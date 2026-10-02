-- ============================================================
-- Migration: 20261002000000_tenant_owner_emails_schema
-- Created:   2026-10-02
-- Author:    Neo (database specialist)
--
-- Adds two new tables — tenant_emails and owner_emails — so Complaint
-- Tracking's deterministic participant-address matcher
-- (projects/hub/complaint-tracking/lib/subject-match.js,
-- matchParticipantsToRecords()/findUniqueMatch()) can check a thread
-- participant's address against EVERY email AppFolio has on file for a
-- tenant or owner, not just the single value in tenants.email/owners.email.
--
-- ============================================================
-- WHY THIS IS NEEDED — two real, distinct data problems
-- ============================================================
-- 1. TENANTS: AppFolio's tenant_directory report returns multiple emails
--    per tenant as a comma-separated string (`emails`). The nightly sync
--    (projects/appfolio-sync/sync.js, tenant_directory buildRow(), ~line
--    171) only ever keeps the first one. Every other address AppFolio has
--    on file for that tenant is silently discarded, every run.
-- 2. OWNERS: AppFolio's owner_directory report field (`email`, singular)
--    is not comma-separated by design the way tenant_directory's is, but
--    in practice carries multiple comma-joined addresses for some owners.
--    The sync (syncOwnerDirectory(), ~line 912) stores it VERBATIM —
--    `email: row.email || null` — with no splitting at all.
--
-- Confirmed live against the real database before writing this file (read
-- -only SELECT against owners/tenants, no writes):
--   - 395 owners total; 394 have any email on file.
--   - 132 of those 394 (33%) are a comma-joined string: 122 hold exactly 2
--     addresses, 10 hold exactly 3. Sample: "ayad321@gmail.com,
--     charlottefnp@hotmail.com".
--   - 0 tenants currently have a stored email containing a comma —
--     consistent with the sync already silently keeping only the first.
--   - Neither tenants.email, owners.email, nor vendors.email carries a
--     uniqueness constraint (confirmed against 20260626000000/
--     20260720000002/20260720000003) — two people sharing one email (e.g.
--     co-owners) is a real, already-handled shape in subject-match.js.
--
-- ============================================================
-- WHY A CHILD TABLE, NOT A SECOND alt_email-STYLE COLUMN, AND NOT A
-- TEXT[] ARRAY COLUMN
-- ============================================================
-- This project's most recent precedent for "a person has more than one
-- known email" is users.alt_email (20260928000000) — one extra nullable
-- column, deliberately scoped to exactly one person having exactly one
-- alternate address, with its own comment explicitly saying "if ... one
-- person needs a third address, that is a reason to revisit this design."
-- That condition is already true here on day one: 10 owners today have
-- THREE addresses, not two. A fixed-N-column shape (email, alt_email,
-- alt_email_2, ...) would need to guess a cap with no real ceiling in
-- AppFolio's data (tenant-side comma counts are completely unknown today
-- because the sync has discarded everything but the first address since
-- day one — there is no historical data to even check), and it wastes
-- columns for the common case (0 or 1 email). A child table handles any
-- number of addresses per person without a schema change every time
-- someone turns up with one more than the current cap.
--
-- A TEXT[] array column on tenants/owners was also considered and
-- rejected, for the same reason this schema already rejected it once
-- before (20260712000000_content_seo_and_topic_tagging.sql, rejecting a
-- TEXT[] of topic_keys on content_items in favor of the content_item_topics
-- join table): it would be the only place in this schema representing a
-- one-to-many identity fact that way, it buys nothing in query simplicity
-- over a plain indexed child table (the matcher's query is "which
-- tenant/owner, if any, uniquely owns this one address" — a plain
-- `WHERE email ILIKE ...` lookup, not a set-membership scan), and it
-- would make a future per-address attribute (e.g. "which AppFolio field
-- did this come from") awkward to add later. A child table is also the
-- established house pattern for exactly this shape of bug —
-- 20260813000001_lease_tenants.sql fixed the near-identical problem
-- ("leases.tenant_id can only hold one tenant") the same way.
--
-- tenants.email and owners.email are NOT dropped, NOT altered, and NOT
-- made redundant by this migration. Every existing reader of those two
-- columns keeps working unchanged. They continue to hold "the first/
-- primary known address" for display purposes; the new tables hold the
-- complete set (including a copy of that same first address, flagged
-- is_primary) for matching purposes. See the sync.js and subject-match.js
-- change specs below for exactly how the two stay in sync.
--
-- ============================================================
-- WHY TWO-PHASE RESOLUTION (raw AppFolio ID now, UUID FK resolved later)
-- ============================================================
-- Mirrors lease_tenants' own resolution shape exactly, and for the same
-- reason: these rows are written by the nightly BULK SYNC, which knows
-- the raw AppFolio tenant/owner ID at write time but not yet knows (or
-- cannot cheaply look up, one row at a time, from a pure buildRow()
-- mapper with no DB access) the real Supabase UUID. appfolio_tenant_id /
-- appfolio_owner_id are therefore NOT NULL and are the upsert conflict
-- key (property_owners/lease_tenants-style); tenant_id/owner_id are
-- nullable UUID FKs, filled in by a second-pass resolution function
-- (below), called at the end of every sync run alongside the existing
-- resolve_appfolio_foreign_keys() and resolve_lease_tenant_foreign_keys().
--
-- Per Neo's standing rule (never modify an existing migration once it may
-- have been applied), these are NEW functions, not edits to either
-- existing resolve function.
--
-- ============================================================
-- DATA INVENTORY (GOVERNANCE.md Rule 4 — required for every new table
-- storing personal data)
-- ============================================================
--   pii_fields:          email (both tables) — a real tenant/owner email
--                        address. Same category of data already stored in
--                        tenants.email/owners.email today; this does not
--                        introduce a new category of personal data, it
--                        stores more of the same category.
--   agents_with_access:  AppFolio nightly sync (service-role key, writes).
--                        Complaint Tracking's identity matcher — subject-
--                        match.js's findUniqueMatch(), called from
--                        significance-pass.js and process-pending-
--                        messages.js (service-role key, reads only). No
--                        AI/LLM agent reads either table directly — this
--                        is structural lookup data, the same posture
--                        lease_tenants documents for itself.
--   privacy_category:   Tenant/owner contact data.
--   retention_policy:    PLACEHOLDER pending Mason — mirrors tenants.email/
--                        owners.email's own retention today (same open
--                        item lease_tenants and b2_photo_folders already
--                        carry as an accepted placeholder). Follow-up open
--                        item: whichever process ultimately redacts a
--                        tenant's/owner's email on a CCPA deletion request
--                        must be extended to also redact that person's
--                        rows in this table — not built here, flagged so
--                        it isn't missed. No such redaction function
--                        exists in this codebase yet for tenants/owners
--                        today (confirmed by search), so this is not a
--                        regression this migration introduces — it is the
--                        same gap the parent tables already have.
--   ccpa_exportable:     TRUE — same basis as lease_tenants: a tenant/
--                        owner could reasonably request "every email
--                        address you have on file for me."
--   ccpa_deletable:      Not directly deletable as a standalone action;
--                        follows the parent row's lifecycle (ON DELETE
--                        CASCADE) the same way lease_tenants follows
--                        leases/tenants.
--
-- RLS: enabled on both new tables, no permissive policies — matches every
-- table in this schema. Nothing reads or writes these tables until a tool
-- adds a policy scoped to authenticated users, or reaches them via the
-- service-role key the way the AppFolio sync and every Hub tool already do.
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No. Two new tables, two new
--       functions. Zero ALTER statements against tenants, owners, or any
--       other existing table. Nothing already reading tenants.email or
--       owners.email changes behavior.
--   [x] Does this touch a table other code depends on? It references
--       tenants(id) and owners(id) via nullable FK only (ON DELETE
--       CASCADE) — no column, constraint, index, or trigger on either
--       existing table is added, changed, or removed.
--   [x] Additive or destructive? Purely additive DDL. (The separate,
--       one-time data backfill for the 132 already-broken owners.email
--       rows is NOT part of this migration — see "BACKFILL" note below,
--       same separation-of-concerns precedent as 20260928000000's alt_email
--       value-setting and 20260813000001's lease_tenants backfill, both
--       kept out of their schema migrations and done as a separate script.)
--   [x] Tested on a copy of the data first? Not yet — standard practice
--       before applying to the real database, same as every migration in
--       this repo. Run this against a Supabase branch/copy before applying
--       to production.
--
-- ============================================================
-- BACKFILL — NEEDED, NOT RUN BY THIS MIGRATION
-- ============================================================
-- This migration only adds empty tables. The 132 owners whose email is
-- already a broken comma-joined string stay unmatchable until that
-- existing data is split into owner_emails AND owners.email itself is
-- normalized down to just the first address (so it stops being a broken
-- literal going forward too). That is a one-time, judgment-laden data
-- correction, not DDL — handled by a separate script:
-- projects/appfolio-sync/backfill-owner-email-split.js. See that file's
-- own header for exactly what it does and the dry-run flag it supports.
-- Do NOT run it automatically as part of applying this migration — test it
-- against a copy first, same as this migration itself.
--
-- tenants.email needs NO equivalent backfill of existing data — the task
-- that produced this migration is explicit that tenants.email's existing
-- single value is presumably already correct, just incomplete, so the fix
-- there is purely additive going forward (capture the rest on next sync +
-- re-sync), never a rewrite of what's already stored.
-- ============================================================


