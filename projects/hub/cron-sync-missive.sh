#!/bin/bash
# Wrapper for the email-intake Missive incremental sync cron job.
# Loads CRON_SECRET from .env instead of embedding it in the crontab line.
# X-Forwarded-Proto: https required — see cron-create-cases-from-sync.sh
# for why (HTTPS-enforcement backstop only trusts that header from loopback).
# Scheduled every 30 minutes 2026-09-07 — not time-sensitive per Peter,
# so a longer interval than maintenance-history's 15-minute ingest is fine.
# Route is overlap-safe (missiveSyncRunning flag in router.js, returns 409
# and skips if a prior run is still going), matching this project's other
# cron-triggered internal routes.
set -a
source /var/www/hub/.env
set +a
curl -s -X POST -H "X-Forwarded-Proto: https" -H "x-cron-secret: $CRON_SECRET" "http://localhost:3500/api/email-intake/internal/sync-missive"
