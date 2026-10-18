/**
 * lib/crmls.js
 * CRMLS (Southern California's real MLS) client, accessed through Recore, a
 * licensed data platform — not a direct MLS connection. Second comp source
 * alongside lib/rentcast.js; see lib/sources.js for how a new source gets
 * registered.
 *
 * This is the only source that can produce a `leased` comp (a real closed
 * transaction, not an inferred one) — see lib/weighting.js, which already
 * weights `leased` 3x and required no changes for this build.
 *
 * Base URL / auth / query syntax / field names below were all confirmed live
 * against the real production feed (not the account's `test_recore` sample
 * dataset — never use that one) — see CRMLS-INTEGRATION-SPEC.md's Technical
 * Appendix for the first pass, and this file's build session for the
 * additional PropertySubType field (housing type — see
 * FROM_CRMLS_PROPERTY_TYPE below), which the spec didn't cover.
 *
 * Needs RECORE_SERVER_TOKEN (server-to-server; NOT RECORE_BROWSER_TOKEN).
 * Rate limit: 5,000/hr — generous, no RentCast-style request budgeting
 * needed (contrast lib/rentcast.js, which bills per request).
 *
 * Relevance filtering (COMP-COVERAGE-SPEC.md): Recore has no distance sort,
 * so the old "take the 10 newest in the box, then filter" approach let
 * condos, duplexes and townhouses crowd a near-perfect single-family lease
 * out of the 10 slots. Each query now asks the MLS only for records that
 * could actually be comparable — a compatible PropertySubType and a
 * compatible BedroomsTotal, both written so an UNKNOWN (null) value still
 * passes (an unknown type or bedroom count is not a mismatch) — up to
 * MAX_RECORDS_PER_STATUS (Recore's maximum page), and closed leases only from
 * the last CRMLS_CLOSED_LOOKBACK_MONTHS months. See buildFilter().
 */

const { NARROW_SEARCH_RADIUS_MILES, WIDE_SEARCH_RADIUS_MILES, MIN_COMPS_FOR_NARROW_RADIUS, positiveOrNull, nonNegativeOrNull, inRangeOrNull } = require('./constants');
const { BEDROOM_MISMATCH_THRESHOLD } = require('./weighting');
const { mlsFactsFromRecord } = require('./mls-facts');

const CRMLS_BASE_URL = 'https://api.marketplace.recore.net/api/v2/OData/crmls/Property';

// Per status. 200 is Recore's maximum $top (a larger value is a 400 error).
// Two statuses queried per analysis (Closed + Active). With the relevance
// filter and date floor in buildFilter() this is far more than a typical
// area returns; if a status ever comes back with exactly this many rows we
// log a possible-truncation warning rather than paginate.
const MAX_RECORDS_PER_STATUS = 200;

// How far back to look for closed (leased) records. Active listings get no
// date floor. A deliberate window, not "the 10 newest" (see header): 6 months
// keeps the lease market current without pulling in last winter's outliers.
const CRMLS_CLOSED_LOOKBACK_MONTHS = 6;

// How far out to search when the subject's coordinates are known (see
// pullCrmlsComps()) — a bounding box is queried at this radius (unchanged:
// still ONE network call), then post-filtered to a true circle (see
// haversineMiles()/buildBoundingBox() below). This file always returns
// everything that survives the circle filter, out to WIDE_SEARCH_RADIUS_MILES
// — it does not decide how far out to actually use. That is the radius
// ladder, applied once across all comp sources together by
// applyCombinedRadiusTiering() in lib/sources.js, after every active source
// has reported back. See lib/constants.js for the ladder numbers.

