-- ============================================================
-- Migration: 20261018000000_rental_cma_quality
-- Created:   2026-10-17 (file prefix 20261018 so it sorts after every
--            existing migration; the last one is 20260929000000)
-- Author:    Neo (database specialist)
--
-- *** NOT APPLIED. Peter applies every migration by hand through
-- Supabase's SQL Editor. Nothing in this repo runs it. ***
--
-- Source of truth for the column list: projects/rental-analysis/
-- CMA-QUALITY-SPEC.md, Revision 3, section "Database change (Neo writes;
-- Peter applies once, BEFORE Phase B deploys)". One migration covers
-- Phases B, C, D and E of that spec. Phase A (the accuracy test) needs
-- no database change at all.
--
-- ============================================================
-- IN PLAIN ENGLISH (for Peter)
-- ============================================================
-- This adds 25 new, empty slots to the two tables that save rent
-- analyses (14 on each analysis, 11 on each comparable home) so the new
-- features have somewhere to keep their results: the $200 recommended
-- range, suggested list price, stretch price, confidence label, the
-- square-footage band, and the extra MLS facts (furnished, lease length,
-- 55+, pool/HOA flags, condition). It changes no existing report, deletes
-- nothing, and the rent-analysis tool you use today keeps working exactly
-- as it does now.
--
-- ONE EXISTING SAFETY RULE IS ALSO LOOSENED (added 2026-10-17 at the
-- coordinator's request, from a real failure): today the database refuses
-- to save any finished report that has no recommended-rent numbers, so an
-- address whose nearby homes are all the wrong type or size (for example
-- 3490 Union Pacific Avenue, a duplex, on 2026-09-21) ends as "failed"
-- instead of a finished report that simply says "not enough comparable
-- homes". After this change a finished report may have no numbers ONLY
-- when the code has recorded that it counted fewer than 4 comps (and
-- therefore shows no range and no prices). The code live today never
-- records that, so for today's code the old strict rule still applies.
--
-- TO APPLY: open Supabase, project rincon-management, SQL Editor, New
-- query; paste this whole file; press Run. Success looks like "Success.
-- No rows returned". Full steps, the check afterwards, and the undo
-- statements are in 20261018_APPLY-GUIDE.md (same folder).
--
-- ============================================================
-- *** ORDERING WARNING - READ BEFORE ANYONE DEPLOYS ANYTHING ***
-- ============================================================
-- This migration MUST be applied BEFORE any Phase B (or later) code is
-- deployed. The Phase B code writes the new rental_comps columns on
-- every analysis. If that code goes live first, the very first
-- insert('rental_comps', ...) fails with an unknown-column error
-- (PostgREST PGRST204 / Postgres 42703) and EVERY analysis ends up as
-- "failed". The reverse order is completely safe: applying this first
-- does nothing visible to the code that is live today (proof below).
-- Required handshake: Peter applies -> TARS proves the columns exist
-- with a service-role GET (see "HOW TO CHECK") -> only then does Scotty
-- deploy anything.
--
-- ============================================================
-- WHAT THIS ADDS (25 columns, 25 CHECK constraints, 0 tables)
-- AND WHAT IT REPLACES (1 existing CHECK, loosened - see PART 2B)
-- ============================================================
-- rental_analyses (14 columns):
--   subject_condition, subject_age_restricted, subject_subdivision  (Items 3, 2, 5)
--   size_band_pct                                                    (Item 1)
--   headline_range_low, headline_range_high, suggested_list_price,
--   stretch_price, owner_goal, confidence_label, confidence_spread,
--   counted_comp_count, counted_leased_count, method_version         (Item 4)
--   + table CHECK chk_headline_range
-- rental_comps (11 columns):
--   mls_listing_id, year_built, subdivision_name, furnished_status,
--   lease_term_class, age_restricted, mls_condition, mls_flags       (Item 2)
--   condition_rating, condition_basis, condition_tags                (Item 3)
--   + table CHECK chk_rental_comps_rating_requires_listing_text
-- Plus COMMENT ON COLUMN notes on the five existing "wide computed range"
-- columns saying they are AUDIT ONLY (Peter's range rule, 2026-10-16).
-- Plus ONE replaced rule: the existing table CHECK
-- chk_complete_requires_rent_range is dropped and re-added in a looser
-- form (PART 2B) so a finished report with fewer than 4 counted comps can
-- be saved with no recommended-rent numbers.
-- No existing column is dropped or altered; the only change to existing
-- columns is comment text (metadata only, none of those five had a
-- comment before).
--
-- ============================================================
-- DESIGN DECISIONS
-- ============================================================
--   - ADDITIVE, except for the one loosened CHECK below, and no
--     back-fill. Every new column is nullable or has a
--     constant default (subject_age_restricted FALSE; mls_flags and
--     condition_tags '{}'). Existing rows (1,342 comps, 71 analyses as of
--     2026-10-17) simply get NULL / the default, which is what "this
--     report predates the new format" should look like. Constant
--     defaults do not rewrite the table (PostgreSQL 11+).
--
--   - CHECKS ARE ADDED AFTER THE COLUMNS, IN GUARDED BLOCKS, ON PURPOSE.
--     PostgreSQL processes a CHECK written inside "ADD COLUMN IF NOT
--     EXISTS ... CHECK (...)" as a separate step, so on a second run it
--     can try to add the same CHECK again even though the column is
--     already there (a duplicate, or an error if it is named). To make
--     "run it twice" genuinely harmless, columns are added first and each
--     CHECK is then added only if no constraint of that name exists.
--     Every constraint has an explicit name so it can be found, widened
--     or dropped later.
--
--   - CLOSED VOCABULARIES. Every short text column is either a closed
--     list (CHECK ... IN (...)) or length-capped, and the two list
--     columns (mls_flags, condition_tags) use array containment
--     (<@) against the spec's lists. Consequence for Q: a value outside
--     a list fails the WHOLE insert, so the mappers must filter to the
--     vocabulary before inserting (the spec already requires this: "no
--     value can break a table CHECK"). To add a word to a list later:
--     DROP the named constraint and ADD it back with the longer list in
--     one migration, deployed together with the code that uses the word.
--
--   - NO LISTING TEXT CAN BE STORED. PublicRemarks, the model's evidence
--     quote and agent/office names have no column here. The free-text
--     columns are capped (mls_listing_id 40, method_version 40,
--     mls_condition 80, subdivision_name / subject_subdivision 120
--     characters), so even by accident a paragraph of MLS marketing text
--     would be rejected. Licensing question (Decision 11 in the spec)
--     stays with Recore/CRMLS and Mason.
--
--   - THE $500 RULE LIVES IN THE DATABASE TOO. chk_headline_range makes a
--     saved recommended range exactly $200 wide with round-hundred ends,
--     so no code bug can ever save a wide "recommendation". The width 200
--     and the stretch step +200 are Peter's approved numbers (Revision 3);
--     if he ever changes them, the CHECK changes in the same release.
--
--   - THE FOUR HEADLINE PRICE COLUMNS TRAVEL TOGETHER, with one tolerance.
--     Either all of headline_range_low, headline_range_high,
--     suggested_list_price, stretch_price are NULL (thin report, or a
--     report from before this format), or low, high and suggested are all
--     set and consistent. stretch_price may be NULL even when a range
--     exists: the spec hides the stretch price on Low-confidence reports,
--     and the code may then choose not to store it. What the CHECK will
--     not allow is a stretch price that is not exactly high + 200, or a
--     stretch price with no range.
--
--   - SQL NULL TRAP, handled. A CHECK passes when its result is NULL, not
--     only when it is TRUE. So "rating exists only when basis is
--     listing_text" is written as  rating IS NULL OR (basis IS NOT NULL
--     AND basis = 'listing_text')  - the naive  rating IS NULL OR basis =
--     'listing_text'  would silently ACCEPT a rating whose basis is NULL.
--
--   - No new indexes. Nothing queries by these columns (reports are read
--     by analysis id, which is already indexed). mls_listing_id is a
--     lookup key for TARS fact-checks on a handful of rows; with 1,342
--     comps an index would be pure overhead. Revisit if that changes.
--
--   - No new table, no new policy. Both tables already have RLS enabled
--     with no permissive policy, and the server reaches them with the
--     service role key (bypasses RLS); new columns inherit all of that.
--
--   - Protected-class note, stated plainly: age_restricted /
--     subject_age_restricted describe a COMMUNITY (an MLS "55+ community"
--     listing field), not a person, and nothing here is about an
--     applicant or tenant. The spec's compliance view (and its optional
--     Mason read of the "55+" wording) covers it; no personal data is
--     stored anywhere in this migration.
--
-- ============================================================
-- THE ONE EXISTING RULE THAT CHANGES: chk_complete_requires_rent_range
-- (PART 2B below; requested after the first draft of this file, from a
-- real failure in the live logs)
-- ============================================================
-- OLD rule (20260812010000): a row with status = 'complete' must have all
-- of recommended_rent_low / mid / high.
-- NEW rule, same name: a 'complete' row must have all three, EXCEPT that
-- all three may be NULL when counted_comp_count IS NOT NULL AND is below
-- 4 AND headline_range_low / headline_range_high / suggested_list_price /
-- stretch_price are all NULL too. A row whose counted_comp_count is NULL
-- (every row today's code writes) or 4 and up still needs all three.
-- It accepts everything the old rule accepted (it only adds one allowed
-- shape), so no existing row can fail it: the 69 complete analyses all
-- have the three numbers.
--
-- Why it is needed (read-only look at the code and the live data):
--   - Where the numbers come from today (identical in server.js ~l.516 /
--     ~l.607 and router.js ~l.460 / ~l.534, via lib/analyze.js
--     computeNumbers() -> lib/weighting.js computeRecommendedRange()):
--     comps are first stripped of Rincon-managed ones; each remaining
--     comp is repeated round(status weight 3/2/1 x bedroom multiplier
--     1 / 0.5 / 0 x property-type multiplier 1 / 0 x 2) times into a
--     sample; low / mid / high are its 25th / 50th / 75th percentiles.
--   - 4 or more counted comps, and also 1 to 3: the sample is not empty,
--     so low / mid / high are real numbers (one comp gives low = mid =
--     high). Today nothing refuses to produce numbers for 1-3 comps; the
--     "at least 4" idea only exists in the radius search and in the
--     narrative's "rough" wording. These saves already work.
--   - ZERO counted comps while at least one comp was returned (every comp
--     is a known different property type, 2+ bedrooms off, or
--     Rincon-managed): every comp repeats 0 times, the sample is empty,
--     percentile() returns null, so recommended.low / mid / high are all
--     NULL. The code still inserts every comp into rental_comps, then
--     sends the final update  status = 'complete'  with those three NULLs.
--     The old CHECK rejects it, the handler's catch block marks the
--     analysis 'failed' and answers HTTP 500, and the comps stay
--     attached to a failed analysis. Live example (2026-09-21 02:37 UTC):
--     3490 Union Pacific Avenue, duplex, 700 sq ft: 14 comps saved, every
--     one an apartment, single-family or condo (known different type),
--     zero counted, analysis status 'failed'. It is the only such case in
--     the 71 saved analyses; the other failed row (2026-08-14, a made-up
--     address) returned no comps at all, which exits earlier with status
--     'failed' and is NOT affected by this CHECK.
--   - Revision 3 makes the zero/few-comps outcome normal (fewer than 4
--     counted comps = no range and no prices, comps still shown), and
--     Phase B's size rule will produce it far more often, so such a
--     report must be saveable as 'complete'.
--
-- WHAT Q'S CODE HAS TO DO (so the save sends NULLs instead of failing):
--   1. In the SAME update that sets status = 'complete' (server.js and
--      router.js, the update of 'rental_analyses' after the comps insert),
--      also send counted_comp_count = the number of comps whose
--      exclusionReasons[i] is null (the array already in scope; counted =
--      not excluded), and counted_leased_count. The CHECK is evaluated on
--      that one update, so setting the count in a later update would not
--      help. recommended_rent_low / mid / high need no change: they are
--      already sent as recommended.low / mid / high, which are JS null
--      when nothing counted, and JSON null is stored as NULL.
--   2. For fewer than 4 counted comps send headline_range_low /
--      headline_range_high / suggested_list_price / stretch_price as NULL
--      (or omit them). Revision 3 requires that anyway; this CHECK now
--      enforces it for a 'complete' row with no recommended-rent numbers.
--   3. Keep sending the numbers for 1-3 comps if wanted: a 'complete' row
--      with all three present is accepted whatever the count is.
--   4. Cosmetic: the log line "recommended=${recommended.low}-
--      ${recommended.high}" will print null-null.
--   5. Not changed by this migration: the early exit when runActiveSources
--      returns zero comps at all (status 'failed', HTTP 500, nothing
--      saved). If Peter wants an address with no comps whatsoever to also
--      end as a finished "no comparable homes" report, that is a separate
--      code decision; the new rule would accept it (counted_comp_count 0).
--   The dashboard already copes with a missing recommendation
--   (hasRecommendation guard, pricePerSqft shows a dash for null); the
--   report text for thin reports is Phase C work.
--
-- Safety of the replacement itself:
--   - One ALTER TABLE statement does the DROP CONSTRAINT IF EXISTS and the
--     ADD CONSTRAINT together, so there is no instant in which the table
--     is without the rule, and a re-run simply replaces it with the same
--     text (the DROP-then-ADD pattern earlier migrations use, made
--     atomic). The name is unchanged.
--   - The new rule needs the columns from PART 1, so it comes after them.
--   - ROLLBACK ORDER MATTERS: dropping counted_comp_count would silently
--     DROP this constraint with it (Postgres removes any CHECK that uses
--     a dropped column) and leave the table with no completeness rule at
--     all. The rollback block therefore puts the ORIGINAL rule back
--     BEFORE dropping any column, and handles thin 'complete' rows saved
--     in the meantime (see the rollback section).
--
-- ============================================================
-- WHERE THE SPEC, THE REQUEST AND THE LIVE DATABASE DISAGREED
-- (checked with read-only GETs against the live project, 2026-10-17)
-- ============================================================
--   1. owner_goal third value. The request text said 'maximize'; the
--      approved spec (Revision 3: Database change table, constant
--      OWNER_GOALS, Decision 13) says 'maximize_rent'. This file follows
--      the SPEC: lease_quickly | balanced | maximize_rent. Code must
--      write exactly those three words or the insert fails.
--   2. stretch_price. The request said "a multiple of 50 above the range
--      high"; the spec says exactly high + 200 (and a multiple of 50
--      follows). This file follows the SPEC (stricter), with the NULL
--      tolerance described above.
--   3. File name. Spec suggests 20261017000000_..., request asks for
--      20261018000000_...; the request's name is used.
--   4. Live tables match the earlier migrations exactly: rental_analyses
--      and rental_comps have every column 20260812010000, 20260814000000
--      and 20260816010000 created, with the same types, defaults and
--      nullability; none of the 25 new column names exists yet (a GET for
--      rental_comps.mls_flags returns 42703 "does not exist" today); all
--      1,342 live comps already satisfy the existing property_type /
--      listing_status / sqft / rent rules. The CHECK definitions
--      themselves cannot be read through the REST API (only through the
--      SQL Editor), so "existing constraints are exactly as the migrations
--      say" is proven by the data conforming plus the optional catalog
--      query in the apply guide, not by reading pg_constraint.
--   5. chk_complete_requires_rent_range. The spec (Database change,
--      "Audit-only columns") says it "still needs the first three" on a
--      finished report, while the same spec's Revision 3 says fewer than 4
--      counted comps means no range and no prices (comps still shown).
--      Those cannot both hold, and the live logs show the conflict (the
--      2026-09-21 Union Pacific Avenue failure). Resolved per the
--      coordinator: the CHECK is loosened exactly as described above;
--      nothing else about the spec changes.
--
-- ============================================================
-- WHY THE CODE THAT IS LIVE TODAY KEEPS WORKING (read-only reasoning)
-- ============================================================
--   - The only production writers are the two copies of the same handler:
--     projects/rental-analysis/server.js (insert 'rental_analyses' ~l.456,
--     insert 'rental_comps' ~l.585, update 'rental_analyses' ~l.489/607/643)
--     and projects/hub/rental-analysis/router.js (~l.407/522/534/440/564).
--     Every one of them names its columns explicitly (compRows lists 21
--     columns; the final update lists 12), none names a new column, so
--     the new ones take NULL / their default. All new CHECKs pass on
--     NULL / the defaults, so chk_headline_range and the rating rule are
--     satisfied by every row the old code writes.
--   - No production code SELECTs from rental_analyses or rental_comps
--     (lib/ only reads rental_market_data, rental_comp_sources,
--     properties, users). The only "select=*" readers are the offline
--     Phase A scripts (backtest/data.js, backtest/a0-replay.js); they
--     treat rows as plain data, so extra keys just ride along, equally
--     on both sides of the A0 old-vs-new comparison.
--   - insert/update use  Prefer: return=representation, so the JSON the
--     dashboards receive will now carry the new keys (mls_flags [],
--     condition_tags [], subject_age_restricted false, the rest null).
--     Both dashboards read named fields only (their one Object.keys call
--     is on the market-data trend history), so extra keys are ignored.
--   - Locks and size: ALTER TABLE takes a brief exclusive lock; the
--     tables hold 1,342 and 71 rows, so each statement finishes in
--     milliseconds. An analysis that is mid-run at that instant just
--     waits that long.
--   - chk_complete_requires_rent_range is REPLACED by a looser rule (PART
--     2B). The code live today never writes counted_comp_count, so for
--     every row it saves the new rule reduces to the old one: a finished
--     report still needs recommended_rent_low/mid/high, which is exactly
--     why those three stay in the table (audit only). Today's one failure
--     mode (zero counted comps -> NULL numbers -> save refused) therefore
--     stays exactly as it is until Q's code starts sending
--     counted_comp_count; nothing gets worse and nothing changes early.
--
-- ============================================================
-- Gate check (must pass before applying to any real database):
--   [x] Rollback exists - see bottom of this file
--   [x] No existing data is broken - ADD COLUMN only, all nullable or
--       defaulted, no UPDATE; every new CHECK is true for NULL / the
--       defaults, which is all existing rows will hold. The one replaced
--       CHECK (PART 2B) accepts everything the old one accepted, and all
--       69 complete analyses already have the three numbers it looks for
--   [x] Touches tables other code depends on - rental_analyses and
--       rental_comps, which server.js and router.js write; shown above
--       to be unaffected (for today's code the replaced rule behaves
--       exactly as before)
--   [x] Additive (safe) or destructive - ADDITIVE except for two
--       reversible things: COMMENT ON COLUMN for five columns (metadata)
--       and the loosened chk_complete_requires_rent_range (a safety rule
--       made weaker on purpose, only for rows that declare fewer than 4
--       counted comps). Nothing is dropped that holds data.
--   [ ] Tested on a copy of the data first - NOT DONE. No staging copy of
--       Supabase exists and no local Postgres is available to Neo, so
--       this file has been checked by careful reading and against the
--       live column list, not executed in Postgres. The wording of every
--       CHECK was also run through a small logic simulator (58 good and
--       bad sample rows, SQL NULL rules included), which tests the
--       logic but not the SQL syntax. Mitigations: a pasted script
--       with several statements normally runs as one all-or-nothing
--       batch (Neo has not verified that on this project), every step is
--       guarded so a re-run is harmless, and the apply guide includes an
--       optional self-test that exercises every installed CHECK on a
--       throw-away temp table (no real row touched).
--
-- Rollback: see the section at the bottom of this file. It deletes
-- whatever the new columns hold, so use it only before Phase B+ code has
-- produced real reports (or after exporting them).
-- ============================================================


-- ============================================================
-- PART 1: rental_analyses - add the columns
-- ============================================================

ALTER TABLE rental_analyses
  ADD COLUMN IF NOT EXISTS subject_condition       TEXT,
  ADD COLUMN IF NOT EXISTS subject_age_restricted  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS subject_subdivision     TEXT,
  ADD COLUMN IF NOT EXISTS size_band_pct           SMALLINT,
  ADD COLUMN IF NOT EXISTS headline_range_low      NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS headline_range_high     NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS suggested_list_price    NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS stretch_price           NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS owner_goal              TEXT,
  ADD COLUMN IF NOT EXISTS confidence_label        TEXT,
  ADD COLUMN IF NOT EXISTS confidence_spread       NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS counted_comp_count      SMALLINT,
  ADD COLUMN IF NOT EXISTS counted_leased_count    SMALLINT,
  ADD COLUMN IF NOT EXISTS method_version          TEXT;


-- ============================================================
-- PART 2: rental_analyses - add the CHECK constraints
-- (each one only if a constraint of that name does not exist yet)
-- ============================================================

DO $do$
DECLARE
  chk RECORD;
BEGIN
  FOR chk IN
    SELECT v.conname, v.expr
    FROM (VALUES
      ('chk_rental_analyses_subject_condition',
       $e$subject_condition IS NULL OR subject_condition IN ('A+', 'A', 'B', 'C', 'D', 'F')$e$),

      ('chk_rental_analyses_subject_subdivision_len',
       $e$subject_subdivision IS NULL OR char_length(subject_subdivision) <= 120$e$),

      ('chk_rental_analyses_size_band_pct',
       $e$size_band_pct IS NULL OR (size_band_pct >= 1 AND size_band_pct <= 100)$e$),

      ('chk_rental_analyses_headline_range_low',
       $e$headline_range_low IS NULL OR (headline_range_low >= 0 AND MOD(headline_range_low, 100) = 0)$e$),

      ('chk_rental_analyses_headline_range_high',
       $e$headline_range_high IS NULL OR (headline_range_high >= 0 AND MOD(headline_range_high, 100) = 0)$e$),

      ('chk_rental_analyses_suggested_list_price',
       $e$suggested_list_price IS NULL OR (suggested_list_price >= 0 AND MOD(suggested_list_price, 50) = 0)$e$),

      ('chk_rental_analyses_stretch_price',
       $e$stretch_price IS NULL OR (stretch_price >= 0 AND MOD(stretch_price, 50) = 0)$e$),

      ('chk_rental_analyses_owner_goal',
       $e$owner_goal IS NULL OR owner_goal IN ('lease_quickly', 'balanced', 'maximize_rent')$e$),

      ('chk_rental_analyses_confidence_label',
       $e$confidence_label IS NULL OR confidence_label IN ('high', 'medium', 'low')$e$),

      ('chk_rental_analyses_confidence_spread',
       $e$confidence_spread IS NULL OR confidence_spread >= 0$e$),

      ('chk_rental_analyses_counted_comp_count',
       $e$counted_comp_count IS NULL OR counted_comp_count >= 0$e$),

      ('chk_rental_analyses_counted_leased_count',
       $e$counted_leased_count IS NULL OR counted_leased_count >= 0$e$),

      ('chk_rental_analyses_method_version_len',
       $e$method_version IS NULL OR char_length(method_version) <= 40$e$),

      -- The table-level rule (Peter's range rule, 2026-10-16): the saved
      -- recommended range is exactly $200 wide, the suggested price sits
      -- inside it, the stretch price (when stored) is exactly range high
      -- + 200, and the four values are never half-filled.
      ('chk_headline_range',
       $e$(
            headline_range_low IS NULL
            AND headline_range_high IS NULL
            AND suggested_list_price IS NULL
            AND stretch_price IS NULL
          )
          OR (
            headline_range_low IS NOT NULL
            AND headline_range_high IS NOT NULL
            AND suggested_list_price IS NOT NULL
            AND headline_range_high - headline_range_low = 200
            AND suggested_list_price >= headline_range_low
            AND suggested_list_price <= headline_range_high
            AND (stretch_price IS NULL OR stretch_price = headline_range_high + 200)
          )$e$)
    ) AS v(conname, expr)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = chk.conname
        AND conrelid = 'public.rental_analyses'::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.rental_analyses ADD CONSTRAINT %I CHECK (%s)',
        chk.conname, chk.expr
      );
    END IF;
  END LOOP;
END
$do$;


-- ============================================================
-- PART 2B: REPLACE chk_complete_requires_rent_range (loosened for thin
-- reports). Must come after PART 1, which adds the columns it reads.
--
-- OLD (20260812010000):
--   status <> 'complete'
--   OR (recommended_rent_low IS NOT NULL AND recommended_rent_mid IS NOT NULL
--       AND recommended_rent_high IS NOT NULL)
--
-- NEW: the same, OR a 'complete' report that has declared it counted
-- fewer than 4 comps and carries no recommended-rent numbers and no
-- headline range or prices at all. counted_comp_count NULL (today's
-- code) never matches the second shape, so it keeps the old behaviour.
-- DROP and ADD are ONE statement, so the rule is never absent.
-- ============================================================

ALTER TABLE rental_analyses
  DROP CONSTRAINT IF EXISTS chk_complete_requires_rent_range,
  ADD CONSTRAINT chk_complete_requires_rent_range CHECK (
    status <> 'complete'
    OR (
      recommended_rent_low IS NOT NULL
      AND recommended_rent_mid IS NOT NULL
      AND recommended_rent_high IS NOT NULL
    )
    OR (
      counted_comp_count IS NOT NULL
      AND counted_comp_count < 4
      AND recommended_rent_low IS NULL
      AND recommended_rent_mid IS NULL
      AND recommended_rent_high IS NULL
      AND headline_range_low IS NULL
      AND headline_range_high IS NULL
      AND suggested_list_price IS NULL
      AND stretch_price IS NULL
    )
  );


-- ============================================================
-- PART 3: rental_comps - add the columns
-- ============================================================

ALTER TABLE rental_comps
  ADD COLUMN IF NOT EXISTS mls_listing_id    TEXT,
  ADD COLUMN IF NOT EXISTS year_built        INTEGER,
  ADD COLUMN IF NOT EXISTS subdivision_name  TEXT,
  ADD COLUMN IF NOT EXISTS furnished_status  TEXT,
  ADD COLUMN IF NOT EXISTS lease_term_class  TEXT,
  ADD COLUMN IF NOT EXISTS age_restricted    BOOLEAN,
  ADD COLUMN IF NOT EXISTS mls_condition     TEXT,
  ADD COLUMN IF NOT EXISTS mls_flags         TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  ADD COLUMN IF NOT EXISTS condition_rating  TEXT,
  ADD COLUMN IF NOT EXISTS condition_basis   TEXT,
  ADD COLUMN IF NOT EXISTS condition_tags    TEXT[] NOT NULL DEFAULT '{}'::TEXT[];


-- ============================================================
-- PART 4: rental_comps - add the CHECK constraints
-- ============================================================

DO $do$
DECLARE
  chk RECORD;
BEGIN
  FOR chk IN
    SELECT v.conname, v.expr
    FROM (VALUES
      ('chk_rental_comps_mls_listing_id_len',
       $e$mls_listing_id IS NULL OR char_length(mls_listing_id) <= 40$e$),

      -- Same 1800-2100 window as rental_analyses.subject_year_built.
      ('chk_rental_comps_year_built',
       $e$year_built IS NULL OR (year_built >= 1800 AND year_built <= 2100)$e$),

      ('chk_rental_comps_subdivision_name_len',
       $e$subdivision_name IS NULL OR char_length(subdivision_name) <= 120$e$),

      ('chk_rental_comps_furnished_status',
       $e$furnished_status IS NULL OR furnished_status IN ('furnished', 'unfurnished', 'partial', 'either')$e$),

      ('chk_rental_comps_lease_term_class',
       $e$lease_term_class IS NULL OR lease_term_class IN ('long', 'short', 'six_month')$e$),

      -- The MLS's own short word (for example Turnkey); never free text.
      ('chk_rental_comps_mls_condition_len',
       $e$mls_condition IS NULL OR char_length(mls_condition) <= 80$e$),

      ('chk_rental_comps_mls_flags_vocab',
       $e$mls_flags <@ ARRAY[
            'furnished', 'partly_furnished', 'short_term', 'age_restricted',
            'hoa', 'private_pool', 'utilities_included', 'water_trash_included',
            'gardener_included', 'new_construction', 'adu_or_guest_house',
            'view_property'
          ]::TEXT[]$e$),

      ('chk_rental_comps_condition_rating',
       $e$condition_rating IS NULL OR condition_rating IN ('A+', 'A', 'B', 'C', 'D', 'F')$e$),

      ('chk_rental_comps_condition_basis',
       $e$condition_basis IS NULL OR condition_basis IN ('listing_text', 'unclear', 'not_available')$e$),

      ('chk_rental_comps_condition_tags_vocab',
       $e$condition_tags <@ ARRAY[
            'remodeled', 'new_build', 'stone_counters', 'new_flooring',
            'new_cabinets', 'updated_kitchen', 'updated_baths',
            'cosmetic_updates', 'original_finishes', 'needs_repair'
          ]::TEXT[]$e$),

      -- A rating exists only when it was read from listing text. Written
      -- with an explicit IS NOT NULL so a rating with a NULL basis is
      -- rejected (see "SQL NULL TRAP" in the design notes).
      ('chk_rental_comps_rating_requires_listing_text',
       $e$condition_rating IS NULL OR (condition_basis IS NOT NULL AND condition_basis = 'listing_text')$e$)
    ) AS v(conname, expr)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = chk.conname
        AND conrelid = 'public.rental_comps'::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.rental_comps ADD CONSTRAINT %I CHECK (%s)',
        chk.conname, chk.expr
      );
    END IF;
  END LOOP;
