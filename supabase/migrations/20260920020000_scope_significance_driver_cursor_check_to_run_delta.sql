-- ============================================================
-- Migration: 20260920020000_scope_significance_driver_cursor_check_to_run_delta
-- Created:   2026-09-20
-- Author:    Neo (database specialist) — design; Q (builder) — this file
--
-- WHY THIS EXISTS (Neo's review of Q's original Fix #2, REJECTED as
-- originally designed)
-- ============================================================
-- 20260920010000 added archive_search_missive_clear_branch_cursor_check(
-- p_cursor_id) — a live digest of every clear-branch row WHERE id <=
-- p_cursor_id, used both to VERIFY a saved cursor before trusting it
-- (resolveDriverStartCursor(), significance-pass.js) and to PERSIST a new
-- one at the end of every run (persistDriverCursor()).
--
-- Q's original plan for a follow-up "time-bound" fix applied
-- `screening_completed_at <= run_started_at` to the ENTIRE id <= cursor
-- range, on every run, at persist time. Neo's objection: screening-pass.js's
-- markConversationScreened() re-screens an ENTIRE conversation thread
-- whenever any new reply arrives — `.eq('missive_conversation_id',
-- conversationId)` with no per-row filter — so it routinely bumps
-- screening_completed_at forward on old, already-verified 'clear' rows that
-- never actually changed risk status. A global time-bound applied to that
-- old region too means a long-running full walk has a real chance of
-- overlapping with one of these routine touches, which would incorrectly
-- exclude an already-safe row from the persisted digest, cause the NEXT
-- run's verification to mismatch, force another full walk (long enough to
-- hit the same thing again), and get the fast-forward optimization stuck
-- permanently off — a silent, unexplained performance regression back to
-- the original 10-17s/page problem this entire migration family exists to
-- fix. Never an error, so nobody would notice until performance quietly
-- degraded.
--
-- ============================================================
-- THE FIX — scope the time-bound to only the territory THIS RUN newly
-- swept, not the whole cumulative range
-- ============================================================
-- Two new, optional parameters, both defaulting to NULL so every EXISTING
-- caller (and every caller that only ever passes p_cursor_id) keeps today's
-- exact behavior, unchanged:
--   p_established_floor_id — the cursor THIS RUN started from (its "floor").
--     Rows at or below the floor are OLD territory this run never re-swept
--     this pass — never subject to the time-bound. Rows above the floor (up
--     to p_cursor_id) are NEW territory this run actually walked — those
--     alone are checked against p_as_of.
--   p_as_of — this run's own start time (run_started_at). Only applied to
--     the new-territory rows above.
--
-- WHERE clause, read as three OR'd escape hatches:
--   p_as_of IS NULL
--     -> the original, unscoped behavior (verification call site — see
--        "WIRING" below): every existing caller that never passes p_as_of
--        gets the identical query 20260920010000 shipped, byte for byte.
--   p_established_floor_id IS NOT NULL AND id <= p_established_floor_id
--     -> OLD territory (already covered by an earlier run, never touched by
--        this run's own screening-completion timing) always counts, time-
--        bound or not.
--   screening_completed_at <= p_as_of
--     -> NEW territory (id > floor, i.e. what THIS run actually walked) only
--        counts if it was screened before this run started — filtering out
--        exactly the routine re-screen-on-reply bump Neo's review caught.
--
-- On a genuine first-ever run (floor = NULL), the middle clause can never
-- match (it requires p_established_floor_id IS NOT NULL), so the whole
-- WHERE degenerates to the plain global time-bound — correct there, since
-- the entire walked range really is new territory that run.
--
-- ============================================================
-- WHY THIS FILE ALSO DROPS THE OLD 1-ARGUMENT OVERLOAD (found while
-- implementing Neo's design, not part of Neo's own SQL as handed off — a
-- real correctness gap in translating the design to a deployable migration,
-- fixed here rather than merely flagged)
-- ============================================================
-- Neo's design is `CREATE OR REPLACE FUNCTION
-- archive_search_missive_clear_branch_cursor_check(p_cursor_id UUID,
-- p_established_floor_id UUID DEFAULT NULL, p_as_of TIMESTAMPTZ DEFAULT
-- NULL)`. In Postgres, CREATE OR REPLACE only replaces a function with the
-- IDENTICAL argument-type list — a 3-argument signature does not replace
-- 20260920010000's existing 1-argument one, it OVERLOADS it. Left as-is,
-- the database would end up with TWO functions of the same name: one taking
-- (UUID), one taking (UUID, UUID DEFAULT NULL, TIMESTAMPTZ DEFAULT NULL). A
-- call passing only p_cursor_id (exactly what the verification call site —
-- resolveDriverStartCursor() — does, and exactly what
-- persistDriverCursor()'s pre-this-migration call already did) becomes
-- ambiguous between the two: Postgres/PostgREST cannot tell which one to
-- use and raises "function ... is not unique" (42725 / PGRST203) at call
-- time, breaking the FIRST verification call this migration is applied
-- before any application-code change even ships. This migration therefore
-- explicitly DROPs the old 1-argument overload before creating the new
-- 3-argument one, so exactly one candidate function exists at every point
-- in time. This does not touch 20260920010000's own file — that migration's
-- CREATE is superseded here, in a new file, per this migration family's own
-- "ship as a new migration, never edit an already-applied one" convention.
--
-- ============================================================
-- WIRING (application code — significance-pass.js, Q's build on top of this
-- migration, not made here)
-- ============================================================
--   Verification call site (resolveDriverStartCursor -> fetchClearBranchDigest,
--   called with no floor/as_of): p_established_floor_id and p_as_of both
--   NULL -> collapses to exactly 20260920010000's original, unrestricted
--   query -- stays fully live, so it keeps catching a genuine Gap 1 reset
--   anywhere in the already-covered range, unchanged.
--
--   Persist call site (persistDriverCursor, inside
--   fetchNextEligibleConversations): p_cursor_id = this run's final cursor;
--   p_established_floor_id = the cursor this run STARTED from, captured into
--   its own variable (startingCursorFloor) before the pagination loop
--   mutates lastId -- lastId itself ends the loop pointing at the final
--   cursor, never the starting one; p_as_of = this run's own run_started_at,
--   captured once at the top of the same function call.
--
-- No new column needed on archive_search_significance_driver_cursors --
-- floor and run_started_at are transient, in-memory values for the RPC call
-- only, never persisted themselves (only their downstream effect on the
-- digest is).
--
-- ============================================================
-- CORRECTNESS
-- ============================================================
-- This changes ONLY which rows are treated as "must have been screened
-- before this run" when computing the persisted digest at the END of a run
-- -- it never changes which rows the underlying view returns, and it never
-- changes the verification query's own behavior (always called with both
-- new parameters NULL, so byte-for-byte identical to 20260920010000's
-- original single-argument query). A digest computed this way is still a
-- faithful, live snapshot of "every row that should count as confirmed
-- as of right now" -- it simply no longer double-counts an old, routinely-
-- re-touched row's screening_completed_at bump against a time-bound that
-- was never meant to apply to it.
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist)
-- ============================================================
--   [x] Rollback exists -- see bottom of this file.
--   [x] Does this break any existing data? No. This replaces one function
--       definition and, having reasoned through the overload hazard above,
--       drops one now-superseded overload of the same function -- no table,
--       row, or column is touched.
--   [x] Does this touch a table other code depends on? No. This is a
--       read-only (STABLE, SQL, no writes) function over the same two
--       relations (missive_message_intake_search_safe_clear_branch,
--       implicitly via id comparison only -- no new column read) the prior
--       version already read. Callers unaffected until Q's driver-code
--       change (in the same build) actually passes the two new parameters
--       at the persist call site -- the verification call site is
--       byte-for-byte unchanged.
--   [x] Additive or destructive? Net additive (a strictly more capable
--       function, old behavior fully preserved via NULL defaults), with one
--       explicit DROP of a now-redundant overload to avoid the ambiguity
--       hazard explained above -- not a removal of any capability, since
--       the 3-argument version called with 1 argument reproduces the
--       1-argument version exactly.
--   [x] Tested on a copy of the data first? No staging copy of Supabase
--       exists in this project -- same standing caveat every migration here
--       carries. Mitigated by: this function is STABLE/read-only and cannot
--       corrupt anything; the verification call site's query shape is
--       provably unchanged (both new parameters NULL, degenerating to the
--       original WHERE clause); and this is a compliance build (touches the
--       Fair-Housing escalation-exclusion/clear-branch cursor mechanism) --
--       per CLAUDE.md's Governance section this does not run against
--       production and is not handed to Peter until Asimov, then TARS, then
--       Judge have all cleared it. All three have now signed off -- see
--       below and compliance/archive-search-significance-cursor-run-delta-
--       asimov-review.md.
--   [x] Governance go-ahead -- OBTAINED. Asimov reviewed this change and
--       cleared it APPROVED TO ACTIVATE: confirmed it does not alter what
--       gets excluded from the clear branch, who decides an exclusion, or
--       when a human sees an escalation -- the escalation-digest snapshot-
--       timing fix is a strict improvement (closes a gap) rather than a new
--       risk. No Mason review required -- nothing here is tenant-facing.
--       Full findings: compliance/archive-search-significance-cursor-run-
--       delta-asimov-review.md.
--
--       TARS then wrote and ran two new repro tests in
--       projects/hub/archive-search/test/run-tests.js: the original
--       null-cursor, 2-page race ("a low-id 'clear' row injected BETWEEN two
--       pages of the SAME first-ever (null-cursor) run..."), and a second
--       case the original repro didn't cover -- a race row landing inside a
--       FAST-FORWARD run's own new-territory delta ("a low-id 'clear' row
--       injected into a FAST-FORWARD run's own NEW-TERRITORY delta (between
--       its floor and its new cursor)..."). Both confirmed to FAIL without
--       this migration's fix and PASS with it (not vacuous). Full suite:
--       276/276 passing, run 55 times with zero flakiness introduced.
--
--       Judge independently verified by reverting just the floor/as_of
--       scoping in this file and rerunning the suite -- confirmed exactly
--       the two race-condition tests above fail and nothing else does, then
--       restored the fix and reconfirmed 276/276. Verdict: CONDITIONAL
--       APPROVAL, cleared to ship once two documentation fixes landed (this
--       checklist, and the Asimov review record referenced above) -- both
--       now done.
-- ============================================================

DROP FUNCTION IF EXISTS archive_search_missive_clear_branch_cursor_check(UUID);

CREATE OR REPLACE FUNCTION archive_search_missive_clear_branch_cursor_check(
  p_cursor_id UUID,
  p_established_floor_id UUID DEFAULT NULL,
  p_as_of TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (row_count BIGINT, digest TEXT)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    COUNT(*)::BIGINT AS row_count,
    md5(COALESCE(string_agg(id::text, ',' ORDER BY id ASC), '')) AS digest
  FROM missive_message_intake_search_safe_clear_branch
  WHERE id <= p_cursor_id
    AND (
      p_as_of IS NULL
      OR (p_established_floor_id IS NOT NULL AND id <= p_established_floor_id)
      OR screening_completed_at <= p_as_of
    );
$$;

REVOKE ALL ON FUNCTION archive_search_missive_clear_branch_cursor_check(UUID, UUID, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION archive_search_missive_clear_branch_cursor_check(UUID, UUID, TIMESTAMPTZ) TO service_role;

COMMENT ON FUNCTION archive_search_missive_clear_branch_cursor_check(UUID, UUID, TIMESTAMPTZ) IS
  'Live COUNT and md5 digest of every row id in missive_message_intake_search_safe_clear_branch WHERE id <= p_cursor_id, same as 20260920010000''s original single-argument version, PLUS an optional run-delta time-bound: when p_as_of is given, rows at or below p_established_floor_id (this run''s STARTING cursor -- old, already-covered territory) always count regardless of screening_completed_at, while rows above the floor (new territory this run itself swept) only count if screening_completed_at <= p_as_of (this run''s own start time). This is deliberately narrower than a global time-bound applied to the whole id<=cursor range -- see this file''s own header for why a global bound is unsafe (screening-pass.js''s markConversationScreened() routinely re-stamps screening_completed_at on old, unchanged ''clear'' rows whenever their conversation gets a new reply, which a global bound would wrongly treat as a below-cursor change and permanently disable the fast-forward optimization). Call with p_established_floor_id and p_as_of both NULL (or omitted) for the original, unrestricted verification behavior -- this is what resolveDriverStartCursor() always does. Call with real floor/as_of values only at persist time (persistDriverCursor()), scoped to the run that just executed. service_role only -- EXECUTE revoked from PUBLIC. Superseded 20260920010000''s single-argument overload of the same name, which this migration explicitly DROPs to avoid an ambiguous-function-call error (Postgres does not treat a 3-argument-with-defaults CREATE OR REPLACE as replacing a distinct 1-argument signature -- both would otherwise coexist and a 1-argument call would become ambiguous between them).';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP FUNCTION IF EXISTS archive_search_missive_clear_branch_cursor_check(UUID, UUID, TIMESTAMPTZ);
--
-- -- Restores 20260920010000's original single-argument function --
-- -- confirm significance-pass.js's fetchClearBranchDigest() has also been
-- -- reverted to call with only p_cursor_id before (or immediately after)
-- -- rolling this back, or the driver code's persist call site will pass
-- -- p_established_floor_id/p_as_of to a function that no longer accepts
-- -- them and every persistDriverCursor() call will fail (caught, logged,
-- -- non-fatal -- see that function's own header -- but every run will lose
-- -- its fast-forward from that point on until the code is reverted too).
-- CREATE OR REPLACE FUNCTION archive_search_missive_clear_branch_cursor_check(p_cursor_id UUID)
-- RETURNS TABLE (row_count BIGINT, digest TEXT)
-- LANGUAGE sql
-- STABLE
-- SET search_path = public
-- AS $$
--   SELECT
--     COUNT(*)::BIGINT AS row_count,
--     md5(COALESCE(string_agg(id::text, ',' ORDER BY id ASC), '')) AS digest
--   FROM missive_message_intake_search_safe_clear_branch
--   WHERE id <= p_cursor_id;
-- $$;
--
-- REVOKE ALL ON FUNCTION archive_search_missive_clear_branch_cursor_check(UUID) FROM PUBLIC;
-- GRANT EXECUTE ON FUNCTION archive_search_missive_clear_branch_cursor_check(UUID) TO service_role;
--
-- ============================================================
