#!/bin/bash
# deploy-feature-to-sally.sh
#
# Deploys ONLY the path(s) you name — not the whole projects/hub/ folder.
#
# WHY THIS SCRIPT EXISTS (2026-09-12):
# deploy-to-sally.sh syncs the entire hub/ directory. Multiple Claude
# sessions work in that same shared folder on different features at once,
# so a deploy from one session ships every OTHER session's uncommitted,
# possibly-unfinished files too — whether or not they were ready to go
# live. That happened twice today: most recently, a deploy of the Call
# Stats/Scoreboard work incidentally shipped an unrelated, in-progress
# Fair Housing screening feature (archive-search) to production as a side
# effect, unnoticed until file timestamps and pm2 restart logs were
# checked. Nothing broke that time, but it's a real, recurring risk. This
# script lets you ship just the path(s) a feature actually touches, so
# work nobody asked to deploy stays off the server.
#
# Usage:
#   bash deploy-feature-to-sally.sh <path> [path2 ...] [--yes]
#
# Each <path> is relative to projects/hub/, e.g.:
#   bash deploy-feature-to-sally.sh archive-search
#   bash deploy-feature-to-sally.sh archive-search email-intake/lib/privilege-keywords.js
#
# What this script does NOT do (on purpose):
#   - It never touches package.json, package-lock.json, or runs npm
#     install. Those are shared, whole-app files — pulling them in here
#     would reintroduce the exact "one feature's deploy affects everything
#     else" risk this script exists to avoid. If your feature needs a new
#     npm package, see the WARNING step below — it tells you, it does not
#     silently install or silently ignore it.
#   - It never syncs anything outside the path(s) you name. Before anything
#     else runs, every path argument is validated (rejecting ".", "..", a
#     leading "/", or any path with a ".." segment) and then resolved with
#     realpath and confirmed to land strictly inside this script's own
#     directory (projects/hub/) — so even a sneaky case like a symlink that
#     points outside the folder gets caught before any rsync or ssh call.
#   - It does not check whether your local git history is clean for these
#     paths. It only compares local files on disk to what's on Sally right
#     now — uncommitted or committed, it doesn't know or care. That's a
#     separate safeguard this script does not attempt.
#
# Modeled on deploy-to-sally.sh (same set -e / step-by-step echo pattern,
# same excludes, same pm2 + /healthz verification at the end).

set -e  # stop on any error — if any step fails, later steps do not run

SALLY="sally"
REMOTE_DIR="/var/www/hub"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---------------------------------------------------------------------------
# Step 0: parse arguments — collect named paths, look for --yes
# ---------------------------------------------------------------------------
AUTO_YES=false
PATHS=()
for arg in "$@"; do
  if [ "$arg" == "--yes" ]; then
    AUTO_YES=true
  else
    PATHS+=("$arg")
  fi
done

