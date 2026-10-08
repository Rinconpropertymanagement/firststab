'use strict';

/**
 * test/last-touched-tests.js
 * Tests for lib/last-touched.js and for the two list endpoints that show
 * "Last touched X ago by [name]" (GET /api/complaint-tracking and
 * GET .../property/:property_id). Registered into the shared runner by
 * test/run-tests.js. Uses only fake Supabase clients and made-up ids and
 * names; touches no real database, network or complaint text.
 *
 * The fake client behaves like the real service where it matters here:
 *  - it refuses (with "Bad Request") a request whose id list is too long for
 *    a web address, which is exactly what broke the list at ~1,000 ids;
 *  - it answers at most 1,000 rows per request;
 *  - it applies .eq / .in / .order / .range for real;
 *  - rows that tie on every ORDER BY column come back in an arbitrary order
 *    that differs from request to request (Postgres promises nothing there).
 */

const assert = require('assert');
const { findLatestAuditRows, SELECT_COLUMNS, DEFAULTS } = require('../lib/last-touched');

// ─── Fakes and builders ─────────────────────────────────────────────────

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const makeIds = (count, start = 1) => Array.from({ length: count }, (_, i) => uuid(start + i));
const at = (seconds) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-/i;

// Longest id list (in characters) a single request may carry. 16,000 is a
// typical web-address limit; the real failure happened at ~37,000.
const ID_LIST_LIMIT = 16000;

let seq = 0;
function audit(entityId, createdAt, by, extra = {}) {
  seq += 1;
  return {
    entity_type: 'complaint',
    entity_id: entityId,
    actor_type: 'human',
    actor_id: by,
    created_at: createdAt,
    sequence_num: seq,
    ...extra,
  };
}

function tieKey(rowIndex, callNo) {
  return (rowIndex * 2654435761 + callNo * 40503) % 1000003;
}

// Fake client answering audit_log lookups; records every request.
function makeAuditClient({ rows = [], serverRowCap = 1000, failWhen = null, rejectWhen = null, throwOnFrom = false, payload = null, delay = false } = {}) {
  const calls = [];
  const state = { inFlight: 0, maxInFlight: 0 };
  const client = {
    from(table) {
      if (throwOnFrom) throw new Error('boom');
      const call = { table, columns: null, entityType: null, inColumn: null, ids: null, orders: [], range: null };
      calls.push(call);
      const callNo = calls.length;
      const chain = {
        select(columns) { call.columns = columns; return chain; },
        eq(col, val) { if (col === 'entity_type') call.entityType = val; return chain; },
        in(col, ids) { call.inColumn = col; call.ids = ids; return chain; },
        order(col, opts) { call.orders.push({ col, ascending: !(opts && opts.ascending === false) }); return chain; },
        range(from, to) { call.range = [from, to]; return chain; },
        then(resolve, reject) {
          const run = async () => {
            state.inFlight += 1;
            state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
            try {
              if (delay) await new Promise((r) => setImmediate(r));
              if (rejectWhen && rejectWhen(call)) throw new Error('socket hang up');
              if (call.ids.join(',').length > ID_LIST_LIMIT) return { data: null, error: { message: 'Bad Request' } };
              const failure = failWhen ? failWhen(call) : null;
              if (failure) return { data: null, error: { message: failure } };
              if (typeof payload === 'function') return { data: payload(call), error: null };

              const wanted = new Set(call.ids);
              const matched = rows
                .map((r, i) => ({ r, i }))
                .filter(({ r }) => (call.entityType === null || r.entity_type === call.entityType) && wanted.has(r.entity_id));
              matched.sort((a, b) => {
                for (const o of call.orders) {
                  const av = a.r[o.col];
                  const bv = b.r[o.col];
                  if (av === bv) continue;
                  const c = av < bv ? -1 : 1;
                  return o.ascending ? c : -c;
                }
                return tieKey(a.i, callNo) - tieKey(b.i, callNo);
              });
              const [from, to] = call.range || [0, matched.length - 1];
              const page = matched.slice(from, Math.min(to + 1, from + serverRowCap));
              const cols = call.columns.split(',').map((c) => c.trim());
              return { data: page.map(({ r }) => Object.fromEntries(cols.map((c) => [c, r[c]]))), error: null };
            } finally {
              state.inFlight -= 1;
            }
          };
          return run().then(resolve, reject);
        },
      };
      return chain;
    },
  };
  return { client, calls, state };
}

