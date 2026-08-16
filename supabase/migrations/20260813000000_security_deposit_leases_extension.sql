-- ============================================================
-- Migration: 20260813000000_security_deposit_leases_extension
-- Created:   2026-08-13
-- Author:    Neo (database specialist)
--
-- Part of the Security Deposit Disposition Assembly Tool build
-- (projects/hub/security-deposit/SPEC.md). Covers spec items #1
-- (move-out signal), #3 (deposit capture), and #7 (jurisdiction field) —
-- all small additive columns on two EXISTING, already-synced tables
-- (leases, properties), not new tables. No Rule 4 data inventory needed
-- here — that requirement is for new tables only (see the three tables
-- created in 20260813000001 through 20260813000003 for that).
--
-- All three additions follow this schema's existing "sync-owned field"
-- convention (documented at the top of projects/appfolio-sync/sync.js
-- and in 20260720000003_foundation.sql): each new column is written by
-- exactly ONE report in the nightly sync, going forward. Sync code must
-- omit the field entirely when it has no data for it — never send null,
-- which would clear a previously-synced value.
--
-- ============================================================
-- LIVE DISCOVERY FINDINGS (run 2026-08-13 against the real AppFolio API,
-- rinconpm.appfolio.com, using the existing APPFOLIO_CLIENT_ID/SECRET —
-- same discovery approach as sync.js --discover, read-only report pulls)
-- ============================================================
--
-- #3 — DEPOSIT CAPTURE: the spec asked whether AppFolio's ledger separates
-- security/pet/cleaning/key deposits and last month's rent as the AB 12
-- aggregate cap requires, and whether a fixed-columns or child-table shape
-- fits the real data. Findings:
--
--   - `rent_roll`, `tenant_directory`, `lease_expiration_detail`, and
--     `delinquency` (all 4 reports already synced) each return a plain
--     `deposit` field — one number per occupancy — that sync.js's
--     buildRow() functions currently discard entirely. No code change is
--     needed to GET this data; it has been sitting in the raw report
--     response the whole time.
--   - Rincon's actual AppFolio chart of accounts (`general_ledger` report,
--     40 distinct account_name values, checked in full) has exactly ONE
--     family of deposit-liability accounts: "2101 - Security Deposits"
--     (primary trust liability), "2130 - Security Deposit Collected by
--     Owner" (an owner-collected variant), "2120 - Security Deposits
--     Clearing" (in-transit), and "1160 - Security Deposit Cash" (the
--     trust cash asset side). There is NO separate account for a pet
--     deposit, cleaning deposit, or key/fob deposit anywhere in Rincon's
--     books — "4102 - Pet Rent" exists but is a monthly INCOME account,
--     not an upfront deposit, and "6140 - Keys" is a maintenance EXPENSE
--     account, not a deposit liability. Per-transaction receipt
--     descriptions for money going into the deposit-cash account were
--     checked directly (general_ledger, account "1160 - Security Deposit
--     Cash") and were uniformly "Move In Charge: Security Deposits" —
--     no distinct sub-type labels were found anywhere in real data.
--   - CONCLUSION: there is nothing to decompose. A generic one-row-per-
--     charge-type child table (the spec's alternative option) would be
--     built for data that does not exist in this AppFolio account today —
--     the same "don't build ahead of a real need" call already made
--     elsewhere in this schema (see 20260812010000_rental_analysis_schema
--     design notes on area_vacancy_rate). A single fixed nullable total
--     is the correct shape. See `deposit_held_total` below.
--   - REAL GAP FOUND, FLAGGED FOR MASON/PETER: "2300 - Prepaid Rent" DOES
--     exist as its own separate liability account, distinct from the
--     Security Deposits family, and AB 12's aggregate cap (Cal. Civil
--     Code § 1950.5(c)) explicitly includes last month's rent collected
--     upfront as security. AppFolio's `deposit` field on the 4 reports
--     above does NOT include this account's balance. If any current
--     Rincon tenant has prepaid last month's rent, that dollar amount is
--     invisible to `deposit_held_total` below and would be UNDER-COUNTED
--     against the AB 12 cap. v1 has no automated per-occupancy pull of
--     the Prepaid Rent balance (would require a general_ledger lookup
--     filtered to account "2300 - Prepaid Rent" and party_type=
--     'Occupancy' — a real, buildable Q connector method, just not part
--     of the nightly bulk sync in v1). This must be flagged to the pod
--     lead as a caveat, not silently omitted — Tron's job — and confirmed
--     with Mason before this is treated as a complete AB 12 total.
--   - Also found while testing report parameters: general_ledger silently
--     ignores `from_date`/`to_date`/`start_date`/`end_date` and defaults
--     to the current month, but DOES respect `posted_on_from`/
--     `posted_on_to` for a real historical range (confirmed: a wide range
--     returned rows starting 2020-01-01 instead of the default
--     2026-08-01). Useful for Q if a later phase needs historical
--     deposit-liability transactions per occupancy — noted here so nobody
--     re-discovers this by trial and error.
--
-- #7 — JURISDICTION FIELD: the spec asked for a county/city field on
-- `properties` so a later phase adding county-specific compliance content
-- doesn't need a schema retrofit. Finding: `property_directory` (already
-- synced, already writes to `properties`) already returns a `property_county`
-- field that sync.js's buildRow() currently discards. Checked the real
-- distinct values across all 381 currently-synced properties:
--   Ventura County: 328   Ventura: 48   California: 2   Los Angeles County: 2   (null): 1
-- This CONFIRMS Mason's concern was not theoretical — 2 of Rincon's
-- properties are actually in Los Angeles County, not Ventura County, so a
-- portfolio-wide "assume Ventura County" would have been silently wrong
-- for real properties today. ("Ventura" vs "Ventura County" is almost
-- certainly the same county with inconsistent formatting from AppFolio's
-- side — worth normalizing whenever this field becomes load-bearing in a
-- later phase; not normalized here since v1's own logic doesn't yet read
-- this column, per the spec.) Stored as free text, not a CHECK-constrained
-- enum, since AppFolio's own values aren't clean enough to constrain yet.
--
-- #1 — MOVE-OUT SIGNAL: no live discovery was needed here — the spec's
-- diagnosis (tenant_tickler's move-out reason getting clobbered by
-- rent_roll's `notes` write on the same `leases` row, per the existing
-- Prefer: resolution=merge-duplicates upsert behavior) was already
-- directly confirmed by reading sync.js line-by-line (lines 143-161 for
-- tenant_tickler's buildRow, line 246 documenting rent_roll running last
-- and winning on conflict). Real, not hypothetical. Fixed the same way
-- Gap #2 (multi-tenant) needed live confirmation but this one didn't.
--
-- Gate check (must pass before applying to any real database):
--   [x] Rollback exists — see bottom of this file
--   [x] No existing data is deleted or overwritten — all ADD COLUMN
--   [x] Touches leases and properties — both pre-existing, Neo-owned
--   [x] Purely additive (new nullable columns, no constraint tightening)
--   [x] Should be tested on a copy of Supabase before production apply
-- ============================================================


