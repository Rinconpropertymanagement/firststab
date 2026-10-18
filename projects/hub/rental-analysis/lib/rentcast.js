/**
 * lib/rentcast.js
 * RentCast API client — one of two real comp sources now (CRMLS is the
 * other — see lib/crmls.js). Zillow is seeded in rental_comp_sources but
 * not implemented: its public API was confirmed dead (retired 2021) and
 * its current replacement is a gated business product that only returns a
 * single Zestimate-style number, not comp listings — there is nothing to
 * build against, not just a pending-access situation. The FlexMLS
 * placeholder row was renamed to CRMLS and activated once real Recore
 * access was confirmed (see lib/crmls.js and its migration).
 * See lib/sources.js for how a new source gets added later without
 * touching this file.
 *
 * subject_estimated_rent (on rental_analyses) is sourced from RentCast's
 * own AVM `rent` field below, not Zillow — confirmed as the intended
 * design: the column is named generically for exactly this reason (see
 * the migration's design notes), and Zillow was never going to be able to
 * supply it anyway per the above.
 *
 * Docs: https://developers.rentcast.io/reference/rent-estimate-long-term
 * Free tier: 50 requests/month. Needs RENTCAST_API_KEY (developers.rentcast.io).
 *
 * Two RentCast requests per analysis (COMP-COVERAGE-SPEC.md):
 *   1. /avm/rent/long-term — one call returns the subject property's own rent
 *      estimate, its geocode and zip, AND RentCast's similarity-ranked top-10
 *      comparables list. Unchanged.
 *   2. /listings/rental/long-term — RentCast's full listings search around the
 *      subject's coordinates: Active and recently-Inactive rentals of the
 *      same property type and a similar bedroom count, in ONE request (both
 *      statuses at once). The top-10 list alone missed real comparables a
 *      manual search found. Every Active listing is kept, but only the
 *      LISTINGS_MAX_INACTIVE nearest Inactive ones (see below). Made only
 *      after the AVM call succeeds, and it never fails the analysis (see
 *      pullRentCastListings()). Inactive means "no longer listed", not a
 *      confirmed lease, so it maps to 'off_market', never 'leased'.
 *
 * Radius tiering: both calls request comps out to WIDE_SEARCH_RADIUS_MILES
 * (the AVM via RentCast's `maxRadius` query param, the listings search via
 * `radius`) and return the full set with a distance_miles on each. This file
 * does not decide how far out to actually use — that is the radius ladder,
 * applied once across all comp sources together by applyCombinedRadiusTiering()
 * in lib/sources.js after every active source has reported back. See
 * lib/constants.js for the ladder numbers.
 *
 * Another RentCast endpoint, /v1/markets (zip-code-level market stats, not
 * property/comp-level), is a separate concern handled by lib/market-data.js,
 * not this file — kept apart so this file doesn't become a dumping ground
 * for every RentCast endpoint. assertConfigured() and RENTCAST_BASE_URL are
 * exported below so that file can reuse them instead of duplicating.
 */

const { WIDE_SEARCH_RADIUS_MILES, positiveOrNull, nonNegativeOrNull, inRangeOrNull } = require('./constants');
const { BEDROOM_MISMATCH_THRESHOLD } = require('./weighting');
const { haversineMiles } = require('./crmls');
const { isSameHome } = require('./property-matching');
const { cleanListingId, cleanYearBuilt } = require('./mls-facts');

const RENTCAST_BASE_URL = 'https://api.rentcast.io/v1';
// Kept at 10 on the AVM call on purpose. RentCast bills per request, not per
// row, so lowering this saves nothing; and RentCast documents compCount as the
// number of comps used in the rent estimate, so changing it could shift
// subject_estimated_rent, which is shown on the report and fed to the
// narrative. The AVM comps are free extras next to the listings search below;
// dedupeComps() collapses the overlap.
const DEFAULT_COMP_COUNT = 10;

