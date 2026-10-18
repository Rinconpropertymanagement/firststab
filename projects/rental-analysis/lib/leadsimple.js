/**
 * lib/leadsimple.js
 * Third comp source, alongside lib/rentcast.js and lib/crmls.js — real,
 * confirmed-current new-tenant leases from Rincon's own portfolio, synced
 * nightly from LeadSimple's "02 Move Ins" process type into the
 * `leadsimple_new_leases` table (see the migration and
 * projects/hub/leadsimple-property-brain/sync-move-in-leases.js). See
 * LEADSIMPLE-COMP-SOURCE-SPEC.md for the full design and the live-tested
 * numbers behind every decision below.
 *
 * NO LIVE LEADSIMPLE API CALL HAPPENS HERE. This only ever reads the synced
 * table (lib/supabase.js's select()) — same "sync, not a live lookup"
 * reasoning as sync-property-stages.js: LeadSimple's API has no address
 * filter, so a live per-analysis lookup would mean paging the whole account
 * inside a request/response cycle. If the nightly sync has a bad night or
 * LEADSIMPLE_API_KEY lapses, this source just serves whatever's already
 * saved (possibly stale, never wrong-tenant — the table only ever holds
 * confirmed-current rows, see the sync script) — same graceful-degradation
 * shape as every other source in lib/sources.js.
 *
 * Every comp this source produces:
 *   - listing_status: 'leased' — a real, closed, confirmed-new-tenant
 *     lease, the same top trust tier CRMLS's real closed transactions get
 *     (lib/weighting.js, 3x weight). Considered and rejected: a 4th,
 *     higher tier — see spec's "Weight tier" section for why.
 *   - is_estimated_price: false, always — every row in leadsimple_new_leases
 *     already passed the sync script's `leases` cross-reference confirming
 *     currency; there is no estimated-price case left in this design (see
 *     spec, "Does market_rent/is_estimated_price still belong").
 *   - is_rincon_managed will end up true for nearly every comp this source
 *     produces once server.js's existing address-match step runs (these are
 *     Rincon's own properties, by construction) — that's expected and
 *     handled by lib/weighting.js's SELF_SOURCED_TRUSTED_SOURCE_NAMES
 *     exemption, not something this file needs to know about. This file
 *     just needs source_name to end up 'LeadSimple Move-Ins' exactly (set
 *     by lib/sources.js's runActiveSources(), from the rental_comp_sources
 *     row's own name) — that exact string is what the exemption keys off.
 *
 * COORDINATES / RADIUS (added for the distance-based comp tiering build —
 * see lib/constants.js): leadsimple_new_leases now carries a
 * latitude/longitude column pair (migration 20260919000000), geocoded by
 * sync-move-in-leases.js via LocationIQ — NOT read from LeadSimple itself,
 * which has no coordinates anywhere in its own data (confirmed live). A row
 * geocoded before this build, or one whose geocode failed, simply has null
 * coordinates — pullLeadSimpleComps() below degrades to exactly the
 * previous zip-only behavior for those, never throws. The query itself
 * stays zip-scoped either way (no DB-side radius query exists here); this
 * file computes real distance_miles and bounds each row to
 * WIDE_SEARCH_RADIUS_MILES, but no longer decides narrow vs. wide for
 * itself — that decision is now made once, across all three comp sources
 * together, by applyCombinedRadiusTiering() in lib/sources.js, after every
 * active source has reported back.
 *
 * WHAT KIND OF HOME EACH LEASE REALLY IS (CONDO-LEASE-TYPE work, 2026-10-17):
 * LeadSimple labels almost every property "Single Home", but the MLS says 46 of
 * every 100 of those are really condos or townhomes. A condo counted as a house
 * (or a house thrown out of a condo report) is the wrong-comp error this tool must
 * never make, so for each lease the report is about to consider this file asks the
 * MLS (CRMLS through Recore, the same feed and key lib/crmls.js uses) what is at
 * that street address, and uses the MLS's answer in place of LeadSimple's label.
 * The rules are in classifyRinconLease() below. In short: use the MLS's type only
 * when ALL its records for that address agree; a unit number in the address means
 * "not a house"; a condo/townhouse mix is "other"; a real disagreement, no MLS
 * record, or an MLS that could not be reached keeps what LeadSimple says. The
 * lookup is capped in time and size (MLS_TYPE_LOOKUP_LIMITS) and can NEVER fail an
 * analysis. It is not a new comp source: it only decides the type of a lease we
 * already have.
 *
 * Two other fixes live here: a lease whose rent cannot be right for the home (a
 * 3-bedroom house at $280) carries a mark and never counts, and a "Multi-Family"
 * lease is no longer an unknown type that counts for every kind of subject.
 */

const { select } = require('./supabase');
const { subjectZipFor, haversineMiles, FROM_CRMLS_PROPERTY_TYPE, CRMLS_BASE_URL } = require('./crmls');
const { WIDE_SEARCH_RADIUS_MILES, RINCON_RENT_SCREEN, PROPERTY_TYPES, positiveOrNull } = require('./constants');
const { BEDROOM_MISMATCH_THRESHOLD } = require('./weighting');
const { streetParts, unitIdentifier, STREET_SUFFIX, STREET_DIRECTION, STREET_NAME_SYNONYM } = require('./property-matching');