const SELECT_FIELDS = [
  'ListingKey', 'ListingId', 'StandardStatus', 'PropertySubType',
  'StreetNumberNumeric', 'StreetDirPrefix', 'StreetName', 'StreetSuffix', 'StreetDirSuffix', 'UnitNumber',
  'City', 'StateOrProvince', 'PostalCode',
  'BedroomsTotal', 'BathroomsTotalDecimal',
  'ListPrice', 'ClosePrice', 'OriginalListPrice',
  'CloseDate', 'OnMarketDate', 'ListingContractDate',
  'Latitude', 'Longitude', 'LivingArea', 'DaysOnMarket',
  // The extra MLS facts (CMA-QUALITY-SPEC.md Item 2): furnished, lease length,
  // 55+ community, neighborhood, year built, the MLS's own condition word, and
  // the fields behind the display tags (HOA, private pool, what the rent
  // includes). PublicRemarks (the listing's marketing text) is deliberately NOT
  // fetched: nothing uses it yet, and it is licensed text we never store.
  'Furnished', 'LeaseTerm', 'SeniorCommunityYN', 'SubdivisionName', 'YearBuilt',
  'PropertyCondition', 'AssociationYN', 'PoolPrivateYN', 'RentIncludes',
].join(',');

// CRMLS's PropertySubType -> our CHECK-constraint list (rental_comps.property_type,
// identical list to lib/rentcast.js's FROM_RENTCAST_PROPERTY_TYPE target).
// Values seen on PropertyType 'Residential Lease' in live read-only samples
// (a 2-mile Ventura box, 414 rows, and a 12-mile Ventura-area box, 2,172
// rows): Single Family Residence, Condominium, Townhouse, Duplex, Triplex,
// Quadruplex, Apartment, Studio, Loft, Rooms for Rent, Commercial/Residential,
// Manufactured On Land, null, and (in an earlier sample) Stock Cooperative.
// Duplex/Triplex/Quadruplex map 1:1 to our duplex/triplex/fourplex (they used
// to be unmapped, which counted a duplex as a match for a single-family
// subject — "unknown type" is never a mismatch). Studio is an apartment unit;
// Rooms for Rent and Commercial/Residential are real but not any bucket we
// compare against, so they map to 'other'. Deliberately left UNMAPPED -> null
// (leave null rather than guess, same reasoning as RentCast's
// FROM_RENTCAST_PROPERTY_TYPE): Loft (ambiguous), Stock Cooperative, and
// anything new CRMLS adds later.
const FROM_CRMLS_PROPERTY_TYPE = {
  'Single Family Residence': 'single_family',
  'Condominium': 'condo',
  'Townhouse': 'townhouse',
  'Apartment': 'apartment',
  'Manufactured On Land': 'manufactured',
  'Duplex': 'duplex',
  'Triplex': 'triplex',
  'Quadruplex': 'fourplex',
  'Studio': 'apartment',
  'Rooms for Rent': 'other',
  'Commercial/Residential': 'other',
};

// Reverse of the map above, derived from it so the two can never drift:
// our property type -> every CRMLS PropertySubType that maps to it, used by
// buildFilter() to ask the MLS only for compatible records. 'other' is left
// out on purpose — we have no idea which CRMLS subtype a subject of type
// 'other' would match, so no subtype clause is added for it (same reasoning
// as lib/rentcast.js omitting propertyType for 'other').
const TO_CRMLS_PROPERTY_SUBTYPES = {};
for (const [subtype, ourType] of Object.entries(FROM_CRMLS_PROPERTY_TYPE)) {
  if (ourType === 'other') continue;
  if (!TO_CRMLS_PROPERTY_SUBTYPES[ourType]) TO_CRMLS_PROPERTY_SUBTYPES[ourType] = [];
  TO_CRMLS_PROPERTY_SUBTYPES[ourType].push(subtype);
}

function assertConfigured() {
  if (!process.env.RECORE_SERVER_TOKEN) {
    throw new Error(
      'Missing RECORE_SERVER_TOKEN. This is the Recore/CRMLS server-to-server access token ' +
      '(not RECORE_BROWSER_TOKEN) — add it to projects/rental-analysis/.env.'
    );
  }
}

