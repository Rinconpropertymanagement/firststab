#!/usr/bin/env node
/**
 * test/capture-golden-on.js
 *
 * Writes golden-on-c781a1b.json: what the Work Order Alert did in modes shadow,
 * on and on-without-interlock for every case in golden-on-lib.js, as produced by
 * the code of a given tree. The committed fixture was produced by commit
 * c781a1b (the last commit before the owner's content-screen switch). To
 * regenerate it, put that commit's approval-briefing folder somewhere (a
 * `git archive c781a1b projects/hub/approval-briefing projects/hub/lib
 * projects/hub/maintenance-history` extracted into a scratch folder, with this
 * repo's projects/hub/node_modules linked in) and pass that tree's projects/hub:
 *
 *   node projects/hub/approval-briefing/test/capture-golden-on.js /scratch/tree/projects/hub "commit c781a1b"
 *
 * Uses the stubbed harness of the tree it is given: no real email, no database.
 */

'use strict';

const fs = require('fs');
const path = require('path');

async function main() {
  const hub = path.resolve(process.argv[2] || path.resolve(__dirname, '../..'));
  const H = require(path.join(hub, 'approval-briefing/test/harness.js'));
  const { baseJob, baseProperty } = require(path.join(hub, 'approval-briefing/test/scenarios.js'));
  const alert = H.load('lib/work-order-notes-alert.js');
  const lib = require('./golden-on-lib');
  const cases = lib.buildCases({ baseJob, baseProperty });
  const out = { source: process.argv[3] || (process.argv[2] ? 'given tree' : 'this tree'), cases: [] };
  for (const c of cases) {
    const rec = { name: c.name, property: c.property, job: c.job, lookup: c.lookup, settings: {} };
    for (const [setting, fn] of Object.entries(lib.SETTINGS)) {
      rec.settings[setting] = await lib.record({ H, alert }, c, baseProperty, fn);
    }
    out.cases.push(rec);
  }
  const file = path.resolve(__dirname, 'golden-on-c781a1b.json');
  // one case per line, so a diff of the fixture reads case by case
  fs.writeFileSync(file, `{"source":${JSON.stringify(out.source)},"cases":[\n${out.cases.map((c) => JSON.stringify(c)).join(',\n')}\n]}\n`);
  process.stdout.write(`Wrote ${out.cases.length} cases x ${Object.keys(lib.SETTINGS).length} settings to ${file}\n`);
}

main().catch((err) => { process.stderr.write(`${err.stack}\n`); process.exit(1); });
