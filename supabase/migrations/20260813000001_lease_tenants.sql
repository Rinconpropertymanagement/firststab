-- ============================================================
-- Migration: 20260813000001_lease_tenants
-- Created:   2026-08-13
-- Author:    Neo (database specialist)
--
-- Part of the Security Deposit Disposition Assembly Tool build
-- (projects/hub/security-deposit/SPEC.md, item #2 — "fixes Gap #3").
-- Fixes the real bug where `leases.tenant_id UUID NOT NULL` (initial
-- schema, line 128) can only ever hold one tenant per lease, silently
-- dropping every co-tenant on a multi-tenant occupancy.
--
-- ============================================================
-- LIVE DISCOVERY FINDINGS — THIS CHANGES THE SPEC'S DIAGNOSIS
-- (run 2026-08-13 against the real AppFolio API, read-only report pulls,
-- same approach as sync.js --discover)
-- ============================================================
--
-- The spec's hypothesis was: "If AppFolio's reports emit one row per
-- (occupancy, tenant) pair for a multi-tenant occupancy... multiple rows
-- in the same sync batch would share the same appfolio_id conflict key
-- with different appfolio_tenant_id values, and Postgres/PostgREST's
-- upsert keeps only the last one processed" — i.e. an upsert race/
-- collision. That hypothesis does NOT hold up against real data:
--
--   - Pulled full `rent_roll` (447 rows), `tenant_tickler` (8 rows), and
--     `lease_expiration_detail` (196 rows) — the three reports (plus
--     `delinquency`) that write to `leases`. Grouped every row by
--     occupancy_id and counted distinct tenant_id values per group.
--     RESULT: zero occupancies had more than one tenant_id in ANY of
--     these three reports. Each occupancy already collapses to exactly
--     one row with exactly one tenant_id before it ever reaches Supabase
--     — there is no multi-row collision happening in the sync batch.
--
--   - So the bug is real (confirmed below), but the mechanism is
--     different: these reports structurally only ever carry ONE tenant
--     per occupancy row to begin with. resolve_appfolio_foreign_keys()
--     was never losing data to an upsert race — it was faithfully
--     resolving leases.tenant_id from source data that only ever had
--     one tenant_id in it.
--
--   - REAL MULTI-TENANT DATA, CONFIRMED: `rent_roll` rows carry a field
--     the current sync ignores entirely — `additional_tenant_ids`, a
--     comma-separated string of every OTHER tenant on the occupancy
--     (plus a matching `additional_tenants` name string). Two real
--     examples pulled live:
--       occupancy_id 568  (263 S Ventura Rd Unit 268): tenant_id 1521
--         (Patrick Herrera) + additional_tenant_ids "1522, 2743"
--         (Audrey Herrera, Lourdes Herrera) — 3 tenants total.
--       occupancy_id 1162 (3677 Willowick Dr): tenant_id 3253
--         (Kent Mathieu) + additional_tenant_ids "3254, 3255, 3256,
--         3257" (Camilla, CarlaMaria, RoxanaMejias Mathieu, Ariel
--         Gildea) — 5 tenants total.
--     Both are real, currently-active Rincon leases, both silently
--     collapsed to a single tenant in `leases.tenant_id` today.
--
--   - BETTER SOURCE FOUND: `tenant_directory` (already synced, already
--     populates `tenants`) turns out to ALREADY be shaped as one row per
--     (occupancy, tenant) pair — exactly the shape the spec originally
--     guessed the leases-writing reports would have. Confirmed directly:
--     tenant_directory has its own `occupancy_id` field, and pulling the
--     row for "RoxanaMejias Mathieu" (selected_tenant_id 3256) shows
--     occupancy_id 1162 — the exact occupancy from the rent_roll example
--     above, and her ID is exactly one of the four in that row's
--     additional_tenant_ids. The two sources cross-validate each other.
--     tenant_directory also carries `primary_tenant` ("Yes"/"No") per
--     row — a clean signal for which tenant is the lease-holder of
--     record vs. a co-tenant, not present anywhere else. Current sync
--     code discards occupancy_id and primary_tenant entirely — it only
--     reads tenant_directory for `tenants` columns.
--
--   - DESIGN DECISION: `tenant_directory` is the primary sync source for
--     this table (naturally one row per pair, includes primary_tenant).
--     `rent_roll`'s additional_tenant_ids is documented above as a
--     available cross-check/fallback but is NOT required as a second
--     write path for v1 — avoids double-sourcing the same fact through
--     two different parsing paths. Q's call if a later gap is found.
--
-- Mason's finding (incorporated into the spec) pointed at
-- `team_member_tool_roles` (20260812020000_shared_team_members.sql,
-- line ~175) as the many-to-many pattern to mirror: its own primary key,
-- a NOT NULL REFERENCES ... ON DELETE CASCADE foreign key, and a UNIQUE
-- constraint over the pair. This table mirrors that shape with one
-- necessary difference, explained below.
--
-- WHY lease_id/tenant_id ARE NULLABLE HERE, UNLIKE team_member_tool_roles
-- team_member_tool_roles's team_member_id is always already a real UUID
-- at insert time — team_members are created by an interactive signup
-- flow, one row at a time. lease_tenants is populated by the NIGHTLY
-- BULK SYNC instead, which writes raw AppFolio identifiers first and
-- resolves them into real UUIDs in a second pass — the exact same
-- two-phase reason leases.tenant_id and leases.unit_id themselves are
-- nullable (see 20260720000001_nullable_fks.sql). So: raw
-- appfolio_occupancy_id/appfolio_tenant_id are NOT NULL (always known at
-- sync time) and are the upsert conflict key (property_owners-style,
-- 20260720000002_owners.sql); lease_id/tenant_id are nullable UUID FKs
-- with ON DELETE CASCADE, filled in by a second-pass resolution function
-- below (leases.tenant_id/unit_id-style, resolve_appfolio_foreign_keys()
-- -style). This gets Mason's CASCADE + UNIQUE-pair shape once resolved,
-- while still being writable by a bulk upsert before resolution runs.
--
-- ============================================================
-- ONE-TIME BACKFILL — NEEDED, NOT RUN BY THIS MIGRATION
-- ============================================================
-- This migration only prevents FUTURE data loss. Every multi-tenant
-- lease that has already synced under the old single-tenant_id scheme
-- has already lost every co-tenant but one — silently, whichever
-- happened to be written last. The two real examples above (occupancy
-- 568, occupancy 1162) are proof this has already happened, not a
-- hypothetical. Recovering them needs an explicit, one-time application
-- step, not a schema change — noted here so it isn't forgotten:
--
--   1. Extend sync.js's tenant_directory buildRow() (or a small
--      one-off script reusing its fetchAllPages/afPost helpers) to also
--      capture occupancy_id, selected_tenant_id (or occupancy_import_uid,
--      matching the existing appfolio_id convention on this report),
--      and primary_tenant from each row.
--   2. Upsert those rows into lease_tenants using
--      ON CONFLICT (appfolio_occupancy_id, appfolio_tenant_id) — the
--      same upsert pattern sync.js already uses for every other table.
--   3. Run resolve_lease_tenant_foreign_keys() (added below) once to
--      fill in lease_id/tenant_id for every row the backfill inserted.
--   4. This is safe to run against the FULL tenant_directory history
--      (1149 rows as of this migration) in one pass — it's a pure
--      upsert, not a destructive operation, and re-running it later
--      (e.g. after step 1 becomes part of the permanent nightly sync)
--      is idempotent.
--   5. Do NOT run this automatically as part of applying this migration
--      — it's an application-code change (sync.js) plus a one-time data
--      pull, not DDL, and per Neo's own migration gate this needs to be
--      tested on a copy first, same as any other write to real tenant
--      data. Flagged for Q to schedule as a follow-up task once this
--      migration and 20260813000004 (the sync fix) both ship.
--
-- Gate check (must pass before applying to any real database):
--   [x] Rollback exists — see bottom of this file
--   [x] No existing data is deleted or overwritten — new table only
--   [x] Touches leases and tenants only via nullable FK, no ALTER on
--       either table
--   [x] Purely additive
--   [ ] Backfill (above) is NOT part of this migration and is NOT yet
--       run — flagged as a required follow-up, not optional
--   [x] Should be tested on a copy of Supabase before production apply
-- ============================================================
--
-- ============================================================
-- DATA INVENTORY (GOVERNANCE.md Rule 4 — required for every new table
-- storing personal data)
-- ============================================================
--   pii_fields:          None stored directly as separate columns — this
--                         table holds only IDs and a boolean flag. The
--                         PII itself (name, email, phone) lives on
--                         `tenants`, referenced by tenant_id. However,
--                         each ROW is itself a personal-data fact: "this
--                         specific person is a tenant on this specific
--                         lease." Treated as personal data under CCPA on
--                         that basis, not because of any column content.
--   agents_with_access:  AppFolio nightly sync (system, service-role
--                         key); the security-deposit tool's backend
--                         routes (service-role key, reading every
--                         leaseholder for a case). No AI/LLM agent reads
--                         this table — it is structural data, never
--                         passed to a model.
--   privacy_category:    Tenant/lease association data.
--   retention_policy:    PLACEHOLDER — pending Mason (same open item as
--                         security_deposit_cases and b2_photo_folders
--                         below; spec item #8 explicitly allows a
--                         placeholder here). Placeholder value: retained
--                         for the life of the underlying `leases` row,
--                         no independent deletion schedule.
--   ccpa_exportable:     TRUE — a tenant could reasonably request "which
--                         leases am I associated with" as part of a data
--                         export.
--   ccpa_deletable:      Not directly deletable as a row on a CCPA
--                         request. Per the existing pattern in this
--                         schema (audit_log's CCPA note,
--                         20260720000003_foundation.sql), the underlying
--                         `tenants` row is anonymized in place on
--                         deletion; this join table's foreign keys are
--                         preserved for referential and audit integrity,
--                         the same way `leases` itself is not deleted
--                         when a tenant requests CCPA deletion.
--
-- RLS: enabled, no permissive policies — matches every other table in
-- this schema. Nothing reads or writes this table until Q adds a policy
-- scoped to authenticated users, or reaches it via the service-role key
-- from the server (the same way the AppFolio sync and every other Hub
-- tool already do).
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- TABLE: lease_tenants
-- What it stores: one row per (lease, tenant) pair — every leaseholder
-- on a lease, not just one. Fixes leases.tenant_id's single-tenant
-- limitation without touching leases itself (leases.tenant_id is left
-- in place, unused by new code, rather than dropped — see note below).
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS lease_tenants (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Raw AppFolio identifiers — always known at sync time, and the
  -- upsert conflict key (property_owners-style, since lease_id/tenant_id
  -- below aren't resolved yet on first write).
  appfolio_occupancy_id   TEXT        NOT NULL,   -- matches leases.appfolio_id
  appfolio_tenant_id      TEXT        NOT NULL,   -- matches tenants.appfolio_id

  -- Resolved UUID FKs — nullable until the resolution function below
  -- runs (mirrors leases.unit_id/tenant_id's own nullable-then-resolved
  -- pattern from 20260720000001_nullable_fks.sql). CASCADE per Mason's
  -- team_member_tool_roles-mirroring instruction.
  lease_id                UUID        REFERENCES leases(id)  ON DELETE CASCADE,
  tenant_id               UUID        REFERENCES tenants(id) ON DELETE CASCADE,

  -- From tenant_directory's `primary_tenant` field (Yes/No) — which
  -- tenant is the lease-holder of record vs. a co-tenant. Nullable:
  -- not knowable until at least one sync has run.
  is_primary              BOOLEAN,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Upsert conflict key — required for Supabase's ON CONFLICT upsert,
  -- same requirement documented in 20260720000002_owners.sql for
  -- property_owners.
  UNIQUE (appfolio_occupancy_id, appfolio_tenant_id)
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE lease_tenants ENABLE ROW LEVEL SECURITY;

-- Primary application query: "every tenant on this lease" — what the
-- disposition packet needs to show every leaseholder, not just one.
CREATE INDEX IF NOT EXISTS idx_lease_tenants_lease_id
  ON lease_tenants(lease_id)
  WHERE lease_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lease_tenants_tenant_id
  ON lease_tenants(tenant_id)
  WHERE tenant_id IS NOT NULL;

-- Once resolved, a (lease_id, tenant_id) pair should never repeat —
-- redundant with the appfolio-id UNIQUE above under normal operation
-- (each occupancy_id maps to exactly one lease_id) but enforced directly
-- too, per Mason's instruction to mirror team_member_tool_roles'
-- UNIQUE(team_member_id, tool) shape once IDs are real.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lease_tenants_resolved_pair
  ON lease_tenants(lease_id, tenant_id)
  WHERE lease_id IS NOT NULL AND tenant_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_lease_tenants_updated_at ON lease_tenants;
CREATE TRIGGER trg_lease_tenants_updated_at
  BEFORE UPDATE ON lease_tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- FUNCTION: resolve_lease_tenant_foreign_keys
-- Second-pass resolution for lease_tenants, mirroring
-- resolve_appfolio_foreign_keys() (20260803000001_resolve_fk_function.sql)
-- exactly in style. Kept as its OWN function rather than folded into
-- resolve_appfolio_foreign_keys() by editing that file — Neo's standing
-- rule is never modify an existing migration once it may have been
-- applied. A future migration is free to fold this in via
-- CREATE OR REPLACE if that's ever cleaner; not done here to keep this
-- migration additive and independently reviewable.
-- Called at the end of every sync run, same as resolve_appfolio_
-- foreign_keys() — Q should call both from sync.js.
-- ============================================================

CREATE OR REPLACE FUNCTION resolve_lease_tenant_foreign_keys()
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  lease_tenants_leases  INT;
  lease_tenants_tenants INT;
BEGIN
  -- lease_tenants.lease_id — match on appfolio_occupancy_id → leases.appfolio_id
  UPDATE lease_tenants lt
  SET lease_id = l.id
  FROM leases l
  WHERE lt.appfolio_occupancy_id = l.appfolio_id
    AND lt.lease_id IS DISTINCT FROM l.id;
  GET DIAGNOSTICS lease_tenants_leases = ROW_COUNT;

  -- lease_tenants.tenant_id — match on appfolio_tenant_id → tenants.appfolio_id
  UPDATE lease_tenants lt
  SET tenant_id = t.id
  FROM tenants t
  WHERE lt.appfolio_tenant_id = t.appfolio_id
    AND lt.tenant_id IS DISTINCT FROM t.id;
  GET DIAGNOSTICS lease_tenants_tenants = ROW_COUNT;

  RETURN jsonb_build_object(
    'lease_tenants_leases',  lease_tenants_leases,
    'lease_tenants_tenants', lease_tenants_tenants
  );
END;
$$;


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP FUNCTION IF EXISTS resolve_lease_tenant_foreign_keys();
--
-- DROP TRIGGER IF EXISTS trg_lease_tenants_updated_at ON lease_tenants;
--
-- DROP INDEX IF EXISTS idx_lease_tenants_resolved_pair;
-- DROP INDEX IF EXISTS idx_lease_tenants_tenant_id;
-- DROP INDEX IF EXISTS idx_lease_tenants_lease_id;
--
-- DROP TABLE IF EXISTS lease_tenants;
--
-- ============================================================
