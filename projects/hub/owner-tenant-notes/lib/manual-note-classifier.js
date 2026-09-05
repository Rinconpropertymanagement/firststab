/**
 * lib/manual-note-classifier.js
 * Layer 2 of the two-layer content check for MANUALLY-TYPED notes —
 * owner-tenant-operational-notes-SPEC.md Section 5: "For manual notes
 * there is no model already in the pipeline to self-report against — this
 * spec recommends Q add one small, new, cheap classification-only Claude
 * call at write time... rather than relying on Layer 1 alone for
 * staff-typed text." This is genuinely new code (the spec's own words),
 * not a reuse of extract-claims.js's self-report convention — there is no
 * extraction happening here, only classification of text a human already
 * typed.
 *
 * This is Open Item #2 from the spec ("a real, new build item, not yet
 * estimated — worth a size check from Q before this ships, since it adds
 * a synchronous AI call to every manual note submission"). See this
 * build's own report for the measured latency/cost from real calls against
 * this file, made before it was wired into the note-creation route.
 *
 * DESIGN CHOICES (Q's judgment calls, not fully specified by the spec —
 * flagged in the build report):
 *   - Model: claude-sonnet-5, matching this codebase's own established
 *     choice for this exact class of task (extract-claims.js's Layer 2
 *     self-report also runs on claude-sonnet-5) — not Opus, which the
 *     claude-api skill defaults to for un-scoped work. The spec explicitly
 *     calls for "one small, new, CHEAP classification-only" call; Opus's
 *     ~2.5x-per-token price for a same-quality classification task (the
 *     same 10-category list Layer 1 already screens for, just judged by
 *     a model instead of a keyword regex) buys nothing here — reserved for
 *     if real measured accuracy on this exact use ever needs raising.
 *   - Effort: 'low' — this is a short classification judgment on a single
 *     paragraph, not a multi-step extraction over PDFs/state-history the
 *     way extract-claims.js's 'medium' effort was tuned for. Measured
 *     against real notes as part of this build (see the report).
 *   - max_tokens: small and fixed — the response is a few fields of JSON,
 *     never a document.
 *   - No PDF/file input, no state history — the classifier sees ONLY the
 *     note's own note_text, nothing else. There is no other content to
 *     reason about for a manually-typed note.
 */

const Anthropic = require('@anthropic-ai/sdk');

const CLASSIFIER_MODEL = 'claude-sonnet-5';
const CLASSIFIER_MAX_TOKENS = 512;

function client() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  return new Anthropic({ apiKey });
}

// Same protected-characteristic list protected-class-terms.js's own header
// comment describes (GOVERNANCE.md Rule 9's ten categories + the
// California-specific expansions) — restated here in prose for the model,
// not imported as code, since this is a natural-language instruction, not
// a data structure this file needs to iterate over. Kept in sync by hand;
// if protected-class-terms.js's CATEGORIES ever changes, this prompt
// should be revisited too (flagged for whoever next touches either file).
const CLASSIFICATION_PROMPT_HEADER = `You are a defense-in-depth content classifier for a property management company (Rincon Management, Southern California). A staff member just typed a short factual note about an owner, a tenant, or a property into an internal record-keeping tool. Your ONLY job is to judge whether the note's text touches a legally protected personal characteristic — independent of, and in addition to, a separate automated keyword scan that also runs on this same text. Judge based on the actual MEANING of the text, not just obvious keywords (the keyword scan already catches those) — this call exists specifically to catch subtler phrasing a fixed keyword list would miss.

Protected characteristics to check for: race, color, religion, sex, sexual orientation, gender identity, national origin, familial status (incl. having children), disability (incl. mental health, medical conditions, medications, service/assistance animals, accommodation requests), source of income (incl. Section 8/housing vouchers, public assistance), marital status, age, ancestry, genetic information, citizenship/immigration status, and primary language.

You are NOT deciding whether the note is appropriate to keep, whether it's true, or how sensitive it is beyond this one question. Do not produce any score, rating, or personality/risk judgment of any kind — only a yes/no flag on protected-characteristic content, with a short category label if yes.

Return ONLY a JSON object, no markdown fences, no explanation:
{
  "protected_class_flag": true | false,
  "protected_class_category": "short label, e.g. disability_health, source_of_income — or null if flag is false",
  "reasoning": "one short sentence explaining the judgment, for a human reviewer's benefit only"
}`;

/**
 * @param {string} noteText - the manual note's own note_text, nothing else.
 * @returns {Promise<{
 *   modelFlag: boolean,
 *   modelCategory: string|null,
 *   reasoning: string|null,
 *   modelVersion: string,
 *   latencyMs: number,
 *   usage: { input_tokens: number, output_tokens: number },
 * }>}
 */
async function classifyManualNote(noteText) {
  const anthropic = client();
  const startedAt = Date.now();

  const response = await anthropic.messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: CLASSIFIER_MAX_TOKENS,
    output_config: { effort: 'low' },
    messages: [{
      role: 'user',
      content: `${CLASSIFICATION_PROMPT_HEADER}\n\n=== NOTE TEXT ===\n${String(noteText || '')}`,
    }],
  });

  const latencyMs = Date.now() - startedAt;

  // Same truncation guard extract-claims.js uses — a classification-only
  // call at max_tokens 512 with effort 'low' should never hit this in
  // practice, but failing safe (treat as unflagged-but-log, never silently
  // swallow) matters more here than there: this IS the only Layer 2 signal
  // for a manual note, not one of several extraction outputs.
  if (response.stop_reason === 'max_tokens') {
    console.error(
      `[manual-note-classifier] TRUNCATED response (stop_reason=max_tokens). ` +
      `This should not happen at max_tokens=${CLASSIFIER_MAX_TOKENS} for a short classification reply — investigate before trusting this result.`
    );
    return {
      modelFlag: false, modelCategory: null, reasoning: null,
      modelVersion: response.model, latencyMs, usage: response.usage, truncated: true,
    };
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) {
    console.error('[manual-note-classifier] No text block in Claude response.');
    return { modelFlag: false, modelCategory: null, reasoning: null, modelVersion: response.model, latencyMs, usage: response.usage };
  }

  const raw = textBlock.text.trim();
  const jsonStart = raw.search(/[[{]/);
  const trimmed = jsonStart > 0 ? raw.slice(jsonStart) : raw;
  const cleaned = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    // SECURITY: never log the raw model response or the note text itself
    // here — same restraint extract-claims.js's own parse-failure handler
    // documents. This text has not yet passed the content check at all.
    console.error(`[manual-note-classifier] JSON parse failed. Response length: ${raw.length} chars. Error: ${err.message}`);
    return { modelFlag: false, modelCategory: null, reasoning: null, modelVersion: response.model, latencyMs, usage: response.usage };
  }

  return {
    modelFlag: !!(parsed && parsed.protected_class_flag),
    modelCategory: (parsed && parsed.protected_class_category) || null,
    reasoning: (parsed && parsed.reasoning) || null,
    modelVersion: response.model,
    latencyMs,
    usage: response.usage,
  };
}

module.exports = { classifyManualNote, CLASSIFIER_MODEL };
