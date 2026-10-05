-- ============================================================
-- Migration: 20260911010000_search_document_pending_index
-- Created:   2026-09-11
--
-- Fixes a real performance bug discovered while actually running the
-- backfill from 20260911000000_search_document_trigger_backfill.sql
-- against the live 254,000+ row missive_message_intake table.
--
-- THE PROBLEM: backfill_missive_message_intake_search_document()'s query
-- ("WHERE search_document IS NULL ORDER BY id LIMIT chunk_size") has no
-- index to satisfy the IS NULL filter (a GIN index on search_document,
-- built by the prior migration, does not index NULL values and cannot
-- help here). Without one, Postgres has to walk the table in id order,
-- skipping every already-backfilled row, to find the next unfilled
-- batch. Confirmed live: this got progressively slower as more rows were
-- backfilled (every already-done row makes every future call scan
-- further), eventually timing out even at a 10-row chunk size and even
-- on a fresh, non-adversarial retry — a real, structural bug, not
-- something that "settling down" or a smaller chunk size fixes on its
-- own.
--
-- THE FIX: a partial index — it only ever contains rows still needing a
-- search_document value, so it shrinks as the backfill progresses and
-- stays cheap to query regardless of how much has already been done.
-- Fully additive, no risk to existing data, same CONCURRENTLY discipline
-- every index in this schema already uses on this table.
--
-- Once the backfill finishes and every row has search_document set, this
-- index becomes permanently empty and harmless — safe to drop then, or
-- just leave it (near-zero ongoing cost at that point). Not dropped
-- automatically by this file; a housekeeping note, not an action item.
--
-- RUN ON ITS OWN — CONCURRENTLY cannot run inside a transaction block,
-- same restriction every other CONCURRENTLY statement in this schema
-- documents.
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_missive_message_intake_search_document_pending
  ON missive_message_intake (id)
  WHERE search_document IS NULL;

-- ============================================================
-- ROLLBACK
-- ============================================================
-- DROP INDEX IF EXISTS idx_missive_message_intake_search_document_pending;
-- ============================================================
