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
 * A second proof rides along (Phase C): for every lease, the product's recommended
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

async function main() {
  const t0 = Date.now();
  const cache = data.loadCache();
  const world = asof.createWorld({ closed: cache.closed, leadsimple: cache.leadsimple, properties: cache.properties });
  const mlsTargets = T.buildMlsTargets(cache.closed, { targetFrom: DEFAULT_TARGET_FROM, today });
  const { targets: rinconTargets } = T.buildRinconTargets(cache.leadsimple, { today });
  console.log(`Phase B equivalence: ${mlsTargets.length} MLS leases and ${rinconTargets.length} Rincon leases, saved data pulled ${cache.meta.pulledAt}.`);

  const tally = { pools: [], leases: 0, differ: 0 };
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
