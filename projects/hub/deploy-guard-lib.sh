#!/bin/bash
# deploy-guard-lib.sh
#
# Shared safety checks for the two Hub deploy scripts:
#   - deploy-to-sally.sh          (whole Hub)
#   - deploy-feature-to-sally.sh  (only the paths you name)
# This file is "sourced" (loaded) by those two scripts. It is not run on its
# own. Both scripts load this same file, so they can never drift apart.
#
# THIS FILE IS EXCLUDED FROM THE DEPLOY (see DEPLOY_EXCLUDE_PATTERNS below). It
# is a tool that runs on your computer, so it is never copied to Sally.
#
# WHAT THE SAFETY CHECKS DO (all of them run BEFORE anything is sent):
#
#   1. NO DELETING BY DEFAULT. A deploy only adds and updates files. Files
#      that exist only on Sally are left alone. Deleting needs the explicit
#      flag --delete-on-server, and then:
#        - every file that would be deleted is listed, marked either
#          "NOT IN GIT - would be lost permanently" or "recorded in git
#          (commit X)";
#        - deleting a file git has never recorded is refused unless you ALSO
#          add --allow-lose-unrecorded-files;
#        - you must type the word DELETE. --yes does NOT answer this question,
#          and with no terminal attached (a script, a pipe) the delete request is
#          refused - even when the preview lists nothing to delete;
#        - the copy is only given rsync's --delete if the preview you approved
#          listed at least one deletion. If it listed none, the copy runs
#          WITHOUT --delete, so a file that shows up on Sally in the last
#          seconds before the copy can never be removed unlisted.
#
#   2. PREVIEW, THEN ASK. It shows exactly which files would be added and
#      which would be overwritten (and deleted, if you asked), then asks
#      y/N. --yes skips only that y/N question, never the checks below.
#      Files are compared by CONTENT (checksum), so a file whose only
#      difference is its timestamp is not treated as a change.
#
#   3. DON'T OVERWRITE NEWER WORK. For everything the deploy would overwrite
#      or replace on Sally:
#        (a) Sally's current copy must be a version that is in the git history
#            of the commit you are deploying from. If not, the deploy STOPS:
#            "Sally has changes git doesn't know about" (someone edited it on
#            Sally and nobody saved it - or it was saved only on ANOTHER
#            branch, which this deploy would silently replace with older code;
#            the stop says which branch).
#            This includes a Sally file, link or folder that sits where your
#            deploy needs a different kind of thing (a file where you have a
#            folder, a link where you have a file) - rsync would quietly
#            remove it to make room, so these are checked too.
#            Override: --allow-unrecorded-server-changes
#        (b) your local copy must be committed to git. If a file you are
#            about to send is edited-but-uncommitted, or brand new and never
#            committed, the deploy STOPS.
#            Override: --allow-uncommitted
#      Both stops apply even with --yes. An override flag prints a loud
#      warning and the y/N question is still asked (unless --yes is also
#      given).
#
#   4. FAILS CLOSED. If ssh, rsync or git cannot finish a check, the deploy
#      is cancelled before anything is sent, with a plain-English reason.
#
#   5. NOTHING CHANGES BETWEEN "YES" AND "SEND". After you say yes, every
#      check is run a second time and compared with what you approved
#      (including which git commit your files are at). If anything moved (a
#      file was edited here or on Sally, or git's commit changed, while you
#      were deciding), it cancels instead of sending.
#
# EXIT CODES: 0 = done (or nothing to do); 1 = you said no / bad arguments;
#             2 = a safety check stopped the deploy; 3 = a check could not be
#             completed (fail closed).
#
# HOW "RECORDED IN GIT" IS DECIDED: the content of Sally's copy is hashed the
# way git hashes files (git hash-object, no line-ending conversion) and
# looked up in the list of every file version in the history of the commit you
# are deploying from (git rev-list --objects HEAD). A version that only exists
# on another branch, in an uncommitted state, or in the stash does NOT count
# for overwriting - overwriting it would replace newer work with older code.
# The one exception is the label in --delete-on-server mode: there, a file that
# exists on ANY branch or tag (git rev-list --objects --all, ignoring the stash)
# is called "recorded in git" (with "but only on another branch" spelled out),
# because it can still be recovered from git.
# "COMMITTED" for your local files means: byte-for-byte the same as the copy
# in the current commit (HEAD).
#
# HOW COLLISIONS ARE FOUND: besides rsync's own dry run, each deploy asks Sally
# (read-only, one `find`) what is already there, so a Sally file/link/folder
# sitting at a spot where the deploy would put something of a different kind
# is caught even though rsync labels it just "new".
#
# KNOWN LIMITS (on purpose, listed so nobody is surprised):
#   - There is a window of a second or two between the final re-check and the
#     actual copy. Something edited on Sally in exactly that window would still
#     be overwritten. (Ideas for later: send only the approved list, and/or keep
#     a backup copy of everything that is overwritten or deleted.)
#   - Same window, with --delete-on-server: when the approved preview listed at least
#     one deletion, the copy runs with rsync's --delete, which removes EVERY Sally-only
#     file it finds at that moment. A Sally-only file that appears in that same second
#     or two would be removed too, without having been listed. (When the preview listed
#     no deletion at all, the copy runs without --delete and this cannot happen.)
#   - "Needs a person at the keyboard" for DELETE only means "standard input is a
#     terminal". Whoever runs the script must hand the keyboard to Peter; nothing
#     here can tell a person from a program that is driving a terminal.
#   - Copies of Sally's files (the ones that would be overwritten or deleted) are
#     fetched into a private temp folder (only you can read it) just long enough
#     to be fingerprinted, then removed again - that is a few seconds, not the
#     whole time the script waits for your answer. The rest of the work folder is
#     removed when the script ends or is interrupted (Ctrl-C); if the script is
#     killed hard, only small lists and fingerprints are left behind.
#   - Special files (pipes, sockets) and file names with a backslash, tab,
#     newline or leading space make the deploy fail closed (exit 3); rename or
#     remove them first.
#
# Written for bash 3.2 (the macOS default): no associative arrays, no mapfile.

# ---------------------------------------------------------------------------
# Settings shared by both scripts
# ---------------------------------------------------------------------------

# Never sent to Sally and never deleted from Sally (rsync protects excluded
# names from deletion on the receiving side). A name matches if ANY folder or
# file name in its path matches one of these. UPPER/lower CASE DOES NOT MATTER: the
# Mac's file system treats .env.local and .ENV.local as the same name, so ".ENV.local",
# ".Env" and ".env" are all secrets files here (see guard_nocase_pattern below and
# guard_path_is_excluded).
#   node_modules    rebuilt on Sally by npm install
#   .env*           secrets - managed by hand on Sally (.env, .env.local ...)
#   .git            git's own data
#   cron-*.sh       wrapper scripts edited on Sally by hand (2026-09-01
#                   incident; see deploy-to-sally.sh). NOTE: this also means
#                   edits to the cron-*.sh files tracked in git NEVER reach
#                   Sally through these scripts.
#   *.bak*  *.backup*  and  *.*.pre-*
#                   rollback copies such as server.js.bak-20261001153325,
#                   server.js.backup-1, foo.bak~ and
#                   server.js.pre-rental-analysis-restore.bak. "*.*.pre-*" means
#                   "a file name that already has an extension, with .pre-something
#                   added" (server.js.pre-x, x.json.pre-1), so a real source file such
#                   as lib.pre-process.js or bakery.js is not skipped by mistake.
#   deploy-guard-lib.sh  this file (it runs on your computer, not on Sally)
DEPLOY_EXCLUDE_PATTERNS=(
  'node_modules'
  '.env*'
  '.git'
  '.DS_Store'
  '*.log'
  'cron-*.sh'
  '*.bak*'
  '*.backup*'
  '*.*.pre-*'
  'deploy-guard-lib.sh'
)

