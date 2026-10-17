/**
 * backtest/candidates.js
 * The methods the test can run, the comp pools it can run them on, the list of
 * tuning candidates (spec A.9) and the rule for adopting a change (A.5, A.11).
 *
 * THIS FILE IS WRITTEN BEFORE ANY HOLD-OUT NUMBER IS LOOKED AT (A.5). The
 * candidate list, the metric and the margins below are the pre-registration:
 * change them only before a hold-out is judged, and say so in the run report.
 *
 * A "method" is the tool's behaviour under test. The baseline is today's real
 * code. The other methods are the proposed rules (Phase B's size band and MLS
 * facts), simulated as a filter on the comps the replay hands the real tool.
 * Dropping a comp before the tool sees it gives the same numbers as Phase B's
 * "excluded but still shown" because an excluded comp contributes nothing to
 * the radius-ladder gate, the dedupe choice or the range math (the spec's
 * "coupled" design). When Phase B ships, these filters should be deleted and
 * the methods switched on by the real lib code instead.
 *
 * A "pool" says which data the replay rebuilds: MLS closed leases only (how
 * the spec's Appendix G was measured), plus as-of asking prices, plus Rincon's
 * own leases (what the live tool has, minus RentCast).
 */
const { ACCEPTANCE, HEADLINE_MIN_COMPS } = require('./constants');
// The lookbacks come from the product's own modules, never from a copy here, so
// the replay cannot keep using 6 and 24 months after the product changes them.
const { CRMLS_CLOSED_LOOKBACK_MONTHS } = require('../lib/crmls');
const { MOVE_IN_LOOKBACK_MONTHS } = require('../lib/leadsimple');

// ── Item 1 reference: size band ──────────────────────────────────────────────
const SQFT_BAND_PROPERTY_TYPES = ['single_family', 'townhouse', 'condo', 'manufactured'];

// Exactly the spec's integer rule: outside when |compSqft - subjectSqft| * 100 > subjectSqft * pct.
// A comp with no usable square footage is unknown, never excluded.
function sqftOutsideBand(compSqft, subjectSqft, pct) {
  if (!Number.isInteger(compSqft) || compSqft <= 0 || !Number.isInteger(subjectSqft) || subjectSqft <= 0) return false;
  return Math.abs(compSqft - subjectSqft) * 100 > subjectSqft * pct;
}

function sizeKeep(pct) {
  return (comp, subj) => !(SQFT_BAND_PROPERTY_TYPES.includes(subj.propertyType) && sqftOutsideBand(comp.sqft, subj.sqft, pct));
}

// ── Item 2 reference: furnished, short-term, 55+ ─────────────────────────────
function item2Keep(comp, subj) {
  const f = comp._mls;
  if (!f) return true; // LeadSimple comps carry no MLS facts: unknown never excludes
  if (f.furnished === 'furnished' && !subj.furnished) return false;
  if (f.furnished === 'unfurnished' && subj.furnished) return false;
  if (f.leaseTerm === 'short' && subj.leaseTermMonths >= 6) return false;
  if (f.ageRestricted === true && !subj.ageRestricted) return false;
  return true;
}

const both = (...fns) => (comp, subj) => fns.every(fn => fn(comp, subj));

const METHODS = {
  baseline: { id: 'baseline', label: 'Real code today (bedrooms + type)', keep: null },
  item2: { id: 'item2', label: '+ furnished / short-term / 55+ left out', keep: item2Keep },
  size25: { id: 'size25', label: '+ size band 25%', keep: sizeKeep(25) },
  size25_item2: { id: 'size25_item2', label: '+ size band 25% + furnished / short-term / 55+', keep: both(sizeKeep(25), item2Keep) },
};
for (const pct of [15, 20, 30, 35]) {
  METHODS[`size${pct}_item2`] = { id: `size${pct}_item2`, label: `+ size band ${pct}% + furnished / short-term / 55+`, keep: both(sizeKeep(pct), item2Keep) };
}

// ── pools ────────────────────────────────────────────────────────────────────
// askingPrice 'original' prices an as-of asking comp at the listing's ORIGINAL
// list price (falling back to the list price when there is none), because the
// final list price may include cuts made after the as-of date. 'final' is kept
// as an option for comparison.
const POOL_DEFAULTS = { asking: false, rincon: false, mlsMonths: CRMLS_CLOSED_LOOKBACK_MONTHS, rinconMonths: MOVE_IN_LOOKBACK_MONTHS, askingPrice: 'original', useProperties: true };
const POOLS = {
  mls: { id: 'mls', label: 'MLS closed leases only (Appendix G pool)', ...POOL_DEFAULTS },
  'mls+asking': { id: 'mls+asking', label: 'MLS closed leases plus as-of asking prices (original list price)', ...POOL_DEFAULTS, asking: true },
  full: { id: 'full', label: 'MLS leases + asking + Rincon own leases (live tool minus RentCast)', ...POOL_DEFAULTS, asking: true, rincon: true },
  'mls+rincon': { id: 'mls+rincon', label: 'MLS closed leases + Rincon own leases', ...POOL_DEFAULTS, rincon: true },
};

function poolWith(base, overrides, idSuffix) {
  return { ...POOLS[base], ...overrides, id: `${POOLS[base].id}${idSuffix}` };
}

