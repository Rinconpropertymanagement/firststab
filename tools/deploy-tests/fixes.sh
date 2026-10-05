source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/harness.sh"
cd "$WORK"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }
rc_of() { sed -n 's/.*exit=\([0-9]*\).*/\1/p' <<<"$1" | head -1; }
expect_rc() { [ "$(rc_of "$3")" = "$2" ] && ok "$1 (exit $2)" || bad "$1 (wanted exit $2, got: $3)"; }
out_has() { grep -Fq -- "$2" "$LOGS/$1.out" && ok "$3" || bad "$3  [missing text: $2]"; }
out_lacks() { grep -Fq -- "$2" "$LOGS/$1.out" && bad "$3  [unexpected text: $2]" || ok "$3"; }
# runx NAME "ENV=VALUE" script args...   (stdin = /dev/null; ENV may be empty)
runx() { local n="$1" envspec="$2" sc="$3"; shift 3; export SHIM_LOG="$LOGS/$n.shim.log"; : > "$SHIM_LOG"
  ( cd "$REPO" && env ${envspec:+"$envspec"} PATH="$SHIMS:$PATH" FAKE_SERVER_DIR="$FAKE" bash "projects/hub/$sc" "$@" ) > "$LOGS/$n.out" 2>&1 </dev/null; echo "[$n] exit=$?"; }
# run against the REAL Sally (read-only through the write-blocking shims); stdin is whatever the caller pipes
run_real() { local n="$1" sc="$2"; shift 2; export SHIM_LOG="$LOGS/$n.shim.log"; : > "$SHIM_LOG"
  ( cd "$REPO" && PATH="$SHIMS:$PATH" bash "projects/hub/$sc" "$@" ) > "$LOGS/$n.out" 2>&1; echo "[$n] exit=$?"; }
change() { echo "// change" >> "$HUB/security-deposit/router.js"; commit_all "change"; }
srv_is_old() { cmp -s "$FAKE/security-deposit/router.js" <(git -C "$REPO" show "HEAD~${1:-1}:projects/hub/security-deposit/router.js"); }
srv_is_new() { cmp -s "$FAKE/security-deposit/router.js" "$HUB/security-deposit/router.js"; }
TAB="$(printf '\t')"

only="${1:-all}"
want() { [ "$only" = all ] || [ "$only" = "$1" ]; }

if want A; then
echo "##### FIX A (important): brand-new folder on Sally ('created directory' line from the real rsync)"
reset_env; mkdir -p "$HUB/zz-new"; echo 'x=1' > "$HUB/zz-new/f.js"; commit_all "zz-new"
# prove the fake server now reproduces real Sally's extra line
out=$(PATH="$SHIMS:$PATH" FAKE_SERVER_DIR="$FAKE" SHIM_LOG="$LOGS/A0.shim.log" rsync -rlpz -n --itemize-changes "$HUB/zz-new/" sally:/var/www/hub/zz-new/ 2>&1)
case "$out" in "created directory /var/www/hub/zz-new"*) ok "A0 fake server prints real Sally's 'created directory' line";; *) bad "A0 fake server does not emulate the line: $out";; esac
r=$(echo n | run_deploy A1 deploy-feature-to-sally.sh zz-new); expect_rc "A1 new folder, answer n -> reaches the question and aborts" 1 "$r"
out_lacks A1 "COULD NOT VERIFY" "A1 no fail-closed message"; out_has A1 "+ zz-new/f.js" "A1 preview lists the new file"
[ -e "$FAKE/zz-new" ] && bad "A1 something was created after n" || ok "A1 nothing created after n"
r=$(echo y | run_deploy A2 deploy-feature-to-sally.sh zz-new); expect_rc "A2 new folder, answer y -> deployed" 0 "$r"; [ -f "$FAKE/zz-new/f.js" ] && ok "A2 file arrived" || bad "A2 file missing"
reset_env; mkdir -p "$HUB/email-intake/new-sub"; echo 'x=1' > "$HUB/email-intake/new-sub/f.js"; commit_all "new-sub"
r=$(echo y | run_deploy A3 deploy-feature-to-sally.sh email-intake/new-sub); expect_rc "A3 new sub-folder under an existing folder (named directly) -> deployed" 0 "$r"; [ -f "$FAKE/email-intake/new-sub/f.js" ] && ok "A3 file arrived" || bad "A3 file missing"
reset_env; mkdir -p "$HUB/email-intake/new-sub2"; echo 'x=1' > "$HUB/email-intake/new-sub2/f.js"; commit_all "new-sub2"
r=$(echo y | run_deploy A4 deploy-feature-to-sally.sh email-intake); expect_rc "A4 existing folder with a new sub-folder -> deployed" 0 "$r"; [ -f "$FAKE/email-intake/new-sub2/f.js" ] && ok "A4 file arrived" || bad "A4 file missing"
reset_env; mkdir -p "$HUB/zz-new"; echo 'x=1' > "$HUB/zz-new/f.js"; commit_all "zz-new"
r=$(echo y | run_deploy A5 deploy-to-sally.sh); expect_rc "A5 full deploy with a brand-new top folder -> deployed" 0 "$r"; [ -f "$FAKE/zz-new/f.js" ] && ok "A5 file arrived" || bad "A5 file missing"
# strictness: only the ONE expected line for the unit's own folder is skipped; anything else still fails closed
reset_env; mkdir -p "$HUB/zz-new"; echo 'x=1' > "$HUB/zz-new/f.js"; commit_all "zz-new"
r=$(runx A6 "SHIM_EXTRA_DRY_LINE=created directory /var/www/hub/something-else" deploy-feature-to-sally.sh zz-new --yes); expect_rc "A6 'created directory' for a DIFFERENT path still fails closed" 3 "$r"; [ -e "$FAKE/zz-new" ] && bad "A6 sent anyway" || ok "A6 nothing sent"
reset_env; change
r=$(runx A7 "SHIM_EXTRA_DRY_LINE=created directory /var/www/hub/security-deposit" deploy-feature-to-sally.sh security-deposit --yes); expect_rc "A7 'created directory' for a folder that already exists on Sally still fails closed" 3 "$r"; srv_is_old && ok "A7 Sally untouched" || bad "A7 Sally changed"
# REAL Sally, read-only dry run of a brand-new folder (the shims block any write); answer n
reset_env; mkdir -p "$HUB/zz-tars-newdir"; echo 'x=1' > "$HUB/zz-tars-newdir/f.js"; commit_all "zz-tars-newdir"
r=$(echo n | run_real A8 deploy-feature-to-sally.sh zz-tars-newdir); expect_rc "A8 REAL Sally: new folder, answer n -> reaches the question and aborts" 1 "$r"
out_lacks A8 "COULD NOT VERIFY" "A8 no fail-closed message on real Sally"; out_has A8 "+ zz-tars-newdir/f.js" "A8 preview lists the new file"
grep -q 'ALLOW  ssh(rsync dry-run)' "$LOGS/A8.shim.log" && ok "A8 the real remote dry run really happened" || bad "A8 no remote dry run in the log"
SHIM_LOG="$LOGS/A9.shim.log" PATH="$SHIMS:$PATH" ssh -n -o BatchMode=yes sally "test -e /var/www/hub/zz-tars-newdir"; erc=$?; [ "$erc" = 1 ] && ok "A9 nothing was created on real Sally (test -e says absent)" || bad "A9 real Sally check returned $erc (0 = folder exists!, 255 = ssh problem)"
fi

