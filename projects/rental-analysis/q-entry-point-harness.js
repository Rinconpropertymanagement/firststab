#!/usr/bin/env node
/**
 * q-entry-point-harness.js
 * Runs the REAL "run analysis" request handler end to end, with nothing real
 * behind it, and checks what comes out and what would have been saved.
 *
 *   node q-entry-point-harness.js server     the standalone app (server.js)
 *   node q-entry-point-harness.js router     the Hub section (hub/rental-analysis/router.js)
 *   node q-entry-point-harness.js --help
 *
 * "Nothing real" means: a pretend database that enforces the same rules as the
 * real one (the migration's fixed word lists, lengths, the $200 range rule, the
 * rule that a finished report may have no numbers only when fewer than 4 comps
 * counted, and the rule that a key left out of some rows of a bulk save becomes
 * NULL), pretend comp sources, a pretend writer for the explanation, and a
 * network that refuses every outside address. No RentCast, Recore or Anthropic
 * request can leave this process.
 *
 * It checks, for each handler: a normal mixed-source report; the three owner
 * goals; a Low-confidence report (no stretch price); a thin report (fewer than 4
 * counted comps: finished, no range, no prices); a report where comps exist but
 * none counted; sources that ran fine but found nothing (finished, no writer
 * call, nothing saved but the analysis); sources that all broke, and the mixed
 * case (failed); bad inputs (refused before anything is saved); and that the
 * answer never carries the old wide computed range; that the written explanation
 * is told only the sources that supplied a comp; and that absurd sizes, a text
 * "false" in the Furnished box and hidden control characters are dealt with before
 * anything is saved.
 *
 * Exits 0 when everything holds, 1 otherwise.
 */
const assert = require('node:assert/strict');
const path = require('node:path');

if (process.argv.includes('--help') || !['server', 'router'].includes(process.argv[2])) {
  console.log(`
q-entry-point-harness.js - runs the real request handler against a pretend database.

Usage:
  node q-entry-point-harness.js server    the standalone app
  node q-entry-point-harness.js router    the Hub section
Nothing leaves this computer: every outside network address is refused.
Exits 0 when every check holds, 1 otherwise.
`);
  process.exit(process.argv.includes('--help') ? 0 : 1);
}
const MODE = process.argv[2];
// A free port picked by the operating system each run (two runs started at the same moment used to collide on a
// fixed pair of ports). Asked of a short child process so it can be had before anything else starts.
const PORT = Number(require('node:child_process').execFileSync(process.execPath, ['-e',
  "const s = require('node:net').createServer(); s.listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); });"], { encoding: 'utf8' }).trim());

process.env.SUPABASE_URL = 'http://mock-supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-key';
process.env.SUPABASE_ANON_KEY = 'mock-anon';
process.env.ANTHROPIC_API_KEY = 'mock-key';
// A made-up Recore access key: the real one (from the .env file the app loads) is never used here, and the pretend MLS below answers instead.
process.env.RECORE_SERVER_TOKEN = 'mock-recore-token';
process.env.RENTAL_ANALYSIS_PORT = String(PORT);
const APP_ROOT = MODE === 'server' ? __dirname : path.join(__dirname, '..', 'hub', 'rental-analysis');
process.chdir(APP_ROOT);

const realFetch = global.fetch;
const log = { analysisInserts: [], analysisUpdates: [], compInserts: [], narrativeCalls: 0, blocked: [], leadsimpleQueries: [], mlsRequests: [] };

// ─── the pretend database ───────────────────────────────────────────────────
const PROPERTY_TYPES = ['single_family', 'condo', 'townhouse', 'duplex', 'triplex', 'fourplex', 'apartment', 'manufactured', 'other'];
const FLAGS = ['furnished', 'partly_furnished', 'short_term', 'age_restricted', 'hoa', 'private_pool', 'utilities_included', 'water_trash_included', 'gardener_included', 'new_construction', 'adu_or_guest_house', 'view_property'];
const TAGS = ['remodeled', 'new_build', 'stone_counters', 'new_flooring', 'new_cabinets', 'updated_kitchen', 'updated_baths', 'cosmetic_updates', 'original_finishes', 'needs_repair'];
const refuse = message => { const e = new Error(message); e.db = true; throw e; };

function checkCompRow(r) {
  for (const k of ['analysis_id', 'source_id', 'address', 'monthly_rent', 'is_estimated_price', 'had_price_cut', 'listing_status', 'is_rincon_managed', 'mls_flags', 'condition_tags']) {
    if (r[k] === null || r[k] === undefined) refuse(`NOT NULL violated: ${k}`);
  }
  if (r.property_type !== null && !PROPERTY_TYPES.includes(r.property_type)) refuse('property_type');
  if (r.sqft !== null && !(r.sqft > 0)) refuse('sqft');
  if (!(r.monthly_rent >= 0)) refuse('rent');
  if (!['active', 'leased', 'off_market'].includes(r.listing_status)) refuse('listing_status');
  if (r.mls_listing_id !== null && r.mls_listing_id.length > 40) refuse('mls_listing_id');
  if (r.year_built !== null && !(r.year_built >= 1800 && r.year_built <= 2100)) refuse('year_built');
  if (r.furnished_status !== null && !['furnished', 'unfurnished', 'partial', 'either'].includes(r.furnished_status)) refuse('furnished_status');
  if (r.lease_term_class !== null && !['long', 'short', 'six_month'].includes(r.lease_term_class)) refuse('lease_term_class');
  if (!Array.isArray(r.mls_flags) || !r.mls_flags.every(f => FLAGS.includes(f))) refuse('mls_flags vocabulary');
  if (r.condition_rating !== null && r.condition_basis !== 'listing_text') refuse('a rating needs listing_text');
  if (!Array.isArray(r.condition_tags) || !r.condition_tags.every(f => TAGS.includes(f))) refuse('condition_tags vocabulary');
}

