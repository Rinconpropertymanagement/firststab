-- ============================================================
-- Migration: 20260924010000_archive_search_corpus_schema
-- Created:   2026-09-24
-- Author:    Q (builder), against Neo's concrete design
--
-- Builds projects/hub/email-intake/archive-search-search-performance-
-- security-barrier-spec.md (~980 lines, read in full before this file was
-- written) — a second, physically separate, trigger-maintained table,
-- archive_search_corpus, containing only the missive_message_intake rows
-- currently eligible for ordinary Archive Search. This exists to fix
-- GET /api/archive-search/search, which is down in production (every
-- query 500s, Postgres 57014) because missive_message_intake_search_safe's
-- security_barrier = true blocks the planner from using any index shape
-- for the non-leakproof `search_document @@ tsquery(...)` predicate.
-- security_barrier stays on that view, unchanged, permanently — this
-- migration does not touch it. See the spec's own "What This Does"
-- section for the full mechanism.
--
-- AUTHORIZATION CHAIN — every document below read in full before this file
-- was written, not summarized:
--   1. compliance/archive-search-search-performance-security-barrier-
--      outside-counsel-opinion.md — the opinion clearing a second,
--      separate eligible-content search corpus as a reasonable
--      alternative enforcement mechanism for the same substantive
--      exclusion rule security_barrier enforces today.
--   2. compliance/archive-search-search-performance-security-barrier-
--      asimov-confirmation.md and -mason-confirmation.md — CLEARED WITH
--      CONDITIONS on the abstract architecture.
--   3. projects/hub/email-intake/archive-search-search-performance-
--      security-barrier-spec.md — Neo's concrete technical design against
--      those two abstract confirmations.
--   4. compliance/archive-search-search-performance-security-barrier-
--      design-asimov-confirmation.md — Asimov's CLEARED WITH CONDITIONS
--      verdict on THIS exact concrete design (Neo's spec above). Three
--      conditions, all incorporated into this file and its companion
--      migration/scripts:
--        Condition 1 — the Rule 6 audit_log entry (spec Section 7) cited
--        the wrong section number for shadow mode and described a literal
--        7-day parallel run that will not happen. NOT written by this
--        migration at all (per the spec's own Section 7 header: it's
--        written once, at go-live, by the backfill script, with a real
--        measured row count) — the corrected version lives in
--        run-archive-search-corpus-backfill.js, citing the shadow-mode
--        waiver (item 3 below) by name instead of a 7-day observation
--        window that didn't happen.
--        Condition 2 — a lightweight periodic point-sample drift check
--        between archive_search_message_is_eligible() and the real, live
--        view, using proven-leakproof plain-equality lookups (never an
--        anti-join under security_barrier). Implemented below in
--        archive_search_corpus_reconcile(), Section 6.
--        Condition 3 — verify archive_search_flagged_suppressions's real
--        column names against production before this migration references
--        them. DONE, directly against production this session (service-
--        role Supabase access via .env), not assumed from Neo's spec or
--        the unmerged branch's migration file:
--          id, missive_conversation_id, mailbox_key, suppressed_by,
--          suppressed_at, suppression_reason, suppression_source — all
--          seven confirmed to exist via seven individual column-probe
--          SELECTs against the live table (0 live rows as of this
--          session, so a sample row couldn't be used — each column name
--          was checked directly instead of inferred from a sample).
--          Table exists in production because Peter applied
--          20260923000000_archive_search_flagged_release_gate_removal.sql
--          directly via Supabase's SQL Editor, independent of this
--          checkout's git/merge state (that migration lives only on the
--          unmerged feature/archive-search-flagged-release-gate-removal
--          branch) — same real drift Neo's own spec names and works
--          around; this migration depends only on the column names, which
--          are now independently confirmed live, not on that branch ever
--          merging.
--   5. compliance/archive-search-search-performance-security-barrier-
--      shadow-mode-owner-risk-acceptance.md — Peter's signed waiver of the
--      literal 7-day observation window (spec Section 8) specifically —
--      NOT of the mechanism. The same-transaction fail-closed removal
--      triggers (Section 3 below), the fail-open becoming-eligible trigger
--      (Section 4), and the reconciliation/audit logging (Section 6) all
--      still run from day one, exactly as designed. What's skipped is only
--      the week of watching them work before the search route is allowed
--      to depend on them — meaning once this migration is applied and the
--      backfill (run-archive-search-corpus-backfill.js) has run, Peter can
--      turn on ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED (router.js, .env)
--      immediately. Asimov's design confirmation (item 4 above) also
--      preserved one thing the waiver does NOT touch: TARS's own real-data
--      comparison pass (sampling actual queries against both
--      archive_search_corpus and missive_message_intake_search_safe,
--      confirming identical result sets) — CLAUDE.md's ordinary "TARS
--      verifies it works with real data" gate, not a shadow-mode artifact,
--      still needs to run once, for real, before that flag is ever turned
--      on. Not this migration's job; named here so it isn't lost.
--
-- STANDARD PIPELINE GATES STILL APPLY, per Asimov's design confirmation's
-- own closing note: Sentinel (RLS/access-control review on the new
-- table(s) and the kill-switch's access path), Ralph (concurrent-write and
-- trigger-failure chaos scenarios), and Judge all still need to review
-- this before it ships. This migration and its companion files do not
-- substitute for any of them.
--
-- Per this project's standing convention (no CLI/DB URL in this
-- environment), Q does not apply this. Peter applies it himself via
-- Supabase's SQL Editor, AFTER 20260924020000 (the CONCURRENTLY partial
-- index migration, which must be run alone, separately, per that file's
-- own header) can be applied either before or after this one — the two are
-- independent — but the reconciliation function below (Section 6) is
-- faster with that index in place.
--
-- ============================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================================
--   - Does not touch missive_message_intake_search_safe, or
--     security_barrier on it. Both stay exactly as they are, permanently
--     out of scope, per the spec's own Section 1.
--   - Does not touch missive_message_intake itself, other than adding one
--     AFTER INSERT OR UPDATE trigger (Section 4) — no column, constraint,
--     or existing index changes.
--   - Does not touch archive_search_escalations or
--     archive_search_flagged_suppressions as tables — both get one new
--     AFTER trigger each (Section 3), nothing else.
--   - Does not change GET /api/archive-search/search itself — that is
--     router.js, a separate file, gated behind an explicit env flag
--     (ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED) that defaults OFF, so this
--     migration can be applied without changing search's live behavior at
--     all until Peter backfills the corpus and flips that flag.
--   - Does not run the one-time backfill. archive_search_corpus starts and
--     stays empty until run-archive-search-corpus-backfill.js is run
--     separately, by Peter, after this migration is applied.
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist, applied by Q)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [ ] Does this break any existing data? No. Two brand-new tables, three
--       brand-new trigger functions + triggers (on existing tables, but
--       AFTER triggers only — no existing write path changes behavior),
--       three brand-new RPC functions. Nothing dropped or altered.
--   [x] Does this touch a table other code depends on? Yes:
--       missive_message_intake, archive_search_escalations,
--       archive_search_flagged_suppressions all get one new AFTER trigger
--       each. Every trigger is additive (fires after the real write
--       already succeeded) and, for the screening-pass direction
--       specifically, wraps its own body in EXCEPTION WHEN OTHERS so a
--       corpus-table problem can never fail or roll back the triggering
--       write (Section 4's own header explains why that asymmetry is
--       deliberate).
--   [x] Additive or destructive to SCHEMA? Additive only.
--   [ ] Tested on a copy of the data first? No staging copy of Supabase
--       exists in this project — same standing caveat every migration
--       here carries. Mitigated by: archive_search_corpus starts empty (no
--       backfill in this migration); the triggers only fire on writes that
--       already happen today; TARS's real-data pass (see authorization
--       chain, item 5) still needs to run before the search route ever
--       depends on this.
--   [x] Governance go-ahead needed? YES, already obtained — see
--       AUTHORIZATION CHAIN above. Do not apply this file if any of those
--       documents are missing, superseded, or if Sentinel/Ralph/Judge
--       haven't yet reviewed the concrete build this migration is part of.
-- ============================================================