if [ ${#PATHS[@]} -eq 0 ]; then
  echo "Usage: bash deploy-feature-to-sally.sh <path> [path2 ...] [--yes]"
  echo ""
  echo "  <path> is relative to projects/hub/, e.g.:"
  echo "    bash deploy-feature-to-sally.sh archive-search"
  echo "    bash deploy-feature-to-sally.sh archive-search email-intake/lib/privilege-keywords.js"
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 1: reject any path argument that could escape projects/hub/ — BEFORE
# any filesystem check, network call, or ssh call happens. This is the fix
# for the bug Judge caught: "." would silently deploy the whole hub/ folder,
# and ".." would compute source = the entire projects/ folder and
# destination = /var/www/ on Sally (the parent of the real app root), then
# run rsync --delete against it.
#
# Rejected outright: empty, exactly ".", exactly "..", any path containing
# a ".." segment, an absolute path (starts with "/"), or "package.json" /
# "package-lock.json" named directly (checked below, and again after
# realpath resolution in Step 2 — this script's header promises it never
# touches those files).
# ---------------------------------------------------------------------------
echo "==> Validating path argument(s)..."
for p in "${PATHS[@]}"; do
  if [ -z "$p" ]; then
    echo ""
    echo "  !!! Empty path argument is not allowed. Nothing was deployed."
    exit 1
  fi
  if [ "$p" == "." ] || [ "$p" == ".." ]; then
    echo ""
    echo "  !!! '$p' is not allowed as a path argument."
    echo "  !!! This script deploys specific path(s) inside projects/hub/ —"
    echo "  !!! '.' would deploy the whole hub/ folder, and '..' would reach"
    echo "  !!! outside it entirely. Name the specific file(s) or folder(s)"
    echo "  !!! your feature touches instead."
    echo "  !!! Nothing was deployed."
    exit 1
  fi
  case "/$p/" in
    */../*)
      echo ""
      echo "  !!! '$p' contains a '..' segment, which is not allowed."
      echo "  !!! Path arguments must stay inside projects/hub/. Nothing was deployed."
      exit 1
      ;;
  esac
  case "$p" in
    /*)
      echo ""
      echo "  !!! '$p' is an absolute path, which is not allowed."
      echo "  !!! Path arguments must be relative to projects/hub/. Nothing was deployed."
      exit 1
      ;;
  esac
  case "$p" in
    package.json|package-lock.json)
      echo ""
      echo "  !!! '$p' is not allowed as a path argument."
      echo "  !!! This script's whole point is that it never touches package.json"
      echo "  !!! or package-lock.json — those are shared, whole-app files (see the"
      echo "  !!! header). If your feature needs a new npm package, use the real"
      echo "  !!! deploy (deploy-to-sally.sh), which runs npm install. Nothing was"
      echo "  !!! deployed."
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Step 2: validate every named path exists locally, then resolve it with
# realpath and confirm it's strictly inside LOCAL_DIR (projects/hub/) — not
# equal to it, not outside it. This is a belt-and-suspenders check on top of
# Step 1's string check: it catches sneakier cases a plain ".." scan would
# miss, like a path that contains a symlink pointing outside the folder.
# A typo (or an escape attempt) here should stop the whole thing, not
# deploy a partial list.
# ---------------------------------------------------------------------------
echo "==> Checking that every path you named exists locally and stays inside projects/hub/..."
RESOLVED_LOCAL_DIR="$(realpath "$LOCAL_DIR")"
for p in "${PATHS[@]}"; do
  if [ ! -e "$LOCAL_DIR/$p" ]; then
    echo ""
    echo "  !!! '$p' does not exist under $LOCAL_DIR"
    echo "  !!! Nothing was deployed. Check the spelling and try again."
    exit 1
  fi
  RESOLVED_PATH="$(realpath "$LOCAL_DIR/$p")"
  case "$RESOLVED_PATH" in
    "$RESOLVED_LOCAL_DIR/package.json"|"$RESOLVED_LOCAL_DIR/package-lock.json")
      echo ""
      echo "  !!! '$p' resolves to '$RESOLVED_PATH'."
      echo "  !!! This script's whole point is that it never touches package.json"
      echo "  !!! or package-lock.json — those are shared, whole-app files (see the"
      echo "  !!! header), and this catches an indirect path (like './package.json')"
      echo "  !!! or a symlink pointing at the real file, not just the literal name."
      echo "  !!! If your feature needs a new npm package, use the real deploy"
      echo "  !!! (deploy-to-sally.sh), which runs npm install. Nothing was deployed."
      exit 1
      ;;
  esac
  case "$RESOLVED_PATH" in
    "$RESOLVED_LOCAL_DIR"/*)
      ;;
    *)
      echo ""
      echo "  !!! '$p' resolves to '$RESOLVED_PATH', which is outside"
      echo "  !!! $RESOLVED_LOCAL_DIR — likely a symlink pointing outside the"
      echo "  !!! hub folder. Nothing was deployed."
      exit 1
      ;;
  esac
  echo "    OK: $p"
done

# ---------------------------------------------------------------------------
# Step 3: warn about npm packages this feature needs that Sally doesn't
# have yet. This script deliberately does NOT run npm install (see header)
# — it only checks and warns, so a missing dependency is a known risk
# before you deploy, not a silent crash after.
#
# It greps for require('pkg') / require("pkg") inside the path(s) you
# named, keeps only non-relative, non-builtin package names, then compares
# that list to the "dependencies" keys in the package.json THAT IS
# CURRENTLY LIVE ON SALLY — not the local one, since local package.json
# may already list unrelated new dependencies from other in-progress work.
# ---------------------------------------------------------------------------
echo ""
echo "==> Checking for npm packages this feature needs but Sally may not have..."

MISSING=""
print_missing_pkg_warning() {
  echo ""
  echo "  !!! WARNING: these packages are used by the code you're deploying"
  echo "  !!! but are NOT in Sally's currently-live package.json:"
  echo "  !!!  $(echo $MISSING | xargs)"
  echo "  !!!"
  echo "  !!! This script does not install packages. If you proceed, the"
  echo "  !!! feature may crash on Sally with a 'Cannot find module' error"
  echo "  !!! the moment it's required. Either add the package to the real"
  echo "  !!! deploy (deploy-to-sally.sh, which runs npm install), or confirm"
  echo "  !!! it's already there some other way, before continuing."
}

NODE_BUILTINS="assert,async_hooks,buffer,child_process,cluster,console,constants,crypto,dgram,diagnostics_channel,dns,domain,events,fs,http,http2,https,inspector,module,net,os,path,perf_hooks,process,punycode,querystring,readline,repl,stream,string_decoder,sys,timers,tls,trace_events,tty,url,util,v8,vm,wasi,worker_threads,zlib"

REQUIRED_PKGS=""
for p in "${PATHS[@]}"; do
  TARGET="$LOCAL_DIR/$p"
  if [ -d "$TARGET" ]; then
    FOUND=$(grep -rhoE "require\(['\"][^'\"]+['\"]\)" "$TARGET" --include="*.js" 2>/dev/null || true)
  else
    FOUND=$(grep -hoE "require\(['\"][^'\"]+['\"]\)" "$TARGET" 2>/dev/null || true)
  fi
  REQUIRED_PKGS="$REQUIRED_PKGS
$FOUND"
done

# Pull the module name out of each require('...') match, drop relative/
# absolute paths (./ ../ /), collapse scoped packages (@scope/pkg/sub ->
# @scope/pkg) and subpath imports (pkg/sub -> pkg), then dedupe.
PKG_NAMES=$(echo "$REQUIRED_PKGS" | grep -oE "['\"][^'\"]+['\"]" | tr -d "'\"" | grep -vE "^\." | grep -vE "^/" | sed -E 's#^(@[^/]+/[^/]+).*#\1#; s#^([^@/][^/]*).*#\1#' | sort -u)

# Drop Node builtins (including the node: prefix form) from that list.
MISSING_CHECK_LIST=""
for pkg in $PKG_NAMES; do
  bare="${pkg#node:}"
  if echo ",$NODE_BUILTINS," | grep -q ",$bare,"; then
    continue
  fi
  MISSING_CHECK_LIST="$MISSING_CHECK_LIST $pkg"
done

if [ -z "$(echo $MISSING_CHECK_LIST | tr -d ' ')" ]; then
  echo "    No third-party packages required() by these path(s) — nothing to check."
else
  echo "    Packages required() by these path(s): $(echo $MISSING_CHECK_LIST | xargs)"
  echo "    Checking Sally's LIVE package.json (not your local one)..."
  LIVE_DEPS=$(ssh -n "$SALLY" "cat $REMOTE_DIR/package.json" 2>/dev/null | node -e "
    let data = '';
    process.stdin.on('data', d => data += d);
    process.stdin.on('end', () => {
      try {
        const pkg = JSON.parse(data);
        console.log(Object.keys(pkg.dependencies || {}).join('\n'));
      } catch (e) { process.exit(1); }
    });
  " || echo "__COULD_NOT_READ__")

  if [ "$LIVE_DEPS" == "__COULD_NOT_READ__" ]; then
    echo ""
    echo "  !!! Could not read Sally's live package.json to check dependencies."
    echo "  !!! Proceeding, but you're deploying without this safety check."
  else
    MISSING=""
    for pkg in $MISSING_CHECK_LIST; do
      if ! echo "$LIVE_DEPS" | grep -qx "$pkg"; then
        MISSING="$MISSING $pkg"
      fi
    done
    if [ -n "$(echo $MISSING | tr -d ' ')" ]; then
      print_missing_pkg_warning
    else
      echo "    All required packages are already in Sally's live package.json."
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Step 4: dry run — show exactly what would change before touching Sally.
# --checksum compares file content, not just timestamps, since mtime-based
# dry runs can misleadingly report "no changes" when the content did change.
# ---------------------------------------------------------------------------
echo ""
echo "==> Dry run — this is what would change on Sally (nothing has happened yet):"
echo ""

RSYNC_EXCLUDES=(
  --exclude 'node_modules'
  --exclude '.env'
  --exclude '.env.*'
  --exclude '.git'
  --exclude '.DS_Store'
  --exclude '*.log'
  --exclude 'cron-*.sh'
)

# RSYNC_SOURCES and RSYNC_DESTS are computed once here and read by both the
# dry-run loop below and the real-apply loop in Step 6, so the source/dest
# logic for a given path argument can't drift between preview and reality.
RSYNC_SOURCES=()
RSYNC_DESTS=()
for p in "${PATHS[@]}"; do
  if [ -d "$LOCAL_DIR/$p" ]; then
    # Trailing slash on a directory source means "copy its contents into
    # the matching directory on the other end," not "create a directory
    # inside it" — matches how the full-tree script syncs LOCAL_DIR itself.
    RSYNC_SOURCES+=("$LOCAL_DIR/$p/")
    RSYNC_DESTS+=("$SALLY:$REMOTE_DIR/$p/")
  else
    RSYNC_SOURCES+=("$LOCAL_DIR/$p")
    RSYNC_DESTS+=("$SALLY:$REMOTE_DIR/$p")
  fi
done

for i in "${!PATHS[@]}"; do
  p="${PATHS[$i]}"
  src="${RSYNC_SOURCES[$i]}"
  dest="${RSYNC_DESTS[$i]}"
  echo "  -- $p --"
  rsync -avzn --checksum --delete "${RSYNC_EXCLUDES[@]}" "$src" "$dest"
  echo ""
done

# ---------------------------------------------------------------------------
# Step 5: require explicit confirmation before applying anything for real.
# ---------------------------------------------------------------------------
if [ "$AUTO_YES" != "true" ]; then
  echo "==================================================="
  echo "  The listing above is a PREVIEW — nothing has been changed on Sally."
  echo "  Only the path(s) you named will be touched: ${PATHS[*]}"
  echo "==================================================="
  if [ -n "$(echo $MISSING | tr -d ' ')" ]; then
    echo ""
    echo "  Reminder — the missing-package warning from earlier still applies:"
    print_missing_pkg_warning
    echo ""
  fi
  read -r -p "Proceed with this deploy? [y/N] " CONFIRM
  case "$CONFIRM" in
    y|Y|yes|YES) ;;
    *)
      echo "Aborted. Nothing was deployed."
      exit 1
      ;;
  esac
fi

# ---------------------------------------------------------------------------
# Step 6: apply for real — same sources/dests/excludes as the dry run above,
# minus -n. No npm install here on purpose (see header) — this script only
# ever touches the path(s) named on the command line.
# ---------------------------------------------------------------------------
echo ""
echo "==> Copying the named path(s) to Sally..."
for i in "${!PATHS[@]}"; do
  p="${PATHS[$i]}"
  src="${RSYNC_SOURCES[$i]}"
  dest="${RSYNC_DESTS[$i]}"
  echo "  -- $p --"
  rsync -az --checksum --delete "${RSYNC_EXCLUDES[@]}" "$src" "$dest"
done

echo ""
echo "==> Restarting the Hub via pm2..."
# Node only picks up file changes on restart, no matter how small the
# change was — so this happens even for a single-file deploy.
ssh -n "$SALLY" "pm2 restart hub --update-env"

echo ""
echo "==> Waiting for the process to settle..."
sleep 3

echo ""
echo "==> Verifying Hub is online and healthy..."
PM2_STATUS=$(ssh -n "$SALLY" "pm2 jlist" | node -e "
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

# Same reasoning as deploy-to-sally.sh: server.js redirects non-HTTPS
# requests to https:// (301) in production, trusting X-Forwarded-Proto
# only from 127.0.0.1 — exactly what this curl, run from Sally itself, is.
# Without the header this would 301 instead of hitting /healthz, making a
# healthy deploy look falsely broken.
HEALTH=$(ssh -n "$SALLY" "curl -s -o /dev/null -w '%{http_code}' -H 'X-Forwarded-Proto: https' http://localhost:3500/healthz" || echo "000")
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
echo "  Deployed path(s): ${PATHS[*]}"
echo "  Hub is running at $REMOTE_DIR, pm2 process 'hub'."
echo "  Logs: ssh $SALLY \"pm2 logs hub --lines 100 --nostream\""
echo "==================================================="
