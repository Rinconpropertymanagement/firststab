-- Migration: 20260803000000_fk_join_columns
-- Adds raw AppFolio parent-ID columns so the sync can store them on first pass,
-- then a second pass resolves them into real UUID foreign keys.

-- units: store the AppFolio property ID from unit_directory
ALTER TABLE units
  ADD COLUMN IF NOT EXISTS appfolio_property_id TEXT;

-- leases: store the AppFolio unit and tenant IDs from occupancy reports
ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS appfolio_unit_id   TEXT;
ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS appfolio_tenant_id TEXT;

-- maintenance_requests: store the AppFolio unit ID from work_order report
ALTER TABLE maintenance_requests
  ADD COLUMN IF NOT EXISTS appfolio_unit_id TEXT;
