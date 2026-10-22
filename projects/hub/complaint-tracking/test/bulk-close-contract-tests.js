'use strict';

/**
 * test/bulk-close-contract-tests.js
 * The contract between the server (lib/bulk-close.js) and the dashboard's
 * "Close old items" panel. The page's own code is lifted out of
 * dashboard/index.html (test/bulk-close-page-harness.js), and every case below
 * feeds it what the REAL service answers over the fake database, through the
 * real routes, then reads the screen the person would see. A field the server
 * sends under a different name than the page reads, a rule the page forgets, or
 * a sentence that stops naming the whole group, fails here instead of reaching
 * Peter.
 *
 * Cases (each one a real answer, not a hand-written mock):
 *   - a normal close, and Recent batches for a batch that finished;
 *   - an Undo that only partly worked (the second group of items refused);
 *   - an Undo that stopped early;
 *   - a close whose end-of-batch row was refused (audit_failed) -> the batch
 *     is listed as unfinished, and undoing it from the list;
 *   - Recent batches in each state the server sends: finished, unfinished,
 *     running, unknown;
 *   - a close that failed with a 500 on the start row;
 *   - a close that stopped early (taken over);
 *   - a preview that could not finish (lookup_incomplete);
 *   - the wording: every sentence about the legal group names the whole group.
 */

const assert = require('assert');

const bulk = require('../lib/bulk-close');
const { loadPanel, routeFetch } = require('./bulk-close-page-harness');
const { fixtures: fx } = require('./bulk-close-tests');

const {
  DAY, NOW, uuid, iso, ACTOR, PERFORMED_BY, world, quiet,
} = fx;

const A = bulk.ACTIONS;
const isCompUpdate = (q) => q.table === 'complaints' && q.op === 'update';
const isAuditInsert = (q) => q.table === 'audit_log' && q.op === 'insert';

const GROUP_SUFFIX = 'or with a rejected owner instruction';
// every mention of the legal group must name the whole group
const NAMES_ONLY_HALF = /legal[- ]exposure(?! or with a rejected owner instruction)/i;
const FAIR_HOUSING_SENTENCE = 'Items flagged for Fair Housing or marked as accommodation requests are always kept open.';

// The real routes over a fake database, behind the panel's fetch().
function mount(db, { serviceOptions = {}, batchesCacheMs } = {}) {
  const handlers = {};
  const router = { get(p, ...h) { handlers[`GET ${p}`] = h; }, post(p, ...h) { handlers[`POST ${p}`] = h; } };
  let n = 0;
  const service = bulk.mountBulkCloseRoutes(router, {
    requireAccess: (req, res, next) => next(),
    supabase: db.client,
    lookupUserId: async () => PERFORMED_BY,
    previewMinIntervalMs: 0,
    ...(batchesCacheMs === undefined ? {} : { batchesCacheMs }),
    serviceOptions: {
      now: () => Math.max(NOW, db.state.clock + 1000), randomUUID: () => uuid(5000 + (n += 1)), lookupTimeoutMs: 5000, ...serviceOptions,
    },
  });
  const fetchImpl = routeFetch(handlers);
  return { handlers, service, fetchImpl, panel: () => loadPanel({ fetchImpl }) };
}

const oldItems = (count, over = {}) => {
  const w = world();
  for (let n = 1; n <= count; n += 1) w.add(n, 200, typeof over === 'function' ? over(n) : over);
  return w;
};

// preview with the settings on screen, then Close -> confirm -> yes
async function previewAndClose(panel) {
  await panel.preview();
  assert.ok(await panel.press({ 'data-co': 'to-confirm' }), 'the red Close button was available after the preview');
  assert.ok(await panel.press({ 'data-co': 'do-close' }), 'the confirm screen offered the final yes');
  await panel.settle();
}

// the panel closed and opened again, so Recent batches shows every batch
async function reopen(panel) {
  await panel.dismiss();
  assert.ok(panel.closedForGood(), 'the window closed');
  await panel.open();
}

const noClaimOfClosing = (text) => assert.ok(!/Closed \d[\d,]* items?/.test(text), `must not claim "Closed N": ${text}`);

