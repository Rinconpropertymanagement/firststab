-- ============================================================
-- SUPERSEDED — DO NOT APPLY THIS FILE ON ITS OWN.
-- This filename collided with another migration also timestamped
-- 20260912040000 (add_reopen_to_archive_search_escalations.sql), whose
-- own view rewrite was written against the OLD pre-fix version of this
-- view. Both are reconciled into
-- 20260912050000_reconcile_20260912040000_timestamp_collision.sql, which
-- is the file to apply. THIS file's fix is already live in production —
-- re-running it verbatim would be a harmless no-op (CREATE OR REPLACE
-- back to the same UNION structure), but apply 20260912050000 instead if
-- you have not already, since it carries this fix forward plus the
-- reopen mechanism correctly layered on top of it.
-- ============================================================

-- ============================================================
-- Migration: 20260912040000_fix_search_safe_view_seq_scan
-- Created:   2026-09-12
-- Author:    Neo (database specialist)
--
-- Fixes a real, live production bug: missive_message_intake_search_safe
-- (the ONLY view every archive-search search/message route may query)
-- times out (Postgres error 57014, statement timeout, ~8-9s) on even a
-- trivial "select=id&limit=1" query against the 254,000+ row
-- missive_message_intake table, RIGHT NOW, confirmed live.
--
-- This is NOT the same bug 20260912020000 already fixed. That migration
-- added idx_missive_message_intake_screening_result and confirmed, live,
-- that a DIRECT query against the base table
-- ("missive_message_intake?select=id&screening_result=eq.clear&limit=1")
-- is now fast (under 1s) — the index is real or applied and working.
-- The VIEW still times out anyway. Something about the view's own
-- structure, not a missing index, is the real cause.
--
-- ============================================================
-- ROOT CAUSE (reasoned from documented Postgres planner behavior; see
-- the confidence note at the very bottom of this header before treating
-- any of this as certain)
-- ============================================================
-- The view's current live WHERE clause (reconstructed by reading
-- 20260910030000, 20260912010000, and 20260912030000 in order — this is
-- the real, current SQL, not a simplification of it):
--
--   WHERE (
--       m.screening_result = 'clear'
--       OR EXISTS ( SELECT 1 FROM archive_search_flagged_overrides o
--                   WHERE o.missive_conversation_id = m.missive_conversation_id
--                     AND o.mailbox_key             = m.mailbox_key
--                     AND o.overridden_screening_completed_at = m.screening_completed_at
--                     AND o.revoked_at IS NULL )
--     )
--     AND NOT EXISTS ( SELECT 1 FROM archive_search_escalations e
--                      WHERE e.missive_conversation_id = m.missive_conversation_id
--                        AND e.mailbox_key             = m.mailbox_key
--                        AND e.status IN ('open', 'confirmed') )
--
-- Mechanism, in plain terms: Postgres can only fold multiple conditions
-- joined by OR into one efficient index lookup (a "BitmapOr") when EVERY
-- branch of the OR is itself an indexable condition on the SAME table
-- being scanned. Here, one branch (screening_result = 'clear') is
-- indexable on missive_message_intake; the other branch is a correlated
-- EXISTS subquery against a DIFFERENT table
-- (archive_search_flagged_overrides). A subquery's true/false result is
-- not something an index on missive_message_intake can produce — it has
-- to be computed by actually running that subquery. Because the two
-- branches of the OR cannot be combined into one index condition, the
-- planner cannot restrict the missive_message_intake scan to "just the
-- rows where screening_result = 'clear'" and still be correct (doing so
-- would silently skip every row that qualifies only via the EXISTS
-- branch). The only correct plan is: scan missive_message_intake some
-- other way (in practice, a full Seq Scan, since no index matches the OR
-- as a whole), and, for each row that scan produces, evaluate
-- "screening_result = 'clear' OR EXISTS(...)" as a Filter.
--
-- Today's real data makes this maximally expensive, not just theoretically
-- present: 100% of ~254,283 rows have screening_result IS NULL — zero
-- rows currently satisfy screening_result = 'clear'. That means, for
-- every single row, the left side of the OR is false, so Postgres must
-- actually execute the correlated EXISTS subquery against
-- archive_search_flagged_overrides to decide the row — roughly 254,283
-- separate subquery executions, each carrying real per-call executor
-- overhead even though that target table is small/empty. That, layered
-- on top of a Seq Scan of a wide table (body_html/body_text/JSONB
-- address columns make each row far heavier than a narrow lookup table),
-- is what plausibly consumes the 8-9 seconds before statement_timeout
-- fires — not any one thing in isolation, but the combination.
--
-- security_barrier = true's role: it does not by itself cause the Seq
-- Scan (the OR-vs-subplan non-indexability above does that on its own,
-- security_barrier or not). What security_barrier specifically forecloses
-- is qual pushdown from an EXTERNAL filter (e.g. a future
-- ?id=eq.<uuid> from the app) past the view's own security-relevant
-- conditions when that external qual isn't provably leakproof — a
-- protection this view still genuinely needs (see "Should
-- security_barrier be removed?" below), and, per Postgres's documented
-- behavior, plain equality on built-in scalar types (uuid, text, etc.)
-- IS marked leakproof, so simple lookups like id=eq.<uuid> are NOT the
-- part security_barrier makes worse here.
--
-- ============================================================
-- THE FIX: rewrite the OR into a UNION of two independently-optimizable
-- branches, each already-indexed or already-small on its own, so no
-- branch ever requires a full scan of missive_message_intake.
-- ============================================================
-- Standard boolean algebra: (A OR B) AND C  ==  (A AND C) OR (B AND C).
-- The rewrite below is exactly that distribution, turned into a UNION of
-- the two (A AND C) / (B AND C) row-sets instead of one OR'd filter:
--
--   Branch 1 (A AND C): screening_result = 'clear', minus any escalation.
--     Driven by idx_missive_message_intake_screening_result (added
--     20260912020000) — Postgres scans ONLY the rows where
--     screening_result = 'clear' (today: zero rows; once the real
--     screening pass runs: a real subset, never a full-table Seq Scan
--     driven by this branch alone), then checks NOT EXISTS escalation
--     only against that already-small row set.
--
--   Branch 2 (B AND C): a live, non-revoked override, minus any
--     escalation. Rewritten from a correlated EXISTS into an INNER JOIN
--     driven from archive_search_flagged_overrides (small, by design —
--     see that table's own migration) INTO missive_message_intake via
--     idx_missive_message_intake_conversation. Postgres scans the small
--     overrides table, not the 254k-row table, and probes into
--     missive_message_intake once per override row — never a full scan.
--
--     Correctness of turning this EXISTS into a JOIN (not just a
--     performance rewrite): archive_search_flagged_overrides carries
--     UNIQUE (missive_conversation_id, mailbox_key,
--     overridden_screening_completed_at) (confirmed directly in
--     20260912010000). That constraint guarantees at most ONE override
--     row can match any given missive_message_intake row m on all three
--     join columns — so the JOIN cannot multiply m's row into duplicates
--     the way a join against a non-unique key could. Same row count as
--     the EXISTS it replaces, always.
--
--   UNION (not UNION ALL): logically, (A AND C) and (B AND C) should
--     never both be true for the same row in practice — a live override
--     only matches while m.screening_completed_at still equals the
--     exact snapshot taken at override-grant time, and per this table's
--     own design, that snapshot is only ever taken for a row that WAS
--     flagged at that moment, not one that was already 'clear'. But
--     that is an application-level invariant (how the not-yet-built
--     override-grant route is expected to behave), not something any
--     CHECK constraint in this schema actually enforces. Rather than
--     bake an unenforced assumption into a security-relevant view's
--     correctness, this migration uses UNION (which de-duplicates by
--     construction, so it is correct regardless of whether that
--     assumption ever holds) and pays the honest cost of that
--     de-duplication: a sort/hash over whatever rows the two branches
--     return. Real, worth knowing, not hidden: once the real screening
--     pass has run, Branch 1 could eventually return a large share of
--     the table's 'clear' rows, and de-duplicating a large, wide
--     (body_html/body_text/JSONB) row set is not free. It is still
--     vastly cheaper than the current Seq Scan + 254k subplan calls this
--     migration fixes, and if that de-dup cost ever becomes the new
--     bottleneck, switching to UNION ALL is a safe follow-up ONLY once a
--     real CHECK constraint enforces the disjointness this comment
--     currently just asserts — not done here, on purpose, to not ship an
--     unverified correctness assumption today.
--
-- The escalation check (C: AND NOT EXISTS archive_search_escalations)
-- is duplicated into both branches, unchanged from the current view's
-- own EXISTS clause — same table, same columns, same semantics. It runs
-- against whatever (already small, per-branch) row set each branch
-- already narrowed down to, never against the full 254k-row table.
--
-- ============================================================
-- SHOULD security_barrier BE REMOVED? NO — kept, unchanged.
-- ============================================================
-- Its stated reason (20260910030000's own comment on this view): this
-- view sits over the schema's highest-PII-density table, before any
-- privilege/Fair-Housing screening check has run on most of it, so a
-- future leaky filter pushed below the view's own row-security logic
-- could leak which rows exist/were excluded via error messages or
-- timing. Nothing about today's performance bug is caused by
-- security_barrier, and nothing about this fix removes the underlying
-- risk security_barrier defends against (this view still gates access
-- to the same held/flagged/unscreened content it always did). Removing
-- it would trade a real, still-needed protection for a performance
-- problem this migration already fixes a different way.
--
-- ============================================================
-- CONFIDENCE LEVEL — read before trusting this without verification
-- ============================================================
-- HIGH confidence: an OR between an indexable column condition and a
-- correlated EXISTS subquery against a different table cannot be served
-- by a single index scan on the first table, and Postgres will fall back
-- to scanning that table some other way (in practice, Seq Scan) and
-- apply the OR as a row-by-row Filter. This is standard, documented
-- planner behavior, not a guess specific to this schema.
-- HIGH confidence: with 100% of 254,283 rows at screening_result IS
-- NULL today, that Filter's left branch is false for every row, forcing
-- the correlated EXISTS subplan to actually execute for effectively
-- every row — a real, non-hypothetical cost at this row count.
-- NOT independently verified with a real EXPLAIN ANALYZE plan from this
-- live database — this environment has no direct Postgres connection
-- (by this project's own standing convention; Peter applies every
-- migration and would need to run any EXPLAIN himself). The exact split
-- of the 8-9s between "Seq Scan of a wide table" vs. "254k subplan
-- calls" vs. any planner behavior not accounted for above is exactly
-- what a real EXPLAIN would settle and this reasoning cannot. See the
-- query below — safe, read-only, and copy-pasteable into Supabase's SQL
-- Editor — for Peter to run and report back before or after applying
-- this fix, so the next round is grounded in a real plan, not another
-- guess:
--
--   BEGIN;
--   SET LOCAL statement_timeout = '30s';
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT id FROM missive_message_intake_search_safe LIMIT 1;
--   ROLLBACK;
--
-- What to look for in the output:
--   - A node reading "Seq Scan on missive_message_intake" (confirms the
--     full-table-scan diagnosis above) vs. any "Index Scan" node driving
--     the scan (would contradict it).
--   - A "SubPlan" node nested under that scan, with its own "actual
--     time" and, most tellingly, "loops=" close to 254283 (confirms the
--     subplan is being executed once per row, not once total).
--   - The top-level "Execution Time" — compare against the 8-9s timeout
--     already observed live.
-- Running this AFTER applying the fix below and comparing plans
-- (Seq Scan gone, Index Scan / small-table-driven plans present instead)
-- is the real verification this fix worked — not assumed here.
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No. This changes only a VIEW
--       definition (a stored query, not stored data) — no table, column,
--       row, or constraint is touched. The rewritten query is logically
--       equivalent to the current one (see the boolean-algebra note
--       above), so it also does not change WHICH rows the view returns,
--       only how fast Postgres finds them. Confirmed today's actual
--       result set for both old and new definitions is identical: zero
--       rows (screening_result is 100% NULL; both overrides and
--       escalations tables are new/empty).
--   [x] Does this touch a table other code depends on?
--       missive_message_intake_search_safe itself, yes — the one view
--       every archive-search search/message route is required to query.
--       Every consumer receives the same columns, same row-filtering
--       semantics, and (per security_barrier staying on) the same
--       security guarantee as before — only the query plan changes.
--       missive_message_intake, archive_search_flagged_overrides,
--       archive_search_escalations — read only, by the view definition,
--       same as before. No ALTER TABLE anywhere in this file.
--   [x] Additive or destructive? Neither, strictly — this is a
--       behavior-preserving rewrite of one view's implementation.
--       CREATE OR REPLACE VIEW is a metadata-only catalog operation; it
--       does not scan or rewrite any table and takes no lock that
--       conflicts with ordinary reads/writes, same fact every prior
--       CREATE OR REPLACE VIEW in this schema's history has confirmed
--       for this exact statement shape.
--   [ ] Tested on a copy of the data first? No staging copy of Supabase
--       exists in this project — same standing caveat every migration
--       here has carried. Mitigated by: the view replacement is
--       metadata-only (nothing to corrupt); the rewrite is provably
--       logically equivalent to the current definition (boolean algebra,
--       above), not a behavior change dressed up as a performance fix;
--       and the EXPLAIN query above lets Peter verify the real plan
--       changed as predicted, on live data, without writing anything,
--       before treating this as fully confirmed.
--   [x] Governance go-ahead needed? No — this is a pure performance fix
--       to an already-governance-cleared view (20260910030000's
--       security_barrier decision and 20260912010000/20260912030000's
--       additive clauses were each already reviewed on their own terms).
--       It adds no new column, no new table, changes no CHECK
--       constraint, and changes what no person or AI agent can see —
--       the exact set of rows the view returns is unchanged (see "does
--       this break any existing data" above). Not a compliance build.
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
      AND e.status IN ('open', 'confirmed')
  )

UNION

SELECT m.*
FROM archive_search_flagged_overrides o
JOIN missive_message_intake m
  ON m.missive_conversation_id          = o.missive_conversation_id
 AND m.mailbox_key                      = o.mailbox_key
 AND m.screening_completed_at           = o.overridden_screening_completed_at
WHERE o.revoked_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM archive_search_escalations e
    WHERE e.missive_conversation_id = m.missive_conversation_id
      AND e.mailbox_key             = m.mailbox_key
      AND e.status IN ('open', 'confirmed')
  );

COMMENT ON VIEW missive_message_intake_search_safe IS
  'The ONLY view every archive-search search/message route may query — never missive_message_intake directly, with the one named exception of screening-pass.js. Same row-filtering semantics as before (a conversation is visible if screening_result = ''clear'' OR a live non-revoked override exists, AND no open/confirmed escalation exists) but rewritten 20260912040000 from a single OR/EXISTS filter into a UNION of two independently-indexed branches, to fix a live statement-timeout bug: the prior OR between an indexed column condition and a correlated EXISTS subquery against a different table could not be served by any index, forcing a full Seq Scan of missive_message_intake plus one correlated subquery execution per row. security_barrier = true unchanged — still needed, see this migration''s own header for why removing it was considered and rejected.';


-- ============================================================
-- ROLLBACK (run this statement to revert to the pre-fix view — reverts
-- ONLY the query plan/structure, not any data; safe at any time, since
-- this migration changes no stored data and the two definitions are
-- logically equivalent)
-- ============================================================
-- CREATE OR REPLACE VIEW missive_message_intake_search_safe
-- WITH (security_barrier = true) AS
-- SELECT *
-- FROM missive_message_intake m
-- WHERE (
--     m.screening_result = 'clear'
--     OR EXISTS (
--       SELECT 1
--       FROM archive_search_flagged_overrides o
--       WHERE o.missive_conversation_id           = m.missive_conversation_id
--         AND o.mailbox_key                       = m.mailbox_key
--         AND o.overridden_screening_completed_at = m.screening_completed_at
--         AND o.revoked_at IS NULL
--     )
--   )
--   AND NOT EXISTS (
--     SELECT 1
--     FROM archive_search_escalations e
--     WHERE e.missive_conversation_id = m.missive_conversation_id
--       AND e.mailbox_key             = m.mailbox_key
--       AND e.status IN ('open', 'confirmed')
--   );
--
-- COMMENT ON VIEW missive_message_intake_search_safe IS
--   'The ONLY view every archive-search search/message route may query — never missive_message_intake directly, with the one named exception of screening-pass.js. Extended twice: archive-search-flagged-review-spec.md (20260912010000) added the override inclusion clause; archive-search-escalation-mechanism-spec.md (20260912030000) added this exclusion clause — a conversation with an open or confirmed entry in archive_search_escalations is excluded from this view immediately, regardless of screening_result or any override on file. Resolving an escalation as false_alarm removes the exclusion on the very next query, with no separate cleanup step.';
-- ============================================================
