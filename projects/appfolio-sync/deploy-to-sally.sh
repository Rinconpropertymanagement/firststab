#!/bin/bash
# deploy-to-sally.sh
#
# Copies sync.js (and its dependencies) to Sally, so a committed change to
# this project is never again stuck relying on someone remembering to copy
# it over by hand.
#
# WHY THIS SCRIPT EXISTS (2026-08-27):
# This project has run on Sally by manual file copy since it was first set
# up — unlike projects/hub and projects/calendar-assistant, which each
# already had a deploy-to-sally.sh. On 2026-08-19 a commit added two new
# report entries (general_ledger, annual_budget_forecast) to sync.js's
# REPORT_CONFIG. The updated file was never copied to Sally. Because
# REPORT_CONFIG is just a plain array sync.js loops over, the two missing
# entries didn't error — they simply didn't exist in the code Sally was
# actually running, so the two tables they populate silently stopped
# receiving new rows while every other report kept syncing normally on the
# stale file. It went unnoticed for 8 days, caught only when a separate
# feature (Approval Briefing) needed one of the missing tables and asked
# why it hadn't updated recently. This script closes that gap the same way
# hub/deploy-to-sally.sh closed an analogous one for the Hub.
#
# Usage:
#   bash deploy-to-sally.sh
#
# Modeled on projects/hub/deploy-to-sally.sh (rsync + npm install + verify)
# and projects/calendar-assistant/deploy-to-sally.sh (this project's own
# closer analog — also a cron-invoked script, not a pm2-managed server, so
# there's no process to restart and no HTTP health check to run).
#
# Note on .env: unlike calendar-assistant, this project does NOT have its
# own .env — sync.js loads one from two directories up
# (`path.join(__dirname, '../../.env')`), which on Sally resolves to the
# shared /var/.env every other credential on this box already reads from.
# This script deliberately never touches that file.

set -e  # stop on any error — if any step fails, later steps do not run

SALLY="sally"
REMOTE_DIR="/var/www/appfolio-sync"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Copying appfolio-sync code to Sally..."
# --delete removes files on Sally that no longer exist locally; .env is
# excluded even though this project doesn't have one, purely as a
# never-accidentally-touch-a-credential-file backstop, matching every other
# deploy script in this repo.
rsync -az --delete \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '.git' \
  --exclude '.DS_Store' \
  --exclude '*.log' \
  "$LOCAL_DIR/" "$SALLY:$REMOTE_DIR/"

echo ""
echo "==> Installing/updating npm packages on Sally..."
ssh "$SALLY" "cd $REMOTE_DIR && npm install --omit=dev"

echo ""
echo "==> Verifying the deployed file matches this repo exactly..."
if command -v md5sum >/dev/null 2>&1; then
  LOCAL_HASH=$(md5sum "$LOCAL_DIR/sync.js" | awk '{print $1}')
else
  LOCAL_HASH=$(md5 -q "$LOCAL_DIR/sync.js")
fi
REMOTE_HASH=$(ssh "$SALLY" "md5sum $REMOTE_DIR/sync.js | awk '{print \$1}'")
if [ "$LOCAL_HASH" != "$REMOTE_HASH" ]; then
  echo "  !!! Hash mismatch after copy — local: $LOCAL_HASH, remote: $REMOTE_HASH"
  echo "  !!! Deployment did not land cleanly."
  exit 1
fi
echo "    sync.js hash matches: $LOCAL_HASH"

echo ""
echo "==> Running --dry-run on Sally to confirm every report entry actually runs..."
# This is the check that would have caught the 2026-08-19 incident within
# hours instead of 8 days: --dry-run fetches and maps every REPORT_CONFIG
# entry (no Supabase writes) and prints one summary line per report. If a
# future change silently drops or fails to reach a report entry the same
# way, this fails loudly here instead of failing silently on Sally's cron.
DRY_RUN_OUTPUT=$(ssh "$SALLY" "cd $REMOTE_DIR && node sync.js --dry-run" 2>&1) || {
  echo "  !!! --dry-run failed:"
  echo "$DRY_RUN_OUTPUT"
  exit 1
}
MISSING=""
for REPORT in general_ledger annual_budget_forecast property_directory unit_directory tenant_directory lease_expiration_detail; do
  echo "$DRY_RUN_OUTPUT" | grep -q "$REPORT" || MISSING="$MISSING $REPORT"
done
if [ -n "$MISSING" ]; then
  echo "  !!! --dry-run completed but these expected reports never appeared in its output:$MISSING"
  echo "  !!! This is exactly the failure mode this script exists to catch — investigate before relying on cron."
  exit 1
fi
echo "    --dry-run completed; all expected report entries present."

echo ""
echo "==================================================="
echo "  Deployment complete."
echo "  sync.js is running at $REMOTE_DIR, invoked by Sally's existing"
echo "  crontab (unchanged by this script — see 'crontab -l' on Sally)."
echo "  Logs: /var/log/appfolio-sync.log"
echo "==================================================="