END
$do$;


-- ============================================================
-- PART 5: column comments - new columns
-- ============================================================

COMMENT ON COLUMN rental_analyses.subject_condition IS
  'Condition of the SUBJECT home on the A+ (completely remodeled) to F (trashed) scale, typed by the person running the analysis and shown as "set by staff". NULL = not rated. Display only in this build: never used in any rent number. CMA-QUALITY-SPEC.md Item 3 / Phase E.';

COMMENT ON COLUMN rental_analyses.subject_age_restricted IS
  'TRUE when staff ticked "Subject is in a 55+ community" on the form. A 55+ subject keeps 55+ comps; every other subject excludes them. NOT NULL DEFAULT FALSE: the box is optional, and reports from before it existed read as FALSE. Describes the community, not any person. Item 2.';

COMMENT ON COLUMN rental_analyses.subject_subdivision IS
  'Subject home''s subdivision / community name when it was found in the MLS (optional Phase D step 3B). NULL = unknown. Max 120 characters. Used only for a "same community" label. Item 5.';

COMMENT ON COLUMN rental_analyses.size_band_pct IS
  'Square-footage band applied when this report was run: comps must be within this many percent of the subject''s size (25 today). NULL = the rule did not apply (duplex, triplex, fourplex, apartment or other subject types) or the report predates the rule. 1-100. Item 1.';

