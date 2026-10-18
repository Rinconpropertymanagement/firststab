/**
 * backtest/metrics.js
 * Scoring for the accuracy test (CMA-QUALITY-SPEC.md A.6). Pure math over the
 * per-target rows the engine produces; no files, no network.
 *
 * One row per target:
 *   { rent, est, low, high, n, leased, nearRange, ... }
 *   rent   the rent actually signed (the answer key)
 *   est    the tool's estimate: the weighted middle (mid) of the counted comps,
 *          null when the tool found nothing to estimate from
 *   low/high  the tool's weighted 25th / 75th percentiles (internal: only their
 *          gap, "spread", is used, as the agreement statistic; never shown)
 *   n      counted comps, leased  confirmed leases among them
 *
 * Two views of the same rows (both always reported, so coverage sits next to
 * accuracy and a method cannot look better by declining to answer):
 *   "all"      every target with an estimate, thin ones (< 4 counted comps)
 *              included. This is how the spec's Appendix G rows were built.
 *   "ranged"   only targets that would actually get a recommended range
 *              (4 or more counted comps): what staff will see in the product.
 *
 * The $200 recommended range, the suggested list price and the confidence
 * label are the spec's Item 4 rules (4.2, 4.3). They are Phase C product code
 * that does not exist yet, so reference copies live here; when lib/weighting.js
 * computeHeadlineRange / lib/confidence.js ship, switch these to the real ones.
 */
const { HEADLINE_MIN_COMPS, HEADLINE_RANGE_WIDTH, LA_BORDER_CITIES, REGION_LABELS, COUNTY_LABELS, ACCEPTANCE } = require('./constants');

// ── basic statistics ─────────────────────────────────────────────────────────
function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

// Wilson 95% interval for a share k/n; the spec quotes these on every hit rate.
function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

// ── Item 4.2 reference: the $200 range, suggested price, stretch price ───────
// Rounds `mid` to the nearest `step`. Exactly halfway (an x50 mid for step 100,
// an x25/x75 mid for step 50) takes whichever candidate is closer to
// (low + high) / 2; if still tied, the lower. Same rule for both steps.
function roundToStep(mid, step, low, high) {
  const lo = Math.floor(mid / step) * step;
  const hi = lo + step;
  if (mid === lo) return lo;
  const dLo = mid - lo, dHi = hi - mid;
  if (dLo < dHi) return lo;
  if (dHi < dLo) return hi;
  const centre = (low + high) / 2;
  const toLo = Math.abs(lo - centre), toHi = Math.abs(hi - centre);
  return toHi < toLo ? hi : lo;
}

/**
 * The recommended range exactly as spec 4.2 defines it: centre = mid rounded to
 * the nearest $100, range = centre -100 to +100, suggested price (the default
 * "Balanced" owner goal) = mid rounded to $50, stretch = range high + 200.
 * Returns null when there is no estimate or fewer than 4 counted comps.
 */
function headlineRange(row) {
  if (row.est === null || row.est === undefined || row.n < HEADLINE_MIN_COMPS) return null;
  const centre = roundToStep(row.est, 100, row.low, row.high);
  const half = HEADLINE_RANGE_WIDTH / 2;
  return {
    centre,
    low: centre - half,
    high: centre + half,
    listPrice: roundToStep(row.est, 50, row.low, row.high),
    stretchPrice: centre + half + 200,
  };
}

// "Band hit" at any evaluation width, centred on the estimate rounded to $100
// (Appendix G). Only the $200 width is ever recommended; $300 and $500 are
// evaluation widths and are labelled that way in every output.
function bandHit(row, width) {
  if (row.est === null || row.est === undefined) return null;
  const centre = roundToStep(row.est, 100, row.low, row.high);
  return Math.abs(row.rent - centre) <= width / 2;
}

// The same, but with plain round-half-up centring: what Appendix G's numbers
// were built with, kept only so the run report can show the effect of the tie rule.
function bandHitHalfUp(row, width) {
  if (row.est === null || row.est === undefined) return null;
  return Math.abs(row.rent - Math.round(row.est / 100) * 100) <= width / 2;
}

// ── Item 4.3 reference: spread buckets and the confidence label ──────────────
const CONF = { agreeSpread: 250, disagreeSpread: 500, highMinComps: 6, highMinLeases: 2, lowBelowComps: 5 };

function spreadBucket(spread) {
  if (spread === null || spread === undefined) return 'no estimate';
  if (spread < CONF.agreeSpread) return 'agree (spread under 250)';
  if (spread < CONF.disagreeSpread) return 'moderate (spread 250-499)';
  return 'disagree (spread 500 or more)';
}

