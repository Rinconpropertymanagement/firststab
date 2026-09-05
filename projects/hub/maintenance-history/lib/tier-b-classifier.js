/**
 * lib/tier-b-classifier.js
 * The Tier B contextual classifier — content-screening-tier-redesign-
 * SPEC.md Section 4. One classifier function, one prompt template,
 * parameterized per term-group (counsel removed the internal memo's "at
 * least 3 tailored prompts" requirement — Section 4's "Engineering
 * decision" leaves this to Rincon, and one prompt is what this build
 * chose).
 *
 * Runs ONLY for the six Tier B terms content-check.js's TIER_B_TERMS
 * defines — every other term protected-class-terms.js knows about stays
 * Tier A (immediate flag, no AI call, no change to that file at all).
 *
 * Fails CLOSED on every error path — network failure, timeout, a
 * truncated response, or a response that isn't exactly one of the three
 * expected words — all resolve to classification: 'ambiguous', never a
 * thrown exception. content-check.js treats 'ambiguous' the same as
 * 'protected' (flagged), per counsel's own instruction: "identify it for
 * human judgment rather than assuming discrimination." This mirrors the
 * same "fail closed, not open" discipline extract-claims.js and
 * approval-briefing/lib/access-instructions-check.js already use for this
 * exact class of AI content-safety call.
 */

const Anthropic = require('@anthropic-ai/sdk');

const TIER_B_CLASSIFIER_VERSION = 'tier-b-classifier-v1';

// Same 9-15s network-timeout precedent range already used elsewhere in
// this codebase (lib/auth.js's AUTH_TIMEOUT_MS, security-deposit/lib/
// b2-client.js's B2_TIMEOUT_MS) — a stalled AI call must not hang the
// caller indefinitely. A timeout resolves to 'ambiguous' below, exactly
// like any other failure. Exact value is an implementation detail left to
// Q (redesign spec Open Item #3) — not researched further than matching
// this codebase's existing precedent.
const TIER_B_TIMEOUT_MS = 12000;

function client() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  return new Anthropic({ apiKey });
}

// The four parameter sets, Section 4's own table — keyed by TERM, not
// category. "Blind" and "Diagnosis" both map to the disability_health
// category (see content-check.js's own, separate categoryOf() lookup,
// which covers every term protected-class-terms.js knows about) but need
// different hint text here, so a category-keyed table would collapse two
// genuinely different questions into one.
const TERM_HINTS = {
  white: {
    protectedHint: "a person's race, ethnicity, or skin color — including a stated racial/ethnic preference about a tenant, neighborhood, or household",
    ordinaryHint: 'a paint color, a fixture or appliance finish or material, a brand name that happens to include a color word, or a similar object/product/repair description',
  },
  black: {
    protectedHint: "a person's race, ethnicity, or skin color — including a stated racial/ethnic preference about a tenant, neighborhood, or household",
    ordinaryHint: 'a paint color, a fixture or appliance finish or material, a brand name that happens to include a color word, or a similar object/product/repair description',
  },
  blind: {
    protectedHint: "a person's visual impairment or blindness",
    ordinaryHint: 'a household item (window blinds) or an unrelated use of the word (e.g. "blind spot")',
  },
  diagnosis: {
    protectedHint: "a person's medical condition, disability, or health diagnosis",
    ordinaryHint: "a technician's or vendor's diagnosis of a mechanical, electrical, plumbing, or appliance fault",
  },
  diagnosed: {
    protectedHint: "a person's medical condition, disability, or health diagnosis",
    ordinaryHint: "a technician's or vendor's diagnosis of a mechanical, electrical, plumbing, or appliance fault",
  },
  'too old': {
    protectedHint: "a person's age — including an age-based housing preference or restriction",
    ordinaryHint: 'a piece of equipment, fixture, appliance, or hardware described as worn out, outdated, or unsuitable for its purpose',
  },
  'too young for': {
    protectedHint: "a person's age — including an age-based housing preference or restriction",
    ordinaryHint: 'a piece of equipment, fixture, appliance, or hardware described as worn out, outdated, or unsuitable for its purpose',
  },
};

