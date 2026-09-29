#!/usr/bin/env node
/**
 * scan-legal-updates.js
 * Discovery feed: searches LegiScan for California state bills relevant to
 * Rincon's compliance topics, keeps ONLY bills that have actually been
 * chaptered (signed into law), and writes non-duplicate candidates into
 * legal_update_candidates (review_status: 'pending') for Mason/Peter to
 * review.
 *
 * Does NOT touch compliance_claims and does NOT decide that any bill is a
 * real legal fact — this script's only output is pending candidate rows
 * plus one legal_update_scan_runs log row per run. See the migration
 * comment in supabase/migrations/20260715000000_legal_update_candidate_scan.sql
 * for the two-step human-review rule this schema enforces.
 *
 * Meant to be run on a schedule (e.g. cron, weekly) with no arguments:
 *   node scan-legal-updates.js
 *   node scan-legal-updates.js --help
 */

// Look for .env next to this file first (matches how it's deployed on the
// server, e.g. /var/www/content-engine/.env), and fall back to the shared
// project-root .env two levels up (matches local dev's nested repo layout,
// e.g. projects/content-engine/scan-legal-updates.js -> ../../.env).
// Whichever exists first wins — same pattern as scan-viral-topics.js.
{
  const path = require('path');
  const fs = require('fs');
  const localEnvPath = path.join(__dirname, '.env');
  const sharedEnvPath = path.join(__dirname, '..', '..', '.env');
  const envPath = fs.existsSync(localEnvPath) ? localEnvPath : sharedEnvPath;
  require('dotenv').config({ path: envPath });
}

const { runLegalUpdateScan, logScanRun } = require('./lib/legal-update-scan');

function printHelp() {
  console.log(`
scan-legal-updates.js — scans LegiScan for California state bills relevant
to Rincon's compliance topics, keeps ONLY bills that have actually been
chaptered (signed into law), and queues non-duplicate ones as pending
legal_update_candidates for Mason/Peter to review.

Usage:
  node scan-legal-updates.js
  node scan-legal-updates.js --help

Requires in .env:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (database)
  LEGISCAN_API_KEY                         (LegiScan full-text bill search)

What this does NOT do:
  - Does not write to compliance_claims, and does not decide any bill is a
    real, citable legal fact — every row it creates is a candidate for a
    human (Mason or Peter) to review
  - Does not surface a bill that is merely introduced, amended, or passed —
    only bills whose LegiScan progress history shows an actual Chaptered
    (signed into law) event
  - Every run (success or failure) is logged to legal_update_scan_runs
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  console.log('Scanning LegiScan for newly chaptered California bills...');

  const stats = { candidatesCreated: 0 };
  try {
    await runLegalUpdateScan(stats);
    await logScanRun({
      succeeded: true,
      candidatesCreated: stats.candidatesCreated,
      errorMessage: stats.topicSearchWarning || null,
    });
    console.log(
      `\n✓ Scan complete. ${stats.candidatesCreated} new candidate(s) added to ` +
        'legal_update_candidates (review_status: pending).'
    );
    if (stats.topicSearchWarning) {
      console.warn(`[scan-legal-updates] ${stats.topicSearchWarning}`);
    }
  } catch (err) {
    await logScanRun({
      succeeded: false,
      candidatesCreated: stats.candidatesCreated,
      errorMessage: err.message,
    });
    console.error(`\n[ERROR] ${err.message}`);
    process.exit(1);
  }
}

main();
