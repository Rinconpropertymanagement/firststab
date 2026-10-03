#!/usr/bin/env node
/**
 * run-name-match-backfill.js
 *
 * The retroactive name-match backfill — CLI driver for
 * lib/name-match-backfill.js. Applies the same narrower, Mason-cleared,
 * human-confirmed name-based-matching design the live pipeline already runs
 * (significance-pass.js) to the existing ~1,800+ complaints where
 * needs_matching = TRUE, instead of only new conversations going forward.
 * Read lib/name-match-backfill.js's header in full first.
 *
 * ============================================================================
 * DO NOT RUN THIS FOR REAL YET
 * ============================================================================
 * This makes real, billed Anthropic API calls and writes real rows into
 * `complaints`. lib/name-match-backfill.js's own
 * submitNameMatchBackfillBatch() refuses to submit anything unless
 * NAME_MATCH_BACKFILL_GOVERNANCE_CLEARED=true is set — as of this build that
 * is NOT set anywhere real. Two things have to happen first, both outside
 * this tool's control:
 *   1. Peter applies the schema migration (supabase/migrations/
 *      20261002070000_add_retroactive_name_match_checked_at_to_complaints.sql)
 *      via Supabase's SQL Editor — this column does not exist on the live
 *      `complaints` table yet.
 *   2. Jarvis confirms whether this RETROACTIVE run needs its own separate
 *      Asimov/Mason sign-off, distinct from the live-pipeline sign-off
 *      already on record for processing NEW complaints (migration
 *      20261002060000's own header flags this as Jarvis's call to confirm,
 *      not a schema question that's already been answered).
 * Running this command before both are true will either error immediately
 * (column does not exist) or, worse, be refused by the tool's own gate —
 * do not work around that gate.
 *
 * ============================================================================
 * MUST RUN ON SALLY. NEVER LOCALLY. Same standing rule every other real,
 * billed batch tool in this codebase carries (run-significance-batch.js,
 * run-significance-pilot.js, run-severity-batch.js) — restated here, not
 * assumed.
 * ============================================================================
 *   ssh sally
 *   cd /var/www/hub
 *   nohup node projects/hub/archive-search/run-name-match-backfill.js \
 *     > /tmp/name-match-backfill.log 2>&1 & disown
 *   tail -f /tmp/name-match-backfill.log
 *
 * ============================================================================
 * HOW TO USE IT — re-run the SAME command; it figures out what to do next
 * ============================================================================
 *   - No in-flight batch known -> submits one (up to --limit complaints,
 *     default Anthropic's own 100,000-request ceiling; at today's real
 *     ~1,800+-row volume this is the entire backlog in one submission).
 *   - An in-flight batch exists -> checks its status; once Anthropic
 *     reports it 'ended', downloads and writes back every result
 *     (resumable — a crash or a rate limit just means re-running this same
 *     command later picks up exactly where it left off).
 *
 * Usage:
 *   node run-name-match-backfill.js                 Submit (or check/resume) the backfill, up to the 100,000-request cap.
 *   node run-name-match-backfill.js --limit=50      Cap a NEW submission at 50 complaints (a small first real test).
 *   node run-name-match-backfill.js --help          Show this help and exit.
 */

