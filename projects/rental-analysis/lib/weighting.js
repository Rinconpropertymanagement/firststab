/**
 * lib/weighting.js
 * Turns a list of comps into a recommended rent range, weighting comps with
 * more trustworthy listing_status more heavily — per spec, this must be a
 * real, adjustable weight per status, not hardcoded math scattered through
 * the analysis logic, since a stronger leased-comp signal is coming once
 * FlexMLS is live (see rental_comp_sources).
 */

const {
  SQFT_BAND_PCT, SQFT_BAND_PROPERTY_TYPES, SHORT_TERM_LEASE_BELOW_MONTHS,
  HEADLINE_RANGE_WIDTH, HEADLINE_MIN_COMPS, LIST_PRICE_STEP, STRETCH_ABOVE_RANGE,
  OWNER_GOALS, DEFAULT_OWNER_GOAL, OWNER_GOAL_PHRASES, NEAR_RANGE_DOLLARS,
} = require('./constants');

// Higher weight = more trust in that comp's price as a real signal of
// current market rent.
//   - leased: a confirmed real transaction — the strongest possible signal.
//     No source live today actually confirms this (see lib/rentcast.js's
//     mapListingStatus — RentCast can only infer, never confirm, so it
//     never produces 'leased' comps). This weight has no visible effect
//     yet and will once FlexMLS goes live.
//   - active: a real, current asking price — a good signal, just not yet
//     proven by an actual transaction.
//   - off_market: delisted with no confirmed transaction (could have
//     leased, could have simply expired or been pulled) — the least
//     certain of the three, so it counts the least.
// Adjust these three numbers to change the weighting anywhere in the app —
// nothing else needs to change.
const LISTING_STATUS_WEIGHTS = {
  leased: 3,
  active: 2,
  off_market: 1,
};

function weightFor(listingStatus) {
  return LISTING_STATUS_WEIGHTS[listingStatus] || 1;
}


// How much to trust a comp's price based on how close its bedroom count is
// to the subject property's — a comp of a very different size isn't really
// the same kind of rental, even if it's nearby and recently leased.
const BEDROOM_ONE_OFF_MULTIPLIER = 0.5; // comp is 1 bedroom off from the subject
const BEDROOM_MISMATCH_THRESHOLD = 2;   // 2+ bedrooms off from the subject -> excluded entirely

// Comp bedroom count vs. the subject's — a comp of a very different size
// isn't really the same kind of rental, even if it's nearby and recently
// leased. Exact match: full trust (unchanged behavior). 1 bedroom off:
// still a real signal, but weighted down, not treated equally. 2+
// bedrooms off: excluded entirely from both range calculations (same
// treatment as excludeRinconManaged — still saved/shown to the user,
// just not counted in the math). A comp with unknown/missing bedroom
// data is treated as "1 off" (moderate trust) rather than excluded
// (don't punish a real comp for missing metadata) or fully trusted
// (we genuinely don't know if it matches).
//
// subjectBedrooms is optional — when it's not a real number (caller
// didn't pass one), this returns 1 for every comp, i.e. no filtering,
// identical to this function not existing. This keeps every existing
// caller (including the test suite) working unchanged unless it
// deliberately opts in by passing subjectBedrooms.
function sizeSimilarityMultiplier(compBedrooms, subjectBedrooms) {
  if (typeof subjectBedrooms !== 'number') return 1;
  if (typeof compBedrooms !== 'number') return BEDROOM_ONE_OFF_MULTIPLIER;
  const diff = Math.abs(compBedrooms - subjectBedrooms);
  if (diff === 0) return 1;
  if (diff < BEDROOM_MISMATCH_THRESHOLD) return BEDROOM_ONE_OFF_MULTIPLIER;
  return 0;
}

// A comp's property type either matches the subject's or it doesn't — no
// partial-credit tier like bedroom count has, because a townhouse isn't
// "somewhat comparable" to a single-family house, it's a different kind of
// structure (Peter's own words: "anyone who reviews the report will bring
// up how they arent the same"). Exact match: counts normally. Known,
// different type: excluded entirely from both range calculations (same
// treatment as a severe bedroom mismatch or a Rincon-managed comp — still
// saved and shown to the user for context, just not counted in the math).
// Unknown type on either side (not every source cleanly reports it):
// NOT excluded — an unknown type isn't a confirmed mismatch, same "don't
// punish a real comp for missing metadata" reasoning sizeSimilarityMultiplier
// already uses for a comp with no bedroom count at all.
function propertyTypeMultiplier(compPropertyType, subjectPropertyType) {
  if (!subjectPropertyType || !compPropertyType) return 1;
  return compPropertyType === subjectPropertyType ? 1 : 0;
}

