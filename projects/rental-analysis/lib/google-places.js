/**
 * lib/google-places.js
 * Google Places API (New) Autocomplete client — live address-suggestion-
 * as-you-type for the "run analysis" form's address field. Replaces
 * lib/locationiq.js's suggestAddresses() for this one endpoint only.
 * lib/locationiq.js itself is NOT removed or changed — its geocodeAddress()
 * (a separate, unrelated function that converts one already-complete
 * address to lat/lon) still powers the LeadSimple lease sync
 * (projects/hub/leadsimple-property-brain/sync-move-in-leases.js).
 *
 * Why Google Places, replacing LocationIQ for this one purpose (checked
 * live this session, not assumed):
 *   - LocationIQ's Autocomplete cannot handle a bare "house number + street"
 *     query with no city yet (e.g. "574 Charleston") — confirmed live, it
 *     returns zero results. Loosening its geographic restriction (the
 *     viewbox+bounded params in lib/locationiq.js) just returns confidently
 *     wrong matches in other states, not a real fix.
 *   - Google Places Autocomplete is best-in-class for exactly this kind of
 *     partial-address matching, and Rincon's real usage volume (roughly
 *     1,000-1,600 requests/month) stays well inside Google's free monthly
 *     allotment of 10,000 Autocomplete Requests — confirmed against
 *     Google's current pricing docs this session.
 *
 * Google's Places API (New) uses a different request shape than every
 * other vendor in this project (RentCast, LocationIQ, CRMLS) — confirmed
 * against Google's real, current docs before writing this, not assumed:
 *   - POST (not GET), with a JSON body — not query params.
 *   - Auth via the `X-Goog-Api-Key` header (Google's own header name —
 *     not a query param like LocationIQ's `key`, and not RentCast's
 *     `X-Api-Key` header name either, despite looking similar).
 *   - An `X-Goog-FieldMask` header selects which response fields come
 *     back. Google's docs say this is technically OPTIONAL for the
 *     Autocomplete endpoint specifically (unlike Place Details/Text
 *     Search/Nearby Search, where Google requires it) — sent explicitly
 *     here anyway as a deliberate cost/scope control, not because the API
 *     demands it: it guarantees this integration only ever asks for (and
 *     can only ever be billed for scope creep on) the one field it needs.
 * Docs verified directly against developers.google.com on 2026-09-20:
 *   - Request/response shape: https://developers.google.com/maps/documentation/places/web-service/place-autocomplete
 *   - Full REST field reference: https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places/autocomplete
 *
 * CRITICAL — stays inside the free tier on purpose: this file must NEVER
 * call Place Details (a separate, additional charge per Google's own
 * docs — confirmed live: "A Place Details (New) request ... is then made
 * when the user has selected one of the Autocomplete (New) suggestions,"
 * i.e. Google's own docs treat that as a deliberate NEXT step this tool
 * never takes). It doesn't need to — Google's Autocomplete (New) response
 * already includes a usable, human-readable formatted address string
 * directly on each suggestion, at `suggestions[].placePrediction.text.text`
 * (confirmed in the REST field reference above: PlacePrediction.text is a
 * FormattableText object whose own `.text` is documented as the
 * human-readable name/description for that prediction) — so no follow-up
 * call is ever needed just to get an address string. The field mask below
 * requests exactly that one field and nothing else.
 *
 * Needs GOOGLE_PLACES_API_KEY — deliberately a different env var from this
 * repo's existing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET (projects/hub's
 * unrelated Gmail/notify.js OAuth integration) — a completely different
 * Google product and credential; nothing shared between the two.
 *
 * Same "never throw except for a missing API key" convention as
 * lib/locationiq.js: any other failure (bad key, rate-limited, Google
 * down, network error, unexpected response shape) returns an empty array
 * so the frontend's fallback is always "let the user keep typing
 * manually," never a broken page.
 */

const GOOGLE_PLACES_AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';

// Same reasoning as lib/locationiq.js's MIN_QUERY_LENGTH — below this, a
// query can't narrow down a real address yet ("1", "12 "), not worth
// spending a request on Google's free-tier allotment.
const MIN_QUERY_LENGTH = 3;

// A dropdown under a text field only has room to show a handful of options
// — same reasoning/value as lib/locationiq.js's DEFAULT_SUGGESTION_LIMIT.
// Google's Autocomplete (New) request body has no "limit"/"max results"
// field (confirmed in the REST reference — unlike LocationIQ's `limit`
// query param), so this is applied client-side after the response comes
// back rather than requested from Google.
const DEFAULT_SUGGESTION_LIMIT = 5;

