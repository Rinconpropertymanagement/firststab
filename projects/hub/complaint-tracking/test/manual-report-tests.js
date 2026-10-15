'use strict';

/**
 * test/manual-report-tests.js
 * Tests for the hand-entered "Report an issue" route (POST
 * /api/complaint-tracking/report): every staff-typed report is assigned to
 * the Director of Operations and flagged needs_human_call so it lands in the
 * Needs a Call lane. Registered into the shared runner by test/run-tests.js.
 * Uses only fake Supabase clients and made-up ids and text; touches no real
 * database, network, email or complaint.
 *
 * The fake client answers the handful of tables this route touches and
 * records every complaints insert and every audit_log insert, so the tests
 * can look at exactly what would have been written.
 */

const assert = require('assert');
const path = require('path');

// ─── Made-up fixtures ────────────────────────────────────────────────────

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const REPORTER_ID = uuid(101);
const DO_ID = uuid(201);
const OTHER_DO_ID = uuid(202);
const PROPERTY_ID = uuid(301);
const CONFIG_ID = uuid(401);
const NEW_COMPLAINT_ID = uuid(501);
const USER_ID = uuid(601);

const PLAIN_TEXT = 'The front gate at this building has been stuck open for two weeks and nobody has called back about it.';
// 'racist' is an immediate-flag keyword (no AI call), so this stays offline.
const FLAGGED_TEXT = 'A tenant says a neighbor made a racist comment in the hallway and wants someone to look into it.';

const DO_ROLE_ROWS = [{ team_member_id: DO_ID }];

// ─── Fake Supabase client ────────────────────────────────────────────────

function makeReportClient({
  roleRows = DO_ROLE_ROWS,
  members = [{ id: DO_ID, is_active: true }],
  roleError = null,
  throwOnRoleLookup = false,
  insertError = null,
} = {}) {
  const state = { complaintInserts: [], auditInserts: [], tables: [] };

  function chainFor(table) {
    let op = 'select';
    let payload = null;
    let inIds = null;

    const singleResult = () => {
      if (table === 'complaints' && op === 'insert') {
        return insertError
          ? { data: null, error: { message: insertError } }
          : { data: { ...payload, id: NEW_COMPLAINT_ID }, error: null };
      }
      if (table === 'complaint_tracking_config') return { data: { id: CONFIG_ID, duplicate_window_days: 3 }, error: null };
      if (table === 'properties') return { data: { id: PROPERTY_ID }, error: null };
      if (table === 'users') return { data: { id: USER_ID }, error: null };
      return { data: null, error: null };
    };

    const chain = {
      select() { return chain; },
      eq() { return chain; },
      or() { return chain; },
      order() { return chain; },
      limit() { return chain; },
      in(col, ids) { inIds = ids; return chain; },
      insert(p) {
        op = 'insert';
        payload = p;
        if (table === 'complaints') state.complaintInserts.push(p);
        if (table === 'audit_log') state.auditInserts.push(p);
        return chain;
      },
      maybeSingle() { return Promise.resolve(singleResult()); },
      single() { return Promise.resolve(singleResult()); },
      then(resolve, reject) {
        let result = { data: [], error: null };
        if (table === 'team_member_tool_roles') {
          result = roleError ? { data: null, error: { message: roleError } } : { data: roleRows, error: null };
        } else if (table === 'team_members') {
          result = { data: members.filter((m) => !inIds || inIds.includes(m.id)), error: null };
        } else if (table === 'audit_log') {
          result = { data: null, error: null };
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }

  return {
    client: {
      from(table) {
        state.tables.push(table);
        if (throwOnRoleLookup && table === 'team_member_tool_roles') throw new Error('simulated lookup crash');
        return chainFor(table);
      },
    },
    state,
  };
}

// Silences and records console.error for the duration of one call.
async function withQuietErrors(fn) {
  const original = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args.join(' ')); };
  try { return { value: await fn(), logged }; } finally { console.error = original; }
}

const reportReq = (body, teamMemberId = REPORTER_ID) => ({
  body, user: { email: 'reporter@rinconmanagement.com' }, teamMemberId, complaintTrackingRole: null,
});

// Same fake-module swap callRouterHandler does, for the one email-path check
// below that needs archive-search/lib/significance-pass.js to pick up a fake
// client. Restores every cache entry it touched.
async function withFreshModules(fakeClient, modulePaths, fn) {
  const supabasePath = require.resolve('@supabase/supabase-js', { paths: [path.dirname(modulePaths[0])] });
  const saved = new Map();
  for (const p of [supabasePath, ...modulePaths]) saved.set(p, { had: Object.prototype.hasOwnProperty.call(require.cache, p), mod: require.cache[p] });
  require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { createClient: () => fakeClient } };
  for (const p of modulePaths) delete require.cache[p];
  try { return await fn(); } finally {
    for (const [p, s] of saved) { if (s.had) require.cache[p] = s.mod; else delete require.cache[p]; }
  }
}

