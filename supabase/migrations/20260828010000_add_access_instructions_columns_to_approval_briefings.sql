-- ============================================================
-- Migration: 20260828010000_add_access_instructions_columns_to_approval_briefings
-- Created:   2026-08-28
-- Author:    Neo (database specialist)
--
-- Closes a real gap Judge flagged after Approval Briefing Phase 3
-- (projects/hub/approval-briefing-SPEC.md Section 4.4 — the
-- access-instructions content-check gate, added per Mason's Fair
-- Housing review, compliance/approval-briefing-fair-housing-review.md
-- finding 1).
--
-- WHAT HAPPENED: Q built the two-layer content check for Latchel's
-- `access_instructions` job field —
-- projects/hub/approval-briefing/lib/access-instructions-check.js,
-- already live. It correctly runs (Layer 1 keyword scan + Layer 2 model
-- self-check, reusing content-check.js/protected-class-terms.js
-- unmodified) and returns a three-state result, deliberately built to
-- mirror risk_assessment_status's design (see that file's own
-- checkAccessInstructions() doc comment, lines 116-142). But Phase 1's
-- migration (20260827000000_approval_briefing_phase1.sql) gave
-- risk_assessment_text/_status/_held_category columns to persist the
-- equivalent risk-assessment result — and never gave this field
-- anywhere to persist. projects/hub/approval-briefing/lib/gather.js
-- already calls checkAccessInstructions() at gather time (Promise.all,
-- alongside job history/spend/tenure) and already logs a loud warning
-- about exactly this gap every time a real access_instructions value is
-- checked: "approval_briefings has no column to store the result yet —
-- held in memory only for this call" (gather.js, the accessCheck.status
-- !== 'none' branch). This migration is additive-only and adds nothing
-- but the three missing columns — it does not touch gather.js.
--
-- ============================================================
-- WHAT TO ADD, per Jarvis's spec: identical shape to the existing
-- risk_assessment_status / risk_assessment_held_category /
-- risk_assessment_text pattern already proven on this table
-- (20260827000000, Section B) — same three-state CHECK, same
-- "held requires a category" enforcement, same "held/flagged text must
-- never land here" enforcement, applied to a parallel set of columns
-- instead of reusing the risk-assessment ones (this is a genuinely
-- different field with its own independent hold/clear outcome per
-- briefing — a risk assessment can be held while access instructions
-- clear, or the reverse).
-- ============================================================
--
-- ============================================================
-- ONE NAMING NUANCE FOR Q TO RESOLVE WHEN WIRING gather.js — NOT
-- DECIDED BY THIS MIGRATION
-- ============================================================
-- access-instructions-check.js's checkAccessInstructions() returns one
-- of THREE states named 'none' | 'cleared' | 'held' (see that file's
-- doc comment). This migration's access_instructions_status column
-- uses 'pending' | 'completed' | 'held' — the same three-state SHAPE
-- Jarvis's spec asked for (identical to risk_assessment_status), but
-- not identical vocabulary. 'held' maps directly. 'cleared' (both
-- layers passed, checked text is safe to render) is the natural fit
-- for 'completed'. 'none' (the field was empty on the Latchel job —
-- nothing to check, nothing held) has no obviously-correct mapping:
-- it could reasonably be written as 'completed' (the check step ran to
-- completion; there was simply nothing to check — access_instructions_
-- text stays NULL either way, satisfying the held-text-not-populated
-- constraint below) or left as 'pending' (nothing was ever meaningfully
-- checked). This is a pipeline-code judgment call, not a schema one —
-- flagged here so it's a deliberate decision when gather.js is wired to
-- these columns, not an accident of whichever mapping is fastest to
-- type. Whichever is chosen, downstream email rendering (spec Section
-- 8) needs to treat 'pending'-with-no-text and 'completed'-with-no-text
-- as the same "no access instructions on this ticket" case either way
-- (access-instructions-check.js's own doc comment already calls this
-- out as a distinct, honest message from the held-state one).
--
-- ============================================================
-- Q'S NEXT STEP (not built here — schema only, per Peter's standing
-- rule that Neo doesn't wire application code)
-- ============================================================
-- Wire projects/hub/approval-briefing/lib/gather.js's
-- gatherApprovalBriefing() (or wherever the right call site ends up
-- being) to actually write access_instructions_status /
-- _held_category / _text into the update payload it already builds for
-- every other gathered field, using the accessCheck result it already
-- computes today but only returns in-memory. Remove the console.warn
-- once this is wired — that log line was Q's own loud flag for exactly
-- this gap, not a permanent feature.
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist, run before any
-- migration is handed off for Peter to apply)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No. Three new nullable-or-
--       defaulted columns added to an existing table with ADD COLUMN IF
--       NOT EXISTS; no existing column, row, or constraint is touched.
--       access_instructions_status backfills every existing row (if
--       any) to 'pending' via its DEFAULT — the same safe backfill
--       pattern risk_assessment_status itself used when it was first
--       created in 20260827000000, just applied here to an ADD COLUMN
--       instead of a CREATE TABLE.
--   [x] Does this touch any table other code depends on? Yes —
--       approval_briefings, and unlike the caveat 20260827000000 could
--       still make ("nothing else in this codebase reads or writes yet"),
--       that is no longer fully true as of Phase 3: gather.js's
--       gatherApprovalBriefing() already runs a real
--       .update(updatePayload) against this table. Checked directly
--       (gather.js, lines ~372-388): updatePayload is built as an
--       explicit, fixed set of named keys (latchel_property_id,
--       appfolio_property_id, property_id, maintenance_request_id, the
--       structured snapshot fields, last_data_refresh_at, optionally
--       appfolio_maintenance_limit) — never `SELECT *` or a
--       spread-everything pattern. Adding three new columns this
--       existing UPDATE call does not reference cannot change its
--       behavior; the new columns simply keep their DEFAULT/NULL until
--       Q's follow-up wiring (above) adds them to that payload.
--   [x] Additive or destructive? Fully additive. No column dropped, no
--       existing row altered, no CHECK narrowed.
--   [ ] Tested on a copy of the data first? No staging copy exists in
--       this project — same standing caveat every migration here
--       carries. Mitigated the same way 20260827000000 was: the three
--       new columns are inert until Q's follow-up wiring lands (this
--       migration alone changes zero application behavior), and the
--       two new CHECK constraints are the exact, already-proven pattern
--       (approval_briefings_held_requires_category /
--       approval_briefings_held_text_not_populated) copied to a second
--       field, not new logic being tried for the first time.
--
-- ONE DEPENDENCY WORTH STATING PLAINLY: this migration ALTERs
-- approval_briefings, which only exists once 20260827000000 has been
-- applied. Per that migration's own header, as of this writing it was
-- cleared to build but its live-application status wasn't asserted here
-- either way — whoever applies migrations should apply
-- 20260827000000_approval_briefing_phase1.sql first (filename order
-- already guarantees this in any apply-in-order tooling; flagged only
-- for a manual/out-of-order apply).
-- ============================================================


