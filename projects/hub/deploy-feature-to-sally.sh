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
# SAFETY BEHAVIOUR (added 2026-10-03 — shared with deploy-to-sally.sh via
# deploy-guard-lib.sh, so the two scripts behave the same):
#
#   * It ONLY ADDS AND UPDATES files inside the path(s) you name. It never
#     deletes anything unless you deliberately add --delete-on-server. (Before
#     2026-10-03 it deleted every Sally-only file inside a named folder.)
#   * It shows a PREVIEW first (what would be added / overwritten), then asks
#     "Proceed? [y/N]". Files are compared by content (checksum), so a file
#     whose only difference is its timestamp is not counted as a change.
#   * It REFUSES TO OVERWRITE NEWER WORK. It stops, even with --yes, if:
#       - a file on Sally is not a version in the git history of the commit you
#         are deploying from ("Sally has changes git doesn't know about" - this
#         includes a version that was saved only on ANOTHER branch), or
#       - a file you are about to send is not committed to git, or
#       - the code you are sending needs an npm package that Sally's live
#         package.json does not list (that is the 2026-08-24 "one missing
#         package takes down every tool" crash).
#   * If anything cannot be checked (ssh, rsync or git fails) it cancels
#     BEFORE sending anything, and tells you why.
#   * Never copied or deleted: .env files (anything starting with .env),
#     node_modules, cron-*.sh, rollback files (*.bak*, *.backup*, and *.*.pre-* such as
#     server.js.bak-... and server.js.pre-rental-analysis-restore.bak), and
#     deploy-guard-lib.sh. If
#     you NAME one of these, the script says so and stops (instead of quietly
#     skipping it).
#   * If Sally already has exactly your files, it says "Nothing to send" and
#     does not restart the Hub.
#   * If a step fails, it says in plain English what was and was not done. What
#     to do next depends on WHICH step failed:
#       - the copy itself failed: running the same command again simply tries
#         the copy again;
#       - the copy worked but the Hub restart failed: running the same command
#         again will NOT retry the restart. Sally already has your files, so it
#         just says "Nothing to send". The failure message tells you exactly
#         what to ask Jarvis to run on Sally to finish the job.
#
# Usage (run it with bash, not zsh/sh):
#   bash deploy-feature-to-sally.sh <path> [path2 ...] [flags]
#
# Each <path> is relative to projects/hub/, e.g.:
#   bash deploy-feature-to-sally.sh archive-search
#   bash deploy-feature-to-sally.sh archive-search email-intake/lib/privilege-keywords.js
# A path may only contain letters, numbers, dot, dash, underscore and slash
# (anything else could be misread by Sally's command line). "./x", "x/" and
# "x//y" are tidied up to "x", "x" and "x/y".
#
# Flags (all optional; the plain command is the safe one):
#   --yes                              Skip ONLY the final y/N question.
#                                      Never gets past a safety stop.
#   --delete-on-server                 ALSO delete files that exist only on
#                                      Sally inside the named folder(s). Lists
#                                      each file, marks it "NOT IN GIT" or
#                                      "recorded in git (commit X)", and makes
#                                      you type the word DELETE. --yes does
#                                      not answer that; with no terminal it is
#                                      refused (even if nothing is listed to
#                                      delete). The copy only deletes if the
#                                      preview you approved listed something.
#   --allow-lose-unrecorded-files      With --delete-on-server: allow deleting
#                                      files git has never recorded (they
#                                      would be lost permanently).
#   --allow-unrecorded-server-changes  Allow overwriting a Sally file that
#                                      has changes git doesn't know about.
#   --allow-uncommitted                Allow sending files that are edited or
#                                      new but not committed to git.
#   --allow-missing-packages           Allow sending code that needs an npm
#                                      package Sally's package.json lacks.
# Exit codes: 0 done / nothing to do, 1 you said no or bad arguments,
#             2 a safety check stopped it, 3 a check could not be completed.
#
# What this script does NOT do (on purpose):
#   - It never touches package.json, package-lock.json, or runs npm
#     install. Those are shared, whole-app files — pulling them in here
#     would reintroduce the exact "one feature's deploy affects everything
#     else" risk this script exists to avoid. If your feature needs a new
#     npm package, the missing-package check below stops the deploy and tells
#     you; it does not silently install or silently ignore it.
#   - It never syncs anything outside the path(s) you name. Before anything
#     else runs, every path argument is validated (rejecting ".", "..", a
#     leading "/", or any path with a ".." segment) and then resolved with
#     realpath and confirmed to land strictly inside this script's own
#     directory (projects/hub/) — so even a sneaky case like a symlink that
#     points outside the folder gets caught before any rsync or ssh call.
#   - It does not decide whether a feature is READY — it only checks that
#     what it sends is saved in git (a committed file is not necessarily a
#     finished one) and that it won't overwrite unsaved work on Sally.
#
# Modeled on deploy-to-sally.sh (same set -e / step-by-step echo pattern,
# same excludes, same pm2 + /healthz verification at the end).

