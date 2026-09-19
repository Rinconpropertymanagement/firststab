-- ============================================================
-- Migration: 20260816010000_rental_market_data
-- Created:   2026-08-16
-- Author:    Neo (database specialist)
--
-- Adds RentCast's zip-code-level market data (median/average rent, rent per
-- sqft, days on market, and month-by-month history) so the rental analysis
-- report can show area context and a trend chart alongside the recommended
-- rent range, without spending a fresh RentCast request on every analysis.
--
-- Source confirmed directly against RentCast's live Market Data endpoint
-- (GET /v1/markets?zipCode=...), never used by this codebase before today
-- (existing RentCast calls in lib/rentcast.js only hit /avm/rent/long-term
-- for comps and /v1/properties for property records — see that file).
-- Real response for zip 91320 confirmed to carry a top-level `rentalData`
-- object shaped like:
--   { lastUpdatedDate, averageRent, medianRent, minRent, maxRent,
--     averageRentPerSquareFoot, medianRentPerSquareFoot,
--     minRentPerSquareFoot, maxRentPerSquareFoot,
--     averageSquareFootage, medianSquareFootage,
--     averageDaysOnMarket, medianDaysOnMarket, newListings, totalListings,
--     dataByPropertyType: [...], dataByBedrooms: [...],
--     history: { "2025-09": { ...same full stat set... }, ... ~12 months } }
-- plus a matching top-level `saleData` object (home *sale* prices) that is
-- deliberately NOT stored anywhere in this migration — this tool is
-- rentals-only, and sale data has no report use here.
--
-- Table creation order (dependency order):
--   1. rental_market_data     (no dependencies — keyed by zip code)
--   2. ALTER rental_analyses  (adds subject_zip; rental_analyses itself
--                              already exists, from 20260812010000)
--
-- Design decisions:
--
--   - Grain is one row per ZIP CODE, not per analysis. Confirmed with Peter
--     as the deliberate design point of this whole migration: market stats
--     for a zip don't change from one analysis to the next in the same
--     area, so this is built as a shared, reusable cache keyed on zip — not
--     a per-analysis pull. That's the reason the RLS/table design below
--     looks more like rental_comp_sources (a lookup/reference table) than
--     like rental_comps (a per-analysis audit record).
--
--   - id UUID PK + a separate UNIQUE index on zip, rather than making zip
--     itself the primary key. Matches this schema's own standing rule
--     (every table gets a UUID id) and the exact precedent already set by
--     rental_comp_sources (UUID PK + UNIQUE index on its own natural key,
--     name). The UNIQUE index on zip is what actually enforces "one row per
--     zip" and is what the app upserts against (ON CONFLICT (zip) DO
--     UPDATE ...) when refreshing a stale row.
--
--   - zip is TEXT, not INTEGER — same reasoning as properties.zip
--     (20260626000000): zip codes are identifiers, not numbers you'd ever
--     add or average, and TEXT preserves a leading zero (e.g. Northeast
--     zips like 01960) even though Rincon's own portfolio is Southern-
--     California-only today. A CHECK constrains it to 5 digits, since this
--     column is now a cache/lookup key (unlike properties.zip, which has no
--     such constraint) and RentCast's zipCode query param is a plain
--     5-digit US zip.
--
--   - Headline stats are real typed columns, not JSONB, per the spec:
--     average/median/min/max rent, average/median/min/max rent-per-sqft,
--     average/median sqft, average/median days-on-market, and the two
--     listing-count fields are all flat scalars already in RentCast's
--     response (no parsing/flattening needed) and are exactly what a report
--     page or a simple query ("what's the median rent in 91320 right now")
--     needs to read directly. All nullable: a sparsely-covered zip can come
--     back with some stats populated and others not, and a zip RentCast has
--     no rental data for at all should still be cacheable as "checked, zero
--     coverage" (see fetched_at note below) rather than rejected outright.
--
--   - average_days_on_market and median_days_on_market are both
--     NUMERIC(6,2), not INTEGER, even though the one confirmed example
--     shows medianDaysOnMarket as a whole number (13) — averageDaysOnMarket
--     in the same response is fractional (25.55), and there's no reason to
--     assume median never is for a different zip/month. Matches this
--     schema's general practice of not assuming a field is always
--     whole-number just because one sample happened to be.
--
--   - history, data_by_bedrooms, data_by_property_type are JSONB, per the
--     spec: this is nested, nested-again data (each history month repeats
--     the full stat set, itself including its own dataByPropertyType) that
--     exists to feed a trend chart and breakdown views directly, not to be
--     filtered or joined on by our own SQL. Normalizing ~12 months x
--     multiple breakdowns into real rows/columns would be a lot of schema
--     for zero current query need. Revisit only if a real need to query
--     *inside* the history shows up (e.g. "every zip where rent dropped
--     3 months running") — additive, a new migration, not this one.
--
--   - Two separate timestamps, not one, same instinct this schema already
--     applies elsewhere (e.g. is_estimated_price kept independent of
--     listing_status): rentcast_updated_at mirrors RentCast's own
--     rentalData.lastUpdatedDate — when RentCast itself last recomputed
--     this zip's market stats, informational only. fetched_at is OUR
--     cache's freshness clock — when this app last successfully pulled the
--     zip from RentCast — and is the one the staleness policy actually
--     compares against a threshold. They will usually be close but are not
--     the same fact: RentCast could recompute a zip's stats the same week
--     we happen to fetch it, or we could fetch a zip whose underlying
--     RentCast computation is itself already a few weeks stale on their
--     end. NOT NULL with DEFAULT NOW() on fetched_at (a row only ever gets
--     created at the moment of a real fetch); rentcast_updated_at stays
--     nullable in case that field is ever missing from a response.
--
--   - No CHECK or enum enforcing the actual staleness window (e.g. "stale
--     after 7 days") — that threshold is application policy, not a
--     structural fact about the data, and is Q's call to make/tune at
--     query time (WHERE fetched_at > NOW() - INTERVAL '7 days' or similar),
--     same as this schema leaving other UX/policy decisions (e.g. how
--     property_id gets matched via typeahead) to Q rather than encoding
--     them in a constraint. A week-plus is a reasonable starting point per
--     the spec's own framing ("market rent stats don't move day to day")
--     but is deliberately not hardcoded here.
--
--   - idx_rental_market_data_fetched_at exists to support a future batch
--     "refresh everything stale" job (find every cached zip older than the
--     threshold) without a full table scan — a reasonable operational query
--     even though nothing calls it yet today.
--
--   - RLS: enabled, locked by default — same as every table in this schema.
--     No permissive policies defined here. This is not tenant PII and has
--     no protected-class fields (it's aggregate market statistics, not
--     information about any individual person or property), but the rule
--     applies uniformly regardless: nothing reads or writes this table
--     until Q adds a policy scoped to authenticated users, or the tool
--     reaches it via the service role key the same way other tools in this
--     schema already do.
--
--   - THE AUDIT-TRAIL CALL (asked for explicitly — not skipped):
--     rental_analyses does NOT snapshot a full copy of the market data it
--     showed. It gets one new nullable column, subject_zip, so a given
--     analysis can always be joined back to "whatever rental_market_data
--     currently has for this zip" — but the analysis does not freeze a
--     point-in-time copy of averageRent/medianRent/history/etc. the way
--     rental_comps freezes each comp, or the way subject_estimated_rent
--     freezes that one AVM number, onto the analysis row itself. Reasoning:
--
--       1. rental_comps and subject_estimated_rent are both genuinely
--          per-analysis artifacts — a fresh RentCast call made FOR that one
--          analysis, about that one subject property, never reused anywhere
--          else. Freezing them is just recording what that call actually
--          returned. rental_market_data is the opposite by design: the
--          entire point of this migration is a resource fetched once and
--          deliberately REUSED across every analysis in the same zip for
--          up to a week or more. Snapshotting it per-analysis would fight
--          the reason the cache exists.
--
--       2. Snapshotting fully (copying the stat columns, or worse, the
--          history/dataByBedrooms/dataByPropertyType JSONB blobs) onto
--          every rental_analyses row that lands in a given zip means dozens
--          of analyses run in the same area in the same week would each
--          carry a redundant copy of the literal same numbers — schema
--          bloat with no real audit benefit, since they're not independent
--          facts, just repeated ones.
--
--       3. The alternative of making rental_market_data itself append-only
--          / versioned (never UPDATE in place, always INSERT a new row so
--          old rows stay as an immutable history) was also considered and
--          rejected for this migration: it would multiply rows per zip
--          indefinitely, complicate the "find the current row for this zip"
--          query that the caching/staleness logic depends on, and still
--          wouldn't by itself link a specific analysis to a specific
--          version unless paired with a per-analysis snapshot anyway (see
--          #2). If a real need for historical zip-level trend snapshots
--          shows up later, that's an additive change to consider on its
--          own — not a reason to complicate this cache table today.
--
--       4. This data's actual role in a report is supplementary area
--          context and a trend chart — not an input to
--          recommended_rent_low/mid/high the way the comps and
--          raw_comp_rent_low/high are. This schema's existing audit rigor
--          (rental_comps as immutable per-analysis rows, rationale stored
--          as real generated text) is scoped to reconstructing exactly what
--          produced the recommended number. A zip's aggregate rent trend
--          isn't part of that causal chain, so it doesn't need the same
--          immutability guarantee. It's closer in spirit to a shared
--          reference table than to a comp.
--
--       5. subject_zip itself is a plain TEXT value, not a foreign key to
--          rental_market_data.id — deliberately. rental_market_data rows
--          are updated in place on refresh (see UNIQUE index on zip above),
--          so an id captured at analysis time would silently point at a row
--          whose numbers have since changed; it would look like a snapshot
--          reference without actually being one. A plain zip value avoids
--          that false impression and is also robust to the (expected, see
--          above) case of no cached row existing yet for a brand-new zip at
--          the moment an analysis runs.
--
--       Net effect: open a report for an analysis from 3 months ago, and
--       the market-data section will show TODAY's cached numbers for that
--       zip, not what was cached back then. That's the deliberate tradeoff
--       being made here — flagging it plainly since it's the one place this
--       migration diverges from this schema's usual "freeze everything"
--       instinct, per the explicit ask not to make this call silently.
--
--   - subject_zip is sourced from the SAME RentCast /avm/rent/long-term
--     response already being fetched for every analysis (per
--     lib/rentcast.js, subjectProperty.zipCode sits right next to
--     subjectProperty.latitude/longitude, which 20260814000000 already
--     extracts onto this table) — so populating it costs zero additional
--     RentCast requests, same free-lunch reasoning as the coordinates
--     migration. Nullable, matching every other subject_* output column
--     (an analysis can still be marked 'complete' without it, same as
--     subject_latitude/subject_longitude). Not decomposed further and not
--     replacing subject_address's free-text design (20260812010000) — this
--     is one additional narrow field for the one new join this migration
--     needs, not a reversal of that earlier call.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- TABLE: rental_market_data
-- What it stores: one row per ZIP code, cached from RentCast's Market Data
-- endpoint (rental side only) and reused across every analysis in that zip
-- rather than re-fetched per analysis. Refreshed in place (see UNIQUE index
-- on zip) when the app decides a cached row is stale.
-- RLS: enabled, locked by default. Access policies added per-tool.
-- ============================================================

CREATE TABLE rental_market_data (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  zip                         TEXT NOT NULL CHECK (zip ~ '^[0-9]{5}$'),

  -- Headline stats, straight from RentCast's rentalData object. All
  -- nullable — see design notes above (sparse zips, "checked, no coverage"
  -- rows).
  average_rent                NUMERIC(10,2) CHECK (average_rent IS NULL OR average_rent >= 0),
  median_rent                 NUMERIC(10,2) CHECK (median_rent IS NULL OR median_rent >= 0),
  min_rent                    NUMERIC(10,2) CHECK (min_rent IS NULL OR min_rent >= 0),
  max_rent                    NUMERIC(10,2) CHECK (max_rent IS NULL OR max_rent >= 0),

  average_rent_per_sqft       NUMERIC(6,2) CHECK (average_rent_per_sqft IS NULL OR average_rent_per_sqft >= 0),
  median_rent_per_sqft        NUMERIC(6,2) CHECK (median_rent_per_sqft IS NULL OR median_rent_per_sqft >= 0),
  min_rent_per_sqft           NUMERIC(6,2) CHECK (min_rent_per_sqft IS NULL OR min_rent_per_sqft >= 0),
  max_rent_per_sqft           NUMERIC(6,2) CHECK (max_rent_per_sqft IS NULL OR max_rent_per_sqft >= 0),

  average_sqft                INTEGER CHECK (average_sqft IS NULL OR average_sqft > 0),
  median_sqft                 INTEGER CHECK (median_sqft IS NULL OR median_sqft > 0),

  -- NUMERIC, not INTEGER — see design notes above (averageDaysOnMarket is
  -- confirmed fractional; median assumed possibly fractional too).
  average_days_on_market      NUMERIC(6,2) CHECK (average_days_on_market IS NULL OR average_days_on_market >= 0),
  median_days_on_market       NUMERIC(6,2) CHECK (median_days_on_market IS NULL OR median_days_on_market >= 0),

  new_listings                INTEGER CHECK (new_listings IS NULL OR new_listings >= 0),
  total_listings              INTEGER CHECK (total_listings IS NULL OR total_listings >= 0),

  -- Nested detail behind a trend chart / breakdown views. Not queried or
  -- filtered by our own SQL — see design notes above.
  history                     JSONB,
  data_by_bedrooms            JSONB,
  data_by_property_type       JSONB,

  -- RentCast's own "as of" date for this zip's underlying computation.
  -- Informational only — NOT what drives the staleness/refresh decision.
  -- See fetched_at below and design notes above.
  rentcast_updated_at         TIMESTAMPTZ,

  -- This cache's freshness clock: when THIS APP last successfully pulled
  -- this zip from RentCast. The staleness policy compares this against a
  -- threshold (e.g. re-fetch if older than ~7-14 days) — see design notes
  -- above for why that threshold isn't hardcoded as a constraint here.
  fetched_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN rental_market_data.rentcast_updated_at IS 'RentCast''s own rentalData.lastUpdatedDate — when RentCast last recomputed this zip''s stats. Informational only; does not drive our cache staleness check.';
COMMENT ON COLUMN rental_market_data.fetched_at IS 'When this app last successfully pulled this zip from RentCast. This is our cache''s freshness clock — compare against a staleness threshold (app-level policy, not enforced here) to decide whether to re-fetch.';

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE rental_market_data ENABLE ROW LEVEL SECURITY;

-- The cache key. Enforces one row per zip and is what the app upserts
-- against (ON CONFLICT (zip) DO UPDATE ...) when refreshing a stale row.
CREATE UNIQUE INDEX idx_rental_market_data_zip ON rental_market_data(zip);

-- Supports a future "refresh everything stale" batch query without a full
-- table scan. Nothing calls this yet, but it's a natural operational need
-- for a time-based cache.
CREATE INDEX idx_rental_market_data_fetched_at ON rental_market_data(fetched_at);

CREATE TRIGGER trg_rental_market_data_updated_at
  BEFORE UPDATE ON rental_market_data
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- ALTER: rental_analyses — add subject_zip
-- What it's for: lets a given analysis be joined to "whatever
-- rental_market_data currently has for this zip" for report display. Does
-- NOT snapshot the market data itself — see the audit-trail design note
-- above for the full reasoning.
-- ============================================================

ALTER TABLE rental_analyses
  ADD COLUMN subject_zip TEXT CHECK (subject_zip IS NULL OR subject_zip ~ '^[0-9]{5}$');

COMMENT ON COLUMN rental_analyses.subject_zip IS 'Subject property zip code, from RentCast subjectProperty.zipCode (same AVM response subject_latitude/subject_longitude already come from — zero extra RentCast requests). Nullable, same reasoning as those columns. Used to join to rental_market_data.zip for report display; deliberately NOT a snapshot of that data — see this migration''s design notes for why.';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- ALTER TABLE rental_analyses DROP COLUMN IF EXISTS subject_zip;
--
-- DROP TRIGGER IF EXISTS trg_rental_market_data_updated_at ON rental_market_data;
--
-- DROP INDEX IF EXISTS idx_rental_market_data_fetched_at;
-- DROP INDEX IF EXISTS idx_rental_market_data_zip;
--
-- DROP TABLE IF EXISTS rental_market_data;
--
-- ============================================================