if want B; then
echo; echo "##### FIX B (blocker): a Sally version that exists only on ANOTHER branch must not count as saved"
reset_env; gc checkout -q -b zz-other; echo "// NEWER committed on other branch" >> "$HUB/security-deposit/router.js"; commit_all "other-branch work"
cp "$HUB/security-deposit/router.js" "$T/other-version.js"; gc checkout -q "$MAIN_BRANCH"; change; cp "$T/other-version.js" "$FAKE/security-deposit/router.js"
r=$(run_deploy B1 deploy-to-sally.sh --yes </dev/null); expect_rc "B1 full deploy: Sally copy only on another branch -> STOP" 2 "$r"
cmp -s "$FAKE/security-deposit/router.js" "$T/other-version.js" && ok "B1 Sally untouched" || bad "B1 Sally was overwritten"
out_has B1 "only on another branch" "B1 says it is only on another branch"; out_has B1 "zz-other" "B1 names the branch"
r=$(run_deploy B2 deploy-feature-to-sally.sh security-deposit --yes </dev/null); expect_rc "B2 feature deploy: same stop" 2 "$r"
r=$(run_deploy B3 deploy-to-sally.sh --yes --allow-unrecorded-server-changes </dev/null); expect_rc "B3 override flag + --yes proceeds" 0 "$r"; srv_is_new && ok "B3 overwritten only because of the override" || bad "B3 not overwritten"
# Sally has a version from HEAD's OWN history -> fine
reset_env; change; git -C "$REPO" show HEAD~1:projects/hub/security-deposit/router.js > "$FAKE/security-deposit/router.js"
r=$(run_deploy B4 deploy-to-sally.sh --yes </dev/null); expect_rc "B4 Sally copy is in HEAD's own history -> normal deploy" 0 "$r"; srv_is_new && ok "B4 updated" || bad "B4 not updated"
out_has B4 "saved in git" "B4 summary says saved in git"
# delete mode: recorded only on another branch is still recoverable -> allowed without the extra flag, labelled honestly
reset_env; gc checkout -q -b zz-other; echo "scratch notes only on other branch" > "$HUB/docs-scratch.md"; commit_all other; gc checkout -q "$MAIN_BRANCH"
echo "scratch notes only on other branch" > "$FAKE/docs-scratch.md"
ANSWERS=("Proceed with this deploy? [y/N]=>y" "Type DELETE:=>DELETE"); r=$(run_deploy_tty B5 deploy-to-sally.sh --delete-on-server); expect_rc "B5 delete mode, file recorded on another branch" 0 "$r"
out_has B5 "recorded in git, but only on another branch" "B5 label is honest about the branch"; [ -e "$FAKE/docs-scratch.md" ] && bad "B5 not deleted" || ok "B5 deleted (it is recoverable from git)"
fi