# rsync's --exclude matching is case-sensitive, so each pattern is handed to rsync with
# every letter written as a two-letter choice: ".env*" becomes ".[eE][nN][vV]*" (matches
# .env, .ENV.local, .Env ...). Digits, dots, dashes, underscores and * stay as they are.
guard_nocase_pattern() {
  local pat="$1" lower upper out="" i=0 l u
  lower="$(printf '%s' "$pat" | LC_ALL=C tr 'A-Z' 'a-z')"
  upper="$(printf '%s' "$pat" | LC_ALL=C tr 'a-z' 'A-Z')"
  while [ "$i" -lt "${#pat}" ]; do
    l="${lower:$i:1}"
    u="${upper:$i:1}"
    if [ "$l" = "$u" ]; then out="$out$l"; else out="$out[$l$u]"; fi
    i=$((i + 1))
  done
  printf '%s' "$out"
}

DEPLOY_EXCLUDES=()
for _guard_pat in "${DEPLOY_EXCLUDE_PATTERNS[@]}"; do
  DEPLOY_EXCLUDES+=(--exclude "$(guard_nocase_pattern "$_guard_pat")")
done
unset _guard_pat

# -r folders, -l symlinks, -p permissions, -z compress, --checksum compare by
# content, -8 print accented file names as they are. Deliberately NOT -t
# (times), -o (owner), -g (group): files whose content is the same are not
# touched at all, and the Mac's user/group names are not stamped onto Sally's
# files. --timeout: give up (instead of hanging) if the connection goes quiet.
GUARD_RSYNC_OPTS=(-rlpz -8 --checksum --no-owner --no-group --timeout=120)

# ssh: never ask for a password, and notice a dead connection instead of hanging.
GUARD_SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)

# Treat every file name as plain bytes. Without this, macOS's tr/awk/grep can
# stumble on an odd (non-UTF-8) file name and silently drop it from a check.
# This is for commands on THIS computer only: ssh would otherwise forward it to
# Sally, and "pm2 restart --update-env" would copy it into the Hub's own
# environment. guard_ssh and guard_rsync below therefore remove it.
export LC_ALL=C

OPT_YES=false
OPT_DELETE=false
OPT_LOSE_UNRECORDED=false
OPT_ALLOW_UNRECORDED_SERVER=false
OPT_ALLOW_UNCOMMITTED=false

# Set to true by guard_decide ONLY when the plan the person approved listed at least
# one deletion and they typed DELETE. guard_transfer gives rsync --delete only then.
GUARD_DELETE_CONFIRMED=false

UNIT_PATHS=()      # what to deploy: (.) for the whole Hub, or the named paths
GUARD_WORK=""      # private temp folder, removed when the script ends
GUARD_TAB="$(printf '\t')"

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

# Flags shared by both scripts. Returns 0 if $1 was one of them.
guard_parse_flag() {
  case "$1" in
    --yes)                             OPT_YES=true ;;
    --delete-on-server)                OPT_DELETE=true ;;
    --allow-lose-unrecorded-files)     OPT_LOSE_UNRECORDED=true ;;
    --allow-unrecorded-server-changes) OPT_ALLOW_UNRECORDED_SERVER=true ;;
    --allow-uncommitted)               OPT_ALLOW_UNCOMMITTED=true ;;
    *) return 1 ;;
  esac
  return 0
}

guard_flags_help() {
  echo "  Safety flags:"
  echo "    --yes                              Skip the final y/N question only. Never skips a safety stop."
  echo "    --delete-on-server                 Also delete files that exist only on Sally (off by default)."
  echo "    --allow-lose-unrecorded-files      With --delete-on-server: allow deleting files git has never recorded."
  echo "    --allow-unrecorded-server-changes  Allow overwriting a Sally file that has changes git doesn't know about."
  echo "    --allow-uncommitted                Allow sending files that are not committed to git."
}

# Check flag combinations once, right after the arguments are read.
guard_check_flags() {
  if [ "$OPT_LOSE_UNRECORDED" = true ] && [ "$OPT_DELETE" != true ]; then
    echo ""
    echo "  !!! --allow-lose-unrecorded-files only makes sense together with --delete-on-server."
    echo "  !!! Nothing was deployed."
    exit 1
  fi
  return 0
}

# Fail closed: a check could not be completed, so nothing is sent.
guard_fail_closed() {
  local reason="$1" line
  shift
  echo ""
  echo "  !!! COULD NOT VERIFY: $reason"
  for line in "$@"; do
    if [ -n "$line" ]; then echo "  !!!   $line"; fi
  done
  echo "  !!! To be safe, the deploy was cancelled BEFORE anything was sent to Sally."
  exit 3
}

# Used by the deploy scripts when a step AFTER the safety checks fails
# (the copy, npm install, the restart). Says plainly what was and was not done.
# Call it as:  some-command || guard_step_failed "what failed" "what state things are in" ["what to do next" ...]
# With no "what to do next" lines it says re-running is safe, which is true when the
# COPY failed (the same copy is simply tried again). For a failure AFTER the copy
# (npm install, the restart) pass your own lines: re-running would only say
# "Nothing to send" - Sally already has the files - and would NOT redo the failed step.
guard_step_failed() {
  local rc=$? line
  echo ""
  echo "  !!! FAILED: $1 (error code $rc)."
  echo "  !!! $2"
  shift 2
  if [ $# -eq 0 ]; then
    echo "  !!! Nothing further was run. It is safe to run the same command again."
  else
    for line in "$@"; do echo "  !!! $line"; done
  fi
  exit "$rc"
}

guard_count() {  # number of lines in a file
  wc -l < "$1" | tr -d ' '
}

guard_cleanup() {
  case "$GUARD_WORK" in
    */hub-deploy.??????) if [ -d "$GUARD_WORK" ]; then rm -rf "$GUARD_WORK"; fi ;;
  esac
  return 0
}

# Run a command on Sally. The safety checks only ever use this for read-only
# commands; the deploy scripts use it for npm install / pm2 after the copy.
guard_ssh() {
  env -u LC_ALL ssh -n "${GUARD_SSH_OPTS[@]}" "$SALLY" "$1"
}

# Same for rsync (it starts ssh itself): LC_ALL=C stays on this computer.
guard_rsync() {
  env -u LC_ALL rsync "$@"
}

# Does this relative path contain a folder or file name that is on the
# never-deployed list? Prints the matching pattern (as written in the list above) and
# returns 0 if so. Upper/lower case is ignored (".ENV.local" matches ".env*"), the
# same as the --exclude list given to rsync. bash's own "nocasematch" setting is
# switched on only while this runs and put back as it was.
guard_path_is_excluded() {
  local rest="$1" seg pat hit="" had_nocase=false
  if shopt -q nocasematch; then had_nocase=true; fi
  shopt -s nocasematch
  while [ -n "$rest" ] && [ -z "$hit" ]; do
    seg="${rest%%/*}"
    case "$rest" in
      */*) rest="${rest#*/}" ;;
      *)   rest="" ;;
    esac
    for pat in "${DEPLOY_EXCLUDE_PATTERNS[@]}"; do
      # shellcheck disable=SC2254
      case "$seg" in
        $pat) hit="$pat"; break ;;
      esac
    done
  done
  if [ "$had_nocase" = false ]; then shopt -u nocasematch; fi
  if [ -n "$hit" ]; then printf '%s\n' "$hit"; return 0; fi
  return 1
}

guard_type_word() {  # find's one-letter file type -> plain English
  case "$1" in
    f) echo "a file" ;;
    d) echo "a folder" ;;
    l) echo "a symbolic link" ;;
    *) echo "something unusual (type $1)" ;;
  esac
}