COMMENT ON COLUMN rental_analyses.headline_range_low IS
  'Low end of the RECOMMENDED RANGE shown to staff and owners: exactly $200 wide (see chk_headline_range), both ends round hundreds. This is the "lease quickly" end. NULL on reports with fewer than 4 counted comps and on reports from before the recommended-range format. Item 4.';

COMMENT ON COLUMN rental_analyses.headline_range_high IS
  'High end of the RECOMMENDED RANGE: headline_range_low + 200. This is the "hold out for more" end. NULL when there is no recommended range. Item 4.';

COMMENT ON COLUMN rental_analyses.suggested_list_price IS
  'Suggested list price, a multiple of $50 inside the recommended range, chosen by owner_goal (lease_quickly = range low, balanced = weighted middle rounded to $50, maximize_rent = range high). NULL when there is no recommended range. Item 4.';

COMMENT ON COLUMN rental_analyses.stretch_price IS
  'Stretch price: ONE price, exactly headline_range_high + 200, shown on its own line with fixed words ("Above the recommended range; may take longer to lease"). Never part of a range, never drawn on the strip or chart, never printed on the owner page. NULL when there is no range; may also be NULL on Low-confidence reports if the code chooses not to store it. Item 4.';

COMMENT ON COLUMN rental_analyses.owner_goal IS
  'Owner goal picked on the form: lease_quickly, balanced or maximize_rent. Changes ONLY suggested_list_price, never the range, stretch price or confidence. NULL on reports from before the field existed (the server writes balanced when the form leaves it empty). Item 4 / Decision 13.';

