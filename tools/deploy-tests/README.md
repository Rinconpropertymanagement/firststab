# Deploy-script tests

These tests check the three Hub deploy scripts before anyone trusts them with the live server (Sally):

- `projects/hub/deploy-to-sally.sh` (sends the whole Hub)
- `projects/hub/deploy-feature-to-sally.sh` (sends one named folder or file)
- `projects/hub/deploy-guard-lib.sh` (the safety checks both of them share)

This folder lives at the top level of the repo, **outside `projects/hub`, on purpose**, so the deploy scripts never copy it to the server.

## What the tests prove

Each check sets up a small made-up situation and confirms the script does the safe thing. In plain terms, the scripts:

- never overwrite a Sally file that exists only on Sally (not saved in git), unless you explicitly say so with a flag, and `--yes` alone can never say so;
- never send files that are uncommitted, untracked, staged-only or git-ignored (and say so in plain words);
- never delete anything on Sally unless a person is at the keyboard and types the exact word `DELETE` after seeing the list;
- never send secrets-style names (`.env*`, in any upper/lower case), rollback copies (`*.bak*`, `*.*.pre-*`), cron scripts or `node_modules`;
- stop ("fail closed") whenever they cannot be sure: Sally unreachable, a git error, odd file names, a symbolic link or pipe, a folder where a file is expected, a missing npm package;
- notice when anything moves while the "Proceed? [y/N]" question is waiting (a new commit, a local edit, an edit on Sally) and cancel;
- run `npm install` before the restart, skip both when nothing was sent, and say honestly what was and was not done when a step fails.

Two places in the suites (marked "documented limit" / "known limit") deliberately re-demonstrate a gap that is **not fixed**: an edit made on Sally in the few seconds between the final check and the copy. Those checks pass by design; the limit is written up in the header of `deploy-guard-lib.sh`.

## How to run them (one command)

From the repo root (or from anywhere):

```
bash tools/deploy-tests/run-all.sh
```

It runs the five suites one after another (they share one scratch repo, so never run two at once) and prints a grand total. It ends with `ALL DEPLOY-SCRIPT TESTS PASSED` and exit code 0 only if every check passed **and** each suite ran exactly the expected number of checks. A single suite can be run alone, for example `bash tools/deploy-tests/judgefix.sh`; `fixes.sh` and `judgefix.sh` also accept a letter to run one section (`bash fixes.sh L`).

Needs: bash, git, rsync and python3 (all already on a Mac). A full run takes about 9 minutes. The tests test the scripts **as they are on disk** in `projects/hub`, so run them after editing a script and before deploying with it.

## Expected results

| Suite | What it covers | Passed | Failed |
|---|---|---|---|
| `regress.sh` | normal deploys, the "unrecorded Sally change" and "uncommitted file" stops, deleting, fail-closed, odd path arguments | 65 | 0 |
| `bugs.sh` | the blocker and minor bugs found in testing (folder/file/symlink collisions, odd names, packages, things moving during the prompt, ...) | 110 | 0 |
| `extras.sh` | Sally folder/symlink where the deploy has a file, and the reverse | 14 | 0 |
| `fixes.sh` | the fixes that followed (new folders, other-branch copies, file names like `-n`, never-send list, temp-folder cleanup, ...) | 147 | 0 |
| `judgefix.sh` | delete mode needs a terminal, `--delete` only when a deletion was approved, upper/lower-case secrets, honest headers, syntax under macOS bash 3.2 | 116 | 0 |
| **Total** | | **452** | **0** |

The total line also reports `BLOCKED lines in all shim logs: 0`. If you intentionally add or remove checks, update the `EXPECTED_...` numbers at the top of `run-all.sh`.

Five checks in `fixes.sh` (section A, the ones marked "REAL Sally") do a read-only look at the real server (a dry run, a "does this folder exist" test, a listing), so they need your normal `ssh sally` access to work. Without it those five fail; nothing else is affected.

## THE BIG SAFETY RULE: the shims must be first in PATH

The tests never run the deploy scripts against the real server. They put three stand-in programs, in `shims/`, ahead of the real `rsync`, `ssh` and `git`:

- `shims/rsync` and `shims/ssh` talk to a local **fake server** folder instead of Sally. Against the real Sally they only allow read-only looks (dry runs, listing, reading), and **block (exit 99) anything that could write**. Every block is logged as a `BLOCKED` line.
- `shims/git` just passes through, but can be told to fail one git command so the tests can prove "fail closed".
- `shims/fake-find.py` lets the fake server answer the one kind of `find` the guard uses (a Mac `find` lacks `-printf`).

**If the shims were not first in PATH, a deploy script run by these tests could reach the real server.** So `harness.sh` puts them first and then checks, before anything else happens, that `command -v rsync`, `command -v ssh` and `command -v git` each resolve to a file inside `shims/`. If any do not, it **aborts immediately with exit code 9**, prints why, and runs nothing. Every suite goes through `harness.sh`, so every suite and `run-all.sh` has this guard. (This was proven by deliberately removing a shim, and by taking away another's run permission: both aborted with exit 9 before any scratch folder or scenario was created.)

Do not copy these scripts or call the deploy scripts by hand "just to see" with the shims out of the way.

## Where things go

Nothing is hard-coded to one computer. The repo location comes from `git rev-parse`, this folder from the script's own location, and scratch files go in a fresh folder made with `mktemp` (or the folder named in `DEPLOY_TEST_WORK`; it must be outside the repo). Inside it, `repo/` is a throw-away clone of your **saved** git history with the current deploy scripts committed on top, `fake-server/` stands in for Sally, and `logs/<suite>/` holds the output and shim log of every scenario. Your real folder is only read (the clone). `run-all.sh` deletes its own scratch folder when everything passes, and keeps it (printing where) if anything fails, or when you set `DEPLOY_TEST_KEEP=1`. A suite run on its own always keeps its scratch folder and prints where.

## Files

- `run-all.sh` runs the five suites and prints the total.
- `harness.sh` shared setup, the shim guard, and the helpers every suite uses.
- `regress.sh`, `bugs.sh`, `extras.sh`, `fixes.sh`, `judgefix.sh` the suites.
- `realpreview.sh` optional and separate (not part of `run-all.sh`): a read-only preview of the **full** deploy against the **real** Sally, answering "n" at the question. Needs `ssh sally`; it shows what a deploy of the saved code would do right now. Look at `exit=` and the output file it names under the scratch folder's `logs/`.
- `ptyrun.py` runs a script inside a real pseudo-terminal and types the answers when the prompts appear (the scripts refuse to delete without a real terminal).
- `shims/` the stand-in rsync, ssh, git and fake-find (see above).
- `fixtures/deploy-guard-lib.sh.before-fixes` the older copy of the helper that `fixes.sh` (section L) uses as a "control", to prove its temp-folder check can actually see the problem it checks for.
