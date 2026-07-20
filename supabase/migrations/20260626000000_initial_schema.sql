-- Migration: 0001_initial_schema
-- Created:   2026-06-26
-- Author:    Neo (database specialist)
--
-- Establishes the 5 core tables shared by all Rincon Management tools.
-- RLS is enabled on every table and locked down by default.
-- No permissive policies are defined here — they will be added per-tool
-- as authentication is wired up.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ------------------------------------------------------------
-- TRIGGER FUNCTION — auto-update updated_at on every row write
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- TABLE: properties
-- What it stores: the buildings Peter manages.
-- RLS: enabled, locked by default. Access policies added per-tool.
-- ============================================================

CREATE TABLE properties (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,           -- e.g. "Sunset Apartments"
  address      TEXT NOT NULL,
  city         TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'CA',
  zip          TEXT NOT NULL,
  unit_count   INTEGER NOT NULL CHECK (unit_count > 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_properties_updated_at
  BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TABLE: units
-- What it stores: individual rentable units within a property.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE units (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  unit_number    TEXT NOT NULL,          -- e.g. "101", "A", "2B"
  bedrooms       INTEGER NOT NULL CHECK (bedrooms >= 0),
  bathrooms      NUMERIC(3,1) NOT NULL CHECK (bathrooms >= 0),
  sqft           INTEGER,               -- nullable — not always known
  monthly_rent   NUMERIC(10,2) NOT NULL CHECK (monthly_rent >= 0),
  status         TEXT NOT NULL DEFAULT 'vacant'
                   CHECK (status IN ('occupied','vacant','notice','maintenance')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE units ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_units_property_id ON units(property_id);
CREATE INDEX idx_units_status ON units(status);

CREATE TRIGGER trg_units_updated_at
  BEFORE UPDATE ON units
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TABLE: tenants
-- What it stores: contact information only.
-- NOT stored: SSNs, bank accounts, passwords, or any protected-class
-- data (race, religion, sex, national origin, familial status,
-- disability, source of income, sexual orientation, gender identity,
-- marital status, age, military status, immigration status,
-- primary language). Fair Housing compliance requires these fields
-- never appear here.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE tenants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name   TEXT NOT NULL,
  last_name    TEXT NOT NULL,
  email        TEXT,                    -- nullable — not always provided
  phone        TEXT,                    -- nullable — not always provided
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
-- Tenant PII is particularly sensitive — policies here must be narrow.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TABLE: leases
-- What it stores: the agreement connecting a tenant to a unit
-- for a specific time period.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE leases (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id        UUID NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  lease_start    DATE NOT NULL,
  lease_end      DATE NOT NULL,
  monthly_rent   NUMERIC(10,2) NOT NULL CHECK (monthly_rent >= 0),
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('active','expired','pending','terminated')),
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT lease_dates_valid CHECK (lease_end > lease_start)
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE leases ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_leases_unit_id    ON leases(unit_id);
CREATE INDEX idx_leases_tenant_id  ON leases(tenant_id);
CREATE INDEX idx_leases_status     ON leases(status);
CREATE INDEX idx_leases_lease_end  ON leases(lease_end);  -- renewal reminders

CREATE TRIGGER trg_leases_updated_at
  BEFORE UPDATE ON leases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TABLE: maintenance_requests
-- What it stores: work orders tied to a unit.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE maintenance_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id        UUID NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  title          TEXT NOT NULL,         -- short description, e.g. "Leaking faucet"
  description    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','assigned','in_progress','completed','closed')),
  priority       TEXT NOT NULL DEFAULT 'medium'
                   CHECK (priority IN ('low','medium','high','urgent')),
  vendor_name    TEXT,                  -- nullable until assigned
  cost           NUMERIC(10,2),         -- nullable until work is invoiced
  completed_at   TIMESTAMPTZ,           -- nullable until resolved
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE maintenance_requests ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_maintenance_unit_id  ON maintenance_requests(unit_id);
CREATE INDEX idx_maintenance_status   ON maintenance_requests(status);
CREATE INDEX idx_maintenance_priority ON maintenance_requests(priority);

CREATE TRIGGER trg_maintenance_updated_at
  BEFORE UPDATE ON maintenance_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP TRIGGER IF EXISTS trg_maintenance_updated_at ON maintenance_requests;
-- DROP TRIGGER IF EXISTS trg_leases_updated_at      ON leases;
-- DROP TRIGGER IF EXISTS trg_tenants_updated_at     ON tenants;
-- DROP TRIGGER IF EXISTS trg_units_updated_at       ON units;
-- DROP TRIGGER IF EXISTS trg_properties_updated_at  ON properties;
--
-- DROP TABLE IF EXISTS maintenance_requests;
-- DROP TABLE IF EXISTS leases;
-- DROP TABLE IF EXISTS tenants;
-- DROP TABLE IF EXISTS units;
-- DROP TABLE IF EXISTS properties;
--
-- DROP FUNCTION IF EXISTS set_updated_at();
--
-- ============================================================
