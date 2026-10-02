-- ============================================================
-- Migration: 20261002060000_add_name_match_human_review_to_complaints
-- Created:   2026-10-02
-- Author:    Neo (database specialist)
--
-- Schema for the NARROWER, human-confirmed version of name-based
-- complaint-to-person matching — relayed via Jarvis, with Peter's explicit
-- approval for building THIS specific version (not full-automatic
-- resolution, which Mason said to abandon outright). No standalone Oracle
-- spec file exists for this one yet — same gap this table's own prior
-- migration (20261002010000, severity tiering) already flagged for its own
-- build; flagged again here rather than silently filled.
--
-- Mason's real review (relayed verbatim on the key points, not yet its own
-- saved compliance doc) set three hard conditions this schema is built to
-- satisfy:
--   1. A human confirming from a bare name alone has little advantage over
--      the AI unless the review surface actively exposes a real collision
--      (e.g. "2 owners named Jane Doe on file," each with their own
--      property) — the reviewer must disambiguate with real information,
--      not just rubber-stamp a single guess.
--   2. The matching condition itself should narrow, not just add a human:
--      require the AI's named-tenant/owner guess to also agree with a
--      property this pipeline can already resolve (the existing, already-
--      approved property content-extraction path) — on real data, zero of
--      13 tenant name-collision groups shared an active-lease property, so
--      this one check collapses most ambiguity before a human ever sees it.
--   3. Audit-trail parity must go further than the existing vendor
--      content-extraction pattern: the record needs who confirmed it and
--      when, and a match_method value that can never be silently treated
--      as equivalent to address_match or plain content_extracted by
--      anything built later.
--
-- This migration is schema only. It does not write the AI prompt that
-- extracts a tenant/owner name reference, the candidate-lookup function
-- (necessarily NOT resolveUniqueMatch() — that function collapses >1 match
-- to "no match"; this feature's whole point is to surface >1 match to a
-- human instead), the property-corroboration join, the review UI, or the
-- shadow-mode env-var gate. All Q's build, on top of this schema, once
-- Q has a plan reviewed. This migration is NOT applied here — Peter
-- applies it himself via Supabase's SQL Editor, per this project's
-- standing convention (no CLI/DB URL in this environment).
--
-- ============================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT BUILD
-- ============================================================
--   - Any change to significance-pass.js's IDENTIFICATION_BLOCK/
--     buildCall1Prompt() to actually ask the model for a tenant/owner name
--     reference. Today that prompt deliberately asks ONLY for property_text
--     /vendor_text — the comment on IDENTIFICATION_BLOCK explains why
--     (tenant/owner identification by name alone was the thing Mason's
--     review was about). Q's build, against this schema.
--   - The candidate-lookup function itself. resolveUniqueMatch() (used
--     today for property/vendor) is the WRONG function to reuse here on
--     purpose — it returns null on more than one match, which is exactly
--     the case this feature exists to surface to a human instead of
--     discarding. Q needs a new function that returns ALL name matches
--     against the tenants/owners directories, not just a unique one.
--   - The property-corroboration logic Mason's point 2 requires. This
--     migration adds no new column for it — see "WHY NO NEW COLUMN FOR
--     PROPERTY CORROBORATION" below for why that's a deliberate finding,
--     not an oversight, and what it actually relies on existing.
--   - The review UI, or any change to complaint-tracking/router.js.
--   - The shadow-mode env-var gate (e.g. a SUBJECT_MATCH_LIVE_PIPELINE_
--     ENABLED-shaped flag). Nothing in this schema needs to know whether
--     that flag is set — see "SHADOW-MODE SUPPORT IS STRUCTURAL, NOT A
--     SCHEMA BRANCH" below.
--   - Any change to complaints_needing_attention or any router/home-count
--     endpoint. This feature resolves WHO a complaint is about; it does
--     not change which complaints are shown or hidden.
--
-- ============================================================
-- DESIGN DECISION 1 — COLUMNS ON `complaints`, NOT A NEW TABLE
-- ============================================================
-- The task brief offered either new columns on complaints or a separate
-- table, flagging the one-to-many candidate list as the reason a separate
-- table might be needed. Worked through concretely: this feature only
-- matters for a complaint that ALREADY EXISTS with no resolved subject —
-- exactly the population complaints.needs_matching already identifies
-- (idx_complaints_needs_matching, live since 20260910000000). That makes
-- this a strict one-to-one enrichment of an existing complaints row, not a
-- one-to-many relationship at the TABLE level — the one-to-many part is
-- entirely contained within a single array-typed column
-- (suggested_subject_candidate_ids, below), the same way this table
-- already holds a one-to-many "which config version" relationship as a
-- single column (complaint_tracking_config_id) rather than a join table.
-- This is mechanically identical in shape to severity_tier/severity_
-- rationale/severity_assessed_at/severity_rubric_version (20261002010000):
-- nullable-until-assessed AI output, written together, on the complaint it
-- describes. Same grouped-prefix convention (suggested_subject_*, human_
-- confirmed_subject_*), same house style, same table. A separate table
-- would mean a new RLS surface, a new index strategy, and an extra join for
-- every reviewer screen that already shows a complaint — real cost with no
-- matching benefit once the cardinality question is settled. Simple is
-- better than clever, per CLAUDE.md's own standing instruction — chosen
-- explicitly, not by default.
--
-- ============================================================
-- DESIGN DECISION 2 — NATIVE UUID[] ARRAY FOR CANDIDATES, NOT JSONB
-- ============================================================
-- The task brief's own sketch named this suggested_subject_candidates as
-- "a JSON array." Checked against this schema's real, existing convention
-- before following that literally: audit_log.regulation_tags is already a
-- native TEXT[] array column (20260815000000) — this schema already uses
-- Postgres arrays for exactly this "small list of same-typed values" shape,
-- not JSONB. A plain UUID[] here is strongly typed (every element is
-- validated as a UUID, not an arbitrary JSON shape), directly usable with
-- `= ANY(...)` in a CHECK constraint (used below) and with `unnest()` in a
-- query, and holds IDS ONLY — not denormalized name/property snapshots.
-- Candidate names and properties are looked up LIVE at review time by
-- joining to tenants/owners/leases/property_owners (Q's job), the same
-- "no enforced FK, no denormalized copy" discipline subject_id already
-- follows elsewhere on this table. A JSON blob holding a stale name/
-- property snapshot would drift the moment a tenant moves units; an array
-- of ids cannot drift, because there is nothing in it to go stale.
--
-- ============================================================
-- WHY NO NEW COLUMN FOR PROPERTY CORROBORATION (checked, not assumed)
-- ============================================================
-- The task brief says Mason's point 2 "doesn't need new schema... the
-- application layer will have what it needs: the already-resolved
-- property_id from the SAME Call 1 pass." Checked directly against
-- significance-pass.js before accepting that claim at face value, because
-- an almost-identical value (the content-extracted property_id from
-- call1.identification.property_text, resolved inside applyCall1Result())
-- is NOT persisted anywhere today when a conversation never produces a
-- complaint — it lives only as an in-memory local variable, passed to
-- createComplaintRow() ONLY if shouldCreateComplaint() gates true. If this
-- feature operated at the CONVERSATION level (like property/vendor
-- identification does), that would be a real gap: a later, asynchronous
-- human-review step would have no durable property_id to corroborate
-- against for a conversation that was processed non-committally.
--
-- It is NOT a gap for the actual feature this migration implements, for
-- the same reason Design Decision 1 holds: this operates at the COMPLAINT
-- level, not the conversation level, and complaints.property_id is a real,
-- persisted, NOT-ephemeral column on the very row this feature enriches
-- (set at createComplaintRow() time, carried forward on the complaint for
-- its entire life). By the time a complaint exists with needs_matching =
-- TRUE, its property_id (possibly NULL, if property identification also
-- failed) already survives on that row with no extra column needed. The
-- task brief's claim is therefore correct, but only because of Design
-- Decision 1 above — restated here so that claim isn't taken on faith
-- without the reasoning that actually makes it true.
--
-- ============================================================
-- SHADOW-MODE SUPPORT IS STRUCTURAL, NOT A SCHEMA BRANCH
-- ============================================================
-- suggested_subject_*/human_confirmed_subject_* are entirely independent
-- columns from subject_type/subject_id. Writing the former never requires
-- writing the latter — Q's application code can populate a full suggestion
-- and its human-reviewed outcome while leaving subject_type/subject_id
-- untouched (shadow mode), or can additionally write subject_type/
-- subject_id once a flag allows it (live mode). The one piece of real
-- enforcement this migration adds (complaints_human_confirmed_subject_
-- matches_written, below) only ever fires once BOTH are written — it is a
-- bug guard, never a requirement to write subject_id at all. No env var,
-- no mode flag, and no DB-level distinction between shadow and live exists
-- anywhere in this file, confirming the task brief's own expectation.
--
-- ============================================================
-- A DELIBERATE OMISSION — NO CHECK FORBIDDING A SUGGESTION ON AN ALREADY-
-- RESOLVED COMPLAINT
-- ============================================================
-- An earlier draft of this migration added a CHECK requiring subject_type/
-- subject_id to be NULL whenever suggested_subject_type is set, reasoning
-- that a suggestion should only ever exist for an unmatched complaint. That
-- CHECK is WRONG and is not in the forward SQL below: the live-mode
-- confirmation path legitimately moves a row from (suggested, unconfirmed,
-- subject NULL) to (suggested, confirmed, subject SET) — a hard CHECK
-- forcing subject_type NULL whenever a suggestion exists would make that
-- transition impossible to persist. The real invariant worth enforcing at
-- the DB level is the one actually added: once BOTH human_confirmed_
-- subject_id and subject_id are set, they must agree (complaints_human_
-- confirmed_subject_matches_written) — a guard against the write path
-- disagreeing with itself, not a ban on the write path running at all.
-- Whether to even ATTEMPT name-matching on a complaint that already has an
-- address-matched subject is Q's application-code responsibility (check
-- needs_matching first), same as it already is for property/vendor
-- identification today.
--
-- ============================================================
-- NAMING — ONE DELIBERATE DEPARTURE FROM THE TASK BRIEF'S OWN WORDING
-- ============================================================
-- Mason's relayed wording was "human_confirmed_by, human_confirmed_at."
-- This table already has zero existing human_confirmed_* columns of its
-- own (historical_review_cleared_by/_at is a differently-named prior
-- example of the same "who/when" shape, on a different workflow), but it
-- is realistic more human-confirmation-shaped columns land on this table
-- later. Named human_confirmed_subject_by/_at/_outcome/_id here, with the
-- _subject_ infix, so a future, unrelated human-confirmation column never
-- collides with or gets confused for this one. missive_message_links
-- (Section B) uses the bare human_confirmed_by/_at Mason actually asked
-- for, since that table has only one kind of human confirmation to ever
-- record and no such ambiguity risk exists there.
--
-- ============================================================
-- RULE 4 DATA INVENTORY ADDENDUM (GOVERNANCE.md Rule 4) — complaints and
-- missive_message_links are already registered tables (20260910000000 and
-- 20260913020000's own Rule 4 blocks). New PII-adjacent fields only, not a
-- repeat of the existing writeups:
-- ============================================================
--   complaints.suggested_subject_name_text — free-text AI-quoted name
--     reference (same citation discipline as missive_message_links.
--     source_reference); lower density than `description` but can
--     directly name a real person.
--   complaints.suggested_subject_candidate_ids — array of tenants.id |
--     owners.id. Identifies specific people, same PII class as subject_id
--     elsewhere on this table (Rule 9 firewall applies identically — see
--     20260913020000's own Rule 9 comment; a candidate list is no less
--     Fair-Housing-adjacent than a resolved subject_id would be).
--   complaints.human_confirmed_subject_id — same PII class as subject_id.
--   complaints.human_confirmed_subject_by / missive_message_links.
--     human_confirmed_by — a staff identifier (email), same class as
--     complaint_tracking_config.set_by / missive_conversation_
--     significance.human_confirmed_big_issue_by elsewhere in this schema;
--     not personal data about a tenant/owner.
--   agents_with_access / retention_policy / ccpa_exportable / ccpa_
--     deletable: unchanged in kind from each table's existing Rule 4
--     entry. suggested_subject_name_text redacts via the same description
--     -> "[REDACTED]" convention already on record for complaints, with
--     the same held_legal_fair_housing hard-refuse carve-out (moot here
--     regardless, since the held-row exclusion below guarantees this field
--     stays NULL on every held row).
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No. Nine new nullable columns on
--       complaints, two new nullable columns on missive_message_links, both
--       added via ADD COLUMN IF NOT EXISTS with no default — every existing
--       row gets NULL throughout, which is exactly "no suggestion yet" /
--       "not a human-confirmed row." The one existing constraint widened on
--       each table (complaints_held_excludes_ai_fields; missive_message_
--       links_address_match_fields and _content_extracted_fields) is
--       trivially satisfied by every existing row today, since the columns
--       they newly reference are brand new and start NULL everywhere.
--   [x] Does this touch a table other code depends on? Yes — complaints is
--       read by complaint-tracking/router.js and both complaints_* views;
--       missive_message_links is read by subject-match.js and Property
--       360's "linked conversations" surfacing. All existing reads either
--       SELECT * (gaining nine/two extra NULL columns, no behavior change)
--       or name columns explicitly (unaffected, since none of them name a
--       column this migration adds). The match_method CHECK widening is a
--       pure superset of today's two legal values — no existing row's
--       match_method value is affected.
--   [x] Additive or destructive? Fully additive — eleven new columns
--       across two tables, seven new CHECK constraints, two existing CHECK
--       constraints widened (both pure supersets of what they allow today),
--       one new partial index. No column dropped, no existing column's
--       type/default changed, no row updated.
--   [ ] Tested on a copy of the data first? No staging copy of Supabase
--       exists in this project — same standing caveat every migration here
--       carries. Mitigated by: every new column is new and starts NULL on
--       every row; every widened constraint can only ever reject a FUTURE
--       write attempting an invalid combination of these brand-new columns
--       — there is no such write today, and this migration doesn't add one.
--   [x] Governance go-ahead to build this specific schema — Peter's
--       explicit approval for THIS narrower, human-confirmed version is on
--       record (relayed via Jarvis); Mason's own conditions are the three
--       this migration is built to satisfy, cited above. Full-automatic
--       resolution, which Mason said to abandon outright, is not built
--       anywhere in this file. Not a go-ahead to run the matching/
--       corroboration logic against real complaints, write subject_type/
--       subject_id from a confirmed candidate, or ship the review UI —
--       those are Q's later build, on top of this schema, with their own
--       gate.
-- ============================================================


-- ============================================================
-- SECTION A: complaints — nine new nullable columns, two lockstep groups.
-- ============================================================

ALTER TABLE complaints
  ADD COLUMN IF NOT EXISTS suggested_subject_type          TEXT
    CHECK (suggested_subject_type IS NULL OR suggested_subject_type IN ('tenant', 'owner')),
  ADD COLUMN IF NOT EXISTS suggested_subject_name_text      TEXT,
  ADD COLUMN IF NOT EXISTS suggested_subject_candidate_ids  UUID[],
  ADD COLUMN IF NOT EXISTS suggested_subject_extracted_by   TEXT,
  ADD COLUMN IF NOT EXISTS suggested_subject_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS human_confirmed_subject_outcome  TEXT
    CHECK (human_confirmed_subject_outcome IS NULL OR human_confirmed_subject_outcome IN ('confirmed', 'rejected')),
  ADD COLUMN IF NOT EXISTS human_confirmed_subject_id       UUID,
  ADD COLUMN IF NOT EXISTS human_confirmed_subject_by       TEXT,
  ADD COLUMN IF NOT EXISTS human_confirmed_subject_at       TIMESTAMPTZ;

-- Lockstep group 1: the AI's suggestion. Either not yet attempted (all
-- five NULL) or a real suggestion with every supporting field present
-- (same "no partial state" discipline as complaints_severity_fields_
-- together, 20261002010000). A suggestion with zero real candidates is
-- never written at all (complaints_suggested_subject_candidates_nonempty,
-- below) — same "zero rows for genuinely unmatchable" philosophy
-- missive_message_links already documents for its own content-extracted
-- path, applied here to a column group instead of a table row.
ALTER TABLE complaints
  ADD CONSTRAINT complaints_suggested_subject_fields_together CHECK (
    (suggested_subject_type IS NULL AND suggested_subject_name_text IS NULL
      AND suggested_subject_candidate_ids IS NULL AND suggested_subject_extracted_by IS NULL
      AND suggested_subject_at IS NULL)
    OR
    (suggested_subject_type IS NOT NULL AND suggested_subject_name_text IS NOT NULL
      AND suggested_subject_candidate_ids IS NOT NULL AND suggested_subject_extracted_by IS NOT NULL
      AND suggested_subject_at IS NOT NULL)
  );

