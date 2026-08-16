-- ============================================================
-- Migration: 20260813000003_b2_photo_folders
-- Created:   2026-08-13
-- Author:    Neo (database specialist)
--
-- Part of the Security Deposit Disposition Assembly Tool build
-- (projects/hub/security-deposit/SPEC.md, item #5 — B2 photo index).
-- Two tables: a versioned confidence-threshold config (Asimov, Rule 5 —
-- required, not optional) and the persisted, queryable index of parsed
-- Backblaze B2 folder names itself.
--
-- DESIGN NOTES
--
--   - b2_match_confidence_config exists ONLY because GOVERNANCE.md Rule 5
--     requires it: "Scoring criteria, screening rules, and decision
--     thresholds that affect people must be stored in versioned config
--     tables. Every decision must reference the version in effect. Never
--     hardcode criteria. When criteria change: create a new version,
--     never overwrite." The threshold here decides auto-index vs.
--     route-to-manual-review for an AI-parsed photo match — exactly the
--     kind of criteria Rule 5 is about. Per Rule 6, changing this value
--     later is a "Standard" change requiring Peter's approval, not
--     something a specialist adjusts unilaterally by editing a row.
--   - Only one config row may be is_active at a time (enforced by the
--     partial unique index below, the standard Postgres idiom for "at
--     most one row where a flag is true"). Changing the threshold means
--     inserting a NEW row with the new version and is_active = TRUE —
--     the application must NOT update auto_index_threshold on an
--     existing row. b2_photo_folders.confidence_config_id then always
--     points at exactly which version's threshold produced a given
--     row's auto-index/manual-review decision, satisfying "every
--     decision must reference the version in effect."
--   - Seeded with version 1 at a placeholder threshold (0.80). This
--     number was not specified anywhere in the spec or by Peter — it is
--     a reasonable starting guess only. Flagged explicitly in the seed
--     row's own `notes` column, same pattern used for placeholder/
--     unconfirmed seed data elsewhere in this schema (see
--     20260812010000_rental_analysis_schema's FlexMLS/Zillow seed rows).
--     Peter should confirm or adjust this number before the tool governs
--     a real disposition packet — Q should surface this seed row's notes
--     somewhere reachable, not bury it.
--
--   - b2_photo_folders is a periodic, incremental index (per the spec:
--     "nightly or weekly, incremental — only new/changed folders since
--     last run"), NOT a live re-parse of the bucket on every case load.
--     UNIQUE(b2_folder_path) is the upsert key the indexing job uses to
--     avoid re-parsing (and re-spending AI cost on) a folder it has
--     already seen.
--   - No `photo_bytes` column, and none should ever be added without a
--     separate privacy review first — Asimov's hard requirement (spec
--     item #5): the folder-name parser sends Claude only the folder
--     path/name string, never photo bytes or the photo files themselves.
--     This table structurally reflects that: every parsed_* column
--     stores text/date facts derived from a folder NAME, never image
--     data. There is nowhere in this schema to put photo bytes even by
--     accident.
--   - No `matched_case_id` / case linkage column. Considered and left
--     out: the spec frames the manual-review queue as correcting a
--     folder's OWN parsed fields (address/unit/type/date) or flagging it
--     as unmatched — not "assigning" a folder to one specific
--     disposition case. Binding a folder to a case at review time would
--     be premature and could go stale if the correction changes its
--     address to match a different case than the one it was reviewed
--     against. The per-case assembly step queries this index by
--     normalized address + nearest date at read time instead (per the
--     spec) — no persisted case link is needed for that to work.
--
-- ============================================================
-- DATA INVENTORY (GOVERNANCE.md Rule 4 — required for every new table
-- storing personal data)
-- ============================================================
--   b2_match_confidence_config: not personal data (a config table of
--   threshold numbers) — Rule 4's inventory below applies to
--   b2_photo_folders only.
--
--   pii_fields:          parsed_address, parsed_unit — property/unit
--                         identifiers tied to a specific tenancy (the
--                         spec's own framing: "parsed address/date data
--                         tied to a specific tenancy"). Not direct tenant
--                         identity (no name/email/phone column exists
--                         here). b2_folder_path is raw, human-typed text
--                         from the original brief's own finding of real
--                         naming noise — it MAY incidentally contain a
--                         tenant's name if whoever filed the photos named
--                         a folder that way rather than by address.
--                         Treated as PII-adjacent, not confirmed clean.
--   agents_with_access:  Claude, via ANTHROPIC_API_KEY — folder path/name
--                         string only, never photo bytes (Asimov's hard
--                         requirement, enforced by this table's own shape
--                         — see design note above); the periodic indexing
--                         job (system, service-role key); an admin or
--                         inspection-coordinator-equivalent role reviewing
--                         the low-confidence manual-review queue.
--   privacy_category:    Property/unit identifying data, tenancy-adjacent.
--   retention_policy:    PLACEHOLDER — pending Mason, same open item as
--                         security_deposit_cases and lease_tenants.
--   ccpa_exportable:     TRUE — if a specific tenant's move-in/move-out
--                         photos are identified via this index (even
--                         indirectly, through case matching), a data
--                         export request should be able to surface it.
--   ccpa_deletable:      This table indexes B2 folder NAMES and parsed
--                         METADATA ONLY — never the photo bytes
--                         themselves. A CCPA deletion request can be
--                         fulfilled for this table's own row (delete or
--                         redact the parsed fields), but cannot reach the
--                         underlying photos in Backblaze B2, because the
--                         B2 credential this tool uses is deliberately
--                         read-only (see the spec's "Known Limitation —
--                         CCPA Deletion Doesn't Reach the Actual Photos").
--                         This is a documented, accepted trade-off, not
--                         an oversight discovered later.
--
-- RLS: enabled, no permissive policies — matches every other table in
-- this schema.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- TABLE: b2_match_confidence_config
-- What it stores: versioned confidence-threshold config deciding
-- auto-index vs. manual-review for AI-parsed B2 folder matches
-- (GOVERNANCE.md Rule 5 — required). Never update auto_index_threshold
-- on an existing row — insert a new version instead.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS b2_match_confidence_config (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  version               INTEGER     NOT NULL,
  auto_index_threshold  NUMERIC(4,3) NOT NULL CHECK (auto_index_threshold BETWEEN 0 AND 1),
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
ALTER TABLE b2_match_confidence_config ENABLE ROW LEVEL SECURITY;

-- At most one active version at a time — standard Postgres idiom for a
-- "singleton flag" constraint via a partial unique index on a constant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_b2_match_confidence_config_one_active
  ON b2_match_confidence_config ((true))
  WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS trg_b2_match_confidence_config_updated_at ON b2_match_confidence_config;
CREATE TRIGGER trg_b2_match_confidence_config_updated_at
  BEFORE UPDATE ON b2_match_confidence_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed version 1 — PLACEHOLDER threshold, not yet Peter-confirmed. See
-- design note above. Idempotent — safe to re-run.
INSERT INTO b2_match_confidence_config (version, auto_index_threshold, is_active, set_by, notes)
VALUES (
  1,
  0.800,
  TRUE,
  'system',
  'PLACEHOLDER — 0.80 (80%) AI confidence auto-indexes a folder match; below this routes to the manual-review queue. This number was not specified by Peter or Asimov as of this migration and needs confirmation before it governs a real disposition packet. To change it: in one transaction, set is_active = FALSE on this row and INSERT a new row with the new version and is_active = TRUE — there is no trigger that does this automatically, the application must do both explicitly. Per GOVERNANCE.md Rule 6, this is a Standard change requiring Peter''s approval.'
)
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- TABLE: b2_photo_folders
-- What it stores: the persisted, queryable index of parsed Backblaze B2
-- photo folder names — built by a periodic incremental indexing job, not
-- a live re-parse on every case load. See design notes above.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS b2_photo_folders (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Raw folder name/path exactly as it appears in B2 — the only input
  -- ever sent to Claude for parsing (Asimov's hard requirement).
  b2_folder_path           TEXT        NOT NULL,

  -- AI-parsed fields. All nullable — a parse can partially fail (e.g.
  -- date found but address ambiguous) without blocking the row.
  parsed_address            TEXT,
  parsed_unit                TEXT,
  parsed_inspection_type      TEXT     CHECK (parsed_inspection_type IS NULL OR parsed_inspection_type IN (
                                 'move_in', 'move_out', 'other'
                               )),
  parsed_date                 DATE,

  -- The AI's raw confidence score for this specific parse (0.000-1.000),
  -- kept visible on the case screen per Tron's requirement — a pod lead
  -- needs to be able to notice and challenge a wrong high-confidence
  -- match, not just trust it silently.
  confidence_score             NUMERIC(4,3) CHECK (confidence_score IS NULL OR confidence_score BETWEEN 0 AND 1),

  -- Which threshold version was in effect when auto-index vs.
  -- manual-review was decided for this row — Rule 5's "every decision
  -- must reference the version in effect." No ON DELETE clause: a config
  -- version must never be deletable once real parses reference it,
  -- same reasoning as rental_comps.source_id
  -- (20260812010000_rental_analysis_schema).
  confidence_config_id         UUID     REFERENCES b2_match_confidence_config(id),

  review_status                 TEXT    NOT NULL DEFAULT 'needs_review'
                                          CHECK (review_status IN (
                                            'auto_indexed',        -- confidence >= threshold, no human touched it
                                            'needs_review',        -- confidence < threshold, sitting in the manual-review queue
                                            'manually_confirmed',  -- a human reviewed it and the AI's parse was correct
                                            'manually_corrected'   -- a human reviewed it and changed the parsed fields
                                          )),

  -- Which AI model produced this parse — cross-references the
  -- audit_log entry Q writes for every parse (details.model_version,
  -- per the spec's Q section).
  model_version                  TEXT,

  indexed_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- when the periodic job parsed this folder

  -- Set only when review_status moves to manually_confirmed or
  -- manually_corrected. Plain TEXT email, not a FK to users(id) or
  -- team_members(id) — mirrors the reviewed_by/escalated_by/granted_by
  -- convention already used throughout this schema
  -- (20260803000002_reviewer_workflow.sql, 20260812020000_shared_team_members.sql).
  resolved_by                     TEXT,
  resolved_at                     TIMESTAMPTZ,

  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Upsert key for the incremental indexing job — see design note above.
  UNIQUE (b2_folder_path)
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE b2_photo_folders ENABLE ROW LEVEL SECURITY;

-- Primary per-case assembly query: match by normalized address + nearest
-- date (per the spec's own description of the matching approach).
CREATE INDEX IF NOT EXISTS idx_b2_photo_folders_address_date
  ON b2_photo_folders(parsed_address, parsed_date)
  WHERE parsed_address IS NOT NULL;

-- Manual-review queue listing: "every folder still needing a human look."
CREATE INDEX IF NOT EXISTS idx_b2_photo_folders_review_status
  ON b2_photo_folders(review_status)
  WHERE review_status = 'needs_review';

DROP TRIGGER IF EXISTS trg_b2_photo_folders_updated_at ON b2_photo_folders;
CREATE TRIGGER trg_b2_photo_folders_updated_at
  BEFORE UPDATE ON b2_photo_folders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP TRIGGER IF EXISTS trg_b2_photo_folders_updated_at ON b2_photo_folders;
-- DROP INDEX IF EXISTS idx_b2_photo_folders_review_status;
-- DROP INDEX IF EXISTS idx_b2_photo_folders_address_date;
-- DROP TABLE IF EXISTS b2_photo_folders;
--
-- DROP TRIGGER IF EXISTS trg_b2_match_confidence_config_updated_at ON b2_match_confidence_config;
-- DROP INDEX IF EXISTS idx_b2_match_confidence_config_one_active;
-- DROP TABLE IF EXISTS b2_match_confidence_config;
--
-- ============================================================
