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
const { isExcludedRinconManaged, weightFor } = require('./weighting');
const { MIN_COMPS_FOR_NARROW_RADIUS } = require('./constants');

// Same model this codebase already uses for real narrative writing —
// content-engine's draft.js/revise.js/captions.js/chat.js all use
// claude-opus-4-8. insurance-compliance's extract-policy.js uses
// claude-sonnet-5 instead, but for a different shape of task (structured
// field extraction from a document) — this is closer to draft.js's job:
// write real, specific, grounded prose.
const MODEL = 'claude-opus-4-8';
const MARKER = 'RENTAL_ANALYSIS_OUTPUT:';

// Output cost is per-comp narrative text; input is cheap. So Claude is shown
// EVERY comp (the rationale must reason over the true sample) but is asked to
// write a per-comp narrative for at most this many of them. A run that falls
// back to the 2-mile ceiling can hand this step 100+ comps; at the old
// "narrative for every comp" shape that overran any max_tokens and lost the
// rationale too. 35 is roughly the most comp cards a reader gets through, and
// about half of what one 16000-token response measured as the limit.
const MAX_NARRATED_COMPS = 35;
const MAX_TOKENS = 16000;

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
    `type: ${c.property_type || 'unknown'}`,
    `rent ${fmtMoney(c.monthly_rent)}${c.is_estimated_price ? ' (algorithmic estimate, not a confirmed real price)' : ''}`,
    `status: ${c.listing_status}`,
    c.distance_miles != null ? `${c.distance_miles} mi away` : null,
    // For an off-market comp the number is how long the listing was UP, not how
    // long it has been off the market; two live runs misread "239 days on
    // market" as "sat off-market 239 days", so that line says what it means.
    c.days_on_market != null
      ? (c.listing_status === 'off_market' ? `days listed before it came off the market: ${c.days_on_market}` : `${c.days_on_market} days on market`)
      : null,
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

// Which comps get a written narrative. Only comps that contribute weight to
// the range qualify: the dashboard shows a NOT COUNTED comp as one compact
// address/price/reason row and never renders a narrative for it. Counted
// comps are ranked by how much they matter (status weight, leased first),
// then by distance (nearest first, unknown distance last), then by their
// position, and the top `cap` are kept. Returned in ascending comp order.
function pickNarratedIndexes(comps, cap = MAX_NARRATED_COMPS) {
  return comps
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !c.exclusion_reason && !isExcludedRinconManaged(c))
    .sort((x, y) => {
      const byWeight = weightFor(y.c.listing_status) - weightFor(x.c.listing_status);
      if (byWeight) return byWeight;
      const dx = typeof x.c.distance_miles === 'number' ? x.c.distance_miles : Infinity;
      const dy = typeof y.c.distance_miles === 'number' ? y.c.distance_miles : Infinity;
      if (dx !== dy) return dx < dy ? -1 : 1;
      return x.i - y.i;
    })
    .slice(0, Math.max(0, cap))
    .map(({ i }) => i)
    .sort((x, y) => x - y);
}

// Ground-truth counts about the comp list, computed here so Claude quotes them
// instead of counting 100+ lines itself (live runs: "a couple" for 3 comps,
// "the handful of leases that match the townhouse profile" when none did).
// "Counted" is the same decision pickNarratedIndexes() makes: no
// exclusion_reason and not an excluded Rincon-managed comp. A comp with no
// recorded property type is its own "unknown" bucket, never a guessed type.
const FACT_REASON_LABELS = {
  property_type_mismatch: `property type differs from the subject's`,
  size_mismatch: `bedroom count 2+ off the subject's`,
  rincon_managed: 'Rincon-managed internal reference',
};

