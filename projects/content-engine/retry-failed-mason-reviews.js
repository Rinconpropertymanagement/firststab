#!/usr/bin/env node
/**
 * retry-failed-mason-reviews.js
 * Sweeps legal_claim_reviews for rows where Mason's automatic review never
 * completed (mason_finding IS NULL) and re-runs reviewClaimAsMason() on each.
 *
 * WHY THIS EXISTS: draft.js/revise.js each call reviewClaimAsMason() exactly
 * ONCE per newly-detected claim, right after insert, wrapped in its own
 * try/catch (see either file's comment right above that call) — a failure
 * there is caught and logged, but nothing else ever retries it. Before
 * 2026-08-18, a claim whose one attempt failed (most commonly: the model's
 * MASON_REVIEW JSON failing to parse — see lib/legal-review.js's
 * extractMasonReviewJson() for the real fix to that) sat with
 * mason_finding: null indefinitely, with no path forward except someone
 * noticing and re-running it by hand. reviewClaimAsMason() itself now
 * retries once internally before giving up, which closes most of that gap —
 * this script is the backstop for whatever still slips through (a claim
 * that failed both internal attempts, or one that was never attempted at
 * all because the process crashed between insert and review).
 *
 * Never touches peter_decision or any of Peter's own fields — same as
 * reviewClaimAsMason() itself. Safe to re-run any time; a row that already
 * has a mason_finding is simply skipped (not re-reviewed).
 *
 * Usage:
 *   node retry-failed-mason-reviews.js
 *   node retry-failed-mason-reviews.js --dry-run
 *   node retry-failed-mason-reviews.js --limit 10
 *   node retry-failed-mason-reviews.js --help
 */

// Same .env resolution convention as every other CLI script in this
// directory (backfill-published-posts.js, scan-legal-updates.js): look next
// to this file first (matches server deployment), fall back to the shared
// project-root .env two levels up (matches local dev's nested repo layout).
{
  const path = require('path');
  const fs = require('fs');
  const localEnvPath = path.join(__dirname, '.env');
  const sharedEnvPath = path.join(__dirname, '..', '..', '.env');
  const envPath = fs.existsSync(localEnvPath) ? localEnvPath : sharedEnvPath;
  require('dotenv').config({ path: envPath });
}

const { select } = require('./lib/supabase');
const { reviewClaimAsMason } = require('./lib/legal-review');

function printHelp() {
  console.log(`
retry-failed-mason-reviews.js — finds legal_claim_reviews rows where Mason's
automatic review pass never completed (mason_finding IS NULL) and re-runs
reviewClaimAsMason() on each one.

Usage:
  node retry-failed-mason-reviews.js
  node retry-failed-mason-reviews.js --dry-run   List the stuck rows, review none.
  node retry-failed-mason-reviews.js --limit 10  Only process the first N.
  node retry-failed-mason-reviews.js --help

Requires in .env:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY

What this does NOT do:
  - Does not touch peter_decision or any of Peter's own review fields.
  - Does not re-review a row that already has a mason_finding.
`);
}

function parseArgs(argv) {
  const args = { dryRun: false, limit: null, help: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg.startsWith('--limit')) {
      const val = arg.includes('=') ? arg.split('=')[1] : argv[argv.indexOf(arg) + 1];
      args.limit = Number(val);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  console.log('[retry-mason] Looking for legal_claim_reviews rows with no mason_finding...');
  let stuckRows = await select(
    'legal_claim_reviews',
    'select=id,content_item_id,claim_text,created_at&mason_finding=is.null&order=created_at.asc'
  );

  if (args.limit && args.limit > 0) {
    stuckRows = stuckRows.slice(0, args.limit);
  }

  if (stuckRows.length === 0) {
    console.log('[retry-mason] Nothing stuck — every claim already has a mason_finding.');
    return;
  }

  console.log(`[retry-mason] Found ${stuckRows.length} claim(s) with no mason_finding:`);
  for (const row of stuckRows) {
    console.log(`  - ${row.id} (content_item ${row.content_item_id}, created ${row.created_at}): "${row.claim_text.slice(0, 80)}${row.claim_text.length > 80 ? '...' : ''}"`);
  }

  if (args.dryRun) {
    console.log('\n[retry-mason] --dry-run: not reviewing anything.');
    return;
  }

  const stats = { succeeded: 0, stillFailed: 0 };
  for (const row of stuckRows) {
    try {
      const result = await reviewClaimAsMason(row.id);
      stats.succeeded++;
      console.log(`[retry-mason] ${row.id}: succeeded -> ${result.finding}`);
    } catch (e) {
      stats.stillFailed++;
      console.warn(`[retry-mason] ${row.id}: still failed -> ${e.message}`);
    }
  }

  console.log(
    `\n[retry-mason] Done. ${stats.succeeded} succeeded, ${stats.stillFailed} still failed ` +
      '(mason_finding remains null for those — safe to run this script again later).'
  );
}

main().catch((err) => {
  console.error(`\n[ERROR] ${err.message}`);
  process.exit(1);
});
