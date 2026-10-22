'use strict';

/**
 * test/bulk-close-hardening-tests.js
 * Server-side hardening of "Close old items" (lib/bulk-close.js), round 4.
 * Registered into the shared runner by test/run-tests.js. Uses only the
 * in-memory fake database and made-up ids and text.
 *
 *  S3-C  the close update re-checks blocked_since, a typed-in source and a
 *        pending duplicate itself, and one item stamped in the future cannot
 *        widen the updated_at fence for the others;
 *  S3-D  the start row records the set code, a start row whose answer was lost
 *        is not written twice, and Recent batches lists a batch once;
 *  S3-E  the 10-minute lock timeout counts from the last progress;
 *  S3-F  Recent batches is worked out at most once in a short while, and is
 *        fresh at once after a close or undo;
 *  S3-I  stopped_early is carried on the batch list and on an undo;
 *  BUG 4 an audit insert that was saved while its answer was lost is not
 *        written a second time (close, undo, start, end and undo summary rows).
 */

const assert = require('assert');

const bulk = require('../lib/bulk-close');
const { fixtures: fx } = require('./bulk-close-tests');

const {
  DAY, NOW, uuid, iso, ACTOR, world, service, closeBody, guardsOf, quiet,
} = fx;

const waitFor = async (cond, ms = 3000) => {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > ms) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const A = bulk.ACTIONS;
const isCompUpdate = (q) => q.table === 'complaints' && q.op === 'update';
const isAuditInsert = (q) => q.table === 'audit_log' && q.op === 'insert';
const auditRows = (db, action) => db.tables.audit_log.filter((r) => r.action === action);

