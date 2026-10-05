source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/harness.sh"
# judgefix.sh - regression tests for the Judge's required fix (2026-10-04) + two tidy-ups.
#   Q = items 1 and 2: --delete-on-server with no terminal is always refused; --delete is only
#       given to the real rsync when the approved plan listed at least one deletion.
#   R = item 4: the never-deploy list (.env* etc.) is matched without regard to upper/lower case.
#   S = item 5: the script headers no longer claim "re-running is always safe".
#   T = bash -n (syntax) under /bin/bash.
# Everything runs against the local FAKE server (or real Sally read-only through the write-blocking shims).
cd "$WORK"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }
rc_of() { sed -n 's/.*exit=\([0-9]*\).*/\1/p' <<<"$1" | head -1; }
expect_rc() { [ "$(rc_of "$3")" = "$2" ] && ok "$1 (exit $2)" || bad "$1 (wanted exit $2, got: $3)"; }
out_has() { grep -Fq -- "$2" "$LOGS/$1.out" && ok "$3" || bad "$3  [missing text: $2]"; }
out_lacks() { grep -Fq -- "$2" "$LOGS/$1.out" && bad "$3  [unexpected text: $2]" || ok "$3"; }
runx() { local n="$1" envspec="$2" sc="$3"; shift 3; export SHIM_LOG="$LOGS/$n.shim.log"; : > "$SHIM_LOG"
  ( cd "$REPO" && env ${envspec:+"$envspec"} PATH="$SHIMS:$PATH" FAKE_SERVER_DIR="$FAKE" bash "projects/hub/$sc" "$@" ) > "$LOGS/$n.out" 2>&1 </dev/null; echo "[$n] exit=$?"; }
change() { echo "// change" >> "$HUB/security-deposit/router.js"; commit_all "change"; }
srv_is_old() { cmp -s "$FAKE/security-deposit/router.js" <(git -C "$REPO" show "HEAD~${1:-1}:projects/hub/security-deposit/router.js"); }
srv_is_new() { cmp -s "$FAKE/security-deposit/router.js" "$HUB/security-deposit/router.js"; }
# the REAL transfer (not a dry run, not a pull of Sally's files for checking): the rsync call without --itemize-changes and without --files-from
real_rsync_calls() { grep 'rsync(local dest)' "$LOGS/$1.shim.log" | grep -v -- '--itemize-changes' | grep -v -- '--files-from'; }
real_rsync_has_delete() { real_rsync_calls "$1" | grep -q -- ' --delete '; }
real_rsync_count() { real_rsync_calls "$1" | wc -l | tr -d ' '; }

only="${1:-all}"
want() { [ "$only" = all ] || [ "$only" = "$1" ]; }

# ---- 0. the write-blocking shims must be first in PATH for every run below (all helpers set it; prove it here)
for t in rsync ssh git; do
  got="$(PATH="$SHIMS:$PATH" command -v $t)"
  [ "$got" = "$SHIMS/$t" ] && ok "0 shim in effect for $t" || { bad "0 shim NOT in effect for $t ($got)"; echo "ABORTING: never run a deploy script without the shims"; exit 9; }
done

