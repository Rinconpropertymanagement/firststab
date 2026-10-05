-- ============================================================
-- Migration: 20260913000000_fix_search_safe_view_union_dedup_cost
-- Created:   2026-09-13
-- Author:    Neo (database specialist)
--
-- Fixes a real, live production bug Q hit tonight while building the
-- archive-search route: missive_message_intake_search_safe (the ONLY
-- view every archive-search search/message route may query) times out
-- (Postgres error 57014, statement timeout, ~8.2s) on EVERY query Q
-- tried against it — including a bare "SELECT id LIMIT 1" with no
-- filters at all. The identical predicate run directly against the base
-- table (missive_message_intake, e.g. screening_result = 'clear' LIMIT 1)
-- runs in 150-300ms. So the problem is specifically in the view, not the
-- underlying table or its indexes (idx_missive_message_intake_
-- screening_result, added 20260912020000, is real and working).
--
-- ============================================================
-- THIS IS NOT A REGRESSION OF 20260912040000_fix_search_safe_view_seq_
-- scan.sql / 20260912050000_reconcile_20260912040000_timestamp_
-- collision.sql. IT IS A NEW BUG THOSE MIGRATIONS COULD NOT HAVE CAUGHT.
-- ============================================================
-- Those two migrations rewrote the view from a single OR/EXISTS filter
-- (unfixably slow: forced a full Seq Scan of the whole table) into a
-- UNION of two independently-indexed branches, and verified live —
-- 8-9s down to a consistent 0.2-0.4s — that the rewrite worked. That
-- verification was real, but it happened at a moment when
-- screening_result was 100% NULL on all ~254,283 rows (confirmed
-- directly by 20260912040000's own header: "100% of ~254,283 rows have
-- screening_result IS NULL today — zero rows currently satisfy
-- screening_result = 'clear'"). At that row distribution, BOTH branches
-- of the UNION returned zero rows, so whatever UNION's own dedup step
-- costs, it cost nothing, because there was nothing to deduplicate. That
-- migration's own header names this precisely, as a real, flagged, not-
-- yet-realized risk (quoting it directly, not paraphrasing): "once the
-- real screening pass has run, Branch 1 could eventually return a large
-- share of the table's 'clear' rows, and de-duplicating a large, wide...
-- row set is not free... if that de-dup cost ever becomes the new
-- bottleneck, switching to UNION ALL is a safe follow-up ONLY once a
-- real CHECK constraint enforces the disjointness this comment
-- currently just asserts — not done here, on purpose."
--
-- That predicted future has now arrived. Q's task for this session
-- states the real screening pass has since run against the full
-- historical backlog: 254,291 rows fully screened. Per screening-pass.js
-- (markConversationScreened / the wide-net-skip and full-check-clear
-- paths, Step 5), 'clear' is the DEFAULT outcome for a non-held
-- conversation — 'held' and 'flagged_protected_class' are the
-- exceptions. So Branch 1 (screening_result = 'clear') now legitimately
-- matches a large majority of a 254,000+ row table, where every row is
-- wide (body_html, body_text, three JSONB address columns, a tsvector
-- search_document column) — exactly the condition the prior migration's
-- own header named as the one thing that would make this expensive.
--
-- ============================================================
-- ROOT CAUSE (reasoned from documented Postgres planner/executor
-- behavior; see the confidence note near the bottom before treating this
-- as certain without verification)
-- ============================================================
-- The view's current live definition (20260912050000, copied verbatim,
-- not simplified):
--
--   SELECT m.* FROM missive_message_intake m
--   WHERE m.screening_result = 'clear' AND NOT EXISTS (... escalations ...)
--   UNION
--   SELECT m.* FROM archive_search_flagged_overrides o
--   JOIN missive_message_intake m ON (...)
--   WHERE o.revoked_at IS NULL AND NOT EXISTS (... escalations ...)
--
-- Plain "UNION" (not "UNION ALL") means Postgres must return the
-- DISTINCT combination of both branches' rows. To do that, it cannot
-- just stream rows out as it finds them — it has to build a full
-- Hash Aggregate (or Sort + Unique) over EVERY column the branches
-- select (SELECT m.* — the full row, body_html/body_text/JSONB/tsvector
-- included, not just the id column an outer "SELECT id" might ask for;
-- Postgres cannot drop columns before a set-operation's own dedup step,
-- because doing so would change which rows count as "the same row").
-- That Hash Aggregate / Unique node is a BLOCKING operator: by its own
-- nature, it must consume its ENTIRE input — all of Branch 1 plus all of
-- Branch 2 — before it can produce even its first output row, because it
-- cannot know a given row is not a later duplicate until it has seen
-- everything. A LIMIT sitting on top of that can only cut how many rows
-- are handed to the client afterward; it cannot skip the underlying
-- "materialize and deduplicate everything first" work. This is exactly
-- why a bare "SELECT id FROM missive_message_intake_search_safe LIMIT 1"
-- pays the full cost of computing the entire view — there is no filter
-- to push down, and even if there were one, the dedup step still has to
-- run over whatever Branch 1 alone returns before Branch 2's rows (and
-- the LIMIT) can be applied on top.
--
-- With screening_result = 'clear' now matching a large majority of
-- 254,291 wide rows, Branch 1 alone has to fetch and hold onto a huge,
-- wide row set (a real, non-hypothetical volume of body_html/body_text/
-- JSONB data) just to feed the Hash Aggregate/Unique step — that is what
-- plausibly consumes the 8.2 seconds before statement_timeout fires, not
-- any missing index (idx_missive_message_intake_screening_result already
-- makes finding those rows cheap; it is holding onto and deduplicating
-- all of them afterward that is expensive).
--
-- security_barrier's role, addressed directly per this task's own
-- prompt: it is not the cause, but it does explain why there is nothing
-- to push down in the "no filter at all" case specifically. security_
-- barrier controls whether an EXTERNAL qual (one the calling query
-- supplies) may be pushed into the view's own subqueries before the
-- view's own row-security-relevant conditions run, and only for quals
-- Postgres can prove leakproof. A bare "SELECT id ... LIMIT 1" supplies
-- no WHERE clause at all — there is no external qual for security_
-- barrier to either push down or block, so security_barrier is not
-- "interacting badly" with anything in that specific case; the cost is
-- inherent to the view's own definition regardless of what the caller
-- asks for. (For a real search query that DOES supply a filter, e.g. a
-- full-text @@ predicate, whether that predicate can be pushed into
-- Branch 1 before the (now-removed, see below) dedup step is a related
-- but separate question from the one this migration is fixing — flagged
-- honestly in the "WHAT THIS MIGRATION DOES NOT CLAIM TO FIX" section
-- below, not swept in as already solved.)
--
-- Why the earlier verification (0.2-0.4s) genuinely doesn't contradict
-- this: it measured a UNION whose Hash Aggregate had zero rows to
-- process from either branch. The same UNION structure with the same
-- Hash Aggregate node, now fed a real, large, wide row set from Branch 1
-- because the real screening pass has since run, is a fundamentally
-- different cost profile — not a different bug, the SAME structural
-- property (UNION's implicit DISTINCT), just now exercised at the scale
-- and row-distribution it was always going to eventually see.
--
-- ============================================================
-- THE FIX: UNION -> UNION ALL, made SAFE by a real, provable disjointness
-- guard — not an assumption, and not the same thing 20260912040000's own
-- header explicitly declined to do "on purpose, to not ship an unverified
-- correctness assumption."
-- ============================================================
-- UNION ALL does not deduplicate — no Hash Aggregate/Unique node, no
-- blocking materialization step, and (per standard Postgres executor
-- behavior) a LIMIT on top of a plain Append of UNION ALL branches CAN
-- stop pulling rows the moment it has enough, without waiting for either
-- branch to finish. That is the entire performance fix.
--
-- The reason plain UNION was chosen over UNION ALL in the first place
-- (20260912040000's own header) is real and still applies in general: a
-- row satisfying BOTH branches would appear TWICE under UNION ALL. That
-- migration's header treated disjointness as a plausible-but-unenforced
-- assumption about how the not-yet-built override-grant route would be
-- used, and declined to rely on it. This migration does not ask anyone
-- to trust that assumption either — it makes the two branches disjoint
-- BY CONSTRUCTION, with one added condition on Branch 2:
--
--   Branch 1 (unchanged qualifying condition): m.screening_result = 'clear'
--   Branch 2 (NEW, added condition):           m.screening_result IS DISTINCT FROM 'clear'
--
-- These two conditions partition every row in missive_message_intake
-- into two sets that cannot overlap — a row's screening_result is either
-- exactly 'clear' or it is not (including NULL, which IS DISTINCT FROM
-- 'clear' evaluates as TRUE for, unlike a plain <> comparison). No row
-- can ever satisfy both WHERE clauses at once, regardless of what
-- screening_completed_at timestamp collisions might exist across
-- archive_search_flagged_overrides rows, regardless of how the
-- override-grant route ends up being used, and regardless of any future
-- change to either table's contents. This is a structural guarantee
-- enforced by the query itself every time it runs, not a fact asserted
-- once about the data and hoped to stay true.
--
-- Correctness — this does not change which rows the view returns, at
-- all, for any row, ever: a row with screening_result = 'clear' was
-- ALREADY being returned via Branch 1 before this change (regardless of
-- whether it also happened to match Branch 2's override JOIN) — Branch
-- 2's UNION with Branch 1 could only ever add that exact same row a
-- second time, which the old UNION's own dedup step was already silently
-- discarding. Excluding that case from Branch 2 removes ONLY the
-- redundant, already-discarded duplicate — never a row that was uniquely
-- reachable through Branch 2. The view's actual output (the set of rows
-- it returns) is therefore identical, row for row, before and after this
-- migration; only the mechanism Postgres uses to compute that output
-- changes.
--
-- Why a WHERE-clause guard, not a CHECK constraint (the mechanism
-- 20260912040000's header specifically named as the prerequisite for
-- this move): a CHECK constraint cannot span two tables in Postgres —
-- there is no way to write a single-table CHECK on
-- archive_search_flagged_overrides that constrains what
-- missive_message_intake.screening_result is allowed to be, or vice
-- versa. A WHERE-clause guard that structurally partitions the two
-- branches' row sets is the actual mechanism that satisfies that
-- migration's own stated bar ("a real CHECK constraint enforces the
-- disjointness") in spirit — a guarantee enforced at query time, on
-- every execution, rather than a static data constraint that could not
-- have been written for this specific cross-table relationship anyway.
--
-- The escalation exclusion (AND NOT EXISTS ... archive_search_
-- escalations ..., with the reopen-awareness folded in by 20260912050000)
-- is carried forward byte-for-byte in both branches, unchanged.
-- security_barrier = true is unchanged, for the same reason every prior
-- migration against this view already gave and none has disputed: this
-- view still gates access to the same held/flagged/unscreened,
-- highest-PII-density content it always did, and nothing about this fix
-- removes that need.
--
-- ============================================================
-- WHAT THIS MIGRATION DOES NOT CLAIM TO FIX
-- ============================================================
-- The bare "SELECT id LIMIT 1" case (and any query that supplies no
-- pushdown-able filter, or one security_barrier cannot prove leakproof)
-- is the case this migration directly fixes: under UNION ALL, a LIMIT
-- on top of Branch 1 alone can stop as soon as one 'clear' row is found
-- via idx_missive_message_intake_screening_result, without ever running
-- Branch 2 or a dedup step at all.
--
-- A real search query that supplies its own filter (e.g. the full-text
-- search_document @@ to_tsquery(...) predicate the search route
-- actually uses) is a related but separate question this migration does
-- not independently verify: whether that specific predicate is leakproof
-- enough for the planner to push it into Branch 1 before evaluating
-- idx_missive_message_intake_screening_result, versus evaluating it as a
-- Filter after the fact, is a real, open question this migration has not
-- benchmarked. What this migration DOES guarantee regardless of that
-- open question: removing the Hash Aggregate/Unique blocking node means
-- even the worst case (the tsquery filter applied only as a Filter over
-- everything Branch 1's index scan produces) no longer ALSO pays a full
-- dedup pass over the combined branches on top of that — a real
-- improvement either way, not a complete guarantee that every possible
-- search query is now fast. TARS should confirm real search queries
-- (not just the bare LIMIT 1 case) against the live view after this
-- ships, not just the specific repro Q hit tonight.
--
-- ============================================================
-- CONFIDENCE LEVEL — read before trusting this without verification
-- ============================================================
-- HIGH confidence: plain UNION requires a blocking dedup step (Hash
-- Aggregate or Sort+Unique) over the full, combined output of both
-- branches before any row can be returned, and this cost is
-- proportional to how many wide rows either branch actually returns —
-- standard, documented Postgres executor behavior, not a guess specific
-- to this schema.
-- HIGH confidence: with the real screening pass now complete (254,291
-- rows) and 'clear' being the default (non-exceptional) outcome per
-- screening-pass.js's own Step 5 logic, Branch 1 now returns a large,
-- wide row set where it previously returned zero — a real, measured
-- change in the data since 20260912040000/20260912050000 were last
-- verified live, not a hypothetical.
-- NOT independently verified with a real EXPLAIN ANALYZE plan from the
-- live database — this environment has no direct Postgres connection (by
-- this project's own standing convention; Peter applies every migration
-- and would need to run any EXPLAIN himself). The exact split of the
-- 8.2s between "fetching Branch 1's rows" vs. "the Hash Aggregate/Unique
-- step itself" vs. any planner behavior not accounted for above is
-- exactly what a real EXPLAIN would settle and this reasoning cannot.
--
-- Two read-only, copy-pasteable queries for Peter to run in Supabase's
-- SQL Editor — BEFORE applying this migration, to confirm the diagnosis,
-- and AFTER, to confirm the fix:
--
--   -- 1. Confirms the row distribution this diagnosis depends on:
--   SELECT screening_result, count(*)
--   FROM missive_message_intake
--   GROUP BY screening_result;
--
--   -- 2. The real plan, before or after this migration —
--   -- BEFORE: expect a "HashAggregate" or "Unique" node near the top,
--   -- with actual time close to the full 8s, and its child nodes
--   -- (the two branches' scans) each showing a large "actual rows" count
--   -- for Branch 1 specifically.
--   -- AFTER: expect the HashAggregate/Unique node to be GONE entirely
--   -- (replaced by a plain "Append"), and a "Limit" node whose actual
--   -- time is a small fraction of the "before" run — ideally similar to
--   -- the 150-300ms already measured against the base table directly.
--   BEGIN;
--   SET LOCAL statement_timeout = '30s';
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT id FROM missive_message_intake_search_safe LIMIT 1;
--   ROLLBACK;
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No. This changes only a VIEW
--       definition (a stored query, not stored data) — no table, column,
--       row, or constraint is touched. Per the "Correctness" note above,
--       the rewritten query returns the IDENTICAL set of rows as the
--       current live definition, for every row, always — not just today.
--       Recommended (not required) verification: compare
--       "SELECT count(*) FROM missive_message_intake_search_safe" before
--       and after — expected to match exactly, though the BEFORE count
--       may itself be slow or may time out, which is the bug this
--       migration exists to fix in the first place.
--   [x] Does this touch a table other code depends on?
--       missive_message_intake_search_safe itself, yes — the one view
--       every archive-search search/message route is required to query
--       (confirmed directly: router.js's every route queries this view by
--       name, never missive_message_intake). Every consumer receives the
--       exact same columns and exact same row-filtering semantics as
--       before — only the query plan changes.
--       missive_message_intake, archive_search_flagged_overrides,
--       archive_search_escalations — read only, by the view definition,
--       same as before. No ALTER TABLE anywhere in this file.
--   [x] Additive or destructive? Neither, strictly — a behavior-preserving
--       rewrite of one view's implementation, same class of change as
--       20260912040000's own UNION rewrite. CREATE OR REPLACE VIEW is a
--       metadata-only catalog operation; it does not scan or rewrite any
--       table and takes no lock that conflicts with ordinary reads/writes
--       — same fact every prior CREATE OR REPLACE VIEW in this schema's
--       history has already confirmed for this exact statement shape.
--   [ ] Tested on a copy of the data first? No staging copy of Supabase
--       exists in this project — same standing caveat every migration
--       here has carried. Mitigated by: the view replacement is
--       metadata-only (nothing to corrupt); the rewrite is provably
--       row-preserving by construction (see "Correctness" above, not
--       just asserted); and the EXPLAIN query above lets Peter or TARS
--       verify the real plan changed as predicted, on live data, without
--       writing anything, before and after applying this.
--   [x] Governance go-ahead needed? No — this is a pure performance fix
--       to an already-governance-cleared view. It adds no new column, no
--       new table, changes no CHECK constraint, and changes WHAT no
--       person or AI agent can see — the exact set of rows the view
--       returns is unchanged (see "Correctness" above). Not a compliance
--       build, same classification 20260912040000's own gate self-check
--       already gave this identical class of change.
-- ============================================================

CREATE OR REPLACE VIEW missive_message_intake_search_safe
WITH (security_barrier = true) AS
SELECT m.*
FROM missive_message_intake m
WHERE m.screening_result = 'clear'
  AND NOT EXISTS (
    SELECT 1
    FROM archive_search_escalations e
    WHERE e.missive_conversation_id = m.missive_conversation_id
      AND e.mailbox_key             = m.mailbox_key
      AND (
        e.status = 'open'
        OR (e.status = 'confirmed' AND e.reopened_at IS NULL)
      )
  )

UNION ALL

SELECT m.*
FROM archive_search_flagged_overrides o
JOIN missive_message_intake m
  ON m.missive_conversation_id          = o.missive_conversation_id
 AND m.mailbox_key                      = o.mailbox_key
 AND m.screening_completed_at           = o.overridden_screening_completed_at
WHERE o.revoked_at IS NULL
  -- NEW condition, this migration — makes the two branches disjoint BY
  -- CONSTRUCTION, so UNION ALL cannot ever return a duplicate row. See
  -- "THE FIX" above for why this is a structural guarantee, not an
  -- assumption about how override rows happen to be used today.
  AND m.screening_result IS DISTINCT FROM 'clear'
  AND NOT EXISTS (
    SELECT 1
    FROM archive_search_escalations e
    WHERE e.missive_conversation_id = m.missive_conversation_id
      AND e.mailbox_key             = m.mailbox_key
      AND (
        e.status = 'open'
        OR (e.status = 'confirmed' AND e.reopened_at IS NULL)
      )
  );

COMMENT ON VIEW missive_message_intake_search_safe IS
  'The ONLY view every archive-search search/message route may query — never missive_message_intake directly, with the one named exception of screening-pass.js. History: 20260910030000 created it; 20260912010000 added the override-inclusion clause; 20260912030000 added the escalation-exclusion clause; 20260912040000/20260912050000 rewrote the OR/EXISTS filter into a UNION of two independently-indexed branches to fix a live Seq Scan timeout (verified fast at the time, but only because screening_result was 100% NULL then — zero rows in either branch); 20260913000000 (this migration) fixed a second, later live timeout — once the real screening pass populated screening_result for real (''clear'' as the default, non-exceptional outcome per screening-pass.js), plain UNION''s implicit DISTINCT forced a blocking Hash Aggregate/Unique step over a now-large, wide row set on every single query, including a bare id-only, no-filter, LIMIT-1 query. Fixed by switching to UNION ALL with an added `m.screening_result IS DISTINCT FROM ''clear''` condition on the override branch, which makes the two branches disjoint by construction (a ''clear'' row was always already covered by the first branch) rather than by an unenforced assumption — same row-filtering semantics and same rows returned as before, only the query plan (and, critically, whether a LIMIT can terminate early) changes. security_barrier = true unchanged throughout.';


-- ============================================================
-- ROLLBACK (run this statement to revert to 20260912050000's live UNION
-- definition — reverts ONLY the query plan/structure, not any data;
-- provably safe at any time, since this migration is row-preserving —
-- see "Correctness" above)
-- ============================================================
-- CREATE OR REPLACE VIEW missive_message_intake_search_safe
-- WITH (security_barrier = true) AS
-- SELECT m.*
-- FROM missive_message_intake m
-- WHERE m.screening_result = 'clear'
--   AND NOT EXISTS (
--     SELECT 1
--     FROM archive_search_escalations e
--     WHERE e.missive_conversation_id = m.missive_conversation_id
--       AND e.mailbox_key             = m.mailbox_key
--       AND (
--         e.status = 'open'
--         OR (e.status = 'confirmed' AND e.reopened_at IS NULL)
--       )
--   )
-- UNION
-- SELECT m.*
-- FROM archive_search_flagged_overrides o
-- JOIN missive_message_intake m
--   ON m.missive_conversation_id          = o.missive_conversation_id
--  AND m.mailbox_key                      = o.mailbox_key
--  AND m.screening_completed_at           = o.overridden_screening_completed_at
-- WHERE o.revoked_at IS NULL
--   AND NOT EXISTS (
--     SELECT 1
--     FROM archive_search_escalations e
--     WHERE e.missive_conversation_id = m.missive_conversation_id
--       AND e.mailbox_key             = m.mailbox_key
--       AND (
--         e.status = 'open'
--         OR (e.status = 'confirmed' AND e.reopened_at IS NULL)
--       )
--   );
--
-- COMMENT ON VIEW missive_message_intake_search_safe IS
--   'The ONLY view every archive-search search/message route may query — never missive_message_intake directly, with the one named exception of screening-pass.js. History: 20260910030000 created it; 20260912010000 added the override-inclusion clause; 20260912030000 added the escalation-exclusion clause; 20260912040000_fix_search_safe_view_seq_scan rewrote it from a single OR/EXISTS filter into a UNION of two independently-indexed branches to fix a live statement-timeout bug (unchanged row-filtering semantics, query plan only); 20260912050000 folded reopen-awareness into both branches'' escalation exclusion. security_barrier = true unchanged throughout.';
-- ============================================================
