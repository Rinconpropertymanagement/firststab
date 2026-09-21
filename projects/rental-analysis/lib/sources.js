/**
 * lib/sources.js
 * Dispatches to a per-source comp-pulling handler, keyed by
 * rental_comp_sources.name, and runs every currently-active source for one
 * analysis. 'RentCast' and 'CRMLS' both have real handlers now. Adding
 * another source later means writing one new lib/<source>.js file and
 * adding one line to SOURCE_HANDLERS below — nothing else about this loop,
 * or the endpoint that calls it, changes.
 *
 * Confirmed live against the real rental_comp_sources table: Zillow is
 * seeded is_active = FALSE. The FlexMLS placeholder row was renamed to
 * CRMLS and activated (is_active = TRUE) once real Recore/CRMLS access was
 * confirmed — see the migration that did that and lib/crmls.js. Zillow's
 * public API is confirmed dead (retired 2021; its replacement is a gated
 * business product with no comp-listing data) — there's no handler for it
 * here and none is planned. If Zillow's row is ever manually flipped to
 * is_active = true without a handler being added, every run will log a
 * harmless "no handler for Zillow" warning below and just skip it — it
 * will not fail the analysis (see runActiveSources()).
 */

const { pullRentCastComps } = require('./rentcast');
const { pullCrmlsComps } = require('./crmls');
const { pullLeadSimpleComps } = require('./leadsimple');
const { NARROW_SEARCH_RADIUS_MILES, MIN_COMPS_FOR_NARROW_RADIUS } = require('./constants');
const { exclusionReason } = require('./weighting');

const SOURCE_HANDLERS = {
  RentCast: pullRentCastComps,
  CRMLS: pullCrmlsComps,
  // Real, confirmed-current new-tenant leases from Rincon's own portfolio —
  // seeded is_active=FALSE (see the migration) until TARS confirms real
  // comps flow end-to-end; see LEADSIMPLE-COMP-SOURCE-SPEC.md and
  // lib/leadsimple.js. This exact name must match the rental_comp_sources
  // row's name AND lib/weighting.js's SELF_SOURCED_TRUSTED_SOURCE_NAMES —
  // all three are load-bearing on the identical string.
  'LeadSimple Move-Ins': pullLeadSimpleComps,
  // Zillow: no handler, and none planned — see NOTE above.
};

/**
 * Makes the one combined narrow/wide radius decision, after every active
 * source has already reported back — see CROSS-SOURCE-RADIUS-SPEC.md. Before
 * this existed, each source (lib/rentcast.js, lib/crmls.js,
 * lib/leadsimple.js) decided for itself whether IT individually had enough
 * close comps to narrow to NARROW_SEARCH_RADIUS_MILES, which let one source
 * widen to WIDE_SEARCH_RADIUS_MILES on its own even though the others
 * already had plenty of close comps (the confirmed real bug: RentCast alone
 * found 4 solid comps within 1 mile; CRMLS alone found only 1 and widened,
 * pulling in condos 1.7-1.9 miles away onto a report for a single-family
 * home). Every source now always returns everything it found out to
 * WIDE_SEARCH_RADIUS_MILES (no source's network call changes) and this
 * function decides once, on the full merged list.
 *
 * REVISION (2026-09-20, see CROSS-SOURCE-RADIUS-SPEC.md "Revision" section):
 * the original version of this function cut EVERY comp beyond 1 mile once
 * the combined pool had enough close comps — with no exception for a far
 * comp that was actually a good match. TARS caught this live on the real
 * 5537 Rainier Street analysis: it correctly removed the motivating bug
 * (wrong-type condos 1.7-1.9mi away) but ALSO removed two genuine same-type
 * comps beyond 1 mile (1148 Colina Vista, 1.10mi, leased $5,650; 7275
 * Coolidge Street, 1.47mi, leased $4,195) that were real contributors to the
 * recommended range, collapsing a $1,452.50 spread down to ~$100. The
 * corrected rule below: distance only ever disqualifies a comp that is ALSO
 * not a genuine match on its own merits (exclusionReason() !== null). A
 * genuine match (exclusionReason() === null) is never cut for being far
 * away, at any distance (known, unknown, or beyond 1mi) — it survives
 * exactly as if this function didn't exist, all the way to the 2-mile bound
 * each source already enforces.
 *
 * A comp counts toward the MIN_COMPS_FOR_NARROW_RADIUS threshold only when
 * it's a genuine match (exclusionReason() === null) AND has a real
 * distance_miles within NARROW_SEARCH_RADIUS_MILES — reuses
 * lib/weighting.js's exclusionReason() rather than reimplementing its
 * property-type/bedroom logic, and reuses the exact same check to decide
 * which comps are even eligible to be cut by distance (see spec judgment
 * call #4 — these must be the same check, not two differently-defined ones).
 * (is_rincon_managed is never set yet at this point in the pipeline —
 * server.js only sets it after runActiveSources() returns — so that branch
 * of exclusionReason() can't fire here; that's expected, not a gap, since
 * excludeRinconManaged() is fully re-applied downstream regardless of which
 * comps survive this step.)
 *
 * Does not deduplicate the same real address reported by two different
 * sources before counting toward the threshold — that's dedupeComps()'s job
 * later in server.js, which needs is_rincon_managed and isn't available yet
 * here either. A deliberate scope decision (see spec), not an oversight.
 *
 * @param {object[]} comps - the full merged list every active source returned
 * @param {object} subject - {..., bedrooms, propertyType} — same subject runActiveSources() receives
 * @returns {object[]}
 */
