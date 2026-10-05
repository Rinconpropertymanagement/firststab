-- ============================================================
-- Migration: 20260816000000_property_brain_claims_phase1
-- Created:   2026-08-16
-- Author:    Neo (database specialist)
--
-- Phase 1 of the Property Brain platform architecture
-- (projects/hub/PROPERTY-BRAIN-ARCHITECTURE.md, "Section 9 — Size and
-- Phased Build Plan", Phase 1). Cleared by Asimov's governance review.
-- Schema only — no email connection, no AI extraction pipeline, no
-- change to anything already built.
--
-- Builds exactly what Phase 1 calls for, no more:
--   1. claim_type_registry  -- fail-closed vocabulary registry
--      (architecture doc Section 1.4), seeded with the four
--      already-proven maintenance claim types.
--   2. claims                -- the generalized version of
--      maintenance_claims (architecture doc Section 1.2), with a new
--      `domain` column so future domains are new rows in this table,
--      not new tables.
--   3. claims_decision_safe  -- same exclusion pattern as
--      maintenance_claims_decision_safe (flagged/rejected content
--      never appears), generalized across domains.
--
-- maintenance_claims and maintenance_requests are NOT touched by this
-- migration. Nothing here changes projects/hub/maintenance-history/
-- router.js or its dashboard — the existing tool keeps working exactly
-- as it does today, reading and writing maintenance_claims as it
-- always has. This migration is purely additive, new structure
-- alongside what exists, not a migration of existing data — no rows
-- are copied from maintenance_claims into claims by this file.
--
-- ============================================================
-- WHY THIS STAYS SMALL — READ BEFORE ADDING ANYTHING
-- ============================================================
-- The architecture doc is explicit that Phase 1's "only goal is to
-- stand up the shared store and prove the registry mechanism" — not to
-- build the pipeline that will eventually populate it from email, and
-- not to build every piece of machinery the original Property Brain
-- thesis describes. Two tables and one view. Nothing here talks to
-- Gmail, Anthropic's API, or Latchel. Q builds the reading/extraction
-- pipeline in Phase 2, against this schema, once Peter approves that
-- phase separately.
--
-- ============================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT BUILD
-- ============================================================
--   - claim_heads / automatic conflict detection (architecture doc
--     Section 1.3). Every claim in this system is a fact about
--     something that happened — append-only by nature — not a mutable
--     property being re-asserted over time, so there is no "current
--     accepted answer" to point a head at and no concurrent-write race
--     to protect. Documented trigger to revisit: the day a domain
--     produces two claims about the SAME fact from DIFFERENT sources
--     that can disagree (the doc's own example: an AppFolio-synced
--     lease-end-date and an email-extracted move-out date, both about
--     the same lease, both claiming to be current).
--   - The `entities` abstraction (Section 1.5). Every domain in scope
--     right now — maintenance (existing) and the email-derived claims
--     Phase 2 will add — needs exactly the two subject columns this
--     migration builds (property_id, maintenance_request_id).
--     Documented trigger: the day a domain needs claims to point at
--     something neither column can express (a lease_id, a tenant_id).
--   - `thread_routing_decisions` (Section 2.4). That table belongs to
--     Phase 2 (the understanding pipeline) — it records a thread's
--     routing decision, and nothing produces routing decisions yet.
--   - The maintenance_claims -> claims compatibility-view migration
--     (Section 1.6). Deferred until a second domain is actually live
--     and writing to `claims` (Phase 3), per the doc's own reasoning:
--     building this before a second domain exists to prove the shared
--     shape holds would be building ahead of a proven need.
--   - Any copying of existing maintenance_claims rows into `claims`.
--     Explicitly out of scope for this phase — this is new structure
--     standing up alongside the existing table, not a data migration.
--     (The architecture doc mentions this as something Peter could
--     smoke-test manually later, by hand, if useful — not something
--     this migration does.)
--   - A trigger enforcing claim_type_registry.is_active at insert time
--     on `claims`. See "FAIL-CLOSED REGISTRY ENFORCEMENT" below for
--     what IS enforced (a foreign key) and why the is_active flag is
--     deliberately left to application-code enforcement for now — the
--     same "don't invent new trigger machinery ahead of a proven need"
--     discipline already applied twice in this schema (see
--     20260815010000_maintenance_history_schema.sql's own "what this
--     migration deliberately does not build" section, re: an
--     audit_log-writing trigger).
--   - Any RLS policy grants. RLS is enabled on both new tables with
--     zero permissive policies — matches every table in this schema.
--     A tool gets explicit read/write access only when Tron/Q actually
--     build something that needs it (Phase 2+).
--
-- ============================================================
-- THE SOURCE_REFERENCE CONVENTION — READ THIS BEFORE ANY
-- EMAIL-SOURCED CLAIM IS EVER INSERTED (Asimov's governance review,
-- applied now even though no email pipeline exists yet)
-- ============================================================
-- claims.source_reference is a direct carryover of
-- maintenance_claims.source_reference's existing discipline: "exactly
-- which record, never a summary with the source stripped off." That
-- discipline gets a sharper, explicit rule the moment a source can be
-- an email thread instead of a Latchel job/invoice/file, because an
-- email thread has a subject line and a body — content a maintenance
-- job record never had in the first place.
--
-- THE RULE: for any claim whose source_type is email-derived (no such
-- source_type is registered by this migration — see the CHECK
-- constraint on claims.source_type below, and the note on widening it
-- when Phase 2 adds one), source_reference MAY ONLY contain a
-- STRUCTURAL pointer to where the fact came from:
--   - a Gmail thread ID
--   - a Gmail message ID
--   - a timestamp
--   - a sender email address
--   ...or some combination of the above (e.g. "gmail thread
--   18d4f2a1b2c3d4e5, message 18d4f2a1b2c3d4e6, from
--   tenant@example.com, 2026-08-14T09:12:00Z").
--
-- source_reference MUST NEVER contain a subject line, a body excerpt,
-- a quoted sentence, or any other snippet of the email's actual
-- content — structural "where," never substantive "what." The "what"
-- belongs in claim_text, already passed through the content check
-- (content-check.js) before insert, same as today. source_reference
-- is not currently subject to that same content check, which is
-- exactly why this rule matters: a subject line or body snippet
-- landing in source_reference would be personal correspondence content
-- sitting in a column nobody scans for protected-class terms or PII
-- before it's stored, silently working around the exact protection
-- claim_text already has.
--
-- WHY THIS IS A COMMENT-ONLY CONVENTION, NOT A CHECK CONSTRAINT: I
-- considered a regex/pattern CHECK on this column and rejected it. A
-- structural pointer is legitimately free-form and can be long, can
-- contain spaces, and can contain an email address (itself containing
-- an "@" and a domain) — there is no reliable pattern that
-- distinguishes "18d4f2a1b2c3d4e5, message ..., from
-- tenant@example.com" (valid) from "Re: mold in unit 4B, tenant says
-- it's getting worse" (invalid) using string shape alone. A CHECK
-- constraint that can't actually tell the two apart would provide
-- false confidence — worse than no constraint, because it would look
-- like enforcement without being enforcement. The real enforcement
-- point is the extraction pipeline itself (Phase 2, Q's build): the
-- prompt/code that populates source_reference must be built to only
-- ever construct it from structural metadata (thread ID, message ID,
-- timestamp, sender), never from the subject or body fields it also
-- has in hand. Flagging this here, before that pipeline is built, is
-- the whole point of doing it now — Asimov's review specifically
-- called out documenting this ahead of the gap being discovered after
-- the fact.
--
-- This same rule is repeated on the column itself via COMMENT ON
-- COLUMN below, so it surfaces in any schema introspection (\d+
-- claims, information_schema, a future ERD tool) — not just to someone
-- reading this migration file.
--
-- ============================================================
-- FAIL-CLOSED REGISTRY ENFORCEMENT — claim_type_registry
-- ============================================================
-- The architecture doc (Section 1.4) asks for a "fail-closed"
-- registry: "an unregistered predicate is rejected, not silently
-- accepted." This migration enforces that at the database level, not
-- just as an application-code convention that a future pipeline could
-- forget to check: `claims` has a composite FOREIGN KEY on
-- (domain, claim_type) referencing claim_type_registry(domain,
-- claim_type). An INSERT attempting an unregistered (domain,
-- claim_type) pair fails outright with a foreign-key violation — true
-- fail-closed, enforced independent of whether the calling code
-- remembered to check first.
--
-- KNOWN, DELIBERATE LIMITATION: a foreign key checks that the row
-- EXISTS in claim_type_registry — it does not, and structurally
-- cannot, also require is_active = TRUE. Postgres foreign keys
-- validate referenced-row existence only, not arbitrary column values
-- on that row. Practical effect: if a claim_type is later deactivated
-- (is_active set to FALSE, e.g. because it turned out to be a mistake
-- in a new domain's vocabulary) but has already been used by real
-- claims, the FK correctly continues to allow reads/joins against
-- those historical rows — but it will NOT by itself block a new insert
-- of a fresh claim still citing the deactivated type. That check is
-- the extraction pipeline's responsibility (Phase 2+, Q's code): look
-- up is_active before inserting, same as it already must look up the
-- registry to build a valid claim in the first place. This is the same
-- split already used throughout this schema — the database enforces
-- referential integrity, application code enforces business rules on
-- top of it. If deactivation-blocking ever needs to be airtight at the
-- database layer too, a BEFORE INSERT trigger checking is_active is
-- the next step; not built now, no proven need for it yet.
--
-- ============================================================
-- DATA INVENTORY (GOVERNANCE.md Rule 4 — required for every new table
-- storing personal data)
-- ============================================================
-- As of this migration, nothing writes to or reads from either new
-- table — no ingestion pipeline exists yet (that's Phase 2). This
-- entry documents the access this schema is DESIGNED for, per the
-- architecture doc, so Rule 4 is satisfied ahead of any tool actually
-- touching these tables, not discovered as a gap once Phase 2 ships.
--
--   pii_fields:          claims.claim_text (the highest-PII-density
--                         field — same role claim_text already plays
--                         on maintenance_claims today, now shared
--                         across domains instead of siloed per-table).
--                         claims.reviewer_notes (PII-adjacent, same
--                         caveat used everywhere else in this schema).
--                         claims.flagged_category (could indirectly
--                         reveal what kind of sensitive topic was
--                         discussed, without containing the topic text
--                         itself). claim_type_registry has NO PII
--                         fields at all — domain/claim_type/description
--                         are taxonomy metadata, not personal data.
--   agents_with_access:  Claude (existing ANTHROPIC_API_KEY), once a
--                         Phase 2+ extraction pipeline exists, for
--                         claim extraction and protected-class
--                         flagging; the scheduled ingestion process
--                         (system, service-role key), once one exists;
--                         Hub users holding 'reviewer' or 'admin' for
--                         the relevant tool, once a tool reads this
--                         table (via team_member_tool_roles — unchanged
--                         by this migration, no new tool/role value
--                         added here since nothing consumes claims yet).
--   privacy_category:    Same as maintenance_claims today for
--                         domain='maintenance' rows (may include
--                         health-adjacent free text). Personal
--                         correspondence, distilled, for any future
--                         email-sourced domain — more sensitive than
--                         most existing tables in this schema, per the
--                         architecture doc Section 4.
--   retention_policy:    PLACEHOLDER — pending Mason, same
--                         explicitly-allowed placeholder pattern used
--                         on every comparable table in this schema.
--   ccpa_exportable:     TRUE.
--   ccpa_deletable:      TRUE, via targeted redaction of claim_text and
--                         reviewer_notes to the literal string
--                         "[REDACTED]" — identical convention to
--                         maintenance_claims. domain, claim_type,
--                         claim_date, source_reference, and
--                         correction_reason_code are preserved for
--                         audit continuity. claim_type_registry has no
--                         personal content to redact.
--
-- RLS: enabled, no permissive policies at creation, on both new
-- tables — matches every table in this schema.
-- ============================================================


-- ============================================================
-- TABLE: claim_type_registry
-- What it stores: the fail-closed vocabulary of (domain, claim_type)
-- pairs a claim is allowed to use. Seeded below with exactly the four
-- already-proven maintenance types — nothing invented, just made
-- explicit and enforced (architecture doc Section 1.4).
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS claim_type_registry (
  domain        TEXT        NOT NULL,
  claim_type    TEXT        NOT NULL,
  description   TEXT        NOT NULL,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,

  -- Beyond the architecture doc's literal shape: created_at/updated_at,
  -- matching this schema's own "every table gets these two columns"
  -- standard. The doc's illustrative shape didn't list them (it's a
  -- reference/vocabulary table, not a claims record), but they're
  -- cheap, standard, and useful for governance review to see when a
  -- claim type was registered or last changed.
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (domain, claim_type)
);

ALTER TABLE claim_type_registry ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_claim_type_registry_updated_at ON claim_type_registry;
CREATE TRIGGER trg_claim_type_registry_updated_at
  BEFORE UPDATE ON claim_type_registry
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE claim_type_registry IS
  'Fail-closed vocabulary registry (Property Brain architecture doc, Section 1.4). A (domain, claim_type) pair must exist here, with is_active = TRUE, before any extraction pipeline should insert a claim using it. Enforced structurally on claims via a composite foreign key (existence only — is_active is an application-code check, see migration 20260816000000''s "FAIL-CLOSED REGISTRY ENFORCEMENT" note).';

COMMENT ON COLUMN claim_type_registry.is_active IS
  'Set FALSE to retire a claim_type without deleting it (historical claims that used it remain valid and queryable). NOT enforced by the foreign key on claims — a Postgres FK checks row existence only, not column values. The extraction pipeline that populates claims must check is_active itself before inserting.';

-- Seed: exactly the four already-proven maintenance claim types,
-- unchanged from maintenance_claims.claim_type's existing CHECK
-- constraint (20260815010000_maintenance_history_schema.sql). This
-- table does not yet govern maintenance_claims itself (that table is
-- untouched by this migration) — it governs the new `claims` table's
-- domain='maintenance' rows, using the exact same vocabulary so the
-- two tables stay conceptually aligned ahead of the Phase 3
-- compatibility-view migration.
INSERT INTO claim_type_registry (domain, claim_type, description) VALUES
  ('maintenance', 'event',      'Something that happened on a maintenance ticket — a status change, a visit, a note logged in the job''s history.'),
  ('maintenance', 'decision',   'A decision someone made about the ticket and, where known, why (e.g. which vendor was assigned, or a repair-vs-replace call).'),
  ('maintenance', 'outcome',    'Whether the work actually resolved the problem, graded on the 1-5 outcome ladder (outcome_level): completed -> function restored -> resident confirmed -> no recurrence in window -> verified by later inspection.'),
  ('maintenance', 'recurrence', 'A link to another maintenance ticket this one is a repeat of, or is repeated by.')
ON CONFLICT (domain, claim_type) DO NOTHING;


-- ============================================================
-- TABLE: claims
-- What it stores: one row per extracted fact, generalized across
-- domains (architecture doc Section 1.2) — the same shape
-- maintenance_claims already proved out, plus a `domain` column and a
-- `correction_reason_code` column (Section 6, the feedback loop).
-- domain='maintenance' rows here are conceptually the same kind of
-- fact maintenance_claims already stores; this table does not replace
-- maintenance_claims and nothing copies data between them yet (Section
-- 1.6 — deferred to Phase 3).
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS claims (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Registered, not free-form — see "FAIL-CLOSED REGISTRY ENFORCEMENT"
  -- above. The composite FK below on (domain, claim_type) is what
  -- actually enforces this; domain has no separate CHECK constraint of
  -- its own because the FK already rejects any domain that has no
  -- registered claim_type row.
  domain                   TEXT        NOT NULL,
  claim_type               TEXT        NOT NULL,

  -- Subject — which property/ticket this claim is about. Same two
  -- columns maintenance_claims (via maintenance_request_id) and the
  -- prior email-context design (via property_id + maintenance_request_id)
  -- already used (architecture doc Section 1.5). RESTRICT, not CASCADE
  -- or SET NULL, on both: properties and maintenance_requests rows are
  -- never expected to be hard-deleted in this schema (system/
  -- AppFolio-owned), and if one somehow were, silently losing a
  -- recorded fact via a cascading delete/clear would be exactly the
  -- kind of missed-data failure this system is graded against. RESTRICT
  -- forces that conflict to be resolved explicitly instead — same
  -- reasoning already used for property_insurance.property_id
  -- (20260720000004_insurance_compliance.sql) and
  -- maintenance_claims.related_maintenance_request_id
  -- (20260815010000_maintenance_history_schema.sql).
  property_id               UUID       REFERENCES properties(id) ON DELETE RESTRICT,
  maintenance_request_id    UUID       REFERENCES maintenance_requests(id) ON DELETE RESTRICT,
  -- Unchanged from maintenance_claims: populated only for
  -- claim_type = 'recurrence'. No ON DELETE clause (defaults to
  -- RESTRICT), same reasoning as above.
  related_maintenance_request_id UUID  REFERENCES maintenance_requests(id),

  claim_text                TEXT       NOT NULL,  -- the fact itself, in plain English
  claim_date                 DATE,                 -- nullable — "unknown" is a legitimate,
                                                     -- expected value here, same discipline
                                                     -- maintenance_claims already uses

  -- Populated only for claim_type = 'outcome' — mirrors
  -- maintenance_claims' own 1-5 ladder unchanged. Enforced below.
  -- Not every domain will have an outcome ladder; this column simply
  -- sits unused (NULL) on claim types that don't, same as it already
  -- does on maintenance's own event/decision/recurrence rows today.
  outcome_level              SMALLINT   CHECK (outcome_level IS NULL OR outcome_level BETWEEN 1 AND 5),

  source_type                TEXT       NOT NULL CHECK (source_type IN (
                                'latchel_job_field', 'latchel_state_history',
                                'latchel_invoice_field', 'latchel_job_file'
                              )),
  -- Exactly which record — see "THE SOURCE_REFERENCE CONVENTION" above
  -- for the rule that governs this field once an email-derived
  -- source_type is added in Phase 2. The CHECK constraint above only
  -- lists today's four Latchel-sourced values (unchanged from
  -- maintenance_claims) — no email source_type exists yet in this
  -- schema. When Phase 2 adds one (e.g. 'gmail_thread'), widen this
  -- CHECK using the same DROP-then-ADD pattern already used twice in
  -- this schema (team_member_tool_roles' tool/role CHECKs) — Postgres
  -- has no ALTER CONSTRAINT for widening a CHECK in place.
  source_reference            TEXT       NOT NULL,

  -- NULL for claims copied straight from a structured API field
  -- (nothing to be uncertain about); set only for AI-derived claims.
  confidence                  NUMERIC(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  extracted_by                 TEXT       NOT NULL,

  -- The Content Check outcome — same discipline as maintenance_claims.
  -- flagged_category required whenever flagged_protected_class is
  -- TRUE, enforced below.
  flagged_protected_class      BOOLEAN    NOT NULL DEFAULT FALSE,
  flagged_category              TEXT,      -- free text, not a rigid enum — Mason should be
                                            -- able to refine categories without a migration

  -- Deliberately NO 'auto_indexed'/'auto_confirmed' option — nothing
  -- here ever promotes a claim past a human based on a confidence
  -- score, same as maintenance_claims.
  review_status                 TEXT       NOT NULL DEFAULT 'unreviewed'
                                  CHECK (review_status IN ('unreviewed', 'confirmed', 'corrected', 'rejected')),
  reviewed_by                    TEXT,
  reviewed_at                    TIMESTAMPTZ,
  reviewer_notes                  TEXT,

  -- NEW vs. maintenance_claims (architecture doc Section 6 — the
  -- feedback loop). Required whenever review_status moves to
  -- 'corrected' or 'rejected' (enforced below). Controlled vocabulary,
  -- generalized from the original 10-ticket test's grading categories.
  correction_reason_code           TEXT     CHECK (correction_reason_code IS NULL OR correction_reason_code IN (
                                     'WRONG_SOURCE', 'HALLUCINATED_DETAIL', 'WRONG_SUBJECT',
                                     'WRONG_CLAIM_TYPE', 'MISSED_NUANCE', 'STALE_ON_ARRIVAL',
                                     'PROTECTED_CLASS_MISS', 'OTHER'
                                   )),

  created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Fail-closed registry enforcement — see note above.
  CONSTRAINT claims_domain_claim_type_registered
    FOREIGN KEY (domain, claim_type) REFERENCES claim_type_registry(domain, claim_type),

  -- Every claim must be about something. Beyond the architecture doc's
  -- literal column list, but directly implied by Section 1.5's own
  -- reasoning ("every domain concretely in scope right now... needs
  -- exactly the two subject columns"): a claim with neither property_id
  -- nor maintenance_request_id set is a fact about nothing, which
  -- nothing in this design or the source thesis calls for. Safe to add
  -- because property_id/maintenance_request_id are RESTRICT, not
  -- CASCADE/SET NULL — this constraint can never be violated by a
  -- downstream delete, only by a bad INSERT, which is exactly what a
  -- CHECK constraint should catch.
  CONSTRAINT claims_has_a_subject
    CHECK (property_id IS NOT NULL OR maintenance_request_id IS NOT NULL),

  -- Enforcement #1 (carried over from maintenance_claims): an
  -- outcome_level value only makes sense on an 'outcome' claim.
  CONSTRAINT claims_outcome_level_scope
    CHECK (claim_type = 'outcome' OR outcome_level IS NULL),

  -- Enforcement #2 (carried over): a recurrence link only makes sense
  -- on a 'recurrence' claim.
  CONSTRAINT claims_recurrence_link_scope
    CHECK (claim_type = 'recurrence' OR related_maintenance_request_id IS NULL),

  -- Enforcement #3 (carried over): GOVERNANCE.md Rule 9 requires the
  -- exclusion reason to be recorded, not just the fact of exclusion.
  CONSTRAINT claims_flag_requires_category
    CHECK (flagged_protected_class = FALSE OR flagged_category IS NOT NULL),

  -- Enforcement #4 (new — architecture doc Section 6): a correction or
  -- rejection must record why, so the monthly feedback-loop query has
  -- something real to aggregate on.
  CONSTRAINT claims_correction_reason_required
    CHECK (review_status NOT IN ('corrected', 'rejected') OR correction_reason_code IS NOT NULL)
);

-- RLS: enabled, no permissive policies — all access denied until a
-- tool explicitly grants it via a policy scoped to authenticated
-- users. Matches every table in this schema.
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;

-- Per-ticket query, same shape as maintenance_claims' primary index
-- today — the only real consumer of this table right now is still the
-- maintenance domain.
CREATE INDEX IF NOT EXISTS idx_claims_maintenance_request
  ON claims(maintenance_request_id, claim_type)
  WHERE maintenance_request_id IS NOT NULL;

-- Cross-domain, per-property query — "everything we know about this
-- property, across every domain" (architecture doc Section 1.2), the
-- specific query this generalized table exists to make possible as one
-- lookup instead of a UNION across domain-specific tables.
CREATE INDEX IF NOT EXISTS idx_claims_property
  ON claims(property_id)
  WHERE property_id IS NOT NULL;

-- Domain-scoped browsing / a domain's own review queue.
CREATE INDEX IF NOT EXISTS idx_claims_domain_type
  ON claims(domain, claim_type);

-- "Needs privacy review" queue — visible only to reviewer/admin roles,
-- same as maintenance_claims today.
CREATE INDEX IF NOT EXISTS idx_claims_flagged
  ON claims(flagged_protected_class)
  WHERE flagged_protected_class = TRUE;

-- Unreviewed-claims queue — "every claim still needing a human look."
CREATE INDEX IF NOT EXISTS idx_claims_unreviewed
  ON claims(review_status)
  WHERE review_status = 'unreviewed';

-- Recurrence lookups: "what else links to this ticket."
CREATE INDEX IF NOT EXISTS idx_claims_related_request
  ON claims(related_maintenance_request_id)
  WHERE related_maintenance_request_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_claims_updated_at ON claims;
CREATE TRIGGER trg_claims_updated_at
  BEFORE UPDATE ON claims
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN claims.source_reference IS
  'STRUCTURAL POINTER ONLY. For today''s Latchel-sourced rows: exactly which record (e.g. "Latchel job 6903, state history entry 2026-07-30"). For any future email-derived row: a thread ID, message ID, timestamp, and/or sender address ONLY — NEVER a subject line, body excerpt, or quoted content. See migration 20260816000000''s "THE SOURCE_REFERENCE CONVENTION" note for the full rule and why this is enforced by convention/pipeline-code discipline rather than a CHECK constraint.';

COMMENT ON COLUMN claims.domain IS
  'Which domain this claim belongs to (''maintenance'' today; ''lease_renewal'', ''tenant_issue'', etc. as those get built). Not independently CHECK-constrained — validity is enforced by the composite foreign key on (domain, claim_type) against claim_type_registry, which requires the pairing to be registered.';

COMMENT ON COLUMN claims.correction_reason_code IS
  'Required whenever review_status is set to ''corrected'' or ''rejected'' (enforced by claims_correction_reason_required). Feeds the monthly feedback-loop query (architecture doc Section 6) grouping corrections by domain + claim_type + source_type + correction_reason_code + extracted_by to spot quality drift. A PROTECTED_CLASS_MISS value should be escalated to Mason immediately, not held for the monthly rollup.';


-- ============================================================
-- VIEW: claims_decision_safe
-- Same exclusion pattern as maintenance_claims_decision_safe
-- (flagged/rejected content never appears), generalized across every
-- domain. Any future feature that summarizes, searches, or reasons
-- across claims — a portfolio-wide dashboard, a per-domain review
-- queue, anything — reads from this view, never the base table
-- directly.
--
-- Note on RLS and views (carried over verbatim from
-- maintenance_claims_decision_safe): Postgres views run with the
-- privileges of the view's owner by default, not the querying role —
-- RLS enabled on the base table does not automatically extend to a
-- view over it. In practice this is a non-issue for how this schema is
-- actually used today: every writer/reader in this codebase connects
-- with the Supabase service-role key, which bypasses RLS entirely
-- regardless. Flagged so it's a known fact, not a surprise, if the Hub
-- UI is ever changed to query Supabase directly under a user's own
-- session instead of through the backend.
-- ============================================================

CREATE OR REPLACE VIEW claims_decision_safe AS
SELECT *
FROM claims
WHERE flagged_protected_class = FALSE
  AND review_status != 'rejected';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP VIEW IF EXISTS claims_decision_safe;
--
-- DROP TRIGGER IF EXISTS trg_claims_updated_at ON claims;
--
-- DROP INDEX IF EXISTS idx_claims_related_request;
-- DROP INDEX IF EXISTS idx_claims_unreviewed;
-- DROP INDEX IF EXISTS idx_claims_flagged;
-- DROP INDEX IF EXISTS idx_claims_domain_type;
-- DROP INDEX IF EXISTS idx_claims_property;
-- DROP INDEX IF EXISTS idx_claims_maintenance_request;
--
-- DROP TABLE IF EXISTS claims;
--
-- DROP TRIGGER IF EXISTS trg_claim_type_registry_updated_at ON claim_type_registry;
--
-- DROP TABLE IF EXISTS claim_type_registry;
--
-- -- Safe to roll back in full as long as nothing has been built on top
-- -- of these tables yet (true as of this migration — Phase 1 has no Q,
-- -- no Tron, nothing consumes `claims` or `claim_type_registry`). If a
-- -- later phase has since inserted real claims, rolling back drops
-- -- them — confirm nothing depends on this data first.
--
-- ============================================================