// Starting definition used in Appendix G.5: spread and comp count only.
function confidenceSimple(row) {
  if (row.est === null || row.n < HEADLINE_MIN_COMPS) return null;
  if (row.spread >= CONF.disagreeSpread) return 'Low';
  if (row.spread < CONF.agreeSpread && row.n >= CONF.highMinComps) return 'High';
  return 'Medium';
}

// The full rule of spec 4.3 (adds the "fewer than 5 comps", "no confirmed
// lease" and "no comp priced near the range" conditions).
function confidenceLabel(row) {
  if (row.est === null || row.n < HEADLINE_MIN_COMPS) return null;
  if (row.spread >= CONF.disagreeSpread || row.n < CONF.lowBelowComps || row.leased === 0 || row.nearRange === false) return 'Low';
  if (row.spread < CONF.agreeSpread && row.n >= CONF.highMinComps && row.leased >= CONF.highMinLeases) return 'High';
  return 'Medium';
}

// ── buckets for the breakdown tables ─────────────────────────────────────────
function rentBand(rent) {
  if (rent < 2500) return 'under 2,500';
  if (rent < 3500) return '2,500-3,499';
  if (rent < 5000) return '3,500-4,999';
  return '5,000 and up';
}

function compCountBand(n) {
  if (n < HEADLINE_MIN_COMPS) return 'under 4 comps';
  if (n <= 5) return '4-5 comps';
  if (n <= 11) return '6-11 comps';
  return '12 or more comps';
}

function sourceMixLabel(row) {
  if (row.mix && row.mix.rincon > 0) return 'includes Rincon leases';
  if (row.mix && row.mix.asking > 0) return 'MLS leases plus asking';
  return 'MLS leases only';
}

// ── the summary ──────────────────────────────────────────────────────────────
const share = (k, n) => (n ? k / n : null);

function summarizeView(rows) {
  const n = rows.length;
  const abs = rows.map(r => Math.abs(r.rent - r.est));
  const signed = rows.map(r => r.rent - r.est);
  const within = d => abs.filter(a => a <= d).length;
  const band = w => rows.filter(r => bandHit(r, w)).length;
  const bandHalfUp = w => rows.filter(r => bandHitHalfUp(r, w)).length;
  return {
    n,
    typicalMiss: median(abs),
    meanMiss: mean(abs),
    within100: share(within(100), n),
    within200: share(within(200), n),
    within300: share(within(300), n),
    within300Ci: wilson(within(300), n),
    band200: share(band(200), n),
    band200Ci: wilson(band(200), n),
    band300: share(band(300), n),
    band500: share(band(500), n),
    band200HalfUp: share(bandHalfUp(200), n),
    medianBias: median(signed), // signed rent minus estimate: positive = the tool ran low
    meanBias: mean(signed),
  };
}

/**
 * Summarises one set of target rows.
 *   targets      how many targets were tried
 *   estimated    targets with an estimate at all
 *   thin         estimated targets with fewer than 4 counted comps
 *   coverage     share of ALL targets that get a recommended range (4+ comps)
 *   all          accuracy over every estimated target (Appendix G style)
 *   ranged       accuracy over targets that get a range (the product view),
 *                incl. the $200 recommended range hit rate and, against the
 *                suggested price, within-$300 and bias
 */
function summarize(rows) {
  const estimated = rows.filter(r => r.est !== null && r.est !== undefined);
  const ranged = estimated.filter(r => r.n >= HEADLINE_MIN_COMPS);
  const out = {
    targets: rows.length,
    estimated: estimated.length,
    thin: estimated.length - ranged.length,
    rangedCount: ranged.length,
    coverage: share(ranged.length, rows.length),
    all: estimated.length ? summarizeView(estimated) : null,
    ranged: null,
  };
  // Per 100 reports TRIED (every target, including those that got no range, which are neither right nor wrong):
  // how many got a suggested price within RIGHT_WITHIN of the signed rent, and how many were off by more than
  // BADLY_WRONG_OVER. These are the two numbers rule (c) of the acceptance rule compares (candidates.js).
  out.rightPer100 = 0;
  out.badlyWrongPer100 = 0;
  if (rows.length) {
    let right = 0, badly = 0;
    for (const r of ranged) {
      const miss = Math.abs(r.rent - headlineRange(r).listPrice);
      if (miss <= ACCEPTANCE.rightWithinDollars) right++;
      else if (miss > ACCEPTANCE.badlyWrongOverDollars) badly++;
    }
    out.rightPer100 = (100 * right) / rows.length;
    out.badlyWrongPer100 = (100 * badly) / rows.length;
  }
  if (ranged.length) {
    const view = summarizeView(ranged);
    const heads = ranged.map(r => ({ r, h: headlineRange(r) }));
    const rangeHits = heads.filter(({ r, h }) => r.rent >= h.low && r.rent <= h.high).length;
    const near = heads.filter(({ r, h }) => Math.abs(r.rent - h.listPrice) <= 300).length;
    const biasVsPrice = heads.map(({ r, h }) => r.rent - h.listPrice);
    view.rangeHit200 = rangeHits / ranged.length;
    view.rangeHit200Ci = wilson(rangeHits, ranged.length);
    view.within300OfSuggested = near / ranged.length;
    view.within300OfSuggestedCount = near;
    view.within300OfSuggestedCi = wilson(near, ranged.length);
    view.medianBiasVsSuggested = median(biasVsPrice);
    view.rangeHit200Count = rangeHits;
    out.ranged = view;
  }
  return out;
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k === null || k === undefined) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return groups;
}

