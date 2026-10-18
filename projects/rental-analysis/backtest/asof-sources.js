/**
 * backtest/asof-sources.js
 * Replay handlers for the real source loop (CMA-QUALITY-SPEC.md A.2, A.3).
 *
 * lib/sources.js exports SOURCE_HANDLERS, a plain object runActiveSources()
 * reads at call time. withReplayHandlers() swaps the three live handlers for
 * the ones below, so the REAL runActiveSources() (RentCast-first ordering, the
 * combined radius ladder, chooseRadiusRung, applyCombinedRadiusTiering) runs
 * unchanged on data rebuilt "as of" a past date T. The comps these handlers
 * return are built by the real mappers (crmls.mapComparable,
 * leadsimple.mapComparable), so the test cannot drift from the product's
 * field mapping.
 *
 * What each replay handler does, mirroring its live twin:
 *   RentCast   no comps (A2, the RentCast snapshot, is not built and RentCast
 *              is never called); it only hands the subject's coordinates to
 *              the sources after it, exactly as the live RentCast geocode does.
 *   CRMLS      closed leases dated before T and within the 6-month lookback
 *              (the real closedSinceDate()), the live query's property-type
 *              and bedroom relevance, the 2-mile box, newest-first, the
 *              200-record cap, then the circle filter and the real mapper.
 *              Optional (pool.asking): listings that were already on the
 *              market at T and leased later, shown as Active at their list
 *              price, with no close price, no close date and a days-on-market
 *              measured to T.
 *   LeadSimple Rincon's own leases that started before T, whose move-in
 *              record closed before T, inside the 24-month lookback, same
 *              zip, within 2 miles, turned into comps by the product's own
 *              buildLeadSimpleComps(): the real type of each lease from the SAVED
 *              MLS evidence (backtest/rincon-mls.js) in place of the live MLS
 *              lookup, the rent screen, the Multi-Family rule, the real mapper.
 *
 * No-peeking rules (A.3), all enforced here and re-checked by the engine:
 *   1. every comp that reaches the tool carries a date before T, else THROW
 *      (assertNoFuture). The one exception is a comp planted on purpose by
 *      the leak self-test, which is marked _planted and only allowed then.
 *   2. the target is removed from every pool by listing key, by the real
 *      addressesMatch, and by "same coordinates (30 m), same bedrooms, same
 *      house number". Any record at the target's address, any date, is removed.
 *   3. nothing from the target's own record except the subject fields (type,
 *      beds, baths, sqft, address, coordinates) is passed to the tool.
 */
const sourcesLib = require('../lib/sources');
const crmls = require('../lib/crmls');
const leadsimple = require('../lib/leadsimple');
const { BEDROOM_MISMATCH_THRESHOLD } = require('../lib/weighting');
const { addressesMatch, houseNumber, normalizeAddress, unitIdentifier } = require('../lib/property-matching');
const { WIDE_SEARCH_RADIUS_MILES } = require('../lib/constants');
const { DUPLICATE_DISTANCE_METERS } = require('./constants');
const { factsFromRecord } = require('./mls-facts-ref');
const rinconMls = require('./rincon-mls');

const METERS_PER_MILE = 1609.344;
const REPLAY_SOURCE_NAMES = ['RentCast', 'CRMLS', 'LeadSimple Move-Ins'];

let CURRENT = null; // the context the handlers read: set by runWithContext()

function noonUtc(dateStr) { return new Date(`${dateStr}T12:00:00Z`); }

function monthsBeforeDate(dateStr, months) {
  const d = noonUtc(dateStr);
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromDate, toDate) {
  return Math.max(0, Math.round((noonUtc(toDate) - noonUtc(fromDate)) / 86400000));
}

