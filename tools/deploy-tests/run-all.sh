#!/bin/bash
# Runs all five deploy-script test suites one after another and prints a grand total.
#   bash tools/deploy-tests/run-all.sh
# Safe by design: the write-blocking shims go first in PATH and the run aborts (exit 9) if they are
# not in effect. Nothing here can change the real server. See README.md.
#
# Exit code: 0 only if every suite finished, nothing failed, and each suite ran exactly the expected
# number of checks. Anything else is non-zero (and the scratch folder, with all logs, is kept).
# If you deliberately add or remove checks in a suite, update the EXPECTED numbers below.

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$TEST_DIR/harness.sh" || exit 9      # puts the shims first, aborts if they are not in effect, makes $WORK
trap - EXIT                             # run-all decides below whether the scratch folder is kept

EXPECTED_regress=65; EXPECTED_bugs=110; EXPECTED_extras=14; EXPECTED_fixes=147; EXPECTED_judgefix=116

TOTAL_PASS=0; TOTAL_FAIL=0; PROBLEMS=0
SUMMARY=""
echo "Scratch folder: $WORK"
echo "Scripts under test: $SRC_HUB/deploy-*.sh"
echo "Shims (first in PATH): $SHIMS"
echo

for suite in regress bugs extras fixes judgefix; do
  echo "=================== $suite ==================="
  # the suites share one scratch repo, so they must run one at a time
  bash "$TEST_DIR/$suite.sh" </dev/null 2>&1 | tee "$WORK/$suite.out"
  rc=${PIPESTATUS[0]}
  line="$(grep -E '^RESULT: [0-9]+ passed, [0-9]+ failed' "$WORK/$suite.out" | tail -1)"
  p="$(printf '%s' "$line" | sed -n 's/^RESULT: \([0-9]*\) passed, \([0-9]*\) failed.*/\1/p')"
  f="$(printf '%s' "$line" | sed -n 's/^RESULT: \([0-9]*\) passed, \([0-9]*\) failed.*/\2/p')"
  eval "want=\$EXPECTED_$suite"
  if [ -z "$p" ]; then
    note="NO RESULT LINE (suite stopped early, exit $rc)"; p=0; f=0; PROBLEMS=$((PROBLEMS+1))
  elif [ "$f" != 0 ]; then
    note="FAILED CHECKS"; PROBLEMS=$((PROBLEMS+1))
  elif [ "$p" != "$want" ]; then
    note="COUNT DIFFERS (expected $want passed)"; PROBLEMS=$((PROBLEMS+1))
  else
    note="ok"
  fi
  TOTAL_PASS=$((TOTAL_PASS+p)); TOTAL_FAIL=$((TOTAL_FAIL+f))
  SUMMARY="$SUMMARY$(printf '  %-9s %4s passed  %3s failed   %s' "$suite" "$p" "$f" "$note")"$'\n'
  echo
done

# every BLOCKED line any shim logged in this run (a BLOCKED line means a script tried to write somewhere it must not)
BLOCKED_LINES="$(cat "$WORK"/logs/*/*.shim.log 2>/dev/null | grep -c BLOCKED)"

echo "=================== TOTAL ==================="
printf '%s' "$SUMMARY"
EXPECTED_TOTAL=$((EXPECTED_regress+EXPECTED_bugs+EXPECTED_extras+EXPECTED_fixes+EXPECTED_judgefix))
echo "  ---------"
printf '  %-9s %4s passed  %3s failed   (expected %s passed, 0 failed)\n' "ALL" "$TOTAL_PASS" "$TOTAL_FAIL" "$EXPECTED_TOTAL"
echo "  BLOCKED lines in all shim logs: $BLOCKED_LINES (the shims stopped this many writes; 0 is what you want)"
[ "$BLOCKED_LINES" = 0 ] || PROBLEMS=$((PROBLEMS+1))

if [ "$PROBLEMS" = 0 ] && [ "$TOTAL_FAIL" = 0 ]; then
  echo "ALL DEPLOY-SCRIPT TESTS PASSED"
  if [ "$WORK_IS_MINE" = yes ] && [ -z "${DEPLOY_TEST_KEEP:-}" ]; then
    case "$WORK" in */deploy-tests.*) rm -rf "$WORK" ;; esac     # only the scratch folder this run made itself
  else
    echo "Scratch folder kept at: $WORK"
  fi
  exit 0
fi
echo "SOMETHING IS WRONG (see the lines above). Scratch folder kept for inspection: $WORK"
exit 1
