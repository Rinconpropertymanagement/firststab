source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/harness.sh"
cd "$WORK"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }
rc_of() { sed -n 's/.*exit=\([0-9]*\).*/\1/p' <<<"$1" | head -1; }
expect_rc() { # expect_rc LABEL EXPECTED "[name] exit=N"
  [ "$(rc_of "$3")" = "$2" ] && ok "$1 (exit $2)" || bad "$1 (wanted exit $2, got: $3)"; }
srv_is_old()  { cmp -s "$FAKE/security-deposit/router.js" <(git -C "$REPO" show "HEAD~${1:-1}:projects/hub/security-deposit/router.js"); }
srv_is_new()  { cmp -s "$FAKE/security-deposit/router.js" "$HUB/security-deposit/router.js"; }
change() { echo "// change" >> "$HUB/security-deposit/router.js"; commit_all "change"; }
run_f() { local n="$1"; shift; export SHIM_LOG="$LOGS/$n.shim.log"; : > "$SHIM_LOG"; ( cd "$REPO" && env $FAILENV PATH="$SHIMS:$PATH" FAKE_SERVER_DIR="$FAKE" bash "projects/hub/$1" "${@:2}" ) > "$LOGS/$n.out" 2>&1 </dev/null; echo "[$n] exit=$?"; }
seed_del() { reset_env; gc rm -q projects/hub/seed-user-alt-email.js; gc commit -q -m rm
  echo notes > "$FAKE/docs-scratch.md"; mkdir -p "$FAKE/scratch-dir"; echo t > "$FAKE/scratch-dir/top.txt"
  echo r > "$FAKE/server.js.bak-1"; echo r > "$FAKE/server.js.pre-x.bak"; echo S=1 > "$FAKE/.env"; echo c > "$FAKE/cron-hand.sh"; change; }
protected_ok() { [ -e "$FAKE/server.js.bak-1" ] && [ -e "$FAKE/server.js.pre-x.bak" ] && [ -e "$FAKE/.env" ] && [ -e "$FAKE/cron-hand.sh" ]; }