COMMENT ON COLUMN rental_analyses.confidence_label IS
  'high, medium or low (lower-case), computed by code from how well the counted comps agree, how many there are and how many are confirmed leases. NULL when there is no recommended range. Item 4.3.';

COMMENT ON COLUMN rental_analyses.confidence_spread IS
  'AUDIT ONLY. The internal agreement statistic behind confidence_label: the weighted 25th-to-75th percentile gap of the counted comps, in dollars. Never displayed and never to be presented as a rent range. NULL when there is no recommended range. Item 4.3.';

COMMENT ON COLUMN rental_analyses.counted_comp_count IS
  'How many comps counted toward the recommendation when this report was run (excluded comps not included). NULL on reports from before this column existed. ALSO GATES chk_complete_requires_rent_range: a complete report may have NO recommended_rent_low/mid/high only when this is set and below 4 (and no headline range or prices); NULL or 4 and up still requires all three. The code must send it in the SAME update that sets status = complete. Item 4.';

COMMENT ON COLUMN rental_analyses.counted_leased_count IS
  'Of the counted comps, how many are confirmed leases (listing_status = leased). NULL on reports from before this column existed. Item 4.';

COMMENT ON COLUMN rental_analyses.method_version IS
  'Short label of the rules that produced this report (for example cma-2026-10-v1), so the accuracy scorecard can group runs by method. Max 40 characters. Item 4.';

