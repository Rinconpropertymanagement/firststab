#!/usr/bin/env node
/**
 * run-significance-batch.js
 *
 * ============================================================================
 * PHASE 2 — THE MESSAGE BATCHES API ("bulk method") RUN, archive-search
 * historical significance backfill. Companion to run-significance-pilot.js
 * (Phase 1's synchronous, one-conversation-at-a-time pilot) — this is the
 * separate, later, explicitly-deferred build that file's own header always
 * named but never built. See lib/significance-batch.js's own header for the
 * full design (why the Batches API, what this build does and does not do).
 *
 * ============================================================================
 * THIS RUNS AGAINST REAL MAIL, MAKES REAL, BILLED AI CALLS (via a single
 * Anthropic Message Batch of up to 100,000 requests), AND WRITES REAL ROWS —
 * to archive_search_significance_batches / archive_search_significance_
 * batch_items immediately, and to missive_conversation_significance (and,
 * for actionable findings, complaints) once results are written back. Every
 * row this tool eventually produces is stamped discovery_context =
 * 'historical_backfill', exactly like the pilot.
 *
 * ============================================================================
 * MUST RUN ON SALLY. NEVER LOCALLY. RESTATED BECAUSE THIS EXACT MISTAKE
 * ALREADY HAPPENED ONCE ON THIS PROJECT (the original Fair Housing scan) —
 * same warning run-significance-pilot.js carries, unchanged.
 * ============================================================================
 *   ssh sally
 *   cd /var/www/hub
 *   nohup node projects/hub/archive-search/run-significance-batch.js \
 *     --since-date=2025-09-17 > /tmp/significance-batch.log 2>&1 & disown
 *   tail -f /tmp/significance-batch.log
 *
 * Unlike the pilot, this script finishes almost immediately on a SUBMIT run
 * (it hands work to Anthropic and exits) — nohup/disown mainly matters for a
 * WRITE-BACK run against a large (~84,000-item) batch, which streams and
 * applies every result in one process lifetime.
 *
 * ============================================================================
 * HOW TO USE IT — re-run the SAME command; it figures out what to do next
 * ============================================================================
 * This is one command, safe to re-run repeatedly (a cron entry, or just
 * checking back later by hand):
 *   - No unfinished batch for --stage exists yet -> submits a new one.
 *   - An unfinished batch exists -> checks its status with Anthropic,
 *     downloads results once it has ended, and writes results back to the
 *     database (resumable — a re-run after a crash picks up exactly where
 *     write-back left off).
 *   - Once every item is written back, the batch is marked complete. For a
 *     'call_1' stage batch, this prints how many of its conversations need
 *     a Call 2 pass — Call 2 is NEVER submitted automatically; that is a
 *     separate, deliberate run of this same command with --stage=call_2,
 *     only once that path is actually built (see lib/significance-batch.js).
 *
 * Usage:
 *   node run-significance-batch.js                          Stage call_1, no date cutoff, up to the 100,000-request cap.
 *   node run-significance-batch.js --since-date=2025-09-17   Only conversations active on/after this date (Peter's staged-by-recency plan).
 *   node run-significance-batch.js --limit=50                Cap this SUBMISSION at 50 conversations (a small first real test, not a permanent ceiling).
 *   node run-significance-batch.js --stage=call_2             Check/resume a call_2 batch (submission not yet built — see the header above).
 *   node run-significance-batch.js --help                    Show this help and exit.
 */

// .env loading is deliberately deferred to the require.main guard at the
// bottom of this file, NOT run unconditionally at require() time (a real
// difference from run-significance-pilot.js's own header, which loads .env
// unconditionally — not changed here, since that file is explicitly off
// limits for this build). Proven, not assumed: an unconditional top-level
// dotenv.config() call re-populates any environment variable a CALLER has
// deliberately deleted (e.g. a test harness forcing anthropicClient() to
// fail closed) the moment this module is merely require()'d for its pure
// exports (parseStageArg/parseLimitArg) — dotenv only skips variables that
// are already SET, and `delete process.env.X` makes X look unset to it.
// Loading .env only inside the require.main guard means requiring this
// file as a library (test/run-tests.js does exactly that) can never have
// that side effect; a real run (`node run-significance-batch.js`) is
// unaffected, since main() always runs under that same guard.
function loadDotEnv() {
  const path = require('path');
  const fs = require('fs');
  // Same candidate-path search run-significance-pilot.js's own header
  // already uses — local dev's three-levels-up layout, or a flatter
  // deployed layout (sally's /var/www/hub, per deploy-to-sally.sh).
  const candidates = [
    path.join(__dirname, '.env'),
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '..', '..', '.env'),
  ];
  const envPath = candidates.find((p) => fs.existsSync(p)) || candidates[candidates.length - 1];
  require('dotenv').config({ path: envPath });
}

