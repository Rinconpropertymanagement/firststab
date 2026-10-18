#!/usr/bin/env node
/**
 * backtest/run.js
 * The permanent blind accuracy test (CMA-QUALITY-SPEC.md Phase A, A1).
 *
 * For every past lease it asks: "if the tool had been run the day before this
 * lease closed (for Rincon's own leases, the day before the move-in), knowing only what existed then, what would it have said?" and
 * compares that with what the home actually leased for. It runs the REAL tool
 * code (lib/sources.js, lib/property-matching.js, lib/weighting.js,
 * lib/analyze.js) on a comp pool rebuilt as of each date, and never touches the
 * real analyses or the database (reads only).
 *
 * See backtest/README.md for the plain-English version.
 */
const fs = require('fs');
const path = require('path');

const HELP = `
run.js - the permanent blind accuracy test for the rent-comp tool

USAGE
  node backtest/run.js                 run on the data already in backtest/cache (no network; about 2 minutes on an idle machine,
                                       longer when the computer is busy)
  node backtest/run.js --refresh       pull fresh data first (about 30 free Recore reads, 3 Supabase reads, and about
                                       a dozen more to ask the MLS what kind of home each Rincon lease is), then run
                                       everything incl. the fidelity check (about 10 more Recore reads)
  node backtest/run.js --refresh-types ask the MLS again what kind of home each saved Rincon lease is (a dozen or so free
                                       Recore reads; answers under two weeks old are reused), then run on the data already
                                       saved. Nothing else in the saved data changes.
  node backtest/run.js --refresh --publish
                                       the monthly routine: refresh, run, and (only if THIS run's scorecard is trusted and the
                                       run was complete) copy that scorecard into lib/accuracy-scorecard.json in BOTH lib folders.
                                       Otherwise it refuses and exits with a non-zero code.
  node backtest/run.js --a0            prove the lib/analyze.js refactor changed no number (reads Supabase)
  node backtest/run.js --help

OPTIONS (an option that takes a value can be written --name value or --name=value; an unknown option is an error)
  --fidelity          run the fidelity check on the cached data (about 10 free Recore reads); needed again whenever the
                      product's comp-pulling code or the replay changes (the stored result records which code it checked)
  --no-asof-listing   skip the second pass that re-runs the MLS leases as of the day each went on the market (staff price at
                      listing time); that pass is on by default (about 15 seconds) because the report states its effect
  --no-leak-test      skip the leak self-test (the scorecard is then not trusted)
  --judge-holdout     judge the pre-registered candidates on the hold-out. A candidate can be judged again only on a
                      hold-out that starts after the end of the one it was last judged on; a repeat shows the stored verdict
  --rejudge           allow judging a candidate again anyway (leave it off unless you know why)
  --plant-leak        DEBUG: put every target's own lease in its pool; numbers will be fake, nothing is written, --publish refused
  --limit N           DEBUG: only about N MLS targets
  --target-from DATE  first lease date to test (default 2026-04-15)
  --holdout-from DATE start of the hold-out (default: newest 3 months of targets)
  --today DATE        pretend today is DATE (default: today)
                      Any of --limit, --target-from, --holdout-from, --today or --plant-leak makes the run PARTIAL: it never updates
                      backtest/scorecard.json, is never trusted, and --publish is refused with a non-zero exit.
  --data-from DATE    with --refresh: first close date to pull (default 2025-03-15)

OUTPUT
  backtest/out/<date>/report.md          aggregates only, safe to share
  backtest/out/<date>/detail.csv         per-lease rows WITH addresses (local only, git-ignored)
  backtest/out/<date>/worst-misses.csv   the biggest misses (local only)
  backtest/out/<date>/scorecard.json     this run's aggregates
  backtest/scorecard.json                the committed aggregates (updated only by a complete run)

It never calls RentCast or Anthropic, never writes to Recore or Supabase, and never prints a key.
`;

