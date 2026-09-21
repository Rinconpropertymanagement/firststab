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
const { isExcludedRinconManaged } = require('./weighting');
const { MIN_COMPS_FOR_NARROW_RADIUS } = require('./constants');

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

// Plain-English label for each exclusionReason() code (lib/weighting.js),
// written for Claude's benefit (goes straight into the prompt) — needs to
// be unambiguous about the one fact that matters here: this comp
// contributes NOTHING to the computed range.
const EXCLUSION_LABELS = {
  rincon_managed: 'this is a Rincon-managed property, not outside competition — internal reference only, NOT COUNTED in the range',
  property_type_mismatch: `this comp's property type does not match the subject's — NOT COUNTED in the range`,
  size_mismatch: `this comp's bedroom count is too different from the subject's (2+ bedrooms off) — NOT COUNTED in the range`,
};

// c.exclusion_reason is set by the caller (server.js/router.js, POST /run)
// via lib/weighting.js's exclusionReason() — the one shared place this is
// decided, so this function prefers it over re-deriving anything. null
// means the comp contributes weight to the range (an exact match, or a
// partial-credit 1-bedroom-off match) and gets no special callout here.
//
// exclusion_reason is left undefined only when describeComp() is called
// directly without going through server.js/router.js first (e.g. these
// unit tests) — that fallback path re-derives the SAME answer
// isExcludedRinconManaged() would give, so behavior for a caller that
// doesn't pass exclusion_reason is identical to before this reason-string
// concept existed. It only ever covers the Rincon-managed case (the only
// one of the three exclusion checks that doesn't need subjectBedrooms/
// subjectPropertyType to evaluate) — a caller not passing exclusion_reason
// still gets no property-type/size callout, same as before.
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
    c.exclusion_reason
      ? (EXCLUSION_LABELS[c.exclusion_reason] || 'NOT COUNTED in the range')
      // A Rincon-managed comp from a trusted, self-sourced source (e.g.
      // LeadSimple Move-Ins, deliberately built to report Rincon's own
      // confirmed new-tenant leases) IS counted, at full weight, and must
      // never be described as excluded — same distinction
      // exclusionReason()/isExcludedRinconManaged() already make.
      : (c.is_rincon_managed
        ? (isExcludedRinconManaged(c)
          ? 'this is a Rincon-managed property, not outside competition — internal reference only'
          : 'this is a Rincon-managed property, but a real, confirmed new-tenant lease from Rincon\'s own records — counted in the range like any other leased comp, not excluded')
        : null),
  ].filter(Boolean);
  return bits.join(' | ');
}

function buildPrompt({ subject, comps, recommended, raw, subjectEstimatedRent, sourcesUsed }) {
  return `You are writing the analyst commentary for a Rincon Management rent-comp analysis — the same kind of write-up Rincon's team produces by hand today. Write in that style: plain, specific, and grounded in the actual comps given below. Cite specific comps and specific facts about them (price, status, days on market, price cuts, distance) the way a property manager would explain their reasoning to a colleague — not generic real-estate filler.

HARD RULES:
- Only use facts given below. Never invent a number, address, or fact not present in this data.
- Comp data for this analysis came from: ${sourcesUsed.join(', ') || 'none'}.
- A comp's status tells you exactly how much to trust its price:
  - "leased" = a real, confirmed transaction (the strongest signal) — describe it as an actual lease with confidence, not a guess.
  - "active" = a real, current asking price, not yet confirmed by a transaction — describe it as currently available, not as leased.
  - "off_market" = delisted with no way to confirm what actually happened (could have leased, could have simply expired) — describe it as delisted/off-market, never as leased or rented.
- Some comps below are marked "NOT COUNTED in the range" (a different property type than the subject, a bedroom count too far from the subject's, or a Rincon-managed property that isn't real outside competition). These contributed ZERO weight to both the raw and recommended ranges below — they are not weak evidence, they are NO evidence. You may mention one for context (e.g. "nearby but a different property type"), but you must NEVER cite a NOT COUNTED comp as a reason, a floor, a ceiling, support, or justification for either range — doing so would misrepresent numbers that were computed without it. If you're not certain whether a comp counted, check for "NOT COUNTED in the range" in that comp's line below — its absence means the comp DID contribute to the range.
- If there are few comps (fewer than ${MIN_COMPS_FOR_NARROW_RADIUS}) or only one source was used, say so plainly in the rationale and describe the recommendation as a rough/preliminary estimate rather than a confident one. Do not manufacture confidence the data doesn't support.

SUBJECT PROPERTY:
${subject.address} | ${subject.bedrooms}bd/${subject.bathrooms}ba | ${subject.sqft} sqft | ${subject.propertyType}${subject.yearBuilt ? ` | built ${subject.yearBuilt}` : ''} | ${subject.leaseTermMonths}-month lease | ${subject.furnished ? 'furnished' : 'unfurnished'}
${subjectEstimatedRent ? `RentCast's automated rent estimate for the subject: ${fmtMoney(subjectEstimatedRent)}` : 'No automated rent estimate available for the subject.'}

COMPS (${comps.length} total):
${comps.map(describeComp).join('\n')}

COMPUTED NUMBERS (already calculated — explain these, do not recompute or contradict them):
- Raw comp rent range: ${fmtMoney(raw.low)}-${fmtMoney(raw.high)}
- Recommended asking rent range: ${fmtMoney(recommended.low)}-${fmtMoney(recommended.high)}, midpoint ${fmtMoney(recommended.mid)}
  (this range weights comps with a more reliable status more heavily — leased comps count 3x today, active comps 2x, off_market comps 1x)

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
    // Bumped from 4096: real analyses now pull 20-30 comps (RentCast +
    // CRMLS combined), and the prompt asks for a narrative for every comp
    // plus a rationale, all packed into one trailing JSON marker line that
    // parseNarrativeOutput() requires to be complete — 4096 was getting cut
    // off mid-response on real runs. 8192 gives real headroom for today's
    // counts plus room to grow, well under claude-opus-4-8's much larger
    // output ceiling, so this is a safety cap, not a cost target (cost is
    // driven by tokens actually generated either way).
    max_tokens: 8192,
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
