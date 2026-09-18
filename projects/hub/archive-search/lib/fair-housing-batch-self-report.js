/**
 * lib/fair-housing-batch-self-report.js
 * Archive Search's Layer 2 Fair Housing self-report — archive-search-
 * technical-spec.md, "Resolving Finding 2" (Option B, the recommended
 * option). Stands in for the free self-report Layer 2 normally gets for
 * free from an extraction/categorization model that's already reading a
 * thread for another purpose (complaint-tracking's own categorize-
 * complaint.js). Archive search's batch pass has no other reason to read a
 * thread's content at all, so this module exists solely to produce that
 * self-report as its own narrow, single-purpose call.
 *
 * Modeled DIRECTLY on maintenance-history/lib/tier-b-classifier.js's real,
 * proven shape, per the spec's own explicit instruction ("Design Decision"):
 * same model (claude-sonnet-5), same max_tokens (512), same effort
 * ('low'), same timeout (12000ms, TIER_B_TIMEOUT_MS's precedent range),
 * same fail-closed contract. The one real difference: tier-b-classifier.js
 * parses a single word out of the model's response; this module parses a
 * small JSON object ({ flagged, category }) instead, because the question
 * here ("does this thread reference a protected characteristic a keyword
 * scan might miss") needs a category alongside the yes/no, not just a
 * three-way word.
 *
 * Fails CLOSED on every error path — network failure, timeout, a truncated
 * response, or a response that isn't valid, well-shaped JSON — all resolve
 * to { flagged: true, category: 'model_self_report_failed_closed' }, never
 * a thrown exception. checkClaim() (maintenance-history/lib/content-
 * check.js) treats a Layer 2 flag as an OR, never a veto — this module
 * never causes a real Fair Housing signal to be silently dropped by its own
 * failure, matching tier-b-classifier.js's own "fail closed, not open"
 * discipline for this exact class of AI content-safety call.
 *
 * SECURITY: never logs the source thread text, or the model's own raw
 * response text, anywhere — same restraint tier-b-classifier.js's own
 * parse-failure handler documents, for the same reason (this is exactly
 * the unfiltered, unscreened correspondence this check exists to screen
 * before anything about it is written to a log).
 */

const Anthropic = require('@anthropic-ai/sdk');

const FAIR_HOUSING_SELF_REPORT_VERSION = 'archive-search-self-report-v2-narrow-fh-concern';

// Same 9-15s network-timeout precedent range tier-b-classifier.js's own
// TIER_B_TIMEOUT_MS uses (lib/auth.js's AUTH_TIMEOUT_MS, security-deposit/
// lib/b2-client.js's B2_TIMEOUT_MS) — a stalled AI call must not hang the
// screening pass indefinitely. A timeout resolves to the fail-closed
// default below, exactly like any other failure.
const SELF_REPORT_TIMEOUT_MS = 12000;

function client() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  return new Anthropic({ apiKey });
}

// Listed for the model's own guidance only — NOT a hard enum the parser
// validates against. protected-class-terms.js's real CATEGORIES (plus its
// new discrimination_general, Finding 4) already cover this ground more
// authoritatively than this file should try to duplicate; if the model
// returns some other short label, checkClaim() still accepts it via
// claim.modelCategory (same as any other Layer 2 self-report already
// flowing through that function today from categorize-complaint.js).
const CATEGORY_HINTS = [
  'race_color', 'religion', 'sex_gender', 'national_origin_immigration',
  'familial_status', 'disability_health', 'source_of_income',
  'marital_status', 'age', 'genetic_information', 'discrimination_general',
];

