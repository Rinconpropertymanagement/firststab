-- ============================================================
-- Migration: 20260913020000_archive_search_significance_complaint_merge_schema
-- Created:   2026-09-13
-- Author:    Neo (database specialist)
--
-- Implements projects/hub/email-intake/archive-search-significance-
-- technical-spec.md (v2, through its fifth same-day correction) —
-- Section 7 ("Schema (for Neo to finalize)"), read together with
-- Sections 1, 3, 4, 6, and 9 for the reasoning behind is_big_issue,
-- discovery_context, human_confirmed_big_issue, and the complaints-
-- creation trigger conditions. This is schema only. It does not
-- authorize Q to write any application code, and does not itself run
-- anything against real mail. Per that spec's own Section 12: this
-- migration IS the one item Asimov named as still outstanding before
-- this build is fully cleared (Neo's Rule 4 data inventory) — the full
-- inventory is its own document, compliance/archive-search-
-- significance-complaint-merge-data-inventory.md, written alongside
-- this file. Peter's compliance-risk approval and shadow-mode/sampling
-- exit criterion are both already on record in the spec's Section 12;
-- neither is re-litigated here.
--
-- This migration is NOT applied here — Peter applies it himself via
-- Supabase's SQL Editor, per this project's standing convention (no
-- CLI/DB URL in this environment).
--
-- ============================================================
-- WHY THIS IS ONE FRESH MIGRATION, NOT AN ALTER ON TOP OF 20260910000000
-- ============================================================
-- 20260910000000_complaint_tracking_schema.sql was written, reviewed,
-- and NEVER APPLIED to the live database — confirmed, repeatedly, in
-- this compliance trail (spec Section 2, Section 7 preamble). Layering
-- ALTER TABLE statements onto a table that was never created would
-- force Peter to paste two files, in a specific order, by hand, with
-- nothing in Supabase's SQL Editor enforcing that order — exactly the
-- human failure mode 20260912050000_reconcile_20260912040000_timestamp
-- _collision.sql already documents for a different pair of files. The
-- spec's own Section 7 preamble recommends exactly what this file does:
-- one fresh migration, timestamped after today's latest, creating
-- missive_message_links, missive_conversation_significance, and the
-- merged complaints shape together, in dependency order.
--
-- 20260910000000_complaint_tracking_schema.sql's own header has been
-- marked superseded/do-not-apply as part of this same change (see that
-- file directly) — the convention followed here is the one
-- 20260912050000 already established for a comparable same-repo
-- situation: a short, prominent notice added to the top of the
-- superseded file, pointing here, rather than deleting or rewriting it.
--
-- ============================================================
-- A REAL FINDING THAT CHANGES WHAT THIS MIGRATION NEEDS TO DO:
-- team_member_tool_roles.tool ALREADY ALLOWS 'complaint_tracking' LIVE
-- ============================================================
-- 20260910000000's own Section D widens team_member_tool_roles.tool to
-- add 'complaint_tracking' — but since that file was never applied, it
-- would be easy to assume this migration needs to redo that widening.
-- It does not. Confirmed by reading every migration that touches
-- team_member_tool_roles_tool_check, in order, through the most recent
-- one: 20260910030000_archive_search_schema.sql (applied — see its own
-- "CONFIRMED ALREADY APPLIED" trail, e.g. 20260911000000's header) DROPS
-- and ADDs this constraint with 'complaint_tracking' ALREADY included
-- in its list, alongside the new 'archive_search' value — written that
-- way even though the migration that "originally" owned
-- 'complaint_tracking' never ran. 20260912000000_scorecard_weekly.sql
-- (the last file to touch this constraint) carries 'complaint_tracking'
-- forward again, plus 'scorecard'. No file after 20260912000000 touches
-- tool_check (confirmed by reading every candidate migration filename
-- after it). Live, current, 13-value list: 'insurance_compliance',
-- 'maintenance_history', 'security_deposit', 'call_stats',
-- 'content_engine', 'leadsimple_application_screening',
-- 'leadsimple_delinquency', 'leadsimple_operations',
-- 'approval_briefing', 'owner_tenant_notes', 'complaint_tracking',
-- 'archive_search', 'scorecard'. This migration therefore makes NO
-- change to team_member_tool_roles at all — the value this schema
-- needs is already legal to grant. role_check is untouched for the
-- same reason it always has been: 'admin' and 'director_of_operations'
-- already exist and are the only two roles this domain ever checks.
--
-- ============================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT BUILD
-- ============================================================
--   - The merged Call 1/Call 2 prompt module, the driver query, the
--     historical Batches-API run, any router/UI, the "Needs a Human
--     Call" tab, the Historical Backlog tab, the active-notification
--     bound (spec Section 6), or the pattern/recurrence SQL count
--     (spec Section 7's "pattern" note). All Q's build, on top of this
--     schema, once this migration ships and Q has a plan reviewed.
--   - Any team_member_tool_roles change — see the finding above.
--   - Any RLS policy grant. RLS is enabled on both new tables with zero
--     permissive policies at creation, matching every table in this
--     schema; every reader today connects via the service-role key,
--     which bypasses RLS regardless.
--   - The complaints-creation trigger as a real Postgres TRIGGER. See
--     "COMPLAINTS-CREATION LOGIC — WHY THIS IS APPLICATION CODE, NOT A
--     DATABASE TRIGGER" below for why, checked directly against how
--     this exact kind of conditional, cross-table, multi-field decision
--     is already handled everywhere else in this codebase.
--   - checkClaim()'s audit_log entry (spec Section 5) — application
--     code, per every other audit_log write in this schema.
--   - The complaints_historical_review_required "affirmative clearance"
--     UI or notification mechanism — only the view itself (Section E
--     below) and the two columns its clearing action writes to.
--
-- ============================================================
-- COMPLAINTS-CREATION LOGIC — WHY THIS IS APPLICATION CODE, NOT A
-- DATABASE TRIGGER (checked against the real, existing convention, not
-- assumed)
-- ============================================================
-- The spec's own build-out prompt asked this directly: is a conditional
-- write like "create a complaints row when escalation_signal != 'none',
-- OR needs_human_call, OR owner_instruction_rejected, OR category IN
-- (legal_exposure, owner_instruction)" ever expressed as a DB trigger
-- anywhere in this schema, or does this codebase keep that kind of
-- business logic in application code, with the DB only enforcing CHECK
-- constraints on the result?
--
-- Checked directly, not assumed: this schema has exactly two real
-- (non-updated_at) triggers today —
-- audit_log_compute_chain (20260815000000, the Rule 1 hash chain) and
-- missive_message_intake_set_search_document (20260911000000, the
-- tsvector self-maintenance trigger). Both are PURE, single-row,
-- single-table functions of that same row's own already-present
-- columns — neither one reads a config table, neither one decides
-- whether to write into a DIFFERENT table, and neither one encodes a
-- product/business rule that could change independently of the
-- row's own data. The actual, real precedent for "decide whether an
-- AI-categorized event is significant enough to create a linked row
-- elsewhere" is process-pending-messages.js: it calls
-- categorizeComplaint(), inspects the result in JavaScript
-- (isBigDeal = !!categorization.category || categorization.
-- needs_human_call, then a conditional supabase.from('complaints').
-- insert(...)), and the database's only role is CHECK constraints on
-- whatever row lands (complaints_blocked_requires_reason,
-- complaints_flag_requires_category, etc.). That is the established
-- convention this migration follows: the complaints-creation gate
-- (spec Section 4) is Q's application code, to be written against the
-- CHECK-constrained shape this migration provides — not a trigger. The
-- exact condition, copied verbatim for Q to build against unchanged:
--
--   Create (or update) a linked complaints row whenever, on the SAME
--   Call 2 write that updates missive_conversation_significance:
--     escalation_signal != 'none'
--     OR needs_human_call
--     OR owner_instruction_rejected IS DISTINCT FROM NULL
--        (i.e. 'true', 'false', or 'uncertain' — any answered value)
--     OR category IN ('legal_exposure', 'owner_instruction')
--   — for both live_pipeline and historical_backfill rows alike (spec
--   Section 4's correction). A human confirming human_confirmed_big_
--   issue = TRUE via the "Needs a Human Call" queue never creates a
--   complaints row on its own (spec Section 7's own note on this) —
--   that path only ever affects is_big_issue and Property 360/
--   compliance-review.html surfacing.
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No. All three tables this
--       file creates (complaint_tracking_config, complaints,
--       missive_message_links) plus the extended
--       missive_conversation_significance are brand new — nothing
--       existing reads or writes any of them. No existing table's
--       column, constraint, or row is altered by this file (confirmed
--       above: team_member_tool_roles needs no change).
--   [x] Does this touch a table other code depends on? No existing
--       table is altered — see above.
--   [x] Additive or destructive? Fully additive — four new tables (one
--       of them, complaint_tracking_config, a straight carry-forward
--       from the never-applied 20260910000000), two new views, zero
--       existing objects touched.
--   [ ] Tested on a copy of the data first? No staging copy of Supabase
--       exists in this project — same standing caveat every migration
--       here has carried. Mitigated by: every table this file creates
--       is brand new and empty; nothing can be broken that doesn't yet
--       exist.
--   [x] Governance go-ahead to build this specific schema — Peter's own
--       compliance-risk approval and shadow-mode/sampling exit
--       criterion are both on record (spec Section 12); Mason's
--       verdict on the merged design is CLEARED WITH CONDITIONS, met by
--       this revision; Asimov's verdict is STILL NOT CLEARED pending
--       exactly this Rule 4 inventory (produced alongside this file)
--       and his own fresh confirmation pass on it — this migration does
--       not self-certify that pass. Not a go-ahead to run either AI
--       call against real mail — that is a separate, later gate.
-- ============================================================


-- ============================================================
-- RULE 9 — HOUSING-DECISION FIREWALL (GOVERNANCE.md Rule 9), applied to
-- ALL THREE tables below that carry real content or real FKs. Read this
-- before writing any query, join, or export against any of them from
-- outside this tool.
-- ============================================================
-- missive_conversation_significance is the closest of the three to a
-- structural firewall: it carries no FK into properties/units/tenants/
-- owners/vendors at all — mailbox_key/missive_conversation_id match
-- missive_message_intake BY VALUE ONLY, never by foreign key, per Rule
-- 9's own established convention on that table (20260905020000). Its
-- one real FK, complaint_id -> complaints(id), is nullable and one-way
-- (mirrors complaints.proposed_operational_note_id -> operational_notes
-- — no reciprocal pointer either direction).
--
-- complaints and missive_message_links are NOT structurally firewalled
-- in that same way — both carry real foreign keys (property_id,
-- unit_id, and on complaints, vendor_id) because both legitimately need
-- to join to properties/units/vendors for ordinary tool operation
-- (Property 360 surfacing, the DO's queue, subject resolution). The
-- firewall on these two is therefore a WRITTEN POLICY, enforced by
-- review discipline, exactly as 20260910000000 already established for
-- complaints — extended here to missive_message_links for the same
-- reason: any join from complaints.subject_id/held_legal_fair_housing/
-- flagged_protected_class, or from missive_message_links.subject_id/
-- subject_type, into a screening, renewal, eviction, or other
-- adverse-action tool REQUIRES a fresh Asimov/Mason review before it is
-- written, including a join that only checks row existence. Knowledge
-- of a pending Fair Housing or legal complaint, or of a resolved
-- historical owner-instruction finding, must never factor into a
-- tenant-adverse decision made elsewhere, by a person or by another
-- tool in this codebase.
-- ============================================================


-- ============================================================
-- SECTION A: missive_message_links — unchanged in shape from v1
-- (missive-archive-analysis-SPEC.md Section 2.2's sketch), with the
-- vendor value the spec's Section 4 confirms is now real:
-- "subject_type already includes 'vendor'". Per that same v1 sketch's
-- own text ("zero for genuinely unmatchable internal chatter"), a
-- message with no resolvable subject gets ZERO rows here, never a row
-- with an 'unmatched' subject_type — so this table's subject_type only
-- ever needs the three real, matched values, not the four-value list an
-- earlier sketch used for a different purpose (describing which
-- MESSAGES get no row at all, not a value this COLUMN would ever hold).
-- Confirmed, not just narrowed on faith.
--
-- DORMANT UNTIL SYNC: the vendor branch is real, live logic — this
-- migration enforces it structurally — but has no real data to match
-- against yet. Spec Section 11, Item 10 (carried from v1): "vendor
-- matching is real, live logic with no real vendor data synced yet...
-- still dormant until an AppFolio→Supabase vendor sync exists." Nothing
-- here builds that sync.
-- ============================================================

CREATE TABLE IF NOT EXISTS missive_message_links (
  id                        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Matches missive_message_intake by value, never by foreign key — Rule
  -- 9 convention already established on that table (20260905020000).
  -- mailbox_key is denormalized here (not in the v1 sketch's own column
  -- list, added by Neo as a documented-convention gap that sketch simply
  -- didn't restate) for the same reason missive_conversation_significance
  -- denormalizes it: a cheap per-mailbox lookup with no join back to
  -- intake, matching every sibling table in this domain.
  mailbox_key               TEXT          NOT NULL,
  missive_message_id        TEXT          NOT NULL,
  missive_conversation_id   TEXT          NOT NULL,

  property_id               UUID          REFERENCES properties(id) ON DELETE RESTRICT,
  unit_id                    UUID         REFERENCES units(id) ON DELETE SET NULL,

  subject_type                TEXT        NOT NULL CHECK (subject_type IN ('tenant', 'owner', 'vendor')),
  -- tenants.id | owners.id | vendors.id, per subject_type — no enforced
  -- FK, same polymorphic pattern operational_notes/complaints/audit_log
  -- already use (a Postgres CHECK cannot express "FK into one of three
  -- tables" natively).
  subject_id                   UUID       NOT NULL,

  match_method                   TEXT     NOT NULL CHECK (match_method IN ('address_match', 'content_extracted')),
  matched_field                   TEXT,    -- which address field matched (e.g. 'to_addresses'); address_match only
  source_reference                 TEXT,   -- which sentence/field the reference came from; content_extracted only — same citation discipline extract-claims.js already requires
  confidence                         NUMERIC CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  extracted_by                        TEXT, -- CONTENT_PASS_VERSION string; content_extracted only (spec Section 7 "Versioning")

  created_at                            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Field-presence discipline the task's own build brief calls out by
  -- name: address_match rows are deterministic (matched_field set, no
  -- AI-derived fields); content_extracted rows are AI-derived (source_
  -- reference/confidence/extracted_by set, no matched_field). Mirrors
  -- complaints_source_requires_fields's own "which fields exist depends
  -- on which path wrote this row" discipline.
  CONSTRAINT missive_message_links_address_match_fields CHECK (
    match_method IS DISTINCT FROM 'address_match' OR (
      matched_field IS NOT NULL AND source_reference IS NULL
      AND confidence IS NULL AND extracted_by IS NULL
    )
  ),
  CONSTRAINT missive_message_links_content_extracted_fields CHECK (
    match_method IS DISTINCT FROM 'content_extracted' OR (
      source_reference IS NOT NULL AND confidence IS NOT NULL
      AND extracted_by IS NOT NULL AND matched_field IS NULL
    )
  )

  -- No FOREIGN KEY into missive_message_intake, missive_conversation_
  -- significance, or complaints appears anywhere in this table
  -- definition — mailbox_key/missive_message_id/missive_conversation_id
  -- match by value only, per Rule 9 above and this schema's standing
  -- "external/sibling table, sync order not guaranteed" convention.
);

ALTER TABLE missive_message_links ENABLE ROW LEVEL SECURITY;

-- "All links for this thread" — the exact query the v1 sketch's own
-- text names as the reason missive_conversation_id is denormalized here.
CREATE INDEX IF NOT EXISTS idx_missive_message_links_conversation
  ON missive_message_links(mailbox_key, missive_conversation_id);

-- Property 360's "conversations tagged to this property" card, and the
-- pattern/recurrence cross-reference count (spec Section 7).
CREATE INDEX IF NOT EXISTS idx_missive_message_links_subject
  ON missive_message_links(subject_type, subject_id);

CREATE INDEX IF NOT EXISTS idx_missive_message_links_property
  ON missive_message_links(property_id) WHERE property_id IS NOT NULL;

-- Cheap re-fetch/idempotency check per (message, subject) pair — a
-- message linked to the same subject twice is a duplicate write, not a
-- second real link.
CREATE UNIQUE INDEX IF NOT EXISTS idx_missive_message_links_unique_link
  ON missive_message_links(missive_message_id, subject_type, subject_id, match_method);

COMMENT ON TABLE missive_message_links IS
  'One row per (message, resolved subject) pair — zero, one, or several rows per message (missive-archive-analysis-SPEC.md Section 2.2). Dormant for subject_type=''vendor'' until an AppFolio-to-Supabase vendor sync exists (spec Section 11, Item 10) — the CHECK constraint and index above are real and enforced today; there is simply no vendor data to match against yet. Read the RULE 9 — HOUSING-DECISION FIREWALL comment earlier in this migration file before joining this table into any screening, renewal, eviction, or adverse-action tool. RLS enabled, zero permissive policies.';

COMMENT ON COLUMN missive_message_links.subject_id IS
  'tenants.id | owners.id | vendors.id, per subject_type. No enforced FK — same polymorphic pattern operational_notes/complaints already use. complaints.subject_type/subject_id must ONLY ever be populated from a row here where match_method = ''address_match'' — never from a content_extracted row, regardless of confidence (archive-search-significance-technical-spec.md Section 4, citing subject-match.js''s own "email-match only, no AI free-text fallback, full stop" discipline).';


-- ============================================================
-- SECTION B: complaint_tracking_config — straight carry-forward from
-- 20260910000000 (never applied). Unchanged in shape; complaints.
-- complaint_tracking_config_id still references it (Section C below).
-- ============================================================

CREATE TABLE IF NOT EXISTS complaint_tracking_config (
  id                                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  version                           INTEGER     NOT NULL,
  blocked_resolution_silence_days   INTEGER     NOT NULL CHECK (blocked_resolution_silence_days > 0),
  big_deal_aging_clock_hours        INTEGER     NOT NULL CHECK (big_deal_aging_clock_hours > 0),
  duplicate_window_days             INTEGER     NOT NULL CHECK (duplicate_window_days > 0),
  is_active                         BOOLEAN     NOT NULL DEFAULT TRUE,
  set_by                            TEXT        NOT NULL,
  set_at                            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes                             TEXT,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (version)
);

ALTER TABLE complaint_tracking_config ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS idx_complaint_tracking_config_one_active
  ON complaint_tracking_config ((true)) WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS trg_complaint_tracking_config_updated_at ON complaint_tracking_config;
CREATE TRIGGER trg_complaint_tracking_config_updated_at
  BEFORE UPDATE ON complaint_tracking_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed version 1 — same three values Peter already confirmed
-- 2026-09-09/10 for the never-applied original migration. Historical-
-- backfill rows are exempt from needing any config version at all
-- (Section C's complaints_config_required_unless_held, extended below) —
-- duplicate_window_days=3 and big_deal_aging_clock_hours=24 remain
-- live-mail-only concepts, per spec Section 6's hard gate.
INSERT INTO complaint_tracking_config
  (version, blocked_resolution_silence_days, big_deal_aging_clock_hours, duplicate_window_days, is_active, set_by, notes)
VALUES (
  1, 2, 24, 3, TRUE, 'peter@rinconmanagement.com',
  'Carried forward unchanged from the never-applied 20260910000000_complaint_tracking_schema.sql. All three values confirmed by Peter 2026-09-09/09-10. To change any of these later: in one transaction, set is_active = FALSE on this row and INSERT a new row with the new version and is_active = TRUE. Per GOVERNANCE.md Rule 6, this is a Standard change requiring Peter''s approval.'
)
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- SECTION C: complaints — the never-applied 20260910000000 shape,
-- evolved per archive-search-significance-technical-spec.md Section 7's
-- own numbered list ("complaints — changes relative to the never-applied
-- 20260910000000 draft"). Everything not called out in a comment below
-- carries forward byte-for-byte from that file's Section B.
-- ============================================================

CREATE TABLE IF NOT EXISTS complaints (
  id                              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  property_id                     UUID          REFERENCES properties(id) ON DELETE RESTRICT,
  unit_id                         UUID          REFERENCES units(id) ON DELETE SET NULL,
  vendor_id                       UUID          REFERENCES vendors(id) ON DELETE SET NULL,
  subject_type                    TEXT          CHECK (subject_type IS NULL OR subject_type IN ('owner', 'tenant', 'team_member', 'property')),
  subject_id                      UUID,         -- owners.id | tenants.id | team_members.id | NULL — no enforced FK
  needs_matching                  BOOLEAN       NOT NULL DEFAULT FALSE,

  -- CHANGED — spec Section 7, bullet 1. The old 6-value complaint-
  -- tracking-only enum is retired; this now uses the SAME 8-value shared
  -- topic taxonomy as missive_conversation_significance.category, so a
  -- conversation reads identically wherever it's shown. legal_compliance
  -- folds into legal_exposure (same meaning, one name); owner_instruction
  -- _one_off folds into owner_instruction, with the discriminatory-
  -- instruction question now the separate owner_instruction_rejected
  -- field below, not its own category value. Deliberately left nullable
  -- (not NOT NULL) — a source='manual_staff' report with no AI category
  -- is still a real, legal complaints row, matching the original design's
  -- own reason for allowing NULL here.
  category                        TEXT          CHECK (category IS NULL OR category IN (
                                     'routine_logistics','maintenance_standard','dispute','safety_issue',
                                     'legal_exposure','accommodation_related','owner_instruction','other'
                                   )),
  needs_human_call                BOOLEAN       NOT NULL DEFAULT FALSE,
  held_legal_fair_housing         BOOLEAN       NOT NULL DEFAULT FALSE,

  description                     TEXT,

  blocked_reason                  TEXT          CHECK (blocked_reason IS NULL OR blocked_reason IN ('explicit_refusal', 'inferred_from_silence')),
  blocked_party                   TEXT          CHECK (blocked_party IS NULL OR blocked_party IN ('owner', 'tenant')),
  blocked_since                   TIMESTAMPTZ,

  -- NEW — spec Section 7, bullet 2. NOT constrained to include 'none':
  -- a 'none' escalation result never creates a complaints row at all
  -- (Section 4/the trigger-logic comment above), so every row that
  -- exists here has a real reason OR reached this table on category
  -- alone (legal_exposure/owner_instruction) with no escalation signal —
  -- hence nullable, not "NOT NULL DEFAULT 'none'".
  escalation_signal               TEXT          CHECK (escalation_signal IS NULL OR escalation_signal IN (
                                     'blocked_resolution','churn_risk','escalation_recurrence','major_money_property_risk'
                                   )),

  -- NEW — the tri-state owner-instruction finding, widened to match
  -- missive_conversation_significance.owner_instruction_rejected exactly
  -- (spec Section 7, bullet 8 — this column's existence on complaints is
  -- implied by that bullet's "widens to match... the same reason" text,
  -- not spelled out as its own "New column" line the way escalation_
  -- signal/discovery_context are; added here as the direct, necessary
  -- implementation of what bullet 8 describes, flagged explicitly as a
  -- gap the spec's own bulleted list left implicit rather than something
  -- silently assumed).
  owner_instruction_rejected      TEXT          CHECK (owner_instruction_rejected IS NULL OR owner_instruction_rejected IN ('true','false','uncertain')),
  -- Companion note-text column, same implied-by-bullet-8 reasoning as
  -- above. Named to match missive_conversation_significance.owner_
  -- instruction_note_text exactly, rather than reusing this table's own
  -- pre-existing `description` column, so the same value is never stored
  -- under two different meanings on two different tables.
  owner_instruction_note_text     TEXT,

  -- Fair Housing content tag (checkClaim()) — unchanged from the
  -- original design.
  flagged_protected_class         BOOLEAN       NOT NULL DEFAULT FALSE,
  flagged_category                TEXT,

  tone_trend                      TEXT          CHECK (tone_trend IS NULL OR tone_trend IN ('stable', 'escalating')),

  status                          TEXT          NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'blocked', 'resolved', 'held')),
  resolution_note                 TEXT,

  owner_team_member_id            UUID          REFERENCES team_members(id),
  delegated_to_team_member_id     UUID          REFERENCES team_members(id),
  last_aging_nudge_at             TIMESTAMPTZ,

  source                          TEXT          NOT NULL CHECK (source IN ('email_ai', 'manual_staff')),
  reported_by_team_member_id      UUID          REFERENCES team_members(id),
  -- Now stores CONTENT_PASS_VERSION, not CLASSIFIER_VERSION (spec
  -- Section 7 "Versioning" — bullet 6). No type/constraint change.
  extracted_by                    TEXT,
  source_missive_conversation_id  TEXT,
  complaint_tracking_config_id    UUID          REFERENCES complaint_tracking_config(id),

  -- NEW — spec Section 7, bullet 3. Section 6's load-bearing fork: which
  -- run processed this conversation, never the age of the mail itself.
  -- Drives the hard gate on the home-page tile, the aging job, and DO
  -- assignment (below) — none of that machinery may ever consider a
  -- 'historical_backfill' row.
  discovery_context               TEXT          NOT NULL CHECK (discovery_context IN ('live_pipeline','historical_backfill')),

  -- NEW — spec Section 7, bullet 4. Section 6's bounded, must-be-
  -- affirmatively-cleared checklist (complaints_historical_review_
  -- required, Section E below) writes here. Nullable; meaningful only
  -- for a row that view would otherwise include.
  historical_review_cleared_at    TIMESTAMPTZ,
  historical_review_cleared_by    TEXT,

  possible_duplicate_of_id        UUID          REFERENCES complaints(id),
  duplicate_status                TEXT          NOT NULL DEFAULT 'none' CHECK (duplicate_status IN ('none', 'suggested', 'confirmed_merged', 'dismissed')),
  merged_into_id                  UUID          REFERENCES complaints(id),

  proposed_operational_note_id    UUID          REFERENCES operational_notes(id),

  created_at                      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- UNCHANGED FORMULA, per spec Section 7 ("Everything not listed below
  -- carries forward unchanged... the is_big_deal generated column").
  -- FLAGGED HERE, NOT SILENTLY CARRIED: under the OLD 6-value enum,
  -- category IS NOT NULL meant "the AI assigned one of six dedicated
  -- escalation categories" — a real, discriminating signal. Under the
  -- NEW shared 8-value taxonomy, Call 1 assigns a category to EVERY
  -- conversation it ever reads (including 'routine_logistics' and
  -- 'other'), and this trigger-logic comment above already establishes
  -- that a complaints row is only ever created once something actionable
  -- is already true. Net effect: for every source='email_ai' row, this
  -- generated column is now definitionally TRUE by construction (the row
  -- would not exist otherwise) — it only remains a real, discriminating
  -- signal for source='manual_staff' rows, which can still legitimately
  -- have category IS NULL. This is a genuine semantic gap the spec's own
  -- "carries forward unchanged" instruction does not resolve — Neo is
  -- naming it, not silently deciding whether it's acceptable. Oracle/
  -- Asimov should confirm a tautological-for-AI-rows flag is fine to
  -- ship as-is (arguably harmless, since it never gates anything by
  -- itself) or whether it should be dropped/redefined now that its
  -- reason for existing has partly evaporated.
  is_big_deal                     BOOLEAN GENERATED ALWAYS AS (
                                     category IS NOT NULL OR needs_human_call OR held_legal_fair_housing
                                   ) STORED,

  CONSTRAINT complaints_held_excludes_ai_fields CHECK (
    held_legal_fair_housing = FALSE OR (
      category IS NULL AND needs_human_call = FALSE AND description IS NULL
      AND flagged_protected_class = FALSE AND tone_trend IS NULL
      -- EXTENDED by this migration: a held row was never AI-categorized
      -- under the old design and is still never AI-categorized under the
      -- merged one (Section 7, bullet 7 — checkThread() is retired, and
      -- nothing in this merge gives held rows a new path to these two
      -- fields). Carrying the original five-column invariant forward
      -- without these two would let a held=TRUE row silently carry an
      -- AI-derived owner-instruction finding, contradicting the
      -- invariant this exact constraint already exists to enforce.
      AND escalation_signal IS NULL AND owner_instruction_rejected IS NULL
    )
  ),
  CONSTRAINT complaints_flag_requires_category CHECK (
    flagged_protected_class = FALSE OR flagged_category IS NOT NULL
  ),
  -- FIXED by this migration — a real correctness bug, not a style
  -- choice. The original constraint checked category = 'blocked_
  -- resolution', which was a legal CATEGORY value under the old 6-value
  -- enum. Under the new shared 8-value taxonomy, 'blocked_resolution' is
  -- an ESCALATION_SIGNAL value, never a category value (spec Section 7's
  -- own "Pre-existing typo, fixed here" note makes the identical point
  -- about a different constraint in the historical-review checklist).
  -- Carried forward literally, this CHECK would become permanently,
  -- silently vacuous — category can never equal 'blocked_resolution'
  -- under the new enum, so the constraint would always pass regardless
  -- of whether blocked_reason was ever set. Fixed to key on
  -- escalation_signal, matching what Call 2's own prompt (spec Section
  -- 5) actually requires: "If blocked_resolution, also set blocked_
  -- reason... and blocked_party."
  CONSTRAINT complaints_blocked_requires_reason CHECK (
    escalation_signal IS DISTINCT FROM 'blocked_resolution' OR blocked_reason IS NOT NULL
  ),
  CONSTRAINT complaints_resolved_requires_note CHECK (
    status IS DISTINCT FROM 'resolved' OR resolution_note IS NOT NULL
  ),
  CONSTRAINT complaints_source_requires_fields CHECK (
    (source = 'manual_staff' AND reported_by_team_member_id IS NOT NULL AND extracted_by IS NULL)
    OR (source = 'email_ai' AND held_legal_fair_housing = TRUE AND extracted_by IS NULL)
    OR (source = 'email_ai' AND held_legal_fair_housing = FALSE AND extracted_by IS NOT NULL)
  ),
  CONSTRAINT complaints_merge_requires_confirmed CHECK (
    merged_into_id IS NULL OR duplicate_status = 'confirmed_merged'
  ),
  -- EXTENDED by spec Section 7, bullet 5 — duplicate detection and
  -- complaint_tracking_config were tuned for live, day-to-day decisions;
  -- duplicate_window_days=3 is meaningless against a 2022 email. Extends
  -- the existing held-row exemption to also exempt historical_backfill
  -- rows.
  CONSTRAINT complaints_config_required_unless_held CHECK (
    held_legal_fair_housing = TRUE OR discovery_context = 'historical_backfill' OR complaint_tracking_config_id IS NOT NULL
  ),
  -- ADDED by this migration — not explicit SQL in the spec, but a direct
  -- enforcement of Call 2's own stated scope (spec Section 5: "OWNER
  -- INSTRUCTION CHECK — only if the conversation's category is owner_
  -- instruction"), using the same "field X requires condition Y" CHECK
  -- pattern this table already applies to flagged_category and blocked_
  -- reason above.
  CONSTRAINT complaints_owner_instruction_requires_category CHECK (
    owner_instruction_rejected IS NULL OR category = 'owner_instruction'
  )
);

ALTER TABLE complaints ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_complaints_property            ON complaints(property_id) WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_complaints_subject             ON complaints(subject_type, subject_id) WHERE subject_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_complaints_needs_matching      ON complaints(needs_matching) WHERE needs_matching = TRUE;
CREATE INDEX IF NOT EXISTS idx_complaints_duplicate_suggested ON complaints(duplicate_status) WHERE duplicate_status = 'suggested';
CREATE INDEX IF NOT EXISTS idx_complaints_big_deal_open       ON complaints(status) WHERE is_big_deal AND status != 'resolved';

-- CHANGED from the original — hard-gated to discovery_context =
-- 'live_pipeline' per spec Section 6's explicit instruction that the
-- 24-hour aging/escalation job (which this index exists to serve) may
-- NEVER consider a historical_backfill row.
CREATE INDEX IF NOT EXISTS idx_complaints_aging_candidates
  ON complaints(created_at) WHERE is_big_deal AND status NOT IN ('resolved') AND discovery_context = 'live_pipeline';

DROP TRIGGER IF EXISTS trg_complaints_updated_at ON complaints;
CREATE TRIGGER trg_complaints_updated_at
  BEFORE UPDATE ON complaints FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE complaints IS
  'One record per actionable finding from the merged significance/complaint pipeline (email_ai) or a manual staff report (manual_staff) — archive-search-significance-technical-spec.md Section 7, evolving the never-applied 20260910000000_complaint_tracking_schema.sql. Access restricted in application code to admin/director_of_operations for tool=''complaint_tracking'' (already a legal team_member_tool_roles.tool value live, per the finding at the top of this migration file — confirm current grants before use). Read the RULE 9 — HOUSING-DECISION FIREWALL comment earlier in this migration file before joining this table into any screening, renewal, eviction, or adverse-action tool. RLS enabled, zero permissive policies.';

COMMENT ON COLUMN complaints.discovery_context IS
  'Which run processed this conversation, never the age of the mail itself (spec Section 6). live_pipeline rows alone may ever reach the home-page red-badge tile, the 24-hour aging job (idx_complaints_aging_candidates above), or DO assignment via owner_team_member_id — a historical_backfill row must never be considered by any of that machinery, enforced at the index/query level, not just in the UI.';

COMMENT ON COLUMN complaints.owner_instruction_rejected IS
  'Tri-state: true/false for live mail, true/false/''uncertain'' for historical mail (spec Section 5/7) — widened from a hypothetical BOOLEAN for the same reason missive_conversation_significance.owner_instruction_rejected is. NULL unless category = ''owner_instruction'' (complaints_owner_instruction_requires_category). Per outside counsel''s opinion (compliance/archive-search-significance-outside-counsel-opinion.md, Question Two) and Mason''s confirmation, owner_instruction_note_text below is auto-drafted for live mail always, and for historical mail only when this is ''true'' — carrying the mandatory "Automated historical assessment — not human verified" label as part of the stored text itself.';

COMMENT ON COLUMN complaints.is_big_deal IS
  'UNCHANGED FORMULA from the never-applied 20260910000000 design (category IS NOT NULL OR needs_human_call OR held_legal_fair_housing) — but see the inline comment on this column''s own definition above: under the new shared 8-value category taxonomy, this is now definitionally TRUE for every source=''email_ai'' row (a complaints row is only ever created once something actionable is already true), and only remains a real, discriminating signal for source=''manual_staff'' rows. Flagged as a real, unresolved semantic gap for Oracle/Asimov, not silently decided here.';


-- ============================================================
-- SECTION D: missive_conversation_significance — spec Section 7's own
-- SQL sketch, transcribed with one corrected expression (is_big_issue,
-- flagged explicitly below) and two added constraints (dismissal_reason_
-- required — referenced by the spec as "unchanged from v1" but not
-- re-printed; and owner_instruction_requires_category — a new Neo
-- addition, same reasoning as complaints_owner_instruction_requires_
-- category above).
-- ============================================================

CREATE TABLE IF NOT EXISTS missive_conversation_significance (
  id                       UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_key              TEXT          NOT NULL,
  missive_conversation_id  TEXT          NOT NULL,

  resolution_status         TEXT         NOT NULL CHECK (resolution_status IN ('open', 'resolved', 'unknown')),
  category                   TEXT        NOT NULL CHECK (category IN (
                                 'routine_logistics','maintenance_standard','dispute','safety_issue',
                                 'legal_exposure','accommodation_related','owner_instruction','other'
                               )),
  why                          TEXT,
  tone_trend                    TEXT      CHECK (tone_trend IS NULL OR tone_trend IN ('stable','escalating')),
  protected_class_flag            BOOLEAN NOT NULL DEFAULT FALSE,
  protected_class_category         TEXT,

  keyword_check_flagged_protected_class BOOLEAN NOT NULL DEFAULT FALSE,
  keyword_check_flagged_category        TEXT,
  keyword_check_matched_layer           TEXT,
  keyword_check_terms_version           TEXT,

  pattern                     TEXT       NOT NULL DEFAULT 'unknown'
                                 CHECK (pattern IN ('first_occurrence', 'possible_recurrence', 'unknown')),

  content_identification_attempted BOOLEAN NOT NULL DEFAULT FALSE,
  source_screening_completed_at TIMESTAMPTZ NOT NULL,

  escalation_signal              TEXT     CHECK (escalation_signal IS NULL OR escalation_signal IN (
                                    'blocked_resolution','churn_risk','escalation_recurrence',
                                    'major_money_property_risk','none'
                                  )),
  needs_human_call                BOOLEAN NOT NULL DEFAULT FALSE,
  blocked_reason                    TEXT  CHECK (blocked_reason IS NULL OR blocked_reason IN ('explicit_refusal','inferred_from_silence')),
  blocked_party                      TEXT CHECK (blocked_party IS NULL OR blocked_party IN ('owner','tenant')),
  owner_instruction_rejected           TEXT CHECK (owner_instruction_rejected IS NULL OR owner_instruction_rejected IN ('true','false','uncertain')),
  owner_instruction_note_text           TEXT,
  call2_completed_at                      TIMESTAMPTZ,

  human_confirmed_big_issue        BOOLEAN,
  human_confirmed_big_issue_at     TIMESTAMPTZ,
  human_confirmed_big_issue_by     TEXT,
  human_confirmed_big_issue_reason TEXT,

  -- FIXED by this migration relative to the spec's own inline SQL sketch
  -- — a real NULL-propagation bug, not a style choice. The spec's
  -- Section 7 comment defends ONLY the third clause's use of IS TRUE
  -- (so an unreviewed human_confirmed_big_issue never turns the whole
  -- expression NULL) — it does not address the second clause. `escalation
  -- _signal IN (...)` is a plain SQL IN test: escalation_signal is NULL
  -- for every row until Call 2 has run (the spec's own Section 7 comment
  -- on this exact column: "NULL... means Call 2 has not run"), and `NULL
  -- IN (...)` evaluates to NULL, not FALSE. Copied verbatim, the spec's
  -- own sketch would make is_big_issue evaluate to NULL — not FALSE —
  -- for the majority of the archive (every row category doesn''t already
  -- qualify, human_confirmed_big_issue hasn''t been set, AND Call 2
  -- hasn''t run yet), because `FALSE OR NULL OR FALSE = NULL` under
  -- three-valued SQL logic. That is exactly the class of bug the spec''s
  -- own comment says it is guarding against, just missed on the middle
  -- clause. Fixed here by wrapping both non-human-decision clauses in
  -- their own IS TRUE, which — like the third clause — always returns a
  -- real TRUE/FALSE, never NULL, regardless of the underlying value:
  is_big_issue                     BOOLEAN GENERATED ALWAYS AS (
                                      (category IN ('legal_exposure', 'owner_instruction')) IS TRUE
                                      OR (escalation_signal IN (
                                           'blocked_resolution', 'churn_risk',
                                           'escalation_recurrence', 'major_money_property_risk'
                                         )) IS TRUE
                                      OR human_confirmed_big_issue IS TRUE
                                    ) STORED,

  discovery_context               TEXT    NOT NULL CHECK (discovery_context IN ('live_pipeline','historical_backfill')),
  complaint_id                     UUID    REFERENCES complaints(id) ON DELETE SET NULL,

  extracted_by                  TEXT     NOT NULL,
  computed_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  dismissed_at                TIMESTAMPTZ,
  dismissed_by                 TEXT,
  dismissal_reason               TEXT,

  UNIQUE (mailbox_key, missive_conversation_id),

  -- "Unchanged from v1" per the spec, not re-printed there — same
  -- lockstep-attribution discipline this schema applies to every other
  -- dismiss/reinstate pattern.
  CONSTRAINT missive_conversation_significance_dismissal_reason_required CHECK (
    dismissed_at IS NULL OR (
      dismissed_by IS NOT NULL AND dismissal_reason IS NOT NULL AND length(trim(dismissal_reason)) > 0
    )
  ),

  -- Spec Section 7, verbatim.
  CONSTRAINT missive_conversation_significance_human_confirmation_together CHECK (
    (human_confirmed_big_issue IS NULL AND human_confirmed_big_issue_at IS NULL AND human_confirmed_big_issue_by IS NULL AND human_confirmed_big_issue_reason IS NULL)
    OR (human_confirmed_big_issue IS NOT NULL AND human_confirmed_big_issue_at IS NOT NULL AND human_confirmed_big_issue_by IS NOT NULL AND human_confirmed_big_issue_reason IS NOT NULL AND human_confirmed_big_issue_reason <> '')
  ),

  -- ADDED by this migration — same reasoning and pattern as complaints_
  -- owner_instruction_requires_category above; Call 2 only ever answers
  -- this question when category = 'owner_instruction' (spec Section 5).
  CONSTRAINT missive_conversation_significance_owner_instruction_requires_category CHECK (
    owner_instruction_rejected IS NULL OR category = 'owner_instruction'
  ),

  -- ADDED by this migration — mirrors complaints_blocked_requires_reason
  -- (fixed above) on the table where Call 2 actually writes this field
  -- first. Call 2's own prompt (spec Section 5): "If blocked_resolution,
  -- also set blocked_reason... and blocked_party."
  CONSTRAINT missive_conversation_significance_blocked_requires_reason CHECK (
    escalation_signal IS DISTINCT FROM 'blocked_resolution' OR blocked_reason IS NOT NULL
  )
);

ALTER TABLE missive_conversation_significance ENABLE ROW LEVEL SECURITY;

-- Supports Section 6's "Needs a Human Call" review queue — the exact
-- filter the spec's own prose names: needs_human_call = TRUE, category
-- not already qualifying, no qualifying escalation_signal, and not yet
-- human-reviewed. No separate VIEW created for this (unlike complaints_
-- historical_review_required, which the spec explicitly names as a
-- view) — the spec describes this as "a plain list of pending items,"
-- Q's own query against this table; this index exists only to make that
-- query cheap.
CREATE INDEX IF NOT EXISTS idx_missive_conversation_significance_needs_human_call_queue
  ON missive_conversation_significance(computed_at)
  WHERE needs_human_call = TRUE
    AND human_confirmed_big_issue IS NULL
    AND category NOT IN ('legal_exposure', 'owner_instruction')
    AND (escalation_signal IS NULL OR escalation_signal = 'none');

-- Supports Property 360 and both compliance-review.html surfacing tabs —
-- "rows where is_big_issue = TRUE," split by discovery_context (Section
-- 9: the Historical Backlog tab shows historical_backfill, the live
-- Needs Attention tab shows live_pipeline; Property 360 reads both,
-- unsplit).
CREATE INDEX IF NOT EXISTS idx_missive_conversation_significance_big_issue
  ON missive_conversation_significance(discovery_context, computed_at)
  WHERE is_big_issue;

-- Historical owner_instruction_rejected = 'true' findings get their own
-- informational count and their own filtered Historical Backlog view
-- (spec Section 6's active-notification bound, third count) — cheap to
-- serve once this exists.
CREATE INDEX IF NOT EXISTS idx_missive_conversation_significance_owner_instruction_rejected
  ON missive_conversation_significance(discovery_context) WHERE owner_instruction_rejected = 'true';

DROP TRIGGER IF EXISTS trg_missive_conversation_significance_updated_at ON missive_conversation_significance;
-- NOTE: this table has no updated_at column in the spec's own sketch
-- (Section 7) — Call 1/Call 2 both write via computed_at, and dismiss/
-- reinstate via dismissed_at, so nothing here follows this schema's
-- usual id/created_at/updated_at house style. Flagged explicitly, same
-- as missive_message_intake's own documented departure from that house
-- style (20260905020000) — not an oversight. No trigger created.

COMMENT ON TABLE missive_conversation_significance IS
  'One row per (mailbox, conversation) — the merged Call 1/Call 2 significance and triage record (archive-search-significance-technical-spec.md Section 7). searcher-readable, unlike complaints (admin/director_of_operations-only) — see spec Section 7''s own reasoning for why this is two tables, not one. Read the RULE 9 — HOUSING-DECISION FIREWALL comment earlier in this migration file. RLS enabled, zero permissive policies. CCPA redaction posture for this table is an explicitly OPEN question (spec Section 11, Item 9) — not resolved by this migration; see the standalone Rule 4 data inventory document for the full statement of what''s open.';

COMMENT ON COLUMN missive_conversation_significance.is_big_issue IS
  'GENERATED ALWAYS ... STORED, per spec Section 6/7 — computed once so Property 360 and both compliance-review.html tabs agree by construction. See this column''s own inline definition comment above for a real NULL-propagation bug found and fixed in this migration relative to the spec''s own copy-pasted SQL sketch (the escalation_signal IN (...) clause, not just the human_confirmed_big_issue clause the spec''s own prose already defends).';

COMMENT ON COLUMN missive_conversation_significance.owner_instruction_note_text IS
  'Auto-drafted for live mail always, and for historical mail only when owner_instruction_rejected = ''true'' — carrying the mandatory "Automated historical assessment — not human verified" label as part of the stored text itself (outside counsel''s opinion, Question Two; Mason''s confirmation, Finding 2). NULL for historical mail when owner_instruction_rejected is ''false'' or ''uncertain''. No human reviews or approves this note before creation — a human reviews the underlying thread only before relying on it for a consequential action (spec Section 6''s reliance-gate rule, not a DB-enforced constraint).';

COMMENT ON COLUMN missive_conversation_significance.complaint_id IS
  'Nullable, one-way — set only when the trigger-logic condition documented at the top of this migration file created a linked complaints row. Mirrors complaints.proposed_operational_note_id''s directional, no-reciprocal-reference pattern. A row can be is_big_issue = TRUE with complaint_id NULL — the one remaining case (spec Section 7, Section 11 Item 13): a human-confirmed "Needs a Human Call" item that never separately trips category or escalation_signal never gets a complaints row at all.';


-- ============================================================
-- SECTION E: complaints_needing_attention (carried forward unchanged)
-- and complaints_historical_review_required (NEW — spec Section 6's
-- bounded, must-be-affirmatively-cleared checklist). Placed after
-- Section D, not before it: this view's own JOIN target,
-- missive_conversation_significance, must already exist as a real
-- table before CREATE VIEW can reference it — an ordering bug caught
-- and fixed while writing this file (an earlier draft placed this
-- section before the table it joins to, which would have failed
-- outright the moment Peter pasted it into Supabase's SQL Editor).
-- ============================================================

CREATE OR REPLACE VIEW complaints_needing_attention AS
SELECT c.* FROM complaints c
WHERE c.is_big_deal
  AND c.status != 'resolved'
  AND c.merged_into_id IS NULL
  AND (
    c.subject_type IS DISTINCT FROM 'tenant'
    OR c.subject_id IS NULL
    OR EXISTS (
      SELECT 1 FROM leases l WHERE l.tenant_id = c.subject_id AND l.status = 'active'
    )
  );

-- NEW. Spec Section 6: "A historical row must be surfaced on this
-- discrete, must-be-affirmatively-cleared list whenever: category IN
-- (legal_exposure, accommodation_related) OR escalation_signal IN
-- (blocked_resolution, major_money_property_risk), AND resolution_status
-- IN (open, unknown)." resolution_status lives on missive_conversation_
-- significance, not on complaints (complaints has its own, differently-
-- shaped status/resolution_note lifecycle) — the spec's own prose names
-- this view but does not show its SQL, so the join below is Neo's own,
-- necessary resolution of that gap, named explicitly rather than
-- assumed: join back to the originating significance row via s.
-- complaint_id = c.id (the same one-way FK Section C's complaint_id
-- comment describes, read from the other side). This correctly, and
-- intentionally, excludes any source=''manual_staff'' complaints row
-- from this specific view (no significance row exists to join to) —
-- consistent with this checklist existing only for the AI backfill
-- pipeline's own historical output, never for a human-filed report.
CREATE OR REPLACE VIEW complaints_historical_review_required AS
SELECT c.*
FROM complaints c
JOIN missive_conversation_significance s ON s.complaint_id = c.id
WHERE c.discovery_context = 'historical_backfill'
  AND c.historical_review_cleared_at IS NULL
  AND s.resolution_status IN ('open', 'unknown')
  AND (
    c.category IN ('legal_exposure', 'accommodation_related')
    OR c.escalation_signal IN ('blocked_resolution', 'major_money_property_risk')
  );

COMMENT ON VIEW complaints_historical_review_required IS
  'Spec Section 6''s bounded, must-be-affirmatively-cleared checklist — NOT the same population as the "Needs a Human Call" queue (disjoint by construction: this view only ever includes a row already is_big_issue = TRUE through category/escalation_signal; the queue only ever includes a row where needs_human_call is the sole signal). Clearing a row here means setting complaints.historical_review_cleared_at/_by (both together; no DB-level lockstep CHECK added here since neither column is ever set without the other by construction in Q''s future clearing action — a candidate for a future migration if that discipline should be DB-enforced too). Joins to missive_conversation_significance for resolution_status, which complaints itself does not carry — see the inline comment on this view''s own definition above.';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- -- Views first — complaints_historical_review_required JOINs
-- -- missive_conversation_significance, so it must be dropped before
-- -- that table, not after (an ordering bug caught and fixed in this
-- -- same file's forward-build section D/E; the rollback needs the
-- -- identical fix in reverse — DROP TABLE on a table a view still
-- -- references fails with a dependency error).
-- DROP VIEW IF EXISTS complaints_historical_review_required;
-- DROP VIEW IF EXISTS complaints_needing_attention;
--
-- DROP INDEX IF EXISTS idx_missive_conversation_significance_owner_instruction_rejected;
-- DROP INDEX IF EXISTS idx_missive_conversation_significance_big_issue;
-- DROP INDEX IF EXISTS idx_missive_conversation_significance_needs_human_call_queue;
-- DROP TABLE IF EXISTS missive_conversation_significance;
-- -- Confirm no real row exists first if this has been applied for any
-- -- length of time (ccpa_exportable = TRUE per the Rule 4 inventory —
-- -- consider exporting first).
--
-- DROP TRIGGER IF EXISTS trg_complaints_updated_at ON complaints;
-- DROP INDEX IF EXISTS idx_complaints_aging_candidates;
-- DROP INDEX IF EXISTS idx_complaints_big_deal_open;
-- DROP INDEX IF EXISTS idx_complaints_duplicate_suggested;
-- DROP INDEX IF EXISTS idx_complaints_needs_matching;
-- DROP INDEX IF EXISTS idx_complaints_subject;
-- DROP INDEX IF EXISTS idx_complaints_property;
-- DROP TABLE IF EXISTS complaints;
-- -- Same caveat as above — confirm nothing depends on it and consider
-- -- exporting first if any real row exists (a held_legal_fair_housing =
-- -- TRUE row in particular must never simply be dropped without a fresh
-- -- legal-hold check first).
--
-- DROP TRIGGER IF EXISTS trg_complaint_tracking_config_updated_at ON complaint_tracking_config;
-- DROP INDEX IF EXISTS idx_complaint_tracking_config_one_active;
-- DROP TABLE IF EXISTS complaint_tracking_config;
--
-- DROP INDEX IF EXISTS idx_missive_message_links_unique_link;
-- DROP INDEX IF EXISTS idx_missive_message_links_property;
-- DROP INDEX IF EXISTS idx_missive_message_links_subject;
-- DROP INDEX IF EXISTS idx_missive_message_links_conversation;
-- DROP TABLE IF EXISTS missive_message_links;
--
-- -- team_member_tool_roles is never touched by this migration (see the
-- -- finding at the top of this file) — nothing to roll back there.
--
-- ============================================================