// The same rules as supabase/migrations/20261018000000_rental_cma_quality.sql
function checkAnalysis(a) {
  if (typeof a.subject_age_restricted !== 'boolean') refuse('subject_age_restricted must be true or false');
  if (a.subject_subdivision != null && a.subject_subdivision.length > 120) refuse('subject_subdivision');
  if (a.size_band_pct != null && !(a.size_band_pct >= 1 && a.size_band_pct <= 100)) refuse('size_band_pct');
  const mod = (v, m) => v % m === 0;
  if (a.headline_range_low != null && !(a.headline_range_low >= 0 && mod(a.headline_range_low, 100))) refuse('headline_range_low');
  if (a.headline_range_high != null && !(a.headline_range_high >= 0 && mod(a.headline_range_high, 100))) refuse('headline_range_high');
  if (a.suggested_list_price != null && !(a.suggested_list_price >= 0 && mod(a.suggested_list_price, 50))) refuse('suggested_list_price');
  if (a.stretch_price != null && !(a.stretch_price >= 0 && mod(a.stretch_price, 50))) refuse('stretch_price');
  if (a.owner_goal != null && !['lease_quickly', 'balanced', 'maximize_rent'].includes(a.owner_goal)) refuse('owner_goal');
  if (a.confidence_label != null && !['high', 'medium', 'low'].includes(a.confidence_label)) refuse('confidence_label');
  if (a.confidence_spread != null && !(a.confidence_spread >= 0)) refuse('confidence_spread');
  if (a.counted_comp_count != null && !(a.counted_comp_count >= 0)) refuse('counted_comp_count');
  if (a.counted_leased_count != null && !(a.counted_leased_count >= 0)) refuse('counted_leased_count');
  if (a.method_version != null && a.method_version.length > 40) refuse('method_version');
  const allNull = a.headline_range_low == null && a.headline_range_high == null && a.suggested_list_price == null && a.stretch_price == null;
  const consistent = a.headline_range_low != null && a.headline_range_high != null && a.suggested_list_price != null
    && a.headline_range_high - a.headline_range_low === 200
    && a.suggested_list_price >= a.headline_range_low && a.suggested_list_price <= a.headline_range_high
    && (a.stretch_price == null || a.stretch_price === a.headline_range_high + 200);
  if (!allNull && !consistent) refuse('chk_headline_range');
  if (a.status === 'complete') {
    const strict = a.recommended_rent_low != null && a.recommended_rent_mid != null && a.recommended_rent_high != null;
    const thin = a.counted_comp_count != null && a.counted_comp_count < 4
      && a.recommended_rent_low == null && a.recommended_rent_mid == null && a.recommended_rent_high == null && allNull;
    if (!strict && !thin) refuse('chk_complete_requires_rent_range');
  }
}

const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
let analysisRow = null, compCounter = 0;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith(`http://127.0.0.1:${PORT}`)) return realFetch(url, opts);
  // the area market numbers are looked up by zip after the report is saved; the pretend answer is "no coverage" (never a real call)
  if (u.startsWith('https://api.rentcast.io/v1/markets')) return json({ error: 'no market data in this test' }, 404);
  // The pretend MLS (Recore) the Rincon lease-type check asks. By default it knows nothing; a scenario can supply its own answer
  // (records for the addresses asked about, a failure). It never leaves this process.
  if (u.startsWith('https://api.marketplace.recore.net/api/v2/OData/crmls/Property?')) {
    log.mlsRequests.push(u.replace(/access_token=[^&]*/, 'access_token=HIDDEN'));
    return scenario && scenario.mls ? scenario.mls(u) : json({ value: [] });
  }
  if (!u.startsWith('http://mock-supabase.test/rest/v1/')) { log.blocked.push(u.slice(0, 60)); throw new Error(`NETWORK BLOCKED: ${u.slice(0, 60)}`); }
  const [table] = u.replace('http://mock-supabase.test/rest/v1/', '').split('?');
  const method = opts.method || 'GET';
  try {
    if (method === 'GET') {
      if (table === 'team_members') return json({ id: 't1', full_name: 'Test', is_active: true });
      if (table === 'team_member_tool_roles') return json({ role: 'admin' });
      if (table === 'users') return json([{ id: '11111111-1111-1111-1111-111111111111' }]);
      if (table === 'properties') return json([{ id: 'p-1', address: '100 Rincon Way', city: 'Ventura', state: 'CA', zip: '93001' }]);
      if (table === 'leadsimple_new_leases') {
        // Rincon's own move-in leases: one row, returned only when the search is for zip 93003 (so the zip used is visible)
        log.leadsimpleQueries.push(u);
        return json(u.includes('zip_code=eq.93003') ? (scenario.leaseRows || [{ id: 'r1', address: '200 Rincon St', city: 'Ventura', state: 'CA', zip_code: '93003', property_type: 'Single Home', bedrooms: 4, bathrooms: 2, sqft: 1600, rent: 4400, lease_start_date: '2026-06-01', closed_at: '2026-06-10', latitude: 34.2012, longitude: -119.2 }]) : []);
      }
      if (table === 'rental_comp_sources') return json([{ id: 'src-r', name: 'RentCast' }, { id: 'src-c', name: 'CRMLS' }, { id: 'src-l', name: 'LeadSimple Move-Ins' }]);
      return json([]);
    }
    const body = JSON.parse(opts.body);
    if (table === 'rental_analyses' && method === 'POST') { checkAnalysis({ ...body }); log.analysisInserts.push(body); analysisRow = { id: 'an-1', ...body }; return json([analysisRow], 201); }
    if (table === 'rental_analyses' && method === 'PATCH') { log.analysisUpdates.push(body); analysisRow = { ...analysisRow, ...body }; checkAnalysis(analysisRow); return json([analysisRow]); }
    if (table === 'rental_comps' && method === 'POST') {
      const rows = Array.isArray(body) ? body : [body];
      // a key missing from some rows of a bulk save becomes NULL (not the column's usual starting value)
      const union = [...new Set(rows.flatMap(r => Object.keys(r)))];
      const filled = rows.map(r => Object.fromEntries(union.map(k => [k, r[k] === undefined ? null : r[k]])));
      log.compInserts.push({ rows, union });
      const withDefaults = filled.map(r => ({ mls_flags: [], condition_tags: [], is_estimated_price: false, had_price_cut: false, is_rincon_managed: false, age_restricted: null, ...r }));
      withDefaults.forEach(checkCompRow);
      return json(withDefaults.map(r => ({ id: `c-${++compCounter}`, ...r })), 201);
    }
    return json([]);
  } catch (e) {
    if (e.db) return json({ code: '23514', message: e.message }, 400);
    throw e;
  }
};

