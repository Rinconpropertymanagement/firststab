-- Migration: 20260721000000_add_inspections_coordinator
-- Created:   2026-07-21
-- Author:    Neo (database specialist)
--
-- Adds Inspections Coordinator to the users.role CHECK constraint.
-- Ray Campos (ray@rinconmanagement.com) is inserted as the first holder
-- of this role. Role sits under Operations, no pod assignment.
-- ============================================================

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN (
  'CEO',
  'Director of Operations',
  'Project Manager / Bookkeeper',
  'Property Manager',
  'Maintenance Coordinator',
  'Transaction Coordinator',
  'Resident Services Coordinator',
  'Inspections Coordinator',
  'Business Development Manager',
  'Business Development Coordinator',
  'Marketing Coordinator'
));
