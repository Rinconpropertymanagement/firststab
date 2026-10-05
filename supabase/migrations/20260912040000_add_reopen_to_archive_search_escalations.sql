-- ============================================================
-- SUPERSEDED — DO NOT APPLY THIS FILE ON ITS OWN.
-- This filename collided with another migration also timestamped
-- 20260912040000 (fix_search_safe_view_seq_scan.sql), which was already
-- applied and live BEFORE this file's own view rewrite (Section 2, below)
-- was written — meaning Section 2 here targets the OLD, slow, pre-fix
-- view definition, not the live one. Applying this file as-is now would
-- silently revert that already-fixed performance bug while adding the
-- reopen logic on top of the reverted version. Both files are reconciled
-- into 20260912050000_reconcile_20260912040000_timestamp_collision.sql,
-- which carries this file's Section 1 (reopen columns/constraint)
-- forward unchanged and re-derives Section 2 against the live,
-- already-fixed view instead. Apply 20260912050000, not this file.
-- ============================================================

-- ============================================================
-- Migration: 20260912040000_add_reopen_to_archive_search_escalations
-- Created:   2026-09-12
-- Author:    Neo (database specialist)
--
-- Builds Peter's own decision, 2026-09-12, resolving the "still open"
-- design finding named in compliance/archive-search-escalation-
-- mechanism-review.md, Outstanding Items #3: "A confirmed escalation can
-- never be re-escalated by anyone, ever — permanent by design, the same
-- way a held conversation is. Confirm this is intended." Peter's answer:
-- no — a 'confirmed' archive_search_escalations row should be
-- REVERSIBLE (search access restorable) without ever erasing the fact
-- that it was once confirmed, by whom, when, and why.
--
-- This is the SAME pattern 20260912010000 (archive_search_flagged_
-- overrides) already built and already had Asimov's and Mason's real
-- governance/legal clearance for, applied here to the mirror-image table:
-- that migration added revoked_at/revoked_by/revocation_reason to let a
-- human take back an earlier GRANT of search access, never mutating or
-- deleting the original override row. This migration adds
-- reopened_at/reopened_by/reopen_reason to let a human take back an
-- earlier CONFIRMATION that search access should stay REVOKED, never
-- mutating or deleting the original escalation row, its status, or its
-- resolved_by/resolved_at/resolution_notes. Same naming shape
-- (<verb>ed_at/<verb>ed_by/<verb>_reason), same CHECK-constraint-lockstep
-- convention (all-three-together-or-all-three-NULL), same "layer a
-- second, later human decision on top, never edit or erase the first
-- one" discipline.
--
-- Also directly enables the fix for the second, independent finding in
-- that same Outstanding Items #3 entry — the generic-404-on-an-already-
-- reported-conversation cosmetic message-clarity issue. That fix is
-- Q's (application-code) job in archive-search/router.js, not a schema
-- change: the report route's precondition check needs to look at
-- archive_search_escalations directly, before or independent of the
-- general missive_message_intake_search_safe check, for an existing
-- 'open' escalation OR a 'confirmed' escalation with reopened_at IS
-- NULL, and return a specific 409 instead of a generic 404. This
-- migration's reopened_at column is exactly the field that check needs
-- to tell "still actively excluding this conversation" apart from "was
-- confirmed, but later reopened, so a fresh report is really a fresh
-- report" — no additional schema is required for that fix beyond what
-- this file already adds.
--
-- Governance status: this IS a GOVERNANCE.md compliance build — it
-- modifies the reversibility of a Fair-Housing-relevant exclusion on
-- missive_message_intake_search_safe, the same view Asimov classified
-- Critical tier (GOVERNANCE.md Rule 6: "decision criteria, compliance
-- logic, permission tiers, guardrails") when 20260912010000 and
-- 20260912030000 first touched it. Per CLAUDE.md's Governance &
-- Compliance section and GOVERNANCE.md's Integrity Rule 4, this file is
-- NOT applied by Neo — Peter applies every migration himself via
-- Supabase's SQL Editor — and per Neo's own standing role, Neo does not
-- approve its own migrations.
--
-- Honestly flagged, not glossed over: unlike 20260912010000's own
-- revocation path, which was built in direct response to an explicit,
-- on-record Mason finding requiring it, THIS specific reopen mechanism
-- has not itself been walked back through a fresh Asimov/Mason closing
-- review — the compliance review document (compliance/archive-search-
-- escalation-mechanism-review.md) left "should a confirmed escalation
-- ever be reversible" as an open design question for Peter's own
-- yes/no, not as a defect requiring their re-review, and this migration
-- answers that question using the identical structural pattern they
-- already cleared for the mirror-image case. Recommended before this
-- ships live: the same lightweight, on-record confirmation Asimov and
-- Mason already gave the original escalation mechanism's own Rule 6
-- shadow-mode waiver ("same reasoning applies — this doesn't touch
-- screening_result/decision criteria, it's a human reversing an earlier
-- human decision") — not a full re-review, but a real, logged one, not
-- assumed silently satisfied by reuse of pattern alone.
--
-- ============================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT BUILD
-- ============================================================
--   - The reopen route itself (e.g. POST /api/archive-search/
--     escalations/:id/reopen) or any UI. Q's (and, later, Tron's) future
--     work on top of this schema. This migration only makes a reopening
--     possible to RECORD and makes the view stop excluding a reopened
--     conversation automatically the moment reopened_at is set — nothing
--     here sets it.
--   - The generic-404-on-duplicate-report fix (Decision 2, above). That
--     is application code in archive-search/router.js's existing
--     POST /api/archive-search/escalate route — checking
--     archive_search_escalations directly for an existing 'open' row or
--     a 'confirmed' row with reopened_at IS NULL, before or independent
--     of the missive_message_intake_search_safe precondition check, and
--     returning a specific 409 with the reporter's name/date instead of
--     a generic 404. No column, index, or constraint below is missing
--     for that fix — it is Q's job to write the query, not this
--     migration's.
--   - Any change to `audit_log`. A future archive_search.
--     escalation_reopened event (actor_type: 'human', entity_type:
--     'archive_search_escalation', privacy_category: 'processing',
--     risk_level: 'high' — mirroring escalation_resolved's identical
--     values, matching not exceeding this project's existing ceiling for
--     a comparable human reversal) is already fully legal under
--     audit_log's real, current CHECK constraints (20260815000000_
--     audit_log_rule1_compliance.sql — action and entity_type carry no
--     CHECK at all; actor_type/privacy_category/risk_level's CHECKs
--     already include 'human'/'processing'/'high', confirmed directly
--     against that file, not assumed). No schema change needed. Writing
--     that event is Q's future reopen route's job.
--   - Any seed/grant row into team_member_tool_roles. No new tool value,
--     no new role value — reopening reuses the existing 'admin'
--     population for tool='archive_search' exactly like resolving
--     already does (spec Section 1); confirmed directly against
--     20260910030000_archive_search_schema.sql Section D. No ALTER TABLE
--     team_member_tool_roles statement appears anywhere in this file.
--   - Any change to missive_message_intake itself. Not one column,
--     constraint, or index on that table is touched. The one statement
--     below that touches anything beyond the new columns is a VIEW
--     replacement defined ON TOP of that table — the non-negotiable rule
--     ("never touch screening_result/_category/_tags/_version/
--     _completed_at on missive_message_intake — ever," restated in every
--     prior migration against this area) is fully upheld here too.
--   - Any change to archive_search_flagged_overrides, its own revocation
--     columns, or the search-safe view's override-inclusion clause. This
--     migration adds one more condition inside the escalations exclusion
--     clause only; the override clause is carried forward byte-for-byte.
--   - test/no-raw-table-access-check.js. No change needed — this
--     migration adds no new file that reads missive_message_intake by
--     name; it is a database migration, not application code.
--   - Any narrowing of the existing "status is one-way: open ->
--     confirmed or open -> false_alarm, never back to open" rule. This
--     migration does not add any path that sets status back to 'open',
--     and does not modify the resolution_fields_together CHECK that
--     already enforces that lifecycle. reopened_at/reopened_by/
--     reopen_reason are new, independent, layered-on-top facts about a
--     status = 'confirmed' row — the row's own status column, and the
--     original resolved_by/resolved_at/resolution_notes that recorded
--     the original confirmation, are never touched by a reopening.
-- ============================================================
--
-- ============================================================
-- WHY THIS MIGRATION NEEDS NO CONCURRENTLY STATEMENT — confirmed, not
-- assumed, per the task's own instruction to check rather than default
-- either way
-- ============================================================
-- CONCURRENTLY is a modifier of CREATE INDEX / REINDEX only — it has no
-- meaning for ALTER TABLE ADD COLUMN, ALTER TABLE ADD CONSTRAINT, or
-- CREATE OR REPLACE VIEW, and this migration contains no CREATE INDEX
-- statement at all (see the "no new index" note in Section 1 below), so
-- the question doesn't even arise for the statements that actually
-- appear here. For completeness, on lock behavior specifically:
--   1. ALTER TABLE ... ADD COLUMN (three nullable columns, no DEFAULT
--      expression to backfill) is a fast, metadata-only change in
--      Postgres 11+ — no table rewrite, because a nullable column with
--      no default is stored as implicitly NULL for every existing row
--      without touching a single existing row on disk.
--   2. ALTER TABLE ... ADD CONSTRAINT (the reopen-fields-together CHECK)
--      does scan the table to validate existing rows against the new
--      constraint — but archive_search_escalations is the same brand-
--      new table 20260912030000 created, with (per this project's own
--      standing note on that table) zero or, at most, a handful of real
--      rows, since no escalate route has been exercised in production
--      and no search UI yet exists to generate one. A scan of that size
--      is instantaneous.
--   3. CREATE OR REPLACE VIEW on missive_message_intake_search_safe is a
--      metadata-only catalog operation in Postgres — it does not scan or
--      rewrite missive_message_intake (or archive_search_escalations),
--      same fact 20260912010000's and 20260912030000's own migration
--      gate self-checks already confirmed the last two times this exact
--      view was modified.
-- Everything below is safe and correct to run as ONE ordinary script in
-- Supabase's SQL Editor, in one paste — no "run this alone" restriction,
-- because nothing here needs one.
-- ============================================================
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No.
--       Every column added is nullable with no default other than NULL,
--       so every row that exists before this migration runs (this table
--       almost certainly still empty, per the standing note on it) gets
--       reopened_at/reopened_by/reopen_reason = NULL, same as every row
--       inserted after this migration until a real reopening happens.
--       Because the new columns start NULL everywhere, the modified
--       view's new condition ("e.status = 'confirmed' AND e.reopened_at
--       IS NULL") is EXACTLY EQUIVALENT to the old, unconditional
--       "e.status = 'confirmed'" for every row that exists at the moment
--       this migration ships — this migration changes NOTHING about
--       what the view returns for any pre-existing row. Behavior changes
--       only once a real, future reopening sets reopened_at on some row,
--       which requires Q's not-yet-built reopen route.
--   [x] Does this touch a table other code depends on?
--       missive_message_intake_search_safe, yes — the one view every
--       archive-search search/message route is required to query. Per
--       the "does this break any existing data" answer above, no
--       currently-live code path changes behavior the moment this
--       ships, for the same reason: the new columns start NULL
--       everywhere, so the view's output is unchanged until a real
--       reopening exists.
--       archive_search_escalations, yes — the existing escalate/resolve
--       routes insert into and update this table today. Neither route's
--       existing INSERT or UPDATE statement names any column this
--       migration adds, so neither is affected: an INSERT that doesn't
--       mention reopened_at/reopened_by/reopen_reason leaves them NULL
--       (their only legal state pre-resolution anyway, per the new
--       CHECK below), and the existing resolve route's UPDATE only ever
--       sets status/resolved_by/resolved_at/resolution_notes, none of
--       which this migration touches or renames.
--       missive_message_intake, archive_search_flagged_overrides — NOT
--       touched (see "WHAT THIS MIGRATION DELIBERATELY DOES NOT BUILD").
--   [x] Additive or destructive? Fully additive — 3 new nullable
--       columns on an existing table, 1 new CHECK constraint, 1 modified
--       view (missive_message_intake_search_safe — one additive
--       narrowing of the existing escalation-exclusion condition from
--       "status IN ('open','confirmed')" to "status = 'open' OR
--       (status = 'confirmed' AND reopened_at IS NULL)", same columns,
--       same security_barrier setting, the override-inclusion clause
--       carried forward byte-for-byte). No column dropped anywhere, no
--       existing row updated, no existing constraint narrowed or
--       removed — the existing resolution_fields_together CHECK is
--       untouched, and status's own one-way lifecycle (open -> confirmed
--       or open -> false_alarm, never back to open) is preserved exactly
--       as-is; nothing here lets status revert to 'open'.
--   [ ] Tested on a copy of the data first? No staging copy of Supabase
--       exists in this project — same standing caveat every migration
--       here has carried to date. Mitigated by: the table this migration
--       alters starts empty or near-empty (nothing to corrupt); the ADD
--       COLUMN and CHECK-validation costs are trivial at that size; the
--       view replacement is a metadata-only catalog operation with no
--       data-migration step; and, mirroring Asimov's and Mason's own
--       carry-forward condition #2 on the original escalation mechanism,
--       a real spot-check in the first use of a future reopen route
--       (confirm a real reopened conversation actually reappears in
--       search on the very next query, and that its resolved_by/
--       resolved_at/resolution_notes/status = 'confirmed' are still
--       intact and unedited) is the recommended substantive replacement
--       for a staging rehearsal this project has never had available.
--   [x] Governance go-ahead needed? YES. Partially obtained, partially
--       flagged as an open item above rather than assumed closed: this
--       reuses a pattern (revoked_at/revoked_by/revocation_reason on
--       archive_search_flagged_overrides) Asimov and Mason already
--       cleared for the mirror-image mechanism, and answers a design
--       question (compliance/archive-search-escalation-mechanism-
--       review.md, Outstanding Items #3) the review itself named as
--       Peter's own yes/no to make, not a defect requiring their
--       re-review. It has NOT, as of this file, been walked back through
--       a fresh Asimov/Mason confirmation the way the original
--       escalation mechanism's Rule 6 shadow-mode waiver was (a real,
--       on-record "same reasoning applies" note, logged to audit_log).
--       Recommended, not blocking: get that same lightweight, on-record
--       confirmation before this ships live. Per Neo's own standing
--       role, this is Neo's build of Peter's own recorded decision using
--       an already-cleared pattern, not Neo's independent sign-off that
--       governance is fully closed — that confirmation, if sought, is
--       Asimov's and Mason's to give, and applying this file for real is
--       Peter's call alone, same as every migration in this schema.
-- ============================================================


