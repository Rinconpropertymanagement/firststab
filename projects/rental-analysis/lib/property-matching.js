/**
 * lib/property-matching.js
 * Best-effort address matching against the `properties` table — used to set
 * rental_analyses.property_id (subject) and rental_comps.comp_property_id /
 * is_rincon_managed (each comp).
 *
 * Ported from projects/insurance-compliance/server.js's normalizeAddress /
 * addressWordScore / findBestPropertyMatch (same 0.6 word-overlap
 * threshold) — per spec, this is meant to be simple exact-ish matching,
 * not a fuzzy-matching system, so reusing the existing proven approach
 * rather than inventing a new one.
 *
 * Fixed 2026-08-13 (TARS found both in live testing):
 *   1. The original word-overlap score treated the house number as just one
 *      word among several ("2194 channel dr" vs "2006 channel dr" scored
 *      0.67 — 2 of 3 words still matched — well above the 0.6 threshold),
 *      so two different buildings on the same street would match. The house
 *      number is now a required gate, checked before the word score even
 *      runs: different house numbers = no match, full stop.
 *   2. normalizeAddress used to split on comma OR hyphen to strip a
 *      trailing ", city, state zip" — but that also chopped a hyphenated
 *      house-number range like "77-79 Raemere St" down to just "77",
 *      dropping the street name entirely. It now splits on comma only, so
 *      "77-79" survives intact as the house-number token.
 *
 * Fixed 2026-08-13, round 2 (Judge found live against the real `properties`
 * table): the house-number gate above stops two different *buildings* on
 * the same street from matching, but not two different *units* in the same
 * building. Rincon's real "130 N Garden St" has five rows — two plain, one
 * "#3144," one "Unit 1411" (and one with a trailing period) — and a comp for
 * "130 N Garden St Unit 1207" (a unit that doesn't exist in the table)
 * matched the real "Unit 1411" row anyway, because the word-overlap score
 * only ever saw "130 n garden st unit 1207" vs "130 n garden st unit 1411"
 * — 5 of 6 words still match, well above 0.6. unitIdentifier() below adds a
 * second required gate, one level down from houseNumber(): whenever EITHER
 * side has a parseable unit/apt/suite/# identifier, it must match too — a
 * unit number on one side with nothing to compare on the other still counts
 * as a mismatch, so a comp for "Unit 1207" can't fall back to matching a
 * unit-less "130 N Garden St" row just because that row has no unit to
 * disagree with.
 */

const { weightFor, SELF_SOURCED_TRUSTED_SOURCE_NAMES, exclusionReason } = require('./weighting');

