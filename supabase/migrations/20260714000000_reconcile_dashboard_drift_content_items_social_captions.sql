-- Migration: 0008_reconcile_dashboard_drift_content_items_social_captions
-- Created:   2026-07-14
-- Author:    Neo (database specialist)
--
-- WHAT THIS FILE IS — READ THIS FIRST:
--   This is NOT a forward migration that changes the live database. The
--   live database already has all three columns documented below. This is
--   a RETROACTIVE / RECONCILIATION migration: it exists purely so the
--   checked-in migration history in supabase/migrations/ matches what is
--   actually running in production. Nothing about live behavior changes
--   when this file is applied.
--
-- WHY THIS FILE EXISTS:
--   While preparing 20260713000000_archive_topic_suggestions_and_social_captions.sql,
--   Neo found three live columns with no corresponding migration file
--   anywhere in this repo:
--     1. content_items.archived
--     2. social_captions.batch_id
--     3. social_captions.topic_label
--   All three exist on the live Supabase project today. They were evidently
--   added directly via the Supabase Dashboard SQL Editor at some point,
--   bypassing this project's convention that every schema change gets a
--   checked-in migration file. 20260713000000 flagged this drift but
--   deliberately did not fix it (out of scope at the time). This file is
--   that follow-up cleanup, requested by Peter.
--
-- HOW THE DEFINITIONS BELOW WERE CONFIRMED (not guessed):
--   content_items.archived — already confirmed directly against the live
--   database via the PostgREST OpenAPI introspection endpoint while writing
--   20260713000000 (see that file's header). Re-used here as-is:
--     archived BOOLEAN NOT NULL DEFAULT FALSE
--
--   social_captions.batch_id and social_captions.topic_label — confirmed
--   directly against the live database just now, the same way: GET
--   <SUPABASE_URL>/rest/v1/ with `Accept: application/openapi+json`,
--   authenticated with the service role key from the root .env (read-only
--   introspection, no data touched, nothing written). The live OpenAPI
--   schema for social_captions lists `batch_id` and `topic_label` as
--   present in `properties` but ABSENT from the table's `required` array
--   (whose members are exactly the NOT NULL columns: id, platform,
--   caption_text, status, created_at, updated_at, archived). Neither
--   property has a `default` entry. So, confirmed live definitions:
--     batch_id    uuid  NULL, no default
--     topic_label text  NULL, no default
--
--   Cross-checked against real usage in
--   projects/content-review/server.js (Q's code, not guessed either):
--     - Line ~1958: `if (!c.batch_id) continue; // safety: skip any legacy
--       row with no batch grouping` — the code explicitly expects some
--       rows to have a missing/NULL batch_id and handles it, which only
--       makes sense if batch_id is nullable. Consistent with the
--       introspected definition above.
--     - Lines ~1960, ~1974, ~2012: `c.topic_label` is always read with a
--       `|| 'Untitled social post'` fallback, never assumed to be present.
--       Consistent with topic_label being nullable with no default.
--   No evidence anywhere in server.js that either column is required to be
--   present on every row (e.g. captions tied to a content_item via
--   content_item_id, rather than being a standalone batch, appear to have
--   no batch_id/topic_label at all) — nullable, no default is the correct
--   reconciled definition, not an approximation.
--
-- HOW THIS FILE IS SAFE TO RUN TWICE, IN TWO DIFFERENT SCENARIOS:
--   Every ADD COLUMN below uses IF NOT EXISTS. That makes this file work
--   correctly in both situations it could ever be run in:
--     (a) Against the CURRENT live database, where all three columns
--         already exist — IF NOT EXISTS makes every statement a harmless
--         no-op. Running this file changes nothing. It just confirms, on
--         record, that reality matches what's written here.
--     (b) Against a hypothetical FRESH database, rebuilt from scratch by
--         running every file in supabase/migrations/ in order — at the
--         point this file runs, none of these three columns exist yet
--         (no earlier migration creates them), so IF NOT EXISTS lets the
--         ADD COLUMN statements actually create them for real, with the
--         same types/nullability/defaults as production.
--   A plain ADD COLUMN (without IF NOT EXISTS) would fail with a
--   "column already exists" error in scenario (a), which is exactly why
--   that form is NOT used here.
--
-- Design notes:
--   - No RLS changes needed — content_items and social_captions already
--     have RLS enabled at the table level (from
--     20260710000000_content_engine_schema.sql), which covers these
--     columns automatically.
--   - No index is added here for batch_id. The partial index
--     idx_social_captions_batch_id was already created by
--     20260713000000_archive_topic_suggestions_and_social_captions.sql
--     (also written IF NOT EXISTS, so it's safe under both scenarios
--     above too). Duplicating it here would be redundant.
--
-- Rollback: intentionally NOT a plain DROP — see explanation below instead
-- of a rollback script.
-- ============================================================


-- ============================================================
-- ALTER TABLE: content_items
-- Documents the live column. No-op on the current database.
-- ============================================================

ALTER TABLE content_items
  ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;


-- ============================================================
-- ALTER TABLE: social_captions
-- Documents the two live columns. No-op on the current database.
-- ============================================================

ALTER TABLE social_captions
  ADD COLUMN IF NOT EXISTS batch_id UUID;

ALTER TABLE social_captions
  ADD COLUMN IF NOT EXISTS topic_label TEXT;

COMMENT ON COLUMN social_captions.batch_id IS
  'Groups standalone social posts (content_item_id IS NULL) into a single reviewable "batch" — there is no separate batch table, grouping is purely by sharing this value. Nullable: rows tied to a content_item, or legacy rows, may have no batch_id (see projects/content-review/server.js, which explicitly skips rows with a missing batch_id when building the batch list).';

COMMENT ON COLUMN social_captions.topic_label IS
  'Human-readable label for a standalone-post batch, shown in the review queue UI. Nullable, no default — projects/content-review/server.js always falls back to "Untitled social post" when absent, never assumes it is present.';


-- ============================================================
-- ROLLBACK
-- ============================================================
--
-- A conventional "DROP COLUMN" rollback is deliberately NOT provided here,
-- because it would be actively harmful, not safe:
--
--   - content_items.archived backs the live, in-use content-archive
--     feature in projects/content-review/server.js. Dropping it would
--     break that feature and silently lose which items were archived.
--   - social_captions.batch_id and social_captions.topic_label back the
--     live, in-use standalone social-post batching and review-queue
--     display in the same file. Dropping either would break batch
--     grouping and the review queue UI, and lose data (which posts
--     belonged to which batch, and their display labels).
--
-- These are not new, untested changes this migration is introducing —
-- they are pre-existing production functionality this file is only
-- documenting. "Rolling back" a documentation file by deleting real,
-- working, in-use columns would make the database worse than before this
-- file existed, not restore it to a prior safe state.
--
-- If these columns ever genuinely need to be removed, that must be its
-- own deliberate, forward migration — written only after confirming
-- nothing in projects/content-review/server.js (or elsewhere) still reads
-- or writes them, not treated as the "undo" of this reconciliation file.
--
-- ============================================================