if want C; then
echo; echo "##### FIX C (blocker): file names that look like echo options (-n, -e ...)"
for nm in -n -nn -ne -e -E; do
  reset_env; change; printf 'secret work\n' > "$HUB/$nm"
  r=$(run_deploy "C1$nm" deploy-to-sally.sh --yes </dev/null); expect_rc "C1 untracked '$nm' at the hub root -> STOP" 2 "$r"
  [ -e "$FAKE/$nm" ] && bad "C1 '$nm' was sent" || ok "C1 '$nm' was not sent"
  grep -Fq -- "!!!     $nm   (new file" "$LOGS/C1$nm.out" && ok "C1 '$nm' is listed in the stop" || bad "C1 '$nm' missing from the stop list"
  grep -Fq -- "+ $nm" "$LOGS/C1$nm.out" && ok "C1 '$nm' is listed in the preview" || bad "C1 '$nm' missing from the preview"
done
reset_env; change; printf 'secret work\n' > "$HUB/-n"
r=$(run_deploy C2 deploy-feature-to-sally.sh ./-n security-deposit --yes </dev/null); expect_rc "C2 feature script, unit './-n' untracked -> STOP" 2 "$r"; [ -e "$FAKE/-n" ] && bad "C2 sent" || ok "C2 not sent"
out_has C2 "!!!     -n   (new file" "C2 listed"
# delete mode: unrecorded Sally-only '-n' next to a recorded file must be LISTED and must need --allow-lose-unrecorded-files
for nm in -n -ne; do
  reset_env; printf 'recorded text\n' > "$HUB/rec.md"; commit_all rec; gc rm -q projects/hub/rec.md; gc commit -q -m rmrec
  printf 'recorded text\n' > "$FAKE/rec.md"; printf 'PRECIOUS UNRECORDED\n' > "$FAKE/$nm"
  ANSWERS=("Proceed with this deploy? [y/N]=>y" "Type DELETE:=>DELETE"); r=$(run_deploy_tty "C3$nm" deploy-to-sally.sh --delete-on-server); expect_rc "C3 delete mode, unrecorded Sally-only '$nm' -> STOP" 2 "$r"
  [ -f "$FAKE/$nm" ] && [ -f "$FAKE/rec.md" ] && ok "C3 '$nm': both Sally files survived" || bad "C3 '$nm': a file was deleted"
  grep -Fq -- "x $nm   NOT IN GIT" "$LOGS/C3$nm.out" && ok "C3 '$nm' listed as NOT IN GIT" || bad "C3 '$nm' not listed as NOT IN GIT"
done
fi

if want D; then
echo; echo "##### FIX D (minor): LC_ALL=C must not be passed on to Sally"
reset_env; change
r=$(runx D1 "LC_ALL=en_US.UTF-8" deploy-to-sally.sh --yes); expect_rc "D1 full deploy works" 0 "$r"
n=$(grep -c 'ENV    LC_ALL=' "$LOGS/D1.shim.log"); b=$(grep 'ENV    LC_ALL=' "$LOGS/D1.shim.log" | grep -vc 'LC_ALL=<unset>')
[ "$n" -ge 6 ] && ok "D1 $n ssh/rsync calls were observed" || bad "D1 only $n calls observed"
[ "$b" = 0 ] && ok "D1 every ssh/rsync call had LC_ALL unset (nothing passed to Sally)" || { bad "D1 $b call(s) still carried LC_ALL"; grep 'ENV    LC_ALL=' "$LOGS/D1.shim.log" | grep -v '<unset>' | head -3; }
reset_env; change
r=$(runx D2 "" deploy-feature-to-sally.sh security-deposit --yes); n=$(grep -c 'ENV    LC_ALL=' "$LOGS/D2.shim.log"); b=$(grep 'ENV    LC_ALL=' "$LOGS/D2.shim.log" | grep -vc 'LC_ALL=<unset>')
[ "$n" -ge 5 ] && [ "$b" = 0 ] && ok "D2 feature script: $n calls, none carried LC_ALL" || bad "D2 feature script: n=$n carrying=$b"
fi

