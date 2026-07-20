-- Migration: 0004_content_engine_schema
-- Created:   2026-07-10
-- Author:    Neo (database specialist)
--
-- Establishes the tables for the content-creation engine:
--   1. compliance_kb_meta      — one row describing the legal knowledge base as a whole
--   2. compliance_topics       — the 12 legal topics the knowledge base covers
--   3. compliance_claims       — the 55 individual legal claims, each with full
--                                evidence/citation structure preserved as JSONB
--   4. content_items           — blog posts, FAQs, market reports, the flagship
--                                report, and case studies (shared table)
--   5. content_item_compliance_claims — links a content item to every legal
--                                claim it cites (many-to-many)
--   6. social_captions         — FB/LinkedIn/Instagram captions tied to a
--                                published blog post, own approve/reject status
--   7. topic_suggestions       — candidate topics surfaced by the discovery feeds
--   8. content_edits           — whole-document edit history (human edits a draft)
--   9. content_section_edits   — section-level edits, for politically-sensitive
--                                civic-monitoring content specifically
--  10. brand_guides            — free-text brand voice / content strategy,
--                                current-version + updated_at, no rigid schema
--
-- RLS is enabled on every table and locked down by default, matching the
-- pattern from 20260626000000_initial_schema.sql. No permissive policies are
-- defined here — they will be added per-tool as authentication is wired up.
--
-- GOVERNANCE (Asimov sign-off already given):
--   - No table here stores credentials or API tokens for any publishing
--     destination (no Facebook/LinkedIn/Instagram tokens, no CMS login, no
--     email/SMS-sending keys). This system stores drafts only — it cannot
--     publish anywhere itself.
--   - No SSNs, bank account numbers, passwords, or protected-class data.
--     Case studies store Peter's own anonymized/fictionalized accounts —
--     never real tenant identifying details.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- Note: set_updated_at() already exists from migration 20260626000000.
-- Re-declared here with CREATE OR REPLACE so this file can be applied
-- standalone against a fresh database if ever needed.

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- TABLE: compliance_kb_meta
-- What it stores: one row per knowledge-base file describing it as a whole
-- (title, who prepared/reviewed it, geography covered, freshness warnings,
-- the review log). This is the "cover page" for the legal claims below —
-- kept separate from individual claims so the whole-file metadata (like
-- Mason's review log) isn't duplicated onto all 55 claim rows.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE compliance_kb_meta (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title                       TEXT NOT NULL,
  prepared_for                TEXT,
  prepared_by                 TEXT,
  geography_covered           JSONB,          -- state/county/cities/exclusions, as supplied
  date_generated              DATE,
  next_review_owner           TEXT,
  freshness_warning           TEXT,
  methodology_note            TEXT,
  total_claims                INTEGER,
  claims_needing_human_review INTEGER,
  review_log                  JSONB,          -- array of {reviewer, date, summary}
  known_local_ordinances      JSONB,          -- "known_local_ordinances_beyond_state_law" from source file
  source_file                 TEXT,           -- path/name of the JSON file this came from
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE compliance_kb_meta ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_compliance_kb_meta_updated_at
  BEFORE UPDATE ON compliance_kb_meta
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TABLE: compliance_topics
-- What it stores: the 12 legal topics the knowledge base is organized into
-- (e.g. "security-deposits", "fair-housing"). Each topic groups several
-- individual claims.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE compliance_topics (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_key     TEXT NOT NULL UNIQUE,   -- e.g. "ab-1482-statewide-and-local-variation"
  kb_meta_id    UUID REFERENCES compliance_kb_meta(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE compliance_topics ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_compliance_topics_kb_meta_id ON compliance_topics(kb_meta_id);

CREATE TRIGGER trg_compliance_topics_updated_at
  BEFORE UPDATE ON compliance_topics
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TABLE: compliance_claims
-- What it stores: the 55 individual legal claims. Every claim traces back
-- to a real source, so the full evidence/citation structure (primary and
-- secondary sources, each with citation/url/retrieved date) is preserved
-- as JSONB rather than flattened — content drafted from a claim can always
-- be traced back to exactly what was cited.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE compliance_claims (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_key                 TEXT NOT NULL UNIQUE,  -- e.g. "ab1482-oxnard-01" (id from source file)
  topic_id                  UUID NOT NULL REFERENCES compliance_topics(id) ON DELETE RESTRICT,
  statement                 TEXT NOT NULL,
  jurisdiction_scope        TEXT NOT NULL,         -- e.g. "statewide", "city (Oxnard)"
  confidence                TEXT NOT NULL
                              CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  status                    TEXT NOT NULL
                              CHECK (status IN ('OK','NEEDS_HUMAN_REVIEW')),
  evidence                  JSONB NOT NULL,        -- { primary: [...], secondary: [...] } verbatim
  conflicts                 TEXT,                  -- nullable — free-text description of any conflict
  notes                     TEXT,
  resolution_log            TEXT,                  -- nullable — how a conflict/review was resolved
  downstream_review_required TEXT,                 -- nullable — extra review instruction (e.g. route to Mason)
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE compliance_claims ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_compliance_claims_topic_id ON compliance_claims(topic_id);
CREATE INDEX idx_compliance_claims_status   ON compliance_claims(status);
CREATE INDEX idx_compliance_claims_confidence ON compliance_claims(confidence);

CREATE TRIGGER trg_compliance_claims_updated_at
  BEFORE UPDATE ON compliance_claims
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TABLE: content_items
-- What it stores: every piece of drafted content — blog posts, FAQ/
-- knowledge-base articles, quarterly market reports, the flagship
-- "State of Ventura County Rental Market" report, and case studies.
-- These share one table (content_type distinguishes them) because the
-- fields overlap heavily: all need a title, body, review status, SEO
-- fields, and author attribution.
-- Case studies must store Peter's own anonymized/fictionalized accounts —
-- never a real tenant's identifying details.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE content_items (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type           TEXT NOT NULL
                           CHECK (content_type IN (
                             'blog_post','faq','market_report',
                             'flagship_report','case_study'
                           )),
  title                  TEXT NOT NULL,
  body                   TEXT,                 -- draft/final content; nullable while still an idea
  status                 TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN (
                             'draft','ready_for_review','needs_changes',
                             'approved','published'
                           )),

  -- SEO fields
  meta_description       TEXT,
  target_keywords        TEXT[],               -- simple list of keywords/phrases

  -- author attribution
  author_name            TEXT,
  author_dre_license     TEXT,                 -- DRE license number, if applicable
  disclosure_text        TEXT,                 -- e.g. AI-assisted disclosure, advertising disclosure

  -- civic-monitoring sensitivity
  politically_sensitive  BOOLEAN NOT NULL DEFAULT FALSE,

  -- quality scoring (optional, filled in by review tooling later)
  quality_score          NUMERIC(4,1),         -- e.g. 0.0–10.0 scale, nullable until scored
  quality_notes          TEXT,

  -- provenance: which discovery-feed suggestion (if any) this came from
  source_topic_suggestion_id UUID,             -- FK added after topic_suggestions is created below

  published_at           TIMESTAMPTZ,          -- nullable until actually published (outside this system)
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE content_items ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_content_items_content_type          ON content_items(content_type);
CREATE INDEX idx_content_items_status                ON content_items(status);
CREATE INDEX idx_content_items_politically_sensitive  ON content_items(politically_sensitive);

CREATE TRIGGER trg_content_items_updated_at
  BEFORE UPDATE ON content_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TABLE: content_item_compliance_claims
-- What it stores: the link between a content item and every legal claim
-- it cites. Many-to-many: one article can cite many claims, and one claim
-- can be cited by many articles.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE content_item_compliance_claims (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_item_id       UUID NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  compliance_claim_id   UUID NOT NULL REFERENCES compliance_claims(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_content_item_claim UNIQUE (content_item_id, compliance_claim_id)
);

ALTER TABLE content_item_compliance_claims ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_cicc_content_item_id     ON content_item_compliance_claims(content_item_id);
CREATE INDEX idx_cicc_compliance_claim_id ON content_item_compliance_claims(compliance_claim_id);


-- ============================================================
-- TABLE: social_captions
-- What it stores: text captions for Facebook, LinkedIn, and Instagram,
-- each linked to a parent approved blog post. No image storage — marketing
-- handles visuals manually. Each caption has its own approve/reject status,
-- independent of the parent post's status.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE social_captions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_item_id   UUID NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  platform          TEXT NOT NULL
                      CHECK (platform IN ('facebook','linkedin','instagram')),
  caption_text      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE social_captions ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_social_captions_content_item_id ON social_captions(content_item_id);
CREATE INDEX idx_social_captions_status          ON social_captions(status);

CREATE TRIGGER trg_social_captions_updated_at
  BEFORE UPDATE ON social_captions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TABLE: topic_suggestions
-- What it stores: candidate topics surfaced by the three discovery feeds:
--   - weekly legislative/trend/forum scan
--   - every-3-days viral trend scan (YouTube/Google Trends)
--   - ongoing civic/city-council monitoring (Oxnard/Ventura/Thousand Oaks)
-- Each candidate has a status; if approved, it links to the content item
-- it became.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE topic_suggestions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_source       TEXT NOT NULL
                      CHECK (feed_source IN (
                        'legislative_trend_forum_scan',
                        'viral_trend_scan',
                        'civic_council_monitoring'
                      )),
  topic_summary     TEXT NOT NULL,           -- what the candidate topic is
  relevance_note    TEXT NOT NULL,           -- why this is trending/relevant right now
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected')),
  content_item_id   UUID REFERENCES content_items(id) ON DELETE SET NULL,  -- set once approved & drafted
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE topic_suggestions ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_topic_suggestions_feed_source     ON topic_suggestions(feed_source);
CREATE INDEX idx_topic_suggestions_status          ON topic_suggestions(status);
CREATE INDEX idx_topic_suggestions_content_item_id ON topic_suggestions(content_item_id);

CREATE TRIGGER trg_topic_suggestions_updated_at
  BEFORE UPDATE ON topic_suggestions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- Now that topic_suggestions exists, add the FK from content_items back to it.
ALTER TABLE content_items
  ADD CONSTRAINT fk_content_items_source_topic_suggestion
  FOREIGN KEY (source_topic_suggestion_id)
  REFERENCES topic_suggestions(id) ON DELETE SET NULL;

CREATE INDEX idx_content_items_source_topic_suggestion_id
  ON content_items(source_topic_suggestion_id);


-- ============================================================
-- TABLE: content_edits
-- What it stores: a log entry every time a human edits a draft via the
-- review page — one row per edit, storing before/after text. This lets
-- the system eventually surface patterns in what Peter tends to edit.
-- Scoped down to "logs edits for a human to review" — no automated
-- learning happens against this table.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE content_edits (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_item_id   UUID NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  edited_by         TEXT,                 -- name of the person who made the edit
  field_changed     TEXT NOT NULL,        -- e.g. "body", "title", "meta_description"
  before_text       TEXT,                 -- nullable — may be empty if field was blank before
  after_text        TEXT,                 -- nullable — may be empty if field was cleared
  edit_note         TEXT,                 -- optional free-text reason for the edit
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE content_edits ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_content_edits_content_item_id ON content_edits(content_item_id);
CREATE INDEX idx_content_edits_created_at      ON content_edits(created_at);


-- ============================================================
-- TABLE: content_section_edits
-- What it stores: section-level inline edits, specifically for
-- civic-monitoring-sourced (politically sensitive) content. Kept separate
-- from content_edits because these need to identify which section of the
-- document was touched, not just which field — cleaner than cramming a
-- section identifier into the general edit log.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE content_section_edits (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_item_id   UUID NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  section_label     TEXT NOT NULL,        -- e.g. "paragraph 3", "quote from council member"
  edited_by         TEXT,
  before_text       TEXT,
  after_text        TEXT,
  reason            TEXT,                 -- why the edit was made (tone, accuracy, neutrality, etc.)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE content_section_edits ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_content_section_edits_content_item_id ON content_section_edits(content_item_id);
CREATE INDEX idx_content_section_edits_created_at      ON content_section_edits(created_at);


-- ============================================================
-- TABLE: brand_guides
-- What it stores: Peter's brand voice guidelines and content strategy
-- documents. Starts empty — Peter hasn't sent the files yet. Designed so
-- updating this later never requires a schema change: one free-text
-- "current content" field plus updated_at, not a rigid structured form.
-- A new version is a new row (history is kept); the most recent row is
-- the active guide.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE brand_guides (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_name        TEXT NOT NULL DEFAULT 'default', -- lets multiple guides exist later if ever needed
  content           TEXT,                 -- free-text brand voice / strategy content; NULL until uploaded
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE brand_guides ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_brand_guides_updated_at
  BEFORE UPDATE ON brand_guides
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed one empty row so the table is ready to receive Peter's brand guide
-- whenever he sends it, without needing an INSERT-vs-UPDATE decision later.
INSERT INTO brand_guides (guide_name, content, notes)
VALUES ('default', NULL, 'Awaiting brand voice guidelines and content strategy docs from Peter — not yet uploaded as of 2026-07-10.');


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP TRIGGER IF EXISTS trg_brand_guides_updated_at        ON brand_guides;
-- DROP TRIGGER IF EXISTS trg_topic_suggestions_updated_at   ON topic_suggestions;
-- DROP TRIGGER IF EXISTS trg_social_captions_updated_at     ON social_captions;
-- DROP TRIGGER IF EXISTS trg_content_items_updated_at       ON content_items;
-- DROP TRIGGER IF EXISTS trg_compliance_claims_updated_at   ON compliance_claims;
-- DROP TRIGGER IF EXISTS trg_compliance_topics_updated_at   ON compliance_topics;
-- DROP TRIGGER IF EXISTS trg_compliance_kb_meta_updated_at  ON compliance_kb_meta;
--
-- ALTER TABLE content_items DROP CONSTRAINT IF EXISTS fk_content_items_source_topic_suggestion;
--
-- DROP TABLE IF EXISTS brand_guides;
-- DROP TABLE IF EXISTS content_section_edits;
-- DROP TABLE IF EXISTS content_edits;
-- DROP TABLE IF EXISTS topic_suggestions;
-- DROP TABLE IF EXISTS social_captions;
-- DROP TABLE IF EXISTS content_item_compliance_claims;
-- DROP TABLE IF EXISTS content_items;
-- DROP TABLE IF EXISTS compliance_claims;
-- DROP TABLE IF EXISTS compliance_topics;
-- DROP TABLE IF EXISTS compliance_kb_meta;
--
-- Note: set_updated_at() is NOT dropped here — it is shared with the
-- initial schema migration (20260626000000) and other tables still use it.
--
-- ============================================================