# This script is written for bash (the shebang line above). Running it with
# zsh or sh breaks in confusing ways, so refuse up front.
if [ -z "$BASH_VERSION" ]; then
  echo "This script must be run with bash:  bash deploy-feature-to-sally.sh <path> [flags]"
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

OPT_ALLOW_MISSING_PKGS=false

feature_flags_help() {
  guard_flags_help
  echo "    --allow-missing-packages           Allow sending code that needs an npm package Sally's package.json lacks."
}

# ---------------------------------------------------------------------------
# Step 0: parse arguments — collect named paths and the safety flags
# ---------------------------------------------------------------------------
PATHS=()
for arg in "$@"; do
  if [ "$arg" = "--allow-missing-packages" ]; then
    OPT_ALLOW_MISSING_PKGS=true
    continue
  fi
  if guard_parse_flag "$arg"; then
    continue
  fi
  case "$arg" in
    -*)
      echo "Unknown flag: $arg"
      echo ""
      feature_flags_help
      exit 1
      ;;
  esac
  PATHS+=("$arg")
done

if [ ${#PATHS[@]} -eq 0 ]; then
  echo "Usage: bash deploy-feature-to-sally.sh <path> [path2 ...] [flags]"
  echo ""
  echo "  <path> is relative to projects/hub/, e.g.:"
  echo "    bash deploy-feature-to-sally.sh archive-search"
  echo "    bash deploy-feature-to-sally.sh archive-search email-intake/lib/privilege-keywords.js"
  echo ""
  feature_flags_help
  exit 1
fi
guard_check_flags

# ---------------------------------------------------------------------------
# Step 1: reject any path argument that could escape projects/hub/ — BEFORE
# any filesystem check, network call, or ssh call happens. This is the fix
# for the bug Judge caught: "." would silently deploy the whole hub/ folder,
# and ".." would compute source = the entire projects/ folder and
# destination = /var/www/ on Sally (the parent of the real app root), then
# run rsync --delete against it.
#
# Rejected outright: empty, exactly ".", exactly "..", any path containing
# a ".." segment, an absolute path (starts with "/"), any character outside
# letters/numbers/. _ - / (rsync 2.6.9 hands the destination path to Sally's
# command line unquoted, so a name like "a;b" or 'a$(x)' could run commands on
# Sally), anything on the never-deployed list (node_modules, .env*, cron-*.sh,
# rollback copies ...), or "package.json" / "package-lock.json" named directly
# (checked below, and again after realpath resolution in Step 2 — this script's
# header promises it never touches those files).
#
# Then each path is tidied up: "./x" and "x/" become "x", "x//y" and "x/./y"
# become "x/y".
# ---------------------------------------------------------------------------
echo "==> Validating path argument(s)..."
CLEAN_PATHS=()
for p in "${PATHS[@]}"; do
  if [ -z "$p" ]; then
    echo ""
    echo "  !!! Empty path argument is not allowed. Nothing was deployed."
    exit 1
  fi
  case "$p" in
    *[!A-Za-z0-9._/-]*)
      echo ""
      echo "  !!! '$p' contains a character this script does not allow."
      echo "  !!! Path arguments may only use letters, numbers, dot, dash, underscore and slash,"
      echo "  !!! because Sally's command line could misread anything else. Nothing was deployed."
      exit 1
      ;;
  esac
  # tidy up the spelling: strip leading "./", collapse "//" and "/./", strip
  # trailing "/" and "/.". (Each pass makes the text shorter, so this ends.)
  SL="/"
  while :; do
    case "$p" in
      ./*)    p="${p#./}" ;;
      *//*)   p="${p//\/\//$SL}" ;;
      */./*)  p="${p//\/.\//$SL}" ;;
      */.)    p="${p%/.}" ;;
      */)     p="${p%/}" ;;
      *)      break ;;
    esac
  done
  if [ -z "$p" ] || [ "$p" == "." ] || [ "$p" == ".." ]; then
    echo ""
    echo "  !!! That path means the whole hub/ folder (or something above it), which is not allowed here."
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
  if EXCLUDED_BY="$(guard_path_is_excluded "$p")"; then
    echo ""
    echo "  !!! '$p' is on the never-deployed list (it matches '$EXCLUDED_BY')."
    echo "  !!! These scripts never send or delete secrets (.env*), node_modules, cron-*.sh,"
    echo "  !!! rollback copies (*.bak*, *.backup*, *.*.pre-* ...) or the deploy helper itself."
    echo "  !!! Capital letters do not matter: .ENV.local counts as .env.local."
    echo "  !!! Nothing was deployed."
    exit 1
  fi
  CLEAN_PATHS+=("$p")
