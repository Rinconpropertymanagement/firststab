/**
 * lib/fair-housing-wide-net-terms.js
 *
 * ============================================================================
 * AUTHORIZED TO WIRE IN — as of 2026-09-12. See
 * projects/hub/email-intake/archive-search-fair-housing-option-b-spec.md's
 * Status line and compliance/archive-search-option-b-governance-review.md
 * for the real, complete authorization record (real outside counsel opinion,
 * Asimov's and Mason's attributed verdicts, Peter's own recorded shadow-mode
 * decision, and the corresponding audit_log entry). This header previously
 * said "NOT WIRED IN... confirmation that does not exist yet" — that was
 * accurate when written and is now stale; it is corrected here rather than
 * left to contradict the spec, per a real, caught inconsistency during this
 * project's own review process (an agent correctly refused to wire this in
 * while this header and the spec disagreed with each other).
 * ============================================================================
 * This file implements the Option B "wide net" pre-filter design from
 * projects/hub/email-intake/archive-search-fair-housing-option-b-spec.md,
 * Section 1. It is a standalone, independently-testable module.
 *
 * Modeled directly on email-intake/lib/privilege-keywords.js's real,
 * live-in-production shape: a flat literal-phrase list (Shape A, this
 * spec's "phrases, not individual words") plus a HOLD_COOCCURRENCE_PAIRS-
 * style array (Shape B, "these two things need to both show up") — never a
 * bare single ordinary word matched on its own, with one deliberate, named
 * exception (discrimination_general, below) carried forward from
 * maintenance-history/lib/protected-class-terms.js's own precedent for
 * exactly that one word.
 *
 * Twelve Fair-Housing categories per the spec's Section 1.3, plus
 * genetic_information and discrimination_general carried forward from
 * protected-class-terms.js for consistency. 'too old'/'too young for' are
 * deliberately NOT included anywhere in this file — spec Section 1.4 item 1
 * excludes them by name, given the real, measured ~91% false-positive data
 * point (content-check.js's TIER_B_TERMS) those two exact phrases are
 * already responsible for elsewhere in this codebase. Age coverage here is
 * carried by the more specific phrases below instead.
 *
 * ---------------------------------------------------------------------------
 * TWO FIXES APPLIED HERE, PER ASIMOV'S AND MASON'S REVIEW OF THE SPEC'S
 * STARTER LIST (before this file existed in any form):
 * ---------------------------------------------------------------------------
 * FIX 1 — 'calfresh' (source_of_income) and 'deportation'
 * (immigration_citizenship) were the spec's own two bare single-word
 * entries sitting in its literal-phrase table, unlike discrimination_general
 * which the spec itself already named as a deliberate exception. Both are
 * converted here to real co-occurrence pairs — the same shape as every
 * other single-ordinary-word category in this file (race_color, religion,
 * sex_gender, etc.) — rather than left as bare words or silently dropped.
 * Neither is named as a bare-word exception, because a reasonable
 * co-occurrence form IS possible for both (unlike discrimination_general,
 * where the spec's own reasoning is that no ordinary-language collision
 * exists for the word at all). Peter has not been asked to sign off on
 * these two because they are not exceptions — they are phrase/co-occurrence
 * entries like every other non-exception entry in this file.
 *
 * FIX 2 — Mason's review: 'separated' in the marital_status co-occurrence
 * pair's `a` side is too common in ordinary property-management
 * correspondence with no marital connotation most of the time (separate
 * utility meters, items separated during a move-out). Removed from the `a`
 * regex. Mason's specific replacement — 'getting divorced', 'going through
 * a divorce', 'estranged spouse' — added in its place. (The pair's other
 * terms — divorced, divorce, widow, widower, spouse, domestic partner —
 * were not flagged by this review and are unchanged.)
 *
 * See the marital_status and source_of_income/immigration_citizenship
 * entries below for the exact before/after; the file's own module header
 * here states the fixes, the CATEGORIES entries below apply them.
 *
 * discrimination_general remains the one deliberate bare-word exception,
 * unchanged from the spec's own proposal — flagged there (spec Section 1.4
 * item 2, Open Item 1) for Peter's own explicit sign-off, which has not yet
 * been given. Nothing in this file assumes that sign-off; the category
 * exists, named as an exception, exactly as the spec proposed it.
 *
 * ---------------------------------------------------------------------------
 * v2 — GAP CLOSED: military_veteran_status added.
 * ---------------------------------------------------------------------------
 * Not one of the original twelve spec categories above — added afterward,
 * once found missing from this file, from protected-class-terms.js, AND
 * from the Ventura County compliance KB. Real outside-counsel opinion
 * (compliance/archive-search-fair-housing-outside-counsel-opinion.md,
 * Section 6, "Required Safeguards Checklist" #6) names "military/veteran
 * status" as one of the principal categories the first-stage screen should
 * reasonably cover, and flags it under "One Real Gap Found In The Actual
 * Build." GOVERNANCE.md's own Fair Housing Standard already names this
 * category too ("State & local — always add these... military/veteran
 * status"). See the military_veteran_status entry below for how its
 * phrase/cooccurrence split was decided.
 */