// Subject property here is {address, ...} plus, when lib/sources.js's
// runActiveSources() ran RentCast first and RentCast geocoded successfully,
// {latitude, longitude} — see pullCrmlsComps() below, which uses those
// coordinates for a true radius search (a lat/long bounding box, since
// CRMLS/Recore has no native radius/geo-search endpoint — see spec's
// Technical Appendix) whenever they're present. CRMLS has no autocomplete or
// AVM step of its own to resolve a zip or geocode from scratch — this
// extractZip() fallback (parsing the 5-digit zip off the end of the typed
// address string) is what's used when coordinates aren't available, same
// zip-only "nearby" mechanism as before this build.
function extractZip(address) {
  if (!address || typeof address !== 'string') return null;
  const match = address.match(/\b(\d{5})(?:-\d{4})?\s*$/);
  return match ? match[1] : null;
}

// The zip a zip-scoped search uses: the one typed at the end of the address when there is one; otherwise the zip the
// geocoder found for the subject (RentCast's own answer to this analysis, already paid for), which lib/sources.js
// hands on as subject.zip. An address picked from the suggestion dropdown arrives as "..., CA, USA" with no zip, which
// used to mean Rincon's own move-in records were never searched. null when there is no zip anywhere.
function subjectZipFor(subject) {
  const typed = extractZip(subject && subject.address);
  if (typed) return typed;
  const found = subject && typeof subject.zip === 'string' ? subject.zip.trim().match(/^(\d{5})(?:-\d{4})?$/) : null;
  return found ? found[1] : null;
}

function toDateOnly(dateString) {
  if (!dateString || typeof dateString !== 'string') return null;
  return dateString.slice(0, 10); // CRMLS dates already come as 'YYYY-MM-DD'; slice is a safe no-op if ever fuller
}

// 'YYYY-MM-DD' for the start of the closed-lease lookback window — same
// month-subtraction pattern as lib/leadsimple.js's MOVE_IN_LOOKBACK_MONTHS
// cutoff. `now` is injectable only so a test can pin the date.
function closedSinceDate(now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - CRMLS_CLOSED_LOOKBACK_MONTHS);
  return cutoff.toISOString().slice(0, 10);
}

// Standard Haversine great-circle distance, in miles (Earth radius 3958.8 mi).
function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Converts a center point + radius into a lat/long box. 1 degree of latitude
// is ~69 miles everywhere; 1 degree of longitude shrinks toward the poles by
// cos(latitude), hence the cosine correction on lonDelta.
function buildBoundingBox(latitude, longitude, radiusMiles) {
  const latDelta = radiusMiles / 69.0;
  const lonDelta = radiusMiles / (69.0 * Math.cos(latitude * Math.PI / 180));
  return {
    minLat: latitude - latDelta,
    maxLat: latitude + latDelta,
    minLon: longitude - lonDelta,
    maxLon: longitude + lonDelta,
  };
}

