-- ============================================================
-- Migration: 20261018010000_unit_vacancy_snapshots
-- Created:   2026-10-17 (file prefix 20261018 so it sorts after every
--            existing migration; the last one is 20260929000000)
-- Author:    Neo (database specialist)
--
-- *** NOT APPLIED. Peter applies every migration by hand through
-- Supabase's SQL Editor. Nothing in this repo runs it. ***
--
-- Source: projects/rental-analysis/CMA-QUALITY-SPEC.md, Revision 3,
-- Phase A3 ("optional, start early"), Decision 5, section A.7 and
-- Appendix H. Peter approved starting this early.
--
-- ============================================================
-- IN PLAIN ENGLISH (for Peter)
-- ============================================================
-- This creates one small, empty table that will keep a nightly record of
-- every vacant unit's asking rent, scheduled rent and days vacant, so the
-- history that the nightly AppFolio sync overwrites today is kept from now
-- on (asking price, price cuts, how long a unit sat empty, and later
-- "asked versus signed" rent). It holds only unit-level rent numbers and
-- dates - NO tenant names, phones, emails or any other personal data.
--
-- TO APPLY: open Supabase, project rincon-management, SQL Editor, New
-- query; paste this whole file; press Run. Success looks like "Success.
-- No rows returned". The table stays empty until Q/Scotty ship the small
-- nightly-job change described below; applying it first is harmless.
-- Full steps, the check afterwards and the undo statements are in
-- 20261018_APPLY-GUIDE.md (same folder).
--
-- ============================================================
-- WHAT THE NIGHTLY JOB MUST INSERT (a later Q/Scotty step - NOT done here)
-- ============================================================
-- One row per unit that appears in TONIGHT'S AppFolio `unit_vacancy`
-- report (the same report projects/appfolio-sync/sync.js step 7 already
-- downloads; its rows carry unit_id, unit, sqft, new_rent, schd_rent):
--
--   column          fill it with
--   --------------  ---------------------------------------------------
--   unit_id         units.id for the report row's unit_id, looked up
--                   through units.appfolio_id (unique). Skip and log any
--                   report row whose unit is not in `units`; never
--                   insert a half-filled row.
--   property_id     that unit's units.property_id (may legitimately be
--                   NULL - see below)
--   snapshot_date   OMIT IT. The database stamps today's date in
--                   America/Los_Angeles, so there is one source of truth
--                   and no UTC-vs-Pacific off-by-one.
--   unit_status     'vacant'
--   asking_rent     report new_rent  (NULL when blank or 0)
--   scheduled_rent  report schd_rent (NULL when blank or 0)
--   days_vacant     whatever days-vacant / vacated-date field AppFolio
--                   returns, converted to days. UNVERIFIED: no code in
--                   this repo has ever read such a field, and the spec
--                   says Q must first look at one raw unit_vacancy row to
--                   see which fields exist. If AppFolio gives none, leave
--                   it NULL; days vacant can then be derived from the run
--                   of consecutive snapshot dates (it will under-count
--                   units that were already empty when snapshots began).
--
-- HOW: send every column on every row (explicit null, not missing) as one
-- upsert:  POST /rest/v1/unit_vacancy_snapshots?on_conflict=unit_id,snapshot_date
-- with  Prefer: resolution=merge-duplicates  - the same mechanism as
-- upsert() in projects/rental-analysis/lib/supabase.js (and the sync's own
-- merge-duplicates upserts). Running the job twice on the same
-- night then updates that night's rows in place instead of duplicating
-- them (the UNIQUE constraint below is what makes this safe). Run it after
-- the units upsert in the same sync, and log "N snapshot rows written".
--
-- IMPORTANT - SNAPSHOT THE REPORT, NOT `units.status = 'vacant'`.
-- Read-only check on the live database, 2026-10-17: 77 units are marked
-- vacant in `units`, but only 50 of them were refreshed by the most recent
-- nightly sync (2026-10-17 ~09:00 UTC). The other 27 were last touched
-- between late July and 9 October, and at least 2 of those 27 have an
-- ACTIVE lease on file - so they look like stale "vacant" flags, not
-- current vacancies. Snapshotting `units` would record those phantom
-- vacancies every night forever. Expect about 50 rows a night (roughly
-- 18,000 a year), not the 77 / 28,000 the spec estimated. (Separately,
-- 27 of the 77 marked-vacant units have no property link and 27 have no
-- rent; these are different but overlapping groups.) Why the stale flags
-- exist is a separate question for Peter / Q; this migration neither
-- depends on it nor changes it.
--
-- ============================================================
-- DESIGN DECISIONS
-- ============================================================
--   - One row per unit per night, enforced by UNIQUE (unit_id,
--     snapshot_date). It is a plain table-level UNIQUE constraint, NOT a
--     partial index, because PostgREST's upsert (on_conflict=...) can only
--     target a real unique constraint on exactly those columns. It also
--     serves as the index for "history of unit X, in date order".
--
--   - A unit with no row on a given night means "was not in that night's
--     vacancy report" - it leased, or the job did not run. The table
--     cannot tell those two apart, so the job logs how many rows it wrote.
--
--   - ON DELETE RESTRICT for BOTH unit_id and property_id (deliberately,
--     not the default). This is a history table: its whole value is that
--     rows survive. SET NULL would leave anonymous rows nobody can place;
--     CASCADE would silently erase the history the moment a unit or
--     property row was deleted. RESTRICT makes the database refuse and
--     forces a deliberate decision, which matches CLAUDE.md ("do not
--     delete any data without asking me first") and the precedent for
--     history tables in this schema (leases.unit_id, maintenance_snapshot_
--     events.property_id). Consequence, stated plainly: units.property_id
--     is ON DELETE CASCADE to properties, so deleting a PROPERTY whose
--     units have vacancy snapshots will also be refused until those
--     snapshots are removed on purpose. The AppFolio sync never deletes
--     units or properties (it only upserts), so nothing automated hits
--     this; only a manual clean-up would.
--
--   - property_id is a stored copy of units.property_id at snapshot time,
--     for two reasons: queries by property need no join, and the row keeps
--     the property the unit belonged to that night even if AppFolio later
--     re-assigns the unit. It is NULLABLE because units.property_id is
--     (live: 27 of the 77 vacant units have none today); unit_id, not
--     property_id, is the anchor.
--
--   - snapshot_date defaults to the Pacific calendar date (see above). It
--     is a DATE, not a timestamp: the grain is "the night of".
--     created_at records the actual moment the row was first written;
--     updated_at moves if a same-night re-run refreshes it.
--
--   - Rent columns are NUMERIC(10,2) like units.monthly_rent and are
--     nullable (live: 27 of 77 vacant units have no rent in `units`).
--     asking_rent and scheduled_rent are stored as separate raw facts
--     because `units` only keeps one blended number (new_rent, else
--     schd_rent) and that is overwritten every night; they are the
--     AppFolio report fields new_rent and schd_rent, which have no
--     counterpart column in `units`. Their exact AppFolio meaning (asking
--     rent for the next tenant vs the unit's scheduled rent) is taken from
--     the sync's own use of them and is for Q to confirm on a raw row.
--
--   - The CHECKs are deliberately LOOSE (>= 0 only). A nightly batch that
--     fails on one odd value would lose that whole night for every unit,
--     and history cannot be re-created afterwards. Sanity filtering is the
--     job's responsibility, not a reason to drop a night.
--
--   - unit_status copies units.status. The list below is the one in
--     20260626000000_initial_schema.sql. The live CHECK cannot be read
--     through the REST API; live data only contains occupied (404) and
--     vacant (77). Because the job only copies a value `units` already
--     accepted (or writes 'vacant'), this list cannot reject anything
--     the live `units` table accepts, unless someone widened it by hand.
--
--   - Indexes: the UNIQUE constraint covers per-unit history and the
--     foreign-key check on unit_id. Added: snapshot_date (whole portfolio
--     on a night or over a period) and (property_id, snapshot_date)
--     partial index (history for a property, and it keeps the property_id
--     foreign-key check fast). At ~18-28k rows a year none of this is
--     heavy; the table will stay in the low hundreds of thousands of rows
--     for years.
--
--   - RLS enabled, no permissive policy, like every other table here. The
--     nightly job uses the service role key (bypasses RLS). Anything that
--     should read this through a user login needs its own policy later.
--
--   - Nothing tenant-related is stored or referenced: no tenant_id, no
--     lease_id, no names, phone numbers, emails or notes. Asked-versus-
--     signed rent is joined at QUERY time through
--     leadsimple_new_leases.matched_unit_id (already a foreign key to
--     units.id) - the table itself never holds a tenant or a lease.
--
--   - Data inventory (GOVERNANCE.md Rule 4 asks for one when a table holds
--     personal data; this one does not, but the fields are recorded on the
--     table comment anyway so the answer is visible from the database).
--
-- ============================================================
-- WHERE THE SPEC AND THE LIVE DATABASE DISAGREED
-- ============================================================
--   1. Spec: "about 77 vacant units a night, ~28,000 rows a year". Live:
--      77 marked vacant but only 50 refreshed by the latest sync (above).
--   2. Spec Appendix H: "units ... holds today's market/scheduled rent".
--      Live `units` has ONE rent column (monthly_rent); new_rent and
--      schd_rent exist only inside the AppFolio report, which is why this
--      table stores them as their own columns.
--   3. Spec says the unit_vacancy row's days-vacant fields are "not
--      verified". Still unverified; days_vacant is nullable for that
--      reason.
--
-- ============================================================
-- Gate check (must pass before applying to any real database):
--   [x] Rollback exists - see bottom of this file
--   [x] No existing data is touched - CREATE of one NEW table only; no
--       existing table, column, row or policy is altered (it only
--       REFERENCES units and properties)
--   [x] Touches no table other code depends on - nothing reads or writes
--       the new table yet; units and properties are unchanged
--   [x] Additive (safe) - purely additive, empty on creation
--   [ ] Tested on a copy of the data first - NOT DONE. No staging copy
--       exists and no local Postgres is available to Neo. Checked by
--       careful reading and against the live units / properties columns.
--       Safe to re-run (IF NOT EXISTS everywhere), and the apply guide
--       includes an optional self-test that runs on a throw-away temp
--       copy of the table (no real row touched).
--
-- Rollback: see the section at the bottom of this file. It deletes the
-- table and everything in it (no other table is affected).
-- ============================================================


-- ============================================================
-- TABLE: unit_vacancy_snapshots
-- What it stores: one row per vacant unit per night - asking rent,
-- scheduled rent and days vacant as AppFolio reported them that night.
-- Append-only in spirit: rows are written once a night and are only ever
-- refreshed by a re-run of the same night's job.
-- RLS: enabled, locked by default. Service role (the nightly job) only.
-- ============================================================

CREATE TABLE IF NOT EXISTS unit_vacancy_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The night this row describes, in Pacific time. The job should omit it.
  snapshot_date   DATE NOT NULL DEFAULT ((NOW() AT TIME ZONE 'America/Los_Angeles')::DATE),

  -- RESTRICT on both: history must never vanish or detach silently.
  unit_id         UUID NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  property_id     UUID REFERENCES properties(id) ON DELETE RESTRICT,

  -- Copy of units.status at snapshot time ('vacant' for every row the
  -- nightly vacancy-report job writes today).
  unit_status     TEXT NOT NULL DEFAULT 'vacant'
                    CHECK (unit_status IN ('occupied', 'vacant', 'notice', 'maintenance')),

  -- AppFolio unit_vacancy report fields new_rent and schd_rent. Nullable:
  -- not every vacant unit has a rent in the report.
  asking_rent     NUMERIC(10,2) CHECK (asking_rent IS NULL OR asking_rent >= 0),
  scheduled_rent  NUMERIC(10,2) CHECK (scheduled_rent IS NULL OR scheduled_rent >= 0),

  -- Days the unit had been vacant on snapshot_date, as AppFolio reports
  -- it. Nullable until Q confirms which report field carries it.
  days_vacant     INTEGER CHECK (days_vacant IS NULL OR days_vacant >= 0),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Idempotent nightly run: one row per unit per night.
  CONSTRAINT uq_unit_vacancy_snapshots_unit_date UNIQUE (unit_id, snapshot_date)
);

-- RLS: enabled, no permissive policies - all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users. The
-- service role key (used by the nightly sync) bypasses RLS.
ALTER TABLE unit_vacancy_snapshots ENABLE ROW LEVEL SECURITY;

-- "Everything vacant on night X" / "over this period" - portfolio-wide
-- history. (Per-unit history is served by the UNIQUE constraint's index.)
CREATE INDEX IF NOT EXISTS idx_unit_vacancy_snapshots_snapshot_date
  ON unit_vacancy_snapshots(snapshot_date);

-- "Vacancy history for this property", and keeps the property_id foreign-
-- key (RESTRICT) check fast. Partial: property_id is NULL for units that
-- are not linked to a property yet.
CREATE INDEX IF NOT EXISTS idx_unit_vacancy_snapshots_property_date
  ON unit_vacancy_snapshots(property_id, snapshot_date)
  WHERE property_id IS NOT NULL;

-- A same-night re-run updates rows in place; keep updated_at honest.
DROP TRIGGER IF EXISTS trg_unit_vacancy_snapshots_updated_at ON unit_vacancy_snapshots;
CREATE TRIGGER trg_unit_vacancy_snapshots_updated_at
  BEFORE UPDATE ON unit_vacancy_snapshots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- COMMENTS
-- ============================================================

COMMENT ON TABLE unit_vacancy_snapshots IS
  'One row per vacant unit per night: the asking rent, scheduled rent and days vacant AppFolio reported that night, kept so history survives the nightly sync overwriting `units`. Written by the nightly vacancy-report job (service role) from the rows of that night''s AppFolio unit_vacancy report - NOT from units.status = vacant, which contains stale flags. A unit with no row on a date was not in that night''s report (or the job did not run). CONTAINS NO PERSONAL DATA: no tenant, lease, name, phone, email or note of any kind - only unit-level rents and dates. DATA INVENTORY (GOVERNANCE.md Rule 4): pii_fields NONE; privacy_category property/unit operational data (not tenant, owner or applicant data; not Fair Housing-relevant); agents_with_access the AppFolio nightly sync writes, the Rental Analysis tool and Property 360 are the intended readers; retention indefinite (about 18,000-28,000 rows a year); ccpa_exportable and ccpa_deletable not applicable (no personal data). RLS enabled, no permissive policies. Asked-versus-signed rent is joined at query time through leadsimple_new_leases.matched_unit_id. Source: CMA-QUALITY-SPEC.md Phase A3.';

COMMENT ON COLUMN unit_vacancy_snapshots.snapshot_date IS
  'The night this row describes, as a calendar date in America/Los_Angeles. Defaults to today''s Pacific date; the nightly job should omit it. With unit_id it forms the UNIQUE key that makes a same-night re-run an in-place update.';

COMMENT ON COLUMN unit_vacancy_snapshots.unit_id IS
  'The unit (units.id). ON DELETE RESTRICT on purpose: a unit that has vacancy history cannot be deleted until that history is removed deliberately.';

COMMENT ON COLUMN unit_vacancy_snapshots.property_id IS
  'units.property_id as of snapshot_date (the property the unit belonged to that night). NULL when the unit is not linked to a property yet (27 of 77 vacant units on 2026-10-17). ON DELETE RESTRICT on purpose.';

COMMENT ON COLUMN unit_vacancy_snapshots.unit_status IS
  'units.status at snapshot time. ''vacant'' for every row the nightly vacancy-report job writes. Same four values as the units.status CHECK in 20260626000000_initial_schema.sql.';

COMMENT ON COLUMN unit_vacancy_snapshots.asking_rent IS
  'AppFolio unit_vacancy report field new_rent: the rent being asked for the unit that night. NULL when the report gave none (or 0). Dollars, not cents. Unlike units.monthly_rent this is never overwritten the next night.';

COMMENT ON COLUMN unit_vacancy_snapshots.scheduled_rent IS
  'AppFolio unit_vacancy report field schd_rent: the unit''s scheduled rent that night. NULL when the report gave none (or 0). Dollars, not cents.';

COMMENT ON COLUMN unit_vacancy_snapshots.days_vacant IS
  'Days the unit had been vacant on snapshot_date, as reported by AppFolio (field name to be confirmed by Q on a raw unit_vacancy row). NULL when AppFolio gives none; it can then be derived from the run of consecutive snapshot_date rows, which under-counts units already empty when snapshots began. Never shown to owners.';


-- ============================================================
-- HOW TO CHECK IT WORKED (read-only; Jarvis or TARS, service-role key)
-- ============================================================
-- Before this is applied the GET below returns HTTP 404 with code PGRST205
-- "Could not find the table 'public.unit_vacancy_snapshots'" (verified
-- 2026-10-17). After it is applied it returns HTTP 200 and an empty list
-- (the job has not run yet):
--
--   GET {SUPABASE_URL}/rest/v1/unit_vacancy_snapshots?select=id,snapshot_date,unit_id,asking_rent,scheduled_rent,days_vacant&limit=1
--       expect:  []
--
-- If it still says "not found in the schema cache" right after applying,
-- wait ~10 seconds and retry (or run  NOTIFY pgrst, 'reload schema';).
-- To confirm RLS is on (SQL Editor, read-only):
--   SELECT relrowsecurity FROM pg_class
--   WHERE oid = 'public.unit_vacancy_snapshots'::regclass;      -- expect: t


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
-- WARNING: this DELETES the table and every snapshot in it. Stop the
-- nightly snapshot job first, or it will fail every night (the table
-- would be missing). No other table is affected.
--
-- DROP TRIGGER IF EXISTS trg_unit_vacancy_snapshots_updated_at ON unit_vacancy_snapshots;
--
-- DROP INDEX IF EXISTS idx_unit_vacancy_snapshots_property_date;
-- DROP INDEX IF EXISTS idx_unit_vacancy_snapshots_snapshot_date;
--
-- DROP TABLE IF EXISTS unit_vacancy_snapshots;
--
-- ============================================================