// "The last year or two at the most," per Peter's own words (spec, "What Q
// Needs to Build This") — scopes which of Rincon's own confirmed-current
// leases count as a recent enough new-tenant signing event to represent
// "what a new tenant recently agreed to pay," not "what everyone happens to
// be paying now" (a lease signed 4 years ago and never turned over hasn't
// been tested against today's market any more recently than a renewal has,
// even though leases.monthly_rent keeps its number fresh via nightly
// AppFolio sync — see spec, "Does the 2-year lookback window still matter").
// Easy to dial to 12-18 later; nothing else needs to change.
const MOVE_IN_LOOKBACK_MONTHS = 24;

// LeadSimple's own property_type free text -> our CHECK-constraint list
// (rental_comps.property_type, identical list to lib/crmls.js's
// FROM_CRMLS_PROPERTY_TYPE / lib/rentcast.js's FROM_RENTCAST_PROPERTY_TYPE
// target). Live-sampled real values across all 667 closed "02 Move Ins"
// records this session: 8 distinct values total, only these two clean
// enough to map 1:1 — 'Multi-Family', 'Multi-Family 2-4 units', 'Student',
// two legacy price-range labels, and nulls are all left unmapped -> null,
// same "say unknown rather than guess" discipline as every other mapper in
// this pipeline (see spec, "What Q Needs to Build This").
const FROM_LEADSIMPLE_PROPERTY_TYPE = {
  'Single Home': 'single_family',
  'Single-Family': 'single_family',
};

// A "Multi-Family" lease (LeadSimple's word for a unit in a building with other
// units) used to map to "unknown type", and an unknown type counts for EVERY kind
// of subject: one report counted three of them, a 3-bedroom house among them, for a
// 2-bedroom condo. It now maps to "apartment", a real type that is not a house, a
// condo or a townhouse, so it no longer counts for those subjects. Where the MLS
// has a clear answer for the address (duplex, condo ...) that answer is used instead.
const MULTI_FAMILY_TYPE = 'apartment';

// True for LeadSimple's "Multi-Family" label and any variant of it ("Multi-Family 2-4 units").
function isMultiFamilyLabel(label) {
  return typeof label === 'string' && /multi[\s-]*family/i.test(label);
}

// What LeadSimple's own label says, with no MLS help: the type used when the MLS has
// nothing to add, could not be reached, or was not asked. null (unknown) for a label
// that is not clearly one of the kinds above, exactly as before.
function labelType(row) {
  const label = row && row.property_type;
  // Object.hasOwn: a label (or any text from outside) such as "constructor" must never find one of JavaScript's own
  // built-in properties and come back as a function instead of a type.
  if (typeof label === 'string' && Object.hasOwn(FROM_LEADSIMPLE_PROPERTY_TYPE, label)) return FROM_LEADSIMPLE_PROPERTY_TYPE[label];
  if (isMultiFamilyLabel(label)) return MULTI_FAMILY_TYPE;
  return null;
}

// A type is one of the nine words the database accepts, or null (unknown). Anything else is never trusted as a type.
const isAllowedType = t => t === null || (typeof t === 'string' && PROPERTY_TYPES.includes(t));

// Looks a word up in one of the fixed tables, but only among the table's own entries (see labelType()).
const ownEntry = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);

// ─── Does this rent make sense for this home? ────────────────────────────────
// The limits are in lib/constants.js (RINCON_RENT_SCREEN). The accuracy test
// (backtest/targets.js) picks the leases it tests with these same functions.
function rentOutsideRange(rent) {
  return !(rent >= RINCON_RENT_SCREEN.minRent && rent <= RINCON_RENT_SCREEN.maxRent);
}

// Rent per square foot, only when the size is a real number: a lease with no size is
// never judged on it. Either the rent or the size is a data error when this is true.
function rentPerSqftOutsideRange(rent, sqft) {
  if (!(typeof sqft === 'number' && sqft > 0)) return false;
  const perSqft = rent / sqft;
  return !(perSqft >= RINCON_RENT_SCREEN.minRentPerSqft && perSqft <= RINCON_RENT_SCREEN.maxRentPerSqft);
}

function rentLooksImplausible(rent, sqft) {
  return rentOutsideRange(rent) || rentPerSqftOutsideRange(rent, sqft);
}

// ─── The MLS lookup: what kind of home is at this street address? ─────────────
// The most a single analysis may spend on it. When any limit is reached the leases
// not yet checked keep their LeadSimple type, the analysis finishes, and the report
// says the check was only partly done (lib/outcome.js buildSourceNotes).
const MLS_TYPE_LOOKUP_LIMITS = Object.freeze({
  batchSize: 20,            // street addresses asked about in one Recore request
  requestTimeoutMs: 5000,   // one request
  totalBudgetMs: 8000,      // all the requests of one analysis together
  maxRequests: 6,           // all the requests (pages included) of one analysis
  pageSize: 200,            // Recore's largest page; a full page means "there may be more"
  maxPagesPerBatch: 3,      // a batch that still has more after this is given up on
  stopAfterFailures: 2,     // this many requests in a row failing ends the check early
  cacheHours: 12,           // how long an answer is remembered in memory
  maxCacheEntries: 3000,
});

// The name this check goes by in a source's "only partly worked" warning (lib/sources.js). lib/outcome.js recognizes it
// and writes the screen note in its own words instead of the generic "only partly available" sentence.
const TYPE_CHECK_WHAT = "its check of each home's type against the MLS";

// The fields asked for: just enough to say which street address and unit a record is
// and what kind of home the MLS calls it. No rents, dates or names.
const MLS_TYPE_SELECT = 'ListingKey,StreetNumberNumeric,StreetDirPrefix,StreetName,StreetSuffix,StreetDirSuffix,UnitNumber,PostalCode,PropertySubType';