function register({ asyncTest }) {
  // ====================================================================
  // S3-C  the write re-checks more of the rules
  // ====================================================================

  asyncTest('bulk close — S3-C: the close update itself re-checks blocked_since, a typed-in source and a pending duplicate, so an item that turned into one of those after the read stays open even though its updated_at was not moved', async () => {
    const w = world();
    for (let n = 1; n <= 8; n += 1) w.add(n, 200);
    w.add(9, 200, { duplicate_status: 'dismissed', possible_duplicate_of_id: uuid(1001) }); // a decided duplicate still closes
    w.add(10, 200, { duplicate_status: 'confirmed_merged', possible_duplicate_of_id: uuid(1001) }); // so does a confirmed one
    let changed = false;
    const db = w.db({
      before: (q, st) => {
        if (changed || !isCompUpdate(q)) return;
        changed = true;
        const row = (n) => st.tables.complaints.find((c) => c.id === uuid(1000 + n));
        row(1).blocked_since = iso(NOW - DAY);            // now waiting on someone
        row(2).source = 'manual_staff';                    // now a typed-in report
        row(3).duplicate_status = 'suggested';             // a duplicate suggestion arrived
        row(4).possible_duplicate_of_id = uuid(1005);      // a duplicate pointer with no decision
        // updated_at is deliberately NOT moved: only the update's own guards can notice
      },
    });
    const res = await service(db).execute(closeBody(10), ACTOR);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.closed, 6, 'items 5 to 10 close');
    assert.strictEqual(res.body.skipped_changed, 4, 'the four that changed are counted as left alone');
    assert.strictEqual(res.body.failed, 0);
    for (const n of [1, 2, 3, 4]) assert.strictEqual(db.tables.complaints.find((c) => c.id === uuid(1000 + n)).status, 'open', `item ${n} stays open`);
    for (const n of [5, 6, 7, 8, 9, 10]) assert.strictEqual(db.tables.complaints.find((c) => c.id === uuid(1000 + n)).status, 'resolved', `item ${n} closes`);

    const guards = guardsOf(db.writesTo('complaints', 'update')[0]);
    for (const g of ['is:blocked_since', 'neq:source', 'neq:duplicate_status', 'or:possible_duplicate_of_id|duplicate_status', 'is:resolution_note', 'is:delegated_to_team_member_id', 'lte:updated_at']) {
      assert.ok(guards.includes(g), `the update carries the guard ${g}`);
    }
    const sourceGuard = db.writesTo('complaints', 'update')[0].filters.find((f) => f.col === 'source');
    assert.strictEqual(sourceGuard.val, 'manual_staff');
    const dupOr = db.writesTo('complaints', 'update')[0].filters.find((f) => f.kind === 'or' && f.terms.some((t) => t.col === 'possible_duplicate_of_id'));
    assert.deepStrictEqual(dupOr.terms.map((t) => `${t.col}.${t.op}.${t.val}`), ['possible_duplicate_of_id.is.null', 'duplicate_status.eq.dismissed', 'duplicate_status.eq.confirmed_merged']);
  });

  asyncTest('bulk close — S3-C: one item stamped in the future cannot widen the updated_at fence: an item that changed after the read is still left alone, and the future-dated one is itself left open', async () => {
    const w = world();
    for (let n = 1; n <= 4; n += 1) w.add(n, 200);
    w.add(5, 200, { updated_at: iso(NOW + 365 * DAY) }); // a bad clock or a hand edit
    w.add(6, 200, { updated_at: iso(NOW + 3600 * 1000) }); // or one that is only an hour ahead
    let changed = false;
    const db = w.db({
      before: (q, st) => {
        if (changed || !isCompUpdate(q)) return;
        changed = true;
        const c2 = st.tables.complaints.find((c) => c.id === uuid(1002));
        c2.severity_tier = 'no_issue'; // leaves the Needs a Call / Flagged lanes: not something the update checks column by column
        c2.escalation_signal = null;
        c2.updated_at = iso(NOW + 5000); // what the database's own trigger stamps, after the read
      },
    });
    const res = await service(db).execute(closeBody(6), ACTOR);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.closed, 3, 'items 1, 3 and 4');
    assert.strictEqual(res.body.skipped_changed, 3, 'item 2 changed after the read; items 5 and 6 are dated after the read');
    const status = (n) => db.tables.complaints.find((c) => c.id === uuid(1000 + n)).status;
    assert.deepStrictEqual([1, 2, 3, 4, 5, 6].map(status), ['resolved', 'open', 'resolved', 'resolved', 'open', 'open']);
    const fence = db.writesTo('complaints', 'update')[0].filters.find((f) => f.kind === 'lte' && f.col === 'updated_at').val;
    assert.ok(Date.parse(fence) <= NOW, `the fence (${fence}) is not later than the moment of the read`);
    assert.strictEqual(fence, iso(NOW - 150 * DAY), 'it is the newest value that is not in the future');
  });

  asyncTest('bulk close — S3-C: when every item is dated after the read, the fence falls back to the moment of the read and nothing closes (and the end row is still written)', async () => {
    const w = world();
    for (let n = 1; n <= 3; n += 1) w.add(n, 200, { updated_at: iso(NOW + 30 * DAY) });
    const db = w.db();
    const res = await service(db).execute(closeBody(3), ACTOR);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.closed, 0);
    assert.strictEqual(res.body.skipped_changed, 3);
    assert.strictEqual(db.writesTo('complaints', 'update')[0].filters.find((f) => f.kind === 'lte').val, iso(NOW));
    assert.strictEqual(auditRows(db, A.batchClosed).length, 1);
    assert.strictEqual(db.tables.complaints.filter((c) => c.status === 'resolved').length, 0);
  });

  // ====================================================================
  // S3-D  the start row: the set code, written once, listed once
  // ====================================================================

  asyncTest('bulk close — S3-D: the start row records the set code that was approved, equal to the preview\'s', async () => {
    const w = world();
    for (let n = 1; n <= 6; n += 1) w.add(n, 200);
    const db = w.db();
    const svc = service(db);
    const pre = (await svc.preview({})).body;
    await svc.execute(closeBody(6, { expected_hash: pre.set_hash }), ACTOR);
    assert.strictEqual(auditRows(db, A.batchStarted)[0].details.set_hash, pre.set_hash);
    assert.ok(/^[0-9a-f]{64}$/.test(pre.set_hash));
  });

  asyncTest('bulk close — S3-D: a start row that WAS saved but whose answer was lost is not written a second time; the close goes ahead and Recent batches lists the batch once', async () => {
    const w = world();
    for (let n = 1; n <= 5; n += 1) w.add(n, 200);
    let fired = 0;
    const db = w.db({
      fail: (q) => {
        if (isAuditInsert(q) && q.rows.length === 1 && q.rows[0].action === A.batchStarted && fired === 0) { fired += 1; return { message: 'socket hang up', applied: true }; }
        return null;
      },
    });
    const svc = service(db);
    const { value: res } = await quiet(() => svc.execute(closeBody(5), ACTOR));
    assert.strictEqual(fired, 1);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.closed, 5);
    assert.strictEqual(res.body.audit_failed, 0);
    assert.strictEqual(auditRows(db, A.batchStarted).length, 1, 'one start row, not two');
    const startInserts = db.writesTo('audit_log', 'insert').filter((x) => x.rows.some((r) => r.action === A.batchStarted));
    assert.strictEqual(startInserts.length, 1, 'the start row was sent once');
    const list = (await svc.listBatches()).body.batches;
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].batch_id, res.body.batch_id);
  });

  asyncTest('bulk close — S3-D: a start row refused outright is still retried once, and when the log really is down nothing is changed', async () => {
    const w = world();
    for (let n = 1; n <= 3; n += 1) w.add(n, 200);
    let refused = 0;
    const db = w.db({ fail: (q) => { if (isAuditInsert(q) && q.rows[0].action === A.batchStarted) { refused += 1; return { message: 'down' }; } return null; } });
    const { value: res } = await quiet(() => service(db).execute(closeBody(3), ACTOR));
    assert.strictEqual(res.status, 500);
    assert.strictEqual(refused, 2, 'tried twice');
    assert.strictEqual(db.writesTo('complaints', 'update').length, 0, 'nothing was changed');
    assert.strictEqual(auditRows(db, A.batchStarted).length, 0);
  });

  asyncTest('bulk close — S3-D: Recent batches lists a batch once even if its start row exists twice; the earlier row gives the start time', async () => {
    const w = world();
    const batch = uuid(7001);
    const row = (n, createdMs) => ({
      id: uuid(8100 + n), action: A.batchStarted, entity_type: bulk.BATCH_ENTITY_TYPE, entity_id: batch, performed_by: null, actor_type: 'human',
      actor_id: ACTOR.email, privacy_category: 'processing', risk_level: 'medium', property_id: null,
      details: { batch_id: batch, older_than_days: 90, hold_back_urgent: true, hold_back_legal: false, eligible: 3 }, created_at: iso(createdMs), sequence_num: n,
    });
    w.audit.push(row(1, NOW - 3600000), row(2, NOW - 3590000));
    const other = uuid(7002);
    w.audit.push({ ...row(3, NOW - 7200000), id: uuid(8103), entity_id: other, details: { batch_id: other, older_than_days: 60, hold_back_urgent: false, hold_back_legal: false, eligible: 1 } });
    const list = (await service(w.db()).listBatches()).body.batches;
    assert.strictEqual(list.length, 2);
    assert.deepStrictEqual(list.map((b) => b.batch_id), [batch, other], 'newest first, each once');
    assert.strictEqual(list[0].closed_at, iso(NOW - 3600000), 'the earlier of the two start rows');
  });

  // ====================================================================
  // S3-E  the lock timeout counts from the last progress
  // ====================================================================

  asyncTest('bulk close — S3-E: a healthy long close is never taken over: the 10 minutes are counted from its last progress, not from when it started', async () => {
    const w = world();
    for (let n = 1; n <= 240; n += 1) w.add(n, 200);
    let t = 0;
    let updates = 0;
    let other = null;
    let svc = null;
    const db = w.db({
      before: (q) => {
        if (!isCompUpdate(q)) return;
        updates += 1;
        t += 6 * 60 * 1000; // each group takes six minutes
        if (updates === 2) other = svc.undo(uuid(9999), ACTOR); // 12 minutes after the start, but 6 after the last progress
      },
    });
    svc = service(db, { clock: () => t });
    const res = await svc.execute(closeBody(240), ACTOR);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.closed, 240, 'all three groups were closed by the one call');
    assert.ok(!res.body.stopped_early, 'it was never taken over');
    assert.strictEqual(res.body.failed, 0);
    assert.strictEqual((await other).status, 409, 'the other call was refused: the close was still making progress');
    assert.strictEqual(t, 18 * 60 * 1000, 'more than 10 minutes in all');
    assert.strictEqual((await svc.preview({})).status, 200, 'the lock was freed at the end');
  });

  asyncTest('bulk close — S3-E: finishing the read and saving the start row also count as progress (a slow read, then a slow start row, then a slow first group: still not taken over)', async () => {
    const w = world();
    for (let n = 1; n <= 160; n += 1) w.add(n, 200);
    let t = 0;
    let reads = 0;
    let updates = 0;
    const others = [];
    let svc = null;
    const db = w.db({
      before: (q) => {
        if (q.table === 'complaints' && q.op === 'select' && (reads += 1) === 1) t += 9 * 60 * 1000; // the read phase takes nine minutes
        if (isAuditInsert(q) && q.rows[0].action === A.batchStarted) { t += 2 * 60 * 1000; others.push(svc.undo(uuid(9999), ACTOR)); } // 11 minutes in, 2 after the read ended
        if (isCompUpdate(q) && (updates += 1) === 1) { t += 9 * 60 * 1000; others.push(svc.undo(uuid(9999), ACTOR)); } // 20 minutes in, 9 after the start row
      },
    });
    svc = service(db, { clock: () => t });
    const res = await svc.execute(closeBody(160), ACTOR);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.closed, 160);
    assert.ok(!res.body.stopped_early);
    assert.deepStrictEqual((await Promise.all(others)).map((o) => o.status), [409, 409], 'both times the close still held the lock: it had made progress within the last 10 minutes');
  });

  asyncTest('bulk close — S3-E: a call that was taken over cannot keep the newer call\'s lock alive by finishing the group it was in the middle of', async () => {
    const w = world();
    for (let n = 1; n <= 200; n += 1) w.add(n, 200);
    let t = 0;
    let updates = 0;
    const db = w.db({
      delay: (q) => { if (!isCompUpdate(q)) return 0; q.nth = (updates += 1); return q.nth === 1 ? 400 : 0; }, // the first call's first group is slow
      fail: (q) => (isCompUpdate(q) && q.nth === 2 ? { hang: true } : null), // the newer call's first group never answers
    });
    const svc = service(db, { clock: () => t });
    const first = svc.execute(closeBody(200), ACTOR);
    await waitFor(() => updates >= 1);
    t += 11 * 60 * 1000;
    svc.execute(closeBody(200), ACTOR).catch(() => {}); // takes over (the first call has made no progress for 11 minutes) and then hangs
    await waitFor(() => updates >= 2);
    t += 5 * 60 * 1000; // 16 minutes: the newer call took the lock at minute 11
    const a = await quiet(() => first); // the slow first group finishes now; the first call then sees it lost the lock
    assert.strictEqual(a.value.body.stopped_early, true);
    t += 6 * 60 * 1000; // 22 minutes: eleven since the newer call took the lock, six since the old call finished its group
    const { value: third } = await quiet(() => svc.undo(uuid(9999), ACTOR));
    assert.strictEqual(third.status, 404, 'the newer call has made no progress for over 10 minutes, so it is taken over in its turn (and the batch id is unknown); the old call\'s finishing did not keep its lock alive');
  });

  asyncTest('bulk close — S3-E: a healthy long UNDO is never taken over either: progress after each group keeps the lock', async () => {
    const w = world();
    for (let n = 1; n <= 240; n += 1) w.add(n, 200);
    const hooks = {};
    const db = w.db(hooks);
    let t = 0;
    const svc = service(db, { clock: () => t, now: () => Math.max(NOW, db.state.clock + 1000) });
    const closed = await svc.execute(closeBody(240), ACTOR);
    assert.strictEqual(closed.body.closed, 240);
    let groups = 0;
    let other = null;
    hooks.before = (q) => {
      if (!isCompUpdate(q) || !q.patch || q.patch.status !== 'open') return;
      groups += 1;
      t += 6 * 60 * 1000;
      if (groups === 2) other = svc.undo(uuid(9999), ACTOR); // 12 minutes in, 6 after the last progress
    };
    const undone = await svc.undo(closed.body.batch_id, ACTOR);
    assert.strictEqual(undone.body.reopened, 240);
    assert.ok(!undone.body.stopped_early && !undone.body.failed, 'never taken over');
    assert.strictEqual((await other).status, 409);
  });

  asyncTest('bulk close — S3-E: a call that makes no progress for 10 minutes is still taken over (progress, not time since the start, is what counts), also for an undo', async () => {
    const w = world();
    for (let n = 1; n <= 160; n += 1) w.add(n, 200);
    let t = 0;
    let updates = 0;
    let svc = null;
    const db = w.db({ fail: (q) => { if (isCompUpdate(q)) { updates += 1; if (updates === 2) return { hang: true }; } return null; } });
    svc = service(db, { clock: () => t });
    svc.execute(closeBody(160), ACTOR).catch(() => {});
    await waitFor(() => updates >= 2); // group 1 done (progress at t = 0), group 2 hangs
    t += 9 * 60 * 1000;
    assert.strictEqual((await svc.undo(uuid(9999), ACTOR)).status, 409, 'nine minutes without progress: still refused');
    t += 2 * 60 * 1000;
    const { value: taken } = await quiet(() => svc.undo(uuid(9999), ACTOR));
    assert.strictEqual(taken.status, 404, 'eleven minutes without progress: the lock was taken over (an unknown batch is simply not found)');
  });

  // ====================================================================
  // S3-F  Recent batches is not worked out over and over
  // ====================================================================

  asyncTest('bulk close — S3-F: Recent batches is worked out at most once per short while; callers who arrive together share one piece of work; a close or undo makes it fresh at once; a failure is not remembered', async () => {
    assert.strictEqual(bulk.BATCHES_CACHE_MS, 2000);
    const w = world();
    for (let n = 1; n <= 5; n += 1) w.add(n, 200);
    let t = 100000;
    let failNext = false;
    const db = w.db({ fail: (q) => { if (failNext && q.table === 'audit_log' && q.op === 'select') { failNext = false; return { message: 'boom' }; } return null; } });
    const svc = service(db, { batchesCacheMs: 2000, clock: () => t });
    const closed = await svc.execute(closeBody(5), ACTOR);
    const calls = () => db.state.calls.length;

    const before = calls();
    const first = await svc.listBatches();
    const perList = calls() - before;
    assert.ok(perList > 0);
    assert.strictEqual(first.body.batches[0].still_closed, 5);

    t += 500;
    const second = await svc.listBatches();
    assert.strictEqual(calls() - before, perList, 'inside the window: nothing was read again');
    assert.deepStrictEqual(second.body, first.body);
    second.body.batches.length = 0; // a caller changing what it got must not change what the next one gets
    assert.strictEqual((await svc.listBatches()).body.batches.length, 1);

    t += 1600; // 2,100 ms after the first
    await svc.listBatches();
    assert.strictEqual(calls() - before, perList * 2, 'after the window: worked out again');

    // an undo makes it fresh at once, inside the window
    await svc.undo(closed.body.batch_id, ACTOR);
    const afterUndo = await svc.listBatches();
    assert.strictEqual(afterUndo.body.batches[0].still_closed, 0, 'not the answer from before the undo');

    // callers who arrive together share one piece of work
    t += 5000;
    const mark = calls();
    const three = await Promise.all([svc.listBatches(), svc.listBatches(), svc.listBatches()]);
    assert.strictEqual(calls() - mark, perList, 'three callers, one piece of work');
    assert.deepStrictEqual(three[1].body, three[0].body);

    // a failed piece of work is not remembered
    t += 5000;
    failNext = true;
    await assert.rejects(() => svc.listBatches());
    const retry = await svc.listBatches();
    assert.strictEqual(retry.status, 200);
  });

  asyncTest('bulk close — S3-F: an answer that was being worked out when a close or undo happened is not kept for later, and a caller who arrives after it does not share it', async () => {
    const w = world();
    for (let n = 1; n <= 5; n += 1) w.add(n, 200);
    let t = 100000;
    let slow = false;
    let started = 0;
    const db = w.db({ delay: (q) => { if (slow && q.table === 'audit_log' && q.op === 'select') { started += 1; return started === 1 ? 150 : 0; } return 0; } });
    const svc = service(db, { batchesCacheMs: 2000, clock: () => t });
    const closed = await svc.execute(closeBody(5), ACTOR);
    const startRowReads = () => db.state.calls.filter((q) => q.table === 'audit_log' && q.op === 'select' && q.filters.some((f) => f.col === 'action' && f.val === A.batchStarted)).length;
    t += 10000;

    // (1) a caller after an undo does its own work instead of joining the one that began before it
    slow = true;
    const oldRead = svc.listBatches(); // starts, then waits 150 ms on its first read
    await waitFor(() => started >= 1);
    const readsBefore = startRowReads();
    await svc.undo(closed.body.batch_id, ACTOR); // lock taken and freed: the answer being worked out is out of date
    slow = false;
    const fresh = await svc.listBatches();
    assert.strictEqual(startRowReads(), readsBefore + 1, 'the new caller read the batches itself');
    assert.strictEqual(fresh.body.batches[0].still_closed, 0);
    await oldRead;

    // (2) the answer that was in progress is not kept: once it has finished, the next caller still gets the fresh one
    t += 10000;
    slow = true;
    started = 0;
    const closedAgain = await svc.execute(closeBody(5), ACTOR); // (a new close makes the batches fresh again)
    const lateRead = svc.listBatches();
    await waitFor(() => started >= 1);
    await svc.undo(closedAgain.body.batch_id, ACTOR);
    await lateRead; // it finishes after the undo: it must not be remembered
    slow = false;
    const mark = startRowReads();
    const next = await svc.listBatches();
    assert.strictEqual(startRowReads(), mark + 1, 'the late answer was not kept: this caller reads again');
    assert.strictEqual(next.body.batches.find((b) => b.batch_id === closedAgain.body.batch_id).still_closed, 0);
    const mark2 = startRowReads();
    await svc.listBatches();
    assert.strictEqual(startRowReads(), mark2, 'and that answer is the one that is kept');
  });

  asyncTest('bulk close — S3-F: an answer given while a close is running is not served after it ends, and one given before the start row was saved is not served once it is', async () => {
    const w = world();
    for (let n = 1; n <= 160; n += 1) w.add(n, 200);
    let t = 100000;
    let slowStartRow = false;
    let slowFirstGroup = false;
    let updates = 0;
    const db = w.db({
      delay: (q) => {
        if (slowStartRow && isAuditInsert(q) && q.rows[0].action === A.batchStarted) return 150;
        if (slowFirstGroup && isCompUpdate(q) && (updates += 1) === 1) return 150;
        return 0;
      },
    });
    const svc = service(db, { batchesCacheMs: 5000, clock: () => t });
    const insertsOf = (action) => db.writesTo('audit_log', 'insert').filter((x) => x.rows.some((r) => r.action === action)).length;

    // a list is asked for while the start row is being written: no batch yet
    slowStartRow = true;
    slowFirstGroup = true;
    const running = svc.execute(closeBody(160), ACTOR);
    await waitFor(() => db.state.calls.some((q) => q.table === 'audit_log' && q.op === 'insert')); // the start row is on its way
    const before = await svc.listBatches();
    assert.strictEqual(before.body.batches.length, 0, 'the start row is not saved yet');
    await waitFor(() => insertsOf(A.batchStarted) >= 1 && updates >= 1); // the start row is in and the first group is being written (slowly)
    const during = await svc.listBatches();
    assert.strictEqual(during.body.batches.length, 1, 'once the start row is saved the batch is listed, not the earlier empty answer');
    assert.strictEqual(during.body.batches[0].state, 'running');
    // ... and it is not still "running" once the close has ended
    await running;
    const after = await svc.listBatches();
    assert.strictEqual(after.body.batches[0].state, 'finished', 'not the answer remembered from while it was running');
    assert.strictEqual(after.body.batches[0].closed, 160);
  });

  asyncTest('bulk close — S3-F: a call taken over by a newer one changes what Recent batches says about its batch, at once (running -> unfinished)', async () => {
    const w = world();
    for (let n = 1; n <= 160; n += 1) w.add(n, 200);
    const hooks = {};
    const db = w.db(hooks);
    let t = 100000;
    const svc = service(db, { batchesCacheMs: 3600000, clock: () => t });
    let updates = 0;
    let slowReads = false;
    hooks.fail = (q) => (isCompUpdate(q) && (updates += 1) === 1 ? { hang: true } : null);
    hooks.delay = (q) => (slowReads && q.table === 'complaints' && q.op === 'select' ? 300 : 0);
    svc.execute(closeBody(160), ACTOR).catch(() => {}); // the first group never answers
    await waitFor(() => updates >= 1);
    const running = await svc.listBatches();
    assert.strictEqual(running.body.batches[0].state, 'running');
    t += 11 * 60 * 1000; // past the lock time; the answer above is still inside its own (very long) window
    slowReads = true;
    const takeover = quiet(() => svc.undo(uuid(9999), ACTOR)); // takes the lock over at once, then waits on its first read
    const during = await svc.listBatches(); // asked while the newer call still holds the lock
    assert.strictEqual(during.body.batches[0].state, 'unfinished', 'no longer "running": the newer call took the lock the moment it started');
    assert.strictEqual((await takeover).value.status, 404, 'the newer call ends: the batch id it was given is unknown');
  });

  asyncTest('bulk close — S3-F: the real route has it on, the service on its own does not (so nothing else changes)', async () => {
    // the service default: every call works it out
    const w = world();
    for (let n = 1; n <= 3; n += 1) w.add(n, 200);
    const db = w.db();
    const plain = service(db);
    await plain.listBatches();
    const m1 = db.state.calls.length;
    await plain.listBatches();
    assert.ok(db.state.calls.length - m1 > 0, 'no cache without batchesCacheMs');
    // mounted on a router: on by default
    const handlers = {};
    const router = { get(p, ...h) { handlers[`GET ${p}`] = h; }, post(p, ...h) { handlers[`POST ${p}`] = h; } };
    let t = 1000;
    bulk.mountBulkCloseRoutes(router, { requireAccess: (req, res, next) => next(), supabase: db.client, lookupUserId: async () => null, serviceOptions: { clock: () => t, now: () => NOW } });
    const run = async () => {
      const h = handlers['GET /api/complaint-tracking/bulk-close/batches'];
      const out = {};
      const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
      await h[h.length - 1]({ query: {}, headers: {}, get: () => undefined }, res);
      return out;
    };
    await run();
    const m2 = db.state.calls.length;
    t += 300;
    assert.strictEqual((await run()).status, 200);
    assert.strictEqual(db.state.calls.length, m2, 'the mounted route remembers the answer for a moment');
  });

  // ====================================================================
  // S3-I  stopped_early is carried
  // ====================================================================

  asyncTest('bulk close — S3-I: a close that stopped early says so on Recent batches (finished batches that did not stop do not), and an undo that was taken over says stopped_early', async () => {
    const w = world();
    for (let n = 1; n <= 200; n += 1) w.add(n, 200);
    let t = 0;
    let n2 = 0;
    let svc = null;
    let takeover = null;
    const db = w.db({
      before: (q) => {
        if (!isCompUpdate(q)) return;
        n2 += 1;
        if (n2 === 1) { t += 11 * 60 * 1000; takeover = svc.undo(uuid(9999), ACTOR); } // taken over while its first group is being written
      },
    });
    svc = service(db, { clock: () => t });
    const res = await svc.execute(closeBody(200), ACTOR);
    await takeover;
    assert.strictEqual(res.body.stopped_early, true);
    assert.strictEqual(res.body.closed, 80);
    const list = (await svc.listBatches()).body.batches;
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].stopped_early, true, 'Recent batches carries it');
    assert.strictEqual(list[0].state, 'finished');
    assert.strictEqual(list[0].closed, 80);

    // an ordinary batch has no such field
    const w2 = world();
    for (let n = 1; n <= 3; n += 1) w2.add(n, 200);
    const svc2 = service(w2.db());
    await svc2.execute(closeBody(3), ACTOR);
    assert.ok(!('stopped_early' in (await svc2.listBatches()).body.batches[0]));

    // an undo taken over part way
    const w3 = world();
    for (let n = 1; n <= 200; n += 1) w3.add(n, 200);
    let t3 = 0;
    let u = 0;
    let svc3 = null;
    let batchId = null;
    const db3 = w3.db({
      before: (q) => {
        if (!isCompUpdate(q) || !q.patch || q.patch.status !== 'open') return;
        u += 1;
        if (u === 1) { t3 += 11 * 60 * 1000; svc3.undo(uuid(9998), ACTOR); } // a newer call takes over during the first reopened group
      },
    });
    svc3 = service(db3, { clock: () => t3 });
    batchId = (await svc3.execute(closeBody(200), ACTOR)).body.batch_id;
    const undone = await svc3.undo(batchId, ACTOR);
    assert.strictEqual(undone.status, 200);
    assert.strictEqual(undone.body.stopped_early, true);
    assert.strictEqual(undone.body.reopened, 80);
    assert.strictEqual(undone.body.failed, 120, 'the groups it never reached');
    const normal = await svc3.undo(batchId, ACTOR);
    assert.ok(!('stopped_early' in normal.body), 'a second, complete undo does not carry it');
    assert.strictEqual(normal.body.reopened, 120);
  });

  // ====================================================================
  // BUG 4  nothing in the audit log is written twice
  // ====================================================================

  asyncTest('bulk close — BUG 4: an 80-row audit insert that was saved while its answer was lost is not written again row by row: one audit row per closed item, audit_failed 0', async () => {
    const w = world();
    for (let n = 1; n <= 100; n += 1) w.add(n, 200);
    let fired = 0;
    const db = w.db({
      fail: (q) => {
        if (isAuditInsert(q) && q.rows.length === 80 && q.rows[0].action === A.itemClosed && fired === 0) { fired += 1; return { message: 'socket hang up', applied: true }; }
        return null;
      },
    });
    const { value: res } = await quiet(() => service(db).execute(closeBody(100), ACTOR));
    assert.strictEqual(fired, 1);
    assert.strictEqual(res.body.closed, 100);
    assert.strictEqual(res.body.audit_failed, 0);
    const items = auditRows(db, A.itemClosed);
    assert.strictEqual(items.length, 100, 'one row per item');
    assert.strictEqual(new Set(items.map((r) => r.entity_id)).size, 100, 'no item twice');
    const inserts = db.writesTo('audit_log', 'insert');
    assert.deepStrictEqual(inserts.map((x) => x.rows.length), [1, 80, 20, 1], 'start, the 80 (once), the 20, end: no row-by-row repeat');
  });

  asyncTest('bulk close — BUG 4: rows already saved are skipped when the group has to be written one at a time; a single row saved while its answer was lost is not repeated', async () => {
    const w = world();
    for (let n = 1; n <= 10; n += 1) w.add(n, 200);
    const batchId = uuid(5001); // service() hands out uuid(5001) first
    // items 1 to 3 already have their rows (as if an earlier attempt had saved them)
    for (let n = 1; n <= 3; n += 1) {
      w.seq += 1;
      w.audit.push({
        id: uuid(8500 + n), action: A.itemClosed, entity_type: 'complaint', entity_id: uuid(1000 + n), performed_by: null, actor_type: 'human', actor_id: ACTOR.email,
        privacy_category: 'processing', risk_level: 'low', property_id: null, details: { batch_id: batchId, from_status: 'open', to_status: 'resolved' }, created_at: iso(NOW - 1000), sequence_num: w.seq,
      });
    }
    let single7 = 0;
    const db = w.db({
      fail: (q) => {
        if (!isAuditInsert(q)) return null;
        if (q.rows.length > 1) return { message: 'multi-row refused' }; // not saved
        if (q.rows[0].action === A.itemClosed && q.rows[0].entity_id === uuid(1007) && single7 === 0) { single7 += 1; return { message: 'socket hang up', applied: true }; }
        return null;
      },
    });
    const { value: res } = await quiet(() => service(db).execute(closeBody(10), ACTOR));
    assert.strictEqual(res.body.batch_id, batchId);
    assert.strictEqual(res.body.closed, 10);
    assert.strictEqual(res.body.audit_failed, 0);
    const rows = auditRows(db, A.itemClosed);
    assert.strictEqual(rows.length, 10, 'ten rows in all: the three that were already there, not written again, and seven new');
    assert.strictEqual(new Set(rows.map((r) => r.entity_id)).size, 10);
  });

  asyncTest('bulk close — BUG 4: a row written for the same item by an EARLIER batch is not mistaken for this batch\'s: a refused insert is still written one row at a time, nothing is lost', async () => {
    const w = world();
    for (let n = 1; n <= 10; n += 1) w.add(n, 200);
    const hooks = {};
    const db = w.db(hooks);
    const svc = service(db, { now: () => Math.max(NOW, db.state.clock + 1000) });
    const first = await svc.execute(closeBody(10), ACTOR);
    await svc.undo(first.body.batch_id, ACTOR);
    // the second close of the same ten: its 10-row insert is refused outright (not saved)
    hooks.fail = (q) => (isAuditInsert(q) && q.rows.length === 10 && q.rows[0].action === A.itemClosed ? { message: 'refused' } : null);
    const pre = (await svc.preview({})).body;
    const { value: second } = await quiet(() => svc.execute(closeBody(10, { expected_hash: pre.set_hash }), ACTOR));
    assert.strictEqual(second.body.closed, 10);
    assert.strictEqual(second.body.audit_failed, 0, 'every row was written');
    const secondRows = auditRows(db, A.itemClosed).filter((r) => r.details.batch_id === second.body.batch_id);
    assert.strictEqual(secondRows.length, 10, 'this batch has its own ten rows, besides the earlier batch\'s ten');
    assert.strictEqual(auditRows(db, A.itemClosed).length, 20);
  });

  asyncTest('bulk close — BUG 4: when the log cannot be asked what it holds, the rows are written again (a row is never lost; a repeated one is the lesser harm), and a refused row is still counted', async () => {
    const w = world();
    for (let n = 1; n <= 100; n += 1) w.add(n, 200);
    let fired = 0;
    const db = w.db({
      fail: (q) => {
        if (q.table !== 'audit_log') return null;
        if (q.op === 'select' && q.filters.some((f) => f.col === 'action' && f.val === A.itemClosed)) return { message: 'cannot look' }; // the "what do you hold" question fails
        if (isAuditInsert(q) && q.rows.length === 80 && fired === 0) { fired += 1; return { message: 'socket hang up', applied: true }; }
        return null;
      },
    });
    const { value: res } = await quiet(() => service(db).execute(closeBody(100), ACTOR));
    assert.strictEqual(res.body.audit_failed, 0);
    const rows = auditRows(db, A.itemClosed);
    assert.strictEqual(new Set(rows.map((r) => r.entity_id)).size, 100, 'every item has its row');
    assert.ok(rows.length >= 100);
  });

  asyncTest('bulk close — BUG 4: if asking the log what it holds THROWS, the close carries on and writes the rows again (it does not fail half way)', async () => {
    const w = world();
    for (let n = 1; n <= 100; n += 1) w.add(n, 200);
    let armed = false;
    let fired = 0;
    const db = w.db({
      before: (q) => { if (isAuditInsert(q) && q.rows[0].action === A.batchStarted) armed = true; },
      fail: (q) => (isAuditInsert(q) && q.rows.length === 80 && q.rows[0].action === A.itemClosed && fired === 0 ? (fired += 1, { message: 'socket hang up', applied: true }) : null),
    });
    const client = {
      from: (table) => {
        const chain = db.client.from(table);
        if (armed && table === 'audit_log') chain.select = () => { throw new Error('connection reset'); };
        return chain;
      },
    };
    const { value: res } = await quiet(() => service(db, { supabase: client }).execute(closeBody(100), ACTOR));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.closed, 100);
    assert.strictEqual(res.body.audit_failed, 0);
    const rows = auditRows(db, A.itemClosed);
    assert.strictEqual(new Set(rows.map((r) => r.entity_id)).size, 100, 'every item has its row (some twice: the look-up could not say which were saved)');
  });

  asyncTest('bulk close — BUG 4: undo rows too: a reopened-items insert saved while its answer was lost is not repeated, and an undo summary is told apart from an earlier undo\'s by its own id', async () => {
    const w = world();
    for (let n = 1; n <= 100; n += 1) w.add(n, 200);
    const hooks = {}; // the fake database reads these on every call, so they can be changed between steps
    const db = w.db(hooks);
    const svc = service(db, { now: () => Math.max(NOW, db.state.clock + 1000) });
    const batchId = (await svc.execute(closeBody(100), ACTOR)).body.batch_id;

    // undo 1: the second group of 20 cannot be reopened
    let reopenGroups = 0;
    hooks.fail = (q) => (isCompUpdate(q) && q.patch && q.patch.status === 'open' && (reopenGroups += 1) === 2 ? { message: 'update refused' } : null);
    const { value: u1 } = await quiet(() => svc.undo(batchId, ACTOR));
    assert.strictEqual(u1.body.reopened, 80);
    assert.strictEqual(u1.body.failed, 20);
    assert.strictEqual(auditRows(db, A.batchUndone).length, 1);

    // undo 2: its 20 reopened rows are saved but the answer is lost; its summary is refused outright
    let lostItems = 0;
    let summaryRefusals = 0;
    hooks.fail = (q) => {
      if (isAuditInsert(q) && q.rows[0].action === A.itemReopened && q.rows.length === 20 && lostItems === 0) { lostItems += 1; return { message: 'socket hang up', applied: true }; }
      if (isAuditInsert(q) && q.rows[0].action === A.batchUndone) { summaryRefusals += 1; return { message: 'refused' }; }
      return null;
    };
    const { value: u2 } = await quiet(() => svc.undo(batchId, ACTOR));
    assert.strictEqual(u2.body.reopened, 20);
    assert.strictEqual(lostItems, 1);
    const reopenedRows = auditRows(db, A.itemReopened);
    assert.strictEqual(reopenedRows.length, 100, 'one row per reopened item across both undos, none twice');
    assert.strictEqual(new Set(reopenedRows.map((r) => r.entity_id)).size, 100);
    assert.strictEqual(summaryRefusals, 2, 'the summary was tried twice');
    assert.strictEqual(auditRows(db, A.batchUndone).length, 1, 'the earlier undo\'s summary is not mistaken for this one\'s');
    assert.strictEqual(u2.body.audit_failed, 1, 'the missing summary is reported');
  });

  asyncTest('bulk close — BUG 4: the end row and an undo summary saved while their answer was lost are not repeated (looked up by batch id, and for the summary by its own undo id)', async () => {
    const w = world();
    for (let n = 1; n <= 5; n += 1) w.add(n, 200);
    const lost = new Set();
    const db = w.db({
      fail: (q) => {
        if (isAuditInsert(q) && q.rows.length === 1 && [A.batchClosed, A.batchUndone].includes(q.rows[0].action) && !lost.has(q.rows[0].action)) {
          lost.add(q.rows[0].action);
          return { message: 'socket hang up', applied: true };
        }
        return null;
      },
    });
    const svc = service(db);
    const { value: closed } = await quiet(() => svc.execute(closeBody(5), ACTOR));
    assert.strictEqual(closed.body.audit_failed, 0);
    assert.strictEqual(auditRows(db, A.batchClosed).length, 1, 'one end row');
    const { value: undone } = await quiet(() => svc.undo(closed.body.batch_id, ACTOR));
    assert.strictEqual(undone.body.audit_failed, undefined);
    assert.strictEqual(auditRows(db, A.batchUndone).length, 1, 'one undo summary');
  });
}

module.exports = { register };