-- ============================================================
-- TABLE: tenant_emails
-- What it stores: every known email address for a tenant — one row per
-- address. The complete set Complaint Tracking's matcher checks against;
-- tenants.email (unchanged, still just the first/primary address) is not
-- read for matching purposes once this ships.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS tenant_emails (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Raw AppFolio tenant ID — always known at sync time, and the upsert
  -- conflict key (property_owners/lease_tenants-style), since tenant_id
  -- below isn't resolved yet on first write. Must match tenant_directory's
  -- own REPORT_CONFIG entry's `const afId = row.selected_tenant_id ||
  -- row.occupancy_import_uid` exactly, or resolution below silently fails.
  appfolio_tenant_id   TEXT        NOT NULL,

  -- Resolved UUID FK — nullable until resolve_tenant_email_foreign_keys()
  -- (below) runs. CASCADE: if a tenant row is ever deleted, their email
  -- rows go with it rather than becoming orphaned.
  tenant_id            UUID        REFERENCES tenants(id) ON DELETE CASCADE,

  email                TEXT        NOT NULL,

  -- TRUE for the one address that also lives in tenants.email (the first
  -- address AppFolio returned for this tenant). Lets a future reader
  -- distinguish "the primary/display address" from "an additional known
  -- address" without re-parsing anything.
  is_primary           BOOLEAN     NOT NULL DEFAULT FALSE,

  -- Where this row came from. Defaults to the sync's own source; a value
  -- like 'manual' is left available for a human-entered address later,
  -- without needing a schema change.
  source               TEXT        NOT NULL DEFAULT 'appfolio_tenant_directory',

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Upsert conflict key (Supabase REST ON CONFLICT requirement, same as
  -- property_owners/lease_tenants) — also naturally de-duplicates the same
  -- address appearing again across repeated tenant_directory rows for the
  -- same tenant (e.g. one row per occupancy, per lease_tenants' own
  -- documented discovery about this report's shape).
  UNIQUE (appfolio_tenant_id, email)
);

ALTER TABLE tenant_emails ENABLE ROW LEVEL SECURITY;

-- Matcher's lookup path: "does this one address belong to a tenant."
CREATE INDEX IF NOT EXISTS idx_tenant_emails_email
  ON tenant_emails(email);

-- Resolution function's join target, and any future "every email for this
-- tenant" query.
CREATE INDEX IF NOT EXISTS idx_tenant_emails_tenant_id
  ON tenant_emails(tenant_id)
  WHERE tenant_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_tenant_emails_updated_at ON tenant_emails;
CREATE TRIGGER trg_tenant_emails_updated_at
  BEFORE UPDATE ON tenant_emails
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE tenant_emails IS
  'One row per known email address per tenant. Populated from tenant_directory''s comma-separated `emails` field (all addresses, not just the first). tenants.email is unchanged and still holds only the first/primary address for display; this table is the complete set the Complaint Tracking matcher checks against.';


-- ============================================================
-- TABLE: owner_emails
-- What it stores: every known email address for an owner — one row per
-- address. Fixes the 33%-of-owners case where AppFolio's owner_directory
-- `email` field carries multiple comma-joined addresses in one string.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS owner_emails (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Raw AppFolio owner ID — matches owners.appfolio_id. Upsert conflict
  -- key, same reasoning as tenant_emails above.
  appfolio_owner_id    TEXT        NOT NULL,

  owner_id             UUID        REFERENCES owners(id) ON DELETE CASCADE,

  email                TEXT        NOT NULL,

  -- TRUE for the one address that also lives in owners.email (the first
  -- address after splitting, going forward — see sync.js change spec).
  is_primary           BOOLEAN     NOT NULL DEFAULT FALSE,

  source               TEXT        NOT NULL DEFAULT 'appfolio_owner_directory',

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (appfolio_owner_id, email)
);

ALTER TABLE owner_emails ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_owner_emails_email
  ON owner_emails(email);

CREATE INDEX IF NOT EXISTS idx_owner_emails_owner_id
  ON owner_emails(owner_id)
  WHERE owner_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_owner_emails_updated_at ON owner_emails;
CREATE TRIGGER trg_owner_emails_updated_at
  BEFORE UPDATE ON owner_emails
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE owner_emails IS
  'One row per known email address per owner. Populated by splitting owner_directory''s `email` field on commas (all addresses, not just the first — and not stored verbatim as a joined string). owners.email is normalized to hold only the first address going forward; this table is the complete set the Complaint Tracking matcher checks against.';


-- ============================================================
-- FUNCTION: resolve_tenant_email_foreign_keys
-- Second-pass resolution for tenant_emails, mirroring
-- resolve_lease_tenant_foreign_keys() (20260813000001_lease_tenants.sql)
-- exactly in style. Called at the end of every sync run, same as the
-- existing resolve_appfolio_foreign_keys() and
-- resolve_lease_tenant_foreign_keys().
-- ============================================================

CREATE OR REPLACE FUNCTION resolve_tenant_email_foreign_keys()
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  tenant_emails_resolved INT;
BEGIN
  UPDATE tenant_emails te
  SET tenant_id = t.id
  FROM tenants t
  WHERE te.appfolio_tenant_id = t.appfolio_id
    AND te.tenant_id IS DISTINCT FROM t.id;
  GET DIAGNOSTICS tenant_emails_resolved = ROW_COUNT;

  RETURN jsonb_build_object('tenant_emails_resolved', tenant_emails_resolved);
END;
$$;


-- ============================================================
-- FUNCTION: resolve_owner_email_foreign_keys
-- Second-pass resolution for owner_emails. Same pattern as above.
-- ============================================================

CREATE OR REPLACE FUNCTION resolve_owner_email_foreign_keys()
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  owner_emails_resolved INT;
BEGIN
  UPDATE owner_emails oe
  SET owner_id = o.id
  FROM owners o
  WHERE oe.appfolio_owner_id = o.appfolio_id
    AND oe.owner_id IS DISTINCT FROM o.id;
  GET DIAGNOSTICS owner_emails_resolved = ROW_COUNT;

  RETURN jsonb_build_object('owner_emails_resolved', owner_emails_resolved);
END;
$$;


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP FUNCTION IF EXISTS resolve_owner_email_foreign_keys();
-- DROP FUNCTION IF EXISTS resolve_tenant_email_foreign_keys();
--
-- DROP TRIGGER IF EXISTS trg_owner_emails_updated_at ON owner_emails;
-- DROP TRIGGER IF EXISTS trg_tenant_emails_updated_at ON tenant_emails;
--
-- DROP INDEX IF EXISTS idx_owner_emails_owner_id;
-- DROP INDEX IF EXISTS idx_owner_emails_email;
-- DROP INDEX IF EXISTS idx_tenant_emails_tenant_id;
-- DROP INDEX IF EXISTS idx_tenant_emails_email;
--
-- DROP TABLE IF EXISTS owner_emails;
-- DROP TABLE IF EXISTS tenant_emails;
--
-- ============================================================
