-- ============================================================
-- Migration: 20260813000002_security_deposit_cases
-- Created:   2026-08-13
-- Author:    Neo (database specialist)
--
-- Part of the Security Deposit Disposition Assembly Tool build
-- (projects/hub/security-deposit/SPEC.md, item #4 — disposition case
-- tracking). One row per lease/move-out being tracked through this tool.
--
-- DESIGN NOTES
--
--   - move_out_date is COPIED onto this table at case-creation time
--     (from leases.move_out_date), not just joined live. This is what
--     lets disposition_deadline below be a real, structurally-guaranteed
--     GENERATED column instead of something application code has to
--     remember to compute correctly every time — see TARS's requirement
--     in the spec that a day-count bug here is a legal-exposure bug, not
--     a cosmetic one. Postgres generated columns cannot reference another
--     table, so the value has to live here. It is a copy of a fact, not
--     new data entered independently — never edit it after creation;
--     if AppFolio's move_out_date is ever corrected, that correction
--     belongs on `leases.move_out_date` first, and this case's copy
--     should be re-synced from there, not hand-edited.
--
--   - disposition_deadline is GENERATED ALWAYS AS (move_out_date + 21)
--     STORED — not computed in application code. This means the 21-day
--     countdown is correct by construction: there is no code path that
--     can compute it from the wrong date, because the database itself
--     derives it from move_out_date and nothing else (not created_at,
--     not the day the sync ran). Directly satisfies the spec's "the
--     21-day clock is always computed from the true date, never from a
--     sync delay" requirement structurally rather than by convention.
--
--   - status is deliberately a small 3-value set (pending_review,
--     reviewed, escalated) rather than mirroring property_insurance's
--     richer status list. This tool has only two pod-lead actions in the
--     spec's own route sketch (save checklist, mark reviewed) plus an
--     escalate path implied by reusing the reviewer-workflow columns —
--     no route or UI concept exists for a terminal "closed" status,
--     because the actual deposit return happens entirely outside this
--     tool and it has no way to verify it happened (see the spec's
--     Design call on reminders continuing regardless of review status).
--     Inventing a "closed" value here would imply a capability the tool
--     doesn't have.
--
--   - tenancy_status (human-confirmed) + ai_suggested_tenancy_status
--     (auto-suggested, same allowed values) follows the EXACT pattern
--     already proven on property_insurance: a real `status` field plus
--     a separate `ai_suggested_status` column added in
--     20260803000002_reviewer_workflow.sql. Mirrored here rather than
--     inventing a new "confirmed" boolean flag — same reasoning Mason
--     gave for reusing team_member_tool_roles's shape for lease_tenants.
--     Both nullable: nothing is inferred automatically per the spec, and
--     the suggestion may not always be computable from sync data alone.
--
--   - Three checklist fields (checklist_notice_sent,
--     checklist_inspection_conducted, checklist_photos_documented), not
--     two — per the spec's explicit instruction: if Tron builds the
--     preferred two-row version of Compliance Grounding's first
--     question, that's two stored fields (notice sent, inspection
--     conducted) plus the photos-documentation question, three total.
--     All nullable BOOLEAN — "unanswered" is a real, distinct state from
--     both true and false, and nothing may default or infer an answer.
--     Wording lives in the application/UI layer (Compliance Grounding,
--     Mason-finalized 2026-08-13), not duplicated here as a CHECK or
--     comment that could drift out of sync with the real legal wording.
--
--   - Missing-evidence flags (no move-in photos found, no deposit on
--     file, etc. — Gap #8) are deliberately NOT columns on this table.
--     The spec is explicit that "missing" is a derived state computed at
--     read time from whatever the assembly step actually found, not a
--     fact to persist and keep in sync. Storing it here would create a
--     second copy of the truth that could drift from the real B2/AppFolio
--     state between reads.
--
--   - UNIQUE(lease_id): a disposition case corresponds 1:1 to one
--     move-out event on one lease. Each AppFolio occupancy already gets
--     its own `leases` row (a re-lease of the same physical unit after a
--     prior tenant's full move-out is a NEW occupancy_id, hence a NEW
--     leases row), so 1:1 is safe and guards against the nightly job or
--     the manual/backfill creation route ever creating a duplicate case
--     for the same move-out. Lets Q's insert use
--     ON CONFLICT (lease_id) DO NOTHING for idempotent case creation.
--
--   - lease_id uses ON DELETE RESTRICT (the default for a bare
--     REFERENCES with no ON DELETE clause), matching leases.tenant_id's
--     own RESTRICT in the initial schema — a disposition case is exactly
--     the kind of tightly-coupled current-state record that should block
--     an accidental lease deletion, not silently disappear or null out.
--     Deliberately NOT the rental_analyses.property_id SET NULL pattern
--     (20260812010000_rental_analysis_schema) — that table is a
--     standalone historical record designed to survive its cross-
--     reference vanishing; a disposition case has no meaning without its
--     lease.
--
-- ============================================================
-- DATA INVENTORY (GOVERNANCE.md Rule 4 — required for every new table
-- storing personal data)
-- ============================================================
--   pii_fields:          No name/email/phone stored directly — tenant
--                         identity is reached via lease_id → lease_tenants
--                         → tenants. reviewer_notes is free text entered
--                         by a pod lead and could incidentally contain
--                         PII (e.g. a tenant's name or a detail from a
--                         conversation) — treat as PII-adjacent, same
--                         caveat as lease_tenants.
--   agents_with_access:  The nightly cron (internal router, shared-secret
--                         header) creates cases automatically; team
--                         members holding the pod_lead or admin role for
--                         tool='security_deposit' (via
--                         team_member_tool_roles, extended in
--                         20260813000004) read/write via the Hub UI; the
--                         reminder-email sender (system) reads status and
--                         move_out_date to decide what's still open.
--   privacy_category:    Tenancy/financial-compliance record — security
--                         deposit disposition tracking.
--   retention_policy:    PLACEHOLDER — pending Mason, explicitly gated in
--                         the spec on the same open deposit-03 citation
--                         confirmation. Placeholder: retain indefinitely
--                         alongside the underlying lease as a compliance
--                         record (same treatment as `documents` and
--                         `audit_log` elsewhere in this schema); revisit
--                         once Mason sets a real number.
--   ccpa_exportable:     TRUE.
--   ccpa_deletable:      Not directly deletable as a row on a CCPA
--                         request — this is a compliance/audit record
--                         supporting Rincon's own AB 12 21-day-deadline
--                         obligation, not personal data collected for
--                         convenience. On a tenant deletion request,
--                         redact any incidental PII inside reviewer_notes
--                         (targeted UPDATE, same "[REDACTED]" convention
--                         as audit_log.details -
--                         20260720000003_foundation.sql) and leave the
--                         structural record (dates, status, checklist
--                         answers) intact, the same way audit_log rows
--                         are never deleted for CCPA requests.
--
-- RLS: enabled, no permissive policies — matches every other table in
-- this schema.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- TABLE: security_deposit_cases
-- What it stores: one row per lease/move-out being tracked through this
-- tool, from automatic creation at move-out through pod-lead review.
-- Never represents the actual deposit return itself — that happens
-- entirely outside this tool, by hand, same as today.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS security_deposit_cases (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  lease_id               UUID        NOT NULL REFERENCES leases(id),

  -- Copied from leases.move_out_date at creation time — see design note
  -- above for why. Never hand-edited; re-sync from leases if the source
  -- date is ever corrected.
  move_out_date          DATE        NOT NULL,

  -- Structurally correct by construction — see design note above.
  disposition_deadline   DATE        GENERATED ALWAYS AS (move_out_date + 21) STORED,

  status                 TEXT        NOT NULL DEFAULT 'pending_review'
                                       CHECK (status IN ('pending_review', 'reviewed', 'escalated')),

  -- Full tenancy ending vs. one co-tenant moving out while the lease
  -- continues — see design note above (mirrors property_insurance's
  -- status / ai_suggested_status split).
  tenancy_status            TEXT     CHECK (tenancy_status IS NULL OR tenancy_status IN (
                               'full_tenancy_ending',
                               'partial_co_tenant_move_out'
                             )),
  ai_suggested_tenancy_status TEXT   CHECK (ai_suggested_tenancy_status IS NULL OR ai_suggested_tenancy_status IN (
                               'full_tenancy_ending',
                               'partial_co_tenant_move_out'
                             )),

  -- Reviewer checklist — three fields, all nullable until a pod lead
  -- actively answers. Wording lives in the application layer (Compliance
  -- Grounding, Mason-finalized). See design note above.
  checklist_notice_sent          BOOLEAN,
  checklist_inspection_conducted BOOLEAN,
  checklist_photos_documented    BOOLEAN,

  -- Reviewer-workflow columns, reused verbatim from
  -- 20260803000002_reviewer_workflow.sql rather than reinvented, per the
  -- spec's explicit instruction.
  reviewed_by            TEXT,
  reviewed_at            TIMESTAMPTZ,
  escalated_by           TEXT,
  escalated_at           TIMESTAMPTZ,
  reviewer_notes         TEXT,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One case per lease — see design note above.
  UNIQUE (lease_id)
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE security_deposit_cases ENABLE ROW LEVEL SECURITY;

-- Primary queue query: "every open case, most urgent first." A partial
-- index on disposition_deadline for non-terminal statuses keeps this
-- small and fast as the table grows.
CREATE INDEX IF NOT EXISTS idx_security_deposit_cases_deadline
  ON security_deposit_cases(disposition_deadline)
  WHERE status IN ('pending_review', 'escalated');

CREATE INDEX IF NOT EXISTS idx_security_deposit_cases_status
  ON security_deposit_cases(status);

DROP TRIGGER IF EXISTS trg_security_deposit_cases_updated_at ON security_deposit_cases;
CREATE TRIGGER trg_security_deposit_cases_updated_at
  BEFORE UPDATE ON security_deposit_cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP TRIGGER IF EXISTS trg_security_deposit_cases_updated_at ON security_deposit_cases;
--
-- DROP INDEX IF EXISTS idx_security_deposit_cases_status;
-- DROP INDEX IF EXISTS idx_security_deposit_cases_deadline;
--
-- DROP TABLE IF EXISTS security_deposit_cases;
--
-- ============================================================