const VALID_STAGES = ['call_1', 'call_2'];

function printHelp() {
  console.log(`
run-significance-batch.js — Phase 2, the Message Batches API run

Submits (or checks/resumes) one Anthropic Message Batch of Call 1 requests
for the archive-search historical significance backfill, and writes results
back to the database once the batch ends. MAKES REAL AI CALLS AND REAL
DATABASE WRITES. MUST RUN ON SALLY, NEVER LOCALLY — see this file's own
header comment before running it.

Usage:
  node run-significance-batch.js
  node run-significance-batch.js --since-date=2025-09-17
  node run-significance-batch.js --limit=50
  node run-significance-batch.js --stage=call_2
  node run-significance-batch.js --help

Flags:
  --stage=call_1|call_2   Which pass this batch is for (default: call_1).
                          Only call_1 SUBMISSION is built today — checking/
                          resuming/writing back an already-submitted batch
                          works for either stage.
  --since-date=YYYY-MM-DD Only conversations whose MOST RECENT message is
                          on/after this date are eligible for a NEW
                          submission (Peter's staged-by-recency backfill —
                          same semantics as run-significance-pilot.js's own
                          --since-date). Ignored on a check/resume run.
  --limit=N               Cap a NEW submission at N conversations (default:
                          Anthropic's own 100,000-request batch ceiling).
                          Useful for a small first real test before
                          committing a full staged window.
`);
}

function parseStageArg(args) {
  const match = args.find((a) => a.startsWith('--stage='));
  if (!match) return { stage: 'call_1', error: null };
  const stage = match.split('=')[1];
  if (!VALID_STAGES.includes(stage)) {
    return { stage: null, error: `--stage must be one of ${VALID_STAGES.join(', ')}, got "${stage}".` };
  }
  return { stage, error: null };
}