// Full listings search (pullRentCastListings() below). 180 days matches the
// CRMLS closed-lease lookback (lib/crmls.js's CRMLS_CLOSED_LOOKBACK_MONTHS):
// Inactive listings carry no confirmed rent and weigh the least, so an older
// window only adds last year's market. Active listings older than this are
// dropped too — stale asking prices. 500 is RentCast's maximum page size; we
// never paginate (each page is another billable request).
const LISTINGS_DAYS_OLD = 180;
const LISTINGS_LIMIT = 500;
// Inactive means "no longer listed", NOT a confirmed lease, yet on a busy street
// one search returns dozens of them (62 of 74 rows on Bunting) at weight 1
// each — enough to outweigh the confirmed leases and pull the low end of the
// range down. So only this many of the NEAREST Inactive listings are kept per
// report; every Active listing is kept. Applies to the listings search only,
// never to the AVM comps.
const LISTINGS_MAX_INACTIVE = 10;

// Our subject_property_type / rental_comps.property_type values -> RentCast's
// propertyType query param. duplex/triplex/fourplex all fold into RentCast's
// single "Multi-Family" bucket (it doesn't distinguish unit count). 'other'
// is intentionally omitted — we have no idea which RentCast bucket it
// belongs to, and guessing could exclude good comps or pull bad ones.
const TO_RENTCAST_PROPERTY_TYPE = {
  single_family: 'Single Family',
  condo: 'Condo',
  townhouse: 'Townhouse',
  duplex: 'Multi-Family',
  triplex: 'Multi-Family',
  fourplex: 'Multi-Family',
  apartment: 'Apartment',
  manufactured: 'Manufactured',
};

// RentCast's propertyType -> our CHECK-constraint list, for storing on
// rental_comps.property_type. "Multi-Family" has no safe reverse mapping —
// RentCast doesn't say whether it's a duplex/triplex/fourplex, so we leave
// it null rather than guess (property_type is nullable on rental_comps for
// exactly this: "comps come from external APIs that don't always classify
// type cleanly" — see the migration's design notes).
const FROM_RENTCAST_PROPERTY_TYPE = {
  'Single Family': 'single_family',
  'Condo': 'condo',
  'Townhouse': 'townhouse',
  'Apartment': 'apartment',
  'Manufactured': 'manufactured',
};

// Rincon Management only operates in Southern California (see CLAUDE.md) —
// used below as the sanity check RentCast's own response doesn't give us
// for free. Generous on purpose: this only needs to catch "RentCast could
// not place this address at all," not fine-tune real comps.
const EXPECTED_STATE = 'CA';
// RentCast's AVM comps are meant to be genuinely nearby the subject — real
// Southern California comps in this pipeline have come back well under 5
// miles. 50 is a deliberately generous ceiling so this only trips when NONE
// of the comps are anywhere close, not when a rural subject's nearest comps
// happen to be a bit far.
const MAX_PLAUSIBLE_COMP_DISTANCE_MILES = 50;

// TARS found that a nonsense address ("asdkfjaslkdfj not a real address
// 999999") still returned HTTP 200 with a full comp set — RentCast fell
// back to some best-effort geocode (in that real case, rural Washington
// State) instead of failing outright, and nothing checked whether the
// result was actually plausible. Confirmed by hand: on a real, resolvable
// address, RentCast's `subjectProperty` comes back with a full matched
// address (city/state/zip); on that nonsense address, `subjectProperty` had
// no address fields at all — just the bedrooms/bathrooms/sqft we sent in
// and a fallback lat/long. That's the real tell, checked first below.
// Distance is checked second, per the bug report's ask to verify RentCast's
// own reported distances are actually being used rather than just trusted.
function assessPlausibility(data) {
  const subject = data.subjectProperty || {};
  const comparables = Array.isArray(data.comparables) ? data.comparables : [];

  if (!subject.state) {
    return {
      plausible: false,
      reason: 'RentCast could not resolve this address to a real property (no matched location was returned) — the address is likely invalid or misspelled.',
    };
  }
  if (subject.state !== EXPECTED_STATE) {
    return {
      plausible: false,
      reason: `RentCast resolved this address to ${subject.city ? subject.city + ', ' : ''}${subject.state} — outside California, where Rincon operates. The address is likely wrong.`,
    };
  }
  if (comparables.length) {
    const nearby = comparables.filter(c => typeof c.distance === 'number' && c.distance <= MAX_PLAUSIBLE_COMP_DISTANCE_MILES);
    if (!nearby.length) {
      return {
        plausible: false,
        reason: `None of the ${comparables.length} comps RentCast returned are within ${MAX_PLAUSIBLE_COMP_DISTANCE_MILES} miles of the resolved address — the comp set does not look real for this address.`,
      };
    }
    const outOfState = comparables.filter(c => c.state && c.state !== EXPECTED_STATE);
    if (outOfState.length === comparables.length) {
      return {
        plausible: false,
        reason: `All ${comparables.length} comps RentCast returned are outside California — the comp set does not look real for this address.`,
      };
    }
  }
  return { plausible: true, reason: null };
}

