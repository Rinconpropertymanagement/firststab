-- ============================================================
-- Migration: 20260819000000_add_prepaid_rent_reported_to_security_deposit_cases
-- Created:   2026-08-19
-- Author:    Neo (database specialist)
--
-- Part of the Security Deposit Disposition Assembly Tool build
-- (projects/hub/security-deposit/SPEC.md, Neo section #3 — Prepaid Rent).
-- Replaces the tool's dependency on a LIVE AppFolio lookup
-- (appfolio-connector.js's getPrepaidRentBalance(), a general_ledger call
-- filtered to account "2300 - Prepaid Rent") with a required, human-
-- entered figure. Automatic retrieval is confirmed a dead end for
-- driving a hard review gate: it can return found:false or an outright
-- error, and there is no way to force a human decision out of a live
-- lookup that might just fail. Peter's decision, on Mason's (legal)
-- recommendation: the pod lead looks up "2300 - Prepaid Rent" for the
-- tenant in AppFolio themselves and types in the balance they find (or
-- $0 if none exists) — the same "human does what software can't
-- guarantee" pattern already used for the reviewer checklist and the
-- inspection-form upload. getPrepaidRentBalance() itself is untouched by
-- this change (still correct, still available for a future phase) — Q's
-- route code simply stops calling it from the case-detail assembly path.
--
-- This is a NEW migration, not an edit to
-- 20260813000002_security_deposit_cases.sql — that migration is already
-- applied to the live database, so Neo's "never modify an already-applied
-- migration" rule is in force. Additive columns on an existing table only.
--
-- ============================================================
-- Column shape
-- ============================================================
--
--   - prepaid_rent_balance NUMERIC(10,2): the dollar figure the pod lead
--     found and typed in. Same type/precision as leases.deposit_held_total
--     (20260813000000) — a plain dollar total, not a computed value. CHECK
--     disallows negative values, same "IS NULL OR ... >= 0" pattern as
--     deposit_held_total.
--
--   - prepaid_rent_reported_by TEXT / prepaid_rent_reported_at TIMESTAMPTZ:
--     who entered the figure and when. TEXT, not a foreign key — matches
--     this exact table's own reviewed_by/escalated_by convention (stores
--     the human-readable identity string the route already computes via
--     req.securityDepositMemberName || req.user.email), not a new pattern.
--     Prefixed with prepaid_rent_ (rather than bare reported_by/
--     reported_at) because this table already has two other who/when
--     pairs (reviewed_by/reviewed_at, escalated_by/escalated_at) — an
--     unprefixed third pair would be ambiguous about which action it
--     records. Mirrors the checklist_ prefix already used for the three
--     checklist booleans on this same table.
--
--   - All three nullable, no default. This is the load-bearing design
--     choice: NULL means "not yet looked up," 0 means "looked up, none
--     found." A NOT NULL DEFAULT 0 would collapse those two states into
--     one and defeat the entire point of requiring a human to actually
--     check AppFolio before the case can move forward.
--
-- ============================================================
-- The hard gate lives in application code, not the database
-- ============================================================
--
-- Checked the existing /review route and this table's CHECK constraints
-- before writing this: there is no existing hard-gate pattern on this
-- table to mirror. status='reviewed' can be set today with the three
-- checklist booleans and tenancy_status still NULL — nothing in the
-- database or the route stops it; "matching how the other two checklist
-- questions already block finalization" describes intended behavior, not
-- something that exists yet to copy structurally. Given that, this
-- migration deliberately does NOT add a
-- CHECK (status <> 'reviewed' OR prepaid_rent_balance IS NOT NULL) at the
-- database layer — enforcing it there for only this one field, while the
-- checklist/tenancy_status fields stay ungated at the database layer too,
-- would be a confusing half-measure. Q's POST .../review route is where
-- this gate is enforced (checks prepaid_rent_balance IS NOT NULL before
-- allowing status to become 'reviewed', returns 400 with a clear message
-- otherwise). See router.js for the actual check.
--
-- ============================================================
-- Rule 4 (GOVERNANCE.md) — no new data inventory block needed
-- ============================================================
--
-- Rule 4 requires a data inventory block when CREATING a new table. This
-- is an additive column on security_deposit_cases, which already has a
-- full Rule 4 block in 20260813000002_security_deposit_cases.sql — same
-- precedent 20260813000000_security_deposit_leases_extension.sql set for
-- additive columns on leases/properties (no fresh block, just a pointer
-- back). Not editing that existing block in place (it's already applied,
-- same "don't touch old migrations" rule as above) — noting here instead:
-- prepaid_rent_balance is tenant-linked financial data covered by
-- security_deposit_cases's existing Rule 4 block — same privacy_category
-- (tenancy/financial-compliance record), same ccpa_exportable=TRUE /
-- ccpa_deletable=FALSE treatment as the rest of the row (a compliance
-- record supporting Rincon's own AB 12 obligation, not personal data
-- collected for convenience). Not a new PII category; no new block
-- required.
--
-- Gate check (must pass before applying to any real database):
--   [x] Rollback exists — see bottom of this file
--   [x] No existing data is deleted or overwritten — all ADD COLUMN
--   [x] Touches security_deposit_cases — already Neo-owned, already RLS-enabled
--   [x] Purely additive (new nullable columns, no constraint tightening)
--   [x] Should be tested on a copy of Supabase before production apply
-- ============================================================

ALTER TABLE security_deposit_cases
  ADD COLUMN IF NOT EXISTS prepaid_rent_balance     NUMERIC(10,2)
    CHECK (prepaid_rent_balance IS NULL OR prepaid_rent_balance >= 0),
  ADD COLUMN IF NOT EXISTS prepaid_rent_reported_by TEXT,
  ADD COLUMN IF NOT EXISTS prepaid_rent_reported_at TIMESTAMPTZ;

COMMENT ON COLUMN security_deposit_cases.prepaid_rent_balance IS
  'Prepaid Rent (AppFolio account "2300 - Prepaid Rent") balance for this tenant, manually looked up in AppFolio and entered by a pod lead — NOT an automated pull. NULL = not yet looked up; 0 = looked up, none found. AB 12 (Cal. Civil Code 1950.5(c)) counts this toward the aggregate deposit cap alongside leases.deposit_held_total, but AppFolio books it in a genuinely separate account, so it is tracked as its own figure here. The case cannot be marked reviewed while this is NULL — enforced in application code (router.js POST .../review), not by a database constraint; see migration header for why.';
COMMENT ON COLUMN security_deposit_cases.prepaid_rent_reported_by IS
  'Human-readable identity of who entered prepaid_rent_balance (team member full name, or email as fallback) — same convention as reviewed_by/escalated_by on this table, not a foreign key.';
COMMENT ON COLUMN security_deposit_cases.prepaid_rent_reported_at IS
  'Timestamp prepaid_rent_balance was last entered/changed. Set together with prepaid_rent_balance and prepaid_rent_reported_by.';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- ALTER TABLE security_deposit_cases DROP COLUMN IF EXISTS prepaid_rent_reported_at;
-- ALTER TABLE security_deposit_cases DROP COLUMN IF EXISTS prepaid_rent_reported_by;
-- ALTER TABLE security_deposit_cases DROP COLUMN IF EXISTS prepaid_rent_balance;
--
-- ============================================================
