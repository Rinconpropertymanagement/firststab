-- ============================================================
-- Migration: 20260920010000_archive_search_significance_driver_cursor_schema
-- Created:   2026-09-20
-- Author:    Neo (database specialist)
--
-- WHY THIS EXISTS
-- significance-pass.js's fetchNextEligibleConversations()/fetchDriverPage()
-- walks missive_message_intake_search_safe_clear_branch in plain id-ascending
-- keyset order (ORDER BY id ASC, id > cursor, LIMIT 500 — 20260918020000),
-- but restarts from cursor=null on EVERY separate call. The front ~44% of
-- the table (by id order) is now fully exhausted (every row already has a
-- missive_conversation_significance row), and per-page fetch time in that
-- exhausted region has regressed from 200-330ms to 10-17s — so every fresh
-- run wastes real time re-walking already-known territory before reaching
-- anything new. This migration adds a persisted resume point so a run can
-- skip past that region, WITHOUT trusting that skip blindly.
--
-- ============================================================
-- GAP 1: THE CLEAR-BRANCH VIEW ITSELF IS NOT MONOTONIC BY ID
-- ============================================================
-- id is gen_random_uuid() (confirmed: 20260905020000) with zero correlation
-- to insertion time, delivery time, or screening completion time. That
-- means membership of missive_message_intake_search_safe_clear_branch is
-- NOT append-only/monotonic by id — a row can leave the view (screening_
-- result reset away from 'clear') and later re-enter it (re-screened back
-- to 'clear') with the SAME id, anywhere in id-space, including "behind" a
-- cursor a prior run already advanced past. This is not hypothetical: reset-
-- layer1-removal-310.js (projects/hub/archive-search/) is a real, already-
-- run script that reset screening_result from 'clear' back to NULL for 310
-- real conversations, which were later re-screened and could re-clear with
-- their original ids. The untracked compliance/archive-search-held-release-
-- *.md files present in this repo as of this migration indicate a similarly
-- shaped reset is currently under governance review. A naive fast-forward
-- cursor would permanently and silently skip such a conversation forever —
-- a Fair Housing screening completeness failure, not just an efficiency
-- question.
--
-- A cursor design that only compares a ROW COUNT below the cursor
-- (COUNT(*) WHERE id <= cursor_id) is NOT sufficient to rule this out: one
-- row leaving the exhausted region (a reset) and a DIFFERENT row entering it
-- (an ordinary new screening completion landing "behind" the cursor by
-- chance — which happens continuously, not only during a deliberate reset,
-- since id has no time correlation) can cancel out in a plain count while
-- the actual membership below the cursor has genuinely changed. The same
-- cancellation happens if one single conversation's OWN reset-then-reclear
-- round trip completes within a single inter-run gap — exactly the shape of
-- the precedent script above. Either way, a bare count can match while a
-- conversation that must be screened sits permanently unreachable below the
-- cursor. This schema therefore stores a DIGEST of the clear-branch region's
-- actual row ids, not merely their count, as the load-bearing safety check;
-- the count is retained alongside it purely for cheap human observability,
-- never as the correctness signal itself.
--
-- ============================================================
-- GAP 2 (found on review of the first draft of this migration): THE
-- ESCALATION-EXCLUSION SET IS A SEPARATE, INDEPENDENTLY TIME-VARYING FILTER
-- ============================================================
-- fetchNextEligibleConversations() does not treat missive_message_intake_
-- search_safe_clear_branch as the final eligible set on its own — every raw
-- page is also filtered through passesEscalationExclusion(), against a set
-- built once per call by fetchEscalationExclusionSet() from
-- archive_search_escalations (status = 'open' OR (status = 'confirmed' AND
-- reopened_at IS NULL) — 20260912040000's own reopened_at column, confirmed
-- live in that migration). A conversation can sit at an id at or below
-- cursor_id, stay 'clear' the entire time (Gap 1's digest matches, unchanged)
-- and STILL have its true eligibility flip: an open escalation that later
-- resolves makes it newly eligible; a resolved one that gets reopened
-- (reopened_at set on a 'confirmed' row) makes it newly excluded. Gap 1's
-- digest says nothing about this — it only characterizes screening_result
-- membership. If a run fast-forwards past cursor_id on the strength of Gap
-- 1's digest alone, fetchDriverPage() is never called for that id range in
-- this run, so passesEscalationExclusion() never gets a chance to
-- re-evaluate any of those rows — a previously-excluded, still-unprocessed
-- conversation whose escalation later resolves would never be reconsidered,
-- silently, permanently. Same failure shape as Gap 1, different trigger.
-- archive_search_escalations is small by design (20260912040000's own "should
-- be rare" framing; 0 rows measured live as recently as 20260918020000), so
-- this does not need a cursor of its own — it needs a digest of its CURRENT,
-- FULL exclusion-relevant set, re-snapshotted and re-verified every run
-- alongside Gap 1's digest, for the identical count-can-cancel-out reason
-- Gap 1's own header already gives (one escalation resolving and a
-- different one opening can leave a bare count unchanged while membership
-- genuinely moved) — so this is a digest too, not a count, for the same
-- reason.
--
-- ============================================================
-- THE MECHANISM (application code, Q's build on top of this schema — not
-- made here; this migration is schema + two small verification functions
-- only, same division of labor as every migration in this file family)
-- ============================================================
--   1. Before trusting a saved cursor, call BOTH
--      archive_search_missive_clear_branch_cursor_check(cursor_id) and
--      archive_search_escalation_exclusion_digest_check() — the two
--      functions this migration adds, below — and compare their digests to
--      this scope's stored established_clear_branch_digest and
--      established_escalation_digest respectively.
--   2. BOTH digests match -> both the clear-branch region below cursor_id
--      AND the escalation-exclusion set applied to it are provably
--      unchanged since last confirmed -> safe to start
--      fetchDriverPage(cursor_id) instead of fetchDriverPage(null).
--   3. EITHER digest fails to match (or no row exists yet for this scope)
--      -> fails closed: fall back to a full walk from id=null this run.
--      This is self-healing, not an error state. Do not treat the two
--      checks independently (e.g. "trust the id range but re-derive
--      escalations some other way") — either mismatch invalidates the
--      whole resume point, because fetchDriverPage(cursor_id) would still
--      skip re-fetching the same below-cursor rows regardless of which
--      check failed.
--   4. At the END of every run (whether it fast-forwarded or walked from
--      scratch), call BOTH functions again — the escalation check fresh,
--      not reused from whatever fetchEscalationExclusionSet() fetched at
--      the start of this same run, so the persisted baseline reflects the
--      truest, most current state available — at the run's new final
--      cursor position, and UPSERT the results as this scope's new
--      cursor_id/established_clear_branch_count/
--      established_clear_branch_digest/established_escalation_count/
--      established_escalation_digest, all together, in one write. Compute
--      these from fresh, real queries every time — never by incrementally
--      adding page lengths in application code. This table only ever holds
--      one row per scope; it is a cache of a provable fact (what do real
--      queries say right now), not an independent ledger that could drift
--      from what the database actually contains.
--
-- Scoped globally per underlying view, not per stage or sinceDate:
-- fetchDriverPage() never branches on stage or sinceDate (sinceDate is
-- applied client-side, per this file's own existing PERFORMANCE NOTE
-- comments; stage is not passed into fetchNextEligibleConversations() at
-- all, confirmed via significance-batch.js's startSubmissionRun()) — the
-- underlying id-ordered walk sequence is identical regardless of either, so
-- one shared cursor per scope is more correct than splitting by either, not
-- just simpler. scope is a free-text key (not an enum/FK) specifically so a
-- future, genuinely different id-ordered driver (e.g. a hypothetical call_2
-- walk over a different view) gets its own independent row without a schema
-- change — it is not, by itself, a safety mechanism: correctness comes from
-- re-querying live state every time (step 1 above), which is also why this
-- design tolerates the view's own WHERE clause being redefined again (it
-- already has been, twice, under the same name) without needing the scope
-- key to encode the view's current definition.
--
-- NOT covered by either digest, flagged rather than fixed here: sinceDate.
-- passesSinceDate() is a deterministic function of a row's own immutable
-- delivered_at and whatever sinceDate THIS call was invoked with. If a
-- future run scope ever passes a LOOSER sinceDate than an earlier run that
-- helped establish the current cursor (widening the window to include
-- older messages), a row that failed the date filter under the old,
-- stricter sinceDate and sits below cursor_id would never be reconsidered
-- under the new one, by the same fast-forward mechanism. Real production
-- usage today submits stage='call_1' as an unbounded backfill (sinceDate
-- effectively null throughout the 84,408-conversation run these migrations
-- already reference), so this is not believed to be live today — but it is
-- a real latent constraint on this mechanism's safety, not proven away by
-- anything in this schema. If sinceDate is ever varied again across calls
-- sharing this cursor scope, it must only ever get stricter (or stay the
-- same) over time, never looser, or this cursor needs a third dimension
-- added the same way Gap 2 was added here. Not built now because it isn't
-- needed by any real, current caller — same "additive when actually
-- needed" discipline this migration family already applies elsewhere.
--
-- ============================================================
-- KNOWN LIMIT, STATED PLAINLY (matches this file family's own standard of
-- not overclaiming confidence)
-- ============================================================
-- Both verification queries scan every matching row in their respective
-- scope once per run (to build their digest), so cost scales with
-- established_clear_branch_count / established_escalation_count, not O(1).
-- At today's real scale (254,822 total rows as of 20260918020000, ~44%
-- established; archive_search_escalations measured at 0 rows as of the same
-- migration) this is cheap — a single bounded index (only) scan over
-- idx_missive_message_intake_clear_id for the first, a full sequential scan
-- of a table that is small by design for the second — both cheap relative
-- to the 10-17s/page, many-page walk this mechanism replaces. Neither has
-- been proven to stay cheap at an order-of-magnitude larger table; if
-- either table grows enough that its own check becomes the bottleneck, a
-- different integrity signal (e.g. a trigger-maintained running checksum)
-- would need to be designed then — not assumed here.
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No. Purely additive: one new
--       table (starts empty), two new functions. No existing table, view,
--       column, or row is touched.
--   [x] Does this touch a table other code depends on? No existing table is
--       altered. The new functions read missive_message_intake_search_safe_
--       clear_branch and archive_search_escalations (both read-only, SELECT
--       only) — the same two relations fetchDriverPage()/
--       fetchEscalationExclusionSet() already read today; this adds a
--       second read path over each, not a new write path or a change to
--       what either already returns.
--   [x] Additive or destructive? Fully additive.
--   [ ] Tested on a copy of the data first? No staging copy of Supabase
--       exists in this project — same standing caveat every migration here
--       carries. Mitigated by: the new table is empty by construction and
--       has no caller until Q's application-code change ships; both new
--       functions are read-only SELECTs (STABLE, no writes, cannot corrupt
--       anything) against already-proven-safe query shapes. Run both
--       functions manually via Supabase's SQL Editor (against a real cursor
--       id, and with a real escalation row if one exists by then) before
--       wiring either into a real 84,408-conversation-scale run, same
--       verify-before-trust discipline this file family has used throughout.
--   [ ] Governance go-ahead — this schema itself stores no new category of
--       personal data (a UUID, counts, and hashes of ids/keys already
--       stored today in missive_message_intake and archive_search_
--       escalations) and makes no decision about a tenant or owner, so I
--       don't believe the SCHEMA blocks on Asimov/Mason by the same
--       standing reasoning 20260918060000 gave for its own operational-
--       bookkeeping tables. But the change this schema enables — allowing
--       the significance driver to SKIP re-walking part of a Fair-Housing-
--       relevant screening pool, across BOTH the screening-result dimension
--       and the escalation-exclusion dimension — is exactly the kind of
--       change CLAUDE.md's Governance section names, and this review
--       surfaced two independent gaps (see Gap 1 / Gap 2 above), one tied
--       directly to a reset-and-reclear pattern this codebase has already
--       executed once and is actively governance-reviewing again
--       (compliance/archive-search-held-release-*.md), the other tied
--       directly to the live, real reopened_at/status escalation lifecycle
--       (20260912040000 — itself already a GOVERNANCE.md compliance build).
--       Recommending the same quick Asimov nod 20260918000000/20260918020000
--       already recommended for this exact area, on Q's application-code
--       change specifically (not blocking on this schema file), before it
--       runs against real data.
-- ============================================================


