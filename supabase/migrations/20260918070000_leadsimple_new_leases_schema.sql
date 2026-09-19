-- ============================================================
-- Migration: 20260918070000_leadsimple_new_leases_schema
-- Created:   2026-09-18
-- (Renamed from 20260918060000 -> 20260918070000 before this was ever
-- applied anywhere: that timestamp collided with another same-day migration,
-- 20260918060000_archive_search_significance_batch_chunking_and_
-- resumability_schema.sql, written independently around the same time.
-- Same "safe to rename/edit in place before it's ever applied" exception
-- the original rental_analysis_schema migration documents for itself, and
-- the same class of issue this repo has hit and fixed before — see
-- 20260912050000_reconcile_20260912040000_timestamp_collision.sql.)
-- Author:    Neo (database specialist)
--
-- Part of the "LeadSimple Move-Ins comp source" build
-- (projects/rental-analysis/LEADSIMPLE-COMP-SOURCE-SPEC.md) — the third
-- comp source for the rental analysis tool, alongside RentCast and CRMLS.
-- Unlike those two (open-market data), this source is Rincon's own,
-- private, confirmed new-tenant lease history, synced nightly from
-- LeadSimple's "02 Move Ins" process type. See the spec in full for the
-- live-tested reasoning behind every decision below — this migration
-- follows it precisely, not a paraphrase.
--
-- Two things, one migration:
--   1. A new table, `leadsimple_new_leases` (kept the spec's own working
--      name — it's already accurate and consistent with the sibling
--      `leadsimple_property_stages` table's naming; no better name found).
--   2. A new `rental_comp_sources` row, named exactly 'LeadSimple Move-Ins',
--      seeded is_active = FALSE.
--
-- ============================================================
-- WHY THIS IS A NEW TABLE, NOT A 4TH ROW IN leadsimple_property_stages
-- ============================================================
-- leadsimple_property_stages (20260902000000) already syncs three other
-- LeadSimple process types into one shared table, but that table's grain
-- and lifecycle are the opposite of what Move-Ins needs: "what stage is
-- this process in right now" (upsert-while-open, DELETE-once-closed — a
-- row exists only while there's something current to show). Move-Ins is
-- the reverse: a record only becomes useful once it's *closed* (a signed
-- lease), and should then be *kept*, not deleted, to serve as a comp for
-- up to two years. Bolting that onto a loop built around "delete on
-- close" would mean special-casing one of four entries in a shared loop
-- for a fundamentally different lifecycle. See the spec's "The new table"
-- section for the full reasoning.
--
-- ============================================================
-- THE REAL INVARIANT — matched_unit_id UNIQUE, not leadsimple_process_id
-- ============================================================
-- This table's row lifecycle is NOT plain insert-only. Read this section
-- before touching this table from application code.
--
-- Earlier revisions of this design kept one row per closed Move-In
-- process, keyed by leadsimple_process_id, and used LeadSimple's own
-- `current_rent`/`lease_start_date` fields directly. Live testing (spec,
-- "Resolving rent accuracy") found those fields are a live snapshot of
-- whatever tenant occupies the unit *today* — not data pinned to the
-- specific Move-In process — so an old, superseded Move-In's own record
-- would silently report a later tenant's rent. Concrete example from the
-- spec: a Move-In that closed 2020-07-23 at 2303 Otter Creek Ln reported
-- current_rent: 3865.0, identical to the Move-In that closed at the same
-- address on 2026-09-16 — the "2020" record was never reporting 2020's
-- rent at all.
--
-- The fix changes what this table is allowed to hold. It no longer stores
-- one row per Move-In ever closed. It stores AT MOST ONE row per
-- currently-confirmed-current Rincon unit — rent and lease-start come
-- exclusively from Rincon's own `leases` table (leases.monthly_rent,
-- leases.lease_start), cross-referenced by the sync script against
-- `closed_at` with a 45-day tolerance, never from LeadSimple's own fields.
-- matched_unit_id (a real FK to units.id) carries this invariant via a
-- UNIQUE constraint below — it is the table's real primary business key,
-- not id and not leadsimple_process_id.
--
-- This makes the sync script's write step (Q, sync-move-in-leases.js)
-- DELETE-then-INSERT, not plain INSERT: before writing a newly-confirmed-
-- current row, it must first DELETE any existing row for that same
-- matched_unit_id. A unit that turns over again must have its previous
-- tenant's row retracted, not left sitting in the table growing stale —
-- this is the "operational requirement" the spec flags explicitly as new
-- behavior Q must build (previous table designs in this codebase never
-- needed a delete-on-write path; this one does). If the insert side ships
-- without the delete side, the table will silently accumulate stale,
-- no-longer-current comps — the exact risk this whole redesign exists to
-- eliminate. Confirmed real yield, tested live against the full 667-record
-- pull: 279 rows expected to land here once the initial backfill runs
-- (170 superseded + 194 no property/unit match + 24 no leases row = 388
-- dropped, on purpose, per Peter's own direction — see spec).
--
-- leadsimple_process_id is kept as a plain column (which Move-In most
-- recently confirmed this row) but is deliberately NOT unique — it is
-- provenance/debugging metadata now, not the uniqueness guarantee. It is
-- still indexed (see below) because the sync script needs a second,
-- narrower retraction path: if a previously-closed process's own
-- `closed_at` reverts to null on a later sync (a walked-back/corrected
-- Move-In — confirmed live that closed_at is a plain mutable field, not
-- an append-only log), the sync must delete any row saved for that
-- process specifically, independent of the matched_unit_id path above.
--
-- ============================================================
-- WHY property_type IS INCLUDED, EVEN THOUGH IT'S NOT NAMED IN THE
-- SPEC'S "Data Boundary" FIELD LIST
-- ============================================================
-- Flagging this explicitly since it's a real inconsistency in the
-- approved spec, not something invented here. The spec's Data Boundary
-- section enumerates what this build reads from LeadSimple as
-- "bedrooms/bathrooms/square_feet, address/city/state/zip, and
-- closed_at" and doesn't list property_type. But the spec's own "What Q
-- Needs to Build This" section requires lib/leadsimple.js to carry a
-- property_type mapping table (FROM_LEADSIMPLE_PROPERTY_TYPE — confirmed
-- already built, see projects/rental-analysis/lib/leadsimple.js line
-- ~63), and lib/leadsimple.js has NO live LeadSimple API access at
-- analysis time — it only ever reads this table (spec, "What Q Needs to
-- Build This", lib/leadsimple.js bullet). Without a stored raw
-- property_type value, that already-approved mapping table would have
-- nothing to map from — dead code. Confirmed live in Q's actual
-- lib/leadsimple.js (mapComparable(), reads row.property_type) that this
-- is exactly the shape expected. Treating the Data Boundary list as an
-- editorial omission rather than a deliberate exclusion: nothing in the
-- spec explains why property_type specifically would be excluded while
-- address/city/state/zip/bedrooms/bathrooms/sqft (the same structured,
-- non-sensitive, property-level category of data, per Technical Notes'
-- "8 distinct real values, only 2 clean enough to map") are all kept.
-- Stored as LeadSimple's raw free-text value, unmapped — the mapping into
-- rental_comps.property_type's CHECK-constrained vocabulary happens later,
-- at read time, in lib/leadsimple.js, same layering as
-- FROM_CRMLS_PROPERTY_TYPE/FROM_RENTCAST_PROPERTY_TYPE living in their
-- own mappers, not their fetch/sync layers.
--
-- ============================================================
-- WHY NO market_rent, is_estimated_price, OR property_id COLUMN
-- ============================================================
-- market_rent / is_estimated_price: dropped from this design entirely
-- (spec, "Does market_rent/is_estimated_price still belong"). Every row
-- this table ever holds already passed the sync script's `leases`
-- cross-reference confirming currency — there is no estimated-price case
-- left. lib/leadsimple.js hardcodes is_estimated_price: false at the
-- comp-mapping layer instead (confirmed in the file, line ~106) — no
-- column needed here since the value never varies.
--
-- property_id: this table has exactly one consumer, lib/leadsimple.js,
-- which reads by zip_code + closed_at only (confirmed in the file,
-- pullLeadSimpleComps()). matched_unit_id -> units -> properties is the
-- only relationship this table needs; server.js's existing pipeline
-- already re-matches every comp from every source against `properties`
-- again at analysis time regardless of where it came from (spec).
-- Skipping property_id here avoids a second, redundant address-match at
-- write time for a link nothing reads.
--
-- ============================================================
-- COLUMN TYPES — matched against this schema's real, existing tables,
-- not guessed
-- ============================================================
--   matched_unit_id  -> units.id is UUID (20260626000000_initial_schema.sql)
--   rent             -> leases.monthly_rent is NUMERIC(10,2)
--   lease_start_date -> leases.lease_start is DATE
--   closed_at        -> LeadSimple's own field, confirmed "a real
--                        timestamp once closed" by
--                        sync-property-stages.js's own header comment
--                        (same connector, same account) -> TIMESTAMPTZ
--   leadsimple_process_id -> stored TEXT, matching this codebase's
--                        established convention for every other external
--                        system ID (appfolio_id is TEXT everywhere in
--                        this schema, "AppFolio's numeric owner ID
--                        (stored as text)" per 20260720000002_owners.sql)
--                        — LeadSimple's own process IDs are documented
--                        elsewhere in this codebase as opaque tokens
--                        (20260825000000), not safe to assume integer.
--   bedrooms/bathrooms/sqft -> nullable, same CHECKs as rental_comps'
--                        own columns of the same name (external-sourced
--                        data, not always cleanly populated — no
--                        evidence these three are always present, unlike
--                        rent/lease_start_date which only ever get
--                        written once already confirmed by the `leases`
--                        cross-reference).
--
-- ============================================================
-- INDEXES — reasoned against this table's one real consumer
-- ============================================================
-- lib/leadsimple.js's pullLeadSimpleComps() issues exactly one query
-- shape (confirmed in the file): filter by zip_code equality, AND
-- closed_at >= a lookback cutoff. A composite index on (zip_code,
-- closed_at) serves that exact query via its leftmost prefix (zip_code
-- equality) plus an efficient range scan on closed_at within that zip —
-- the right shape for this specific access pattern, not two separate
-- single-column indexes.
--
-- matched_unit_id's UNIQUE constraint (below) already creates the index
-- the sync script's delete-before-insert retraction step needs
-- (DELETE ... WHERE matched_unit_id = ?) — no separate index required.
--
-- leadsimple_process_id gets its own plain index for the sync script's
-- second, narrower retraction path (a process whose closed_at reverts to
-- null — see "THE REAL INVARIANT" above). Table volume is small (~279
-- rows at expected steady state, never more than one row per Rincon unit
-- — 467 units total in this account as of this migration) so this index
-- is cheap and mostly a correctness/clarity aid, not a scale necessity.
--
-- ============================================================
-- RLS: enabled, locked down by default — matching every other table in
-- this schema. No permissive policies are defined here. The nightly sync
-- script and lib/leadsimple.js both reach this table via the service role
-- key from the server, bypassing RLS — same convention rental_comps and
-- rental_analyses already use (20260812010000).
-- ============================================================
--
-- Gate check (must pass before applying to any real database):
--   [x] Rollback exists — see bottom of this file
--   [x] No existing data is deleted or overwritten — new table, and the
--       rental_comp_sources seed below is a plain INSERT of a brand-new
--       row (confirmed: no 'LeadSimple Move-Ins' row exists today — the
--       original schema migration seeded only FlexMLS/Zillow/RentCast;
--       FlexMLS was later renamed to CRMLS by 20260918040000, an UPDATE,
--       not this row)
--   [x] Touches only this new table plus one INSERT into the existing
--       rental_comp_sources lookup table — no ALTER on properties, units,
--       leases, or any other shared table
--   [x] Additive only — CREATE TABLE IF NOT EXISTS, ON CONFLICT DO
--       NOTHING on the seed row, safe to re-run
--   [x] Seeded is_active = FALSE — this source cannot silently start
--       feeding live recommendations before TARS confirms real comps flow
--       end-to-end and Peter/Scotty flip it on (a plain UPDATE, no
--       migration — same pattern the original FlexMLS placeholder used)
--   [ ] Tested on a copy of Supabase before production apply — no staging
--       copy exists in this project, same standing caveat as every
--       migration in this repo to date
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- TABLE: leadsimple_new_leases
-- What it stores: at most one row per Rincon unit whose most recent
-- closed LeadSimple "02 Move Ins" process has been confirmed, against
-- Rincon's own `leases` table, to still be that unit's CURRENT lease.
-- Real, ledger-confirmed rent and lease-start only — never an estimate,
-- never a superseded tenant's number. See "THE REAL INVARIANT" above for
-- the full lifecycle (this is not a plain insert-only log).
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS leadsimple_new_leases (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Provenance only, as of this revision — see "THE REAL INVARIANT"
  -- above for why this is no longer the uniqueness guarantee. LeadSimple's
  -- own process IDs are opaque tokens in this account (confirmed
  -- elsewhere in this schema, 20260825000000) — stored as TEXT, matching
  -- this codebase's established convention for every external system ID.
  leadsimple_process_id  TEXT        NOT NULL,

  -- THE real invariant: at most one row per currently-confirmed Rincon
  -- unit. Set by the sync script only after its `leases` cross-reference
  -- confirms this Move-In is still current for this unit (within
  -- LEASE_MATCH_TOLERANCE_DAYS = 45 of leases.lease_start). ON DELETE
  -- CASCADE: this row has no meaning without the unit it was confirmed
  -- against and is a fully re-derivable cache (the sync script would
  -- simply re-derive it on a later run), not a standalone historical
  -- audit record like rental_analyses/rental_comps — same reasoning
  -- leadsimple_property_stages already used for its own property_id FK.
  matched_unit_id         UUID        NOT NULL UNIQUE
                            REFERENCES units(id) ON DELETE CASCADE,

  -- Captured live from LeadSimple at sync time, plain free-text fields —
  -- matching rental_comps.address's own free-text convention (not
  -- decomposed/validated further, not itself a FK). Decomposed into
  -- separate columns, unlike rental_comps.address, because zip_code is
  -- this table's other real query key (see INDEXES above) — mirrors
  -- properties' own address/city/state/zip shape for that reason.
  address                 TEXT        NOT NULL,
  city                    TEXT        NOT NULL,
  state                   TEXT        NOT NULL DEFAULT 'CA',
  zip_code                TEXT        NOT NULL,

  -- LeadSimple's raw property_type free text (e.g. 'Single Home',
  -- 'Multi-Family', 'Student'), stored as-is. NOT mapped to
  -- rental_comps.property_type's CHECK-constrained vocabulary here —
  -- that mapping happens downstream in lib/leadsimple.js
  -- (FROM_LEADSIMPLE_PROPERTY_TYPE), same layering CRMLS/RentCast use.
  -- See "WHY property_type IS INCLUDED" above. Nullable — LeadSimple's
  -- own field is sometimes null, and even populated it's mostly
  -- ambiguous (8 distinct real values, only 2 map cleanly). Length cap
  -- is a structural guardrail against accidentally storing free-form
  -- note content here instead of a short category label, same pattern
  -- leadsimple_property_stages.stage already uses.
  property_type           TEXT        CHECK (property_type IS NULL
                            OR char_length(property_type) <= 100),

  -- Nullable — external-sourced, no evidence these are always cleanly
  -- populated (unlike rent/lease_start_date below, which only ever get
  -- written once already confirmed). Same CHECKs as rental_comps' own
  -- columns of the same name.
  bedrooms                INTEGER      CHECK (bedrooms IS NULL OR bedrooms >= 0),
  bathrooms               NUMERIC(3,1) CHECK (bathrooms IS NULL OR bathrooms >= 0),
  sqft                    INTEGER      CHECK (sqft IS NULL OR sqft > 0),

  -- Always leases.monthly_rent — real, AppFolio-synced, actively-charged
  -- rent, confirmed current by the sync script's `leases` cross-reference.
  -- Never an estimate, never LeadSimple's own (unreliable, live-snapshot)
  -- current_rent field. NOT NULL: a row is only ever written once this
  -- value is known and confirmed — see "THE REAL INVARIANT" above.
  rent                    NUMERIC(10,2) NOT NULL CHECK (rent >= 0),

  -- The CONFIRMED leases.lease_start for the matched unit — not
  -- LeadSimple's own unit.lease_start_date field, which has the same
  -- live-snapshot unreliability as current_rent (spec, "Resolving rent
  -- accuracy"). NOT NULL for the same reason as rent above.
  lease_start_date        DATE        NOT NULL,

  -- The Move-In process's own closed_at — confirmed live as "a real
  -- timestamp once closed" (sync-property-stages.js header), not a plain
  -- date. This is the anchor date the sync script's 45-day tolerance
  -- check is measured against, and the freshness window lib/leadsimple.js
  -- filters on (MOVE_IN_LOOKBACK_MONTHS).
  closed_at               TIMESTAMPTZ NOT NULL,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users. The
-- nightly sync script (sync-move-in-leases.js) and lib/leadsimple.js both
-- reach this table via the service role key from the server, bypassing
-- RLS — same convention rental_comps/rental_analyses already use.
ALTER TABLE leadsimple_new_leases ENABLE ROW LEVEL SECURITY;

-- Serves lib/leadsimple.js's one real query: zip_code equality + a
-- closed_at range (lookback cutoff). See INDEXES above.
CREATE INDEX IF NOT EXISTS idx_leadsimple_new_leases_zip_closed_at
  ON leadsimple_new_leases(zip_code, closed_at);

-- Serves the sync script's second retraction path: a process whose
-- closed_at reverts to null must have any row it previously confirmed
-- deleted, looked up by leadsimple_process_id. See "THE REAL INVARIANT"
-- above.
CREATE INDEX IF NOT EXISTS idx_leadsimple_new_leases_process_id
  ON leadsimple_new_leases(leadsimple_process_id);

DROP TRIGGER IF EXISTS trg_leadsimple_new_leases_updated_at ON leadsimple_new_leases;
CREATE TRIGGER trg_leadsimple_new_leases_updated_at
  BEFORE UPDATE ON leadsimple_new_leases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- SEED: rental_comp_sources row for this new source
-- Named exactly 'LeadSimple Move-Ins' — load-bearing string. This exact
-- name is what lib/sources.js's SOURCE_HANDLERS map and
-- lib/weighting.js's SELF_SOURCED_TRUSTED_SOURCE_NAMES set both key off
-- (spec). It must never drift from this literal value.
--
-- A plain INSERT, not an UPDATE-existing-row like 20260918040000's CRMLS
-- activation: confirmed against the original schema migration
-- (20260812010000) that no placeholder row for this source exists today
-- — that migration seeded only FlexMLS, Zillow, and RentCast, and
-- FlexMLS was already claimed (renamed to CRMLS) by 20260918040000.
--
-- Seeded is_active = FALSE, same pattern the original FlexMLS/CRMLS
-- placeholder used — flip to TRUE with a plain UPDATE (no migration)
-- only once TARS confirms real comps are flowing end-to-end through
-- server.js and lib/weighting.js's exclusion fix, so a half-tested
-- source can't silently start feeding live recommendations.
-- ============================================================

INSERT INTO rental_comp_sources (name, description, is_active) VALUES
  ('LeadSimple Move-Ins',
   'Rincon''s own confirmed new-tenant lease history, synced nightly from LeadSimple''s "02 Move Ins" process type via sync-move-in-leases.js into leadsimple_new_leases. Every row is cross-referenced against Rincon''s own leases table (lease_start within 45 days of the Move-In''s closed_at) before being kept, so this source only ever reports a real, ledger-confirmed, currently-accurate rent — never an estimate, never a superseded tenant''s number. Seeded inactive; flip to is_active = TRUE (a plain UPDATE, no migration) once TARS confirms real comps flow end-to-end. See projects/rental-analysis/LEADSIMPLE-COMP-SOURCE-SPEC.md.',
   FALSE)
ON CONFLICT (name) DO NOTHING;


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DELETE FROM rental_comp_sources WHERE name = 'LeadSimple Move-Ins';
--
-- DROP TRIGGER IF EXISTS trg_leadsimple_new_leases_updated_at ON leadsimple_new_leases;
--
-- DROP INDEX IF EXISTS idx_leadsimple_new_leases_process_id;
-- DROP INDEX IF EXISTS idx_leadsimple_new_leases_zip_closed_at;
--
-- DROP TABLE IF EXISTS leadsimple_new_leases;
--
-- ============================================================
