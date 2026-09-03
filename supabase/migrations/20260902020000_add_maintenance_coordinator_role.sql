-- ============================================================
-- Migration: 20260902020000_add_maintenance_coordinator_role
-- Created:   2026-09-02
-- Author:    Neo (database specialist)
--
-- RESOLVED 2026-09-02 — CLEARED TO APPLY. Written as prep while the
-- access decision below was still open; both Asimov and Mason have
-- since reviewed it and Peter has explicitly approved the final scope.
-- Full decision trail: compliance/maintenance-coordinator-leadsimple-access.md.
-- The "OPEN CONFLICT" section below is kept for the historical record
-- of what was actually weighed — it is no longer open. Final scope:
-- this role gets Delinquency and Move Out stage visibility, NOT Lease
-- Renewal (a per-process-type restriction enforced in application code,
-- not by this migration — this migration only makes the role value
-- legal to grant at all).
-- ============================================================

-- ============================================================
-- WHAT THIS ADDS AND WHY
-- ============================================================
-- Adds 'maintenance_coordinator' as a new, standalone value on
-- team_member_tool_roles.role — a new role, not a reuse of any existing
-- one (existing candidates were 'reviewer', 'contributor', or the
-- Maintenance History-linked 'property_manager' / 'inspection_coordinator'
-- / 'pod_lead' trio already on this constraint). Intent, per the request
-- this migration was prepared from: let people in a maintenance-
-- coordinator-type job be granted visibility into the new LeadSimple
-- card on Property 360 (property-360-SPEC.md) — specifically its open
-- Delinquency / Lease Renewal / Move Out stage name, and nothing else
-- (see "SCOPE" below).
--
-- Same DROP-then-ADD pattern proven repeatedly on this constraint —
-- 20260813000004, 20260815010000, 20260818000000, 20260819020000,
-- 20260821000000, 20260825000000, 20260827000000 — see "CURRENT STATE
-- CHECK" below for the list this builds on. Postgres has no ALTER
-- CONSTRAINT for widening a CHECK in place.
--
-- ============================================================
-- OPEN CONFLICT — READ BEFORE APPLYING (found while preparing this
-- file, not resolved by this migration)
-- ============================================================
-- property-360-SPEC.md's "Access control" section and this morning's
-- 20260902000000_leadsimple_property_stages.sql both document that the
-- exact access question this role is meant to answer was already
-- decided, same day, and marked "RESOLVED 2026-09-02 (final)":
--
--   "stage-name-only content ... gated by the already-built
--   leadsimple_delinquency/leasing_reviewer mechanism, not Maintenance
--   History's role."
--
-- That decision reversed Peter's own earlier "piggyback on Maintenance
-- History access" instinct specifically on Asimov's recommendation,
-- after Asimov found a real protected-class mention (a housing voucher
-- — Fair Housing, source of income) in LeadSimple free text during its
-- Core governance review (20260825000000). The spec's own reasoning
-- (property-360-SPEC.md, "Access control" section) is that roles tied
-- to Maintenance-adjacent job functions — its examples are literally
-- property_manager, inspection_coordinator, pod_lead — "were never
-- evaluated for this category of data and ... bypass the exact narrow-
-- grant boundary the leasing_reviewer role was built to enforce."
--
-- A new 'maintenance_coordinator' role, scoped to grant
-- tool='leadsimple_delinquency' visibility to a maintenance-coordinator
-- job function, is functionally the same widening that reasoning
-- argued against — a different role name, but the same category of
-- job function gaining a second, separate path into the same
-- Fair-Housing-flagged LeadSimple data the leasing_reviewer boundary
-- exists to narrow.
--
-- RESOLUTION: Asimov's follow-up review and Mason's legal review both
-- ran on this exact tension. Verdict: Move Out approved outright (a
-- real, direct operational need — turnover scheduling — independent of
-- the leasing/collections framing this role doesn't fit). Delinquency
-- was initially denied on an appearance-of-bias concern, then REVERSED
-- to approved after Peter raised California's habitability-obligation
-- law (Civil Code §§1941/1941.1; Green v. Superior Court, 1974) —
-- landlords must maintain habitability regardless of payment status,
-- so hiding the fact doesn't add real legal protection, and a written
-- equal-treatment policy is the more durable safeguard (see the
-- compliance doc for that policy's exact required text). Lease Renewal
-- stays denied — Peter's habitability argument is maintenance-specific
-- and doesn't extend to renewal timing, and no equivalent bright-line
-- legal backstop exists there. Full reasoning for all three:
-- compliance/maintenance-coordinator-leadsimple-access.md.
--
-- ============================================================
-- SCOPE — matches how leasing_reviewer was scoped narrowly on creation
-- (20260825000000)
-- ============================================================
-- This role is scoped for now specifically to LeadSimple visibility —
-- tool='leadsimple_delinquency' — via a row in team_member_tool_roles.
-- It does not automatically grant anything else: not Maintenance
-- History, not any other tool on this table, not admin-level access
-- anywhere. Holding 'maintenance_coordinator' for one tool grants
-- nothing on another tool, same isolation already proven for every
-- other role/tool pair on this table. Widening its scope beyond
-- leadsimple_delinquency later is a separate, visible decision — not
-- assumed here.
--
-- ============================================================
-- CURRENT STATE CHECK — role CHECK is restated unchanged except for the
-- one addition (Postgres requires the full list on every DROP-then-ADD).
-- Current 8 values, per 20260827000000 (the most recent migration to
-- touch this constraint): admin, director_of_operations,
-- property_manager, inspection_coordinator, pod_lead, reviewer,
-- contributor, leasing_reviewer. 'maintenance_coordinator' does not
-- already appear on this constraint under any name — confirmed by
-- searching every migration in this repo for the literal value. It is
-- also not a collision with users.role's separate 'Maintenance
-- Coordinator' job-title value (20260720000003_foundation.sql,
-- 20260721000000_add_inspections_coordinator.sql) — that is a different
-- table, different column, different CHECK constraint (org-chart job
-- title, not Hub tool access); the two are unrelated and can coexist
-- without conflict.
--
-- tool CHECK is not touched by this migration — 'leadsimple_delinquency'
-- already exists (20260825000000) and needs no change here.
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
    'reviewer',
    'contributor',
    'leasing_reviewer',
    'maintenance_coordinator'
  ));

