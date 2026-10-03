#!/bin/bash
# Wrapper for the Archive Search screening-pass hourly cron job.
# Loads CRON_SECRET from .env instead of embedding it in the crontab line.
# X-Forwarded-Proto: https required — see cron-create-cases-from-sync.sh
# for why (HTTPS-enforcement backstop only trusts that header from loopback).
#
# Added 2026-09-18 (Scotty), per Asimov's clearance of the Archive Search
# screening pass (Fair Housing screening of Missive mail) for AUTOMATIC
# scheduling — condition: a circuit breaker that stops a chunk early and
# alerts Peter if its error rate looks unhealthy. That circuit breaker
# lives server-side (lib/screening-pass.js's CIRCUIT_BREAKER_* constants,
# checked inside runScreeningPassChunk()'s own per-conversation loop) and
# fires archive-search/router.js's existing sendFailureAlertEmail() when
# tripped — this script itself stays a plain one-shot curl, same shape as
# every other cron-*.sh wrapper in this project.
#
# Runs exactly ONE chunk of up to 500 pending conversations per call (see
# router.js's process-pending route comment) — ordinary hourly mail volume
# is far below that, so one call per scheduled hour is normally enough;
# if it's ever not, the next hour picks up where this one left off, same
# as a human calling this route by hand.
#
# The archive-search significance/complaint-triage pass has its own,
# separate route for this same shape (process-significance-pending-
# scheduled) but is DELIBERATELY NOT wired into cron yet — see that
# route's own comment in archive-search/router.js for why and for exactly
# what turns it on later. Do not create a cron-archive-search-
# significance.sh file or crontab entry until that condition is met.
set -a
source /var/www/hub/.env
set +a
curl -s -X POST -H "X-Forwarded-Proto: https" -H "x-cron-secret: $CRON_SECRET" "http://localhost:3500/api/archive-search/process-pending"
