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
const { RADIUS_LADDER_MILES, MIN_COMPS_FOR_NARROW_RADIUS, MIN_LEASED_COMPS_FOR_NARROW_RADIUS } = require('./constants');
const { exclusionReason, subjectExtrasFrom } = require('./weighting');
const { dedupeComps, dropSubjectsOwnListing } = require('./property-matching');
const { mergeMlsFacts } = require('./mls-facts');

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
 * Picks how far out the comp search should reach — the radius ladder. Walks
 * RADIUS_LADDER_MILES (0.5, 1, 1.5, then WIDE_SEARCH_RADIUS_MILES) in
 * ascending order over the full merged list every active source returned and
 * stops at the first rung with enough solid evidence: at least
 * MIN_COMPS_FOR_NARROW_RADIUS genuine comps AND at least
 * MIN_LEASED_COMPS_FOR_NARROW_RADIUS of them confirmed leases. If no rung
 * qualifies it returns the last rung (the 2-mile ceiling).
 *
 * At each rung r, the candidates are the comps that are:
 *   - a genuine match on their own merits (exclusionReason() === null, the
 *     same check lib/weighting.js uses to zero-weight a comp, INCLUDING the
 *     square-footage band and the furnished / short-term / 55+ rules: a comp
 *     those rules leave out is not "genuine", so it does not count toward the
 *     "at least 4 genuine and 2 leased" that lets the search stop at a rung), and
 *   - have a real numeric distance_miles <= r (exactly r counts).
 * Those candidates are then run through dedupeComps(), so the count is of
 * distinct addresses, not rows. That matters: the RentCast listings search
 * overlaps CRMLS and RentCast's own similar-rentals list heavily, and without
 * it one property seen by two sources would count twice. When two copies of
 * one address collide, dedupeComps() keeps the higher-weight one, so a CRMLS
 * or LeadSimple 'leased' copy beats a RentCast 'off_market' copy and the
 * address counts once, as leased. Comps with no address are never merged.
 * "Leased" means a CRMLS Closed or LeadSimple Move-Ins comp — RentCast can
 * never produce one (its Inactive is never mapped to 'leased').
 *
 * (is_rincon_managed is never set yet at this point in the pipeline —
 * server.js/router.js only set it after runActiveSources() returns — so that
 * branch of exclusionReason() can't fire here. Rincon-managed comps are
 * therefore still counted by the ladder and only excluded later from the
 * range math. A known, documented limitation, not a gap.)
 *
 * @param {object[]} comps - the full merged list every active source returned
 * @param {object} subject - {..., bedrooms, propertyType} — same subject runActiveSources() receives
 * @returns {{rung: number, genuineCount: number, leasedCount: number}} the counts are those at the returned rung
 */
function chooseRadiusRung(comps, subject) {
  let genuineCount = 0;
  let leasedCount = 0;
  const extras = subjectExtrasFrom(subject);
  for (const rung of RADIUS_LADDER_MILES) {
    const candidates = comps.filter(c =>
      exclusionReason(c, subject.bedrooms, subject.propertyType, extras) === null &&
      typeof c.distance_miles === 'number' &&
      c.distance_miles <= rung
    );
    const unique = dedupeComps(candidates, subject.bedrooms, subject.propertyType, extras);
    genuineCount = unique.length;
    leasedCount = unique.filter(c => c.listing_status === 'leased').length;
    if (genuineCount >= MIN_COMPS_FOR_NARROW_RADIUS && leasedCount >= MIN_LEASED_COMPS_FOR_NARROW_RADIUS) {
      return { rung, genuineCount, leasedCount };
    }
  }
  return { rung: RADIUS_LADDER_MILES[RADIUS_LADDER_MILES.length - 1], genuineCount, leasedCount };
}

/**
 * Applies the radius ladder (see chooseRadiusRung() above) once, after every
 * active source has already reported back — see CROSS-SOURCE-RADIUS-SPEC.md
 * for why this is a single combined decision rather than one per source, and
 * COMP-COVERAGE-SPEC.md for the ladder itself. Every source always returns
 * everything it found out to WIDE_SEARCH_RADIUS_MILES (no source's network
 * call changes); this function then keeps only what falls inside the rung
 * chosen.
 *
 * A comp is kept when:
 *   - it has a numeric distance_miles <= the chosen rung, whether or not it
 *     is a genuine match (a non-genuine comp inside the rung stays visible
 *     and shows as "not used", same as before); or
 *   - it has no numeric distance AND the chosen rung is the ceiling (the
 *     last rung) — nothing was verified closer, and sources already bound
 *     everything to the ceiling. A comp with no distance is dropped whenever
 *     a narrower rung is chosen, since it cannot be shown to be inside it.
 * Everything else — genuine or not — beyond the chosen rung is dropped. When
 * there are no numeric distances at all (RentCast failed, CRMLS on its zip
 * fallback) no rung qualifies, the ceiling is chosen, and every comp is kept.
 *
 * REVISION (2026-10-14, COMP-COVERAGE-SPEC.md): this deliberately replaces
 * the 2026-09-20 rule that a genuine match is never cut for distance. That
 * rule existed because the earlier plain 1-mile cut deleted 5537 Rainier
 * Street's two best leases (1148 Colina Vista, 1.10mi; 7275 Coolidge Street,
 * 1.47mi) when the area had no confirmed leases inside 1 mile. The ladder
 * cannot stop at a rung unless that rung already holds at least
 * MIN_COMPS_FOR_NARROW_RADIUS genuine comps with at least
 * MIN_LEASED_COMPS_FOR_NARROW_RADIUS confirmed leases, so a far genuine comp
 * is only dropped when real lease evidence already sits closer. Where that
 * evidence isn't there, the ladder widens (Rainier stops at 1.5mi and keeps
 * both) or falls back to the full 2 miles.
 *
 * @param {object[]} comps - the full merged list every active source returned
 * @param {object} subject - {..., bedrooms, propertyType} — same subject runActiveSources() receives
 * @returns {object[]}
 */