if want E; then
echo; echo "##### FIX E (minor): a tab in a file name fails closed (it used to mislabel files)"
reset_env; printf 'recorded text\n' > "$HUB/rec.md"; commit_all rec; gc rm -q projects/hub/rec.md; gc commit -q -m rmrec
printf 'recorded text\n' > "$FAKE/rec.md"; printf 'PRECIOUS UNRECORDED\n' > "$FAKE/rec.md$TAB"
ANSWERS=("Proceed with this deploy? [y/N]=>y" "Type DELETE:=>DELETE"); r=$(run_deploy_tty E1 deploy-to-sally.sh --delete-on-server); expect_rc "E1 Sally-only name ending in a tab -> fail closed" 3 "$r"
[ -f "$FAKE/rec.md" ] && [ -f "$FAKE/rec.md$TAB" ] && ok "E1 both files survived" || bad "E1 a file was deleted"
reset_env; printf 'x\n' > "$HUB/security-deposit/tab${TAB}here.js"; commit_all tabname
r=$(run_deploy E2 deploy-feature-to-sally.sh security-deposit --yes </dev/null); expect_rc "E2 committed local file with a tab in its name -> fail closed (plain reason)" 3 "$r"; out_has E2 "tab" "E2 message mentions the tab"
fi

if want F; then
echo; echo "##### FIX F (minor): the never-deploy name list now follows the approved plan (*.bak* and *.*.pre-*)"
cat > "$T/excl-test.sh" <<'EOS'
LOCAL_DIR=$1; . "$LOCAL_DIR/deploy-guard-lib.sh"
# every name below is created as a real file; rsync's own exclude and guard_path_is_excluded must AGREE
d=$(mktemp -d "${TMPDIR:-/tmp}/excl.XXXXXX"); trap 'rm -rf "$d"' EXIT
EXCLUDED="server.js.backup-1 a.backup foo.bak~ keep.bakx x.json.pre-1 server.js.pre-x a.bak a.js.bak-2 a.bak2 server.js.bak-20261001153325 server.js.pre-rental-analysis-restore.bak .env .env.local cron-x.sh x.log .DS_Store deploy-guard-lib.sh x.js.pre-1.bak b.md.pre-edit"
KEPT="lib.pre-process.js bakery.js prebak.js pre-commit.js lib.js backup.js rebake.js server.js a.js.pre keep.js"
mkdir -p "$d/src" "$d/dst" "$d/src/x.bak" "$d/src/node_modules"
for n in $EXCLUDED $KEPT; do echo c > "$d/src/$n"; done
echo c > "$d/src/x.bak/inner.js"; echo c > "$d/src/node_modules/m.js"
rsync -rl -n --itemize-changes "${DEPLOY_EXCLUDES[@]}" "$d/src/" "$d/dst/" | sed -n 's/^[<>]f[+]* //p' | sort > "$d/rsync-sends"
bad=0
for n in $EXCLUDED; do
  guard_path_is_excluded "$n" >/dev/null || { echo "NOT excluded by guard_path_is_excluded: $n"; bad=1; }
  grep -qxF "$n" "$d/rsync-sends" && { echo "rsync would SEND (should be excluded): $n"; bad=1; }
done
for n in $KEPT; do
  guard_path_is_excluded "$n" >/dev/null && { echo "WRONGLY excluded by guard_path_is_excluded: $n"; bad=1; }
  grep -qxF "$n" "$d/rsync-sends" || { echo "rsync would NOT send (should deploy): $n"; bad=1; }
done
guard_path_is_excluded "x.bak/inner.js" >/dev/null || { echo "folder x.bak not excluded: guard"; bad=1; }
grep -q 'inner.js' "$d/rsync-sends" && { echo "rsync sends inside x.bak"; bad=1; }
guard_path_is_excluded "node_modules/m.js" >/dev/null || { echo "node_modules not excluded"; bad=1; }
# nothing git tracks in the hub is newly skipped compared with the OLD pattern list
OLD=( node_modules '.env*' .git .DS_Store '*.log' 'cron-*.sh' '*.bak' '*.bak[-._0-9]*' '*.js.pre-*' deploy-guard-lib.sh )
cd "$LOCAL_DIR" && git ls-files -z . | tr '\0' '\n' | while IFS= read -r f; do
  new=false; guard_path_is_excluded "$f" >/dev/null && new=true
  old=false; rest="$f"; while [ -n "$rest" ]; do seg="${rest%%/*}"; case "$rest" in */*) rest="${rest#*/}";; *) rest="";; esac; for p in "${OLD[@]}"; do case "$seg" in $p) old=true;; esac; done; done
  [ "$new" = "$old" ] || echo "TRACKED FILE CLASSIFICATION CHANGED: $f (old=$old new=$new)"
