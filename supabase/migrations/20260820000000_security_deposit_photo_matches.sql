-- ============================================================
-- Migration: 20260820000000_security_deposit_photo_matches
-- Created:   2026-08-20
-- Author:    Neo (database specialist)
--
-- Part of the "Targeted Photo Matching" addendum to the Security Deposit
-- Disposition Assembly Tool (projects/hub/security-deposit/
-- targeted-photo-matching-SPEC.md, Neo section — Photo match records +
-- Photo-match confidence config). Governance-cleared by Asimov (7
-- conditions) and Mason (1 condition) before this spec was written — see
-- that spec's "Compliance Grounding" section for the full list. This
-- migration is what makes conditions 1, 2, 3, and 4 structurally true,
-- not just documented as intent.
--
-- Two tables, same pairing pattern as 20260813000003_b2_photo_folders.sql
-- (a versioned confidence-threshold config + the record table whose
-- auto-show/needs-confirmation decision that config governs):
--   1. photo_match_confidence_config  — versioned threshold config
--   2. security_deposit_photo_matches — one row per move-out photo a
--      coordinator selected and the system attempted to match
--
-- General photo browsing and the address search (the other two pieces of
-- this addendum) need NO schema — pure read-through to B2 / read of the
-- already-existing b2_photo_folders table. Nothing for Neo to build for
-- either. Confirmed against the spec's own Neo section #4 and #4a before
-- writing this file, so this migration is deliberately narrower than the
-- addendum as a whole.
--
-- This is a NEW migration file. 20260813000002_security_deposit_cases.sql
-- and 20260813000003_b2_photo_folders.sql are both already applied to the
-- live database — this codebase's standing rule ("never modify an
-- already-applied migration") means those files are read here for
-- convention only, never edited. Everything below is additive: two new
-- tables, zero changes to any existing table or constraint.
--
-- ============================================================
-- DESIGN NOTES
-- ============================================================
--
--   - WHY photo_match_confidence_config IS ITS OWN TABLE, NOT A SECOND
--     COLUMN ON b2_match_confidence_config (spec Open Item #3 — Neo's
--     call to make, not a mandate to follow blindly). Confirmed my own
--     judgment agrees with the spec's recommendation, for the same
--     reason the spec gives plus one more found while writing this:
--       (a) b2_match_confidence_config.auto_index_threshold governs a
--           text-parse decision (does an AI reading of a FOLDER NAME get
--           auto-indexed). This new table governs a photo-CONTENT
--           decision (does an AI that actually looked at image bytes get
--           auto-shown). These are different AI capabilities reading
--           different inputs at different privacy-exposure levels (see
--           the base tool's own SPEC.md Neo section #5: "AI reads a
--           filename" vs. "AI reads a photo of someone's apartment" is
--           the exact line Asimov drew as a hard requirement needing its
--           own review before crossing). A single shared config table
--           would blur two decisions that this codebase's own governance
--           history has already treated as categorically different.
--       (b) Practically: this repo has already suffered one real
--           production regression (20260818000000_fix_role_check_
--           regression.sql) from two independent concerns sharing one
--           constraint and drifting out of sync when only one side was
--           updated. A shared confidence-config table with two threshold
--           columns is the identical failure shape — someone adjusts one
--           threshold, doesn't realize the CHECK/index/seed-row logic
--           now needs to account for two independently-versioned numbers
--           in one row, and the next change silently mis-scopes. Keeping
--           them as two singleton-active tables means each can only ever
--           drift against itself.
--     Same exact shape as b2_match_confidence_config otherwise —
--     versioned, one active row at a time via a partial unique index,
--     set_by/set_at/notes, never update a row's threshold in place.
--
--   - WHY confidence_score AND confidence_config_id ARE NOT NULL HERE,
--     UNLIKE b2_photo_folders' OWN (NULLABLE) VERSIONS OF THE SAME TWO
--     COLUMNS — a deliberate tightening, called out explicitly since the
--     spec's illustrative shape says "same shape as
--     b2_photo_folders.confidence_score" without specifying nullability.
--     b2_photo_folders.confidence_score is nullable because a folder-NAME
--     parse can partially fail (date found, address ambiguous) and still
--     produce a row worth keeping. This table's AI call has no equivalent
--     partial-failure shape: photo-matcher.js's own output contract
--     (spec Q section) always returns a matched_index/confidence pair —
--     confidence 0.0 for "no plausible match," never an absence of a
--     number. A row only ever gets inserted here after a completed AI
--     response scored against the currently-active threshold version; if
--     the B2 byte-fetch or the Claude call itself errors, that's a
--     request-level failure Q's route returns as an HTTP error, not a row
--     to persist. NOT NULL on both columns makes "every row represents a
--     completed, threshold-evaluated decision" true by construction
--     instead of by convention — directly satisfies GOVERNANCE.md Rule 5
--     ("every decision must reference the version in effect") more
--     strictly than a nullable FK would.
--
--   - WHY UNIQUE(case_id, move_out_photo_path) — NOT in the spec's
--     illustrative column list; my own addition, flagged here so it's a
--     visible decision, not a silent one. The spec's Q section says
--     GET .../photo-matches exists "so re-opening a case doesn't re-spend
--     an AI call" — that only holds if the same move-out photo can't
--     silently accumulate two independent match rows (e.g. a coordinator
--     double-clicking submit, or a retried request after a slow response
--     that actually succeeded). The constraint makes the intended
--     idempotency structural: one match attempt per (case, move-out
--     photo), full stop. A pod lead correcting a match updates the same
--     row via POST .../photo-matches/:id/resolve (per the spec's route
--     table) rather than creating a second one — match_status moving to
--     manually_corrected on that existing row is exactly what this
--     constraint expects.
--
--   - NO FREE-TEXT/CAPTION/NOTES COLUMN ANYWHERE ON
--     security_deposit_photo_matches — Asimov's condition 1 and Mason's
--     condition 7 (spec Compliance Grounding) are both enforced here by
--     omission, not by a comment telling application code to behave.
--     Deliberately different from security_deposit_cases, which has a
--     free-text reviewer_notes column (20260813000002) — that precedent
--     is NOT mirrored here on purpose. A pod lead confirming or
--     correcting a match records WHO and WHEN (resolved_by/resolved_at)
--     and WHICH photo (move_in_photo_path, overwritten on correction),
--     never WHY or WHAT THEY SAW. There is nowhere in this schema for a
--     caption, a description, or a damage characterization to go, even
--     by accident — same defense-in-depth b2_photo_folders already
--     established by having no such column either.
--
--   - move_in_photo_path is nullable (no confident match found, or no
--     plausible candidate at all — match_status = 'no_match_found');
--     move_out_photo_path is NOT NULL (there is no row without a
--     coordinator having selected a move-out photo first).
--
--   - match_status has 5 states, not b2_photo_folders.review_status's 4
--     — per the spec's explicit instruction: mirror auto_indexed /
--     needs_review / manually_confirmed / manually_corrected, renamed to
--     this feature's own vocabulary (auto_shown / needs_confirmation /
--     manually_confirmed / manually_corrected), PLUS a fifth state
--     (no_match_found) this feature needs that folder-matching doesn't:
--     the AI can find zero plausible candidates in the move-in folder
--     entirely, which is a different case from "found a candidate but
--     wasn't confident enough."
--
--   - case_id uses ON DELETE CASCADE, deliberately different from
--     security_deposit_cases.lease_id's own ON DELETE RESTRICT
--     (20260813000002). That RESTRICT exists because a disposition case
--     has no meaning without its lease (a tightly-coupled current-state
--     record, not a standalone one). The relationship here is the
--     reverse direction: a photo-match row has no meaning without ITS
--     case (it's a child record OF a case), so if a case is ever deleted
--     its match rows should go with it rather than block the delete or
--     be left dangling. Matches the spec's own explicit recommendation
--     (Neo section #1) and the same CASCADE convention lease_tenants
--     already uses for its own parent FK.
--
--   - confidence_config_id has no ON DELETE clause (defaults to
--     RESTRICT) — identical reasoning to b2_photo_folders.
--     confidence_config_id: a config version must never be deletable
--     once a real match references it, or "every decision references the
--     version in effect" (Rule 5) would become unverifiable after the
--     fact.
--
--   - No column linking to a b2_photo_folders row. Considered and left
--     out: this table stores raw B2 file PATHS (individual photo files
--     inside an already-matched folder), which is what Q's routes
--     actually operate on (listFilesInFolder / downloadFileBytes take
--     paths, not folder-index row IDs). The move_in/move_out FOLDER
--     match already lives on security_deposit_cases via the base tool's
--     existing assembly (case_id is enough to reach both folders and,
--     transitively, their b2_photo_folders rows if ever needed). Adding
--     a redundant FK here would duplicate a relationship the case row
--     already carries, for no query this feature's spec actually needs.
--
--   - Seed threshold: 0.850, not b2_match_confidence_config's 0.800.
--     Both are equally unconfirmed placeholders (see spec Open Item #4 —
--     Peter has not specified a number), but I picked a different
--     starting guess deliberately rather than copying the folder-parse
--     number: this threshold gates an AI that looked at actual photo
--     CONTENT and claims to have identified the same physical spot in
--     two different images — a materially harder and higher-stakes
--     visual-identification task than scoring a hand-typed folder name
--     against a known address. A wrongly "confident" photo match is also
--     the specific risk the spec's own "What Could Go Wrong" section
--     calls out as worse than an honest "not sure." Erring slightly more
--     conservative (more matches routed to needs_confirmation, fewer
--     auto-shown) fits that risk better than reusing 0.800 by default.
--     This is still just a placeholder starting guess, not a
--     recommendation Peter has confirmed — flagged in the seed row's own
--     `notes` column and restated in the handoff below.
--
-- ============================================================
-- DATA INVENTORY (GOVERNANCE.md Rule 4 — required for every new table
-- storing personal data)
-- ============================================================
--   photo_match_confidence_config: NOT personal data — a config table of
--   threshold numbers, identical treatment to b2_match_confidence_config
--   (spec's own Neo section #3 confirms this explicitly). Rule 4's
--   inventory below applies to security_deposit_photo_matches only.
--
--   pii_fields:          move_out_photo_path, move_in_photo_path — B2
--                         file paths tied to a specific case (and
--                         therefore a specific tenancy), same
--                         PII-adjacent treatment b2_photo_folders already
--                         gives b2_folder_path: these are raw path
--                         strings, not structured tenant identity, but a
--                         hand-typed or camera-default file name COULD
--                         incidentally contain a tenant's name. Treated
--                         as PII-adjacent, not confirmed clean.
--                         selected_by / resolved_by are Rincon STAFF
--                         identifiers (whichever team member picked or
--                         resolved the match), not tenant PII — same
--                         plain-email-string convention as reviewed_by/
--                         escalated_by elsewhere in this schema, noted
--                         here for completeness rather than treated as a
--                         tenant-privacy concern. No tenant name, email,
--                         or phone is stored directly on this table —
--                         tenant identity is reachable only via
--                         case_id -> security_deposit_cases -> lease_id
--                         -> lease_tenants -> tenants, same indirection
--                         security_deposit_cases itself already uses.
--   agents_with_access:  Claude, via ANTHROPIC_API_KEY — for THIS table
--                         specifically, actual photo BYTES (not just a
--                         filename string), the first time this codebase
--                         sends image content to an AI rather than text
--                         (see targeted-photo-matching-SPEC.md's own
--                         framing: "the first time this tool asks an AI
--                         to actually look at a photo rather than just a
--                         filename"). Bytes are read transiently for the
--                         matching call and never persisted anywhere by
--                         this table or elsewhere (condition 2, spec
--                         Compliance Grounding) — this table only ever
--                         stores the PATH the bytes were read from, never
--                         the bytes themselves. Also: team members
--                         holding admin/pod_lead/inspection_coordinator
--                         for tool='security_deposit' (submit, browse,
--                         and — pod_lead/admin only — resolve).
--   privacy_category:    Tenancy-adjacent photo-evidence metadata (file
--                         paths + an AI confidence judgment about them),
--                         not photo content itself — same category
--                         b2_photo_folders uses, one level further from
--                         raw content since this table never stores
--                         parsed address/unit fields, only opaque paths.
--   retention_policy:    PLACEHOLDER — pending Mason, same open item as
--                         every other security-deposit table
--                         (security_deposit_cases, lease_tenants,
--                         b2_photo_folders all carry this identical
--                         placeholder pending the same deposit-03
--                         citation confirmation).
--   ccpa_exportable:     TRUE — if a specific tenant's case is identified
--                         via case_id, an export request should be able
--                         to surface which photos were matched, at what
--                         confidence, by whom, and when.
--   ccpa_deletable:      This table's OWN rows (paths, confidence score,
--                         model name, who/when) are deletable/redactable
--                         on a CCPA request — same "extends, doesn't
--                         create" treatment the spec's own "Known
--                         Limitation" section describes. What CANNOT be
--                         reached by any deletion request through this
--                         table, same as everywhere else in this tool:
--                         the underlying photo bytes in Backblaze B2 —
--                         this tool's B2 credential is read-only by
--                         design (Scotty/Sentinel condition, spec
--                         section 6), so it structurally cannot delete a
--                         B2 object even if asked to. No new,
--                         undisclosed gap — same documented trade-off the
--                         base tool's SPEC.md already discloses, now
--                         explicitly extended to this table.
--
-- RLS: enabled on both tables, no permissive policies — matches every
-- other table in this schema.
--
-- Rollback: see the DROP section at the bottom of this file.
--
-- ============================================================
-- MIGRATION GATE (Neo's pre-apply checklist, per CLAUDE.md / GOVERNANCE.md
-- Rule 4 "Neo gate is mandatory for every migration")
-- ============================================================
--   [x] Rollback exists — see bottom of this file
--   [x] Breaks no existing data — two brand-new tables, zero ALTERs on
--       any existing table, zero changes to any existing constraint
--   [x] Touches security_deposit_cases only via a new incoming FK
--       reference (security_deposit_photo_matches.case_id) — that table
--       itself is not modified, its own rows are untouched, its existing
--       columns/constraints/indexes are unchanged
--   [x] Purely additive — CREATE TABLE x2, no DROP/ALTER on anything
--       that already exists
--   [x] Should be tested on a copy of Supabase before production apply —
--       same caveat every migration in this project carries; no staging
--       copy exists here, same as every prior migration in this repo
-- ============================================================


-- ============================================================
-- TABLE: photo_match_confidence_config
-- What it stores: versioned confidence-threshold config deciding
-- auto-show vs. needs-confirmation for AI photo-CONTENT matches (this
-- feature) — a different decision from b2_match_confidence_config's
-- auto-index vs. needs-review for AI folder-NAME parses. See design
-- notes above for why these are two tables, not one shared config.
-- Never update auto_show_threshold on an existing row — insert a new
-- version instead (GOVERNANCE.md Rule 5).
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS photo_match_confidence_config (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  version               INTEGER     NOT NULL,
  auto_show_threshold   NUMERIC(4,3) NOT NULL CHECK (auto_show_threshold BETWEEN 0 AND 1),
  is_active             BOOLEAN     NOT NULL DEFAULT TRUE,
  set_by                TEXT        NOT NULL,   -- email of whoever approved this version (Rule 6: Standard change, owner approval)
  set_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes                 TEXT,                    -- nullable — rationale for this threshold / this change
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (version)
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE photo_match_confidence_config ENABLE ROW LEVEL SECURITY;

-- At most one active version at a time — same partial-unique-index idiom
-- as b2_match_confidence_config.
CREATE UNIQUE INDEX IF NOT EXISTS idx_photo_match_confidence_config_one_active
  ON photo_match_confidence_config ((true))
  WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS trg_photo_match_confidence_config_updated_at ON photo_match_confidence_config;
CREATE TRIGGER trg_photo_match_confidence_config_updated_at
  BEFORE UPDATE ON photo_match_confidence_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed version 1 — PLACEHOLDER threshold, not yet Peter-confirmed. See
-- design note above for why 0.850 rather than reusing
-- b2_match_confidence_config's 0.800. Idempotent — safe to re-run.
INSERT INTO photo_match_confidence_config (version, auto_show_threshold, is_active, set_by, notes)
VALUES (
  1,
  0.850,
  TRUE,
  'system',
  'PLACEHOLDER — 0.85 (85%) AI confidence auto-shows a photo-content match; below this routes to needs_confirmation for a pod lead. Deliberately set higher than b2_match_confidence_config''s 0.80 folder-name-parse threshold: this AI call is doing real visual identification (matching photo content across two images), a harder and higher-stakes judgment than scoring a hand-typed folder name against a known address, and a wrongly "confident" photo match is exactly the risk the addendum spec flags as worse than an honest "not sure." This number was not specified by Peter, Asimov, or Mason as of this migration and needs Peter''s confirmation before it governs a real case. To change it: in one transaction, set is_active = FALSE on this row and INSERT a new row with the new version and is_active = TRUE — there is no trigger that does this automatically, the application must do both explicitly. Per GOVERNANCE.md Rule 6, this is a Standard change requiring Peter''s approval.'
)
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- TABLE: security_deposit_photo_matches
-- What it stores: one row per move-out photo a coordinator selected for
-- AI matching against a case's move-in folder — the matched move-in
-- photo path (if any), the AI's confidence, which config version's
-- threshold governed the auto-show/needs-confirmation decision, who
-- selected it, and (if applicable) who confirmed or corrected it.
--
-- Deliberately contains NO caption, description, or free-text field of
-- any kind about what either photo shows — Asimov's condition 1 and
-- Mason's condition 7 (spec Compliance Grounding). Only file paths, a
-- number, a model name, and who/when. There is nowhere in this table for
-- the model (or a human) to put a description even by accident.
--
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS security_deposit_photo_matches (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  case_id                  UUID        NOT NULL REFERENCES security_deposit_cases(id) ON DELETE CASCADE,

  -- The B2 file path of the move-out photo the coordinator selected.
  -- Always present — there is no row without a selection having
  -- happened first.
  move_out_photo_path      TEXT        NOT NULL,

  -- The B2 file path of the matched move-in photo. NULL means the AI
  -- found no plausible candidate at all (match_status = 'no_match_found'),
  -- not merely a low-confidence guess (that case still populates this
  -- with the AI's best candidate, at match_status = 'needs_confirmation').
  move_in_photo_path       TEXT,

  -- The AI's confidence for this specific match attempt (0.000-1.000).
  -- NOT NULL, unlike b2_photo_folders.confidence_score — see design note
  -- above: photo-matcher.js's output contract always returns a number
  -- (0.0 for "no plausible match"), so every row here represents a
  -- completed AI response, never a partial one.
  confidence_score          NUMERIC(4,3) NOT NULL CHECK (confidence_score BETWEEN 0 AND 1),

  -- Which threshold version was in effect when auto-show vs.
  -- needs-confirmation was decided for this row (Rule 5). NOT NULL — see
  -- design note above. No ON DELETE clause: a config version must never
  -- be deletable once a real match references it, same reasoning as
  -- b2_photo_folders.confidence_config_id.
  confidence_config_id      UUID        NOT NULL REFERENCES photo_match_confidence_config(id),

  -- Which AI model produced this match — cross-references the audit_log
  -- entry Q writes for every match attempt
  -- (details.model_version, per the spec's audit-logging section).
  model_version              TEXT,

  match_status                TEXT      NOT NULL
                                          CHECK (match_status IN (
                                            'auto_shown',          -- confidence >= threshold, shown directly
                                            'needs_confirmation',  -- confidence < threshold, a candidate exists but wasn't confident enough
                                            'manually_confirmed',  -- a pod lead reviewed it and the AI's match was correct
                                            'manually_corrected',  -- a pod lead reviewed it and picked a different move-in photo
                                            'no_match_found'       -- the AI found no plausible candidate at all
                                          )),

  -- Who selected the move-out photo for matching, and when. Plain TEXT
  -- email/name, not a FK to users(id) or team_members(id) — mirrors the
  -- reviewed_by/escalated_by/resolved_by convention already used
  -- throughout this schema.
  selected_by                 TEXT      NOT NULL,
  selected_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Set only when a pod lead confirms or corrects a needs_confirmation
  -- row (match_status moves to manually_confirmed or
  -- manually_corrected). Same pattern as b2_photo_folders.resolved_by/
  -- resolved_at.
  resolved_by                 TEXT,
  resolved_at                 TIMESTAMPTZ,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One match attempt per (case, move-out photo) — see design note above
  -- for why this is added beyond the spec's illustrative column list.
  UNIQUE (case_id, move_out_photo_path)
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE security_deposit_photo_matches ENABLE ROW LEVEL SECURITY;

-- Queue-style lookup: "every match on any case still needing a pod
-- lead's confirmation." Mirrors b2_photo_folders' own
-- idx_b2_photo_folders_review_status partial-index shape.
CREATE INDEX IF NOT EXISTS idx_security_deposit_photo_matches_needs_confirmation
  ON security_deposit_photo_matches(case_id)
  WHERE match_status = 'needs_confirmation';

DROP TRIGGER IF EXISTS trg_security_deposit_photo_matches_updated_at ON security_deposit_photo_matches;
CREATE TRIGGER trg_security_deposit_photo_matches_updated_at
  BEFORE UPDATE ON security_deposit_photo_matches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP TRIGGER IF EXISTS trg_security_deposit_photo_matches_updated_at ON security_deposit_photo_matches;
-- DROP INDEX IF EXISTS idx_security_deposit_photo_matches_needs_confirmation;
-- DROP TABLE IF EXISTS security_deposit_photo_matches;
--
-- DROP TRIGGER IF EXISTS trg_photo_match_confidence_config_updated_at ON photo_match_confidence_config;
-- DROP INDEX IF EXISTS idx_photo_match_confidence_config_one_active;
-- DROP TABLE IF EXISTS photo_match_confidence_config;
--
-- ============================================================
