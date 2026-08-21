-- ============================================================
-- Migration: 20260819020000_call_stats_team_roles
-- Created:   2026-08-19
-- Author:    Neo (database specialist)
--
-- Part of the Aircall Call Stats build (projects/hub/call-stats/
-- SPEC.md, "Access / Roles in the Hub" section). Extends the shared
-- team_member_tool_roles table (20260812020000_shared_team_members.sql)
-- to support a fourth Hub tool, same pattern used for
-- security_deposit's own onboarding
-- (20260813000004_security_deposit_team_roles.sql) and maintenance_
-- history's (20260815010000_maintenance_history_schema.sql).
--
-- ONE change only, smaller than every prior tool's onboarding:
--   - tool CHECK — add 'call_stats' alongside the three existing
--     values.
--
-- No role CHECK change needed. Per the spec: v1 access is deliberately
-- flat, reusing the two roles that already exist rather than inventing
-- a new one — 'admin' and 'pod_lead' are both already live values on
-- team_member_tool_roles.role (pod_lead was added for security_deposit
-- in 20260813000004; both survive intact through the most recent
-- change to this constraint, 20260818000000_fix_role_check_regression.
-- sql). Anyone holding either role for tool='call_stats' sees BOTH
-- pods' numbers in v1 — the exact same simplification already shipped
-- for security_deposit's pod_lead (confirmed in
-- security-deposit/router.js: "Every active pod_lead role holder gets
-- every reminder in v1 — no per-property pod routing yet"). This build
-- reuses that already-accepted limitation rather than building new
-- pod-scoped visibility for itself.
--
-- ============================================================
-- LIVE STATE CHECK BEFORE WRITING THIS (this exact class of mistake —
-- widening a CHECK against a stale assumption of what's live — caused
-- a real regression on 2026-08-17/18, fixed in
-- 20260818000000_fix_role_check_regression.sql; not repeating it here)
-- ============================================================
-- Read live rows directly via the Supabase REST API just before
-- writing this file (`GET /rest/v1/team_member_tool_roles?select=
-- tool,role`, service-role key): 6 live rows, using only
-- tool IN ('insurance_compliance', 'maintenance_history',
-- 'security_deposit') and role IN ('admin', 'director_of_operations')
-- — a strict subset of both the tool list and the role list declared
-- below and in every prior migration. No live row uses a value outside
-- what's already known.
--
-- Cross-checked against every migration that has ever touched either
-- constraint (20260812020000 original CREATE TABLE, 20260813000004,
-- 20260815010000, 20260818000000 — the same four files
-- 20260818000000's own postmortem enumerated as the complete set).
-- Their union for `tool` is exactly the 3 values already live
-- (insurance_compliance, maintenance_history, security_deposit) — no
-- tool-side regression has ever occurred, per 20260818000000's own
-- explicit note that only `role` drifted, not `tool`. This migration
-- adds a 4th value to that already-correct list; it does not touch
-- `role` at all, so it cannot re-introduce the role-side regression
-- either.
--
-- This environment has no direct pg_constraint/information_schema
-- access (same limitation noted in 20260818000000) — live state here
-- is confirmed via a REST read of the actual data plus a full-repo
-- migration-history reconstruction, not assumed from a single file in
-- isolation.
--
-- Same DROP-then-ADD pattern as every prior widening of this
-- constraint — Postgres has no ALTER CONSTRAINT for widening a CHECK
-- in place.
--
-- Gate check (must pass before applying to any real database):
--   [x] Rollback exists — see bottom of this file
--   [x] No existing data is deleted or overwritten — all 6 live rows
--       use values that remain valid under the widened CHECK
--   [x] Touches team_member_tool_roles — shared across 4 Hub tools now
--       — but purely additive (widening a CHECK, not narrowing one)
--   [x] Additive — no row is forced to change
--   [x] Fresh live-state check (REST read + full migration-history
--       re-grep) performed immediately before writing this file
--   [ ] Tested on a copy of Supabase before production apply — no
--       staging copy exists in this project, same caveat as every
--       migration here; mitigated by the live-state check above
-- ============================================================


ALTER TABLE team_member_tool_roles
  DROP CONSTRAINT IF EXISTS team_member_tool_roles_tool_check;

ALTER TABLE team_member_tool_roles
  ADD CONSTRAINT team_member_tool_roles_tool_check
  CHECK (tool IN (
    'insurance_compliance',
    'maintenance_history',
    'security_deposit',
    'call_stats'
  ));


-- No changes below this line — role CHECK is untouched. Current live
-- definition (set by 20260818000000, confirmed still current above)
-- remains: role IN ('admin', 'director_of_operations',
-- 'property_manager', 'inspection_coordinator', 'pod_lead', 'reviewer').


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
-- Only safe to roll back if no row has been written with
-- tool='call_stats' yet — restoring the narrower CHECK will fail
-- against any row that violates it.
--
-- ALTER TABLE team_member_tool_roles
--   DROP CONSTRAINT IF EXISTS team_member_tool_roles_tool_check;
-- ALTER TABLE team_member_tool_roles
--   ADD CONSTRAINT team_member_tool_roles_tool_check
--   CHECK (tool IN (
--     'insurance_compliance',
--     'maintenance_history',
--     'security_deposit'
--   ));
--
-- ============================================================
