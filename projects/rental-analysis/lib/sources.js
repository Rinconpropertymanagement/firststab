/**
 * lib/sources.js
 * Dispatches to a per-source comp-pulling handler, keyed by
 * rental_comp_sources.name, and runs every currently-active source for one
 * analysis. Only 'RentCast' has a real handler today. Adding a real source
 * later means writing one new lib/<source>.js file and adding one line to
 * SOURCE_HANDLERS below — nothing else about this loop, or the endpoint
 * that calls it, changes.
 *
 * Confirmed live against the real rental_comp_sources table: Zillow and
 * FlexMLS are both seeded is_active = FALSE (RentCast is the only one seeded
 * TRUE). Zillow's public API is confirmed dead (retired 2021; its
 * replacement is a gated business product with no comp-listing data) —
 * there's no handler for it here and none is planned. If Zillow's row is
 * ever manually flipped to is_active = true without a handler being added,
 * every run will log a harmless "no handler for Zillow" warning below and
 * just skip it — it will not fail the analysis (see runActiveSources()).
 */

const { pullRentCastComps } = require('./rentcast');

const SOURCE_HANDLERS = {
  RentCast: pullRentCastComps,
  // Zillow: no handler, and none planned — see NOTE above.
  // FlexMLS: not implemented yet — CRMLS/Trestle access request still pending.
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

  for (const source of activeSources) {
    const handler = SOURCE_HANDLERS[source.name];
    if (!handler) {
      console.warn(`[rental-analysis] No handler implemented yet for active source "${source.name}" — skipping.`);
      continue;
    }
    try {
      const result = await handler(subject);
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
    } catch (err) {
      console.error(`[rental-analysis] Source "${source.name}" failed:`, err.message);
      sourceErrors.push({ name: source.name, error: err.message });
    }
  }

  return { comps: allComps, subjectEstimatedRent, subjectLatitude, subjectLongitude, subjectZip, sourcesUsed, sourceErrors };
}

module.exports = { SOURCE_HANDLERS, runActiveSources };
