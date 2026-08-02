-- Migration: 20260802000000_add_no_additional_insured_status
-- Adds 'no_additional_insured' to the property_insurance status CHECK constraint.
-- Used when Rincon Management is not listed as additional insured on the policy.

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
    'insufficient_liability',
    'no_additional_insured'
  ));
