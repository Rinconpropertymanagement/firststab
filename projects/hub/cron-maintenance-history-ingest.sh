#!/bin/bash
# Wrapper for the Maintenance History nightly Latchel ingest cron job.
# Loads CRON_SECRET from .env instead of embedding it in the crontab line.
# X-Forwarded-Proto: https required — see cron-create-cases-from-sync.sh
# for why (HTTPS-enforcement backstop only trusts that header from loopback).
# Added 2026-08-31 — this sync was built and deployed but never scheduled
# (last real run was 2026-08-16, manual); confirmed live 2026-08-31 that it
# completes correctly (364 jobs, 3653 claims, 0 errors) — the one test that
# looked like a hang was actually just the first catch-up run taking about
# 67 minutes; it tracks what is already current, so nightly runs going
# forward should be much faster. Recreated 2026-09-01 after a deploy's
# rsync --delete removed this file (it lives only on Sally, not in git).
set -a
source /var/www/hub/.env
set +a
curl -s -X POST -H "X-Forwarded-Proto: https" -H "x-cron-secret: $CRON_SECRET" "http://localhost:3500/api/maintenance-history/internal/ingest?since_days=30"
