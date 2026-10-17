/**
 * backtest/report.js
 * Turns a finished run into the three outputs (CMA-QUALITY-SPEC.md A.1, A.10):
 *
 *   report.md        aggregates only (percentages, counts, dollars of typical
 *                    miss). Safe to share. No addresses, no listing ids.
 *   scorecard.json   the committed, publishable summary. Aggregates only: every
 *                    group has 20 or more leases, and assertAggregatesOnly()
 *                    refuses to write anything that looks like an address, a
 *                    zip code, a listing key, a UUID or an email.
 *   detail.csv /     per-target rows including addresses, written ONLY under
 *   worst-misses.csv backtest/out/ (git-ignored) for local review.
 *
 * Also: the staff accuracy line and the per-label track record, generated from
 * the scorecard (never typed in), so a re-run keeps them true (A.12 item 5).
 */
const { G } = require('./appendix-g');
const M = require('./metrics');
const { MIN_GROUP_N, TRACK_RECORD_MIN_LEASES, RENTCAST_SHARE_PERCENT, LA_BORDER_CITIES, REGION_LABELS, MAX_DATA_AGE_DAYS } = require('./constants');
const { fidelityValidity } = require('./provenance');
const { LIVE_MLS_MONTHS, LIVE_RINCON_MONTHS, POOLS } = require('./candidates');
const { verdictLine } = require('./judging');

// ── formatting ───────────────────────────────────────────────────────────────
const nz = x => x !== null && x !== undefined && !Number.isNaN(x);
const A = s => (s && s.all) || {}; // a group or period with no estimates has all: null
const pct = (x, d = 0) => (nz(x) ? `${(x * 100).toFixed(d)}%` : '-');
const usd = x => (nz(x) ? `$${Math.round(x).toLocaleString('en-US')}` : '-');
const signedUsd = x => (nz(x) ? `${x < 0 ? '-' : '+'}$${Math.abs(Math.round(x)).toLocaleString('en-US')}` : '-');
const signed = (x, d) => { const t = x.toFixed(d); return Number(t) === 0 ? (d ? (0).toFixed(d) : '0') : `${x > 0 ? '+' : ''}${t}`; }; // never "-0" or "-0.0"
const pts = x => (nz(x) ? signed(x, 0) : '-');
const pts1 = x => (nz(x) ? signed(x, 1) : '-');
const pct1 = x => (nz(x) ? Math.round(x * 1000) / 10 : null); // whole-and-tenth percent for JSON

function table(headers, rows) {
  const line = cells => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

// ── aggregates-only guard ────────────────────────────────────────────────────
const FORBIDDEN_KEYS = /^(address|addr|street|rents?|rows?|listing(key|id)?|key|signedrent|detail)$/i;
const FORBIDDEN_VALUES = [
  [/\b\d{5}(-\d{4})?\b/, 'a zip code'],
  [/\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){0,3}(?:st|street|ave|avenue|blvd|boulevard|dr|drive|rd|road|ln|lane|ct|court|pl|place|way|cir|circle|ter|terrace|hwy|pkwy)\b/i, 'a street address'],
  [/[0-9a-f]{32}/i, 'a listing key'],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i, 'a UUID'],
  [/@/, 'an email address'],
];

function assertAggregatesOnly(value, path = 'scorecard') {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    for (const [re, what] of FORBIDDEN_VALUES) {
      if (re.test(value)) throw new Error(`Aggregates-only guard: ${path} contains ${what} ("${value.slice(0, 40)}").`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertAggregatesOnly(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(k)) throw new Error(`Aggregates-only guard: ${path} has a "${k}" field, which could hold individual records.`);
    for (const [re, what] of FORBIDDEN_VALUES) {
      if (re.test(k)) throw new Error(`Aggregates-only guard: ${path} has a key that looks like ${what} ("${k}").`);
    }
    assertAggregatesOnly(v, `${path}.${k}`);
  }
}

// ── scorecard ────────────────────────────────────────────────────────────────
function viewBlock(s) {
  if (!s) return null;
  const a = s.all, r = s.ranged;
  return {
    targets: s.targets,
    estimated: s.estimated,
    thin: s.thin,
    rangedCount: s.rangedCount,
    coveragePct: pct1(s.coverage),
    all: a && {
      n: a.n,
      typicalMiss: Math.round(a.typicalMiss),
      meanMiss: Math.round(a.meanMiss),
      within100Pct: pct1(a.within100),
      within200Pct: pct1(a.within200),
      within300Pct: pct1(a.within300),
      within300CiPct: a.within300Ci && [pct1(a.within300Ci.low), pct1(a.within300Ci.high)],
      band200Pct: pct1(a.band200),
      band300EvalPct: pct1(a.band300),
      band500EvalPct: pct1(a.band500),
      medianBias: Math.round(a.medianBias),
    },
    ranged: r && {
      n: r.n,
      typicalMiss: Math.round(r.typicalMiss),
      within300Pct: pct1(r.within300),
      rangeHit200Pct: pct1(r.rangeHit200),
      rangeHit200Count: r.rangeHit200Count,
      rangeHit200CiPct: r.rangeHit200Ci && [pct1(r.rangeHit200Ci.low), pct1(r.rangeHit200Ci.high)],
      within300OfSuggestedPct: pct1(r.within300OfSuggested),
      within300OfSuggestedCount: r.within300OfSuggestedCount,
      within300OfSuggestedCiPct: r.within300OfSuggestedCi && [pct1(r.within300OfSuggestedCi.low), pct1(r.within300OfSuggestedCi.high)],
      medianBiasVsSuggested: Math.round(r.medianBiasVsSuggested),
    },
  };
}

function groupBlocks(rows, minN = MIN_GROUP_N) {
  const out = {};
  const groups = M.summarizeAllGroupings(rows, minN);
  for (const [name, byKey] of Object.entries(groups)) {
    out[name] = {};
    for (const [key, s] of Object.entries(byKey)) out[name][key] = viewBlock(s);
  }
  return out;
}

function scoreboardFor(rows) {
  return { county: viewBlock(M.summarize(rows)), core: viewBlock(M.summarize(rows.filter(r => r.area === 'core'))) };
}

// Counts that can be large go through here before they reach scorecard text: "41,424", never a bare
// five-digit number, which the aggregates-only guard would (rightly) read as a zip code.
const fmtCount = n => Number(n).toLocaleString('en-US');
const wholePercent = share => Math.round(share * 100); // the one rounding used for the LA-border share everywhere

// LA-border cities vs the rest of the Ventura-area box. A side is published only with MIN_GROUP_N or more leases.
function regionBlocks(rows) {
  const la = rows.filter(x => M.isLaBorder(x.city));
  const rest = rows.filter(x => x.city && !M.isLaBorder(x.city));
  const side = rs => (rs.length >= MIN_GROUP_N ? { ...viewBlock(M.summarize(rs)), medianRent: Math.round(M.median(rs.map(x => x.rent))) } : null);
  return { laBorder: side(la), venturaOnly: side(rest) };
}

function daysBetweenDates(a, b) {
  return Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);
}

