-- ============================================================
-- Migration: 20260821000000_content_engine_team_roles
-- Created:   2026-08-21
-- Author:    Neo (database specialist)
--
-- Part of folding Content Engine and Content Review into the Hub's
-- shared access system (approved by Peter). Extends the shared
-- team_member_tool_roles table (20260812020000_shared_team_members.sql)
-- to support a fifth Hub tool, same pattern already used for
-- security_deposit's onboarding (20260813000004), maintenance_
-- history's (20260815010000), and call_stats's (20260819020000).
--
-- Two changes, both using the DROP-then-ADD CONSTRAINT pattern every
-- prior widening of these constraints has used (Postgres has no ALTER
-- CONSTRAINT for widening a CHECK in place):
--
--   1. tool CHECK — add 'content_engine'. ONE value covers both the new
--      Content Engine panel (drafting) and the migrated-in Content
--      Review workflow (approve/reject) — per Oracle's plan, they're
--      two ends of one pipeline, not two separate access grants, so
--      they share a single tool value rather than getting one each.
--   2. role CHECK — add 'contributor', the new role this build needs
--      (someone who can draft/submit content but not approve/publish
--      it). 'admin' already exists on this CHECK and is reused as-is —
--      no change needed for that value; a content_engine team member
--      is either 'admin' or 'contributor', no other role value is ever
--      paired with tool='content_engine' by anything this build
--      creates.
--
-- ============================================================
-- LIVE STATE CHECK BEFORE WRITING THIS (this exact class of mistake —
-- widening a CHECK against a stale assumption of what's live — caused
-- a real regression on 2026-08-17/18, fixed in
-- 20260818000000_fix_role_check_regression.sql; not repeating it here)
-- ============================================================
-- This environment has no direct pg_constraint/information_schema
-- access via the REST API (same limitation noted in 20260818000000 and
-- 20260819020000) — live state below is reconstructed from the actual
-- files on disk plus a live data read, not assumed from any single
-- migration in isolation, including the two that already claim to be
-- current (20260818000000 for `role`, 20260819020000 for `tool`).
--
-- Grepped every migration file in supabase/migrations/ for any
-- reference to team_member_tool_roles_role_check or
-- team_member_tool_roles_tool_check. Exactly five files have ever
-- ALTERed either constraint, in this applied order:
--   1. 20260812020000 (original CREATE TABLE)
--        tool: ('insurance_compliance')
--        role: ('admin', 'director_of_operations', 'property_manager',
--               'inspection_coordinator')
--   2. 20260815010000 (maintenance_history) — applied BEFORE #3 below,
--      despite its later filename timestamp; see 20260818000000's own
--      incident writeup for why apply order differs from file-name
--      order here
--        tool: (..., 'security_deposit', 'maintenance_history') -> 3 values
--        role: (..., 'pod_lead', 'reviewer') -> 6 values
--   3. 20260813000004 (security_deposit) — applied 2026-08-17/18, after
--      #2. Its tool CHECK matched the already-live 3-value superset
--      (no regression). Its role CHECK only listed 5 values (missing
--      'reviewer', added after this file's draft was written) — this
--      silently narrowed live `role` back to 5, the regression fixed
--      next.
--   4. 20260818000000 (fix_role_check_regression) — restored `role` to
--      the full 6 values. Explicitly did NOT touch `tool` (verified
--      correct and untouched at 3 values as of that migration).
--   5. 20260819020000 (call_stats) — added 'call_stats' to `tool` only
--      (4 values). Explicitly did NOT touch `role` (confirmed still the
--      6-value set from #4).
--
-- A sixth file, 20260816000000_property_brain_claims_phase1.sql,
-- mentions team_member_tool_roles but only in documentation/precedent
-- comments ("unchanged by this migration") — confirmed by reading each
-- spot directly; it contains no ALTER on either constraint. Two more,
-- 20260813000001_lease_tenants.sql and 20260813000002_security_deposit_
-- cases.sql, also just mention the table in comments (mirroring its
-- shape for an unrelated table) — same confirmation, no ALTER.
--
-- Net result — the CURRENT live state, before this migration:
--   tool CHECK: ('insurance_compliance', 'maintenance_history',
--                'security_deposit', 'call_stats')
--   role CHECK: ('admin', 'director_of_operations', 'property_manager',
--                'inspection_coordinator', 'pod_lead', 'reviewer')
--
-- Cross-checked against live DATA (not just migration files) via a REST
-- read against the real database just before writing this file
-- (`GET /rest/v1/team_member_tool_roles?select=id,tool,role,granted_by`,
-- service-role key): 8 live rows, using only
-- tool IN ('insurance_compliance', 'maintenance_history',
-- 'security_deposit', 'call_stats') and
-- role IN ('admin', 'director_of_operations') — a strict subset of the
-- reconstructed superset above. No live row uses a value outside what's
-- already known, and no row uses 'content_engine' or 'contributor'
-- (expected — this migration is what introduces them).
--
-- Same DROP-then-ADD pattern as every prior widening of these
-- constraints (20260803000002_reviewer_workflow.sql; 20260813000004;
-- 20260815010000; 20260818000000; 20260819020000).
--
-- No new table, no new PII column — team_member_tool_roles already has
-- its own Rule 4 treatment (RLS enabled, locked down, documented in
-- 20260812020000). This migration only widens two CHECK constraints and
-- inserts one access row using an email that's already covered by that
-- table's existing PII inventory entry; nothing here needs a new data
-- inventory entry (same conclusion as 20260813000004 and 20260815010000
-- reached for their own, structurally identical changes).
--
-- Gate check (must pass before applying to any real database):
--   [x] Rollback exists — see bottom of this file
--   [x] No existing data is deleted or overwritten — all 8 live rows use
--       values that remain valid under the widened CHECKs; the one new
--       row this migration inserts targets a (team_member_id, tool) pair
--       that has no existing row (guarded by ON CONFLICT DO NOTHING
--       against the table's own UNIQUE(team_member_id, tool) constraint,
--       so re-running this migration is also safe)
--   [x] Touches team_member_tool_roles — shared across 5 Hub tools now
--       (insurance_compliance, maintenance_history, security_deposit,
--       call_stats, content_engine) — purely additive (widening CHECKs,
--       not narrowing either one)
--   [x] Additive only — no row is forced to change, no existing value
--       removed from either CHECK
--   [x] Fresh live-state check (full migration-history re-grep + REST
--       data read) performed immediately before writing this file, not
--       reused from an earlier session
--   [ ] Tested on a copy of Supabase before production apply — no
--       staging copy exists in this project, same caveat as every prior
--       migration here; mitigated by the live-state check above
-- ============================================================


-- ------------------------------------------------------------
-- tool CHECK — add 'content_engine'
-- ------------------------------------------------------------

ALTER TABLE team_member_tool_roles
  DROP CONSTRAINT IF EXISTS team_member_tool_roles_tool_check;

ALTER TABLE team_member_tool_roles
  ADD CONSTRAINT team_member_tool_roles_tool_check
  CHECK (tool IN (
    'insurance_compliance',
    'maintenance_history',
    'security_deposit',
    'call_stats',
    'content_engine'
  ));


-- ------------------------------------------------------------
-- role CHECK — add 'contributor'
-- ------------------------------------------------------------

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
    'reviewer',
    'contributor'
  ));