done > "$d/tracked-diff"
[ -s "$d/tracked-diff" ] && { cat "$d/tracked-diff"; bad=1; }
echo "tracked files checked: $(git ls-files . | wc -l | tr -d ' ')"
exit $bad
EOS
reset_env; res=$(bash "$T/excl-test.sh" "$HUB" 2>&1); rc=$?; echo "$res" | sed 's/^/        /'
[ $rc -eq 0 ] && ok "F1 pattern list: rsync and guard agree; wanted names excluded, real source kept, no tracked file newly skipped" || bad "F1 pattern list problems (see above)"
reset_env; for nm in server.js.backup-1 foo.bak~ x.json.pre-1; do printf 'x\n' > "$HUB/security-deposit/$nm"; done; change
r=$(run_deploy F2 deploy-feature-to-sally.sh security-deposit --yes </dev/null); expect_rc "F2 uncommitted rollback-style names are ignored (not a stop)" 0 "$r"
[ -e "$FAKE/security-deposit/server.js.backup-1" ] || [ -e "$FAKE/security-deposit/foo.bak~" ] || [ -e "$FAKE/security-deposit/x.json.pre-1" ] && bad "F2 a rollback-style file was sent" || ok "F2 rollback-style files not sent"
reset_env; printf 'x\n' > "$FAKE/security-deposit/server.js.backup-1"; printf 'x\n' > "$FAKE/x.json.pre-1"; change
ANSWERS=("Proceed with this deploy? [y/N]=>y" "Type DELETE:=>DELETE"); r=$(run_deploy_tty F3 deploy-to-sally.sh --delete-on-server --yes); expect_rc "F3 delete mode never lists or deletes rollback-style files (nothing else to delete -> deploys only)" 0 "$r"
[ -e "$FAKE/security-deposit/server.js.backup-1" ] && [ -e "$FAKE/x.json.pre-1" ] && ok "F3 rollback-style Sally files survived delete mode" || bad "F3 rollback-style Sally file deleted"
fi

if want G; then
echo; echo "##### FIX G (minor): a named FILE where Sally has a FOLDER of that name"
reset_env; rm -f "$FAKE/security-deposit/router.js"; mkdir -p "$FAKE/security-deposit/router.js"; echo inner > "$FAKE/security-deposit/router.js/inner.txt"; change
r=$(echo y | run_deploy G1 deploy-feature-to-sally.sh security-deposit/router.js --allow-unrecorded-server-changes); expect_rc "G1 file unit on a Sally folder -> fail closed even with the override" 3 "$r"
[ -e "$FAKE/security-deposit/router.js/router.js" ] && bad "G1 file was put inside the Sally folder" || ok "G1 nothing was put inside the Sally folder"
[ -f "$FAKE/security-deposit/router.js/inner.txt" ] && ok "G1 Sally folder untouched" || bad "G1 Sally folder damaged"
out_has G1 "folder" "G1 message mentions the folder"
fi

if want H; then
echo; echo "##### FIX H (minor): helper file missing -> plain-English message"
for sc in deploy-to-sally.sh deploy-feature-to-sally.sh; do
  reset_env; rm "$HUB/deploy-guard-lib.sh"; export SHIM_LOG="$LOGS/H-$sc.shim.log"; : > "$SHIM_LOG"
  ( cd "$REPO" && PATH="$SHIMS:$PATH" FAKE_SERVER_DIR="$FAKE" bash "projects/hub/$sc" security-deposit --yes ) > "$LOGS/H-$sc.out" 2>&1 </dev/null; rc=$?
  [ $rc -eq 3 ] && ok "H $sc exits 3" || bad "H $sc exit $rc"
  grep -q "Could not load" "$LOGS/H-$sc.out" && ok "H $sc says what is wrong in plain English" || bad "H $sc raw error: $(head -2 "$LOGS/H-$sc.out")"
  grep -q "No such file" "$LOGS/H-$sc.out" && bad "H $sc shows bash's raw error" || ok "H $sc no raw bash error"
  [ -s "$SHIM_LOG" ] && bad "H $sc touched the network" || ok "H $sc touched nothing"
done
fi

if want I; then
echo; echo "##### FIX I (minor): missing-package check reads 'require ( 'x' )' with spaces and ignores node: modules"
reset_env; printf "const x = require( 'leftpad-zz' );\n" > "$HUB/security-deposit/zz-spaces.js"; commit_all spaces
r=$(run_deploy I1 deploy-feature-to-sally.sh security-deposit/zz-spaces.js --yes </dev/null); expect_rc "I1 require( 'pkg' ) with spaces, missing on Sally -> STOP" 2 "$r"; out_has I1 "NEEDS NPM PACKAGES" "I1 says why"
reset_env; printf "const t = require('node:test'); const p = require ( \"node:path\" ); const f = require('fs');\n" > "$HUB/security-deposit/zz-node.js"; commit_all nodemods
r=$(run_deploy I2 deploy-feature-to-sally.sh security-deposit/zz-node.js --yes </dev/null); expect_rc "I2 node:test / node:path / fs are not 'missing packages'" 0 "$r"
reset_env; printf "const x = require('leftpad-zz');\n" > "$HUB/security-deposit/zz-plain.js"; commit_all plain
r=$(run_deploy I3 deploy-feature-to-sally.sh security-deposit/zz-plain.js --yes </dev/null); expect_rc "I3 plain require('pkg') still stops (unchanged)" 2 "$r"
r=$(run_deploy I4 deploy-feature-to-sally.sh security-deposit/zz-plain.js --yes --allow-missing-packages </dev/null); expect_rc "I4 --allow-missing-packages still overrides" 0 "$r"
fi

