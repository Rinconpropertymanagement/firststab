#!/usr/bin/env node
/**
 * test/render-samples-unscreened.js
 *
 * Prints the whole Work Order Alert email for the owner's "content screen off"
 * switch (WORK_ORDER_ALERT_DESCRIPTION_SCREEN=off), next to the same text with
 * the screen ON, so Peter can read the real wording. SYNTHETIC DATA ONLY; the
 * same stubbed harness as the tests, so nothing is sent and nothing real is
 * contacted:
 *   node projects/hub/approval-briefing/test/render-samples-unscreened.js
 *
 * Every sample runs with the mode "on" and the ingestion interlock set (what the
 * live email would look like once everything is approved).
 */

const H = require('./harness');
const { baseProperty, baseJob } = require('./scenarios');

const alert = H.load('lib/work-order-notes-alert.js');
const clone = (o) => JSON.parse(JSON.stringify(o));

const UNASSIGNED = () => baseProperty({ id: 'prop-0003', pod: null, latchel_property_id: '900003' });

const SAMPLES = [
  {
    title: 'A. SCREEN ON (unchanged): an ordinary text',
    screen: undefined,
    job: baseJob({ job_id: 7001, order_number: 9001, name: 'Kitchen faucet leaking', description: 'Tenant reports the kitchen faucet drips constantly and water pools under the sink cabinet.' }),
  },
  {
    title: 'B. SCREEN OFF: the same ordinary text',
    screen: 'off',
    job: baseJob({ job_id: 7001, order_number: 9001, name: 'Kitchen faucet leaking', description: 'Tenant reports the kitchen faucet drips constantly and water pools under the sink cabinet.' }),
  },
  {
    title: 'C. SCREEN ON (unchanged): a sensitive synthetic text is held',
    screen: undefined,
    job: baseJob({ job_id: 7002, order_number: 9002, name: 'Locks', description: 'My husband hit me last night, I need the locks changed. I use a wheelchair and I am undocumented.' }),
  },
  {
    title: 'D. SCREEN OFF: the same sensitive synthetic text, shown word for word (nothing is held; this is what Peter chose)',
    screen: 'off',
    job: baseJob({ job_id: 7002, order_number: 9002, name: 'Locks', description: 'My husband hit me last night, I need the locks changed. I use a wheelchair and I am undocumented.' }),
  },
  {
    title: 'E. SCREEN OFF: the never-store mask (SSN, card number, bank account, routing number and password replaced; phone, e-mail, name, gate code and ticket numbers left alone)',
    screen: 'off',
    job: baseJob({ job_id: 7003, order_number: 9003, name: 'Tenant payment help', description: 'Maria Lopez (maria@example.com, 951-555-1234) gave SSN 123-45-6789, card 4111 1111 1111 1111, account 123456789012, routing 021000021. Wi-Fi password: Hunter22!. Gate code 2040, unit 5B, ticket 483921, $1,250.00 due 10/17/2026.' }),
  },
  {
    title: 'E2. SCREEN OFF: the mask in round 5 (a card in an unusual grouping with no card word, four unit numbers left alone, a password after filler words, a bare SWIFT code, a real date vs a number after "account")',
    screen: 'off',
    job: baseJob({ job_id: 7007, order_number: 9007, name: 'Billing question for units 4521 4522 4523 4524', description: 'Tenant paid with 4111 11111 11111 11 last week. The password for the portal is hunter2. Wire via SWIFT: DEUTDEFF, account 12-34-5678 or account 2026-10-17. Ticket 4421-5532-6643-7754.' }),
  },
  {
    title: 'F. SCREEN ON (unchanged): unassigned pod, pointer only',
    screen: undefined,
    property: UNASSIGNED(),
    job: baseJob({ job_id: 7004, order_number: 9004, property_id: 900003, name: 'Kitchen faucet leaking', description: 'Faucet drips.' }),
  },
  {
    title: 'G. SCREEN OFF: unassigned pod (the text goes to both inboxes, nothing is held)',
    screen: 'off',
    property: UNASSIGNED(),
    job: baseJob({ job_id: 7004, order_number: 9004, property_id: 900003, name: 'Kitchen faucet leaking', description: 'Faucet drips.' }),
  },
  {
    title: 'H. SCREEN OFF: a web address and markup in the text (links replaced, markup removed, the rest shown)',
    screen: 'off',
    job: baseJob({ job_id: 7005, order_number: 9005, name: 'Visit', description: 'Call about it.Support the lid <b>now</b> see http://evil.example/login and evil.zone, 5" pipe.' }),
  },
  {
    title: 'I. SCREEN OFF: text that cannot be made safe to print (nested markup that will not settle): the neutral line, not a hold',
    screen: 'off',
    job: baseJob({ job_id: 7006, order_number: 9006, name: 'Visit', description: `Faucet drips. &${'amp;'.repeat(9)}lt;b&${'amp;'.repeat(9)}gt; thanks` }),
  },
];

function blockOf(text) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.startsWith('Created:'));
  const j = lines.findIndex((l) => l.startsWith('View this property:'));
  return lines.slice(i + 2, j - 1);
}

async function main() {
  for (const s of SAMPLES) {
    H.reset();
    process.env.WORK_ORDER_ALERT_DESCRIPTION_MODE = 'on';
    process.env.WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED = 'yes';
    if (s.screen !== undefined) process.env.WORK_ORDER_ALERT_DESCRIPTION_SCREEN = s.screen;
    H.db.tables.properties.push(clone(s.property || baseProperty()));
    await alert.handleWorkOrderJob(clone(s.job), 'webhook');
    const m = H.mail.sent[0];
    const audit = H.db.writes.filter((w) => w.table === 'audit_log' && w.payload.action === 'work_order_note_alert.description_checked').map((w) => w.payload)[0];
    process.stdout.write(`\n${'='.repeat(78)}\n${s.title}\n${'='.repeat(78)}\n`);
    process.stdout.write(`To:      ${m.to.join(', ')}\nSubject: ${m.subject}\n\n${m.text}\n`);
    const block = blockOf(m.text);
    process.stdout.write(`[block: ${block.join('\n').length} characters over ${block.length} line${block.length === 1 ? '' : 's'}; audit: result=${audit.details.result} cause=${audit.details.cause} screen_version=${audit.details.screen_version} risk=${audit.risk_level}]\n`);
  }
}

main().catch((err) => { process.stderr.write(`${err.stack}\n`); process.exit(1); });