function parseLimitArg(args) {
  const match = args.find((a) => a.startsWith('--limit='));
  if (!match) return { limit: undefined, error: null }; // undefined -> submitBatch()'s own default (the full 100,000-request cap).
  const n = Number.parseInt(match.split('=')[1], 10);
  if (!Number.isFinite(n) || n <= 0) return { limit: undefined, error: `--limit must be a positive integer, got "${match.split('=')[1]}".` };
  return { limit: n, error: null };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const { stage, error: stageError } = parseStageArg(args);
  if (stageError) {
    console.error(`${stageError} Run with --help for usage.`);
    process.exitCode = 1;
    return;
  }
  const { limit, error: limitError } = parseLimitArg(args);
  if (limitError) {
    console.error(`${limitError} Run with --help for usage.`);
    process.exitCode = 1;
    return;
  }
  // Reused verbatim from run-significance-pilot.js — identical --since-date
  // semantics and validation, not re-derived here. (--since-years is
  // intentionally not offered on this script; Peter's staged plan already
  // has real calendar dates in hand by the time a Batches API run is
  // warranted — --since-date alone keeps this tool's own flag surface
  // small.)
  const { parseSinceArgs } = require('./run-significance-pilot');
  const { sinceDate, error: sinceError } = parseSinceArgs(args);
  if (sinceError) {
    console.error(`${sinceError} Run with --help for usage.`);
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
  console.log('ARCHIVE SEARCH SIGNIFICANCE BATCH — Phase 2 (Message Batches API)');
  console.log('='.repeat(72));
  console.log(`Host:  ${os.hostname()}`);
  console.log(`Stage: ${stage}`);
  console.log('This makes REAL, BILLED AI calls (a single Anthropic batch) and REAL database writes.');
  console.log('If this is not running on sally right now, stop and re-launch there instead — see this file\'s own header.\n');

  // Cross-process lock (lib/significance-lock.js — Asimov's flagged gap,
  // 2026-09-18, automatic-scheduling review): this script and the Hub's
  // own significance routes (archive-search/router.js's process-
  // significance-pending and process-significance-pending-scheduled) can
  // both write into the same significance rows. Nothing before this
  // stopped them from running at the same time — this makes that
  // impossible, whichever one gets there first. Wraps the WHOLE rest of
  // main() (submit, or check/resume + write-back), not just one call
  // inside it, since every branch below does real, billed work or real
  // database writes.
  const { withSignificanceLock } = require('./lib/significance-lock');
  await withSignificanceLock(`standalone-batch --stage=${stage}${sinceDate ? ` --since-date=${sinceDate}` : ''}`, () => runBatchWork({ stage, sinceDate, limit }));
}

async function runBatchWork({ stage, sinceDate, limit }) {
  const batchLib = require('./lib/significance-batch');

  const existing = await batchLib.findUnfinishedBatch(stage);

  if (!existing) {
    console.log(`No unfinished '${stage}' batch found — submitting a new one...`);
    console.log(`Date cutoff: ${sinceDate ? `${sinceDate} — only conversations whose MOST RECENT message is on/after this date` : 'none — every eligible conversation is in scope'}`);
    if (limit !== undefined) console.log(`Submission cap: ${limit} conversation(s) (--limit)`);

    const result = await batchLib.submitBatch({ stage, sinceDate, limit });
    if (!result.submitted) {
      console.log(`\nNothing submitted (${result.reason}).`);
      if (result.batch) console.log(`Existing/unfinished batch: ${result.batch.anthropic_batch_id} (status: ${result.batch.anthropic_status})`);
      if (result.orphanedAnthropicBatchId) console.log(`URGENT: real Anthropic batch ${result.orphanedAnthropicBatchId} was created but could not be recorded locally — see the error above and reconcile manually.`);
      return;
    }
    console.log(`\nSubmitted batch ${result.batch.anthropic_batch_id} with ${result.requestCount} conversation(s)${result.skipped ? ` (${result.skipped} skipped — no messages found)` : ''}.`);
    console.log('Batches can take up to 24 hours. Re-run this same command later to check status.');
    return;
  }

  console.log(`Found unfinished '${stage}' batch: ${existing.anthropic_batch_id} (last known status: ${existing.anthropic_status})`);
  const checked = await batchLib.checkAndResume({ stage });
  if (!checked.found) {
    console.log('No unfinished batch found on re-check (it may have just completed) — re-run to submit a new one.');
    return;
  }

  console.log(`Anthropic status: ${checked.remote.processing_status}`);
  if (checked.remote.request_counts) {
    const c = checked.remote.request_counts;
    console.log(`Request counts — processing: ${c.processing}, succeeded: ${c.succeeded}, errored: ${c.errored}, canceled: ${c.canceled}, expired: ${c.expired}`);
  }

  if (checked.remote.processing_status !== 'ended') {
    console.log('\nBatch is still processing at Anthropic. Nothing more to do right now — re-run later.');
    return;
  }

  if (!checked.batch.results_retrieved_at) {
    console.log('\nBatch ended, but results were not fully retrieved this run (see any errors above) — re-run to retry downloading results.');
    return;
  }

  console.log('\nResults retrieved. Writing results back to the database (resumable)...');
  const writeBackSummary = await batchLib.writeBackBatch({ batchId: checked.batch.id, anthropicBatchId: checked.batch.anthropic_batch_id });
  console.log(`Write-back: ${writeBackSummary.processed} processed (${writeBackSummary.written_significance} wrote a significance row, ${writeBackSummary.no_row_written} did not — errored/canceled/expired/unparseable), ${writeBackSummary.errors} error(s), ${writeBackSummary.unmatched} unmatched.`);

  const nowCompleted = await batchLib.maybeMarkBatchCompleted(checked.batch.id);
  if (!nowCompleted) {
    console.log('\nSome items still need write-back (see counts above, or an interrupted run) — re-run this command to continue.');
    return;
  }
  console.log(`\nBatch ${checked.batch.anthropic_batch_id} is now fully complete.`);

  if (stage === 'call_1') {
    const report = await batchLib.reportNeedsCall2({ batchId: checked.batch.id });
    console.log(`\n${report.needsCall2Count} of ${report.totalWithSignificanceRow} conversation(s) with a written significance row need a Call 2 pass.`);
    console.log('Call 2 is NOT submitted automatically. Review these Call 1 results first (same review step the pilot always required), then run this tool again with --stage=call_2 once that submission path is built.');
  }
}

// require.main guard — lets test/run-tests.js require this file to unit-test
// parseStageArg/parseLimitArg (pure, no I/O) without launching a real run.
if (require.main === module) {
  loadDotEnv();
  main().catch((err) => {
    console.error('Batch run failed:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { parseStageArg, parseLimitArg };
