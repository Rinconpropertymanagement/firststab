-- ============================================================
-- Migration: 20261002030000_widen_no_issue_guard_and_historical_review_
-- for_legal_and_rejected_instructions
-- Created:   2026-10-02
-- Author:    Neo (database specialist)
--
-- PLAIN ENGLISH: this widens two existing safety nets on the complaints
-- table so they also catch legal-exposure complaints and rejected-owner-
-- instruction findings, not just the three signals they already caught.
-- It does not create any new table or column, and does not touch any
-- other part of the schema.
--
-- Direct, same-day follow-up to 20261002020000_add_no_issue_protected_
-- signal_guard_to_complaints.sql (REQUIRES that migration already
-- applied — this one DROPs and re-ADDs the exact constraint it created).
-- Not folded into that file in place, per Neo's standing rule to never
-- modify an existing migration — same one-file-per-change convention
-- this project has used throughout (20261002010000 -> 20261002020000 is
-- the most recent prior example of this exact pattern).
--
-- WHY THIS MIGRATION EXISTS: Mason's scoped review of the now-live
-- severity-tier system (2,715 of 2,755 real complaints already assessed)
-- found the safety floor 20261002020000 added too narrow. Verbatim
-- finding, relayed via Jarvis: "Add category = 'legal_exposure' and
-- owner_instruction_rejected IN ('true','uncertain') to complaints_no_
-- issue_excludes_protected_signals's trigger conditions" and, separately,
-- "Add the same owner_instruction_rejected IN ('true','uncertain')
-- condition to complaints_historical_review_required's WHERE clause."
--
-- This migration is NOT applied here — Peter applies it himself via
-- Supabase's SQL Editor, same as every migration in this project.
--
-- ============================================================
-- A REAL FINDING THAT CHANGES HOW PART 1 MUST SHIP: 306 LIVE ROWS ALREADY
-- VIOLATE THE WIDENED CHECK CONSTRAINT — CONFIRMED AGAINST THE REAL
-- DATABASE, NOT ASSUMED SAFE BY ANALOGY TO 20261002020000
-- ============================================================
-- 20261002020000's own Migration Gate self-check could truthfully say
-- "no row has severity_tier set yet" — it shipped the same day as the
-- column, before any backfill ran. That precedent does NOT carry over
-- to this file: a real severity batch has since run against 2,715 real
-- complaints. Read-only query against the live table (service-role key,
-- SELECT only, no write), run before writing this file:
--
--   SELECT count(*) FROM complaints
--   WHERE severity_tier = 'no_issue' AND category = 'legal_exposure';
--   -> 306 rows (303 discovery_context = 'historical_backfill',
--      3 discovery_context = 'live_pipeline')
--
--   SELECT count(*) FROM complaints
--   WHERE severity_tier = 'no_issue'
--     AND owner_instruction_rejected IN ('true', 'uncertain');
--   -> 0 rows (this half of the widening adds no live violation)
--
-- A plain `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)` validates
-- every existing row by default. Pasted into Supabase's SQL Editor as a
-- normal ADD CONSTRAINT, this statement would fail outright on the first
-- of those 306 rows it scans — not a hypothetical, a guaranteed error,
-- and it would also hold a table-scanning lock on complaints the whole
-- time it checked. That is a Migration Gate failure as originally
-- planned. Rather than blocking this migration entirely, the standard,
-- safe fix below is to add the constraint NOT VALID.
--
-- WHAT NOT VALID DOES AND DOES NOT DO (so this is not mistaken for a
-- weaker or partial guarantee):
--   - From the moment this statement runs, EVERY new INSERT and UPDATE
--     on complaints is checked against the full, widened rule — no
--     future write can set severity_tier = 'no_issue' while category =
--     'legal_exposure' or owner_instruction_rejected IN ('true',
--     'uncertain'), exactly as validly as if the constraint had been
--     added the normal way. The guarantee for all FUTURE data is
--     complete and immediate.
--   - It does NOT scan or touch the 306 existing rows. Their stored
--     values are completely unchanged by this migration — this file
--     corrects no data, by design (a data correction is a judgment call
--     about 306 real, already-delivered AI assessments, not a schema
--     change, and is explicitly out of scope here).
--   - A NOT VALID constraint still shows up in \d complaints and in any
--     tool that reads pg_constraint — it is not hidden or soft in any
--     way other than skipping the one-time historical scan.
--   - This migration includes, but does NOT run, a VALIDATE CONSTRAINT
--     statement (see below the ADD CONSTRAINT). Running it today would
--     simply fail on the same 306 rows VALIDATE would find — exactly the
--     same failure a plain ADD CONSTRAINT would hit immediately, just
--     deferred to a moment Peter/Q control instead of blocking this
--     migration's deploy outright. Run it only after the 306 rows have
--     been corrected (most likely: Q re-running severity assessment on
--     them against the now-widened rubric, surfacing a real question —
--     were these 306 legal_exposure complaints mis-tiered, or should
--     some stay 'no_issue' with category reassessed instead? — that is
--     a judgment call for Q/Oracle/Mason, not Neo, and not resolved by
--     this file).
--
-- FLAGGED EXPLICITLY, NOT BURIED: this finding means Mason's review
-- surfaced something real and already live, not just a future-facing
-- gap — 306 real complaints flagged legal_exposure are sitting with
-- severity_tier = 'no_issue' today. That is worth Peter's and Mason's
-- attention on its own, independent of whether this schema change ships.
-- This migration makes the GOING-FORWARD guarantee airtight today; it
-- does not and cannot retroactively fix those 306 rows itself.
--
-- ============================================================
-- PART 2 (the view) HAS NO EQUIVALENT RISK — CONFIRMED, NOT ASSUMED
-- ============================================================
-- CREATE OR REPLACE VIEW has no validation step and cannot fail against
-- existing data — it only changes what a later SELECT against the view
-- returns. Read-only check of the real impact, run before writing this
-- file: of the historical, uncleared rows with owner_instruction_rejected
-- IN ('true','uncertain'), exactly 2 have a joined missive_conversation_
-- significance.resolution_status of 'open' and will newly appear on this
-- checklist once this ships (a 3rd matching row has resolution_status =
-- 'resolved' and will not). Two real rows newly requiring affirmative
-- human clearance — small, additive, and exactly the intended effect of
-- Mason's finding. Nothing here needs NOT VALID or any other mitigation.
--
-- ============================================================
-- CONFIRMED, NOT ASSUMED: THE REAL CURRENT SHAPE OF BOTH OBJECTS BEING
-- WIDENED
-- ============================================================
-- Re-read directly from the two files Mason's review named, not from
-- memory, before writing this one:
--
--   - complaints_no_issue_excludes_protected_signals (20261002020000):
--     currently blocks severity_tier = 'no_issue' only when
--     needs_human_call = TRUE, category = 'accommodation_related', or
--     flagged_protected_class = TRUE. Confirmed a plain CHECK constraint
--     on complaints, no trigger involved.
--
--   - complaints_historical_review_required (20260913020000, Section E):
--     confirmed a VIEW (not a partial index — Mason's own finding asked
--     this be confirmed), joining complaints to missive_conversation_
--     significance on s.complaint_id = c.id, currently surfacing a
--     historical_backfill row, uncleared, with the significance row's
--     resolution_status IN ('open','unknown'), AND (category IN
--     ('legal_exposure','accommodation_related') OR escalation_signal IN
--     ('blocked_resolution','major_money_property_risk')).
--
-- Both changes below ADD a condition to an existing OR-group in each
-- object — neither removes or loosens anything either object already
-- checks.
--
-- ============================================================
-- GOVERNANCE.md RULE 1 / RULE 4 — CONFIRMED, NEITHER APPLIES NEW
-- OBLIGATIONS HERE
-- ============================================================
-- Rule 4 (new tables need a data-inventory entry): N/A. This migration
-- creates no new table and no new column — category, owner_instruction_
-- rejected, and severity_tier all already exist on complaints and are
-- already covered by the existing inventory (compliance/archive-search-
-- significance-complaint-merge-data-inventory.md, written alongside
-- 20260913020000). Confirmed by checking the compliance/ directory for a
-- severity-tier-specific inventory doc before writing this file — none
-- exists, consistent with 20261002010000/20261002020000 not having
-- created one either, because severity_tier is a derived AI-assessment
-- field on an already-inventoried table, not a new PII surface.
--
-- Rule 1 (every AI decision logged to audit_log): N/A, same reasoning as
-- 20261002020000's own self-check. This file adds no new write path —
-- Q's existing complaint_tracking.severity_assessed audit_log write
-- (when severity_tier/severity_rationale/severity_rubric_version are set
-- together) already covers every row this constraint could ever block.
-- A write this constraint rejects fails the whole transaction, the same
-- as any other CHECK violation already does elsewhere in this schema —
-- nothing is silently written, so there is nothing new to log.
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No row's stored data is
--       altered by this file (confirmed above — NOT VALID skips the
--       historical scan; the view is a pure query-logic change). The
--       306-row finding above is a pre-existing data-quality fact this
--       migration surfaces and protects against going forward, not
--       something this migration causes or worsens.
--   [x] Does this touch a table other code depends on? Yes, complaints —
--       mitigated the same way 20261002020000 was: this only adds a
--       stricter write-time guarantee and widens a read-only review
--       checklist; nothing that reads complaints today breaks because a
--       FUTURE write got checked more strictly, or because 2 more rows
--       now appear on a review list that already existed.
--   [x] Additive or destructive? Additive/restrictive-going-forward only.
--       No column, table, index, or existing constraint condition is
--       removed or loosened — both changes add an OR'd condition to an
--       existing rule.
--   [x] Tested on a copy of the data first? No staging copy exists in
--       this project, same standing caveat as always — mitigated here by
--       actually running the real, read-only impact queries above
--       against live Supabase before writing a single line of DDL,
--       rather than assuming safety by analogy to a prior migration whose
--       own safety argument ("no row has this value yet") no longer
--       holds now that a real batch has run.
--   [x] Governance go-ahead for THIS SPECIFIC widening — yes: this
--       migration exists because Mason's scoped review required it,
--       relayed via Jarvis, with Peter's explicit authorization to build
--       it. Does not itself resolve the 306-row data-quality finding
--       above, and does not run VALIDATE CONSTRAINT — that remains a
--       separate, later decision for Q/Mason/Peter once the 306 rows
--       have been looked at.
-- ============================================================


