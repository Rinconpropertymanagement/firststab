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
process.env.RENTAL_ANALYSIS_PORT = String(PORT);
const APP_ROOT = MODE === 'server' ? __dirname : path.join(__dirname, '..', 'hub', 'rental-analysis');
process.chdir(APP_ROOT);

const realFetch = global.fetch;
const log = { analysisInserts: [], analysisUpdates: [], compInserts: [], narrativeCalls: 0, blocked: [], leadsimpleQueries: [], rentcastMarket: 0 };

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
let analysisRow = null, compCounter = 0, analysisCounter = 0;

// ─── what the pretend database remembers (so a saved report can be read back later) ───
// The column lists of rental_analyses and rental_comps are the real ones (read from the live database on 2026-10-18).
// The lists for users, rental_comp_sources and rental_market_data are NOT read from the live database: they only hold the
// columns this check needs (the real tables have more). A request that names a column missing from its list is refused
// here, the way the real database refuses an unknown column.
const REAL_COLUMNS = {
  rental_analyses: 'id,subject_address,subject_bedrooms,subject_bathrooms,subject_sqft,subject_property_type,subject_year_built,lease_term_months,furnished,property_id,run_by,status,recommended_rent_low,recommended_rent_mid,recommended_rent_high,subject_estimated_rent,raw_comp_rent_low,raw_comp_rent_high,rationale,notes,actual_rent,actual_rent_recorded_at,created_at,updated_at,subject_latitude,subject_longitude,subject_zip,subject_condition,subject_age_restricted,subject_subdivision,size_band_pct,headline_range_low,headline_range_high,suggested_list_price,stretch_price,owner_goal,confidence_label,confidence_spread,counted_comp_count,counted_leased_count,method_version'.split(','),
  rental_comps: 'id,analysis_id,source_id,address,property_type,bedrooms,bathrooms,sqft,distance_miles,monthly_rent,is_estimated_price,original_price,had_price_cut,listing_status,days_on_market,listed_date,leased_date,is_rincon_managed,comp_property_id,narrative,created_at,updated_at,latitude,longitude,mls_listing_id,year_built,subdivision_name,furnished_status,lease_term_class,age_restricted,mls_condition,mls_flags,condition_rating,condition_basis,condition_tags'.split(','),
  users: ['id', 'name', 'email', 'phone'],
  rental_comp_sources: ['id', 'name', 'is_active'],
  rental_market_data: ['id', 'zip', 'median_rent', 'average_rent', 'history', 'fetched_at'],
};
const RUNNER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_RUNNER_ID = '22222222-2222-2222-2222-222222222222';
const db = {
  analyses: [],
  comps: [],
  // two staff members, each with an email and a phone number that must NEVER reach a past-report answer
  users: [
    { id: RUNNER_ID, name: 'Pat Runner', email: 'pat.runner@example.test', phone: '805-555-0101' },
    { id: OTHER_RUNNER_ID, name: 'Sam Second', email: 'sam.second@example.test', phone: '805-555-0102' },
  ],
  market: [],
};
const uuidFor = n => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const withAllColumns = (table, row) => ({ ...Object.fromEntries(REAL_COLUMNS[table].map(c => [c, null])), ...row });

// Access for the Hub's role check: ok | nomember | inactive | norole | roleerror. dbFail = tables that answer with a database error.
let access = 'ok';
const dbFail = new Set();
const log2 = { requests: [] };

