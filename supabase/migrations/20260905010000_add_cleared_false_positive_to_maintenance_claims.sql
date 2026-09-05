-- ============================================================
-- Migration: 20260905010000_add_cleared_false_positive_to_maintenance_claims
-- Created:   2026-09-05
-- Author:    Neo (database specialist)
--
-- Part of the Content-Screening Precision Redesign (Tier A / Tier B)
-- for Rincon's Fair Housing maintenance-content screening.
-- Spec: projects/hub/maintenance-history/content-screening-tier-redesign-SPEC.md,
-- Section 5 ("Data Model — What Gets Logged Where") and Section 6
-- ("Two-Way Human Override"). This is the ONLY schema change the spec
-- requires (Section 11, item 2) — everything else in the redesign
-- (the Tier A/B classifier, the kill switch, audit_log writes, the new
-- applyReviewAction actions) is application code, owned by Q.
--
-- Governance trail (all resolved before this file was written, per the
-- spec's own header): real outside counsel opinion (GREEN verdict,
-- 2026-09-05), Mason's technical sanity-check (2026-09-05, five
-- corrections applied), Asimov's technical sanity-check (2026-09-05,
-- four required changes applied), Peter's go-ahead to build.
-- ============================================================
-- WHY THIS VALUE, AND WHY NOT REUSE AN EXISTING ONE
-- ============================================================
-- Section 6's new `clear_flag` review action needs a review_status value
-- meaning "this flag was determined to be wrong and reversed." None of
-- today's four values fit:
--   - 'unreviewed' / 'rejected' — unrelated meanings.
--   - 'corrected'  — already means "the claim's own claim_text was
--     edited," a different fact. Overloading it to also mean "the flag
--     itself was wrong" would blur two distinct events behind one label
--     in a compliance-sensitive column — the spec is explicit this is
--     exactly what to avoid.
-- 'cleared_false_positive' is a new, distinct value naming the actual
-- event: a human determined the protected-class flag was a false
-- positive and cleared it.
--
-- The other override direction (staff manually flagging an AI-cleared
-- item, Section 6's new `flag` action) does NOT need a new value —
-- 'confirmed' already means "a human looked at this and confirmed a
-- flag belongs here," which fits that action's meaning as-is. No schema
-- change needed for that direction.
--
-- No change to maintenance_claims_flag_requires_category: that
-- constraint only requires flagged_category whenever
-- flagged_protected_class = TRUE, and `clear_flag` sets
-- flagged_protected_class -> FALSE while deliberately leaving
-- flagged_category in place as historical record (Section 6) — already
-- valid under the existing constraint, confirmed in the spec, no change
-- needed here.
-- ============================================================
-- CURRENT STATE CHECK — restated in full below (Postgres requires the
-- complete list on every DROP-then-ADD; there is no ALTER CONSTRAINT to
-- widen a CHECK in place). Current 4 values, from
-- 20260815010000_maintenance_history_schema.sql, confirmed unchanged by
-- any migration since (no other file in supabase/migrations references
-- the constraint name maintenance_claims_review_status_check):
-- 'unreviewed', 'confirmed', 'corrected', 'rejected'. This migration
-- adds one value, 'cleared_false_positive', alongside them — the same
-- DROP-then-ADD CHECK-widen pattern already used twice on this schema's
-- team_member_tool_roles constraints (e.g. 20260902020000_add_
-- maintenance_coordinator_role.sql).
-- ============================================================

ALTER TABLE maintenance_claims
  DROP CONSTRAINT IF EXISTS maintenance_claims_review_status_check;

ALTER TABLE maintenance_claims
  ADD CONSTRAINT maintenance_claims_review_status_check
  CHECK (review_status IN (
    'unreviewed',
    'confirmed',
    'corrected',
    'rejected',
    'cleared_false_positive'
  ));

-- No seed/backfill UPDATE in this migration. This migration only makes
-- review_status = 'cleared_false_positive' legal to write — the actual
-- clear_flag action (Section 6) and its application-code gating
-- (PRIVACY_REVIEW_ROLES, requireAcknowledgment, non-empty reviewer_notes)
-- are Q's to build, not this migration's concern.

-- ============================================================
-- MIGRATION GATE (Neo's standard checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] No existing data is deleted or overwritten — additive CHECK
--       widening only; every row's existing review_status value
--       (unreviewed/confirmed/corrected/rejected) remains valid and is
--       untouched. No UPDATE statement in this migration.
--   [x] Touches maintenance_claims, which application code (router.js's
--       applyReviewAction, the flagged-queue and bulk-review routes, and
--       maintenance_claims_decision_safe) depends on — but only widens
--       the CHECK constraint on review_status; no column is added,
--       renamed, or removed, no existing constraint value is removed,
--       and no default changes. Existing queries and views keep working
--       unmodified. maintenance_claims_decision_safe already reads
--       flagged_protected_class = FALSE AND review_status != 'rejected'
--       — a row with the new value passes that filter correctly with no
--       view change needed, per spec Section 6.
--   [x] Additive, not destructive — one new legal value added to a CHECK
--       constraint.
--   [ ] Tested on a copy of Supabase before production apply — no
--       staging copy exists in this project, same standing caveat noted
--       on every migration in this schema to date. Per project
--       convention, Peter applies this himself via Supabase's SQL Editor.
--   [x] Governance: outside counsel opinion (GREEN), Mason's and
--       Asimov's technical sanity-checks, and Peter's go-ahead are all
--       recorded in content-screening-tier-redesign-SPEC.md's header as
--       complete before this file was written.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- -- Only safe if no row has been written with review_status =
-- -- 'cleared_false_positive' yet (a clear_flag action will have used
-- -- this value going forward once Q's application code ships) — reassign
-- -- or otherwise handle any such row first, or the DROP-then-ADD below
-- -- will fail with a constraint violation.
-- ALTER TABLE maintenance_claims
--   DROP CONSTRAINT IF EXISTS maintenance_claims_review_status_check;
-- ALTER TABLE maintenance_claims
--   ADD CONSTRAINT maintenance_claims_review_status_check
--   CHECK (review_status IN (
--     'unreviewed',
--     'confirmed',
--     'corrected',
--     'rejected'
--   ));
--
-- ============================================================