// ── The no-peeking guard ─────────────────────────────────────────────────────
// Every dated field a comp carries must be strictly before T. leased_date is a
// lease close/start date, listed_date an on-market date. A comp without the
// field that matters for its status is also refused: if we cannot prove when it
// was known we cannot let it in.
function assertNoFuture(comps, T, { allowPlanted = false } = {}) {
  for (const c of comps) {
    if (c._planted) {
      if (!allowPlanted) throw new Error(`No-peeking violation: a planted (leak self-test) comp reached a normal run: ${c.address}`);
      continue;
    }
    const datedFields = [['leased_date', c.leased_date], ['listed_date', c.listed_date]];
    for (const [name, value] of datedFields) {
      if (value !== null && value !== undefined && String(value).slice(0, 10) >= T) {
        throw new Error(`No-peeking violation: comp "${c.address}" has ${name} ${value}, on or after the as-of date ${T}.`);
      }
    }
    if (c.listing_status === 'leased' && !c.leased_date) {
      throw new Error(`No-peeking violation: leased comp "${c.address}" has no lease date, so it cannot be shown to pre-date ${T}.`);
    }
    if (c.listing_status === 'active' && !c.listed_date) {
      throw new Error(`No-peeking violation: active comp "${c.address}" has no on-market date, so it cannot be shown to pre-date ${T}.`);
    }
  }
}

// ── Same-property detection (target exclusion) ───────────────────────────────
function metersBetween(lat1, lon1, lat2, lon2) {
  return crmls.haversineMiles(lat1, lon1, lat2, lon2) * METERS_PER_MILE;
}

function addressHouseNumber(address) { return houseNumber(normalizeAddress(address)); }

/**
 * True when `candidate` ({address, latitude, longitude, bedrooms, key?,
 * listingId?}) is the target itself, or a duplicate listing / relist / same
 * lease from another source, or any record at the target's address.
 *   - same ListingKey / ListingId
 *   - the real addressesMatch()
 *   - within DUPLICATE_DISTANCE_METERS, same bedrooms AND same house number,
 *     unless both addresses name different units.
 *     (The spec says "same coordinates and same bedrooms". Read literally that
 *     would also delete the next-door neighbour, 20 m away, and every other
 *     unit of the same building, which are the best comps there are. The
 *     same-house-number and different-unit conditions keep the rule to what
 *     it is for: one property under two address spellings or two listings.)
 */
function isTargetOrDuplicate(candidate, target) {
  if (candidate.key && target.key && candidate.key === target.key) return true;
  if (candidate.listingId && target.listingId && candidate.listingId === target.listingId) return true;
  if (addressesMatch(candidate.address, target.address)) return true;
  if (typeof candidate.latitude === 'number' && typeof candidate.longitude === 'number'
    && candidate.bedrooms === target.bedrooms
    && metersBetween(candidate.latitude, candidate.longitude, target.latitude, target.longitude) <= DUPLICATE_DISTANCE_METERS) {
    const a = addressHouseNumber(candidate.address), b = addressHouseNumber(target.address);
    const ua = unitIdentifier(candidate.address), ub = unitIdentifier(target.address);
    const differentUnits = ua && ub && ua !== ub;
    if (a && b && a === b && !differentUnits) return true;
  }
  return false;
}

function recordAsCandidate(r) {
  return { key: r.ListingKey, listingId: r.ListingId, address: crmls.buildAddress(r), latitude: r.Latitude, longitude: r.Longitude, bedrooms: r.BedroomsTotal };
}

function leaseRowAsCandidate(row) {
  return { key: row.id, listingId: null, address: leadsimple.buildAddress(row), latitude: row.latitude, longitude: row.longitude, bedrooms: row.bedrooms };
}

// ── Mirrors of the live CRMLS query semantics ────────────────────────────────
// buildFilter() asks Recore for: a compatible PropertySubType OR null, and
// BedroomsTotal within BEDROOM_MISMATCH_THRESHOLD - 1 of the subject's OR null.
function passesRelevance(record, { propertyType, bedrooms }) {
  const subtypes = crmls.TO_CRMLS_PROPERTY_SUBTYPES[propertyType];
  if (Array.isArray(subtypes) && subtypes.length) {
    if (record.PropertySubType != null && !subtypes.includes(record.PropertySubType)) return false;
  }
  if (typeof bedrooms === 'number') {
    const spread = BEDROOM_MISMATCH_THRESHOLD - 1;
    const lo = Math.max(0, bedrooms - spread), hi = bedrooms + spread;
    if (record.BedroomsTotal != null && !(record.BedroomsTotal >= lo && record.BedroomsTotal <= hi)) return false;
  }
  return true;
}

