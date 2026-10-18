/**
 * lib/analyze.js
 * The "numbers pipeline": everything that happens to the comps AFTER
 * runActiveSources() (lib/sources.js) returns and BEFORE anything is saved.
 * Until this file existed the same sequence was copied inline into both
 * server.js (standalone) and router.js (Hub); now both call computeNumbers()
 * below, and so does the permanent accuracy test (backtest/), so the test
 * and the product can never run different code. CMA-QUALITY-SPEC.md, Phase A0.
 *
 * Pure: no network, no database, no clock. The one table it needs, the
 * `properties` rows used to spot Rincon-managed comps, is passed in by the
 * caller (server.js/router.js fetch it exactly where they always did).
 *
 * This is a straight move of the old inline code. Nothing about the order of
 * steps, the arguments passed to each function, or the shape of the results
 * changed, so every number the tool produces is the same as before (proved by
 * the existing checks plus backtest/a0-replay.js, which runs the frozen
 * pre-move code beside this file on every saved analysis). Later phases
 * (size band, MLS facts, recommended range, confidence) add their steps HERE,
 * once, for both entry points and the test.
 *
 * Phase B (size band and MLS facts) added ONE thing here: the subject's
 * extras (square footage, furnished, lease length, 55+) are read from `subject`
 * once and handed to every step below, so the dedupe choice, both ranges and
 * the per-comp verdict all apply the same four extra rules
 * (lib/weighting.js, extraExclusionReason). A subject that leaves those fields
 * out gets the old behavior exactly (this is how the accuracy test still runs
 * "the tool before Phase B"). Nothing else about the steps changed.
 *
 * Phase C (recommended range, prices, confidence) added the last two things this
 * returns: `headline` (the $200 recommended range, the suggested list price and
 * the stretch price) and `confidence` (High / Medium / Low with its reasons),
 * both built only from the comps that counted. They are null when fewer than 4
 * comps counted: no range, no prices, no label. The old wide numbers
 * (`recommended`, `raw`) are still returned, but ONLY for the audit columns in
 * the database and for working out how well the comps agree; nothing shown to a
 * reader may use them. The owner's goal comes in on `subject.ownerGoal` and only
 * chooses which price inside the range is suggested.
 *
 * Steps, in order:
 *   1. Match every comp's address against `properties` (best-effort) and tag
 *      it with comp_property_id / is_rincon_managed.
 *   2. Collapse the same real unit reported twice into one comp
 *      (dedupeComps(), lib/property-matching.js). subject bedrooms/type are
 *      passed so dedup's tie-break prefers whichever copy actually counts.
 *      Everything downstream (ranges, narrative, the database insert) runs on
 *      this deduped list.
 *   3. The weighted recommended range and the raw comp range, computed from
 *      the deduped list. The narrative step only ever explains these.
 *   4. The one shared "why doesn't this comp count" verdict per comp
 *      (exclusionReason(), lib/weighting.js), computed once here and reused
 *      by the narrative prompt and the API response, so they can never
 *      independently drift on which comps are excluded. Positional array,
 *      same order as compsWithMatch.
 *   5. The counted comps (verdict null), how many of them are confirmed
 *      leases, and from those the headline range and the confidence label.
 */

const { findBestPropertyMatch, dedupeComps } = require('./property-matching');
const { computeRecommendedRange, computeRawRange, exclusionReason, subjectExtrasFrom, computeHeadlineRange } = require('./weighting');
const { computeConfidence } = require('./confidence');

/**
 * @param {object} args
 * @param {object[]} args.comps - the comps runActiveSources() returned (each already has source_id/source_name)
 * @param {{bedrooms: number, propertyType: string, sqft?: number, furnished?: boolean, leaseTermMonths?: number, ageRestricted?: boolean, ownerGoal?: string}} args.subject - same subject runActiveSources() received (other fields ignored)
 * @param {object[]} [args.properties] - rows from `properties` ({id, address, city, state, zip}); omitted/empty means no comp is Rincon-managed
 * @returns {{
 *   compsWithMatch: object[],
 *   matchedCount: number,
 *   recommended: {low: number|null, mid: number|null, high: number|null},
 *   raw: {low: number|null, high: number|null},
 *   exclusionReasons: (string|null)[],
 *   counted: {total: number, leased: number},
 *   headline: object|null,
 *   confidence: object|null
 * }} matchedCount is the comp count BEFORE dedupe (callers log it against compsWithMatch.length)
 */
function computeNumbers({ comps, subject, properties = [] }) {
  const { bedrooms, propertyType } = subject;
  const extras = subjectExtrasFrom(subject);

  const matchedComps = comps.map(c => {
    const match = findBestPropertyMatch(c.address, properties);
    return { ...c, comp_property_id: match ? match.id : null, is_rincon_managed: !!match };
  });
  const compsWithMatch = dedupeComps(matchedComps, bedrooms, propertyType, extras);

  const recommended = computeRecommendedRange(compsWithMatch, bedrooms, propertyType, extras);
  const raw = computeRawRange(compsWithMatch, bedrooms, propertyType, extras);

  const exclusionReasons = compsWithMatch.map(c => exclusionReason(c, bedrooms, propertyType, extras));

  const countedComps = compsWithMatch.filter((c, i) => exclusionReasons[i] === null);
  const counted = { total: countedComps.length, leased: countedComps.filter(c => c.listing_status === 'leased').length };
  const headline = computeHeadlineRange(recommended, countedComps, subject.ownerGoal);
  const confidence = computeConfidence(headline);

  return { compsWithMatch, matchedCount: matchedComps.length, recommended, raw, exclusionReasons, counted, headline, confidence };
}

module.exports = { computeNumbers };