COMMENT ON COLUMN rental_comps.mls_listing_id IS
  'MLS listing number (CRMLS ListingId; RentCast''s mlsNumber when its mlsName is CRMLS). Join key for merging MLS facts across duplicate copies of one listing and for TARS fact-checks. NULL for comps with no MLS record. Max 40 characters. Item 2.';

COMMENT ON COLUMN rental_comps.year_built IS
  'Year the comp was built, from the MLS or RentCast. NULL = unknown. 1800-2100. Display, and the new_construction flag (built within 2 years). Item 2.';

COMMENT ON COLUMN rental_comps.subdivision_name IS
  'Cleaned MLS subdivision name (tract-code suffix removed, junk values such as "Other" mapped to NULL). NULL = unknown. Max 120 characters. Display and the "same community" label. Item 2 / 5.';

COMMENT ON COLUMN rental_comps.furnished_status IS
  'Normalized MLS Furnished field: furnished, unfurnished, partial (partly furnished) or either (Furnished Or Unfurnished / Negotiable). NULL = unknown, and unknown NEVER excludes a comp. Only furnished (or unfurnished against a furnished subject) causes the furnished_mismatch exclusion. Item 2.';

COMMENT ON COLUMN rental_comps.lease_term_class IS
  'Classification of the MLS LeaseTerm text: long (12 or 24 months), short (month-to-month, vacation, seasonal or short-term), six_month (flag only). NULL = unknown, which never excludes. Item 2.';

