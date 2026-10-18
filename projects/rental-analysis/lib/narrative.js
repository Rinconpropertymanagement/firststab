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
const { isExcludedRinconManaged, weightFor, sqftBandFor } = require('./weighting');
const { MIN_COMPS_FOR_NARROW_RADIUS, HEADLINE_MIN_COMPS, SQFT_BAND_PCT } = require('./constants');

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

// ── Limits on the text the checks will read ──────────────────────────────────
// The checks below are regular expressions run over text a model wrote, and that text can be steered by what
// someone typed into the address box. A rationale is 3-6 sentences and a per-comp narrative is two or three, so
// anything far longer is refused BEFORE any pattern runs (fail closed: it is treated as rejected), and every check
// reads at most this much even when it is called directly. That keeps the work bounded however hostile the text is.
const MAX_RATIONALE_CHARS = 8000;
const MAX_NARRATIVE_CHARS = 2000;
const MAX_SENTENCES_CHECKED = 80;   // a rationale never has more; the sentence-by-sentence salvage refuses more
const MAX_MATCHES_READ = 400;       // no loop over regex matches reads more than this many
// A real explanation has a handful of dollar figures. Many more is refused outright (fail closed), so a long run of "$1" can
// never push a real invented figure past the limit on matches read.
const MAX_DOLLAR_SIGNS_RATIONALE = 100;
const MAX_DOLLAR_SIGNS_NARRATIVE = 30;
const countDollarSigns = text => { let n = 0; for (let i = text.indexOf('$'); i !== -1; i = text.indexOf('$', i + 1)) n++; return n; };

const capText = (text, max = MAX_RATIONALE_CHARS) => {
  const s = String(text === null || text === undefined ? '' : text);
  return s.length > max ? s.slice(0, max) : s;
};

// First n items of an iterator (a matchAll() result), so a hostile string cannot make a loop run for ever.
function* firstMatches(iterator, n = MAX_MATCHES_READ) {
  let i = 0;
  for (const item of iterator) {
    if (i++ >= n) return;
    yield item;
  }
}