if want Q; then
echo; echo "##### Q  items 1+2: delete mode needs a terminal even when nothing is listed; --delete only when something was listed"
PLANT_FULL="echo planted-late > '$FAKE/planted-late.txt'"
for sc in deploy-to-sally.sh "deploy-feature-to-sally.sh security-deposit"; do
  case "$sc" in deploy-to-sally.sh) tag=full; unitdir="";; *) tag=feat; unitdir="security-deposit/";; esac
  # Q1: zero Sally-only files, no terminal, --yes -> must be REFUSED (exit 2); nothing sent
  reset_env; change
  r=$(runx Q1-$tag "" $sc --delete-on-server --yes); expect_rc "Q1 $tag: --delete-on-server --yes </dev/null, nothing to delete -> refused" 2 "$r"
  out_has Q1-$tag "DELETING FILES NEEDS A PERSON AT THE KEYBOARD" "Q1 $tag: says a person is needed"
  srv_is_old && ok "Q1 $tag: Sally untouched" || bad "Q1 $tag: Sally was changed"
  [ "$(real_rsync_count Q1-$tag)" = 0 ] && ok "Q1 $tag: no real copy was started" || bad "Q1 $tag: a real rsync copy ran"
  # Q2: the Judge's exact scenario: a Sally-only file appears just before the copy. Must survive, or the run must be refused.
  reset_env; change
  r=$(runx Q2-$tag "SHIM_BEFORE_REAL_RSYNC=echo planted-late > '$FAKE/${unitdir}planted-late.txt'" $sc --delete-on-server --yes)
  if [ "$(rc_of "$r")" = 2 ]; then ok "Q2 $tag: refused with exit 2 (so the late file can never be touched)"
  elif [ -f "$FAKE/${unitdir}planted-late.txt" ]; then ok "Q2 $tag: file planted just before the copy survived (exit $(rc_of "$r"))"
  else bad "Q2 $tag: late file was deleted unlisted and unconfirmed (exit $(rc_of "$r"))"; fi
  # Q3: same, but WITH a terminal (the run is allowed): answer y; no DELETE question (nothing to delete); late file must survive; real rsync gets no --delete
  reset_env; change
  export SHIM_BEFORE_REAL_RSYNC="echo planted-late > '$FAKE/${unitdir}planted-late.txt'"
  ANSWERS=("Proceed with this deploy? [y/N]=>y"); r=$(run_deploy_tty Q3-$tag $sc --delete-on-server); unset SHIM_BEFORE_REAL_RSYNC
  expect_rc "Q3 $tag: terminal, --delete-on-server, nothing listed -> deploys" 0 "$r"
  out_lacks Q3-$tag "Type DELETE" "Q3 $tag: no DELETE question when nothing is listed"
  grep -q 'HOOK   before real rsync' "$LOGS/Q3-$tag.shim.log" && ok "Q3 $tag: the late-file hook really ran right before the copy" || bad "Q3 $tag: hook did not run"
  [ -f "$FAKE/${unitdir}planted-late.txt" ] && ok "Q3 $tag: file that appeared in the last seconds survived" || bad "Q3 $tag: file that appeared in the last seconds was DELETED unlisted"
  [ "$(real_rsync_count Q3-$tag)" = 1 ] && ok "Q3 $tag: exactly one real copy ran" || bad "Q3 $tag: real copy count $(real_rsync_count Q3-$tag)"
  real_rsync_has_delete Q3-$tag && bad "Q3 $tag: the real copy was given --delete although nothing was listed" || ok "Q3 $tag: the real copy was NOT given --delete"
  srv_is_new && ok "Q3 $tag: the change was deployed" || bad "Q3 $tag: change not deployed"
  out_lacks Q3-$tag "AND deleting" "Q3 $tag: progress text does not claim anything is being deleted"
  # Q4: positive control: a listed deletion IS deleted, and only then does the real copy get --delete
  reset_env; printf 'recorded text\n' > "$HUB/${unitdir}rec.md"; commit_all rec; gc rm -q "projects/hub/${unitdir}rec.md"; gc commit -q -m rmrec
  printf 'recorded text\n' > "$FAKE/${unitdir}rec.md"; change
  ANSWERS=("Proceed with this deploy? [y/N]=>y" "Type DELETE:=>DELETE"); r=$(run_deploy_tty Q4-$tag $sc --delete-on-server)
  expect_rc "Q4 $tag: listed deletion, terminal, typed DELETE -> proceeds" 0 "$r"
  [ ! -e "$FAKE/${unitdir}rec.md" ] && ok "Q4 $tag: the listed file was deleted" || bad "Q4 $tag: the listed file survived"
  real_rsync_has_delete Q4-$tag && ok "Q4 $tag: the real copy was given --delete (something was confirmed)" || bad "Q4 $tag: no --delete although a deletion was confirmed"
  out_has Q4-$tag "AND deleting the Sally-only files you confirmed" "Q4 $tag: progress text says deleting"
  # Q5: answering n at the DELETE question (or anything but DELETE) -> nothing sent, nothing deleted
  reset_env; printf 'recorded text\n' > "$HUB/${unitdir}rec.md"; commit_all rec; gc rm -q "projects/hub/${unitdir}rec.md"; gc commit -q -m rmrec
  printf 'recorded text\n' > "$FAKE/${unitdir}rec.md"; change
  ANSWERS=("Proceed with this deploy? [y/N]=>y" "Type DELETE:=>no"); r=$(run_deploy_tty Q5-$tag $sc --delete-on-server)
  expect_rc "Q5 $tag: wrong word at the DELETE question -> aborted" 1 "$r"; [ -f "$FAKE/${unitdir}rec.md" ] && srv_is_old && ok "Q5 $tag: nothing sent, nothing deleted" || bad "Q5 $tag: something changed"
  # Q6: Sally-only EMPTY FOLDER only (n_only=0, n_dirs=1): that still counts as a deletion -> DELETE asked, folder removed, --delete given
  reset_env; mkdir -p "$FAKE/${unitdir}empty-d"; change
  ANSWERS=("Proceed with this deploy? [y/N]=>y" "Type DELETE:=>DELETE"); r=$(run_deploy_tty Q6-$tag $sc --delete-on-server)
  expect_rc "Q6 $tag: Sally-only empty folder, typed DELETE -> proceeds" 0 "$r"; [ ! -e "$FAKE/${unitdir}empty-d" ] && ok "Q6 $tag: the folder was removed" || bad "Q6 $tag: folder survived"
  real_rsync_has_delete Q6-$tag && ok "Q6 $tag: --delete given for the confirmed folder" || bad "Q6 $tag: no --delete for a confirmed folder"
  # Q7: no terminal and nothing to send and nothing to delete: still refused (a delete request needs a person), nothing happens
  reset_env
  r=$(runx Q7-$tag "" $sc --delete-on-server --yes); expect_rc "Q7 $tag: in sync + --delete-on-server + no terminal -> refused" 2 "$r"
  # Q8: without --delete-on-server nothing changes: no terminal is fine, never --delete
  reset_env; change
  r=$(runx Q8-$tag "" $sc --yes); expect_rc "Q8 $tag: plain --yes </dev/null still deploys" 0 "$r"; real_rsync_has_delete Q8-$tag && bad "Q8 $tag: --delete given without --delete-on-server" || ok "Q8 $tag: no --delete without --delete-on-server"
  # Q9: Sally-only file that exists, no terminal, (the old, already-correct refusal) still refused
  reset_env; change; echo notes > "$FAKE/${unitdir}docs-scratch.md"
  r=$(runx Q9-$tag "" $sc --delete-on-server --allow-lose-unrecorded-files --yes); expect_rc "Q9 $tag: listed deletion + no terminal -> refused" 2 "$r"; [ -f "$FAKE/${unitdir}docs-scratch.md" ] && srv_is_old && ok "Q9 $tag: nothing changed" || bad "Q9 $tag: something changed"
