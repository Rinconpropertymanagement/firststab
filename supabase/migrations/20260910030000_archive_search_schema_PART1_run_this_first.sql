-- ============================================================
-- Migration: 20260910030000_archive_search_schema
-- Created:   2026-09-10
-- Author:    Neo (database specialist)
--
-- Schema for Archive Search (projects/hub/email-intake/archive-search-
-- technical-spec.md, section "Proposed Data Model" — as already fixed by
-- Neo's own prior schema review of that document, see the spec's own
-- "Neo's Schema Review — 2026-09-10" section, and cleared by a real,
-- independent Asimov + Mason technical review on 2026-09-10, documented
-- inside the spec itself). Product design in
-- projects/hub/email-intake/archive-search-v1-scope.md. Implements the
-- spec's data model exactly — this migration is the build step, not
-- another design pass. Nothing here re-litigates a decision the spec
-- already made.
--
-- Two places this migration exercises independent judgment, both on
-- genuinely open items the spec names and explicitly defers to Neo (spec
-- Finding 5 / task instructions — "plain CSV export vs. a table, your
-- call"): the shape of `archive_search_validation_sample` (built as a
-- real TABLE) and `missive_message_intake_held_review_safe` (built as a
-- VIEW). See the comment block on each below for the reasoning.
--
-- No application code, no router, no UI, no cron job, and no seed/grant
-- row into team_member_tool_roles ships from this file — schema only,
-- per Neo's standing role and this schema's own repeated convention.
-- This migration is NOT applied here — Peter applies it himself via
-- Supabase's SQL Editor, per this project's standing convention (no
-- CLI/DB URL in this environment). Per the spec's own "Before Any of
-- This Runs For Real" section: writing this migration does not authorize
-- applying it, and applying it does not authorize running the screening
-- pass against real data — that is its own, separate, later gate.
--
-- Governance status: this is a GOVERNANCE.md compliance build (stores/
-- processes personal data at the highest PII density in this schema,
-- and its screening pass makes an automated hold/flag determination
-- that gates what 8 people can see). The product-level design and this
-- technical spec were both reviewed by Asimov and Mason — see the
-- spec's own "Neo's Schema Review," "Resolving the Real Asimov + Mason
-- Review," and "Open Items" sections for the full trail. This migration
-- does not itself activate anything live: the screening pass stays
-- manually-triggered only (no cron), and no row is screened by this
-- file — it only creates the columns/view/table the (separate, later)
-- screening-pass code will write to and read from.
--
-- ============================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT BUILD
-- ============================================================
--   - The screening pass, the search route, the self-report classifier,
--     the keyword-list fixes, or any router/UI. All Q's work, on top of
--     this schema, per the spec's "The Screening Pass" and "Routes
--     Needed" sections.
--   - Any seed/grant row into team_member_tool_roles for
--     tool='archive_search'. This migration only makes 'archive_search'
--     (tool) and 'searcher' (role) legal to grant — who actually holds
--     'admin'/'searcher' is Peter's call, made only after the Finding 5
--     validation sample has passed with zero confirmed misses (spec,
--     "Access / Roles in the Hub" — same deferral every prior tool
--     onboarding in this schema has used).
--   - Any change to `audit_log`. Every actor_type/privacy_category/
--     risk_level value the spec's events use
--     (archive_search.screening_held, .screening_flagged_protected_class,
--     .batch_pass_run, .query_performed, .message_opened,
--     .validation_sample_reviewed, .held_review_export_generated) is
--     already legal under audit_log's real, current CHECK constraints
--     (20260815000000_audit_log_rule1_compliance.sql), confirmed
--     directly, not assumed: actor_type IN ('human','ai_agent','system'),
--     privacy_category IN ('collection','processing','dissemination',
--     'invasion','unclassified'), risk_level IN ('unclassified','low',
--     'medium','high','critical'). No schema change needed.
--   - A CHECK constraint restricting mailbox_key, or any change to
--     missive_sync_state, missive_message_intake's existing columns, or
--     the SCOPE LOCK the original 20260905020000 migration set. Fully
--     additive to that table.
--   - Any reconciliation between this tool's screening_result = 'held'
--     rows and complaint-tracking's own complaints.held_legal_
--     fair_housing rows. Named in the spec as a real, accepted, open
--     item (Finding 8 / Open Item 3) — not solved by a schema mechanism
--     here.
--   - A `hold_mechanism` column on missive_message_intake. The screening
--     pass writes screening_tags = NULL for held rows (spec, "The
--     Screening Pass," step 4) — "which mechanism tripped the hold" for
--     the held-review export lives only in
--     audit_log.details.hold_mechanism on the archive_search.
--     screening_held event, keyed by source_missive_conversation_id.
--     Materializing it as a column here would mean duplicating
--     audit_log content onto this table for no benefit the view below
--     doesn't already get by design — left for Q's route to join at
--     query time, same "audit_log is the one home for this detail"
--     discipline complaint-tracking's own migration already uses for
--     hold-mechanism-shaped facts.
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No. The five new columns on
--       missive_message_intake are all nullable with no default other
--       than NULL; every existing row keeps reading exactly as it does
--       today (screening_result IS NULL means "not yet screened," which
--       is true of every row that exists before this migration runs).
--       The two new tables/objects (archive_search_validation_sample,
--       missive_message_intake_held_review_safe) are brand new; nothing
--       existing reads or writes either one.
--   [x] Does this touch a table other code depends on?
--       missive_message_intake, yes — additively (5 new nullable
--       columns, 2 new CHECK constraints validated NOT VALID/
--       VALIDATE per the lock-avoidance note below, 1 new GENERATED
--       column, 3 new CONCURRENTLY indexes). Every existing reader/
--       writer of this table (the Missive sync cron job,
--       complaint-tracking's own pipeline) is unaffected: none of them
--       select or write any of these new columns, and pipeline_status
--       — the one column complaint-tracking's own ingestion query
--       filters on — is untouched by this migration (the screening
--       pass writing pipeline_status = 'processed' is Q's future code,
--       not this schema change). team_member_tool_roles, yes —
--       narrowly: both CHECK constraints are dropped and re-added with
--       every existing value plus one new one each, same DROP-then-ADD
--       pattern this constraint has now used 11 times (tool) / 8 times
--       (role) — see "LIVE STATE CHECK" below.
--   [x] Additive or destructive? Fully additive — 5 new columns, 1
--       GENERATED column, 3 indexes, 1 view, 1 new table, 2
--       CHECK-constraint widenings (+1 legal value each, no value
--       removed). No column dropped, no existing row updated, no
--       existing constraint narrowed.
--   [ ] Tested on a copy of the data first? No staging copy of Supabase
--       exists in this project — same standing caveat every migration
--       here has carried to date, and the same one 20260905020000's own
--       gate self-check already flagged for this exact table. Mitigated
--       by: the five plain columns are metadata-only in Postgres 11+
--       (near-instant); the GENERATED column and its GIN index are the
--       one real execution risk on this migration, addressed with an
--       explicit operational note and CONCURRENTLY, not glossed over
--       (see "SECTION B" below); the two new CHECK constraints are
--       added NOT VALID + VALIDATED separately to avoid an ACCESS
--       EXCLUSIVE table-scan lock on 254,000+ live rows, applying the
--       identical operational-carefulness principle the CONCURRENTLY
--       fix already establishes to a second lock-risk in this same
--       migration, not previously called out in the spec's own SQL
--       sketch — a judgment call, not a spec requirement, made because
--       the underlying risk (a live cron writing to this table
--       concurrently, no staging copy to rehearse against) is identical
--       to the one the CONCURRENTLY fix already exists to avoid.
--   [x] Governance go-ahead to build this specific schema — Asimov +
--       Mason technical review, 2026-09-10 (spec's own "Resolving the
--       Real Asimov + Mason Review" section). Not a go-ahead to run the
--       screening pass against real data — that is a separate, later
--       gate per the spec's "Before Any of This Runs For Real" section,
--       and not a go-ahead to grant any team_member_tool_roles row for
--       tool='archive_search' before the Finding 5 validation sample
--       has passed.
-- ============================================================
--
-- ============================================================
-- LIVE STATE CHECK BEFORE WIDENING team_member_tool_roles' CHECKs
-- (this constraint has a documented regression history —
-- 20260818000000_fix_role_check_regression.sql — from exactly this
-- kind of DROP/ADD being done against a stale assumption of what the
-- constraint currently allows, instead of the real, current
-- definition.)
-- ============================================================
-- tool_check: confirmed directly, by reading every migration file that
-- touches team_member_tool_roles_tool_check, in order. The most recent
-- is 20260910000000_complaint_tracking_schema.sql, which left it at 11
-- values: ('insurance_compliance', 'maintenance_history',
-- 'security_deposit', 'call_stats', 'content_engine',
-- 'leadsimple_application_screening', 'leadsimple_delinquency',
-- 'leadsimple_operations', 'approval_briefing', 'owner_tenant_notes',
-- 'complaint_tracking'). No file after that touches tool_check —
-- confirmed by reading both later 2026-09-10 migrations
-- (...call_stats_line_misses x2) directly: both mention
-- team_member_tool_roles only in prose ("adds no new tool value / no
-- team_member_tool_roles change"), neither alters the constraint. This
-- migration's ADD CONSTRAINT below carries forward all 11 existing
-- values plus 'archive_search' (12 total — matches the spec's own "12th
-- tool value" count exactly, not assumed).
--
-- role_check: confirmed the same way. The most recent migration to
-- touch it is still 20260902020000_add_maintenance_coordinator_role.sql
-- (neither 20260905020000, 20260906000000, 20260908000000, nor
-- 20260910000000 alters role_check — 20260910000000 states this
-- directly as Design Decision 15). Current 9 values: ('admin',
-- 'director_of_operations', 'property_manager',
-- 'inspection_coordinator', 'pod_lead', 'reviewer', 'contributor',
-- 'leasing_reviewer', 'maintenance_coordinator'). This migration's ADD
-- CONSTRAINT below carries forward all 9 existing values plus
-- 'searcher' (10 total — matches the spec's own "10th role value" count
-- exactly).
-- ============================================================


-- ============================================================
-- RULE 4 DATA INVENTORY UPDATE (GOVERNANCE.md Rule 4) — what changes on
-- missive_message_intake's existing inventory (full inventory already
-- on record in 20260905020000; not restated here in full, only the
-- deltas this migration causes, matching the spec's own "Data
-- Inventory" section).
-- ============================================================
--
-- missive_message_intake:
--   agents_with_access: was NONE ("no AI agent, LLM call, or extraction
--     step reads this table" — 20260905020000's own words). NO LONGER
--     TRUE once Q's future screening-pass code ships and runs: the new
--     fair-housing-batch-self-report.js classifier (Claude, via
--     ANTHROPIC_API_KEY) will read full, unscreened body_text for every
--     non-held conversation. This migration does not itself grant that
--     access (no application code ships here) — it is flagged now
--     because the columns this migration adds
--     (screening_result/_category/_tags/_version/_completed_at) are the
--     concrete evidence, once populated, that this inventory line has
--     changed. Also: Hub users holding 'searcher'/'admin' for
--     tool='archive_search' — but only ever against
--     missive_message_intake_search_safe below, never the base table
--     (the screening pass itself is the one narrow exception that must
--     read the base table, by definition, to screen it).
--   privacy_category: unchanged ('collection' for the base table); the
--     new columns are a 'processing' artifact of that same
--     already-collected content, not a new collection event.
--   retention_policy: unchanged in substance (Mason's 2026-09-05 RULE
--     1/RULE 2 policy is not rewritten here) — but its own PREREQUISITE
--     ("a held/tier flag... Neo's call, not added by this migration")
--     is satisfied for the first time by screening_result below. See
--     the column comment on screening_result for the retention-clock
--     consequence this triggers, stated plainly, not left implicit.
--   ccpa_exportable / ccpa_deletable: unchanged (TRUE/TRUE). The six new
--     columns this migration adds (five plain columns plus
--     search_document) are NOT added to the redaction target list:
--     search_document is a GENERATED column and recomputes automatically
--     the moment subject/body_text are redacted (no separate redaction
--     step needed), and screening_result/_category/_tags/_version/
--     _completed_at are exactly the audit-continuity metadata this
--     schema's existing redaction convention already preserves on
--     purpose — "this row was screened, and found X" stays; the
--     correspondence itself does not.
--
-- archive_search_validation_sample (new table, this migration):
--   pii_fields: NONE directly — the table stores only a foreign-key
--     pointer to a missive_message_intake row, a stratum label ('A'/
--     'B'), a sample-run number, and a timestamp. It carries no name,
--     email, or content column of its own. Flagged plainly: it is still
--     an indirect pointer into this schema's most sensitive table — a
--     row existing here identifies which specific messages were pulled
--     into the pre-launch human-review sample, which is itself
--     information worth protecting (see RLS note below), even though no
--     field on the row is PII by itself.
--   agents_with_access: NONE. No AI reads or writes this table — a
--     human reviewer (whoever holds 'admin' for tool='archive_search')
--     is the only consumer, via the validation-sample-export route,
--     which joins this table back to missive_message_intake to build
--     the CSV (Q's future route code, not built here).
--   privacy_category: 'processing' — an artifact of reviewing
--     already-collected, already-screened content, not a new collection
--     event.
--   retention_policy: kept indefinitely, same reasoning as audit_log's
--     own append-only retention — this table is a small, permanent
--     record of which messages were sampled for the launch-gating
--     accuracy check, useful for exactly the same "prove this happened
--     and what it covered" reason audit_log's own rows are kept
--     indefinitely. Rows are never updated (see column comments below);
--     a re-drawn sample (Finding 5's "fresh sample" re-draw on a
--     confirmed miss) adds new rows under a new sample_run rather than
--     overwriting the prior run's rows, preserving that history too.
--   ccpa_exportable: FALSE — no field on this table identifies a person;
--     nothing here is personal data in its own right.
--   ccpa_deletable: FALSE / not applicable, same reasoning. If a
--     referenced missive_message_intake row is ever redacted under that
--     table's own CCPA process, the sample row simply becomes a pointer
--     to a now-redacted row — not a problem, and not something this
--     table needs its own redaction step for.
--   Not CCPA-scannable (no pii_fields) — no CCPA scan list registration
--     needed.
--
-- RLS: enabled on archive_search_validation_sample, zero permissive
-- policies at creation — same "locked down until a tool explicitly asks
-- for access" default as every table in this schema, applied here
-- specifically because this table's very existence-per-row is sensitive
-- metadata about which correspondence was in the pre-launch human
-- review sample, even though no column is PII by itself.
-- ============================================================


-- ============================================================
-- SECTION A: missive_message_intake — new screening columns
-- (spec Finding 1: "The fix — a new column, not a new table" — a new
-- table was considered and rejected in the spec itself; not
-- re-litigated here).
-- ============================================================

ALTER TABLE missive_message_intake
  ADD COLUMN IF NOT EXISTS screening_result        TEXT,
  ADD COLUMN IF NOT EXISTS screening_category      TEXT,
  ADD COLUMN IF NOT EXISTS screening_tags          JSONB,
  ADD COLUMN IF NOT EXISTS screening_version       TEXT,
  ADD COLUMN IF NOT EXISTS screening_completed_at  TIMESTAMPTZ;

-- Both CHECK constraints below are added NOT VALID, then validated in a
-- separate statement (Neo's judgment call, this migration — see
-- "MIGRATION GATE SELF-CHECK" above). Every existing row already has
-- screening_result IS NULL immediately after the ADD COLUMN above (its
-- only possible value, since the column did not exist a moment ago),
-- which trivially satisfies both constraints — but Postgres still has
-- to scan the full table to confirm that for every one of 254,000+ live
-- rows. Adding the constraint outright takes an ACCESS EXCLUSIVE lock
-- for the whole scan (blocking every read and write, including the live
-- Missive sync cron job, for its duration); NOT VALID takes that lock
-- only for the fast, metadata-only "add the constraint, applies to
-- future writes immediately" step, and the subsequent VALIDATE
-- CONSTRAINT takes only a SHARE UPDATE EXCLUSIVE lock (does not block
-- ordinary reads/writes) for the scan itself. Same underlying risk
-- (no staging copy, a live concurrent writer) the CONCURRENTLY fix in
-- Section B already addresses, applied here to a second lock-risk in
-- this same migration that the spec's own SQL sketch did not call out.
ALTER TABLE missive_message_intake
  ADD CONSTRAINT missive_message_intake_screening_result_check
  CHECK (screening_result IS NULL OR screening_result IN ('held', 'flagged_protected_class', 'clear'))
  NOT VALID;

ALTER TABLE missive_message_intake
  VALIDATE CONSTRAINT missive_message_intake_screening_result_check;

-- Same discipline complaints_flag_requires_category already uses on
-- complaints (20260910000000) — a flagged row must carry a category; an
-- unflagged row must not (screening_category stays NULL for both
-- 'held' and 'clear' rows).
ALTER TABLE missive_message_intake
  ADD CONSTRAINT missive_message_intake_screening_category_required
  CHECK (screening_result IS DISTINCT FROM 'flagged_protected_class' OR screening_category IS NOT NULL)
  NOT VALID;

ALTER TABLE missive_message_intake
  VALIDATE CONSTRAINT missive_message_intake_screening_category_required;


-- ============================================================
-- SECTION B: search_document (tsvector, GENERATED) + its indexes
-- (spec, "The Search Mechanism") — subject + body_text only,
-- deliberately NOT from_address (dilutes relevance; sender lookup is
-- served by a plain ?from= ILIKE parameter at query time instead, per
-- the spec).
--
-- ****************************************************************
-- OPERATIONAL NOTE — READ BEFORE RUNNING THIS AGAINST THE REAL TABLE.
-- ****************************************************************
-- Unlike the five plain columns in Section A (metadata-only in
-- Postgres 11+, near-instant regardless of table size), the ALTER TABLE
-- immediately below is NOT metadata-only: a GENERATED ... STORED column
-- requires Postgres to compute and write the expression for every
-- EXISTING row — a full rewrite of missive_message_intake, all
-- 254,056+ rows, under an ACCESS EXCLUSIVE lock, while the live Missive
-- sync cron job (which writes to this exact table on its own schedule)
-- keeps running. This project has no staging copy of the data to
-- rehearse this against (same standing caveat 20260905020000's own
-- migration-gate self-check already carries) — the real table is the
-- only place this gets tested. Expect a real pause on this ONE
-- statement specifically (duration scales with table + body_html/
-- body_text size — not measured here) and do not run it during a
-- Missive sync job's active window without accounting for that.
--
-- The three CREATE INDEX CONCURRENTLY statements that follow it are
-- each a SEPARATE risk: CONCURRENTLY avoids the write-blocking lock a
-- plain CREATE INDEX would take, but CANNOT run inside a transaction
-- block. RUN EACH OF THE FOUR STATEMENTS BELOW (the ALTER TABLE ... ADD
-- COLUMN search_document, and the three CREATE INDEX CONCURRENTLY
-- statements) ONE AT A TIME, ON ITS OWN, IN SUPABASE'S SQL EDITOR — do
-- not paste this whole file, or even this whole section, as one script.
-- Postgres will reject a CONCURRENTLY statement run inside an implicit
-- multi-statement transaction.
-- ****************************************************************

-- ****************************************************************
-- STOP — the ADD COLUMN search_document statement, and the three
-- CREATE INDEX CONCURRENTLY statements, have all been pulled out of this
-- file on purpose. Two real problems showed up running this file whole:
-- (1) CONCURRENTLY cannot run in the same batch as everything else, and
-- (2) the ADD COLUMN statement alone is slow enough (rewriting all
-- 254,000+ rows) to exceed Supabase's own SQL Editor timeout, which
-- rolled back this entire file both times, Section A included.
--
-- Run this file (PART 1) to completion first — it should be fast, no
-- timeout risk. THEN run the remaining four statements from chat, in
-- order, EACH ONE AS ITS OWN SEPARATE RUN in the SQL Editor (not pasted
-- together, not pasted with this file):
--
-- 1) SET statement_timeout = '30min';
--    ALTER TABLE missive_message_intake
--      ADD COLUMN search_document tsvector
--      GENERATED ALWAYS AS (
--        to_tsvector('english', coalesce(subject, '') || ' ' || coalesce(body_text, ''))
--      ) STORED;
--
-- 2) SET statement_timeout = '30min';
--    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_missive_message_intake_search_document
--      ON missive_message_intake USING GIN (search_document);
--
-- 3) SET statement_timeout = '30min';
--    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_missive_message_intake_screening_pending
--      ON missive_message_intake (delivered_at)
--      WHERE screening_result IS NULL;
--
-- 4) SET statement_timeout = '30min';
--    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_missive_message_intake_delivered_at
--      ON missive_message_intake (delivered_at);
-- ****************************************************************


-- ============================================================
-- SECTION C: missive_message_intake_search_safe (spec Finding 1) —
-- mirrors maintenance_claims_decision_safe's single-table WHERE, no
-- join, plus security_barrier = true (Neo's prior review, fix 1 — see
-- the spec's "Resolving Finding 1" for why this view needs it and
-- maintenance_claims_decision_safe doesn't: this view sits over
-- unscreened, highest-PII-density content, and search_document is
-- computed over EVERY row including held/flagged ones, so the
-- underlying GIN index physically contains tokenized privileged
-- content even though this view is the only thing meant to stand
-- between a query and it).
--
-- Every route in archive-search/router.js and archive-search/lib/
-- (other than screening-pass.js, which must read the base table by
-- definition) is required to query this view, never
-- missive_message_intake directly — enforced by code convention, not
-- by this view alone (the shared Supabase service-role key every Hub
-- route uses bypasses RLS regardless of what missive_message_intake's
-- own policies say). Per the spec's Finding 1 and this build's own
-- named, required deliverable: a CI/test check asserting no such file
-- contains the literal string "missive_message_intake" outside of this
-- view's own name is required before this build is considered done —
-- not built by this migration (Q's/TARS's work), noted here so the
-- dependency is explicit.
-- ============================================================

CREATE OR REPLACE VIEW missive_message_intake_search_safe
WITH (security_barrier = true) AS
SELECT *
FROM missive_message_intake
WHERE screening_result = 'clear';


-- ============================================================
-- SECTION D: team_member_tool_roles — 'archive_search' (12th tool
-- value), 'searcher' (10th role value). Same DROP-then-ADD pattern this
-- constraint has used repeatedly. Current lists confirmed directly
-- above ("LIVE STATE CHECK"), not assumed.
-- ============================================================

ALTER TABLE team_member_tool_roles
  DROP CONSTRAINT IF EXISTS team_member_tool_roles_tool_check;
ALTER TABLE team_member_tool_roles
  ADD CONSTRAINT team_member_tool_roles_tool_check
  CHECK (tool IN (
    'insurance_compliance', 'maintenance_history', 'security_deposit', 'call_stats',
    'content_engine', 'leadsimple_application_screening', 'leadsimple_delinquency',
    'leadsimple_operations', 'approval_briefing', 'owner_tenant_notes',
    'complaint_tracking', 'archive_search'
  ));

ALTER TABLE team_member_tool_roles
  DROP CONSTRAINT IF EXISTS team_member_tool_roles_role_check;
ALTER TABLE team_member_tool_roles
  ADD CONSTRAINT team_member_tool_roles_role_check
  CHECK (role IN (
    'admin', 'director_of_operations', 'property_manager', 'inspection_coordinator',
    'pod_lead', 'reviewer', 'contributor', 'leasing_reviewer', 'maintenance_coordinator',
    'searcher'
  ));

-- No seed/grant INSERT — who holds 'searcher' vs 'admin' for
-- tool='archive_search' is Peter's call, made only after the Finding 5
-- validation sample has passed with zero confirmed misses, per the
-- scope document's own sequencing note (Section 4).


-- ============================================================
-- SECTION E: archive_search_validation_sample (spec Finding 5) — NEO'S
-- JUDGMENT CALL, task explicitly named this a genuinely open item.
--
-- WHAT THE SPEC ALREADY DECIDED: "a plain exported list, not a
-- review-queue UI" — no per-row reviewer/disposition workflow, no
-- structured record of what each reviewer decided (that stays a single
-- audit_log event, archive_search.validation_sample_reviewed, plus a
-- plain written note, same convention this codebase already uses for
-- review documents). That part is settled and this migration does not
-- reopen it.
--
-- WHAT THE SPEC LEFT OPEN: whether the 1,000-row stratified sample
-- itself (500 rows delivered_at >= 2024-01-01, 500 rows before) is
-- materialized anywhere, or purely computed live by the export route
-- each time it's called.
--
-- NEO'S CALL: a real table, not a view or a query-time-only sample, for
-- one concrete reason a view can't satisfy — the sample is drawn with
-- random selection (ORDER BY random() LIMIT 500 per stratum), and a
-- VIEW re-evaluates its query on every read. A plain live-random view
-- would hand a DIFFERENT 1,000 rows to the reviewer every time the
-- export is opened, downloaded again, or paginated — incompatible with
-- a bounded, one-time human review of a FIXED set of 1,000 messages
-- (the same problem the "no structured record of what was reviewed"
-- design only works around by assuming the underlying set stays
-- constant across the review period). Persisting the draw as rows here
-- is the minimum mechanism that makes "this specific set of 1,000 was
-- reviewed, zero misses found" a statement that can actually be true.
--
-- This table stores ONLY which messages are in the sample and which
-- draw they belong to — never a reviewer's disposition of any row (that
-- would be the review-queue table the spec explicitly decided not to
-- build). Q's future export route SELECTs the message id + missive_
-- message_intake fields (delivered_at, from_address, subject,
-- body_text, conversation id) by joining this table back to
-- missive_message_intake; it does not write review outcomes here.
--
-- sample_run exists for Finding 5's own re-draw rule: "If the 1,000-row
-- sample comes back with any confirmed miss... the entire batch pass is
-- re-run... and a fresh sample is drawn before this rule is checked
-- again." A second draw adds NEW rows under sample_run = 2 rather than
-- overwriting run 1's rows — preserving, for free, a real record of
-- what the first (failed) sample actually covered, which is itself
-- useful audit history if this ever needs revisiting.
--
-- No updated_at: same deliberate departure from this schema's usual
-- id/created_at/updated_at house style that missive_message_intake
-- itself already carries, for the identical reason — a row here is
-- never mutated after insert. It is either part of a sample draw or it
-- isn't; a "fresh sample" is new rows under a new sample_run, not an
-- update to existing ones.
-- ============================================================

CREATE TABLE IF NOT EXISTS archive_search_validation_sample (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  missive_message_intake_id  UUID        NOT NULL REFERENCES missive_message_intake(id) ON DELETE CASCADE,

  -- 'A' = delivered_at >= 2024-01-01 (500 rows); 'B' = before (500 rows,
  -- the deliberate pre-2024 oversample, spec Finding 5).
  stratum                     TEXT        NOT NULL CHECK (stratum IN ('A', 'B')),

  -- Which draw this row belongs to. 1 for the first (and, if it passes
  -- with zero confirmed misses, only) draw; incremented on a Finding-5
  -- re-draw after a confirmed miss forces a batch-pass re-run.
  sample_run                  INTEGER     NOT NULL DEFAULT 1 CHECK (sample_run > 0),

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A given message should never be drawn twice within the same run
  -- (random sampling without replacement makes this true by
  -- construction, but it costs nothing to also make it a real
  -- guarantee rather than an assumption about the export route's own
  -- correctness).
  UNIQUE (missive_message_intake_id, sample_run)
);

-- RLS: enabled, zero permissive policies — see RULE 4 DATA INVENTORY
-- UPDATE section above for why, even though no column here is PII by
-- itself.
ALTER TABLE archive_search_validation_sample ENABLE ROW LEVEL SECURITY;

-- "Give me this run's 1,000 rows" — the export route's one real query
-- shape.
CREATE INDEX IF NOT EXISTS idx_archive_search_validation_sample_run
  ON archive_search_validation_sample (sample_run);

-- (missive_message_intake_id + sample_run's UNIQUE constraint above
-- already creates its own composite unique index — no separate lookup
-- index needed for the FK column alone at this table's expected size,
-- 1,000-2,000 rows total across the life of this one-time task.)


-- ============================================================
-- SECTION F: missive_message_intake_held_review_safe (spec Finding 8) —
-- NEO'S JUDGMENT CALL, the second genuinely open item named by the
-- task.
--
-- NEO'S CALL: a plain VIEW, not a table. Unlike the validation sample
-- (Section E), there is nothing random or point-in-time to freeze here
-- — "every row where screening_result = 'held'" is a fully
-- deterministic condition, and the export's whole purpose (Mason's
-- Condition 4: Peter/DO/counsel reviewing the CURRENT held bucket) is
-- served just as well, and more accurately, by a live query as by a
-- stale snapshot. A table here would need its own refresh mechanism to
-- stay correct as new held rows accumulate from future screening-pass
-- runs — real complexity a view gets for free, matching CLAUDE.md's
-- "keep it as simple as possible."
--
-- GROUPED BY CONVERSATION, not left as one row per message: the
-- screening pass writes screening_result = 'held' onto every message
-- row in a held conversation (spec, "The Screening Pass," step 4), so a
-- flat SELECT * would show the same conversation multiple times — one
-- row per message — which is not what Finding 8's export actually wants
-- ("every row where screening_result = 'held'," read in context as "the
-- held conversations," matching how the export's own column list
-- describes a single delivered_at/subject/from_address per item, not
-- per message).
--
-- Deliberately NOT included: the "which mechanism tripped the hold"
-- column Finding 8's export wants. That fact is not stored on
-- missive_message_intake at all (see "WHAT THIS MIGRATION DELIBERATELY
-- DOES NOT BUILD" above) — it lives only in
-- audit_log.details.hold_mechanism on the archive_search.screening_held
-- event, keyed by source_missive_conversation_id. Q's future
-- held-review-export route joins this view against audit_log for that
-- one column; this view cannot and does not manufacture it.
--
-- No security_barrier here, unlike Section C's search-safe view. That
-- option exists specifically to stop a leaky-function side channel from
-- undermining a view meant to keep a BROAD population (8 searchers)
-- away from held/flagged content. This view has the opposite audience
-- and purpose — it exists specifically TO surface held content, to a
-- narrow, already-trusted population (whoever holds 'admin' for
-- tool='archive_search': Peter, the DO, counsel), gated in application
-- code (requireArchiveSearchAdmin). There is no "should have been
-- filtered out" case for security_barrier to protect here.
-- ============================================================

CREATE OR REPLACE VIEW missive_message_intake_held_review_safe AS
SELECT
  missive_conversation_id,
  mailbox_key,
  MIN(delivered_at)                                        AS earliest_delivered_at,
  MAX(delivered_at)                                         AS latest_delivered_at,
  COUNT(*)                                                  AS message_count,
  (ARRAY_AGG(subject      ORDER BY delivered_at ASC))[1]    AS earliest_subject,
  (ARRAY_AGG(from_address ORDER BY delivered_at ASC))[1]    AS earliest_from_address,
  MAX(screening_completed_at)                               AS screened_at,
  MAX(screening_version)                                    AS screening_version
FROM missive_message_intake
WHERE screening_result = 'held'
GROUP BY missive_conversation_id, mailbox_key;


-- ============================================================
-- COMMENTS — table/column/view documentation, same convention as every
-- other migration in this schema.
-- ============================================================

COMMENT ON COLUMN missive_message_intake.screening_result IS
  'Archive Search''s one-time screening-pass outcome: ''held'' | ''flagged_protected_class'' | ''clear'' | NULL (not yet screened). This IS the "held/tier flag" column 20260905020000''s own retention_policy note named as the missing PREREQUISITE for any age-based deletion job on this table. Real consequence, stated plainly: once the screening pass sets this on the historical backlog (and flips pipeline_status to ''processed'' alongside it), the 4-year CCP Section 337 deletion clock starts running, retroactively from delivered_at, on every ''clear'' row AND every ''flagged_protected_class'' row alike — a Fair-Housing flag is excluded from search but is NOT a legal hold (see complaints.flagged_protected_class''s own "advisory tag only, never a hold" precedent). Only ''held'' rows get the opposite: a permanent legal hold, no clock, until an attorney affirmatively releases it. No deletion job exists yet; nothing is deleted by this migration or by the screening pass itself — the clock becomes real the moment this column is populated, not hypothetically. See archive-search-technical-spec.md, "Resolving Finding 9," and Open Item 1.';

COMMENT ON COLUMN missive_message_intake.screening_category IS
  'Populated only when screening_result = ''flagged_protected_class'' (enforced by missive_message_intake_screening_category_required) — mirrors complaints.flagged_category. The matched keyword/phrase itself is never stored here, matching Design Decision 2''s restraint in complaint-tracking; detail lives only in audit_log.details for the archive_search.screening_flagged_protected_class event.';

COMMENT ON COLUMN missive_message_intake.screening_tags IS
  'Tier 1 TAG labels from checkThread() (e.g. [''regulatory_matter'']) — informational only, never a search filter. NULL for held rows (checkThread short-circuits before Tier 1 tagging matters for a held conversation) and may be NULL or populated for clear/flagged rows depending on what checkThread found.';

COMMENT ON COLUMN missive_message_intake.screening_version IS
  'Compact string identifying the combined privilege-keyword / protected-class-term / self-report-classifier version in effect when this row was screened (e.g. ''archive-search-screening-v1'') — satisfies GOVERNANCE.md Rule 5''s "every decision must reference the version in effect" without a second config table, same reasoning complaints.extracted_by''s design already used.';

COMMENT ON COLUMN missive_message_intake.screening_completed_at IS
  'When this row was actually screened by Archive Search''s batch pass, distinct from missive_message_intake''s own deliberate lack of a generic updated_at (see that column''s absence, noted in 20260905020000).';

-- MOVED — this documents the search_document column, which this file no
-- longer creates (see the STOP note near the top). Run this COMMENT
-- statement together with Step 2's ALTER TABLE in chat, right after it,
-- not here:
--
-- COMMENT ON COLUMN missive_message_intake.search_document IS
--   'Generated tsvector over subject + body_text (English config) for full-text search — deliberately excludes from_address (dilutes relevance for a "what was said" search; sender lookup is served by a plain ?from= ILIKE parameter instead). Computed over EVERY row, including held and flagged ones — the GIN index built on this column physically contains tokenized privileged/Fair-Housing content even though missive_message_intake_search_safe is the only thing meant to stand between a query and it. This is why that view carries security_barrier = true (see its own comment). Recomputes automatically if subject/body_text are ever redacted under this table''s CCPA process — no separate redaction step needed for this column.';

COMMENT ON VIEW missive_message_intake_search_safe IS
  'The ONLY view every archive-search search/message route may query — never missive_message_intake directly, with the one named exception of screening-pass.js, which must read the base table to screen it. security_barrier = true (Neo''s schema review of the technical spec, fix 1): this view sits over this schema''s highest-PII-density table, before any privilege/Fair-Housing check has run on most of it, so the usual "views are just convenience" reasoning maintenance_claims_decision_safe relies on does not hold here. A required CI/test check (per the spec''s Finding 1 and this build''s named deliverable) asserts no file under archive-search/router.js or archive-search/lib/, other than screening-pass.js, contains the literal string "missive_message_intake" outside of this view''s own name — the real, practical backstop given that every Hub route shares one service-role connection that bypasses RLS regardless.';

COMMENT ON TABLE archive_search_validation_sample IS
  'Neo''s schema for the Finding 5 pre-launch accuracy check (archive-search-technical-spec.md) — a persisted, stratified random draw of 1,000 screening_result=''clear'' messages (500 delivered_at >= 2024-01-01, 500 before), reviewed by whoever holds ''admin'' for tool=''archive_search'' BEFORE any ''searcher'' role is ever granted. A real table, not a view, specifically because the draw is random and must stay the SAME set of 1,000 across repeated exports during the review window — a live-random view would reshuffle on every read. Stores only which messages are in which draw (sample_run) — never a reviewer''s per-row disposition; that stays a single audit_log event (archive_search.validation_sample_reviewed) plus a plain written note, per the spec''s own explicit "not a review-queue UI" design. RLS enabled, zero permissive policies.';

COMMENT ON COLUMN archive_search_validation_sample.sample_run IS
  'Which draw this row belongs to. 1 for the first draw. Finding 5''s exit rule requires a FRESH sample and a full batch-pass re-run on any confirmed miss — a re-draw adds new rows under sample_run = 2 (etc.), never overwrites or deletes the prior run''s rows, preserving what the earlier (failed) sample actually covered.';

COMMENT ON VIEW missive_message_intake_held_review_safe IS
  'Neo''s schema for the Finding 8 held-bucket export (Mason''s Condition 4) — every held conversation, one row per conversation (not per message; the screening pass marks every message in a held conversation ''held''), admin-only, read-only, no disposition/closure workflow (matching Mason''s "not a search feature into the held bucket itself"). A plain view, not a table: "held" is a fully deterministic, always-current condition with nothing to freeze, unlike the validation sample above. Deliberately does NOT include which mechanism tripped the hold — that fact lives only in audit_log.details.hold_mechanism on the archive_search.screening_held event, keyed by source_missive_conversation_id; the export route joins there for it. Not reconciled against complaints.held_legal_fair_housing — a real, accepted, unsolved overlap named in the spec''s Open Items, not this migration''s to fix.';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP VIEW IF EXISTS missive_message_intake_held_review_safe;
--
-- DROP INDEX IF EXISTS idx_archive_search_validation_sample_run;
-- -- Safe to drop in full as long as no real sample has been drawn and
-- -- reviewed yet (true as of this migration). If a real validation
-- -- sample draw/review has since happened, dropping this table loses
-- -- the record of exactly which 1,000 messages were reviewed — confirm
-- -- the archive_search.validation_sample_reviewed audit_log event (and
-- -- any written review note) already captures what's needed before
-- -- dropping.
-- DROP TABLE IF EXISTS archive_search_validation_sample;
--
-- ALTER TABLE team_member_tool_roles
--   DROP CONSTRAINT IF EXISTS team_member_tool_roles_role_check;
-- ALTER TABLE team_member_tool_roles
--   ADD CONSTRAINT team_member_tool_roles_role_check
--   CHECK (role IN (
--     'admin', 'director_of_operations', 'property_manager', 'inspection_coordinator',
--     'pod_lead', 'reviewer', 'contributor', 'leasing_reviewer', 'maintenance_coordinator'
--   ));
-- -- Only safe if no row has been granted role='searcher' since this
-- -- migration was applied — check team_member_tool_roles first.
--
-- ALTER TABLE team_member_tool_roles
--   DROP CONSTRAINT IF EXISTS team_member_tool_roles_tool_check;
-- ALTER TABLE team_member_tool_roles
--   ADD CONSTRAINT team_member_tool_roles_tool_check
--   CHECK (tool IN (
--     'insurance_compliance', 'maintenance_history', 'security_deposit', 'call_stats',
--     'content_engine', 'leadsimple_application_screening', 'leadsimple_delinquency',
--     'leadsimple_operations', 'approval_briefing', 'owner_tenant_notes',
--     'complaint_tracking'
--   ));
-- -- Only safe if no row has been granted tool='archive_search' since
-- -- this migration was applied — check team_member_tool_roles first.
--
-- DROP VIEW IF EXISTS missive_message_intake_search_safe;
--
-- -- Index drops (each of these is itself safe to run inside a normal
-- -- transaction/paste — only the CREATE ... CONCURRENTLY direction has
-- -- the "run on its own" restriction, not DROP INDEX).
-- DROP INDEX IF EXISTS idx_missive_message_intake_delivered_at;
-- DROP INDEX IF EXISTS idx_missive_message_intake_screening_pending;
-- DROP INDEX IF EXISTS idx_missive_message_intake_search_document;
--
-- ALTER TABLE missive_message_intake DROP COLUMN IF EXISTS search_document;
-- -- This one is also a full-table rewrite, same OPERATIONAL NOTE as the
-- -- ADD above — expect the same real pause, run on its own.
--
-- ALTER TABLE missive_message_intake
--   DROP CONSTRAINT IF EXISTS missive_message_intake_screening_category_required;
-- ALTER TABLE missive_message_intake
--   DROP CONSTRAINT IF EXISTS missive_message_intake_screening_result_check;
--
-- ALTER TABLE missive_message_intake
--   DROP COLUMN IF EXISTS screening_completed_at,
--   DROP COLUMN IF EXISTS screening_version,
--   DROP COLUMN IF EXISTS screening_tags,
--   DROP COLUMN IF EXISTS screening_category,
--   DROP COLUMN IF EXISTS screening_result;
-- -- Safe to drop these five in full as long as no screening pass has
-- -- actually run yet (true as of this migration — no Q code exists that
-- -- could have written a real value). If the screening pass has since
-- -- run against real data, dropping these columns permanently loses
-- -- which messages were held/flagged/clear, and — per this column's own
-- -- comment above — the retention-clock PREREQUISITE this migration
-- -- satisfies would become unsatisfied again. Confirm nothing depends on
-- -- this before rolling back a live-screened table.
--
-- ============================================================
