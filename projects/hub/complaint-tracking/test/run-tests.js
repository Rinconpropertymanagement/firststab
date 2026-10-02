#!/usr/bin/env node
/**
 * test/run-tests.js
 * Standalone test runner for complaint-tracking/lib/thread-adapter.js — no
 * test framework dependency, matching archive-search/test/run-tests.js's
 * own convention. Run with:
 *   node projects/hub/complaint-tracking/test/run-tests.js
 *
 * Makes zero real network calls and touches no real Supabase project or
 * Anthropic account — thread-adapter.js has no external dependencies at
 * all, so no fake env values are needed here.
 *
 * SCOPE: this file currently covers only the 2026-09-17 prototype,
 * threadFullTextBounded() — a disposable, standalone function built for
 * TARS to validate the "clean formatting, capped to the most recent N
 * messages" cost-reduction approach against real data. It is NOT wired
 * into significance-pass.js or any other real pipeline code. threadFullText()
 * itself is untouched by that prototype; existing coverage of it (if any)
 * lives elsewhere and this file does not attempt to duplicate it.
 */

// Fake env values, same reasoning archive-search/test/run-tests.js's own
// header gives for its identical setup: router.js (required below, for
// PART A) creates a Supabase client at module load time, same as every
// other Hub tool's router.js — these let it load without its own startup
// env-var check exiting the process. Set before ANY require below, since
// router.js's own require chain (archive-search/router.js, which in turn
// requires archive-search/lib/significance-pass.js) reads these at their
// own module-load time too.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://fake-test-project.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'fake-test-service-role-key';
process.env.CRON_SECRET = process.env.CRON_SECRET || 'fake-test-cron-secret';

const assert = require('assert');
const path = require('path');

const results = [];
const asyncResults = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (err) {
    results.push({ name, pass: false, error: err.message });
  }
}

function asyncTest(name, fn) {
  asyncResults.push(
    fn()
      .then(() => ({ name, pass: true }))
      .catch((err) => ({ name, pass: false, error: err.message }))
  );
}

const { toThreadShape, threadFullText, threadFullTextBounded } = require('../lib/thread-adapter');

// ============================================================
// Fixtures — real message-row shape (missive_message_intake columns), fed
// through the real toThreadShape() exactly the way process-pending-
// messages.js does, so these tests exercise threadFullTextBounded() against
// the same object shape threadFullText() actually receives in production.
// ============================================================

// Builds `count` rows for one conversation, oldest first, each with a
// distinguishable body so message order/identity is easy to assert on.
function makeRows(count, { conversationId = 'conv-1' } = {}) {
  const rows = [];
  for (let i = 1; i <= count; i += 1) {
    rows.push({
      missive_message_id: `msg-${i}`,
      from_address: i % 2 === 0 ? { address: 'owner@example.com', name: 'Owner' } : { address: 'tenant@example.com', name: 'Tenant' },
      to_addresses: [{ address: 'staff@rinconmanagement.com' }],
      cc_addresses: [],
      bcc_addresses: [],
      subject: `Re: Maintenance request (message ${i})`,
      body_text: `This is the body of message ${i} of ${count}.`,
      // Strictly increasing so sort order in toThreadShape is unambiguous.
      delivered_at: new Date(2026, 0, i).toISOString(),
    });
  }
  return rows;
}

// ============================================================
// (a) Short threads pass through byte-for-byte unchanged, for every
// maxMessages TARS needs to test (5 and 8), across the boundary (fewer
// than, and exactly equal to, maxMessages).
// ============================================================

for (const maxMessages of [5, 8]) {
  test(`threadFullTextBounded — thread shorter than maxMessages=${maxMessages} is byte-for-byte identical to threadFullText()`, () => {
    const thread = toThreadShape('conv-short', makeRows(maxMessages - 2));
    const expected = threadFullText(thread);
    const actual = threadFullTextBounded(thread, maxMessages);
    assert.strictEqual(actual, expected);
  });

  test(`threadFullTextBounded — thread with EXACTLY maxMessages=${maxMessages} messages is byte-for-byte identical to threadFullText() (boundary case, no marker)`, () => {
    const thread = toThreadShape('conv-exact', makeRows(maxMessages));
    const expected = threadFullText(thread);
    const actual = threadFullTextBounded(thread, maxMessages);
    assert.strictEqual(actual, expected);
    assert.ok(!actual.includes('omitted'), 'expected no omission marker when the thread is not actually truncated');
  });
}

