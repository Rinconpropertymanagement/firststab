-- ============================================================
-- Migration: 20260929010000_add_manual_staff_to_complaints_discovery_context_check
-- Created:   2026-09-29
--
-- Real production bug, found live by Peter testing the "Report an Issue"
-- form for the first time today: every submission failed with
--   null value in column "discovery_context" of relation "complaints"
--   violates not-null constraint
--
-- Root cause: `complaints.discovery_context` was added later
-- (20260913020000_archive_search_significance_complaint_merge_schema.sql,
-- as part of the significance-pass engine swap) as NOT NULL, restricted to
-- exactly two values: 'live_pipeline' and 'historical_backfill' — both
-- describing WHICH AI SCAN found the conversation. Neither describes a
-- complaint a staff member typed by hand. The manual-report insert path
-- (complaint-tracking/router.js's POST /api/complaint-tracking/report)
-- predates that migration and was never updated to set this column when
-- it was added — the form has been broken since that migration landed,
-- silently, until today.
--
-- Fix: widen the CHECK constraint by exactly one value, 'manual_staff' —
-- already the established name for this exact case (the same insert row
-- already sets `source: 'manual_staff'`, right next to the missing
-- discovery_context field). Same DROP-then-ADD pattern already used
-- repeatedly in this schema for this kind of additive widening.
--
-- Confirmed safe: no other code checks discovery_context = 'manual_staff'
-- specifically, so this cannot change behavior for any existing
-- 'live_pipeline'/'historical_backfill' row. The one CHECK constraint that
-- references discovery_context (complaints_needing_config_or_backfill,
-- ~line 565 of the schema migration: "held_legal_fair_housing = TRUE OR
-- discovery_context = 'historical_backfill' OR complaint_tracking_config_id
-- IS NOT NULL") is already satisfied for manual reports regardless of this
-- change, since that insert path always sets complaint_tracking_config_id.
-- The one partial index scoped to discovery_context = 'live_pipeline'
-- (idx_complaints_needing_attention) simply won't match manual_staff rows
-- either way — same as it already didn't match historical_backfill rows,
-- not a new behavior this migration introduces.
-- ============================================================

ALTER TABLE complaints
  DROP CONSTRAINT IF EXISTS complaints_discovery_context_check;

ALTER TABLE complaints
  ADD CONSTRAINT complaints_discovery_context_check
  CHECK (discovery_context IN ('live_pipeline', 'historical_backfill', 'manual_staff'));

-- ============================================================
-- ROLLBACK (only safe if no row currently has discovery_context = 'manual_staff')
-- ============================================================
--
-- ALTER TABLE complaints
--   DROP CONSTRAINT IF EXISTS complaints_discovery_context_check;
-- ALTER TABLE complaints
--   ADD CONSTRAINT complaints_discovery_context_check
--   CHECK (discovery_context IN ('live_pipeline', 'historical_backfill'));
--
-- ============================================================
