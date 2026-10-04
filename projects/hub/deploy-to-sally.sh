#!/bin/bash
# deploy-to-sally.sh
#
# Deploys projects/hub/ to Sally in a fixed, enforced order:
#   1. check what would change, show a preview, run the safety checks, ask
#   2. copy the new code
#   3. install/update dependencies (npm install)
#   4. restart the pm2 process
#   5. verify it actually came back up healthy
#
# SAFETY BEHAVIOUR (added 2026-10-03 — read this before using the script):
#
#   * It ONLY ADDS AND UPDATES files on Sally. It never deletes anything
#     unless you deliberately add --delete-on-server (see below).
#   * It shows a PREVIEW first (what would be added / overwritten), then asks
#     "Proceed? [y/N]". Files are compared by content, so a file whose only
#     difference is its timestamp is not counted as a change.
#   * It REFUSES TO OVERWRITE NEWER WORK. It stops, even with --yes, if:
#       - a file on Sally is not a version in the git history of the commit you
#         are deploying from ("Sally has changes git doesn't know about" - this
#         includes a version that was saved only on ANOTHER branch), or
#       - a file you are about to send is not committed to git.
#   * If anything cannot be checked (ssh, rsync or git fails) it cancels
#     BEFORE sending anything, and tells you why.
#   * npm install and the pm2 restart only run AFTER the copy has succeeded,
#     and the script prints what it is about to run.
#   * Never copied or deleted: .env files (anything starting with .env),
#     node_modules, cron-*.sh (those are edited by hand on Sally — so edits to
#     the cron-*.sh files tracked in git do NOT reach Sally through this
#     script; the preview adds a "Heads-up" if one of them differs from Sally's
#     copy), rollback files (*.bak*, *.backup*, and *.*.pre-* such as server.js.bak-...
#     and server.js.pre-rental-analysis-restore.bak), and deploy-guard-lib.sh.
#   * If Sally already has exactly your files, it says "Nothing to send" and
#     does NOT run npm install or restart the Hub. (It can't be used as a
#     "just restart the Hub" button; ask Jarvis for a restart if you need one.)
#   * If a step fails, it says in plain English what was and was not done. What
#     to do next depends on WHICH step failed:
#       - the copy itself failed: running the same command again simply tries
#         the copy again;
#       - the copy worked but npm install or the restart failed: running the same
#         command again will NOT retry them. Sally already has your files, so it
#         just says "Nothing to send". The failure message tells you exactly what
#         to ask Jarvis to run on Sally to finish the job.
#
# Usage:
#   bash deploy-to-sally.sh [flags]
#
# Flags (all optional; the plain command is the safe one):
#   --yes                              Skip ONLY the final y/N question.
#                                      Never gets past a safety stop.
#   --delete-on-server                 ALSO delete files that exist only on
#                                      Sally. Lists each file, marks it
#                                      "NOT IN GIT" or "recorded in git
#                                      (commit X)", and makes you type the
#                                      word DELETE. --yes does not answer
#                                      that; with no terminal it is refused
#                                      (even if nothing is listed to delete).
#                                      The copy only deletes if the preview
#                                      you approved listed something.
#   --allow-lose-unrecorded-files      With --delete-on-server: allow deleting
#                                      files git has never recorded (they
#                                      would be lost permanently).
#   --allow-unrecorded-server-changes  Allow overwriting a Sally file that
#                                      has changes git doesn't know about.
#   --allow-uncommitted                Allow sending files that are edited or
#                                      new but not committed to git.
# Run it with bash (not zsh/sh). Until this script and its helper
# (deploy-guard-lib.sh) are committed to git, the check above will stop a full
# deploy over those files; commit them first.
# Exit codes: 0 done / nothing to do, 1 you said no or bad arguments,
#             2 a safety check stopped it, 3 a check could not be completed.
#
# All of the checking logic lives in deploy-guard-lib.sh (next to this file),
# which deploy-feature-to-sally.sh shares, so the two scripts behave the same.
# That file stays on your computer — it is excluded from the copy to Sally.
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
# Modeled on projects/calendar-assistant/deploy-to-sally.sh (same set -e /
# step-by-step echo pattern), adapted for a multi-directory app deployed
# with rsync instead of a single-file scp.

# This script is written for bash (the shebang line above). Running it with
# zsh or sh breaks in confusing ways, so refuse up front. (zsh runs the lines in
# order, so this check happens before anything else.)
if [ -z "$BASH_VERSION" ]; then
  echo "This script must be run with bash:  bash deploy-to-sally.sh [flags]"
  echo "Nothing was deployed."
  exit 1
