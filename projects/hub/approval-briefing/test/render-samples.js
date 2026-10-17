#!/usr/bin/env node
/**
 * test/render-samples.js
 *
 * Prints the whole Work Order Alert email in each state of the optional
 * "What the work order is" block, so Peter can read the real wording before
 * anything is switched on. SYNTHETIC DATA ONLY; the same stubbed harness as the
 * tests, so nothing is sent and nothing real is contacted:
 *   node projects/hub/approval-briefing/test/render-samples.js
 *
 * The samples run with the mode set to "on" and the ingestion interlock set,
 * which is what the live email would look like once everything is approved.
 * (In "off" and "shadow" the email has no such block at all.)
 *
 * Third fix round: the block is exactly as in the second round except that the
 * two held samples 11 and 12 are new, sample 9 shows the inch mark in place of a
 * straight double quote, and nothing quotes a sentence-break shape any more.
 * Fourth fix round: the twelve samples are unchanged in wording (every held
 * sample is still the same fixed sentence, whatever the reason); after each
 * email the script prints the length of the block, and at the end the honest
 * worst case (733 characters over 6 lines; pinned by fix-round-tests.js R18).
 */

const H = require('./harness');
const { baseProperty, baseJob } = require('./scenarios');

const alert = H.load('lib/work-order-notes-alert.js');
const clone = (o) => JSON.parse(JSON.stringify(o));

const SAMPLES = [
  {
    title: '1. SHOWN (typical): title, category guess, description, and the fixed last line',
    job: baseJob({ job_id: 6001, order_number: 8001, name: 'Kitchen faucet leaking', description: 'Tenant reports the kitchen faucet drips constantly and water pools under the sink cabinet.' }),
  },
  {
    title: '2. SHOWN, but the description was long and got shortened',
    job: baseJob({ job_id: 6002, order_number: 8002, name: 'Water heater problem', description: 'Water heater in the hall closet is making a loud popping noise when it heats and there is a little rust around the base. '.repeat(5) }),
  },
  {
    title: '3. HELD by an ordinary word (the real cost of "any match holds": "white" is a paint color here)',
    job: baseJob({ job_id: 6003, order_number: 8003, name: 'Touch up paint', description: 'Paint the hallway walls white after the plumber patches the drywall.' }),
  },
  {
    title: '4. HELD by a sensitive synthetic phrase (looks exactly like sample 3: the reason is never shown)',
    job: baseJob({ job_id: 6004, order_number: 8004, name: 'Entry request', description: 'Tenant uses a wheelchair, please call before arriving.' }),
  },
  {
    title: '5. UNASSIGNED POD (nothing was read or checked, and the sentence says so; both inboxes get it)',
    property: baseProperty({ id: 'prop-0003', pod: null, latchel_property_id: '900003' }),
    job: baseJob({ job_id: 6005, order_number: 8005, property_id: 900003, name: 'Kitchen faucet leaking', description: 'Faucet drips.' }),
  },
  {
    title: '6. NONE (no title and no description came through with the work order)',
    job: baseJob({ job_id: 6006, order_number: 8006, name: '', description: '' }),
  },
  {
    title: '7. UNAVAILABLE (the job had no description field and the Latchel lookup failed)',
    job: (() => { const j = baseJob({ job_id: 6007, order_number: 8007 }); delete j.description; return j; })(),
    lookupFails: true,
  },
  {
    title: '8. EMERGENCY-FLAGGED job that is shown (the priority line comes only from Latchel\'s own flags)',
    job: baseJob({ job_id: 6008, order_number: 8008, name: 'Burst pipe in garage', description: 'Water is spraying from a pipe in the garage ceiling. Shut off valve is behind the water heater.', is_emergency: true, is_urgent: true }),
  },
  {
    title: '9. SHOWN, with fractions and powers exactly as typed, and a straight double quote shown as the inch mark (so the text cannot close the quote around the description)',
    job: baseJob({ job_id: 6009, order_number: 8009, name: 'Replace 2\u00BD inch copper pipe', description: 'Pipe under the 5\u00B2 ft laundry room is leaking at the 3/4" shutoff valve.' }),
  },
  {
    title: '10. HELD because a web address would have appeared at the 300-character cut (looks exactly like the other held samples)',
    job: baseJob({ job_id: 6010, order_number: 8010, name: 'Visit', description: `${'a'.repeat(297)}.coder` }),
  },
  {
    title: '11. HELD because of a missing space after a full stop (it reads exactly like a brand-looking web address, so the whole block is held; looks exactly like the other held samples)',
    job: baseJob({ job_id: 6011, order_number: 8011, name: 'Toilet running', description: 'Toilet keeps running after every flush.Support the tank lid, it is loose.' }),
  },
  {
    title: '12. HELD because the text would not settle in the cleaner (deeply nested markup; counted on its own line, not as a scanner error; looks exactly like the other held samples)',
    job: baseJob({ job_id: 6012, order_number: 8012, name: 'Visit', description: `Faucet drips. &${'amp;'.repeat(9)}lt;b&${'amp;'.repeat(9)}gt; thanks` }),
  },
];

// The lines between "Created:" and "View this property:" (without the blank separators): the block.
function blockOf(text) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.startsWith('Created:'));
  const j = lines.findIndex((l) => l.startsWith('View this property:'));
  return lines.slice(i + 2, j - 1);
}

async function main() {
  const lengths = [];
  for (const s of SAMPLES) {
    H.reset();
    process.env.WORK_ORDER_ALERT_DESCRIPTION_MODE = 'on';
    process.env.WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED = 'yes';
    if (s.lookupFails) H.latchelState.getJobImpl = async () => { throw new Error('lookup unavailable'); };
    H.db.tables.properties.push(clone(s.property || baseProperty()));
    await alert.handleWorkOrderJob(clone(s.job), 'webhook');
    const m = H.mail.sent[0];
    process.stdout.write(`\n${'='.repeat(78)}\n${s.title}\n${'='.repeat(78)}\n`);
    process.stdout.write(`To:      ${m.to.join(', ')}\nSubject: ${m.subject}\n\n${m.text}\n`);
    const block = blockOf(m.text);
    lengths.push(block.join('\n').length);
    process.stdout.write(`[this block: ${block.join('\n').length} characters over ${block.length} line${block.length === 1 ? '' : 's'}]\n`);
  }
  const longest = Math.max(...lengths);
  process.stdout.write(`\n${'='.repeat(78)}\nBLOCK LENGTH, honestly: the longest of these twelve samples is ${longest} characters; a typical shown block is about 330; the longest block the code can produce is 733 characters over 6 lines (100-character title, 300-character description, the two longest category labels, the emergency line and the fixed last line); Peter's soft target was about 600, and nothing has been cut to meet it.\n`);
}

main().catch((err) => { process.stderr.write(`${err.stack}\n`); process.exit(1); });
