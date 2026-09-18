#!/usr/bin/env node
/**
 * run-significance-pilot.js
 *
 * ============================================================================
 * PHASE 1 PILOT — archive-search-significance-technical-spec.md (v2),
 * Section 10 / Section 12. Processes the FIRST batch of eligible
 * conversations (default 100, Peter's own allowance up to 200 — spec
 * Section 12: "good amount. might need another 100.") synchronously, in
 * real time, through the merged Call 1 / Call 2 significance + complaint-
 * triage pass (lib/significance-pass.js) — the SAME shadow-mode sample
 * that satisfies GOVERNANCE.md Rule 6's exit criterion. Every row this
 * script writes is stamped discovery_context = 'historical_backfill'.
 *
 * THIS RUNS AGAINST REAL MAIL AND MAKES REAL, BILLED AI CALLS. It is not a
 * dry run (unlike dry-run-wide-net-measurement.js in this same directory)
 * — running it writes real rows into missive_conversation_significance
 * and, for actionable findings, complaints.
 *
 * ============================================================================
 * MUST RUN ON SALLY. NEVER LOCALLY. RESTATED BECAUSE THIS EXACT MISTAKE
 * ALREADY HAPPENED ONCE ON THIS PROJECT (the original Fair Housing scan).
 * ============================================================================
 * Do not run this on a laptop, even for a first test. The correct way to
 * launch it (mirroring /tmp/sally-screening-loop.sh's own precedent —
 * launched ON sally itself, surviving independent of any SSH session):
 *
 *   ssh sally
 *   cd /var/www/hub                    # deployed hub code, per deploy-to-sally.sh's REMOTE_DIR
 *   nohup node projects/hub/archive-search/run-significance-pilot.js \
 *     > /tmp/significance-pilot.log 2>&1 & disown
 *   # then, from the same or a later SSH session:
 *   tail -f /tmp/significance-pilot.log
 *
 * At 100-200 conversations this finishes in well under an hour even
 * without nohup/disown, but the requirement is independent of runtime —
 * see this script's own README-in-code above and spec Section 10's own
 * "must be independently verified live on the server, not assumed from
 * the code" instruction. Whoever runs this (Peter, or Scotty) should
 * confirm they are actually on sally (`hostname`) before running it.
 *
 * ============================================================================
 * AFTER IT FINISHES
 * ============================================================================
 * Review the results via GET /api/archive-search/significance-pilot-export
 * (archive-search/router.js, admin-only) — a CSV of every
 * discovery_context='historical_backfill' row this pilot produced, plus
 * whether each one created a linked complaints row. This is the "actually
 * look at it by hand" step spec Section 12 requires before Peter decides
 * whether to expand to the full-scale Phase 2 (Batches API) run — NOT
 * built by this script, and not built anywhere in this pass; that is a
 * separate, later, explicitly-deferred build.
 *
 * ============================================================================
 * STAGED-BY-RECENCY BACKFILL (Peter's request, 2026-09-17)
 * ============================================================================
 * Peter wants to run the ~250,487-conversation historical archive in
 * date-scoped stages by recency — the last 1 year first, review real
 * results and cost, then decide whether to expand further back (another
 * year, etc.) — rather than committing to the whole archive at once.
 * --since-years / --since-date (mutually exclusive) restrict which
 * conversations even become eligible: a conversation qualifies if its
 * MOST RECENT message's delivered_at is on/after the cutoff — not whether
 * the conversation started before or after it (see lib/significance-
 * pass.js, the sinceDate block just above fetchDriverPage(), for the full
 * semantics and correctness argument). Omit both flags for the original,
 * unrestricted behavior (every eligible conversation, oldest first) —
 * unchanged from before this flag existed.
 *
 * Usage:
 *   node run-significance-pilot.js                    Process 100 conversations (default), no date cutoff.
 *   node run-significance-pilot.js --count=200         Process up to 200 (Peter's own stated ceiling).
 *   node run-significance-pilot.js --since-years=1     Only conversations active within the last 1 year.
 *   node run-significance-pilot.js --since-date=2025-09-17   Only conversations active on/after this exact date.
 *   node run-significance-pilot.js --since-years=1 --count=200   Combine a date cutoff with a higher count.
 *   node run-significance-pilot.js --help              Show this help and exit.
 */