// Southern California bounding box — same real-world area as
// lib/locationiq.js's viewbox (roughly San Diego to north of Santa
// Barbara, coast to San Bernardino/Riverside; wider than just Ventura
// County on purpose, since sales also evaluates prospective properties
// outside Rincon's current portfolio). Re-expressed here in Google's
// documented locationRestriction.rectangle shape (low = southwest corner,
// high = northeast corner) — different vendor, different shape, same
// coordinates. locationRESTRICTION (not locationBias) is Google's hard
// filter, matching LocationIQ's viewbox+bounded=1 (a hard restriction, not
// just a ranking preference).
const SOCAL_BOUNDS = {
  low: { latitude: 33.0, longitude: -120.0 },
  high: { latitude: 35.5, longitude: -116.5 },
};

function assertConfigured() {
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    throw new Error(
      'Missing GOOGLE_PLACES_API_KEY. Create/select a Google Cloud project, enable the ' +
      '"Places API (New)", create an API key, and add GOOGLE_PLACES_API_KEY to ' +
      'projects/rental-analysis/.env.'
    );
  }
}

/**
 * Maps one Google Places Autocomplete (New) suggestion into what the
 * frontend needs. `placePrediction.text.text` is Google's own
 * human-readable, ready-to-display address/place string (see this file's
 * header comment for where that's confirmed in Google's docs) — the same
 * role LocationIQ's `display_name` plays in lib/locationiq.js's own
 * mapSuggestion(), so this uses the same `formattedAddress` output key for
 * a consistent shape across both vendors. Everything else Google returns
 * (place, placeId, structuredFormat, types, distanceMeters) is discarded —
 * nothing downstream needs more than the finished string, and the field
 * mask sent in suggestAddresses() below means most of it isn't even
 * present on the response to begin with.
 * @param {object} suggestion one entry of the response's `suggestions` array
 * @returns {{formattedAddress: string}|null} null for anything that isn't
 *   a real place prediction with usable text — e.g. a `queryPrediction`
 *   (Google's Autocomplete can mix in generic search-query suggestions
 *   with no actual place/address behind them), which this tool has no use
 *   for since it only wants real addresses.
 */
function mapSuggestion(suggestion) {
  const text = suggestion && suggestion.placePrediction && suggestion.placePrediction.text;
  if (!text || typeof text.text !== 'string') return null;
  return { formattedAddress: text.text };
}

/**
 * Looks up live address suggestions for the "run analysis" form's address
 * field as the user types. Drop-in replacement for lib/locationiq.js's
 * suggestAddresses() — same signature, same return shape, so the frontend
 * and both server call sites need zero changes.
 * @param {string} query
 * @returns {Promise<{formattedAddress: string}[]>}
 */
async function suggestAddresses(query) {
  if (typeof query !== 'string' || query.trim().length < MIN_QUERY_LENGTH) {
    return [];
  }

  assertConfigured();

  const body = {
    input: query.trim(),
    locationRestriction: { rectangle: SOCAL_BOUNDS },
    // Lowercase ccTLD-style code, matching Google's own documented example
    // usage (`includedRegionCodes: ['us', 'au']`) — not the uppercase ISO
    // 3166-1 convention. Same real-world effect as LocationIQ's lowercase
    // `countrycodes: 'us'`.
    includedRegionCodes: ['us'],
  };

  let data;
  try {
    const res = await fetch(GOOGLE_PLACES_AUTOCOMPLETE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
        // Requests exactly (and only) the field mapSuggestion() above
        // needs to build a formatted address string — see this file's
        // header comment for why this keeps the integration inside the
        // free tier (never triggers a Place Details call/charge).
        'X-Goog-FieldMask': 'suggestions.placePrediction.text.text',
      },
      body: JSON.stringify(body),
    });
    // Same "no data" handling as lib/locationiq.js's suggestAddresses():
    // any non-OK response (bad key, rate-limited, Google down) just means
    // no suggestions right now, not a page-breaking error.
    if (!res.ok) return [];
    data = await res.json();
  } catch (err) {
    return []; // network error, bad JSON, etc. — same "no suggestions" fallback
  }

  if (!data || !Array.isArray(data.suggestions)) return [];

  return data.suggestions
    .map(mapSuggestion)
    .filter(Boolean)
    .slice(0, DEFAULT_SUGGESTION_LIMIT);
}

module.exports = {
  suggestAddresses,
  mapSuggestion,
  MIN_QUERY_LENGTH,
};
