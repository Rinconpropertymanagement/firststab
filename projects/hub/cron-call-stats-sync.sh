#!/bin/bash
# Wrapper for the Call Stats nightly Aircall sync cron job.
# Loads CRON_SECRET from .env instead of embedding it in the crontab line.
# X-Forwarded-Proto: https required — see cron-create-cases-from-sync.sh
# for why (HTTPS-enforcement backstop only trusts that header from loopback).
# This sync was built and deployed on 2026-08-20 but never scheduled, then
# blocked by a bad Aircall credential (403 Forbidden) once scheduling was
# attempted. Fixed 2026-09-01: the token in .env had a stray trailing
# backslash locally, and production's credentials were a different,
# genuinely invalid pair — both replaced with a confirmed-working
# ID/token, verified live against /v1/ping before this was re-scheduled.
set -a
source /var/www/hub/.env
set +a
curl -s -X POST -H "X-Forwarded-Proto: https" -H "x-cron-secret: $CRON_SECRET" "http://localhost:3500/api/call-stats/internal/sync"
