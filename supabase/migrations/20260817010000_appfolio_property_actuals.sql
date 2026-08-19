-- ============================================================
-- Migration: 20260817010000_appfolio_property_actuals
-- Created:   2026-08-17
-- Author:    Neo (database specialist)
--
-- Part of the Maintenance Budget — Actual Spend build, Part 3
-- (projects/hub/maintenance-history/actual-spend-SPEC.md, "Neo's
-- Section — Schema Summary" and Decision 2). One new table only. No
-- changes to `appfolio_property_budgets`, `claims`,
-- `maintenance_claims`, or any other existing table.
--
-- What this is for: fills in the Budget tab's "Actual (AppFolio)"
-- column, which has shown "not available from AppFolio" since launch.
-- AppFolio has no pre-totaled "actual spend per property/category"
-- report, but its `general_ledger` report exposes every raw accounting
-- transaction. This table stores the *aggregate* — one row per
-- property + GL account + month — computed by summing those raw
-- transactions at sync time in `sync.js`. The raw transaction rows
-- themselves are never written here or anywhere in Supabase (see "WHY
-- NOT RAW TRANSACTION LINES" below — this is the load-bearing decision
-- in this migration).
--
-- ============================================================
-- WHY THIS DOESN'T GO THROUGH `claims` / `maintenance_claims`
-- ============================================================
-- Same reasoning as Part 2's `appfolio_property_budgets`
-- (20260817000000_appfolio_property_budgets.sql), unchanged: a row here
-- is a structured fact fetched directly from AppFolio's own general
-- ledger report and arithmetically summed (sum(debit) - sum(credit)),
-- not an AI interpretation of messy source material. No human review
-- gate is needed, so no `confidence`/`extracted_by`/`review_status`
-- columns — same plain-sync pattern `appfolio_property_budgets` and
-- `properties`/`maintenance_requests` already use.
--
-- ============================================================
-- WHY NO FK-RESOLUTION STEP INTO A STORED property_id
-- ============================================================
-- Same reasoning as `appfolio_property_budgets`: this table is only
-- ever read one way — "show me this property's actual spend" — a
-- single join (properties.appfolio_id = appfolio_property_actuals.
-- appfolio_property_id) at query time. appfolio_property_id is
-- deliberately plain TEXT, not a declared foreign key, matching
-- appfolio_property_budgets.appfolio_property_id and every other
-- AppFolio-sourced column in this schema — sync order isn't
-- guaranteed, and a hard FK would make a nightly sync run fail if this
-- report's rows ever landed before a brand-new property's own
-- property_directory row existed.
--
-- ============================================================
-- WHY A NEW TABLE, NOT `appfolio_property_budgets.actual_amount`
-- ============================================================
-- appfolio_property_budgets.actual_amount already exists (nullable,
-- unused) but stays that way. AppFolio's general_ledger report only
-- ever returns the CURRENT month's transactions — it ignores every
-- date-range parameter tried (spec's Finding C, confirmed live against
-- four different parameter shapes, all returning the identical 4,423
-- rows spanning only 2026-08-01 through 2026-08-17). That means there
-- is no single "this year's actual spend" number to fetch and write
-- once — it has to be built up month by month as each month closes,
-- and once a month rolls off AppFolio's window there is no way to ask
-- AppFolio for it again. That is a fundamentally different write
-- pattern (accumulate one locked-in row per month, forever) than
-- appfolio_property_budgets's shape (one row per year, overwritten in
-- place most nights). Forcing this into a single nullable column on
-- the yearly-grain budget table would either lose the monthly detail
-- needed to compute a correct running total, or require bolting a
-- second write pattern onto a table that doesn't otherwise need one.
-- "Actual spend this year" is a query-time SUM() over this table's
-- rows (see "QUERY PATTERN" below) — never written back into
-- appfolio_property_budgets.actual_amount, so there is exactly one
-- source for that number, not two that could drift apart.
--
-- ============================================================
-- WHY NOT RAW TRANSACTION LINES (this is the PII-relevant decision)
-- ============================================================
-- The spec considered storing raw general_ledger transaction rows
-- (full audit trail, drill-down to any line item) and rejected it, for
-- three reasons carried forward here:
--   1. AppFolio's own report can't deliver a complete raw history
--      anyway (Finding C, above) — raw storage could never hold more
--      than "this month forward from whenever the sync started."
--      AppFolio itself remains the system of record for line-item
--      detail; Peter or his bookkeeper can already open AppFolio
--      directly for that.
--   2. Real PII risk, confirmed live (spec's Finding D): raw
--      general_ledger rows carry a tenant's real name in `party_name`
--      on transactions tagged to ordinary EXPENSE GL accounts, not
--      just on obviously tenant-facing accounts like Rent Income —
--      e.g. a tenant's utility-reimbursement line landing in the same
--      "6410 - Electricity" account as the expense it offsets. Storing
--      raw lines would put a tenant's name into this schema for the
--      first time on this feature. Aggregating at sync time — keeping
--      only property + category + month + two dollar totals, and
--      discarding `party_name`, `party_id`, `description`, `txn_id`,
--      and every other raw-row field before anything is written —
--      avoids that entirely.
--   3. Volume/shape mismatch: 4,423 raw rows in seventeen days for one
--      portfolio. A full year of raw lines would be tens of thousands
--      of rows, growing forever, for a drill-down benefit AppFolio's
--      own interface already covers.
-- This conclusion is CONDITIONAL on Q's sync code actually aggregating
-- at sync time as designed, before anything is sent to Supabase — see
-- the data inventory note below and the spec's Decision 5. If a future
-- change ever stores raw transaction lines for a drill-down feature,
-- that reintroduces tenant PII into this area and must go back through
-- a proper Rule 4 review, not inherit this migration's conclusion.
--
-- ============================================================
-- WHAT `reimbursable_amount` IS AND ISN'T (spec's Decision 3)
-- ============================================================
-- Peter's decision: tenant reimbursements/billbacks stay counted in
-- "actual spend" (net_amount) exactly as they always would — nothing
-- about that headline number changes. reimbursable_amount is an
-- additive breakout, not a subtraction: the portion of that same
-- total that a tenant's payment offset, so staff can see both "$18,400
-- spent" and "$1,240 of that was reimbursed by tenants" instead of one
-- blended number. It is computed at sync time as sum(credit) over rows
-- where AppFolio's own `party_type` field equals 'Occupancy' (a
-- tenant, per the spec's Finding E — a clean structured field, not
-- name-matching against `party_name`). The spec's Finding E also
-- surfaced a nuance this column deliberately excludes: some
-- `party_type = 'Occupancy'` rows are on the DEBIT side (money paid TO
-- a tenant — e.g. hotel/relocation costs during a repair) — that is
-- ordinary spend, the opposite of a reimbursement, and stays inside
-- net_amount only. reimbursable_amount only ever sums CREDIT-side
-- tenant-sourced dollars, which is why it is modeled as >= 0 below.
-- `party_type` itself is read only in memory during this sum and is
-- never written to this table or anywhere in Supabase — same for
-- `party_id` and `party_name`, which the aggregation logic never even
-- needs to read.
--
-- ============================================================
-- QUERY PATTERN (informs the index choice below)
-- ============================================================
-- "Actual spend this year" for a property + category =
--   SUM(net_amount) WHERE appfolio_property_id = ? AND gl_account_id = ?
--   AND fiscal_year = ?
-- "Reimbursed this year" for the same slice = SUM(reimbursable_amount)
-- over the identical row set. Both computed live in the
-- /budget route (router.js), the same way the ticket-cost rollup is
-- already computed live today — not written back anywhere.
--
-- ============================================================
-- OPEN ITEMS NOT RESOLVED BY THIS MIGRATION (see spec's "Open Items"
-- section — these are real limitations of AppFolio's API, not bugs in
-- this schema, and are not blockers to shipping this table)
-- ============================================================
--   - Whether AppFolio's general-ledger "current month" window resets
--     exactly on the calendar month boundary was only confirmed from a
--     single snapshot (Aug 1-17). If it turns out to behave
--     differently, a month's total could be captured early/late by the
--     nightly sync. The UNIQUE constraint below means a late/wrong
--     capture would still upsert cleanly into the right (property,
--     period, gl_account_id) row — it does not protect against
--     capturing the wrong window, only against duplicate rows for the
--     same window.
--   - Whether pagination kicks in on a full month's transactions (today
--     's sample was a partial 17-day month) is unconfirmed. If it does
--     and Q's sync doesn't follow it, a month's net_amount could be
--     understated silently. Worth Q/TARS checking once real data spans
--     a full month.
--   - Backfill is not possible: whatever date this ships, actual-spend
--     data accumulates from that date forward only. There is no way to
--     pull earlier-2026 transactions through this report after the
--     fact. This is a real limit of AppFolio's API, not something this
--     schema could work around — it's the reason the Budget tab needs
--     a UI note (Q's section) rather than a schema fix.
--
-- ============================================================
-- DATA INVENTORY (GOVERNANCE.md Rule 4 pattern)
-- ============================================================
--   pii_fields:          NONE, by construction. Confirmed against the
--                         actual column list below
--                         (appfolio_property_id, period, fiscal_year,
--                         gl_account_id, gl_account_name, net_amount,
--                         reimbursable_amount) — none of these identify
--                         a person. This holds ONLY if Q's sync code
--                         does the aggregation before writing (see "WHY
--                         NOT RAW TRANSACTION LINES" above) — must be
--                         re-verified against the actual buildRow()/
--                         REPORT_CONFIG code once built, not just
--                         assumed from this migration's intent, per the
--                         spec's own instruction to Neo.
--   agents_with_access:  the nightly AppFolio sync process (system,
--                         service-role key); any Hub user with existing
--                         Maintenance History access — same as
--                         appfolio_property_budgets.
--   privacy_category:    N/A — no personal data.
--   retention_policy:    indefinite, same as every other synced table —
--                         nothing here needs redaction once the
--                         no-PII premise above is confirmed against the
--                         real sync code.
--   ccpa_exportable / ccpa_deletable: N/A — not tied to any individual
--                         contact.
--
-- Governance path: per CLAUDE.md's compliance-build boundary and the
-- spec's own Decision 5, this does NOT require Asimov or Mason — no
-- message is ever sent to anyone, no decision about a tenant or
-- applicant is made or influenced, and (per the inventory above and
-- conditional on Q's sync aggregating as designed) no personal data is
-- stored. GOVERNANCE.md Rule 6 Standard tier at most — Peter's
-- approval of the spec satisfies it.
--
-- RLS: enabled, no permissive policies — matches every other table in
-- this schema.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- TABLE: appfolio_property_actuals
-- What it stores: one row per property, per AppFolio GL spending
-- category, per calendar month ('YYYY-MM') — the actual dollars
-- AppFolio's own general ledger shows were spent, aggregated from raw
-- transactions at sync time (net_amount), plus the portion of that
-- spend a tenant reimbursement offset (reimbursable_amount). Synced
-- nightly, read-only, fetched-and-summed fact (see "Why this doesn't
-- go through claims" above).
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS appfolio_property_actuals (
  id                     UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Joins to properties.appfolio_id at query time, same convention as
  -- appfolio_property_budgets.appfolio_property_id (see "Why no
  -- FK-resolution step" above). Deliberately NOT a declared foreign
  -- key, for the same sync-ordering reason as every other
  -- AppFolio-sourced column in this schema.
  appfolio_property_id   TEXT          NOT NULL,

  -- 'YYYY-MM', AppFolio's own month-id shape (matches
  -- annual_budget_forecast's months[].id already used in sync.js).
  -- This table's natural grain, since AppFolio's general_ledger report
  -- only ever exposes "the current month" (see "Why a new table"
  -- above) — each month gets locked in as its own row once AppFolio's
  -- window moves past it. Light format guard only; AppFolio owns the
  -- actual value.
  period                 TEXT          NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),

  -- Derived from period at write time (same parseInt(...slice(0,4))
  -- pattern the existing annual_budget_forecast entry already uses in
  -- sync.js) and stored, not computed at query time, so "sum this
  -- property's year" (see "Query pattern" above) is a plain filter
  -- rather than a string-slice on every row.
  fiscal_year             INTEGER      NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2100),

  -- AppFolio's own internal numeric GL account ID — the real join key
  -- to appfolio_property_budgets (spec's Finding A: general_ledger's
  -- account_name arrives as "6210 - Repair", annual_budget_forecast's
  -- arrives as bare "Repair" — text would silently fail to match, but
  -- both reports carry the same stable account_id, confirmed live:
  -- 40 of 42 general-ledger account IDs matched exactly against the
  -- budget report's 54). NOT the join key by itself for display —
  -- gl_account_name below carries the human-readable text.
  gl_account_id           INTEGER      NOT NULL,

  -- "NNNN - " prefix stripped from AppFolio's raw account_name at
  -- write time, so this matches appfolio_property_budgets
  -- .gl_account_name character-for-character (e.g. "Repair", not
  -- "6210 - Repair"). Display convenience only — gl_account_id above
  -- is the real join key. Free text, not a CHECK-constrained enum:
  -- AppFolio owns this vocabulary, not Rincon (same reasoning as
  -- appfolio_property_budgets.gl_account_name).
  gl_account_name          TEXT        NOT NULL,

  -- sum(debit) - sum(credit) across ALL general_ledger transactions
  -- for this property + gl_account_id + period, no filtering by
  -- counterparty. This is the "Actual (AppFolio)" figure the Budget
  -- tab shows, and per Peter's decision (spec's Decision 3) it
  -- deliberately still includes tenant reimbursements/billbacks netted
  -- in, same as any other credit. Computed from raw general_ledger
  -- rows entirely in sync-time memory — the raw rows themselves are
  -- never written anywhere (see "Why not raw transaction lines"
  -- above). Can legitimately be negative for a property/category/month
  -- where credits outweighed debits (e.g. a large refund) — not
  -- constrained to >= 0.
  net_amount               NUMERIC(12,2) NOT NULL,

  -- The portion of net_amount attributable to a tenant reimbursement:
  -- sum(credit) restricted to rows where AppFolio's party_type =
  -- 'Occupancy' (spec's Finding E), for this same property +
  -- gl_account_id + period. A breakout of net_amount, not a second
  -- total and not something to add to or subtract from it (see "What
  -- reimbursable_amount is and isn't" above). Always >= 0 by
  -- construction — it only ever sums credit-side amounts, which
  -- AppFolio itself never represents as negative (spec's Finding B).
  -- Defaults to 0 rather than NULL because "no tenant reimbursement
  -- this month" is itself a real, known answer, unlike
  -- appfolio_property_budgets.actual_amount's NULL (which means
  -- "not fetched yet" for a different report).
  reimbursable_amount      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (reimbursable_amount >= 0),

  -- When this row was last confirmed by the nightly sync — lets the
  -- Budget tab show "as of [date]," same purpose as
  -- appfolio_property_budgets.synced_at elsewhere in this schema.
  synced_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Upsert key for the nightly sync job (matches Supabase's
  -- on_conflict= pattern every other supabaseUpsert* call in sync.js
  -- already uses). While a month is still "current" in AppFolio's
  -- window, this row gets overwritten every night with that month's
  -- latest running total. Once the calendar rolls past that month,
  -- AppFolio's window moves on and this row simply stops being
  -- touched — it becomes the permanent record of that month's total.
  UNIQUE (appfolio_property_id, period, gl_account_id)
);

-- Supports the query-time rollup described in "Query pattern" above
-- (SUM(net_amount)/SUM(reimbursable_amount) filtered by property +
-- gl_account_id + fiscal_year, called once per Budget tab page load).
-- The UNIQUE constraint above leads with (appfolio_property_id,
-- period, ...), which does NOT give a usable prefix for a fiscal_year
-- filter, so this is a genuinely separate index, not a duplicate of
-- the constraint's own index.
CREATE INDEX IF NOT EXISTS idx_appfolio_property_actuals_rollup
  ON appfolio_property_actuals (appfolio_property_id, fiscal_year, gl_account_id);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE appfolio_property_actuals ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_appfolio_property_actuals_updated_at ON appfolio_property_actuals;
CREATE TRIGGER trg_appfolio_property_actuals_updated_at
  BEFORE UPDATE ON appfolio_property_actuals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP TRIGGER IF EXISTS trg_appfolio_property_actuals_updated_at ON appfolio_property_actuals;
-- DROP INDEX IF EXISTS idx_appfolio_property_actuals_rollup;
-- DROP TABLE IF EXISTS appfolio_property_actuals;
--
-- Note: set_updated_at() is NOT dropped here — it is shared with
-- appfolio_property_budgets and every other table in this schema that
-- uses the same trigger pattern.
--
-- ============================================================
