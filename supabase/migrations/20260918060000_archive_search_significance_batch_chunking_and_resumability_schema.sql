-- ============================================================
-- Migration: 20260918060000_archive_search_significance_batch_chunking_and_resumability_schema
-- Created:   2026-09-18
-- Author:    Neo (database specialist)
--
-- INCIDENT THIS MIGRATION EXISTS TO FIX (tonight, 2026-09-18): an 8-hour
-- eligibility scan (fetchNextEligibleConversations() / fetchDriverPage() in
-- projects/hub/archive-search/lib/significance-pass.js — itself a known,
-- accepted cost from an earlier fix tonight, migration 20260918020000)
-- assembled 84,408 real conversations for a 'call_1' batch submission. The
-- actual anthropic.beta.messages.batches.create() call then failed with a
-- real 413: "request_too_large ... The Message Batches API accepts
-- requests up to 256MBs." Confirmed nothing was billed (Anthropic rejects
-- an oversized request before accepting it) — but the entire 8-hour scan's
-- results were lost, because lib/significance-batch.js's submitBatch()
-- (20260917020000's own application code) writes NOTHING to the database
-- until AFTER a batch has actually been submitted. Anthropic's real limits
-- were re-verified live against platform.claude.com/docs (not assumed)
-- while designing this fix: a Message Batch is capped at 100,000 requests
-- OR 256 MB, WHICHEVER IS REACHED FIRST. The 100,000-request cap
-- (MAX_BATCH_REQUESTS, already correct in significance-batch.js) was never
-- the problem; nothing before tonight ever checked the 256 MB byte cap at
-- all.
--
-- THIS MIGRATION IS SCHEMA ONLY, same convention as 20260917020000 — no
-- application code, and it does not itself authorize submitting any real
-- batch to Anthropic. The two real fixes this schema enables (Q's build,
-- on top of this migration):
--   1. SIZE-AWARE CHUNKING — submitBatch()'s replacement must estimate
--      each request's real serialized byte size (e.g.
--      Buffer.byteLength(JSON.stringify(request), 'utf8') — NOT
--      .length, which counts UTF-16 code units, not bytes, and would
--      under-count any non-ASCII character in real tenant/owner email
--      text) as it builds each request, and cut a new chunk before a
--      running total would exceed a real safety margin below 256 MB —
--      never the exact number. This migration's own tables exist to hold
--      the resulting one-run-becomes-many-chunks/many-batches shape;
--      the actual chunking arithmetic is Q's application code, not
--      enforced here.
--   2. RESUMABILITY — the assembled, deduplicated eligible list must be
--      persisted to real tables BEFORE any Anthropic call is ever made,
--      so a crash or interruption after the expensive scan but before
--      every resulting chunk is submitted never requires re-running
--      fetchNextEligibleConversations. That function itself is UNCHANGED
--      by this migration — see THE RUN MODEL below for why calling it
--      exactly once per run, rather than modifying its own exclusion
--      logic, is what actually makes this safe.
--
-- ============================================================
-- THE RUN MODEL — why two new tables, not a tweak to the existing ones
-- ============================================================
-- 20260917020000's own schema assumes ONE Anthropic batch per submission
-- attempt: archive_search_significance_batches held a real
-- anthropic_batch_id from the moment a row was ever written (no
-- "reserved but not yet submitted" state), and its own
-- idx_archive_search_significance_batches_one_unfinished_per_stage unique
-- partial index was the entire double-submission guard — at most one
-- unfinished batch per stage, ever.
--
-- Tonight's fix needs a submission attempt to become MULTIPLE Anthropic
-- batches (chunks), all safely under 256 MB each. That breaks the old
-- guard's own assumption: two chunks of the SAME submission legitimately
-- need to be unfinished (in_progress at Anthropic, for up to 24 hours
-- each) AT THE SAME TIME — the whole point of allowing chunks to run
-- concurrently rather than serially (see PARALLEL CHUNKS below). So the
-- one-unfinished-per-stage guarantee cannot stay on
-- archive_search_significance_batches at all; it has to move up one
-- level, to a new concept this schema calls a SUBMISSION RUN: one call to
-- fetchNextEligibleConversations() for one stage, whose resulting eligible
-- set is then split into however many chunks 256 MB/100,000 requests
-- requires. A run, not a batch, is now the thing there is only ever one
-- unfinished one of, per stage (see SECTION A's own unique index).
--
-- WHY NOT JUST RELAX archive_search_significance_batches' OWN INDEX AND
-- CALL IT DONE — because that index was never just "don't waste a
-- request," it was the ONLY thing preventing fetchNextEligibleConversations
-- from re-selecting a conversation that's already been submitted but has
-- no missive_conversation_significance row yet (that row is only written
-- at write-back, by design — see 20260917020000's own Rule 9 note).
-- Simply allowing multiple unfinished batches per stage with no
-- replacement guard would silently reopen exactly that double-submission
-- hole. The replacement guard (SECTION A's unique index, on runs, not
-- batches) closes it the same way the original did — at the database
-- layer, not by trusting application code to check first — just scoped to
-- the right unit of work now that "one submission attempt" and "one
-- Anthropic batch" are no longer the same thing.
--
-- WHY A NEW submission_run_items TABLE, NOT A NULLABLE batch_id ON THE
-- EXISTING archive_search_significance_batch_items (the question Q's own
-- request for this migration asked directly): that table's
-- UNIQUE(batch_id, mailbox_key, missive_conversation_id) constraint is
-- exactly what stops the same conversation being submitted twice within
-- one batch — but Postgres treats every NULL as distinct from every other
-- NULL in a UNIQUE constraint. Making batch_id nullable to hold
-- "staged, not yet submitted" rows would silently stop that constraint
-- from protecting the pre-submission staging state at all: any number of
-- (NULL, mailbox_key, missive_conversation_id) rows could coexist without
-- ever violating it. That is a real, subtle correctness gap, not a style
-- preference — reusing that table for staging was considered and
-- rejected for this reason. A dedicated child table, scoped to a run
-- instead of a batch, keeps 20260917020000's own tables and their
-- existing, carefully-reasoned constraints completely untouched (purely
-- additive, same discipline that migration's own header already
-- establishes) and gets its OWN correct uniqueness constraint instead
-- (SECTION B).
--
-- HOW NO CONVERSATION IS EVER SUBMITTED TWICE (the actual, end-to-end
-- guarantee, spelled out because the task this migration answers asked
-- for it explicitly):
--   1. fetchNextEligibleConversations() is called EXACTLY ONCE per run —
--      an application-code discipline Q's build must follow, not
--      something this schema can enforce by itself, but the ONLY change
--      this design needs from that function: it is otherwise reused
--      completely unmodified. Its own existing dedup
--      (dedupeNewPairs/filterAlreadyProcessed) already guarantees the
--      returned list itself has no duplicates.
--   2. That whole list is inserted into archive_search_significance_
--      submission_run_items ONCE, immediately, before any Anthropic call —
--      this INSERT succeeding is the durability checkpoint that makes the
--      8-hour scan crash-safe. UNIQUE(run_id, mailbox_key,
--      missive_conversation_id) below is the database-level backstop on
--      top of the application-level dedup already done upstream.
--   3. Chunk boundaries are then assigned to these already-persisted rows
--      in one deterministic left-to-right pass (by sequence_in_run,
--      Q's build) — every row gets exactly one chunk_number, exactly
--      once. Dispatch only ever touches rows with batch_id IS NULL (the
--      resume query, SECTION B's own partial index), so a row already
--      assigned to an earlier chunk can never be picked up by a later
--      one, even across separate, interrupted dispatch runs.
--   4. Because the eligible list is fixed and partitioned BEFORE any
--      submission happens, and never re-queried, no code path exists that
--      could ask "what's still eligible" mid-run and get back a
--      conversation already claimed by an earlier chunk of the same run —
--      the exact failure mode named in this migration's own request.
--   5. And because SECTION A's unique index guarantees at most one
--      unfinished run per stage, no SECOND run can start (and therefore
--      no second fetchNextEligibleConversations() call can happen) while
--      an earlier run's conversations are still mid-flight with no
--      significance row yet to exclude them the ordinary way.
--
-- ============================================================
-- PARALLEL CHUNKS — chosen over serial, with reasoning, per this
-- migration's own request to state it either way
-- ============================================================
-- Serial (submit chunk 1, wait for it to reach completed_at, only then
-- submit chunk 2) was considered and rejected: a single Anthropic batch
-- can take up to 24 hours on its own, so N serialized chunks could take
-- up to N days for one submission run — unacceptable for an operational
-- pipeline Peter is waiting on results from. Parallel dispatch (submit
-- every chunk's .create() call back-to-back, without waiting for any of
-- them to finish processing, then let Q's existing per-batch polling
-- logic check on each independently) does NOT reintroduce the
-- double-submission risk that would normally make "many things in flight
-- at once" dangerous, because — per THE RUN MODEL above — correctness
-- here never depended on "only one thing in flight." It depends on the
-- eligible set being fixed and partitioned before ANY submission call, a
-- property that holds identically whether the resulting chunks are
-- dispatched one second or one day apart. Real operational risk this
-- migration does NOT solve (flagged for Q, not a schema question):
-- Anthropic's own Batches API rate limits ("the number of requests within
-- a batch waiting to be processed," per their docs) could reject a rapid
-- back-to-back .create() call for a large chunk with a 429 — dispatch
-- code should treat that chunk as simply not-yet-dispatched (its
-- submission_run_items rows stay batch_id IS NULL) and retry on the next
-- resume pass, not as a fatal error for the whole run.
--
-- ============================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT CHANGE
-- ============================================================
--   - archive_search_significance_batch_items — zero columns, indexes, or
--     constraints touched. Its own write-back/resume contract
--     (written_back_at IS NULL) is exactly as correct after this
--     migration as before it; a batch is still a batch once it exists,
--     regardless of whether it came from a single-chunk or multi-chunk
--     run.
--   - fetchNextEligibleConversations() / fetchDriverPage() (significance-
--     pass.js) — not touched by this schema, and Q's build should not
--     need to touch their internals either; see THE RUN MODEL point 1
--     above for why calling that function once per run is the only
--     discipline this design needs from it.
--   - Any actual chunk-size arithmetic (the safety margin below 256 MB,
--     how many bytes a running total may reach before cutting a chunk).
--     That is real application logic living in Q's rewritten
--     significance-batch.js, not something a CHECK constraint here can
--     usefully enforce — this schema only holds the RESULT of that
--     decision (chunk_number), same division of labor as
--     request_count_total on archive_search_significance_batches already
--     established (recorded, never independently verified by the
--     database).
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No existing row in
--       archive_search_significance_batches is modified. The two new
--       columns added to it (run_id, chunk_number) are added NULLABLE,
--       specifically so any batch row that may already exist from before
--       tonight's redesign (submitted under the old one-batch-per-
--       submission model) stays valid exactly as-is — NULL/NULL on both
--       new columns means "predates this migration," documented on the
--       column comments below, not backfilled or guessed at. Both brand
--       new tables (SECTIONS A/B) start empty.
--   [x] Does this touch a table other code depends on? Yes, one existing
--       table (archive_search_significance_batches) gets two new nullable
--       columns and one index swap (see below) — additive plus a
--       necessary index change, not a removal of any column, row, or
--       constraint that predates tonight.
--   [ ] Additive or destructive? Mostly additive (two new tables, two new
--       nullable columns) with ONE deliberate, necessary destructive
--       piece: DROP INDEX idx_archive_search_significance_batches_
--       one_unfinished_per_stage. Dropping an index cannot corrupt or
--       lose data — it only changes what the database will refuse to
--       insert going forward — but it IS a real removal of the exact
--       guarantee 20260917020000 built, so it is called out here
--       explicitly rather than left implicit in a diff. Its replacement
--       (idx_archive_search_significance_submission_runs_one_active_
--       per_stage, SECTION A) is created in the same migration, before
--       the drop, so there is no window where neither guard exists.
--   [ ] Tested on a copy of the data first? No staging copy of Supabase
--       exists in this project — same standing caveat every migration
--       here carries. Mitigated by: the two new tables are empty by
--       construction, the two new columns are nullable and default to
--       NULL for every existing row, and the one index swap is a pure
--       DDL operation with no data rewrite. This migration also does not
--       authorize submitting any real batch to Anthropic — that remains
--       Q's application code and Peter's approval, same as
--       20260917020000's own note.
--   [ ] Governance go-ahead — not sought by this migration, for the same
--       reason 20260917020000 gave: this is operational bookkeeping (a
--       run's stage/date-cutoff/counts, and the same mailbox_key/
--       missive_conversation_id values already stored today in
--       missive_conversation_significance and archive_search_
--       significance_batch_items) — no new category of stored personal
--       data, no decision made about a tenant or owner. Whether Asimov/
--       Mason need to review the historical-backfill batch tool ITSELF
--       remains the same open, separate question 20260917020000 already
--       flagged as out of scope for a schema-only migration.
-- ============================================================


-- ============================================================
-- SECTION A: archive_search_significance_submission_runs — one row per
-- call to fetchNextEligibleConversations() for one stage. The new home
-- for "is there already an unfinished attempt in flight for this stage,"
-- moved here from archive_search_significance_batches (see THE RUN MODEL
-- above for why).
-- ============================================================

CREATE TABLE IF NOT EXISTS archive_search_significance_submission_runs (
  id                        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  stage                     TEXT          NOT NULL CHECK (stage IN ('call_1', 'call_2')),

  -- Peter's staged-by-recency rollout cutoff (significance-pass.js's own
  -- sinceDate parameter) — the ISO date string that was passed into
  -- fetchNextEligibleConversations() for this run, if any. NULL means "no
  -- cutoff" (that function's own default), matching its own semantics
  -- exactly, not a sentinel this schema invents.
  since_date                DATE,

  -- The `targetCount`/`limit` this run's fetchNextEligibleConversations()
  -- call was invoked with — what was ASKED for, not what was found (see
  -- eligible_count below for that). Recorded for the same reason
  -- request_count_total is recorded on archive_search_significance_
  -- batches: a cheap, independent sanity value, never re-verified by the
  -- database.
  requested_count           INTEGER       NOT NULL CHECK (requested_count > 0),

  -- How many (mailbox_key, missive_conversation_id) pairs
  -- fetchNextEligibleConversations() actually returned for this run — set
  -- ONCE, at the same moment assembled_at is set (see the lockstep CHECK
  -- below), from COUNT(*) of this run's own archive_search_significance_
  -- submission_run_items rows at insert time. Never recomputed after.
  eligible_count            INTEGER       CHECK (eligible_count >= 0),

  -- THE DURABILITY CHECKPOINT. Set the moment this run's full eligible
  -- list has been inserted into archive_search_significance_
  -- submission_run_items — i.e., the moment the expensive scan's results
  -- are safe in Postgres, regardless of what happens to Anthropic
  -- submission afterward. NULL means the scan either hasn't finished or
  -- its results were never durably recorded (the exact failure mode this
  -- migration exists to close).
  assembled_at              TIMESTAMPTZ,

  -- The real "fully done" marker for the whole run: every chunk/batch
  -- this run was split into has reached ITS OWN completed_at (full
  -- write-back done for every item in every chunk) — not merely
  -- "every chunk has been submitted" (see dispatched-but-not-yet-
  -- processed reasoning in this file's own header). This, not
  -- assembled_at and not "every chunk dispatched," is what the unique
  -- index below actually keys on: a run whose conversations have not
  -- ALL been written back yet still holds the one-active-run-per-stage
  -- slot, because until write-back happens those conversations have no
  -- missive_conversation_significance row and nothing else would stop
  -- them being re-selected by a second run's own eligibility scan.
  fully_processed_at        TIMESTAMPTZ,

  -- Set only when the application (or an operator) has given up on this
  -- run ever reaching fully_processed_at — same convention and same
  -- purpose as archive_search_significance_batches.failed_at: what
  -- actually frees the one-active-run-per-stage slot for a genuinely
  -- stuck or abandoned run. Never set on ordinary success.
  failed_at                 TIMESTAMPTZ,
  failure_reason            TEXT,

  -- Free text — which script/build started this run (e.g. a version
  -- string for Q's rewritten submission tool), same convention as
  -- archive_search_significance_batches.submitted_by.
  submitted_by              TEXT          NOT NULL,

  -- Free-form operational context, same purpose as archive_search_
  -- significance_batches.notes.
  notes                     TEXT,

  created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- assembled_at and eligible_count are set together or not at all —
  -- same lockstep-field discipline 20260917020000 already established
  -- for its own failure_reason_required/not_both_done_and_failed
  -- constraints.
  CONSTRAINT archive_search_significance_submission_runs_assembled_lockstep CHECK (
    (assembled_at IS NULL) = (eligible_count IS NULL)
  ),
  CONSTRAINT archive_search_significance_submission_runs_failure_reason_required CHECK (
    failed_at IS NULL OR failure_reason IS NOT NULL
  ),
  CONSTRAINT archive_search_significance_submission_runs_not_both_done_and_failed CHECK (
    fully_processed_at IS NULL OR failed_at IS NULL
  )
);

ALTER TABLE archive_search_significance_submission_runs ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- THE (RELOCATED) NO-DOUBLE-SUBMISSION GUARANTEE. At most one run per
-- stage may be neither fully processed nor failed at any moment — the
-- direct successor to 20260917020000's own idx_archive_search_
-- significance_batches_one_unfinished_per_stage, moved to the unit of
-- work that now actually needs to be singular (a run, which may fan out
-- into many concurrently-unfinished batches/chunks — see THE RUN MODEL
-- above for why the old index could not simply stay where it was).
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_search_significance_submission_runs_one_active_per_stage
  ON archive_search_significance_submission_runs(stage)
  WHERE fully_processed_at IS NULL AND failed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_archive_search_significance_submission_runs_stage
  ON archive_search_significance_submission_runs(stage);

DROP TRIGGER IF EXISTS trg_archive_search_significance_submission_runs_updated_at ON archive_search_significance_submission_runs;
CREATE TRIGGER trg_archive_search_significance_submission_runs_updated_at
  BEFORE UPDATE ON archive_search_significance_submission_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE archive_search_significance_submission_runs IS
  'One row per call to significance-pass.js fetchNextEligibleConversations() for one stage of the archive-search significance batch pipeline. Exists so an expensive (hours-long) eligibility scan is durably recorded (see assembled_at) before any Anthropic submission is attempted, and so "is there already an unfinished attempt for this stage" — the guarantee that prevents double-submitting a conversation — is enforced at the run level, since one run may now legitimately fan out into several concurrently-unfinished Anthropic batches (see archive_search_significance_batches.run_id). Read/written exclusively via the service-role key by Q''s backend submission/dispatch tool. RLS enabled, zero permissive policies, matching every table in this schema.';

COMMENT ON COLUMN archive_search_significance_submission_runs.fully_processed_at IS
  'Every chunk/batch this run was split into has reached ITS OWN completed_at. This — not assembled_at, and not "every chunk dispatched" — is what idx_archive_search_significance_submission_runs_one_active_per_stage keys on: until every conversation in this run has been written back to missive_conversation_significance, nothing else excludes those conversations from a future eligibility scan, so this run must keep holding the one-active-per-stage slot.';

COMMENT ON COLUMN archive_search_significance_submission_runs.assembled_at IS
  'Set the moment this run''s full eligible list has been durably inserted into archive_search_significance_submission_run_items — the actual fix for tonight''s incident (2026-09-18): an 8-hour eligibility scan whose results were lost because nothing was written to the database until Anthropic submission succeeded. Once this is set, the scan itself never needs to be re-run for this run, regardless of what happens to submission/dispatch afterward.';


-- ============================================================
-- SECTION B: archive_search_significance_submission_run_items — one row
-- per conversation in one run's assembled eligible list, staged BEFORE
-- any Anthropic call. See the CHILD-TABLE-NOT-A-NULLABLE-batch_id note in
-- this file's own header for why this is a new table rather than a
-- relaxed archive_search_significance_batch_items.
-- ============================================================

CREATE TABLE IF NOT EXISTS archive_search_significance_submission_run_items (
  id                        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- RESTRICT, same reasoning as archive_search_significance_batch_items.
  -- batch_id: deleting a run while its items still reference it would
  -- silently erase the one durable record that an 8-hour scan's results
  -- ever existed.
  run_id                    UUID          NOT NULL REFERENCES archive_search_significance_submission_runs(id) ON DELETE RESTRICT,

  -- This pair's position in fetchNextEligibleConversations()'s own
  -- returned order — preserved so chunk-boundary assignment (Q's
  -- application code) is deterministic and reproducible from these rows
  -- alone, without needing to re-derive or re-guess an order.
  sequence_in_run           INTEGER       NOT NULL CHECK (sequence_in_run >= 0),

  -- Matches missive_conversation_significance/missive_message_links by
  -- VALUE only, never by foreign key — same Rule 9 convention
  -- 20260917020000 already carries forward for archive_search_
  -- significance_batch_items, for the identical reason: a conversation
  -- lands here specifically BECAUSE it has no significance row yet.
  mailbox_key               TEXT          NOT NULL,
  missive_conversation_id   TEXT          NOT NULL,

  -- NULL until this item has been assigned to a chunk (Q's size/count-
  -- aware chunking pass) and that chunk has actually been submitted to
  -- Anthropic. Sibling of the migration's own "at most one unfinished
  -- run per stage" guarantee: this is the per-item half of resumability —
  -- "WHERE batch_id IS NULL" (the partial index below) is the exact
  -- resume-dispatch query, finding exactly the items this run still owes
  -- a submission for, without redoing chunks already sent.
  chunk_number              INTEGER       CHECK (chunk_number >= 0),
  batch_id                  UUID          REFERENCES archive_search_significance_batches(id) ON DELETE RESTRICT,
  dispatched_at             TIMESTAMPTZ,

  created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- THE ACTUAL PER-RUN NO-DUPLICATE GUARANTEE — a database-level backstop
  -- on top of fetchNextEligibleConversations()'s own existing
  -- application-level dedup (dedupeNewPairs/filterAlreadyProcessed),
  -- which this migration does not change. Unlike a nullable batch_id on
  -- the existing batch_items table, this constraint has no NULL column
  -- in it, so it protects every row from the moment it's inserted,
  -- staged-but-undispatched or not.
  UNIQUE (run_id, mailbox_key, missive_conversation_id),
  UNIQUE (run_id, sequence_in_run),

  -- chunk_number / batch_id / dispatched_at are set together or not at
  -- all — same lockstep-field discipline as every other paired-state
  -- column in this schema family.
  CONSTRAINT archive_search_significance_submission_run_items_dispatch_lockstep CHECK (
    (chunk_number IS NULL AND batch_id IS NULL AND dispatched_at IS NULL)
    OR (chunk_number IS NOT NULL AND batch_id IS NOT NULL AND dispatched_at IS NOT NULL)
  )
);

ALTER TABLE archive_search_significance_submission_run_items ENABLE ROW LEVEL SECURITY;

-- THE resume-dispatch query: "which of this run's conversations still
-- need to be assigned to a chunk and submitted."
CREATE INDEX IF NOT EXISTS idx_archive_search_significance_submission_run_items_undispatched
  ON archive_search_significance_submission_run_items(run_id)
  WHERE batch_id IS NULL;

-- Reverse lookup ("which run/chunk did this real Anthropic batch come
-- from") — debugging/reconciliation only, not load-bearing for either
-- resumability or the no-double-submission guarantee above.
CREATE INDEX IF NOT EXISTS idx_archive_search_significance_submission_run_items_batch
  ON archive_search_significance_submission_run_items(batch_id)
  WHERE batch_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_archive_search_significance_submission_run_items_updated_at ON archive_search_significance_submission_run_items;
CREATE TRIGGER trg_archive_search_significance_submission_run_items_updated_at
  BEFORE UPDATE ON archive_search_significance_submission_run_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE archive_search_significance_submission_run_items IS
  'One row per (mailbox_key, missive_conversation_id) pair in one submission run''s fully-assembled, deduplicated eligible list, inserted BEFORE any Anthropic call — the actual fix for tonight''s incident (2026-09-18), where an 8-hour eligibility scan''s results were lost because nothing was durably recorded until a batch submission call itself succeeded. chunk_number/batch_id/dispatched_at are filled in once Q''s chunking pass assigns this item to an actual submitted Anthropic batch; NULL means still owed a submission (see the partial index on batch_id IS NULL, the real resume-dispatch query). Never foreign-keys into missive_conversation_significance, same Rule 9 reasoning as archive_search_significance_batch_items. Read/written exclusively via the service-role key. RLS enabled, zero permissive policies.';

COMMENT ON COLUMN archive_search_significance_submission_run_items.chunk_number IS
  'Assigned once, in one deterministic left-to-right pass over this run''s undispatched items ordered by sequence_in_run (Q''s application code, not enforced by this schema) — the actual mechanism that guarantees no conversation is ever split across two chunks or resubmitted: dispatch only ever reads rows WHERE batch_id IS NULL, so a row already assigned a chunk_number/batch_id can never be picked up again, even across separate, crash-interrupted dispatch attempts.';


-- ============================================================
-- SECTION C: archive_search_significance_batches — additive columns
-- linking each real Anthropic batch back to the run/chunk it belongs to,
-- plus the index swap THE RUN MODEL (this file's header) explains in
-- full. No existing column, constraint, or row is altered.
-- ============================================================

ALTER TABLE archive_search_significance_batches
  ADD COLUMN IF NOT EXISTS run_id        UUID REFERENCES archive_search_significance_submission_runs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS chunk_number  INTEGER CHECK (chunk_number >= 0);

-- NULL/NULL means this batch predates this migration (submitted under the
-- old one-batch-per-submission model, 20260917020000) — left exactly as
-- it was, never backfilled or guessed at (see MIGRATION GATE above). Every
-- batch submitted from now on sets both together.
ALTER TABLE archive_search_significance_batches
  ADD CONSTRAINT archive_search_significance_batches_run_chunk_lockstep CHECK (
    (run_id IS NULL) = (chunk_number IS NULL)
  );

-- No two chunks of the same run may claim the same chunk_number — the
-- per-batch half of "no conversation submitted twice," alongside SECTION
-- B's own UNIQUE(run_id, mailbox_key, missive_conversation_id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_search_significance_batches_run_chunk
  ON archive_search_significance_batches(run_id, chunk_number)
  WHERE run_id IS NOT NULL;

-- THE INDEX SWAP. Dropped because it is no longer true, by design, that
-- at most one unfinished batch may exist per stage — multiple chunks of
-- ONE run are meant to be concurrently unfinished (see PARALLEL CHUNKS
-- above). Its replacement,
-- idx_archive_search_significance_submission_runs_one_active_per_stage
-- (SECTION A), is created earlier in this same migration file, so
-- applying this file in order never leaves a window with neither guard
-- active.
DROP INDEX IF EXISTS idx_archive_search_significance_batches_one_unfinished_per_stage;

COMMENT ON COLUMN archive_search_significance_batches.run_id IS
  'The submission run (archive_search_significance_submission_runs) this batch is one chunk of. NULL only for a batch submitted before 2026-09-18''s chunking/resumability redesign, under the old one-batch-per-submission model — never backfilled. See idx_archive_search_significance_submission_runs_one_active_per_stage for where the "no double submission" guarantee actually lives now that this table itself may hold several concurrently-unfinished rows per stage (one per chunk of the same run).';

COMMENT ON COLUMN archive_search_significance_batches.completed_at IS
  'The real "fully done" marker for this ONE chunk/batch: every child row in archive_search_significance_batch_items has been written back to missive_conversation_significance. As of 2026-09-18, this no longer drives any uniqueness guarantee by itself — see run_id and archive_search_significance_submission_runs.fully_processed_at, which aggregates this column across every chunk of a run.';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- COMMENT ON COLUMN archive_search_significance_batches.completed_at IS
--   'The real "fully done" marker for this batch: every child row in archive_search_significance_batch_items has been written back to missive_conversation_significance. This — never anthropic_status alone — is what idx_archive_search_significance_batches_one_unfinished_per_stage keys on to decide whether a stage has an unfinished batch.';
-- COMMENT ON COLUMN archive_search_significance_batches.run_id IS NULL;
--
-- CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_search_significance_batches_one_unfinished_per_stage
--   ON archive_search_significance_batches(stage)
--   WHERE completed_at IS NULL AND failed_at IS NULL;
-- -- Confirm no run currently depends on multiple concurrently-unfinished
-- -- batches for the same stage before re-creating this — recreating it
-- -- while such a run exists will simply fail with a live unique
-- -- violation, which is the correct, safe failure mode (loudly, not
-- -- silently).
--
-- DROP INDEX IF EXISTS idx_archive_search_significance_batches_run_chunk;
-- ALTER TABLE archive_search_significance_batches
--   DROP CONSTRAINT IF EXISTS archive_search_significance_batches_run_chunk_lockstep;
-- ALTER TABLE archive_search_significance_batches
--   DROP COLUMN IF EXISTS chunk_number,
--   DROP COLUMN IF EXISTS run_id;
--
-- DROP TRIGGER IF EXISTS trg_archive_search_significance_submission_run_items_updated_at ON archive_search_significance_submission_run_items;
-- DROP INDEX IF EXISTS idx_archive_search_significance_submission_run_items_batch;
-- DROP INDEX IF EXISTS idx_archive_search_significance_submission_run_items_undispatched;
-- DROP TABLE IF EXISTS archive_search_significance_submission_run_items;
-- -- Confirm no real, in-flight run (a submission_runs row with
-- -- fully_processed_at IS NULL AND failed_at IS NULL) exists first —
-- -- dropping this table while a run's chunks are still being tracked
-- -- would re-create exactly the lost-scan risk this migration exists to
-- -- prevent.
--
-- DROP TRIGGER IF EXISTS trg_archive_search_significance_submission_runs_updated_at ON archive_search_significance_submission_runs;
-- DROP INDEX IF EXISTS idx_archive_search_significance_submission_runs_stage;
-- DROP INDEX IF EXISTS idx_archive_search_significance_submission_runs_one_active_per_stage;
-- DROP TABLE IF EXISTS archive_search_significance_submission_runs;
-- -- Same caveat as above — check for a real in-flight run first.
--
-- ============================================================
