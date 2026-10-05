source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/harness.sh"
cd "$WORK"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }
rc_of() { sed -n 's/.*exit=\([0-9]*\).*/\1/p' <<<"$1" | head -1; }
expect_rc() { [ "$(rc_of "$3")" = "$2" ] && ok "$1 (exit $2)" || bad "$1 (wanted exit $2, got: $3)"; }
out_has() { grep -q -- "$2" "$LOGS/$1.out" && ok "$3" || bad "$3  [missing text: $2]"; }
out_lacks() { grep -q -- "$2" "$LOGS/$1.out" && bad "$3  [unexpected text: $2]" || ok "$3"; }
# runx NAME "ENV=VALUE" script args...   (stdin = /dev/null; ENV may be empty)
runx() { local n="$1" envspec="$2" sc="$3"; shift 3; export SHIM_LOG="$LOGS/$n.shim.log"; : > "$SHIM_LOG"
  ( cd "$REPO" && env ${envspec:+"$envspec"} PATH="$SHIMS:$PATH" FAKE_SERVER_DIR="$FAKE" bash "projects/hub/$sc" "$@" ) > "$LOGS/$n.out" 2>&1 </dev/null; echo "[$n] exit=$?"; }
change() { echo "// change" >> "$HUB/security-deposit/router.js"; commit_all "change"; }
srv_is_old() { cmp -s "$FAKE/security-deposit/router.js" <(git -C "$REPO" show "HEAD~${1:-1}:projects/hub/security-deposit/router.js"); }
srv_is_new() { cmp -s "$FAKE/security-deposit/router.js" "$HUB/security-deposit/router.js"; }
no_net() { [ ! -s "$LOGS/$1.shim.log" ]; }

echo "##### BUG 1 (blocker): Sally file/symlink where the deploy creates a FOLDER (or file)"
reset_env; mkdir -p "$HUB/email-intake/newsub"; echo 'module.exports=1' > "$HUB/email-intake/newsub/z.js"; commit_all "newsub"
echo "SALLY-ONLY PRECIOUS TEXT (in no commit)" > "$FAKE/email-intake/newsub"
r=$(echo y | run_deploy B1a deploy-feature-to-sally.sh email-intake); expect_rc "1a: Sally file where deploy has a folder -> STOP" 2 "$r"
[ -f "$FAKE/email-intake/newsub" ] && grep -q PRECIOUS "$FAKE/email-intake/newsub" && ok "1a: Sally file untouched" || bad "1a: Sally file was changed"
out_has B1a "REPLACED by a different KIND" "1a: preview lists it under REPLACED"
out_has B1a "NOT saved anywhere in git" "1a: flagged as not saved in git"
grep -q "Files that exist only on Sally: 1" "$LOGS/B1a.out" && bad "1a: still counted as Sally-only" || ok "1a: not counted as a Sally-only file"
r=$(run_deploy B1b deploy-feature-to-sally.sh email-intake --yes </dev/null); expect_rc "1a: --yes cannot bypass" 2 "$r"
r=$(echo y | run_deploy B1c deploy-feature-to-sally.sh email-intake --allow-unrecorded-server-changes); expect_rc "1a: override + y proceeds" 0 "$r"
[ -d "$FAKE/email-intake/newsub" ] && ok "1a: override replaced it with the folder (explicit, warned)" || bad "1a: override did not replace"
# recorded variant: Sally's file content IS in git history -> allowed (nothing is lost)
reset_env; echo "OLD TEXT recorded in git" > "$HUB/email-intake/newsub"; commit_all "file newsub"; rm "$HUB/email-intake/newsub"; mkdir -p "$HUB/email-intake/newsub"; echo 'x=1' > "$HUB/email-intake/newsub/z.js"; commit_all "folder newsub"
cp "$(git -C "$REPO" show HEAD~1:projects/hub/email-intake/newsub | cat >/dev/null; echo /dev/null)" /dev/null 2>/dev/null
git -C "$REPO" show HEAD~1:projects/hub/email-intake/newsub > "$FAKE/email-intake/newsub"
r=$(echo y | run_deploy B1d deploy-feature-to-sally.sh email-intake); expect_rc "1a-recorded: file saved in git may be replaced (after y)" 0 "$r"; out_has B1d "this exact file is saved in git" "1a-recorded: preview says it is saved in git"
# symlink at a path where deploy has a regular file
reset_env; echo 'a=1' > "$HUB/email-intake/a.js"; commit_all "a.js"; echo 'b=1' > "$FAKE/email-intake/b.js"; ln -s b.js "$FAKE/email-intake/a.js"
r=$(echo y | run_deploy B1e deploy-feature-to-sally.sh email-intake); expect_rc "1b: Sally symlink where deploy has a file -> STOP" 2 "$r"
[ -L "$FAKE/email-intake/a.js" ] && ok "1b: symlink untouched" || bad "1b: symlink replaced"; out_has B1e "a symbolic link" "1b: preview names it a symbolic link"

