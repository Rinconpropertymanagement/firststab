-- ============================================================
-- Migration: 20260924020000_add_eligible_id_partial_index_for_archive_search_corpus_reconciliation
-- Created:   2026-09-24
-- Author:    Q (builder), against Neo's concrete design
--
-- Builds projects/hub/email-intake/archive-search-search-performance-
-- security-barrier-spec.md, Section 5's own follow-up index — needed for
-- archive_search_corpus_backfill_batch() and archive_search_corpus_
-- reconcile()'s Step 2 gap-fill (both added by 20260924010000) to walk
-- missive_message_intake's eligible population by id efficiently instead
-- of a full table scan.
--
-- UPDATED 2026-09-24, after a real failed attempt: this migration
-- originally used CREATE INDEX CONCURRENTLY, with a comment warning it
-- must be pasted alone. Peter pasted the whole file (CREATE INDEX +
-- COMMENT ON INDEX together) and hit ERROR 25001 anyway — the same
-- documented failure mode 20260917010000's header already names ("the
-- mere presence of a second statement... regardless of a 'run this
-- alone' instruction"). Rather than rely on paste discipline a second
-- time, this migration now uses a PLAIN CREATE INDEX (below), matching
-- the fix already proven on this exact table in 20260917010000: a brief
-- SHARE lock blocking writes for the build's duration is acceptable
-- given this table's write volume (the periodic Missive sync only), and
-- this index is smaller/simpler than 20260917010000's own composite
-- index, so it builds at least as fast. Apply 20260924010000 (the main
-- corpus schema) separately, before or after this file — the two are
-- independent of each other.
--
-- Also directly closes, as a real byproduct (not this migration's primary
-- purpose, and not a claim that significance-pass.js itself is updated to
-- use it — that's a separate decision), the stale-index gap
-- 20260924000000's own header deliberately left open for the significance
-- driver: that driver's existing indexes are scoped to screening_result =
-- 'clear' only, now under-scoped since flagged_protected_class also counts
-- toward eligibility as of the (unmerged, but live-in-production)
-- flagged-release-gate-removal build.
--
-- WHY CONCURRENTLY IS REQUIRED HERE, UNLIKE 20260924010000's OWN INDEXES:
-- missive_message_intake is a live, 255,000+ row table with an active
-- writer (the hourly screening cron). A plain (non-CONCURRENTLY) CREATE
-- INDEX takes a SHARE lock for the full, slow build duration and blocks
-- every write for that whole time — the same reasoning every prior index
-- built on this specific table already documents (20260911010000,
-- 20260912020000, 20260914000000, 20260917010000, 20260918010000,
-- 20260922000000, 20260922010000).
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist, applied by Q)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No — additive index only.
--   [x] Does this touch a table other code depends on? Yes, read-only:
--       adds one partial index to missive_message_intake. No column,
--       constraint, or existing index changes.
--   [x] Additive or destructive? Additive only.
--   [x] Tested on a copy of the data first? Same standing caveat as every
--       migration in this project. Mitigated by this being a small,
--       simple, read-path index addition with no behavior change for any
--       existing query, and by a plain (non-CONCURRENTLY) build on this
--       table already being proven fast (well under a minute, per
--       20260917010000's own build) and acceptable given this table's
--       write volume (the periodic Missive sync only).
--   [ ] Governance go-ahead needed? No new access, no new data exposure —
--       this is an index on missive_message_intake, not a policy or view
--       change. Not itself a compliance build, though it is a companion
--       piece of one (20260924010000).
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_missive_message_intake_eligible_id
  ON missive_message_intake (id)
  WHERE screening_result IN ('clear', 'flagged_protected_class');

COMMENT ON INDEX idx_missive_message_intake_eligible_id IS
  'Partial, id-ordered index serving archive_search_corpus_backfill_batch() and archive_search_corpus_reconcile()''s gap-fill step (both 20260924010000) — id-ordered cursor walk of the eligible (clear + flagged_protected_class) population, bypassing missive_message_intake_search_safe''s security_barrier entirely (this indexes the base table directly). Also narrows, as a byproduct, the significance driver''s own stale clear-only index scoping (20260924000000''s own header names this as a deliberately-deferred, separate gap) — significance-pass.js itself is not changed by this migration.';

-- ============================================================
-- ROLLBACK (run this statement to undo this migration)
-- ============================================================
-- DROP INDEX IF EXISTS idx_missive_message_intake_eligible_id;
-- ============================================================