/**
 * @param {object} r - the run results (see run.js)
 * @returns {object} the scorecard (validated aggregates-only)
 */
function buildScorecard(r) {
  const base = r.mls.mls.baseline, bundle = r.mls.mls.size25_item2;
  const trustReasons = [];
  if (!r.selfTests.leak) trustReasons.push('leak self-test was not run in this run');
  else if (!r.selfTests.leak.pass) trustReasons.push('leak self-test did not pass in this run');
  // The fidelity result counts only for the same data pull AND the same code (content hashes of every file the replay depends on).
  const fidelity = fidelityValidity(r.selfTests.fidelity, r.trackedHashes, r.cachePulledAt);
  if (!fidelity.valid) trustReasons.push(fidelity.reason);
  if (r.partial) trustReasons.push(`partial run (${(r.partialReasons && r.partialReasons.length ? r.partialReasons.join(', ') : 'limited targets')})`);
  // The pool settings the replay used must be the product's own settings.
  const driftedPools = Object.values(POOLS).filter(p => p.mlsMonths !== LIVE_MLS_MONTHS || p.rinconMonths !== LIVE_RINCON_MONTHS).map(p => p.id);
  if (driftedPools.length) trustReasons.push(`the replay's lookback differs from the product's (${LIVE_MLS_MONTHS} months of closed leases, ${LIVE_RINCON_MONTHS} months of Rincon leases) in pool(s): ${driftedPools.join(', ')}`);
  // The saved data must be recent and must reach back far enough for every target.
  const dataPulledOn = r.dataPulledOn || null;
  if (!dataPulledOn) trustReasons.push('the date the data was pulled is unknown');
  else if (daysBetweenDates(dataPulledOn, r.runDate) > MAX_DATA_AGE_DAYS) trustReasons.push(`data older than ${MAX_DATA_AGE_DAYS} days (pulled ${dataPulledOn}); re-pull with --refresh`);
  if (r.dataCoverage && !r.dataCoverage.ok) trustReasons.push(`the saved data starts ${r.dataCoverage.dataFrom} but the targets need data from ${r.dataCoverage.requiredFrom}; re-pull with --refresh (and --data-from if needed)`);
  // What the run sent over the network is measured, not assumed.
  if (!r.network || !r.network.measured) trustReasons.push('network use was not measured');
  else if (r.network.requestsDuringReplay > 0) trustReasons.push(`the replay made ${fmtCount(r.network.requestsDuringReplay)} outbound request(s); it must make none`);
  else if (r.network.rentcastRequests > 0 || r.network.anthropicRequests > 0 || r.network.otherHostRequests > 0) trustReasons.push('the run attempted a RentCast, Anthropic or other outside request');

  const laShare = base.length ? base.filter(x => M.isLaBorder(x.city)).length / base.length : 0;
  const sc = {
    schema: 1,
    generatedAt: r.generatedAt,
    testedOn: r.runDate,
    dataPulledOn,
    dataPulledAt: r.cachePulledAt,
    dataThrough: r.dataThrough,
    trusted: trustReasons.length === 0,
    trustReasons,
    methodVersion: 'current-tool-2026-10',
    methodNote: 'baseline = the production comp-matching code as it runs today (bedrooms and property type only); size25_item2 = the same code with the proposed Phase B rules simulated',
    scope: {
      county: `the Ventura-area service box (Ventura, Oxnard, Camarillo, Simi Valley, Thousand Oaks and the Conejo Valley border); about ${wholePercent(laShare)}% of the leases are in the Calabasas / Agoura Hills / Westlake Village / West Hills border area (also reported separately as "${REGION_LABELS.laBorder}")`,
      core: 'the Ventura core box',
    },
    pool: {
      mls: `MLS closed leases from CRMLS (Recore) dated before the day each lease closed, ${POOLS.mls.mlsMonths}-month lookback`,
      full: `MLS leases plus as-of asking listings (original list price) plus Rincon\'s own leases (${POOLS.full.rinconMonths}-month lookback)`,
      rentcast: `not included (RentCast as-of snapshot, A2, is not built); RentCast is about ${RENTCAST_SHARE_PERCENT}% of the comps staff see`,
      timing: `as of the day before the lease closed; staff price a home at listing time (median gap ${r.medianGapDays === null || r.medianGapDays === undefined ? 'unknown' : r.medianGapDays} days in this data), so the figures are optimistic`,
    },
    network: r.network || { measured: false },
    selfTests: {
      leak: r.selfTests.leak && {
        pass: r.selfTests.leak.pass,
        sample: r.selfTests.leak.sample,
        cleanTypicalMiss: Math.round(r.selfTests.leak.clean.typicalMiss),
        singleLeakTypicalMiss: Math.round(r.selfTests.leak.single.typicalMiss),
        heavyLeakTypicalMiss: Math.round(r.selfTests.leak.heavy.typicalMiss),
      },
      fidelity: r.selfTests.fidelity && { pass: r.selfTests.fidelity.pass, subjects: r.selfTests.fidelity.subjects, validForThisCodeAndData: fidelity.valid },
    },
    split: { holdoutStart: r.config.holdoutStart, tuneTargets: r.counts.tune, holdoutTargets: r.counts.holdout },
    minGroupN: MIN_GROUP_N,
    overall: {
      baseline: scoreboardFor(base),
      size25_item2: scoreboardFor(bundle),
    },
    byPool: {},
    groups: {
      baseline: { county: groupBlocks(base), core: groupBlocks(base.filter(x => x.area === 'core')) },
      size25_item2: { county: groupBlocks(bundle), core: groupBlocks(bundle.filter(x => x.area === 'core')) },
    },
    regions: {
      definition: `"${REGION_LABELS.laBorder}" are ${LA_BORDER_CITIES.join(', ')}; "${REGION_LABELS.venturaOnly}" is every other city in the box`,
      shareOfLeasesPct: pct1(laShare),
      baseline: regionBlocks(base),
      size25_item2: regionBlocks(bundle),
    },
    rincon: r.rincon && r.rincon.headline && {
      targets: r.rincon.headline.baseline.targets,
      description: `Rincon single-home leases started in the last 12 months after the plausibility screen; signed rent is the target; pool = full (${LIVE_RINCON_MONTHS}-month Rincon lookback)`,
      baseline: viewBlock(r.rincon.headline.baseline),
      size25_item2: viewBlock(r.rincon.headline.size25_item2),
      note: 'signed rent is not always market rent: a unit re-priced after sitting vacant signs below its first ask (no asking-price history exists yet, A3)',
    },
    outcomes: r.outcomes && { ...r.outcomes.counts },
  };
  if (r.listingTime) {
    sc.listingTimeCheck = {
      description: 'MLS leases re-run as of the day they went on the market instead of the day before they closed',
      leases: r.listingTime.targets,
      skipped: r.listingTime.skipped,
      medianDaysListedBeforeClose: r.listingTime.medianGapDays,
      closeDateBasis: { baseline: scoreboardFor(r.listingTime.sameLeases.baseline), size25_item2: scoreboardFor(r.listingTime.sameLeases.size25_item2) },
      listingTimeBasis: { baseline: scoreboardFor(r.listingTime.rows.baseline), size25_item2: scoreboardFor(r.listingTime.rows.size25_item2) },
    };
  }
  for (const [poolId, methods] of Object.entries(r.mls)) {
    if (poolId === 'mls') continue;
    sc.byPool[poolId] = {};
    for (const [methodId, rows] of Object.entries(methods)) sc.byPool[poolId][methodId] = scoreboardFor(rows);
  }
  assertAggregatesOnly(sc);
  return sc;
}