// ─── Registration ────────────────────────────────────────────────────────

function register({ asyncTest, callRouterHandler }) {
  const post = (fake, body, teamMemberId) => withQuietErrors(() => callRouterHandler({
    fakeClient: fake.client, method: 'post', routePath: '/api/complaint-tracking/report', req: reportReq(body, teamMemberId),
  }));

  const onlyInsert = (fake) => {
    assert.strictEqual(fake.state.complaintInserts.length, 1, 'expected exactly one complaints insert');
    return fake.state.complaintInserts[0];
  };
  const createdAudit = (fake) => {
    const rows = fake.state.auditInserts.filter((r) => r.action === 'complaint_tracking.created');
    assert.strictEqual(rows.length, 1, 'expected exactly one complaint_tracking.created audit row');
    return rows[0];
  };

  asyncTest('manual report — one active Director of Operations: saved with the DO as owner, needs_human_call true, manual_staff, never held, no severity fields; submit succeeds', async () => {
    const fake = makeReportClient();
    const { value: result } = await post(fake, { description: PLAIN_TEXT, property_id: PROPERTY_ID, category: null });

    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.success, true);
    assert.strictEqual(result.body.id, NEW_COMPLAINT_ID);

    const row = onlyInsert(fake);
    assert.strictEqual(row.owner_team_member_id, DO_ID);
    assert.strictEqual(row.needs_human_call, true);
    assert.strictEqual(row.held_legal_fair_housing, false);
    assert.strictEqual(row.source, 'manual_staff');
    assert.strictEqual(row.discovery_context, 'manual_staff');
    assert.strictEqual(row.status, 'open');
    assert.strictEqual(row.category, null);
    assert.strictEqual(row.reported_by_team_member_id, REPORTER_ID);
    assert.strictEqual(row.property_id, PROPERTY_ID);
    assert.strictEqual(row.flagged_protected_class, false);
    assert.deepStrictEqual(Object.keys(row).filter((k) => k.startsWith('severity_')), [], 'a manual report is never written with a severity rating');
    assert.strictEqual(row.severity_tier, undefined);
  });

  asyncTest('manual report — audit: still exactly one complaint_tracking.created row (no new audit action), now saying the assignment was automatic and why', async () => {
    const fake = makeReportClient();
    await post(fake, { description: PLAIN_TEXT, property_id: PROPERTY_ID });

    assert.deepStrictEqual(fake.state.auditInserts.map((r) => r.action), ['complaint_tracking.created']);
    const audit = createdAudit(fake);
    assert.strictEqual(audit.entity_id, NEW_COMPLAINT_ID);
    assert.strictEqual(audit.actor_type, 'human', 'the reporter stays the actor, so "last touched by" still names the reporter');
    assert.strictEqual(audit.actor_id, 'reporter@rinconmanagement.com');
    assert.strictEqual(audit.details.owner_team_member_id, DO_ID);
    assert.strictEqual(audit.details.auto_assigned_to_director_of_operations, true);
    assert.strictEqual(audit.details.assignment_rule, 'staff_report_always_to_director_of_operations');
    assert.strictEqual(audit.details.needs_human_call_set_by_rule, true);
    assert.strictEqual(audit.details.reported_by_team_member_id, REPORTER_ID);
    assert.strictEqual(audit.details.category, null);
    assert.match(audit.details.reason, /^Automatically assigned to the Director of Operations and placed in Needs a Call because a staff member typed this report in\. No AI made this assignment\.$/);
    assert.ok(!audit.details.reason.includes(PLAIN_TEXT), 'the audit note never repeats the complaint text');
  });

  asyncTest('manual report — no Director of Operations at all: still saved and successful, owner left empty, still needs_human_call true, audit says it could not assign; log line has no complaint text and no ids', async () => {
    const fake = makeReportClient({ roleRows: [], members: [] });
    const { value: result, logged } = await post(fake, { description: PLAIN_TEXT, property_id: PROPERTY_ID });

    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.success, true);
    const row = onlyInsert(fake);
    assert.ok(row.owner_team_member_id == null, 'expected no owner');
    assert.strictEqual(row.needs_human_call, true, 'still lands in Needs a Call without an owner');
    assert.strictEqual(row.held_legal_fair_housing, false);

    const audit = createdAudit(fake);
    assert.strictEqual(audit.details.owner_team_member_id, null);
    assert.strictEqual(audit.details.auto_assigned_to_director_of_operations, false);
    assert.strictEqual(audit.details.needs_human_call_set_by_rule, true);
    assert.match(audit.details.reason, /Could not assign automatically \(no single active Director of Operations found\); left unassigned but still in Needs a Call/);

    assert.ok(logged.length >= 1, 'expected a short log line saying why there is no owner');
    for (const line of logged) {
      assert.ok(!line.includes(PLAIN_TEXT.slice(0, 30)), 'log line must not carry complaint text');
      assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(line), 'log line must not carry ids');
    }
  });

  asyncTest('manual report — two active Directors of Operations: never guesses, saved with no owner, still needs_human_call true, still succeeds', async () => {
    const fake = makeReportClient({
      roleRows: [{ team_member_id: DO_ID }, { team_member_id: OTHER_DO_ID }],
      members: [{ id: DO_ID, is_active: true }, { id: OTHER_DO_ID, is_active: true }],
    });
    const { value: result } = await post(fake, { description: PLAIN_TEXT });

    assert.strictEqual(result.statusCode, 200);
    const row = onlyInsert(fake);
    assert.ok(row.owner_team_member_id == null);
    assert.strictEqual(row.needs_human_call, true);
    assert.strictEqual(createdAudit(fake).details.auto_assigned_to_director_of_operations, false);
  });

  asyncTest('manual report — two people hold the role but only one is still active: that one is the owner (same rule the email path uses)', async () => {
    const fake = makeReportClient({
      roleRows: [{ team_member_id: DO_ID }, { team_member_id: OTHER_DO_ID }],
      members: [{ id: DO_ID, is_active: true }, { id: OTHER_DO_ID, is_active: false }],
    });
    await post(fake, { description: PLAIN_TEXT });
    assert.strictEqual(onlyInsert(fake).owner_team_member_id, DO_ID);
  });

  asyncTest('manual report — the role lookup returns a database error: report still saved and successful, no owner, still needs_human_call true', async () => {
    const fake = makeReportClient({ roleError: 'simulated role lookup failure' });
    const { value: result, logged } = await post(fake, { description: PLAIN_TEXT, property_id: PROPERTY_ID });

    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.success, true);
    const row = onlyInsert(fake);
    assert.ok(row.owner_team_member_id == null);
    assert.strictEqual(row.needs_human_call, true);
    assert.strictEqual(createdAudit(fake).details.auto_assigned_to_director_of_operations, false);
    for (const line of logged) assert.ok(!line.includes(PLAIN_TEXT.slice(0, 30)));
  });

  asyncTest('manual report — the lookup itself crashes (throws): caught, report still saved and successful, no owner, still needs_human_call true', async () => {
    const fake = makeReportClient({ throwOnRoleLookup: true });
    const { value: result, logged } = await post(fake, { description: PLAIN_TEXT, property_id: PROPERTY_ID });

    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.success, true);
    assert.strictEqual(result.body.id, NEW_COMPLAINT_ID);
    const row = onlyInsert(fake);
    assert.ok(row.owner_team_member_id == null);
    assert.strictEqual(row.needs_human_call, true);
    assert.strictEqual(createdAudit(fake).details.auto_assigned_to_director_of_operations, false);
    assert.ok(logged.some((l) => l.includes('lookup threw')), 'expected the crash to be logged');
    for (const line of logged) assert.ok(!line.includes(PLAIN_TEXT.slice(0, 30)));
  });

  asyncTest('manual report — the reporter is the Director of Operations: no special case, he is the owner of his own report', async () => {
    const fake = makeReportClient();
    const { value: result } = await post(fake, { description: PLAIN_TEXT, property_id: PROPERTY_ID }, DO_ID);

    assert.strictEqual(result.statusCode, 200);
    const row = onlyInsert(fake);
    assert.strictEqual(row.owner_team_member_id, DO_ID);
    assert.strictEqual(row.reported_by_team_member_id, DO_ID);
    assert.strictEqual(row.needs_human_call, true);
  });

  asyncTest('manual report — a legacy valid category is still accepted and kept; owner and needs_human_call same as without one', async () => {
    const { TOPIC_CATEGORIES } = require('../../archive-search/lib/significance-pass');
    const category = TOPIC_CATEGORIES.find((c) => c !== 'other');
    const fake = makeReportClient();
    const { value: result } = await post(fake, { description: PLAIN_TEXT, property_id: PROPERTY_ID, category });

    assert.strictEqual(result.statusCode, 200);
    const row = onlyInsert(fake);
    assert.strictEqual(row.category, category);
    assert.strictEqual(row.owner_team_member_id, DO_ID);
    assert.strictEqual(row.needs_human_call, true);
    assert.strictEqual(createdAudit(fake).details.category, category);
  });

  asyncTest('manual report — an unknown category is still refused with a 400 and nothing is written or looked up', async () => {
    const fake = makeReportClient();
    const { value: result } = await post(fake, { description: PLAIN_TEXT, category: 'not_a_real_category' });

    assert.strictEqual(result.statusCode, 400);
    assert.strictEqual(fake.state.complaintInserts.length, 0);
    assert.strictEqual(fake.state.auditInserts.length, 0);
    assert.ok(!fake.state.tables.includes('team_member_tool_roles'), 'no DO lookup for a rejected request');
  });

  asyncTest('manual report — a blank description is still refused with a 400 and nothing is written', async () => {
    const fake = makeReportClient();
    const { value: result } = await post(fake, { description: '   ' });
    assert.strictEqual(result.statusCode, 400);
    assert.strictEqual(fake.state.complaintInserts.length, 0);
  });

  asyncTest('manual report — a Fair Housing keyword changes nothing about routing: same owner, same needs_human_call, never held; the flag and its own audit row are still written', async () => {
    const plain = makeReportClient();
    await post(plain, { description: PLAIN_TEXT, property_id: PROPERTY_ID });
    const flagged = makeReportClient();
    const { value: result } = await post(flagged, { description: FLAGGED_TEXT, property_id: PROPERTY_ID });

    assert.strictEqual(result.statusCode, 200);
    const plainRow = onlyInsert(plain);
    const flaggedRow = onlyInsert(flagged);
    assert.strictEqual(flaggedRow.flagged_protected_class, true, 'the keyword check still flags it');
    assert.ok(flaggedRow.flagged_category);
    assert.strictEqual(flaggedRow.owner_team_member_id, DO_ID);
    assert.strictEqual(flaggedRow.needs_human_call, true);
    assert.strictEqual(flaggedRow.held_legal_fair_housing, false);

    // Everything except the text itself and the flag fields is identical.
    const strip = (r) => { const c = { ...r }; delete c.description; delete c.flagged_protected_class; delete c.flagged_category; return c; };
    assert.deepStrictEqual(strip(flaggedRow), strip(plainRow));

    const actions = flagged.state.auditInserts.map((r) => r.action).sort();
    assert.deepStrictEqual(actions, ['complaint_tracking.created', 'complaint_tracking.protected_class_flagged']);
    const created = createdAudit(flagged);
    assert.ok(!JSON.stringify(created.details).includes('racist'), 'the created audit row never carries the matched term');
    assert.strictEqual(created.details.auto_assigned_to_director_of_operations, true);
  });

  asyncTest('manual report — a failed insert still returns 500 with no audit row (unchanged behaviour)', async () => {
    const fake = makeReportClient({ insertError: 'simulated insert failure' });
    const { value: result } = await post(fake, { description: PLAIN_TEXT, property_id: PROPERTY_ID });

    assert.strictEqual(result.statusCode, 500);
    assert.strictEqual(fake.state.auditInserts.length, 0);
  });

  asyncTest('manual report — nothing is sent: the only tables the route touches are the ones it always did plus the role lookup (no email, text or notification tables)', async () => {
    const fake = makeReportClient();
    await post(fake, { description: PLAIN_TEXT, property_id: PROPERTY_ID });
    const allowed = new Set([
      'properties', 'complaint_tracking_config', 'complaints', 'audit_log', 'users', 'team_member_tool_roles', 'team_members',
    ]);
    for (const t of new Set(fake.state.tables)) assert.ok(allowed.has(t), `unexpected table touched: ${t}`);
  });

  // The DO-lookup module keeps its own client in a module-level variable.
  // This leaves such a stale client behind (one that sees no DO at all) and
  // checks the test runner does not let the next report reuse it.
  asyncTest('manual report — a stale DO-lookup client left in the module cache by an earlier test is not reused', async () => {
    const pendingPath = require.resolve('../lib/process-pending-messages.js');
    const supabasePath = require.resolve('@supabase/supabase-js', { paths: [path.dirname(pendingPath)] });
    const had = { pending: Object.prototype.hasOwnProperty.call(require.cache, pendingPath), supabase: Object.prototype.hasOwnProperty.call(require.cache, supabasePath) };
    const saved = { pending: require.cache[pendingPath], supabase: require.cache[supabasePath] };
    try {
      const stale = makeReportClient({ roleRows: [], members: [] });
      require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { createClient: () => stale.client } };
      delete require.cache[pendingPath];
      const primed = await require(pendingPath).lookupSingleDirectorOfOperations();
      assert.strictEqual(primed.ok, false, 'setup: the stale client sees no DO');
      // Put the real supabase module entry back but leave the primed module cached on purpose.
      if (had.supabase) require.cache[supabasePath] = saved.supabase; else delete require.cache[supabasePath];

      const fake = makeReportClient();
      const { value: result } = await post(fake, { description: PLAIN_TEXT, property_id: PROPERTY_ID });
      assert.strictEqual(result.statusCode, 200);
      assert.strictEqual(onlyInsert(fake).owner_team_member_id, DO_ID, 'the report must use its own fake client, not the stale one');
    } finally {
      if (had.pending) require.cache[pendingPath] = saved.pending; else delete require.cache[pendingPath];
      if (had.supabase) require.cache[supabasePath] = saved.supabase; else delete require.cache[supabasePath];
    }
  });

  // ─── Email-driven complaints are not touched ───────────────────────────

  asyncTest('email-driven complaint — unchanged: live mail still gets the DO as owner and keeps its own needs_human_call; a failed DO lookup still sets needs_human_call; a historical row still gets no owner', async () => {
    const sigPath = require.resolve('../../archive-search/lib/significance-pass.js');
    const pendingPath = require.resolve('../lib/process-pending-messages.js');

    const run = async (fakeOpts, discoveryContext, needsHumanCall) => {
      const fake = makeReportClient(fakeOpts);
      let inserted;
      await withQuietErrors(() => withFreshModules(fake.client, [sigPath, pendingPath], async () => {
        const { createComplaintRow } = require(sigPath);
        await createComplaintRow({
          mailbox_key: 'team:test', missive_conversation_id: 'conv-test-1', discoveryContext,
          category: 'dispute', why: 'A made-up summary of a made-up email thread.',
          call2Fields: { escalation_signal: 'none', needs_human_call: needsHumanCall, blocked_reason: null, blocked_party: null, owner_instruction_rejected: null, owner_instruction_note_text: null },
          keywordCheck: { flagged_protected_class: false, flagged_category: null },
          property_id: PROPERTY_ID, vendor_id: null, addressMatch: {}, blockedSinceIso: null,
        });
        inserted = fake.state.complaintInserts[0];
      }));
      return inserted;
    };

    const live = await run({}, 'live_pipeline', false);
    assert.strictEqual(live.source, 'email_ai');
    assert.strictEqual(live.owner_team_member_id, DO_ID);
    assert.strictEqual(live.needs_human_call, false, 'live email row keeps the AI\'s own flag when the DO is found');

    const liveNoDo = await run({ roleRows: [], members: [] }, 'live_pipeline', false);
    assert.ok(liveNoDo.owner_team_member_id == null);
    assert.strictEqual(liveNoDo.needs_human_call, true, 'live email row with no single DO is still flagged for a human');

    const historical = await run({}, 'historical_backfill', false);
    assert.ok(historical.owner_team_member_id == null, 'a historical row never gets a DO owner');
    assert.strictEqual(historical.needs_human_call, false);
  });
}

module.exports = { register };
