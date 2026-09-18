#!/usr/bin/env node
/**
 * dry-run-wide-net-measurement.js
 *
 * ============================================================================
 * READ-ONLY. NO AI CALLS. NO WRITES. NOT PART OF THE LIVE SCREENING PASS.
 * ============================================================================
 * The Section 5 / Open Item 7 "zero-cost dry run first" measurement from
 * projects/hub/email-intake/archive-search-fair-housing-option-b-spec.md —
 * the real number Asimov and Mason both said Peter needs before finalizing
 * anything with his attorney about the wide-net pre-filter design.
 *
 * This script is a thin CLI wrapper only. It does not itself query
 * missive_message_intake (or any table) — it calls
 * lib/screening-pass.js's dryRunWideNetMeasurement(), the one function in
 * this codebase structurally permitted to read that table directly (see
 * that function's own header comment for exactly why). Nothing here writes
 * to the database, calls the Anthropic API, or changes any row's
 * screening_result. Running this script does NOT affect what
 * POST /api/archive-search/process-pending does today, and does not require
 * or trigger the batch screening pass to run.
 *
 * Usage:
 *   node dry-run-wide-net-measurement.js            Run the real measurement.
 *   node dry-run-wide-net-measurement.js --json      Same, output as JSON only.
 *   node dry-run-wide-net-measurement.js --help       Show this help and exit.
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (read-only use here) —
 * loaded from the shared .env, same candidate-path search backfill-missive-
 * history.js's own header already uses (local dev's three-levels-up layout,
 * or a flatter one-level-up deployed layout).
 */

{
  const path = require('path');
  const fs = require('fs');
  const candidates = [
    path.join(__dirname, '.env'),
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '..', '..', '.env'),
  ];
  const envPath = candidates.find((p) => fs.existsSync(p)) || candidates[candidates.length - 1];
  require('dotenv').config({ path: envPath });
}

function printHelp() {
  console.log(`
dry-run-wide-net-measurement.js

Read-only measurement: for every conversation in the real archive, checks
whether the (not-yet-wired-in) Fair Housing wide-net pre-filter would match
it. Makes NO AI calls and writes NOTHING. Does not change any row.

Usage:
  node dry-run-wide-net-measurement.js
  node dry-run-wide-net-measurement.js --json
  node dry-run-wide-net-measurement.js --help
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  const jsonOnly = args.includes('--json');

  const missing = [];
  if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(', ')}. Set these in the shared .env at the project root.`);
    process.exitCode = 1;
    return;
  }

  const { dryRunWideNetMeasurement } = require('./lib/screening-pass');

  const startedAt = Date.now();
  if (!jsonOnly) console.log('Running read-only wide-net dry run against the real archive — no AI calls, no writes...\n');

  let lastPrinted = 0;
  const result = await dryRunWideNetMeasurement({
    onProgress: jsonOnly
      ? null
      : (partial) => {
          // Print progress at most once per ~10,000 rows scanned, so a
          // ~254,000-row run gives visible movement without flooding stdout.
          if (partial.message_rows_scanned - lastPrinted >= 10000) {
            lastPrinted = partial.message_rows_scanned;
            console.log(
              `  ...scanned ${partial.message_rows_scanned} message rows, ${partial.conversations_checked} conversations checked so far ` +
                `(${partial.held_excluded} held / ${partial.non_held_would_call_ai} would-call-AI / ${partial.non_held_would_skip} would-skip)`
            );
          }
        },
  });

  const elapsedSec = Math.round((Date.now() - startedAt) / 100) / 10;

  if (jsonOnly) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\nDone in ${elapsedSec}s.\n`);
  console.log('='.repeat(72));
  console.log('WIDE-NET DRY RUN — REAL RESULTS (read-only, no AI calls, no writes)');
  console.log('='.repeat(72));
  console.log(`Message rows scanned:            ${result.message_rows_scanned}`);
  console.log(`Conversations checked:            ${result.conversations_checked}`);
  console.log(`  Held (excluded, unread by wide net): ${result.held_excluded}`);
  console.log(`  Non-held, wide net WOULD match (AI call still happens):  ${result.non_held_would_call_ai}`);
  console.log(`  Non-held, wide net WOULD skip (AI call avoided):        ${result.non_held_would_skip}`);
  console.log(`Would-skip rate among non-held conversations: ${result.would_skip_rate_pct}%`);
  console.log(`fair-housing-wide-net-terms.js version used: ${result.wide_net_terms_version}`);
  console.log('\nTop matched literal phrases:');
  for (const [term, count] of Object.entries(result.matched_phrase_counts).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${count.toString().padStart(6)}  ${term}`);
  }
  console.log('\nTop matched co-occurrence pairs:');
  for (const [id, count] of Object.entries(result.matched_cooccurrence_pair_counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count.toString().padStart(6)}  ${id}`);
  }
  if (Object.keys(result.matched_bare_word_exception_counts).length > 0) {
    console.log('\nMatched bare-word exceptions (discrimination_general — not yet Peter-approved):');
    for (const [term, count] of Object.entries(result.matched_bare_word_exception_counts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count.toString().padStart(6)}  ${term}`);
    }
  }
  console.log('='.repeat(72));
}

main().catch((err) => {
  console.error('Dry run failed:', err.message);
  process.exitCode = 1;
});