-- ============================================================
-- PART 1: complaints_no_issue_excludes_protected_signals — widened to
-- also exclude category = 'legal_exposure' and owner_instruction_
-- rejected IN ('true','uncertain'), in addition to the three conditions
-- it already enforced. Added NOT VALID — see the finding above for why.
-- ============================================================

ALTER TABLE complaints
  DROP CONSTRAINT IF EXISTS complaints_no_issue_excludes_protected_signals;

ALTER TABLE complaints
  ADD CONSTRAINT complaints_no_issue_excludes_protected_signals CHECK (
    severity_tier IS DISTINCT FROM 'no_issue' OR (
      needs_human_call = FALSE
      AND category IS DISTINCT FROM 'accommodation_related'
      AND category IS DISTINCT FROM 'legal_exposure'
      AND flagged_protected_class = FALSE
      AND owner_instruction_rejected IS DISTINCT FROM 'true'
      AND owner_instruction_rejected IS DISTINCT FROM 'uncertain'
    )
  ) NOT VALID;

-- Deliberately NOT run as part of this migration — see the finding
-- above. Run this by hand, separately, only after the 306 pre-existing
-- violating rows (SELECT count(*) FROM complaints WHERE severity_tier =
-- 'no_issue' AND category = 'legal_exposure') have been corrected:
--
--   ALTER TABLE complaints VALIDATE CONSTRAINT complaints_no_issue_excludes_protected_signals;

