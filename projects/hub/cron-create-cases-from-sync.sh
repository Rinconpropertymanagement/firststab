#!/bin/bash
# Wrapper for the security-deposit "create cases from sync" cron job.
# Loads CRON_SECRET from .env instead of embedding it in the crontab line.
# X-Forwarded-Proto: https is required here because hub's HTTPS-enforcement
# backstop (server.js, ~line 269) 301-redirects any non-secure request when
# NODE_ENV=production, and Express only trusts that header from loopback
# (app.set('trust proxy', 'loopback')) — which this curl, running on Sally
# itself against localhost, genuinely is. Without it every cron hit 301s
# and never reaches the route (confirmed live 2026-08-28).
# Added 2026-08-28 by Scotty — pre-change crontab backed up in /root/crontab-backups/
# Recreated 2026-08-31 after a deploy's rsync --delete removed this file
# (it lived only on Sally, not in the git repo) — recreated from the exact
# content read via SSH earlier the same night, verified byte-for-byte.
set -a
source /var/www/hub/.env
set +a
curl -s -X POST -H "X-Forwarded-Proto: https" -H "x-cron-secret: $CRON_SECRET" http://localhost:3500/api/security-deposit/internal/create-cases-from-sync