// "O'Neill", "St. Clair", "Fourth": the pieces of a street name the MLS might spell
// differently are tried both ways in the search (the street is then matched exactly
// on this side, see recordsAtAddress()).
function wordAlternates(word) {
  const out = [word];
  const short = ownEntry(STREET_NAME_SYNONYM, word);
  if (short) out.push(short);
  for (const [spelled, shortForm] of Object.entries(STREET_NAME_SYNONYM)) if (shortForm === word) out.push(spelled);
  return [...new Set(out)];
}

const MAX_STREET_WORD_LENGTH = 40;

// The word the MLS search looks for in the street name: the longest word of the name
// (not a direction, a suffix like "St", or the unit). Letters and digits only, so
// nothing typed in an address can change the shape of the search.
function streetQueryWords(street) {
  const text = String(street || '').toLowerCase().replace(/^\s*\d+\s+/, '');
  const beforeUnit = text.split(/#|\b(?:unit|apt|apartment|ste|suite|bldg|building|space|spc)\b/)[0];
  let tokens = beforeUnit.split(/[^a-z0-9]+/).filter(Boolean);
  // the name ends at the first suffix word after at least one name word ("100 Court St" is the street "court")
  const suffixAt = tokens.findIndex((t, i) => i >= 1 && ownEntry(STREET_SUFFIX, t));
  if (suffixAt !== -1) tokens = tokens.slice(0, suffixAt);
  // a leading direction (N, South ...) is not part of the name, unless it is the only word ("100 East St")
  if (tokens.length > 1 && ownEntry(STREET_DIRECTION, tokens[0])) tokens = tokens.slice(1);
  if (!tokens.length) return [];
  // No real street word is anywhere near this long. A word that is (thousands of letters of nonsense in an address) is not
  // searched for at all: the lease simply keeps its LeadSimple type.
  if (tokens.some(t => t.length > MAX_STREET_WORD_LENGTH)) return [];
  // a word the MLS may spell two ways ("Saint"/"St", "Fourth"/"4th") is a poor word to search by when the name has another
  const spelledTwoWays = t => !!ownEntry(STREET_NAME_SYNONYM, t) || Object.values(STREET_NAME_SYNONYM).includes(t);
  const preferred = tokens.filter(t => !spelledTwoWays(t));
  const pool = preferred.length ? preferred : tokens;
  const longest = pool.reduce((a, b) => (b.length > a.length ? b : a));
  return wordAlternates(longest);
}

/**
 * What to ask the MLS about one Rincon lease: its house number, zip and a word of its
 * street name. null when the address cannot be searched safely (no plain whole-number
 * house number such as "77-79" or "123A", no 5-digit zip, no street word): that lease
 * simply keeps its LeadSimple type.
 * @returns {{key: string, number: number, zip: string, words: string[]}|null}
 */
function mlsQueryFor(row) {
  if (!row || typeof row.address !== 'string') return null;
  const street = row.address.split(',')[0];
  const numberMatch = street.match(/^\s*(\d{1,6})\s+\S/);
  const zipMatch = String(row.zip_code === null || row.zip_code === undefined ? '' : row.zip_code).match(/^\s*(\d{5})(?:-\d{4})?\s*$/);
  if (!numberMatch || !zipMatch) return null;
  const words = streetQueryWords(street);
  if (!words.length) return null;
  const number = Number(numberMatch[1]);
  return { key: `${number}|${zipMatch[1]}|${words.join('/')}`, number, zip: zipMatch[1], words };
}

// The Recore search text for a batch of addresses: for each, same house number AND zip AND a
// word in the street name (any capitals: the name is lowered first, because some MLS street
// names are stored in capitals or with "DRIVE" attached). Everything between the quotes is
// letters and digits only (see streetQueryWords()).
function buildMlsLookupFilter(queries) {
  return queries.map(q => {
    const words = q.words.map(w => `contains(tolower(StreetName),'${w}')`);
    return `(StreetNumberNumeric eq ${q.number} and PostalCode eq '${q.zip}' and ${words.length > 1 ? `(${words.join(' or ')})` : words[0]})`;
  }).join(' or ');
}

const textOrNull = v => (typeof v === 'string' && v.trim() ? v.trim() : null);

// One MLS record cut down to what the type check needs, or null when it cannot say which
// address it is. This is also the exact shape the accuracy test saves (backtest/cache/rincon-mls.json).
function slimMlsRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const rawNumber = r.StreetNumberNumeric;
  const number = typeof rawNumber === 'number' ? rawNumber : (typeof rawNumber === 'string' && /^\d+$/.test(rawNumber.trim()) ? Number(rawNumber) : null);
  const zip = String(r.PostalCode === null || r.PostalCode === undefined ? '' : r.PostalCode).match(/^\s*(\d{5})/);
  const street = textOrNull(r.StreetName);
  if (!Number.isInteger(number) || !zip || !street) return null;
  return {
    number, zip: zip[1], dirPrefix: textOrNull(r.StreetDirPrefix), street,
    suffix: textOrNull(r.StreetSuffix), dirSuffix: textOrNull(r.StreetDirSuffix),
    unit: textOrNull(r.UnitNumber), subtype: textOrNull(r.PropertySubType),
  };
}

// True when this record is one of the ones the search for `query` is meant to return.
function recordAnswersQuery(rec, query) {
  return rec.number === query.number && rec.zip === query.zip && query.words.some(w => rec.street.toLowerCase().includes(w));
}