function normalizeAddress(addr) {
  if (!addr) return '';
  return addr.split(',')[0]
    .toLowerCase()
    .replace(/[.#]/g, '')
    .replace(/\bstreet\b/g,    'st')
    .replace(/\bavenue\b/g,    'ave')
    .replace(/\bboulevard\b/g, 'blvd')
    .replace(/\bdrive\b/g,     'dr')
    .replace(/\broad\b/g,      'rd')
    .replace(/\blane\b/g,      'ln')
    .replace(/\bcourt\b/g,     'ct')
    .replace(/\bplace\b/g,     'pl')
    .replace(/\bcircle\b/g,    'cir')
    .replace(/\bhighway\b/g,   'hwy')
    .replace(/\bnorth\b/g,     'n')
    .replace(/\bsouth\b/g,     's')
    .replace(/\beast\b/g,      'e')
    .replace(/\bwest\b/g,      'w')
    .replace(/\s+/g,           ' ')
    .trim();
}

// The leading house-number token of a normalized address — e.g. "2194" from
// "2194 channel dr", or "77-79" from "77-79 raemere st" (hyphenated ranges
// survive normalizeAddress intact now that it only splits on comma). Used
// as a required match gate, not just another word in the overlap score.
function houseNumber(normalized) {
  if (!normalized) return null;
  const m = normalized.match(/^([a-z0-9-]+)/);
  return m ? m[1] : null;
}

// The leading token of an address only has to look like a real house
// number to be trusted as one — a street name ("maple st") is also a
// leading alphanumeric token, but has no digit in it. Used by the
// incomplete-address check in server.js, kept here alongside houseNumber()
// since it's the same underlying parse.
function hasParseableHouseNumber(address) {
  const hn = houseNumber(normalizeAddress(address));
  return !!(hn && /\d/.test(hn));
}

// A unit/apartment/suite/# identifier anywhere in the address — e.g. "1411"
// from "130 N Garden St Unit 1411" or "3144" from either "130 N Garden St
// #3144" or RentCast's own "130 N Garden St, Unit 3144, Ventura, CA 93001"
// (confirmed live: RentCast puts the unit in its OWN comma segment, after
// the street and before the city — a real comp came back shaped exactly
// like that during testing this fix). Deliberately scans the raw, full
// address rather than normalizeAddress's comma-truncated, "#"-stripped
// output: restricting to the pre-comma segment (like houseNumber() does)
// would silently drop a same-comma-segment "#" unit AND any unit that
// RentCast placed in its own segment — caught live when a real 130 N
// Garden St #3144 comp matched the wrong (unit-less) property row because
// this function returned null for it instead of "3144". Returns null when
// no such identifier is present anywhere — most addresses are single-unit
// and have none, same as houseNumber() returning null for an address with
// no leading number.
function unitIdentifier(address) {
  if (!address) return null;
  const m = address.match(/(?:#|\bunit\b|\bapt\b|\bapartment\b|\bste\b|\bsuite\b)\.?\s*#?\s*([a-z0-9-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function addressWordScore(normA, normB) {
  const wa = normA.split(' ').filter(w => w.length > 1);
  const wb = new Set(normB.split(' ').filter(w => w.length > 1));
  if (!wa.length || !wb.size) return 0;
  return wa.filter(w => wb.has(w)).length / Math.max(wa.length, wb.size);
}

// Same matching rules as findBestPropertyMatch() below (house-number gate,
// unit gate, 0.6 word-overlap threshold), but for comparing two free-text
// addresses directly rather than a target against a list of property rows —
// used by dedupeComps() below to recognize the same real unit reported by
// two different comp sources with slightly different address formatting
// (e.g. "1696 Salt River Ave" vs "1696 Salt River Avenue").
function addressesMatch(addressA, addressB) {
  if (!addressA || !addressB) return false;
  const normA = normalizeAddress(addressA);
  const normB = normalizeAddress(addressB);
  if (!normA || !normB) return false;
  const houseA = houseNumber(normA);
  const houseB = houseNumber(normB);
  if (houseA && houseB && houseA !== houseB) return false;
  const unitA = unitIdentifier(addressA);
  const unitB = unitIdentifier(addressB);
  if ((unitA || unitB) && unitA !== unitB) return false;
  return addressWordScore(normA, normB) >= 0.6;
}

// `properties` stores address/city/state/zip as separate columns (unlike
// subject_address/rental_comps.address, which are single free-text fields —
// see the migration's design notes on why). Compose one comparable string.
function fullAddress(property) {
  return [property.address, property.city, property.state, property.zip].filter(Boolean).join(', ');
}

/**
 * @param {string} targetAddress - free-text address to match (subject_address or a comp's address)
 * @param {object[]} properties - rows with at least {id, address, city, state, zip}
 * @returns {object|null} the best-matching property row, or null if nothing scores >= 0.6
 */
function findBestPropertyMatch(targetAddress, properties) {
  if (!targetAddress || !properties || !properties.length) return null;
  const normTarget = normalizeAddress(targetAddress);
  if (!normTarget) return null;
  const targetHouseNumber = houseNumber(normTarget);
  const targetUnit = unitIdentifier(targetAddress);
  let best = null, bestScore = 0;
  for (const prop of properties) {
    const propFullAddress = fullAddress(prop);
    const normProp = normalizeAddress(propFullAddress);
    // Required gate: two addresses on the same street with different house
    // numbers must never match, no matter how well the rest of the words
    // overlap. Only skipped when one side has no parseable house number.
    const propHouseNumber = houseNumber(normProp);
    if (targetHouseNumber && propHouseNumber && targetHouseNumber !== propHouseNumber) {
      continue;
    }
    // Second required gate, one level down: two different units in the
    // SAME building must never match each other either. Unlike the house-
    // number gate above, this one fires when EITHER side has a parseable
    // unit/apt/suite/# identifier, not only when both do — a comp for
    // "Unit 1207" must not fall back to matching a unit-less "130 N Garden
    // St" row just because that row has nothing to disagree with. Only
    // skipped when NEITHER side has a unit identifier at all.
    const propUnit = unitIdentifier(propFullAddress);
    if ((targetUnit || propUnit) && targetUnit !== propUnit) {
      continue;
    }
    const score = addressWordScore(normTarget, normProp);
    if (score > bestScore && score >= 0.6) { bestScore = score; best = prop; }
  }
  return best;
}

// Collapses comps that describe the same real rental unit but arrived as
// separate rows — either from two different sources (RentCast inferring
// 'off_market' on a unit CRMLS separately confirms as 'leased') or from one
// source reporting the same address twice (CRMLS returning both an older
// 'Active' record and a newer 'Closed' one for the same unit). Either way,
// it's one real data point, not two, and counting it twice skews the range
// math. Walks the list once; for each comp, checks it against every comp
// already kept via addressesMatch() on .address. No match -> keep it. Match
// found -> keep whichever of the two is more trustworthy:
//   0. (Only when subjectBedrooms/subjectPropertyType are passed — see
//      below) Prefer whichever candidate would NOT be excluded from the
//      range math (exclusionReason(), lib/weighting.js) over one that
//      would be. This has to be checked BEFORE the status-weight rule in
//      step 1, not after or instead of it: two sources can genuinely
//      disagree about the same real unit's property type or bedroom count
//      (confirmed real case, 2026-09-20 — a duplex subject where sources
//      disagreed on type), and status weight has no way to know that one
//      candidate would survive exclusionReason() downstream and the other
//      wouldn't. Left unguarded, the OLD status-weight-only rule could
//      keep a higher-weight 'leased' row that then gets fully zero-weighted
//      by exclusionReason() (wrong type/size), silently discarding a
//      lower-weight 'active' row that would have actually counted toward
//      the range — with no trace, unlike a normal exclusion which at least
//      stays visible. A comp worth zero weight is worse to keep than one
//      worth ANY weight, regardless of listing_status. This step is a
//      no-op (falls through to step 1 unchanged) whenever the two
//      candidates AGREE on excluded status (both excluded, or neither) —
//      it only ever overrides the outcome when they disagree.
//   1. Higher listing_status weight (weightFor(), lib/weighting.js) wins —
//      reusing the real weighting so this can't drift out of sync with it.
//   2. Tie -> prefer a comp from a trusted, self-sourced source (e.g.
//      LeadSimple Move-Ins — see SELF_SOURCED_TRUSTED_SOURCE_NAMES,
//      lib/weighting.js) over one that isn't. Added for the LeadSimple
//      Move-Ins build: a Rincon-managed unit could in principle be
//      independently listed on CRMLS around the same time (a
//      broker-assisted listing) at the same 'leased' weight — without this
//      rule, dedupeComps() could keep the CRMLS copy on a coin-flip
//      first-seen tie, and that kept copy would then get excluded by
//      excludeRinconManaged() (it's Rincon-managed but not from a trusted
//      source), silently losing a comp that should have counted. See
//      LEADSIMPLE-COMP-SOURCE-SPEC.md, "What Could Go Wrong."
//   3. Still tied (both or neither trusted) -> prefer a real (non-null)
//      distance_miles over a missing one.
//   4. Still tied -> keep whichever was already kept (first-seen wins).
// The loser is dropped entirely — not inserted, not returned, not shown.
//
// @param {object[]} comps
// @param {number} [subjectBedrooms] - optional; see sizeSimilarityMultiplier
//   (lib/weighting.js). Omitted (together with subjectPropertyType below),
//   step 0 above is skipped entirely and dedupeComps() behaves EXACTLY as
//   it did before this parameter existed — same pattern computeRawRange()/
//   sizeSimilarityMultiplier()/propertyTypeMultiplier() already use, so
//   every existing caller that doesn't pass these is unaffected. Gating on
//   "was real subject context passed at all" (rather than letting
//   exclusionReason()'s own Rincon-managed check run unconditionally) is
//   deliberate: isExcludedRinconManaged() alone doesn't actually depend on
//   subjectBedrooms/subjectPropertyType, but step 0 only ever activates
//   when the caller opts in with real subject context, so a caller that
//   omits both parameters gets provably identical behavior, not just
//   "usually" identical behavior.
// @param {string} [subjectPropertyType] - optional; see propertyTypeMultiplier
function dedupeComps(comps, subjectBedrooms, subjectPropertyType) {
  const checkExclusion = typeof subjectBedrooms === 'number' || typeof subjectPropertyType === 'string';
  const kept = [];
  for (const comp of (comps || [])) {
    const matchIndex = kept.findIndex(k => addressesMatch(k.address, comp.address));
    if (matchIndex === -1) {
      kept.push(comp);
      continue;
    }
    const existing = kept[matchIndex];

    if (checkExclusion) {
      const existingExcluded = !!exclusionReason(existing, subjectBedrooms, subjectPropertyType);
      const compExcluded = !!exclusionReason(comp, subjectBedrooms, subjectPropertyType);
      if (existingExcluded !== compExcluded) {
        // Exactly one of the two would count toward the range -> keep that
        // one, full stop. Skips the status-weight/trusted-source/distance/
        // first-seen tie-break below entirely, since none of those matter
        // if the alternative contributes zero weight anyway.
        if (existingExcluded) kept[matchIndex] = comp;
        continue;
      }
      // else: both excluded, or neither -> no signal here, fall through.
    }

    const existingWeight = weightFor(existing.listing_status);
    const compWeight = weightFor(comp.listing_status);
    if (compWeight > existingWeight) {
      kept[matchIndex] = comp;
    } else if (compWeight === existingWeight) {
      const existingTrusted = SELF_SOURCED_TRUSTED_SOURCE_NAMES.has(existing.source_name);
      const compTrusted = SELF_SOURCED_TRUSTED_SOURCE_NAMES.has(comp.source_name);
      if (compTrusted && !existingTrusted) {
        kept[matchIndex] = comp;
      } else if (existingTrusted === compTrusted) {
        const existingHasDistance = existing.distance_miles !== null && existing.distance_miles !== undefined;
        const compHasDistance = comp.distance_miles !== null && comp.distance_miles !== undefined;
        if (!existingHasDistance && compHasDistance) kept[matchIndex] = comp;
        // else: still tied -> first-seen wins, keep existing.
      }
      // else: existing is the trusted one -> keep existing.
    }
    // else: existing has the stronger (or equal, non-improved) signal -> keep existing.
  }
  return kept;
}

module.exports = {
  normalizeAddress,
  addressWordScore,
  addressesMatch,
  findBestPropertyMatch,
  dedupeComps,
  fullAddress,
  houseNumber,
  hasParseableHouseNumber,
  unitIdentifier,
};
