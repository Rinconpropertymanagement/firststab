-- ============================================================
-- Migration: 20260720000004_insurance_compliance
-- Created:   2026-07-21
-- Author:    Neo (database specialist)
--
-- Adds insurance compliance tracking to the Rincon Management
-- workflow system. One new table (property_insurance) and one
-- column addition (properties.pod).
--
-- Dependency order:
--   Requires: properties, users, documents, workflow_instances
--   (all established in prior migrations)
--
-- Design decisions:
--   - Multiple rows per property are allowed (policy history).
--     Only one row per property may have is_current = true.
--     Enforced by a partial unique index on appfolio_property_id
--     WHERE is_current = true.
--   - appfolio_property_id is used as the primary join key (text)
--     alongside the UUID property_id FK, consistent with how
--     property_owners handles the sync-before-UUID-match problem.
--   - The two manual verification fields (additional_insured_verified
--     and coverage_amount_verified) default to false and are only
--     set to true by a property manager via the review form.
--     The system never sets these to true automatically.
--   - Status transitions:
--       pending_review  -> compliant       (PM saves verified form)
--       compliant       -> expiring_soon   (nightly job, <=30 days)
--       compliant /
--       expiring_soon   -> expired         (nightly job, expiration_date <= today)
--       any             -> no_policy       (manual override, not set by automation)
--
-- RLS: enabled, locked by default on property_insurance.
--      properties.pod does not change RLS on that table.
--
-- Rollback: see DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- ALTER TABLE properties -- add pod column
-- Pod assignment is required for dashboard filtering and for
-- the nightly monitor to look up the correct property manager.
-- Pod is nullable: properties not yet assigned to a pod show
-- as NULL and are visible to all roles on the dashboard.
-- Valid values match the users.pod check constraint.
-- ============================================================

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS pod TEXT CHECK (pod IN ('Solimar', 'Faria'));


-- ============================================================
-- TABLE: property_insurance
-- What it stores: one row per insurance policy per property.
-- Only one row per property may have is_current = true --
-- enforced by the partial unique index below.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS property_insurance (
  id                          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Property linkage (dual-key, same pattern as property_owners)
  property_id                 UUID         REFERENCES properties(id) ON DELETE RESTRICT,
  -- nullable: set once the UUID is confirmed; rows from the import
  -- script may have only appfolio_property_id initially

  appfolio_property_id        TEXT,
  -- matches properties.appfolio_id; used by import and nightly sync
  -- before UUID match is confirmed

  -- Policy fields (extracted by Claude AI, corrected by PM)
  policy_number               TEXT,
  insurer_name                TEXT,
  effective_date              DATE,
  expiration_date             DATE,
  coverage_amount             NUMERIC(12,2),  -- dollar value, e.g. 1000000.00
  named_insured               TEXT,           -- owner name as printed on the policy
  property_address_on_policy  TEXT,           -- address as printed on the policy

  -- Manual verification (PM checks these boxes -- never set by automation)
  additional_insured_verified BOOLEAN      NOT NULL DEFAULT false,
  coverage_amount_verified    BOOLEAN      NOT NULL DEFAULT false,
  verified_by                 UUID         REFERENCES users(id),
  verified_at                 TIMESTAMPTZ,

  -- Status
  status                      TEXT         NOT NULL DEFAULT 'pending_review'
                                             CHECK (status IN (
                                               'pending_review',
                                               'compliant',
                                               'expiring_soon',
                                               'expired',
                                               'no_policy'
                                             )),

  -- History / current flag
  -- true = this is the active policy for this property
  -- set to false when a new policy is uploaded to replace it
  is_current                  BOOLEAN      NOT NULL DEFAULT true,

  -- Document link
  document_id                 UUID         REFERENCES documents(id),

  -- Optional free-text notes from PM during review
  notes                       TEXT,

  -- Workflow linkage
  workflow_instance_id        UUID         REFERENCES workflow_instances(id),

  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- RLS: enabled, no permissive policies -- all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE property_insurance ENABLE ROW LEVEL SECURITY;


-- ============================================================
-- INDEXES
-- ============================================================

-- Core lookup: find the current policy for a property by UUID
CREATE INDEX IF NOT EXISTS idx_pi_property_id
  ON property_insurance(property_id)
  WHERE property_id IS NOT NULL;

-- Core lookup: find the current policy by AppFolio ID (import, sync)
CREATE INDEX IF NOT EXISTS idx_pi_appfolio_property_id
  ON property_insurance(appfolio_property_id)
  WHERE appfolio_property_id IS NOT NULL;

-- Nightly monitor: scan all current policies by expiration date
CREATE INDEX IF NOT EXISTS idx_pi_expiration_date
  ON property_insurance(expiration_date)
  WHERE is_current = true;

-- Dashboard filter: filter by status
CREATE INDEX IF NOT EXISTS idx_pi_status
  ON property_insurance(status);

-- History queries: find all policies for a property
CREATE INDEX IF NOT EXISTS idx_pi_property_history
  ON property_insurance(appfolio_property_id, created_at DESC)
  WHERE appfolio_property_id IS NOT NULL;


-- ============================================================
-- PARTIAL UNIQUE INDEX -- one current policy per property
-- Enforces: at most one row with is_current = true per
-- appfolio_property_id. Rows with is_current = false (history)
-- are unconstrained.
--
-- When uploading a new policy, the application must set
-- is_current = false on the previous row BEFORE inserting the
-- new row, or the insert will fail this constraint.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_one_current_per_property
  ON property_insurance(appfolio_property_id)
  WHERE is_current = true AND appfolio_property_id IS NOT NULL;


-- ============================================================
-- TRIGGER -- auto-update updated_at
-- ============================================================

DROP TRIGGER IF EXISTS trg_property_insurance_updated_at ON property_insurance;
CREATE TRIGGER trg_property_insurance_updated_at
  BEFORE UPDATE ON property_insurance
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- ROLLBACK (run in order to undo this migration)
-- ============================================================
--
-- DROP TRIGGER IF EXISTS trg_property_insurance_updated_at ON property_insurance;
--
-- DROP INDEX IF EXISTS idx_pi_one_current_per_property;
-- DROP INDEX IF EXISTS idx_pi_property_history;
-- DROP INDEX IF EXISTS idx_pi_status;
-- DROP INDEX IF EXISTS idx_pi_expiration_date;
-- DROP INDEX IF EXISTS idx_pi_appfolio_property_id;
-- DROP INDEX IF EXISTS idx_pi_property_id;
--
-- DROP TABLE IF EXISTS property_insurance;
--
-- ALTER TABLE properties DROP COLUMN IF EXISTS pod;
--
-- ============================================================
