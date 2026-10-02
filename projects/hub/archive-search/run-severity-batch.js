#!/usr/bin/env node
/**
 * run-severity-batch.js
 *
 * The retroactive complaint severity-tier backfill — CLI driver for
 * lib/severity-batch.js. Read that file's header in full first (why this is
 * a deliberately simpler design than run-significance-batch.js's own
 * run/chunk tracking, and why that's a flagged scope decision, not a
 * missed requirement).
 *
 * ============================================================================
 * DO NOT RUN THIS FOR REAL YET
 * ============================================================================
 * This makes real, billed Anthropic API calls and writes real rows into
 * `complaints` and `audit_log`. lib/severity-batch.js's own
 * submitSeverityBatch() refuses to submit anything unless
 * SEVERITY_BATCH_GOVERNANCE_CLEARED=true is set — as of this build that is
 * NOT set anywhere real. Two things have to happen first, both outside this
 * tool's control:
 *   1. Peter applies both schema migrations (supabase/migrations/
 *      20261002010000_add_severity_tier_to_complaints.sql and
 *      20261002020000_add_no_issue_protected_signal_guard_to_complaints.sql)
 *      via Supabase's SQL Editor — these columns do not exist on the live
 *      `complaints` table yet.
 *   2. Mason's scoped review of the accommodation/protected-class
 *      interaction clears (relayed via Jarvis) — Asimov's review already
 *      flagged severity_tier as a new score with real Fair Housing stakes
 *      (see the first migration's own "GOVERNANCE FLAG" section).
 * Running this command before both are true will either error immediately
 * (column does not exist) or, worse, be refused by the tool's own gate —
 * do not work around that gate.
 *
 * ============================================================================
 * MUST RUN ON SALLY. NEVER LOCALLY. Same standing rule every other real,
 * billed batch tool in this codebase carries (run-significance-batch.js,
 * run-significance-pilot.js) — restated here, not assumed.
 * ============================================================================
 *   ssh sally
 *   cd /var/www/hub
 *   nohup node projects/hub/archive-search/run-severity-batch.js \
 *     > /tmp/severity-batch.log 2>&1 & disown
 *   tail -f /tmp/severity-batch.log
 *
 * ============================================================================
 * HOW TO USE IT — re-run the SAME command; it figures out what to do next
 * ============================================================================
 *   - No in-flight batch known -> submits one (up to --limit rows, default
 *     Anthropic's own 100,000-request ceiling; at today's real ~2,733-row
 *     volume this is the entire backfill in one submission).
 *   - An in-flight batch exists -> checks its status; once Anthropic
 *     reports it 'ended', downloads and writes back every result
 *     (resumable — a crash or a rate limit just means re-running this same
 *     command later picks up exactly where it left off).
 *
 * Usage:
 *   node run-severity-batch.js                 Submit (or check/resume) the backfill, up to the 100,000-request cap.
 *   node run-severity-batch.js --limit=50      Cap a NEW submission at 50 complaints (a small first real test).
 *   node run-severity-batch.js --help          Show this help and exit.
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
run-severity-batch.js — complaint severity-tier retroactive backfill

Submits (or checks/resumes) one Anthropic Message Batch of the calibrated
severity rubric against every complaint whose severity_tier is still NULL
(not yet assessed). MAKES REAL AI CALLS AND REAL DATABASE WRITES, ONCE
CLEARED — see this file's own header, "DO NOT RUN THIS FOR REAL YET," before
running it at all. MUST RUN ON SALLY, NEVER LOCALLY.

Usage:
  node run-severity-batch.js
  node run-severity-batch.js --limit=50
  node run-severity-batch.js --help

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
  const severityBatch = require('./lib/severity-batch');

  const state = severityBatch.readState();

  if (!state || state.results_retrieved_at) {
    console.log('No in-flight severity batch found — attempting to submit a new one...');
    const result = await severityBatch.submitSeverityBatch({ limit });
    if (!result.submitted) {
      console.log(`\nNothing submitted (${result.reason}).`);
      if (result.state) console.log(`Existing in-flight batch: ${result.state.anthropic_batch_id}`);
      return;
    }
    console.log(`\nSubmitted batch ${result.state.anthropic_batch_id} with ${result.requestCount} complaint(s).`);
    if (result.skippedOversized) console.log(`${result.skippedOversized} row(s) skipped as individually oversized — needs manual review.`);
    if (result.remainingEligibleAfterThisChunk) console.log(`${result.remainingEligibleAfterThisChunk} more eligible complaint(s) remain for a future run once this batch completes.`);
    console.log('Re-run this same command later to check status and write back results once Anthropic finishes (up to 24 hours).');
    return;
  }

  console.log(`Found in-flight severity batch: ${state.anthropic_batch_id} (submitted ${state.submitted_at}, ${state.complaint_ids.length} complaint(s))`);
  const result = await severityBatch.checkAndWriteBackSeverityBatch();
  if (!result.alreadyComplete) {
    console.log(`Status: ${result.status} — still processing at Anthropic. Re-run this same command later to check again.`);
    return;
  }
  if (!result.justCompleted) {
    console.log('This batch\'s results were already fully written back by an earlier run.');
    return;
  }
  console.log(`\nBatch ${state.anthropic_batch_id} fully processed: ${result.summary.processed} processed, ${result.summary.written} wrote a severity assessment, ${result.summary.no_row_written} wrote nothing (stay eligible for a future run), ${result.summary.errors} error(s).`);
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
  console.log('COMPLAINT SEVERITY-TIER BACKFILL — Message Batches API');
  console.log('='.repeat(72));
  console.log(`Host: ${os.hostname()}`);
  console.log('This makes REAL, BILLED AI calls and REAL database writes, once cleared.');
  console.log('If SEVERITY_BATCH_GOVERNANCE_CLEARED is not set to \'true\', submission will be refused — see this file\'s own header.');
  console.log('If this is not running on sally right now, stop and re-launch there instead.\n');

  const { withSeverityLock } = require('./lib/severity-lock');
  await withSeverityLock(`severity-batch${limit ? ` --limit=${limit}` : ''}`, () => runBatchWork({ limit }));
}

if (require.main === module) {
  loadDotEnv();
  main().catch((err) => {
    console.error('Severity batch run failed:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { parseLimitArg };
