/**
 * lib/protected-class-terms.js
 * Layer 1 of the two-layer content check (SPEC.md "The Content Check",
 * GOVERNANCE.md Rule 9). A maintained, reviewable keyword/phrase list — a
 * code asset, not a database table, so Mason can edit it the same way
 * GOVERNANCE.md itself is a maintained, owner-approved document.
 *
 * Built from three sources, per SPEC.md and the schema migration's "AUDIT
 * LOG GUIDANCE FOR Q" section — nothing invented fresh:
 *   1. GOVERNANCE.md Rule 9's ten categories (race, color, religion, sex,
 *      sexual orientation, gender identity, national origin, familial
 *      status, disability, source of income).
 *   2. The California-specific expansions already Mason-reviewed in
 *      compliance/ventura-county-compliance-kb.json, topics.fair-housing,
 *      fh-01 through fh-06: marital status, age, ancestry, genetic
 *      information, citizenship/immigration status, primary language, and
 *      Section 8 / voucher source-of-income specifically.
 *   3. Practical health/medical/disability terms — the real category the
 *      10-ticket "Property Brain" experiment turned up in a real vendor
 *      report ("Tenant is complaining of health concerns," ticket 17432-1).
 *
 * This is Layer 1 only — deterministic, fast, cheap, auditable. Layer 2
 * (the extraction model's own judgment) lives in extract-claims.js and
 * catches subtler phrasing this fixed list would miss. A hit on EITHER
 * layer flags the claim — see extract-claims.js's runContentCheck().
 *
 * DESIGN CALL: this list is intentionally broad/recall-oriented, not
 * precision-tuned. A false-positive flag costs one extra human review of
 * an already-unreviewed claim (it was never going to auto-apply to a
 * decision anyway — see "Review Gate" in SPEC.md). A false NEGATIVE — a
 * protected-class-adjacent claim that slips through unflagged — is the
 * failure mode Rule 9 exists to prevent. When in doubt, this list errs
 * toward flagging.
 *
 * VERSIONING: bump TERMS_VERSION whenever this list changes. Written into
 * audit_log.actor_version for every keyword-layer exclusion (see
 * extract-claims.js and router.js), so a compliance review can always tell
 * which version of this list produced a given flag.
 */

const TERMS_VERSION = 'protected-class-terms-v1';

// Each category maps to an array of lowercase terms/phrases. Matching is
// case-insensitive, whole-word-ish (see matchesTerm below) against the
// claim's plain-English text.
const CATEGORIES = {
  race_color: [
    'race', 'racial', 'racist', 'ethnicity', 'ethnic', 'skin color', 'skin tone',
    'black', 'african american', 'white', 'caucasian', 'asian', 'hispanic',
    'latino', 'latina', 'latinx', 'native american', 'indigenous',
    'middle eastern', 'pacific islander',
  ],
  religion: [
    'religion', 'religious', 'christian', 'christianity', 'catholic', 'protestant',
    'muslim', 'islam', 'islamic', 'jewish', 'judaism', 'hindu', 'hinduism',
    'buddhist', 'buddhism', 'sikh', 'atheist', 'church', 'mosque', 'synagogue',
    'temple', 'hijab', 'yarmulke', 'religious accommodation',
  ],
  sex_gender: [
    'pregnant', 'pregnancy', 'gay', 'lesbian', 'bisexual', 'homosexual',
    'transgender', 'trans ', 'nonbinary', 'non-binary', 'gender identity',
    'gender expression', 'sexual orientation', 'lgbtq',
  ],
  national_origin_immigration: [
    'national origin', 'immigrant', 'immigration', 'immigration status',
    'citizenship', 'citizenship status', 'visa status', 'green card',
    'undocumented', 'deportation', 'ice hold', 'ancestry', 'country of origin',
    'primary language', 'doesn\'t speak english', 'does not speak english',
    'language barrier', 'needs a translator', 'needs an interpreter',
  ],
  familial_status: [
    'familial status', 'has children', 'has kids', 'minor child', 'minor children',
    'custody', 'child custody', 'daycare', 'foster child', 'pregnant tenant',
  ],
  disability_health: [
    'disability', 'disabled', 'handicap', 'handicapped', 'wheelchair',
    'blind', 'deaf', 'hard of hearing', 'mental health', 'mental illness',
    'depression', 'anxiety disorder', 'ptsd', 'bipolar', 'schizophrenia',
    'autism', 'autistic', 'adhd', 'medical condition', 'health concern',
    'health concerns', 'illness', 'chronic illness', 'terminal illness',
    'medication', 'prescription', 'therapy', 'diagnosis', 'diagnosed',
    'hospice', 'cancer', 'seizure', 'seizures', 'service animal',
    'emotional support animal', 'assistance animal', 'reasonable accommodation',
    'reasonable modification', 'mobility impairment', 'cognitive impairment',
    'developmental disability',
  ],
  source_of_income: [
    'source of income', 'section 8', 'housing voucher', 'housing choice voucher',
    'hcv', 'vash', 'welfare', 'food stamps', 'calfresh', 'snap benefits',
    'ssi', 'social security disability', 'disability income', 'public assistance',
    'rental assistance program',
  ],
  marital_status: [
    'marital status', 'divorced', 'divorce', 'separated (spouse)', 'widow',
    'widower', 'spouse', 'domestic partner',
  ],
  age: [
    'senior citizen', 'elderly', 'over 62', 'over 65', 'age discrimination',
    'too old', 'too young for',
  ],
  genetic_information: [
    'genetic information', 'genetic testing', 'genetic condition',
    'family medical history',
  ],
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word/phrase regex per term, built once at module load. Plain
// substring matching was tried first and rejected — it false-positived on
// ordinary words that happen to contain a short acronym (e.g. "SSI" inside
// "exceSSIve"). \b word boundaries fix that while still matching multi-word
// phrases like "health concern" normally. Trailing-space terms (e.g.
// "trans ") are trimmed first so the boundary regex still applies cleanly.
const FLAT_TERMS = Object.entries(CATEGORIES).flatMap(([category, terms]) =>
  terms.map(term => {
    const trimmed = term.trim();
    return {
      term,
      category,
      regex: new RegExp(`\\b${escapeRegex(trimmed)}\\b`, 'i'),
    };
  })
);

/**
 * Scans a single piece of claim text for protected-class-indicator terms.
 * Returns { flagged, categories, matchedTerms } — matchedTerms is for
 * internal/UI use only (e.g. showing a reviewer why something was
 * flagged); callers MUST NOT write matchedTerms or the source text into
 * audit_log (see SPEC.md's Content Check + router.js's audit_log writes —
 * "deliberately NOT the flagged text itself").
 */
function scanText(text) {
  const normalized = String(text || '');
  const categories = new Set();
  const matchedTerms = [];

  for (const { term, category, regex } of FLAT_TERMS) {
    if (regex.test(normalized)) {
      categories.add(category);
      matchedTerms.push(term);
    }
  }

  return {
    flagged: categories.size > 0,
    categories: Array.from(categories),
    matchedTerms,
  };
}

module.exports = { scanText, TERMS_VERSION, CATEGORIES };