done
PATHS=("${CLEAN_PATHS[@]}")

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

# Set up the shared safety checks (finds the git repo, makes a private temp
# folder, and confirms Sally can be reached). Done after the path checks above
# so a typo'd path is rejected before any network call.
guard_init

# ---------------------------------------------------------------------------
# Step 3: check for npm packages this feature needs that Sally doesn't have
# yet. This script deliberately does NOT run npm install (see header) — it
# only checks. A missing package is a STOP (like the other safety checks, --yes
# does not get past it); --allow-missing-packages overrides it. The stop itself
# is printed by guard_extra_stops (below), which the shared checks call.
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

NODE_BUILTINS="assert,async_hooks,buffer,child_process,cluster,console,constants,crypto,dgram,diagnostics_channel,dns,domain,events,fs,http,http2,https,inspector,module,net,os,path,perf_hooks,process,punycode,querystring,readline,repl,stream,string_decoder,sys,timers,tls,trace_events,tty,url,util,v8,vm,wasi,worker_threads,zlib"

# require('x'), require("x"), and the same with spaces: require ( 'x' ). Only these
# plain forms are read (not import ... from, import(), backticks or a variable).
REQUIRE_RE="require[[:space:]]*\([[:space:]]*['\"][^'\"]+['\"][[:space:]]*\)"

REQUIRED_PKGS=""
for p in "${PATHS[@]}"; do
  TARGET="$LOCAL_DIR/$p"
  if [ -d "$TARGET" ]; then
    FOUND=$(grep -rhoE "$REQUIRE_RE" "$TARGET" --include="*.js" --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null || true)
  else
    FOUND=$(grep -hoE "$REQUIRE_RE" "$TARGET" 2>/dev/null || true)
  fi
  REQUIRED_PKGS="$REQUIRED_PKGS
$FOUND"
done

# Pull the module name out of each require('...') match, drop relative/
# absolute paths (./ ../ /), collapse scoped packages (@scope/pkg/sub ->
# @scope/pkg) and subpath imports (pkg/sub -> pkg), then dedupe.
PKG_NAMES=$(printf '%s\n' "$REQUIRED_PKGS" | grep -oE "['\"][^'\"]+['\"]" | tr -d "'\"" | grep -vE "^\." | grep -vE "^/" | sed -E 's#^(@[^/]+/[^/]+).*#\1#; s#^([^@/][^/]*).*#\1#' | sort -u || true)

# Drop Node builtins (including the node: prefix form) from that list.
MISSING_CHECK_LIST=""
for pkg in $PKG_NAMES; do
  # anything written with the node: prefix (node:test, node:fs ...) is built into Node
  case "$pkg" in node:*) continue ;; esac
  if printf '%s\n' ",$NODE_BUILTINS," | grep -q ",$pkg,"; then
    continue
  fi
  MISSING_CHECK_LIST="$MISSING_CHECK_LIST $pkg"
done

if [ -z "${MISSING_CHECK_LIST// /}" ]; then
  echo "    No third-party packages required() by these path(s) — nothing to check."
