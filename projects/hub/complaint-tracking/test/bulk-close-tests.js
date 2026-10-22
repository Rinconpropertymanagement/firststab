'use strict';

/**
 * test/bulk-close-tests.js
 * Tests for "Close old items" (lib/bulk-close.js and its four routes under
 * /api/complaint-tracking/bulk-close). Registered into the shared runner by
 * test/run-tests.js. Uses only the in-memory fake database in
 * test/bulk-close-fake-db.js and made-up ids and text: no real database,
 * network, email, model or complaint is touched.
 *
 * What is pinned here:
 *  - the eligibility rule (every skip reason alone and combined, the 89/90/91
 *    day edge, the 30-day "someone worked it" edge, failing closed);
 *  - that the preview and the real close use the same rule and the same set;
 *  - that the server's idea of "Needs a Call / Flagged for Review" cannot
 *    drift from the dashboard's (the page's own laneOf/triagePriority are run
 *    against the server's over a table of every field combination);
 *  - the write rules (stale preview refused, batch cap, chunks of 80, a failed
 *    group is counted truthfully, nothing is ever deleted, only status and
 *    resolution_note change);
 *  - audit rows (a start row BEFORE anything changes, one per item, one at the
 *    end, ids and counts only), and what happens when the audit log misbehaves;
 *  - Peter's 2026-10-22 override: legal-exposure items are closed unless the
 *    box is ticked, while Fair Housing items can never be closed;
 *  - an item that already has a note is never overwritten;
 *  - undo (only this batch, only untouched items, safe twice, then re-close);
 *  - hardening: exact batch tag, set code, safe logging, lock timeout, preview
 *    limit, bounded batch list;
 *  - access, input checks, and speed with 3,000 complaints.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');

const bulk = require('../lib/bulk-close');
const { findLatestAuditRows } = require('../lib/last-touched');
const { makeDb } = require('./bulk-close-fake-db');

// ─── Made-up fixtures ────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 21, 18, 0, 0); // 2026-10-21 11:00 in Los Angeles
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const iso = (ms) => new Date(ms).toISOString();
const MARKER = 'ZZ-COMPLAINT-TEXT-THAT-MUST-NEVER-LEAVE-THE-COMPLAINT-ROW';
const ACTOR = { email: 'peter@rincon.test', name: 'Peter McKenzie' };
const PERFORMED_BY = uuid(900);

function complaint(n, overrides = {}, base = NOW) {
  return {
    id: uuid(1000 + n),
    status: 'open',
    merged_into_id: null,
    held_legal_fair_housing: false,
    source: 'email_ai',
    needs_human_call: false,
    escalation_signal: 'dispute',
    severity_tier: 'worth_a_look',
    flagged_protected_class: false,
    flagged_category: null,
    category: 'dispute',
    owner_instruction_rejected: null,
    delegated_to_team_member_id: null,
    duplicate_status: 'none',
    possible_duplicate_of_id: null,
    blocked_since: null,
    source_missive_conversation_id: `conv-${n}`,
    property_id: uuid(7),
    updated_at: iso(base - 150 * DAY),
    description: `${MARKER} #${n}`,
    resolution_note: null,
    ...overrides,
  };
}

// A set of complaints plus the emails and audit rows that go with them.
function world(base = NOW) {
  const w = { base, complaints: [], messages: [], audit: [], members: [], users: [], roles: [], seq: 0 };
  // add(n, daysSinceLastEmail | null, overrides, [{ days, type, by, action }])
  w.add = (n, lastDays, overrides = {}, auditSpecs = []) => {
    const c = complaint(n, overrides, base);
    w.complaints.push(c);
    const conv = c.source_missive_conversation_id;
    if (conv && lastDays !== null && lastDays !== undefined) {
      w.messages.push(
        { missive_conversation_id: conv, delivered_at: iso(base - (lastDays + 20) * DAY) },
        { missive_conversation_id: conv, delivered_at: iso(base - lastDays * DAY) },
      );
    }
    for (const a of auditSpecs) {
      w.seq += 1;
      w.audit.push({
        id: uuid(8000 + w.seq), action: a.action || 'complaint_tracking.stage_changed', entity_type: 'complaint', entity_id: c.id,
        performed_by: null, actor_type: a.type || 'human', actor_id: a.by || 'someone@rincon.test',
        privacy_category: 'processing', risk_level: 'low', property_id: null, details: {},
        created_at: iso(base - a.days * DAY), sequence_num: w.seq,
      });
    }
    return c;
  };
  w.db = (hooks, opts) => makeDb(w, hooks, { startMs: base, ...(opts || {}) });
  return w;
}

function service(db, extra = {}) {
  let n = 0;
  return bulk.createBulkClose({
    supabase: db.client, now: () => NOW, randomUUID: () => uuid(5000 + (n += 1)),
    lookupUserId: async () => PERFORMED_BY, lookupTimeoutMs: 5000, ...extra,
  });
}

// The set code a preview hands back: for the worlds where complaints 1..N are
// the ones that qualify, that is the code of ids uuid(1001)..uuid(1000+N).
const isValidUuidText = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const seqIds = (n) => Array.from({ length: n }, (_, i) => uuid(1001 + i));
// "kind:column" for every filter on a recorded write (an OR filter is named by its columns).
const guardsOf = (write) => write.filters.map((f) => (f.kind === 'or' ? `or:${[...new Set(f.terms.map((t) => t.col))].join('|')}` : `${f.kind}:${f.col}`));
const closeBody = (expected, over = {}) => ({
  older_than_days: 90, hold_back_urgent: true, expected_count: expected,
  expected_hash: bulk.setHash(Number.isInteger(expected) && expected > 0 && expected <= 5000 ? seqIds(expected) : []),
  ...over,
});

async function quiet(fn) {
  const original = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args.join(' ')); };
  try { return { value: await fn(), logged }; } finally { console.error = original; }
}

// The mixed set the preview tests use. Numbers in the comments are what the
// rule must say about each one at 90 days with urgent items held back.
function mixedWorld(base = NOW) {
  const w = world(base);
  w.add(1, 120); // eligible
  w.add(2, 400, { severity_tier: 'urgent' }); // urgent: held back
  w.add(3, 800, { severity_tier: null, escalation_signal: null, needs_human_call: true }); // eligible (Needs a Call by needs_human_call)
  w.add(4, 500, { severity_tier: null, escalation_signal: 'dispute' }); // eligible (Flagged by escalation_signal)
  w.add(5, 10); // recent
  w.add(6, base === NOW ? 90 : 89.99); // recent: exactly 90 days is not "older than 90" (a hair inside the edge when the clock is the real one)
  w.add(7, 91); // eligible
  w.add(8, 89); // recent
  w.add(9, 200, { flagged_protected_class: true, flagged_category: 'race' }); // Fair Housing
  w.add(10, 200, { flagged_category: 'disability' }); // Fair Housing (category only)
  w.add(11, 200, { category: 'accommodation_related' }); // Fair Housing (accommodation)
  w.add(12, 300, { severity_tier: 'urgent' }); // urgent: held back
  w.add(13, null, { source: 'manual_staff', needs_human_call: true, source_missive_conversation_id: null }); // typed-in report
  w.add(14, 300, { source: 'manual_staff', needs_human_call: true }); // typed-in report with a thread
  w.add(15, 200, { delegated_to_team_member_id: uuid(55) }); // delegated
  w.add(16, 200, {}, [{ days: 10 }]); // a person touched it 10 days ago
  w.add(17, 200, { duplicate_status: 'suggested', possible_duplicate_of_id: uuid(1001) }); // duplicate waiting
  w.add(18, 200, { duplicate_status: 'none', possible_duplicate_of_id: uuid(1001) }); // duplicate pointer, no decision
  w.add(19, 250, { duplicate_status: 'dismissed', possible_duplicate_of_id: uuid(1001) }); // eligible: duplicate was decided
  w.add(20, 200, { blocked_since: iso(base - 300 * DAY) }); // waiting on someone
  w.add(21, null); // has a thread but no dated message
  w.add(22, 200, { source_missive_conversation_id: null }); // no thread at all
  // Not in the Needs a Call / Flagged for Review lanes, or not open: not counted anywhere.
  w.add(23, 300, { severity_tier: 'just_a_record', escalation_signal: null });
  w.add(24, 300, { severity_tier: 'no_issue', escalation_signal: null });
  w.add(25, 300, { status: 'in_progress' });
  w.add(26, 300, { status: 'blocked' });
  w.add(27, 300, { status: 'resolved', resolution_note: 'Handled earlier' });
  w.add(28, 300, { merged_into_id: uuid(1001), duplicate_status: 'confirmed_merged' });
  w.add(29, 300, { status: 'held', held_legal_fair_housing: true, severity_tier: null, escalation_signal: null, category: null });
  w.add(30, 300, { severity_tier: null, escalation_signal: null });
  return w;
}
const ELIGIBLE_MIXED = [1, 3, 4, 7, 19].map((n) => uuid(1000 + n));
const mixedBody = (over = {}) => closeBody(5, { expected_hash: bulk.setHash(ELIGIBLE_MIXED), ...over });
const EXPECTED_MIXED_PREVIEW = {
  older_than_days: 90, hold_back_urgent: true, hold_back_legal: false, open_in_scope: 22, eligible: 5,
  eligible_by_year: { 2024: 1, 2025: 1, 2026: 3 }, legal_tagged_in_eligible: 0, set_hash: bulk.setHash(ELIGIBLE_MIXED),
  skipped: { fair_housing_flagged: 3, urgent_held_back: 2, recent: 3, manual_report: 2, recently_worked_or_delegated: 2, kept_has_note: 0, duplicate_pending: 2, not_open_or_other: 3 },
  cap: 2000, over_cap: false, lookup_incomplete: false,
};

// ─── The dashboard's own lane functions, lifted out of the page ──────────

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} was not found in dashboard/index.html`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`function ${name} in dashboard/index.html never closes`);
}

function loadPageLaneLogic() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
  const code = `${extractFunction(html, 'triagePriority')}\n${extractFunction(html, 'laneOf')}\n({ triagePriority, laneOf })`;
  return vm.runInNewContext(code, {});
}

// ─── Loading the real router against a fake database ────────────────────

async function withRouter(fakeClient, fn) {
  const targetPath = require.resolve('../router.js');
  const supabasePath = require.resolve('@supabase/supabase-js', { paths: [path.dirname(targetPath)] });
  const others = [
    require.resolve('../../archive-search/router.js'),
    require.resolve('../../archive-search/lib/significance-pass.js'),
    require.resolve('../lib/process-pending-messages.js'),
  ];
  const watched = [supabasePath, targetPath, ...others];
  const saved = new Map(watched.map((p) => [p, { had: Object.prototype.hasOwnProperty.call(require.cache, p), mod: require.cache[p] }]));
  require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { createClient: () => fakeClient } };
  for (const p of [targetPath, ...others]) delete require.cache[p];
  try {
    return await fn(require(targetPath));
  } finally {
    for (const [p, s] of saved) { if (s.had) require.cache[p] = s.mod; else delete require.cache[p]; }
  }
}

// Runs one route's whole stack (access check, same-origin check, handler) in
// order, the way Express would, and returns what was answered.
async function runRoute(routerModule, method, routePath, req) {
  const layer = routerModule.router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`No route found for ${method.toUpperCase()} ${routePath}`);
  const out = { status: 200, body: null };
  const res = { status(code) { out.status = code; return res; }, json(body) { out.body = body; return res; } };
  for (const sub of layer.route.stack) {
    let advanced = false;
    await sub.handle(req, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return out;
}

function reqOf(opts = {}) {
  const { body, query, params, headers = {}, name = 'Peter McKenzie', email = ACTOR.email } = opts;
  const role = 'role' in opts ? opts.role : 'admin';
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    user: { id: 'user-1', email }, complaintTrackingRole: role, complaintTrackingMemberName: name,
    body, query: query || {}, params: params || {}, headers: lower, get: (n) => lower[String(n).toLowerCase()],
  };
}

const ROUTES = {
  preview: ['get', '/api/complaint-tracking/bulk-close/preview'],
  close: ['post', '/api/complaint-tracking/bulk-close'],
  batches: ['get', '/api/complaint-tracking/bulk-close/batches'],
  undo: ['post', '/api/complaint-tracking/bulk-close/:batch_id/undo'],
};

function httpJson(port, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathname,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, json, text: buf }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Small seeded random numbers, so the "random" worlds are the same every run.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Registration ────────────────────────────────────────────────────────

function register({ test, asyncTest }) {
  // ====================================================================
  // 1. The lane rule, pinned to the dashboard
  // ====================================================================

  test('bulk close — the server lane rule agrees with the dashboard\'s own laneOf/triagePriority on every combination of fields (1,120 rows, the page\'s real functions run in a sandbox)', () => {
    const page = loadPageLaneLogic();
    const sources = ['email_ai', 'manual_staff'];
    const flags = [true, false];
    const tiers = [null, undefined, 'urgent', 'worth_a_look', 'just_a_record', 'no_issue', 'something_else'];
    const signals = [null, 'dispute'];
    const merged = [null, uuid(1)];
    const statuses = ['open', 'in_progress', 'blocked', 'resolved', 'held'];
    const mismatches = [];
    let count = 0;
    for (const source of sources) for (const needs of flags) for (const tier of tiers) for (const signal of signals) {
      for (const held of flags) for (const mergedId of merged) for (const status of statuses) {
        const row = { source, needs_human_call: needs, severity_tier: tier, escalation_signal: signal, held_legal_fair_housing: held, merged_into_id: mergedId, status };
        count += 1;
        const fromPage = String(page.laneOf(row));
        const fromServer = bulk.serverLaneOf(row);
        const priorityPage = String(page.triagePriority(row));
        if (fromPage !== fromServer || priorityPage !== bulk.serverTriagePriority(row)) mismatches.push(JSON.stringify(row) + ` page=${fromPage} server=${fromServer}`);
      }
    }
    assert.strictEqual(count, 1120);
    assert.deepStrictEqual(mismatches.slice(0, 5), [], 'the server lane rule drifted from the dashboard');
  });

  test('bulk close — the lane rule gives the documented answer on a hand-written table (so the page and the server cannot both drift the same way)', () => {
    const cases = [
      [{ severity_tier: 'urgent' }, 'call'],
      [{ severity_tier: 'worth_a_look' }, 'flagged'],
      [{ severity_tier: 'just_a_record' }, 'log'],
      [{ severity_tier: 'no_issue' }, 'no_issue'],
      [{ needs_human_call: true }, 'call'],
      [{ escalation_signal: 'dispute' }, 'flagged'],
      [{}, 'log'],
      [{ source: 'manual_staff', needs_human_call: true, severity_tier: 'just_a_record' }, 'call'],
      [{ source: 'manual_staff', needs_human_call: false, severity_tier: 'just_a_record' }, 'log'],
      [{ severity_tier: 'worth_a_look', needs_human_call: true }, 'flagged'],
      [{ severity_tier: 'something_else', needs_human_call: true }, 'call'],
      [{ held_legal_fair_housing: true, severity_tier: 'urgent' }, 'held'],
      [{ merged_into_id: uuid(1), severity_tier: 'urgent' }, 'merged'],
      [{ status: 'resolved', severity_tier: 'urgent' }, 'resolved'],
      [{ status: 'in_progress', severity_tier: 'urgent' }, 'call'],
    ];
    for (const [fields, lane] of cases) {
      assert.strictEqual(bulk.serverLaneOf({ status: 'open', ...fields }), lane, JSON.stringify(fields));
    }
  });

  test('bulk close — only OPEN rows in the Needs a Call or Flagged for Review lanes are in scope (isInScope)', () => {
    const inScope = (o) => bulk.isInScope({ status: 'open', ...o });
    assert.strictEqual(inScope({ severity_tier: 'urgent' }), true);
    assert.strictEqual(inScope({ severity_tier: 'worth_a_look' }), true);
    assert.strictEqual(inScope({ severity_tier: 'just_a_record' }), false);
    assert.strictEqual(inScope({ severity_tier: 'no_issue' }), false);
    assert.strictEqual(inScope({}), false, 'a plain Log row is not in scope');
    assert.strictEqual(inScope({ status: 'in_progress', severity_tier: 'urgent' }), false);
    assert.strictEqual(inScope({ status: 'blocked', severity_tier: 'urgent' }), false);
    assert.strictEqual(inScope({ status: 'resolved', severity_tier: 'urgent' }), false);
    assert.strictEqual(inScope({ status: 'held', severity_tier: 'urgent' }), false);
    assert.strictEqual(inScope({ merged_into_id: uuid(1), severity_tier: 'urgent' }), false);
    assert.strictEqual(inScope({ held_legal_fair_housing: true, severity_tier: 'urgent' }), false);
    assert.strictEqual(bulk.isInScope(null), false);
    assert.strictEqual(bulk.isInScope(undefined), false);
  });

  // ====================================================================
  // 2. The eligibility rule, row by row
  // ====================================================================

  const ctxFor = ({ days = 90, hold = true, holdLegal = false, notes = [], last = {}, audit = {}, unverified = [], auditPending = false } = {}) => ({
    nowMs: NOW,
    olderThanDays: days,
    holdBackUrgent: hold,
    holdBackLegal: holdLegal,
    withNote: new Set(notes),
    lastEmail: new Map(Object.entries(last).map(([k, v]) => [k, v === null ? null : NOW - v * DAY])),
    latestAudit: auditPending ? null : new Map(Object.entries(audit).map(([k, v]) => [k, { actor_type: v.type || 'human', created_at: iso(NOW - v.days * DAY) }])),
    auditUnverified: new Set(unverified),
  });
  const baseRow = (o = {}) => complaint(1, o);
  const verdict = (row, ctxOptions) => {
    const d = bulk.decide(row, ctxFor({ last: { [row.source_missive_conversation_id]: 200 }, ...ctxOptions }));
    return d.eligible ? 'eligible' : (d.inScope ? d.reason : 'out_of_scope');
  };

  test('bulk close — a plain old open item qualifies; each skip reason, taken alone, gives exactly its own reason', () => {
    assert.strictEqual(verdict(baseRow()), 'eligible');
    const alone = [
      ['manual_report', { source: 'manual_staff', needs_human_call: true }],
      ['not_open_or_other', { source_missive_conversation_id: null }],
      ['not_open_or_other', { blocked_since: iso(NOW - 5 * DAY) }],
      ['fair_housing_flagged', { flagged_protected_class: true, flagged_category: 'race' }],
      ['fair_housing_flagged', { flagged_protected_class: true }],
      ['fair_housing_flagged', { flagged_category: 'disability' }],
      ['fair_housing_flagged', { category: 'accommodation_related' }],
      ['urgent_held_back', { severity_tier: 'urgent' }],
      ['recently_worked_or_delegated', { delegated_to_team_member_id: uuid(55) }],
      ['duplicate_pending', { duplicate_status: 'suggested', possible_duplicate_of_id: uuid(2) }],
      ['duplicate_pending', { duplicate_status: 'suggested' }],
      ['duplicate_pending', { duplicate_status: 'none', possible_duplicate_of_id: uuid(2) }],
      ['out_of_scope', { status: 'in_progress' }],
      ['out_of_scope', { status: 'blocked' }],
      ['out_of_scope', { status: 'resolved' }],
      ['out_of_scope', { status: 'held' }],
      ['out_of_scope', { held_legal_fair_housing: true }],
      ['out_of_scope', { merged_into_id: uuid(3), duplicate_status: 'confirmed_merged' }],
      ['out_of_scope', { severity_tier: 'no_issue', escalation_signal: null }],
      ['out_of_scope', { severity_tier: 'just_a_record', escalation_signal: null }],
    ];
    for (const [expected, fields] of alone) assert.strictEqual(verdict(baseRow(fields)), expected, JSON.stringify(fields));
    // A decided duplicate does not hold anything back.
    assert.strictEqual(verdict(baseRow({ duplicate_status: 'dismissed', possible_duplicate_of_id: uuid(2) })), 'eligible');
    assert.strictEqual(verdict(baseRow({ duplicate_status: 'confirmed_merged', possible_duplicate_of_id: uuid(2) })), 'eligible');
    assert.strictEqual(verdict(baseRow({ flagged_protected_class: false, flagged_category: null })), 'eligible');
  });

  test('bulk close — an open item that already has a note is skipped as kept_has_note, after the earlier reasons and before the audit and duplicate checks', () => {
    const row = baseRow();
    assert.strictEqual(verdict(row, { notes: [row.id] }), 'kept_has_note');
    assert.strictEqual(verdict(row, { notes: [uuid(99)] }), 'eligible');
    assert.strictEqual(verdict(baseRow({ severity_tier: 'urgent' }), { notes: [row.id] }), 'urgent_held_back');
    assert.strictEqual(verdict(baseRow({ category: 'accommodation_related' }), { notes: [row.id] }), 'fair_housing_flagged');
    assert.strictEqual(verdict(baseRow({ delegated_to_team_member_id: uuid(55) }), { notes: [row.id] }), 'recently_worked_or_delegated');
    assert.strictEqual(verdict(row, { notes: [row.id], audit: { [row.id]: { days: 3 } } }), 'kept_has_note');
    assert.strictEqual(verdict(baseRow({ duplicate_status: 'suggested' }), { notes: [row.id] }), 'kept_has_note');
    // before the audit lookup has run, a kept item does not need it
    const pending = bulk.decide(row, ctxFor({ notes: [row.id], last: { [row.source_missive_conversation_id]: 200 }, auditPending: true }));
    assert.strictEqual(pending.needsAudit, false);
    assert.strictEqual(pending.reason, 'kept_has_note');
    // a context with no note list at all (older callers) keeps working
    const noList = ctxFor({ last: { [row.source_missive_conversation_id]: 200 } });
    delete noList.withNote;
    assert.strictEqual(bulk.decide(row, noList).eligible, true);
  });

  test('bulk close — no thread, no dated message, or a failed lookup are all "age unknown": never eligible', () => {
    const row = baseRow();
    const noDate = bulk.decide(row, ctxFor({ last: { [row.source_missive_conversation_id]: null } }));
    assert.strictEqual(noDate.eligible, false);
    assert.strictEqual(noDate.reason, 'not_open_or_other');
    const notLookedUp = bulk.decide(row, ctxFor({ last: {} }));
    assert.strictEqual(notLookedUp.eligible, false);
    assert.strictEqual(notLookedUp.reason, 'not_open_or_other');
    const nan = bulk.decide(row, { ...ctxFor({}), lastEmail: new Map([[row.source_missive_conversation_id, Number.NaN]]) });
    assert.strictEqual(nan.eligible, false);
    assert.strictEqual(nan.reason, 'not_open_or_other');
  });

  test('bulk close — the day edge: 89 days is recent, exactly 90 is recent, 91 qualifies (and one millisecond either side of 90 behaves)', () => {
    const row = baseRow();
    const at = (ageMs, days = 90) => {
      const ctx = ctxFor({ days });
      ctx.lastEmail = new Map([[row.source_missive_conversation_id, NOW - ageMs]]);
      const d = bulk.decide(row, ctx);
      return d.eligible ? 'eligible' : d.reason;
    };
    assert.strictEqual(at(89 * DAY), 'recent');
    assert.strictEqual(at(90 * DAY - 1), 'recent');
    assert.strictEqual(at(90 * DAY), 'recent');
    assert.strictEqual(at(90 * DAY + 1), 'eligible');
    assert.strictEqual(at(91 * DAY), 'eligible');
    // the same edge at the smallest and a big setting
    assert.strictEqual(at(30 * DAY, 30), 'recent');
    assert.strictEqual(at(31 * DAY, 30), 'eligible');
    assert.strictEqual(at(3650 * DAY, 3650), 'recent');
    assert.strictEqual(at(3651 * DAY, 3650), 'eligible');
    // an email dated in the future (clock skew) is recent, never old
    assert.strictEqual(at(-DAY), 'recent');
  });

  test('bulk close — urgent items are held back only when asked; with the box unticked an otherwise-clean urgent item qualifies', () => {
    const urgent = baseRow({ severity_tier: 'urgent' });
    assert.strictEqual(verdict(urgent, { hold: true }), 'urgent_held_back');
    assert.strictEqual(verdict(urgent, { hold: false }), 'eligible');
    // not urgent: the box makes no difference
    assert.strictEqual(verdict(baseRow({ severity_tier: 'worth_a_look' }), { hold: true }), 'eligible');
    assert.strictEqual(verdict(baseRow({ severity_tier: 'worth_a_look' }), { hold: false }), 'eligible');
    // Fair Housing is held back whatever the box says
    assert.strictEqual(verdict(baseRow({ severity_tier: 'urgent', flagged_protected_class: true, flagged_category: 'race' }), { hold: false }), 'fair_housing_flagged');
  });

  test('bulk close — "a person worked it": a person\'s newest audit row within 30 days skips it; 30 days exactly skips; older, or a system/AI row, does not', () => {
    const row = baseRow();
    const withAudit = (spec) => verdict(row, { audit: { [row.id]: spec } });
    assert.strictEqual(withAudit({ days: 1 }), 'recently_worked_or_delegated');
    assert.strictEqual(withAudit({ days: 29 }), 'recently_worked_or_delegated');
    assert.strictEqual(withAudit({ days: 30 }), 'recently_worked_or_delegated');
    assert.strictEqual(withAudit({ days: 31 }), 'eligible');
    assert.strictEqual(withAudit({ days: 400 }), 'eligible');
    assert.strictEqual(withAudit({ days: 1, type: 'system' }), 'eligible');
    assert.strictEqual(withAudit({ days: 1, type: 'ai_agent' }), 'eligible');
    // a person's action with an unreadable time counts as just now
    const ctx = ctxFor({ last: { [row.source_missive_conversation_id]: 200 } });
    ctx.latestAudit = new Map([[row.id, { actor_type: 'human', created_at: 'not a date' }]]);
    assert.strictEqual(bulk.decide(row, ctx).reason, 'recently_worked_or_delegated');
    // no audit history at all is fine
    assert.strictEqual(verdict(row, { audit: {} }), 'eligible');
  });

  test('bulk close — an audit history that could not be checked fails CLOSED (skipped, never closed)', () => {
    const row = baseRow();
    assert.strictEqual(verdict(row, { unverified: [row.id] }), 'recently_worked_or_delegated');
    assert.strictEqual(verdict(row, { unverified: [uuid(99)] }), 'eligible');
    // before the audit lookup has run, a row that would need it says so
    const pending = bulk.decide(row, ctxFor({ last: { [row.source_missive_conversation_id]: 200 }, auditPending: true }));
    assert.strictEqual(pending.needsAudit, true);
    assert.strictEqual(pending.eligible, false);
  });

  test('bulk close — when several reasons apply, the first in the documented order is the one counted (so skip counts add up exactly)', () => {
    const fh = { flagged_protected_class: true, flagged_category: 'race' };
    const cases = [
      [{ source: 'manual_staff', ...fh }, {}, 'manual_report'],
      [{ ...fh }, { ageDays: 10 }, 'recent'],
      [{ ...fh, severity_tier: 'urgent' }, {}, 'fair_housing_flagged'],
      [{ severity_tier: 'urgent', delegated_to_team_member_id: uuid(55) }, {}, 'urgent_held_back'],
      [{ delegated_to_team_member_id: uuid(55), duplicate_status: 'suggested' }, {}, 'recently_worked_or_delegated'],
      [{ blocked_since: iso(NOW - DAY), delegated_to_team_member_id: uuid(55) }, {}, 'not_open_or_other'],
      [{ source_missive_conversation_id: null, ...fh }, {}, 'not_open_or_other'],
      [{ severity_tier: 'urgent' }, { hold: false, audit: { days: 3 } }, 'recently_worked_or_delegated'],
      [{ duplicate_status: 'suggested' }, { audit: { days: 3 } }, 'recently_worked_or_delegated'],
    ];
    for (const [fields, extra, expected] of cases) {
      const row = baseRow(fields);
      const ctx = ctxFor({ hold: extra.hold !== false, last: { [row.source_missive_conversation_id]: extra.ageDays || 200 }, audit: extra.audit ? { [row.id]: extra.audit } : {} });
      const d = bulk.decide(row, ctx);
      assert.strictEqual(d.reason, expected, JSON.stringify(fields));
    }
  });

  test('bulk close — over 2,000 random rows the counts always add up (eligible + every skip reason = in scope), and the result matches a separately written all-conditions check', () => {
    const page = loadPageLaneLogic();
    const rand = prng(20261021);
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const rows = [];
    const lastEmail = new Map();
    const latestAudit = new Map();
    const oracleAudit = new Map();
    const withNote = new Set();
    for (let i = 1; i <= 2200; i += 1) {
      const fh = rand() < 0.08;
      const c = complaint(i, {
        status: rand() < 0.9 ? 'open' : pick(['in_progress', 'blocked', 'resolved', 'held']),
        source: rand() < 0.1 ? 'manual_staff' : 'email_ai',
        needs_human_call: rand() < 0.2,
        severity_tier: pick([null, 'urgent', 'worth_a_look', 'just_a_record', 'no_issue']),
        escalation_signal: rand() < 0.4 ? 'dispute' : null,
        flagged_protected_class: fh, flagged_category: fh ? 'race' : (rand() < 0.03 ? 'disability' : null),
        category: rand() < 0.05 ? 'accommodation_related' : (rand() < 0.08 ? 'legal_exposure' : (rand() < 0.1 ? 'owner_instruction' : 'dispute')),
        delegated_to_team_member_id: rand() < 0.05 ? uuid(55) : null,
        duplicate_status: pick(['none', 'none', 'none', 'suggested', 'dismissed']),
        possible_duplicate_of_id: rand() < 0.07 ? uuid(2) : null,
        blocked_since: rand() < 0.03 ? iso(NOW - 40 * DAY) : null,
        merged_into_id: rand() < 0.02 ? uuid(3) : null,
        held_legal_fair_housing: rand() < 0.01,
        source_missive_conversation_id: rand() < 0.05 ? null : `conv-${i}`,
      });
      rows.push(c);
      const hasDate = rand() < 0.92;
      const days = Math.floor(rand() * 900);
      if (c.source_missive_conversation_id) lastEmail.set(c.source_missive_conversation_id, hasDate ? NOW - days * DAY : null);
      const r = rand();
      if (r < 0.3) {
        const type = rand() < 0.7 ? 'human' : 'system';
        const ageDays = 1 + Math.floor(rand() * 120);
        latestAudit.set(c.id, { actor_type: type, created_at: iso(NOW - ageDays * DAY) });
        oracleAudit.set(c.id, { type, ageDays });
      }
      c.__days = hasDate && c.source_missive_conversation_id ? days : null;
      if (c.category === 'owner_instruction') c.owner_instruction_rejected = pick([null, 'true', 'false', 'uncertain']);
      if (rand() < 0.06) withNote.add(c.id);
    }
    for (const hold of [true, false]) for (const holdLegal of [true, false]) for (const days of [30, 90, 365]) {
      const ctx = { nowMs: NOW, olderThanDays: days, holdBackUrgent: hold, holdBackLegal: holdLegal, withNote, lastEmail, latestAudit, auditUnverified: new Set() };
      const out = bulk.classifyRows(rows, ctx);
      const skippedTotal = Object.values(out.skipped).reduce((a, b) => a + b, 0);
      assert.strictEqual(out.eligible.length + skippedTotal, out.open_in_scope, `counts must add up (days=${days}, hold=${hold}, legal=${holdLegal})`);
      assert.deepStrictEqual(Object.keys(out.skipped).sort(), [...bulk.skipReasonsFor(holdLegal)].sort());
      assert.strictEqual('legal_held_back' in out.skipped, holdLegal, 'legal_held_back is in the answer only when that box is ticked');
      const expectedIds = rows.filter((c) => {
        const lane = String(page.laneOf(c));
        if (c.status !== 'open' || c.merged_into_id || c.held_legal_fair_housing) return false;
        if (lane !== 'call' && lane !== 'flagged') return false;
        if (c.source === 'manual_staff') return false;
        if (c.__days === null || !(c.__days > days)) return false;
        if (c.flagged_protected_class || c.flagged_category || c.category === 'accommodation_related') return false;
        if (hold && c.severity_tier === 'urgent') return false;
        if (holdLegal && (c.category === 'legal_exposure' || c.owner_instruction_rejected === 'true' || c.owner_instruction_rejected === 'uncertain')) return false;
        if (c.blocked_since || c.delegated_to_team_member_id) return false;
        if (withNote.has(c.id)) return false;
        const a = oracleAudit.get(c.id);
        if (a && a.type === 'human' && a.ageDays <= 30) return false;
        if (c.duplicate_status === 'suggested' || (c.possible_duplicate_of_id && !['dismissed', 'confirmed_merged'].includes(c.duplicate_status))) return false;
        return true;
      }).map((c) => c.id).sort();
      assert.deepStrictEqual(out.eligible.map((e) => e.row.id).sort(), expectedIds, `eligible set differs from the separate check (days=${days}, hold=${hold}, legal=${holdLegal})`);
      const legalInEligible = out.eligible.filter((e) => e.row.category === 'legal_exposure' || ['true', 'uncertain'].includes(e.row.owner_instruction_rejected)).length;
      assert.strictEqual(out.legal_tagged, legalInEligible, 'legal_tagged counts the legal-exposure items that WILL be closed');
      if (holdLegal) assert.strictEqual(out.legal_tagged, 0);
    }
  });

  test('bulk close — the by-year counts use the year of the last email, and eligible rows come back oldest email first', () => {
    const rows = [complaint(1), complaint(2), complaint(3)];
    const ctx = ctxFor({ last: { 'conv-1': 100, 'conv-2': 800, 'conv-3': 500 } });
    const out = bulk.classifyRows(rows, ctx);
    assert.deepStrictEqual(out.eligible.map((e) => e.row.id), [uuid(1002), uuid(1003), uuid(1001)]);
    assert.deepStrictEqual(out.eligible_by_year, { 2024: 1, 2025: 1, 2026: 1 });
    assert.deepStrictEqual(bulk.classifyRows([], ctx).eligible_by_year, {});
  });

  // ====================================================================
  // 3. Input checks
  // ====================================================================

  test('bulk close — option parsing: defaults, the 30..3650 range, and strict types for the address (strings) and the body (numbers, booleans)', () => {
    assert.deepStrictEqual(bulk.parseOptions({}, { fromQuery: true }), { olderThanDays: 90, holdBackUrgent: true, holdBackLegal: false });
    assert.deepStrictEqual(bulk.parseOptions(undefined, { fromQuery: true }), { olderThanDays: 90, holdBackUrgent: true, holdBackLegal: false });
    assert.deepStrictEqual(bulk.parseOptions({ older_than_days: '30', hold_back_urgent: 'false' }, { fromQuery: true }), { olderThanDays: 30, holdBackUrgent: false, holdBackLegal: false });
    assert.deepStrictEqual(bulk.parseOptions({ older_than_days: '3650', hold_back_urgent: 'true', hold_back_legal: 'true' }, { fromQuery: true }), { olderThanDays: 3650, holdBackUrgent: true, holdBackLegal: true });
    assert.deepStrictEqual(bulk.parseOptions({ older_than_days: 45, hold_back_urgent: false }), { olderThanDays: 45, holdBackUrgent: false, holdBackLegal: false });
    assert.deepStrictEqual(bulk.parseOptions({ hold_back_legal: true }), { olderThanDays: 90, holdBackUrgent: true, holdBackLegal: true });
    assert.deepStrictEqual(bulk.parseOptions({}), { olderThanDays: 90, holdBackUrgent: true, holdBackLegal: false });
    const badQuery = ['29', '3651', '0', '-1', '-90', '9.5', '1e3', '0x5A', ' 90', '90 ', '90abc', 'abc', '', 'NaN', 'Infinity', '999999', '００９０', ['90', '91'], { a: 1 }, 90, null, true];
    for (const v of badQuery) assert.ok(bulk.parseOptions({ older_than_days: v }, { fromQuery: true }).error, `address value ${JSON.stringify(v)} must be refused`);
    const badBody = ['90', '30', 29, 3651, 0, -1, -90, 90.5, 1e9, Number.NaN, Infinity, -Infinity, null, true, [90], { n: 90 }, ''];
    for (const v of badBody) assert.ok(bulk.parseOptions({ older_than_days: v }).error, `body value ${JSON.stringify(v)} must be refused`);
    const badHoldQuery = ['yes', '1', '0', 'TRUE', 'False', '', ' true', ['true'], true, false, null];
    for (const v of badHoldQuery) assert.ok(bulk.parseOptions({ hold_back_urgent: v }, { fromQuery: true }).error, `address hold value ${JSON.stringify(v)} must be refused`);
    const badHoldBody = ['true', 'false', 1, 0, null, [], {}, 'yes', ''];
    for (const v of badHoldBody) assert.ok(bulk.parseOptions({ hold_back_urgent: v }).error, `body hold value ${JSON.stringify(v)} must be refused`);
    // the legal box is held to the same strict types
    for (const v of badHoldQuery) assert.ok(bulk.parseOptions({ hold_back_legal: v }, { fromQuery: true }).error, `address legal value ${JSON.stringify(v)} must be refused`);
    for (const v of badHoldBody) assert.ok(bulk.parseOptions({ hold_back_legal: v }).error, `body legal value ${JSON.stringify(v)} must be refused`);
    // nothing in a request can switch the Fair Housing hold-back off: other keys are simply not read
    const sneaky = bulk.parseOptions({ older_than_days: 90, hold_back_fair_housing: false, include_fair_housing: true, hold_back_protected: false, allow_fair_housing: true });
    assert.deepStrictEqual(sneaky, { olderThanDays: 90, holdBackUrgent: true, holdBackLegal: false });
  });

  // ====================================================================
  // 4. Wording
  // ====================================================================

  test('bulk close — the resolution note has the exact required wording and carries the batch tag verbatim', () => {
    const batchId = uuid(5001);
    const note = bulk.buildNote({ olderThanDays: 90, batchId, approverName: 'Peter McKenzie', nowMs: NOW });
    assert.strictEqual(note, `Closed in bulk: no email activity for over 90 days (batch ${batchId}), approved by Peter McKenzie on 2026-10-21.`);
    assert.ok(note.includes(bulk.batchTag(batchId)));
    assert.strictEqual(bulk.batchTag(batchId), `(batch ${batchId})`);
    assert.ok(note.length < 200);
    // the date is the Los Angeles date: 02:00 UTC on the 22nd is still the 21st there
    const late = bulk.buildNote({ olderThanDays: 120, batchId, approverName: 'Pat', nowMs: Date.UTC(2026, 9, 22, 2, 0, 0) });
    assert.ok(late.endsWith('approved by Pat on 2026-10-21.'), late);
    // a name with control characters or a huge length cannot break the note
    const messy = bulk.buildNote({ olderThanDays: 90, batchId, approverName: `Pe\nter\t${'x'.repeat(500)}`, nowMs: NOW });
    assert.ok(!/[\n\t]/.test(messy));
    assert.ok(messy.length < 300);
    assert.ok(bulk.buildNote({ olderThanDays: 90, batchId, approverName: '', nowMs: NOW }).includes('approved by a signed-in user'));
  });

  test('bulk close — safety by construction: no delete, no mail/text/AI module, and the complaint text and notes are never read for the preview or the close', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'bulk-close.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\.delete\s*\(/.test(code), 'the bulk close must never delete anything');
    assert.ok(!/\.upsert\s*\(/.test(code));
    assert.ok(!/nodemailer|anthropic|twilio|sendMail|sendMessage|openai|fetch\s*\(|https?:\/\//i.test(code), 'no mail, text, AI or network call belongs here');
    assert.ok(!/\.rpc\s*\(/.test(code));
    const columns = bulk.COMPLAINT_COLUMNS.split(',').map((s) => s.trim());
    assert.ok(!columns.includes('description') && !columns.includes('resolution_note'));
    assert.ok(columns.includes('flagged_protected_class') && columns.includes('flagged_category') && columns.includes('severity_tier'));
    assert.ok(columns.includes('owner_instruction_rejected') && columns.includes('category'), 'the legal-exposure signals are read');
    const tables = [...code.matchAll(/\.from\(\s*'([a-z_]+)'\s*\)/g)].map((m) => m[1]);
    assert.deepStrictEqual([...new Set(tables)].sort(), ['audit_log', 'complaints', 'team_members']);
  });

  // ====================================================================
  // 5. The preview
  // ====================================================================

  asyncTest('bulk close — preview: the exact counts on a mixed set (every skip reason once or more, out-of-scope rows not counted), nothing written, and no complaint text or notes read', async () => {
    const db = mixedWorld().db();
    const svc = service(db);
    const res = await svc.preview({ older_than_days: '90', hold_back_urgent: 'true' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, EXPECTED_MIXED_PREVIEW);
    assert.strictEqual(res.body.eligible + Object.values(res.body.skipped).reduce((a, b) => a + b, 0), res.body.open_in_scope);

    assert.strictEqual(db.state.writes.length, 0, 'a preview must not write anything');
    assert.strictEqual(db.state.deleteAttempts, 0);
    for (const call of db.state.calls) assert.strictEqual(call.op, 'select');
    const complaintSelects = db.state.calls.filter((c) => c.table === 'complaints');
    assert.ok(complaintSelects.length >= 2);
    // the item reads ask for the agreed columns; whether a note exists is asked for by id only (never the note itself)
    const noteReads = complaintSelects.filter((c) => c.cols === 'id');
    assert.strictEqual(noteReads.length, 1);
    assert.ok(noteReads[0].filters.some((f) => f.kind === 'not' && f.col === 'resolution_note' && f.op === 'is' && f.val === null), 'only ids of items that HAVE a note');
    for (const c of complaintSelects.filter((x) => x.cols !== 'id')) assert.strictEqual(c.cols, bulk.COMPLAINT_COLUMNS);
    for (const c of db.state.calls.filter((x) => x.table === 'missive_message_intake')) assert.strictEqual(c.cols, 'missive_conversation_id, delivered_at', 'only ids and dates may be read from the email table');
    const lookedUp = db.state.calls.filter((x) => x.table === 'missive_message_intake').flatMap((c) => c.filters.filter((f) => f.kind === 'in').flatMap((f) => f.val)).sort();
    const wanted = [...Array.from({ length: 12 }, (_, i) => i + 1), 15, 16, 17, 18, 19, 20, 21].map((n) => `conv-${n}`).sort();
    assert.deepStrictEqual(lookedUp, wanted, 'email dates are looked up only for in-scope items that came from an email thread (not typed-in reports, not out-of-scope items)');
    for (const c of db.state.calls.filter((x) => x.table === 'audit_log')) {
      assert.strictEqual(c.cols, 'entity_id, actor_type, actor_id, created_at');
      assert.ok(c.filters.some((f) => f.kind === 'not' && f.col === 'action' && f.op === 'in' && f.val.includes(bulk.ACTIONS.itemClosed) && f.val.includes(bulk.ACTIONS.itemReopened)), 'this feature\'s own close/undo rows are left out of the "a person worked on it" test');
    }
  });

  asyncTest('bulk close — preview with "hold back urgent" unticked: the two urgent items become eligible and the by-year table follows', async () => {
    const svc = service(mixedWorld().db());
    const res = await svc.preview({ older_than_days: '90', hold_back_urgent: 'false' });
    assert.strictEqual(res.body.eligible, 7);
    assert.deepStrictEqual(res.body.eligible_by_year, { 2024: 1, 2025: 3, 2026: 3 });
    assert.strictEqual(res.body.skipped.urgent_held_back, 0);
    assert.strictEqual(res.body.open_in_scope, 22);
    assert.strictEqual(res.body.hold_back_urgent, false);
  });

  asyncTest('bulk close — preview: the day setting moves the edge (30, 120, 400 days) and the defaults are 90 days with urgent held back', async () => {
    const svc = service(mixedWorld().db());
    const at = async (days) => (await svc.preview({ older_than_days: String(days) })).body;
    assert.strictEqual((await at(30)).eligible, 7); // n=5 (10 days) stays recent; 6, 8 (90, 89 days) are now old enough
    assert.strictEqual((await at(30)).skipped.recent, 1);
    assert.strictEqual((await at(120)).eligible, 3); // n=1 (exactly 120) and n=7 (91) are recent now
    assert.strictEqual((await at(400)).eligible, 2); // only 800 and 500 days
    const defaults = (await svc.preview({})).body;
    assert.strictEqual(defaults.older_than_days, 90);
    assert.strictEqual(defaults.hold_back_urgent, true);
    assert.strictEqual((await svc.preview({ older_than_days: '29' })).status, 400);
  });

  asyncTest('bulk close — preview reads open complaints a page at a time past the 1,000-row cap (2,500 open items are all counted)', async () => {
    const w = world();
    for (let n = 1; n <= 2500; n += 1) w.add(n, 200);
    const db = w.db();
    const res = await service(db).preview({});
    assert.strictEqual(res.body.open_in_scope, 2500);
    assert.strictEqual(res.body.eligible, 2500);
    assert.strictEqual(res.body.over_cap, true);
    assert.strictEqual(res.body.cap, 2000);
    assert.strictEqual(db.state.calls.filter((c) => c.table === 'complaints' && c.cols !== 'id').length, 3, 'three pages of up to 1,000');
    assert.strictEqual(db.state.calls.filter((c) => c.table === 'complaints' && c.cols === 'id').length, 1, 'one id-only read for the notes');
    assert.strictEqual(res.body.skipped.kept_has_note, 0);
  });

  // ====================================================================
  // 6. The real close
  // ====================================================================

  asyncTest('bulk close — close: exactly the previewed set is closed, with the exact note, and nothing else about any complaint changes', async () => {
    const w = mixedWorld();
    const before = w.complaints.map((c) => JSON.parse(JSON.stringify(c)));
    const db = w.db();
    const svc = service(db);
    const res = await svc.execute(mixedBody(), ACTOR);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.closed, 5);
    assert.strictEqual(res.body.failed, 0);
    assert.strictEqual(res.body.skipped_changed, 0);
    assert.strictEqual(res.body.older_than_days, 90);
    assert.strictEqual(res.body.hold_back_urgent, true);
    assert.strictEqual(res.body.hold_back_legal, false);
    assert.strictEqual(res.body.audit_failed, 0);
    const batchId = res.body.batch_id;
    assert.ok(/^[0-9a-f-]{36}$/.test(batchId));

    const expectedNote = `Closed in bulk: no email activity for over 90 days (batch ${batchId}), approved by Peter McKenzie on 2026-10-21.`;
    for (const original of before) {
      const now = db.tables.complaints.find((c) => c.id === original.id);
      if (ELIGIBLE_MIXED.includes(original.id)) {
        assert.strictEqual(now.status, 'resolved', original.id);
        assert.strictEqual(now.resolution_note, expectedNote);
        const changed = Object.keys(now).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(original[k])).sort();
        assert.deepStrictEqual(changed, ['resolution_note', 'status', 'updated_at'], 'only status and resolution_note (and the automatic updated_at) may change');
      } else {
        assert.deepStrictEqual(now, original, `item ${original.id} must not be touched`);
      }
    }
    // the same set the preview named
    assert.deepStrictEqual(db.writesTo('complaints', 'update').flatMap((x) => x.ids).sort(), [...ELIGIBLE_MIXED].sort());
    for (const write of db.writesTo('complaints', 'update')) {
      assert.deepStrictEqual(Object.keys(write.patch).sort(), ['resolution_note', 'status']);
      assert.deepStrictEqual(write.patch.status, 'resolved');
      const guards = guardsOf(write);
      for (const g of ['eq:status', 'is:merged_into_id', 'eq:held_legal_fair_housing', 'is:delegated_to_team_member_id', 'lte:updated_at', 'in:id',
        'is:resolution_note', 'eq:flagged_protected_class', 'is:flagged_category', 'or:category', 'or:severity_tier']) assert.ok(guards.includes(g), `update must be guarded by ${g}`);
      assert.ok(!guards.includes('or:owner_instruction_rejected'), 'the legal guards are not there when the legal box is not ticked');
      assert.strictEqual(write.filters.find((f) => f.col === 'status').val, 'open');
      assert.strictEqual(write.filters.find((f) => f.col === 'resolution_note').val, null, 'a note is never overwritten');
    }
    assert.deepStrictEqual([...new Set(db.state.writes.map((x) => x.table))].sort(), ['audit_log', 'complaints']);
    assert.strictEqual(db.state.deleteAttempts, 0);
  });

  asyncTest('bulk close — non-default settings (30 days, urgent not held back) are used everywhere: the set, the note, the response, the audit rows and the batch list', async () => {
    const w = mixedWorld();
    w.members.push({ id: uuid(300), full_name: 'Peter McKenzie', email: ACTOR.email, is_active: true, auth_user_id: 'u1' });
    const db = w.db();
    const svc = service(db);
    const preview = (await svc.preview({ older_than_days: '30', hold_back_urgent: 'false' })).body;
    assert.strictEqual(preview.eligible, 9);
    assert.strictEqual(preview.older_than_days, 30);
    assert.strictEqual(preview.hold_back_urgent, false);
    assert.strictEqual(preview.skipped.urgent_held_back, 0);
    const res = await svc.execute({ older_than_days: 30, hold_back_urgent: false, expected_count: 9, expected_hash: preview.set_hash }, ACTOR);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.closed, 9);
    assert.strictEqual(res.body.older_than_days, 30);
    assert.strictEqual(res.body.hold_back_urgent, false);
    const batchId = res.body.batch_id;
    const closedRows = db.tables.complaints.filter((c) => c.resolution_note && c.resolution_note.startsWith('Closed in bulk'));
    assert.strictEqual(closedRows.length, 9);
    for (const c of closedRows) assert.strictEqual(c.resolution_note, `Closed in bulk: no email activity for over 30 days (batch ${batchId}), approved by Peter McKenzie on 2026-10-21.`);
    assert.ok(closedRows.some((c) => c.severity_tier === 'urgent'), 'urgent items were closed because the box was unticked');
    const audit = db.writesTo('audit_log', 'insert').flatMap((x) => x.rows);
    for (const r of audit.filter((x) => x.action === bulk.ACTIONS.itemClosed)) {
      assert.strictEqual(r.details.older_than_days, 30);
      assert.strictEqual(r.details.hold_back_urgent, false);
    }
    const batchRow = audit.find((x) => x.action === bulk.ACTIONS.batchClosed);
    assert.strictEqual(batchRow.details.older_than_days, 30);
    assert.strictEqual(batchRow.details.hold_back_urgent, false);
    assert.strictEqual(batchRow.details.closed, 9);
    const listed = (await svc.listBatches()).body.batches[0];
    assert.strictEqual(listed.older_than_days, 30);
    assert.strictEqual(listed.hold_back_urgent, false);
    assert.strictEqual(listed.closed, 9);
    // a preview made with other settings does not authorise this close: the count is for THESE settings
    const db2 = mixedWorld().db();
    const mismatch = await service(db2).execute({ older_than_days: 30, hold_back_urgent: false, expected_count: 5, expected_hash: preview.set_hash }, ACTOR);
    assert.strictEqual(mismatch.status, 409);
    assert.strictEqual(mismatch.body.eligible, 9);
    assert.strictEqual(db2.state.writes.length, 0);
  });

  asyncTest('bulk close — the set the preview shows is the set the close acts on (random world of 700 complaints, every combination of the urgent and legal boxes)', async () => {
    const page = loadPageLaneLogic();
    for (const hold of [true, false]) for (const holdLegal of [true, false]) {
      const rand = prng((hold ? 7 : 11) + (holdLegal ? 100 : 0));
      const pick = (list) => list[Math.floor(rand() * list.length)];
      const w = world();
      for (let n = 1; n <= 700; n += 1) {
        const fh = rand() < 0.08;
        const category = rand() < 0.1 ? 'legal_exposure' : (rand() < 0.1 ? 'owner_instruction' : (rand() < 0.04 ? 'accommodation_related' : 'dispute'));
        w.add(n, rand() < 0.08 ? null : Math.floor(rand() * 600), {
          status: rand() < 0.9 ? 'open' : pick(['in_progress', 'resolved']),
          source: rand() < 0.08 ? 'manual_staff' : 'email_ai',
          needs_human_call: rand() < 0.2,
          severity_tier: pick([null, 'urgent', 'worth_a_look', 'just_a_record', 'no_issue']),
          escalation_signal: rand() < 0.4 ? 'dispute' : null,
          flagged_protected_class: fh, flagged_category: fh ? 'race' : null,
          category,
          owner_instruction_rejected: category === 'owner_instruction' ? pick([null, 'true', 'false', 'uncertain']) : null,
          delegated_to_team_member_id: rand() < 0.05 ? uuid(55) : null,
          duplicate_status: pick(['none', 'none', 'suggested']),
          resolution_note: rand() < 0.06 ? 'An older note a person wrote' : null,
        }, rand() < 0.15 ? [{ days: 1 + Math.floor(rand() * 90), type: rand() < 0.7 ? 'human' : 'system' }] : []);
      }
      // a resolved row must carry a note
      for (const c of w.complaints) if (c.status === 'resolved' && !c.resolution_note) c.resolution_note = 'Done earlier';
      const before = new Map(w.complaints.map((c) => [c.id, JSON.stringify(c)]));
      const db = w.db();
      const svc = service(db);
      const opts = { older_than_days: 90, hold_back_urgent: hold, hold_back_legal: holdLegal };
      const preview = (await svc.preview({ older_than_days: '90', hold_back_urgent: String(hold), hold_back_legal: String(holdLegal) })).body;
      const planned = (await svc.evaluate({ olderThanDays: 90, holdBackUrgent: hold, holdBackLegal: holdLegal })).eligible.map((e) => e.row.id).sort();
      assert.strictEqual(planned.length, preview.eligible);
      assert.strictEqual(preview.set_hash, bulk.setHash(planned));
      assert.ok(preview.eligible > 20 && preview.eligible < 2000, `a useful size of test set (${preview.eligible})`);
      assert.strictEqual(preview.eligible + Object.values(preview.skipped).reduce((a, b) => a + b, 0), preview.open_in_scope, 'the counts add up');
      assert.ok(preview.skipped.kept_has_note > 0, 'the world has open items with notes');
      const res = await svc.execute({ ...opts, expected_count: preview.eligible, expected_hash: preview.set_hash }, ACTOR);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.closed, preview.eligible);
      const closedIds = db.tables.complaints.filter((c) => c.resolution_note && c.resolution_note.startsWith('Closed in bulk')).map((c) => c.id).sort();
      assert.deepStrictEqual(closedIds, planned, 'the closed set must equal the previewed set');
      // and every one of them is a Needs a Call / Flagged item by the page's own rule, was open, had no note, and is no Fair Housing item
      const byId = new Map(w.complaints.map((c) => [c.id, c]));
      let legalClosed = 0;
      for (const id of closedIds) {
        const orig = JSON.parse(before.get(id));
        assert.ok(['call', 'flagged'].includes(String(page.laneOf(orig))), 'closed an item outside Needs a Call / Flagged for Review');
        assert.strictEqual(orig.status, 'open');
        assert.strictEqual(orig.resolution_note, null, 'a note was overwritten');
        assert.ok(!orig.flagged_protected_class && !orig.flagged_category && orig.category !== 'accommodation_related', 'a Fair Housing item was closed');
        if (orig.category === 'legal_exposure' || ['true', 'uncertain'].includes(orig.owner_instruction_rejected)) legalClosed += 1;
        if (hold) assert.notStrictEqual(orig.severity_tier, 'urgent');
        assert.ok(byId.get(id));
      }
      assert.strictEqual(legalClosed, preview.legal_tagged_in_eligible, 'the preview said how many legal-exposure items would close');
      if (holdLegal) assert.strictEqual(legalClosed, 0); else assert.ok(legalClosed > 0, 'with the box unticked, legal-exposure items are closed');
      // nothing outside the set changed at all
      for (const c of db.tables.complaints) if (!closedIds.includes(c.id)) assert.strictEqual(JSON.stringify(c), before.get(c.id), 'an item outside the set changed');
    }
  });

  asyncTest('bulk close — a stale preview never closes a different set: a count that does not match gets 409 and nothing is written (more or fewer)', async () => {
    for (const expected of [4, 6, 1, 2000, 22]) {
      const db = mixedWorld().db();
      const res = await service(db).execute(closeBody(expected), ACTOR);
      assert.strictEqual(res.status, 409, `expected_count ${expected}`);
      assert.strictEqual(res.body.eligible, 5);
      assert.ok(res.body.error);
      assert.strictEqual(db.state.writes.length, 0);
    }
  });

  asyncTest('bulk close — the 2,000 batch cap: 2,001 eligible gets 422 and nothing is written; exactly 2,000 is allowed', async () => {
    const big = (count) => { const w = world(); for (let n = 1; n <= count; n += 1) w.add(n, 200); return w; };
    const dbOver = big(2001).db();
    const over = await service(dbOver).execute(closeBody(2001), ACTOR);
    assert.strictEqual(over.status, 422);
    assert.strictEqual(over.body.eligible, 2001);
    assert.strictEqual(over.body.cap, 2000);
    assert.strictEqual(dbOver.state.writes.length, 0);
    const preview = await service(dbOver).preview({});
    assert.strictEqual(preview.body.over_cap, true);

    const dbExact = big(2000).db();
    const exact = await service(dbExact).execute(closeBody(2000), ACTOR);
    assert.strictEqual(exact.status, 200);
    assert.strictEqual(exact.body.closed, 2000);
    assert.strictEqual((await service(big(2000).db()).preview({})).body.over_cap, false);
  });

  asyncTest('bulk close — writes go in groups of at most 80 ids (updates and audit inserts), so no request address is too long', async () => {
    const w = world();
    for (let n = 1; n <= 200; n += 1) w.add(n, 200);
    const db = w.db();
    const res = await service(db).execute(closeBody(200), ACTOR);
    assert.strictEqual(res.body.closed, 200);
    const updates = db.writesTo('complaints', 'update');
    assert.deepStrictEqual(updates.map((u) => u.ids.length), [80, 80, 40]);
    const auditInserts = db.writesTo('audit_log', 'insert');
    assert.deepStrictEqual(auditInserts.map((a) => a.rows.length), [1, 80, 80, 40, 1], 'the start row, three groups, the end row');
    assert.strictEqual(res.body.audit_failed, 0);
    for (const call of db.state.calls) for (const f of call.filters) if (f.kind === 'in') assert.ok(f.val.length <= 100, 'no id list longer than the other lookups use');
  });

  asyncTest('bulk close — one failed group is fail-soft and counted truthfully; the others still close; the batch row records the real counts; re-running finishes the rest without touching anything twice', async () => {
    const w = world();
    for (let n = 1; n <= 200; n += 1) w.add(n, 200);
    let updates = 0;
    const db = w.db({ fail: (q) => { if (q.table === 'complaints' && q.op === 'update') { updates += 1; if (updates === 2) return { message: 'simulated outage' }; } return null; } });
    const svc = service(db);
    const { value: res } = await quiet(() => svc.execute(closeBody(200), ACTOR));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.closed, 120);
    assert.strictEqual(res.body.failed, 80);
    assert.strictEqual(res.body.skipped_changed, 0);
    const resolved = db.tables.complaints.filter((c) => c.status === 'resolved');
    assert.strictEqual(resolved.length, 120);
    const batchRow = db.writesTo('audit_log', 'insert').flatMap((x) => x.rows).find((r) => r.action === bulk.ACTIONS.batchClosed);
    assert.strictEqual(batchRow.details.closed, 120);
    assert.strictEqual(batchRow.details.failed, 80);
    const itemAudit = db.writesTo('audit_log', 'insert').flatMap((x) => x.rows).filter((r) => r.action === bulk.ACTIONS.itemClosed);
    assert.strictEqual(itemAudit.length, 120, 'one audit row per item that really closed, none for the failed group');
    assert.deepStrictEqual(new Set(itemAudit.map((r) => r.entity_id)), new Set(resolved.map((c) => c.id)));

    // re-run: only the 80 still open qualify; the 120 already done are not touched again
    const writesBefore = db.state.writes.length;
    const again = await svc.preview({});
    assert.strictEqual(again.body.eligible, 80);
    const second = await svc.execute(closeBody(80, { expected_hash: again.body.set_hash }), ACTOR);
    assert.strictEqual(second.body.closed, 80);
    assert.strictEqual(second.body.failed, 0);
    const secondUpdates = db.state.writes.slice(writesBefore).filter((x) => x.table === 'complaints');
    assert.strictEqual(secondUpdates.flatMap((x) => x.ids).length, 80);
    assert.strictEqual(db.tables.complaints.filter((c) => c.status === 'resolved').length, 200);
    const allItemAudit = db.writesTo('audit_log', 'insert').flatMap((x) => x.rows).filter((r) => r.action === bulk.ACTIONS.itemClosed);
    assert.strictEqual(allItemAudit.length, 200);
    assert.strictEqual(new Set(allItemAudit.map((r) => r.entity_id)).size, 200, 'no item gets two closing audit rows');
  });

  asyncTest('bulk close — an update whose answer was lost on the way back but was saved is found by its batch tag and counted as closed; the double fault (the check also fails) is counted failed, and undo still finds them by tag', async () => {
    const make = () => { const w = world(); for (let n = 1; n <= 200; n += 1) w.add(n, 200); return w; };
    let updates = 0;
    const dbLost = make().db({ fail: (q) => { if (q.table === 'complaints' && q.op === 'update') { updates += 1; if (updates === 2) return { message: 'connection reset', applied: true }; } return null; } });
    const { value: lost } = await quiet(() => service(dbLost).execute(closeBody(200), ACTOR));
    assert.strictEqual(lost.body.closed, 200);
    assert.strictEqual(lost.body.failed, 0);
    const lostItemAudit = dbLost.writesTo('audit_log', 'insert').flatMap((x) => x.rows).filter((r) => r.action === bulk.ACTIONS.itemClosed);
    assert.strictEqual(lostItemAudit.length, 200, 'the saved group still gets its audit rows');

    let updates2 = 0;
    const dbDouble = make().db({
      fail: (q) => {
        if (q.table === 'complaints' && q.op === 'update') { updates2 += 1; if (updates2 === 2) return { message: 'connection reset', applied: true }; }
        if (q.table === 'complaints' && q.op === 'select' && q.cols === 'id, property_id') return { message: 'still down' }; // the "what was saved?" check only
        return null;
      },
    });
    const svc = service(dbDouble);
    const { value: dbl } = await quiet(() => svc.execute(closeBody(200), ACTOR));
    assert.strictEqual(dbl.body.closed, 120);
    assert.strictEqual(dbl.body.failed, 80, 'a group that cannot be checked is reported as failed (never claimed as closed)');
    const tagged = dbDouble.tables.complaints.filter((c) => c.status === 'resolved').length;
    assert.strictEqual(tagged, 200, 'the group really was saved');
    const undone = await svc.undo(dbl.body.batch_id, ACTOR);
    assert.strictEqual(undone.body.reopened, 200, 'undo finds every item by its tag, including the ones the counts missed');
  });

  asyncTest('bulk close — when an update\'s answer is lost, only items that carry THIS batch\'s tag are counted as closed: an item a person resolved in that same moment with their own note is not claimed', async () => {
    const w = world();
    for (let n = 1; n <= 160; n += 1) w.add(n, 200);
    let updates = 0;
    const db = w.db({
      before: (q, state) => {
        if (q.table === 'complaints' && q.op === 'update' && updates === 1) {
          const row = state.tables.complaints.find((c) => c.id === uuid(1100));
          row.status = 'resolved'; row.resolution_note = 'A person resolved this just now';
        }
      },
      fail: (q) => { if (q.table === 'complaints' && q.op === 'update') { updates += 1; if (updates === 2) return { message: 'connection reset', applied: true }; } return null; },
    });
    const { value: res } = await quiet(() => service(db).execute(closeBody(160), ACTOR));
    assert.strictEqual(res.body.closed, 159, 'the person\'s item is not counted as ours');
    assert.strictEqual(res.body.failed, 1);
    assert.strictEqual(db.tables.complaints.find((c) => c.id === uuid(1100)).resolution_note, 'A person resolved this just now');
    const audited = db.tables.audit_log.filter((r) => r.action === bulk.ACTIONS.itemClosed).map((r) => r.entity_id);
    assert.ok(!audited.includes(uuid(1100)), 'and it gets no closing audit row');
  });

  asyncTest('bulk close — items that changed between the read and the write (worked, delegated, edited) are left alone and counted as skipped_changed', async () => {
    const w = world();
    for (let n = 1; n <= 20; n += 1) w.add(n, 200);
    let done = false;
    const db = w.db({
      before: (q, state) => {
        if (done || q.table !== 'complaints' || q.op !== 'update') return;
        done = true;
        const row = (n) => state.tables.complaints.find((c) => c.id === uuid(1000 + n));
        row(3).status = 'in_progress';
        row(4).delegated_to_team_member_id = uuid(55);
        // changed after the read, but updated_at did NOT move (as if the database's own stamp were missing): only the
        // write's own guards can notice these
        row(8).flagged_protected_class = true; row(8).flagged_category = 'race';
        row(9).category = 'accommodation_related';
        row(10).resolution_note = 'A person typed this just now';
        row(12).severity_tier = 'urgent';
        // changed after the read in a way no guard names: only the updated_at fence notices it
        row(5).property_id = uuid(8); row(5).updated_at = iso(NOW + 60000);
        row(6).merged_into_id = uuid(1001); row(6).duplicate_status = 'confirmed_merged';
        row(7).held_legal_fair_housing = true;
      },
    });
    const res = await service(db).execute(closeBody(20), ACTOR);
    assert.strictEqual(res.status, 200);
    const changedMidway = [3, 4, 5, 6, 7, 8, 9, 10, 12];
    assert.strictEqual(res.body.closed, 20 - changedMidway.length);
    assert.strictEqual(res.body.skipped_changed, changedMidway.length);
    assert.strictEqual(res.body.failed, 0);
    for (const n of changedMidway) {
      const now = db.tables.complaints.find((c) => c.id === uuid(1000 + n));
      assert.notStrictEqual(now.status, 'resolved', `item ${n} must be left alone`);
    }
    assert.strictEqual(db.tables.complaints.find((c) => c.id === uuid(1003)).status, 'in_progress');
    assert.strictEqual(db.tables.complaints.find((c) => c.id === uuid(1010)).resolution_note, 'A person typed this just now', 'a note that appeared meanwhile is never overwritten');
    const audited = db.writesTo('audit_log', 'insert').flatMap((x) => x.rows).filter((r) => r.action === bulk.ACTIONS.itemClosed).map((r) => r.entity_id);
    assert.strictEqual(audited.length, 20 - changedMidway.length);
    for (const n of changedMidway) assert.ok(!audited.includes(uuid(1000 + n)));
  });

  asyncTest('bulk close — the write itself keeps Fair Housing items (and, when asked, urgent and legal ones) open even if they were flagged after the read; with the boxes unticked those two groups are closed, Fair Housing never', async () => {
    const run = async ({ hold, holdLegal }) => {
      const w = world();
      for (let n = 1; n <= 8; n += 1) w.add(n, 200);
      let done = false;
      const db = w.db({
        before: (q, state) => {
          if (done || q.table !== 'complaints' || q.op !== 'update') return;
          done = true;
          const row = (n) => state.tables.complaints.find((c) => c.id === uuid(1000 + n));
          row(1).severity_tier = 'urgent'; // urgent, no timestamp change
          row(2).category = 'legal_exposure';
          row(3).category = 'owner_instruction'; row(3).owner_instruction_rejected = 'true';
          row(4).category = 'owner_instruction'; row(4).owner_instruction_rejected = 'uncertain';
          row(5).category = 'accommodation_related';
          row(6).flagged_protected_class = true; row(6).flagged_category = 'disability';
          row(7).category = 'owner_instruction'; row(7).owner_instruction_rejected = 'false'; // an instruction that was NOT rejected: not a legal signal
          row(8).category = null; row(8).severity_tier = null; row(8).needs_human_call = true; // no category at all: a null is not a signal
        },
      });
      const body = { older_than_days: 90, hold_back_urgent: hold, hold_back_legal: holdLegal, expected_count: 8, expected_hash: bulk.setHash(seqIds(8)) };
      const res = await service(db).execute(body, ACTOR);
      assert.strictEqual(res.status, 200);
      return { res, closed: db.tables.complaints.filter((c) => c.status === 'resolved').map((c) => Number(c.id.slice(-4)) - 1000).sort((a, b) => a - b), db };
    };
    const neither = await run({ hold: false, holdLegal: false });
    assert.deepStrictEqual(neither.closed, [1, 2, 3, 4, 7, 8], 'boxes unticked: urgent and legal-exposure items close; Fair Housing (5, 6) never');
    const urgentOnly = await run({ hold: true, holdLegal: false });
    assert.deepStrictEqual(urgentOnly.closed, [2, 3, 4, 7, 8]);
    const both = await run({ hold: true, holdLegal: true });
    assert.deepStrictEqual(both.closed, [7, 8], 'legal box ticked: category legal_exposure and owner instructions rejected / uncertain stay open too');
    assert.strictEqual(both.res.body.skipped_changed, 6);
    const legalGuards = guardsOf(both.db.writesTo('complaints', 'update')[0]);
    assert.ok(legalGuards.includes('or:owner_instruction_rejected') && legalGuards.includes('or:severity_tier'));
    assert.strictEqual(guardsOf(neither.db.writesTo('complaints', 'update')[0]).includes('or:severity_tier'), false);
  });

  asyncTest('bulk close — running the same request again is safe: nothing qualifies, so 409 and no writes; and nothing is closed twice', async () => {
    const db = mixedWorld().db();
    const svc = service(db);
    assert.strictEqual((await svc.execute(mixedBody(), ACTOR)).status, 200);
    const writes = db.state.writes.length;
    for (const expected of [5, 1, 0]) {
      const again = await svc.execute(mixedBody({ expected_count: expected }), ACTOR);
      assert.strictEqual(again.status, expected === 0 ? 400 : 409);
    }
    assert.strictEqual(db.state.writes.length, writes);
    assert.strictEqual((await svc.preview({})).body.eligible, 0);
  });

  asyncTest('bulk close — a close request needs a real expected_count and valid options before anything is read', async () => {
    const db = mixedWorld().db();
    const svc = service(db);
    const bad = [
      {}, { older_than_days: 90, hold_back_urgent: true },
      closeBody(0), closeBody(-5), closeBody(1.5), closeBody('5'), closeBody(null), closeBody(Number.NaN), closeBody(Infinity), closeBody(1e12), closeBody(undefined),
      closeBody(5, { older_than_days: '90' }), closeBody(5, { older_than_days: 29 }), closeBody(5, { older_than_days: -1 }), closeBody(5, { older_than_days: 3651 }),
      closeBody(5, { older_than_days: Number.NaN }), closeBody(5, { older_than_days: 1e9 }), closeBody(5, { older_than_days: null }),
      closeBody(5, { hold_back_urgent: 'true' }), closeBody(5, { hold_back_urgent: 1 }), closeBody(5, { hold_back_urgent: null }),
      closeBody(5, { hold_back_legal: 'true' }), closeBody(5, { hold_back_legal: 1 }), closeBody(5, { hold_back_legal: null }), closeBody(5, { hold_back_legal: [] }),
      closeBody(5, { expected_hash: undefined }), closeBody(5, { expected_hash: '' }), closeBody(5, { expected_hash: 'abc' }), closeBody(5, { expected_hash: null }),
      closeBody(5, { expected_hash: 12345 }), closeBody(5, { expected_hash: ['a'.repeat(64)] }), closeBody(5, { expected_hash: 'g'.repeat(64) }),
      closeBody(5, { expected_hash: 'a'.repeat(63) }), closeBody(5, { expected_hash: 'a'.repeat(65) }), closeBody(5, { expected_hash: ` ${'a'.repeat(63)}` }),
      null, undefined, 'a string', [5], 5,
    ];
    for (const body of bad) {
      const res = await svc.execute(body, ACTOR);
      assert.strictEqual(res.status, 400, JSON.stringify(body));
      assert.ok(res.body.error);
    }
    assert.strictEqual(db.state.calls.length, 0, 'bad input must be refused before any database access');
  });

  asyncTest('bulk close — two close requests at once: one runs, the other is refused (409) and nothing is closed twice; the lock frees afterwards, even after an error', async () => {
    const db = mixedWorld().db();
    const svc = service(db);
    const [a, b] = await Promise.all([svc.execute(mixedBody(), ACTOR), svc.execute(mixedBody(), ACTOR)]);
    assert.deepStrictEqual([a.status, b.status].sort(), [200, 409]);
    assert.strictEqual(db.tables.complaints.filter((c) => c.resolution_note && c.resolution_note.startsWith('Closed in bulk')).length, 5);
    assert.strictEqual(db.writesTo('audit_log', 'insert').flatMap((x) => x.rows).filter((r) => r.action === bulk.ACTIONS.itemClosed).length, 5);
    const refused = a.status === 409 ? a : b;
    assert.ok(/running/i.test(refused.body.error));
    // undo works afterwards (lock released), and an undo during a close is refused
    const winner = a.status === 200 ? a : b;
    assert.strictEqual((await svc.undo(winner.body.batch_id, ACTOR)).status, 200);

    // an error in the middle (the database is down) releases the lock too
    let failNext = true;
    const db2 = mixedWorld().db({ fail: (q) => { if (failNext && q.table === 'complaints') { failNext = false; return { message: 'down' }; } return null; } });
    const svc2 = service(db2);
    await assert.rejects(() => svc2.execute(mixedBody(), ACTOR), /could not read/);
    const retry = await svc2.execute(mixedBody(), ACTOR);
    assert.strictEqual(retry.status, 200);
  });

  // ====================================================================
  // 7. Who is allowed to be closed: failing closed
  // ====================================================================

  asyncTest('bulk close — an audit history that cannot be read fails closed: those items are skipped (not closed), the preview says the check was incomplete, and a close refuses the count', async () => {
    const w = world();
    for (let n = 1; n <= 10; n += 1) w.add(n, 200);
    const db = w.db({ fail: (q) => (q.table === 'audit_log' && q.op === 'select' ? { message: 'audit table unavailable' } : null) });
    const svc = service(db);
    const { value: preview } = await quiet(() => svc.preview({}));
    assert.strictEqual(preview.body.eligible, 0);
    assert.strictEqual(preview.body.skipped.recently_worked_or_delegated, 10);
    assert.strictEqual(preview.body.lookup_incomplete, true);
    const { value: closing } = await quiet(() => svc.execute(closeBody(10), ACTOR));
    assert.strictEqual(closing.status, 409);
    assert.strictEqual(db.state.writes.length, 0);
  });

  asyncTest('bulk close — email dates that cannot be read fail closed too: nothing is closed and the preview says the check was incomplete', async () => {
    const w = world();
    for (let n = 1; n <= 10; n += 1) w.add(n, 200);
    const db = w.db({ fail: (q) => (q.table === 'missive_message_intake' ? { message: 'email table unavailable' } : null) });
    const svc = service(db);
    const { value: preview } = await quiet(() => svc.preview({}));
    assert.strictEqual(preview.body.eligible, 0);
    assert.strictEqual(preview.body.skipped.not_open_or_other, 10);
    assert.strictEqual(preview.body.lookup_incomplete, true);
    const { value: closing } = await quiet(() => svc.execute(closeBody(10), ACTOR));
    assert.strictEqual(closing.status, 409);
    assert.strictEqual(db.state.writes.length, 0);
  });

  asyncTest('bulk close — the "newest audit row" reading: a person\'s action 10 days ago followed by a system row 5 days ago is judged by the newest (system) row; a newer person\'s action wins over an older system row', async () => {
    const w = world();
    w.add(1, 200, {}, [{ days: 10, type: 'human' }, { days: 5, type: 'system' }]); // newest is system -> eligible
    w.add(2, 200, {}, [{ days: 300, type: 'system' }, { days: 5, type: 'human' }]); // newest is a person -> skipped
    w.add(3, 200, {}, [{ days: 60, type: 'human' }]); // a person, but long ago -> eligible
    const res = await service(w.db()).preview({});
    assert.strictEqual(res.body.eligible, 2);
    assert.strictEqual(res.body.skipped.recently_worked_or_delegated, 1);
  });

  // ====================================================================
  // 8. Audit rows
  // ====================================================================

  asyncTest('bulk close — audit: a start row first, then one row per closed item, then one end row; ids, counts and the note only (never a complaint\'s text); the right actor on every row', async () => {
    const w = mixedWorld();
    w.members.push({ id: uuid(300), full_name: 'Peter McKenzie', email: ACTOR.email, is_active: true, auth_user_id: 'user-1' });
    const db = w.db();
    const res = await service(db).execute(mixedBody(), ACTOR);
    const batchId = res.body.batch_id;
    const rows = db.writesTo('audit_log', 'insert').flatMap((x) => x.rows);
    assert.strictEqual(rows.length, 7);
    assert.strictEqual(rows[0].action, 'complaint_tracking.bulk_close_started', 'the start row is the very first audit row');
    assert.strictEqual(rows[rows.length - 1].action, 'complaint_tracking.bulk_close_batch', 'the end row is last');
    const starts = rows.filter((r) => r.action === 'complaint_tracking.bulk_close_started');
    const items = rows.filter((r) => r.action === 'complaint_tracking.bulk_closed');
    const batches = rows.filter((r) => r.action === 'complaint_tracking.bulk_close_batch');
    assert.strictEqual(starts.length, 1);
    assert.strictEqual(items.length, 5);
    assert.strictEqual(batches.length, 1);
    assert.deepStrictEqual(items.map((r) => r.entity_id).sort(), [...ELIGIBLE_MIXED].sort());

    const itemKeys = ['action', 'entity_type', 'entity_id', 'performed_by', 'actor_type', 'actor_id', 'privacy_category', 'risk_level', 'property_id', 'details'].sort();
    const note = `Closed in bulk: no email activity for over 90 days (batch ${batchId}), approved by Peter McKenzie on 2026-10-21.`;
    for (const r of items) {
      assert.deepStrictEqual(Object.keys(r).sort(), itemKeys);
      assert.strictEqual(r.entity_type, 'complaint');
      assert.strictEqual(r.actor_type, 'human');
      assert.strictEqual(r.actor_id, ACTOR.email);
      assert.strictEqual(r.performed_by, PERFORMED_BY);
      assert.strictEqual(r.property_id, uuid(7));
      assert.deepStrictEqual(r.details, { batch_id: batchId, older_than_days: 90, hold_back_urgent: true, hold_back_legal: false, from_status: 'open', to_status: 'resolved', reason: note });
    }
    const st = starts[0];
    assert.strictEqual(st.entity_type, bulk.BATCH_ENTITY_TYPE);
    assert.strictEqual(st.entity_id, batchId);
    assert.strictEqual(st.actor_type, 'human');
    assert.strictEqual(st.actor_id, ACTOR.email);
    assert.strictEqual(st.performed_by, PERFORMED_BY);
    assert.deepStrictEqual(st.details, {
      batch_id: batchId, older_than_days: 90, hold_back_urgent: true, hold_back_legal: false, open_in_scope: 22, eligible: 5, legal_tagged_in_eligible: 0,
      set_hash: bulk.setHash(ELIGIBLE_MIXED), skipped: EXPECTED_MIXED_PREVIEW.skipped, cap: 2000,
    }, 'the start row says what was asked and what was expected, including the set code that was approved: settings, counts and the code, nothing else');
    const b = batches[0];
    assert.strictEqual(b.entity_type, bulk.BATCH_ENTITY_TYPE);
    assert.strictEqual(b.entity_id, batchId);
    assert.strictEqual(b.actor_type, 'human');
    assert.strictEqual(b.actor_id, ACTOR.email);
    assert.deepStrictEqual(b.details, { batch_id: batchId, closed: 5, failed: 0, skipped_changed: 0, audit_failed: 0, older_than_days: 90, hold_back_urgent: true, hold_back_legal: false, cap: 2000 });
    for (const v of Object.values(b.details)) assert.ok(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean', 'counts only');
    for (const v of Object.values(st.details)) assert.ok(['string', 'number', 'boolean', 'object'].includes(typeof v));
    assert.ok(!JSON.stringify(rows).includes(MARKER), 'no complaint text may reach the audit log');
    assert.ok(!JSON.stringify(rows).includes('Handled earlier'));
  });

  asyncTest('bulk close — RECORD FIRST: the start row is saved before any complaint is touched', async () => {
    const w = mixedWorld();
    const db = w.db();
    await service(db).execute(mixedBody(), ACTOR);
    const firstComplaintWrite = db.state.writes.findIndex((x) => x.table === 'complaints');
    const startWrite = db.state.writes.findIndex((x) => x.table === 'audit_log' && x.rows.some((r) => r.action === bulk.ACTIONS.batchStarted));
    assert.ok(startWrite >= 0 && firstComplaintWrite >= 0);
    assert.ok(startWrite < firstComplaintWrite, 'the start row must come before the first change to a complaint');
    assert.strictEqual(startWrite, 0);
  });

  asyncTest('bulk close — if the start row cannot be saved NOTHING is changed: the answer is an error in plain words, no complaint is written, no end row, and a later close still works', async () => {
    const w = mixedWorld();
    let down = true;
    const db = w.db({ fail: (q) => (down && q.table === 'audit_log' && q.op === 'insert' ? { message: 'audit table unavailable: secret-detail-123' } : null) });
    const svc = service(db);
    const { value: res, logged } = await quiet(() => svc.execute(mixedBody(), ACTOR));
    assert.strictEqual(res.status, 500);
    assert.ok(/nothing was changed/i.test(res.body.error), res.body.error);
    assert.ok(!/secret-detail/.test(JSON.stringify(res.body)), 'the database\'s words never reach the person');
    assert.strictEqual(db.writesTo('complaints').length, 0, 'not one complaint was written');
    assert.strictEqual(db.tables.complaints.filter((c) => c.status === 'resolved' && c.resolution_note && c.resolution_note.startsWith('Closed in bulk')).length, 0);
    assert.strictEqual(db.tables.audit_log.filter((r) => r.action.startsWith('complaint_tracking.bulk')).length, 0, 'no bulk-close audit row exists');
    assert.ok(!logged.join('\n').includes('secret-detail-123'), 'and never reach the log');
    down = false;
    const again = await svc.execute(mixedBody(), ACTOR);
    assert.strictEqual(again.status, 200, 'the lock was released');
    assert.strictEqual(again.body.closed, 5);
  });

  asyncTest('bulk close — the start row is retried once (a blip is not fatal), and a start row refused twice stops the close', async () => {
    const w = mixedWorld();
    let inserts = 0;
    const db = w.db({ fail: (q) => { if (q.table === 'audit_log' && q.op === 'insert') { inserts += 1; if (inserts === 1) return { message: 'blip' }; } return null; } });
    const { value: res } = await quiet(() => service(db).execute(mixedBody(), ACTOR));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.audit_failed, 0);
    assert.strictEqual(db.tables.audit_log.filter((r) => r.action === bulk.ACTIONS.batchStarted).length, 1);
    let inserts2 = 0;
    const db2 = mixedWorld().db({ fail: (q) => { if (q.table === 'audit_log' && q.op === 'insert') { inserts2 += 1; if (inserts2 <= 2) return { message: 'blip' }; } return null; } });
    const { value: res2 } = await quiet(() => service(db2).execute(mixedBody(), ACTOR));
    assert.strictEqual(res2.status, 500);
    assert.strictEqual(db2.writesTo('complaints').length, 0);
  });

  asyncTest('bulk close — the end row is written even when nothing could be closed, so the batch shows what happened', async () => {
    const w = world();
    for (let n = 1; n <= 3; n += 1) w.add(n, 200);
    const db = w.db({ fail: (q) => (q.table === 'complaints' && q.op === 'update' ? { message: 'down' } : null) });
    const svc = service(db);
    const { value: res } = await quiet(() => svc.execute(closeBody(3), ACTOR));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.closed, 0);
    assert.strictEqual(res.body.failed, 3);
    const end = db.tables.audit_log.find((r) => r.action === bulk.ACTIONS.batchClosed);
    assert.deepStrictEqual([end.details.closed, end.details.failed], [0, 3]);
    const list = (await svc.listBatches()).body.batches;
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].state, 'finished');
    assert.strictEqual(list[0].closed, 0);
    assert.strictEqual(list[0].still_closed, 0);
  });

  asyncTest('bulk close — a user-lookup failure still gets audit rows (with no linked user); one blip on a group of rows is absorbed (the group is tried again row by row)', async () => {
    const w = world();
    for (let n = 1; n <= 3; n += 1) w.add(n, 200);
    const db = w.db();
    const res = await service(db, { lookupUserId: async () => { throw new Error('users table down'); } }).execute(closeBody(3), ACTOR);
    assert.strictEqual(res.body.closed, 3);
    assert.ok(db.writesTo('audit_log', 'insert').flatMap((x) => x.rows).every((r) => r.performed_by === null));

    const w2 = world();
    for (let n = 1; n <= 3; n += 1) w2.add(n, 200);
    let groupInserts = 0;
    const db2 = w2.db({ fail: (q) => { if (q.table === 'audit_log' && q.op === 'insert' && q.rows.length > 1) { groupInserts += 1; if (groupInserts === 1) return { message: 'blip' }; } return null; } });
    const { value: blip } = await quiet(() => service(db2).execute(closeBody(3), ACTOR));
    assert.strictEqual(blip.body.audit_failed, 0, 'one blip costs nothing');
    assert.strictEqual(db2.tables.audit_log.filter((r) => r.action === bulk.ACTIONS.itemClosed).length, 3);
  });

  asyncTest('bulk close — the audit log going down AFTER the start row: the items stay closed, audit_failed says exactly how many rows were not saved, the log is not hammered, and undo still works from the tag', async () => {
    const w = world();
    for (let n = 1; n <= 200; n += 1) w.add(n, 200);
    let seen = 0;
    const db = w.db({ fail: (q) => { if (q.table === 'audit_log' && q.op === 'insert') { seen += 1; if (seen > 1) return { message: 'audit down' }; } return null; } });
    const svc = service(db);
    const { value: down, logged } = await quiet(() => svc.execute(closeBody(200), ACTOR));
    assert.strictEqual(down.status, 200);
    assert.strictEqual(down.body.closed, 200);
    assert.strictEqual(down.body.audit_failed, 201, '200 item rows + the end row could not be written');
    assert.ok(seen < 40, `the audit table was asked ${seen} times; it must give up instead of trying all 200 rows over and over`);
    assert.ok(!logged.join('\n').includes('audit down'), 'the database\'s own words are not logged');
    assert.strictEqual(db.tables.audit_log.length, 1, 'only the start row exists');
    assert.strictEqual((await svc.undo(down.body.batch_id, ACTOR)).body.reopened, 200, 'undo works from the tag with no per-item rows');
  });

  // ====================================================================
  // 8b. When an 80-row audit insert is refused
  // ====================================================================

  asyncTest('bulk close — a database that refuses multi-row audit inserts (the hash-chain worry): every row is still saved, one at a time, and after two refusals it stops trying the big statements', async () => {
    const w = world();
    for (let n = 1; n <= 200; n += 1) w.add(n, 200);
    const db = w.db({ fail: (q) => (q.table === 'audit_log' && q.op === 'insert' && q.rows.length > 1 ? { message: 'multi-row inserts are not allowed here' } : null) });
    const { value: res } = await quiet(() => service(db).execute(closeBody(200), ACTOR));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.closed, 200);
    assert.strictEqual(res.body.audit_failed, 0, 'no row was lost');
    const itemRows = db.tables.audit_log.filter((r) => r.action === bulk.ACTIONS.itemClosed);
    assert.strictEqual(itemRows.length, 200);
    assert.strictEqual(new Set(itemRows.map((r) => r.entity_id)).size, 200, 'one row per item, none twice');
    assert.strictEqual(db.tables.audit_log.filter((r) => r.action === bulk.ACTIONS.batchStarted).length, 1);
    assert.strictEqual(db.tables.audit_log.filter((r) => r.action === bulk.ACTIONS.batchClosed).length, 1);
    const bigAttempts = db.state.calls.filter((c) => c.table === 'audit_log' && c.op === 'insert' && c.rows.length > 1).length;
    assert.strictEqual(bigAttempts, 2, 'two group statements were refused, then the rest went row by row');
  });

  asyncTest('bulk close — a database that refuses SOME single audit rows: those rows are counted in audit_failed (each tried twice), every other row is saved, and the close is not harmed', async () => {
    const w = world();
    for (let n = 1; n <= 100; n += 1) w.add(n, 200);
    const bad = new Set([uuid(1003), uuid(1050), uuid(1099)]);
    const db = w.db({ fail: (q) => (q.table === 'audit_log' && q.op === 'insert' && q.rows.some((r) => bad.has(r.entity_id)) ? { message: 'this row is refused' } : null) });
    const { value: res } = await quiet(() => service(db).execute(closeBody(100), ACTOR));
    assert.strictEqual(res.body.closed, 100);
    assert.strictEqual(res.body.audit_failed, 3);
    const saved = new Set(db.tables.audit_log.filter((r) => r.action === bulk.ACTIONS.itemClosed).map((r) => r.entity_id));
    assert.strictEqual(saved.size, 97);
    for (const id of bad) assert.ok(!saved.has(id));
    const attemptsOnBad = db.state.calls.filter((c) => c.table === 'audit_log' && c.op === 'insert' && c.rows.length === 1 && bad.has(c.rows[0].entity_id)).length;
    assert.strictEqual(attemptsOnBad, 6, 'each refused row was tried twice');
    const end = db.tables.audit_log.find((r) => r.action === bulk.ACTIONS.batchClosed);
    assert.strictEqual(end.details.audit_failed, 3);
  });

  asyncTest('bulk close — undo gets the same fall-back: its group of audit rows is tried row by row when the big statement is refused', async () => {
    const w = world();
    for (let n = 1; n <= 100; n += 1) w.add(n, 200);
    const db = w.db();
    const svc = service(db);
    const closed = await svc.execute(closeBody(100), ACTOR);
    const db2 = makeDb({ complaints: db.tables.complaints, audit: db.tables.audit_log, messages: db.tables.missive_message_intake }, {
      fail: (q) => (q.table === 'audit_log' && q.op === 'insert' && q.rows.length > 1 ? { message: 'no group inserts' } : null),
    }, { startMs: NOW + 3600 * 1000 });
    const { value: res } = await quiet(() => service(db2).undo(closed.body.batch_id, ACTOR));
    assert.strictEqual(res.body.reopened, 100);
    assert.strictEqual(res.body.audit_failed, undefined, 'no audit row lost');
    assert.strictEqual(db2.tables.audit_log.filter((r) => r.action === bulk.ACTIONS.itemReopened).length, 100);
  });

  // ====================================================================
  // 9. Undo
  // ====================================================================

  asyncTest('bulk close — undo reopens exactly the batch: status back to open, the note cleared, one audit row per item and one batch row; a different batch and other items stay as they were', async () => {
    const w = world();
    for (let n = 1; n <= 3; n += 1) w.add(n, 200);
    const db = w.db();
    const svc = service(db);
    const a = await svc.execute(closeBody(3), ACTOR);
    // a second group becomes eligible and is closed as batch B
    for (let n = 11; n <= 13; n += 1) {
      db.tables.complaints.push(complaint(n));
      db.tables.missive_message_intake.push({ missive_conversation_id: `conv-${n}`, delivered_at: iso(NOW - 250 * DAY) });
    }
    const b = await svc.execute(closeBody(3, { expected_hash: bulk.setHash([11, 12, 13].map((n) => uuid(1000 + n))) }), ACTOR);
    assert.notStrictEqual(a.body.batch_id, b.body.batch_id);
    // an unrelated resolved item with its own note
    db.tables.complaints.push(complaint(21, { status: 'resolved', resolution_note: 'Plumber fixed it' }));
    const writesBefore = db.state.writes.length;

    const res = await svc.undo(a.body.batch_id, ACTOR);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { batch_id: a.body.batch_id, reopened: 3, skipped_changed: 0 });
    for (let n = 1; n <= 3; n += 1) {
      const c = db.tables.complaints.find((x) => x.id === uuid(1000 + n));
      assert.strictEqual(c.status, 'open');
      assert.strictEqual(c.resolution_note, null);
    }
    for (let n = 11; n <= 13; n += 1) {
      const c = db.tables.complaints.find((x) => x.id === uuid(1000 + n));
      assert.strictEqual(c.status, 'resolved', 'the other batch must stay closed');
      assert.ok(c.resolution_note.includes(`(batch ${b.body.batch_id})`));
    }
    assert.strictEqual(db.tables.complaints.find((x) => x.id === uuid(1021)).resolution_note, 'Plumber fixed it');

    const newWrites = db.state.writes.slice(writesBefore);
    const upd = newWrites.filter((x) => x.table === 'complaints');
    assert.strictEqual(upd.length, 1);
    assert.deepStrictEqual(Object.keys(upd[0].patch).sort(), ['resolution_note', 'status']);
    assert.deepStrictEqual(upd[0].patch, { status: 'open', resolution_note: null });
    const auditRows = newWrites.filter((x) => x.table === 'audit_log').flatMap((x) => x.rows);
    const itemRows = auditRows.filter((r) => r.action === 'complaint_tracking.bulk_close_undone');
    assert.strictEqual(itemRows.length, 3);
    for (const r of itemRows) {
      assert.deepStrictEqual(r.details, { batch_id: a.body.batch_id, from_status: 'resolved', to_status: 'open' });
      assert.strictEqual(r.actor_type, 'human');
    }
    const summary = auditRows.filter((r) => r.action === 'complaint_tracking.bulk_close_batch_undone');
    assert.strictEqual(summary.length, 1);
    assert.strictEqual(summary[0].entity_type, bulk.BATCH_ENTITY_TYPE);
    assert.strictEqual(summary[0].entity_id, a.body.batch_id);
    assert.ok(isValidUuidText(summary[0].details.undo_id), 'the undo summary carries an id of its own, so a lost answer can be checked without confusing it with another undo');
    const { undo_id: undoId, ...summaryRest } = summary[0].details;
    assert.ok(undoId);
    assert.deepStrictEqual(summaryRest, { batch_id: a.body.batch_id, reopened: 3, skipped_changed: 0, failed: 0, audit_failed: 0 });
    assert.strictEqual(auditRows.length, 4);
    assert.strictEqual(db.state.deleteAttempts, 0);
    assert.ok(!JSON.stringify(auditRows).includes(MARKER));
  });

  asyncTest('bulk close — undo touches only items still resolved with this batch\'s tag, untouched since; anything worked, reopened, re-noted, merged or held since is left alone, and a second undo changes nothing', async () => {
    const w = world();
    for (let n = 1; n <= 6; n += 1) w.add(n, 200);
    const db = w.db();
    const svc = service(db);
    const closed = await svc.execute(closeBody(6), ACTOR);
    const batchId = closed.body.batch_id;
    const row = (n) => db.tables.complaints.find((c) => c.id === uuid(1000 + n));
    row(1).resolution_note = 'A person re-resolved this with their own note'; // tag gone
    row(2).status = 'open'; // reopened by a person (the old note stays on the row)
    row(3).status = 'in_progress';
    row(4).merged_into_id = uuid(1005); row(4).duplicate_status = 'confirmed_merged';
    // 5 and 6 untouched
    const snapshot = JSON.stringify(db.tables.complaints);

    const res = await svc.undo(batchId, ACTOR);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.reopened, 2);
    assert.strictEqual(res.body.skipped_changed, 4, 'items 2, 3 and 4 still carry the tag but were changed since, and item 1 had its note replaced by a person (no tag left): all four were left alone and all four are counted');
    assert.strictEqual(row(1).resolution_note, 'A person re-resolved this with their own note');
    assert.strictEqual(row(1).status, 'resolved');
    assert.strictEqual(row(2).status, 'open');
    assert.ok(row(2).resolution_note.includes(batchId), 'left exactly as the person left it');
    assert.strictEqual(row(3).status, 'in_progress');
    assert.strictEqual(row(4).status, 'resolved');
    assert.strictEqual(row(5).status, 'open');
    assert.strictEqual(row(5).resolution_note, null);
    assert.strictEqual(row(6).status, 'open');
    assert.notStrictEqual(JSON.stringify(db.tables.complaints), snapshot);

    // a second undo changes nothing at all
    const writes = db.state.writes.length;
    const again = await svc.undo(batchId, ACTOR);
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.reopened, 0);
    assert.strictEqual(db.state.writes.length, writes, 'a second undo must not write anything');
  });

  asyncTest('bulk close — undoing a batch twice when every item was reopened the first time: still a clean 200 (reopened 0), no writes; an unknown batch id is 404', async () => {
    const w = world();
    for (let n = 1; n <= 3; n += 1) w.add(n, 200);
    const db = w.db();
    const svc = service(db);
    const closed = await svc.execute(closeBody(3), ACTOR);
    assert.strictEqual((await svc.undo(closed.body.batch_id, ACTOR)).body.reopened, 3);
    const writes = db.state.writes.length;
    const second = await svc.undo(closed.body.batch_id, ACTOR);
    assert.deepStrictEqual(second, { status: 200, body: { batch_id: closed.body.batch_id, reopened: 0, skipped_changed: 0 } });
    assert.strictEqual(db.state.writes.length, writes);
    assert.strictEqual((await svc.undo(uuid(123456), ACTOR)).status, 404);
    // the upper-case spelling of a real batch id (one with hex letters in it) is the same batch
    const w2 = world(); w2.add(1, 200);
    const db2 = w2.db();
    const lettered = 'abcdef01-2345-4678-9abc-def012345678';
    const svc2 = service(db2, { randomUUID: () => lettered });
    const c2 = await svc2.execute(closeBody(1), ACTOR);
    assert.strictEqual(c2.body.batch_id, lettered);
    assert.strictEqual((await svc2.undo(lettered.toUpperCase(), ACTOR)).body.reopened, 1);
  });

  asyncTest('bulk close — items changed between undo\'s read and its write (reopened, re-noted, merged, held by someone else in that moment) are left alone and counted as skipped_changed', async () => {
    const w = world();
    for (let n = 1; n <= 8; n += 1) w.add(n, 200);
    let armed = false;
    let fired = false;
    const db = w.db({
      before: (q, state) => {
        if (!armed || fired || q.table !== 'complaints' || q.op !== 'update') return;
        fired = true;
        const row = (n) => state.tables.complaints.find((c) => c.id === uuid(1000 + n));
        row(1).status = 'in_progress'; // a person picked it up (note still has the tag)
        row(2).resolution_note = 'A person wrote their own resolution'; // tag gone, still resolved
        row(3).merged_into_id = uuid(1008); row(3).duplicate_status = 'confirmed_merged';
        row(4).held_legal_fair_housing = true;
      },
    });
    const svc = service(db);
    const closed = await svc.execute(closeBody(8), ACTOR);
    armed = true;
    const res = await svc.undo(closed.body.batch_id, ACTOR);
    assert.strictEqual(fired, true, 'the race was staged');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.reopened, 4);
    assert.strictEqual(res.body.skipped_changed, 4);
    const row = (n) => db.tables.complaints.find((c) => c.id === uuid(1000 + n));
    assert.strictEqual(row(1).status, 'in_progress');
    assert.ok(row(1).resolution_note.includes(closed.body.batch_id));
    assert.strictEqual(row(2).status, 'resolved');
    assert.strictEqual(row(2).resolution_note, 'A person wrote their own resolution');
    assert.strictEqual(row(3).status, 'resolved');
    assert.strictEqual(row(4).status, 'resolved');
    for (const n of [5, 6, 7, 8]) { assert.strictEqual(row(n).status, 'open'); assert.strictEqual(row(n).resolution_note, null); }
    const undone = db.writesTo('audit_log', 'insert').flatMap((x) => x.rows).filter((r) => r.action === bulk.ACTIONS.itemReopened).map((r) => r.entity_id).sort();
    assert.deepStrictEqual(undone, [5, 6, 7, 8].map((n) => uuid(1000 + n)), 'audit rows only for the items that were really reopened');
  });

  asyncTest('bulk close — undo with a bad batch id (odd characters, SQL-looking text, wildcards, wrong shape) is refused with 400 before any database access; a good id only ever searches for its own tag', async () => {
    const bad = [
      "x' OR '1'='1", "'; DROP TABLE complaints; --", '%', '%25', '_', '*', '../../etc/passwd', '<script>alert(1)</script>',
      'null', 'undefined', 'all', '', ' ', uuid(1) + '%', uuid(1) + "' --", uuid(1) + '\n', ' ' + uuid(1), uuid(1).slice(0, -1), uuid(1) + '0',
      '00000000-0000-4000-8000-00000000000g', '{' + uuid(1) + '}', null, undefined, 123, [uuid(1)], { id: uuid(1) },
    ];
    const db = mixedWorld().db();
    const svc = service(db);
    for (const id of bad) {
      const res = await svc.undo(id, ACTOR);
      assert.strictEqual(res.status, 400, JSON.stringify(id));
    }
    assert.strictEqual(db.state.calls.length, 0, 'refused before touching the database');

    const good = uuid(777);
    await svc.undo(good, ACTOR);
    const likes = db.state.calls.flatMap((c) => c.filters).filter((f) => f.kind === 'like');
    assert.ok(likes.length >= 1);
    for (const f of likes) assert.strictEqual(f.val, bulk.batchLikePattern(good));
    assert.strictEqual(bulk.batchLikePattern(good), `Closed in bulk: no email activity for over % days (batch ${good}), approved by %`);
  });

  asyncTest('bulk close — undo still works for items closed by a batch whose summary audit row is missing (found by the tag alone)', async () => {
    const w = world();
    for (let n = 1; n <= 3; n += 1) w.add(n, 200);
    const db = w.db();
    const svc = service(db);
    const closed = await svc.execute(closeBody(3), ACTOR);
    db.tables.audit_log = db.tables.audit_log.filter((r) => r.action !== bulk.ACTIONS.batchClosed && r.action !== bulk.ACTIONS.batchStarted);
    const res = await svc.undo(closed.body.batch_id, ACTOR);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.reopened, 3);
    assert.strictEqual(res.body.skipped_changed, 0, 'with no end row the number replaced cannot be told, and none is claimed');
  });

  asyncTest('bulk close — a failed undo group is fail-soft and reported (failed), the other groups reopen', async () => {
    const w = world();
    for (let n = 1; n <= 200; n += 1) w.add(n, 200);
    const db0 = w.db();
    const closed = await service(db0).execute(closeBody(200), ACTOR);
    // carry the closed state into a fresh database whose first update fails
    let updates = 0;
    const db = makeDb({ complaints: db0.tables.complaints, audit: db0.tables.audit_log, messages: db0.tables.missive_message_intake }, {
      fail: (q) => { if (q.table === 'complaints' && q.op === 'update') { updates += 1; if (updates === 1) return { message: 'simulated outage' }; } return null; },
    }, { startMs: NOW + 3600 * 1000 });
    const svc2 = service(db);
    const { value: res } = await quiet(() => svc2.undo(closed.body.batch_id, ACTOR));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.failed, 80);
    assert.strictEqual(res.body.reopened, 120);
    assert.strictEqual(db.tables.complaints.filter((c) => c.status === 'open').length, 120);
  });

  // ====================================================================
  // 10. Recent batches
  // ====================================================================

  const waitFor = async (cond, ms = 3000) => {
    const started = Date.now();
    while (!cond()) {
      if (Date.now() - started > ms) throw new Error('waitFor: timed out');
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const startRow = (w, i, { actor = ACTOR.email, details = {} } = {}) => {
    w.seq += 1;
    w.audit.push({
      id: uuid(8100 + i), action: bulk.ACTIONS.batchStarted, entity_type: bulk.BATCH_ENTITY_TYPE, entity_id: uuid(7000 + i),
      performed_by: null, actor_type: 'human', actor_id: actor, privacy_category: 'processing', risk_level: 'medium', property_id: null,
      details: { batch_id: uuid(7000 + i), older_than_days: 90, hold_back_urgent: i % 2 === 0, hold_back_legal: i % 3 === 0, eligible: 10 + i, ...details },
      created_at: iso(NOW - i * 3600 * 1000), sequence_num: w.seq,
    });
  };
  const endRow = (w, i, closed) => {
    w.seq += 1;
    w.audit.push({
      id: uuid(8300 + i), action: bulk.ACTIONS.batchClosed, entity_type: bulk.BATCH_ENTITY_TYPE, entity_id: uuid(7000 + i),
      performed_by: null, actor_type: 'human', actor_id: ACTOR.email, privacy_category: 'processing', risk_level: 'medium', property_id: null,
      details: { batch_id: uuid(7000 + i), closed, failed: 0, skipped_changed: 0, audit_failed: 0, older_than_days: 90, hold_back_urgent: true, cap: 2000 },
      created_at: iso(NOW - i * 3600 * 1000 + 60000), sequence_num: w.seq,
    });
  };
  const taggedNote = (batch, over = '2026-10-20') => `Closed in bulk: no email activity for over 90 days (batch ${uuid(7000 + batch)}), approved by Peter McKenzie on ${over}.`;

  asyncTest('bulk close — recent batches: built from the START rows, newest first, only the last 20; names resolved; the closed count comes from the end row (or the live count when there is none); state says finished or unfinished', async () => {
    const w = world();
    w.members.push({ id: uuid(300), full_name: 'Peter McKenzie', email: ACTOR.email, is_active: true, auth_user_id: 'u1' });
    for (let i = 0; i < 25; i += 1) {
      startRow(w, i, { actor: i === 1 ? 'Someone.Else@rincon.test' : ACTOR.email });
      if (i % 2 === 0) endRow(w, i, 10 + i); // odd batches have no end row
    }
    // rows that must not be listed: a per-item row, an undo summary, an end row whose start row is missing
    w.seq += 1;
    w.audit.push({ id: uuid(8200), action: bulk.ACTIONS.itemClosed, entity_type: 'complaint', entity_id: uuid(1001), performed_by: null, actor_type: 'human', actor_id: ACTOR.email, privacy_category: 'processing', risk_level: 'low', property_id: null, details: {}, created_at: iso(NOW + 1000), sequence_num: w.seq });
    w.seq += 1;
    w.audit.push({ id: uuid(8201), action: bulk.ACTIONS.batchUndone, entity_type: bulk.BATCH_ENTITY_TYPE, entity_id: uuid(7000), performed_by: null, actor_type: 'human', actor_id: ACTOR.email, privacy_category: 'processing', risk_level: 'medium', property_id: null, details: {}, created_at: iso(NOW + 2000), sequence_num: w.seq });
    endRow(w, 90, 77);
    // batch 0 still has 3 closed items; batch 1 (no end row) has 2; batch 2 has one item a person reopened (status open, tag kept)
    for (let k = 0; k < 3; k += 1) w.add(40 + k, 200, { status: 'resolved', resolution_note: taggedNote(0) });
    for (let k = 0; k < 2; k += 1) w.add(45 + k, 200, { status: 'resolved', resolution_note: taggedNote(1) });
    w.add(50, 200, { status: 'open', resolution_note: taggedNote(2) });
    const res = await service(w.db()).listBatches();
    assert.strictEqual(res.status, 200);
    const list = res.body.batches;
    assert.strictEqual(list.length, 20);
    assert.deepStrictEqual(list.map((x) => x.batch_id), Array.from({ length: 20 }, (_, i) => uuid(7000 + i)), 'newest first');
    assert.deepStrictEqual(Object.keys(list[0]).sort(), ['batch_id', 'closed', 'closed_at', 'closed_by_name', 'hold_back_legal', 'hold_back_urgent', 'older_than_days', 'state', 'still_closed']);
    assert.strictEqual(list[0].closed, 10, 'from the end row');
    assert.strictEqual(list[0].state, 'finished');
    assert.strictEqual(list[0].closed_by_name, 'Peter McKenzie');
    assert.strictEqual(list[0].older_than_days, 90);
    assert.strictEqual(list[0].hold_back_urgent, true);
    assert.strictEqual(list[0].hold_back_legal, true);
    assert.strictEqual(list[1].hold_back_urgent, false);
    assert.strictEqual(list[1].hold_back_legal, false);
    assert.strictEqual(list[1].closed_by_name, 'Someone.Else@rincon.test', 'no matching team member: the email is shown');
    assert.strictEqual(list[1].state, 'unfinished', 'no end row');
    assert.strictEqual(list[1].closed, 2, 'no end row: the live count of items still closed');
    assert.strictEqual(list[1].still_closed, 2);
    assert.strictEqual(list[0].closed_at, iso(NOW));
    assert.strictEqual(list[0].still_closed, 3);
    assert.strictEqual(list[2].still_closed, 0, 'a reopened item no longer counts as closed');
    assert.strictEqual(list[2].closed, 12, 'the end row says 12 were closed, even though none is closed now');
    assert.strictEqual(list[3].still_closed, 0);
    assert.strictEqual(list[3].closed, 0);
    assert.ok(!list.some((x) => x.batch_id === uuid(7090)), 'an end row with no start row is not a batch');
  });

  asyncTest('bulk close — a batch that stopped halfway (the process died after the first group) is still listed, shown as unfinished with the right number still closed, and its Undo works', async () => {
    const w = world();
    for (let n = 1; n <= 200; n += 1) w.add(n, 200);
    let updates = 0;
    const db = w.db({ fail: (q) => { if (q.table === 'complaints' && q.op === 'update') { updates += 1; if (updates === 2) return { hang: true }; } return null; } });
    const svc = service(db);
    svc.execute(closeBody(200), ACTOR).catch(() => {}); // never answers: the "process" is gone
    await waitFor(() => updates >= 2);
    assert.strictEqual(db.tables.complaints.filter((c) => c.status === 'resolved').length, 80);
    assert.strictEqual(db.tables.audit_log.filter((r) => r.action === bulk.ACTIONS.itemClosed).length, 80, 'the first group was recorded as it was closed');
    assert.strictEqual(db.tables.audit_log.filter((r) => r.action === bulk.ACTIONS.batchStarted).length, 1);
    assert.strictEqual(db.tables.audit_log.filter((r) => r.action === bulk.ACTIONS.batchClosed).length, 0, 'there is no end row');

    // while it is "running", the same service says so
    const live = (await svc.listBatches()).body.batches;
    assert.strictEqual(live[0].state, 'running');

    // after a restart (a fresh service over the same database)
    const svc2 = service(db);
    const list = (await svc2.listBatches()).body.batches;
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].state, 'unfinished');
    assert.strictEqual(list[0].still_closed, 80);
    assert.strictEqual(list[0].closed, 80);
    assert.strictEqual(list[0].older_than_days, 90);
    const undone = await svc2.undo(list[0].batch_id, ACTOR);
    assert.strictEqual(undone.status, 200);
    assert.strictEqual(undone.body.reopened, 80);
    assert.strictEqual(db.tables.complaints.filter((c) => c.status === 'resolved').length, 0);
    assert.strictEqual((await svc2.listBatches()).body.batches[0].still_closed, 0);
  });

  asyncTest('bulk close — recent batches: still_closed falls to 0 after an undo; an empty history is an empty list; still_closed is null (not 0) when the count could not be made', async () => {
    const w = world();
    for (let n = 1; n <= 4; n += 1) w.add(n, 200);
    const db = w.db();
    const svc = service(db);
    assert.deepStrictEqual((await svc.listBatches()).body, { batches: [] });
    const closed = await svc.execute(closeBody(4), ACTOR);
    const first = (await svc.listBatches()).body.batches;
    assert.strictEqual(first.length, 1);
    assert.strictEqual(first[0].batch_id, closed.body.batch_id);
    assert.strictEqual(first[0].closed, 4);
    assert.strictEqual(first[0].still_closed, 4);
    assert.strictEqual(first[0].state, 'finished');
    assert.strictEqual(first[0].hold_back_legal, false);
    await svc.undo(closed.body.batch_id, ACTOR);
    assert.strictEqual((await svc.listBatches()).body.batches[0].still_closed, 0);
    assert.strictEqual(db.writesTo('complaints', 'insert').length, 0, 'nothing is ever created in the complaints table');

    // the live count fails: "unknown", never a made-up zero
    const broken = makeDb({ complaints: db.tables.complaints, audit: db.tables.audit_log }, { fail: (q) => (q.table === 'complaints' && q.head ? { message: 'count failed' } : null) }, { startMs: NOW + 7200 * 1000 });
    const { value: unknown } = await quiet(() => service(broken).listBatches());
    assert.strictEqual(unknown.body.batches[0].still_closed, null);
    assert.strictEqual(unknown.body.batches[0].closed, 4, 'the end row still says how many were closed');
    assert.strictEqual(unknown.body.batches[0].state, 'finished');

    // the end rows cannot be read: the state is "unknown" (neither finished nor unfinished is claimed); the rest of the list is still given
    const noEndRows = makeDb({ complaints: db.tables.complaints, audit: db.tables.audit_log }, { fail: (q) => (q.table === 'audit_log' && q.cols === 'entity_id, details' ? { message: 'x' } : null) }, { startMs: NOW + 7200 * 1000 });
    const { value: partial } = await quiet(() => service(noEndRows).listBatches());
    assert.strictEqual(partial.status, 200);
    assert.strictEqual(partial.body.batches[0].state, 'unknown');
    assert.strictEqual(partial.body.batches[0].still_closed, 0);
    assert.strictEqual(partial.body.batches[0].closed, 0, 'with no end row to read, the live count is used');
    const threw = makeDb({ complaints: db.tables.complaints, audit: db.tables.audit_log }, { before: (q) => { if (q.table === 'audit_log' && q.cols === 'entity_id, details') throw new Error('socket hang up'); } }, { startMs: NOW + 7200 * 1000 });
    assert.strictEqual((await quiet(() => service(threw).listBatches())).value.body.batches[0].state, 'unknown');
  });

  asyncTest('bulk close — recent batches: the live counts run a few at a time (never 20 at once), the lists sent to the database stay short, and odd-looking addresses never reach the name lookup', async () => {
    const w = world();
    w.members.push({ id: uuid(300), full_name: 'Peter McKenzie', email: ACTOR.email, is_active: true, auth_user_id: 'u1' });
    const odd = ['a,b@rincon.test', 'o"brien@rincon.test', 'evil)@rincon.test', "x'y@rincon.test", 'has space@rincon.test', 'back\\slash@rincon.test'];
    for (let i = 0; i < 20; i += 1) { startRow(w, i, { actor: i < odd.length ? odd[i] : ACTOR.email }); endRow(w, i, 1); }
    let active = 0;
    let maxActive = 0;
    const db = w.db({
      delay: (q) => { if (q.table === 'complaints' && q.head) { active += 1; maxActive = Math.max(maxActive, active); return 15; } return 0; },
      fail: (q) => { if (q.table === 'complaints' && q.head) active -= 1; return null; },
    });
    const res = await service(db).listBatches();
    assert.strictEqual(res.body.batches.length, 20);
    assert.ok(maxActive >= 2 && maxActive <= bulk.BATCH_LIST_CONCURRENCY, `at most ${bulk.BATCH_LIST_CONCURRENCY} counts at once (saw ${maxActive})`);
    assert.strictEqual(bulk.BATCH_LIST_CONCURRENCY, 3);
    for (const call of db.state.calls) for (const f of call.filters) if (f.kind === 'in') assert.ok(f.val.length <= 20, 'no id list longer than the 20 batches');
    const nameCalls = db.state.calls.filter((c) => c.table === 'team_members');
    assert.strictEqual(nameCalls.length, 1);
    assert.deepStrictEqual(nameCalls[0].filters.find((f) => f.kind === 'in').val, [ACTOR.email], 'only plain-looking addresses are looked up');
    assert.strictEqual(res.body.batches[0].closed_by_name, 'a,b@rincon.test', 'the odd address is still shown as text');
    assert.strictEqual(res.body.batches[10].closed_by_name, 'Peter McKenzie');
    // none of the count queries starts with a wildcard (the note is matched from its fixed beginning)
    for (const call of db.state.calls) for (const f of call.filters) if (f.kind === 'like') assert.ok(!f.val.startsWith('%'));
  });

  // ====================================================================
  // 11. Speed with a big list
  // ====================================================================

  asyncTest('bulk close — 3,000 complaints: the preview and a 1,900-item close finish quickly with a handful of requests (no per-item queries)', async () => {
    const make = (eligibleCount) => {
      const w = world();
      let n = 0;
      for (let i = 0; i < eligibleCount; i += 1) w.add(n += 1, 200 + (i % 700));
      for (let i = 0; i < 400; i += 1) w.add(n += 1, 10 + (i % 60)); // recent
      for (let i = 0; i < 300; i += 1) w.add(n += 1, 300, { flagged_protected_class: true, flagged_category: 'race' });
      for (let i = 0; i < 200; i += 1) w.add(n += 1, 300, { severity_tier: 'urgent' });
      for (let i = 0; i < 100; i += 1) w.add(n += 1, null, { source: 'manual_staff', needs_human_call: true, source_missive_conversation_id: null });
      while (n < 3000) w.add(n += 1, 300, { severity_tier: 'just_a_record', escalation_signal: null });
      return w;
    };
    const db = make(1900).db();
    const svc = service(db);
    assert.strictEqual(db.tables.complaints.length, 3000);
    let started = Date.now();
    const preview = (await svc.preview({})).body;
    const previewMs = Date.now() - started;
    assert.strictEqual(preview.eligible, 1900);
    assert.strictEqual(preview.open_in_scope, 2900);
    assert.ok(previewMs < 4000, `preview took ${previewMs} ms`);
    const readCalls = db.state.calls.length;
    assert.ok(readCalls < 150, `preview used ${readCalls} requests`);

    started = Date.now();
    const closed = await svc.execute(closeBody(1900), ACTOR);
    const closeMs = Date.now() - started;
    assert.strictEqual(closed.body.closed, 1900);
    assert.ok(closeMs < 8000, `close took ${closeMs} ms`);
    const totalCalls = db.state.calls.length;
    assert.ok(totalCalls < 320, `preview + close used ${totalCalls} requests`);
    assert.strictEqual(db.writesTo('complaints', 'update').length, 24, '1,900 items in groups of 80');
    assert.strictEqual(db.writesTo('audit_log', 'insert').length, 26, 'the start row + 24 groups of audit rows + the end row');
    assert.strictEqual(db.tables.complaints.filter((c) => c.status === 'resolved').length, 1900);

    // over the cap with 2,100: refused cleanly, quickly
    const dbOver = make(2100).db();
    started = Date.now();
    const refused = await service(dbOver).execute(closeBody(2100), ACTOR);
    assert.strictEqual(refused.status, 422);
    assert.ok(Date.now() - started < 4000);
    assert.strictEqual(dbOver.state.writes.length, 0);
  });

  // ====================================================================
  // 12. The routes: access, input, same-origin, shapes
  // ====================================================================

  asyncTest('bulk close routes — all four refuse (403) anyone without an allowed role, before any database access', async () => {
    const roles = [null, undefined, '', 'viewer', 'member', 'owner', 'tenant', 'ADMIN', 'Admin', ' admin', 'admin ', 'director', 'director_of_operations ', 'true', 'none'];
    const db = mixedWorld(Date.now()).db();
    await withRouter(db.client, async (mod) => {
      for (const role of roles) {
        for (const [key, [method, routePath]] of Object.entries(ROUTES)) {
          const req = reqOf({
            role,
            body: key === 'close' ? closeBody(5) : undefined,
            query: key === 'preview' ? { older_than_days: '90' } : {},
            params: key === 'undo' ? { batch_id: uuid(1) } : {},
          });
          const out = await runRoute(mod, method, routePath, req);
          assert.strictEqual(out.status, 403, `${key} for role ${JSON.stringify(role)}`);
          assert.ok(out.body && out.body.error);
        }
      }
      assert.strictEqual(db.state.calls.length, 0, 'no database access for a refused request');
      assert.strictEqual(db.state.writes.length, 0);
    });
  });

  asyncTest('bulk close routes — the two allowed roles (admin, director_of_operations) get through on every route', async () => {
    const w = mixedWorld(Date.now());
    w.users.push({ id: PERFORMED_BY, email: ACTOR.email, alt_email: null });
    const db = w.db();
    await withRouter(db.client, async (mod) => {
      for (const role of ['admin', 'director_of_operations']) {
        const pre = await runRoute(mod, ...ROUTES.preview, reqOf({ role, email: `${role}@rincon.test`, query: { older_than_days: '90' } }));
        assert.strictEqual(pre.status, 200);
        assert.strictEqual((await runRoute(mod, ...ROUTES.batches, reqOf({ role }))).status, 200);
        assert.strictEqual((await runRoute(mod, ...ROUTES.undo, reqOf({ role, params: { batch_id: uuid(1) } }))).status, 404);
        assert.strictEqual((await runRoute(mod, ...ROUTES.close, reqOf({ role, body: closeBody(999) }))).status, 409);
      }
    });
  });

  asyncTest('bulk close routes — the two POST routes refuse a browser request from another site (403) and accept same-origin, no header, and "none"', async () => {
    const w = mixedWorld(Date.now());
    w.users.push({ id: PERFORMED_BY, email: ACTOR.email, alt_email: null });
    const db = w.db();
    await withRouter(db.client, async (mod) => {
      for (const site of ['cross-site', 'same-site', 'bogus', 'CROSS-SITE']) {
        const closeOut = await runRoute(mod, ...ROUTES.close, reqOf({ body: closeBody(5), headers: { 'Sec-Fetch-Site': site } }));
        assert.strictEqual(closeOut.status, 403, `close with Sec-Fetch-Site ${site}`);
        const undoOut = await runRoute(mod, ...ROUTES.undo, reqOf({ params: { batch_id: uuid(1) }, headers: { 'Sec-Fetch-Site': site } }));
        assert.strictEqual(undoOut.status, 403, `undo with Sec-Fetch-Site ${site}`);
      }
      assert.strictEqual(db.state.calls.length, 0);
      for (const headers of [{ 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Site': 'none' }, {}]) {
        const out = await runRoute(mod, ...ROUTES.close, reqOf({ body: closeBody(999), headers }));
        assert.strictEqual(out.status, 409, JSON.stringify(headers));
      }
    });
  });

  asyncTest('bulk close routes — bad input is a 400 before any database access, on the address (preview) and in the body (close), and a bad batch id on undo', async () => {
    const db = mixedWorld(Date.now()).db();
    await withRouter(db.client, async (mod) => {
      const badQueries = [
        { older_than_days: '29' }, { older_than_days: '3651' }, { older_than_days: 'abc' }, { older_than_days: '-5' }, { older_than_days: '9.5' }, { older_than_days: '' },
        { older_than_days: 'NaN' }, { older_than_days: '99999999999' }, { older_than_days: ['90', '91'] }, { older_than_days: { x: 1 } },
        { hold_back_urgent: 'yes' }, { hold_back_urgent: '1' }, { hold_back_urgent: 'TRUE' }, { hold_back_urgent: ['true', 'false'] },
        { hold_back_legal: 'yes' }, { hold_back_legal: '1' }, { hold_back_legal: 'TRUE' }, { hold_back_legal: ['true', 'false'] }, { hold_back_legal: '' },
      ];
      for (const query of badQueries) {
        const out = await runRoute(mod, ...ROUTES.preview, reqOf({ query }));
        assert.strictEqual(out.status, 400, JSON.stringify(query));
      }
      const badBodies = [
        closeBody(5, { older_than_days: '90' }), closeBody(5, { older_than_days: -1 }), closeBody(5, { older_than_days: Number.NaN }), closeBody(5, { older_than_days: 1e9 }),
        closeBody(5, { hold_back_urgent: 'true' }), closeBody(5, { hold_back_urgent: 1 }), closeBody(0), closeBody('5'), closeBody(undefined), {}, undefined,
        closeBody(5, { hold_back_legal: 'false' }), closeBody(5, { hold_back_legal: 0 }), closeBody(5, { expected_hash: 'nope' }), closeBody(5, { expected_hash: undefined }),
      ];
      for (const body of badBodies) {
        const out = await runRoute(mod, ...ROUTES.close, reqOf({ body }));
        assert.strictEqual(out.status, 400, JSON.stringify(body));
      }
      for (const id of ["x' OR '1'='1", '%', '../..', uuid(1) + '%', 'null', 'abc']) {
        const out = await runRoute(mod, ...ROUTES.undo, reqOf({ params: { batch_id: id } }));
        assert.strictEqual(out.status, 400, id);
      }
      assert.strictEqual(db.state.calls.length, 0);
    });
  });

  asyncTest('bulk close routes — the answers have exactly the agreed shapes: preview, close, batches, undo (full round trip through the real router)', async () => {
    const w = mixedWorld(Date.now());
    w.users.push({ id: PERFORMED_BY, email: ACTOR.email, alt_email: null });
    w.members.push({ id: uuid(300), full_name: 'Peter McKenzie', email: ACTOR.email, is_active: true, auth_user_id: 'user-1' });
    const db = w.db(null, { startMs: Date.now() });
    await withRouter(db.client, async (mod) => {
      const pre = await runRoute(mod, ...ROUTES.preview, reqOf({ query: { older_than_days: '90', hold_back_urgent: 'true' } }));
      assert.strictEqual(pre.status, 200);
      assert.deepStrictEqual(Object.keys(pre.body).sort(), ['cap', 'eligible', 'eligible_by_year', 'hold_back_legal', 'hold_back_urgent', 'legal_tagged_in_eligible', 'lookup_incomplete', 'older_than_days', 'open_in_scope', 'over_cap', 'set_hash', 'skipped']);
      assert.deepStrictEqual(Object.keys(pre.body.skipped).sort(), ['duplicate_pending', 'fair_housing_flagged', 'kept_has_note', 'manual_report', 'not_open_or_other', 'recent', 'recently_worked_or_delegated', 'urgent_held_back']);
      assert.ok(/^[0-9a-f]{64}$/.test(pre.body.set_hash));
      const preLegal = await runRoute(mod, ...ROUTES.preview, reqOf({ email: 'someone.else@rincon.test', query: { older_than_days: '90', hold_back_legal: 'true' } }));
      assert.strictEqual(preLegal.body.hold_back_legal, true);
      assert.ok('legal_held_back' in preLegal.body.skipped, 'the legal line appears only when that box is ticked');
      assert.strictEqual(pre.body.eligible, 5);
      assert.strictEqual(pre.body.cap, 2000);

      const stale = await runRoute(mod, ...ROUTES.close, reqOf({ body: closeBody(4) }));
      assert.strictEqual(stale.status, 409);
      assert.strictEqual(stale.body.eligible, 5);
      assert.ok(stale.body.error);

      const closed = await runRoute(mod, ...ROUTES.close, reqOf({ body: closeBody(pre.body.eligible, { expected_hash: pre.body.set_hash }) }));
      assert.strictEqual(closed.status, 200);
      assert.deepStrictEqual(Object.keys(closed.body).sort(), ['audit_failed', 'batch_id', 'closed', 'failed', 'hold_back_legal', 'hold_back_urgent', 'older_than_days', 'skipped_changed']);
      assert.strictEqual(closed.body.closed, 5);
      const noteSample = db.tables.complaints.find((c) => c.id === ELIGIBLE_MIXED[0]).resolution_note;
      assert.ok(noteSample.endsWith('approved by Peter McKenzie on ' + noteSample.slice(-11, -1) + '.'));
      assert.ok(noteSample.includes(`(batch ${closed.body.batch_id})`));
      assert.strictEqual(db.writesTo('audit_log', 'insert').flatMap((x) => x.rows)[0].performed_by, PERFORMED_BY, 'the router passes its user lookup through');

      const list = await runRoute(mod, ...ROUTES.batches, reqOf());
      assert.strictEqual(list.status, 200);
      assert.strictEqual(list.body.batches.length, 1);
      assert.deepStrictEqual(Object.keys(list.body.batches[0]).sort(), ['batch_id', 'closed', 'closed_at', 'closed_by_name', 'hold_back_legal', 'hold_back_urgent', 'older_than_days', 'state', 'still_closed']);
      assert.strictEqual(list.body.batches[0].closed_by_name, 'Peter McKenzie');
      assert.strictEqual(list.body.batches[0].still_closed, 5);
      assert.strictEqual(list.body.batches[0].state, 'finished');

      const undone = await runRoute(mod, ...ROUTES.undo, reqOf({ params: { batch_id: closed.body.batch_id } }));
      assert.strictEqual(undone.status, 200);
      assert.deepStrictEqual(undone.body, { batch_id: closed.body.batch_id, reopened: 5, skipped_changed: 0 });
      assert.strictEqual((await runRoute(mod, ...ROUTES.batches, reqOf())).body.batches[0].still_closed, 0);
    });
  });

  asyncTest('bulk close routes — a database failure is a plain 500 that names no data and leaves the lock free', async () => {
    const w = mixedWorld(Date.now());
    let failures = 2;
    const db = w.db({ fail: (q) => { if (failures > 0 && q.table === 'complaints') { failures -= 1; return { message: 'password authentication failed for user "postgres" at 10.0.0.5' }; } return null; } });
    await withRouter(db.client, async (mod) => {
      const { value: out } = await quiet(() => runRoute(mod, ...ROUTES.preview, reqOf({ query: {} })));
      assert.strictEqual(out.status, 500);
      assert.ok(!/postgres|10\.0\.0\.5|password/i.test(out.body.error), 'the database\'s own message must not be shown');
      const { value: out2 } = await quiet(() => runRoute(mod, ...ROUTES.close, reqOf({ body: closeBody(5) })));
      assert.strictEqual(out2.status, 500);
      assert.ok(!/postgres|10\.0\.0\.5|password/i.test(out2.body.error));
      const ok = await runRoute(mod, ...ROUTES.preview, reqOf({ email: 'third.person@rincon.test', query: {} }));
      assert.strictEqual(ok.status, 200);
    });
  });

  asyncTest('bulk close routes — over real HTTP: login-less visitors and the wrong role are refused, the right role can preview, close, list and undo, and the JSON body is read as sent', async () => {
    const express = require('express');
    const w = mixedWorld(Date.now());
    w.users.push({ id: PERFORMED_BY, email: ACTOR.email, alt_email: null });
    w.members.push({ id: uuid(300), full_name: 'Peter McKenzie', email: ACTOR.email, is_active: true, auth_user_id: 'user-1' });
    w.members.push({ id: uuid(301), full_name: 'Viewer Person', email: 'viewer@rincon.test', is_active: true, auth_user_id: 'user-2' });
    w.roles.push({ team_member_id: uuid(300), tool: 'complaint_tracking', role: 'admin' });
    w.roles.push({ team_member_id: uuid(301), tool: 'complaint_tracking', role: 'viewer' });
    const db = w.db(null, { startMs: Date.now() });
    await withRouter(db.client, async (mod) => {
      const app = express();
      app.use(express.json());
      app.use((req, res, next) => {
        const who = req.headers['x-test-user'];
        if (who === 'peter') req.user = { id: 'user-1', email: ACTOR.email };
        else if (who === 'viewer') req.user = { id: 'user-2', email: 'viewer@rincon.test' };
        else return res.status(401).json({ error: 'login required' });
        next();
      });
      app.use(mod.router);
      const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
      try {
        const port = server.address().port;
        const peter = { 'x-test-user': 'peter' };
        const viewer = { 'x-test-user': 'viewer' };
        const base = '/api/complaint-tracking/bulk-close';

        assert.strictEqual((await httpJson(port, 'GET', `${base}/preview`, undefined, {})).status, 401);
        for (const [method, p, body] of [['GET', `${base}/preview`, undefined], ['GET', `${base}/batches`, undefined], ['POST', base, mixedBody()], ['POST', `${base}/${uuid(1)}/undo`, {}]]) {
          const refused = await httpJson(port, method, p, body, viewer);
          assert.strictEqual(refused.status, 403, `${method} ${p}`);
        }
        assert.strictEqual(db.state.writes.length, 0);

        const pre = await httpJson(port, 'GET', `${base}/preview?older_than_days=90&hold_back_urgent=true`, undefined, peter);
        assert.strictEqual(pre.status, 200);
        assert.strictEqual(pre.json.eligible, 5);
        assert.strictEqual((await httpJson(port, 'GET', `${base}/preview?older_than_days=abc`, undefined, peter)).status, 400);

        const crossSite = await httpJson(port, 'POST', base, mixedBody(), { ...peter, 'sec-fetch-site': 'cross-site' });
        assert.strictEqual(crossSite.status, 403);
        const asString = await httpJson(port, 'POST', base, { older_than_days: '90', hold_back_urgent: true, expected_count: 5, expected_hash: pre.json.set_hash }, peter);
        assert.strictEqual(asString.status, 400);
        assert.strictEqual(db.state.writes.length, 0);

        const closed = await httpJson(port, 'POST', base, mixedBody({ expected_hash: pre.json.set_hash }), { ...peter, 'sec-fetch-site': 'same-origin' });
        assert.strictEqual(closed.status, 200, closed.text);
        assert.strictEqual(closed.json.closed, 5);
        const list = await httpJson(port, 'GET', `${base}/batches`, undefined, peter);
        assert.strictEqual(list.json.batches[0].batch_id, closed.json.batch_id);
        assert.strictEqual(list.json.batches[0].still_closed, 5);
        const undone = await httpJson(port, 'POST', `${base}/${closed.json.batch_id}/undo`, {}, peter);
        assert.deepStrictEqual(undone.json, { batch_id: closed.json.batch_id, reopened: 5, skipped_changed: 0 });
        assert.strictEqual((await httpJson(port, 'POST', `${base}/${encodeURIComponent("x' OR '1'='1")}/undo`, {}, peter)).status, 400);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  asyncTest('bulk close routes — the existing complaint routes still answer where they did (the new routes shadow none of them)', async () => {
    const db = mixedWorld(Date.now()).db();
    await withRouter(db.client, async (mod) => {
      const has = (method, p) => mod.router.stack.some((l) => l.route && l.route.path === p && l.route.methods[method]);
      for (const [method, p] of [
        ['get', '/api/complaint-tracking'], ['get', '/api/complaint-tracking/home-count'], ['get', '/api/complaint-tracking/property/:property_id'],
        ['post', '/api/complaint-tracking/report'], ['post', '/api/complaint-tracking/:id/stage'], ['get', '/api/complaint-tracking/:id/history'],
        ['post', '/api/complaint-tracking/:id/delegate'], ['post', '/api/complaint-tracking/:id/match'], ['post', '/api/complaint-tracking/:id/duplicate/confirm'],
        ['post', '/api/complaint-tracking/:id/held/close'], ['post', '/api/complaint-tracking/:id/redact'], ['get', '/api/complaint-tracking/auth/me'],
      ]) assert.ok(has(method, p), `${method.toUpperCase()} ${p} is still registered`);
      // Express matches routes in order: a bulk-close path must reach its own handler first
      const order = mod.router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
      const idx = (s) => order.indexOf(s);
      assert.ok(idx('post /api/complaint-tracking/bulk-close/:batch_id/undo') < idx('post /api/complaint-tracking/:id/stage'));
      assert.ok(idx('get /api/complaint-tracking/bulk-close/preview') < idx('get /api/complaint-tracking/:id/history'));
    });
  });

  // ====================================================================
  // 12b. Peter's override (2026-10-22): legal-exposure items close unless the box is ticked; Fair Housing never
  // ====================================================================

  // 1 plain; 2 legal; 3 legal+urgent; 4/5 owner instruction rejected true/uncertain; 6/7 not a legal signal;
  // 8 accommodation; 9/10 Fair Housing flags (9 and 10 are also legal); 11 urgent.
  function legalWorld() {
    const w = world();
    w.add(1, 200);
    w.add(2, 200, { category: 'legal_exposure' });
    w.add(3, 200, { category: 'legal_exposure', severity_tier: 'urgent' });
    w.add(4, 200, { category: 'owner_instruction', owner_instruction_rejected: 'true' });
    w.add(5, 200, { category: 'owner_instruction', owner_instruction_rejected: 'uncertain' });
    w.add(6, 200, { category: 'owner_instruction', owner_instruction_rejected: 'false' });
    w.add(7, 200, { category: 'owner_instruction', owner_instruction_rejected: null });
    w.add(8, 200, { category: 'accommodation_related' });
    w.add(9, 200, { category: 'legal_exposure', flagged_protected_class: true, flagged_category: 'race' });
    w.add(10, 200, { category: 'legal_exposure', flagged_category: 'disability' });
    w.add(11, 200, { severity_tier: 'urgent' });
    return w;
  }
  const idsOf = (list) => list.map((n) => uuid(1000 + n));

  test('bulk close — legal-exposure signals: category legal_exposure, or an owner instruction rejected "true" or "uncertain"; nothing else counts', () => {
    const legal = (o) => bulk.isLegalTagged(complaint(1, o));
    assert.strictEqual(legal({ category: 'legal_exposure' }), true);
    assert.strictEqual(legal({ category: 'owner_instruction', owner_instruction_rejected: 'true' }), true);
    assert.strictEqual(legal({ category: 'owner_instruction', owner_instruction_rejected: 'uncertain' }), true);
    assert.strictEqual(legal({ category: 'owner_instruction', owner_instruction_rejected: 'false' }), false);
    assert.strictEqual(legal({ category: 'owner_instruction', owner_instruction_rejected: null }), false);
    assert.strictEqual(legal({ category: 'dispute' }), false);
    assert.strictEqual(legal({ category: null }), false);
    assert.strictEqual(legal({ needs_human_call: true }), false);
    assert.strictEqual(legal({ severity_tier: 'urgent' }), false);
    const fh = (o) => bulk.isFairHousing(complaint(1, o));
    assert.strictEqual(fh({ category: 'accommodation_related' }), true);
    assert.strictEqual(fh({ flagged_category: 'race' }), true);
    assert.strictEqual(fh({ flagged_protected_class: true }), true);
    assert.strictEqual(fh({ category: 'legal_exposure' }), false);
    assert.strictEqual(fh({}), false);
  });

  test('bulk close — decide(): legal-exposure items are ELIGIBLE by default, held back only with the box ticked; Fair Housing items are held back whatever any box says', () => {
    const cases = [
      [{ category: 'legal_exposure' }, 'eligible', 'legal_held_back'],
      [{ category: 'owner_instruction', owner_instruction_rejected: 'true' }, 'eligible', 'legal_held_back'],
      [{ category: 'owner_instruction', owner_instruction_rejected: 'uncertain' }, 'eligible', 'legal_held_back'],
      [{ category: 'owner_instruction', owner_instruction_rejected: 'false' }, 'eligible', 'eligible'],
      [{ category: 'legal_exposure', severity_tier: 'urgent' }, 'eligible', 'urgent_held_back'], // urgent box ticked below: urgent comes first
      [{ category: 'accommodation_related' }, 'fair_housing_flagged', 'fair_housing_flagged'],
      [{ flagged_protected_class: true, flagged_category: 'race', category: 'legal_exposure' }, 'fair_housing_flagged', 'fair_housing_flagged'],
      [{ flagged_category: 'disability', category: 'legal_exposure' }, 'fair_housing_flagged', 'fair_housing_flagged'],
    ];
    for (const [fields, withoutBox, withBox] of cases) {
      const row = baseRow(fields);
      // urgent box unticked here so only the legal box varies; the urgent+legal row is checked with the urgent box ticked afterwards
      const unticked = fields.severity_tier === 'urgent' ? 'eligible' : withoutBox;
      assert.strictEqual(verdict(row, { hold: false, holdLegal: false }), unticked, JSON.stringify(fields));
      const ticked = fields.severity_tier === 'urgent' ? 'legal_held_back' : withBox;
      assert.strictEqual(verdict(row, { hold: false, holdLegal: true }), ticked, JSON.stringify(fields));
    }
    assert.strictEqual(verdict(baseRow({ category: 'legal_exposure', severity_tier: 'urgent' }), { hold: true, holdLegal: true }), 'urgent_held_back');
    // Fair Housing under every combination of both boxes
    for (const hold of [true, false]) for (const holdLegal of [true, false]) {
      for (const fields of [{ category: 'accommodation_related' }, { flagged_protected_class: true, flagged_category: 'race' }, { flagged_category: 'disability' }]) {
        assert.strictEqual(verdict(baseRow({ severity_tier: 'urgent', ...fields }), { hold, holdLegal }), 'fair_housing_flagged', JSON.stringify({ fields, hold, holdLegal }));
      }
    }
  });

  asyncTest('bulk close — preview with the default boxes: legal-exposure items are in the count and the preview says how many; no legal line in the skipped list', async () => {
    const svc = service(legalWorld().db());
    const res = await svc.preview({});
    assert.strictEqual(res.body.hold_back_legal, false);
    assert.strictEqual(res.body.open_in_scope, 11);
    assert.strictEqual(res.body.eligible, 6);
    assert.strictEqual(res.body.legal_tagged_in_eligible, 3, 'items 2, 4 and 5 are tagged legal exposure and WILL be closed');
    assert.strictEqual(res.body.set_hash, bulk.setHash(idsOf([1, 2, 4, 5, 6, 7])));
    assert.deepStrictEqual(res.body.skipped, { fair_housing_flagged: 3, urgent_held_back: 2, recent: 0, manual_report: 0, recently_worked_or_delegated: 0, kept_has_note: 0, duplicate_pending: 0, not_open_or_other: 0 });
    assert.ok(!('legal_held_back' in res.body.skipped));
  });

  asyncTest('bulk close — preview with the legal box ticked: those items move to a legal_held_back line, the count of legal items to be closed is 0, and the lines still add up', async () => {
    const svc = service(legalWorld().db());
    const res = await svc.preview({ hold_back_legal: 'true' });
    assert.strictEqual(res.body.hold_back_legal, true);
    assert.strictEqual(res.body.eligible, 3);
    assert.strictEqual(res.body.legal_tagged_in_eligible, 0);
    assert.strictEqual(res.body.skipped.legal_held_back, 3);
    assert.strictEqual(res.body.skipped.fair_housing_flagged, 3);
    assert.strictEqual(res.body.skipped.urgent_held_back, 2);
    assert.strictEqual(res.body.set_hash, bulk.setHash(idsOf([1, 6, 7])));
    assert.strictEqual(res.body.eligible + Object.values(res.body.skipped).reduce((a, b) => a + b, 0), res.body.open_in_scope);
    // both boxes unticked
    const both = (await svc.preview({ hold_back_urgent: 'false', hold_back_legal: 'false' })).body;
    assert.strictEqual(both.eligible, 8);
    assert.strictEqual(both.legal_tagged_in_eligible, 4);
    assert.strictEqual(both.skipped.fair_housing_flagged, 3, 'Fair Housing stays whatever the boxes say');
  });

  asyncTest('bulk close — close with the default boxes closes the legal-exposure items too (Peter\'s override); with the box ticked it leaves them open; the start row records which', async () => {
    const dbDefault = legalWorld().db();
    const resDefault = await service(dbDefault).execute(closeBody(6, { expected_hash: bulk.setHash(idsOf([1, 2, 4, 5, 6, 7])) }), ACTOR);
    assert.strictEqual(resDefault.status, 200);
    assert.strictEqual(resDefault.body.closed, 6);
    assert.strictEqual(resDefault.body.hold_back_legal, false);
    const closedIds = dbDefault.tables.complaints.filter((c) => c.status === 'resolved').map((c) => c.id).sort();
    assert.deepStrictEqual(closedIds, idsOf([1, 2, 4, 5, 6, 7]));
    const startDefault = dbDefault.tables.audit_log.find((r) => r.action === bulk.ACTIONS.batchStarted);
    assert.strictEqual(startDefault.details.hold_back_legal, false);
    assert.strictEqual(startDefault.details.legal_tagged_in_eligible, 3);
    for (const r of dbDefault.tables.audit_log.filter((x) => x.action === bulk.ACTIONS.itemClosed)) assert.strictEqual(r.details.hold_back_legal, false);

    const dbHeld = legalWorld().db();
    const resHeld = await service(dbHeld).execute(closeBody(3, { hold_back_legal: true, expected_hash: bulk.setHash(idsOf([1, 6, 7])) }), ACTOR);
    assert.strictEqual(resHeld.body.closed, 3);
    assert.strictEqual(resHeld.body.hold_back_legal, true);
    assert.deepStrictEqual(dbHeld.tables.complaints.filter((c) => c.status === 'resolved').map((c) => c.id).sort(), idsOf([1, 6, 7]));
    const startHeld = dbHeld.tables.audit_log.find((r) => r.action === bulk.ACTIONS.batchStarted);
    assert.strictEqual(startHeld.details.hold_back_legal, true);
    assert.strictEqual(startHeld.details.skipped.legal_held_back, 3);
    // a close that does not say which preview it follows (legal box differs) is refused by the count/set check
    const dbMismatch = legalWorld().db();
    const mismatch = await service(dbMismatch).execute(closeBody(6, { hold_back_legal: true, expected_hash: bulk.setHash(idsOf([1, 2, 4, 5, 6, 7])) }), ACTOR);
    assert.strictEqual(mismatch.status, 409);
    assert.strictEqual(dbMismatch.state.writes.length, 0);
  });

  asyncTest('bulk close — Fair Housing items cannot be closed by ANY request: extra keys that try to switch the hold-back off are ignored, in the service and over the real routes', async () => {
    const sneaky = { hold_back_fair_housing: false, include_fair_housing: true, hold_back_protected: false, allow_fair_housing: true, hold_back_accommodation: false, force: true };
    const db = legalWorld().db();
    const preview = (await service(db).preview({ older_than_days: '90', hold_back_urgent: 'false', hold_back_legal: 'false', ...sneaky })).body;
    assert.strictEqual(preview.skipped.fair_housing_flagged, 3);
    const res = await service(db).execute({ older_than_days: 90, hold_back_urgent: false, hold_back_legal: false, expected_count: preview.eligible, expected_hash: preview.set_hash, ...sneaky }, ACTOR);
    assert.strictEqual(res.status, 200);
    const closed = new Set(db.tables.complaints.filter((c) => c.status === 'resolved').map((c) => c.id));
    for (const n of [8, 9, 10]) assert.ok(!closed.has(uuid(1000 + n)), `Fair Housing item ${n} must stay open`);
    assert.strictEqual(closed.size, 8);

    const w = legalWorld();
    w.users.push({ id: PERFORMED_BY, email: ACTOR.email, alt_email: null });
    const db2 = w.db(null, { startMs: Date.now() });
    await withRouter(db2.client, async (mod) => {
      const pre = await runRoute(mod, ...ROUTES.preview, reqOf({ query: { older_than_days: '90', hold_back_urgent: 'false', ...Object.fromEntries(Object.entries(sneaky).map(([k, v]) => [k, String(v)])) } }));
      assert.strictEqual(pre.status, 200);
      const out = await runRoute(mod, ...ROUTES.close, reqOf({ body: { older_than_days: 90, hold_back_urgent: false, expected_count: pre.body.eligible, expected_hash: pre.body.set_hash, ...sneaky } }));
      assert.strictEqual(out.status, 200);
      for (const n of [8, 9, 10]) assert.strictEqual(db2.tables.complaints.find((c) => c.id === uuid(1000 + n)).status, 'open');
    });
  });

  // ====================================================================
  // 12c. An item that already has a note is never overwritten
  // ====================================================================

  function notesWorld() {
    const w = world();
    w.add(1, 200); // eligible
    w.add(2, 200, { resolution_note: 'Reopened earlier; the old note was left on it' }); // kept
    w.add(3, 200, { resolution_note: 'Another old note', severity_tier: 'urgent' }); // urgent comes first
    w.add(4, 300, { resolution_note: 'Third old note' }); // kept
    w.add(5, 10, { resolution_note: 'Recent one' }); // recent comes first
    return w;
  }

  asyncTest('bulk close — an open item with a resolution note is kept open and counted as kept_has_note in the preview and the close; open_in_scope = eligible + every skipped line; the note itself is never read', async () => {
    const w = notesWorld();
    const db = w.db();
    const svc = service(db);
    const pre = (await svc.preview({})).body;
    assert.strictEqual(pre.eligible, 1);
    assert.strictEqual(pre.skipped.kept_has_note, 2);
    assert.strictEqual(pre.skipped.urgent_held_back, 1);
    assert.strictEqual(pre.skipped.recent, 1);
    assert.strictEqual(pre.open_in_scope, 5);
    assert.strictEqual(pre.eligible + Object.values(pre.skipped).reduce((a, b) => a + b, 0), pre.open_in_scope);
    assert.ok(db.state.calls.every((c) => !(c.cols || '').includes('resolution_note')), 'no read ever asks for the note\'s text');

    const res = await svc.execute(closeBody(1, { expected_hash: pre.set_hash }), ACTOR);
    assert.strictEqual(res.body.closed, 1);
    const row = (n) => db.tables.complaints.find((c) => c.id === uuid(1000 + n));
    assert.strictEqual(row(1).status, 'resolved');
    for (const n of [2, 3, 4, 5]) assert.strictEqual(row(n).status, 'open', `item ${n} stays open`);
    assert.strictEqual(row(2).resolution_note, 'Reopened earlier; the old note was left on it');
    assert.strictEqual(row(4).resolution_note, 'Third old note');
    // a second preview now: nothing left, and the same two kept
    const again = (await svc.preview({})).body;
    assert.strictEqual(again.eligible, 0);
    assert.strictEqual(again.skipped.kept_has_note, 2);
    // the start row recorded the kept count
    assert.strictEqual(db.tables.audit_log.find((r) => r.action === bulk.ACTIONS.batchStarted).details.skipped.kept_has_note, 2);
    // undo clears only the note this batch wrote
    const undone = await svc.undo(res.body.batch_id, ACTOR);
    assert.strictEqual(undone.body.reopened, 1);
    assert.strictEqual(row(1).resolution_note, null);
    assert.strictEqual(row(2).resolution_note, 'Reopened earlier; the old note was left on it');
    assert.strictEqual(row(4).resolution_note, 'Third old note');
  });

  asyncTest('bulk close — notes are found past the 1,000-row page limit (1,500 open items with notes are all kept), and a failed note check stops the preview and the close (500, nothing changed)', async () => {
    const w = world();
    for (let n = 1; n <= 1500; n += 1) w.add(n, 200, { resolution_note: 'note' });
    w.add(1501, 200);
    const db = w.db();
    const pre = (await service(db).preview({})).body;
    assert.strictEqual(pre.skipped.kept_has_note, 1500);
    assert.strictEqual(pre.eligible, 1);
    assert.strictEqual(db.state.calls.filter((c) => c.table === 'complaints' && c.cols === 'id').length, 2, 'two pages of ids');

    const w2 = notesWorld();
    const db2 = w2.db({ fail: (q) => (q.table === 'complaints' && q.cols === 'id' ? { message: 'boom' } : null) });
    const svc = service(db2);
    await quiet(async () => {
      await assert.rejects(() => svc.preview({}), /note/);
      await assert.rejects(() => svc.execute(closeBody(1), ACTOR), /note/);
    });
    assert.strictEqual(db2.state.writes.length, 0);
    await quiet(async () => {
      const lockFree = await svc.preview({}).catch(() => 'rejected');
      assert.strictEqual(lockFree, 'rejected');
    });
  });

  // ====================================================================
  // 12d. Undo, then close again with corrected settings
  // ====================================================================

  asyncTest('bulk close — UNDO THEN RE-CLOSE: this feature\'s own close and undo rows do not count as "a person worked on it", so the same items can be closed again with different settings; a real person\'s work still counts', async () => {
    const w = world();
    for (let n = 1; n <= 5; n += 1) w.add(n, 200);
    w.add(6, 200, {}, [{ days: 10, type: 'human' }]); // a person really worked on this 10 days ago
    w.add(7, 200, {}, [{ days: 60, type: 'human' }]); // a person, but long ago: eligible
    const db = w.db();
    // The clock follows the fake database's, as the real one does: rows reopened by the undo carry a time that is already past.
    const svc = service(db, { now: () => Math.max(NOW, db.state.clock + 1000) });
    const first = (await svc.preview({})).body;
    assert.strictEqual(first.eligible, 6);
    assert.strictEqual(first.skipped.recently_worked_or_delegated, 1);
    const closed = await svc.execute(closeBody(6, { expected_hash: first.set_hash }), ACTOR);
    assert.strictEqual(closed.body.closed, 6);
    const undone = await svc.undo(closed.body.batch_id, ACTOR);
    assert.strictEqual(undone.body.reopened, 6);
    // the newest audit row of every one of those six is now a person's (bulk_close_undone)
    for (const n of [1, 2, 3, 4, 5, 7]) {
      const rows = db.tables.audit_log.filter((r) => r.entity_id === uuid(1000 + n) && r.entity_type === 'complaint');
      assert.strictEqual(rows[rows.length - 1].action, bulk.ACTIONS.itemReopened);
      assert.strictEqual(rows[rows.length - 1].actor_type, 'human');
    }
    const second = (await svc.preview({ older_than_days: '120', hold_back_urgent: 'false' })).body;
    assert.strictEqual(second.eligible, 6, 'all six can be closed again');
    assert.strictEqual(second.skipped.recently_worked_or_delegated, 1, 'only the person\'s real work 10 days ago still protects an item');
    const again = await svc.execute({ older_than_days: 120, hold_back_urgent: false, expected_count: 6, expected_hash: second.set_hash }, ACTOR);
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.closed, 6);
    assert.strictEqual(again.body.older_than_days, 120);
    assert.strictEqual((await svc.listBatches()).body.batches.length, 2);
  });

  asyncTest('bulk close — only this feature\'s own rows are ignored in the "recently worked" test: a person\'s earlier real action still counts even when bulk rows come after it', async () => {
    const w = world();
    const bulkRows = (extra) => [{ days: 2, type: 'human', action: bulk.ACTIONS.itemClosed }, { days: 1, type: 'human', action: bulk.ACTIONS.itemReopened }, ...extra];
    w.add(1, 200, {}, bulkRows([{ days: 12, type: 'human' }]));      // a person's real action 12 days ago, then bulk rows: protected
    w.add(2, 200, {}, bulkRows([{ days: 70, type: 'human' }]));      // a person's real action 70 days ago: not protected
    w.add(3, 200, {}, bulkRows([]));                                  // only bulk rows: not protected
    w.add(4, 200, {}, bulkRows([{ days: 3, type: 'human', action: 'complaint_tracking.delegated' }])); // a real action 3 days ago, newer than 12: protected
    const res = (await service(w.db()).preview({})).body;
    assert.strictEqual(res.eligible, 2);
    assert.strictEqual(res.skipped.recently_worked_or_delegated, 2);
    assert.strictEqual(res.set_hash, bulk.setHash([uuid(1002), uuid(1003)]));
  });

  asyncTest('bulk close — undo reports every item it left alone, including ones whose note a person replaced (they carry no tag any more), and says the same again on a second undo', async () => {
    const w = world();
    for (let n = 1; n <= 5; n += 1) w.add(n, 200);
    const db = w.db();
    const svc = service(db);
    const closed = await svc.execute(closeBody(5), ACTOR);
    const row = (n) => db.tables.complaints.find((c) => c.id === uuid(1000 + n));
    row(1).resolution_note = 'A person wrote their own resolution'; // tag gone
    row(2).resolution_note = 'Another person note';                 // tag gone
    row(3).status = 'in_progress';                                   // tag kept, status changed
    const res = await svc.undo(closed.body.batch_id, ACTOR);
    assert.strictEqual(res.body.reopened, 2);
    assert.strictEqual(res.body.skipped_changed, 3, 'items 1, 2 and 3 were left alone');
    // a second undo reopens nothing more and reports the same three left alone (two replaced notes, one picked up by a person)
    const second = await svc.undo(closed.body.batch_id, ACTOR);
    assert.deepStrictEqual(second.body, { batch_id: closed.body.batch_id, reopened: 0, skipped_changed: 3 });
    assert.strictEqual(row(1).resolution_note, 'A person wrote their own resolution');
    assert.strictEqual(row(3).status, 'in_progress');
  });

  asyncTest('bulk close — a batch with a start row but no end row, whose notes are all gone: undo says nothing was left alone (the number cannot be told), and does not make one up', async () => {
    const w = world();
    startRow(w, 1);
    const res = await service(w.db()).undo(uuid(7001), ACTOR);
    assert.deepStrictEqual(res, { status: 200, body: { batch_id: uuid(7001), reopened: 0, skipped_changed: 0 } });
    assert.strictEqual((await service(w.db()).undo(uuid(7002), ACTOR)).status, 404, 'a batch with no rows at all is still unknown');
  });

  asyncTest('bulk close — undo when every note was replaced: nothing reopened, and all of them are counted as left alone', async () => {
    const w = world();
    for (let n = 1; n <= 4; n += 1) w.add(n, 200);
    const db = w.db();
    const svc = service(db);
    const closed = await svc.execute(closeBody(4), ACTOR);
    for (const c of db.tables.complaints) c.resolution_note = 'replaced by a person';
    const res = await svc.undo(closed.body.batch_id, ACTOR);
    assert.deepStrictEqual(res, { status: 200, body: { batch_id: closed.body.batch_id, reopened: 0, skipped_changed: 4 } });
  });

  asyncTest('bulk close — a partly failed undo followed by a second undo adds up: nothing is reported as replaced that was really reopened', async () => {
    const w = world();
    for (let n = 1; n <= 200; n += 1) w.add(n, 200);
    const db0 = w.db();
    const closed = await service(db0).execute(closeBody(200), ACTOR);
    let updates = 0;
    const db = makeDb({ complaints: db0.tables.complaints, audit: db0.tables.audit_log }, { fail: (q) => { if (q.table === 'complaints' && q.op === 'update') { updates += 1; if (updates === 1) return { message: 'outage' }; } return null; } }, { startMs: NOW + 3600 * 1000 });
    const svc = service(db);
    const { value: first } = await quiet(() => svc.undo(closed.body.batch_id, ACTOR));
    assert.strictEqual(first.body.reopened, 120);
    assert.strictEqual(first.body.failed, 80);
    assert.strictEqual(first.body.skipped_changed, 0);
    const second = await svc.undo(closed.body.batch_id, ACTOR);
    assert.deepStrictEqual(second.body, { batch_id: closed.body.batch_id, reopened: 80, skipped_changed: 0 });
  });

  // ====================================================================
  // 12e. Hardening
  // ====================================================================

  test('bulk close — the batch tag in a note: batchIdOfNote reads the id right after the days, exactly; look-alikes give nothing', () => {
    const X = 'abcdef01-2345-4678-9abc-def012345678';
    const good = `Closed in bulk: no email activity for over 90 days (batch ${X}), approved by Peter McKenzie on 2026-10-21.`;
    assert.strictEqual(bulk.batchIdOfNote(good), X);
    assert.strictEqual(bulk.batchIdOfNote(bulk.buildNote({ olderThanDays: 365, batchId: X, approverName: 'Pat', nowMs: NOW })), X);
    const bad = [
      null, undefined, 42, '', `x ${good}`, ` ${good}`, good.replace('Closed in bulk', 'closed in bulk'),
      good.replace(`(batch ${X})`, `[batch ${X}]`), good.replace(`(batch ${X})`, `(batch ${X.toUpperCase()})`), good.replace(`(batch ${X})`, `(batch ${X}0)`),
      good.replace(', approved by', ' approved by'), good.replace('over 90 days', 'over days'), good.replace('over 90 days', 'over x90 days'),
      `A person wrote: ${good}`, `Closed in bulk: no email activity for over 90 days, approved by Eve (batch ${X}) on 2026-10-21.`,
    ];
    for (const note of bad) assert.strictEqual(bulk.batchIdOfNote(note), null, JSON.stringify(note));
    // a name that carries a tag of its own is read as the REAL tag, never the name's
    const Y = uuid(5002);
    const forged = `Closed in bulk: no email activity for over 90 days (batch ${Y}), approved by Eve days (batch ${X}), approved by Z on 2026-10-21.`;
    assert.strictEqual(bulk.batchIdOfNote(forged), Y);
    // and the database search refuses a note that holds two tags at all
    assert.strictEqual(bulk.TWO_TAGS_PATTERN, '%(batch %(batch %');
  });

  test('bulk close — a name can not carry a batch tag into a note: brackets are taken out of the approver\'s name', () => {
    const X = uuid(5001);
    const Y = uuid(5002);
    const note = bulk.buildNote({ olderThanDays: 90, batchId: Y, approverName: `Eve (batch ${X})`, nowMs: NOW });
    assert.strictEqual((note.match(/\(/g) || []).length, 1, 'the only bracket in the note is the real tag');
    assert.ok(!note.includes(`(batch ${X})`));
    assert.strictEqual(bulk.batchIdOfNote(note), Y);
    assert.ok(note.includes('approved by Eve batch'), note);
    assert.ok(!/[()]/.test(bulk.buildNote({ olderThanDays: 90, batchId: Y, approverName: '((()))', nowMs: NOW }).replace(`(batch ${Y})`, '')));
  });

  asyncTest('bulk close — undoing batch X never reopens batch Y\'s items, even when Y was closed by a person whose name says "(batch X)"; notes forged by hand are not found by the search or are refused by the exact check; the live counts agree', async () => {
    const w = world();
    w.add(1, 200); w.add(2, 200);
    const db = w.db();
    const svc = service(db); // batch ids: uuid(5001), uuid(5002), ...
    const X = uuid(5001);
    const Y = uuid(5002);
    const a = await svc.execute(closeBody(2), ACTOR);
    assert.strictEqual(a.body.batch_id, X);
    for (let n = 3; n <= 4; n += 1) {
      db.tables.complaints.push(complaint(n));
      db.tables.missive_message_intake.push({ missive_conversation_id: `conv-${n}`, delivered_at: iso(NOW - 250 * DAY) });
    }
    const b = await svc.execute(closeBody(2, { expected_hash: bulk.setHash([uuid(1003), uuid(1004)]) }), { email: 'eve@rincon.test', name: `Eve (batch ${X})` });
    assert.strictEqual(b.body.batch_id, Y);
    // two notes forged by hand in the database (the app itself can not write these: names have no brackets):
    //  5: a real tag for Y with an imitation of X's tag inside the name part
    //  6: right shape for X but "abc" where the days belong
    db.tables.complaints.push(complaint(5, { status: 'resolved', resolution_note: `Closed in bulk: no email activity for over 90 days (batch ${Y}), approved by Eve days (batch ${X}), approved by Z on 2026-10-21.` }));
    db.tables.complaints.push(complaint(6, { status: 'resolved', resolution_note: `Closed in bulk: no email activity for over abc days (batch ${X}), approved by Eve on 2026-10-21.` }));
    const list = (await svc.listBatches()).body.batches;
    assert.strictEqual(list.find((x) => x.batch_id === Y).still_closed, 2, 'Y has exactly its own two: the forged note with two tags is nobody\'s');
    const undone = await svc.undo(X, ACTOR);
    assert.strictEqual(undone.body.reopened, 2);
    const state = (n) => db.tables.complaints.find((c) => c.id === uuid(1000 + n)).status;
    assert.deepStrictEqual([1, 2, 3, 4, 5, 6].map(state), ['open', 'open', 'resolved', 'resolved', 'resolved', 'resolved'], 'batch Y and both forged notes were left alone');
    assert.strictEqual(undone.body.skipped_changed, 1, 'the "abc" note matched the database search but fails the exact check: counted as left alone');
    const undoneY = await svc.undo(Y, ACTOR);
    assert.strictEqual(undoneY.body.reopened, 2, 'Y\'s own two, not the forged note');
    assert.strictEqual(state(5), 'resolved');
    // the search the database is given refuses a note holding two tags
    for (const call of db.state.calls.filter((c) => c.table === 'complaints')) {
      const likes = call.filters.filter((f) => f.kind === 'like' || (f.kind === 'not' && f.op === 'like'));
      if (likes.length) assert.ok(likes.some((f) => f.kind === 'not' && f.val === bulk.TWO_TAGS_PATTERN), 'every note search also rules out two tags');
    }
  });

  asyncTest('bulk close — SET CODE: the preview hands back a code for exactly which items qualify, and a close with the right count but a different set is refused (409) with nothing written', async () => {
    const w = world();
    w.add(21, 200); w.add(22, 200);
    w.add(23, 50); // not old enough yet
    const db = w.db();
    const svc = service(db);
    const pre = (await svc.preview({})).body;
    assert.strictEqual(pre.eligible, 2);
    assert.strictEqual(pre.set_hash, bulk.setHash([uuid(1021), uuid(1022)]));
    assert.strictEqual(bulk.setHash([uuid(1022), uuid(1021)]), pre.set_hash, 'the order of the ids does not matter');
    assert.notStrictEqual(bulk.setHash([uuid(1021), uuid(1023)]), pre.set_hash);
    assert.notStrictEqual(bulk.setHash([]), pre.set_hash);
    // between the preview and the close: 22 gets a fresh email, 23 ages out. Still two items, but not the same two.
    db.tables.missive_message_intake.push({ missive_conversation_id: 'conv-22', delivered_at: iso(NOW - 2 * DAY) });
    for (const m of db.tables.missive_message_intake.filter((x) => x.missive_conversation_id === 'conv-23')) m.delivered_at = iso(NOW - 150 * DAY);
    const stale = await svc.execute(closeBody(2, { expected_hash: pre.set_hash }), ACTOR);
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.body.eligible, 2);
    assert.ok(/not the same ones/.test(stale.body.error), stale.body.error);
    assert.strictEqual(db.state.writes.length, 0);
    // the right code for the new set works
    const fresh = (await svc.preview({})).body;
    assert.strictEqual(fresh.set_hash, bulk.setHash([uuid(1021), uuid(1023)]));
    const ok = await svc.execute(closeBody(2, { expected_hash: fresh.set_hash.toUpperCase() }), ACTOR);
    assert.strictEqual(ok.status, 200, 'the code is compared without regard to upper or lower case');
    assert.strictEqual(ok.body.closed, 2);
    // a wrong code of the right shape
    const db2 = mixedWorld().db();
    const wrong = await service(db2).execute(mixedBody({ expected_hash: '0'.repeat(64) }), ACTOR);
    assert.strictEqual(wrong.status, 409);
    assert.strictEqual(db2.state.writes.length, 0);
  });

  asyncTest('bulk close — nothing the database says is ever logged: not in a failed read, a failed group, a failed audit row, a failed count, or the route\'s 500', async () => {
    const secret = 'password authentication failed for user "postgres" at 10.9.8.7 (SECRET-TOKEN-XYZ)';
    const world5 = () => { const w = world(); for (let n = 1; n <= 5; n += 1) w.add(n, 200); return w; };
    const which = [
      ['a failed read', (q) => (q.table === 'complaints' && q.op === 'select' && q.cols === bulk.COMPLAINT_COLUMNS), (svc) => svc.preview({}).catch(() => 'threw')],
      ['a failed group', (q) => (q.table === 'complaints' && q.op === 'update'), (svc) => svc.execute(closeBody(5), ACTOR)],
      ['a failed audit row', (q) => (q.table === 'audit_log' && q.op === 'insert' && q.rows[0].action !== bulk.ACTIONS.batchStarted), (svc) => svc.execute(closeBody(5), ACTOR)],
      ['a failed start row', (q) => (q.table === 'audit_log' && q.op === 'insert'), (svc) => svc.execute(closeBody(5), ACTOR)],
      ['a failed count', (q) => (q.table === 'complaints' && q.head), (svc) => svc.listBatches()],
      ['a failed batch list', (q) => (q.table === 'audit_log' && q.op === 'select' && q.cols === 'entity_id, actor_id, details, created_at'), (svc) => svc.listBatches().catch(() => 'threw')],
    ];
    for (const [label, when, act] of which) {
      const w = world5();
      const priming = w.db(); // a closed batch to list, for the count/list cases
      const primed = await service(priming).execute(closeBody(5), ACTOR);
      assert.strictEqual(primed.status, 200);
      const target = label.includes('list') || label.includes('count') ? priming : w.db();
      const fresh = makeDb({ complaints: target.tables.complaints, audit: target.tables.audit_log, messages: target.tables.missive_message_intake }, { fail: (q) => (when(q) ? { message: secret, code: '28P01' } : null) }, { startMs: NOW + 3600 * 1000 });
      const { logged } = await quiet(async () => act(service(fresh)));
      const text = logged.join('\n');
      assert.ok(!/SECRET-TOKEN|postgres|10\.9\.8\.7|password/i.test(text), `${label}: the log must not carry the database's own words: ${text}`);
    }
    // errors that are THROWN (a dropped connection, a bug), not returned: the group update and the audit insert
    for (const [label, when, act] of [
      ['a group that throws', (q) => q.table === 'complaints' && q.op === 'update', (svc) => svc.execute(closeBody(5), ACTOR)],
      ['an audit insert that throws', (q) => q.table === 'audit_log' && q.op === 'insert' && q.rows[0].action !== bulk.ACTIONS.batchStarted, (svc) => svc.execute(closeBody(5), ACTOR)],
      ['an undo group that throws', (q) => q.table === 'complaints' && q.op === 'update' && q.patch.status === 'open', null],
    ]) {
      const w = world5();
      const base = w.db();
      const closedFirst = await service(base).execute(closeBody(5), ACTOR);
      const target = label.includes('undo') ? base : w.db();
      const fresh = makeDb({ complaints: target.tables.complaints, audit: target.tables.audit_log, messages: target.tables.missive_message_intake }, { before: (q) => { if (when(q)) throw new Error(secret); } }, { startMs: NOW + 3600 * 1000 });
      const { logged } = await quiet(async () => (act ? act(service(fresh)) : service(fresh).undo(closedFirst.body.batch_id, ACTOR)));
      assert.ok(logged.length > 0, `${label}: something was logged`);
      assert.ok(!/SECRET-TOKEN|postgres|10\.9\.8\.7|password/i.test(logged.join('\n')), `${label}: the log must not carry the error's own words: ${logged.join(' | ')}`);
    }
    // a client that throws before it even answers
    const throwing = { from: () => { throw new Error(secret); } };
    await withRouter(throwing, async (mod) => {
      const { logged, value } = await quiet(() => runRoute(mod, ...ROUTES.preview, reqOf({ query: {} })));
      assert.strictEqual(value.status, 500);
      assert.ok(!/SECRET-TOKEN|postgres|10\.9\.8\.7|password/i.test(logged.join('\n')), `a thrown error: ${logged.join(' | ')}`);
      assert.ok(!/SECRET-TOKEN|postgres|password/i.test(JSON.stringify(value.body)));
    });
    // the route's own 500 log line
    const db = world5().db({ fail: (q) => (q.table === 'complaints' ? { message: secret, code: '28P01' } : null) });
    await withRouter(db.client, async (mod) => {
      const { logged, value } = await quiet(() => runRoute(mod, ...ROUTES.preview, reqOf({ query: {} })));
      assert.strictEqual(value.status, 500);
      assert.ok(logged.some((l) => l.includes('bulk close')), 'a line was logged');
      assert.ok(!/SECRET-TOKEN|postgres|10\.9\.8\.7|password/i.test(logged.join('\n')));
      assert.ok(logged.join('\n').includes('28P01'), 'the short code is kept for diagnosis');
    });
    assert.strictEqual(bulk.safeErr({ message: secret }), 'error');
    assert.strictEqual(bulk.safeErr({ message: secret, code: '23505', name: 'PostgrestError' }), 'PostgrestError 23505');
    assert.strictEqual(bulk.safeErr({ code: 'has spaces and (parens)' }), 'error');
    assert.strictEqual(bulk.safeErr(null), 'error');
  });

  asyncTest('bulk close — the one-at-a-time lock times out: a call that has held it for over 10 minutes is taken as hung; the next call may start, and the hung one stops before its next write and releases nothing it no longer owns', async () => {
    assert.strictEqual(bulk.BUSY_TIMEOUT_MS, 10 * 60 * 1000);
    // (1) a call that never answers does not block closes forever
    const w = world();
    for (let n = 1; n <= 160; n += 1) w.add(n, 200);
    let t = 1000;
    let updates = 0;
    const dbHung = w.db({ fail: (q) => { if (q.table === 'complaints' && q.op === 'update') { updates += 1; if (updates === 1) return { hang: true }; } return null; } });
    const svcHung = service(dbHung, { clock: () => t });
    svcHung.execute(closeBody(160), ACTOR).catch(() => {});
    await waitFor(() => updates >= 1);
    t += 9 * 60 * 1000;
    assert.strictEqual((await svcHung.execute(closeBody(160), ACTOR)).status, 409, 'still within the limit: refused');
    assert.strictEqual((await svcHung.undo(uuid(9), ACTOR)).status, 409);
    t += 2 * 60 * 1000;
    const { value: taken, logged } = await quiet(() => svcHung.execute(closeBody(160), ACTOR));
    assert.strictEqual(taken.status, 200, 'past the limit: the next call goes ahead');
    assert.strictEqual(taken.body.closed, 160);
    assert.ok(logged.some((l) => /lock/.test(l)));
    // its own lock is released normally afterwards
    assert.strictEqual((await svcHung.preview({})).status, 200);

    // (2) a slow call that resumes after being taken over stops before its next group, and does not free the newer call's lock
    const w2 = world();
    for (let n = 1; n <= 200; n += 1) w2.add(n, 200);
    let clock2 = 0;
    let n2 = 0;
    const db2 = w2.db({ delay: (q) => { if (q.table === 'complaints' && q.op === 'update') { n2 += 1; return n2 === 1 ? 120 : (n2 === 2 ? 400 : 0); } return 0; } });
    const svc2 = service(db2, { clock: () => clock2 });
    const slowA = svc2.execute(closeBody(200), ACTOR);
    await waitFor(() => n2 >= 1);
    clock2 += 11 * 60 * 1000;
    const slowB = svc2.execute(closeBody(200), ACTOR); // takes over; its own first update is the slow one (400 ms)
    await waitFor(() => n2 >= 2);
    const a = await slowA; // A finishes its first (already started) group, then sees the lock is gone
    assert.strictEqual(a.status, 200);
    assert.strictEqual(a.body.stopped_early, true);
    assert.strictEqual(a.body.closed, 80);
    assert.strictEqual(a.body.failed, 120, 'the groups it never reached are reported as not closed');
    clock2 += 1; // still B's lock: A's finishing must not have released it
    assert.strictEqual((await svc2.execute(closeBody(120, { expected_hash: bulk.setHash(seqIds(200).slice(80)) }), ACTOR)).status, 409, 'B still holds the lock');
    const b = await slowB;
    assert.strictEqual(b.status, 200);
    assert.strictEqual(b.body.closed + a.body.closed, 200, 'between them every item was closed exactly once');
    assert.strictEqual(db2.tables.complaints.filter((c) => c.status === 'resolved').length, 200);
    const endRowA = db2.tables.audit_log.find((r) => r.action === bulk.ACTIONS.batchClosed && r.entity_id === a.body.batch_id);
    assert.strictEqual(endRowA.details.stopped_early, true);
  });

  asyncTest('bulk close — PREVIEW LIMIT: one preview per person per second; another person is not held up; a request that is refused for bad input does not use up the turn; the limit is on by default on the real route', async () => {
    assert.strictEqual(bulk.PREVIEW_MIN_INTERVAL_MS, 1000);
    const w = mixedWorld();
    const db = w.db();
    let t = 10000;
    const svc = service(db, { previewMinIntervalMs: 1000, clock: () => t });
    const me = { email: 'a@rincon.test' };
    assert.strictEqual((await svc.preview({}, me)).status, 200);
    const callsAfterFirst = db.state.calls.length;
    t += 400;
    const tooSoon = await svc.preview({}, me);
    assert.strictEqual(tooSoon.status, 429);
    assert.ok(tooSoon.body.error);
    assert.strictEqual(db.state.calls.length, callsAfterFirst, 'a refused preview reads nothing');
    assert.strictEqual((await svc.preview({}, { email: 'b@rincon.test' })).status, 200, 'another person is not affected');
    assert.strictEqual((await svc.preview({ older_than_days: 'abc' }, me)).status, 400, 'bad input is refused before the limit is looked at');
    t += 600; // 1,000 ms since the first
    assert.strictEqual((await svc.preview({}, me)).status, 200);
    // the close and the batch list are not limited
    assert.strictEqual((await svc.execute(mixedBody(), ACTOR)).status, 200);
    assert.strictEqual((await svc.listBatches()).status, 200);
    // without a limit set (the default for the service itself) nothing is refused
    const free = service(mixedWorld().db());
    for (let i = 0; i < 3; i += 1) assert.strictEqual((await free.preview({}, me)).status, 200);
    // many different people do not grow the table without end
    const many = service(mixedWorld().db(), { previewMinIntervalMs: 1000, clock: () => (t += 61000) });
    for (let i = 0; i < 230; i += 1) assert.strictEqual((await many.preview({}, { email: `p${i}@rincon.test` })).status, 200);

    // on the real route (limit on by default), the second quick preview by the same person is refused
    const dbRoute = mixedWorld(Date.now()).db();
    await withRouter(dbRoute.client, async (mod) => {
      const first = await runRoute(mod, ...ROUTES.preview, reqOf({ query: {} }));
      const second = await runRoute(mod, ...ROUTES.preview, reqOf({ query: {} }));
      const other = await runRoute(mod, ...ROUTES.preview, reqOf({ email: 'other@rincon.test', query: {} }));
      assert.deepStrictEqual([first.status, second.status, other.status], [200, 429, 200]);
    });
  });

  // ====================================================================
  // 12f. Server-side warnings the page shows
  // ====================================================================

  asyncTest('bulk close — the fields the page warns with: audit_failed on the close answer, lookup_incomplete on the preview; still_closed null (unknown) on a batch list', async () => {
    const w = world();
    for (let n = 1; n <= 6; n += 1) w.add(n, 200);
    let seen = 0;
    const db = w.db({ fail: (q) => { if (q.table === 'audit_log' && q.op === 'insert') { seen += 1; if (seen > 1) return { message: 'x' }; } return null; } });
    const { value: closed } = await quiet(() => service(db).execute(closeBody(6), ACTOR));
    assert.strictEqual(closed.body.closed, 6);
    assert.strictEqual(closed.body.audit_failed, 7);
    const w2 = world();
    for (let n = 1; n <= 6; n += 1) w2.add(n, 200);
    const db2 = w2.db({ fail: (q) => (q.table === 'missive_message_intake' ? { message: 'x' } : null) });
    const { value: pre } = await quiet(() => service(db2).preview({}));
    assert.strictEqual(pre.body.lookup_incomplete, true);
    assert.strictEqual(pre.body.eligible, 0);
  });

  // ====================================================================
  // 13. lib/last-touched.js: the new "could not be checked" list
  // ====================================================================

  const auditSeed = (ids, extra = {}) => ids.map((id, i) => ({
    id: uuid(9000 + i), action: 'x', entity_type: 'complaint', entity_id: id, performed_by: null, actor_type: 'human', actor_id: 'a@b.test',
    privacy_category: 'processing', risk_level: 'low', property_id: null, details: {}, created_at: iso(NOW - (i + 1) * DAY), sequence_num: i + 1, ...extra,
  }));

  asyncTest('last-touched — options.unverified lists exactly the ids that could not be checked: a failed batch, but not an id with a real row or an id with no history in a batch read to the end', async () => {
    const ids = Array.from({ length: 6 }, (_, i) => uuid(100 + i));
    const rows = auditSeed(ids.slice(0, 3)); // ids 3..5 have no history at all
    const db = makeDb({ audit: rows }, { fail: (q) => (q.filters.some((f) => f.kind === 'in' && f.val.includes(ids[4])) ? { message: 'boom' } : null) });
    const unverified = new Set();
    const { value: found } = await quiet(() => findLatestAuditRows(db.client, ids, { chunkSize: 2, unverified }));
    assert.deepStrictEqual([...found.keys()].sort(), ids.slice(0, 3).sort());
    // chunks: [0,1] ok (rows), [2,3] ok (2 has a row, 3 has none), [4,5] failed
    assert.deepStrictEqual([...unverified].sort(), [ids[4], ids[5]].sort());
  });

  asyncTest('last-touched — options.unverified: an id the page limit never reached is unverified; one that was found is not; with no option nothing changes', async () => {
    const ids = [uuid(200), uuid(201), uuid(202)];
    const rows = [
      ...auditSeed([ids[0]]).map((r) => ({ ...r, created_at: iso(NOW - 1 * DAY), sequence_num: 1 })),
      ...auditSeed([ids[0]]).map((r, i) => ({ ...r, id: uuid(9100 + i), created_at: iso(NOW - 2 * DAY), sequence_num: 2 })),
      ...auditSeed([ids[1]]).map((r, i) => ({ ...r, id: uuid(9200 + i), created_at: iso(NOW - 3 * DAY), sequence_num: 3 })),
    ];
    const db = makeDb({ audit: rows });
    const unverified = new Set();
    const found = await findLatestAuditRows(db.client, ids, { chunkSize: 10, pageSize: 2, maxPages: 1, unverified });
    // one page of 2 rows: both belong to ids[0] and ids[1]/ids[2] were never reached
    assert.deepStrictEqual([...found.keys()], [ids[0]]);
    assert.deepStrictEqual([...unverified].sort(), [ids[1], ids[2]].sort());
    const plain = await findLatestAuditRows(db.client, ids, { chunkSize: 10, pageSize: 2, maxPages: 1 });
    assert.deepStrictEqual([...plain.keys()], [ids[0]]);
    const none = await findLatestAuditRows(db.client, [], { unverified: new Set() });
    assert.strictEqual(none.size, 0);
  });

  asyncTest('last-touched — options.unverified: a batch still running when the time limit passes is unverified; batches that finished are not', async () => {
    const ids = Array.from({ length: 4 }, (_, i) => uuid(300 + i));
    const db = makeDb({ audit: auditSeed(ids) }, { delay: (q) => (q.filters.some((f) => f.kind === 'in' && f.val.includes(ids[3])) ? 400 : 0) });
    const unverified = new Set();
    const { value: found } = await quiet(() => findLatestAuditRows(db.client, ids, { chunkSize: 2, overallTimeoutMs: 60, unverified }));
    assert.deepStrictEqual([...found.keys()].sort(), [ids[0], ids[1]].sort());
    assert.deepStrictEqual([...unverified].sort(), [ids[2], ids[3]].sort());
    await new Promise((r) => setTimeout(r, 450)); // let the slow request finish: it must not change the result
    assert.deepStrictEqual([...unverified].sort(), [ids[2], ids[3]].sort());
    assert.deepStrictEqual([...found.keys()].sort(), [ids[0], ids[1]].sort(), 'a late answer must not be added to the result after the limit passed');
  });

  asyncTest('last-touched — options.excludeActions: rows with those actions are left out, so the newest row that is not one of them is returned; an id with nothing else has no history (and counts as checked, not "unverified")', async () => {
    const [a, b, c] = [uuid(400), uuid(401), uuid(402)];
    const mk = (id, action, days, i) => ({ ...auditSeed([id])[0], id: uuid(9400 + i), action, created_at: iso(NOW - days * DAY), sequence_num: 100 + i });
    const rows = [
      mk(a, 'complaint_tracking.stage_changed', 10, 1), mk(a, bulk.ACTIONS.itemClosed, 2, 2), mk(a, bulk.ACTIONS.itemReopened, 1, 3),
      mk(b, bulk.ACTIONS.itemClosed, 2, 4), mk(b, bulk.ACTIONS.itemReopened, 1, 5),
      mk(c, 'complaint_tracking.delegated', 5, 6),
    ];
    const db = makeDb({ audit: rows });
    const unverified = new Set();
    const found = await findLatestAuditRows(db.client, [a, b, c], { chunkSize: 10, unverified, excludeActions: bulk.OWN_ITEM_ACTIONS });
    assert.strictEqual(found.get(a).created_at, iso(NOW - 10 * DAY), 'the person\'s real action, not the bulk rows after it');
    assert.ok(!found.has(b), 'only bulk rows: no history');
    assert.strictEqual(found.get(c).created_at, iso(NOW - 5 * DAY));
    assert.deepStrictEqual([...unverified], [], 'a complaint with only excluded rows was checked, not left unverified');
    const notFilter = db.state.calls.flatMap((q) => q.filters).find((f) => f.kind === 'not');
    assert.deepStrictEqual([notFilter.col, notFilter.op, notFilter.val], ['action', 'in', bulk.OWN_ITEM_ACTIONS]);
    // without the option nothing changes
    const plain = await findLatestAuditRows(db.client, [a, b, c], { chunkSize: 10 });
    assert.strictEqual(plain.get(a).created_at, iso(NOW - 1 * DAY));
    assert.ok(plain.has(b));
    assert.ok(!db.state.calls.slice(-1)[0].filters.some((f) => f.kind === 'not'));
  });

  asyncTest('last-touched — options.excludeActions: only plain action names are sent; anything else is dropped, and an empty or odd list adds no filter', async () => {
    const id = uuid(410);
    const db = makeDb({ audit: auditSeed([id]) });
    await findLatestAuditRows(db.client, [id], { excludeActions: ['x"); drop table audit_log; --', 5, null, '', 'a b', 'ok.action_1'] });
    const sent = db.state.calls.flatMap((q) => q.filters).find((f) => f.kind === 'not');
    assert.deepStrictEqual(sent.val, ['ok.action_1']);
    for (const odd of [[], 'complaint_tracking.bulk_closed', null, {}, [5, null, '']]) {
      const db2 = makeDb({ audit: auditSeed([id]) });
      await findLatestAuditRows(db2.client, [id], { excludeActions: odd });
      assert.ok(!db2.state.calls.flatMap((q) => q.filters).some((f) => f.kind === 'not'), JSON.stringify(odd));
    }
  });
}

// The fixtures other bulk-close test files build on (test/bulk-close-hardening-tests.js, test/bulk-close-contract-tests.js).
module.exports = {
  register,
  fixtures: {
    DAY, NOW, uuid, iso, ACTOR, PERFORMED_BY, MARKER, complaint, world, service, closeBody, seqIds, mixedWorld, ELIGIBLE_MIXED, mixedBody,
    quiet, withRouter, runRoute, reqOf, ROUTES, extractFunction, guardsOf,
  },
};
