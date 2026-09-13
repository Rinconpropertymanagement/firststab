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

const { percentile, computeRecommendedRange, computeRawRange, buildWeightedSample, excludeRinconManaged } = require('./lib/weighting');
const { mapComparable, mapListingStatus, assessPlausibility, pullRentCastComps, lookupPropertyDetails } = require('./lib/rentcast');
const { findBestPropertyMatch, normalizeAddress, houseNumber, hasParseableHouseNumber, unitIdentifier } = require('./lib/property-matching');
const { parseNarrativeOutput } = require('./lib/narrative');
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

  await check('buildWeightedSample() repeats each rent by its status weight', () => {
    const sample = buildWeightedSample([
      { monthly_rent: 100, listing_status: 'off_market' }, // weight 1
      { monthly_rent: 200, listing_status: 'leased' },     // weight 3
    ]);
    assert.equal(sample.length, 4);
    assert.equal(sample.filter(n => n === 200).length, 3);
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

  console.log('--- lib/sources.js ---');

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
