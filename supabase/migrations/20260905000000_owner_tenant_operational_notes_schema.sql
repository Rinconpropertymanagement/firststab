-- ============================================================
-- Migration: 20260905000000_owner_tenant_operational_notes_schema
-- Created:   2026-09-05
-- Author:    Neo (database specialist)
--
-- Schema for the "Owner & Tenant Operational Notes" Hub feature
-- (projects/hub/property-360/owner-tenant-operational-notes-SPEC.md,
-- Sections 3-5 and 9). Implements spec Section 4's table exactly,
-- Section 5's view exactly, and Section 3's one CHECK-constraint
-- widening. No application code, no router, no UI, no seed/grant rows
-- — Q builds all of that on top of this once it exists (spec's own
-- instruction, task brief point 5).
--
-- ============================================================
-- STATUS FLAG — READ BEFORE APPLYING THIS FILE
-- ============================================================
-- The spec this migration implements carries its own Status line
-- (top of owner-tenant-operational-notes-SPEC.md): "Status: Draft...
-- Remaining before Neo/Q build: the few unrelated 'Still Open' items
-- below, AND PETER'S FINAL GO-AHEAD TO BUILD." That sentence names a
-- distinct gate from the staffing/role-mapping decisions Section 3
-- documents as resolved (pod_lead=property_manager, contributor=no
-- access, admin-only reaches legal_privileged — all with dated,
-- quoted decisions from Peter). Those two things are not the same
-- fact: the role-tier mapping being settled does not, by itself,
-- establish that Peter has separately said "go ahead and build this."
-- I was told this spec is "full, final, approved" with "nothing...
-- still undecided" — that framing matches Section 3's resolved items
-- but does not match the spec document's own Status line, which
-- still lists a go-ahead-to-build gate as outstanding. I'm writing
-- this file anyway because drafting a migration is inert (it is not
-- applied here — see below) and Peter must manually run it in
-- Supabase's SQL Editor regardless, which is itself a real approval
-- gate. But whoever hands this file to Peter should confirm the
-- go-ahead explicitly rather than treating this migration's existence
-- as proof it was already given. Flagging this plainly rather than
-- silently assuming it away, per Neo's own standing "you don't
-- approve your own migrations" rule.
--
-- This is also a GOVERNANCE.md compliance build (stores personal
-- data about owners/tenants; influences how staff treat a tenant).
-- CLAUDE.md requires Asimov (governance) and Mason (Fair Housing/
-- legal) sign-off before any compliance build ships — the spec states
-- both reviewed the Section 3 role-tier mapping and the Section 5
-- review-vocabulary/decision-safe-view divergence and cleared them
-- with conditions (Sections 3, 5, 9, 11). I have not independently
-- re-verified Asimov's/Mason's review with them directly; I am
-- relying on the spec's own account of that review, same as I rely on
-- the spec for every other design decision in it. This migration does
-- not itself ship anything live to a tenant or owner — it is schema
-- only, per the spec's own Rule 6/7 "what's clear to build vs. what
-- must happen before go-live" distinction (Section 11).
--
-- ============================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT BUILD (spec Section 4's
-- own "Deliberately not built, considered and rejected" list, carried
-- forward unchanged — not redesigned or second-guessed here)
-- ============================================================
--   - A `related_note_id` self-reference linking a restricted-tier
--     note to a sanitized Operational-tier companion. Two independent
--     notes, optionally cross-referenced in free text, is enough for
--     v1 (spec Section 4) — matches this schema's own repeated
--     "don't build ahead of a proven need" discipline
--     (maintenance_snapshot_events' identical call).
--   - Any `risk_score`/`personality`-type column. Does not exist
--     anywhere in this table, on purpose — this is the concrete
--     enforcement mechanism for counsel's "I would not build AI-
--     generated personality or risk assessments" prohibition (spec
--     Section 4/7): there is no field capable of holding one.
--   - A retention/expiry column (`archived_at`, `expires_at`).
--     `retention_policy` stays a documented PLACEHOLDER pending Mason
--     (spec Section 4/9), same standing practice as
--     maintenance_claims, maintenance_snapshot_events, and
--     security_deposit_cases before Mason set an actual figure for
--     each.
--   - Any RLS policy grant. RLS is enabled with zero permissive
--     policies at creation (see Section B below) — a tool gets
--     explicit access only when Q/Tron build something that reads it
--     (spec Section 2's "surfaced primarily on Property 360").
--   - Any seed/grant INSERT into team_member_tool_roles for
--     tool='owner_tenant_notes'. This migration only makes the tool
--     value valid to grant — who actually gets access is Peter's
--     call, same deferral already used for leasing_reviewer
--     (20260825000000), pod_lead (20260813000004), and
--     maintenance_coordinator (20260902020000).
--   - No new role value on team_member_tool_roles.role. Spec Section
--     3 is explicit: the proposed `legal_access` role was removed
--     per Peter's decision — `admin` alone reaches legal_privileged.
--     The role CHECK constraint is therefore not touched at all by
--     this migration (see Section A below).
--   - Any application code: no router, no middleware
--     (attachOwnerTenantNotesRole/requireOwnerTenantNotesAccess/
--     requireOwnerTenantNotesRole per spec Section 3), no content-
--     check wiring (Layer 1/Layer 2 per spec Section 5), no
--     applyNoteReviewDisposition function, no UI. All Q's work, from
--     this migration, per the task brief (point 5) and the spec's own
--     framing throughout ("Neo/Q build").
--   - The AI email-extraction pipeline (spec Section 8) in any form —
--     that path sits behind its own separate, later gate per spec
--     Section 2 and is explicitly not part of this schema.
--   - Any subject_type != 'tenant' filter for maintenance_coordinator
--     (spec Section 3's "further scoped" note). That is an
--     application-code query filter layered on top of the tier check,
--     per the spec's own words — not something a table or CHECK
--     constraint can express, and not built here.
--
-- ============================================================
-- LIVE STATE CHECK BEFORE WIDENING team_member_tool_roles.tool_check
-- (this table has a documented regression history —
-- 20260818000000_fix_role_check_regression.sql — from exactly this
-- class of mistake: widening a CHECK against a stale assumption of
-- what's already live)
-- ============================================================
-- Confirmed via grep across every file in supabase/migrations/: the
-- most recent migration to touch team_member_tool_roles_tool_check is
-- 20260827000000_approval_briefing_phase1.sql, which left it at 9
-- values:
--   ('insurance_compliance', 'maintenance_history', 'security_deposit',
--    'call_stats', 'content_engine', 'leadsimple_application_screening',
--    'leadsimple_delinquency', 'leadsimple_operations',
--    'approval_briefing')
-- No file after 20260827000000 touches tool_check (confirmed by grep;
-- 20260902020000_add_maintenance_coordinator_role.sql, the next file
-- to touch either constraint, explicitly widens role_check ONLY and
-- states in its own header that it leaves tool_check untouched).
-- This migration's ADD CONSTRAINT below carries forward all 9 existing
-- values plus 'owner_tenant_notes' (10 total) — not a stale list.
--
-- role_check is NOT touched by this migration (spec Section 3: no new
-- role value). Its current state, per 20260902020000 (the most recent
-- file to touch it), is 9 values: ('admin', 'director_of_operations',
-- 'property_manager', 'inspection_coordinator', 'pod_lead', 'reviewer',
-- 'contributor', 'leasing_reviewer', 'maintenance_coordinator').
-- Restated here for the record only — no ALTER on role_check appears
-- in this file, same convention 20260819020000 and 20260902020000 both
-- used when only one of the two constraints actually changes.
--
-- CAVEAT, stated plainly: this environment has no direct Supabase
-- credential to confirm the above against live data (same standing
-- limitation as every migration since 20260825000000). Peter (or
-- whoever applies this) should run
-- `SELECT DISTINCT tool, role FROM team_member_tool_roles;` right
-- before applying and confirm no value outside the 9-tool/9-role list
-- above appears. If one does, stop and tell Neo before proceeding.
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No. The tool_check widening
--       only ADDS a valid value — every existing row's tool value
--       remains valid. operational_notes and operational_notes_visible
--       are both brand new; nothing existing reads or writes either.
--   [x] Does this touch a table other code depends on? Yes —
--       team_member_tool_roles is shared across every Hub tool. The
--       only change here is additive (a strict superset CHECK) —
--       nothing existing changes behavior.
--   [x] Additive or destructive? Fully additive. No column dropped, no
--       existing row altered, no CHECK narrowed.
--   [ ] Tested on a copy of the data first? No staging copy exists in
--       this project — same standing caveat every migration here has
--       carried to date. Mitigated by: operational_notes is a brand
--       new, empty table (nothing can be broken that doesn't yet
--       exist), and the tool_check widening is the same proven-safe
--       DROP-then-ADD pattern already applied 7 times on this
--       constraint without incident. The one real pre-flight risk is
--       the live-state assumption above — see the pre-apply query
--       called out there.
--   [ ] Governance/business go-ahead to BUILD (as opposed to the
--       Section 3 role-tier mapping, which is separately resolved and
--       documented) — see "STATUS FLAG" at top of this file. Not
--       independently confirmed by Neo; flagged for Peter to confirm
--       before this file is applied.
-- ============================================================


-- ============================================================
-- SECTION A: team_member_tool_roles.tool CHECK — +1 value
-- (spec Section 2/3: new tool value 'owner_tenant_notes'). Same
-- DROP-then-ADD pattern this constraint has now used 8 times
-- (20260812020000 original, 20260813000004, 20260815010000,
-- 20260818000000, 20260819020000, 20260821000000, 20260825000000,
-- 20260827000000) — Postgres has no ALTER CONSTRAINT for widening a
-- CHECK in place. role CHECK is not touched — see "LIVE STATE CHECK"
-- above.
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
    'leadsimple_operations',
    'approval_briefing',
    'owner_tenant_notes'
  ));

-- No seed/grant INSERT — see "WHAT THIS MIGRATION DELIBERATELY DOES
-- NOT BUILD" above. This migration only makes tool='owner_tenant_notes'
-- valid to grant; who actually gets access is Peter's call, made
-- against the Section 3 role-tier mapping once Q has built something
-- to grant access to.


-- ============================================================
-- SECTION B: operational_notes — new table (spec Section 4)
--
-- One row per factual note about an owner, a tenant, or a property in
-- general — counsel's literal content bar (spec Section 1): "Is this
-- objectively stated information that is reasonably necessary or
-- useful for a legitimate property-management, maintenance, safety,
-- compliance, customer-service, or dispute-management purpose, and is
-- it appropriate for the intended employee to receive it?" No
-- complaint counts, behavioral profiling, or tenant scoring — individual
-- factual records only (spec Section 1, red line, unchanged). No AI in
-- an actual housing decision — this table has zero connection to any
-- leasing/screening/renewal/eviction workflow (spec Section 10) and
-- must never gain one without its own fresh Fair Housing review.
--
-- Every column, both named CONSTRAINTs, and all five indexes below
-- match spec Section 4's literal SQL exactly; only whitespace/column
-- alignment is cleaned up for this schema's usual formatting, and
-- CREATE OR REPLACE VIEW is used in Section C in place of the spec's
-- bare CREATE VIEW purely for idempotency, matching every other view
-- in this schema (maintenance_claims_decision_safe). No column, type,
-- constraint, or index was added, removed, or altered in meaning.
-- ============================================================

CREATE TABLE IF NOT EXISTS operational_notes (
  id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Every note is anchored to a property — matches the concept doc's
  -- own property-page framing and Peter's original ask ("visible to
  -- staff before they act" on a specific property). RESTRICT, not
  -- CASCADE: properties rows are never expected to be hard-deleted in
  -- this schema (AppFolio-owned), same reasoning already used for
  -- claims.property_id (20260816000000) and approval_briefings.property_id
  -- (20260827000000).
  property_id             UUID          NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  -- Nullable; populated when the note ties to a specific unit/tenancy,
  -- not the whole property. SET NULL, not RESTRICT: losing the
  -- unit-level pointer if a unit record is ever removed should not
  -- block deleting the unit, and does not destroy the note itself.
  unit_id                 UUID          REFERENCES units(id) ON DELETE SET NULL,

  -- Polymorphic subject reference — same TEXT-discriminator + UUID
  -- pattern audit_log already uses (entity_type/entity_id), not a new
  -- mechanism. No enforced FK: subject_id points into owners.id or
  -- tenants.id depending on subject_type, and Postgres CHECK
  -- constraints can't express "FK into one of two tables" natively —
  -- same limitation audit_log already accepts. NULL for
  -- subject_type='property' (a general/neighbor-dispute fact not tied
  -- to one named person).
  subject_type            TEXT          NOT NULL CHECK (subject_type IN ('owner', 'tenant', 'property')),
  subject_id              UUID,         -- owners.id | tenants.id | NULL — see above

  note_text               TEXT          NOT NULL,   -- the fact itself, objectively stated, per counsel's exact standard (Section 1)
  category                TEXT,         -- free text, not a rigid enum — e.g. 'maintenance_standard', 'access_preference', 'dispute', 'accommodation_instruction', 'owner_instruction_rejected' — Mason should be able to refine without a migration, same convention as flagged_category

  access_tier             TEXT          NOT NULL CHECK (access_tier IN ('operational', 'management_compliance_restricted', 'legal_privileged')),

  source                  TEXT          NOT NULL CHECK (source IN ('manual', 'ai_proposed')),
  author_team_member_id   UUID          NOT NULL REFERENCES team_members(id), -- who typed it (manual), or who approved the AI's draft (ai_proposed — see approval_status below)
  extracted_by            TEXT,         -- NULL for 'manual'; the model version string for 'ai_proposed' — mirrors maintenance_claims.extracted_by exactly

  -- AI-drafted notes require human approval before they are visible to
  -- ANYONE at their declared tier, full stop — the concept doc's own
  -- "AI drafts, human approves" design, which counsel's opinion (spec
  -- Section 5: "I would permit AI to propose factual notes, subject to
  -- human and automated controls") does not remove. Manual notes skip
  -- this entirely — a human already exercised judgment by typing the
  -- fact; only the content-check/flagging path below gates a manual
  -- note, not a second blanket approval step. NULL for source='manual'
  -- (not applicable); NOT NULL, starting 'pending_approval', for
  -- source='ai_proposed' — enforced in application code at insert and
  -- by the operational_notes_ai_requires_approval_status constraint
  -- below, not a DB CHECK tying the *value progression* of the two
  -- columns together (matches this schema's general discipline of
  -- enforcing only the clearly-stated invariants and leaving looser
  -- conventions to app code + comments, e.g. outcome_level's
  -- claim_type scope in maintenance_claims).
  approval_status         TEXT          CHECK (approval_status IN ('pending_approval', 'approved', 'declined')),

  -- The two-layer content check (GOVERNANCE.md Rule 9) — identical
  -- columns, identical enforcement to maintenance_claims/
  -- maintenance_snapshot_events. Layer 1 (lib/protected-class-terms.js,
  -- reused as-is) runs on every note's note_text regardless of source.
  -- Layer 2 differs by source (spec Section 5) — that logic is Q's,
  -- not this migration's.
  flagged_protected_class BOOLEAN       NOT NULL DEFAULT FALSE,
  flagged_category        TEXT,         -- required whenever flagged_protected_class = TRUE, enforced below

  -- Disposition of a FLAGGED note, decided by a human reviewer holding
  -- Management/Compliance-Restricted tier or above. Deliberately NOT
  -- the confirm/correct/reject vocabulary maintenance_claims uses —
  -- spec Section 5 requires a genuinely different outcome model here:
  -- two of these three dispositions must make the note visible again,
  -- which maintenance_claims' vocabulary was never designed to express.
  -- See operational_notes_visible (Section C below) for why this is a
  -- deliberate divergence, not an inconsistency to "fix."
  review_status           TEXT          NOT NULL DEFAULT 'unreviewed'
                             CHECK (review_status IN (
                               'unreviewed', 'retained_restricted',
                               'rephrased_and_released', 'false_positive_released'
                             )),
  reviewed_by             TEXT,         -- reviewer's email, same TEXT-email convention as maintenance_claims.reviewed_by
  reviewed_at             TIMESTAMPTZ,
  reviewer_notes          TEXT,

  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- Enforcement #1: GOVERNANCE.md Rule 9 requires the exclusion/flag
  -- reason to be recorded, not just the fact of flagging — same
  -- discipline as maintenance_claims_flag_requires_category
  -- (20260815010000) and approval_briefings_held_requires_category
  -- (20260827000000).
  CONSTRAINT operational_notes_flag_requires_category
    CHECK (flagged_protected_class = FALSE OR flagged_category IS NOT NULL),

  -- Enforcement #2: approval_status is populated if and only if
  -- source='ai_proposed'. (Separately, spec Section 3's rule that a
  -- note declared legal_privileged may only be authored, or AI-drafted-
  -- and-approved, by admin is NOT enforced here — it requires a join
  -- against team_members this table can't see on its own, so it's
  -- enforced in application code at write time, same as the spec
  -- itself states.)
  CONSTRAINT operational_notes_ai_requires_approval_status
    CHECK ((source = 'manual' AND approval_status IS NULL) OR (source = 'ai_proposed' AND approval_status IS NOT NULL))
);

-- RLS: enabled, no permissive policies — all access denied until a
-- tool explicitly grants it via a policy scoped to authenticated
-- users. Same "locked down until a tool explicitly asks for access"
-- default used everywhere else in this schema (20260812020000,
-- 20260815010000, 20260626000000 all state this explicitly). Every
-- tool that touches Supabase today reads and writes through its own
-- backend using the service-role key, which always bypasses RLS — so
-- this table works correctly today with zero policies, exactly like
-- every other core table here. A policy is added later, in its own
-- migration, only if the Hub UI ever needs the browser to read this
-- table directly under a user's own session instead of through a
-- backend — not guessed at here.
ALTER TABLE operational_notes ENABLE ROW LEVEL SECURITY;

-- Property-page lookup — the primary query this table exists to serve
-- (spec Section 2: a collapsible section on Property 360).
CREATE INDEX IF NOT EXISTS idx_operational_notes_property
  ON operational_notes(property_id);

-- Owner/tenant-page lookup, once such a page exists to use it.
CREATE INDEX IF NOT EXISTS idx_operational_notes_subject
  ON operational_notes(subject_type, subject_id)
  WHERE subject_id IS NOT NULL;

-- "Needs privacy review" queue (GOVERNANCE.md Rule 9) — every note
-- ever flagged, visible only to reviewer/admin-tier roles per Q's
-- route, same shape as idx_maintenance_claims_flagged (20260815010000).
CREATE INDEX IF NOT EXISTS idx_operational_notes_flagged
  ON operational_notes(flagged_protected_class)
  WHERE flagged_protected_class = TRUE;

-- Narrower slice of the above: flagged notes still awaiting a human
-- disposition specifically — the actual work queue a reviewer clears,
-- as opposed to the flagged queue's full history.
CREATE INDEX IF NOT EXISTS idx_operational_notes_unreviewed_flagged
  ON operational_notes(review_status)
  WHERE flagged_protected_class = TRUE AND review_status = 'unreviewed';

-- AI-proposal approval queue (spec Section 4) — every ai_proposed note
-- still waiting on a human approve/decline decision.
CREATE INDEX IF NOT EXISTS idx_operational_notes_pending_approval
  ON operational_notes(approval_status)
  WHERE approval_status = 'pending_approval';

DROP TRIGGER IF EXISTS trg_operational_notes_updated_at ON operational_notes;
CREATE TRIGGER trg_operational_notes_updated_at
  BEFORE UPDATE ON operational_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE operational_notes IS
  'Factual operational notes about an owner, tenant, or property, at one of three access tiers (spec: projects/hub/property-360/owner-tenant-operational-notes-SPEC.md, Section 4). Read-only context for a human already doing an operational task — never an input to any automated or human housing decision (Section 10). No complaint counts, behavioral profiling, tenant scoring, or risk/personality scoring exist anywhere in this table by design (Section 4/7).';

COMMENT ON COLUMN operational_notes.review_status IS
  'Disposition of a flagged note by a Management/Compliance-Restricted-or-above human reviewer. Deliberately different vocabulary from maintenance_claims.review_status: retained_restricted keeps the note excluded from operational_notes_visible for anyone below that tier; rephrased_and_released and false_positive_released both RELEASE the note back into normal visibility (see operational_notes_visible, spec Section 5) — the opposite exclusion behavior from maintenance_claims_decision_safe''s permanent-exclusion pattern, required by counsel''s explicit three-disposition review model, not an oversight.';


-- ============================================================
-- SECTION C: operational_notes_visible — view (spec Section 5)
--
-- ============================================================
-- WHY THIS VIEW'S EXCLUSION LOGIC DELIBERATELY DIFFERS FROM
-- maintenance_claims_decision_safe / maintenance_snapshot_events_
-- decision_safe — READ BEFORE "FIXING" THIS
-- ============================================================
-- Both of those views permanently exclude any row where
-- flagged_protected_class = TRUE, REGARDLESS of review_status —
-- confirmed directly against the live view definition
-- (20260815010000_maintenance_history_schema.sql):
-- `WHERE flagged_protected_class = FALSE AND review_status != 'rejected'`.
-- That is correct for maintenance ticket narrative, where "flagged"
-- means the content should never appear in the normal ticket view
-- again, full stop. (Note: the spec this migration implements
-- originally attributed this requirement to a quoted Asimov review
-- that does not actually exist anywhere in this codebase — a
-- fabricated citation, caught and corrected 2026-09-05. The technical
-- description above is verified directly against the real SQL; only
-- the false attribution was removed.)
--
-- Counsel's model for THIS feature requires the opposite outcome for
-- two of the three review dispositions (spec Section 5, quoting
-- counsel directly): "Compliance reviewer decides → retain restricted;
-- convert to operationally appropriate language; or classify as a
-- false positive and release." Two of those three outcomes —
-- rephrase-and-release, false-positive-release — REQUIRE the item to
-- become normally visible again, at whatever tier the reviewer
-- assigns. A decision-safe view that permanently excludes anything
-- ever flagged would make counsel's explicitly-approved feature
-- impossible to build correctly. This is a deliberate, counsel-
-- required divergence from this codebase's existing pattern, not an
-- oversight — call it out to Asimov by name if this migration is ever
-- reviewed against the maintenance_history precedent, precisely
-- because it looks, on the surface, like repeating a mistake this
-- codebase already fixed once.
--
-- A flagged-and-retained_restricted note stays permanently excluded
-- from this view for anyone below Management/Compliance-Restricted
-- tier — same exclusion outcome as maintenance_claims_decision_safe
-- for that one specific disposition, just not for all three.
--
-- What this view does NOT do: decide who can see a given row's
-- access_tier. This view only answers "should this note be visible to
-- anyone at all" (is it an approved AI draft or a manual note, and is
-- it clear of an unresolved/retained flag). The application layer
-- additionally filters these rows by the viewer's NOTE_TIER_RANK
-- against each row's access_tier (spec Section 3) — that per-viewer
-- tier check is Q's application code, not expressible in this view.
--
-- Note on RLS and views (same fact already documented for
-- maintenance_claims_decision_safe, 20260815010000): Postgres views
-- run with the privileges of the view's owner by default, not the
-- querying role, so RLS on operational_notes does not automatically
-- extend to this view. Non-issue today since every reader connects via
-- the Supabase service-role key, which bypasses RLS regardless —
-- flagged here so it's a known fact, not a surprise, if the Hub UI is
-- ever changed to query Supabase directly under a user's own session.
-- ============================================================