{
  const path = require('path');
  const fs = require('fs');
  // Same candidate-path search dry-run-wide-net-measurement.js's own
  // header already uses — local dev's three-levels-up layout, or a
  // flatter deployed layout (sally's /var/www/hub, per deploy-to-sally.sh).
  const candidates = [
    path.join(__dirname, '.env'),
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '..', '..', '.env'),
  ];
  const envPath = candidates.find((p) => fs.existsSync(p)) || candidates[candidates.length - 1];
  require('dotenv').config({ path: envPath });
}

const DEFAULT_PILOT_COUNT = 100;
const PILOT_CEILING_WARNING = 200; // Peter's own stated ceiling (spec Section 12) — a printed reminder, not a hard block; expanding past it without his go-ahead is a process discipline, not something this script enforces.

function printHelp() {
  console.log(`
run-significance-pilot.js — Phase 1 pilot (spec Section 10/12)

Processes eligible historical conversations synchronously through the
merged significance + complaint-triage pass. MAKES REAL AI CALLS AND
REAL DATABASE WRITES. MUST RUN ON SALLY, NEVER LOCALLY — see this file's
own header comment before running it.

Usage:
  node run-significance-pilot.js
  node run-significance-pilot.js --count=200
  node run-significance-pilot.js --since-years=1
  node run-significance-pilot.js --since-date=2025-09-17
  node run-significance-pilot.js --since-years=1 --count=200
  node run-significance-pilot.js --help

Date cutoff (optional, mutually exclusive — omit both for no cutoff):
  --since-years=N       Only conversations active within the last N years (fractional allowed, e.g. 0.5).
  --since-date=YYYY-MM-DD   Only conversations active on/after this exact date.
  "Active" means: the conversation's MOST RECENT message was delivered on/after
  the cutoff — a conversation that started years ago but has recent activity
  still qualifies. See lib/significance-pass.js for the full semantics.
`);
}