-- Re-issued in full (COMMENT ON COLUMN always replaces the previous text
-- outright), same convention 20261002020000 used, so anyone reading this
-- column's comment directly in Supabase sees the complete, current
-- invariant rather than only what the prior migration knew about.
COMMENT ON COLUMN complaints.severity_tier IS
  'Calibrated severity (distinct from the tautological-for-AI-rows is_big_deal — see that column''s own comment): ''urgent'' (active dispute, obstruction, explicit legal/leave threat, or an unresolved actively-disputed Fair Housing/accommodation request), ''worth_a_look'' (real friction or an open disagreement not yet escalated, or a genuinely new unaddressed hazard with near-term timing risk), ''just_a_record'' (a real disagreement being actively negotiated, not yet escalated — never routine uncontested business regardless of money/permanence involved), ''no_issue'' (the default: routine business or a maintenance/habitability issue progressing with no dispute). NULL means not yet assessed — a real fourth state, never coerced into one of the four tiers; see complaints_severity_fields_together. Calibrated across three rounds against Peter''s own real judgment (70% exact agreement on round 3, every miss single-tier and defensible, never urgent-buried-as-routine). held_legal_fair_housing rows are structurally excluded from this field (complaints_held_excludes_ai_fields) — a held row is already the most severe thing this table represents and is never run through automated categorization of any kind. GUARANTEED, not just calibration-likely (complaints_no_issue_excludes_protected_signals, widened 2026-10-02 per Mason''s scoped review): this can never equal ''no_issue'' on any row where needs_human_call = TRUE, category IN (''accommodation_related'', ''legal_exposure''), flagged_protected_class = TRUE, or owner_instruction_rejected IN (''true'',''uncertain''), regardless of what any prompt, rubric, or recalibration ever outputs — the database refuses the write outright. NOTE: added NOT VALID on 2026-10-02 because 306 rows already assessed before this widening (303 historical_backfill, 3 live_pipeline) have severity_tier = ''no_issue'' with category = ''legal_exposure'' — those specific rows are grandfathered until corrected and VALIDATEd; the guarantee is nonetheless airtight for every row written or updated from 2026-10-02 onward.';