const { parseArgs, CliError } = require('./cli');
let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  if (err instanceof CliError) { console.error(err.message); process.exit(1); }
  throw err;
}
if (args.flags.has('help')) {
  console.log(HELP);
  process.exit(0);
}

// ── everything below needs the heavy modules ────────────────────────────────
const { loadEnv } = require('./env');
loadEnv(); // before any ../lib module that reads process.env at require time

const data = require('./data');
const T = require('./targets');
const asof = require('./asof-sources');
const eng = require('./engine');
const C = require('./candidates');
const M = require('./metrics');
const selftests = require('./selftests');
const outcomes = require('./outcomes');
const rinconMlsLib = require('./rincon-mls');
const report = require('./report');
const provenance = require('./provenance');
const judging = require('./judging');
const { publishScorecard } = require('./publish');
const { installNetGuard } = require('./netguard');
const { addressesMatch } = require('../lib/property-matching');
const { DEFAULT_TARGET_FROM, DEFAULT_DATA_FROM, HOLDOUT_MONTHS } = require('./constants');

const OUT_ROOT = path.join(__dirname, 'out');
const SCORECARD_PATH = path.join(__dirname, 'scorecard.json');
const LIB_TARGETS = [
  path.join(__dirname, '..', 'lib', 'accuracy-scorecard.json'),
  path.join(__dirname, '..', '..', 'hub', 'rental-analysis', 'lib', 'accuracy-scorecard.json'),
];

const log = msg => console.log(msg);
const todayLocal = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD in local time
function localDateOrNull(value) {
  if (typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('sv-SE');
}

function readJson(p) { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; }
function writeJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); }

// Five known subjects for the fidelity check: the most recent distinct saved
// reports that have coordinates, topped up with core-area MLS targets.
function fidelitySubjects(analyses, mlsTargets, count = 5) {
  const subjects = [];
  const sorted = analyses.filter(a => a.status === 'complete' && typeof a.subject_latitude === 'number' && typeof a.subject_longitude === 'number')
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  for (const a of sorted) {
    if (subjects.length >= count) break;
    if (subjects.some(s => addressesMatch(s.address, a.subject_address))) continue;
    subjects.push({ address: a.subject_address, propertyType: a.subject_property_type, bedrooms: a.subject_bedrooms, latitude: a.subject_latitude, longitude: a.subject_longitude });
  }
  const core = mlsTargets.filter(t => t.area === 'core');
  for (let i = 0; subjects.length < count && i < core.length; i += Math.max(1, Math.floor(core.length / count))) {
    const t = core[i];
    subjects.push({ address: t.address, propertyType: t.propertyType, bedrooms: t.bedrooms, latitude: t.latitude, longitude: t.longitude });
  }
  return subjects;
}

