/**
 * lib/work-order-notes-classifier.js
 *
 * CURRENTLY UNUSED — nothing in this codebase calls this file (its only
 * caller, work-order-notes-content-check.js, is itself unused — see that
 * file's own header). Peter explicitly instructed the content check be
 * removed from the Work Order Notes Alert send path entirely; see
 * work-order-notes-alert.js's header and
 * compliance/work-order-note-alerts-content-check-removal-decision-resolution.md
 * for the full record. Left in the repo rather than deleted — cheap to
 * keep, cheap to re-wire if this is ever revisited — but it is dormant.
 *
 * Layer 2 of the two-layer content check for properties.maintenance_notes
 * (Work Order Notes Alert — work-order-notes-alert-SPEC.md Section 7;
 * hard requirement in compliance/work-order-note-alerts-governance-review.md,
 * condition 1: "Layer 1 ... and Layer 2 ..., both run unconditionally at
 * send time"). Cloned from owner-tenant-notes/lib/manual-note-classifier.js
 * per the build task's explicit instruction ("same model, same low-effort
 * classification-only call") rather than invented fresh — same model, same
 * effort level, same max_tokens, same response shape/parsing, same
 * fail-open-on-parse-failure behavior (Layer 1 remains a real, independent
 * backstop either way — see work-order-notes-content-check.js, whose own
 * try/catch around the call to this file is what fails SAFE on an actual
 * call-level error, per governance condition 4).
 *
 * The only real difference from manual-note-classifier.js is the prompt's
 * framing: this field is property-level operational text (vendor contacts,
 * approval routing — e.g. "Call Zack for approval on any work order"),
 * sourced from AppFolio and editable by any property manager, not a
 * tenant/owner-authored narrative note. Oracle's spec Section 7 and
 * Asimov's governance review both point to
 * approval-briefing/lib/access-instructions-check.js's prior treatment of
 * a comparable property/job-adjacent field (access_instructions) as the
 * direct precedent for why that difference in origin doesn't excuse this
 * field from a real Layer 2 check.
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
// comment describes, restated in prose for the model — kept in sync by
// hand with that file and with manual-note-classifier.js's own copy, same
// as that file already documents.
const CLASSIFICATION_PROMPT_HEADER = `You are a defense-in-depth content classifier for a property management company (Rincon Management, Southern California). The text below is a property-level "maintenance notes" field — special handling instructions for work orders at this property (e.g. vendor contacts, approval routing, access logistics), sourced from the company's property management software and editable by any property manager. It is about to be included, verbatim unless flagged, in an automatic internal staff email sent every time a new work order is created at this property. Your ONLY job is to judge whether the text touches a legally protected personal characteristic — independent of, and in addition to, a separate automated keyword scan that also runs on this same text. Judge based on the actual MEANING of the text, not just obvious keywords (the keyword scan already catches those) — this call exists specifically to catch subtler phrasing a fixed keyword list would miss.

Protected characteristics to check for: race, color, religion, sex, sexual orientation, gender identity, national origin, familial status (incl. having children), disability (incl. mental health, medical conditions, medications, service/assistance animals, accommodation requests), source of income (incl. Section 8/housing vouchers, public assistance), marital status, age, ancestry, genetic information, citizenship/immigration status, and primary language.

An ordinary operational instruction — "call Zack for approval on any work order over $500," "gate code is 2040," "vendor must call 1 hour ahead," "tenant has a key, no need to notify" — is NOT protected-class content on its own. Only flag if the text itself actually touches one of the topics above (a real example this check exists to catch: "coordinate with tenant's home health aide before entering" — disability/health).

You are NOT deciding whether the note is appropriate to keep, whether it's true, or how sensitive it is beyond this one question. Do not produce any score, rating, or personality/risk judgment of any kind — only a yes/no flag on protected-characteristic content, with a short category label if yes.

Return ONLY a JSON object, no markdown fences, no explanation:
{
  "protected_class_flag": true | false,
  "protected_class_category": "short label, e.g. disability_health, source_of_income — or null if flag is false",
  "reasoning": "one short sentence explaining the judgment, for a human reviewer's benefit only"
}`;

/**
 * @param {string} noteText - properties.maintenance_notes' current value, nothing else.
 * @returns {Promise<{
 *   modelFlag: boolean,
 *   modelCategory: string|null,
 *   reasoning: string|null,
 *   modelVersion: string,
 *   latencyMs: number,
 *   usage: { input_tokens: number, output_tokens: number },
 * }>}
 */
async function classifyWorkOrderNote(noteText) {
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

  // Same truncation guard manual-note-classifier.js uses — should never
  // fire in practice at max_tokens=512/effort=low for a short
  // classification reply, but failing safe (log loudly, treat as
  // unflagged-but-log) matters more here than in a multi-output
  // extraction: Layer 1 is the only other independent signal for this
  // one instance.
  if (response.stop_reason === 'max_tokens') {
    console.error(
      `[work-order-notes-classifier] TRUNCATED response (stop_reason=max_tokens). ` +
      `This should not happen at max_tokens=${CLASSIFIER_MAX_TOKENS} for a short classification reply — investigate before trusting this result.`
    );
    return {
      modelFlag: false, modelCategory: null, reasoning: null,
      modelVersion: response.model, latencyMs, usage: response.usage, truncated: true,
    };
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) {
    console.error('[work-order-notes-classifier] No text block in Claude response.');
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
    // here — same restraint manual-note-classifier.js's own parse-failure
    // handler documents.
    console.error(`[work-order-notes-classifier] JSON parse failed. Response length: ${raw.length} chars. Error: ${err.message}`);
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

module.exports = { classifyWorkOrderNote, CLASSIFIER_MODEL };
