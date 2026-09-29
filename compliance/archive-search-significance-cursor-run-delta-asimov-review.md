# Asimov — Governance Review: Cursor Run-Delta Scoping Fix

**Date:** 2026-09-20. Reviews migration
`supabase/migrations/20260920020000_scope_significance_driver_cursor_check_to_run_delta.sql`
and its wiring in `projects/hub/archive-search/lib/significance-pass.js`
(`fetchClearBranchDigest`, `persistDriverCursor`, `fetchNextEligibleConversations`).
This is a review of a bug fix to an already-approved mechanism, not a new feature —
see `compliance/archive-search-significance-final-asimov-clearance.md` and
`compliance/archive-search-escalation-mechanism-review.md` for the original
clearance of the resumable-cursor / fast-forward design this migration patches.

## What changed

**The bug.** Migration `20260920010000` introduced
`archive_search_missive_clear_branch_cursor_check(p_cursor_id)`, a live digest
(row count + md5 of ids) of the clear-branch view at or below a saved cursor,
used both to verify a saved cursor before trusting it and to persist a new one
at the end of every run. Q's original follow-up design applied a global
`screening_completed_at <= run_started_at` time-bound to the *entire*
`id <= cursor` range at persist time. Neo's review caught that
`screening-pass.js`'s `markConversationScreened()` re-screens a whole
conversation thread on any new reply, routinely bumping
`screening_completed_at` forward on old, already-verified `clear` rows that
never changed risk status. A global time-bound would then have a real chance
of misreading one of those routine touches as new activity during a
long-running full walk, wrongly excluding an already-safe row from the
persisted digest, and getting the fast-forward optimization stuck off — a
silent performance regression, never an error, with no user-facing symptom to
flag it.

**The fix.** This migration changes the RPC's signature — from one required
argument (`p_cursor_id`) to that same argument plus two new *optional*
parameters, both defaulting to `NULL`:
`p_established_floor_id` (the cursor this run started from) and `p_as_of`
(this run's own start time). The WHERE clause only applies the time-bound to
rows *above* the floor — the new territory this run itself swept — and never
to rows at or below it. Old territory always counts regardless of timing, so
the routine re-screen-on-reply bump Neo flagged can no longer suppress a
safe, already-covered row. On the existing verification call site
(`resolveDriverStartCursor`), both new parameters are always `NULL`, which
collapses the WHERE clause back to `20260920010000`'s original, unscoped
query — byte-for-byte unchanged. The migration also drops the old
1-argument overload of the function (a Postgres `CREATE OR REPLACE`
mechanics detail — a 3-argument signature with defaults *overloads* rather
than replaces a distinct 1-argument one, which would otherwise leave two
candidate functions and make every 1-argument call ambiguous) — a
correctness gap found while implementing Neo's design, not part of Neo's SQL
as handed off, fixed in this file rather than merely flagged.

`significance-pass.js`'s driver code was updated to match: `persistDriverCursor`
now threads a captured `startingCursorFloor` (this run's cursor *before* the
pagination loop advances it) and `runStartedAt` (captured once at the top of
the run) through to `fetchClearBranchDigest`, which passes them to the RPC as
`establishedFloorId`/`asOf`. The verification call site is untouched.

## Why this is a compliance build

This mechanism sits inside the Fair-Housing-adjacent escalation-exclusion
pipeline covered by migrations `20260912030000`, `20260912040000`, and
`20260912050000` (the escalation lifecycle and its exclusion set) and by
`20260920010000` (the resumable-cursor fast-forward this migration patches).
The clear-branch digest this RPC computes is one of the two correctness
proofs (alongside the escalation-exclusion digest) that gate whether the
significance driver is allowed to skip re-walking part of the screening
pool on a given run. Any change to how that digest is computed touches the
same correctness safeguard governance review exists to protect, even when
the change is a bug fix rather than new functionality — per CLAUDE.md's
Governance section, that makes it a compliance build requiring my review
before it ships.

## Findings

**No change to what gets excluded, who decides, or when a human sees an
escalation.** This migration touches only the clear-branch cursor digest —
it does not read, write, or reference `archive_search_escalations`, its
status/reopened_at lifecycle, or the human-review/escalation-digest path at
all. The set of conversations that get excluded from the significance
driver's walk (via the escalation-exclusion digest, unchanged in this
migration), the criteria for who decides an exclusion, and the timing at
which a human sees an escalation are all identical before and after this
change. What changes is narrower and purely internal: which below-cursor
*clear-branch* rows are treated as "confirmed as of right now" when deciding
whether a saved cursor can be trusted to fast-forward past them — a
performance/correctness optimization, not a screening or exclusion decision.

**RPC backward-compatibility confirmed by repo-wide grep, not assumption.** I
grepped the full repository (excluding `node_modules`) for
`archive_search_missive_clear_branch_cursor_check` and confirmed the only
production caller of this RPC is `fetchClearBranchDigest()` in
`projects/hub/archive-search/lib/significance-pass.js` (line 1161). No other
script, route, or scheduled job calls it. The verification call site
(`resolveDriverStartCursor` → `fetchClearBranchDigest`, called with no
floor/as-of) always passes both new parameters as `NULL`, which the SQL's own
`p_as_of IS NULL` branch degenerates back to the exact query
`20260920010000` originally shipped — so the one caller that matters for the
live Fair-Housing-relevant verification path is provably unaffected in
behavior, not merely unaffected in code. The only caller that exercises the
new, narrower parameters is the persist path
(`persistDriverCursor`/`fetchNextEligibleConversations`), which is where the
bug lived.

**The escalation-digest snapshot-timing fix closes a gap rather than opening
one.** Before this migration, a long-running full walk had a real (if
silent) chance of a routine screening re-stamp on an old, unchanged `clear`
row causing the fast-forward optimization to get stuck permanently off —
never wrong in a Fair-Housing sense (a disabled fast-forward just means a
slower, still-complete full walk every time), but a correctness safeguard
degrading in a way nobody would notice. This fix makes the persisted digest
a more accurate reflection of "what this run actually confirmed," without
weakening the check in the other direction: old territory (already covered
before this run started) is still always counted, and new territory is only
ever excluded from the persisted digest when it clears the review flagged
by the two TARS repro tests (a row racing in after the run's own
verification/start but before persist) — the exact case a stale digest could
otherwise miss. Net effect: the same safety property `20260920010000` was
designed to guarantee, computed more precisely, with no new failure mode
introduced. I confirmed this by reading the WHERE clause directly (three
OR'd branches: unscoped-when-NULL, always-count-below-floor,
time-bound-only-above-floor) rather than relying on the migration's own
prose description of it.

## Verdict

**APPROVED TO ACTIVATE.** This migration and its `significance-pass.js`
wiring may be applied to production once Peter runs the migration himself
via the Supabase SQL Editor, per this repo's standing process. No Mason
review required — nothing in this change is tenant-facing, sends any
message, or affects a housing decision; it is an internal correctness fix to
a cursor-caching optimization sitting behind an already-approved screening
and exclusion mechanism. This clearance does not re-open or re-decide
anything already on record for the underlying escalation-exclusion design
(see the migrations and compliance files named above) — it covers only the
scoping change in `20260920020000` and its driver-code wiring.

— Asimov
