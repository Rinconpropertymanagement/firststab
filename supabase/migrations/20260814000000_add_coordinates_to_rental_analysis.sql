-- ============================================================
-- Migration: 20260814000000_add_coordinates_to_rental_analysis
-- Created:   2026-08-14
-- Author:    Neo (database specialist)
--
-- Adds latitude/longitude to rental_analyses (subject property) and
-- rental_comps (each comp) so the analysis report can plot a map with a pin
-- for the subject and every comp.
--
-- This is a NEW migration, not an edit to 20260812010000_rental_analysis_schema.sql.
-- That migration has already been applied to the live database (Peter ran it
-- via the Supabase SQL Editor), so Neo's "never modify existing migrations"
-- rule is back in force — its own in-place-edit exception only ever applied
-- while it had not yet been applied anywhere, and that window has closed.
--
-- Source confirmed directly against RentCast's live /avm/rent/long-term
-- response (not assumed): subjectProperty.latitude/longitude (also
-- duplicated at the response's top level) and each comparables[] item both
-- carry real latitude/longitude already, at roughly 6 decimal places (e.g.
-- 34.179615). No geocoding step is needed — see
-- projects/rental-analysis/lib/rentcast.js, which already reads
-- data.subjectProperty and data.comparables in this same shape today.
--
-- Design decisions:
--
--   - All 4 new columns are nullable. subject_latitude/subject_longitude on
--     rental_analyses could in principle always be populated going forward
--     (RentCast always returns them), but nullable matches every other
--     subject_* output column on this table (e.g. subject_estimated_rent) —
--     an analysis can still be marked 'complete' without them per
--     chk_complete_requires_rent_range, and a future comp source or a failed
--     lookup shouldn't be blocked from saving everything else it did get.
--     rental_comps.latitude/longitude are nullable for the same reason as
--     every other rental_comps attribute beyond the required core fields:
--     comps could come from a future source that doesn't provide coordinates
--     (FlexMLS and Zillow, both already seeded inactive in
--     rental_comp_sources, are unconfirmed on this point), and a comp
--     missing coordinates is still useful for its price/status data — it
--     would just be omitted from the map.
--
--   - NUMERIC(9,6) on all 4 columns: 6 decimal places matches what RentCast
--     actually returns (e.g. 34.179615) and is standard survey-grade
--     precision (~11cm) — far more than a map pin needs, but matching the
--     source data exactly avoids any rounding on the way in. 3 digits before
--     the decimal point covers longitude's full range (-180 to 180);
--     latitude only needs 2 but reuses the same column type as longitude for
--     consistency, same as every other paired-purpose numeric in this schema.
--
--   - CHECK constraints bound each value to its valid geographic range
--     (latitude -90..90, longitude -180..180) — cheap protection against a
--     bad parse or a swapped lat/lng landing silently in the table, which
--     would only surface later as a pin in the wrong hemisphere on the map.
--     Same IS NULL OR ... pattern used for every other optional bounded
--     numeric in this schema (e.g. subject_year_built above).
--
--   - No new indexes. These columns exist to render a map, not to filter or
--     sort by proximity — nothing in the tool queries "comps near X,Y" today.
--     If a real proximity-query need shows up later, that's a new migration.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================

ALTER TABLE rental_analyses
  ADD COLUMN subject_latitude  NUMERIC(9,6) CHECK (subject_latitude  IS NULL OR (subject_latitude  BETWEEN -90  AND 90)),
  ADD COLUMN subject_longitude NUMERIC(9,6) CHECK (subject_longitude IS NULL OR (subject_longitude BETWEEN -180 AND 180));

COMMENT ON COLUMN rental_analyses.subject_latitude  IS 'Subject property latitude, from RentCast subjectProperty.latitude. Nullable — not always available (e.g. failed lookup, future source without coordinates).';
COMMENT ON COLUMN rental_analyses.subject_longitude IS 'Subject property longitude, from RentCast subjectProperty.longitude. Nullable — see subject_latitude.';

ALTER TABLE rental_comps
  ADD COLUMN latitude  NUMERIC(9,6) CHECK (latitude  IS NULL OR (latitude  BETWEEN -90  AND 90)),
  ADD COLUMN longitude NUMERIC(9,6) CHECK (longitude IS NULL OR (longitude BETWEEN -180 AND 180));

COMMENT ON COLUMN rental_comps.latitude  IS 'Comp latitude, from RentCast comparables[].latitude. Nullable — comps from a future source may not provide coordinates.';
COMMENT ON COLUMN rental_comps.longitude IS 'Comp longitude, from RentCast comparables[].longitude. Nullable — see latitude.';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- ALTER TABLE rental_comps     DROP COLUMN IF EXISTS longitude;
-- ALTER TABLE rental_comps     DROP COLUMN IF EXISTS latitude;
-- ALTER TABLE rental_analyses  DROP COLUMN IF EXISTS subject_longitude;
-- ALTER TABLE rental_analyses  DROP COLUMN IF EXISTS subject_latitude;
--
-- ============================================================