function inBoundingBox(record, box) {
  return typeof record.Latitude === 'number' && typeof record.Longitude === 'number'
    && record.Latitude >= box.minLat && record.Latitude <= box.maxLat
    && record.Longitude >= box.minLon && record.Longitude <= box.maxLon;
}

// Mirrors pullCrmlsComps' circle filter + mapping for a list of already
// selected raw records.
function mapRecords(records, subject) {
  return records
    .map(record => (
      typeof record.Latitude === 'number' && typeof record.Longitude === 'number'
        ? { record, distance: crmls.haversineMiles(subject.latitude, subject.longitude, record.Latitude, record.Longitude) }
        : { record, distance: undefined }
    ))
    .filter(({ distance }) => typeof distance !== 'number' || distance <= WIDE_SEARCH_RADIUS_MILES)
    .map(({ record, distance }) => {
      const comp = crmls.mapComparable(record, distance);
      if (comp) comp._mls = factsFromRecord(record); // transient, like the spec's _remarks: never stored
      return comp;
    })
    .filter(Boolean);
}

// ── Pool selection for the CRMLS handler ─────────────────────────────────────
function closedSinceFor(T, months) {
  return months === crmls.CRMLS_CLOSED_LOOKBACK_MONTHS ? crmls.closedSinceDate(noonUtc(T)) : monthsBeforeDate(T, months);
}

function selectClosed(world, ctx, subject) {
  const { T, target, pool } = ctx;
  const box = crmls.buildBoundingBox(subject.latitude, subject.longitude, WIDE_SEARCH_RADIUS_MILES);
  const since = closedSinceFor(T, pool.mlsMonths);
  const rel = { propertyType: subject.propertyType, bedrooms: subject.bedrooms };
  const out = [];
  // world.closed is sorted newest CloseDate first (ties by ListingKey).
  for (const r of world.closed) {
    const d = r.CloseDate;
    if (!d || d >= T) continue;            // not yet closed at T: unknown at T
    if (d < since) break;                  // older than the lookback (and so is everything after)
    // A few records (11 of 4,286) were entered in the MLS AFTER the lease closed
    // (on-market date later than close date). The live tool could not have seen
    // such a record at T, so it is not knowable at T either.
    const listed = (r.OnMarketDate || r.ListingContractDate || '').slice(0, 10);
    if (listed && listed >= T) continue;
    if (!inBoundingBox(r, box) || !passesRelevance(r, rel)) continue;
    if (isTargetOrDuplicate(recordAsCandidate(r), target)) continue;
    out.push(r);
    if (out.length >= crmls.MAX_RECORDS_PER_STATUS) break; // the live query's $top cap
  }
  return out;
}

// Listings that were on the market at T and leased later. world.asking is
// sorted newest on-market date first. The record is rewritten so the real
// mapper sees what the live feed showed at T: an Active listing at its list
// price, no close price, no close date.
function selectAsking(world, ctx, subject) {
  const { T, target, pool } = ctx;
  const box = crmls.buildBoundingBox(subject.latitude, subject.longitude, WIDE_SEARCH_RADIUS_MILES);
  const rel = { propertyType: subject.propertyType, bedrooms: subject.bedrooms };
  const out = [];
  for (const r of world.asking) {
    const listed = (r.OnMarketDate || r.ListingContractDate || '').slice(0, 10);
    if (!listed || listed >= T) continue;       // not yet on the market at T
    if (!r.CloseDate || r.CloseDate < T) continue; // already leased before T: it is a closed comp, not asking
    if (!inBoundingBox(r, box) || !passesRelevance(r, rel)) continue;
    if (isTargetOrDuplicate(recordAsCandidate(r), target)) continue;
    // Original list price by default (the final price may include cuts made after T);
    // fall back to the list price when the original is missing or not a positive number.
    const useOriginal = pool.askingPrice !== 'final' && typeof r.OriginalListPrice === 'number' && r.OriginalListPrice > 0;
    const price = useOriginal ? r.OriginalListPrice : r.ListPrice;
    out.push({
      ...r,
      StandardStatus: 'Active',
      ListPrice: price,
      ClosePrice: null,
      CloseDate: null,
      DaysOnMarket: daysBetween(listed, T),
    });
    if (out.length >= crmls.MAX_RECORDS_PER_STATUS) break;
  }
  return out;
}