if want J; then
echo; echo "##### FIX J (minor): tracked files that are never sent get a preview note when they differ from Sally"
reset_env; r=$(run_deploy J1 deploy-to-sally.sh </dev/null); expect_rc "J1 in sync -> nothing to send" 0 "$r"; out_lacks J1 "NOT sent by these scripts" "J1 no note when the skipped tracked files match Sally"
reset_env; echo "# edited here" >> "$HUB/cron-send-reminders.sh"; commit_all cron
r=$(run_deploy J2 deploy-to-sally.sh --yes </dev/null); expect_rc "J2 edited tracked cron script -> still 'nothing to send'" 0 "$r"
out_has J2 "NOT sent by these scripts" "J2 note shown"; out_has J2 "cron-send-reminders.sh" "J2 note names the file"; [ -e "$FAKE/cron-send-reminders.sh" ] && ! grep -q "edited here" "$FAKE/cron-send-reminders.sh" && ok "J2 not sent (as before)" || bad "J2 cron script reached the server"
reset_env; echo "# edited here" >> "$HUB/cron-send-reminders.sh"; commit_all cron; change
r=$(run_deploy J3 deploy-feature-to-sally.sh security-deposit --yes </dev/null); expect_rc "J3 feature script naming another folder -> no cron note (not in its scope)" 0 "$r"; out_lacks J3 "NOT sent by these scripts" "J3 scoped to the named paths"
reset_env; rm -f "$FAKE/cron-send-reminders.sh"; r=$(run_deploy J4 deploy-to-sally.sh --yes </dev/null); expect_rc "J4 tracked cron script missing on Sally -> still fine" 0 "$r"; out_has J4 "cron-send-reminders.sh" "J4 reported as differing (missing on Sally)"
fi

if want K; then
echo; echo "##### FIX K (minor): a pipe/socket in the folder gives a readable message"
reset_env; mkfifo "$HUB/security-deposit/zz-fifo"; change
r=$(run_deploy K1 deploy-feature-to-sally.sh security-deposit --yes </dev/null); expect_rc "K1 named pipe -> fail closed" 3 "$r"; out_has K1 "a pipe, socket or similar" "K1 plain-English reason"; srv_is_old && ok "K1 Sally untouched" || bad "K1 Sally changed"
fi

if want L; then
echo; echo "##### FIX L (minor): Sally's file contents are not left in the temp folder while the script waits for an answer"
mkdir -p "$T/tmp"
tmp_probe() {   # run a deploy in a terminal, and at the y/N question list any fetched Sally copies lying in the temp folder
  rm -rf "$T/tmp"; mkdir -p "$T/tmp"; : > "$T/tmp-listing.txt"
  ANSWERS=("Proceed with this deploy? [y/N]=>@@ls -d $T/tmp/hub-deploy.* >> $T/tmp-listing.txt 2>&1; find $T/tmp -type d -name 'sally-*' >> $T/tmp-listing.txt 2>&1@@n")
  TMPDIR="$T/tmp" run_deploy_tty "$1" deploy-to-sally.sh --delete-on-server --allow-lose-unrecorded-files >/dev/null
}
# control: the OLD helper (before this fix) really does leave the copies lying around, so this probe can see them
reset_env; cp "$TEST_DIR/fixtures/deploy-guard-lib.sh.before-fixes" "$HUB/deploy-guard-lib.sh"; commit_all "old lib"; printf 'SECRET-LOOKING TEXT\n' > "$FAKE/docs-scratch.md"; change
tmp_probe L0
grep -q 'hub-deploy\.' "$T/tmp-listing.txt" && grep -q 'sally-' "$T/tmp-listing.txt" && ok "L0 control: the old helper leaves Sally's copies in the temp folder while waiting (probe works)" || { bad "L0 control: probe saw nothing"; cat "$T/tmp-listing.txt"; }
reset_env; printf 'SECRET-LOOKING TEXT\n' > "$FAKE/docs-scratch.md"; change
tmp_probe L1
grep -q 'hub-deploy\.' "$T/tmp-listing.txt" && ok "L1 the work folder exists while waiting (probe looked in the right place)" || bad "L1 probe saw no work folder"
grep -q 'sally-' "$T/tmp-listing.txt" && { bad "L1 Sally's copies are still lying in the temp folder"; cat "$T/tmp-listing.txt"; } || ok "L1 no fetched Sally copies left while waiting at the question"
[ -z "$(ls -A "$T/tmp" 2>/dev/null)" ] && ok "L2 temp folder is empty again after the script ended" || bad "L2 something was left in the temp folder: $(ls -A "$T/tmp")"
fi

