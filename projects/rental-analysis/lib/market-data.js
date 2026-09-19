/**
 * lib/market-data.js
 * RentCast zip-code-level market data (median/average rent, rent per sqft,
 * days on market, month-by-month history) — cached in rental_market_data so
 * a report can show area context and a trend chart without spending a fresh
 * RentCast request on every analysis. Separate file from lib/rentcast.js on
 * purpose: this is a third distinct RentCast concern (property/comp-level
 * data vs. zip-level aggregate stats), and keeping it apart is what keeps
 * that file from becoming a dumping ground — see its own header comment.
 *
 * Docs: https://developers.rentcast.io/reference/market-statistics
 * Endpoint: GET /v1/markets?zipCode=<zip> — confirmed live for zip 91320.
 * Response carries a top-level `rentalData` object (mapped below) and a
 * matching `saleData` object (home *sale* prices) that is deliberately
 * never read here — this tool is rentals-only. Also confirmed live: a zip
 * RentCast has no rental coverage for (tried: 96162, a sparse rural zip)
 * comes back with NO `rentalData` key at all, not an empty one — handled
 * below by falling back to `{}` before mapping, same "checked, no coverage"
 * row Neo's migration design notes describe rather than treating it as an
 * error.
 *
 * THE CACHE, in one sentence: getMarketData(zip) is the only function
 * callers outside this file should need — it reads rental_market_data for
 * an existing fresh-enough row and returns it as-is, or calls RentCast and
 * upserts a new one, never both.
 */

const { select, upsert } = require('./supabase');
const { assertConfigured, RENTCAST_BASE_URL } = require('./rentcast');

// ── Freshness policy ────────────────────────────────────────────────────
// App policy, not a hard rule — deliberately not enforced by any DB
// constraint (see the migration's design notes: "that threshold is
// application policy, not a structural fact about the data"). Kept as a
// named, top-of-file constant specifically so it's easy to find and tune,
// per the spec. Market rent stats don't move day to day, so a week is a
// reasonable starting point.
const FRESHNESS_WINDOW_DAYS = 7;

// Matches the migration's CHECK (zip ~ '^[0-9]{5}$') on rental_market_data.zip
// and rental_analyses.subject_zip. A zip+4 (e.g. "91320-1234") is normalized
// down to its plain 5-digit form; anything else is treated as "no usable
// zip" rather than passed through to fail a DB insert.
const ZIP_PLUS4_RE = /^(\d{5})(-\d{4})?$/;

function normalizeZip(zip) {
  if (typeof zip !== 'string') return null;
  const match = zip.trim().match(ZIP_PLUS4_RE);
  return match ? match[1] : null;
}

function numOrNull(v) {
  return typeof v === 'number' ? v : null;
}