# Fingerprint (git's own hash, no line-ending conversion) every file named in
# list file $1 (absolute paths, one per line). Writes one hash per line to $2.
guard_hash_list() {
  local list="$1" out="$2" want got
  git -C "$REPO_ROOT" hash-object --no-filters --stdin-paths < "$list" > "$out" 2> "$out.err" \
    || guard_fail_closed "git could not fingerprint some files" "$(head -2 "$out.err" | tr '\n' ' ')"
  want="$(guard_count "$list")"
  got="$(guard_count "$out")"
  if [ "$want" != "$got" ]; then
    guard_fail_closed "git fingerprinted $got of $want files"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Set-up: needs SALLY, REMOTE_DIR and LOCAL_DIR to be set by the calling script
# ---------------------------------------------------------------------------
guard_init() {
  local tool
  for tool in git rsync ssh awk; do
    command -v "$tool" >/dev/null 2>&1 || guard_fail_closed "the '$tool' program was not found on this computer"
  done

  REPO_ROOT="$(git -C "$LOCAL_DIR" rev-parse --show-toplevel 2>/dev/null)" \
    || guard_fail_closed "this folder is not inside a git repository, so I can't tell what git has saved"
  REPO_PREFIX="$(git -C "$LOCAL_DIR" rev-parse --show-prefix 2>/dev/null)" \
    || guard_fail_closed "git could not tell me where this folder sits inside the repository"
  git -C "$REPO_ROOT" rev-parse --verify -q HEAD >/dev/null 2>&1 \
    || guard_fail_closed "git has no saved commits in this repository"

  GUARD_WORK="$(mktemp -d "${TMPDIR:-/tmp}/hub-deploy.XXXXXX")" \
    || guard_fail_closed "could not create a temporary work folder"
  trap guard_cleanup EXIT
  trap 'exit 130' INT     # Ctrl-C: exit normally so the temp folder is removed
  trap 'exit 143' TERM

  guard_ssh "test -d $REMOTE_DIR" >/dev/null 2>&1 \
    || guard_fail_closed "could not reach Sally over ssh (or $REMOTE_DIR does not exist there)"
}

# The source and destination rsync should use for one deploy "unit".
# "." means the whole Hub folder; anything else is a file or folder inside it.
# Sets U_SRC, U_DEST, U_PREFIX (what to put in front of rsync's file names),
# U_NAME (the unit with any trailing slash removed), U_IS_FILE, and U_ABSENT
# (starts false; guard_unit_inventory sets it true for a folder that does not
# exist on Sally yet).
guard_unit_endpoints() {
  local u="$1"
  while [ "${u%/}" != "$u" ]; do u="${u%/}"; done
  U_NAME="$u"
  U_IS_FILE=false
  U_ABSENT=false
  if [ "$u" = "." ] || [ -z "$u" ]; then
    U_NAME="."
    U_SRC="$LOCAL_DIR/"
    U_DEST="$SALLY:$REMOTE_DIR/"
    U_PREFIX=""
  elif [ -d "$LOCAL_DIR/$u" ]; then
    # trailing slash on a folder = "copy its contents into the matching folder"
    U_SRC="$LOCAL_DIR/$u/"
    U_DEST="$SALLY:$REMOTE_DIR/$u/"
    U_PREFIX="$u/"
  else
    U_SRC="$LOCAL_DIR/$u"
    U_DEST="$SALLY:$REMOTE_DIR/$u"
    U_PREFIX=""
    U_IS_FILE=true
  fi
}

# ---------------------------------------------------------------------------
# Step A0: look at what is ALREADY on Sally for one unit (read-only `find`).
# Writes "type<TAB>path" lines (path relative to the Hub folder) into
# $GUARD_WORK/plan/inventory. type is find's letter: f file, d folder, l link.
# Also checks the unit's own spot on Sally: the folder above it must exist
# (rsync only creates one new folder level), and a folder unit must not be
# sitting on a Sally file or link.
# ---------------------------------------------------------------------------
guard_unit_inventory() {
  local n="$1" plan="$GUARD_WORK/plan" parent base target raw fmt root_type
  fmt='%y\t%P\n'
  raw="$plan/root-$n"
  target="$REMOTE_DIR"
  root_type="d"

  if [ "$U_NAME" != "." ]; then
    case "$U_NAME" in
      */*) parent="$REMOTE_DIR/${U_NAME%/*}"; base="${U_NAME##*/}" ;;
      *)   parent="$REMOTE_DIR"; base="$U_NAME" ;;
    esac
    target="$REMOTE_DIR/$U_NAME"
    if ! guard_ssh "find '$parent' -maxdepth 1 -name '$base' -printf '%y\\n'" > "$raw.out" 2> "$raw.err"; then
      guard_fail_closed "could not look at '$U_NAME' on Sally" \
        "Either Sally could not be reached, or the folder '${parent#$REMOTE_DIR}' does not exist on Sally yet." \
        "This script creates at most one new folder level. Name a folder that already exists on Sally," \
        "or ask Jarvis to create the missing folder first."
    fi
    root_type="$(head -1 "$raw.out")"
  fi

  if [ "$U_IS_FILE" = true ]; then
    if [ "$root_type" = d ]; then
      # rsync would put the file INSIDE that folder (x/a.js/a.js) instead of replacing
      # it, which is not what the preview would say. Not something to guess about.
      guard_fail_closed "Sally has a folder named '$U_NAME' where this deploy needs a file" \
        "Sending the file would put it inside that folder instead of replacing it." \
        "Ask Jarvis to look at it on Sally first."
    fi
    if [ -n "$root_type" ]; then printf '%s\t%s\n' "$root_type" "$U_NAME" >> "$plan/inventory"; fi
    return 0
  fi

  case "$root_type" in
    "") U_ABSENT=true; return 0 ;;   # a brand-new folder on Sally: nothing there to protect
    d)  ;;
    *)  guard_fail_closed "Sally has $(guard_type_word "$root_type") named '$U_NAME' where this deploy needs a folder" \
          "Deploying would remove it to make room. Ask Jarvis to look at it on Sally first." ;;
  esac

  if ! guard_ssh "find '$target' '(' -name node_modules -o -name .git ')' -prune -o -printf '$fmt'" > "$raw.inv" 2> "$raw.inv.err"; then
    guard_fail_closed "could not list what is on Sally under '$U_NAME'" "$(head -2 "$raw.inv.err" | tr '\n' ' ')"
  fi
  PFX="$U_PREFIX" awk -F'\t' 'length($2) > 0 { print $1 "\t" ENVIRON["PFX"] $2 }' "$raw.inv" >> "$plan/inventory"
  return 0
}