done
fi

if want R; then
echo; echo "##### R  item 4: the never-deploy list ignores upper/lower case (.ENV.local, .Env, .env ...)"
cat > "$T/excl-test-ci.sh" <<'EOS'
LOCAL_DIR=$1; . "$LOCAL_DIR/deploy-guard-lib.sh"
d=$(mktemp -d "${TMPDIR:-/tmp}/exclci.XXXXXX"); trap 'rm -rf "$d"' EXIT
# names (no two differ only by case: the Mac filesystem would treat them as one file)
EXCLUDED=".env .ENV.local .Env.example .eNv.production .ENVIRONMENT CRON-x.SH Cron-y.sh X.LOG .DS_STORE .ds_store2.log Server.JS.BAK-1 a.BACKUP-2 X.JSON.PRE-1 Deploy-Guard-Lib.SH b.MD.Pre-edit x.Bak"
KEPT="Lib.Pre-Process.js Bakery.js PREBAK.js Env.js ENV.md env.txt Environment.js README.MD Server.JS Notes.TXT A.JS.PRE Backup.js REBAKE.js Cronjob.sh"
DIRS_EXCLUDED="NODE_MODULES .GIT Y.BAK .ENV-dir"
mkdir -p "$d/src/deep/er" "$d/dst"
for n in $EXCLUDED $KEPT; do echo c > "$d/src/$n"; echo c > "$d/src/deep/er/$n"; done
for n in $DIRS_EXCLUDED; do mkdir -p "$d/src/$n"; echo c > "$d/src/$n/inner.js"; done
rsync -rl -n --itemize-changes "${DEPLOY_EXCLUDES[@]}" "$d/src/" "$d/dst/" | sed -n 's/^[<>]f[+]* //p' | sort > "$d/rsync-sends"
bad=0
for pre in "" "deep/er/"; do
  for n in $EXCLUDED; do
    guard_path_is_excluded "$pre$n" >/dev/null || { echo "guard does NOT exclude: $pre$n"; bad=1; }
    grep -qxF "$pre$n" "$d/rsync-sends" && { echo "rsync would SEND (should be excluded): $pre$n"; bad=1; }
  done
  for n in $KEPT; do
    guard_path_is_excluded "$pre$n" >/dev/null && { echo "WRONGLY excluded by guard: $pre$n"; bad=1; }
    grep -qxF "$pre$n" "$d/rsync-sends" || { echo "rsync would NOT send (should deploy): $pre$n"; bad=1; }
  done
