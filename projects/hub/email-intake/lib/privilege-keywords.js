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
 *
 * v4 (archive-search-technical-spec.md, "Resolving Finding 4"): two fixes,
 * both scoped entirely inside this file — privilege-filter.js needs NO
 * changes for either.
 *   1. 'lawyer' added to HOLD_TERMS, alongside the existing 'attorney'.
 *   2. A new co-occurrence check (HOLD_COOCCURRENCE_PAIRS, below) closes
 *      the word-order gap in the three Fair Housing complaint phrases
 *      ('fair housing complaint', 'hud complaint', 'crd complaint') — see
 *      that constant's own comment for why a flat phrase list can't fix
 *      this in general.
 *
 * v5 (TARS/Judge bug fix, 2026-09-10): the v4 co-occurrence complaint-word
 * regex was built on the noun stem "complaint" with suffixes (s|ed|ing),
 * which only ever produces "complaint"/"complaints" plus the non-words
 * "complainted"/"complainting" — it never matched the actual verb forms
 * people use in real correspondence ("complain," "complains,"
 * "complained," "complaining"). Real sentence that was missed: "She
 * complained to the Civil Rights Department about how she was treated."
 * Fixed by building the regex on the verb stem "complain" instead, with
 * both verb and noun suffixes.
 */

const TERMS_VERSION = 'privilege-keywords-v5';

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
  'lawyer',
  'counsel',
  'subpoena',
  'demand letter',
  'fair housing complaint',
  'hud complaint',
  'crd complaint',
];

// Co-occurrence check — a new match type, independent of the flat term
// list above, added for v4 (archive-search-technical-spec.md, "Resolving
// Finding 4"). Today 'fair housing complaint', 'hud complaint', and 'crd
// complaint' are exact-phrase matches only — "a complaint about fair
// housing" or "filed a complaint with HUD" matches none of them, and no
// amount of adding more literal phrases closes that gap in general (word
// order has too many real permutations to enumerate). Fires HOLD when a
// regulator/subject-matter token and a complaint-word both appear
// ANYWHERE in the same text, regardless of order or distance — two
// independent regex tests, ANDed, not one .*-spanning regex (which would
// risk catastrophic backtracking over a full message body).
const HOLD_COOCCURRENCE_PAIRS = [
  {
    id: 'fair_housing_complaint_cooccurrence',
    a: /\b(fair housing|housing discrimination|hud|department of housing and urban development|crd|civil rights department|dfeh)\b/i,
    b: /\bcomplain(?:s|ed|ing|t|ts)?\b/i,
  },
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
 * Scans a single piece of text for Tier 2 (hold) trigger terms — the flat
 * HOLD_TERMS list PLUS the HOLD_COOCCURRENCE_PAIRS check above. A
 * co-occurrence hit adds a synthetic entry (its `id`, e.g.
 * 'fair_housing_complaint_cooccurrence') to matchedTerms alongside any
 * literal-phrase matches, so callers (and audit_log) can tell which
 * mechanism fired. checkThread()/checkMessage() in privilege-filter.js
 * need NO changes — they only ever call scanForHoldKeywords(text) and read
 * .matched/.matchedTerms, both still present in the same shape.
 * @returns {{ matched: boolean, matchedTerms: string[] }}
 */
function scanForHoldKeywords(text) {
  const normalized = String(text || '');
  const base = scan(normalized, COMPILED_HOLD_TERMS);
  const matchedTerms = [...base.matchedTerms];
  for (const pair of HOLD_COOCCURRENCE_PAIRS) {
    if (pair.a.test(normalized) && pair.b.test(normalized)) {
      matchedTerms.push(pair.id);
    }
  }
  return { matched: matchedTerms.length > 0, matchedTerms };
}

module.exports = {
  scanForTagKeywords,
  scanForHoldKeywords,
  TAG_TERMS,
  HOLD_TERMS,
  HOLD_COOCCURRENCE_PAIRS,
  TERMS_VERSION,
};
