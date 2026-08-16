-- ============================================================
-- Migration: 20260813000004_security_deposit_team_roles
-- Created:   2026-08-13
-- Author:    Neo (database specialist)
--
-- Part of the Security Deposit Disposition Assembly Tool build
-- (projects/hub/security-deposit/SPEC.md, item #6 — permission table
-- extension). Extends the shared team_member_tool_roles table
-- (20260812020000_shared_team_members.sql) to support a second Hub tool,
-- exactly as that migration's own header comment anticipated: "When a
-- second tool joins the hub with its own roles, extend the `tool` CHECK
-- below in a NEW migration — never edit this one." This is that
-- migration.
--
-- Two changes, both using the DROP-then-ADD CONSTRAINT pattern already
-- proven in 20260803000002_reviewer_workflow.sql (Postgres requires
-- dropping a CHECK before re-adding it with new allowed values —
-- there's no ALTER CONSTRAINT for widening a CHECK in place):
--
--   1. tool CHECK — add 'security_deposit' alongside the existing
--      'insurance_compliance'.
--   2. role CHECK — add 'pod_lead', this tool's primary reviewer role.
--      Per the spec: "The role CHECK is shared across all tools
--      (role<->tool pairing is enforced by the UNIQUE(team_member_id,
--      tool) constraint, not by the CHECK), so 'admin' can be reused
--      as-is for this tool." 'pod_lead' is the only genuinely new role
--      value needed — the security-deposit tool does not need its own
--      version of director_of_operations, property_manager, or
--      inspection_coordinator (those stay meaningful only for
--      insurance_compliance; a security-deposit team member is either
--      'admin' or 'pod_lead', per the spec's role usage — no other role
--      value is ever paired with tool='security_deposit' by anything
--      this build creates).
--
-- Both constraint names below are Postgres's auto-generated names for an
-- inline column CHECK (<table>_<column>_check) — the same convention
-- already documented and relied on in
-- 20260720000001_nullable_fks.sql ("PostgreSQL auto-names this inline
-- CHECK as 'properties_unit_count_check'") and used directly in
-- 20260803000002_reviewer_workflow.sql
-- ('property_insurance_status_check'). Confirmed against
-- 20260812020000_shared_team_members.sql's actual CREATE TABLE
-- statement (both CHECKs are inline, unnamed) rather than assumed.
--
-- No new table, no PII change — team_member_tool_roles already exists
-- and already has its own Rule 4 treatment (RLS enabled, locked down,
-- documented in its own migration). This migration only widens two
-- CHECK constraints; nothing here needs a new data inventory entry.
--
-- Gate check (must pass before applying to any real database):
--   [x] Rollback exists — see bottom of this file
--   [x] No existing data is deleted or overwritten — existing rows
--       (today: only tool='insurance_compliance', role in the original
--       4 values) remain valid under the widened CHECKs
--   [x] Touches team_member_tool_roles — shared across Hub tools, but
--       purely additive (widening a CHECK, not narrowing one)
--   [x] Additive — no row is forced to change
--   [x] Should be tested on a copy of Supabase before production apply
-- ============================================================


-- ------------------------------------------------------------
-- tool CHECK — add 'security_deposit'
-- ------------------------------------------------------------

ALTER TABLE team_member_tool_roles
  DROP CONSTRAINT IF EXISTS team_member_tool_roles_tool_check;

ALTER TABLE team_member_tool_roles
  ADD CONSTRAINT team_member_tool_roles_tool_check
  CHECK (tool IN (
    'insurance_compliance',
    'security_deposit'
  ));


-- ------------------------------------------------------------
-- role CHECK — add 'pod_lead'
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
    'pod_lead'
  ));


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
-- Only safe to roll back if no row has been written with
-- tool='security_deposit' or role='pod_lead' yet — restoring the
-- narrower CHECKs will fail against any row that violates them.
--
-- ALTER TABLE team_member_tool_roles
--   DROP CONSTRAINT IF EXISTS team_member_tool_roles_role_check;
-- ALTER TABLE team_member_tool_roles
--   ADD CONSTRAINT team_member_tool_roles_role_check
--   CHECK (role IN (
--     'admin',
--     'director_of_operations',
--     'property_manager',
--     'inspection_coordinator'
--   ));
--
-- ALTER TABLE team_member_tool_roles
--   DROP CONSTRAINT IF EXISTS team_member_tool_roles_tool_check;
-- ALTER TABLE team_member_tool_roles
--   ADD CONSTRAINT team_member_tool_roles_tool_check
--   CHECK (tool IN (
--     'insurance_compliance'
--   ));
--
-- ============================================================
