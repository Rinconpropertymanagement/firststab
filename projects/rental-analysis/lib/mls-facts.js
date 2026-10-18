/**
 * lib/mls-facts.js
 * Turns the extra facts the MLS (CRMLS, through Recore) sends with each listing
 * into the small, safe values this tool stores and uses (CMA-QUALITY-SPEC.md
 * Item 2): furnished or not, how long the lease is, whether it is a 55+
 * community, the subdivision, the year built, the MLS's own condition word, and
 * a few display tags (pool, HOA, utilities included, new construction).
 *
 * Three rules hold everywhere in this file:
 *   1. A fact the MLS did not give us is "unknown" (null), and unknown NEVER
 *      leaves a comp out. Only a fact we are sure about can.
 *   2. Every value is forced into the exact list the database accepts
 *      (lib/constants.js). One bad value would make the database refuse the
 *      whole batch of comps and the whole analysis would fail.
 *   3. Listing text (PublicRemarks) is never read, kept or stored here.
 *
 * The tags (mls_flags) are for display only. They never change a rent number.
 * Only furnished_status, lease_term_class and age_restricted can leave a comp
 * out of the numbers, and that decision is made in lib/weighting.js.
 */

const {
  FURNISHED_STATUSES,
  LEASE_TERM_CLASSES,
  MLS_FLAGS,
  MAX_MLS_LISTING_ID_LENGTH,
  MAX_MLS_CONDITION_LENGTH,
  MAX_SUBDIVISION_LENGTH,
  MIN_YEAR_BUILT,
  MAX_YEAR_BUILT,
  NEW_CONSTRUCTION_YEARS,
} = require('./constants');
const { addressesMatch } = require('./property-matching');
const { stripControlChars } = require('./subject-inputs');
const { SELF_SOURCED_TRUSTED_SOURCE_NAMES, hasExclusionFacts } = require('./weighting');

// ─── Small cleaners ──────────────────────────────────────────────────────────

// Trimmed text no longer than maxLength, otherwise null. Text that is too long
// for its column is treated as unknown, never cut short and never guessed.
function textOrNull(value, maxLength) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text && text.length <= maxLength ? text : null;
}

// The MLS sends some lists as one comma-separated string (LeaseTerm: "12
// Months,24 Months") and some as a real list (RentIncludes: ["Gardener",
// "Water"]). Either way this returns lower-case, trimmed, non-empty words.
function listTokens(value) {
  const parts = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(',') : []);
  return parts
    .filter(part => typeof part === 'string')
    .map(part => part.trim().toLowerCase())
    .filter(Boolean);
}

function cleanListingId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return textOrNull(String(value), MAX_MLS_LISTING_ID_LENGTH);
  return textOrNull(value, MAX_MLS_LISTING_ID_LENGTH);
}

function cleanYearBuilt(value) {
  return Number.isInteger(value) && value >= MIN_YEAR_BUILT && value <= MAX_YEAR_BUILT ? value : null;
}

// PropertyCondition arrives as a list such as ["Turnkey","Updated/Remodeled"]
// (or an empty list). Kept as the MLS's own short words, joined with ", ".
function cleanMlsCondition(value) {
  const words = Array.isArray(value)
    ? value.filter(w => typeof w === 'string').map(w => w.replace(/\s+/g, ' ').trim()).filter(Boolean)
    : (typeof value === 'string' && value.trim() ? [value.replace(/\s+/g, ' ').trim()] : []);
  return words.length ? textOrNull(words.join(', '), MAX_MLS_CONDITION_LENGTH) : null;
}

// ─── Furnished, lease length, 55+ ────────────────────────────────────────────

// MLS "Furnished" -> furnished | unfurnished | partial | either | null.
// Real values seen: Unfurnished, Furnished, Partially, Furnished Or
// Unfurnished, Negotiable, and nothing at all.
function normalizeFurnished(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  let status = null;
  if (v === 'furnished') status = 'furnished';
  else if (v === 'unfurnished') status = 'unfurnished';
  else if (v === 'partially' || v === 'partially furnished') status = 'partial';
  else if (v === 'furnished or unfurnished' || v === 'negotiable') status = 'either';
  return FURNISHED_STATUSES.includes(status) ? status : null;
}

// MLS "LeaseTerm" (for example "Month To Month,12 Months") -> long | short |
// six_month | null. Spec Item 2, rule 2, exactly, on lower-cased words:
//   any word starting "12" or "24"                              -> long
//   otherwise "vacation rental", "seasonal" or "short term
//     lease", or a list made only of "month to month"           -> short
//   otherwise a "6 months" word                                 -> six_month
//   anything else (nothing, only "Negotiable", "Month To
//     Month,Negotiable")                                        -> unknown
// So "Month To Month,12 Months" is long: a lease offered for a year is a
// regular lease even if the owner would also take month-to-month.
function classifyLeaseTerm(value) {
  const words = listTokens(value);
  if (!words.length) return null;
  let cls = null;
  if (words.some(w => w.startsWith('12') || w.startsWith('24'))) cls = 'long';
  else if (words.some(w => w === 'vacation rental' || w === 'seasonal' || w === 'short term lease')) cls = 'short';
  else if (words.every(w => w === 'month to month')) cls = 'short';
  else if (words.some(w => w === '6 months')) cls = 'six_month';
  return LEASE_TERM_CLASSES.includes(cls) ? cls : null;
}