async function runPool(world, targets, poolId, pool, methodIds, label) {
  const out = {};
  for (const m of methodIds) {
    const t0 = Date.now();
    out[m] = await eng.runTargets(world, targets, C.METHODS[m], pool);
    log(`  ${label || poolId} / ${m}: ${targets.length} targets, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  if (args.flags.has('a0')) {
    require('./a0-replay'); // prints its own result and exits non-zero on failure
    return;
  }

  // A run is COMPLETE only when it uses the default settings. Any option that narrows or shifts the
  // targets makes it partial: a partial run never updates backtest/scorecard.json and is never published.
  const partialReasons = [];
  if (args.values.limit) partialReasons.push('--limit');
  if (args.flags.has('plant-leak')) partialReasons.push('--plant-leak');
  for (const opt of ['target-from', 'holdout-from', 'today']) if (args.values[opt]) partialReasons.push(`--${opt}`);
  const partial = partialReasons.length > 0;
  if (args.flags.has('publish') && partial) {
    console.error(`Refusing to --publish: this run uses ${partialReasons.join(' and ')}, so it is partial and only a complete run on the default settings may be published. Nothing was run.`);
    process.exit(1);
  }

  const today = args.values.today || todayLocal();
  const targetFrom = args.values['target-from'] || DEFAULT_TARGET_FROM;
  let recoreRequests = 0;
  const guard = installNetGuard(); // counts every outbound request by host; blocks everything but Recore and Supabase

  if (args.flags.has('refresh')) {
    guard.setPhase('refresh');
    const { meta, client } = await data.refreshCache({ dataFrom: args.values['data-from'] || DEFAULT_DATA_FROM, log });
    guard.setPhase('replay');
    recoreRequests += client.requests;
    log(`Cache written: ${JSON.stringify(meta.counts)}`);
  }
  if (args.flags.has('refresh-types') && !args.flags.has('refresh')) {
    guard.setPhase('refresh');
    const { client, asked, reused, skipped } = await data.refreshRinconMls({ log });
    guard.setPhase('replay');
    recoreRequests += client.requests;
    log(`Rincon lease types saved: ${asked} addresses asked, ${reused} reused from the earlier pull, ${skipped} leases with an address that cannot be searched; ${client.requests} Recore requests.`);
  }
  let cache;
  try {
    cache = data.loadCache();
  } catch (err) {
    if (err.code === 'NO_CACHE' || err.code === 'BAD_CACHE') { console.error(err.message); process.exit(1); }
    throw err;
  }
  log(`Using cache pulled ${cache.meta.pulledAt}: ${JSON.stringify(cache.meta.counts)}`);

  const world = asof.createWorld({ closed: cache.closed, leadsimple: cache.leadsimple, properties: cache.properties, rinconMls: cache.rinconMls });
  let mlsTargets = T.buildMlsTargets(cache.closed, { targetFrom, today });
  if (args.values.limit) mlsTargets = mlsTargets.filter((_, i) => i % Math.max(1, Math.floor(mlsTargets.length / Number(args.values.limit))) === 0).slice(0, Number(args.values.limit));
  // Rincon test leases are typed the way the product types them: by what the MLS says is at the address (saved evidence), else LeadSimple's label.
  const { targets: rinconTargets, screenedOut } = T.buildRinconTargets(cache.leadsimple, { today, resolveType: cache.rinconMls ? rinconMlsLib.resolverFor(cache.rinconMls) : null });
  // What the report needs to know about that evidence, to decide whether the scorecard describes the tool that really runs.
  const rinconTypes = cache.rinconMls
    ? { present: true, ...rinconMlsLib.coverageOf(cache.rinconMls, cache.leadsimple), typedByMls: rinconTargets.filter(t => t.typeSource === 'mls').length, targetsByType: rinconTargets.reduce((m, t) => { m[t.propertyType] = (m[t.propertyType] || 0) + 1; return m; }, {}) }
    : { present: false, total: 0, covered: 0, uncovered: 0, oldest: null, newest: null, typedByMls: 0, targetsByType: {} };
  const holdoutStart = args.values['holdout-from'] || T.holdoutStartFor(mlsTargets, HOLDOUT_MONTHS);
  const split = T.splitWalkForward(mlsTargets, holdoutStart);
  const dataThrough = mlsTargets.reduce((m, t) => (t.date > m ? t.date : m), targetFrom);
  const leakPool = args.flags.has('plant-leak') ? { plantLeak: 1 } : {};
  const dataFromEarly = cache.meta.dataFrom || (cache.closed[0] && cache.closed[0].CloseDate) || null;
  // cheap: the listing dates only; a lease listed before the saved data can give it a full lookback is left out
  const listingView = T.listingTimeTargets(mlsTargets, { notBefore: dataFromEarly ? T.monthsBefore(dataFromEarly, -C.LIVE_MLS_MONTHS) : null });
  // The saved data must reach back far enough for every target (and for the listing-time view): earliest as-of date minus the lookback.
  const earliestAsOf = [mlsTargets[0] && mlsTargets[0].date, rinconTargets[0] && rinconTargets[0].date, ...listingView.targets.map(t => t.asOf)].filter(Boolean).sort()[0];
  const dataFrom = cache.meta.dataFrom || (cache.closed[0] && cache.closed[0].CloseDate) || null;
  const requiredFrom = earliestAsOf ? T.monthsBefore(earliestAsOf, C.LIVE_MLS_MONTHS) : null;
  const dataCoverage = { dataFrom, requiredFrom, ok: !!(dataFrom && requiredFrom && dataFrom <= requiredFrom) };
  const enteredAfterClose = cache.closed.filter(r => { const l = (r.OnMarketDate || r.ListingContractDate || '').slice(0, 10); return l && r.CloseDate && l > r.CloseDate.slice(0, 10); }).length;
  const completeAnalyses = cache.analyses.filter(a => a.status === 'complete');
  const staffRunMix = { total: completeAnalyses.length, multiFamily: completeAnalyses.filter(a => ['duplex', 'triplex', 'fourplex', 'apartment'].includes(a.subject_property_type)).length };
  // The MLS county field is used only to group the results; its fill is measured and shown, never assumed.
  const countyFill = { closed: M.countyFill(cache.closed), active: M.countyFill(cache.active) };
  log(`County field: on ${countyFill.closed.known} of ${countyFill.closed.records} closed and ${countyFill.active.known} of ${countyFill.active.records} active records (closed values: ${countyFill.closed.values.map(v => `${v.value} ${v.count}`).join(', ')}).`);
  log(`Targets: ${mlsTargets.length} MLS (${mlsTargets.filter(t => t.area === 'core').length} core), ${rinconTargets.length} Rincon. Hold-out from ${holdoutStart} (${split.tune.length} tune / ${split.holdout.length} hold-out).`);

  // ── self-tests ─────────────────────────────────────────────────────────────
  const selfTests = { leak: null, fidelity: null };
  const trackedHashes = provenance.trackedFilesHash();
  if (!args.flags.has('no-leak-test') && !args.flags.has('plant-leak')) {
    log('Leak self-test...');
    selfTests.leak = await selftests.leakSelfTest({ world, targets: mlsTargets });
    log(`  leak self-test: ${selfTests.leak.pass ? 'PASS' : 'FAIL'} (clean miss $${selfTests.leak.clean.typicalMiss}, single leak $${selfTests.leak.single.typicalMiss}, heavy leak $${selfTests.leak.heavy.typicalMiss})`);
  }
  if (args.flags.has('refresh') || args.flags.has('fidelity')) {
    log('Fidelity check (live Recore reads)...');
    guard.setPhase('fidelity');
    let counted = 0;
    const realFetch = global.fetch;
    // The real pullCrmlsComps() uses global fetch; count its requests without altering them.
    global.fetch = async (...a) => { counted++; return realFetch(...a); };
    try {
      const subjects = fidelitySubjects(cache.analyses, mlsTargets);
      const fid = await selftests.fidelityCheck({ world, active: cache.active, subjects });
      fid.ranAt = new Date().toISOString();
      fid.pulledAt = cache.meta.pulledAt;
      fid.hashes = trackedHashes; // which code this result vouches for
      fid.requests = counted;
      recoreRequests += counted;
      selfTests.fidelity = fid;
      cache.meta.fidelity = fid;
      data.saveMeta(cache.meta);
      log(`  fidelity: ${fid.pass ? 'PASS' : 'FAIL'} (${fid.results.filter(r => r.identical).length}/${fid.subjects} subjects identical, ${counted} Recore requests)`);
    } finally {
      global.fetch = realFetch;
      guard.setPhase('replay');
    }
  } else if (cache.meta.fidelity) {
    selfTests.fidelity = cache.meta.fidelity;
  }
  {
    const validity = provenance.fidelityValidity(selfTests.fidelity, trackedHashes, cache.meta.pulledAt);
    if (!validity.valid) log(`Fidelity result is not valid for today's code and data: ${validity.reason}.`);
  }

  // ── the numbers ────────────────────────────────────────────────────────────
  log('Running the real tool code on every target (MLS)...');
  const mls = {};
  const bandMethods = ['size15_item2', 'size20_item2', 'size30_item2', 'size35_item2'];
  mls.mls = await runPool(world, mlsTargets, 'mls', { ...C.POOLS.mls, ...leakPool }, ['baseline', 'item2', 'size25', 'size25_item2', ...bandMethods]);
  mls['mls+asking'] = await runPool(world, mlsTargets, 'mls+asking', { ...C.POOLS['mls+asking'], ...leakPool }, ['baseline', 'size25_item2']);
  mls.full = await runPool(world, mlsTargets, 'full', { ...C.POOLS.full, ...leakPool }, ['baseline', 'size25_item2']);

  log('Running the Rincon portfolio test...');
  const rinconCombos = [];
  const addCombo = async (label, poolId, pool, methodId, isHeadline) => {
    const rows = await eng.runTargets(world, rinconTargets, C.METHODS[methodId], pool);
    rinconCombos.push({ label, poolId, methodId, rows, isHeadline: !!isHeadline });
    return rows;
  };
  const LIVE = C.LIVE_RINCON_MONTHS;
  const fullPool = { ...C.POOLS.full, ...leakPool };
  const rinconHeadline = {
    baseline: await addCombo(`MLS + asking + Rincon (${LIVE} months), today's code`, 'full', fullPool, 'baseline', true),
    size25_item2: await addCombo(`MLS + asking + Rincon (${LIVE} months), + size 25% + MLS rules`, 'full', fullPool, 'size25_item2'),
  };
  await addCombo('MLS closed leases only, today\'s code', 'mls', { ...C.POOLS.mls, ...leakPool }, 'baseline');
  const lookbackMonths = [...new Set([6, 12, LIVE])].sort((a, b) => a - b);
  for (const months of lookbackMonths) {
    await addCombo(`MLS + Rincon (${months}-month lookback${months === LIVE ? ', live' : ''}), today's code`, 'mls+rincon', { ...C.POOLS['mls+rincon'], rinconMonths: months, ...leakPool }, 'baseline');
  }
  await addCombo(`MLS + Rincon (${LIVE} months), + size 25% + MLS rules`, 'mls+rincon', { ...C.POOLS['mls+rincon'], ...leakPool }, 'size25_item2');
  const rinconLookback = lookbackMonths.map(months => {
    const c = rinconCombos.find(x => x.poolId === 'mls+rincon' && x.methodId === 'baseline' && x.label.includes(`(${months}-month`));
    return { label: `${months} months${months === LIVE ? ' (live)' : ''}`, s: M.summarize(c.rows) };
  });

  // ── opt-in: the same MLS leases, priced as of the day they went on the market ──
  let listingTime = null;
  if (!args.flags.has('no-asof-listing')) {
    log('Running the MLS leases as of listing time...');
    const lt = listingView;
    const keys = new Set(lt.targets.map(t => t.key));
    const rows = {}, sameLeases = {};
    for (const m of ['baseline', 'size25_item2']) {
      rows[m] = await eng.runTargets(world, lt.targets, C.METHODS[m], { ...C.POOLS.mls, ...leakPool });
      sameLeases[m] = mls.mls[m].filter(x => keys.has(x.key)); // the default column, on exactly the same leases
    }
    listingTime = { targets: lt.targets.length, skipped: lt.skipped, medianGapDays: lt.medianGapDays, rows, sameLeases };
  }

  // ── outcome matcher ────────────────────────────────────────────────────────
  const outcomeResult = outcomes.matchOutcomes(cache.analyses, cache.leadsimple);

  // ── candidates (pre-registered in candidates.js) ───────────────────────────
  const refMethod = 'item2';
  const bandIds = [refMethod, 'size15_item2', 'size20_item2', 'size25_item2', 'size30_item2', 'size35_item2'];
  const tuneOf = rows => rows.filter(x => x.date < holdoutStart);
  const holdOf = rows => rows.filter(x => x.date >= holdoutStart);
  const candidates = {
    sizeBands: bandIds.map(id => ({ id, label: C.METHODS[id].label, tune: M.summarize(tuneOf(mls.mls[id])) })),
    rinconLookback,
  };
  if (args.flags.has('judge-holdout') && !partial) {
    const judgedPath = path.join(args.values.out || OUT_ROOT, 'holdout-judged.json');
    const groupsOf = rows => ({ propertyType: M.summarizeBy(rows, M.GROUPINGS.propertyType), rentBand: M.summarizeBy(rows, M.GROUPINGS.rentBand), city: M.summarizeBy(rows, M.GROUPINGS.city) });
    const item = (label, baseId, candId) => ({
      key: `${candId} vs ${baseId}`,
      label,
      evaluate: () => {
        const b = holdOf(mls.mls[baseId]), c = holdOf(mls.mls[candId]);
        return C.evaluateAcceptance({ baseline: M.summarize(b), candidate: M.summarize(c), baselineGroups: groupsOf(b), candidateGroups: groupsOf(c) });
      },
    });
    const items = [item('Phase B bundle (size 25% + MLS rules) vs today\'s code', 'baseline', 'size25_item2'),
      ...bandIds.slice(1).map(id => item(`${C.METHODS[id].label} vs the MLS rules alone`, refMethod, id))];
    const { verdicts, store } = judging.judgeCandidates({
      store: readJson(judgedPath) || {}, items, holdoutStart, holdoutEnd: dataThrough, today: todayLocal(), rejudge: args.flags.has('rejudge'),
    });
    writeJson(judgedPath, store);
    candidates.holdoutVerdicts = verdicts;
    for (const v of verdicts) log(`  ${judging.verdictLine(v)}`);
  }

  // ── assemble, write ────────────────────────────────────────────────────────
  const runDate = today;
  const results = {
    runDate,
    generatedAt: new Date().toISOString(),
    cachePulledAt: cache.meta.pulledAt,
    dataThrough,
    recoreRequests,
    elapsedSeconds: Math.round((Date.now() - t0) / 1000),
    partial,
    guardChecks: eng.stats.targetRuns,
    config: { targetFrom, holdoutStart },
    counts: {
      closedRecords: cache.closed.length,
      countyTargets: mlsTargets.length,
      coreTargets: mlsTargets.filter(t => t.area === 'core').length,
      rinconTargets: rinconTargets.length,
      rinconScreenedOut: screenedOut,
      rinconTargetsByType: rinconTypes.targetsByType,
      tune: split.tune.length,
      holdout: split.holdout.length,
    },
    mls,
    rincon: { combos: rinconCombos, headline: { baseline: M.summarize(rinconHeadline.baseline), size25_item2: M.summarize(rinconHeadline.size25_item2) } },
    candidates,
    outcomes: outcomeResult,
    selfTests,
    trackedHashes,
    listingTime,
    partialReasons,
    medianGapDays: listingView.medianGapDays,
    // an unreadable or missing pull time is null (so the scorecard is untrusted), never the text "Invalid Date"
    dataPulledOn: localDateOrNull(cache.meta.pulledAt),
    dataCoverage,
    staffRunMix,
    countyFill,
    dataFacts: { enteredAfterClose },
    rinconTypes,
    network: guard.counts(),
  };

  if (args.flags.has('plant-leak')) {
    const s = M.summarize(mls.mls.baseline);
    log(`PLANT-LEAK debug run: baseline typical miss with every target's own lease planted = $${Math.round(s.all.typicalMiss)} (nothing written).`);
    return;
  }

  const scorecard = report.buildScorecard(results);
  const outDir = path.join(args.values.out || OUT_ROOT, runDate);
  fs.mkdirSync(outDir, { recursive: true });
  const previous = readJson(SCORECARD_PATH);
  fs.writeFileSync(path.join(outDir, 'report.md'), report.renderReport(results, previous, scorecard));
  fs.writeFileSync(path.join(outDir, 'detail.csv'), report.detailCsv([
    { pool: 'mls', method: 'baseline', rows: mls.mls.baseline },
    { pool: 'mls', method: 'size25_item2', rows: mls.mls.size25_item2 },
    { pool: 'full', method: 'baseline', rows: mls.full.baseline },
    ...rinconCombos.filter(c => c.isHeadline || c.methodId === 'size25_item2').map(c => ({ pool: `rincon:${c.poolId}`, method: c.methodId, rows: c.rows })),
  ]));
  fs.writeFileSync(path.join(outDir, 'worst-misses.csv'), report.worstMissesCsv(mls.mls.baseline) + '\n# Rincon portfolio\n' + report.worstMissesCsv(rinconHeadline.baseline));
  fs.writeFileSync(path.join(outDir, 'outcomes.csv'), 'address,run_date,lease_start,days_from_report,signed_rent,range_low,range_high,centre,inside_range,basis\n'
    + outcomeResult.forward.map(f => [f.address, f.runDate, f.leaseStart, f.daysFromReportToLease, f.signedRent, f.rangeLow, f.rangeHigh, f.centre, f.insideRange, f.basis].map(report.csvCell).join(',')).join('\n') + '\n');
  writeJson(path.join(outDir, 'scorecard.json'), scorecard);

  let wroteCommitted = false;
  if (!partial && (scorecard.trusted || !previous)) { writeJson(SCORECARD_PATH, scorecard); wroteCommitted = true; }
  log(`\nWrote ${path.relative(process.cwd(), path.join(outDir, 'report.md'))} (aggregates), detail.csv and worst-misses.csv (local only), scorecard.json.`);
  log(wroteCommitted ? `Updated ${path.relative(process.cwd(), SCORECARD_PATH)} (trusted: ${scorecard.trusted}).` : `Did NOT update backtest/scorecard.json (${partial ? 'partial run' : 'this run is not trusted and a scorecard already exists'}).`);
  if (!scorecard.trusted) log(`Scorecard NOT trusted: ${scorecard.trustReasons.join('; ')}.`);

  if (args.flags.has('publish')) {
    // THIS run's scorecard, only if it is trusted and the run was complete.
    const result = publishScorecard({ scorecard, partial, targets: LIB_TARGETS });
    if (result.ok) log(result.message);
    else { console.error(result.message); process.exitCode = 1; }
  }

  // The deploy script copies the whole folder to the server. Warn (never block) until it leaves the local data out.
  try {
    const deploy = fs.readFileSync(path.join(__dirname, '..', 'deploy-to-sally.sh'), 'utf8');
    if (!deploy.includes('backtest/cache') || !deploy.includes('backtest/out')) {
      log('WARNING: deploy-to-sally.sh does not yet exclude backtest/cache and backtest/out, so a deploy would copy MLS records to the server. Do not deploy until Scotty adds --exclude lines for both.');
    }
  } catch (_) { /* no deploy script here: nothing to warn about */ }

  log(`Done in ${Math.round((Date.now() - t0) / 1000)}s. Recore requests this session: ${recoreRequests}.`);
  if ((selfTests.leak && !selfTests.leak.pass) || (selfTests.fidelity && !selfTests.fidelity.pass)) process.exitCode = 1;
}

{
  main().catch(err => {
    console.error(`FAILED: ${require('./env').redact(err && err.stack ? err.stack : err)}`);
    process.exit(1);
  });
}