echo; echo "##### BUG 2 (blocker): preview says LEFT ALONE but rsync removes a Sally file/symlink to make room for a folder"
reset_env; mkdir -p "$HUB/notes"; echo n1 > "$HUB/notes/n1.md"; commit_all "notes"; echo "SALLY-ONLY PRECIOUS" > "$FAKE/notes"
r=$(run_deploy B2a deploy-to-sally.sh --yes </dev/null); expect_rc "2: full deploy, Sally file where deploy has a folder -> STOP" 2 "$r"
[ -f "$FAKE/notes" ] && grep -q PRECIOUS "$FAKE/notes" && ok "2: Sally file survived" || bad "2: Sally file was destroyed"
out_has B2a "NOT saved anywhere in git" "2: flagged"
reset_env; mkdir -p "$HUB/email-intake/notes"; echo n1 > "$HUB/email-intake/notes/n1.md"; commit_all "notes"; echo "SALLY-ONLY PRECIOUS" > "$FAKE/email-intake/notes"
r=$(run_deploy B2b deploy-feature-to-sally.sh email-intake --yes </dev/null); expect_rc "2: feature deploy variant -> STOP" 2 "$r"; [ -f "$FAKE/email-intake/notes" ] && ok "2: feature variant file survived" || bad "2: feature variant destroyed"
reset_env; mkdir -p "$HUB/shared" "$T/mount"; touch "$HUB/shared/.gitkeep"; commit_all "shared"; echo mount-data > "$T/mount/data.txt"; ln -s "$T/mount" "$FAKE/shared"
r=$(run_deploy B2c deploy-to-sally.sh --yes </dev/null); expect_rc "2: Sally symlink-to-folder where deploy has a folder -> STOP" 2 "$r"; [ -L "$FAKE/shared" ] && ok "2: symlink-to-folder survived" || bad "2: symlink-to-folder replaced"
reset_env; mkdir -p "$HUB/notes"; echo n1 > "$HUB/notes/n1.md"; commit_all "notes"; echo "SALLY-ONLY PRECIOUS" > "$FAKE/notes"
export SHIM_LOG="$LOGS/B2d.shim.log"; : > "$SHIM_LOG"; ANSWERS=("Proceed with this deploy? [y/N]=>y" "Type DELETE:=>DELETE"); r=$(run_deploy_tty B2d deploy-to-sally.sh --delete-on-server); expect_rc "2: --delete-on-server also stops on the unrecorded file" 2 "$r"; [ -f "$FAKE/notes" ] && ok "2: delete mode: Sally file survived" || bad "2: delete mode destroyed it"

echo; echo "##### BUG 3: Sally symlink where the deploy has a regular file (guard (a) never saw it)"
reset_env; mkdir -p "$HUB/lib"; echo 'a=1' > "$HUB/lib/a.js"; commit_all "lib/a.js"; mkdir -p "$FAKE/lib"; ln -s ../server.js "$FAKE/lib/a.js"
r=$(run_deploy B3a deploy-to-sally.sh --yes </dev/null); expect_rc "3: Sally symlink replaced by file -> STOP" 2 "$r"; [ -L "$FAKE/lib/a.js" ] && ok "3: symlink untouched" || bad "3: symlink replaced"
out_lacks B3a "OK  No Sally files are being overwritten" "3: no false 'nothing overwritten' claim"