if want M; then
echo; echo "##### INDEPENDENT RE-CHECK: TARS's exact repros in a tiny scratch repo (no other branches or remotes mixed in)"
SC="$T/scratch"
reset_scratch() {
  rm -rf "$SC"; mkdir -p "$SC/projects/hub/lib" "$SC/fake"
  cp "$SRC_HUB/deploy-to-sally.sh" "$SRC_HUB/deploy-feature-to-sally.sh" "$SRC_HUB/deploy-guard-lib.sh" "$SC/projects/hub/"
  printf 'module.exports=1;' > "$SC/projects/hub/lib/a.js"
  git -C "$SC" init -q -b main; git -C "$SC" -c user.name=t -c user.email=t@t add -A; git -C "$SC" -c user.name=t -c user.email=t@t commit -q -m base
  rsync -a --exclude .git "$SC/projects/hub/" "$SC/fake/"
}
sg() { git -C "$SC" -c user.name=t -c user.email=t@t "$@"; }
srun() { local n="$1" sc="$2"; shift 2; export SHIM_LOG="$LOGS/$n.shim.log"; : > "$SHIM_LOG"
  ( cd "$SC" && PATH="$SHIMS:$PATH" FAKE_SERVER_DIR="$SC/fake" bash "projects/hub/$sc" "$@" ) > "$LOGS/$n.out" 2>&1 </dev/null; echo "[$n] exit=$?"; }
stty_run() { local n="$1" sc="$2"; shift 2; export SHIM_LOG="$LOGS/$n.shim.log"; : > "$SHIM_LOG"
  ( cd "$SC" && PATH="$SHIMS:$PATH" FAKE_SERVER_DIR="$SC/fake" python3 "$TEST_DIR/ptyrun.py" "${ANSWERS[@]}" -- bash "projects/hub/$sc" "$@" ) > "$LOGS/$n.out" 2>&1; echo "[$n] exit=$? (real terminal)"; }
# repro 2 (blocker, other branch)
reset_scratch; sg checkout -q -b other; printf 'NEWER committed on other branch' > "$SC/projects/hub/lib/a.js"; sg commit -qam other; sg checkout -q -; printf 'module.exports=2;' > "$SC/projects/hub/lib/a.js"; sg commit -qam mainline
printf 'NEWER committed on other branch' > "$SC/fake/lib/a.js"
r=$(srun M2 deploy-to-sally.sh --yes); expect_rc "M2 TARS repro: Sally copy only on another branch -> now STOPS" 2 "$r"
[ "$(cat "$SC/fake/lib/a.js")" = "NEWER committed on other branch" ] && ok "M2 Sally's newer copy was NOT replaced" || bad "M2 Sally's copy was replaced"
out_has M2 "only on another branch (other)" "M2 stop names the branch"
# repro 3 (blocker, echo options): uncommitted -n
reset_scratch; printf 'module.exports=3;' > "$SC/projects/hub/lib/a.js"; sg commit -qam change; printf 'x\n' > "$SC/projects/hub/-n"
r=$(srun M3 deploy-to-sally.sh --yes); expect_rc "M3 TARS repro: uncommitted file named -n -> now STOPS" 2 "$r"; [ -e "$SC/fake/-n" ] && bad "M3 -n was sent" || ok "M3 -n was not sent"
r=$(srun M3b deploy-feature-to-sally.sh ./-n lib/a.js --yes); expect_rc "M3b feature script ./-n -> STOPS" 2 "$r"
# repro 3 delete mode
reset_scratch; printf 'recorded\n' > "$SC/projects/hub/rec.md"; sg add -A; sg commit -qm rec; sg rm -q projects/hub/rec.md; sg commit -qm rmrec
printf 'recorded\n' > "$SC/fake/rec.md"; printf 'PRECIOUS\n' > "$SC/fake/-n"
ANSWERS=("Proceed with this deploy? [y/N]=>y" "Type DELETE:=>DELETE"); r=$(stty_run M3c deploy-to-sally.sh --delete-on-server); expect_rc "M3c TARS repro: delete mode with unrecorded -n -> now STOPS" 2 "$r"
[ -f "$SC/fake/-n" ] && [ -f "$SC/fake/rec.md" ] && ok "M3c both files survived" || bad "M3c a file was deleted"
# repro 1/4 (new folder)
reset_scratch; mkdir -p "$SC/projects/hub/zz-tars-newdir"; echo 'x=1' > "$SC/projects/hub/zz-tars-newdir/f.js"; sg add -A; sg commit -qm newdir
export SHIM_LOG="$LOGS/M1.shim.log"; : > "$SHIM_LOG"; r=$( (cd "$SC" && echo n | PATH="$SHIMS:$PATH" FAKE_SERVER_DIR="$SC/fake" bash projects/hub/deploy-feature-to-sally.sh zz-tars-newdir) > "$LOGS/M1.out" 2>&1; echo "[M1] exit=$?")
expect_rc "M1 TARS repro: brand-new folder, answer n -> reaches the question" 1 "$r"; out_lacks M1 "COULD NOT VERIFY" "M1 no fail-closed message"
fi

