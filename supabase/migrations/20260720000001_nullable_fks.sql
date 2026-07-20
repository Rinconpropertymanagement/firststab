-- Migration: 20260720000001_nullable_fks
-- Created:   2026-07-20
-- Author:    Neo (database specialist)
--
-- Why this exists:
--   The AppFolio → Supabase sync script imports data from flat report exports.
--   Those exports do not always include the foreign-key values needed to resolve
--   relationships (property_id, unit_id, tenant_id) at insert time, and may
--   omit unit attributes (bedrooms, bathrooms, monthly_rent) or portfolio-level
--   counts (unit_count). Making these columns nullable lets the sync insert what
--   it has and back-fill relationships in a second pass.
--
--   Foreign key references (and their ON DELETE behavior) are preserved exactly
--   as defined in the initial schema — only the NOT NULL requirement is dropped.
--
-- Gate check (must pass before applying to any real database):
--   [x] Rollback exists — see bottom of this file
--   [x] No existing data is deleted or overwritten
--   [x] Touches units, leases, maintenance_requests, properties — all owned by Neo
--   [x] Every change is additive (constraint relaxation) — no destructive DDL
--   [x] Should be tested on a copy of the Supabase project before production apply
-- ============================================================


-- ------------------------------------------------------------
-- 1. properties — make unit_count nullable, relax its CHECK
-- ------------------------------------------------------------

ALTER TABLE properties
  ALTER COLUMN unit_count DROP NOT NULL;

-- PostgreSQL auto-names this inline CHECK as "properties_unit_count_check".
-- If the name differs in your instance, look it up in the Supabase dashboard
-- under Table Editor → properties → Constraints, then replace the name below.
ALTER TABLE properties
  DROP CONSTRAINT IF EXISTS properties_unit_count_check;

ALTER TABLE properties
  ADD CONSTRAINT properties_unit_count_check
    CHECK (unit_count IS NULL OR unit_count >= 0);


-- ------------------------------------------------------------
-- 2. units — make property_id, bedrooms, bathrooms, monthly_rent nullable
--            and relax the CHECK constraints on the numeric columns
-- ------------------------------------------------------------

-- FK column — preserves REFERENCES properties(id) ON DELETE CASCADE
ALTER TABLE units
  ALTER COLUMN property_id DROP NOT NULL;

-- bedrooms
ALTER TABLE units
  ALTER COLUMN bedrooms DROP NOT NULL;

ALTER TABLE units
  DROP CONSTRAINT IF EXISTS units_bedrooms_check;

ALTER TABLE units
  ADD CONSTRAINT units_bedrooms_check
    CHECK (bedrooms IS NULL OR bedrooms >= 0);

-- bathrooms
ALTER TABLE units
  ALTER COLUMN bathrooms DROP NOT NULL;

ALTER TABLE units
  DROP CONSTRAINT IF EXISTS units_bathrooms_check;

ALTER TABLE units
  ADD CONSTRAINT units_bathrooms_check
    CHECK (bathrooms IS NULL OR bathrooms >= 0);

-- monthly_rent
ALTER TABLE units
  ALTER COLUMN monthly_rent DROP NOT NULL;

ALTER TABLE units
  DROP CONSTRAINT IF EXISTS units_monthly_rent_check;

ALTER TABLE units
  ADD CONSTRAINT units_monthly_rent_check
    CHECK (monthly_rent IS NULL OR monthly_rent >= 0);


-- ------------------------------------------------------------
-- 3. leases — make unit_id and tenant_id nullable
--             preserves REFERENCES and ON DELETE RESTRICT on both
-- ------------------------------------------------------------

ALTER TABLE leases
  ALTER COLUMN unit_id DROP NOT NULL;

ALTER TABLE leases
  ALTER COLUMN tenant_id DROP NOT NULL;


-- ------------------------------------------------------------
-- 4. maintenance_requests — make unit_id nullable
--                           preserves REFERENCES units(id) ON DELETE RESTRICT
-- ------------------------------------------------------------

ALTER TABLE maintenance_requests
  ALTER COLUMN unit_id DROP NOT NULL;


-- ============================================================
-- ROLLBACK
-- Run these statements in order to undo this migration.
-- Apply only if no sync data has been inserted with NULL values —
-- restoring NOT NULL will fail if any existing rows contain NULLs.
-- ============================================================
--
-- -- 4. maintenance_requests
-- ALTER TABLE maintenance_requests
--   ALTER COLUMN unit_id SET NOT NULL;
--
-- -- 3. leases
-- ALTER TABLE leases
--   ALTER COLUMN tenant_id SET NOT NULL;
--
-- ALTER TABLE leases
--   ALTER COLUMN unit_id SET NOT NULL;
--
-- -- 2. units
-- ALTER TABLE units
--   DROP CONSTRAINT IF EXISTS units_monthly_rent_check;
-- ALTER TABLE units
--   ADD CONSTRAINT units_monthly_rent_check CHECK (monthly_rent >= 0);
-- ALTER TABLE units
--   ALTER COLUMN monthly_rent SET NOT NULL;
--
-- ALTER TABLE units
--   DROP CONSTRAINT IF EXISTS units_bathrooms_check;
-- ALTER TABLE units
--   ADD CONSTRAINT units_bathrooms_check CHECK (bathrooms >= 0);
-- ALTER TABLE units
--   ALTER COLUMN bathrooms SET NOT NULL;
--
-- ALTER TABLE units
--   DROP CONSTRAINT IF EXISTS units_bedrooms_check;
-- ALTER TABLE units
--   ADD CONSTRAINT units_bedrooms_check CHECK (bedrooms >= 0);
-- ALTER TABLE units
--   ALTER COLUMN bedrooms SET NOT NULL;
--
-- ALTER TABLE units
--   ALTER COLUMN property_id SET NOT NULL;
--
-- -- 1. properties
-- ALTER TABLE properties
--   DROP CONSTRAINT IF EXISTS properties_unit_count_check;
-- ALTER TABLE properties
--   ADD CONSTRAINT properties_unit_count_check CHECK (unit_count > 0);
-- ALTER TABLE properties
--   ALTER COLUMN unit_count SET NOT NULL;
--
-- ============================================================
