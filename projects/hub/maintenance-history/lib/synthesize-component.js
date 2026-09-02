/**
 * lib/synthesize-component.js
 * Step 5 of the Property Overview build (property-overview-SPEC.md) — the
 * one genuinely new AI step in this feature. Takes already-extracted,
 * already-cited maintenance_claims sentences for ONE component bucket on
 * ONE property and composes them into a short flowing paragraph instead
 * of a bullet list.
 *
 * This does NOT re-read raw tickets, invoices, or PDFs — that already
 * happened once, correctly, in extract-claims.js, with its own "cite a
 * source, say unknown rather than guess" discipline. This step's only job
 * is to compress and order claims that already exist. The model's output
 * must carry the claim_id(s) each sentence is built from — this file only
 * calls the model and parses its answer; it does NOT decide what's
 * trustworthy enough to display. router.js's overview route validates
 * every returned claim_id against the property's real claim set before
 * anything is shown (spec: "if it doesn't [check out], that sentence is
 * dropped rather than shown, the same 'don't show what you can't back up'
 * rule the original extraction used").
 */

const Anthropic = require('@anthropic-ai/sdk');

const SYNTHESIZER_ACTOR_ID = 'maintenance-history-overview-synthesizer';

function client() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  return new Anthropic({ apiKey });
}

const SYNTHESIS_PROMPT_HEADER = `You are compressing already-extracted maintenance-history facts about one system/component of a Southern California rental property into a short, flowing paragraph for a property manager who has never seen this property before ("first day on the job").

You are NOT reading a raw ticket or inventing anything new. Every fact below has already been extracted and cited from real records by a separate process. Your only job is to compress and order these facts into 2-5 short sentences that read naturally, not as a bullet list.

HARD RULES:
1. Do not add any fact, date, name, or outcome that isn't already stated in the facts below. Compression and rephrasing only — never invention.
2. EVERY sentence you write must carry the claim_id(s) of every fact it is built from, in a "claim_ids" array. If a sentence draws on more than one fact, list all of them. Never write a sentence with an empty claim_ids array.
3. Only use claim_id values that appear in the facts below — never invent one.
4. If the facts describe something still unresolved or pending (e.g. an item marked "completed" that a later fact says wasn't actually fixed, or a decision still awaiting approval), say so plainly — don't smooth it over into sounding resolved.
5. Keep it factual and concise — this is a brief, not a narrative.

Return ONLY a JSON object, no markdown fences, no explanation:
{
  "sentences": [
    { "text": "one sentence or short clause", "claim_ids": ["<uuid>", "..."] }
  ]
}

If there is nothing worth composing into a sentence, return { "sentences": [] }.`;

function buildFactsText(claims) {
  return claims
    .map(c => `- [claim_id: ${c.id}] (${c.claim_type}${c.claim_date ? ', ' + c.claim_date : ''}, ticket "${c.ticket_title}") ${c.claim_text}`)
    .join('\n');
}

/**
 * @param {object} params
 * @param {string} params.componentLabel - e.g. "Electrical"
 * @param {string} params.propertyLabel - e.g. "751 Warwick Ave"
 * @param {Array}  params.claims - claim rows: { id, claim_type, claim_text, claim_date, ticket_title }
 * @returns {Promise<{sentences: Array<{text:string, claim_ids:string[]}>, modelVersion: string|null, truncated: boolean}>}
 */
async function synthesizeComponent({ componentLabel, propertyLabel, claims }) {
  if (!claims || claims.length === 0) {
    return { sentences: [], modelVersion: null, truncated: false };
  }

  const anthropic = client();
  const promptText = `${SYNTHESIS_PROMPT_HEADER}\n\nProperty: ${propertyLabel}\nComponent: ${componentLabel}\n\n=== FACTS ===\n${buildFactsText(claims)}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    // This is a compression task over a handful of already-extracted short
    // facts, not deep reasoning over raw documents (contrast
    // extract-claims.js, which reads whole PDFs) — max_tokens/effort are
    // sized down accordingly, not blindly copied from that module.
    max_tokens: 4096,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: [{ type: 'text', text: promptText }] }],
  });

  // Same defensive check extract-claims.js uses, and for the same reason:
  // a response that's all thinking has no text block at all.
  if (response.stop_reason === 'max_tokens') {
    console.error(
      `[synthesize-component] TRUNCATED response (stop_reason=max_tokens) for component "${componentLabel}", property "${propertyLabel}".`
    );
    return { sentences: [], modelVersion: response.model, truncated: true };
  }

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text block in Claude response.');
  const raw = textBlock.text.trim();

  const jsonStart = raw.search(/[{[]/);
  const trimmed = jsonStart > 0 ? raw.slice(jsonStart) : raw;
  const cleaned = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    // SECURITY: same reasoning as extract-claims.js — never log the raw
    // model response here. These facts are drawn from
    // maintenance_claims_decision_safe, so they've already passed the
    // content check, but logging full text on every parse failure is
    // still more than a diagnostic needs.
    console.error(
      `[synthesize-component] JSON parse failed for component "${componentLabel}". Response length: ${raw.length} chars. Error: ${err.message}`
    );
    return { sentences: [], modelVersion: response.model, truncated: false };
  }

  const sentencesRaw = Array.isArray(parsed && parsed.sentences) ? parsed.sentences : [];
  const sentences = sentencesRaw
    .filter(s => s && typeof s.text === 'string' && s.text.trim() && Array.isArray(s.claim_ids) && s.claim_ids.length > 0)
    .map(s => ({ text: s.text.trim(), claim_ids: s.claim_ids.map(String) }));

  return { sentences, modelVersion: response.model, truncated: false };
}

module.exports = { synthesizeComponent, SYNTHESIZER_ACTOR_ID };