echo; echo "##### BUG 4: leading-space name bypassed the unrecorded-file guard in delete mode"
reset_env; echo 'lead v1' > "$HUB/lead.md"; commit_all "lead"; gc rm -q projects/hub/lead.md; gc commit -q -m "rm lead"
echo 'lead v1' > "$FAKE/lead.md"; echo 'PRECIOUS UNRECORDED WORK' > "$FAKE/ lead.md"
ANSWERS=("Proceed with this deploy? [y/N]=>y" "Type DELETE:=>DELETE"); r=$(run_deploy_tty B4a deploy-to-sally.sh --delete-on-server); expect_rc "4: twin-name repro now fails closed" 3 "$r"
[ -f "$FAKE/ lead.md" ] && [ -f "$FAKE/lead.md" ] && ok "4: both files survived" || bad "4: a file was deleted"
rm -f "$FAKE/lead.md"; ANSWERS=("Proceed with this deploy? [y/N]=>y" "Type DELETE:=>DELETE"); r=$(run_deploy_tty B4b deploy-to-sally.sh --delete-on-server); expect_rc "4: no-twin variant fails closed" 3 "$r"; [ -f "$FAKE/ lead.md" ] && ok "4: file survived" || bad "4: deleted"
# trailing-space name must be treated as its own (unrecorded) file, not merged with the recorded twin
reset_env; echo 'tw v1' > "$HUB/tw.md"; commit_all "tw"; gc rm -q projects/hub/tw.md; gc commit -q -m "rm tw"
echo 'tw v1' > "$FAKE/tw.md"; echo 'PRECIOUS TRAILING' > "$FAKE/tw.md "
ANSWERS=("Proceed with this deploy? [y/N]=>y"); r=$(run_deploy_tty B4c deploy-to-sally.sh --delete-on-server); expect_rc "4: trailing-space unrecorded twin stops (not merged with recorded twin)" 2 "$r"; [ -f "$FAKE/tw.md " ] && ok "4: trailing-space file survived" || bad "4: trailing-space file deleted"

echo; echo "##### BUG 5: path arguments with shell characters are rejected before any network call"
reset_env; for nm in 'semi;colon' 'dollar$(id)' 'back`tick`' 'sp ace' "quo'te" 'amp&er' 'pipe|x' 'star*'; do mkdir -p "$HUB/$nm"; echo x > "$HUB/$nm/f.js"; done; commit_all "weird names"
i=0; for nm in 'semi;colon' 'dollar$(id)' 'back`tick`' 'sp ace' "quo'te" 'amp&er' 'pipe|x' 'star*'; do i=$((i+1)); r=$(run_deploy B5-$i deploy-feature-to-sally.sh "$nm" </dev/null); [ "$(rc_of "$r")" = 1 ] && no_net B5-$i && ok "5: '$nm' rejected, no ssh/rsync call" || bad "5: '$nm' -> $r (net log lines: $(wc -l < $LOGS/B5-$i.shim.log))"; done

echo; echo "##### BUG 6: missing npm package is now a STOP"
reset_env; mkdir -p "$HUB/lib"; echo "const x = require('leftpad'); module.exports = x;" > "$HUB/lib/needs-pkg.js"; commit_all "needs leftpad"
r=$(run_deploy B6a deploy-feature-to-sally.sh lib/needs-pkg.js --yes </dev/null); expect_rc "6: missing package stops even with --yes" 2 "$r"; [ -e "$FAKE/lib/needs-pkg.js" ] && bad "6: file was sent" || ok "6: nothing sent"
grep -q 'pm2 restart' "$LOGS/B6a.shim.log" && bad "6: restart issued" || ok "6: no restart issued"
r=$(echo n | run_deploy B6b deploy-feature-to-sally.sh lib --allow-missing-packages); expect_rc "6: override + n declines" 1 "$r"
r=$(echo y | run_deploy B6c deploy-feature-to-sally.sh lib --allow-missing-packages); expect_rc "6: override + y proceeds" 0 "$r"; [ -e "$FAKE/lib/needs-pkg.js" ] && ok "6: override sent it" || bad "6: override did not send"
reset_env; echo "const x = require('leftpad');" > "$HUB/lib/needs-pkg.js"; mkdir -p "$HUB/lib"; r=$(run_deploy B6d deploy-feature-to-sally.sh lib/needs-pkg.js --yes --allow-missing-packages </dev/null); expect_rc "6: override alone cannot bypass the uncommitted stop" 2 "$r"

