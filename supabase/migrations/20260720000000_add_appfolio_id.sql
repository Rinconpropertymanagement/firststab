-- Migration: 0002_add_appfolio_id
-- Created:   2026-07-20
-- Author:    Neo (database specialist)
--
-- Adds an appfolio_id column to all 5 core tables.
-- This column is the upsert key used by the nightly AppFolio sync script.
--
-- Design notes:
--   - Column is nullable: rows entered manually will have appfolio_id = NULL.
--   - Uniqueness is enforced with a PARTIAL index (WHERE appfolio_id IS NOT NULL)
--     so that multiple manually-entered NULL rows never conflict with each other.
--   - The sync script runs with the Supabase service role key and uses
--     ON CONFLICT (appfolio_id) DO UPDATE to upsert without duplicates.
--   - For AppFolio records without a single natural key (e.g. units), the sync
--     script stores a composite key such as "property_name|unit_number".
--   - IF NOT EXISTS guards on both the column and the index make this migration
--     safe to run more than once.
--
-- No RLS policy changes are needed: the sync script bypasses RLS via the
-- service role key, which was the agreed approach for the nightly job.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- TABLE: properties
-- ============================================================

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS appfolio_id TEXT;

-- Partial unique index: enforces uniqueness only for non-NULL values,
-- so manually-entered rows (appfolio_id = NULL) never collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_properties_appfolio_id
  ON properties(appfolio_id)
  WHERE appfolio_id IS NOT NULL;


-- ============================================================
-- TABLE: units
-- ============================================================

ALTER TABLE units
  ADD COLUMN IF NOT EXISTS appfolio_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_units_appfolio_id
  ON units(appfolio_id)
  WHERE appfolio_id IS NOT NULL;


-- ============================================================
-- TABLE: tenants
-- ============================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS appfolio_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_appfolio_id
  ON tenants(appfolio_id)
  WHERE appfolio_id IS NOT NULL;


-- ============================================================
-- TABLE: leases
-- ============================================================

ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS appfolio_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leases_appfolio_id
  ON leases(appfolio_id)
  WHERE appfolio_id IS NOT NULL;


-- ============================================================
-- TABLE: maintenance_requests
-- ============================================================

ALTER TABLE maintenance_requests
  ADD COLUMN IF NOT EXISTS appfolio_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_maintenance_requests_appfolio_id
  ON maintenance_requests(appfolio_id)
  WHERE appfolio_id IS NOT NULL;


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP INDEX IF EXISTS idx_maintenance_requests_appfolio_id;
-- DROP INDEX IF EXISTS idx_leases_appfolio_id;
-- DROP INDEX IF EXISTS idx_tenants_appfolio_id;
-- DROP INDEX IF EXISTS idx_units_appfolio_id;
-- DROP INDEX IF EXISTS idx_properties_appfolio_id;
--
-- ALTER TABLE maintenance_requests DROP COLUMN IF EXISTS appfolio_id;
-- ALTER TABLE leases               DROP COLUMN IF EXISTS appfolio_id;
-- ALTER TABLE tenants              DROP COLUMN IF EXISTS appfolio_id;
-- ALTER TABLE units                DROP COLUMN IF EXISTS appfolio_id;
-- ALTER TABLE properties           DROP COLUMN IF EXISTS appfolio_id;
--
-- ============================================================