# ---------------------------------------------------------------------------
# Step A: ask rsync what WOULD change (dry run, nothing is written) and sort
# it into lists inside $GUARD_WORK/plan:
#   new          files that do not exist on Sally yet
#   new-dirs     folders that do not exist on Sally yet
#   changed      files on Sally whose content differs from yours
#   mode         files/folders with identical content but different permissions
#   server-only  files that exist only on Sally (left alone unless --delete-on-server)
#   inventory    everything already on Sally (type<TAB>path), see above
# The dry run always includes --delete so Sally-only files are discovered; the
# REAL run only gets --delete if --delete-on-server was given.
# ---------------------------------------------------------------------------
guard_scan() {
  local plan="$GUARD_WORK/plan" n=0 unit out line flags name rel f saw_delete rest
  rm -rf "$plan"
  mkdir -p "$plan"
  for f in new new-dirs changed mode server-only server-only-dirs inventory; do : > "$plan/$f"; done

  for unit in "${UNIT_PATHS[@]}"; do
    n=$((n + 1))
    guard_unit_endpoints "$unit"
    echo "    comparing '$U_NAME' with Sally..."
    guard_unit_inventory "$n"

    out="$plan/rsync-$n"
    if ! guard_rsync "${GUARD_RSYNC_OPTS[@]}" -n --itemize-changes --delete \
         "${DEPLOY_EXCLUDES[@]}" "$U_SRC" "$U_DEST" > "$out.out" 2> "$out.err"; then
      guard_fail_closed "could not compare '$U_NAME' with Sally" \
        "rsync said: $(head -3 "$out.err" | tr '\n' ' ')"
    fi

    saw_delete=false
    while IFS= read -r line || [ -n "$line" ]; do
      [ -z "$line" ] && continue
      # A brand-new folder: the real rsync (3.x on Sally) begins its dry run with
      # "created directory <the folder>". Skip exactly that line - and only when
      # this folder really is missing on Sally. Anything else unexpected still
      # fails closed below.
      if [ "$U_ABSENT" = true ] && [ "${line%/}" = "created directory $REMOTE_DIR/$U_NAME" ]; then
        continue
      fi
      case "$line" in
        'skipping non-regular file'*)
          guard_fail_closed "a special file (a pipe, socket or similar) is in the folder being deployed, and these scripts cannot deploy it" \
            "$line" "Remove it (or move it out of the Hub folder) and run the deploy again." ;;
      esac
      case "$line" in
        *' '*) ;;
        *) guard_fail_closed "rsync printed a line this check cannot read" "$line" ;;
      esac
      # rsync's line is "<flags> <name>". The flags have no spaces, and the name
      # is everything after the FIRST space (so names that start with a space
      # are kept exactly). "*deleting" lines are padded with extra spaces by some
      # rsync versions, so for those all leading spaces are stripped; that is
      # only safe if no Sally name starts with a space, which is checked below.
      case "$line" in
        '*deleting'*)
          flags="*deleting"
          name="${line#\*deleting}"
          while [ "${name# }" != "$name" ]; do name="${name# }"; done
          saw_delete=true
          ;;
        *)
          flags="${line%% *}"
          name="${line#* }"
          ;;
      esac
      case "$name" in
        *\\*|*"$GUARD_TAB"*) guard_fail_closed "a file name has unusual characters (a backslash, a tab or a control character), which this check can't handle safely" "$name" "Rename it (or ask Jarvis to) and run the deploy again." ;;
      esac
      if [ "$U_IS_FILE" = true ]; then
        rel="$U_NAME"
      elif [ "$name" = "./" ]; then
        rel="$U_NAME/"
      else
        rel="$U_PREFIX$name"
      fi

      case "$flags" in
        '*deleting')
          case "$name" in
            */) printf '%s\n' "$rel" >> "$plan/server-only-dirs" ;;
            *)  printf '%s\n' "$rel" >> "$plan/server-only" ;;
          esac
          ;;
        '<f'*|'>f'*)
          rest="${flags#??}"
          if [ -z "$(printf '%s' "$rest" | tr -d '+')" ]; then
            printf '%s\n' "$rel" >> "$plan/new"
          else
            printf '%s\n' "$rel" >> "$plan/changed"
          fi
          ;;
        'cd'*)
          # a folder being created. (The unit's own top folder was checked in
          # guard_unit_inventory, so skip "./".)
          if [ "$name" != "./" ]; then printf '%s\n' "${rel%/}" >> "$plan/new-dirs"; fi
          ;;
        .f*|.d*)
          # identical content; only matters if the permissions differ
          if [ "${flags:5:1}" = "p" ]; then printf '%s\n' "$rel" >> "$plan/mode"; fi
          ;;
        .L*|.S*|.D*)
          : # unchanged link / special file: nothing to protect
          ;;
        *)
          guard_fail_closed "rsync reported something this check does not understand (a new or changed symbolic link or special file?)" "$line"
          ;;
      esac
    done < "$out.out"

    # The "strip all the padding spaces" rule above is only safe if no name on
    # Sally starts with a space. If one does, we cannot be sure which file a
    # "*deleting" line means, so fail closed.
    if [ "$saw_delete" = true ]; then
      if awk -F'\t' '$2 ~ /^ / || $2 ~ /\/ / { found = 1 } END { exit !found }' "$plan/inventory"; then
        guard_fail_closed "a file or folder name on Sally starts with a space, so this check cannot tell exactly which file rsync means" \
          "Ask Jarvis to look at the odd-looking name on Sally first."
      fi
    fi
  done

  for f in new new-dirs changed mode server-only server-only-dirs; do
    LC_ALL=C sort -u "$plan/$f" > "$plan/$f.sorted"
    mv "$plan/$f.sorted" "$plan/$f"
  done
  return 0
}

