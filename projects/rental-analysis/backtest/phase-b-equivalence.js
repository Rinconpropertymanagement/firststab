#!/usr/bin/env node
/**
 * backtest/phase-b-equivalence.js
 * Phase B proof: the size band and the MLS-fact rules, as the real lib/ code now
 * applies them, give exactly the same answer for every past lease as the
 * simulation the accuracy test used before Phase B was built.
 *
 * "The simulation" (method size25_item2_sim in candidates.js) removes the
 * comps those rules would leave out BEFORE the tool sees them. "The shipped
 * code" (method size25_item2) hands the tool every comp and lets
 * lib/weighting.js leave them out, the way the report pages will. If the two
 * ever give a different estimate, range, comp count or set of counted rents for
 * ANY lease, this script says which one and exits 1.
 *
 * Two more proofs ride along. (1) Rincon lease types: the replay gets each Rincon lease's
 * real type from SAVED MLS answers (backtest/rincon-mls.js) where the product asks the live
 * MLS; both go through the same lib/leadsimple.js buildLeadSimpleComps(). This script runs the
 * product's live lookup (lookupMlsRecords(), against a pretend Recore that serves the saved
 * answers) and the saved-answers path on every Rincon lease, for four kinds of subject, and
 * requires the identical comps, types and rent marks. (2) Phase C: for every lease, the product's recommended
 * range, suggested price, stretch price and High / Medium / Low label (lib/weighting.js
 * computeHeadlineRange and lib/confidence.js) must equal the reference copy the
 * scorecard is built from (backtest/metrics.js). If they ever disagree, the hit rates
 * the scorecard publishes would describe a tool that does not exist.
 *
 * It uses only the data already saved in backtest/cache (no network at all: any
 * attempt to reach the network stops the script), the same blind replay and the
 * same no-peeking guards as run.js, so it cannot see a lease's own answer.
 *
 * Usage:
 *   node backtest/phase-b-equivalence.js
 *   node backtest/phase-b-equivalence.js --today 2026-10-17
 *   node backtest/phase-b-equivalence.js --help
 */
const assert = require('node:assert/strict');

if (process.argv.includes('--help')) {
  console.log(`
phase-b-equivalence.js - proves the shipped Phase B rules (size band 25% plus the
furnished / short-term / 55+ rules, applied by lib/) give the same answer for every
past lease as the simulated rules the accuracy test used before they were built.

Runs every Ventura-area MLS lease and every Rincon lease through both versions, in
the three comp pools the scorecard uses, and compares: the estimate, the low and
high, the raw comp range, how many comps counted, how many were leases, and the
exact list of counted rents. Prints what was compared; exits 1 on any difference.

Uses the saved data in backtest/cache only. No network, no Anthropic, no writes.
Option: --today YYYY-MM-DD   pretend today is this date (default: today)
`);
  process.exit(0);
}

const args = process.argv.slice(2);
const todayArg = args.includes('--today') ? args[args.indexOf('--today') + 1] : null;
if (args.includes('--today') && !/^\d{4}-\d{2}-\d{2}$/.test(todayArg || '')) {
  console.error('Option --today needs a date as YYYY-MM-DD.');
  process.exit(1);
}

// Nothing here may reach the network, ever.
global.fetch = () => { throw new Error('phase-b-equivalence.js uses saved data only: the network is blocked.'); };

const data = require('./data');
const T = require('./targets');
const asof = require('./asof-sources');
const eng = require('./engine');
const C = require('./candidates');
const { DEFAULT_TARGET_FROM } = require('./constants');
const M = require('./metrics');
const { computeHeadlineRange } = require('../lib/weighting');
const { computeConfidence } = require('../lib/confidence');
const leadsimpleLib = require('../lib/leadsimple');
const rinconMlsLib = require('./rincon-mls');
const { makeFakeRecoreFetch } = require('./tests/fake-recore-mls');

const today = todayArg || new Date().toLocaleDateString('sv-SE');

// The fields that decide an answer. `pooled` (how many comps the tool was handed)
// is deliberately NOT compared: the shipped code is handed the comps the rules
// leave out, so it can never be smaller than the simulation's.
function answerOf(row) {
  return {
    est: row.est, low: row.low, high: row.high, spread: row.spread,
    rawLow: row.rawLow, rawHigh: row.rawHigh, n: row.n, leased: row.leased, mix: row.mix,
    rents: [...row.rents].sort((a, b) => a - b),
  };
}