// Counsel's own base question (Question 2 of the outside-counsel opinion),
// not the internal memo's broader "coded or indirect" standard — Section 4.
function buildPrompt({ term, claimText }) {
  const hints = TERM_HINTS[term];
  if (!hints) throw new Error(`No Tier B hint text defined for term "${term}".`);
  return `You are reviewing a single sentence from a property-management maintenance
record, for one narrow question. Do not evaluate the sentence for anything
else.

Sentence: "${claimText}"

The word or phrase in question: "${term}"

Question: In this sentence, does "${term}" actually communicate or
materially imply information about ${hints.protectedHint}, rather than
describing ${hints.ordinaryHint}?

If the answer is genuinely ambiguous, say "ambiguous" — do not guess, and
do not assume discrimination is present just because the word could
theoretically be read that way.

Respond with exactly one word: "protected", "ordinary", or "ambiguous".`;
}

const VALID_CLASSIFICATIONS = new Set(['protected', 'ordinary', 'ambiguous']);

/**
 * @param {object} params
 * @param {string} params.term - one of content-check.js's six Tier B terms
 * @param {string} params.category - the flagged_category this term maps
 *   to, per the caller's own categoryOf() lookup. Echoed back on the
 *   result, not used to build the prompt (see TERM_HINTS above for why
 *   hint text is looked up per-term, not per-category).
 * @param {string} params.claimText - the full claim sentence being checked
 * @returns {Promise<{
 *   term: string,
 *   category: string,
 *   classification: 'protected'|'ordinary'|'ambiguous',
 *   disposition: 'cleared'|'flagged',
 *   model_version: string,
 * }>}
 */
async function classifyTierBTerm({ term, category, claimText }) {
  let classification;
  try {
    const anthropic = client();
    const response = await anthropic.messages.create(
      {
        // Same model/account already used by extract-claims.js and
        // access-instructions-check.js for this exact class of narrow
        // content-safety self-check.
        model: 'claude-sonnet-5',
        // A one-word classification, not an extraction — same sizing
        // access-instructions-check.js already settled on for a
        // comparably narrow self-check ("a one-sentence classification,
        // not an extraction — no need for 'medium'/'high' reasoning
        // depth").
        max_tokens: 512,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt({ term, claimText }) }] }],
      },
      { timeout: TIER_B_TIMEOUT_MS }
    );

    if (response.stop_reason === 'max_tokens') {
      // Truncated before it finished — treated the same as any other
      // unparseable response, per the fail-closed rule below.
      console.error(`[tier-b-classifier] Response truncated (stop_reason=max_tokens) for term "${term}" — failing closed as ambiguous.`);
      classification = 'ambiguous';
    } else {
      const textBlock = response.content.find(b => b.type === 'text');
      // Strip any leading/trailing punctuation or quoting the model adds
      // around the single word (e.g. "Ordinary." or "\"protected\"").
      const raw = textBlock ? textBlock.text.trim().toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '') : '';
      if (VALID_CLASSIFICATIONS.has(raw)) {
        classification = raw;
      } else {
        // SECURITY: never log the raw model response or the source
        // sentence here — same discipline extract-claims.js's and
        // access-instructions-check.js's own parse-failure handlers
        // document, for the same reason (this is exactly the unfiltered
        // content this check exists to screen before anything is logged).
        console.error(`[tier-b-classifier] Unparseable response for term "${term}" (expected exactly one of protected/ordinary/ambiguous) — failing closed as ambiguous.`);
        classification = 'ambiguous';
      }
    }
  } catch (err) {
    // Fail CLOSED, not open — any network error, timeout, or thrown
    // exception resolves to 'ambiguous' rather than propagating. Section
    // 4: "the fail-closed default... now covers both AI uncertainty AND
    // infrastructure failure identically."
    console.error(`[tier-b-classifier] Classifier call failed for term "${term}" — failing closed as ambiguous: ${err.message}`);
    classification = 'ambiguous';
  }

  return {
    term,
    category,
    classification,
    disposition: classification === 'ordinary' ? 'cleared' : 'flagged',
    model_version: TIER_B_CLASSIFIER_VERSION,
  };
}

module.exports = { classifyTierBTerm, TIER_B_CLASSIFIER_VERSION };