-- ============================================================
-- SECTION 1: archive_search_escalations (add reopen columns)
--
-- Mirrors archive_search_flagged_overrides.revoked_at/revoked_by/
-- revocation_reason exactly, adapted to this table's status column.
-- reopened_at/reopened_by/reopen_reason are additive-only, layered on
-- top of a row that is (and remains) status = 'confirmed' — never a
-- rewrite of status, resolved_by, resolved_at, or resolution_notes. A
-- reopened row still shows, forever, in one row: that it WAS confirmed
-- (by whom, when, why) AND that it was later reopened (by whom, when,
-- why) — identical to how a revoked override still shows both of its
-- own life stages on the one row.
--
-- No new index. This table's own header (20260912030000) already
-- accepted the cost of an unindexed "status IN ('open','confirmed')"
-- narrowing inside the search-safe view's EXISTS check, on the reasoning
-- that this table is expected to stay small by design (escalations
-- should be rare) and the (missive_conversation_id, mailbox_key) pair
-- itself is already covered by the existing partial unique index for
-- the 'open' case. Narrowing that same condition further, to also check
-- reopened_at IS NULL for 'confirmed' rows, adds one more NULL check on
-- rows the planner has already found by that pair — not an additional
-- scan — so no new index is added here either, matching CLAUDE.md's
-- "keep it as simple as possible."
-- ============================================================

