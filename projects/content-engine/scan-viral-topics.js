#!/usr/bin/env node
/**
 * scan-viral-topics.js
 * Discovery feed: searches YouTube for recent videos trending around
 * Rincon's compliance topics, ranks them by view velocity, and writes
 * relevant, non-duplicate candidates into topic_suggestions (status:
 * 'pending') for Peter to review on the /topics page.
 *
 * Does NOT draft anything, does NOT touch content_items, and does NOT call
 * draftContent() — this script's only output is pending suggestion rows
 * plus one topic_scan_runs log row per run.
 *
 * Meant to be run on a schedule (e.g. cron, every 3 days) with no arguments:
 *   node scan-viral-topics.js
 *   node scan-viral-topics.js --help
 */

// Look for .env next to this file first (matches how it's deployed on the
// server, e.g. /var/www/content-engine/.env), and fall back to the shared
// project-root .env two levels up (matches local dev's nested repo layout,
// e.g. projects/content-engine/scan-viral-topics.js -> ../../.env). Whichever
// exists first wins — this makes the same file work correctly in both places.
{
  const path = require('path');
  const fs = require('fs');
  const localEnvPath = path.join(__dirname, '.env');
  const sharedEnvPath = path.join(__dirname, '..', '..', '.env');
  const envPath = fs.existsSync(localEnvPath) ? localEnvPath : sharedEnvPath;
  require('dotenv').config({ path: envPath });
}

const { runViralTrendScan, logScanRun } = require('./lib/viral-scan');

function printHelp() {
  console.log(`
scan-viral-topics.js — scans YouTube for recent, high-velocity videos about
Rincon's compliance topics and queues relevant, non-duplicate ones as
pending topic_suggestions for Peter to review.

Usage:
  node scan-viral-topics.js
  node scan-viral-topics.js --help

Requires in .env:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (database)
  ANTHROPIC_API_KEY                        (relevance/duplicate judgment)
  YOUTUBE_API_KEY                          (YouTube Data API v3 search)

What this does NOT do:
  - Does not draft any content or touch content_items
  - Does not state or imply any legal fact — it only notices that public
    interest in a topic exists right now
  - Every run (success or failure) is logged to topic_scan_runs, visible on
    the /topics review page
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  console.log('Scanning YouTube for viral landlord-tenant topics...');

  const stats = { suggestionsCreated: 0 };
  try {
    await runViralTrendScan(stats);
    await logScanRun({ succeeded: true, suggestionsCreated: stats.suggestionsCreated });
    console.log(
      `\n✓ Scan complete. ${stats.suggestionsCreated} new suggestion(s) added to ` +
        'topic_suggestions (status: pending).'
    );
  } catch (err) {
    await logScanRun({
      succeeded: false,
      suggestionsCreated: stats.suggestionsCreated,
      errorMessage: err.message,
    });
    console.error(`\n[ERROR] ${err.message}`);
    process.exit(1);
  }
}

main();
