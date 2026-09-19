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

const { percentile, computeRecommendedRange, computeRawRange, buildWeightedSample, excludeRinconManaged, isExcludedRinconManaged, SELF_SOURCED_TRUSTED_SOURCE_NAMES, sizeSimilarityMultiplier } = require('./lib/weighting');
const { mapComparable, mapListingStatus, assessPlausibility, pullRentCastComps, lookupPropertyDetails } = require('./lib/rentcast');
const {
  mapComparable: mapCrmlsComparable,
  haversineMiles,
  buildBoundingBox,
  buildFilter: buildCrmlsFilter,
  pullCrmlsComps,
  SEARCH_RADIUS_MILES,
} = require('./lib/crmls');
const {
  mapComparable: mapLeadSimpleComparable,
  buildAddress: buildLeadSimpleAddress,
  pullLeadSimpleComps,
  FROM_LEADSIMPLE_PROPERTY_TYPE,
} = require('./lib/leadsimple');
const { findBestPropertyMatch, normalizeAddress, houseNumber, hasParseableHouseNumber, unitIdentifier, addressesMatch, dedupeComps } = require('./lib/property-matching');
const { parseNarrativeOutput, buildPrompt, describeComp } = require('./lib/narrative');
const { suggestAddresses, mapSuggestion } = require('./lib/locationiq');
const marketDataLib = require('./lib/market-data');
const { mapMarketData, fetchMarketData, getMarketData, normalizeZip, isFresh, FRESHNESS_WINDOW_DAYS } = marketDataLib;
const sourcesLib = require('./lib/sources');
const { runActiveSources } = sourcesLib;

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
          { formattedAddress: '123 Main St, Newbury Park, CA 91320', state: 'CA', distance: 0.8, latitude: 34.180001, longitude: -119.199501 },
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
    const lat = 34.179615, lon = -119.198962, radius = SEARCH_RADIUS_MILES;
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

  await check('pullCrmlsComps() runs a lat/long bounding-box search (not PostalCode) when subject coordinates are present, and post-filters to a true circle — drops a box-corner record beyond SEARCH_RADIUS_MILES, keeps a near one with a real nonzero distance_miles', async () => {
    const originalFetch = global.fetch;
    const originalToken = process.env.RECORE_SERVER_TOKEN;
    process.env.RECORE_SERVER_TOKEN = 'test-token';

    const subjectLat = 34.179615, subjectLon = -119.198962;
    const box = buildBoundingBox(subjectLat, subjectLon, SEARCH_RADIUS_MILES);
    const baseFields = {
      StandardStatus: 'Closed', PropertySubType: 'Single Family Residence',
      StreetSuffix: 'St', City: 'Newbury Park', StateOrProvince: 'CA', PostalCode: '91320', ClosePrice: 4300,
    };
    // Just inside the box, close to center — must survive the circle filter with a real distance_miles.
    const nearRecord = { ...baseFields, StreetNumberNumeric: 100, StreetName: 'Near', Latitude: subjectLat + 0.001, Longitude: subjectLon };
    // Sits exactly at the box's own corner — inside the box's lat/lon range,
    // but per the "corners are farther than edges" math above, actually
    // outside a true SEARCH_RADIUS_MILES circle — must be dropped.
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
      assert.ok(typeof result.comps[0].distance_miles === 'number' && result.comps[0].distance_miles > 0 && result.comps[0].distance_miles <= SEARCH_RADIUS_MILES,
        `expected a real, nonzero distance_miles <= ${SEARCH_RADIUS_MILES}, got ${result.comps[0].distance_miles}`);
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

  console.log(`\n${passed} check(s) passed.${process.exitCode ? ' SOME CHECKS FAILED — see FAIL lines above.' : ''}`);
}

main();
