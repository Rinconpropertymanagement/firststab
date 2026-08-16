-- Migration: 20260808000000_add_structural_flag_scan_to_detected_by
-- Created:   2026-08-08
-- Author:    Neo (database specialist)
--
-- Widens legal_claim_reviews.detected_by to also allow 'structural_flag_scan'.
--
-- Context: 20260801000000_legal_claim_reviews.sql named exactly two detector
-- layers ('pattern_match', 'ai_comprehension') and said explicitly in its
-- design notes that a third layer was not yet planned, but that "a
-- follow-on migration can widen it if a third layer is ever added." Q is
-- now adding that third layer: a deterministic, non-AI final safety scan
-- that catches any [LEGAL CLAIM PENDING REVIEW: ...] flag left in an
-- article body that the first two detectors missed. 'structural_flag_scan'
-- is tagged as its own distinct value (not folded into 'pattern_match')
-- specifically so the data shows which layer actually caught each claim —
-- this backstop's hit rate is a monitoring signal for whether the first two
-- layers are reliable enough on their own.
--
-- This migration ONLY widens the detected_by CHECK constraint. It does not
-- touch RLS, any other column, any other table, or remove/rename either of
-- the two existing allowed values — both 'pattern_match' and
-- 'ai_comprehension' remain valid exactly as before.
--
-- Constraint name: legal_claim_reviews_detected_by_check is the Postgres
-- default auto-generated name for an unnamed inline CHECK on
-- detected_by (declared inline in 20260801000000, no explicit CONSTRAINT
-- name given) — i.e. "<table>_<column>_check". This matches the same
-- drop-and-recreate-by-default-name pattern already used in this codebase
-- for widening a CHECK constraint (see 20260730000001_add_insufficient_
-- liability_status.sql and 20260802000000_add_no_additional_insured_
-- status.sql, both against property_insurance_status_check).
--
-- Safety notes:
--   - Purely additive: every row currently satisfying the old constraint
--     (detected_by IN ('pattern_match', 'ai_comprehension')) still
--     satisfies the new one. No existing row can be invalidated by this
--     change, and no backfill is needed.
--   - Nothing else reads detected_by as an exhaustive/enumerated list on
--     the application side (checked lib/draft.js, lib/revise.js,
--     lib/legal-review.js, and the content-engine test scripts) — it is
--     passed straight through as a string, so this widening does not
--     require any code change to stay valid.
--
-- Rollback: see the bottom of this file. Rollback is only safe if no row
-- has been written with detected_by = 'structural_flag_scan' yet — see the
-- rollback note below.
-- ============================================================

ALTER TABLE legal_claim_reviews
  DROP CONSTRAINT IF EXISTS legal_claim_reviews_detected_by_check;

ALTER TABLE legal_claim_reviews
  ADD CONSTRAINT legal_claim_reviews_detected_by_check
  CHECK (detected_by IN (
    'pattern_match',
    'ai_comprehension',
    'structural_flag_scan'
  ));


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- Only safe to run if no row has detected_by = 'structural_flag_scan' —
-- otherwise the narrower constraint will fail to apply against existing
-- data. Check first:
--   SELECT count(*) FROM legal_claim_reviews WHERE detected_by = 'structural_flag_scan';
--
-- ALTER TABLE legal_claim_reviews
--   DROP CONSTRAINT IF EXISTS legal_claim_reviews_detected_by_check;
--
-- ALTER TABLE legal_claim_reviews
--   ADD CONSTRAINT legal_claim_reviews_detected_by_check
--   CHECK (detected_by IN ('pattern_match', 'ai_comprehension'));
--
-- ============================================================
