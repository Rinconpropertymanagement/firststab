/**
 * backtest/mls-facts-ref.js
 * Reference copy of the MLS-field rules from CMA-QUALITY-SPEC.md Item 2
 * (furnished, lease term, 55+). The product does not have these yet (they are
 * Phase B, lib/mls-facts.js); the accuracy test needs them now to (a) screen
 * out targets that are not like-for-like (spec protocol) and (b) measure what
 * the Item 2 exclusions would do. When Phase B ships, this file should be
 * replaced by imports from lib/mls-facts.js so the test uses the real rules.
 *
 * Unknown (null) is never a mismatch.
 */

// MLS `Furnished` -> furnished | unfurnished | partial | either | null
function normalizeFurnished(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'furnished') return 'furnished';
  if (v === 'unfurnished') return 'unfurnished';
  if (v === 'partially' || v === 'partially furnished') return 'partial';
  if (v === 'furnished or unfurnished' || v === 'negotiable') return 'either';
  return null;
}

// MLS `LeaseTerm` (a comma list such as "Month To Month,12 Months") ->
// long | short | six_month | null. Spec Item 2 rule 2, exactly:
//   any token starting "12" or "24"                 -> long
//   else a "vacation rental" / "seasonal" / "short term lease" token,
//        or a list that is only "month to month"    -> short
//   else a "6 months" token                         -> six_month
//   else (null, only "Negotiable", "Month To Month,Negotiable") -> null
function classifyLeaseTerm(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const tokens = value.toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
  if (!tokens.length) return null;
  if (tokens.some(t => t.startsWith('12') || t.startsWith('24'))) return 'long';
  if (tokens.some(t => t === 'vacation rental' || t === 'seasonal' || t === 'short term lease')) return 'short';
  if (tokens.every(t => t === 'month to month')) return 'short';
  if (tokens.some(t => t === '6 months')) return 'six_month';
  return null;
}

// Pulls the three facts the test uses off a raw Recore record.
function factsFromRecord(record) {
  return {
    furnished: normalizeFurnished(record.Furnished),
    leaseTerm: classifyLeaseTerm(record.LeaseTerm),
    ageRestricted: typeof record.SeniorCommunityYN === 'boolean' ? record.SeniorCommunityYN : null,
  };
}

// True when this record is a like-for-like lease for the protocol's target
// screen: not furnished, not month-to-month/short, not 6-month, not 55+.
function isLikeForLikeTarget(record) {
  const f = factsFromRecord(record);
  if (f.furnished === 'furnished') return false;
  if (f.leaseTerm === 'short' || f.leaseTerm === 'six_month') return false;
  if (f.ageRestricted === true) return false;
  return true;
}

module.exports = { normalizeFurnished, classifyLeaseTerm, factsFromRecord, isLikeForLikeTarget };
