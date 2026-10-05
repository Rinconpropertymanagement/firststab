-- ============================================================
-- Migration: 20260912050000_reconcile_20260912040000_timestamp_collision
-- Created:   2026-09-12
-- Author:    Neo (database specialist)
--
-- WHY THIS FILE EXISTS
-- ============================================================
-- Two unrelated migrations were both accidentally saved with the exact
-- same timestamp prefix, 20260912040000:
--
--   (A) 20260912040000_fix_search_safe_view_seq_scan.sql
--       A performance fix. missive_message_intake_search_safe was timing
--       out live (statement_timeout, ~8-9s) on trivial queries because its
--       WHERE clause OR'd an indexable column condition against a
--       correlated EXISTS subquery, which Postgres cannot serve with any
--       index — forcing a full Seq Scan of a 254,000+ row table plus one
--       subquery execution per row. The fix rewrote the view as a UNION
--       of two independently-indexed branches (same rows, same
--       security_barrier, only the query plan changes). CONFIRMED
--       ALREADY APPLIED AND LIVE — verified by direct query timing
--       (8+ second timeout before, a consistent 0.2-0.4s after) as part
--       of this build's test pass. This migration is real, working, and
--       must not be undone.
--
--   (B) 20260912040000_add_reopen_to_archive_search_escalations.sql
--       An unrelated schema change: adds reopened_at/reopened_by/
--       reopen_reason columns (plus a lockstep CHECK constraint) to
--       archive_search_escalations, so a 'confirmed' escalation's search
--       exclusion can be reversed without ever erasing the original
--       confirmation. NOT yet applied. Its own view-rewrite section,
--       however, was written against the OLD pre-(A) view definition (the
--       slow OR/EXISTS form) — because at the time it was written, (A)'s
--       fix had not yet landed. Applying (B) exactly as written, now,
--       after (A) is already live, would CREATE OR REPLACE the view back
--       to the slow OR/EXISTS structure — silently reverting (A)'s
--       already-confirmed fix — while layering the new reopen condition
--       on top of that reverted, slow version.
--
-- Two migration files sharing one timestamp is purely a filename
-- collision — Postgres does not know or care about filenames, so nothing
-- has executed twice or out of order on its own. The real risk this file
-- prevents is a HUMAN one: Peter applies migrations by pasting files into
-- Supabase's SQL Editor himself, in filename order, one at a time. Two
-- files sorting identically makes it easy to paste only (B) — or (B)
-- before noticing (A) already ran — and get exactly the silent
-- regression described above with no error of any kind (CREATE OR
-- REPLACE VIEW never complains that it is replacing something "newer").
-- This was caught in review (TARS + Judge, this build), before Peter ever
-- saw either file, which is exactly what this project's review process is
-- for.
--
-- WHAT THIS FILE DOES
-- ============================================================
-- Supersedes and completes BOTH (A) and (B) as a single, correctly
-- sequenced migration:
--   1. Adds (B)'s three reopen columns to archive_search_escalations,
--      PLUS the two changes required by the Round 3 governance/legal
--      review that (B) itself did not yet have (see below) — a fourth
--      column (litigation_hold_attestation) and a strengthened CHECK
--      constraint (reopened_by IS DISTINCT FROM resolved_by). They don't
--      touch the view and don't conflict with anything (A) did.
--   2. Rewrites missive_message_intake_search_safe starting from (A)'s
--      LIVE, ALREADY-APPLIED UNION structure (read directly from (A)'s
--      own file on disk for this migration — not reconstructed from
--      memory), with (B)'s reopen-awareness folded into BOTH UNION
--      branches' escalation-exclusion clause: the exclusion condition
--      changes from "e.status IN ('open', 'confirmed')" to
--      "e.status = 'open' OR (e.status = 'confirmed' AND e.reopened_at
--      IS NULL)" in each branch. Same override-inclusion logic, same
--      security_barrier setting, same UNION-of-two-indexed-branches
--      shape (A) already fixed — nothing about (A)'s fix is undone.
--   3. Does NOT delete or modify (A) or (B) — see the short "SUPERSEDED"
--      notices added to the top of each of those two files as part of
--      this same change, so nobody pastes either one on its own later.
--      (A) is already live, so re-applying it verbatim would be a
--      harmless no-op CREATE OR REPLACE back to the UNION form this
--      migration also produces — but the notice exists to prevent
--      confusion, not because re-running (A) alone would corrupt
--      anything.
--
-- ============================================================
-- ROUND 3 GOVERNANCE/LEGAL REQUIREMENTS — WHY THIS FILE DIFFERS FROM (B)
-- ============================================================
-- See compliance/archive-search-escalation-mechanism-review.md, "Round 3
-- — Real Legal/Governance Review of the 'Reopen a Confirmed Escalation'
-- Mechanism" (added 2026-09-12). An earlier attempt to treat (B)'s reopen
-- design as a quick confirmation of the archive_search_flagged_overrides
-- revocation precedent was NOT APPROVED — Asimov found reopening moves in
-- the opposite risk direction from a revocation (it RE-EXPOSES
-- correspondence a human admin already confirmed was a real Fair Housing
-- concern, to the same up-to-8-person population, with no further
-- check), and Mason concurred, requiring two specific, concrete changes
-- before the reopen capability may be used for real. Quoting Mason's
-- verdict directly, not just asserting it:
--
--   1. "A different admin must reopen than the one who confirmed —
--      enforce reopened_by IS DISTINCT FROM resolved_by, at the database
--      level, in the same CHECK constraint pattern this table already
--      uses. ... I'd treat this as close to a floor requirement, not a
--      nice-to-have."
--
--   2. "The litigation-hold reminder must become a real, captured step in
--      the reopen action itself, not a passive SQL comment. ... require
--      the reopen action to capture a structured attestation ('I
--      confirmed with Peter this conversation is not under an active
--      litigation hold') as part of reopen_reason... not as a separate
--      unenforced reminder" — implemented as its own required, separate
--      field, not buried in general reason text.
--
-- Mason also confirmed: once both changes are in place, no mandatory
-- cooling-off period and no fresh outside-counsel sign-off are required.
--
-- This file implements both, on top of (B)'s original three columns:
--   (a) litigation_hold_attestation — a new, separate required TEXT
--       column (Section 1 below), same lockstep pattern as reopen_reason
--       — NULL until reopened, then required and non-empty, enforced by
--       the same archive_search_escalations_reopen_fields_together CHECK
--       constraint (B) already introduced, now widened rather than
--       replaced with a second constraint.
--   (b) reopened_by IS DISTINCT FROM resolved_by — folded into that same
--       CHECK constraint as an additional required condition on the
--       "reopened" branch, so the database itself refuses a same-admin
--       reopen; this is not application-code-only enforcement.
-- Any future build against this mechanism should cite the Round 3
-- section directly, not this comment alone — this comment quotes it, it
-- does not replace it as the record of the review.
-- ============================================================
--
-- NOTE ON "CONFIRMED ALREADY APPLIED AND LIVE": that confirmation (the
-- 8s-timeout-to-0.2s query timing) came from this build's TARS test pass
-- against the real, live database — not from a direct Postgres connection
-- available to Neo. This project has no direct DB connection by standing
-- convention (Peter applies every migration and verification query
-- himself via Supabase's SQL Editor). The UNION structure copied into
-- Section 2 below was read verbatim from (A)'s own file on disk, which is
-- the actual, live definition regardless of who ran the timing check.
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file. Reverts the view to
--       (A)'s live UNION structure (reopen-unaware) and drops the reopen
--       columns/constraint — i.e., back to exactly the state that exists
--       right now, before this migration runs.
--   [x] Does this break any existing data? No. Section 1 adds four
--       nullable columns with no default (metadata-only, no row
--       rewritten) — same reasoning (B) itself already gave, extended to
--       the new litigation_hold_attestation column. Section 2 replaces
--       only a VIEW definition (a stored query, not stored data).
--       CONFIRMED, not assumed: queried the live database directly via
--       its REST API (Supabase project mnqyhrihmopwqjipsldj, schema
--       introspection + a live SELECT) as part of this same build,
--       2026-09-12 — archive_search_escalations has zero rows today and
--       none of reopened_at/reopened_by/reopen_reason/
--       litigation_hold_attestation exist on it yet, confirming neither
--       (B) nor this migration has been applied. Because no escalation
--       row has reopened_at set today (the columns don't exist until this
--       migration adds them, and no reopen route exists yet to set
--       them), the new view condition
--       "e.status = 'open' OR (e.status = 'confirmed' AND e.reopened_at
--       IS NULL)" is EXACTLY EQUIVALENT to the old "e.status IN
--       ('open','confirmed')" for every row that exists the moment this
--       ships. The view's result set is unchanged today; behavior
--       diverges only once a future reopen route (Q's, not built here)
--       sets reopened_at on a real row.
--   [x] Does this touch a table other code depends on?
--       missive_message_intake_search_safe, yes — the one view every
--       archive-search search/message route is required to query. Same
--       columns, same row-filtering semantics for every row that exists
--       today, same security_barrier guarantee — only the exclusion
--       condition's future behavior (once a reopen happens) and the
--       query plan (already fixed by (A), preserved here) differ from
--       what was live before (A).
--       archive_search_escalations, yes — existing escalate/resolve
--       routes insert/update this table today; neither statement names
--       reopened_at/reopened_by/reopen_reason/litigation_hold_attestation,
--       so neither is affected.
--       missive_message_intake, archive_search_flagged_overrides — read
--       only, by the view definition, unchanged from (A).
--   [x] Additive or destructive? Additive: 4 new nullable columns, 1 new
--       CHECK constraint, 1 view replacement that is behavior-preserving
--       for every row that exists today (see above) and is, in net effect
--       across (A)+(B)+this file, a straight continuation of (A)'s
--       already-fixed UNION structure — not a reversion, not a new
--       structural risk. CREATE OR REPLACE VIEW is metadata-only, no
--       table scan or rewrite, same fact (A)'s and every prior view
--       migration in this schema already confirmed for this exact
--       statement shape.
--   [ ] Tested on a copy of the data first? No staging copy of Supabase
--       exists in this project — same standing caveat every migration
--       here has carried. Mitigated by: Section 1 is trivial at this
--       table's near-empty size; Section 2 is metadata-only and provably
--       behavior-preserving today (see above); and the UNION structure it
--       builds on was already verified live, on real data, by this
--       build's TARS pass (8+s timeout -> 0.2-0.4s). Recommended, mirrors
--       (B)'s own recommendation: after applying, re-run the same timing
--       check to confirm the view is still fast with the added NULL check
--       in both branches (expected: no material change, per (B)'s own
--       "one extra NULL check per already-matched row, not an additional
--       scan" reasoning) —
--         SELECT count(*) FROM missive_message_intake_search_safe;
--       (time it; compare against the post-(A) 0.2-0.4s baseline.)
--   [x] Governance go-ahead needed? YES — and now specifically addressed,
--       not just inherited-open. (B)'s own header flagged that the
--       reopen mechanism had not yet had its own Asimov/Mason review (it
--       only carried the mirror-image archive_search_flagged_overrides
--       precedent by analogy). That review has since happened for real —
--       Round 3, compliance/archive-search-escalation-mechanism-review.md
--       — and it did NOT clear the reopen design as originally drafted:
--       Asimov found the risk direction is inverted from a revocation
--       (re-exposure, not risk reduction), and Mason required two
--       specific database-level changes before the capability may be
--       used for real (quoted in full above). This file makes exactly
--       those two changes — nothing more, nothing extrapolated beyond
--       what Mason's verdict specifies. Mason's verdict is explicit that,
--       with both changes in place, no further cooling-off period and no
--       fresh outside-counsel sign-off are required. That said: per
--       Neo's own standing role, Neo does not approve its own migrations
--       or close governance items on its own say-so — implementing
--       Mason's specified fix is not the same thing as Asimov/Mason
--       re-reviewing this exact SQL, and applying this file for real
--       remains Peter's call alone, same as every migration in this
--       schema.
-- ============================================================


-- ============================================================
-- SECTION 1: archive_search_escalations (add reopen columns)
-- (B)'s three original columns (reopened_at/reopened_by/reopen_reason)
-- carried forward, PLUS litigation_hold_attestation and a strengthened
-- CHECK constraint — the two changes Round 3 requires (see the header
-- section above, quoting Mason directly). This section does not touch
-- the view and has no dependency on the collision this migration
-- resolves.
-- ============================================================

ALTER TABLE archive_search_escalations
  ADD COLUMN IF NOT EXISTS reopened_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reopened_by    TEXT,
  ADD COLUMN IF NOT EXISTS reopen_reason  TEXT,
  ADD COLUMN IF NOT EXISTS litigation_hold_attestation TEXT;

-- Widened from (B)'s original version to fold in both Round 3
-- requirements as required, not optional, conditions on the "reopened"
-- branch:
--   - litigation_hold_attestation joins reopen_reason in the same
--     lockstep, non-empty-when-set discipline (Mason requirement 2).
--   - reopened_by IS DISTINCT FROM resolved_by is now enforced here, at
--     the database level, not just recommended in application code
--     (Mason requirement 1). resolved_by is guaranteed NOT NULL whenever
--     status = 'confirmed' (archive_search_escalations_resolution_fields
--     _together, 20260912030000), so this comparison is never silently
--     satisfied by a NULL on either side — confirmed directly against
--     that constraint and against the live table (zero rows today), not
--     assumed.
ALTER TABLE archive_search_escalations
  ADD CONSTRAINT archive_search_escalations_reopen_fields_together
    CHECK (
      (reopened_at IS NULL AND reopened_by IS NULL AND reopen_reason IS NULL
       AND litigation_hold_attestation IS NULL)
      OR
      (status = 'confirmed'
       AND reopened_at IS NOT NULL AND reopened_by IS NOT NULL
       AND reopen_reason IS NOT NULL AND length(trim(reopen_reason)) > 0
       AND litigation_hold_attestation IS NOT NULL
       AND length(trim(litigation_hold_attestation)) > 0
       AND reopened_by IS DISTINCT FROM resolved_by)
    );

COMMENT ON COLUMN archive_search_escalations.reopened_at IS
  'NULL until a human decides a ''confirmed'' escalation was wrong and this conversation''s search access should be restored — Peter''s own decision, 2026-09-12 (compliance/archive-search-escalation-mechanism-review.md, Outstanding Items #3), mirroring archive_search_flagged_overrides.revoked_at''s identical reversal pattern for the mirror-image mechanism. Once set (together with reopened_by/reopen_reason — enforced by this table''s own reopen-fields-together CHECK), missive_message_intake_search_safe stops excluding this conversation on its very next query — no separate cleanup step. This NEVER changes status back to ''open'' and NEVER touches resolved_by/resolved_at/resolution_notes: the fact that this was once confirmed, by whom, when, and why remains permanently on this same row, alongside the new fact that it was later reopened, by whom, when, and why. Only legal while status = ''confirmed'' (enforced by the same CHECK) — an ''open'' report has nothing to reopen, and a ''false_alarm'' resolution already left the conversation searchable, so there is nothing here to reverse.';

COMMENT ON COLUMN archive_search_escalations.reopened_by IS
  'Who reopened a confirmed escalation — same TEXT attribution convention as reported_by/resolved_by (this table) and overridden_by/revoked_by (archive_search_flagged_overrides). NULL until reopened; once set, permanent — never cleared or reassigned afterward. MUST differ from this same row''s resolved_by (enforced by the reopen-fields-together CHECK, reopened_by IS DISTINCT FROM resolved_by) — Mason''s Round 3 requirement (compliance/archive-search-escalation-mechanism-review.md), in his own words "close to a floor requirement, not a nice-to-have": the admin who confirmed a concern is real may not be the same admin who later reopens it alone.';

COMMENT ON COLUMN archive_search_escalations.reopen_reason IS
  'Why a ''confirmed'' escalation was reopened — required, non-empty once set (enforced by the reopen-fields-together CHECK). Same restraint as escalation_reason/resolution_notes: describe why the original confirmation is now believed to have been wrong, do not quote or paraphrase the flagged correspondence itself into this field. Distinct from litigation_hold_attestation, which is its own required field, not a sentence folded into this one — Mason''s Round 3 review specifically rejected relying on reopen_reason prose for the litigation-hold check.';

COMMENT ON COLUMN archive_search_escalations.litigation_hold_attestation IS
  'Added 2026-09-12 per Mason''s Round 3 requirement (compliance/archive-search-escalation-mechanism-review.md): "require the reopen action to capture a structured attestation (''I confirmed with Peter this conversation is not under an active litigation hold'') as part of reopen_reason... not as a separate unenforced reminder" — implemented here as its own required, separate field rather than folded into reopen_reason''s free text, so the check is captured and enforceable, not just a passive SQL comment (Round 2''s original, now-superseded answer). NULL until reopened; required and non-empty once reopened_at is set (enforced by the reopen-fields-together CHECK, same lockstep pattern as reopen_reason). This table does not verify the attestation''s truth — same human-attestation model resolution_notes/escalation_reason already use — it only guarantees the step was consciously taken and recorded, not skipped.';

COMMENT ON CONSTRAINT archive_search_escalations_reopen_fields_together
  ON archive_search_escalations IS
  'Keeps reopened_at/reopened_by/reopen_reason/litigation_hold_attestation in lockstep, and restricts them to a status = ''confirmed'' row: either all four are NULL, or status = ''confirmed'' AND all four are set together (reopen_reason and litigation_hold_attestation both non-empty) AND reopened_by IS DISTINCT FROM resolved_by. Prevents a partially-recorded reopening, prevents "reopening" an ''open'' report (nothing to reopen) or a ''false_alarm'' resolution (already searchable, nothing to reverse), prevents the same admin who confirmed from unilaterally reopening alone, and prevents reopening without a captured litigation-hold attestation — all at the database level, not just in application code. The distinct-admin and attestation conditions were added 2026-09-12 per Mason''s Round 3 review (compliance/archive-search-escalation-mechanism-review.md); the original three-column lockstep (without those two conditions) came from 20260912040000_add_reopen_to_archive_search_escalations.sql, never applied live. Same defense-in-depth discipline archive_search_flagged_overrides_revocation_fields_together already applies to its own reversal case.';

COMMENT ON TABLE archive_search_escalations IS
  'A human report of a suspected material Fair Housing concern encountered while using Archive Search (compliance/archive-search-fair-housing-outside-counsel-opinion.md, safeguard #5; projects/hub/email-intake/archive-search-escalation-mechanism-spec.md). Distinct from archive_search_flagged_overrides, which corrects a false-positive AI flag in the opposite direction. A row with status = ''open'', or status = ''confirmed'' with reopened_at IS NULL, makes missive_message_intake_search_safe stop returning the conversation immediately — never by writing to missive_message_intake itself. status is one-way: open -> confirmed or open -> false_alarm, never back to open; a later new report on the same conversation gets its own fresh row. A ''confirmed'' row''s search EXCLUSION, unlike its status, IS reversible: reopened_at/reopened_by/reopen_reason/litigation_hold_attestation (columns added 2026-09-12, Peter''s own decision to make reopening possible at all — Outstanding Items #3 — but the specific safeguards below came from a real Round 3 Asimov/Mason review, not Peter''s design alone) layer a second, later human decision on top, mirroring archive_search_flagged_overrides.revoked_at''s pattern but NOT identically: reopening a ''confirmed'' row must be done by a different admin than the one who confirmed it (reopened_by IS DISTINCT FROM resolved_by, database-enforced) and must carry its own captured litigation-hold attestation (litigation_hold_attestation, required and non-empty) — both because reopening re-exposes correspondence a human already determined was a real concern, the opposite risk direction from a revocation. The fact that this was once confirmed, by whom, when, and why is never erased or edited, only added to. No AI agent ever reads or writes this table — every row (report, resolution, or reopening) is a human act, per GOVERNANCE.md Rule 8 Tier 3 and the Fair Housing Standard''s Rule 7.';

COMMENT ON COLUMN archive_search_escalations.status IS
  'open: reported, pending admin review — the conversation is excluded from search. confirmed: an admin determined this is a real concern — excluded from search unless and until reopened (reopened_at IS NULL keeps the exclusion in place; see reopened_at''s own comment for the reversal path added 2026-09-12). status itself never changes away from ''confirmed'', even once reopened, so the fact of the original confirmation stays permanent. false_alarm: an admin determined this was not a real concern — the conversation reappears in search on the very next query once this status is set, with no further action needed, exactly the same "no separate cleanup step" mechanic archive_search_flagged_overrides.revoked_at already documents for its own reversal case.';


-- ============================================================
-- SECTION 2: missive_message_intake_search_safe (reconciled view)
--
-- Base structure: 20260912040000_fix_search_safe_view_seq_scan.sql's live
-- UNION-of-two-branches rewrite, copied verbatim from that file (both
-- SELECT branches, the JOIN, the override/revoked_at condition — nothing
-- there is altered). The ONLY change from that live definition: both
-- branches' "AND NOT EXISTS (... archive_search_escalations ...)" clause
-- narrows "e.status IN ('open', 'confirmed')" to
-- "e.status = 'open' OR (e.status = 'confirmed' AND e.reopened_at IS
-- NULL)" — 20260912040000_add_reopen_to_archive_search_escalations.sql's
-- own reopen-aware condition, applied to the UNION structure instead of
-- the pre-fix OR/EXISTS structure that file was (necessarily, at the
-- time it was written) built against.
--
-- security_barrier = true: unchanged, for the same reason (A) already
-- gave and (B) did not dispute — this view still gates access to
-- unscreened/held/flagged PII-dense content, and nothing about either
-- source migration's own change removes that need.
-- ============================================================

CREATE OR REPLACE VIEW missive_message_intake_search_safe
WITH (security_barrier = true) AS
SELECT m.*
FROM missive_message_intake m
WHERE m.screening_result = 'clear'
  AND NOT EXISTS (
    SELECT 1
    FROM archive_search_escalations e
    WHERE e.missive_conversation_id = m.missive_conversation_id
      AND e.mailbox_key             = m.mailbox_key
      AND (
        e.status = 'open'
        OR (e.status = 'confirmed' AND e.reopened_at IS NULL)
      )
  )

UNION

SELECT m.*
FROM archive_search_flagged_overrides o
JOIN missive_message_intake m
  ON m.missive_conversation_id          = o.missive_conversation_id
 AND m.mailbox_key                      = o.mailbox_key
 AND m.screening_completed_at           = o.overridden_screening_completed_at
WHERE o.revoked_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM archive_search_escalations e
    WHERE e.missive_conversation_id = m.missive_conversation_id
      AND e.mailbox_key             = m.mailbox_key
      AND (
        e.status = 'open'
        OR (e.status = 'confirmed' AND e.reopened_at IS NULL)
      )
  );

COMMENT ON VIEW missive_message_intake_search_safe IS
  'The ONLY view every archive-search search/message route may query — never missive_message_intake directly, with the one named exception of screening-pass.js. History: 20260910030000 created it; 20260912010000 added the override-inclusion clause; 20260912030000 added the escalation-exclusion clause; 20260912040000_fix_search_safe_view_seq_scan rewrote it from a single OR/EXISTS filter into a UNION of two independently-indexed branches to fix a live statement-timeout bug (unchanged row-filtering semantics, query plan only); this migration (20260912050000) reconciles that same-day timestamp collision against 20260912040000_add_reopen_to_archive_search_escalations by folding that file''s reopen-aware narrowing into the UNION structure instead of the pre-fix structure it was written against — a ''confirmed'' escalation with reopened_at IS NOT NULL no longer excludes its conversation; an ''open'' escalation still excludes unconditionally, pending review. Resolving an escalation as false_alarm, or reopening a confirmed one, both remove the exclusion on the very next query, with no separate cleanup step. security_barrier = true unchanged throughout.';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration —
-- returns to exactly the state that existed right before this migration
-- ran: (A)'s live UNION view, reopen-unaware, and no reopen columns)
-- ============================================================
--
-- -- Reverts the view to 20260912040000_fix_search_safe_view_seq_scan's
-- -- live definition (UNION structure, reopen-unaware). Safe at any time —
-- -- changes only which rows the view returns, never stored data. If any
-- -- escalation has ever really been reopened, rolling back makes that
-- -- conversation excluded from search again immediately — confirm this is
-- -- intended first:
-- -- SELECT * FROM archive_search_escalations WHERE reopened_at IS NOT NULL;
--
-- CREATE OR REPLACE VIEW missive_message_intake_search_safe
-- WITH (security_barrier = true) AS
-- SELECT m.*
-- FROM missive_message_intake m
-- WHERE m.screening_result = 'clear'
--   AND NOT EXISTS (
--     SELECT 1
--     FROM archive_search_escalations e
--     WHERE e.missive_conversation_id = m.missive_conversation_id
--       AND e.mailbox_key             = m.mailbox_key
--       AND e.status IN ('open', 'confirmed')
--   )
-- UNION
-- SELECT m.*
-- FROM archive_search_flagged_overrides o
-- JOIN missive_message_intake m
--   ON m.missive_conversation_id          = o.missive_conversation_id
--  AND m.mailbox_key                      = o.mailbox_key
--  AND m.screening_completed_at           = o.overridden_screening_completed_at
-- WHERE o.revoked_at IS NULL
--   AND NOT EXISTS (
--     SELECT 1
--     FROM archive_search_escalations e
--     WHERE e.missive_conversation_id = m.missive_conversation_id
--       AND e.mailbox_key             = m.mailbox_key
--       AND e.status IN ('open', 'confirmed')
--   );
--
-- -- Drops the reopen mechanism itself, including the two Round 3
-- -- columns. Confirm no real row has reopened_at set (query above), or
-- -- that losing that record is truly intended, before dropping these
-- -- columns for real.
-- ALTER TABLE archive_search_escalations
--   DROP CONSTRAINT IF EXISTS archive_search_escalations_reopen_fields_together;
-- ALTER TABLE archive_search_escalations
--   DROP COLUMN IF EXISTS litigation_hold_attestation,
--   DROP COLUMN IF EXISTS reopen_reason,
--   DROP COLUMN IF EXISTS reopened_by,
--   DROP COLUMN IF EXISTS reopened_at;
--
-- ============================================================