// ─── pretend writer and pretend sources ─────────────────────────────────────
const narrative = require(path.join(APP_ROOT, 'lib', 'narrative'));
let narrativeInputs = [];
narrative.generateNarrative = async (input) => { log.narrativeCalls++; narrativeInputs.push(input); return { rationale: 'test rationale', narrativesByIndex: input.comps.map(() => null) }; };
const sourcesLib = require(path.join(APP_ROOT, 'lib', 'sources'));
const crmls = require(path.join(APP_ROOT, 'lib', 'crmls'));
const rentcast = require(path.join(APP_ROOT, 'lib', 'rentcast'));
const leadsimple = require(path.join(APP_ROOT, 'lib', 'leadsimple'));
const { COMP_ROW_COLUMNS } = require(path.join(APP_ROOT, 'lib', 'comp-rows'));
const { makeFakeRecoreFetch } = require(path.join(__dirname, 'backtest', 'tests', 'fake-recore-mls'));

const rec = o => ({
  ListingKey: 'k', ListingId: 'V1-1', StandardStatus: 'Closed', PropertySubType: 'Single Family Residence', StreetNumberNumeric: 100, StreetName: 'Oak', StreetSuffix: 'Street',
  City: 'Ventura', StateOrProvince: 'CA', PostalCode: '93003', BedroomsTotal: 4, BathroomsTotalDecimal: 2, ListPrice: 4000, ClosePrice: 4000, OriginalListPrice: 4000,
  CloseDate: '2026-09-01', OnMarketDate: '2026-08-01', Latitude: 34.2, Longitude: -119.2, LivingArea: 1600, Furnished: 'Unfurnished', LeaseTerm: '12 Months', SeniorCommunityYN: false, ...o,
});
// closed (leased) comps at the given rents, or active listings when the status is 'Active'
const crmlsComps = (rents, status = 'Closed') => rents.map((rent, i) => crmls.mapComparable(
  rec({ ListingKey: `k${i}`, ListingId: `V1-${i}`, StreetNumberNumeric: 10 + i, StandardStatus: status, ClosePrice: status === 'Closed' ? rent : null, ListPrice: rent, CloseDate: status === 'Closed' ? '2026-09-01' : null }),
  0.1 + i * 0.03));

let scenario = null;
sourcesLib.SOURCE_HANDLERS.RentCast = async () => {
  if (scenario.rentcast === 'throw') throw new Error('RentCast is down');
  return {
    subjectEstimatedRent: 4100, subjectLatitude: 34.2, subjectLongitude: -119.2, subjectZip: scenario.zip === undefined ? null : scenario.zip, comps: scenario.rentcastComps || [],
    ...(scenario.rentcastPartial ? { partialFailure: [{ what: 'its search of nearby rental listings', message: 'status 500' }] } : {}),
  };
};
sourcesLib.SOURCE_HANDLERS.CRMLS = async () => {
  if (scenario.crmls === 'throw') throw new Error('Recore is down');
  return { subjectZip: null, comps: scenario.crmlsComps || [], ...(scenario.crmlsPartial ? { partialFailure: [{ what: 'its recently leased homes', message: 'Closed query rejected' }] } : {}) };
};
const mockLeadSimple = async () => ({
  subjectZip: null,
  comps: scenario.leadsimple ? [leadsimple.mapComparable({ id: 'r1', address: '200 Rincon St', city: 'Ventura', state: 'CA', zip_code: '93003', property_type: 'Single Home', bedrooms: 4, bathrooms: 2, sqft: 1600, rent: 4400, lease_start_date: '2026-06-01' }, 0.2)] : [],
});
// the real Rincon move-in search (against the pretend database) when a scenario asks for it, so the zip it uses can be seen
sourcesLib.SOURCE_HANDLERS['LeadSimple Move-Ins'] = subject => (scenario.realLeadSimple ? leadsimple.pullLeadSimpleComps(subject) : mockLeadSimple(subject));

if (MODE === 'server') {
  require(path.join(APP_ROOT, 'server.js'));
} else {
  const express = require(path.join(APP_ROOT, '..', 'node_modules', 'express'));
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 'u1' }; next(); });
  app.use(require(path.join(APP_ROOT, 'router.js')).router);
  app.listen(PORT, '127.0.0.1');
}

