/**
 * backtest/appendix-g.js
 * The reference numbers from CMA-QUALITY-SPEC.md Appendix G and Item 4.3 for
 * the REAL tool code (not the research estimators), so every run can print
 * "this run vs the spec" and a human can see at a glance whether the permanent
 * test still agrees with the evidence the plan was built on (A.12 item 3).
 *
 * Shares are whole percentages, dollars are whole dollars. "n" counts targets
 * with an estimate and "thin" those with fewer than 4 counted comps, exactly as
 * Appendix G labels its rows. These are fixed history: they were measured on
 * 2026-10-16 data and should NOT be edited when the monthly data moves on.
 */
const G = {
  // G.1 Ventura core, real code
  core: {
    baseline:     { n: 223, thin: 28, miss: 350, within: [19, 32, 47], band: [20, 26, 38], bias: 50 },
    item2:        { n: 220, thin: 30, miss: 338, within: [20, 33, 48], band: [21, 28, 41], bias: 50 },
    size25_item2: { n: 204, thin: 67, miss: 250, within: [26, 42, 59], band: [27, 36, 52], bias: 53 },
  },
  // G.2 county-wide, real code
  county: {
    baseline:     { n: 1071, thin: 79, miss: 450, within: [15, 26, 38], band: [16, 19, 31] },
    size25_item2: { n: 1012, thin: 201, miss: 325, within: [21, 35, 49], band: [23, 27, 42] },
  },
  // G.3 share of targets that get a recommended range (4+ counted comps)
  coverage: { county: { baseline: 91, size25_item2: 74 }, core: { baseline: 85, size25_item2: 60 } },
  // Item 4.3 table (real code, size 25% + exclusions, G.5 starting definition)
  confidence: {
    county: { High: { share: 9, rangeHit: 38, within300: 68 }, Medium: { share: 38, rangeHit: 28, within300: 61 }, Low: { share: 53, rangeHit: 17, within300: 40 } },
    core:   { High: { share: 22, rangeHit: 33, within300: 77 }, Medium: { share: 47, rangeHit: 33, within300: 72 }, Low: { share: 31, rangeHit: 19, within300: 44 } },
  },
  // G.8 / A.7 Rincon portfolio (80 single-home leases after the plausibility screen).
  // Appendix G measured these with the research estimators A and B, not the real
  // tool code, so only direction and rough size are comparable.
  rincon: {
    targets: 80,
    estimable180Days: 50,
    estimable24Months: 60,
    typicalMiss180Days: 388,
    typicalMiss24Months: 303,
    estimateRanHigh: true,
  },
  // Walk-forward split used in G.4
  split: { tune: 555, holdout: 535, total: 1090 },
};

module.exports = { G };