// ─── The new rules (CMA-QUALITY-SPEC.md Items 1 and 2) ──────────────────────
// Four more reasons a comp can be left out of the numbers. They are decided in
// ONE place (extraExclusionReason below) and used by the range math, the
// radius search, the duplicate check, the written explanation and the
// dashboards, so none of them can disagree about which comps count.
//
// "subjectExtras" describes the subject for these rules:
//   { sqft, furnished, leaseTermMonths, ageRestricted }
// Each rule turns on only when its piece is given, so a caller that passes
// nothing (every older caller, and the "before Phase B" method in the accuracy
// test) gets exactly the old behavior. The report pages always pass all four.
// A fact the MLS did not give us (null) is NEVER a reason to leave a comp out.

// True when this subject's square footage is a usable whole number and its
// property type is one the size rule covers.
function sqftRuleApplies(subjectSqft, subjectPropertyType) {
  return Number.isInteger(subjectSqft) && subjectSqft > 0 && SQFT_BAND_PROPERTY_TYPES.includes(subjectPropertyType);
}

// The percent shown on the report ("size band 25%"), or null when the rule
// does not apply to this subject (a duplex, no square footage, ...).
function sizeBandPctFor(subjectPropertyType, subjectSqft) {
  return sqftRuleApplies(subjectSqft, subjectPropertyType) ? SQFT_BAND_PCT : null;
}

// The smallest and largest comp size that still counts, for the written note
// on the report: a 1,636 sq ft subject gives 1,227 to 2,045. Null when the
// rule does not apply.
function sqftBandFor(subjectPropertyType, subjectSqft) {
  if (!sqftRuleApplies(subjectSqft, subjectPropertyType)) return null;
  return {
    pct: SQFT_BAND_PCT,
    low: Math.ceil(subjectSqft * (100 - SQFT_BAND_PCT) / 100),
    high: Math.floor(subjectSqft * (100 + SQFT_BAND_PCT) / 100),
  };
}

// True when a comp's size is too far from the subject's. Whole-number maths
// only (no rounding): exactly 25.0% off still counts, 25.1% off does not. A
// comp with no square footage listed is unknown, never excluded, the same
// rule already used for an unknown bedroom count or property type.
function sqftOutsideBand(compSqft, subjectSqft, subjectPropertyType) {
  if (!sqftRuleApplies(subjectSqft, subjectPropertyType)) return false;
  if (!Number.isInteger(compSqft) || compSqft <= 0) return false;
  return Math.abs(compSqft - subjectSqft) * 100 > subjectSqft * SQFT_BAND_PCT;
}

// Builds the subjectExtras above from the subject object the entry points and
// runActiveSources() already pass around: { sqft, furnished, leaseTermMonths,
// ageRestricted } (any of them may be missing).
function subjectExtrasFrom(subject) {
  const s = subject || {};
  return {
    sqft: s.sqft,
    furnished: s.furnished,
    leaseTermMonths: s.leaseTermMonths,
    ageRestricted: s.ageRestricted,
  };
}

// True when the comp carries any of the three MLS facts that decide whether it
// is left out (furnished, lease length, 55+). Used to prefer the copy of a
// listing that has them (lib/property-matching.js) and to decide which comps
// can borrow them (lib/mls-facts.js).
function hasExclusionFacts(comp) {
  return !!comp && (
    (comp.furnished_status !== null && comp.furnished_status !== undefined) ||
    (comp.lease_term_class !== null && comp.lease_term_class !== undefined) ||
    (comp.age_restricted !== null && comp.age_restricted !== undefined)
  );
}

// A comp whose rent cannot be right for the home (a 3-bedroom house at $280,
// a 613 sq ft condo at $199) is a data error and never counts. Only Rincon's own
// lease records can carry the mark: lib/leadsimple.js sets it on a comp whose rent
// fails the screen in RINCON_RENT_SCREEN (lib/constants.js). A comp that carries no
// mark is never affected, so older callers and the "before" method of the accuracy
// test see no change from any comp they build by hand.
function hasImplausibleRent(comp) {
  return !!comp && comp.implausible_rent === true;
}