// "2378 Channel Dr" or, for a unit, "2378 Channel Dr, Unit 103": the street
// address as the comp line shows it, without city/state/zip.
function shortAddress(c) {
  const parts = String(c.address || '').split(',').map(x => x.trim());
  return parts[1] && /^(unit|apt|apartment|suite|ste|#)/i.test(parts[1]) ? `${parts[0]}, ${parts[1]}` : parts[0];
}

// Lines about WHICH counted comps are lowest/highest, set the raw range, or sit
// above/below the recommended range. Computed here from the same comps and
// figures the prompt shows, so the model never has to scan 100+ lines (or
// guess) to say "the lowest", "pulls the range down" or "sits above the range".
const MAX_FACT_LIST = 15;
function rangeFactLines(counted, recommended, raw) {
  const rented = counted.map(c => ({ c, rent: Number(c.monthly_rent) })).filter(x => Number.isFinite(x.rent) && x.rent > 0);
  const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const at = (list, rent) => list.filter(x => Math.abs(x.rent - rent) < 0.005).map(x => shortAddress(x.c));
  const named = names => (names.length ? names.join('; ') : 'no counted comp has exactly this rent');
  const listed = (list, withStatus) => {
    const shown = list.slice(0, MAX_FACT_LIST).map(x => `${shortAddress(x.c)} ${fmtMoney(x.rent)}${withStatus ? ` (${x.c.listing_status || 'unknown'})` : ''}`);
    return `${list.length}: ${shown.join('; ')}${list.length > MAX_FACT_LIST ? `; and ${list.length - MAX_FACT_LIST} more` : ''}`;
  };
  const lines = [];
  if (rented.length) {
    const lo = Math.min(...rented.map(x => x.rent)), hi = Math.max(...rented.map(x => x.rent));
    lines.push(`- Lowest counted rent: ${fmtMoney(lo)} (${named(at(rented, lo))}). Highest counted rent: ${fmtMoney(hi)} (${named(at(rented, hi))}).`);
  }
  const rawLow = raw ? num(raw.low) : null, rawHigh = raw ? num(raw.high) : null;
  if (rawLow !== null && rawHigh !== null) {
    lines.push(`- Raw range ${fmtMoney(rawLow)}-${fmtMoney(rawHigh)}: the low is set by ${named(at(rented, rawLow))}; the high is set by ${named(at(rented, rawHigh))}.`);
  }
  const recLow = recommended ? num(recommended.low) : null, recHigh = recommended ? num(recommended.high) : null;
  if (recHigh !== null) {
    const above = rented.filter(x => x.rent > recHigh).sort((a, b) => b.rent - a.rent);
    lines.push(`- Counted comps with rent ABOVE the recommended high (${fmtMoney(recHigh)}): ${above.length ? listed(above, true) : 'none'}.`);
  }
  if (recLow !== null) {
    const below = rented.filter(x => x.rent < recLow).sort((a, b) => a.rent - b.rent);
    lines.push(`- Counted comps with rent BELOW the recommended low (${fmtMoney(recLow)}): ${below.length ? listed(below, true) : 'none'}.`);
  }
  const leases = rented.filter(x => x.c.listing_status === 'leased');
  if (leases.length) {
    const lo = Math.min(...leases.map(x => x.rent)), hi = Math.max(...leases.map(x => x.rent));
    lines.push(`- Highest counted LEASE: ${fmtMoney(hi)} (${named(at(leases, hi))}). Lowest counted LEASE: ${fmtMoney(lo)} (${named(at(leases, lo))}).`);
  } else {
    lines.push('- Highest and lowest counted LEASE: none (no counted comp is leased).');
  }
  return lines;
}

// recommended/raw are optional; without them only the count lines are produced.
function compFactsBlock(comps, { recommended, raw } = {}) {
  const tally = (list, keyFn) => {
    const m = new Map();
    for (const x of list) m.set(keyFn(x), (m.get(keyFn(x)) || 0) + 1);
    return m;
  };
  const show = (m, order) => {
    const keys = [...m.keys()].sort((a, b) => {
      const ia = order ? order.indexOf(a) : -1;
      const ib = order ? order.indexOf(b) : -1;
      if (ia !== ib && (ia !== -1 || ib !== -1)) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return m.get(b) - m.get(a) || String(a).localeCompare(String(b));
    });
    return keys.length ? keys.map(k => `${k} ${m.get(k)}`).join(', ') : 'none';
  };
  const reasonOf = c => c.exclusion_reason || (isExcludedRinconManaged(c) ? 'rincon_managed' : null);
  const counted = comps.filter(c => !reasonOf(c));
  const notCounted = comps.filter(c => reasonOf(c));
  const leased = counted.filter(c => c.listing_status === 'leased');
  const typeOf = c => c.property_type || 'unknown';
  return [
    `COMPUTED COMP FACTS (counted by code from the comp lines above; the only figures you may use for any count or makeup statement, and for any statement about which comp is the lowest or highest or sits above or below the range):`,
    `- Total comps: ${comps.length}. Counted in the range: ${counted.length}. NOT COUNTED: ${notCounted.length}.`,
    `- NOT COUNTED by reason: ${show(tally(notCounted, c => FACT_REASON_LABELS[reasonOf(c)] || reasonOf(c)))}.`,
    `- Counted comps by property type: ${show(tally(counted, typeOf))}.`,
    `- Counted comps by status: ${show(tally(counted, c => c.listing_status || 'unknown'), ['leased', 'active', 'off_market'])}.`,
    `- Counted leased comps by property type and bedrooms: ${show(tally(leased, c => `${typeOf(c)} ${c.bedrooms ?? '?'}bd`))}.`,
    `- Counted comps that are also Rincon-managed: ${counted.filter(c => c.is_rincon_managed).length}.`,
    ...(recommended || raw ? rangeFactLines(counted, recommended, raw) : []),
  ].join('\n');
}

// narrateIndexes: which comp numbers Claude should write a narrative for.
// Omitted, it defaults to pickNarratedIndexes(comps) so a direct caller (the
// unit tests) gets the same behavior generateNarrative() uses.
// correction (optional): text appended after the WRITE section when a previous
// rationale was rejected by validateRationale() — see buildCorrection().
function buildPrompt({ subject, comps, recommended, raw, subjectEstimatedRent, sourcesUsed, narrateIndexes, correction }) {
  const narrate = Array.isArray(narrateIndexes) ? narrateIndexes : pickNarratedIndexes(comps);
  const writeSteps = narrate.length
    ? `1. A one-to-two sentence "narrative" for ONLY these comp numbers: ${narrate.join(', ')}. Cite that comp's own specific facts. Refer to the comp by its street address, never by its number (the number only keys the JSON). Every other comp above is context for the rationale only: write no narrative for it.`
    : `1. No per-comp narratives. Leave "comp_narratives" as an empty object {}.`;
  return `You are writing the analyst commentary for a Rincon Management rent-comp analysis — the same kind of write-up Rincon's team produces by hand today. Write in that style: plain, specific, and grounded in the actual comps given below. Cite specific comps and specific facts about them (price, status, days on market, price cuts, distance) the way a property manager would explain their reasoning to a colleague — not generic real-estate filler.

HARD RULES:
- Only use facts given below. Never invent a number, address, or fact not present in this data.
- Comp data for this analysis came from: ${sourcesUsed.join(', ') || 'none'}.
- A comp's status tells you exactly how much to trust its price:
  - "leased" = a real, confirmed transaction (the strongest signal) — describe it as an actual lease with confidence, not a guess.
  - "active" = a real, current asking price, not yet confirmed by a transaction — describe it as currently available, not as leased.
  - "off_market" = delisted with no way to confirm what actually happened (could have leased, could have simply expired) — describe it as delisted/off-market, never as leased or rented.
- Some comps below are marked "NOT COUNTED in the range" (a different property type than the subject, a bedroom count too far from the subject's, or a Rincon-managed property that isn't real outside competition). These contributed ZERO weight to both the raw and recommended ranges below — they are not weak evidence, they are NO evidence. You may mention one for context (e.g. "nearby but a different property type"), but you must NEVER cite a NOT COUNTED comp as a reason, a floor, a ceiling, support, or justification for either range — doing so would misrepresent numbers that were computed without it. If you're not certain whether a comp counted, check for "NOT COUNTED in the range" in that comp's line below — its absence means the comp DID contribute to the range.
- Each comp's line shows its property type as "type: ..." using the stored value (single_family, condo, townhouse, duplex, and so on). State a comp's property type ONLY exactly as given on its own line. "type: unknown" means the type is unknown: never infer or guess it from the address, the bedroom count, the rent, or anything else, and never call an unknown-type comp a townhouse, condo, house, apartment, or any other type.
- Do NOT characterize the makeup of the NOT COUNTED comps as a group (their property types, sizes, bedroom mix, rents, or locations) beyond what is literally stated on each individual line. You may say how many comps were not counted and why (the reason is on each line); any number you give must be exactly right. You may still mention one specific NOT COUNTED comp using only the facts on its own line.
- Never group or compare a comp with other comps as if they matched when its bedroom count or property type differs from theirs. Only describe comps as similar to each other on a trait when their lines actually show the same value for that trait; an unknown type matches nothing. Likewise, never say a comp matches or fits the subject's property type unless its own line shows that same type; an unknown type matches nothing. Do not describe an unknown-type comp as belonging to any type category (for example "townhouse/other").
- Any count of comps you state (counted, NOT COUNTED, Rincon-managed, per reason, and so on) must be exactly right: count the matching lines before stating it. Never use a vague quantifier such as "a couple", "a few", or "several" for a number you can count; state the number.
- Whenever you state a count, or describe the makeup or composition of the evidence (how many comps counted or did not count and why, what property types or statuses the counted comps are, what the leased comps are, how many match the subject's property type or bedroom count), use ONLY the figures in the COMPUTED COMP FACTS block below. Where that block gives a figure, use it exactly instead of counting lines yourself, and never replace it with a vague quantifier such as "handful", "couple", "few", "several", or "vast majority"; say the number. If a count you would like to state is not in that block, leave it out.
- If there are few comps (fewer than ${MIN_COMPS_FOR_NARROW_RADIUS}) or only one source was used, say so plainly in the rationale and describe the recommendation as a rough/preliminary estimate rather than a confident one. Do not manufacture confidence the data doesn't support.
- Refer to every comp ONLY by its street address, in the rationale AND in every per-comp narrative. The "COMP 12" labels at the start of the comp lines exist only so you can key the JSON comp_narratives; never write "COMP 12", "Comp 12", "comp #12", or any other numeric label for a comp anywhere in your output text. The reader's report shows no comp numbers, so a numeric label cannot be understood.
- Describe a comp as setting, anchoring, supporting, or bracketing the LOW or HIGH end of the recommended range ONLY if that comp's own rent is within about $150 of that end's figure in the recommended range given below. Describe a comp as "around", "near", or "at" the top, bottom, or middle of the range ONLY if its rent is actually near that point (within about $150 of that figure). When you are not sure, do not characterize: state the comp's rent and the range figure side by side and let the reader compare.
- Quote dollar figures exactly as they appear in this data: a comp's rent or original price, the subject's estimate, the raw range, or the recommended range and midpoint. Do not average, round, or invent a rent or a range figure. A plain difference between two of those figures (such as "$500 below the midpoint") is fine.
- Days on market is how long the listing was up, never how long it has been off the market. For an off-market comp the line gives "days listed before it came off the market"; never write that such a comp "sat off-market" for that many days.
- Every comp that is not marked NOT COUNTED contributed to the recommended range, including outliers and off-market comps (an off-market comp counts at a lower weight, and a comp far above or below the range still counts). Never say a counted comp is "not used", "carries no weight", "anchors nothing", or "did not lift" or "did not affect" the range; you may say it is unconfirmed (off-market) or an outlier. Only NOT COUNTED comps are outside the math.
- Any statement that a comp is "the lowest" or "the highest", that comps sit above or below the recommended range, or that a comp pulls the range up or down or "anchors" it, must rest only on the lowest/highest, raw-range, above/below-the-range and lease lines of COMPUTED COMP FACTS and on the comp lines. The raw range low and high are the lowest and highest COUNTED rents named there; a comp that is not the one named there is not "the lowest" or "the highest". The recommended low, midpoint and high are the 25th, 50th and 75th percentiles of the counted rents weighted by status, so a counted comp whose rent is above the recommended midpoint can only pull the range up (never "the middle or bottom down"), and a counted comp below the midpoint can only pull it down (never the top up).

SUBJECT PROPERTY:
${subject.address} | ${subject.bedrooms}bd/${subject.bathrooms}ba | ${subject.sqft} sqft | ${subject.propertyType}${subject.yearBuilt ? ` | built ${subject.yearBuilt}` : ''} | ${subject.leaseTermMonths}-month lease | ${subject.furnished ? 'furnished' : 'unfurnished'}
${subjectEstimatedRent ? `RentCast's automated rent estimate for the subject: ${fmtMoney(subjectEstimatedRent)}` : 'No automated rent estimate available for the subject.'}

COMPS (${comps.length} total):
${comps.map(describeComp).join('\n')}

${compFactsBlock(comps, { recommended, raw })}

COMPUTED NUMBERS (already calculated — explain these, do not recompute or contradict them):
- Raw comp rent range: ${fmtMoney(raw.low)}-${fmtMoney(raw.high)}
- Recommended asking rent range: ${fmtMoney(recommended.low)}-${fmtMoney(recommended.high)}, midpoint ${fmtMoney(recommended.mid)}
  (this range weights comps with a more reliable status more heavily — leased comps count 3x today, active comps 2x, off_market comps 1x)

WRITE:
${writeSteps}
2. One "rationale" paragraph (3-6 sentences) explaining why the recommended range is what it is, referencing specific comps by street address only (never by a COMP number). Base it on all ${comps.length} comps listed above, including the ones that get no narrative.
${correction ? `\n${correction}\n` : ''}
Respond with ONLY the one line below (valid JSON, no markdown fences). No reasoning, preamble, or per-comp text before or after it. Keep "rationale" first, then "comp_narratives" keyed by comp number:
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

// A response cut off by max_tokens ends mid-JSON, so parseNarrativeOutput()
// would throw and everything already written would be lost. "rationale" is
// the first key in the marker line, so a cut-off inside comp_narratives still
// leaves it complete. This keeps the complete rationale string and every
// complete "N": "..." narrative, and drops only the half-written one. Returns
// null when no complete rationale exists, which the caller treats as unusable.
const JSON_STRING = '"((?:[^"\\\\]|\\\\.)*)"';

function salvagePartialOutput(text, expectedCompCount) {
  const at = (text || '').search(/RENTAL_ANALYSIS_OUTPUT:/i);
  if (at === -1) return null;
  const body = text.slice(at + MARKER.length);

  const rationaleMatch = body.match(new RegExp(`"rationale"\\s*:\\s*${JSON_STRING}`));
  if (!rationaleMatch) return null;
  let rationale;
  try {
    rationale = JSON.parse(`"${rationaleMatch[1]}"`).trim();
  } catch (e) {
    return null;
  }
  if (!rationale) return null;

  const narrativesByIndex = Array.from({ length: expectedCompCount }, () => null);
  const sectionAt = body.indexOf('"comp_narratives"');
  if (sectionAt !== -1) {
    const entry = new RegExp(`"(\\d+)"\\s*:\\s*${JSON_STRING}`, 'g');
    for (const m of body.slice(sectionAt).matchAll(entry)) {
      const idx = Number(m[1]);
      if (idx >= expectedCompCount) continue;
      try {
        const n = JSON.parse(`"${m[2]}"`).trim();
        if (n) narrativesByIndex[idx] = n;
      } catch (e) {
        // an unparseable single narrative is left null, never guessed
      }
    }
  }
  return { rationale, narrativesByIndex };
}

// Deterministic backstop for the "off_market/active is never leased" rule: a
// live run opened an off_market comp's card with "Leased... off-market 2bd...".
// For any comp whose listing_status is not 'leased', a narrative that claims
// it leased/rented is dropped (null, so the dashboard just shows no narrative)
// rather than shown as a factual error. Checked clause by clause; a claim
// phrase is ignored when something earlier in the same clause negates or
// hedges it ("never confirmed leased", "unclear whether it was leased") or
// makes it about another comp ("COMP 71, which leased at $4,085").
const LEASED_CLAIMS = [
  /^\W*(?:(?:just|recently|newly|already)\s+)?leased\b(?!\s+(?:status|comps?|comparables?)\b)/i,
  /\bleased\s+(?:at|for|to|by|in|on|out)\b/i,
  /\b(?:just|recently|newly|was|were|been|got|already|actually|successfully)\s+(?:leased|rented)\b/i,
  /\brented\s+(?:at|for|to|out)\b/i,
  /\bconfirmed\s+(?:lease|leased)\b/i,
];
const NEGATES_OR_REDIRECTS = /\b(?:not|never|no|unconfirmed|unverified|unclear|unknown|whether|if|cannot|would|may|might|could|possibly|perhaps|unsure|uncertain|without|unable|neither|nor|than|unlike|versus|vs|whereas|which|COMP\s*\d+)\b|n['’]t\b/i;

function claimsLeased(narrative) {
  const clauses = String(narrative).split(/(?:\.{2,}|…|[.;!?]+(?=\s|$))|\s+[—–-]\s+|[—–]/);
  return clauses.some(clause => LEASED_CLAIMS.some(re => {
    const m = clause.match(re);
    return m && !NEGATES_OR_REDIRECTS.test(clause.slice(0, m.index));
  }));
}

function guardLeasedClaims(comps, narrativesByIndex) {
  return narrativesByIndex.map((n, i) => {
    if (!n || (comps[i] && comps[i].listing_status === 'leased') || !claimsLeased(n)) return n;
    console.warn(`[rental-analysis] Dropped the narrative for comp ${i} (${comps[i] ? comps[i].address : 'unknown address'}): it called a comp with status "${comps[i] ? comps[i].listing_status : 'unknown'}" leased.`);
    return null;
  });
}

// A per-comp narrative that uses a numeric comp label ("COMP 63") cannot be
// resolved by the reader, because the report cards show no comp numbers. Same
// fail-safe as guardLeasedClaims(): the narrative is dropped (null, so the card
// simply shows none) rather than shown with a label nobody can follow. Uses the
// same label rule as the rationale gate (findCompLabels(), defined below).
function guardCompLabels(comps, narrativesByIndex) {
  return narrativesByIndex.map((n, i) => {
    if (!n) return n;
    const labels = findCompLabels(n);
    if (!labels.length) return n;
    console.warn(`[rental-analysis] Dropped the narrative for comp ${i} (${comps[i] ? comps[i].address : 'unknown address'}): it used a numeric comp label (${labels.map(l => `"${l}"`).join(', ')}).`);
    return null;
  });
}

// A COUNTED comp contributed to the recommended range (a leave-one-out
// recompute of real runs moved the recommended high by $200 when one
// outlier was removed), so a sentence saying it "carries no weight", "anchors
// nothing", "was not used to lift the range" or "did not affect" it is false.
// Only NOT COUNTED comps are outside the math ("the 72 excluded comps carry no
// weight" is true and is never flagged). The phrase list is deliberately short
// and exact; a phrase is a violation only when the comp it is about is a
// counted one, decided by the street address nearest to the phrase in its
// sentence (a house number followed by the comp's street name). A phrase with
// no address near it in a RATIONALE is left alone (it may be about a group of
// excluded comps); in a per-comp narrative it is about that narrative's own comp.
const NO_WEIGHT = /\b(?:carr(?:y|ies)\s+(?:no|zero)\s+weight|(?:has|have)\s+(?:no|zero)\s+weight|(?:no|zero)\s+weight\s+(?:on|in|for)\b|anchors?\s+nothing|(?:was|were)\s+not\s+used\s+(?:to|in|for)\b|(?:did|does)\s+not\s+(?:lift|raise|move|affect|influence)\b|no\s+(?:effect|impact|influence)\s+on\s+the\s+(?:range|recommend))/gi;

const isCounted = c => !c.exclusion_reason && !isExcludedRinconManaged(c);

// the sentence (or ';'-clause) containing text[idx], as {text, start}
function sentenceAround(text, idx) {
  const boundary = i => {
    const ch = text[i];
    if (ch === ';') return true;
    if (!/[.!?]/.test(ch) || !/\s/.test(text[i + 1] || '')) return false;
    if (!/^[A-Z0-9]/.test(text.slice(i + 1).trimStart())) return false;
    const word = (text.slice(Math.max(0, i - 8), i).match(/([A-Za-z]+)$/) || [])[1];
    return !(word && ABBREVIATED.has(word.toLowerCase()));
  };
  let a = idx;
  while (a > 0 && idx - a < 500 && !boundary(a - 1)) a--;
  let b = idx;
  while (b < text.length - 1 && b - idx < 300 && !boundary(b)) b++;
  return { text: text.slice(a, b + 1), start: a };
}

// -> [{ phrase, address }] for each no-weight phrase whose nearest cited comp is
// a counted comp. ownIndex: the comp a per-comp narrative is about (a phrase with
// no nearer address in it is about that comp); omit it for a rationale.
function findNoWeightClaims(text, comps, ownIndex) {
  const src = String(text || '');
  const out = [];
  for (const m of src.matchAll(NO_WEIGHT)) {
    const win = sentenceAround(src, m.index);
    const phraseAt = m.index - win.start;
    let nearest = null;
    comps.forEach((c, i) => {
      const k = parseKnownAddress(c.address);
      if (!k) return;
      const first = dropDirection(k.words)[0].replace(/[^a-z0-9]/gi, '');
      const nums = [...k.numbers].map(n => n.replace(/[^0-9A-Za-z]/g, ''));
      if (!first || !nums.length) return;
      const re = new RegExp(`\\b(?:${nums.join('|')})\\b[^.;:]{0,30}?\\b${first}`, 'gi');
      for (const hit of win.text.matchAll(re)) {
        const dist = Math.abs(hit.index - phraseAt);
        if (!nearest || dist < nearest.dist) nearest = { dist, c, i };
      }
    });
    const about = nearest ? nearest.c : (ownIndex !== undefined ? comps[ownIndex] : null);
    if (about && isCounted(about)) out.push({ phrase: m[0].replace(/\s+/g, ' '), address: shortAddress(about) });
  }
  return out;
}

// Per-comp narratives are only ever written for counted comps, so a no-weight
// phrase in one is a false statement about the range: dropped (null, with one
// warning), like the leased and comp-label guards.
function guardNoWeightClaims(comps, narrativesByIndex) {
  return narrativesByIndex.map((n, i) => {
    if (!n || !comps[i] || !isCounted(comps[i])) return n;
    const claims = findNoWeightClaims(n, comps, i);
    if (!claims.length) return n;
    console.warn(`[rental-analysis] Dropped the narrative for comp ${i} (${comps[i].address}): it said a counted comp has no effect on the range ("${claims[0].phrase}").`);
    return null;
  });
}

// ── Rationale gate ──────────────────────────────────────────────────────────
// Live runs showed the rationale can be right on counts and types and still
// read wrong: it cited "COMP 63" (the report cards show no comp numbers, so a
// reader cannot resolve it) and could state a rent that is not in the data.
// validateRationale() catches four things in code: a numeric comp label, a
// dollar figure not in the data, a street address that matches no comp, and a
// counted comp described as having no effect on the range.
// It is deliberately not a fact-checker: whether a real rent is described
// fairly ("anchors the low end") is governed by the prompt rules only.

// Rule 1: a numeric comp label. "comp 63", "COMP #63", "comp no. 63", "comp
// number 63" always count. A bare "comp 63" does too, unless the number is
// really something else: a decimal ("a comp 0.4 miles away") or followed by a
// unit ("comp 2 bedrooms"). A plural list ("comps 12 and 14") counts as well.
const COMP_LABEL = /\bcomp\s*(#|no\.?|number)?\s*(\d+)(\.\d)?/gi;
const COMP_LABEL_LIST = /\bcomps\s*#?\s*\d+\s*(?:,|and|&|or|\/)\s*#?\d+/gi;
const NUMBER_UNIT = /^\s*(?:mi\b|miles?\b|bd\b|beds?\b|bedrooms?\b|br\b|ba\b|baths?\b|days?\b|sq\s?ft\b|%|units?\b|years?\b|months?\b)/i;

function findCompLabels(text) {
  const found = [];
  for (const m of text.matchAll(COMP_LABEL)) {
    const explicit = Boolean(m[1]);
    if (!explicit && m[3]) continue;
    if (!explicit && NUMBER_UNIT.test(text.slice(m.index + m[0].length))) continue;
    found.push(m[0].replace(/\s+/g, ' ').trim());
  }
  for (const m of text.matchAll(COMP_LABEL_LIST)) found.push(m[0].replace(/\s+/g, ' ').trim());
  return [...new Set(found)];
}

// Rule 2: dollar figures. Only text written as "$..." counts (a percent or a
// bare count is never a dollar figure); "$3,495", "$3495", "$3,495.00" and
// "$3.5k" all normalize to a number, and the second number of a range written
// "$3,495-4,500" is read as a dollar figure too (only when it has a thousands
// comma or 4+ digits, so "$4,000-4 bedroom" is not).
const DOLLAR = /\$\s*(\d+(?:,\d{3})*(?:\.\d+)?)(\s*[kK]\b)?/g;
const RANGE_TAIL = /\s*(?:-|–|—|to)\s*\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,}(?:\.\d+)?)(\s*[kK]\b)?/y;

function dollarValue(digits, kSuffix) {
  const n = parseFloat(String(digits).replace(/,/g, ''));
  return Number.isFinite(n) ? n * (kSuffix ? 1000 : 1) : null;
}

// -> [{ text, value, band }] in order of appearance, one entry per distinct
// value. band is true for the idiom "$4,000s" ("mid-$4,000s"): a whole
// thousand-dollar band, not a figure.
const BAND_S = /['’]?s\b/y;
function extractDollarFigures(text) {
  const src = String(text || '');
  const found = new Map();
  const add = (shown, value, band) => {
    if (value === null) return;
    const key = `${Math.round(value * 100)}${band ? 'b' : ''}`;
    if (!found.has(key)) found.set(key, { text: shown.trim(), value, band });
  };
  for (const m of src.matchAll(DOLLAR)) {
    let band = false, shown = m[0];
    if (!m[2]) {
      BAND_S.lastIndex = m.index + m[0].length;
      const b = BAND_S.exec(src);
      if (b) { band = true; shown = m[0] + b[0]; }
    }
    add(shown, dollarValue(m[1], m[2]), band);
    RANGE_TAIL.lastIndex = m.index + m[0].length;
    const tail = RANGE_TAIL.exec(src);
    if (tail) add(`$${tail[1]}${tail[2] ? 'k' : ''}`, dollarValue(tail[1], tail[2]), false);
  }
  return [...found.values()];
}

// Rule 3: a street address that is not one of the comp addresses (or the
// subject's). Live runs wrote "435 S Seaward Avenue" for the real "436 S Seaward
// Avenue". The same check must accept every real comp address exactly as it is
// written in the data, and the data is messy: "219-221-225 El Medio St", "127 And
// 145 W Santa Barbara St", "234 238 S Pacific Ave", "116-124 3/4 S Mathews St",
// "201-201 1/2 Eva St-201 1/2 Eva St", "1201 Fuchsia St.-B", "158 Midbury Hill
// Road Newbury Park", "1407 Oak Trail St", "100 St Louis Ave", "O'Neill".
//
// A mention is every house number that leads it (a list joined by - / & "and"
// "to" or a space) followed by capitalized street-name words. It is judged only
// when it looks like an address: its words contain a street type (Ave, Street,
// Dr, ...) after the first word, or its first word is the first word of a street
// in the data. So "21 Counted", "3 Rincon-managed" and "9 Townhouses", "$4,000",
// "3bd", "1424 sqft", "239 days" and "0.26 mi" are never judged.
//
// Street words are compared as a PREFIX of the street in the data, with the
// leading N/S/E/W dropped, apostrophes and accents ignored, and any two street
// types counted as equal (Ave = Avenue = Street): "Oak Trail" and "Oak Trail St"
// both match "1407 Oak Trail St", and "158 Midbury Hill Road" matches the
// data's "Midbury Hill Road Newbury Park". The mention's trailing capitalized
// words after a street type are ignored ("Hoover Ave. The next sentence").
// Every house number in a mention must appear on a comp on that street, so
// "263/264 N Dos Caminos Ave" passes when 263 and 264 are both real comps there,
// while a wrong number, an invented street, and a real number on the wrong
// street are all flagged.
const STREET_CANON = { avenue: 'ave', av: 'ave', street: 'st', drive: 'dr', lane: 'ln', boulevard: 'blvd', court: 'ct', road: 'rd', place: 'pl', circle: 'cir', terrace: 'ter', terr: 'ter', parkway: 'pkwy', highway: 'hwy', trail: 'trl', alley: 'aly', plaza: 'plz', square: 'sq' };
const STREET_TYPES = new Set(['ave', 'st', 'dr', 'ln', 'blvd', 'ct', 'rd', 'pl', 'cir', 'ter', 'pkwy', 'hwy', 'trl', 'way', 'loop', 'aly', 'plz', 'sq']);
const DIRECTIONS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'north', 'south', 'east', 'west']);
const ABBREVIATED = new Set(['ave', 'av', 'st', 'dr', 'ln', 'blvd', 'ct', 'rd', 'pl', 'cir', 'ter', 'terr', 'pkwy', 'hwy', 'trl', 'aly', 'plz', 'sq', 'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
const UNIT_WORDS = new Set(['unit', 'apt', 'apartment', 'suite', 'ste', 'bldg', 'building', 'space', 'spc']);
const ADDR_NUMBERS = /(?<![\w$.,])(\d{1,6}[A-Z]?(?:(?:\s*[\/&-]\s*|\s+(?:and|And|AND|to)\s+|\s+)\d{1,6}[A-Z]?)*)(?=\s+(?:\p{Lu}|\d{1,3}(?:st|nd|rd|th)\b))/gu;
const ADDR_WORD = /^\s+(\p{Lu}[\p{L}'’]*|\d{1,3}(?:st|nd|rd|th))(\.?)/u;
const STREET_WORD = /\p{L}[\p{L}'’]*|\d{1,3}(?:st|nd|rd|th)\b/gu;

// lowercase, no apostrophes or accents, a spelled-out street type -> its abbreviation
function canonWord(w) {
  const x = String(w).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’]s$/i, '').replace(/['’‘`]/g, '').toLowerCase();
  return STREET_CANON[x] || x;
}
const isType = w => STREET_TYPES.has(w);
function dropDirection(words) {
  return words.length >= 2 && DIRECTIONS.has(words[0]) ? words.slice(1) : words;
}

// How many leading words of the mention match the street in the data (two
// street types match each other), or 0.
function matchedWords(mention, known) {
  const m = dropDirection(mention), k = dropDirection(known);
  let n = 0;
  while (n < m.length && n < k.length && (m[n] === k[n] || (n > 0 && isType(m[n]) && isType(k[n])))) n++;
  return { n, m, k };
}
function streetCompatible(mention, known) {
  const { n, m, k } = matchedWords(mention, known);
  return n >= 1 && (n === m.length || n === k.length || (n >= 2 && isType(m[n - 1])));
}

// -> [{ shown, numbers: ['2585','2587'], words: ['warbler','ave'], streetShaped }]
function extractAddressMentions(text) {
  const out = [];
  const src = String(text || '');
  for (const m of src.matchAll(ADDR_NUMBERS)) {
    const numbers = m[1].match(/\d+[A-Z]?/g);
    const start = m.index + m[0].length;
    const toks = [];
    let at = start;
    while (toks.length < 8) {
      const t = src.slice(at).match(ADDR_WORD);
      if (!t) break;
      const raw = t[1];
      if (UNIT_WORDS.has(raw.toLowerCase())) break;
      at += t[0].length;
      toks.push({ word: canonWord(raw), raw, end: at, period: t[2] === '.' });
    }
    if (!toks.length) continue;
    const words = toks.map(t => t.word);
    const typeAt = words.findIndex((w, i) => i >= 1 && isType(w));
    // what to show: up to the last street type, or all words; a sentence-ending period is not part of the address
    let lastType = -1;
    words.forEach((w, i) => { if (isType(w)) lastType = i; });
    const last = toks[lastType >= 0 ? lastType : toks.length - 1];
    let shown = src.slice(m.index, last.end).trim();
    if (shown.endsWith('.') && !ABBREVIATED.has(last.raw.toLowerCase().replace(/\.$/, ''))) shown = shown.slice(0, -1);
    out.push({ shown, numbers, words, streetShaped: typeAt !== -1 });
  }
  return out;
}

// One entry per comp line (and the subject): {label, numbers:Set, words}. The
// numbers and words are read from the first comma-separated part of the address
// as written, however odd.
function parseKnownAddress(address) {
  const first = String(address || '').split(',')[0].trim();
  const toks = first.split(/\s+/);
  const numbers = [];
  let i = 0;
  while (i < toks.length) {
    // "23A" is kept as "23A" and also as "23", so a citation without the letter still matches
    if (/^\d+[A-Za-z]?(?:[\/&-]\d+[A-Za-z]?)*$/.test(toks[i])) { for (const n of toks[i].match(/\d+[A-Za-z]?/g)) numbers.push(n, n.replace(/[A-Za-z]$/, '')); i++; continue; }
    if (numbers.length && /^(and|&|to)$/i.test(toks[i]) && i + 1 < toks.length && /^\d/.test(toks[i + 1])) { i++; continue; }
    break;
  }
  if (!numbers.length) return null;
  const words = [];
  for (const tok of toks.slice(i)) {
    if (UNIT_WORDS.has(tok.toLowerCase()) || tok.startsWith('#')) break;
    for (const w of tok.match(STREET_WORD) || []) words.push(canonWord(w));
  }
  return words.length ? { label: first, numbers: new Set(numbers), words } : null;
}
function knownAddresses({ comps, subject }) {
  const list = [];
  const add = a => { const k = parseKnownAddress(a); if (k) list.push(k); };
  (comps || []).forEach(c => add(c.address));
  if (subject) add(subject.address);
  return list;
}

// -> [{ shown, hint: [addresses the data does have on that street] }]
function findBadAddresses(text, input) {
  const known = knownAddresses(input);
  const firstWords = new Set(known.map(k => dropDirection(k.words)[0]));
  const bad = new Map();
  for (const a of extractAddressMentions(text)) {
    const onStreet = known.filter(k => streetCompatible(a.words, k.words));
    if (!a.streetShaped && !firstWords.has(dropDirection(a.words)[0])) continue; // not address-shaped ("3 Rincon-managed")
    if (onStreet.length && a.numbers.every(n => onStreet.some(k => k.numbers.has(n)))) continue;
    const key = `${a.numbers.join('/')}|${dropDirection(a.words).slice(0, 2).join(' ')}`;
    if (!bad.has(key)) bad.set(key, { shown: a.shown, hint: [...new Set(onStreet.map(k => k.label))].slice(0, 3) });
  }
  return [...bad.values()];
}

// The dollar figures the model was actually shown: every comp rent and shown
// original price (read back out of the same comp lines the prompt contains),
// the recommended low/mid/high, the raw low/high, and the subject estimate.
// Built from the data, never from the retry prompt (which quotes the rejected
// figures and would make them look allowed) or from the rule text (whose
// examples are not data).
function allowedDollarFigures({ comps, recommended, raw, subjectEstimatedRent }) {
  const exact = new Set();
  const add = v => {
    const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v);
    if (v !== null && v !== undefined && Number.isFinite(n) && n > 0) exact.add(Math.round(n * 100));
  };
  comps.forEach((c, i) => {
    add(c.monthly_rent);
    if (c.had_price_cut) add(c.original_price);
    for (const f of extractDollarFigures(describeComp(c, i))) add(f.value);
  });
  [recommended && recommended.low, recommended && recommended.mid, recommended && recommended.high,
    raw && raw.low, raw && raw.high, subjectEstimatedRent].forEach(add);
  // A fractional figure ($4,197.50, $2,912.50) may be written as a whole
  // dollar amount, rounded to the nearest dollar or floored.
  const rounded = new Set();
  for (const c of exact) if (c % 100 !== 0) { rounded.add(Math.round(c / 100) * 100); rounded.add(Math.floor(c / 100) * 100); }
  return { exact, rounded, min: exact.size ? Math.min(...exact) : 0 };
}

// A figure passes when it is (a) one of the provided figures, or one rounded to
// the nearest dollar or floored, or (b) a band written "$4,000s" ("mid-$4,000s",
// the thousand band 4,000-4,999; "$4,600s" is the hundred band 4,600-4,699) that
// contains at least one provided figure, or
// (c) arithmetic: below half the lowest provided rent (a "$150 premium" is
// never a rent), or exactly the difference of two provided figures AND below the
// lowest provided rent, so a difference can never stand in for a rent. Anything
// else that looks like a rent (an average, a different rounding, an invented
// range end) is flagged.
function isAllowedFigure(f, allowed) {
  const { exact, rounded, min } = allowed;
  const c = Math.round(f.value * 100);
  const width = f.band ? (f.value % 1000 === 0 ? 100000 : f.value % 100 === 0 ? 10000 : 0) : 0;
  if (width) {
    for (const e of exact) if (e >= c && e < c + width) return true;
    return false;
  }
  if (exact.has(c) || rounded.has(c)) return true;
  if (c < Math.max(25000, Math.round(min / 2))) return true;
  if (c < min) for (const a of exact) if (exact.has(a + c)) return true;
  return false;
}

/**
 * @returns {{ok: boolean, problems: string[], labels: string[], badFigures: string[], badAddresses: string[], badClaims: string[]}}
 *   problems are written for the model: they go straight into the retry prompt.
 */
function validateRationale(rationale, input) {
  const text = String(rationale || '');
  const labels = findCompLabels(text);
  const allowed = allowedDollarFigures(input);
  const badFigures = extractDollarFigures(text).filter(f => !isAllowedFigure(f, allowed)).map(f => f.text);
  const badAddresses = findBadAddresses(text, input);
  const badClaims = findNoWeightClaims(text, input.comps || []);
  const problems = [];
  if (labels.length) {
    problems.push(`it used a numeric COMP label (${labels.map(l => `"${l}"`).join(', ')}); the reader's report shows no comp numbers, so refer to every comp by its street address only`);
  }
  if (badFigures.length) {
    problems.push(`it contained a dollar figure that is not in the data you were given (${badFigures.join(', ')}); use only the provided figures`);
  }
  if (badAddresses.length) {
    const list = badAddresses.map(b => `"${b.shown}"${b.hint.length ? ` (the data has ${b.hint.join('; ')} on that street)` : ' (no comp line has it)'}`).join(', ');
    problems.push(`it mentioned ${badAddresses.length > 1 ? 'addresses that do' : 'an address that does'} not match any comp line in the data: ${list}; write each comp's street address exactly as it appears on its comp line`);
  }
  if (badClaims.length) {
    const list = badClaims.map(b => `"${b.address}" (${b.phrase})`).join(', ');
    problems.push(`it said a counted comp has no effect on the range: ${list}; every comp not marked NOT COUNTED contributed to the recommended range, so do not say it carries no weight, was not used, or anchors nothing (you may call it unconfirmed or an outlier)`);
  }
  return { ok: problems.length === 0, problems, labels, badFigures, badAddresses: badAddresses.map(b => b.shown), badClaims: badClaims.map(b => `${b.address}: ${b.phrase}`) };
}

function buildCorrection(problems, previousRationale) {
  return `CORRECTION REQUIRED: an automated check rejected your previous rationale for this analysis because:
${problems.map(p => `- ${p}`).join('\n')}
The rejected rationale was: ${JSON.stringify(previousRationale)}
Write the rationale again. Refer to comps by street address only (never "COMP 12" or any numeric label), use only dollar figures that appear in the data above (a plain difference such as "$500 below" is fine), and keep every other rule above. Respond with the same single RENTAL_ANALYSIS_OUTPUT line, with "comp_narratives" as an empty object {}.`;
}

// One Claude call asking for narratives on `narrateIndexes` only. Returns
// {result, stopReason, outputTokens}; result is null only when the response
// was cut off by max_tokens before a complete rationale was written (the one
// case worth a retry). Any other problem throws, as before. `correction`
// (optional) is the text from buildCorrection(), for the rationale-only
// re-ask after validateRationale() rejected a rationale.
async function requestNarrative(client, input, narrateIndexes, correction) {
  const { subject, comps, recommended, raw, subjectEstimatedRent, sourcesUsed } = input;
  const response = await client.messages.create({
    model: MODEL,
    // Output is now bounded by MAX_NARRATED_COMPS narratives plus one
    // rationale (and the prompt forbids any text outside the marker line),
    // far under this cap. It stays at 16000 as headroom, well under
    // claude-opus-4-8's much larger output ceiling; cost is driven by tokens
    // actually generated, not by this number.
    max_tokens: MAX_TOKENS,
    messages: [
      { role: 'user', content: buildPrompt({ subject, comps, recommended, raw, subjectEstimatedRent, sourcesUsed, narrateIndexes, correction }) },
    ],
  });
  const stopReason = response.stop_reason || null;
  const outputTokens = response.usage && typeof response.usage.output_tokens === 'number' ? response.usage.output_tokens : null;

  // Same defensive lookup insurance-compliance's extract-policy.js uses —
  // the model can return blocks other than a plain text block first.
  const textBlock = (response.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text block in Claude response.');
  const text = textBlock.text.trim();

  // Only the comps we asked about keep a narrative; anything Claude wrote
  // for another comp is dropped so "no narrative" always means the same thing.
  const wanted = new Set(narrateIndexes);
  const keepWanted = r => ({ ...r, narrativesByIndex: guardNoWeightClaims(comps, guardCompLabels(comps, guardLeasedClaims(comps, r.narrativesByIndex.map((n, i) => (wanted.has(i) ? n : null))))) });

  if (stopReason === 'max_tokens') {
    const salvaged = salvagePartialOutput(text, comps.length);
    return { result: salvaged ? keepWanted(salvaged) : null, stopReason, outputTokens };
  }
  return { result: keepWanted(parseNarrativeOutput(text, comps.length)), stopReason, outputTokens };
}

/**
 * Writes the rationale plus per-comp narratives. The per-comp narratives are
 * best effort, and so, now, is the rationale (see the gate below):
 *  - Claude sees every comp but narrates at most MAX_NARRATED_COMPS of them
 *    (counted comps only, see pickNarratedIndexes()).
 *  - If a response is cut off by max_tokens, whatever is complete is kept
 *    (the rationale, plus any finished narratives).
 *  - If it is cut off before a complete rationale, one retry asks for the
 *    rationale alone (the "max_tokens retry").
 *  - The rationale then goes through validateRationale(): it is rejected if it
 *    uses a numeric COMP label, a dollar figure that is not in the data, a
 *    street address that matches no comp, or says a counted comp has no effect
 *    on the range. A
 *    rejection costs ONE more call (the "rationale retry"), which names what
 *    was wrong and asks for the rationale alone; if that one is rejected too,
 *    or fails in any way, rationale is null. The per-comp narratives from the
 *    first response are kept either way; null is never an error.
 *  Anthropic calls per report: 1 normally; at most 3 (full response, max_tokens
 *  retry, rationale retry); the two retries are independent.
 * The computed numbers never depend on any of this (server.js/router.js
 * compute them first and treat a throw here as non-fatal).
 *
 * @param {object} input
 * @param {{messages: {create: Function}}} [options.client] - injected in tests; defaults to the real Anthropic client
 * @returns {Promise<{rationale: string|null, narrativesByIndex: (string|null)[], meta: object}>}
 *   meta: {narrativesRequested, narrativesWritten, truncated, retried, rationaleRetried, rationaleDropped, rationaleProblems, anthropicCalls, stopReason, outputTokens} (logging only)
 */
async function generateNarrative(input, { client } = {}) {
  const api = client || getClient();
  const { comps } = input;
  const narrateIndexes = pickNarratedIndexes(comps);

  let anthropicCalls = 1;
  const first = await requestNarrative(api, input, narrateIndexes);
  let attempt = first;
  let retried = false;
  if (!first.result) {
    console.warn(`[rental-analysis] Narrative response hit max_tokens before a complete rationale (${comps.length} comps, ${narrateIndexes.length} narratives asked) — retrying once for the rationale alone.`);
    retried = true;
    anthropicCalls++;
    attempt = await requestNarrative(api, input, []);
    if (!attempt.result) {
      throw new Error('Narrative response was cut off by max_tokens twice, with no complete rationale either time.');
    }
  }

  const { narrativesByIndex } = attempt.result;
  let rationale = attempt.result.rationale;

  let rationaleRetried = false;
  let rationaleProblems = [];
  const gate = validateRationale(rationale, input);
  if (!gate.ok) {
    rationaleProblems = gate.problems;
    rationaleRetried = true;
    console.warn(`[rental-analysis] Rationale rejected (${gate.problems.join('; ')}) — asking once for a corrected rationale.`);
    const rejected = rationale;
    rationale = null;
    try {
      anthropicCalls++;
      const second = await requestNarrative(api, input, [], buildCorrection(gate.problems, rejected));
      const secondGate = second.result ? validateRationale(second.result.rationale, input) : null;
      if (secondGate && secondGate.ok) {
        rationale = second.result.rationale;
      } else {
        console.warn(`[rental-analysis] The corrected rationale ${secondGate ? `was rejected too (${secondGate.problems.join('; ')})` : 'was cut off by max_tokens'} — saving the report with no rationale; per-comp narratives and numbers are kept.`);
      }
    } catch (err) {
      console.warn(`[rental-analysis] The rationale retry failed (${err.message}) — saving the report with no rationale; per-comp narratives and numbers are kept.`);
    }
  }

  const narrativesWritten = narrativesByIndex.filter(Boolean).length;
  const truncated = first.stopReason === 'max_tokens';
  if (truncated && !retried) {
    console.warn(`[rental-analysis] Narrative response hit max_tokens; kept ${rationale ? 'the rationale and ' : ''}${narrativesWritten} of ${narrateIndexes.length} requested comp narratives.`);
  }
  return {
    rationale,
    narrativesByIndex,
    meta: {
      narrativesRequested: retried ? 0 : narrateIndexes.length,
      narrativesWritten,
      truncated,
      retried,
      rationaleRetried,
      rationaleDropped: rationale === null,
      rationaleProblems,
      anthropicCalls,
      stopReason: attempt.stopReason,
      outputTokens: attempt.outputTokens,
    },
  };
}

module.exports = {
  generateNarrative,
  buildPrompt,
  parseNarrativeOutput,
  salvagePartialOutput,
  pickNarratedIndexes,
  describeComp,
  compFactsBlock,
  guardLeasedClaims,
  guardCompLabels,
  guardNoWeightClaims,
  findNoWeightClaims,
  validateRationale,
  findBadAddresses,
  extractAddressMentions,
  extractDollarFigures,
  findCompLabels,
  buildCorrection,
  MODEL,
  MAX_NARRATED_COMPS,
  MAX_TOKENS,
};
