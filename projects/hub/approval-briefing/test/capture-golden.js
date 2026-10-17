#!/usr/bin/env node
/**
 * test/capture-golden.js
 *
 * Runs every scenario in scenarios.js through a Work Order Alert module
 * and writes what it emailed to golden-emails.json.
 *
 * The committed golden-emails.json was produced by the PARENT commit's
 * lib/work-order-notes-alert.js (058618d), before the description block
 * was added. To regenerate it, put that version of the file somewhere
 * under approval-briefing/lib/ (it must sit next to its sibling modules
 * so its relative requires resolve) and pass its path:
 *
 *   git show 058618d:projects/hub/approval-briefing/lib/work-order-notes-alert.js \
 *     > projects/hub/approval-briefing/lib/_parent-alert.js
 *   node projects/hub/approval-briefing/test/capture-golden.js lib/_parent-alert.js
 *   rm projects/hub/approval-briefing/lib/_parent-alert.js
 *
 * Uses the same stubbed harness as the tests: no real email, no database.
 */

const fs = require('fs');
const path = require('path');
const H = require('./harness');
const { SCENARIOS } = require('./scenarios');

async function main() {
  const rel = process.argv[2] || 'lib/work-order-notes-alert.js';
  const alert = H.load(rel);
  const out = [];
  for (const s of SCENARIOS) {
    H.reset();
    H.db.tables.properties.push(JSON.parse(JSON.stringify(s.property)));
    await alert.handleWorkOrderJob(JSON.parse(JSON.stringify(s.job)), 'webhook');
    if (H.mail.sent.length !== 1) throw new Error(`scenario ${s.name}: expected exactly 1 email, got ${H.mail.sent.length}`);
    const { to, subject, text } = H.mail.sent[0];
    out.push({ name: s.name, to, subject, text });
  }
  const file = path.resolve(__dirname, 'golden-emails.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  process.stdout.write(`Wrote ${out.length} golden emails to ${file}\n`);
}

main().catch((err) => { process.stderr.write(`${err.stack}\n`); process.exit(1); });