// ── staff-facing sentences generated from the scorecard ──────────────────────
// Rules: a rate is rounded ONCE, from the raw count (k of n), to a whole "N in
// 10" with a tie going DOWN (so 75% is "7 in 10", 73% is "7 in 10", 35% is "3
// in 10"); an interval is widened outward (low floored, high ceilinged) so the
// words never claim more than the data; a label needs TRACK_RECORD_MIN_LEASES
// leases behind it or the sentence says "too few tests to say yet"; the test did
// not include RentCast listings and the sentence says so. No "accurate to", no
// promises, no time statistic.
function inTen(k, n) {
  return Math.max(0, Math.ceil((k / n) * 10 - 0.5 - 1e-9));
}
function inTenRange(low, high) {
  return [Math.max(0, Math.floor(low / 10 + 1e-9)), Math.min(10, Math.ceil(high / 10 - 1e-9))];
}
function rentcastNote(scorecard) {
  const excluded = !scorecard.pool || !scorecard.pool.rentcast || /not included/.test(scorecard.pool.rentcast);
  return excluded ? `RentCast listings, about ${RENTCAST_SHARE_PERCENT}% of the comps staff see, were not part of this test.` : '';
}
function timesInTen(k, n, ciPct) {
  const main = inTen(k, n);
  const head = `about ${main} ${main === 1 ? 'time' : 'times'} in 10`;
  if (!ciPct) return head;
  const [lo, hi] = inTenRange(ciPct[0], ciPct[1]);
  return `${head} (roughly ${lo} to ${hi} times in 10)`;
}

const AREA_LABELS = { county: 'Ventura-area', core: 'Ventura core' };
const leaseWord = n => (n === 1 ? 'lease' : 'leases');
const dataDatePhrase = scorecard => (scorecard.dataPulledOn ? `data pulled ${scorecard.dataPulledOn}` : 'data date unknown');

function accuracyLine(scorecard, { method = 'baseline', area = 'county', areaLabel } = {}) {
  const label = areaLabel || AREA_LABELS[area] || AREA_LABELS.county;
  const block = scorecard.overall[method][area];
  if (!block || !block.ranged) return null;
  const rg = block.ranged;
  const note = rentcastNote(scorecard);
  if (rg.n < TRACK_RECORD_MIN_LEASES) return `Blind-tested on only ${rg.n} past ${label} ${leaseWord(rg.n)}: too few tests to say yet (${dataDatePhrase(scorecard)}).${note ? ` ${note}` : ''}`;
  const miss = Math.ceil(rg.typicalMiss / 50) * 50; // rounded UP: never claims a smaller miss than measured
  const hit = timesInTen(rg.within300OfSuggestedCount, rg.n, rg.within300OfSuggestedCiPct);
  // Coverage next to accuracy: some homes get no range at all, and the sentence must not hide that. Rounded down.
  const coverage = block.coveragePct === null || block.coveragePct === undefined ? '' : `; a recommended range could be shown for ${Math.floor(block.coveragePct + 1e-9)}% of the homes tried`;
  return `Blind-tested on ${rg.n} past ${label} ${leaseWord(rg.n)}: typical miss about $${miss.toLocaleString('en-US')}; the suggested price landed within $300 of the signed rent ${hit}${coverage} (${dataDatePhrase(scorecard)}).${note ? ` ${note}` : ''}`;
}

function labelHitRates(scorecard, label, { method = 'size25_item2', area = 'county' } = {}) {
  const g = scorecard.groups[method] && scorecard.groups[method][area] && scorecard.groups[method][area].confidence;
  const b = g && g[label];
  if (!b || !b.ranged) return { n: 0, enough: false };
  const rg = b.ranged;
  return {
    n: rg.n, enough: rg.n >= TRACK_RECORD_MIN_LEASES,
    rangeHitCount: rg.rangeHit200Count, rangeHitCiPct: rg.rangeHit200CiPct,
    within300Count: rg.within300OfSuggestedCount, within300CiPct: rg.within300OfSuggestedCiPct,
  };
}

function trackRecordSentence(scorecard, label, opts = {}) {
  const h = labelHitRates(scorecard, label, opts);
  if (!h.enough) return `${label} confidence: too few tests to say yet.`;
  const where = opts.areaLabel || AREA_LABELS[opts.area || 'county'] || AREA_LABELS.county;
  const note = rentcastNote(scorecard);
  return `${label} confidence. In blind tests on ${h.n} past ${where} ${leaseWord(h.n)}, reports like this held the signed rent inside the recommended range ${timesInTen(h.rangeHitCount, h.n, h.rangeHitCiPct)} and landed within $300 of the suggested price ${timesInTen(h.within300Count, h.n, h.within300CiPct)}.${note ? ` ${note}` : ''}`;
}

// ── detail files (local only) ────────────────────────────────────────────────
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function detailCsv(entries) {
  const head = ['pool', 'method', 'kind', 'key', 'date', 'address', 'city', 'type', 'area', 'beds', 'sqft', 'signed_rent', 'estimate', 'signed_minus_estimate', 'counted_comps', 'leased_comps', 'spread', 'confidence_label'];
  const lines = [head.join(',')];
  for (const { pool, method, rows } of entries) {
    for (const r of rows) {
      lines.push([pool, method, r.kind, r.key, r.date, r.address, r.city, r.type, r.area, r.beds, r.sqft, r.rent, r.est, r.est === null ? '' : r.rent - r.est, r.n, r.leased, r.spread, M.confidenceLabel(r) || ''].map(csvCell).join(','));
    }
  }
  return lines.join('\n') + '\n';
}

function worstMissesCsv(rows, n = 10) {
  const est = rows.filter(r => r.est !== null).map(r => ({ r, miss: Math.abs(r.rent - r.est) })).sort((a, b) => b.miss - a.miss).slice(0, n);
  const lines = ['address,city,date,signed_rent,estimate,signed_minus_estimate,counted_comps'];
  for (const { r } of est) lines.push([r.address, r.city, r.date, r.rent, r.est, r.rent - r.est, r.n].map(csvCell).join(','));
  return lines.join('\n') + '\n';
}

