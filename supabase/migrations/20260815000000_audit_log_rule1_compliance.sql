-- ============================================================
-- Migration: 20260815000000_audit_log_rule1_compliance
-- Created:   2026-08-15
-- Author:    Neo (database specialist)
--
-- WHY THIS MIGRATION EXISTS
-- Asimov's governance review found that audit_log (created in
-- 20260720000003_foundation.sql) does not meet GOVERNANCE.md Rule 1
-- ("Every Decision Gets Logged"). This blocks two upcoming data
-- connections (Latchel maintenance data, a shared email inbox) that
-- both need to write through audit_log. This migration brings the
-- table into full Rule 1 compliance.
--
-- GOVERNANCE.md Rule 1, verbatim, is the spec for this migration:
--   "Every AI decision, recommendation, or action must be written to
--   an append-only audit log with all required fields: company_id,
--   instance_id, decision_id, action_id, actor_type, actor_id,
--   event_type, event_summary, event_data, context_snapshot,
--   privacy_category (Solove taxonomy), regulation_tags[], risk_level,
--   contact_id, property_id, legal_basis, retention_policy,
--   sequence_num, prev_hash, entry_hash. The hash chain (sequence_num,
--   prev_hash, entry_hash) is mandatory — every entry must chain to
--   the previous. Every event_data must include
--   trace: { trace_id, span_id, parent_span_id }."
-- Every one of those fields is added below. Nothing in the summary
-- Jarvis relayed narrowed this down to 3 fields — that was shorthand;
-- this migration implements the rule's full, literal field list.
--
-- WHAT AUDIT_LOG HAS TODAY (unchanged by this migration)
--   id, action, entity_type, entity_id, performed_by, details, created_at
-- ~20 call sites across projects/insurance-compliance, projects/hub/insurance,
-- projects/hub/security-deposit, and projects/insurance-compliance/monitor.js
-- write to this table today (grepped before writing this migration). Every
-- one of them was read directly, not just grepped-and-assumed. Every one
-- only ever sets action, entity_type, entity_id, and details — none of
-- them set performed_by (zero matches for "performed_by" as a write across
-- all four files). Human attribution today is done informally, by stuffing
-- an email string into details (e.g. details.created_by, details.uploaded_by,
-- details.answered_by — the key name varies by call site). This is the
-- concrete gap behind Asimov's "performed_by only points to a human user or
-- is null" finding — in practice almost nothing populates performed_by at
-- all, human or AI. See the actor_type / actor_id design note below for how
-- this migration handles that without requiring every call site to change
-- before this can ship.
--
-- DESIGN DECISIONS WORTH READING BEFORE YOU RUN THIS
--
-- 1. company_id has no table to reference. This schema is single-tenant —
--    one Supabase project, one company (Rincon Management), no `companies`
--    table exists anywhere in this schema (checked). Rule 1 is written as
--    if it might run in a multi-company product. Rather than invent a
--    companies table no other part of this system has or needs, company_id
--    is a plain TEXT column defaulting to the constant 'rincon-management'
--    (matching the Supabase project name in CLAUDE.md). If this system is
--    ever used for more than one company, that default stops being correct
--    and this column is where that change would land.
--
-- 2. instance_id is named exactly `instance_id` per Rule 1's literal text,
--    even though the rest of this schema calls the same concept
--    (a foreign key to workflow_instances.id) `workflow_instance_id`
--    (see tasks, scheduled_events, communications_log,
--    20260720000004_insurance_compliance). That's a real naming
--    inconsistency, introduced deliberately: Asimov's review is checking
--    for Rule 1's exact field names, so this migration matches Rule 1's
--    wording rather than this schema's local convention. Both names refer
--    to the same table. Flagged here so nobody "fixes" the mismatch later
--    without knowing why it exists.
--
-- 3. decision_id and action_id have no table to reference either — there is
--    no `decisions` table in this schema. Both are nullable, unconstrained
--    UUID columns for the calling application to use as correlation IDs:
--    decision_id to link multiple audit rows that belong to the same
--    decision (e.g. recommended -> approved -> executed), action_id to
--    identify this specific action occurrence. action_id defaults to a
--    fresh gen_random_uuid() so it's never left blank; decision_id has no
--    default because most routine system actions genuinely aren't part of
--    a decision flow and forcing one would be noise, not signal.
--
-- 4. actor_type / actor_id / actor_version — this is the "which AI agent
--    (and version) did this" fix Asimov's review asked for. actor_type is
--    a closed set ('human' | 'ai_agent' | 'system'). actor_id and
--    actor_version are free TEXT, not foreign keys — there is no agent
--    registry table in this schema, and valid actors today span the old
--    `users` table, the newer `team_members` table, plain email strings,
--    and AI agent names, none of which share one identity system yet. The
--    trigger below (audit_log_compute_chain) infers actor_type / actor_id
--    from performed_by when a caller doesn't set them explicitly, purely
--    as a safety net for old call sites — see the important caveat in the
--    handoff report about what this net does and does not catch.
--
-- 5. event_type mirrors the existing `action` column; event_data mirrors
--    the existing `details` column. Neither old column is renamed, dropped,
--    or touched — every existing writer keeps working unmodified. The
--    trigger keeps action/event_type and details/event_data in sync in
--    both directions, so a writer that only sets the old name still ends
--    up with both populated, and a writer updated to use the new
--    Rule-1 name doesn't leave the old one null either.
--
-- 6. Rule 1 requires event_data to always include
--    trace: { trace_id, span_id, parent_span_id }. This migration does
--    NOT enforce that with a NOT NULL / CHECK constraint, because none of
--    today's ~20 call sites set it, and a hard constraint here would break
--    every one of them immediately on deploy. This is a real, intentional
--    gap versus strict Rule 1 text — documented, not hidden — flagged
--    clearly in the handoff report as a follow-up for Q once call sites
--    are updated to pass trace context.
--
-- 7. privacy_category (Solove taxonomy) uses Solove's four top-level
--    categories — collection, processing, dissemination, invasion — plus
--    'unclassified' as an honest placeholder for rows nobody has
--    categorized yet (all pre-existing rows, and any future row a caller
--    doesn't set explicitly). 'unclassified' is preferred over silently
--    guessing a real category for historical data, or defaulting new rows
--    to something that looks precise but isn't.
--
-- 8. risk_level: same reasoning as privacy_category. Defaulting unknown
--    rows to 'low' would understate real risk on anything nobody has
--    actually assessed. 'unclassified' is the honest default; real values
--    ('low' | 'medium' | 'high' | 'critical') are for callers that have
--    actually assessed the action.
--
-- 9. retention_policy is NOT a placeholder, unlike privacy_category /
--    risk_level. audit_log's own CCPA note (right below, unchanged) already
--    documents this table's retention policy in prose: retained
--    indefinitely under Cal. Civ. Code Sec. 1798.105(d)(9)'s security/fraud
--    exemption, PII inside details/event_data redacted in place on a CCPA
--    request rather than the row being deleted. This migration just makes
--    that already-decided policy queryable instead of prose-only.
--
-- 10. contact_id / property_id are nullable foreign keys, ON DELETE SET
--     NULL (never CASCADE) — audit_log rows must never be deleted as a
--     side effect of something else being deleted. In practice neither
--     contacts nor properties are hard-deleted in this system (CCPA
--     requests anonymize in place, same pattern as everywhere else in this
--     schema), so this should rarely if ever fire.
--
-- 11. The hash chain (sequence_num, prev_hash, entry_hash) is a single
--     global chain across the whole table, not one chain per entity or per
--     actor — Rule 1 describes one append-only log, not a log per entity.
--     A genesis row is inserted first (sequence_num = 1, prev_hash = NULL
--     — the only row ever allowed to have a null prev_hash, enforced by
--     audit_log_chain_genesis_check below), then every pre-existing row is
--     walked forward in created_at order (id as tiebreaker) computing each
--     row's entry_hash from the row before it. Going forward, the
--     audit_log_compute_chain trigger computes this on every INSERT using
--     the exact same formula, so old and new rows chain together with no
--     seam at the migration boundary. The trigger serializes concurrent
--     inserts with pg_advisory_xact_lock so two simultaneous writers can
--     never both compute a hash from the same "previous row" and fork the
--     chain — without that lock, the hash chain's tamper-evidence guarantee
--     would be subtly broken under real concurrent writes, which is exactly
--     the kind of thing that looks fine in testing and quietly fails later.
--     This hash chain proves a row wasn't altered after being written; it
--     is not a cryptographic signature and isn't anchored anywhere outside
--     this database — someone with direct database access and enough
--     understanding of the formula could in principle rewrite the whole
--     chain forward from a tampered row. It catches accidental edits and
--     casual tampering, which is what an internal compliance log needs.
--
-- 12. This migration requires the pgcrypto extension (for digest(), used
--     to compute SHA-256 hashes). No existing migration in this schema
--     enables any extension (checked — gen_random_uuid() has been built
--     into Postgres core since v13 and doesn't need it). This is the
--     first thing in this schema that needs pgcrypto specifically.
--     Enabling it is standard and low-risk on Supabase.
--
-- WHAT THIS MIGRATION DOES NOT DO (considered, deliberately left out)
--   Rule 4 says audit-log tables are insert-only — no UPDATE, no DELETE.
--   That's already true by convention (documented in the original table
--   comment) but not enforced at the database level — RLS on this table
--   has zero permissive policies, but every writer today uses the
--   service-role key, which bypasses RLS entirely, so RLS was never
--   actually the enforcement mechanism here. A trigger that blocks
--   UPDATE/DELETE outright would be a real additional safeguard and would
--   reinforce the hash chain this migration adds — but it would also have
--   to special-case the CCPA redaction UPDATE this table's own header
--   comment already documents as sanctioned, and getting that wrong risks
--   breaking a real compliance procedure. That's a genuinely separate
--   piece of work from what was asked here (hash chain, privacy tagging,
--   actor/version tracking), so it isn't included in this migration —
--   flagged as a recommended follow-up in the handoff report instead of
--   being added silently.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- STEP 1 — extension required for digest() / SHA-256 hashing
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ============================================================
-- STEP 2 — add all new columns
-- Nullable-with-no-default where the trigger/backfill below computes
-- the real value (so "IS NULL" checks in that logic actually fire);
-- NOT NULL DEFAULT <constant> only where a plain constant is correct
-- for every row, old and new, with no conditional logic needed.
-- ============================================================

ALTER TABLE audit_log
  -- Identity / correlation (Rule 1: company_id, instance_id, decision_id, action_id)
  ADD COLUMN IF NOT EXISTS company_id       TEXT        NOT NULL DEFAULT 'rincon-management',
  ADD COLUMN IF NOT EXISTS instance_id      UUID        REFERENCES workflow_instances(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decision_id      UUID,
  ADD COLUMN IF NOT EXISTS action_id        UUID        NOT NULL DEFAULT gen_random_uuid(),

  -- Actor / agent tracking (Rule 1: actor_type, actor_id — actor_version added
  -- beyond Rule 1's literal list because the task that produced this migration
  -- explicitly asked for agent *version* tracking, and Rule 6/Rule 7 elsewhere
  -- in GOVERNANCE.md already assume agent changes are versioned)
  ADD COLUMN IF NOT EXISTS actor_type       TEXT,
  ADD COLUMN IF NOT EXISTS actor_id         TEXT,
  ADD COLUMN IF NOT EXISTS actor_version    TEXT,

  -- Event description (Rule 1: event_type, event_summary, event_data, context_snapshot)
  ADD COLUMN IF NOT EXISTS event_type       TEXT,
  ADD COLUMN IF NOT EXISTS event_summary    TEXT,
  ADD COLUMN IF NOT EXISTS event_data       JSONB,
  ADD COLUMN IF NOT EXISTS context_snapshot JSONB,

  -- Privacy / compliance tagging (Rule 1: privacy_category, regulation_tags[], risk_level, legal_basis, retention_policy)
  ADD COLUMN IF NOT EXISTS privacy_category TEXT        NOT NULL DEFAULT 'unclassified',
  ADD COLUMN IF NOT EXISTS regulation_tags  TEXT[]      NOT NULL DEFAULT '{}'::TEXT[],
  ADD COLUMN IF NOT EXISTS risk_level       TEXT        NOT NULL DEFAULT 'unclassified',
  ADD COLUMN IF NOT EXISTS legal_basis      TEXT,
  ADD COLUMN IF NOT EXISTS retention_policy TEXT        NOT NULL DEFAULT 'retain_indefinitely_ccpa_1798_105_d_9',

  -- Linkage (Rule 1: contact_id, property_id)
  ADD COLUMN IF NOT EXISTS contact_id       UUID        REFERENCES contacts(id)   ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS property_id      UUID        REFERENCES properties(id) ON DELETE SET NULL,

  -- Tamper-evident hash chain (Rule 1: sequence_num, prev_hash, entry_hash — mandatory)
  ADD COLUMN IF NOT EXISTS sequence_num     BIGINT,
  ADD COLUMN IF NOT EXISTS prev_hash        TEXT,
  ADD COLUMN IF NOT EXISTS entry_hash       TEXT;


-- ============================================================
-- STEP 3 — backfill existing rows, phase 1: simple field sync
-- Bulk, set-based, order-independent. Must run before the genesis
-- row is inserted (step 4) so these WHERE clauses only ever touch
-- genuinely pre-existing rows.
-- ============================================================

UPDATE audit_log SET event_type = action
  WHERE event_type IS NULL;

UPDATE audit_log SET event_data = COALESCE(details, '{}'::jsonb)
  WHERE event_data IS NULL;

UPDATE audit_log SET actor_type = CASE WHEN performed_by IS NOT NULL THEN 'human' ELSE 'system' END
  WHERE actor_type IS NULL;

UPDATE audit_log SET actor_id = performed_by::TEXT
  WHERE actor_id IS NULL AND performed_by IS NOT NULL;


-- ============================================================
-- STEP 4 — backfill existing rows, phase 2: the hash chain itself
--
-- Why this can't be a column DEFAULT: prev_hash and entry_hash for any
-- row depend on the row immediately before it — inherently sequential,
-- not expressible as a per-row-independent expression. Done procedurally:
--   1. Insert one genesis row. It has no predecessor, so prev_hash is
--      NULL — the only row ever allowed to have a null prev_hash.
--   2. Walk every pre-existing row oldest-to-newest (created_at, then id
--      as a tiebreaker for same-timestamp rows) and assign each one the
--      next sequence_num, the prior row's entry_hash as its prev_hash, and
--      a freshly computed entry_hash — using the exact same hash formula
--      the audit_log_compute_chain trigger (step 7) uses for all future
--      inserts, so there's no seam between backfilled and new rows.
-- This does not modify id, action, entity_type, entity_id, performed_by,
-- details, or created_at on any existing row — only the new columns.
--
-- Guarded to be safe to run twice by accident: if any row already has a
-- sequence_num, this whole block is skipped rather than inserting a
-- second genesis row or re-walking the chain.
-- ============================================================

DO $$
DECLARE
  r           RECORD;
  prev_hash_v TEXT;
  next_hash_v TEXT;
  seq_v       BIGINT := 0;
  hash_input  TEXT;
  genesis_id  UUID;
  backfilled  BIGINT := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM audit_log WHERE sequence_num IS NOT NULL) THEN
    RAISE NOTICE 'audit_log already has sequence_num values populated — skipping backfill (this migration looks like it already ran).';
    RETURN;
  END IF;

  -- 1. Genesis row — marks where the tamper-evident chain starts.
  seq_v := 1;
  hash_input := 'GENESIS|1|audit_log_chain_init|rincon-management';
  next_hash_v := encode(digest(hash_input, 'sha256'), 'hex');

  INSERT INTO audit_log (
    action, entity_type, entity_id, details,
    company_id, action_id, actor_type, actor_id,
    event_type, event_summary, event_data,
    privacy_category, regulation_tags, risk_level, retention_policy,
    sequence_num, prev_hash, entry_hash
  ) VALUES (
    'system.audit_chain_genesis', 'system', gen_random_uuid(),
    jsonb_build_object(
      'note', 'Hash chain initialized by migration 20260815000000_audit_log_rule1_compliance.'
    ),
    'rincon-management', gen_random_uuid(), 'system', 'migration:20260815000000_audit_log_rule1_compliance',
    'system.audit_chain_genesis',
    'Tamper-evident hash chain initialized for audit_log per GOVERNANCE.md Rule 1.',
    jsonb_build_object(
      'note', 'Hash chain initialized by migration 20260815000000_audit_log_rule1_compliance. Rows below this one in sequence_num order that predate the migration were backfilled forward from here in created_at order.',
      'trace', jsonb_build_object('trace_id', NULL, 'span_id', NULL, 'parent_span_id', NULL)
    ),
    'unclassified', '{}'::TEXT[], 'unclassified', 'retain_indefinitely_ccpa_1798_105_d_9',
    seq_v, NULL, next_hash_v
  )
  RETURNING id INTO genesis_id;

  prev_hash_v := next_hash_v;

  -- 2. Walk every other pre-existing row forward, oldest first.
  FOR r IN
    SELECT id, action, entity_type, entity_id, actor_type, actor_id, event_type, event_data, created_at
    FROM audit_log
    WHERE id <> genesis_id
    ORDER BY created_at ASC, id ASC
  LOOP
    seq_v := seq_v + 1;

    hash_input :=
      prev_hash_v                        || '|' ||
      seq_v::TEXT                        || '|' ||
      r.id::TEXT                         || '|' ||
      COALESCE(r.event_type, r.action)   || '|' ||
      COALESCE(r.entity_type, '')        || '|' ||
      COALESCE(r.entity_id::TEXT, '')    || '|' ||
      COALESCE(r.actor_type, '')         || '|' ||
      COALESCE(r.actor_id, '')           || '|' ||
      COALESCE(r.event_data::TEXT, '')   || '|' ||
      r.created_at::TEXT;

    next_hash_v := encode(digest(hash_input, 'sha256'), 'hex');

    UPDATE audit_log
    SET sequence_num = seq_v,
        prev_hash    = prev_hash_v,
        entry_hash   = next_hash_v
    WHERE id = r.id;

    prev_hash_v := next_hash_v;
    backfilled := backfilled + 1;
  END LOOP;

  RAISE NOTICE 'audit_log hash chain initialized: 1 genesis row + % pre-existing row(s) backfilled.', backfilled;
END $$;


-- ============================================================
-- STEP 5 — integrity constraints
-- Added after backfill so they validate against fully-populated data.
-- ============================================================

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_actor_type_check
    CHECK (actor_type IN ('human', 'ai_agent', 'system'));

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_privacy_category_check
    CHECK (privacy_category IN ('collection', 'processing', 'dissemination', 'invasion', 'unclassified'));
    -- Solove taxonomy top-level categories, per Rule 1. 'unclassified' is
    -- this migration's placeholder for rows nobody has categorized —
    -- see design note 7 above.

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_risk_level_check
    CHECK (risk_level IN ('unclassified', 'low', 'medium', 'high', 'critical'));

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_chain_genesis_check
    CHECK ( (sequence_num = 1 AND prev_hash IS NULL) OR (sequence_num > 1 AND prev_hash IS NOT NULL) );
    -- Only the genesis row may have a null prev_hash. Guards against a
    -- future bug (or manual edit) accidentally creating a second
    -- "start of chain" row.

-- Now that every row is guaranteed populated (steps 3-4), lock in NOT
-- NULL on the fields that must always have a real value going forward.
-- actor_id and everything below privacy/legal is intentionally left
-- nullable — see design notes above for which fields genuinely can't
-- always be known and why.
ALTER TABLE audit_log ALTER COLUMN event_type   SET NOT NULL;
ALTER TABLE audit_log ALTER COLUMN event_data   SET NOT NULL;
ALTER TABLE audit_log ALTER COLUMN actor_type   SET NOT NULL;
ALTER TABLE audit_log ALTER COLUMN sequence_num SET NOT NULL;
ALTER TABLE audit_log ALTER COLUMN entry_hash   SET NOT NULL;


-- ============================================================
-- STEP 6 — indexes
-- Targeted at the query patterns Rule 1 exists to support (compliance
-- review by risk/category, chain verification, cross-referencing a
-- workflow run, contact, or property) — not an index on every column.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_log_sequence_num ON audit_log(sequence_num);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor              ON audit_log(actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_privacy_category   ON audit_log(privacy_category);
CREATE INDEX IF NOT EXISTS idx_audit_log_risk_level         ON audit_log(risk_level) WHERE risk_level <> 'unclassified';
CREATE INDEX IF NOT EXISTS idx_audit_log_instance_id        ON audit_log(instance_id) WHERE instance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_contact_id         ON audit_log(contact_id)  WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_property_id        ON audit_log(property_id) WHERE property_id IS NOT NULL;


-- ============================================================
-- STEP 7 — trigger: compute the hash chain (and sync legacy/new field
-- pairs) automatically on every future INSERT, so no future writer has
-- to compute this by hand. This is the piece that keeps the chain
-- correct even if whoever builds the Latchel or shared-inbox connector
-- never reads this migration file.
-- ============================================================

CREATE OR REPLACE FUNCTION audit_log_compute_chain()
RETURNS TRIGGER AS $$
DECLARE
  prev_sequence_num BIGINT;
  prev_entry_hash   TEXT;
  hash_input        TEXT;
BEGIN
  -- Serialize audit_log inserts so the hash chain can never fork under
  -- concurrent writers. Scoped to this transaction only — released
  -- automatically on COMMIT or ROLLBACK. audit_log's write volume for a
  -- single property-management company is low enough that this has no
  -- meaningful performance impact; the correctness guarantee it buys
  -- (two simultaneous inserts can never both chain from the same
  -- "previous" row) is worth the brief serialization.
  PERFORM pg_advisory_xact_lock(hashtext('audit_log_hash_chain'));

  -- Scalar SELECT INTO (not a RECORD) so an empty table gives clean NULLs
  -- in both variables rather than depending on RECORD-specific behavior
  -- for a zero-row result.
  SELECT sequence_num, entry_hash
  INTO prev_sequence_num, prev_entry_hash
  FROM audit_log
  ORDER BY sequence_num DESC
  LIMIT 1;

  -- COALESCE to 0 so an empty table (should not happen after this
  -- migration's backfill, which always leaves at least the genesis row —
  -- kept only as a safety net, e.g. if audit_log is ever recreated fresh)
  -- still produces sequence_num = 1 with a null prev_hash, same as genesis.
  NEW.sequence_num := COALESCE(prev_sequence_num, 0) + 1;
  NEW.prev_hash    := prev_entry_hash;

  -- Backward-compatible field sync — see design note 5 above. Lets old
  -- writers (action/details) and new writers (event_type/event_data)
  -- both work without either one going null.
  IF NEW.event_type IS NULL THEN NEW.event_type := NEW.action; END IF;
  IF NEW.action     IS NULL THEN NEW.action     := NEW.event_type; END IF;
  IF NEW.event_data IS NULL THEN NEW.event_data := COALESCE(NEW.details, '{}'::jsonb); END IF;
  IF NEW.details    IS NULL THEN NEW.details    := NEW.event_data; END IF;

  -- Actor inference safety net — see design note 4 above. Only fires
  -- when a caller hasn't set actor_type/actor_id explicitly.
  IF NEW.actor_type IS NULL THEN
    NEW.actor_type := CASE WHEN NEW.performed_by IS NOT NULL THEN 'human' ELSE 'system' END;
  END IF;
  IF NEW.actor_id IS NULL AND NEW.performed_by IS NOT NULL THEN
    NEW.actor_id := NEW.performed_by::TEXT;
  END IF;

  hash_input :=
    COALESCE(NEW.prev_hash, 'GENESIS')  || '|' ||
    NEW.sequence_num::TEXT              || '|' ||
    NEW.id::TEXT                        || '|' ||
    COALESCE(NEW.event_type, '')        || '|' ||
    COALESCE(NEW.entity_type, '')       || '|' ||
    COALESCE(NEW.entity_id::TEXT, '')   || '|' ||
    COALESCE(NEW.actor_type, '')        || '|' ||
    COALESCE(NEW.actor_id, '')          || '|' ||
    COALESCE(NEW.event_data::TEXT, '')  || '|' ||
    NEW.created_at::TEXT;

  NEW.entry_hash := encode(digest(hash_input, 'sha256'), 'hex');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_compute_chain ON audit_log;
CREATE TRIGGER trg_audit_log_compute_chain
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_compute_chain();


-- ============================================================
-- ROLLBACK (run in reverse order to undo this migration)
-- ============================================================
--
-- DROP TRIGGER IF EXISTS trg_audit_log_compute_chain ON audit_log;
-- DROP FUNCTION IF EXISTS audit_log_compute_chain();
--
-- DROP INDEX IF EXISTS idx_audit_log_property_id;
-- DROP INDEX IF EXISTS idx_audit_log_contact_id;
-- DROP INDEX IF EXISTS idx_audit_log_instance_id;
-- DROP INDEX IF EXISTS idx_audit_log_risk_level;
-- DROP INDEX IF EXISTS idx_audit_log_privacy_category;
-- DROP INDEX IF EXISTS idx_audit_log_actor;
-- DROP INDEX IF EXISTS idx_audit_log_sequence_num;
--
-- ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_chain_genesis_check;
-- ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_risk_level_check;
-- ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_privacy_category_check;
-- ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_type_check;
--
-- Remove the genesis row this migration inserted. Worth a quick look
-- before deleting it — uncomment the SELECT first to confirm it's the
-- row you expect, then run the DELETE:
-- SELECT * FROM audit_log WHERE action = 'system.audit_chain_genesis';
-- DELETE FROM audit_log WHERE action = 'system.audit_chain_genesis';
--
-- ALTER TABLE audit_log
--   DROP COLUMN IF EXISTS entry_hash,
--   DROP COLUMN IF EXISTS prev_hash,
--   DROP COLUMN IF EXISTS sequence_num,
--   DROP COLUMN IF EXISTS property_id,
--   DROP COLUMN IF EXISTS contact_id,
--   DROP COLUMN IF EXISTS retention_policy,
--   DROP COLUMN IF EXISTS legal_basis,
--   DROP COLUMN IF EXISTS risk_level,
--   DROP COLUMN IF EXISTS regulation_tags,
--   DROP COLUMN IF EXISTS privacy_category,
--   DROP COLUMN IF EXISTS context_snapshot,
--   DROP COLUMN IF EXISTS event_data,
--   DROP COLUMN IF EXISTS event_summary,
--   DROP COLUMN IF EXISTS event_type,
--   DROP COLUMN IF EXISTS actor_version,
--   DROP COLUMN IF EXISTS actor_id,
--   DROP COLUMN IF EXISTS actor_type,
--   DROP COLUMN IF EXISTS action_id,
--   DROP COLUMN IF EXISTS decision_id,
--   DROP COLUMN IF EXISTS instance_id,
--   DROP COLUMN IF EXISTS company_id;
--
-- -- pgcrypto is left enabled on rollback — dropping extensions that
-- -- other things may come to depend on is riskier than leaving an
-- -- unused one enabled. Drop it by hand later only if you're sure
-- -- nothing else in the project uses it.
--
-- ============================================================