function parseCountArg(args) {
  const match = args.find((a) => a.startsWith('--count='));
  if (!match) return DEFAULT_PILOT_COUNT;
  const n = Number.parseInt(match.split('=')[1], 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PILOT_COUNT;
}

// ============================================================
// Staged-by-recency backfill flags (Peter's request, 2026-09-17) — pure,
// unit-tested (test/run-tests.js), no I/O. Returns { sinceDate, error }:
// sinceDate is an ISO 'YYYY-MM-DD' string or null (no cutoff — the
// original, unrestricted default when neither flag is passed); error is a
// human-readable string or null. Never throws — a bad flag is reported as
// an error string so main() can print it and exit cleanly, not crash.
// ============================================================
function computeSinceDateFromYears(years, now = new Date()) {
  // Whole days back, via getTime() arithmetic rather than
  // Date#setFullYear — avoids the leap-year/month-length edge cases
  // setFullYear can hit (e.g. Feb 29 minus 1 year), and supports a
  // fractional --since-years=0.5 the same way an integer one works.
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const daysBack = Math.round(years * 365.25);
  const cutoff = new Date(now.getTime() - daysBack * MS_PER_DAY);
  return cutoff.toISOString().slice(0, 10); // 'YYYY-MM-DD' — a bare date is enough precision for a "which year(s) to include" staging decision.
}

function parseSinceArgs(args) {
  const sinceDateArg = args.find((a) => a.startsWith('--since-date='));
  const sinceYearsArg = args.find((a) => a.startsWith('--since-years='));

  if (sinceDateArg && sinceYearsArg) {
    return { sinceDate: null, error: 'Pass only one of --since-date or --since-years, not both.' };
  }

  if (sinceDateArg) {
    const value = sinceDateArg.slice('--since-date='.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(value).getTime())) {
      return { sinceDate: null, error: `--since-date must be a valid YYYY-MM-DD date, got "${value}".` };
    }
    return { sinceDate: value, error: null };
  }

  if (sinceYearsArg) {
    const value = sinceYearsArg.slice('--since-years='.length);
    const years = Number.parseFloat(value);
    if (!Number.isFinite(years) || years <= 0) {
      return { sinceDate: null, error: `--since-years must be a positive number, got "${value}".` };
    }
    return { sinceDate: computeSinceDateFromYears(years), error: null };
  }

  return { sinceDate: null, error: null }; // neither flag passed — no cutoff, the original unrestricted behavior.
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  const count = parseCountArg(args);
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
  console.log('ARCHIVE SEARCH SIGNIFICANCE PILOT — Phase 1 (spec Section 10/12)');
  console.log('='.repeat(72));
  console.log(`Host:  ${os.hostname()}`);
  console.log(`Target conversation count: ${count}${count > PILOT_CEILING_WARNING ? `  (WARNING: above Peter's own stated ${PILOT_CEILING_WARNING}-conversation ceiling — confirm this is intentional and approved)` : ''}`);
  console.log(`Date cutoff: ${sinceDate ? `${sinceDate} — only conversations whose MOST RECENT message is on/after this date` : 'none — every eligible conversation is in scope, oldest first'}`);
  console.log('This makes REAL AI calls and REAL database writes, stamped discovery_context = \'historical_backfill\'.');
  console.log('If this is not running on sally right now, stop and re-launch there instead — see this file\'s own header.\n');

  const { runSignificancePassBatch } = require('./lib/significance-pass');
  // Cross-process lock (lib/significance-lock.js — Asimov's flagged gap,
  // 2026-09-18, automatic-scheduling review): prevents this pilot from
  // ever running at the same time as run-significance-batch.js or the
  // Hub's own significance routes (archive-search/router.js) — all four
  // write into the same significance rows and none of them coordinated
  // with each other before this.
  const { withSignificanceLock } = require('./lib/significance-lock');

  const startedAt = Date.now();
  const summary = await withSignificanceLock(
    `standalone-pilot --count=${count}${sinceDate ? ` --since-date=${sinceDate}` : ''}`,
    () => runSignificancePassBatch({ limit: count, discoveryContext: 'historical_backfill', sinceDate })
  );
  const elapsedSec = Math.round((Date.now() - startedAt) / 100) / 10;

  console.log(`\nDone in ${elapsedSec}s.\n`);
  console.log('='.repeat(72));
  console.log('PILOT RESULTS');
  console.log('='.repeat(72));
  console.log(`Conversations processed:        ${summary.conversations_processed}`);
  console.log(`  Call 2 retried (previously stuck): ${summary.call2_retried || 0}`);
  console.log(`  Call 2 completed:             ${summary.call2_completed}`);
  console.log(`  Call 2 failed (placeholder):  ${summary.call2_failed_placeholder}`);
  console.log(`  Complaints rows created:      ${summary.complaints_created}`);
  console.log(`Call 1 total failures (no row): ${summary.call1_failed}`);
  console.log(`Errors:                          ${summary.errors}`);
  console.log('='.repeat(72));
  console.log('\nNext step: review these results by hand before deciding whether to');
  console.log('expand — GET /api/archive-search/significance-pilot-export (admin-only).');
  if (summary.conversations_processed < count) {
    console.log(`\nNote: fewer than ${count} conversations were found eligible — this may mean the`);
    console.log('archive is smaller than expected, or most of it is already processed.');
  }
}

// require.main guard — lets test/run-tests.js require this file to unit-
// test parseSinceArgs/computeSinceDateFromYears (pure, no I/O) without
// actually launching the pilot (which would need real env vars and would
// make real, billed AI calls).
if (require.main === module) {
  main().catch((err) => {
    console.error('Pilot run failed:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { parseSinceArgs, computeSinceDateFromYears, parseCountArg };