const recordStreetLine = rec => [rec.number, rec.dirPrefix, rec.street, rec.suffix, rec.dirSuffix].filter(v => v !== null && v !== '').join(' ');

// Is the MLS record on the same street as the lease's address? The same street NAME (any capitals,
// "Saint" and "St.", "Fourth" and "4th"), the same direction when both give one, the same suffix when
// both give one ("Ave" and "Avenue" agree). A street that cannot be read matches nothing.
function sameStreetAs(leaseAddress, rec) {
  const a = streetParts(leaseAddress);
  const b = streetParts(recordStreetLine(rec));
  if (!a.name || !b.name || a.name !== b.name) return false;
  if (a.direction && b.direction && a.direction !== b.direction) return false;
  if (a.suffix && b.suffix && a.suffix !== b.suffix) return false;
  return true;
}

// "3144", "#3144", "Unit 0099" -> "3144", "3144", "99": the same unit however it is written.
function unitKey(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).toLowerCase().trim().replace(/^(?:#|unit|apt|apartment|ste|suite|no\.?)\s*#?\s*/, '').replace(/[^a-z0-9-]/g, '').replace(/^0+(?=\d)/, '');
  return s || null;
}

/**
 * Of the records the search returned, the ones at THIS lease's address: same house number, same zip,
 * same street. (The search itself is looser on purpose, one word of the street name: "Main" also
 * finds "Mainsail" and "Domain".)
 */
function recordsAtAddress(row, queryRecords) {
  const query = mlsQueryFor(row);
  if (!query || !Array.isArray(queryRecords)) return [];
  const street = row.address.split(',')[0];
  return queryRecords.filter(rec => rec.number === query.number && rec.zip === query.zip && sameStreetAs(street, rec));
}

// The kinds of home among records, using the tool's own CRMLS table (lib/crmls.js). A record with
// no kind, or a kind the tool does not map (a loft, a stock cooperative), says nothing and is ignored.
function typesOfRecords(records) {
  return [...new Set(records.map(r => ownEntry(FROM_CRMLS_PROPERTY_TYPE, r.subtype)).filter(t => typeof t === 'string' && isAllowedType(t)))];
}

const isAttachedMix = types => types.length > 1 && types.every(t => t === 'condo' || t === 'townhouse');

/**
 * The real kind of home for one Rincon lease, from the MLS records AT ITS ADDRESS (see
 * recordsAtAddress()). Returns {type, source}. `source` says where the type came from:
 *   'mls'          the MLS decided it
 *   'unit_number'  the address has a unit number, so it is not a house
 *   'label'        LeadSimple's own label (today's behavior)
 * The rules (CONDO-LEASE-TYPE-SPEC.md, "How It Works"):
 *   - records null (the MLS could not be asked or did not answer): the label, for every lease
 *   - a unit number in the address means NOT a house. Only that unit's records are used when
 *     there are any. Condo when every record says condo, townhouse when every record says
 *     townhouse, otherwise "other".
 *   - no unit number, every record the same kind: that kind
 *   - no unit number, a mix of only condo and townhouse: "other" (certainly not a house, and
 *     not a match for a condo or a townhouse subject either, since the tool keeps those apart)
 *   - no unit number, any other mix (a house with a condo, a true conflict), or no usable
 *     record at all: the label
 *   - a "Multi-Family" label is handled the same way except that the label's own fallback is
 *     "apartment", an MLS answer of "single family house" is a conflict with the label (so it is
 *     not trusted and the fallback stands), and a unit number changes nothing.
 * @param {object} row - a leadsimple_new_leases row (address, property_type)
 * @param {object[]|null} records - the MLS records at this address, or null when not checked
 */
function classifyRinconLease(row, records) {
  const result = classifyUnchecked(row, records);
  // The last guard: whatever came out, a type is one of the nine allowed words (or unknown). Anything else keeps the label.
  return isAllowedType(result.type) ? result : { type: labelType(row), source: 'label' };
}

function classifyUnchecked(row, records) {
  const fallback = { type: labelType(row), source: 'label' };
  if (!Array.isArray(records)) return fallback;
  const unit = unitKey(unitIdentifier(row && row.address));
  const unitRecords = unit ? records.filter(r => unitKey(r.unit) === unit) : [];
  const usable = unitRecords.length ? unitRecords : records;
  const types = typesOfRecords(usable);

  if (isMultiFamilyLabel(row && row.property_type)) {
    if (types.length === 1 && types[0] !== 'single_family') return { type: types[0], source: 'mls' };
    if (isAttachedMix(types)) return { type: 'other', source: 'mls' };
    return fallback;
  }
  if (unit) {
    if (types.length === 1 && (types[0] === 'condo' || types[0] === 'townhouse')) return { type: types[0], source: 'mls' };
    return { type: 'other', source: 'unit_number' };
  }
  if (types.length === 1) return { type: types[0], source: 'mls' };
  if (isAttachedMix(types)) return { type: 'other', source: 'mls' };
  return fallback;
}

// A lease's records out of what the search returned for its query, then classified. `queryRecords`
// null means "could not be checked".
function resolveLeaseType(row, queryRecords) {
  if (!Array.isArray(queryRecords)) return classifyRinconLease(row, null);
  return classifyRinconLease(row, recordsAtAddress(row, queryRecords));
}

// ─── Fetching from Recore, with limits, a memory of recent answers, and no way to throw ──
const mlsAnswerCache = new Map();   // query key -> {at, records}
function clearMlsTypeCache() { mlsAnswerCache.clear(); }

// Waits for `work` but gives up after `ms`. The request is also told to stop (signal) for a fetch
// that listens; a fetch that does not is simply no longer waited for.
function withTimeout(makeWork, ms) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (controller) { try { controller.abort(); } catch (_) { /* nothing to stop */ } }
      const err = new Error('timed out');
      err.timedOut = true;
      reject(err);
    }, ms);
  });
  return Promise.race([Promise.resolve().then(() => makeWork(controller ? controller.signal : undefined)), timeout]).finally(() => clearTimeout(timer));
}