// ── the markdown report ──────────────────────────────────────────────────────
function summaryRow(label, s, ref) {
  const a = s.all;
  if (!a) return [label, `${s.estimated}`, pct(s.coverage), '-', '-', '-', '-', '-'];
  return [
    label,
    `${s.estimated} (${s.thin} thin)`,
    pct(s.coverage),
    usd(a.typicalMiss),
    usd(a.meanMiss),
    `${pct(a.within100)} / ${pct(a.within200)} / ${pct(a.within300)}`,
    `${pct(a.band200)} / ${pct(a.band300)} / ${pct(a.band500)}`,
    signedUsd(a.medianBias),
  ];
}

function gRefRow(label, g, cov) {
  return [label, `${g.n} (${g.thin} thin)`, nz(cov) ? `${cov}%` : '-', usd(g.miss), '-', g.within.map(x => `${x}%`).join(' / '), g.band.map(x => `${x}%`).join(' / '), nz(g.bias) ? signedUsd(g.bias) : '-'];
}

const SUMMARY_HEAD = ['Method', 'Leases estimated', 'Coverage (gets a range)', 'Typical miss (median)', 'Mean miss', 'Within $100 / $200 / $300', 'Range hit at $200 / $300* / $500* wide', 'Median signed rent minus estimate'];

function diffLine(label, mine, ref, refCov, myCov) {
  if (!mine || !mine.all) return `- ${label}: no result`;
  const parts = [];
  parts.push(`typical miss ${usd(mine.all.typicalMiss)} vs ${usd(ref.miss)} (${signedUsd(mine.all.typicalMiss - ref.miss)})`);
  ['100', '200', '300'].forEach((d, i) => {
    const v = [mine.all.within100, mine.all.within200, mine.all.within300][i];
    parts.push(`within $${d} ${pct(v)} vs ${ref.within[i]}% (${pts(v * 100 - ref.within[i])} pts)`);
  });
  if (nz(refCov) && nz(myCov)) parts.push(`coverage ${pct(myCov)} vs ${refCov}% (${pts(myCov * 100 - refCov)} pts)`);
  const worstPts = Math.max(...[mine.all.within100, mine.all.within200, mine.all.within300].map((v, i) => Math.abs(v * 100 - ref.within[i])));
  const verdict = worstPts <= 3 && Math.abs(mine.all.typicalMiss - ref.miss) <= 50 ? 'matches' : worstPts <= 6 && Math.abs(mine.all.typicalMiss - ref.miss) <= 100 ? 'close' : 'GAP';
  return `- **${label}: ${verdict}.** ${parts.join('; ')}.`;
}

function groupTable(byKey, order) {
  const keys = (order || Object.keys(byKey)).filter(k => byKey[k]);
  const rows = keys.map(k => {
    const s = byKey[k];
    const rg = s.ranged;
    return [k, s.estimated, pct(s.coverage), usd(A(s).typicalMiss), pct(A(s).within300), rg ? pct(rg.rangeHit200) : '-', rg ? pct(rg.within300OfSuggested) : '-'];
  });
  return table(['Group', 'Leases', 'Coverage', 'Typical miss', 'Within $300', 'Range hit ($200)', 'Within $300 of suggested price'], rows);
}

const GROUP_TITLES = {
  propertyType: 'property type', rentBand: 'rent level (signed rent per month)', compCount: 'number of counted comps', agreement: 'how closely the comps agree',
  sourceMix: 'where the counted comps came from', area: 'area', city: 'city', confidence: 'confidence label (spec 4.3)', targetKind: 'MLS-only vs Rincon-only',
};

const ORDER = {
  propertyType: ['single_family', 'townhouse', 'condo'],
  rentBand: ['under 2,500', '2,500-3,499', '3,500-4,999', '5,000 and up'],
  compCount: ['4-5 comps', '6-11 comps', '12 or more comps', 'under 4 comps'],
  agreement: ['agree (spread under 250)', 'moderate (spread 250-499)', 'disagree (spread 500 or more)'],
  confidence: ['High', 'Medium', 'Low'],
  confidenceSimple: ['High', 'Medium', 'Low'],
  sourceMix: ['MLS leases only', 'MLS leases plus asking', 'includes Rincon leases'],
  area: ['Ventura core', 'Ventura-area outside the core'],
};

// What pricing at listing time (instead of the day before closing) does to the numbers, from the run's own data.
function listingTimeFacts(lt, sum) {
  if (!lt) return null;
  const core = rows => rows.filter(x => x.area === 'core');
  const diffs = { within: [], miss: [], coverage: [] };
  for (const m of ['baseline', 'size25_item2']) {
    const d = sum(lt.sameLeases[m]), l = sum(lt.rows[m]);
    if (d.all && l.all) {
      diffs.within.push((d.all.within300 - l.all.within300) * 100);
      diffs.miss.push(l.all.typicalMiss - d.all.typicalMiss);
      diffs.coverage.push((d.coverage - l.coverage) * 100);
    }
  }
  const dCore = sum(core(lt.sameLeases.size25_item2)), lCore = sum(core(lt.rows.size25_item2));
  return { diffs, coreCoverageFrom: dCore.coverage, coreCoverageTo: lCore.coverage, leases: lt.targets };
}
const spanText = (xs, fmt) => {
  if (!xs.length) return 'n/a';
  const lo = Math.min(...xs), hi = Math.max(...xs);
  return fmt(lo) === fmt(hi) ? fmt(lo) : `${fmt(lo)} to ${fmt(hi)}`;
};

