/**
 * backtest/rincon-mls.js
 * The saved MLS evidence about what kind of home each of Rincon's own leases is
 * (CONDO-LEASE-TYPE-SPEC.md). The product asks the MLS about each lease's street
 * address while an analysis runs (lib/leadsimple.js, lookupMlsRecords()). The
 * accuracy test must never reach the network while it replays, so this file pulls
 * the same answers ONCE (a few free Recore reads) into backtest/cache/rincon-mls.json
 * and hands them back to the replay through the same function the product uses
 * (lib/leadsimple.js, buildLeadSimpleComps()), so the test and the product cannot
 * work out a lease's type differently.
 *
 * What is saved: the street address pieces, the zip, the unit and the MLS's kind of
 * home for each record found at a Rincon lease's address. Nothing else: no rents, no
 * dates, no names. The file is git-ignored and kept off the server like the rest of
 * backtest/cache (backtest/.gitignore, deploy-to-sally.sh).
 *
 * Shape: { schema: 1, entries: { "<house number>|<zip>|<street word>": { at: "YYYY-MM-DD", records: [...] } } }
 * An entry with an empty records list is a real answer ("the MLS has nothing at that
 * address"). A search that could not be completed has NO entry, and the replay then
 * keeps that lease's LeadSimple type, exactly as the product does when the MLS fails.
 */
const {
  mlsQueryFor, buildMlsLookupFilter, slimMlsRecord, recordAnswersQuery, resolveLeaseType, classifyRinconLease,
  MLS_TYPE_LOOKUP_LIMITS, MLS_TYPE_SELECT,
} = require('../lib/leadsimple');

const SCHEMA = 1;
const BATCH = MLS_TYPE_LOOKUP_LIMITS.batchSize;
const PAGE = MLS_TYPE_LOOKUP_LIMITS.pageSize;
// A saved answer younger than this is reused by a later pull instead of being asked for again (a building does not change type).
const REUSE_DAYS = 14;
const MAX_PAGES = 5;

const isoDay = d => new Date(d).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);

// One search for a batch of addresses, every page. Returns the raw records, or null when the batch has more than
// MAX_PAGES full pages (the caller then splits it in two).
async function fetchPages(client, batch) {
  const records = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = { '$filter': buildMlsLookupFilter(batch), '$select': MLS_TYPE_SELECT, '$orderby': 'ListingKey asc', '$top': String(PAGE) };
    if (page > 0) params['$skip'] = String(page * PAGE);
    const data = await client.get(params);
    if (!data || !Array.isArray(data.value)) throw new Error('Recore sent back a reply with no "value" list.');
    records.push(...data.value);
    if (data.value.length < PAGE) return records;
  }
  return null;
}

async function fetchBatch(client, batch, out) {
  const records = await fetchPages(client, batch);
  if (records === null) {
    if (batch.length === 1) return; // one address with a thousand records: no answer saved, so the lease keeps its LeadSimple type
    const mid = Math.ceil(batch.length / 2);
    await fetchBatch(client, batch.slice(0, mid), out);
    await fetchBatch(client, batch.slice(mid), out);
    return;
  }
  const slim = records.map(slimMlsRecord).filter(Boolean);
  for (const q of batch) out.set(q.key, slim.filter(rec => recordAnswersQuery(rec, q)));
}

/**
 * Asks the MLS about every Rincon lease address, reusing answers from an earlier pull that are less than REUSE_DAYS old.
 * @param {object} args
 * @param {object} args.client - recore.makeClient() (read only, polite, retrying)
 * @param {object[]} args.rows - the saved leadsimple_new_leases rows
 * @param {object|null} [args.existing] - the evidence file from an earlier pull
 * @param {Date} [args.now]
 * @returns {Promise<{evidence: object, asked: number, reused: number, skipped: number}>}
 */
async function pullRinconMls({ client, rows, existing = null, now = new Date(), log = () => {} }) {
  const today = isoDay(now);
  const queries = [];
  const seen = new Set();
  let skipped = 0;
  for (const row of rows) {
    const q = mlsQueryFor(row);
    if (!q) { skipped++; continue; }
    if (seen.has(q.key)) continue;
    seen.add(q.key);
    queries.push(q);
  }
  const entries = {};
  const toAsk = [];
  let reused = 0;
  for (const q of queries) {
    const old = existing && existing.schema === SCHEMA && existing.entries ? existing.entries[q.key] : null;
    if (old && Array.isArray(old.records) && typeof old.at === 'string' && daysBetween(old.at, today) <= REUSE_DAYS) { entries[q.key] = old; reused++; } else toAsk.push(q);
  }
  const fresh = new Map();
  for (let i = 0; i < toAsk.length; i += BATCH) {
    await fetchBatch(client, toAsk.slice(i, i + BATCH), fresh);
    log(`  Rincon lease types: ${Math.min(i + BATCH, toAsk.length)} of ${toAsk.length} addresses asked`);
  }
  for (const [key, records] of fresh) entries[key] = { at: today, records };
  return { evidence: { schema: SCHEMA, entries }, asked: toAsk.length, reused, skipped };
}

/**
 * The replay's stand-in for the live MLS lookup: same shape of answer, from the saved file. An address with no saved
 * entry comes back as "could not be checked" (null), which keeps its LeadSimple type, as a failed live lookup does.
 */
function evidenceLookup(evidence) {
  return async function lookupFromSavedEvidence(queries) {
    const byKey = new Map();
    for (const q of queries) {
      const entry = evidence && evidence.entries ? evidence.entries[q.key] : null;
      byKey.set(q.key, entry && Array.isArray(entry.records) ? entry.records : null);
    }
    return { byKey, requests: 0, cacheHits: 0, ceilingHit: false, problem: null };
  };
}

/** The type of one lease from the saved evidence ({type, source}); the label when there is no evidence for it. */
function resolverFor(evidence) {
  return function resolveFromSavedEvidence(row) {
    const q = mlsQueryFor(row);
    const entry = q && evidence && evidence.entries ? evidence.entries[q.key] : null;
    if (!entry || !Array.isArray(entry.records)) return classifyRinconLease(row, null);
    return resolveLeaseType(row, entry.records);
  };
}

/**
 * Does the saved file cover the leases? `total` leases have a searchable address; `covered` of them have an entry.
 * `oldest` is the date of the oldest entry, so a trust check can say how stale the evidence is.
 */
function coverageOf(evidence, rows) {
  let total = 0, covered = 0;
  for (const row of rows) {
    const q = mlsQueryFor(row);
    if (!q) continue;
    total++;
    if (evidence && evidence.entries && evidence.entries[q.key] && Array.isArray(evidence.entries[q.key].records)) covered++;
  }
  const dates = evidence && evidence.entries ? Object.values(evidence.entries).map(e => e.at).filter(Boolean).sort() : [];
  return { total, covered, uncovered: total - covered, oldest: dates[0] || null, newest: dates[dates.length - 1] || null };
}

/** True when the file looks like what this module writes. */
function looksLikeEvidence(value) {
  return !!value && typeof value === 'object' && value.schema === SCHEMA && !!value.entries && typeof value.entries === 'object' && !Array.isArray(value.entries);
}

module.exports = { SCHEMA, REUSE_DAYS, pullRinconMls, evidenceLookup, resolverFor, coverageOf, looksLikeEvidence };