// MLS "SeniorCommunityYN" -> true | false | null (unknown is not the same as no).
function normalizeAgeRestricted(value) {
  return typeof value === 'boolean' ? value : null;
}

// ─── Subdivision (same neighborhood label) ───────────────────────────────────

// The MLS puts a tract code after the name ("Bird IIID - 144804", "Hueneme Bay
// 4 (148804)") and uses placeholder text when it has no real name ("Not
// Applicable", "Other (OTHR)", "Ventura: Other - 0027"). Returns the plain
// name, or null for a placeholder, an empty value, or a name too long to store.
// A real name that contains a colon ("Oxnard Shores: Driftwood 7 - 2477") is kept.
function cleanSubdivisionName(value) {
  if (typeof value !== 'string') return null;
  let name = value.replace(/\s+/g, ' ').trim();
  name = name.replace(/\s*-\s*\d+$/, '').replace(/\s*\(\d+\)$/, '').trim();
  if (!name || /^\d+$/.test(name)) return null;
  if (/^(not applicable|n\/?a|none|unknown)$/i.test(name)) return null;
  if (/^other\b/i.test(name) || /:\s*other$/i.test(name)) return null;
  return textOrNull(name, MAX_SUBDIVISION_LENGTH);
}

// True only when both homes have a real subdivision name and the names match
// (ignoring capital letters). The report's "same community" label uses this.
function sameSubdivision(subjectSubdivision, compSubdivision) {
  const a = cleanSubdivisionName(subjectSubdivision);
  const b = cleanSubdivisionName(compSubdivision);
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

// ─── Display tags ────────────────────────────────────────────────────────────

const HOUSE_LIKE_TYPES = ['single_family', 'townhouse'];

// Display tags, in a fixed order, already limited to the allowed list. `facts`
// are the cleaned facts above; `record` supplies the pool, HOA and
// "rent includes" fields. They never change a rent number.
function deriveMlsFlags(facts, record, propertyType, now = new Date()) {
  const rec = record || {};
  const includes = listTokens(rec.RentIncludes);
  const has = (...words) => includes.some(w => words.includes(w));
  const utilities = has('all utilities', 'electricity', 'electric', 'gas');
  const flags = [];
  if (facts.furnished_status === 'furnished') flags.push('furnished');
  if (facts.furnished_status === 'partial' || facts.furnished_status === 'either') flags.push('partly_furnished');
  if (facts.lease_term_class === 'short') flags.push('short_term');
  if (facts.age_restricted === true) flags.push('age_restricted');
  if (rec.AssociationYN === true || has('association dues')) flags.push('hoa');
  // PoolPrivateYN is "true" for most condos because it means the building's
  // shared pool, so a pool tag is only shown for houses and townhomes.
  if (rec.PoolPrivateYN === true && HOUSE_LIKE_TYPES.includes(propertyType)) flags.push('private_pool');
  if (utilities) flags.push('utilities_included');
  if (!utilities && has('water', 'sewer', 'trash collection', 'trash')) flags.push('water_trash_included');
  if (has('gardener')) flags.push('gardener_included');
  if (Number.isInteger(facts.year_built) && facts.year_built >= now.getFullYear() - NEW_CONSTRUCTION_YEARS) flags.push('new_construction');
  return flags.filter(flag => MLS_FLAGS.includes(flag));
}

// ─── One raw MLS record -> the new comp columns ──────────────────────────────

/**
 * @param {object} record - one raw Recore/CRMLS Property record
 * @param {{propertyType?: string|null, now?: Date}} [opts] - propertyType is OUR type for the comp (the pool tag depends on it); now is injectable for tests
 * @returns {{mls_listing_id, year_built, subdivision_name, furnished_status, lease_term_class, age_restricted, mls_condition, mls_flags}}
 */
function mlsFactsFromRecord(record, { propertyType = null, now = new Date() } = {}) {
  const rec = record || {};
  const facts = {
    mls_listing_id: cleanListingId(rec.ListingId),
    year_built: cleanYearBuilt(rec.YearBuilt),
    subdivision_name: cleanSubdivisionName(rec.SubdivisionName),
    furnished_status: normalizeFurnished(rec.Furnished),
    lease_term_class: classifyLeaseTerm(rec.LeaseTerm),
    age_restricted: normalizeAgeRestricted(rec.SeniorCommunityYN),
    mls_condition: cleanMlsCondition(rec.PropertyCondition),
  };
  return { ...facts, mls_flags: deriveMlsFlags(facts, rec, propertyType, now) };
}

// ─── Making the facts survive de-duplication ─────────────────────────────────

// Two rents "match" for merging when they are within 5% of each other.
function rentsClose(a, b) {
  const x = Number(a), y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) return false;
  return Math.abs(x - y) <= 0.05 * Math.max(x, y);
}

