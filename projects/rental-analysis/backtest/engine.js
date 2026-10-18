/**
 * backtest/engine.js
 * Runs ONE target through the real tool, blind, and returns a result row.
 *
 * For a target (a lease that already happened) it:
 *   1. installs the replay handlers (asof-sources.js) in place of the live ones
 *   2. runs the REAL runActiveSources() with only the subject's own facts (type,
 *      beds, baths, address, and for a method that runs the Phase B rules also
 *      sqft plus the form defaults furnished no / 12-month lease / not 55+): the
 *      signed rent never goes in. A method without those rules (the baseline,
 *      the tuning variants) is given a subject WITHOUT sqft and the three
 *      defaults, which switches the rules off in lib/.
 *   3. throws if anything that reaches the tool is dated on or after T, or if
 *      any source failed (runActiveSources() swallows handler errors, so a
 *      no-peeking violation inside a handler must not be allowed to vanish)
 *   4. runs the REAL lib/analyze.js computeNumbers() on what came back
 *   5. checks again that nothing dated on or after T survived, then scores
 *
 * The row keeps the signed rent next to the estimate so metrics.js can score
 * it; the address is kept for the local-only detail file and never leaves it.
 */
const { runActiveSources } = require('../lib/sources');
const { computeNumbers } = require('../lib/analyze');
const asof = require('./asof-sources');
const { headlineRange } = require('./metrics');

// How many target runs have cleared both no-peeking checks in this process (reported by run.js).
const stats = { targetRuns: 0 };

// What the "run analysis" form sends when staff leave the optional boxes alone:
// unfurnished, a 12-month lease, not a 55+ community.
const FORM_DEFAULTS = { furnished: false, leaseTermMonths: 12, ageRestricted: false };

const SOURCE_ROWS = {
  RentCast: { id: 'replay-rentcast', name: 'RentCast' },
  CRMLS: { id: 'replay-crmls', name: 'CRMLS' },
  'LeadSimple Move-Ins': { id: 'replay-leadsimple', name: 'LeadSimple Move-Ins' },
};

function activeSourcesFor(pool) {
  // Order as the live table returns them is irrelevant: runActiveSources puts RentCast first.
  return [SOURCE_ROWS.CRMLS, SOURCE_ROWS['LeadSimple Move-Ins'], SOURCE_ROWS.RentCast].filter(s => s.name !== 'LeadSimple Move-Ins' || pool.rincon);
}

// runActiveSources() logs one line per call; a full run makes tens of
// thousands of calls, so silence console.log/warn/error for the duration.
async function quietly(fn) {
  const log = console.log, warn = console.warn, error = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {}; // a source failure is re-thrown by runTarget() with its message, so nothing is lost
  try { return await fn(); } finally { console.log = log; console.warn = warn; console.error = error; }
}

/**
 * @param {object} world - from asof.createWorld()
 * @param {object} target - from targets.js
 * @param {{id: string, keep: Function|null}} method - from candidates.js
 * @param {object} pool - from candidates.js POOLS (plus plantLeak/useProperties overrides)
 */
async function runTarget(world, target, method, pool) {
  // T is the day the replay stands on. Normally the day before the lease closed
  // (target.date); the opt-in --asof-listing run sets target.asOf to the day the
  // home went on the market. target.date stays the close date for splits and reports.
  const T = target.asOf || target.date;
  // A method flagged `shipped` runs the Phase B rules inside lib/, so its subject carries the size and the form
  // defaults. Every other method gets a subject without them, which keeps those rules switched off in lib/
  // (the simulated variants apply their own filter on the comps instead, using subjectFacts below).
  const subject = { address: target.address, propertyType: target.propertyType, bedrooms: target.bedrooms, bathrooms: target.bathrooms };
  if (method && method.shipped) Object.assign(subject, { sqft: target.sqft }, FORM_DEFAULTS);
  const subjectFacts = { propertyType: target.propertyType, sqft: target.sqft, ...FORM_DEFAULTS };
  asof.setContext({ T, target, pool, method, subjectFacts });
  let sourced;
  try {
    sourced = await quietly(() => runActiveSources(activeSourcesFor(pool), subject));
  } finally {
    asof.clearContext();
  }
  if (sourced.sourceErrors.length) {
    throw new Error(`Replay source failed for target ${target.key}: ${sourced.sourceErrors.map(e => `${e.name}: ${e.error}`).join(' | ')}`);
  }
  const allowPlanted = !!pool.plantLeak;
  asof.assertNoFuture(sourced.comps, T, { allowPlanted });

  const properties = pool.useProperties === false ? [] : world.properties;
  const nums = computeNumbers({ comps: sourced.comps, subject, properties });
  asof.assertNoFuture(nums.compsWithMatch, T, { allowPlanted });

  stats.targetRuns++;

  const counted = nums.compsWithMatch.filter((c, i) => nums.exclusionReasons[i] === null);
  const rents = counted.map(c => Number(c.monthly_rent));
  const row = {
    key: target.key,
    kind: target.kind,
    date: target.date,
    address: target.address, // local detail only
    city: target.city,
    county: target.county || null, // the MLS county, for grouping the results only; nothing above reads it
    type: target.propertyType,
    area: target.area,
    beds: target.bedrooms,
    sqft: target.sqft,
    rent: target.rent,
    est: nums.recommended.mid,
    low: nums.recommended.low,
    high: nums.recommended.high,
    spread: nums.recommended.mid === null ? null : nums.recommended.high - nums.recommended.low,
    rawLow: nums.raw.low,
    rawHigh: nums.raw.high,
    n: counted.length,
    leased: counted.filter(c => c.listing_status === 'leased').length,
    pooled: sourced.comps.length,
    mix: {
      mlsLeased: counted.filter(c => c.source_name === 'CRMLS' && c.listing_status === 'leased').length,
      asking: counted.filter(c => c.source_name === 'CRMLS' && c.listing_status === 'active').length,
      rincon: counted.filter(c => c.source_name === 'LeadSimple Move-Ins').length,
    },
    rents, // local detail only
    planted: counted.some(c => c._planted),
  };
  const head = headlineRange(row);
  row.nearRange = head ? rents.some(r => r >= head.low - 100 && r <= head.high + 100) : null;
  return row;
}

async function runTargets(world, targets, method, pool, onProgress) {
  const rows = [];
  await asof.withReplayHandlers(world, async () => {
    for (let i = 0; i < targets.length; i++) {
      rows.push(await runTarget(world, targets[i], method, pool));
      if (onProgress) onProgress(i + 1, targets.length);
    }
  });
  return rows;
}

module.exports = { runTarget, runTargets, activeSourcesFor, quietly, stats, FORM_DEFAULTS };