function assertConfigured() {
  if (!process.env.RENTCAST_API_KEY) {
    throw new Error(
      'Missing RENTCAST_API_KEY. Sign up for a free API key at developers.rentcast.io ' +
      '(free tier: 50 requests/month) and add RENTCAST_API_KEY to projects/rental-analysis/.env.'
    );
  }
}

// RentCast only ever reports a listing as Active or Inactive — it has no
// way to confirm an Inactive listing actually leased vs. was simply pulled
// or expired unleased (its own docs describe this as an inferred signal,
// not a clean transaction flag). We only map to our 'leased' status from a
// source that gives a real transaction confirmation — CRMLS, now live (see
// lib/crmls.js's mapComparable). RentCast maps to 'off_market' instead —
// honestly says "delisted, no confirmed transaction" without asserting a
// lease that isn't proven.
function mapListingStatus(rentcastStatus) {
  return rentcastStatus === 'Active' ? 'active' : 'off_market';
}

function toDateOnly(isoString) {
  if (!isoString || typeof isoString !== 'string') return null;
  return isoString.slice(0, 10); // 'YYYY-MM-DDTHH:mm:ss.sssZ' -> 'YYYY-MM-DD'
}

/**
 * Maps one RentCast comparable into a partial rental_comps row. The caller
 * fills in analysis_id, source_id, comp_property_id, is_rincon_managed, and
 * narrative afterward.
 *
 * Returns null when `price` is not a number > 0 (missing, 0, negative, text,
 * NaN): a rent of 0 means "rent unknown", never "free", and a $0 comp would
 * drag the range's low end to $0 (see lib/weighting.js). Callers must drop
 * the nulls.
 */
function mapComparable(c) {
  const monthlyRent = positiveOrNull(c.price);
  if (monthlyRent === null) return null;
  return {
    address: c.formattedAddress
      || [c.addressLine1, c.city, c.state, c.zipCode].filter(Boolean).join(', '),
    property_type: FROM_RENTCAST_PROPERTY_TYPE[c.propertyType] || null,
    bedrooms: nonNegativeOrNull(c.bedrooms),
    bathrooms: nonNegativeOrNull(c.bathrooms),
    // rental_comps.sqft is CHECK (sqft > 0): a 0 placeholder becomes null.
    sqft: positiveOrNull(c.squareFootage),
    distance_miles: nonNegativeOrNull(c.distance),
    latitude: inRangeOrNull(c.latitude, -90, 90),
    longitude: inRangeOrNull(c.longitude, -180, 180),
    monthly_rent: monthlyRent,
    // RentCast's `price` is always a real historical asking price it
    // actually observed on the listing — never an algorithmic guess — for
    // both Active and Inactive listings. The one genuinely algorithmic
    // number in this whole pipeline is the /avm endpoint's own subject
    // `rent` estimate, stored separately as subject_estimated_rent — see
    // pullRentCastComps() below. Judgment call: flagged for Peter in the
    // build report, since the spec called this exact field out for extra
    // scrutiny.
    is_estimated_price: false,
    // RentCast's AVM comparables don't include price-change history (only
    // the listings-search endpoint's `history` object would, and we don't
    // read it). So these are always "no known cut," not "confirmed no cut
    // ever happened," for RentCast comps specifically.
    original_price: null,
    had_price_cut: false,
    listing_status: mapListingStatus(c.status),
    days_on_market: nonNegativeOrNull(c.daysOnMarket),
    listed_date: toDateOnly(c.listedDate),
    // "when it went off market" per the schema's dual-purpose comment on
    // this column — not asserted as a lease start date, consistent with
    // never claiming 'leased' for a RentCast comp (see mapListingStatus).
    leased_date: toDateOnly(c.removedDate),
    // RentCast gives an MLS number only for listings that came from CRMLS
    // (mlsName "CRMLS"); that number equals the CRMLS ListingId, which is how
    // lib/mls-facts.js's mergeMlsFacts() finds the matching CRMLS copy and lends
    // this comp its furnished / lease length / 55+ facts. The year built is
    // shown on the comp card. RentCast gives nothing else about the MLS.
    mls_listing_id: c.mlsName === 'CRMLS' ? cleanListingId(c.mlsNumber) : null,
    year_built: cleanYearBuilt(c.yearBuilt),
  };
}