COMMENT ON COLUMN rental_comps.age_restricted IS
  'TRUE when the MLS marks the listing as a 55+ / senior community (SeniorCommunityYN). NULL = unknown (not the same as FALSE). A 55+ comp is excluded unless the subject is marked 55+. Describes the community, not any person. Item 2.';

COMMENT ON COLUMN rental_comps.mls_condition IS
  'The MLS''s own short condition word when it gave one (for example Turnkey, Updated/Remodeled). Max 80 characters; never listing text. Shown as a fact chip only. Item 2 / 3.';

COMMENT ON COLUMN rental_comps.mls_flags IS
  'Display tags derived from structured MLS fields: furnished, partly_furnished, short_term, age_restricted, hoa, private_pool, utilities_included, water_trash_included, gardener_included, new_construction, adu_or_guest_house, view_property. Closed list enforced by chk_rental_comps_mls_flags_vocab. NOT NULL DEFAULT empty array. Flags never change the rent math. Item 2 / 3.';

COMMENT ON COLUMN rental_comps.condition_rating IS
  'Condition grade A+ to F read from the listing text by the optional AI step (Phase E). Exists only when condition_basis = listing_text. DISPLAY ONLY: never used in any rent number. Listing text itself is never stored. Item 3.';

COMMENT ON COLUMN rental_comps.condition_basis IS
  'Where condition_rating came from or why there is none: listing_text (rated), unclear (text too thin to judge) or not_available (no listing text, for example RentCast and LeadSimple comps). NULL = condition step did not run. Item 3.';