echo; echo "##### MINOR: HEAD / commit state moving while the y/N prompt waits"
reset_env; change; ANSWERS=("Proceed with this deploy? [y/N]=>@@git -C $REPO reset -q --soft HEAD~1@@y"); r=$(run_deploy_tty M1a deploy-feature-to-sally.sh security-deposit); expect_rc "HEAD moved (reset --soft) during prompt -> cancelled" 3 "$r"; srv_is_old 0 && ok "Sally untouched" || bad "Sally changed"
reset_env; change; ANSWERS=("Proceed with this deploy? [y/N]=>@@git -C $REPO reset -q --mixed HEAD~1@@y"); r=$(run_deploy_tty M1b deploy-to-sally.sh); expect_rc "commit state moved (reset --mixed) during prompt -> cancelled" 3 "$r"; srv_is_old 0 && ok "Sally untouched" || bad "Sally changed"
reset_env; change; ANSWERS=("Proceed with this deploy? [y/N]=>@@echo '// sneaky local edit' >> $HUB/security-deposit/router.js@@y"); r=$(run_deploy_tty M1c deploy-feature-to-sally.sh security-deposit); expect_rc "local file edited during prompt -> cancelled" 3 "$r"
reset_env; change; ANSWERS=("Proceed with this deploy? [y/N]=>@@echo '// hotfix' >> $FAKE/security-deposit/router.js@@y"); r=$(run_deploy_tty M1d deploy-feature-to-sally.sh security-deposit); expect_rc "Sally file edited during prompt -> cancelled" 3 "$r"

echo; echo "##### MINOR: naming excluded folders/files"
reset_env; mkdir -p "$HUB/node_modules/q"; echo x > "$HUB/node_modules/q/i.js"; echo S=1 > "$HUB/.env-local"; echo c > "$HUB/cron-hand.sh"; echo r > "$HUB/server.js.bak-1"
for a in node_modules node_modules/q node_modules/q/i.js .env-local cron-hand.sh server.js.bak-1 deploy-guard-lib.sh; do
  nm=M2-$(echo "$a" | tr '/.' '__'); r=$(run_deploy "$nm" deploy-feature-to-sally.sh "$a" --yes --allow-uncommitted --allow-unrecorded-server-changes </dev/null)
  [ "$(rc_of "$r")" = 1 ] && no_net "$nm" && ok "'$a' refused plainly (never-deployed list), no network call" || bad "'$a' -> $r"; done
out_has M2-node_modules "never-deployed list" "refusal message names the reason"

echo; echo "##### MINOR: git ERROR is not 'new file' any more"
reset_env; change; echo n > "$HUB/security-deposit/brand-new.js"; commit_all "brandnew"
r=$(runx M3a "SHIM_FAIL_GIT=ls-tree" deploy-feature-to-sally.sh security-deposit --yes); expect_rc "git ls-tree error -> fail closed (not exit 2)" 3 "$r"
r=$(runx M3b "SHIM_FAIL_GIT=ls-tree" deploy-feature-to-sally.sh security-deposit --yes --allow-uncommitted); expect_rc "git ls-tree error cannot be overridden by --allow-uncommitted" 3 "$r"
r=$(runx M3c "SHIM_FAIL_GIT_ARGS=rev-parse HEAD" deploy-feature-to-sally.sh security-deposit --yes --allow-uncommitted); expect_rc "git rev-parse HEAD error -> fail closed" 3 "$r"
srv_is_old 2 && ok "Sally untouched" || bad "Sally changed"