# ---------------------------------------------------------------------------
# Step A2: collisions. rsync labels a file/folder "new" when nothing of the
# same KIND is at that spot - even if Sally has a different kind of thing there
# (a file where you have a folder, a link where you have a file). It then
# quietly removes that Sally item to make room. Look every "new" path up in the
# list of what is already on Sally; anything found is a collision, recorded in
# plan/replaced as "type<TAB>path". These are NOT "left alone" Sally-only files.
# ---------------------------------------------------------------------------
guard_find_conflicts() {
  local plan="$GUARD_WORK/plan"
  : > "$plan/replaced"
  cat "$plan/new" "$plan/new-dirs" > "$plan/created"
  if [ -s "$plan/created" ] && [ -s "$plan/inventory" ]; then
    awk -F'\t' 'NR == FNR { t[$2] = $1; next } ($0 in t) { print t[$0] "\t" $0 }' \
      "$plan/inventory" "$plan/created" > "$plan/replaced.raw"
    LC_ALL=C sort -u "$plan/replaced.raw" > "$plan/replaced"
  fi
  if [ -s "$plan/replaced" ]; then
    # they are being replaced, so they are not "Sally-only files left alone"
    awk -F'\t' 'NR == FNR { r[$2] = 1; next } !($0 in r)' "$plan/replaced" "$plan/server-only" > "$plan/server-only.x"
    mv "$plan/server-only.x" "$plan/server-only"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Step B: lists of the file versions git has recorded (each built once)
#   head  every version in the history of the commit you are deploying from.
#         THIS decides whether Sally's copy may be overwritten. A Sally version
#         that exists only on some OTHER branch does not count: deploying from
#         here would replace it with older code.
#   all   every version on ANY branch or tag (not the stash). Used only to label
#         deletions: a file that is on some branch can still be recovered.
# ---------------------------------------------------------------------------
guard_history() {   # $1 = head | all
  local f="$GUARD_WORK/history-$1"
  if [ -s "$f" ]; then return 0; fi
  if [ "$1" = head ]; then
    git -C "$REPO_ROOT" rev-list --objects HEAD > "$f.raw" 2> "$f.err" \
      || guard_fail_closed "git could not list the saved history of your current commit" "$(head -2 "$f.err" | tr '\n' ' ')"
  else
    git -C "$REPO_ROOT" rev-list --objects --exclude=refs/stash --all > "$f.raw" 2> "$f.err" \
      || guard_fail_closed "git could not list its saved history" "$(head -2 "$f.err" | tr '\n' ' ')"
  fi
  cut -d' ' -f1 "$f.raw" | LC_ALL=C sort -u > "$f"
  if [ ! -s "$f" ]; then
    guard_fail_closed "git's saved history came back empty"
  fi
  return 0
}

# Which branches/tags hold this exact file version? (Only used to explain a stop,
# so if git cannot say, it simply prints nothing.) $1 = git hash.
guard_other_refs() {
  local c
  c="$(git -C "$REPO_ROOT" log --exclude=refs/stash --all --find-object="$1" --reverse --format=%H 2>/dev/null | head -1)" || return 0
  [ -n "$c" ] || return 0
  git -C "$REPO_ROOT" for-each-ref --contains "$c" --format='%(refname:short)' refs/heads refs/remotes refs/tags 2>/dev/null | head -3 | paste -sd, - || true
  return 0
}

# Is Sally's copy of $1 saved in git, but only on another branch? Prints a short
# phrase and returns 0 if so; returns 1 if git does not have it at all.
guard_where_else() {
  local line
  line="$(awk -F'\t' -v r="$1" '$1 == r { print "x" $2; exit }' "$GUARD_WORK/plan/elsewhere")"
  [ -n "$line" ] || return 1
  line="${line#x}"
  if [ -n "$line" ]; then echo "only on another branch ($line)"; else echo "only on another branch or tag"; fi
  return 0
}

# Copy the listed files FROM Sally into a private temp folder (read-only on
# Sally) so they can be fingerprinted. $1 = list file, $2 = folder to fill.
# The list is passed with NUL separators so odd file names cannot be misread.
guard_pull() {
  local list="$1" dest="$2"
  if grep -Eiq '(^|/)\.env' "$list"; then
    guard_fail_closed "a secrets file (.env) ended up on a list of files to check; refusing to copy it"
  fi
  rm -rf "$dest"
  mkdir -p "$dest"
  tr '\n' '\0' < "$list" > "$dest.list0"
  guard_rsync -rl --timeout=120 --from0 --files-from="$dest.list0" "$SALLY:$REMOTE_DIR/" "$dest/" > "$dest.out" 2> "$dest.err" \
    || guard_fail_closed "could not fetch Sally's copies of files to check them against git" "rsync said: $(head -3 "$dest.err" | tr '\n' ' ')"
}

# ---------------------------------------------------------------------------
# Check (b): is every file we are about to send committed to git?
# Fingerprints all new + changed local files in one go and compares each with
# the copy in the current commit (HEAD). Any git error stops the deploy.
# ---------------------------------------------------------------------------
guard_check_local() {
  local plan="$GUARD_WORK/plan" rel tag f
  : > "$plan/local-abs"; : > "$plan/local-tags"
  for f in new changed; do
    if [ "$f" = new ]; then tag=NEW; else tag=CHANGED; fi
    while IFS= read -r rel; do
      if [ ! -f "$LOCAL_DIR/$rel" ]; then
        guard_fail_closed "local file '$rel' vanished or is not a regular file while checking it"
      fi
      printf '%s\n' "$LOCAL_DIR/$rel" >> "$plan/local-abs"
      printf '%s\t%s\n' "$tag" "$rel" >> "$plan/local-tags"
    done < "$plan/$f"
  done
  if [ ! -s "$plan/local-abs" ]; then return 0; fi

  echo "    checking $(guard_count "$plan/local-abs") local file(s) against git..."
  guard_hash_list "$plan/local-abs" "$plan/local-hashes"
  paste "$plan/local-tags" "$plan/local-hashes" > "$plan/local3"     # TAG<TAB>path<TAB>hash

  # What the current commit (HEAD) holds for this folder: "git-path<TAB>hash".
  # Any git failure here must stop the deploy - never treat it as "not committed".
  if [ -n "$REPO_PREFIX" ]; then
    git -C "$REPO_ROOT" ls-tree -r -z HEAD -- "$REPO_PREFIX" > "$plan/head-tree.z" 2> "$plan/head-tree.err" \
      || guard_fail_closed "git could not read the files in your current commit" "$(head -2 "$plan/head-tree.err" | tr '\n' ' ')"
  else
    git -C "$REPO_ROOT" ls-tree -r -z HEAD > "$plan/head-tree.z" 2> "$plan/head-tree.err" \
      || guard_fail_closed "git could not read the files in your current commit" "$(head -2 "$plan/head-tree.err" | tr '\n' ' ')"
  fi
  # (The first line is a harmless placeholder so the file is never empty: awk's
  # "first file" test below misreads the second file as the first when the first is empty.)
  printf '\t\n' > "$plan/head-map"
  tr '\0' '\n' < "$plan/head-tree.z" | awk -F'\t' '{ split($1, a, " "); print $2 "\t" a[3] }' >> "$plan/head-map"

  PFX="$REPO_PREFIX" awk -F'\t' '
    NR == FNR { head[$1] = $2; next }
    { g = ENVIRON["PFX"] $2
      if (!(g in head))       print $2 "\tnew file, never committed to git"
      else if (head[g] != $3) print $2 "\tedited since the last commit" }
  ' "$plan/head-map" "$plan/local3" >> "$plan/uncommitted"
  awk -F'\t' '{ print $1 " " $2 " " $3 }' "$plan/local3" >> "$plan/fingerprint"
  return 0
}

# ---------------------------------------------------------------------------
# Check (a): is Sally's current copy of everything we'd overwrite or replace a
# version git has recorded? Fills plan/unrecorded (one path per line).
#   - files whose content differs: fetch Sally's copy, fingerprint, look up
#   - Sally items replaced by a different kind of thing (see guard_find_conflicts):
#     a regular file is checked the same way; a link or folder counts as unrecorded
# ---------------------------------------------------------------------------
guard_check_server_copies() {
  local plan="$GUARD_WORK/plan" rel f t h
  : > "$plan/unrecorded"; : > "$plan/elsewhere"; : > "$plan/pull-list"
  cat "$plan/changed" >> "$plan/pull-list"
  while IFS="$GUARD_TAB" read -r t rel; do
    if [ "$t" = f ]; then
      printf '%s\n' "$rel" >> "$plan/pull-list"
    else
      printf '%s\n' "$rel" >> "$plan/unrecorded"
      echo "SERVERITEM $rel type-$t" >> "$plan/fingerprint"
    fi
  done < "$plan/replaced"
  if [ ! -s "$plan/pull-list" ]; then return 0; fi

  guard_history head
  echo "    fetching $(guard_count "$plan/pull-list") Sally file(s) to check them against git..."
  guard_pull "$plan/pull-list" "$GUARD_WORK/sally-copies"
  : > "$plan/pulled-abs"; : > "$plan/pulled-names"
  while IFS= read -r rel; do
    f="$GUARD_WORK/sally-copies/$rel"
    if [ ! -e "$f" ] && [ ! -L "$f" ]; then
      guard_fail_closed "Sally's copy of '$rel' could not be fetched for checking (did it change during the check?)"
    fi
    if [ -L "$f" ] || [ ! -f "$f" ]; then
      printf '%s\n' "$rel" >> "$plan/unrecorded"
      echo "SERVERCOPY $rel not-a-regular-file" >> "$plan/fingerprint"
      continue
    fi
    printf '%s\n' "$f" >> "$plan/pulled-abs"
    printf '%s\n' "$rel" >> "$plan/pulled-names"
  done < "$plan/pull-list"
  if [ ! -s "$plan/pulled-abs" ]; then rm -rf "$GUARD_WORK/sally-copies"; return 0; fi

  guard_hash_list "$plan/pulled-abs" "$plan/pulled-hashes"
  rm -rf "$GUARD_WORK/sally-copies"     # only needed for the fingerprints; don't leave Sally's file contents lying around
  paste "$plan/pulled-names" "$plan/pulled-hashes" > "$plan/pulled2"
  while IFS="$GUARD_TAB" read -r rel h; do
    echo "SERVERCOPY $rel $h" >> "$plan/fingerprint"
    if ! grep -Fxq -- "$h" "$GUARD_WORK/history-head"; then
      printf '%s\n' "$rel" >> "$plan/unrecorded"
      # Is it at least saved on some OTHER branch? (Only changes what the stop says.)
      guard_history all
      if grep -Fxq -- "$h" "$GUARD_WORK/history-all"; then
        printf '%s\t%s\n' "$rel" "$(guard_other_refs "$h")" >> "$plan/elsewhere"
      fi
    fi
  done < "$plan/pulled2"
  return 0
}

# ---------------------------------------------------------------------------
# Deletion check (only when --delete-on-server was given): which Sally-only
# files are recorded in git, and which would be lost for good?
#   del-recorded    "path<TAB>commit"
#   del-unrecorded  "path"
# ---------------------------------------------------------------------------
guard_check_deletes() {
  local plan="$GUARD_WORK/plan" rel f h commit
  : > "$plan/del-recorded"; : > "$plan/del-unrecorded"; : > "$plan/del-elsewhere"
  if [ "$OPT_DELETE" != true ] || [ ! -s "$plan/server-only" ]; then return 0; fi
  guard_history head
  guard_history all
  echo "    fetching $(guard_count "$plan/server-only") Sally-only file(s) to check them against git..."
  guard_pull "$plan/server-only" "$GUARD_WORK/sally-delete"
  : > "$plan/del-abs"; : > "$plan/del-names"
  while IFS= read -r rel; do
    f="$GUARD_WORK/sally-delete/$rel"
    if [ ! -e "$f" ] && [ ! -L "$f" ]; then
      guard_fail_closed "Sally's copy of '$rel' (marked for deletion) could not be fetched for checking"
    fi
    if [ -L "$f" ] || [ ! -f "$f" ]; then
      printf '%s\n' "$rel" >> "$plan/del-unrecorded"
      echo "DELETE $rel not-a-regular-file" >> "$plan/fingerprint"
      continue
    fi
    printf '%s\n' "$f" >> "$plan/del-abs"
    printf '%s\n' "$rel" >> "$plan/del-names"
  done < "$plan/server-only"
  if [ ! -s "$plan/del-abs" ]; then rm -rf "$GUARD_WORK/sally-delete"; return 0; fi

  guard_hash_list "$plan/del-abs" "$plan/del-hashes"
  rm -rf "$GUARD_WORK/sally-delete"     # only needed for the fingerprints; don't leave Sally's file contents lying around
  paste "$plan/del-names" "$plan/del-hashes" > "$plan/del2"
  while IFS="$GUARD_TAB" read -r rel h; do
    echo "DELETE $rel $h" >> "$plan/fingerprint"
    if grep -Fxq -- "$h" "$GUARD_WORK/history-all"; then
      # The FIRST commit that saved this exact content (--reverse = oldest first).
      git -C "$REPO_ROOT" log --exclude=refs/stash --all --find-object="$h" --reverse --format=%h \
          > "$GUARD_WORK/commit-lookup" 2> "$GUARD_WORK/commit-lookup.err" \
        || guard_fail_closed "git could not look up which commit holds Sally's copy of '$rel'" "$(head -2 "$GUARD_WORK/commit-lookup.err" | tr '\n' ' ')"
      commit="$(head -1 "$GUARD_WORK/commit-lookup")"
      [ -n "$commit" ] || commit="a saved version, commit not located"
      printf '%s\t%s\n' "$rel" "$commit" >> "$plan/del-recorded"
      # on some branch, but not in the history of the commit being deployed from?
      if ! grep -Fxq -- "$h" "$GUARD_WORK/history-head"; then printf '%s\n' "$rel" >> "$plan/del-elsewhere"; fi
    else
      printf '%s\n' "$rel" >> "$plan/del-unrecorded"
    fi
  done < "$plan/del2"
  return 0
}

# Run every check from scratch and write the fingerprint of the plan.
guard_analyze() {
  local plan="$GUARD_WORK/plan" rel head
  guard_scan
  guard_find_conflicts
  : > "$plan/fingerprint"; : > "$plan/uncommitted"
  head="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null)" \
    || guard_fail_closed "git could not tell me which commit your files are at"
  echo "HEAD $head" >> "$plan/fingerprint"
  guard_check_local
  guard_check_server_copies
  guard_check_deletes
  while IFS= read -r rel; do echo "MODE $rel" >> "$plan/fingerprint"; done < "$plan/mode"
  awk -F'\t' '{ print "REPLACED " $2 " " $1 }' "$plan/replaced" >> "$plan/fingerprint"
  awk '{ print "UNRECORDED " $0 }' "$plan/unrecorded" >> "$plan/fingerprint"
  awk -F'\t' '{ print "UNCOMMITTED " $1 " " $2 }' "$plan/uncommitted" >> "$plan/fingerprint"
  awk '{ print "DELUNRECORDED " $0 }' "$plan/del-unrecorded" >> "$plan/fingerprint"
  LC_ALL=C sort "$plan/fingerprint" > "$plan/fingerprint.sorted"
  mv "$plan/fingerprint.sorted" "$plan/fingerprint"
  return 0
}

# ---------------------------------------------------------------------------
# Show the plan, apply the stops, ask for confirmation
# ---------------------------------------------------------------------------
guard_show_list() {  # $1 = file of paths, $2 = marker
  local rel
  while IFS= read -r rel; do
    echo "      $2 $rel"
  done < "$1"
  return 0
}

# ---------------------------------------------------------------------------
# Heads-up (a difference never stops the deploy): files that git tracks but these
# scripts NEVER send, because their names are on the never-deploy list (cron-*.sh
# and friends). If one of them differs from Sally's copy, say so, because this
# deploy will not fix that. Like every other check, if the comparison itself
# cannot be made, the deploy is cancelled before anything is sent.
# (.env files and the helper itself are left out of this note on purpose.)
# ---------------------------------------------------------------------------
guard_note_skipped() {
  local plan="$GUARD_WORK/plan" unit spec rel pat line flags name n
  : > "$plan/skipped.names"
  for unit in "${UNIT_PATHS[@]}"; do
    guard_unit_endpoints "$unit"
    if [ "$U_NAME" = "." ]; then spec="${REPO_PREFIX:-.}"; else spec="$REPO_PREFIX$U_NAME"; fi
    git -C "$REPO_ROOT" ls-files -z -- "$spec" > "$plan/skipped.git" 2> "$plan/skipped.err" \
      || guard_fail_closed "git could not list the files it tracks (needed for the never-sent-files check)" "$(head -2 "$plan/skipped.err" | tr '\n' ' ')"
    tr '\0' '\n' < "$plan/skipped.git" | while IFS= read -r rel; do
      rel="${rel#"$REPO_PREFIX"}"
      [ -n "$rel" ] || continue
      pat="$(guard_path_is_excluded "$rel")" || continue
      case "$pat" in '.env*'|deploy-guard-lib.sh|node_modules|.git) continue ;; esac
      if [ -f "$LOCAL_DIR/$rel" ] && [ ! -L "$LOCAL_DIR/$rel" ]; then printf '%s\n' "$rel"; fi
    done >> "$plan/skipped.names"
  done
  if [ ! -s "$plan/skipped.names" ]; then return 0; fi

  tr '\n' '\0' < "$plan/skipped.names" > "$plan/skipped.list0"
  if ! guard_rsync -lpz -8 --checksum --no-owner --no-group --timeout=120 -n --itemize-changes --from0 \
       --files-from="$plan/skipped.list0" "$LOCAL_DIR/" "$SALLY:$REMOTE_DIR/" > "$plan/skipped.out" 2> "$plan/skipped.err"; then
    guard_fail_closed "could not compare the never-sent tracked files (cron-*.sh ...) with Sally" \
      "rsync said: $(head -3 "$plan/skipped.err" | tr '\n' ' ')"
  fi
  : > "$plan/skipped.differ"
  while IFS= read -r line || [ -n "$line" ]; do
    flags="${line%% *}"
    name="${line#* }"
    case "$flags" in
      '<f'*|'>f'*) printf '%s\n' "$name" >> "$plan/skipped.differ" ;;
    esac
  done < "$plan/skipped.out"
  if [ ! -s "$plan/skipped.differ" ]; then return 0; fi
  n="$(guard_count "$plan/skipped.differ")"
  echo ""
  echo "  Heads-up: $n file(s) tracked in git are NOT sent by these scripts (cron-*.sh and other"
  echo "  never-deploy names) and differ from Sally's copy - this deploy will not change them:"
  guard_show_list "$plan/skipped.differ" "!"
  echo "  If you edited one here, copy it to Sally by hand. If it was edited on Sally, save"
  echo "  that copy into git (ask Jarvis)."
  return 0
}

