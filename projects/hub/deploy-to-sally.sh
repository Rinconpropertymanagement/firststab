#!/bin/bash
# deploy-to-sally.sh
#
# Deploys projects/hub/ to Sally in a fixed, enforced order:
#   1. copy the new code
#   2. install/update dependencies (npm install)
#   3. restart the pm2 process
#   4. verify it actually came back up healthy
#
# WHY THIS SCRIPT EXISTS (2026-08-24):
# On 2026-08-24, folding Content Review and Content Engine into the Hub
# added a new dependency (the `diff` library) to package.json, but the
# code was restarted on Sally before `npm install` had run there. Because
# server.js requires() every tool's router unconditionally at startup
# (before the app opens for business — see the "Process-level safety net"
# comment above, which covers crashes AFTER startup, not a missing
# dependency AT startup), one tool's missing dependency crashed the
# ENTIRE Hub — every tool, not just the new one. pm2 tried to restart it
# 16 times in about 3 seconds before giving up ("too many unstable
# restarts"). It was caught and fixed by chance ~20 minutes before that
# day's domain cutover, so no real damage was done, but the underlying
# problem — deploy steps that could be run by hand, in any order, or
# skipped — was still there. This script removes that possibility: run
# this, and the order can't be gotten wrong.
#
# Usage:
#   bash deploy-to-sally.sh
#
# Modeled on projects/calendar-assistant/deploy-to-sally.sh (same set -e /
# step-by-step echo pattern), adapted for a multi-directory app deployed
# with rsync instead of a single-file scp.

set -e  # stop on any error — if any step fails, later steps do not run

SALLY="sally"
REMOTE_DIR="/var/www/hub"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Copying Hub code to Sally..."
# --delete removes files on Sally that no longer exist locally (e.g. a
# router.js that got renamed), but never touches anything matched by
# --exclude below — .env and node_modules on Sally are left alone here;
# node_modules is rebuilt by the npm install step that follows, and .env
# is managed separately (see the project's .env.example).
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
# This step runs AFTER the code copy and BEFORE the restart below, every
# time, with no way to skip it — that ordering is the actual fix.
ssh "$SALLY" "cd $REMOTE_DIR && npm install --omit=dev"

echo ""
echo "==> Restarting the Hub via pm2..."
ssh "$SALLY" "pm2 restart hub --update-env"

echo ""
echo "==> Waiting for the process to settle..."
sleep 3

echo ""
echo "==> Verifying Hub is online and healthy..."
PM2_STATUS=$(ssh "$SALLY" "pm2 jlist" | node -e "
  let data = '';
  process.stdin.on('data', d => data += d);
  process.stdin.on('end', () => {
    const procs = JSON.parse(data);
    const hub = procs.find(p => p.name === 'hub');
    if (!hub) { console.log('NOT_FOUND'); process.exit(1); }
    console.log(hub.pm2_env.status + ' restarts=' + hub.pm2_env.restart_time);
  });
" 2>/dev/null || echo "UNKNOWN")
echo "    pm2 status: $PM2_STATUS"


# server.js redirects any request it doesn't consider HTTPS to https://
# (301) when NODE_ENV=production — a backstop in case nginx is ever
# misconfigured, so a login POST is never silently accepted over plain
# HTTP (see the "Backstop only" comment in server.js). It trusts that
# signal via the X-Forwarded-Proto header, but ONLY when the request
# actually arrives from 127.0.0.1 ('trust proxy': 'loopback') — which is
# exactly nginx's real traffic pattern, and exactly what this curl is
# run as (localhost, from Sally itself). Without this header a plain
# curl gets redirected (301) instead of hitting /healthz directly, which
# would make this check falsely report the deploy as broken.
HEALTH=$(ssh "$SALLY" "curl -s -o /dev/null -w '%{http_code}' -H 'X-Forwarded-Proto: https' http://localhost:3500/healthz" || echo "000")
if [ "$HEALTH" != "200" ]; then
  echo ""
  echo "  !!! Health check failed (HTTP $HEALTH) — Hub may not have restarted cleanly."
  echo "  !!! Check logs: ssh $SALLY \"pm2 logs hub --lines 50 --nostream\""
  exit 1
fi
echo "    /healthz -> HTTP $HEALTH"

echo ""
echo "==================================================="
echo "  Deployment complete."
echo "  Hub is running at $REMOTE_DIR, pm2 process 'hub'."
echo "  Logs: ssh $SALLY \"pm2 logs hub --lines 100 --nostream\""
echo "==================================================="