function register({ asyncTest }) {
  // ====================================================================
  // The ordinary path
  // ====================================================================

  asyncTest('page contract — a normal close: the preview, the confirm screen, "Closed N items", an Undo, and the batch in Recent batches as a finished batch', async () => {
    const w = oldItems(5);
    const db = w.db();
    const m = mount(db);
    const panel = m.panel();
    const { logged } = await quiet(async () => {
      await panel.open();
      assert.ok(panel.screenText().includes('Close old items'));
      assert.ok(panel.screenText().includes('No batches yet'));
      await panel.preview();
      assert.ok(/5 items will be closed/.test(panel.screenText()), panel.screenText());
      assert.ok(panel.screenText().includes(FAIR_HOUSING_SENTENCE), 'the Fair Housing sentence is on the form');
      await panel.press({ 'data-co': 'to-confirm' });
      assert.ok(/Close 5 items\?/.test(panel.screenText()));
      assert.ok(panel.screenText().includes('Items flagged for Fair Housing or marked as accommodation requests are always kept open'));
      await panel.press({ 'data-co': 'do-close' });
      await panel.settle();
      const text = panel.screenText();
      assert.ok(/Closed 5 items\./.test(text), text);
      assert.ok(!/record of it was not fully saved/.test(text));
      const batchId = db.tables.audit_log.find((r) => r.action === A.batchStarted).entity_id;
      assert.ok(panel.undoButton(batchId) && !panel.undoButton(batchId).disabled, 'an Undo for the batch just closed');

      await reopen(panel);
      const list = panel.screenText();
      assert.ok(/Closed 5 items on /.test(list), list);
      assert.ok(/all still closed/.test(list));
      assert.ok(!/Unfinished|still running|could not be read/.test(list), 'a finished batch has no warning');
      assert.ok(panel.undoButton(batchId) && !panel.undoButton(batchId).disabled);
      // the page really asked for the real routes
      assert.ok(panel.record.fetches.some((f) => f.method === 'POST' && f.url.endsWith('/bulk-close') && f.body.expected_count === 5 && /^[0-9a-f]{64}$/.test(f.body.expected_hash)));
    });
    assert.deepStrictEqual(logged, []);
    assert.strictEqual(db.tables.complaints.filter((c) => c.status === 'resolved').length, 5);
  });

  // ====================================================================
  // Undo
  // ====================================================================

  asyncTest('page contract — an Undo that only partly worked (the second group refused): the server says reopened 80 and failed 20, the page says so in plain words, never says the batch was undone, keeps an Undo button, and a second Undo finishes it', async () => {
    const w = oldItems(100);
    const hooks = {};
    const db = w.db(hooks);
    const m = mount(db);
    const panel = m.panel();
    await quiet(async () => {
      await panel.open();
      await previewAndClose(panel);
      assert.ok(/Closed 100 items\./.test(panel.screenText()));
      const batchId = db.tables.audit_log.find((r) => r.action === A.batchStarted).entity_id;

      let groups = 0;
      hooks.fail = (q) => (isCompUpdate(q) && q.patch && q.patch.status === 'open' && (groups += 1) === 2 ? { message: 'update refused' } : null);
      const listsBefore = panel.record.listRefreshes;
      const batchGetsBefore = panel.record.fetches.filter((f) => f.method === 'GET' && f.url.endsWith('/batches')).length;
      assert.ok(await panel.press({ 'data-co': 'undo', 'data-batch': batchId }));
      assert.ok(panel.record.listRefreshes > listsBefore, 'a partly failed undo refreshes the list behind the window');
      assert.ok(panel.record.fetches.filter((f) => f.method === 'GET' && f.url.endsWith('/batches')).length > batchGetsBefore, 'and Recent batches');
      assert.strictEqual(groups, 2, 'the second group was tried and refused');
      assert.strictEqual(db.tables.complaints.filter((c) => c.status === 'open').length, 80, 'the server really reopened 80');
      assert.strictEqual(db.tables.complaints.filter((c) => c.status === 'resolved').length, 20, 'and 20 are still closed');
      const text = panel.screenText();
      assert.ok(text.includes('Reopened 80 items. 20 items could not be reopened and are still closed. Press Undo again to finish.'), text);
      assert.ok(!/This batch was undone/i.test(text), 'never says the batch was undone');
      assert.ok(!/Closed 100 items/.test(text), 'and no longer claims it is simply closed');
      const again = panel.undoButton(batchId);
      assert.ok(again && !again.disabled, 'an Undo button is still there and can be pressed');

      // the same, read from Recent batches in a fresh window
      await reopen(panel);
      const listed = panel.screenText();
      assert.ok(/20 of 100 still closed/.test(listed), listed);
      assert.ok(panel.undoButton(batchId) && !panel.undoButton(batchId).disabled);

      // pressing it again, with the database working, finishes the job
      hooks.fail = null;
      assert.ok(await panel.press({ 'data-co': 'undo', 'data-batch': batchId }));
      assert.strictEqual(db.tables.complaints.filter((c) => c.status === 'resolved').length, 0);
      const done = panel.screenText();
      assert.ok(/Reopened 20 items\./.test(done), done);
      assert.ok(!/could not be reopened/.test(done), done);
      assert.ok(!panel.undoButton(batchId), 'nothing left to undo');
    });
  });

  asyncTest('page contract — an Undo that only partly worked, pressed from the "Closed N items" screen straight after the close: the screen no longer says the batch was undone, and the same Undo button finishes it', async () => {
    const w = oldItems(100);
    const hooks = {};
    const db = w.db(hooks);
    const m = mount(db);
    const panel = m.panel();
    await quiet(async () => {
      await panel.open();
      await previewAndClose(panel);
      const batchId = db.tables.audit_log.find((r) => r.action === A.batchStarted).entity_id;
      let groups = 0;
      hooks.fail = (q) => (isCompUpdate(q) && q.patch && q.patch.status === 'open' && (groups += 1) === 2 ? { message: 'update refused' } : null);
      await panel.press({ 'data-co': 'undo', 'data-batch': batchId });
      const top = panel.screenText();
      assert.ok(!/This batch was undone/i.test(top), top);
      assert.ok(/still closed/.test(top), top);
      hooks.fail = null;
      assert.ok(await panel.press({ 'data-co': 'undo', 'data-batch': batchId }), 'the featured Undo can be pressed again');
      assert.ok(/This batch was undone\./.test(panel.screenText()));
    });
  });

  asyncTest('page contract — an Undo that stopped early (taken over by a newer call) is a warning, not a success, with the Undo button kept', async () => {
    const w = oldItems(200);
    let t = 0;
    const hooks = {};
    const db = w.db(hooks);
    const m = mount(db, { serviceOptions: { clock: () => t } });
    const panel = m.panel();
    await quiet(async () => {
      await panel.open();
      await previewAndClose(panel);
      const batchId = db.tables.audit_log.find((r) => r.action === A.batchStarted).entity_id;
      let first = true;
      hooks.before = (q) => {
        if (first && isCompUpdate(q) && q.patch && q.patch.status === 'open') { first = false; t += 11 * 60 * 1000; m.service.undo(uuid(9998), ACTOR); }
      };
      await panel.press({ 'data-co': 'undo', 'data-batch': batchId });
      hooks.before = null;
      const text = panel.screenText();
      assert.ok(/Reopened 80 items\./.test(text), text);
      assert.ok(/could not be reopened and are still closed/.test(text), text);
      assert.ok(/stopped early/i.test(text), text);
      assert.ok(/Press Undo again to finish/.test(text));
      assert.ok(!/This batch was undone/i.test(text));
      const again = panel.undoButton(batchId);
      assert.ok(again && !again.disabled);
    });
  });

  asyncTest('page contract — an Undo whose own record was not saved (audit_failed on the undo answer): the page says so in plain words after the reopened count', async () => {
    const w = oldItems(5);
    const hooks = {};
    const db = w.db(hooks);
    const m = mount(db);
    const panel = m.panel();
    await quiet(async () => {
      await panel.open();
      await previewAndClose(panel);
      const batchId = db.tables.audit_log.find((r) => r.action === A.batchStarted).entity_id;
      hooks.fail = (q) => (isAuditInsert(q) && q.rows[0].action === A.batchUndone ? { message: 'down' } : null);
      await panel.press({ 'data-co': 'undo', 'data-batch': batchId });
      const text = panel.screenText();
      assert.ok(/Reopened 5 items\./.test(text), text);
      assert.ok(/The record of this undo was not fully saved, so please tell Peter or Jarvis\./.test(text), text);
      assert.strictEqual(db.tables.complaints.filter((c) => c.status === 'resolved').length, 0);
    });
  });

  asyncTest('page contract — an Undo answer that says stopped_early but no failed count is still a warning with the Undo button kept (the page does not rely on the two always arriving together)', async () => {
    const w = oldItems(5);
    const db = w.db();
    const m = mount(db);
    const synthetic = async (url, opts) => {
      if (String(url).endsWith('/undo')) {
        const body = { batch_id: String(url).split('/').slice(-2)[0], reopened: 3, skipped_changed: 0, stopped_early: true };
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      }
      return m.fetchImpl(url, opts);
    };
    const panel = loadPanel({ fetchImpl: synthetic });
    await quiet(async () => {
      await panel.open();
      await previewAndClose(panel);
      const batchId = db.tables.audit_log.find((r) => r.action === A.batchStarted).entity_id;
      await panel.press({ 'data-co': 'undo', 'data-batch': batchId });
      const text = panel.screenText();
      assert.ok(/Reopened 3 items\./.test(text), text);
      assert.ok(/stopped early/i.test(text) && /Press Undo again to finish/.test(text), text);
      assert.ok(!/This batch was undone/i.test(text));
      const again = panel.undoButton(batchId);
      assert.ok(again && !again.disabled);
    });
  });

  asyncTest('page contract — a close with audit_failed: the done screen says the record was not fully saved and gives the batch id; after Undo the sentence still reads sensibly', async () => {
    const w = oldItems(5);
    const db = w.db({ fail: (q) => (isAuditInsert(q) && q.rows[0].action === A.batchClosed ? { message: 'down' } : null) });
    const m = mount(db);
    const panel = m.panel();
    await quiet(async () => {
      await panel.open();
      await previewAndClose(panel);
      const batchId = db.tables.audit_log.find((r) => r.action === A.batchStarted).entity_id;
      const text = panel.screenText();
      assert.ok(/Closed 5 items\./.test(text), text);
      assert.ok(/record of it was not fully saved/.test(text), text);
      assert.ok(text.includes(batchId), 'the batch id is shown');

      await panel.press({ 'data-co': 'undo', 'data-batch': batchId });
      const after = panel.screenText();
      assert.ok(/This batch was undone\./.test(after), after);
      assert.ok(/Reopened 5 items\./.test(after));
      assert.ok(/record of it was not fully saved/.test(after), 'the warning stays');
      assert.ok(/When this batch was closed, the record of it was not fully saved/.test(after), `says it was about the close, in the right place: ${after}`);
      assert.ok(!/Closed 5 items/.test(after), 'and does not say Closed 5 above a message saying they were reopened');
    });
  });

  // ====================================================================
  // Recent batches: every state the server sends
  // ====================================================================

  asyncTest('page contract — a batch whose end row was refused is listed as UNFINISHED (the server sends state "unfinished" and the live count in closed); its Undo works and the card does not turn into "Closed 0 items"', async () => {
    const w = oldItems(5);
    const db = w.db({ fail: (q) => (isAuditInsert(q) && q.rows[0].action === A.batchClosed ? { message: 'down' } : null) });
    const m = mount(db);
    const panel = m.panel();
    await quiet(async () => {
      await panel.open();
      await previewAndClose(panel);
      const batchId = db.tables.audit_log.find((r) => r.action === A.batchStarted).entity_id;
      // the real answer the page is about to read
      const real = JSON.parse(await (await m.fetchImpl('/api/complaint-tracking/bulk-close/batches')).text());
      const row = real.batches.find((b) => b.batch_id === batchId);
      assert.strictEqual(row.state, 'unfinished');
      assert.strictEqual(row.closed, 5, 'for an unfinished batch the server puts the live still-closed count in closed');
      assert.strictEqual(row.still_closed, 5);
      assert.ok(typeof row.closed_at === 'string');

      await reopen(panel);
      const text = panel.screenText();
      const startedAt = db.tables.audit_log.find((r) => r.action === A.batchStarted).created_at;
      const startedOn = new Date(startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      assert.ok(text.includes(`Unfinished batch started on ${startedOn} at `), `the start time (closed_at) is shown: ${text}`);
      assert.ok(/Unfinished batch started on /.test(text), text);
      assert.ok(/stopped before its final record was saved/.test(text), text);
      noClaimOfClosing(text);
      assert.ok(/5 items still closed/.test(text), `says how many are still closed, not "all still closed": ${text}`);
      const undo = panel.undoButton(batchId);
      assert.ok(undo && !undo.disabled, 'a working Undo');

      await panel.press({ 'data-co': 'undo', 'data-batch': batchId });
      assert.strictEqual(db.tables.complaints.filter((c) => c.status === 'resolved').length, 0);
      const after = panel.screenText();
      assert.ok(/Reopened 5 items\./.test(after), after);
      assert.ok(!/Closed 0 items/.test(after), 'not "Closed 0 items" after undoing an unfinished batch');
      noClaimOfClosing(after);
      assert.ok(/nothing is still closed/.test(after), `the card now says nothing is still closed: ${after}`);
    });
  });

  asyncTest('page contract — Recent batches in each state the server sends: running says it is still running, unknown says the record could not be read, neither claims "Closed N"; finished does', async () => {
    // batch one closes normally; items 11 to 13 become eligible only afterwards, for a second batch that never answers
    const w = oldItems(3);
    for (let n = 11; n <= 13; n += 1) w.add(n, 200, { blocked_since: iso(NOW - 300 * DAY) });
    const hooks = {};
    const db = w.db(hooks);
    const m = mount(db, { batchesCacheMs: 0 }); // the answer must follow the hooks below, so no remembered answers here
    await quiet(async () => {
      const first = m.panel();
      await first.open();
      await previewAndClose(first);
      assert.ok(/Closed 3 items\./.test(first.screenText()));
      const finishedId = db.tables.audit_log.find((r) => r.action === A.batchStarted).entity_id;

      for (const c of db.tables.complaints) if (c.blocked_since) c.blocked_since = null;
      const asJson = async (url) => JSON.parse(await (await m.fetchImpl(url)).text());
      const pre = await asJson('/api/complaint-tracking/bulk-close/preview?older_than_days=90&hold_back_urgent=true&hold_back_legal=false');
      assert.strictEqual(pre.eligible, 3);
      let hung = false;
      hooks.fail = (q) => { if (isCompUpdate(q) && !hung) { hung = true; return { hang: true }; } return null; };
      // this call never answers (the process died, the connection froze): it is "running" as far as anyone can tell
      m.fetchImpl('/api/complaint-tracking/bulk-close', { method: 'POST', body: JSON.stringify({ older_than_days: 90, hold_back_urgent: true, hold_back_legal: false, expected_count: 3, expected_hash: pre.set_hash }) });
      await new Promise((r) => setTimeout(r, 60));
      assert.ok(hung, 'the second close reached its first group');
      hooks.fail = null;

      const viewer = m.panel();
      await viewer.open();
      const text = viewer.screenText();
      const runningId = db.tables.audit_log.filter((r) => r.action === A.batchStarted).find((r) => r.entity_id !== finishedId).entity_id;
      const real = await asJson('/api/complaint-tracking/bulk-close/batches');
      assert.strictEqual(real.batches.find((b) => b.batch_id === runningId).state, 'running');
      assert.strictEqual(real.batches.find((b) => b.batch_id === finishedId).state, 'finished');
      assert.ok(/is still running/.test(text), text);
      assert.ok(/Closed 3 items on /.test(text), 'the finished batch still says Closed 3');
      assert.strictEqual((text.match(/Closed \d[\d,]* items? on /g) || []).length, 1, 'and only that one claims a number');

      // the record of how batches ended cannot be read: every batch is "unknown"
      hooks.fail = (q) => (q.table === 'audit_log' && q.op === 'select' && q.filters.some((f) => f.col === 'action' && f.val === A.batchClosed) ? { message: 'down' } : null);
      const lost = m.panel();
      await lost.open();
      const lostText = lost.screenText();
      const real2 = await asJson('/api/complaint-tracking/bulk-close/batches');
      assert.ok(real2.batches.length >= 2 && real2.batches.every((b) => b.state === 'unknown'), JSON.stringify(real2.batches.map((b) => b.state)));
      assert.ok(/could not be read/.test(lostText), lostText);
      noClaimOfClosing(lostText);
      for (const b of real2.batches) {
        const undo = lost.undoButton(b.batch_id);
        assert.ok(undo, 'every batch has an Undo button');
        // with something still closed (or an unknown number) it can be pressed; the batch that never changed anything has nothing to undo
        assert.strictEqual(undo.disabled, b.still_closed === 0, `Undo for a batch with ${b.still_closed} still closed`);
      }
      assert.ok(real2.batches.some((b) => b.still_closed > 0), 'at least one batch has items to undo');
    });
  });

  // ====================================================================
  // A close that fails
  // ====================================================================

  asyncTest('page contract — a close whose start row cannot be saved: the server answers 500 with its plain sentence, the page shows that sentence (not "some items may already have been closed"), and still refreshes the list and Recent batches', async () => {
    const w = oldItems(5);
    const hooks = {};
    const db = w.db(hooks);
    const m = mount(db);
    const panel = m.panel();
    await quiet(async () => {
      await panel.open();
      await panel.preview();
      await panel.press({ 'data-co': 'to-confirm' });
      hooks.fail = (q) => (isAuditInsert(q) && q.rows[0].action === A.batchStarted ? { message: 'down' } : null);
      const listsBefore = panel.record.listRefreshes;
      const batchGetsBefore = panel.record.fetches.filter((f) => f.method === 'GET' && f.url.endsWith('/batches')).length;
      await panel.press({ 'data-co': 'do-close' });
      await panel.settle();
      const text = panel.screenText();
      assert.ok(text.includes('The record of this close could not be saved, so nothing was changed.'), text);
      assert.ok(!/Some items may already have been closed/.test(text), text);
      assert.strictEqual(db.writesTo('complaints', 'update').length, 0, 'and indeed nothing was changed');
      assert.ok(panel.record.listRefreshes > listsBefore, 'the list behind the window was refreshed');
      assert.ok(panel.record.fetches.filter((f) => f.method === 'GET' && f.url.endsWith('/batches')).length > batchGetsBefore, 'Recent batches was reloaded');
    });
  });

  asyncTest('page contract — a database failure the route reports as a plain 500 (no sentence from the service) still gets the cautious wording', async () => {
    const w = oldItems(5);
    const hooks = {};
    const db = w.db(hooks);
    const m = mount(db);
    const panel = m.panel();
    await quiet(async () => {
      await panel.open();
      await panel.preview();
      await panel.press({ 'data-co': 'to-confirm' });
      hooks.fail = (q) => (q.table === 'complaints' && q.op === 'select' ? { message: 'down' } : null); // the close re-reads everything: the route answers 500
      await panel.press({ 'data-co': 'do-close' });
      const text = panel.screenText();
      assert.ok(/Could not close the old items\. Nothing further was changed/.test(text) || /Something went wrong while closing/.test(text), text);
      assert.ok(!/ZZ-|password|postgres/i.test(text));
    });
  });

  asyncTest('page contract — a close that stopped early (taken over by a newer call): closed 80, failed 120, and the page says it stopped early in plain words, with a way to close the rest', async () => {
    const w = oldItems(200);
    let t = 0;
    const hooks = {};
    const db = w.db(hooks);
    const m = mount(db, { serviceOptions: { clock: () => t } });
    const panel = m.panel();
    await quiet(async () => {
      await panel.open();
      await panel.preview();
      await panel.press({ 'data-co': 'to-confirm' });
      let first = true;
      hooks.before = (q) => { if (first && isCompUpdate(q)) { first = false; t += 11 * 60 * 1000; m.service.undo(uuid(9997), ACTOR); } };
      await panel.press({ 'data-co': 'do-close' });
      hooks.before = null;
      const text = panel.screenText();
      assert.ok(/Closed 80 items\./.test(text), text);
      assert.ok(/120 items could not be closed and were left open/.test(text), text);
      assert.ok(/stopped early/i.test(text), text);
      assert.ok(panel.button({ 'data-co': 'more' }), 'Close more items is offered');
    });
  });

  // ====================================================================
  // The preview
  // ====================================================================

  asyncTest('page contract — a preview that could not finish (lookup_incomplete): the page says the check could not finish and the red Close button stays off', async () => {
    const w = oldItems(6);
    const db = w.db({ fail: (q) => (q.table === 'missive_message_intake' ? { message: 'down' } : null) });
    const m = mount(db);
    const panel = m.panel();
    await quiet(async () => {
      await panel.open();
      await panel.preview();
      const text = panel.screenText();
      assert.ok(/<h3[^>]*id="coPrevHead"[^>]*>The check could not finish<\/h3>/.test(panel.screenHtml()), 'the headline itself says so');
      assert.ok(/Some checks could not finish/.test(text), text);
      const close = panel.button({ 'data-co': 'to-confirm' });
      assert.ok(close && close.disabled, 'Close is off');
      assert.strictEqual(await panel.press({ 'data-co': 'to-confirm' }), false);
      assert.ok(!/will be closed/.test(text));
    });
  });

  asyncTest('page contract — a preview that only PARTLY finished (some items counted, the rest could not be checked): the count is shown as "so far", it cannot be closed from, and Close stays off', async () => {
    const w = oldItems(160);
    // the second group of 80 conversations cannot be looked up
    const db = w.db({ fail: (q) => (q.table === 'missive_message_intake' && q.filters.some((f) => f.kind === 'in' && f.val.includes('conv-150')) ? { message: 'down' } : null) });
    const m = mount(db);
    const panel = m.panel();
    await quiet(async () => {
      await panel.open();
      await panel.preview();
      const real = JSON.parse(await (await m.fetchImpl('/api/complaint-tracking/bulk-close/preview?older_than_days=90&hold_back_urgent=true&hold_back_legal=false')).text());
      assert.strictEqual(real.lookup_incomplete, true);
      assert.ok(real.eligible > 0 && real.eligible < 160, `some were counted: ${real.eligible}`);
      const text = panel.screenText();
      assert.ok(/<h3[^>]*id="coPrevHead"[^>]*>The check could not finish<\/h3>/.test(panel.screenHtml()), text);
      assert.ok(/Counted so far: \d+ items\. Nothing can be closed from this count\./.test(text), text);
      const close = panel.button({ 'data-co': 'to-confirm' });
      assert.ok(close && close.disabled, 'Close is off even though items were counted');
      assert.strictEqual(await panel.press({ 'data-co': 'to-confirm' }), false);
    });
  });

  // ====================================================================
  // The wording: every sentence about the legal group names the whole group
  // ====================================================================

  asyncTest('page contract — every sentence about the legal group says "tagged legal exposure or with a rejected owner instruction": the box and its hint, "Of these, N ...", the confirm screen, the "Not being closed" line, and the settings of a batch in Recent batches; the Fair Housing sentence is kept word for word', async () => {
    const w = oldItems(0);
    w.add(1, 200);
    w.add(2, 200, { category: 'legal_exposure' });
    w.add(3, 200, { owner_instruction_rejected: 'true' });
    w.add(4, 200, { owner_instruction_rejected: 'uncertain' });
    w.add(5, 200, { category: 'accommodation_related' });
    const db = w.db();
    const m = mount(db);
    const panel = m.panel();
    await quiet(async () => {
      await panel.open();
      const form = panel.screenText();
      assert.ok(form.includes(`Also hold back items tagged legal exposure ${GROUP_SUFFIX}`), form);
      assert.ok(form.includes(FAIR_HOUSING_SENTENCE), 'the exact Fair Housing sentence');
      assert.ok(!NAMES_ONLY_HALF.test(form), `the form names half the group: ${form}`);

      // default boxes: the group is part of the count, and the page says how many
      await panel.preview();
      const preview = panel.screenText();
      assert.ok(/4 items will be closed/.test(preview), preview);
      assert.ok(/Of these, 3 items tagged legal exposure or with a rejected owner instruction will be closed too/.test(preview), preview);
      assert.ok(!NAMES_ONLY_HALF.test(preview), `the preview names half the group: ${preview}`);
      assert.ok(preview.includes(FAIR_HOUSING_SENTENCE) || /Flagged for Fair Housing or marked as accommodation requests.*always kept open/.test(preview));
      await panel.press({ 'data-co': 'to-confirm' });
      const confirm = panel.screenText();
      assert.ok(/3 items tagged legal exposure or with a rejected owner instruction will be closed too/.test(confirm), confirm);
      assert.ok(!NAMES_ONLY_HALF.test(confirm), `the confirm screen names half the group: ${confirm}`);
      assert.ok(confirm.includes('Items flagged for Fair Housing or marked as accommodation requests are always kept open'));
      await panel.press({ 'data-co': 'back' });

      // box ticked: they move to "Not being closed", and the confirm screen says they are not included
      await panel.tick('coHoldLegal', true);
      await panel.preview();
      const held = panel.screenText();
      assert.ok(/1 item will be closed/.test(held), held);
      assert.ok(/Tagged legal exposure or with a rejected owner instruction: 3 \(held back, because that box is ticked\)/.test(held), held);
      assert.ok(!NAMES_ONLY_HALF.test(held), `the "Not being closed" list names half the group: ${held}`);
      await panel.press({ 'data-co': 'to-confirm' });
      const confirmHeld = panel.screenText();
      assert.ok(/Items tagged legal exposure or with a rejected owner instruction are not included \(3 held back\)/.test(confirmHeld), confirmHeld);
      assert.ok(!NAMES_ONLY_HALF.test(confirmHeld));
      await panel.press({ 'data-co': 'do-close' });
      await panel.settle();

      // Recent batches: a batch closed with the box ticked, and one closed with it unticked
      await reopen(panel);
      const heldBatch = panel.screenText();
      assert.ok(/items tagged legal exposure or with a rejected owner instruction held back/.test(heldBatch), heldBatch);
      assert.ok(!NAMES_ONLY_HALF.test(heldBatch), `Recent batches names half the group: ${heldBatch}`);
      await panel.preview(); // the box starts unticked in a fresh window
      await panel.press({ 'data-co': 'to-confirm' });
      await panel.press({ 'data-co': 'do-close' });
      await panel.settle();
      await reopen(panel);
      const both = panel.screenText();
      assert.ok(/items tagged legal exposure or with a rejected owner instruction included/.test(both), both);
      assert.ok(!NAMES_ONLY_HALF.test(both));
    });
  });

  asyncTest('page contract — when none of the items to close are in the legal group, the page says so naming the whole group, on the preview and on the confirm screen', async () => {
    const w = oldItems(3);
    const m = mount(w.db());
    const panel = m.panel();
    await quiet(async () => {
      await panel.open();
      await panel.preview();
      const preview = panel.screenText();
      assert.ok(/3 items will be closed/.test(preview), preview);
      assert.ok(preview.includes('No items tagged legal exposure or with a rejected owner instruction are in this count.'), preview);
      assert.ok(!NAMES_ONLY_HALF.test(preview));
      await panel.press({ 'data-co': 'to-confirm' });
      const confirm = panel.screenText();
      assert.ok(confirm.includes('Items tagged legal exposure or with a rejected owner instruction are not held back, because that box is not ticked (none are in this batch).'), confirm);
      assert.ok(!NAMES_ONLY_HALF.test(confirm));
    });
  });
}

module.exports = { register };