// A reason in plain words for a log line. Never the address of the request (its web address carries the access key).
function failureReason(err) {
  if (err && err.timedOut) return 'it did not answer in time';
  if (err && typeof err.status === 'number') return `it answered with an error (status ${err.status})`;
  return 'it could not be reached';
}

/**
 * Asks the MLS about a list of addresses (see mlsQueryFor()). NEVER throws.
 * @param {{key: string, number: number, zip: string, words: string[]}[]} queries
 * @param {object} [options] - for tests: limits, fetchImpl, token, cache, now
 * @returns {Promise<{byKey: Map<string, object[]|null>, requests: number, cacheHits: number, ceilingHit: boolean, problem: string|null}>}
 *   byKey: the records found for each query (an empty list is a real answer: "the MLS has nothing at that address");
 *   null means the address could not be checked (a failed request, the limits reached, no access key)
 */
async function lookupMlsRecords(queries, options = {}) {
  const limits = { ...MLS_TYPE_LOOKUP_LIMITS, ...(options.limits || {}) };
  const now = options.now || Date.now;
  const cache = options.cache || mlsAnswerCache;
  const out = { byKey: new Map(), requests: 0, cacheHits: 0, ceilingHit: false, problem: null };
  try {
    const started = now();
    const pending = [];
    const seen = new Set();
    for (const q of queries) {
      if (!q || seen.has(q.key)) continue;
      seen.add(q.key);
      const hit = cache.get(q.key);
      if (hit && now() - hit.at < limits.cacheHours * 3600000) { out.byKey.set(q.key, hit.records); out.cacheHits++; } else pending.push(q);
    }
    if (!pending.length) return out;
    const token = options.token !== undefined ? options.token : process.env.RECORE_SERVER_TOKEN;
    const fetchImpl = options.fetchImpl || global.fetch;
    if (!token || typeof fetchImpl !== 'function') {
      for (const q of pending) out.byKey.set(q.key, null);
      out.problem = !token ? 'there is no MLS access key on this server' : 'this server cannot make web requests';
      return out;
    }

    let failuresInARow = 0;
    for (let i = 0; i < pending.length; i += limits.batchSize) {
      const batch = pending.slice(i, i + limits.batchSize);
      const elapsed = now() - started;
      if (out.requests >= limits.maxRequests || elapsed >= limits.totalBudgetMs) {
        out.ceilingHit = true;
        for (const q of pending.slice(i)) out.byKey.set(q.key, null);
        break;
      }
      if (failuresInARow >= limits.stopAfterFailures) {
        for (const q of pending.slice(i)) out.byKey.set(q.key, null);
        break;
      }
      const result = await fetchBatch(batch, { limits, now, started, fetchImpl, token, out });
      if (result.ok) {
        failuresInARow = 0;
        const slim = result.records.map(slimMlsRecord).filter(Boolean);
        for (const q of batch) {
          const mine = slim.filter(rec => recordAnswersQuery(rec, q));
          out.byKey.set(q.key, mine);
          cache.set(q.key, { at: now(), records: mine });
        }
        while (cache.size > limits.maxCacheEntries) cache.delete(cache.keys().next().value);
      } else {
        failuresInARow++;
        if (result.ceiling) out.ceilingHit = true;
        if (!out.problem) out.problem = result.reason;
        for (const q of batch) out.byKey.set(q.key, null);
      }
    }
  } catch (err) {
    // Nothing above should throw; if something does, whatever was not answered keeps its LeadSimple type.
    out.problem = out.problem || 'an unexpected error stopped the check';
    for (const q of queries || []) if (q && !out.byKey.has(q.key)) out.byKey.set(q.key, null);
  }
  return out;
}

// One batch of addresses: one request, plus more pages while a page comes back full. {ok, records} or {ok: false, reason}.
async function fetchBatch(batch, { limits, now, started, fetchImpl, token, out }) {
  const records = [];
  for (let page = 0; page < limits.maxPagesPerBatch; page++) {
    const remaining = limits.totalBudgetMs - (now() - started);
    if (remaining <= 0 || out.requests >= limits.maxRequests) return { ok: false, ceiling: true, reason: 'the limit for the check was reached' };
    const params = new URLSearchParams({
      access_token: token,
      '$filter': buildMlsLookupFilter(batch),
      '$select': MLS_TYPE_SELECT,
      '$orderby': 'ListingKey asc',
      '$top': String(limits.pageSize),
    });
    if (page > 0) params.set('$skip', String(page * limits.pageSize));
    out.requests++;
    let data;
    try {
      data = await withTimeout(async signal => {
        const res = await fetchImpl(`${CRMLS_BASE_URL}?${params.toString()}`, signal ? { signal } : undefined);
        if (!res || !res.ok) { const e = new Error('bad status'); e.status = res ? res.status : 0; throw e; }
        return res.json();
      }, Math.min(limits.requestTimeoutMs, remaining));
    } catch (err) {
      return { ok: false, reason: failureReason(err), ceiling: !!(err && err.timedOut && remaining < limits.requestTimeoutMs) };
    }
    if (!data || !Array.isArray(data.value)) return { ok: false, reason: 'it sent back a reply that could not be read' };
    records.push(...data.value);
    if (data.value.length < limits.pageSize) return { ok: true, records };
  }
  // Still more after the last page allowed: the batch is incomplete, and an incomplete list could hide a disagreement.
  return { ok: false, reason: 'too many records came back at once' };
}

