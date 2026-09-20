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
 * UPDATED 2026-09-18 — SUBMISSION RUNS, REPLACING THE OLD SINGLE-BATCH FLOW
 * ============================================================================
 * Tonight, an 8-hour eligibility scan's real 84,408-conversation result was
 * lost outright when the old single-batch submitBatch() call it fed into was
 * rejected by Anthropic with a real 413 (over the real 256MB-per-batch
 * limit) — nothing had been saved to the database before that call. This
 * script now drives lib/significance-batch.js's newer SUBMISSION RUN flow
 * (startSubmissionRun/dispatchRunChunks/checkAndResumeRun) instead of the
 * old single-batch submitBatch()/checkAndResume() pair: the full eligible
 * list a submission is built from is now durably recorded BEFORE any
 * Anthropic call happens at all, and is then split into as many
 * appropriately-sized chunks (each its own real Anthropic batch) as its real
 * byte size and request count actually require — see lib/significance-
 * batch.js's own "ADDED 2026-09-18" header and Neo's migration (supabase/
 * migrations/20260918060000_..._schema.sql) for the full story. The flags
 * below are UNCHANGED from before this fix — this is an internal mechanism
 * change, not a new CLI interface.
 *
 * ============================================================================
 * HOW TO USE IT — re-run the SAME command; it figures out what to do next
 * ============================================================================
 * This is one command, safe to re-run repeatedly (a cron entry, or just
 * checking back later by hand):
 *   - No unfinished submission run for --stage exists yet -> starts one (one
 *     call to the expensive eligibility scan, durably recorded immediately,
 *     before anything is sent to Anthropic).
 *   - An unfinished run exists -> dispatches any of its chunks not yet
 *     submitted to Anthropic (safe to re-run — already-dispatched chunks are
 *     always skipped), then checks every chunk's status, downloads results
 *     once each has ended, and writes results back to the database
 *     (resumable at every step — a re-run after a crash or a rate limit
 *     picks up exactly where it left off).
 *   - Once every chunk's results are written back, the run is marked fully
 *     processed. For a 'call_1' stage run, this prints how many of its
 *     conversations (across every chunk) need a Call 2 pass — Call 2 is
 *     NEVER submitted automatically; that is a separate, deliberate run of
 *     this same command with --stage=call_2, only once that path is
 *     actually built (see lib/significance-batch.js).
 *
 * Usage:
 *   node run-significance-batch.js                          Stage call_1, no date cutoff, up to the 100,000-request cap.
 *   node run-significance-batch.js --since-date=2025-09-17   Only conversations active on/after this date (Peter's staged-by-recency plan).
 *   node run-significance-batch.js --limit=50                Cap this SUBMISSION at 50 conversations (a small first real test, not a permanent ceiling).
 *   node run-significance-batch.js --stage=call_2             Check/resume a call_2 batch (submission not yet built — see the header above).
 *   node run-significance-batch.js --force                   Override a failed expected-pool sanity check for THIS run only (see below).
 *   node run-significance-batch.js --help                    Show this help and exit.
 *
 * ============================================================================
 * ADDED 2026-09-19 — THE EXPECTED-POOL SANITY CHECK (the 33,755-vs-84,192
 * real-incident-class safeguard)
 * ============================================================================
 * Before dispatching anything NEW to Anthropic for a run, this tool now
 * compares that run's own real eligible_count against a fast, independent
 * estimate of what the pool should roughly be (lib/significance-batch.js's
 * checkEligiblePoolSanity(), lib/significance-pass.js's
 * estimateExpectedEligiblePool() — see both files' own headers for the full
 * incident story and the 70% threshold's reasoning). If the real count looks
 * implausibly low, this command prints a loud warning with the real numbers,
 * dispatches NOTHING, and exits non-zero — the run's already-scanned,
 * already-persisted eligible list is untouched either way, so nothing is
 * ever lost by this refusal. Re-run this exact same command with --force
 * once a human has reviewed the numbers (see the warning's own instructions)
 * and confirmed the low count is real, not a repeat of the incident.
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

Starts (or dispatches/checks/resumes) one SUBMISSION RUN of Call 1 requests
for the archive-search historical significance backfill — a run's eligible
conversations are durably recorded before any Anthropic call happens, then
split into as many appropriately-sized Anthropic Message Batches (chunks) as
their real byte size/request count require, and results are written back to
the database as each chunk finishes. MAKES REAL AI CALLS AND REAL DATABASE
WRITES. MUST RUN ON SALLY, NEVER LOCALLY — see this file's own header
comment before running it.

Usage:
  node run-significance-batch.js
  node run-significance-batch.js --since-date=2025-09-17
  node run-significance-batch.js --limit=50
  node run-significance-batch.js --stage=call_2
  node run-significance-batch.js --help

Flags:
  --stage=call_1|call_2   Which pass this run is for (default: call_1).
                          Only call_1 SUBMISSION is built today — checking/
                          resuming/dispatching/writing back an already-
                          started run works for either stage.
  --since-date=YYYY-MM-DD Only conversations whose MOST RECENT message is
                          on/after this date are eligible for a NEW run
                          (Peter's staged-by-recency backfill — same
                          semantics as run-significance-pilot.js's own
                          --since-date). Ignored when resuming an existing
                          run.
  --limit=N               Cap a NEW run's eligible set at N conversations
                          (default: Anthropic's own 100,000-request batch
                          ceiling). Useful for a small first real test before
                          committing a full staged window. A run this large
                          is still automatically split into multiple
                          Anthropic batches if its real byte size requires
                          it — this cap is about how many conversations to
                          fetch, not how many chunks the run becomes.
  --force                 Override a failed expected-pool sanity check and
                          dispatch this run anyway. Only use this after
                          reviewing the real numbers the warning printed
                          (this file's own "ADDED 2026-09-19" header above)
                          and confirming the low count is real. Applies to
                          this one command invocation only — never silently
                          remembered for next time.
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

// A plain boolean flag, no value — pulled into its own tiny, exported,
// directly-testable function purely for consistency with parseStageArg/
// parseLimitArg above, not because it needs any real parsing logic.
function parseForceArg(args) {
  return { force: args.includes('--force') };
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
  const { force } = parseForceArg(args);
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
  await withSignificanceLock(`standalone-batch --stage=${stage}${sinceDate ? ` --since-date=${sinceDate}` : ''}${force ? ' --force' : ''}`, () => runBatchWork({ stage, sinceDate, limit, force }));
}

// ============================================================================
// UPDATED 2026-09-18 — drives lib/significance-batch.js's newer SUBMISSION
// RUN flow (startSubmissionRun/dispatchRunChunks/checkAndResumeRun) instead
// of the old single-batch submitBatch()/checkAndResume() pair — see this
// file's own header for why. Every step below is resumable and safe to
// re-run; a crash, a rate limit, or a still-processing Anthropic batch (up
// to 24 hours) just means re-running this same command later picks up
// exactly where it left off.
// ============================================================================
async function runBatchWork({ stage, sinceDate, limit, force = false }) {
  const batchLib = require('./lib/significance-batch');

  let run = await batchLib.findUnfinishedRun(stage);

  if (!run) {
    console.log(`No unfinished '${stage}' submission run found — starting a new one...`);
    console.log(`Date cutoff: ${sinceDate ? `${sinceDate} — only conversations whose MOST RECENT message is on/after this date` : 'none — every eligible conversation is in scope'}`);
    if (limit !== undefined) console.log(`Eligible-set cap: ${limit} conversation(s) (--limit)`);

    const result = await batchLib.startSubmissionRun({ stage, sinceDate, limit });
    if (!result.started) {
      console.log(`\nNothing started (${result.reason}).`);
      if (result.run) console.log(`Existing/unfinished run: ${result.run.id} (assembled: ${!!result.run.assembled_at})`);
      return;
    }
    console.log(`\nRun ${result.run.id} started with ${result.eligibleCount} eligible conversation(s), durably recorded — the expensive eligibility scan's results can never be lost now, regardless of what happens to submission from here.`);
    run = result.run;
  } else {
    console.log(`Found unfinished '${stage}' submission run: ${run.id} (eligible_count: ${run.eligible_count == null ? 'not yet known — assembly may be incomplete' : run.eligible_count})`);
  }

  if (!run.assembled_at) {
    console.error(`\nRun ${run.id} has not finished being durably recorded (assembled_at is not set). This should only happen if a previous run crashed between inserting the run row and finishing its item inserts — a narrow, documented window (see lib/significance-batch.js's own header). This needs manual review: re-running this command will NOT re-attempt the eligibility scan for an already-started run (by design — that discipline is the whole point of this fix), so it also cannot fix this on its own.`);
    process.exitCode = 1;
    return;
  }

  console.log('\nDispatching any undispatched chunks for this run to Anthropic (safe to re-run — already-dispatched chunks are always skipped)...');
  if (force) console.log('--force given: skipping the expected-pool sanity check for this call.');
  const dispatch = await batchLib.dispatchRunChunks({ runId: run.id, force });

  if (dispatch.blockedBySanityCheck) {
    const { sanityCheck } = dispatch;
    const ratioPct = (sanityCheck.ratio * 100).toFixed(1);
    const thresholdPct = (batchLib.EXPECTED_POOL_MIN_RATIO * 100).toFixed(0);
    console.error('\n' + '!'.repeat(72));
    console.error('SANITY CHECK FAILED — NOTHING WAS SENT TO ANTHROPIC FOR THIS RUN');
    console.error('!'.repeat(72));
    console.error(`Found:    ${sanityCheck.eligibleCount} eligible conversation(s) (this run's real, already-scanned result).`);
    console.error(`Expected: roughly ${sanityCheck.expectedPool} (a fast estimate: ${sanityCheck.totalMatchingMessages} matching message(s) minus ${sanityCheck.totalAlreadyProcessed} already-processed conversation(s)).`);
    console.error(`That's only ${ratioPct}% of the expected pool — below the ${thresholdPct}% threshold.`);
    console.error('This is the same shape as the real 2026-09-18 incident (33,755 found vs. ~84,192 expected, 40% of the pool) — an unexplained silent undercount.');
    console.error('\nThe run itself is safe: its full eligible list is already durably saved (nothing was lost), and nothing has been dispatched to Anthropic yet.');
    console.error('\nWhat to do next:');
    console.error(`  1. In the Supabase SQL Editor, look at this run's row (archive_search_significance_submission_runs, id = ${run.id}) and spot-check a sample of its submission_run_items against what you'd expect for since_date=${run.since_date || '(none)'}.`);
    console.error('  2. If the low count is real and expected (e.g. a genuinely small or already-mostly-processed date window), re-run this exact same command with --force to dispatch anyway.');
    console.error('  3. If the low count looks wrong, do NOT force it — flag this run for Neo/Q to investigate before anything is sent to Anthropic.');
    process.exitCode = 1;
    return;
  }

  console.log(`Dispatch: ${dispatch.chunksSubmitted} chunk(s) submitted, ${dispatch.itemsDispatched} conversation(s) dispatched` +
    `${dispatch.itemsSkippedEmpty ? `, ${dispatch.itemsSkippedEmpty} skipped (no messages found)` : ''}` +
    `${dispatch.itemsSkippedOversized ? `, ${dispatch.itemsSkippedOversized} skipped (a single conversation too large to fit in any chunk — needs manual review)` : ''}` +
    `${dispatch.chunksRateLimited ? `, ${dispatch.chunksRateLimited} chunk(s) rate-limited by Anthropic (will retry on the next run of this command)` : ''}.`);

  console.log('\nChecking every chunk (Anthropic batch) in this run and writing back any results that have finished (resumable, unchanged per-chunk polling/write-back logic)...');
  const resumed = await batchLib.checkAndResumeRun({ runId: run.id });
  if (resumed.results.length === 0) {
    console.log('  (no chunks submitted yet for this run — nothing to check.)');
  }
  for (const r of resumed.results) {
    if (r.alreadyCompleted) { console.log(`  chunk ${r.batchId}: already complete.`); continue; }
    if (r.failed) { console.log(`  chunk ${r.batchId}: marked failed — skipped.`); continue; }
    const writeBackText = r.writeBackSummary
      ? `, write-back: ${r.writeBackSummary.processed} processed (${r.writeBackSummary.written_significance} wrote a significance row), ${r.writeBackSummary.errors} error(s)`
      : '';
    console.log(`  chunk ${r.batchId} (${r.anthropicBatchId}): status=${r.anthropicStatus}${writeBackText}${r.nowCompleted ? ' — now fully complete' : ''}`);
  }

  if (!resumed.fullyProcessed) {
    console.log(`\nRun ${run.id} is not fully processed yet — some chunk(s) are still processing at Anthropic (up to 24 hours each), still rate-limited, or still need write-back. Re-run this same command later to continue.`);
    return;
  }

  console.log(`\nRun ${run.id} is now fully processed — every chunk's results have been written back.`);

  if (stage === 'call_1') {
    let totalWithSignificanceRow = 0;
    let totalNeedsCall2 = 0;
    for (const r of resumed.results) {
      const report = await batchLib.reportNeedsCall2({ batchId: r.batchId });
      totalWithSignificanceRow += report.totalWithSignificanceRow;
      totalNeedsCall2 += report.needsCall2Count;
    }
    console.log(`\n${totalNeedsCall2} of ${totalWithSignificanceRow} conversation(s) with a written significance row (across this run's ${resumed.results.length} chunk(s)) need a Call 2 pass.`);
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

module.exports = { parseStageArg, parseLimitArg, parseForceArg };
