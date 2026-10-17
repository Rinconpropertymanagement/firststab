/**
 * backtest/targets.js
 * Builds the leases the test tries to predict (CMA-QUALITY-SPEC.md A.4) and the
 * walk-forward split (A.5). Pure functions over plain arrays: nothing here
 * reads files, the network or the clock (the caller passes "today").
 *
 *   MLS targets    closed CRMLS leases inside the county box that pass the
 *                  protocol's usability screen and are like-for-like (not
 *                  furnished, month-to-month, 6-month or 55+), closed on or
 *                  after the target-from date and not in the future.
 *   Rincon targets leadsimple_new_leases single-home leases started in the
 *                  last 12 months, after the plausibility screen.
 *
 * A target is the plain record the test needs (address, type, beds, size,
 * coordinates, start date T, signed rent). The signed rent is the answer key;
 * it must never reach the code that estimates (the engine passes only the
 * subject fields to runActiveSources and keeps rent for scoring).
 */
const { FROM_CRMLS_PROPERTY_TYPE, buildAddress: buildCrmlsAddress } = require('../lib/crmls');
const { buildAddress: buildLeadSimpleAddress, FROM_LEADSIMPLE_PROPERTY_TYPE } = require('../lib/leadsimple');
const { COUNTY_BOX, CORE_BOX, USABLE, USABLE_TARGET_TYPES, RINCON, HOLDOUT_MONTHS } = require('./constants');
const { isLikeForLikeTarget } = require('./mls-facts-ref');

function inBox(lat, lon, box) {
  return typeof lat === 'number' && typeof lon === 'number'
    && lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon;
}

function areaOf(lat, lon) {
  if (inBox(lat, lon, CORE_BOX)) return 'core';
  if (inBox(lat, lon, COUNTY_BOX)) return 'county';
  return null;
}

// 'YYYY-MM-DD' minus N calendar months (day clamped by Date; used for lookback periods,
// where a one-day edge case is irrelevant).
function monthsBefore(dateStr, months) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

function isUsableMlsRecord(r) {
  const type = FROM_CRMLS_PROPERTY_TYPE[r.PropertySubType];
  return USABLE_TARGET_TYPES.includes(type)
    && typeof r.ClosePrice === 'number' && r.ClosePrice >= USABLE.minRent && r.ClosePrice <= USABLE.maxRent
    && typeof r.BedroomsTotal === 'number' && r.BedroomsTotal >= 0
    && typeof r.LivingArea === 'number' && r.LivingArea > 0
    && typeof r.Latitude === 'number' && typeof r.Longitude === 'number'
    && typeof r.CloseDate === 'string';
}

function mlsTargetFromRecord(r) {
  return {
    kind: 'mls',
    key: r.ListingKey,
    listingId: r.ListingId || null,
    date: r.CloseDate.slice(0, 10),
    address: buildCrmlsAddress(r),
    city: r.City || null,
    zip: r.PostalCode || null,
    propertyType: FROM_CRMLS_PROPERTY_TYPE[r.PropertySubType],
    bedrooms: r.BedroomsTotal,
    bathrooms: typeof r.BathroomsTotalDecimal === 'number' ? r.BathroomsTotalDecimal : 0,
    sqft: r.LivingArea,
    latitude: r.Latitude,
    longitude: r.Longitude,
    rent: r.ClosePrice,
    area: areaOf(r.Latitude, r.Longitude),
    record: r, // the raw CRMLS record: used only to exclude the target from pools and by the leak self-test
  };
}

/**
 * @param {object[]} closedRecords - raw Recore closed-lease records
 * @param {{targetFrom: string, today: string}} opts - closed on or after targetFrom, not after today
 */
function buildMlsTargets(closedRecords, { targetFrom, today }) {
  return closedRecords
    .filter(r => isUsableMlsRecord(r)
      && inBox(r.Latitude, r.Longitude, COUNTY_BOX)
      && r.CloseDate.slice(0, 10) >= targetFrom
      && r.CloseDate.slice(0, 10) <= today
      && isLikeForLikeTarget(r))
    .map(mlsTargetFromRecord)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.key < b.key ? -1 : 1));
}

/**
 * Rincon single-home leases (A.4): started in the last RINCON.lookbackMonths,
 * rent and rent-per-sq-ft plausible, sq ft / bedrooms / coordinates known.
 * Returns { targets, screenedOut } where screenedOut counts why rows left.
 */
