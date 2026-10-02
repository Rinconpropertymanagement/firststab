-- ============================================================
-- Migration: 20261002010000_add_severity_tier_to_complaints
-- Created:   2026-10-02
-- Author:    Neo (database specialist)
--
-- Adds a calibrated severity tier to `complaints`, to fix a real, confirmed
-- signal problem: `is_big_deal` (the existing generated column) is TRUE on
-- 2,732 of 2,733 live rows today — it no longer distinguishes anything,
-- because the 2026-09-13 significance-pass merge made Call 1 assign a
-- category to every conversation it reads (including routine ones), and
-- is_big_deal's formula (category IS NOT NULL OR needs_human_call OR
-- held_legal_fair_housing) was already flagged, in that same migration's
-- own column comment, as "now definitionally TRUE by construction" for
-- every source='email_ai' row. This migration does not touch is_big_deal —
-- that flag and its own semantic-gap comment are left exactly as they are,
-- per this project's "never modify an existing migration" rule. Severity
-- tiering is new, additive signal layered next to it, not a replacement.
--
-- Four new nullable columns, same grouped-prefix pattern this table's own
-- sibling table already uses (missive_conversation_significance's
-- keyword_check_flagged_protected_class / _flagged_category / _matched_
-- layer / _terms_version — a {value, detail, how-matched, version} group
-- under one prefix): severity_tier (the value), severity_rationale (the
-- AI's one-line "why", same transparency role as missive_conversation_
-- significance.why), severity_assessed_at (when), severity_rubric_version
-- (which rubric revision produced it). The rubric itself — four tiers,
-- three calibration rounds against Peter's own real judgment on real
-- complaints, 70% exact agreement on round 3 (every miss a single-tier,
-- defensible call, never urgent-buried-as-routine), a 500-complaint random
-- sample projecting ~177 urgent / ~155 worth_a_look / ~111 just_a_record /
-- ~2,290 no_issue against the real 2,733 total — is the task brief this
-- migration was built from, relayed via Jarvis. No standalone Oracle spec
-- file exists for this one, unlike this table's prior two migrations (both
-- cite a technical-spec.md); flagged here as a real gap in this build's
-- paper trail, not silently filled. See "GOVERNANCE FLAG" below for why
-- that gap matters for more than just paperwork tidiness.
--
-- This migration is NOT applied here — Peter applies it himself via
-- Supabase's SQL Editor, per this project's standing convention (no
-- CLI/DB URL in this environment).
--
-- ============================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT BUILD
-- ============================================================
--   - The retroactive backfill batch job for the 2,733 existing rows. Q's
--     build, same resumable Call 1/Call 2 batch shape as archive-search/
--     lib/significance-batch.js — this migration only makes the columns
--     exist for it to write into, and (below) makes sure they degrade
--     safely while that job is mid-run.
--   - Any change to the live categorization pipeline (significance-pass.js
--     / complaint-tracking/router.js) to assign severity_tier to NEW
--     complaints going forward. Also Q's build, explicitly out of scope
--     for this request.
--   - Any change to complaints_needing_attention (the home-page-tile/
--     Property 360 view) or to the home-count/list endpoints in router.js
--     to actually exclude severity_tier = 'no_issue' by default. The
--     request that produced this migration explicitly scoped "pipeline/UI
--     changes" to Q, separately — so this migration adds the column, the
--     CHECK, and the supporting index, but does not rewrite the view.
--     Flagged explicitly so this doesn't get lost: once the backfill has
--     run, three call sites need a `severity_tier IS DISTINCT FROM
--     'no_issue'` filter added for Peter's "invisible in normal use"
--     requirement to actually take effect —
--       1. complaints_needing_attention (this file's Section E, below —
--          the view itself is unchanged here, on purpose)
--       2. GET /api/complaint-tracking/home-count (router.js ~line 753)
--       3. GET /api/complaint-tracking (router.js ~line 710 — the
--          unfiltered list; whether "no_issue" should be hidden there by
--          default or just moved behind a toggle is a product call, not a
--          schema one)
--     Until that filter is added, every existing/new row's severity_tier
--     is NULL (not yet assessed) and the current behavior is completely
--     unchanged — adding these columns today is a true no-op for every
--     reader of this table until Q wires the filter in.
--
-- ============================================================
-- DESIGN DECISION — WHAT HAPPENS TO A "no_issue" ROW (Neo's judgment call,
-- as asked for)
-- ============================================================
-- Agreed with Peter's own lean: keep the row, make it cheap and trivial to
-- exclude from default views, never delete it. Three independent reasons
-- this schema already commits to that exact pattern elsewhere, not a new
-- principle invented here:
--   1. held_legal_fair_housing rows — kept forever, excluded from the
--      standard CCPA redaction path, visible only through deliberate
--      review, never dropped (20260910000000's Rule 4 note, carried
--      forward).
--   2. audit_log — append-only by construction (GOVERNANCE.md Rule 4,
--      point 2: "no UPDATE, no DELETE").
--   3. complaints_needing_attention itself already uses this exact
--      pattern for a different exclusion (a tenant-subject complaint whose
--      lease has ended drops out of the VIEW, never out of the TABLE) —
--      "the underlying complaints row is never deleted or hidden
--      elsewhere; it just drops out of this one view" (that view's own
--      COMMENT ON VIEW, unchanged by this migration).
-- A fourth reason specific to this change: the calibration is Peter's own
-- judgment, captured at a point in time, already showing single-tier
-- disagreement on 30% of a 46-complaint sample. If a future recalibration
-- (severity_rubric_version bumps again, same convention CONTENT_PASS_
-- VERSION/SCREENING_VERSION already use elsewhere) finds this round's
-- "no_issue" calls were too aggressive, the only way to recover from that
-- cheaply is if the rows were never deleted in the first place — deleting
-- ~2,290 rows and then discovering some should not have been would be
-- unrecoverable, where keeping them and re-running a later batch pass over
-- them is just another backfill run.
--
-- No real indexing concern at today's 2,733-row volume — a plain
-- sequential scan over the whole table costs low-single-digit milliseconds
-- regardless of how the WHERE clause is written. The two partial indexes
-- added below (Section "INDEXES") are added anyway, for the same reason
-- this schema already indexes selective predicates at comparable or lower
-- row counts (idx_complaints_duplicate_suggested, idx_complaints_needs_
-- matching): cheap now, and this table has only grown since it was
-- created, never shrunk.
--
-- ============================================================
-- ROLLOUT / BACKFILL SAFETY (why nothing here is NOT NULL)
-- ============================================================
-- All four columns are nullable with no DEFAULT. None of the 2,733 existing
-- rows have a severity assessment yet — that is Q's forthcoming resumable
-- batch job, not this migration. NULL is a real, distinct fourth state
-- alongside the four tier values: "not yet assessed," never to be confused
-- with (or silently coerced into) any of urgent/worth_a_look/just_a_record/
-- no_issue. The lockstep CHECK below (complaints_severity_fields_together)
-- makes that state unambiguous at the DB level: either all four severity_*
-- columns are NULL together (not assessed) or all four are set together
-- (assessed, with a real rationale and a real rubric version on record) —
-- there is no partial state where, say, severity_tier is set but
-- severity_rubric_version is not. This is stricter than missive_
-- conversation_significance.why (nullable independently of category, no
-- lockstep) — a deliberate departure, not an oversight: the request this
-- migration was built from is explicit that the rationale is load-bearing
-- transparency ("staff can see the reasoning, not just a label"), not an
-- optional nice-to-have the way `why` has always been treated. A batch job
-- that writes severity_tier without also writing a rationale and a version
-- is a bug this constraint catches at the database, not something the
-- backfill script has to separately remember to enforce.
--
-- held_legal_fair_housing rows are excluded from this backfill for the
-- same reason they are already excluded from every other AI-derived field
-- on this table: complaints_held_excludes_ai_fields (existing constraint,
-- extended below, not replaced in spirit) already establishes that a held
-- row is a minimal placeholder, never run through AI categorization at
-- all. Severity tiering is one more AI judgment pass over complaint
-- content — it follows that same existing rule, not a new one. A held row
-- is already the most severe thing this table can represent (a formal
-- Fair Housing/HUD/CRD complaint or real attorney correspondence) and is
-- already guaranteed-visible via is_big_deal; it does not need, and must
-- not get, an automated severity_tier assignment layered on top. If Peter
-- later wants held rows to visibly read as "urgent" in the UI, that is a
-- display-layer decision Q can make by checking held_legal_fair_housing
-- directly — it should not be done by having the backfill job write
-- severity_tier = 'urgent' onto a held row, which this constraint
-- correctly blocks at the database level.
--
-- ============================================================
-- GOVERNANCE FLAG — Neo's independent read (a parallel heads-up to Asimov
-- is already in motion per the request; this is not a substitute for that,
-- and this migration file does not wait on it before being written, since
-- authoring an unapplied schema file touches no real data and makes no
-- live decision)
-- ============================================================
-- My own read, for what it's worth alongside Asimov's: I do NOT think this
-- is safely filed under "a normal recalibration of existing categorization
-- logic" the way the protected_class_flag removal or the owner_instruction
-- _rejected fix were, and I'd flag it for a fresh pass rather than wave it
-- through on precedent, for three concrete reasons:
--
--   1. CLAUDE.md's own definition of a compliance build names "score" as
--      a tenant-decision-influencing action ("makes or influences a
--      decision about an applicant or tenant (approve, deny, screen,
--      score)"). severity_tier IS a score — a new one, not a rename or a
--      threshold tweak on an existing one.
--   2. Effect size, not just mechanism: this doesn't just relabel what's
--      already visible, it is designed to make ~84% of today's flagged
--      population (2,733 -> ~330 under the 500-sample projection)
--      invisible by default. GOVERNANCE.md Rule 6 classifies changes to
--      "decision criteria, compliance logic" as Critical — attorney
--      review + 7 days shadow mode — specifically because of effect size
--      like this, not because of how many lines of code changed.
--   3. The "urgent" tier definition explicitly includes "an unresolved
--      actively-disputed Fair Housing/accommodation request" — meaning
--      this rubric is the thing deciding whether a NON-held Fair-Housing-
--      adjacent complaint reads as top-priority or gets sorted into
--      something hidden by default. That is squarely Rule 9 / Fair
--      Housing Standard territory (human-in-the-loop visibility into
--      exactly this category of complaint), not just an internal
--      operations nicety.
--
-- None of this is a reason to block writing or handing over this schema
-- file — it's additive, unapplied, and reversible. It is a reason the
-- backfill batch job and any pipeline/UI change should wait for Asimov's
-- (and likely Mason's, given point 3) actual sign-off before running
-- against the real 2,733 rows or changing what Peter sees by default —
-- consistent with this project's own standing rule that Asimov/Mason are
-- never silently deferred on a build that fits CLAUDE.md's compliance-
-- build definition. Not my gate to clear — flagging it plainly, as asked.
--
-- ============================================================
-- RULE 4 DATA INVENTORY ADDENDUM (GOVERNANCE.md Rule 4) — complaints is
-- already a registered table (20260910000000's Rule 4 block); this adds
-- four columns, one of which (severity_rationale) is a genuinely new
-- PII-adjacent free-text field, not a repeat of an existing pattern, so
-- it gets named here rather than assumed covered by the original writeup.
-- ============================================================
--   pii_fields added: severity_rationale (free-text; lower density than
--     `description` by design — "one-line rationale," not a summary of
--     the underlying content — but can still restate who/what a dispute
--     involves). severity_tier/severity_assessed_at/severity_rubric_version
--     are not personal data on their own (a tier label, a timestamp, a
--     version string).
--   agents_with_access: unchanged — the same categorization pipeline
--     (Claude, via ANTHROPIC_API_KEY) already named in this table's
--     original Rule 4 block, running a new, separately-calibrated
--     prompt/rubric rather than a new agent or a new credential.
--   retention_policy: unchanged — same indefinite retention already on
--     record for this table (v1-scope.md Section 4's "never delete"
--     stance, carried forward; this migration's own "keep no_issue rows"
--     design decision above is a direct application of that same policy,
--     not a new one).
--   ccpa_exportable / ccpa_deletable: unchanged in kind — severity_
--     rationale redacts via the exact same description/resolution_note ->
--     "[REDACTED]" convention already established for this table, with the
--     same held_legal_fair_housing hard-refuse carve-out (which this
--     migration's own held-row exclusion above guarantees stays
--     NULL/moot for every held row regardless).
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No. Four new nullable columns,
--       no default, added via ADD COLUMN IF NOT EXISTS — every existing
--       row gets NULL in all four, which is exactly the "not yet assessed"
--       state this migration is designed around. The one existing
--       constraint this migration widens (complaints_held_excludes_ai_
--       fields) is widened to require severity_tier IS NULL on a held
--       row — trivially satisfied by every existing row today, since the
--       column is brand new and starts NULL everywhere.
--   [x] Does this touch a table other code depends on? Yes —
--       `complaints` is read by complaint-tracking/router.js (list, home-
--       count, Property 360 endpoints), complaints_needing_attention, and
--       complaints_historical_review_required. All of those do `SELECT *`
--       or name columns explicitly; none of them currently reads or
--       filters on severity_tier (it doesn't exist yet in their code), so
--       every one of them gets four extra NULL-valued columns back and
--       nothing in their existing behavior changes. That is the entire
--       point of shipping this additively, ahead of the view/router
--       changes named above as deliberately out of scope.
--   [x] Additive or destructive? Fully additive — four new columns, one
--       new lockstep CHECK, one existing CHECK widened (a pure narrowing
--       of what's legal for held rows specifically, on a brand-new column
--       no row has ever set), two new partial indexes. No column dropped,
--       no existing column's type or default changed, no row updated.
--   [ ] Tested on a copy of the data first? No staging copy of Supabase
--       exists in this project — same standing caveat every migration
--       here carries. Mitigated by: every column is new and starts NULL
--       on every row; the one widened constraint can only ever reject a
--       future write that tries to set severity_tier on a held row (there
--       is no such write today, and this migration doesn't add one).
--   [~] Governance go-ahead — NOT yet on record for this specific schema,
--       unlike this table's prior two migrations (both cite a dated
--       Asimov+Mason pass in their own header). See "GOVERNANCE FLAG"
--       above. Does not block this file existing; should block the
--       backfill batch job and any view/router change that acts on these
--       columns.
-- ============================================================


ALTER TABLE complaints
  ADD COLUMN IF NOT EXISTS severity_tier TEXT
    CHECK (severity_tier IS NULL OR severity_tier IN ('urgent', 'worth_a_look', 'just_a_record', 'no_issue')),
  ADD COLUMN IF NOT EXISTS severity_rationale       TEXT,
  ADD COLUMN IF NOT EXISTS severity_assessed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS severity_rubric_version  TEXT;

-- Lockstep: either all four are NULL (not yet assessed) or all four are
-- set (assessed, with a rationale and a version on record). See "ROLLOUT /
-- BACKFILL SAFETY" above for why this is stricter than `why`'s own
-- independence from `category` elsewhere in this schema.
ALTER TABLE complaints
  ADD CONSTRAINT complaints_severity_fields_together CHECK (
    (severity_tier IS NULL AND severity_rationale IS NULL AND severity_assessed_at IS NULL AND severity_rubric_version IS NULL)
    OR
    (severity_tier IS NOT NULL AND severity_rationale IS NOT NULL AND severity_assessed_at IS NOT NULL AND severity_rubric_version IS NOT NULL)
  );

-- Extends the existing held-row invariant (complaints_held_excludes_ai_
-- fields, last touched 20260913020000) to this new column — a held row
-- gets no automated severity assessment, same as it gets no category, no
-- needs_human_call, no escalation_signal. See "ROLLOUT / BACKFILL SAFETY"
-- above for the reasoning. Because severity_tier is already forced into
-- lockstep with the other three severity_* columns (constraint just
-- above), checking severity_tier alone here is sufficient to guarantee all
-- four stay NULL on a held row.
ALTER TABLE complaints
  DROP CONSTRAINT IF EXISTS complaints_held_excludes_ai_fields;
ALTER TABLE complaints
  ADD CONSTRAINT complaints_held_excludes_ai_fields CHECK (
    held_legal_fair_housing = FALSE OR (
      category IS NULL AND needs_human_call = FALSE AND description IS NULL
      AND flagged_protected_class = FALSE AND tone_trend IS NULL
      AND escalation_signal IS NULL AND owner_instruction_rejected IS NULL
      AND severity_tier IS NULL
    )
  );


-- ============================================================
-- INDEXES
-- ============================================================

-- The backfill batch job's own driver query: "find complaints not yet
-- severity-assessed, chunk through them, resumable" — same shape as
-- idx_complaints_needs_matching / the significance-batch driver queries
-- elsewhere in this schema. Shrinks toward empty as the backfill
-- progresses; cheap to keep afterward for the same reason it's cheap to
-- add now.
CREATE INDEX IF NOT EXISTS idx_complaints_severity_unassessed
  ON complaints(created_at) WHERE severity_tier IS NULL;

-- Supports whichever of the three call sites named above (home-count,
-- Property 360, the main list) Q wires up first to exclude 'no_issue' by
-- default. IS DISTINCT FROM (not !=) so a NULL (not-yet-assessed) row
-- stays matched — unassessed rows must keep showing up in default views
-- during rollout, never get treated as equivalent to a confirmed
-- 'no_issue' call just because neither has run yet.
CREATE INDEX IF NOT EXISTS idx_complaints_severity_visible
  ON complaints(created_at) WHERE severity_tier IS DISTINCT FROM 'no_issue';

-- No plain (non-partial) index on severity_tier alone. At 2,733 rows a
-- full scan is sub-millisecond regardless; the two partial indexes above
-- already cover the two real access patterns this migration knows about
-- (find unassessed; exclude no_issue). If a future dashboard needs "every
-- row of exactly one tier, portfolio-wide" as its own query, add a plain
-- btree index then, against that real query — not speculatively here.


-- ============================================================
-- COMMENTS
-- ============================================================

COMMENT ON COLUMN complaints.severity_tier IS
  'Calibrated severity (distinct from the tautological-for-AI-rows is_big_deal — see that column''s own comment): ''urgent'' (active dispute, obstruction, explicit legal/leave threat, or an unresolved actively-disputed Fair Housing/accommodation request), ''worth_a_look'' (real friction or an open disagreement not yet escalated, or a genuinely new unaddressed hazard with near-term timing risk), ''just_a_record'' (a real disagreement being actively negotiated, not yet escalated — never routine uncontested business regardless of money/permanence involved), ''no_issue'' (the default: routine business or a maintenance/habitability issue progressing with no dispute). NULL means not yet assessed — a real fourth state, never coerced into one of the four tiers; see complaints_severity_fields_together. Calibrated across three rounds against Peter''s own real judgment (70% exact agreement on round 3, every miss single-tier and defensible, never urgent-buried-as-routine). held_legal_fair_housing rows are structurally excluded from this field (complaints_held_excludes_ai_fields) — a held row is already the most severe thing this table represents and is never run through automated categorization of any kind.';

COMMENT ON COLUMN complaints.severity_rationale IS
  'The AI''s one-line rationale for severity_tier — same transparency role missive_conversation_significance.why already plays for that table''s category, so staff see the reasoning, not just a label. Always set together with severity_tier (complaints_severity_fields_together) — unlike `why`, which is independently nullable from category elsewhere in this schema; this field is load-bearing, not optional, per the calibration task''s own framing.';

COMMENT ON COLUMN complaints.severity_assessed_at IS
  'When this row''s severity_tier was assigned — by the retroactive backfill batch job for the 2,733 pre-existing rows, or by the live pipeline for anything assessed going forward (not built by this migration). NULL exactly when severity_tier is NULL (complaints_severity_fields_together). Distinct from created_at: a complaint can sit unassessed for a long time before a batch run reaches it.';

COMMENT ON COLUMN complaints.severity_rubric_version IS
  'Which rubric revision produced severity_tier/severity_rationale — same bump-on-material-change convention as significance-pass.js''s CONTENT_PASS_VERSION and screening-pass.js''s SCREENING_VERSION. Lets a future recalibration (this rubric has already gone through three rounds before shipping) tell which complaints were scored under which version, same spirit as complaints.extracted_by. Free text, no CHECK — same reason extracted_by has none.';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP INDEX IF EXISTS idx_complaints_severity_visible;
-- DROP INDEX IF EXISTS idx_complaints_severity_unassessed;
--
-- ALTER TABLE complaints
--   DROP CONSTRAINT IF EXISTS complaints_held_excludes_ai_fields;
-- ALTER TABLE complaints
--   ADD CONSTRAINT complaints_held_excludes_ai_fields CHECK (
--     held_legal_fair_housing = FALSE OR (
--       category IS NULL AND needs_human_call = FALSE AND description IS NULL
--       AND flagged_protected_class = FALSE AND tone_trend IS NULL
--       AND escalation_signal IS NULL AND owner_instruction_rejected IS NULL
--     )
--   );
-- -- Restores the exact pre-migration constraint (20260913020000's version,
-- -- without severity_tier) — safe regardless of whether any row has been
-- -- severity-assessed by the time this rolls back, since dropping the
-- -- columns next removes severity_tier from existence entirely.
--
-- ALTER TABLE complaints
--   DROP CONSTRAINT IF EXISTS complaints_severity_fields_together;
--
-- ALTER TABLE complaints
--   DROP COLUMN IF EXISTS severity_rubric_version,
--   DROP COLUMN IF EXISTS severity_assessed_at,
--   DROP COLUMN IF EXISTS severity_rationale,
--   DROP COLUMN IF EXISTS severity_tier;
-- -- Only safe once you've confirmed no backfill or live-pipeline work has
-- -- been built on top of these columns yet, or that losing whatever it has
-- -- written is acceptable — same standing caveat every DROP COLUMN
-- -- rollback in this schema carries. If the backfill batch job has run for
-- -- any length of time, consider exporting severity_tier/severity_
-- -- rationale/severity_assessed_at/severity_rubric_version first
-- -- (ccpa_exportable, per this table's existing Rule 4 posture) before
-- -- dropping them.
--
-- ============================================================
