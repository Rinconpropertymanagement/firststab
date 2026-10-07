#!/bin/bash
# Wrapper for the insurance-compliance "new property check" cron job.
# Loads CRON_SECRET from .env instead of embedding it in the crontab line.
# Added 2026-08-25 by Scotty — pre-change crontab backed up in /root/crontab-backups/
set -a
source /var/www/insurance-compliance/.env
set +a
curl -s -X POST -H "x-cron-secret: $CRON_SECRET" http://localhost:3456/api/insurance/internal/check-new-properties
