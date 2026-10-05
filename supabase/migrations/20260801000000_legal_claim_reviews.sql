-- ============================================================
-- Migration: 20260801000000_legal_claim_reviews
-- Created:   2026-08-01
-- Author:    Neo (database specialist)
--
-- Adds storage for a NEW content-engine capability: for legal-topic
-- articles, the AI may now research and state a legal fact that is NOT
-- already sitting in compliance_claims (20260710000000) — as long as it
-- names a real source. compliance_claims remains the only table the AI is
-- unconditionally trusted to draft from; everything this migration adds is
-- the review gate that stands between "the AI said this" and "this is a
-- fact Rincon Management is willing to publish."
--
-- THE RULE THIS SCHEMA EXISTS TO ENFORCE — READ BEFORE CHANGING ANYTHING:
--   This mirrors the discipline established in 20260715000000
--   (legal_update_candidate_scan): an AI surfacing something is never, by
--   itself, enough to make it real. Here the discipline is even stricter,
--   because this is a claim already sitting live in a drafted article, not
--   just a bill-tracking candidate — so TWO separate reviews, each its own
--   column, must both happen before anything can be published:
--
--     Step 1 — mason_finding / mason_note / mason_reviewed_at:
--       Mason (AI legal reviewer) runs an automatic pass and records a
--       finding: CONFIRMED / NEEDS_SOURCE_CHECK / FLAG_FOR_ATTORNEY / REJECT.
--       This is Mason's judgment on the claim and its source. It is NOT a
--       publishing decision.
--
--     Step 2 — peter_decision / peter_edited_text / decided_by / decided_at:
--       Peter (the property manager who owns this system) must separately
--       and explicitly record his own call: approved_as_is /
--       approved_with_edit / removed_from_draft / consulting_attorney.
--
--   These are two distinct columns on purpose, and nothing in this schema
--   (no trigger, no default, no generated column) ever derives one from the
--   other. Mason confirming a claim does NOT set peter_decision. The
--   application layer must never treat mason_finding = 'CONFIRMED' as
--   equivalent to Peter's approval — a human (Peter) approves every
--   housing-adjacent legal statement before it ships, matching the
--   "Tier 3 — Humans Only" rule in GOVERNANCE.md.
--
--   A CHECK constraint below enforces the attribution half of this at the
--   database level: peter_decision can only ever be set together with
--   decided_by and decided_at (never one without the others), so a
--   decision can never exist in this table without a record of who made it
--   and when. decided_by is expected to hold a real identifier (Peter's
--   name or email) — never a generic value like "system" or "ai" — but the
--   database has no way to verify *who* a text value actually represents,
--   so that half of the rule is a naming discipline for the application
--   layer (Q's UI), not something a CHECK constraint can enforce.
--
--   "Resolved" vs. "unresolved" — NOT obvious from the schema, so it is
--   written here AND as an inline comment on the column below:
--     RESOLVED   = peter_decision IN ('approved_as_is', 'approved_with_edit',
--                  'removed_from_draft')
--     UNRESOLVED = peter_decision IS NULL OR peter_decision =
--                  'consulting_attorney'
--   'consulting_attorney' deliberately does NOT count as resolved — it is a
--   flag that the claim has been sent up the chain, not a verdict. Treating
--   it as resolved would let a "still waiting on the attorney" claim quietly
--   read as cleared-to-publish, which is exactly the silent-collapse this
--   whole design exists to prevent.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO:
--   - No trigger recomputes content_items.legal_review_status from
--     legal_claim_reviews rows. That recomputation is application code's
--     job, run explicitly when a decision is saved — not a blind database
--     trigger. Same "no silent auto-collapsing" reasoning as above: a
--     trigger would be one more invisible place a status could flip
--     without a human decision behind it.
--   - Does not modify compliance_claims or content_edits.
--     compliance_claims stays the one AI-trusted source of pre-approved
--     legal facts; nothing here writes to it. content_edits' existing
--     free-text field_changed column already supports a new
--     'legal_review' value for the audit trail — that's an
--     application-level INSERT using the existing schema, not a schema
--     change, so there is nothing to migrate there.
--   - Does not modify any other existing table besides the single additive
--     column on content_items below.
--
-- Design notes:
--   - content_item_id has ON DELETE CASCADE, matching content_edits and
--     content_section_edits (both 20260710000000): this is child data
--     scoped to one article's lifecycle, same shape as those two tables.
--   - claim_text is the exact verbatim sentence/clause from the article
--     body — NOT a paraphrase — so a reviewer (or a future audit) can
--     always find precisely what was published and trace it back to where
--     it came from.
--   - source_tier defaults to 'unknown' rather than being nullable: the
--     detector that first writes this row is not qualified to judge source
--     quality (that is explicitly Mason's job per spec), so 'unknown' is
--     the honest starting state until Mason updates it to 'primary' or
--     'secondary'.
--   - detected_by is CHECK-constrained (not free TEXT like
--     legal_update_candidates.jurisdiction) because the two-layer detector
--     design names exactly two layers today: 'pattern_match' and
--     'ai_comprehension'. Unlike jurisdiction (explicitly expected to grow
--     to include local ordinances), a third detector layer is not a known,
--     planned addition — a CHECK constraint catches typos/drift now, and a
--     follow-on migration can widen it if a third layer is ever added.
--   - jurisdiction_scope reuses the exact convention already established by
--     compliance_claims.jurisdiction_scope (free TEXT, e.g. "statewide",
--     "city (Oxnard)") rather than inventing a new one.
--   - updated_at (+ trigger) is included even though the requesting spec's
--     column list didn't spell it out, matching this codebase's own
--     standing rule that every table gets id/created_at/updated_at, and
--     matching legal_update_candidates' identical reasoning: this is a row
--     that gets actively edited after insert — twice, here (Mason's pass,
--     then separately Peter's decision).
--   - Two CHECK constraints translate the plain-English rules above into
--     enforced data integrity, not just documentation:
--       chk_peter_decision_requires_attribution — peter_decision,
--       decided_by, and decided_at must be all-NULL or all-set together.
--       chk_edited_text_requires_edit_decision — peter_edited_text must be
--       present whenever peter_decision = 'approved_with_edit'.
--
-- RLS is enabled and locked down by default, matching every other table in
-- this schema. No policies are added — this app (content-review) reaches
-- these rows the same way it already reaches content_items and
-- content_edits: via the service role key from the server, which bypasses
-- RLS entirely (see projects/content-review/lib/db.js). No new access
-- model is introduced here.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- TABLE: legal_claim_reviews
-- What it stores: one row per newly-researched legal claim per article
-- version — a legal statement the AI wrote and sourced itself, that is NOT
-- already sitting in compliance_claims. Waiting for Mason's finding AND
-- Peter's decision (two separate columns — see rule above) before it can
-- ever be treated as cleared to publish.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE legal_claim_reviews (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_item_id     UUID NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,

  claim_text          TEXT NOT NULL,          -- exact verbatim sentence/clause as it appears in the article body, not a paraphrase
  claim_context       TEXT,                   -- surrounding sentence(s), for reviewer context
  source_url          TEXT NOT NULL,          -- the source the AI named for this claim
  source_tier         TEXT NOT NULL DEFAULT 'unknown'
                        CHECK (source_tier IN ('primary', 'secondary', 'unknown')),  -- Mason's judgment call on source quality; 'unknown' until he assesses it
  jurisdiction_scope  TEXT NOT NULL,          -- same convention as compliance_claims.jurisdiction_scope, e.g. "statewide", "city (Oxnard)"
  detected_by         TEXT NOT NULL
                        CHECK (detected_by IN ('pattern_match', 'ai_comprehension')),  -- which detector layer caught this claim

  -- Step 1: Mason's automatic pass. Independent of peter_decision below —
  -- see the two-step rule at the top of this file. Nullable: null until
  -- Mason's automatic pass actually runs.
  mason_finding       TEXT
                        CHECK (mason_finding IN (
                          'CONFIRMED', 'NEEDS_SOURCE_CHECK',
                          'FLAG_FOR_ATTORNEY', 'REJECT'
                        )),
  mason_note          TEXT,                   -- Mason's explanation, nullable
  mason_reviewed_at   TIMESTAMPTZ,

  -- Step 2: Peter's decision. MUST be set only by an explicit action
  -- attributed to Peter — never derived from mason_finding, never
  -- defaulted, never set by a trigger. See the two-step rule at the top of
  -- this file.
  --
  -- Resolved   = peter_decision IN ('approved_as_is', 'approved_with_edit', 'removed_from_draft')
  -- Unresolved = peter_decision IS NULL OR peter_decision = 'consulting_attorney'
  -- ('consulting_attorney' is a flag that review is still in flight, not a
  -- verdict — it must never be read as cleared-to-publish.)
  peter_decision      TEXT
                        CHECK (peter_decision IN (
                          'approved_as_is', 'approved_with_edit',
                          'removed_from_draft', 'consulting_attorney'
                        )),
  peter_edited_text   TEXT,                   -- what Peter changed claim_text to, only if peter_decision = 'approved_with_edit'
  decided_by          TEXT,                   -- real identifier of who recorded peter_decision (e.g. Peter's name/email) — never a generic system value
  decided_at          TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- when this claim was first detected
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Enforces the attribution half of the two-step rule: a peter_decision
  -- can never exist without a record of who made it and when, and vice
  -- versa — decided_by/decided_at can never be set without an actual
  -- decision. All three are all-NULL or all-set, together, always.
  CONSTRAINT chk_peter_decision_requires_attribution CHECK (
    (peter_decision IS NULL AND decided_by IS NULL AND decided_at IS NULL)
    OR
    (peter_decision IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  ),

  -- Enforces the spec's explicit rule: if Peter chose approved_with_edit,
  -- the edited text must actually be recorded.
  CONSTRAINT chk_edited_text_requires_edit_decision CHECK (
    peter_decision <> 'approved_with_edit' OR peter_edited_text IS NOT NULL
  )
);

ALTER TABLE legal_claim_reviews ENABLE ROW LEVEL SECURITY;

-- Supports "show me every legal claim reviewed for this article."
CREATE INDEX idx_legal_claim_reviews_content_item_id
  ON legal_claim_reviews(content_item_id);

-- Supports Mason's review queue ("show me claims with no finding yet").
CREATE INDEX idx_legal_claim_reviews_mason_finding
  ON legal_claim_reviews(mason_finding);

-- Supports the resolved/unresolved query pattern described above.
CREATE INDEX idx_legal_claim_reviews_peter_decision
  ON legal_claim_reviews(peter_decision);

CREATE TRIGGER trg_legal_claim_reviews_updated_at
  BEFORE UPDATE ON legal_claim_reviews
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- COLUMN: content_items.legal_review_status
-- What it's for: the field the Approve/Publish routes check before letting
-- a legal-topic article go out (Tron/Q build that check separately — this
-- migration only adds the column). 'needs_review' means at least one
-- legal_claim_reviews row for this article is unresolved (see definition
-- above); 'cleared' means every such row is resolved; 'not_required' means
-- this article never went through the AI-sources-its-own-legal-fact path
-- at all.
--
-- Deliberately NOT trigger-maintained: recomputing this from
-- legal_claim_reviews rows is application code's job, run explicitly when
-- a decision is saved — not a blind database trigger. See the top-of-file
-- rule about no silent auto-collapsing.
-- ============================================================

ALTER TABLE content_items
  ADD COLUMN legal_review_status TEXT NOT NULL DEFAULT 'not_required'
    CHECK (legal_review_status IN ('not_required', 'needs_review', 'cleared'));

CREATE INDEX idx_content_items_legal_review_status
  ON content_items(legal_review_status);


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP INDEX IF EXISTS idx_content_items_legal_review_status;
-- ALTER TABLE content_items DROP COLUMN IF EXISTS legal_review_status;
--
-- DROP TRIGGER IF EXISTS trg_legal_claim_reviews_updated_at ON legal_claim_reviews;
-- DROP TABLE IF EXISTS legal_claim_reviews;
--
-- Note: set_updated_at() is NOT dropped here — it is shared with earlier
-- migrations (20260626000000, 20260710000000, 20260715000000, ...) and
-- other tables still use it.
--
-- ============================================================