function renderReport(r, previousScorecard, scorecard) {
  const L = [];
  const mls = r.mls, base = mls.mls.baseline;
  const sum = rows => M.summarize(rows);
  const core = rows => rows.filter(x => x.area === 'core');

  L.push(`# Blind accuracy test: run of ${r.runDate}`);
  L.push('');
  L.push(`Generated ${r.generatedAt}. Aggregates only: no addresses or listing ids are in this file (they are in backtest/out/${r.runDate}/detail.csv, local only).`);
  L.push('');
  L.push('## How to read this');
  L.push('');
  L.push('This is a test of the rent tool against leases that already happened. For each past lease the real tool is run as it would have been the day before that lease closed (for Rincon\'s own leases, the day before move-in), using only what was known then, and its answer is compared with the rent that was actually signed. Nothing real is touched.');
  L.push('');
  L.push('- **Typical miss**: the middle (median) gap, in dollars, between the tool\'s estimate and the signed rent. Half of the leases missed by less, half by more.');
  L.push('- **Within $300**: the share of leases where the estimate was within $300 of the signed rent.');
  L.push('- **Range hit**: the share where the signed rent fell inside the $200 recommended range built around the estimate. Only a $200 range is ever recommended; the $300 and $500 widths in some tables are for comparison only.');
  L.push('- **Thin**: fewer than 4 counted comps, so no range would be shown. Thin leases are still counted in the accuracy columns, except where a column says "ranged only".');
  L.push('- **Coverage**: the share of all homes tried that get a recommended range at all.');
  L.push('- **Tune and hold-out**: older leases (used to choose a rule) and the newest three months (kept aside and judged once).');
  L.push('- **baseline** is today\'s tool; **size25_item2** is the same tool with the proposed size and MLS rules simulated.');
  L.push('- **LA-border cities** (Westlake Village, Agoura Hills, Calabasas, West Hills and a few others) are inside the test area but are Los Angeles County; they are reported separately below.');
  L.push('');
  if (scorecard) {
    L.push('## What staff would see (the exact sentences, generated from this run\'s scorecard)');
    L.push('');
    const preview = [accuracyLine(scorecard), ...['High', 'Medium', 'Low'].map(lab => trackRecordSentence(scorecard, lab))].filter(Boolean);
    for (const line of preview) L.push(`- ${line}`);
    L.push('');
    L.push(`Scorecard trusted: ${scorecard.trusted ? 'yes' : 'NO'}${scorecard.trusted ? '' : ` (${scorecard.trustReasons.join('; ')})`}. The first line is for today\'s tool; the label sentences use the proposed rules, which is what the labels will be calibrated on.`);
    L.push('');
  }
  L.push(`- Data: CRMLS closed leases from Recore pulled ${r.cachePulledAt} (${r.counts.closedRecords} records), Rincon's own leases and saved reports from Supabase (read-only). Newest target: ${r.dataThrough}.`);
  L.push(`- Targets: ${r.counts.countyTargets} MLS leases in the Ventura-area box (${r.counts.coreTargets} in the Ventura core), closed ${r.config.targetFrom} or later, like-for-like; ${r.counts.rinconTargets} Rincon single-home leases.`);
  L.push(`- Walk-forward split: tune = before ${r.config.holdoutStart} (${r.counts.tune} MLS targets), hold-out = ${r.config.holdoutStart} onward (${r.counts.holdout}).`);
  const net = r.network;
  L.push(net && net.measured
    ? `- Network use, measured by a guard that blocks anything but Recore and Supabase: Recore requests this session ${net.recoreRequests}, Supabase ${net.supabaseRequests}; RentCast requests ${net.rentcastRequests}; Anthropic calls ${net.anthropicRequests}; other hosts ${net.otherHostRequests}; requests of any kind during the replay itself ${net.requestsDuringReplay}. Run time ${r.elapsedSeconds}s.`
    : `- Recore requests this session: ${r.recoreRequests}. Network use was not measured in this run. Run time ${r.elapsedSeconds}s.`);
  L.push(`- What is tested: the real production code (lib/sources.js radius ladder, lib/property-matching.js dedupe, lib/analyze.js computeNumbers, lib/weighting.js) on comps rebuilt as of the day before each MLS lease closed (move-in date for Rincon leases). RentCast is not included (A2 is not built).`);
  L.push('');

  // drift alarm
  if (previousScorecard && previousScorecard.overall && previousScorecard.overall.baseline) {
    const prev = previousScorecard.overall.baseline.county.all, cur = sum(base).all;
    if (prev && cur && prev.n >= 300 && cur.n >= 300) {
      const drop = prev.within300Pct - cur.within300 * 100;
      if (drop > 5) L.push(`> **DRIFT ALARM:** the baseline's "within $300" fell ${drop.toFixed(1)} points since the ${previousScorecard.testedOn} scorecard (${prev.within300Pct}% to ${pct(cur.within300)}).\n`);
    }
  }

  // self tests
  L.push('## Self-tests (must pass before the scorecard is trusted)');
  L.push('');
  const lk = r.selfTests.leak;
  if (lk) {
    L.push(`**Leak self-test: ${lk.pass ? 'PASS' : 'FAIL'}** (${lk.sample} targets). Clean typical miss ${usd(lk.clean.typicalMiss)}; with the target's own lease planted once ${usd(lk.single.typicalMiss)} (within $25 of signed: ${pct(lk.clean.exactShare)} to ${pct(lk.single.exactShare)}); planted as ${lk.heavy.copies} comps ${usd(lk.heavy.typicalMiss)} (within $25: ${pct(lk.heavy.exactShare)}).`);
    L.push((lk.checks || []).map(c => `  - ${c.pass ? 'pass' : 'FAIL'}: ${c.label}`).join('\n'));
  } else L.push('**Leak self-test:** not run.');
  L.push('');
  const fd = r.selfTests.fidelity;
  if (fd) {
    const validity = fidelityValidity(fd, r.trackedHashes, r.cachePulledAt);
    L.push(`**Fidelity check: ${fd.pass ? 'PASS' : 'FAIL'}${validity.valid ? '' : ', BUT NOT VALID FOR TODAY'}** (${fd.subjects} subjects, run ${fd.ranAt || 'at the last refresh'}). The replay's CRMLS comp set (address, rent, status, distance) was compared with a live call to the real pullCrmlsComps().${validity.valid ? ' It was run on this data pull and on the code as it is today.' : ` **Not valid: ${validity.reason}.**`}`);
    L.push((fd.results || []).map((x, i) => `  - subject ${i + 1}: replay ${x.replayComps} comps, live ${x.liveComps} comps, only-in-replay ${x.onlyReplay}, only-in-live ${x.onlyLive} -> ${x.identical ? 'identical' : 'DIFFERENT'}`).join('\n'));
  } else L.push('**Fidelity check:** not run on this data pull (it needs about 10 free Recore requests: run with --refresh or --fidelity). The scorecard is not trusted until it has been.');
  L.push('');
  L.push(`**No-peeking guard:** every comp reaching the tool and every comp surviving into the numbers was checked to be dated before the as-of date (the day before the lease closed; the move-in date for Rincon leases); ${r.guardChecks} target runs passed with no violation (a violation throws and stops the run).`);
  L.push('');

  // headline vs appendix G
  L.push('## Headline: the real tool code, MLS closed leases only (the Appendix G pool)');
  L.push('');
  L.push('Coverage = share of ALL targets that get a recommended range (4 or more counted comps). Accuracy columns cover every target with an estimate, thin ones included, as Appendix G does. *Range hit at $300 and $500 wide are evaluation widths only; only the $200 range is ever recommended.');
  L.push('');
  for (const [label, pick] of [['Ventura core', rows => core(rows)], ['Ventura-area', rows => rows]]) {
    L.push(`### ${label}`);
    L.push('');
    const key = label === 'Ventura core' ? 'core' : 'county';
    const rows = [];
    for (const m of ['baseline', 'item2', 'size25', 'size25_item2']) {
      if (!mls.mls[m]) continue;
      rows.push(summaryRow(`This run: ${m}`, sum(pick(mls.mls[m]))));
      if (G[key][m]) rows.push(gRefRow(`Appendix G: ${m}`, G[key][m], G.coverage[key][m]));
    }
    L.push(table(SUMMARY_HEAD, rows));
    L.push('');
    L.push('Against Appendix G (matches = within 3 points and $50; close = within 6 points and $100):');
    for (const m of ['baseline', 'item2', 'size25_item2']) {
      if (G[key][m] && mls.mls[m]) L.push(diffLine(m, sum(pick(mls.mls[m])), G[key][m], G.coverage[key][m], sum(pick(mls.mls[m])).coverage));
    }
    L.push('');
  }
  L.push('Target counts: this run has ' + `${r.counts.countyTargets} Ventura-area targets (${r.counts.tune} tune + ${r.counts.holdout} hold-out); Appendix G had ${G.split.total} (${G.split.tune} + ${G.split.holdout}). MLS records get entered and corrected after the fact, so a re-pull on a later day differs by a few percent.`);
  L.push('');

  // size rule
  L.push('## The size-rule effect (Item 1 simulated on the real code)');
  L.push('');
  const sizeRows = [];
  for (const [lab, pick] of [['Ventura-area', x => x], ['Ventura core', core]]) {
    const b = sum(pick(mls.mls.baseline)), s = sum(pick(mls.mls.size25_item2));
    sizeRows.push([lab, usd(A(b).typicalMiss), usd(A(s).typicalMiss), pct(A(b).within300), pct(A(s).within300), pts((A(s).within300 - A(b).within300) * 100), pct(b.coverage), pct(s.coverage), pts((s.coverage - b.coverage) * 100)]);
  }
  L.push(table(['Area', 'Typical miss today', 'with size 25% + MLS rules', 'Within $300 today', 'with rules', 'Change (pts)', 'Coverage today', 'with rules', 'Change (pts)'], sizeRows));
  L.push('');
  L.push('The rule lifts accuracy and costs coverage in this MLS-only pool; the live pool also has RentCast, Rincon leases and listings, so the real coverage drop is smaller (see the pool table below).');
  L.push('');

  // Ventura-area vs LA-border
  {
    const la = x => M.isLaBorder(x.city), rest = x => x.city && !M.isLaBorder(x.city);
    const share = base.filter(la).length / (base.length || 1);
    L.push('## Ventura-area leases vs the LA-border cities');
    L.push('');
    L.push(`The test area also takes in the Los Angeles side of the Conejo Valley border (${LA_BORDER_CITIES.join(', ')}): ${wholePercent(share)}% of the leases tested. Those homes rent for more and the tool misses by more there, so the Ventura-area figures above mix two different markets. Whether staff price homes in those cities is a business question; the comp area was not trimmed because that would change every published number.`);
    L.push('');
    const regionRows = [];
    for (const m of ['baseline', 'size25_item2']) {
      for (const [lab, pick] of [[REGION_LABELS.venturaOnly, rest], [REGION_LABELS.laBorder, la]]) {
        const rows = mls.mls[m].filter(pick);
        const s = sum(rows);
        regionRows.push([m, lab, rows.length, usd(M.median(rows.map(x => x.rent))), s.estimated, pct(s.coverage), usd(A(s).typicalMiss), pct(A(s).within300), s.ranged ? pct(s.ranged.rangeHit200) : '-']);
      }
    }
    L.push(table(['Method', 'Group', 'Leases', 'Median signed rent', 'Estimated', 'Coverage', 'Typical miss', 'Within $300', 'Range hit ($200, ranged only)'], regionRows));
    L.push('');
  }

  // 95% intervals (A.6)
  L.push('## How sure are these hit rates? (95% intervals, Ventura-area, MLS pool)');
  L.push('');
  const ciRows = [];
  for (const m of ['baseline', 'size25_item2']) {
    const s = sum(mls.mls[m]);
    const ci = x => (x ? `${pct(x.low)} to ${pct(x.high)}` : '-');
    ciRows.push([m, A(s).n, `${pct(A(s).within300)} (${ci(A(s).within300Ci)})`, s.ranged ? `${pct(s.ranged.rangeHit200)} (${ci(s.ranged.rangeHit200Ci)})` : '-', s.ranged ? `${pct(s.ranged.within300OfSuggested)} (${ci(s.ranged.within300OfSuggestedCi)})` : '-']);
  }
  L.push(table(['Method', 'Leases', 'Within $300 of the estimate', 'Recommended $200 range held the signed rent (ranged reports only)', 'Within $300 of the suggested price (ranged reports only)'], ciRows));
  L.push('');

  // pools
  L.push('## Which comp pool (coverage and accuracy together)');
  L.push('');
  const poolRows = [];
  for (const poolId of Object.keys(mls)) {
    for (const m of ['baseline', 'size25_item2']) {
      if (!mls[poolId][m]) continue;
      const s = sum(mls[poolId][m]);
      poolRows.push([poolId, m, s.estimated, pct(s.coverage), usd(A(s).typicalMiss), pct(A(s).within300), s.ranged ? pct(s.ranged.rangeHit200) : '-']);
    }
  }
  L.push(table(['Pool', 'Method', 'Leases estimated', 'Coverage', 'Typical miss', 'Within $300', 'Range hit ($200, ranged only)'], poolRows));
  L.push('');
  L.push('Pools: mls = closed leases only; mls+asking = plus listings that were on the market at the lease date and leased later (priced at the ORIGINAL list price, because the final price may include cuts made after the lease date; the feed has no expired or withdrawn records, so these are survivors); full = plus Rincon\'s own leases (' + LIVE_RINCON_MONTHS + '-month lookback; only leases still current are in the table, so older ones are missing).');
  L.push('');

  if (mls.full && mls.full.baseline) {
    L.push('**Where the counted comps come from, full pool, today\'s code**');
    L.push('');
    L.push(groupTable(M.summarizeBy(mls.full.baseline, M.GROUPINGS.sourceMix, MIN_GROUP_N), ORDER.sourceMix));
    L.push('');
  }

  // calibration
  L.push('## Confidence labels (spec 4.3 calibration, Phase C will use these)');
  L.push('');
  L.push('Method size25_item2 (what Phase B would ship), MLS pool, only reports with a recommended range. "Simple" = the Appendix G starting definition (spread and comp count). "Full" = spec 4.3 including fewer than 5 comps, no confirmed lease, no comp near the range.');
  L.push('');
  for (const [lab, pick, key] of [['Ventura-area', x => x, 'county'], ['Ventura core', core, 'core']]) {
    const rows = pick(mls.mls.size25_item2);
    const simple = M.summarizeBy(rows, M.GROUPINGS.confidenceSimple);
    const full = M.summarizeBy(rows, M.GROUPINGS.confidence);
    const total = Object.values(simple).reduce((a, s) => a + s.rangedCount, 0);
    const trs = ['High', 'Medium', 'Low'].map(k => {
      const s = simple[k], f = full[k], g = G.confidence[key][k];
      return [k,
        s ? `${s.rangedCount} (${pct(s.rangedCount / total)}) vs ${g.share}%` : '-',
        s && s.ranged ? `${pct(s.ranged.rangeHit200)} vs ${g.rangeHit}%` : '-',
        s && s.ranged ? `${pct(s.ranged.within300OfSuggested)} vs ${g.within300}%` : '-',
        f ? `${f.rangedCount} (${f.ranged ? pct(f.ranged.rangeHit200) : '-'})` : '0'];
    });
    L.push(`### ${lab}`);
    L.push('');
    L.push(table(['Label', 'Reports (share) vs Appendix G share', 'Recommended range held the signed rent, vs Appendix G', 'Within $300 of suggested price, vs Appendix G', 'Full 4.3 rule: reports (range hit)'], trs));
    L.push('');
  }
  L.push('If High and Medium are not clearly different on the hold-out, Phase C should collapse them into one label (spec 4.3).');
  L.push('');

  // breakdowns
  L.push('## Where it is strong and weak (Ventura-area, MLS pool)');
  for (const [methodId, title] of [['baseline', 'Today\'s code'], ['size25_item2', 'With the proposed size and MLS rules']]) {
    L.push('');
    L.push(`### ${title}`);
    const groups = M.summarizeAllGroupings(mls.mls[methodId], MIN_GROUP_N);
    for (const name of ['propertyType', 'rentBand', 'compCount', 'agreement', 'sourceMix', 'area', 'city']) {
      if (!groups[name] || !Object.keys(groups[name]).length) continue;
      L.push('');
      L.push(`**By ${GROUP_TITLES[name] || name}** (groups under ${MIN_GROUP_N} leases are not shown)`);
      L.push('');
      L.push(groupTable(groups[name], ORDER[name]));
    }
  }
  L.push('');

  // rincon
  if (r.rincon) {
    L.push('## Rincon portfolio test (A.4, A.7)');
    L.push('');
    L.push(`${r.counts.rinconTargets} single-home leases started in the last 12 months after the plausibility screen (screened out: ${Object.entries(r.counts.rinconScreenedOut).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')}). Signed rent is the target; it is not always market rent (a re-priced unit signs below its first ask), and no asking-price history exists yet.`);
    L.push('');
    const rrows = [];
    for (const c of r.rincon.combos) {
      const s = sum(c.rows);
      rrows.push([c.label, s.estimated, s.thin, pct(s.coverage), usd(A(s).typicalMiss), `${pct(A(s).within100)} / ${pct(A(s).within200)} / ${pct(A(s).within300)}`, s.ranged ? pct(s.ranged.rangeHit200) : '-', signedUsd(A(s).medianBias), signedUsd(A(s).meanBias)]);
    }
    L.push(table(['Pool and method', 'Estimated', 'Thin', 'Coverage', 'Typical miss', 'Within $100 / $200 / $300', 'Range hit ($200)', 'Median signed minus estimate', 'Mean signed minus estimate'], rrows));
    L.push('');
    L.push(`Appendix G (research estimators, not the real code): ${G.rincon.estimable180Days} estimable with a 180-day Rincon lookback, typical miss ${usd(G.rincon.typicalMiss180Days)}; ${G.rincon.estimable24Months} estimable with a 24-month lookback (the live setting is ${LIVE_RINCON_MONTHS} months), typical miss ${usd(G.rincon.typicalMiss24Months)}; the estimate ran high. A negative "signed minus estimate" above means the estimate ran HIGH, the same direction.`);
    const rin = r.rincon.combos.find(c => c.isHeadline);
    if (rin) {
      const by = M.summarizeBy(rin.rows, M.GROUPINGS.agreement);
      L.push('');
      L.push('By agreement (headline Rincon row): ' + Object.entries(by).map(([k, s]) => `${k}: ${s.estimated} leases, typical miss ${usd(A(s).typicalMiss)}, within $300 ${pct(A(s).within300)}`).join('; ') + '.');
    }
    L.push('');
    const estRincon = r.rincon.combos.find(c => c.isHeadline) ? sum(r.rincon.combos.find(c => c.isHeadline).rows).rangedCount : 0;
    L.push(`Rincon-specific corrections (a weight, "Rincon first", an offset): **not eligible yet.** The rule is at least 100 estimable Rincon targets or 30 forward outcomes; there are ${estRincon} estimable targets and ${r.outcomes.counts.forwardMatches} forward outcomes.`);
    L.push('');
    L.push(`With ${r.counts.rinconTargets} leases a hit rate has a 95% interval of roughly plus or minus 11 points, so differences under about 10 points are not detectable.`);
    L.push('');
  }

  // walk-forward + candidates
  L.push('## Walk-forward split and tuning candidates (A.5, A.9)');
  L.push('');
  const split = r.config.holdoutStart;
  const wfRows = [];
  // The hold-out is shown for the method in production (baseline) so drift can be watched.
  // A candidate's hold-out is shown only once it has been judged (--judge-holdout), so a
  // candidate can never be chosen by looking at it (A.5).
  const judged = !!(r.candidates && (r.candidates.holdoutVerdicts || []).some(v => !v.stored && v.holdoutStart === r.config.holdoutStart));
  for (const m of ['baseline', 'size25_item2']) {
    const t = sum(mls.mls[m].filter(x => x.date < split)), h = sum(mls.mls[m].filter(x => x.date >= split));
    wfRows.push([m, 'tune', t.estimated, pct(t.coverage), usd(A(t).typicalMiss), pct(A(t).within300)]);
    if (m === 'baseline' || judged) wfRows.push([m, 'hold-out', h.estimated, pct(h.coverage), usd(A(h).typicalMiss), pct(A(h).within300)]);
    else wfRows.push([m, 'hold-out', 'not looked at', '-', '-', '-']);
  }
  L.push(table(['Method', 'Period', 'Leases estimated', 'Coverage', 'Typical miss', 'Within $300'], wfRows));
  L.push('');
  if (r.candidates && r.candidates.sizeBands) {
    L.push('**Candidate 1: size band, tune period only** (the hold-out is judged once, with --judge-holdout). Reference = MLS rules without a size band.');
    L.push('');
    const crows = r.candidates.sizeBands.map(c => [c.label, c.tune.estimated, pct(c.tune.coverage), usd(A(c.tune).typicalMiss), pct(A(c.tune).within300)]);
    L.push(table(['Method', 'Tune leases estimated', 'Coverage', 'Typical miss', 'Within $300'], crows));
    L.push('');
    if (r.candidates.holdoutVerdicts) {
      L.push('**Hold-out verdicts (acceptance rule, judged once):**');
      for (const v of r.candidates.holdoutVerdicts) L.push(`- ${verdictLine(v)}`);
      L.push('');
    }
  }
  if (r.candidates && r.candidates.rinconLookback) {
    L.push('**Candidate 9 (part): Rincon lookback, headline Rincon targets, real code**');
    L.push('');
    L.push(table(['Rincon lookback', 'Estimated', 'Coverage', 'Typical miss', 'Within $300', 'Median signed minus estimate'], r.candidates.rinconLookback.map(c => [c.label, c.s.estimated, pct(c.s.coverage), usd(A(c.s).typicalMiss), pct(A(c.s).within300), signedUsd(A(c.s).medianBias)])));
    L.push('');
  }
  L.push('Candidates that need product code that does not exist yet (similarity weights, ladder variants, status weights, centre method, trend adjustment, RentCast Inactive handling, high-rent confidence cap) are listed in backtest/candidates.js and are not run here. Candidate 4 (minimum comps) is read straight from the coverage column above.');
  L.push('');

  // listing time (opt-in)
  if (r.listingTime) {
    const lt = r.listingTime;
    L.push('## Pricing at listing time (the same leases, one step earlier)');
    L.push('');
    L.push(`Staff price a home when it is listed; the default test goes back only to the day before the lease closed. Here the same ${lt.targets} MLS leases are re-run as of the day each went on the market (median ${lt.medianGapDays} days before closing; ${lt.skipped} leases are left out of both columns: no usable listing date, or listed before the saved data can give them a full lookback). MLS-only pool.`);
    L.push('');
    const ltRows = [];
    for (const [lab, pick] of [['Ventura-area', x => x], ['Ventura core', core]]) {
      for (const m of ['baseline', 'size25_item2']) {
        const d = sum(pick(lt.sameLeases[m])), l = sum(pick(lt.rows[m]));
        ltRows.push([lab, m, d.estimated, pct(d.coverage), usd(A(d).typicalMiss), pct(A(d).within300), l.estimated, pct(l.coverage), usd(A(l).typicalMiss), pct(A(l).within300), nz(d.all && l.all) ? pts1((A(l).within300 - A(d).within300) * 100) : '-']);
      }
    }
    L.push(table(['Area', 'Method', 'Default: leases', 'coverage', 'typical miss', 'within $300', 'At listing time: leases', 'coverage', 'typical miss', 'within $300', 'Change in within $300 (pts)'], ltRows));
    L.push('');
  }

  // outcomes
  L.push('## Outcome matcher (A.4, A.7): saved reports vs leases signed later');
  L.push('');
  const oc = r.outcomes.counts;
  L.push(`${oc.analyses} saved reports (${oc.complete} complete). ${oc.analysesWithAnyAddressMatch} match a Rincon lease by address; ${oc.retrospectiveMatches} matches are retrospective (the lease started on or before the report was run, so they are not tests); **${oc.forwardMatches} forward matches** (lease started after the report, within 120 days).`);
  if (oc.forwardMatches) {
    const f = r.outcomes.forward;
    const inside = f.filter(x => x.insideRange).length;
    L.push(`Forward results: the signed rent was inside the stored range ${inside} of ${f.length} times. Basis: ${[...new Set(f.map(x => x.basis))].join('; ')}. Median signed minus centre ${signedUsd(M.median(f.map(x => x.missVsCentre)))}.`);
  } else {
    L.push('Nothing to score yet: the closed loop only fills up when staff run the tool at pricing time, before the lease is signed (a process point, no code needed).');
  }
  L.push('');

  // limits
  L.push('## What this test cannot see (stated limits)');
  L.push('');
  {
    const gap = r.medianGapDays !== null && r.medianGapDays !== undefined ? r.medianGapDays : (r.listingTime ? r.listingTime.medianGapDays : null);
    const f = listingTimeFacts(r.listingTime, sum);
    const gapText = gap === null ? 'some time' : `a median of ${gap} days`;
    if (f) {
      L.push(`- Pricing happens at listing time, but the test knows everything up to the day the lease closed (${gapText} later in this data), so the default figures are optimistic. Re-run as of the day each home went on the market (${f.leases} leases, MLS-only pool): the share within $300 is ${spanText(f.diffs.within, x => `${x.toFixed(1)}`)} points lower, the typical miss is ${spanText(f.diffs.miss, x => `$${Math.round(x)}`)} worse, and coverage is ${spanText(f.diffs.coverage, x => `${x.toFixed(1)}`)} points lower across the Ventura-area; in the Ventura core with the size rule coverage falls from ${pct(f.coreCoverageFrom, 1)} to ${pct(f.coreCoverageTo, 1)}.`);
    } else {
      L.push(`- Pricing happens at listing time, but the test knows everything up to the day the lease closed (${gapText} later in this data), so every figure here is optimistic. How much was not measured in this run (--no-asof-listing).`);
    }
  }
  L.push('- Only homes that actually leased are tested. The MLS feed holds no withdrawn, expired or canceled leases, so homes that sat unrented never appear as targets either (survivor bias in the targets, not only in the asking comps).');
  {
    const mix = r.staffRunMix;
    L.push(`- Duplexes, triplexes, fourplexes and apartments are not tested${mix && mix.total ? `, although they are about ${Math.round((mix.multiFamily / mix.total) * 100)}% of staff runs (${mix.multiFamily} of ${mix.total} saved reports)` : ''}; the test covers houses, townhomes and condos only.`);
  }
  L.push('- As-of asking prices are only listings that later leased. They are priced at the original list price, but the feed shows no mid-listing history, so a price that was cut and then recovered or a listing that was withdrawn is invisible. The MLS feed holds no expired, withdrawn or canceled leases, so these comps are survivors and flatter the result. (The final list price, which may include cuts made after the as-of date, can be selected with the pool option askingPrice: final.)');
  L.push('- RentCast is not in the pool (about 45% of the comps staff see). The live tool has them; accuracy and coverage in a live report can differ.');
  L.push('- Rincon leases: the table keeps only leases that are still the unit\'s current lease, so older Rincon comps are under-counted for earlier targets.');
  L.push('- Signed rent is not always market rent (price cuts after vacancy); nothing records asking-price history yet (Phase A3).');
  L.push(`- A listing entered in the MLS after its lease closed (${r.dataFacts && r.dataFacts.enteredAfterClose !== undefined ? r.dataFacts.enteredAfterClose : 'a few'} records) is treated as not knowable before it was entered.`);
  L.push('- Hit rates on groups of under 100 leases have wide intervals; groups under 20 are not published.');
  L.push('');
  return L.join('\n') + '\n';
}

module.exports = {
  assertAggregatesOnly, viewBlock, buildScorecard, accuracyLine, labelHitRates, trackRecordSentence,
  detailCsv, worstMissesCsv, renderReport, table, pct, usd, csvCell, inTen, inTenRange, pts, pts1, fmtCount,
};
