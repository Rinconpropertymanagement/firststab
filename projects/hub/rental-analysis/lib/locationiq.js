/**
 * lib/locationiq.js
 * LocationIQ Autocomplete API client — live address-suggestion-as-you-type
 * for the "run analysis" form's address field. Separate file from
 * lib/rentcast.js on purpose: different vendor, different concern.
 *
 * Why LocationIQ (checked before building, not assumed):
 *   - RentCast has no autocomplete endpoint at all — only property lookup
 *     and rent/comps, both keyed on a complete address already.
 *   - OpenStreetMap Nominatim's own usage policy explicitly prohibits using
 *     it for autocomplete/type-ahead.
 *   - LocationIQ has a purpose-built Autocomplete endpoint, is free (no
 *     credit card), and its usage policy allows this. Confirmed against
 *     LocationIQ's real current docs below, not guessed.
 *
 * Docs: https://docs.locationiq.com/docs/autocomplete
 * Endpoint: GET https://api.locationiq.com/v1/autocomplete
 * Auth: API key as the `key` query param (confirmed in the docs — not the
 * `X-Api-Key` header RentCast uses; different vendor, different convention).
 * Needs LOCATIONIQ_API_KEY (sign up free at locationiq.com).
 *
 * This is purely "help the user finish typing an address" — it has no idea
 * about bedrooms/bathrooms/sqft (that's lib/rentcast.js's
 * lookupPropertyDetails(), a completely separate lookup against a different
 * vendor). Never throws except for a missing API key (a real setup
 * problem, same as lib/rentcast.js's assertConfigured()) — any other
 * failure (LocationIQ down, a bad/empty response, a network error) returns
 * an empty array so the frontend's fallback is always "let the user keep
 * typing manually," never a broken page. Same "never throw for no-data
 * reasons" convention as lookupPropertyDetails().
 */

const LOCATIONIQ_BASE_URL = 'https://api.locationiq.com/v1/autocomplete';

// Separate endpoint from the Autocomplete one above — same vendor, same
// domain/auth convention, different purpose. Checked LocationIQ's real docs
// before building (docs.locationiq.com/docs/search-forward-geocoding, not
// assumed): Autocomplete is for "as someone types" suggestions; this
// endpoint ("Search / Forward Geocoding") is the documented tool for
// "convert one complete, known address into coordinates" — exactly what
// geocodeAddress() below needs for a LeadSimple sync row's already-complete
// stored address, not a partial in-progress query.
// Docs: https://docs.locationiq.com/docs/search-forward-geocoding
const LOCATIONIQ_SEARCH_URL = 'https://api.locationiq.com/v1/search';

// Below this, a query can't narrow down a real address yet ("1", "12 ") —
// not worth spending a request on. LocationIQ's free tier is a limited
// resource, same reasoning as RentCast's budget notes in lib/rentcast.js.
const MIN_QUERY_LENGTH = 3;

// A dropdown under a text field only has room to show a handful of options
// — this is a type-ahead suggestion list, not a search results page.
const DEFAULT_SUGGESTION_LIMIT = 5;

function assertConfigured() {
  if (!process.env.LOCATIONIQ_API_KEY) {
    throw new Error(
      'Missing LOCATIONIQ_API_KEY. Sign up for a free API key at locationiq.com ' +
      '(no credit card required) and add LOCATIONIQ_API_KEY to projects/rental-analysis/.env.'
    );
  }
}

/**
 * Maps one LocationIQ Autocomplete result into what the frontend needs.
 * LocationIQ's `display_name` is already a complete, formatted address
 * string (house number through country) — the same role RentCast's
 * `formattedAddress` field plays elsewhere in this codebase, so this uses
 * the same key for a consistent shape across both vendors. Everything else
 * LocationIQ returns (place_id, osm_id/osm_type, lat/lon, boundingbox,
 * class/type, the structured `address` breakdown) is discarded — this
 * endpoint only helps someone finish typing an address; nothing downstream
 * needs more than the finished string.
 */
