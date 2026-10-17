#!/usr/bin/env node
/**
 * test/run-all.js
 * Runs every Work Order Alert test file in its own process, with a scrubbed
 * environment (only PATH, HOME and placeholder Supabase values), and prints
 * one total:
 *   node projects/hub/approval-briefing/test/run-all.js
 * Exit code 1 if any file fails. No real email, database, Latchel or model.
 * Add --sweep to also run the exhaustive separator sweep (test/sweep-full.js, about 90 seconds).
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const FILES = ['run-tests.js', 'cleaner-tests.js', 'screen-corpus.js', 'no-ai-proof.js', 'fix-round-tests.js', 'round3-tests.js', 'round4-tests.js'];
const quiet = process.argv.includes('--quiet');

let passed = 0;
let total = 0;
let failedFiles = 0;
for (const f of FILES) {
  const res = spawnSync(process.execPath, [path.join(__dirname, f)], {
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: '/tmp/x', SUPABASE_URL: 'https://placeholder.invalid', SUPABASE_SERVICE_ROLE_KEY: 'placeholder', SUPABASE_ANON_KEY: 'placeholder' },
  });
  const out = (res.stdout || '') + (res.stderr || '');
  const m = out.match(/(\d+)\/(\d+) passed/);
  const p = m ? Number(m[1]) : 0;
  const t = m ? Number(m[2]) : 0;
  passed += p; total += t;
  const ok = res.status === 0 && m && p === t;
  if (!ok) failedFiles++;
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${f}: ${p}/${t}\n`);
  if (!ok || !quiet) {
    const lines = out.split('\n').filter((l) => !ok ? !l.startsWith('PASS') : /^\s+\(/.test(l));
    if (lines.length) process.stdout.write(lines.slice(0, ok ? 20 : 80).join('\n') + '\n');
  }
}
// Optional, a minute and a half: the exhaustive separator sweep (every punctuation, symbol and space code point of
// every plane in every shared multi-word phrase). Counts only. Add --local to include the feature-local phrases (about 15 minutes).
let sweepFailed = false;
if (process.argv.includes('--sweep')) {
  const res = spawnSync(process.execPath, [path.join(__dirname, 'sweep-full.js'), ...(process.argv.includes('--local') ? ['--local'] : [])], {
    encoding: 'utf8', timeout: 3600000, maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: '/tmp/x', SUPABASE_URL: 'https://placeholder.invalid', SUPABASE_SERVICE_ROLE_KEY: 'placeholder', SUPABASE_ANON_KEY: 'placeholder' },
  });
  sweepFailed = res.status !== 0;
  process.stdout.write(`${sweepFailed ? 'FAIL' : 'ok  '} sweep-full.js: ${(res.stdout || '').trim() || (res.stderr || '').trim()}\n`);
}
process.stdout.write(`\nTOTAL ${passed}/${total} passed across ${FILES.length} files${failedFiles ? `, ${failedFiles} FILE(S) FAILED` : ''}${sweepFailed ? ', THE SWEEP FAILED' : ''}\n`);
process.exit(failedFiles || sweepFailed ? 1 : 0);