ALTER TABLE archive_search_escalations
  ADD COLUMN IF NOT EXISTS reopened_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reopened_by    TEXT,
  ADD COLUMN IF NOT EXISTS reopen_reason  TEXT;

-- Keeps the three reopen columns in lockstep, AND restricts reopening to
-- a 'confirmed' row only — a stronger constraint than
-- archive_search_flagged_overrides_revocation_fields_together needed,
-- because that table has no status column to couple against. There is
-- nothing to reopen on an 'open' row (it is already excluded and
-- pending review) or a 'false_alarm' row (it is already searchable —
-- resolving false_alarm already restored access; reopening one of those
-- would mean something different from what this decision asked for, and
-- is not what this CHECK permits).
ALTER TABLE archive_search_escalations
  ADD CONSTRAINT archive_search_escalations_reopen_fields_together
    CHECK (
      (reopened_at IS NULL AND reopened_by IS NULL AND reopen_reason IS NULL)
      OR
      (status = 'confirmed'
       AND reopened_at IS NOT NULL AND reopened_by IS NOT NULL
       AND reopen_reason IS NOT NULL AND length(trim(reopen_reason)) > 0)
    );

COMMENT ON COLUMN archive_search_escalations.reopened_at IS
  'NULL until a human decides a ''confirmed'' escalation was wrong and this conversation''s search access should be restored — Peter''s own decision, 2026-09-12 (compliance/archive-search-escalation-mechanism-review.md, Outstanding Items #3), mirroring archive_search_flagged_overrides.revoked_at''s identical reversal pattern for the mirror-image mechanism. Once set (together with reopened_by/reopen_reason — enforced by this table''s own reopen-fields-together CHECK), missive_message_intake_search_safe stops excluding this conversation on its very next query — no separate cleanup step. This NEVER changes status back to ''open'' and NEVER touches resolved_by/resolved_at/resolution_notes: the fact that this was once confirmed, by whom, when, and why remains permanently on this same row, alongside the new fact that it was later reopened, by whom, when, and why. Only legal while status = ''confirmed'' (enforced by the same CHECK) — an ''open'' report has nothing to reopen, and a ''false_alarm'' resolution already left the conversation searchable, so there is nothing here to reverse.';

