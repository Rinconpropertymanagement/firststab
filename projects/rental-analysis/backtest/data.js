/**
 * backtest/data.js
 * Fills and reads the local cache (backtest/cache/, git-ignored):
 *   closed.json      CRMLS closed leases for the padded county box (Recore, free)
 *   active.json      CRMLS Active leases right now (fidelity check only)
 *   leadsimple.json  Rincon's own new-lease rows (Supabase GET)
 *   properties.json  Rincon properties (id, address, city, state, zip) so the
 *                    "Rincon-managed" check behaves as in production
 *   analyses.json    saved rental_analyses (Supabase GET) for the outcome matcher
 *   meta.json        when it was pulled, counts, request count, self-test results
 * Reads only; nothing is ever written to Recore or Supabase.
 */
const path = require('path');
const { loadEnv, requireEnv } = require('./env');
const { getAll } = require('./db');
const recore = require('./recore');
const { DEFAULT_DATA_FROM } = require('./constants');

async function refreshCache({ dataFrom = DEFAULT_DATA_FROM, log = () => {}, dir = recore.CACHE_DIR } = {}) {
  loadEnv();
  requireEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'RECORE_SERVER_TOKEN']);
  const client = recore.makeClient();
  log(`Pulling CRMLS leases from Recore (closed since ${dataFrom}, plus current Active)...`);
  const { closed, active } = await recore.pullCounty({ client, dataFrom, log });
  log('Reading Rincon rows from Supabase (GET only)...');
  const [leadsimple, properties, analyses] = await Promise.all([
    getAll('leadsimple_new_leases', 'select=*&order=id.asc'),
    getAll('properties', 'select=id,address,city,state,zip&order=id.asc'),
    getAll('rental_analyses', 'select=*&order=created_at.asc,id.asc'),
  ]);
  recore.writeCache('closed.json', closed, dir);
  recore.writeCache('active.json', active, dir);
  recore.writeCache('leadsimple.json', leadsimple, dir);
  recore.writeCache('properties.json', properties, dir);
  recore.writeCache('analyses.json', analyses, dir);
  const meta = {
    pulledAt: new Date().toISOString(),
    dataFrom,
    recoreRequests: client.requests,
    counts: { closed: closed.length, active: active.length, leadsimple: leadsimple.length, properties: properties.length, analyses: analyses.length },
    fidelity: null,
  };
  recore.writeCache('meta.json', meta, dir);
  return { meta, client };
}

// meta.json is an object; the others are lists of records (closed.json must have some, and each must look like a CRMLS lease).
function hasExpectedShape(name, value) {
  if (name === 'meta') return !!value && typeof value === 'object' && !Array.isArray(value);
  if (!Array.isArray(value)) return false;
  if (!value.every(x => x && typeof x === 'object' && !Array.isArray(x))) return false;
  if (name === 'closed') return value.length > 0 && typeof value[0].CloseDate === 'string' && typeof value[0].ListingKey === 'string';
  return true;
}

function loadCache(dir = recore.CACHE_DIR) {
  const out = {};
  for (const name of ['closed', 'active', 'leadsimple', 'properties', 'analyses', 'meta']) {
    const damaged = () => {
      const err = new Error(`Saved data file ${name}.json is damaged and cannot be read. Run: node backtest/run.js --refresh`);
      err.code = 'BAD_CACHE';
      return err;
    };
    try {
      out[name] = recore.readCache(`${name}.json`, dir);
    } catch (_) {
      throw damaged(); // not valid JSON
    }
    if (out[name] !== null && !hasExpectedShape(name, out[name])) throw damaged(); // valid JSON, wrong shape
    if (out[name] === null) {
      const err = new Error(`No saved data found (${name}.json is missing from ${path.basename(dir)}/). Run: node backtest/run.js --refresh`);
      err.code = 'NO_CACHE';
      throw err;
    }
  }
  return out;
}

function saveMeta(meta, dir = recore.CACHE_DIR) { recore.writeCache('meta.json', meta, dir); }

module.exports = { refreshCache, loadCache, saveMeta, hasExpectedShape };