const post = async body => {
  const res = await realFetch(`http://127.0.0.1:${PORT}/api/rental-analysis/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const good = { subject_address: '2461 Bunting Avenue, Ventura, CA 93003', subject_bedrooms: 4, subject_bathrooms: 2, subject_sqft: 1636, subject_property_type: 'single_family', lease_term_months: 12, furnished: false, run_by: '11111111-1111-1111-1111-111111111111' };
const AUDIT = ['recommended_rent_low', 'recommended_rent_mid', 'recommended_rent_high', 'raw_comp_rent_low', 'raw_comp_rent_high', 'confidence_spread'];

function reset() { leadsimple.clearMlsTypeCache(); log.mlsRequests.length = 0; log.leadsimpleQueries.length = 0; log.analysisInserts.length = 0; log.analysisUpdates.length = 0; log.compInserts.length = 0; log.narrativeCalls = 0; narrativeInputs = []; analysisRow = null; }
async function run(name, sc, extra = {}) {
  reset();
  scenario = sc;
  const r = await post({ ...good, ...extra });
  console.log(`  ${name}: HTTP ${r.status}`);
  return r;
}
// no key anywhere in the answer may be an audit column, and no text anywhere may spell out a span of $500 or more
function assertNoWideRange(body) {
  const walk = (x, where) => {
    if (x && typeof x === 'object') { for (const [k, v] of Object.entries(x)) { assert.ok(!AUDIT.includes(k), `${where}.${k} is an audit-only column and must not be in the answer`); walk(v, `${where}.${k}`); } }
  };
  walk(body, 'answer');
}

(async () => {
  await new Promise(resolve => setTimeout(resolve, 500));
  const lastUpdate = () => log.analysisUpdates[log.analysisUpdates.length - 1];

  // 1. High: six leased comps that agree
  let r = await run('High report (6 leased comps that agree)', { crmlsComps: crmlsComps([4300, 4350, 4400, 4400, 4450, 4500]) });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.body.confidence.label, 'high');
  assert.equal(r.body.headline.high - r.body.headline.low, 200);
  assert.equal(r.body.headline.goal, 'balanced');
  assert.equal(r.body.headline.stretchPrice, r.body.headline.high + 200);
  assert.equal(r.body.headline.stretchWords, 'Above the recommended range; may take longer to lease');
  assert.equal(r.body.headline.lowLabel, 'Lease quickly');
  assert.equal(r.body.headline.highLabel, 'Hold out for more');
  assert.equal(r.body.confidence.firmUp, null);
  assert.equal(r.body.noRange, null);
  assert.equal(r.body.counted.total, 6);
  assert.equal(r.body.counted.leased, 6);
  assertNoWideRange(r.body);
  let u = lastUpdate();
  assert.equal(u.status, 'complete');
  assert.equal(u.counted_comp_count, 6);
  assert.equal(u.counted_leased_count, 6);
  assert.equal(u.headline_range_low, r.body.headline.low);
  assert.equal(u.stretch_price, r.body.headline.stretchPrice);
  assert.equal(u.suggested_list_price, r.body.headline.listPrice);
  assert.equal(u.confidence_label, 'high');
  assert.equal(u.owner_goal, 'balanced');
  assert.equal(u.method_version, 'cma-2026-10-v2');
  assert.ok(u.recommended_rent_low != null && u.recommended_rent_mid != null && u.recommended_rent_high != null, 'the audit columns are still written when 4 or more comps counted');
  assert.equal(narrativeInputs[0].headline.low, r.body.headline.low, 'the write-up is told the recommended range');
  assert.ok(!('recommended' in narrativeInputs[0]) && !('raw' in narrativeInputs[0]), 'the write-up is NOT given the old wide computed range');
  assert.deepEqual(narrativeInputs[0].sourcesUsed, ['CRMLS'], 'RentCast and LeadSimple ran fine but supplied no comp, so the write-up is not told to name them');
  for (const row of log.compInserts[0].rows) { assert.ok(Array.isArray(row.mls_flags)); assert.ok(Array.isArray(row.condition_tags)); }

  // 2. The three owner goals change only the suggested price
  const prices = {};
  for (const goal of ['lease_quickly', 'balanced', 'maximize_rent']) {
    r = await run(`owner goal ${goal}`, { crmlsComps: crmlsComps([4000, 4150, 4300, 4450, 4600, 4750]) }, { owner_goal: goal });
    assert.equal(r.status, 200);
    assert.equal(r.body.headline.goal, goal);
    assert.equal(lastUpdate().owner_goal, goal);
    prices[goal] = r.body;
  }
  assert.equal(prices.lease_quickly.headline.listPrice, prices.lease_quickly.headline.low);
  assert.equal(prices.maximize_rent.headline.listPrice, prices.maximize_rent.headline.high);
  assert.equal(prices.balanced.headline.listPrice % 50, 0);
  for (const g of ['lease_quickly', 'maximize_rent']) {
    assert.equal(prices[g].headline.low, prices.balanced.headline.low, 'the goal never moves the range');
    assert.equal(prices[g].headline.stretchPrice, prices.balanced.headline.stretchPrice, 'the goal never moves the stretch price');
    assert.equal(prices[g].confidence.label, prices.balanced.confidence.label, 'the goal never moves the label');
  }
  assert.equal(prices.balanced.confidence.label, 'medium');
  assert.ok(prices.balanced.confidence.firmUp, 'a Medium report carries the firm-this-up line');

  // 3. Low: 4 comps, two of them leased: range shown, no stretch price
  r = await run('Low report (4 comps)', { crmlsComps: [...crmlsComps([4300, 4400]), ...crmlsComps([4350, 4450], 'Active').map((c, i) => ({ ...c, address: `${90 + i} Active Ln, Ventura, CA 93003` }))] });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.body.confidence.label, 'low');
  assert.equal(r.body.confidence.startingPoint, true);
  assert.equal(r.body.headline.stretchPrice, null, 'no stretch price on a Low report');
  assert.equal(r.body.headline.stretchWords, null);
  assert.equal(lastUpdate().stretch_price, null);
  assert.equal(lastUpdate().confidence_label, 'low');
  assert.ok(lastUpdate().headline_range_low != null);
  assert.ok(narrativeInputs[0].headline && narrativeInputs[0].headline.stretchPrice === null, 'the write-up is not told the stretch price on a Low report');

  // 4. Thin: 3 counted comps, finished, no range and no prices
  r = await run('thin report (3 counted comps)', { crmlsComps: crmlsComps([4300, 4400, 4500]) });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.body.headline, null);
  assert.equal(r.body.confidence, null);
  assert.match(r.body.noRange, /^Only 3 comparable homes found \(at least 4 are needed\)/);
  assert.equal(r.body.analysis.status, 'complete');
  u = lastUpdate();
  assert.equal(u.counted_comp_count, 3);
  for (const k of ['headline_range_low', 'headline_range_high', 'suggested_list_price', 'stretch_price', 'confidence_label', 'confidence_spread', 'recommended_rent_low', 'recommended_rent_mid', 'recommended_rent_high']) assert.equal(u[k], null, `${k} is NULL on a thin report`);
  assert.equal(log.compInserts[0].rows.length, 3, 'the comps are still saved and shown');
  assertNoWideRange(r.body);

  // 5. Comps exist but none counted (every one is the wrong type)
  r = await run('comps found, none counted', { crmlsComps: crmlsComps([4300, 4400, 4500, 4600]).map(c => ({ ...c, property_type: 'condo' })) });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.body.headline, null);
  assert.match(r.body.noRange, /^None of the 4 homes found could be counted/);
  assert.equal(lastUpdate().counted_comp_count, 0);

  // 6. Sources ran fine and found NOTHING: a finished report, no writer call, no comps saved
  r = await run('sources ran, found nothing', { crmlsComps: [] });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.body.analysis.status, 'complete');
  assert.equal(r.body.headline, null);
  assert.equal(r.body.confidence, null);
  assert.deepEqual(r.body.comps, []);
  assert.match(r.body.noRange, /^No comparable homes were found/);
  assert.match(r.body.analysis.rationale, /^No comparable homes were found near this address/);
  assert.equal(log.narrativeCalls, 0, 'no writer call for an empty report');
  assert.equal(log.compInserts.length, 0, 'nothing to save for comps');
  u = lastUpdate();
  assert.equal(u.status, 'complete');
  assert.equal(u.counted_comp_count, 0);
  assert.equal(u.counted_leased_count, 0);
  for (const k of ['headline_range_low', 'headline_range_high', 'suggested_list_price', 'stretch_price', 'recommended_rent_low', 'recommended_rent_mid', 'recommended_rent_high']) assert.equal(u[k], null);

  // 7. Every source broke: FAILED
  r = await run('every source broke', { rentcast: 'throw', crmls: 'throw' });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /RentCast: RentCast is down \| CRMLS: Recore is down/);
  assert.equal(lastUpdate().status, 'failed');

  // 8. Mixed: one source ran fine with nothing, another broke: we cannot say there are no comps, so FAILED
  r = await run('one source found nothing, another broke', { crmls: 'throw', crmlsComps: [] });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /CRMLS: Recore is down/);
  assert.equal(lastUpdate().status, 'failed');
  assert.equal(log.narrativeCalls, 0);

  // 9. A source broke but the others found comps: a normal report
  r = await run('one source broke, others found comps', { rentcast: 'throw', crmlsComps: crmlsComps([4300, 4350, 4400, 4400, 4450, 4500]) });
  assert.equal(r.status, 200);
  assert.equal(r.body.analysis.status, 'complete');
  assert.deepEqual(r.body.sourceNotes, ['RentCast was unavailable when this report ran, so it uses fewer comparable homes. Run it again to include them.']);
  const cleanSix = await run('the same comps with every source fine', { crmlsComps: crmlsComps([4300, 4350, 4400, 4400, 4450, 4500]) });
  assert.deepEqual(cleanSix.body.sourceNotes, []);
  assert.deepEqual(r.body.headline, cleanSix.body.headline, 'a missing source note changes no number');
  assert.deepEqual(r.body.confidence, cleanSix.body.confidence, 'and no label');

  // 9b. A half-down source (RentCast listings search failed after its similar-rentals list worked; CRMLS lost its Closed half):
  //     nothing found plus a warning is a FAILED analysis, not "no comparable homes"; nothing found and no warning is a finished report;
  //     comps plus a warning is a normal report that says so in plain words.
  r = await run('zero comps + RentCast listings search failed', { rentcastPartial: true });
  assert.equal(r.status, 500, JSON.stringify(r.body).slice(0, 300));
  assert.match(r.body.error, /RentCast: only partly worked, its search of nearby rental listings did not come back \(status 500\)/);
  assert.equal(lastUpdate().status, 'failed');
  assert.equal(log.narrativeCalls, 0);
  r = await run('zero comps + CRMLS Closed half rejected', { crmlsPartial: true });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /CRMLS: only partly worked, its recently leased homes did not come back/);
  assert.equal(lastUpdate().status, 'failed');
  r = await run('zero comps + every source clean', { crmlsComps: [] });
  assert.equal(r.status, 200, 'finished with nothing found');
  assert.equal(r.body.analysis.status, 'complete');
  assert.deepEqual(r.body.sourceNotes, []);
  r = await run('comps + RentCast listings search failed', { rentcastPartial: true, crmlsComps: crmlsComps([4300, 4350, 4400, 4400, 4450, 4500]) });
  assert.equal(r.status, 200);
  assert.equal(r.body.analysis.status, 'complete');
  assert.deepEqual(r.body.sourceNotes, ['RentCast was only partly available when this report ran (its search of nearby rental listings could not be loaded), so it may use fewer comparable homes. Run it again to include them.']);
  assert.deepEqual(r.body.headline, cleanSix.body.headline);
  assert.deepEqual(r.body.confidence, cleanSix.body.confidence);
  assert.equal(JSON.stringify(Object.keys(lastUpdate())).includes('note'), false, 'the note is not saved');
  r = await run('comps + CRMLS Closed half rejected', { crmlsPartial: true, crmlsComps: crmlsComps([4300, 4350, 4400, 4400, 4450, 4500]) });
  assert.equal(r.status, 200);
  assert.match(r.body.sourceNotes[0], /^CRMLS was only partly available when this report ran \(its recently leased homes could not be loaded\)/);

  // 9c. The subject's own current listing is never one of its comps (RentCast's copy of it goes; an MLS Closed lease at the same address stays)
  const ownCast = { ...crmlsComps([4300])[0], address: '2461 Bunting Avenue, Ventura, CA 93003', monthly_rent: 4200, listing_status: 'off_market', leased_date: null };
  const ownLease = { ...crmlsComps([4310])[0], address: '2461 Bunting Avenue, Ventura, CA 93003' };
  r = await run('the subject\'s own listing among the comps', { rentcastComps: [ownCast], crmlsComps: [...crmlsComps([4300, 4350, 4400, 4400, 4450, 4500]), ownLease] });
  assert.equal(r.status, 200);
  const atSubject = r.body.comps.filter(c => /2461 Bunting/.test(c.address));
  assert.deepEqual(atSubject.map(c => c.listing_status), ['leased'], 'only the confirmed lease at that address remains');

  // 9d. An address typed WITHOUT a zip (as the suggestion list gives it) still searches Rincon's own move-in leases, using the zip the
  //     geocoder (RentCast) found; a typed zip is used as typed; with no zip anywhere the search is skipped, as before.
  const noZipAddress = '2461 Bunting Avenue, Ventura, CA, USA';
  r = await run('no zip typed, geocoder found one', { zip: '93003', realLeadSimple: true, crmlsComps: crmlsComps([4300, 4350, 4400, 4400, 4450]) }, { subject_address: noZipAddress });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.equal(log.leadsimpleQueries.length, 1);
  assert.match(log.leadsimpleQueries[0], /zip_code=eq\.93003/);
  assert.ok(r.body.comps.some(c => /200 Rincon St/.test(c.address)), 'the Rincon move-in lease is among the comps');
  r = await run('zip typed', { zip: '93099', realLeadSimple: true, crmlsComps: crmlsComps([4300, 4350, 4400, 4400, 4450]) }, { subject_address: '2461 Bunting Avenue, Ventura, CA 93003' });
  assert.match(log.leadsimpleQueries[0], /zip_code=eq\.93003/, 'the typed zip wins over the geocoder\'s');
  r = await run('no zip typed and none found', { zip: null, realLeadSimple: true, crmlsComps: crmlsComps([4300, 4350, 4400, 4400, 4450]) }, { subject_address: noZipAddress });
  assert.equal(r.status, 200);
  assert.equal(log.leadsimpleQueries.length, 0, 'no zip anywhere: the source is skipped, exactly as before');
  assert.ok(!r.body.comps.some(c => /200 Rincon St/.test(c.address)));
  // ... and when nothing was found anywhere, the plain no-comps text says the Rincon records were NOT searched (never "checked")
  r = await run('nothing found, no zip anywhere', { zip: null, realLeadSimple: true, crmlsComps: [] }, { subject_address: noZipAddress });
  assert.equal(r.status, 200);
  assert.match(r.body.analysis.rationale, /Sources checked: RentCast, CRMLS\. Not searched: Rincon's own move-in records \(the address has no zip code\)\./);
  assert.doesNotMatch(r.body.analysis.rationale, /Sources checked:[^.]*LeadSimple/);

  // 9d2. Rincon's own leases are typed by what the MLS says is at their street address (a pretend MLS here), a lease whose rent cannot be
  //      right and a "Multi-Family" lease no longer count for a house, and everything saved is accepted by the pretend database's rules.
  const lease = (id, num, over = {}) => ({ id, address: `${num} Rincon St`, city: 'Ventura', state: 'CA', zip_code: '93003', property_type: 'Single Home', bedrooms: 4, bathrooms: 2, sqft: 1600, rent: 4400, lease_start_date: '2026-06-01', closed_at: '2026-06-10', latitude: 34.2012, longitude: -119.2, ...over });
  const mlsAt = (num, subtype, extra = {}) => ({ number: num, zip: '93003', dirPrefix: null, street: 'Rincon', suffix: 'St', dirSuffix: null, unit: null, subtype, ...extra });
  const pretendMls = records => {
    const fakeFetch = makeFakeRecoreFetch({ recordsFor: q => records.filter(rec => rec.number === q.number && rec.zip === q.zip && q.words.some(w => rec.street.toLowerCase().includes(w))) });
    return u => fakeFetch(u);
  };
  const houses = crmlsComps([4300, 4350, 4400, 4400, 4450]);
  r = await run('Rincon leases typed by the MLS, a junk rent and a Multi-Family lease', {
    zip: '93003', realLeadSimple: true, crmlsComps: houses,
    leaseRows: [lease('m1', 200), lease('m2', 300, { rent: 3100, sqft: 1550 }), lease('m3', 400, { rent: 280, sqft: 1500 }), lease('m4', 500, { property_type: 'Multi-Family', rent: 4300 })],
    mls: pretendMls([mlsAt(200, 'Single Family Residence'), mlsAt(300, 'Condominium'), mlsAt(300, 'Condominium', { unit: '4' })]),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  const byAddr = n => r.body.comps.find(c => c.address.startsWith(`${n} Rincon St`));
  assert.equal(byAddr(200).property_type, 'single_family');
  assert.equal(byAddr(200).exclusion_reason, null, 'the house the MLS confirms counts for a house');
  assert.equal(byAddr(200).property_type_source, 'mls');
  assert.equal(byAddr(300).property_type, 'condo', 'LeadSimple says Single Home, the MLS says condo: it is a condo');
  assert.equal(byAddr(300).exclusion_reason, 'property_type_mismatch');
  assert.equal(byAddr(300).property_type_source, 'mls', 'the screen can say the MLS lists it as a condo');
  assert.equal(byAddr(400).exclusion_reason, 'implausible_rent', 'a 4-bedroom house at $280 is a data error and does not count');
  assert.equal(byAddr(500).property_type, 'apartment', 'a Multi-Family lease is no longer an unknown type that counts for everything');
  assert.equal(byAddr(500).exclusion_reason, 'property_type_mismatch');
  assert.equal(r.body.counted.total, 6, 'five MLS houses and the one confirmed Rincon house');
  assert.equal(log.mlsRequests.length, 1, 'one MLS request for the four addresses');
  assert.doesNotMatch(log.mlsRequests[0], /mock-recore-token/);
  assert.deepEqual(r.body.sourceNotes, [], 'nothing went wrong, so no note');
  assert.deepEqual(log.compInserts[0].union.slice().sort(), [...COMP_ROW_COLUMNS].sort(), 'only the real database columns are saved: the type source and the rent mark are not');
  assert.ok(log.compInserts[0].rows.every(row => PROPERTY_TYPES.includes(row.property_type) || row.property_type === null), 'every saved type is one the database accepts');
  assert.equal(log.compInserts[0].rows.find(row => row.address.startsWith('300 Rincon St')).property_type, 'condo');
  assert.equal(narrativeInputs[0].comps.find(c => c.address.startsWith('400 Rincon St')).exclusion_reason, 'implausible_rent', 'the write-up is told that comp does not count');
  assert.deepEqual(narrativeInputs[0].sourcesUsed.slice().sort(), ['CRMLS', 'LeadSimple Move-Ins'], 'the MLS check is not named as a source');
  const typedAnswer = r;

  // 9d3. The MLS cannot be reached (it answers with an error): the analysis still finishes with exactly the numbers it has when the MLS
  //      simply knows nothing about these addresses (every lease keeps LeadSimple's type), saved cleanly, with a plain note on the screen.
  const plainRows = [lease('p1', 200), lease('p2', 300, { rent: 3100, sqft: 1550 })];
  const noRecord = await run('Rincon leases, the MLS knows nothing about them', { zip: '93003', realLeadSimple: true, crmlsComps: houses, leaseRows: plainRows, mls: pretendMls([]) });
  const mlsDown = await run('Rincon leases, the MLS is down', { zip: '93003', realLeadSimple: true, crmlsComps: houses, leaseRows: plainRows, mls: () => json({ message: 'down' }, 500) });
  assert.equal(mlsDown.status, 200, JSON.stringify(mlsDown.body).slice(0, 300));
  assert.equal(mlsDown.body.analysis.status, 'complete');
  assert.deepEqual(mlsDown.body.headline, noRecord.body.headline, 'a failed MLS check changes no number');
  assert.deepEqual(mlsDown.body.confidence, noRecord.body.confidence);
  assert.deepEqual(mlsDown.body.counted, noRecord.body.counted);
  assert.deepEqual(mlsDown.body.comps.map(c => [c.address, c.property_type, c.exclusion_reason]), noRecord.body.comps.map(c => [c.address, c.property_type, c.exclusion_reason]), 'every lease keeps the type LeadSimple gives it');
  assert.equal(mlsDown.body.comps.find(c => c.address.startsWith('300 Rincon St')).property_type, 'single_family');
  assert.equal(mlsDown.body.sourceNotes.length, 1);
  assert.equal(mlsDown.body.sourceNotes[0], "Rincon's own signed leases could not all be checked against the MLS (house, condo or townhouse) when this report ran, so some are counted under the type LeadSimple gives them, which is sometimes wrong. Run it again to redo that check.");
  assert.deepEqual(noRecord.body.sourceNotes, [], 'an MLS with no record is a real answer, not a failure');
  assert.equal(JSON.stringify(Object.keys(lastUpdate())).includes('note'), false, 'the note is not saved');
  assert.ok(log.compInserts.length === 1 && log.compInserts[0].rows.every(row => PROPERTY_TYPES.includes(row.property_type) || row.property_type === null));
  assert.equal(typedAnswer.body.counted.total, 6);
  // ... and the same when the MLS sends back something unreadable, or the access key is missing
  const mlsGarbage = await run('Rincon leases, the MLS sends garbage', { zip: '93003', realLeadSimple: true, crmlsComps: houses, leaseRows: plainRows, mls: () => json({ unexpected: true }) });
  assert.equal(mlsGarbage.status, 200);
  assert.deepEqual(mlsGarbage.body.headline, noRecord.body.headline);
  assert.equal(mlsGarbage.body.sourceNotes.length, 1);
  const savedToken = process.env.RECORE_SERVER_TOKEN;
  delete process.env.RECORE_SERVER_TOKEN;
  const noKey = await run('Rincon leases, no MLS access key on the server', { zip: '93003', realLeadSimple: true, crmlsComps: houses, leaseRows: plainRows, mls: pretendMls([]) });
  process.env.RECORE_SERVER_TOKEN = savedToken;
  assert.equal(noKey.status, 200);
  assert.deepEqual(noKey.body.headline, noRecord.body.headline);
  assert.equal(log.mlsRequests.length, 0, 'with no access key nothing is asked');
  assert.equal(noKey.body.sourceNotes.length, 1);

  // 9e. A hostile address of thousands of characters is refused up front with a plain message, and nothing is saved or looked up
  reset();
  scenario = { crmlsComps: crmlsComps([4300, 4350, 4400, 4400, 4450, 4500]) };
  r = await post({ ...good, subject_address: `2461 Bunting Avenue ${'A '.repeat(40000)}, Ventura, CA 93003` });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /subject_address must be 300 characters or fewer\./);
  assert.equal(log.analysisInserts.length, 0, 'nothing saved');
  // 9f. A bare house number (also what is left after hidden characters are cleaned away) has no street name: refused before any lookup
  for (const bare of ['2461', '2461\u0000', '2461, Ventura, CA', '2461 Apt 5']) {
    reset();
    scenario = { crmlsComps: crmlsComps([4300, 4350, 4400, 4400, 4450, 4500]) };
    r = await post({ ...good, subject_address: bare });
    assert.equal(r.status, 400, JSON.stringify(bare));
    assert.match(r.body.error, /subject_address needs a street name\./);
    assert.equal(log.analysisInserts.length, 0, 'nothing saved');
  }
  r = await post({ ...good, subject_address: `2461 Bunting Avenue, Ventura, CA 93003${' '.repeat(10)}` });
  assert.equal(r.status, 200, 'an ordinary address with trailing spaces is fine');

  // 10. Bad inputs are refused before anything is saved
  for (const bad of [{ owner_goal: 'maximize' }, { owner_goal: 'Balanced' }, { owner_goal: 7 }, { subject_age_restricted: 'maybe' }, { subject_subdivision: 'x'.repeat(121) }]) {
    reset();
    scenario = { crmlsComps: crmlsComps([4300, 4350, 4400, 4400, 4450, 4500]) };
    r = await post({ ...good, ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(log.analysisInserts.length, 0, `nothing saved for ${JSON.stringify(bad)}`);
  }
  reset();
  scenario = { crmlsComps: crmlsComps([4300, 4350, 4400, 4400, 4450, 4500]) };
  r = await post({ ...good, owner_goal: '' });
  assert.equal(r.status, 200, 'an empty goal means Balanced');
  assert.equal(r.body.headline.goal, 'balanced');

  // 10b. Silly values are refused before anything is saved (a plain message, not database text)
  for (const [bad, pattern] of [
    [{ subject_sqft: 20001 }, /subject_sqft must be 20,000 or less/], [{ subject_bedrooms: 21 }, /subject_bedrooms must be 20 or less/],
    [{ subject_bathrooms: 21 }, /subject_bathrooms must be 20 or less/], [{ lease_term_months: 121 }, /lease_term_months must be 120 or less/],
    [{ furnished: 'false' }, /furnished must be true or false/], [{ furnished: 1 }, /furnished must be true or false/],
  ]) {
    reset();
    scenario = { crmlsComps: crmlsComps([4300, 4350, 4400, 4400, 4450, 4500]) };
    r = await post({ ...good, ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(r.body.error, pattern);
    assert.doesNotMatch(r.body.error, /violat|constraint|postgres|column/i, 'a plain message, no database wording');
    assert.equal(log.analysisInserts.length, 0, `nothing saved for ${JSON.stringify(bad)}`);
  }
  reset();
  scenario = { crmlsComps: crmlsComps([4300, 4350, 4400, 4400, 4450, 4500]) };
  r = await post({ ...good, subject_sqft: 20000, subject_bedrooms: 20, subject_bathrooms: 20, lease_term_months: 120, furnished: true });
  assert.equal(r.status, 200, 'the largest allowed values still work');
  assert.equal(log.analysisInserts[0].furnished, true);
  // hidden control characters are removed from the address and the neighborhood before saving
  reset();
  scenario = { crmlsComps: crmlsComps([4300, 4350, 4400, 4400, 4450, 4500]) };
  r = await post({ ...good, subject_address: '2461 Bunting\u0000 Avenue,\n Ventura, CA 93003', subject_subdivision: 'Hueneme\u0000 Bay 1 - 148801' });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(log.analysisInserts[0].subject_address, '2461 Bunting Avenue, Ventura, CA 93003');
  assert.equal(log.analysisInserts[0].subject_subdivision, 'Hueneme Bay 1');
  assert.ok(!JSON.stringify(log.analysisInserts[0]).includes('\\u0000'), 'no zero byte reaches the database');

  // 10c. A source that supplied comps is named to the write-up, in the order the comps came
  reset();
  scenario = { rentcastComps: crmlsComps([4300, 4350]).map((c, i) => ({ ...c, address: `${70 + i} Rent Cast Ln, Ventura, CA 93003`, monthly_rent: 4300 + i * 50, listing_status: 'off_market', leased_date: null })), crmlsComps: crmlsComps([4300, 4350, 4400, 4400]), leadsimple: true };
  r = await post(good);
  assert.equal(r.status, 200);
  assert.deepEqual([...narrativeInputs[0].sourcesUsed].sort(), ['CRMLS', 'LeadSimple Move-Ins', 'RentCast']);

  // 11. A 55+ subject and a neighborhood name (Stage 1 inputs still work); a furnished 55+ comp mix
  reset();
  scenario = { crmlsComps: crmlsComps([4300, 4350, 4400, 4400, 4450, 4500]) };
  r = await post({ ...good, subject_age_restricted: true, subject_subdivision: 'Hueneme Bay 1 - 148801' });
  assert.equal(r.status, 200);
  assert.equal(log.analysisInserts[0].subject_age_restricted, true);
  assert.equal(log.analysisInserts[0].subject_subdivision, 'Hueneme Bay 1');
  assert.equal(log.analysisInserts[0].owner_goal, 'balanced');

  assert.equal(log.blocked.length, 0, `outside network attempts: ${log.blocked.join(', ')}`);
  console.log(`Entry-point harness (${MODE}): PASS`);
  process.exit(0);
})().catch(e => { console.error(`Entry-point harness (${MODE}): FAIL`, e && e.stack || e); process.exit(1); });
