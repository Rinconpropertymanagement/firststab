/**
 * backtest/selftests.js
 * The two self-tests that must pass before a scorecard is trusted
 * (CMA-QUALITY-SPEC.md A.2 items 4 and 5).
 *
 * LEAK SELF-TEST. Puts the answer key back into the pool on purpose and checks
 * that the numbers collapse. If planting the target's own lease does not move
 * the typical miss, the test cannot see leaks and nothing it says is trusted.
 *   single leak   the target's own lease planted once (the realistic bug:
 *                 "forgot to exclude the target"). Pass: typical miss falls to
 *                 at most LEAK.singleMaxShare of the clean run's.
 *   heavy leak    the same lease planted as LEAK.heavyCopies distinct comps so
 *                 it outweighs the real ones. Pass: typical miss falls to at
 *                 most LEAK.heavyMaxShare of the clean run's ("collapse toward
 *                 $0"). Thresholds are fixed in constants.js before the run.
 *   normal runs   must contain no planted comp at all.
 *
 * FIDELITY CHECK. For 5 known subjects, runs the replay "as of now" and the
 * REAL pullCrmlsComps() live, and requires the two comp sets (address, rent,
 * status, distance) to be identical. This proves the replay selects and maps
 * CRMLS records exactly as the product does. Needs Recore (about 10 free GETs).
 */
const crmls = require('../lib/crmls');
const asof = require('./asof-sources');
const { runTargets, quietly } = require('./engine');
const { summarize } = require('./metrics');
const { LEAK } = require('./constants');
const { METHODS, POOLS } = require('./candidates');

// ── leak ─────────────────────────────────────────────────────────────────────
function evenSample(items, size) {
  if (items.length <= size) return items;
  const step = items.length / size;
  const out = [];
  for (let i = 0; i < size; i++) out.push(items[Math.floor(i * step)]);
  return out;
}

async function leakSelfTest({ world, targets, sampleSize = LEAK.sampleSize, heavyCopies = LEAK.heavyCopies }) {
  const sample = evenSample(targets, sampleSize);
  const pool = POOLS.mls;
  const method = METHODS.baseline;
  const clean = await runTargets(world, sample, method, pool);
  const single = await runTargets(world, sample, method, { ...pool, plantLeak: 1 });
  const heavy = await runTargets(world, sample, method, { ...pool, plantLeak: heavyCopies });

  const missOf = rows => summarize(rows).all.typicalMiss;
  const exactShare = rows => {
    const est = rows.filter(r => r.est !== null);
    return est.length ? est.filter(r => Math.abs(r.rent - r.est) <= 25).length / est.length : null;
  };
  const cleanMiss = missOf(clean), singleMiss = missOf(single), heavyMiss = missOf(heavy);
  const res = {
    sample: sample.length,
    clean: { typicalMiss: cleanMiss, exactShare: exactShare(clean), plantedRows: clean.filter(r => r.planted).length },
    single: { typicalMiss: singleMiss, exactShare: exactShare(single), plantedRows: single.filter(r => r.planted).length },
    heavy: { typicalMiss: heavyMiss, exactShare: exactShare(heavy), plantedRows: heavy.filter(r => r.planted).length, copies: heavyCopies },
    thresholds: { singleMaxShare: LEAK.singleMaxShare, heavyMaxShare: LEAK.heavyMaxShare },
  };
  const checks = [
    { label: 'normal run contains no planted comp', pass: res.clean.plantedRows === 0 },
    { label: `single planted lease cuts the typical miss to at most ${Math.round(LEAK.singleMaxShare * 100)}% of the clean run's`, pass: cleanMiss > 0 && singleMiss <= cleanMiss * LEAK.singleMaxShare },
    { label: `heavy planted lease (${heavyCopies} copies) cuts the typical miss to at most ${Math.round(LEAK.heavyMaxShare * 100)}% of the clean run's`, pass: cleanMiss > 0 && heavyMiss <= cleanMiss * LEAK.heavyMaxShare },
  ];
  return { ...res, checks, pass: checks.every(c => c.pass) };
}

// ── fidelity ─────────────────────────────────────────────────────────────────
// What the live pullCrmlsComps() would see right now, from the cache:
// closed leases since the lookback date (no upper bound) and Active listings.
function replayAsNow(world, active, subject, now = new Date()) {
  const box = crmls.buildBoundingBox(subject.latitude, subject.longitude, 2);
  const rel = { propertyType: subject.propertyType, bedrooms: subject.bedrooms };
  const since = crmls.closedSinceDate(now);
  const closed = [];
  for (const r of world.closed) {
    if (!r.CloseDate || r.CloseDate < since) break;
    if (!asof.inBoundingBox(r, box) || !asof.passesRelevance(r, rel)) continue;
    closed.push(r);
    if (closed.length >= crmls.MAX_RECORDS_PER_STATUS) break;
  }
  const act = [];
  for (const r of active) { // cache order is OnMarketDate asc; the live query sorts newest first
    if (!asof.inBoundingBox(r, box) || !asof.passesRelevance(r, rel)) continue;
    act.push(r);
  }
  act.sort((a, b) => ((a.OnMarketDate || '') < (b.OnMarketDate || '') ? 1 : (a.OnMarketDate || '') > (b.OnMarketDate || '') ? -1 : a.ListingKey < b.ListingKey ? -1 : 1));
  return asof.mapRecords(closed.concat(act.slice(0, crmls.MAX_RECORDS_PER_STATUS)), subject);
}

function compSignature(c) {
  return `${c.address}|${c.monthly_rent}|${c.listing_status}|${c.property_type}|${c.bedrooms}|${c.sqft}|${c.distance_miles === null ? 'null' : c.distance_miles.toFixed(4)}`;
}

function multisetDiff(a, b) {
  const count = new Map();
  for (const s of a) count.set(s, (count.get(s) || 0) + 1);
  for (const s of b) count.set(s, (count.get(s) || 0) - 1);
  let onlyA = 0, onlyB = 0;
  for (const v of count.values()) { if (v > 0) onlyA += v; else onlyB -= v; }
  return { onlyReplay: onlyA, onlyLive: onlyB };
}

/**
 * @param {object} args
 * @param {object} args.world - asof.createWorld()
 * @param {object[]} args.active - cached Active records (cache/active.json)
 * @param {{address, propertyType, bedrooms, latitude, longitude}[]} args.subjects - 5 known subjects
 * @param {Function} [args.livePull] - override for tests; default is the real pullCrmlsComps
 */
async function fidelityCheck({ world, active, subjects, livePull = crmls.pullCrmlsComps, now = new Date() }) {
  const results = [];
  for (const s of subjects) {
    const subject = { address: s.address, propertyType: s.propertyType, bedrooms: s.bedrooms, latitude: s.latitude, longitude: s.longitude };
    const replay = replayAsNow(world, active, subject, now);
    const live = (await quietly(() => livePull(subject))).comps;
    const diff = multisetDiff(replay.map(compSignature), live.map(compSignature));
    results.push({ replayComps: replay.length, liveComps: live.length, ...diff, identical: diff.onlyReplay === 0 && diff.onlyLive === 0 && replay.length === live.length });
  }
  return { subjects: results.length, results, pass: results.length > 0 && results.every(r => r.identical) };
}

module.exports = { leakSelfTest, fidelityCheck, replayAsNow, compSignature, multisetDiff, evenSample };