function applyCombinedRadiusTiering(comps, subject) {
  const { rung, genuineCount, leasedCount } = chooseRadiusRung(comps, subject);
  const isCeiling = rung === RADIUS_LADDER_MILES[RADIUS_LADDER_MILES.length - 1];
  const kept = comps.filter(c =>
    typeof c.distance_miles === 'number' ? c.distance_miles <= rung : isCeiling
  );
  console.log(`[rental-analysis] Radius ladder: stopped at ${rung} mi (genuine=${genuineCount}, leased=${leasedCount}); kept ${kept.length} of ${comps.length} comps.`);
  return kept;
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
 * @param {object} subject - {address, propertyType, bedrooms, bathrooms, sqft, furnished, leaseTermMonths, ageRestricted} — the last four feed the size and MLS-fact rules; any may be missing, which switches that rule off
 * A source that answered but could not load part of what it searches (RentCast's listings
 * search failing after its similar-rentals list worked, CRMLS losing its Closed or its Active
 * half) reports it in its result's partialFailure; each one is collected as a sourceWarning
 * ({name, what, message}). A warning is not an error: the comps that did come back are used.
 * But "no comps at all" together with a warning is NOT "nothing nearby" (see
 * lib/outcome.js classifySourceResult()).
 *
 * The geocoder's zip (RentCast's answer) is handed on to the sources still to run as
 * subject.zip, so an address typed without a zip still gets its zip-scoped searches
 * (Rincon's own move-in records).
 *
 * The subject's own current listing is never kept as a comp (see
 * dropSubjectsOwnListing() in lib/property-matching.js for what is and is not dropped).
 *
 * @returns {Promise<{comps: object[], subjectEstimatedRent: number|null, subjectLatitude: number|null, subjectLongitude: number|null, subjectZip: string|null, sourcesUsed: string[], sourceErrors: {name: string, error: string}[], sourceWarnings: {name: string, what: string, message: string}[], sourcesSkipped: {name: string, reason: string}[]}>}
 */
async function runActiveSources(activeSources, subject) {
  const allComps = [];
  const sourcesUsed = [];
  const sourceErrors = [];
  const sourceWarnings = [];
  const sourcesSkipped = [];
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
      // A source that did not search at all (no zip, no location) is not "used": it is reported as skipped, so a report with
      // no comps never claims it checked it.
      if (typeof result.skipped === 'string' && result.skipped) sourcesSkipped.push({ name: source.name, reason: result.skipped });
      else sourcesUsed.push(source.name);
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
      if (!enrichedSubject.zip && typeof result.subjectZip === 'string') {
        enrichedSubject.zip = result.subjectZip;
      }
      for (const part of asPartialFailureList(result.partialFailure)) {
        console.warn(`[rental-analysis] Source "${source.name}" only partly worked (${part.what}): ${part.message}`);
        sourceWarnings.push({ name: source.name, what: part.what, message: part.message });
      }
    } catch (err) {
      console.error(`[rental-analysis] Source "${source.name}" failed:`, err.message);
      sourceErrors.push({ name: source.name, error: err.message });
    }
  }

  // Before the radius search: a comp from a non-MLS source (RentCast) that is
  // the same listing as a CRMLS comp borrows the CRMLS copy's MLS facts, so the
  // furnished / short-term / 55+ rules apply to it too. See lib/mls-facts.js.
  const own = dropSubjectsOwnListing(allComps, subject.address);
  if (own.dropped.length) {
    console.log(`[rental-analysis] Dropped ${own.dropped.length} listing(s) of the subject's own address from the comps: ${own.dropped.map(c => `${c.address} (${c.source_name})`).join('; ')}`);
  }
  return { comps: applyCombinedRadiusTiering(mergeMlsFacts(own.kept), subject), subjectEstimatedRent, subjectLatitude, subjectLongitude, subjectZip, sourcesUsed, sourceErrors, sourceWarnings, sourcesSkipped };
}

// A handler's partialFailure may be a list of {what, message}, one such object, or just a message string.
function asPartialFailureList(partialFailure) {
  if (!partialFailure) return [];
  const list = Array.isArray(partialFailure) ? partialFailure : [partialFailure];
  return list.map(p => (typeof p === 'string' ? { what: 'part of what it searches', message: p } : { what: String((p && p.what) || 'part of what it searches'), message: String((p && p.message) || 'no details') }));
}

module.exports = { SOURCE_HANDLERS, chooseRadiusRung, applyCombinedRadiusTiering, runActiveSources };