// The reason, if any, among the four new ones. In this order when several
// apply: size_sqft, furnished_mismatch, short_term_lease, age_restricted.
// Only the reason that is REPORTED depends on the order; whether the comp
// counts does not. A rent that cannot be right (see hasImplausibleRent above)
// comes first and, unlike the four, needs nothing from the subject.
function extraExclusionReason(comp, subjectPropertyType, subjectExtras) {
  if (hasImplausibleRent(comp)) return 'implausible_rent';
  const x = subjectExtras || {};
  if (sqftOutsideBand(comp.sqft, x.sqft, subjectPropertyType)) return 'size_sqft';
  if (typeof x.furnished === 'boolean') {
    // A furnished subject wants furnished comps; an unfurnished one wants unfurnished.
    // "partly furnished", "either" and unknown never leave a comp out.
    if (comp.furnished_status === 'furnished' && !x.furnished) return 'furnished_mismatch';
    if (comp.furnished_status === 'unfurnished' && x.furnished) return 'furnished_mismatch';
  }
  if (Number.isInteger(x.leaseTermMonths) && x.leaseTermMonths >= SHORT_TERM_LEASE_BELOW_MONTHS) {
    // A subject leasing for 6 months or more does not want month-to-month or
    // vacation-style comps. A subject with a shorter lease keeps them.
    if (comp.lease_term_class === 'short') return 'short_term_lease';
  }
  if (typeof x.ageRestricted === 'boolean' && !x.ageRestricted) {
    // A subject that is not in a 55+ community leaves 55+ comps out; a 55+
    // subject keeps them.
    if (comp.age_restricted === true) return 'age_restricted';
  }
  return null;
}

// Builds a weighted sample by repeating each comp's rent `weight` times, so
// percentiles computed on the sample naturally lean toward higher-trust
// comps without needing a more complex weighted-percentile formula.
// subjectBedrooms is optional (see sizeSimilarityMultiplier) — omitting it
// preserves the exact prior behavior: repeatCount is the plain status
// weight, not scaled at all. When subjectBedrooms IS given, every comp's
// repeatCount is computed on the same *2 scale (needed so the 0.5 "one
// bedroom off" multiplier produces a whole number of repeats) — that scale
// only ever compares comps to each other within this one call, so it never
// needs to match the unscaled, subjectBedrooms-omitted case number-for-number.
// subjectPropertyType is the same kind of optional add-on (see
// propertyTypeMultiplier) — omitted, it defaults to 1 for every comp, so
// it never changes repeatCount on its own. It's combined multiplicatively
// with the bedroom multiplier: a property-type mismatch (0) zeroes out the
// repeat count regardless of how well bedrooms match, since these are two
// independent hard/soft filters that must both pass.
function buildWeightedSample(comps, subjectBedrooms, subjectPropertyType) {
  const sizeAware = typeof subjectBedrooms === 'number';
  const sample = [];
  for (const comp of comps) {
    const statusWeight = weightFor(comp.listing_status);
    const repeatCount = sizeAware
      ? Math.round(statusWeight * sizeSimilarityMultiplier(comp.bedrooms, subjectBedrooms) * propertyTypeMultiplier(comp.property_type, subjectPropertyType) * 2) // *2 keeps the 0.5 multiplier producing whole repeats without changing the existing 3/2/1 status weights' relative proportions
      : statusWeight;
    for (let i = 0; i < repeatCount; i++) sample.push(Number(comp.monthly_rent));
  }
  return sample.sort((a, b) => a - b);
}

// Linear-interpolation percentile — standard definition, easy to verify by
// hand against a small sample.
function percentile(sortedArr, p) {
  if (!sortedArr || sortedArr.length === 0) return null;
  if (sortedArr.length === 1) return sortedArr[0];
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  const frac = idx - lo;
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * frac;
}

function round2(n) {
  return n === null || n === undefined ? null : Math.round(n * 100) / 100;
}