COMMENT ON COLUMN archive_search_escalations.reopened_by IS
  'Who reopened a confirmed escalation — same TEXT attribution convention as reported_by/resolved_by (this table) and overridden_by/revoked_by (archive_search_flagged_overrides). NULL until reopened; once set, permanent — never cleared or reassigned afterward.';

COMMENT ON COLUMN archive_search_escalations.reopen_reason IS
  'Why a ''confirmed'' escalation was reopened — required, non-empty once set (enforced by the reopen-fields-together CHECK). Same restraint as escalation_reason/resolution_notes: describe why the original confirmation is now believed to have been wrong, do not quote or paraphrase the flagged correspondence itself into this field.';

COMMENT ON CONSTRAINT archive_search_escalations_reopen_fields_together
  ON archive_search_escalations IS
  'Keeps reopened_at/reopened_by/reopen_reason in lockstep, and restricts them to a status = ''confirmed'' row: either all three are NULL, or status = ''confirmed'' AND all three are set together with a non-empty reason. Prevents a partially-recorded reopening, and prevents "reopening" an ''open'' report (nothing to reopen) or a ''false_alarm'' resolution (already searchable, nothing to reverse) at the database level, not just in application code — same defense-in-depth discipline archive_search_flagged_overrides_revocation_fields_together already applies to its own reversal case.';

