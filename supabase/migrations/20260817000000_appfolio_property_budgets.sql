-- ============================================================
-- Migration: 20260817000000_appfolio_property_budgets
-- Created:   2026-08-17
-- Author:    Neo (database specialist)
--
-- Part of the Maintenance Budget Cross-Check build, Part 2
-- (projects/hub/maintenance-history/budget-crosscheck-SPEC.md, "Neo's
-- Section — Schema"). One new table only. No changes to `claims`,
-- `maintenance_claims`, `claim_type_registry`, or any other existing
-- table.
--
-- What this is for: AppFolio is the real, official budget of record for
-- a property's yearly spending by category (e.g. "Repairs &
-- Maintenance"). This table stores that number, and what AppFolio's own
-- books say was actually spent, once a night, via
-- projects/appfolio-sync/sync.js's existing REPORT_CONFIG loop — the
-- same nightly batch job that already syncs properties/units/tenants/
-- leases/maintenance_requests. See "Why sync.js, not the security-
-- deposit connector" and "Cadence" in the spec for why this rides the
-- nightly job rather than getting its own schedule: budgets change
-- rarely, and re-confirming the same numbers most nights costs nothing
-- extra in a loop that already runs.
--
-- ============================================================
-- WHY THIS DOESN'T GO THROUGH `claims` / `maintenance_claims`
-- ============================================================
-- The `claims` table (PROPERTY-BRAIN-ARCHITECTURE.md) and
-- `maintenance_claims` (20260815010000_maintenance_history_schema.sql)
-- both exist for facts an AI had to extract and interpret from messy
-- source material, where a human might need to check the read —
-- that's why every claims-style row carries confidence,
-- extracted_by, and starts review_status = 'unreviewed'. A row in this
-- table is a structured field fetched directly from AppFolio's own
-- Budget report API, with no AI reading step in between — the same
-- category of fact as properties.address or maintenance_requests.cost,
-- both of which already sync straight into their own plain tables today
-- with no claims wrapper and no review gate. This table follows that
-- same plain-sync pattern. Confirmed against the spec's own reasoning
-- ("Why This Doesn't Go Through the claims Table") — agreed, not
-- second-guessed.
--
-- ============================================================
-- WHY NO FK-RESOLUTION STEP INTO A STORED property_id
-- ============================================================
-- sync.js's resolve_appfolio_foreign_keys() RPC exists because several
-- tables (units, leases, maintenance_requests) get WRITTEN using an
-- AppFolio ID and need a real foreign key resolved afterward for joins
-- elsewhere in the app. This table is only ever read one way — "show me
-- this property's budget" — a single join
-- (properties.appfolio_id = appfolio_property_budgets.appfolio_property_id)
-- at query time. Adding this table to the shared FK-resolution RPC would
-- touch code every other synced table depends on, for a saving that
-- doesn't exist yet. Revisit only if a second real consumer of this
-- table ever needs a stored FK.
--
-- ============================================================
-- OPEN ITEMS NOT YET RESOLVED BY THIS MIGRATION (see spec's "Open
-- Items" section — these are Q's / the live-discovery step's to close,
-- not blockers to shipping this schema)
-- ============================================================
--   - Exact report slug and field names are unconfirmed as of this
--     migration. Every existing REPORT_CONFIG entry in sync.js has its
--     field names "confirmed by --discover," never guessed — this
--     feature should get the same treatment before its REPORT_CONFIG
--     entry is written. If live discovery finds AppFolio's Budget report
--     returns monthly rows rather than one row per property+year+
--     category, the UNIQUE constraint below will reject the second
--     monthly row for the same key loudly (a constraint violation, not
--     silent data loss) — that failure is the signal to come back and
--     widen this table's grain, not a bug to work around in application
--     code.
--   - Whether AppFolio's report actually returns a real "actual spend"
--     column at this grain, or whether that requires a second report, is
--     also unconfirmed. actual_amount is nullable specifically so a
--     sync run that only has budgeted_amount from one report doesn't
--     need to fake a zero.
--   - fiscal_year is modeled as a single INTEGER (not
--     period_start/period_end). If live discovery shows AppFolio's
--     Budget report is period-based rather than calendar-year-based,
--     this is the column to revisit — flagged, not assumed correct.
--
-- ============================================================
-- DATA INVENTORY (GOVERNANCE.md Rule 4 pattern — not strictly required
-- here since this table stores no personal data, but followed anyway
-- for consistency with every other table in this schema, same as
-- b2_match_confidence_config's note in 20260813000003_b2_photo_folders.sql)
-- ============================================================
--   pii_fields:          NONE. This table holds property-level budget
--                         figures only — no tenant name, no contact
--                         info, no unit-level tenancy data, no
--                         protected-class-adjacent content of any kind.
--                         Confirmed against the actual column list below
--                         (appfolio_property_id, fiscal_year,
--                         gl_account_name, budgeted_amount,
--                         actual_amount) — none of these identify a
--                         person.
--   agents_with_access:  the nightly AppFolio sync process (system,
--                         service-role key); any Hub user with existing
--                         Maintenance History access (no narrower
--                         reviewer/admin gate needed — this isn't a
--                         claim requiring review).
--   privacy_category:    N/A — no personal data.
--   retention_policy:    indefinite, same as properties/units/
--                         maintenance_requests — nothing here needs
--                         redaction.
--   ccpa_exportable / ccpa_deletable: N/A — not tied to any individual
--                         contact.
--
-- Governance path: per CLAUDE.md's compliance-build boundary, this does
-- NOT require Asimov or Mason review — no message is ever sent to
-- anyone, no decision about a tenant or applicant is made or
-- influenced, and (per the inventory above) no personal data is stored.
-- Confirmed independently against the actual columns below, not just
-- taken on the spec's word.
--
-- RLS: enabled, no permissive policies — matches every other table in
-- this schema.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- TABLE: appfolio_property_budgets
-- What it stores: one row per property, per fiscal year, per AppFolio
-- GL spending category (e.g. "Repairs & Maintenance") — AppFolio's own
-- reported budgeted-vs-actual figures, synced nightly, read-only,
-- fetched fact (see "Why this doesn't go through claims" above).
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS appfolio_property_budgets (
  id                     UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Joins to properties.appfolio_id at query time (see "Why no
  -- FK-resolution step" above). TEXT, matching this schema's
  -- established appfolio_id convention (20260720000000_add_appfolio_id.sql)
  -- and units.appfolio_property_id (projects/appfolio-sync/sync.js).
  -- Deliberately NOT a FK — properties.appfolio_id has a unique index,
  -- not a primary key, and several other AppFolio-sourced columns in
  -- this schema (units.appfolio_property_id, maintenance_requests.
  -- appfolio_unit_id) already reference it as plain TEXT rather than a
  -- declared foreign key, for the same reason: sync order isn't
  -- guaranteed, and a hard FK would make the sync job fail if this
  -- report's rows ever arrive before a brand-new property's own
  -- property_directory row has landed.
  appfolio_property_id   TEXT          NOT NULL,

  -- Single calendar year, e.g. 2026. See "Open Items" above — revisit
  -- if live discovery shows AppFolio's Budget report is period-based.
  fiscal_year             INTEGER       NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2100),

  -- e.g. "Repairs & Maintenance". Sync EVERY category the report
  -- returns, not just R&M — same "sync broad, filter at display time"
  -- pattern sync.js already uses elsewhere (rent_roll, delinquency,
  -- etc.) — so a future feature wanting a different budget line doesn't
  -- need a second sync built for it. Free text, not a CHECK-constrained
  -- enum: AppFolio owns this vocabulary, not Rincon.
  gl_account_name          TEXT         NOT NULL,

  -- Both nullable — see "Open Items" above on whether AppFolio's report
  -- actually returns a real actual_amount at this grain. A sync run
  -- must omit a field it doesn't have, never send a fabricated 0.00 —
  -- same discipline as every other REPORT_CONFIG entry in sync.js
  -- (see that file's "SYNC CONFLICT RULE" header comment).
  budgeted_amount            NUMERIC(12,2),
  actual_amount               NUMERIC(12,2),

  -- When this row was last confirmed by the nightly sync — lets the
  -- Budget tab show "as of [date]," same purpose as maintenance_requests
  -- .latchel_claims_synced_at / leases.deposit_synced_at elsewhere in
  -- this schema.
  synced_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  created_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Upsert key for the nightly sync job (matches Supabase's
  -- on_conflict= pattern already used by every other supabaseUpsert*
  -- call in sync.js). Also doubles as the primary read index — a lookup
  -- by appfolio_property_id (with or without fiscal_year/gl_account_name
  -- narrowing) uses this index as a leftmost-prefix scan, so no
  -- additional index is needed for a table this small. If live
  -- discovery finds AppFolio's report actually returns more than one row
  -- per property+year+category (e.g. monthly detail), this constraint
  -- will reject the second row loudly instead of silently overwriting —
  -- see "Open Items" above.
  UNIQUE (appfolio_property_id, fiscal_year, gl_account_name)
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE appfolio_property_budgets ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_appfolio_property_budgets_updated_at ON appfolio_property_budgets;
CREATE TRIGGER trg_appfolio_property_budgets_updated_at
  BEFORE UPDATE ON appfolio_property_budgets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP TRIGGER IF EXISTS trg_appfolio_property_budgets_updated_at ON appfolio_property_budgets;
-- DROP TABLE IF EXISTS appfolio_property_budgets;
--
-- ============================================================
