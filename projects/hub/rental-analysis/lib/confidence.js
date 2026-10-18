/**
 * lib/confidence.js
 * The High / Medium / Low confidence label that goes with the recommended range
 * (CMA-QUALITY-SPEC.md Item 4.3), and the plain reasons behind it. Everything
 * here is worked out by code from the counted comps; the AI writes none of it.
 *
 * The label is only about how much to trust the range:
 *   - how many comps counted, and how many of them are confirmed leases
 *   - how closely their rents agree (the internal "spread", which is never shown)
 *   - whether any counted comp is priced near the range
 * It says nothing about how fast a home leases. The numbers behind each word
 * (250, 500, 6, 2, 5) are in lib/constants.js and are starting values that the
 * accuracy test checks.
 *
 * No range means no label: with fewer than 4 counted comps this returns null and
 * the report says why instead.
 */

const {
  CONF_AGREE_SPREAD, CONF_DISAGREE_SPREAD, CONF_HIGH_MIN_COMPS, CONF_HIGH_MIN_LEASES, CONF_LOW_BELOW_COMPS,
} = require('./constants');

const plural = (n, one, many) => (n === 1 ? one : many);

/**
 * @param {object|null} headline - from computeHeadlineRange() in lib/weighting.js
 * @returns {null | {label: 'high'|'medium'|'low', reasons: string[], reasonText: string}}
 */
function computeConfidence(headline) {
  if (!headline) return null;
  const { countedTotal: n, leasedCounted: leased, spread, compsNear } = headline;

  const spreadWide = spread >= CONF_DISAGREE_SPREAD;
  const tooFew = n < CONF_LOW_BELOW_COMPS;
  const noLease = leased === 0;
  const noneNear = compsNear === 0;
  const isLow = spreadWide || tooFew || noLease || noneNear;
  const isHigh = !isLow && spread < CONF_AGREE_SPREAD && n >= CONF_HIGH_MIN_COMPS && leased >= CONF_HIGH_MIN_LEASES;
  const label = isLow ? 'low' : isHigh ? 'high' : 'medium';

  // Always say how many comps counted and how many are confirmed leases.
  const reasons = [`${n} ${plural(n, 'comp', 'comps')} counted, ${leased} of them ${leased === 1 ? 'a confirmed lease' : 'confirmed leases'}`];
  if (label === 'low') {
    // the count was just given above, so this does not repeat it
    if (tooFew) reasons.push(`${CONF_LOW_BELOW_COMPS} or more are needed for better than Low`);
    if (noLease) reasons.push('no confirmed lease is among them');
    if (spreadWide) reasons.push('their rents are spread widely');
    if (noneNear) reasons.push('no counted comp is priced near this range');
  } else if (label === 'medium') {
    if (spread >= CONF_AGREE_SPREAD) reasons.push('they agree only moderately');
    else reasons.push('they mostly agree');
    if (n < CONF_HIGH_MIN_COMPS) reasons.push(`${CONF_HIGH_MIN_COMPS} or more comps are needed for High`);
    if (leased < CONF_HIGH_MIN_LEASES) reasons.push(`${CONF_HIGH_MIN_LEASES} or more confirmed leases are needed for High`);
  } else {
    reasons.push('they mostly agree');
  }
  return { label, reasons, reasonText: `${reasons.join('; ')}.` };
}

// What to do about a Medium or Low report. Only things that can be done today.
const FIRM_UP_LINE = "To firm this up: check the highest and lowest comps, and confirm the home's size and condition.";

module.exports = { computeConfidence, FIRM_UP_LINE };