test('threadFullTextBounded — a genuinely empty thread (zero messages) matches threadFullText() (both empty string)', () => {
  const thread = toThreadShape('conv-empty', []);
  assert.strictEqual(threadFullTextBounded(thread, 5), threadFullText(thread));
  assert.strictEqual(threadFullTextBounded(thread, 5), '');
});

// ============================================================
// (b) + (c) Long threads get bounded to the right message count, with an
// omission marker present and stating the correct real count of omitted
// messages — for both maxMessages values TARS needs (5 and 8), and at a
// realistic "very long" size (the kind of 50,000+ token thread this
// prototype exists for).
// ============================================================

for (const [totalMessages, maxMessages] of [
  [12, 5],
  [12, 8],
  [40, 5],
  [40, 8],
]) {
  test(`threadFullTextBounded — a ${totalMessages}-message thread bounded to maxMessages=${maxMessages} keeps exactly ${maxMessages} messages and states the correct omitted count (${totalMessages - maxMessages})`, () => {
    const rows = makeRows(totalMessages);
    const thread = toThreadShape('conv-long', rows);
    const bounded = threadFullTextBounded(thread, maxMessages);

    const omittedCount = totalMessages - maxMessages;
    const expectedMarker = `[${omittedCount} earlier message${omittedCount === 1 ? '' : 's'} omitted — thread continues below]`;
    assert.ok(bounded.includes(expectedMarker), `expected the marker "${expectedMarker}" in the output`);

    // Exactly maxMessages message bodies present, and they are the LAST
    // maxMessages (most recent), not the first — the whole point of
    // "recent messages" bounding.
    for (let i = 1; i <= totalMessages; i += 1) {
      const marker = `body of message ${i} of ${totalMessages}.`;
      const shouldBePresent = i > totalMessages - maxMessages;
      assert.strictEqual(
        bounded.includes(marker),
        shouldBePresent,
        `message ${i} should ${shouldBePresent ? '' : 'NOT '}be present in the bounded output`
      );
    }
  });
}

test('threadFullTextBounded — omission marker uses singular "message" when exactly one message is omitted', () => {
  const thread = toThreadShape('conv-one-over', makeRows(6));
  const bounded = threadFullTextBounded(thread, 5);
  assert.ok(bounded.includes('[1 earlier message omitted — thread continues below]'), 'expected singular phrasing for exactly 1 omitted message');
  assert.ok(!bounded.includes('1 earlier messages'), 'expected no plural "messages" when the count is 1');
});

// ============================================================
// (d) No formatting drift: the per-message formatting inside the bounded
// output for the messages it DOES keep must exactly match what
// threadFullText() itself produces for those same messages — proving the
// two functions render messages identically, not just similarly.
// ============================================================

test('threadFullTextBounded — the retained messages\' formatting is byte-for-byte identical to threadFullText() run on just those messages (no formatting drift)', () => {
  const totalMessages = 12;
  const maxMessages = 5;
  const rows = makeRows(totalMessages);
  const thread = toThreadShape('conv-drift-check', rows);

  const bounded = threadFullTextBounded(thread, maxMessages);

  // Independently compute "what threadFullText() would produce for just
  // the last maxMessages messages" by slicing the already-sorted thread
  // object and calling the real, untouched threadFullText() on that
  // subset — this is the actual production formatting code, not a
  // reimplementation of it.
  const expectedTail = threadFullText({ messages: thread.messages.slice(-maxMessages) });

  assert.ok(bounded.endsWith(expectedTail), 'expected the bounded output to end with exactly threadFullText()\'s own formatting of the retained messages');

  // And the marker plus separator is exactly what precedes that tail —
  // proving there's no stray extra content, only the honest omission
  // marker sits in front of the real formatting.
  const omittedCount = totalMessages - maxMessages;
  const expectedMarker = `[${omittedCount} earlier messages omitted — thread continues below]`;
  assert.strictEqual(bounded, `${expectedMarker}\n\n---\n\n${expectedTail}`);
});