/** summarize() per group; groups with fewer than minN ESTIMATED leases are dropped. */
function summarizeBy(rows, keyFn, minN = 0) {
  const out = {};
  for (const [key, group] of groupBy(rows, keyFn)) {
    const s = summarize(group);
    if (s.estimated >= minN) out[key] = s;
  }
  return out;
}

const LA_BORDER_SET = new Set(LA_BORDER_CITIES.map(c => c.toLowerCase()));
function isLaBorder(city) { return !!city && LA_BORDER_SET.has(String(city).trim().toLowerCase()); }

// The MLS county field -> 'ventura' | 'other' | null (unknown). Tolerant of case, spaces and a trailing
// "County" ("Ventura", "ventura county", " VENTURA "). An empty value or a placeholder is unknown, never a
// county of its own: "Other County" is what CRMLS records when the county is not in its pick-list (3 closed
// Woodland Hills / Malibu leases in the 2026-10-17 pull), so it tells us nothing and the city list decides.
const COUNTY_PLACEHOLDERS = new Set(['', 'unknown', 'n/a', 'na', 'none', 'null', '-', 'other county', 'other']);
function countyOf(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase().replace(/\s+county$/, '').trim();
  if (COUNTY_PLACEHOLDERS.has(v)) return null;
  return v === 'ventura' ? 'ventura' : 'other';
}

// The two published county groups. A lease with a known county goes by the county; one with no county falls
// back to the old city list (an LA-border city counts as "other counties"). Null only when there is neither.
function countyGroupOf(row) {
  const c = countyOf(row.county);
  if (c) return c === 'ventura' ? COUNTY_LABELS.ventura : COUNTY_LABELS.other;
  if (!row.city) return null;
  return isLaBorder(row.city) ? COUNTY_LABELS.other : COUNTY_LABELS.ventura;
}
function hasKnownCounty(row) { return countyOf(row.county) !== null; }

// How many records carry a usable county, and which values the feed uses (counts only; for the report and the run log).
function countyFill(records, field = 'CountyOrParish') {
  const values = new Map();
  let known = 0;
  for (const r of records) {
    const raw = r[field];
    if (countyOf(raw) !== null) known++;
    const key = typeof raw === 'string' && raw.trim() ? raw.trim() : '(blank)';
    values.set(key, (values.get(key) || 0) + 1);
  }
  return {
    records: records.length,
    known,
    unknown: records.length - known,
    knownShare: records.length ? known / records.length : null,
    values: [...values.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 12).map(([value, count]) => ({ value, count })),
  };
}

const GROUPINGS = {
  countyGroup: countyGroupOf,
  region: r => (r.city ? (isLaBorder(r.city) ? REGION_LABELS.laBorder : REGION_LABELS.venturaOnly) : null),
  area: r => (r.area === 'core' ? 'Ventura core' : r.area ? 'Ventura-area outside the core' : null),
  city: r => (r.city ? r.city.trim() : null),
  propertyType: r => r.type,
  rentBand: r => rentBand(r.rent),
  compCount: r => (r.est === null || r.est === undefined ? null : compCountBand(r.n)),
  agreement: r => (r.est === null || r.est === undefined ? null : spreadBucket(r.spread)),
  confidence: r => confidenceLabel(r),
  confidenceSimple: r => confidenceSimple(r),
  sourceMix: r => (r.est === null || r.est === undefined ? null : sourceMixLabel(r)),
  targetKind: r => (r.kind === 'rincon' ? 'Rincon-only (portfolio)' : 'MLS-only'),
};

function summarizeAllGroupings(rows, minN = 0) {
  const out = {};
  for (const [name, fn] of Object.entries(GROUPINGS)) out[name] = summarizeBy(rows, fn, minN);
  return out;
}

module.exports = {
  median, mean, wilson, roundToStep, headlineRange, bandHit, bandHitHalfUp, CONF,
  spreadBucket, confidenceSimple, confidenceLabel, rentBand, compCountBand, sourceMixLabel,
  summarizeView, summarize, groupBy, summarizeBy, summarizeAllGroupings, GROUPINGS, isLaBorder,
  countyOf, countyGroupOf, hasKnownCounty, countyFill,
};