function isFresh(fetchedAt) {
  if (!fetchedAt) return false;
  const ageMs = Date.now() - new Date(fetchedAt).getTime();
  return Number.isFinite(ageMs) && ageMs < FRESHNESS_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Maps RentCast's rentalData object onto rental_market_data's columns
 * exactly (snake_case). Pure function, no network/DB — easy to unit test.
 * @param {string} zip - already-normalized 5-digit zip
 * @param {object} rentalData - RentCast's rentalData object, or {} for "no coverage"
 */
function mapMarketData(zip, rentalData = {}) {
  const rd = rentalData || {};
  return {
    zip,
    average_rent: numOrNull(rd.averageRent),
    median_rent: numOrNull(rd.medianRent),
    min_rent: numOrNull(rd.minRent),
    max_rent: numOrNull(rd.maxRent),
    average_rent_per_sqft: numOrNull(rd.averageRentPerSquareFoot),
    median_rent_per_sqft: numOrNull(rd.medianRentPerSquareFoot),
    min_rent_per_sqft: numOrNull(rd.minRentPerSquareFoot),
    max_rent_per_sqft: numOrNull(rd.maxRentPerSquareFoot),
    average_sqft: numOrNull(rd.averageSquareFootage),
    median_sqft: numOrNull(rd.medianSquareFootage),
    average_days_on_market: numOrNull(rd.averageDaysOnMarket),
    median_days_on_market: numOrNull(rd.medianDaysOnMarket),
    new_listings: numOrNull(rd.newListings),
    total_listings: numOrNull(rd.totalListings),
    // Nested detail, stored as-is per the migration's design notes ("not
    // queried or filtered by our own SQL") — no parsing/flattening here.
    history: (rd.history && typeof rd.history === 'object') ? rd.history : null,
    data_by_bedrooms: Array.isArray(rd.dataByBedrooms) ? rd.dataByBedrooms : null,
    data_by_property_type: Array.isArray(rd.dataByPropertyType) ? rd.dataByPropertyType : null,
    // RentCast's own "as of" date — informational only, see migration notes.
    rentcast_updated_at: typeof rd.lastUpdatedDate === 'string' ? rd.lastUpdatedDate : null,
    // OUR cache's freshness clock — set here (not left to the column
    // DEFAULT) because an upsert's UPDATE path does not re-trigger a
    // column default; every fetch must stamp this explicitly to actually
    // reset the staleness clock on a refresh.
    fetched_at: new Date().toISOString(),
  };
}

/**
 * Calls RentCast's Market Data endpoint for one zip and maps the result to
 * a rental_market_data row. Never throws for "no data" reasons — a zip with
 * no rental coverage, a RentCast outage, or a network error all come back
 * as a normal row with mostly-null stats (still cacheable as "checked, zero
 * coverage"), same convention as lookupPropertyDetails() and
 * suggestAddresses() elsewhere in this codebase. The one exception is a
 * missing RENTCAST_API_KEY — a real setup problem, not a "no data" case —
 * which still throws via assertConfigured(), same as the rest of this app.
 * @param {string} zip - 5-digit zip code
 * @returns {Promise<object>} a full rental_market_data row, not yet saved
 */
async function fetchMarketData(zip) {
  assertConfigured();

  const url = `${RENTCAST_BASE_URL}/markets?${new URLSearchParams({ zipCode: zip }).toString()}`;

  let data = null;
  try {
    const res = await fetch(url, {
      headers: { 'X-Api-Key': process.env.RENTCAST_API_KEY, Accept: 'application/json' },
    });
    // Any non-OK response is treated as "no data for this zip" below, same
    // graceful-degradation convention as lookupPropertyDetails() — the
    // caller only needs a cacheable row back, not to know why RentCast
    // didn't return one.
    if (res.ok) data = await res.json();
  } catch (err) {
    data = null; // network error, bad JSON, etc. — same "no data" fallback
  }

  // Confirmed live (zip 96162): a zip with no rental coverage omits
  // `rentalData` entirely rather than sending it empty — `|| {}` covers
  // both that case and the res.ok-but-no-data-at-all fallback above.
  return mapMarketData(zip, (data && data.rentalData) || {});
}

/**
 * The cache. Reads rental_market_data for `zip`; if a row exists and is
 * fresher than FRESHNESS_WINDOW_DAYS, returns it as-is — no RentCast call.
 * Otherwise fetches fresh from RentCast and upserts (ON CONFLICT (zip) DO
 * UPDATE) with a new fetched_at, so the next call within the window reuses
 * it too.
 *
 * Returns null (never throws) for a missing/malformed zip — this is meant
 * to be called with whatever subject_zip came back from RentCast's AVM
 * response, which is nullable by design (see the migration notes), so "no
 * zip to look up" is a normal case, not an error. Real failures (Supabase
 * down, missing RENTCAST_API_KEY, etc.) DO throw — callers should treat
 * this the same non-fatal way narrative generation is already treated in
 * server.js (log it, continue with marketData: null), not swallow errors
 * inside this function.
 * @param {string|null} zip
 * @returns {Promise<object|null>}
 */
async function getMarketData(zip) {
  const normalizedZip = normalizeZip(zip);
  if (!normalizedZip) return null;

  const cachedRows = await select('rental_market_data', `select=*&zip=eq.${normalizedZip}`);
  const cached = cachedRows[0] || null;

  if (cached && isFresh(cached.fetched_at)) {
    console.log(`[rental-analysis] Market data cache HIT for zip ${normalizedZip} (fetched_at=${cached.fetched_at}) — no RentCast call.`);
    return cached;
  }

  console.log(`[rental-analysis] Market data cache ${cached ? 'STALE' : 'MISS'} for zip ${normalizedZip} — fetching from RentCast.`);
  const fresh = await fetchMarketData(normalizedZip);
  const savedRows = await upsert('rental_market_data', fresh, 'zip');
  return savedRows[0] || fresh;
}

module.exports = {
  getMarketData,
  fetchMarketData,
  mapMarketData,
  normalizeZip,
  isFresh,
  FRESHNESS_WINDOW_DAYS,
};