else
  echo "    Packages required() by these path(s): $(echo $MISSING_CHECK_LIST | xargs)"
  echo "    Checking Sally's LIVE package.json (not your local one)..."
  LIVE_DEPS=$(guard_ssh "cat $REMOTE_DIR/package.json" 2>/dev/null | node -e "
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
    # Fail closed (2026-10-03): this used to say "proceeding anyway". If a
    # check can't be completed, nothing is sent.
    guard_fail_closed "could not read Sally's live package.json to check which npm packages it has"
  else
    for pkg in $MISSING_CHECK_LIST; do
      if ! printf '%s\n' "$LIVE_DEPS" | grep -qx "$pkg"; then
        MISSING="$MISSING $pkg"
      fi
    done
    if [ -n "${MISSING// /}" ]; then
      echo "    Missing from Sally's package.json:$MISSING   (this will STOP the deploy unless you add --allow-missing-packages)"
    else
      echo "    All required packages are already in Sally's live package.json."
    fi
  fi
fi

# Called by the shared checks (guard_decide) alongside the other stops.
# Returns 0 = fine, 1 = stop, 2 = overridden (warn and continue).
guard_extra_stops() {
  if [ -z "${MISSING// /}" ]; then return 0; fi
  echo ""
  if [ "$OPT_ALLOW_MISSING_PKGS" = true ]; then
    echo "  !!! WARNING (OVERRIDDEN): CODE YOU ARE SENDING NEEDS NPM PACKAGES SALLY DOESN'T HAVE"
  else
    echo "  !!! STOPPED - CODE YOU ARE SENDING NEEDS NPM PACKAGES SALLY DOESN'T HAVE"
  fi
  echo "  !!! These packages are used by the code you're deploying but are NOT in"
  echo "  !!! Sally's currently-live package.json:"
  echo "  !!!  $(echo $MISSING | xargs)"
  echo "  !!!"
  echo "  !!! This script does not install packages. If this went ahead, the feature (and,"
  echo "  !!! because the Hub loads every tool at startup, the WHOLE Hub) could crash with a"
  echo "  !!! 'Cannot find module' error when it restarts - exactly the 2026-08-24 crash."
  if [ "$OPT_ALLOW_MISSING_PKGS" = true ]; then
    echo "  !!! --allow-missing-packages was given: continuing anyway."
    return 2
  fi
  echo "  !!!"
  echo "  !!! Safest fix: use the full deploy (deploy-to-sally.sh), which runs npm install."
  echo "  !!! If you are sure the package is already installed on Sally: --allow-missing-packages"
  return 1
}

# ---------------------------------------------------------------------------
# Step 4: check, preview, ask. (Replaces the old dry run + prompt, 2026-10-03.)
# The shared checks (deploy-guard-lib.sh) compare each named path with Sally by
# content (checksum), list what would be added / overwritten, refuse to
# overwrite Sally changes git doesn't know about or to send uncommitted files,
# ask y/N, and then re-check that nothing moved. Sally-only files are left
# alone unless --delete-on-server was given. Nothing is sent before this ends.
# ---------------------------------------------------------------------------
UNIT_PATHS=("${PATHS[@]}")

guard_run_checks_and_confirm

# ---------------------------------------------------------------------------
# Step 5: apply for real — same sources/dests/excludes as the preview, minus
# the dry run. --delete is only included if the preview you approved listed at least
# one deletion and you typed DELETE (see guard_transfer in deploy-guard-lib.sh).
# No npm install here on purpose (see header) — this script only ever touches
# the path(s) named on the command line.
# ---------------------------------------------------------------------------
echo ""
echo "==> Copying the named path(s) to Sally..."
if [ "$GUARD_DELETE_CONFIRMED" = true ]; then
  echo "    (adding/updating files, AND deleting the Sally-only files you confirmed)"
else
  echo "    (adding/updating files only — nothing is deleted)"
fi
guard_transfer || guard_step_failed "copying the files to Sally" \
  "Some files may already have been updated on Sally. The Hub restart did NOT run, so the running Hub was not touched."

echo ""
echo "==> Restarting the Hub via pm2..."
# Node only picks up file changes on restart, no matter how small the
# change was — so this happens even for a single-file deploy. It only runs
# after the copy above finished without error.
echo "    About to run on Sally:  pm2 restart hub --update-env"
guard_ssh "pm2 restart hub --update-env" || guard_step_failed "restarting the Hub on Sally" \
  "The new files WERE copied, but the restart did not go through. The Hub may still be running the old code." \
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

# Same reasoning as deploy-to-sally.sh: server.js redirects non-HTTPS
# requests to https:// (301) in production, trusting X-Forwarded-Proto
# only from 127.0.0.1 — exactly what this curl, run from Sally itself, is.
# Without the header this would 301 instead of hitting /healthz, making a
# healthy deploy look falsely broken.
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
echo "  Deployed path(s): ${PATHS[*]}"
echo "  Hub is running at $REMOTE_DIR, pm2 process 'hub'."
echo "  Logs: ssh $SALLY \"pm2 logs hub --lines 100 --nostream\""
echo "==================================================="