-- ============================================================
-- SECTION 1: archive_search_message_is_eligible — the single, canonical
-- eligibility definition. Every trigger below, the reconciliation
-- function, and the backfill script's own RPC all call this — there is no
-- second, hand-copied WHERE clause anywhere in this build. Copied
-- byte-for-byte from missive_message_intake_search_safe's real, live
-- predicate, confirmed directly against production this session (not the
-- older, merged-only 'clear'-only definition):
--   missive_message_intake_search_safe live count: 255,296
--   screening_result = 'clear':                    254,510
--   screening_result = 'flagged_protected_class':       786
--   254,510 + 786 = 255,296 — exactly the view's live count, confirming
--   the escalations/suppressions NOT EXISTS clauses below are currently
--   excluding nothing further (0 open/confirmed-not-reopened escalations,
--   0 suppressions live as of this session) — consistent with, not merely
--   assumed to match, the predicate below.
--
-- MAINTENANCE OBLIGATION, stated honestly (unchanged from Neo's spec): if
-- missive_message_intake_search_safe's own definition ever changes again,
-- this function must change in lockstep, by hand. There is no mechanism
-- that keeps the two automatically in sync at DDL time — that's exactly
-- what Section 6's periodic drift check (Asimov's Condition 2) exists to
-- catch after the fact, given the 7-day shadow window that would normally
-- have surfaced this kind of drift by observation has been waived.
-- ============================================================
CREATE OR REPLACE FUNCTION archive_search_message_is_eligible(p_message_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    m.screening_result IN ('clear', 'flagged_protected_class')
    AND NOT EXISTS (
      SELECT 1 FROM archive_search_escalations e
      WHERE e.missive_conversation_id = m.missive_conversation_id
        AND e.mailbox_key             = m.mailbox_key
        AND (
          e.status = 'open'
          OR (e.status = 'confirmed' AND e.reopened_at IS NULL)
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM archive_search_flagged_suppressions s
      WHERE s.missive_conversation_id = m.missive_conversation_id
        AND s.mailbox_key             = m.mailbox_key
    )
  FROM missive_message_intake m
  WHERE m.id = p_message_id;
$$;

REVOKE ALL ON FUNCTION archive_search_message_is_eligible(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION archive_search_message_is_eligible(UUID) TO service_role;

COMMENT ON FUNCTION archive_search_message_is_eligible(UUID) IS
  'The SINGLE, canonical definition of "eligible for Archive Search" this whole build uses — every trigger, archive_search_corpus_reconcile(), and archive_search_corpus_backfill_batch() call this; none re-derive the condition independently. Copied byte-for-byte from missive_message_intake_search_safe''s real, live predicate, confirmed against production 2026-09-24 (255,296 live view rows = 254,510 clear + 786 flagged_protected_class exactly, with 0 escalation/suppression exclusions currently in effect). If the view''s own definition ever changes, this function must change in lockstep by hand — see archive_search_corpus_reconcile()''s drift-check step for the automated backstop that catches drift between this function and the view after the fact.';


-- ============================================================
-- SECTION 2: archive_search_corpus — the new table. One row per
-- missive_message_intake row CURRENTLY eligible for ordinary Archive
-- Search, message-grain (matching missive_message_intake_search_safe's own
-- grain). A row's mere presence in this table IS the eligibility
-- determination. Maintained EXCLUSIVELY by triggers (Sections 3-4) and the
-- reconciliation function (Section 6) — no application code ever writes to
-- this table directly.
--
-- A plain table, not a materialized view: Mason's condition 1 (same-
-- transaction, single-row removal on escalation/suppression) has no
-- materialized-view equivalent (REFRESH recomputes the whole thing). A
-- plain table has no security_barrier parameter to set at all — that's the
-- entire point of this design (see spec, "Why a plain table needs no
-- security_barrier"). Access is gated exactly like every other table in
-- this schema: RLS enabled, zero permissive policies, real access control
-- lives in requireArchiveSearchAccess (router.js) against
-- SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS.
-- ============================================================
CREATE TABLE IF NOT EXISTS archive_search_corpus (
  id                        UUID        PRIMARY KEY
                                         REFERENCES missive_message_intake(id) ON DELETE CASCADE,
  mailbox_key               TEXT        NOT NULL,
  missive_conversation_id   TEXT        NOT NULL,
  subject                   TEXT,
  from_address              TEXT,
  delivered_at              TIMESTAMPTZ,
  body_text                 TEXT,
  search_document           tsvector,
  synced_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE archive_search_corpus ENABLE ROW LEVEL SECURITY;
-- RLS enabled, zero permissive policies — same default every table in this
-- schema uses. Access is gated in application code
-- (requireArchiveSearchAccess), not RLS.

CREATE INDEX IF NOT EXISTS idx_archive_search_corpus_search_document
  ON archive_search_corpus USING GIN (search_document);

-- UPDATED 2026-09-24, after a real failed backfill: this index originally
-- INCLUDEd search_document (a tsvector) for a true index-only scan on the
-- text-search filter. A real production row hit ERROR 54000 ("index row
-- size 4472 exceeds btree version 4 maximum 2704") — a long email's
-- tokenized tsvector is too large for a btree row, INCLUDE column or not
-- (unlike GIN, which idx_archive_search_corpus_search_document above
-- already uses and has no such row-size ceiling). Dropped search_document
-- from this index's INCLUDE list. This index still lets Postgres walk
-- rows in delivered_at order without a sort; the text-search filter now
-- costs one heap fetch per candidate row instead of zero, which is a real
-- but minor cost next to this table's actual fix (no security_barrier, no
-- anti-joins, no full-table scan before the filter even applies).
CREATE INDEX IF NOT EXISTS idx_archive_search_corpus_delivered_at_covering
  ON archive_search_corpus (delivered_at DESC, id)
  INCLUDE (mailbox_key, missive_conversation_id);
-- Neither index needs CONCURRENTLY: this table is brand-new and empty at
-- creation time (backfill runs separately, after this migration, via
-- run-archive-search-corpus-backfill.js) — CREATE INDEX on an empty table
-- is instantaneous with no concurrent writers to block.

-- Serves archive_search_corpus_sync_from_escalation() /
-- _from_suppression() (Section 3), which both DELETE FROM
-- archive_search_corpus WHERE missive_conversation_id = ... AND
-- mailbox_key = ... — a full table scan without this index once the table
-- is populated.
CREATE INDEX IF NOT EXISTS idx_archive_search_corpus_conversation_mailbox
  ON archive_search_corpus (missive_conversation_id, mailbox_key);

COMMENT ON TABLE archive_search_corpus IS
  'A live, trigger-maintained copy of ONLY the missive_message_intake rows currently eligible for ordinary Archive Search, per archive_search_message_is_eligible(). Built to replace security_barrier-based query-time filtering for the one query it could never serve efficiently (full-text @@ search) — see projects/hub/email-intake/archive-search-search-performance-security-barrier-spec.md. missive_message_intake_search_safe is UNCHANGED and remains the required view for every other archive-search route. This table serves GET /api/archive-search/search ONLY, and only once ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED=true (router.js) — see that env var''s own .env.example comment for the deploy-order dependency. Maintained exclusively by triggers on missive_message_intake, archive_search_escalations, and archive_search_flagged_suppressions, plus the periodic archive_search_corpus_reconcile() job (Section 6) that self-heals drift and enforces the hard subset guarantee: this table''s row set must never be a superset of what missive_message_intake_search_safe would return right now.';


-- ============================================================
-- SECTION 3: Same-transaction removal — "leaving eligibility." Two real
-- write paths, both fail-closed (no exception handler): if the corpus-side
-- change can't be guaranteed, the ENTIRE triggering transaction
-- (escalate/resolve/reopen, or a suppression insert) rolls back and the
-- caller gets a real 500, never a silent gap. Mason's condition 1's
-- concrete meaning: "no lag, ever, full stop," for this direction only.
-- ============================================================
CREATE OR REPLACE FUNCTION archive_search_corpus_sync_from_escalation()
RETURNS TRIGGER AS $$
DECLARE
  is_excluding BOOLEAN;
BEGIN
  is_excluding := (NEW.status = 'open')
               OR (NEW.status = 'confirmed' AND NEW.reopened_at IS NULL);

  IF is_excluding THEN
    DELETE FROM archive_search_corpus
    WHERE missive_conversation_id = NEW.missive_conversation_id
      AND mailbox_key             = NEW.mailbox_key;
  ELSE
    -- false_alarm or reopened: re-derive eligibility per-message via the
    -- ONE shared function rather than assuming "not excluded by this
    -- table means eligible" — a message could still be held/unscreened or
    -- separately suppressed.
    INSERT INTO archive_search_corpus
      (id, mailbox_key, missive_conversation_id, subject, from_address, delivered_at, body_text, search_document, synced_at)
    SELECT m.id, m.mailbox_key, m.missive_conversation_id, m.subject, m.from_address, m.delivered_at, m.body_text, m.search_document, NOW()
    FROM missive_message_intake m
    WHERE m.missive_conversation_id = NEW.missive_conversation_id
      AND m.mailbox_key             = NEW.mailbox_key
      AND archive_search_message_is_eligible(m.id)
    ON CONFLICT (id) DO UPDATE SET
      subject          = EXCLUDED.subject,
      from_address      = EXCLUDED.from_address,
      delivered_at      = EXCLUDED.delivered_at,
      body_text         = EXCLUDED.body_text,
      search_document   = EXCLUDED.search_document,
      synced_at         = NOW();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- Deliberately NO exception handler. If this fails, the triggering
-- escalate/resolve/reopen transaction fails with it.

CREATE TRIGGER trg_archive_search_corpus_sync_from_escalation
  AFTER INSERT OR UPDATE ON archive_search_escalations
  FOR EACH ROW
  EXECUTE FUNCTION archive_search_corpus_sync_from_escalation();

COMMENT ON FUNCTION archive_search_corpus_sync_from_escalation() IS
  'Fail-closed, same-transaction leaving-eligibility trigger (Mason condition 1, "no lag, ever, full stop"). Fires on every INSERT/UPDATE to archive_search_escalations. An open report or a confirmed-not-reopened report removes the conversation''s messages from archive_search_corpus; a false_alarm resolution or a reopen re-derives per-message eligibility via archive_search_message_is_eligible() rather than assuming re-inclusion. No exception handler: a corpus-write failure here rolls back the entire escalate/resolve/reopen transaction.';

CREATE OR REPLACE FUNCTION archive_search_corpus_sync_from_suppression()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM archive_search_corpus
  WHERE missive_conversation_id = NEW.missive_conversation_id
    AND mailbox_key             = NEW.mailbox_key;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- No exception handler — same fail-closed reasoning as the escalation
-- trigger above. archive_search_flagged_suppressions is append-only (no
-- revoke path), so this is INSERT-only, one direction only.

CREATE TRIGGER trg_archive_search_corpus_sync_from_suppression
  AFTER INSERT ON archive_search_flagged_suppressions
  FOR EACH ROW
  EXECUTE FUNCTION archive_search_corpus_sync_from_suppression();

COMMENT ON FUNCTION archive_search_corpus_sync_from_suppression() IS
  'Fail-closed, same-transaction leaving-eligibility trigger. Fires on every INSERT to archive_search_flagged_suppressions (append-only, no revoke path — INSERT-only trigger by design). Removes the suppressed conversation''s messages from archive_search_corpus immediately. No exception handler: a corpus-write failure here rolls back the suppression insert itself.';


-- ============================================================
-- SECTION 4: Same-transaction, fail-OPEN "becoming eligible" — the
-- screening pass direction. Unlike Section 3, exceptions are caught and
-- logged (RAISE WARNING), never allowed to fail the triggering write:
-- markConversationScreened()'s own UPDATE must always succeed regardless
-- of corpus-table health, because that pipeline is what the rest of this
-- system's Fair Housing protections depend on running reliably. Primary
-- propagation target: 0 seconds (same-transaction, structural). Any gap
-- left by a caught exception here is closed by archive_search_corpus_
-- reconcile()'s own 15-minute-cadence backstop (Section 6).
-- ============================================================
CREATE OR REPLACE FUNCTION archive_search_corpus_sync_from_message()
RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    IF archive_search_message_is_eligible(NEW.id) THEN
      INSERT INTO archive_search_corpus
        (id, mailbox_key, missive_conversation_id, subject, from_address, delivered_at, body_text, search_document, synced_at)
      VALUES
        (NEW.id, NEW.mailbox_key, NEW.missive_conversation_id, NEW.subject, NEW.from_address, NEW.delivered_at, NEW.body_text, NEW.search_document, NOW())
      ON CONFLICT (id) DO UPDATE SET
        subject          = EXCLUDED.subject,
        from_address      = EXCLUDED.from_address,
        delivered_at      = EXCLUDED.delivered_at,
        body_text         = EXCLUDED.body_text,
        search_document   = EXCLUDED.search_document,
        synced_at         = NOW();
    ELSE
      DELETE FROM archive_search_corpus WHERE id = NEW.id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Deliberately swallowed. markConversationScreened()'s own write must
    -- never fail because of a corpus-table problem. Any gap left here is
    -- caught and self-healed by archive_search_corpus_reconcile()'s own
    -- next run (Section 6).
    RAISE WARNING 'archive_search_corpus_sync_from_message failed for message %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_archive_search_corpus_sync_from_message
  AFTER INSERT OR UPDATE ON missive_message_intake
  FOR EACH ROW
  EXECUTE FUNCTION archive_search_corpus_sync_from_message();

COMMENT ON FUNCTION archive_search_corpus_sync_from_message() IS
  'Fail-OPEN, same-transaction becoming-eligible trigger. Fires on every INSERT/UPDATE to missive_message_intake (not narrowly scoped to screening_result, so a future subject/body_text redaction re-syncs this table''s copy too, per 20260910030000''s own search_document column comment). Exceptions are caught and logged (RAISE WARNING), never propagated — the triggering write (most commonly markConversationScreened()''s hourly screening-cron UPDATE) must always succeed. Deliberate asymmetry vs. archive_search_corpus_sync_from_escalation()/_from_suppression(): this pipeline''s own reliability is what the rest of this system''s Fair Housing protections depend on. Any gap left by a caught exception is closed by archive_search_corpus_reconcile()''s 15-minute backstop.';


-- ============================================================
-- MIGRATION-TIME LOCKING CAVEAT — restated from Neo's spec, not a new
-- finding: CREATE TRIGGER above (on missive_message_intake) takes a brief
-- SHARE ROW EXCLUSIVE lock — metadata-only, normally fast, but it blocks
-- concurrent writers for its duration. Apply this migration during a lull
-- in the hourly screening cron, not mid-run, same operational discipline
-- every prior DDL statement against this table has already documented.
-- ============================================================


-- ============================================================
-- SECTION 5: The kill-switch / reconciliation-state singleton row. This is
-- the "small single-row health/status check" GET /api/archive-search/
-- search consults (router.js) before querying archive_search_corpus,
-- falling back to missive_message_intake_search_safe when
-- kill_switch_active = true — the concrete shape for the fail-safe
-- mechanism the spec named but deliberately left to Q's build (spec
-- Section 9, item 3 / Open Item 2). Per Asimov's design confirmation, this
-- concrete shape is a required follow-up gate — Asimov should see it
-- before it ships, same as everything else in this build.
--
-- A single-row table, not a KV/settings table this schema doesn't have —
-- id is a BOOLEAN fixed at TRUE, CHECK-enforced, so INSERT can only ever
-- produce exactly one row (a second INSERT attempt fails the CHECK/PK
-- combination rather than silently creating ambiguity about which row is
-- "the" state).
-- ============================================================
CREATE TABLE IF NOT EXISTS archive_search_corpus_reconciliation_state (
  id                              BOOLEAN     PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),
  last_run_at                     TIMESTAMPTZ,
  last_superset_violation_count   INT         NOT NULL DEFAULT 0,
  last_gap_count                  INT         NOT NULL DEFAULT 0,
  last_drift_mismatch_count       INT         NOT NULL DEFAULT 0,
  kill_switch_active              BOOLEAN     NOT NULL DEFAULT FALSE,
  kill_switch_reason              TEXT,
  kill_switch_activated_at        TIMESTAMPTZ,
  kill_switch_cleared_at          TIMESTAMPTZ,
  kill_switch_cleared_by          TEXT
);

ALTER TABLE archive_search_corpus_reconciliation_state ENABLE ROW LEVEL SECURITY;
-- RLS enabled, zero permissive policies — same default every table in this
-- schema uses. Read by GET /api/archive-search/search and written by
-- archive_search_corpus_reconcile(), both via the service-role connection.

COMMENT ON TABLE archive_search_corpus_reconciliation_state IS
  'Singleton (exactly one row, id=TRUE) status row written by archive_search_corpus_reconcile() (Section 6) and read by GET /api/archive-search/search (router.js) before every corpus-backed query. kill_switch_active=true means: fall back to missive_message_intake_search_safe (the original, still-security_barrier-protected view) instead of archive_search_corpus, until a human confirms corpus health and clears it. To clear by hand once confirmed healthy: UPDATE archive_search_corpus_reconciliation_state SET kill_switch_active = false, kill_switch_cleared_at = NOW(), kill_switch_cleared_by = ''<your name>'' WHERE id = TRUE; — same "Peter applies fixes directly via Supabase''s SQL Editor" convention this project already uses everywhere else.';


-- ============================================================
-- SECTION 6: archive_search_corpus_reconcile() — the subset-guarantee
-- reconciliation job (spec Section 5), including Asimov's Condition 2
-- drift check. Callable directly by Peter (SELECT
-- archive_search_corpus_reconcile();, in Supabase's SQL Editor) or by a
-- cron wrapper via Supabase RPC — router.js exposes it as
-- POST /api/archive-search/process-corpus-reconciliation (x-cron-secret
-- gated, same pattern as process-pending/process-significance-pending),
-- which also sends sendFailureAlertEmail() on the conditions this
-- function's returned summary flags, since plain SQL cannot send email.
--
-- Never queries missive_message_intake_search_safe with a correlated
-- anti-join — 20260918020000's own live evidence proved that plan
-- unstable run-to-run, even against an empty exception table. The gap/
-- superset checks below are plain anti-joins against archive_search_corpus
-- and missive_message_intake directly (neither carries security_barrier,
-- so this instability does not apply to them). The ONE place this
-- function does touch the barrier'd view is the drift-check (Condition 2),
-- and there only via individual plain-equality point lookups (id = ...),
-- the exact query shape 20260912040000's own header already proved
-- leakproof and fast under security_barrier — never an anti-join.
-- ============================================================
CREATE OR REPLACE FUNCTION archive_search_corpus_reconcile()
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_run_id                    UUID := gen_random_uuid();
  v_superset_ids               UUID[];
  v_superset_count              INT := 0;
  v_previous_superset_count     INT := 0;
  v_gap_inserted_count           INT := 0;
  v_previous_gap_count           INT := 0;
  v_gap_repeated              BOOLEAN := FALSE;
  v_systemic                  BOOLEAN := FALSE;
  v_sample_ids                 UUID[];
  v_sample_id                    UUID;
  v_drift_sample_size            INT := 0;
  v_drift_mismatch_ids         UUID[] := ARRAY[]::UUID[];
  v_drift_mismatch_count         INT := 0;
  v_kill_switch_active        BOOLEAN;
  v_summary                    JSONB;
BEGIN
  -- Ensure the singleton row exists, then lock it for the duration of
  -- this run so two concurrent reconciliation runs (a manual SQL-Editor
  -- call landing mid-cron-run) can't both read/write the previous-run
  -- counters and corrupt the "repeated across consecutive runs" logic.
  INSERT INTO archive_search_corpus_reconciliation_state (id) VALUES (TRUE)
  ON CONFLICT (id) DO NOTHING;
  PERFORM 1 FROM archive_search_corpus_reconciliation_state WHERE id = TRUE FOR UPDATE;

  SELECT last_superset_violation_count, last_gap_count
    INTO v_previous_superset_count, v_previous_gap_count
  FROM archive_search_corpus_reconciliation_state WHERE id = TRUE;

  -- ── Step 1: superset check — the guarantee that must never be true.
  -- Rows in archive_search_corpus the canonical function now says are NOT
  -- eligible. Self-heal immediately (delete), regardless of severity.
  SELECT array_agg(c.id) INTO v_superset_ids
  FROM archive_search_corpus c
  WHERE NOT archive_search_message_is_eligible(c.id);
  v_superset_count := COALESCE(array_length(v_superset_ids, 1), 0);

  IF v_superset_count > 0 THEN
    DELETE FROM archive_search_corpus WHERE id = ANY(v_superset_ids);

    INSERT INTO audit_log (action, entity_type, entity_id, actor_type, actor_id, risk_level, privacy_category, details)
    VALUES (
      'archive_search.corpus_subset_violation_detected',
      'archive_search_corpus', v_run_id, 'system', 'archive_search_corpus_reconcile',
      'critical', 'unclassified',
      jsonb_build_object(
        'violation_count', v_superset_count,
        'action_taken', 'deleted from archive_search_corpus within this reconciliation run',
        'message_ids', to_jsonb(v_superset_ids)
      )
    );
  END IF;

  -- Systemic: >500 rows in one pass, OR any nonzero violation count
  -- repeats across two consecutive runs (spec Section 5's own table).
  v_systemic := v_superset_count > 500 OR (v_superset_count > 0 AND v_previous_superset_count > 0);

  IF v_systemic THEN
    UPDATE archive_search_corpus_reconciliation_state
    SET kill_switch_active = TRUE,
        kill_switch_reason = format(
          'Systemic superset violation: %s row(s) deleted this run (previous run: %s row(s)). GET /api/archive-search/search falls back to missive_message_intake_search_safe until a human confirms corpus health and clears this switch (see this table''s own COMMENT for the clear statement).',
          v_superset_count, v_previous_superset_count
        ),
        kill_switch_activated_at = COALESCE(kill_switch_activated_at, NOW())
    WHERE id = TRUE;

    INSERT INTO audit_log (action, entity_type, entity_id, actor_type, actor_id, risk_level, privacy_category, details)
    VALUES (
      'archive_search.corpus_kill_switch_activated',
      'archive_search_corpus', v_run_id, 'system', 'archive_search_corpus_reconcile',
      'critical', 'unclassified',
      jsonb_build_object('reason', 'systemic_superset_violation', 'this_run_count', v_superset_count, 'previous_run_count', v_previous_superset_count)
    );
  END IF;

  -- ── Step 2: gap check + self-heal — a lag gap (eligible row missing
  -- from corpus). A single set-based INSERT, not the chunked backfill
  -- loop (archive_search_corpus_backfill_batch, Section 7) — the anti-join
  -- below only ever needs to touch the TRUE gap (rows not already
  -- present), which after the first run should be small. On the very
  -- first run, before the one-time backfill has completed, this may
  -- insert on the order of the whole eligible population in one
  -- statement — expected, per spec Section 9 ("a partially-backfilled
  -- corpus is a real, valid state... correct, expected behavior, not a
  -- bug"), and a single INSERT...SELECT is still one bounded, indexed
  -- statement, not an unbounded per-row loop.
  INSERT INTO archive_search_corpus
    (id, mailbox_key, missive_conversation_id, subject, from_address, delivered_at, body_text, search_document, synced_at)
  SELECT m.id, m.mailbox_key, m.missive_conversation_id, m.subject, m.from_address, m.delivered_at, m.body_text, m.search_document, NOW()
  FROM missive_message_intake m
  WHERE m.screening_result IN ('clear', 'flagged_protected_class')
    AND archive_search_message_is_eligible(m.id)
    AND NOT EXISTS (SELECT 1 FROM archive_search_corpus c WHERE c.id = m.id)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_gap_inserted_count = ROW_COUNT;

  v_gap_repeated := v_gap_inserted_count > 0 AND v_previous_gap_count > 0;

  IF v_gap_inserted_count > 0 THEN
    INSERT INTO audit_log (action, entity_type, entity_id, actor_type, actor_id, risk_level, privacy_category, details)
    VALUES (
      'archive_search.corpus_sync_gap_detected',
      'archive_search_corpus', v_run_id, 'system', 'archive_search_corpus_reconcile',
      CASE WHEN v_gap_repeated THEN 'high' ELSE 'medium' END, 'unclassified',
      jsonb_build_object(
        'gap_count', v_gap_inserted_count,
        'previous_run_gap_count', v_previous_gap_count,
        'repeated_across_consecutive_runs', v_gap_repeated,
        'action_taken', 'inserted into archive_search_corpus within this reconciliation run'
      )
    );
  END IF;

  -- ── Step 3: drift check (Asimov's Condition 2) — a lightweight,
  -- rotating point-sample of CURRENT corpus row ids, each checked with a
  -- plain-equality lookup against the real, live, security_barrier'd view
  -- (never an anti-join). Catches archive_search_message_is_eligible()
  -- silently drifting from the view's real predicate over time — the
  -- exact failure mode that already happened once in this project in the
  -- last 24 hours (20260924000000's own header) and that the waived
  -- 7-day shadow window would otherwise have been the thing to catch it.
  -- TABLESAMPLE SYSTEM, not ORDER BY random(): page-level sampling, cheap
  -- even as this table grows, appropriate for "lightweight" per Asimov's
  -- own wording — not a rigorous statistical guarantee, a rotating spot
  -- check.
  SELECT array_agg(id) INTO v_sample_ids
  FROM (
    SELECT id FROM archive_search_corpus TABLESAMPLE SYSTEM (1)
    LIMIT 200
  ) sampled;
  v_drift_sample_size := COALESCE(array_length(v_sample_ids, 1), 0);

  IF v_drift_sample_size > 0 THEN
    FOREACH v_sample_id IN ARRAY v_sample_ids LOOP
      -- Plain equality point lookup on a built-in scalar type (uuid) —
      -- confirmed leakproof and fast under security_barrier
      -- (20260912040000's own header, quoted directly in Neo's spec).
      IF NOT EXISTS (
        SELECT 1 FROM missive_message_intake_search_safe v WHERE v.id = v_sample_id
      ) THEN
        v_drift_mismatch_ids := array_append(v_drift_mismatch_ids, v_sample_id);
      END IF;
    END LOOP;
    v_drift_mismatch_count := COALESCE(array_length(v_drift_mismatch_ids, 1), 0);
  END IF;

  IF v_drift_mismatch_count > 0 THEN
    -- A corpus row the canonical function says is eligible, but the real,
    -- live view does not return — direct evidence of drift, not merely
    -- internal inconsistency (step 1's own check can't catch this, since
    -- it only re-checks the same function against itself). Self-heal the
    -- specific rows found (same isolated-violation treatment as step 1),
    -- and log critical — this is exactly the novel risk Condition 2
    -- exists to catch now that no 7-day observation window will.
    DELETE FROM archive_search_corpus WHERE id = ANY(v_drift_mismatch_ids);

    INSERT INTO audit_log (action, entity_type, entity_id, actor_type, actor_id, risk_level, privacy_category, details)
    VALUES (
      'archive_search.corpus_view_drift_check',
      'archive_search_corpus', v_run_id, 'system', 'archive_search_corpus_reconcile',
      'critical', 'unclassified',
      jsonb_build_object(
        'sample_size', v_drift_sample_size,
        'mismatch_count', v_drift_mismatch_count,
        'mismatched_ids', to_jsonb(v_drift_mismatch_ids),
        'interpretation', 'archive_search_message_is_eligible() disagreed with missive_message_intake_search_safe''s real, live predicate for these ids — the function likely needs updating to match a real view change (see this function''s own MAINTENANCE OBLIGATION comment). Rows deleted from archive_search_corpus as an immediate self-heal.',
        'action_taken', 'deleted from archive_search_corpus within this reconciliation run'
      )
    );
  ELSIF v_drift_sample_size > 0 THEN
    -- Clean sample — still logged (Rule 1's "every decision gets logged,"
    -- applied to "nothing was wrong" too), at low severity.
    INSERT INTO audit_log (action, entity_type, entity_id, actor_type, actor_id, risk_level, privacy_category, details)
    VALUES (
      'archive_search.corpus_view_drift_check',
      'archive_search_corpus', v_run_id, 'system', 'archive_search_corpus_reconcile',
      'low', 'unclassified',
      jsonb_build_object('sample_size', v_drift_sample_size, 'mismatch_count', 0)
    );
  END IF;

  -- ── Step 4: update state, write the always-present run summary. ──
  UPDATE archive_search_corpus_reconciliation_state
  SET last_run_at                    = NOW(),
      last_superset_violation_count  = v_superset_count,
      last_gap_count                 = v_gap_inserted_count,
      last_drift_mismatch_count      = v_drift_mismatch_count
  WHERE id = TRUE;

  SELECT kill_switch_active INTO v_kill_switch_active
  FROM archive_search_corpus_reconciliation_state WHERE id = TRUE;

  v_summary := jsonb_build_object(
    'run_id', v_run_id,
    'superset_violation_count', v_superset_count,
    'gap_count', v_gap_inserted_count,
    'gap_repeated_across_consecutive_runs', v_gap_repeated,
    'systemic_violation', v_systemic,
    'drift_sample_size', v_drift_sample_size,
    'drift_mismatch_count', v_drift_mismatch_count,
    'kill_switch_active', v_kill_switch_active,
    'clean_run', (v_superset_count = 0 AND v_gap_inserted_count = 0 AND v_drift_mismatch_count = 0)
  );

  INSERT INTO audit_log (action, entity_type, entity_id, actor_type, actor_id, risk_level, privacy_category, details)
  VALUES (
    'archive_search.corpus_reconciliation_run',
    'archive_search_corpus', v_run_id, 'system', 'archive_search_corpus_reconcile',
    CASE
      WHEN v_systemic OR v_drift_mismatch_count > 0 THEN 'critical'
      WHEN v_gap_repeated THEN 'high'
      WHEN v_superset_count > 0 OR v_gap_inserted_count > 0 THEN 'medium'
      ELSE 'low'
    END,
    'unclassified',
    v_summary
  );

  RETURN v_summary;
END;
$$;

REVOKE ALL ON FUNCTION archive_search_corpus_reconcile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION archive_search_corpus_reconcile() TO service_role;

COMMENT ON FUNCTION archive_search_corpus_reconcile() IS
  'The subset-guarantee reconciliation job (spec Section 5) plus Asimov''s Condition 2 drift check. Self-heals superset violations (deletes) and gaps (inserts) against archive_search_corpus, flips archive_search_corpus_reconciliation_state.kill_switch_active on a systemic superset violation, and runs a lightweight rotating point-sample check of archive_search_message_is_eligible() against missive_message_intake_search_safe''s real predicate. Writes one or more audit_log entries every run (always at least archive_search.corpus_reconciliation_run). Returns a JSONB summary for a caller (e.g. the cron wrapper, POST /api/archive-search/process-corpus-reconciliation in router.js) to decide whether to send a failure alert email — this function itself cannot send email. Proposed cadence: every 15 minutes (TARS should confirm real run time before this is locked in as the audited value, per spec Section 5''s own open item).';


-- ============================================================
-- SECTION 7: archive_search_corpus_backfill_batch — the one-time backfill
-- script's own RPC (run-archive-search-corpus-backfill.js, written, not
-- run, per this project's standing convention). Cursor-paginated, small
-- fixed batches (chunked discipline every one-time backfill in this
-- project already follows) — deliberately SEPARATE from the reconciliation
-- job's own single-statement gap-fill (Section 6, Step 2), which only
-- needs to touch the true (usually small) gap; this function is for the
-- one-time, potentially-whole-population initial load, where explicit
-- chunking gives the backfill script real, resumable progress visibility
-- (measure -> chunk -> verify -> one Rule 6 audit_log entry with a real
-- count), matching reset-layer1-removal-310.js''s own discipline.
-- ============================================================
CREATE OR REPLACE FUNCTION archive_search_corpus_backfill_batch(
  p_cursor_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 5000
)
RETURNS TABLE (examined_count INT, written_count INT, next_cursor UUID)
LANGUAGE sql
SET search_path = public
AS $$
  WITH candidates AS (
    SELECT m.id, m.mailbox_key, m.missive_conversation_id, m.subject, m.from_address, m.delivered_at, m.body_text, m.search_document
    FROM missive_message_intake m
    WHERE m.screening_result IN ('clear', 'flagged_protected_class')
      AND (p_cursor_id IS NULL OR m.id > p_cursor_id)
      AND archive_search_message_is_eligible(m.id)
    ORDER BY m.id ASC
    LIMIT p_limit
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
    (SELECT id FROM candidates ORDER BY id DESC LIMIT 1);
$$;

REVOKE ALL ON FUNCTION archive_search_corpus_backfill_batch(UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION archive_search_corpus_backfill_batch(UUID, INT) TO service_role;

COMMENT ON FUNCTION archive_search_corpus_backfill_batch(UUID, INT) IS
  'Cursor-paginated batch upsert used ONLY by run-archive-search-corpus-backfill.js (the one-time backfill script) — id-ordered, id > p_cursor_id, LIMIT p_limit, using idx_missive_message_intake_eligible_id (20260924020000) for the base-table scan. examined_count < p_limit tells the caller it has reached the end. Idempotent (ON CONFLICT DO UPDATE) — safe to re-run from any cursor.';


-- ============================================================
-- ROLLBACK (run these statements, in this order, to undo this migration)
-- ============================================================
-- DROP TRIGGER IF EXISTS trg_archive_search_corpus_sync_from_message ON missive_message_intake;
-- DROP TRIGGER IF EXISTS trg_archive_search_corpus_sync_from_suppression ON archive_search_flagged_suppressions;
-- DROP TRIGGER IF EXISTS trg_archive_search_corpus_sync_from_escalation ON archive_search_escalations;
-- DROP FUNCTION IF EXISTS archive_search_corpus_backfill_batch(UUID, INT);
-- DROP FUNCTION IF EXISTS archive_search_corpus_reconcile();
-- DROP FUNCTION IF EXISTS archive_search_corpus_sync_from_message();
-- DROP FUNCTION IF EXISTS archive_search_corpus_sync_from_suppression();
-- DROP FUNCTION IF EXISTS archive_search_corpus_sync_from_escalation();
-- DROP TABLE IF EXISTS archive_search_corpus_reconciliation_state;
-- DROP TABLE IF EXISTS archive_search_corpus;
-- DROP FUNCTION IF EXISTS archive_search_message_is_eligible(UUID);
--
-- Rolling this back while ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED=true in any
-- deployed router.js would break search (querying a table that no longer
-- exists) — confirm that flag is unset/false first, same deploy-order
-- discipline this migration's own header names for turning it ON.
-- ============================================================