// The newest row per complaint, worked out directly from the fixture rows.
function expectedNewest(rows) {
  const best = new Map();
  for (const r of rows) {
    if (r.entity_type !== 'complaint') continue;
    const cur = best.get(r.entity_id);
    if (!cur || r.created_at > cur.created_at || (r.created_at === cur.created_at && r.sequence_num > cur.sequence_num)) best.set(r.entity_id, r);
  }
  return best;
}

// Silences the error logging inside a test, restores after.
async function quiet(fn) {
  const original = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args.join(' ')); };
  try { return { result: await fn(), logged }; } finally { console.error = original; }
}

// Fake client for the list endpoints: complaints (paged like the real route
// reads them), audit_log (the fake above), team_members, and empty answers
// for every other table the list code touches.
function makeListClient({ complaints, auditRows = [], members = [], auditOptions = {} }) {
  const audit = makeAuditClient({ rows: auditRows, ...auditOptions });
  const memberCalls = [];
  const client = {
    from(table) {
      if (table === 'audit_log') return audit.client.from(table);
      let rangeArgs = null;
      let memberEmails = null;
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        or() { return chain; },
        ilike() { return chain; },
        in(col, list) { if (table === 'team_members' && col === 'email') { memberEmails = list; memberCalls.push(list); } return chain; },
        order() { return chain; },
        range(from, to) { rangeArgs = [from, to]; return chain; },
        then(resolve, reject) {
          let data = [];
          if (table === 'complaints' || table === 'complaints_needing_attention') {
            data = complaints.slice(rangeArgs ? rangeArgs[0] : 0, rangeArgs ? rangeArgs[1] + 1 : undefined);
          } else if (table === 'team_members' && memberEmails) {
            data = members.filter((m) => memberEmails.includes(m.email));
          }
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
  return { client, auditCalls: audit.calls, memberCalls };
}

const complaintRows = (idList) => idList.map((id) => ({ id, status: 'open', created_at: '2026-09-01T00:00:00Z', source_missive_conversation_id: null }));

// ─── Registration ───────────────────────────────────────────────────────

function register({ asyncTest: runnerAsyncTest, callRouterHandler }) {
  // These tests swap console.error and the module cache, so run-tests.js
  // hands us a runner that already runs them one after another.
  const asyncTest = runnerAsyncTest;

  // --- batching ------------------------------------------------------------

  asyncTest('last-touched — 1,100 ids go out in chunks of at most 100; every id is asked about exactly once; no request carries an over-long id list', async () => {
    const idList = makeIds(1100);
    const { client, calls } = makeAuditClient({ rows: idList.map((id, i) => audit(id, at(i), 'a@example.com')) });
    const out = await findLatestAuditRows(client, idList);

    assert.strictEqual(DEFAULTS.chunkSize, 100);
    assert.strictEqual(calls.length, 11, 'one request per chunk when every chunk fits in one page');
    for (const c of calls) {
      assert.strictEqual(c.table, 'audit_log');
      assert.strictEqual(c.entityType, 'complaint');
      assert.strictEqual(c.inColumn, 'entity_id');
      assert.strictEqual(c.columns, SELECT_COLUMNS);
      assert.ok(c.ids.length <= 100, `a request carried ${c.ids.length} ids`);
      assert.ok(c.ids.join(',').length < ID_LIST_LIMIT);
    }
    const asked = calls.flatMap((c) => c.ids);
    assert.strictEqual(asked.length, 1100, 'no id asked twice');
    assert.deepStrictEqual([...asked].sort(), [...idList].sort(), 'every id asked');
    assert.strictEqual(out.size, 1100);
    assert.deepStrictEqual(calls[0].orders, [{ col: 'created_at', ascending: false }, { col: 'sequence_num', ascending: false }]);
  });

  asyncTest('last-touched — duplicate, empty and non-string ids are collapsed (each real id asked once); no ids at all makes no request', async () => {
    const [a, b] = makeIds(2);
    const { client, calls } = makeAuditClient({ rows: [audit(a, at(1), 'x@example.com')] });
    const out = await findLatestAuditRows(client, [a, a, b, a, b, '', null, undefined, 42]);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual([...calls[0].ids].sort(), [a, b].sort());
    assert.deepStrictEqual([...out.keys()], [a]);

    const none = makeAuditClient();
    assert.strictEqual((await findLatestAuditRows(none.client, [null, '', undefined])).size, 0);
    assert.strictEqual((await findLatestAuditRows(none.client, undefined)).size, 0);
    assert.strictEqual((await findLatestAuditRows(none.client, [])).size, 0);
    assert.strictEqual(none.calls.length, 0);
  });

  asyncTest('last-touched — at most 5 chunks are in flight at once, and they do run side by side', async () => {
    const idList = makeIds(2000);
    const { client, state } = makeAuditClient({ rows: idList.map((id, i) => audit(id, at(i), 'a@example.com')), delay: true });
    const out = await findLatestAuditRows(client, idList);
    assert.strictEqual(out.size, 2000);
    assert.ok(state.maxInFlight > 1, 'chunks ran one at a time');
    assert.ok(state.maxInFlight <= 5, `${state.maxInFlight} chunks in flight`);
  });

  // --- newest row wins -------------------------------------------------------

  asyncTest('last-touched — the NEWEST audit row per complaint wins after merging all chunks, including a complaint with many rows, rows inserted out of order, and rows of another entity type', async () => {
    const idList = makeIds(250); // chunks of 100, 100, 50
    const rows = [];
    idList.forEach((id, i) => rows.push(audit(id, at(1000 + i), `only-${i}@example.com`)));
    // One complaint in each chunk gets many rows, written out of time order.
    [0, 150, 249].forEach((i, n) => {
      const times = [500, 40, 3000, 7, 2500, 2999, 1, 2000];
      times.forEach((t, k) => rows.push(audit(idList[i], at(t), `many-${n}-${k}@example.com`)));
    });
    // A lookalike row for another kind of record, newer than anything above.
    rows.push(audit(idList[10], at(99999), 'tenant-note@example.com', { entity_type: 'tenant' }));
    // A complaint with no audit rows at all.
    const ghost = uuid(9999);

    const { client } = makeAuditClient({ rows });
    const out = await findLatestAuditRows(client, [...idList, ghost]);
    const expected = expectedNewest(rows);

    assert.strictEqual(out.size, 250);
    assert.ok(!out.has(ghost), 'a complaint with no audit rows is simply absent');
    for (const id of idList) {
      assert.strictEqual(out.get(id).actor_id, expected.get(id).actor_id, 'wrong row kept for one complaint');
      assert.strictEqual(out.get(id).created_at, expected.get(id).created_at);
    }
    assert.strictEqual(out.get(idList[0]).actor_id, 'many-0-2@example.com', 'the t=3000 row, not first-seen-in-input or last-seen');
    assert.strictEqual(out.get(idList[10]).actor_id, 'only-10@example.com', 'the tenant row must not count');
  });

  // --- 1000-row page boundary ------------------------------------------------

  asyncTest('last-touched — a complaint whose newest row falls on, or after, the 1000-row page boundary still gets its newest row (not an older one, not nothing)', async () => {
    const idList = makeIds(100);
    const rows = [];
    let n = 0;
    const next = (id, by) => { rows.push(audit(id, at(100000 - n), by)); n += 1; };
    for (let i = 0; i < 999; i += 1) next(idList[i % 98], `p1-${i}`); // positions 1..999: complaints 1..98
    next(idList[99], 'c100-newest'); // position 1000, the very last row of page 1
    next(idList[98], 'c99-newest'); // position 1001, first row of page 2
    next(idList[98], 'c99-older');
    next(idList[99], 'c100-older');
    for (let i = 0; i < 202; i += 1) next(idList[i % 98], `p2-${i}`); // older rows of complaints 1..98

    const { client, calls } = makeAuditClient({ rows });
    const out = await findLatestAuditRows(client, idList);

    assert.strictEqual(out.size, 100);
    assert.strictEqual(out.get(idList[99]).actor_id, 'c100-newest');
    assert.strictEqual(out.get(idList[98]).actor_id, 'c99-newest');
    for (let k = 0; k < 98; k += 1) assert.strictEqual(out.get(idList[k]).actor_id, `p1-${k}`, `complaint ${k + 1} did not keep its page-1 row`);
    assert.deepStrictEqual(calls.map((c) => c.range), [[0, 999], [1000, 1999]]);
  });

  asyncTest('last-touched — paging stops as soon as every complaint in the chunk has its newest row (no needless second page)', async () => {
    const idList = makeIds(100);
    const rows = [];
    for (let round = 0; round < 11; round += 1) idList.forEach((id, k) => rows.push(audit(id, at(round * 1000 + k), `r${round}-${k}`)));
    const { client, calls } = makeAuditClient({ rows }); // 1,100 rows: page 1 is full and already covers all 100 ids
    const out = await findLatestAuditRows(client, idList);
    assert.strictEqual(out.size, 100);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(out.get(idList[7]).actor_id, 'r10-7');
  });

  asyncTest('last-touched — rows written at the very same instant: the later insert (higher sequence number) is the newest, even when the tie straddles the page boundary', async () => {
    const idList = makeIds(100);
    const rows = [];
    for (let i = 0; i < 1500; i += 1) rows.push(audit(idList[i % 100], at(5), `by-${i}`)); // all share one created_at
    const { client } = makeAuditClient({ rows });
    const out = await findLatestAuditRows(client, idList);
    assert.strictEqual(out.size, 100);
    for (let k = 0; k < 100; k += 1) assert.strictEqual(out.get(idList[k]).actor_id, `by-${1400 + k}`, `complaint ${k + 1} did not get its latest insert`);
  });

  asyncTest('last-touched — page limit: a complaint the pages never reached is left out (never given an older row), the log carries only a count, and the ones reached keep their rows', async () => {
    const idList = makeIds(5);
    const [a, b, c, d] = idList; // idList[4] has no rows
    const rows = [];
    let n = 0;
    const next = (id) => { rows.push(audit(id, at(1000 - n), `by-${n}`)); n += 1; };
    for (let i = 0; i < 5; i += 1) next(a);
    for (let i = 0; i < 5; i += 1) next(b);
    for (let i = 0; i < 5; i += 1) next(c);
    next(d);
    const { client } = makeAuditClient({ rows });
    const { result: out, logged } = await quiet(() => findLatestAuditRows(client, idList, { pageSize: 5, maxPages: 2 }));
    assert.deepStrictEqual([...out.keys()].sort(), [a, b].sort());
    assert.strictEqual(out.get(a).actor_id, 'by-0');
    assert.strictEqual(out.get(b).actor_id, 'by-5');
    assert.ok(logged.some((l) => l.includes('3 row(s)')), 'count is logged');
    assert.ok(logged.every((l) => !UUID_IN_TEXT.test(l)), 'no ids in the log');
  });

  // --- fail soft --------------------------------------------------------------

  asyncTest('last-touched — fail soft: one failing chunk blanks only its own 100 complaints; the other chunks keep theirs; the log names the error but no ids', async () => {
    const idList = makeIds(300);
    const rows = idList.map((id, i) => audit(id, at(i), `by-${i}`));
    const { client } = makeAuditClient({ rows, failWhen: (call) => (call.ids.includes(idList[100]) ? 'connection reset' : null) });
    const { result: out, logged } = await quiet(() => findLatestAuditRows(client, idList));
    assert.strictEqual(out.size, 200);
    idList.forEach((id, i) => assert.strictEqual(out.has(id), i < 100 || i >= 200, `complaint ${i + 1}`));
    assert.ok(logged.length >= 1 && logged.every((l) => l.includes('connection reset')));
    assert.ok(logged.every((l) => !UUID_IN_TEXT.test(l)), 'no ids in the log');
  });

  asyncTest('last-touched — fail soft: if a LATER page of a chunk fails, the whole chunk is dropped (not half of it); other chunks are untouched', async () => {
    const idList = makeIds(200);
    const chunkA = idList.slice(0, 100);
    const chunkB = idList.slice(100);
    const rows = [];
    for (let i = 0; i < 1000; i += 1) rows.push(audit(chunkA[i % 99], at(100000 - i), `a-${i}`)); // page 1: complaints 1..99
    rows.push(audit(chunkA[99], at(1), 'a-last')); // only on page 2
    chunkB.forEach((id, i) => rows.push(audit(id, at(i), `b-${i}`)));
    const { client } = makeAuditClient({ rows, failWhen: (call) => (call.ids.includes(chunkA[0]) && call.range[0] === 1000 ? 'statement timeout' : null) });
    const { result: out } = await quiet(() => findLatestAuditRows(client, idList));
    assert.strictEqual(out.size, 100);
    assert.ok(chunkA.every((id) => !out.has(id)), 'a half-read chunk must not leak partial results');
    assert.ok(chunkB.every((id) => out.has(id)));
  });

  asyncTest('last-touched — fail soft: a client that throws outright, or a request that rejects, never throws out of the helper (a rejecting chunk blanks only itself)', async () => {
    const idList = makeIds(300);
    const rows = idList.map((id, i) => audit(id, at(i), `by-${i}`));

    const thrower = makeAuditClient({ rows, throwOnFrom: true });
    const { result: allBlank, logged } = await quiet(() => findLatestAuditRows(thrower.client, idList));
    assert.strictEqual(allBlank.size, 0);
    assert.ok(logged.length >= 1);

    const rejecter = makeAuditClient({ rows, rejectWhen: (call) => call.ids.includes(idList[250]) });
    const { result: out } = await quiet(() => findLatestAuditRows(rejecter.client, idList));
    assert.strictEqual(out.size, 200);
    assert.ok(idList.slice(200).every((id) => !out.has(id)));
  });

  asyncTest('last-touched — fail soft: malformed payloads (not a list, a string, junk entries) are survived; junk entries are ignored while good rows alongside them still count', async () => {
    const [a, b] = makeIds(2);
    const good = { entity_id: a, actor_type: 'human', actor_id: 'good@example.com', created_at: at(5) };

    for (const bad of [{ oops: true }, 'garbage', 17]) {
      const { client } = makeAuditClient({ payload: () => bad });
      const { result: out, logged } = await quiet(() => findLatestAuditRows(client, [a, b]));
      assert.strictEqual(out.size, 0, `payload ${JSON.stringify(bad)}`);
      assert.ok(logged.length >= 1);
    }

    const nothing = makeAuditClient({ payload: () => null });
    assert.strictEqual((await findLatestAuditRows(nothing.client, [a, b])).size, 0, 'null data with no error just means no rows');

    const junk = makeAuditClient({ payload: () => [null, 42, 'x', {}, { entity_id: uuid(777), actor_id: 'not-asked@example.com' }, good] });
    const out = await findLatestAuditRows(junk.client, [a, b]);
    assert.deepStrictEqual([...out.keys()], [a]);
    assert.strictEqual(out.get(a).actor_id, 'good@example.com');
  });

  // --- list endpoints -----------------------------------------------------------

  // 1,100 complaints, 3 audit rows each. The newest row of complaint k is by a
  // known team member (k % 3 === 0), by the system (1), or by someone who is
  // not on the team list (2). Older rows are decoys with different people.
  function buildBigList() {
    const idList = makeIds(1100);
    const rows = [];
    const expectedBy = new Map();
    idList.forEach((id, k) => {
      rows.push(audit(id, at(10 + k), 'old-creator@example.com'));
      const newestAt = at(100000 + k);
      if (k % 3 === 0) {
        rows.push(audit(id, at(50000 + k), 'someone-else@example.com'));
        rows.push(audit(id, newestAt, 'Maria.Test@Example.com')); // mixed case on purpose
        expectedBy.set(id, { at: newestAt, by: 'Maria Test' });
      } else if (k % 3 === 1) {
        rows.push(audit(id, at(50000 + k), 'someone-else@example.com'));
        rows.push(audit(id, newestAt, 'complaint-tracking', { actor_type: 'system' }));
        expectedBy.set(id, { at: newestAt, by: 'System' });
      } else {
        rows.push(audit(id, at(50000 + k), 'maria.test@example.com'));
        rows.push(audit(id, newestAt, 'stranger@example.com'));
        expectedBy.set(id, { at: newestAt, by: 'stranger@example.com' });
      }
    });
    return { idList, rows, expectedBy };
  }
  const members = [{ email: 'maria.test@example.com', full_name: 'Maria Test' }];

  asyncTest('router — GET /api/complaint-tracking with 1,100 complaints (the real list size): status 200, every row has its correct last-touched time and name, in batches of at most 100', async () => {
    const { idList, rows, expectedBy } = buildBigList();
    const { client, auditCalls, memberCalls } = makeListClient({ complaints: complaintRows(idList), auditRows: rows, members });
    const result = await callRouterHandler({ fakeClient: client, method: 'get', routePath: '/api/complaint-tracking', req: { query: {} } });

    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.complaints.length, 1100);
    for (const c of result.body.complaints) {
      assert.deepStrictEqual(c.display.last_touched, expectedBy.get(c.id), 'wrong last-touched for one row');
      assert.ok(Object.prototype.hasOwnProperty.call(c.display, 'missive_link'), 'the rest of display is still there');
    }
    assert.strictEqual(auditCalls.length, 11);
    assert.ok(auditCalls.every((c) => c.ids.length <= 100));
    assert.strictEqual(memberCalls.length, 1, 'team names are looked up once, not per batch');
    assert.deepStrictEqual([...memberCalls[0]].sort(), ['maria.test@example.com', 'stranger@example.com']);
  });

  asyncTest('router — GET /api/complaint-tracking: if one batch of the last-touched lookup fails the list still loads (200, all 1,100 rows) and only that batch\'s 100 rows lack last-touched', async () => {
    const { idList, rows, expectedBy } = buildBigList();
    const { client } = makeListClient({
      complaints: complaintRows(idList), auditRows: rows, members,
      auditOptions: { failWhen: (call) => (call.ids.includes(idList[400]) ? 'Bad Request' : null) },
    });
    const { result } = await quiet(() => callRouterHandler({ fakeClient: client, method: 'get', routePath: '/api/complaint-tracking', req: { query: {} } }));
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.complaints.length, 1100);
    const blank = result.body.complaints.filter((c) => !c.display.last_touched);
    assert.strictEqual(blank.length, 100);
    assert.ok(blank.every((c) => idList.indexOf(c.id) >= 400 && idList.indexOf(c.id) < 500));
    for (const c of result.body.complaints) {
      if (c.display.last_touched) assert.deepStrictEqual(c.display.last_touched, expectedBy.get(c.id));
      assert.ok(Object.prototype.hasOwnProperty.call(c.display, 'missive_link'));
    }
  });

  asyncTest('router — GET /api/complaint-tracking: a complaint with no audit rows gets no last_touched key (its card falls back to updated_at), and the lookup throwing outright still returns the list', async () => {
    const [withRows, without] = makeIds(2);
    const rows = [audit(withRows, at(5), 'maria.test@example.com')];
    const ok = makeListClient({ complaints: complaintRows([withRows, without]), auditRows: rows, members });
    const first = await callRouterHandler({ fakeClient: ok.client, method: 'get', routePath: '/api/complaint-tracking', req: { query: {} } });
    const byId = Object.fromEntries(first.body.complaints.map((c) => [c.id, c]));
    assert.deepStrictEqual(byId[withRows].display.last_touched, { at: at(5), by: 'Maria Test' });
    assert.ok(!Object.prototype.hasOwnProperty.call(byId[without].display, 'last_touched'));

    const broken = makeListClient({ complaints: complaintRows([withRows, without]), auditRows: rows, members, auditOptions: { throwOnFrom: true } });
    const { result: second } = await quiet(() => callRouterHandler({ fakeClient: broken.client, method: 'get', routePath: '/api/complaint-tracking', req: { query: {} } }));
    assert.strictEqual(second.statusCode, 200);
    assert.strictEqual(second.body.complaints.length, 2);
    assert.ok(second.body.complaints.every((c) => c.display && !c.display.last_touched));
  });

  asyncTest('router — GET /api/complaint-tracking/property/:property_id: the Property 360 list gets last-touched through the same batches', async () => {
    const idList = makeIds(250);
    const rows = idList.map((id, i) => audit(id, at(i), i % 2 ? 'maria.test@example.com' : 'complaint-tracking', i % 2 ? {} : { actor_type: 'system' }));
    const { client, auditCalls } = makeListClient({ complaints: complaintRows(idList), auditRows: rows, members });
    const result = await callRouterHandler({
      fakeClient: client, method: 'get', routePath: '/api/complaint-tracking/property/:property_id',
      req: { params: { property_id: '55555555-5555-5555-5555-555555555555' }, query: {} },
    });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.complaints.length, 250);
    result.body.complaints.forEach((c, i) => assert.deepStrictEqual(c.display.last_touched, { at: at(i), by: i % 2 ? 'Maria Test' : 'System' }));
    assert.strictEqual(auditCalls.length, 3);
    assert.ok(auditCalls.every((c) => c.ids.length <= 100));
  });
}

module.exports = { register };