function toDateOnly(dateString) {
  if (!dateString || typeof dateString !== 'string') return null;
  return dateString.slice(0, 10); // already 'YYYY-MM-DD' from the sync script; slice is a safe no-op if ever fuller
}

// Builds one comparable-format address string from the table's separate
// address/city/state/zip_code columns — same free-text join shape as
// lib/crmls.js's buildAddress(), needed here because rental_comps.address
// (and this pipeline's dedupeComps()/findBestPropertyMatch() address
// matching) expects one formatted string, not decomposed parts.
function buildAddress(row) {
  const cityStateZip = [row.city, [row.state, row.zip_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [row.address, cityStateZip].filter(Boolean).join(', ');
}

// leadsimple_new_leases.rent is NUMERIC(10,2) NOT NULL CHECK (rent >= 0), so
// the table itself allows a rent of 0, and a saved comp from this source
// (3491 Kings Canyon Dr, Oxnard) did come through at $0. Read-only filter
// here — nothing in Supabase is changed. A rent of 0 means "rent unknown",
// never "free"; a $0 leased comp counts 3x and would drag the range's low end
// to $0. Returns a number > 0, else null. A numeric string is still accepted
// (as before); null, '', 0, negatives and NaN are not.
function positiveRentOrNull(rent) {
  return positiveOrNull(typeof rent === 'string' && rent.trim() !== '' ? Number(rent) : rent);
}

/**
 * Maps one leadsimple_new_leases row into a partial rental_comps row, or
 * returns null when the row has no rent > 0 (see positiveRentOrNull() —
 * pullLeadSimpleComps() drops the nulls).
 * Exported (like every other source's mapComparable) so the test suite can
 * exercise it directly without a real Supabase table.
 *
 * @param {object} row
 * @param {number|null} [distanceMiles] - real Haversine distance from the
 *   subject, computed by pullLeadSimpleComps() when both the subject and
 *   this row have real coordinates (see the migration adding
 *   leadsimple_new_leases.latitude/longitude). Omitted (-> null) for a row
 *   with no coordinates of its own (not yet backfilled, or its geocode
 *   failed) or when the subject has none — never guessed, same convention
 *   as lib/crmls.js's own mapComparable().
 * @param {string|null} [resolvedType] - the home's real type when it has been worked out
 *   (classifyRinconLease()). Left out, the type is what LeadSimple's own label says
 *   (labelType()). null means "unknown" and is a real answer, not "left out".
 * @param {string} [typeSource] - 'mls', 'unit_number' or 'label': where resolvedType came from.
 *   It rides on the comp (never saved; there is no column for it) so the report can say
 *   "the MLS lists it as a condo" beside a lease that is not used.
 */
function mapComparable(row, distanceMiles = null, resolvedType, typeSource) {
  const monthlyRent = positiveRentOrNull(row.rent);
  if (monthlyRent === null) return null;
  const hasCoords = typeof row.latitude === 'number' && typeof row.longitude === 'number';
  const typeGiven = resolvedType !== undefined && isAllowedType(resolvedType || null);
  const sqft = typeof row.sqft === 'number' ? row.sqft : null;
  return {
    address: buildAddress(row),
    property_type: typeGiven ? (resolvedType || null) : labelType(row),
    // Where the type came from; shown on the report, never saved (see the comment above).
    property_type_source: typeGiven && typeSource ? typeSource : 'label',
    bedrooms: typeof row.bedrooms === 'number' ? row.bedrooms : null,
    bathrooms: typeof row.bathrooms === 'number' ? row.bathrooms : null,
    sqft,
    // Real, computed distance when pullLeadSimpleComps() could compute one
    // (subject + this row both geocoded); null otherwise — this source is
    // zip-scoped at the query level either way (see pullLeadSimpleComps()),
    // same as lib/crmls.js's own zip-fallback path. Never guessed.
    distance_miles: typeof distanceMiles === 'number' ? distanceMiles : null,
    latitude: hasCoords ? row.latitude : null,
    longitude: hasCoords ? row.longitude : null,
    monthly_rent: monthlyRent,
    // True when this rent cannot be right for this home (3 bedrooms at $280, 613 sq ft at $199).
    // The comp is still kept and shown as "not used", but it never counts: lib/weighting.js.
    // Never saved (there is no column for it).
    implausible_rent: rentLooksImplausible(monthlyRent, sqft),
    // Always false — see file header. leadsimple_new_leases carries no
    // is_estimated_price column at all; hardcoded here, same pattern
    // lib/crmls.js uses for its own certain-price (Closed) case.
    is_estimated_price: false,
    original_price: null,
    had_price_cut: false,
    // The whole point of this source: a real, confirmed, new-tenant lease —
    // see lib/weighting.js for the 3x weight this earns.
    listing_status: 'leased',
    days_on_market: null,
    // "when it went off market / lease began" per rental_comps' dual-purpose
    // comment on this column (see the original schema migration) — this is
    // a real confirmed lease start date (leases.lease_start, via the sync
    // script's currency cross-reference), consistent with only
    // leased-status comps ever setting this field (CRMLS's own leased
    // comps do the same with CloseDate).
    leased_date: toDateOnly(row.lease_start_date),
    listed_date: null,
  };
}

/**
 * Turns the leases already chosen for this analysis into comps, working out the real
 * type of each. This is the ONE place that does it: the live pull (pullLeadSimpleComps()
 * below) and the accuracy test's replay (backtest/asof-sources.js) both call it, so the test
 * cannot drift from the product. NEVER throws, and never fails the analysis: whatever the MLS
 * does, every lease still becomes a comp, at worst with its LeadSimple type.
 *
 * Only leases that could change an answer are looked up: a positive rent that is not a data
 * error (those never count), a bedroom count within reach of the subject's (2 or more off never
 * counts), and only when the subject's own type is known (with no subject type, no comp's type
 * can leave it out).
 *
 * @param {{row: object, distanceMiles: number|null}[]} selected - the leases, already chosen by zip, lookback and distance
 * @param {{propertyType?: string, bedrooms?: number}} subject
 * @param {object} [options]
 * @param {Function|null} [options.lookup] - (queries) => {byKey, ...}; default is the live MLS lookup. null: no lookup at all (every type from the label)
 * @param {Function|null} [options.log] - where the one plain summary line goes (default console.log; null for none)
 * @returns {Promise<{comps: object[], stats: object, partialFailure: object[]|null}>}
 */
async function buildLeadSimpleComps(selected, subject, options = {}) {
  const lookup = options.lookup === undefined ? lookupMlsRecords : options.lookup;
  const log = options.log === undefined ? (msg => console.log(msg)) : options.log;
  const subjectType = subject && typeof subject.propertyType === 'string' && subject.propertyType ? subject.propertyType : null;
  const subjectBedrooms = subject && typeof subject.bedrooms === 'number' ? subject.bedrooms : null;

  const needsCheck = ({ row }) => {
    const rent = positiveRentOrNull(row.rent);
    if (rent === null) return false;
    if (rentLooksImplausible(rent, typeof row.sqft === 'number' ? row.sqft : null)) return false;
    if (subjectBedrooms !== null && typeof row.bedrooms === 'number' && Math.abs(row.bedrooms - subjectBedrooms) >= BEDROOM_MISMATCH_THRESHOLD) return false;
    return true;
  };

  const stats = { considered: 0, looked: 0, answered: 0, noAnswer: 0, couldNotCheck: 0, noSearchableAddress: 0, requests: 0, cacheHits: 0, ceilingHit: false, problem: null };
  let evidence = null;
  const queryOf = new Map();   // row -> its query, for the leases that will be checked
  if (lookup && subjectType) {
    const queries = [];
    for (const item of selected) {
      if (!needsCheck(item)) continue;
      stats.considered++;
      const q = mlsQueryFor(item.row);
      if (!q) { stats.noSearchableAddress++; continue; }
      queryOf.set(item.row, q);
      queries.push(q);
    }
    if (queries.length) {
      try {
        evidence = await lookup(queries);
      } catch (_) {
        evidence = null;
        stats.problem = 'an unexpected error stopped the check';
      }
    }
    if (evidence) {
      stats.requests = evidence.requests || 0;
      stats.cacheHits = evidence.cacheHits || 0;
      stats.ceilingHit = !!evidence.ceilingHit;
      stats.problem = evidence.problem || stats.problem;
    }
  }

  const comps = [];
  for (const { row, distanceMiles } of selected) {
    const q = queryOf.get(row);
    let resolved = { type: labelType(row), source: 'label' };
    if (q) {
      stats.looked++;
      const records = evidence && evidence.byKey instanceof Map ? evidence.byKey.get(q.key) : undefined;
      if (!Array.isArray(records)) stats.couldNotCheck++;
      else {
        resolved = resolveLeaseType(row, records);
        if (resolved.source === 'label') stats.noAnswer++; else stats.answered++;
      }
    }
    const comp = mapComparable(row, distanceMiles, resolved.type, resolved.source);
    if (comp) comps.push(comp);
  }

  let partialFailure = null;
  if (stats.looked > 0) {
    if (stats.couldNotCheck > 0) {
      const why = stats.ceilingHit ? 'the limit for the check was reached' : (stats.problem || 'the MLS did not answer');
      partialFailure = [{
        what: TYPE_CHECK_WHAT,
        message: `${stats.couldNotCheck} of ${stats.looked} homes could not be checked (${why}); those keep the type LeadSimple gives them`,
      }];
    }
    if (log) {
      const bits = [`${stats.answered} answered`, `${stats.noAnswer} had no clear MLS record`];
      if (stats.couldNotCheck) bits.push(`${stats.couldNotCheck} could not be checked${stats.problem ? ` (${stats.problem})` : ''}`);
      log(`[rental-analysis] LeadSimple Move-Ins: looked up the real property type of ${stats.looked} Rincon lease${stats.looked === 1 ? '' : 's'} in the MLS: ${bits.join(', ')}. Any that were not answered keep the type LeadSimple gives them. ${stats.requests} MLS request(s), ${stats.cacheHits} answer(s) remembered from earlier${stats.ceilingHit ? '; the limit for the check was reached' : ''}.`);
    }
  }
  return { comps, stats, partialFailure };
}

/**
 * Pulls Rincon's own confirmed-current new-lease comps for one analysis,
 * from the synced leadsimple_new_leases table — zip-scoped at the query
 * level (unchanged: no DB-side radius query exists for this table, see the
 * migration) and lookback-windowed on `closed_at` (MOVE_IN_LOOKBACK_MONTHS
 * above). Same {comps: [...]} shape every other source returns, so
 * lib/sources.js's loop doesn't need to know which source it called.
 *
 * Self-sufficient, like lib/crmls.js's own zip fallback path:
 * parses the zip straight off the subject's typed address, so the QUERY
 * itself doesn't depend on RentCast running first. When the address has no zip
 * (one picked from the suggestion dropdown ends "..., CA, USA"), the zip the
 * geocoder found for the subject (subject.zip, handed on by lib/sources.js from
 * RentCast's answer) is used instead; with neither, this source is skipped as
 * before. Radius TIERING (see
 * below) does opt into lib/sources.js's enrichedSubject.latitude/longitude
 * when RentCast already geocoded the subject — same mechanism
 * lib/crmls.js's box search uses — but degrades to exactly the previous
 * zip-only behavior (no tiering, every fetched row kept, distance_miles
 * null) whenever those coordinates aren't available, never throws over it.
 *
 * The real type of each lease is then looked up in the MLS (buildLeadSimpleComps()). That
 * check can only ever add a "partly worked" warning; it cannot fail this pull.
 *
 * @param {{address: string, zip?: string, latitude?: number, longitude?: number, propertyType?: string, bedrooms?: number}} subject
 * @returns {Promise<{comps: object[], subjectEstimatedRent: null, subjectLatitude: null, subjectLongitude: null, subjectZip: string|null, partialFailure?: object[]}>}
 */
async function pullLeadSimpleComps(subject) {
  const zip = subjectZipFor(subject);
  if (!zip) {
    console.warn(`[rental-analysis] LeadSimple Move-Ins: could not find a 5-digit zip at the end of "${subject.address}" (or from the geocoder) — skipping (this source is zip-scoped only, no coordinate fallback).`);
    return { comps: [], subjectEstimatedRent: null, subjectLatitude: null, subjectLongitude: null, subjectZip: null, skipped: 'the address has no zip code' };
  }

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - MOVE_IN_LOOKBACK_MONTHS);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const query = `select=*&zip_code=eq.${encodeURIComponent(zip)}&closed_at=gte.${cutoffDate}`;
  const rows = await select('leadsimple_new_leases', query);

  // Distance/radius bound — same policy as lib/rentcast.js/lib/crmls.js (see
  // lib/constants.js), applied on top of the zip-scoped rows already
  // fetched above rather than a second query (no DB-side radius query
  // exists for this table). Only runs when the subject itself has real
  // coordinates (fed forward by lib/sources.js from RentCast, when active);
  // otherwise every row is mapped as-is, distance_miles null throughout —
  // exactly today's zip-only behavior, never a throw. The narrow/wide
  // decision itself no longer happens here — see applyCombinedRadiusTiering()
  // in lib/sources.js.
  const hasSubjectCoords = typeof subject.latitude === 'number' && typeof subject.longitude === 'number';
  let selected;
  if (hasSubjectCoords) {
    const withDistance = (rows || []).map(row => {
      const hasRowCoords = typeof row.latitude === 'number' && typeof row.longitude === 'number';
      const distanceMiles = hasRowCoords
        ? haversineMiles(subject.latitude, subject.longitude, row.latitude, row.longitude)
        : null;
      return { row, distanceMiles };
    });
    // A row beyond WIDE_SEARCH_RADIUS_MILES is dropped, same as CRMLS's own
    // box-corner post-filter — a zip code can span well past 2 miles, so
    // this is the one place that bound gets enforced for this source. A row
    // with no distance (not yet geocoded/backfilled) is kept as-is, same
    // "no basis to compute or drop it" rule lib/crmls.js uses.
    selected = withDistance.filter(({ distanceMiles }) => distanceMiles === null || distanceMiles <= WIDE_SEARCH_RADIUS_MILES);
  } else {
    selected = (rows || []).map(row => ({ row, distanceMiles: null }));
  }

  const built = await buildLeadSimpleComps(selected, subject);

  return {
    comps: built.comps,
    // This source does no AVM-style estimate and doesn't geocode the
    // subject — same reasoning as lib/crmls.js's own nulls here.
    subjectEstimatedRent: null,
    subjectLatitude: null,
    subjectLongitude: null,
    subjectZip: zip,
    ...(built.partialFailure ? { partialFailure: built.partialFailure } : {}),
  };
}

module.exports = {
  pullLeadSimpleComps,
  buildLeadSimpleComps,
  mapComparable,
  positiveRentOrNull,
  buildAddress,
  toDateOnly,
  FROM_LEADSIMPLE_PROPERTY_TYPE,
  MULTI_FAMILY_TYPE,
  MOVE_IN_LOOKBACK_MONTHS,
  MLS_TYPE_LOOKUP_LIMITS,
  MLS_TYPE_SELECT,
  TYPE_CHECK_WHAT,
  MAX_STREET_WORD_LENGTH,
  labelType,
  isMultiFamilyLabel,
  rentOutsideRange,
  rentPerSqftOutsideRange,
  rentLooksImplausible,
  mlsQueryFor,
  buildMlsLookupFilter,
  slimMlsRecord,
  recordAnswersQuery,
  recordsAtAddress,
  classifyRinconLease,
  resolveLeaseType,
  lookupMlsRecords,
  clearMlsTypeCache,
};
