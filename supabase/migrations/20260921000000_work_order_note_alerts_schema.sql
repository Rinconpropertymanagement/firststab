-- ============================================================
-- Migration: 20260921000000_work_order_note_alerts_schema
-- Created:   2026-09-21
-- Author:    Neo (database specialist)
--
-- Part of the Work Order Notes Alert feature
-- (projects/hub/work-order-notes-alert-SPEC.md, written by Oracle,
-- 2026-09-21). The feature: when a new Latchel work order is created
-- for a property that has a special-handling note on file
-- (properties.maintenance_notes), send a fixed-template email to that
-- property's pod inbox (Faria or Solimar) so the note is pushed to the
-- right people instead of relying on someone going to look for it.
--
-- This migration is Neo's entire piece of that feature (spec Section 4
-- + Build Sequence item 1): one new table,
-- work_order_note_alerts, that (a) prevents sending the same work
-- order's alert twice no matter how many times Latchel redelivers the
-- webhook or the hourly backstop poll re-checks it, and (b) durably
-- records the outcome of every attempt so a failure is never silent
-- (spec Section 8, "Failure Visibility"). No application code, no
-- webhook route, no email template — that is Q's build, next, on top
-- of this table.
--
-- Governance trail relayed via Jarvis: Asimov reviewed Oracle's spec
-- and approved with conditions, four of which land on this migration:
-- (1) a content-check outcome pair matching maintenance_claims'
-- flagged_protected_class/flagged_category convention exactly, not a
-- new naming scheme; (2) a light-touch Rule 4 data-inventory addendum,
-- same discipline as maintenance_claims, even though the expected
-- conclusion is low sensitivity; (3) a real structural safeguard
-- against double-notification, not just an application-code promise;
-- (4) confirmation that this feature's audit-log event types are
-- compatible with the existing audit_log table/writeAuditLog
-- convention with no structural change needed there. All four are
-- addressed below, each in its own section. See
-- compliance/work-order-note-alerts-data-inventory.md for the full
-- Rule 4 writeup (condition 2).
--
-- One honest gap, flagged rather than hidden: I could not find a
-- standalone written Asimov review document for this specific feature
-- anywhere under compliance/ (checked — every other governance-gated
-- feature in this codebase's history has one, e.g.
-- appfolio-maintenance-notes-governance-review.md,
-- leadsimple-spec-governance-precheck.md,
-- archive-search-significance-complaint-merge-asimov-review.md). The
-- spec file itself (work-order-notes-alert-SPEC.md) still reads
-- "NOT cleared to build... PENDING ASIMOV REVIEW" as of this writing.
-- I'm proceeding on Jarvis's relayed word that Asimov has since
-- reviewed and approved with the conditions listed above — per this
-- project's standing rule that a relayed approval from Jarvis is the
-- approval, not a claim for me to re-verify — and every condition
-- relayed matches, almost verbatim, what Oracle's own spec already
-- proposed and flagged for Asimov to confirm (Sections 4 and 7), which
-- is consistent with a real review that agreed with the spec author.
-- Flagging the missing written artifact anyway, in the report back to
-- Jarvis, since this codebase otherwise treats one as standard
-- practice and Peter may want it on file before this ships for real.
-- ============================================================


