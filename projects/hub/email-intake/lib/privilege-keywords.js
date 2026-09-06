/**
 * lib/privilege-keywords.js
 * Layer 2 of the privilege/legal-hold filter (see privilege-filter.js).
 *
 * Two-tier trigger-term lists per Peter's final boundary (supersedes the
 * prior split — moves the bare self-reported terms "litigation", "lawsuit",
 * and "small claims" from Tier 2 down to Tier 1; see privilege-filter.js
 * history / build notes for why):
 *
 *   TAG_TERMS  — Tier 1: routine regulatory/code-compliance language, PLUS
 *                bare mentions of litigation/lawsuit/small claims with no
 *                corroborating signal (no attorney, no subpoena, no
 *                law-firm domain). Tags the thread for visibility but does
 *                NOT hold it.
 *   HOLD_TERMS — Tier 2: direct signals of active legal representation or a
 *                formal complaint (attorneys, subpoenas, demand letters,
 *                formal fair-housing/HUD/CRD complaints). Holds the thread,
 *                same as the original build.
 *
 * Scanned against the SUBJECT and full BODY of every message in a thread
 * (see privilege-filter.js — this module only scans one string at a time;
 * the caller is responsible for checking every message, not just the
 * first).
 */

const TERMS_VERSION = 'privilege-keywords-v3';

// Tier 1 — TAG. Routine code-enforcement / regulatory-agency correspondence,
// plus bare litigation/lawsuit/small-claims mentions with no other signal.
// Common in ordinary property management and not, on its own, a sign of
// legal exposure — so it's surfaced for visibility, not held.
const TAG_TERMS = [
  'citation',
  'code compliance',
  'code enforcement',
  'violation notice',
  'case no.',
  'case #',
  'notice to comply',
  'administrative penalty',
  'litigation',
  'lawsuit',
  'small claims',
];

// Tier 2 — HOLD. Direct signals of legal exposure — attorneys, subpoenas,
// demand letters, formal fair-housing complaints.
const HOLD_TERMS = [
  'attorney',
  'counsel',
  'subpoena',
  'demand letter',
  'fair housing complaint',
  'hud complaint',
  'crd complaint',
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Terms made only of letters/digits/spaces get a \b-bounded regex (so
// "attorney" doesn't match inside "attorneys@..." headers by accident —
// it still matches the plain word). Terms with punctuation ("case no.",
// "case #") fall back to a plain case-insensitive substring match, since
// \b doesn't behave predictably around punctuation and these phrases are
// distinctive enough that substring matching is precise in practice.
function compile(terms) {
  return terms.map((term) => {
    const wordCharsOnly = /^[a-z0-9 ]+$/i.test(term);
    return {
      term,
      regex: wordCharsOnly
        ? new RegExp(`\\b${escapeRegex(term)}\\b`, 'i')
        : new RegExp(escapeRegex(term), 'i'),
    };
  });
}

const COMPILED_TAG_TERMS = compile(TAG_TERMS);
const COMPILED_HOLD_TERMS = compile(HOLD_TERMS);

function scan(text, compiled) {
  const normalized = String(text || '');
  const matchedTerms = [];
  for (const { term, regex } of compiled) {
    if (regex.test(normalized)) matchedTerms.push(term);
  }
  return { matched: matchedTerms.length > 0, matchedTerms };
}

/**
 * Scans a single piece of text (e.g. one message's "subject\n\nbody") for
 * Tier 1 (tag-only) trigger terms.
 * @returns {{ matched: boolean, matchedTerms: string[] }}
 */
function scanForTagKeywords(text) {
  return scan(text, COMPILED_TAG_TERMS);
}

/**
 * Scans a single piece of text for Tier 2 (hold) trigger terms.
 * @returns {{ matched: boolean, matchedTerms: string[] }}
 */
function scanForHoldKeywords(text) {
  return scan(text, COMPILED_HOLD_TERMS);
}

module.exports = {
  scanForTagKeywords,
  scanForHoldKeywords,
  TAG_TERMS,
  HOLD_TERMS,
  TERMS_VERSION,
};