/**
 * Maps one listing from RentCast's listings search into the same partial
 * rental_comps row mapComparable() produces for an AVM comparable. The one
 * difference: the listings search has no `distance` field (the AVM comps do),
 * so it is computed here as the great-circle distance from the subject, when
 * both the listing and the subject have coordinates. Otherwise it is left
 * undefined, which mapComparable() turns into a null distance_miles — never
 * guessed. Status goes through the existing mapListingStatus(): Active ->
 * 'active', anything else (Inactive) -> 'off_market', never 'leased'.
 *
 * Returns null when the listing has no price > 0 (see mapComparable()).
 *
 * @param {object} listing - one element of the /listings/rental/long-term array
 * @param {number} subjectLat
 * @param {number} subjectLon
 */
function mapListing(listing, subjectLat, subjectLon) {
  const hasCoordinates = typeof listing.latitude === 'number' && typeof listing.longitude === 'number'
    && typeof subjectLat === 'number' && typeof subjectLon === 'number';
  const distance = hasCoordinates
    ? haversineMiles(subjectLat, subjectLon, listing.latitude, listing.longitude)
    : undefined;
  return mapComparable({ ...listing, distance });
}

/**
 * Keeps every Active listing and only the LISTINGS_MAX_INACTIVE nearest of the
 * rest (RentCast's Inactive = no longer listed, never a confirmed lease; it
 * maps to 'off_market'). "Nearest" ranks by distance ascending with a null
 * distance last; ties go to the row RentCast sent first. The rows that survive
 * come back in the order RentCast sent them, so nothing downstream sees a
 * different ordering than before. Expects rows that have already passed the
 * price/radius/subject-address filters, so the kept rows are all valid,
 * in-radius ones.
 */
function capInactiveListings(comps) {
  const inactive = comps
    .map((comp, order) => ({ comp, order }))
    .filter(({ comp }) => comp.listing_status !== 'active');
  if (inactive.length <= LISTINGS_MAX_INACTIVE) return comps;
  const nearest = new Set(inactive
    .sort((a, b) => {
      const da = typeof a.comp.distance_miles === 'number' ? a.comp.distance_miles : Infinity;
      const db = typeof b.comp.distance_miles === 'number' ? b.comp.distance_miles : Infinity;
      if (da !== db) return da < db ? -1 : 1;
      return a.order - b.order;
    })
    .slice(0, LISTINGS_MAX_INACTIVE)
    .map(({ comp }) => comp));
  console.log(`[rental-analysis] RentCast listings search: kept all ${comps.length - inactive.length} Active and the ${LISTINGS_MAX_INACTIVE} nearest of ${inactive.length} Inactive listings.`);
  return comps.filter(comp => comp.listing_status === 'active' || nearest.has(comp));
}