// No UnparsedAddress field exists on this feed (confirmed — see spec's
// Technical Appendix) — assembled by hand from the parts that do exist.
// StreetNumberNumeric (int) preferred over StreetNumber (string, can be
// null even when the numeric version is populated — per spec).
function buildAddress(record) {
  const streetLine = [
    record.StreetNumberNumeric != null ? String(record.StreetNumberNumeric) : null,
    record.StreetDirPrefix,
    record.StreetName,
    record.StreetSuffix,
    record.StreetDirSuffix,
  ].filter(Boolean).join(' ');
  const unit = record.UnitNumber ? `Unit ${record.UnitNumber}` : null;
  const cityStateZip = [
    record.City,
    [record.StateOrProvince, record.PostalCode].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ');
  return [streetLine, unit, cityStateZip].filter(Boolean).join(', ');
}

// True for a Closed lease whose close date is later than today. That can only
// be a data-entry mistake (one real record, 7376 Impala Drive, was closed
// "2026-11-15" in a year-typo for 2025-11-15), and left in it would look like
// a brand-new lease. Such a record is dropped. Only Closed records are
// checked: an Active listing has no close date. `now` is injectable for tests.
function isFutureDatedClosedRecord(record, now = new Date()) {
  if (!record || record.StandardStatus !== 'Closed') return false;
  const closeDate = toDateOnly(record.CloseDate);
  return !!closeDate && closeDate > now.toISOString().slice(0, 10);
}

/**
 * Maps one CRMLS Property record into a partial rental_comps row. Returns
 * null when no usable rent figure exists — monthly_rent must be a number > 0;
 * missing, 0, negative or non-numeric all mean "rent unknown" (monthly_rent is
 * NOT NULL on rental_comps — see the migration) rather than inserting a
 * broken or $0 row; pullCrmlsComps() filters these out.
 *
 * @param {object} record
 * @param {number|null} [distanceMiles] - real Haversine distance from the
 *   subject, computed by pullCrmlsComps() when the search was box-based and
 *   this record has its own real Latitude/Longitude. Omitted (-> null) for
 *   the zip-fallback path or a record with no coordinates — never guessed.
 * @param {Date} [now] - today, injectable only so a test can pin it. Used for the future-close-date check and the "new construction" tag.
 */
function mapComparable(record, distanceMiles = null, now = new Date()) {
  if (isFutureDatedClosedRecord(record, now)) return null;
  const isClosed = record.StandardStatus === 'Closed';
  // Closed (leased) records: ClosePrice is the actual amount it leased for
  // — the real transaction figure, and what makes this comp worth 3x in
  // lib/weighting.js. Fall back to ListPrice if ClosePrice is not a real
  // positive number (absent, or the MLS's 0 placeholder for "not entered" —
  // two real Closed records, 1121 Pittsfield Ln and 1300 Saratoga Ave, carry
  // ClosePrice 0 beside a normal ListPrice; on 400 real Closed records
  // ClosePrice equals ListPrice 84% of the time and is within 5% on 95%).
  // Active records have no ClosePrice at all (null on every Active record
  // tested) — ListPrice is the only real asking price available, same as
  // RentCast's active comps. A rent of 0 means "unknown", never "free": if
  // neither figure is a positive number there is no comp, and a $0 rent
  // must never reach lib/weighting.js (a leased comp counts 3x, so a single
  // $0 drags the whole range's low end to $0).
  const closePrice = positiveOrNull(record.ClosePrice);
  const monthlyRent = isClosed && closePrice !== null
    ? closePrice
    : positiveOrNull(record.ListPrice);
  if (monthlyRent === null) return null;

  const propertyType = FROM_CRMLS_PROPERTY_TYPE[record.PropertySubType] || null;

  return {
    address: buildAddress(record),
    property_type: propertyType,
    bedrooms: nonNegativeOrNull(record.BedroomsTotal),
    bathrooms: nonNegativeOrNull(record.BathroomsTotalDecimal),
    // A live CRMLS record reports LivingArea 0 for "unknown"; rental_comps.sqft
    // is CHECK (sqft > 0), so 0 must become null or the batch insert fails.
    sqft: positiveOrNull(record.LivingArea),
    // Real computed Haversine distance when pullCrmlsComps() ran a box-based
    // search and this record has coordinates; null for the zip-fallback path
    // or a record with no lat/long — nullable on rental_comps for exactly
    // this ("comps come from external APIs that don't always classify type
    // cleanly" — same reasoning as property_type). Never invented.
    distance_miles: nonNegativeOrNull(distanceMiles),
    latitude: inRangeOrNull(record.Latitude, -90, 90),
    longitude: inRangeOrNull(record.Longitude, -180, 180),
    monthly_rent: monthlyRent,
    // ListPrice/ClosePrice are real MLS-observed figures, never algorithmic
    // — same reasoning as RentCast's `price` field (see lib/rentcast.js).
    is_estimated_price: false,
    original_price: nonNegativeOrNull(record.OriginalListPrice),
    had_price_cut: typeof record.OriginalListPrice === 'number' && typeof record.ListPrice === 'number'
      ? record.ListPrice < record.OriginalListPrice
      : false,
    // The whole point of this source: a real confirmed transaction maps to
    // 'leased', not an inferred status — see lib/weighting.js.
    listing_status: isClosed ? 'leased' : 'active',
    days_on_market: nonNegativeOrNull(record.DaysOnMarket),
    listed_date: toDateOnly(record.OnMarketDate) || toDateOnly(record.ListingContractDate),
    // "when it went off market / lease began" per the schema's dual-purpose
    // comment on this column — CloseDate is a real confirmed lease date
    // here (unlike RentCast, which never sets this — see mapListingStatus
    // there), consistent with only CRMLS producing 'leased' comps.
    leased_date: toDateOnly(record.CloseDate),
    // The extra MLS facts (lib/mls-facts.js): MLS number, year built,
    // neighborhood, furnished, lease length, 55+, the MLS's condition word and
    // the display tags. Unknown stays null and never excludes a comp.
    ...mlsFactsFromRecord(record, { propertyType, now }),
  };
}

// scope is either {type: 'zip', zip} (today's exact behavior) or
// {type: 'box', minLat, maxLat, minLon, maxLon} (the new radius search) —
// see pullCrmlsComps().
//
// relevance is optional. Omitted (or {}), the output is exactly the
// scope-only filter. Otherwise these clauses are appended, in this order:
//   - subtype: only if relevance.propertyType has CRMLS subtypes
//     (TO_CRMLS_PROPERTY_SUBTYPES) — a matching PropertySubType OR null
//   - bedrooms: only if relevance.bedrooms is a number — within
//     BEDROOM_MISMATCH_THRESHOLD - 1 of it (same range lib/rentcast.js asks
//     RentCast for) OR null
//   - date floor: only for status 'Closed' with relevance.closedSince set —
//     CloseDate on or after that 'YYYY-MM-DD'
// The `eq null` branches keep the house rule that an unknown type or unknown
// bedroom count is not a mismatch. A record whose subtype IS known to CRMLS
// but unmapped (Loft, Stock Cooperative) is deliberately not fetched for a
// typed subject: CRMLS told us what it is, so that is not missing data.
function buildFilter(status, scope, relevance = {}) {
  const base = `StandardStatus eq '${status}' and PropertyType eq 'Residential Lease'`;
  let filter = scope.type === 'box'
    ? `${base} and Latitude ge ${scope.minLat} and Latitude le ${scope.maxLat} and Longitude ge ${scope.minLon} and Longitude le ${scope.maxLon}`
    : `${base} and PostalCode eq '${scope.zip}'`;

  const rel = relevance || {};
  const subtypes = TO_CRMLS_PROPERTY_SUBTYPES[rel.propertyType];
  if (Array.isArray(subtypes) && subtypes.length) {
    const clauses = [...subtypes.map(subtype => `PropertySubType eq '${subtype}'`), 'PropertySubType eq null'];
    filter += ` and (${clauses.join(' or ')})`;
  }
  if (typeof rel.bedrooms === 'number') {
    const spread = BEDROOM_MISMATCH_THRESHOLD - 1;
    const lo = Math.max(0, rel.bedrooms - spread);
    const hi = rel.bedrooms + spread;
    filter += ` and ((BedroomsTotal ge ${lo} and BedroomsTotal le ${hi}) or BedroomsTotal eq null)`;
  }
  if (status === 'Closed' && rel.closedSince) {
    filter += ` and CloseDate ge ${rel.closedSince}`;
  }
  return filter;
}

async function fetchByStatus(scope, status, orderBy, relevance) {
  const filter = buildFilter(status, scope, relevance);
  const params = new URLSearchParams({
    access_token: process.env.RECORE_SERVER_TOKEN,
    '$filter': filter,
    '$select': SELECT_FIELDS,
    '$orderby': orderBy,
    '$top': String(MAX_RECORDS_PER_STATUS),
  });
  const res = await fetch(`${CRMLS_BASE_URL}?${params.toString()}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`CRMLS API request failed (${res.status}): ${body || res.statusText}`);
  }
  const data = await res.json();
  // An empty list is a real answer ("nothing nearby"); a reply with no list at all is a malformed one, and is reported as
  // a failure of this half (see pullCrmlsComps(): a lost half becomes a partial-failure warning) instead of reading as "no comps".
  if (!data || !Array.isArray(data.value)) {
    throw new Error(`CRMLS API returned an unexpected reply for the ${status} query (no "value" list).`);
  }
  const records = data.value;
  if (records.length >= MAX_RECORDS_PER_STATUS) {
    console.warn(`[rental-analysis] CRMLS: ${status} query returned ${records.length} records, the maximum page size — results may be truncated (not paginated).`);
  }
  return records;
}

/**
 * Pulls CRMLS comps for one analysis: recently leased (Closed, last
 * CRMLS_CLOSED_LOOKBACK_MONTHS months) records plus current listings
 * (Active), each limited server-side to a compatible property subtype and
 * bedroom count when the subject carries them (see buildFilter()), up to
 * MAX_RECORDS_PER_STATUS per status. Scoped to a true radius search (a lat/long
 * bounding box, post-filtered to a circle — see below) whenever
 * subject.latitude/subject.longitude are real numbers — this is the normal
 * path now, since lib/sources.js's runActiveSources() runs RentCast first
 * and feeds its geocode result forward. Falls back to exactly the previous
 * PostalCode-only scoping when those coordinates aren't available (RentCast
 * inactive/failed, or called directly without them) — never throws over a
 * missing subject.latitude/longitude, only degrades.
 * Same {comps: [...]} shape as pullRentCastComps() in lib/rentcast.js, so
 * lib/sources.js's loop doesn't need to know which source it called.
 *
 * The Closed and Active queries run independently: if one fails (e.g. a
 * transient Recore error) but the other succeeds, this still returns
 * whatever comps it could get rather than discarding a working half — only
 * logged as a warning. If BOTH fail, this throws so lib/sources.js records
 * a real source error (the spec's "worth a periodic gut-check" signal for
 * a credentials/access lapse) instead of silently looking like "zero
 * comps for this address."
 *
 * @param {{address: string, latitude?: number, longitude?: number, propertyType?: string, bedrooms?: number}} subject
 * @returns {Promise<{comps: object[], subjectEstimatedRent: null, subjectLatitude: null, subjectLongitude: null, subjectZip: string|null}>}
 */
async function pullCrmlsComps(subject) {
  assertConfigured();

  const hasCoordinates = typeof subject.latitude === 'number' && typeof subject.longitude === 'number';
  // Parsed either way: it's the search scope on the fallback path, and just
  // a nice-to-have subjectZip fallback (see the return below) on the
  // coordinate path, where it's not required for the search itself.
  const zip = subjectZipFor(subject);

  let scope;
  if (hasCoordinates) {
    scope = { type: 'box', ...buildBoundingBox(subject.latitude, subject.longitude, WIDE_SEARCH_RADIUS_MILES) };
  } else if (zip) {
    scope = { type: 'zip', zip };
  } else {
    console.warn(`[rental-analysis] CRMLS: no subject coordinates available and could not find a 5-digit zip at the end of "${subject.address}" — skipping (no way to scope a CRMLS search without one).`);
    return { comps: [], subjectEstimatedRent: null, subjectLatitude: null, subjectLongitude: null, subjectZip: null, skipped: 'no location or zip code for this address' };
  }

  // runActiveSources() hands every handler the whole subject, so propertyType
  // and bedrooms are normally present; when they aren't (older tests, a
  // direct call) buildFilter() simply adds no type/bedroom clauses.
  const relevance = { propertyType: subject.propertyType, bedrooms: subject.bedrooms, closedSince: closedSinceDate() };
  const [closedResult, activeResult] = await Promise.allSettled([
    fetchByStatus(scope, 'Closed', 'CloseDate desc', relevance),
    fetchByStatus(scope, 'Active', 'OnMarketDate desc', relevance),
  ]);

  if (closedResult.status === 'rejected' && activeResult.status === 'rejected') {
    throw new Error(`CRMLS request failed for both Closed and Active: ${closedResult.reason.message}`);
  }
  // One half failed: keep the other half, but say so (lib/sources.js sourceWarnings), so a report with no comps cannot
  // read as "nothing nearby" when part of the MLS never answered.
  const partialFailure = [];
  if (closedResult.status === 'rejected') {
    console.warn(`[rental-analysis] CRMLS: Closed (leased) query failed, continuing with Active only: ${closedResult.reason.message}`);
    partialFailure.push({ what: 'its recently leased homes', message: closedResult.reason.message });
  }
  if (activeResult.status === 'rejected') {
    console.warn(`[rental-analysis] CRMLS: Active query failed, continuing with Closed only: ${activeResult.reason.message}`);
    partialFailure.push({ what: 'its active listings', message: activeResult.reason.message });
  }

  let records = [
    ...(closedResult.status === 'fulfilled' ? closedResult.value : []),
    ...(activeResult.status === 'fulfilled' ? activeResult.value : []),
  ];

  // A box's corners are farther from center than its edges, so a box query
  // alone isn't a true radius search. On the coordinate path only: compute
  // each record's real distance where it has coordinates of its own, and
  // drop anything the box let through but that's actually beyond
  // WIDE_SEARCH_RADIUS_MILES once measured on the circle. A record with no
  // Latitude/Longitude (some older Closed listings don't have them — per
  // the spec's field notes) is kept as-is, distance left null — no basis to
  // compute or drop it. The zip fallback path never runs this at all.
  if (scope.type === 'box') {
    records = records
      .map(record => (
        typeof record.Latitude === 'number' && typeof record.Longitude === 'number'
          ? { ...record, _distanceMiles: haversineMiles(subject.latitude, subject.longitude, record.Latitude, record.Longitude) }
          : record
      ))
      .filter(record => typeof record._distanceMiles !== 'number' || record._distanceMiles <= WIDE_SEARCH_RADIUS_MILES);
  }

  const now = new Date();
  const futureDated = records.filter(record => isFutureDatedClosedRecord(record, now)).length;
  if (futureDated) {
    console.warn(`[rental-analysis] CRMLS: dropped ${futureDated} Closed record(s) with a close date in the future (a data-entry mistake in the MLS).`);
  }
  const comps = records.map(record => mapComparable(record, record._distanceMiles, now)).filter(Boolean);

  return {
    comps,
    // CRMLS does no AVM-style estimate and doesn't geocode the subject
    // itself (unlike RentCast) — RentCast already supplies these reliably;
    // sources.js's "first non-null wins" merge just skips these from CRMLS.
    subjectEstimatedRent: null,
    subjectLatitude: null,
    subjectLongitude: null,
    // Offered as a fallback only — RentCast is the primary subjectZip
    // source (confirmed live from its own AVM response). This is just the
    // zip parsed out of the typed address, in case RentCast's call ever
    // fails on an analysis where CRMLS's still succeeds.
    subjectZip: zip,
    ...(partialFailure.length ? { partialFailure } : {}),
  };
}

module.exports = {
  pullCrmlsComps,
  mapComparable,
  extractZip,
  subjectZipFor,
  toDateOnly,
  buildAddress,
  assertConfigured,
  haversineMiles,
  buildBoundingBox,
  buildFilter,
  closedSinceDate,
  isFutureDatedClosedRecord,
  SELECT_FIELDS,
  FROM_CRMLS_PROPERTY_TYPE,
  TO_CRMLS_PROPERTY_SUBTYPES,
  MAX_RECORDS_PER_STATUS,
  CRMLS_CLOSED_LOOKBACK_MONTHS,
  CRMLS_BASE_URL,
  NARROW_SEARCH_RADIUS_MILES,
  WIDE_SEARCH_RADIUS_MILES,
  MIN_COMPS_FOR_NARROW_RADIUS,
};