-- ============================================================
-- SECTION A: archive_search_significance_driver_cursors — one row per
-- id-ordered driver scope, holding the last position it is safe to resume
-- from, and proof that BOTH the walked view's membership AND the
-- escalation-exclusion set applied to it have not changed underneath it.
-- ============================================================

CREATE TABLE IF NOT EXISTS archive_search_significance_driver_cursors (
  id                            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which id-ordered walk this row tracks. Free text, not an enum/FK, by
  -- design — see this file's own header for why a new scope should never
  -- require a schema change. Today, always the literal view name this
  -- scope's rows are walked from: 'missive_message_intake_search_safe_clear_branch'.
  scope                         TEXT          NOT NULL CHECK (scope <> ''),

  -- The last id this scope's driver has walked through, cumulatively, as of
  -- last_confirmed_at. NOT, by itself, proof of anything — see
  -- established_clear_branch_digest and established_escalation_digest,
  -- which are the actual safety checks, BOTH of which must be reconfirmed
  -- before this is trusted.
  cursor_id                     UUID          NOT NULL,

  -- COUNT(*) FROM this scope's view WHERE id <= cursor_id, as measured at
  -- last_confirmed_at. Kept for cheap human observability (a glance at this
  -- table shows real progress) — NEVER the correctness check by itself; see
  -- established_clear_branch_digest and this file's own Gap 1 for why a
  -- bare count can coincidentally match despite a real membership change
  -- underneath it.
  established_clear_branch_count    INTEGER   NOT NULL CHECK (established_clear_branch_count >= 0),

  -- md5(string_agg(id::text, ',' ORDER BY id ASC)) over the same rows
  -- established_clear_branch_count counts, as measured at last_confirmed_at
  -- — the actual safety proof for the clear-branch dimension. A fresh call
  -- to archive_search_missive_clear_branch_cursor_check(cursor_id)
  -- reproducing this exact digest is what makes it safe (together with the
  -- escalation digest below) to resume from cursor_id; any mismatch means
  -- something changed below the cursor (an addition, a removal, or a
  -- same-conversation reset-then-reclear round trip that a count alone
  -- would not catch) and the caller must fall back to a full walk from
  -- id=null this run.
  established_clear_branch_digest   TEXT      NOT NULL,

  -- COUNT(*) of the CURRENT archive_search_escalations exclusion set
  -- (status = 'open' OR (status = 'confirmed' AND reopened_at IS NULL)),
  -- as measured at last_confirmed_at. Observability only, same caveat as
  -- established_clear_branch_count — see established_escalation_digest for
  -- the actual check.
  established_escalation_count      INTEGER   NOT NULL CHECK (established_escalation_count >= 0),

  -- md5 digest of every `mailbox_key || '::' || missive_conversation_id`
  -- key currently in the escalation-exclusion set (same composite-key shape
  -- fetchEscalationExclusionSet()/passesEscalationExclusion() already use),
  -- as measured at last_confirmed_at — the actual safety proof for the
  -- escalation dimension (this file's own Gap 2). This set is NOT bounded
  -- by cursor_id — it is the whole current exclusion-relevant set, snapshot
  -- fresh every run, because archive_search_escalations is small by design
  -- and has no id-ordered relationship to missive_message_intake at all.
  -- A fresh call to archive_search_escalation_exclusion_digest_check()
  -- reproducing this exact digest is required, IN ADDITION TO the
  -- clear-branch digest matching, before cursor_id may be trusted: an
  -- escalation resolving (making a below-cursor conversation newly
  -- eligible) or a confirmed escalation being reopened (making one newly
  -- excluded) both change this digest even though they never touch
  -- screening_result and would leave established_clear_branch_digest alone.
  established_escalation_digest     TEXT      NOT NULL,

  -- When every established_* column above was last measured fresh (either
  -- after a full walk, or after re-confirming and advancing past a
  -- successful fast-forward). All four established_* values are always set
  -- together, from real query results, never derived by adding page
  -- lengths or reusing an earlier in-run fetch in application code — see
  -- this file's own header for why.
  last_confirmed_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- Set when a run's walk reached the true live end of the view at
  -- cursor_id (mirrors the existing `page.length < DRIVER_PAGE_SIZE`
  -- "exhausted" signal already in fetchDriverPage()'s own caller).
  -- INFORMATIONAL ONLY, never load-bearing for correctness: new rows can
  -- always appear ahead of (or behind) any given cursor as screening
  -- completes, so this only ever means "was fully walked as of
  -- last_confirmed_at," not "no more work will ever exist here."
  exhausted_at                  TIMESTAMPTZ,

  created_at                    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  UNIQUE (scope)
);

ALTER TABLE archive_search_significance_driver_cursors ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_archive_search_significance_driver_cursors_updated_at ON archive_search_significance_driver_cursors;
CREATE TRIGGER trg_archive_search_significance_driver_cursors_updated_at
  BEFORE UPDATE ON archive_search_significance_driver_cursors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE archive_search_significance_driver_cursors IS
  'One row per id-ordered significance-driver walk scope (today, exactly one: missive_message_intake_search_safe_clear_branch), letting fetchNextEligibleConversations() skip re-walking an already-exhausted region of the view on a fresh run. cursor_id alone proves nothing; established_clear_branch_digest (a hash of the actual ids below cursor_id, not just their count) AND established_escalation_digest (a hash of the CURRENT archive_search_escalations exclusion set, not just its count) are the real safety proofs, and BOTH must be reconfirmed live before cursor_id is trusted — see archive_search_missive_clear_branch_cursor_check() and archive_search_escalation_exclusion_digest_check(). Two independent things can change underneath a stale cursor: (1) id is gen_random_uuid() with zero time correlation, so a row can leave this view (a governance-driven screening reset, e.g. reset-layer1-removal-310.js) and later re-enter it with the same id anywhere in id-space; (2) an escalation on a still-unprocessed, below-cursor conversation can resolve or reopen (20260912040000''s reopened_at/status lifecycle), changing its true eligibility with no change to screening_result at all. Read/written exclusively via the service-role key. RLS enabled, zero permissive policies, matching every table in this schema family.';

COMMENT ON COLUMN archive_search_significance_driver_cursors.established_clear_branch_digest IS
  'md5(string_agg(id::text, '','' ORDER BY id ASC)) over every row in this scope''s view WHERE id <= cursor_id, as of last_confirmed_at. This, not established_clear_branch_count, is what makes fast-forwarding safe on the screening-result dimension: a plain row count below the cursor can coincidentally stay the same even when the actual membership changed (one row leaving via a screening reset, a different row entering via an ordinary new screening completion landing behind the cursor by chance, or one conversation''s own reset-then-reclear round trip) — this digest changes in every one of those cases. Recompute via archive_search_missive_clear_branch_cursor_check(cursor_id) and compare BEFORE trusting a saved cursor_id — AND check established_escalation_digest too, since either mismatch alone must block the fast-forward.';

COMMENT ON COLUMN archive_search_significance_driver_cursors.established_clear_branch_count IS
  'COUNT(*) FROM this scope''s view WHERE id <= cursor_id, as of last_confirmed_at. Observability/debugging only (a cheap, human-readable progress number) — the application must never use this alone to decide whether a saved cursor is safe to trust; see established_clear_branch_digest for the actual check and why a bare count is not sufficient on its own.';

COMMENT ON COLUMN archive_search_significance_driver_cursors.established_escalation_digest IS
  'md5 digest of every mailbox_key||''::''||missive_conversation_id key in archive_search_escalations currently matching status = ''open'' OR (status = ''confirmed'' AND reopened_at IS NULL) — the exact predicate fetchEscalationExclusionSet() already uses. NOT bounded by cursor_id: this is a full, unconditional snapshot of the current exclusion set, re-verified every run via archive_search_escalation_exclusion_digest_check(). A conversation below cursor_id can stay screening_result=''clear'' (established_clear_branch_digest unchanged) while an escalation on it resolves or reopens — this digest is what catches that, and it must match, IN ADDITION TO established_clear_branch_digest, before a saved cursor may be trusted.';

COMMENT ON COLUMN archive_search_significance_driver_cursors.established_escalation_count IS
  'COUNT(*) of the current archive_search_escalations exclusion set (status = ''open'' OR (status = ''confirmed'' AND reopened_at IS NULL)), as of last_confirmed_at. Observability/debugging only — see established_escalation_digest for the actual check and why a bare count is not sufficient on its own (one escalation resolving and a different one opening can leave the count unchanged while membership genuinely moved).';


-- ============================================================
-- SECTION B: verification functions. Two, not one — a bare PostgREST
-- count=exact/head=true request (already used elsewhere in this codebase,
-- e.g. estimateExpectedEligiblePool()) can only express a plain COUNT, not
-- the string_agg/md5 digest either dimension of this design actually needs
-- to be safe (see Gap 1 / Gap 2 above). Both are hardcoded to their one
-- real relation rather than taking a table/view name as a parameter — this
-- project has exactly one scope today, and accepting a dynamic identifier
-- for a service-role-only function is an avoidable injection-shaped risk
-- for no present benefit; if a second scope is ever genuinely needed, add a
-- second, similarly narrow function then, consistent with this migration
-- family's own preference for "additive when actually needed" over
-- speculative generality (see 20260918020000's own reasoning for rejecting
-- the precompute-snapshot-table approach on the same grounds).
-- ============================================================

CREATE OR REPLACE FUNCTION archive_search_missive_clear_branch_cursor_check(p_cursor_id UUID)
RETURNS TABLE (row_count BIGINT, digest TEXT)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    COUNT(*)::BIGINT AS row_count,
    md5(COALESCE(string_agg(id::text, ',' ORDER BY id ASC), '')) AS digest
  FROM missive_message_intake_search_safe_clear_branch
  WHERE id <= p_cursor_id;
$$;

REVOKE ALL ON FUNCTION archive_search_missive_clear_branch_cursor_check(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION archive_search_missive_clear_branch_cursor_check(UUID) TO service_role;

COMMENT ON FUNCTION archive_search_missive_clear_branch_cursor_check(UUID) IS
  'Returns the real, live COUNT and an md5 digest of every row id in missive_message_intake_search_safe_clear_branch WHERE id <= p_cursor_id, in one indexed pass (idx_missive_message_intake_clear_id, 20260914000000). Call this BEFORE trusting a saved archive_search_significance_driver_cursors row (compare the returned digest to established_clear_branch_digest) and AGAIN at the end of every run to record the new cursor position''s state. Matching alone is NOT sufficient to trust the cursor — archive_search_escalation_exclusion_digest_check() must also match. service_role only — EXECUTE revoked from PUBLIC.';


-- Full, unconditional snapshot digest of the CURRENT escalation-exclusion
-- set — no cursor/id parameter, because this set has no id-ordered
-- relationship to missive_message_intake at all; it is re-verified in full
-- every run, same as fetchEscalationExclusionSet() already does today.
CREATE OR REPLACE FUNCTION archive_search_escalation_exclusion_digest_check()
RETURNS TABLE (row_count BIGINT, digest TEXT)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    COUNT(*)::BIGINT AS row_count,
    md5(COALESCE(string_agg(mailbox_key || '::' || missive_conversation_id, ',' ORDER BY mailbox_key, missive_conversation_id), '')) AS digest
  FROM archive_search_escalations
  WHERE status = 'open' OR (status = 'confirmed' AND reopened_at IS NULL);
$$;

REVOKE ALL ON FUNCTION archive_search_escalation_exclusion_digest_check() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION archive_search_escalation_exclusion_digest_check() TO service_role;

COMMENT ON FUNCTION archive_search_escalation_exclusion_digest_check() IS
  'Returns the real, live COUNT and an md5 digest of every mailbox_key||''::''||missive_conversation_id key in archive_search_escalations currently matching status = ''open'' OR (status = ''confirmed'' AND reopened_at IS NULL) — the exact predicate and key shape fetchEscalationExclusionSet()/passesEscalationExclusion() already use in significance-pass.js. No parameter: this is a full, unconditional snapshot (the table is small by design, per 20260912040000), not bounded by any cursor. Call this alongside archive_search_missive_clear_branch_cursor_check() — compare against established_escalation_digest — before trusting a saved archive_search_significance_driver_cursors row; a resolved or newly-reopened escalation changes this digest with no change to screening_result at all, which the clear-branch digest alone cannot detect (this file''s own Gap 2). service_role only — EXECUTE revoked from PUBLIC.';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- REVOKE ALL ON FUNCTION archive_search_escalation_exclusion_digest_check() FROM service_role;
-- DROP FUNCTION IF EXISTS archive_search_escalation_exclusion_digest_check();
--
-- REVOKE ALL ON FUNCTION archive_search_missive_clear_branch_cursor_check(UUID) FROM service_role;
-- DROP FUNCTION IF EXISTS archive_search_missive_clear_branch_cursor_check(UUID);
--
-- DROP TRIGGER IF EXISTS trg_archive_search_significance_driver_cursors_updated_at ON archive_search_significance_driver_cursors;
-- DROP TABLE IF EXISTS archive_search_significance_driver_cursors;
-- -- Safe at any time: if application code has already shipped reading this
-- -- table, revert that code to always call fetchDriverPage(null) first
-- -- (today's existing, unconditional behavior), or the next run will error
-- -- looking for a table that no longer exists rather than safely falling
-- -- back to a full walk.
--
-- ============================================================
