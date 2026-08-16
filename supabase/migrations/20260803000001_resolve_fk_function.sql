-- Migration: 20260803000001_resolve_fk_function
-- Creates a stored procedure that resolves AppFolio foreign keys in one shot.
-- Called at the end of every sync run.

CREATE OR REPLACE FUNCTION resolve_appfolio_foreign_keys()
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  units_linked   INT;
  leases_units   INT;
  leases_tenants INT;
  mr_units       INT;
BEGIN
  -- 1. units.property_id — match on appfolio_property_id → properties.appfolio_id
  UPDATE units u
  SET property_id = p.id
  FROM properties p
  WHERE u.appfolio_property_id = p.appfolio_id
    AND u.appfolio_property_id IS NOT NULL
    AND u.property_id IS DISTINCT FROM p.id;
  GET DIAGNOSTICS units_linked = ROW_COUNT;

  -- 2. leases.unit_id — match on appfolio_unit_id → units.appfolio_id
  UPDATE leases l
  SET unit_id = u.id
  FROM units u
  WHERE l.appfolio_unit_id = u.appfolio_id
    AND l.appfolio_unit_id IS NOT NULL
    AND l.unit_id IS DISTINCT FROM u.id;
  GET DIAGNOSTICS leases_units = ROW_COUNT;

  -- 3. leases.tenant_id — match on appfolio_tenant_id → tenants.appfolio_id
  UPDATE leases l
  SET tenant_id = t.id
  FROM tenants t
  WHERE l.appfolio_tenant_id = t.appfolio_id
    AND l.appfolio_tenant_id IS NOT NULL
    AND l.tenant_id IS DISTINCT FROM t.id;
  GET DIAGNOSTICS leases_tenants = ROW_COUNT;

  -- 4. maintenance_requests.unit_id — match on appfolio_unit_id → units.appfolio_id
  UPDATE maintenance_requests mr
  SET unit_id = u.id
  FROM units u
  WHERE mr.appfolio_unit_id = u.appfolio_id
    AND mr.appfolio_unit_id IS NOT NULL
    AND mr.unit_id IS DISTINCT FROM u.id;
  GET DIAGNOSTICS mr_units = ROW_COUNT;

  RETURN jsonb_build_object(
    'units_linked',    units_linked,
    'leases_units',    leases_units,
    'leases_tenants',  leases_tenants,
    'mr_units',        mr_units
  );
END;
$$;
