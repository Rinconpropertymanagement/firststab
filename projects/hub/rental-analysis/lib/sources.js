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

  return { comps: allComps, subjectEstimatedRent, subjectLatitude, subjectLongitude, subjectZip, sourcesUsed, sourceErrors };
}

module.exports = { SOURCE_HANDLERS, runActiveSources };