// ── the pre-registered candidate list (A.9) ──────────────────────────────────
// status: 'runnable' = the replay can run it today; 'needs-phase-X' = it needs
// product code that does not exist yet, so it is listed but NOT run.
const CANDIDATES = [
  { id: 1, name: 'Size band 15 / 20 / 25 / 30 / 35% / none', status: 'runnable', methods: ['item2', 'size15_item2', 'size20_item2', 'size25_item2', 'size30_item2', 'size35_item2'], pool: 'mls' },
  { id: 2, name: 'Similarity weights replacing the repeated-sample status/bedroom weights', status: 'needs-phase-F' },
  { id: 3, name: 'Radius ladder rungs and stop rule', status: 'needs-phase-F' },
  { id: 4, name: 'Minimum comps for a recommended range (3 / 4 / 5 / 6)', status: 'runnable-post-hoc' },
  { id: 5, name: 'Status weights (leased 3 / active 2 / off-market 1)', status: 'needs-phase-F' },
  { id: 6, name: 'RentCast Inactive listings: weight 0 vs 1; cap 10 vs 5', status: 'needs-A2' },
  { id: 7, name: 'Centre of the range (median vs mean vs 55th/60th percentile)', status: 'needs-phase-F' },
  { id: 8, name: 'Market-trend adjustment', status: 'needs-phase-F' },
  { id: 9, name: 'Lookback periods (MLS 90/120/180/270 days; Rincon 6/12 months and the live setting)', status: 'runnable', rinconMonths: [6, 12, MOVE_IN_LOOKBACK_MONTHS] },
  { id: 10, name: 'High-rent homes ($5,000+): cap confidence at Medium', status: 'needs-phase-C' },
];

// ── the acceptance rule (Decision 4 / A.11) ──────────────────────────────────
/**
 * Judges one candidate against the baseline on the SAME hold-out targets.
 * Inputs are summaries from metrics.summarize() and, for the large-group
 * check, per-group summaries (metrics.summarizeBy) for both.
 * Returns { pass, checks: [{id, label, pass, detail}] }. All five conditions
 * must hold; the change is also announced to Peter and re-checked next month.
 */
function evaluateAcceptance({ baseline, candidate, baselineGroups = {}, candidateGroups = {}, rinconOnly = false }) {
  const pts = x => Math.round(x * 1000) / 10;
  const checks = [];
  const b = baseline.all, c = candidate.all;
  const needed = rinconOnly ? ACCEPTANCE.minHoldoutLeasesRinconOnly : ACCEPTANCE.minHoldoutLeases;

  const gain = b && c ? (c.within300 - b.within300) * 100 : null;
  checks.push({ id: 'a', label: `at least ${ACCEPTANCE.minGainWithin300Points} points more leases within $300`, pass: gain !== null && gain >= ACCEPTANCE.minGainWithin300Points, detail: gain === null ? 'no data' : `${gain.toFixed(1)} points` });

  const missBetter = b && c ? b.typicalMiss - c.typicalMiss : null;
  checks.push({ id: 'b', label: `typical miss better by at least $${ACCEPTANCE.minMissImprovementDollars}`, pass: missBetter !== null && missBetter >= ACCEPTANCE.minMissImprovementDollars, detail: missBetter === null ? 'no data' : `$${Math.round(missBetter)}` });

  const covLoss = baseline.coverage !== null && candidate.coverage !== null ? (baseline.coverage - candidate.coverage) * 100 : null;
  checks.push({ id: 'c', label: `coverage not down more than ${ACCEPTANCE.maxCoverageLossPoints} points`, pass: covLoss !== null && covLoss <= ACCEPTANCE.maxCoverageLossPoints, detail: covLoss === null ? 'no data' : `${covLoss.toFixed(1)} points lost` });

  const worse = [];
  for (const [groupName, groups] of Object.entries(baselineGroups)) {
    for (const [key, bs] of Object.entries(groups)) {
      const cs = (candidateGroups[groupName] || {})[key];
      if (!bs.all || !cs || !cs.all || bs.estimated < ACCEPTANCE.largeGroupMinN) continue;
      const drop = (bs.all.within300 - cs.all.within300) * 100;
      if (drop > ACCEPTANCE.maxLargeGroupWorsePoints) worse.push(`${groupName}/${key}: -${drop.toFixed(1)}`);
    }
  }
  checks.push({ id: 'd', label: `no large group (${ACCEPTANCE.largeGroupMinN}+ leases) worse by more than ${ACCEPTANCE.maxLargeGroupWorsePoints} points`, pass: worse.length === 0, detail: worse.length ? worse.join('; ') : 'none worse' });

  const n = candidate.estimated;
  checks.push({ id: 'e', label: `tested on at least ${needed} hold-out leases`, pass: n >= needed, detail: `${n} leases` });

  return { pass: checks.every(ch => ch.pass), checks };
}

module.exports = {
  LIVE_MLS_MONTHS: CRMLS_CLOSED_LOOKBACK_MONTHS, LIVE_RINCON_MONTHS: MOVE_IN_LOOKBACK_MONTHS,
  SQFT_BAND_PROPERTY_TYPES, sqftOutsideBand, sizeKeep, item2Keep, METHODS, POOLS, poolWith, CANDIDATES, evaluateAcceptance, HEADLINE_MIN_COMPS,
};