fi

set -e  # stop on any error — if any step fails, later steps do not run

SALLY="sally"
REMOTE_DIR="/var/www/hub"
# (CDPATH= : if the shell has CDPATH set, a plain "cd" prints the folder and this
# would end up as two lines.)
LOCAL_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

# Shared safety checks (preview, git checks, delete rules, excludes).
# shellcheck source=deploy-guard-lib.sh
# (Check first: when the file is missing, bash would stop with its own raw error
# before the plain-English message below could be shown.)
if [ ! -r "$LOCAL_DIR/deploy-guard-lib.sh" ]; then
  echo ""
  echo "  !!! Could not load the safety-check file $LOCAL_DIR/deploy-guard-lib.sh"
  echo "  !!! (it should sit right next to this script). Nothing was deployed."
  exit 3
fi
source "$LOCAL_DIR/deploy-guard-lib.sh" || { echo "  !!! Could not load $LOCAL_DIR/deploy-guard-lib.sh. Nothing was deployed."; exit 3; }

for arg in "$@"; do
  if guard_parse_flag "$arg"; then
    continue
  fi
  echo "Unknown argument: $arg"
  echo ""
  echo "Usage: bash deploy-to-sally.sh [flags]"
  echo ""
  guard_flags_help
  exit 1
done
guard_check_flags

guard_init
UNIT_PATHS=(.)

# The copy can no longer be done blind. This checks, previews, asks, and then
# re-checks that nothing moved before anything is sent.
#
# Exclusions (see DEPLOY_EXCLUDES in deploy-guard-lib.sh), kept from the old
# script for the same reasons:
#   .env / .env.*  managed separately on Sally (see .env.example)
#   node_modules   rebuilt by the npm install step below
#   cron-*.sh      2026-09-01 incident: these wrapper scripts (create-cases-
#                  from-sync, index-b2-photos, send-reminders, maintenance-
#                  history-ingest) were written directly onto Sally by hand,
#                  and the old unconditional --delete removed all four the
#                  first time this script ran after they existed — breaking
#                  every scheduled cron job that calls one, silently, until
#                  caught and all four were recreated by hand.
#   *.bak* *.backup* *.*.pre-*  rollback copies kept on Sally on purpose.
guard_run_checks_and_confirm

echo ""
echo "==> Copying Hub code to Sally..."
if [ "$GUARD_DELETE_CONFIRMED" = true ]; then
  echo "    (adding/updating files, AND deleting the Sally-only files you confirmed)"
else
  echo "    (adding/updating files only — nothing is deleted)"
fi
guard_transfer || guard_step_failed "copying the files to Sally" \
  "Some files may already have been updated on Sally. npm install and the Hub restart did NOT run, so the running Hub was not touched."

echo ""
echo "==> Installing/updating npm packages on Sally..."
# This step runs AFTER the code copy and BEFORE the restart below, every
# time, with no way to skip it — that ordering is the actual fix. It only
# ever runs after the copy above finished without error (set -e).
echo "    About to run on Sally:  cd $REMOTE_DIR && npm install --omit=dev"
guard_ssh "cd $REMOTE_DIR && npm install --omit=dev" || guard_step_failed "npm install on Sally" \
  "The new files WERE copied to Sally, but npm install did not finish and the Hub was NOT restarted." \
  "Nothing further was run. Running this same command again will NOT retry npm install: Sally already has" \
  "your files, so it would just say 'Nothing to send'. To finish the job, ask Jarvis to run these on Sally, in order:" \
  "    cd $REMOTE_DIR && npm install --omit=dev" \
  "    pm2 restart hub --update-env"

echo ""
echo "==> Restarting the Hub via pm2..."
echo "    About to run on Sally:  pm2 restart hub --update-env"
guard_ssh "pm2 restart hub --update-env" || guard_step_failed "restarting the Hub on Sally" \
  "The new files WERE copied and npm install finished, but the restart did not go through. The Hub may still be running the old code." \
  "Nothing further was run. Running this same command again will NOT retry the restart: Sally already has" \
  "your files, so it would just say 'Nothing to send'. To finish the job, ask Jarvis to run this on Sally:" \
  "    pm2 restart hub --update-env"

echo ""
echo "==> Waiting for the process to settle..."
sleep 3

echo ""
echo "==> Verifying Hub is online and healthy..."
PM2_STATUS=$(guard_ssh "pm2 jlist" | node -e "
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
HEALTH=$(guard_ssh "curl -s -o /dev/null -w '%{http_code}' -H 'X-Forwarded-Proto: https' http://localhost:3500/healthz" || echo "000")
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
