-- Migration: 0007_archive_topic_suggestions_and_social_captions
-- Created:   2026-07-13
-- Author:    Neo (database specialist)
--
-- Extends the existing "Archive" capability (already live on
-- content_items.archived, used by projects/content-review/server.js) to two
-- more places Peter approved:
--
--   1. topic_suggestions.archived — lets a rejected/stale topic suggestion
--      be hidden from the discovery-feed review queue without deleting it.
--   2. social_captions.archived   — lets a standalone social post (or a
--      whole batch of them — see note below) be hidden from the review
--      queue without deleting it.
--
-- CONVENTION CHECK (done before writing this file, not guessed):
--   content_items.archived was inspected on the LIVE database via the
--   PostgREST OpenAPI introspection endpoint (GET /rest/v1/ with
--   `Accept: application/openapi+json`), since no migration file in this
--   repo actually creates it — it is undocumented schema drift (see
--   WARNING below). The live definition is:
--     archived BOOLEAN NOT NULL DEFAULT FALSE
--   This matches what projects/content-review/server.js already assumes:
--   `archived=eq.false` / `archived=eq.true` is used as a hard filter with
--   no NULL-handling special-casing anywhere in that file. The two new
--   columns below mirror this exactly — same type, same default, same
--   NOT NULL constraint.
--
-- WARNING — undocumented schema drift found while preparing this migration:
--   Three live columns have NO corresponding migration file anywhere in
--   supabase/migrations/: content_items.archived, social_captions.batch_id,
--   and social_captions.topic_label. They exist on the live database
--   (confirmed via the OpenAPI introspection above) but were evidently
--   added directly in the Supabase Dashboard SQL Editor without a
--   checked-in migration. This migration does not attempt to retroactively
--   document those — that's a separate cleanup Peter should decide on —
--   but it's flagged here so it isn't mistaken for an oversight in this
--   file. Because of this drift, the batch_id index below is written
--   defensively (IF NOT EXISTS) in case an index was also added out-of-band
--   alongside the column.
--
-- Design notes:
--   - Neither table is new, so no new RLS setup is needed — RLS is already
--     enabled at the table level on both topic_suggestions and
--     social_captions (from 20260710000000_content_engine_schema.sql) and
--     applies to all columns on those tables, including these two new ones.
--   - social_captions: standalone social posts (rows where
--     content_item_id IS NULL) are grouped into "batches" purely by sharing
--     a batch_id value — there is no separate batch table. Archiving a
--     "batch" means the application (Q's code) runs one UPDATE setting
--     archived = true for every row matching a given batch_id — that's
--     application logic, not something enforced by this column. What this
--     migration adds is the index that UPDATE needs to be efficient:
--     idx_social_captions_batch_id, a partial index (WHERE batch_id IS NOT
--     NULL) matching the existing partial-index pattern used for
--     topic_suggestions.youtube_video_id in 20260711000000 — batch_id is
--     only ever populated on standalone posts, so indexing just the
--     non-NULL values keeps the index small.
--   - No new dedicated index is added for `archived` itself on either
--     table. content_items.archived — the existing precedent this is
--     mirroring — has no dedicated index either, despite server.js using it
--     as a hard filter on every list view. These are small operator-facing
--     review-queue tables (drafts, topic suggestions, social captions), not
--     high-volume tables, so a sequential scan filtered by a boolean is not
--     a real cost here. If either table grows large enough for this to
--     matter, add a partial index (WHERE archived = false) at that time —
--     matching the existing idx_topic_suggestions_status /
--     idx_social_captions_status pattern is the natural next step.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- ALTER TABLE: topic_suggestions
-- Adds the archive flag. Mirrors content_items.archived exactly:
-- BOOLEAN NOT NULL DEFAULT FALSE.
-- ============================================================

ALTER TABLE topic_suggestions
  ADD COLUMN archived BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN topic_suggestions.archived IS
  'Hides a topic suggestion from the discovery-feed review queue without deleting it. Same convention as content_items.archived: BOOLEAN NOT NULL DEFAULT FALSE, queried as a hard filter (archived=eq.false / archived=eq.true).';


-- ============================================================
-- ALTER TABLE: social_captions
-- Adds the archive flag (same convention as above) plus the index needed
-- for the batch-archive bulk update (WHERE batch_id = ...).
-- ============================================================

ALTER TABLE social_captions
  ADD COLUMN archived BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN social_captions.archived IS
  'Hides a social caption (or, when bulk-updated by batch_id, a whole standalone-post batch) from the review queue without deleting it. Same convention as content_items.archived: BOOLEAN NOT NULL DEFAULT FALSE, queried as a hard filter (archived=eq.false / archived=eq.true).';

-- Partial index on batch_id so "archive this whole batch" (an UPDATE
-- ... WHERE batch_id = <id>, run by the application, not this migration)
-- and any "show me this batch" read both stay index-backed. batch_id is
-- only ever populated on standalone posts (content_item_id IS NULL), so
-- only indexing the non-NULL values keeps this small — same pattern as
-- idx_topic_suggestions_youtube_video_id in 20260711000000.
-- IF NOT EXISTS guards against the undocumented-drift possibility that
-- this index was already added out-of-band alongside the batch_id column.
CREATE INDEX IF NOT EXISTS idx_social_captions_batch_id
  ON social_captions(batch_id)
  WHERE batch_id IS NOT NULL;


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP INDEX IF EXISTS idx_social_captions_batch_id;
-- ALTER TABLE social_captions DROP COLUMN IF EXISTS archived;
-- ALTER TABLE topic_suggestions DROP COLUMN IF EXISTS archived;
--
-- ============================================================