function planLeak(ctx, subject) {
  const { target, pool } = ctx;
  if (!pool.plantLeak) return [];
  if (target.kind === 'rincon' && target.row) {
    // The signed lease itself, mapped by the real LeadSimple mapper, at distance 0, with the same type the test gave the target.
    const comp = leadsimple.mapComparable(target.row, 0, target.propertyType, target.typeSource);
    if (!comp) return [];
    comp._planted = true;
    return [comp];
  }
  if (!target.record) return [];
  const copies = Math.max(1, pool.plantLeak);
  const planted = [];
  for (let k = 0; k < copies; k++) {
    // Copies other than the first get their own house number so dedupeComps()
    // cannot fold them back into one comp.
    const rec = { ...target.record, ...(k === 0 ? {} : { StreetNumberNumeric: 90000 + k, ListingKey: `${target.key}-leak-${k}`, ListingId: null }) };
    const comp = mapRecords([rec], subject)[0];
    if (comp) { comp._planted = true; planted.push(comp); }
  }
  return planted;
}

function crmlsHandler(world) {
  return async function replayCrmls(subject) {
    const ctx = CURRENT;
    if (typeof subject.latitude !== 'number' || typeof subject.longitude !== 'number') {
      throw new Error('Replay CRMLS handler: the subject has no coordinates (the RentCast replay should have supplied them).');
    }
    let records = selectClosed(world, ctx, subject);
    let comps = mapRecords(records, subject);
    if (ctx.pool.asking) comps = comps.concat(mapRecords(selectAsking(world, ctx, subject), subject));
    comps = ctx.method && ctx.method.keep ? comps.filter(c => ctx.method.keep(c, ctx.subjectFacts)) : comps;
    comps = comps.concat(planLeak(ctx, subject)); // never filtered by a method: the leak must reach the pool
    return { comps, subjectEstimatedRent: null, subjectLatitude: null, subjectLongitude: null, subjectZip: crmls.extractZip(subject.address) };
  };
}

function leadsimpleHandler(world) {
  // The product looks each lease's real type up in the MLS while an analysis runs. The replay never touches the network, so
  // the same answers are read from the saved evidence instead (backtest/rincon-mls.js) and handed to the SAME function the
  // product calls. A world with no evidence (an older saved data folder) gets no lookup at all: every type from LeadSimple's label.
  const lookup = world.rinconMls ? rinconMls.evidenceLookup(world.rinconMls) : null;
  return async function replayLeadSimple(subject) {
    const ctx = CURRENT;
    const { T, target, pool } = ctx;
    const zip = crmls.extractZip(subject.address);
    if (!zip) return { comps: [], subjectEstimatedRent: null, subjectLatitude: null, subjectLongitude: null, subjectZip: null };
    const cutoff = monthsBeforeDate(T, pool.rinconMonths);
    const rows = world.leadsimple.filter(row => {
      if (row.zip_code !== zip) return false;                       // the live query is zip-scoped
      const start = typeof row.lease_start_date === 'string' ? row.lease_start_date.slice(0, 10) : null;
      const closedAt = typeof row.closed_at === 'string' ? row.closed_at.slice(0, 10) : null;
      if (!start || start >= T) return false;                        // had not started yet at T
      if (closedAt && closedAt >= T) return false;                   // the move-in record did not exist yet at T
      if (!closedAt || closedAt < cutoff) return false;              // outside the lookback (live filter is on closed_at)
      return !isTargetOrDuplicate(leaseRowAsCandidate(row), target);
    });
    const hasSubjectCoords = typeof subject.latitude === 'number' && typeof subject.longitude === 'number';
    let selected;
    if (hasSubjectCoords) {
      selected = rows
        .map(row => {
          const hasRowCoords = typeof row.latitude === 'number' && typeof row.longitude === 'number';
          return { row, distanceMiles: hasRowCoords ? crmls.haversineMiles(subject.latitude, subject.longitude, row.latitude, row.longitude) : null };
        })
        .filter(({ distanceMiles }) => distanceMiles === null || distanceMiles <= WIDE_SEARCH_RADIUS_MILES);
    } else {
      selected = rows.map(row => ({ row, distanceMiles: null }));
    }
    let { comps } = await leadsimple.buildLeadSimpleComps(selected, subject, { lookup, log: null });
    comps = ctx.method && ctx.method.keep ? comps.filter(c => ctx.method.keep(c, ctx.subjectFacts)) : comps;
    return { comps, subjectEstimatedRent: null, subjectLatitude: null, subjectLongitude: null, subjectZip: zip };
  };
}