// Linear-time clean-up every check starts from, so look-alike spellings read as the plain text they imitate: full-width
// digits and "$" ("$３,２００"), zero-width and soft-hyphen characters hidden inside a word or around a dash, the dash
// and non-breaking-space HTML entities, and non-breaking spaces (which count as spaces in \s). Runs of white space are collapsed.
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
const DASH_ENTITY_RE = /&(?:ndash|mdash|minus|#8211|#8212|#8722|#x2013|#x2014|#x2212);/gi;
const SPACE_ENTITY_RE = /&nbsp;|&#160;|&#xa0;/gi;
// Cyrillic letters that look like Latin ones ("с" for "c", "о" for "o"), so a word or a "to" typed with them is read as written
const CYRILLIC_LOOKALIKE = { 'о': 'o', 'а': 'a', 'е': 'e', 'р': 'p', 'с': 'c', 'х': 'x', 'і': 'i', 'у': 'y', 'О': 'O', 'А': 'A', 'Е': 'E', 'Р': 'P', 'С': 'C', 'Х': 'X', 'І': 'I', 'У': 'Y', 'В': 'B', 'К': 'K', 'М': 'M', 'Н': 'H', 'Т': 'T' };
const CYRILLIC_LOOKALIKE_RE = /[оаерсхіуОАЕРСХІУВКМНТ]/g;
const BLOCK_TAG_RE = /<\/?(?:br|p|li|ul|ol|tr|td|th|table|div)\b[^<>]{0,80}>/gi;
const ANY_TAG_RE = /<\/?[A-Za-z][^<>]{0,80}>/g;
function cleanModelText(text, max = MAX_RATIONALE_CHARS) {
  return capText(capText(text, max).normalize('NFKC'), max)
    .replace(ZERO_WIDTH_RE, '')
    .replace(CYRILLIC_LOOKALIKE_RE, ch => CYRILLIC_LOOKALIKE[ch])
    .replace(BLOCK_TAG_RE, ' ')
    .replace(ANY_TAG_RE, '')
    .replace(DASH_ENTITY_RE, ' - ')
    .replace(SPACE_ENTITY_RE, ' ')
    .replace(/\s+/g, ' ');   // every run of spaces, tabs and line breaks becomes one space (no pattern ever has to cope with a long run)
}

// True (with one warning) when a per-comp narrative is too long to be read; the guards then drop it.
function narrativeTooLong(narrative, index, comps) {
  if (String(narrative).length <= MAX_NARRATIVE_CHARS) return false;
  console.warn(`[rental-analysis] Dropped the narrative for comp ${index} (${comps && comps[index] ? comps[index].address : 'unknown address'}): it was longer than ${MAX_NARRATIVE_CHARS} characters.`);
  return true;
}

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
  size_sqft: `this comp's square footage is more than ${SQFT_BAND_PCT}% larger or smaller than the subject's — NOT COUNTED in the range`,
  furnished_mismatch: `this comp's furnished status does not match the subject's (furnished against unfurnished) — NOT COUNTED in the range`,
  short_term_lease: `this comp is a month-to-month, vacation or other short-term lease, unlike the subject's lease — NOT COUNTED in the range`,
  age_restricted: `this comp is in a 55+ community and the subject is not — NOT COUNTED in the range`,
  implausible_rent: `this comp's rent (or its listed size) looks like a data entry mistake for a home like this — NOT COUNTED in the range`,
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
// The property type as words a reader would use ("single-family"), not the stored code ("single_family"): this is what the writer is shown
// on every comp line, in the counts and for the subject, so it does not copy the code into the explanation.
const PROPERTY_TYPE_WORDS = { single_family: 'single-family', manufactured: 'manufactured home' };
const readableType = code => (code ? (PROPERTY_TYPE_WORDS[code] || String(code).replace(/_/g, ' ')) : code);

function describeComp(c, i) {
  const bits = [
    `COMP ${i}: ${c.address}`,
    `${c.bedrooms ?? '?'}bd/${c.bathrooms ?? '?'}ba`,
    c.sqft ? `${c.sqft} sqft` : null,
    `type: ${readableType(c.property_type) || 'unknown'}`,
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
  size_sqft: `square footage more than ${SQFT_BAND_PCT}% off the subject's`,
  furnished_mismatch: `furnished status differs from the subject's`,
  short_term_lease: 'short-term lease',
  age_restricted: '55+ community',
  implausible_rent: 'rent or size looks like a data error',
  rincon_managed: 'Rincon-managed internal reference',
};

// "2378 Channel Dr" or, for a unit, "2378 Channel Dr, Unit 103": the street
// address as the comp line shows it, without city/state/zip.
function shortAddress(c) {
  const parts = String(c.address || '').split(',').map(x => x.trim());
  return parts[1] && /^(unit|apt|apartment|suite|ste|#)/i.test(parts[1]) ? `${parts[0]}, ${parts[1]}` : parts[0];
}

// Lines about WHICH counted comps are the lowest and highest, or sit above or
// below the recommended range, and the confidence label. Computed here from the
// same comps and figures the prompt shows, so the model never has to scan 100+
// lines (or guess) to say "the lowest", "pulls the centre down" or "sits above
// the range". The lowest and highest rents are two SEPARATE facts about two
// comps, never a pair: the only range the model may state is the recommended one.
const MAX_FACT_LIST = 15;
function rangeFactLines(counted, headline, confidence) {
  const rented = counted.map(c => ({ c, rent: Number(c.monthly_rent) })).filter(x => Number.isFinite(x.rent) && x.rent > 0);
  const at = (list, rent) => list.filter(x => Math.abs(x.rent - rent) < 0.005).map(x => shortAddress(x.c));
  const named = names => (names.length ? names.join('; ') : 'no counted comp has exactly this rent');
  const listed = (list, withStatus) => {
    const shown = list.slice(0, MAX_FACT_LIST).map(x => `${shortAddress(x.c)} ${fmtMoney(x.rent)}${withStatus ? ` (${x.c.listing_status || 'unknown'})` : ''}`);
    return `${list.length}: ${shown.join('; ')}${list.length > MAX_FACT_LIST ? `; and ${list.length - MAX_FACT_LIST} more` : ''}`;
  };
  const lines = [];
  if (rented.length) {
    const lo = Math.min(...rented.map(x => x.rent)), hi = Math.max(...rented.map(x => x.rent));
    // two separate lines on purpose: written side by side they invite the model to state them as a span
    lines.push(`- Lowest counted rent: ${fmtMoney(lo)} (${named(at(rented, lo))}).`);
    lines.push(`- Highest counted rent: ${fmtMoney(hi)} (${named(at(rented, hi))}).`);
  }
  if (headline) {
    const above = rented.filter(x => x.rent > headline.high).sort((a, b) => b.rent - a.rent);
    lines.push(`- Counted comps with rent ABOVE the recommended range (above ${fmtMoney(headline.high)}): ${above.length ? listed(above, true) : 'none'}.`);
    const below = rented.filter(x => x.rent < headline.low).sort((a, b) => a.rent - b.rent);
    lines.push(`- Counted comps with rent BELOW the recommended range (below ${fmtMoney(headline.low)}): ${below.length ? listed(below, true) : 'none'}.`);
  } else {
    lines.push(`- No recommended range: only ${counted.length} counted ${counted.length === 1 ? 'comp' : 'comps'} (at least ${HEADLINE_MIN_COMPS} are needed).`);
  }
  const leases = rented.filter(x => x.c.listing_status === 'leased');
  if (leases.length) {
    const lo = Math.min(...leases.map(x => x.rent)), hi = Math.max(...leases.map(x => x.rent));
    lines.push(`- Highest counted LEASE: ${fmtMoney(hi)} (${named(at(leases, hi))}).`);
    lines.push(`- Lowest counted LEASE: ${fmtMoney(lo)} (${named(at(leases, lo))}).`);
  } else {
    lines.push('- Highest and lowest counted LEASE: none (no counted comp is leased).');
  }
  if (confidence && confidence.label) {
    lines.push(`- Confidence in the recommended range: ${confidence.label} (${confidence.reasonText || (confidence.reasons || []).join('; ')}).`);
  }
  return lines;
}

// One line naming the square-footage band that was applied, or nothing when the
// rule does not apply to this subject (a duplex, no square footage, no subject).
function sizeBandFactLine(subject) {
  const band = subject ? sqftBandFor(subject.propertyType, subject.sqft) : null;
  if (!band) return [];
  return [`- Size band: counted comps must be within ${band.pct}% of the subject's ${Number(subject.sqft).toLocaleString()} sq ft (${band.low.toLocaleString()}-${band.high.toLocaleString()} sq ft); a comp with no square footage listed counts as unknown and is not left out for size.`];
}

// headline and confidence are optional; without them (and without a subject)
// only the count lines are produced. headline is the recommended range
// (lib/weighting.js computeHeadlineRange) or null when no range exists.
// subject is optional too: with it (and a property type the size rule covers)
// one line states the square-footage band, so the write-up can say why a
// too-large or too-small home was left out without inventing the numbers.
function compFactsBlock(comps, { headline, confidence, subject, withRange = false } = {}) {
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
  const typeOf = c => readableType(c.property_type) || 'unknown';
  return [
    `COMPUTED COMP FACTS (counted by code from the comp lines above; the only figures you may use for any count or makeup statement, and for any statement about which comp is the lowest or highest or sits above or below the range):`,
    `- Total comps: ${comps.length}. Counted in the range: ${counted.length}. NOT COUNTED: ${notCounted.length}.`,
    `- NOT COUNTED by reason: ${show(tally(notCounted, c => FACT_REASON_LABELS[reasonOf(c)] || reasonOf(c)))}.`,
    `- Counted comps by property type: ${show(tally(counted, typeOf))}.`,
    `- Counted comps by status: ${show(tally(counted, c => c.listing_status || 'unknown'), ['leased', 'active', 'off_market'])}.`,
    `- Counted leased comps by property type and bedrooms: ${show(tally(leased, c => `${typeOf(c)} ${c.bedrooms ?? '?'}bd`))}.`,
    `- Counted comps that are also Rincon-managed: ${counted.filter(c => c.is_rincon_managed).length}.`,
    ...sizeBandFactLine(subject),
    ...(headline || withRange ? rangeFactLines(counted, headline, confidence) : []),
  ].join('\n');
}

// The recommendation as the model is told it: the recommended range, the owner's
// goal and the suggested list price, the stretch price (not given on a
// Low-confidence report), and the label. With no range, it says so and forbids
// inventing one. The old wide computed range is NOT here (Peter's range rule).
function recommendationBlock(headline, confidence) {
  if (!headline) {
    return `THE RECOMMENDATION (already calculated — explain it, do not recompute or contradict it):
- There is NO recommended range and no suggested price for this analysis (fewer than ${HEADLINE_MIN_COMPS} comps counted). Say so plainly and explain why from the counts above. Do not suggest, imply or work out any rent, range or price.
  (counted comps are weighted by their status: leased comps count 3x today, active comps 2x, off_market comps 1x)`;
  }
  const goalWords = { lease_quickly: 'leasing quickly', balanced: 'a balanced approach', maximize_rent: 'maximizing rent' }[headline.goal] || 'a balanced approach';
  return `THE RECOMMENDATION (already calculated — explain it, do not recompute or contradict it):
- Recommended range: ${fmtMoney(headline.low)}-${fmtMoney(headline.high)} per month, exactly $200 wide, centred on the weighted middle of the counted comps. The low end is the "lease quickly" end and the high end is the "hold out for more" end.
- Owner goal: ${goalWords}. Suggested list price: ${fmtMoney(headline.listPrice)}.
${headline.stretchPrice ? `- Stretch price: ${fmtMoney(headline.stretchPrice)}, a single price above the recommended range and not part of it.\n` : ''}${confidence ? `- Confidence: ${confidence.label} (${confidence.reasonText || (confidence.reasons || []).join('; ')}).\n` : ''}  (counted comps are weighted by their status: leased comps count 3x today, active comps 2x, off_market comps 1x)`;
}

// narrateIndexes: which comp numbers Claude should write a narrative for.
// Omitted, it defaults to pickNarratedIndexes(comps) so a direct caller (the
// unit tests) gets the same behavior generateNarrative() uses.
// correction (optional): text appended after the WRITE section when a previous
// rationale was rejected by validateRationale() — see buildCorrection().
function buildPrompt({ subject, comps, headline, confidence, subjectEstimatedRent, sourcesUsed, narrateIndexes, correction }) {
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
- Some comps below are marked "NOT COUNTED in the range" (a different property type than the subject, a bedroom count too far from the subject's, a square footage more than ${SQFT_BAND_PCT}% larger or smaller than the subject's, a furnished status that does not match the subject's, a month-to-month or other short-term lease, a 55+ community when the subject is not in one, or a Rincon-managed property that isn't real outside competition). These contributed ZERO weight to the recommended range below — they are not weak evidence, they are NO evidence. You may mention one for context (e.g. "nearby but a different property type"), but you must NEVER cite a NOT COUNTED comp as a reason, a floor, a ceiling, support, or justification for the recommended range — doing so would misrepresent numbers that were computed without it. If you're not certain whether a comp counted, check for "NOT COUNTED in the range" in that comp's line below — its absence means the comp DID contribute to the range.
- Each comp's line shows its property type as "type: ..." using the type as written there (single-family, condo, townhouse, duplex, and so on). State a comp's property type ONLY exactly as given on its own line. "type: unknown" means the type is unknown: never infer or guess it from the address, the bedroom count, the rent, or anything else, and never call an unknown-type comp a townhouse, condo, house, apartment, or any other type.
- Do NOT characterize the makeup of the NOT COUNTED comps as a group (their property types, sizes, bedroom mix, rents, or locations) beyond what is literally stated on each individual line. You may say how many comps were not counted and why (the reason is on each line); any number you give must be exactly right. You may still mention one specific NOT COUNTED comp using only the facts on its own line.
- Never group or compare a comp with other comps as if they matched when its bedroom count or property type differs from theirs. Only describe comps as similar to each other on a trait when their lines actually show the same value for that trait; an unknown type matches nothing. Likewise, never say a comp matches or fits the subject's property type unless its own line shows that same type; an unknown type matches nothing. Do not describe an unknown-type comp as belonging to any type category (for example "townhouse/other").
- Any count of comps you state (counted, NOT COUNTED, Rincon-managed, per reason, and so on) must be exactly right: count the matching lines before stating it. Never use a vague quantifier such as "a couple", "a few", or "several" for a number you can count; state the number.
- Whenever you state a count, or describe the makeup or composition of the evidence (how many comps counted or did not count and why, what property types or statuses the counted comps are, what the leased comps are, how many match the subject's property type or bedroom count), use ONLY the figures in the COMPUTED COMP FACTS block below. Where that block gives a figure, use it exactly instead of counting lines yourself, and never replace it with a vague quantifier such as "handful", "couple", "few", "several", or "vast majority"; say the number. If a count you would like to state is not in that block, leave it out.
- If there are few comps (fewer than ${MIN_COMPS_FOR_NARROW_RADIUS}) or only one source was used, say so plainly in the rationale. Do not manufacture confidence the data doesn't support.
- Refer to every comp ONLY by its street address, in the rationale AND in every per-comp narrative. The "COMP 12" labels at the start of the comp lines exist only so you can key the JSON comp_narratives; never write "COMP 12", "Comp 12", "comp #12", or any other numeric label for a comp anywhere in your output text. The reader's report shows no comp numbers, so a numeric label cannot be understood.
- Describe a comp as setting, anchoring, supporting, or bracketing the LOW or HIGH end of the recommended range ONLY if that comp's own rent is within about $100 of that end of the range given below. Describe a comp as "around", "near", or "at" the top, bottom, or middle of the range, or as near the suggested list price, ONLY if its rent is actually near that point (within about $100 of that figure). When you are not sure, do not characterize: state the comp's rent and the range figure side by side and let the reader compare.
- Quote dollar figures exactly as they appear in this data: a comp's rent or original price, the subject's estimate, the two ends of the recommended range, the suggested list price, or the stretch price. Do not average, round, or invent a rent or a range figure. A plain difference between two of those figures (such as "$500 below the suggested price") is fine.
- The recommended range is exactly $200 wide, and it is the ONLY range you may state. Write it as its two figures together, exactly as given in the recommendation section below. Never write any other pair of dollar figures as a span or range (not a spread between two comps' rents, not a neighboring range, and not a "between ... and ..." pair), and never describe the rents as spread over $500 or more. To mention two comps' rents, name each comp separately with its own address and its own rent. A comp's own price cut (its original price and its current rent) is fine.
- The stretch price, when one is given below, is a single price above the recommended range. It is not part of the range, and nothing in the comps supports it beyond being a fixed step above the range. If you mention it, call it the stretch price and use the fixed words "Above the recommended range; may take longer to lease". Never write it as part of a range, never write a span that ends at it, and never put it in a sentence with the word "range" other than in the words "above the recommended range".
- The owner's goal only chooses the suggested list price inside the range: leasing quickly suggests the low end of the range, a balanced approach suggests the weighted middle of the counted comps, and maximizing rent suggests the high end. You may explain that in plain words, once, without saying anything about time.
- When you explain low confidence, say only that the rents are spread widely. Never give the lowest and the highest rent together, and never state how far apart any two rents are.
- Never give a figure for how far apart rents are: no gap, spread, difference, band or distance in dollars, whether between the lowest and the highest rent, between two comps, or between one comp and the other comps (a distance from the recommended range or from the suggested price is fine, but write it only in the same sentence as that comp's own street address). Do not write "as low as ... as high as", "start at ... top out at", or "the rents differ by". Do not describe the rents as covering a band of dollars.
- Use the word "range" only for the recommended range itself. Never say that a group of comps "ranges", "runs" or "sits" lower, higher, above or below another group of comps or the recommended range (for example "the leased comps range lower"); to compare, name individual comps, each with its own address and its own rent.
- Say nothing about how long leasing will take. Never state a number of days, weeks or months that leasing takes or will take, and never give a chance, odds, probability or likelihood of leasing. (A comp's own days on market is a fact about that one comp; you may give it when you name that comp.)
- Days on market is how long the listing was up, never how long it has been off the market. For an off-market comp the line gives "days listed before it came off the market"; never write that such a comp "sat off-market" for that many days.
- Every comp that is not marked NOT COUNTED contributed to the recommended range, including outliers and off-market comps (an off-market comp counts at a lower weight, and a comp far above or below the range still counts). Never say a counted comp is "not used", "carries no weight", "anchors nothing", or "did not lift" or "did not affect" the range; you may say it is unconfirmed (off-market) or an outlier. Only NOT COUNTED comps are outside the math.
- Any statement that a comp is "the lowest" or "the highest", that comps sit above or below the recommended range, or that a comp pulls the range up or down or "anchors" it, must rest only on the lowest/highest, above/below-the-recommended-range and lease lines of COMPUTED COMP FACTS and on the comp lines. The lowest and highest counted rents are the ones named there; a comp that is not the one named there is not "the lowest" or "the highest". The recommended range is centred on the weighted middle of the counted rents, so a counted comp priced above the recommended range can only pull the centre of the range up (never down), and a counted comp priced below it can only pull the centre down (never up).

SUBJECT PROPERTY:
${subject.address} | ${subject.bedrooms}bd/${subject.bathrooms}ba | ${subject.sqft} sqft | ${readableType(subject.propertyType)}${subject.yearBuilt ? ` | built ${subject.yearBuilt}` : ''} | ${subject.leaseTermMonths}-month lease | ${subject.furnished ? 'furnished' : 'unfurnished'}
${subjectEstimatedRent ? `RentCast's automated rent estimate for the subject: ${fmtMoney(subjectEstimatedRent)}` : 'No automated rent estimate available for the subject.'}

COMPS (${comps.length} total):
${comps.map(describeComp).join('\n')}

${compFactsBlock(comps, { headline, confidence, subject, withRange: true })}

${recommendationBlock(headline, confidence)}

WRITE:
${writeSteps}
2. One "rationale" paragraph (3-6 sentences) explaining ${headline ? 'why the recommended range is what it is' : 'why there is no recommended range'}, referencing specific comps by street address only (never by a COMP number). Base it on all ${comps.length} comps listed above, including the ones that get no narrative.
${correction ? `\n${correction}\n` : ''}
Respond with ONLY the one line below (valid JSON, no markdown fences). No reasoning, preamble, or per-comp text before or after it. Keep "rationale" first, then "comp_narratives" keyed by comp number:
${MARKER} {"rationale": "...", "comp_narratives": {"0": "...", "1": "..."}}`;
}

function parseNarrativeOutput(text, expectedCompCount) {
  // Read from the LAST marker only, anchored at that one position: a response that repeats the marker thousands of times
  // cannot make the pattern start over and over.
  const whole = String(text || '');
  const markerAt = whole.toLowerCase().lastIndexOf(MARKER.toLowerCase());
  const re = /^RENTAL_ANALYSIS_OUTPUT:\s*(\{[\s\S]*\})\s*$/i;
  const match = markerAt === -1 ? null : whole.slice(markerAt).match(re);
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
  const clauses = cleanModelText(narrative, MAX_NARRATIVE_CHARS).split(/(?:\.{2,}|…|[.;!?]+(?=\s|$))|\s+[—–-]\s+|[—–]/);
  return clauses.some(clause => LEASED_CLAIMS.some(re => {
    const m = clause.match(re);
    return m && !NEGATES_OR_REDIRECTS.test(clause.slice(0, m.index));
  }));
}

function guardLeasedClaims(comps, narrativesByIndex) {
  return narrativesByIndex.map((n, i) => {
    if (n && narrativeTooLong(n, i, comps)) return null;
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
    if (narrativeTooLong(n, i, comps)) return null;
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

const NEXT_IS_CAPITAL = /\s*[A-Z0-9]/y;

// the sentence (or ';'-clause) containing text[idx], as {text, start}
function sentenceAround(text, idx) {
  const boundary = i => {
    const ch = text[i];
    if (ch === ';') return true;
    if (!/[.!?]/.test(ch) || !/\s/.test(text[i + 1] || '')) return false;
    NEXT_IS_CAPITAL.lastIndex = i + 1;
    if (!NEXT_IS_CAPITAL.test(text)) return false;
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
// One pattern per comp, built once (a caller that checks many sentences builds them once and passes them in).
function compPatternsFor(comps) {
  const compPatterns = [];
  (comps || []).forEach((c, i) => {
    const k = parseKnownAddress(c.address);
    if (!k) return;
    const first = dropDirection(k.words)[0].replace(/[^a-z0-9]/gi, '');
    const nums = [...k.numbers].map(n => n.replace(/[^0-9A-Za-z]/g, ''));
    if (!first || !nums.length) return;
    compPatterns.push({ c, i, re: new RegExp(`\\b(?:${nums.join('|')})\\b[^.;:]{0,30}?\\b${first}`, 'gi') });
  });
  return compPatterns;
}

function findNoWeightClaims(text, comps, ownIndex, compPatterns = compPatternsFor(comps)) {
  const src = cleanModelText(text);
  const out = [];
  for (const m of firstMatches(src.matchAll(NO_WEIGHT), 60)) {
    const win = sentenceAround(src, m.index);
    const phraseAt = m.index - win.start;
    let nearest = null;
    for (const { c, i, re } of compPatterns) {
      for (const hit of win.text.matchAll(re)) {
        const dist = Math.abs(hit.index - phraseAt);
        if (!nearest || dist < nearest.dist) nearest = { dist, c, i };
      }
    }
    const about = nearest ? nearest.c : (ownIndex !== undefined ? (comps || [])[ownIndex] : null);
    if (about && isCounted(about)) out.push({ phrase: m[0].replace(/\s+/g, ' '), address: shortAddress(about) });
  }
  return out;
}

// Per-comp narratives are only ever written for counted comps, so a no-weight
// phrase in one is a false statement about the range: dropped (null, with one
// warning), like the leased and comp-label guards.
function guardNoWeightClaims(comps, narrativesByIndex) {
  return narrativesByIndex.map((n, i) => {
    if (n && narrativeTooLong(n, i, comps)) return null;
    if (!n || !comps[i] || !isCounted(comps[i])) return n;
    const claims = findNoWeightClaims(n, comps, i);
    if (!claims.length) return n;
    console.warn(`[rental-analysis] Dropped the narrative for comp ${i} (${comps[i].address}): it said a counted comp has no effect on the range ("${claims[0].phrase}").`);
    return null;
  });
}

// A per-comp narrative must obey the same range rule as the rationale: no span of
// dollar figures other than the recommended range, no spread said in other words
// (lowest and highest together, "$1,400 above another comp", "a $1,400 band"), nothing
// that ties the stretch price to a range, no chance or odds of leasing, and none of the
// retired names for the range. On top of that, a narrative may only state dollar figures that
// are in the data (its own rent, its price cut, the recommended range), and may not generalise
// about how long leasing takes ("homes like this typically lease within 30 days"). Like the other
// guards it is fail-safe: a narrative that breaks the rule is dropped (null, one
// warning) rather than shown. A narrative may still give its own comp's days on
// market, so the plain days/weeks/months check is not applied to it. (Defined further
// down, next to findWideRangeStatements().)
function guardWideRanges(comps, narrativesByIndex, input) {
  const merged = { ...input, comps };
  // what the data allows is worked out once for all the narratives, not once per narrative
  let allowedOnce = null;
  const allowedFor = () => (allowedOnce = allowedOnce || allowedDollarFigures({ comps, headline: input && input.headline, subjectEstimatedRent: input && input.subjectEstimatedRent }));
  return narrativesByIndex.map((n, i) => {
    if (!n) return n;
    if (narrativeTooLong(n, i, comps)) return null;
    if (countDollarSigns(cleanModelText(n, MAX_NARRATIVE_CHARS)) > MAX_DOLLAR_SIGNS_NARRATIVE) {
      console.warn(`[rental-analysis] Dropped the narrative for comp ${i} (${comps[i] ? comps[i].address : 'unknown address'}): it had more than ${MAX_DOLLAR_SIGNS_NARRATIVE} dollar signs.`);
      return null;
    }
    // the narrative is about ONE comp (comps[i]): a distance from the range or a price is allowed only as that comp's own
    const bad = findWideRangeStatements(n, merged, { narrative: true, allowed: allowedFor(), ownComp: comps[i] });
    if (!bad.length) return n;
    console.warn(`[rental-analysis] Dropped the narrative for comp ${i} (${comps[i] ? comps[i].address : 'unknown address'}): it broke the range rule (${bad[0].kind}: "${bad[0].text}").`);
    return null;
  });
}

// ── Rationale gate ──────────────────────────────────────────────────────────
// Live runs showed the rationale can be right on counts and types and still
// read wrong: it cited "COMP 63" (the report cards show no comp numbers, so a
// reader cannot resolve it) and could state a rent that is not in the data.
// validateRationale() catches these in code: a numeric comp label, a dollar
// figure not in the data, a street address that matches no comp, a counted comp
// described as having no effect on the range, any way of stating a spread of
// $500 or more or a range other than the recommended one, a stretch price tied
// to a range, anything about how long leasing takes or how likely it is, the
// retired word for the range, and a data source named that supplied no comps.
// It is deliberately not a fact-checker: whether a real rent is described
// fairly ("anchors the low end") is governed by the prompt rules only.

// Rule 1: a numeric comp label. "comp 63", "COMP #63", "comp no. 63", "comp
// number 63" always count. A bare "comp 63" does too, unless the number is
// really something else: a decimal ("a comp 0.4 miles away") or followed by a
// unit ("comp 2 bedrooms"). A plural list ("comps 12 and 14") counts as well.
const COMP_LABEL = /\bcomp\s{0,2}(#|no\.?|number)?\s{0,2}(\d+)(\.\d)?/gi;
const COMP_LABEL_LIST = /\bcomps\s{0,2}#?\s{0,2}\d+\s{0,2}(?:,|and|&|or|\/)\s{0,2}#?\d+/gi;
const NUMBER_UNIT = /^\s*(?:mi\b|miles?\b|bd\b|beds?\b|bedrooms?\b|br\b|ba\b|baths?\b|days?\b|sq\s?ft\b|%|units?\b|years?\b|months?\b)/i;

function findCompLabels(rawText) {
  const text = cleanModelText(rawText);
  const found = [];
  for (const m of firstMatches(text.matchAll(COMP_LABEL))) {
    const explicit = Boolean(m[1]);
    if (!explicit && m[3]) continue;
    if (!explicit && NUMBER_UNIT.test(text.slice(m.index + m[0].length))) continue;
    found.push(m[0].replace(/\s+/g, ' ').trim());
  }
  for (const m of firstMatches(text.matchAll(COMP_LABEL_LIST))) found.push(m[0].replace(/\s+/g, ' ').trim());
  return [...new Set(found)];
}

// Rule 2: dollar figures. Only text written as "$..." counts (a percent or a
// bare count is never a dollar figure); "$3,495", "$3495", "$3,495.00" and
// "$3.5k" all normalize to a number, and the second number of a range written
// "$3,495-4,500" is read as a dollar figure too (only when it has a thousands
// comma or 4+ digits, so "$4,000-4 bedroom" is not).
const DOLLAR = /\$\s*(\d+(?:,\d{3}){0,6}(?:\.\d+)?)(\s*[kK]\b)?/g;
// Every dash a writer (or a word processor) might use between two figures: hyphen, hyphen variants, en and em dash, horizontal bar, minus sign.
const DASHES = '-‐‑‒–—―−';
const RANGE_TAIL = new RegExp(`\\s*(?:[${DASHES}]|to)\\s*\\$?\\s*(\\d{1,3}(?:,\\d{3}){1,6}(?:\\.\\d+)?|\\d{4,}(?:\\.\\d+)?)(\\s*[kK]\\b)?`, 'y');

// Money written in ways the dollar-sign patterns do not see is first rewritten as ordinary figures, so every
// rule below treats it the same way:  "$3.4-4.6k" or "$3.4k to 4.6k"  ->  "$3,400-$4,600";
// "thirty-two hundred dollars"  ->  "$3,200".
const K_RANGE_RE = new RegExp(`\\$\\s*(\\d+(?:\\.\\d+)?)(\\s*[kK]\\b)?(\\s*(?:[${DASHES}]|\\bto\\b|\\bthrough\\b)\\s*)\\$?\\s*(\\d+(?:\\.\\d+)?)\\s*[kK]\\b`, 'g');
const WORD_VALUES = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const WORD_NUMBER_TOKEN = `(?:${Object.keys(WORD_VALUES).join('|')}|hundred|thousand|a|an|and|\\d{1,3})`;   // (a digit group counts too: "4 thousand six hundred")
const WORD_MONEY_RE = new RegExp(`\\b(${WORD_NUMBER_TOKEN}(?:[-\\s]+${WORD_NUMBER_TOKEN}){0,11})\\s+dollars?\\b`, 'gi');
const groupDigits = n => Math.round(n).toLocaleString('en-US');
const moneyText = n => `$${groupDigits(n)}`;
// "between 3,200 and 4,600 dollars", "3,200 to 4,600 dollars", "4,600 dollars": figures written with no dollar sign
const PLAIN_AMOUNT = '(\\d{1,3}(?:[,.]\\d{3}){1,6}|\\d{4,6})';
const PLAIN_DOLLARS_PAIR_RE = new RegExp(`(?<![\\d$,.])${PLAIN_AMOUNT}(\\s+and\\s+|\\s*[${DASHES}]\\s*|\\s+to\\s+|\\s+through\\s+)${PLAIN_AMOUNT}\\s+dollars?\\b`, 'gi');
const PLAIN_DOLLARS_RE = new RegExp(`(?<![\\d$,.])${PLAIN_AMOUNT}\\s+dollars?\\b`, 'gi');
// "between 3,200 and 4,600" / "somewhere between 3,200 and 4,600" with no dollar sign (not a size, a distance or a pair of years)
const PLAIN_BETWEEN_RE = new RegExp(`\\bbetween\\s+(?<![\\d$,.])${PLAIN_AMOUNT}\\s+and\\s+${PLAIN_AMOUNT}(?!\\s*(?:sq|square|sf\\b|feet|ft\\b|mi\\b|miles|years?|units|homes|properties|people|bedrooms|beds|baths|%))`, 'gi');
// "$3 200" (a space for the thousands comma) and "$3.200" (a point for it, exactly three digits after)
const SPACED_THOUSANDS_RE = /\$\s?(\d{1,3}) (\d{3})(?![\d,])/g;
const POINT_THOUSANDS_RE = /\$\s?(\d{1,3})\.(\d{3})(?![\d.])/g;
// "$3.2 thousand", "3.2 to 4.6 thousand dollars", "4.6 thousand dollars"
// (not when more number words follow, as in "4 thousand six hundred dollars")
const NUMBER_WORD_NEXT = `(?!\\s+(?:and\\s+)?(?:${Object.keys(WORD_VALUES).join('|')}|hundred)\\b)`;
const THOUSAND_PAIR_RE = new RegExp(`(?<![\\d.])(\\$?\\s?\\d+(?:\\.\\d+)?)\\s*(to|and|through|-)\\s*\\$?\\s?(\\d+(?:\\.\\d+)?)\\s*thousand\\b${NUMBER_WORD_NEXT}(?:\\s+dollars?)?`, 'gi');
const THOUSAND_ONE_RE = new RegExp(`(?<![\\d.])\\$?\\s?(\\d+(?:\\.\\d+)?)\\s*thousand\\b${NUMBER_WORD_NEXT}(?:\\s+dollars?)?`, 'gi');
// "$3,200/mo", "$3,200 per month", "$3,200 a month": the monthly wording after a figure is dropped, so "$3,200 / $4,600" reads as a pair
const MONTHLY_SUFFIX_RE = /(\$\s?\d[\d,]*(?:\.\d+)?(?:\s*[kK]\b)?)\s*(?:\/\s?mo(?:nth)?\b|per\s+month\b|a\s+month\b|monthly\b)/gi;
const plainAmount = a => String(a).replace(/\./g, ',');

// "thirty-two hundred" -> 3200, "four thousand six hundred" -> 4600; null when it is not a figure of a hundred or more.
function wordMoneyValue(phrase) {
  const tokens = String(phrase).toLowerCase().split(/[-\s]+/).filter(Boolean);
  let lead = 0;
  while (lead < tokens.length && (tokens[lead] === 'and' || ((tokens[lead] === 'a' || tokens[lead] === 'an') && !/^(?:hundred|thousand)$/.test(tokens[lead + 1] || '')))) lead++;
  let total = 0, current = 0, scaled = false;
  for (const t of tokens.slice(lead)) {
    if (/^\d+$/.test(t)) current += Number(t);
    else if (t in WORD_VALUES) current += WORD_VALUES[t];
    else if (t === 'hundred') { current = (current || 1) * 100; scaled = true; }
    else if (t === 'thousand') { total += (current || 1) * 1000; current = 0; scaled = true; }
    else if (t === 'a' || t === 'an') current = current || 1;
  }
  return scaled ? { value: total + current, lead: tokens.slice(0, lead).join(' ') } : null;
}

function normalizeMoneyText(text) {
  return cleanModelText(text)
    .replace(THOUSAND_PAIR_RE, (whole, a, joiner, b) => {
      const lo = Number(String(a).replace(/[$\s]/g, ''));
      return `$${groupDigits(lo * 1000)} ${joiner} $${groupDigits(Number(b) * 1000)}`;
    })
    .replace(THOUSAND_ONE_RE, (whole, a) => `$${groupDigits(Number(a) * 1000)}`)
    .replace(WORD_MONEY_RE, (whole, phrase) => {
      const w = wordMoneyValue(phrase);
      return w && w.value >= 100 ? `${w.lead ? `${w.lead} ` : ''}$${groupDigits(w.value)}` : whole;
    })
    .replace(SPACED_THOUSANDS_RE, (whole, a, b) => `$${a},${b}`)
    .replace(POINT_THOUSANDS_RE, (whole, a, b) => `$${a},${b}`)
    .replace(PLAIN_DOLLARS_PAIR_RE, (whole, a, joiner, b) => `$${plainAmount(a)}${joiner}$${plainAmount(b)}`)
    .replace(PLAIN_DOLLARS_RE, (whole, a) => `$${plainAmount(a)}`)
    .replace(PLAIN_BETWEEN_RE, (whole, a, b) => {
      const years = x => /^\d{4}$/.test(x) && Number(x) >= 1800 && Number(x) <= 2100;
      return years(a) && years(b) ? whole : whole.replace(a, `$${plainAmount(a)}`).replace(new RegExp(`${b}$`), `$${plainAmount(b)}`);
    })
    .replace(K_RANGE_RE, (whole, a, aK, joiner, b) => {
      const lo = aK || Number(a) < 100 ? Number(a) * 1000 : Number(a);
      return `$${groupDigits(lo)}${joiner}$${groupDigits(Number(b) * 1000)}`;
    })
    .replace(MONTHLY_SUFFIX_RE, '$1');
}

function dollarValue(digits, kSuffix) {
  const n = parseFloat(String(digits).replace(/,/g, ''));
  return Number.isFinite(n) ? n * (kSuffix ? 1000 : 1) : null;
}

// -> [{ text, value, band }] in order of appearance, one entry per distinct
// value. band is true for the idiom "$4,000s" ("mid-$4,000s"): a whole
// thousand-dollar band, not a figure.
const BAND_S = /['’]?s\b/y;
function extractDollarFigures(text) {
  const src = normalizeMoneyText(text);
  const found = new Map();
  const add = (shown, value, band) => {
    if (value === null) return;
    const key = `${Math.round(value * 100)}${band ? 'b' : ''}`;
    if (!found.has(key)) found.set(key, { text: shown.trim(), value, band });
  };
  for (const m of firstMatches(src.matchAll(DOLLAR))) {
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
const ADDR_NUMBERS = /(?<![\w$.,])(?<!\b(?:Apt|apt|APT|Apartment|apartment|Unit|unit|UNIT|Ste|ste|Suite|suite|Bldg|bldg|Building|building|Space|space|Spc|spc|No|no|NO)\.?\s+)(?<!#\s*)(\d{1,6}[A-Z]?(?:(?:\s*[\/&-]\s*|\s+(?:and|And|AND|to)\s+|\s+)\d{1,6}[A-Z]?){0,7})(?=\s+(?:\p{Lu}|\d{1,3}(?:st|nd|rd|th)\b))/gu;
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
  const src = cleanModelText(text);
  for (const m of firstMatches(src.matchAll(ADDR_NUMBERS))) {
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
    if (/^\d+[A-Za-z]?(?:[\/&-]\d+[A-Za-z]?){0,6}$/.test(toks[i])) { for (const n of toks[i].match(/\d+[A-Za-z]?/g)) numbers.push(n, n.replace(/[A-Za-z]$/, '')); i++; continue; }
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
function findBadAddresses(text, input, known = knownAddresses(input)) {
  const firstWords = new Set(known.map(k => dropDirection(k.words)[0]));
  const bad = new Map();
  for (const a of extractAddressMentions(cleanModelText(text))) {
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
// the two ends of the recommended range, the suggested list price, the stretch
// price (when one was shown), and the subject estimate. The old wide computed
// range is NOT in this list any more: the model is not shown it, so quoting it
// would be a made-up figure. Built from the data, never from the retry prompt
// (which quotes the rejected figures and would make them look allowed) or from
// the rule text (whose examples are not data).
function allowedDollarFigures({ comps, headline, subjectEstimatedRent }) {
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
  [headline && headline.low, headline && headline.high, headline && headline.listPrice, headline && headline.stretchPrice,
    subjectEstimatedRent].forEach(add);
  // A fractional figure ($4,197.50, $2,912.50) may be written as a whole
  // dollar amount, rounded to the nearest dollar or floored.
  const rounded = new Set();
  for (const c of exact) if (c % 100 !== 0) { rounded.add(Math.round(c / 100) * 100); rounded.add(Math.floor(c / 100) * 100); }
  // How far a comp's rent is from the recommended range's ends, the suggested price, the stretch price or RentCast's estimate, and
  // how much a comp's price was cut: a difference that equals that arithmetic EXACTLY is a true statement ("$3,895, about $1,295 above
  // the recommended high of $2,600"), even though it is not below the lowest rent.
  const measuredFrom = [headline && headline.low, headline && headline.high, headline && headline.listPrice, headline && headline.stretchPrice, subjectEstimatedRent]
    .map(Number).filter(v => Number.isFinite(v) && v > 0);
  const distances = new Set();   // |a comp's rent - a range end / the suggested or stretch price / the estimate|
  const cuts = new Set();        // |a price cut's original price - its rent|
  for (const c of comps) {
    const rent = Number(c && c.monthly_rent);
    if (!Number.isFinite(rent) || rent <= 0) continue;
    for (const h of measuredFrom) distances.add(Math.round(Math.abs(rent - h) * 100));
    if (c.had_price_cut && Number(c.original_price) > 0) cuts.add(Math.round(Math.abs(Number(c.original_price) - rent) * 100));
  }
  const differences = new Set([...distances, ...cuts]);
  return { exact, rounded, distances, cuts, differences, measuredFrom, min: exact.size ? Math.min(...exact) : 0 };
}

// What one comp's own distance and price cut can be: used for a per-comp narrative, which is about that comp alone.
function ownDifferencesOf(comp, measuredFrom) {
  const own = new Set();
  const rent = Number(comp && comp.monthly_rent);
  if (!Number.isFinite(rent) || rent <= 0) return own;
  for (const h of measuredFrom) own.add(Math.round(Math.abs(rent - h) * 100));
  if (comp.had_price_cut && Number(comp.original_price) > 0) own.add(Math.round(Math.abs(Number(comp.original_price) - rent) * 100));
  return own;
}

// Everything the checks need to know about one report's data, built ONCE per call (not once per sentence).
function buildCheckContext(input) {
  const comps = (input && input.comps) || [];
  const unitIds = new Set();
  for (const c of comps) for (const m of firstMatches(String(c && c.address || '').matchAll(UNIT_MENTION_RE), 4)) unitIds.add(String(m[1] || m[2]).toLowerCase());
  const compKnown = [];
  for (const c of comps) { const k = parseKnownAddress(c && c.address); if (k) compKnown.push(k); }
  return {
    allowed: allowedDollarFigures({ comps, headline: input && input.headline, subjectEstimatedRent: input && input.subjectEstimatedRent }),
    known: knownAddresses(input || {}),
    compKnown, unitIds,
    compPatterns: compPatternsFor(comps),
  };
}

// Does this sentence name one of the comps in the data: an address (house number and street, as findBadAddresses() reads it) or a
// unit that one of the comps' own addresses has ("Unit 1212", "#500")?
const UNIT_MENTION_RE = /\b(?:Unit|Apt\.?|Apartment|Suite|Ste\.?)\s{0,2}#?([A-Za-z0-9-]{1,6})\b|#\s{0,2}([A-Za-z0-9-]{1,6})\b/gi;
function sentenceNamesAComp(sentence, ctx) {
  for (const a of extractAddressMentions(sentence)) {
    const onStreet = ctx.compKnown.filter(k => streetCompatible(a.words, k.words));
    if (onStreet.length && a.numbers.every(n => onStreet.some(k => k.numbers.has(n)))) return true;
  }
  for (const m of firstMatches(sentence.matchAll(UNIT_MENTION_RE), 8)) if (ctx.unitIds.has(String(m[1] || m[2]).toLowerCase())) return true;
  return false;
}

// A figure of $500 or more that is allowed ONLY as arithmetic (exactly how far some comp's rent is from a range end, a price or the
// estimate, and not a figure in the data or a price cut) must sit in a sentence that names a comp. On a big comp set many round
// hundreds are some comp's distance, so "rents differ by $1,400 depending on the comp" would otherwise pass. -> the figures' text.
function findUnanchoredDistances(text, ctx) {
  const { allowed } = ctx;
  const out = [];
  for (const sentence of sentencesOf(text)) {
    const figures = extractDollarFigures(sentence).filter(f => {
      const c = Math.round(f.value * 100);
      return !f.band && c >= 50000 && !allowed.exact.has(c) && !allowed.rounded.has(c) && !allowed.cuts.has(c) && allowed.distances.has(c);
    });
    if (!figures.length || sentenceNamesAComp(sentence, ctx)) continue;
    for (const f of figures) if (!out.includes(f.text)) out.push(f.text);
  }
  return out;
}

// A figure passes when it is (a) one of the provided figures, or one rounded to
// the nearest dollar or floored, or (b) a band written "$4,000s" ("mid-$4,000s",
// the thousand band 4,000-4,999; "$4,600s" is the hundred band 4,600-4,699) that
// contains at least one provided figure, or
// (c) arithmetic: under $500 (a "$150 premium" is never a rent), or exactly how
// far a comp's rent is from a range end, the suggested or stretch price or RentCast's
// estimate, or how much a price was cut. Anything else that looks like a rent (an
// average, a different rounding, an invented range end, the difference of two comps'
// rents) is flagged.
function isAllowedFigure(f, allowed) {
  const { exact, rounded } = allowed;
  const c = Math.round(f.value * 100);
  const width = f.band ? (f.value % 1000 === 0 ? 100000 : f.value % 100 === 0 ? 10000 : 0) : 0;
  if (width) {
    for (const e of exact) if (e >= c && e < c + width) return true;
    return false;
  }
  if (exact.has(c) || rounded.has(c)) return true;
  if (allowed.differences && allowed.differences.has(c)) return true;
  // Under $500 is arithmetic ("a $150 premium"); $500 or more must be a figure in the data, or exactly how far a comp's rent is from the
  // recommended range's ends, the suggested or stretch price, or RentCast's estimate, or a price cut (the differences above). The
  // difference of two comps' rents is NOT allowed: "rents differ by $1,400" is a spread however it is worked out.
  if (c < 50000) return true;
  return false;
}

// ── Rule 5: spans of dollar figures, the stretch price, time statistics ─────
// (CMA-QUALITY-SPEC.md 4.6.) The recommended range is the ONLY range the write-up
// may state, and it is exactly $200 wide. This finds anything that reads like
// another range, anything that ties the stretch price to a range, anything that
// says how long leasing takes or how likely it is, and the retired word for the range.
//
// A "span" is two dollar figures joined the way people write ranges: "$A-$B",
// "$A to $B", "from $A to $B", "$A through $B", "$A up to $B", "between $A and
// $B". A span passes only when it is exactly the recommended range, or is one
// comp's own price cut (its original price and its rent). Any span whose two
// ends are $500 or more apart is flagged whatever it is made of. Small
// arithmetic ("$100 to $150 more") is not a rent range and is left alone.
const MONEY_SRC = String.raw`\$\s*\d+(?:,\d{3}){0,6}(?:\.\d+)?(?:\s*[kK]\b)?`;
const BARE_MONEY_SRC = String.raw`(?:\d{1,3}(?:,\d{3}){1,6}(?:\.\d+)?|\d{4,}(?:\.\d+)?)(?:\s*[kK]\b)?`;
const SPAN_RE = new RegExp(`(${MONEY_SRC})\\s*(?:[${DASHES}]|\\bto\\b|\\bthrough\\b|\\bup\\s+to\\b)\\s*(${MONEY_SRC}|${BARE_MONEY_SRC})`, 'gi');
const BETWEEN_RE = new RegExp(`\\bbetween\\s+(${MONEY_SRC})\\s+and\\s+(${MONEY_SRC}|${BARE_MONEY_SRC})`, 'gi');
const UP_TO_RE = new RegExp(`\\bup\\s+to\\s+(${MONEY_SRC})`, 'gi');
// Spans with words between the two figures ("from $3,200 at 1556 Bittern Ct up to $4,600 at 2292 Buffalo
// Avenue", "from 1556 Bittern Ct at $3,200 up to 2292 Buffalo Avenue at $4,600", "ranging from ... to ...",
// "between $3,200 at X and $4,600 at Y"). The words allowed between "from" / "between", the figures and the
// "to" are the ones an address or a short description is made of (capitalised words, house numbers, "at",
// "asking", "leased", "the", ...); anything else, a verb for example, ends the span. So "a cut from $5,200 to get
// there, so the $5,000+ asks" is not read as a span from $5,200 to $5,000.
const GAP_TOKEN = String.raw`\(?(?:[A-Z0-9][\w'’#/&-]*|(?:at|for|of|about|around|roughly|nearly|approximately|only|just|asking|rent|rents|rented|price|priced|lease|leased|listed|listing|a|an|the|and|its|with|low|high|lowest|highest|cheapest|priciest|top|bottom|end|up|comp|comps|home|homes|house|unit|mi|miles|away|bd|ba|sqft)\b|(?:St|Ave|Dr|Ln|Rd|Blvd|Ct|Pl|Cir|Ter|Pkwy|Hwy|Trl)\.)\)?,?`;
const GAP = String.raw`(?:\s+${GAP_TOKEN}){0,14}?\s+`;
const GAP0 = String.raw`(?:\s+${GAP_TOKEN}){0,14}?`;
// These patterns are case-sensitive on purpose (the capital letter is what marks an address word), so the
// literal words in them are written out in both cases.
const ci = word => word.replace(/[a-z]/gi, c => `[${c.toLowerCase()}${c.toUpperCase()}]`);
const TO_WORD = `(?:${ci('up')}\\s+${ci('to')}|${ci('to')}|${ci('through')})`;
const FROM_TO_RE = new RegExp(`\\b${ci('from')}\\b${GAP}(${MONEY_SRC})${GAP0}\\s+${TO_WORD}\\b${GAP}(${MONEY_SRC})`, 'g');
const RANGING_RE = new RegExp(`\\b(?:${['range', 'ranges', 'ranged', 'ranging', 'run', 'runs', 'running', 'span', 'spans', 'spread', 'spreads', 'stretch', 'stretches'].map(ci).join('|')})\\b${GAP}(${MONEY_SRC})${GAP0}\\s+${TO_WORD}\\b${GAP}(${MONEY_SRC})`, 'g');
const BETWEEN_GAP_RE = new RegExp(`\\b${ci('between')}\\b${GAP}(${MONEY_SRC})${GAP0}\\s+${ci('and')}\\b${GAP}(${MONEY_SRC})`, 'g');
// "$1,200 apart", "a spread of $1,200", "a gap of about $900", "a $700 difference": how far apart rents are
const APART_RE = new RegExp(`(${MONEY_SRC})\\s+(?:apart|spread|gap|difference)\\b|\\b(?:spread|gap|difference|differential)\\s+(?:of|is|was|between)?\\s*(?:about|roughly|around|nearly|over|almost|some)?\\s*(${MONEY_SRC})`, 'gi');
const PROBABILITY_WORDS = /\b(?:probability|chance|chances|likelihood|odds)\b/i;
const NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|sixty|ninety|a\\s+few|several|a\\s+couple\\s+of';
const TIME_STAT_RE = new RegExp(`\\b(?:\\d+|${NUMBER_WORDS})(?:\\s*-\\s*|\\s+)(?:business\\s+)?(?:days?|weeks?|months?)\\b`, 'i');
// a lease length ("a 12-month lease") and a data period ("the last 6 months") are
// not statements about how long leasing takes
const NOT_A_TIME_STAT = /\b\d+[- ]months?\s+(?:lease|term)s?\b|\b(?:last|past|previous|prior)\s+\d+\s+months?\b/gi;

// ── Spreads written without a "$A to $B" span ────────────────────────────────
// A live re-test wrote thirty realistic sentences that state how far apart the rents are without one of the span
// patterns above ("rents run as low as $3,200 ... and as high as $4,600", "$1,400 above 1556 Bittern Ct", "the
// counted rents differ by $1,400", "a $1,400 band"). Four more rules catch them, none of which touches a
// sentence that only names the recommended range, a price cut, one comp's rent or two comps' rents without
// saying how they compare:
//   1. a sentence with a "low" word AND a "high" word and two rents $500 or more apart (the recommended range's
//      own figures and the subject's estimate do not count as rents here);
//   2. a figure of $500 or more that is not in the data (a difference, so it can only be a spread), written next to a
//      difference word, in a sentence that also talks about the extremes, the other comps, or two comps' rents,
//      unless the difference is measured from the recommended range or a price;
//   3. "a $1,400 band", "$1,400 wide";
//   4. a group of comps said to "range lower" or "run higher".
const LOW_WORD_RE = /\b(?:lowest|cheapest|least\s+expensive|as\s+low\s+as|bottom(?:s|ed|ing)?\s+out|bottoms?\s+at|bottom\s+comp|start(?:s|ed|ing)?\s+(?:at|from|around|near)|floor|low\s+of|smallest|minimum)\b/i;
const HIGH_WORD_RE = /\b(?:highest|priciest|dearest|most\s+expensive|as\s+high\s+as|top(?:s|ped|ping)?\s+out|tops?\s+(?:at|off)|top\s+comp|ceiling|high\s+of|maximum|peaks?\s+at)\b/i;
// "the top of the recommended range", "the low end of our range": about the recommended range, so not an extreme of the rents
const RANGE_END_PHRASE_RE = /\b(?:the\s+)?(?:top|bottom|high\s+end|low\s+end|upper\s+end|lower\s+end|upper|lower)(?:\s+end)?\s+of\s+(?:the|our)\s+(?:recommended\s+)?range\b/gi;
const DIFF_WORD_RE = /\b(?:more\s+than|less\s+than|higher\s+than|lower\s+than|cheaper\s+than|pricier\s+than|above|below|under|over|beyond|apart|gap|spread|difference|differs?|differed|differing|distance|between|vary|varies|varied|varying|variation|margin|swing|separat\w*|band|wide|wider)\b/i;
const EXTREMES_TALK_RE = /\b(?:lowest|highest|cheapest|priciest|dearest|least\s+expensive|most\s+expensive|top\s+comps?|bottom\s+comps?|top\s+(?:rent|end)|bottom\s+(?:rent|end)|(?:other|remaining)\s+comps?|(?:the\s+)?counted\s+(?:comps?|rents?|homes?)|the\s+comps|the\s+rest|each\s+other|one\s+another|extremes?|low\s+to\s+high|bottom\s+to\s+top)\b/i;
// a difference measured from the recommended range or one of the prices ("$1,000 below the recommended range") is allowed
const MEASURED_FROM_PRICE_AFTER_RE = /^\s*(?:or\s+so\s+|a\s+month\s+|per\s+month\s+|\/mo\s+)?(?:(?:more|less|higher|lower|cheaper|pricier)\s+than\s+|above\s+|below\s+|under\s+|over\s+|beyond\s+)(?:(?:the|our|its)\s+)?(?:recommended|suggested|stretch|rentcast|automated|estimate|estimated|list|asking|range|it|that|this)\b/i;
const MEASURED_FROM_PRICE_BEFORE_RE = /(?:recommended|suggested|stretch)\s+(?:range|price|high|low|midpoint|list\s+price)[^$]{0,25}$/i;
const BAND_RE = new RegExp(`(${MONEY_SRC})\\s+(?:band|wide|swing)\\b|\\b(?:band|swing)\\s+of\\s+(?:about\\s+|roughly\\s+|around\\s+)?(${MONEY_SRC})`, 'gi');
const GROUP_CLAIM_RE = /\b(?:range[sd]?|ranging|runs?|running)\s+(?:a\s+bit\s+|somewhat\s+|much\s+|slightly\s+|a\s+little\s+|well\s+)?(?:lower|higher)\b|\brange[sd]?\s+(?:above|below)\b/gi;
// a general statement about how long leasing takes ("homes like this typically lease within 30 days")
const GENERALISING_RE = /\b(?:typically|usually|generally|normally|commonly|often|on\s+average|averag(?:e|es|ing)|tends?\s+to|tend|(?:homes|properties|rentals|comps)\s+like\s+(?:this|these|it)|similar\s+(?:homes|properties|rentals)|most\s+(?:homes|rentals|properties))\b/i;

// ── More ways to say a spread (Round 4) ──────────────────────────────────────
// A comparison dressed as a percentage or a multiple ("44% higher", "nearly double"), "as little as ... as much as",
// "begin at ... end around", "stretch from ... out to", "from $2,500 up to the stretch price", the top comp in one
// sentence and the bottom comp in the next, and (in a per-comp narrative) "$1,400 less than the best comp". Each of them
// needs two comps' rents $500 or more apart in the same sentence (the one for the stretch price needs a figure) so a
// sentence that only names the recommended range, a price cut or one comp is never touched.
// A percentage or multiple used to COMPARE two prices ("44% higher than", "a 30% premium", "nearly double", "three times as
// much"), not a percentage or multiple that is about something else ("the size band percent", "leased comps count 3x").
const PERCENT_OR_MULTIPLE_RE = /\b\d+(?:\.\d+)?\s*(?:%|percent)\s+(?:higher|lower|more|less|cheaper|pricier|above|below|over|under|bigger|larger|premium|discount|markup)\b|\b(?:higher|lower|more|less|above|below|premium|discount|markup|up|down)\s+(?:of\s+|by\s+)?(?:about\s+|roughly\s+|nearly\s+|around\s+|almost\s+)?\d+(?:\.\d+)?\s*(?:%|percent)|\bdouble[sd]?\b|\btwice\b|\btriple[sd]?\b|\b(?:two|three|four|\d+(?:\.\d+)?)\s*(?:x|×|times)\s+(?:the|as|higher|more|cheaper|pricier|than)\b|\bone\s+and\s+a\s+half\b|\bhalf\s+again\b|\b(?:a\s+)?(?:third|quarter|half|fifth)\s+(?:higher|lower|more|less|cheaper|pricier|above|below)\b|\b(?:two|three)\s+(?:thirds|quarters)\b|\b(?:two|three|four|five|ten|\d+)-?fold\b/i;
// ("the high end" / "the low end" on their own mean the ends of the recommended range, so only "the high end of the comps" counts)
const TOP_WORD_RE = /\b(?:at\s+the\s+top|the\s+top|top\s+comps?|highest|priciest|dearest|most\s+expensive|high\s+end\s+of|best\s+comps?|as\s+much\s+as|ends?\s+(?:at|around|near)|expensive\s+end|peaks?|reach(?:es|ed|ing)?|climbs?\s+(?:to|up))\b/i;
const BOTTOM_WORD_RE = /\b(?:at\s+the\s+bottom|the\s+bottom|bottom\s+comps?|lowest|cheapest|least\s+expensive|low\s+end\s+of|as\s+little\s+as|worst\s+comps?|begins?\s+(?:at|around|near)|starts?\s+(?:at|around|near)|cheap\s+end|bottoming|dips?\s+(?:to|down)|falls?\s+(?:to|back)|drops?\s+(?:to|down))\b/i;
const OUT_TO_RE = /\b(?:out\s+to|all\s+the\s+way\s+(?:up\s+)?to)\b/i;
const FROM_WORD_RE = /\bfrom\b/i;
const TO_STRETCH_PRICE_RE = /\b(?:up\s+to|to|through)\s+(?:the\s+)?stretch\s+price\b/i;
const BEST_WORST_COMP_RE = /\b(?:less|more|cheaper|pricier|lower|higher)\s+than\s+(?:the\s+)?(?:best|worst)\s+comps?\b|\b(?:under|below|above|over)\s+(?:the\s+)?(?:best|worst)\s+comps?\b/i;

// Round 5 additions. Extremes talk about rents ("the two extremes", "both ends", "bracket"), a spread written as "a $1,400 range" or
// "moves by $1,400", a low/high pair with labels, a slash pair, time-to-lease wording, and sources the data never came from.
// ("bracket" is about rents unless it is about a single reference point: "bracket that figure", "bracket the center", "bracket the subject";
//  "extremes" is the noun, not "extreme days-on-market")
const EXTREMES_WORD_RE = /\bextremes\b|\bat\s+(?:one|either|the\s+other)\s+extreme\b|\bboth\s+ends\b|\bbracket(?:s|ed|ing)?\b(?!\s+(?:the|our|that|this)\s+(?:recommended\s+|suggested\s+|weighted\s+)?(?:range|figure|price|list|midpoint|center|centre|middle|number|rent|subject|estimate|target|point))/i;
const SPREAD_NOUN_RE = new RegExp(`(${MONEY_SRC})\\s+(?:range|spread|gap)\\b|\\b(?:range|spread|gap)\\s+(?:of|by)\\s+(?:about\\s+|roughly\\s+|around\\s+|nearly\\s+)?(${MONEY_SRC})|\\b(?:moves?|moved|moving|varies|varying|vary|swings?|swung|fluctuates?|differs?|differed|differing|jumps?|jumped|jumping|changes?|changed|changing)\\s+by\\s+(?:about\\s+|roughly\\s+|around\\s+|nearly\\s+|as\\s+much\\s+as\\s+)?(${MONEY_SRC})`, 'gi');
const LABELLED_FIGURE_RE = new RegExp(`\\b(low(?:est)?|high(?:est)?|min(?:imum)?|max(?:imum)?|cheapest|priciest)\\b[\\s|:=,-]{0,6}(?:rent\\s{0,2})?(${MONEY_SRC})`, 'gi');
// a table whose header row names the low and the high and whose next row has the two figures: "| Low | High | | $3,200 | $4,600 |"
const HEADER_PAIR_RE = new RegExp(`\\|\\s*(?:low(?:est)?|min(?:imum)?|high(?:est)?|max(?:imum)?)\\s*\\|\\s*(?:low(?:est)?|min(?:imum)?|high(?:est)?|max(?:imum)?)\\s*\\|[\\s|:-]{0,12}(${MONEY_SRC})[\\s|:-]{0,6}(${MONEY_SRC})`, 'gi');
const SLASH_PAIR_RE = new RegExp(`(${MONEY_SRC})\\s?\\/\\s?(${MONEY_SRC})`, 'g');
const UNIT_AFTER_ADDRESS_RE = /^[\s,]{0,3}(?:Unit|Apt\.?|Apartment|Suite|Ste\.?|#)\s{0,2}#?([A-Za-z0-9-]{1,6})/i;
const AND_SO_ON_UP_TO_RE = /\band\s+so\s+on\s+(?:up\s+)?to\b/i;
const TIME_TO_LEASE_RE = new RegExp(`\\b(?:\\d+|${NUMBER_WORDS})\\s+(?:business\\s+)?(?:days?|weeks?|months?)\\s+to\\s+(?:lease|rent|let|fill|find)\\b|\\b(?:takes?|taking|needs?)\\s+(?:about\\s+|roughly\\s+|around\\s+|only\\s+|just\\s+)?(?:\\d+|${NUMBER_WORDS})\\s+(?:business\\s+)?(?:days?|weeks?|months?)\\s+to\\b`, 'i');
const A_COMP_OWN_PAST_DAYS_RE = /\b(?:took|taken|leased|rented|sat|was|were|had|after|before|cut)\b/i;
const TIME_IN_A_PERIOD_RE = /\b(?:in|within|under|inside|over)\s+(?:a|one|an)\s+(?:month|week|day)s?\b/i;
const TIME_GENERAL_RE = /\b(?:usually|typically|generally|normally|commonly)\s+(?:rents?|leases?|leased|rented)\b/i;
const EXTERNAL_SOURCE_RE = /\b(?:Zillow|Redfin|Trulia|Apartments\.com|Realtor\.com|Craigslist|HotPads|Rent\.com|Zumper|Facebook\s+Marketplace)\b/i;

function moneyValueOf(text) {
  const m = String(text).match(/(\d+(?:,\d{3}){0,6}(?:\.\d+)?)(\s*[kK]\b)?/);
  return m ? dollarValue(m[1], m[2]) : null;
}

// the sentences of a text: split after . ! ? when a capital letter, digit or $ follows, EXCEPT where the full stop is part
// of an address: after an initial ("121 W. Channel Islands Blvd."), after Apt / Ste / No / Mt / Jr / Sr, or after a street
// suffix that a unit follows ("760 W. Hemlock St. Unit 3 asks $2,400."). A cut inside an address would leave half an address
// at the end of one piece and the rest at the start of the next.
const SENTENCE_BOUNDARY_RE = /[.!?] (?=[A-Z0-9$])/g;
const NEVER_ENDS_A_SENTENCE_RE = /(?:^|[\s(])(?:[A-Z]|Apt|Ste|No|Mt|Jr|Sr)\.$/;
const SUFFIX_BEFORE_A_UNIT_RE = /(?:^|[\s(])(?:St|Ave|Blvd|Dr|Ct|Ln|Rd|Pl|Cir|Ter|Pkwy|Hwy|Way|Trl)\.$/;
const UNIT_WORD_NEXT_RE = /^(?:Unit|Apt|Apartment|Ste|Suite|Bldg|Building|Space|Spc|#)\b/;
function sentencesOf(text) {
  const src = cleanModelText(text);   // white space is already one space, so a boundary is a stop and one space
  const pieces = [];
  let start = 0;
  for (const m of src.matchAll(SENTENCE_BOUNDARY_RE)) {
    if (pieces.length > MAX_SENTENCES_CHECKED) break;
    const end = m.index + 1;
    if (m[0][0] === '.') {
      const before = src.slice(Math.max(start, end - 14), end);
      if (NEVER_ENDS_A_SENTENCE_RE.test(before)) continue;
      if (SUFFIX_BEFORE_A_UNIT_RE.test(before) && UNIT_WORD_NEXT_RE.test(src.slice(end + 1, end + 13))) continue;
    }
    pieces.push(src.slice(start, end).trim());
    start = end + 1;
  }
  pieces.push(src.slice(start).trim());
  return pieces.filter(Boolean).slice(0, MAX_SENTENCES_CHECKED + 1);
}

/**
 * @param {string} text - a rationale or one comp narrative
 * @param {{comps?: object[], headline?: object|null, subjectEstimatedRent?: number}} input
 * @param {{narrative?: boolean, allowed?: object, ownComp?: object}} [opts] - narrative: a per-comp narrative may state its own comp's days on market, so the "number of days" check is skipped; allowed: the figures the data allows, when the caller has already worked them out; ownComp: for a per-comp narrative, the comp it is about, so only that comp's own distance from the range (or its price cut) is allowed
 * @returns {{kind: string, text: string}[]} what is wrong; kind is one of span (any way of giving a spread of $500 or more), stretch, time, probability, word, group (a group of comps said to "range lower"), figure (a per-comp narrative with a dollar figure that is not in the data)
 */
function findWideRangeStatements(text, input, { narrative = false, allowed: allowedGiven, ownComp } = {}) {
  const src = normalizeMoneyText(text);
  const comps = (input && input.comps) || [];
  const headline = input && input.headline;
  const found = [];
  const seen = new Set();
  const add = (kind, shown) => { const key = `${kind}|${shown}`; if (!seen.has(key)) { seen.add(key); found.push({ kind, text: shown }); } };

  const allowed = allowedGiven || allowedDollarFigures({ comps, headline, subjectEstimatedRent: input && input.subjectEstimatedRent });
  const sameMoney = (x, y) => Math.round(x * 100) === Math.round(y * 100);
  const isRecommended = (a, b) => !!headline && [a, b].sort((x, y) => x - y).every((v, i) => sameMoney(v, [headline.low, headline.high][i]));
  const isPriceCut = (a, b) => comps.some(c => c.had_price_cut && Number(c.original_price) > 0
    && [a, b].sort((x, y) => x - y).every((v, i) => sameMoney(v, [Number(c.monthly_rent), Number(c.original_price)].sort((x, y) => x - y)[i])));
  const stretch = headline && Number.isFinite(Number(headline.stretchPrice)) ? Number(headline.stretchPrice) : null;
  const rentScale = v => Math.round(v * 100) >= Math.max(25000, Math.round(allowed.min / 2));

  const checkSpan = (shown, aText, bText, after) => {
    const a = moneyValueOf(aText), b = moneyValueOf(bText);
    if (a === null || b === null) return;
    // "$3,700 to 1121 Pittsfield Ln": a bare number followed by a capitalised word is a house number, not a rent
    if (!/\$/.test(bText) && /^\s+[A-Z]/.test(after)) return;
    const shownText = shown.replace(/\s+/g, ' ').trim();
    // a span that ends at the stretch price is wrong whatever its size (a comp's own price cut that happens to
    // end at that figure is the one exception)
    const endsAtStretch = stretch !== null && (sameMoney(a, stretch) || sameMoney(b, stretch)) && !isPriceCut(a, b);
    if (endsAtStretch) add('stretch', shownText);
    if (Math.abs(b - a) >= 500) { add('span', shownText); return; }
    if (!endsAtStretch && rentScale(Math.max(a, b)) && !isRecommended(a, b) && !isPriceCut(a, b)) add('span', shownText);
  };
  for (const m of src.matchAll(SPAN_RE)) checkSpan(m[0], m[1], m[2], src.slice(m.index + m[0].length));
  for (const m of src.matchAll(BETWEEN_RE)) checkSpan(m[0], m[1], m[2], src.slice(m.index + m[0].length));
  for (const re of [FROM_TO_RE, RANGING_RE, BETWEEN_GAP_RE]) {
    for (const m of src.matchAll(re)) checkSpan(m[0], m[1], m[2], '');
  }
  // how far apart rents are: any gap, spread or difference of $500 or more
  for (const m of src.matchAll(APART_RE)) {
    const n = moneyValueOf(m[1] || m[2]);
    if (n !== null && n >= 500) add('span', m[0].replace(/\s+/g, ' ').trim());
  }
  // "a $1,400 band", "$1,400 wide"
  for (const m of src.matchAll(BAND_RE)) {
    const n = moneyValueOf(m[1] || m[2]);
    if (n !== null && n >= 500) add('span', m[0].replace(/\s+/g, ' ').trim());
  }
  // a group of comps said to "range lower" or "run higher" than another group
  for (const m of src.matchAll(GROUP_CLAIM_RE)) add('group', m[0].replace(/\s+/g, ' ').trim());
  if (stretch !== null) {
    for (const m of src.matchAll(UP_TO_RE)) if (sameMoney(moneyValueOf(m[1]), stretch)) add('stretch', m[0].replace(/\s+/g, ' ').trim());
  }

  // What counts as a rent in a sentence for the extremes rules below: not the recommended range's own figures, the
  // prices, or the subject's estimate.
  const headlineCents = new Set([headline && headline.low, headline && headline.high, headline && headline.listPrice, headline && headline.stretchPrice, input && input.subjectEstimatedRent]
    .map(Number).filter(v => Number.isFinite(v) && v > 0).map(v => Math.round(v * 100)));
  // A figure that is one of the recommended range's own numbers is not a rent, UNLESS a comp is priced at that very
  // figure ("as low as $3,400 and as high as $4,400" is a spread when a comp rents for $4,400).
  const compCents = new Set(comps.map(c => Math.round(Number(c && c.monthly_rent) * 100)).filter(v => Number.isFinite(v) && v > 0));
  const rentsIn = sentence => extractDollarFigures(sentence)
    .filter(f => { const c = Math.round(f.value * 100); return !f.band && rentScale(f.value) && (!headlineCents.has(c) || compCents.has(c)); }).map(f => f.value);
  // the distinct figures in a sentence that are some comp's rent
  const compFiguresIn = sentence => [...new Set(extractDollarFigures(sentence).filter(f => !f.band && compCents.has(Math.round(f.value * 100))).map(f => f.value))];
  const isWide = figures => figures.length >= 2 && Math.max(...figures) - Math.min(...figures) >= 500;
  // Round 6: the rents of the COUNTED comps (not the range's own figures, not a price cut's original price, not an excluded comp's rent)
  const countedRentCents = new Set(comps.filter(c => c && isCounted(c)).map(c => Math.round(Number(c.monthly_rent) * 100)).filter(v => Number.isFinite(v) && v > 0));
  const cutOriginalCents = new Set(comps.filter(c => c && c.had_price_cut && Number(c.original_price) > 0).map(c => Math.round(Number(c.original_price) * 100)));
  const isDataFigure = v => allowed.exact.has(Math.round(v * 100)) || allowed.rounded.has(Math.round(v * 100));
  const withoutRangeEnds = sentence => sentence.replace(RANGE_END_PHRASE_RE, ' ');

  // Round 5: a derived spread said as "a $1,400 range", "a spread of $1,400", "moves by $1,400" (a figure of $500 or more that is not in the data)
  for (const m of firstMatches(src.matchAll(SPREAD_NOUN_RE))) {
    const n = moneyValueOf(m[1] || m[2] || m[3]);
    if (n !== null && n >= 500 && !isDataFigure(n) && !headlineCents.has(Math.round(n * 100))) add('span', m[0].replace(/\s+/g, ' ').trim());
  }
  // A low and a high given with labels, in a sentence, a bullet list or a table row ("(low: $3,200; high: $4,600)", "| Lowest | $3,200 |"):
  // $500 or more apart and close to each other in the text.
  const labelled = [];
  for (const m of firstMatches(src.matchAll(LABELLED_FIGURE_RE), 40)) {
    const value = moneyValueOf(m[2]);
    const isBand = /^['’]?s\b/.test(src.slice(m.index + m[0].length));   // "high-$3,000s" is a band, not a figure
    if (value !== null && rentScale(value) && !isBand) labelled.push({ at: m.index, low: /^(?:low|min|cheapest)/i.test(m[1]), value });
  }
  for (const a of labelled) {
    if (!a.low) continue;
    for (const b of labelled) if (!b.low && Math.abs(a.at - b.at) <= 200 && Math.abs(b.value - a.value) >= 500) add('span', `low ${moneyText(a.value)}, high ${moneyText(b.value)}`);
  }
  for (const m of firstMatches(src.matchAll(HEADER_PAIR_RE))) {
    const x = moneyValueOf(m[1]), y = moneyValueOf(m[2]);
    if (x !== null && y !== null && Math.abs(x - y) >= 500) add('span', m[0].replace(/\s+/g, ' ').trim());
  }
  // "$3,200 / $4,600" (with the "/mo" after each figure already taken off)
  for (const m of firstMatches(src.matchAll(SLASH_PAIR_RE))) {
    const x = moneyValueOf(m[1]), y = moneyValueOf(m[2]);
    if (x !== null && y !== null && Math.abs(x - y) >= 500) add('span', m[0].replace(/\s+/g, ' ').trim());
  }
  // a source the data never came from
  const external = src.match(EXTERNAL_SOURCE_RE);
  if (external) add('source', external[0]);

  // If a real comp happens to be priced exactly at the stretch price, a sentence that names that comp (by its
  // address) next to the word "range" is about the comp's rent, not the stretch price, so the sentence check is
  // skipped for such a sentence (the span check above still catches "$X to $stretch").
  const stretchIsACompRent = stretch !== null && comps.some(c => sameMoney(Number(c.monthly_rent), stretch) || (c.had_price_cut && sameMoney(Number(c.original_price), stretch)));
  // (a sentence that already has a span flagged is not listed a second time)
  const alreadyFlagged = sentence => found.some(f => f.kind === 'span' && f.text.length > 0 && sentence.includes(f.text));
  for (const sentence of sentencesOf(src)) {
    if (stretch !== null && !(stretchIsACompRent && extractAddressMentions(sentence).length > 0) && extractDollarFigures(sentence).some(f => sameMoney(f.value, stretch))
      && /\brange\b/i.test(sentence.replace(/above the recommended range/gi, ''))) {
      add('stretch', sentence.slice(0, 160));
    }
    const plain = withoutRangeEnds(sentence);
    // Rule 1: "the lowest is $3,400 and the highest is $4,600", "as low as $3,200 ... as high as $4,600", "start at $3,200
    // and top out at $4,600": two rents presented as the two ends of the rents
    if (LOW_WORD_RE.test(plain) && HIGH_WORD_RE.test(plain)) {
      const values = rentsIn(plain);
      if (values.length >= 2 && Math.max(...values) - Math.min(...values) >= 500) add('span', sentence.slice(0, 160));
    }
    // Rule 2: a difference of $500 or more (a figure that is not in the data) next to a difference word, in a
    // sentence about the extremes, the other comps, or two comps' rents
    const talksAboutExtremes = EXTREMES_TALK_RE.test(plain) || extractAddressMentions(plain).length >= 2 || rentsIn(plain).filter(isDataFigure).length >= 2;
    if (talksAboutExtremes) {
      for (const m of plain.matchAll(DOLLAR)) {
        const value = dollarValue(m[1], m[2]);
        if (value === null || value < 500 || isDataFigure(value) || headlineCents.has(Math.round(value * 100))) continue;
        const before = plain.slice(Math.max(0, m.index - 70), m.index);
        const after = plain.slice(m.index + m[0].length, m.index + m[0].length + 70);
        if (/^['’]?s\b/.test(after)) continue; // "$4,000s" is a band, not a figure
        if (!(DIFF_WORD_RE.test(before) || DIFF_WORD_RE.test(after))) continue;
        if (MEASURED_FROM_PRICE_AFTER_RE.test(after) || MEASURED_FROM_PRICE_BEFORE_RE.test(before)) continue;
        add('span', sentence.slice(0, 160));
      }
    }
    // Round 6: every counted comp's rent a sentence gives must be tied to that comp's own address. Two or more such rents with fewer
    // addresses ("the low end of the counted comps is $3,200 and the high end is $4,600", "rents begin near $3,200 and top out near
    // $4,600") is a spread in disguise; so are two band figures ("from the low $3,000s to the mid $4,000s").
    const figuresHere = extractDollarFigures(plain);
    const statedRents = new Set(figuresHere.filter(f => !f.band).map(f => Math.round(f.value * 100))
      .filter(c => countedRentCents.has(c) && !headlineCents.has(c) && !cutOriginalCents.has(c)));
    if (statedRents.size >= 2) {
      // an address is its house number, street and UNIT: "1300 Saratoga Ave, Unit 500" and "1300 Saratoga Avenue, Unit 1212" are two
      const addresses = new Set();
      let cursor = 0;
      for (const a of extractAddressMentions(plain)) {
        const at = plain.indexOf(a.shown, cursor);
        let unit = '';
        if (at !== -1) {
          cursor = at + a.shown.length;
          unit = (plain.slice(cursor, cursor + 28).match(UNIT_AFTER_ADDRESS_RE) || [])[1] || '';
        }
        addresses.add(`${a.numbers.join('/')}|${a.words.slice(0, 2).join(' ')}|${unit.toLowerCase()}`);
      }
      if (addresses.size < statedRents.size && !alreadyFlagged(sentence)) add('span', sentence.slice(0, 160));
    }
    if (new Set(figuresHere.filter(f => f.band).map(f => f.value)).size >= 2 && !alreadyFlagged(sentence)) add('span', sentence.slice(0, 160));
    // Round 4: other ways of putting two comps $500 or more apart in one sentence
    const compFigs = compFiguresIn(plain);
    if (isWide(compFigs)) {
      if (PERCENT_OR_MULTIPLE_RE.test(plain)) add('span', sentence.slice(0, 160));                                    // "44% higher", "nearly double"
      if (TOP_WORD_RE.test(plain) && BOTTOM_WORD_RE.test(plain)) add('span', sentence.slice(0, 160));                 // "as little as ... as much as"
      if (FROM_WORD_RE.test(plain) && OUT_TO_RE.test(plain)) add('span', sentence.slice(0, 160));                     // "from $3,200 out to $4,600"
      if (EXTREMES_WORD_RE.test(plain)) add('span', sentence.slice(0, 160));                                          // "the two extremes", "both ends", "bracket"
    }
    if (AND_SO_ON_UP_TO_RE.test(plain) && extractDollarFigures(plain).length > 0) add('span', sentence.slice(0, 160));  // "$3,200, $3,400 and so on up to $4,600"
    // "Roughly 30 days to lease" / "typically leases". (In a per-comp narrative a comp's OWN past days are fine: "it took 62 days to lease".)
    if ((TIME_TO_LEASE_RE.test(sentence) && !(narrative && A_COMP_OWN_PAST_DAYS_RE.test(sentence))) || TIME_GENERAL_RE.test(sentence)) add('time', sentence.slice(0, 160));
    if (!narrative && TIME_IN_A_PERIOD_RE.test(sentence) && extractAddressMentions(sentence).length === 0) add('time', sentence.slice(0, 160));   // "leases within a month" 
    if (TO_STRETCH_PRICE_RE.test(plain) && extractDollarFigures(plain).length > 0) add('stretch', sentence.slice(0, 160));  // "from $2,500 up to the stretch price of $2,800"
    if (narrative && BEST_WORST_COMP_RE.test(plain) && extractDollarFigures(plain).length > 0) add('span', sentence.slice(0, 160));  // "$1,400 less than the best comp"
    if (!narrative && TIME_STAT_RE.test(sentence.replace(NOT_A_TIME_STAT, ' ')) && extractAddressMentions(sentence).length === 0) {
      add('time', sentence.slice(0, 160));
    }
    // a comp's own days on market is fine in its narrative, but "homes like this typically lease within 30 days" is not
    if (narrative && GENERALISING_RE.test(sentence) && TIME_STAT_RE.test(sentence.replace(NOT_A_TIME_STAT, ' '))) {
      add('time', sentence.slice(0, 160));
    }
  }
  // The lowest rent in one sentence and the highest in the next: the same spread, said in two steps.
  const sentenceList = sentencesOf(src).map(withoutRangeEnds);
  // Not 3-6 sentences but dozens: refused rather than read in part.
  if (sentenceList.length > MAX_SENTENCES_CHECKED) add('length', `more than ${MAX_SENTENCES_CHECKED} sentences`);
  for (let i = 0; i + 1 < sentenceList.length; i++) {
    const a = sentenceList[i], b = sentenceList[i + 1];
    const aLow = LOW_WORD_RE.test(a) && !HIGH_WORD_RE.test(a), aHigh = HIGH_WORD_RE.test(a) && !LOW_WORD_RE.test(a);
    const bLow = LOW_WORD_RE.test(b) && !HIGH_WORD_RE.test(b), bHigh = HIGH_WORD_RE.test(b) && !LOW_WORD_RE.test(b);
    if (!((aLow && bHigh) || (aHigh && bLow))) continue;
    const x = rentsIn(a), y = rentsIn(b);
    if (!x.length || !y.length) continue;
    const spread = aLow ? Math.max(...y) - Math.min(...x) : Math.max(...x) - Math.min(...y);
    if (spread >= 500) add('span', `${a.trim().slice(0, 80)} ${b.trim().slice(0, 80)}`);
  }
  // The top comp in one sentence and the bottom comp in the next ("At the top we see $4,600 ... At the bottom we see $3,200 ..."):
  // only the top sentence's largest comp rent and the bottom sentence's smallest are compared.
  for (let i = 0; i + 1 < sentenceList.length; i++) {
    const a = sentenceList[i], b = sentenceList[i + 1];
    const aTop = TOP_WORD_RE.test(a) && !BOTTOM_WORD_RE.test(a), aBottom = BOTTOM_WORD_RE.test(a) && !TOP_WORD_RE.test(a);
    const bTop = TOP_WORD_RE.test(b) && !BOTTOM_WORD_RE.test(b), bBottom = BOTTOM_WORD_RE.test(b) && !TOP_WORD_RE.test(b);
    if (!((aTop && bBottom) || (aBottom && bTop))) continue;
    const topFigures = compFiguresIn(aTop ? a : b), bottomFigures = compFiguresIn(aTop ? b : a);
    if (!topFigures.length || !bottomFigures.length) continue;
    if (Math.max(...topFigures) - Math.min(...bottomFigures) >= 500) add('span', `${a.trim().slice(0, 80)} ${b.trim().slice(0, 80)}`);
  }
  // A per-comp narrative may only state figures from the data (its own rent, its price cut, the recommended range),
  // never a rent of its own invention ("... suggests the subject could rent for about $4,950").
  // (Judged only when at least one comp has a rent; with none there is nothing to compare a figure with.)
  // ... and a figure of $500 or more that is not in the data is allowed only as exactly how far a comp's rent is from the
  // recommended range's ends, the suggested or stretch price or RentCast's estimate, or as a price cut ("Rent of $4,600 sits $1,200
  // above the leased comp at ..." is not).
  // (When the narrative's own comp is known, only THAT comp's distance counts; without it, any comp's.)
  const ownDifferences = narrative && ownComp ? ownDifferencesOf(ownComp, allowed.measuredFrom) : null;
  if (narrative && comps.some(c => Number(c && c.monthly_rent) > 0)) {
    for (const f of extractDollarFigures(src)) {
      if (!isAllowedFigure(f, allowed)) add('figure', f.text);
      else if (!f.band && f.value >= 500 && !isDataFigure(f.value) && !(ownDifferences || allowed.differences).has(Math.round(f.value * 100))) add('figure', f.text);
    }
  }
  const prob = src.match(PROBABILITY_WORDS);
  if (prob) add('probability', prob[0]);
  if (/\bwindow\b/i.test(src)) add('word', 'window');
  return found;
}

// A data source the text names although it supplied no comp to this analysis (a live run said "RentCast, CRMLS
// and LeadSimple Move-Ins" when no LeadSimple comp existed). Only judged when the comps say where they came
// from (source_name). RentCast is also the source of the subject's automated rent estimate, so a sentence that
// says RentCast "estimates" is about that estimate and passes.
const SOURCE_WORDS = [
  { source: 'LeadSimple Move-Ins', re: /\bLeadSimple\b|\bMove-Ins?\b/i },
  { source: 'CRMLS', re: /\bCRMLS\b/i },
  { source: 'RentCast', re: /\bRentCast\b/i },
];
function findUnsuppliedSources(text, input) {
  const comps = (input && input.comps) || [];
  if (!comps.some(c => c && c.source_name)) return [];
  const have = new Set(comps.map(c => c && c.source_name).filter(Boolean));
  const out = [];
  for (const { source, re } of SOURCE_WORDS) {
    if (have.has(source)) continue;
    for (const sentence of sentencesOf(text)) {
      if (!re.test(sentence)) continue;
      if (source === 'RentCast' && /\b(?:estimate[sd]?|estimat\w*|automated|AVM)\b/i.test(sentence)) continue;
      out.push(source);
      break;
    }
  }
  return out;
}

/**
 * @returns {{ok: boolean, problems: string[], labels: string[], badFigures: string[], badAddresses: string[], badClaims: string[], badStatements: string[], badSources: string[]}}
 *   problems are written for the model: they go straight into the retry prompt.
 */
function validateRationale(rationale, input, ctx) {
  // Far too long to be a rationale: refused before any pattern reads it (fail closed).
  if (String(rationale === null || rationale === undefined ? '' : rationale).length > MAX_RATIONALE_CHARS) {
    return {
      ok: false,
      problems: [`it was longer than ${MAX_RATIONALE_CHARS} characters; write 3 to 6 sentences`],
      labels: [], badFigures: [], badAddresses: [], badClaims: [], badStatements: [], badSources: [], tooLong: true,
    };
  }
  const text = cleanModelText(rationale);
  if (countDollarSigns(text) > MAX_DOLLAR_SIGNS_RATIONALE) {
    return {
      ok: false,
      problems: [`it had more than ${MAX_DOLLAR_SIGNS_RATIONALE} dollar signs; write 3 to 6 sentences with only the figures that matter`],
      labels: [], badFigures: [], badAddresses: [], badClaims: [], badStatements: [], badSources: [], tooLong: true,
    };
  }
  const labels = findCompLabels(text);
  ctx = ctx || buildCheckContext(input);   // (a caller that checks many sentences builds it once)
  const { allowed } = ctx;
  const invented = extractDollarFigures(text).filter(f => !isAllowedFigure(f, allowed)).map(f => f.text);
  const unanchored = findUnanchoredDistances(text, ctx);
  const badFigures = [...invented, ...unanchored.filter(f => !invented.includes(f))];
  const badAddresses = findBadAddresses(text, input, ctx.known);
  const badClaims = findNoWeightClaims(text, input.comps || [], undefined, ctx.compPatterns);
  const badStatements = findWideRangeStatements(text, input, { allowed });
  const badSources = findUnsuppliedSources(text, input);
  const problems = [];
  if (labels.length) {
    problems.push(`it used a numeric COMP label (${labels.map(l => `"${l}"`).join(', ')}); the reader's report shows no comp numbers, so refer to every comp by its street address only`);
  }
  if (invented.length) {
    problems.push(`it contained a dollar figure that is not in the data you were given (${invented.join(', ')}); use only the provided figures`);
  }
  if (unanchored.length) {
    problems.push(`it gave a distance (${unanchored.join(', ')}) without naming the comp it is about; a distance from the recommended range, a price or the estimate is allowed only next to that comp's own street address, and never as a gap between rents in general`);
  }
  if (badAddresses.length) {
    const list = badAddresses.map(b => `"${b.shown}"${b.hint.length ? ` (the data has ${b.hint.join('; ')} on that street)` : ' (no comp line has it)'}`).join(', ');
    problems.push(`it mentioned ${badAddresses.length > 1 ? 'addresses that do' : 'an address that does'} not match any comp line in the data: ${list}; write each comp's street address exactly as it appears on its comp line`);
  }
  if (badClaims.length) {
    const list = badClaims.map(b => `"${b.address}" (${b.phrase})`).join(', ');
    problems.push(`it said a counted comp has no effect on the range: ${list}; every comp not marked NOT COUNTED contributed to the recommended range, so do not say it carries no weight, was not used, or anchors nothing (you may call it unconfirmed or an outlier)`);
  }
  const spans = badStatements.filter(b => b.kind === 'span');
  if (spans.length) {
    problems.push(`it wrote a span of dollar figures that is not the recommended range (${spans.map(b => `"${b.text}"`).join(', ')}); the recommended range is the only range you may state, exactly as given, and never describe any spread of $500 or more; never give a figure for how far apart rents are (no lowest-and-highest pair, no gap, spread, difference or band in dollars); name any other comps' rents separately, each with its own address`);
  }
  if (badStatements.some(b => b.kind === 'length')) {
    problems.push(`it had more than ${MAX_SENTENCES_CHECKED} sentences; write 3 to 6 sentences`);
  }
  const groupProblems = badStatements.filter(b => b.kind === 'group');
  if (groupProblems.length) {
    problems.push(`it said a group of comps "ranges", "runs" or "sits" higher, lower, above or below (${groupProblems.map(b => `"${b.text}"`).join(', ')}); use the word "range" only for the recommended range, and to compare comps name individual comps, each with its own address and its own rent`);
  }
  const sourceProblems = badStatements.filter(b => b.kind === 'source');
  if (sourceProblems.length) {
    problems.push(`it named a source the comps did not come from (${sourceProblems.map(b => `"${b.text}"`).join(', ')}); name only the sources listed in "Comp data for this analysis came from"`);
  }
  const stretchProblems = badStatements.filter(b => b.kind === 'stretch');
  if (stretchProblems.length) {
    problems.push(`it tied the stretch price to a range (${stretchProblems.map(b => `"${b.text}"`).join(', ')}); the stretch price is a single price above the recommended range and not part of it, so never write a span that ends at it and never use the word "range" in a sentence with it other than in "above the recommended range"`);
  }
  const timeProblems = badStatements.filter(b => b.kind === 'time' || b.kind === 'probability');
  if (timeProblems.length) {
    problems.push(`it said something about how long leasing takes or how likely it is (${timeProblems.map(b => `"${b.text}"`).join(', ')}); say nothing about time to lease, chances, odds or probability`);
  }
  if (badSources.length) {
    problems.push(`it named a data source that supplied no comps to this analysis (${badSources.join(', ')}); name only the sources listed in "Comp data for this analysis came from"`);
  }
  if (badStatements.some(b => b.kind === 'word')) {
    problems.push('it used a banned word for the recommended range; call it "the recommended range"');
  }
  return {
    ok: problems.length === 0, problems, labels, badFigures,
    badAddresses: badAddresses.map(b => b.shown),
    badClaims: badClaims.map(b => `${b.address}: ${b.phrase}`),
    badStatements: badStatements.map(b => `${b.kind}: ${b.text}`),
    badSources,
  };
}

const STARTS_LIKE_A_SENTENCE_RE = /^["“(]?[A-Z0-9$]/;
const ENDS_LIKE_A_SENTENCE_RE = /[.!?]["”)]?$/;
// The least text worth saving after the flagged sentences are taken out of a rejected second draft.
const MIN_TRIMMED_RATIONALE_CHARS = 60;
const MIN_TRIMMED_RATIONALE_SENTENCES = 2;
const MAX_SENTENCES_TO_TRIM = 15;

/**
 * Takes the sentences the checks reject out of a rationale and keeps the rest. Used only on the SECOND draft (the
 * one written after a correction), so a draft that is mostly sound is not thrown away because of one bad sentence.
 * Every sentence is checked on its own, and the remainder is checked again as a whole (so a pair of sentences that
 * only break a rule together, such as the lowest rent in one and the highest in the next, still fails).
 * @returns {string|null} the cleaned rationale, or null when fewer than two sentences (or too little text) are left or it still fails
 */
function dropFlaggedSentences(rationale, input) {
  if (String(rationale === null || rationale === undefined ? '' : rationale).length > MAX_RATIONALE_CHARS) return null;
  if (countDollarSigns(cleanModelText(rationale)) > MAX_DOLLAR_SIGNS_RATIONALE) return null;
  const sentences = sentencesOf(rationale);
  // a rationale is 3 to 6 sentences: a draft with dozens is not trimmed into an answer
  if (sentences.length > MAX_SENTENCES_TO_TRIM) return null;
  const ctx = buildCheckContext(input);   // once, not once per sentence
  const kept = sentences.filter(sentence => validateRationale(sentence, input, ctx).ok);
  const trimmed = kept.join(' ').trim();
  // one thin sentence ("With a balanced approach, the suggested list price is $4,200.") is not an explanation
  if (kept.length < MIN_TRIMMED_RATIONALE_SENTENCES || trimmed.length < MIN_TRIMMED_RATIONALE_CHARS) return null;
  // What is left must read as whole sentences: it starts with a capital letter, a digit or a dollar sign, ends with a full stop,
  // question or exclamation mark, and no piece ends in the middle of an address ("... 121 W.").
  const wholeSentence = s => STARTS_LIKE_A_SENTENCE_RE.test(s) && ENDS_LIKE_A_SENTENCE_RE.test(s) && !NEVER_ENDS_A_SENTENCE_RE.test(s);
  if (!wholeSentence(trimmed) || !kept.every(wholeSentence)) return null;
  return validateRationale(trimmed, input, ctx).ok ? trimmed : null;
}

function buildCorrection(problems, previousRationale) {
  return `CORRECTION REQUIRED: an automated check rejected your previous rationale for this analysis because:
${problems.map(p => `- ${p}`).join('\n')}
The rejected rationale was: ${JSON.stringify(previousRationale)}
Write the rationale again. Refer to comps by street address only (never "COMP 12" or any numeric label), use only dollar figures that appear in the data above (a plain difference such as "$500 below" is fine), state no range other than the recommended range, say nothing about how long leasing takes or how likely it is, and keep every other rule above. Respond with the same single RENTAL_ANALYSIS_OUTPUT line, with "comp_narratives" as an empty object {}.`;
}

// One Claude call asking for narratives on `narrateIndexes` only. Returns
// {result, stopReason, outputTokens}; result is null only when the response
// was cut off by max_tokens before a complete rationale was written (the one
// case worth a retry). Any other problem throws, as before. `correction`
// (optional) is the text from buildCorrection(), for the rationale-only
// re-ask after validateRationale() rejected a rationale.
async function requestNarrative(client, input, narrateIndexes, correction) {
  const { subject, comps, headline, confidence, subjectEstimatedRent, sourcesUsed } = input;
  const response = await client.messages.create({
    model: MODEL,
    // Output is now bounded by MAX_NARRATED_COMPS narratives plus one
    // rationale (and the prompt forbids any text outside the marker line),
    // far under this cap. It stays at 16000 as headroom, well under
    // claude-opus-4-8's much larger output ceiling; cost is driven by tokens
    // actually generated, not by this number.
    max_tokens: MAX_TOKENS,
    messages: [
      { role: 'user', content: buildPrompt({ subject, comps, headline, confidence, subjectEstimatedRent, sourcesUsed, narrateIndexes, correction }) },
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
  const keepWanted = r => ({ ...r, narrativesByIndex: guardWideRanges(comps, guardNoWeightClaims(comps, guardCompLabels(comps, guardLeasedClaims(comps, r.narrativesByIndex.map((n, i) => (wanted.has(i) ? n : null))))), input) });

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
 *    street address that matches no comp, says a counted comp has no effect
 *    on the range, states a spread or a range other than the recommended one,
 *    or breaks any other rule listed above that function. A
 *    rejection costs ONE more call (the "rationale retry"), which names what
 *    was wrong and asks for the rationale alone; if that one is rejected too,
 *    or fails in any way, rationale is null. The per-comp narratives from the
 *    first response are kept either way; null is never an error.
 *    A second draft that is rejected is not simply thrown away: the sentences
 *    that fail the checks are taken out, and what is left is saved if it passes
 *    the same checks as a whole (meta.rationaleTrimmed); otherwise it is null.
 *  Anthropic calls per report: 1 normally; at most 3 (full response, max_tokens
 *  retry, rationale retry); the two retries are independent.
 * The computed numbers never depend on any of this (server.js/router.js
 * compute them first and treat a throw here as non-fatal).
 *
 * @param {object} input
 * @param {{messages: {create: Function}}} [options.client] - injected in tests; defaults to the real Anthropic client
 * @returns {Promise<{rationale: string|null, narrativesByIndex: (string|null)[], meta: object}>}
 *   meta: {narrativesRequested, narrativesWritten, truncated, retried, rationaleRetried, rationaleTrimmed, rationaleDropped, rationaleProblems, anthropicCalls, stopReason, outputTokens} (logging only)
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
  let rationaleTrimmed = false;
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
      } else if (secondGate) {
        // Rejected again: take out the flagged sentences and keep the rest if what is left passes the same checks.
        const trimmed = dropFlaggedSentences(second.result.rationale, input);
        if (trimmed) {
          rationale = trimmed;
          rationaleTrimmed = true;
          console.warn(`[rental-analysis] The corrected rationale was rejected too (${secondGate.problems.join('; ')}) — saving it with the flagged sentences taken out; per-comp narratives and numbers are kept.`);
        } else {
          console.warn(`[rental-analysis] The corrected rationale was rejected too (${secondGate.problems.join('; ')}) and nothing worth saving was left after taking the flagged sentences out — saving the report with no rationale; per-comp narratives and numbers are kept.`);
        }
      } else {
        console.warn('[rental-analysis] The corrected rationale was cut off by max_tokens — saving the report with no rationale; per-comp narratives and numbers are kept.');
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
      rationaleTrimmed,
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
  dropFlaggedSentences,
  sentencesOf,
  findWideRangeStatements,
  guardWideRanges,
  allowedDollarFigures,
  buildCheckContext,
  findUnanchoredDistances,
  findBadAddresses,
  extractAddressMentions,
  extractDollarFigures,
  findCompLabels,
  buildCorrection,
  MODEL,
  MAX_NARRATED_COMPS,
  MAX_TOKENS,
};