CREATE OR REPLACE VIEW operational_notes_visible AS
SELECT * FROM operational_notes
WHERE (source = 'manual' OR approval_status = 'approved')     -- AI drafts stay invisible until approved, always
  AND (
    flagged_protected_class = FALSE
    OR review_status IN ('rephrased_and_released', 'false_positive_released')
  );

COMMENT ON VIEW operational_notes_visible IS
  'Rows eligible to be shown to SOME viewer at SOME tier (spec Section 5) — not a per-viewer visibility check. Deliberately does NOT permanently exclude every ever-flagged row the way maintenance_claims_decision_safe does: a flagged note disposed as rephrased_and_released or false_positive_released is INCLUDED again, per counsel''s explicit three-disposition review model. Only a flagged note still unreviewed, or disposed as retained_restricted, is excluded. The application layer must still filter these rows by the viewer''s tier against access_tier (spec Section 3) before rendering — this view alone is not sufficient access control.';


-- ============================================================
-- SECTION D: audit_log — NO SCHEMA CHANGE (spec Section 9; task brief
-- point 4). Documented here, not left to be assumed silently.
-- ============================================================
-- Spec Section 9 adds two new `action` string values for this feature:
--   operational_notes.tier_access_acknowledged
--   operational_notes.viewed
-- (alongside operational_notes.created, .ai_proposed, .approval_decided,
-- .protected_class_flagged, .reviewed, .corrected, and
-- .privacy_queue_acknowledged — all likewise just new `action` string
-- values, not new columns.)
--
-- Confirmed directly against audit_log's real, current schema, not
-- assumed:
--   - 20260720000003_foundation.sql (original CREATE TABLE): action
--     TEXT NOT NULL (free text — no CHECK constraint on this column,
--     confirmed by reading the CREATE TABLE statement in full), plus
--     entity_type TEXT NOT NULL, entity_id UUID NOT NULL,
--     performed_by UUID, details JSONB, created_at TIMESTAMPTZ.
--   - 20260815000000_audit_log_rule1_compliance.sql (Rule 1 upgrade):
--     ADDS actor_type, actor_id, actor_version, event_type,
--     event_summary, event_data JSONB, privacy_category,
--     regulation_tags[], risk_level, legal_basis, retention_policy,
--     contact_id, property_id, sequence_num, prev_hash, entry_hash.
--     Confirmed the original `details` JSONB column is preserved,
--     untouched, alongside the new `event_data` JSONB column (the
--     migration's own genesis-row INSERT writes to both). Confirmed
--     the CHECK constraints added on the three columns this feature's
--     new actions need:
--       audit_log_actor_type_check:       ('human', 'ai_agent', 'system')
--       audit_log_privacy_category_check: ('collection', 'processing',
--                                          'dissemination', 'invasion',
--                                          'unclassified')
--       audit_log_risk_level_check:       ('unclassified', 'low',
--                                          'medium', 'high', 'critical')
--
-- Spec Section 9's table for this feature's audit events uses
-- actor_type IN ('human', 'ai_agent', 'system') and privacy_category
-- IN ('collection', 'processing') and risk_level IN ('low', 'medium',
-- 'high') throughout, including for the two new events — every one of
-- those values is already legal under the CHECK constraints above.
-- `operational_notes.viewed`'s required payload, per spec Section 9 —
-- details: { note_id, property_id, access_tier, actor_role } — fits
-- the existing JSONB `details` (or `event_data`) column with no
-- change; `entity_type`/`entity_id` (already NOT NULL columns) hold
-- 'operational_note' / the note's own id, same pattern every other
-- domain in this schema already uses.
--
-- CONCLUSION: audit_log genuinely needs no schema change for this
-- feature's two new audit-log actions, or any of its other five. This
-- is a real, confirmed finding (I read both files in full and checked
-- every constraint before concluding this), not an assumption carried
-- over from the task brief's framing. If this ever turns out to be
-- wrong — e.g. if a future actor_type/privacy_category/risk_level
-- value this feature needs isn't already on one of the three CHECK
-- lists above — that is a real, separate migration to widen the
-- relevant CHECK the same DROP-then-ADD way used throughout this
-- schema, not something to force through by picking the nearest
-- existing value.
-- ============================================================


-- ============================================================
-- SECTION E: RULE 4 DATA INVENTORY (GOVERNANCE.md Rule 4, spec Section
-- 4's own inventory, carried forward verbatim — not re-derived here)
-- ============================================================
--   pii_fields:          note_text — highest density by design;
--                         reviewer_notes — same PII-adjacent caveat
--                         used everywhere in this schema;
--                         flagged_category — could indirectly reveal
--                         the sensitive topic without containing it.
--   agents_with_access:  Claude (ANTHROPIC_API_KEY), only for the
--                         ai_proposed path (spec Sections 5/8, not yet
--                         built); Hub users holding a role mapped to
--                         Operational tier or above for
--                         tool='owner_tenant_notes' (spec Section 3),
--                         scoped per-note by access_tier. As of THIS
--                         migration specifically (schema only): the
--                         table exists but is empty — nothing reads or
--                         writes it yet, no pipeline or route exists.
--   privacy_category:    Owner/tenant operational record — same
--                         category maintenance_claims uses, extended
--                         to cover owner-side content this schema
--                         hasn't stored before.
--   retention_policy:    PLACEHOLDER pending Mason (spec Section 4/9)
--                         — same explicitly-allowed placeholder pattern
--                         as maintenance_claims, maintenance_snapshot_
--                         events, and security_deposit_cases before
--                         Mason set an actual figure for each.
--   ccpa_exportable:     TRUE.
--   ccpa_deletable:      TRUE, via the same targeted note_text/
--                         reviewer_notes -> "[REDACTED]" redaction
--                         convention as maintenance_claims.claim_text,
--                         preserving subject_type, category,
--                         access_tier, and dates for audit continuity.
--                         Same accepted v1 limitation as every other
--                         domain in this schema: finding every row
--                         about a specific person is a manual lookup
--                         via subject_id/property_id, not automatic.
--
-- RLS: enabled, zero permissive policies at creation on
-- operational_notes (Section B above). team_member_tool_roles is
-- unchanged in RLS posture by this migration — it already has RLS
-- enabled with zero permissive policies (20260812020000); the widened
-- CHECK inherits that same locked-down posture automatically.
-- ============================================================


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP VIEW IF EXISTS operational_notes_visible;
--
-- DROP TRIGGER IF EXISTS trg_operational_notes_updated_at ON operational_notes;
--
-- DROP INDEX IF EXISTS idx_operational_notes_pending_approval;
-- DROP INDEX IF EXISTS idx_operational_notes_unreviewed_flagged;
-- DROP INDEX IF EXISTS idx_operational_notes_flagged;
-- DROP INDEX IF EXISTS idx_operational_notes_subject;
-- DROP INDEX IF EXISTS idx_operational_notes_property;
--
-- -- Safe to drop in full as long as nothing has been built on top of
-- -- this table yet (true as of this migration — no Q, no Tron, nothing
-- -- consumes operational_notes). If a later phase has since inserted
-- -- real rows, dropping the table loses them — confirm nothing depends
-- -- on this data first.
-- DROP TABLE IF EXISTS operational_notes;
--
-- -- Only safe if no row has been written with tool='owner_tenant_notes'
-- -- yet.
-- ALTER TABLE team_member_tool_roles
--   DROP CONSTRAINT IF EXISTS team_member_tool_roles_tool_check;
-- ALTER TABLE team_member_tool_roles
--   ADD CONSTRAINT team_member_tool_roles_tool_check
--   CHECK (tool IN (
--     'insurance_compliance',
--     'maintenance_history',
--     'security_deposit',
--     'call_stats',
--     'content_engine',
--     'leadsimple_application_screening',
--     'leadsimple_delinquency',
--     'leadsimple_operations',
--     'approval_briefing'
--   ));
--
-- ============================================================
