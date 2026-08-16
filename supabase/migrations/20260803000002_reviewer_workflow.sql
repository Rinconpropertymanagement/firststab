-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Reviewer workflow for property_insurance
-- Adds columns for PM review and DO escalation, plus 'escalated' status.
-- ─────────────────────────────────────────────────────────────────────────────

-- New columns on property_insurance
ALTER TABLE property_insurance
  ADD COLUMN IF NOT EXISTS reviewed_by        TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escalated_by       TEXT,
  ADD COLUMN IF NOT EXISTS escalated_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewer_notes     TEXT,
  ADD COLUMN IF NOT EXISTS ai_suggested_status TEXT;

-- Update status constraint to include 'escalated'
-- (DROP first because PostgreSQL requires it before re-adding with new values)
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
    'no_additional_insured',
    'escalated'
  ));