function applyCombinedRadiusTiering(comps, subject) {
  const isGenuineMatch = c => exclusionReason(c, subject.bedrooms, subject.propertyType) === null;
  const isNearby = c => typeof c.distance_miles === 'number' && c.distance_miles <= NARROW_SEARCH_RADIUS_MILES;

  const genuineNearbyCount = comps.filter(c => isGenuineMatch(c) && isNearby(c)).length;

  return comps.filter(c => isGenuineMatch(c) || genuineNearbyCount < MIN_COMPS_FOR_NARROW_RADIUS || isNearby(c));
}

/**
 * Runs every active source's handler against the subject property and
 * merges the results. A source that's active in the DB but has no handler
 * yet is logged and skipped rather than treated as fatal — the analysis
 * still runs on whichever sources are actually implemented. A source whose
 * handler throws (e.g. RentCast with no API key configured) is likewise
 * caught and recorded rather than crashing the whole run — the caller
 * decides whether "zero usable comps" should fail the analysis.
 *
 * RentCast runs first whenever it's active, ahead of every other source —
 * not for independence (the module comment above is about that), but
 * because RentCast already reliably geocodes the subject as a side effect
 * of its own AVM call, and CRMLS's handler now uses that lat/long (when
 * available) to run a true radius search instead of a zip-only one — see
 * lib/crmls.js. Each processed source's own subjectLatitude/subjectLongitude
 * feeds an `enrichedSubject` passed to every handler from that point on
 * (first non-null wins, same rule as this function's own return value
 * below), so a still-to-run handler can use coordinates a prior one found.
 * If RentCast is inactive or fails, enrichedSubject simply never gets
 * lat/long — CRMLS degrades to its existing zip-only behavior, never throws
 * over it.
 *
 * @param {object[]} activeSources - rows from rental_comp_sources where is_active = true (need at least {id, name})
 * @param {object} subject - {address, propertyType, bedrooms, bathrooms, sqft}
 * @returns {Promise<{comps: object[], subjectEstimatedRent: number|null, subjectLatitude: number|null, subjectLongitude: number|null, subjectZip: string|null, sourcesUsed: string[], sourceErrors: {name: string, error: string}[]}>}
 */
async function runActiveSources(activeSources, subject) {
  const allComps = [];
  const sourcesUsed = [];
  const sourceErrors = [];
  let subjectEstimatedRent = null;
  let subjectLatitude = null;
  let subjectLongitude = null;
  let subjectZip = null;

  // RentCast first (when present), everything else after in its original
  // relative order — a stable partition, not a full re-sort.
  const orderedSources = [
    ...activeSources.filter(s => s.name === 'RentCast'),
    ...activeSources.filter(s => s.name !== 'RentCast'),
  ];

  const enrichedSubject = { ...subject };

  for (const source of orderedSources) {
    const handler = SOURCE_HANDLERS[source.name];
    if (!handler) {
      console.warn(`[rental-analysis] No handler implemented yet for active source "${source.name}" — skipping.`);
      continue;
    }
    try {
      const result = await handler(enrichedSubject);
      const comps = (result.comps || []).map(c => ({
        ...c,
        source_id: source.id,
        source_name: source.name, // stripped before insert — kept here only for logging/debugging
      }));
      allComps.push(...comps);
      sourcesUsed.push(source.name);
      if (subjectEstimatedRent === null && typeof result.subjectEstimatedRent === 'number') {
        subjectEstimatedRent = result.subjectEstimatedRent;
      }
      if (subjectLatitude === null && typeof result.subjectLatitude === 'number') {
        subjectLatitude = result.subjectLatitude;
      }
      if (subjectLongitude === null && typeof result.subjectLongitude === 'number') {
        subjectLongitude = result.subjectLongitude;
      }
      if (subjectZip === null && typeof result.subjectZip === 'string') {
        subjectZip = result.subjectZip;
      }
      // Feed forward to any handler still to run, same first-non-null-wins rule.
      if (enrichedSubject.latitude == null && typeof result.subjectLatitude === 'number') {
        enrichedSubject.latitude = result.subjectLatitude;
      }
      if (enrichedSubject.longitude == null && typeof result.subjectLongitude === 'number') {
        enrichedSubject.longitude = result.subjectLongitude;
      }
    } catch (err) {
      console.error(`[rental-analysis] Source "${source.name}" failed:`, err.message);
      sourceErrors.push({ name: source.name, error: err.message });
    }
  }

  return { comps: applyCombinedRadiusTiering(allComps, subject), subjectEstimatedRent, subjectLatitude, subjectLongitude, subjectZip, sourcesUsed, sourceErrors };
}

module.exports = { SOURCE_HANDLERS, applyCombinedRadiusTiering, runActiveSources };
