/**
 * lib/access-instructions-check.js
 *
 * The two-layer content check (content-check.js + protected-class-terms.js,
 * GOVERNANCE.md Rule 9), applied to Latchel's `access_instructions` job
 * field specifically — approval-briefing-SPEC.md Section 4.4, the gate
 * Mason's Fair Housing review required (finding 1,
 * compliance/approval-briefing-fair-housing-review.md): "access_instructions
 * must be routed through content-check.js (both layers) at gather time,
 * the same way risk_assessment_text is, before it is rendered into either
 * the PM briefing or the owner draft."
 *
 * Why this file exists instead of just calling extract-claims.js's
 * self-check: that self-check is produced as a byproduct of extracting a
 * maintenance CLAIM from a job's free text (extractAIClaims() asks the
 * model to self-report protected_class_flag alongside each claim it
 * writes). access_instructions never goes through that extraction
 * pipeline — it is copied close to verbatim into two email templates
 * (Section 8), not distilled into a claim — so there is no existing
 * Layer-2 self-check to reuse. This file is the narrowly-scoped
 * equivalent: one short, single-purpose model call whose only job is the
 * same self-check question extract-claims.js already asks, asked of this
 * one field instead. Layer 1 (protected-class-terms.js) and the
 * combining logic (content-check.js's checkClaim()) are reused completely
 * unchanged — nothing about the actual detection logic is duplicated.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { checkClaim } = require('../../maintenance-history/lib/content-check');

function client() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  return new Anthropic({ apiKey });
}

// Mirrors extract-claims.js's own self-check paragraph verbatim in spirit
// (same protected-class topic list, same "your own reading of the
// meaning, not just obvious keywords" instruction) — scoped to exactly
// one short field instead of a claim being extracted.
const SELF_CHECK_PROMPT_HEADER = `You are screening ONE short piece of text before it is shown to a property manager and possibly forwarded, by hand, toward a property owner. The text is a maintenance ticket's "access instructions" field — how a vendor should get into the property — written by a tenant, a vendor, or a property manager.

Does this text touch on a legally protected personal topic — race, color, religion, sex, sexual orientation, gender identity, national origin, familial status, disability/health/medical, source of income (incl. Section 8/vouchers), marital status, age, ancestry, genetic information, citizenship/immigration status, or primary language?

An ordinary entry-logistics instruction — "leave the key under the mat," "gate code is 2040," "call ahead, friendly dog inside," "use the side door" — is NOT protected-class content on its own. Only flag if the text itself actually touches one of the topics above (a real example this check exists to catch: "please call ahead, my mother who lives with us needs notice" — familial status/disability).

This is independent of, and in addition to, an automated keyword scan that also runs on this text — flag based on your own reading of the meaning, not just obvious keywords.

Text to screen:
"""
${'{{TEXT}}'}
"""

Return ONLY JSON, no markdown fences, no explanation:
{"protected_class_flag": true|false, "protected_class_category": "short label or null"}`;

/**
 * Layer 2: the model's own judgment on this one field. Returns
 * { modelFlag, modelCategory }. Never throws on a malformed model
 * response — fails CLOSED (flags it) rather than open, since a parse
 * failure here must not silently let unscreened text through.
 */
async function modelSelfCheck(text) {
  const promptText = SELF_CHECK_PROMPT_HEADER.replace('{{TEXT}}', text);

  let response;
  try {
    const anthropic = client();
    response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 512,
      output_config: { effort: 'low' }, // a one-sentence classification, not an extraction — no need for 'medium'/'high' reasoning depth
      messages: [{ role: 'user', content: [{ type: 'text', text: promptText }] }],
    });
  } catch (err) {
    // Fail CLOSED, not open — same reasoning protected-class-terms.js
    // documents for why Layer 1's own list errs toward flagging: a
    // false-positive costs one extra human review of already-unreviewed
    // content; a false negative here means unscreened tenant/vendor free
    // text reaches a PM (and possibly, via the owner draft, a third
    // party) with no check having run at all. Live-confirmed failure
    // mode this actually protects against, not a hypothetical: this
    // build's own test run hit the account's ANTHROPIC_API_KEY usage
    // limit (2026-08-28) — without this catch, that error would have
    // propagated up and either crashed the gather step or (worse, if
    // ever wrapped in a swallow-and-continue at a higher layer) silently
    // skipped the check entirely.
    console.error(`[access-instructions-check] Model call failed — failing closed (treated as flagged): ${err.message}`);
    return { modelFlag: true, modelCategory: 'model_call_failed' };
  }

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) {
    console.error('[access-instructions-check] No text block in model response — failing closed (treated as flagged).');
    return { modelFlag: true, modelCategory: 'model_response_unparseable' };
  }
  const raw = textBlock.text.trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    // SECURITY: never log the raw model response or the source text here
    // — same discipline extract-claims.js's own parse-failure handler
    // documents, for the same reason (this is exactly the unfiltered
    // content the check exists to screen before anything is logged).
    console.error(`[access-instructions-check] JSON parse failed: ${err.message}. Failing closed (treated as flagged).`);
    return { modelFlag: true, modelCategory: 'model_response_unparseable' };
  }
  return {
    modelFlag: !!parsed.protected_class_flag,
    modelCategory: parsed.protected_class_category || null,
  };
}

/**
 * Runs the full two-layer check on one job's access_instructions field
 * and returns the same three-state shape approval_briefings.
 * risk_assessment_status already uses, so a future migration adding the
 * matching access_instructions_* columns (see this build's report to
 * Jarvis — no such column exists yet) can wire this straight through:
 *
 *   status: 'none'      — field was empty/whitespace; nothing to check,
 *                          nothing to hold. Downstream should render
 *                          "No access instructions on this ticket" (a
 *                          different, honest message from the held-state
 *                          one below — this is Section 8's idea #4
 *                          "missing data says so, loudly" applied here).
 *   status: 'cleared'    — both layers passed. `text` carries the
 *                          checked copy, safe to render verbatim.
 *   status: 'held'       — either layer flagged it. `text` is null (per
 *                          the same hard rule risk_assessment_text
 *                          enforces structurally — flagged text must
 *                          never land in a field a template can read),
 *                          `held_category` records why (GOVERNANCE.md
 *                          Rule 9 — the exclusion reason must be
 *                          recorded, not just the fact of exclusion).
 *
 * @param {string|null|undefined} rawText - job.access_instructions, as
 *   returned by Latchel, unmodified.
 * @returns {Promise<{status: 'none'|'cleared'|'held', text: string|null, held_category: string|null, matched_layer: string|null, terms_version: string}>}
 */
async function checkAccessInstructions(rawText) {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text) {
    return { status: 'none', text: null, held_category: null, matched_layer: null, terms_version: null };
  }

  const { modelFlag, modelCategory } = await modelSelfCheck(text);
  // content-screening-tier-redesign-SPEC.md Section 3.2: checkClaim() is
  // now async (Tier B makes a network call for six specific terms) —
  // awaited here, same as every other real call site in the codebase.
  const result = await checkClaim({ claim_text: text, modelFlag, modelCategory });

  if (!result.flagged_protected_class) {
    return { status: 'cleared', text, held_category: null, matched_layer: null, terms_version: result.terms_version };
  }
  return {
    status: 'held',
    text: null, // hard rule: flagged text must never be returned in a form a caller could render
    held_category: result.flagged_category,
    matched_layer: result.matched_layer,
    terms_version: result.terms_version,
  };
}

module.exports = { checkAccessInstructions };
