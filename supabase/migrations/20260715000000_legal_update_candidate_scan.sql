-- Migration: 0009_legal_update_candidate_scan
-- Created:   2026-07-15
-- Author:    Neo (database specialist)
--
-- Adds storage for a NEW discovery feed: an automated scan of LegiScan's
-- California bill-tracking API, looking for state bills that have just been
-- signed into law (chaptered). Local city ordinances (Oxnard/Ventura/
-- Thousand Oaks) are explicitly OUT of scope for this build — state law
-- only, for now.
--
--   1. legal_update_candidates — one row per chaptered CA bill the scan
--      finds, waiting for Mason (legal specialist) or Peter to review.
--   2. legal_update_scan_runs  — one row per scan attempt, same
--      "last scan: succeeded / failed" visibility pattern as the existing
--      topic_scan_runs table (20260711000000).
--
-- THE RULE THIS SCHEMA EXISTS TO ENFORCE — READ BEFORE CHANGING ANYTHING:
--   compliance_claims (20260710000000) is the ONLY table the AI is ever
--   allowed to read legal facts from when drafting content. Nothing about
--   this build changes that. This new feed does not, and must never, write
--   directly to compliance_claims. It only writes candidate rows here, for
--   a human to review.
--
--   That review is a TWO-STEP process, and the schema is built so the two
--   steps cannot be collapsed into one by accident:
--     Step 1: a human sets legal_update_candidates.review_status to
--             'approved' or 'rejected'. This alone creates nothing — it is
--             just a verdict on whether the candidate is worth acting on.
--     Step 2: separately, a human (Mason, most likely) actually writes and
--             saves a real compliance_claims row — with its own citation,
--             evidence, confidence rating, etc. — and only then is
--             resulting_claim_id set on the candidate, linking the two.
--   A row with review_status = 'approved' AND resulting_claim_id = NULL is
--   an expected, normal state: someone agreed this bill matters, but the
--   real, citable legal-claim writeup hasn't been done yet. Nothing in this
--   schema auto-populates resulting_claim_id — no trigger, no default. The
--   application (Q's UI) must never treat "approved" as "published."
--
-- Design notes:
--   - jurisdiction is typed as free TEXT (not an enum/CHECK), even though
--     every row from this scan will read "California" / statewide for now.
--     Local ordinance tracking (Oxnard/Ventura/Thousand Oaks) is a known,
--     explicitly-planned future addition — hardcoding a California-only
--     constraint here would just mean a follow-on migration the day that
--     work starts. No CHECK constraint is added to keep that door open.
--   - status_at_discovery records the LegiScan/CA-bulk-data status label
--     (e.g. "Chaptered") as evidence that this row passed the "actually
--     signed into law, not just passed or pending" filter. That filtering
--     itself happens in Q's scan script, not in this schema — but recording
--     the status here means a human reviewer (or a future audit) can see
--     why a given row was ever written in the first place, without trusting
--     the scan script blindly.
--   - effective_date is nullable: some chaptered bills state an effective
--     date immediately, others don't have one available at discovery time.
--   - topic_id links a candidate to one of the 12 tracked compliance_topics
--     when the scan's keyword-matching can reasonably tag it. Nullable
--     because not every bill will cleanly map to an existing topic.
--     ON DELETE SET NULL (not RESTRICT): this is a best-effort, soft tag on
--     a not-yet-real candidate, not a hard dependency the way
--     compliance_claims.topic_id is on a finished, citable claim — mirrors
--     the SET NULL behavior topic_suggestions.content_item_id already uses
--     in this schema for the same kind of soft back-reference.
--   - resulting_claim_id is nullable and ON DELETE SET NULL for the same
--     reason: it's a provenance link ("this candidate became that claim"),
--     not something that should ever block deleting a claim.
--   - No UNIQUE constraint on bill_number. CA bill numbers repeat across
--     legislative sessions (e.g. "SB 177" exists in every two-year
--     session), so bill_number alone can't safely be unique, and this
--     migration doesn't have enough information about LegiScan's own
--     identifiers to build a correct compound key. Exact-match dedup
--     ("have I already surfaced this bill?") is Q's job in the scan script,
--     the same way youtube_video_id dedup is handled in lib code today —
--     the plain index on bill_number below is what makes that lookup fast,
--     it does not enforce uniqueness itself.
--   - legal_update_scan_runs is a separate new table, not an extension of
--     topic_scan_runs. topic_scan_runs.suggestions_created counts rows
--     written to topic_suggestions (blog topic ideas); this feed counts
--     rows written to a completely different table with different meaning
--     (candidate legal facts). Widening topic_scan_runs's feed_source CHECK
--     to cover this would conflate two unrelated review queues under one
--     run-log. A separate table costs one extra CREATE TABLE and keeps each
--     run-log unambiguous about what it's counting — otherwise identical in
--     shape and purpose to topic_scan_runs (same succeeded/error_message/
--     append-only pattern).
--   - Both new tables get created_at; legal_update_candidates also gets
--     updated_at (+ trigger), since it is a row a human actively edits over
--     time (review_status, reviewed_by, reviewed_at, resulting_claim_id all
--     change after insert). legal_update_scan_runs does not get updated_at
--     — it is append-only, one row written per scan attempt and never
--     changed afterward, matching the topic_scan_runs/content_edits
--     precedent.
--
-- RLS is enabled on both new tables and locked down by default, matching
-- every other table in this schema — no permissive policy is added here.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- TABLE: legal_update_candidates
-- What it stores: one row per California state bill the LegiScan scan
-- finds that has actually been chaptered (signed into law) — a candidate
-- for Mason/Peter to review, NOT a finished legal fact. See the two-step
-- rule explained above: approving a row here does not create a
-- compliance_claims row by itself.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE legal_update_candidates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_number           TEXT NOT NULL,          -- e.g. "SB 177"
  jurisdiction          TEXT NOT NULL DEFAULT 'California',  -- free text; local ordinances are a known future addition
  summary               TEXT NOT NULL,          -- plain-English description auto-generated by the scan; a starting point, NOT a finished claim
  status_at_discovery   TEXT NOT NULL,          -- LegiScan/CA-bulk-data status label at discovery time, e.g. "Chaptered"
  effective_date        DATE,                   -- nullable — not every chaptered bill has a stated date available yet
  source_url            TEXT NOT NULL,          -- link to the real bill page (LegiScan or leginfo.legislature.ca.gov)
  topic_id              UUID REFERENCES compliance_topics(id) ON DELETE SET NULL,  -- nullable best-effort tag

  discovered_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  review_status         TEXT NOT NULL DEFAULT 'pending'
                          CHECK (review_status IN ('pending', 'approved', 'rejected')),
  reviewed_by           TEXT,                   -- who made the call (e.g. Mason's or Peter's identifier/email)
  reviewed_at           TIMESTAMPTZ,

  -- Set only once a human has actually written and saved a real
  -- compliance_claims row for this candidate. NEVER set automatically by
  -- approving review_status — see the two-step rule above.
  resulting_claim_id    UUID REFERENCES compliance_claims(id) ON DELETE SET NULL,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE legal_update_candidates ENABLE ROW LEVEL SECURITY;

-- Supports the scan script's "have I already surfaced this bill?" dedup
-- lookup before inserting a new row (see design note above — this index
-- makes that lookup fast; it does not itself enforce uniqueness).
CREATE INDEX idx_legal_update_candidates_bill_number
  ON legal_update_candidates(bill_number);

-- Supports the review queue's default view ("show me pending candidates").
CREATE INDEX idx_legal_update_candidates_review_status
  ON legal_update_candidates(review_status);

CREATE INDEX idx_legal_update_candidates_topic_id
  ON legal_update_candidates(topic_id);

-- Supports "has this candidate already become a real claim?" lookups.
CREATE INDEX idx_legal_update_candidates_resulting_claim_id
  ON legal_update_candidates(resulting_claim_id);

CREATE TRIGGER trg_legal_update_candidates_updated_at
  BEFORE UPDATE ON legal_update_candidates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TABLE: legal_update_scan_runs
-- What it stores: one row per LegiScan state-bill scan attempt — did it
-- run, did it succeed, how many new candidates it produced, and if it
-- failed, why. Same shape and purpose as topic_scan_runs (20260711000000),
-- kept as a separate table because it counts rows in a different table
-- with a different meaning — see design notes above.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE legal_update_scan_runs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_source           TEXT NOT NULL
                          CHECK (feed_source IN (
                            'legiscan_state_bill_scan'
                          )),
  ran_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- when this scan attempt executed
  succeeded             BOOLEAN NOT NULL,                    -- did the scan complete without error
  candidates_created    INTEGER NOT NULL DEFAULT 0,          -- how many new legal_update_candidates rows it inserted
  error_message         TEXT,                                -- nullable — populated only when succeeded = FALSE
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE legal_update_scan_runs ENABLE ROW LEVEL SECURITY;

-- Supports "what's the latest run for this feed" (ORDER BY ran_at DESC per
-- feed_source), same as idx_topic_scan_runs_feed_source_ran_at — what the
-- review page's status banner needs on every page load.
CREATE INDEX idx_legal_update_scan_runs_feed_source_ran_at
  ON legal_update_scan_runs(feed_source, ran_at DESC);


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP TABLE IF EXISTS legal_update_scan_runs;
--
-- DROP TRIGGER IF EXISTS trg_legal_update_candidates_updated_at ON legal_update_candidates;
-- DROP TABLE IF EXISTS legal_update_candidates;
--
-- Note: set_updated_at() is NOT dropped here — it is shared with earlier
-- migrations (20260626000000, 20260710000000) and other tables still use it.
--
-- ============================================================