/**
 * Pulls RentCast's full rental-listings search around the subject: Active and
 * Inactive (recently removed) rentals within WIDE_SEARCH_RADIUS_MILES,
 * of the subject's property type, with a bedroom count within
 * BEDROOM_MISMATCH_THRESHOLD - 1 of the subject's, listed in the last
 * LISTINGS_DAYS_OLD days. ONE billable request returns both statuses
 * (`status=Active|Inactive`). Every Active listing is returned; of the
 * Inactive ones only the LISTINGS_MAX_INACTIVE nearest (see
 * capInactiveListings()).
 *
 * NEVER THROWS. A non-OK response (including a 429), a network error, bad
 * JSON, or a body that is not an array each log one warning line, tell the
 * optional reportPartialFailure callback ({what, message}) and return
 * [] — the AVM comps already pulled still produce a report, and the caller
 * can say that part of RentCast did not come back. Does not
 * paginate. If RentCast reports (x-total-count) more matches than it sent
 * back, logs a single truncation warning.
 *
 * Rows are filtered after mapping, in this order: no price > 0 (missing, 0,
 * negative, non-numeric) -> dropped;
 * numeric distance beyond WIDE_SEARCH_RADIUS_MILES -> dropped; address matches
 * the subject's own -> dropped (the subject must not appear as its own comp);
 * then the Inactive cap above is applied to what is left, so the kept Inactive
 * rows are always valid, in-radius ones.
 * A listing with no coordinates is kept with a null distance, same as CRMLS
 * (it sorts last among Inactive, so it is dropped when 10 nearer ones exist).
 *
 * Caveat, accepted: the server-side bedrooms filter excludes a listing with no
 * bedroom count at all, unlike the house rule "unknown is not a mismatch".
 * RentCast listings essentially always carry bedrooms.
 *
 * @param {{address: string, propertyType: string, bedrooms: number}} subject
 * @param {number} lat - the AVM's subject latitude
 * @param {number} lon - the AVM's subject longitude
 * @param {function} [reportPartialFailure] - called with {what, message} on any failure
 * @returns {Promise<object[]>} mapped comps, [] on any failure
 */
async function pullRentCastListings(subject, lat, lon, reportPartialFailure = () => {}) {
  // Every path that returns [] without a real answer tells the caller (pullRentCastComps) so a report built on the
  // similar-rentals list alone can say that part of RentCast did not come back.
  const LISTINGS_WHAT = 'its search of nearby rental listings';
  try {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      radius: String(WIDE_SEARCH_RADIUS_MILES),
      status: 'Active|Inactive',
    });
    const rentcastType = TO_RENTCAST_PROPERTY_TYPE[subject.propertyType];
    if (rentcastType) params.set('propertyType', rentcastType);
    if (typeof subject.bedrooms === 'number') {
      const spread = BEDROOM_MISMATCH_THRESHOLD - 1;
      params.set('bedrooms', `${Math.max(0, subject.bedrooms - spread)}:${subject.bedrooms + spread}`);
    }
    params.set('daysOld', String(LISTINGS_DAYS_OLD));
    params.set('limit', String(LISTINGS_LIMIT));
    params.set('includeTotalCount', 'true');

    const res = await fetch(`${RENTCAST_BASE_URL}/listings/rental/long-term?${params.toString()}`, {
      headers: { 'X-Api-Key': process.env.RENTCAST_API_KEY, Accept: 'application/json' },
    });
    if (!res.ok) {
      console.warn(`[rental-analysis] RentCast listings search failed (${res.status}) — continuing with the AVM comps only.`);
      reportPartialFailure({ what: LISTINGS_WHAT, message: `status ${res.status}` });
      return [];
    }
    const data = await res.json();
    if (!Array.isArray(data)) {
      console.warn('[rental-analysis] RentCast listings search returned an unexpected (non-array) response — continuing with the AVM comps only.');
      reportPartialFailure({ what: LISTINGS_WHAT, message: 'unexpected response' });
      return [];
    }

    // Read only when a real Headers object is present — plain test mocks
    // have no headers at all.
    const totalHeader = res.headers && typeof res.headers.get === 'function' ? res.headers.get('x-total-count') : null;
    const total = totalHeader === null || totalHeader === undefined ? NaN : Number(totalHeader);
    if (Number.isFinite(total) && total > data.length) {
      console.warn(`[rental-analysis] RentCast listings search: ${total} matches but only ${data.length} returned (limit ${LISTINGS_LIMIT}) — results may be truncated.`);
    }

    const validRows = data
      .filter(listing => listing && typeof listing === 'object')
      .map(listing => mapListing(listing, lat, lon))
      .filter(Boolean) // mapListing() returns null for a listing with no price > 0
      .filter(comp => !(typeof comp.distance_miles === 'number' && comp.distance_miles > WIDE_SEARCH_RADIUS_MILES))
      .filter(comp => !isSameHome(subject.address, comp.address));
    return capInactiveListings(validRows);
  } catch (err) {
    console.warn(`[rental-analysis] RentCast listings search failed (${err.message}) — continuing with the AVM comps only.`);
    reportPartialFailure({ what: LISTINGS_WHAT, message: err.message });
    return [];
  }
}