const TERMS_VERSION = 'fair-housing-wide-net-terms-v2';

// ---------------------------------------------------------------------------
// Shared companion patterns — spec Section 1.2. Same two-independent-
// regexes-ANDed shape as privilege-keywords.js's HOLD_COOCCURRENCE_PAIRS; no
// single regex spans both sides, for the same catastrophic-backtracking
// reason that file's own comment gives. Copied verbatim from the spec, not
// reworded.
// ---------------------------------------------------------------------------

// "Something adverse/differential happened" — the actual Fair-Housing-
// relevant scenario, as opposed to an identity word appearing incidentally.
const ADVERSE_TREATMENT_LANGUAGE = /\b(discriminat\w*|treated? (?:me|him|her|them|us)? ?differently|treated unfairly|wouldn'?t rent to|refused to rent|denied (?:my|his|her|their) application|turned (?:me|him|her|them|us)? ?down because|won'?t allow|declined (?:my|his|her|their) application|made (?:comments|fun) about|harass(?:ed|ment)|targeted (?:me|him|her|them|us)|uncomfortable because of|singled (?:me|him|her|them|us)? ?out)\b/i;

// "A need or request tied to a personal characteristic" — the Fair-
// Housing-relevant accommodation scenario, as opposed to a routine repair.
const ACCOMMODATION_OR_NEED_LANGUAGE = /\b(accommodat\w*|modif\w* the unit|needs? (?:a ramp|an interpreter|a translator|help with)|because of (?:my|his|her|their) (?:disability|condition)|due to (?:my|his|her|their) (?:disability|condition))\b/i;