-- ============================================================
-- SECTION A: three new columns on approval_briefings, mirroring
-- risk_assessment_status / risk_assessment_held_category /
-- risk_assessment_text exactly in shape (spec Section 4.4).
-- ============================================================

-- Mirrors risk_assessment_status's own CHECK vocabulary and default
-- exactly (20260827000000, Section B). See the naming-nuance note above
-- for how access-instructions-check.js's 'none'/'cleared'/'held' result
-- maps onto this column's 'pending'/'completed'/'held' — a pipeline-code
-- decision for Q, not decided here.
ALTER TABLE approval_briefings
  ADD COLUMN IF NOT EXISTS access_instructions_status TEXT
    NOT NULL DEFAULT 'pending'
    CHECK (access_instructions_status IN ('pending', 'completed', 'held'));

-- Required whenever access_instructions_status = 'held' — same
-- discipline as risk_assessment_held_category /
-- approval_briefings_held_requires_category (20260827000000):
-- GOVERNANCE.md Rule 9 requires the exclusion reason to be recorded,
-- not just the fact of exclusion. Populated from
-- checkAccessInstructions()'s own held_category (which itself comes
-- from content-check.js's checkClaim() — the same flagged_category
-- vocabulary risk_assessment_held_category already uses, per that
-- function's shared, unmodified reuse of content-check.js).
ALTER TABLE approval_briefings
  ADD COLUMN IF NOT EXISTS access_instructions_held_category TEXT;

