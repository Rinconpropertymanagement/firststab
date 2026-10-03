#!/bin/bash
# Wrapper for the Scoreboard's weekly metric compute.
# Loads CRON_SECRET from .env instead of embedding it in the crontab line.
# X-Forwarded-Proto: https required -- see cron-create-cases-from-sync.sh
# for why (HTTPS-enforcement backstop only trusts that header from loopback).
#
# Runs once, Monday mornings. The nine Scoreboard metrics are weekly
# numbers -- a week is not eligible to publish until it has fully closed
# (latestPublishableWeek() in lib/week.js), so nothing is gained by
# checking more often. Before this existed, the Scoreboard only updated
# when someone ran this by hand -- added 2026-09-13 after that gap was
# found: Call Stats had a real nightly sync, the Scoreboard had nothing.
set -a
source /var/www/hub/.env
set +a
curl -s -X POST -H "X-Forwarded-Proto: https" -H "x-cron-secret: $CRON_SECRET" "http://localhost:3500/api/scorecard/internal/compute"