/**
 * Pulls RentCast comps + a subject rent estimate for one analysis: the AVM
 * call (rent estimate, subject geocode, top-10 similar comps), then the full
 * listings search around the geocode — two RentCast requests when everything
 * works, one if the AVM call fails (the listings call is never made then).
 * @param {{address: string, propertyType: string, bedrooms: number, bathrooms: number, sqft: number}} subject
 * @returns {Promise<{subjectEstimatedRent: number|null, subjectLatitude: number|null, subjectLongitude: number|null, subjectZip: string|null, comps: object[]}>}
 */
async function pullRentCastComps(subject) {
  assertConfigured();

  const params = new URLSearchParams({
    address: subject.address,
    bedrooms: String(subject.bedrooms),
    bathrooms: String(subject.bathrooms),
    squareFootage: String(subject.sqft),
    compCount: String(DEFAULT_COMP_COUNT),
    maxRadius: String(WIDE_SEARCH_RADIUS_MILES),
  });
  const rentcastType = TO_RENTCAST_PROPERTY_TYPE[subject.propertyType];
  if (rentcastType) params.set('propertyType', rentcastType);

  const url = `${RENTCAST_BASE_URL}/avm/rent/long-term?${params.toString()}`;
  const res = await fetch(url, {
    headers: { 'X-Api-Key': process.env.RENTCAST_API_KEY, Accept: 'application/json' },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`RentCast API request failed (${res.status}): ${body || res.statusText}`);
  }

  const data = await res.json();

  const plausibility = assessPlausibility(data);
  if (!plausibility.plausible) {
    throw new Error(plausibility.reason);
  }

  const comparables = Array.isArray(data.comparables) ? data.comparables : [];

  // subjectProperty.latitude/longitude is the primary source; data.latitude/
  // longitude (the same values duplicated at the response's top level, per
  // the migration's design notes) is a fallback in case a future response
  // shape ever omits one but not the other.
  const subjectProperty = data.subjectProperty || {};
  const subjectLatitude = typeof subjectProperty.latitude === 'number' ? subjectProperty.latitude
    : (typeof data.latitude === 'number' ? data.latitude : null);
  const subjectLongitude = typeof subjectProperty.longitude === 'number' ? subjectProperty.longitude
    : (typeof data.longitude === 'number' ? data.longitude : null);

  // Second RentCast request: the full listings search around the coordinates
  // the AVM just geocoded. Only reached after the AVM call succeeded and
  // passed the plausibility check above, so a failed AVM costs exactly one
  // request. Skipped (one log line, no request) when there are no coordinates
  // to search around. Never throws — see pullRentCastListings().
  let listingComps = [];
  const partialFailure = [];
  if (typeof subjectLatitude === 'number' && typeof subjectLongitude === 'number') {
    listingComps = await pullRentCastListings(subject, subjectLatitude, subjectLongitude, failure => partialFailure.push(failure));
  } else {
    console.log('[rental-analysis] RentCast: AVM returned no subject coordinates — skipping the listings search.');
  }

  return {
    subjectEstimatedRent: typeof data.rent === 'number' ? data.rent : null,
    subjectLatitude,
    subjectLongitude,
    // subjectProperty.zipCode — confirmed live (1895 Dorrit St -> "91320")
    // sitting right next to subjectProperty.latitude/longitude above. Feeds
    // rental_analyses.subject_zip in server.js at zero extra RentCast cost
    // (same response already fetched for comps) — see lib/market-data.js
    // for what that zip is then used for. No top-level fallback documented
    // for this field (unlike lat/long), so this is the one source.
    subjectZip: typeof subjectProperty.zipCode === 'string' ? subjectProperty.zipCode : null,
    // AVM comps first so dedupeComps()'s first-seen tie-break stays stable:
    // an AVM comp beats its identical listings-search twin.
    // mapComparable() returns null for a comparable with no price > 0 — dropped.
    // The subject's own listing is never one of its comps. The similar-rentals list can include the subject itself
    // (a live run returned "1300 Saratoga Ave, Unit 500" for Unit 500), so it is taken out here as the listings
    // search already does for its own results. Another unit in the same building stays.
    comps: [...comparables.map(mapComparable).filter(Boolean).filter(c => !isSameHome(subject.address, c.address)), ...listingComps],
    // Only present when part of this source did not come back (see lib/sources.js sourceWarnings).
    ...(partialFailure.length ? { partialFailure } : {}),
  };
}