// The product's range and label for one lease row, against the scorecard's reference copy.
// Only the rents, how many are leases and the internal spread matter to either, so the counted comps are rebuilt from the row.
function headlineDisagrees(row) {
  const ref = M.headlineRange(row);
  const comps = row.rents.map((rent, i) => ({ monthly_rent: rent, listing_status: i < row.leased ? 'leased' : 'active' }));
  const mine = row.est === null ? null : computeHeadlineRange({ low: row.low, mid: row.est, high: row.high }, comps, 'balanced');
  if (!ref || !mine) return !!ref !== !!mine;
  if (mine.low !== ref.low || mine.high !== ref.high || mine.listPrice !== ref.listPrice || mine.stretchPrice !== ref.stretchPrice) return true;
  const refLabel = M.confidenceLabel({ ...row, nearRange: row.rents.some(r => r >= ref.low - 100 && r <= ref.high + 100) });
  const label = computeConfidence(mine).label;
  return (refLabel || '').toLowerCase() !== label;
}

async function compare(label, world, targets, pool, tally) {
  const sim = await eng.runTargets(world, targets, C.METHODS.size25_item2_sim, pool);
  const real = await eng.runTargets(world, targets, C.METHODS.size25_item2, pool);
  assert.equal(sim.length, real.length);
  let differs = 0, extraComps = 0, withRange = 0, headlineDiffers = 0;
  const shown = [];
  for (let i = 0; i < sim.length; i++) {
    try {
      assert.deepStrictEqual(answerOf(real[i]), answerOf(sim[i]));
    } catch (_) {
      differs++;
      if (shown.length < 10) shown.push(`${sim[i].key} (${sim[i].date}): shipped est ${real[i].est} n ${real[i].n} / simulated est ${sim[i].est} n ${sim[i].n}`);
    }
    if (real[i].pooled > sim[i].pooled) extraComps++;
    assert.ok(real[i].pooled >= sim[i].pooled, 'the shipped code was handed fewer comps than the simulation, which should be impossible');
    if (real[i].est !== null) withRange++;
    if (headlineDisagrees(real[i])) headlineDiffers++;
  }
  tally.pools.push({ label, leases: sim.length, withEstimate: withRange, differ: differs, shippedKeptExtraComps: extraComps, headlineDiffers });
  tally.leases += sim.length;
  tally.differ += differs + headlineDiffers;
  if (headlineDiffers) console.error(`  ${label}: the product's range or label differs from the scorecard's reference on ${headlineDiffers} leases`);
  if (differs) {
    console.error(`  ${label}: ${differs} of ${sim.length} leases DIFFER`);
    for (const line of shown) console.error(`    ${line}`);
  } else if (!headlineDiffers) {
    console.log(`  ${label}: ${sim.length} leases, ${withRange} with an estimate, all identical (the shipped code kept extra not-counted comps on ${extraComps}); the recommended range, prices and label match the scorecard's reference on all of them`);
  }
}

