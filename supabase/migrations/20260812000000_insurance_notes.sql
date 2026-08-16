-- Migration: Per-policy notes for the insurance compliance system
-- Stores timestamped team notes attached to a specific insurance record.

CREATE TABLE IF NOT EXISTS insurance_notes (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  insurance_id UUID        NOT NULL REFERENCES property_insurance(id) ON DELETE CASCADE,
  note         TEXT        NOT NULL,
  created_by   TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS insurance_notes_insurance_id_idx ON insurance_notes(insurance_id);