// ---------------------------------------------------------------------------
// CATEGORIES — one entry per Fair-Housing topic. Each holds:
//   phrases      — Shape A: literal multi-word phrases, \b-bounded.
//   cooccurrence — Shape B: [{ id, a, b }] pairs, both regexes ANDed.
//   bareWordExceptions — ONLY discrimination_general has this. A deliberate,
//                        named departure, never silent.
// Structured by category (rather than one flat list, like
// protected-class-terms.js's own CATEGORIES) so Mason can review, extend,
// or challenge any one topic's coverage independently of the rest.
// ---------------------------------------------------------------------------
const CATEGORIES = {
  race_color: {
    phrases: [],
    cooccurrence: [
      {
        id: 'race_color_cooccurrence',
        a: /\b(race|racial|ethnicity|ethnic background|skin color|skin tone)\b/i,
        b: ADVERSE_TREATMENT_LANGUAGE,
      },
    ],
  },

  religion: {
    phrases: ['religious accommodation', 'religious discrimination', 'religious harassment', 'religious observance'],
    cooccurrence: [
      {
        id: 'religion_cooccurrence',
        a: /\b(religion|religious|christian|catholic|muslim|jewish|hindu|buddhist|sikh|church|mosque|synagogue|temple|hijab|yarmulke)\b/i,
        b: ADVERSE_TREATMENT_LANGUAGE,
      },
    ],
  },

  sex_gender: {
    phrases: ['sexual orientation', 'gender identity', 'gender expression', 'sexual harassment', 'pregnancy discrimination'],
    cooccurrence: [
      {
        id: 'sex_gender_cooccurrence',
        a: /\b(pregnant|pregnancy|gay|lesbian|bisexual|transgender|nonbinary|non-binary|lgbtq)\b/i,
        b: ADVERSE_TREATMENT_LANGUAGE,
      },
    ],
  },

  national_origin: {
    phrases: ['national origin', 'country of origin', 'accent discrimination'],
    cooccurrence: [
      {
        id: 'national_origin_cooccurrence',
        a: /\b(national origin|country of origin|accent|middle eastern|latino|latina|hispanic|indigenous|native american|pacific islander)\b/i,
        b: ADVERSE_TREATMENT_LANGUAGE,
      },
    ],
  },

  // Phrases only — the real vocabulary here is already multi-word and
  // directly on-topic even in mundane-sounding correspondence (occupancy-
  // limit discussions are a classic indirect familial-status issue).
  familial_status: {
    phrases: [
      'familial status', 'family status', 'no children allowed', 'kids not allowed',
      'adults only', 'no kids policy', 'child custody', 'foster child', 'pregnant tenant',
      'occupancy limit', 'household size', 'household composition', 'number of occupants',
    ],
    cooccurrence: [],
  },

  // Phrases (accommodation-shaped) + co-occurrence (everything else) — the
  // single most bare-word-prone category in the whole list; wheelchair,
  // blind, medication, diagnosis, therapy are all common in entirely
  // ordinary PM correspondence. Two cooccurrence pairs share the same `a`
  // side with different `b` companions — spec: "either companion should
  // fire the match."
  disability: {
    phrases: [
      'reasonable accommodation', 'reasonable modification', 'service animal',
      'emotional support animal', 'assistance animal', 'accessible unit',
      'wheelchair accessible', 'disability accommodation', 'accessibility needs',
    ],
    cooccurrence: [
      {
        id: 'disability_accommodation_cooccurrence',
        a: /\b(wheelchair|blind|deaf|hard of hearing|disability|disabled|handicap(?:ped)?|mental illness|depression|anxiety disorder|ptsd|bipolar|schizophrenia|autism|autistic|adhd|diagnosis|diagnosed|medication|prescription|therapy)\b/i,
        b: ACCOMMODATION_OR_NEED_LANGUAGE,
      },
      {
        id: 'disability_adverse_treatment_cooccurrence',
        a: /\b(wheelchair|blind|deaf|hard of hearing|disability|disabled|handicap(?:ped)?|mental illness|depression|anxiety disorder|ptsd|bipolar|schizophrenia|autism|autistic|adhd|diagnosis|diagnosed|medication|prescription|therapy)\b/i,
        b: ADVERSE_TREATMENT_LANGUAGE,
      },
    ],
  },

  // FIX 1 (Asimov/Mason review): the spec's own starter list had 'calfresh'
  // as a bare word here. BEFORE: phrases included 'calfresh' directly.
  // AFTER: removed from phrases, added as a co-occurrence pair below —
  // same shape every other single-word-vocabulary category in this file
  // uses, not a bare-word exception.
  source_of_income: {
    phrases: [
      'source of income', 'section 8', 'housing choice voucher', 'housing voucher',
      'rental assistance program', 'snap benefits', 'public assistance',
      'social security disability',
    ],
    cooccurrence: [
      {
        id: 'source_of_income_calfresh_cooccurrence',
        a: /\bcalfresh\b/i,
        b: ADVERSE_TREATMENT_LANGUAGE,
      },
    ],
  },

  // Phrases only, deliberately excluding 'too old'/'too young for' — spec
  // Section 1.4 item 1, the real, measured 91% false-positive data point.
  age: {
    phrases: ['age discrimination', 'senior citizen', 'elderly tenant', 'over 62', 'over 65', 'age restricted community'],
    cooccurrence: [],
  },

  // FIX 2 (Mason review): the spec's own starter pair had 'separated' in
  // the `a` side. BEFORE: a: /\b(divorced|divorce|separated|widow|widower|
  // spouse|domestic partner)\b/i. AFTER: 'separated' removed (too common in
  // ordinary PM correspondence with no marital connotation — separate
  // meters, items separated during move-out); replaced with Mason's three
  // specific phrases. Every other term in the pair is unchanged.
  marital_status: {
    phrases: ['marital status'],
    cooccurrence: [
      {
        id: 'marital_status_cooccurrence',
        a: /\b(divorced|divorce|getting divorced|going through a divorce|estranged spouse|widow|widower|spouse|domestic partner)\b/i,
        b: ADVERSE_TREATMENT_LANGUAGE,
      },
    ],
  },

  // v2 addition — genuinely missing before (see the v2 header note above).
  // 'veteran status' and 'military discrimination' are specific enough to
  // stand alone as phrases — same reasoning as 'marital status' and
  // 'religious discrimination' elsewhere in this file: on-topic on their
  // own, low ordinary-correspondence collision risk.
  // 'active duty', 'service member', 'military family', and 'pcs orders'
  // are deliberately NOT phrases — each is extremely common in ordinary,
  // entirely legitimate PM correspondence with no discrimination angle at
  // all (Servicemembers Civil Relief Act lease-break requests, deployment/
  // PCS relocation notices are routine, frequent, and not Fair-Housing
  // issues by themselves). Following this file's own FIX 1/FIX 2 precedent
  // for exactly this problem, they sit in the cooccurrence `a` side
  // instead, needing ADVERSE_TREATMENT_LANGUAGE to also be present before
  // firing. Same treatment for the bare words 'military' and 'veteran'
  // themselves, which have common non-discriminatory business usage
  // ("military discount", "veteran-owned business").
  military_veteran_status: {
    phrases: ['veteran status', 'military discrimination'],
    cooccurrence: [
      {
        id: 'military_veteran_status_cooccurrence',
        a: /\b(military family|active[ -]duty|service member|pcs orders|military|veteran)\b/i,
        b: ADVERSE_TREATMENT_LANGUAGE,
      },
    ],
  },

  ancestry: {
    phrases: ['family ancestry'],
    cooccurrence: [
      {
        id: 'ancestry_cooccurrence',
        a: /\bancestry\b/i,
        b: ADVERSE_TREATMENT_LANGUAGE,
      },
    ],
  },

  // FIX 1 (Asimov/Mason review): the spec's own starter list had
  // 'deportation' as a bare word here. BEFORE: phrases included
  // 'deportation' directly. AFTER: removed from phrases, added as a
  // co-occurrence pair below.
  immigration_citizenship: {
    phrases: [
      'immigration status', 'citizenship status', 'visa status', 'green card',
      'undocumented immigrant', 'ice hold', 'proof of citizenship',
    ],
    cooccurrence: [
      {
        id: 'immigration_deportation_cooccurrence',
        a: /\bdeportation\b/i,
        b: ADVERSE_TREATMENT_LANGUAGE,
      },
    ],
  },

  // Phrases only — protected-class-terms.js's own entries here are already
  // phrase-shaped; reused directly, not reworded.
  primary_language: {
    phrases: [
      'primary language', "doesn't speak english", 'does not speak english',
      'language barrier', 'needs a translator', 'needs an interpreter',
      'limited english proficiency',
    ],
    cooccurrence: [],
  },

  // Bonus category, carried forward from protected-class-terms.js for
  // consistency — already phrase-shaped there; reused directly.
  genetic_information: {
    phrases: ['genetic information', 'genetic testing', 'family medical history'],
    cooccurrence: [],
  },

  // THE ONE DELIBERATE BARE-WORD EXCEPTION — unchanged from the spec's own
  // proposal. Named explicitly, not silently included, per Peter's own
  // instruction ("phrases and not individual words") — this is the single
  // departure from it, carried over from protected-class-terms.js's own
  // reasoning: "a bare discrimination accusation, in property-management
  // correspondence, is in practice essentially never an unrelated use of
  // the word." FLAGGED FOR PETER'S OWN EXPLICIT SIGN-OFF (spec Open Item
  // 1) — not yet given. If he'd rather this be phrase-only too (e.g. 'this
  // is discrimination', 'that's discriminatory'), that's a one-line change
  // to bareWordExceptions below, not a redesign.
  discrimination_general: {
    phrases: [],
    cooccurrence: [],
    bareWordExceptions: [
      'discriminate', 'discriminated', 'discriminating', 'discriminates',
      'discrimination', 'discriminatory',
    ],
  },
};

