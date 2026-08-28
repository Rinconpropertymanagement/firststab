-- ============================================================
-- Migration: 20260827000000_approval_briefing_phase1
-- Created:   2026-08-27
-- Author:    Neo (database specialist)
--
-- Phase 1 of the Approval Briefing domain
-- (projects/hub/approval-briefing-SPEC.md, Section 12, "Phase 1 —
-- Schema. Additive only."). Cleared by Asimov's spec-level governance
-- pre-check, recorded verbatim at
-- compliance/approval-briefing-spec-governance-precheck.md: "Neo and Q
-- can start the two most boring, lowest-risk pieces now (Phase 0 and
-- Phase 1)... Neither touches AI text or sends anything to anyone."
-- Phase 2 onward (webhook receiver, AI risk-assessment generation,
-- email send) stays blocked pending re-confirmation that the
-- content-check fix (spec Sections 5/8) closes the gap Asimov found,
-- plus Mason's narrow language check — this migration builds none of
-- that. Schema only, additive only, zero risk to anything already
-- live.
--
-- This is the THIRD domain to build on the Property Brain platform
-- (projects/hub/PROPERTY-BRAIN-ARCHITECTURE.md), after 'maintenance'
-- (20260816000000) and the three leadsimple_* domains (20260825000000).
--
-- Builds exactly what spec Section 12 Phase 1 calls for, no more:
--   1. approval_briefings  -- new dedicated table (spec Section 2.3).
--      NOT a claims-table domain in the LeadSimple/maintenance sense —
--      spec Section 2.1 explains why: most of what this feature does is
--      one-shot workflow orchestration state about a single event, not
--      a durable fact about the world. Read Section 2.1 in full before
--      ever proposing to fold this into `claims`.
--   2. One new claim_type_registry row: (approval_briefing,
--      risk_assessment) — the single deliberate exception spec Section
--      2.1 carves out. This is the only piece of this feature that
--      becomes a claim.
--   3. team_member_tool_roles.tool CHECK widened by one value
--      (approval_briefing) — same DROP-then-ADD pattern used four times
--      already on this table. NO new role value (spec Section 11: this
--      domain reuses property_manager/pod_lead/admin unchanged).
--   4. This domain's own Rule 4 data-inventory addendum (spec Section
--      11), matching the addendum-per-domain structure
--      20260825000000 set for the LeadSimple domains.
--
-- ============================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT BUILD
-- ============================================================
--   - Phase 0 (projects/hub/approval-briefing-SPEC.md Section 12): the
--     properties.latchel_property_id backfill job. That is Q's work
--     (a one-time reconciliation script against live data), not a
--     schema change — nothing here touches it. This table is designed
--     to be fully functional before that backfill runs (spec Section
--     2.4: property_id starts NULL on effectively every real row).
--   - Any webhook receiver, internal router, LATCHEL_WEBHOOK_SECRET
--     verification, or reconciliation-poll code (spec Section 3). All
--     Phase 2, blocked per the governance pre-check above.
--   - The risk-assessment extraction prompt, the content-check wiring,
--     or any AI call of any kind (spec Section 5). All Phase 4, blocked.
--   - Any email generation or send path, nodemailer wiring, or
--     dashboard UI (spec Sections 6-8). Phases 5-6, blocked.
--   - The reminder/escalation scheduler logic itself (spec Section 9) —
--     this migration only provides the columns (reminder_sent_at,
--     escalated_at, escalated_to) a future poll will read/write; no
--     timer, cron, or scheduling code lives in a migration file.
--   - Any RLS policy grant. approval_briefings gets RLS enabled with
--     zero permissive policies at creation, matching every table in
--     this schema. A tool gets explicit access only when Q/Tron
--     actually build something that needs it (Phase 2+).
--   - Any seed/grant of tool='approval_briefing' to any team member.
--     This migration only makes the tool value valid to grant — same
--     deferral already used for leasing_reviewer (20260825000000) and
--     pod_lead (20260813000004). Who gets access is Peter's call, once
--     there's something to access.
--
-- ============================================================
-- LIVE STATE CHECK BEFORE WRITING THIS (team_member_tool_roles has a
-- documented regression history — 20260818000000_fix_role_check_
-- regression.sql — from exactly this class of mistake: widening a
-- CHECK against a stale assumption of what's already live)
-- ============================================================
-- Confirmed via grep across every migration file in this directory: no
-- file after 20260825000000_leadsimple_property_brain_phase1.sql
-- touches team_member_tool_roles_tool_check or
-- team_member_tool_roles_role_check, and 20260825000000 is also the
-- most recent file in the entire supabase/migrations/ directory by
-- filename timestamp. That file's own reconstructed live state (its
-- Section C) is:
--   tool CHECK: ('insurance_compliance', 'maintenance_history',
--                'security_deposit', 'call_stats', 'content_engine',
--                'leadsimple_application_screening',
--                'leadsimple_delinquency', 'leadsimple_operations')
--   role CHECK: ('admin', 'director_of_operations', 'property_manager',
--                'inspection_coordinator', 'pod_lead', 'reviewer',
--                'contributor', 'leasing_reviewer')
-- This migration's tool-CHECK widening builds on top of that 8-tool
-- state. The role CHECK is not touched at all by this migration (spec
-- Section 11 proposes no new role value) — restated unchanged below
-- only because Postgres requires the full CHECK list on every
-- DROP-then-ADD, not because anything about it is changing.
--
-- CAVEAT, stated plainly since it could not be independently verified
-- live (this environment has no direct Supabase credential): this
-- reconstruction trusts that 20260825000000's own reconstruction was
-- accurate and that nothing has since written a tool/role value outside
-- what these files declare. Given the documented regression history on
-- this exact table, Peter (or whoever applies this) should run
-- `SELECT DISTINCT tool, role FROM team_member_tool_roles;` right
-- before applying this migration and confirm no value outside the
-- 8-tool/8-role list above appears. If one does, stop and tell Neo
-- before proceeding — the DROP-then-ADD below would silently narrow
-- live data the same way the 2026-08-17/18 incident did.
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist, run before any
-- migration is handed off for Peter to apply)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No. Every statement here is
--       additive: a new table (CREATE TABLE IF NOT EXISTS), one new
--       claim_type_registry row (INSERT ... ON CONFLICT DO NOTHING,
--       cannot collide with the existing 'maintenance' or
--       'leadsimple_*' rows — different domain value), and a CHECK
--       widening that only ADDS a valid value, never removes one. Every
--       existing row in team_member_tool_roles keeps its current
--       tool/role value valid under the new CHECK.
--   [x] Does this touch any table other code depends on? Yes —
--       claim_type_registry and team_member_tool_roles are shared
--       across the whole Hub. Both changes here are additive-only
--       (an INSERT with ON CONFLICT DO NOTHING guarding re-runs, and a
--       CHECK widening that is a strict superset of the prior list) —
--       nothing existing changes behavior. approval_briefings itself is
--       a brand-new table nothing else in this codebase reads or writes
--       yet.
--   [x] Additive or destructive? Fully additive. No column is dropped,
--       no existing row is altered, no CHECK is narrowed.
--   [ ] Tested on a copy of the data first? No staging copy exists in
--       this project — same standing caveat every migration here has
--       carried to date. Mitigated by: the table is brand new (nothing
--       can be broken that doesn't yet exist), and the two shared-table
--       changes are the same proven-safe DROP-then-ADD/ON-CONFLICT
--       pattern already applied five times without incident on this
--       schema. The one real pre-flight risk is the live-state
--       assumption above — see the pre-apply query called out there.
-- ============================================================


-- ============================================================
-- SECTION A: claim_type_registry — 1 new row (spec Section 2.1's
-- single deliberate exception)
-- Fail-closed vocabulary registration. Until this (domain, claim_type)
-- pair exists here, claims.claims_domain_claim_type_registered (the
-- composite FK from 20260816000000) rejects any insert using it.
-- ============================================================

INSERT INTO claim_type_registry (domain, claim_type, description) VALUES
  ('approval_briefing', 'risk_assessment',
   'The AI''s cited, plain-English read of the risk represented by a Latchel maintenance job sitting in "Needs Approval" — never a bare numeric score standing alone, always a qualitative level plus explanation (spec Section 5). Extracted from the job''s free-text fields only (description, vendor_description, estimate_note), through the same two-layer content check (content-check.js + protected-class-terms.js) every other domain''s free-text extraction already gets, run once, unconditionally, before the text is stored anywhere or used in either email (spec Section 5, corrected 2026-08-27). This is the ONLY claim_type this domain registers — every other piece of this feature (email-sent logs, reminder/escalation state, the cost benchmark, the compiled email bodies) is workflow orchestration state about one specific event, not a durable fact about the world, and lives on approval_briefings directly instead (spec Section 2.1). Mirrored into claims only when the subject (property_id) has resolved — approval_briefings.risk_assessment_text is always the self-contained, authoritative copy regardless (spec Section 2.3/2.4).')
ON CONFLICT (domain, claim_type) DO NOTHING;


-- ============================================================
-- SECTION B: approval_briefings — new table (spec Section 2.3)
--
-- One row per Latchel job's one trip through "Needs Approval." A job
-- that resolves and later re-enters approval gets a SECOND row, not an
-- update to the first (spec Section 2.3 opening) — each is a distinct
-- event with its own briefing, timer, and outcome. This is why there is
-- no UNIQUE constraint on latchel_job_id alone.
--
-- Deliberately NOT a claims_has_a_subject-style requirement (unlike
-- `claims`): property_id and maintenance_request_id are both expected
-- to be NULL on most real rows for a while, per spec Section 2.4 —
-- properties.latchel_property_id is confirmed at 0% populated today,
-- and only 47 of 483 tickets currently match a maintenance_requests
-- row. The whole point of this table's design (spec Section 2.3/2.4) is
-- that the briefing pipeline works fully without either resolving.
-- ============================================================

CREATE TABLE IF NOT EXISTS approval_briefings (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ---- Identity and linkage ----
  -- The one field guaranteed present the instant the webhook or poll
  -- fires (spec Section 2.3, Section 3.6 step 4).
  latchel_job_id              TEXT        NOT NULL,

  -- Raw join-key text, captured even when property_id below can't
  -- resolve yet (spec Section 2.3). Not guaranteed present at the
  -- initial insert (spec Section 3.6 step 4 only lists job id,
  -- trigger_reason, entered_needs_approval_at as insert-time fields) —
  -- populated during the gather step (Section 4) once read.
  latchel_property_id         TEXT,
  appfolio_property_id        TEXT,

  -- Resolved via properties.latchel_property_id at gather time.
  -- RESTRICT, not CASCADE/SET NULL: properties rows are never expected
  -- to be hard-deleted in this schema (AppFolio-owned), matching the
  -- same reasoning already used for claims.property_id (20260816000000)
  -- and property_insurance.property_id (20260720000004).
  property_id                 UUID        REFERENCES properties(id) ON DELETE RESTRICT,
  -- Resolved opportunistically via latchel_job_id; same RESTRICT
  -- reasoning as property_id above and claims.maintenance_request_id.
  maintenance_request_id      UUID        REFERENCES maintenance_requests(id) ON DELETE RESTRICT,

  -- Latchel's own two documented paths into state 27 (spec Section 3.2).
  trigger_reason               TEXT       NOT NULL
                                 CHECK (trigger_reason IN (
                                   'new_job_no_estimate',
                                   'estimate_exceeds_authorization'
                                 )),
  -- Which path actually caught this instance (spec Section 3).
  trigger_source                TEXT      NOT NULL
                                 CHECK (trigger_source IN (
                                   'webhook',
                                   'reconciliation_poll'
                                 )),
  -- From the webhook's state_updated_at when present, else resolved via
  -- GET /jobs/{id}/history/state (spec Section 2.3). Nullable because
  -- it is not always available at insert time.
  entered_needs_approval_at    TIMESTAMPTZ,

  -- ---- What was gathered (spec Section 4), structured only ----
  -- HARD RULE (spec Section 2.3): this snapshot may never include
  -- job.description, job.vendor_description, or job.estimate_note
  -- verbatim. Those free-text fields are read only by the
  -- risk-assessment prompt (Section 5), the one place in this pipeline
  -- that content-checks free text before it lands anywhere durable. Do
  -- not add a raw-JSON "capture everything" column here — see spec
  -- Section 2.3's own explicit warning against recreating the
  -- unguarded-second-copy risk PROPERTY-BRAIN-ARCHITECTURE.md Section
  -- 1.2.1 named for email citations, one column over.
  estimate                     NUMERIC(10,2),
  max_cost                     NUMERIC(10,2),
  issue_id                     TEXT,
  category                     TEXT,
  is_urgent                    BOOLEAN,
  is_emergency                 BOOLEAN,
  severity                     TEXT,
  state_name                   TEXT,

  -- Nullable — field/report name unconfirmed, spec Open Item #1
  -- (Section 4.2). Do not populate this column until that live AppFolio
  -- research pass resolves the source.
  appfolio_maintenance_limit   NUMERIC(10,2),

  -- Structured value: median, low, high, sample size, matched issue_id
  -- — or an explicit "insufficient history" marker (spec Section 7).
  -- Never a bare number with no sample size. JSONB, not separate
  -- columns, because the shape genuinely varies (a real benchmark vs.
  -- an "insufficient history" marker) and nothing here needs to filter
  -- or index on its internal fields.
  cost_benchmark                JSONB,

  -- Structured: matched-category-or-null, the list version used, plus
  -- Latchel's own is_urgent/is_emergency flags carried separately in
  -- the dedicated columns above — spec Section 6 is explicit these must
  -- never be conflated into one signal.
  emergency_match                JSONB,

  -- ---- Risk assessment — self-contained on this row (spec Section
  -- 2.3: "always populated here directly," independent of whether a
  -- claims row was ever written) ----
  risk_assessment_text            TEXT,
  risk_assessment_confidence       NUMERIC(4,3)
                                     CHECK (risk_assessment_confidence IS NULL
                                            OR risk_assessment_confidence BETWEEN 0 AND 1),

  -- Neo's column, per spec Section 5's explicit delegation: "The row
  -- instead records that a risk assessment was attempted and is held
  -- (a flag/hold status — Neo's exact column, Phase 1)." Mirrors the
  -- claims.review_status / flagged_protected_class discipline already
  -- proven on `claims`, sized for this table's own lifecycle instead of
  -- reusing that table's review vocabulary directly.
  risk_assessment_status            TEXT      NOT NULL DEFAULT 'pending'
                                       CHECK (risk_assessment_status IN (
                                         'pending', 'completed', 'held'
                                       )),
  -- Required whenever risk_assessment_status = 'held' — same discipline
  -- as claims.flagged_category / claims_flag_requires_category
  -- (20260816000000): GOVERNANCE.md Rule 9 requires the exclusion
  -- reason to be recorded, not just the fact of exclusion.
  risk_assessment_held_category      TEXT,

  -- Populated only when the subject resolved AND the two-layer content
  -- check passed AND the claim was successfully written (spec Section
  -- 2.3/5) — the durable, reviewable, cross-domain-visible copy. No
  -- ON DELETE CASCADE/SET NULL: claims rows are not expected to be
  -- hard-deleted in this schema, same RESTRICT reasoning used
  -- everywhere else in this migration.
  risk_assessment_claim_id            UUID     REFERENCES claims(id) ON DELETE RESTRICT,

  -- ---- What was sent (spec Section 8) ----
  pm_briefing_recipients                TEXT[],
  pm_briefing_sent_at                    TIMESTAMPTZ,
  -- The actual rendered text sent — the audit record idea #6 asks for
  -- (spec Section 8.1/10.1).
  pm_briefing_body                        TEXT,
  -- Generated, never sent by this system (spec Section 8.2) — the PM
  -- copies, edits, and sends it themselves. No send-path columns exist
  -- for this field by design.
  owner_draft_text                         TEXT,
  -- The "last updated" freshness stamp the design doc's resolved item
  -- calls for (spec Section 2.3).
  last_data_refresh_at                      TIMESTAMPTZ,

  -- ---- Reminder / escalation / outcome (spec Section 9) ----
  reminder_sent_at                           TIMESTAMPTZ,
  escalated_at                                TIMESTAMPTZ,
  escalated_to                                 TEXT[],
  -- Captured by the reconciliation poll once state_id moves off 27
  -- (spec Section 9.2) — doubles as the "was it acted on" signal and,
  -- per spec Section 4.2, the caveated seed of a future owner-decision
  -- history. NOT to be shown to a PM as "owner history" until
  -- Peter/Mason validate the proxy (spec Section 12, Deferred list).
  resolved_state_name                          TEXT,
  resolved_at                                   TIMESTAMPTZ,

  -- ---- Feedback loop (spec Section 10.2) ----
  -- Deliberately separate from claims.correction_reason_code — spec
  -- Section 10.2 walks through why in full: this answers "did the PM
  -- agree with the risk call" (a professional-judgment question), not
  -- "was the claim's content accurate" (correction_reason_code's actual
  -- job). Conflating the two would blur the monthly quality-drift query
  -- PROPERTY-BRAIN-ARCHITECTURE.md Section 6 already runs.
  pm_risk_feedback                               TEXT      NOT NULL DEFAULT 'not_recorded'
                                                    CHECK (pm_risk_feedback IN (
                                                      'agreed', 'disagreed', 'not_recorded'
                                                    )),
  pm_risk_feedback_notes                          TEXT,
  pm_risk_feedback_recorded_by                     TEXT,
  pm_risk_feedback_recorded_at                      TIMESTAMPTZ,

  created_at                                         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                                          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Enforcement #1: a held risk assessment must record why, mirroring
  -- claims_flag_requires_category (20260816000000).
  CONSTRAINT approval_briefings_held_requires_category
    CHECK (risk_assessment_status != 'held' OR risk_assessment_held_category IS NOT NULL),

  -- Enforcement #2: flagged/held text must never actually land in
  -- risk_assessment_text — this is spec Section 5's hard rule
  -- ("risk_assessment_text is NOT populated with the flagged text")
  -- encoded structurally, not just left to pipeline-code discipline.
  CONSTRAINT approval_briefings_held_text_not_populated
    CHECK (risk_assessment_status = 'completed' OR risk_assessment_text IS NULL)
);

-- RLS: enabled, zero permissive policies at creation — matches every
-- table in this schema (spec Section 2.3).
ALTER TABLE approval_briefings ENABLE ROW LEVEL SECURITY;

-- Idempotency safety net for spec Section 3.4's rule ("an
-- already-existing approval_briefings row for the same job that hasn't
-- since resolved means already gathering or already sent"). A partial
-- unique index is a closer match to the actual business rule than a
-- plain UNIQUE(latchel_job_id) would be: it blocks two simultaneously
-- OPEN rows for the same job (the real race Section 3.4 describes —
-- duplicate webhook deliveries, or a created+updated pair) while still
-- allowing a job that resolves and later re-enters approval to get its
-- documented second row (spec Section 2.3 opening). This is Neo's own
-- addition beyond the spec's literal column list, flagged here the same
-- way 20260825000000 flagged its own claims.source_link addition — the
-- spec doesn't ask for this index by name, but Section 3.4's own text
-- describes exactly the constraint it enforces, and it costs nothing to
-- add now versus rediscovering the same race in Phase 2. Full duplicate
-- detection still belongs to the pipeline code (Q, Phase 2) per this
-- schema's standing "database enforces referential integrity,
-- application code enforces business rules" split (20260816000000) —
-- this index is a backstop, not a substitute for that logic.
CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_briefings_open_job
  ON approval_briefings(latchel_job_id)
  WHERE resolved_at IS NULL;

-- Property-scoped lookups, once Phase 0's backfill resolves property_id
-- for a given row — mirrors idx_claims_property's same "cross-domain,
-- per-property" reasoning (20260816000000).
CREATE INDEX IF NOT EXISTS idx_approval_briefings_property
  ON approval_briefings(property_id)
  WHERE property_id IS NOT NULL;

-- Per-ticket lookups, once maintenance_request_id resolves.
CREATE INDEX IF NOT EXISTS idx_approval_briefings_maintenance_request
  ON approval_briefings(maintenance_request_id)
  WHERE maintenance_request_id IS NOT NULL;

-- The reconciliation poll's own primary query (spec Section 9.1/9.2):
-- "every row still open, checked against elapsed time and Latchel's
-- current state" — every unresolved row, cheaply.
CREATE INDEX IF NOT EXISTS idx_approval_briefings_unresolved
  ON approval_briefings(latchel_job_id)
  WHERE resolved_at IS NULL;

-- "Needs review" queue for the feedback loop (spec Section 10.2).
CREATE INDEX IF NOT EXISTS idx_approval_briefings_risk_feedback
  ON approval_briefings(pm_risk_feedback)
  WHERE pm_risk_feedback = 'not_recorded';

DROP TRIGGER IF EXISTS trg_approval_briefings_updated_at ON approval_briefings;
CREATE TRIGGER trg_approval_briefings_updated_at
  BEFORE UPDATE ON approval_briefings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE approval_briefings IS
  'One row per Latchel job''s one trip through "Needs Approval" (approval-briefing-SPEC.md Section 2.3). A job that resolves and later re-enters approval gets a second row, not an update to the first. Dedicated table, not a claims-table domain — most of this feature is one-shot workflow orchestration state about a single event (Section 2.1), not a durable fact about the world. The single exception is risk_assessment_text, which is also mirrored into claims (domain=''approval_briefing'', claim_type=''risk_assessment'') once property_id resolves.';

COMMENT ON COLUMN approval_briefings.risk_assessment_status IS
  'pending = not yet attempted. completed = the two-layer content check passed; risk_assessment_text is populated. held = either content-check layer flagged the generated text; risk_assessment_text is NOT populated (enforced by approval_briefings_held_text_not_populated) and risk_assessment_held_category records why (enforced by approval_briefings_held_requires_category). Email generation (spec Section 8) must render "Risk assessment pending review" when status != ''completed'' — never fall back to reading the raw Latchel free-text fields directly.';

COMMENT ON COLUMN approval_briefings.pm_risk_feedback IS
  'Whether the PM agreed with the AI risk call — a professional-judgment signal, deliberately separate from claims.correction_reason_code, which answers a different question ("was the claim''s content accurate"). See spec Section 10.2 for the full reasoning against conflating the two.';


-- ============================================================
-- SECTION C: team_member_tool_roles.tool CHECK — +1 value (spec
-- Section 11). Same DROP-then-ADD pattern proven in 20260813000004,
-- 20260815010000, 20260818000000, 20260819020000, 20260821000000, and
-- 20260825000000 — see the "LIVE STATE CHECK" note above for the
-- reconstructed 8-tool starting point this builds on. Postgres has no
-- ALTER CONSTRAINT for widening a CHECK in place.
--
-- role CHECK is restated unchanged (Postgres requires the full list on
-- every DROP-then-ADD) — spec Section 11 proposes NO new role value:
-- "unlike LeadSimple's leasing_reviewer, this domain reuses the
-- existing property_manager/pod_lead/admin values directly." Whether a
-- narrower role is warranted is explicitly left to Mason's Section 0
-- review (Open Item #6) — not decided in this migration, and nothing
-- here forecloses adding one later the same DROP-then-ADD way.
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
    'approval_briefing'
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

-- No seed/grant INSERT in this migration, same deferral already used
-- for leasing_reviewer (20260825000000) and pod_lead (20260813000004).
-- This migration only makes tool='approval_briefing' valid to grant —
-- who actually gets it is Peter's call, once Phase 2+ builds something
-- to grant access to.


-- ============================================================
-- SECTION D: DATA INVENTORY ADDENDUM (GOVERNANCE.md Rule 4 /
-- PROPERTY-BRAIN-ARCHITECTURE.md Section 5 — every new domain requires
-- its own addendum, not an assumption an existing entry already covers
-- it). Matches the addendum structure 20260825000000 set for the
-- LeadSimple domains. Covers approval_briefings rows and any mirrored
-- claims rows with domain='approval_briefing' specifically — does not
-- restate or modify any existing entry, which remain correct for their
-- own rows.
--
--   pii_fields:          approval_briefings.pm_briefing_body /
--                         owner_draft_text (rendered content that
--                         includes tenant tenure, maintenance-pattern
--                         counts, and access-instruction excerpts
--                         pulled from a real ticket — real personal
--                         data, even though distilled, per spec Section
--                         11), risk_assessment_text / claims.claim_text
--                         for the mirrored claim, pm_risk_feedback_notes.
--                         No SSNs, bank account numbers, or government
--                         IDs are proposed anywhere in this domain's
--                         data (spec Section 4 gap analysis names no
--                         such field). As of THIS migration specifically
--                         (schema only, Phase 1): the table exists but
--                         is empty — nothing reads or writes it yet, no
--                         ingestion pipeline exists (Phase 2+).
--   agents_with_access:  Once Phase 2+ builds the pipeline: Claude
--                         (existing ANTHROPIC_API_KEY, risk-assessment
--                         prompt only, spec Section 5); the scheduled
--                         webhook/poll process (system, service-role
--                         key); Hub users holding property_manager,
--                         pod_lead, or admin for tool='approval_briefing'
--                         in team_member_tool_roles (spec Section 11 —
--                         whether this should be narrower than those
--                         three existing roles is explicitly Mason's
--                         open call, Open Item #6, not decided here).
--   privacy_category:    Existing-tenant operational and
--                         maintenance-history data (tenure,
--                         maintenance-request pattern counts, access
--                         instructions) plus, for the mirrored
--                         risk_assessment claims, the same category the
--                         'maintenance' domain's existing rows already
--                         carry (spec Section 11). Rent-payment status
--                         is deliberately excluded from this domain
--                         entirely (spec Section 4.4/12) — never
--                         collected here, nothing to redact.
--   retention_policy:    PLACEHOLDER pending Mason (spec Section 11) —
--                         explicitly NOT assumed to be the LeadSimple
--                         domains' 7-year figure, since that number was
--                         tied specifically to Rincon's applicant/
--                         collections records policy, not maintenance
--                         workflow data. Same explicitly-allowed
--                         placeholder pattern used on every comparable
--                         table in this schema (e.g. 20260816000000).
--   ccpa_exportable:     TRUE.
--   ccpa_deletable:      TRUE, via the same targeted-redaction
--                         convention used everywhere else in this
--                         schema: pm_briefing_body, owner_draft_text,
--                         risk_assessment_text, and
--                         pm_risk_feedback_notes redacted to the literal
--                         string "[REDACTED]"; structural/timestamp
--                         fields (trigger_reason, trigger_source,
--                         entered_needs_approval_at, resolved_state_name,
--                         resolved_at, pm_risk_feedback) preserved for
--                         audit continuity, same as every other domain
--                         in this schema (spec Section 11).
--
-- RLS: enabled, zero permissive policies at creation on
-- approval_briefings (Section B above). claim_type_registry and
-- team_member_tool_roles are unchanged in RLS posture by this
-- migration — both already have RLS enabled with zero permissive
-- policies (20260812020000, 20260816000000); the new registry row and
-- widened CHECK inherit that same locked-down posture automatically.
-- ============================================================


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- -- Only safe if no row has been written with tool =
-- -- 'approval_briefing' yet.
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
--     'leadsimple_operations'
--   ));
--
-- DROP TRIGGER IF EXISTS trg_approval_briefings_updated_at ON approval_briefings;
--
-- DROP INDEX IF EXISTS idx_approval_briefings_risk_feedback;
-- DROP INDEX IF EXISTS idx_approval_briefings_unresolved;
-- DROP INDEX IF EXISTS idx_approval_briefings_maintenance_request;
-- DROP INDEX IF EXISTS idx_approval_briefings_property;
-- DROP INDEX IF EXISTS idx_approval_briefings_open_job;
--
-- -- Safe to drop in full as long as nothing has been built on top of
-- -- this table yet (true as of this migration — Phase 1 has no Q, no
-- -- Tron, nothing consumes approval_briefings). If a later phase has
-- -- since inserted real rows, dropping the table loses them — confirm
-- -- nothing depends on this data first.
-- DROP TABLE IF EXISTS approval_briefings;
--
-- -- Only safe if no claims row has been written with
-- -- domain = 'approval_briefing' yet — true as of this migration, since
-- -- no ingestion pipeline exists (Phase 4). If a later phase has since
-- -- inserted real claims, this DELETE will fail on the
-- -- claims_domain_claim_type_registered foreign key (a deliberate,
-- -- correct block, not a bug) — resolve those claims first.
-- DELETE FROM claim_type_registry
--   WHERE domain = 'approval_briefing';
--
-- ============================================================
