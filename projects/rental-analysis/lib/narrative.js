/**
 * lib/narrative.js
 * Generates the analysis rationale + each comp's narrative text via Claude,
 * grounded strictly in the structured comp data already pulled and the
 * numbers already computed (lib/weighting.js) — Claude explains numbers,
 * it never invents them.
 *
 * Structured-output convention matches projects/content-engine/lib/
 * legal-review.js's parseMasonReview(): ask Claude to end its response
 * with one exact marker line of JSON, parse only that line, and throw
 * (never silently guess a fallback) if it's missing or malformed. Same
 * "point at structured output, verify it, never trust it blindly" contract
 * as every other AI-output parser in this codebase.
 */

const Anthropic = require('@anthropic-ai/sdk');

// Same model this codebase already uses for real narrative writing —
// content-engine's draft.js/revise.js/captions.js/chat.js all use
// claude-opus-4-8. insurance-compliance's extract-policy.js uses
// claude-sonnet-5 instead, but for a different shape of task (structured
// field extraction from a document) — this is closer to draft.js's job:
// write real, specific, grounded prose.
const MODEL = 'claude-opus-4-8';
const MARKER = 'RENTAL_ANALYSIS_OUTPUT:';

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'Missing ANTHROPIC_API_KEY. Add it to projects/rental-analysis/.env — see root .env.example.'
    );
  }
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function fmtMoney(n) {
  return n === null || n === undefined ? 'unknown' : `$${Number(n).toLocaleString()}`;
}

function describeComp(c, i) {
  const bits = [
    `COMP ${i}: ${c.address}`,
    `${c.bedrooms ?? '?'}bd/${c.bathrooms ?? '?'}ba`,
    c.sqft ? `${c.sqft} sqft` : null,
    `rent ${fmtMoney(c.monthly_rent)}${c.is_estimated_price ? ' (algorithmic estimate, not a confirmed real price)' : ''}`,
    `status: ${c.listing_status}`,
    c.distance_miles != null ? `${c.distance_miles} mi away` : null,
    c.days_on_market != null ? `${c.days_on_market} days on market` : null,
    c.had_price_cut ? `had a price cut${c.original_price ? ` (from ${fmtMoney(c.original_price)})` : ''}` : null,
    c.is_rincon_managed ? 'this is a Rincon-managed property, not outside competition — internal reference only' : null,
  ].filter(Boolean);
  return bits.join(' | ');
}

function buildPrompt({ subject, comps, recommended, raw, subjectEstimatedRent, sourcesUsed }) {
  return `You are writing the analyst commentary for a Rincon Management rent-comp analysis — the same kind of write-up Rincon's team produces by hand today. Write in that style: plain, specific, and grounded in the actual comps given below. Cite specific comps and specific facts about them (price, status, days on market, price cuts, distance) the way a property manager would explain their reasoning to a colleague — not generic real-estate filler.

HARD RULES:
- Only use facts given below. Never invent a number, address, or fact not present in this data.
- Comp data came from RentCast only today (sources used: ${sourcesUsed.join(', ') || 'none'}). RentCast is not MLS data, and it cannot confirm whether an "off_market" comp actually leased or was simply delisted — never describe an off_market comp as "leased" or "rented." Call it delisted/off-market, and note its price is the last known asking price, not a confirmed transaction.
- If there are few comps (fewer than 4) or only one source was used, say so plainly in the rationale and describe the recommendation as a rough/preliminary estimate rather than a confident one. Do not manufacture confidence the data doesn't support.

SUBJECT PROPERTY:
${subject.address} | ${subject.bedrooms}bd/${subject.bathrooms}ba | ${subject.sqft} sqft | ${subject.propertyType}${subject.yearBuilt ? ` | built ${subject.yearBuilt}` : ''} | ${subject.leaseTermMonths}-month lease | ${subject.furnished ? 'furnished' : 'unfurnished'}
${subjectEstimatedRent ? `RentCast's automated rent estimate for the subject: ${fmtMoney(subjectEstimatedRent)}` : 'No automated rent estimate available for the subject.'}

COMPS (${comps.length} total):
${comps.map(describeComp).join('\n')}

COMPUTED NUMBERS (already calculated — explain these, do not recompute or contradict them):
- Raw comp rent range: ${fmtMoney(raw.low)}-${fmtMoney(raw.high)}
- Recommended asking rent range: ${fmtMoney(recommended.low)}-${fmtMoney(recommended.high)}, midpoint ${fmtMoney(recommended.mid)}
  (this range weights comps with a more reliable status more heavily — only active/off_market are possible today, since RentCast has no confirmed-leased signal; leased comps will count for more once a source that confirms real transactions is live)

WRITE:
1. A one-to-two sentence "narrative" for EACH comp above, in the same order, citing that comp's own specific facts.
2. One "rationale" paragraph (3-6 sentences) explaining why the recommended range is what it is, referencing specific comps by address or number.

End your response with exactly one line in this exact format (valid JSON, no markdown fences, nothing after it):
${MARKER} {"rationale": "...", "comp_narratives": {"0": "...", "1": "..."}}`;
}

function parseNarrativeOutput(text, expectedCompCount) {
  const re = /RENTAL_ANALYSIS_OUTPUT:\s*(\{[\s\S]*\})\s*$/i;
  const match = (text || '').match(re);
  if (!match) {
    throw new Error(
      `Narrative response did not end with the expected "${MARKER}" line. Raw response tail: ${(text || '').slice(-500)}`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (e) {
    throw new Error(`Narrative output line was not valid JSON: ${e.message}`);
  }

  if (typeof parsed.rationale !== 'string' || !parsed.rationale.trim()) {
    throw new Error('Narrative output missing a non-empty "rationale" string.');
  }
  if (typeof parsed.comp_narratives !== 'object' || parsed.comp_narratives === null) {
    throw new Error('Narrative output missing a "comp_narratives" object.');
  }

  const narrativesByIndex = [];
  for (let i = 0; i < expectedCompCount; i++) {
    const n = parsed.comp_narratives[String(i)];
    narrativesByIndex.push(typeof n === 'string' && n.trim() ? n.trim() : null);
  }

  return { rationale: parsed.rationale.trim(), narrativesByIndex };
}

/**
 * @returns {Promise<{rationale: string, narrativesByIndex: (string|null)[]}>}
 */
async function generateNarrative({ subject, comps, recommended, raw, subjectEstimatedRent, sourcesUsed }) {
  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [
      { role: 'user', content: buildPrompt({ subject, comps, recommended, raw, subjectEstimatedRent, sourcesUsed }) },
    ],
  });

  // Same defensive lookup insurance-compliance's extract-policy.js uses —
  // the model can return blocks other than a plain text block first.
  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text block in Claude response.');

  return parseNarrativeOutput(textBlock.text.trim(), comps.length);
}

module.exports = { generateNarrative, buildPrompt, parseNarrativeOutput, describeComp, MODEL };