test('threadFullTextBounded — each individual retained message\'s From/Date/Subject/body block matches threadFullText()\'s own single-message rendering', () => {
  const rows = makeRows(9);
  const thread = toThreadShape('conv-per-message-check', rows);
  const bounded = threadFullTextBounded(thread, 5);

  const lastFive = thread.messages.slice(-5);
  for (const m of lastFive) {
    const singleMessageRendering = threadFullText({ messages: [m] });
    assert.ok(bounded.includes(singleMessageRendering), `expected the exact threadFullText() rendering of message ${m.messageId} inside the bounded output`);
  }
});

// ============================================================
// threadFullText() itself is provably untouched — same call, same
// arguments, same result as before this prototype existed. This is a
// behavioral smoke check, not a guess: any accidental edit to
// threadFullText() that changed its output would fail this.
// ============================================================

test('threadFullText() itself is unchanged — produces its known, exact format for a simple 2-message thread', () => {
  const rows = makeRows(2);
  const thread = toThreadShape('conv-untouched-check', rows);
  const out = threadFullText(thread);
  const expected =
    'From: tenant@example.com\nDate: ' + thread.messages[0].date + '\nSubject: Re: Maintenance request (message 1)\n\nThis is the body of message 1 of 2.' +
    '\n\n---\n\n' +
    'From: owner@example.com\nDate: ' + thread.messages[1].date + '\nSubject: Re: Maintenance request (message 2)\n\nThis is the body of message 2 of 2.';
  assert.strictEqual(out, expected);
});

// ============================================================
// Input validation — a clear, immediate error for a nonsensical
// maxMessages rather than silently misbehaving.
// ============================================================

test('threadFullTextBounded — throws a clear error for a non-positive maxMessages', () => {
  const thread = toThreadShape('conv-validate', makeRows(3));
  assert.throws(() => threadFullTextBounded(thread, 0), /positive integer/);
  assert.throws(() => threadFullTextBounded(thread, -1), /positive integer/);
});

test('threadFullTextBounded — throws a clear error for a non-integer maxMessages', () => {
  const thread = toThreadShape('conv-validate-2', makeRows(3));
  assert.throws(() => threadFullTextBounded(thread, 5.5), /positive integer/);
});

// ============================================================
// PART A — router.js: name-match suggestion review routes (migration
// 20261002060000; archive-search/lib/significance-pass.js's own
// findNameMatchCandidates()/applyCall1Result() carry the suggestion-
// generation tests, in that file's own test suite — this PART covers
// only the human-review side: POST .../name-match/confirm and POST
// .../name-match/reject).
//
// No supertest-style HTTP harness exists anywhere in this codebase (grep
// confirms it) — the established, lighter-weight convention this suite
// already uses for a DB-touching function (archive-search/test/run-tests.js
// PART 15's withFakeSupabaseClient) is to swap @supabase/supabase-js's own
// require.cache entry for a fake createClient() BEFORE requiring the real
// module, so the module's own `const supabase = createClient(...)` picks
// up the fake. Applied here to complaint-tracking/router.js (which itself
// requires archive-search/router.js, which requires archive-search/lib/
// significance-pass.js — both resolve the SAME @supabase/supabase-js file
// from this monorepo's one node_modules, so the single swapped cache entry
// covers all three). The route HANDLER is then called directly (pulled off
// router.stack by path/method), bypassing requireComplaintTrackingAccess —
// that gate is a plain allow-list already readable from router.js's own
// source; these tests exercise the handler's actual read/write logic, not
// the access-control middleware in front of it.
// ============================================================

