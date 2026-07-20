-- Migration: 20260720000002_owners
-- Created:   2026-07-20
-- Author:    Neo (database specialist)
--
-- Adds two tables that support owner reporting and the AppFolio owner sync:
--
--   owners          — one row per unique property owner (contact details, total units)
--   property_owners — junction table linking owners to the properties they own
--
-- Design notes:
--   - appfolio_id on owners is NOT NULL; the partial unique index (WHERE appfolio_id
--     IS NOT NULL) is added for consistency with the rest of the schema, alongside
--     an explicit UNIQUE CONSTRAINT required by the Supabase REST API for ON CONFLICT
--     upsert operations.
--   - property_owners carries no FK constraints to properties or owners. AppFolio
--     IDs are used directly as the join key so the nightly sync can write
--     property_owners rows regardless of the order tables are populated.
--   - RLS is enabled on both tables and locked down by default. No permissive
--     policies are defined here — they will be added per-tool as auth is wired up.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- TABLE: owners
-- What it stores: one row per property owner (name, contact, total unit count).
-- RLS: enabled, locked by default. Access policies added per-tool.
-- ============================================================

CREATE TABLE owners (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appfolio_id  TEXT NOT NULL,           -- AppFolio's numeric owner ID (stored as text)
  name         TEXT,                    -- full name, nullable
  phone        TEXT,                    -- nullable
  email        TEXT,                    -- nullable — not available in current AppFolio report
  total_units  INTEGER,                 -- total units owned across all properties, nullable
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE owners ENABLE ROW LEVEL SECURITY;

-- Partial unique index: consistent with the rest of the schema.
-- Since appfolio_id is NOT NULL, this is equivalent to a full unique index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_owners_appfolio_id
  ON owners(appfolio_id)
  WHERE appfolio_id IS NOT NULL;

-- Explicit unique constraint: required for Supabase REST API ON CONFLICT upserts.
ALTER TABLE owners
  ADD CONSTRAINT owners_appfolio_id_unique UNIQUE (appfolio_id);

CREATE TRIGGER trg_owners_updated_at
  BEFORE UPDATE ON owners
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TABLE: property_owners
-- What it stores: which owners are linked to which properties, and how
-- many units each owner holds at that property.
-- No FK constraints — AppFolio IDs are used directly so the sync can
-- write rows in any order without worrying about referential integrity.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE property_owners (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appfolio_property_id TEXT NOT NULL,   -- matches properties.appfolio_id
  appfolio_owner_id    TEXT NOT NULL,   -- matches owners.appfolio_id
  unit_count           INTEGER,         -- units at this property owned by this owner, nullable
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (appfolio_property_id, appfolio_owner_id)  -- one row per property-owner pair
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE property_owners ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_property_owners_property_id ON property_owners(appfolio_property_id);
CREATE INDEX idx_property_owners_owner_id    ON property_owners(appfolio_owner_id);

CREATE TRIGGER trg_property_owners_updated_at
  BEFORE UPDATE ON property_owners
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP TRIGGER IF EXISTS trg_property_owners_updated_at ON property_owners;
-- DROP TRIGGER IF EXISTS trg_owners_updated_at          ON owners;
--
-- DROP INDEX IF EXISTS idx_property_owners_owner_id;
-- DROP INDEX IF EXISTS idx_property_owners_property_id;
-- DROP INDEX IF EXISTS idx_owners_appfolio_id;
--
-- DROP TABLE IF EXISTS property_owners;
-- DROP TABLE IF EXISTS owners;
--
-- ============================================================