-- ============================================================
-- DUPLICATE-NOTIFICATION PREVENTION (Asimov condition 3 / spec
-- Section 4's "small new table" brief, and the Section 2.3/2.4
-- landmine Oracle's spec names directly: Latchel has no delivery
-- guarantee, so the same job can arrive more than once via the
-- webhook, and the hourly backstop poll re-checks overlapping windows
-- on purpose)
-- ============================================================
-- latchel_job_id below carries a real UNIQUE constraint, not just a
-- unique index and not a partial one. That is a deliberate choice,
-- different from this schema's other Latchel-dedup table
-- (approval_briefings, 20260827000000): approval_briefings uses a
-- PARTIAL unique index on latchel_job_id (WHERE resolved_at IS NULL)
-- because its business rule allows the same job to legitimately get a
-- second row later, once the first resolves and the job re-enters
-- approval. This feature's business rule is different and simpler,
-- per spec Section 2.3: "the first delivery this system ever sees for
-- a given latchel_job_id is what triggers the one-time notification,"
-- full stop — a work order's alert never legitimately needs a second
-- row. A plain, full UNIQUE constraint is the correct, tighter fit,
-- and it is also what makes the retry logic in spec Section 4's last
-- paragraph implementable as a single atomic operation: Q's send path
-- can do one INSERT ... ON CONFLICT (latchel_job_id) DO UPDATE ...
-- WHERE work_order_note_alerts.send_status = 'failed', which the
-- database itself enforces as "at most one row per job, ever" — the
-- structural safeguard Asimov's condition asked for, not just an
-- application-code promise to check first and hope nothing races it.
-- (The failed-only WHERE clause on the UPDATE half is Q's application
-- code to write; the schema only guarantees the row is unique, not
-- which conflicts are allowed to update it — see "AUDIT LOG GUIDANCE
-- FOR Q" below for the same division of responsibility.)
-- ============================================================


CREATE TABLE IF NOT EXISTS work_order_note_alerts (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity — latchel_job_id is both the natural key Latchel gives
  -- every work order and this table's dedup/retry key (see above).
  -- latchel_property_id and property_id are both nullable: Oracle's
  -- spec marks property_id nullable explicitly ("nullable FK ->
  -- properties, RESTRICT"), and latchel_property_id gets the same
  -- treatment here even though it's populated on effectively every
  -- real job seen live (spec Section 2.2) — this table's whole purpose
  -- is "don't miss this," and a NOT NULL constraint on a
  -- Latchel-sourced field should never be the reason a compliance-
  -- relevant row fails to write. RESTRICT (not CASCADE/SET NULL) on
  -- property_id matches this schema's standing rule for anything that
  -- records a fact tied to a property or ticket (claims.property_id,
  -- maintenance_claims.related_maintenance_request_id): a property is
  -- never expected to be hard-deleted, and if one somehow were,
  -- silently losing this row's link via CASCADE would be exactly the
  -- kind of missed-data failure this feature exists to prevent.
  latchel_job_id           TEXT        NOT NULL,
  latchel_property_id      TEXT,
  property_id              UUID        REFERENCES properties(id) ON DELETE RESTRICT,

  -- What was resolved. pod mirrors properties.pod's own two real
  -- values plus a third, 'unassigned_both', for spec Section 5.2's
  -- fallback (the property has a triggering note but properties.pod
  -- is NULL, so both pod inboxes were emailed). Not a shared CHECK
  -- with properties.pod — Postgres constraints are per-table — but the
  -- same two real-value spelling ('Solimar', 'Faria'), so a join or
  -- manual comparison against properties.pod always lines up.
  -- recipients is a snapshot of who the email actually went to at
  -- send time (plain TEXT[], same type convention as
  -- audit_log.regulation_tags), not a live reference to
  -- shared_inboxes — if a pod inbox address changes later, this
  -- column still shows what was true when this alert was sent.
  pod                      TEXT        CHECK (pod IN ('Solimar', 'Faria', 'unassigned_both')),
  recipients               TEXT[],

  -- The Content Check outcome (Asimov condition 1) — deliberately the
  -- exact same two columns, same names, same types, same discipline as
  -- maintenance_claims (20260815010000_maintenance_history_schema.sql):
  -- flagged_protected_class is NOT NULL DEFAULT FALSE so every row
  -- states its outcome explicitly, never leaves it implicit.
  -- flagged_category is free TEXT, not a rigid enum, so Mason can
  -- refine categories without a migration, same reasoning
  -- maintenance_claims.flagged_category already uses. Enforced below
  -- (flag requires category, same as maintenance_claims).
  flagged_protected_class  BOOLEAN     NOT NULL DEFAULT FALSE,
  flagged_category         TEXT,

  -- What was sent — the maintenance-notes text as it actually appeared
  -- in the email. If Layer 1/Layer 2 held the note (spec Section 7),
  -- this stores the fixed placeholder text that was sent instead, per
  -- protected-class-terms.js's standing rule: never store the raw
  -- flagged text here or anywhere else.
  notes_snapshot           TEXT,

  -- Outcome and retry (spec Section 4's last paragraph). send_status
  -- has no default — every row this table ever holds represents a
  -- completed attempt with a known outcome, per how Q's send path is
  -- specified to write it (check for an existing row, then attempt,
  -- then insert/update with the real result — never a placeholder
  -- "pending" row written ahead of the attempt).
  send_status              TEXT        NOT NULL CHECK (send_status IN ('sent', 'failed')),
  send_error               TEXT,
  trigger_source           TEXT        NOT NULL CHECK (trigger_source IN ('webhook', 'reconciliation_poll')),
  attempted_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at                  TIMESTAMPTZ,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Duplicate-notification prevention — see the header note above.
  CONSTRAINT work_order_note_alerts_latchel_job_id_unique
    UNIQUE (latchel_job_id),

  -- GOVERNANCE.md Rule 9 enforcement, identical in spirit and wording
  -- to maintenance_claims_flag_requires_category
  -- (20260815010000): a flag with no recorded category is a silent
  -- exclusion, which Rule 9 requires be logged, not just applied.
  CONSTRAINT work_order_note_alerts_flag_requires_category
    CHECK (flagged_protected_class = FALSE OR flagged_category IS NOT NULL),

  -- Beyond the spec's literal column list, flagged explicitly (same
  -- practice as maintenance_claims_outcome_level_scope /
  -- _recurrence_link_scope in 20260815010000): sent_at only makes
  -- sense paired with send_status = 'sent', and should never be set on
  -- a 'failed' row that the next poll or webhook delivery is expected
  -- to retry.
  CONSTRAINT work_order_note_alerts_sent_at_scope
    CHECK (
      (send_status = 'sent'   AND sent_at IS NOT NULL) OR
      (send_status = 'failed' AND sent_at IS NULL)
    )
);

-- RLS: enabled, no permissive policies — matches every table in this
-- schema. All access denied until a tool explicitly grants it via a
-- policy scoped to authenticated users.
ALTER TABLE work_order_note_alerts ENABLE ROW LEVEL SECURITY;

-- Property-scoped lookups — the Property 360 "Work order alerts" card
-- spec Section 8 recommends (most recent alert attempt for a
-- property).
CREATE INDEX IF NOT EXISTS idx_work_order_note_alerts_property
  ON work_order_note_alerts(property_id)
  WHERE property_id IS NOT NULL;

-- The retry/failure-visibility queue spec Sections 4 and 8 both
-- describe — "every alert still in a failed state," same query shape
-- as idx_maintenance_claims_unreviewed (20260815010000).
CREATE INDEX IF NOT EXISTS idx_work_order_note_alerts_failed
  ON work_order_note_alerts(send_status)
  WHERE send_status = 'failed';

-- "Needs privacy review" queue, same shape and same purpose as
-- idx_maintenance_claims_flagged (20260815010000) — kept even though
-- this table has no human review workflow of its own yet (unlike
-- maintenance_claims), because the same query ("every alert whose
-- note text was held") is exactly what Asimov/Mason would ask for
-- first if this feature's content-check outcomes are ever audited.
CREATE INDEX IF NOT EXISTS idx_work_order_note_alerts_flagged
  ON work_order_note_alerts(flagged_protected_class)
  WHERE flagged_protected_class = TRUE;

DROP TRIGGER IF EXISTS trg_work_order_note_alerts_updated_at ON work_order_note_alerts;
CREATE TRIGGER trg_work_order_note_alerts_updated_at
  BEFORE UPDATE ON work_order_note_alerts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- COLUMN COMMENTS — for whoever reads this schema later without this
-- migration file open next to it.
-- ============================================================

COMMENT ON COLUMN work_order_note_alerts.latchel_job_id IS
  'Latchel''s own job_id off the webhook delivery or listJobsUpdatedSince() poll result (spec Section 2.3/2.4). The dedup/retry key this entire table exists for — see the UNIQUE constraint and the migration header note on why it is a full unique, not a partial one like approval_briefings.latchel_job_id.';

COMMENT ON COLUMN work_order_note_alerts.latchel_property_id IS
  'Latchel''s own raw property_id as seen directly on the job (spec Section 2.2), captured independently of whether it resolved to a Rincon properties row. Nullable defensively, not because real jobs are expected to omit it — live-checked 2026-09-21, present with no nulls across 170 sampled jobs.';

COMMENT ON COLUMN work_order_note_alerts.property_id IS
  'Resolved via properties.latchel_property_id (spec Section 2.2''s join path — property-level, not through a matched maintenance_requests row). Nullable per spec Section 4; RESTRICT on delete, never CASCADE/SET NULL, so a property row can''t silently take this alert history with it.';

COMMENT ON COLUMN work_order_note_alerts.pod IS
  'Which pod inbox (or both, in the unassigned-pod fallback, spec Section 5.2) this alert was routed to. Same two real values as properties.pod (''Solimar''/''Faria''), plus ''unassigned_both'' for the fallback case — not a shared constraint with properties.pod, Postgres constraints are per-table.';

COMMENT ON COLUMN work_order_note_alerts.flagged_protected_class IS
  'The Content Check outcome (spec Section 7: Layer 1 keyword scan, run unconditionally at send time, plus Layer 2 AI classification if Asimov/Mason require it for this field) — same column name, type, and discipline as maintenance_claims.flagged_protected_class. TRUE means notes_snapshot below holds the held-content placeholder text, never the raw flagged note.';

COMMENT ON COLUMN work_order_note_alerts.flagged_category IS
  'Free text, not a rigid enum, same reasoning as maintenance_claims.flagged_category: lets Mason refine categories without a migration. Required whenever flagged_protected_class = TRUE (work_order_note_alerts_flag_requires_category below) — never the matched term text itself, only the category, per protected-class-terms.js''s standing rule.';

COMMENT ON COLUMN work_order_note_alerts.notes_snapshot IS
  'properties.maintenance_notes exactly as it appeared in the sent email — or, if the content check held it, the fixed placeholder text ("Maintenance notes on file — flagged for review, see Property 360 for details," spec Section 7) that was sent in its place. Never the raw flagged text.';

COMMENT ON COLUMN work_order_note_alerts.send_status IS
  'Outcome of this specific attempt. ''failed'' rows are automatically retried the next time this latchel_job_id is seen again (next poll, or another webhook delivery for the same job) — see the UNIQUE constraint note above and spec Section 4''s last paragraph. No ''pending''/other value: every row records a completed attempt.';

COMMENT ON COLUMN work_order_note_alerts.trigger_source IS
  'Which path produced this attempt — the live webhook branch on POST /api/approval-briefing/internal/webhook, or the hourly backstop poll (POST /api/approval-briefing/internal/reconcile-work-order-notes, spec Section 2.4). Both paths check and write the same row for a given latchel_job_id, which is exactly what makes running the backstop on overlapping windows safe.';


-- ============================================================
-- DATA INVENTORY (GOVERNANCE.md Rule 4 — required for every new table
-- storing personal data; Asimov condition 2, "a light-touch
-- data-inventory addendum, same discipline as maintenance_claims, even
-- if the conclusion is low sensitivity")
-- ============================================================
-- Full writeup: compliance/work-order-note-alerts-data-inventory.md
-- (this migration's companion document, same split this schema
-- already uses for larger builds — e.g.
-- archive-search-significance-complaint-merge-data-inventory.md
-- alongside 20260913020000). Summarized here, same as every other
-- table in this schema embeds its own Rule 4 summary directly
-- (maintenance_claims, operational_notes):
--   pii_fields:          notes_snapshot — property-level operational
--                         text (vendor contacts, approval routing),
--                         not tenant/applicant narrative; can
--                         incidentally include a vendor's name/phone
--                         number, same caveat properties.maintenance_
--                         notes' own migration (20260906000000)
--                         already flagged for the source column this
--                         one is a snapshot of. flagged_category —
--                         could indirectly reveal what kind of
--                         sensitive topic was caught, without
--                         containing the topic text itself, same
--                         caveat used everywhere else in this schema.
--                         No tenant PII, no SSNs, no financial data.
--   agents_with_access:  the webhook route and reconcile-poll route
--                         (system, service-role key) that write this
--                         table; Layer 1's scanText() (deterministic,
--                         no AI, no network call) and, if Asimov/Mason
--                         adopt it, a Layer 2 AI classifier (Claude),
--                         both read-only against notes text before a
--                         row is written, per spec Section 7; Hub
--                         users wherever the spec Section 8 Property
--                         360 card surfaces this table's rows (access
--                         tier TBD by Q/Tron, not set here).
--   privacy_category:    Property-level operational record, lower
--                         sensitivity than maintenance_claims/
--                         operational_notes (no tenant-narrative free
--                         text) but not zero — see the full addendum
--                         for the reasoning and the one open question
--                         it flags.
--   retention_policy:    7 years. Set directly by Peter, 2026-09-21
--                         ("7 years, same as everything else"), matching
--                         Rincon's standing retention policy already
--                         applied elsewhere (e.g. LeadSimple's
--                         Application Screening/Delinquency tables).
--                         See compliance/work-order-note-alerts-
--                         data-inventory.md for the full note on why
--                         this figure was a deliberate choice, not a
--                         default copy.
--   ccpa_exportable:     TRUE (expected — confirm at build time).
--   ccpa_deletable:      Open — see the full addendum. This table
--                         carries no direct tenant/owner identifier of
--                         its own (property-scoped, not person-
--                         scoped); a vendor name/number that
--                         incidentally appears in notes_snapshot is
--                         reachable only by reading free text, same
--                         accepted v1 limitation as
--                         properties.maintenance_notes itself.
-- ============================================================


-- ============================================================
-- AUDIT LOG GUIDANCE FOR Q (spec Section 9 / Asimov condition 4:
-- "confirm the spec's proposed event types are compatible with the
-- existing audit_log/writeAuditLog convention")
-- ============================================================
-- Confirmed directly against audit_log's real, current schema, not
-- assumed — read both 20260720000003_foundation.sql (original CREATE
-- TABLE) and 20260815000000_audit_log_rule1_compliance.sql (the Rule 1
-- upgrade) in full before writing this note:
--   - actor_type has a CHECK constraint (audit_log_actor_type_check):
--     ('human', 'ai_agent', 'system'). Spec Section 9 uses actor_type:
--     'system' throughout (this feature has no human in the loop at
--     send time) — already legal.
--   - risk_level has a CHECK constraint (audit_log_risk_level_check):
--     ('unclassified', 'low', 'medium', 'high', 'critical'). Spec
--     Section 9, event 3 (work_order_note_alert.send_failed) asks for
--     risk_level: 'high' — already legal. Events 1/2/4/5 don't state a
--     risk_level explicitly; Q should set one rather than leave it at
--     the 'unclassified' default, same practice this schema already
--     follows elsewhere (maintenance-history/router.js's writeAuditLog
--     defaults privacy_category, not risk_level, and leaves risk_level
--     for the caller to set per event).
--   - event_type/action and event_data/details are kept in sync
--     automatically by the audit_log_compute_chain trigger in both
--     directions, so either of this codebase's two existing
--     writeAuditLog() helpers (email-intake/lib/shared.js, hardcodes
--     actor_type: 'system' — the shape this feature's system-triggered
--     events actually match; maintenance-history/router.js, hardcodes
--     actor_type: 'human' — the wrong shape here) work correctly
--     against Section 9's five event types with no schema change.
--     Neither writeAuditLog lives in approval-briefing/router.js today
--     (checked — no match); Q will need to import one or write a
--     small system-actor equivalent there, but that's application
--     code, not a schema gap.
--   - entity_type/entity_id are free TEXT/UUID with no CHECK
--     constraint (confirmed by reading the original CREATE TABLE) — Q
--     can point these at this table's own id (e.g. entity_type:
--     'work_order_note_alert') with no schema change either.
--
-- CONCLUSION: audit_log needs no schema change for this feature's five
-- audit events. This matches what Jarvis relayed as Asimov's finding.
-- If a future event type needs an actor_type/privacy_category/
-- risk_level value not already on one of the three CHECK lists above,
-- that's a real, separate migration to widen the relevant CHECK the
-- same DROP-then-ADD way used throughout this schema (e.g.
-- 20260905010000) — not something to force through by picking the
-- nearest existing value.
-- ============================================================


-- ============================================================
-- MIGRATION GATE (Neo's standard checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] No existing data is deleted or overwritten — this migration
--       only creates a new table. No ALTER, UPDATE, or DELETE against
--       any existing table.
--   [x] Does this touch any table other code depends on? — property_id
--       is a read-only foreign key into properties(id); nothing about
--       properties itself changes, and no existing query, view, or
--       route anywhere in this codebase reads work_order_note_alerts
--       yet (grepped — it doesn't exist before this migration). Zero
--       blast radius on existing functionality.
--   [x] Additive, not destructive — one new table, RLS enabled with
--       zero permissive policies (matches every table in this schema),
--       nothing else touched.
--   [ ] Tested on a copy of Supabase before production apply — no
--       staging copy exists in this project, same standing caveat
--       noted on every migration in this schema to date. Per project
--       convention, Peter applies this himself via Supabase's SQL
--       Editor.
--   [x] Governance: conditions relayed via Jarvis from Asimov's review
--       of work-order-notes-alert-SPEC.md are addressed above
--       (content-check columns, Rule 4 addendum, dedup mechanism,
--       audit_log compatibility). One gap flagged, not hidden: no
--       standalone written Asimov review document was found under
--       compliance/ for this specific feature, unlike every other
--       governance-gated feature in this codebase's history — see the
--       header note above. This migration creates a table and writes
--       no rows and sends nothing; Peter/Jarvis should confirm a
--       governance record gets written for the audit trail before Q
--       builds the send path on top of this schema.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP TRIGGER IF EXISTS trg_work_order_note_alerts_updated_at ON work_order_note_alerts;
--
-- DROP INDEX IF EXISTS idx_work_order_note_alerts_flagged;
-- DROP INDEX IF EXISTS idx_work_order_note_alerts_failed;
-- DROP INDEX IF EXISTS idx_work_order_note_alerts_property;
--
-- DROP TABLE IF EXISTS work_order_note_alerts;
--
-- -- Safe unconditionally: this migration creates one new, standalone
-- -- table and touches nothing else (no ALTER on any existing table,
-- -- no new column anywhere else, no trigger/function shared with any
-- -- other table). Dropping it fully undoes this migration with no
-- -- other cleanup required.
--
-- ============================================================