echo; echo "##### MINOR: path spellings"
for sp in './security-deposit' 'security-deposit/' 'security-deposit/.' './security-deposit/./router.js' 'security-deposit//router.js' 'security-deposit/router.js'; do
  reset_env; change; r=$(run_deploy "M4" deploy-feature-to-sally.sh "$sp" --yes </dev/null); [ "$(rc_of "$r")" = 0 ] && srv_is_new && ok "spelling '$sp' works" || bad "spelling '$sp' -> $r"; done

echo; echo "##### MINOR: nested new folder whose parent is missing on Sally"
reset_env; mkdir -p "$HUB/newfeature/sub"; echo n > "$HUB/newfeature/sub/n1.js"; commit_all "newfeature"
r=$(echo y | run_deploy M5a deploy-feature-to-sally.sh newfeature/sub); expect_rc "nested new folder: plain-English fail closed before the prompt" 3 "$r"; out_has M5a "does not exist on Sally yet" "hint printed"; [ -e "$FAKE/newfeature" ] && bad "something was created" || ok "nothing created"
r=$(echo y | run_deploy M5b deploy-feature-to-sally.sh newfeature); expect_rc "naming the top new folder works" 0 "$r"; [ -f "$FAKE/newfeature/sub/n1.js" ] && ok "folder tree arrived" || bad "folder tree missing"
reset_env; mkdir -p "$HUB/newfeature"; echo n > "$HUB/newfeature/n1.js"; commit_all "nf file"; r=$(echo y | run_deploy M5c deploy-feature-to-sally.sh newfeature/n1.js); expect_rc "single file in missing folder: fail closed with hint" 3 "$r"

echo; echo "##### MINOR: DELETE prompt wants the exact word"
reset_env; gc rm -q projects/hub/seed-user-alt-email.js; gc commit -q -m rm; echo n > "$FAKE/docs-scratch.md"; change
for ans in '  DELETE  ' ' DELETE' 'DELETE ' 'delete' 'DELETE!'; do
  ANSWERS=("Type DELETE:=>$ans"); r=$(run_deploy_tty M6 deploy-to-sally.sh --delete-on-server --allow-lose-unrecorded-files --yes); [ "$(rc_of "$r")" = 1 ] && [ -e "$FAKE/docs-scratch.md" ] && ok "'$ans' refused" || bad "'$ans' accepted ($r)"; done
ANSWERS=("Type DELETE:=>DELETE"); r=$(run_deploy_tty M6 deploy-to-sally.sh --delete-on-server --allow-lose-unrecorded-files --yes); expect_rc "exact DELETE accepted" 0 "$r"; [ ! -e "$FAKE/docs-scratch.md" ] && ok "deleted after exact DELETE" || bad "not deleted"