# ---- normal flows
reset_env; r=$(run_deploy R-s0 deploy-to-sally.sh </dev/null); expect_rc "in-sync full deploy does nothing" 0 "$r"
reset_env; change; r=$(echo y | run_deploy R-s1 deploy-to-sally.sh); expect_rc "normal full deploy" 0 "$r"
srv_is_new && ok "normal deploy updated the file" || bad "normal deploy did not update file"
n=$(grep -n 'SIMULATED ssh cd /var/www/hub && npm install' "$LOGS/R-s1.shim.log" | cut -d: -f1); p=$(grep -n 'SIMULATED ssh pm2 restart' "$LOGS/R-s1.shim.log" | cut -d: -f1)
[ -n "$n" ] && [ -n "$p" ] && [ "$n" -lt "$p" ] && ok "npm install ran before pm2 restart" || bad "npm/pm2 order wrong ($n/$p)"
grep -q "About to run on Sally:  cd /var/www/hub && npm install" "$LOGS/R-s1.out" && grep -q "About to run on Sally:  pm2 restart" "$LOGS/R-s1.out" && ok "npm/pm2 steps print what they will run" || bad "missing 'about to run' lines"
reset_env; change; r=$(echo y | run_deploy R-f1 deploy-feature-to-sally.sh security-deposit); expect_rc "normal feature deploy" 0 "$r"; srv_is_new && ok "feature deploy updated file" || bad "feature deploy no update"
# ---- guard (a)
reset_env; change; echo "// hotfix on sally" >> "$FAKE/security-deposit/router.js"; cp "$FAKE/security-deposit/router.js" "$T/h.js"
r=$(echo y | run_deploy R-a1 deploy-feature-to-sally.sh security-deposit); expect_rc "(a) unrecorded Sally change stops" 2 "$r"; cmp -s "$FAKE/security-deposit/router.js" "$T/h.js" && ok "(a) Sally untouched" || bad "(a) Sally changed"
r=$(run_deploy R-a2 deploy-feature-to-sally.sh security-deposit --yes </dev/null); expect_rc "(a) --yes cannot bypass" 2 "$r"
r=$(echo n | run_deploy R-a3 deploy-feature-to-sally.sh security-deposit --allow-unrecorded-server-changes); expect_rc "(a) override + n declines" 1 "$r"; cmp -s "$FAKE/security-deposit/router.js" "$T/h.js" && ok "(a) override+n left Sally alone" || bad "(a) override+n changed Sally"
r=$(echo y | run_deploy R-a4 deploy-feature-to-sally.sh security-deposit --allow-unrecorded-server-changes); expect_rc "(a) override + y proceeds" 0 "$r"; srv_is_new && ok "(a) override overwrote" || bad "(a) override did not overwrite"
# ---- guard (b)
reset_env; echo "// u" >> "$HUB/security-deposit/router.js"
r=$(echo y | run_deploy R-b1 deploy-to-sally.sh); expect_rc "(b) uncommitted edit stops (full)" 2 "$r"
r=$(run_deploy R-b2 deploy-feature-to-sally.sh security-deposit --yes </dev/null); expect_rc "(b) --yes cannot bypass" 2 "$r"; srv_is_old 0 && ok "(b) Sally untouched" || bad "(b) Sally changed"
reset_env; echo n > "$HUB/security-deposit/new-untracked.js"; r=$(run_deploy R-b3 deploy-feature-to-sally.sh security-deposit --yes </dev/null); expect_rc "(b) untracked new file stops" 2 "$r"; [ -e "$FAKE/security-deposit/new-untracked.js" ] && bad "(b) untracked leaked" || ok "(b) untracked not sent"
reset_env; echo s >> "$HUB/security-deposit/router.js"; gc add projects/hub/security-deposit/router.js; r=$(run_deploy R-b4 deploy-feature-to-sally.sh security-deposit --yes </dev/null); expect_rc "(b) staged-only stops" 2 "$r"
reset_env; mkdir -p "$HUB/call-stats/.backfill-state"; echo '{}' > "$HUB/call-stats/.backfill-state/x.json"; r=$(run_deploy R-b5 deploy-feature-to-sally.sh call-stats --yes </dev/null); expect_rc "(b) gitignored file stops" 2 "$r"
reset_env; echo "// u" >> "$HUB/security-deposit/router.js"; r=$(echo y | run_deploy R-b6 deploy-feature-to-sally.sh security-deposit --allow-uncommitted); expect_rc "(b) override + y proceeds" 0 "$r"; srv_is_new && ok "(b) override sent file" || bad "(b) override did not send"
reset_env; echo "// u" >> "$HUB/security-deposit/router.js"; r=$(echo n | run_deploy R-b7 deploy-feature-to-sally.sh security-deposit --allow-uncommitted); expect_rc "(b) override + n declines" 1 "$r"
# ---- deleting
seed_del; r=$(echo y | run_deploy R-d1 deploy-to-sally.sh); expect_rc "default never deletes" 0 "$r"; [ -e "$FAKE/docs-scratch.md" ] && [ -e "$FAKE/scratch-dir/top.txt" ] && protected_ok && ok "default: Sally-only + protected files all survive" || bad "default deleted something"
seed_del; r=$(printf 'y\nDELETE\n' | run_deploy R-d2 deploy-to-sally.sh --delete-on-server --allow-lose-unrecorded-files); expect_rc "delete with piped DELETE (no terminal) refused" 2 "$r"; [ -e "$FAKE/docs-scratch.md" ] && ok "no-terminal: nothing deleted" || bad "no-terminal deleted"
seed_del; ANSWERS=("Proceed with this deploy? [y/N]=>y"); r=$(run_deploy_tty R-d3 deploy-to-sally.sh --delete-on-server); expect_rc "unrecorded delete w/o allow flag stops" 2 "$r"; [ -e "$FAKE/docs-scratch.md" ] && ok "unrecorded kept" || bad "unrecorded deleted"
seed_del; ANSWERS=("Type DELETE:=>delete"); r=$(run_deploy_tty R-d4 deploy-to-sally.sh --delete-on-server --allow-lose-unrecorded-files --yes); expect_rc "wrong word aborts (--yes given)" 1 "$r"; [ -e "$FAKE/docs-scratch.md" ] && srv_is_old && ok "wrong word: nothing deleted, nothing sent" || bad "wrong word had effect"
seed_del; ANSWERS=("Type DELETE:=>DELETE"); r=$(run_deploy_tty R-d5 deploy-to-sally.sh --delete-on-server --allow-lose-unrecorded-files --yes); expect_rc "--yes + typed DELETE proceeds" 0 "$r"
[ ! -e "$FAKE/docs-scratch.md" ] && [ ! -e "$FAKE/scratch-dir" ] && [ ! -e "$FAKE/seed-user-alt-email.js" ] && protected_ok && ok "deleted Sally-only files; protected files survived" || bad "delete result wrong"
seed_del; ANSWERS=("Proceed with this deploy? [y/N]=>n"); r=$(run_deploy_tty R-d6 deploy-to-sally.sh --delete-on-server --allow-lose-unrecorded-files); expect_rc "n at y/N aborts before DELETE prompt" 1 "$r"; grep -q "Type DELETE" "$LOGS/R-d6.out" && bad "DELETE prompt shown after n" || ok "no DELETE prompt after n"
seed_del; r=$(run_deploy R-d7 deploy-to-sally.sh --allow-lose-unrecorded-files </dev/null); expect_rc "--allow-lose without --delete-on-server rejected" 1 "$r"
grep -q "recorded in git (commit" <(seed_del; ANSWERS=("Proceed with this deploy? [y/N]=>n"); run_deploy_tty R-d8 deploy-to-sally.sh --delete-on-server >/dev/null; cat "$LOGS/R-d8.out") && ok "recorded file labelled with commit" || bad "no commit label"
grep -q "NOT IN GIT - would be lost permanently" "$LOGS/R-d8.out" && ok "unrecorded file labelled NOT IN GIT" || bad "no NOT IN GIT label"
# ---- fail closed
for spec in "ssh|SHIM_FAIL=ssh" "rsync-dry|SHIM_FAIL=rsync-dry" "pull|SHIM_FAIL=rsync-pull" "git-revlist|SHIM_FAIL_GIT=rev-list" "git-hash|SHIM_FAIL_GIT=hash-object" "ssh-cat|SHIM_FAIL=ssh-cat"; do
  nm=${spec%%|*}; FAILENV=${spec#*|}; reset_env; change
  r=$(run_f R-fc-$nm deploy-feature-to-sally.sh security-deposit --yes); expect_rc "fail-closed: $nm" 3 "$r"; srv_is_old && ok "fail-closed $nm: Sally untouched" || bad "fail-closed $nm: Sally CHANGED"
done
FAILENV="SHIM_FAIL=rsync-send"; reset_env; change; r=$(run_f R-fc-send deploy-to-sally.sh --yes); [ "$(rc_of "$r")" != "0" ] && ok "failed send is non-zero" || bad "failed send returned 0"
grep -q SIMULATED "$LOGS/R-fc-send.shim.log" && bad "npm/pm2 ran after failed send" || ok "npm/pm2 did NOT run after failed send"
FAILENV=""
# ---- misc
reset_env; mkdir -p "$FAKE/empty-d"; change; r=$(run_deploy R-m1 deploy-to-sally.sh --delete-on-server --yes </dev/null); expect_rc "folder-only delete needs terminal" 2 "$r"
reset_env; echo x > "$HUB/security-deposit/a.bak"; echo x > "$HUB/security-deposit/b.js.pre-x"; echo S=1 > "$HUB/security-deposit/.env"; change
r=$(run_deploy R-m2 deploy-feature-to-sally.sh security-deposit --yes </dev/null); expect_rc "excluded files ignored" 0 "$r"; [ -e "$FAKE/security-deposit/a.bak" ] || [ -e "$FAKE/security-deposit/b.js.pre-x" ] || [ -e "$FAKE/security-deposit/.env" ] && bad "excluded file reached server" || ok "excluded files not sent"
reset_env; chmod +x "$HUB/security-deposit/router.js"; commit_all chmod; r=$(run_deploy R-m3 deploy-feature-to-sally.sh security-deposit --yes </dev/null); expect_rc "mode-only change" 0 "$r"; [ -x "$FAKE/security-deposit/router.js" ] && ok "mode applied" || bad "mode not applied"
for a in "." ".." "/etc" "package.json" "./package.json" "nope-not-here" "--bogus"; do
  export SHIM_LOG="$LOGS/R-v.shim.log"; : > "$SHIM_LOG"; ( cd "$REPO" && PATH="$SHIMS:$PATH" bash projects/hub/deploy-feature-to-sally.sh "$a" ) >/dev/null 2>&1 </dev/null; rc=$?
  [ $rc -eq 1 ] && [ ! -s "$SHIM_LOG" ] && ok "validation rejects '$a' with no network call" || bad "validation '$a' rc=$rc log=$(wc -l < $SHIM_LOG)"
done
echo; echo "RESULT: $PASS passed, $FAIL failed"
echo "BLOCKED lines in all regression logs: $(cat $LOGS/R-*.shim.log | grep -c BLOCKED)"