// Question text below is counsel's own recommended language (outside
// counsel opinion, Section 10 — compliance/archive-search-self-report-
// recalibration-outside-counsel-opinion.md), adopted verbatim per
// projects/hub/email-intake/archive-search-self-report-recalibration-spec.md
// Section 3. Only the intro framing sentence, the {threadText} slot, and
// the trailing "respond with JSON" instruction are call scaffolding, not
// part of counsel's reviewed text. Replaces the old "references a
// protected characteristic" question (FAIR_HOUSING_SELF_REPORT_VERSION
// v1), which flagged ~90% of everything that reached it on real archive
// data — see the spec's Section 1 and Section 2 for why.
function buildPrompt({ threadText }) {
  return `You are reviewing a single email conversation from a property
management company's inbox, for one narrow question.

This conversation already matched an automated scan for language connected
to a legally protected characteristic (race, religion, sex, familial
status, disability, national origin, source of income, marital status,
age, or a similar protected category). That match alone does not mean this
conversation is worth a person reviewing.

Conversation:
"""
${threadText}
"""

Setting aside the mere presence or discussion of a protected
characteristic, does this conversation reasonably indicate a potential
Fair Housing concern?

Flag the conversation if it reasonably indicates:
(a) adverse, hostile, derogatory, or differential treatment connected to a
protected characteristic, including a refusal, denial, exclusion, threat,
different service, or materially different treatment;
(b) a disability accommodation or modification request that appears to
have been refused, ignored, materially delayed, retaliated against, or
left unresolved;
(c) a preference, limitation, policy, steering effort, recommendation,
advertisement, instruction, or housing decision that appears influenced by
a protected characteristic; or
(d) indirect or euphemistic language that, viewed reasonably in context,
suggests a protected characteristic influenced or may influence treatment,
services, a housing decision, policy, preference, limitation, or
recommendation.

Do not flag solely because a protected characteristic is identified,
mentioned, or discussed. Do not flag a reasonable accommodation or
modification merely because it was requested or granted. Ordinary factual
or operational discussion involving a protected characteristic should
clear unless the surrounding context reasonably indicates one of the
concerns above.

If the communication presents a genuine ambiguity that cannot reasonably
be resolved from context, send it for human review.

Respond with EXACTLY one JSON object and nothing else — no markdown code
fence, no explanation before or after it:
{"flagged": true or false, "category": one short lowercase label from [${CATEGORY_HINTS.join(', ')}] if flagged, or null if not flagged}`;
}

// Extracts and parses the first {...} JSON object found in the model's
// response text. Tolerates a wrapping markdown code fence or incidental
// leading/trailing text, since a "respond with exactly one JSON object"
// instruction is not always followed to the letter.
function parseSelfReportResponse(rawText) {
  if (typeof rawText !== 'string') return null;
  const start = rawText.indexOf('{');
  const end = rawText.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  let parsed;
  try {
    parsed = JSON.parse(rawText.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.flagged !== 'boolean') {
    return null;
  }
  const category = parsed.flagged
    ? (typeof parsed.category === 'string' && parsed.category.trim() ? parsed.category.trim().toLowerCase() : 'model_judgment_unspecified')
    : null;
  return { flagged: parsed.flagged, category };
}

const FAIL_CLOSED_RESULT = Object.freeze({ flagged: true, category: 'model_self_report_failed_closed' });

/**
 * @param {object} params
 * @param {string} params.threadText - full thread text (threadFullText()
 *   from complaint-tracking/lib/thread-adapter.js — every message,
 *   labeled, oldest first)
 * @returns {Promise<{ flagged: boolean, category: string|null }>}
 */
async function selfReportFairHousingContent({ threadText }) {
  let result;
  try {
    const anthropic = client();
    const response = await anthropic.messages.create(
      {
        model: 'claude-sonnet-5',
        max_tokens: 512,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt({ threadText }) }] }],
      },
      { timeout: SELF_REPORT_TIMEOUT_MS }
    );

    if (response.stop_reason === 'max_tokens') {
      console.error('[fair-housing-batch-self-report] Response truncated (stop_reason=max_tokens) — failing closed.');
      result = FAIL_CLOSED_RESULT;
    } else {
      const textBlock = response.content.find((b) => b.type === 'text');
      const parsed = textBlock ? parseSelfReportResponse(textBlock.text) : null;
      if (parsed) {
        result = parsed;
      } else {
        // SECURITY: never log the raw model response or the source thread
        // text here — same discipline tier-b-classifier.js's own
        // parse-failure handler documents, for the same reason.
        console.error('[fair-housing-batch-self-report] Unparseable response (expected {"flagged":bool,"category":...}) — failing closed.');
        result = FAIL_CLOSED_RESULT;
      }
    }
  } catch (err) {
    // Fail CLOSED, not open — any network error, timeout, or thrown
    // exception resolves to the fail-closed default rather than
    // propagating, identical to tier-b-classifier.js's own discipline.
    console.error(`[fair-housing-batch-self-report] Self-report call failed — failing closed: ${err.message}`);
    result = FAIL_CLOSED_RESULT;
  }

  return result;
}

module.exports = { selfReportFairHousingContent, FAIR_HOUSING_SELF_REPORT_VERSION };