-- ============================================================
-- PART 2: complaints_historical_review_required — widened to also
-- surface a row when owner_instruction_rejected IN ('true','uncertain'),
-- alongside the category/escalation_signal conditions it already checks.
-- Pure query-logic change, no validation step, no risk of failing
-- against existing data.
-- ============================================================

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
    OR c.owner_instruction_rejected IN ('true', 'uncertain')
  );

COMMENT ON VIEW complaints_historical_review_required IS
  'Spec Section 6''s bounded, must-be-affirmatively-cleared checklist — NOT the same population as the "Needs a Human Call" queue (disjoint by construction: this view only ever includes a row already is_big_issue = TRUE through category/escalation_signal/owner_instruction_rejected; the queue only ever includes a row where needs_human_call is the sole signal). Widened 2026-10-02 per Mason''s scoped review to also surface a row where owner_instruction_rejected IN (''true'',''uncertain'') — confirmed against real data at widening time: 2 historical, uncleared rows newly qualify (a 3rd candidate has resolution_status = ''resolved'' and correctly does not). Clearing a row here means setting complaints.historical_review_cleared_at/_by (both together; no DB-level lockstep CHECK added here since neither column is ever set without the other by construction in Q''s future clearing action — a candidate for a future migration if that discipline should be DB-enforced too). Joins to missive_conversation_significance for resolution_status, which complaints itself does not carry.';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- -- View first, back to its pre-widening definition (20260913020000):