guard_show_plan() {
  local plan="$GUARD_WORK/plan" rel t n_new n_changed n_mode n_only n_dirs n_replaced commit now tag where
  n_new="$(guard_count "$plan/new")"
  n_changed="$(guard_count "$plan/changed")"
  n_mode="$(guard_count "$plan/mode")"
  n_only="$(guard_count "$plan/server-only")"
  n_dirs="$(guard_count "$plan/server-only-dirs")"
  n_replaced="$(guard_count "$plan/replaced")"

  echo ""
  echo "==================================================="
  echo "  PREVIEW - this is what the deploy would do on Sally."
  echo "  Nothing has been sent yet."
  echo "==================================================="

  echo ""
  echo "  Files that would be ADDED (new on Sally): $n_new"
  guard_show_list "$plan/new" "+"

  echo ""
  echo "  Files that would be OVERWRITTEN with your version: $n_changed"
  while IFS= read -r rel; do
    if grep -Fxq -- "$rel" "$plan/unrecorded"; then
      if where="$(guard_where_else "$rel")"; then
        echo "      ~ $rel   <-- Sally's copy is saved in git $where, NOT in the code you are deploying"
      else
        echo "      ~ $rel   <-- Sally's copy is NOT saved anywhere in git"
      fi
    else
      echo "      ~ $rel"
    fi
  done < "$plan/changed"

  if [ "$n_replaced" -gt 0 ]; then
    echo ""
    echo "  Things on Sally that would be REPLACED by a different KIND of thing: $n_replaced"
    echo "  (rsync quietly removes them to make room - they are not 'left alone')"
    while IFS="$GUARD_TAB" read -r t rel; do
      if grep -Fxq -- "$rel" "$plan/new-dirs"; then now="a folder"; else now="a file"; fi
      if grep -Fxq -- "$rel" "$plan/unrecorded"; then
        if where="$(guard_where_else "$rel")"; then
          tag="<-- saved in git $where, NOT in the code you are deploying"
        else
          tag="<-- NOT saved anywhere in git"
        fi
      else
        tag="(this exact file is saved in git)"
      fi
      echo "      ! $rel   Sally has $(guard_type_word "$t") here; your deploy puts $now there   $tag"
    done < "$plan/replaced"
  fi

  if [ "$n_mode" -gt 0 ]; then
    echo ""
    echo "  Files/folders whose content is identical but whose permissions would change: $n_mode"
    guard_show_list "$plan/mode" "p"
  fi

  echo ""
  if [ "$OPT_DELETE" = true ]; then
    echo "  Files that would be PERMANENTLY DELETED from Sally: $n_only (plus $n_dirs folder(s))"
    while IFS= read -r rel; do
      if grep -Fxq -- "$rel" "$plan/del-unrecorded"; then
        echo "      x $rel   NOT IN GIT - would be lost permanently"
      else
        commit="$(awk -F '\t' -v r="$rel" '$1 == r { print $2; exit }' "$plan/del-recorded")"
        if grep -Fxq -- "$rel" "$plan/del-elsewhere"; then
          echo "      x $rel   recorded in git, but only on another branch (commit $commit)"
        else
          echo "      x $rel   recorded in git (commit $commit)"
        fi
      fi
    done < "$plan/server-only"
    if [ "$n_dirs" -gt 0 ]; then
      echo "      (folders that would be removed once empty:)"
      guard_show_list "$plan/server-only-dirs" "x"
    fi
  else
    echo "  Files that exist only on Sally: $n_only - these will be LEFT ALONE."
    echo "  (Deploys never delete anything unless you add --delete-on-server.)"
  fi
  guard_note_skipped
  return 0
}