function loadDotEnv() {
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
run-name-match-backfill.js — retroactive name-match backfill

Submits (or checks/resumes) one Anthropic Message Batch of the Mason-cleared
name-based-matching check against every complaint where needs_matching is
TRUE and retroactive_name_match_checked_at is still NULL (not yet examined by
this tool). MAKES REAL AI CALLS AND REAL DATABASE WRITES, ONCE CLEARED — see
this file's own header, "DO NOT RUN THIS FOR REAL YET," before running it at
all. MUST RUN ON SALLY, NEVER LOCALLY.

Usage:
  node run-name-match-backfill.js
  node run-name-match-backfill.js --limit=50
  node run-name-match-backfill.js --help

Flags:
  --limit=N   Cap a NEW submission's eligible set at N complaints (default:
              Anthropic's own 100,000-request batch ceiling). Useful for a
              small first real test before the full backfill. Ignored when
              resuming an already-submitted batch.
  --help      Show this help and exit.
`);
}

function parseLimitArg(args) {
  const match = args.find((a) => a.startsWith('--limit='));
  if (!match) return { limit: undefined, error: null };
  const n = Number.parseInt(match.split('=')[1], 10);
  if (!Number.isFinite(n) || n <= 0) return { limit: undefined, error: `--limit must be a positive integer, got "${match.split('=')[1]}".` };
  return { limit: n, error: null };
}

async function runBatchWork({ limit }) {
  const nameMatchBackfill = require('./lib/name-match-backfill');

  const state = nameMatchBackfill.readState();

  if (!state || state.results_retrieved_at) {
    console.log('No in-flight name-match backfill batch found — attempting to submit a new one...');
    const result = await nameMatchBackfill.submitNameMatchBackfillBatch({ limit });
    if (!result.submitted) {
      console.log(`\nNothing submitted (${result.reason}).`);
      if (result.state) console.log(`Existing in-flight batch: ${result.state.anthropic_batch_id}`);
      return;
    }
    console.log(`\nSubmitted batch ${result.state.anthropic_batch_id} with ${result.requestCount} complaint(s).`);
    if (result.skippedUnreadable) console.log(`${result.skippedUnreadable} row(s) skipped — no readable conversation content, left unchecked.`);
    if (result.skippedOversized) console.log(`${result.skippedOversized} row(s) skipped as individually oversized — needs manual review.`);
    if (result.remainingEligibleAfterThisChunk) console.log(`${result.remainingEligibleAfterThisChunk} more eligible complaint(s) remain for a future run once this batch completes.`);
    console.log('Re-run this same command later to check status and write back results once Anthropic finishes (up to 24 hours).');
    return;
  }

  console.log(`Found in-flight name-match backfill batch: ${state.anthropic_batch_id} (submitted ${state.submitted_at}, ${state.complaint_ids.length} complaint(s))`);
  const result = await nameMatchBackfill.checkAndWriteBackNameMatchBackfillBatch();
  if (!result.alreadyComplete) {
    console.log(`Status: ${result.status} — still processing at Anthropic. Re-run this same command later to check again.`);
    return;
  }
  if (!result.justCompleted) {
    console.log('This batch\'s results were already fully written back by an earlier run.');
    return;
  }
  console.log(`\nBatch ${state.anthropic_batch_id} fully processed: ${result.summary.processed} processed, ${result.summary.written_with_suggestion} found a real candidate, ${result.summary.written_no_suggestion} found nothing (checked, no suggestion), ${result.summary.no_row_written} wrote nothing at all (stay eligible for a future run), ${result.summary.errors} error(s).`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const { limit, error: limitError } = parseLimitArg(args);
  if (limitError) {
    console.error(`${limitError} Run with --help for usage.`);
    process.exitCode = 1;
    return;
  }

  const missing = [];
  if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(', ')}. Set these in the shared .env at the project root.`);
    process.exitCode = 1;
    return;
  }

  const os = require('os');
  console.log('='.repeat(72));
  console.log('RETROACTIVE NAME-MATCH BACKFILL — Message Batches API');
  console.log('='.repeat(72));
  console.log(`Host: ${os.hostname()}`);
  console.log('This makes REAL, BILLED AI calls and REAL database writes, once cleared.');
  console.log('If NAME_MATCH_BACKFILL_GOVERNANCE_CLEARED is not set to \'true\', submission will be refused — see this file\'s own header.');
  console.log('If this is not running on sally right now, stop and re-launch there instead.\n');

  const { withNameMatchBackfillLock } = require('./lib/name-match-backfill-lock');
  await withNameMatchBackfillLock(`name-match-backfill${limit ? ` --limit=${limit}` : ''}`, () => runBatchWork({ limit }));
}

if (require.main === module) {
  loadDotEnv();
  main().catch((err) => {
    console.error('Name-match backfill run failed:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { parseLimitArg };