-- CREATE OR REPLACE VIEW complaints_historical_review_required AS
-- SELECT c.*
-- FROM complaints c
-- JOIN missive_conversation_significance s ON s.complaint_id = c.id
-- WHERE c.discovery_context = 'historical_backfill'
--   AND c.historical_review_cleared_at IS NULL
--   AND s.resolution_status IN ('open', 'unknown')
--   AND (
--     c.category IN ('legal_exposure', 'accommodation_related')
--     OR c.escalation_signal IN ('blocked_resolution', 'major_money_property_risk')
--   );
--
-- COMMENT ON VIEW complaints_historical_review_required IS
--   'Spec Section 6''s bounded, must-be-affirmatively-cleared checklist — NOT the same population as the "Needs a Human Call" queue (disjoint by construction: this view only ever includes a row already is_big_issue = TRUE through category/escalation_signal; the queue only ever includes a row where needs_human_call is the sole signal). Clearing a row here means setting complaints.historical_review_cleared_at/_by (both together; no DB-level lockstep CHECK added here since neither column is ever set without the other by construction in Q''s future clearing action — a candidate for a future migration if that discipline should be DB-enforced too). Joins to missive_conversation_significance for resolution_status, which complaints itself does not carry — see the inline comment on this view''s own definition above.';
--
-- -- Constraint back to its pre-widening form (20261002020000). Safe at
-- -- any time, VALID or NOT VALID — removing/replacing this constraint
-- -- cannot itself corrupt data; it only stops blocking a write it would
-- -- otherwise have rejected. Rolling this back after this constraint was
-- -- ever VALIDATEd and relied upon does not retroactively affect any
-- -- already-stored row either way.
-- ALTER TABLE complaints
--   DROP CONSTRAINT IF EXISTS complaints_no_issue_excludes_protected_signals;
--
-- ALTER TABLE complaints
--   ADD CONSTRAINT complaints_no_issue_excludes_protected_signals CHECK (
--     severity_tier IS DISTINCT FROM 'no_issue' OR (
--       needs_human_call = FALSE
--       AND category IS DISTINCT FROM 'accommodation_related'
--       AND flagged_protected_class = FALSE
--     )
--   );
-- -- NOT VALID omitted here deliberately: at rollback time, if this
-- -- constraint was ever VALIDATEd under its widened form, every existing
-- -- row already satisfies this narrower, pre-widening form trivially (a
-- -- row satisfying the stricter rule always satisfies the looser one), so
-- -- a plain validated ADD CONSTRAINT is safe and simpler. If rolling back
-- -- while still NOT VALID (never VALIDATEd), this plain form will
-- -- immediately re-encounter the same 306 pre-existing rows and fail the
-- -- same way the widened VALID form would have at deploy time — add NOT
-- -- VALID back here too in that specific situation.
--
-- COMMENT ON COLUMN complaints.severity_tier IS
--   'Calibrated severity (distinct from the tautological-for-AI-rows is_big_deal — see that column''s own comment): ''urgent'' (active dispute, obstruction, explicit legal/leave threat, or an unresolved actively-disputed Fair Housing/accommodation request), ''worth_a_look'' (real friction or an open disagreement not yet escalated, or a genuinely new unaddressed hazard with near-term timing risk), ''just_a_record'' (a real disagreement being actively negotiated, not yet escalated — never routine uncontested business regardless of money/permanence involved), ''no_issue'' (the default: routine business or a maintenance/habitability issue progressing with no dispute). NULL means not yet assessed — a real fourth state, never coerced into one of the four tiers; see complaints_severity_fields_together. Calibrated across three rounds against Peter''s own real judgment (70% exact agreement on round 3, every miss single-tier and defensible, never urgent-buried-as-routine). held_legal_fair_housing rows are structurally excluded from this field (complaints_held_excludes_ai_fields) — a held row is already the most severe thing this table represents and is never run through automated categorization of any kind. GUARANTEED, not just calibration-likely (complaints_no_issue_excludes_protected_signals, added 2026-10-02 per Asimov''s review): this can never equal ''no_issue'' on any row where needs_human_call = TRUE, category = ''accommodation_related'', or flagged_protected_class = TRUE, regardless of what any prompt, rubric, or recalibration ever outputs — the database refuses the write outright.';
--
-- ============================================================
