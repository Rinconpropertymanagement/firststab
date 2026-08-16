-- ============================================================
-- Migration: 20260815010000_maintenance_history_schema
-- Created:   2026-08-15
-- Author:    Neo (database specialist)
--
-- Part of the Maintenance History tool build
-- (projects/hub/maintenance-history/SPEC.md, "Data Model" section).
-- First real schema step for this tool — governance clearance
-- (Asimov, 6 conditions), the audit_log Rule 1 upgrade
-- (20260815000000_audit_log_rule1_compliance.sql), and live Latchel API
-- verification are all already done. This migration covers spec items
-- #1-#5 under "Data Model": two columns on properties, two columns on
-- maintenance_requests, the new maintenance_claims table, the
-- maintenance_claims_decision_safe view, and the team_member_tool_roles
-- CHECK-constraint extension. Nothing here talks to Latchel, AppFolio,
-- or any external API — this is schema only. Q builds the ingestion
-- pipeline and Hub routes on top of this next.
--
-- ============================================================
-- WHY THIS STAYS SMALL — READ BEFORE ADDING ANYTHING
-- ============================================================
-- The spec is explicit that this data model is "kept deliberately small
-- and additive — anchored only to the four fact-types the 10-ticket test
-- already proved matter (what happened, what was decided and why,
-- whether it held, whether it recurred), not a speculative mirror of
-- every Latchel table." One new table, two tiny column additions, one
-- view, one CHECK-constraint widen. Nothing here mirrors Latchel's Job/
-- Invoice/File objects directly, on purpose — see SPEC.md's "Data Model"
-- intro.
--
-- ============================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT BUILD
-- ============================================================
--   - A versioned confidence-threshold config table (the b2_photo_folders
--     / b2_match_confidence_config pattern, GOVERNANCE.md Rule 5).
--     Rule 5 requires that table ONLY when a threshold decides whether a
--     match/claim skips human review — b2_photo_folders' confidence
--     score decides auto_indexed vs. needs_review. Nothing in this
--     design ever skips review based on confidence: review_status starts
--     at 'unreviewed' for every claim, unconditionally, and has no
--     'auto_indexed' or equivalent value. confidence here is a sort/
--     triage signal only, never a gate. If a later phase adds an
--     auto-accept tier, that is when a versioned config table becomes
--     required — not before. Per SPEC.md's own "Deliberately not built"
--     note under Data Model #3.
--   - A protected-class keyword-list TABLE. SPEC.md's "The Content
--     Check" section is explicit that Layer 1's term list "lives as a
--     maintained code asset (e.g.
--     projects/hub/maintenance-history/lib/protected-class-terms.js),
--     reviewable and editable by Mason the same way GOVERNANCE.md itself
--     is a maintained, owner-approved document — not a database config
--     table, since this is a reference taxonomy, not a numeric decision
--     threshold." That is Q's file to write, not a table Neo creates.
--     This migration's job is only the two columns that record the
--     OUTCOME of that check on a claim (flagged_protected_class,
--     flagged_category below) and the view that structurally excludes
--     anything flagged — see "THE CONTENT CHECK" note on the table
--     below.
--   - A separate "quarantine" table for flagged claims. Per GOVERNANCE.md
--     Rule 9 and SPEC.md: flagged claims are "never deleted... excluded
--     from maintenance_claims_decision_safe... routed to a separate
--     'Needs privacy review' queue." That queue is just
--     `SELECT * FROM maintenance_claims WHERE flagged_protected_class =
--     TRUE`, filtered to reviewer/admin roles by Q's route — the row
--     never leaves maintenance_claims. A second table would be a second
--     copy of the same fact to keep in sync for no real benefit.
--   - Any DB trigger that writes to audit_log automatically. No existing
--     table in this schema does this — every audit_log write in this
--     codebase today (insurance-compliance, security-deposit) happens in
--     application code, not a database trigger, and SPEC.md's "Audit
--     Logging" section describes exactly that: three specific writes
--     from Q's nightly job / review routes. Inventing a new trigger-based
--     pattern here, with no precedent, is more machinery than this task
--     asked for. Instead, see "AUDIT LOG GUIDANCE FOR Q" far below — a
--     precise, field-by-field spec for what Q's application code should
--     write, including the Rule 1 fields (actor_type/actor_id/
--     actor_version/privacy_category/risk_level) this migration's
--     predecessor (20260815000000_audit_log_rule1_compliance.sql) added,
--     so those don't get left at 'unclassified' by default.
--
-- ============================================================
-- BEYOND SPEC.md's LITERAL SQL — FLAGGED EXPLICITLY
-- ============================================================
-- SPEC.md's "Data Model #3" gives an exact column list for
-- maintenance_claims, including prose comments like "populated only for
-- claim_type = 'outcome'" and "populated only for claim_type =
-- 'recurrence'". The literal pseudo-SQL block in the spec does not turn
-- those into enforced CHECK constraints. This migration adds three small
-- CHECK constraints that enforce exactly what the spec's own comments
-- already say, no more:
--   1. outcome_level may only be set when claim_type = 'outcome'.
--   2. related_maintenance_request_id may only be set when
--      claim_type = 'recurrence'.
--   3. flagged_category must be set whenever flagged_protected_class =
--      TRUE — a direct enforcement of GOVERNANCE.md Rule 9 and SPEC.md's
--      "The Content Check": "A hit on either layer sets
--      flagged_protected_class = TRUE and records flagged_category,"
--      and the audit-log entry for every exclusion requires
--      flagged_category in its details. Without this constraint, a bug
--      in Q's content-check code could silently flag a claim with no
--      recorded reason — exactly the kind of silent failure Rule 9
--      exists to prevent.
-- None of these add a new column, a new concept, or new "vocabulary" —
-- they only stop already-declared columns from being used in a way the
-- spec itself says is invalid. Flagged here, not applied quietly, in
-- case Peter or Q wants any of them relaxed before this goes live.
--
-- ============================================================
-- THE CONTENT CHECK (Governance Requirement #4 / GOVERNANCE.md Rule 9)
-- ============================================================
-- Two layers, both run by Q's extraction pipeline BEFORE a claim is ever
-- inserted (this migration only provides the columns the result lands
-- in):
--   Layer 1 — keyword/phrase scan. A maintained list combining
--   GOVERNANCE.md Rule 9's ten categories (race, color, religion, sex,
--   sexual orientation, gender identity, national origin, familial
--   status, disability, source of income) with the California-specific
--   expansions already Mason-reviewed in
--   compliance/ventura-county-compliance-kb.json (topics.fair-housing,
--   entries fh-01 through fh-06: marital status, age, ancestry, genetic
--   information, citizenship/immigration status, primary language, and
--   Section 8 / voucher source-of-income specifically), plus practical
--   health/medical/disability terms — the real category the 10-ticket
--   test itself turned up ("Tenant is complaining of health concerns").
--   Lives in code (protected-class-terms.js), not a table — see above.
--   Layer 2 — the extraction model's own judgment, defense in depth,
--   flagging anything protected-class-adjacent even without a keyword
--   hit.
-- A hit on EITHER layer sets flagged_protected_class = TRUE and
-- flagged_category on the claim row (enforced together by CHECK #3
-- above). Flagged rows stay in maintenance_claims — never deleted —
-- but maintenance_claims_decision_safe (below) structurally excludes
-- them from any read path a future feature might build on.
--
-- ============================================================
-- REVIEW GATE (Governance Requirement #3)
-- ============================================================
-- review_status starts at 'unreviewed' for EVERY claim, no exceptions.
-- There is deliberately no 'auto_indexed'/'auto_confirmed' value —
-- unlike b2_photo_folders, nothing here ever promotes a claim past a
-- human based on a confidence score. See "WHAT THIS MIGRATION
-- DELIBERATELY DOES NOT BUILD" above for why that also means no
-- confidence-threshold config table is needed (Rule 5 only applies once
-- a threshold makes a skip-review decision, and none does here).
--
-- ============================================================
-- CCPA (Governance Requirement #5 / GOVERNANCE.md Rule 10)
-- ============================================================
-- ccpa_deletable: TRUE, via targeted redaction of claim_text and
-- reviewer_notes to the literal string "[REDACTED]" — same convention
-- as audit_log.details (20260720000003_foundation.sql) and
-- security_deposit_cases.reviewer_notes. claim_type, claim_date,
-- outcome_level, and source_reference are preserved for audit
-- continuity (the fact "an event happened on this ticket" stays; the
-- free-text sentence that might name a tenant does not).
-- Known, accepted limitation carried over verbatim from SPEC.md: because
-- claim_text is a sentence of free text, not a tenant_id column, this
-- table cannot automatically find every claim that mentions a specific
-- person. Fulfilling a real CCPA deletion request means a person looks
-- up which maintenance tickets belonged to that tenant's unit/lease
-- (already possible today via existing tables) and redacts the related
-- claims by hand — the same accepted trade-off already documented for
-- b2_photo_folders and lease_tenants in this schema. Not solved here,
-- not silently ignored either.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- 1. properties: one new column (SPEC.md Data Model #1)
-- No new data inventory needed — additive nullable column on an
-- existing, already-governed table, same reasoning as
-- 20260813000000_security_deposit_leases_extension.sql's
-- jurisdiction_county addition.
--
-- Ownership: written by the periodic property-reconciliation step
-- SPEC.md describes ("Properties change rarely, so this can run as an
-- occasional reconciliation step... rather than every night"). Only one
-- writer — omit the field on a run that finds no match rather than
-- writing NULL over a previously-found match, same discipline as every
-- sync-owned column elsewhere in this schema.
--
-- Partial unique index added beyond SPEC.md's literal column list,
-- because the spec explicitly says to match "this schema's existing
-- appfolio_id convention" (20260720000000_add_appfolio_id.sql) — and
-- that convention IS a partial unique index, not just a TEXT column. It
-- exists to catch a real failure mode: a reconciliation bug that matches
-- two Rincon properties to the same Latchel property would otherwise
-- fail silently.
-- ============================================================

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS latchel_property_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_properties_latchel_property_id
  ON properties(latchel_property_id)
  WHERE latchel_property_id IS NOT NULL;

COMMENT ON COLUMN properties.latchel_property_id IS
  'Latchel''s own property ID (GET /properties), once matched to this Rincon property via appfolio_id/address reconciliation. Stored as TEXT, matching this schema''s appfolio_id convention, even though Latchel''s own API types this field as an integer. Written by the maintenance-history tool''s periodic (not nightly) property-reconciliation step. Omit (do not send null) on a run that finds no match — never clear a previously-found match.';


-- ============================================================
-- 2. maintenance_requests: two new columns (SPEC.md Data Model #2)
-- No new data inventory needed — additive nullable columns on an
-- existing, already-governed table, same reasoning as above.
--
-- latchel_job_id is the join key everything in maintenance_claims hangs
-- off of. latchel_claims_synced_at mirrors leases.deposit_synced_at
-- (20260813000000_security_deposit_leases_extension.sql) exactly: lets
-- the nightly ingestion job know what's already processed without a
-- fragile text-matching dedupe step, and lets the UI show "as of
-- [date]."
--
-- MATCHING NOTE FOR Q (not a schema concern, flagged here because it's
-- exactly the kind of thing that's easy to get wrong silently): SPEC.md
-- confirms live that Latchel's Job.order_number matches Rincon's own
-- ticket-reference numbering (e.g. "17061-1") on every job checked, and
-- that this is the primary match path — no fuzzy match needed. This
-- schema does NOT assume order_number is the same value already stored
-- in maintenance_requests.appfolio_id: sync.js's work_order buildRow()
-- (projects/appfolio-sync/sync.js, ~line 240) sets appfolio_id from
-- AppFolio's own `work_order_id || work_order_number`, which has not
-- been directly confirmed equal to Latchel's order_number in this pass
-- — that confirmation is exactly SPEC.md's remaining open item
-- ("confirming the same order_number matching pattern holds across a
-- larger sample"). Whichever field Q ends up matching against, the
-- result lands in latchel_job_id below; no schema change needed either
-- way.
--
-- Partial unique index on latchel_job_id, same reasoning as
-- latchel_property_id above (matches the appfolio_id convention in
-- full, catches a duplicate-match bug loudly instead of silently).
-- ============================================================

ALTER TABLE maintenance_requests
  ADD COLUMN IF NOT EXISTS latchel_job_id           TEXT,
  ADD COLUMN IF NOT EXISTS latchel_claims_synced_at  TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_maintenance_requests_latchel_job_id
  ON maintenance_requests(latchel_job_id)
  WHERE latchel_job_id IS NOT NULL;

COMMENT ON COLUMN maintenance_requests.latchel_job_id IS
  'Latchel''s own job_id (the path-level ID used in GET /jobs/{job_id}), once matched to this Rincon maintenance ticket. Primary match path per SPEC.md: Latchel Job.order_number against Rincon''s own ticket-reference numbering, cross-checked against ref_job_id (offset by +172, confirmed live on 23/23 jobs sampled). The join key for every maintenance_claims row. Written by the nightly Latchel ingestion job — omit (do not send null) when no match is found for a given run.';

COMMENT ON COLUMN maintenance_requests.latchel_claims_synced_at IS
  'When this ticket''s Latchel facts (state history + files) were last pulled and extracted into maintenance_claims. Mirrors leases.deposit_synced_at (20260813000000_security_deposit_leases_extension.sql) exactly: lets the nightly job know what''s already processed without a fragile dedupe step, and lets the UI show "as of [date]." Set together with any new maintenance_claims rows for this ticket by the nightly ingestion job only.';


-- ============================================================
-- DATA INVENTORY (GOVERNANCE.md Rule 4 — required for every new table
-- storing personal data)
-- ============================================================
--   pii_fields:          claim_text — by design, this is where the rich
--                         narrative content lives, so it will routinely
--                         contain tenant names, health/medical mentions,
--                         and other personal detail. Treat as the
--                         highest-PII-density field this migration
--                         creates. reviewer_notes — PII-adjacent, same
--                         caveat used everywhere else in this schema
--                         (security_deposit_cases.reviewer_notes,
--                         lease_tenants). flagged_category — could
--                         indirectly reveal what kind of sensitive topic
--                         was discussed, without containing the topic
--                         text itself.
--   agents_with_access:  Claude (existing ANTHROPIC_API_KEY) for
--                         extraction and protected-class flagging; the
--                         nightly ingestion cron (system, service-role
--                         key); Hub users holding the 'reviewer' or
--                         'admin' role for tool='maintenance_history'
--                         (via team_member_tool_roles, extended below).
--   privacy_category:    Maintenance-history record; may include
--                         health-adjacent free text — flagged as more
--                         sensitive than most existing tables in this
--                         schema, precisely because that's the content
--                         this tool exists to capture.
--   retention_policy:    PLACEHOLDER — pending Mason, same explicitly-
--                         allowed placeholder pattern as
--                         security_deposit_cases, lease_tenants, and
--                         b2_photo_folders.
--   ccpa_exportable:     TRUE.
--   ccpa_deletable:      TRUE, via targeted redaction of claim_text and
--                         reviewer_notes to "[REDACTED]" (same
--                         convention as audit_log.details and
--                         security_deposit_cases.reviewer_notes),
--                         preserving claim_type/claim_date/outcome_level/
--                         source_reference for audit continuity. Finding
--                         which rows belong to a specific tenant is a
--                         manual v1 step — see "CCPA" note above.
--
-- RLS: enabled, no permissive policies — matches every other table in
-- this schema.
-- ============================================================


-- ============================================================
-- TABLE: maintenance_claims
-- What it stores: one row per extracted fact about a maintenance
-- ticket — not a flat mirror of Latchel's own tables. Four fact-types
-- (event / decision / outcome / recurrence), matching exactly what the
-- 10-ticket "Property Brain" experiment
-- (projects/property-brain-experiment/) proved valuable. Every claim
-- carries a source citation and, where AI-derived, a confidence score.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS maintenance_claims (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- CASCADE, not RESTRICT: a claim has no meaning without its ticket,
  -- same reasoning as insurance_notes -> property_insurance
  -- (20260812000000_insurance_notes.sql).
  maintenance_request_id   UUID        NOT NULL REFERENCES maintenance_requests(id) ON DELETE CASCADE,

  claim_type               TEXT        NOT NULL CHECK (claim_type IN (
                              'event', 'decision', 'outcome', 'recurrence'
                            )),

  claim_text               TEXT        NOT NULL,  -- the fact itself, in plain English
  claim_date                DATE,                  -- nullable — "unknown" is a legitimate,
                                                     -- expected value here, same discipline
                                                     -- the 10-ticket test used

  -- Populated only for claim_type = 'outcome' — mirrors the test's own
  -- 1-5 ladder (work completed -> function restored -> resident
  -- confirmed -> no recurrence in window -> verified by later
  -- inspection). Enforced below (see "BEYOND SPEC.md's LITERAL SQL").
  outcome_level             SMALLINT    CHECK (outcome_level IS NULL OR outcome_level BETWEEN 1 AND 5),

  -- Populated only for claim_type = 'recurrence'. No ON DELETE clause
  -- (defaults to RESTRICT) — deliberately different from
  -- maintenance_request_id above: a maintenance_requests row is never
  -- expected to be hard-deleted (system/AppFolio-owned, same as every
  -- other synced table), and if one somehow were, silently losing a
  -- recorded "this happened before" fact via CASCADE would be exactly
  -- the kind of missed-data failure the 10-ticket test was graded
  -- against (0% missed). RESTRICT forces that conflict to be resolved
  -- explicitly instead.
  related_maintenance_request_id UUID  REFERENCES maintenance_requests(id),

  source_type               TEXT        NOT NULL CHECK (source_type IN (
                               'latchel_job_field', 'latchel_state_history',
                               'latchel_invoice_field', 'latchel_job_file'
                             )),
  -- Exactly which record, e.g. "Latchel job 6903, state history entry
  -- 2026-07-30" or "Latchel invoice 304354-231322-2" — mirrors the
  -- test's own [source: ...] citation on every claim. Never a summary
  -- with the source stripped off — the discipline that got the test to
  -- 0% "wrong source."
  source_reference           TEXT        NOT NULL,

  -- NULL for claims copied straight from a structured API field
  -- (nothing to be uncertain about); set only for AI-derived claims.
  confidence                 NUMERIC(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  -- 'system' for a direct field copy, or a model version string for an
  -- AI-derived claim (e.g. 'claude-...-20260815') — cross-references
  -- whatever actor_version Q's audit_log write for this claim uses. See
  -- "AUDIT LOG GUIDANCE FOR Q" below.
  extracted_by                TEXT        NOT NULL,

  -- The Content Check outcome (Governance Requirement #4) — see notes
  -- at top of file. flagged_category required whenever
  -- flagged_protected_class is TRUE, enforced below.
  flagged_protected_class     BOOLEAN     NOT NULL DEFAULT FALSE,
  flagged_category             TEXT,       -- free text, not a rigid enum — Mason should be
                                            -- able to refine categories without a migration

  -- Deliberately NO 'auto_indexed'/'auto_confirmed' option, unlike
  -- b2_photo_folders — see "REVIEW GATE" note at top of file for why
  -- nothing here ever auto-promotes past a human.
  review_status                TEXT        NOT NULL DEFAULT 'unreviewed'
                                 CHECK (review_status IN ('unreviewed', 'confirmed', 'corrected', 'rejected')),
  -- Reused verbatim from 20260803000002_reviewer_workflow.sql /
  -- security_deposit_cases' reviewer columns rather than reinvented.
  reviewed_by                   TEXT,
  reviewed_at                   TIMESTAMPTZ,
  reviewer_notes                 TEXT,

  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Enforcement #1 (see "BEYOND SPEC.md's LITERAL SQL" above): an
  -- outcome_level value only makes sense on an 'outcome' claim.
  CONSTRAINT maintenance_claims_outcome_level_scope
    CHECK (claim_type = 'outcome' OR outcome_level IS NULL),

  -- Enforcement #2: a recurrence link only makes sense on a
  -- 'recurrence' claim.
  CONSTRAINT maintenance_claims_recurrence_link_scope
    CHECK (claim_type = 'recurrence' OR related_maintenance_request_id IS NULL),

  -- Enforcement #3: GOVERNANCE.md Rule 9 requires the exclusion reason
  -- to be recorded, not just the fact that something was excluded.
  CONSTRAINT maintenance_claims_flag_requires_category
    CHECK (flagged_protected_class = FALSE OR flagged_category IS NOT NULL)
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE maintenance_claims ENABLE ROW LEVEL SECURITY;

-- Primary application query: "every claim for this ticket, grouped by
-- type" — exactly the four-section ticket-history view SPEC.md
-- describes (event timeline / decisions / outcome / related tickets).
CREATE INDEX IF NOT EXISTS idx_maintenance_claims_request_type
  ON maintenance_claims(maintenance_request_id, claim_type);

-- "Needs privacy review" queue (Governance Requirement #4) — visible
-- only to reviewer/admin roles per SPEC.md, distinct from the normal
-- per-ticket claims view.
CREATE INDEX IF NOT EXISTS idx_maintenance_claims_flagged
  ON maintenance_claims(flagged_protected_class)
  WHERE flagged_protected_class = TRUE;

-- Unreviewed-claims queue — "every claim still needing a human look,"
-- same query shape as b2_photo_folders' needs_review partial index.
CREATE INDEX IF NOT EXISTS idx_maintenance_claims_unreviewed
  ON maintenance_claims(review_status)
  WHERE review_status = 'unreviewed';

-- Recurrence lookups: "what else links to this ticket."
CREATE INDEX IF NOT EXISTS idx_maintenance_claims_related_request
  ON maintenance_claims(related_maintenance_request_id)
  WHERE related_maintenance_request_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_maintenance_claims_updated_at ON maintenance_claims;
CREATE TRIGGER trg_maintenance_claims_updated_at
  BEFORE UPDATE ON maintenance_claims
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- VIEW: maintenance_claims_decision_safe
-- Any future feature that summarizes, searches, or reasons across
-- maintenance history (recurrence detection, a portfolio-wide
-- dashboard, anything) reads from this view, never the base table
-- directly — makes "don't use flagged or rejected content" the easy
-- default instead of something every future query has to remember.
--
-- Note on RLS and views: Postgres views run with the privileges of the
-- view's owner by default, not the querying role — RLS enabled on the
-- base table does not automatically extend to a view over it in the way
-- a table's own RLS does. In practice this is a non-issue for how this
-- schema is actually used today: every writer/reader in this codebase
-- (AppFolio sync, insurance-compliance, security-deposit) connects with
-- the Supabase service-role key, which bypasses RLS entirely regardless
-- — the same reason RLS-with-zero-policies already works correctly on
-- every base table here. Flagged so it's a known fact, not a surprise,
-- if the Hub UI is ever changed to query Supabase directly under a
-- user's own session instead of through the backend.
-- ============================================================

CREATE OR REPLACE VIEW maintenance_claims_decision_safe AS
SELECT *
FROM maintenance_claims
WHERE flagged_protected_class = FALSE
  AND review_status != 'rejected';


-- ============================================================
-- team_member_tool_roles EXTENSION (SPEC.md Data Model #5)
-- Same DROP-then-ADD CHECK pattern already proven twice
-- (20260803000002_reviewer_workflow.sql,
-- 20260813000004_security_deposit_team_roles.sql) — Postgres has no
-- ALTER CONSTRAINT for widening a CHECK in place. No new table, no PII
-- change: team_member_tool_roles already has its own Rule 4 treatment
-- from 20260812020000_shared_team_members.sql.
--
--   1. tool CHECK — add 'maintenance_history' alongside the existing
--      'insurance_compliance' and 'security_deposit'.
--   2. role CHECK — add 'reviewer', per SPEC.md Data Model #5: "Reuse
--      the existing 'admin' role as-is. One new role recommended:
--      'reviewer' — whoever checks unreviewed/flagged claims." Exactly
--      who gets that role is Peter's call, same as pod_lead was left to
--      him for Security Deposit.
-- ============================================================

ALTER TABLE team_member_tool_roles
  DROP CONSTRAINT IF EXISTS team_member_tool_roles_tool_check;

ALTER TABLE team_member_tool_roles
  ADD CONSTRAINT team_member_tool_roles_tool_check
  CHECK (tool IN (
    'insurance_compliance',
    'security_deposit',
    'maintenance_history'
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
    'reviewer'
  ));


-- ============================================================
-- AUDIT LOG GUIDANCE FOR Q (Governance Requirement #6 / SPEC.md "Audit
-- Logging") — NOT executed by this migration. audit_log itself and its
-- Rule 1 fields already exist (20260815000000_audit_log_rule1_
-- compliance.sql). No trigger is added here — see "WHAT THIS MIGRATION
-- DELIBERATELY DOES NOT BUILD" at top of file for why. This is the exact
-- field guidance the task asked for, so whichever agent writes these
-- INSERTs doesn't leave the new Rule 1 columns at their 'unclassified'
-- defaults when a better value is knowable at write time.
--
-- 1. Every nightly ingestion run, per ticket touched:
--      action / event_type = 'maintenance_claims.ingestion_run'
--      entity_type          = 'maintenance_request'
--      entity_id            = the ticket's maintenance_requests.id
--      actor_type            = 'ai_agent'  (Claude produced the claims
--                               this run inserted; use 'system' only for
--                               a run that touched zero claims because
--                               there was nothing new to extract)
--      actor_id               = the extraction model identifier, e.g.
--                               'claude-maintenance-extractor' — reuse
--                               whatever constant Q's extract-policy.js-
--                               style module already uses for this
--      actor_version          = the actual model version string used
--      privacy_category        = 'collection' (pulling ticket data from
--                               Latchel)
--      risk_level              = 'low' unless the run itself surfaced a
--                               protected-class flag (then see #2)
--      details / event_data   = { claim_ids, claim_types,
--                               source_files_read }
--
-- 2. Every protected-class exclusion:
--      action / event_type = 'maintenance_claims.protected_class_excluded'
--      entity_type          = 'maintenance_claim'
--      entity_id            = the claim's maintenance_claims.id
--      actor_type            = 'system' if matched_layer = 'keyword'
--                               (deterministic list match); 'ai_agent' if
--                               matched_layer = 'model' (the extraction
--                               step's own judgment caught it)
--      actor_id               = 'maintenance-history-content-check' for
--                               the keyword layer, or the same
--                               extraction-model actor_id as #1 for the
--                               model layer
--      actor_version           = the protected-class-terms.js list
--                               version for the keyword layer, or the
--                               model version for the model layer
--      privacy_category         = 'processing' (Solove taxonomy — this
--                               is the system processing already-
--                               collected data to decide what NOT to
--                               surface)
--      risk_level                = 'high' — this is exactly the health/
--                               disability/protected-class-adjacent
--                               content Rule 9 exists to catch
--      details / event_data     = { flagged_category, matched_layer,
--                               claim_type, source_reference } —
--                               deliberately NOT the flagged text itself
--
-- 3. Every human review action:
--      action / event_type = 'maintenance_claims.reviewed'
--      entity_type          = 'maintenance_claim'
--      entity_id            = the claim's id
--      performed_by          = the reviewer's user id (also populate
--                               actor_type = 'human', actor_id = the
--                               reviewer's email — team_members.email,
--                               not a raw UUID, matching the
--                               reviewed_by/resolved_by TEXT-email
--                               convention already used on
--                               maintenance_claims itself and on
--                               b2_photo_folders)
--      privacy_category        = 'processing'
--      risk_level               = 'low' (routine human oversight,
--                               reducing risk rather than creating it) —
--                               unless the review action is a
--                               'corrected' or 'rejected' outcome on a
--                               claim that was ALSO flagged_protected_
--                               class, in which case use 'medium'
--      details / event_data     = { review_status, reviewer_notes }
--
-- All three should also set instance_id/decision_id/action_id/
-- context_snapshot/regulation_tags/legal_basis/contact_id/property_id
-- per audit_log's now-standard shape wherever a real value is available
-- (e.g. property_id from maintenance_requests -> units -> properties);
-- none of those are invented here since they depend on data this
-- migration doesn't have visibility into.
-- ============================================================


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
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
-- ALTER TABLE team_member_tool_roles
--   DROP CONSTRAINT IF EXISTS team_member_tool_roles_tool_check;
-- ALTER TABLE team_member_tool_roles
--   ADD CONSTRAINT team_member_tool_roles_tool_check
--   CHECK (tool IN (
--     'insurance_compliance',
--     'security_deposit'
--   ));
-- -- Only safe to roll back if no row has been written with
-- -- tool='maintenance_history' or role='reviewer' yet.
--
-- DROP VIEW IF EXISTS maintenance_claims_decision_safe;
--
-- DROP TRIGGER IF EXISTS trg_maintenance_claims_updated_at ON maintenance_claims;
--
-- DROP INDEX IF EXISTS idx_maintenance_claims_related_request;
-- DROP INDEX IF EXISTS idx_maintenance_claims_unreviewed;
-- DROP INDEX IF EXISTS idx_maintenance_claims_flagged;
-- DROP INDEX IF EXISTS idx_maintenance_claims_request_type;
--
-- DROP TABLE IF EXISTS maintenance_claims;
--
-- ALTER TABLE maintenance_requests DROP COLUMN IF EXISTS latchel_claims_synced_at;
-- ALTER TABLE maintenance_requests DROP COLUMN IF EXISTS latchel_job_id;
-- DROP INDEX IF EXISTS idx_maintenance_requests_latchel_job_id;
--
-- ALTER TABLE properties DROP COLUMN IF EXISTS latchel_property_id;
-- DROP INDEX IF EXISTS idx_properties_latchel_property_id;
--
-- ============================================================