/**
 * Looks up known property details (bedrooms, bathrooms, sqft, year built,
 * property type) for a single address, so the analysis form can pre-fill
 * them for Peter to confirm/correct instead of typing from scratch.
 *
 * Distinct from pullRentCastComps() above: this hits RentCast's separate
 * Property Records endpoint (`/v1/properties?address=`), not the AVM/comps
 * endpoint pullRentCastComps() uses. Confirmed live against a real address
 * (1895 Dorrit St): returns propertyType/bedrooms/bathrooms/squareFootage/
 * yearBuilt among many other fields (tax records, owner info, sale
 * history, ...) — everything except those five is discarded here, never
 * stored or exposed.
 *
 * BUDGET NOTE: calling this ahead of pullRentCastComps() for the same
 * analysis means THREE RentCast requests instead of two (this lookup, the
 * AVM call, and the listings search) — RentCast's free tier is 50
 * requests/month total (see the module header above), so a lookup-then-run
 * analysis now costs 3 of those 50, not 2.
 *
 * Never throws for "no data" reasons (no match, RentCast downtime, a
 * network error, an unexpected response shape) — manual entry is always
 * the fallback, so any of those return null rather than an unhandled
 * rejection. A missing RENTCAST_API_KEY is the one exception: that's a
 * real setup problem, not "this address has no record," so it still
 * throws via assertConfigured(), same as pullRentCastComps().
 *
 * @param {string} address
 * @returns {Promise<{propertyType: string|null, bedrooms: number|null, bathrooms: number|null, squareFootage: number|null, yearBuilt: number|null}|null>}
 */
async function lookupPropertyDetails(address) {
  assertConfigured();

  const url = `${RENTCAST_BASE_URL}/properties?${new URLSearchParams({ address }).toString()}`;

  let data;
  try {
    const res = await fetch(url, {
      headers: { 'X-Api-Key': process.env.RENTCAST_API_KEY, Accept: 'application/json' },
    });
    // Any non-OK response (RentCast down, rate-limited, address it can't
    // parse at all, etc.) is treated the same as "no match" here — the
    // caller only needs to know whether to pre-fill or fall back to
    // manual entry, not why RentCast didn't return anything.
    if (!res.ok) return null;
    data = await res.json();
  } catch (err) {
    return null; // network error, bad JSON, etc. — same "not found" fallback
  }

  if (!Array.isArray(data) || !data.length) return null;

  const record = data[0];
  return {
    propertyType: FROM_RENTCAST_PROPERTY_TYPE[record.propertyType] || null,
    bedrooms: typeof record.bedrooms === 'number' ? record.bedrooms : null,
    bathrooms: typeof record.bathrooms === 'number' ? record.bathrooms : null,
    squareFootage: typeof record.squareFootage === 'number' ? record.squareFootage : null,
    yearBuilt: typeof record.yearBuilt === 'number' ? record.yearBuilt : null,
  };
}

module.exports = {
  pullRentCastComps,
  pullRentCastListings,
  lookupPropertyDetails,
  mapComparable,
  mapListing,
  mapListingStatus,
  toDateOnly,
  assessPlausibility,
  assertConfigured,
  TO_RENTCAST_PROPERTY_TYPE,
  FROM_RENTCAST_PROPERTY_TYPE,
  RENTCAST_BASE_URL,
  LISTINGS_DAYS_OLD,
  LISTINGS_LIMIT,
  LISTINGS_MAX_INACTIVE,
};