// A Rincon-managed comp is normally Rincon's own listing showing up via an
// INDEPENDENT market source (RentCast/CRMLS) — not a real outside data
// point, so the math excludes it. Confirmed against Peter's own reference
// report (stated "Comp rent range" $4,650-$5,000, with the Rincon-managed
// comp in that report priced at $4,635 — below the stated range, i.e.
// already excluded from Rincon's existing manual process).
//
// LeadSimple Move-Ins comp source build (see LEADSIMPLE-COMP-SOURCE-SPEC.md,
// "Resolving the Rincon-managed exclusion conflict"): a source can now be
// DELIBERATELY built to pull only Rincon's own managed properties, on
// purpose, because that's real, confirmed, real-transaction data — not an
// incidental match. Excluding those the same way would silently zero out
// every comp this kind of source ever produces (they're Rincon-managed by
// construction), so the exclusion is now keyed off which SOURCE produced
// the comp, not is_rincon_managed alone. Named, explicit exemption list —
// a source must be deliberately added here, never inferred.
const SELF_SOURCED_TRUSTED_SOURCE_NAMES = new Set(['LeadSimple Move-Ins']);

// True when a comp should be treated as "internal reference only, don't
// count it" — is_rincon_managed AND not from a source on the trusted list
// above. Shared by excludeRinconManaged() below, lib/narrative.js's
// describeComp() (so Claude isn't told a counted, 3x-weighted comp is
// "internal reference only"), and server.js (which forwards the same
// verdict to the dashboard, since dashboard/index.html is plain browser JS
// with no way to require() this file directly — see server.js's own
// comment on why the check is duplicated there rather than imported).
// Keeping the trusted-source list in exactly one place (here) means all
// three call sites can never drift out of sync with each other.
function isExcludedRinconManaged(comp) {
  return !!(comp && comp.is_rincon_managed) && !SELF_SOURCED_TRUSTED_SOURCE_NAMES.has(comp.source_name);
}

// Comps still get displayed and stored with their RINCON MANAGED badge
// either way — this only controls what feeds the two range calculations
// below.
function excludeRinconManaged(comps) {
  return (comps || []).filter(c => !isExcludedRinconManaged(c));
}

// Single shared "why doesn't this comp count" answer — computed once here
// and reused everywhere else that needs it (lib/narrative.js's
// describeComp()/buildPrompt(), server.js/router.js's API response for the
// dashboard, lib/property-matching.js's dedupeComps()). Before this
// function existed, narrative.js had no way to know a comp had been
// zero-weighted by computeRecommendedRange()/computeRawRange() below, and
// confidently cited excluded comps as supporting evidence (confirmed live,
// 2026-09-20: a duplex analysis's rationale cited two single-family comps
// and a townhouse as "supporting the upper end"/"a real current floor" —
// all zero-weighted). One source of truth means narrative.js and the
// dashboard can never independently drift on what counts as excluded.
//
// Returns null when the comp contributes any weight to the range (an exact
// match, or a partial-credit 1-bedroom-off match) — i.e. nothing to report.
// Returns a short machine-readable reason string when the comp is fully
// zero-weighted (contributes nothing, in either computeRecommendedRange()
// or computeRawRange()) for one of the three reasons this file already
// checks independently.
//
// A comp can fail more than one check at once (e.g. Rincon-managed AND a
// different property type). Only one reason is ever reported, in this
// priority order:
//   1. rincon_managed — this isn't a market-data mismatch at all, it's a
//      different KIND of problem (the comp isn't really outside/independent
//      data), so it's checked and reported first regardless of whether it
//      would also fail the type/size checks below.
//   2. property_type_mismatch — checked before size_mismatch because
//      property type has no partial-credit tier (propertyTypeMultiplier is
//      either 1 or 0 — see its own comment on why a townhouse "isn't
//      somewhat comparable" to a single-family house), so a type mismatch
//      is the more fundamental reason the comp doesn't belong in this
//      analysis, whether or not its bedroom count also happens to be off.
//   3. size_mismatch — checked last since sizeSimilarityMultiplier has a
//      partial-credit tier (1 bedroom off still counts at half weight), so
//      it only zeroes out a comp for a genuinely severe (2+ bedroom) gap.
// This ordering only affects which single reason string gets reported for
// display — it has no effect on whether a comp counts (that's still decided
// independently, and identically, by computeRecommendedRange()/
// computeRawRange() below multiplying all three checks together).
//
// Four more reasons follow, from extraExclusionReason() above, only when the
// caller passes subjectExtras (see the block above): size_sqft (square
// footage more than 25% off), furnished_mismatch, short_term_lease and
// age_restricted (a 55+ community). Same rule as the first three: only one
// reason is reported, and the order never changes whether a comp counts.
//
// One more, implausible_rent, needs no subject at all: Rincon's own lease records whose rent
// cannot be right for the home carry a mark (comp.implausible_rent) and never count.
function exclusionReason(comp, subjectBedrooms, subjectPropertyType, subjectExtras) {
  if (isExcludedRinconManaged(comp)) return 'rincon_managed';
  // A rent that cannot be right is the more basic problem with a comp (its other facts are no more
  // trustworthy), so it is the reason reported, ahead of a type or size difference.
  if (hasImplausibleRent(comp)) return 'implausible_rent';
  if (propertyTypeMultiplier(comp.property_type, subjectPropertyType) === 0) return 'property_type_mismatch';
  if (sizeSimilarityMultiplier(comp.bedrooms, subjectBedrooms) === 0) return 'size_mismatch';
  return extraExclusionReason(comp, subjectPropertyType, subjectExtras);
}