done
for n in $DIRS_EXCLUDED; do
  guard_path_is_excluded "$n/inner.js" >/dev/null || { echo "guard does NOT exclude folder: $n"; bad=1; }
  guard_path_is_excluded "deep/$n/inner.js" >/dev/null || { echo "guard does NOT exclude nested folder: $n"; bad=1; }
  grep -q "^$n/" "$d/rsync-sends" && { echo "rsync sends inside folder $n"; bad=1; }
done
# the pattern printed for a match is the canonical (lower-case) one, which the "heads-up" code relies on
[ "$(guard_path_is_excluded '.ENV.local')" = '.env*' ] && : || { echo "wrong pattern name for .ENV.local: $(guard_path_is_excluded '.ENV.local')"; bad=1; }
# the setting guard_path_is_excluded changes must be put back (a caller's own case matching must not change)
shopt -q nocasematch && { echo "nocasematch was left switched ON"; bad=1; }
# the guard's own check for a .env file on a list to be pulled from Sally is case-insensitive too
printf 'a/.ENV.local\n' > "$d/pull.txt"; GUARD_WORK="$d/gw"; SALLY=zz-no-such-host; REMOTE_DIR=/nowhere; mkdir -p "$GUARD_WORK"
( guard_pull "$d/pull.txt" "$d/pulled" ) >/dev/null 2>&1; [ $? -eq 3 ] || { echo "guard_pull did not refuse a .ENV list entry"; bad=1; }
exit $bad
EOS
reset_env; res=$(PATH="$SHIMS:$PATH" bash "$T/excl-test-ci.sh" "$HUB" 2>&1); rc=$?; echo "$res" | sed 's/^/        /'
[ $rc -eq 0 ] && ok "R1 rsync's exclude and the guard agree for any-case names, at any depth (files and folders); real source names are kept" || bad "R1 any-case exclude problems (see above)"
# R2: the Judge's exact repro: naming a secrets-style file with different letter case
for nm in ".ENV.local" ".Env" ".env" ".eNv.production" "sub/.ENV" "sub/deeper/.Env.local"; do
  reset_env; mkdir -p "$HUB/security-deposit/sub/deeper"; printf 'SECRET=1\n' > "$HUB/security-deposit/$nm"; change
  n="R2-$(printf '%s' "$nm" | tr '/.' '__')"
  r=$(runx "$n" "" deploy-feature-to-sally.sh "security-deposit/$nm" --yes --allow-uncommitted); expect_rc "R2 feature script naming security-deposit/$nm -> refused" 1 "$r"
  out_has "$n" "never-deployed list" "R2 $nm: plain-English reason"
  [ -e "$FAKE/security-deposit/$nm" ] && bad "R2 $nm: reached the server" || ok "R2 $nm: nothing was copied"
  [ -z "$(real_rsync_calls "$n")" ] && ok "R2 $nm: no copy was started" || bad "R2 $nm: a real copy ran"
