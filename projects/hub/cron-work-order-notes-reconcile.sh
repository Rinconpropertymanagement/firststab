#!/bin/bash
# Wrapper for the Work Order Notes Alert hourly backstop poll
# (work-order-notes-alert-SPEC.md Section 2.4) -- catches any Latchel
# webhook delivery that never arrived (Latchel documents no delivery
# guarantee). Calls reconcileWorkOrderNotes() in
# approval-briefing/lib/work-order-notes-alert.js, which looks back a
# fixed 2 days (RECONCILE_LOOKBACK_DAYS) via latchel.listJobsUpdatedSince()
# -- no query params needed on this route.
# Safe to run repeatedly or on overlapping windows: the dedup/retry table
# (work_order_note_alerts, unique on latchel_job_id) makes re-scanning a
# job that's already been sent, or one that still doesn't qualify, a
# guaranteed no-op -- see that table's migration header for why.
# Loads CRON_SECRET from .env instead of embedding it in the crontab line.
# X-Forwarded-Proto: https required -- see cron-create-cases-from-sync.sh
# for why (the HTTPS-enforcement backstop in server.js only trusts that
# header from loopback, i.e. exactly this curl running on Sally itself).
# Added 2026-09-22 by Scotty, right after deploying the feature itself,
# per Jarvis/Peter's explicit go-ahead. Lives only on Sally, not in git --
# same convention as every other cron-*.sh wrapper in this folder (a
# deploy's rsync --delete is configured to exclude cron-*.sh for exactly
# this reason -- see deploy-to-sally.sh's own header comment).
set -a
source /var/www/hub/.env
set +a
curl -s -X POST -H "X-Forwarded-Proto: https" -H "x-cron-secret: $CRON_SECRET" "http://localhost:3500/api/approval-briefing/internal/reconcile-work-order-notes"
