-- ============================================================
-- Migration: 20260801000001_content_conversation_turns
-- Created:   2026-08-01
-- Author:    Neo (database specialist)
--
-- Adds storage for the new chat/conversation feature on the draft detail
-- page (projects/content-review), replacing today's one-shot
-- "Request Changes -> full rewrite" flow with an actual back-and-forth
-- conversation per draft. One new table, ONE TABLE ONLY — every field this
-- feature needs (who, what, what kind of turn, and the optional link back
-- to an actual edit) fits on a single row per conversational turn, so a
-- multi-table split (e.g. separate tables per sender, or per turn type)
-- would only add join complexity with no benefit. Simplest shape that
-- covers the spec.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO:
--   - Does not touch content_items or content_edits. content_edits
--     (20260710000000) remains the one place a whole-document edit's
--     before/after text is recorded; this table only links to it, it never
--     duplicates it (see resulting_content_edit_id below).
--   - Does not implement the in-place scoped-edit feature itself — that is
--     application code (Q) and possibly a later migration if it turns out
--     to need its own supporting columns. This migration only reserves the
--     turn_type value for it now (see design note below) so the enum
--     doesn't need widening later just to add an already-known value.
--
-- Design notes:
--   - content_item_id has ON DELETE CASCADE, matching content_edits,
--     content_section_edits, and legal_claim_reviews (all 20260710000000 /
--     20260801000000): this is child data scoped to one article's
--     lifecycle, same shape as those three tables.
--
--   - turn_number is an explicit integer sequence (1, 2, 3, ...) per draft,
--     enforced UNIQUE together with content_item_id. The spec asks for
--     turns to "display in the order they happened" — a request handler
--     can insert a Peter-turn and its AI-turn response back-to-back in the
--     same call, and while TIMESTAMPTZ has microsecond resolution (ties are
--     unlikely), an explicit ordering column is unambiguous, human-
--     auditable, and doesn't depend on clock precision or insert-order
--     assumptions. created_at is still recorded (see below) but turn_number
--     is what the UI sorts and paginates by.
--
--   - sender is a two-value CHECK ('peter', 'ai') rather than a generic
--     "author name" column. Checked against this app's own login setup
--     (projects/content-review/scripts/create-first-user.js): this review
--     app has exactly one human login, Peter's — so "peter vs. ai" is an
--     accurate description of who can send a turn today, not an
--     oversimplification. If this app ever grows beyond a single human
--     login, widening this CHECK is a follow-on migration.
--
--   - sender_identity carries the real identifier (Peter's email, same
--     value as content_edits.edited_by / legal_claim_reviews.decided_by —
--     req.session.userEmail in this codebase) for sender = 'peter' rows.
--     It is required (NOT NULL) whenever sender = 'peter', and forbidden
--     (must be NULL) whenever sender = 'ai' — the literal value 'ai' in the
--     sender column is already the accurate, non-generic answer to "who
--     sent this," so there is no separate identity to record, and setting
--     one would just invite drift between two columns claiming to say the
--     same thing. Enforced by chk_sender_identity_matches_sender below.
--
--   - turn_type describes the EXCHANGE, not just the one row: both the
--     Peter-authored turn and the AI-authored turn that responds to it
--     carry the same turn_type value. A question and its direct answer are
--     both 'question'; an edit request and the full-draft regeneration it
--     triggered are both 'edit_full_regen'. This matches how the spec
--     itself describes the three types ("a question that got a direct
--     answer", "an edit request that triggered a full regeneration") as
--     properties of the round-trip, not of one message in isolation, and
--     it makes "show me every full-regeneration exchange for this draft"
--     a single WHERE turn_type = ... query instead of a self-join.
--     'edit_scoped' is included now even though no code path creates it
--     yet, because the spec explicitly names it as a planned (later)
--     feature — unlike legal_claim_reviews.detected_by, where a
--     hypothetical third detector layer was deliberately left OUT of that
--     CHECK because it was not a known, planned addition. Here it is
--     known and named, so reserving the value now avoids a migration
--     later just to widen an enum for something already decided.
--
--   - resulting_content_edit_id links a turn to the content_edits row it
--     produced, so the chat log and the existing whole-document edit
--     history (20260710000000) stay connected instead of duplicating
--     before/after text a second time in this table. It is nullable
--     (most turns — every question, and any edit request that failed or
--     was abandoned before a regeneration completed — never produce one),
--     and two CHECK constraints keep it honest about which rows are
--     allowed to carry it:
--       chk_resulting_edit_only_on_ai_turn — only the AI's own turn (the
--       one that IS the regeneration) may reference a content_edits row;
--       Peter's request turn never does.
--       chk_resulting_edit_requires_edit_turn_type — a 'question' turn can
--         never carry this link; by definition a question gets a direct
--         answer, not an edit.
--     ON DELETE SET NULL (not CASCADE or RESTRICT): content_edits is an
--     append-only audit log that this app never deletes from in practice,
--     but if a row there were ever removed, the conversation turn should
--     keep existing (the message was still sent) rather than vanish or
--     block the delete — same soft-reference pattern already used by
--     topic_suggestions.content_item_id and compliance_topics.kb_meta_id
--     (both 20260710000000).
--
--   - updated_at (+ trigger) is included even though a chat turn is, in
--     practice, write-once — matching this codebase's standing rule
--     (CLAUDE.md: every table gets id/created_at/updated_at) and the same
--     reasoning legal_claim_reviews (20260801000000) used for including it
--     where its own requesting spec didn't spell it out. content_edits and
--     content_section_edits predate consistent application of that rule
--     and don't have it; this table follows the now-established, more
--     recent convention instead rather than repeating the older gap.
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
-- TABLE: content_conversation_turns
-- What it stores: one row per message in the chat conversation on a
-- draft's detail page — who sent it (Peter or the AI), the message text,
-- what kind of exchange it was part of (a direct-answer question, a
-- full-regeneration edit request, or later an in-place scoped edit), and,
-- for AI turns that actually produced a new draft, a link to the
-- resulting content_edits row.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE content_conversation_turns (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_item_id           UUID NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,

  turn_number               INTEGER NOT NULL CHECK (turn_number > 0),  -- explicit display/sort order within this draft's conversation

  sender                    TEXT NOT NULL
                              CHECK (sender IN ('peter', 'ai')),
  sender_identity           TEXT,                 -- real identifier (Peter's email) when sender = 'peter'; NULL when sender = 'ai' — see design note

  message                   TEXT NOT NULL,         -- the turn's text

  turn_type                 TEXT NOT NULL
                              CHECK (turn_type IN (
                                'question',         -- a question that got a direct answer, no edit
                                'edit_full_regen',   -- an edit request that triggered a full-draft regeneration
                                'edit_scoped'        -- reserved: later in-place scoped-edit feature, not yet built
                              )),

  resulting_content_edit_id UUID REFERENCES content_edits(id) ON DELETE SET NULL,  -- set only on the AI turn that actually produced this content_edits row

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_content_conversation_turns_item_turn UNIQUE (content_item_id, turn_number),

  -- sender_identity must be present for peter turns and absent for ai turns
  -- (see design note above — 'ai' is already the accurate, non-generic
  -- answer to "who", so no separate identity value is meaningful there).
  CONSTRAINT chk_sender_identity_matches_sender CHECK (
    (sender = 'peter' AND sender_identity IS NOT NULL)
    OR
    (sender = 'ai' AND sender_identity IS NULL)
  ),

  -- Only the AI's own turn may link to the content_edits row it produced.
  CONSTRAINT chk_resulting_edit_only_on_ai_turn CHECK (
    resulting_content_edit_id IS NULL OR sender = 'ai'
  ),

  -- A 'question' turn never results in an edit, by definition.
  CONSTRAINT chk_resulting_edit_requires_edit_turn_type CHECK (
    resulting_content_edit_id IS NULL OR turn_type <> 'question'
  )
);

ALTER TABLE content_conversation_turns ENABLE ROW LEVEL SECURITY;

-- uq_content_conversation_turns_item_turn above already creates a unique
-- btree index on (content_item_id, turn_number), which covers both
-- "get this draft's conversation" (content_item_id) and "in order"
-- (turn_number) — no separate single-column content_item_id index is
-- added, it would just be redundant.

-- Supports "which chat turn produced this content_edits row" lookups.
CREATE INDEX idx_content_conversation_turns_resulting_content_edit_id
  ON content_conversation_turns(resulting_content_edit_id);

-- Supports filtering/reporting by exchange type (e.g. "how many
-- full-regeneration requests has this draft had").
CREATE INDEX idx_content_conversation_turns_turn_type
  ON content_conversation_turns(turn_type);

CREATE TRIGGER trg_content_conversation_turns_updated_at
  BEFORE UPDATE ON content_conversation_turns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP TRIGGER IF EXISTS trg_content_conversation_turns_updated_at ON content_conversation_turns;
-- DROP INDEX IF EXISTS idx_content_conversation_turns_turn_type;
-- DROP INDEX IF EXISTS idx_content_conversation_turns_resulting_content_edit_id;
-- DROP TABLE IF EXISTS content_conversation_turns;
--
-- Note: set_updated_at() is NOT dropped here — it is shared with earlier
-- migrations (20260626000000, 20260710000000, 20260715000000,
-- 20260801000000, ...) and other tables still use it.
--
-- ============================================================