-- The cleared, checked instruction text — safe to render verbatim into
-- either email template (spec Section 4.4/8) once
-- access_instructions_status = 'completed'. Same "held/flagged text
-- must never land here" rule as risk_assessment_text, enforced
-- structurally below (not left to pipeline-code discipline alone) —
-- mirrors approval_briefings_held_text_not_populated's CHECK pattern.
ALTER TABLE approval_briefings
  ADD COLUMN IF NOT EXISTS access_instructions_text TEXT;

-- Enforcement #1: a held access-instructions check must record why —
-- mirrors approval_briefings_held_requires_category (20260827000000)
-- applied to this new pair of columns.
ALTER TABLE approval_briefings
  DROP CONSTRAINT IF EXISTS approval_briefings_access_instructions_held_requires_category;
ALTER TABLE approval_briefings
  ADD CONSTRAINT approval_briefings_access_instructions_held_requires_category
  CHECK (access_instructions_status != 'held' OR access_instructions_held_category IS NOT NULL);

-- Enforcement #2: flagged/held text must never actually land in
-- access_instructions_text — mirrors
-- approval_briefings_held_text_not_populated (20260827000000) applied
-- to this new pair of columns. Note the boundary condition this
-- constraint deliberately allows: status = 'pending' with text IS NULL
-- (nothing gathered yet) passes this CHECK the same way status =
-- 'completed' with text IS NULL would (see the naming-nuance note above
-- for the 'none' case) — this constraint only ever blocks the unsafe
-- combination (status = 'held' with text populated), which is its
-- entire job.
ALTER TABLE approval_briefings
  DROP CONSTRAINT IF EXISTS approval_briefings_access_instructions_held_text_not_populated;
ALTER TABLE approval_briefings
  ADD CONSTRAINT approval_briefings_access_instructions_held_text_not_populated
  CHECK (access_instructions_status = 'completed' OR access_instructions_text IS NULL);

COMMENT ON COLUMN approval_briefings.access_instructions_status IS
  'pending = not yet checked (or checked and nothing to check — see this migration''s header for the checkAccessInstructions() none/cleared/held to pending/completed/held mapping note). completed = the two-layer content check passed (or the field was empty); access_instructions_text may be populated. held = either content-check layer flagged the generated text; access_instructions_text is NOT populated (enforced by approval_briefings_access_instructions_held_text_not_populated) and access_instructions_held_category records why (enforced by approval_briefings_access_instructions_held_requires_category). Email generation (spec Section 8) must render "Access instructions not available for this ticket" when status != ''completed'' or text IS NULL — never fall back to reading job.access_instructions directly.';

COMMENT ON COLUMN approval_briefings.access_instructions_text IS
  'The checked, cleared copy of Latchel job.access_instructions — safe to render verbatim into the PM briefing and owner-draft templates (spec Section 4.4/8) once access_instructions_status = ''completed''. Never populated with flagged/held text (enforced structurally, not just by pipeline discipline) — see approval_briefings_access_instructions_held_text_not_populated.';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- -- Only safe if gather.js has not yet been wired to write these
-- -- columns (Q's follow-up step, not built by this migration) — if it
-- -- has, confirm nothing downstream depends on the stored values first.
-- ALTER TABLE approval_briefings
--   DROP CONSTRAINT IF EXISTS approval_briefings_access_instructions_held_text_not_populated;
-- ALTER TABLE approval_briefings
--   DROP CONSTRAINT IF EXISTS approval_briefings_access_instructions_held_requires_category;
--
-- ALTER TABLE approval_briefings DROP COLUMN IF EXISTS access_instructions_text;
-- ALTER TABLE approval_briefings DROP COLUMN IF EXISTS access_instructions_held_category;
-- ALTER TABLE approval_briefings DROP COLUMN IF EXISTS access_instructions_status;
--
-- ============================================================
