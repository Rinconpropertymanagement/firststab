# Test harness for the Hub deploy scripts. It is SOURCED (not run) by run-all.sh and by every suite.
# Everything happens in a throw-away scratch folder ($WORK); the real server ("sally") is never written to.
#
# THE BIG SAFETY RULE: the stand-in rsync / ssh / git programs in ./shims must come FIRST in PATH.
# Without them, a deploy script run by these tests could reach the real server. So this file puts the
# shims first and then REFUSES TO CONTINUE (exit 9, nothing runs) unless `command -v rsync`,
# `command -v ssh` and `command -v git` all resolve to files inside the shims folder.
#
# Where things live (all derived, nothing is hard-coded):
#   TEST_DIR  this folder (tools/deploy-tests)             SHIMS     TEST_DIR/shims
#   SRC_ROOT  the repo this folder sits in (git rev-parse)  SRC_HUB   SRC_ROOT/projects/hub  (the scripts under test)
#   WORK      scratch folder: $DEPLOY_TEST_WORK if set, otherwise a new mktemp folder in $TMPDIR
#   REPO      WORK/repo         a fresh clone of SRC_ROOT's saved history, rebuilt by reset_env before every scenario
#   FAKE      WORK/fake-server  stands in for Sally's /var/www/hub
#   LOGS      WORK/logs/<suite> output and shim log of every scenario

if [ -z "${BASH_VERSION:-}" ]; then echo "ABORTING: harness.sh must be sourced from bash" >&2; return 9 2>/dev/null || exit 9; fi

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHIMS="$TEST_DIR/shims"

# ---- THE HARD GUARD: shims first in PATH, and proven, before anything else happens ----
PATH="$SHIMS:$PATH"; export PATH; hash -r
for _t in rsync ssh git; do
  _got="$(command -v "$_t" 2>/dev/null)"
  if [ "$_got" != "$SHIMS/$_t" ] || [ ! -x "$SHIMS/$_t" ]; then
    echo "ABORTING: '$_t' does not resolve into the shims folder ($SHIMS); found: ${_got:-nothing}." >&2
    echo "          Refusing to run anything: a deploy script could reach the real server." >&2
    exit 9
  fi
done
unset _t _got

SRC_ROOT="$(git -C "$TEST_DIR" rev-parse --show-toplevel 2>/dev/null)" || { echo "ABORTING: $TEST_DIR is not inside a git repository" >&2; exit 9; }
SRC_HUB="$SRC_ROOT/projects/hub"
for _f in deploy-to-sally.sh deploy-feature-to-sally.sh deploy-guard-lib.sh; do
  [ -f "$SRC_HUB/$_f" ] || { echo "ABORTING: $SRC_HUB/$_f not found (these tests need the Hub deploy scripts)" >&2; exit 9; }
done
unset _f

if [ -n "${DEPLOY_TEST_WORK:-}" ]; then
  mkdir -p "$DEPLOY_TEST_WORK" || exit 9
  WORK="$(cd "$DEPLOY_TEST_WORK" && pwd)"; WORK_IS_MINE=no
else
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/deploy-tests.XXXXXX")" || { echo "ABORTING: could not make a scratch folder" >&2; exit 9; }
  WORK="$(cd "$WORK" && pwd)"; WORK_IS_MINE=yes
fi
case "$WORK" in
  ""|/|"$HOME"|"$SRC_ROOT"|"$SRC_ROOT"/*) echo "ABORTING: scratch folder '$WORK' is not allowed (must be a separate folder, outside the repo)" >&2; exit 9 ;;
esac
export DEPLOY_TEST_WORK="$WORK"     # also read by shims/rsync (the scratch folder is a place it may write to)
if [ "$WORK_IS_MINE" = yes ]; then trap 'echo "Scratch folder (logs, fake server) kept at: $WORK"' EXIT; fi

T="$WORK"                                    # short name the suites use for the scratch folder
SUITE="$(basename "${BASH_SOURCE[1]:-suite}" .sh)"
REPO="$WORK/repo"
FAKE="$WORK/fake-server"
LOGS="$WORK/logs/$SUITE"
HUB="$REPO/projects/hub"
mkdir -p "$LOGS"
export SHIM_LOG="$WORK/shim-default.log"     # keeps stray shim logging out of the repo; every scenario sets its own

reset_env() {   # fresh clone with the CURRENT deploy scripts committed + a fake server identical to it
  rm -rf "$REPO" "$FAKE"
  git clone -q --no-hardlinks "$SRC_ROOT" "$REPO" 2>/dev/null
  [ -d "$REPO/.git" ] || { echo "HARNESS BUG: could not clone $SRC_ROOT into $REPO"; exit 9; }
  # the branch the clone starts on is the "main line" the scenarios return to after trying another branch
  MAIN_BRANCH="$(git -C "$REPO" symbolic-ref -q --short HEAD)" || { MAIN_BRANCH=deploy-test-base; git -C "$REPO" checkout -q -b "$MAIN_BRANCH"; }
  cp "$SRC_HUB/deploy-to-sally.sh" "$SRC_HUB/deploy-feature-to-sally.sh" "$SRC_HUB/deploy-guard-lib.sh" "$HUB/"
  git -C "$REPO" -c user.name=test -c user.email=t@t add -- projects/hub/deploy-to-sally.sh projects/hub/deploy-feature-to-sally.sh projects/hub/deploy-guard-lib.sh
  # (when the saved history already holds exactly these scripts there is nothing to commit, and that is fine)
  git -C "$REPO" diff --cached --quiet || git -C "$REPO" -c user.name=test -c user.email=t@t commit -q -m "test: new deploy scripts"
  if [ -n "$(git -C "$REPO" status --porcelain)" ]; then echo "HARNESS BUG: clone not clean after reset"; git -C "$REPO" status --short | head; fi
  mkdir -p "$FAKE"
  rsync -a --exclude node_modules --exclude .git --exclude .env "$HUB/" "$FAKE/"
}
gc() { git -C "$REPO" -c user.name=test -c user.email=t@t "$@"; }
commit_all() { gc add -A projects/hub; gc commit -q -m "${1:-test commit}"; }

# run_deploy LOGNAME script args...   (stdin is whatever the caller pipes in)
run_deploy() {
  local name="$1" script="$2"; shift 2
  export SHIM_LOG="$LOGS/$name.shim.log"; : > "$SHIM_LOG"
  ( cd "$REPO" && PATH="$SHIMS:$PATH" FAKE_SERVER_DIR="$FAKE" bash "projects/hub/$script" "$@" ) > "$LOGS/$name.out" 2>&1
  local rc=$?
  echo "[$name] exit=$rc"
  return 0
}
# same, but inside a real pseudo-terminal; ANSWERS=("prompt text=>answer" ...) are typed when each prompt appears
run_deploy_tty() {
  local name="$1" script="$2"; shift 2
  export SHIM_LOG="$LOGS/$name.shim.log"; : > "$SHIM_LOG"
  ( cd "$REPO" && PATH="$SHIMS:$PATH" FAKE_SERVER_DIR="$FAKE" python3 "$TEST_DIR/ptyrun.py" "${ANSWERS[@]}" -- bash "projects/hub/$script" "$@" ) > "$LOGS/$name.out" 2>&1
  local rc=$?
  echo "[$name] exit=$rc (real terminal)"
  return 0
}
show() { sed -e 's/\r$//' "$LOGS/$1.out"; }
blocked() { grep -c BLOCKED "$LOGS/$1.shim.log" 2>/dev/null; }