if want N; then
echo; echo "##### NOT FIXED (documented limit): an edit on Sally in the gap between the final re-check and the copy"
reset_env; change
r=$(runx N1 "SHIM_BEFORE_REAL_RSYNC=echo '// edited on Sally in the gap' >> '$FAKE/security-deposit/router.js'" deploy-to-sally.sh --yes)
grep -q 'HOOK   before real rsync' "$LOGS/N1.shim.log" && ok "N1 the hook really ran right before the real copy" || bad "N1 hook did not run"
grep -q "edited on Sally in the gap" "$FAKE/security-deposit/router.js" && echo "        (still true: the gap edit survived)" || echo "        (CONFIRMED known limit: the gap edit was overwritten; deploy exit: $(rc_of "$r"))"
ok "N1 race window re-demonstrated and documented in the helper's header (not fixed on purpose: see report)"
fi

if want O; then
echo; echo "##### FOUND BY RALPH'S RE-RUN: CDPATH, the extra safety call, and honest advice after a failed npm/restart"
reset_env; change
export SHIM_LOG="$LOGS/O1.shim.log"; : > "$SHIM_LOG"
r=$( (cd "$REPO/projects" && CDPATH="$WORK:$REPO:$REPO/projects" PATH="$SHIMS:$PATH" FAKE_SERVER_DIR="$FAKE" bash hub/deploy-to-sally.sh --yes) > "$LOGS/O1.out" 2>&1 </dev/null; echo "[O1] exit=$?")
expect_rc "O1 relative script path with CDPATH set works" 0 "$r"; srv_is_new && ok "O1 deployed" || bad "O1 not deployed"
# every rsync call failing, one at a time: the deploy must stop before anything is sent (or, for the real copy, report the failure)
for n in 1 2 3 4 5; do
  reset_env; change; rm -f "$LOGS/O2-$n.shim.log.nth"
  r=$(runx O2-$n "SHIM_FAIL_RSYNC_NTH=$n" deploy-to-sally.sh --yes); expect_rc "O2 rsync call #$n fails -> fail closed" 3 "$r"; srv_is_old && ok "O2 call #$n: Sally untouched" || bad "O2 call #$n: Sally changed"
done
grep -q "INJECTED-FAILURE rsync call #3: -lpz -8 --checksum" "$LOGS/O2-3.shim.log" && ok "O2 call #3 is the never-sent-files comparison (the new call), and it fails closed" || bad "O2 call #3 is not the comparison: $(grep INJECTED "$LOGS/O2-3.shim.log")"
out_has O2-3 "could not compare the never-sent tracked files" "O2 plain-English reason for call #3"
reset_env; change; rm -f "$LOGS/O2-6.shim.log.nth"
r=$(runx O2-6 "SHIM_FAIL_RSYNC_NTH=6" deploy-to-sally.sh --yes); [ "$(rc_of "$r")" != 0 ] && ok "O2 call #6 (the real copy) fails -> non-zero" || bad "O2 call #6 returned 0"
grep -q "SIMULATED" "$LOGS/O2-6.shim.log" && bad "O2 npm/pm2 ran after a failed copy" || ok "O2 npm/pm2 did not run after a failed copy"
# the advice after a failure that comes AFTER the copy must not promise a re-run will finish the job
reset_env; change; r=$(runx O3a "SHIM_FAIL=ssh-npm" deploy-to-sally.sh --yes); [ "$(rc_of "$r")" != 0 ] && ok "O3 npm failure is non-zero" || bad "O3 npm failure returned 0"
out_has O3a "will NOT retry npm install" "O3 npm failure: says a re-run will not retry it"; out_has O3a "npm install --omit=dev" "O3 npm failure: names the command Jarvis should run"; out_has O3a "pm2 restart hub --update-env" "O3 npm failure: names the restart too"
out_lacks O3a "It is safe to run the same command again" "O3 npm failure: no misleading 'safe to run again'"
reset_env; change; r=$(runx O3b "SHIM_FAIL=ssh-pm2" deploy-to-sally.sh --yes); out_has O3b "will NOT retry the restart" "O3 restart failure (full): says a re-run will not retry it"
reset_env; change; r=$(runx O3c "SHIM_FAIL=ssh-pm2" deploy-feature-to-sally.sh security-deposit --yes); out_has O3c "will NOT retry the restart" "O3 restart failure (feature): says a re-run will not retry it"
reset_env; change; r=$(runx O3d "SHIM_FAIL=rsync-send" deploy-to-sally.sh --yes); out_has O3d "It is safe to run the same command again" "O3 failed COPY still says re-running is safe (true for the copy)"
fi

echo; echo "RESULT: $PASS passed, $FAIL failed"
echo "BLOCKED lines in this suite's shim logs: $(cat $LOGS/A*.shim.log $LOGS/B?.shim.log $LOGS/C*.shim.log $LOGS/D*.shim.log $LOGS/E*.shim.log $LOGS/F*.shim.log $LOGS/G*.shim.log $LOGS/H*.shim.log $LOGS/I*.shim.log $LOGS/J*.shim.log $LOGS/K*.shim.log $LOGS/L*.shim.log $LOGS/M*.shim.log $LOGS/N*.shim.log $LOGS/O*.shim.log 2>/dev/null | grep -c BLOCKED)"