-- ------------------------------------------------------------
-- Seed Peter's own access so testing isn't blocked on him not having
-- access to his own new tool. Keyed by email via a subquery against
-- team_members (not a hardcoded UUID) — same identifier convention
-- already used for every other manually-granted row in this table
-- (confirmed via the same live REST read above: e.g. the
-- security_deposit/director_of_operations and maintenance_history/admin
-- rows both use granted_by='peter@rinconmanagement.com'). ON CONFLICT
-- guards against this statement ever creating a duplicate (team_member_
-- id, tool) row if this migration is re-run.
-- ------------------------------------------------------------

INSERT INTO team_member_tool_roles (team_member_id, tool, role, granted_by)
SELECT id, 'content_engine', 'admin', 'system'
FROM team_members
WHERE email = 'peter@rinconmanagement.com'
ON CONFLICT (team_member_id, tool) DO NOTHING;


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
-- Only safe to roll back if no row has been written with
-- tool='content_engine' or role='contributor' OTHER than the single
-- seed row this migration inserts (which the DELETE below removes
-- first) — restoring the narrower CHECKs will fail against any other
-- row that violates them.
--
-- DELETE FROM team_member_tool_roles
--   WHERE tool = 'content_engine'
--     AND granted_by = 'system'
--     AND team_member_id = (SELECT id FROM team_members WHERE email = 'peter@rinconmanagement.com');
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
--     'pod_lead',
--     'reviewer'
--   ));
--
-- ALTER TABLE team_member_tool_roles
--   DROP CONSTRAINT IF EXISTS team_member_tool_roles_tool_check;
-- ALTER TABLE team_member_tool_roles
--   ADD CONSTRAINT team_member_tool_roles_tool_check
--   CHECK (tool IN (
--     'insurance_compliance',
--     'maintenance_history',
--     'security_deposit',
--     'call_stats'
--   ));
--
-- ============================================================