guard_stop_a() {   # $1 = heading, $2 = "overridden" to leave out the how-to-fix hints
  local plan="$GUARD_WORK/plan" rel first where any_else=false
  echo ""
  echo "  !!! $1"
  echo "  !!! These items on Sally are not any version saved in the history of the code you are"
  echo "  !!! deploying (your current commit). Sending your version would overwrite or replace"
  echo "  !!! them, and Sally's version would be lost - or silently replaced by OLDER code:"
  first=""
  while IFS= read -r rel; do
    echo "  !!!     $rel"
    if where="$(guard_where_else "$rel")"; then
      echo "  !!!       ^ git has Sally's version, $where - but that is not part of your current commit."
      any_else=true
    fi
    [ -n "$first" ] || first="$rel"
  done < "$plan/unrecorded"
  if [ "$2" != "overridden" ]; then
    echo "  !!!"
    if grep -Fxq -- "$first" "$plan/changed"; then
      echo "  !!! To see what is different:  ssh $SALLY cat '$REMOTE_DIR/$first' | diff - '$LOCAL_DIR/$first'"
    else
      echo "  !!! To look at one:  ssh $SALLY ls -ld '$REMOTE_DIR/$first'"
    fi
    if [ "$any_else" = true ]; then
      echo "  !!! Safest fix: bring the other branch's work into this one (or deploy from that branch)"
      echo "  !!! - ask Jarvis - then deploy again."
    else
      echo "  !!! Safest fix: save Sally's version into git first (ask Jarvis), then deploy again."
    fi
    echo "  !!! If you are sure you want to overwrite it anyway: --allow-unrecorded-server-changes"
  fi
  return 0
}

guard_stop_b() {   # $1 = heading, $2 = "overridden" to leave out the how-to-fix hints
  local plan="$GUARD_WORK/plan" rel why
  echo ""
  echo "  !!! $1"
  echo "  !!! Sending them would put work on Sally that git has no record of:"
  while IFS="$GUARD_TAB" read -r rel why; do
    echo "  !!!     $rel   ($why)"
  done < "$plan/uncommitted"
  if [ "$2" != "overridden" ]; then
    echo "  !!!"
    echo "  !!! Safest fix: commit them first (ask Jarvis), then deploy again."
    echo "  !!! If you are sure you want to send them anyway: --allow-uncommitted"
  fi
  return 0
}

guard_stop_delete() {   # $1 = heading, $2 = "overridden" to leave out the how-to-fix hints
  local plan="$GUARD_WORK/plan" n
  n="$(guard_count "$plan/del-unrecorded")"
  echo ""
  echo "  !!! $1"
  echo "  !!! $n file(s) marked for deletion are not saved anywhere in git (each is marked"
  echo "  !!! \"NOT IN GIT\" in the list above). Deleting them would lose them permanently."
  if [ "$2" != "overridden" ]; then
    echo "  !!!"
    echo "  !!! Safest fix: copy them into git first (ask Jarvis), or leave --delete-on-server off."
    echo "  !!! If you are sure you want to lose them: add --allow-lose-unrecorded-files"
  fi
  return 0
}

