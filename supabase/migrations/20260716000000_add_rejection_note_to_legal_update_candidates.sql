-- Migration: 0010_add_rejection_note_to_legal_update_candidates
-- Created:   2026-07-16
-- Author:    Neo (database specialist)
--
-- Adds legal_update_candidates.rejection_note — an optional one-line reason
-- Peter can leave when he rejects a legal-update candidate (i.e. sets
-- review_status = 'rejected' in 20260715000000_legal_update_candidate_scan.sql).
--
-- This mirrors topic_suggestions.rejection_note exactly, added in
-- 20260711000000_viral_trend_scan_tracking.sql: nullable TEXT, no default,
-- captured for potential future use — nothing reads it yet.
--
-- Design notes:
--   - Nullable, no default: matches the topic_suggestions precedent. Most
--     rejections may not need a note; only pending -> rejected transitions
--     that want an explanation will ever populate it.
--   - No index: same as topic_suggestions.rejection_note, this is a
--     free-text note, not something ever looked up or filtered on.
--   - No new RLS policy needed: RLS is already enabled at the table level
--     on legal_update_candidates (from 20260715000000_legal_update_candidate_scan.sql)
--     and applies to all columns on that table, including this new one.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- ALTER TABLE: legal_update_candidates
-- Adds the optional rejection reason (same convention as
-- topic_suggestions.rejection_note).
-- ============================================================

ALTER TABLE legal_update_candidates
  ADD COLUMN rejection_note TEXT;

COMMENT ON COLUMN legal_update_candidates.rejection_note IS
  'Optional one-line reason Peter gives when rejecting a legal-update candidate. Captured for potential future use; no logic consumes it yet.';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- ALTER TABLE legal_update_candidates DROP COLUMN IF EXISTS rejection_note;
--
-- ============================================================