function rentcastHandler() {
  return async function replayRentCast(subject) {
    const ctx = CURRENT;
    return {
      comps: [], // RentCast as-of (A2) is not built: no RentCast data, no RentCast request
      subjectEstimatedRent: null,
      subjectLatitude: ctx.target.latitude,
      subjectLongitude: ctx.target.longitude,
      subjectZip: crmls.extractZip(subject.address),
    };
  };
}

// Prepares a world from raw arrays: sorted copies the selectors rely on.
function createWorld({ closed, leadsimple: leaseRows = [], properties = [], rinconMls: rinconTypeEvidence = null }) {
  const byCloseDesc = [...closed].sort((a, b) => (a.CloseDate < b.CloseDate ? 1 : a.CloseDate > b.CloseDate ? -1 : a.ListingKey < b.ListingKey ? -1 : 1));
  const listedOf = r => (r.OnMarketDate || r.ListingContractDate || '').slice(0, 10);
  const asking = closed
    .filter(r => listedOf(r) && r.CloseDate)
    .sort((a, b) => (listedOf(a) < listedOf(b) ? 1 : listedOf(a) > listedOf(b) ? -1 : a.ListingKey < b.ListingKey ? -1 : 1));
  return { closed: byCloseDesc, asking, leadsimple: leaseRows, properties, rinconMls: rinconTypeEvidence };
}

/**
 * Runs `fn` with the replay handlers installed in the real SOURCE_HANDLERS and
 * restores the live ones afterwards, even on error.
 */
async function withReplayHandlers(world, fn) {
  const original = {};
  for (const name of REPLAY_SOURCE_NAMES) original[name] = sourcesLib.SOURCE_HANDLERS[name];
  sourcesLib.SOURCE_HANDLERS.RentCast = rentcastHandler();
  sourcesLib.SOURCE_HANDLERS.CRMLS = crmlsHandler(world);
  sourcesLib.SOURCE_HANDLERS['LeadSimple Move-Ins'] = leadsimpleHandler(world);
  try {
    return await fn();
  } finally {
    for (const name of REPLAY_SOURCE_NAMES) sourcesLib.SOURCE_HANDLERS[name] = original[name];
  }
}

function setContext(ctx) { CURRENT = ctx; }
function clearContext() { CURRENT = null; }

module.exports = {
  REPLAY_SOURCE_NAMES, assertNoFuture, isTargetOrDuplicate, recordAsCandidate, leaseRowAsCandidate,
  passesRelevance, inBoundingBox, mapRecords, selectClosed, selectAsking, closedSinceFor,
  crmlsHandler, leadsimpleHandler, rentcastHandler, createWorld, withReplayHandlers, setContext, clearContext,
  daysBetween, monthsBeforeDate, noonUtc,
};
