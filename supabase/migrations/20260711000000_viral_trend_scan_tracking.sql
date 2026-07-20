-- Migration: 0005_viral_trend_scan_tracking
-- Created:   2026-07-11
-- Author:    Neo (database specialist)
--
-- Follow-on to 20260710000000_content_engine_schema.sql. Adds what the
-- "viral trend scan" feed (YouTube/Google Trends, every 3 days) needs that
-- the original topic_suggestions table didn't yet cover:
--
--   1. topic_suggestions.youtube_video_id — lets Q's scan script check
--      "have I already suggested this video?" before inserting a new row,
--      and lets Tron render a "Watch the video" link on the review page.
--   2. topic_suggestions.rejection_note — optional one-line reason Peter
--      can leave when he rejects a suggestion. Captured now for potential
--      future use; nothing reads it yet.
--   3. topic_scan_runs (new table) — one row per scan attempt (any of the
--      three feeds), so the /topics review page can show "last scan:
--      succeeded / failed" instead of a silent failure when, e.g., the
--      YouTube API key is bad, quota is exceeded, or the network call
--      times out.
--
-- Design notes:
--   - youtube_video_id stores the bare video ID (e.g. "dQw4w9WgXcQ"), not
--     the full URL. The ID is the canonical, stable value — it's what an
--     exact-match dedup lookup should compare against. The full watch URL
--     is a trivial derivation (https://www.youtube.com/watch?v=<id>) that
--     Tron can build with one string interpolation; storing both would
--     just create two values that could drift out of sync for no benefit.
--   - youtube_video_id is nullable because only the viral_trend_scan feed
--     has a video to reference — legislative_trend_forum_scan and
--     civic_council_monitoring rows will always leave it NULL.
--   - topic_scan_runs is an append-only log (one row written per scan run,
--     never updated afterward), same shape as content_edits and
--     content_section_edits in the prior migration — so, matching that
--     precedent, it gets created_at only, no updated_at/trigger.
--   - topic_scan_runs.feed_source reuses the exact same three-value CHECK
--     as topic_suggestions.feed_source, so logging isn't locked to just
--     the viral scan if the other two feeds ever want run-tracking too.
--
-- RLS is enabled on the new table and locked down by default, matching
-- every other table in this schema — no permissive policy is added here.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- ALTER TABLE: topic_suggestions
-- Adds the YouTube video reference (for dedup + the review-page link) and
-- an optional rejection reason.
-- ============================================================

ALTER TABLE topic_suggestions
  ADD COLUMN youtube_video_id TEXT,      -- bare video ID, e.g. "dQw4w9WgXcQ"; NULL for non-video feeds
  ADD COLUMN rejection_note   TEXT;      -- optional one-line reason Peter leaves when rejecting

COMMENT ON COLUMN topic_suggestions.youtube_video_id IS
  'YouTube video ID referenced by a viral_trend_scan suggestion. NULL for legislative_trend_forum_scan and civic_council_monitoring rows. Used for exact-match dedup before inserting a new suggestion.';

COMMENT ON COLUMN topic_suggestions.rejection_note IS
  'Optional one-line reason Peter gives when rejecting a suggestion. Captured for potential future use; no logic consumes it yet.';

-- Partial index: only viral_trend_scan rows ever populate this column, so
-- indexing just the non-NULL values keeps the index small and keeps the
-- every-scan-run dedup lookup ("has this video already been suggested?")
-- fast without wasting space on rows that will never match.
CREATE INDEX idx_topic_suggestions_youtube_video_id
  ON topic_suggestions(youtube_video_id)
  WHERE youtube_video_id IS NOT NULL;


-- ============================================================
-- TABLE: topic_scan_runs
-- What it stores: one row per discovery-feed scan attempt — did it run,
-- did it succeed, how many new suggestions it produced, and if it failed,
-- why. This is what turns a silent scan failure (bad API key, quota
-- exceeded, network error) into something the /topics review page can
-- show Peter ("last scan: succeeded / failed").
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE topic_scan_runs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_source           TEXT NOT NULL
                          CHECK (feed_source IN (
                            'legislative_trend_forum_scan',
                            'viral_trend_scan',
                            'civic_council_monitoring'
                          )),
  ran_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- when this scan attempt executed
  succeeded             BOOLEAN NOT NULL,                    -- did the scan complete without error
  suggestions_created   INTEGER NOT NULL DEFAULT 0,          -- how many new topic_suggestions rows it inserted
  error_message         TEXT,                                -- nullable — populated only when succeeded = FALSE
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE topic_scan_runs ENABLE ROW LEVEL SECURITY;

-- Supports "what's the latest run for this feed" (ORDER BY ran_at DESC
-- per feed_source), which is exactly what the review page's status
-- banner needs on every page load.
CREATE INDEX idx_topic_scan_runs_feed_source_ran_at
  ON topic_scan_runs(feed_source, ran_at DESC);


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP TABLE IF EXISTS topic_scan_runs;
--
-- DROP INDEX IF EXISTS idx_topic_suggestions_youtube_video_id;
-- ALTER TABLE topic_suggestions DROP COLUMN IF EXISTS rejection_note;
-- ALTER TABLE topic_suggestions DROP COLUMN IF EXISTS youtube_video_id;
--
-- ============================================================
