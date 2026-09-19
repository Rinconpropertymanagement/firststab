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
 * needed (contrast lib/rentcast.js's DEFAULT_COMP_COUNT comment).
 */

const CRMLS_BASE_URL = 'https://api.marketplace.recore.net/api/v2/OData/crmls/Property';

// Per status, mirrors RentCast's DEFAULT_COMP_COUNT order of magnitude (10).
// Two statuses queried per analysis (Closed + Active), so up to 20 CRMLS
// comps total, before weighting.
const COMPS_PER_STATUS = 10;

// How far out to search when the subject's coordinates are known (see
// pullCrmlsComps()) — a bounding box is queried at this radius, then
// post-filtered to a true circle (see haversineMiles()/buildBoundingBox()
// below). Easily adjustable later; 2 miles is a reasonable starting default,
// not a permanent decision.
const SEARCH_RADIUS_MILES = 2;

const SELECT_FIELDS = [
  'ListingKey', 'ListingId', 'StandardStatus', 'PropertySubType',
  'StreetNumberNumeric', 'StreetDirPrefix', 'StreetName', 'StreetSuffix', 'StreetDirSuffix', 'UnitNumber',
  'City', 'StateOrProvince', 'PostalCode',
  'BedroomsTotal', 'BathroomsTotalDecimal',
  'ListPrice', 'ClosePrice', 'OriginalListPrice',
  'CloseDate', 'OnMarketDate', 'ListingContractDate',
  'Latitude', 'Longitude', 'LivingArea', 'DaysOnMarket',
].join(',');

// CRMLS's PropertySubType -> our CHECK-constraint list (rental_comps.property_type,
// identical list to lib/rentcast.js's FROM_RENTCAST_PROPERTY_TYPE target).
// Live-sampled 200 real 'Residential Lease' records this session:
// Single Family Residence, Condominium, Townhouse, Apartment,
// Manufactured On Land, and one Stock Cooperative. Only the clean 1:1
// matches are mapped; Stock Cooperative has no safe bucket in our list
// (not a real match for 'condo' or 'other' either) so it's left unmapped ->
// null, same "leave null rather than guess" reasoning as RentCast's
// FROM_RENTCAST_PROPERTY_TYPE (see that file) for its own unmapped values.
const FROM_CRMLS_PROPERTY_TYPE = {
  'Single Family Residence': 'single_family',
  'Condominium': 'condo',
  'Townhouse': 'townhouse',
  'Apartment': 'apartment',
  'Manufactured On Land': 'manufactured',
};

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

function toDateOnly(dateString) {
  if (!dateString || typeof dateString !== 'string') return null;
  return dateString.slice(0, 10); // CRMLS dates already come as 'YYYY-MM-DD'; slice is a safe no-op if ever fuller
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

/**
 * Maps one CRMLS Property record into a partial rental_comps row. Returns
 * null when no usable rent figure exists (monthly_rent is NOT NULL on
 * rental_comps — see the migration) rather than inserting a broken row;
 * pullCrmlsComps() filters these out.
 *
 * @param {object} record
 * @param {number|null} [distanceMiles] - real Haversine distance from the
 *   subject, computed by pullCrmlsComps() when the search was box-based and
 *   this record has its own real Latitude/Longitude. Omitted (-> null) for
 *   the zip-fallback path or a record with no coordinates — never guessed.
 */
function mapComparable(record, distanceMiles = null) {
  const isClosed = record.StandardStatus === 'Closed';
  // Closed (leased) records: ClosePrice is the actual amount it leased for
  // — the real transaction figure, and what makes this comp worth 3x in
  // lib/weighting.js. Fall back to ListPrice only if ClosePrice is somehow
  // absent (shouldn't happen on a real Closed record per the spec, but
  // don't drop a comp over it). Active records have no ClosePrice at all
  // (null on every Active record tested) — ListPrice is the only real
  // asking price available, same as RentCast's active comps.
  const monthlyRent = isClosed && typeof record.ClosePrice === 'number'
    ? record.ClosePrice
    : record.ListPrice;
  if (typeof monthlyRent !== 'number' || !(monthlyRent >= 0)) return null;

  return {
    address: buildAddress(record),
    property_type: FROM_CRMLS_PROPERTY_TYPE[record.PropertySubType] || null,
    bedrooms: typeof record.BedroomsTotal === 'number' ? record.BedroomsTotal : null,
    bathrooms: typeof record.BathroomsTotalDecimal === 'number' ? record.BathroomsTotalDecimal : null,
    sqft: typeof record.LivingArea === 'number' ? record.LivingArea : null,
    // Real computed Haversine distance when pullCrmlsComps() ran a box-based
    // search and this record has coordinates; null for the zip-fallback path
    // or a record with no lat/long — nullable on rental_comps for exactly
    // this ("comps come from external APIs that don't always classify type
    // cleanly" — same reasoning as property_type). Never invented.
    distance_miles: typeof distanceMiles === 'number' ? distanceMiles : null,
    latitude: typeof record.Latitude === 'number' ? record.Latitude : null,
    longitude: typeof record.Longitude === 'number' ? record.Longitude : null,
    monthly_rent: monthlyRent,
    // ListPrice/ClosePrice are real MLS-observed figures, never algorithmic
    // — same reasoning as RentCast's `price` field (see lib/rentcast.js).
    is_estimated_price: false,
    original_price: typeof record.OriginalListPrice === 'number' ? record.OriginalListPrice : null,
    had_price_cut: typeof record.OriginalListPrice === 'number' && typeof record.ListPrice === 'number'
      ? record.ListPrice < record.OriginalListPrice
      : false,
    // The whole point of this source: a real confirmed transaction maps to
    // 'leased', not an inferred status — see lib/weighting.js.
    listing_status: isClosed ? 'leased' : 'active',
    days_on_market: typeof record.DaysOnMarket === 'number' ? record.DaysOnMarket : null,
    listed_date: toDateOnly(record.OnMarketDate) || toDateOnly(record.ListingContractDate),
    // "when it went off market / lease began" per the schema's dual-purpose
    // comment on this column — CloseDate is a real confirmed lease date
    // here (unlike RentCast, which never sets this — see mapListingStatus
    // there), consistent with only CRMLS producing 'leased' comps.
    leased_date: toDateOnly(record.CloseDate),
  };
}

// scope is either {type: 'zip', zip} (today's exact behavior) or
// {type: 'box', minLat, maxLat, minLon, maxLon} (the new radius search) —
// see pullCrmlsComps().
function buildFilter(status, scope) {
  const base = `StandardStatus eq '${status}' and PropertyType eq 'Residential Lease'`;
  if (scope.type === 'box') {
    return `${base} and Latitude ge ${scope.minLat} and Latitude le ${scope.maxLat} and Longitude ge ${scope.minLon} and Longitude le ${scope.maxLon}`;
  }
  return `${base} and PostalCode eq '${scope.zip}'`;
}

async function fetchByStatus(scope, status, orderBy) {
  const filter = buildFilter(status, scope);
  const params = new URLSearchParams({
    access_token: process.env.RECORE_SERVER_TOKEN,
    '$filter': filter,
    '$select': SELECT_FIELDS,
    '$orderby': orderBy,
    '$top': String(COMPS_PER_STATUS),
  });
  const res = await fetch(`${CRMLS_BASE_URL}?${params.toString()}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`CRMLS API request failed (${res.status}): ${body || res.statusText}`);
  }
  const data = await res.json();
  return Array.isArray(data.value) ? data.value : [];
}

/**
 * Pulls CRMLS comps for one analysis: recently leased (Closed) records plus
 * current listings (Active). Scoped to a true radius search (a lat/long
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
 * @param {{address: string, latitude?: number, longitude?: number}} subject
 * @returns {Promise<{comps: object[], subjectEstimatedRent: null, subjectLatitude: null, subjectLongitude: null, subjectZip: string|null}>}
 */
async function pullCrmlsComps(subject) {
  assertConfigured();

  const hasCoordinates = typeof subject.latitude === 'number' && typeof subject.longitude === 'number';
  // Parsed either way: it's the search scope on the fallback path, and just
  // a nice-to-have subjectZip fallback (see the return below) on the
  // coordinate path, where it's not required for the search itself.
  const zip = extractZip(subject.address);

  let scope;
  if (hasCoordinates) {
    scope = { type: 'box', ...buildBoundingBox(subject.latitude, subject.longitude, SEARCH_RADIUS_MILES) };
  } else if (zip) {
    scope = { type: 'zip', zip };
  } else {
    console.warn(`[rental-analysis] CRMLS: no subject coordinates available and could not find a 5-digit zip at the end of "${subject.address}" — skipping (no way to scope a CRMLS search without one).`);
    return { comps: [], subjectEstimatedRent: null, subjectLatitude: null, subjectLongitude: null, subjectZip: null };
  }

  const [closedResult, activeResult] = await Promise.allSettled([
    fetchByStatus(scope, 'Closed', 'CloseDate desc'),
    fetchByStatus(scope, 'Active', 'OnMarketDate desc'),
  ]);

  if (closedResult.status === 'rejected' && activeResult.status === 'rejected') {
    throw new Error(`CRMLS request failed for both Closed and Active: ${closedResult.reason.message}`);
  }
  if (closedResult.status === 'rejected') {
    console.warn(`[rental-analysis] CRMLS: Closed (leased) query failed, continuing with Active only: ${closedResult.reason.message}`);
  }
  if (activeResult.status === 'rejected') {
    console.warn(`[rental-analysis] CRMLS: Active query failed, continuing with Closed only: ${activeResult.reason.message}`);
  }

  let records = [
    ...(closedResult.status === 'fulfilled' ? closedResult.value : []),
    ...(activeResult.status === 'fulfilled' ? activeResult.value : []),
  ];

  // A box's corners are farther from center than its edges, so a box query
  // alone isn't a true radius search. On the coordinate path only: compute
  // each record's real distance where it has coordinates of its own, and
  // drop anything the box let through but that's actually beyond
  // SEARCH_RADIUS_MILES once measured on the circle. A record with no
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
      .filter(record => typeof record._distanceMiles !== 'number' || record._distanceMiles <= SEARCH_RADIUS_MILES);
  }

  const comps = records.map(record => mapComparable(record, record._distanceMiles)).filter(Boolean);

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
  };
}

module.exports = {
  pullCrmlsComps,
  mapComparable,
  extractZip,
  toDateOnly,
  buildAddress,
  assertConfigured,
  haversineMiles,
  buildBoundingBox,
  buildFilter,
  FROM_CRMLS_PROPERTY_TYPE,
  CRMLS_BASE_URL,
  SEARCH_RADIUS_MILES,
};