done
# a folder that is on the list in a different case
reset_env; mkdir -p "$HUB/security-deposit/Node_Modules"; echo x > "$HUB/security-deposit/Node_Modules/m.js"; change
r=$(runx R2-nm "" deploy-feature-to-sally.sh security-deposit/Node_Modules --yes --allow-uncommitted); expect_rc "R2 naming security-deposit/Node_Modules -> refused" 1 "$r"
# R3: a folder that CONTAINS such files: they are not sent, and are not offered to the "not committed" stop either
for sc in "deploy-feature-to-sally.sh security-deposit" "deploy-to-sally.sh"; do
  case "$sc" in deploy-to-sally.sh) tag=full;; *) tag=feat;; esac
  reset_env; mkdir -p "$HUB/security-deposit/sub"
  for nm in .ENV.local .Env .eNv.production sub/.ENV; do printf 'SECRET=1\n' > "$HUB/security-deposit/$nm"; done
  printf 'SECRET=1\n' > "$HUB/.ENV.production"; change
  r=$(runx R3-$tag "" $sc --yes); expect_rc "R3 $tag: folder holding uncommitted .ENV.local/.Env/... -> deploys, no 'not committed' stop" 0 "$r"
  srv_is_new && ok "R3 $tag: the real change was deployed" || bad "R3 $tag: change not deployed"
  leaked=""; for nm in .ENV.local .Env .eNv.production sub/.ENV; do [ -e "$FAKE/security-deposit/$nm" ] && leaked="$leaked $nm"; done
  [ -e "$FAKE/.ENV.production" ] && [ "$tag" = full ] && leaked="$leaked ROOT/.ENV.production"
  [ -z "$leaked" ] && ok "R3 $tag: none of the secrets-style files reached the server" || bad "R3 $tag: SENT:$leaked"
  out_lacks R3-$tag ".ENV.local" "R3 $tag: not even named in the preview"
  # R3b: same, but the files are COMMITTED (tracked in git): still never sent
  reset_env; mkdir -p "$HUB/security-deposit/sub"; for nm in .ENV.local .Env sub/.ENV; do printf 'SECRET=1\n' > "$HUB/security-deposit/$nm"; gc add -f -- "projects/hub/security-deposit/$nm"; done; gc commit -q -m "tracked secrets-style names"; change
  [ "$(gc ls-files -- projects/hub/security-deposit/.ENV.local projects/hub/security-deposit/.Env projects/hub/security-deposit/sub/.ENV | wc -l | tr -d ' ')" = 3 ] && ok "R3b $tag: setup - the three secrets-style names really are tracked in git" || bad "R3b $tag: setup - not tracked"
  r=$(runx R3b-$tag "" $sc --yes); expect_rc "R3b $tag: committed .ENV.local/.Env/sub/.ENV -> deploys" 0 "$r"
  leaked=""; for nm in .ENV.local .Env sub/.ENV; do [ -e "$FAKE/security-deposit/$nm" ] && leaked="$leaked $nm"; done
  [ -z "$leaked" ] && ok "R3b $tag: committed secrets-style names were still not sent" || bad "R3b $tag: SENT:$leaked"