COMMENT ON COLUMN rental_comps.condition_tags IS
  'Short condition tags derived by code from the verified evidence quote (remodeled, new_build, stone_counters, new_flooring, new_cabinets, updated_kitchen, updated_baths, cosmetic_updates, original_finishes, needs_repair). Closed list enforced by chk_rental_comps_condition_tags_vocab. NOT NULL DEFAULT empty array. Display only. Item 3.';


-- ============================================================
-- PART 6: AUDIT-ONLY notes on the existing wide computed range
-- (Peter's range rule, 2026-10-16: no range of $500 or more is ever
-- recommended or shown). These five columns keep being written, because
-- chk_complete_requires_rent_range requires recommended_rent_low / mid /
-- high on every finished report that counted 4 or more comps (or whose
-- count is unknown). None of the five had a comment before
-- this migration (verified live), so the rollback resets them to none.
-- ============================================================

COMMENT ON COLUMN rental_analyses.recommended_rent_low IS
  'AUDIT ONLY: never displayed or returned as a recommendation (Peter''s range rule, 2026-10-16). Weighted 25th percentile of the counted comps - the low end of the wide "computed range". Kept because chk_complete_requires_rent_range requires recommended_rent_low/mid/high on a finished report (all three may be NULL only when counted_comp_count is set and below 4), and for before/after comparisons. No screen, API response, written explanation or prompt may use it. The recommendation is headline_range_low / headline_range_high and suggested_list_price.';

COMMENT ON COLUMN rental_analyses.recommended_rent_mid IS
  'AUDIT ONLY: never displayed or returned as a recommendation (Peter''s range rule, 2026-10-16). Weighted middle of the counted comps; the headline range is centred from it, but the number itself is internal. Kept because chk_complete_requires_rent_range requires recommended_rent_low/mid/high on a finished report (all three may be NULL only when counted_comp_count is set and below 4). No screen, API response, written explanation or prompt may use it.';

COMMENT ON COLUMN rental_analyses.recommended_rent_high IS
  'AUDIT ONLY: never displayed or returned as a recommendation (Peter''s range rule, 2026-10-16). Weighted 75th percentile of the counted comps - the high end of the wide "computed range". Kept because chk_complete_requires_rent_range requires recommended_rent_low/mid/high on a finished report (all three may be NULL only when counted_comp_count is set and below 4), and for before/after comparisons. No screen, API response, written explanation or prompt may use it.';

COMMENT ON COLUMN rental_analyses.raw_comp_rent_low IS
  'AUDIT ONLY: never displayed or returned as a recommendation (Peter''s range rule, 2026-10-16). Lowest counted comp rent, the low end of the raw comp spread. Kept for audit and before/after comparisons. No screen, API response, written explanation or prompt may use it.';

COMMENT ON COLUMN rental_analyses.raw_comp_rent_high IS
  'AUDIT ONLY: never displayed or returned as a recommendation (Peter''s range rule, 2026-10-16). Highest counted comp rent, the high end of the raw comp spread. Kept for audit and before/after comparisons. No screen, API response, written explanation or prompt may use it.';


