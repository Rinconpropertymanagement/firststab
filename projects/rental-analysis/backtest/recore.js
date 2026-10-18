/**
 * backtest/recore.js
 * Pulls the CRMLS lease records the accuracy test needs from Recore (read-only
 * GETs, free) into plain JSON arrays, and reads/writes the local cache under
 * backtest/cache/ (git-ignored; MLS rows must never be committed or deployed).
 *
 * Two pulls for the whole county box (padded a little so a target near the edge
 * still sees every comp within 2 miles):
 *   - Closed Residential Lease records with CloseDate on or after the pull
 *     start: the leases themselves (targets and as-of comps) AND the source of
 *     the "was it already on the market at date T" asking-price comps.
 *   - Active Residential Lease records right now: only used by the fidelity
 *     check ("as of now" replay vs a live pullCrmlsComps call).
 *
 * Polite: sequential requests, a pause between them, retries with back-off on
 * 429/5xx, a request counter reported at the end. The Recore token goes in the
 * query string (that is how the API works), so every error message is passed
 * through redact() and nothing is ever logged with a URL.
 */
const fs = require('fs');
const path = require('path');
const { CRMLS_BASE_URL } = require('../lib/crmls');
const { redact } = require('./env');
const { COUNTY_BOX, PULL_PAD, RECORE_PAGE, RECORE_DELAY_MS } = require('./constants');

// BACKTEST_CACHE_DIR lets a test (or a second copy of the data) point somewhere else; it defaults to backtest/cache/.
const CACHE_DIR = process.env.BACKTEST_CACHE_DIR || path.join(__dirname, 'cache');

// Everything lib/crmls.js's mapComparable() and buildAddress() read, plus the
// three MLS facts the protocol's target screen and the Item 2 variants use,
// plus CountyOrParish (the MLS's county, used only to GROUP the scorecard; no
// mapper or comp rule reads it).
// Deliberately NOT selected: PublicRemarks and every agent/office field.
const SELECT_FIELDS = [
  'ListingKey', 'ListingId', 'StandardStatus', 'PropertySubType',
  'StreetNumberNumeric', 'StreetDirPrefix', 'StreetName', 'StreetSuffix', 'StreetDirSuffix', 'UnitNumber',
  'City', 'StateOrProvince', 'PostalCode',
  'BedroomsTotal', 'BathroomsTotalDecimal',
  'ListPrice', 'ClosePrice', 'OriginalListPrice',
  'CloseDate', 'OnMarketDate', 'ListingContractDate',
  'Latitude', 'Longitude', 'LivingArea', 'DaysOnMarket',
  'Furnished', 'LeaseTerm', 'SeniorCommunityYN',
  'CountyOrParish',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeClient({ fetchImpl = fetch, delayMs = RECORE_DELAY_MS, retryMs = 1000, token = process.env.RECORE_SERVER_TOKEN } = {}) {
  if (!token) throw new Error('Missing RECORE_SERVER_TOKEN (projects/rental-analysis/.env).');
  const client = {
    requests: 0,
    async get(params) {
      const qs = new URLSearchParams({ access_token: token, ...params });
      let lastErr = null;
      for (let attempt = 1; attempt <= 4; attempt++) {
        if (client.requests > 0) await sleep(delayMs);
        client.requests++;
        let res;
        try {
          res = await fetchImpl(`${CRMLS_BASE_URL}?${qs.toString()}`);
        } catch (err) {
          lastErr = new Error(`Recore request failed: ${redact(err.message)}`);
          await sleep(retryMs * attempt);
          continue;
        }
        if (res.ok) return res.json();
        const body = redact(await res.text().catch(() => ''));
        lastErr = new Error(`Recore request failed (${res.status}): ${body.slice(0, 200)}`);
        if (res.status !== 429 && res.status < 500) throw lastErr; // a 4xx other than 429 will not get better by retrying
        await sleep(retryMs * attempt);
      }
      throw lastErr;
    },
  };
  return client;
}

function paddedBoxFilter(box = COUNTY_BOX, pad = PULL_PAD) {
  const minLat = (box.minLat - pad.lat).toFixed(4), maxLat = (box.maxLat + pad.lat).toFixed(4);
  const minLon = (box.minLon - pad.lon).toFixed(4), maxLon = (box.maxLon + pad.lon).toFixed(4);
  return `Latitude ge ${minLat} and Latitude le ${maxLat} and Longitude ge ${minLon} and Longitude le ${maxLon}`;
}

function cleanRecord(record) {
  const out = {};
  for (const f of SELECT_FIELDS) if (record[f] !== undefined) out[f] = record[f];
  return out;
}

// Pages through one filtered query. Ordering is fixed (date, then ListingKey) so
// $skip paging cannot repeat or skip a record; the first page also asks for
// the total so a short read is caught.
async function pagedPull(client, { filter, orderby, label, log = () => {} }) {
  const records = [];
  let total = null;
  for (let skip = 0; ; skip += RECORE_PAGE) {
    const params = { '$filter': filter, '$select': SELECT_FIELDS.join(','), '$orderby': orderby, '$top': String(RECORE_PAGE), '$skip': String(skip) };
    if (skip === 0) params['$count'] = 'true';
    const data = await client.get(params);
    if (skip === 0 && typeof data['@odata.count'] === 'number') total = data['@odata.count'];
    const page = Array.isArray(data.value) ? data.value : [];
    records.push(...page.map(cleanRecord));
    log(`  ${label}: ${records.length}${total !== null ? ` of ${total}` : ''}`);
    if (page.length < RECORE_PAGE) break;
  }
  if (total !== null && records.length !== total) {
    throw new Error(`${label}: read ${records.length} records but Recore reported ${total}; data changed mid-pull, re-run --refresh.`);
  }
  return records;
}

async function pullCounty({ client, dataFrom, log }) {
  const box = paddedBoxFilter();
  const base = `PropertyType eq 'Residential Lease' and ${box}`;
  const closed = await pagedPull(client, {
    filter: `StandardStatus eq 'Closed' and ${base} and CloseDate ge ${dataFrom}`,
    orderby: 'CloseDate asc,ListingKey asc', label: 'closed leases', log,
  });
  const active = await pagedPull(client, {
    filter: `StandardStatus eq 'Active' and ${base}`,
    orderby: 'OnMarketDate asc,ListingKey asc', label: 'active leases', log,
  });
  return { closed, active };
}

function cachePath(name, dir = CACHE_DIR) { return path.join(dir, name); }

function writeCache(name, data, dir = CACHE_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = cachePath(`${name}.tmp`, dir);
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, cachePath(name, dir));
}

function readCache(name, dir = CACHE_DIR) {
  const p = cachePath(name, dir);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

module.exports = { SELECT_FIELDS, CACHE_DIR, makeClient, paddedBoxFilter, pagedPull, pullCounty, cleanRecord, writeCache, readCache };
