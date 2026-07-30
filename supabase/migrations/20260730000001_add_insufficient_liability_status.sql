-- Migration: 20260730000001_add_insufficient_liability_status
-- Adds 'insufficient_liability' to the property_insurance status CHECK constraint.
-- Used when premises liability coverage is below the $500,000 minimum.

ALTER TABLE property_insurance
  DROP CONSTRAINT IF EXISTS property_insurance_status_check;

ALTER TABLE property_insurance
  ADD CONSTRAINT property_insurance_status_check
  CHECK (status IN (
    'pending_review',
    'compliant',
    'expiring_soon',
    'expired',
    'no_policy',
    'insufficient_liability'
  ));
