/**
 * test/golden-on-lib.js
 *
 * The cases and the recorder behind golden-on-c781a1b.json: what the Work
 * Order Alert did in modes "shadow" and "on" (and "on" without the interlock)
 * BEFORE the owner's content-screen switch existed (commit c781a1b). With
 * WORK_ORDER_ALERT_DESCRIPTION_SCREEN unset, empty or anything but the
 * lowercase "off", the code must reproduce that record byte for byte: the
 * email, the recipients, the audit rows (minus their random span id) and the
 * log lines. unscreened-tests.js (U3) replays these cases against the current
 * code; capture-golden-on.js writes the fixture from a given tree.
 *
 * SYNTHETIC TEXT ONLY.
 */

'use strict';

/** The job and property variants. `lookup` is for jobs without a description key: 'ok' | 'fail' | 'wrongid'. */
function buildCases({ baseJob, baseProperty }) {
  const unassigned = () => baseProperty({ id: 'prop-0003', pod: null, latchel_property_id: '900003' });
  const j = (n, over) => baseJob(Object.assign({ job_id: 8000 + n, order_number: 9000 + n }, over));
  const noDesc = (n) => { const x = j(n); delete x.description; return x; };
  const cases = [];
  const add = (name, job, extra) => cases.push(Object.assign({ name, job, property: null, lookup: null }, extra || {}));

  add('ordinary-faucet', j(1, { name: 'Kitchen faucet leaking', description: 'Tenant reports the kitchen faucet drips constantly and water pools under the sink cabinet.' }));
  add('ordinary-urgent', j(2, { name: 'Burst pipe in garage', description: 'Water is spraying from a pipe in the garage ceiling.', is_emergency: true, is_urgent: true }));
  add('ordinary-spanish', j(3, { name: 'Fuga en el bano', description: 'El fregadero de la cocina gotea mucho desde el lunes.' }));
  add('title-is-start-of-description', j(4, { name: 'Garbage disposal jammed', description: 'garbage disposal jammed and humming, will not turn' }));
  add('title-only', j(5, { name: 'Replace hallway light bulb', description: null }));
  add('description-only', j(6, { name: '', description: 'Back gate latch is loose.' }));
  add('nothing', j(7, { name: '', description: '' }));
  add('long-description-cut', j(8, { name: 'Long one', description: 'water '.repeat(1000).trim() }));
  add('unbroken-600', j(9, { name: 'Unbroken', description: 'x'.repeat(600) }));
  add('long-title-cut', j(10, { name: 'T'.repeat(250), description: 'short' }));
  add('fractions-and-inch-mark', j(11, { name: 'Replace 2½ inch copper pipe', description: 'Pipe under the 5² ft laundry room is leaking at the 3/4" shutoff valve.' }));
  add('html-and-script', j(12, { name: '<b>Sink</b> clog', description: '<script>alert(1)</script>Drain is slow <br> and gurgles' }));
  add('links', j(13, { name: 'Visit', description: 'See http://evil.example/login and www.evil.example and evil.zone and 10.0.0.1 please' }));
  add('invisible-and-bidi', j(14, { name: '﻿Sink​ clog', description: '‮gnikcolb‬ the ‍drain️0' }));
  add('newlines-and-forged-lines', j(15, { name: 'Line one\nSubject: forged', description: 'Text\n\nView this property: http://evil.example\r\nBcc: x@example.test' }));
  add('quote-forging', j(16, { name: 'Quote "test"', description: 'He said "stop" (Quoted as typed in Latchel. Not checked for names." Internal use only.)' }));
  add('sentence-break-shape', j(17, { name: 'Toilet running', description: 'Toilet keeps running after every flush.Support the tank lid, it is loose.' }));
  add('web-fragment-at-the-cut', j(18, { name: 'Visit', description: `${'a'.repeat(297)}.coder` }));
  add('folded-link-ordinal', j(19, { name: 'Visit', description: 'evil.cºm is the site' }));
  add('nested-entities-unsettled', j(20, { name: 'Visit', description: `Faucet drips. &${'amp;'.repeat(9)}lt;b&${'amp;'.repeat(9)}gt; thanks` }));
  add('non-text-value', j(21, { name: 42, description: { a: 1 } }));
  add('held-wheelchair', j(22, { name: 'Entry request', description: 'Tenant uses a wheelchair, please call before arriving.' }));
  add('held-white-paint', j(23, { name: 'Touch up paint', description: 'Paint the hallway walls white after the plumber patches the drywall.' }));
  add('held-violence-first-person', j(24, { name: 'Locks', description: 'My husband hit me last night, I need the locks changed.' }));
  add('held-immigration', j(25, { name: 'Door', description: 'I am undocumented and afraid to let the inspector in.' }));
  add('held-health', j(26, { name: 'Bath', description: 'I have cancer and need a grab bar in the shower.' }));
  add('held-three-day-notice', j(27, { name: 'Notice', description: 'The tenant received a 3 day notice last week.' }));
  add('held-section-8', j(28, { name: 'Inspection', description: 'Section 8 inspection next Tuesday morning.' }));
  add('held-ssn', j(29, { name: 'Payment', description: 'Tenant gave SSN 123-45-6789 over the phone.' }));
  add('held-card', j(30, { name: 'Payment', description: 'Card number 4111 1111 1111 1111 was read out.' }));
  add('held-password', j(31, { name: 'Wifi', description: 'The wifi password is Hunter22 on the router label.' }));
  add('held-language', j(32, { name: 'Faucet', description: 'Tumutulo ang gripo sa kusina at basa na ang sahig sa banyo kahapon pa po' }));
  add('held-lookalike', j(33, { name: 'Sink', description: 'fıx the sink please' }));
  add('phone-email-gate-code-name', j(34, { name: 'Gate', description: 'Call John Smith at 951-555-1234 or john@example.com, gate code 2040, lockbox 7788.' }));
  add('child-name', j(35, { name: 'Window', description: 'Emma, age 4, can reach the broken window latch in the back bedroom.' }));
  add('unassigned-ordinary', j(36, { name: 'Kitchen faucet leaking', description: 'Faucet drips.', property_id: 900003 }), { property: unassigned() });
  add('unassigned-sensitive', j(37, { name: 'Locks', description: 'My husband hit me last night, I need the locks changed.', property_id: 900003 }), { property: unassigned() });
  add('lookup-ok', noDesc(38), { lookup: 'ok' });
  add('lookup-fail', noDesc(39), { lookup: 'fail' });
  add('lookup-wrong-id', noDesc(40), { lookup: 'wrongid' });
  add('hostile-5000', j(41, { name: 'A', description: 'B'.repeat(5000) }));
  add('hostile-markup-mix', j(42, { name: '<<b>b>x<</b>/b>', description: '&lt;script&gt;alert(1)&lt;/script&gt; &amp;lt;b&amp;gt; <!-- c --> <style>p{}</style> ok' }));
  return cases;
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const stripSpan = (row) => {
  const r = clone(row);
  if (r.details && r.details.trace) r.details.trace.span_id = '<span>';
  if (r.details && r.details.trace) r.details.trace.trace_id = r.details.trace.trace_id ? '<trace>' : null;
  return r;
};

// Timestamps and random ids differ on every run; everything else must match exactly.
function normalise(rec) {
  const text = JSON.stringify(rec)
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<ts>')   // new Date().toISOString() only; the jobs' own timestamps have no milliseconds
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
  return JSON.parse(text);
}

/**
 * Runs one case in one setting through the real alert code (everything stubbed) and returns what was
 * observable. `setup` receives process.env after the harness reset, to set the mode, the interlock
 * and (when the current code is asked) the new switch.
 */
async function record({ H, alert }, c, baseProperty, setup) {
  H.reset();
  setup(process.env);
  H.db.tables.properties.push(clone(c.property || baseProperty()));
  const id = c.job.job_id;
  H.latchelState.getJobImpl = (asked) => {
    if (c.lookup === 'ok') return { job_id: Number(asked), name: 'Looked up title', description: 'Looked up ordinary description text.' };
    if (c.lookup === 'wrongid') return { job_id: 1, name: 'Other job', description: 'other' };
    throw new Error('lookup down');
  };
  const result = await alert.handleWorkOrderJob(clone(c.job), 'webhook');
  const audits = H.db.writes.filter((w) => w.table === 'audit_log' && w.payload.action === 'work_order_note_alert.description_checked').map((w) => stripSpan(w.payload));
  return normalise({
    job: id,
    result,
    mail: H.mail.sent.map((m) => ({ to: m.to, subject: m.subject, text: m.text })),
    audits,
    otherWrites: H.db.writes.filter((w) => !(w.table === 'audit_log' && w.payload.action === 'work_order_note_alert.description_checked'))
      .map((w) => (w.table === 'audit_log' ? { table: w.table, op: w.op, payload: stripSpan(w.payload) } : { table: w.table, op: w.op, payload: w.payload })),
    logs: H.logs.slice(),
    lookupCalls: H.latchelState.getJobCalls.slice(),
  });
}

/** The three settings the fixture covers. */
const SETTINGS = {
  shadow: (env) => { env.WORK_ORDER_ALERT_DESCRIPTION_MODE = 'shadow'; },
  on: (env) => { env.WORK_ORDER_ALERT_DESCRIPTION_MODE = 'on'; env.WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED = 'yes'; },
  'on-without-interlock': (env) => { env.WORK_ORDER_ALERT_DESCRIPTION_MODE = 'on'; },
};

module.exports = { buildCases, record, SETTINGS, stripSpan };