// The product's live lookup and the replay's saved-answers lookup, on every Rincon lease, must give the same comps.
// The live path runs for real (batching, the search text, reading the reply) against a pretend Recore that serves the
// saved answers; no network is used.
async function rinconTypeEquivalence(cache, tally) {
  if (!cache.rinconMls) {
    console.error('  Rincon lease types: NO saved MLS answers (backtest/cache/rincon-mls.json): the replay types every Rincon lease by label. Run: node backtest/run.js --refresh-types');
    tally.differ++;
    return;
  }
  const entries = cache.rinconMls.entries;
  const rows = cache.leadsimple.filter(row => { const q = leadsimpleLib.mlsQueryFor(row); return !q || !!entries[q.key]; });
  const fake = makeFakeRecoreFetch({ recordsFor: q => (entries[`${q.number}|${q.zip}|${q.words.join('/')}`] || { records: [] }).records });
  const live = queries => leadsimpleLib.lookupMlsRecords(queries, {
    fetchImpl: fake, token: 'pretend-token', cache: new Map(), limits: { maxRequests: 500, totalBudgetMs: 120000, requestTimeoutMs: 20000 },
  });
  const saved = rinconMlsLib.evidenceLookup(cache.rinconMls);
  let compared = 0, mlsTyped = 0, differ = 0;
  const kinds = { single_family: 0, condo: 0, townhouse: 0, other: 0, apartment: 0 };
  for (const subject of [{ propertyType: 'single_family', bedrooms: 3 }, { propertyType: 'condo', bedrooms: 2 }, { propertyType: 'townhouse', bedrooms: 3 }, { propertyType: 'apartment', bedrooms: 2 }]) {
    const selected = rows.map(row => ({ row, distanceMiles: null }));
    const a = await leadsimpleLib.buildLeadSimpleComps(selected, subject, { lookup: live, log: null });
    const b = await leadsimpleLib.buildLeadSimpleComps(selected, subject, { lookup: saved, log: null });
    try {
      assert.deepStrictEqual(a.comps, b.comps);
      assert.equal(a.stats.couldNotCheck, 0, 'the live path could not check some lease that the saved answers cover');
    } catch (err) {
      differ++;
      console.error(`  Rincon lease types, ${subject.propertyType} subject: the live lookup and the saved answers DIFFER (${String(err.message).split('\n')[0].slice(0, 160)})`);
    }
    compared += b.comps.length;
    mlsTyped += b.comps.filter(c => c.property_type_source === 'mls').length;
    if (subject.propertyType === 'single_family') for (const c of b.comps) kinds[c.property_type] = (kinds[c.property_type] || 0) + 1;
  }
  tally.pools.push({ label: 'Rincon lease types, live lookup vs saved answers', leases: rows.length, withEstimate: 0, differ, shippedKeptExtraComps: 0, headlineDiffers: 0 });
  tally.differ += differ;
  if (!differ) console.log(`  Rincon lease types: ${rows.length} leases x 4 kinds of subject (${compared} comps): the product's live lookup (run against a pretend Recore serving the saved answers) and the replay's saved-answers path give identical comps, types and rent marks; ${mlsTyped} comp-types came from the MLS. Types with a house subject: ${Object.entries(kinds).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ')}.`);
}

async function main() {
  const t0 = Date.now();
  const cache = data.loadCache();
  const world = asof.createWorld({ closed: cache.closed, leadsimple: cache.leadsimple, properties: cache.properties, rinconMls: cache.rinconMls });
  const mlsTargets = T.buildMlsTargets(cache.closed, { targetFrom: DEFAULT_TARGET_FROM, today });
  const { targets: rinconTargets } = T.buildRinconTargets(cache.leadsimple, { today, resolveType: cache.rinconMls ? rinconMlsLib.resolverFor(cache.rinconMls) : null });
  console.log(`Phase B equivalence: ${mlsTargets.length} MLS leases and ${rinconTargets.length} Rincon leases, saved data pulled ${cache.meta.pulledAt}.`);

  const tally = { pools: [], leases: 0, differ: 0 };
  await rinconTypeEquivalence(cache, tally);
  for (const [id, pool] of [['mls', C.POOLS.mls], ['mls+asking', C.POOLS['mls+asking']], ['full', C.POOLS.full]]) {
    await compare(`MLS leases, pool ${id}`, world, mlsTargets, pool, tally);
  }
  for (const [id, pool] of [['full', C.POOLS.full], ['mls+rincon', C.POOLS['mls+rincon']]]) {
    await compare(`Rincon leases, pool ${id}`, world, rinconTargets, pool, tally);
  }
  // Also standing at the day each home went on the market (the second pass run.js makes).
  const listing = T.listingTimeTargets(mlsTargets, { notBefore: cache.meta.dataFrom ? T.monthsBefore(cache.meta.dataFrom, -C.LIVE_MLS_MONTHS) : null });
  await compare('MLS leases as of listing time, pool mls', world, listing.targets, C.POOLS.mls, tally);

  const secs = Math.round((Date.now() - t0) / 1000);
  if (tally.differ) {
    console.error(`\nPhase B equivalence: FAIL. ${tally.differ} of ${tally.leases} runs differ between the shipped rules and the simulation (${secs}s).`);
    process.exit(1);
  }
  console.log(`\nPhase B equivalence: PASS. ${tally.leases} lease runs compared, every estimate, range, comp count and list of counted rents identical (${secs}s). No network used.`);
}

main().catch(err => {
  console.error('Phase B equivalence: FAIL');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
