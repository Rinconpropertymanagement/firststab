-- ============================================================
-- Migration: 20260924030000_fix_archive_search_corpus_backfill_batch_stale_plan
-- Created:   2026-09-24
-- Author:    Neo (database specialist) — direct live-incident diagnosis and
--            fix, requested after the backfill failed/needed manual
--            intervention 4 times today under a 30-second statement timeout.
--
-- INCIDENT: archive_search_corpus_backfill_batch() (20260924010000,
-- Section 7) was measured live, via Supabase's SQL Editor, two ways:
--
--   1. The SAME predicate as a literal top-level query:
--      35.44ms, Index Scan on idx_missive_message_intake_eligible_id,
--      Buffers: shared hit=9221 read=13.
--   2. Called through the actual RPC the backfill script uses:
--      27,945ms — right at the 30s statement timeout. EXPLAIN only shows
--      an opaque "Function Scan" (no internal plan visible). Buffers:
--      shared hit=100823 read=58670 dirtied=2688 (~470MB of real disk
--      reads to process 1000 rows).
--
-- DIAGNOSIS (verified directly against 20260924010000's real function
-- text, not assumed):
--
-- archive_search_corpus_backfill_batch() is LANGUAGE sql and contains a
-- writable CTE (the `ins AS (INSERT ... RETURNING id)` clause). A SQL
-- function whose body includes a data-modifying statement can NEVER be
-- inlined by the planner — this is an unconditional PostgreSQL rule, not
-- specific to this function. (It is additionally non-inlinable because it
-- carries a `SET search_path = public` clause — inline_function() in
-- Postgres's planner excludes any function with a non-null proconfig — but
-- the writable CTE alone already rules out inlining regardless.) This
-- non-inlining is exactly what the EXPLAIN evidence confirms empirically:
-- a real, inlined query would show its full internal plan; an opaque
-- "Function Scan" node is what you get when the function body is executed
-- as its own separately-planned unit via SPI, invisible to the outer
-- EXPLAIN.
--
-- Because the function is never inlined, its internal `candidates` SELECT
-- (the same SELECT that ran in 35ms as a literal query) is planned and
-- CACHED via Postgres's ordinary plancache — the same "try up to 5 custom
-- (literal-aware) plans, then possibly switch to and reuse ONE generic
-- (parameter-blind) plan" mechanism used for PREPARE'd statements and
-- PL/pgSQL. The backfill script (run-archive-search-corpus-backfill.js)
-- calls this RPC ~255 times in a tight loop with a fresh literal
-- p_cursor_id each call; once a backend session's plan for this function
-- settles into a generic plan (built with NO knowledge of any specific
-- cursor value), Postgres can no longer use real selectivity information
-- for `m.id > p_cursor_id` or for the per-row archive_search_message_
-- is_eligible() filter, and can silently fall back to a far more
-- expensive access path than the targeted, LIMIT-bounded Index Scan the
-- literal query gets every time. That matches the evidence precisely: the
-- RPC path touches ~17x more buffers and reads ~470MB from disk (mostly
-- cold pages) versus ~13 disk reads for the literal version, for the
-- identical logical query.
--
-- RULED OUT, checked directly, not assumed:
--   - ON CONFLICT (id): archive_search_corpus.id is PRIMARY KEY
--     (20260924010000, Section 2) — a real, unique btree index backs the
--     ON CONFLICT target. Not the problem.
--   - The partial index's predicate itself (screening_result IN ('clear',
--     'flagged_protected_class')) is identical literal text in both the
--     query and the index definition (20260924020000) in BOTH call paths
--     — its applicability does not depend on the cursor parameter at all,
--     so this specific predicate is not what's failing to be proven.
--   - archive_search_message_is_eligible() itself is unchanged and behaves
--     identically regardless of caller — it also carries SET search_path,
--     so it is never inlined either way. Its per-row cost is the same in
--     both paths; the difference is how many rows it ends up being
--     evaluated against, which is a function of the outer scan shape
--     described above.
--
-- FIX: rewrite archive_search_corpus_backfill_batch() as LANGUAGE plpgsql,
-- using RETURN QUERY EXECUTE ... USING for the entire candidates/insert
-- statement. Per PostgreSQL's own documented EXECUTE behavior: "unlike
-- other commands in PL/pgSQL, a command run by EXECUTE is not prepared and
-- saved just once during the life of the session — the command is
-- prepared each time the statement is run," using the actual USING
-- parameter values. This guarantees a fresh, literal-aware plan on every
-- single call — the same plan shape the 35ms literal query already proved
-- correct — with no dependency on plan-cache heuristics, connection
-- pooling/session reuse, or how far the cursor has advanced. The
-- RPC's name, argument list, and return shape are UNCHANGED, so
-- run-archive-search-corpus-backfill.js needs no changes at all.
--
-- Trade-off, stated plainly: EXECUTE re-parses and re-plans this ~20-line
-- statement on every call instead of reusing a cached plan. That overhead
-- is sub-millisecond-to-a-few-milliseconds — negligible next to avoiding a
-- 28-second query that was about to time out a 5th time.
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK
-- ============================================================
--   [x] Rollback exists — see bottom of this file (re-apply 20260924010000
--       Section 7's original text verbatim; NOT recommended, restores the
--       slow/timeout-prone behavior this migration fixes).
--   [x] Does this break any existing data? No. Same table, same columns,
--       same ON CONFLICT semantics — only the function's internal
--       planning strategy changes.
--   [x] Does this touch a table other code depends on? No new table
--       touches beyond what 20260924010000 already added. The function
--       signature and RETURNS TABLE shape are byte-for-byte unchanged, so
--       every existing caller (run-archive-search-corpus-backfill.js) is
--       unaffected.
--   [x] Additive or destructive to SCHEMA? Neither — CREATE OR REPLACE
--       FUNCTION with an identical name/signature/return type, so this
--       replaces the function body in place without dropping it.
--   [x] Tested on a copy of data first? No staging copy exists (standing
--       project caveat). Mitigated by: the new plan is the SAME plan
--       already measured at 35ms against real production data via the
--       literal EXPLAIN; this migration only forces the function to use
--       that already-proven plan every call, it does not change what rows
--       are selected or written. Recommend Peter re-run
--       EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM
--       archive_search_corpus_backfill_batch('753830f8-5c17-4cff-a7ba-6464101cd3b0'::uuid, 1000);
--       once after applying, to directly confirm it's back near ~35ms
--       before resuming the backfill loop.
--   [x] Governance go-ahead needed? No. This changes only HOW the database
--       computes an already-approved query (performance/plan-caching
--       fix) — it does not change eligibility logic, access control, or
--       what data is exposed. No new conditions triggered.
-- ============================================================

