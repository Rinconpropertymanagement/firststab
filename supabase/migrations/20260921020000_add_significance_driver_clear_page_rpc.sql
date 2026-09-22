-- ============================================================
-- Migration: 20260921020000_add_significance_driver_clear_page_rpc
-- Created:   2026-09-21
-- Author:    Neo (database specialist)
--
-- WHY THIS EXISTS — PRODUCTION INCIDENT, security_barrier BLOCKING THE
-- PLANNER FROM USING THE INDEX IT HAS
-- ============================================================
-- significance-pass.js's fetchDriverPage() (the same id-ordered pagination
-- the real production run-significance-batch.js driver uses) queries
-- missive_message_intake_search_safe_clear_branch, walking it 500 rows at a
-- time via `ORDER BY id ASC ... LIMIT 500`. That view carries
-- security_barrier = true (added 20260918020000, to protect the same
-- PII-bearing, pre-screening content class as missive_message_intake_
-- search_safe). Individual page fetches have been intermittently taking
-- 10-28s (occasionally exceeding service_role's 30s statement_timeout,
-- migration 20260918030000, and crashing real runs) despite a partial index
-- that exists specifically to serve this query
-- (idx_missive_message_intake_clear_id, 20260914000000).
--
-- ROOT CAUSE — CONFIRMED LIVE, not hypothesized (Peter, running the
-- diagnostics below directly in Supabase's SQL Editor, 2026-09-21):
--
--   Query A — same filter/order/limit shape, run DIRECTLY against the base
--   table (bypassing the view):
--     EXPLAIN (ANALYZE, BUFFERS)
--     SELECT id, mailbox_key, missive_conversation_id, delivered_at
--     FROM missive_message_intake
--     WHERE screening_result = 'clear'
--     ORDER BY id ASC
--     LIMIT 500;
--   -> 76.3ms. Plan: Index Scan using idx_missive_message_intake_clear_id.
--      Buffers: shared hit=372 read=131.
--
--   Query B — the SAME shape, through the actual view the real driver
--   queries:
--     EXPLAIN (ANALYZE, BUFFERS)
--     SELECT id, mailbox_key, missive_conversation_id, delivered_at
--     FROM missive_message_intake_search_safe_clear_branch
--     ORDER BY id ASC
--     LIMIT 500;
--   -> 1030.7ms — 13x slower. Plan: Limit -> Gather Merge -> Sort (top-N
--      heapsort) -> Subquery Scan on
--      missive_message_intake_search_safe_clear_branch -> Parallel Seq
--      Scan on missive_message_intake, Filter: screening_result='clear'
--      (Rows Removed by Filter: 398 per worker). Buffers: shared
--      hit=31478 read=18875. The partial index is not used at all — this
--      scans and sorts the ENTIRE 'clear' set (~148,586 rows and growing)
--      on every single page.
--
--   Query B run again immediately after (same statement, same session):
--   986.4ms, same exact plan, same buffer counts (hit=31478 read=18875,
--   essentially unchanged). This rules out cold cache / disk I/O variance
--   as the explanation -- it is a consistent, deterministic PLAN CHOICE by
--   the planner every time the view is queried, not I/O variance. The fix
--   has to change which plan gets chosen, not just hope for a warmer
--   cache or accept the slowness as inherent to disk access patterns.
--
-- WHY: security_barrier = true makes the planner treat the view as a
-- security-barrier subquery boundary it must conservatively evaluate
-- (effectively materialize/filter) before applying the outer query's
-- ORDER BY / LIMIT on top -- it will not push the sort/limit through the
-- barrier to use an index that would otherwise satisfy both the filter and
-- the ordering in one pass. This scales with the size of the whole 'clear'
-- set, which explains both today's timeouts and why this regressed since
-- 20260918020000's own note that this view "was independently walked live
-- for 55 consecutive real pages / 27,500 rows with flat ~200-330ms timing"
-- -- the 'clear' set has grown substantially since then (84,389+ matching
-- messages in just the 1-year window alone as of this week).
--
-- ============================================================
-- THE FIX — BYPASS THE VIEW ENTIRELY FOR THIS ONE CALLER, WITHOUT TOUCHING
-- security_barrier
-- ============================================================
-- security_barrier's actual protection (blocking a leaky, non-leakproof
-- predicate from being evaluated against rows the caller shouldn't see) is
-- not doing real work for this specific, single, already-known caller:
-- fetchDriverPage() is invoked exclusively via the service_role key, which
-- already bypasses RLS and has full, direct, unrestricted access to
-- missive_message_intake itself (Query A above proves this -- it already
-- reads the base table directly, successfully). There is no privilege gap
-- between the view and the base table for this caller to protect against;
-- nothing is "leaked" by a role that already has complete access to
-- everything the view would ever show it. Rather than resolve that
-- reasoning into "therefore it's safe to drop security_barrier from the
-- view" (a change that would affect every current and future caller of
-- that shared view, not just this one, and would need to first confirm
-- via information_schema.role_table_grants that no lower-privileged role
-- can reach it -- not yet independently confirmed, and a real security
-- property change on PII-adjacent content in this Fair-Housing-relevant
-- pipeline, so not something to change on inference alone) -- this
-- migration instead adds a narrow, purpose-built function that queries the
-- base table directly, with a hardcoded, fixed filter/order/limit shape
-- (no caller-supplied predicate beyond a plain cursor comparison, no leaky
-- function, nothing an untrusted caller could use to compose an unintended
-- query). This sidesteps the view/security_barrier boundary -- and the
-- planning restriction it imposes -- entirely, for this one query shape,
-- while leaving missive_message_intake_search_safe_clear_branch and its
-- security_barrier setting completely untouched for every other purpose.
--
-- This reproduces Query A's fast plan deterministically (same base-table
-- query, same available index, no view involved), not by luck of caching --
-- consistent with the finding above that this is a plan-choice problem, not
-- an I/O-variance one.
--
-- CORRECTED after a real, live apply failure (Peter, 2026-09-21):
--   ERROR: 42P13: return type mismatch in function declared to return record
--   DETAIL: Final statement returns text instead of uuid at column 3.
-- The original draft declared missive_conversation_id UUID based on a
-- sampled row VALUE (a UUID-shaped string), which cannot distinguish a real
-- uuid column from a text column holding uuid-formatted strings -- not a
-- real type check. Corrected and re-verified for real this time via
-- PostgREST's own OpenAPI schema document (GET {SUPABASE_URL}/rest/v1/ with
-- Accept: application/openapi+json -- definitions.missive_message_intake.
-- properties), which reports Postgres's actual declared column
-- types/formats, not a sampled value:
--   id                      -> format "uuid"                       -> UUID
--   mailbox_key             -> format "text"                       -> TEXT
--   missive_conversation_id -> format "text"                       -> TEXT (was wrongly UUID)
--   delivered_at            -> format "timestamp with time zone"   -> TIMESTAMPTZ
-- All four columns used in this function's RETURNS TABLE are confirmed
-- against this real source, not re-asserted from memory.
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No. No table, row, or column is
--       touched, changed, or removed. This adds one new function only.
--   [x] Does this touch a table other code depends on? Reads
--       missive_message_intake (read-only, SELECT) -- the same table and
--       columns fetchDriverPage() already reads today via the view, same
--       shape, same scope. No writes, no schema change to that table.
--   [x] Additive or destructive? Fully additive -- one new function,
--       nothing dropped, nothing altered. missive_message_intake_search_
--       safe_clear_branch and its security_barrier setting are completely
--       untouched by this migration.
--   [x] Is this safe to apply directly? Yes -- CREATE OR REPLACE FUNCTION
--       plus REVOKE/GRANT is a fast catalog-only change, no lock on
--       missive_message_intake itself, no data rewrite.
--   [x] Governance go-ahead needed? No -- this does not touch
--       security_barrier, RLS, or any access grant on existing objects; it
--       does not change what any existing role can see (service_role
--       already has full read access to missive_message_intake directly,
--       proven by Query A); it sends no message and makes no decision
--       about a tenant or applicant. Not a compliance build under
--       CLAUDE.md's definition. (Dropping security_barrier from the view
--       itself was considered and explicitly NOT done here for exactly
--       this reason -- that alternative would need its own Asimov review
--       before ever being applied; this migration avoids needing that
--       review at all.)
-- ============================================================