function mapSuggestion(result) {
  return { formattedAddress: result.display_name };
}

/**
 * Looks up live address suggestions for the "run analysis" form's address
 * field as the user types.
 * @param {string} query
 * @returns {Promise<{formattedAddress: string}[]>}
 */
async function suggestAddresses(query) {
  if (typeof query !== 'string' || query.trim().length < MIN_QUERY_LENGTH) {
    return [];
  }

  assertConfigured();

  const params = new URLSearchParams({
    key: process.env.LOCATIONIQ_API_KEY,
    q: query.trim(),
    limit: String(DEFAULT_SUGGESTION_LIMIT),
    format: 'json',
    // Rincon only operates in Southern California (see CLAUDE.md) — biases
    // results toward the US without hard-blocking anything; this never
    // errors or excludes, it just ranks US matches first.
    countrycodes: 'us',
    // countrycodes alone isn't enough: verified live that a short, common
    // partial address (e.g. "130 N Garden", a real Rincon property) returns
    // only irrelevant matches in NC/NY with no CA results at all once a
    // city isn't typed yet. viewbox+bounded restricts results to Southern
    // California outright (not just a soft preference) — roughly San Diego
    // to north of Santa Barbara, coast to San Bernardino/Riverside. Wider
    // than just Ventura County on purpose: sales also evaluates prospective
    // properties outside Rincon's current portfolio, still within the
    // broader Southern California market this business operates in.
    viewbox: '-120.0,35.5,-116.5,33.0',
    bounded: '1',
  });

  let data;
  try {
    const res = await fetch(`${LOCATIONIQ_BASE_URL}?${params.toString()}`, {
      headers: { Accept: 'application/json' },
    });
    // Same "no data" handling as lookupPropertyDetails() in lib/rentcast.js:
    // any non-OK response (bad key, rate-limited, no matches, LocationIQ
    // down) just means no suggestions right now, not a page-breaking error.
    if (!res.ok) return [];
    data = await res.json();
  } catch (err) {
    return []; // network error, bad JSON, etc. — same "no suggestions" fallback
  }

  if (!Array.isArray(data)) return [];

  return data.map(mapSuggestion);
}

/**
 * Geocodes one complete, known address to {latitude, longitude} — used by
 * sync-move-in-leases.js to populate leadsimple_new_leases.latitude/
 * longitude (see that migration), never called from the live analysis path.
 * Same "never throw for no-data reasons" convention as suggestAddresses():
 * a bad/empty response, LocationIQ down, or a network error all return
 * null so the sync can skip that one row's coordinates (leave them null,
 * per this project's "don't invent, leave unknown" policy) rather than
 * failing the whole sync run. A missing API key is the one exception — a
 * real setup problem, same as every other assertConfigured() in this file.
 * @param {string} address
 * @returns {Promise<{latitude: number, longitude: number}|null>}
 */
async function geocodeAddress(address) {
  if (typeof address !== 'string' || !address.trim()) return null;

  assertConfigured();

  const params = new URLSearchParams({
    key: process.env.LOCATIONIQ_API_KEY,
    q: address.trim(),
    format: 'json',
    limit: '1',
    countrycodes: 'us',
  });

  let data;
  try {
    const res = await fetch(`${LOCATIONIQ_SEARCH_URL}?${params.toString()}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null; // no match, rate-limited, LocationIQ down, etc. — same "no result" fallback as suggestAddresses()
    data = await res.json();
  } catch (err) {
    return null; // network error, bad JSON, etc.
  }

  if (!Array.isArray(data) || !data.length) return null;

  const lat = Number(data[0].lat);
  const lon = Number(data[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return { latitude: lat, longitude: lon };
}

module.exports = {
  suggestAddresses,
  mapSuggestion,
  geocodeAddress,
  MIN_QUERY_LENGTH,
};