/**
 * @param {object[]} comps - each needs {monthly_rent, listing_status, is_rincon_managed, bedrooms, property_type}
 * @param {number} [subjectBedrooms] - optional; see sizeSimilarityMultiplier
 * @param {string} [subjectPropertyType] - optional; see propertyTypeMultiplier
 * @param {object} [subjectExtras] - optional; see the "new rules" block above. Comps left out by size_sqft, furnished_mismatch, short_term_lease or age_restricted are dropped here too.
 * @returns {{low: number|null, mid: number|null, high: number|null}}
 */
function computeRecommendedRange(comps, subjectBedrooms, subjectPropertyType, subjectExtras) {
  const eligible = excludeRinconManaged(comps)
    .filter(c => extraExclusionReason(c, subjectPropertyType, subjectExtras) === null);
  if (!eligible.length) return { low: null, mid: null, high: null };
  const sample = buildWeightedSample(eligible, subjectBedrooms, subjectPropertyType);
  return {
    low:  round2(percentile(sample, 25)),
    mid:  round2(percentile(sample, 50)),
    high: round2(percentile(sample, 75)),
  };
}

/**
 * The unweighted spread across the actual comps pulled — distinct from the
 * recommended range above (see migration design notes on raw_comp_rent_*
 * vs. recommended_rent_*). Comps 2+ bedrooms off from the subject, or a
 * known different property type, are excluded here too (same principle as
 * excludeRinconManaged) — a 1-bed apartment isn't a legitimate comp for a
 * 5-bed house in either number, and neither is a townhouse for a
 * single-family house.
 * @param {object[]} comps - each needs {monthly_rent, is_rincon_managed, bedrooms, property_type}
 * @param {number} [subjectBedrooms] - optional; see sizeSimilarityMultiplier
 * @param {string} [subjectPropertyType] - optional; see propertyTypeMultiplier
 * @param {object} [subjectExtras] - optional; see the "new rules" block above
 * @returns {{low: number|null, high: number|null}}
 */
function computeRawRange(comps, subjectBedrooms, subjectPropertyType, subjectExtras) {
  const eligible = excludeRinconManaged(comps)
    .filter(c => sizeSimilarityMultiplier(c.bedrooms, subjectBedrooms) > 0)
    .filter(c => propertyTypeMultiplier(c.property_type, subjectPropertyType) > 0)
    .filter(c => extraExclusionReason(c, subjectPropertyType, subjectExtras) === null);
  if (!eligible.length) return { low: null, high: null };
  const rents = eligible.map(c => Number(c.monthly_rent)).filter(n => Number.isFinite(n));
  if (!rents.length) return { low: null, high: null };
  return { low: round2(Math.min(...rents)), high: round2(Math.max(...rents)) };
}

// ─── The recommended range, the suggested price and the stretch price ───────
// (CMA-QUALITY-SPEC.md Item 4.2.) The computed range above (the 25th, 50th and
// 75th percentiles and the lowest-to-highest rents) is WIDE and is kept only for
// the audit trail and for working out how well the comps agree. What a reader is
// ever told is the headline below: a range exactly $200 wide, built around the
// weighted middle of the counted comps.

// Rounds `mid` to the nearest `step` dollars. Exactly halfway (an x50 middle for
// a $100 step, an x25 or x75 middle for a $50 step) takes whichever candidate is
// closer to the middle of the computed range (low + high) / 2; if still tied, the
// lower one.
function roundToStep(mid, step, low, high) {
  const lo = Math.floor(mid / step) * step;
  const hi = lo + step;
  if (mid === lo) return lo;
  const dLo = mid - lo, dHi = hi - mid;
  if (dLo < dHi) return lo;
  if (dHi < dLo) return hi;
  const centre = (low + high) / 2;
  return Math.abs(hi - centre) < Math.abs(lo - centre) ? hi : lo;
}