CREATE OR REPLACE FUNCTION archive_search_corpus_backfill_batch(
  p_cursor_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 5000
)
RETURNS TABLE (examined_count INT, written_count INT, next_cursor UUID)
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RETURN QUERY EXECUTE $q$
    WITH candidates AS (
      SELECT m.id, m.mailbox_key, m.missive_conversation_id, m.subject, m.from_address, m.delivered_at, m.body_text, m.search_document
      FROM missive_message_intake m
      WHERE m.screening_result IN ('clear', 'flagged_protected_class')
        AND ($1 IS NULL OR m.id > $1)
        AND archive_search_message_is_eligible(m.id)
      ORDER BY m.id ASC
      LIMIT $2
    ),
    ins AS (
      INSERT INTO archive_search_corpus
        (id, mailbox_key, missive_conversation_id, subject, from_address, delivered_at, body_text, search_document, synced_at)
      SELECT id, mailbox_key, missive_conversation_id, subject, from_address, delivered_at, body_text, search_document, NOW()
      FROM candidates
      ON CONFLICT (id) DO UPDATE SET
        subject          = EXCLUDED.subject,
        from_address      = EXCLUDED.from_address,
        delivered_at      = EXCLUDED.delivered_at,
        body_text         = EXCLUDED.body_text,
        search_document   = EXCLUDED.search_document,
        synced_at         = NOW()
      RETURNING id
    )
    SELECT
      (SELECT count(*) FROM candidates)::INT,
      (SELECT count(*) FROM ins)::INT,
      (SELECT id FROM candidates ORDER BY id DESC LIMIT 1)
  $q$
  USING p_cursor_id, p_limit;
END;
$$;

REVOKE ALL ON FUNCTION archive_search_corpus_backfill_batch(UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION archive_search_corpus_backfill_batch(UUID, INT) TO service_role;

COMMENT ON FUNCTION archive_search_corpus_backfill_batch(UUID, INT) IS
  'Cursor-paginated batch upsert used ONLY by run-archive-search-corpus-backfill.js. REWRITTEN 2026-09-24 (this migration) from LANGUAGE sql to LANGUAGE plpgsql + RETURN QUERY EXECUTE ... USING, after live evidence showed the original LANGUAGE sql version (containing a writable CTE, therefore never inlinable) settling into a stale, parameter-blind cached plan that read ~470MB per 1000-row batch and approached the 30s statement timeout, versus 35ms for the identical query run as literal top-level SQL. EXECUTE forces PostgreSQL to re-plan this statement fresh, against the real literal cursor value, on every call — no cross-call plan caching, no dependency on connection-pooling/session-reuse behavior. Same signature, same return shape, same ON CONFLICT DO UPDATE semantics as the original — callers need no changes. See this migration file''s own header for the full diagnosis.';

-- ============================================================
-- ROLLBACK (NOT recommended — restores the timeout-prone behavior)
-- ============================================================
-- To roll back, re-apply 20260924010000's Section 7 definition of
-- archive_search_corpus_backfill_batch(UUID, INT) verbatim (LANGUAGE sql,
-- static WITH ... AS query body). This restores the original stale-plan
-- bug this migration exists to fix.
-- ============================================================