-- Reissued to reflect the new reversal path — same "keep the comment in
-- sync with the row's real lifecycle" discipline 20260912010000 already
-- applied to archive_search_flagged_overrides' own table comment when it
-- added revocation.
COMMENT ON TABLE archive_search_escalations IS
  'A human report of a suspected material Fair Housing concern encountered while using Archive Search (compliance/archive-search-fair-housing-outside-counsel-opinion.md, safeguard #5; projects/hub/email-intake/archive-search-escalation-mechanism-spec.md). Distinct from archive_search_flagged_overrides, which corrects a false-positive AI flag in the opposite direction. A row with status = ''open'', or status = ''confirmed'' with reopened_at IS NULL, makes missive_message_intake_search_safe stop returning the conversation immediately — never by writing to missive_message_intake itself. status is one-way: open -> confirmed or open -> false_alarm, never back to open; a later new report on the same conversation gets its own fresh row. A ''confirmed'' row''s search EXCLUSION, unlike its status, IS reversible: reopened_at/reopened_by/reopen_reason (added 2026-09-12, Peter''s own decision — compliance/archive-search-escalation-mechanism-review.md, Outstanding Items #3) layer a second, later human decision on top, mirroring archive_search_flagged_overrides.revoked_at''s identical pattern — the fact that this was once confirmed, by whom, when, and why is never erased or edited, only added to. No AI agent ever reads or writes this table — every row (report, resolution, or reopening) is a human act, per GOVERNANCE.md Rule 8 Tier 3 and the Fair Housing Standard''s Rule 7.';

COMMENT ON COLUMN archive_search_escalations.status IS
  'open: reported, pending admin review — the conversation is excluded from search. confirmed: an admin determined this is a real concern — excluded from search unless and until reopened (reopened_at IS NULL keeps the exclusion in place; see reopened_at''s own comment for the reversal path added 2026-09-12). status itself never changes away from ''confirmed'', even once reopened, so the fact of the original confirmation stays permanent. false_alarm: an admin determined this was not a real concern — the conversation reappears in search on the very next query once this status is set, with no further action needed, exactly the same "no separate cleanup step" mechanic archive_search_flagged_overrides.revoked_at already documents for its own reversal case.';


-- ============================================================
-- SECTION 2: missive_message_intake_search_safe (modified view)
--
-- One further additive narrowing, on top of 20260912030000's own
-- exclusion clause. That migration excluded a conversation for ANY
-- escalation with status IN ('open', 'confirmed'). This narrows the
-- 'confirmed' half of that condition to also require reopened_at IS
-- NULL — a 'confirmed' escalation that has since been reopened no
-- longer excludes its conversation. The 'open' half is unchanged
-- (unconditionally excluded, pending review, exactly as before), and
-- 'false_alarm' rows were never excluded and still aren't. The override-
-- inclusion clause (archive_search_flagged_overrides) is carried
-- forward byte-for-byte, untouched. security_barrier = true unchanged.
-- ============================================================

