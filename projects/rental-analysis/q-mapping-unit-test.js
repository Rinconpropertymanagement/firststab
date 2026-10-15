#!/usr/bin/env node
/**
 * q-mapping-unit-test.js
 * Real (not hypothetical) tests for the pure logic in this project — the
 * parts that don't need a live RentCast key, a live Anthropic key, or the
 * migration applied to a real database. Run this before wiring up real
 * credentials to catch mapping/math bugs early.
 *
 * This is Q's own build-time sanity check, not a replacement for TARS —
 * TARS still needs to run this against real RentCast/Claude/Supabase once
 * RENTCAST_API_KEY is set and the migration is applied.
 *
 * Usage:
 *   node q-mapping-unit-test.js
 */

// Same line server.js uses. Needed here because lib/supabase.js reads
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY into module-level constants at
// require() time, not per-call — a test that sets process.env.SUPABASE_URL
// after this file's requires have already run would have no effect. This
// only matters for the getMarketData() tests below (the only ones that
// exercise lib/supabase.js); every other test in this file mocks a module
// that reads its env vars dynamically inside the function body instead.
require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });

const assert = require('node:assert/strict');

const { percentile, computeRecommendedRange, computeRawRange, buildWeightedSample, excludeRinconManaged, isExcludedRinconManaged, exclusionReason, SELF_SOURCED_TRUSTED_SOURCE_NAMES, sizeSimilarityMultiplier, propertyTypeMultiplier } = require('./lib/weighting');
const { mapComparable, mapListingStatus, assessPlausibility, pullRentCastComps, lookupPropertyDetails, pullRentCastListings, mapListing, LISTINGS_DAYS_OLD, LISTINGS_LIMIT, LISTINGS_MAX_INACTIVE } = require('./lib/rentcast');
const {
  mapComparable: mapCrmlsComparable,
  haversineMiles,
  buildBoundingBox,
  buildFilter: buildCrmlsFilter,
  pullCrmlsComps,
  closedSinceDate,
  FROM_CRMLS_PROPERTY_TYPE,
  TO_CRMLS_PROPERTY_SUBTYPES,
  MAX_RECORDS_PER_STATUS,
  CRMLS_CLOSED_LOOKBACK_MONTHS,
  NARROW_SEARCH_RADIUS_MILES,
  WIDE_SEARCH_RADIUS_MILES,
  MIN_COMPS_FOR_NARROW_RADIUS,
} = require('./lib/crmls');
const { RADIUS_LADDER_MILES, MIN_LEASED_COMPS_FOR_NARROW_RADIUS } = require('./lib/constants');
const {
  mapComparable: mapLeadSimpleComparable,
  buildAddress: buildLeadSimpleAddress,
  pullLeadSimpleComps,
  FROM_LEADSIMPLE_PROPERTY_TYPE,
} = require('./lib/leadsimple');
const { findBestPropertyMatch, normalizeAddress, houseNumber, hasParseableHouseNumber, unitIdentifier, addressesMatch, dedupeComps } = require('./lib/property-matching');
const { parseNarrativeOutput, buildPrompt, describeComp, generateNarrative, salvagePartialOutput, pickNarratedIndexes, compFactsBlock, guardLeasedClaims, guardCompLabels, guardNoWeightClaims, findNoWeightClaims, validateRationale, extractDollarFigures, findCompLabels, findBadAddresses, extractAddressMentions, MAX_NARRATED_COMPS, MAX_TOKENS } = require('./lib/narrative');
const { suggestAddresses, mapSuggestion, geocodeAddress } = require('./lib/locationiq');
const { suggestAddresses: suggestAddressesGoogle, mapSuggestion: mapSuggestionGoogle } = require('./lib/google-places');
const marketDataLib = require('./lib/market-data');
const { mapMarketData, fetchMarketData, getMarketData, normalizeZip, isFresh, FRESHNESS_WINDOW_DAYS } = marketDataLib;
const sourcesLib = require('./lib/sources');
const { runActiveSources, applyCombinedRadiusTiering, chooseRadiusRung } = sourcesLib;

let passed = 0;

// Awaits fn() before judging pass/fail — a plain (non-async) try/catch here
// would mark an async check's assertions as "PASS" the instant fn() returns
// a pending Promise, regardless of what that Promise later does. `await` on
// a non-Promise return value is a harmless no-op, so this works for both
// sync and async check bodies.
async function check(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
}

// Runs fn with console.warn captured, restoring it even if fn throws. Passes
// the live array of warning strings to fn so assertions can read it.
async function withCapturedWarnings(fn) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    return await fn(warnings);
  } finally {
    console.warn = original;
  }
}

// Fake global.fetch for pullRentCastComps()/pullRentCastListings() that routes
// by URL path the way the real RentCast API does and records every call.
// `avm` and `listings` are response objects (or functions of the URL that
// return one; a function may also throw to simulate a network failure).
function mockRentCastFetch({ avm, listings }) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: opts.headers || {} });
    const pick = handler => (typeof handler === 'function' ? handler(u) : handler);
    if (u.includes('/avm/rent/long-term')) return pick(avm);
    if (u.includes('/listings/rental/long-term')) return pick(listings);
    throw new Error(`unexpected URL in test: ${u}`);
  };
  return { fn, calls };
}

// A successful JSON response. `headers` (optional) becomes a minimal
// Headers-like object; omit it to mimic the older mocks that have none.
function okJson(body, headers) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    ...(headers ? { headers: { get: name => (name.toLowerCase() in headers ? headers[name.toLowerCase()] : null) } } : {}),
  };
}

async function main() {
  console.log('--- lib/weighting.js ---');

  await check('percentile() matches hand-computed values on a known sorted array', () => {
    const arr = [4000, 4200, 4400, 4600, 4800];
    assert.equal(percentile(arr, 0), 4000);
    assert.equal(percentile(arr, 50), 4400);
    assert.equal(percentile(arr, 100), 4800);
    assert.equal(percentile(arr, 25), 4200); // idx = 0.25*4 = 1 -> arr[1]
  });

  await check('computeRecommendedRange() weights leased comps more heavily than active/off_market', () => {
    // 4 active comps clustered around 4000, 1 leased comp at 5000 — the
    // leased comp's weight (3) should pull the weighted median above where
    // the active comps alone would put it. Derive that baseline with the
    // same percentile() function rather than a hand-typed guess, so the
    // test can't drift out of sync with the interpolation method it's
    // checking against.
    const activeRents = [3900, 4000, 4050, 4100];
    const activeOnlyMedian = percentile([...activeRents].sort((a, b) => a - b), 50);

    const comps = [
      ...activeRents.map(monthly_rent => ({ monthly_rent, listing_status: 'active' })),
      { monthly_rent: 5000, listing_status: 'leased' },
    ];
    const { low, mid, high } = computeRecommendedRange(comps);
    assert.ok(low <= mid && mid <= high, `expected low <= mid <= high, got ${low}/${mid}/${high}`);
    assert.ok(mid > activeOnlyMedian, `expected leased weighting to pull mid (${mid}) above the active-only median (${activeOnlyMedian})`);
  });

  await check('computeRecommendedRange() returns nulls for zero comps (caller must treat this as a failed analysis)', () => {
    const { low, mid, high } = computeRecommendedRange([]);
    assert.equal(low, null);
    assert.equal(mid, null);
    assert.equal(high, null);
  });

  await check('computeRecommendedRange() handles a single comp without throwing', () => {
    const { low, mid, high } = computeRecommendedRange([{ monthly_rent: 4200, listing_status: 'active' }]);
    assert.equal(low, 4200);
    assert.equal(mid, 4200);
    assert.equal(high, 4200);
  });

  await check('computeRawRange() is the plain unweighted min/max, not the weighted range', () => {
    const comps = [
      { monthly_rent: 4650 },
      { monthly_rent: 4800 },
      { monthly_rent: 5000 },
    ];
    const { low, high } = computeRawRange(comps);
    assert.equal(low, 4650);
    assert.equal(high, 5000);
  });

  await check('computeRecommendedRange() and computeRawRange() exclude is_rincon_managed comps entirely from the math (Judge blocker: Peter\'s reference report — stated range $4,650-$5,000, Rincon-managed comp priced $4,635, below that range, i.e. already excluded from Rincon\'s real process)', () => {
    const independentComps = [
      { monthly_rent: 4650, listing_status: 'active', is_rincon_managed: false },
      { monthly_rent: 4800, listing_status: 'active', is_rincon_managed: false },
      { monthly_rent: 5000, listing_status: 'active', is_rincon_managed: false },
    ];
    const withoutManaged = {
      recommended: computeRecommendedRange(independentComps),
      raw: computeRawRange(independentComps),
    };

    // Add a Rincon-managed comp priced BELOW the independent comps' low end
    // — if it were still counted, it would pull raw.low (and likely
    // recommended.low) down below 4650. It must not move either number.
    const withManaged = [
      ...independentComps,
      { monthly_rent: 4635, listing_status: 'active', is_rincon_managed: true },
    ];
    const afterAddingManaged = {
      recommended: computeRecommendedRange(withManaged),
      raw: computeRawRange(withManaged),
    };

    assert.deepEqual(afterAddingManaged.raw, withoutManaged.raw, 'a Rincon-managed comp must not move the raw range');
    assert.deepEqual(afterAddingManaged.recommended, withoutManaged.recommended, 'a Rincon-managed comp must not move the recommended range');
    assert.equal(afterAddingManaged.raw.low, 4650, 'raw low must stay 4650, not drop to the managed comp\'s 4635');
  });

  await check('computeRecommendedRange() and computeRawRange() return nulls when every comp is Rincon-managed (nothing independent left to compute from)', () => {
    const comps = [
      { monthly_rent: 4635, listing_status: 'active', is_rincon_managed: true },
      { monthly_rent: 4700, listing_status: 'active', is_rincon_managed: true },
    ];
    assert.deepEqual(computeRecommendedRange(comps), { low: null, mid: null, high: null });
    assert.deepEqual(computeRawRange(comps), { low: null, high: null });
  });

  await check('excludeRinconManaged() keeps comps with is_rincon_managed false/undefined, drops only true', () => {
    const comps = [
      { monthly_rent: 4000, is_rincon_managed: false },
      { monthly_rent: 4100 }, // undefined — treated as not managed
      { monthly_rent: 4200, is_rincon_managed: true },
    ];
    const kept = excludeRinconManaged(comps);
    assert.equal(kept.length, 2);
    assert.deepEqual(kept.map(c => c.monthly_rent), [4000, 4100]);
  });

  console.log('--- lib/weighting.js LeadSimple Move-Ins trusted-source exemption ---');

  await check('isExcludedRinconManaged() excludes a RentCast/CRMLS comp that happens to match a Rincon-managed property (unchanged behavior)', () => {
    assert.equal(isExcludedRinconManaged({ is_rincon_managed: true, source_name: 'RentCast' }), true);
    assert.equal(isExcludedRinconManaged({ is_rincon_managed: true, source_name: 'CRMLS' }), true);
  });

  await check('isExcludedRinconManaged() does NOT exclude a comp from a trusted, self-sourced source (LeadSimple Move-Ins) even though it is Rincon-managed by construction', () => {
    assert.equal(isExcludedRinconManaged({ is_rincon_managed: true, source_name: 'LeadSimple Move-Ins' }), false);
  });

  await check('isExcludedRinconManaged() never excludes a comp that is not Rincon-managed at all, regardless of source_name', () => {
    assert.equal(isExcludedRinconManaged({ is_rincon_managed: false, source_name: 'LeadSimple Move-Ins' }), false);
    assert.equal(isExcludedRinconManaged({ is_rincon_managed: false, source_name: 'RentCast' }), false);
    assert.equal(isExcludedRinconManaged({}), false, 'missing is_rincon_managed must not throw or default to excluded');
  });

  await check('SELF_SOURCED_TRUSTED_SOURCE_NAMES contains exactly "LeadSimple Move-Ins" — this exact string is load-bearing across lib/sources.js, the migration\'s rental_comp_sources seed, and this set', () => {
    assert.equal(SELF_SOURCED_TRUSTED_SOURCE_NAMES.has('LeadSimple Move-Ins'), true);
    assert.equal(SELF_SOURCED_TRUSTED_SOURCE_NAMES.has('RentCast'), false);
    assert.equal(SELF_SOURCED_TRUSTED_SOURCE_NAMES.has('CRMLS'), false);
  });

  await check('excludeRinconManaged() drops a Rincon-managed RentCast comp but KEEPS a Rincon-managed LeadSimple Move-Ins comp', () => {
    const comps = [
      { monthly_rent: 4000, is_rincon_managed: true, source_name: 'RentCast' },
      { monthly_rent: 4100, is_rincon_managed: true, source_name: 'LeadSimple Move-Ins' },
      { monthly_rent: 4200, is_rincon_managed: false, source_name: 'CRMLS' },
    ];
    const kept = excludeRinconManaged(comps);
    assert.deepEqual(kept.map(c => c.monthly_rent), [4100, 4200]);
  });

  await check('THE BIG RISK, unit-tested directly: computeRecommendedRange()/computeRawRange() actually COUNT a Rincon-managed LeadSimple Move-Ins comp — this is the single biggest way this whole build could silently do nothing (spec: "this entire build will silently produce zero effect" if this exclusion fix is missed)', () => {
    const rentCastOnly = [
      { monthly_rent: 3800, listing_status: 'active', is_rincon_managed: false, source_name: 'RentCast' },
      { monthly_rent: 3900, listing_status: 'active', is_rincon_managed: false, source_name: 'RentCast' },
    ];
    const withoutLeadSimple = {
      recommended: computeRecommendedRange(rentCastOnly),
      raw: computeRawRange(rentCastOnly),
    };

    // A real, closed, confirmed-new-tenant lease priced well ABOVE the
    // RentCast comps — if it were silently excluded (the bug this test
    // guards against), raw.high and recommended.high would never move.
    const withLeadSimple = [
      ...rentCastOnly,
      { monthly_rent: 5200, listing_status: 'leased', is_rincon_managed: true, source_name: 'LeadSimple Move-Ins' },
    ];
    const afterAdding = {
      recommended: computeRecommendedRange(withLeadSimple),
      raw: computeRawRange(withLeadSimple),
    };

    assert.equal(afterAdding.raw.high, 5200, 'the LeadSimple comp must move raw.high — proof it was actually counted, not silently zeroed out');
    assert.ok(afterAdding.recommended.high > withoutLeadSimple.recommended.high, 'the LeadSimple comp (3x weight, same as any other leased comp) must pull recommended.high upward');
  });

  await check('buildWeightedSample() repeats each rent by its status weight', () => {
    const sample = buildWeightedSample([
      { monthly_rent: 100, listing_status: 'off_market' }, // weight 1
      { monthly_rent: 200, listing_status: 'leased' },     // weight 3
    ]);
    assert.equal(sample.length, 4);
    assert.equal(sample.filter(n => n === 200).length, 3);
  });

  await check('sizeSimilarityMultiplier() returns 1 for every comp when subjectBedrooms is not passed (no filtering, identical to the function not existing)', () => {
    assert.equal(sizeSimilarityMultiplier(1, undefined), 1);
    assert.equal(sizeSimilarityMultiplier(5, undefined), 1);
    assert.equal(sizeSimilarityMultiplier(null, undefined), 1);
  });

  await check('sizeSimilarityMultiplier() trusts an exact bedroom match fully, a 1-off comp at half weight, and excludes 2+ off entirely', () => {
    assert.equal(sizeSimilarityMultiplier(5, 5), 1, 'exact match');
    assert.equal(sizeSimilarityMultiplier(4, 5), 0.5, '1 bedroom under');
    assert.equal(sizeSimilarityMultiplier(6, 5), 0.5, '1 bedroom over');
    assert.equal(sizeSimilarityMultiplier(3, 5), 0, '2 bedrooms under -> excluded');
    assert.equal(sizeSimilarityMultiplier(1, 5), 0, '4 bedrooms under -> excluded');
  });

  await check('sizeSimilarityMultiplier() treats missing/unknown comp bedroom data as 1-off (moderate trust), not excluded and not fully trusted', () => {
    assert.equal(sizeSimilarityMultiplier(null, 5), 0.5);
    assert.equal(sizeSimilarityMultiplier(undefined, 5), 0.5);
  });

  await check('buildWeightedSample() with subjectBedrooms down-weights a 1-bedroom-off comp and fully excludes a 2+-off comp', () => {
    const sample = buildWeightedSample([
      { monthly_rent: 4000, listing_status: 'active', bedrooms: 5 }, // exact match, weight 2 -> repeatCount 4
      { monthly_rent: 3000, listing_status: 'active', bedrooms: 4 }, // 1 off, weight 2*0.5 -> repeatCount 2
      { monthly_rent: 1895, listing_status: 'active', bedrooms: 1 }, // 4 off -> excluded, repeatCount 0
    ], 5);
    assert.equal(sample.filter(n => n === 4000).length, 4);
    assert.equal(sample.filter(n => n === 3000).length, 2);
    assert.equal(sample.filter(n => n === 1895).length, 0);
    assert.equal(sample.length, 6);
  });

  await check('computeRecommendedRange() and computeRawRange() with subjectBedrooms exclude size-mismatched comps from both numbers, reproducing the Rio Grande St bug fix', () => {
    // Mirrors the real bug: a 5-bed subject with two well-matched 4-5bd
    // comps around $4,000-$4,500, plus two tiny 1bd/1ba comps around
    // $1,895-$2,300 that were previously counted at full weight and
    // dragged the range down. With subjectBedrooms=5 passed, those two
    // should be excluded from both computed ranges entirely.
    const comps = [
      { monthly_rent: 4000, listing_status: 'active', bedrooms: 5, is_rincon_managed: false },
      { monthly_rent: 4500, listing_status: 'active', bedrooms: 4, is_rincon_managed: false },
      { monthly_rent: 1895, listing_status: 'active', bedrooms: 1, is_rincon_managed: false },
      { monthly_rent: 2300, listing_status: 'active', bedrooms: 1, is_rincon_managed: false },
    ];
    const withoutSubjectBedrooms = computeRawRange(comps);
    assert.equal(withoutSubjectBedrooms.low, 1895, 'sanity check: without subjectBedrooms, the tiny comps still pull raw.low down');

    const raw = computeRawRange(comps, 5);
    assert.equal(raw.low, 4000, 'raw.low must exclude the 1bd comps once subjectBedrooms is passed');
    assert.equal(raw.high, 4500);

    const recommended = computeRecommendedRange(comps, 5);
    assert.ok(recommended.low >= 4000, `expected recommended.low (${recommended.low}) to stay at or above the smallest well-matched comp once the 1bd comps are excluded`);
  });

  await check('propertyTypeMultiplier() returns 1 for every comp when subjectPropertyType is not passed (no filtering, identical to the function not existing)', () => {
    assert.equal(propertyTypeMultiplier('townhouse', undefined), 1);
    assert.equal(propertyTypeMultiplier('single_family', undefined), 1);
    assert.equal(propertyTypeMultiplier(null, undefined), 1);
  });

  await check('propertyTypeMultiplier() trusts an exact property type match fully and excludes any known different type entirely — no partial-credit tier like bedroom count has', () => {
    assert.equal(propertyTypeMultiplier('single_family', 'single_family'), 1, 'exact match');
    assert.equal(propertyTypeMultiplier('townhouse', 'single_family'), 0, 'townhouse vs single_family -> excluded, not partial weight');
    assert.equal(propertyTypeMultiplier('condo', 'single_family'), 0, 'condo vs single_family -> excluded');
    assert.equal(propertyTypeMultiplier('apartment', 'single_family'), 0, 'apartment vs single_family -> excluded');
  });

  await check('propertyTypeMultiplier() treats missing/unknown property type on either side as NOT a confirmed mismatch (multiplier 1, not excluded) — unlike bedroom count, there is no "unknown -> moderate trust" tier, just "unknown -> don\'t punish it"', () => {
    assert.equal(propertyTypeMultiplier(null, 'single_family'), 1, 'unknown comp type');
    assert.equal(propertyTypeMultiplier(undefined, 'single_family'), 1, 'undefined comp type');
    assert.equal(propertyTypeMultiplier('single_family', null), 1, 'unknown subject type');
  });

  await check('buildWeightedSample() with subjectPropertyType fully excludes a known-different-type comp regardless of how well its bedroom count matches', () => {
    const sample = buildWeightedSample([
      { monthly_rent: 4000, listing_status: 'active', bedrooms: 5, property_type: 'single_family' }, // exact match on both -> repeatCount 4
      { monthly_rent: 3500, listing_status: 'active', bedrooms: 5, property_type: 'townhouse' },      // exact bedroom match, but wrong type -> repeatCount 0
    ], 5, 'single_family');
    assert.equal(sample.filter(n => n === 4000).length, 4);
    assert.equal(sample.filter(n => n === 3500).length, 0, 'a property-type mismatch must zero out the repeat count even with a perfect bedroom match');
    assert.equal(sample.length, 4);
  });

  await check('computeRecommendedRange() and computeRawRange() with subjectPropertyType exclude a known-different-type comp from both numbers, reproducing the 9831 Rio Grande St bug fix (a townhouse comp counted at full weight alongside single-family comps)', () => {
    // Mirrors the real bug: a single-family subject with well-matched
    // single-family comps around $4,650-$5,000, plus a townhouse comp at
    // $4,300 that was previously counted at full weight and could pull the
    // low end down even though "they aren't the same" (Peter's own words).
    const comps = [
      { monthly_rent: 4650, listing_status: 'active', bedrooms: 4, property_type: 'single_family', is_rincon_managed: false },
      { monthly_rent: 4800, listing_status: 'active', bedrooms: 4, property_type: 'single_family', is_rincon_managed: false },
      { monthly_rent: 5000, listing_status: 'active', bedrooms: 4, property_type: 'single_family', is_rincon_managed: false },
      { monthly_rent: 4300, listing_status: 'active', bedrooms: 4, property_type: 'townhouse', is_rincon_managed: false },
    ];
    const withoutSubjectPropertyType = computeRawRange(comps, 4);
    assert.equal(withoutSubjectPropertyType.low, 4300, 'sanity check: without subjectPropertyType, the townhouse comp still pulls raw.low down');

    const raw = computeRawRange(comps, 4, 'single_family');
    assert.equal(raw.low, 4650, 'raw.low must exclude the townhouse comp once subjectPropertyType is passed');
    assert.equal(raw.high, 5000);

    const recommended = computeRecommendedRange(comps, 4, 'single_family');
    assert.ok(recommended.low >= 4650, `expected recommended.low (${recommended.low}) to stay at or above the smallest single-family comp once the townhouse comp is excluded`);

    // No regression: an all-single-family pool (e.g. 1895 Dorrit St) has
    // nothing to exclude, so passing subjectPropertyType must not change
    // the range at all.
    const allSameType = comps.slice(0, 3);
    assert.deepEqual(computeRawRange(allSameType, 4, 'single_family'), computeRawRange(allSameType, 4));
    assert.deepEqual(computeRecommendedRange(allSameType, 4, 'single_family'), computeRecommendedRange(allSameType, 4));
  });

  console.log('--- lib/weighting.js exclusionReason() ---');

  await check('exclusionReason() returns null for a comp that contributes full weight (exact bedroom and property type match)', () => {
    assert.equal(exclusionReason({ bedrooms: 4, property_type: 'single_family', is_rincon_managed: false }, 4, 'single_family'), null);
  });

  await check('exclusionReason() returns null for a comp that contributes partial weight (1 bedroom off is still counted, just at half weight)', () => {
    assert.equal(exclusionReason({ bedrooms: 3, property_type: 'single_family', is_rincon_managed: false }, 4, 'single_family'), null);
  });

  await check('exclusionReason() returns "rincon_managed" for a Rincon-managed comp not from a trusted, self-sourced source, even when its type/bedrooms match perfectly', () => {
    assert.equal(exclusionReason({ bedrooms: 4, property_type: 'single_family', is_rincon_managed: true, source_name: 'RentCast' }, 4, 'single_family'), 'rincon_managed');
  });

  await check('exclusionReason() returns null for a Rincon-managed comp from a trusted, self-sourced source (e.g. LeadSimple Move-Ins) — it counts, so it is never "excluded"', () => {
    assert.equal(exclusionReason({ bedrooms: 4, property_type: 'single_family', is_rincon_managed: true, source_name: 'LeadSimple Move-Ins' }, 4, 'single_family'), null);
  });

  await check('exclusionReason() returns "property_type_mismatch" for a known, different property type', () => {
    assert.equal(exclusionReason({ bedrooms: 4, property_type: 'townhouse', is_rincon_managed: false }, 4, 'single_family'), 'property_type_mismatch');
  });

  await check('exclusionReason() returns "size_mismatch" for a 2+ bedroom gap', () => {
    assert.equal(exclusionReason({ bedrooms: 2, property_type: 'single_family', is_rincon_managed: false }, 4, 'single_family'), 'size_mismatch');
  });

  await check('exclusionReason() prioritizes "rincon_managed" over a property-type/size mismatch when a comp fails more than one check at once (real shape: 530 Coronado Street\'s duplex analysis had a 3bd Rincon-managed townhouse comp against a 1bd duplex subject — wrong on all three)', () => {
    assert.equal(
      exclusionReason({ bedrooms: 3, property_type: 'townhouse', is_rincon_managed: true, source_name: 'RentCast' }, 1, 'duplex'),
      'rincon_managed',
      'rincon_managed must win over property_type_mismatch/size_mismatch, since it is a different KIND of problem (not real outside market data), not just a worse match'
    );
  });

  await check('exclusionReason() prioritizes "property_type_mismatch" over "size_mismatch" when both apply (property type has no partial-credit tier, so it is the more fundamental reason)', () => {
    assert.equal(
      exclusionReason({ bedrooms: 1, property_type: 'townhouse', is_rincon_managed: false }, 4, 'single_family'),
      'property_type_mismatch'
    );
  });

  await check('exclusionReason() reproduces the real 530 Coronado Street duplex bug Judge found live (2026-09-20): single-family and townhouse comps the old narrative cited as "supporting the upper end"/"a real current floor" were actually zero-weighted for a 1bd duplex subject', () => {
    // Real stored comp data (rental_comps for analysis
    // 90403536-726d-4d08-8175-8642ccddb525) — subject is 1bd/duplex.
    const dosCaminos263 = { bedrooms: 1, property_type: 'single_family', is_rincon_managed: false }; // "Comp 5" in the old rationale
    const dosCaminos264 = { bedrooms: 1, property_type: 'single_family', is_rincon_managed: false }; // "Comp 6"
    const arcadeDr404   = { bedrooms: 2, property_type: 'townhouse',     is_rincon_managed: false }; // "Comp 15"
    const evaSt211       = { bedrooms: 2, property_type: 'single_family', is_rincon_managed: false }; // "Comp 13"
    for (const comp of [dosCaminos263, dosCaminos264, arcadeDr404, evaSt211]) {
      assert.equal(exclusionReason(comp, 1, 'duplex'), 'property_type_mismatch', JSON.stringify(comp));
    }
    // And the one comp the old rationale correctly treated as real evidence
    // (1078 S Seaward, unknown property type, exact bedroom match) must
    // still NOT be excluded.
    assert.equal(exclusionReason({ bedrooms: 1, property_type: null, is_rincon_managed: false }, 1, 'duplex'), null);
  });

  console.log('--- lib/rentcast.js ---');

  await check('mapListingStatus() never maps RentCast Inactive to leased (inferred, not confirmed)', () => {
    assert.equal(mapListingStatus('Active'), 'active');
    assert.equal(mapListingStatus('Inactive'), 'off_market');
  });

  await check('mapComparable() maps a real-shaped Active RentCast comparable correctly', () => {
    // Field names match developers.rentcast.io/reference/rent-estimate-long-term's
    // documented comparable object shape.
    const rentcastComp = {
      id: 'abc123',
      formattedAddress: '123 Main St, Newbury Park, CA 91320',
      addressLine1: '123 Main St',
      city: 'Newbury Park',
      state: 'CA',
      zipCode: '91320',
      propertyType: 'Single Family',
      bedrooms: 3,
      bathrooms: 2,
      squareFootage: 1450,
      status: 'Active',
      price: 4200,
      listedDate: '2026-07-01T00:00:00.000Z',
      removedDate: null,
      daysOnMarket: 22,
      distance: 0.8,
      latitude: 34.179615,
      longitude: -119.198962,
    };
    const mapped = mapComparable(rentcastComp);
    assert.equal(mapped.listing_status, 'active');
    assert.equal(mapped.is_estimated_price, false);
    assert.equal(mapped.property_type, 'single_family');
    assert.equal(mapped.monthly_rent, 4200);
    assert.equal(mapped.listed_date, '2026-07-01');
    assert.equal(mapped.leased_date, null);
    assert.equal(mapped.had_price_cut, false);
    assert.equal(mapped.latitude, 34.179615);
    assert.equal(mapped.longitude, -119.198962);
  });

  await check('mapComparable() maps Inactive to off_market, never leased, and leaves price-cut fields honest', () => {
    const rentcastComp = {
      formattedAddress: '456 Oak Ave, Newbury Park, CA 91320',
      propertyType: 'Multi-Family',
      bedrooms: 2,
      bathrooms: 1,
      squareFootage: 900,
      status: 'Inactive',
      price: 3100,
      listedDate: '2026-05-01T00:00:00.000Z',
      removedDate: '2026-06-15T00:00:00.000Z',
      daysOnMarket: 45,
      distance: 1.4,
    };
    const mapped = mapComparable(rentcastComp);
    assert.equal(mapped.listing_status, 'off_market');
    assert.notEqual(mapped.listing_status, 'leased');
    // Multi-Family has no safe reverse mapping (could be duplex/triplex/fourplex) — must be null, not guessed
    assert.equal(mapped.property_type, null);
    assert.equal(mapped.leased_date, '2026-06-15');
    assert.equal(mapped.original_price, null);
    assert.equal(mapped.had_price_cut, false);
    // This fixture has no latitude/longitude fields at all (unlike the Active
    // fixture above) — proves mapComparable() defaults to null rather than
    // throwing or passing `undefined` through when a comp lacks coordinates.
    assert.equal(mapped.latitude, null);
    assert.equal(mapped.longitude, null);
  });

  console.log('--- lib/rentcast.js lookupPropertyDetails() ---');

  await check('lookupPropertyDetails() maps a real-shaped Property Records match, mapping propertyType through FROM_RENTCAST_PROPERTY_TYPE', async () => {
    // Shaped like RentCast's real /v1/properties response for 1895 Dorrit
    // St (confirmed live), trimmed to the fields lookupPropertyDetails()
    // actually reads — the real response also carries tax records, owner
    // info, and sale history, which must be discarded, not mapped through.
    const originalFetch = global.fetch;
    const originalKey = process.env.RENTCAST_API_KEY;
    process.env.RENTCAST_API_KEY = 'test-key';
    global.fetch = async () => ({
      ok: true,
      json: async () => ([{
        formattedAddress: '1895 Dorrit St, Newbury Park, CA 91320',
        propertyType: 'Single Family',
        bedrooms: 4,
        bathrooms: 2,
        squareFootage: 1768,
        yearBuilt: 1965,
        owner: { names: ['Someone Else'] }, // must not be surfaced by lookupPropertyDetails()
        taxAssessments: { '2025': { value: 500000 } }, // ditto
      }]),
    });
    try {
      const details = await lookupPropertyDetails('1895 Dorrit St, Newbury Park, CA');
      assert.deepEqual(details, {
        propertyType: 'single_family',
        bedrooms: 4,
        bathrooms: 2,
        squareFootage: 1768,
        yearBuilt: 1965,
      });
      assert.equal('owner' in details, false, 'must not pass through unrelated fields like owner info');
    } finally {
      global.fetch = originalFetch;
      process.env.RENTCAST_API_KEY = originalKey;
    }
  });

  await check('lookupPropertyDetails() returns null (not a guess) for a propertyType with no safe reverse mapping, same ambiguity handling as mapComparable()', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.RENTCAST_API_KEY;
    process.env.RENTCAST_API_KEY = 'test-key';
    global.fetch = async () => ({
      ok: true,
      json: async () => ([{
        propertyType: 'Multi-Family', // no safe single_family/duplex/triplex/fourplex reverse mapping
        bedrooms: 6,
        bathrooms: 3,
        squareFootage: 2400,
        yearBuilt: 1980,
      }]),
    });
    try {
      const details = await lookupPropertyDetails('1 Multi Unit Rd, Ventura, CA');
      assert.equal(details.propertyType, null);
      assert.equal(details.bedrooms, 6); // the other fields still come through
    } finally {
      global.fetch = originalFetch;
      process.env.RENTCAST_API_KEY = originalKey;
    }
  });

  await check('lookupPropertyDetails() returns null (not a throw) when RentCast returns an empty array (no match)', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.RENTCAST_API_KEY;
    process.env.RENTCAST_API_KEY = 'test-key';
    global.fetch = async () => ({ ok: true, json: async () => ([]) });
    try {
      const details = await lookupPropertyDetails('999 Nonexistent Ave, Nowhere, CA');
      assert.equal(details, null);
    } finally {
      global.fetch = originalFetch;
      process.env.RENTCAST_API_KEY = originalKey;
    }
  });

  await check('lookupPropertyDetails() returns null (not a throw) on a non-OK HTTP response', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.RENTCAST_API_KEY;
    process.env.RENTCAST_API_KEY = 'test-key';
    global.fetch = async () => ({ ok: false, status: 500, text: async () => 'RentCast is down' });
    try {
      const details = await lookupPropertyDetails('1 Test Rd, Ventura, CA');
      assert.equal(details, null);
    } finally {
      global.fetch = originalFetch;
      process.env.RENTCAST_API_KEY = originalKey;
    }
  });

  await check('lookupPropertyDetails() returns null (not a throw) when fetch itself rejects (network error)', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.RENTCAST_API_KEY;
    process.env.RENTCAST_API_KEY = 'test-key';
    global.fetch = async () => { throw new Error('network is down'); };
    try {
      const details = await lookupPropertyDetails('1 Test Rd, Ventura, CA');
      assert.equal(details, null);
    } finally {
      global.fetch = originalFetch;
      process.env.RENTCAST_API_KEY = originalKey;
    }
  });

  console.log('--- lib/property-matching.js ---');

  await check('findBestPropertyMatch() matches a Rincon-managed address written slightly differently', () => {
    const properties = [
      { id: 'p1', address: '1895 Dorrit St', city: 'Newbury Park', state: 'CA', zip: '91320' },
      { id: 'p2', address: '200 Ventura Blvd', city: 'Camarillo', state: 'CA', zip: '93010' },
    ];
    const match = findBestPropertyMatch('1895 Dorrit Street, Newbury Park, CA 91320', properties);
    assert.ok(match, 'expected a match');
    assert.equal(match.id, 'p1');
  });

  await check('findBestPropertyMatch() returns null for an address with no real overlap', () => {
    const properties = [
      { id: 'p1', address: '1895 Dorrit St', city: 'Newbury Park', state: 'CA', zip: '91320' },
    ];
    const match = findBestPropertyMatch('555 Completely Different Rd, Oxnard, CA 93030', properties);
    assert.equal(match, null);
  });

  await check('normalizeAddress() strips unit/suite fragments after a comma so they do not block a match', () => {
    assert.equal(normalizeAddress('123 Main St, Unit 4B'), '123 main st');
  });

  await check('findBestPropertyMatch() does NOT match a different house number on the same street (TARS bug: 2194 Channel Dr vs. real 2006 Channel Dr)', () => {
    const properties = [
      { id: 'p1', address: '2006 Channel Dr', city: 'Ventura', state: 'CA', zip: '93001' },
    ];
    const match = findBestPropertyMatch('2194 Channel Dr, Ventura, CA 93001', properties);
    assert.equal(match, null, 'a different house number on the same street must never match');
  });

  await check('findBestPropertyMatch() does NOT match nearby-but-different house numbers (Darling Rd / Pierpont Blvd cases from TARS)', () => {
    const properties = [
      { id: 'p1', address: '10409 Darling Rd', city: 'Ventura', state: 'CA', zip: '93004' },
      { id: 'p2', address: '2408 Pierpont Blvd', city: 'Ventura', state: 'CA', zip: '93001' },
    ];
    assert.equal(findBestPropertyMatch('10289 Darling Rd', properties), null);
    assert.equal(findBestPropertyMatch('2637 Pierpont Blvd', properties), null);
  });

  await check('findBestPropertyMatch() does NOT match same street name across different cities (2007 Poli St, Ventura vs. real 375 N Poli St, Ojai)', () => {
    const properties = [
      { id: 'p1', address: '375 N Poli St', city: 'Ojai', state: 'CA', zip: '93023' },
    ];
    const match = findBestPropertyMatch('2007 Poli St, Ventura, CA 93001', properties);
    assert.equal(match, null);
  });

  await check('houseNumber() keeps a hyphenated house-number range intact (TARS bug: "77-79 Raemere St" was truncated to just "77")', () => {
    assert.equal(houseNumber(normalizeAddress('77-79 Raemere St.')), '77-79');
  });

  await check('normalizeAddress() keeps the street name after a hyphenated house number, not just the leading digits', () => {
    assert.equal(normalizeAddress('77-79 Raemere St.'), '77-79 raemere st');
  });

  await check('findBestPropertyMatch() matches a hyphenated multi-unit address on house number + street, not by coincidence', () => {
    const properties = [
      { id: 'p1', address: '77-79 Raemere St.', city: 'Camarillo', state: 'CA', zip: '93010' },
    ];
    const match = findBestPropertyMatch('77-79 Raemere St, Camarillo, CA', properties);
    assert.ok(match, 'expected the hyphenated address to match on its full house-number + street');
    assert.equal(match.id, 'p1');
    // And a genuinely different building on the same hyphenated-numbering
    // street must still be rejected — proves this isn't just "starts with 77".
    const noMatch = findBestPropertyMatch('77-79 Raemere St, Camarillo, CA', [
      { id: 'p2', address: '81-83 Raemere St.', city: 'Camarillo', state: 'CA', zip: '93010' },
    ]);
    assert.equal(noMatch, null);
  });

  await check('findBestPropertyMatch() does NOT match a different unit in the same building (Judge blocker, live against real 130 N Garden St rows: Unit 1207 comp vs. real Unit 1411 row)', () => {
    // Shaped exactly like Rincon's real properties table for this address:
    // two plain rows, one "#3144," one "Unit 1411".
    const properties = [
      { id: 'plain1', address: '130 N Garden St', city: 'Ventura', state: 'CA', zip: '93001' },
      { id: 'plain2', address: '130 N Garden St', city: 'Ventura', state: 'CA', zip: '93001' },
      { id: 'unit3144', address: '130 N Garden St #3144', city: 'Ventura', state: 'CA', zip: '93001' },
      { id: 'unit1411', address: '130 N Garden St Unit 1411', city: 'Ventura', state: 'CA', zip: '93001' },
    ];
    const match = findBestPropertyMatch('130 N Garden St Unit 1207', properties);
    assert.equal(match, null, 'a comp for a different unit in the same building must never match another unit\'s row');
  });

  await check('findBestPropertyMatch() still matches a unit address against its own exact row', () => {
    const properties = [
      { id: 'unit1411', address: '130 N Garden St Unit 1411', city: 'Ventura', state: 'CA', zip: '93001' },
      { id: 'unit3144', address: '130 N Garden St #3144', city: 'Ventura', state: 'CA', zip: '93001' },
    ];
    const match = findBestPropertyMatch('130 N Garden St Unit 1411', properties);
    assert.ok(match, 'expected the exact same unit to match');
    assert.equal(match.id, 'unit1411');
  });

  await check('unitIdentifier() extracts a unit number from "Unit N" and a "#N" suite consistently', () => {
    assert.equal(unitIdentifier('130 N Garden St Unit 1411'), '1411');
    assert.equal(unitIdentifier('130 N Garden St #3144'), '3144');
    assert.equal(unitIdentifier('130 N Garden St'), null);
  });

  await check('unitIdentifier() finds the unit even when RentCast puts it in its own comma segment (real shape returned live: "130 N Garden St, Unit 3144, Ventura, CA 93001")', () => {
    assert.equal(unitIdentifier('130 N Garden St, Unit 3144, Ventura, CA 93001'), '3144');
  });

  await check('findBestPropertyMatch() matches a real RentCast-shaped comp address ("130 N Garden St, Unit 3144, Ventura, CA 93001") to the correct real #3144 row, not a unit-less row (live regression: caught when unitIdentifier only scanned the pre-comma segment and missed a comma-separated unit)', () => {
    const properties = [
      { id: 'plain1', address: '130 N Garden St', city: 'Ventura', state: 'CA', zip: '93001' },
      { id: 'plain2', address: '130 N Garden St', city: 'Ventura', state: 'CA', zip: '93001' },
      { id: 'unit3144', address: '130 N Garden St #3144', city: 'Ventura', state: 'CA', zip: '93001' },
      { id: 'unit1411', address: '130 N Garden St Unit 1411', city: 'Ventura', state: 'CA', zip: '93001' },
    ];
    const match = findBestPropertyMatch('130 N Garden St, Unit 3144, Ventura, CA 93001', properties);
    assert.ok(match, 'expected a match');
    assert.equal(match.id, 'unit3144', 'must match the real #3144 row, not fall back to a unit-less plain row');
  });

  await check('hasParseableHouseNumber() rejects an address with no street number (Judge bug: "Maple St, Santa Paula, CA" got a confident RentCast result anyway)', () => {
    assert.equal(hasParseableHouseNumber('Maple St, Santa Paula, CA'), false);
    assert.equal(hasParseableHouseNumber(''), false);
    assert.equal(hasParseableHouseNumber(null), false);
  });

  await check('hasParseableHouseNumber() accepts real addresses, including a hyphenated house-number range', () => {
    assert.equal(hasParseableHouseNumber('130 N Garden St Unit 1411, Ventura, CA 93001'), true);
    assert.equal(hasParseableHouseNumber('77-79 Raemere St, Camarillo, CA'), true);
  });

  console.log('--- lib/property-matching.js addressesMatch() / dedupeComps() ---');

  await check('addressesMatch() matches the same real unit written slightly differently across sources (real dedup bug: RentCast\'s "1696 Salt River Ave" vs. CRMLS\'s "1696 Salt River Avenue", both Ventura 93004)', () => {
    assert.equal(addressesMatch('1696 Salt River Ave, Ventura, CA 93004', '1696 Salt River Avenue, Ventura, CA 93004'), true);
    assert.equal(addressesMatch('10872 Kings Rd, Ventura, CA 93004', '10872 Kings Road, Ventura, CA 93004'), true);
  });

  await check('addressesMatch() does NOT match a different house number on the same street', () => {
    assert.equal(addressesMatch('2194 Channel Dr, Ventura, CA 93001', '2006 Channel Dr, Ventura, CA 93001'), false);
  });

  await check('addressesMatch() does NOT match a different unit in the same building', () => {
    assert.equal(addressesMatch('130 N Garden St Unit 1207', '130 N Garden St Unit 1411'), false);
  });

  await check('addressesMatch() returns false for missing/empty input rather than throwing', () => {
    assert.equal(addressesMatch(null, '123 Main St'), false);
    assert.equal(addressesMatch('123 Main St', ''), false);
    assert.equal(addressesMatch(undefined, undefined), false);
  });

  await check('dedupeComps() collapses a RentCast off_market comp and a CRMLS leased comp for the same real unit into one, keeping the leased (higher-weight) row (real dedup bug: 1696 Salt River Ave)', () => {
    const comps = [
      { address: '1696 Salt River Ave, Ventura, CA 93004', listing_status: 'off_market', monthly_rent: 4700, distance_miles: 1.2, source_name: 'RentCast' },
      { address: '1696 Salt River Avenue, Ventura, CA 93004', listing_status: 'leased', monthly_rent: 4700, distance_miles: 1.2, source_name: 'CRMLS' },
    ];
    const deduped = dedupeComps(comps);
    assert.equal(deduped.length, 1, 'expected the pair to collapse into a single comp');
    assert.equal(deduped[0].listing_status, 'leased', 'the confirmed leased comp must survive over the inferred off_market one');
  });

  await check('dedupeComps() leaves genuinely different comps alone', () => {
    const comps = [
      { address: '1696 Salt River Ave, Ventura, CA 93004', listing_status: 'off_market', monthly_rent: 4700, distance_miles: 1.2 },
      { address: '10872 Kings Rd, Ventura, CA 93004', listing_status: 'off_market', monthly_rent: 5500, distance_miles: 2.1 },
    ];
    const deduped = dedupeComps(comps);
    assert.equal(deduped.length, 2);
  });

  await check('dedupeComps() handles the same SOURCE reporting the same address twice (real shape: CRMLS returning both an older Active record and a newer Closed/leased one) — keeps the leased row, same status-weight tiebreak as the cross-source case', () => {
    const comps = [
      { address: '1203 Nilgai Place, Ventura, CA 93003', listing_status: 'active', monthly_rent: 3000, distance_miles: 0.8, source_name: 'CRMLS' },
      { address: '1203 Nilgai Place, Ventura, CA 93003', listing_status: 'leased', monthly_rent: 3100, distance_miles: 0.8, source_name: 'CRMLS' },
    ];
    const deduped = dedupeComps(comps);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].listing_status, 'leased');
    assert.equal(deduped[0].monthly_rent, 3100, 'the surviving row must be the leased one\'s own data, not a merge');
  });

  await check('dedupeComps() breaks a tied listing_status by preferring the comp with a real (non-null) distance_miles', () => {
    const comps = [
      { address: '500 Elm St, Ventura, CA 93001', listing_status: 'active', monthly_rent: 3500, distance_miles: null },
      { address: '500 Elm Street, Ventura, CA 93001', listing_status: 'active', monthly_rent: 3550, distance_miles: 1.5 },
    ];
    const deduped = dedupeComps(comps);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].distance_miles, 1.5, 'the comp with a real distance must win the tie over the one with a null distance');
  });

  await check('dedupeComps() breaks a fully-tied pair (same status weight, same distance-availability) by first-seen-wins', () => {
    const comps = [
      { address: '500 Elm St, Ventura, CA 93001', listing_status: 'active', monthly_rent: 3500, distance_miles: 1.0 },
      { address: '500 Elm Street, Ventura, CA 93001', listing_status: 'active', monthly_rent: 3550, distance_miles: 1.1 },
    ];
    const deduped = dedupeComps(comps);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].monthly_rent, 3500, 'fully tied -> the first-seen comp must survive');
  });

  await check('dedupeComps() drops the loser entirely — it never appears anywhere in the output, not even as a secondary field', () => {
    const comps = [
      { address: '1696 Salt River Ave, Ventura, CA 93004', listing_status: 'off_market', monthly_rent: 4700, distance_miles: 1.2 },
      { address: '1696 Salt River Avenue, Ventura, CA 93004', listing_status: 'leased', monthly_rent: 4700, distance_miles: 1.2 },
    ];
    const deduped = dedupeComps(comps);
    assert.equal(JSON.stringify(deduped).includes('off_market'), false, 'the off_market loser must not appear anywhere in the result');
  });

  await check('dedupeComps() is a no-op on an empty or undefined list', () => {
    assert.deepEqual(dedupeComps([]), []);
    assert.deepEqual(dedupeComps(undefined), []);
  });

  await check('dedupeComps() breaks a tied listing_status by preferring the trusted-source (LeadSimple Move-Ins) comp over a same-weight CRMLS comp for the same unit — guards the spec\'s own flagged risk: a Rincon-managed unit independently listed on CRMLS around the same time could otherwise win the tie and then get wrongly excluded by excludeRinconManaged()', () => {
    const comps = [
      { address: '1 Test St, Ventura, CA 93001', listing_status: 'leased', monthly_rent: 3500, distance_miles: 1.0, source_name: 'CRMLS' },
      { address: '1 Test Street, Ventura, CA 93001', listing_status: 'leased', monthly_rent: 3550, distance_miles: null, source_name: 'LeadSimple Move-Ins' },
    ];
    const deduped = dedupeComps(comps);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].source_name, 'LeadSimple Move-Ins', 'the trusted-source comp must win the tie even without a real distance_miles');
  });

  await check('dedupeComps() trusted-source tie-break wins regardless of which comp was seen first', () => {
    const comps = [
      { address: '1 Test St, Ventura, CA 93001', listing_status: 'leased', monthly_rent: 3550, distance_miles: null, source_name: 'LeadSimple Move-Ins' },
      { address: '1 Test Street, Ventura, CA 93001', listing_status: 'leased', monthly_rent: 3500, distance_miles: 1.0, source_name: 'CRMLS' },
    ];
    const deduped = dedupeComps(comps);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].source_name, 'LeadSimple Move-Ins');
  });

  await check('dedupeComps() still prefers a HIGHER-weight comp over a trusted-source one when they are not actually tied (trusted-source only breaks a real tie, never overrides the weight rule)', () => {
    const comps = [
      { address: '1 Test St, Ventura, CA 93001', listing_status: 'leased', monthly_rent: 3550, distance_miles: null, source_name: 'LeadSimple Move-Ins' }, // weight 3
      { address: '1 Test Street, Ventura, CA 93001', listing_status: 'active', monthly_rent: 3500, distance_miles: 1.0, source_name: 'RentCast' }, // weight 2, lower
    ];
    const deduped = dedupeComps(comps);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].source_name, 'LeadSimple Move-Ins', 'leased (3x) must still beat active (2x) regardless of trusted-source status');
  });

  console.log('--- lib/property-matching.js dedupeComps() exclusion-aware tie-break (subjectBedrooms/subjectPropertyType) ---');

  await check('dedupeComps() called with no subjectBedrooms/subjectPropertyType behaves EXACTLY as before (backward compatible) — keeps the higher-weight (leased) duplicate even though it would actually be excluded from the range, since the caller never opted in to the exclusion-aware check', () => {
    const comps = [
      { address: '1 Test St, Ventura, CA 93001', listing_status: 'off_market', monthly_rent: 2000, bedrooms: 1, property_type: 'single_family' },
      { address: '1 Test Street, Ventura, CA 93001', listing_status: 'leased', monthly_rent: 4000, bedrooms: 4, property_type: 'townhouse' },
    ];
    const deduped = dedupeComps(comps);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].listing_status, 'leased', 'with no subject context passed, the old status-weight-only rule must still decide this, unchanged');
  });

  await check('dedupeComps() WITH subjectBedrooms/subjectPropertyType prefers the duplicate that would actually count toward the range over a higher-weight one that would be excluded — the exact bug this build fixes: two sources disagreeing on the same real unit\'s type/bedrooms', () => {
    const comps = [
      // Same real unit, reported differently by two sources: RentCast says
      // a 4bd townhouse (wrong on both counts vs. a 1bd single_family
      // subject) and leased (highest status weight); CRMLS says the real
      // 1bd single_family truth, but only active (lower status weight).
      { address: '1 Test St, Ventura, CA 93001', listing_status: 'leased', monthly_rent: 4000, bedrooms: 4, property_type: 'townhouse', source_name: 'RentCast' },
      { address: '1 Test Street, Ventura, CA 93001', listing_status: 'active', monthly_rent: 2100, bedrooms: 1, property_type: 'single_family', source_name: 'CRMLS' },
    ];
    const withoutSubjectContext = dedupeComps(comps);
    assert.equal(withoutSubjectContext[0].source_name, 'RentCast', 'sanity check: without subject context, the old status-weight rule keeps the (wrong) leased townhouse');

    const deduped = dedupeComps(comps, 1, 'single_family');
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].source_name, 'CRMLS', 'the comp that would actually count toward the range must survive, even though it has a lower status weight');
  });

  await check('dedupeComps() exclusion-aware check is a genuine no-op when both duplicates agree on excluded status — falls through to the unchanged status-weight tie-break', () => {
    // Both candidates are a matching type/bedroom count for the subject
    // (neither excluded) -> step 0 has nothing to decide, so the ordinary
    // status-weight rule (leased beats active) must still apply.
    const comps = [
      { address: '1 Test St, Ventura, CA 93001', listing_status: 'active', monthly_rent: 2000, bedrooms: 1, property_type: 'single_family' },
      { address: '1 Test Street, Ventura, CA 93001', listing_status: 'leased', monthly_rent: 2050, bedrooms: 1, property_type: 'single_family' },
    ];
    const deduped = dedupeComps(comps, 1, 'single_family');
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].listing_status, 'leased', 'neither candidate is excluded, so the status-weight tie-break must still decide this, unchanged');
  });

  await check('dedupeComps() exclusion-aware check also fires when BOTH duplicates would be excluded (both wrong type) — falls through to the unchanged status-weight tie-break rather than making an arbitrary choice', () => {
    const comps = [
      { address: '1 Test St, Ventura, CA 93001', listing_status: 'active', monthly_rent: 2000, bedrooms: 4, property_type: 'townhouse' },
      { address: '1 Test Street, Ventura, CA 93001', listing_status: 'leased', monthly_rent: 2050, bedrooms: 4, property_type: 'condo' },
    ];
    const deduped = dedupeComps(comps, 1, 'single_family');
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].listing_status, 'leased', 'both candidates are excluded either way, so status-weight still decides which single row is kept for display');
  });

  console.log('--- lib/rentcast.js pullRentCastComps() coordinates ---');

  // pullRentCastComps() calls the real global fetch(), so these mock it the
  // same way runActiveSources()'s tests below mock SOURCE_HANDLERS.RentCast
  // — swap it out, restore it in `finally` even on assertion failure.
  await check('pullRentCastComps() reads subject coordinates from subjectProperty and maps each comp\'s coordinates', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.RENTCAST_API_KEY;
    process.env.RENTCAST_API_KEY = 'test-key';
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        rent: 4200,
        // Top-level duplicate, per the migration's design notes — present
        // here too, but subjectProperty's own values must win (next test
        // below covers the fallback when subjectProperty lacks them).
        latitude: 99.9,
        longitude: -99.9,
        subjectProperty: { state: 'CA', city: 'Newbury Park', latitude: 34.179615, longitude: -119.198962 },
        comparables: [
          // price is required for a comparable to be a comp at all (a missing
          // or 0 price means "rent unknown" and is dropped — see mapComparable()).
          { formattedAddress: '123 Main St, Newbury Park, CA 91320', state: 'CA', distance: 0.8, latitude: 34.180001, longitude: -119.199501, price: 3900 },
        ],
      }),
    });
    try {
      const result = await pullRentCastComps({ address: '456 Oak Ave, Newbury Park, CA', propertyType: 'single_family', bedrooms: 3, bathrooms: 2, sqft: 1450 });
      assert.equal(result.subjectLatitude, 34.179615);
      assert.equal(result.subjectLongitude, -119.198962);
      assert.equal(result.comps[0].latitude, 34.180001);
      assert.equal(result.comps[0].longitude, -119.199501);
    } finally {
      global.fetch = originalFetch;
      process.env.RENTCAST_API_KEY = originalKey;
    }
  });

  await check('pullRentCastComps() falls back to the response\'s top-level latitude/longitude when subjectProperty omits them', async () => {
    // Guards the fallback branch in pullRentCastComps() — not expected to
    // happen with RentCast's current response shape (subjectProperty always
    // carries them today, per the migration's design notes), but the field
    // is duplicated at the top level specifically so a future shape change
    // wouldn't silently lose the subject's coordinates.
    const originalFetch = global.fetch;
    const originalKey = process.env.RENTCAST_API_KEY;
    process.env.RENTCAST_API_KEY = 'test-key';
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        rent: 4200,
        latitude: 34.2,
        longitude: -119.3,
        subjectProperty: { state: 'CA', city: 'Newbury Park' }, // no latitude/longitude here
        comparables: [],
      }),
    });
    try {
      const result = await pullRentCastComps({ address: '456 Oak Ave, Newbury Park, CA', propertyType: 'single_family', bedrooms: 3, bathrooms: 2, sqft: 1450 });
      assert.equal(result.subjectLatitude, 34.2);
      assert.equal(result.subjectLongitude, -119.3);
    } finally {
      global.fetch = originalFetch;
      process.env.RENTCAST_API_KEY = originalKey;
    }
  });

  await check('assessPlausibility() rejects a response with no resolved subjectProperty (TARS bug: nonsense address still returned HTTP 200)', () => {
    // Real shape RentCast returned for "asdkfjaslkdfj not a real address
    // 999999" — subjectProperty has no address fields at all, just the
    // bedrooms/bathrooms/sqft we sent in and a fallback lat/long.
    const data = {
      rent: 1990,
      subjectProperty: { latitude: 45.99, longitude: -122.44, bedrooms: 2, bathrooms: 2, squareFootage: 1000 },
      comparables: [
        { formattedAddress: '44805 Ne Yale Bridge Rd, Amboy, WA 98601', state: 'WA', distance: 4.9 },
      ],
    };
    const result = assessPlausibility(data);
    assert.equal(result.plausible, false);
    assert.match(result.reason, /could not resolve/i);
  });

  await check('assessPlausibility() rejects a resolved subject outside California', () => {
    const data = {
      subjectProperty: { city: 'Amboy', state: 'WA', latitude: 45.99, longitude: -122.44 },
      comparables: [{ formattedAddress: '1 Test Rd, Amboy, WA 98601', state: 'WA', distance: 2 }],
    };
    const result = assessPlausibility(data);
    assert.equal(result.plausible, false);
    assert.match(result.reason, /outside California/);
  });

  await check('assessPlausibility() rejects when none of the comps are within a plausible distance', () => {
    const data = {
      subjectProperty: { city: 'Ventura', state: 'CA' },
      comparables: [
        { formattedAddress: '1 Far Rd, Somewhere, CA 90000', state: 'CA', distance: 200 },
        { formattedAddress: '2 Far Rd, Somewhere, CA 90000', state: 'CA', distance: 300 },
      ],
    };
    const result = assessPlausibility(data);
    assert.equal(result.plausible, false);
    assert.match(result.reason, /within 50 miles/);
  });

  await check('assessPlausibility() accepts a normal, well-resolved California response', () => {
    const data = {
      subjectProperty: { city: 'Ventura', state: 'CA', latitude: 34.27, longitude: -119.27 },
      comparables: [
        { formattedAddress: '1153 Montauk Ln, Ventura, CA 93001', state: 'CA', distance: 0.48 },
        { formattedAddress: '622 S Evergreen Dr, Ventura, CA 93003', state: 'CA', distance: 0.29 },
      ],
    };
    const result = assessPlausibility(data);
    assert.equal(result.plausible, true);
    assert.equal(result.reason, null);
  });

  await check('assessPlausibility() accepts a resolved California subject with zero comparables (a different, pre-existing failure path handles "no comps")', () => {
    const data = { subjectProperty: { city: 'Ventura', state: 'CA' }, comparables: [] };
    const result = assessPlausibility(data);
    assert.equal(result.plausible, true);
  });

  console.log('--- lib/rentcast.js radius tiering ---');

  await check('pullRentCastComps() requests the real documented maxRadius param set to WIDE_SEARCH_RADIUS_MILES', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.RENTCAST_API_KEY;
    process.env.RENTCAST_API_KEY = 'test-key';
    // pullRentCastComps() now makes a second (listings) request whenever the
    // AVM response carries coordinates, so record the URL of the AVM call
    // specifically rather than "the last URL fetched".
    let avmUrl = null;
    global.fetch = async (url) => {
      if (String(url).includes('/avm/rent/long-term')) avmUrl = String(url);
      return { ok: true, json: async () => ({ rent: 4200, subjectProperty: { state: 'CA', latitude: 34.179615, longitude: -119.198962 }, comparables: [] }) };
    };
    try {
      await pullRentCastComps({ address: '456 Oak Ave, Newbury Park, CA', propertyType: 'single_family', bedrooms: 3, bathrooms: 2, sqft: 1450 });
      assert.ok(avmUrl, 'expected an AVM request');
      const maxRadius = new URL(avmUrl).searchParams.get('maxRadius');
      assert.equal(maxRadius, String(WIDE_SEARCH_RADIUS_MILES), 'expected maxRadius to be sent as WIDE_SEARCH_RADIUS_MILES on the AVM call, one call, no separate narrow request');
    } finally {
      global.fetch = originalFetch;
      process.env.RENTCAST_API_KEY = originalKey;
    }
  });

  console.log('--- lib/narrative.js ---');

  await check('parseNarrativeOutput() parses a well-formed trailing marker line', () => {
    const text = `Some reasoning text here.\n\nRENTAL_ANALYSIS_OUTPUT: {"rationale": "Because comp 0 is close and recent.", "comp_narratives": {"0": "A strong nearby comp."}}`;
    const { rationale, narrativesByIndex } = parseNarrativeOutput(text, 1);
    assert.equal(rationale, 'Because comp 0 is close and recent.');
    assert.equal(narrativesByIndex[0], 'A strong nearby comp.');
  });

  await check('parseNarrativeOutput() throws clearly (not a silent fallback) when the marker line is missing', () => {
    assert.throws(() => parseNarrativeOutput('No marker line here.', 1), /did not end with the expected/);
  });

  await check('parseNarrativeOutput() throws clearly on malformed JSON after the marker', () => {
    assert.throws(() => parseNarrativeOutput('RENTAL_ANALYSIS_OUTPUT: {not valid json}', 1), /not valid JSON/);
  });

  await check('parseNarrativeOutput() fills a missing per-comp narrative with null instead of throwing', () => {
    const text = `RENTAL_ANALYSIS_OUTPUT: {"rationale": "ok", "comp_narratives": {"0": "first"}}`;
    const { narrativesByIndex } = parseNarrativeOutput(text, 2);
    assert.equal(narrativesByIndex[0], 'first');
    assert.equal(narrativesByIndex[1], null);
  });

  const narrativePromptFixture = {
    subject: { address: '1 Test St, Ventura, CA 93001', bedrooms: 3, bathrooms: 2, sqft: 1500, propertyType: 'single_family', yearBuilt: 2000, leaseTermMonths: 12, furnished: false },
    comps: [
      { address: '2 Comp St', bedrooms: 3, bathrooms: 2, sqft: 1450, monthly_rent: 3000, listing_status: 'leased' },
      { address: '3 Comp St', bedrooms: 3, bathrooms: 2, sqft: 1480, monthly_rent: 3100, listing_status: 'off_market' },
    ],
    recommended: { low: 2900, high: 3200, mid: 3050 },
    raw: { low: 2900, high: 3200 },
    subjectEstimatedRent: 3050,
    sourcesUsed: ['RentCast', 'CRMLS'],
  };

  await check('buildPrompt() reports sourcesUsed as they actually are, and never asserts "RentCast only" when CRMLS also ran', () => {
    const prompt = buildPrompt(narrativePromptFixture);
    assert.match(prompt, /came from: RentCast, CRMLS/);
    assert.doesNotMatch(prompt, /RentCast only/);
  });

  await check('buildPrompt() keys its trust rule off listing_status (leased/active/off_market), not source name', () => {
    const prompt = buildPrompt(narrativePromptFixture);
    assert.match(prompt, /"leased" = a real, confirmed transaction/);
    assert.match(prompt, /"active" = a real, current asking price/);
    assert.match(prompt, /"off_market" = delisted with no way to confirm/);
  });

  await check('buildPrompt() states leased comps count 3x today, not "will count more once... is live"', () => {
    const prompt = buildPrompt(narrativePromptFixture);
    assert.match(prompt, /leased comps count 3x today/);
    assert.doesNotMatch(prompt, /will count for more once/);
  });

  await check('buildPrompt() with a RentCast-only run still reports sourcesUsed accurately (no CRMLS wording assumed)', () => {
    const prompt = buildPrompt({ ...narrativePromptFixture, sourcesUsed: ['RentCast'] });
    assert.match(prompt, /came from: RentCast\.$/m);
  });

  await check('describeComp() tells Claude a RentCast/CRMLS comp that happens to match a Rincon property is "internal reference only" (unchanged behavior)', () => {
    const desc = describeComp({ address: '1 Test St', monthly_rent: 4000, listing_status: 'active', is_rincon_managed: true, source_name: 'RentCast' }, 0);
    assert.match(desc, /internal reference only/);
  });

  await check('describeComp() does NOT tell Claude a LeadSimple Move-Ins comp is "internal reference only" — it must say the comp IS counted, matching lib/weighting.js\'s isExcludedRinconManaged() so Claude is never told a 3x-weighted, counted comp was excluded', () => {
    const desc = describeComp({ address: '1 Test St', monthly_rent: 4000, listing_status: 'leased', is_rincon_managed: true, source_name: 'LeadSimple Move-Ins' }, 0);
    assert.doesNotMatch(desc, /internal reference only/);
    assert.match(desc, /counted in the range/);
  });

  await check('describeComp() says nothing about Rincon-managed status at all for a comp that is not Rincon-managed', () => {
    const desc = describeComp({ address: '1 Test St', monthly_rent: 4000, listing_status: 'active', is_rincon_managed: false, source_name: 'RentCast' }, 0);
    assert.doesNotMatch(desc, /Rincon-managed/);
  });

  await check('describeComp() marks a comp with exclusion_reason "property_type_mismatch" as NOT COUNTED — the real bug this build fixes (Claude previously had no way to know a comp had been zero-weighted)', () => {
    const desc = describeComp({ address: '404 Arcade Drive', monthly_rent: 3475, listing_status: 'leased', bedrooms: 2, property_type: 'townhouse', exclusion_reason: 'property_type_mismatch' }, 0);
    assert.match(desc, /NOT COUNTED in the range/);
  });

  await check('describeComp() marks a comp with exclusion_reason "size_mismatch" as NOT COUNTED', () => {
    const desc = describeComp({ address: '1 Test St', monthly_rent: 4000, listing_status: 'off_market', bedrooms: 5, exclusion_reason: 'size_mismatch' }, 0);
    assert.match(desc, /NOT COUNTED in the range/);
  });

  await check('describeComp() marks a comp with exclusion_reason "rincon_managed" as NOT COUNTED, taking priority over the older is_rincon_managed-only wording (exclusion_reason is always the authoritative, server-computed answer)', () => {
    const desc = describeComp({ address: '1 Test St', monthly_rent: 4000, listing_status: 'active', is_rincon_managed: true, source_name: 'RentCast', exclusion_reason: 'rincon_managed' }, 0);
    assert.match(desc, /NOT COUNTED in the range/);
    assert.match(desc, /internal reference only/);
  });

  await check('describeComp() with exclusion_reason explicitly null (the normal "counted" case from server.js/router.js) behaves exactly like exclusion_reason being absent', () => {
    const withNull = describeComp({ address: '1 Test St', monthly_rent: 4000, listing_status: 'active', bedrooms: 3, exclusion_reason: null }, 0);
    const withoutField = describeComp({ address: '1 Test St', monthly_rent: 4000, listing_status: 'active', bedrooms: 3 }, 0);
    assert.equal(withNull, withoutField);
    assert.doesNotMatch(withNull, /NOT COUNTED/);
  });

  await check('buildPrompt() hard rules explicitly tell Claude never to cite a NOT COUNTED comp as evidence for the range — the exact instruction added to fix the 530 Coronado Street duplex bug (Judge found live, 2026-09-20)', () => {
    const prompt = buildPrompt({
      ...narrativePromptFixture,
      comps: [
        { address: '2 Comp St', bedrooms: 3, bathrooms: 2, sqft: 1450, monthly_rent: 3000, listing_status: 'leased', exclusion_reason: null },
        { address: '404 Arcade Drive', bedrooms: 2, bathrooms: 1.8, sqft: 1000, monthly_rent: 3475, listing_status: 'leased', property_type: 'townhouse', exclusion_reason: 'property_type_mismatch' },
      ],
    });
    assert.match(prompt, /NEVER cite a NOT COUNTED comp as a reason, a floor, a ceiling, support, or justification/);
    assert.match(prompt, /COMP 1: 404 Arcade Drive.*NOT COUNTED in the range/);
  });

  // ── Property type on every comp line + the rules that stop Claude inventing
  //    type facts (TARS live run, 2026-10-14: an unknown-type comp was called
  //    a "townhouse" and the NOT COUNTED group was described as "mostly
  //    2bd/1ba apartments" when the real mix was mostly single-family/condo). ──
  await check('describeComp() includes the stored property type on the comp line, for every stored value', () => {
    for (const t of ['single_family', 'condo', 'townhouse', 'duplex', 'triplex', 'fourplex', 'apartment', 'manufactured', 'other']) {
      const desc = describeComp({ address: '1 Test St', monthly_rent: 4000, listing_status: 'active', bedrooms: 3, property_type: t }, 0);
      assert.match(desc, new RegExp(`\\| type: ${t} \\|`), `${t} missing from: ${desc}`);
    }
  });

  await check('describeComp() says "type: unknown" (never a guessed type) when property_type is null, undefined or empty', () => {
    for (const v of [null, undefined, '']) {
      const desc = describeComp({ address: '3677 Willowick', monthly_rent: 3900, listing_status: 'leased', bedrooms: 3, property_type: v }, 84);
      assert.match(desc, /\| type: unknown \|/);
      assert.doesNotMatch(desc, /townhouse|condo|single_family|apartment/);
    }
  });

  await check('describeComp() puts the type on NOT COUNTED lines too, and its added field does not disturb the rest of the line', () => {
    const desc = describeComp({ address: '404 Arcade Drive', monthly_rent: 3475, listing_status: 'leased', bedrooms: 2, bathrooms: 1.8, sqft: 1000, property_type: 'apartment', exclusion_reason: 'property_type_mismatch' }, 7);
    assert.equal(desc, "COMP 7: 404 Arcade Drive | 2bd/1.8ba | 1000 sqft | type: apartment | rent $3,475 | status: leased | this comp's property type does not match the subject's — NOT COUNTED in the range");
  });

  await check('buildPrompt() lists each comp\'s property type (and "unknown") in the COMPS block', () => {
    const prompt = buildPrompt({
      ...narrativePromptFixture,
      comps: [
        { address: '2 Comp St', bedrooms: 3, bathrooms: 2, monthly_rent: 3000, listing_status: 'leased', property_type: 'townhouse' },
        { address: '3 Comp St', bedrooms: 3, bathrooms: 2, monthly_rent: 3100, listing_status: 'leased', property_type: null },
      ],
    });
    assert.match(prompt, /COMP 0: 2 Comp St.*type: townhouse/);
    assert.match(prompt, /COMP 1: 3 Comp St.*type: unknown/);
  });

  await check('buildPrompt() hard rules: property type only as given on the comp\'s line, "unknown" means unknown, never guess a type', () => {
    const prompt = buildPrompt(narrativePromptFixture);
    assert.match(prompt, /State a comp's property type ONLY exactly as given on its own line/);
    assert.match(prompt, /"type: unknown" means the type is unknown/);
    assert.match(prompt, /never infer or guess it/);
    assert.match(prompt, /never call an unknown-type comp a townhouse, condo, house, apartment, or any other type/);
  });

  await check('buildPrompt() hard rules: no characterizing the NOT COUNTED group as a whole, but how many and why is allowed', () => {
    const prompt = buildPrompt(narrativePromptFixture);
    assert.match(prompt, /Do NOT characterize the makeup of the NOT COUNTED comps as a group \(their property types, sizes, bedroom mix, rents, or locations\) beyond what is literally stated on each individual line/);
    assert.match(prompt, /You may say how many comps were not counted and why/);
  });

  await check('buildPrompt() hard rules: never group or compare comps as matching when bedroom count or property type differs', () => {
    const prompt = buildPrompt(narrativePromptFixture);
    assert.match(prompt, /Never group or compare a comp with other comps as if they matched when its bedroom count or property type differs from theirs/);
    assert.match(prompt, /an unknown type matches nothing/);
  });

  await check('buildPrompt() hard rules: never say a comp matches or fits the SUBJECT\'s property type unless its own line shows that type (TARS/live run 2026-10-14: unknown-type leased comps were described as matching the subject\'s townhouse profile)', () => {
    const prompt = buildPrompt(narrativePromptFixture);
    assert.match(prompt, /Likewise, never say a comp matches or fits the subject's property type unless its own line shows that same type; an unknown type matches nothing\./);
  });

  await check('buildPrompt() hard rules: an unknown-type comp is never described as belonging to a type category (e.g. "townhouse/other")', () => {
    const prompt = buildPrompt(narrativePromptFixture);
    assert.match(prompt, /Do not describe an unknown-type comp as belonging to any type category \(for example "townhouse\/other"\)\./);
  });

  await check('buildPrompt() hard rules: any stated count of comps must be exactly right, and vague quantifiers ("a couple", "a few", "several") are barred for a number that can be counted', () => {
    const prompt = buildPrompt(narrativePromptFixture);
    assert.match(prompt, /Any count of comps you state \(counted, NOT COUNTED, Rincon-managed, per reason, and so on\) must be exactly right: count the matching lines before stating it\./);
    assert.match(prompt, /Never use a vague quantifier such as "a couple", "a few", or "several" for a number you can count; state the number\./);
  });

  await check('buildPrompt() new subject-match / category / count rules sit inside HARD RULES, before the SUBJECT PROPERTY block, and the earlier type rules are still all present', () => {
    const prompt = buildPrompt(narrativePromptFixture);
    const rules = prompt.slice(prompt.indexOf('HARD RULES:'), prompt.indexOf('SUBJECT PROPERTY:'));
    for (const re of [/Likewise, never say a comp matches or fits the subject's property type/, /belonging to any type category/, /Any count of comps you state/,
      /State a comp's property type ONLY exactly as given on its own line/, /Do NOT characterize the makeup of the NOT COUNTED comps as a group/, /Never group or compare a comp with other comps as if they matched/,
      /NEVER cite a NOT COUNTED comp as a reason, a floor, a ceiling, support, or justification/]) {
      assert.match(rules, re);
    }
  });

  await check('buildPrompt() keeps every pre-existing rule alongside the new type rules (NOT COUNTED never cited, ONLY one line output, narrated-comps cap wording)', () => {
    const prompt = buildPrompt(narrativePromptFixture);
    assert.match(prompt, /NEVER cite a NOT COUNTED comp as a reason, a floor, a ceiling, support, or justification/);
    assert.match(prompt, /Only use facts given below\. Never invent a number, address, or fact not present in this data\./);
    assert.match(prompt, /Respond with ONLY the one line below/);
    assert.match(prompt, /Base it on all 2 comps listed above, including the ones that get no narrative\./);
    assert.match(prompt, /Cite specific comps/);
  });

  // ── Narrative scaling: Claude sees every comp but narrates a capped,
  //    counted-only subset, and a max_tokens cut-off degrades instead of
  //    throwing the rationale away. All Claude calls here are mocked. ──
  console.log('--- lib/narrative.js large comp lists and max_tokens cut-offs ---');

  // 130 comps shaped like Bunting's 2-mile fallback: a mix of statuses and
  // distances, every 7th comp NOT COUNTED (property_type_mismatch).
  const manyComps = Array.from({ length: 130 }, (_, i) => ({
    address: `${100 + i} Test Ave, Ventura, CA 93003`,
    bedrooms: 4, bathrooms: 2, sqft: 1800,
    monthly_rent: 4000 + i * 10,
    listing_status: ['leased', 'active', 'off_market'][i % 3],
    distance_miles: Number(((i * 37) % 200 / 100).toFixed(2)),
    exclusion_reason: i % 7 === 0 ? 'property_type_mismatch' : null,
  }));
  const bigInput = { ...narrativePromptFixture, comps: manyComps };
  const mockClaude = replies => {
    const calls = [];
    return {
      calls,
      client: {
        messages: {
          create: async req => {
            calls.push(req);
            const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
            return typeof reply === 'function' ? reply(req) : reply;
          },
        },
      },
    };
  };
  const textReply = (text, stop_reason = 'end_turn', output_tokens = 1234) =>
    ({ stop_reason, content: [{ type: 'text', text }], usage: { output_tokens } });
  const askedIndexes = req => {
    const m = req.messages[0].content.match(/ONLY these comp numbers: ([\d, ]+)\./);
    return m ? m[1].split(',').map(x => Number(x.trim())) : [];
  };
  const answerFor = (indexes, rationale = 'Rationale over the whole sample.') =>
    `RENTAL_ANALYSIS_OUTPUT: ${JSON.stringify({ rationale, comp_narratives: Object.fromEntries(indexes.map(i => [String(i), `Narrative ${i}.`])) })}`;

  await check('pickNarratedIndexes() on 130 comps picks at most MAX_NARRATED_COMPS, never a NOT COUNTED comp, in ascending order', () => {
    const picked = pickNarratedIndexes(manyComps);
    assert.equal(picked.length, MAX_NARRATED_COMPS);
    assert.ok(picked.every(i => !manyComps[i].exclusion_reason), 'only comps that count are narrated');
    assert.deepEqual(picked, [...picked].sort((a, b) => a - b));
    assert.equal(new Set(picked).size, picked.length);
  });

  await check('pickNarratedIndexes() ranks leased before active before off_market, then nearest first, unknown distance last', () => {
    const comps = [
      { listing_status: 'off_market', distance_miles: 0.1 },  // 0
      { listing_status: 'active', distance_miles: 0.9 },      // 1
      { listing_status: 'leased', distance_miles: 1.8 },      // 2
      { listing_status: 'leased', distance_miles: 0.4 },      // 3
      { listing_status: 'leased', distance_miles: null },     // 4
      { listing_status: 'active', distance_miles: 0.2 },      // 5
    ];
    assert.deepEqual(pickNarratedIndexes(comps, 3), [2, 3, 4], 'the three leased comps win the three slots');
    assert.deepEqual(pickNarratedIndexes(comps, 4), [2, 3, 4, 5], 'then the nearest active comp');
    assert.deepEqual(pickNarratedIndexes(comps, 99), [0, 1, 2, 3, 4, 5], 'under the cap, every counted comp is narrated');
    assert.deepEqual(pickNarratedIndexes(comps, 0), []);
  });

  await check('pickNarratedIndexes() skips an excluded Rincon-managed comp even when exclusion_reason was not passed, but keeps a trusted LeadSimple Move-Ins comp', () => {
    const comps = [
      { listing_status: 'leased', is_rincon_managed: true, source_name: 'RentCast' },
      { listing_status: 'leased', is_rincon_managed: true, source_name: 'LeadSimple Move-Ins' },
      { listing_status: 'active' },
    ];
    assert.deepEqual(pickNarratedIndexes(comps), [1, 2]);
  });

  await check('buildPrompt() on 130 comps lists ALL 130 comps as context but asks for narratives only on the capped, counted set', () => {
    const prompt = buildPrompt(bigInput);
    assert.match(prompt, /COMPS \(130 total\):/);
    for (let i = 0; i < 130; i++) assert.ok(prompt.includes(`COMP ${i}: ${manyComps[i].address}`), `comp ${i} missing from the context list`);
    const asked = askedIndexes({ messages: [{ content: prompt }] });
    assert.deepEqual(asked, pickNarratedIndexes(manyComps));
    assert.ok(asked.length <= MAX_NARRATED_COMPS);
    assert.ok(asked.every(i => i % 7 !== 0), 'no NOT COUNTED comp is asked for a narrative');
    assert.match(prompt, /including the ones that get no narrative/);
    assert.match(prompt, /Respond with ONLY the one line below/);
  });

  await check('buildPrompt() on a small all-counted run still asks for a narrative on every comp (normal-size runs lose nothing)', () => {
    const prompt = buildPrompt(narrativePromptFixture);
    assert.deepEqual(askedIndexes({ messages: [{ content: prompt }] }), [0, 1]);
  });

  await check('buildPrompt() with no counted comps asks for no per-comp narratives and tells Claude to leave comp_narratives empty', () => {
    const prompt = buildPrompt({ ...narrativePromptFixture, comps: manyComps.map(c => ({ ...c, exclusion_reason: 'size_mismatch' })) });
    assert.match(prompt, /No per-comp narratives/);
    assert.doesNotMatch(prompt, /ONLY these comp numbers/);
  });

  await check('generateNarrative() on 130 comps: one call, max_tokens 16000, rationale returned, narratives only for the capped counted set, null elsewhere', async () => {
    const mock = mockClaude([req => textReply(answerFor(askedIndexes(req)))]);
    const result = await generateNarrative(bigInput, { client: mock.client });
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].max_tokens, 16000);
    assert.equal(MAX_TOKENS, 16000);
    assert.equal(result.rationale, 'Rationale over the whole sample.');
    assert.equal(result.narrativesByIndex.length, 130);
    const written = result.narrativesByIndex.map((n, i) => (n ? i : null)).filter(i => i !== null);
    assert.deepEqual(written, pickNarratedIndexes(manyComps));
    assert.equal(result.narrativesByIndex[0], null, 'comp 0 is NOT COUNTED: no narrative');
    assert.equal(result.meta.truncated, false);
    assert.equal(result.meta.narrativesWritten, MAX_NARRATED_COMPS);
  });

  await check('generateNarrative() drops a narrative Claude wrote for a comp it was not asked about (a NOT COUNTED comp stays null)', async () => {
    const mock = mockClaude([req => textReply(answerFor([...askedIndexes(req), 0, 7]))]);
    const result = await generateNarrative(bigInput, { client: mock.client });
    assert.equal(result.narrativesByIndex[0], null);
    assert.equal(result.narrativesByIndex[7], null);
  });

  await check('generateNarrative() with stop_reason max_tokens mid-narrative does NOT throw: keeps the complete rationale and the finished narratives, nulls the half-written one, no retry', async () => {
    const cutOff = 'RENTAL_ANALYSIS_OUTPUT: {"rationale": "Leased comps near the subject anchor the range. It is \\"firm\\".", "comp_narratives": {"1": "First done.", "2": "Second done.", "3": "Third was cut o';
    const mock = mockClaude([textReply(cutOff, 'max_tokens', 16000)]);
    const result = await withCapturedWarnings(warnings => generateNarrative({ ...narrativePromptFixture, comps: manyComps.slice(0, 5).map(c => ({ ...c, exclusion_reason: null })) }, { client: mock.client })
      .then(r => { assert.ok(warnings.some(w => /hit max_tokens/.test(w)), 'the cut-off is logged'); return r; }));
    assert.equal(mock.calls.length, 1, 'a usable partial result needs no retry');
    assert.equal(result.rationale, 'Leased comps near the subject anchor the range. It is "firm".');
    assert.equal(result.narrativesByIndex[1], 'First done.');
    assert.equal(result.narrativesByIndex[2], 'Second done.');
    assert.equal(result.narrativesByIndex[3], null, 'the half-written narrative is dropped, not guessed');
    assert.equal(result.meta.truncated, true);
    assert.equal(result.meta.stopReason, 'max_tokens');
  });

  await check('generateNarrative() cut off BEFORE a complete rationale retries once asking for the rationale alone, and returns it with no per-comp narratives', async () => {
    const mock = mockClaude([
      textReply('RENTAL_ANALYSIS_OUTPUT: {"rationale": "The nearby leased comps anchor the ra', 'max_tokens', 16000),
      req => textReply(answerFor([], 'Retry rationale.')),
    ]);
    const result = await withCapturedWarnings(() => generateNarrative(bigInput, { client: mock.client }));
    assert.equal(mock.calls.length, 2);
    assert.match(mock.calls[0].messages[0].content, /ONLY these comp numbers/);
    assert.match(mock.calls[1].messages[0].content, /No per-comp narratives/);
    assert.equal(result.rationale, 'Retry rationale.');
    assert.ok(result.narrativesByIndex.every(n => n === null));
    assert.equal(result.meta.retried, true);
  });

  await check('generateNarrative() cut off twice with no rationale throws a clear error (server.js/router.js catch it and still save the numbers)', async () => {
    const cut = textReply('RENTAL_ANALYSIS_OUTPUT: {"rationale": "never fini', 'max_tokens', 16000);
    const mock = mockClaude([cut, cut]);
    await withCapturedWarnings(async () => {
      await assert.rejects(() => generateNarrative(bigInput, { client: mock.client }), /cut off by max_tokens twice/);
    });
    assert.equal(mock.calls.length, 2, 'exactly one retry, never a loop');
  });

  // ── Computed facts block: exact, code-computed counts the model must quote. ──
  const factsMix = [
    { address: 'L1', listing_status: 'leased', property_type: 'townhouse', bedrooms: 2 },
    { address: 'L2', listing_status: 'leased', property_type: null, bedrooms: 3 },
    { address: 'L3', listing_status: 'leased', bedrooms: 3 },
    { address: 'L4', listing_status: 'leased', bedrooms: 3, is_rincon_managed: true, source_name: 'LeadSimple Move-Ins' },
    { address: 'A1', listing_status: 'active', property_type: 'townhouse', bedrooms: 3 },
    { address: 'A2', listing_status: 'active', property_type: null, bedrooms: 3 },
    { address: 'O1', listing_status: 'off_market', property_type: 'townhouse', bedrooms: 3 },
    { address: 'X1', listing_status: 'leased', property_type: 'apartment', bedrooms: 3, exclusion_reason: 'property_type_mismatch' },
    { address: 'X2', listing_status: 'active', property_type: 'condo', bedrooms: 3, exclusion_reason: 'property_type_mismatch' },
    { address: 'X3', listing_status: 'active', property_type: 'single_family', bedrooms: 3, exclusion_reason: 'property_type_mismatch' },
    { address: 'X4', listing_status: 'off_market', property_type: null, bedrooms: 3, exclusion_reason: 'property_type_mismatch' },
    { address: 'X5', listing_status: 'leased', property_type: 'townhouse', bedrooms: 5, exclusion_reason: 'size_mismatch' },
    { address: 'X6', listing_status: 'active', property_type: 'townhouse', bedrooms: 1, exclusion_reason: 'size_mismatch' },
    { address: 'X7', listing_status: 'leased', property_type: 'townhouse', bedrooms: 3, exclusion_reason: 'rincon_managed', is_rincon_managed: true },
    { address: 'X8', listing_status: 'leased', property_type: 'townhouse', bedrooms: 3, is_rincon_managed: true, source_name: 'RentCast' },
  ];

  await check('compFactsBlock() gives exact counts for a constructed mix: totals, NOT COUNTED by reason, counted by type (with its own "unknown" bucket), by status, leased breakdown, counted Rincon-managed', () => {
    const lines = compFactsBlock(factsMix).split('\n');
    assert.equal(lines.length, 7, 'compact: a header plus six fact lines');
    assert.match(lines[0], /^COMPUTED COMP FACTS \(counted by code/);
    assert.equal(lines[1], '- Total comps: 15. Counted in the range: 7. NOT COUNTED: 8.');
    assert.equal(lines[2], "- NOT COUNTED by reason: property type differs from the subject's 4, bedroom count 2+ off the subject's 2, Rincon-managed internal reference 2.");
    assert.equal(lines[3], '- Counted comps by property type: unknown 4, townhouse 3.');
    assert.equal(lines[4], '- Counted comps by status: leased 4, active 2, off_market 1.');
    assert.equal(lines[5], '- Counted leased comps by property type and bedrooms: unknown 3bd 3, townhouse 2bd 1.');
    assert.equal(lines[6], '- Counted comps that are also Rincon-managed: 1.');
  });

  await check('compFactsBlock() uses the same counted/NOT COUNTED decision as pickNarratedIndexes() (exclusion_reason, or an excluded Rincon-managed comp), never a type guess', () => {
    const counted = pickNarratedIndexes(factsMix).length;
    assert.match(compFactsBlock(factsMix), new RegExp(`Counted in the range: ${counted}\\.`));
    assert.equal(counted, 7);
  });

  await check('compFactsBlock() with nothing excluded or no leased comps says "none" instead of inventing a figure', () => {
    const lines = compFactsBlock([{ address: 'A', listing_status: 'active', bedrooms: 3 }]).split('\n');
    assert.equal(lines[1], '- Total comps: 1. Counted in the range: 1. NOT COUNTED: 0.');
    assert.equal(lines[2], '- NOT COUNTED by reason: none.');
    assert.equal(lines[3], '- Counted comps by property type: unknown 1.');
    assert.equal(lines[5], '- Counted leased comps by property type and bedrooms: none.');
  });

  await check('buildPrompt() carries the facts block after the COMPS list and before COMPUTED NUMBERS, for the 130-comp run (19 NOT COUNTED, all 111 counted comps type-unknown)', () => {
    const prompt = buildPrompt(bigInput);
    const at = n => prompt.indexOf(n);
    const header = 'COMPUTED COMP FACTS (counted by code';
    assert.equal(prompt.split(header).length - 1, 1, 'the block appears exactly once');
    assert.ok(at('COMPS (130 total):') < at(header) && at(header) < at('COMPUTED NUMBERS'));
    assert.match(prompt, /- Total comps: 130\. Counted in the range: 111\. NOT COUNTED: 19\./);
    assert.match(prompt, /- NOT COUNTED by reason: property type differs from the subject's 19\./);
    assert.match(prompt, /- Counted comps by property type: unknown 111\./);
  });

  await check('buildPrompt() rule: counts and makeup statements use ONLY the facts block, no vague quantifiers for a provided number; earlier count rule and all older rules kept', () => {
    const prompt = buildPrompt(narrativePromptFixture);
    assert.match(prompt, /use ONLY the figures in the COMPUTED COMP FACTS block below\./);
    assert.match(prompt, /never replace it with a vague quantifier such as "handful", "couple", "few", "several", or "vast majority"; say the number\./);
    assert.match(prompt, /If a count you would like to state is not in that block, leave it out\./);
    assert.match(prompt, /Any count of comps you state \(counted, NOT COUNTED, Rincon-managed, per reason, and so on\) must be exactly right/);
    assert.match(prompt, /NEVER cite a NOT COUNTED comp as a reason, a floor, a ceiling, support, or justification/);
    assert.match(prompt, /Respond with ONLY the one line below/);
    assert.ok(prompt.indexOf('use ONLY the figures in the COMPUTED COMP FACTS') < prompt.indexOf('SUBJECT PROPERTY:'), 'the rule sits in HARD RULES');
  });

  await check('generateNarrative() sends the facts block to Claude in the real request, with counts matching the comps it was given', async () => {
    const mock = mockClaude([textReply(answerFor(pickNarratedIndexes(factsMix)))]);
    await generateNarrative({ ...narrativePromptFixture, comps: factsMix }, { client: mock.client });
    assert.match(mock.calls[0].messages[0].content, /- Total comps: 15\. Counted in the range: 7\. NOT COUNTED: 8\./);
  });

  // ── Status guard: a narrative may never call a non-leased comp leased. ──
  const GLITCH = 'Leased... off-market 2bd/2.5ba townhouse 0.85 mi away at $4,000 after just 1 day on market; a townhouse match but a bedroom short, and only off-market so weighted lightly.';
  const guardComps = [
    { address: '1564 E Thompson Blvd, Ventura, CA 93001', bedrooms: 2, listing_status: 'off_market', property_type: 'townhouse', exclusion_reason: null },
    { address: '1121 Pittsfield Ln, Ventura, CA 93001', bedrooms: 3, listing_status: 'off_market', property_type: 'townhouse', exclusion_reason: null },
    { address: '404 Arcade Drive, Ventura, CA 93003', bedrooms: 2, listing_status: 'leased', property_type: 'townhouse', exclusion_reason: null },
    { address: '436 S Seaward Avenue, Ventura, CA 93003', bedrooms: 3, listing_status: 'active', exclusion_reason: null },
  ];
  const guardInput = { ...narrativePromptFixture, comps: guardComps };

  await check('guardLeasedClaims() nulls the exact glitch seen live (off_market narrative opening "Leased... off-market 2bd/2.5ba townhouse...") and warns once with index + address', async () => {
    await withCapturedWarnings(async warnings => {
      const out = guardLeasedClaims(guardComps, [GLITCH, null, null, null]);
      assert.deepEqual(out, [null, null, null, null]);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /comp 0 \(1564 E Thompson Blvd, Ventura, CA 93001\).*"off_market"/);
    });
  });

  await check('guardLeasedClaims() nulls every phrasing of a lease claim on a non-leased comp (active or off_market): leased at/for/in, was/recently/just leased, rented at/for, confirmed lease, opening "Leased"', async () => {
    const claims = [
      'Active 3bd listing that leased at $3,500 in 20 days.',
      'Off-market comp that was leased for $4,000.',
      'Recently leased at $3,900.',
      'Just leased, 3bd near the subject.',
      'Rented at $3,200 last month.',
      'Rented for $3,200 on a 12-month term.',
      'Confirmed lease at $4,000 in 11 days.',
      'Leased 3bd/2ba, 0.4 mi away.',
    ];
    await withCapturedWarnings(async warnings => {
      const comps = claims.map((_, i) => ({ address: `${i} Test St`, listing_status: i % 2 ? 'off_market' : 'active' }));
      const out = guardLeasedClaims(comps, claims);
      assert.ok(out.every(n => n === null), `still shown: ${claims.filter((_, i) => out[i] !== null).join(' || ')}`);
      assert.equal(warnings.length, claims.length, 'one warning per dropped narrative');
    });
  });

  await check('guardLeasedClaims() KEEPS narratives that correctly say the comp is NOT confirmed leased (never confirmed, unclear whether, cannot confirm, not leased yet, no confirmed lease, may have, unconfirmed whether)', async () => {
    const fine = [
      'Off-market after 239 days, never confirmed leased, so the price is unconfirmed.',
      'Delisted after 1 day; it is unclear whether it was leased or simply expired.',
      'Off-market at $4,100; we cannot confirm it leased at that price.',
      "Off-market at $4,100; we can't confirm it leased at that price.",
      'Active asking price, not leased yet.',
      'Off-market, no confirmed lease.',
      'Off-market 3bd at $4,000 with no price cut; unconfirmed whether it leased.',
      'Delisted townhouse; may have been leased or simply expired.',
      'Leased status unconfirmed: it was delisted after 1 day.',
    ];
    await withCapturedWarnings(async warnings => {
      const comps = fine.map((_, i) => ({ address: `${i} Test St`, listing_status: i % 2 ? 'off_market' : 'active' }));
      const out = guardLeasedClaims(comps, fine);
      assert.deepEqual(out, fine, `wrongly dropped: ${fine.filter((_, i) => out[i] === null).join(' || ')}`);
      assert.equal(warnings.length, 0);
    });
  });

  await check('guardLeasedClaims() KEEPS a non-leased comp narrative that merely mentions OTHER leased comps (nearby leased comps, "COMP 71, which leased at $4,085", "Leased comps nearby run higher")', async () => {
    const fine = [
      'Active at $3,495; nearby leased comps are lower.',
      'Asking $4,850, well above COMP 71, which leased at $4,085.',
      'Leased comps nearby run higher, so this ask looks aggressive.',
    ];
    await withCapturedWarnings(async warnings => {
      const out = guardLeasedClaims(fine.map((_, i) => ({ address: `${i} Test St`, listing_status: 'active' })), fine);
      assert.deepEqual(out, fine);
      assert.equal(warnings.length, 0);
    });
  });

  await check('guardLeasedClaims() never touches a LEASED comp (it may say "Leased at ..."), and leaves null narratives null', async () => {
    await withCapturedWarnings(async warnings => {
      const out = guardLeasedClaims([{ address: 'a', listing_status: 'leased' }, { address: 'b', listing_status: 'active' }], ['Leased at $3,475 in 11 days.', null]);
      assert.deepEqual(out, ['Leased at $3,475 in 11 days.', null]);
      assert.equal(warnings.length, 0);
    });
  });

  await check('generateNarrative() NORMAL path: the off_market "Leased..." glitch and an active "Recently leased" are dropped; the hedged off_market, the leased comp, and meta.narrativesWritten stay correct', async () => {
    const reply = `RENTAL_ANALYSIS_OUTPUT: ${JSON.stringify({ rationale: 'R.', comp_narratives: {
      0: GLITCH,
      1: 'Off-market after 239 days, never confirmed leased, so the price is unconfirmed.',
      2: 'Leased at $3,475 in 11 days, a confirmed lease.',
      3: 'Recently leased at $3,900.',
    } })}`;
    const mock = mockClaude([textReply(reply)]);
    const result = await withCapturedWarnings(async warnings => {
      const r = await generateNarrative(guardInput, { client: mock.client });
      const dropped = warnings.filter(w => /Dropped the narrative/.test(w));
      assert.equal(dropped.length, 2);
      assert.match(dropped[0], /comp 0 \(1564 E Thompson Blvd/);
      assert.match(dropped[1], /comp 3 \(436 S Seaward Avenue/);
      return r;
    });
    assert.equal(result.narrativesByIndex[0], null);
    assert.equal(result.narrativesByIndex[1], 'Off-market after 239 days, never confirmed leased, so the price is unconfirmed.');
    assert.equal(result.narrativesByIndex[2], 'Leased at $3,475 in 11 days, a confirmed lease.');
    assert.equal(result.narrativesByIndex[3], null);
    assert.equal(result.meta.narrativesWritten, 2);
    assert.equal(result.rationale, 'R.');
  });

  await check('generateNarrative() SALVAGE path (max_tokens cut-off): the guard applies there too; kept narratives survive, the half-written one is still dropped', async () => {
    const cut = `RENTAL_ANALYSIS_OUTPUT: {"rationale": "R.", "comp_narratives": {"0": ${JSON.stringify(GLITCH)}, "1": "Off-market after 239 days, never confirmed leased.", "2": "Leased at $3,475 in 11 days.", "3": "Rented at $3,900 in 5 days.", "4": "cut o`;
    const mock = mockClaude([textReply(cut, 'max_tokens', 16000)]);
    const result = await withCapturedWarnings(async warnings => {
      const r = await generateNarrative({ ...guardInput, comps: [...guardComps, { address: '9 Extra St', listing_status: 'active', exclusion_reason: null }] }, { client: mock.client });
      assert.equal(warnings.filter(w => /Dropped the narrative/.test(w)).length, 2);
      return r;
    });
    assert.equal(result.narrativesByIndex[0], null, 'glitch dropped on the salvage path');
    assert.equal(result.narrativesByIndex[1], 'Off-market after 239 days, never confirmed leased.');
    assert.equal(result.narrativesByIndex[2], 'Leased at $3,475 in 11 days.');
    assert.equal(result.narrativesByIndex[3], null, 'active comp "Rented at" dropped on the salvage path');
    assert.equal(result.narrativesByIndex[4], null, 'the half-written narrative is still dropped');
    assert.equal(result.meta.truncated, true);
  });

  await check('a comp whose narrative the guard nulled still renders: the dashboard prints the narrative div only when c.narrative is truthy (same already-verified path as other null narratives)', () => {
    for (const file of ['dashboard/index.html', '../hub/rental-analysis/dashboard/index.html']) {
      const fs = require('fs');
      if (!fs.existsSync(require('path').join(__dirname, file))) continue;
      assert.match(fs.readFileSync(require('path').join(__dirname, file), 'utf8'), /\(c\.narrative \? '<div class="comp-narrative">'/, `${file}: narrative is conditional`);
    }
  });

  await check('generateNarrative() still throws clearly on a normal (end_turn) response with no marker line, exactly as before', async () => {
    const mock = mockClaude([textReply('I could not do that.')]);
    await assert.rejects(() => generateNarrative(bigInput, { client: mock.client }), /did not end with the expected/);
    assert.equal(mock.calls.length, 1, 'only a max_tokens cut-off is retried');
  });

  // ── Rationale gate: no numeric COMP label, no dollar figure that is not in the data. ──
  console.log('--- lib/narrative.js rationale gate (numeric COMP labels, invented dollar figures) ---');

  const gateInput = {
    subject: { address: '1 Test St, Ventura, CA 93001', bedrooms: 3, bathrooms: 2, sqft: 1500, propertyType: 'townhouse', yearBuilt: 2000, leaseTermMonths: 12, furnished: false },
    comps: [
      { address: '101 Alpha St, Ventura, CA 93003', bedrooms: 3, bathrooms: 2, sqft: 1450, property_type: 'townhouse', monthly_rent: 3495, listing_status: 'leased', distance_miles: 0.2, exclusion_reason: null },
      { address: '102 Beta St, Ventura, CA 93003', bedrooms: 3, bathrooms: 2, sqft: 1480, property_type: 'townhouse', monthly_rent: 3795, listing_status: 'active', distance_miles: 0.4, exclusion_reason: null },
      { address: '103 Gamma St, Ventura, CA 93003', bedrooms: 3, bathrooms: 2, sqft: 1500, property_type: 'townhouse', monthly_rent: 3700, listing_status: 'leased', distance_miles: 0.6, exclusion_reason: null },
      { address: '104 Delta St, Ventura, CA 93003', bedrooms: 3, bathrooms: 2, sqft: 1500, property_type: 'townhouse', monthly_rent: 4085, listing_status: 'leased', distance_miles: 0.7, had_price_cut: true, original_price: 4200, exclusion_reason: null },
      { address: '105 Echo St, Ventura, CA 93003', bedrooms: 3, bathrooms: 2, sqft: 1500, property_type: 'townhouse', monthly_rent: 3295, listing_status: 'off_market', distance_miles: 0.9, exclusion_reason: null },
      { address: '106 Far St, Ventura, CA 93003', bedrooms: 5, bathrooms: 3, sqft: 2500, property_type: 'townhouse', monthly_rent: 5600, listing_status: 'active', distance_miles: 1.1, exclusion_reason: 'size_mismatch' },
    ],
    recommended: { low: 3495, mid: 3750, high: 4000 },
    raw: { low: 3295, high: 4085 },
    subjectEstimatedRent: 3850,
    sourcesUsed: ['RentCast', 'CRMLS'],
  };
  const GOOD = '103 Gamma St leased at $3,700 and 104 Delta St leased at $4,085 (it was first asked at $4200), so leases sit between the $3,495 low and the $4,000 high of the recommended range, with a $3,750 midpoint. 105 Echo St is off-market at $3295, and 102 Beta St asks $3,795, $500 above it, while RentCast estimates $3,850. The raw range is $3,295-$4,085, so a $150 spread either way is normal, and 3 of 5 comps are leased or asked within 5% of the midpoint.';
  const rationaleOnly = rationale => `RENTAL_ANALYSIS_OUTPUT: ${JSON.stringify({ rationale, comp_narratives: {} })}`;
  const gateReply = (rationale, narratives = { 0: 'Alpha narrative.', 1: 'Beta narrative.', 2: 'Gamma narrative.', 3: 'Delta narrative.', 4: 'Echo narrative.' }) =>
    textReply(`RENTAL_ANALYSIS_OUTPUT: ${JSON.stringify({ rationale, comp_narratives: narratives })}`);

  await check('validateRationale() accepts a clean rationale: every figure from the data in any format ($3,495 / $3495 / $4200 / a raw-range dash), a "$500 above" difference, a "$150" aside, and percent / plain counts', () => {
    const r = validateRationale(GOOD, gateInput);
    assert.deepEqual(r, { ok: true, problems: [], labels: [], badFigures: [], badAddresses: [], badClaims: [] });
  });

  await check('extractDollarFigures() normalizes $3,495 / $3495 / $3,495.00 / $3.5k to one value, reads the second end of "$3,495-4,500", ignores percents and bare numbers', () => {
    assert.deepEqual(extractDollarFigures('$3,495, $3495 and $3,495.00').map(f => f.value), [3495]);
    assert.deepEqual(extractDollarFigures('about $3.5k or $4K').map(f => f.value), [3500, 4000]);
    assert.deepEqual(extractDollarFigures('$3,495-4,500 and $3,000 to $3,400 and $4,000-4 bedrooms').map(f => f.value), [3495, 4500, 3000, 3400, 4000]);
    assert.deepEqual(extractDollarFigures('up 5%, 12 days, 4bd, 1,500 sqft, 3,495 without a sign'), []);
  });

  await check('validateRationale() flags a numeric COMP label in every spelling ("COMP 63", "Comp 7", "comp #12", "comp no. 5", "comp number 9", "comps 12 and 14", "comps 3, 4") but not "a comp 0.4 miles away", "a comp 2 bedrooms off", "3 comps", or a comma-separated "comp, 12 days"', () => {
    for (const text of ['anchored by COMP 63 at the low end', 'Comp 7 leased', 'see comp #12', 'comp no. 5 is close', 'comp number 9 is close', 'comps 12 and 14 agree', 'comps 3, 4 are leased', 'the comp63 line']) {
      const r = validateRationale(text, gateInput);
      assert.equal(r.ok, false, `should flag: ${text}`);
      assert.ok(r.labels.length >= 1, `labels for: ${text}`);
    }
    for (const text of ['a comp 0.4 miles away leased', 'a comp 2 bedrooms off the subject', 'a comp 12 days on market', '3 comps leased', 'comps within 2 miles', 'the comp, 12 days on market, leased', 'Compton 93001 is nearby', 'comp 4bd/2ba']) {
      assert.equal(validateRationale(text, gateInput).ok, true, `should NOT flag: ${text}`);
    }
    assert.deepEqual(findCompLabels('COMP 63 and COMP 63 and comp #7'), ['COMP 63', 'comp #7']);
  });

  await check('validateRationale() flags an invented rent or range (a figure not in the data and not a difference of two data figures) and names it: $4,250 rent, an invented $3,900-$4,150 range, a $4.3k, a model-computed average', () => {
    const r = validateRationale('The home should rent at $4,250, inside a $3,900-$4,150 band of about $4.3k, with a $3,816 average.', gateInput);
    assert.equal(r.ok, false);
    assert.deepEqual(r.badFigures, ['$4,250', '$3,900', '$4,150', '$4.3k', '$3,816']);
    assert.equal(r.labels.length, 0);
    assert.match(r.problems[0], /dollar figure that is not in the data you were given \(\$4,250, \$3,900, \$4,150, \$4\.3k, \$3,816\)/);
    assert.equal(validateRationale('A range of $3,495-4,500 fits.', gateInput).ok, false, 'the unmarked second end of a range is read: 4,500 is not in the data');
    assert.equal(validateRationale('A range of $3,495-4,085 fits.', gateInput).ok, true, '4,085 is a real comp rent');
  });

  await check('validateRationale() is not punishing arithmetic: a difference of two data figures ($500 = 3,795-3,295; $1,100 = 4,085-3,295... ) and any amount under half the lowest rent pass; a rent-scale number that is neither a data figure nor a difference does not', () => {
    assert.equal(validateRationale('102 Beta St asks $500 above 105 Echo St.', gateInput).ok, true, '$500 = 3795 - 3295');
    assert.equal(validateRationale('104 Delta St is $790 above 105 Echo St.', gateInput).ok, true, '$790 = 4085 - 3295 (a difference, not a rent)');
    assert.equal(validateRationale('A $75 or $250 or $1,000 premium is typical.', gateInput).ok, true, 'amounts under half the lowest provided rent are arithmetic, never a rent');
    assert.equal(validateRationale('The midpoint is $3,810.', gateInput).ok, false, '3,810 is not a data figure and not a difference');
    assert.equal(validateRationale('Rent them at $2,000 a month.', gateInput).ok, false, '2,000 is above half the lowest rent (1,647) and is not a data figure');
  });

  await check('validateRationale() allows only figures the model was shown: an original price counts only when the comp line shows it (had_price_cut), and a figure from the NOT COUNTED comp lines is still a shown figure', () => {
    assert.equal(validateRationale('104 Delta St was first asked at $4,200.', gateInput).ok, true);
    const hidden = { ...gateInput, comps: gateInput.comps.map(c => (c.address.startsWith('104') ? { ...c, had_price_cut: false } : c)) };
    assert.equal(validateRationale('104 Delta St was first asked at $4,200.', hidden).ok, false, 'original_price is not in the prompt without a price cut, so it is not an allowed figure');
    assert.equal(validateRationale('106 Far St asks $5,600 but is not counted.', gateInput).ok, true, 'it is on a comp line the model saw');
  });

  await check('buildPrompt() carries the new rules: refer to a comp only by street address (never COMP n), the within-about-$150 rule for low/high anchoring, the "around the top/bottom/middle" rule with the side-by-side instruction, and the figures-only-from-the-data rule', () => {
    const prompt = buildPrompt(gateInput);
    const rules = prompt.slice(prompt.indexOf('HARD RULES:'), prompt.indexOf('SUBJECT PROPERTY:'));
    assert.match(rules, /Refer to every comp ONLY by its street address, in the rationale AND in every per-comp narrative\./);
    assert.match(rules, /never write "COMP 12", "Comp 12", "comp #12", or any other numeric label for a comp anywhere in your output text/);
    assert.match(rules, /The "COMP 12" labels at the start of the comp lines exist only so you can key the JSON comp_narratives/);
    assert.match(rules, /Describe a comp as setting, anchoring, supporting, or bracketing the LOW or HIGH end of the recommended range ONLY if that comp's own rent is within about \$150 of that end's figure/);
    assert.match(rules, /"around", "near", or "at" the top, bottom, or middle of the range ONLY if its rent is actually near that point/);
    assert.match(rules, /When you are not sure, do not characterize: state the comp's rent and the range figure side by side and let the reader compare\./);
    assert.match(rules, /Do not average, round, or invent a rent or a range figure\. A plain difference between two of those figures \(such as "\$500 below the midpoint"\) is fine\./);
    assert.match(prompt, /referencing specific comps by street address only \(never by a COMP number\)/);
    assert.doesNotMatch(prompt, /by address or number/);
    assert.match(prompt, /Refer to the comp by its street address, never by its number \(the number only keys the JSON\)\./);
    assert.match(buildPrompt({ ...gateInput, comps: gateInput.comps.map(c => ({ ...c, exclusion_reason: 'size_mismatch' })) }), /street address only/, 'also on the no-narratives prompt');
    assert.ok(prompt.indexOf('COMP 0: 101 Alpha St') > -1, 'the numeric keys stay in the comp lines (they key comp_narratives)');
    assert.doesNotMatch(prompt, /CORRECTION REQUIRED/, 'a first request carries no correction');
  });

  await check('generateNarrative() clean rationale with a "$500 below"-style difference: accepted on the first response, exactly ONE call, narratives kept', async () => {
    const mock = mockClaude([gateReply(GOOD)]);
    const result = await generateNarrative(gateInput, { client: mock.client });
    assert.equal(mock.calls.length, 1);
    assert.equal(result.rationale, GOOD);
    assert.equal(result.narrativesByIndex[2], 'Gamma narrative.');
    assert.equal(result.meta.rationaleRetried, false);
    assert.equal(result.meta.anthropicCalls, 1);
  });

  await check('generateNarrative() rationale citing "COMP 63" is rejected, ONE retry names the violation (rationale only, rejected text quoted), the clean retry is accepted, narratives from the first response are kept', async () => {
    const bad = 'The lower bound is anchored by active townhouse asks like COMP 63 ($3,795), with leases at 103 Gamma St.';
    const mock = mockClaude([gateReply(bad), textReply(rationaleOnly(GOOD))]);
    const result = await withCapturedWarnings(warnings => generateNarrative(gateInput, { client: mock.client })
      .then(r => { assert.ok(warnings.some(w => /Rationale rejected/.test(w) && /COMP 63/.test(w))); return r; }));
    assert.equal(mock.calls.length, 2, 'one call, one retry, never a loop');
    const retryPrompt = mock.calls[1].messages[0].content;
    assert.match(retryPrompt, /CORRECTION REQUIRED/);
    assert.match(retryPrompt, /it used a numeric COMP label \("COMP 63"\)/);
    assert.match(retryPrompt, /refer to every comp by its street address only/);
    assert.ok(retryPrompt.includes(JSON.stringify(bad)), 'the rejected rationale is quoted back');
    assert.match(retryPrompt, /No per-comp narratives/, 'the retry asks for the rationale alone');
    assert.doesNotMatch(mock.calls[0].messages[0].content, /CORRECTION REQUIRED/);
    assert.equal(result.rationale, GOOD);
    assert.deepEqual(result.narrativesByIndex.slice(0, 5), ['Alpha narrative.', 'Beta narrative.', 'Gamma narrative.', 'Delta narrative.', 'Echo narrative.']);
    assert.equal(result.narrativesByIndex[5], null, 'the NOT COUNTED comp has no narrative, as always');
    assert.equal(result.meta.rationaleRetried, true);
    assert.equal(result.meta.rationaleDropped, false);
    assert.equal(result.meta.anthropicCalls, 2);
    assert.match(result.meta.rationaleProblems[0], /COMP 63/);
  });

  await check('generateNarrative() rationale with an invented dollar figure is rejected, the retry names that exact figure, and a clean retry is accepted', async () => {
    const mock = mockClaude([gateReply('The range of $3,900-$4,150 is anchored by 103 Gamma St.'), textReply(rationaleOnly(GOOD))]);
    const result = await withCapturedWarnings(() => generateNarrative(gateInput, { client: mock.client }));
    assert.equal(mock.calls.length, 2);
    assert.match(mock.calls[1].messages[0].content, /dollar figure that is not in the data you were given \(\$3,900, \$4,150\)/);
    assert.equal(result.rationale, GOOD);
  });

  await check('generateNarrative() two rejected rationales in a row: rationale is null, the per-comp narratives are kept, nothing throws, still only 2 calls; an invented figure quoted in the retry prompt is NOT treated as allowed', async () => {
    const bad = 'Rent should be $4,250 per 103 Gamma St.';
    const mock = mockClaude([gateReply(bad), textReply(rationaleOnly(bad))]);
    const result = await withCapturedWarnings(warnings => generateNarrative(gateInput, { client: mock.client })
      .then(r => { assert.ok(warnings.some(w => /rejected too/.test(w) && /no rationale/.test(w))); return r; }));
    assert.equal(mock.calls.length, 2);
    assert.match(mock.calls[1].messages[0].content, /\$4,250/, 'the figure is quoted in the correction text');
    assert.equal(result.rationale, null);
    assert.equal(result.narrativesByIndex[0], 'Alpha narrative.');
    assert.equal(result.narrativesByIndex.filter(Boolean).length, 5);
    assert.equal(result.meta.rationaleDropped, true);
    assert.equal(result.meta.narrativesWritten, 5);
    assert.equal(result.meta.anthropicCalls, 2);
    const twoLabels = mockClaude([gateReply('COMP 3 and COMP 4 lead.'), textReply(rationaleOnly('Still COMP 3.'))]);
    assert.equal((await withCapturedWarnings(() => generateNarrative(gateInput, { client: twoLabels.client }))).rationale, null);
  });

  await check('generateNarrative() when the rationale retry itself fails (API error, no marker line, cut off by max_tokens): rationale null, narratives kept, no throw', async () => {
    const bad = gateReply('Anchored by COMP 63.');
    const failures = {
      'API error': () => { throw new Error('529 overloaded'); },
      'no marker line': textReply('Sorry, I cannot do that.'),
      'cut off before a rationale': textReply('RENTAL_ANALYSIS_OUTPUT: {"rationale": "Leases at 103 Gam', 'max_tokens', 16000),
    };
    for (const [label, retryReply] of Object.entries(failures)) {
      const mock = mockClaude([bad, retryReply]);
      const result = await withCapturedWarnings(() => generateNarrative(gateInput, { client: mock.client }));
      assert.equal(result.rationale, null, label);
      assert.equal(result.narrativesByIndex[1], 'Beta narrative.', label);
      assert.equal(mock.calls.length, 2, label);
    }
  });

  await check('generateNarrative() max_tokens salvage still works: a cut-off response with a CLEAN complete rationale is kept as before (one call, no retry)', async () => {
    const cutOff = `RENTAL_ANALYSIS_OUTPUT: {"rationale": ${JSON.stringify(GOOD)}, "comp_narratives": {"0": "Alpha narrative.", "1": "Beta done.", "2": "Gamma was cut o`;
    const mock = mockClaude([textReply(cutOff, 'max_tokens', 16000)]);
    const result = await withCapturedWarnings(() => generateNarrative(gateInput, { client: mock.client }));
    assert.equal(mock.calls.length, 1);
    assert.equal(result.rationale, GOOD);
    assert.equal(result.narrativesByIndex[1], 'Beta done.');
    assert.equal(result.narrativesByIndex[2], null);
    assert.equal(result.meta.truncated, true);
    assert.equal(result.meta.rationaleRetried, false);
  });

  await check('generateNarrative() max_tokens salvage + gate: a salvaged cut-off rationale that cites COMP 63 is rejected, ONE rationale retry fixes it, the salvaged narratives survive', async () => {
    const cutOff = 'RENTAL_ANALYSIS_OUTPUT: {"rationale": "Anchored by COMP 63 at $3,795.", "comp_narratives": {"0": "Alpha done.", "1": "Beta done.", "2": "Gamma was cut o';
    const mock = mockClaude([textReply(cutOff, 'max_tokens', 16000), textReply(rationaleOnly(GOOD))]);
    const result = await withCapturedWarnings(() => generateNarrative(gateInput, { client: mock.client }));
    assert.equal(mock.calls.length, 2);
    assert.equal(result.rationale, GOOD);
    assert.deepEqual(result.narrativesByIndex.slice(0, 3), ['Alpha done.', 'Beta done.', null]);
    assert.equal(result.meta.truncated, true);
    assert.equal(result.meta.rationaleRetried, true);
  });

  await check('generateNarrative() the two retries are independent and bounded: cut off before a rationale (call 2, rationale alone), that rationale is rejected (call 3, corrected) = 3 calls at most, never a 4th', async () => {
    const cut = textReply('RENTAL_ANALYSIS_OUTPUT: {"rationale": "The nearby leased comps anchor the ra', 'max_tokens', 16000);
    const worst = mockClaude([cut, textReply(rationaleOnly('Anchored by COMP 63.')), textReply(rationaleOnly('Anchored by COMP 63 again.')), textReply(rationaleOnly(GOOD))]);
    const r1 = await withCapturedWarnings(() => generateNarrative(gateInput, { client: worst.client }));
    assert.equal(worst.calls.length, 3, 'max_tokens retry + one rationale retry; the 4th reply is never requested');
    assert.equal(r1.rationale, null);
    assert.equal(r1.meta.retried, true);
    assert.equal(r1.meta.anthropicCalls, 3);
    assert.ok(r1.narrativesByIndex.every(n => n === null), 'the max_tokens retry asked for no narratives, so there are none');

    const recovers = mockClaude([cut, textReply(rationaleOnly('Anchored by COMP 63.')), textReply(rationaleOnly(GOOD))]);
    const r2 = await withCapturedWarnings(() => generateNarrative(gateInput, { client: recovers.client }));
    assert.equal(recovers.calls.length, 3);
    assert.equal(r2.rationale, GOOD);
  });

  await check('the generateNarrative() 130-comp / existing mock replies (no dollar figures, no labels) are untouched by the gate: one call, as before', async () => {
    const mock = mockClaude([req => textReply(answerFor(askedIndexes(req)))]);
    const result = await generateNarrative(bigInput, { client: mock.client });
    assert.equal(mock.calls.length, 1);
    assert.equal(result.meta.rationaleRetried, false);
  });

  await check('both dashboards render nothing for a null rationale: the "Why ..." section is built only inside (analysis.rationale ? ... : \'\'), so no "null"/"undefined" text and the comp cards\' narratives are unaffected', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    for (const file of [path.join(__dirname, 'dashboard', 'index.html'), path.join(__dirname, '..', 'hub', 'rental-analysis', 'dashboard', 'index.html')]) {
      const html = fs.readFileSync(file, 'utf8');
      const uses = html.match(/analysis\.rationale/g) || [];
      assert.equal(uses.length, 2, `${file}: the only uses of analysis.rationale are the guard and the escaped print`);
      assert.match(html, /\(analysis\.rationale \?\s*'<div class="section-heading">Why '[\s\S]*?esc\(analysis\.rationale\)[\s\S]*?: ''\)/, `${file}: heading and box are both inside the truthy branch`);
    }
  });

  // ── Address check + off-market days wording + narrative label guard ──
  console.log('--- lib/narrative.js address check, off-market days wording, narrative label guard ---');

  // Real Haley Point comps (addresses, rents and statuses copied from a saved analysis) and two REAL live rationales.
  const haleyInput = {
    subject: { address: '2472 Haley Point Drive, Ventura, CA, USA', bedrooms: 3, bathrooms: 2.5, sqft: 1424, propertyType: 'townhouse', yearBuilt: 2025, leaseTermMonths: 12, furnished: false },
    comps: [
      { address: "2378 Channel Dr, Unit 103, Ventura, CA 93003", property_type: "townhouse", bedrooms: 3, monthly_rent: 4100, listing_status: "off_market", original_price: null, had_price_cut: false, days_on_market: 1, exclusion_reason: null },
      { address: "1121 Pittsfield Ln, Ventura, CA 93001", property_type: "townhouse", bedrooms: 3, monthly_rent: 4850, listing_status: "off_market", original_price: null, had_price_cut: false, days_on_market: 239, exclusion_reason: null },
      { address: "436 S Seaward Avenue, Ventura, CA 93003", property_type: null, bedrooms: 3, monthly_rent: 3495, listing_status: "active", original_price: 3495, had_price_cut: false, days_on_market: 0, exclusion_reason: null },
      { address: "1078 S Seaward Avenue, Ventura, CA 93001", property_type: null, bedrooms: 1, monthly_rent: 2800, listing_status: "leased", original_price: 2800, had_price_cut: false, days_on_market: 29, exclusion_reason: null },
      { address: "514 S Seaward Ave, Ventura, CA 93003", property_type: "single_family", bedrooms: 2, monthly_rent: 2950, listing_status: "off_market", original_price: null, had_price_cut: false, days_on_market: 1, exclusion_reason: null },
      { address: "5383 Paseo Ricoso, Camarillo, CA 93012", property_type: null, bedrooms: 3, monthly_rent: 4000, listing_status: "leased", original_price: 4200, had_price_cut: true, days_on_market: 22, exclusion_reason: null },
      { address: "102 Hoover Ave., Ventura, CA 93003", property_type: null, bedrooms: 3, monthly_rent: 3700, listing_status: "leased", original_price: null, had_price_cut: false, days_on_market: null, exclusion_reason: null },
      { address: "3677 Willowick Dr, Ventura, CA 93003", property_type: null, bedrooms: 3, monthly_rent: 4085, listing_status: "leased", original_price: null, had_price_cut: false, days_on_market: null, exclusion_reason: null },
      { address: "2585/2587 Warbler Ave., Ventura, CA 93003", property_type: null, bedrooms: 2, monthly_rent: 3540, listing_status: "leased", original_price: null, had_price_cut: false, days_on_market: null, exclusion_reason: null },
      { address: "404 Arcade Drive, Ventura, CA 93003", property_type: "townhouse", bedrooms: 2, monthly_rent: 3475, listing_status: "leased", original_price: 3475, had_price_cut: false, days_on_market: 11, exclusion_reason: null },
      { address: "1085 Mchugh Court, Ventura, CA 93003", property_type: "townhouse", bedrooms: 3, monthly_rent: 3795, listing_status: "active", original_price: 3795, had_price_cut: false, days_on_market: 0, exclusion_reason: null },
      { address: "935 Goodman Avenue, Ventura, CA 93003", property_type: "townhouse", bedrooms: 2, monthly_rent: 3600, listing_status: "active", original_price: 3600, had_price_cut: false, days_on_market: 0, exclusion_reason: null },
      { address: "4577 Calle Argolla, Camarillo, CA 93012", property_type: "townhouse", bedrooms: 3, monthly_rent: 3850, listing_status: "active", original_price: 3850, had_price_cut: false, days_on_market: 0, exclusion_reason: null },
      { address: "2437 E Main St, Ventura, CA 93003", property_type: "townhouse", bedrooms: 2, monthly_rent: 2200, listing_status: "off_market", original_price: null, had_price_cut: false, days_on_market: 1, exclusion_reason: null },
      { address: "102 N Kalorama Street, Unit 1, Ventura, CA 93001", property_type: null, bedrooms: 2, monthly_rent: 2950, listing_status: "leased", original_price: 3100, had_price_cut: true, days_on_market: 14, exclusion_reason: null },
      { address: "1568 E Thompson Boulevard, Ventura, CA 93001", property_type: "townhouse", bedrooms: 4, monthly_rent: 4695, listing_status: "active", original_price: 4695, had_price_cut: false, days_on_market: 3, exclusion_reason: null },
      { address: "3495 Somis Road, Somis, CA 93066", property_type: null, bedrooms: 3, monthly_rent: 4300, listing_status: "active", original_price: 4500, had_price_cut: true, days_on_market: 46, exclusion_reason: null },
    ],
    recommended: { low: 3495, mid: 3750, high: 4000 },
    raw: { low: 2200, high: 4850 },
    subjectEstimatedRent: 4110,
    sourcesUsed: ['RentCast', 'CRMLS', 'LeadSimple Move-Ins'],
  };
  const LIVE_RUN1 = "The recommended range of $3,495-$4,000 (midpoint $3,750) rests on the 21 comps that actually counted — 9 townhouses and 12 unknown-type — while 80 comps were excluded: 72 for a property type that differs from the subject's townhouse, 5 for a bedroom count 2+ off, and 3 as Rincon-managed internal references. The strongest evidence comes from the 8 leased comps: 102 Hoover Ave. leased at $3,700 and 3677 Willowick Dr at $4,085 are both confirmed Rincon transactions, and 5383 Paseo Ricoso leased at $4,000 after a cut from $4,200, which supports the top of the range; 2585/2587 Warbler Ave. leased at $3,540 and 404 Arcade Drive leased at $3,475 in just 11 days help anchor the low end. The high end is held down because the two highest counted asking prices — 1121 Pittsfield Ln at $4,850, which has sat off-market 239 days, and 2378 Channel Dr, Unit 103 at $4,100, off-market after 1 day — are unconfirmed delistings that carry less weight than the leases, and the raw range top of $4,850 comes from that long-sitting Pittsfield listing. Current active townhouse asking prices like 435 S Seaward Avenue at $3,495, 935 Goodman Avenue at $3,600, and 1085 Mchugh Court at $3,795 cluster below $4,000 and reinforce the midpoint. Note the subject's own RentCast estimate of $4,110 sits above this comp-based range, and that 436 S Seaward Avenue, 1085 Mchugh Court and others are active asking prices not yet confirmed by a transaction, so treat the top of the range as achievable but not guaranteed.";
  const LIVE_RUN2 = "The subject is a 3bd/2.5ba, 1424 sqft townhouse, and of the 101 comps pulled from RentCast, CRMLS, and LeadSimple Move-Ins, only 21 counted toward the range; 80 were excluded (72 for a property type that differs from the subject's, 5 for a bedroom count 2+ off, and 3 as Rincon-managed internal references). The raw rent spread across the counted comps runs $2,200-$4,850, but that is pulled wide on the low end by small 2-bedroom units like 2437 E Main St at $2,200 and on the high end by 1121 Pittsfield Ln, which sat off-market at $4,850 for 239 days with no confirmed lease. The recommended range of $3,495-$4,000 (midpoint $3,750) leans on the confirmed leases, which carry the most weight: 5383 Paseo Ricoso actually leased at $4,000 after a cut from $4,200, 102 Hoover Ave. leased at $3,700, 3677 Willowick Dr leased at $4,085, and 2585/2587 Warbler Ave. leased at $3,540, with 404 Arcade Drive leasing at $3,475 in just 11 days. Current asking prices support the same band — 4577 Calle Argolla is active at $3,850, 1085 Mchugh Court at $3,795, 935 Goodman Avenue at $3,600, and 436 S Seaward Avenue at $3,495. Note that the counted comps are a mix of 9 townhouses and 12 unknown-type properties, and none is a confirmed-leased 3bd townhouse, so this should be read as a reasonable estimate rather than a tightly confirmed one.";

  await check('findBadAddresses(): the real live Run 2 rationale and Run 1 (with its one wrong house number repaired) have NO flagged addresses, and validateRationale() accepts both in full', () => {
    assert.deepEqual(findBadAddresses(LIVE_RUN2, haleyInput), []);
    const run1Fixed = LIVE_RUN1.replace('435 S Seaward Avenue', '436 S Seaward Avenue');
    assert.notEqual(run1Fixed, LIVE_RUN1);
    assert.deepEqual(findBadAddresses(run1Fixed, haleyInput), []);
    for (const text of [LIVE_RUN2, run1Fixed]) assert.deepEqual(validateRationale(text, haleyInput), { ok: true, problems: [], labels: [], badFigures: [], badAddresses: [], badClaims: [] });
  });

  await check('findBadAddresses(): live Run 1\'s "435 S Seaward Avenue" (the real address is 436) is flagged, alone, with the street\'s real addresses as the hint, and validateRationale() names it for the retry', () => {
    const bad = findBadAddresses(LIVE_RUN1, haleyInput);
    assert.deepEqual(bad.map(b => b.shown), ['435 S Seaward Avenue']);
    assert.deepEqual(bad[0].hint, ['436 S Seaward Avenue', '1078 S Seaward Avenue', '514 S Seaward Ave']);
    const v = validateRationale(LIVE_RUN1, haleyInput);
    assert.equal(v.ok, false);
    assert.deepEqual(v.badAddresses, ['435 S Seaward Avenue']);
    assert.deepEqual(v.badFigures, []);
    assert.deepEqual(v.labels, []);
    assert.equal(v.problems.length, 1);
    assert.match(v.problems[0], /it mentioned an address that does not match any comp line in the data: "435 S Seaward Avenue" \(the data has 436 S Seaward Avenue; 1078 S Seaward Avenue; 514 S Seaward Ave on that street\); write each comp's street address exactly as it appears on its comp line/);
  });

  await check('findBadAddresses(): "2585/2587 Warbler Ave." passes (and "2585 Warbler Avenue", "2587 Warbler"), a combined number that is not on one comp does not', () => {
    for (const ok of ['2585/2587 Warbler Ave. leased at $3,540.', '2585 Warbler Avenue leased.', 'leased at 2587 Warbler.', '2585-2587 Warbler Ave leased.', '2585 / 2587 Warbler Ave. leased.']) assert.deepEqual(findBadAddresses(ok, haleyInput), [], ok);
    assert.deepEqual(findBadAddresses('2585/2588 Warbler Ave. leased.', haleyInput).map(b => b.shown), ['2585/2588 Warbler Ave.']);
  });

  await check('findBadAddresses(): tolerant of street-type abbreviations, N/S/E/W prefixes (with or without a period, or spelled out), unit suffixes, and the subject\'s own address', () => {
    for (const ok of ['102 N. Kalorama St. is a lease.', '102 N Kalorama Street is a lease.', '102 Kalorama Street is a lease.', '1568 E. Thompson Blvd is active.', '1568 East Thompson Boulevard is active.', '436 South Seaward Ave is active.',
      '2378 Channel Drive, Unit 103 is off-market.', '2378 Channel Dr Unit 103 is off-market.', '2437 E Main St is small.', '4577 Calle Argolla is active.', 'The subject at 2472 Haley Point Drive is a townhouse.', '3495 Somis Road asks more.']) {
      assert.deepEqual(findBadAddresses(ok, haleyInput), [], ok);
    }
  });

  await check('findBadAddresses(): a wrong number, an invented street, a real number on the wrong street, and a wrong number with no street type are all flagged; each is named once', () => {
    const flagged = text => findBadAddresses(text, haleyInput).map(b => b.shown);
    assert.deepEqual(flagged('435 S Seaward Avenue asks $3,495 and again 435 S Seaward Avenue.'), ['435 S Seaward Avenue']);
    assert.deepEqual(flagged('500 Imaginary Boulevard leased.'), ['500 Imaginary Boulevard']);
    assert.deepEqual(findBadAddresses('500 Imaginary Boulevard leased.', haleyInput)[0].hint, []);
    assert.match(validateRationale('500 Imaginary Boulevard leased.', haleyInput).problems[0], /"500 Imaginary Boulevard" \(no comp line has it\)/);
    assert.deepEqual(flagged('3677 Hoover Ave leased.'), ['3677 Hoover Ave']);
    assert.deepEqual(flagged('3678 Willowick leased.'), ['3678 Willowick']);
    assert.deepEqual(flagged('Both 3678 Willowick Dr and 103 Hoover Ave. leased.'), ['3678 Willowick Dr', '103 Hoover Ave.']);
    assert.match(validateRationale('Both 3678 Willowick Dr and 103 Hoover Ave. leased.', haleyInput).problems[0], /it mentioned addresses that do not match/);
  });

  await check('findBadAddresses(): dollar amounts, 3bd/2.5ba, sqft, days, mile distances, counts and plain capitalized words after a number are never mistaken for addresses', () => {
    const text = 'The range of $3,495-$4,000 (midpoint $3,750) and $3,495-4,000 Range rests on 21 Counted comps, 3 Rincon-managed references, 80 Excluded, 9 Townhouses and 12 Unknown-type, a 3bd/2.5ba Townhouse of 1424 sqft Townhouse built 2025 Townhouse, 239 Days listed, 0.26 mi away, 2.5 Baths, a 2 Bedroom unit, and $4,000 After a cut from $4,200 in 11 Days.';
    const mentions = extractAddressMentions(text);
    assert.ok(mentions.every(m => !m.streetShaped), 'none looks like a street');
    assert.ok(!mentions.some(m => /^(3495|4000|3750|4200|1424|2025|239|26|5|2)$/.test(m.numbers[0]) && /\$|sqft|mi\b/.test(m.shown)), 'no $ amount, sqft or mile figure is parsed as a house number');
    assert.deepEqual(findBadAddresses(text, haleyInput), []);
    assert.equal(validateRationale(text, haleyInput).badAddresses.length, 0);
  });

  await check('generateNarrative() rationale with a wrong house number: rejected, ONE retry names the address and the real one, the clean retry is accepted, narratives kept; two wrong in a row gives rationale null', async () => {
    const bad = LIVE_RUN1;
    const fixed = LIVE_RUN2;
    const mock = mockClaude([gateReply(bad, { 2: 'Active ask.' }), textReply(rationaleOnly(fixed))]);
    const result = await withCapturedWarnings(warnings => generateNarrative(haleyInput, { client: mock.client })
      .then(r => { assert.ok(warnings.some(w => /Rationale rejected/.test(w) && /435 S Seaward Avenue/.test(w))); return r; }));
    assert.equal(mock.calls.length, 2);
    assert.match(mock.calls[1].messages[0].content, /it mentioned an address that does not match any comp line in the data: "435 S Seaward Avenue" \(the data has 436 S Seaward Avenue/);
    assert.match(mock.calls[1].messages[0].content, /No per-comp narratives/);
    assert.equal(result.rationale, fixed);
    assert.equal(result.narrativesByIndex[2], 'Active ask.', 'narratives from the first response are kept');
    assert.equal(result.meta.anthropicCalls, 2);

    const twice = mockClaude([gateReply(bad), textReply(rationaleOnly(bad))]);
    const dropped = await withCapturedWarnings(() => generateNarrative(haleyInput, { client: twice.client }));
    assert.equal(dropped.rationale, null);
    assert.equal(twice.calls.length, 2);
    assert.equal(dropped.meta.rationaleDropped, true);
  });

  await check('describeComp(): an off-market comp\'s days_on_market is labelled so it cannot be read as time spent off-market; active and leased comps keep "N days on market"; no days field when there is none', () => {
    const off = describeComp({ address: '1121 Pittsfield Ln', listing_status: 'off_market', monthly_rent: 4850, days_on_market: 239 }, 1);
    assert.match(off, /\| days listed before it came off the market: 239( \||$)/);
    assert.doesNotMatch(off, /days on market/);
    assert.match(describeComp({ address: 'A', listing_status: 'active', monthly_rent: 3495, days_on_market: 14 }, 2), /\| 14 days on market/);
    assert.match(describeComp({ address: 'L', listing_status: 'leased', monthly_rent: 3475, days_on_market: 11 }, 3), /\| 11 days on market/);
    assert.doesNotMatch(describeComp({ address: 'O', listing_status: 'off_market', monthly_rent: 4100 }, 4), /days/);
    assert.match(describeComp({ address: 'O', listing_status: 'off_market', monthly_rent: 4100, days_on_market: 0 }, 5), /days listed before it came off the market: 0/, 'zero days is a real value');
  });

  await check('buildPrompt() carries the days-on-market rule and the relabelled off-market line', () => {
    const prompt = buildPrompt(haleyInput);
    const rules = prompt.slice(prompt.indexOf('HARD RULES:'), prompt.indexOf('SUBJECT PROPERTY:'));
    assert.match(rules, /Days on market is how long the listing was up, never how long it has been off the market\./);
    assert.match(rules, /never write that such a comp "sat off-market" for that many days/);
    assert.match(prompt, /COMP 1: 1121 Pittsfield Ln.*days listed before it came off the market: 239/);
    assert.match(prompt, /COMP 0: 2378 Channel Dr.*days listed before it came off the market: 1/);
  });

  await check('guardCompLabels(): a per-comp narrative with a numeric comp label is dropped with one warning each; "a comp 0.4 miles away", "2 bedrooms", ordinary text and nulls are kept', () => {
    const comps = [{ address: '10 A St' }, { address: '11 B St' }, { address: '12 C St' }, { address: '13 D St' }, { address: '14 E St' }, { address: '15 F St' }];
    const narratives = ['Asking $3,495, close to COMP 63 at $3,795.', 'Sits a comp 0.4 miles away from the subject.', 'A comp 2 bedrooms smaller than the subject.', 'Leased at $3,700 in 11 days.', null, 'Mirrors comp #12 and Comps 3 and 4.'];
    const warnings = [];
    const original = console.warn;
    console.warn = w => warnings.push(w);
    let out;
    try { out = guardCompLabels(comps, narratives); } finally { console.warn = original; }
    assert.deepEqual(out, [null, narratives[1], narratives[2], narratives[3], null, null]);
    assert.equal(warnings.length, 2, 'one warning per dropped narrative');
    assert.match(warnings[0], /Dropped the narrative for comp 0 \(10 A St\): it used a numeric comp label \("COMP 63"\)/);
    assert.match(warnings[1], /comp 5 \(15 F St\).*"comp #12", "Comps 3 and 4"/);
  });

  await check('generateNarrative() NORMAL path: a per-comp narrative that uses a COMP label is nulled (one warning), the clean ones and meta.narrativesWritten are right, and the rationale is unaffected', async () => {
    const reply = gateReply(GOOD, { 0: 'Leased at $3,495 in a month.', 1: 'Active ask of $3,795, above COMP 5 at $3,295.', 2: 'Leased at $3,700, a comp 0.4 miles away.', 3: 'Leased at $4,085 after a cut from $4,200.', 4: 'Off-market, a comp 2 bedrooms off.' });
    const mock = mockClaude([reply]);
    const result = await withCapturedWarnings(warnings => generateNarrative(gateInput, { client: mock.client })
      .then(r => { assert.equal(warnings.filter(w => /numeric comp label/.test(w)).length, 1); assert.match(warnings.find(w => /numeric comp label/.test(w)), /comp 1 \(102 Beta St/); return r; }));
    assert.equal(mock.calls.length, 1);
    assert.equal(result.narrativesByIndex[1], null);
    assert.equal(result.narrativesByIndex[0], 'Leased at $3,495 in a month.');
    assert.equal(result.narrativesByIndex[2], 'Leased at $3,700, a comp 0.4 miles away.');
    assert.equal(result.narrativesByIndex[4], 'Off-market, a comp 2 bedrooms off.');
    assert.equal(result.meta.narrativesWritten, 4);
    assert.equal(result.rationale, GOOD);
  });

  await check('generateNarrative() SALVAGE path (max_tokens cut-off): a COMP-label narrative is nulled there too, finished clean narratives survive, the half-written one is still dropped', async () => {
    const cut = `RENTAL_ANALYSIS_OUTPUT: {"rationale": ${JSON.stringify(GOOD)}, "comp_narratives": {"0": "Clean one.", "1": "Higher than COMP 63.", "2": "Clean two.", "3": "was cut o`;
    const mock = mockClaude([textReply(cut, 'max_tokens', 16000)]);
    const result = await withCapturedWarnings(warnings => generateNarrative(gateInput, { client: mock.client })
      .then(r => { assert.equal(warnings.filter(w => /numeric comp label/.test(w)).length, 1); return r; }));
    assert.equal(mock.calls.length, 1);
    assert.deepEqual(result.narrativesByIndex.slice(0, 4), ['Clean one.', null, 'Clean two.', null]);
    assert.equal(result.rationale, GOOD);
    assert.equal(result.meta.truncated, true);
  });

  // ── TARS pass 3: address matcher on real messy addresses, dollar rounding/bands, range-building facts and rules ──
  console.log('--- lib/narrative.js address matcher on real data shapes, dollar rounding and bands, range facts, no-weight claims ---');

  // Real comp addresses copied from saved rental_comps rows, written exactly as stored (the 9 TARS found rejected, plus 263/264 as two real comps)
  const REAL_ADDRESSES = [
    '219-221-225 El Medio St, Ventura, CA 93001', '127 And 145 W Santa Barbara St, # 145G, Santa Paula, CA 93060', '234 238 S Pacific Ave, Ventura, CA 93001',
    '263 N Dos Caminos Ave, Ventura, CA 93003', '264 N Dos Caminos Ave, Ventura, CA 93003', '68 And 86 Kellogg St, Ventura, CA 93001', '116-124 3/4 S Mathews St, Los Angeles, CA 90033',
    '201-201 1/2 Eva St-201 1/2 Eva St, Ventura, CA 93003', '1201 Fuchsia St.-B, Oxnard, CA 93036', '1407 Oak Trail St, Newbury Park, CA 91320',
    '158 Midbury Hill Road Newbury Park, Newbury Park, CA 91320', '100 St Louis Ave, Ventura, CA 93001', "55 O'Neill Ln, Ventura, CA 93001", '23A Lemon Dr, Camarillo, CA 93010',
    '2378 Channel Dr, Unit 103, Ventura, CA 93003', '2585/2587 Warbler Ave., Ventura, CA 93003', '436 S Seaward Avenue, Ventura, CA 93003', '1568 E Thompson Boulevard, Ventura, CA 93001',
  ];
  const addrInput = { subject: { address: '5 Subject Way, Ventura, CA 93001' }, comps: REAL_ADDRESSES.map(address => ({ address, monthly_rent: 4000, listing_status: 'leased' })) };

  await check('findBadAddresses(): every messy REAL address (3-number range, "And", space-separated numbers, a fraction, a doubled address, "St.-B", a city glued on, "Oak Trail St", "St Louis", O\'Neill, 23A) passes when cited exactly as stored, in full and as its first part', () => {
    for (const address of REAL_ADDRESSES) {
      assert.deepEqual(findBadAddresses(`Leased at ${address} for $4,000.`, addrInput), [], `full: ${address}`);
      assert.deepEqual(findBadAddresses(`Leased at ${address.split(',')[0]} for $4,000.`, addrInput), [], `first part: ${address}`);
    }
  });

  await check('findBadAddresses(): the way a model abbreviates, shortens and punctuates those addresses passes too (Avenue/Ave., St./Street, N./North, one number of a range, no street type, curly apostrophe, possessive, a following sentence)', () => {
    for (const text of ['219 El Medio St leased.', '221 El Medio Street leased.', '225 El Medio leased.', '127 W Santa Barbara St leased.', '145 West Santa Barbara Street leased.', '234 S Pacific Ave leased.', '238 S. Pacific Avenue leased.',
      '263 N Dos Caminos Ave and 264 N. Dos Caminos Avenue leased.', '68 Kellogg St leased.', '86 Kellogg Street leased.', '116 S Mathews St leased.', '124 S Mathews leased.', '201 Eva St leased.', '1201 Fuchsia St. is active.',
      '1407 Oak Trail St leased.', '1407 Oak Trail leased.', '1407 Oak Trl St leased.', '158 Midbury Hill Road leased.', '158 Midbury Hill Rd Newbury Park leased.', '100 St. Louis Ave leased.', '100 St Louis Avenue leased.',
      '55 O’Neill Ln leased.', '55 O\'Neill Lane leased.', '23A Lemon Dr leased.', '23 Lemon Dr leased.', "Today 436 S Seaward Ave's ask is high.", 'at 2585 Warbler Ave. The recommended range follows.', 'at 2378 Channel Drive, Unit 103, off-market.', 'at 1568 E. Thompson Blvd Rincon lease.']) {
      assert.deepEqual(findBadAddresses(text, addrInput), [], text);
    }
  });

  await check('findBadAddresses(): "263/264 N Dos Caminos Ave" passes when 263 and 264 are each a real comp on that street; "263/265" does not', () => {
    assert.deepEqual(findBadAddresses('263/264 N Dos Caminos Ave leased.', addrInput), []);
    assert.deepEqual(findBadAddresses('263 & 264 N Dos Caminos Ave leased.', addrInput), []);
    assert.deepEqual(findBadAddresses('263/265 N Dos Caminos Ave leased.', addrInput).map(b => b.shown), ['263/265 N Dos Caminos Ave']);
  });

  await check('findBadAddresses(): a wrong house number is still flagged on EVERY real address shape (first number +1), with the real addresses on that street as the hint', () => {
    for (const address of REAL_ADDRESSES) {
      const first = address.split(',')[0];
      const num = first.match(/\d+/)[0];
      const taken = REAL_ADDRESSES.some(a => a !== address && a.split(',')[0].replace(/^[\d\s\/&-]*(And\s+)?/, '') === first.replace(/^[\d\s\/&-]*(And\s+)?/, '') && new RegExp(`\\b${Number(num) + 1}\\b`).test(a.split(',')[0]));
      if (taken || (/^(263|264) /.test(first))) continue; // 263 -> 264 is another real comp on the same street: a correct citation
      const wrong = first.replace(num, String(Number(num) + 1));
      assert.equal(findBadAddresses(`Leased at ${wrong} for $4,000.`, addrInput).length, 1, `should flag: ${wrong}`);
    }
    assert.deepEqual(findBadAddresses('Leased at 265 N Dos Caminos Ave.', addrInput).map(b => b.shown), ['265 N Dos Caminos Ave.']);
  });

  await check('findBadAddresses(): an invented street, and a real house number on the wrong street, are flagged', () => {
    assert.deepEqual(findBadAddresses('500 Imaginary Boulevard leased.', addrInput).map(b => b.shown), ['500 Imaginary Boulevard']);
    assert.deepEqual(findBadAddresses('1407 Pine Trail St leased.', addrInput).map(b => b.shown), ['1407 Pine Trail St'], 'right number, wrong street');
    assert.deepEqual(findBadAddresses('100 Louis Ave leased.', addrInput).map(b => b.shown), ['100 Louis Ave'], 'dropping the "St" of St Louis is a different street');
    assert.deepEqual(findBadAddresses('1407 Oak Park Ave leased.', addrInput).map(b => b.shown), ['1407 Oak Park Ave']);
  });

  const dollarInput = (rents, recommended = { low: 3495, mid: 3750, high: 4000 }, raw = { low: 3295, high: 4085 }, est = 3850) => ({
    subject: { address: '1 Test St, Ventura, CA 93001' }, comps: rents.map((monthly_rent, i) => ({ address: `${i + 1} Money St, Ventura, CA 93001`, monthly_rent, listing_status: 'leased', exclusion_reason: null })), recommended, raw, subjectEstimatedRent: est,
  });

  await check('validateRationale() accepts a provided FRACTIONAL figure written as a whole dollar (rounded to the nearest dollar or floored): $2,571 / $2,913 / ~$3,998 for 2571.25 / 2912.5 / 3997.5; still flags a different rounding and an invented figure', () => {
    const inp = dollarInput([2600, 3997.5], { low: 2571.25, mid: 2695, high: 2912.5 }, { low: 2200, high: 4085 }, 2540);
    for (const ok of ['The range is $2,571-$2,913 with a $2,695 midpoint.', 'A midpoint of ~$3,998 for one comp.', 'It asked $3,997 and then $2,912.', 'Exactly $2,571.25 to $2,912.50.']) {
      assert.deepEqual(validateRationale(ok, inp).badFigures, [], ok);
    }
    assert.deepEqual(validateRationale('A high of $2,914 and a low of $2,570.', inp).badFigures, ['$2,914', '$2,570'], 'neither is the provided figure rounded to a dollar or floored');
    assert.deepEqual(validateRationale('A low of $2,572.', inp).badFigures, ['$2,572'], 'rounding UP past the nearest dollar is not accepted');
  });

  await check('validateRationale() accepts the idiom "mid-$4,000s" / "high-$3,000s" / "$4,000s" only when a provided rent lies in that thousand-dollar band, and "$2,600s" only when one lies in 2,600-2,699', () => {
    const inp = dollarInput([3495, 3700, 4300, 4695], { low: 3495, mid: 3750, high: 4300 }, { low: 3495, high: 4695 });
    for (const ok of ['asks sit in the mid-$4,000s', 'leases in the high-$3,000s', 'a few in the $4,000s', "comps in the low $3,000's", 'the $3,000s and the $4,000s']) assert.deepEqual(validateRationale(ok, inp).badFigures, [], ok);
    assert.deepEqual(validateRationale('asks in the mid-$5,000s', inp).badFigures, ['$5,000s'], 'no provided rent is in 5,000-5,999');
    assert.deepEqual(validateRationale('asks in the $2,000s', inp).badFigures, ['$2,000s'], 'no provided rent is in 2,000-2,999');
    const hundreds = dollarInput([2665, 2800, 3000]);
    assert.deepEqual(validateRationale('landing in the mid-$2,600s', hundreds).badFigures, []);
    assert.deepEqual(validateRationale('landing in the high-$2,700s', hundreds).badFigures, ['$2,700s'], 'no rent in 2,700-2,799 (2,800 is outside it)');
  });

  await check('validateRationale() still flags a genuinely invented figure ($4,400 that is not provided, $4.2k, an average), and a difference of two provided figures only counts when it is smaller than the lowest provided rent', () => {
    const inp = dollarInput([3495, 3700, 4085, 4300]);
    assert.deepEqual(validateRationale('Open near $4,400.', inp).badFigures, ['$4,400']);
    assert.deepEqual(validateRationale('Roughly $4.2k works.', inp).badFigures, ['$4.2k']);
    assert.deepEqual(validateRationale('The average is $3,895.', inp).badFigures, ['$3,895']);
    const wide = dollarInput([3000, 7400, 5000]);
    assert.deepEqual(validateRationale('That is $4,400 above the lowest.', wide).badFigures, ['$4,400'], '7,400 - 3,000 = 4,400 is a difference but is rent-sized, so it cannot pass for a rent');
    const small = dollarInput([2000, 3800]);
    assert.deepEqual(validateRationale('$3,800 is $1,800 above $2,000.', small).badFigures, [], '3,800 - 2,000 = 1,800 is smaller than the lowest rent');
    assert.deepEqual(validateRationale('$3,800 is $1,700 above $2,000.', small).badFigures, ['$1,700']);
  });

  // ── range-building facts ──
  const factComps = [
    { address: '10 Low St, Ventura, CA 93001', monthly_rent: 2995, listing_status: 'active', exclusion_reason: null },
    { address: '11 Lease St, Ventura, CA 93001', monthly_rent: 3600, listing_status: 'leased', exclusion_reason: null },
    { address: '12 Mid St, Ventura, CA 93001', monthly_rent: 3750, listing_status: 'leased', exclusion_reason: null },
    { address: '13 Twin St, Ventura, CA 93001', monthly_rent: 3750, listing_status: 'active', exclusion_reason: null },
    { address: '14 High Lease St, Ventura, CA 93001', monthly_rent: 4100, listing_status: 'leased', exclusion_reason: null },
    { address: '15 Outlier Ave, Ventura, CA 93001', monthly_rent: 6500, listing_status: 'off_market', exclusion_reason: null },
    { address: '16 Giant Ave, Ventura, CA 93001', monthly_rent: 7990, listing_status: 'active', exclusion_reason: null },
    { address: '17 Condo Ct, Ventura, CA 93001', monthly_rent: 9500, listing_status: 'active', property_type: 'condo', exclusion_reason: 'property_type_mismatch' },
    { address: '18 Tiny Ct, Ventura, CA 93001', monthly_rent: 800, listing_status: 'leased', exclusion_reason: 'size_mismatch' },
    { address: '19 Unit Way, Unit 4, Ventura, CA 93001', monthly_rent: 2995, listing_status: 'leased', exclusion_reason: null },
  ];
  const factLines = (comps, rec, raw) => compFactsBlock(comps, { recommended: rec, raw }).split('\n').slice(7);

  await check('compFactsBlock() with recommended/raw adds exact lowest/highest, raw-range setters, above/below-the-range and lowest/highest LEASE lines (NOT COUNTED comps never appear; ties list every address; unit addresses keep their unit)', () => {
    const lines = factLines(factComps, { low: 3495, mid: 3750, high: 4000 }, { low: 2995, high: 7990 });
    assert.deepEqual(lines, [
      '- Lowest counted rent: $2,995 (10 Low St; 19 Unit Way, Unit 4). Highest counted rent: $7,990 (16 Giant Ave).',
      '- Raw range $2,995-$7,990: the low is set by 10 Low St; 19 Unit Way, Unit 4; the high is set by 16 Giant Ave.',
      '- Counted comps with rent ABOVE the recommended high ($4,000): 3: 16 Giant Ave $7,990 (active); 15 Outlier Ave $6,500 (off_market); 14 High Lease St $4,100 (leased).',
      '- Counted comps with rent BELOW the recommended low ($3,495): 2: 10 Low St $2,995 (active); 19 Unit Way, Unit 4 $2,995 (leased).',
      '- Highest counted LEASE: $4,100 (14 High Lease St). Lowest counted LEASE: $2,995 (19 Unit Way, Unit 4).',
    ]);
    assert.ok(!lines.join('\n').includes('Condo Ct') && !lines.join('\n').includes('Tiny Ct'), 'NOT COUNTED comps are outside the math and outside these lines');
  });

  await check('compFactsBlock() range lines: "none" when nothing is above/below, a no-lease run says so, ties at the top list every address, nothing is added without recommended/raw, and a long list is capped with the true count', () => {
    const inside = [{ address: '1 A St', monthly_rent: 3600, listing_status: 'active' }, { address: '2 B St', monthly_rent: 3900, listing_status: 'active' }];
    const lines = factLines(inside, { low: 3500, mid: 3700, high: 4000 }, { low: 3600, high: 3900 });
    assert.equal(lines[2], '- Counted comps with rent ABOVE the recommended high ($4,000): none.');
    assert.equal(lines[3], '- Counted comps with rent BELOW the recommended low ($3,500): none.');
    assert.equal(lines[4], '- Highest and lowest counted LEASE: none (no counted comp is leased).');
    assert.equal(compFactsBlock(inside).split('\n').length, 7, 'without recommended/raw the block is unchanged');
    const many = Array.from({ length: 20 }, (_, i) => ({ address: `${100 + i} Big St`, monthly_rent: 5000 + i * 10, listing_status: 'off_market' }));
    const capped = factLines(many, { low: 3000, mid: 3500, high: 4000 }, { low: 5000, high: 5190 })[2];
    assert.match(capped, /ABOVE the recommended high \(\$4,000\): 20: 119 Big St \$5,190 \(off_market\); /);
    assert.match(capped, /; and 5 more\.$/);
    assert.equal(capped.split(';').length, 16, '15 listed + the "and 5 more" part');
    assert.match(factLines(many, { low: 3000, mid: 3500, high: 4000 }, { low: 5000, high: 5190 })[1], /^- Raw range \$5,000-\$5,190: the low is set by 100 Big St; the high is set by 119 Big St\.$/);
    assert.match(factLines([{ address: '1 A St', monthly_rent: 3000, listing_status: 'active' }], { low: 1, mid: 2, high: 3 }, { low: 3100, high: 3200 })[1], /the low is set by no counted comp has exactly this rent/);
  });

  await check('range facts support leave-one-out reasoning: a counted outlier far above the range really does move the recommended high (computed with lib/weighting.js), and the facts list it as a counted comp above the high so it cannot be called "not used"', () => {
    const counted = factComps.filter(c => !c.exclusion_reason).map(c => ({ ...c, bedrooms: 3, property_type: 'single_family' }));
    const withAll = computeRecommendedRange(counted, 3, 'single_family');
    const withoutOutliers = computeRecommendedRange(counted.filter(c => c.monthly_rent < 6000), 3, 'single_family');
    const withoutOne = computeRecommendedRange(counted.filter(c => c.monthly_rent !== 6500), 3, 'single_family');
    assert.ok(withAll.high > withoutOutliers.high, `the $6,500 and $7,990 comps lift the recommended high (${withAll.high} vs ${withoutOutliers.high})`);
    assert.ok(withAll.high > withoutOne.high || withAll.mid > withoutOne.mid || withAll.low > withoutOne.low, 'removing even one counted outlier changes the range');
    const raw = computeRawRange(counted, 3, 'single_family');
    const facts = factLines(counted.map(c => ({ ...c })), withAll, raw).join('\n');
    assert.match(facts, /ABOVE the recommended high.*16 Giant Ave \$7,990 \(active\)/);
    assert.match(facts, new RegExp(`Raw range \\$2,995-\\$7,990: the low is set by 10 Low St; 19 Unit Way, Unit 4; the high is set by 16 Giant Ave`));
  });

  await check('buildPrompt() carries the range facts with the real figures, the widened facts header, and the two accuracy rules (counted comps always contributed; lowest/highest/pulls/anchors only from the facts, percentile direction)', () => {
    const prompt = buildPrompt({ ...gateInput, comps: gateInput.comps });
    assert.match(prompt, /COMPUTED COMP FACTS \(counted by code from the comp lines above; the only figures you may use for any count or makeup statement, and for any statement about which comp is the lowest or highest or sits above or below the range\):/);
    assert.match(prompt, /- Lowest counted rent: \$3,295 \(105 Echo St\)\. Highest counted rent: \$4,085 \(104 Delta St\)\./);
    assert.match(prompt, /- Raw range \$3,295-\$4,085: the low is set by 105 Echo St; the high is set by 104 Delta St\./);
    assert.match(prompt, /- Counted comps with rent ABOVE the recommended high \(\$4,000\): 1: 104 Delta St \$4,085 \(leased\)\./);
    assert.match(prompt, /- Counted comps with rent BELOW the recommended low \(\$3,495\): 1: 105 Echo St \$3,295 \(off_market\)\./);
    assert.match(prompt, /- Highest counted LEASE: \$4,085 \(104 Delta St\)\. Lowest counted LEASE: \$3,495 \(101 Alpha St\)\./);
    const facts = prompt.indexOf('COMPUTED COMP FACTS (counted by code'), numbers = prompt.indexOf('COMPUTED NUMBERS (');
    assert.ok(prompt.indexOf('COMPS (') < facts && facts < numbers, 'facts sit after the comp list and before COMPUTED NUMBERS');
    const rules = prompt.slice(prompt.indexOf('HARD RULES:'), prompt.indexOf('SUBJECT PROPERTY:'));
    assert.match(rules, /Every comp that is not marked NOT COUNTED contributed to the recommended range, including outliers and off-market comps/);
    assert.match(rules, /Never say a counted comp is "not used", "carries no weight", "anchors nothing", or "did not lift" or "did not affect" the range; you may say it is unconfirmed \(off-market\) or an outlier\. Only NOT COUNTED comps are outside the math\./);
    assert.match(rules, /must rest only on the lowest\/highest, raw-range, above\/below-the-range and lease lines of COMPUTED COMP FACTS and on the comp lines/);
    assert.match(rules, /are the 25th, 50th and 75th percentiles of the counted rents weighted by status, so a counted comp whose rent is above the recommended midpoint can only pull the range up \(never "the middle or bottom down"\), and a counted comp below the midpoint can only pull it down \(never the top up\)\./);
    assert.match(rules, /Only use facts given below\./, 'the earlier rules are all still there');
  });

  // ── "no effect on the range" claims about a COUNTED comp ──
  const claimComps = [
    { address: '639 Skyview Terrace, Ventura, CA 93003', monthly_rent: 6500, listing_status: 'off_market', exclusion_reason: null },
    { address: '4857 Loma Vista, Ventura, CA 93003', monthly_rent: 7990, listing_status: 'active', exclusion_reason: null },
    { address: '138 S Bryn Mawr St, Ventura, CA 93003', monthly_rent: 2995, listing_status: 'active', exclusion_reason: null },
    { address: '200 Condo Ct, Ventura, CA 93003', monthly_rent: 3000, listing_status: 'active', property_type: 'condo', exclusion_reason: 'property_type_mismatch' },
    { address: '7027 Flicker Ct, Ventura, CA 93003', monthly_rent: 3250, listing_status: 'active', exclusion_reason: null },
  ];
  const claimInput = { subject: { address: '1 Test St, Ventura, CA 93001' }, comps: claimComps, recommended: { low: 3250, mid: 3500, high: 4700 }, raw: { low: 2995, high: 7990 }, subjectEstimatedRent: 4000, sourcesUsed: ['RentCast'] };

  await check('findNoWeightClaims()/validateRationale() reject a COUNTED comp said to carry no weight / anchor nothing / not be used to lift the range (TARS\'s exact Rainier wording), and name the comp for the retry', () => {
    for (const [text, address] of [
      ['639 Skyview Terrace was not used to lift the range.', '639 Skyview Terrace'],
      ['4857 Loma Vista and 138 S Bryn Mawr St anchor nothing.', '138 S Bryn Mawr St'], // the cited comp nearest the phrase
      ['138 S Bryn Mawr St, at $2,995, carries no weight on the range.', '138 S Bryn Mawr St'],
      ['The $7,990 ask at 4857 Loma Vista carry no weight here.', '4857 Loma Vista'],
      ['639 Skyview Terrace anchors nothing, and 4857 Loma Vista did not lift the range.', '639 Skyview Terrace'],
      ['7027 Flicker Ct has zero weight in the math.', '7027 Flicker Ct'],
    ]) {
      const claims = findNoWeightClaims(text, claimComps);
      assert.ok(claims.length >= 1, text);
      assert.equal(claims[0].address, address, text);
      const v = validateRationale(text, claimInput);
      assert.equal(v.ok, false, text);
      assert.ok(v.badClaims.length >= 1);
      assert.match(v.problems.join(' '), /it said a counted comp has no effect on the range: ".*" \(.*\); every comp not marked NOT COUNTED contributed to the recommended range/);
    }
  });

  await check('findNoWeightClaims(): never flags a NOT COUNTED comp or a group of excluded comps (those really are outside the math), nor ordinary wording like "little weight", "less weight", "not used" with no such phrase', () => {
    for (const text of ['The 80 excluded comps carry no weight in either range.', '200 Condo Ct is a different property type, so it carries no weight.', 'Most nearby condos carry zero weight.',
      '639 Skyview Terrace is off-market, so it carries less weight than the leases.', '4857 Loma Vista is an outlier and carries little weight, yet it is counted.', '138 S Bryn Mawr St was used with the other counted comps.',
      '200 Condo Ct carries no weight, while 639 Skyview Terrace is counted at the low off-market weight.']) {
      assert.deepEqual(findNoWeightClaims(text, claimComps), [], text);
    }
    assert.equal(validateRationale('The 80 excluded comps carry no weight in either range.', claimInput).ok, true);
  });

  await check('guardNoWeightClaims(): a narrative that says its (counted) comp carries no weight / has no effect is dropped with one warning; honest "little weight", unrelated narratives, nulls and NOT COUNTED comps are untouched; about another NOT COUNTED comp it is kept', () => {
    const narratives = ['Off-market at $6,500, it carries no weight on the range.', 'Off-market at $6,500 after 112 days; an outlier, unconfirmed, so it carries little weight.', 'An outlier at $7,990 that anchors nothing.', null,
      'Active at $3,250, unlike 200 Condo Ct, which carries no weight.'];
    const warnings = [];
    const original = console.warn;
    console.warn = w => warnings.push(w);
    let out;
    try { out = guardNoWeightClaims(claimComps, narratives); } finally { console.warn = original; }
    assert.deepEqual(out, [null, narratives[1], null, null, narratives[4]]);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /Dropped the narrative for comp 0 \(639 Skyview Terrace.*\): it said a counted comp has no effect on the range \("carries no weight"\)/);
    const condo = guardNoWeightClaims(claimComps, [null, null, null, 'A different property type, so it carries no weight.', null]);
    assert.equal(condo[3], 'A different property type, so it carries no weight.', 'a NOT COUNTED comp may carry no weight');
  });

  await check('generateNarrative(): a rationale saying a counted comp is "not used to lift the range" is rejected, the ONE retry names that comp, a clean retry is accepted (still 2 calls); a narrative with the phrase is nulled on the normal AND the salvage path', async () => {
    const mock = mockClaude([gateReply('639 Skyview Terrace was not used to lift the range, per 138 S Bryn Mawr St.', { 0: 'Off-market, $6,500, an outlier that carries no weight.', 1: 'Active $7,990, the high outlier.', 2: 'Active $2,995.', 4: 'Active $3,250.' }), textReply(rationaleOnly('639 Skyview Terrace is an off-market outlier that still counts at the lowest weight.'))]);
    const result = await withCapturedWarnings(() => generateNarrative(claimInput, { client: mock.client }));
    assert.equal(mock.calls.length, 2);
    assert.match(mock.calls[1].messages[0].content, /it said a counted comp has no effect on the range: "639 Skyview Terrace" \(was not used to\)/);
    assert.equal(result.rationale, '639 Skyview Terrace is an off-market outlier that still counts at the lowest weight.');
    assert.equal(result.narrativesByIndex[0], null, 'the false narrative is dropped');
    assert.equal(result.narrativesByIndex[1], 'Active $7,990, the high outlier.');
    const cut = `RENTAL_ANALYSIS_OUTPUT: {"rationale": "639 Skyview Terrace is an off-market outlier that still counts.", "comp_narratives": {"0": "An outlier that anchors nothing.", "1": "Active $7,990.", "2": "Active $2,9`;
    const salvage = await withCapturedWarnings(() => generateNarrative(claimInput, { client: mockClaude([textReply(cut, 'max_tokens', 16000)]).client }));
    assert.deepEqual(salvage.narrativesByIndex.slice(0, 3), [null, 'Active $7,990.', null]);
  });

  await check('salvagePartialOutput(): needs a complete rationale (null otherwise), ignores out-of-range comp numbers, and decodes escapes', () => {
    assert.equal(salvagePartialOutput('no marker here', 3), null);
    assert.equal(salvagePartialOutput('RENTAL_ANALYSIS_OUTPUT: {"rationale": "cut', 3), null);
    const ok = salvagePartialOutput('RENTAL_ANALYSIS_OUTPUT: {"rationale": "Line one.\\nLine two.", "comp_narratives": {"0": "A.", "9": "out of range", "1": "B', 3);
    assert.equal(ok.rationale, 'Line one.\nLine two.');
    assert.deepEqual(ok.narrativesByIndex, ['A.', null, null]);
  });

  await check('a comp with a null narrative renders fine: the dashboard only prints the narrative div when c.narrative is truthy, and NOT COUNTED comps use buildNotUsedRow (address/price/reason only)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    for (const file of [path.join(__dirname, 'dashboard', 'index.html'), path.join(__dirname, '..', 'hub', 'rental-analysis', 'dashboard', 'index.html')]) {
      const html = fs.readFileSync(file, 'utf8');
      assert.match(html, /\(c\.narrative \? '<div class="comp-narrative">'/, `${file}: narrative is conditional`);
      const notUsed = html.slice(html.indexOf('function buildNotUsedRow'), html.indexOf('function renderReport'));
      assert.ok(!/narrative/.test(notUsed), `${file}: buildNotUsedRow never uses a narrative`);
    }
  });

  console.log('--- lib/sources.js ---');

  await check('SOURCE_HANDLERS registers "LeadSimple Move-Ins" with pullLeadSimpleComps, matching the exact name the migration\'s rental_comp_sources seed and lib/weighting.js\'s SELF_SOURCED_TRUSTED_SOURCE_NAMES both use', () => {
    assert.equal(typeof sourcesLib.SOURCE_HANDLERS['LeadSimple Move-Ins'], 'function');
    assert.equal(sourcesLib.SOURCE_HANDLERS['LeadSimple Move-Ins'], pullLeadSimpleComps);
  });

  await check('runActiveSources() skips a source with no handler instead of throwing (Zillow is actually seeded is_active=false today and would never reach this loop — this proves the skip-path is still safe if it were ever flipped on without a handler)', async () => {
    const result = await runActiveSources(
      [{ id: 'src-1', name: 'Zillow' }], // no handler registered for 'Zillow' — see lib/sources.js's NOTE
      { address: '1 Test St', propertyType: 'single_family', bedrooms: 2, bathrooms: 1, sqft: 900 }
    );
    assert.deepEqual(result.comps, []);
    assert.deepEqual(result.sourcesUsed, []);
    assert.deepEqual(result.sourceErrors, []); // "no handler" is a skip, not a source error
    assert.equal(result.subjectEstimatedRent, null);
  });

  await check('runActiveSources() records a source error (not a thrown exception) when a handler rejects', async () => {
    const originalRentCast = sourcesLib.SOURCE_HANDLERS.RentCast;
    sourcesLib.SOURCE_HANDLERS.RentCast = async () => { throw new Error('simulated RentCast failure'); };
    try {
      const result = await runActiveSources(
        [{ id: 'src-2', name: 'RentCast' }],
        { address: '1 Test St', propertyType: 'single_family', bedrooms: 2, bathrooms: 1, sqft: 900 }
      );
      assert.deepEqual(result.comps, []);
      assert.equal(result.sourceErrors.length, 1);
      assert.equal(result.sourceErrors[0].name, 'RentCast');
      assert.match(result.sourceErrors[0].error, /simulated RentCast failure/);
    } finally {
      sourcesLib.SOURCE_HANDLERS.RentCast = originalRentCast;
    }
  });

  await check('runActiveSources() surfaces a handler\'s subjectEstimatedRent through to the caller', async () => {
    const originalRentCast = sourcesLib.SOURCE_HANDLERS.RentCast;
    sourcesLib.SOURCE_HANDLERS.RentCast = async () => ({
      subjectEstimatedRent: 4275,
      comps: [{ monthly_rent: 4200, listing_status: 'active' }],
    });
    try {
      const result = await runActiveSources(
        [{ id: 'src-3', name: 'RentCast' }],
        { address: '1 Test St', propertyType: 'single_family', bedrooms: 2, bathrooms: 1, sqft: 900 }
      );
      assert.equal(result.subjectEstimatedRent, 4275);
      assert.equal(result.comps.length, 1);
      assert.deepEqual(result.sourcesUsed, ['RentCast']);
    } finally {
      sourcesLib.SOURCE_HANDLERS.RentCast = originalRentCast;
    }
  });

  await check('runActiveSources() surfaces a handler\'s subjectLatitude/subjectLongitude through to the caller, alongside each comp\'s own coordinates', async () => {
    const originalRentCast = sourcesLib.SOURCE_HANDLERS.RentCast;
    sourcesLib.SOURCE_HANDLERS.RentCast = async () => ({
      subjectEstimatedRent: 4275,
      subjectLatitude: 34.179615,
      subjectLongitude: -119.198962,
      comps: [{ monthly_rent: 4200, listing_status: 'active', latitude: 34.180001, longitude: -119.199501 }],
    });
    try {
      const result = await runActiveSources(
        [{ id: 'src-4', name: 'RentCast' }],
        { address: '1 Test St', propertyType: 'single_family', bedrooms: 2, bathrooms: 1, sqft: 900 }
      );
      assert.equal(result.subjectLatitude, 34.179615);
      assert.equal(result.subjectLongitude, -119.198962);
      assert.equal(result.comps[0].latitude, 34.180001);
      assert.equal(result.comps[0].longitude, -119.199501);
    } finally {
      sourcesLib.SOURCE_HANDLERS.RentCast = originalRentCast;
    }
  });

  await check('runActiveSources() leaves subjectLatitude/subjectLongitude null when a handler does not provide them (e.g. Zillow/FlexMLS, once added, before coordinate support is confirmed)', async () => {
    const result = await runActiveSources(
      [{ id: 'src-1', name: 'Zillow' }], // no handler — same skip path as the first test above
      { address: '1 Test St', propertyType: 'single_family', bedrooms: 2, bathrooms: 1, sqft: 900 }
    );
    assert.equal(result.subjectLatitude, null);
    assert.equal(result.subjectLongitude, null);
  });

  await check('runActiveSources() runs RentCast first regardless of its position in activeSources, and feeds its subjectLatitude/subjectLongitude forward into every other handler\'s subject (the CRMLS radius-search build)', async () => {
    const originalRentCast = sourcesLib.SOURCE_HANDLERS.RentCast;
    const originalCrmls = sourcesLib.SOURCE_HANDLERS.CRMLS;
    const callOrder = [];
    let crmlsReceivedSubject = null;
    sourcesLib.SOURCE_HANDLERS.RentCast = async () => {
      callOrder.push('RentCast');
      return { subjectLatitude: 34.179615, subjectLongitude: -119.198962, comps: [] };
    };
    sourcesLib.SOURCE_HANDLERS.CRMLS = async (subject) => {
      callOrder.push('CRMLS');
      crmlsReceivedSubject = subject;
      return { comps: [] };
    };
    try {
      // CRMLS listed BEFORE RentCast here — proves the reorder actually
      // happens, rather than the test just getting lucky with array order.
      await runActiveSources(
        [{ id: 'src-crmls', name: 'CRMLS' }, { id: 'src-rentcast', name: 'RentCast' }],
        { address: '1895 Dorrit St, Newbury Park, CA 91320', propertyType: 'single_family', bedrooms: 3, bathrooms: 2, sqft: 1450 }
      );
      assert.deepEqual(callOrder, ['RentCast', 'CRMLS'], 'RentCast must run first even though CRMLS was listed first in activeSources');
      assert.equal(crmlsReceivedSubject.latitude, 34.179615, 'CRMLS\'s handler must receive the lat/long RentCast just discovered');
      assert.equal(crmlsReceivedSubject.longitude, -119.198962);
      assert.equal(crmlsReceivedSubject.address, '1895 Dorrit St, Newbury Park, CA 91320', 'the enriched subject must still carry the original fields, unmodified');
    } finally {
      sourcesLib.SOURCE_HANDLERS.RentCast = originalRentCast;
      sourcesLib.SOURCE_HANDLERS.CRMLS = originalCrmls;
    }
  });

  await check('runActiveSources() leaves the subject\'s latitude/longitude unset when RentCast is not among the active sources — CRMLS must degrade to its own zip-only path, not throw', async () => {
    const originalCrmls = sourcesLib.SOURCE_HANDLERS.CRMLS;
    let crmlsReceivedSubject = null;
    sourcesLib.SOURCE_HANDLERS.CRMLS = async (subject) => {
      crmlsReceivedSubject = subject;
      return { comps: [] };
    };
    try {
      await runActiveSources(
        [{ id: 'src-crmls', name: 'CRMLS' }],
        { address: '1895 Dorrit St, Newbury Park, CA 91320', propertyType: 'single_family', bedrooms: 3, bathrooms: 2, sqft: 1450 }
      );
      assert.equal('latitude' in crmlsReceivedSubject, false);
      assert.equal('longitude' in crmlsReceivedSubject, false);
    } finally {
      sourcesLib.SOURCE_HANDLERS.CRMLS = originalCrmls;
    }
  });

  console.log('--- lib/sources.js applyCombinedRadiusTiering() / runActiveSources() cross-source radius coordination ---');

  // NOTE (2026-10-14, COMP-COVERAGE-SPEC.md): the radius ladder replaced the
  // single "4 genuine comps within 1 mile" rule. A rung only qualifies with
  // at least MIN_COMPS_FOR_NARROW_RADIUS genuine comps (one per distinct
  // address) AND at least MIN_LEASED_COMPS_FOR_NARROW_RADIUS confirmed
  // leases. Every test below that expects the search to NARROW therefore
  // carries two 'leased' comps among its near comps; the tests that expect
  // it to stay wide carry none, so no rung qualifies and the ceiling keeps
  // everything. Each was hand-traced rung by rung.
  await check('runActiveSources(): the real 5537 Rainier Street bug, reconstructed — the close comps include enough confirmed leases that the ladder stops at 1 mile, so CRMLS\'s own far-away condos must NOT survive', async () => {
    const originalRentCast = sourcesLib.SOURCE_HANDLERS.RentCast;
    const originalCrmls = sourcesLib.SOURCE_HANDLERS.CRMLS;
    // Hand-trace (subject single_family 3bd; comps carry no bedrooms, which
    // is "unknown", still genuine): rung 0.5 -> 0.2, 0.4 = 2 genuine, fails;
    // rung 1 -> 0.2, 0.4, 0.6, 0.8, 0.9 = 5 genuine, 2 leased (0.8, 0.9),
    // stops. RentCast never produces 'leased' for real, so the two leased
    // comps are CRMLS's (the 0.9 comp moved from the RentCast list to the
    // CRMLS list to keep that true in the mock too).
    sourcesLib.SOURCE_HANDLERS.RentCast = async () => ({
      comps: [
        { monthly_rent: 4200, listing_status: 'active', property_type: 'single_family', distance_miles: 0.2 },
        { monthly_rent: 4300, listing_status: 'active', property_type: 'single_family', distance_miles: 0.4 },
        { monthly_rent: 4250, listing_status: 'active', property_type: 'single_family', distance_miles: 0.6 },
      ],
    });
    sourcesLib.SOURCE_HANDLERS.CRMLS = async () => ({
      comps: [
        { monthly_rent: 4350, listing_status: 'leased', property_type: 'single_family', distance_miles: 0.8 },
        { monthly_rent: 4400, listing_status: 'leased', property_type: 'single_family', distance_miles: 0.9 },
        { monthly_rent: 3800, listing_status: 'active', property_type: 'condo', distance_miles: 1.71, address: '1300 Saratoga Ave' },
        { monthly_rent: 3750, listing_status: 'active', property_type: 'condo', distance_miles: 1.83, address: '1237 Saratoga Ave' },
        { monthly_rent: 3900, listing_status: 'active', property_type: 'condo', distance_miles: 1.91, address: '3700 Dean' },
      ],
    });
    try {
      const result = await runActiveSources(
        [{ id: 'src-rc', name: 'RentCast' }, { id: 'src-crmls', name: 'CRMLS' }],
        { address: '5537 Rainier Street, Ventura, CA', propertyType: 'single_family', bedrooms: 3, bathrooms: 2, sqft: 1600 }
      );
      const addresses = result.comps.map(c => c.address);
      assert.ok(!addresses.includes('1300 Saratoga Ave'), 'condo 1.71mi away must not survive — RentCast alone already had enough close comps');
      assert.ok(!addresses.includes('1237 Saratoga Ave'));
      assert.ok(!addresses.includes('3700 Dean'));
      assert.equal(result.comps.length, 5, 'the 3 RentCast comps plus the 2 close CRMLS comps — every surviving comp within 1 mile');
    } finally {
      sourcesLib.SOURCE_HANDLERS.RentCast = originalRentCast;
      sourcesLib.SOURCE_HANDLERS.CRMLS = originalCrmls;
    }
  });

  await check('applyCombinedRadiusTiering(): no confirmed leases among the comps -> no rung qualifies, the ladder uses the 2mi ceiling, every comp every source found survives', () => {
    const comps = [
      { source_name: 'RentCast', monthly_rent: 4200, property_type: 'single_family', distance_miles: 0.3 },
      { source_name: 'CRMLS', monthly_rent: 3800, property_type: 'single_family', distance_miles: 0.9 },
      { source_name: 'CRMLS', monthly_rent: 3900, property_type: 'condo', distance_miles: 1.7 },
      { source_name: 'LeadSimple Move-Ins', monthly_rent: 4000, property_type: 'single_family', distance_miles: 1.9 },
    ]; // no 'leased' comp anywhere (and only 3 genuine in total) -> no rung qualifies -> ceiling, nothing is cut
    const result = applyCombinedRadiusTiering(comps, { bedrooms: 3, propertyType: 'single_family' });
    assert.equal(result.length, 4, 'a genuinely wide case must keep every comp from every source');
  });

  await check('applyCombinedRadiusTiering(): a property-type mismatch within a rung does not count as a genuine comp; with no rung qualifying the ceiling keeps everything', () => {
    const comps = [
      { source_name: 'RentCast', monthly_rent: 4200, property_type: 'single_family', distance_miles: 0.2 },
      { source_name: 'RentCast', monthly_rent: 4300, property_type: 'single_family', distance_miles: 0.4 },
      { source_name: 'CRMLS', monthly_rent: 3800, property_type: 'townhouse', distance_miles: 0.5 }, // mismatch — doesn't count
      { source_name: 'CRMLS', monthly_rent: 3900, property_type: 'condo', distance_miles: 0.6 }, // mismatch — doesn't count
    ]; // only 2 countable (the two single_family), and none leased -> no rung qualifies
    const result = applyCombinedRadiusTiering(comps, { bedrooms: 3, propertyType: 'single_family' });
    assert.equal(result.length, 4, 'only 2 countable comps and no leases -> no rung qualifies -> ceiling -> every comp (including the mismatches) survives');
  });

  await check('applyCombinedRadiusTiering(): an unknown property type (null) still counts as a genuine comp, per exclusionReason()\'s "don\'t punish missing data" rule', () => {
    // Hand-trace: rung 0.5 -> 0.2, 0.4, 0.5 = 3 genuine, fails (needs 4);
    // rung 1 -> 0.2, 0.4, 0.5, 0.6 = 4 genuine (2 single_family + 2
    // unknown-type) and 2 leased (0.4 single_family, 0.5 unknown-type),
    // stops. The unknown-type comps are what get it to 4.
    const comps = [
      { source_name: 'RentCast', monthly_rent: 4200, property_type: 'single_family', distance_miles: 0.2 },
      { source_name: 'CRMLS', monthly_rent: 4300, listing_status: 'leased', property_type: 'single_family', distance_miles: 0.4 },
      { source_name: 'CRMLS', monthly_rent: 3800, listing_status: 'leased', property_type: null, distance_miles: 0.5 }, // unknown — counts
      { source_name: 'CRMLS', monthly_rent: 3900, property_type: null, distance_miles: 0.6 }, // unknown — counts
      { source_name: 'CRMLS', monthly_rent: 3950, property_type: 'condo', distance_miles: 1.7 }, // mismatch, beyond the chosen rung anyway
    ];
    const result = applyCombinedRadiusTiering(comps, { bedrooms: 3, propertyType: 'single_family' });
    assert.equal(result.length, 4, 'the 4 within 1 mile (2 single_family + 2 unknown-type, 2 of them leased) qualify rung 1 -> the far condo is dropped');
    assert.ok(result.every(c => c.distance_miles <= RADIUS_LADDER_MILES[1]));
    assert.equal(chooseRadiusRung(comps, { bedrooms: 3, propertyType: 'single_family' }).rung, 1);
  });

  await check('applyCombinedRadiusTiering(): comps with no distance_miles never help a rung qualify, but survive when the ladder ends at the ceiling', () => {
    const comps = [
      { source_name: 'RentCast', monthly_rent: 4200, property_type: 'single_family', distance_miles: 0.2 },
      { source_name: 'RentCast', monthly_rent: 4300, property_type: 'single_family', distance_miles: 0.4 },
      { source_name: 'CRMLS', monthly_rent: 3800, property_type: 'single_family', distance_miles: 0.6 },
      { source_name: 'LeadSimple Move-Ins', monthly_rent: 4000, property_type: 'single_family', distance_miles: null }, // not yet geocoded
    ]; // only 3 countable (real distances) and none leased -> no rung qualifies
    const result = applyCombinedRadiusTiering(comps, { bedrooms: 3, propertyType: 'single_family' });
    assert.equal(result.length, 4, 'ceiling — the no-distance comp cannot prove it is close, so it never helps a rung qualify, but it survives at the ceiling');
    assert.ok(result.some(c => c.distance_miles === null), 'the no-distance comp must still be present in the wide result');
  });

  await check('applyCombinedRadiusTiering(): a GENUINE comp with no distance_miles is dropped once a narrower rung is chosen — it cannot be shown to be inside it (superseded: it used to survive unconditionally)', () => {
    // Hand-trace: rung 0.5 -> 0.2, 0.4 = 2 genuine, fails; rung 1 -> 4
    // genuine (0.2, 0.4, 0.6, 0.9), 2 leased (0.6, 0.9), stops. The
    // no-distance LeadSimple comp never counts toward a rung and is dropped.
    const comps = [
      { source_name: 'RentCast', monthly_rent: 4200, property_type: 'single_family', distance_miles: 0.2 },
      { source_name: 'RentCast', monthly_rent: 4300, property_type: 'single_family', distance_miles: 0.4 },
      { source_name: 'CRMLS', monthly_rent: 3800, listing_status: 'leased', property_type: 'single_family', distance_miles: 0.6 },
      { source_name: 'CRMLS', monthly_rent: 3900, listing_status: 'leased', property_type: 'single_family', distance_miles: 0.9 },
      { source_name: 'LeadSimple Move-Ins', monthly_rent: 4000, property_type: 'single_family', distance_miles: null }, // genuine match (same type), just not yet geocoded
    ];
    const result = applyCombinedRadiusTiering(comps, { bedrooms: 3, propertyType: 'single_family' });
    assert.equal(result.length, 4, 'rung 1 was chosen, so the comp with no distance (which cannot be shown to be inside it) is dropped');
    assert.ok(!result.some(c => c.distance_miles === null), 'the no-distance comp must not survive a narrower rung');
  });

  await check('applyCombinedRadiusTiering(): the same comps with NO leases -> no rung qualifies -> ceiling, and the genuine no-distance comp survives', () => {
    const comps = [
      { source_name: 'RentCast', monthly_rent: 4200, property_type: 'single_family', distance_miles: 0.2 },
      { source_name: 'RentCast', monthly_rent: 4300, property_type: 'single_family', distance_miles: 0.4 },
      { source_name: 'CRMLS', monthly_rent: 3800, listing_status: 'active', property_type: 'single_family', distance_miles: 0.6 },
      { source_name: 'CRMLS', monthly_rent: 3900, listing_status: 'active', property_type: 'single_family', distance_miles: 0.9 },
      { source_name: 'LeadSimple Move-Ins', monthly_rent: 4000, property_type: 'single_family', distance_miles: null },
    ];
    const result = applyCombinedRadiusTiering(comps, { bedrooms: 3, propertyType: 'single_family' });
    assert.equal(result.length, 5, 'nothing is cut at the ceiling');
    assert.ok(result.some(c => c.source_name === 'LeadSimple Move-Ins' && c.distance_miles === null), 'at the ceiling the no-distance comp survives, same as before the ladder');
  });

  await check('applyCombinedRadiusTiering(): a NON-genuine match with no distance_miles is dropped once a narrower rung is chosen (same as a genuine no-distance comp)', () => {
    const comps = [
      { source_name: 'RentCast', monthly_rent: 4200, property_type: 'single_family', distance_miles: 0.2 },
      { source_name: 'RentCast', monthly_rent: 4300, property_type: 'single_family', distance_miles: 0.4 },
      { source_name: 'CRMLS', monthly_rent: 3800, listing_status: 'leased', property_type: 'single_family', distance_miles: 0.6 },
      { source_name: 'CRMLS', monthly_rent: 3900, listing_status: 'leased', property_type: 'single_family', distance_miles: 0.9 },
      { source_name: 'CRMLS', monthly_rent: 3950, property_type: 'condo', distance_miles: null }, // NOT a genuine match (wrong type), and can't be proven close
    ]; // 4 genuine within 1 mile, 2 leased -> rung 1 (rung 0.5 has only 2 genuine)
    const result = applyCombinedRadiusTiering(comps, { bedrooms: 3, propertyType: 'single_family' });
    assert.equal(result.length, 4, 'the non-genuine no-distance comp must be dropped once rung 1 is chosen — it can\'t prove it belongs');
    assert.ok(!result.some(c => c.property_type === 'condo'), 'the non-genuine no-distance comp must not survive');
  });

  await check('applyCombinedRadiusTiering(): a genuine match beyond the chosen rung is dropped once that rung has 4 genuine + 2 leased comps (flipped: a far genuine match used to survive unconditionally; safe now because real lease evidence already sits closer)', () => {
    // Hand-trace: rung 0.5 -> 0.2, 0.5 = 2 genuine, fails; rung 1 -> 0.2,
    // 0.5, 0.7, 0.9 = 4 genuine, 2 leased (0.7, 0.9), stops. The genuine
    // 1.6 and 1.8 comps and the 1.6 condo are all beyond rung 1.
    const comps = [
      { source_name: 'RentCast', monthly_rent: 4200, property_type: 'single_family', distance_miles: 0.2 },
      { source_name: 'RentCast', monthly_rent: 4300, property_type: 'single_family', distance_miles: 0.5 },
      { source_name: 'RentCast', monthly_rent: 4400, property_type: 'single_family', distance_miles: 1.6 }, // genuine (single_family), but beyond the chosen rung
      { source_name: 'CRMLS', monthly_rent: 3800, listing_status: 'leased', property_type: 'single_family', distance_miles: 0.7 },
      { source_name: 'CRMLS', monthly_rent: 3900, listing_status: 'leased', property_type: 'single_family', distance_miles: 0.9 },
      { source_name: 'LeadSimple Move-Ins', monthly_rent: 4000, listing_status: 'leased', property_type: 'single_family', distance_miles: 1.8 }, // also genuine, beyond the chosen rung
      { source_name: 'RentCast', monthly_rent: 3500, property_type: 'condo', distance_miles: 1.6 }, // NOT genuine, beyond the chosen rung
    ];
    const result = applyCombinedRadiusTiering(comps, { bedrooms: 3, propertyType: 'single_family' });
    assert.equal(result.length, 4, 'only the 4 comps inside rung 1 survive');
    assert.ok(result.every(c => c.distance_miles <= 1), 'nothing beyond the chosen rung survives, genuine or not');
    assert.ok(!result.some(c => c.distance_miles === 1.6 || c.distance_miles === 1.8), 'the genuine 1.6mi RentCast comp and the genuine 1.8mi LeadSimple comp are dropped (flipped from the old assertion)');
  });

  await check('runActiveSources() + computeRecommendedRange(): the Rainier Street regression (analysis 9ab946b1-2c6b-405a-adbd-d8f1c91f31e1) — the ladder widens to 1.5 miles (no confirmed leases inside 1), so 1148 Colina Vista and 7275 Coolidge Street survive, the far condos are gone, and the range recomputes', async () => {
    // Reconstructed directly from the real rental_comps rows for this
    // analysis (pulled live from Supabase, 2026-09-20) — not hand-guessed.
    // RentCast's 4 close same-type comps within 1 mile (555 Skyline Rd is
    // one of Rincon's own managed properties — is_rincon_managed isn't set
    // yet at this point in the pipeline, same as real handler output; it's
    // applied below, right before computeRecommendedRange(), mirroring
    // where server.js actually sets it via findBestPropertyMatch(), after
    // runActiveSources() returns).
    const rentCastComps = [
      { address: '555 Skyline Rd, Ventura, CA 93003', property_type: 'single_family', bedrooms: 4, distance_miles: 0.19, monthly_rent: 4395, listing_status: 'off_market' },
      { address: '5651 N Bryn Mawr St, Ventura, CA 93003', property_type: 'single_family', bedrooms: 4, distance_miles: 0.56, monthly_rent: 4500, listing_status: 'off_market' },
      { address: '201 Burnett Ave, Ventura, CA 93003', property_type: 'single_family', bedrooms: 4, distance_miles: 0.69, monthly_rent: 4500, listing_status: 'off_market' },
      { address: '6237 Hunter St, Ventura, CA 93003', property_type: 'single_family', bedrooms: 4, distance_miles: 0.82, monthly_rent: 4200, listing_status: 'off_market' },
    ];
    // CRMLS's close comp (480 Day Road), the two genuine leased matches
    // beyond 1 mile this regression exists to protect (1148 Colina Vista,
    // 7275 Coolidge Street — both real regression evidence), the 5 condo
    // rows across the 3 addresses that triggered the original bug (1300
    // Saratoga Ave x3 units, 1237 Saratoga Ave, 3700 Dean — all 1.71-1.91mi,
    // wrong property type), and the other far comps (6bd mismatch, wrong
    // type, 2-bedroom-off, unknown type) that sit beyond the rung the
    // ladder stops at.
    //
    // Hand-trace (subject single_family 4bd): rung 0.5 -> 555 Skyline (0.19),
    // 480 Day Rd (0.44, 3bd = one off, still genuine) = 2 genuine, 0 leased,
    // fails. Rung 1 -> + Bryn Mawr, Burnett, Hunter = 5 genuine, 0 leased,
    // fails (Colina Vista is at 1.10). Rung 1.5 -> + Colina Vista (leased) and
    // Coolidge (1.47, leased) = 7 genuine, 2 leased: stops at 1.5. Creekmont
    // (6bd) and Brentwood (apartment) are inside 1.5 but not genuine, so they
    // stay in the list and show as "not used".
    const crmlsComps = [
      { address: '480 Day Road, Ventura, CA 93003', property_type: 'single_family', bedrooms: 3, distance_miles: 0.44, monthly_rent: 4600, listing_status: 'active' },
      { address: '1148 Colina Vista, Ventura, CA 93003', property_type: 'single_family', bedrooms: 4, distance_miles: 1.10, monthly_rent: 5650, listing_status: 'leased' },
      { address: '642 Creekmont Court, Ventura, CA 93003', property_type: 'single_family', bedrooms: 6, distance_miles: 1.12, monthly_rent: 6500, listing_status: 'active' }, // 2+ bedrooms off -> not genuine
      { address: '60 Brentwood Avenue, Ventura, CA 93003', property_type: 'apartment', bedrooms: 0, distance_miles: 1.37, monthly_rent: 1400, listing_status: 'leased' }, // wrong type -> not genuine
      { address: '7275 Coolidge Street, Ventura, CA 93003', property_type: 'single_family', bedrooms: 3, distance_miles: 1.47, monthly_rent: 4195, listing_status: 'leased' },
      { address: '86 College Drive, Ventura, CA 93003', property_type: null, bedrooms: 2, distance_miles: 1.6, monthly_rent: 2795, listing_status: 'leased' }, // 2 bedrooms off -> not genuine, even with unknown type
      { address: '1300 Saratoga Avenue, Unit 2204, Ventura, CA 93003', property_type: 'condo', bedrooms: 2, distance_miles: 1.71, monthly_rent: 3100, listing_status: 'active' },
      { address: '1300 Saratoga Avenue, Unit 108, Ventura, CA 93003', property_type: 'condo', bedrooms: 2, distance_miles: 1.71, monthly_rent: 2550, listing_status: 'active' },
      { address: '1237 Saratoga Avenue, Ventura, CA 93003', property_type: 'condo', bedrooms: 2, distance_miles: 1.72, monthly_rent: 2500, listing_status: 'active' },
      { address: '1300 Saratoga Avenue, Unit 1212, Ventura, CA 93003', property_type: 'condo', bedrooms: 2, distance_miles: 1.73, monthly_rent: 2850, listing_status: 'active' },
      { address: '3700 Dean, Unit 2106, Ventura, CA 93003', property_type: 'condo', bedrooms: 2, distance_miles: 1.91, monthly_rent: 2950, listing_status: 'active' },
      { address: '3296 San Luis Street, Ventura, CA 93003', property_type: null, bedrooms: 3, distance_miles: 1.96, monthly_rent: 3750, listing_status: 'active' }, // unknown type + 1bd off -> still genuine
      { address: '1220 Johnson Drive, Unit 4, Ventura, CA 93003', property_type: 'manufactured', bedrooms: 2, distance_miles: 1.99, monthly_rent: 3000, listing_status: 'active' }, // wrong type -> not genuine
    ];

    const originalRentCast = sourcesLib.SOURCE_HANDLERS.RentCast;
    const originalCrmls = sourcesLib.SOURCE_HANDLERS.CRMLS;
    sourcesLib.SOURCE_HANDLERS.RentCast = async () => ({ comps: rentCastComps });
    sourcesLib.SOURCE_HANDLERS.CRMLS = async () => ({ comps: crmlsComps });
    try {
      const result = await runActiveSources(
        [{ id: 'src-rc', name: 'RentCast' }, { id: 'src-crmls', name: 'CRMLS' }],
        { address: '5537 Rainier Street, Ventura, CA', propertyType: 'single_family', bedrooms: 4, bathrooms: 2.5, sqft: 2139 }
      );
      const addresses = result.comps.map(c => c.address);

      assert.equal(chooseRadiusRung([...rentCastComps, ...crmlsComps], { bedrooms: 4, propertyType: 'single_family' }).rung, 1.5, 'the ladder must stop at 1.5 miles');
      assert.equal(result.comps.length, 9, '4 RentCast comps + Day Rd + Colina Vista + Coolidge + Creekmont + Brentwood');

      assert.ok(addresses.includes('1148 Colina Vista, Ventura, CA 93003'), '1148 Colina Vista (1.10mi, leased $5,650, exact 4bd match) must survive — the exact comp the regression dropped');
      assert.ok(addresses.includes('7275 Coolidge Street, Ventura, CA 93003'), '7275 Coolidge Street (1.47mi, leased $4,195, 1bd off) must survive — the other comp the regression dropped');

      const saratogaAndDeanAddresses = [
        '1300 Saratoga Avenue, Unit 2204, Ventura, CA 93003',
        '1300 Saratoga Avenue, Unit 108, Ventura, CA 93003',
        '1237 Saratoga Avenue, Ventura, CA 93003',
        '1300 Saratoga Avenue, Unit 1212, Ventura, CA 93003',
        '3700 Dean, Unit 2106, Ventura, CA 93003',
      ];
      for (const addr of saratogaAndDeanAddresses) {
        assert.ok(!addresses.includes(addr), `${addr} must still be absent — the original bug fix (non-genuine comps cut by distance) must still hold`);
      }
      // Inside 1.5 miles but not genuine matches: kept, shown as "not used".
      for (const addr of ['642 Creekmont Court, Ventura, CA 93003', '60 Brentwood Avenue, Ventura, CA 93003']) {
        const kept = result.comps.find(c => c.address === addr);
        assert.ok(kept, `${addr} is inside the chosen 1.5mi rung, so it stays in the list`);
        assert.notEqual(exclusionReason(kept, 4, 'single_family'), null, `${addr} is not a genuine match, so it must show as "not used"`);
      }
      // Beyond 1.5 miles: dropped, genuine or not.
      assert.ok(!addresses.includes('86 College Drive, Ventura, CA 93003'), 'College Dr (1.6mi) is beyond the chosen rung');
      assert.ok(!addresses.includes('3296 San Luis Street, Ventura, CA 93003'), '3296 San Luis (1.96mi) is beyond the chosen rung');
      assert.ok(!addresses.includes('1220 Johnson Drive, Unit 4, Ventura, CA 93003'), '1220 Johnson (1.99mi) is beyond the chosen rung');

      // is_rincon_managed is set downstream of runActiveSources() in the
      // real pipeline (server.js's findBestPropertyMatch(), after this
      // function returns) — applied here on the one comp it's true for,
      // mirroring that real ordering, before computing the range.
      const forRangeCalc = result.comps.map(c =>
        c.address === '555 Skyline Rd, Ventura, CA 93003' ? { ...c, is_rincon_managed: true } : c
      );
      const range = computeRecommendedRange(forRangeCalc, 4, 'single_family');
      // Was 4197.5/4500/5650 with no ladder; the $2.50 difference is only
      // because 3296 San Luis (1.96mi, unknown type, $3,750) is now beyond the
      // rung. Colina Vista and Coolidge survive and the condos are gone, which
      // is what this regression protects.
      assert.deepEqual(range, { low: 4200, mid: 4500, high: 5650 },
        `expected the hand-traced range for analysis 9ab946b1-2c6b-405a-adbd-d8f1c91f31e1 under the ladder, got ${JSON.stringify(range)}`);
    } finally {
      sourcesLib.SOURCE_HANDLERS.RentCast = originalRentCast;
      sourcesLib.SOURCE_HANDLERS.CRMLS = originalCrmls;
    }
  });

  console.log('--- lib/sources.js radius ladder: chooseRadiusRung() / applyCombinedRadiusTiering() ---');

  // Every ladder test below uses this subject unless it says otherwise.
  // lc() builds a genuine single-family comp at a given distance; each gets its
  // own house number so no two ever merge in dedupeComps() unless a test
  // deliberately gives them the same address.
  const ladderSubject = { bedrooms: 3, propertyType: 'single_family' };
  let ladderSeq = 0;
  const lc = (distance_miles, listing_status = 'active', extra = {}) => ({
    address: `${100 + ladderSeq++} Ladder St, Ventura, CA 93003`,
    source_name: 'CRMLS',
    property_type: 'single_family',
    bedrooms: 3,
    monthly_rent: 4000,
    listing_status,
    distance_miles,
    ...extra,
  });

  await check('chooseRadiusRung(): stops at 0.5 with 4 genuine comps (2 leased) inside it; a comp at exactly 0.5 counts, one at 0.51 does not', () => {
    const inside = [lc(0.2, 'leased'), lc(0.3, 'leased'), lc(0.4), lc(0.5)]; // 0.5 exactly counts
    const outside = [lc(0.51), lc(1.2, 'leased')];
    assert.deepEqual(chooseRadiusRung([...inside, ...outside], ladderSubject), { rung: 0.5, genuineCount: 4, leasedCount: 2 });
    const kept = applyCombinedRadiusTiering([...inside, ...outside], ladderSubject);
    assert.equal(kept.length, 4, 'the 0.51 and 1.2 comps are beyond rung 0.5');
    assert.ok(kept.every(c => c.distance_miles <= 0.5));

    // Swap the exactly-0.5 comp for a 0.51 one: only 3 genuine inside 0.5, so
    // the ladder must widen to rung 1 (4 genuine, 2 leased there).
    const swapped = [lc(0.2, 'leased'), lc(0.3, 'leased'), lc(0.4), lc(0.51)];
    assert.equal(chooseRadiusRung(swapped, ladderSubject).rung, 1);
  });

  await check('chooseRadiusRung(): widens 0.5 -> 1 -> 1.5 -> 2 as the counts fail, and stops at the FIRST qualifying rung', () => {
    // Rung 0.5 has 2 genuine (fails). Rung 1 has 4 genuine, 2 leased: stops
    // there even though rungs 1.5 and 2 would qualify too.
    const stopsAt1 = [lc(0.1), lc(0.4), lc(0.6, 'leased'), lc(0.9, 'leased'), lc(1.2, 'leased'), lc(1.8, 'leased')];
    assert.deepEqual(chooseRadiusRung(stopsAt1, ladderSubject), { rung: 1, genuineCount: 4, leasedCount: 2 });
    assert.equal(applyCombinedRadiusTiering(stopsAt1, ladderSubject).length, 4);

    // Rung 1: 4 genuine but only 1 leased (fails). Rung 1.5: 5 genuine, 2 leased.
    const stopsAt15 = [lc(0.1), lc(0.4), lc(0.6, 'leased'), lc(0.9), lc(1.2, 'leased'), lc(1.8)];
    assert.deepEqual(chooseRadiusRung(stopsAt15, ladderSubject), { rung: 1.5, genuineCount: 5, leasedCount: 2 });
    assert.equal(applyCombinedRadiusTiering(stopsAt15, ladderSubject).length, 5);

    // Rung 1.5: 5 genuine but only 1 leased (fails). Rung 2: 6 genuine, 2 leased.
    const stopsAt2 = [lc(0.1), lc(0.4), lc(0.6, 'leased'), lc(0.9), lc(1.2), lc(1.8, 'leased')];
    assert.deepEqual(chooseRadiusRung(stopsAt2, ladderSubject), { rung: 2, genuineCount: 6, leasedCount: 2 });
    assert.equal(applyCombinedRadiusTiering(stopsAt2, ladderSubject).length, 6);
  });

  await check('chooseRadiusRung(): the leased gate — 6 genuine comps inside 0.5 but only 1 leased widens; adding a second lease stops it', () => {
    const sixOneLease = [lc(0.1, 'leased'), lc(0.15), lc(0.2), lc(0.3), lc(0.4), lc(0.45)];
    // Nothing else exists to widen to, so no rung qualifies: the ceiling.
    assert.deepEqual(chooseRadiusRung(sixOneLease, ladderSubject), { rung: WIDE_SEARCH_RADIUS_MILES, genuineCount: 6, leasedCount: 1 });
    // A second lease farther out lets it stop at the first rung that holds both.
    assert.deepEqual(chooseRadiusRung([...sixOneLease, lc(0.8, 'leased')], ladderSubject), { rung: 1, genuineCount: 7, leasedCount: 2 });
    // A second lease inside 0.5 stops it at 0.5.
    const sixTwoLeases = [lc(0.1, 'leased'), lc(0.15, 'leased'), lc(0.2), lc(0.3), lc(0.4), lc(0.45)];
    assert.deepEqual(chooseRadiusRung(sixTwoLeases, ladderSubject), { rung: 0.5, genuineCount: 6, leasedCount: 2 });
  });

  await check('applyCombinedRadiusTiering(): when no rung qualifies it uses the 2mi ceiling and keeps every comp, including ones with no distance', () => {
    const comps = [lc(0.3), lc(0.9, 'leased'), lc(1.4), lc(1.9), lc(null), lc(undefined)];
    const pick = chooseRadiusRung(comps, ladderSubject);
    assert.equal(pick.rung, WIDE_SEARCH_RADIUS_MILES);
    assert.equal(pick.leasedCount, 1);
    assert.equal(applyCombinedRadiusTiering(comps, ladderSubject).length, 6, 'nothing cut, no-distance comps included');

    // Zero numeric distances at all (RentCast failed, CRMLS on its zip fallback): today's behavior, everything kept.
    const noDistances = [lc(null, 'leased'), lc(null, 'leased'), lc(null), lc(null), lc(null)];
    assert.equal(chooseRadiusRung(noDistances, ladderSubject).rung, WIDE_SEARCH_RADIUS_MILES);
    assert.equal(applyCombinedRadiusTiering(noDistances, ladderSubject).length, 5);
  });

  await check('chooseRadiusRung(): dedupes inside the gate — the same address from RentCast (off_market) and CRMLS (leased) counts once, as leased; 4 rows that are really 2 addresses do not qualify', () => {
    const lemurRentCast = lc(0.31, 'off_market', { address: '7560 Lemur St, Ventura, CA 93003', source_name: 'RentCast' });
    const lemurCrmls = lc(0.31, 'leased', { address: '7560 Lemur Street, Ventura, CA 93003', source_name: 'CRMLS' });
    // 5 rows, 4 distinct addresses: two plain comps, one lease, and Lemur
    // (counted once, as leased) -> 4 genuine, 2 leased -> stops at 0.5.
    const withLemur = [lc(0.2), lc(0.3), lc(0.4, 'leased'), lemurRentCast, lemurCrmls];
    assert.deepEqual(chooseRadiusRung(withLemur, ladderSubject), { rung: 0.5, genuineCount: 4, leasedCount: 2 });

    // 4 rows, 2 addresses, each seen by RentCast and CRMLS. Counted by row it
    // would be 4 genuine + 2 leased and stop at 0.5; counted by address it is 2.
    const dupPair = (n, d) => [
      lc(d, 'off_market', { address: `${n} Dup St, Ventura, CA 93003`, source_name: 'RentCast' }),
      lc(d, 'leased', { address: `${n} Dup Street, Ventura, CA 93003`, source_name: 'CRMLS' }),
    ];
    const fourRowsTwoAddresses = [...dupPair(900, 0.2), ...dupPair(902, 0.3)];
    assert.deepEqual(chooseRadiusRung(fourRowsTwoAddresses, ladderSubject), { rung: WIDE_SEARCH_RADIUS_MILES, genuineCount: 2, leasedCount: 2 });
  });

  await check('chooseRadiusRung(): LeadSimple Move-Ins leased comps count toward the leased gate (even when flagged Rincon-managed, via the trusted-source exemption)', () => {
    const leadSimple = (d, extra = {}) => lc(d, 'leased', { source_name: 'LeadSimple Move-Ins', ...extra });
    const comps = [lc(0.2, 'active', { source_name: 'RentCast' }), lc(0.45, 'active', { source_name: 'RentCast' }), leadSimple(0.3), leadSimple(0.4)];
    assert.deepEqual(chooseRadiusRung(comps, ladderSubject), { rung: 0.5, genuineCount: 4, leasedCount: 2 });
    const flagged = [comps[0], comps[1], leadSimple(0.3, { is_rincon_managed: true }), leadSimple(0.4, { is_rincon_managed: true })];
    assert.deepEqual(chooseRadiusRung(flagged, ladderSubject), { rung: 0.5, genuineCount: 4, leasedCount: 2 });
  });

  await check('applyCombinedRadiusTiering(): non-genuine comps inside the rung are kept ("not used"), beyond it dropped; an unknown type counts as genuine; zero comps returns []', () => {
    const comps = [
      lc(0.1, 'leased'), lc(0.2, 'leased'), lc(0.3),
      lc(0.4, 'active', { property_type: null }),                       // unknown type: genuine, the 4th
      lc(0.45, 'leased', { property_type: 'condo' }),                   // wrong type, inside the rung: kept, never counted
      lc(0.9, 'active', { property_type: 'condo' }),                   // wrong type, beyond: dropped
      lc(0.8, 'leased', { bedrooms: 6 }),                              // 3 bedrooms off, beyond: dropped
    ];
    assert.deepEqual(chooseRadiusRung(comps, ladderSubject), { rung: 0.5, genuineCount: 4, leasedCount: 2 });
    const kept = applyCombinedRadiusTiering(comps, ladderSubject);
    assert.equal(kept.length, 5, 'the 4 genuine plus the non-genuine condo inside 0.5');
    assert.ok(kept.some(c => c.property_type === 'condo' && c.distance_miles === 0.45), 'the non-genuine comp inside the rung stays');
    assert.ok(!kept.some(c => c.distance_miles === 0.9 || c.distance_miles === 0.8), 'non-genuine comps beyond the rung are dropped');
    assert.ok(kept.some(c => c.property_type === null), 'the unknown-type comp counted as genuine and is kept');

    assert.deepEqual(applyCombinedRadiusTiering([], ladderSubject), []);
    assert.equal(chooseRadiusRung([], ladderSubject).rung, WIDE_SEARCH_RADIUS_MILES);
  });

  await check('radius ladder constants: ascending, starts at 0.5, ends at WIDE_SEARCH_RADIUS_MILES; the legacy exports still resolve from lib/crmls', () => {
    const constantsLib = require('./lib/constants');
    assert.ok(RADIUS_LADDER_MILES.length >= 2);
    for (let i = 1; i < RADIUS_LADDER_MILES.length; i++) {
      assert.ok(RADIUS_LADDER_MILES[i] > RADIUS_LADDER_MILES[i - 1], 'ladder must be strictly ascending');
    }
    assert.equal(RADIUS_LADDER_MILES[0], 0.5);
    assert.equal(RADIUS_LADDER_MILES[RADIUS_LADDER_MILES.length - 1], WIDE_SEARCH_RADIUS_MILES);
    assert.equal(MIN_LEASED_COMPS_FOR_NARROW_RADIUS, 2);
    // Imported above from lib/crmls, which re-exports the legacy names.
    assert.equal(NARROW_SEARCH_RADIUS_MILES, RADIUS_LADDER_MILES[0]);
    assert.equal(WIDE_SEARCH_RADIUS_MILES, constantsLib.WIDE_SEARCH_RADIUS_MILES);
    assert.equal(MIN_COMPS_FOR_NARROW_RADIUS, 4);
    assert.equal(MIN_COMPS_FOR_NARROW_RADIUS, constantsLib.MIN_COMPS_FOR_NARROW_RADIUS);
  });

  await check('runActiveSources(): Bunting-shaped scenario — the ladder stops at 1 mile, Sora/Partridge/Lemur are in, the 1.07+ mile leases are out, and Lemur collapses to ONE leased row after dedupeComps()', async () => {
    // Distances and statuses are the real Bunting findings from
    // COMP-COVERAGE-SPEC.md; house numbers on Swan St and the rents on
    // 2810 Sherwin / Swan St are illustrative (only distance, status, type
    // and bedrooms drive the result).
    const bunting = { address: '2461 Bunting Avenue, Ventura, CA 93003', propertyType: 'single_family', bedrooms: 4, bathrooms: 2, sqft: 1800 };
    const rc = (address, distance_miles, listing_status, monthly_rent) =>
      ({ address, property_type: 'single_family', bedrooms: 4, distance_miles, listing_status, monthly_rent });
    const rentCastComps = [
      rc('2810 Sherwin Ave, Ventura, CA 93003', 0.26, 'active', 4300),
      rc('6630 Sora St, Ventura, CA 93003', 0.52, 'active', 4195),
      rc('6552 Partridge Dr, Ventura, CA 93003', 0.66, 'off_market', 3995),
      rc('7560 Lemur St, Ventura, CA 93003', 0.81, 'off_market', 3800),
    ];
    const crmlsComps = [
      rc('2500 Swan Street, Ventura, CA 93003', 0.36, 'active', 4250),
      rc('2292 Buffalo Street, Ventura, CA 93003', 0.45, 'leased', 4600),
      rc('6453 Tanager Street, Ventura, CA 93003', 0.59, 'leased', 4500),
      rc('7560 Lemur Street, Ventura, CA 93003', 0.81, 'leased', 3800),
      rc('1203 Nilgai Street, Ventura, CA 93003', 1.07, 'leased', 3000),
      rc('7275 Coolidge Street, Ventura, CA 93003', 1.93, 'leased', 4195),
      rc('9026 Feather Street, Ventura, CA 93003', 1.98, 'leased', 3700),
      { address: '2974 Sherwin Avenue, Ventura, CA 93003', property_type: 'duplex', bedrooms: 2, distance_miles: 0.38, listing_status: 'leased', monthly_rent: 2400 },
    ];

    // Hand-trace: rung 0.5 -> 2810 Sherwin, Swan, Buffalo = 3 genuine, 1 leased: fails.
    // Rung 1 adds Sora, Partridge, Tanager and the two Lemur copies, which are
    // ONE address -> 7 genuine, and 3 leased (Buffalo, Tanager, Lemur as leased).
    assert.deepEqual(chooseRadiusRung([...rentCastComps, ...crmlsComps], bunting), { rung: 1, genuineCount: 7, leasedCount: 3 });

    const originalRentCast = sourcesLib.SOURCE_HANDLERS.RentCast;
    const originalCrmls = sourcesLib.SOURCE_HANDLERS.CRMLS;
    sourcesLib.SOURCE_HANDLERS.RentCast = async () => ({ comps: rentCastComps });
    sourcesLib.SOURCE_HANDLERS.CRMLS = async () => ({ comps: crmlsComps });
    try {
      const result = await runActiveSources([{ id: 'src-rc', name: 'RentCast' }, { id: 'src-crmls', name: 'CRMLS' }], bunting);
      const addresses = result.comps.map(c => c.address);
      for (const wanted of ['6630 Sora St', '6552 Partridge Dr', '7560 Lemur St', '7560 Lemur Street']) {
        assert.ok(addresses.some(a => a.startsWith(wanted)), `${wanted} must be present`);
      }
      for (const dropped of ['1203 Nilgai', '7275 Coolidge', '9026 Feather']) {
        assert.ok(!addresses.some(a => a.startsWith(dropped)), `${dropped} is beyond rung 1 and must be dropped`);
      }
      assert.ok(addresses.some(a => a.startsWith('2974 Sherwin')), 'the duplex is inside the rung (non-genuine), so it stays and shows as "not used"');
      assert.equal(result.comps.length, 9, '12 comps minus the 3 beyond 1 mile');

      // The later server.js/router.js step: one row per real address.
      const deduped = dedupeComps(result.comps, bunting.bedrooms, bunting.propertyType);
      const lemurRows = deduped.filter(c => c.address.startsWith('7560 Lemur'));
      assert.equal(lemurRows.length, 1, 'Lemur must be ONE row after dedupeComps()');
      assert.equal(lemurRows[0].listing_status, 'leased', 'the CRMLS leased copy beats the RentCast off_market copy');
      assert.equal(lemurRows[0].source_name, 'CRMLS');
      assert.equal(deduped.length, 8);
    } finally {
      sourcesLib.SOURCE_HANDLERS.RentCast = originalRentCast;
      sourcesLib.SOURCE_HANDLERS.CRMLS = originalCrmls;
    }
  });

  console.log('--- lib/rentcast.js pullRentCastComps() subjectZip ---');

  await check('pullRentCastComps() reads subjectZip from subjectProperty.zipCode', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.RENTCAST_API_KEY;
    process.env.RENTCAST_API_KEY = 'test-key';
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        rent: 4200,
        subjectProperty: { state: 'CA', city: 'Newbury Park', zipCode: '91320' },
        comparables: [],
      }),
    });
    try {
      const result = await pullRentCastComps({ address: '456 Oak Ave, Newbury Park, CA', propertyType: 'single_family', bedrooms: 3, bathrooms: 2, sqft: 1450 });
      assert.equal(result.subjectZip, '91320');
    } finally {
      global.fetch = originalFetch;
      process.env.RENTCAST_API_KEY = originalKey;
    }
  });

  await check('pullRentCastComps() leaves subjectZip null when subjectProperty omits zipCode, rather than guessing', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.RENTCAST_API_KEY;
    process.env.RENTCAST_API_KEY = 'test-key';
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ rent: 4200, subjectProperty: { state: 'CA', city: 'Newbury Park' }, comparables: [] }),
    });
    try {
      const result = await pullRentCastComps({ address: '456 Oak Ave, Newbury Park, CA', propertyType: 'single_family', bedrooms: 3, bathrooms: 2, sqft: 1450 });
      assert.equal(result.subjectZip, null);
    } finally {
      global.fetch = originalFetch;
      process.env.RENTCAST_API_KEY = originalKey;
    }
  });

  console.log('--- lib/rentcast.js full listings search (COMP-COVERAGE-SPEC.md) ---');

  // Bunting is the real subject behind this build. The listing coordinates
  // below are placed at a chosen distance due north of it, so the expected
  // distance is known without inventing real street coordinates.
  const buntingSubject = { address: '2461 Bunting Avenue, Ventura, CA 93003', propertyType: 'single_family', bedrooms: 4, bathrooms: 2, sqft: 1800 };
  const buntingLat = 34.252446, buntingLon = -119.200606;
  const northOf = miles => buntingLat + miles / 69.0;
  // Top-level latitude/longitude are deliberate decoys: the listings request
  // must use subjectProperty's coordinates.
  const avmBody = (comparables = [], subjectProperty = { state: 'CA', city: 'Ventura', zipCode: '93003', latitude: buntingLat, longitude: buntingLon }) =>
    ({ rent: 4350, latitude: 99.9, longitude: -99.9, subjectProperty, comparables });
  const rcListing = (over = {}) => ({
    formattedAddress: '6630 Sora St, Ventura, CA 93003', propertyType: 'Single Family', bedrooms: 4, bathrooms: 2, squareFootage: 1800,
    status: 'Active', price: 4195, listedDate: '2026-10-02T00:00:00.000Z', removedDate: null,
    latitude: northOf(0.52), longitude: buntingLon, ...over,
  });
  // Runs fn with global.fetch and the API key swapped in, restoring both.
  const withRentCastMock = async (mock, fn) => {
    const originalFetch = global.fetch;
    const originalKey = process.env.RENTCAST_API_KEY;
    process.env.RENTCAST_API_KEY = 'test-key';
    global.fetch = mock.fn;
    try {
      return await fn();
    } finally {
      global.fetch = originalFetch;
      process.env.RENTCAST_API_KEY = originalKey;
    }
  };

  await check('pullRentCastComps() makes exactly 2 fetches — the AVM first, then the listings search — and never puts the API key in a URL (budget guard)', async () => {
    const mock = mockRentCastFetch({ avm: okJson(avmBody()), listings: okJson([rcListing()]) });
    const result = await withRentCastMock(mock, () => pullRentCastComps(buntingSubject));
    assert.equal(mock.calls.length, 2, 'one AVM request plus one listings request, nothing else');
    assert.ok(mock.calls[0].url.includes('/avm/rent/long-term'), 'AVM first');
    assert.ok(mock.calls[1].url.includes('/listings/rental/long-term'), 'listings second');
    assert.equal(mock.calls[1].headers['X-Api-Key'], 'test-key', 'the key goes in the header, same as the AVM call');
    assert.ok(!mock.calls.some(c => c.url.includes('test-key')), 'the key must never appear in a URL');
    assert.equal(result.comps.length, 1);
    assert.equal(result.subjectEstimatedRent, 4350, 'the AVM call is unchanged: subject rent estimate still comes from it');
  });

  await check('pullRentCastComps() listings request carries exactly the documented params (lat/lon from subjectProperty, radius 2, Active|Inactive, propertyType, bedrooms range from the mismatch threshold, daysOld 180, limit 500, includeTotalCount)', async () => {
    const listingsUrlFor = async subject => {
      const mock = mockRentCastFetch({ avm: okJson(avmBody()), listings: okJson([]) });
      await withRentCastMock(mock, () => pullRentCastComps(subject));
      return mock.calls[1].url;
    };

    const fourBed = await listingsUrlFor(buntingSubject);
    assert.equal(new URL(fourBed).pathname, '/v1/listings/rental/long-term');
    assert.deepEqual(Object.fromEntries(new URL(fourBed).searchParams), {
      latitude: String(buntingLat),
      longitude: String(buntingLon),
      radius: String(WIDE_SEARCH_RADIUS_MILES),
      status: 'Active|Inactive',
      propertyType: 'Single Family',
      bedrooms: '3:5',
      daysOld: '180',
      limit: '500',
      includeTotalCount: 'true',
    });
    assert.ok(fourBed.includes('status=Active%7CInactive'), 'the pipe is URL-encoded by URLSearchParams');
    assert.equal(LISTINGS_DAYS_OLD, 180);
    assert.equal(LISTINGS_LIMIT, 500);

    const studio = new URL(await listingsUrlFor({ ...buntingSubject, propertyType: 'apartment', bedrooms: 0 })).searchParams;
    assert.equal(studio.get('bedrooms'), '0:1', 'a studio never produces a negative lower bound');
    assert.equal(studio.get('propertyType'), 'Apartment');

    const twoBed = new URL(await listingsUrlFor({ ...buntingSubject, bedrooms: 2 })).searchParams;
    assert.equal(twoBed.get('bedrooms'), '1:3');

    const other = new URL(await listingsUrlFor({ ...buntingSubject, propertyType: 'other' })).searchParams;
    assert.equal(other.has('propertyType'), false, 'an unmapped subject type sends no propertyType filter');
    assert.equal(other.get('bedrooms'), '3:5');
  });

  await check('mapListing(): Active -> active, Inactive -> off_market (never leased); price, date-only removedDate, and a computed haversine distance (6630 Sora St is ~0.52 mi from Bunting); no coordinates -> null distance', () => {
    const active = mapListing(rcListing(), buntingLat, buntingLon);
    assert.equal(active.listing_status, 'active');
    assert.equal(active.monthly_rent, 4195);
    assert.equal(active.property_type, 'single_family');
    assert.equal(active.is_estimated_price, false);
    assert.equal(active.listed_date, '2026-10-02');
    assert.equal(active.distance_miles, haversineMiles(buntingLat, buntingLon, rcListing().latitude, rcListing().longitude), 'distance is exactly the haversine of the two points');
    assert.ok(Math.abs(active.distance_miles - 0.52) < 0.01, `expected ~0.52 mi, got ${active.distance_miles}`);

    const inactive = mapListing(rcListing({ formattedAddress: '6552 Partridge Dr, Ventura, CA 93003', status: 'Inactive', price: 3995, removedDate: '2026-09-27T00:00:00.000Z', latitude: northOf(0.66) }), buntingLat, buntingLon);
    assert.equal(inactive.listing_status, 'off_market');
    assert.notEqual(inactive.listing_status, 'leased');
    assert.equal(inactive.monthly_rent, 3995);
    assert.equal(inactive.leased_date, '2026-09-27', 'removedDate is kept date-only');
    assert.ok(Math.abs(inactive.distance_miles - 0.66) < 0.01);

    for (const status of ['Inactive', 'Pending', undefined, 'anything else']) {
      assert.notEqual(mapListing(rcListing({ status }), buntingLat, buntingLon).listing_status, 'leased', `status ${status} must never map to leased`);
    }

    const noCoords = mapListing(rcListing({ latitude: undefined, longitude: undefined }), buntingLat, buntingLon);
    assert.equal(noCoords.distance_miles, null, 'no listing coordinates -> null distance, never guessed');
    assert.equal(noCoords.latitude, null);
    assert.equal(noCoords.longitude, null);
  });

  await check('pullRentCastListings() drops a listing with no numeric price, one over 2 mi away, and the subject\'s own address; keeps one with no coordinates (null distance)', async () => {
    const rows = [
      rcListing(), // 6630 Sora St: kept
      rcListing({ formattedAddress: '6552 Partridge Dr, Ventura, CA 93003', status: 'Inactive', price: 3995, latitude: northOf(0.66) }), // kept
      rcListing({ formattedAddress: '11 No Price Ln, Ventura, CA 93003', price: undefined }),
      rcListing({ formattedAddress: '12 Text Price Ln, Ventura, CA 93003', price: '3500' }),
      rcListing({ formattedAddress: '13 Far Away Rd, Ventura, CA 93003', latitude: northOf(2.5) }),
      rcListing({ formattedAddress: '2461 Bunting Ave, Ventura, CA 93003', latitude: northOf(0) }), // the subject itself, written a different way
      rcListing({ formattedAddress: '14 No Coords Ct, Ventura, CA 93003', latitude: undefined, longitude: undefined }), // kept
    ];
    const mock = mockRentCastFetch({ avm: okJson(avmBody()), listings: okJson(rows) });
    const comps = await withRentCastMock(mock, () => pullRentCastListings(buntingSubject, buntingLat, buntingLon));
    assert.deepEqual(comps.map(c => c.address), [
      '6630 Sora St, Ventura, CA 93003',
      '6552 Partridge Dr, Ventura, CA 93003',
      '14 No Coords Ct, Ventura, CA 93003',
    ]);
    assert.equal(comps[2].distance_miles, null);
  });

  // ── Inactive cap: every Active listing is kept, only the 10 nearest Inactive. ──
  const inactiveRow = (i, miles, over = {}) => rcListing({ formattedAddress: `${100 + i} Inactive Ln, Ventura, CA 93003`, status: 'Inactive', price: 3600 + i, latitude: northOf(miles), ...over });
  const activeRow = (i, miles, over = {}) => rcListing({ formattedAddress: `${200 + i} Active Ct, Ventura, CA 93003`, status: 'Active', price: 4200 + i, latitude: northOf(miles), ...over });
  const runListings = async rows => {
    const mock = mockRentCastFetch({ avm: okJson(avmBody()), listings: okJson(rows) });
    return withRentCastMock(mock, () => pullRentCastListings(buntingSubject, buntingLat, buntingLon));
  };
  // 25 Inactive at 25 distinct distances in a scrambled order (rank = (i*11)%25, so the nearest 10 are NOT the first 10 sent)
  const scrambledInactive = Array.from({ length: 25 }, (_, i) => inactiveRow(i, 0.05 + ((i * 11) % 25) * 0.07));
  const spreadActive = Array.from({ length: 12 }, (_, i) => activeRow(i, 0.1 + i * 0.15)); // out to 1.75 mi, farther than most kept Inactive

  await check('LISTINGS_MAX_INACTIVE is exported and is 10', () => {
    assert.equal(LISTINGS_MAX_INACTIVE, 10);
  });

  await check('pullRentCastListings() with 25 Inactive + 12 Active returns all 12 Active plus exactly the 10 nearest Inactive, and the survivors keep the order RentCast sent them', async () => {
    const rows = [...scrambledInactive.slice(0, 13), ...spreadActive, ...scrambledInactive.slice(13)]; // interleaved on purpose
    const comps = await runListings(rows);
    assert.equal(comps.length, 22);
    const active = comps.filter(c => c.listing_status === 'active');
    const inactive = comps.filter(c => c.listing_status !== 'active');
    assert.equal(active.length, 12, 'every Active listing is kept, even the farthest');
    assert.equal(inactive.length, 10);
    // Reference: rank all 25 Inactive by the computed distance, independent of the implementation.
    const ranked = scrambledInactive.map(r => mapListing(r, buntingLat, buntingLon)).sort((a, b) => a.distance_miles - b.distance_miles);
    const expected10 = new Set(ranked.slice(0, 10).map(c => c.address));
    assert.deepEqual(new Set(inactive.map(c => c.address)), expected10, 'the 10 kept Inactive are the 10 nearest');
    assert.ok(Math.max(...inactive.map(c => c.distance_miles)) < ranked[10].distance_miles, 'every dropped Inactive is farther than every kept one');
    assert.deepEqual(comps.map(c => c.address), rows.map(r => r.formattedAddress).filter(a => expected10.has(a) || a.includes('Active Ct')), 'survivors are in the order RentCast sent them');
  });

  await check('pullRentCastComps() with 25 Inactive + 12 Active still makes exactly 2 fetches (the cap is not a second request) and the AVM comps are untouched by it', async () => {
    const avmComps = Array.from({ length: 12 }, (_, i) => ({ formattedAddress: `${300 + i} Avm Way, Ventura, CA 93003`, propertyType: 'Single Family', state: 'CA', distance: 0.3 + i * 0.1, bedrooms: 4, price: 4000 + i, status: 'Inactive' }));
    const mock = mockRentCastFetch({ avm: okJson(avmBody(avmComps)), listings: okJson([...scrambledInactive, ...spreadActive]) });
    const result = await withRentCastMock(mock, () => pullRentCastComps(buntingSubject));
    assert.equal(mock.calls.length, 2);
    assert.equal(result.comps.length, 12 + 22, 'all 12 AVM comps (even though Inactive) + 12 Active + 10 Inactive');
    assert.equal(result.comps.filter(c => c.address.includes('Avm Way')).length, 12, 'the cap never touches the AVM comps');
  });

  await check('Inactive cap: a listing with no coordinates (null distance) ranks last, so it is dropped when 10 nearer Inactive exist, kept when it is among the closest 10, and ties keep RentCast\'s order', async () => {
    const noCoords = i => inactiveRow(i, 0, { latitude: undefined, longitude: undefined });
    const nearTen = Array.from({ length: 10 }, (_, i) => inactiveRow(i, 0.3 + i * 0.1));
    const dropped = await runListings([noCoords(50), noCoords(51), ...nearTen]);
    assert.equal(dropped.length, 10);
    assert.ok(dropped.every(c => c.distance_miles !== null), 'both null-distance rows were dropped although sent first');

    const kept = await runListings([noCoords(50), ...nearTen.slice(0, 7)]);
    assert.equal(kept.length, 8, 'fewer than 10 Inactive: the null-distance one is kept too');
    assert.equal(kept[0].distance_miles, null);

    const mixed = await runListings([noCoords(50), noCoords(51), noCoords(52), ...nearTen.slice(0, 9)]);
    assert.equal(mixed.length, 10);
    assert.deepEqual(mixed.filter(c => c.distance_miles === null).map(c => c.address), ['150 Inactive Ln, Ventura, CA 93003'], '9 with a distance + the FIRST null-distance row sent');

    const tied = await runListings(Array.from({ length: 12 }, (_, i) => inactiveRow(i, 0.5)));
    assert.deepEqual(tied.map(c => c.address), Array.from({ length: 10 }, (_, i) => `${100 + i} Inactive Ln, Ventura, CA 93003`), 'equal distance: the first 10 sent');
  });

  await check('Inactive cap: fewer than 10 Inactive -> all kept; Active is never capped (40 Active with 0 Inactive, and 40 Active with 25 Inactive)', async () => {
    const seven = await runListings([...scrambledInactive.slice(0, 7), ...spreadActive.slice(0, 3)]);
    assert.equal(seven.length, 10);
    assert.equal(seven.filter(c => c.listing_status !== 'active').length, 7, 'all 7 Inactive kept');

    const exactlyTen = await runListings(scrambledInactive.slice(0, 10));
    assert.equal(exactlyTen.length, 10);

    const forty = Array.from({ length: 40 }, (_, i) => activeRow(i, 0.05 + i * 0.045));
    assert.equal((await runListings(forty)).length, 40, 'Active only: nothing capped');
    assert.equal((await runListings([...forty, ...scrambledInactive])).length, 50, '40 Active + the 10 nearest of 25 Inactive');
  });

  await check('Inactive cap is applied AFTER the row filters: an Inactive listing with no price, over 2 mi, or the subject\'s own address never takes one of the 10 slots', async () => {
    const invalidNearest = [
      inactiveRow(60, 0, { formattedAddress: '2461 Bunting Ave, Ventura, CA 93003' }), // the subject itself, distance 0
      inactiveRow(61, 0.01, { price: 0 }),
      inactiveRow(62, 0.02, { price: undefined }),
      inactiveRow(63, 2.5), inactiveRow(64, 3.1),
    ];
    const valid = Array.from({ length: 12 }, (_, i) => inactiveRow(i, 0.4 + i * 0.1));
    const comps = await runListings([...invalidNearest, ...valid]);
    assert.equal(comps.length, 10, 'ten valid Inactive rows, none of the five invalid ones');
    assert.ok(comps.every(c => /^1\d\d Inactive Ln/.test(c.address) && Number(c.address.split(' ')[0]) < 110), 'the 10 nearest VALID rows (addresses 100-109)');
    assert.ok(comps.every(c => c.monthly_rent > 0 && c.distance_miles <= 2));
  });

  await check('Inactive cap: a kept Inactive listing still maps to off_market and is never leased, and the cap changes nothing about the request (same single call, same params)', async () => {
    const mock = mockRentCastFetch({ avm: okJson(avmBody()), listings: okJson([...scrambledInactive, ...spreadActive]) });
    const comps = await withRentCastMock(mock, () => pullRentCastListings(buntingSubject, buntingLat, buntingLon));
    assert.equal(mock.calls.length, 1, 'pullRentCastListings() is one request');
    assert.ok(comps.every(c => c.listing_status === 'active' || c.listing_status === 'off_market'));
    assert.ok(!comps.some(c => c.listing_status === 'leased'), 'RentCast Inactive is never leased');
    assert.equal(comps.filter(c => c.listing_status === 'off_market').length, 10);
    const params = new URL(mock.calls[0].url).searchParams;
    assert.equal(params.get('status'), 'Active|Inactive');
    assert.equal(params.get('limit'), String(LISTINGS_LIMIT));
    assert.equal(params.get('daysOld'), String(LISTINGS_DAYS_OLD));
  });

  await check('pullRentCastComps() never lets the listings call fail an analysis: a 500, a 429, a network error, bad JSON, or a non-array body each return the AVM comps and warn', async () => {
    const avmComp = { formattedAddress: '555 Skyline Rd, Ventura, CA 93003', propertyType: 'Single Family', state: 'CA', distance: 0.19, bedrooms: 4, price: 4395, status: 'Inactive' };
    const failures = {
      'HTTP 500': () => ({ ok: false, status: 500, statusText: 'Server Error', json: async () => ({}), text: async () => 'boom' }),
      'HTTP 429': () => ({ ok: false, status: 429, statusText: 'Too Many Requests', json: async () => ({}), text: async () => 'limit' }),
      'network error': () => { throw new Error('ECONNRESET'); },
      'bad JSON': () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } }),
      'non-array body': () => okJson({ message: 'not a list' }),
    };
    for (const [label, listings] of Object.entries(failures)) {
      const mock = mockRentCastFetch({ avm: okJson(avmBody([avmComp])), listings });
      await withCapturedWarnings(async warnings => {
        const result = await withRentCastMock(mock, () => pullRentCastComps(buntingSubject));
        assert.equal(result.comps.length, 1, `${label}: the AVM comp must still come back`);
        assert.equal(result.comps[0].address, '555 Skyline Rd, Ventura, CA 93003');
        assert.equal(result.subjectEstimatedRent, 4350, `${label}: the subject rent estimate must be unaffected`);
        assert.equal(mock.calls.length, 2, `${label}: no retry, no pagination`);
        assert.equal(warnings.length, 1, `${label}: exactly one warning line, got ${JSON.stringify(warnings)}`);
        assert.ok(!warnings[0].includes('test-key'), 'a warning must never contain the API key');
      });
    }
  });

  await check('pullRentCastComps(): a failed AVM call throws having made only 1 fetch (no listings call); an AVM response with no coordinates makes no listings call either', async () => {
    const failedAvm = mockRentCastFetch({
      avm: { ok: false, status: 500, statusText: 'Server Error', text: async () => 'boom' },
      listings: okJson([rcListing()]),
    });
    await assert.rejects(() => withRentCastMock(failedAvm, () => pullRentCastComps(buntingSubject)), /RentCast API request failed \(500\)/);
    assert.equal(failedAvm.calls.length, 1, 'a failed AVM costs exactly one request');

    const noCoords = mockRentCastFetch({ avm: okJson({ rent: 4350, subjectProperty: { state: 'CA', city: 'Ventura' }, comparables: [] }), listings: okJson([rcListing()]) });
    const result = await withRentCastMock(noCoords, () => pullRentCastComps(buntingSubject));
    assert.equal(noCoords.calls.length, 1, 'no coordinates -> no listings request');
    assert.deepEqual(result.comps, []);
  });

  await check('pullRentCastListings() warns once when x-total-count says more matches exist than were returned, and stays silent when the counts agree or the response has no headers', async () => {
    const rows = [rcListing(), rcListing({ formattedAddress: '6552 Partridge Dr, Ventura, CA 93003', latitude: northOf(0.66) })];
    const run = async listingsResponse => {
      const mock = mockRentCastFetch({ avm: okJson(avmBody()), listings: listingsResponse });
      return withCapturedWarnings(async warnings => {
        const comps = await withRentCastMock(mock, () => pullRentCastListings(buntingSubject, buntingLat, buntingLon));
        return { comps, warnings };
      });
    };
    const truncated = await run(okJson(rows, { 'x-total-count': '1334' }));
    assert.equal(truncated.comps.length, 2, 'the rows that did come back are still used');
    assert.equal(truncated.warnings.length, 1);
    assert.match(truncated.warnings[0], /truncated/);

    assert.equal((await run(okJson(rows, { 'x-total-count': '2' }))).warnings.length, 0, 'counts agree');
    assert.equal((await run(okJson(rows))).warnings.length, 0, 'plain mocks with no headers object must not throw or warn');
  });

  await check('an AVM comp and a listings-search listing for the same address collapse to ONE comp through dedupeComps(), and the AVM copy (seen first) wins a full tie', async () => {
    const avmComp = { formattedAddress: '7560 Lemur St, Ventura, CA 93003', propertyType: 'Single Family', state: 'CA', distance: 0.81, bedrooms: 4, price: 3800, status: 'Inactive', listedDate: '2026-07-01T00:00:00.000Z' };
    const listing = rcListing({ formattedAddress: '7560 Lemur St, Ventura, CA 93003', status: 'Inactive', price: 3800, listedDate: '2026-07-02T00:00:00.000Z', latitude: northOf(0.81) });
    const mock = mockRentCastFetch({ avm: okJson(avmBody([avmComp])), listings: okJson([listing]) });
    const result = await withRentCastMock(mock, () => pullRentCastComps(buntingSubject));
    assert.equal(result.comps.length, 2, 'both copies come back from RentCast');
    assert.equal(result.comps[0].listed_date, '2026-07-01', 'AVM comps are listed first');
    const deduped = dedupeComps(result.comps, 4, 'single_family');
    assert.equal(deduped.length, 1, 'same address -> one comp');
    assert.equal(deduped[0].listed_date, '2026-07-01', 'first seen (the AVM copy) wins a full tie');
  });

  console.log('--- lib/sources.js subjectZip passthrough ---');

  await check('runActiveSources() surfaces a handler\'s subjectZip through to the caller', async () => {
    const originalRentCast = sourcesLib.SOURCE_HANDLERS.RentCast;
    sourcesLib.SOURCE_HANDLERS.RentCast = async () => ({
      subjectZip: '91320',
      comps: [{ monthly_rent: 4200, listing_status: 'active' }],
    });
    try {
      const result = await runActiveSources(
        [{ id: 'src-5', name: 'RentCast' }],
        { address: '1 Test St', propertyType: 'single_family', bedrooms: 2, bathrooms: 1, sqft: 900 }
      );
      assert.equal(result.subjectZip, '91320');
    } finally {
      sourcesLib.SOURCE_HANDLERS.RentCast = originalRentCast;
    }
  });

  console.log('--- lib/crmls.js radius search (box math, Haversine, $filter) ---');

  await check('haversineMiles() returns 0 for identical points and the exact closed-form great-circle distance for two points 1 degree of latitude apart (same longitude)', () => {
    assert.equal(haversineMiles(34.179615, -119.198962, 34.179615, -119.198962), 0);
    // With longitude unchanged, the Haversine formula collapses to exactly
    // R * dLat(radians) — a closed form, not a hand-typed guess, so this
    // can be checked to a tight tolerance.
    const oneDegreeLatMiles = 3958.8 * (Math.PI / 180);
    const computed = haversineMiles(34.0, -118.0, 35.0, -118.0);
    assert.ok(Math.abs(computed - oneDegreeLatMiles) < 0.01, `expected ~${oneDegreeLatMiles.toFixed(3)} mi, got ${computed}`);
  });

  await check('buildBoundingBox() matches the documented lat/long delta formula, and its corner sits farther from center than its edge (why pullCrmlsComps() post-filters to a true circle)', () => {
    const lat = 34.179615, lon = -119.198962, radius = WIDE_SEARCH_RADIUS_MILES;
    const box = buildBoundingBox(lat, lon, radius);
    const latDelta = radius / 69.0;
    const lonDelta = radius / (69.0 * Math.cos(lat * Math.PI / 180));
    assert.ok(Math.abs(box.maxLat - (lat + latDelta)) < 1e-9);
    assert.ok(Math.abs(box.minLat - (lat - latDelta)) < 1e-9);
    assert.ok(Math.abs(box.maxLon - (lon + lonDelta)) < 1e-9);
    assert.ok(Math.abs(box.minLon - (lon - lonDelta)) < 1e-9);

    const edgeDistance = haversineMiles(lat, lon, box.maxLat, lon);
    assert.ok(Math.abs(edgeDistance - radius) < 0.01, `expected the box's edge to sit ~${radius} mi out, got ${edgeDistance}`);
    const cornerDistance = haversineMiles(lat, lon, box.maxLat, box.maxLon);
    assert.ok(cornerDistance > radius, `expected the box's corner (${cornerDistance.toFixed(3)} mi) to be farther than the radius (${radius} mi) — this is exactly why a box alone isn't a true radius search`);
  });

  await check('buildFilter() builds a lat/long $filter for a box scope, and the exact previous PostalCode $filter for a zip scope', () => {
    const boxFilter = buildCrmlsFilter('Active', { type: 'box', minLat: 34.1, maxLat: 34.2, minLon: -119.3, maxLon: -119.1 });
    assert.equal(boxFilter, "StandardStatus eq 'Active' and PropertyType eq 'Residential Lease' and Latitude ge 34.1 and Latitude le 34.2 and Longitude ge -119.3 and Longitude le -119.1");
    const zipFilter = buildCrmlsFilter('Closed', { type: 'zip', zip: '91320' });
    assert.equal(zipFilter, "StandardStatus eq 'Closed' and PropertyType eq 'Residential Lease' and PostalCode eq '91320'");
  });

  await check('mapCrmlsComparable() defaults distance_miles to null with no argument, and passes through a real computed value when one is given', () => {
    const record = {
      StandardStatus: 'Active', PropertySubType: 'Single Family Residence',
      StreetNumberNumeric: 123, StreetName: 'Main', StreetSuffix: 'St',
      City: 'Newbury Park', StateOrProvince: 'CA', PostalCode: '91320',
      ListPrice: 4200, Latitude: 34.18, Longitude: -119.2,
    };
    assert.equal(mapCrmlsComparable(record).distance_miles, null);
    assert.equal(mapCrmlsComparable(record, 1.23).distance_miles, 1.23);
  });

  await check('pullCrmlsComps() runs a lat/long bounding-box search (not PostalCode) when subject coordinates are present, and post-filters to a true circle — drops a box-corner record beyond WIDE_SEARCH_RADIUS_MILES, keeps a near one with a real nonzero distance_miles', async () => {
    const originalFetch = global.fetch;
    const originalToken = process.env.RECORE_SERVER_TOKEN;
    process.env.RECORE_SERVER_TOKEN = 'test-token';

    const subjectLat = 34.179615, subjectLon = -119.198962;
    const box = buildBoundingBox(subjectLat, subjectLon, WIDE_SEARCH_RADIUS_MILES);
    const baseFields = {
      StandardStatus: 'Closed', PropertySubType: 'Single Family Residence',
      StreetSuffix: 'St', City: 'Newbury Park', StateOrProvince: 'CA', PostalCode: '91320', ClosePrice: 4300,
    };
    // Just inside the box, close to center (well within the NARROW 1-mile
    // radius too, but only 1 comp total -> below MIN_COMPS_FOR_NARROW_RADIUS,
    // so tiering keeps the full set either way — see the tiering-specific
    // checks below for cases where the narrow/wide choice actually differs).
    // Must survive the circle filter with a real distance_miles.
    const nearRecord = { ...baseFields, StreetNumberNumeric: 100, StreetName: 'Near', Latitude: subjectLat + 0.001, Longitude: subjectLon };
    // Sits exactly at the box's own corner — inside the box's lat/lon range,
    // but per the "corners are farther than edges" math above, actually
    // outside a true WIDE_SEARCH_RADIUS_MILES circle — must be dropped.
    const cornerRecord = { ...baseFields, StreetNumberNumeric: 200, StreetName: 'Corner', Latitude: box.maxLat, Longitude: box.maxLon };

    const requestedUrls = [];
    global.fetch = async (url) => {
      const u = String(url);
      requestedUrls.push(u);
      // Only the Active query ($orderby=OnMarketDate desc) returns fixtures,
      // so records aren't double-counted across the Closed+Active queries
      // this function always issues. Checked via the $orderby param
      // specifically — $select always lists both CloseDate and OnMarketDate
      // as column names, so a whole-URL substring check would false-match.
      const records = new URL(u).searchParams.get('$orderby') === 'OnMarketDate desc' ? [nearRecord, cornerRecord] : [];
      return { ok: true, json: async () => ({ value: records }) };
    };
    try {
      const result = await pullCrmlsComps({ address: '1895 Dorrit St, Newbury Park, CA 91320', latitude: subjectLat, longitude: subjectLon });

      // SELECT_FIELDS always lists PostalCode/Latitude/Longitude as selected
      // columns, so checking the raw URL would false-positive on $select —
      // decode the actual $filter param instead.
      const filters = requestedUrls.map(u => new URL(u).searchParams.get('$filter'));
      assert.ok(filters.every(f => f.includes('Latitude ge') && f.includes('Longitude ge')), 'expected a lat/long bounding-box $filter');
      assert.ok(filters.every(f => !f.includes('PostalCode')), 'must not fall back to PostalCode when coordinates are present');

      assert.equal(result.comps.length, 1, 'the box-corner record must be dropped by the true-circle post-filter');
      assert.ok(result.comps[0].address.startsWith('100 Near St'), 'the surviving comp must be the near record, not the corner one');
      assert.ok(typeof result.comps[0].distance_miles === 'number' && result.comps[0].distance_miles > 0 && result.comps[0].distance_miles <= WIDE_SEARCH_RADIUS_MILES,
        `expected a real, nonzero distance_miles <= ${WIDE_SEARCH_RADIUS_MILES}, got ${result.comps[0].distance_miles}`);
    } finally {
      global.fetch = originalFetch;
      process.env.RECORE_SERVER_TOKEN = originalToken;
    }
  });

  await check('pullCrmlsComps() falls back to the exact previous PostalCode-only $filter, with distance_miles left null, when subject.latitude/subject.longitude are not provided (graceful degradation, e.g. RentCast inactive or failed)', async () => {
    const originalFetch = global.fetch;
    const originalToken = process.env.RECORE_SERVER_TOKEN;
    process.env.RECORE_SERVER_TOKEN = 'test-token';

    const record = {
      StandardStatus: 'Active', PropertySubType: 'Condominium',
      StreetNumberNumeric: 300, StreetName: 'Fallback', StreetSuffix: 'Ave',
      City: 'Newbury Park', StateOrProvince: 'CA', PostalCode: '91320',
      ListPrice: 3900, Latitude: 34.2, Longitude: -119.21, // has coordinates of its own — must still be ignored on this path
    };
    const requestedUrls = [];
    global.fetch = async (url) => {
      const u = String(url);
      requestedUrls.push(u);
      const records = new URL(u).searchParams.get('$orderby') === 'OnMarketDate desc' ? [record] : [];
      return { ok: true, json: async () => ({ value: records }) };
    };
    try {
      const result = await pullCrmlsComps({ address: '1895 Dorrit St, Newbury Park, CA 91320' }); // no latitude/longitude
      const filters = requestedUrls.map(u => new URL(u).searchParams.get('$filter'));
      assert.ok(filters.every(f => f.includes("PostalCode eq '91320'")), 'expected the zip-only $filter, no coordinates supplied');
      assert.ok(filters.every(f => !f.includes('Latitude ge')), 'must not attempt a box search without real subject coordinates');
      assert.equal(result.comps.length, 1);
      assert.equal(result.comps[0].distance_miles, null, 'distance_miles must stay null on the zip-fallback path, even though this record has its own lat/long');
      assert.equal(result.subjectZip, '91320');
    } finally {
      global.fetch = originalFetch;
      process.env.RECORE_SERVER_TOKEN = originalToken;
    }
  });

  console.log('--- lib/crmls.js radius search always returns the full <=2mi set (narrow/wide decision moved to lib/sources.js) ---');

  await check('pullCrmlsComps() always returns the full box-search set out to <=2mi, real distance_miles on each, even when enough of them are within 1 mile (the narrow cut no longer happens here)', async () => {
    const originalFetch = global.fetch;
    const originalToken = process.env.RECORE_SERVER_TOKEN;
    process.env.RECORE_SERVER_TOKEN = 'test-token';

    const subjectLat = 34.179615, subjectLon = -119.198962;
    const baseFields = {
      StandardStatus: 'Active', PropertySubType: 'Single Family Residence',
      StreetSuffix: 'St', City: 'Newbury Park', StateOrProvince: 'CA', PostalCode: '91320', ListPrice: 4200,
    };
    // 4 records within 1 mile (0.3/0.5/0.7/0.9), 2 more within 2 miles but
    // beyond 1 (1.3/1.7) — offsets built the same latDelta = miles/69.0 way
    // buildBoundingBox() itself does, same-longitude so Haversine distance
    // is effectively the offset in miles (verified to <0.01mi tolerance by
    // the haversineMiles() test above). Before this fix, 4 within 1 mile
    // would have met MIN_COMPS_FOR_NARROW_RADIUS and cut the other 2 —
    // now that decision happens in lib/sources.js, not here.
    const milesOffsets = [0.3, 0.5, 0.7, 0.9, 1.3, 1.7];
    const records = milesOffsets.map((mi, i) => ({
      ...baseFields, StreetNumberNumeric: 100 + i, StreetName: `Comp${i}`,
      Latitude: subjectLat + mi / 69.0, Longitude: subjectLon,
    }));

    global.fetch = async (url) => {
      const recs = new URL(String(url)).searchParams.get('$orderby') === 'OnMarketDate desc' ? records : [];
      return { ok: true, json: async () => ({ value: recs }) };
    };
    try {
      const result = await pullCrmlsComps({ address: '1895 Dorrit St, Newbury Park, CA 91320', latitude: subjectLat, longitude: subjectLon });
      assert.equal(result.comps.length, 6, 'all 6 comps out to 2mi must be returned, regardless of how many are within 1 mile');
      assert.ok(result.comps.every(c => typeof c.distance_miles === 'number' && c.distance_miles <= WIDE_SEARCH_RADIUS_MILES), 'every comp must carry its real distance_miles, all within the wide bound');
    } finally {
      global.fetch = originalFetch;
      process.env.RECORE_SERVER_TOKEN = originalToken;
    }
  });

  await check('pullCrmlsComps() still returns the full <=2mi set when few comps are within 1 mile (same always-wide behavior, not a "fallback" anymore)', async () => {
    const originalFetch = global.fetch;
    const originalToken = process.env.RECORE_SERVER_TOKEN;
    process.env.RECORE_SERVER_TOKEN = 'test-token';

    const subjectLat = 34.179615, subjectLon = -119.198962;
    const baseFields = {
      StandardStatus: 'Active', PropertySubType: 'Single Family Residence',
      StreetSuffix: 'St', City: 'Newbury Park', StateOrProvince: 'CA', PostalCode: '91320', ListPrice: 4200,
    };
    // Only 2 within 1 mile, 2 more between 1 and 2 miles.
    const milesOffsets = [0.3, 0.5, 1.3, 1.7];
    const records = milesOffsets.map((mi, i) => ({
      ...baseFields, StreetNumberNumeric: 200 + i, StreetName: `Comp${i}`,
      Latitude: subjectLat + mi / 69.0, Longitude: subjectLon,
    }));

    global.fetch = async (url) => {
      const recs = new URL(String(url)).searchParams.get('$orderby') === 'OnMarketDate desc' ? records : [];
      return { ok: true, json: async () => ({ value: recs }) };
    };
    try {
      const result = await pullCrmlsComps({ address: '1895 Dorrit St, Newbury Park, CA 91320', latitude: subjectLat, longitude: subjectLon });
      assert.equal(result.comps.length, 4, 'all 4 comps out to 2mi returned, unconditionally');
    } finally {
      global.fetch = originalFetch;
      process.env.RECORE_SERVER_TOKEN = originalToken;
    }
  });

  console.log('--- lib/crmls.js relevance filtering, date floor, and Duplex mapping (COMP-COVERAGE-SPEC.md) ---');

  const filterBox = { type: 'box', minLat: 34.1, maxLat: 34.2, minLon: -119.3, maxLon: -119.1 };
  const filterBoxPrefix = status => `StandardStatus eq '${status}' and PropertyType eq 'Residential Lease' and Latitude ge 34.1 and Latitude le 34.2 and Longitude ge -119.3 and Longitude le -119.1`;

  await check('buildFilter() with relevance: exact strings for Closed SFR 4-bed (box), Active (no CloseDate), condo, apartment (two subtypes), fourplex, other (no subtype clause), a 0-bed subject, and the zip scope', () => {
    // The spec's example, written out in full.
    assert.equal(
      buildCrmlsFilter('Closed', filterBox, { propertyType: 'single_family', bedrooms: 4, closedSince: '2026-04-14' }),
      "StandardStatus eq 'Closed' and PropertyType eq 'Residential Lease' and Latitude ge 34.1 and Latitude le 34.2 and Longitude ge -119.3 and Longitude le -119.1 and (PropertySubType eq 'Single Family Residence' or PropertySubType eq null) and ((BedroomsTotal ge 3 and BedroomsTotal le 5) or BedroomsTotal eq null) and CloseDate ge 2026-04-14"
    );
    // Active never gets a date floor, even when closedSince is passed.
    assert.equal(
      buildCrmlsFilter('Active', filterBox, { propertyType: 'single_family', bedrooms: 4, closedSince: '2026-04-14' }),
      `${filterBoxPrefix('Active')} and (PropertySubType eq 'Single Family Residence' or PropertySubType eq null) and ((BedroomsTotal ge 3 and BedroomsTotal le 5) or BedroomsTotal eq null)`
    );
    assert.equal(
      buildCrmlsFilter('Active', filterBox, { propertyType: 'condo', bedrooms: 2 }),
      `${filterBoxPrefix('Active')} and (PropertySubType eq 'Condominium' or PropertySubType eq null) and ((BedroomsTotal ge 1 and BedroomsTotal le 3) or BedroomsTotal eq null)`
    );
    assert.equal(
      buildCrmlsFilter('Active', filterBox, { propertyType: 'apartment', bedrooms: 1 }),
      `${filterBoxPrefix('Active')} and (PropertySubType eq 'Apartment' or PropertySubType eq 'Studio' or PropertySubType eq null) and ((BedroomsTotal ge 0 and BedroomsTotal le 2) or BedroomsTotal eq null)`
    );
    assert.equal(
      buildCrmlsFilter('Active', filterBox, { propertyType: 'fourplex', bedrooms: 2 }),
      `${filterBoxPrefix('Active')} and (PropertySubType eq 'Quadruplex' or PropertySubType eq null) and ((BedroomsTotal ge 1 and BedroomsTotal le 3) or BedroomsTotal eq null)`
    );
    assert.equal(
      buildCrmlsFilter('Active', filterBox, { propertyType: 'duplex', bedrooms: 2 }),
      `${filterBoxPrefix('Active')} and (PropertySubType eq 'Duplex' or PropertySubType eq null) and ((BedroomsTotal ge 1 and BedroomsTotal le 3) or BedroomsTotal eq null)`
    );
    // 'other' has no subtype clause; the bedroom clause still applies.
    assert.equal(
      buildCrmlsFilter('Active', filterBox, { propertyType: 'other', bedrooms: 3 }),
      `${filterBoxPrefix('Active')} and ((BedroomsTotal ge 2 and BedroomsTotal le 4) or BedroomsTotal eq null)`
    );
    // A studio (0 bedrooms) never produces a negative lower bound.
    assert.equal(
      buildCrmlsFilter('Closed', filterBox, { propertyType: 'apartment', bedrooms: 0, closedSince: '2026-04-14' }),
      `${filterBoxPrefix('Closed')} and (PropertySubType eq 'Apartment' or PropertySubType eq 'Studio' or PropertySubType eq null) and ((BedroomsTotal ge 0 and BedroomsTotal le 1) or BedroomsTotal eq null) and CloseDate ge 2026-04-14`
    );
    // Zip scope: relevance clauses follow the PostalCode clause.
    assert.equal(
      buildCrmlsFilter('Closed', { type: 'zip', zip: '91320' }, { propertyType: 'townhouse', bedrooms: 3, closedSince: '2026-04-14' }),
      "StandardStatus eq 'Closed' and PropertyType eq 'Residential Lease' and PostalCode eq '91320' and (PropertySubType eq 'Townhouse' or PropertySubType eq null) and ((BedroomsTotal ge 2 and BedroomsTotal le 4) or BedroomsTotal eq null) and CloseDate ge 2026-04-14"
    );
    // Only some relevance fields set: only those clauses.
    assert.equal(
      buildCrmlsFilter('Closed', filterBox, { closedSince: '2026-04-14' }),
      `${filterBoxPrefix('Closed')} and CloseDate ge 2026-04-14`
    );
    // Omitted / empty relevance is byte-identical to the two-argument output.
    assert.equal(buildCrmlsFilter('Closed', filterBox, {}), buildCrmlsFilter('Closed', filterBox));
    assert.equal(buildCrmlsFilter('Closed', filterBox, undefined), `${filterBoxPrefix('Closed')}`);
    assert.equal(buildCrmlsFilter('Closed', { type: 'zip', zip: '91320' }, {}), "StandardStatus eq 'Closed' and PropertyType eq 'Residential Lease' and PostalCode eq '91320'");
  });

  await check('pullCrmlsComps(): both statuses ask for $top=200; only Closed carries the 6-month CloseDate floor; type/bedroom clauses appear when the subject has them and are absent when it does not', async () => {
    const originalFetch = global.fetch;
    const originalToken = process.env.RECORE_SERVER_TOKEN;
    process.env.RECORE_SERVER_TOKEN = 'test-token';
    const lat = 34.252446, lon = -119.200606;
    const requests = [];
    global.fetch = async url => {
      const params = new URL(String(url)).searchParams;
      requests.push({ orderBy: params.get('$orderby'), top: params.get('$top'), filter: params.get('$filter') });
      return { ok: true, json: async () => ({ value: [] }) };
    };
    const run = async subject => {
      requests.length = 0;
      await pullCrmlsComps(subject);
      return {
        closed: requests.find(r => r.orderBy === 'CloseDate desc').filter,
        active: requests.find(r => r.orderBy === 'OnMarketDate desc').filter,
        tops: requests.map(r => r.top),
      };
    };
    try {
      const typed = await run({ address: '2461 Bunting Avenue, Ventura, CA 93003', latitude: lat, longitude: lon, propertyType: 'single_family', bedrooms: 4 });
      assert.deepEqual(typed.tops, ['200', '200'], 'Recore\'s maximum page, for both statuses');
      assert.equal(MAX_RECORDS_PER_STATUS, 200);
      assert.ok(typed.closed.endsWith(` and CloseDate ge ${closedSinceDate()}`), `Closed filter must end with the 6-month floor, got: ${typed.closed}`);
      assert.ok(!typed.active.includes('CloseDate'), 'Active has no date floor');
      for (const f of [typed.closed, typed.active]) {
        assert.ok(f.includes("(PropertySubType eq 'Single Family Residence' or PropertySubType eq null)"));
        assert.ok(f.includes('((BedroomsTotal ge 3 and BedroomsTotal le 5) or BedroomsTotal eq null)'));
      }

      // No type or bedrooms on the subject (an old test, a direct call): no relevance clauses at all.
      const untyped = await run({ address: '2461 Bunting Avenue, Ventura, CA 93003', latitude: lat, longitude: lon });
      for (const f of [untyped.closed, untyped.active]) {
        assert.ok(!f.includes('PropertySubType'), `no subtype clause expected, got: ${f}`);
        assert.ok(!f.includes('BedroomsTotal'), `no bedroom clause expected, got: ${f}`);
      }
      assert.ok(untyped.closed.endsWith(` and CloseDate ge ${closedSinceDate()}`), 'the date floor is independent of the subject');
      assert.ok(!untyped.active.includes('CloseDate'));

      // Zip fallback (no coordinates) gets the same relevance clauses.
      const zipFallback = await run({ address: '2461 Bunting Avenue, Ventura, CA 93003', propertyType: 'condo', bedrooms: 2 });
      assert.ok(zipFallback.closed.includes("PostalCode eq '93003'"));
      assert.ok(zipFallback.closed.includes("(PropertySubType eq 'Condominium' or PropertySubType eq null)"));
      assert.ok(zipFallback.closed.includes('((BedroomsTotal ge 1 and BedroomsTotal le 3) or BedroomsTotal eq null)'));
    } finally {
      global.fetch = originalFetch;
      process.env.RECORE_SERVER_TOKEN = originalToken;
    }
  });

  await check('pullCrmlsComps() warns about possible truncation when a status returns exactly 200 rows, and does not when it returns fewer', async () => {
    const originalFetch = global.fetch;
    const originalToken = process.env.RECORE_SERVER_TOKEN;
    process.env.RECORE_SERVER_TOKEN = 'test-token';
    const lat = 34.252446, lon = -119.200606;
    const activeRows = n => Array.from({ length: n }, (_, i) => ({
      StandardStatus: 'Active', PropertySubType: 'Single Family Residence', ListPrice: 4000,
      StreetNumberNumeric: 1000 + i, StreetName: 'Bulk', StreetSuffix: 'St', City: 'Ventura', StateOrProvince: 'CA', PostalCode: '93003',
      Latitude: lat + 0.002 * (i % 5), Longitude: lon,
    }));
    const runWith = async n => {
      global.fetch = async url => {
        const isActive = new URL(String(url)).searchParams.get('$orderby') === 'OnMarketDate desc';
        return { ok: true, json: async () => ({ value: isActive ? activeRows(n) : [] }) };
      };
      return withCapturedWarnings(async warnings => {
        const result = await pullCrmlsComps({ address: '2461 Bunting Avenue, Ventura, CA 93003', latitude: lat, longitude: lon, propertyType: 'single_family', bedrooms: 4 });
        return { result, warnings };
      });
    };
    try {
      const full = await runWith(200);
      assert.equal(full.warnings.length, 1, `expected one truncation warning, got ${JSON.stringify(full.warnings)}`);
      assert.match(full.warnings[0], /Active/);
      assert.match(full.warnings[0], /truncated/);
      assert.equal(full.result.comps.length, 200, 'the 200 rows are still all used; the warning is informational');

      const under = await runWith(199);
      assert.equal(under.warnings.length, 0);
    } finally {
      global.fetch = originalFetch;
      process.env.RECORE_SERVER_TOKEN = originalToken;
    }
  });

  await check('FROM_CRMLS_PROPERTY_TYPE: Duplex/Triplex/Quadruplex/Studio/Rooms for Rent/Commercial-Residential map as specified; Loft, Stock Cooperative, null and an unknown string stay null; TO_CRMLS_PROPERTY_SUBTYPES is derived from it', () => {
    const typeFor = PropertySubType => mapCrmlsComparable({ StandardStatus: 'Active', PropertySubType, ListPrice: 3000 }).property_type;
    const expected = {
      'Single Family Residence': 'single_family', 'Condominium': 'condo', 'Townhouse': 'townhouse', 'Apartment': 'apartment', 'Manufactured On Land': 'manufactured',
      'Duplex': 'duplex', 'Triplex': 'triplex', 'Quadruplex': 'fourplex', 'Studio': 'apartment',
      'Rooms for Rent': 'other', 'Commercial/Residential': 'other',
    };
    for (const [subtype, ourType] of Object.entries(expected)) {
      assert.equal(typeFor(subtype), ourType, `${subtype} -> ${ourType}`);
    }
    for (const unmapped of ['Loft', 'Stock Cooperative', null, undefined, 'Some Subtype CRMLS Added Later']) {
      assert.equal(typeFor(unmapped), null, `${unmapped} must stay unmapped (null), not guessed`);
    }

    // The reverse map is derived, so every typed subtype must round-trip.
    for (const [ourType, subtypes] of Object.entries(TO_CRMLS_PROPERTY_SUBTYPES)) {
      for (const subtype of subtypes) assert.equal(FROM_CRMLS_PROPERTY_TYPE[subtype], ourType);
    }
    assert.deepEqual(TO_CRMLS_PROPERTY_SUBTYPES.apartment, ['Apartment', 'Studio']);
    assert.deepEqual(TO_CRMLS_PROPERTY_SUBTYPES.fourplex, ['Quadruplex']);
    assert.deepEqual(TO_CRMLS_PROPERTY_SUBTYPES.single_family, ['Single Family Residence']);
    assert.equal(TO_CRMLS_PROPERTY_SUBTYPES.other, undefined, '"other" yields no subtypes');

    assert.equal(CRMLS_CLOSED_LOOKBACK_MONTHS, 6);
    assert.equal(closedSinceDate(new Date('2026-10-14T12:00:00Z')), '2026-04-14');
  });

  await check('a CRMLS Duplex record (3bd, Tiber-St-shaped) is no longer "unknown type = match" for a single_family 4bd subject: exclusionReason() says property_type_mismatch', () => {
    const duplexRecord = {
      StandardStatus: 'Closed', PropertySubType: 'Duplex', ClosePrice: 3200, ListPrice: 3300, CloseDate: '2026-09-10',
      StreetNumberNumeric: 1450, StreetName: 'Tiber', StreetSuffix: 'St', City: 'Ventura', StateOrProvince: 'CA', PostalCode: '93003',
      BedroomsTotal: 3, Latitude: 34.25, Longitude: -119.2,
    };
    const mapped = mapCrmlsComparable(duplexRecord, 0.9);
    assert.equal(mapped.property_type, 'duplex');
    assert.equal(exclusionReason(mapped, 4, 'single_family'), 'property_type_mismatch');
    assert.equal(exclusionReason(mapped, 3, 'duplex'), null, 'but it IS a genuine comp for a duplex subject');
  });

  console.log('--- zero/negative numeric values would violate rental_comps CHECKs (sqft > 0; bedrooms, bathrooms, distance, prices, days >= 0) ---');

  const crmlsBase = {
    StandardStatus: 'Active', ListPrice: 2995, PropertySubType: 'Single Family Residence',
    StreetNumberNumeric: 336, StreetName: 'Hollywood', StreetSuffix: 'Boulevard', City: 'Oxnard', StateOrProvince: 'CA', PostalCode: '93035',
    BedroomsTotal: 2, BathroomsTotalDecimal: 1.5, LivingArea: 1100, DaysOnMarket: 12, OriginalListPrice: 3095, Latitude: 34.17, Longitude: -119.23,
  };

  await check('CRMLS mapComparable(): LivingArea 0 (the real 336 Hollywood Boulevard, Oxnard record) maps to sqft null, not 0', () => {
    assert.equal(mapCrmlsComparable({ ...crmlsBase, LivingArea: 0 }).sqft, null);
  });

  await check('CRMLS mapComparable(): a negative LivingArea maps to sqft null', () => {
    assert.equal(mapCrmlsComparable({ ...crmlsBase, LivingArea: -50 }).sqft, null);
  });

  await check('CRMLS mapComparable(): a normal record is unchanged (sqft, bedrooms 0 for a studio, every other numeric field passed through)', () => {
    const m = mapCrmlsComparable(crmlsBase, 0.75);
    assert.equal(m.sqft, 1100);
    assert.equal(m.bedrooms, 2);
    assert.equal(m.bathrooms, 1.5);
    assert.equal(m.distance_miles, 0.75);
    assert.equal(m.days_on_market, 12);
    assert.equal(m.original_price, 3095);
    assert.equal(m.latitude, 34.17);
    assert.equal(m.longitude, -119.23);
    assert.equal(m.had_price_cut, true);
    assert.equal(mapCrmlsComparable({ ...crmlsBase, BedroomsTotal: 0 }).bedrooms, 0, 'a studio (0 bedrooms) is valid, only negatives are not');
    assert.equal(mapCrmlsComparable(crmlsBase, 0).distance_miles, 0, 'distance 0 is valid');
    assert.equal(mapCrmlsComparable({ ...crmlsBase, DaysOnMarket: 0 }).days_on_market, 0, '0 days on market is valid');
  });

  await check('CRMLS mapComparable(): every other nullable numeric column with a CHECK maps a violating value to null instead of failing the batch insert', () => {
    const m = mapCrmlsComparable({ ...crmlsBase, BedroomsTotal: -1, BathroomsTotalDecimal: -0.5, DaysOnMarket: -3, OriginalListPrice: -1, Latitude: 190, Longitude: -200 }, -1);
    assert.equal(m.bedrooms, null);
    assert.equal(m.bathrooms, null);
    assert.equal(m.days_on_market, null);
    assert.equal(m.original_price, null);
    assert.equal(m.distance_miles, null);
    assert.equal(m.latitude, null);
    assert.equal(m.longitude, null);
    assert.equal(m.monthly_rent, 2995, 'the NOT NULL rent is untouched');
  });

  await check('RentCast mapComparable(): squareFootage 0 and negative map to sqft null; a normal comparable keeps its sqft', () => {
    const base = { formattedAddress: '1 Test St, Ventura, CA 93003', propertyType: 'Single Family', bedrooms: 3, bathrooms: 2, squareFootage: 1500, status: 'Active', price: 3500, distance: 0.6, daysOnMarket: 9 };
    assert.equal(mapComparable({ ...base, squareFootage: 0 }).sqft, null);
    assert.equal(mapComparable({ ...base, squareFootage: -10 }).sqft, null);
    const normal = mapComparable(base);
    assert.equal(normal.sqft, 1500);
    assert.equal(normal.bedrooms, 3);
    assert.equal(normal.bathrooms, 2);
    assert.equal(normal.distance_miles, 0.6);
    assert.equal(normal.days_on_market, 9);
    assert.equal(normal.monthly_rent, 3500);
  });

  await check('RentCast mapListing(): squareFootage 0 on a listings-search record maps to sqft null; negative days/bedrooms map to null too', () => {
    assert.equal(mapListing(rcListing({ squareFootage: 0 }), buntingLat, buntingLon).sqft, null);
    const m = mapListing(rcListing({ daysOnMarket: -2, bedrooms: -1, bathrooms: -1 }), buntingLat, buntingLon);
    assert.equal(m.days_on_market, null);
    assert.equal(m.bedrooms, null);
    assert.equal(m.bathrooms, null);
    assert.equal(mapListing(rcListing(), buntingLat, buntingLon).sqft, 1800, 'a normal listing is unchanged');
  });

  await check('LeadSimple mapComparable() needs no guard: leadsimple_new_leases carries the identical CHECKs (sqft > 0, bedrooms/bathrooms >= 0), so a violating row cannot exist to map', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const migration = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20260918070000_leadsimple_new_leases_schema.sql'), 'utf8');
    assert.match(migration, /sqft\s+INTEGER\s+CHECK \(sqft IS NULL OR sqft > 0\)/);
    assert.match(migration, /bedrooms\s+INTEGER\s+CHECK \(bedrooms IS NULL OR bedrooms >= 0\)/);
    assert.match(migration, /bathrooms\s+NUMERIC\(3,1\)\s+CHECK \(bathrooms IS NULL OR bathrooms >= 0\)/);
  });

  console.log('--- a rent of 0 (or negative/non-numeric) means "rent unknown", never "free": no mapper may turn it into a comp ---');

  const zeroRents = [0, -0, -1, -2500, NaN, null, undefined, '', '0', 'abc', '3500', true, [], {}];

  await check('CRMLS mapComparable(): a Closed record with ClosePrice 0 and a real positive ListPrice falls back to ListPrice (same fallback as an absent ClosePrice) and stays leased — the real 1121 Pittsfield Ln (ListPrice 4400) and 1300 Saratoga Ave (ListPrice 2500) shape', () => {
    const closed = { ...crmlsBase, StandardStatus: 'Closed', CloseDate: '2026-08-01', OriginalListPrice: 2500 };
    const zeroClose = mapCrmlsComparable({ ...closed, ClosePrice: 0, ListPrice: 2500 });
    assert.equal(zeroClose.monthly_rent, 2500);
    assert.equal(zeroClose.listing_status, 'leased');
    assert.equal(zeroClose.leased_date, '2026-08-01');
    assert.equal(mapCrmlsComparable({ ...closed, ClosePrice: null, ListPrice: 2500 }).monthly_rent, 2500, 'an absent ClosePrice behaves exactly as before');
    assert.equal(mapCrmlsComparable({ ...closed, ClosePrice: -5, ListPrice: 2500 }).monthly_rent, 2500, 'a negative ClosePrice is "unknown" too');
    assert.equal(mapCrmlsComparable({ ...closed, ClosePrice: NaN, ListPrice: 2500 }).monthly_rent, 2500);
  });

  await check('CRMLS mapComparable(): a Closed record with ClosePrice 0 and no positive ListPrice (0, missing, null, negative, NaN, text) is not a comp', () => {
    const closed = { ...crmlsBase, StandardStatus: 'Closed', CloseDate: '2026-08-01' };
    for (const closePrice of [0, null, undefined]) {
      for (const listPrice of [0, null, undefined, -100, NaN, '2500']) {
        assert.equal(mapCrmlsComparable({ ...closed, ClosePrice: closePrice, ListPrice: listPrice }), null, `ClosePrice ${closePrice} / ListPrice ${String(listPrice)} must be dropped`);
      }
    }
  });

  await check('CRMLS mapComparable(): a Closed record with a real ClosePrice still uses it (even beside a ListPrice of 0 or a different ListPrice) — the real transaction figure wins', () => {
    const closed = { ...crmlsBase, StandardStatus: 'Closed', CloseDate: '2026-08-01' };
    assert.equal(mapCrmlsComparable({ ...closed, ClosePrice: 2800, ListPrice: 2995 }).monthly_rent, 2800);
    assert.equal(mapCrmlsComparable({ ...closed, ClosePrice: 2800, ListPrice: 0 }).monthly_rent, 2800);
    assert.equal(mapCrmlsComparable({ ...closed, ClosePrice: 2800, ListPrice: 0 }).listing_status, 'leased');
  });

  await check('CRMLS mapComparable(): an Active record with ListPrice 0 (or negative/missing/non-numeric) is not a comp; a positive ClosePrice on an Active record is not consulted', () => {
    for (const listPrice of zeroRents) {
      assert.equal(mapCrmlsComparable({ ...crmlsBase, StandardStatus: 'Active', ListPrice: listPrice }), null, `Active ListPrice ${String(listPrice)} must be dropped`);
    }
    assert.equal(mapCrmlsComparable({ ...crmlsBase, StandardStatus: 'Active', ListPrice: 0, ClosePrice: 2995 }), null, 'Active uses ListPrice only, as before');
    assert.equal(mapCrmlsComparable({ ...crmlsBase, StandardStatus: 'Active', ListPrice: 0.01 }).monthly_rent, 0.01, 'any positive number is a number > 0');
  });

  await check('CRMLS mapComparable(): a normal Active record and a normal Closed record are unchanged by the rent guard', () => {
    const active = mapCrmlsComparable(crmlsBase, 0.5);
    assert.equal(active.monthly_rent, 2995);
    assert.equal(active.listing_status, 'active');
    assert.equal(active.address, '336 Hollywood Boulevard, Oxnard, CA 93035');
    const closed = mapCrmlsComparable({ ...crmlsBase, StandardStatus: 'Closed', ClosePrice: 2900, CloseDate: '2026-09-01' }, 0.5);
    assert.equal(closed.monthly_rent, 2900);
    assert.equal(closed.listing_status, 'leased');
    assert.equal(closed.leased_date, '2026-09-01');
  });

  await check('RentCast mapComparable() (AVM comp): price 0, negative, NaN, missing or text is not a comp (null); a normal comparable is unchanged', () => {
    const base = { formattedAddress: '1 Test St, Ventura, CA 93003', propertyType: 'Single Family', bedrooms: 3, bathrooms: 2, squareFootage: 1500, status: 'Active', price: 3500, distance: 0.6, daysOnMarket: 9 };
    for (const price of zeroRents.filter(p => p !== '3500')) {
      assert.equal(mapComparable({ ...base, price }), null, `price ${String(price)} must be dropped`);
    }
    assert.equal(mapComparable({ ...base, price: '3500' }), null, 'a text price is not a number (unchanged policy: the listings path already dropped it)');
    const noPrice = { ...base };
    delete noPrice.price;
    assert.equal(mapComparable(noPrice), null, 'a comparable with no price at all is dropped too');
    const normal = mapComparable(base);
    assert.equal(normal.monthly_rent, 3500);
    assert.equal(normal.listing_status, 'active');
    assert.equal(normal.address, '1 Test St, Ventura, CA 93003');
  });

  await check('RentCast mapListing() (listings search): price 0 or negative is not a comp (null); a normal listing is unchanged', () => {
    assert.equal(mapListing(rcListing({ price: 0 }), buntingLat, buntingLon), null);
    assert.equal(mapListing(rcListing({ price: -3995 }), buntingLat, buntingLon), null);
    assert.equal(mapListing(rcListing({ price: undefined }), buntingLat, buntingLon), null);
    assert.equal(mapListing(rcListing(), buntingLat, buntingLon).monthly_rent, 4195);
  });

  await check('pullRentCastComps(): an AVM comparable with price 0 and a listings-search row with price 0 (and one negative) are both dropped; the real ones are kept', async () => {
    const avmComps = [
      { formattedAddress: '555 Skyline Rd, Ventura, CA 93003', propertyType: 'Single Family', state: 'CA', distance: 0.19, bedrooms: 4, price: 4395, status: 'Inactive' },
      { formattedAddress: '556 Zero Rd, Ventura, CA 93003', propertyType: 'Single Family', state: 'CA', distance: 0.2, bedrooms: 4, price: 0, status: 'Inactive' },
    ];
    const listings = [
      rcListing(),
      rcListing({ formattedAddress: '21 Zero Listing Ln, Ventura, CA 93003', price: 0 }),
      rcListing({ formattedAddress: '22 Negative Listing Ln, Ventura, CA 93003', price: -1 }),
    ];
    const mock = mockRentCastFetch({ avm: okJson(avmBody(avmComps)), listings: okJson(listings) });
    const result = await withRentCastMock(mock, () => pullRentCastComps(buntingSubject));
    assert.deepEqual(result.comps.map(c => c.address), ['555 Skyline Rd, Ventura, CA 93003', '6630 Sora St, Ventura, CA 93003']);
    assert.ok(result.comps.every(c => c.monthly_rent > 0));
    assert.equal(mock.calls.length, 2, 'still exactly one AVM + one listings request');
    const listingsOnly = await withRentCastMock(mockRentCastFetch({ avm: okJson(avmBody()), listings: okJson(listings) }), () => pullRentCastListings(buntingSubject, buntingLat, buntingLon));
    assert.deepEqual(listingsOnly.map(c => c.address), ['6630 Sora St, Ventura, CA 93003']);
  });

  await check('LeadSimple mapComparable(): a row with rent 0, negative, NaN, null, empty or non-numeric text is not a comp (null); the real 3491 Kings Canyon Dr rent-$0 shape is dropped', () => {
    const kingsCanyon = { address: '3491 Kings Canyon Dr', city: 'Oxnard', state: 'CA', zip_code: '93036', property_type: 'Single Home', bedrooms: 3, bathrooms: 2, sqft: 1300, rent: 0, lease_start_date: '2026-05-01', closed_at: '2026-05-10' };
    assert.equal(mapLeadSimpleComparable(kingsCanyon), null);
    for (const rent of zeroRents.filter(r => r !== '3500')) {
      assert.equal(mapLeadSimpleComparable({ ...kingsCanyon, rent }), null, `rent ${String(rent)} must be dropped`);
    }
    assert.equal(mapLeadSimpleComparable({ ...kingsCanyon, rent: undefined }), null);
    const noRent = { ...kingsCanyon };
    delete noRent.rent;
    assert.equal(mapLeadSimpleComparable(noRent), null, 'a row with no rent field at all is dropped');
  });

  await check('LeadSimple mapComparable(): a normal row is unchanged, and a numeric string rent (as before) is still accepted as a number', () => {
    const row = { address: '2303 Otter Creek Ln', city: 'Oxnard', state: 'CA', zip_code: '93036', property_type: 'Single Home', bedrooms: 4, bathrooms: 2, sqft: 1850, rent: 3865, lease_start_date: '2026-09-09' };
    assert.equal(mapLeadSimpleComparable(row).monthly_rent, 3865);
    assert.equal(mapLeadSimpleComparable({ ...row, rent: '3865.00' }).monthly_rent, 3865);
    assert.equal(mapLeadSimpleComparable({ ...row, rent: 3865.5 }).monthly_rent, 3865.5);
  });

  await check('pullLeadSimpleComps(): a rent-0 and a negative-rent row are skipped on BOTH paths (subject with coordinates, and zip-only), real rows kept; the query is read-only (a single GET select)', async () => {
    const originalFetch = global.fetch;
    const subjectLat = 34.179615, subjectLon = -119.198962;
    const rows = [
      { address: '100 Real St', city: 'Oxnard', state: 'CA', zip_code: '93036', property_type: 'Single Home', bedrooms: 3, rent: 3100, lease_start_date: '2026-06-01', closed_at: '2026-06-05', latitude: subjectLat + 0.3 / 69.0, longitude: subjectLon },
      { address: '3491 Kings Canyon Dr', city: 'Oxnard', state: 'CA', zip_code: '93036', property_type: 'Single Home', bedrooms: 3, rent: 0, lease_start_date: '2026-06-01', closed_at: '2026-06-05', latitude: subjectLat + 0.4 / 69.0, longitude: subjectLon },
      { address: '102 Negative St', city: 'Oxnard', state: 'CA', zip_code: '93036', property_type: 'Single Home', bedrooms: 3, rent: -50, lease_start_date: '2026-06-01', closed_at: '2026-06-05', latitude: subjectLat + 0.5 / 69.0, longitude: subjectLon },
      { address: '103 Real St', city: 'Oxnard', state: 'CA', zip_code: '93036', property_type: 'Single Home', bedrooms: 3, rent: 3300, lease_start_date: '2026-06-01', closed_at: '2026-06-05', latitude: null, longitude: null },
    ];
    const methods = [];
    global.fetch = async (url, opts = {}) => {
      methods.push(opts.method || 'GET');
      return { ok: true, json: async () => rows };
    };
    try {
      const withCoords = await pullLeadSimpleComps({ address: '1 Comp St, Oxnard, CA 93036', latitude: subjectLat, longitude: subjectLon });
      assert.deepEqual(withCoords.comps.map(c => c.monthly_rent), [3100, 3300]);
      const zipOnly = await pullLeadSimpleComps({ address: '1 Comp St, Oxnard, CA 93036' });
      assert.deepEqual(zipOnly.comps.map(c => c.monthly_rent), [3100, 3300]);
      assert.deepEqual(methods, ['GET', 'GET'], 'filtered on read only — nothing is written to Supabase');
    } finally {
      global.fetch = originalFetch;
    }
  });

  await check('END TO END through runActiveSources() (all 3 sources, mocked): $0 / unknown rents from every source never become comps, so computeRawRange() low is the lowest REAL rent, not 0, and the recommended range is not dragged down either', async () => {
    const closedRecord = (num, over) => ({
      StandardStatus: 'Closed', PropertySubType: 'Single Family Residence', StreetNumberNumeric: num, StreetName: 'Crmls', StreetSuffix: 'Way',
      City: 'Ventura', StateOrProvince: 'CA', PostalCode: '93003', BedroomsTotal: 4, BathroomsTotalDecimal: 2, LivingArea: 1800,
      Latitude: northOf(0.3), Longitude: buntingLon, CloseDate: '2026-09-15', ...over,
    });
    const activeRecord = (num, over) => ({ ...closedRecord(num), StandardStatus: 'Active', ClosePrice: null, OnMarketDate: '2026-10-01', ...over });
    const crmlsClosed = [
      closedRecord(201, { ClosePrice: 4200, ListPrice: 4200 }),
      closedRecord(202, { ClosePrice: 0, ListPrice: 4300 }), // ClosePrice placeholder -> ListPrice fallback
      closedRecord(203, { ClosePrice: 0, ListPrice: 0 }),    // nothing real -> dropped
    ];
    const crmlsActive = [activeRecord(204, { ListPrice: 4500 }), activeRecord(205, { ListPrice: 0 })];
    const lsRows = [
      { address: '3491 Kings Canyon Dr', city: 'Ventura', state: 'CA', zip_code: '93003', property_type: 'Single Home', bedrooms: 4, rent: 0, lease_start_date: '2026-06-01', closed_at: '2026-06-05', latitude: northOf(0.2), longitude: buntingLon },
      { address: '301 Leadsimple Ct', city: 'Ventura', state: 'CA', zip_code: '93003', property_type: 'Single Home', bedrooms: 4, rent: 4100, lease_start_date: '2026-06-01', closed_at: '2026-06-05', latitude: northOf(0.2), longitude: buntingLon },
    ];
    const avmComps = [
      { formattedAddress: '401 Avm Ave, Ventura, CA 93003', propertyType: 'Single Family', state: 'CA', distance: 0.3, bedrooms: 4, price: 4000, status: 'Inactive' },
      { formattedAddress: '402 Zero Avm Ave, Ventura, CA 93003', propertyType: 'Single Family', state: 'CA', distance: 0.3, bedrooms: 4, price: 0, status: 'Inactive' },
    ];
    const rcListings = [
      rcListing({ formattedAddress: '501 Listing Ln, Ventura, CA 93003', price: 4400, latitude: northOf(0.3) }),
      rcListing({ formattedAddress: '502 Zero Listing Ln, Ventura, CA 93003', price: 0, latitude: northOf(0.3) }),
    ];
    const rcMock = mockRentCastFetch({ avm: okJson(avmBody(avmComps)), listings: okJson(rcListings) });
    const originalFetch = global.fetch;
    const originalToken = process.env.RECORE_SERVER_TOKEN;
    const originalKey = process.env.RENTCAST_API_KEY;
    process.env.RECORE_SERVER_TOKEN = 'test-token';
    process.env.RENTCAST_API_KEY = 'test-key';
    global.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/rest/v1/leadsimple_new_leases')) return okJson(lsRows);
      if (u.includes('recore.net')) return okJson({ value: new URL(u).searchParams.get('$orderby') === 'CloseDate desc' ? crmlsClosed : crmlsActive });
      return rcMock.fn(u, opts);
    };
    try {
      const sources = [{ id: 'rc', name: 'RentCast' }, { id: 'cr', name: 'CRMLS' }, { id: 'ls', name: 'LeadSimple Move-Ins' }];
      const result = await runActiveSources(sources, buntingSubject);
      assert.deepEqual(result.sourceErrors, []);
      const rents = result.comps.map(c => c.monthly_rent).sort((a, b) => a - b);
      assert.deepEqual(rents, [4000, 4100, 4200, 4300, 4400, 4500], 'exactly the six real rents; all five $0 / unknown records are gone');
      assert.ok(result.comps.every(c => c.monthly_rent > 0));
      const raw = computeRawRange(result.comps, buntingSubject.bedrooms, buntingSubject.propertyType);
      assert.equal(raw.low, 4000, 'the raw low is the lowest real rent, never 0');
      assert.equal(raw.high, 4500);
      const rec = computeRecommendedRange(result.comps, buntingSubject.bedrooms, buntingSubject.propertyType);
      assert.ok(rec.low >= 4000 && rec.low <= rec.mid && rec.mid <= rec.high && rec.high <= 4500, `recommended range ${JSON.stringify(rec)} must sit inside the real rents`);
    } finally {
      global.fetch = originalFetch;
      process.env.RECORE_SERVER_TOKEN = originalToken;
      process.env.RENTCAST_API_KEY = originalKey;
    }
  });

  console.log('--- lib/leadsimple.js ---');

  await check('mapComparable() maps a real-shaped leadsimple_new_leases row to a leased, non-estimated, uncoordinated comp', () => {
    const row = {
      address: '2303 Otter Creek Ln', city: 'Oxnard', state: 'CA', zip_code: '93036',
      property_type: 'Single Home',
      bedrooms: 4, bathrooms: 2, sqft: 1850,
      rent: 3865, lease_start_date: '2026-09-09', closed_at: '2026-09-16T12:00:00.000Z',
    };
    const mapped = mapLeadSimpleComparable(row);
    assert.equal(mapped.address, '2303 Otter Creek Ln, Oxnard, CA 93036');
    assert.equal(mapped.property_type, 'single_family');
    assert.equal(mapped.bedrooms, 4);
    assert.equal(mapped.bathrooms, 2);
    assert.equal(mapped.sqft, 1850);
    assert.equal(mapped.monthly_rent, 3865);
    assert.equal(mapped.is_estimated_price, false, 'every row already passed the sync script\'s leases cross-reference — never an estimate');
    assert.equal(mapped.listing_status, 'leased', 'the whole point of this source: a real, confirmed, new-tenant lease');
    assert.equal(mapped.leased_date, '2026-09-09');
    // No coordinates exist anywhere in LeadSimple's data (confirmed live,
    // see the spec's Technical Notes) — never guessed.
    assert.equal(mapped.distance_miles, null);
    assert.equal(mapped.latitude, null);
    assert.equal(mapped.longitude, null);
  });

  await check('mapComparable() maps an unmapped/ambiguous property_type (e.g. "Multi-Family", null) to null rather than guessing, same discipline as CRMLS/RentCast', () => {
    assert.equal(mapLeadSimpleComparable({ address: '1 Test St', rent: 3000, property_type: 'Multi-Family' }).property_type, null);
    assert.equal(mapLeadSimpleComparable({ address: '1 Test St', rent: 3000, property_type: null }).property_type, null);
    assert.equal(mapLeadSimpleComparable({ address: '1 Test St', rent: 3000, property_type: 'Student' }).property_type, null);
  });

  await check('FROM_LEADSIMPLE_PROPERTY_TYPE maps exactly the two clean values from live sampling ("Single Home", "Single-Family") to single_family, nothing else', () => {
    assert.equal(FROM_LEADSIMPLE_PROPERTY_TYPE['Single Home'], 'single_family');
    assert.equal(FROM_LEADSIMPLE_PROPERTY_TYPE['Single-Family'], 'single_family');
    assert.equal(Object.keys(FROM_LEADSIMPLE_PROPERTY_TYPE).length, 2);
  });

  await check('buildAddress() joins the table\'s separate address/city/state/zip_code columns into one formatted string, same shape rental_comps.address/dedupeComps() expect', () => {
    assert.equal(buildLeadSimpleAddress({ address: '263 S Ventura Rd #270', city: 'Port Hueneme', state: 'CA', zip_code: '93041' }), '263 S Ventura Rd #270, Port Hueneme, CA 93041');
    assert.equal(buildLeadSimpleAddress({ address: '1 Test St', city: null, state: null, zip_code: null }), '1 Test St');
  });

  await check('pullLeadSimpleComps() queries leadsimple_new_leases filtered by the subject\'s zip and the lookback cutoff, never calls a live LeadSimple API', async () => {
    const originalFetch = global.fetch;
    const requestedUrls = [];
    global.fetch = async (url) => {
      const u = String(url);
      requestedUrls.push(u);
      if (u.includes('/rest/v1/leadsimple_new_leases')) {
        return {
          ok: true,
          json: async () => ([
            { address: '2303 Otter Creek Ln', city: 'Oxnard', state: 'CA', zip_code: '93036', property_type: 'Single Home', bedrooms: 4, bathrooms: 2, sqft: 1850, rent: 3865, lease_start_date: '2026-09-09', closed_at: '2026-09-16' },
          ]),
        };
      }
      throw new Error('Unexpected fetch call in pullLeadSimpleComps() test: ' + u);
    };
    try {
      const result = await pullLeadSimpleComps({ address: '2303 Otter Creek Ln, Oxnard, CA 93036' });
      assert.equal(requestedUrls.length, 1, 'must query Supabase exactly once, never a live LeadSimple API call');
      const query = new URL(requestedUrls[0]).search;
      assert.match(query, /zip_code=eq\.93036/);
      assert.match(query, /closed_at=gte\./);
      assert.equal(result.comps.length, 1);
      assert.equal(result.comps[0].monthly_rent, 3865);
      assert.equal(result.comps[0].listing_status, 'leased');
      assert.equal(result.subjectZip, '93036');
      assert.equal(result.subjectEstimatedRent, null, 'this source does no AVM-style estimate');
    } finally {
      global.fetch = originalFetch;
    }
  });

  await check('pullLeadSimpleComps() returns no comps (and never queries Supabase) when the subject address has no parseable zip', async () => {
    const originalFetch = global.fetch;
    let called = false;
    global.fetch = async () => { called = true; return { ok: true, json: async () => ([]) }; };
    try {
      const result = await pullLeadSimpleComps({ address: 'No Zip Here' });
      assert.equal(called, false);
      assert.deepEqual(result.comps, []);
      assert.equal(result.subjectZip, null);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await check('mapComparable() defaults distance_miles/latitude/longitude to null with no second argument, and passes through real values when given', () => {
    const row = { address: '1 Test St', city: 'Oxnard', state: 'CA', zip_code: '93036', rent: 3000, latitude: 34.18, longitude: -119.2 };
    const noDistance = mapLeadSimpleComparable(row);
    assert.equal(noDistance.distance_miles, null);
    assert.equal(noDistance.latitude, 34.18, 'row has real coordinates of its own -> carried through regardless of distance arg');
    const withDistance = mapLeadSimpleComparable(row, 0.75);
    assert.equal(withDistance.distance_miles, 0.75);
  });

  console.log('--- lib/leadsimple.js radius (coordinates added for this build) always returns the full <=2mi bounded set ---');

  await check('pullLeadSimpleComps() computes real distance_miles and returns every row out to <=2mi, even when enough of them are within 1 mile (the narrow cut no longer happens here)', async () => {
    const originalFetch = global.fetch;
    const subjectLat = 34.179615, subjectLon = -119.198962;
    const milesOffsets = [0.3, 0.5, 0.7, 0.9, 1.3, 1.7]; // 4 within 1mi, 2 more within 2mi
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/rest/v1/leadsimple_new_leases')) {
        return {
          ok: true,
          json: async () => milesOffsets.map((mi, i) => ({
            address: `${100 + i} Comp St`, city: 'Oxnard', state: 'CA', zip_code: '93036',
            property_type: 'Single Home', bedrooms: 3, bathrooms: 2, sqft: 1200,
            rent: 3000 + i, lease_start_date: '2026-06-01', closed_at: '2026-06-05',
            latitude: subjectLat + mi / 69.0, longitude: subjectLon,
          })),
        };
      }
      throw new Error('Unexpected fetch: ' + u);
    };
    try {
      const result = await pullLeadSimpleComps({ address: '1 Comp St, Oxnard, CA 93036', latitude: subjectLat, longitude: subjectLon });
      assert.equal(result.comps.length, 6, 'all 6 rows out to 2mi must be returned, regardless of how many are within 1 mile');
      assert.ok(result.comps.every(c => typeof c.distance_miles === 'number' && c.distance_miles <= WIDE_SEARCH_RADIUS_MILES));
    } finally {
      global.fetch = originalFetch;
    }
  });

  await check('pullLeadSimpleComps() still returns the full <=2mi bounded set when few rows are within 1 mile (same always-wide behavior, not a "fallback" anymore)', async () => {
    const originalFetch = global.fetch;
    const subjectLat = 34.179615, subjectLon = -119.198962;
    const milesOffsets = [0.3, 0.5, 1.3, 1.7]; // only 2 within 1mi
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/rest/v1/leadsimple_new_leases')) {
        return {
          ok: true,
          json: async () => milesOffsets.map((mi, i) => ({
            address: `${200 + i} Comp St`, city: 'Oxnard', state: 'CA', zip_code: '93036',
            rent: 3000 + i, lease_start_date: '2026-06-01', closed_at: '2026-06-05',
            latitude: subjectLat + mi / 69.0, longitude: subjectLon,
          })),
        };
      }
      throw new Error('Unexpected fetch: ' + u);
    };
    try {
      const result = await pullLeadSimpleComps({ address: '1 Comp St, Oxnard, CA 93036', latitude: subjectLat, longitude: subjectLon });
      assert.equal(result.comps.length, 4, 'all 4 rows out to 2mi returned, unconditionally');
    } finally {
      global.fetch = originalFetch;
    }
  });

  await check('pullLeadSimpleComps() drops a row beyond WIDE_SEARCH_RADIUS_MILES even though it shares the subject\'s zip code', async () => {
    const originalFetch = global.fetch;
    const subjectLat = 34.179615, subjectLon = -119.198962;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/rest/v1/leadsimple_new_leases')) {
        return {
          ok: true,
          json: async () => ([
            { address: '1 Near St', city: 'Oxnard', state: 'CA', zip_code: '93036', rent: 3000, lease_start_date: '2026-06-01', closed_at: '2026-06-05', latitude: subjectLat + 0.5 / 69.0, longitude: subjectLon },
            // Same zip on paper, but a real 4-mile-away outlier once geocoded — must be dropped.
            { address: '2 Far St', city: 'Oxnard', state: 'CA', zip_code: '93036', rent: 3100, lease_start_date: '2026-06-01', closed_at: '2026-06-05', latitude: subjectLat + 4.0 / 69.0, longitude: subjectLon },
          ]),
        };
      }
      throw new Error('Unexpected fetch: ' + u);
    };
    try {
      const result = await pullLeadSimpleComps({ address: '1 Near St, Oxnard, CA 93036', latitude: subjectLat, longitude: subjectLon });
      assert.equal(result.comps.length, 1, 'the 4-mile-away row must be dropped even though it matched on zip');
      assert.equal(result.comps[0].address.startsWith('1 Near St'), true);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await check('pullLeadSimpleComps() keeps a row with no coordinates of its own (never yet geocoded) even when the subject has coordinates, distance_miles left null', async () => {
    const originalFetch = global.fetch;
    const subjectLat = 34.179615, subjectLon = -119.198962;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/rest/v1/leadsimple_new_leases')) {
        return {
          ok: true,
          json: async () => ([
            { address: '1 Not Geocoded Yet', city: 'Oxnard', state: 'CA', zip_code: '93036', rent: 3000, lease_start_date: '2026-06-01', closed_at: '2026-06-05', latitude: null, longitude: null },
          ]),
        };
      }
      throw new Error('Unexpected fetch: ' + u);
    };
    try {
      const result = await pullLeadSimpleComps({ address: '1 Not Geocoded Yet, Oxnard, CA 93036', latitude: subjectLat, longitude: subjectLon });
      assert.equal(result.comps.length, 1, 'never dropped for lack of coordinates — no basis to compute or drop it');
      assert.equal(result.comps[0].distance_miles, null);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await check('pullLeadSimpleComps() falls back to exactly the zip-only behavior (no tiering, distance_miles null) when the subject itself has no coordinates', async () => {
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/rest/v1/leadsimple_new_leases')) {
        return {
          ok: true,
          json: async () => ([
            { address: '1 Test St', city: 'Oxnard', state: 'CA', zip_code: '93036', rent: 3000, lease_start_date: '2026-06-01', closed_at: '2026-06-05', latitude: 34.2, longitude: -119.2 },
          ]),
        };
      }
      throw new Error('Unexpected fetch: ' + u);
    };
    try {
      // No subject.latitude/longitude passed — same as a plain address-only call today.
      const result = await pullLeadSimpleComps({ address: '1 Test St, Oxnard, CA 93036' });
      assert.equal(result.comps.length, 1);
      assert.equal(result.comps[0].distance_miles, null, 'never computed without real subject coordinates, even though this row has its own');
    } finally {
      global.fetch = originalFetch;
    }
  });

  console.log('--- lib/market-data.js mapMarketData() ---');

  await check('mapMarketData() maps a real-shaped rentalData object to rental_market_data columns exactly (fixture from live zip 91320)', () => {
    // Field names/values match the live confirmed response for zip 91320
    // (see migration header + Q's own live check before writing this file).
    const rentalData = {
      lastUpdatedDate: '2026-08-17T00:00:00.000Z',
      averageRent: 4532, medianRent: 4495, minRent: 1400, maxRent: 9750,
      averageRentPerSquareFoot: 2.59, medianRentPerSquareFoot: 2.45,
      minRentPerSquareFoot: 0.61, maxRentPerSquareFoot: 4.9,
      averageSquareFootage: 1907, medianSquareFootage: 1768,
      minSquareFootage: 480, maxSquareFootage: 6629, // no columns for these — must be discarded
      averageDaysOnMarket: 25.89, medianDaysOnMarket: 13,
      minDaysOnMarket: 1, maxDaysOnMarket: 333, // no columns for these either — must be discarded
      newListings: 28, totalListings: 93,
      dataByBedrooms: [{ bedrooms: 0, averageRent: 2612 }],
      dataByPropertyType: [{ propertyType: 'Apartment', averageRent: 4000 }],
      history: { '2025-09': { averageRent: 4532 } },
    };
    const mapped = mapMarketData('91320', rentalData);
    assert.equal(mapped.zip, '91320');
    assert.equal(mapped.average_rent, 4532);
    assert.equal(mapped.median_rent, 4495);
    assert.equal(mapped.min_rent, 1400);
    assert.equal(mapped.max_rent, 9750);
    assert.equal(mapped.average_rent_per_sqft, 2.59);
    assert.equal(mapped.median_rent_per_sqft, 2.45);
    assert.equal(mapped.min_rent_per_sqft, 0.61);
    assert.equal(mapped.max_rent_per_sqft, 4.9);
    assert.equal(mapped.average_sqft, 1907);
    assert.equal(mapped.median_sqft, 1768);
    assert.equal(mapped.average_days_on_market, 25.89);
    assert.equal(mapped.median_days_on_market, 13);
    assert.equal(mapped.new_listings, 28);
    assert.equal(mapped.total_listings, 93);
    assert.deepEqual(mapped.data_by_bedrooms, [{ bedrooms: 0, averageRent: 2612 }]);
    assert.deepEqual(mapped.data_by_property_type, [{ propertyType: 'Apartment', averageRent: 4000 }]);
    assert.deepEqual(mapped.history, { '2025-09': { averageRent: 4532 } });
    assert.equal(mapped.rentcast_updated_at, '2026-08-17T00:00:00.000Z');
    assert.ok(typeof mapped.fetched_at === 'string' && !Number.isNaN(Date.parse(mapped.fetched_at)), 'fetched_at must be a real timestamp');
    // rental_market_data has no min/max sqft or min/max days-on-market
    // columns (per the migration) — confirms those fields are silently
    // discarded, not stuffed into the wrong column or thrown away with an error.
    assert.equal('min_sqft' in mapped, false);
    assert.equal('max_sqft' in mapped, false);
    assert.equal('min_days_on_market' in mapped, false);
    assert.equal('max_days_on_market' in mapped, false);
  });

  await check('mapMarketData() maps a zip with NO rental coverage (confirmed live: zip 96162 has no rentalData key at all) to a row of mostly-null stats, not a throw', () => {
    const mapped = mapMarketData('96162', {}); // fetchMarketData() passes {} when rentalData is absent
    assert.equal(mapped.zip, '96162');
    assert.equal(mapped.average_rent, null);
    assert.equal(mapped.median_rent, null);
    assert.equal(mapped.history, null);
    assert.equal(mapped.data_by_bedrooms, null);
    assert.equal(mapped.data_by_property_type, null);
    assert.equal(mapped.rentcast_updated_at, null);
    // fetched_at is still stamped — this is a real "checked, zero coverage"
    // row meant to be cached, not a rejected/empty result.
    assert.ok(typeof mapped.fetched_at === 'string');
  });

  console.log('--- lib/market-data.js fetchMarketData() ---');

  await check('fetchMarketData() requests the real /v1/markets endpoint with zipCode and maps the rentalData object', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.RENTCAST_API_KEY;
    process.env.RENTCAST_API_KEY = 'test-key';
    let requestedUrl = null;
    global.fetch = async (url) => {
      requestedUrl = url;
      return { ok: true, json: async () => ({ rentalData: { averageRent: 4532, medianRent: 4495 } }) };
    };
    try {
      const row = await fetchMarketData('91320');
      assert.match(requestedUrl, /\/v1\/markets\?/);
      assert.match(requestedUrl, /zipCode=91320/);
      assert.equal(row.average_rent, 4532);
      assert.equal(row.median_rent, 4495);
    } finally {
      global.fetch = originalFetch;
      process.env.RENTCAST_API_KEY = originalKey;
    }
  });

  await check('fetchMarketData() never throws when RentCast has no rentalData at all for the zip (confirmed live shape: zip 96162 -> only saleData, no rentalData key)', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.RENTCAST_API_KEY;
    process.env.RENTCAST_API_KEY = 'test-key';
    global.fetch = async () => ({ ok: true, json: async () => ({ id: '96162', zipCode: '96162', saleData: { averagePrice: 2000000 } }) });
    try {
      const row = await fetchMarketData('96162');
      assert.equal(row.zip, '96162');
      assert.equal(row.average_rent, null);
    } finally {
      global.fetch = originalFetch;
      process.env.RENTCAST_API_KEY = originalKey;
    }
  });

  await check('fetchMarketData() never throws (returns a mostly-null row instead) on a non-OK HTTP response', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.RENTCAST_API_KEY;
    process.env.RENTCAST_API_KEY = 'test-key';
    global.fetch = async () => ({ ok: false, status: 500, text: async () => 'RentCast is down' });
    try {
      const row = await fetchMarketData('91320');
      assert.equal(row.zip, '91320');
      assert.equal(row.average_rent, null);
    } finally {
      global.fetch = originalFetch;
      process.env.RENTCAST_API_KEY = originalKey;
    }
  });

  await check('fetchMarketData() never throws (returns a mostly-null row instead) when fetch itself rejects (network error)', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.RENTCAST_API_KEY;
    process.env.RENTCAST_API_KEY = 'test-key';
    global.fetch = async () => { throw new Error('network is down'); };
    try {
      const row = await fetchMarketData('91320');
      assert.equal(row.zip, '91320');
      assert.equal(row.average_rent, null);
    } finally {
      global.fetch = originalFetch;
      process.env.RENTCAST_API_KEY = originalKey;
    }
  });

  await check('fetchMarketData() DOES throw when RENTCAST_API_KEY is missing — a real setup problem, not a "no data" case (same rule as pullRentCastComps/lookupPropertyDetails)', async () => {
    const originalKey = process.env.RENTCAST_API_KEY;
    delete process.env.RENTCAST_API_KEY;
    try {
      await assert.rejects(() => fetchMarketData('91320'), /Missing RENTCAST_API_KEY/);
    } finally {
      process.env.RENTCAST_API_KEY = originalKey;
    }
  });

  console.log('--- lib/market-data.js normalizeZip() / isFresh() ---');

  await check('normalizeZip() accepts a plain 5-digit zip and normalizes a zip+4 down to 5 digits', () => {
    assert.equal(normalizeZip('91320'), '91320');
    assert.equal(normalizeZip('91320-1234'), '91320');
    assert.equal(normalizeZip(' 91320 '), '91320');
  });

  await check('normalizeZip() returns null for anything that is not a real 5-digit zip', () => {
    assert.equal(normalizeZip('9132'), null);
    assert.equal(normalizeZip('abcde'), null);
    assert.equal(normalizeZip(''), null);
    assert.equal(normalizeZip(null), null);
    assert.equal(normalizeZip(undefined), null);
    assert.equal(normalizeZip(91320), null); // number, not string — same strict typing as this codebase's other mappers
  });

  await check(`isFresh() treats a row fetched just now as fresh, and one older than FRESHNESS_WINDOW_DAYS (${FRESHNESS_WINDOW_DAYS} days) as stale`, () => {
    const now = new Date().toISOString();
    const wayOld = new Date(Date.now() - (FRESHNESS_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(isFresh(now), true);
    assert.equal(isFresh(wayOld), false);
    assert.equal(isFresh(null), false);
    assert.equal(isFresh(undefined), false);
  });

  console.log('--- lib/market-data.js getMarketData() (the cache) ---');

  // These mock global.fetch and route by URL — same approach the rest of
  // this test file uses (see pullRentCastComps()/suggestAddresses() tests
  // above), just routing between two different vendors (Supabase's REST API
  // and RentCast) instead of one, since getMarketData() is the one function
  // in this codebase that talks to both in a single call.
  function mockCacheFetch({ cachedRows = [], rentcastRentalData = {} } = {}) {
    const calls = { supabaseSelect: 0, supabaseUpsert: 0, rentcast: 0 };
    const fn = async (url, opts = {}) => {
      const u = String(url);
      const method = (opts && opts.method) || 'GET';
      if (u.includes('/rest/v1/rental_market_data') && method === 'GET') {
        calls.supabaseSelect++;
        return { ok: true, json: async () => cachedRows };
      }
      if (u.includes('/rest/v1/rental_market_data') && method === 'POST') {
        calls.supabaseUpsert++;
        const sentRows = JSON.parse(opts.body);
        return { ok: true, json: async () => (Array.isArray(sentRows) ? sentRows : [sentRows]) };
      }
      if (u.includes('api.rentcast.io/v1/markets')) {
        calls.rentcast++;
        return { ok: true, json: async () => ({ rentalData: rentcastRentalData }) };
      }
      throw new Error('Unexpected fetch call in getMarketData() test: ' + method + ' ' + u);
    };
    fn.calls = calls;
    return fn;
  }

  // SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are NOT overridden here — see the
  // note at the top of this file: lib/supabase.js captures them at
  // require() time, so mutating process.env now would have no effect. The
  // real values from .env (already loaded above) flow through instead;
  // mockCacheFetch() below matches on the request path, not the host, so it
  // doesn't matter that the URL is real.
  async function withMockedEnv(fetchImpl, fn) {
    const originalFetch = global.fetch;
    const originalRentcastKey = process.env.RENTCAST_API_KEY;
    global.fetch = fetchImpl;
    process.env.RENTCAST_API_KEY = 'test-rentcast-key';
    try {
      return await fn();
    } finally {
      global.fetch = originalFetch;
      process.env.RENTCAST_API_KEY = originalRentcastKey;
    }
  }

  await check('getMarketData() cache HIT: a fresh cached row is reused with NO RentCast call — this is the entire point of the feature', async () => {
    const freshRow = { zip: '91320', average_rent: 4500, fetched_at: new Date().toISOString() };
    const fetchImpl = mockCacheFetch({ cachedRows: [freshRow] });
    await withMockedEnv(fetchImpl, async () => {
      const result = await getMarketData('91320');
      assert.equal(result.average_rent, 4500);
      assert.equal(fetchImpl.calls.supabaseSelect, 1);
      assert.equal(fetchImpl.calls.rentcast, 0, 'a fresh cache hit must never call RentCast');
      assert.equal(fetchImpl.calls.supabaseUpsert, 0, 'a fresh cache hit must never write back to the DB');
    });
  });

  await check('getMarketData() cache MISS: no cached row -> fetches RentCast and upserts', async () => {
    const fetchImpl = mockCacheFetch({ cachedRows: [], rentcastRentalData: { averageRent: 4700, medianRent: 4650 } });
    await withMockedEnv(fetchImpl, async () => {
      const result = await getMarketData('93010');
      assert.equal(result.zip, '93010');
      assert.equal(result.average_rent, 4700);
      assert.equal(fetchImpl.calls.rentcast, 1, 'a cache miss must call RentCast exactly once');
      assert.equal(fetchImpl.calls.supabaseUpsert, 1, 'a cache miss must upsert the fresh row');
    });
  });

  await check('getMarketData() cache STALE: a cached row older than FRESHNESS_WINDOW_DAYS is refreshed from RentCast, not reused as-is', async () => {
    const staleRow = {
      zip: '93003',
      average_rent: 3900, // the stale value — must not be what's returned
      fetched_at: new Date(Date.now() - (FRESHNESS_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString(),
    };
    const fetchImpl = mockCacheFetch({ cachedRows: [staleRow], rentcastRentalData: { averageRent: 4100 } });
    await withMockedEnv(fetchImpl, async () => {
      const result = await getMarketData('93003');
      assert.equal(result.average_rent, 4100, 'a stale row must be replaced with the fresh RentCast value, not the old cached one');
      assert.equal(fetchImpl.calls.rentcast, 1, 'a stale cache entry must trigger exactly one RentCast call');
      assert.equal(fetchImpl.calls.supabaseUpsert, 1);
    });
  });

  await check('getMarketData() returns null without touching the network at all for a missing/invalid zip', async () => {
    const fetchImpl = mockCacheFetch({});
    await withMockedEnv(fetchImpl, async () => {
      assert.equal(await getMarketData(null), null);
      assert.equal(await getMarketData(''), null);
      assert.equal(await getMarketData('not-a-zip'), null);
      assert.equal(fetchImpl.calls.supabaseSelect, 0, 'an invalid zip must never even reach the cache lookup');
      assert.equal(fetchImpl.calls.rentcast, 0);
    });
  });

  console.log('--- lib/locationiq.js ---');

  await check('mapSuggestion() maps a real-shaped LocationIQ Autocomplete result to just {formattedAddress}', () => {
    // Field names match docs.locationiq.com/docs/autocomplete's documented
    // result shape (confirmed against LocationIQ's real docs, not guessed).
    const locationiqResult = {
      place_id: '321978604508',
      osm_id: '34633854',
      osm_type: 'way',
      licence: 'https://locationiq.com/attribution',
      lat: '40.7484284',
      lon: '-73.9856546198733',
      boundingbox: ['40.7479226', '40.7489422', '-73.9864855', '-73.9848259'],
      class: 'building',
      type: 'residential',
      display_name: '1895 Dorrit St, Newbury Park, Ventura County, California, 91320, United States of America',
      display_place: '1895 Dorrit St',
      display_address: 'Newbury Park, Ventura County, California, 91320, USA',
      address: { house_number: '1895', road: 'Dorrit St', city: 'Newbury Park', state: 'California', postcode: '91320', country: 'United States of America', country_code: 'us' },
    };
    const mapped = mapSuggestion(locationiqResult);
    assert.deepEqual(mapped, { formattedAddress: '1895 Dorrit St, Newbury Park, Ventura County, California, 91320, United States of America' });
    // Only formattedAddress — place_id/lat/lon/address breakdown/etc. must
    // not pass through; nothing downstream needs more than the string.
    assert.deepEqual(Object.keys(mapped), ['formattedAddress']);
  });

  await check('suggestAddresses() returns [] without calling fetch at all for a query under 3 characters (never wastes a request)', async () => {
    const originalFetch = global.fetch;
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => [] }; };
    try {
      assert.deepEqual(await suggestAddresses(''), []);
      assert.deepEqual(await suggestAddresses('1'), []);
      assert.deepEqual(await suggestAddresses('12'), []);
      assert.deepEqual(await suggestAddresses('  1 '), []); // whitespace-only-effective length still under 3
      assert.equal(fetchCalled, false, 'a too-short query must never reach fetch()');
    } finally {
      global.fetch = originalFetch;
    }
  });

  await check('suggestAddresses() maps a real-shaped multi-result response for a normal query', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.LOCATIONIQ_API_KEY;
    process.env.LOCATIONIQ_API_KEY = 'test-key';
    let requestedUrl = null;
    global.fetch = async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        json: async () => ([
          { display_name: '1895 Dorrit St, Newbury Park, CA 91320, United States of America' },
          { display_name: '1895 Dorrit Ave, Oxnard, CA 93030, United States of America' },
        ]),
      };
    };
    try {
      const suggestions = await suggestAddresses('1895 Dorrit');
      assert.deepEqual(suggestions, [
        { formattedAddress: '1895 Dorrit St, Newbury Park, CA 91320, United States of America' },
        { formattedAddress: '1895 Dorrit Ave, Oxnard, CA 93030, United States of America' },
      ]);
      // Confirms the key is sent as the documented `key` query param, not a
      // header (RentCast's convention) or a different param name.
      assert.match(requestedUrl, /[?&]key=test-key(&|$)/);
      assert.match(requestedUrl, /[?&]q=1895(\+|%20)Dorrit(&|$)/);
    } finally {
      global.fetch = originalFetch;
      process.env.LOCATIONIQ_API_KEY = originalKey;
    }
  });

  await check('suggestAddresses() returns [] (not a throw) on a non-OK HTTP response', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.LOCATIONIQ_API_KEY;
    process.env.LOCATIONIQ_API_KEY = 'test-key';
    global.fetch = async () => ({ ok: false, status: 401, text: async () => 'Invalid key' });
    try {
      assert.deepEqual(await suggestAddresses('1895 Dorrit St'), []);
    } finally {
      global.fetch = originalFetch;
      process.env.LOCATIONIQ_API_KEY = originalKey;
    }
  });

  await check('suggestAddresses() returns [] (not a throw) when fetch itself rejects (network error)', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.LOCATIONIQ_API_KEY;
    process.env.LOCATIONIQ_API_KEY = 'test-key';
    global.fetch = async () => { throw new Error('network is down'); };
    try {
      assert.deepEqual(await suggestAddresses('1895 Dorrit St'), []);
    } finally {
      global.fetch = originalFetch;
      process.env.LOCATIONIQ_API_KEY = originalKey;
    }
  });

  await check('suggestAddresses() returns [] (not a throw) when LocationIQ returns a non-array body (e.g. an error object)', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.LOCATIONIQ_API_KEY;
    process.env.LOCATIONIQ_API_KEY = 'test-key';
    global.fetch = async () => ({ ok: true, json: async () => ({ error: 'Invalid Request' }) });
    try {
      assert.deepEqual(await suggestAddresses('1895 Dorrit St'), []);
    } finally {
      global.fetch = originalFetch;
      process.env.LOCATIONIQ_API_KEY = originalKey;
    }
  });

  await check('suggestAddresses() throws a clear error when LOCATIONIQ_API_KEY is missing — the one case address-suggest\'s server.js route logs before still returning []', async () => {
    const originalKey = process.env.LOCATIONIQ_API_KEY;
    delete process.env.LOCATIONIQ_API_KEY;
    try {
      await assert.rejects(() => suggestAddresses('1895 Dorrit St'), /Missing LOCATIONIQ_API_KEY/);
    } finally {
      process.env.LOCATIONIQ_API_KEY = originalKey;
    }
  });

  console.log('--- lib/locationiq.js geocodeAddress() (added for LeadSimple coordinate backfill/sync) ---');

  await check('geocodeAddress() hits the /v1/search forward-geocoding endpoint (not /v1/autocomplete) and maps the first result to {latitude, longitude}', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.LOCATIONIQ_API_KEY;
    process.env.LOCATIONIQ_API_KEY = 'test-key';
    let requestedUrl = null;
    global.fetch = async (url) => {
      requestedUrl = String(url);
      return { ok: true, json: async () => ([{ lat: '34.179615', lon: '-119.198962', display_name: '1895 Dorrit St, Newbury Park, CA 91320' }]) };
    };
    try {
      const result = await geocodeAddress('1895 Dorrit St, Newbury Park, CA 91320');
      assert.ok(requestedUrl.startsWith('https://api.locationiq.com/v1/search?'), `expected the /v1/search endpoint, got ${requestedUrl}`);
      assert.deepEqual(result, { latitude: 34.179615, longitude: -119.198962 });
    } finally {
      global.fetch = originalFetch;
      process.env.LOCATIONIQ_API_KEY = originalKey;
    }
  });

  await check('geocodeAddress() returns null (not a throw) on a non-OK response, a network error, an empty array, or a non-numeric lat/lon', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.LOCATIONIQ_API_KEY;
    process.env.LOCATIONIQ_API_KEY = 'test-key';
    try {
      global.fetch = async () => ({ ok: false, json: async () => ({}) });
      assert.equal(await geocodeAddress('1 Bad Address'), null);

      global.fetch = async () => { throw new Error('network down'); };
      assert.equal(await geocodeAddress('1 Bad Address'), null);

      global.fetch = async () => ({ ok: true, json: async () => ([]) });
      assert.equal(await geocodeAddress('1 No Match Address'), null);

      global.fetch = async () => ({ ok: true, json: async () => ([{ lat: 'not-a-number', lon: '-119.2' }]) });
      assert.equal(await geocodeAddress('1 Bad Coords'), null);
    } finally {
      global.fetch = originalFetch;
      process.env.LOCATIONIQ_API_KEY = originalKey;
    }
  });

  await check('geocodeAddress() returns null for an empty/whitespace-only address without calling fetch, and throws when LOCATIONIQ_API_KEY is missing for a real address', async () => {
    const originalFetch = global.fetch;
    let called = false;
    global.fetch = async () => { called = true; return { ok: true, json: async () => ([]) }; };
    try {
      assert.equal(await geocodeAddress(''), null);
      assert.equal(await geocodeAddress('   '), null);
      assert.equal(called, false, 'must not spend a request on an empty address');

      const originalKey = process.env.LOCATIONIQ_API_KEY;
      delete process.env.LOCATIONIQ_API_KEY;
      try {
        await assert.rejects(() => geocodeAddress('1895 Dorrit St'), /Missing LOCATIONIQ_API_KEY/);
      } finally {
        process.env.LOCATIONIQ_API_KEY = originalKey;
      }
    } finally {
      global.fetch = originalFetch;
    }
  });

  console.log('--- lib/google-places.js ---');

  await check('mapSuggestion() maps a real-shaped Google Places Autocomplete (New) placePrediction to just {formattedAddress}', () => {
    // Field names match developers.google.com's real REST reference for
    // AutocompleteSuggestion/PlacePrediction/FormattableText (confirmed
    // against Google's real docs, not guessed) — this is the field-masked
    // shape this project's own request actually asks for
    // (X-Goog-FieldMask: suggestions.placePrediction.text.text).
    const googleSuggestion = {
      placePrediction: {
        text: { text: '1895 Dorrit St, Newbury Park, CA 91320, USA', matches: [{ startOffset: 0, endOffset: 4 }] },
      },
    };
    const mapped = mapSuggestionGoogle(googleSuggestion);
    assert.deepEqual(mapped, { formattedAddress: '1895 Dorrit St, Newbury Park, CA 91320, USA' });
    // Only formattedAddress — place/placeId/structuredFormat/types/etc.
    // must not pass through; nothing downstream needs more than the string.
    assert.deepEqual(Object.keys(mapped), ['formattedAddress']);
  });

  await check('mapSuggestion() returns null (not a throw) for a queryPrediction (a generic search suggestion with no real place behind it)', () => {
    // Google's Autocomplete (New) can mix queryPrediction entries into the
    // same suggestions array — this tool only wants real addresses, and
    // the field mask sent by suggestAddresses() means a query-only entry
    // comes back with neither `placePrediction` nor `queryPrediction`
    // populated, so this also covers a bare `{}` entry.
    assert.equal(mapSuggestionGoogle({ queryPrediction: { text: { text: 'pizza near me' } } }), null);
    assert.equal(mapSuggestionGoogle({}), null);
    assert.equal(mapSuggestionGoogle(null), null);
  });

  await check('suggestAddresses() returns [] without calling fetch at all for a query under 3 characters (never wastes a request)', async () => {
    const originalFetch = global.fetch;
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({ suggestions: [] }) }; };
    try {
      assert.deepEqual(await suggestAddressesGoogle(''), []);
      assert.deepEqual(await suggestAddressesGoogle('1'), []);
      assert.deepEqual(await suggestAddressesGoogle('12'), []);
      assert.deepEqual(await suggestAddressesGoogle('  1 '), []); // whitespace-only-effective length still under 3
      assert.equal(fetchCalled, false, 'a too-short query must never reach fetch()');
    } finally {
      global.fetch = originalFetch;
    }
  });

  await check('suggestAddresses() POSTs to places:autocomplete with the documented auth header, field mask, and JSON body — and maps a real-shaped multi-result response', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.GOOGLE_PLACES_API_KEY;
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    let requestedUrl = null;
    let requestedOptions = null;
    global.fetch = async (url, options) => {
      requestedUrl = url;
      requestedOptions = options;
      return {
        ok: true,
        json: async () => ({
          suggestions: [
            { placePrediction: { text: { text: '1895 Dorrit St, Newbury Park, CA 91320, USA' } } },
            { placePrediction: { text: { text: '1895 Dorrit Ave, Oxnard, CA 93030, USA' } } },
          ],
        }),
      };
    };
    try {
      const suggestions = await suggestAddressesGoogle('1895 Dorrit');
      assert.deepEqual(suggestions, [
        { formattedAddress: '1895 Dorrit St, Newbury Park, CA 91320, USA' },
        { formattedAddress: '1895 Dorrit Ave, Oxnard, CA 93030, USA' },
      ]);
      // Confirms this hits the real documented endpoint, not a guessed one.
      assert.equal(requestedUrl, 'https://places.googleapis.com/v1/places:autocomplete');
      assert.equal(requestedOptions.method, 'POST');
      // Confirms the key is sent as the documented `X-Goog-Api-Key` header,
      // not a query param (LocationIQ's convention) or RentCast's
      // `X-Api-Key` header name.
      assert.equal(requestedOptions.headers['X-Goog-Api-Key'], 'test-key');
      // Confirms the field mask requests exactly (and only) the field
      // mapSuggestion() needs — never anything that would pull in a Place
      // Details-priced field.
      assert.equal(requestedOptions.headers['X-Goog-FieldMask'], 'suggestions.placePrediction.text.text');
      const body = JSON.parse(requestedOptions.body);
      assert.equal(body.input, '1895 Dorrit');
      assert.deepEqual(body.includedRegionCodes, ['us']);
      assert.ok(body.locationRestriction && body.locationRestriction.rectangle, 'expected a locationRestriction.rectangle to hard-restrict to Southern California');
    } finally {
      global.fetch = originalFetch;
      process.env.GOOGLE_PLACES_API_KEY = originalKey;
    }
  });

  await check('suggestAddresses() caps results at 5 even when Google returns more', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.GOOGLE_PLACES_API_KEY;
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        suggestions: Array.from({ length: 8 }, (_, i) => ({ placePrediction: { text: { text: `${100 + i} Dorrit St, Newbury Park, CA` } } })),
      }),
    });
    try {
      const suggestions = await suggestAddressesGoogle('Dorrit St');
      assert.equal(suggestions.length, 5);
    } finally {
      global.fetch = originalFetch;
      process.env.GOOGLE_PLACES_API_KEY = originalKey;
    }
  });

  await check('suggestAddresses() skips queryPrediction entries mixed into a real response rather than passing them through', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.GOOGLE_PLACES_API_KEY;
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        suggestions: [
          { placePrediction: { text: { text: '1895 Dorrit St, Newbury Park, CA 91320, USA' } } },
          { queryPrediction: { text: { text: 'dorrit street apartments' } } },
        ],
      }),
    });
    try {
      const suggestions = await suggestAddressesGoogle('Dorrit');
      assert.deepEqual(suggestions, [{ formattedAddress: '1895 Dorrit St, Newbury Park, CA 91320, USA' }]);
    } finally {
      global.fetch = originalFetch;
      process.env.GOOGLE_PLACES_API_KEY = originalKey;
    }
  });

  await check('suggestAddresses() returns [] (not a throw) on a non-OK HTTP response', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.GOOGLE_PLACES_API_KEY;
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    global.fetch = async () => ({ ok: false, status: 403, text: async () => 'API key not valid' });
    try {
      assert.deepEqual(await suggestAddressesGoogle('1895 Dorrit St'), []);
    } finally {
      global.fetch = originalFetch;
      process.env.GOOGLE_PLACES_API_KEY = originalKey;
    }
  });

  await check('suggestAddresses() returns [] (not a throw) when fetch itself rejects (network error)', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.GOOGLE_PLACES_API_KEY;
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    global.fetch = async () => { throw new Error('network is down'); };
    try {
      assert.deepEqual(await suggestAddressesGoogle('1895 Dorrit St'), []);
    } finally {
      global.fetch = originalFetch;
      process.env.GOOGLE_PLACES_API_KEY = originalKey;
    }
  });

  await check('suggestAddresses() returns [] (not a throw) when Google returns a body with no suggestions array (e.g. an error object)', async () => {
    const originalFetch = global.fetch;
    const originalKey = process.env.GOOGLE_PLACES_API_KEY;
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    global.fetch = async () => ({ ok: true, json: async () => ({ error: { code: 400, message: 'Invalid request' } }) });
    try {
      assert.deepEqual(await suggestAddressesGoogle('1895 Dorrit St'), []);
    } finally {
      global.fetch = originalFetch;
      process.env.GOOGLE_PLACES_API_KEY = originalKey;
    }
  });

  await check('suggestAddresses() throws a clear error when GOOGLE_PLACES_API_KEY is missing — the one case address-suggest\'s server.js route logs before still returning []', async () => {
    const originalKey = process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.GOOGLE_PLACES_API_KEY;
    try {
      await assert.rejects(() => suggestAddressesGoogle('1895 Dorrit St'), /Missing GOOGLE_PLACES_API_KEY/);
    } finally {
      process.env.GOOGLE_PLACES_API_KEY = originalKey;
    }
  });

  console.log(`\n${passed} check(s) passed.${process.exitCode ? ' SOME CHECKS FAILED — see FAIL lines above.' : ''}`);
}

main();
