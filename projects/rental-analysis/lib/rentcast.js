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
 * Uses /avm/rent/long-term, not the plain /listings/rental/long-term search
 * endpoint: one call returns both the subject property's own rent estimate
 * AND a similarity-ranked comparables list, so a full analysis costs one
 * RentCast request instead of two or three — matters a lot on a 50/month
 * budget.
 *
 * Radius tiering: requests comps out to WIDE_SEARCH_RADIUS_MILES via
 * RentCast's own documented `maxRadius` query param ("The maximum distance
 * between comparable listings and the subject property, in miles" — one
 * real network call, not two), then locally prefers the
 * NARROW_SEARCH_RADIUS_MILES subset when it meets MIN_COMPS_FOR_NARROW_RADIUS,
 * falling back to the full wide set otherwise — see applyRadiusTiering()
 * below and lib/constants.js for the shared numbers. Same policy as
 * lib/crmls.js and lib/leadsimple.js, decided independently per source.
 *
 * A third RentCast endpoint, /v1/markets (zip-code-level market stats, not
 * property/comp-level), is a separate concern handled by lib/market-data.js,
 * not this file — kept apart so this file doesn't become a dumping ground
 * for every RentCast endpoint. assertConfigured() and RENTCAST_BASE_URL are
 * exported below so that file can reuse them instead of duplicating.
 */

const { NARROW_SEARCH_RADIUS_MILES, WIDE_SEARCH_RADIUS_MILES, MIN_COMPS_FOR_NARROW_RADIUS } = require('./constants');

const RENTCAST_BASE_URL = 'https://api.rentcast.io/v1';
const DEFAULT_COMP_COUNT = 10; // RentCast allows 5-25 per request; 10 balances sample size against payload/API cost

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

// Prefers the tight NARROW_SEARCH_RADIUS_MILES subset when it has enough
// comps (MIN_COMPS_FOR_NARROW_RADIUS); otherwise keeps the full
// WIDE_SEARCH_RADIUS_MILES set already pulled via maxRadius above — no
// second request either way. A comp with no distance_miles (shouldn't
// happen on a real RentCast response, but never assumed) is only ever kept
// via the wide-set fallback, never counted toward the narrow subset.
function applyRadiusTiering(comps) {
  const narrow = comps.filter(c => typeof c.distance_miles === 'number' && c.distance_miles <= NARROW_SEARCH_RADIUS_MILES);
  return narrow.length >= MIN_COMPS_FOR_NARROW_RADIUS ? narrow : comps;
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
 */
function mapComparable(c) {
  return {
    address: c.formattedAddress
      || [c.addressLine1, c.city, c.state, c.zipCode].filter(Boolean).join(', '),
    property_type: FROM_RENTCAST_PROPERTY_TYPE[c.propertyType] || null,
    bedrooms: typeof c.bedrooms === 'number' ? c.bedrooms : null,
    bathrooms: typeof c.bathrooms === 'number' ? c.bathrooms : null,
    sqft: typeof c.squareFootage === 'number' ? c.squareFootage : null,
    distance_miles: typeof c.distance === 'number' ? c.distance : null,
    latitude: typeof c.latitude === 'number' ? c.latitude : null,
    longitude: typeof c.longitude === 'number' ? c.longitude : null,
    monthly_rent: c.price,
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
    // the plain listings-search endpoint's `history` object would, and we
    // don't call that endpoint — see module header). So these are always
    // "no known cut," not "confirmed no cut ever happened," for RentCast
    // comps specifically. Real values once FlexMLS is live.
    original_price: null,
    had_price_cut: false,
    listing_status: mapListingStatus(c.status),
    days_on_market: typeof c.daysOnMarket === 'number' ? c.daysOnMarket : null,
    listed_date: toDateOnly(c.listedDate),
    // "when it went off market" per the schema's dual-purpose comment on
    // this column — not asserted as a lease start date, consistent with
    // never claiming 'leased' for a RentCast comp (see mapListingStatus).
    leased_date: toDateOnly(c.removedDate),
  };
}

/**
 * Pulls RentCast comps + a subject rent estimate for one analysis.
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
  return {
    subjectEstimatedRent: typeof data.rent === 'number' ? data.rent : null,
    subjectLatitude: typeof subjectProperty.latitude === 'number' ? subjectProperty.latitude
      : (typeof data.latitude === 'number' ? data.latitude : null),
    subjectLongitude: typeof subjectProperty.longitude === 'number' ? subjectProperty.longitude
      : (typeof data.longitude === 'number' ? data.longitude : null),
    // subjectProperty.zipCode — confirmed live (1895 Dorrit St -> "91320")
    // sitting right next to subjectProperty.latitude/longitude above. Feeds
    // rental_analyses.subject_zip in server.js at zero extra RentCast cost
    // (same response already fetched for comps) — see lib/market-data.js
    // for what that zip is then used for. No top-level fallback documented
    // for this field (unlike lat/long), so this is the one source.
    subjectZip: typeof subjectProperty.zipCode === 'string' ? subjectProperty.zipCode : null,
    comps: applyRadiusTiering(comparables.map(mapComparable)),
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
 * analysis means TWO RentCast requests instead of one — RentCast's free
 * tier is 50 requests/month total (see the module header above), so a
 * lookup-then-run analysis now costs 2 of those 50, not 1.
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
  lookupPropertyDetails,
  mapComparable,
  mapListingStatus,
  toDateOnly,
  assessPlausibility,
  assertConfigured,
  applyRadiusTiering,
  TO_RENTCAST_PROPERTY_TYPE,
  FROM_RENTCAST_PROPERTY_TYPE,
  RENTCAST_BASE_URL,
};
