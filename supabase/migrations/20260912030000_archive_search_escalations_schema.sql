-- ============================================================
-- Migration: 20260912030000_archive_search_escalations_schema
-- Created:   2026-09-12
-- Author:    Neo (database specialist)
--
-- Builds projects/hub/email-intake/archive-search-escalation-mechanism-
-- spec.md, Section 3 ("The Escalation Mechanism — Pull First, Review
-- Second") — the employee escalation mechanism for material Fair
-- Housing concerns, safeguard #5 of outside counsel's Option B opinion
-- (compliance/archive-search-fair-housing-outside-counsel-opinion.md).
-- This is the FIRST migration for this spec; none of its schema exists
-- live yet.
--
-- Builds the spec's Section 3.2 SQL AS DRAFTED, with zero changes —
-- unlike 20260912010000 (the flagged-overrides schema), which had to
-- add a revocation path Mason required beyond the original draft, this
-- draft already went through Asimov's and Mason's real review (both
-- read in full before this file was written) and both cleared it on the
-- schema as written, with three carry-forward conditions that are
-- process/paperwork items for Q's build and Peter's ongoing use, not
-- schema changes:
--   1. Asimov's required Rule 6 change-management log entry (the
--      shadow-mode waiver itself, previous position -> new position,
--      with the corrected "doesn't touch decision criteria" reasoning)
--      goes to audit_log as its own entry when Q builds the routes —
--      not a schema change; audit_log already has every field this
--      needs (Rule 1 compliance migration, 20260815000000).
--   2. A spot-check in the first 1-2 weeks of real use (an escalated
--      conversation actually disappears from search; a false_alarm
--      resolution actually restores it) — an operational/TARS step, not
--      schema.
--   3. Mason's one open loose end (attorney-review prong of Rule 6,
--      specific implementation choices not yet counsel-confirmed
--      line-by-line) — a legal/paperwork item, not something any
--      column, index, or constraint below can satisfy.
-- None of the three block this migration; Asimov's and Mason's verdicts
-- both say so explicitly ("CLEARED FOR NEO AND Q TO BUILD").
--
-- Governance status: this IS a GOVERNANCE.md compliance build — it
-- stores personal data (a staff member's name reporting and, later,
-- resolving a concern; free text describing both) and changes what up
-- to 8 people can see of Archive Search content, on a Fair-Housing
-- basis. Per CLAUDE.md's Governance & Compliance section and
-- GOVERNANCE.md's Integrity Rule 4 ("Neo gate is mandatory for every
-- migration"), this file is NOT applied by Neo — Peter applies every
-- migration himself via Supabase's SQL Editor, per this project's
-- standing convention (no CLI/DB URL in this environment). Per Neo's
-- own standing role, Neo does not approve its own migrations; that
-- approval is Peter's, and it already has Asimov's and Mason's
-- governance/legal clearance on record (both reviews read in full
-- before this file was written; verdicts summarized above).
--
-- ============================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT BUILD
-- ============================================================
--   - The three routes (escalate, escalations-review-export, resolve)
--     or any UI. All Q's (and, later, Tron's) work on top of this
--     schema, per the spec's Section 3.3. This migration only makes an
--     escalation possible to RECORD and makes the view exclusion
--     happen automatically the moment a row exists — nothing here
--     inserts a row or sends an email.
--   - Any change to `audit_log`. archive_search.escalation_reported,
--     .escalation_resolved, and .escalation_review_export_generated
--     (spec Section 4) all use actor_type='human',
--     privacy_category='processing', and risk_level IN ('high',
--     'medium') — every one of those values already legal under
--     audit_log's real, current CHECK constraints
--     (20260815000000_audit_log_rule1_compliance.sql, confirmed
--     directly against that file, not assumed). No schema change
--     needed. Writing those three events is Q's future routes' job.
--   - The Rule 6 change-management log entry itself (Asimov's carry-
--     forward condition #1 above). That is a write to the EXISTING
--     audit_log schema (already fully able to hold it — no column is
--     missing), made once, by whoever builds/ships the routes — not a
--     migration, and not repeated here as a pre-written INSERT because
--     this migration doesn't know the routes' real trace/decision IDs
--     yet.
--   - Any seed/grant row into team_member_tool_roles. No new tool
--     value, no new role value — confirmed directly against
--     20260910030000_archive_search_schema.sql Section D: 'searcher'
--     and 'admin' already exist for tool='archive_search'. This build
--     reuses both exactly as the spec's Section 1 already settled, and
--     neither Asimov's nor Mason's review disputed it. No ALTER TABLE
--     team_member_tool_roles statement appears anywhere in this file.
--   - Any change to missive_message_intake itself. Not one column,
--     constraint, or index on that table is touched. Every statement
--     below either creates a brand-new table or replaces a VIEW defined
--     on top of that table. The spec's own non-negotiable rule ("never
--     touch screening_result/_category/_tags/_version/_completed_at on
--     missive_message_intake — ever," Section 3.1) is fully upheld,
--     identical discipline to 20260912010000's own build of the
--     flagged-overrides mechanism.
--   - test/no-raw-table-access-check.js. No change needed — confirmed
--     directly against the spec's own Section 3.2 closing note: this
--     migration adds no new file that reads missive_message_intake by
--     name; the one raw-table read the future export route needs
--     (Section 3.3's body_text lookup) is Q's job to add to
--     screening-pass.js's own already-exempt module, not this
--     migration's.
-- ============================================================
--
-- ============================================================
-- WHY THIS MIGRATION NEEDS NO CONCURRENTLY STATEMENT, UNLIKE THE TWO
-- MOST RECENT MIGRATIONS AGAINST THIS SAME AREA OF THE SCHEMA
-- (20260911010000, 20260912020000) — read and confirmed, not assumed
-- ============================================================
-- Both of those needed CONCURRENTLY because they built an index ON
-- missive_message_intake itself — a live table with 254,000+ rows and a
-- cron job writing to it on its own schedule, where a plain (non-
-- CONCURRENTLY) CREATE INDEX takes a SHARE lock for the full, slow
-- build duration and blocks every write for that whole time.
--
-- Neither statement below has that problem:
--   1. archive_search_escalations is a BRAND-NEW, EMPTY table. Its two
--      indexes (the partial unique index and the reported_at index) are
--      built on zero rows — instantaneous, and there is no concurrent
--      writer to block because nothing has ever written to a table that
--      doesn't exist yet until this same migration creates it.
--   2. CREATE OR REPLACE VIEW on missive_message_intake_search_safe is
--      a metadata-only catalog operation in Postgres — it does not scan
--      or rewrite missive_message_intake, and takes no lock that
--      conflicts with ordinary reads/writes against that table. Same
--      fact 20260912010000's own migration gate self-check already
--      confirmed for this exact statement the last time this view was
--      modified.
-- CONCURRENTLY cannot be used inside a transaction block, and everything
-- below is safe and correct to run as ONE ordinary script in Supabase's
-- SQL Editor, in one paste, unlike 20260911010000 and 20260912020000 —
-- this file carries no "run this alone" restriction because it has
-- nothing that needs one. Learned directly from the real mistake TARS
-- and Judge caught earlier today (20260912020000's own header): a
-- CONCURRENTLY statement must be the ONLY statement in its file, never
-- paired with a COMMENT or anything else, because a multi-statement
-- paste gets wrapped in one implicit transaction. This file has no
-- CONCURRENTLY statement anywhere, so that failure mode cannot occur
-- here regardless of how it's pasted.
-- ============================================================
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No.
--       archive_search_escalations is a brand-new table — nothing
--       existing reads or writes it, and it starts empty. The CREATE OR
--       REPLACE VIEW on missive_message_intake_search_safe is additive
--       in the "what's excluded" direction, not the "what's included"
--       direction (unlike 20260912010000's own change, which added an
--       inclusion clause) — it can only ever make the view return FEWER
--       rows than it does today, never more, and only for a conversation
--       that has an 'open' or 'confirmed' row in the new table, which
--       today has zero rows. Applying this migration changes NOTHING
--       about what the view returns until the very first escalation is
--       ever reported — a fact worth stating plainly, not just implying.
--   [x] Does this touch a table other code depends on?
--       missive_message_intake_search_safe, yes — the one view every
--       archive-search search/message route is required to query
--       (technical spec's Finding 1). Per this same migration's "does
--       this break any existing data" answer above, no currently-live
--       code path changes behavior the moment this ships, because the
--       new table starts empty; behavior only changes once a real
--       report exists, which requires Q's not-yet-built escalate route.
--       missive_message_intake itself — NOT touched (see "WHAT THIS
--       MIGRATION DELIBERATELY DOES NOT BUILD" above).
--       archive_search_flagged_overrides — NOT touched; this migration
--       adds a second, independent EXISTS-based exclusion clause to the
--       view, and does not modify that table, its own EXISTS clause, or
--       anything about how the override mechanism works.
--   [x] Additive or destructive? Fully additive — 1 new table (10
--       columns), 1 new CHECK constraint on that new table (resolution
--       fields together), 1 new partial unique index, 1 new plain index,
--       RLS enabled with zero permissive policies, 1 modified view
--       (missive_message_intake_search_safe — one additive AND NOT
--       EXISTS clause, same columns, same security_barrier setting, the
--       existing OR-EXISTS override clause carried forward unchanged).
--       No column dropped anywhere, no existing row updated, no
--       existing constraint narrowed.
--   [ ] Tested on a copy of the data first? No staging copy of Supabase
--       exists in this project — same standing caveat every migration
--       here has carried to date. Mitigated by: the new table starts
--       empty (nothing to corrupt); the view replacement is a metadata-
--       only catalog operation with no data-migration step (see the
--       CONCURRENTLY section above); and, per Asimov's and Mason's own
--       carry-forward condition #2, a real spot-check against production
--       is recommended in the first 1-2 weeks of actual use (report a
--       real conversation, confirm it vanishes from search; resolve it
--       false_alarm, confirm it reappears) as the substantive
--       replacement for a staging rehearsal this project has never had
--       available for this table.
--   [x] Governance go-ahead needed? YES, and already obtained. This is
--       a GOVERNANCE.md compliance build (new personal-data table;
--       changes what up to 8 people can see of Fair-Housing-relevant
--       content). Asimov's review: "CLEARED FOR NEO AND Q TO BUILD,"
--       conditioned on three carry-forward items (Rule 6 audit-log
--       entry, a real-use spot-check, logging the waiver itself) that
--       are Q's/Peter's follow-through, not schema gaps — none block
--       this file. Mason's review: "Neo and Q can start on the schema
--       and routes now," with one open loose end (the attorney-review
--       prong of Rule 6) that is explicitly a paperwork/process step,
--       not a redesign, and explicitly does not block the build
--       starting. Per Neo's own standing role, this is Neo's build of
--       an already-cleared design, not Neo's independent sign-off that
--       it's cleared — that confirmation is Asimov's and Mason's, given
--       above, and applying this file for real is Peter's call alone,
--       same as every migration in this schema.
-- ============================================================


-- ============================================================
-- SECTION 1: archive_search_escalations (new table)
--
-- One row per human report of a suspected material Fair Housing concern
-- encountered while using Archive Search (safeguard #5). See the spec's
-- Section 3.1 for the full design rationale (why immediate, structural
-- exclusion rather than a passive flag) and Section 3.2's own column-
-- by-column comments (restated as COMMENT ON COLUMN statements below).
--
-- NOT the same mechanism as archive_search_flagged_overrides. That
-- table corrects a false-positive AI flag (the AI said 'flagged', a
-- human says 'no, restore it'). This table records the mirror-image,
-- opposite-direction fact: a human proactively reporting a concern the
-- AI check did not catch. Different direction, different population
-- initiating it (the full searcher+admin population, not admin-only),
-- different default disposition (exclude on report, not include), and,
-- per this section, a different table — never touches
-- archive_search_flagged_overrides, and archive_search_flagged_overrides
-- never touches this one.
--
-- Lifecycle: 'open' -> 'confirmed' or 'open' -> 'false_alarm', never
-- back to 'open' — same "never edit history, add a new row for new
-- state" discipline archive_search_validation_sample.sample_run already
-- uses. A re-report after a resolution gets its own fresh row (the
-- partial unique index below only applies WHERE status = 'open', so it
-- never blocks that).
--
-- No `updated_at`, despite CLAUDE.md's default id/created_at/updated_at
-- house style — same deliberate omission archive_search_flagged_
-- overrides already makes, for the same reason: the one event this
-- table can undergo after insert (resolution) is already timestamped by
-- resolved_at itself, so a generic updated_at would just duplicate that
-- value under a less specific name. No separate `created_at` either —
-- reported_at already serves that purpose under a name that says what
-- actually happened, not just when the row appeared.
-- ============================================================

CREATE TABLE IF NOT EXISTS archive_search_escalations (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Same compound identity convention as archive_search_flagged_overrides
  -- and missive_message_intake_held_review_safe/_flagged_review_safe — a
  -- conversation id is unique only within a mailbox.
  missive_conversation_id   TEXT        NOT NULL,
  mailbox_key               TEXT        NOT NULL,

  -- The report itself.
  reported_by               TEXT        NOT NULL,
  reported_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  escalation_reason         TEXT        NOT NULL
    CHECK (length(trim(escalation_reason)) > 0),

  -- Lifecycle: 'open' until an admin resolves it one of two ways. Never
  -- reverts to 'open' once resolved.
  status                    TEXT        NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'confirmed', 'false_alarm')),

  resolved_by               TEXT,
  resolved_at               TIMESTAMPTZ,
  resolution_notes          TEXT,

  -- Same "all-or-nothing together" discipline as
  -- archive_search_flagged_overrides' revocation-fields-together CHECK:
  -- either still open (all three NULL) or resolved (all three set, with
  -- a real, non-empty reason).
  CONSTRAINT archive_search_escalations_resolution_fields_together
    CHECK (
      (status = 'open' AND resolved_by IS NULL AND resolved_at IS NULL AND resolution_notes IS NULL)
      OR
      (status IN ('confirmed', 'false_alarm') AND resolved_by IS NOT NULL
       AND resolved_at IS NOT NULL AND resolution_notes IS NOT NULL
       AND length(trim(resolution_notes)) > 0)
    )
);

-- Prevents a double-submit (or two different searchers independently
-- reporting the same still-open conversation) from producing two
-- redundant open rows for the one conversation. A genuinely NEW report
-- after a prior one is resolved gets its own row, since this partial
-- index only applies WHERE status = 'open'. Brand-new, empty table —
-- no CONCURRENTLY needed (see header note above).
CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_search_escalations_one_open_per_conversation
  ON archive_search_escalations (missive_conversation_id, mailbox_key)
  WHERE status = 'open';

-- Serves the escalations-review-export route's own "ordered by
-- reported_at DESC" listing (spec Section 3.3). Brand-new, empty table
-- — no CONCURRENTLY needed.
CREATE INDEX IF NOT EXISTS idx_archive_search_escalations_reported_at
  ON archive_search_escalations (reported_at DESC);

ALTER TABLE archive_search_escalations ENABLE ROW LEVEL SECURITY;
-- RLS enabled, zero permissive policies — same default every table in
-- this schema uses; access is gated in application code
-- (requireArchiveSearchAccess to report, requireArchiveSearchAdmin to
-- review/resolve), not by RLS.

COMMENT ON TABLE archive_search_escalations IS
  'A human report of a suspected material Fair Housing concern encountered while using Archive Search (compliance/archive-search-fair-housing-outside-counsel-opinion.md, safeguard #5; projects/hub/email-intake/archive-search-escalation-mechanism-spec.md). Distinct from archive_search_flagged_overrides, which corrects a false-positive AI flag in the opposite direction. A row with status IN (''open'',''confirmed'') makes missive_message_intake_search_safe stop returning the conversation immediately — never by writing to missive_message_intake itself. status is one-way: open -> confirmed or open -> false_alarm, never back to open; a later new report on the same conversation gets its own fresh row. No AI agent ever reads or writes this table — every row is a human act (report or resolve), per GOVERNANCE.md Rule 8 Tier 3 and the Fair Housing Standard''s Rule 7.';

COMMENT ON COLUMN archive_search_escalations.escalation_reason IS
  'Required, non-empty (CHECK-enforced). Same guidance as archive_search_flagged_overrides.override_reason: describe what concerned you and why — do not quote or paraphrase the flagged correspondence itself into this field.';

COMMENT ON COLUMN archive_search_escalations.status IS
  'open: reported, pending admin review — the conversation is excluded from search. confirmed: an admin determined this is a real concern — stays excluded from search, permanently, as its own recorded fact (mirrors how screening_result = ''flagged_protected_class'' with no override already works, without ever touching that column). false_alarm: an admin determined this was not a real concern — the conversation reappears in search on the very next query once this status is set, with no further action needed, exactly the same "no separate cleanup step" mechanic archive_search_flagged_overrides.revoked_at already documents for its own reversal case.';

COMMENT ON COLUMN archive_search_escalations.resolution_notes IS
  'Required, non-empty once resolved. Same restraint as escalation_reason and (in archive_search_flagged_overrides) override_reason/revocation_reason: describe the disposition and why, do not quote the correspondence itself.';

COMMENT ON CONSTRAINT archive_search_escalations_resolution_fields_together
  ON archive_search_escalations IS
  'Keeps resolved_by/resolved_at/resolution_notes in lockstep: either all three are NULL (status = ''open'') or all three are set together with a non-empty reason (status IN (''confirmed'',''false_alarm'')). Prevents a partially-recorded resolution at the database level, not just in application code — same defense-in-depth discipline archive_search_flagged_overrides_revocation_fields_together already applies to its own reversal case.';


-- ============================================================
-- SECTION 2: missive_message_intake_search_safe (modified view)
--
-- One further additive change, on top of archive-search-flagged-review-
-- spec.md's own addition (20260912010000). That migration added an
-- inclusion clause (OR EXISTS ... override, revoked_at IS NULL). This
-- adds an exclusion clause (AND NOT EXISTS ... escalation) that applies
-- REGARDLESS of screening_result or any override — an escalated
-- conversation is pulled from search even if it was previously 'clear',
-- and even if it was previously flagged AND already overridden.
-- security_barrier = true unchanged.
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
      AND e.status IN ('open', 'confirmed')
  );

-- Both EXISTS subqueries use only leakproof "=" / "IN"/"IS NULL"
-- comparisons — security_barrier's guarantee is unaffected by adding
-- this second clause, same reasoning 20260912010000's own migration
-- already confirmed when it added the first one. Real, honest
-- performance note, not glossed over: this is now two correlated EXISTS
-- checks per row that isn't already screening_result = 'clear',
-- evaluated against two tables both expected to stay small (overrides
-- and escalations should both be rare, by design) and both already
-- indexed for their exact lookup shape (the override table by its own
-- UNIQUE constraint; this new escalations table by
-- idx_archive_search_escalations_one_open_per_conversation, which
-- covers the (missive_conversation_id, mailbox_key) pair the NOT EXISTS
-- filters on, though not the status IN (...) narrowing — a minor,
-- expected-negligible-at-this-scale cost, not benchmarked here and not
-- asserted as free.

COMMENT ON VIEW missive_message_intake_search_safe IS
  'The ONLY view every archive-search search/message route may query — never missive_message_intake directly, with the one named exception of screening-pass.js. Extended twice: archive-search-flagged-review-spec.md (20260912010000) added the override inclusion clause; archive-search-escalation-mechanism-spec.md (20260912030000) added this exclusion clause — a conversation with an open or confirmed entry in archive_search_escalations is excluded from this view immediately, regardless of screening_result or any override on file. Resolving an escalation as false_alarm removes the exclusion on the very next query, with no separate cleanup step.';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- -- Reverts missive_message_intake_search_safe to its PRIOR definition
-- -- (20260912010000 — override-aware, escalation-unaware). Safe at any
-- -- time — this only changes which rows the view returns, never any
-- -- stored data. Confirm no real escalation exists first (query below)
-- -- before rolling back, if this has been live for real use: rolling
-- -- back the view makes any currently-excluded (open/confirmed)
-- -- conversation searchable again immediately, before the table itself
-- -- is dropped.
-- -- SELECT * FROM archive_search_escalations WHERE status IN ('open','confirmed');
--
-- CREATE OR REPLACE VIEW missive_message_intake_search_safe
-- WITH (security_barrier = true) AS
-- SELECT *
-- FROM missive_message_intake m
-- WHERE m.screening_result = 'clear'
--    OR EXISTS (
--      SELECT 1
--      FROM archive_search_flagged_overrides o
--      WHERE o.missive_conversation_id           = m.missive_conversation_id
--        AND o.mailbox_key                       = m.mailbox_key
--        AND o.overridden_screening_completed_at = m.screening_completed_at
--        AND o.revoked_at IS NULL
--    );
--
-- DROP INDEX IF EXISTS idx_archive_search_escalations_reported_at;
-- DROP INDEX IF EXISTS idx_archive_search_escalations_one_open_per_conversation;
--
-- -- This table is the only durable record that a human ever reported a
-- -- suspected Fair Housing concern, and (once resolved) the only durable
-- -- record of how and by whom it was resolved — audit_log's own
-- -- archive_search.escalation_reported / .escalation_resolved events are
-- -- the one remaining record if this table is ever dropped after real
-- -- use. Confirm no real row exists (or that losing this record is truly
-- -- intended) before dropping it for real.
-- DROP TABLE IF EXISTS archive_search_escalations;
--
-- ============================================================
