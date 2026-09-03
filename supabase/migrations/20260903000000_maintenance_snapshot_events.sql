-- ============================================================
-- Migration: 20260903000000_maintenance_snapshot_events
-- Created:   2026-09-03
-- Author:    Neo (database specialist)
--
-- Part of the Property 360 build (projects/hub/property-360-SPEC.md).
-- Peter asked for a real, multi-year maintenance history "snapshot" per
-- property on that page — a short list of one-line historical facts
-- ("Kitchen faucet repair — 2022-03-14, $180, ABC Plumbing"), not full
-- ticket detail, going back up to 5 years. This is NOT the same feature
-- as the existing Maintenance summary card (open ticket count,
-- trailing-12mo spend) or the flagged Privacy Review queue — it is a
-- new, separate glance: a plain historical list. One new table only.
--
-- ============================================================
-- WHY THIS TABLE EXISTS, AND WHY NOT maintenance_claims
-- ============================================================
-- Live research tonight (2026-09-02/03) confirmed the real source is
-- AppFolio's own `bill_detail` Reports API report
-- (occurred_on_from/occurred_on_to params) — genuinely returns real
-- historical vendor-bill data going back 10+ years. Rows with a
-- populated work_order_id are the maintenance-relevant subset, and
-- carry work_order_issue, payee_name, paid, property_id, and a date.
--
-- Latchel's own job history was considered and rejected for this
-- specific use: a live check tonight found 50%+ of older Latchel
-- records belong to properties Rincon no longer manages — a real,
-- measured problem AppFolio's billing data doesn't share (AppFolio is
-- the system of record for who Rincon currently manages).
--
-- This is deliberately a new, separate table from maintenance_claims,
-- not a new claim_type on it:
--   - maintenance_claims is fact-extraction FROM a maintenance_requests
--     ticket (maintenance_request_id NOT NULL, CASCADE) — it has no
--     meaning without a Rincon ticket row to hang off of. This new data
--     is sourced from AppFolio's bill history directly and is not
--     required to already have a matching maintenance_requests row
--     (the whole point of going back up to 5 years is real coverage
--     older than what maintenance_requests/Latchel can join to today —
--     confirmed elsewhere in this schema that ~204 older AppFolio-only
--     tickets already can't be linked to a unit, the same gap this
--     table is explicitly reaching past).
--   - The four maintenance_claims claim_types (event / decision /
--     outcome / recurrence) model ticket-narrative structure (Latchel
--     state history, job files). A vendor-bill line is a flatter kind
--     of fact — one summary, one amount, one vendor, one date — that
--     doesn't naturally fit any of those four types.
-- Both tables can end up describing the same real-world repair from two
-- different angles (a ticket's own narrative vs. its paid bill) — that
-- overlap is accepted, not deduped here; this table is scoped
-- narrowly to "the bill-history snapshot," not a merge of every
-- maintenance data source into one shape.
--
-- ============================================================
-- WHY A REAL property_id FK, NOT AN appfolio_property_id TEXT JOIN
-- ============================================================
-- appfolio_property_budgets/appfolio_property_actuals deliberately use
-- appfolio_property_id (join at query time), because their nightly sync
-- can write a row before that property's own Rincon row has finished
-- FK-resolution. That reasoning does not apply here: per the task
-- brief, this table is explicitly filtered to only Rincon's
-- currently-active properties before a row is ever written — the
-- backfill/ingest script already resolves a real properties.id (almost
-- certainly via the existing properties.appfolio_id column,
-- 20260720000000_add_appfolio_id.sql) before it inserts. Same reasoning
-- leadsimple_property_stages (20260902000000) already used for the
-- same choice: there is no unresolved external ID to join on later, so
-- a real UUID FK, resolved at write time, is correct.
--
-- ON DELETE RESTRICT, not CASCADE. This table is a historical record
-- (real dollars, real repairs, real vendors, over up to 5 real years)
-- the same way maintenance_claims and property_brain's own `claims`
-- table are — not a nightly-rewritten cache of current state the way
-- leadsimple_property_stages is. properties rows are never expected to
-- be hard-deleted in this schema (system/AppFolio-owned, same as every
-- other synced table) — RESTRICT forces that conflict to be resolved
-- explicitly instead of silently losing real financial/maintenance
-- history via a cascading delete. Same reasoning already used for
-- claims.property_id (20260816000000) and property_insurance.property_id
-- (20260720000004).
--
-- ============================================================
-- SOURCE-AWARE BY A COLUMN, NOT BY THE TABLE NAME
-- ============================================================
-- Per the task brief: this is sourced from AppFolio bills, not Latchel,
-- but the schema should stay source-aware in case a second source is
-- ever added later, without over-engineering for a source that doesn't
-- exist yet. Concretely: the table is NOT named appfolio_-anything (so
-- a future second source doesn't need a parallel table), and `source`
-- is a narrow, fail-closed CHECK — exactly the same "narrow now, widen
-- later via a real, visible migration" pattern already used for
-- leadsimple_property_stages.process_type and claims.source_type in
-- this schema. `source_reference` carries the structural pointer to
-- exactly which record this came from (same discipline as
-- claims.source_reference / maintenance_claims.source_reference:
-- "exactly which record, never a summary with the source stripped
-- off") — for today's only source, the AppFolio bill_detail row's own
-- identifier (and the work_order_id it carried, if useful for
-- cross-referencing maintenance_requests/maintenance_claims later).
--
-- ============================================================
-- WHY REVIEW_STATUS / CONTENT-CHECK COLUMNS, MATCHING
-- maintenance_claims EXACTLY — READ BEFORE Q BUILDS THE BACKFILL
-- ============================================================
-- `summary` is real free text, ultimately built from AppFolio's own
-- work_order_issue field (a human-written description — a tenant's or
-- staff member's own words) combined with payee_name, whether Q's
-- backfill script paraphrases it with AI or builds it deterministically
-- (spec brief: "TBD by Q"). Either path can carry protected-class-
-- adjacent content, because the risk lives in work_order_issue's
-- original human-written text, not in how the one-line summary is
-- assembled from it — the same category of risk maintenance_claims
-- already hit (SPEC.md's own real example: "Tenant is complaining of
-- health concerns").
--
-- This table therefore reuses maintenance_claims' exact review pattern,
-- not a new one:
--   - flagged_protected_class / flagged_category — the two-layer
--     content check's recorded outcome (Layer 1: keyword/phrase scan,
--     lib/protected-class-terms.js; Layer 2: the generation step's own
--     judgment, if an AI path is used). MUST run on the final `summary`
--     text before insert, no exceptions — same as every maintenance_claims
--     row today (GOVERNANCE.md Rule 9). This applies on the deterministic
--     path too: work_order_issue's original text is what's actually at
--     risk, not the assembly method.
--   - review_status starts at 'unreviewed' for every row, unconditionally
--     — no 'auto_indexed'/'auto_confirmed' value, same "REVIEW GATE"
--     discipline as maintenance_claims (20260815010000).
--   - Flagged rows are never deleted, but maintenance_snapshot_events_
--     decision_safe (below) structurally excludes them from any read
--     path — including the Property 360 card itself, which should read
--     ONLY the view, never this base table directly. A confirmed/
--     corrected review never re-admits a flagged row to the view — same
--     permanent-exclusion behavior maintenance_claims_decision_safe
--     already has, and the same one property-360-SPEC.md explicitly
--     calls out for maintenance_claims_decision_safe: "reviewing
--     something never 'lets it back in.'"
--   - CHECK enforcing flagged_category whenever flagged_protected_class
--     = TRUE — same enforcement as maintenance_claims (Rule 9: record
--     the reason, not just the fact of exclusion).
--
-- ACCESS/GATING NOTE FOR Q: this table adds no new team_member_tool_roles
-- value. Per property-360-SPEC.md's Access Control section, the
-- Maintenance section (including this snapshot) is gated by the
-- existing requireMaintenanceHistoryAccess (any real maintenance_history
-- role) for general reads of the decision_safe view; the flagged-review
-- queue (raw table, WHERE flagged_protected_class = TRUE) should stay
-- restricted to the existing PRIVACY_REVIEW_ROLES = ['admin', 'reviewer',
-- 'director_of_operations'] constant already used in
-- maintenance-history/router.js — same roles, same file, not a new gate.
--
-- `extracted_by` mirrors maintenance_claims.extracted_by: 'system' for
-- the deterministic-template path, or a model version string (e.g.
-- 'claude-...-20260903') for an AI-paraphrase path — whichever Q picks.
-- No `confidence` column: unlike maintenance_claims' AI-extracted
-- narrative facts, this data starts from a structured AppFolio field
-- (paid amount, payee, date) that isn't itself uncertain — only the
-- one-line phrasing is generated, so there's no real uncertainty score
-- to record. Not adding it now avoids inventing unneeded machinery,
-- same "WHY THIS STAYS SMALL" discipline used elsewhere in this schema.
--
-- ============================================================
-- BACKFILL IDEMPOTENCY — FLAGGED FOR Q
-- ============================================================
-- UNIQUE (source, source_reference) below is both a real integrity
-- constraint and the backfill script's natural upsert/dedupe key, same
-- role UNIQUE already plays on appfolio_property_actuals and
-- leadsimple_property_stages. This means source_reference MUST be a
-- genuinely stable, unique-per-row identifier for the underlying
-- AppFolio bill_detail line (its own row/bill ID, not just a
-- work_order_id — one work order can have more than one bill line) —
-- confirm the exact stable field live against the Reports API response
-- before writing the insert code, same live-check discipline every
-- other source in this codebase was held to. Without a real unique
-- source_reference, re-running the backfill (or a later incremental
-- top-up covering an overlapping date range) will either silently
-- duplicate rows or silently fail every insert on the constraint —
-- worth getting right before this ships, not after.
--
-- ============================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT BUILD
-- ============================================================
--   - No nightly/incremental sync job, no backfill script. Schema only,
--     per this task's scope — Q builds the ingestion code against this
--     table next.
--   - No AI paraphrase vs. deterministic-template decision. Both are
--     supported by this schema unchanged (`extracted_by` records
--     whichever path ran); that choice is explicitly left to Q.
--   - No join/cross-reference column to maintenance_requests or
--     maintenance_claims. Real overlap between this table and those two
--     is expected (see "WHY THIS TABLE EXISTS" above) but is not
--     resolved or deduped at the schema level — a v2 concern if it
--     turns out to matter in practice, not assumed now.
--   - No new team_member_tool_roles value — see "ACCESS/GATING NOTE"
--     above.
--
-- ============================================================
-- DATA INVENTORY (GOVERNANCE.md Rule 4 — required for every new table
-- storing personal data)
-- ============================================================
--   pii_fields:          `summary` — highest PII density; ultimately
--                         derived from AppFolio's work_order_issue, a
--                         human-written description that can, same as
--                         maintenance_claims.claim_text, incidentally
--                         contain a tenant's name or health/disability-
--                         adjacent detail (e.g. "repaired grab bar for
--                         tenant's mobility needs"). `reviewer_notes` —
--                         PII-adjacent, same caveat used everywhere else
--                         in this schema. `flagged_category` — could
--                         indirectly reveal what kind of sensitive topic
--                         was discussed, without containing the topic
--                         text itself. `vendor_name` — business contact
--                         info (a company or contractor name), not
--                         tenant/owner data and no Fair Housing angle —
--                         same lower-sensitivity category property-360-
--                         SPEC.md already used for Latchel vendor names.
--                         `amount` and `event_date` are financial/
--                         scheduling facts, not personal content on
--                         their own.
--   agents_with_access:  The backfill/ingest process (system,
--                         service-role key, existing AppFolio Reports
--                         API credential already used by
--                         projects/appfolio-sync/sync.js) writes it;
--                         Claude (existing ANTHROPIC_API_KEY), only if Q
--                         chooses the AI-paraphrase path, for generating
--                         `summary` and for Layer 2 of the content
--                         check. Hub users holding ANY real
--                         maintenance_history role (via
--                         requireMaintenanceHistoryAccess) read
--                         maintenance_snapshot_events_decision_safe for
--                         the Property 360 snapshot card. Hub users
--                         holding 'admin', 'reviewer', or
--                         'director_of_operations' for
--                         tool='maintenance_history' (the existing
--                         PRIVACY_REVIEW_ROLES constant,
--                         maintenance-history/router.js) read the raw
--                         table's flagged rows for review.
--   privacy_category:    Maintenance-history record, same category
--                         maintenance_claims already carries — may
--                         include health-adjacent free text, flagged as
--                         more sensitive than most existing tables in
--                         this schema for the same reason.
--   retention_policy:    PLACEHOLDER — pending Mason, matching
--                         maintenance_claims' own still-unresolved
--                         placeholder (20260815010000) rather than
--                         inventing a figure for this table alone. (The
--                         7-year figure Mason set for Security Deposit,
--                         20260829000000, was a decision scoped to that
--                         tool's specific data — not assumed to transfer
--                         here without its own review.)
--   ccpa_exportable:     TRUE.
--   ccpa_deletable:      TRUE, via targeted redaction of `summary` and
--                         `reviewer_notes` to the literal string
--                         "[REDACTED]" — identical convention to
--                         maintenance_claims.claim_text/reviewer_notes.
--                         event_date, amount, vendor_name, source, and
--                         source_reference are preserved for audit
--                         continuity (the fact "a bill for this amount,
--                         from this vendor, on this date" stays; the
--                         free-text sentence that might name a tenant
--                         does not). Same accepted limitation as
--                         maintenance_claims: this table has no
--                         tenant_id column, so finding every row that
--                         mentions a specific person for a CCPA request
--                         is a manual v1 step (via the tenant's
--                         unit/lease, then this table's property_id),
--                         not automatic.
--
-- RLS: enabled, no permissive policies — matches every table in this
-- schema. Access is enforced in application code via
-- requireMaintenanceHistoryAccess / PRIVACY_REVIEW_ROLES, exactly like
-- maintenance_claims today.
--
-- Gate check (must pass before applying to any real database):
--   [x] Rollback exists — see bottom of this file
--   [x] No existing data is deleted or overwritten — new table, no
--       existing row anywhere is touched
--   [x] Touches only this new table — no ALTER on properties,
--       maintenance_requests, maintenance_claims, or
--       team_member_tool_roles; no CHECK constraint widened
--   [x] Additive only — CREATE TABLE IF NOT EXISTS, safe to re-run
--   [ ] Tested on a copy of Supabase before production apply — no
--       staging copy exists in this project, same standing caveat as
--       every migration here to date
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- TABLE: maintenance_snapshot_events
-- What it stores: one row per historical maintenance-relevant bill/
-- event for a property — a short, one-line historical fact ("Kitchen
-- faucet repair — 2022-03-14, $180, ABC Plumbing"), not full ticket
-- detail. v1 source: AppFolio's bill_detail Reports API report, filtered
-- to rows with a populated work_order_id, for Rincon's currently-active
-- properties only, going back up to 5 years.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS maintenance_snapshot_events (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Real FK, resolved by the backfill/ingest script before this row is
  -- ever written — see "WHY A REAL property_id FK" above. RESTRICT:
  -- this is historical record-keeping, not a rewritable cache.
  property_id         UUID          NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,

  -- The bill/repair's own date (AppFolio's occurred_on), not when this
  -- row was backfilled — created_at below already covers that.
  event_date          DATE          NOT NULL,

  -- The one-line historical fact itself. AI-paraphrased or built
  -- deterministically from work_order_issue + payee_name (Q's call,
  -- see notes above) — either way, MUST pass the two-layer content
  -- check (flagged_protected_class/flagged_category below) before
  -- insert. Length-capped as a structural guardrail against a full
  -- ticket narrative or an unredacted work_order_issue landing here
  -- whole — this is meant to stay a short line, not a paragraph.
  summary              TEXT         NOT NULL CHECK (char_length(summary) <= 300),

  -- AppFolio's own `paid` figure for this bill line. Not constrained to
  -- >= 0 — a credit memo/vendor refund can legitimately be negative,
  -- same reasoning already used for appfolio_property_actuals.net_amount.
  -- NOT NULL on the working assumption every maintenance-relevant
  -- bill_detail row carries a real paid amount — confirm live before
  -- Q's backfill assumes this holds for 100% of rows; flag back to Neo
  -- if a real row is ever found with no amount.
  amount               NUMERIC(12,2) NOT NULL,

  -- AppFolio's payee_name — a vendor/company name, not tenant/owner
  -- data. Free text, not a CHECK-constrained enum: AppFolio (and,
  -- eventually, a second source) owns this vocabulary, not Rincon.
  vendor_name          TEXT         NOT NULL,

  -- Source-aware by design (see "SOURCE-AWARE BY A COLUMN" above).
  -- Exactly one value today; widening this list for a real second
  -- source later is a real, visible migration (same DROP-then-ADD
  -- pattern used everywhere else in this schema for a CHECK widening),
  -- not a silent addition.
  source               TEXT         NOT NULL CHECK (source IN (
                          'appfolio_bill'
                        )),

  -- Structural pointer to exactly which record this came from (e.g.
  -- "AppFolio bill_detail row 4471982, work_order 78910") — never a
  -- summary with the source stripped off, same discipline as
  -- claims.source_reference / maintenance_claims.source_reference. Also
  -- the backfill's real dedupe key — see "BACKFILL IDEMPOTENCY" above
  -- and the UNIQUE constraint below.
  source_reference     TEXT         NOT NULL,

  -- 'system' for the deterministic-template path, or a model version
  -- string for an AI-paraphrase path — same role as
  -- maintenance_claims.extracted_by.
  extracted_by         TEXT         NOT NULL,

  -- The Content Check outcome (GOVERNANCE.md Rule 9) — same columns,
  -- same enforcement as maintenance_claims. flagged_category required
  -- whenever flagged_protected_class is TRUE, enforced below.
  flagged_protected_class BOOLEAN   NOT NULL DEFAULT FALSE,
  flagged_category      TEXT,        -- free text, not a rigid enum — Mason should be
                                      -- able to refine categories without a migration

  -- Deliberately NO 'auto_indexed'/'auto_confirmed' option — nothing
  -- here ever promotes a row past a human based on confidence, same
  -- "REVIEW GATE" discipline as maintenance_claims.
  review_status          TEXT       NOT NULL DEFAULT 'unreviewed'
                            CHECK (review_status IN ('unreviewed', 'confirmed', 'corrected', 'rejected')),
  reviewed_by             TEXT,
  reviewed_at             TIMESTAMPTZ,
  reviewer_notes           TEXT,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Enforcement: GOVERNANCE.md Rule 9 requires the exclusion reason to
  -- be recorded, not just the fact that something was excluded — same
  -- constraint maintenance_claims already has.
  CONSTRAINT maintenance_snapshot_events_flag_requires_category
    CHECK (flagged_protected_class = FALSE OR flagged_category IS NOT NULL),

  -- Backfill idempotency key — see "BACKFILL IDEMPOTENCY" above. Also
  -- (leftmost-prefix) a usable index for "every row from this source."
  UNIQUE (source, source_reference)
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE maintenance_snapshot_events ENABLE ROW LEVEL SECURITY;

-- Primary application query: "this property's maintenance snapshot,
-- most recent first" — the exact query the Property 360 card needs.
CREATE INDEX IF NOT EXISTS idx_maintenance_snapshot_events_property
  ON maintenance_snapshot_events(property_id, event_date DESC);

-- "Needs privacy review" queue — visible only to PRIVACY_REVIEW_ROLES,
-- same shape as maintenance_claims' own flagged index.
CREATE INDEX IF NOT EXISTS idx_maintenance_snapshot_events_flagged
  ON maintenance_snapshot_events(flagged_protected_class)
  WHERE flagged_protected_class = TRUE;

-- Unreviewed-rows queue — "every row still needing a human look," same
-- query shape as maintenance_claims' own unreviewed index.
CREATE INDEX IF NOT EXISTS idx_maintenance_snapshot_events_unreviewed
  ON maintenance_snapshot_events(review_status)
  WHERE review_status = 'unreviewed';

DROP TRIGGER IF EXISTS trg_maintenance_snapshot_events_updated_at ON maintenance_snapshot_events;
CREATE TRIGGER trg_maintenance_snapshot_events_updated_at
  BEFORE UPDATE ON maintenance_snapshot_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN maintenance_snapshot_events.source_reference IS
  'STRUCTURAL POINTER ONLY, and the backfill''s real dedupe key (see UNIQUE(source, source_reference)). For today''s only source (appfolio_bill): the bill_detail report row''s own stable identifier, not just a work_order_id (one work order can have more than one bill line) — confirm the exact field live against the Reports API before writing insert code. Never a summary with the source stripped off.';

COMMENT ON COLUMN maintenance_snapshot_events.summary IS
  'The one-line historical fact shown on Property 360''s maintenance snapshot. AI-paraphrased or built deterministically from AppFolio''s work_order_issue + payee_name (Q''s call) — either way MUST pass the two-layer content check (lib/protected-class-terms.js + lib/content-check.js, same as maintenance_claims) before insert, because the underlying work_order_issue text is human-written and can carry protected-class-adjacent content regardless of how the summary is assembled.';


-- ============================================================
-- VIEW: maintenance_snapshot_events_decision_safe
-- Same exclusion pattern as maintenance_claims_decision_safe /
-- claims_decision_safe (flagged/rejected content never appears). The
-- Property 360 snapshot card, and any other future feature that reads
-- this table, should read ONLY this view — never the base table
-- directly — making "don't show flagged or rejected content" the easy
-- default instead of something every future query has to remember.
--
-- Note on RLS and views (carried over verbatim from
-- maintenance_claims_decision_safe / claims_decision_safe): Postgres
-- views run with the privileges of the view's owner by default, not the
-- querying role — RLS enabled on the base table does not automatically
-- extend to a view over it. Non-issue in practice here: every
-- writer/reader in this codebase connects with the Supabase
-- service-role key, which bypasses RLS entirely regardless. Flagged so
-- it's a known fact, not a surprise, if the Hub UI is ever changed to
-- query Supabase directly under a user's own session instead of through
-- the backend.
-- ============================================================

CREATE OR REPLACE VIEW maintenance_snapshot_events_decision_safe AS
SELECT *
FROM maintenance_snapshot_events
WHERE flagged_protected_class = FALSE
  AND review_status != 'rejected';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP VIEW IF EXISTS maintenance_snapshot_events_decision_safe;
--
-- DROP TRIGGER IF EXISTS trg_maintenance_snapshot_events_updated_at ON maintenance_snapshot_events;
--
-- DROP INDEX IF EXISTS idx_maintenance_snapshot_events_unreviewed;
-- DROP INDEX IF EXISTS idx_maintenance_snapshot_events_flagged;
-- DROP INDEX IF EXISTS idx_maintenance_snapshot_events_property;
--
-- DROP TABLE IF EXISTS maintenance_snapshot_events;
--
-- -- Safe to roll back in full as long as no backfill has been run yet
-- -- (true as of this migration — schema only, no ingest code exists).
-- -- If a backfill has since inserted real rows, rolling back drops
-- -- them permanently — confirm nothing depends on this data first.
--
-- ============================================================