CREATE OR REPLACE FUNCTION archive_search_significance_driver_next_clear_page(
  p_cursor_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 500
)
RETURNS TABLE (
  id UUID,
  mailbox_key TEXT,
  missive_conversation_id TEXT,
  delivered_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT m.id, m.mailbox_key, m.missive_conversation_id, m.delivered_at
  FROM missive_message_intake m
  WHERE m.screening_result = 'clear'
    AND (p_cursor_id IS NULL OR m.id > p_cursor_id)
  ORDER BY m.id ASC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION archive_search_significance_driver_next_clear_page(UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION archive_search_significance_driver_next_clear_page(UUID, INT) TO service_role;

COMMENT ON FUNCTION archive_search_significance_driver_next_clear_page(UUID, INT) IS
  'Added 20260921020000, after live EXPLAIN evidence showed missive_message_intake_search_safe_clear_branch''s security_barrier=true blocks the planner from pushing ORDER BY id/LIMIT through the view boundary into idx_missive_message_intake_clear_id, forcing a full parallel seq scan + sort of the whole screening_result=''clear'' set (~148,586+ rows) on every driver page (1030.7ms vs 76.3ms direct against the base table, confirmed deterministic/plan-based on a repeat run, not cache variance). This function bypasses the view for significance-pass.js''s fetchDriverPage() only, querying missive_message_intake directly with the identical fixed filter/order/limit shape the view already restricted itself to -- no leaky predicate, no broader access than service_role already has. security_barrier on the view itself is intentionally left untouched for every other caller/purpose.';

-- ============================================================
-- ROLLBACK (run this statement to undo this migration)
-- ============================================================
-- DROP FUNCTION IF EXISTS archive_search_significance_driver_next_clear_page(UUID, INT);
-- ============================================================
