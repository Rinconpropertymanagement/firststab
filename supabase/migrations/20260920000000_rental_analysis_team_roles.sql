-- ============================================================
-- Migration: 20260920000000_rental_analysis_team_roles
-- Created:   2026-09-20
-- Author:    Neo (database specialist)
--
-- Part of the "Fold Rental Analysis Into the Hub" build
-- (projects/rental-analysis/HUB-INTEGRATION-SPEC.md, "What Neo Needs to
-- Build"). Extends the shared team_member_tool_roles table
-- (20260812020000_shared_team_members.sql) to support a new Hub tool,
-- exactly as that migration's own header comment anticipated: "When a
-- second tool joins the hub with its own roles, extend the `tool` CHECK
-- below in a NEW migration — never edit this one." This is one of those
-- migrations.
--
-- One change only, using the DROP-then-ADD CONSTRAINT pattern already
-- proven in 20260803000002_reviewer_workflow.sql and
-- 20260813000004_security_deposit_team_roles.sql (Postgres requires
-- dropping a CHECK before re-adding it with new allowed values — there's
-- no ALTER CONSTRAINT for widening a CHECK in place):
--
--   1. tool CHECK — add 'rental_analysis' alongside every tool value
--      confirmed live in the table today.
--
-- No role CHECK change in this migration. Per the spec ("Who Gets
-- Access"): rental analysis has no internal permission tiers of its own
-- today — nothing in its own code distinguishes one user from another.
-- Peter/Jarvis decided the existing shared 'admin' role value is reused
-- as-is; no new role value (unlike security_deposit's 'pod_lead') is
-- needed for this tool.
--
-- This migration does NOT insert any row into team_member_tool_roles.
-- It only makes the schema capable of a tool='rental_analysis' value
-- existing. Granting specific people access is Peter's own separate,
-- later, deliberate decision ("nothing actually gives them access until
-- i say — i need the tool to be better before i roll it out") — per the
-- spec, that's a one-time SQL insert Peter/Neo runs later, not part of
-- this file.
--
-- Live values confirmed BEFORE writing this migration (not assumed) via
-- a plain read against the real database:
--   GET {SUPABASE_URL}/rest/v1/team_member_tool_roles?select=tool
--   using the service-role key, deduped client-side (PostgREST has no
--   native DISTINCT). 34 total rows; distinct tool values returned:
--     archive_search, call_stats, content_engine, insurance_compliance,
--     leadsimple_delinquency, maintenance_history, owner_tenant_notes,
--     scorecard, security_deposit
-- This list is a superset of what 20260813000004's own CHECK allowed
-- (insurance_compliance, maintenance_history, security_deposit only) —
-- several more tools have shipped their own team_member_tool_roles rows
-- since that migration was written, exactly the kind of drift that
-- migration's own history already warned about. All of them are
-- included below alongside the new 'rental_analysis' value.
--
-- The constraint name below is Postgres's auto-generated name for an
-- inline column CHECK (<table>_<column>_check) — the same convention
-- already documented and relied on in 20260720000001_nullable_fks.sql
-- and used directly in 20260813000004_security_deposit_team_roles.sql.
--
-- No new table, no PII change — team_member_tool_roles already exists
-- and already has its own Rule 4 treatment (RLS enabled, locked down,
-- documented in its own migration). This migration only widens one
-- CHECK constraint; nothing here needs a new data inventory entry.
--
-- Gate check (must pass before applying to any real database):
--   [x] Rollback exists — see bottom of this file
--   [x] No existing data is deleted or overwritten — every tool value
--       confirmed live today remains valid under the widened CHECK
--   [x] Touches team_member_tool_roles — shared across Hub tools, but
--       purely additive (widening a CHECK, not narrowing one)
--   [x] Additive — no row is forced to change; zero rows are inserted
--       by this migration
--   [x] Should be tested on a copy of Supabase before production apply
-- ============================================================


-- ------------------------------------------------------------
-- tool CHECK — add 'rental_analysis'
-- ------------------------------------------------------------

ALTER TABLE team_member_tool_roles
  DROP CONSTRAINT IF EXISTS team_member_tool_roles_tool_check;

ALTER TABLE team_member_tool_roles
  ADD CONSTRAINT team_member_tool_roles_tool_check
  CHECK (tool IN (
    'archive_search',
    'call_stats',
    'content_engine',
    'insurance_compliance',
    'leadsimple_delinquency',
    'maintenance_history',
    'owner_tenant_notes',
    'scorecard',
    'security_deposit',
    'rental_analysis'
  ));


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
-- Only safe to roll back if no row has been written with
-- tool='rental_analysis' yet — restoring the narrower CHECK will fail
-- against any row that violates it.
--
-- ALTER TABLE team_member_tool_roles
--   DROP CONSTRAINT IF EXISTS team_member_tool_roles_tool_check;
-- ALTER TABLE team_member_tool_roles
--   ADD CONSTRAINT team_member_tool_roles_tool_check
--   CHECK (tool IN (
--     'archive_search',
--     'call_stats',
--     'content_engine',
--     'insurance_compliance',
--     'leadsimple_delinquency',
--     'maintenance_history',
--     'owner_tenant_notes',
--     'scorecard',
--     'security_deposit'
--   ));
--
-- ============================================================