function buildRinconTargets(leadsimpleRows, { today }) {
  const since = monthsBefore(today, RINCON.lookbackMonths);
  const screenedOut = { notSingleHome: 0, tooOld: 0, notYetStarted: 0, rentOutOfRange: 0, rentPerSqftOutOfRange: 0, missingFacts: 0 };
  const targets = [];
  for (const row of leadsimpleRows) {
    if (!RINCON.singleHomeTypes.includes(row.property_type)) { screenedOut.notSingleHome++; continue; }
    const start = typeof row.lease_start_date === 'string' ? row.lease_start_date.slice(0, 10) : null;
    if (!start || start < since) { screenedOut.tooOld++; continue; }
    if (start > today) { screenedOut.notYetStarted++; continue; }
    const rent = Number(row.rent);
    if (!(rent >= RINCON.minRent && rent <= RINCON.maxRent)) { screenedOut.rentOutOfRange++; continue; }
    if (!(row.sqft > 0) || typeof row.bedrooms !== 'number' || typeof row.latitude !== 'number' || typeof row.longitude !== 'number') { screenedOut.missingFacts++; continue; }
    const perSqft = rent / row.sqft;
    if (!(perSqft >= RINCON.minRentPerSqft && perSqft <= RINCON.maxRentPerSqft)) { screenedOut.rentPerSqftOutOfRange++; continue; }
    targets.push({
      kind: 'rincon',
      key: row.id,
      listingId: null,
      date: start,
      address: buildLeadSimpleAddress(row),
      city: row.city || null,
      zip: row.zip_code || null,
      propertyType: FROM_LEADSIMPLE_PROPERTY_TYPE[row.property_type] || 'single_family',
      bedrooms: row.bedrooms,
      bathrooms: typeof row.bathrooms === 'number' ? row.bathrooms : 0,
      sqft: row.sqft,
      latitude: row.latitude,
      longitude: row.longitude,
      rent,
      area: areaOf(row.latitude, row.longitude),
      row, // the raw lease row: used only to exclude the target from pools and by the leak self-test
    });
  }
  targets.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.key < b.key ? -1 : 1));
  return { targets, screenedOut };
}

/**
 * For the opt-in --asof-listing run: the same MLS targets, but standing on the
 * day each home went on the market instead of the day before it closed (staff
 * price a home at listing time). A lease whose record has no on-market date, or
 * whose on-market date is not before its close date (entered after the fact),
 * has no listing-time view and is left out of BOTH columns, as is a lease listed
 * before `notBefore` (the saved data starts too late to give it a full lookback).
 * @returns {{targets: object[], skipped: number, tooEarly: number, medianGapDays: number|null}}
 */
function listingTimeTargets(targets, { notBefore = null } = {}) {
  const out = [];
  const gaps = [];
  let skipped = 0, tooEarly = 0;
  for (const t of targets) {
    const r = t.record || {};
    const listed = (r.OnMarketDate || r.ListingContractDate || '').slice(0, 10);
    if (t.kind !== 'mls' || !listed || listed >= t.date) { skipped++; continue; }
    // Listed so long ago that the saved data cannot supply a full lookback before that day: left out.
    if (notBefore && listed < notBefore) { skipped++; tooEarly++; continue; }
    out.push({ ...t, asOf: listed });
    gaps.push(Math.round((new Date(`${t.date}T12:00:00Z`) - new Date(`${listed}T12:00:00Z`)) / 86400000));
  }
  gaps.sort((a, b) => a - b);
  const m = Math.floor(gaps.length / 2);
  const medianGapDays = gaps.length ? (gaps.length % 2 ? gaps[m] : (gaps[m - 1] + gaps[m]) / 2) : null;
  return { targets: out, skipped, tooEarly, medianGapDays };
}

// A.5: the newest HOLDOUT_MONTHS of targets are the hold-out; everything older
// is the tune period. The split date is derived from the newest target so the
// monthly run always judges the latest three months.
function holdoutStartFor(targets, months = HOLDOUT_MONTHS) {
  if (!targets.length) return null;
  const newest = targets.reduce((m, t) => (t.date > m ? t.date : m), targets[0].date);
  return monthsBefore(newest, months);
}

function splitWalkForward(items, holdoutStart, dateOf = x => x.date) {
  const tune = [], holdout = [];
  for (const it of items) (dateOf(it) >= holdoutStart ? holdout : tune).push(it);
  return { tune, holdout };
}

module.exports = {
  inBox, areaOf, monthsBefore, isUsableMlsRecord, mlsTargetFromRecord,
  buildMlsTargets, buildRinconTargets, listingTimeTargets, holdoutStartFor, splitWalkForward,
};
