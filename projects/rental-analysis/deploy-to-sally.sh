#!/bin/bash
# deploy-to-sally.sh
#
# Deploys projects/rental-analysis/ to Sally (first deploy: 2026-09-19,
# Scotty), so the team can reach it at a real URL instead of it only ever
# running as `node server.js` on Peter's own laptop.
#
# WHAT THIS DOES, IN ORDER:
#   1. copy the code (rsync, same excludes as every other deploy-to-sally.sh
#      in this repo — node_modules / .env / .git / .DS_Store / *.log)
#   2. bootstrap .env on Sally ONLY if it doesn't already exist there — a
#      normal deploy never touches it after that, same reasoning as
#      hub/deploy-to-sally.sh and appfolio-sync/deploy-to-sally.sh: a stale
#      local .env should never silently overwrite a secret that was rotated
#      directly on the server
#   3. npm install (production deps only)
#   4. start or restart the pm2 process, then `pm2 save` so it survives a
#      reboot (pm2-root systemd service is already enabled on Sally)
#   5. verify it actually came back up healthy by hitting a real endpoint
#      that touches Supabase (GET /api/rental-analysis/users), not just a
#      static 200 — this app has no /healthz (only projects/hub/ does)
#
# Modeled on projects/hub/deploy-to-sally.sh (rsync + npm install + pm2 +
# health verify) and projects/calendar-assistant/deploy-to-sally.sh (the
# .env-bootstrap step, adapted to not clobber a real deployed .env on every
# run).
#
# Usage:
#   bash deploy-to-sally.sh
#
# nginx (not part of this script — nginx config lives on Sally only, it is
# not checked into this repo, same as every other project here):
#   /rental-analysis/       -> static alias to /var/www/rental-analysis/dashboard/
#   /api/rental-analysis/   -> proxied to http://127.0.0.1:3457/api/rental-analysis/
#   both added to /etc/nginx/sites-available/calendar-assistant (the
#   srv1784739.hstgr.cloud server block), same pattern already used there
#   for /insurance/ and /api/insurance/.

set -e  # stop on any error — if any step fails, later steps do not run

SALLY="sally"
REMOTE_DIR="/var/www/rental-analysis"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Creating directory on Sally (if needed)..."
ssh "$SALLY" "mkdir -p $REMOTE_DIR"

echo ""
echo "==> Copying rental-analysis code to Sally..."
rsync -az --delete \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '.git' \
  --exclude '.DS_Store' \
  --exclude '*.log' \
  "$LOCAL_DIR/" "$SALLY:$REMOTE_DIR/"

echo ""
echo "==> Checking .env on Sally..."
REMOTE_ENV_EXISTS=$(ssh "$SALLY" "[ -f $REMOTE_DIR/.env ] && echo yes || echo no")
if [ "$REMOTE_ENV_EXISTS" == "no" ]; then
  echo "    No .env on Sally yet — bootstrapping it from this machine's $LOCAL_DIR/.env"
  echo "    (this only ever happens once; every later deploy leaves Sally's .env alone)."
  scp "$LOCAL_DIR/.env" "$SALLY:$REMOTE_DIR/.env"
  ssh "$SALLY" "chmod 600 $REMOTE_DIR/.env"
else
  echo "    .env already exists on Sally — leaving it untouched, as every other"
  echo "    deploy script in this repo does. If a value changed, update it by hand:"
  echo "    ssh $SALLY \"nano $REMOTE_DIR/.env\" (then re-run this script to restart)."
fi

echo ""
echo "==> Installing/updating npm packages on Sally..."
ssh "$SALLY" "cd $REMOTE_DIR && npm install --omit=dev"

echo ""
echo "==> Starting/restarting rental-analysis via pm2..."
PM2_EXISTS=$(ssh "$SALLY" "pm2 jlist" | node -e "
  let data = '';
  process.stdin.on('data', d => data += d);
  process.stdin.on('end', () => {
    const procs = JSON.parse(data);
    console.log(procs.some(p => p.name === 'rental-analysis') ? 'yes' : 'no');
  });
" 2>/dev/null || echo "no")
if [ "$PM2_EXISTS" == "yes" ]; then
  ssh "$SALLY" "pm2 restart rental-analysis --update-env"
else
  ssh "$SALLY" "cd $REMOTE_DIR && pm2 start server.js --name rental-analysis"
fi
# Persist the process list so it comes back after a server reboot —
# pm2-root's systemd service (already enabled on Sally) replays this file.
ssh "$SALLY" "pm2 save"

echo ""
echo "==> Waiting for the process to settle..."
sleep 3

echo ""
echo "==> Verifying rental-analysis is online and healthy..."
PM2_STATUS=$(ssh "$SALLY" "pm2 jlist" | node -e "
  let data = '';
  process.stdin.on('data', d => data += d);
  process.stdin.on('end', () => {
    const procs = JSON.parse(data);
    const app = procs.find(p => p.name === 'rental-analysis');
    if (!app) { console.log('NOT_FOUND'); process.exit(1); }
    console.log(app.pm2_env.status + ' restarts=' + app.pm2_env.restart_time);
  });
" 2>/dev/null || echo "UNKNOWN")
echo "    pm2 status: $PM2_STATUS"

# This app has no /healthz (only projects/hub/ does), so hit a real,
# read-only endpoint that actually touches Supabase instead of just
# checking the process answers on its port at all.
HEALTH=$(ssh "$SALLY" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3457/api/rental-analysis/users" || echo "000")
if [ "$HEALTH" != "200" ]; then
  echo ""
  echo "  !!! Health check failed (HTTP $HEALTH) — rental-analysis may not have restarted cleanly."
  echo "  !!! Check logs: ssh $SALLY \"pm2 logs rental-analysis --lines 50 --nostream\""
  exit 1
fi
echo "    GET /api/rental-analysis/users -> HTTP $HEALTH"

echo ""
echo "==================================================="
echo "  Deployment complete."
echo "  rental-analysis is running at $REMOTE_DIR, pm2 process 'rental-analysis'."
echo "  Dashboard: https://srv1784739.hstgr.cloud/rental-analysis/"
echo "  Logs: ssh $SALLY \"pm2 logs rental-analysis --lines 100 --nostream\""
echo "==================================================="