// ---------------------------------------------------------------------------
// Compilation — same mechanism privilege-keywords.js's compile() already
// uses: \b-bounded regex for plain word/space terms, plain substring match
// as a fallback for anything with punctuation (none of this file's terms
// need that fallback today, but the same escape hatch is kept for
// consistency and future entries).
// ---------------------------------------------------------------------------
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileTerm(term) {
  const wordCharsOnly = /^[a-z0-9 ']+$/i.test(term);
  return wordCharsOnly
    ? new RegExp(`\\b${escapeRegex(term)}\\b`, 'i')
    : new RegExp(escapeRegex(term), 'i');
}

// Flat, reviewable lists — same export shape as privilege-keywords.js's
// TAG_TERMS/HOLD_TERMS/HOLD_COOCCURRENCE_PAIRS — built once from CATEGORIES
// above so the category structure and the flat compiled form can never
// silently drift apart.
const WIDE_NET_PHRASES = [];
const WIDE_NET_COOCCURRENCE_PAIRS = [];
const WIDE_NET_BARE_WORD_EXCEPTIONS = [];

for (const [category, def] of Object.entries(CATEGORIES)) {
  for (const term of def.phrases || []) {
    WIDE_NET_PHRASES.push({ term, category, regex: compileTerm(term) });
  }
  for (const pair of def.cooccurrence || []) {
    WIDE_NET_COOCCURRENCE_PAIRS.push({ ...pair, category });
  }
  for (const term of def.bareWordExceptions || []) {
    WIDE_NET_BARE_WORD_EXCEPTIONS.push({ term, category, regex: compileTerm(term) });
  }
}

/**
 * Scans one piece of text (a full thread's text — see threadFullText() in
 * complaint-tracking/lib/thread-adapter.js) against the wide net: every
 * literal phrase, every co-occurrence pair, and the one named bare-word
 * exception category. Pure, synchronous, no I/O — safe to call in a tight
 * loop over the whole archive (the dry-run measurement below does exactly
 * that).
 * @param {string} threadText
 * @returns {{
 *   matched: boolean,
 *   matchedPhrases: string[],
 *   matchedCooccurrencePairs: string[],
 *   matchedBareWordExceptions: string[],
 *   matchedCategories: string[]
 * }}
 */
function matchesWideNet(threadText) {
  const normalized = String(threadText || '');
  const matchedPhrases = [];
  const matchedCooccurrencePairs = [];
  const matchedBareWordExceptions = [];
  const matchedCategories = new Set();

  for (const { term, category, regex } of WIDE_NET_PHRASES) {
    if (regex.test(normalized)) {
      matchedPhrases.push(term);
      matchedCategories.add(category);
    }
  }
  for (const pair of WIDE_NET_COOCCURRENCE_PAIRS) {
    if (pair.a.test(normalized) && pair.b.test(normalized)) {
      matchedCooccurrencePairs.push(pair.id);
      matchedCategories.add(pair.category);
    }
  }
  for (const { term, category, regex } of WIDE_NET_BARE_WORD_EXCEPTIONS) {
    if (regex.test(normalized)) {
      matchedBareWordExceptions.push(term);
      matchedCategories.add(category);
    }
  }

  return {
    matched: matchedPhrases.length > 0 || matchedCooccurrencePairs.length > 0 || matchedBareWordExceptions.length > 0,
    matchedPhrases,
    matchedCooccurrencePairs,
    matchedBareWordExceptions,
    matchedCategories: Array.from(matchedCategories),
  };
}

module.exports = {
  matchesWideNet,
  CATEGORIES,
  WIDE_NET_PHRASES,
  WIDE_NET_COOCCURRENCE_PAIRS,
  WIDE_NET_BARE_WORD_EXCEPTIONS,
  ADVERSE_TREATMENT_LANGUAGE,
  ACCOMMODATION_OR_NEED_LANGUAGE,
  TERMS_VERSION,
};
