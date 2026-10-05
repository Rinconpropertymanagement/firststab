# Read-only preview of the FULL deploy against REAL Sally (write-blocking shims first in PATH); answers n.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/harness.sh"
run_real() { local n="$1" sc="$2"; shift 2; export SHIM_LOG="$LOGS/$n.shim.log"; : > "$SHIM_LOG"
  ( cd "$REPO" && PATH="$SHIMS:$PATH" bash "projects/hub/$sc" "$@" ) > "$LOGS/$n.out" 2>&1; echo "[$n] exit=$?"; }
for t in rsync ssh git; do got="$(PATH="$SHIMS:$PATH" command -v $t)"; [ "$got" = "$SHIMS/$t" ] || { echo "SHIM NOT IN EFFECT for $t: $got"; exit 9; }; done
echo "shims verified first in PATH for rsync, ssh, git"
reset_env
echo n | run_real RS6 deploy-to-sally.sh