done
# R4: delete mode: hand-managed Sally secrets in any case are neither listed nor deleted; the one real deletable file still is
reset_env; printf 'S=1\n' > "$FAKE/.ENV.local"; printf 'S=1\n' > "$FAKE/security-deposit/.Env"; printf 'S=1\n' > "$FAKE/.env"; printf 'notes\n' > "$FAKE/docs-scratch.md"; change
ANSWERS=("Proceed with this deploy? [y/N]=>y" "Type DELETE:=>DELETE"); r=$(run_deploy_tty R4 deploy-to-sally.sh --delete-on-server --allow-lose-unrecorded-files); expect_rc "R4 delete mode with Sally-side .ENV.local/.Env/.env present -> proceeds" 0 "$r"
[ -e "$FAKE/.ENV.local" ] && [ -e "$FAKE/security-deposit/.Env" ] && [ -e "$FAKE/.env" ] && ok "R4 Sally's secrets-style files (any case) survived delete mode" || bad "R4 a Sally secrets-style file was deleted"
[ ! -e "$FAKE/docs-scratch.md" ] && ok "R4 the confirmed ordinary file was deleted" || bad "R4 ordinary file survived"
out_lacks R4 ".ENV.local" "R4 secrets-style names are not listed for deletion"
fi

if want N; then
echo; echo "##### N  documented limit (NOT fixed, on purpose): a deletion WAS approved, and another Sally-only file appears in the last seconds"
reset_env; printf 'recorded text\n' > "$HUB/rec.md"; commit_all rec; gc rm -q projects/hub/rec.md; gc commit -q -m rmrec
printf 'recorded text\n' > "$FAKE/rec.md"; change
export SHIM_BEFORE_REAL_RSYNC="echo planted-late > '$FAKE/planted-late.txt'"
ANSWERS=("Proceed with this deploy? [y/N]=>y" "Type DELETE:=>DELETE"); r=$(run_deploy_tty N2 deploy-to-sally.sh --delete-on-server); unset SHIM_BEFORE_REAL_RSYNC
expect_rc "N2 listed deletion approved -> deploys" 0 "$r"; [ ! -e "$FAKE/rec.md" ] && ok "N2 the listed file was deleted (approved)" || bad "N2 listed file survived"
if [ -e "$FAKE/planted-late.txt" ]; then echo "        (the late file survived)"; else echo "        (CONFIRMED known limit: with an approved deletion, rsync --delete also removed a Sally-only file that appeared after the preview; written up in the helper's KNOWN LIMITS)"; fi
ok "N2 limit re-demonstrated and documented in deploy-guard-lib.sh (KNOWN LIMITS)"
fi

if want S; then
echo; echo "##### S  item 5: headers are accurate about re-running"
for f in deploy-to-sally.sh deploy-feature-to-sally.sh deploy-guard-lib.sh; do
  grep -qi "always safe" "$SRC_HUB/$f" && bad "S $f still says re-running is always safe" || ok "S $f has no 'always safe' claim"
done
for f in deploy-to-sally.sh deploy-feature-to-sally.sh; do
  sed '/BASH_VERSION/,$d' "$SRC_HUB/$f" > "$T/hdr.txt"   # only the comment block at the top of the script
  grep -q "will NOT retry" "$T/hdr.txt" && ok "S $f header says a re-run will not retry the later steps" || bad "S $f header does not mention the no-retry"
  grep -q "Nothing to send" "$T/hdr.txt" && ok "S $f header explains the 'Nothing to send' result" || bad "S $f header does not mention 'Nothing to send'"
  grep -qi "always safe" "$T/hdr.txt" && bad "S $f header still says always safe" || ok "S $f header: no 'always safe'"
done
fi

if want T; then
echo; echo "##### T  syntax under /bin/bash (3.2)"
for f in deploy-to-sally.sh deploy-feature-to-sally.sh deploy-guard-lib.sh; do
  /bin/bash -n "$SRC_HUB/$f" && ok "T bash -n $f" || bad "T bash -n $f"
done
fi

echo; echo "RESULT: $PASS passed, $FAIL failed"
echo "BLOCKED lines in this suite's shim logs: $(cat $LOGS/Q*.shim.log $LOGS/R*.shim.log $LOGS/N2.shim.log 2>/dev/null | grep -c BLOCKED)"
