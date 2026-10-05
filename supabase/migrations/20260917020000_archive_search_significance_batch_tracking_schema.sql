-- ============================================================
-- Migration: 20260917020000_archive_search_significance_batch_tracking_schema
-- Created:   2026-09-17
-- Author:    Neo (database specialist)
--
-- Requested by Jarvis on Q's behalf: Q researched the real mechanics of
-- Anthropic's Message Batches API and needs a database home for batch
-- state before writing the submission/polling tool that will run the real
-- historical significance-tagging backfill (starting with a 1-year window,
-- 84,408 real Missive email conversations, projects/hub/archive-search/
-- lib/significance-pass.js's Call 1 / Call 2 passes — see that file's own
-- buildCall1Prompt/buildCall2Prompt/needsCall2 for the two calls' real
-- shape). This migration is schema only — no application code. It does
-- not authorize submitting any real batch to Anthropic.
--
-- WHY THIS TABLE HAS TO EXIST (not a plain state file):
-- A submitted batch can take up to 24 hours to finish at Anthropic, and
-- its results stay downloadable for 29 days after that. Hub is redeployed
-- onto sally by copying a fresh code tree into /var/www/hub — a routine,
-- unrelated redeploy would wipe a plain state file out from under a real,
-- in-flight, PAID batch job, orphaning it with no local record of its ID.
-- A database table survives that. Real Batches API facts used below (the
-- claude-api skill's own Message Batches reference, fetched fresh for
-- this migration rather than assumed from training-time memory): up to
-- 100,000 requests or 256MB per batch; batch.processing_status is a real,
-- CONFIRMED three-value enum — 'in_progress' (default at creation),
-- 'canceling' (only after an explicit cancel call), 'ended' (terminal,
-- regardless of whether the requests inside it succeeded); each
-- individual result's own result.type is a real, CONFIRMED four-value
-- enum — 'succeeded', 'errored', 'canceled', 'expired'; custom_id must
-- match ^[a-zA-Z0-9_-]{1,64}$ and only needs to be unique WITHIN one
-- batch, not account-wide.
--
-- WHY SHORT TOKENS, NOT THE REAL (mailbox_key, missive_conversation_id)
-- PAIR, AS custom_id:
-- Both real identifiers are UUIDs (36 characters each) — two of them,
-- plus any separator, blow past custom_id's 64-character ceiling. So
-- every conversation submitted in a batch gets a short, randomly
-- generated token (Q's job, not this migration's) that becomes its
-- custom_id; the real (mailbox_key, missive_conversation_id) pair that
-- token stands for is kept here, in Postgres, not in the request sent to
-- Anthropic at all.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT BUILD:
--   - The actual batch-submission script, the results-polling/download
--     script, or the code that writes a retrieved result back into
--     missive_conversation_significance/complaints. All Q's build, on
--     top of this schema, once this migration ships.
--   - Any change to missive_conversation_significance, complaints, or any
--     other existing table. Purely additive — two new tables, nothing
--     else touched.
--   - Any team_member_tool_roles change. Nothing in this schema is read
--     or written from a UI a team member logs into — both tables here
--     are read and written exclusively by Q's future backend
--     submission/polling script, connecting with the service-role key
--     (which bypasses RLS regardless), the same access model this
--     migration file's own RLS section documents for every table below.
--   - A discovery_context column. Per significance-pass.js's own header
--     comment ("PILOT / PHASE 2" — that module deliberately does NOT
--     implement the Batches API run for the historical backfill; this is
--     that separate, later build), every batch this schema will ever
--     hold is, by construction, for the historical backfill. If a live-
--     pipeline batching use ever gets built later, that is a genuinely
--     new fact this schema does not anticipate, and adding the column
--     then — when there is a real second case to distinguish — is a
--     smaller, safer change than carrying an always-one-value column
--     starting today.
--
-- ============================================================
-- THE CHILD-TABLE-VS-JSON DECISION — child table, not a JSON column
-- ============================================================
-- The token -> (mailbox_key, missive_conversation_id) mapping for one
-- batch could live as a JSONB column on the batch row, or as its own
-- table with one row per conversation. This migration chooses the
-- latter, for three concrete reasons that all point the same direction
-- at this table's real scale (up to ~84,000 rows per batch):
--
--   1. Access pattern is fundamentally per-row, not per-batch. Once a
--      batch ends, Q's polling tool streams results from Anthropic ONE
--      AT A TIME (client.messages.batches.results(id) — an async
--      iterator, not a single blob) and, for each one, needs to look up
--      the real (mailbox_key, missive_conversation_id) pair for that
--      result's custom_id and then mark that one conversation done. A
--      real table gives that an indexed point lookup (batch_id, token).
--      A JSONB column would force loading and scanning a ~84,000-entry
--      array (or a slow ->> path expression) for every single one of
--      the up to 84,000 lookups in one batch.
--
--   2. Resumability needs cheap, durable per-item state. If Q's write-
--      back script dies partway through applying results (the exact
--      failure mode this whole table exists to survive), it needs to
--      cheaply ask "which of this batch's conversations still need
--      their result written back?" A plain indexed column
--      (written_back_at IS NULL) answers that instantly. Tracking that
--      same per-item state inside a JSON array means finding and
--      flipping one element buried in an ~84,000-entry structure — no
--      partial index can reach inside a JSON array element the way it
--      can a real column.
--
--   3. Write amplification. Postgres MVCC means updating any single key
--      inside a JSONB column rewrites the ENTIRE column value as a new
--      row version. Marking each of up to 84,000 conversations done one
--      at a time, if that state lived inside one JSONB blob, means
--      rewriting an ~84,000-entry JSON document up to 84,000 times over
--      the life of one batch. A real child table just updates one small
--      row per conversation — the ordinary, cheap case a relational
--      database is built for. 84,000 rows in a table is unremarkable at
--      this schema's scale (missive_message_intake already holds
--      millions); an ~84,000-entry JSON document living inside a single
--      row is not.
--
-- ============================================================
-- WHY A CHILD ROW NEVER FOREIGN-KEYS INTO missive_conversation_
-- significance (Rule 9 convention, carried forward from every sibling
-- table in this schema — 20260913020000's own header explains the
-- original reasoning)
-- ============================================================
-- mailbox_key/missive_conversation_id match by VALUE only here, exactly
-- as they do on missive_message_links and missive_conversation_
-- significance itself — never by foreign key. This isn't just
-- convention-following: a conversation is added to a Call 1 batch
-- specifically BECAUSE it has no row in missive_conversation_
-- significance yet (that row is what Call 1's own result creates) — an
-- FK into a table that provably doesn't have the matching row yet would
-- be a contradiction, not just an inconsistency with house style.
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No. Both tables this file
--       creates are brand new; nothing existing reads or writes either
--       one. No existing table's column, constraint, or row is altered.
--   [x] Does this touch a table other code depends on? No existing table
--       is altered at all.
--   [x] Additive or destructive? Fully additive — two new tables, zero
--       existing objects touched.
--   [ ] Tested on a copy of the data first? No staging copy of Supabase
--       exists in this project — same standing caveat every migration
--       here carries. Mitigated by: both tables this file creates are
--       brand new and empty; nothing can be broken that doesn't yet
--       exist. This migration also does not authorize submitting any
--       real batch to Anthropic — that is a separate, later, real-money
--       decision for Q's build and Peter's approval, not this schema.
--   [ ] Governance go-ahead — not sought by this migration. This table
--       only stores operational bookkeeping (a batch ID, a status
--       string, timestamps, and the same mailbox_key/missive_
--       conversation_id values already stored today, at rest, in
--       missive_conversation_significance and missive_message_links). It
--       creates no new category of stored personal data and makes no
--       decision about a tenant or owner. Whether Asimov/Mason need to
--       review the historical-backfill BATCH TOOL ITSELF (the real-money
--       submission of up to 84,408 conversations' content to Anthropic
--       via a new code path) is a real, separate question for that build
--       — not resolved by this schema-only migration, and not skipped
--       here so much as genuinely out of scope for what this file does.
-- ============================================================


-- ============================================================
-- SECTION A: archive_search_significance_batches — one row per Anthropic
-- Message Batch submitted for this pipeline.
-- ============================================================

CREATE TABLE IF NOT EXISTS archive_search_significance_batches (
  id                        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which of significance-pass.js's two AI calls this batch is running.
  -- 'call_2' batches only ever include conversations whose Call 1 result
  -- already said they need one (needsCall2() in that file) — this
  -- migration does not enforce that; it's Q's driver-query logic, same
  -- division of labor as every other cross-table business rule in this
  -- schema (see 20260913020000's own "COMPLAINTS-CREATION LOGIC" note on
  -- why that kind of decision lives in application code, not a DB
  -- trigger or CHECK).
  stage                     TEXT          NOT NULL CHECK (stage IN ('call_1', 'call_2')),

  -- The real Anthropic batch ID (e.g. "msgbatch_...") — assigned by
  -- Anthropic at creation time, returned synchronously from the create
  -- call. A row in this table is only ever written once that ID exists;
  -- there is no "reserved but not yet submitted" state (see the
  -- ONE-UNFINISHED-BATCH-PER-STAGE note below for how duplicate
  -- submission is actually prevented, which does not depend on a
  -- pre-submission placeholder row).
  anthropic_batch_id        TEXT          NOT NULL,

  -- Anthropic's own processing_status, mirrored verbatim on every poll.
  -- REAL, CONFIRMED three-value enum (claude-api skill's Message Batches
  -- reference, fetched fresh for this migration): 'in_progress' is the
  -- value at creation; 'canceling' only appears after an explicit cancel
  -- call; 'ended' is terminal and means Anthropic is done processing —
  -- it does NOT mean every request inside succeeded. There is no
  -- Anthropic-side 'completed' or 'failed' batch status; per-request
  -- outcomes are a separate concept, tracked per row on
  -- archive_search_significance_batch_items.result_status below, not
  -- here.
  anthropic_status          TEXT          NOT NULL DEFAULT 'in_progress'
                                CHECK (anthropic_status IN ('in_progress', 'canceling', 'ended')),

  -- Recorded once, from the create call's own response — how many
  -- requests this batch was submitted with. A cheap, independent sanity
  -- total to check against COUNT(*) of this batch's own child rows;
  -- never recomputed after submission.
  request_count_total       INTEGER       NOT NULL CHECK (request_count_total > 0),

  -- Free text — which script/build submitted this (e.g. a version
  -- string for Q's future submission tool), same convention as
  -- complaint_tracking_config.set_by and missive_conversation_
  -- significance.extracted_by elsewhere in this schema. Not a
  -- team_members FK: nothing here is a human clicking a button in a UI,
  -- it's a backend script run, so a version/script identifier is the
  -- right shape, not a person.
  submitted_by              TEXT          NOT NULL,

  submitted_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  -- Updated on every poll, regardless of whether anthropic_status
  -- changed — "did the resume script even check on this today" is its
  -- own useful operational signal, independent of the status itself.
  last_checked_at           TIMESTAMPTZ,
  -- When Q's tool finished streaming every result off
  -- client.messages.batches.results(...) for this batch — distinct from
  -- anthropic_status = 'ended', which only means Anthropic finished
  -- PROCESSING, not that this pipeline finished DOWNLOADING.
  results_retrieved_at      TIMESTAMPTZ,
  -- The real "fully done" marker: every one of this batch's child rows
  -- has had its result successfully written back into missive_
  -- conversation_significance (and, where shouldCreateComplaint()
  -- applies, complaints). Deliberately a SEPARATE concept from both
  -- anthropic_status = 'ended' and results_retrieved_at — a batch can be
  -- 'ended' and fully downloaded, yet still have individual conversation
  -- rows not yet written back if the write-back script itself crashed
  -- partway through. completed_at is the one column the "is there an
  -- unfinished batch for this stage" check (below) actually keys on.
  completed_at              TIMESTAMPTZ,

  -- Set only when the application (or an operator) has given up on this
  -- batch ever reaching completed_at — e.g. the 29-day results window
  -- lapsed before results were ever retrieved, or a batch was
  -- deliberately canceled and is not going to be resumed. This is what
  -- actually frees the "one unfinished batch per stage" slot below for a
  -- genuinely stuck or abandoned batch — completed_at is only ever set
  -- on real success, never as a way to give up.
  failed_at                 TIMESTAMPTZ,
  failure_reason            TEXT,

  -- Free-form operational context — e.g. which since-date cutoff this
  -- batch's conversations were drawn from (Peter's staged-by-recency
  -- rollout, significance-pass.js's own sinceDate parameter). Same
  -- purpose as complaint_tracking_config.notes elsewhere in this schema:
  -- a place for the "why," not a column this migration gives any
  -- meaning to itself.
  notes                     TEXT,

  created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  UNIQUE (anthropic_batch_id),

  CONSTRAINT archive_search_significance_batches_failure_reason_required CHECK (
    failed_at IS NULL OR failure_reason IS NOT NULL
  ),
  -- A batch is either a real success or a given-up-on failure, never
  -- both — mirrors this schema's existing lockstep-field discipline
  -- (e.g. missive_conversation_significance_dismissal_reason_required).
  CONSTRAINT archive_search_significance_batches_not_both_done_and_failed CHECK (
    completed_at IS NULL OR failed_at IS NULL
  )
);

ALTER TABLE archive_search_significance_batches ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- THE ACTUAL NO-DOUBLE-SUBMISSION GUARANTEE.
-- A plain UNIQUE index, not just an index — Postgres itself will refuse
-- a second INSERT of an unfinished (not yet completed_at, not yet
-- failed_at) row for the same stage. This is the real answer to "is
-- there already an unfinished batch for stage X, so a resumed script
-- never double-submits": Q's resume script queries this exact condition
-- to decide whether to submit a new batch or resume an existing one, and
-- even if that check and a submission ever raced (two invocations of the
-- resume script somehow running at once), the database — not
-- application logic remembering to check first — is what actually
-- prevents two live unfinished batches for the same stage from ever
-- coexisting.
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_search_significance_batches_one_unfinished_per_stage
  ON archive_search_significance_batches(stage)
  WHERE completed_at IS NULL AND failed_at IS NULL;

DROP TRIGGER IF EXISTS trg_archive_search_significance_batches_updated_at ON archive_search_significance_batches;
CREATE TRIGGER trg_archive_search_significance_batches_updated_at
  BEFORE UPDATE ON archive_search_significance_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE archive_search_significance_batches IS
  'One row per Anthropic Message Batch submitted for the archive-search historical significance backfill (projects/hub/archive-search/lib/significance-pass.js Call 1/Call 2). Exists so a submitted, paid, up-to-24-hour, up-to-29-day-downloadable batch survives a routine Hub redeploy onto sally (which copies a fresh code tree into /var/www/hub, wiping any plain state file) with no local record of its ID. Read exclusively via the service-role key by Q''s backend submission/polling tool — no team member logs into a UI backed by this table, hence no team_member_tool_roles grant and no RLS policy. RLS enabled, zero permissive policies, matching every table in this schema.';

COMMENT ON COLUMN archive_search_significance_batches.anthropic_status IS
  'Anthropic''s own batch.processing_status, mirrored verbatim on every poll. Real, confirmed 3-value enum: in_progress (at creation) -> canceling (only after an explicit cancel) -> ended (terminal). "ended" means Anthropic finished PROCESSING, not that every request inside succeeded, and not that this pipeline finished downloading/writing back results — see results_retrieved_at and completed_at for those.';

COMMENT ON COLUMN archive_search_significance_batches.completed_at IS
  'The real "fully done" marker for this batch: every child row in archive_search_significance_batch_items has been written back to missive_conversation_significance. This — never anthropic_status alone — is what idx_archive_search_significance_batches_one_unfinished_per_stage keys on to decide whether a stage has an unfinished batch.';


-- ============================================================
-- SECTION B: archive_search_significance_batch_items — one row per
-- conversation included in a batch. See the CHILD-TABLE-VS-JSON DECISION
-- comment at the top of this file for why this is a table, not a JSONB
-- column on the batch row above.
-- ============================================================

CREATE TABLE IF NOT EXISTS archive_search_significance_batch_items (
  id                        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- RESTRICT, not CASCADE: this row's own real Anthropic batch ID is the
  -- only durable record that a real, paid batch was ever submitted for
  -- this conversation. Deleting the parent batch row while items still
  -- point to it would silently erase that audit trail — RESTRICT forces
  -- a deliberate, explicit decision (delete the items first) rather than
  -- letting one DROP/DELETE quietly take the whole batch's history with
  -- it.
  batch_id                  UUID          NOT NULL REFERENCES archive_search_significance_batches(id) ON DELETE RESTRICT,

  -- The short generated value sent to Anthropic as this request's
  -- custom_id — never the real (mailbox_key, missive_conversation_id)
  -- pair (see the TOKENS note at the top of this file for why: two
  -- UUIDs blow past custom_id's 64-character ceiling). The CHECK below
  -- enforces Anthropic's own real custom_id pattern directly at the
  -- database layer, so a malformed token can never be written here in
  -- the first place. Only unique WITHIN a batch — matching Anthropic's
  -- own real constraint — not account-wide (see the UNIQUE below).
  token                     TEXT          NOT NULL CHECK (token ~ '^[a-zA-Z0-9_-]{1,64}$'),

  -- Matches missive_conversation_significance/missive_message_links by
  -- VALUE only, never by foreign key — see the Rule 9 note at the top of
  -- this file. TEXT, not the Postgres UUID type, deliberately matching
  -- how both sibling tables already store these two columns today, even
  -- though the real-world values are UUID-shaped.
  mailbox_key               TEXT          NOT NULL,
  missive_conversation_id   TEXT          NOT NULL,

  -- Real, confirmed 4-value result.type enum from Anthropic's own
  -- results stream, plus this pipeline's own 'pending' for "the batch
  -- hasn't ended yet / this result hasn't been read off the results
  -- stream yet."
  result_status             TEXT          NOT NULL DEFAULT 'pending'
                                CHECK (result_status IN ('pending', 'succeeded', 'errored', 'canceled', 'expired')),

  -- Free text, populated by Q's tool as needed — either Anthropic's own
  -- result.error.type/message for an 'errored' result, or this
  -- pipeline's own exception message if writing a 'succeeded' result
  -- back to missive_conversation_significance/complaints itself failed.
  -- One flexible column rather than this migration guessing which of
  -- those two genuinely different failure shapes Q's tool will need to
  -- record more often.
  error_detail              TEXT,

  -- Set only once this specific conversation's result has been
  -- successfully applied to missive_conversation_significance (and, for
  -- a qualifying Call 2 result, complaints). This is the per-conversation
  -- resume marker: if the write-back script dies partway through a
  -- batch, "WHERE batch_id = ? AND written_back_at IS NULL" (the partial
  -- index below) finds exactly the conversations still owed a write,
  -- without redoing the ones already applied.
  written_back_at           TIMESTAMPTZ,

  created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- Anthropic's own real constraint: custom_id unique within one batch.
  UNIQUE (batch_id, token),
  -- Never submit the same conversation twice within one batch.
  UNIQUE (batch_id, mailbox_key, missive_conversation_id),

  -- A result can only be marked written back once it has actually come
  -- back from Anthropic with a real outcome — never while still
  -- 'pending'.
  CONSTRAINT archive_search_significance_batch_items_written_back_requires_terminal_status CHECK (
    written_back_at IS NULL OR result_status IN ('succeeded', 'errored', 'canceled', 'expired')
  )
);

ALTER TABLE archive_search_significance_batch_items ENABLE ROW LEVEL SECURITY;

-- The actual resume query: "which of this batch's conversations still
-- need their result written back."
CREATE INDEX IF NOT EXISTS idx_archive_search_significance_batch_items_pending_writeback
  ON archive_search_significance_batch_items(batch_id, result_status)
  WHERE written_back_at IS NULL;

DROP TRIGGER IF EXISTS trg_archive_search_significance_batch_items_updated_at ON archive_search_significance_batch_items;
CREATE TRIGGER trg_archive_search_significance_batch_items_updated_at
  BEFORE UPDATE ON archive_search_significance_batch_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE archive_search_significance_batch_items IS
  'One row per conversation included in one archive_search_significance_batches row. Holds the token -> (mailbox_key, missive_conversation_id) mapping that lets a downloaded Anthropic batch result be written back to the right missive_conversation_significance row, and the per-conversation written_back_at marker a resumed write-back script needs after a crash. Read/written exclusively via the service-role key. RLS enabled, zero permissive policies, matching every table in this schema. Never foreign-keys into missive_conversation_significance — see the Rule 9 note at the top of this migration file for why that is a real correctness requirement here, not just style.';

COMMENT ON COLUMN archive_search_significance_batch_items.token IS
   'The short, randomly generated custom_id sent to Anthropic for this request — never the real (mailbox_key, missive_conversation_id) pair, which together exceed custom_id''s 64-character limit. CHECK enforces Anthropic''s own real custom_id pattern (^[a-zA-Z0-9_-]{1,64}$) at the database layer. Unique per batch, matching Anthropic''s own real constraint — not unique account-wide.';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP TRIGGER IF EXISTS trg_archive_search_significance_batch_items_updated_at ON archive_search_significance_batch_items;
-- DROP INDEX IF EXISTS idx_archive_search_significance_batch_items_pending_writeback;
-- DROP TABLE IF EXISTS archive_search_significance_batch_items;
-- -- Confirm no real, in-flight (completed_at IS NULL AND failed_at IS
-- -- NULL) batch exists first if this has been applied for any length of
-- -- time — dropping this table while a real paid batch is still being
-- -- tracked would re-create exactly the orphaned-batch risk this
-- -- migration exists to prevent.
--
-- DROP TRIGGER IF EXISTS trg_archive_search_significance_batches_updated_at ON archive_search_significance_batches;
-- DROP INDEX IF EXISTS idx_archive_search_significance_batches_one_unfinished_per_stage;
-- DROP TABLE IF EXISTS archive_search_significance_batches;
-- -- Same caveat as above — check for a real in-flight batch first.
--
-- ============================================================
