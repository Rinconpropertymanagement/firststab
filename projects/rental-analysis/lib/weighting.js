/**
 * lib/weighting.js
 * Turns a list of comps into a recommended rent range, weighting comps with
 * more trustworthy listing_status more heavily — per spec, this must be a
 * real, adjustable weight per status, not hardcoded math scattered through
 * the analysis logic, since a stronger leased-comp signal is coming once
 * FlexMLS is live (see rental_comp_sources).
 */

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

// Builds a weighted sample by repeating each comp's rent `weight` times, so
// percentiles computed on the sample naturally lean toward higher-trust
// comps without needing a more complex weighted-percentile formula.
function buildWeightedSample(comps) {
  const sample = [];
  for (const comp of comps) {
    const w = weightFor(comp.listing_status);
    for (let i = 0; i < w; i++) sample.push(Number(comp.monthly_rent));
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

// A Rincon-managed comp is Rincon's own listing, not an independent market
// data point — the narrative (lib/narrative.js's describeComp) and the
// dashboard (dashboard/index.html's "Internal reference only — not an
// independent market comp" label) already tell the reader this. The math
// has to agree: confirmed against Peter's own reference report (stated
// "Comp rent range" $4,650-$5,000, with the Rincon-managed comp in that
// report priced at $4,635 — below the stated range, i.e. already excluded
// from Rincon's existing manual process). Comps still get displayed and
// stored with their badge either way — this only controls what feeds the
// two range calculations below.
function excludeRinconManaged(comps) {
  return (comps || []).filter(c => !c.is_rincon_managed);
}

/**
 * @param {object[]} comps - each needs {monthly_rent, listing_status, is_rincon_managed}
 * @returns {{low: number|null, mid: number|null, high: number|null}}
 */
function computeRecommendedRange(comps) {
  const eligible = excludeRinconManaged(comps);
  if (!eligible.length) return { low: null, mid: null, high: null };
  const sample = buildWeightedSample(eligible);
  return {
    low:  round2(percentile(sample, 25)),
    mid:  round2(percentile(sample, 50)),
    high: round2(percentile(sample, 75)),
  };
}

/**
 * The unweighted spread across the actual comps pulled — distinct from the
 * recommended range above (see migration design notes on raw_comp_rent_*
 * vs. recommended_rent_*).
 * @param {object[]} comps - each needs {monthly_rent, is_rincon_managed}
 * @returns {{low: number|null, high: number|null}}
 */
function computeRawRange(comps) {
  const eligible = excludeRinconManaged(comps);
  if (!eligible.length) return { low: null, high: null };
  const rents = eligible.map(c => Number(c.monthly_rent)).filter(n => Number.isFinite(n));
  if (!rents.length) return { low: null, high: null };
  return { low: round2(Math.min(...rents)), high: round2(Math.max(...rents)) };
}

module.exports = {
  LISTING_STATUS_WEIGHTS,
  weightFor,
  buildWeightedSample,
  percentile,
  excludeRinconManaged,
  computeRecommendedRange,
  computeRawRange,
};