function findMlsTwin(comp, mlsComps) {
  if (comp.mls_listing_id) {
    const byId = mlsComps.find(m => m.mls_listing_id && m.mls_listing_id === comp.mls_listing_id);
    if (byId) return byId;
  }
  let best = null, bestGap = Infinity;
  for (const m of mlsComps) {
    if (!addressesMatch(comp.address, m.address) || !rentsClose(comp.monthly_rent, m.monthly_rent)) continue;
    const gap = Math.abs(Number(comp.monthly_rent) - Number(m.monthly_rent));
    if (gap < bestGap) { best = m; bestGap = gap; }
  }
  return best;
}

/**
 * RentCast runs first, and when it and CRMLS both report the same home the
 * RentCast copy can win the duplicate check, which would throw away the CRMLS
 * copy's furnished / lease length / 55+ facts (and a furnished comp could slip
 * through as "counted"). So before the radius search, every comp that has no
 * MLS facts of its own borrows them from the CRMLS comp that is the same
 * listing: matched on the MLS number first, otherwise on the same address with
 * a rent within 5%. Only the MLS facts are borrowed; the comp's own price,
 * bedrooms, size and status are never touched.
 *
 * Comps that already carry facts, CRMLS's own comps, and Rincon's own leases
 * (LeadSimple Move-Ins) are left exactly as they are.
 *
 * @param {object[]} comps - every comp the sources returned (each with source_name)
 * @returns {object[]} a list in the same order; changed comps are new objects, the rest are the same objects
 */
function mergeMlsFacts(comps) {
  const list = comps || [];
  const mlsComps = list.filter(c => c && c.source_name === 'CRMLS');
  if (!mlsComps.length) return list;
  return list.map(comp => {
    if (!comp || comp.source_name === 'CRMLS' || SELF_SOURCED_TRUSTED_SOURCE_NAMES.has(comp.source_name) || hasExclusionFacts(comp)) return comp;
    const twin = findMlsTwin(comp, mlsComps);
    if (!twin) return comp;
    const flags = [...new Set([...(Array.isArray(comp.mls_flags) ? comp.mls_flags : []), ...(Array.isArray(twin.mls_flags) ? twin.mls_flags : [])])];
    return {
      ...comp,
      mls_listing_id: comp.mls_listing_id || twin.mls_listing_id || null,
      year_built: comp.year_built ?? twin.year_built ?? null,
      subdivision_name: comp.subdivision_name || twin.subdivision_name || null,
      furnished_status: twin.furnished_status ?? null,
      lease_term_class: twin.lease_term_class ?? null,
      age_restricted: twin.age_restricted ?? null,
      mls_condition: comp.mls_condition || twin.mls_condition || null,
      mls_flags: flags.filter(flag => MLS_FLAGS.includes(flag)),
    };
  });
}

// ─── The new optional inputs on the "run analysis" request ───────────────────

/**
 * subject_age_restricted: "Subject is in a 55+ community". Optional; left out
 * means no. Otherwise it must be exactly true or false (a JSON boolean), the same
 * as Furnished: the text "false" is not quietly read as an answer. Returns
 * { value: boolean } or { error: string } (never null, because the database
 * column is NOT NULL).
 */
function parseAgeRestrictedInput(raw) {
  if (raw === undefined || raw === null) return { value: false };
  if (typeof raw === 'boolean') return { value: raw };
  return { error: 'subject_age_restricted must be true or false, or omitted.' };
}

/**
 * subject_subdivision: the subject's neighborhood name, when known. Optional.
 * Returns { value: string|null } (a placeholder such as "Not Applicable" or a
 * tract code is cleaned away, leaving null) or { error: string }.
 */
function parseSubdivisionInput(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  if (typeof raw !== 'string') return { error: 'subject_subdivision must be text, or omitted.' };
  // control characters (a zero byte, line breaks) are dropped before anything is measured or saved
  const typed = stripControlChars(raw);
  if (typed.trim().length > MAX_SUBDIVISION_LENGTH) return { error: `subject_subdivision must be ${MAX_SUBDIVISION_LENGTH} characters or fewer.` };
  return { value: cleanSubdivisionName(typed) };
}

module.exports = {
  textOrNull,
  listTokens,
  cleanListingId,
  cleanYearBuilt,
  cleanMlsCondition,
  normalizeFurnished,
  classifyLeaseTerm,
  normalizeAgeRestricted,
  cleanSubdivisionName,
  sameSubdivision,
  deriveMlsFlags,
  mlsFactsFromRecord,
  rentsClose,
  mergeMlsFacts,
  parseAgeRestrictedInput,
  parseSubdivisionInput,
};
