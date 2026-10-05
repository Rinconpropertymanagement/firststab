-- ============================================================
-- Migration: 20260911000000_search_document_trigger_backfill
-- Created:   2026-09-11
-- Author:    Neo (database specialist)
--
-- SUPERSEDES ONLY ONE PIECE of 20260910030000_archive_search_schema.sql —
-- its Section B "ALTER TABLE ... ADD COLUMN search_document ... GENERATED
-- ALWAYS AS (...) STORED" statement, and nothing else. Every other
-- section of that migration (the five screening_* columns, both CHECK
-- constraints, missive_message_intake_search_safe,
-- missive_message_intake_held_review_safe, archive_search_validation_
-- sample, the team_member_tool_roles CHECK widenings) already applied
-- successfully to the live table and is untouched and unaffected by this
-- file. This migration does not re-run or duplicate any of that.
--
-- ============================================================
-- WHY THIS FILE EXISTS — READ BEFORE RUNNING
-- ============================================================
-- Three independent, real attempts to run 20260910030000's Section B
-- ADD COLUMN ... GENERATED ALWAYS AS (...) STORED statement through
-- Supabase Studio's web SQL Editor all failed with the identical
-- structural signature: real time elapses, missive_message_intake is
-- genuinely locked/busy the whole time (confirmed independently via
-- direct REST probing against the live table during each attempt, not
-- just inferred from the UI), then the browser reports a network/
-- timeout-flavored error ("Failed to fetch (api.supabase.com)", or "SQL
-- query ran into an upstream timeout"), and Postgres cleanly rolls the
-- whole statement back — no partial damage, no orphaned objects,
-- search_document confirmed absent afterward every time.
--
-- Re-investigated fresh, 2026-09-11, independently (not a rubber stamp
-- of that conclusion): this is a real execution-environment limit, not a
-- bug in the original file. A GENERATED ... STORED column is not
-- metadata-only — ADD COLUMN must compute and write the expression for
-- every existing row as part of adding it, which means a synchronous,
-- full-table rewrite of 254,000+ rows under one ACCESS EXCLUSIVE lock,
-- in one request, that whole request has to survive Supabase Studio's
-- SQL Editor's own gateway-level timeout (it proxies through
-- api.supabase.com; that timeout is separate from, and not fixed by,
-- `SET statement_timeout` inside the SQL itself — which is why the
-- suggested statement_timeout fix did not help). Independently confirmed
-- live, same day: this table is currently exhibiting real, measurable
-- read-timeout instability even on plain, read-only queries with no
-- write or lock involved (a `count=exact` aggregate and a mid-table
-- OFFSET both intermittently hit Postgres's own statement-timeout error,
-- 57014, with no ALTER TABLE running at the time) — consistent with real
-- concurrent load from the live Missive sync cron (which writes to this
-- exact table on a ~15-minute cadence, confirmed via missive_sync_state)
-- and/or table bloat from continuous growth, not a one-off fluke. That
-- makes a single, minutes-long, all-254,000-rows-at-once lock on this
-- specific table a genuinely higher-risk operation right now than the
-- original design's own already-cautious operational note assumed, on
-- top of the gateway-timeout problem alone.
--
-- THE FIX: same end state, different mechanism, never one statement that
-- has to touch all 254,000+ rows at once. search_document remains a
-- tsvector column, built from the exact same expression, indexed by the
-- exact same GIN index, read by the exact same
-- missive_message_intake_search_safe view (`SELECT *` — genuinely no
-- view change needed, confirmed by reading that view's real definition).
-- What changes: it is added as a PLAIN, nullable column first —
-- metadata-only, instant, identical in kind to the five screening_*
-- columns Section A already added successfully — kept correct forever by
-- a BEFORE INSERT OR UPDATE OF subject, body_text trigger instead of
-- Postgres's GENERATED STORED mechanism, and the historical backlog is
-- backfilled afterward in small, resumable, row-level-lock-only chunks —
-- never one statement scanning/rewriting the whole table.
--
-- WHY A TRIGGER, NOT JUST "ADD IT PLAIN AND BACKFILL, DONE": Postgres has
-- no ALTER TABLE syntax to convert an existing plain column into a true
-- GENERATED ALWAYS AS (...) STORED column, or to attach a generation
-- expression to a column after the fact. `ALTER TABLE ... ALTER COLUMN
-- ... ADD GENERATED { ALWAYS | BY DEFAULT } AS IDENTITY` is real Postgres
-- syntax, but it applies only to IDENTITY columns (sequence-backed
-- auto-increment values) — confirmed against Postgres's own ALTER TABLE
-- grammar, not assumed, and structurally unrelated to a generated-
-- EXPRESSION column like this one. The only way to get a true GENERATED
-- STORED column at all is CREATE TABLE or ALTER TABLE ... ADD COLUMN ...
-- GENERATED ALWAYS AS (...) STORED — and the latter is exactly the
-- single statement that keeps failing, for the structural reason above.
-- A trigger is the real, standard Postgres substitute for "this column
-- stays correct forever without any application code having to remember
-- to update it" when GENERATED STORED itself isn't reachable — same
-- self-maintaining guarantee, different plumbing underneath it.
--
-- CORRECTNESS, CHECKED AGAINST THE ORIGINAL COLUMN'S OWN COMMENT
-- (20260910030000, COMMENT ON COLUMN missive_message_intake.
-- search_document): that comment names two properties this replacement
-- must preserve exactly, and both are preserved:
--   1. "Computed over EVERY row, including held and flagged ones" — true
--      here too. The trigger carries no screening_result condition; it
--      fires on every INSERT and every UPDATE that touches subject or
--      body_text, regardless of screening state.
--   2. "Recomputes automatically if subject/body_text are ever redacted
--      under this table's CCPA process — no separate redaction step
--      needed" — true here too, and for the same underlying reason: no
--      redaction code exists yet for this table (confirmed — no file in
--      this repo references CCPA/redaction against
--      missive_message_intake today, so this was an equally forward-
--      looking, equally unexercised guarantee under the original design
--      too, not something this change weakens). Whenever that code is
--      written, it will redact by UPDATEing subject and/or body_text —
--      the same mechanism every other write to this table already uses
--      — and `UPDATE OF subject, body_text` fires on any UPDATE whose
--      SET list includes either column, redaction included.
--
-- A REAL, POSITIVE DIFFERENCE FROM THE ORIGINAL DESIGN, NOT JUST PARITY:
-- scoping the trigger to `UPDATE OF subject, body_text` (rather than a
-- bare UPDATE) means it does NOT re-fire on writes that never touch
-- either source column — concretely, the screening pass's own writes
-- (screening_result/_category/_tags/_version/_completed_at/
-- pipeline_status only — confirmed directly against archive-search/lib/
-- screening-pass.js's markConversationScreened(), which never sets
-- subject or body_text). Standard Postgres GENERATED STORED columns, by
-- contrast, are documented to recompute on every UPDATE of the row
-- regardless of which columns actually changed — meaning every one of
-- the screening pass's 254,000+ future writes would, under the original
-- design, have silently recomputed an unchanged tsvector. Flagged here
-- with the appropriate hedge: TARS should confirm this empirically
-- before it's quoted to Peter as a hard number — it is Neo's
-- understanding of standard Postgres behavior, not something measured
-- live in this environment.
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No. search_document does not
--       exist on any live row as of this writing (confirmed live,
--       2026-09-11, via a direct column listing against the real table —
--       all three prior ALTER TABLE attempts cleanly rolled back, no
--       partial state). The ADD COLUMN below is nullable with no
--       default — every existing row keeps reading exactly as it does
--       today, identical to Section A's five columns.
--   [x] Does this touch a table other code depends on?
--       missive_message_intake, yes — additively (1 new nullable column,
--       1 new trigger + its function, 1 new backfill function, 1
--       CONCURRENTLY index). The trigger only fires on INSERT or on
--       UPDATE OF subject/body_text — checked against every current
--       writer of this table: the Missive sync connector (INSERTs new
--       rows; a re-synced message that legitimately changes subject/
--       body_text correctly re-fires the trigger — that is the intended
--       behavior, not a side effect to guard against) and the screening
--       pass (never touches subject/body_text, confirmed above). No
--       existing reader selects search_document yet — no route ships
--       from this file, same as the original migration's own posture.
--   [x] Additive or destructive? Fully additive. Nothing dropped,
--       nothing existing altered in place.
--   [x] Tested on a copy of the data first? No staging copy exists (same
--       standing caveat every migration against this table carries).
--       Mitigated more thoroughly here than the original design could
--       manage: every statement in this file is either metadata-only
--       (the ADD COLUMN, the trigger/function DDL) or explicitly bounded
--       to a small, caller-chosen row count per call (the backfill
--       function below, via FOR UPDATE SKIP LOCKED and a LIMIT) — there
--       is no longer any single statement whose cost scales with all
--       254,000+ rows at once. The one exception, the CONCURRENTLY GIN
--       index build, has table-proportional cost by nature — but
--       CONCURRENTLY is specifically the mechanism that avoids turning
--       that cost into a blocking lock, the same tool the original
--       design already used correctly for this exact index, deliberately
--       sequenced here to run while the column is still all-NULL (see
--       Section B) so even that cost is trivial at build time and gets
--       paid incrementally, in the backfill's own small chunks, instead
--       of in one lump sum later.
--   [x] Governance go-ahead: this changes HOW search_document is kept
--       correct, not WHAT it contains, who can read it, or any property
--       Asimov/Mason actually reviewed. Same column name, type, defining
--       expression, GIN index, and consuming view as the version they
--       reviewed — missive_message_intake_search_safe needs no change at
--       all (`SELECT *`). This is the same class of judgment call
--       20260910030000 already made twice, in this same file, without
--       re-escalating to Asimov/Mason (NOT VALID + VALIDATE for the two
--       CHECK constraints; CONCURRENTLY for the three indexes) — a pure
--       execution-mechanism choice, not a change to decision criteria,
--       compliance logic, permission tiers, or guardrails (the actual
--       scope of GOVERNANCE.md Rule 6). Squarely within Neo's standing
--       schema authority on that precedent. This still requires Peter's
--       ordinary migration-gate approval before it is applied — that is
--       the standing "Peter approves every migration himself" rule that
--       applies to every migration regardless of compliance status, not
--       a governance re-review this change is asking to skip.
-- ============================================================


-- ============================================================
-- SECTION A: search_document — PLAIN, nullable column. Metadata-only in
-- Postgres 11+, near-instant regardless of table size — identical in
-- kind to 20260910030000 Section A's five screening_* columns, which
-- already applied successfully against this same table. Safe to run
-- exactly as pasted, on its own, in Supabase's SQL Editor.
-- ============================================================
ALTER TABLE missive_message_intake
  ADD COLUMN IF NOT EXISTS search_document tsvector;


-- ============================================================
-- SECTION B: the GIN index — built CONCURRENTLY now, deliberately BEFORE
-- the backfill (reordered from the original design, which built its
-- index after a fully-populated GENERATED column). Indexing 254,000+
-- all-NULL tsvector values is trivial and fast; every later backfill
-- UPDATE (Section D) then maintains this index incrementally, as an
-- ordinary, cheap side effect of a small row-level write — spreading the
-- real indexing cost across the whole backfill instead of paying it in
-- one lump sum against a fully-populated column afterward.
--
-- RUN ON ITS OWN, in Supabase's SQL Editor, exactly as pasted — NOT
-- combined with any other statement in this file. CONCURRENTLY cannot
-- run inside a transaction block (same restriction 20260910030000
-- already documented for its own three CONCURRENTLY indexes); pasting it
-- together with Section A/C/D would make Postgres reject it outright.
-- ============================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_missive_message_intake_search_document
  ON missive_message_intake USING GIN (search_document);


-- ============================================================
-- SECTION C: the self-maintaining trigger — the real substitute for
-- GENERATED ALWAYS AS (...) STORED (see the file header for why the
-- GENERATED mechanism itself cannot be attached to an existing column).
-- Identical expression to the original design, applied to the same two
-- source columns, in the same order, with the same 'english' config —
-- byte-for-byte the same output as the original GENERATED column would
-- have produced for every row.
--
-- Safe to run exactly as pasted, on its own or together with Section D,
-- in Supabase's SQL Editor — ordinary DDL, no CONCURRENTLY restriction.
-- ============================================================
CREATE OR REPLACE FUNCTION missive_message_intake_set_search_document()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_document := to_tsvector(
    'english',
    coalesce(NEW.subject, '') || ' ' || coalesce(NEW.body_text, '')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS missive_message_intake_search_document_trigger
  ON missive_message_intake;

CREATE TRIGGER missive_message_intake_search_document_trigger
  BEFORE INSERT OR UPDATE OF subject, body_text ON missive_message_intake
  FOR EACH ROW
  EXECUTE FUNCTION missive_message_intake_set_search_document();


-- ============================================================
-- SECTION D: the backfill function — ONE bounded, fast, row-level-lock-
-- only UPDATE per call. Matches this codebase's own established chunked-
-- backfill convention exactly: archive-search/lib/screening-pass.js's
-- 500-row driver chunks over this same table, and email-intake/
-- backfill-missive-history.js's checkpointed-segment pattern (both read
-- directly as part of this investigation, not assumed).
--
-- Reassigns subject to itself (a real value, unchanged) purely to fire
-- Section C's trigger through Postgres's own `UPDATE OF subject,
-- body_text` semantics — no second, separately-maintained "compute and
-- SET search_document explicitly" code path to keep in sync with the
-- trigger's own logic.
--
-- FOR UPDATE SKIP LOCKED: if the live Missive sync cron is concurrently
-- writing a row this chunk would otherwise select, skip it this round
-- rather than block waiting for it — it stays search_document IS NULL
-- and is naturally picked up by a later call.
--
-- This is the one piece of the ORIGINAL design's promise this migration
-- deliberately does NOT restore: with GENERATED STORED, "add the column"
-- and "every row is correct" were the same instant, by construction. With
-- this design, there is a real window, from the moment Section A runs
-- until the backfill finishes draining 254,000+ rows, during which most
-- rows have search_document IS NULL — a real, honest tradeoff, not
-- hidden. It is a safe window only because nothing reads search_document
-- yet: no route ships from this file (same posture as the original
-- migration), and missive_message_intake_search_safe's own `SELECT *`
-- simply passes NULL through for not-yet-backfilled rows until Q's
-- future search routes exist to care.
--
-- CALLING IT: either directly from Supabase's SQL Editor —
-- `SELECT backfill_missive_message_intake_search_document(5000);` — run
-- repeatedly until it returns 0 (roughly 51 calls at the default chunk
-- size for today's 254,000+ rows; each call is a small, fast, ordinary
-- UPDATE, safe to paste and re-run one line at a time, nothing like the
-- statement that was failing) — or, better, via a tiny driver Q builds
-- following screening-pass.js's own "call repeatedly until it returns 0"
-- pattern, so Peter never has to click Run more than once. Building that
-- driver is Q's work, not this file's — per Neo's standing role, no
-- application code or route ships from this migration.
--
-- Safe to run exactly as pasted, on its own or together with Section C,
-- in Supabase's SQL Editor.
-- ============================================================
CREATE OR REPLACE FUNCTION backfill_missive_message_intake_search_document(
  chunk_size integer DEFAULT 5000
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  rows_updated integer;
BEGIN
  UPDATE missive_message_intake
  SET subject = subject
  WHERE id IN (
    SELECT id FROM missive_message_intake
    WHERE search_document IS NULL
    ORDER BY id
    LIMIT chunk_size
    FOR UPDATE SKIP LOCKED
  );
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated;
END;
$$;


-- ============================================================
-- NOT PART OF THIS FILE, BUT UNBLOCKED AND INDEPENDENT — a reminder, not
-- a new statement. 20260910030000's other two CONCURRENTLY indexes,
-- idx_missive_message_intake_screening_pending and
-- idx_missive_message_intake_delivered_at, do not touch search_document
-- at all and were never reported to fail. Nothing in this file
-- supersedes them — Peter can run those two exactly as originally
-- written, independently of this file, whenever convenient.
-- ============================================================


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP FUNCTION IF EXISTS backfill_missive_message_intake_search_document(integer);
--
-- DROP TRIGGER IF EXISTS missive_message_intake_search_document_trigger
--   ON missive_message_intake;
-- DROP FUNCTION IF EXISTS missive_message_intake_set_search_document();
--
-- DROP INDEX IF EXISTS idx_missive_message_intake_search_document;
--
-- ALTER TABLE missive_message_intake DROP COLUMN IF EXISTS search_document;
-- -- Plain column drop — metadata-only, instant, at any point, backfilled
-- -- or not. Unlike the original design's GENERATED column (whose DROP
-- -- COLUMN was itself flagged as a second full-table-rewrite risk), this
-- -- drop carries no such cost — a real, additional safety margin this
-- -- design gets for free.
-- ============================================================
