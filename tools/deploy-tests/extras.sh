source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/harness.sh"
cd "$WORK"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }
rc_of() { sed -n 's/.*exit=\([0-9]*\).*/\1/p' <<<"$1" | head -1; }
expect_rc() { [ "$(rc_of "$3")" = "$2" ] && ok "$1 (exit $2)" || bad "$1 (wanted exit $2, got: $3)"; }
runx() { local n="$1" envspec="$2" sc="$3"; shift 3; export SHIM_LOG="$LOGS/$n.shim.log"; : > "$SHIM_LOG"
  ( cd "$REPO" && env ${envspec:+"$envspec"} PATH="$SHIMS:$PATH" FAKE_SERVER_DIR="$FAKE" bash "projects/hub/$sc" "$@" ) > "$LOGS/$n.out" 2>&1 </dev/null; echo "[$n] exit=$?"; }
out_has() { grep -q -- "$2" "$LOGS/$1.out" && ok "$3" || bad "$3  [missing text: $2]"; }

echo "--- Sally FOLDER (with a file in it) where the deploy has a FILE"
reset_env; echo 'x=1' > "$HUB/email-intake/dirx"; commit_all dirx; mkdir -p "$FAKE/email-intake/dirx"; echo "SALLY WORK" > "$FAKE/email-intake/dirx/inner.txt"
r=$(runx E1 "" deploy-feature-to-sally.sh email-intake --yes); expect_rc "Sally folder where deploy has a file -> STOP" 2 "$r"; [ -f "$FAKE/email-intake/dirx/inner.txt" ] && ok "Sally folder contents untouched" || bad "Sally folder damaged"; out_has E1 "Sally has a folder here" "message says Sally has a folder"
echo "--- single NAMED file sitting on a Sally symlink"
reset_env; mkdir -p "$HUB/lib" "$FAKE/lib"; echo 'a=1' > "$HUB/lib/a.js"; commit_all a; echo b > "$FAKE/lib/b.js"; ln -s b.js "$FAKE/lib/a.js"
r=$(runx E2 "" deploy-feature-to-sally.sh lib/a.js --yes); expect_rc "named file on a Sally symlink -> STOP" 2 "$r"; [ -L "$FAKE/lib/a.js" ] && ok "symlink untouched" || bad "symlink replaced"
echo "--- named FOLDER unit where Sally has a plain file / symlink at the folder's own name"
reset_env; mkdir -p "$HUB/newdir"; echo n > "$HUB/newdir/n.js"; commit_all nd; echo "SALLY FILE" > "$FAKE/newdir"
r=$(runx E3 "" deploy-feature-to-sally.sh newdir --yes); expect_rc "folder unit on a Sally file -> fail closed" 3 "$r"; grep -q "SALLY FILE" "$FAKE/newdir" && ok "Sally file untouched" || bad "Sally file damaged"
echo "--- a new local symbolic link is not understood -> fail closed with plain words"
reset_env; mkdir -p "$HUB/lib"; echo a > "$HUB/lib/a.js"; ln -s a.js "$HUB/lib/link.js"; commit_all link
r=$(runx E4 "" deploy-feature-to-sally.sh lib --yes); expect_rc "new local symlink -> fail closed" 3 "$r"; out_has E4 "symbolic link" "message mentions symbolic link"
echo "--- failure of just the new 'find' look at Sally"
reset_env; echo "// c" >> "$HUB/security-deposit/router.js"; commit_all c
r=$(runx E5 "SHIM_FAIL=ssh-find" deploy-feature-to-sally.sh security-deposit --yes); expect_rc "ssh find fails -> fail closed" 3 "$r"; cmp -s "$FAKE/security-deposit/router.js" <(git -C "$REPO" show HEAD~1:projects/hub/security-deposit/router.js) && ok "Sally untouched" || bad "Sally changed"
r=$(runx E5b "SHIM_FAIL=ssh-find" deploy-to-sally.sh --yes); expect_rc "ssh find fails (full deploy) -> fail closed" 3 "$r"
echo "--- Sally-only dir where deploy has file inside excluded etc: normal Sally-only stuff must NOT be reported as a collision"
reset_env; mkdir -p "$FAKE/scratch-dir/sub"; echo t > "$FAKE/scratch-dir/sub/x.txt"; echo r > "$FAKE/server.js.bak-9"; echo c > "$FAKE/cron-x.sh"; echo "// c" >> "$HUB/security-deposit/router.js"; commit_all c
r=$(echo y | run_deploy E6 deploy-to-sally.sh); [ "$(rc_of "$r")" = 0 ] && ok "clean deploy with unrelated Sally-only items (exit 0)" || bad "unrelated Sally-only items caused a stop: $r"
grep -q "REPLACED" "$LOGS/E6.out" && bad "false collision reported" || ok "no false collision"
echo; echo "RESULT: $PASS passed, $FAIL failed; BLOCKED: $(cat $LOGS/E*.shim.log | grep -c BLOCKED)"
