#!/bin/bash
# Wrapper for the Archive Search significance/complaint-triage pass's
# automatic scheduling.
# Loads CRON_SECRET from .env instead of embedding it in the crontab line.
# X-Forwarded-Proto: https required — see cron-create-cases-from-sync.sh
# for why (HTTPS-enforcement backstop only trusts that header from loopback).
#
# Added 2026-10-01, per Asimov's CLEARED WITH CONDITIONS verdict on this
# pass's own trial period (compliance/archive-search-significance-*.md,
# and the real 2-day live trial reviewed directly by Peter). Two
# conditions, both closed before this file was created: (1) Peter's own
# real-time review across both trial days, satisfying the project's
# either-Peter-or-the-DO sign-off requirement; (2) a per-run failure alert
# — significancePassAlertShouldFire()/sendSignificancePassAlertEmail() in
# archive-search/lib/significance-pass.js, firing to DO_EMAIL/PETER_EMAIL
# when a run's errors+call1_failed+call2_failed_placeholder count hits 3
# or more — wired into both this scheduled route and the existing manual
# one.
#
# Was deliberately NOT wired into cron before this — see this same
# comment's own prior text, preserved in git history on
# cron-archive-search-screening.sh, for the original hold.
#
# Same one-shot-per-call shape as the screening pass's own cron wrapper —
# runs the scheduled route's own default batch size per call; the next
# scheduled hour picks up where this one left off, same as a human
# calling the manual route by hand.
set -a
source /var/www/hub/.env
set +a
curl -s -X POST -H "X-Forwarded-Proto: https" -H "x-cron-secret: $CRON_SECRET" "http://localhost:3500/api/archive-search/process-significance-pending-scheduled?limit=50&since_date=2026-10-01"
