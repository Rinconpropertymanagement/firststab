/**
 * backtest/tests/fake-recore-mls.js
 * A pretend Recore for the Rincon lease-type lookup (lib/leadsimple.js, lookupMlsRecords()). It
 * reads the search the product builds (house number, zip and a street word for each address in the
 * batch), looks each one up in a list the test supplies, and answers the way Recore does: a page of
 * records in "value", honoring $top and $skip. It makes no network request of any kind.
 * Used by q-mapping-unit-test.js and backtest/phase-b-equivalence.js.
 */
const { CRMLS_BASE_URL } = require('../../lib/crmls');

// The searches lib/leadsimple.js builds look like
//   (StreetNumberNumeric eq 1177 and PostalCode eq '93003' and contains(tolower(StreetName),'alder')) or (...)
// Only that shape is understood. Returns [{number, zip, words}].
function parseLookupFilter(filter) {
  const text = String(filter || '');
  const chunks = text.split(/\)\s+or\s+\((?=StreetNumberNumeric eq )/);
  return chunks.map(chunk => {
    const number = chunk.match(/StreetNumberNumeric eq (\d+)/);
    const zip = chunk.match(/PostalCode eq '(\d{5})'/);
    const words = [...chunk.matchAll(/contains\(tolower\(StreetName\),'([a-z0-9]+)'\)/g)].map(m => m[1]);
    if (!number || !zip || !words.length) throw new Error(`fake Recore cannot read this search: ${chunk.slice(0, 80)}`);
    return { number: Number(number[1]), zip: zip[1], words };
  });
}

// A record as Recore sends it (the fields the product asks for).
function toRecoreRecord(rec, index = 0) {
  return {
    ListingKey: `fake-${index}`,
    StreetNumberNumeric: rec.number,
    StreetDirPrefix: rec.dirPrefix || null,
    StreetName: rec.street,
    StreetSuffix: rec.suffix || null,
    StreetDirSuffix: rec.dirSuffix || null,
    UnitNumber: rec.unit || null,
    PostalCode: rec.zip,
    PropertySubType: rec.subtype || null,
  };
}

/**
 * @param {object} args
 * @param {Function} args.recordsFor - ({number, zip, words}) => the records (in the saved shape: number, zip, dirPrefix, street, suffix, dirSuffix, unit, subtype) a search for that address finds
 * @param {Function} [args.onRequest] - called with the parsed request: {queries, top, skip, tokenSeen}
 * @param {Function} [args.respond] - (request) => a Response-like to send instead (a failure, a delay); return undefined to answer normally
 * @returns {Function} a fetch
 */
function makeFakeRecoreFetch({ recordsFor, onRequest = null, respond = null }) {
  return async function fakeFetch(url, opts) {
    const u = new URL(String(url));
    if (!String(url).startsWith(CRMLS_BASE_URL)) throw new Error(`fake Recore was asked for something else: ${u.origin}${u.pathname}`);
    const queries = parseLookupFilter(u.searchParams.get('$filter'));
    const top = Number(u.searchParams.get('$top') || 200);
    const skip = Number(u.searchParams.get('$skip') || 0);
    const request = { queries, top, skip, tokenSeen: u.searchParams.has('access_token'), select: u.searchParams.get('$select'), signal: opts && opts.signal };
    if (onRequest) onRequest(request);
    if (respond) {
      const custom = await respond(request);
      if (custom !== undefined) return custom;
    }
    // The union of what each address in the batch finds. A record two searches both find is sent once; identical records
    // inside ONE search (the same unit listed twice) are all sent.
    const most = new Map();
    const sample = new Map();
    for (const q of queries) {
      const counts = new Map();
      for (const rec of recordsFor(q) || []) {
        const key = JSON.stringify(rec);
        counts.set(key, (counts.get(key) || 0) + 1);
        sample.set(key, rec);
      }
      for (const [key, n] of counts) most.set(key, Math.max(most.get(key) || 0, n));
    }
    const all = [];
    for (const [key, n] of most) for (let i = 0; i < n; i++) all.push(sample.get(key));
    const page = all.slice(skip, skip + top).map((rec, i) => toRecoreRecord(rec, skip + i));
    return { ok: true, status: 200, json: async () => ({ value: page }), text: async () => JSON.stringify({ value: page }) };
  };
}

module.exports = { parseLookupFilter, toRecoreRecord, makeFakeRecoreFetch };