echo; echo "##### MINOR: odd names, secrets, rollback copies, zsh, directory permissions"
reset_env; printf 'x' > "$HUB/security-deposit/café.js"; commit_all "cafe"; r=$(run_deploy M7a deploy-to-sally.sh --yes </dev/null); expect_rc "accented file name now works" 0 "$r"; [ -f "$FAKE/security-deposit/café.js" ] && ok "café.js arrived" || bad "café.js missing"
reset_env; printf 'x' > "$HUB/security-deposit/a\\b.js"; commit_all "backslash"; r=$(run_deploy M7b deploy-to-sally.sh --yes </dev/null); expect_rc "backslash file name still fails closed" 3 "$r"; [ -e "$FAKE/security-deposit/a\\b.js" ] && bad "sent" || ok "nothing sent"
reset_env; for n in .env-local .envrc .env-old .env.production; do echo S=1 > "$HUB/$n"; done; change; r=$(run_deploy M8 deploy-to-sally.sh --yes --allow-uncommitted </dev/null); expect_rc "secrets-like names: deploy ok" 0 "$r"; ls -a "$FAKE" | grep -q '^\.env' && bad "a .env* file reached the server" || ok "no .env* file reached the server"
reset_env; echo p > "$HUB/security-deposit/lib.pre-process.js"; echo r > "$HUB/security-deposit/x.js.pre-y"; echo r > "$HUB/security-deposit/y.bak"; echo r > "$HUB/security-deposit/z.bak-1"; commit_all "names"
r=$(run_deploy M9 deploy-feature-to-sally.sh security-deposit --yes </dev/null); expect_rc "real file lib.pre-process.js is deployed" 0 "$r"
[ -f "$FAKE/security-deposit/lib.pre-process.js" ] && ok "lib.pre-process.js arrived" || bad "lib.pre-process.js was skipped"; { [ -e "$FAKE/security-deposit/x.js.pre-y" ] || [ -e "$FAKE/security-deposit/y.bak" ] || [ -e "$FAKE/security-deposit/z.bak-1" ]; } && bad "rollback-style file sent" || ok "rollback-style files not sent"
reset_env; export SHIM_LOG="$LOGS/M10.shim.log"; : > "$SHIM_LOG"; ( cd "$REPO" && PATH="$SHIMS:$PATH" FAKE_SERVER_DIR="$FAKE" zsh projects/hub/deploy-to-sally.sh --yes ) > "$LOGS/M10.out" 2>&1 </dev/null; rc=$?; [ $rc = 1 ] && no_net M10 && grep -q "must be run with bash" "$LOGS/M10.out" && ok "zsh refused politely before anything ran" || bad "zsh run rc=$rc"
reset_env; chmod 700 "$HUB/security-deposit"; r=$(echo y | run_deploy M11 deploy-feature-to-sally.sh security-deposit); expect_rc "directory permission change deploy" 0 "$r"; out_has M11 "permissions would change" "preview lists the folder permission change"; [ "$(stat -f %Lp "$FAKE/security-deposit")" = 700 ] && ok "folder mode applied as previewed" || bad "mode not applied"

echo; echo "##### MINOR: failures after the copy explain themselves"
for spec in "npm|SHIM_FAIL=ssh-npm|FAILED: npm install|WERE copied" "pm2|SHIM_FAIL=ssh-pm2|FAILED: restarting|WERE copied" "send|SHIM_FAIL=rsync-send|FAILED: copying|did NOT run"; do
  IFS='|' read -r nm envs txt1 txt2 <<<"$spec"; reset_env; change; r=$(runx M12-$nm "$envs" deploy-to-sally.sh --yes); [ "$(rc_of "$r")" != 0 ] && ok "$nm failure is non-zero" || bad "$nm failure returned 0"
  out_has M12-$nm "$txt1" "$nm failure: plain-English headline"; out_has M12-$nm "$txt2" "$nm failure: says what was/was not done"; done

echo; echo "##### MINOR: hangs and progress"
reset_env; change; r=$(run_deploy M13 deploy-feature-to-sally.sh security-deposit --yes </dev/null); grep -q -- '--timeout=120' "$LOGS/M13.shim.log" && ok "rsync calls carry --timeout" || bad "no rsync --timeout"; grep -q 'ServerAliveInterval=15' "$LOGS/M13.shim.log" && ok "ssh calls carry ServerAliveInterval" || bad "no ssh keep-alive"; out_has M13 "against git..." "progress line printed"

echo; echo "##### nothing-to-send behaviour"
reset_env; r=$(run_deploy M14 deploy-to-sally.sh --yes </dev/null); expect_rc "in-sync full deploy: exit 0" 0 "$r"; grep -q 'pm2 restart\|npm install' "$LOGS/M14.shim.log" && bad "restart/npm ran" || ok "no npm install / pm2 restart when nothing to send"

echo; echo "RESULT: $PASS passed, $FAIL failed"
echo "BLOCKED lines in all bug-test logs: $(cat $LOGS/B*.shim.log $LOGS/M*.shim.log 2>/dev/null | grep -c BLOCKED)"
