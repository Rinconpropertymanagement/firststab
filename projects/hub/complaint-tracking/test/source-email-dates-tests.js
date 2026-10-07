'use strict';

/**
 * test/source-email-dates-tests.js
 * Tests for lib/source-email-dates.js and for the two list endpoints that
 * use it (GET /api/complaint-tracking, GET .../property/:property_id).
 * Registered into the shared runner by test/run-tests.js — see the
 * register() call there. Uses only fake Supabase clients and made-up ids;
 * touches no real database, network or email content.
 */

const assert = require('assert');
const { createSourceEmailDates, SELECT_COLUMNS } = require('../lib/source-email-dates');

// ─── Fakes ───────────────────────────────────────────────────────────────

// Fake client that answers missive_message_intake lookups and records every
// call. `serverRowCap` mimics PostgREST's per-request row limit.
function makeIntakeClient({ rows = [], error = null, throwOnCall = false, hang = false, serverRowCap = 1000 } = {}) {
  const calls = [];
  const client = {
    from(table) {
      const call = { table, columns: null, inColumn: null, ids: null };
      calls.push(call);
      if (throwOnCall) throw new Error('boom');
      const chain = {
        select(columns) { call.columns = columns; return chain; },
        in(col, ids) { call.inColumn = col; call.ids = ids; return chain; },
        then(resolve, reject) {
          if (hang) return new Promise(() => {}).then(resolve, reject);
          const failure = typeof error === 'function' ? error(call) : error;
          if (failure) return Promise.resolve({ data: null, error: { message: failure } }).then(resolve, reject);
          const matched = rows.filter((r) => call.ids.includes(r.missive_conversation_id)).slice(0, serverRowCap);
          return Promise.resolve({ data: matched, error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
  return { client, calls };
}

const msg = (conversation, deliveredAt) => ({ missive_conversation_id: conversation, delivered_at: deliveredAt });
const manyIds = (n, prefix = 'conv') => Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`);

// Silences the helper's own error logging inside a test, restores after.
async function quiet(fn) {
  const original = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args.join(' ')); };
  try { return { result: await fn(), logged }; } finally { console.error = original; }
}

// Fake client for the two list endpoints. Every table the list code touches
// answers with empty data except complaints and missive_message_intake.
function makeListClient({ complaints, intakeRows = [], intakeError = null }) {
  const intake = makeIntakeClient({ rows: intakeRows, error: intakeError });
  const orders = [];
  const client = {
    from(table) {
      if (table === 'missive_message_intake') return intake.client.from(table);
      let rangeArgs = null;
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        or() { return chain; },
        ilike() { return chain; },
        in() { return chain; },
        order(col, opts) { orders.push({ table, col, ascending: opts && opts.ascending }); return chain; },
        range(from, to) { rangeArgs = [from, to]; return chain; },
        then(resolve, reject) {
          const isComplaintList = table === 'complaints' || table === 'complaints_needing_attention';
          const data = isComplaintList ? complaints.slice(rangeArgs ? rangeArgs[0] : 0, rangeArgs ? rangeArgs[1] + 1 : undefined) : [];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
  return { client, intakeCalls: intake.calls, orders };
}

// ─── Registration ────────────────────────────────────────────────────────

function register({ test, asyncTest: runnerAsyncTest, callRouterHandler }) {
  // The shared runner starts every async test the moment it is registered,
  // all at once. These tests swap console.error and the module cache, so
  // they are queued to run one after another instead.
  let queue = Promise.resolve();
  const asyncTest = (name, fn) => runnerAsyncTest(name, () => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  });
  // --- batching / chunking -------------------------------------------------

  asyncTest('source-email-dates — 200 conversation ids are looked up in chunks of 80 (80, 80, 40), each against missive_message_intake by missive_conversation_id', async () => {
    const { client, calls } = makeIntakeClient({ rows: [] });
    const helper = createSourceEmailDates({ supabase: client });
    const out = await helper.lookup(manyIds(200));
    assert.deepStrictEqual(calls.map((c) => c.ids.length).sort((a, b) => b - a), [80, 80, 40]);
    for (const c of calls) {
      assert.strictEqual(c.table, 'missive_message_intake');
      assert.strictEqual(c.inColumn, 'missive_conversation_id');
    }
    assert.strictEqual(out.size, 200);
  });

  asyncTest('source-email-dates — duplicate, empty and non-string conversation ids are collapsed: each real id is queried exactly once', async () => {
    const { client, calls } = makeIntakeClient({ rows: [msg('a', '2025-03-03T10:00:00Z')] });
    const helper = createSourceEmailDates({ supabase: client });
    const out = await helper.lookup(['a', 'a', 'b', 'a', 'b', '', null, undefined, 42]);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual([...calls[0].ids].sort(), ['a', 'b']);
    assert.deepStrictEqual([...out.keys()].sort(), ['a', 'b']);
  });

  asyncTest('source-email-dates — no ids at all makes no query', async () => {
    const { client, calls } = makeIntakeClient();
    const helper = createSourceEmailDates({ supabase: client });
    const out = await helper.lookup([null, undefined, '']);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(out.size, 0);
  });

  // --- first / last ---------------------------------------------------------

  asyncTest('source-email-dates — first and last are the earliest and latest message in the thread, whatever order the rows arrive in; null and unreadable dates are ignored; output is ISO', async () => {
    const rows = [
      msg('thread-1', '2025-03-05T09:00:00+00:00'),
      msg('thread-1', '2024-11-20T15:30:00+00:00'),
      msg('thread-1', null),
      msg('thread-1', 'not a date'),
      msg('thread-1', '2025-01-02T00:00:00+00:00'),
      msg('thread-2', '2026-02-02T12:00:00+00:00'), // single-message thread
      msg('thread-3', null), // only an undated message
      msg('other-thread', '2020-01-01T00:00:00+00:00'), // not asked for
    ];
    const { client } = makeIntakeClient({ rows });
    const helper = createSourceEmailDates({ supabase: client });
    const out = await helper.lookup(['thread-1', 'thread-2', 'thread-3', 'thread-4']);
    assert.deepStrictEqual(out.get('thread-1'), { first: '2024-11-20T15:30:00.000Z', last: '2025-03-05T09:00:00.000Z' });
    assert.deepStrictEqual(out.get('thread-2'), { first: '2026-02-02T12:00:00.000Z', last: '2026-02-02T12:00:00.000Z' });
    assert.strictEqual(out.get('thread-3'), null, 'a thread with no dated message has no dates');
    assert.strictEqual(out.get('thread-4'), null, 'a thread with no rows at all has no dates');
    assert.ok(!out.has('other-thread'));
  });

  // --- attach(): manual complaints, existing fields untouched --------------

  asyncTest('source-email-dates — attach(): a complaint with a source thread gets both fields; a manual complaint (no source thread) gets null and is never queried; no other field changes', async () => {
    const { client, calls } = makeIntakeClient({
      rows: [msg('thread-1', '2025-03-03T10:00:00Z'), msg('thread-1', '2025-03-09T10:00:00Z')],
    });
    const helper = createSourceEmailDates({ supabase: client });
    const rows = [
      { id: 'c1', source_missive_conversation_id: 'thread-1', description: 'x', created_at: '2026-09-29T00:00:00Z', display: { keep: true } },
      { id: 'c2', source_missive_conversation_id: null, description: 'y', created_at: '2026-09-30T00:00:00Z' },
      { id: 'c3', description: 'z', created_at: '2026-09-30T00:00:00Z' }, // field missing entirely
    ];
    const returned = await helper.attach(rows);
    assert.strictEqual(returned, rows, 'attach returns the same array, mutated in place');
    assert.strictEqual(rows[0].source_email_first_at, '2025-03-03T10:00:00.000Z');
    assert.strictEqual(rows[0].source_email_last_at, '2025-03-09T10:00:00.000Z');
    assert.deepStrictEqual(rows[0].display, { keep: true });
    assert.strictEqual(rows[0].created_at, '2026-09-29T00:00:00Z');
    for (const r of [rows[1], rows[2]]) {
      assert.strictEqual(r.source_email_first_at, null);
      assert.strictEqual(r.source_email_last_at, null);
    }
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].ids, ['thread-1'], 'only the real source thread is queried');
  });

  asyncTest('source-email-dates — attach(): empty or missing input is returned as is, with no query', async () => {
    const { client, calls } = makeIntakeClient();
    const helper = createSourceEmailDates({ supabase: client });
    const empty = [];
    assert.strictEqual(await helper.attach(empty), empty);
    assert.strictEqual(await helper.attach(undefined), undefined);
    assert.strictEqual(calls.length, 0);
  });

  // --- fail soft ----------------------------------------------------------

  asyncTest('source-email-dates — fail soft: a Supabase error leaves every field null, attach() does not throw, and nothing is cached so the next call retries', async () => {
    let failing = true;
    const rows = [msg('thread-1', '2025-03-03T10:00:00Z')];
    const { client, calls } = makeIntakeClient({ rows, error: () => (failing ? 'statement timeout' : null) });
    const helper = createSourceEmailDates({ supabase: client });

    const complaints = [{ id: 'c1', source_missive_conversation_id: 'thread-1' }, { id: 'c2', source_missive_conversation_id: null }];
    const first = await quiet(() => helper.attach(complaints));
    assert.strictEqual(complaints[0].source_email_first_at, null);
    assert.strictEqual(complaints[0].source_email_last_at, null);
    assert.strictEqual(complaints[1].source_email_first_at, null);
    assert.ok(first.logged.length >= 1, 'the failure is logged');
    assert.ok(first.logged.every((l) => !l.includes('thread-1')), 'logs carry no conversation ids');

    failing = false;
    await helper.attach(complaints);
    assert.strictEqual(calls.length, 2, 'the failed lookup was not cached, so the second attach asked again');
    assert.strictEqual(complaints[0].source_email_first_at, '2025-03-03T10:00:00.000Z');
  });

  asyncTest('source-email-dates — fail soft: one failing chunk only blanks that chunk; the other chunk still gets its dates', async () => {
    const goodIds = manyIds(80, 'good');
    const badIds = manyIds(80, 'bad');
    const rows = goodIds.map((id) => msg(id, '2025-06-01T00:00:00Z'));
    const { client } = makeIntakeClient({ rows, error: (call) => (call.ids.includes('bad-1') ? 'connection reset' : null) });
    const helper = createSourceEmailDates({ supabase: client });
    const complaints = [...goodIds, ...badIds].map((id) => ({ id, source_missive_conversation_id: id }));
    await quiet(() => helper.attach(complaints));
    assert.strictEqual(complaints.filter((c) => c.source_email_first_at !== null).length, 80);
    assert.ok(complaints.filter((c) => c.id.startsWith('bad')).every((c) => c.source_email_first_at === null && c.source_email_last_at === null));
  });

  asyncTest('source-email-dates — fail soft: a client that throws outright does not break attach()', async () => {
    const { client } = makeIntakeClient({ throwOnCall: true });
    const helper = createSourceEmailDates({ supabase: client });
    const complaints = [{ id: 'c1', source_missive_conversation_id: 'thread-1' }];
    await quiet(() => helper.attach(complaints));
    assert.strictEqual(complaints[0].source_email_first_at, null);
    assert.strictEqual(complaints[0].source_email_last_at, null);
  });

  asyncTest('source-email-dates — fail soft: a lookup that never answers is abandoned at the overall timeout and the rows come back with null dates', async () => {
    const { client } = makeIntakeClient({ hang: true });
    const helper = createSourceEmailDates({ supabase: client, overallTimeoutMs: 40 });
    const complaints = [{ id: 'c1', source_missive_conversation_id: 'thread-1' }];
    const started = Date.now();
    const { logged } = await quiet(() => helper.attach(complaints));
    assert.ok(Date.now() - started < 1000, 'returned promptly instead of hanging');
    assert.strictEqual(complaints[0].source_email_first_at, null);
    assert.ok(logged.some((l) => l.includes('timed out')));
  });

  // --- cache ---------------------------------------------------------------

  asyncTest('source-email-dates — cache: a second lookup of the same ids inside the window makes no query; ids not yet cached are still fetched', async () => {
    const { client, calls } = makeIntakeClient({ rows: [msg('a', '2025-01-01T00:00:00Z'), msg('b', '2025-02-01T00:00:00Z')] });
    const helper = createSourceEmailDates({ supabase: client, now: () => 1000 });
    await helper.lookup(['a']);
    assert.strictEqual(calls.length, 1);
    const again = await helper.lookup(['a']);
    assert.strictEqual(calls.length, 1, 'cache hit');
    assert.strictEqual(again.get('a').first, '2025-01-01T00:00:00.000Z');
    await helper.lookup(['a', 'b']);
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[1].ids, ['b'], 'only the uncached id is asked for');
  });

  asyncTest('source-email-dates — cache: an entry expires after the time limit (5 minutes by default) and is looked up again', async () => {
    let clock = 1_000_000;
    const { client, calls } = makeIntakeClient({ rows: [msg('a', '2025-01-01T00:00:00Z')] });
    const helper = createSourceEmailDates({ supabase: client, now: () => clock });
    await helper.lookup(['a']);
    clock += 5 * 60 * 1000 - 1;
    await helper.lookup(['a']);
    assert.strictEqual(calls.length, 1, 'still fresh one millisecond before expiry');
    clock += 1;
    await helper.lookup(['a']);
    assert.strictEqual(calls.length, 2, 'expired exactly at the limit');
  });

  asyncTest('source-email-dates — cache: a thread with no dated messages is remembered too, so a missing thread is not re-asked on every load', async () => {
    const { client, calls } = makeIntakeClient({ rows: [] });
    const helper = createSourceEmailDates({ supabase: client, now: () => 5 });
    await helper.lookup(['ghost']);
    await helper.lookup(['ghost']);
    assert.strictEqual(calls.length, 1);
  });

  asyncTest('source-email-dates — cache: stays bounded (clears itself at maxCacheEntries) and clearCache() empties it', async () => {
    const { client } = makeIntakeClient({ rows: [] });
    const helper = createSourceEmailDates({ supabase: client, maxCacheEntries: 100 });
    await helper.lookup(manyIds(250));
    assert.ok(helper.cacheSize() <= 100, `cache grew to ${helper.cacheSize()}`);
    helper.clearCache();
    assert.strictEqual(helper.cacheSize(), 0);
  });

  // --- privacy: columns -------------------------------------------------------

  asyncTest('source-email-dates — never selects body, subject, address or any content column: every query asks for exactly missive_conversation_id and delivered_at', async () => {
    const { client, calls } = makeIntakeClient({ rows: [msg('a', '2025-01-01T00:00:00Z')] });
    const helper = createSourceEmailDates({ supabase: client });
    await helper.lookup(manyIds(170));
    assert.ok(calls.length >= 3);
    for (const c of calls) {
      assert.strictEqual(c.columns, 'missive_conversation_id, delivered_at');
      assert.ok(!/\*|body|subject|html|address|from|to_|cc|bcc|text/i.test(c.columns.replace('missive_conversation_id', '').replace('delivered_at', '')));
    }
    assert.strictEqual(SELECT_COLUMNS, 'missive_conversation_id, delivered_at');
  });

  // --- row cap ----------------------------------------------------------------

  asyncTest('source-email-dates — a chunk whose answer hits the 1000-row cap is split and retried, so busy threads still get correct first/last dates', async () => {
    // 80 threads x 13 messages = 1,040 rows: the first request is cut off at 1,000.
    const ids = manyIds(80, 'busy');
    const rows = [];
    ids.forEach((id, i) => {
      for (let m = 0; m < 13; m += 1) rows.push(msg(id, new Date(Date.UTC(2025, 0, 1 + m, i)).toISOString()));
    });
    const { client, calls } = makeIntakeClient({ rows, serverRowCap: 1000 });
    const helper = createSourceEmailDates({ supabase: client });
    const out = await helper.lookup(ids);
    assert.ok(calls.length > 1, 'the chunk was split');
    assert.strictEqual(out.size, 80);
    for (let i = 0; i < ids.length; i += 1) {
      assert.strictEqual(out.get(ids[i]).first, new Date(Date.UTC(2025, 0, 1, i)).toISOString());
      assert.strictEqual(out.get(ids[i]).last, new Date(Date.UTC(2025, 0, 13, i)).toISOString());
    }
  });

  asyncTest('source-email-dates — a single thread that alone fills the row cap is left without dates (never a possibly wrong one) and is not cached', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => msg('huge', new Date(Date.UTC(2025, 0, 1, 0, i)).toISOString()));
    rows.push(msg('normal', '2025-05-05T00:00:00Z'));
    const { client } = makeIntakeClient({ rows, serverRowCap: 1000 });
    const helper = createSourceEmailDates({ supabase: client });
    const { result: out } = await quiet(() => helper.lookup(['huge', 'normal']));
    assert.ok(!out.has('huge'));
    assert.strictEqual(out.get('normal').first, '2025-05-05T00:00:00.000Z');
    assert.strictEqual(helper.cacheSize(), 1, 'only the good thread is cached');
  });

  // --- list endpoints -----------------------------------------------------------

  const CT_PROPERTY_ID = '55555555-5555-5555-5555-555555555555';
  const listComplaints = () => [
    { id: 'c1', source_missive_conversation_id: 'thread-1', description: 'd1', created_at: '2026-09-30T05:00:00Z', status: 'open' },
    { id: 'c2', source_missive_conversation_id: null, description: 'd2', created_at: '2026-10-01T05:00:00Z', status: 'open' },
    { id: 'c3', source_missive_conversation_id: 'thread-missing', description: 'd3', created_at: '2026-09-29T05:00:00Z', status: 'open' },
  ];
  const listIntake = [msg('thread-1', '2022-04-04T08:00:00Z'), msg('thread-1', '2022-04-09T08:00:00Z')];

  asyncTest('router — GET /api/complaint-tracking: each complaint carries source_email_first_at / source_email_last_at (null for a manual report and for a thread with no dated mail); existing fields and the created_at ordering are unchanged', async () => {
    const { client, intakeCalls, orders } = makeListClient({ complaints: listComplaints(), intakeRows: listIntake });
    const result = await callRouterHandler({ fakeClient: client, method: 'get', routePath: '/api/complaint-tracking', req: { query: {} } });
    assert.strictEqual(result.statusCode, 200);
    const byId = Object.fromEntries(result.body.complaints.map((c) => [c.id, c]));
    assert.strictEqual(result.body.complaints.length, 3);
    assert.strictEqual(byId.c1.source_email_first_at, '2022-04-04T08:00:00.000Z');
    assert.strictEqual(byId.c1.source_email_last_at, '2022-04-09T08:00:00.000Z');
    assert.strictEqual(byId.c2.source_email_first_at, null);
    assert.strictEqual(byId.c2.source_email_last_at, null);
    assert.strictEqual(byId.c3.source_email_first_at, null);
    assert.strictEqual(byId.c3.source_email_last_at, null);
    for (const c of result.body.complaints) {
      assert.ok(c.display, 'display info still attached');
      assert.ok(Object.prototype.hasOwnProperty.call(c.display, 'missive_link'));
    }
    assert.strictEqual(byId.c1.description, 'd1');
    assert.strictEqual(byId.c1.created_at, '2026-09-30T05:00:00Z');
    assert.deepStrictEqual(orders.find((o) => o.table === 'complaints'), { table: 'complaints', col: 'created_at', ascending: false });
    assert.strictEqual(intakeCalls.length, 1);
    assert.deepStrictEqual([...intakeCalls[0].ids].sort(), ['thread-1', 'thread-missing']);
    assert.strictEqual(intakeCalls[0].columns, 'missive_conversation_id, delivered_at');
  });

  asyncTest('router — GET /api/complaint-tracking: if the email-date lookup fails the list still loads (200, every row present, dates null)', async () => {
    const { client } = makeListClient({ complaints: listComplaints(), intakeError: 'statement timeout' });
    const { result } = await quiet(() => callRouterHandler({ fakeClient: client, method: 'get', routePath: '/api/complaint-tracking', req: { query: {} } }));
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.complaints.length, 3);
    for (const c of result.body.complaints) {
      assert.strictEqual(c.source_email_first_at, null);
      assert.strictEqual(c.source_email_last_at, null);
      assert.ok(c.display);
    }
  });

  asyncTest('router — GET /api/complaint-tracking/property/:property_id: same two fields on the Property 360 list', async () => {
    const { client } = makeListClient({ complaints: listComplaints().slice(0, 2), intakeRows: listIntake });
    const result = await callRouterHandler({
      fakeClient: client, method: 'get', routePath: '/api/complaint-tracking/property/:property_id',
      req: { params: { property_id: CT_PROPERTY_ID }, query: {} },
    });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.complaints[0].source_email_first_at, '2022-04-04T08:00:00.000Z');
    assert.strictEqual(result.body.complaints[0].source_email_last_at, '2022-04-09T08:00:00.000Z');
    assert.strictEqual(result.body.complaints[1].source_email_first_at, null);
    assert.ok(result.body.complaints[0].display);
  });
}

module.exports = { register };