-- No seed/grant INSERT in this migration, same deferral already used
-- for leasing_reviewer (20260825000000) and pod_lead (20260813000004).
-- This migration only makes role='maintenance_coordinator' valid to
-- grant — who actually gets it is Peter's call, made with Asimov's and
-- Mason's input already in hand (see RESOLUTION above), not this
-- migration's. The Lease Renewal exclusion for this role is enforced in
-- application code (projects/hub/property-360/router.js), not here —
-- this migration has no concept of per-process-type restriction.

-- ============================================================
-- MIGRATION GATE (Neo's standard checklist — RESOLVED, cleared to apply)
-- ============================================================
--   [x] Rollback exists — see bottom of this file
--   [x] No existing data is deleted or overwritten — additive CHECK
--       widening only, no row is touched
--   [x] Touches team_member_tool_roles, which other code depends on —
--       but only widens its role CHECK; no existing role value, no
--       existing row, and no existing access-check function is changed
--       or removed
--   [x] Additive, not destructive, taken purely as a schema change —
--       adding one legal value to a CHECK constraint
--   [ ] Tested on a copy of Supabase before production apply — no
--       staging copy exists in this project, same standing caveat as
--       every migration here to date
--   [x] Governance: Asimov's follow-up review and Mason's legal review
--       both ran on the exact conflict this file originally flagged.
--       Both cleared it (with the Delinquency/Lease Renewal split and
--       the required written policy — see RESOLUTION above and
--       compliance/maintenance-coordinator-leadsimple-access.md). Peter
--       has explicitly approved the final scope.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- -- Only safe if no row has been written with role =
-- -- 'maintenance_coordinator' yet.
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
--     'reviewer',
--     'contributor',
--     'leasing_reviewer'
--   ));
--
-- ============================================================