# Decide: stop, or ask, or go. Exits the script unless the deploy may proceed.
guard_decide() {
  local plan="$GUARD_WORK/plan" stops=0 warned=false answer rc no_terminal_delete=false
  local n_new n_changed n_mode n_only n_dirs n_del n_replaced
  n_new="$(guard_count "$plan/new")"
  n_changed="$(guard_count "$plan/changed")"
  n_mode="$(guard_count "$plan/mode")"
  n_only="$(guard_count "$plan/server-only")"
  n_dirs="$(guard_count "$plan/server-only-dirs")"
  n_replaced="$(guard_count "$plan/replaced")"
  n_del=$((n_only + n_dirs))     # files and folders that --delete-on-server would remove

  # A delete request needs a person at the keyboard (to type DELETE) - ALWAYS, even if
  # the preview happens to list nothing to delete. (Checked here so that the early
  # "Nothing to send" exit below cannot skip it, and again in the stops further down.)
  if [ "$OPT_DELETE" = true ] && [ ! -t 0 ]; then no_terminal_delete=true; fi

  guard_show_plan

  # Nothing to send and nothing to delete: done.
  if [ "$n_new" -eq 0 ] && [ "$n_changed" -eq 0 ] && [ "$n_mode" -eq 0 ] && [ "$n_replaced" -eq 0 ] \
     && [ "$no_terminal_delete" != true ] \
     && { [ "$OPT_DELETE" != true ] || [ "$n_del" -eq 0 ]; }; then
    echo ""
    echo "==> Nothing to send: for the files these scripts deploy, Sally already has the same content."
    echo "    Nothing was changed (and the Hub was not restarted)."
    exit 0
  fi

  # --- the stops (all are reported together) ---
  if [ -s "$plan/unrecorded" ]; then
    if [ "$OPT_ALLOW_UNRECORDED_SERVER" = true ]; then
      guard_stop_a "WARNING (OVERRIDDEN): SALLY HAS CHANGES GIT DOESN'T KNOW ABOUT" overridden
      echo "  !!! --allow-unrecorded-server-changes was given: continuing, those Sally versions WILL be overwritten."
      warned=true
    else
      guard_stop_a "STOPPED - SALLY HAS CHANGES GIT DOESN'T KNOW ABOUT"
      stops=1
    fi
  fi
  if [ -s "$plan/uncommitted" ]; then
    if [ "$OPT_ALLOW_UNCOMMITTED" = true ]; then
      guard_stop_b "WARNING (OVERRIDDEN): SOME FILES YOU ARE ABOUT TO SEND ARE NOT SAVED IN GIT" overridden
      echo "  !!! --allow-uncommitted was given: continuing, git will have NO record of what is sent."
      warned=true
    else
      guard_stop_b "STOPPED - SOME FILES YOU ARE ABOUT TO SEND ARE NOT SAVED IN GIT"
      stops=1
    fi
  fi
  if [ "$OPT_DELETE" = true ] && [ -s "$plan/del-unrecorded" ]; then
    if [ "$OPT_LOSE_UNRECORDED" = true ]; then
      guard_stop_delete "WARNING (OVERRIDDEN): FILES MARKED FOR DELETION ARE NOT SAVED ANYWHERE IN GIT" overridden
      echo "  !!! --allow-lose-unrecorded-files was given: continuing, those files will be GONE FOR GOOD."
      warned=true
    else
      guard_stop_delete "STOPPED - SOME FILES MARKED FOR DELETION ARE NOT SAVED ANYWHERE IN GIT"
      stops=1
    fi
  fi
  # The calling script may add its own stop by defining guard_extra_stops.
  # It prints its own message and returns 0 (no problem), 1 (stop) or 2 (stop
  # that was overridden with its own flag; continue after a warning).
  if declare -F guard_extra_stops >/dev/null 2>&1; then
    rc=0
    guard_extra_stops || rc=$?
    case "$rc" in
      0) ;;
      1) stops=1 ;;
      *) warned=true ;;
    esac
  fi
  if [ "$no_terminal_delete" = true ]; then
    echo ""
    echo "  !!! DELETING FILES NEEDS A PERSON AT THE KEYBOARD"
    echo "  !!! --delete-on-server asks you to type the word DELETE. This run has no terminal"
    echo "  !!! attached (it is a script or a pipe), so the delete request is refused - even if"
    echo "  !!! the preview above lists nothing to delete. Run it again without --delete-on-server,"
    echo "  !!! or from a terminal where a person can type DELETE."
    stops=1
  fi
  if [ "$stops" -ne 0 ]; then
    echo ""
    echo "  Deploy STOPPED by a safety check. Nothing was sent to Sally and nothing was changed."
    echo "  (--yes does not get past these stops.)"
    exit 2
  fi

  # --- summary of the safety checks (so a clean run is visibly clean) ---
  echo ""
  echo "  Safety checks:"
  if [ "$n_changed" -eq 0 ] && [ "$n_replaced" -eq 0 ]; then
    echo "    OK  No Sally files are being overwritten."
  elif [ -s "$plan/unrecorded" ]; then
    echo "    OVERRIDDEN  Some Sally files being overwritten or replaced are not saved in git."
  else
    echo "    OK  Sally's current copy of every file being overwritten or replaced is a version saved in git (in the history of your current commit)."
  fi
  if [ -s "$plan/uncommitted" ]; then
    echo "    OVERRIDDEN  Some files being sent are not committed to git."
  else
    echo "    OK  Every file being sent is committed to git."
  fi

  # --- the y/N question (--yes skips only this) ---
  if [ "$OPT_YES" != true ]; then
    echo ""
    if [ "$warned" = true ]; then
      echo "  You are overriding a safety check (see the warnings above)."
    fi
    printf '%s' "Proceed with this deploy? [y/N] " >&2
    read -r answer || answer=""
    case "$answer" in
      y|Y|yes|YES) ;;
      *)
        echo "Aborted. Nothing was deployed."
        exit 1
        ;;
    esac
  else
    echo ""
    echo "  (--yes given: skipping the y/N question. Safety stops above still applied.)"
  fi

  # --- the DELETE question (--yes does NOT skip this) ---
  # NOTE: "has a terminal" only means stdin is a terminal. Whoever runs this must
  # make Peter type DELETE himself; nothing here can tell a person from a program
  # that is driving a terminal.
  if [ "$OPT_DELETE" = true ] && [ "$n_del" -gt 0 ]; then
    echo ""
    echo "  You asked for $n_only file(s) and $n_dirs folder(s) to be PERMANENTLY DELETED from Sally."
    echo "  To go ahead, type the word DELETE (capital letters, nothing else) and press Enter."
    echo "  Anything else cancels. (--yes does not answer this question.)"
    printf '%s' "Type DELETE: " >&2
    IFS= read -r answer || answer=""
    if [ "$answer" != "DELETE" ]; then
      echo "Aborted - that was not the word DELETE. Nothing was deployed."
      exit 1
    fi
    # The only place this becomes true: the approved plan listed at least one deletion
    # and the person typed DELETE. guard_transfer relies on it.
    GUARD_DELETE_CONFIRMED=true
  fi
  return 0
}

# After you said yes: run every check again and make sure nothing moved.
guard_recheck() {
  echo ""
  echo "==> Re-checking that nothing changed while you were deciding..."
  cp "$GUARD_WORK/plan/fingerprint" "$GUARD_WORK/approved-fingerprint"
  guard_analyze
  if ! cmp -s "$GUARD_WORK/approved-fingerprint" "$GUARD_WORK/plan/fingerprint"; then
    echo ""
    echo "  !!! Something changed (on Sally, in your files, or in git) between the preview and your yes."
    echo "  !!! To be safe the deploy was cancelled before anything was sent. Run it again"
    echo "  !!! and review the new preview."
    exit 3
  fi
  echo "    OK - same as the preview you approved."
  return 0
}

# The real copy. Same options as the dry run, minus -n. --delete is added ONLY if the
# plan you approved listed at least one deletion and you typed DELETE for it
# (GUARD_DELETE_CONFIRMED). With --delete-on-server but nothing listed, the copy is sent
# WITHOUT --delete, so a file that appeared on Sally after the preview is never removed
# unlisted. (Asking for --delete-on-server alone never deletes anything.)
guard_transfer() {
  local unit
  for unit in "${UNIT_PATHS[@]}"; do
    guard_unit_endpoints "$unit"
    echo "  -- $U_NAME --"
    if [ "$OPT_DELETE" = true ] && [ "$GUARD_DELETE_CONFIRMED" = true ]; then
      guard_rsync "${GUARD_RSYNC_OPTS[@]}" --delete "${DEPLOY_EXCLUDES[@]}" "$U_SRC" "$U_DEST" || return $?
    else
      guard_rsync "${GUARD_RSYNC_OPTS[@]}" "${DEPLOY_EXCLUDES[@]}" "$U_SRC" "$U_DEST" || return $?
    fi
  done
  return 0
}

# One call for "check, show, ask, re-check" (used by both scripts).
guard_run_checks_and_confirm() {
  echo ""
  echo "==> Checking what would change on Sally and whether it is safe (nothing is sent yet)..."
  guard_analyze
  guard_decide
  guard_recheck
}
