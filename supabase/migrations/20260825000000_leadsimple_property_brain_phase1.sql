-- ============================================================
-- Migration: 20260825000000_leadsimple_property_brain_phase1
-- Created:   2026-08-25
-- Author:    Neo (database specialist)
--
-- Phase 1 of the LeadSimple Tasks/Workflows domain
-- (projects/hub/leadsimple-property-brain-SPEC.md, Section 9, "Phase 1
-- — Schema"). Cleared by Asimov's spec-level governance pre-check
-- (spec header, "Updated 2026-08-25"). Schema only — no LeadSimple API
-- connector, no extraction/ingestion code, no content-check wiring, no
-- Hub UI. Additive only, zero risk to anything already live.
--
-- This is the SECOND domain to build on the Property Brain platform
-- (projects/hub/PROPERTY-BRAIN-ARCHITECTURE.md), the first being
-- 'maintenance' (20260816000000_property_brain_claims_phase1.sql).
-- Everything below extends `claims` / `claim_type_registry` /
-- `team_member_tool_roles` in place — no new tables (one new nullable
-- column on `claims`, see Section B2), no change to `maintenance`
-- domain rows, nothing that touches projects/hub/maintenance-history/
-- or its dashboard.
--
-- Builds exactly what spec Section 9 Phase 1 calls for, plus one item
-- Peter explicitly asked to add tonight (2026-08-25) — see Section B2:
--   1. Register 11 claim_type_registry rows (Section 2).
--   2. Widen claims.source_type CHECK, +3 values (Section 5).
--   3. Widen team_member_tool_roles' tool CHECK (+3) and role CHECK
--      (+1) (Section 6).
--   4. File this domain's own Rule 4 data-inventory addendum to
--      `claims` (Section 10 / architecture doc Section 5).
--   5. Add `claims.source_link` (Section 5, "Citation must click
--      through to the source record") — added by explicit instruction,
--      not part of the original Phase 1 task list. See Section B2
--      below for the full reasoning. This migration's first draft
--      deliberately left this column out and flagged the decision for
--      Peter/Jarvis (Neo's task list didn't include it); it is added
--      now, in place, rather than via a separate follow-up migration,
--      because this file was never successfully applied to any
--      database (it errored out on Section A on first attempt, before
--      this column existed at all) — nothing live depends on the shape
--      this file had before this edit.
--
-- ============================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT BUILD
-- ============================================================
--   - `field_recorded` registered for domain='leadsimple_operations'.
--     Deliberately absent — see the claim_type_registry INSERT below
--     and spec Section 2's explicit design requirement: this is a
--     structural gate, not an oversight, and the registry's existing
--     fail-closed foreign key on claims(domain, claim_type) is what
--     makes it a real gate rather than a convention someone could
--     forget. Do not add this row in a "fix" later without the
--     record-level content scan spec Section 2 requires first.
--   - Any grant of role='leasing_reviewer' to anyone, including Peter.
--     Unlike content_engine's admin seed for Peter
--     (20260821000000_content_engine_team_roles.sql), spec Section 6 is
--     explicit that "who actually gets leasing_reviewer is Peter's
--     call" — the same deferral already used for pod_lead
--     (20260813000004). This migration only makes the role value valid
--     to grant; it grants it to no one.
--   - Any LeadSimple API connector, extraction logic, content-check
--     wiring (Layer 1 keyword scan / Layer 2 model self-check), or Hub
--     UI screens. All Phase 2+ (Q, then Tron), per spec Section 9.
--   - Any change to the `claims_has_a_subject` / property_id /
--     maintenance_request_id subject-column design. Spec Section 3
--     confirms all three LeadSimple domains use `property_id` alone —
--     already supported by the existing schema, no change needed.
--   - Any RLS policy grant. `claims`, `claim_type_registry`, and
--     `team_member_tool_roles` already have RLS enabled with zero
--     permissive policies (20260816000000, 20260812020000) — this
--     migration adds registry rows and widens CHECKs under that same
--     locked-down posture. A tool gets explicit access only when
--     Tron/Q actually build something that needs it (Phase 2+/5).
--
-- ============================================================
-- LIVE STATE CHECK BEFORE WRITING THIS (team_member_tool_roles has a
-- documented regression history — 20260818000000_fix_role_check_
-- regression.sql — from exactly this class of mistake: widening a
-- CHECK against a stale assumption of what's already live)
-- ============================================================
-- Per this project's standing setup, this environment has no direct
-- Supabase credential to run a live REST/SQL read against the real
-- database (unlike 20260819020000 and 20260821000000, which both did).
-- In its place: a full grep of every migration file in this directory
-- for any reference to team_member_tool_roles_tool_check or
-- team_member_tool_roles_role_check, same reconstruction method
-- 20260821000000 itself used and cross-checked against a live read.
-- Exactly five files have ever ALTERed either constraint, in this
-- applied order (confirmed via file timestamps and each file's own
-- "current live state" section, which already did this reconciliation
-- once):
--   1. 20260812020000 (original CREATE TABLE)
--   2. 20260815010000 (maintenance_history)
--   3. 20260813000004 (security_deposit, applied after #2 despite its
--      earlier filename timestamp)
--   4. 20260818000000 (fix_role_check_regression — role only)
--   5. 20260819020000 (call_stats — tool only)
--   6. 20260821000000 (content_engine — both), which states its own
--      post-apply live state, cross-checked against a REST data read
--      at the time, as:
--        tool CHECK: ('insurance_compliance', 'maintenance_history',
--                     'security_deposit', 'call_stats', 'content_engine')
--        role CHECK: ('admin', 'director_of_operations',
--                     'property_manager', 'inspection_coordinator',
--                     'pod_lead', 'reviewer', 'contributor')
-- No file after 20260821000000 touches either constraint (confirmed by
-- grep across the full migrations/ directory). This migration builds
-- its DROP-then-ADD statements on top of that 5-tool/7-role state.
--
-- CAVEAT, stated plainly since it could not be independently verified
-- live: this reconstruction trusts that 20260821000000's own live
-- cross-check was accurate at the time and that nothing has since
-- written a role/tool value outside what these six files declare.
-- Given the documented regression history on this exact table,
-- Peter (or whoever applies this) should run
-- `SELECT DISTINCT tool, role FROM team_member_tool_roles;` right
-- before applying this migration and confirm no value outside the
-- 5-tool/7-role list above appears. If one does, stop and tell Neo
-- before proceeding — the DROP-then-ADD below would silently narrow
-- live data the same way the 2026-08-17/18 incident did.
--
-- Same DROP-then-ADD pattern as every prior widening of these two
-- constraints — Postgres has no ALTER CONSTRAINT for widening a CHECK
-- in place.
--
-- Gate check (must pass before applying to any real database):
--   [x] Rollback exists — see bottom of this file
--   [x] No existing data is deleted or overwritten — every existing
--       row's tool/role/source_type value remains valid under the
--       widened CHECKs; the 11 new claim_type_registry rows use
--       (domain, claim_type) pairs that cannot collide with the
--       existing 4 'maintenance' rows (different domain values); the
--       new claims.source_link column is nullable with no DEFAULT
--       expression, so every existing claims row (all 'maintenance'
--       domain, if any exist yet) gets NULL and is otherwise untouched
--   [x] Touches claims, claim_type_registry, team_member_tool_roles —
--       all three shared across the Hub, but every change here is
--       additive (widening a CHECK, adding a nullable column, or
--       inserting new rows — never narrowing a CHECK, dropping/typing
--       a column, or altering an existing row)
--   [x] Additive only — no row is forced to change, no existing value
--       removed from either CHECK, no existing claim_type_registry row
--       touched (ON CONFLICT DO NOTHING guards re-runs)
--   [ ] Live-state reconstructed from migration files only, NOT
--       confirmed via a live database read (no credential in this
--       environment) — mitigated by the caveat and pre-apply query
--       above; this is the one open item on this migration's own gate,
--       flagged rather than glossed over
--   [ ] Tested on a copy of Supabase before production apply — no
--       staging copy exists in this project, same standing caveat as
--       every migration here to date
-- ============================================================


-- ============================================================
-- SECTION A: claim_type_registry — 11 rows (spec Section 2)
-- Fail-closed vocabulary registration. Until a (domain, claim_type)
-- pair exists here, claims.claims_domain_claim_type_registered (the
-- composite FK added in 20260816000000) rejects any insert using it —
-- the same enforcement already proven for the four 'maintenance' rows.
--
-- Four claim types (stage_entered, task_completed, task_skipped,
-- field_recorded) registered separately for each of the two full-rigor
-- domains (leadsimple_application_screening, leadsimple_delinquency) =
-- 8 rows. Three claim types (stage_entered, task_completed,
-- task_skipped — NOT field_recorded) registered once for
-- leadsimple_operations = 3 rows. 11 total.
--
-- Descriptions below are written per-domain, not copied across all 11:
-- the same claim_type means a materially different thing depending on
-- which of the 74 operational workflow types vs. the two full-rigor
-- domains it's describing, per spec Section 2's own table.
-- ============================================================

INSERT INTO claim_type_registry (domain, claim_type, description) VALUES
  -- leadsimple_application_screening (spec Section 2, full rigor)
  ('leadsimple_application_screening', 'stage_entered',
   'The application screening process (LeadSimple workflow "01 Application Screening") entered a named stage on a given date — e.g. "Approved," "Denied," "Application Received." The stage name is LeadSimple''s own; a human made this call inside LeadSimple, and the claim records that they did, not why.'),
  ('leadsimple_application_screening', 'task_completed',
   'A named task on an application screening process (e.g. "Verify employment," "Call previous landlord") was marked complete on a date.'),
  ('leadsimple_application_screening', 'task_skipped',
   'A named task on an application screening process was marked skipped or not applicable on a date.'),
  ('leadsimple_application_screening', 'field_recorded',
   'A custom field''s value on an application screening process, as recorded on a date — field name plus value. For the two free-text fields ("Positive Landlord Reference" and the general "comments" field), the value stored in claim_text is a distilled paraphrase, never a verbatim quote, per this domain''s source_reference/claim_text discipline (spec Section 5).'),

  -- leadsimple_delinquency (spec Section 2, full rigor)
  ('leadsimple_delinquency', 'stage_entered',
   'The delinquency process (LeadSimple workflow "002 Delinquency") entered a named stage on a given date — e.g. a collections-stage milestone. The stage name is LeadSimple''s own; a human made this call inside LeadSimple, and the claim records that they did, not why.'),
  ('leadsimple_delinquency', 'task_completed',
   'A named task on a delinquency process was marked complete on a date.'),
  ('leadsimple_delinquency', 'task_skipped',
   'A named task on a delinquency process was marked skipped or not applicable on a date.'),
  ('leadsimple_delinquency', 'field_recorded',
   'A custom field''s value on a delinquency process, as recorded on a date — field name plus value. Delinquency''s 6 defined custom fields are dropdown/date only in practice (per the data-inventory scan, blank 100% of the time); the general "comments" field is the one free-text exception and follows the same distilled-paraphrase discipline as Application Screening''s free-text fields when used.'),

  -- leadsimple_operations (spec Section 2, lighter-touch — deliberately
  -- 3 types only, see header comment above)
  ('leadsimple_operations', 'stage_entered',
   'One of LeadSimple''s other 74 workflow types (Move In/Out, Lease Renewal, Property Onboarding, Insurance Compliance, HOA Violations, Owner Termination, internal HR/accounting, etc.) entered a named stage on a given date. The stage name is LeadSimple''s own; a human made this call inside LeadSimple, and the claim records that they did, not why.'),
  ('leadsimple_operations', 'task_completed',
   'A named task on one of the 74 operations-domain workflow types was marked complete on a date.'),
  ('leadsimple_operations', 'task_skipped',
   'A named task on one of the 74 operations-domain workflow types was marked skipped or not applicable on a date.')

  -- NOTE: ('leadsimple_operations', 'field_recorded', ...) is
  -- deliberately NOT included. Do not add it here or in a later "just
  -- add the missing row" patch — see spec Section 2 and the header
  -- comment above. It requires its own migration, written only after a
  -- specific one of the 74 workflow types has had its own record-level
  -- content scan, per spec Section 2's structural gate design.
ON CONFLICT (domain, claim_type) DO NOTHING;


-- ============================================================
-- SECTION B: claims.source_type CHECK — +3 values (spec Section 5)
-- Same DROP-then-ADD pattern already used for this exact column's
-- constraint's siblings on team_member_tool_roles (Section C below) —
-- Postgres has no ALTER CONSTRAINT for widening a CHECK in place.
-- Confirmed via grep across supabase/migrations/ that no migration
-- since 20260816000000 (which created this CHECK) has touched it —
-- today's live value is exactly the four Latchel-sourced values that
-- migration declared. Constraint name is Postgres's auto-generated
-- name for an inline column CHECK (<table>_<column>_check), the same
-- convention already confirmed and relied on elsewhere in this schema
-- (20260813000004's header note).
-- ============================================================

ALTER TABLE claims
  DROP CONSTRAINT IF EXISTS claims_source_type_check;

ALTER TABLE claims
  ADD CONSTRAINT claims_source_type_check
  CHECK (source_type IN (
    'latchel_job_field',
    'latchel_state_history',
    'latchel_invoice_field',
    'latchel_job_file',
    'leadsimple_process_stage',
    'leadsimple_task',
    'leadsimple_custom_field'
  ));

-- Refreshes the column comment 20260816000000 wrote (which predates
-- these three values and only describes the Latchel + hypothetical
-- future-email cases) to also state the LeadSimple structural-pointer
-- rule from spec Section 5 — so anyone reading this column via \d+
-- claims or information_schema sees the current, complete rule, not
-- just the part written before this domain existed.
COMMENT ON COLUMN claims.source_reference IS
  'STRUCTURAL POINTER ONLY. For Latchel-sourced rows: exactly which record (e.g. "Latchel job 6903, state history entry 2026-07-30"). For any future email-derived row: a thread ID, message ID, timestamp, and/or sender address ONLY — never a subject line, body excerpt, or quoted content. For LeadSimple-sourced rows (source_type IN (''leadsimple_process_stage'', ''leadsimple_task'', ''leadsimple_custom_field'')), per spec Section 5: the LeadSimple process ID, the field/task/stage name, and a timestamp ONLY (e.g. "LeadSimple process 4821 (01 Application Screening), field ''comments'', recorded 2026-04-02") — never the field''s own text content restated as if it were a citation. See migration 20260816000000''s "THE SOURCE_REFERENCE CONVENTION" note for the full original rule and why this is enforced by pipeline-code discipline (Q''s Phase 2 extraction code) rather than a CHECK constraint — the same reasoning applies unchanged to the LeadSimple case.';


-- ============================================================
-- SECTION B2: claims.source_link — new column (spec Section 5,
-- "Citation must click through to the source record", resolved
-- 2026-08-25). Added by Peter's explicit instruction tonight
-- (2026-08-25), ahead of Q's Phase 2 extraction pipeline actually
-- populating it — schema-only, same as the rest of this file.
--
-- Neo's call, per the spec's own framing ("Whether that's a new column
-- on claims or a structured sub-value inside source_reference is Neo's
-- call in Phase 1"): a dedicated column, not a sub-value packed inside
-- source_reference. Reasons:
--   1. source_reference stays a plain structural-pointer TEXT string
--      under the existing convention (20260816000000's "THE
--      SOURCE_REFERENCE CONVENTION" note) — no new parsing rule to
--      invent or for Tron's UI to implement just to pull a URL back out
--      of a string that was never designed to carry a second value.
--   2. The spec's own requirement is that "the raw URL survives
--      ingestion and reaches Tron's UI as a real value to put in an
--      <a href>" — a dedicated column is that value directly, with no
--      extraction step and no risk of a malformed sub-value shape
--      breaking the link render.
--   3. Nullable and domain-agnostic by design: not every claim will
--      have a deep link (Latchel-sourced claims don't populate it as
--      of this migration; NULL is the correct, expected value for
--      those rows, same discipline already used for claim_date,
--      confidence, and every other "not every row has this" column on
--      this table). Scoping the column itself to LeadSimple would mean
--      inventing a new column the next domain with its own deep link
--      would just duplicate — same reasoning that already keeps
--      `domain` a plain value on one shared table instead of a
--      per-domain table (architecture doc Section 1.2).
--
-- What this column is NOT: not subject to the verbatim-content
-- discipline that governs claim_text or the free-text fields in
-- source_reference (spec Section 5, items 1-2) — a URL is a structural
-- pointer, not prose content, so nothing here changes the
-- paraphrase-only rule for claim_text. Per spec Section 5's live
-- verification: capture LeadSimple's own `link` field value verbatim
-- at ingestion (Q, Phase 2) — never construct this URL from
-- `process_id`; LeadSimple encodes it into an opaque token this schema
-- has no way to reproduce.
-- ============================================================

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS source_link TEXT;

COMMENT ON COLUMN claims.source_link IS
  'Optional deep link to the record this claim was extracted from, for Tron''s UI to render as a clickable citation (spec Section 5, "Citation must click through to the source record", resolved 2026-08-25). NULL for any claim whose source has no ready-made deep link (all Latchel-sourced claims as of this migration). For LeadSimple-sourced claims: capture the LeadSimple API''s own `link` field value on the Process object VERBATIM at ingestion time (Q, Phase 2) — never construct this URL from process_id; LeadSimple encodes it into an opaque token, e.g. "https://app.leadsimple.com/v2/process-types/{opaque_token}/processes/{opaque_token}". Not a structural-pointer text convention like source_reference and not subject to the verbatim-content ban that governs claim_text — a URL is not prose content.';


-- ============================================================
-- SECTION C: team_member_tool_roles — +3 tool values, +1 role value
-- (spec Section 6). Same DROP-then-ADD pattern proven in
-- 20260813000004, 20260815010000, 20260818000000, 20260819020000, and
-- 20260821000000 — see the "LIVE STATE CHECK" note above for the
-- reconstructed 5-tool/7-role starting point this builds on.
--
--   1. tool CHECK — add 'leadsimple_application_screening',
--      'leadsimple_delinquency', 'leadsimple_operations'. Kept as
--      three separate values, not lumped into one, per spec Section 6:
--      "Application Screening and Delinquency are different domains
--      with different — if both sensitive — data profiles." A person
--      needs an explicit row for each tool value; holding a role on
--      one grants nothing on another, by construction (same isolation
--      already proven for every other tool on this table).
--   2. role CHECK — add 'leasing_reviewer', paired with the existing
--      'admin' value for Application Screening/Delinquency access.
--      Distinct from the generic 'reviewer' already used elsewhere
--      specifically so granting it is a visibly deliberate act tied to
--      an actual leasing function, per Mason's condition (spec Section
--      6) — not a relabeling of 'reviewer', not a reuse of it.
--      leadsimple_operations reuses the existing 'admin'/'reviewer'
--      values unchanged (spec Section 6, last bullet) — no new role
--      value needed for that tool.
--
-- No seed/grant INSERT in this migration — see "WHAT THIS MIGRATION
-- DELIBERATELY DOES NOT BUILD" above. Unlike content_engine's Peter-
-- admin seed, spec Section 6 explicitly leaves who gets
-- 'leasing_reviewer' (and who gets access to the two restricted tools)
-- to Peter's own decision.
-- ============================================================

ALTER TABLE team_member_tool_roles
  DROP CONSTRAINT IF EXISTS team_member_tool_roles_tool_check;

ALTER TABLE team_member_tool_roles
  ADD CONSTRAINT team_member_tool_roles_tool_check
  CHECK (tool IN (
    'insurance_compliance',
    'maintenance_history',
    'security_deposit',
    'call_stats',
    'content_engine',
    'leadsimple_application_screening',
    'leadsimple_delinquency',
    'leadsimple_operations'
  ));

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
    'leasing_reviewer'
  ));


-- ============================================================
-- SECTION D: DATA INVENTORY ADDENDUM (GOVERNANCE.md Rule 4 /
-- PROPERTY-BRAIN-ARCHITECTURE.md Section 5 — "every new domain
-- requires its own addendum here, not an assumption an existing entry
-- already covers it"). Per spec Section 10's own scope, this
-- translates compliance/leadsimple-tasks-workflows-data-inventory.md's
-- "Data Inventory" section into this table's addendum format rather
-- than duplicating the underlying research — see that document for the
-- live-account findings this is built on (2,158 Application Screening
-- cases + 6,772 Delinquency cases, 100% record-level content-scanned).
--
-- This addendum covers claims rows where domain IN
-- ('leadsimple_application_screening', 'leadsimple_delinquency',
-- 'leadsimple_operations') specifically. It does not restate or modify
-- the existing 'maintenance'-domain entry from 20260816000000 — that
-- entry remains correct for its own rows, per the architecture doc's
-- own point that one domain's PII profile cannot be assumed to
-- describe another's.
--
--   pii_fields:          claims.claim_text for field_recorded claims
--                         on the two full-rigor domains' free-text
--                         fields (Application Screening's "Positive
--                         Landlord Reference," and the general
--                         "comments" field on either full-rigor
--                         domain) — distilled paraphrase only, never
--                         verbatim, per spec Section 5. The underlying
--                         LeadSimple records these claims are extracted
--                         from also carry applicant/tenant/owner name,
--                         email, and phone (compliance doc's own
--                         pii_fields entry) — none of that is copied
--                         into claim_text itself; claims.source_reference
--                         cites the record structurally (process ID +
--                         field/task/stage name + timestamp) rather
--                         than carrying that content forward. No SSNs,
--                         bank account numbers, or government IDs exist
--                         anywhere in this domain's data, per the
--                         compliance doc's account-wide field-definition
--                         scan (267 custom fields checked). claims.
--                         reviewer_notes and claims.flagged_category
--                         carry the same standing caveats already
--                         documented for every other domain in this
--                         table (20260816000000, 20260815010000).
--                         leadsimple_operations rows carry no free text
--                         at all by design (no field_recorded claim
--                         type registered — Section A above) — lower
--                         PII density than the two full-rigor domains.
--   agents_with_access:  Once Phase 2+ builds the pipeline: Claude
--                         (existing ANTHROPIC_API_KEY) for extraction
--                         and, for leadsimple_application_screening
--                         specifically, the Layer 2 model self-check
--                         (spec Section 4); the scheduled LeadSimple
--                         ingestion process (system, service-role key,
--                         LEADSIMPLE_API_KEY); Hub users holding
--                         'leasing_reviewer' or 'admin' for
--                         tool='leadsimple_application_screening' or
--                         tool='leadsimple_delinquency' specifically —
--                         NOT general Hub-wide 'reviewer'/'admin' for
--                         any other tool, per Mason's access condition
--                         (spec Section 6); Hub users holding 'reviewer'
--                         or 'admin' for tool='leadsimple_operations'
--                         (standard Hub pattern, lower risk, no leasing-
--                         function restriction, per spec Section 6's
--                         last bullet). As of this migration, nothing
--                         reads or writes claims for this domain yet —
--                         no ingestion pipeline exists (Phase 2).
--   privacy_category:    Applicant and tenant personal data. The Fair
--                         Housing Standard (GOVERNANCE.md) applies in
--                         full to leadsimple_application_screening —
--                         it stores facts about prospective tenants,
--                         per spec Section 0. leadsimple_delinquency
--                         is tenant collections data, sensitive on its
--                         own terms per spec Section 8. Both are more
--                         sensitive than this table's existing
--                         'maintenance'-domain rows, which carry no
--                         applicant/screening/collections content.
--                         leadsimple_operations is lower-sensitivity —
--                         structural workflow facts only, no free text.
--   retention_policy:    7 years, per Peter's 2026-08-24 instruction
--                         applying Rincon's standing company-wide
--                         records retention policy (not a figure
--                         invented for this build; previously attorney-
--                         advised per Peter's 2026-08-25 confirmation,
--                         no fresh review required — spec Section 7 /
--                         Open Items #2). Applies uniformly to
--                         leadsimple_application_screening and
--                         leadsimple_delinquency claims, including
--                         denied applicants. leadsimple_operations
--                         inherits the same 7-year figure by default
--                         (no reason identified to diverge) but was not
--                         separately reviewed by Mason — flag to him if
--                         his standalone sign-off is ever requested for
--                         this domain specifically (spec Section 7).
--   ccpa_exportable:     TRUE.
--   ccpa_deletable:      TRUE, via the same targeted-redaction
--                         mechanism already used for every other domain
--                         in this table: claim_text and reviewer_notes
--                         redacted to the literal string "[REDACTED]";
--                         domain, claim_type, claim_date,
--                         source_reference, and correction_reason_code
--                         preserved for audit continuity.
--
-- RLS: unchanged by this migration — claims, claim_type_registry, and
-- team_member_tool_roles already have RLS enabled with zero permissive
-- policies (20260816000000, 20260812020000); these new domain rows and
-- CHECK values inherit that same locked-down posture automatically.
-- ============================================================


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- -- Only safe if no row has been written with tool IN
-- -- ('leadsimple_application_screening', 'leadsimple_delinquency',
-- -- 'leadsimple_operations') or role='leasing_reviewer' yet.
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
--     'contributor'
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
--     'call_stats',
--     'content_engine'
--   ));
--
-- -- Safe any time — drops the column and any values in it. If Q's
-- -- Phase 2 pipeline has since populated source_link on real claims,
-- -- those URLs are lost (not referenced by any FK, so nothing blocks
-- -- this the way claim_type_registry deletes can be blocked below;
-- -- confirm losing them is acceptable before running).
-- ALTER TABLE claims
--   DROP COLUMN IF EXISTS source_link;
--
-- -- Only safe if no claims row has been written with source_type IN
-- -- ('leadsimple_process_stage', 'leadsimple_task',
-- -- 'leadsimple_custom_field') yet.
-- COMMENT ON COLUMN claims.source_reference IS
--   'STRUCTURAL POINTER ONLY. For today''s Latchel-sourced rows: exactly which record (e.g. "Latchel job 6903, state history entry 2026-07-30"). For any future email-derived row: a thread ID, message ID, timestamp, and/or sender address ONLY — NEVER a subject line, body excerpt, or quoted content. See migration 20260816000000''s "THE SOURCE_REFERENCE CONVENTION" note for the full rule and why this is enforced by convention/pipeline-code discipline rather than a CHECK constraint.';
-- ALTER TABLE claims
--   DROP CONSTRAINT IF EXISTS claims_source_type_check;
-- ALTER TABLE claims
--   ADD CONSTRAINT claims_source_type_check
--   CHECK (source_type IN (
--     'latchel_job_field',
--     'latchel_state_history',
--     'latchel_invoice_field',
--     'latchel_job_file'
--   ));
--
-- -- Only safe if no claims row has been written with domain IN
-- -- ('leadsimple_application_screening', 'leadsimple_delinquency',
-- -- 'leadsimple_operations') yet — true as of this migration, since no
-- -- ingestion pipeline exists (Phase 2). If a later phase has since
-- -- inserted real claims against these registry rows, this DELETE will
-- -- fail on the claims_domain_claim_type_registered foreign key (a
-- -- deliberate, correct block, not a bug) — resolve those claims first.
-- DELETE FROM claim_type_registry
--   WHERE domain IN (
--     'leadsimple_application_screening',
--     'leadsimple_delinquency',
--     'leadsimple_operations'
--   );
--
-- ============================================================