CREATE OR REPLACE VIEW missive_message_intake_search_safe
WITH (security_barrier = true) AS
SELECT *
FROM missive_message_intake m
WHERE (
    m.screening_result = 'clear'
    OR EXISTS (
      SELECT 1
      FROM archive_search_flagged_overrides o
      WHERE o.missive_conversation_id           = m.missive_conversation_id
        AND o.mailbox_key                       = m.mailbox_key
        AND o.overridden_screening_completed_at = m.screening_completed_at
        AND o.revoked_at IS NULL
    )
  )
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

-- The new condition uses only "=" / "IS NULL" comparisons, same as every
-- predicate this view has ever used — security_barrier's leakproofness
-- guarantee is unaffected, same confirmed reasoning 20260912010000's and
-- 20260912030000's own migrations already gave the last two times a
-- clause was added here. Real, honest performance note, not glossed
-- over: this replaces one condition ("status IN ('open','confirmed')")
-- with a logically-equivalent-or-narrower one that costs one extra NULL
-- check per already-matched row (see Section 1's "no new index" note
-- above) — not an additional scan, and not expected to change this
-- view's already-accepted performance profile at this table's expected
-- scale.

COMMENT ON VIEW missive_message_intake_search_safe IS
  'The ONLY view every archive-search search/message route may query — never missive_message_intake directly, with the one named exception of screening-pass.js. Extended three times: archive-search-flagged-review-spec.md (20260912010000) added the override inclusion clause; archive-search-escalation-mechanism-spec.md (20260912030000) added the escalation exclusion clause; this migration (20260912040000) narrowed that exclusion so a ''confirmed'' escalation with reopened_at IS NOT NULL no longer excludes its conversation — an ''open'' escalation still excludes unconditionally, pending review. Resolving an escalation as false_alarm, or reopening a confirmed one, both remove the exclusion on the very next query, with no separate cleanup step.';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- -- Reverts missive_message_intake_search_safe to its definition from
-- -- 20260912030000 (escalation-exclusion-aware, reopen-unaware). Safe at
-- -- any time — this only changes which rows the view returns, never any
-- -- stored data. If any escalation has ever really been reopened, rolling
-- -- back this view makes that conversation excluded from search again
-- -- immediately, even though the confirmed row was reopened — confirm
-- -- this is intended first:
-- -- SELECT * FROM archive_search_escalations WHERE reopened_at IS NOT NULL;
--
-- CREATE OR REPLACE VIEW missive_message_intake_search_safe
-- WITH (security_barrier = true) AS
-- SELECT *
-- FROM missive_message_intake m
-- WHERE (
--     m.screening_result = 'clear'
--     OR EXISTS (
--       SELECT 1
--       FROM archive_search_flagged_overrides o
--       WHERE o.missive_conversation_id           = m.missive_conversation_id
--         AND o.mailbox_key                       = m.mailbox_key
--         AND o.overridden_screening_completed_at = m.screening_completed_at
--         AND o.revoked_at IS NULL
--     )
--   )
--   AND NOT EXISTS (
--     SELECT 1
--     FROM archive_search_escalations e
--     WHERE e.missive_conversation_id = m.missive_conversation_id
--       AND e.mailbox_key             = m.mailbox_key
--       AND e.status IN ('open', 'confirmed')
--   );
--
-- -- Drops the reopen mechanism itself. This table is the only durable
-- -- record that a 'confirmed' escalation was ever reopened — by whom,
-- -- when, why (audit_log's own future archive_search.escalation_reopened
-- -- event, once a reopen route ships, is the one remaining record if
-- -- these columns are ever dropped after real use). Confirm no real row
-- -- has reopened_at set (query above), or that losing that record is
-- -- truly intended, before dropping these columns for real.
-- ALTER TABLE archive_search_escalations
--   DROP CONSTRAINT IF EXISTS archive_search_escalations_reopen_fields_together;
-- ALTER TABLE archive_search_escalations
--   DROP COLUMN IF EXISTS reopen_reason,
--   DROP COLUMN IF EXISTS reopened_by,
--   DROP COLUMN IF EXISTS reopened_at;
--
-- ============================================================
