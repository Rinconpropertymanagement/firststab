-- ============================================================
-- Migration: 20260818000000_fix_role_check_regression
-- Created:   2026-08-18
-- Author:    Neo (database specialist)
--
-- Fixes a real regression introduced by applying
-- 20260813000004_security_deposit_team_roles.sql against the live
-- database on 2026-08-17/18. Full incident, for anyone reading this later:
--
--   1. 20260813000004 was WRITTEN on 2026-08-13, when the only known live
--      value on team_member_tool_roles.role was the original 4
--      (admin, director_of_operations, property_manager,
--      inspection_coordinator). It widened the `role` CHECK to add
--      'pod_lead' — 5 values total.
--   2. Before that file was actually APPLIED, a second, concurrent
--      migration — 20260815010000_maintenance_history_schema.sql — was
--      written and applied. That file correctly read 20260813000004's
--      not-yet-applied draft and built a proper superset: it widened
--      `role` to 6 values (the original 4, PLUS 'pod_lead' from
--      20260813000004's draft, PLUS its own new 'reviewer'). At this
--      point the LIVE constraint correctly had all 6 values.
--   3. On 2026-08-17/18, 20260813000004 was finally applied (after being
--      corrected for an unrelated `tool`-CHECK collision with
--      'maintenance_history' — see that file's own inline correction
--      note). Its `role` CHECK statement had not been refreshed since
--      step 1 and still only listed 5 values — no 'reviewer'. Because no
--      live row used role='reviewer' yet, this ADD CONSTRAINT did not
--      error — it silently succeeded and narrowed the live constraint
--      back down to 5 values, undoing step 2's fix without any error to
--      signal it.
--   4. Caught during post-apply verification (checked
--      20260815010000's already-applied CHECK definition against
--      20260813000004's, noticed the mismatch, flagged it as unconfirmed
--      since this environment has no pg_constraint/information_schema
--      access via the REST API). Confirmed for certain via
--      `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE
--      conrelid = 'team_member_tool_roles'::regclass AND contype = 'c';`
--      run directly against the live database: 'reviewer' was indeed
--      missing.
--
-- RE-VERIFIED FRESH before writing this fix (not reused from the earlier
-- check — same reasoning that caused the original miss: live state can
-- drift between when something is known and when a fix is actually
-- written):
--   - `SELECT DISTINCT role FROM team_member_tool_roles` run again just
--     now: only 'admin' is in use (2 rows total, both admin — Peter on
--     insurance_compliance and maintenance_history). No new role values
--     appeared since the last check.
--   - Grepped every file in supabase/migrations/ (not just the ones
--     already known) for any reference to
--     team_member_tool_roles_role_check or
--     team_member_tool_roles_tool_check. Exactly three files have ever
--     touched either constraint: 20260812020000 (original CREATE TABLE),
--     20260813000004 (this migration's cause), and 20260815010000
--     (maintenance_history's fix-that-got-undone). One other file,
--     20260816000000_property_brain_claims_phase1.sql, mentions
--     team_member_tool_roles twice — both confirmed, by reading each
--     spot directly, to be documentation/precedent comments only
--     ("unchanged by this migration, no new tool/role value added
--     here") — it does not ALTER either constraint. No fourth,
--     previously-unknown change exists.
--   - The union of every role value any of those three files has ever
--     declared is exactly the 6 listed in the CHECK below — nothing
--     more, nothing assumed beyond what's actually on disk plus what's
--     actually live.
--
-- SCOPE: this migration touches `role` ONLY. The `tool` CHECK
-- (insurance_compliance, security_deposit, maintenance_history) was
-- independently verified correct and live during the same pass — both
-- 20260813000004 and 20260815010000 declared the identical 3-value set
-- for `tool`, so there was never a `tool`-side regression, only a
-- `role`-side one. Deliberately not re-running a DROP+ADD on `tool` here
-- — it isn't broken, and touching a working constraint adds risk without
-- fixing anything.
--
-- Same DROP-then-ADD pattern as every prior widening of this constraint
-- (20260803000002_reviewer_workflow.sql; 20260813000004; 20260815010000)
-- — Postgres has no ALTER CONSTRAINT for widening a CHECK in place.
--
-- Gate check (must pass before applying to any real database):
--   [x] Rollback exists — see bottom of this file
--   [x] No existing data is deleted or overwritten — the only 2 live
--       rows both use role='admin', which is in every version of this
--       CHECK that has ever existed; neither row is affected
--   [x] Touches team_member_tool_roles — shared across 3 Hub tools now
--       (insurance_compliance, maintenance_history, security_deposit) —
--       purely additive (restoring a value, not narrowing)
--   [x] Fresh live-state + full-repo re-check performed immediately
--       before writing this file, not reused from an earlier session
--   [x] Should be tested on a copy of Supabase before production apply —
--       same caveat as every migration in this project; no staging copy
--       exists here, same as the prior 5
-- ============================================================


ALTER TABLE team_member_tool_roles
  DROP CONSTRAINT IF EXISTS team_member_tool_roles_role_check;

ALTER TABLE team_member_tool_roles
  ADD CONSTRAINT team_member_tool_roles_role_check
  CHECK (role IN (
    'admin',
    'director_of_operations',
    'property_manager',
    'inspection_coordinator',
    'pod_lead',
    'reviewer'
  ));


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
-- Only safe to roll back if no row has been written with role='reviewer'
-- since this migration applied — restoring the narrower CHECK will fail
-- against any row that violates it. Rolling back would re-introduce the
-- exact regression this migration fixes — check with maintenance_history
-- before ever doing this.
--
-- ALTER TABLE team_member_tool_roles
--   DROP CONSTRAINT IF EXISTS team_member_tool_roles_role_check;
-- ALTER TABLE team_member_tool_roles
--   ADD CONSTRAINT team_member_tool_roles_role_check
--   CHECK (role IN (
--     'admin',
--     'director_of_operations',
--     'property_manager',
--     'inspection_coordinator',
--     'pod_lead'
--   ));
--
-- ============================================================