-- ============================================================
-- HOW TO CHECK IT WORKED (read-only; Jarvis or TARS, service-role key)
-- ============================================================
-- Each of these returns HTTP 200 once the migration is applied. Before it
-- is applied the first one returns HTTP 400 with code 42703 (verified
-- 2026-10-17). If one returns a "column not found in the schema cache"
-- message right after applying, wait ~10 seconds and retry (or run
-- NOTIFY pgrst, 'reload schema';  in the SQL Editor).
--
--   GET {SUPABASE_URL}/rest/v1/rental_comps?select=mls_flags,condition_rating&limit=1
--       expect:  [{"mls_flags":[],"condition_rating":null}]
--   GET {SUPABASE_URL}/rest/v1/rental_comps?select=age_restricted,condition_tags,year_built&limit=1
--       expect:  [{"age_restricted":null,"condition_tags":[],"year_built":null}]
--   GET {SUPABASE_URL}/rest/v1/rental_analyses?select=headline_range_low,stretch_price,owner_goal,subject_age_restricted&limit=1
--       expect:  [{"headline_range_low":null,"stretch_price":null,"owner_goal":null,"subject_age_restricted":false}]
--
-- Row counts must be unchanged (1,342 comps / 71 analyses on 2026-10-17,
-- plus any analyses run since).
--
-- The replaced rule (PART 2B) cannot be seen through the REST API. Check it
-- in the SQL Editor (read-only):
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'public.rental_analyses'::regclass
--     AND conname = 'chk_complete_requires_rent_range';
--   expect: text that contains  counted_comp_count < 4  (before this
--   migration it contains only the three recommended_rent_* NOT NULL tests).
-- And through REST that nothing already saved was disturbed (expect []):
--   GET {SUPABASE_URL}/rest/v1/rental_analyses?select=id&status=eq.complete&recommended_rent_low=is.null
-- Behaviour is proven by the self-test in 20261018_APPLY-GUIDE.md (9 cases
-- on this rule) and, once Q's code sends counted_comp_count, by one real
-- run of 3490 Union Pacific Avenue (duplex, 700 sq ft), which must now end
-- 'complete' with no range instead of 'failed'.


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
-- WARNING: this DELETES whatever is stored in the new columns. Roll the
-- Phase B+ code back FIRST (otherwise every analysis fails with an
-- unknown-column error), and use this only before real reports have been
-- saved with the new format, or after exporting them.
-- Dropping a column also drops every CHECK that mentions it, including
-- the two table-level ones - AND chk_complete_requires_rent_range, which
-- reads counted_comp_count. So STEP 1 below puts the ORIGINAL rule back
-- BEFORE any column is dropped. Do not skip or reorder it.
--
-- STEP 1a. Count 'complete' reports saved WITHOUT recommended-rent numbers
-- (thin reports allowed by the loosened rule). Read-only:
--   SELECT count(*) FROM rental_analyses
--   WHERE status = 'complete'
--     AND (recommended_rent_low IS NULL OR recommended_rent_mid IS NULL
--          OR recommended_rent_high IS NULL);
--
-- STEP 1b, if the count is 0 - restore the original rule outright:
-- ALTER TABLE rental_analyses
--   DROP CONSTRAINT IF EXISTS chk_complete_requires_rent_range,
--   ADD CONSTRAINT chk_complete_requires_rent_range CHECK (
--     status <> 'complete'
--     OR (recommended_rent_low IS NOT NULL
--         AND recommended_rent_mid IS NOT NULL
--         AND recommended_rent_high IS NOT NULL)
--   );
--
-- STEP 1b, if the count is more than 0 - the original rule cannot be
-- validated against those thin rows, and this migration will not change
-- or delete them. Restore it as NOT VALID instead: it then protects every
-- NEW row and every row later updated, and leaves the existing thin rows
-- as they are (any later UPDATE of one of those rows would be refused
-- until it is dealt with; ask Neo before touching them):
-- ALTER TABLE rental_analyses
--   DROP CONSTRAINT IF EXISTS chk_complete_requires_rent_range,
--   ADD CONSTRAINT chk_complete_requires_rent_range CHECK (
--     status <> 'complete'
--     OR (recommended_rent_low IS NOT NULL
--         AND recommended_rent_mid IS NOT NULL
--         AND recommended_rent_high IS NOT NULL)
--   ) NOT VALID;
--
-- STEP 2. Now the rest, as before:
--
-- ALTER TABLE rental_analyses DROP CONSTRAINT IF EXISTS chk_headline_range;
-- ALTER TABLE rental_comps    DROP CONSTRAINT IF EXISTS chk_rental_comps_rating_requires_listing_text;
--
-- ALTER TABLE rental_comps
--   DROP COLUMN IF EXISTS condition_tags,
--   DROP COLUMN IF EXISTS condition_basis,
--   DROP COLUMN IF EXISTS condition_rating,
--   DROP COLUMN IF EXISTS mls_flags,
--   DROP COLUMN IF EXISTS mls_condition,
--   DROP COLUMN IF EXISTS age_restricted,
--   DROP COLUMN IF EXISTS lease_term_class,
--   DROP COLUMN IF EXISTS furnished_status,
--   DROP COLUMN IF EXISTS subdivision_name,
--   DROP COLUMN IF EXISTS year_built,
--   DROP COLUMN IF EXISTS mls_listing_id;
--
-- ALTER TABLE rental_analyses
--   DROP COLUMN IF EXISTS method_version,
--   DROP COLUMN IF EXISTS counted_leased_count,
--   DROP COLUMN IF EXISTS counted_comp_count,
--   DROP COLUMN IF EXISTS confidence_spread,
--   DROP COLUMN IF EXISTS confidence_label,
--   DROP COLUMN IF EXISTS owner_goal,
--   DROP COLUMN IF EXISTS stretch_price,
--   DROP COLUMN IF EXISTS suggested_list_price,
--   DROP COLUMN IF EXISTS headline_range_high,
--   DROP COLUMN IF EXISTS headline_range_low,
--   DROP COLUMN IF EXISTS size_band_pct,
--   DROP COLUMN IF EXISTS subject_subdivision,
--   DROP COLUMN IF EXISTS subject_age_restricted,
--   DROP COLUMN IF EXISTS subject_condition;
--
-- -- Put the five audit columns back to "no comment" (their state before):
-- COMMENT ON COLUMN rental_analyses.recommended_rent_low  IS NULL;
-- COMMENT ON COLUMN rental_analyses.recommended_rent_mid  IS NULL;
-- COMMENT ON COLUMN rental_analyses.recommended_rent_high IS NULL;
-- COMMENT ON COLUMN rental_analyses.raw_comp_rent_low     IS NULL;
-- COMMENT ON COLUMN rental_analyses.raw_comp_rent_high    IS NULL;
--
-- ============================================================