-- ------------------------------------------------------------
-- leases: move-out signal (spec item #1)
-- Owned exclusively by tenant_tickler going forward. No other report's
-- buildRow() may ever set these two columns — that's the entire fix.
-- ------------------------------------------------------------

ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS move_out_date   DATE,
  ADD COLUMN IF NOT EXISTS move_out_reason TEXT;

COMMENT ON COLUMN leases.move_out_date IS
  'Sync-owned exclusively by the tenant_tickler report. Never written by delinquency, lease_expiration_detail, or rent_roll. Omit (do not send null) when tenant_tickler has no move-out data for a row.';
COMMENT ON COLUMN leases.move_out_reason IS
  'Sync-owned exclusively by the tenant_tickler report. Same omit-don''t-null rule as move_out_date.';


-- ------------------------------------------------------------
-- leases: deposit capture (spec item #3)
-- Owned exclusively by rent_roll going forward — consistent with
-- rent_roll's existing role as the most complete lease report, which
-- already runs last and wins on conflict for every other leases field
-- (sync.js line 246). tenant_directory, lease_expiration_detail, and
-- delinquency ALSO carry a `deposit` value in their raw AppFolio
-- response, but must NOT write this column — that would recreate the
-- exact single-field clobber bug Gap #2 fixes elsewhere on this same
-- table. Pick one owner, same as move_out_date/move_out_reason above.
-- ------------------------------------------------------------

ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS deposit_held_total NUMERIC(10,2)
    CHECK (deposit_held_total IS NULL OR deposit_held_total >= 0),
  ADD COLUMN IF NOT EXISTS deposit_synced_at  TIMESTAMPTZ;

COMMENT ON COLUMN leases.deposit_held_total IS
  'AppFolio''s own reported deposit total for this occupancy (source: rent_roll''s `deposit` field). This is Rincon''s Security Deposits liability total ONLY (AppFolio GL accounts 2101/2130) — it does NOT include any last month''s rent collected upfront, which AppFolio tracks separately under "2300 - Prepaid Rent" and which AB 12 (Cal. Civil Code 1950.5(c)) still counts toward the aggregate cap. The UI must label this figure as sourced from AppFolio''s ledger, not an independently verified trust balance, and must flag that prepaid-rent-as-security is not included if it becomes relevant to a specific case. Sync-owned exclusively by rent_roll.';
COMMENT ON COLUMN leases.deposit_synced_at IS
  'Timestamp this lease''s deposit_held_total was last written by the sync. Lets the UI show "as of [date]" next to the figure. Set together with deposit_held_total by rent_roll only.';


-- ------------------------------------------------------------
-- properties: jurisdiction field (spec item #7)
-- Owned exclusively by property_directory going forward (the report that
-- already populates `properties`). Free text, not a CHECK enum — see
-- design note above on inconsistent real values ("Ventura" vs
-- "Ventura County"). Not read by any v1 logic; exists so a later phase
-- adding county-specific compliance content doesn't need a retrofit.
-- ------------------------------------------------------------

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS jurisdiction_county TEXT;

COMMENT ON COLUMN properties.jurisdiction_county IS
  'AppFolio''s own property_county value (source: property_directory report). Free text, not normalized — real portfolio values include both "Ventura County" and "Ventura" for the same county. Not read by any v1 security-deposit logic (v1''s statutes are all statewide) — exists to avoid a schema retrofit when a later phase adds county-specific compliance content. Sync-owned exclusively by property_directory.';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- ALTER TABLE properties DROP COLUMN IF EXISTS jurisdiction_county;
--
-- ALTER TABLE leases DROP COLUMN IF EXISTS deposit_synced_at;
-- ALTER TABLE leases DROP COLUMN IF EXISTS deposit_held_total;
--
-- ALTER TABLE leases DROP COLUMN IF EXISTS move_out_reason;
-- ALTER TABLE leases DROP COLUMN IF EXISTS move_out_date;
--
-- ============================================================
