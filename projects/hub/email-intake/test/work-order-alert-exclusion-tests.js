#!/usr/bin/env node
/**
 * test/work-order-alert-exclusion-tests.js
 *
 * Tests for the prepared (NOT enabled, NOT deployed) change that stops the
 * Missive intake from copying the Hub's own "Work Order Alert" emails into
 * missive_message_intake: lib/shared.js isWorkOrderAlertMessage / storeMessage,
 * and the two callers that count a skipped message as "excluded", not "stored"
 * (router.js's incremental sync and backfill-missive-history.js).
 *
 *   node projects/hub/email-intake/test/work-order-alert-exclusion-tests.js
 *
 * SAFETY: no network, no real Supabase, no real Missive. Supabase and the
 * Missive connector are replaced in require.cache before anything loads.
 * Every message below is invented.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const HUB_DIR = path.resolve(__dirname, '../..');
const INTAKE_DIR = path.resolve(__dirname, '..');

process.env.SUPABASE_URL = 'https://placeholder.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder';

// ─── Fakes ──────────────────────────────────────────────────────────────────
const db = { upserts: [], inserts: [], updates: [], failAudit: false, existing: [] };
let rowCounter = 0;

class Query {
  constructor(table) { this.table = table; this.op = 'select'; }
  upsert(row) { this.op = 'upsert'; this.payload = row; return this; }
  insert(row) { this.op = 'insert'; this.payload = row; return this; }
  update(row) { this.op = 'update'; this.payload = row; return this; }
  select() { return this; }
  eq() { return this; }
  single() { return this; }
  then(resolve, reject) {
    try {
      if (this.op === 'upsert') {
        db.upserts.push({ table: this.table, row: this.payload });
        rowCounter += 1;
        return Promise.resolve({ data: { id: `row-${rowCounter}` }, error: null }).then(resolve, reject);
      }
      if (this.op === 'insert') {
        if (db.failAudit && this.table === 'audit_log') throw new Error('audit write failed');
        db.inserts.push({ table: this.table, row: this.payload });
        return Promise.resolve({ error: null }).then(resolve, reject);
      }
      if (this.op === 'update') {
        db.updates.push({ table: this.table, row: this.payload });
        return Promise.resolve({ error: null }).then(resolve, reject);
      }
      return Promise.resolve({ data: db.existing.map((id) => ({ missive_message_id: id })), error: null }).then(resolve, reject);
    } catch (err) { return Promise.reject(err).then(resolve, reject); }
  }
}

function seed(filename, exports) {
  const m = new Module(filename);
  m.filename = filename; m.loaded = true; m.exports = exports;
  require.cache[filename] = m;
}

const missiveState = { conversationMessages: [], fullById: {}, getMessageCalls: [] };
seed(require.resolve('@supabase/supabase-js', { paths: [HUB_DIR] }), { createClient: () => ({ from: (t) => new Query(t) }) });
seed(path.join(INTAKE_DIR, 'lib/missive-connector.js'), {
  listConversationsPage: async () => [],
  listConversationMessagesPage: async () => { const page = missiveState.conversationMessages; missiveState.conversationMessages = []; return page; },
  getMessage: async (id) => { missiveState.getMessageCalls.push(id); return missiveState.fullById[id]; },
});

const shared = require(path.join(INTAKE_DIR, 'lib/shared.js'));
const { storeMessage, isWorkOrderAlertMessage, workOrderAlertExclusionReason, HUB_NOTIFICATION_SENDER } = shared;

// ─── Tiny runner ────────────────────────────────────────────────────────────
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function reset() { db.upserts.length = 0; db.inserts.length = 0; db.updates.length = 0; db.failAudit = false; db.existing = []; missiveState.getMessageCalls.length = 0; missiveState.conversationMessages = []; missiveState.fullById = {}; }

let idCounter = 0;
const uuid = () => { idCounter += 1; return `00000000-0000-4000-8000-${String(idCounter).padStart(12, '0')}`; };
const msg = (over) => Object.assign({
  id: uuid(), subject: 'Work Order Alert — 123 Test Street Unit A has special handling notes',
  from_field: { address: 'noreply@rinconmanagement.com', name: 'Rincon Hub' },
  to_fields: [{ address: 'solimar-pod@example.test' }], delivered_at: 1760000000, body: '<p>SECRET-BODY-TEXT A new work order was just created.</p>',
}, over);
const store = (m) => storeMessage({ mailboxKey: 'team:ab0d3661-fb4c-498c-a311-94c6978530d6', conversationId: 'conv-1', message: m });
const storedRows = () => db.upserts.filter((u) => u.table === 'missive_message_intake');
const exclusionEvents = () => db.inserts.filter((i) => i.table === 'audit_log' && i.row.action === 'email_intake.work_order_alert_excluded').map((i) => i.row);

// ════════════════════════════════════════════════════════════════════════
test('E1 an exact Hub alert is skipped: nothing is written to missive_message_intake, one counts-only audit event is', async () => {
  reset();
  const m = msg();
  const result = await store(m);
  assert.strictEqual(result, null);
  assert.strictEqual(storedRows().length, 0, 'no row, no stub');
  assert.strictEqual(db.updates.length, 0, 'no body_text');
  const events = exclusionEvents();
  assert.strictEqual(events.length, 1);
  assert.strictEqual(db.inserts.filter((i) => i.row.action === 'missive_message_intake.stored').length, 0, 'no "stored" event either');
  assert.deepStrictEqual(Object.keys(events[0].details).sort(), ['mailbox_key', 'missive_conversation_id', 'missive_message_id', 'reason']);
  assert.strictEqual(events[0].details.reason, 'sender_and_subject');
  assert.strictEqual(events[0].details.missive_message_id, m.id);
  assert.strictEqual(events[0].details.missive_conversation_id, 'conv-1');
  assert.strictEqual(events[0].details.mailbox_key, 'team:ab0d3661-fb4c-498c-a311-94c6978530d6');
  assert.strictEqual(events[0].entity_id, m.id);
  assert.strictEqual(events[0].actor_type, 'system'); assert.strictEqual(events[0].risk_level, 'low');
});

test('E2 the audit event never carries the subject, an address or the body', async () => {
  reset();
  await store(msg());
  const blob = JSON.stringify(db);
  for (const bad of ['SECRET-BODY-TEXT', 'Work Order Alert', 'noreply', 'rinconmanagement', 'special handling', 'solimar-pod']) assert.ok(!blob.includes(bad), `found ${bad}`);
});

test('E3 Re:, Fw:, Fwd: forms (any case, repeated, with or without spaces) are skipped', async () => {
  for (const subject of ['Re: Work Order Alert — x', 'RE: Work Order Alert', 'Fw: Work Order Alert — x', 'FW: Work Order Alert', 'Fwd: Work Order Alert - x', 'fwd:work order alert - x',
    'Re: Fwd: Re: Work Order Alert — x', '  Re:   Work Order Alert  ', 'RE:FW:FWD:Work Order Alert']) {
    reset();
    assert.strictEqual(workOrderAlertExclusionReason(msg({ subject })), 'sender_and_subject', subject);
    assert.strictEqual(await store(msg({ subject })), null, subject);
    assert.strictEqual(storedRows().length, 0);
  }
});

test('E4 em dash, hyphen, colon and bare subjects are skipped; the case of the words does not matter', async () => {
  for (const subject of ['Work Order Alert — 123 Test St has special handling notes', 'Work Order Alert - 123 Test St has special handling notes', 'Work Order Alert: x', 'Work Order Alert', 'work order alert — x', 'WORK ORDER ALERT — X']) {
    assert.ok(isWorkOrderAlertMessage(msg({ subject })), subject);
  }
});

test('E5 the Hub sender is matched case-insensitively and trimmed', async () => {
  for (const address of ['NoReply@RinconManagement.com', ' noreply@rinconmanagement.com', 'noreply@rinconmanagement.com  ', 'NOREPLY@RINCONMANAGEMENT.COM']) {
    assert.strictEqual(workOrderAlertExclusionReason(msg({ from_field: { address } })), 'sender_and_subject', JSON.stringify(address));
  }
});

test('E6 near-miss senders with the alert subject are STORED (look-alike domains, suffixes, subdomains, wrong tld, two @)', async () => {
  for (const address of ['noreply@rinconmanagement.com.evil.test', 'noreply@rinconmanagernent.com', 'noreply@rinconmanagement.co', 'noreply@mail.rinconmanagement.com',
    'noreply@rinconmanagement.com@evil.test', 'evil@rinconmanagement.com.evil.test', 'noreply@rincon-management.com', 'noreply@rinconmanagement.org', 'rinconmanagement.com', 'noreply@', '@rinconmanagement.com', 'a b@rinconmanagement.com', '']) {
    reset();
    assert.strictEqual(workOrderAlertExclusionReason(msg({ from_field: { address } })), null, JSON.stringify(address));
    const id = await store(msg({ from_field: { address } }));
    assert.ok(id && /^row-/.test(id), `stored: ${JSON.stringify(address)}`);
    assert.strictEqual(storedRows().length, 1);
    assert.strictEqual(exclusionEvents().length, 0);
  }
});

test('E7 an OUTSIDE sender using the alert subject is stored normally (never subject-only)', async () => {
  for (const address of ['tenant@example.test', 'owner@gmail.com', 'vendor@acme.example', 'noreply@example.test']) {
    reset();
    const id = await store(msg({ from_field: { address }, subject: 'Re: Work Order Alert — my kitchen is flooding' }));
    assert.ok(/^row-/.test(id));
    assert.strictEqual(storedRows().length, 1);
    assert.strictEqual(db.inserts.filter((i) => i.row.action === 'missive_message_intake.stored').length, 1);
    assert.strictEqual(exclusionEvents().length, 0);
  }
});

test('E8 REPLY GUARD: an internal @rinconmanagement.com sender whose subject starts with the alert subject is skipped as "internal_reply"', async () => {
  for (const address of ['faria.lead@rinconmanagement.com', 'Peter@RinconManagement.com', 'noreply+tag@rinconmanagement.com', 'solimarteam@rinconmanagement.com']) {
    reset();
    const m = msg({ from_field: { address }, subject: 'Re: Work Order Alert — 123 Test St' });
    assert.strictEqual(workOrderAlertExclusionReason(m), 'internal_reply', address);
    assert.strictEqual(await store(m), null);
    assert.strictEqual(storedRows().length, 0);
    assert.strictEqual(exclusionEvents()[0].details.reason, 'internal_reply');
  }
});

test('E9 never sender-only: the Hub sender or an internal sender with ANY OTHER subject is stored', async () => {
  for (const subject of ['Security Deposit Reminder', 'Insurance certificate expiring', 'Work Orders Alert', 'Alert: Work Order 5001', 'Fwd: Re: Notice about Work Order Alert', 'Work Order Notes Alert failed to send — 123 Test St', 'Work Order', '', null, undefined, 42]) {
    for (const address of ['noreply@rinconmanagement.com', 'faria.lead@rinconmanagement.com']) {
      reset();
      assert.strictEqual(workOrderAlertExclusionReason(msg({ subject, from_field: { address } })), null, `${address} / ${subject}`);
      const id = await store(msg({ subject, from_field: { address } }));
      assert.ok(/^row-/.test(id));
    }
  }
});

test('E10 odd or missing fields never throw: no from_field, no subject, not an object', async () => {
  for (const m of [msg({ from_field: undefined }), msg({ from_field: null }), msg({ from_field: {} }), msg({ from_field: { address: 42 } }), msg({ subject: undefined, from_field: undefined })]) {
    assert.strictEqual(isWorkOrderAlertMessage(m), false);
  }
  for (const bad of [null, undefined, 'string', 42, []]) assert.strictEqual(isWorkOrderAlertMessage(bad), false);
});

test('E11 an ordinary message is stored exactly as before (verbatim row, "stored" audit event, body_text)', async () => {
  reset();
  const m = msg({ subject: 'Leaking faucet at 123 Test Street', from_field: { address: 'tenant@example.test' }, body: '<p>Hello <b>there</b></p>' });
  const id = await store(m);
  assert.ok(/^row-/.test(id));
  assert.strictEqual(storedRows().length, 1);
  const row = storedRows()[0].row;
  assert.strictEqual(row.subject, m.subject); assert.strictEqual(row.from_address, 'tenant@example.test'); assert.strictEqual(row.body_html, m.body);
  assert.strictEqual(db.inserts.filter((i) => i.row.action === 'missive_message_intake.stored').length, 1);
  assert.strictEqual(db.updates.length, 1); assert.strictEqual(db.updates[0].row.body_text, 'Hello there');
});

test('E12 if the exclusion audit write fails, the message is STILL not stored (and the caller sees an error, not a stored message)', async () => {
  reset();
  db.failAudit = true;
  await assert.rejects(() => store(msg()), /audit write failed/);
  assert.strictEqual(storedRows().length, 0);
});

test('E13 the sender constant equals the address lib/notify.js sends from, and the alert subject really starts with the matched text', async () => {
  const notify = fs.readFileSync(path.join(HUB_DIR, 'lib/notify.js'), 'utf8');
  const from = notify.match(/From: "Rincon Hub" <([^>]+)>/);
  assert.ok(from, 'the From header in lib/notify.js was found');
  assert.strictEqual(from[1].trim().toLowerCase(), HUB_NOTIFICATION_SENDER);
  const alertSrc = fs.readFileSync(path.join(HUB_DIR, 'approval-briefing/lib/work-order-notes-alert.js'), 'utf8');
  const subject = alertSrc.match(/const subject = `([^`$]*)\$\{/);
  assert.ok(subject, 'the alert subject template was found');
  assert.ok(subject[1].toLowerCase().startsWith('work order alert'), `alert subject starts with "${subject[1]}"`);
  assert.ok(isWorkOrderAlertMessage(msg({ subject: `${subject[1]}123 Test Street has special handling notes` })));
});

// ─── The two callers ────────────────────────────────────────────────────────
test('E14 router.js incremental sync: an alert is counted as excluded, not stored; the other messages are stored', async () => {
  reset();
  const router = require(path.join(INTAKE_DIR, 'router.js'));
  const a = msg(); const b = msg({ subject: 'Leaking faucet', from_field: { address: 'tenant@example.test' } }); const c = msg({ subject: 'Re: Work Order Alert — x', from_field: { address: 'staff@rinconmanagement.com' } }); const d = msg({ subject: 'Gate code question', from_field: { address: 'vendor@example.test' } });
  for (const m of [a, b, c, d]) missiveState.fullById[m.id] = m;
  missiveState.conversationMessages = [a, b, c, d].map((m) => ({ id: m.id, delivered_at: m.delivered_at }));
  const result = await router._syncConversationMessagesForTesting({ mailboxKey: 'team:ab0d3661-fb4c-498c-a311-94c6978530d6', teamId: 'ab0d3661-fb4c-498c-a311-94c6978530d6', conversationId: 'conv-9' });
  assert.deepStrictEqual(result, { stored: 2, excluded: 2 });
  assert.strictEqual(storedRows().length, 2);
  assert.deepStrictEqual(exclusionEvents().map((e) => e.details.reason).sort(), ['internal_reply', 'sender_and_subject']);
  const src = fs.readFileSync(path.join(INTAKE_DIR, 'router.js'), 'utf8');
  assert.ok(/messages_excluded: 0/.test(src) && /summary\.messages_excluded \+= result\.messagesExcluded/.test(src), 'the run summary reports excluded');
});

test('E15 backfill-missive-history.js: the same counters (real and dry-run), loaded without running its main()', async () => {
  reset();
  const file = path.join(INTAKE_DIR, 'backfill-missive-history.js');
  const original = fs.readFileSync(file, 'utf8');
  const tail = original.indexOf('\nmain().catch(');
  assert.ok(tail > 0, 'main() launcher found');
  const patched = `${original.slice(0, tail)}\nmodule.exports = { syncConversationMessagesBackfill };\n`;
  const m = new Module(file, module);
  m.filename = file; m.paths = Module._nodeModulePaths(INTAKE_DIR);
  m._compile(patched, file);
  const { syncConversationMessagesBackfill } = m.exports;
  const a = msg(); const b = msg({ subject: 'Leaking faucet', from_field: { address: 'tenant@example.test' } }); const c = msg({ subject: 'Fwd: Work Order Alert', from_field: { address: 'noreply@rinconmanagement.com' } });
  for (const dryRun of [false, true]) {
    reset();
    for (const x of [a, b, c]) missiveState.fullById[x.id] = x;
    missiveState.conversationMessages = [a, b, c].map((x) => ({ id: x.id, delivered_at: x.delivered_at }));
    const result = await syncConversationMessagesBackfill({ contentMailboxKey: 'team:ab0d3661-fb4c-498c-a311-94c6978530d6', teamId: 'ab0d3661-fb4c-498c-a311-94c6978530d6', conversationId: 'conv-8', dryRun });
    assert.deepStrictEqual(result, { stored: 1, excluded: 2 }, `dryRun=${dryRun}`);
    assert.strictEqual(storedRows().length, dryRun ? 0 : 1);
  }
});

test('E16 no new mailbox and no new field: the scope lock and the stored columns are unchanged', async () => {
  reset();
  assert.deepStrictEqual(shared.MISSIVE_ALLOWED_TEAM_IDS, ['b56138a6-f464-43db-a861-9bd79b07c8df', 'ab0d3661-fb4c-498c-a311-94c6978530d6']);
  await store(msg({ subject: 'Leaking faucet', from_field: { address: 'tenant@example.test' } }));
  assert.deepStrictEqual(Object.keys(storedRows()[0].row).sort(), ['bcc_addresses', 'body_html', 'cc_addresses', 'delivered_at', 'email_message_id', 'from_address', 'mailbox_key', 'missive_conversation_id', 'missive_message_id', 'subject', 'to_addresses']);
});

(async () => {
  let failures = 0;
  process.stdout.write('\nMissive intake: Work Order Alert exclusion tests\n' + '='.repeat(60) + '\n');
  for (const t of tests) {
    try { await t.fn(); process.stdout.write(`PASS  ${t.name}\n`); } catch (err) { failures++; process.stdout.write(`FAIL  ${t.name}\n      ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n      ')}\n`); }
  }
  process.stdout.write('='.repeat(60) + `\n${tests.length - failures}/${tests.length} passed\n`);
  process.exit(failures ? 1 : 0);
})();
