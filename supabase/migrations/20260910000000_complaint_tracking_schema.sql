-- ============================================================
-- *** SUPERSEDED — DO NOT APPLY THIS FILE ***
-- ============================================================
-- This migration was never applied to the live database (confirmed,
-- repeatedly, in the compliance trail for archive-search-significance-
-- technical-spec.md v2). It has been superseded in full by
-- 20260913020000_archive_search_significance_complaint_merge_schema.sql,
-- which creates complaint_tracking_config and complaints (evolved —
-- shared 8-value category taxonomy, escalation_signal, discovery_
-- context, owner_instruction_rejected, and more, per that spec's
-- Section 7) together with missive_message_links and missive_
-- conversation_significance, in one fresh, dependency-ordered migration,
-- exactly per that spec's own Section 7 recommendation. Same convention
-- 20260912050000_reconcile_20260912040000_timestamp_collision.sql
-- already used for a comparable same-repo situation (a short, prominent
-- notice on the superseded file, pointing to its replacement, rather
-- than deleting or rewriting the file itself).
--
-- DO NOT paste this file into Supabase's SQL Editor. Paste
-- 20260913020000_archive_search_significance_complaint_merge_schema.sql
-- instead. Everything below this notice is preserved as-written, for
-- history only.
-- ============================================================
--
-- ============================================================
-- Migration: 20260910000000_complaint_tracking_schema
-- Created:   2026-09-10
-- Author:    Neo (database specialist)
--
-- Schema for the "Complaint & Issue Tracking" Hub feature
-- (projects/hub/email-intake/complaint-tracking-technical-spec.md,
-- section "Proposed Data Model"; product design in
-- projects/hub/email-intake/complaint-tracking-v1-scope.md). Implements
-- that spec's data model exactly, as already fixed by Neo's own prior
-- schema review of that document (see the spec's "Neo's Schema Review —
-- 2026-09-09" section) and cleared by a real, independent Asimov +
-- Mason technical pass on 2026-09-10 (see the spec's "Asimov + Mason
-- Technical Review — 2026-09-10" section). Nothing in this file
-- redesigns, second-guesses, or "improves on" a decision the spec
-- already made — this is the build step, not another design pass. The
-- one place this migration exercises independent judgment is Open Item
-- 4 (the duplicate "close match" algorithm beyond exact-subject-match),
-- which the spec names as genuinely open and explicitly defers to
-- application code (Q), not to this migration — nothing here implements
-- it; see the comment on `possible_duplicate_of_id` below for why that
-- stays true even after this file exists.
--
-- No application code, no router, no UI, no cron job, and no seed/grant
-- row into team_member_tool_roles ships from this file — schema only,
-- per Neo's standing role and this schema's own repeated convention.
-- This migration is NOT applied here — Peter applies it himself via
-- Supabase's SQL Editor, per this project's standing convention (no
-- CLI/DB URL in this environment).
--
-- Governance status: this is a GOVERNANCE.md compliance build under all
-- three of CLAUDE.md's triggers (stores personal data about tenants,
-- owners, and team members; reads real correspondence to make a triage
-- judgment; its Category 6 path can influence how staff treat a
-- tenant). The product-level design was reviewed and cleared by Asimov
-- and Mason; this technical spec then received its own separate,
-- focused Asimov + Mason pass on 2026-09-10 (APPROVED WITH CONDITIONS /
-- FLAGGED-approved with conditions respectively) — every condition from
-- that pass is resolved or explicitly, knowingly accepted by Peter as a
-- named risk (spec's own "Open Items" section). This migration does not
-- itself activate anything live against real tenant mail — per
-- GOVERNANCE.md Rule 7 and the spec's Design Decision 16, the
-- categorization pipeline that reads this schema still needs its own
-- shadow-mode period before real use (see
-- compliance/complaint-tracking-ai-risk-assessment.md), and this build
-- stays manually-triggered only (no cron) for that period, per the
-- task's own explicit instruction.
--
-- ============================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT BUILD
-- ============================================================
--   - The ingestion pipeline, categorization model, duplicate-match
--     algorithm, aging job, or any router/UI. All Q's work, on top of
--     this schema, per the spec's own "Rough Build Size" section.
--   - Any seed/grant row into team_member_tool_roles for
--     tool='complaint_tracking'. This migration only makes the tool
--     value valid to grant — who actually holds admin/
--     director_of_operations access to THIS tool is Peter's call, made
--     after Q has built something to grant access to. Same deferral
--     every prior tool onboarding in this schema has used
--     (leasing_reviewer, pod_lead, maintenance_coordinator,
--     owner_tenant_notes).
--   - Any new team_member_tool_roles.role value. Design Decision 15:
--     'admin' and 'director_of_operations' already exist and are the
--     only two roles this tool ever checks — the role CHECK constraint
--     is not touched by this migration at all.
--   - Any RLS policy grant. RLS is enabled on both new tables with zero
--     permissive policies at creation — matches every table in this
--     schema; every reader today connects via the service-role key,
--     which bypasses RLS regardless (Data Inventory, spec).
--   - Any change to `audit_log`. Every actor_type/privacy_category/
--     risk_level value the spec's Design Decision 11 table uses is
--     already legal under audit_log's real, current CHECK constraints
--     (20260815000000_audit_log_rule1_compliance.sql) — confirmed
--     directly against that file for this migration, not assumed from
--     the spec's own account of it: actor_type IN ('human','ai_agent',
--     'system'), privacy_category IN ('collection','processing',
--     'dissemination','invasion','unclassified'), risk_level IN
--     ('unclassified','low','medium','high','critical'). Every value
--     Design Decision 11 uses is a subset of these. No schema change
--     needed.
--   - Any FK from `complaints` back into `missive_message_intake`. That
--     table's own migration (20260905020000) is explicit it carries
--     zero FKs by design — traceability stays a plain TEXT column,
--     `source_missive_conversation_id`, same "external system, no
--     enforced FK" convention as `call_stats.aircall_user_id`.
--   - A CHECK constraint enforcing the duplicate "close match" algorithm
--     beyond exact-subject-match. Spec Open Item 4 names this as a real,
--     not-yet-specified algorithm for Q to implement in application
--     code — a similarity judgment over free-text `description`, which
--     a CHECK constraint cannot express. This migration provides only
--     the mechanically-distinct data model the algorithm's output
--     writes into (`possible_duplicate_of_id`, `duplicate_status`,
--     `merged_into_id` — see those columns below), matching exactly the
--     shape the spec's Design Decision 10 already settled. Nothing here
--     guesses at the algorithm itself.
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No. Both new tables are
--       brand new; nothing existing reads or writes either one. The one
--       existing table touched, team_member_tool_roles, only gains a
--       new legal value on its tool CHECK — every row that already
--       exists keeps whatever tool value it already had; none is
--       widened out.
--   [x] Does this touch a table other code depends on?
--       team_member_tool_roles, yes — narrowly: the tool CHECK
--       constraint is dropped and re-added with the same 10 existing
--       values plus one new one, same DROP-then-ADD pattern this
--       constraint has now used 10 times (see "LIVE STATE CHECK"
--       below). No other table's constraint, column, or row is altered.
--   [x] Additive or destructive? Fully additive — two new tables, one
--       new view, one CHECK-constraint widening (+1 legal value, no
--       value removed). No column dropped, no existing row updated, no
--       existing constraint narrowed.
--   [ ] Tested on a copy of the data first? No staging copy of Supabase
--       exists in this project — same standing caveat every migration
--       here has carried to date. Mitigated by: both new tables are
--       brand new and empty (nothing can be broken that doesn't yet
--       exist), and the one existing-table change (the tool CHECK
--       widening) is a pure superset of the current legal values,
--       verified against the actual live constraint definition, not
--       assumed (see "LIVE STATE CHECK" immediately below).
--   [x] Governance go-ahead to build this specific schema — Asimov +
--       Mason technical review, 2026-09-10, APPROVED WITH CONDITIONS /
--       FLAGGED-approved with conditions (spec's own "Asimov + Mason
--       Technical Review — 2026-09-10" section). Not a go-ahead to run
--       the categorization pipeline against real mail — that is a
--       separate, later gate per Rule 7 and the spec's Design
--       Decision 16 / Open Item 11.
-- ============================================================
--
-- ============================================================
-- LIVE STATE CHECK BEFORE WIDENING team_member_tool_roles.tool_check
-- (this constraint has a documented regression history —
-- 20260818000000_fix_role_check_regression.sql — from exactly this
-- kind of DROP/ADD being done against a stale assumption of what the
-- constraint currently allows, instead of the real, current
-- definition.)
-- ============================================================
-- Confirmed directly, by reading every migration file that touches
-- team_member_tool_roles_tool_check, in order: the most recent one is
-- 20260905000000_owner_tenant_operational_notes_schema.sql, which left
-- it at 10 values:
--   ('insurance_compliance', 'maintenance_history', 'security_deposit',
--    'call_stats', 'content_engine', 'leadsimple_application_screening',
--    'leadsimple_delinquency', 'leadsimple_operations',
--    'approval_briefing', 'owner_tenant_notes')
-- No file after 20260905000000 touches tool_check — confirmed by
-- reading each candidate directly: 20260905020000 (Missive intake)
-- states in its own "WHAT THIS MIGRATION DELIBERATELY DOES NOT BUILD"
-- section that it adds no team_member_tool_roles change at all;
-- 20260906000000 (maintenance notes on properties) touches no roles
-- table; 20260908000000 (call_stats HubSpot-native) explicitly reuses
-- the existing tool='call_stats' gate and states no
-- team_member_tool_roles change. This migration's ADD CONSTRAINT below
-- carries forward all 10 existing values plus 'complaint_tracking'
-- (11 total, spec's own "11th value, same DROP-then-ADD pattern used
-- 9 times already" — 10 by the time this migration is confirmed
-- against the live count above) — not a stale list.
--
-- role_check is NOT touched by this migration (Design Decision 15: no
-- new role value). Its current state, per 20260902020000
-- (add_maintenance_coordinator_role, the most recent migration to
-- touch it): 'admin', 'director_of_operations', 'property_manager',
-- 'inspection_coordinator', 'pod_lead', 'reviewer', 'contributor',
-- 'leasing_reviewer', 'maintenance_coordinator' — both roles this tool
-- checks ('admin', 'director_of_operations') already exist in that
-- list, confirmed directly.
-- ============================================================


-- ============================================================
-- RULE 4 DATA INVENTORY (GOVERNANCE.md Rule 4 — required for every new
-- table storing personal data). Content sourced from the technical
-- spec's own "Data Inventory (GOVERNANCE.md Rule 4)" section, translated
-- here into this migration file's own header-comment convention — not
-- re-derived, not restated as new analysis.
-- ============================================================
--
-- complaint_tracking_config — NO PII. Three integer thresholds
--   (blocked_resolution_silence_days, big_deal_aging_clock_hours,
--   duplicate_window_days), a version number, and an approver email
--   (set_by) — an internal operating parameter, not personal data
--   about any tenant, owner, or team member. RLS: enabled, zero
--   permissive policies (see table section below).
--
-- complaints — the sensitive table. Full inventory:
--   pii_fields:          description (highest density — complaint
--                         content, by design); resolution_note;
--                         blocked_reason/blocked_party/blocked_since
--                         (identify who is refusing/being unresponsive);
--                         flagged_category (could indirectly reveal the
--                         sensitive topic without containing it);
--                         subject_id/subject_type (identifies a
--                         specific tenant/owner/team member);
--                         source_missive_conversation_id (traces back
--                         to real correspondence, via a plain-text
--                         pointer into missive_message_intake — no FK,
--                         see "WHAT THIS MIGRATION DELIBERATELY DOES
--                         NOT BUILD" above).
--   agents_with_access:  the categorization pipeline (Claude, via
--                         ANTHROPIC_API_KEY — already resolved for this
--                         exact use, per operational-notes-SPEC.md
--                         Section 8's confirmed DPA/Commercial-Terms
--                         answer, which applies identically here since
--                         it is the same direct-API credential); Hub
--                         users holding 'admin' or
--                         'director_of_operations' for
--                         tool='complaint_tracking'; any active team
--                         member, for the manual-report form only
--                         (write access to their own submission, no
--                         read access to anything — Design Decision 9).
--   privacy_category:    Complaint/dispute record about a tenant,
--                         owner, or team member — a new category for
--                         this schema (closest existing analog is
--                         operational_notes' "owner/tenant operational
--                         record," but this one also covers
--                         team-member-tied complaints, which that table
--                         never does).
--   retention_policy:    RESOLVED, not a placeholder — the product
--                         doc's own explicit "never delete" stance
--                         (v1-scope.md Section 4) is a real, stated
--                         retention decision: indefinite retention,
--                         matching the pattern already used elsewhere
--                         in this schema (e.g. call_stats' own resolved
--                         indefinite retention). Distinct from deletion
--                         policy — see ccpa_deletable immediately below.
--   ccpa_exportable:     TRUE — this table plainly holds personal data
--                         about identifiable tenants, owners, and team
--                         members.
--   ccpa_deletable:      TRUE for ordinary rows, via the same targeted
--                         description/resolution_note -> "[REDACTED]"
--                         redaction convention operational_notes.
--                         note_text already uses, preserving
--                         subject_type, category, status, and dates for
--                         audit continuity.
--
--                         held_legal_fair_housing = TRUE rows are a
--                         categorical exception — this tool's own
--                         equivalent of operational_notes'
--                         legal_privileged carve-out, for the identical
--                         spoliation/litigation-hold reasoning that
--                         table's own Section 4 already worked through.
--                         The standard redaction path must hard-refuse
--                         (never a silent skip) on any
--                         held_legal_fair_housing = TRUE row, routing
--                         instead to a fresh, per-request hold/
--                         exception determination made by whichever of
--                         admin/director_of_operations handles the
--                         request — no separate named-attorney-
--                         confirmation gate invented here, mirroring
--                         Peter's own already-made decision on the
--                         identical question for operational_notes. Two
--                         audit actions, reused by name pattern:
--                         complaint_tracking.ccpa_deletion_blocked_held
--                         (system, automatic, every time the redaction
--                         endpoint is hit for a held row) and
--                         complaint_tracking.ccpa_deletion_disposition
--                         (human, the actual determination — details
--                         captures the reasoning, never the held row's
--                         own content).
--
-- RLS: enabled on BOTH new tables, zero permissive policies at
-- creation — matches every table in this schema's "locked down until a
-- tool explicitly asks for access" default.
--
-- Rule 10 (handleCCPADelete): for a tenant/owner contact-deletion
-- request, identify every complaints row where subject_id = contact_id
-- (manual lookup via subject_id — same accepted v1 limitation
-- operational_notes already carries, not automatic), apply the
-- redaction path above (with the held_legal_fair_housing carve-out
-- honored), confirm completion, log it permanently. This is Q's
-- application code, not something this migration implements — noted
-- here per Rule 4's own inventory requirement, not built here.
-- ============================================================


-- ============================================================
-- RULE 9 — HOUSING-DECISION FIREWALL (GOVERNANCE.md Rule 9: "Never Use
-- Protected Class Data in Decisions"). Added per Mason's technical
-- review Finding 2 (spec Open Item 10). Read this before writing any
-- query, view, join, or export that touches `complaints` from outside
-- this tool.
-- ============================================================
-- Unlike missive_message_intake (which is structurally firewalled —
-- zero foreign keys into any table in this schema, by design, so no
-- join into a housing-decision table can even be written), `complaints`
-- is NOT structurally firewalled in that same way. It carries real
-- foreign keys (property_id, unit_id, vendor_id) and a subject_id that,
-- on a held_legal_fair_housing = TRUE or flagged_protected_class = TRUE
-- row, can directly identify a real tenant or owner connected to a
-- pending Fair Housing or legal matter. A structural zero-FK design was
-- considered and correctly rejected for this table (Design Decision 8
-- in the technical spec): complaints legitimately needs to join to
-- properties/units/vendors for the tool's own ordinary operation
-- (Property 360 surfacing, the home-page count, the dashboard), in a
-- way missive_message_intake's raw-intake role never does. The firewall
-- here is therefore a WRITTEN POLICY, enforced by review discipline,
-- not by the absence of a foreign key:
--
--   Any join from complaints.subject_id, complaints.
--   held_legal_fair_housing, or complaints.flagged_protected_class into
--   a screening, renewal, eviction, or other adverse-action tool
--   (leadsimple_application_screening, leadsimple_delinquency, any
--   future eviction/non-renewal workflow, or any export that could feed
--   one) REQUIRES a fresh Asimov/Mason review before it is written —
--   never a silent reuse of this table's data for that purpose, no
--   matter how convenient the join looks. This applies even to a join
--   that only checks whether a row exists (e.g. "does this tenant have
--   any complaint on file") — existence alone is exactly the kind of
--   signal Rule 9 exists to keep out of a housing decision.
--
--   One-line policy for whoever holds admin or director_of_operations
--   access to this tool (Design Decision 15 — the only two roles that
--   can see this data at all): knowledge of a pending Fair Housing or
--   legal complaint — held or otherwise — must never factor into a
--   tenant-adverse decision made elsewhere, whether that decision is
--   made by a person or by another tool in this codebase.
--
-- This does not relax anything Design Decision 2 already restricts:
-- the matched protected-class term itself is still never logged in any
-- complaint_tracking.* audit action (see the flag-audit note on
-- `flagged_category` below) — this firewall is about where the ROW's
-- existence and its flags may be used, on top of that existing
-- restriction on what content may ever be logged about it.
-- ============================================================


-- ============================================================
-- SECTION A: complaint_tracking_config (technical spec, Design
-- Decision 5 — GOVERNANCE.md Rule 5, versioned decision thresholds).
-- Two clocks (blocked_resolution_silence_days — a classification
-- trigger; big_deal_aging_clock_hours — an escalation trigger) plus
-- duplicate_window_days (Design Decision 10), one row per version,
-- never updated in place — insert a new version and deactivate the
-- old. Same twice-proven pattern as b2_match_confidence_config
-- (20260813000003) and photo_match_confidence_config (20260820000000).
-- ============================================================

CREATE TABLE IF NOT EXISTS complaint_tracking_config (
  id                                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  version                           INTEGER     NOT NULL,
  blocked_resolution_silence_days   INTEGER     NOT NULL CHECK (blocked_resolution_silence_days > 0),
  big_deal_aging_clock_hours        INTEGER     NOT NULL CHECK (big_deal_aging_clock_hours > 0),
  duplicate_window_days             INTEGER     NOT NULL CHECK (duplicate_window_days > 0),
  is_active                         BOOLEAN     NOT NULL DEFAULT TRUE,
  set_by                            TEXT        NOT NULL,
  set_at                            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes                             TEXT,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (version)
);

-- RLS: enabled, no permissive policies — same "locked down until a tool
-- explicitly asks for access" default as every table in this schema.
ALTER TABLE complaint_tracking_config ENABLE ROW LEVEL SECURITY;

-- At most one active version at a time — same partial-unique-index
-- idiom b2_match_confidence_config / photo_match_confidence_config
-- already use.
CREATE UNIQUE INDEX IF NOT EXISTS idx_complaint_tracking_config_one_active
  ON complaint_tracking_config ((true)) WHERE is_active = TRUE;

-- updated_at trigger — not shown in the technical spec's own inline SQL
-- sketch for this table, but every other versioned-config table in this
-- schema (b2_match_confidence_config, photo_match_confidence_config)
-- gets one, and this table declares the same updated_at column those
-- do. Added here as a Neo judgment call filling a documented-convention
-- gap the spec's abbreviated sketch simply didn't restate — not a
-- redesign of anything the spec decided.
DROP TRIGGER IF EXISTS trg_complaint_tracking_config_updated_at ON complaint_tracking_config;
CREATE TRIGGER trg_complaint_tracking_config_updated_at
  BEFORE UPDATE ON complaint_tracking_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed version 1 — all three values are Peter's real, confirmed
-- decisions (technical spec, Design Decision 5 and Open Items item 1):
-- blocked_resolution_silence_days=2 confirmed 2026-09-09
-- (complaint-tracking-v1-scope.md Sections 3 and 9, down from an
-- initial 4-day proposal); big_deal_aging_clock_hours=24 and
-- duplicate_window_days=3 were Oracle's proposed defaults, confirmed
-- as-is by Peter 2026-09-10 — no longer placeholders. Idempotent — safe
-- to re-run.
INSERT INTO complaint_tracking_config
  (version, blocked_resolution_silence_days, big_deal_aging_clock_hours, duplicate_window_days, is_active, set_by, notes)
VALUES (
  1, 2, 24, 3, TRUE, 'peter@rinconmanagement.com',
  'All three values confirmed by Peter. blocked_resolution_silence_days=2 confirmed 2026-09-09 (down from an initial 4-day proposal). big_deal_aging_clock_hours=24 and duplicate_window_days=3 were Oracle''s proposed defaults, confirmed as-is by Peter 2026-09-10. To change any of these later: in one transaction, set is_active = FALSE on this row and INSERT a new row with the new version and is_active = TRUE — there is no trigger that does this automatically. Per GOVERNANCE.md Rule 6, this is a Standard change requiring Peter''s approval.'
)
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- SECTION B: complaints (technical spec, "Proposed Data Model") — the
-- central table. Every CHECK constraint below is exactly as fixed by
-- Neo's prior schema review of this spec (see the spec's own "Neo's
-- Schema Review — 2026-09-09" section for why each of the three fixes
-- was necessary); nothing here is a new fix invented by this migration.
-- Read the RULE 9 — HOUSING-DECISION FIREWALL section above before
-- writing any query against this table from outside this tool.
-- ============================================================

CREATE TABLE IF NOT EXISTS complaints (
  id                              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Subject / location — nullable throughout; see Design Decision 8 for
  -- why this deliberately diverges from operational_notes.property_id's
  -- NOT NULL. RESTRICT on property_id matches this schema's standing
  -- convention for AppFolio-owned property rows (claims.property_id,
  -- approval_briefings.property_id, operational_notes.property_id all
  -- use the same RESTRICT reasoning: a property row is never expected
  -- to be hard-deleted here).
  property_id                     UUID          REFERENCES properties(id) ON DELETE RESTRICT,
  unit_id                         UUID          REFERENCES units(id) ON DELETE SET NULL,
  vendor_id                       UUID          REFERENCES vendors(id) ON DELETE SET NULL,
  subject_type                    TEXT          CHECK (subject_type IS NULL OR subject_type IN ('owner', 'tenant', 'team_member', 'property')),
  subject_id                      UUID,         -- owners.id | tenants.id | team_members.id | NULL — no enforced FK, same polymorphic pattern operational_notes and audit_log already use (Postgres CHECK constraints can't express "FK into one of three tables" natively)
  needs_matching                  BOOLEAN       NOT NULL DEFAULT FALSE,

  -- Category / significance (product doc Sections 2-3). A fixed,
  -- structural CHECK enum, not DB-configurable — Design Decision 6:
  -- adding/removing a category is realistically a schema/prompt change
  -- either way, same reasoning maintenance_claims.claim_type and
  -- operational_notes.access_tier already use for their own enums.
  category                        TEXT          CHECK (category IS NULL OR category IN (
                                     'legal_compliance', 'blocked_resolution', 'churn_risk',
                                     'escalation_recurrence', 'major_money_property_risk', 'owner_instruction_one_off'
                                   )),
  needs_human_call                BOOLEAN       NOT NULL DEFAULT FALSE,
  held_legal_fair_housing         BOOLEAN       NOT NULL DEFAULT FALSE,

  description                     TEXT,         -- AI summary or the manual reporter's own text; NULL only for held placeholders (enforced below)

  -- Blocked-resolution detail (Design Decision 4) — "explicit refusal"
  -- vs. "inferred from silence" as a real, distinct, structurally
  -- enforced pair of columns, never one generic "Blocked" badge left to
  -- a UI convention.
  blocked_reason                  TEXT          CHECK (blocked_reason IS NULL OR blocked_reason IN ('explicit_refusal', 'inferred_from_silence')),
  blocked_party                   TEXT          CHECK (blocked_party IS NULL OR blocked_party IN ('owner', 'tenant')),
  blocked_since                   TIMESTAMPTZ,

  -- Fair Housing content tag (Design Decision 2 — checkClaim() from
  -- maintenance-history/lib/content-check.js) — advisory metadata only,
  -- no review/visibility-exclusion workflow needed here (unlike
  -- operational_notes) because this tool's entire reader population
  -- (Peter + DO) already sees everything. matched_layer/tier_b_results
  -- are deliberately NOT persisted columns here, same restraint
  -- operational_notes already applies — only flagged_protected_class/
  -- flagged_category are stored; the rest goes only into
  -- audit_log.details. The matched TERM itself is never stored on this
  -- table or logged in any complaint_tracking.* audit action, absent a
  -- separate Asimov extension of the one narrow, already-approved
  -- exception scoped to maintenance_claims.tier_b_classification only.
  flagged_protected_class         BOOLEAN       NOT NULL DEFAULT FALSE,
  flagged_category                TEXT,

  -- Frustration/tone (product doc Section 3a) — advisory only, never
  -- triggers any action on its own.
  tone_trend                      TEXT          CHECK (tone_trend IS NULL OR tone_trend IN ('stable', 'escalating')),

  -- Lifecycle (product doc Section 4): Open -> In Progress -> Blocked ->
  -- Resolved, plus 'held' for a Legal/Fair Housing placeholder. The
  -- full stage-change history lives entirely in audit_log (Design
  -- Decision 11) — this column holds only the CURRENT stage, never a
  -- parallel history table.
  status                          TEXT          NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'blocked', 'resolved', 'held')),
  resolution_note                 TEXT,         -- required once status = 'resolved' (enforced below)

  -- Ownership (Design Decision 12) — owner_team_member_id is the
  -- accountable owner (the DO, for a big-deal complaint; set by
  -- application code, never guessed at by this schema).
  -- delegated_to_team_member_id is who the DO hands the actual work to,
  -- without changing who stays accountable.
  owner_team_member_id            UUID          REFERENCES team_members(id),
  delegated_to_team_member_id     UUID          REFERENCES team_members(id),
  last_aging_nudge_at             TIMESTAMPTZ,

  -- Provenance
  source                          TEXT          NOT NULL CHECK (source IN ('email_ai', 'manual_staff')),
  reported_by_team_member_id      UUID          REFERENCES team_members(id), -- required for manual_staff
  extracted_by                    TEXT,         -- CLASSIFIER_VERSION string, required for email_ai UNLESS held (Design Decision 6; a held row is source='email_ai' but was never AI-categorized, so it has no classifier version to record — see complaints_source_requires_fields below, fixed by Neo's review)
  source_missive_conversation_id  TEXT,         -- plain text, no FK — traceability back to missive_message_intake (external system, sync-order not guaranteed, same convention as call_stats.aircall_user_id)
  complaint_tracking_config_id    UUID          REFERENCES complaint_tracking_config(id), -- which threshold version was in effect (Rule 5); required on every non-held row — see complaints_config_required_unless_held below, added by Neo's review

  -- Duplicate detection (Design Decision 10) — mechanically distinct
  -- from Category 4 recurrence, which must never be merged. The actual
  -- "is this a close match" algorithm beyond exact-subject-match is a
  -- real, not-yet-specified Open Item (Open Item 4) for Q's application
  -- code, not guessed at or enforced here — this migration provides
  -- only the data model its output writes into.
  possible_duplicate_of_id        UUID          REFERENCES complaints(id),
  duplicate_status                TEXT          NOT NULL DEFAULT 'none' CHECK (duplicate_status IN ('none', 'suggested', 'confirmed_merged', 'dismissed')),
  merged_into_id                  UUID          REFERENCES complaints(id),

  -- Category 6 -> Operational Notes (Design Decision 13) — one-way
  -- pointer only; operational_notes has no reciprocal reference. Calls
  -- the real, current proposeAINote() exported from
  -- owner-tenant-notes/router.js (confirmed against that live function
  -- for this migration: required params property_id, subject_type,
  -- subject_id, note_text, category, access_tier, extracted_by,
  -- routed_to_team_member_id, with unit_id/modelFlag/modelCategory
  -- optional — matches the spec's own account exactly).
  proposed_operational_note_id    UUID          REFERENCES operational_notes(id),

  created_at                      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- "Big deal" is exactly: a confirmed category, genuine AI uncertainty,
  -- or a held item — computed once, stored, so every query site (list,
  -- home count, Property 360, the aging job) agrees by construction
  -- rather than re-deriving this logic in N places.
  is_big_deal                     BOOLEAN GENERATED ALWAYS AS (
                                     category IS NOT NULL OR needs_human_call OR held_legal_fair_housing
                                   ) STORED,

  CONSTRAINT complaints_held_excludes_ai_fields CHECK (
    held_legal_fair_housing = FALSE OR (
      category IS NULL AND needs_human_call = FALSE AND description IS NULL
      AND flagged_protected_class = FALSE AND tone_trend IS NULL
    )
  ),
  CONSTRAINT complaints_flag_requires_category CHECK (
    flagged_protected_class = FALSE OR flagged_category IS NOT NULL
  ),
  CONSTRAINT complaints_blocked_requires_reason CHECK (
    category IS DISTINCT FROM 'blocked_resolution' OR blocked_reason IS NOT NULL
  ),
  CONSTRAINT complaints_resolved_requires_note CHECK (
    status IS DISTINCT FROM 'resolved' OR resolution_note IS NOT NULL
  ),
  -- FIXED by Neo's prior review (spec's "Neo's Schema Review" section,
  -- fix 1): the original draft of this constraint required
  -- extracted_by IS NOT NULL for every source='email_ai' row with no
  -- exception for held rows — but a held row (held_legal_fair_housing =
  -- TRUE) is inserted by the email pipeline (source='email_ai') and is,
  -- by design (complaints_held_excludes_ai_fields above), never
  -- AI-categorized, so it genuinely has no classifier version to
  -- record. As originally written, no held row could ever satisfy both
  -- constraints at once — this exempts held rows from the extracted_by
  -- requirement instead of inventing a fake version string to satisfy a
  -- constraint that shouldn't apply to them.
  CONSTRAINT complaints_source_requires_fields CHECK (
    (source = 'manual_staff' AND reported_by_team_member_id IS NOT NULL AND extracted_by IS NULL)
    OR (source = 'email_ai' AND held_legal_fair_housing = TRUE AND extracted_by IS NULL)
    OR (source = 'email_ai' AND held_legal_fair_housing = FALSE AND extracted_by IS NOT NULL)
  ),
  CONSTRAINT complaints_merge_requires_confirmed CHECK (
    merged_into_id IS NULL OR duplicate_status = 'confirmed_merged'
  ),
  -- ADDED by Neo's prior review (spec's "Neo's Schema Review" section,
  -- fix 2): GOVERNANCE.md Rule 5 requires every decision that used a
  -- versioned threshold to reference the version in effect. Duplicate
  -- detection (Design Decision 10) runs against
  -- complaint_tracking_config's duplicate_window_days for every
  -- non-held complaint at creation — manual or email_ai alike — so
  -- every non-held row genuinely used a config version and must record
  -- which one, not just be allowed to. A held row uses no threshold at
  -- all (it skips categorization, content-check, and duplicate
  -- detection entirely — Ingestion Pipeline step 3) and so correctly
  -- has no config version to reference.
  CONSTRAINT complaints_config_required_unless_held CHECK (
    held_legal_fair_housing = TRUE OR complaint_tracking_config_id IS NOT NULL
  )
);

ALTER TABLE complaints ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_complaints_property            ON complaints(property_id) WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_complaints_subject             ON complaints(subject_type, subject_id) WHERE subject_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_complaints_needs_matching      ON complaints(needs_matching) WHERE needs_matching = TRUE;
CREATE INDEX IF NOT EXISTS idx_complaints_duplicate_suggested ON complaints(duplicate_status) WHERE duplicate_status = 'suggested';
CREATE INDEX IF NOT EXISTS idx_complaints_big_deal_open       ON complaints(status) WHERE is_big_deal AND status != 'resolved';
CREATE INDEX IF NOT EXISTS idx_complaints_aging_candidates    ON complaints(created_at) WHERE is_big_deal AND status NOT IN ('resolved');

DROP TRIGGER IF EXISTS trg_complaints_updated_at ON complaints;
CREATE TRIGGER trg_complaints_updated_at
  BEFORE UPDATE ON complaints FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- SECTION C: complaints_needing_attention (Design Decision 14 —
-- tenant lease-end auto-cleanup). Not a stored flag — a query-time
-- view, matching this schema's "computed live" convention already used
-- for call_stats and Property 360's own decision-safe views. A
-- tenant-subject complaint drops out of this view automatically once
-- that tenant has no active lease (per leases.status, already synced
-- from AppFolio) — the underlying row is untouched, still queryable
-- directly, never deleted, matching the product doc's "kept on record,
-- never shown as something needing action."
-- ============================================================

CREATE OR REPLACE VIEW complaints_needing_attention AS
SELECT c.* FROM complaints c
WHERE c.is_big_deal
  AND c.status != 'resolved'
  AND c.merged_into_id IS NULL
  AND (
    c.subject_type IS DISTINCT FROM 'tenant'
    OR c.subject_id IS NULL
    OR EXISTS (
      SELECT 1 FROM leases l WHERE l.tenant_id = c.subject_id AND l.status = 'active'
    )
  );


-- ============================================================
-- SECTION D: team_member_tool_roles.tool CHECK — +1 value
-- (Design Decision 15). No role value added — see "LIVE STATE CHECK"
-- above for why role_check is untouched.
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
    'owner_tenant_notes',
    'complaint_tracking'
  ));

-- No seed/grant INSERT — see "WHAT THIS MIGRATION DELIBERATELY DOES NOT
-- BUILD" above. This migration only makes tool='complaint_tracking'
-- valid to grant; who actually holds it is Peter's call.


-- ============================================================
-- COMMENTS — table/column documentation, same convention as every
-- other migration in this schema.
-- ============================================================

COMMENT ON TABLE complaint_tracking_config IS
  'Versioned thresholds for the Complaint Tracking tool (GOVERNANCE.md Rule 5): blocked_resolution_silence_days (a classification trigger), big_deal_aging_clock_hours (an escalation trigger), duplicate_window_days (Design Decision 10). One row per version, never updated in place — insert a new version and deactivate the old. RLS enabled, zero permissive policies.';

COMMENT ON TABLE complaints IS
  'One record per complaint/issue, however it arrives (AI-categorized email or manual staff report) — projects/hub/email-intake/complaint-tracking-technical-spec.md. Access restricted in application code to admin/director_of_operations for tool=''complaint_tracking'' (Design Decision 15); manual reporters get write-only access to their own submission. Read the RULE 9 — HOUSING-DECISION FIREWALL comment earlier in this migration file before joining this table into any screening, renewal, eviction, or other adverse-action tool. RLS enabled, zero permissive policies.';

COMMENT ON COLUMN complaints.description IS
  'AI summary (email_ai source) or the manual reporter''s own text (manual_staff source). Highest PII density on this table by design. NULL only for held Legal/Fair Housing placeholders — see complaints_held_excludes_ai_fields. CCPA-deletable via redaction to "[REDACTED]", EXCEPT on held_legal_fair_housing = TRUE rows, which hard-refuse the standard redaction path — see the Rule 4 Data Inventory comment earlier in this migration file.';

COMMENT ON COLUMN complaints.held_legal_fair_housing IS
  'TRUE for a minimal placeholder record created when privilege-filter.js''s checkThread() returns held: true (Design Decision 1) — a formal Fair Housing/HUD/CRD complaint or real attorney/legal correspondence. Never AI-categorized (complaints_held_excludes_ai_fields), never redacted by the standard CCPA path (see Rule 4 Data Inventory note above). Drives is_big_deal.';

COMMENT ON COLUMN complaints.flagged_protected_class IS
  'Set by checkClaim() (maintenance-history/lib/content-check.js, Design Decision 2) — advisory tag only, never a hold. The matched term itself is never stored here or logged in any complaint_tracking.* audit action, absent a separate Asimov extension of the one narrow exception already scoped to maintenance_claims.tier_b_classification.';

COMMENT ON COLUMN complaints.subject_id IS
  'owners.id | tenants.id | team_members.id | NULL for subject_type=''property'' or a fully unmatched (needs_matching=TRUE) row. No enforced FK — same polymorphic pattern operational_notes and audit_log already use. See the RULE 9 — HOUSING-DECISION FIREWALL comment earlier in this migration file before using this column to join into any adverse-action tool.';

COMMENT ON COLUMN complaints.possible_duplicate_of_id IS
  'Set when a new complaint matches an existing open complaint on (property_id, subject_type, subject_id) within duplicate_window_days (Design Decision 10). The "is this a close match" algorithm beyond exact-subject-match is Open Item 4 — a real, not-yet-specified choice for Q''s application code, not enforced here.';

COMMENT ON COLUMN complaints.proposed_operational_note_id IS
  'Set when a Category 6 (owner_instruction_one_off) complaint is proposed as an Operational Note via the real, current proposeAINote() exported from owner-tenant-notes/router.js (Design Decision 13). One-way pointer only — operational_notes has no reciprocal reference to this table, matching that router''s own housing-decision-firewall discipline: complaint-tracking requires owner-tenant-notes; nothing in owner-tenant-notes ever requires complaint-tracking.';

COMMENT ON COLUMN complaints.source_missive_conversation_id IS
  'Plain TEXT pointer back to missive_message_intake.missive_conversation_id — no foreign key, by convention (that table carries zero FKs by design; sync order is not guaranteed). Same pattern as call_stats.aircall_user_id.';

COMMENT ON VIEW complaints_needing_attention IS
  'Live-computed "what still needs eyes on it" view (Design Decision 14) — every open, non-merged, big-deal complaint, except a tenant-subject complaint whose tenant no longer has an active lease. The underlying complaints row is never deleted or hidden elsewhere; it just drops out of this one view once the lease-end condition is met.';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP VIEW IF EXISTS complaints_needing_attention;
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
--     'leadsimple_operations',
--     'approval_briefing',
--     'owner_tenant_notes'
--   ));
-- -- Only safe to roll back the tool_check widening above if no row has
-- -- been granted tool='complaint_tracking' since this migration was
-- -- applied — check team_member_tool_roles for that value first; if any
-- -- exists, either delete/reassign those grant rows first or do not run
-- -- this rollback step.
--
-- DROP TRIGGER IF EXISTS trg_complaints_updated_at ON complaints;
-- DROP INDEX IF EXISTS idx_complaints_aging_candidates;
-- DROP INDEX IF EXISTS idx_complaints_big_deal_open;
-- DROP INDEX IF EXISTS idx_complaints_duplicate_suggested;
-- DROP INDEX IF EXISTS idx_complaints_needs_matching;
-- DROP INDEX IF EXISTS idx_complaints_subject;
-- DROP INDEX IF EXISTS idx_complaints_property;
-- -- Safe to drop in full as long as nothing has been built on top of
-- -- this table yet (true as of this migration — no Q, no router, no
-- -- cron job exists that could have written a real row). If a later
-- -- phase has since inserted real rows, dropping this table permanently
-- -- loses that data — confirm nothing depends on it first, and consider
-- -- exporting first (ccpa_exportable = TRUE per the Rule 4 note above)
-- -- if a compliance hold might apply. A held_legal_fair_housing = TRUE
-- -- row in particular must never simply be dropped without a fresh
-- -- legal-hold check first.
-- DROP TABLE IF EXISTS complaints;
--
-- DROP TRIGGER IF EXISTS trg_complaint_tracking_config_updated_at ON complaint_tracking_config;
-- DROP INDEX IF EXISTS idx_complaint_tracking_config_one_active;
-- DROP TABLE IF EXISTS complaint_tracking_config;
--
-- ============================================================