-- A suggestion with no real candidate is not a suggestion — mirrors the
-- existing content_extracted path on missive_message_links, which only
-- ever writes a row when resolveUniqueMatch() actually found something.
ALTER TABLE complaints
  ADD CONSTRAINT complaints_suggested_subject_candidates_nonempty CHECK (
    suggested_subject_candidate_ids IS NULL OR cardinality(suggested_subject_candidate_ids) >= 1
  );

-- Lockstep group 2: the human review event itself (outcome/by/at travel
-- together — Mason's audit-trail-parity requirement, point 3). A pending
-- (not-yet-reviewed) suggestion has all three NULL.
ALTER TABLE complaints
  ADD CONSTRAINT complaints_human_confirmed_subject_review_together CHECK (
    (human_confirmed_subject_outcome IS NULL AND human_confirmed_subject_by IS NULL AND human_confirmed_subject_at IS NULL)
    OR
    (human_confirmed_subject_outcome IS NOT NULL AND human_confirmed_subject_by IS NOT NULL AND human_confirmed_subject_at IS NOT NULL)
  );

-- A review can only happen once something was actually suggested.
ALTER TABLE complaints
  ADD CONSTRAINT complaints_human_confirmed_subject_requires_suggestion CHECK (
    human_confirmed_subject_outcome IS NULL OR suggested_subject_type IS NOT NULL
  );

-- human_confirmed_subject_id is set IFF the outcome is 'confirmed' —
-- 'rejected' means "none of these candidates, confirmed by a human," not
-- a particular wrong guess.
ALTER TABLE complaints
  ADD CONSTRAINT complaints_human_confirmed_subject_outcome_id_matches CHECK (
    (human_confirmed_subject_outcome IS DISTINCT FROM 'confirmed' AND human_confirmed_subject_id IS NULL)
    OR
    (human_confirmed_subject_outcome = 'confirmed' AND human_confirmed_subject_id IS NOT NULL)
  );

-- Mason's point 1, enforced structurally, not just by UI convention: a
-- human cannot confirm a candidate that was never actually offered.
ALTER TABLE complaints
  ADD CONSTRAINT complaints_human_confirmed_subject_id_is_candidate CHECK (
    human_confirmed_subject_id IS NULL OR human_confirmed_subject_id = ANY(suggested_subject_candidate_ids)
  );

-- The real bug guard (see "A DELIBERATE OMISSION" above for why this is
-- the right invariant and not a ban on writing subject_id at all): once
-- BOTH the confirmed candidate and the actually-written subject exist,
-- they must agree. Silent on whether subject_id is ever written —
-- shadow mode leaves it NULL forever; live mode sets it to match.
ALTER TABLE complaints
  ADD CONSTRAINT complaints_human_confirmed_subject_matches_written CHECK (
    human_confirmed_subject_id IS NULL OR subject_id IS NULL OR human_confirmed_subject_id = subject_id
  );

-- Extends the existing held-row invariant (complaints_held_excludes_ai_
-- fields, last widened 20261002010000 to add severity_tier) to this new
-- column group — a held row gets no automated name-match suggestion,
-- same as it gets no category, no severity_tier, no escalation_signal.
-- Checking suggested_subject_type alone is sufficient: the lockstep CHECK
-- above already forces the other four suggestion columns to NULL whenever
-- it is, and complaints_human_confirmed_subject_requires_suggestion above
-- already forces every human_confirmed_subject_* column to NULL whenever
-- suggested_subject_type is NULL — so one clause here transitively
-- guarantees all nine new columns stay NULL on a held row.
ALTER TABLE complaints
  DROP CONSTRAINT IF EXISTS complaints_held_excludes_ai_fields;
ALTER TABLE complaints
  ADD CONSTRAINT complaints_held_excludes_ai_fields CHECK (
    held_legal_fair_housing = FALSE OR (
      category IS NULL AND needs_human_call = FALSE AND description IS NULL
      AND flagged_protected_class = FALSE AND tone_trend IS NULL
      AND escalation_signal IS NULL AND owner_instruction_rejected IS NULL
      AND severity_tier IS NULL
      AND suggested_subject_type IS NULL
    )
  );


-- ============================================================
-- INDEX — the review queue's own driver: "complaints with a pending name-
-- match suggestion awaiting human review." Same partial-index shape as
-- idx_complaints_needs_matching / idx_complaints_severity_unassessed.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_complaints_suggested_subject_pending
  ON complaints(created_at)
  WHERE suggested_subject_type IS NOT NULL AND human_confirmed_subject_outcome IS NULL;


-- ============================================================
-- SECTION B: missive_message_links — the new match_method value, two new
-- columns, and the field-presence CHECKs this table already enforces per
-- match_method, extended to cover them (Mason's point 3 — audit-trail
-- parity, applied to the PERMANENT link record, not just the review-queue
-- columns in Section A).
-- ============================================================

ALTER TABLE missive_message_links
  ADD COLUMN IF NOT EXISTS human_confirmed_by TEXT,
  ADD COLUMN IF NOT EXISTS human_confirmed_at TIMESTAMPTZ;

-- New, distinct, self-describing value — never confusable with
-- address_match (deterministic, no AI involved) or content_extracted
-- (AI-derived, no human review). Named explicitly so nothing built later
-- can silently treat a human-confirmed name match as equivalent to an
-- address-verified one (Mason's point 3, verbatim requirement).
ALTER TABLE missive_message_links
  DROP CONSTRAINT IF EXISTS missive_message_links_match_method_check;
ALTER TABLE missive_message_links
  ADD CONSTRAINT missive_message_links_match_method_check
  CHECK (match_method IN ('address_match', 'content_extracted', 'content_extracted_human_confirmed'));

-- Widened only to also require the two new columns stay NULL on the two
-- existing match methods — zero change to what either constraint already
-- enforced about matched_field/source_reference/confidence/extracted_by.
ALTER TABLE missive_message_links
  DROP CONSTRAINT IF EXISTS missive_message_links_address_match_fields;
ALTER TABLE missive_message_links
  ADD CONSTRAINT missive_message_links_address_match_fields CHECK (
    match_method IS DISTINCT FROM 'address_match' OR (
      matched_field IS NOT NULL AND source_reference IS NULL
      AND confidence IS NULL AND extracted_by IS NULL
      AND human_confirmed_by IS NULL AND human_confirmed_at IS NULL
    )
  );

ALTER TABLE missive_message_links
  DROP CONSTRAINT IF EXISTS missive_message_links_content_extracted_fields;
ALTER TABLE missive_message_links
  ADD CONSTRAINT missive_message_links_content_extracted_fields CHECK (
    match_method IS DISTINCT FROM 'content_extracted' OR (
      source_reference IS NOT NULL AND confidence IS NOT NULL
      AND extracted_by IS NOT NULL AND matched_field IS NULL
      AND human_confirmed_by IS NULL AND human_confirmed_at IS NULL
    )
  );

-- The new match method's own field-presence rule: carries the same AI-
-- derived triple content_extracted already requires (source_reference/
-- confidence/extracted_by — the ORIGINAL suggestion's own provenance,
-- left as-is, not overwritten to imply false certainty), PLUS the two
-- human fields content_extracted never has. matched_field stays NULL —
-- this was never a deterministic address match.
ALTER TABLE missive_message_links
  ADD CONSTRAINT missive_message_links_content_extracted_human_confirmed_fields CHECK (
    match_method IS DISTINCT FROM 'content_extracted_human_confirmed' OR (
      source_reference IS NOT NULL AND confidence IS NOT NULL
      AND extracted_by IS NOT NULL AND matched_field IS NULL
      AND human_confirmed_by IS NOT NULL AND human_confirmed_at IS NOT NULL
    )
  );

-- Mason's point 2's narrowing, restated structurally: this new match
-- method exists ONLY because tenant/owner identification by name carries
-- real risk a human must review (IDENTIFICATION_BLOCK's own comment on why
-- vendor never needed this). Vendor content-extraction stays on the plain
-- content_extracted path, with no human-review requirement, exactly as it
-- is today — this CHECK keeps that true by construction, not by
-- convention Q has to remember.
ALTER TABLE missive_message_links
  ADD CONSTRAINT missive_message_links_human_confirmed_requires_person CHECK (
    match_method IS DISTINCT FROM 'content_extracted_human_confirmed' OR subject_type IN ('tenant', 'owner')
  );


-- ============================================================
-- COMMENTS
-- ============================================================

COMMENT ON COLUMN complaints.suggested_subject_type IS
  'AI-suggested subject type (tenant or owner only — never vendor/property/team_member) awaiting human review, per the narrower, Mason-cleared name-based-matching design. NULL means no suggestion has ever been made. Always set together with the other four suggested_subject_* columns (complaints_suggested_subject_fields_together) — never a partial state. Structurally excluded on a held_legal_fair_housing = TRUE row (complaints_held_excludes_ai_fields), same as every other AI-derived field on this table.';

COMMENT ON COLUMN complaints.suggested_subject_name_text IS
  'The exact quoted sentence/phrase the AI cited as naming a tenant or owner — same citation discipline missive_message_links.source_reference already requires for content_extracted rows. Never an AI-guessed id by itself.';

COMMENT ON COLUMN complaints.suggested_subject_candidate_ids IS
  'tenants.id | owners.id (per suggested_subject_type), one per real name-collision candidate on file — NOT a single top pick. No enforced FK, same polymorphic no-FK convention subject_id already uses; native UUID[] chosen over JSONB to match this schema''s existing array convention (audit_log.regulation_tags) and to hold ids only, never a denormalized name/property snapshot that could drift. Never empty when set (complaints_suggested_subject_candidates_nonempty) — a name with zero directory matches produces no suggestion row at all. The review surface must show every id here with its own real property (joined live, not stored) — a single-candidate array still requires human confirmation; this column existing says nothing about how many candidates there were.';

COMMENT ON COLUMN complaints.suggested_subject_extracted_by IS
  'CONTENT_PASS_VERSION-style version string for whichever pass produced this suggestion — same versioning convention as complaints.extracted_by and missive_message_links.extracted_by. Free text, no CHECK, same reasoning as those columns.';

COMMENT ON COLUMN complaints.suggested_subject_at IS
  'When this suggestion was produced — may be well after created_at, if a later backfill pass (not this complaint''s original creation) is what generates the suggestion. Distinct from human_confirmed_subject_at, which is when a human acted on it.';

COMMENT ON COLUMN complaints.human_confirmed_subject_outcome IS
  '''confirmed'' (a human picked one real candidate) or ''rejected'' (a human reviewed the candidate list and confirmed none of them is right) — NULL means still pending human review. Always set together with human_confirmed_subject_by/_at (complaints_human_confirmed_subject_review_together); can only be set when a suggestion actually exists (complaints_human_confirmed_subject_requires_suggestion).';

COMMENT ON COLUMN complaints.human_confirmed_subject_id IS
  'Which candidate from suggested_subject_candidate_ids a human actually confirmed — set IFF human_confirmed_subject_outcome = ''confirmed'' (complaints_human_confirmed_subject_outcome_id_matches), and must be one of the offered candidates (complaints_human_confirmed_subject_id_is_candidate) — Mason''s point 1, enforced structurally: a human cannot confirm a candidate that was never shown. Writing this column never requires also writing subject_id/subject_type — that is a separate, shadow-mode-gated application-layer decision (see this migration''s own "SHADOW-MODE SUPPORT" note); the only DB-level rule is that if BOTH are ever set, they must agree (complaints_human_confirmed_subject_matches_written).';

COMMENT ON COLUMN complaints.human_confirmed_subject_by IS
  'Staff identifier (email) of who reviewed the suggestion — Mason''s point 3, audit-trail parity. Named with the _subject_ infix (not bare human_confirmed_by, which Mason''s own wording used) because this table already has other human-confirmation-shaped workflows (historical_review_cleared_by) and will likely grow more; this naming keeps a future one from colliding with or being confused for this one.';

COMMENT ON COLUMN complaints.human_confirmed_subject_at IS
  'When human_confirmed_subject_by made the call. NULL exactly when human_confirmed_subject_outcome is NULL (complaints_human_confirmed_subject_review_together).';

COMMENT ON COLUMN missive_message_links.match_method IS
  'address_match (deterministic, participant email matched a record on file) | content_extracted (AI-cited property/vendor text, verified against a directory, zero human review — vendor only in practice today, per IDENTIFICATION_BLOCK''s own comment on why tenant/owner never uses this path) | content_extracted_human_confirmed (AI-cited tenant/owner name text, directory-matched to one or more candidates, a human then confirmed exactly one — the narrower, Mason-cleared design; never vendor, enforced by missive_message_links_human_confirmed_requires_person). The three values are deliberately never treated as equivalent by anything downstream — complaints.subject_type/subject_id was, and remains, writable from address_match without restriction; writing it from a content_extracted_human_confirmed suggestion is a separate, shadow-mode-gated application decision (see complaints.human_confirmed_subject_id''s own comment); writing it from plain content_extracted is still never permitted, unchanged from 20260913020000.';

COMMENT ON COLUMN missive_message_links.human_confirmed_by IS
  'Staff identifier (email) of who confirmed this link, for match_method = ''content_extracted_human_confirmed'' only (missive_message_links_content_extracted_human_confirmed_fields) — NULL for address_match and content_extracted rows, which carry no human review of any kind.';

COMMENT ON COLUMN missive_message_links.human_confirmed_at IS
  'When human_confirmed_by made the call. NULL exactly when human_confirmed_by is NULL, for the same match_method-conditioned reason.';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- ALTER TABLE missive_message_links
--   DROP CONSTRAINT IF EXISTS missive_message_links_human_confirmed_requires_person;
-- ALTER TABLE missive_message_links
--   DROP CONSTRAINT IF EXISTS missive_message_links_content_extracted_human_confirmed_fields;
--
-- ALTER TABLE missive_message_links
--   DROP CONSTRAINT IF EXISTS missive_message_links_content_extracted_fields;
-- ALTER TABLE missive_message_links
--   ADD CONSTRAINT missive_message_links_content_extracted_fields CHECK (
--     match_method IS DISTINCT FROM 'content_extracted' OR (
--       source_reference IS NOT NULL AND confidence IS NOT NULL
--       AND extracted_by IS NOT NULL AND matched_field IS NULL
--     )
--   );
--
-- ALTER TABLE missive_message_links
--   DROP CONSTRAINT IF EXISTS missive_message_links_address_match_fields;
-- ALTER TABLE missive_message_links
--   ADD CONSTRAINT missive_message_links_address_match_fields CHECK (
--     match_method IS DISTINCT FROM 'address_match' OR (
--       matched_field IS NOT NULL AND source_reference IS NULL
--       AND confidence IS NULL AND extracted_by IS NULL
--     )
--   );
--
-- ALTER TABLE missive_message_links
--   DROP CONSTRAINT IF EXISTS missive_message_links_match_method_check;
-- ALTER TABLE missive_message_links
--   ADD CONSTRAINT missive_message_links_match_method_check
--   CHECK (match_method IN ('address_match', 'content_extracted'));
-- -- Only safe once you've confirmed no row has match_method =
-- -- 'content_extracted_human_confirmed' — check first; if any exists,
-- -- this rollback statement fails outright (as it should) rather than
-- -- silently orphaning those rows under a now-illegal value.
--
-- ALTER TABLE missive_message_links
--   DROP COLUMN IF EXISTS human_confirmed_at,
--   DROP COLUMN IF EXISTS human_confirmed_by;
--
--
-- DROP INDEX IF EXISTS idx_complaints_suggested_subject_pending;
--
-- ALTER TABLE complaints
--   DROP CONSTRAINT IF EXISTS complaints_held_excludes_ai_fields;
-- ALTER TABLE complaints
--   ADD CONSTRAINT complaints_held_excludes_ai_fields CHECK (
--     held_legal_fair_housing = FALSE OR (
--       category IS NULL AND needs_human_call = FALSE AND description IS NULL
--       AND flagged_protected_class = FALSE AND tone_trend IS NULL
--       AND escalation_signal IS NULL AND owner_instruction_rejected IS NULL
--       AND severity_tier IS NULL
--     )
--   );
-- -- Restores the exact pre-migration definition (20261002010000's version).
--
-- ALTER TABLE complaints
--   DROP CONSTRAINT IF EXISTS complaints_human_confirmed_subject_matches_written;
-- ALTER TABLE complaints
--   DROP CONSTRAINT IF EXISTS complaints_human_confirmed_subject_id_is_candidate;
-- ALTER TABLE complaints
--   DROP CONSTRAINT IF EXISTS complaints_human_confirmed_subject_outcome_id_matches;
-- ALTER TABLE complaints
--   DROP CONSTRAINT IF EXISTS complaints_human_confirmed_subject_requires_suggestion;
-- ALTER TABLE complaints
--   DROP CONSTRAINT IF EXISTS complaints_human_confirmed_subject_review_together;
-- ALTER TABLE complaints
--   DROP CONSTRAINT IF EXISTS complaints_suggested_subject_candidates_nonempty;
-- ALTER TABLE complaints
--   DROP CONSTRAINT IF EXISTS complaints_suggested_subject_fields_together;
--
-- ALTER TABLE complaints
--   DROP COLUMN IF EXISTS human_confirmed_subject_at,
--   DROP COLUMN IF EXISTS human_confirmed_subject_by,
--   DROP COLUMN IF EXISTS human_confirmed_subject_id,
--   DROP COLUMN IF EXISTS human_confirmed_subject_outcome,
--   DROP COLUMN IF EXISTS suggested_subject_at,
--   DROP COLUMN IF EXISTS suggested_subject_extracted_by,
--   DROP COLUMN IF EXISTS suggested_subject_candidate_ids,
--   DROP COLUMN IF EXISTS suggested_subject_name_text,
--   DROP COLUMN IF EXISTS suggested_subject_type;
-- -- Only safe once you've confirmed no backfill or review-UI work has been
-- -- built on top of these columns yet, or that losing whatever it has
-- -- written is acceptable — same standing caveat every DROP COLUMN
-- -- rollback in this schema carries. If any row has a real suggestion or a
-- -- real human-confirmed outcome, consider exporting first
-- -- (ccpa_exportable, per this table's existing Rule 4 posture).
--
-- ============================================================
