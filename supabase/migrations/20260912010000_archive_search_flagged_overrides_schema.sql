-- ============================================================
-- Migration: 20260912010000_archive_search_flagged_overrides_schema
-- Created:   2026-09-12
-- Author:    Neo (database specialist)
--
-- Builds projects/hub/email-intake/archive-search-flagged-review-spec.md
-- Section 3.2 ("Proposed schema, for Neo to finalize") — the flagged-
-- conversation reinstatement mechanism for Archive Search. This is the
-- FIRST migration for this spec; none of its schema exists live yet.
--
-- This migration does NOT build the spec's Section 3.2 SQL as originally
-- drafted. It builds that SQL PLUS Mason's and Asimov's two required
-- additions, both real governance findings on the draft, both addressed
-- here rather than deferred:
--
-- 1. A REVOCATION PATH (Mason's finding, verbatim, 2026-09-12): "this
--    override doesn't just let one trained reviewer see one record — it
--    makes real Fair-Housing-flagged correspondence freely searchable, by
--    arbitrary query, to up to 8 people, indefinitely, with no way to
--    revoke it... recommend a minimal revocation path (even a manual one
--    — delete the override row, log the reversal) exist before or
--    shortly after this ships." Built as three new, all-nullable columns
--    (revoked_at/revoked_by/revocation_reason) on the same row, never a
--    DELETE — deleting would destroy the exact permanent record Section
--    3.1's whole design exists to preserve. A revoked override still
--    shows, forever, in one row: that it WAS granted (by whom, when,
--    why) AND that it was later revoked (by whom, when, why).
--    missive_message_intake_search_safe's EXISTS clause (Section 3
--    below) now also requires revoked_at IS NULL — a revoked override
--    stops making its conversation searchable again immediately, the
--    next time anyone queries that view.
-- 2. A GOVERNANCE.md RULE 4 DATA INVENTORY (Asimov's finding, verbatim,
--    2026-09-12): "This spec adds a brand-new table
--    (archive_search_flagged_overrides) that stores personal data — a
--    staff member's name (overridden_by) and free text about a Fair
--    Housing disposition (override_reason) — and has no equivalent
--    section. Rule 4 requires registering any new personal-data-storing
--    table (pii_fields, agents_with_access, privacy_category,
--    retention_policy, ccpa_exportable/deletable) before it ships." Now
--    written into the spec document itself
--    (archive-search-flagged-review-spec.md, new "Data Inventory
--    (GOVERNANCE.md Rule 4)" section, covering both the original override
--    fields and the new revocation fields) — not just this migration's
--    header comment, matching this schema's own convention that Rule 4
--    lives in the spec, and this file's header only cross-references it
--    (see 20260910000000_complaint_tracking_schema.sql's identical
--    split: spec has the analysis, migration cites it).
--
-- Where the spec's original Section 3.2 SQL is followed exactly, as
-- drafted: the CREATE TABLE's original 8 columns and their CHECK/UNIQUE
-- constraints, missive_message_intake_flagged_review_safe (unchanged),
-- and RLS posture (enabled, zero permissive policies, app-code-gated —
-- same default every table in this schema uses).
--
-- Governance status: this is a GOVERNANCE.md compliance build — it
-- stores personal data (a staff member's name doing the overriding and
-- the revoking; free text explaining both decisions) and changes what up
-- to 8 people can see of Fair-Housing-flagged correspondence. Per
-- CLAUDE.md's Governance & Compliance section and GOVERNANCE.md's
-- Integrity Rule 4 ("Neo gate is mandatory for every migration"), this
-- file is NOT applied by Neo — Peter applies every migration himself via
-- Supabase's SQL Editor, per this project's standing convention (no
-- CLI/DB URL in this environment) — and per Neo's own standing role,
-- Neo does not approve its own migrations; that is Peter's call, after
-- Asimov and Mason confirm this concrete SQL actually satisfies the two
-- findings quoted above (not just that a fix of some shape exists).
--
-- ============================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT BUILD
-- ============================================================
--   - The two routes (flagged-review-export, override) or any future
--     revocation route/UI. All Q's/Tron's future work, on top of this
--     schema, per the spec's Section 3.3 and Section 2's named Tron
--     follow-on. This migration only makes revocation possible to
--     RECORD — nothing writes revoked_at yet.
--   - Any change to `audit_log`. archive_search.flagged_conversation_
--     overridden and .flagged_review_export_generated (spec Section 4)
--     both already use values already legal under audit_log's real,
--     current CHECK constraints (20260815000000_audit_log_rule1_
--     compliance.sql), confirmed directly, not assumed — no schema
--     change needed for either. A third event this build now implies,
--     archive_search.flagged_override_revoked, needs no schema change
--     either, for the identical reason (actor_type: 'human',
--     entity_type: 'archive_search_flagged_override',
--     privacy_category: 'processing', risk_level: 'high' — all already
--     legal); writing that event is Q's future revocation route's job,
--     not this migration's.
--   - Any seed/grant row into team_member_tool_roles. No new tool value,
--     no new role value — this build reuses the existing 'admin' role
--     for tool='archive_search' exactly as the spec's Section 1 and
--     Section 3.3 already settled (Asimov/Mason's own review of the
--     original draft did not dispute this; only the two items above were
--     required). No ALTER TABLE team_member_tool_roles statement appears
--     anywhere in this file.
--   - Any change to missive_message_intake itself. Not one column,
--     constraint, or index on that table is touched by this migration —
--     every statement below either creates a brand-new table or
--     replaces a VIEW defined on top of that table. Section 3.1's core
--     rule ("never touch screening_result/_category/_tags/_version/
--     _completed_at on missive_message_intake. Ever.") is fully upheld.
--   - A trigger (or any other mechanism) preventing a revoked override
--     from ever being un-revoked (revoked_at cleared back to NULL) or
--     revoked twice. Considered and deliberately kept out, matching this
--     project's own repeated "no second approver, trust the admin
--     population, reuse existing discipline instead of inventing a new
--     bar" reasoning (spec Section 5, applied here to the reversal
--     action for the identical reason it was applied to the original
--     override action) — Mason's own finding explicitly sanctions "even
--     a manual" mechanism. The one piece of real defense-in-depth this
--     migration DOES add (the revocation-fields-together CHECK below)
--     is the same order of protection override_reason's own CHECK
--     already gives the original grant — a non-empty, attributed reason
--     enforced at the database level, not a workflow gate.
-- ============================================================
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No. archive_search_flagged_
--       overrides is a brand-new table — nothing existing reads or
--       writes it. The CREATE OR REPLACE VIEW on
--       missive_message_intake_search_safe is strictly additive to what
--       is visible: every row the current live view returns
--       (screening_result = 'clear') is still returned unconditionally;
--       the only change is that some additional, currently-invisible
--       'flagged_protected_class' rows may now also appear, and only
--       for a conversation with a currently-valid (non-revoked, not
--       superseded by a later re-screen), attributed, reasoned override
--       on file. No row visible today becomes invisible.
--   [x] Does this touch a table other code depends on?
--       missive_message_intake_search_safe, yes — this is the one view
--       every archive-search search/message route is required to query
--       (spec's Finding 1 discipline, carried from the original
--       technical spec). No route exists yet that queries it (confirmed:
--       no file under projects/hub/archive-search/ exists in this repo
--       as of this migration — the schema in 20260910030000 shipped
--       ahead of any application code, and still does), so the practical
--       risk today is zero; flagged so whoever builds the first search
--       route sees that this view's definition changed here, once,
--       before any code depends on its old shape.
--       missive_message_intake — NOT touched (see "WHAT THIS MIGRATION
--       DELIBERATELY DOES NOT BUILD" above).
--   [x] Additive or destructive? Fully additive — 1 new table (8
--       original columns + 3 new revocation columns), 1 new CHECK
--       constraint on that new table, 1 new index, RLS enabled with zero
--       permissive policies, 1 new view
--       (missive_message_intake_flagged_review_safe), 1 modified view
--       (missive_message_intake_search_safe — additive WHERE clause
--       only, same columns, same security_barrier setting). No column
--       dropped anywhere, no existing row updated, no existing
--       constraint narrowed.
--   [ ] Tested on a copy of the data first? No staging copy of Supabase
--       exists in this project — same standing caveat every migration
--       here has carried to date. Mitigated by: the new table starts
--       empty (nothing to corrupt); the two views are read-only
--       definitions with no data-migration step; the only statement
--       whose cost scales with missive_message_intake's 254,000+ rows is
--       the VIEW replacement itself, and CREATE OR REPLACE VIEW is a
--       metadata-only catalog operation in Postgres (it does not scan or
--       rewrite the underlying table) — none of this migration's
--       lock-avoidance concerns from 20260910030000/20260911000000
--       (ACCESS EXCLUSIVE table rewrites, CONCURRENTLY index builds)
--       apply here. Safe to run as one ordinary script in Supabase's SQL
--       Editor, unlike those two prior files.
--   [x] Governance: addresses both of Mason's and Asimov's required
--       findings on the spec's original draft, in full, as detailed in
--       this file's header above and in the spec's own updated "Data
--       Inventory (GOVERNANCE.md Rule 4)" section. This is Neo's build
--       of those findings, not Neo's independent sign-off that they are
--       satisfied — per Neo's own standing role, that confirmation is
--       Asimov's and Mason's to give, and applying this file is Peter's
--       call alone, same as every migration in this schema.
-- ============================================================


-- ============================================================
-- SECTION 1: archive_search_flagged_overrides (new table)
--
-- One row per human decision to reinstate a specific flagged screening
-- determination into search — AND, if it happens, the human decision to
-- later take that reinstatement back. See the spec's Section 3.1 for the
-- full design rationale (why this is a new, independent table rather
-- than a rewrite of screening_result in place) and Section 3.2's own
-- column-by-column comments (restated as COMMENT ON COLUMN statements
-- below, not just prose here).
--
-- APPEND-MOSTLY, NOT STRICTLY APPEND-ONLY — a deliberate, narrow
-- departure from archive_search_validation_sample's "never updated after
-- insert" discipline, scoped to exactly one permitted event: an admin
-- revoking their own (or another admin's) earlier override. A row is
-- inserted once, at grant time, with revoked_at/revoked_by/
-- revocation_reason all NULL; the ONLY UPDATE this table ever undergoes
-- is setting those three columns together, once, when a human revokes
-- it. Every other column (missive_conversation_id, mailbox_key, the
-- three overridden_screening_* snapshots, overridden_by, override_reason,
-- overridden_at) is fixed forever at insert and is never the target of
-- any UPDATE — a re-flag after a future re-screen still gets its own
-- brand-new row (Section 3.1, unchanged by this migration), never an
-- edit to this one. This is the simplest schema that satisfies Mason's
-- explicit design constraint ("a revoked override should still show it
-- WAS granted... AND that it was later revoked") without a second table
-- or a join: one row, two life stages, both permanently visible on it at
-- once.
--
-- No `updated_at`, despite CLAUDE.md's default id/created_at/updated_at
-- house style — deliberate, not an oversight, for the same reason
-- archive_search_validation_sample already omits it: the one event this
-- table can now undergo (revocation) is already timestamped by
-- revoked_at itself. A generic updated_at would always either be NULL
-- (never revoked) or exactly equal to revoked_at (revoked) — pure
-- duplication of a value the row already carries under a clearer name,
-- telling a reader nothing revoked_at doesn't. No separate `created_at`
-- either, for the same reason the original draft already chose:
-- overridden_at already serves that purpose under a name that says what
-- actually happened, not just when a row appeared.
-- ============================================================

CREATE TABLE IF NOT EXISTS archive_search_flagged_overrides (
  id                                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Compound identity, mirroring missive_message_intake_held_review_safe's
  -- own GROUP BY (missive_conversation_id, mailbox_key) — this schema's
  -- own precedent treats a conversation id as unique only within a
  -- mailbox, not globally, so this table follows the same key shape.
  missive_conversation_id             TEXT        NOT NULL,
  mailbox_key                         TEXT        NOT NULL,

  -- Snapshots of what the flagged determination actually was AT THE
  -- MOMENT of override — never a live join back to missive_message_intake
  -- for these three. This is what lets the override row stand on its own
  -- as a permanent record even after a future re-screen changes the live
  -- row's own screening_category/version/completed_at.
  overridden_screening_category       TEXT        NOT NULL,
  overridden_screening_version        TEXT        NOT NULL,
  overridden_screening_completed_at   TIMESTAMPTZ NOT NULL,

  -- The human decision itself (the grant).
  overridden_by                       TEXT        NOT NULL,
  override_reason                     TEXT        NOT NULL
    CHECK (length(trim(override_reason)) > 0),
  overridden_at                       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The human decision to reverse it (Mason's required revocation path,
  -- 2026-09-12). All three NULL until revoked — never touched at INSERT
  -- time. See the COMMENT ON COLUMN statements below for what each one
  -- means and the CHECK immediately after this table for how they're
  -- kept in lockstep.
  revoked_at                          TIMESTAMPTZ,
  revoked_by                          TEXT,
  revocation_reason                   TEXT,

  -- One override per exact determination — prevents an accidental double
  -- submit from creating two rows for the same flagged state, while still
  -- allowing a genuinely NEW override after a re-screen produces a new
  -- overridden_screening_completed_at value.
  UNIQUE (missive_conversation_id, mailbox_key, overridden_screening_completed_at),

  -- Keeps the three revocation columns in lockstep: either all three are
  -- NULL (never revoked) or all three are set together, with a non-empty
  -- reason — the same "required, attributed, non-empty reason" discipline
  -- override_reason's own CHECK above already enforces for the grant,
  -- applied symmetrically to the reversal. A revocation with no reason,
  -- or a revoked_at with no revoked_by, is not legal at the database
  -- level, not just discouraged in application code.
  CONSTRAINT archive_search_flagged_overrides_revocation_fields_together
    CHECK (
      (revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL)
      OR
      (revoked_at IS NOT NULL AND revoked_by IS NOT NULL
       AND revocation_reason IS NOT NULL
       AND length(trim(revocation_reason)) > 0)
    )
);

ALTER TABLE archive_search_flagged_overrides ENABLE ROW LEVEL SECURITY;
-- RLS enabled, zero permissive policies — same default every table in
-- this schema uses; every real reader/writer is the Hub's own
-- service-role connection, gated in application code by
-- requireArchiveSearchAdmin, not by RLS (identical reasoning to
-- archive_search_validation_sample and every other table this project
-- has added).

-- Recency listing for the future admin UI (spec Section 2) and for the
-- export route's own ordering. Serves both "most recent overrides" and
-- "most recent revocations" reasonably well even without a dedicated
-- revoked_at index: this table is expected to stay small by design
-- (overrides should be rare), and the UNIQUE constraint above already
-- gives a fast index for the one hot-path lookup (the search-safe view's
-- EXISTS clause, Section 3 below) — a second index keyed on revoked_at
-- would only ever filter a handful of rows at this table's expected
-- scale, so one is not added here, matching CLAUDE.md's "keep it as
-- simple as possible."
CREATE INDEX IF NOT EXISTS idx_archive_search_flagged_overrides_overridden_at
  ON archive_search_flagged_overrides (overridden_at DESC);

COMMENT ON TABLE archive_search_flagged_overrides IS
  'A human decision to reinstate one specific flagged screening determination into search, without ever changing screening_result/_category/_tags/_version/_completed_at on missive_message_intake itself — AND, if it happens, the human decision to later take that reinstatement back (revoked_at/revoked_by/revocation_reason, added 2026-09-12 per Mason''s required revocation-path finding). A row is inserted once, at grant time, with the revocation columns NULL; the only UPDATE this table ever permits is setting those three columns together, once. Every other column is fixed forever at insert — a re-flag after a future re-screen (a new screening_completed_at) gets a fresh override row of its own if an admin chooses to override it again, never an edit to this one. See missive_message_intake_search_safe''s own comment for how a row here (grant AND revocation state) is consumed at query time.';

COMMENT ON COLUMN archive_search_flagged_overrides.overridden_screening_completed_at IS
  'Snapshot of missive_message_intake.screening_completed_at at the moment of override — this is the fingerprint that ties this override to one specific screening determination, not to the conversation in general. missive_message_intake_search_safe only honors this row while the live row''s own screening_completed_at still matches it AND revoked_at IS NULL; a later re-screen (new mail, a fresh pass) changes that value on the live row and this override silently stops applying, without ever being edited or deleted — same for a later revocation.';

COMMENT ON COLUMN archive_search_flagged_overrides.override_reason IS
  'Required, non-empty (enforced by CHECK, not just application code — same defense-in-depth discipline as missive_message_intake_screening_category_required). Guidance for whoever writes this, following the identical precedent already set for maintenance_claims.protected_class_flag_overridden''s own reviewer_notes field: describe the disposition and why it is a false positive — do not quote or paraphrase the flagged correspondence itself into this field, which is not subject to the same redaction discipline as the message content it is stored alongside in an audit trail. The same restraint applies to revocation_reason below.';

COMMENT ON COLUMN archive_search_flagged_overrides.revoked_at IS
  'NULL until a human decides this specific override should no longer keep its conversation searchable — Mason''s required revocation path (finding, 2026-09-12): "this override... makes real Fair-Housing-flagged correspondence freely searchable, by arbitrary query, to up to 8 people, indefinitely, with no way to revoke it... recommend a minimal revocation path... exist before or shortly after this ships." Once set, missive_message_intake_search_safe''s EXISTS clause stops honoring this row on its very next query — the conversation reverts to excluded from search immediately, without this row (or any of the original grant''s columns) ever being deleted or edited. Enforced together with revoked_by/revocation_reason by this table''s own revocation-fields-together CHECK: never set alone.';

COMMENT ON COLUMN archive_search_flagged_overrides.revoked_by IS
  'Who revoked the override — same TEXT attribution convention as overridden_by (this table), reviewed_by (maintenance_claims), resolved_by (b2_photo_folders). NULL until revoked; once set, permanent — a revocation, like the original override, is always attributed to a specific human, never inferred or defaulted, and this column is never cleared or reassigned afterward.';

COMMENT ON COLUMN archive_search_flagged_overrides.revocation_reason IS
  'Why the override was revoked — required, non-empty once revoked (enforced by the revocation-fields-together CHECK below, same defense-in-depth discipline override_reason''s own CHECK already gives the original grant). Same restraint as override_reason: describe the reason for reversing the decision, do not quote or paraphrase the flagged correspondence itself into this field.';

COMMENT ON CONSTRAINT archive_search_flagged_overrides_revocation_fields_together
  ON archive_search_flagged_overrides IS
  'Keeps revoked_at/revoked_by/revocation_reason in lockstep: either all three are NULL (never revoked) or all three are set together with a non-empty reason. Prevents a partially-recorded revocation (e.g. a timestamp with no attributed reason) at the database level, not just in application code.';


-- ============================================================
-- SECTION 2: missive_message_intake_flagged_review_safe (new view)
--
-- Mirrors missive_message_intake_held_review_safe's own shape exactly
-- (one row per conversation, not per message; GROUP BY
-- (missive_conversation_id, mailbox_key); MAX() on the screening columns
-- because markConversationScreened() writes them identically across
-- every message row in a conversation in one call — confirmed directly
-- against the real screening-pass.js code, not assumed). Read-only,
-- admin-gated in application code (requireArchiveSearchAdmin) — no
-- security_barrier, same reasoning as the held-bucket view: this exists
-- specifically to surface flagged content to an already-trusted, narrow
-- population, not to hide it from a broad one.
--
-- Unlike the held-bucket view, this one is joined (in the export route's
-- application code, not here — same pattern held-review-export already
-- uses for its own audit_log join) against
-- archive_search_flagged_overrides so an admin reviewing the list can
-- see, for each conversation, whether it has already been overridden,
-- by whom, when, why — and, now, whether that override was later
-- revoked, by whom, when, why. This view itself carries no override or
-- revocation columns; both are look-ups Q's future export route performs
-- against archive_search_flagged_overrides directly.
-- ============================================================

CREATE OR REPLACE VIEW missive_message_intake_flagged_review_safe AS
SELECT
  missive_conversation_id,
  mailbox_key,
  MIN(delivered_at)                                        AS earliest_delivered_at,
  MAX(delivered_at)                                         AS latest_delivered_at,
  COUNT(*)                                                  AS message_count,
  (ARRAY_AGG(subject      ORDER BY delivered_at ASC))[1]    AS earliest_subject,
  (ARRAY_AGG(from_address ORDER BY delivered_at ASC))[1]    AS earliest_from_address,
  MAX(screening_category)                                   AS screening_category,
  MAX(screening_version)                                    AS screening_version,
  MAX(screening_completed_at)                               AS screening_completed_at
FROM missive_message_intake
WHERE screening_result = 'flagged_protected_class'
GROUP BY missive_conversation_id, mailbox_key;

COMMENT ON VIEW missive_message_intake_flagged_review_safe IS
  'archive-search-flagged-review-spec.md — every currently-flagged conversation, one row per conversation, admin-only, read-only, mirroring missive_message_intake_held_review_safe''s own shape exactly. Deliberately does NOT include body_text — unlike the export route built on top of it, which deliberately DOES fetch body_text separately for the reviewer to judge, the same precedent the validation-sample export already set (not the held-bucket export''s metadata-only shape — see the spec''s Section 2 for why the two differ). Joined in application code against archive_search_flagged_overrides to show existing override AND revocation status (revoked_at/revoked_by/revocation_reason, added 2026-09-12); this view does not know about either itself.';


-- ============================================================
-- SECTION 3: missive_message_intake_search_safe (modified view)
--
-- One additive change to the WHERE clause only, on top of this view's
-- one and only prior definition (20260910030000, unchanged since) —
-- every column and security_barrier = true are unchanged. A currently-
-- flagged row is now visible through this view if, and only if, a
-- currently-valid, NON-REVOKED override exists for the EXACT
-- determination it currently carries (spec Section 3.1; revocation
-- clause added here per Mason's required finding).
-- ============================================================

CREATE OR REPLACE VIEW missive_message_intake_search_safe
WITH (security_barrier = true) AS
SELECT *
FROM missive_message_intake m
WHERE m.screening_result = 'clear'
   OR EXISTS (
     SELECT 1
     FROM archive_search_flagged_overrides o
     WHERE o.missive_conversation_id           = m.missive_conversation_id
       AND o.mailbox_key                       = m.mailbox_key
       AND o.overridden_screening_completed_at = m.screening_completed_at
       AND o.revoked_at IS NULL
   );

-- All three predicates use only leakproof "=" / "IS NULL" comparisons,
-- and EXISTS against a plain equality-correlated subquery composes the
-- same way the original screening_result = 'clear' predicate already did
-- with the search_document @@ ... predicate (see the original spec's
-- "The Search Mechanism") — security_barrier's guarantee is unaffected by
-- adding this clause or by adding the revoked_at IS NULL condition to it.
-- One real, honest performance note, not glossed over: the planner now
-- has one more correlated EXISTS check per row that isn't already
-- screening_result = 'clear', evaluated against a table expected to stay
-- small (overrides should be rare, by design) and already indexed for
-- this exact lookup by the table's own UNIQUE constraint — a real but
-- minor cost, not benchmarked here, and not expected to matter at this
-- archive's scale, but not asserted as free either. Adding revoked_at IS
-- NULL to the EXISTS adds no meaningful cost beyond what was already
-- there: the UNIQUE constraint guarantees at most one matching row for
-- the three equality columns, so this is one extra NULL check on a
-- single already-located row, not an additional scan.

COMMENT ON VIEW missive_message_intake_search_safe IS
  'The ONLY view every archive-search search/message route may query — never missive_message_intake directly, with the one named exception of screening-pass.js. Extended, archive-search-flagged-review-spec.md, to also surface a flagged row when a currently-valid, NON-REVOKED entry exists in archive_search_flagged_overrides for that row''s exact screening_completed_at — screening_result itself is NEVER rewritten to make this happen. A revoked override (revoked_at IS NOT NULL) stops satisfying this EXISTS clause immediately, on the very next query — no separate cleanup step, no cache, no delay. security_barrier = true unchanged from the original migration; see that migration''s own comment for why this view needs it.';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP VIEW IF EXISTS missive_message_intake_flagged_review_safe;
--
-- -- Reverts missive_message_intake_search_safe to its ORIGINAL,
-- -- override-unaware definition (20260910030000, the only prior
-- -- definition this view has ever had). Safe at any time — this only
-- -- changes which rows the view returns, never any stored data.
-- CREATE OR REPLACE VIEW missive_message_intake_search_safe
-- WITH (security_barrier = true) AS
-- SELECT * FROM missive_message_intake WHERE screening_result = 'clear';
--
-- DROP INDEX IF EXISTS idx_archive_search_flagged_overrides_overridden_at;
-- -- Confirm no real override (or revocation) has been granted yet before
-- -- dropping this table for real — check row count first. If any
-- -- override exists, this table is the only durable record that a human
-- -- ever restored that specific conversation to search, AND — if it was
-- -- later reversed — the only durable record that a human later revoked
-- -- that reinstatement, by whom, when, why. Dropping the table loses both
-- -- facts permanently (audit_log's own archive_search.
-- -- flagged_conversation_overridden and, once Q's future revocation
-- -- route ships, archive_search.flagged_override_revoked events are the
-- -- one remaining record if this table is ever dropped after real use).
-- DROP TABLE IF EXISTS archive_search_flagged_overrides;
--
-- ============================================================