// A small stand-in for the way the real database reads a request: filters (eq, neq, in, ilike), order, limit, offset and select.
function likeToRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) { source += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    source += ch === '*' || ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'is');
}
function readRows(table, rows, search) {
  const p = new URLSearchParams(search);
  let out = rows.slice();
  const select = p.get('select') || '*';
  const columns = select === '*' ? null : select.split(',');
  if (columns) for (const c of columns) if (!REAL_COLUMNS[table].includes(c)) { const e = new Error(`column ${table}.${c} does not exist`); e.db = true; throw e; }
  for (const [key, value] of p.entries()) {
    if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
    const m = /^(eq|neq|in|ilike)\.([\s\S]*)$/.exec(value);
    if (!m) throw new Error(`pretend database: filter not understood: ${key}=${value}`);
    if (!REAL_COLUMNS[table].includes(key)) { const e = new Error(`column ${table}.${key} does not exist`); e.db = true; throw e; }
    const [, op, arg] = m;
    out = out.filter(r => {
      const v = r[key];
      if (op === 'eq') return String(v) === arg;
      if (op === 'neq') return String(v) !== arg;
      if (op === 'in') return arg.replace(/^\(|\)$/g, '').split(',').includes(String(v));
      return v !== null && v !== undefined && likeToRegExp(arg).test(String(v));
    });
  }
  const order = p.get('order');
  if (order) {
    const keys = order.split(',').map(o => o.split('.'));
    out.sort((a, b) => { for (const [k, dir] of keys) { if (a[k] === b[k]) continue; return (a[k] < b[k] ? -1 : 1) * (dir === 'desc' ? -1 : 1); } return 0; });
  }
  const offset = Number(p.get('offset') || 0), limit = p.get('limit') === null ? out.length : Number(p.get('limit'));
  out = out.slice(offset, offset + limit);
  return columns ? out.map(r => Object.fromEntries(columns.map(c => [c, r[c]]))) : out;
}
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith(`http://127.0.0.1:${PORT}`)) return realFetch(url, opts);
  // the area market numbers are looked up by zip after the report is saved; the pretend answer is "no coverage" (never a real call)
  if (u.startsWith('https://api.rentcast.io/v1/markets')) { log.rentcastMarket++; return json({ error: 'no market data in this test' }, 404); }
  if (!u.startsWith('http://mock-supabase.test/rest/v1/')) { log.blocked.push(u.slice(0, 60)); throw new Error(`NETWORK BLOCKED: ${u.slice(0, 60)}`); }
  const [table] = u.replace('http://mock-supabase.test/rest/v1/', '').split('?');
  const method = opts.method || 'GET';
  try {
    if (method === 'GET') {
      log2.requests.push(u);
      if (table === 'team_members') {
        if (access === 'nomember') return json([]);
        return json({ id: 't1', full_name: 'Test', is_active: access !== 'inactive' });
      }
      if (table === 'team_member_tool_roles') {
        if (access === 'roleerror') return json({ code: 'PGRST205', message: 'relation does not exist' }, 404);
        return access === 'norole' ? json([]) : json({ role: 'admin' });
      }
      if (dbFail.has(table)) return json({ code: 'XX000', message: 'internal detail DB_PASSWORD=hunter2 at pg_catalog' }, 500);
      if (table === 'users') return json(readRows('users', db.users, u.split('?')[1] || ''));
      if (table === 'rental_analyses') return json(readRows('rental_analyses', db.analyses, u.split('?')[1] || ''));
      if (table === 'rental_comps') return json(readRows('rental_comps', db.comps, u.split('?')[1] || ''));
      if (table === 'rental_market_data') return json(readRows('rental_market_data', db.market, u.split('?')[1] || ''));
      if (table === 'properties') return json([{ id: 'p-1', address: '100 Rincon Way', city: 'Ventura', state: 'CA', zip: '93001' }]);
      if (table === 'leadsimple_new_leases') {
        // Rincon's own move-in leases: one row, returned only when the search is for zip 93003 (so the zip used is visible)
        log.leadsimpleQueries.push(u);
        return json(u.includes('zip_code=eq.93003') ? [{ id: 'r1', address: '200 Rincon St', city: 'Ventura', state: 'CA', zip_code: '93003', property_type: 'Single Home', bedrooms: 4, bathrooms: 2, sqft: 1600, rent: 4400, lease_start_date: '2026-06-01', closed_at: '2026-06-10', latitude: 34.2012, longitude: -119.2 }] : []);
      }
      if (table === 'rental_comp_sources') return json(readRows('rental_comp_sources', [{ id: 'src-r', name: 'RentCast', is_active: true }, { id: 'src-c', name: 'CRMLS', is_active: true }, { id: 'src-l', name: 'LeadSimple Move-Ins', is_active: true }], u.split('?')[1] || ''));
      return json([]);
    }
    const body = JSON.parse(opts.body);
    // the saved report's id is a real-looking UUID (the past-reports page address accepts nothing else)
    if (table === 'rental_analyses' && method === 'POST') {
      checkAnalysis({ ...body }); log.analysisInserts.push(body);
      const n = ++analysisCounter;
      analysisRow = withAllColumns('rental_analyses', { id: uuidFor(n), created_at: new Date(Date.UTC(2026, 9, 18, 12, 0, n)).toISOString(), updated_at: new Date(Date.UTC(2026, 9, 18, 12, 0, n)).toISOString(), ...body });
      db.analyses.push(analysisRow);
      return json([analysisRow], 201);
    }
    if (table === 'rental_analyses' && method === 'PATCH') {
      log.analysisUpdates.push(body); analysisRow = { ...analysisRow, ...body }; checkAnalysis(analysisRow);
      db.analyses[db.analyses.findIndex(a => a.id === analysisRow.id)] = analysisRow;
      return json([analysisRow]);
    }
    if (table === 'rental_comps' && method === 'POST') {
      const rows = Array.isArray(body) ? body : [body];
      // a key missing from some rows of a bulk save becomes NULL (not the column's usual starting value)
      const union = [...new Set(rows.flatMap(r => Object.keys(r)))];
      const filled = rows.map(r => Object.fromEntries(union.map(k => [k, r[k] === undefined ? null : r[k]])));
      log.compInserts.push({ rows, union });
      const withDefaults = filled.map(r => ({ mls_flags: [], condition_tags: [], is_estimated_price: false, had_price_cut: false, is_rincon_managed: false, age_restricted: null, ...r }));
      withDefaults.forEach(checkCompRow);
      const saved = withDefaults.map(r => withAllColumns('rental_comps', { id: `c-${++compCounter}`, created_at: analysisRow.created_at, ...r }));
      db.comps.push(...saved);
      return json(saved, 201);
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
  // The Hub's login runs before this router (hub/server.js: app.use(requireLogin) comes before app.use(rentalAnalysisRouter)).
  // Here the login is pretended, except when a check asks to be a visitor who is not logged in: then the Hub's REAL login check runs.
  const { requireLogin } = require(path.join(APP_ROOT, '..', 'lib', 'middleware'));
  app.use((req, res, next) => {
    if (req.headers['x-test-login'] === 'logged-out') return requireLogin(req, res, next);
    if (req.headers['x-test-login'] === 'no-user') return next(); // a request that reaches the router with no known person on it
    req.user = { id: 'u1' };
    next();
  });
  app.use(require(path.join(APP_ROOT, 'router.js')).router);
  app.listen(PORT, '127.0.0.1');
}

const post = async body => {
  const res = await realFetch(`http://127.0.0.1:${PORT}/api/rental-analysis/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const good = { subject_address: '2461 Bunting Avenue, Ventura, CA 93003', subject_bedrooms: 4, subject_bathrooms: 2, subject_sqft: 1636, subject_property_type: 'single_family', lease_term_months: 12, furnished: false, run_by: '11111111-1111-1111-1111-111111111111' };
const AUDIT = ['recommended_rent_low', 'recommended_rent_mid', 'recommended_rent_high', 'raw_comp_rent_low', 'raw_comp_rent_high', 'confidence_spread'];

function reset() { log.leadsimpleQueries.length = 0; log.analysisInserts.length = 0; log.analysisUpdates.length = 0; log.compInserts.length = 0; log.narrativeCalls = 0; narrativeInputs = []; analysisRow = null; }
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
  assert.equal(u.method_version, 'cma-2026-10-v1');
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


  // ═══ Past reports: list and reopen saved reports (read-only, Hub only) ═══
  if (MODE === 'server') {
    // the standalone app has no login, so it must not have either past-reports address
    for (const p of ['/api/rental-analysis/history', '/api/rental-analysis/history?limit=1', `/api/rental-analysis/history/${uuidFor(1)}`]) {
      const res = await realFetch(`http://127.0.0.1:${PORT}${p}`);
      assert.equal(res.status, 404, `${p} must not exist on the standalone app`);
    }
    console.log('  past reports: the standalone app has neither address (404)');
  } else {
    const history = require(path.join(APP_ROOT, 'lib', 'history'));
    const call = async (p, headers = {}) => {
      const res = await realFetch(`http://127.0.0.1:${PORT}${p}`, { headers, redirect: 'manual' });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch (_) { /* not JSON */ }
      return { status: res.status, body, text, location: res.headers.get('location'), cache: res.headers.get('cache-control') };
    };
    const tablesAsked = since => log2.requests.slice(since).map(u => u.replace('http://mock-supabase.test/rest/v1/', '').split('?')[0]);
    const FORBIDDEN_TEXT = ['@example.test', '805-555', 'PRIVATE STAFF NOTE', 'mock-key', 'mock-anon', 'hunter2', 'DB_PASSWORD', 'service_role', 'apikey', 'Bearer'];
    const assertNoLeak = (text, where) => { for (const bad of FORBIDDEN_TEXT) assert.ok(!text.includes(bad), `${where}: the answer must not contain "${bad}"`); };

    // ── make some real saved reports by running the real handler (nothing is faked about what gets saved) ──
    const rentcastBefore = log.rentcastMarket;
    const savedLive = {};
    const make = async (key, sc, extra) => { const x = await run(`past reports setup: ${key}`, sc, extra); assert.ok(x.status === 200 || x.status === 500, key); savedLive[key] = x.body; return x.body; };
    await make('high', { crmlsComps: crmlsComps([4300, 4350, 4400, 4400, 4450, 4500]) });
    await make('quick', { crmlsComps: crmlsComps([4000, 4150, 4300, 4450, 4600, 4750]) }, { owner_goal: 'lease_quickly' });
    await make('max', { crmlsComps: crmlsComps([4000, 4150, 4300, 4450, 4600, 4750]) }, { owner_goal: 'maximize_rent' });
    await make('low', { crmlsComps: [...crmlsComps([4300, 4400]), ...crmlsComps([4350, 4450], 'Active').map((c, i) => ({ ...c, address: `${90 + i} Active Ln, Ventura, CA 93003` }))] }, { run_by: OTHER_RUNNER_ID, subject_address: '88 Oak Street, Ventura, CA 93003' });
    await make('thin', { crmlsComps: crmlsComps([4300, 4400, 4500]) });
    await make('none', { crmlsComps: crmlsComps([4300, 4400, 4500, 4600]).map(c => ({ ...c, property_type: 'condo' })) });
    await make('nothing', { crmlsComps: [] });
    await make('failed', { rentcast: 'throw', crmls: 'throw' });
    await make('mixed', { crmlsComps: [...crmlsComps([4300, 4350, 4400, 4400, 4450, 4500]), ...crmlsComps([4900]).map(c => ({ ...c, address: '55 Elsewhere Rd, Ventura, CA 93003', sqft: 3200, furnished_status: 'furnished' }))] });
    assert.equal(savedLive.failed.analysis_id !== undefined, true, 'a failed run still names its saved row');
    const narrativeCallsAfterSetup = log.narrativeCalls, analysesAfterSetup = db.analyses.length, compsAfterSetup = db.comps.length;

    const sameAsLive = async (name, live, id = live.analysis.id) => {
      const g = await call(`/api/rental-analysis/history/${id}`);
      assert.equal(g.status, 200, `${name}: ${g.text.slice(0, 200)}`);
      assert.equal(g.cache, 'no-store', `${name}: private data is not kept by the browser`);
      const saved = g.body;
      for (const k of ['headline', 'confidence', 'counted', 'noRange', 'sizeBand', 'sizeNote', 'accuracyLine']) assert.deepEqual(saved[k], live[k], `${name}: ${k} is what the live run showed`);
      for (const k of Object.keys(saved.analysis)) assert.deepEqual(saved.analysis[k], live.analysis[k], `${name}: analysis.${k}`);
      for (const audit of AUDIT) assert.ok(!(audit in saved.analysis), `${name}: ${audit} stays out`);
      assert.ok(!('run_by' in saved.analysis) && !('notes' in saved.analysis) && !('property_id' in saved.analysis), `${name}: no run_by / notes / property_id`);
      assert.equal(saved.comps.length, live.comps.length, `${name}: same number of comps`);
      for (const c of saved.comps) {
        const was = live.comps.find(x => x.id === c.id);
        assert.ok(was, `${name}: comp ${c.id} was in the live answer`);
        assert.equal(c.exclusion_reason, was.exclusion_reason, `${name}: ${c.address}: same reason it was not counted`);
        for (const col of history.COMP_COLUMNS.split(',')) assert.deepEqual(c[col], was[col], `${name}: comp.${col}`);
      }
      assertNoWideRange(saved);
      assertNoLeak(g.text, name);
      return saved;
    };
    const names = ['high', 'quick', 'max', 'low', 'thin', 'none', 'nothing', 'mixed'];
    const reopened = {};
    for (const key of names) reopened[key] = await sameAsLive(key, savedLive[key]);
    assert.equal(reopened.high.format, 'new');
    assert.equal(reopened.high.runByName, 'Pat Runner');
    assert.equal(reopened.low.runByName, 'Sam Second');
    assert.equal(reopened.high.headline.stretchPrice, reopened.high.headline.high + 200);
    assert.equal(reopened.low.headline.stretchPrice, null, 'a Low report shows no stretch price when reopened');
    assert.equal(reopened.low.analysis.stretch_price, null);
    assert.equal(reopened.quick.headline.listPrice, reopened.quick.headline.low);
    assert.equal(reopened.max.headline.listPrice, reopened.max.headline.high);
    assert.equal(reopened.thin.headline, null);
    assert.match(reopened.thin.noRange, /^Only 3 comparable homes found/);
    assert.match(reopened.none.noRange, /^None of the 4 homes found could be counted/);
    assert.deepEqual(reopened.nothing.comps, []);
    assert.ok(reopened.mixed.comps.some(c => c.exclusion_reason === 'size_sqft'), 'a home left out for size keeps its reason');
    assert.ok(reopened.mixed.comps.some(c => c.exclusion_reason === 'furnished_mismatch') || reopened.mixed.comps.some(c => c.exclusion_reason === 'size_sqft'));
    assert.deepEqual(reopened.high.sourceNotes, [history.ORDER_NOTE, history.NO_MARKET_NOTE], 'the order note (two or more homes), then: no saved area figures, the section is left out and the page says so');
    assert.deepEqual(reopened.nothing.sourceNotes, [history.NO_MARKET_NOTE], 'a report with no homes has no order note');
    assert.equal(reopened.high.marketData, null);
    console.log('  past reports: 8 reports reopened exactly as the live run showed them');

    // ── the failed run, reached through show_failed ──
    const failedId = savedLive.failed.analysis_id;
    const failedReport = await call(`/api/rental-analysis/history/${failedId}`);
    assert.equal(failedReport.status, 200);
    assert.equal(failedReport.body.format, 'unfinished');
    assert.equal(failedReport.body.headline, null);
    assert.equal(failedReport.body.confidence, null);
    assert.equal(failedReport.body.noRange, history.UNFINISHED_NO_RANGE.failed);
    assert.equal(failedReport.body.olderFormat, false);

    // ── an older-format report (saved before the recommended-range method), with older-style comps ──
    const oldId = uuidFor(9001);
    const mkOld = (n, over) => withAllColumns('rental_comps', { id: `old-c-${n}`, analysis_id: oldId, source_id: 'src-c', address: `${n} Old Lane, Ventura, CA 93001`, property_type: 'single_family', bedrooms: 3, bathrooms: 2, sqft: 1500, distance_miles: 0.2 + n / 10, monthly_rent: 4000 + n * 100, is_estimated_price: false, had_price_cut: false, listing_status: 'leased', is_rincon_managed: false, narrative: `OLD NARRATIVE ${n}`, mls_flags: [], condition_tags: [], created_at: '2026-09-02T17:00:00.000Z', ...over });
    db.analyses.push(withAllColumns('rental_analyses', {
      id: oldId, subject_address: '77 Old Method Way, Ventura, CA 93001', subject_bedrooms: 3, subject_bathrooms: 2, subject_sqft: 1500,
      subject_property_type: 'single_family', lease_term_months: 12, furnished: false, subject_age_restricted: false, run_by: OTHER_RUNNER_ID, status: 'complete',
      recommended_rent_low: 3800, recommended_rent_mid: 4200, recommended_rent_high: 4650, raw_comp_rent_low: 3500, raw_comp_rent_high: 5000,
      subject_estimated_rent: 4100, subject_zip: '93001', subject_latitude: 34.2, subject_longitude: -119.2,
      rationale: 'OLD-STYLE explanation: the range is $3,800 to $4,650.', notes: 'PRIVATE STAFF NOTE', created_at: '2026-09-02T17:00:00.000Z', updated_at: '2026-09-02T17:00:30.000Z',
    }));
    db.comps.push(mkOld(1, {}), mkOld(2, { sqft: 3300 }), mkOld(3, { property_type: 'condo' }), mkOld(4, { is_rincon_managed: true, listing_status: 'off_market', is_estimated_price: true }), mkOld(5, { bedrooms: 5 }), mkOld(6, { furnished_status: 'furnished', source_id: 'src-r', listing_status: 'active', days_on_market: 12 }));
    const older = await call(`/api/rental-analysis/history/${oldId}`);
    assert.equal(older.status, 200, older.text.slice(0, 200));
    const ob = older.body;
    assert.equal(ob.format, 'older');
    assert.equal(ob.olderFormat, true);
    assert.equal(ob.headline, null, 'no recommended range is made up for an older report');
    assert.equal(ob.confidence, null);
    assert.equal(ob.accuracyLine, null);
    assert.equal(ob.sizeNote, null);
    assert.equal(ob.analysis.stretch_price, null);
    assert.deepEqual(ob.legacyRange, { low: 3800, mid: 4200, high: 4650 }, 'the old numbers are shown as they were saved, apart from the headline');
    assert.equal(ob.noRange, history.OLDER_NO_RANGE);
    assert.equal(ob.analysis.rationale, null, 'the old written explanation is not shown (it stays in the database)');
    assert.ok(!older.text.includes('OLD-STYLE'), 'none of the old explanation text is in the answer');
    assert.equal(ob.runByName, 'Sam Second');
    for (const audit of AUDIT) assert.ok(!older.text.includes(`"${audit}"`), `${audit} is not in an older report's answer`);
    assert.ok(!('recommended_rent_low' in ob.analysis) && !('raw_comp_rent_low' in ob.analysis), 'the old wide columns are not in the analysis');
    const why = Object.fromEntries(ob.comps.map(c => [c.id, c.exclusion_reason]));
    assert.equal(why['old-c-1'], null);
    assert.equal(why['old-c-2'], null, 'the size rule did not exist when this report ran, so a very large home was counted then');
    assert.equal(why['old-c-3'], 'property_type_mismatch');
    assert.equal(why['old-c-4'], 'rincon_managed');
    assert.equal(why['old-c-5'], 'size_mismatch');
    assert.equal(why['old-c-6'], null, 'a furnished home was not left out by a rule that did not exist yet');
    assert.deepEqual(ob.counted, { total: 3, leased: 2, active: 1, offMarket: 0 });
    assert.equal(ob.comps.length, 6);
    assert.ok(ob.comps.every(c => c.narrative === null), 'the old notes on each home are not shown');
    assert.ok(!older.text.includes('OLD NARRATIVE'), 'none of the old per-home notes is in the answer');
    assert.deepEqual(ob.sourceNotes, [history.ORDER_NOTE, history.NO_MARKET_NOTE]);
    assertNoLeak(older.text, 'older report');
    console.log('  past reports: an older-format report keeps its saved numbers and is marked older (no headline, no label, no stretch price)');

    // saved area figures: used when a row for the zip is saved (read only, no RentCast call), left out and said so when not
    db.market.push({ id: 'm1', zip: '93001', median_rent: 4100, average_rent: 4200, history: {}, fetched_at: '2026-10-17T21:41:02.674+00:00' });
    const withMarket = await call(`/api/rental-analysis/history/${oldId}`);
    assert.equal(withMarket.body.marketData.zip, '93001');
    assert.deepEqual(withMarket.body.sourceNotes, [history.ORDER_NOTE, 'Area market figures are the latest saved for this zip code (updated 2026-10-17), not necessarily the figures from the day this report was run.']);
    assert.ok(withMarket.body.comps.every(c => c.narrative === null) && withMarket.body.analysis.rationale === null);
    assert.equal(log.rentcastMarket, rentcastBefore, 'opening saved reports never asks RentCast for anything');

    // ── the list ──
    const everyone = db.analyses.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : (a.id < b.id ? 1 : -1)));
    const complete = everyone.filter(a => a.status === 'complete');
    assert.ok(complete.length > 30 && complete.length < 100, `setup: ${complete.length} finished reports`);
    // 130 plain extra rows (older dates) so the caps and "load more" are real
    for (let i = 1; i <= 130; i++) {
      db.analyses.push(withAllColumns('rental_analyses', { id: uuidFor(5000 + i), subject_address: `${i} Seed Street, Oxnard, CA 93030`, subject_bedrooms: 2, subject_bathrooms: 1, subject_sqft: 900, subject_property_type: 'condo', lease_term_months: 12, furnished: false, subject_age_restricted: false, run_by: RUNNER_ID, status: 'complete', recommended_rent_low: 2000, recommended_rent_mid: 2200, recommended_rent_high: 2500, created_at: new Date(Date.UTC(2026, 7, 1, 0, 0, i)).toISOString(), updated_at: new Date(Date.UTC(2026, 7, 1, 0, 0, i)).toISOString() }));
    }
    const allComplete = db.analyses.filter(a => a.status === 'complete').sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : (a.id < b.id ? 1 : -1)));
    assert.ok(allComplete.length > 150);
    const ROW_KEYS = ['confidence_label', 'created_at', 'format', 'headline', 'id', 'run_by_name', 'status', 'subject_address', 'subject_bathrooms', 'subject_bedrooms', 'subject_property_type', 'subject_sqft', 'suggested_list_price'];

    const first = await call('/api/rental-analysis/history');
    assert.equal(first.status, 200);
    assert.equal(first.cache, 'no-store');
    assert.equal(first.body.limit, 50, 'default page is 50');
    assert.equal(first.body.offset, 0);
    assert.equal(first.body.rows.length, 50);
    assert.equal(first.body.hasMore, true);
    assert.deepEqual(first.body.rows.map(r => r.id), allComplete.slice(0, 50).map(a => a.id), 'newest first');
    for (const r of first.body.rows) { assert.deepEqual(Object.keys(r).sort(), ROW_KEYS); assert.equal(r.status, 'complete', 'failed and unfinished reports are hidden by default'); }
    assertNoLeak(first.text, 'list');
    // the list asks the database only for the columns it shows
    const listAsk = new URLSearchParams(log2.requests.filter(u => u.includes('/rental_analyses?')).pop().split('?')[1]);
    assert.equal(listAsk.get('select'), history.LIST_COLUMNS);
    for (const hidden of ['notes', 'property_id', 'rationale', 'confidence_spread', 'raw_comp_rent_low', 'recommended_rent_low', 'recommended_rent_mid', 'recommended_rent_high']) assert.ok(!listAsk.get('select').split(',').includes(hidden), `${hidden} is never read for the list`);

    const capped = await call('/api/rental-analysis/history?limit=100000');
    assert.equal(capped.status, 200);
    assert.equal(capped.body.limit, 100, 'the hard cap is 100');
    assert.equal(capped.body.rows.length, 100);
    assert.equal(capped.body.hasMore, true);
    assert.equal((await call('/api/rental-analysis/history?limit=100')).body.rows.length, 100);
    assert.equal((await call('/api/rental-analysis/history?limit=1')).body.rows.length, 1);

    // paging through the whole list in pages of 37: every report once, in order, with "more" true until the last page
    const pagedIds = [];
    for (let offset = 0, guard = 0; guard < 20; guard++) {
      const pg = await call(`/api/rental-analysis/history?limit=37&offset=${offset}`);
      assert.equal(pg.status, 200);
      assert.ok(pg.body.rows.length <= 37);
      pagedIds.push(...pg.body.rows.map(r => r.id));
      if (!pg.body.hasMore) break;
      assert.equal(pg.body.rows.length, 37, 'a page that has more after it is full');
      offset += 37;
    }
    assert.deepEqual(pagedIds, allComplete.map(a => a.id), 'paging shows every finished report once, newest first');
    const pastEnd = await call(`/api/rental-analysis/history?offset=${allComplete.length + 5}`);
    assert.deepEqual([pastEnd.body.rows.length, pastEnd.body.hasMore], [0, false]);

    // bad limits and offsets are refused with a plain message
    for (const bad of ['limit=0', 'limit=-3', 'limit=abc', 'limit=1.5', 'limit=1&limit=2', 'offset=-1', 'offset=abc', 'offset=99999999', 'q=a&q=b', 'limit[]=1', 'q[x]=1', 'show_failed=1&show_failed=0']) {
      const before = log2.requests.length;
      const b = await call(`/api/rental-analysis/history?${bad}`);
      assert.equal(b.status, 400, bad);
      assert.equal(typeof b.body.error, 'string');
      assert.ok(!tablesAsked(before).some(t => t.startsWith('rental_')), `${bad}: refused before the database is asked`);
    }

    // show_failed
    const withFailed = await call('/api/rental-analysis/history?limit=100&show_failed=1&q=bunting');
    assert.equal(withFailed.status, 200);
    const failedRows = withFailed.body.rows.filter(r => r.status === 'failed');
    assert.ok(failedRows.length >= 1, 'failed reports appear when asked for');
    for (const r of failedRows) { assert.equal(r.format, 'unfinished'); assert.equal(r.headline, null); assert.ok(!('older_range' in r)); assert.equal(r.confidence_label, null); }
    assert.equal((await call('/api/rental-analysis/history?show_failed=0&q=bunting&limit=100')).body.rows.filter(r => r.status !== 'complete').length, 0);

    // what each kind of report looks like in the list
    const ids = k => savedLive[k].analysis.id;
    const listAll = (await call('/api/rental-analysis/history?limit=100&q=ventura')).body.rows;
    const rowFor = id => { const r = listAll.find(x => x.id === id); assert.ok(r, id); return r; };
    const hi = rowFor(ids('high'));
    assert.equal(hi.format, 'new');
    assert.deepEqual(hi.headline, { low: reopened.high.headline.low, high: reopened.high.headline.high });
    assert.equal(hi.suggested_list_price, reopened.high.headline.listPrice);
    assert.equal(hi.confidence_label, 'high');
    assert.equal(hi.run_by_name, 'Pat Runner');
    assert.ok(!('older_range' in hi));
    assert.equal(rowFor(ids('low')).confidence_label, 'low');
    assert.equal(rowFor(ids('low')).run_by_name, 'Sam Second');
    const th = rowFor(ids('thin'));
    assert.deepEqual([th.format, th.headline, th.confidence_label, th.suggested_list_price], ['new', null, null, null]);
    const od = rowFor(oldId);
    assert.deepEqual([od.format, od.headline, od.confidence_label, od.suggested_list_price], ['older', null, null, null]);
    assert.ok(!('older_range' in od), 'an older row carries no old figures in the list (the screen shows only an "Older report" tag)');
    for (const figure of ['3800', '4200', '4650', '3500', '5000']) assert.ok(!JSON.stringify(od).includes(figure), `${figure} is not in an older row of the list`);
    assert.equal(od.run_by_name, 'Sam Second');

    // searching the address: any capitals, every word must match
    const found = await call('/api/rental-analysis/history?q=BUNTING%20avenue&limit=100');
    assert.ok(found.body.rows.length > 5);
    for (const r of found.body.rows) assert.match(r.subject_address, /bunting avenue/i);
    assert.deepEqual((await call('/api/rental-analysis/history?q=old%20method')).body.rows.map(r => r.id), [oldId]);
    assert.deepEqual((await call(`/api/rental-analysis/history?q=${encodeURIComponent('77 Old Method Way, Ventura, CA 93001')}`)).body.rows.map(r => r.id), [oldId], 'a full address pasted with commas still finds it');
    assert.equal((await call('/api/rental-analysis/history?q=zzzznotanaddress')).body.rows.length, 0);
    assert.equal((await call('/api/rental-analysis/history?q=zzzznotanaddress')).body.hasMore, false);

    // typed search text can never act as a database pattern or an extra filter
    const hostile = ['%', '_', '*', 'Bunt%ng', 'Bunt_ng', '*bunting*', '\\', '\\%', 'a,b', '(a)', 'a" or ""="', "'; drop table rental_analyses; --", 'x&status=eq.failed', 'x&select=*', 'x%26select%3D*', '%26status%3Deq.failed', 'a.b.c', '))))', '𝟏𝟐𝟑', 'ｅｑ.ｘ', 'bunting\u0000avenue', 'x'.repeat(5000), `${'word '.repeat(50)}`, 'ilike.*', 'or=(status.eq.failed)', '2461 Bunting Avenue, Ventura, CA 93003'];
    for (const q of hostile) {
      const before = log2.requests.length;
      const h = await call(`/api/rental-analysis/history?limit=100&q=${encodeURIComponent(q)}`);
      assert.equal(h.status, 200, JSON.stringify(q).slice(0, 60));
      const ask = log2.requests.slice(before).filter(u => u.includes('/rental_analyses?')).map(u => new URLSearchParams(u.split('?')[1]));
      assert.equal(ask.length, 1);
      const keys = [...ask[0].keys()];
      for (const k of keys) assert.ok(['select', 'order', 'limit', 'offset', 'status', 'subject_address'].includes(k), `${JSON.stringify(q).slice(0, 40)}: no extra filter ("${k}")`);
      assert.ok(keys.filter(k => k === 'status').length <= 1 && ask[0].get('status') === 'eq.complete');
      const patterns = ask[0].getAll('subject_address');
      assert.ok(patterns.length <= 6, 'at most 6 words');
      for (const pat of patterns) {
        assert.match(pat, /^ilike\.\*[\p{L}\p{N} .'#/&-]{1,40}\*$/u, `${JSON.stringify(q).slice(0, 40)}: only plain address characters reach the database: ${pat}`);
      }
      assert.equal(ask[0].get('select'), history.LIST_COLUMNS);
      assert.ok(h.body.rows.length <= 100);
    }
    // a text with nothing usable in it means "no filter" (it never means "match nothing special")
    const noWords = await call('/api/rental-analysis/history?limit=100&q=%25%5F%2A');
    assert.deepEqual(noWords.body.rows.map(r => r.id), allComplete.slice(0, 100).map(a => a.id));

    // ── opening one: the address must be a UUID; a missing one is a 404; nothing is looked up for a bad one ──
    for (const bad of ['not-a-uuid', '123', `${uuidFor(1)}x`, `x${uuidFor(1)}`, 'ZZZZZZZZ-0000-4000-8000-000000000001', '..%2F..%2Fusers', encodeURIComponent(`${uuidFor(1)}' or 1=1 --`), encodeURIComponent(`${uuidFor(1)}&select=*`), '%00', 'null', 'undefined', encodeURIComponent(`${uuidFor(1)},${uuidFor(2)}`)]) {
      const before = log2.requests.length;
      const b = await call(`/api/rental-analysis/history/${bad}`);
      assert.equal(b.status, 400, bad);
      assert.equal(typeof b.body.error, 'string');
      assert.ok(!tablesAsked(before).some(t => t.startsWith('rental_')), `${bad}: refused before the database is asked`);
    }
    const missing = await call(`/api/rental-analysis/history/${uuidFor(777777)}`);
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /No saved report was found/);
    const upper = await call(`/api/rental-analysis/history/${ids('high').toUpperCase()}`);
    assert.ok([200, 404].includes(upper.status), 'an upper-case id is a valid UUID and is answered, not crashed on');

    // ── who may ask ──
    const asks = ['/api/rental-analysis/history', '/api/rental-analysis/history?limit=1', `/api/rental-analysis/history/${ids('high')}`];
    for (const mode of ['nomember', 'inactive', 'norole', 'roleerror']) {
      access = mode;
      for (const p of asks) {
        const before = log2.requests.length;
        const x = await call(p);
        assert.equal(x.status, 403, `${mode}: ${p}`);
        assert.match(x.body.error, /does not have access to Rental Analysis/);
        assert.ok(!tablesAsked(before).some(t => t.startsWith('rental_')), `${mode}: no saved report is read for a person without access`);
        assertNoLeak(x.text, `${mode} refusal`);
      }
    }
    access = 'ok';
    for (const p of asks) {
      const none = await call(p, { 'x-test-login': 'no-user' });
      assert.equal(none.status, 403, `reached with no known person: ${p}`);
      const out = await call(p, { 'x-test-login': 'logged-out' });
      assert.equal(out.status, 302, `logged out (the Hub's real login check): ${p}`);
      assert.equal(out.location, '/login');
      assert.ok(!out.text.includes('Bunting'), 'nothing from a report is sent to a logged-out visitor');
    }
    assert.equal((await call(asks[0])).status, 200, 'and a person with access is back in');

    // ── database trouble never leaks its wording ──
    for (const table of ['rental_analyses', 'rental_comps', 'rental_comp_sources']) {
      dbFail.add(table);
      for (const p of table === 'rental_analyses' ? asks.slice(0, 1).concat(asks[2]) : [asks[2]]) {
        const x = await call(p);
        assert.equal(x.status, 500, `${table}: ${p}`);
        assert.equal(typeof x.body.error, 'string');
        assertNoLeak(x.text, `${table} failure`);
        assert.doesNotMatch(x.text, /pg_catalog|XX000|internal detail/);
      }
      dbFail.delete(table);
    }
    dbFail.add('users');
    const noNames = await call('/api/rental-analysis/history?limit=3');
    assert.equal(noNames.status, 200, 'a names problem does not stop the list');
    assert.ok(noNames.body.rows.every(r => r.run_by_name === null));
    assert.equal((await call(asks[2])).status, 200);
    dbFail.delete('users');
    dbFail.add('rental_market_data');
    const noMarketTable = await call(`/api/rental-analysis/history/${oldId}`);
    assert.equal(noMarketTable.status, 200, 'a market-figures problem does not stop the report');
    assert.equal(noMarketTable.body.marketData, null);
    assert.deepEqual(noMarketTable.body.sourceNotes, [history.ORDER_NOTE, history.MARKET_FAILED_NOTE], 'a FAILED lookup is not worded as "not saved"');
    assert.doesNotMatch(noMarketTable.text, /hunter2|DB_PASSWORD|pg_catalog/);
    dbFail.delete('rental_market_data');

    // ── the saved values win, and a wide range is never shown as a recommendation ──
    const highRow = db.analyses.find(a => a.id === ids('high'));
    const keepCount = highRow.counted_comp_count;
    highRow.counted_comp_count = keepCount + 1;
    const off = await call(`/api/rental-analysis/history/${ids('high')}`);
    assert.equal(off.body.counted.total, keepCount + 1, 'the saved count is shown');
    assert.ok(off.body.sourceNotes.includes(history.NOT_MATCHING_NOTE), 'and the screen says the recount did not match');
    highRow.counted_comp_count = keepCount;
    const keepHigh = highRow.headline_range_high;
    highRow.headline_range_high = highRow.headline_range_low + 500;
    const wide = await call(`/api/rental-analysis/history/${ids('high')}`);
    assert.equal(wide.body.headline, null, 'a saved range that is not $200 wide is not shown as a recommendation');
    assert.equal(wide.body.confidence, null);
    assert.equal(wide.body.noRange, history.RANGE_NOT_SHOWN);
    assert.deepEqual([wide.body.analysis.headline_range_low, wide.body.analysis.headline_range_high, wide.body.analysis.suggested_list_price, wide.body.analysis.stretch_price, wide.body.analysis.confidence_label], [null, null, null, null, null], 'the unusable saved range is not passed on in any field');
    assert.equal((await call('/api/rental-analysis/history?limit=100&q=bunting')).body.rows.find(r => r.id === ids('high')).headline, null);
    assertNoWideRange(wide.body);
    highRow.headline_range_high = keepHigh;
    const lowRow = db.analyses.find(a => a.id === ids('low'));
    lowRow.stretch_price = lowRow.headline_range_high + 200; // even if one were saved on a Low report, it stays hidden
    const lowAgain = await call(`/api/rental-analysis/history/${ids('low')}`);
    assert.equal(lowAgain.body.headline.stretchPrice, null);
    assert.equal(lowAgain.body.analysis.stretch_price, null);
    lowRow.stretch_price = null;
    // a report whose saved label is missing or not one of the three words shows no stretch price either
    const keepLabel = highRow.confidence_label;
    for (const badLabel of [null, 'amazing']) {
      highRow.confidence_label = badLabel;
      const noLabel = await call(`/api/rental-analysis/history/${ids('high')}`);
      assert.equal(noLabel.status, 200);
      assert.equal(noLabel.body.headline.stretchPrice, null, `no stretch price with the label ${JSON.stringify(badLabel)}`);
      assert.equal(noLabel.body.analysis.stretch_price, null);
      assert.equal(noLabel.body.confidence, null);
    }
    highRow.confidence_label = keepLabel;
    assert.notEqual((await call(`/api/rental-analysis/history/${ids('high')}`)).body.headline.stretchPrice, null, 'and it comes back with the label');

    // ── nothing above ran a search, wrote anything, or called a paid service ──
    assert.equal(log.rentcastMarket, rentcastBefore, 'no RentCast request from any past-report read');
    assert.equal(log.narrativeCalls, narrativeCallsAfterSetup, 'no writer (AI) call from any past-report read');
    assert.equal(db.comps.length - 0, compsAfterSetup + 6, 'nothing was saved by reading (only the six older-style homes this check added itself)');
    assert.equal(db.analyses.length, analysesAfterSetup + 1 + 130, 'nothing was saved by reading (only the rows this check added itself)');
    console.log('  past reports: list, paging, hard cap, search escaping, failed filter, ids, 404, access and error wording all hold');
  }

  assert.equal(log.blocked.length, 0, `outside network attempts: ${log.blocked.join(', ')}`);
  console.log(`Entry-point harness (${MODE}): PASS`);
  process.exit(0);
})().catch(e => { console.error(`Entry-point harness (${MODE}): FAIL`, e && e.stack || e); process.exit(1); });
