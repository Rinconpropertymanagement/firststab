-- ============================================================
-- Migration: 20261002070000_add_retroactive_name_match_checked_at_to_complaints
-- Created:   2026-10-02
-- Author:    Neo (database specialist)
--
-- One new nullable column on `complaints`, to fix a real resumability gap
-- in a retroactive batch tool Q is about to build (relayed via Jarvis).
-- No standalone Oracle spec file exists for this one either — same gap
-- this table's prior two migrations (20261002010000, 20261002060000) each
-- already flagged for their own builds; flagged again here rather than
-- silently filled.
--
-- ============================================================
-- THE GAP (why NULL already in use for "unmatched" isn't enough here)
-- ============================================================
-- 20261002060000 added suggested_subject_type/_name_text/_candidate_ids/
-- _extracted_by/_at to `complaints`, all five NULL together unless a real
-- name-match candidate was found (complaints_suggested_subject_fields_
-- together + complaints_suggested_subject_candidates_nonempty). That is
-- exactly right for the LIVE pipeline, where Call 1 runs exactly once per
-- conversation, ever — a complaint that gets no candidate just stays NULL
-- forever, because nothing will ever re-check that same complaint again.
-- There is no resumability problem to solve there.
--
-- The retroactive batch tool Q is about to build is different in exactly
-- the way that breaks that assumption: it has to process the ~1,800+
-- existing complaints where needs_matching = TRUE, re-reading already-
-- stored email content looking for a property-corroborated name match, in
-- a tool that gets re-run (crash, rate limit, chunking — same shape as
-- severity-batch.js's own resumable design, archive-search/lib/severity-
-- batch.js, which this tool is modeled on per the task brief). If a
-- complaint is checked and NO candidate is found, suggested_subject_type
-- stays NULL — which is INDISTINGUISHABLE, with today's schema, from
-- "this row has never been looked at by the retroactive tool at all."
-- Every re-run would therefore re-process (and re-bill, since this makes
-- real Anthropic API calls per the severity-batch precedent) every
-- no-match row, forever, instead of converging toward zero like severity-
-- batch.js's own severity_tier IS NULL signal does.
--
-- ============================================================
-- THE FIX — one new column, deliberately NOT part of the existing lockstep
-- group
-- ============================================================
-- retroactive_name_match_checked_at (TIMESTAMPTZ, nullable, no default):
-- set by the retroactive batch tool on EVERY complaint it examines,
-- regardless of outcome. `retroactive_name_match_checked_at IS NULL`
-- becomes that tool's own resumability signal — the exact role
-- severity_tier IS NULL plays for severity-batch.js (fetchUnassessedComplaints,
-- severity-batch.js line ~170), applied to a tool whose real output
-- (suggested_subject_*) cannot itself serve that role because a real
-- no-match outcome is supposed to look like "nothing," not like an error.
--
-- Checked directly against complaints_suggested_subject_fields_together
-- (20261002060000) before writing this, per the task's own instruction not
-- to assume its shape: that CHECK forces suggested_subject_type/_name_text/
-- _candidate_ids/_extracted_by/_at to be all-NULL or all-set, together. The
-- new column is DELIBERATELY left out of that group, and out of every
-- other existing CHECK on this table, because the whole point is that it
-- must vary INDEPENDENTLY of the suggestion fields — the task's own two
-- required states:
--   - checked, nothing found:  retroactive_name_match_checked_at SET,
--                              all five suggested_subject_* columns NULL.
--   - checked, candidate found: retroactive_name_match_checked_at SET,
--                                all five suggested_subject_* columns SET.
-- Folding this column into complaints_suggested_subject_fields_together
-- (e.g. requiring it set whenever suggested_subject_type is set, or null
-- whenever suggested_subject_type is null) would make the first state
-- above impossible to represent, since the live pipeline's own suggestions
-- have nothing to do with the retroactive tool having run. No new CHECK
-- ties this column to suggested_subject_type for the same reason
-- complaints_human_confirmed_subject_requires_suggestion ties human review
-- to a suggestion existing but nothing ties a suggestion to this column:
-- the dependency only ever runs one direction, and here there is no
-- dependency at all — this column records a fact about the RETROACTIVE
-- TOOL's own history on this row, not a fact about whether a suggestion
-- exists.
--
-- Also not tied to needs_matching: a row can legitimately be checked by
-- the retroactive tool (retroactive_name_match_checked_at set, in the
-- past) and later have needs_matching flip to FALSE through some other
-- path (e.g. a human resolves it via the UI, or a later address-match
-- backfill resolves it) — that is a true, correct historical record of
-- "the retroactive tool looked at this row on this date," not something a
-- CHECK should retroactively invalidate. Targeting which rows are eligible
-- for a given run is the batch tool's own driver-query job (below), not a
-- database-level invariant.
--
-- ============================================================
-- HELD-ROW EXCLUSION — extending the existing invariant, not inventing a
-- new one
-- ============================================================
-- complaints_held_excludes_ai_fields (widened three times already —
-- 20260913020000 -> 20261002010000 added severity_tier -> 20261002060000
-- added suggested_subject_type) establishes that a held_legal_fair_housing
-- row is a minimal placeholder that never gets run through ANY automated
-- categorization pass. The retroactive batch tool re-reads stored email
-- content and runs the same name-match logic 20261002060000 already
-- cleared for the live pipeline — that is exactly the kind of automated
-- examination a held row must never be subjected to, even just to record
-- "checked, found nothing." Widened again here, same pattern, so a held
-- row cannot get this column set either.
--
-- This is schema-level defense in depth, not a substitute for the
-- application-layer exclusion Q's driver query needs. severity-batch.js's
-- own fetchUnassessedComplaints() already establishes the house pattern
-- for this exact situation (its own comment: "held_legal_fair_housing =
-- false is defense in depth, not reliance on the database CHECK alone...
-- excluded explicitly so this tool never even builds a request for one,
-- rather than building one and relying on the database to reject the
-- eventual write"). Q's retroactive name-match driver query should filter
-- held_legal_fair_housing = FALSE explicitly, the same way, for the same
-- reason — flagged here so it isn't missed, not built here, since this
-- migration is schema only.
--
-- ============================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT BUILD
-- ============================================================
--   - The retroactive batch tool itself (run-name-match-batch.js or
--     equivalent, modeled on run-severity-batch.js / lib/severity-batch.js
--     per the task brief). Q's build, on top of this column.
--   - Any version-tracking column for the retroactive tool's own check
--     (e.g. a "checked under which matching-logic version" sibling column,
--     the same role suggested_subject_extracted_by/severity_rubric_version
--     play elsewhere). Deliberately out of scope — the task explicitly
--     asked for exactly this one column. If a future change to the
--     matching logic ever needs to force a genuine re-check of
--     already-checked rows, that is a new, separate, scoped request, not
--     assumed or pre-built here.
--   - Any change to the eligibility/driver query, the governance gate on
--     actually running this tool against real complaints (same
--     SEVERITY_BATCH_GOVERNANCE_CLEARED-shaped env-var pattern severity-
--     batch.js uses — whether this retroactive run needs its own
--     Asimov/Mason sign-off, separate from the live-pipeline sign-off
--     20261002060000 already has on record for processing NEW complaints,
--     is Jarvis's call to confirm before Q's tool is allowed to run for
--     real, not a schema question).
--
-- ============================================================
-- RULE 4 DATA INVENTORY ADDENDUM (GOVERNANCE.md Rule 4) — complaints is
-- already a registered table; this adds no new PII-adjacent field.
-- ============================================================
--   retroactive_name_match_checked_at is a timestamp recording when an
--   automated tool examined a row, not personal data about a tenant/owner
--   on its own — same non-PII treatment severity_assessed_at and
--   suggested_subject_at already have on record. No change to
--   agents_with_access, retention_policy, ccpa_exportable, or
--   ccpa_deletable beyond what 20261002060000 already covers for this
--   table.
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No. One new nullable column, no
--       default, added via ADD COLUMN IF NOT EXISTS — every existing row
--       gets NULL, which is exactly "never checked by the retroactive tool"
--       — correct, since that tool has not run yet. The one existing
--       constraint widened (complaints_held_excludes_ai_fields) is
--       trivially satisfied by every existing row today, since the column
--       is brand new and starts NULL everywhere.
--   [x] Does this touch a table other code depends on? Yes — complaints is
--       read by complaint-tracking/router.js and the complaints_* views.
--       All existing reads either SELECT * (gaining one extra NULL column,
--       no behavior change) or name columns explicitly (unaffected, since
--       none of them name this new column).
--   [x] Additive or destructive? Fully additive — one new column, one
--       existing CHECK widened (a pure superset of what it allows today).
--       No column dropped, no existing column's type/default changed, no
--       row updated, no existing constraint's logic narrowed for any
--       already-possible value.
--   [ ] Tested on a copy of the data first? No staging copy of Supabase
--       exists in this project — same standing caveat every migration here
--       carries. Mitigated by: the new column is new and starts NULL on
--       every row; the widened constraint can only ever reject a FUTURE
--       write that tries to set this column on a held row — there is no
--       such write today, and this migration doesn't add one.
--   [x] Governance go-ahead to build this specific schema — this column
--       stores no name, no candidate, no decision, and changes no matching
--       logic; it is bookkeeping for which rows an already-cleared tool has
--       examined. It does not, on its own, revisit any of Mason's three
--       conditions from 20261002060000. Running the retroactive tool for
--       real against the 1,800+ backlog rows is a separate question this
--       migration does not answer — see "WHAT THIS MIGRATION DELIBERATELY
--       DOES NOT BUILD" above.
-- ============================================================


ALTER TABLE complaints
  ADD COLUMN IF NOT EXISTS retroactive_name_match_checked_at TIMESTAMPTZ;

-- Extends the existing held-row invariant (complaints_held_excludes_ai_
-- fields, last widened 20261002060000 to add suggested_subject_type) to
-- this new column — a held row gets no automated retroactive name-match
-- check either, same as it gets no category, no severity_tier, no
-- suggested_subject_type. See "HELD-ROW EXCLUSION" above.
ALTER TABLE complaints
  DROP CONSTRAINT IF EXISTS complaints_held_excludes_ai_fields;
ALTER TABLE complaints
  ADD CONSTRAINT complaints_held_excludes_ai_fields CHECK (
    held_legal_fair_housing = FALSE OR (
      category IS NULL AND needs_human_call = FALSE AND description IS NULL
      AND flagged_protected_class = FALSE AND tone_trend IS NULL
      AND escalation_signal IS NULL AND owner_instruction_rejected IS NULL
      AND severity_tier IS NULL
      AND suggested_subject_type IS NULL
      AND retroactive_name_match_checked_at IS NULL
    )
  );


-- ============================================================
-- INDEX — the retroactive batch tool's own driver query: "complaints still
-- eligible for a retroactive name-match check." Same partial-index shape
-- as idx_complaints_severity_unassessed (shrinks toward empty as the
-- backfill progresses; cheap to keep afterward for the same reason it's
-- cheap to add now). Deliberately does not also filter
-- held_legal_fair_housing = FALSE here — the query issuing that extra
-- filter (see "HELD-ROW EXCLUSION" above) is still covered by this index,
-- the same way idx_complaints_severity_unassessed covers severity-batch.js's
-- query even though that query adds its own held_legal_fair_housing filter
-- on top.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_complaints_retroactive_name_match_unchecked
  ON complaints(created_at)
  WHERE needs_matching = TRUE AND retroactive_name_match_checked_at IS NULL;


-- ============================================================
-- COMMENT
-- ============================================================

COMMENT ON COLUMN complaints.retroactive_name_match_checked_at IS
  'When the RETROACTIVE batch backfill tool (not the live pipeline) last examined this complaint for a name-match candidate, regardless of outcome. NULL means the retroactive tool has never looked at this row — that is its own resumability signal (idx_complaints_retroactive_name_match_unchecked), the same role severity_tier IS NULL plays for severity-batch.js. Deliberately independent of suggested_subject_* (not part of complaints_suggested_subject_fields_together): set alongside all-NULL suggested_subject_* when checked but no candidate was found, or alongside all-SET suggested_subject_* when a candidate was found — both are valid, simultaneously-occurring states on purpose. Never set on a held_legal_fair_housing row (complaints_held_excludes_ai_fields) — a held row is never examined by this tool at all, the same as it never receives any other automated field on this table.';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP INDEX IF EXISTS idx_complaints_retroactive_name_match_unchecked;
--
-- ALTER TABLE complaints
--   DROP CONSTRAINT IF EXISTS complaints_held_excludes_ai_fields;
-- ALTER TABLE complaints
--   ADD CONSTRAINT complaints_held_excludes_ai_fields CHECK (
--     held_legal_fair_housing = FALSE OR (
--       category IS NULL AND needs_human_call = FALSE AND description IS NULL
--       AND flagged_protected_class = FALSE AND tone_trend IS NULL
--       AND escalation_signal IS NULL AND owner_instruction_rejected IS NULL
--       AND severity_tier IS NULL
--       AND suggested_subject_type IS NULL
--     )
--   );
-- -- Restores the exact pre-migration definition (20261002060000's version,
-- -- without retroactive_name_match_checked_at).
--
-- ALTER TABLE complaints
--   DROP COLUMN IF EXISTS retroactive_name_match_checked_at;
-- -- Only safe once you've confirmed the retroactive batch tool hasn't run
-- -- for any length of time, or that losing its "already checked" progress
-- -- is acceptable — dropping this column makes every previously-checked
-- -- row look unchecked again, which just means the next run re-examines
-- -- (and re-bills) rows it had already covered. Not data loss in the
-- -- CCPA/Rule 4 sense (this column is not personal data, see the Rule 4
-- -- addendum above) — only lost backfill progress.
--
-- ============================================================
