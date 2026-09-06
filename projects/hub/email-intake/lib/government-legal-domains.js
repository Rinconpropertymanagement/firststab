/**
 * lib/government-legal-domains.js
 * Layer 1 of the privilege/legal-hold filter (see privilege-filter.js).
 *
 * A maintained, Mason-reviewable list of domain patterns for government
 * agencies (code enforcement, building & safety, health department, court
 * e-filing vendors) and common law-firm domain conventions — a code asset,
 * not a database table, same reasoning as maintenance-history's
 * protected-class-terms.js (Mason can edit this file directly, no schema
 * change needed).
 *
 * Two-tier split per Mason's final review — this module was already
 * structured to distinguish the two, privilege-filter.js just now reads
 * that distinction differently:
 *   - Government domains (isGovernmentDomain)  -> Tier 1, TAG only. Ordinary
 *     regulatory-agency correspondence (code enforcement, building &
 *     safety, health department, court e-filing vendors).
 *   - Law-firm domains (isLawFirmDomain)        -> Tier 2, HOLD. Direct
 *     signal of legal exposure — unchanged from the original build.
 * classifyDomain()'s `type` field ('government' | 'law_firm') is what
 * privilege-filter.js maps to Tier 1 / Tier 2.
 *
 * DESIGN CALL, same bias as protected-class-terms.js: broad/recall-oriented,
 * not precision-tuned. A false positive here costs one extra human look at
 * a thread that was already headed for review (nothing here auto-sends or
 * auto-deletes anything). A false negative — an actual code-enforcement or
 * law-firm thread that slips through unheld/untagged — is the failure mode
 * this exists to prevent. When in doubt, this list errs toward flagging.
 */

// Hostname substrings for known government-agency functions that don't
// necessarily sit on a literal .gov domain (many cities/counties run
// code-enforcement or health-department portals on .org/.us/vendor domains)
// and for known third-party court e-filing vendors.
const GOV_HOSTNAME_KEYWORDS = [
  'codeenforcement', 'code-enforcement', 'codecompliance', 'code-compliance',
  'buildingandsafety', 'building-and-safety', 'buildingsafety', 'building-safety',
  'healthdepartment', 'health-department', 'publichealth', 'public-health',
  'courts', 'courtfiling', 'court-filing',
  // known court e-filing vendors used across CA counties
  'efiling', 'onelegal', 'filetime', 'greenfiling', 'myfilerunner',
];

// Whole-label or label-suffix tokens that indicate a law-firm domain, e.g.
// "smithlaw.com" (label ends with "law"), "smith-law-llp.com" (hyphenated
// token "law"/"llp"), "doejohnsonattorneys.com" (label ends with
// "attorneys"). Suffix matching (not plain substring) is deliberate — it
// catches "smithlaw" without also matching unrelated words like "lawrence"
// or "lawson", which don't end in "law".
const LEGAL_SUFFIXES = [
  'law', 'legal', 'llp', 'esq', 'attorneys', 'attorney', 'lawyers', 'lawyer', 'lawfirm',
];

function extractDomain(address) {
  if (!address) return null;
  const match = String(address).match(/@([a-z0-9.-]+)/i);
  return match ? match[1].toLowerCase().replace(/[>\s]+$/, '') : null;
}

function isGovernmentDomain(hostname) {
  if (!hostname) return false;
  const labels = hostname.split('.');
  if (labels.includes('gov')) return true;
  return GOV_HOSTNAME_KEYWORDS.some((kw) => hostname.includes(kw));
}

function isLawFirmDomain(hostname) {
  if (!hostname) return false;
  // Drop the final label (TLD, e.g. "com"/"org") — check every remaining
  // label as a whole, plus its hyphen/underscore-separated tokens.
  const labels = hostname.split('.').slice(0, -1);
  for (const label of labels) {
    if (LEGAL_SUFFIXES.some((suf) => label === suf || label.endsWith(suf))) return true;
    const tokens = label.split(/[-_]/);
    if (tokens.some((tok) => LEGAL_SUFFIXES.includes(tok))) return true;
  }
  return false;
}

/**
 * Classifies a single email address's domain.
 * @returns {{ type: 'government'|'law_firm', domain: string } | null}
 */
function classifyDomain(address) {
  const hostname = extractDomain(address);
  if (!hostname) return null;
  if (isGovernmentDomain(hostname)) return { type: 'government', domain: hostname };
  if (isLawFirmDomain(hostname)) return { type: 'law_firm', domain: hostname };
  return null;
}

module.exports = {
  classifyDomain,
  extractDomain,
  isGovernmentDomain,
  isLawFirmDomain,
  GOV_HOSTNAME_KEYWORDS,
  LEGAL_SUFFIXES,
};