// A missing or unrecognised goal means Balanced.
function normalizeOwnerGoal(goal) {
  return OWNER_GOALS.includes(goal) ? goal : DEFAULT_OWNER_GOAL;
}

function formatDollars(n) {
  return `$${Number(n).toLocaleString('en-US')}`;
}

// The one plain sentence that carries the suggested price. Three fixed
// templates; the price is the only thing that changes. (Same words on the screen
// and, later, on the owner page.)
function goalSentenceFor(goal, listPrice) {
  return `Based on your goal of ${OWNER_GOAL_PHRASES[normalizeOwnerGoal(goal)]}, we suggest listing at ${formatDollars(listPrice)}.`;
}

/**
 * @param {{low: number|null, mid: number|null, high: number|null}} recommended - the computed range (internal)
 * @param {object[]} countedComps - only the comps that counted (each needs monthly_rent, listing_status)
 * @param {string} [goal] - lease_quickly | balanced | maximize_rent (anything else means balanced)
 * @returns {null | {low, high, listPrice, goal, goalSentence, stretchPrice, centre, countedTotal, leasedCounted, compsInside, compsNear, spread}}
 *   null (no range, no prices) when fewer than HEADLINE_MIN_COMPS comps counted or there is no middle to work from.
 *   low/high are exactly HEADLINE_RANGE_WIDTH apart, both multiples of $100; listPrice is a multiple of $50
 *   inside the range; stretchPrice is the range high plus STRETCH_ABOVE_RANGE. spread is INTERNAL (it feeds
 *   the confidence label and is saved for audit); it is never shown.
 */
function computeHeadlineRange(recommended, countedComps, goal) {
  const counted = Array.isArray(countedComps) ? countedComps : [];
  if (!recommended || recommended.mid === null || recommended.mid === undefined || !Number.isFinite(Number(recommended.mid))) return null;
  if (counted.length < HEADLINE_MIN_COMPS) return null;
  const mid = Number(recommended.mid);
  const half = HEADLINE_RANGE_WIDTH / 2;
  // never lower than $0 at the bottom (the database refuses a negative end)
  const centre = Math.max(half, roundToStep(mid, 100, recommended.low, recommended.high));
  const low = centre - half;
  const high = centre + half;
  const chosenGoal = normalizeOwnerGoal(goal);
  const balanced = Math.min(high, Math.max(low, roundToStep(mid, LIST_PRICE_STEP, recommended.low, recommended.high)));
  const listPrice = chosenGoal === 'lease_quickly' ? low : chosenGoal === 'maximize_rent' ? high : balanced;
  const rents = counted.map(c => Number(c.monthly_rent)).filter(Number.isFinite);
  return {
    low,
    high,
    listPrice,
    goal: chosenGoal,
    goalSentence: goalSentenceFor(chosenGoal, listPrice),
    stretchPrice: high + STRETCH_ABOVE_RANGE,
    centre,
    countedTotal: counted.length,
    leasedCounted: counted.filter(c => c.listing_status === 'leased').length,
    compsInside: rents.filter(r => r >= low && r <= high).length,
    compsNear: rents.filter(r => r >= low - NEAR_RANGE_DOLLARS && r <= high + NEAR_RANGE_DOLLARS).length,
    spread: recommended.high - recommended.low,
  };
}

module.exports = {
  LISTING_STATUS_WEIGHTS,
  BEDROOM_ONE_OFF_MULTIPLIER,
  BEDROOM_MISMATCH_THRESHOLD,
  SELF_SOURCED_TRUSTED_SOURCE_NAMES,
  weightFor,
  sizeSimilarityMultiplier,
  propertyTypeMultiplier,
  buildWeightedSample,
  percentile,
  isExcludedRinconManaged,
  excludeRinconManaged,
  sqftRuleApplies,
  sizeBandPctFor,
  sqftBandFor,
  sqftOutsideBand,
  subjectExtrasFrom,
  hasExclusionFacts,
  hasImplausibleRent,
  extraExclusionReason,
  exclusionReason,
  computeRecommendedRange,
  computeRawRange,
  roundToStep,
  normalizeOwnerGoal,
  formatDollars,
  goalSentenceFor,
  computeHeadlineRange,
};