function makeNameMatchFakeClient({ complaintRow, significanceRow = null, anchorMessageRow = null }) {
  const state = {
    complaints: [{ ...complaintRow }],
    significance: significanceRow,
    anchorMessage: anchorMessageRow,
    auditLogInserts: [],
    messageLinkInserts: [],
  };

  function makeChain(table) {
    const filters = [];
    let op = null, payload = null;
    const chain = {
      select() { if (!op) op = 'select'; return chain; },
      eq(col, val) { filters.push({ col, val }); return chain; },
      or() { return chain; }, // 'users' lookup (writeAuditLog's lookupUserId) — always misses below, irrelevant to what these tests assert.
      order() { return chain; },
      limit() { return chain; },
      update(fields) { op = 'update'; payload = fields; return chain; },
      insert(row) { op = 'insert'; payload = row; return chain; },
      maybeSingle() {
        if (table === 'complaints' && op === 'select') {
          const match = state.complaints.find((r) => filters.every((f) => r[f.col] === f.val));
          return Promise.resolve({ data: match ? { ...match } : null, error: null });
        }
        if (table === 'complaints' && op === 'update') {
          const idx = state.complaints.findIndex((r) => filters.every((f) => r[f.col] === f.val));
          if (idx === -1) return Promise.resolve({ data: null, error: null });
          state.complaints[idx] = { ...state.complaints[idx], ...payload };
          return Promise.resolve({ data: { ...state.complaints[idx] }, error: null });
        }
        if (table === 'missive_conversation_significance') return Promise.resolve({ data: state.significance, error: null });
        if (table === 'missive_message_intake_search_safe') return Promise.resolve({ data: state.anchorMessage, error: null });
        return Promise.resolve({ data: null, error: null }); // 'users', or anything else not modeled here.
      },
      single() {
        if (table === 'complaints' && op === 'update') {
          const idx = state.complaints.findIndex((r) => filters.every((f) => r[f.col] === f.val));
          if (idx === -1) return Promise.resolve({ data: null, error: { message: 'not found' } });
          state.complaints[idx] = { ...state.complaints[idx], ...payload };
          return Promise.resolve({ data: { ...state.complaints[idx] }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve, reject) {
        let result = { data: null, error: null };
        if (table === 'audit_log' && op === 'insert') {
          state.auditLogInserts.push(payload);
        } else if (table === 'missive_message_links' && op === 'insert') {
          state.messageLinkInserts.push(payload);
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }

  return { client: { from: (t) => makeChain(t) }, state };
}

// Swaps @supabase/supabase-js's require.cache entry for the fake client,
// force-refreshes complaint-tracking/router.js so its own `const supabase
// = createClient(...)` picks it up, pulls the named route's handler
// (the LAST layer in that route's own stack — requireComplaintTrackingAccess
// is the only other one) off router.stack, and calls it with a minimal
// fake req/res. Restores everything in `finally`, so this can never leak a
// fake module into any other test in this suite — same discipline
// archive-search/test/run-tests.js's withFakeSupabaseClient already
// documents for its own identical swap.
async function callRouterHandler({ fakeClient, method, routePath, req }) {
  const targetPath = require.resolve('../router.js');
  const supabasePath = require.resolve('@supabase/supabase-js', { paths: [path.dirname(targetPath)] });

  const hadSupabaseCache = Object.prototype.hasOwnProperty.call(require.cache, supabasePath);
  const originalSupabaseModule = require.cache[supabasePath];
  const hadTargetCache = Object.prototype.hasOwnProperty.call(require.cache, targetPath);
  const originalTargetModule = require.cache[targetPath];

  // archive-search/router.js and archive-search/lib/significance-pass.js
  // (both required transitively by complaint-tracking/router.js) each
  // build their OWN Supabase client too — force a fresh require of those
  // as well so none of them hold onto a stale, previously-cached client
  // from an earlier test run in this same process.
  const archiveSearchRouterPath = require.resolve('../../archive-search/router.js');
  const significancePassPath = require.resolve('../../archive-search/lib/significance-pass.js');
  const hadArchiveSearchRouterCache = Object.prototype.hasOwnProperty.call(require.cache, archiveSearchRouterPath);
  const originalArchiveSearchRouterModule = require.cache[archiveSearchRouterPath];
  const hadSignificancePassCache = Object.prototype.hasOwnProperty.call(require.cache, significancePassPath);
  const originalSignificancePassModule = require.cache[significancePassPath];

  require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true, exports: { createClient: () => fakeClient },
  };
  delete require.cache[targetPath];
  delete require.cache[archiveSearchRouterPath];
  delete require.cache[significancePassPath];

  try {
    const { router } = require(targetPath);
    const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
    if (!layer) throw new Error(`No route found for ${method.toUpperCase()} ${routePath}`);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;

    let statusCode = 200;
    let jsonBody = null;
    const res = {
      status(code) { statusCode = code; return res; },
      json(body) { jsonBody = body; return res; },
    };
    await handler(req, res);
    return { statusCode, body: jsonBody };
  } finally {
    if (hadSupabaseCache) require.cache[supabasePath] = originalSupabaseModule; else delete require.cache[supabasePath];
    if (hadTargetCache) require.cache[targetPath] = originalTargetModule; else delete require.cache[targetPath];
    if (hadArchiveSearchRouterCache) require.cache[archiveSearchRouterPath] = originalArchiveSearchRouterModule; else delete require.cache[archiveSearchRouterPath];
    if (hadSignificancePassCache) require.cache[significancePassPath] = originalSignificancePassModule; else delete require.cache[significancePassPath];
  }
}

// isValidUuid() (router.js) requires real UUID shape — these fixture ids
// are deliberately real-looking UUIDs, not readable slugs, so every route
// under test gets past that check and actually exercises the logic below
// it (an earlier draft of these tests used slugs like "complaint-1" and
// every one of them tripped the 400 "not valid" guard instead of the
// behavior being tested — caught by actually running this suite, not
// assumed correct).
const COMPLAINT_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_A_ID = '22222222-2222-2222-2222-222222222222';
const TENANT_B_ID = '33333333-3333-3333-3333-333333333333';
const NOT_OFFERED_ID = '44444444-4444-4444-4444-444444444444';
const PROPERTY_ID = '55555555-5555-5555-5555-555555555555';

const BASE_COMPLAINT_ROW = {
  id: COMPLAINT_ID,
  property_id: PROPERTY_ID,
  source_missive_conversation_id: 'conv-1',
  suggested_subject_type: 'tenant',
  suggested_subject_name_text: '"Jane Doe called about the leak"',
  suggested_subject_candidate_ids: [TENANT_A_ID, TENANT_B_ID],
  suggested_subject_extracted_by: 'archive-search-content-pass-v2',
  human_confirmed_subject_outcome: null,
  human_confirmed_subject_id: null,
  human_confirmed_subject_by: null,
  human_confirmed_subject_at: null,
  subject_type: null,
  subject_id: null,
  needs_matching: true,
};

asyncTest('router — POST .../name-match/confirm: happy path writes subject_type/subject_id, needs_matching=false, the human_confirmed_subject_* trail, one audit_log entry, and a missive_message_links row with match_method=content_extracted_human_confirmed', async () => {
  const { client, state } = makeNameMatchFakeClient({
    complaintRow: BASE_COMPLAINT_ROW,
    significanceRow: { mailbox_key: 'team:test-mailbox' },
    anchorMessageRow: { missive_message_id: 'msg-anchor-1' },
  });
  const req = { params: { id: COMPLAINT_ID }, body: { candidate_id: TENANT_A_ID }, user: { email: 'do@rinconmanagement.com' }, complaintTrackingRole: 'director_of_operations' };
  const result = await callRouterHandler({ fakeClient: client, method: 'post', routePath: '/api/complaint-tracking/:id/name-match/confirm', req });

  assert.strictEqual(result.statusCode, 200);
  assert.strictEqual(result.body.success, true);
  assert.strictEqual(result.body.complaint.subject_type, 'tenant');
  assert.strictEqual(result.body.complaint.subject_id, TENANT_A_ID);
  assert.strictEqual(result.body.complaint.needs_matching, false);
  assert.strictEqual(result.body.complaint.human_confirmed_subject_outcome, 'confirmed');
  assert.strictEqual(result.body.complaint.human_confirmed_subject_id, TENANT_A_ID);
  assert.strictEqual(result.body.complaint.human_confirmed_subject_by, 'do@rinconmanagement.com');
  assert.ok(result.body.complaint.human_confirmed_subject_at);

  assert.strictEqual(state.auditLogInserts.length, 1);
  assert.strictEqual(state.auditLogInserts[0].action, 'complaint_tracking.name_match_confirmed');
  assert.strictEqual(state.auditLogInserts[0].entity_type, 'complaint');
  assert.strictEqual(state.auditLogInserts[0].details.subject_id, TENANT_A_ID);

  assert.strictEqual(state.messageLinkInserts.length, 1);
  const link = state.messageLinkInserts[0];
  assert.strictEqual(link.match_method, 'content_extracted_human_confirmed');
  assert.strictEqual(link.subject_type, 'tenant');
  assert.strictEqual(link.subject_id, TENANT_A_ID);
  assert.strictEqual(link.mailbox_key, 'team:test-mailbox');
  assert.strictEqual(link.missive_message_id, 'msg-anchor-1');
  assert.strictEqual(link.human_confirmed_by, 'do@rinconmanagement.com');
  assert.ok(link.human_confirmed_at);
  assert.strictEqual(link.source_reference, BASE_COMPLAINT_ROW.suggested_subject_name_text);
  assert.strictEqual(link.extracted_by, BASE_COMPLAINT_ROW.suggested_subject_extracted_by);
});

asyncTest('router — POST .../name-match/confirm: rejects a candidate_id that was never actually suggested (400, nothing written) — Mason\'s point 1, enforced at the route too, not just the DB CHECK', async () => {
  const { client, state } = makeNameMatchFakeClient({ complaintRow: BASE_COMPLAINT_ROW });
  const req = { params: { id: COMPLAINT_ID }, body: { candidate_id: NOT_OFFERED_ID }, user: { email: 'do@rinconmanagement.com' }, complaintTrackingRole: 'director_of_operations' };
  const result = await callRouterHandler({ fakeClient: client, method: 'post', routePath: '/api/complaint-tracking/:id/name-match/confirm', req });

  assert.strictEqual(result.statusCode, 400);
  assert.strictEqual(state.complaints[0].subject_type, null, 'expected subject_type to stay untouched');
  assert.strictEqual(state.auditLogInserts.length, 0);
});

asyncTest('router — POST .../name-match/confirm: 409 when the complaint has no pending suggestion at all', async () => {
  const { client } = makeNameMatchFakeClient({ complaintRow: { ...BASE_COMPLAINT_ROW, suggested_subject_type: null, suggested_subject_candidate_ids: null } });
  const req = { params: { id: COMPLAINT_ID }, body: { candidate_id: TENANT_A_ID }, user: { email: 'do@rinconmanagement.com' }, complaintTrackingRole: 'director_of_operations' };
  const result = await callRouterHandler({ fakeClient: client, method: 'post', routePath: '/api/complaint-tracking/:id/name-match/confirm', req });
  assert.strictEqual(result.statusCode, 409);
});

asyncTest('router — POST .../name-match/confirm: 409 when this suggestion was already reviewed (no double-confirm)', async () => {
  const { client } = makeNameMatchFakeClient({ complaintRow: { ...BASE_COMPLAINT_ROW, human_confirmed_subject_outcome: 'rejected', human_confirmed_subject_by: 'someone@rinconmanagement.com', human_confirmed_subject_at: '2026-10-01T00:00:00.000Z' } });
  const req = { params: { id: COMPLAINT_ID }, body: { candidate_id: TENANT_A_ID }, user: { email: 'do@rinconmanagement.com' }, complaintTrackingRole: 'director_of_operations' };
  const result = await callRouterHandler({ fakeClient: client, method: 'post', routePath: '/api/complaint-tracking/:id/name-match/confirm', req });
  assert.strictEqual(result.statusCode, 409);
});

asyncTest('router — POST .../name-match/confirm: never blocked by a failed missive_message_links write (best-effort) — the real subject_type/subject_id write and audit trail still succeed even when the mailbox/anchor lookup comes back empty', async () => {
  const { client, state } = makeNameMatchFakeClient({ complaintRow: BASE_COMPLAINT_ROW, significanceRow: null, anchorMessageRow: null });
  const req = { params: { id: COMPLAINT_ID }, body: { candidate_id: TENANT_B_ID }, user: { email: 'do@rinconmanagement.com' }, complaintTrackingRole: 'director_of_operations' };
  const result = await callRouterHandler({ fakeClient: client, method: 'post', routePath: '/api/complaint-tracking/:id/name-match/confirm', req });

  assert.strictEqual(result.statusCode, 200);
  assert.strictEqual(result.body.complaint.subject_id, TENANT_B_ID);
  assert.strictEqual(state.auditLogInserts.length, 1, 'expected the real audit trail to still be written');
  assert.strictEqual(state.messageLinkInserts.length, 0, 'expected no missive_message_links row when the anchor could not be resolved');
});

asyncTest('router — POST .../name-match/reject: sets outcome=rejected, leaves needs_matching=TRUE and subject_type/subject_id untouched (null), writes one audit_log entry', async () => {
  const { client, state } = makeNameMatchFakeClient({ complaintRow: BASE_COMPLAINT_ROW });
  const req = { params: { id: COMPLAINT_ID }, body: {}, user: { email: 'do@rinconmanagement.com' }, complaintTrackingRole: 'director_of_operations' };
  const result = await callRouterHandler({ fakeClient: client, method: 'post', routePath: '/api/complaint-tracking/:id/name-match/reject', req });

  assert.strictEqual(result.statusCode, 200);
  assert.strictEqual(result.body.complaint.human_confirmed_subject_outcome, 'rejected');
  assert.strictEqual(result.body.complaint.human_confirmed_subject_id, null);
  assert.strictEqual(result.body.complaint.human_confirmed_subject_by, 'do@rinconmanagement.com');
  assert.ok(result.body.complaint.human_confirmed_subject_at);
  assert.strictEqual(result.body.complaint.needs_matching, true, 'expected needs_matching to stay TRUE on rejection');
  assert.strictEqual(result.body.complaint.subject_type, null, 'expected subject_type to never be written on a rejection');
  assert.strictEqual(result.body.complaint.subject_id, null, 'expected subject_id to never be written on a rejection');

  assert.strictEqual(state.auditLogInserts.length, 1);
  assert.strictEqual(state.auditLogInserts[0].action, 'complaint_tracking.name_match_rejected');
  assert.strictEqual(state.messageLinkInserts.length, 0, 'expected no missive_message_links row on a rejection — nothing was confirmed');
});

asyncTest('router — POST .../name-match/reject: 409 when there is no pending suggestion', async () => {
  const { client } = makeNameMatchFakeClient({ complaintRow: { ...BASE_COMPLAINT_ROW, suggested_subject_type: null, suggested_subject_candidate_ids: null } });
  const req = { params: { id: COMPLAINT_ID }, body: {}, user: { email: 'do@rinconmanagement.com' }, complaintTrackingRole: 'director_of_operations' };
  const result = await callRouterHandler({ fakeClient: client, method: 'post', routePath: '/api/complaint-tracking/:id/name-match/reject', req });
  assert.strictEqual(result.statusCode, 409);
});

// ─── Report ──────────────────────────────────────────────────────────────
async function main() {
  const resolvedAsync = await Promise.all(asyncResults);
  const all = [...results, ...resolvedAsync];

  console.log('\nComplaint Tracking — Test Suite\n' + '='.repeat(60));
  let failCount = 0;
  for (const r of all) {
    if (r.pass) {
      console.log(`PASS  ${r.name}`);
    } else {
      failCount += 1;
      console.log(`FAIL  ${r.name}`);
      console.log(`      ${r.error}`);
    }
  }
  console.log('='.repeat(60));
  console.log(`${all.length - failCount}/${all.length} passed`);

  if (failCount > 0) process.exitCode = 1;
}

main();
