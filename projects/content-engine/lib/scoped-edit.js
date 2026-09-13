/**
 * lib/scoped-edit.js
 * Second EDIT path for lib/chat.js's handleChatMessage(): for a small,
 * narrowly-scoped chat request ("change X to Y", "fix this sentence",
 * "trim this paragraph"), find the exact existing passage, verify it, and
 * swap in a replacement — WITHOUT sending the whole article through
 * lib/revise.js's full regeneration.
 *
 * THE GUARANTEE THIS FILE EXISTS TO KEEP: if anything here is even slightly
 * uncertain, attemptScopedEdit() returns { applicable: false } and
 * handleChatMessage() falls through to the existing, completely unchanged
 * full-regeneration path — the exact same experience Peter would have had
 * if this file didn't exist. Peter never sees an error about "couldn't find
 * that text" or "ambiguous passage" — those are internal plumbing outcomes,
 * not something he can act on. This is why every failure mode below returns
 * quietly rather than throwing outward, EXCEPT the actual database writes in
 * step 4 once a scoped edit has been decided on — a failure writing an
 * already-verified edit is a real error (same posture lib/revise.js's own
 * step 4 takes: its content_items/content_edits writes aren't wrapped in
 * try/catch either — only the downstream legal-review safety net is).
 *
 * FOUR STEPS, each gating the next:
 *   1. PROPOSE (one Claude call) — decide whether this request is
 *      scoped-eligible (one exact existing passage swapped for new text),
 *      and if so, produce the exact old passage + its replacement.
 *   2. VERIFY (no AI, plain code) — the exact passage must be found in the
 *      current body via a substring check, and must appear EXACTLY ONCE.
 *      More than one match is treated as a failure — this is intentionally
 *      stricter than the older content_section_edits manual feature, which
 *      silently picks the first match. That laxness is tolerable for a
 *      human manually editing one section by hand; it is not tolerable
 *      here, where this path runs on every scoped-eligible chat message.
 *   3. NARRATION-SAFETY CHECK (a SEPARATE, second Claude call — never folded
 *      into step 1) — does the proposed replacement read like real article
 *      content, or like the writer talking about the edit/request/itself?
 *      Modeled on lib/package-draft.js's LEAKED_OPENING_NARRATION check:
 *      same "point at it, verify, fail closed" contract. Kept as its own
 *      call rather than a field on step 1's response for the same reason
 *      this codebase never lets a model grade its own output in the same
 *      breath it produced it (see lib/package-draft.js's own header comment
 *      on why Pass 1/Pass 2 are separate calls, and lib/draft.js's/
 *      lib/revise.js's identical two-pass split).
 *   4. APPLY — plain find-and-replace on the body, save it, then run the
 *      EXACT SAME legal-review write sequence lib/revise.js runs after a
 *      full rewrite (detectLegalClaims() -> filterNewLegalClaimFindings()
 *      -> findMissingLegalClaimBracketFindings() -> recomputeLegalReviewStatus()
 *      -> reviewClaimAsMason() per new finding) — all five reused directly
 *      from lib/package-draft.js/lib/legal-review.js, never reimplemented.
 *
 * A successful scoped edit puts the item back into 'ready_for_review' status
 * — the same status lib/revise.js's reviseContent() already moves an item to
 * after a full rewrite (see that function's own step 4) — so "needs review"
 * behaves identically regardless of which EDIT path actually ran.
 *
 * WEB SEARCH: per an explicit build decision, a scoped edit may research and
 * add ONE new fact, same allowance a full rewrite already has (see
 * lib/revise.js's/lib/draft.js's own webSearchRuleForLegalTopics /
 * webSearchRuleForGeneralTopics). The tool is attached to step 1's PROPOSE
 * call only:
 *   - for a legal-topic article (this item has linked topic_ids) THAT ALSO
 *     already has at least one linked grounding claim — a legal-topic item
 *     with zero linked claims gets no web_search here at all: there is no
 *     baseline legal grounding to extend, and a single scoped chat message
 *     is not the place to establish a legal topic's grounding from scratch.
 *   - unconditionally for a non-legal-topic article — matching
 *     lib/draft.js's/lib/revise.js's own unconditional general-topic
 *     behavior, since the "restricted" framing in this codebase has always
 *     been specifically about the ONE-ADDITIONAL-LEGAL-FACT allowance, not
 *     about general web search overall.
 * Whichever branch applies, the prompt carries the SAME sourcing discipline
 * lib/revise.js's equivalent rule already enforces: a real, specific,
 * nameable source or the fact isn't stated at all; the one extra legal fact
 * (if any) wrapped in "[LEGAL CLAIM PENDING REVIEW: ...]"; fabricating a
 * citation or source forbidden with no exception.
 *
 * NOT USED HERE: lib/revise.js's length-compliance machinery
 * (detectLengthSignal()/checkLengthCompliance()) — a scoped edit only ever
 * touches one passage, so there is no "did the whole piece hit its target
 * length" question to check. A whole-article length request ("make this
 * shorter overall," "cut this to 3 paragraphs") is explicitly excluded from
 * scoped-eligibility in step 1's own prompt instead — that is a
 * full-rewrite-shaped request with real length-target logic already built
 * for it. A request about ONE passage ("trim this paragraph") IS
 * scoped-eligible; the model just writes a shorter replacement directly, no
 * special machinery needed.
 */

const { getClient } = require('./anthropic');
const { select, insert, update } = require('./supabase');
const { getLinkedClaims, getLinkedTopicIds, stripSourcesSectionForLegalScan } = require('./revise');
const { detectLegalClaims } = require('./package-draft');
const {
  recomputeLegalReviewStatus,
  filterNewLegalClaimFindings,
  findMissingLegalClaimBracketFindings,
  reviewClaimAsMason,
} = require('./legal-review');
const { WEB_SEARCH_ALLOWED_DOMAINS } = require('./general-citation-domains');

const MODEL = 'claude-opus-4-8';

// Same off-switch, same "own copy per file, read at call time" convention as
// lib/draft.js's/lib/revise.js's identical helper — see either file's own
// comment for why this isn't shared across files and isn't cached at
// require-time.
function webSearchEnabled() {
  return process.env.ENABLE_WEB_SEARCH_CITATIONS !== 'false';
}

/**
 * Same shape as lib/draft.js's/lib/revise.js's buildWebSearchTool() (same
 * tool type/name, same trusted domain allowlist), but a smaller budget:
 * `max_uses: 3`, not 6 — a scoped edit is researching AT MOST one fact for
 * ONE passage, not researching an entire article, so the full-article
 * budget would just be unused headroom here.
 * @returns {object|null}
 */
function buildScopedWebSearchTool() {
  if (!webSearchEnabled()) return null;
  return {
    type: 'web_search_20250305',
    name: 'web_search',
    allowed_domains: WEB_SEARCH_ALLOWED_DOMAINS,
    max_uses: 3,
  };
}

/**
 * Whether step 1's PROPOSE call should get the web_search tool at all — see
 * this file's own header comment for the exact rule and reasoning.
 * @param {boolean} hasTopics
 * @param {object[]} claims
 */
function shouldEnableWebSearch(hasTopics, claims) {
  if (!webSearchEnabled()) return false;
  const hasClaims = Array.isArray(claims) && claims.length > 0;
  return hasTopics ? hasClaims : true;
}

/**
 * Same "drop everything before the LAST tool-result block" fix as
 * lib/draft.js's/lib/revise.js's identical helper — kept as its own copy,
 * same per-file convention this codebase already follows elsewhere. Only
 * matters here when the PROPOSE call actually used web_search; the common
 * (no-search) case falls through to "concatenate every text block"
 * unchanged.
 * @param {object[]} content
 * @returns {string}
 */
function concatenateTextBlocks(content) {
  const blocks = content || [];
  let lastToolBlockIndex = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i] && blocks[i].type !== 'text') lastToolBlockIndex = i;
  }
  const relevantBlocks = lastToolBlockIndex === -1 ? blocks : blocks.slice(lastToolBlockIndex + 1);
  return relevantBlocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

// ============================================================
// STEP 1 — PROPOSE
// ============================================================

/**
 * Same per-claim formatting convention as every other prompt-builder in this
 * codebase (lib/revise.js's/lib/chat.js's/lib/package-draft.js's own copies)
 * — kept as its own copy rather than imported, matching that established
 * pattern.
 */
function formatClaimsForProposePrompt(claims) {
  if (!claims || claims.length === 0) {
    return '(No compliance claims are currently linked to this draft — do not state any new legal fact in the replacement; flag it "[NEEDS HUMAN REVIEW: ...]" instead, per hard rule 1 below.)';
  }
  return claims
    .map((c, i) => {
      const flag = c.status === 'NEEDS_HUMAN_REVIEW' ? ' [STATUS: NEEDS_HUMAN_REVIEW]' : '';
      return `${i + 1}. claim_key: ${c.claim_key}${flag}\n   jurisdiction: ${c.jurisdiction_scope}\n   statement: ${c.statement}`;
    })
    .join('\n\n');
}

const WEB_SEARCH_RULE_FOR_LEGAL_TOPICS = `

ADDITIONAL HARD RULE — WEB SEARCH:
You may use web_search to research and state real, specific, non-legal
facts (a market statistic, a program name, industry trend data, and
similar) directly in the NEW PASSAGE, naming the source by name where you
state something specific.

You may ALSO use web_search to research and state ONE additional legal fact
that is not covered by the GROUNDING CLAIMS above — but ONLY under every one
of these conditions:
- You must name the real, specific source in your own prose (e.g. "according
  to the Ventura County Star..." or "per the California Apartment
  Association's..."), never a vague "sources say" or "reports indicate."
- The stated fact must be wrapped in this exact inline flag, placed
  immediately around or adjacent to where the fact appears in the NEW
  PASSAGE: "[LEGAL CLAIM PENDING REVIEW: <short description of the claim>]"
  This is a DIFFERENT flag from "[NEEDS HUMAN REVIEW: ...]" (hard rule 1
  below), and the two must never be confused or used interchangeably:
  "[NEEDS HUMAN REVIEW: ...]" means you found no usable source and are
  declining to state the fact; "[LEGAL CLAIM PENDING REVIEW: ...]" means you
  DID find and name a real source and ARE stating the fact, but it still
  requires a human's sign-off before anyone treats it as verified.
- If your search does not turn up a real, specific, nameable source for a
  legal fact this replacement would otherwise need, do not state it at all —
  use "[NEEDS HUMAN REVIEW: ...]" instead, per hard rule 1 below.
- Limit yourself to ONE such flagged legal fact in this replacement.
- Fabricating a citation, statute number, ordinance number, or source — or
  attributing a stated fact to a source that didn't actually return it — is
  absolutely forbidden, no exception.

QUOTES CAN NEVER STATE A LEGAL FACT: if the NEW PASSAGE includes a direct
quotation found via web_search, that quotation can never be used to state a
legal fact (a rule, a deadline, a dollar amount, a percentage, a notice
period, a citation, a statute or ordinance number) — including the one
additional legal fact allowance above. A quote may only ever support a
general, non-legal point.`;

const WEB_SEARCH_RULE_FOR_GENERAL_TOPICS = `

ADDITIONAL HARD RULE — WEB SEARCH:
You may use web_search to research and state real, specific, non-legal
facts (a market statistic, a program name, industry trend data, and
similar) directly in the NEW PASSAGE, naming the source by name where you
state something specific. Never use a search result, no matter how
authoritative it looks, to state or modify a legal fact — this draft has no
legal grounding claims linked to it.

QUOTES CAN NEVER STATE A LEGAL FACT: if the NEW PASSAGE includes a direct
quotation found via web_search, that quotation can never be used to state a
legal fact. A quote may only ever support a general, non-legal point.`;

function buildProposeSystemPrompt({ hasWebSearch, hasTopics }) {
  const webSearchRule = hasWebSearch
    ? hasTopics
      ? WEB_SEARCH_RULE_FOR_LEGAL_TOPICS
      : WEB_SEARCH_RULE_FOR_GENERAL_TOPICS
    : '';

  const legalFactRule = hasWebSearch && hasTopics
    ? ` If satisfying the request needs a legal fact the GROUNDING CLAIMS
   don't cover, you may alternatively research and state ONE additional
   legal fact yourself — see the WEB SEARCH rule further below for exactly
   how and under what conditions.`
    : '';

  return `You are a scoped-edit classifier and passage rewriter for Rincon
Management's content-review chat tool. Peter (the property manager who owns
this business) is chatting about ONE specific article draft and has already
asked for a CHANGE to be made to it (a separate step already decided this is
an edit request, not a question).

YOUR ONLY JOB: decide whether this request can be satisfied by finding ONE
exact, already-existing passage in the article and replacing it with new
text — with nothing else in the article touched. This is a narrow
mechanism, not a general revision tool. If the request needs more than
that, say so plainly rather than forcing a bad, narrow answer onto it.

SCOPED-ELIGIBLE means ALL of the following are true:
- The request is about ONE specific passage, sentence, fact, or phrase — not
  something that requires touching multiple, unrelated parts of the
  article.
- Satisfying it does not require restructuring the article, reorganizing
  existing sections, or adding a brand new section.
- It is NOT a request about the LENGTH OF THE WHOLE ARTICLE (e.g. "make
  this shorter overall," "cut this down to 3 paragraphs," "this needs to be
  more in-depth/longer overall") — those need the full revision pipeline's
  real length-target logic and are NEVER scoped-eligible, even though they
  are technically an edit request. A request to shorten, trim, or expand
  ONE specific passage/paragraph/sentence (not the whole piece) IS
  scoped-eligible — just write the replacement directly, no special length
  handling needed.

If the request is NOT scoped-eligible for any of these reasons, say so
plainly using the output format below.

If it IS scoped-eligible, find the EXACT existing passage in the CURRENT
ARTICLE BODY below that needs to change, and write its replacement.

HARD RULES FOR THE OLD PASSAGE:
- Copy it EXACTLY, character-for-character, from the CURRENT ARTICLE BODY
  below — never paraphrased, never retyped, never "corrected" for a typo it
  happens to contain. If you cannot find a precise, exact passage to point
  at, this request is NOT scoped-eligible — say so rather than inventing a
  close-enough passage.
- Make it only as long as it needs to be to uniquely and unambiguously
  identify the one spot that needs to change — long enough that this exact
  text plausibly appears only once in the article (a single common word or
  short generic phrase is too short; a full sentence or a phrase specific to
  this spot is usually right).

HARD RULES FOR THE NEW PASSAGE (the replacement):
1. You may only state a specific legal fact (a rule, a deadline, a dollar
   amount, a percentage, a notice period, a citation) if it is explicitly
   present in the GROUNDING CLAIMS section below.${legalFactRule} Otherwise,
   if satisfying the request would require a NEW legal fact not covered by
   the grounding claims, do not invent it — write the inline flag
   "[NEEDS HUMAN REVIEW: <short reason>]" in the NEW PASSAGE instead, exactly
   where that fact would go.
2. Never include any tenant's or owner's real name, address, or other
   identifying detail.
3. Write ONLY the replacement text itself — no explanation, no "Here's the
   updated sentence," no talking about the edit or the request in any way.
   It must read as genuine article prose that could sit directly in the
   published piece, start to finish.
4. Match the surrounding article's tone, formatting, and grammatical role —
   if the old passage is a bullet item, a heading, or part of a sentence,
   the new passage should fit that same structural role so the swap reads
   naturally in place.${webSearchRule}

OUTPUT FORMAT — respond with EXACTLY one of these two shapes, nothing
before or after:

If NOT scoped-eligible:
SCOPED_ELIGIBLE: false
REASON: <one short sentence — for internal logs only, Peter never sees this>

If scoped-eligible:
SCOPED_ELIGIBLE: true
===OLD PASSAGE===
<the exact existing passage, copied character-for-character>
===NEW PASSAGE===
<the replacement text>
===END===

Reproduce the marker lines (===OLD PASSAGE===, ===NEW PASSAGE===, ===END===)
exactly as shown, each on its own line, with nothing else on those lines.`;
}

function buildProposeUserPrompt({ message, currentBody, claims }) {
  return `CURRENT ARTICLE BODY:
${currentBody}

GROUNDING CLAIMS already linked to this draft (the only legal facts you may
state in the NEW PASSAGE, unless the WEB SEARCH rule above grants a
research allowance for this draft):
${formatClaimsForProposePrompt(claims)}

PETER'S REQUEST:
${message}

Decide whether this request is scoped-eligible, following the rules above.
Respond in the exact output format described — nothing else.`;
}

/**
 * Parse step 1's response. Never throws on a malformed/unexpected shape —
 * returns { eligible: false } instead, so a parsing hiccup here quietly
 * becomes "not applicable" (see attemptScopedEdit()'s own outer try/catch,
 * which treats this identically to every other "not applicable" outcome).
 * @param {string} text
 * @returns {{eligible: false, reason: string}|{eligible: true, oldPassage: string, newPassage: string}}
 */
function parseProposeResponse(text) {
  const raw = text || '';

  const eligibleMatch = raw.match(/SCOPED_ELIGIBLE:\s*(true|false)/i);
  if (!eligibleMatch) {
    return { eligible: false, reason: 'no SCOPED_ELIGIBLE line found in the model response' };
  }

  if (eligibleMatch[1].toLowerCase() === 'false') {
    const reasonMatch = raw.match(/REASON:\s*(.+)/i);
    return { eligible: false, reason: reasonMatch ? reasonMatch[1].trim() : '(no reason given)' };
  }

  const oldMatch = raw.match(/===OLD PASSAGE===([\s\S]*?)===NEW PASSAGE===/);
  const newMatch = raw.match(/===NEW PASSAGE===([\s\S]*?)===END===/);
  if (!oldMatch || !newMatch) {
    return { eligible: false, reason: 'SCOPED_ELIGIBLE: true but the OLD/NEW PASSAGE markers were not found in the expected format' };
  }

  const oldPassage = oldMatch[1].trim();
  const newPassage = newMatch[1].trim();
  if (!oldPassage) {
    return { eligible: false, reason: 'OLD PASSAGE was empty' };
  }

  return { eligible: true, oldPassage, newPassage };
}

async function proposeScopedEdit({ message, currentBody, claims, hasTopics }) {
  const webSearchTool = shouldEnableWebSearch(hasTopics, claims) ? buildScopedWebSearchTool() : null;

  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    // A single passage swap, not a full article — generous enough for a
    // long paragraph on either side of the replacement, far less than
    // lib/revise.js's 8192 (a whole article) or even lib/package-draft.js's
    // 2048 (several metadata fields at once, this call only ever produces
    // two blocks of prose).
    max_tokens: 2048,
    ...(webSearchTool ? { tools: [webSearchTool] } : {}),
    system: buildProposeSystemPrompt({ hasWebSearch: Boolean(webSearchTool), hasTopics }),
    messages: [{ role: 'user', content: buildProposeUserPrompt({ message, currentBody, claims }) }],
  });

  const text = concatenateTextBlocks(response.content);
  return parseProposeResponse(text);
}

// ============================================================
// STEP 2 — VERIFY (plain code, no AI)
// ============================================================

/**
 * How many times `needle` occurs in `haystack`, as a plain literal
 * substring (not a regex) — used to enforce the "must not be ambiguous"
 * rule. Returns 0 for an empty needle (never treated as "found").
 */
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

// ============================================================
// STEP 3 — NARRATION-SAFETY CHECK (a separate, second Claude call)
// ============================================================

function buildNarrationCheckSystemPrompt() {
  return `You are a narration-leak checker for Rincon Management's content
tool. You are given ONE piece of text — a proposed replacement passage that
is about to be inserted directly into a published article's body, in place
of an existing passage. Do not evaluate its accuracy, grounding, or
anything else about it — decide ONLY this one thing:

Does this text read like genuine, standalone article content that could sit
directly inside a published article — or does it read like the writer
talking ABOUT the edit, the request, or itself (e.g. "I've updated this
paragraph as requested," "Here's the revised sentence," "As requested, this
now says...", "I've made this change to address your feedback")?

This is a COMPREHENSION judgment, not a keyword search — narration can read
as ordinary, reasonable-sounding prose without an obvious announcement
phrase. Judge what the text IS about, not merely how it happens to be
phrased. Never flag genuine article content just because it happens to
open in first person, or because it states a fact plainly — normal, direct
prose is real content, not narration.

THE QUESTION THAT DECIDES IT: who/what is the sentence ABOUT — the
article's subject matter (tenants, leases, the law, maintenance, money,
whatever this article actually covers), or the edit/request/AI's own
process of producing this text? Two specific patterns read as
narration-shaped on the surface but are ordinary article writing style and
must NOT be flagged on their own:

- A "Here's"/"Here is" lead-in followed by real substantive information
  about the article's subject matter is a normal direct-answer opener, not
  narration — e.g. "Here's what the law requires when a tenant requests a
  pre-move-out inspection: it must occur during the final two weeks of the
  tenancy," or "Here's what tenants should do within the first 30 days of
  move-in." Only flag a "Here's"/"Here is" opener when what follows is
  about the EDIT ITSELF — "Here's the revised sentence," "Here's the
  updated paragraph," "Here's what I changed."
- A reference to ANY structural unit of the article — section, paragraph,
  sentence, passage, part, portion, chunk, segment, block, or literally any
  other noun a writer might use for a piece of the article — used in the
  ARTICLE'S OWN VOICE to tell the reader what that unit covers, explains,
  or discusses is legitimate content. IMPORTANT — read this carefully: the
  noun itself is NEVER the deciding factor and must never be pattern-
  matched against a fixed list. Do not require the specific word to appear
  in the examples below before you'll accept this carve-out — that is the
  wrong test and a mistake this checker has made before. The examples exist
  only to illustrate the TEST, not to enumerate the approved vocabulary.
  Before flagging any sentence shaped like "this <structural noun>
  <verb>...", first mentally swap in a different structural noun (e.g.
  swap "paragraph" for "section," or "passage" for "part") — if the
  classification wouldn't change, then the noun was never what mattered,
  and you must judge it by the same rule as the examples below. Examples:
  "This section explains what tenants should do within the first 30 days
  of move-in, including documenting the unit's condition with dated
  photos." "This paragraph covers what a landlord must include in a 3-day
  notice." "This sentence outlines a tenant's right to a pre-move-out
  inspection." "This passage discusses the steps a property manager should
  take before withholding a deposit." In every one of these the sentence is
  ABOUT the article's subject matter, so none of them is narration,
  regardless of which structural noun was used. Only flag this pattern when
  it instead describes the WRITER'S EDITING ACTION on that unit — "I've
  revised this section," "this part now reflects your requested change,"
  "this paragraph now says...", "I've updated this sentence," "this passage
  now covers what you asked for." The deciding question is always the same
  one from above (article subject matter vs. the edit itself) — asked fresh
  for whatever noun appears, never answered by checking the noun against a
  list.

If the text is genuinely clean, real content, respond with exactly:
NARRATION_FOUND: ""

If you find narration anywhere in the text, copy the EXACT offending span
(character-for-character, a real substring of the text given to you) as a
JSON string:
NARRATION_FOUND: "<exact text>"

Output ONLY that one line — nothing before or after it, no markdown fence.`;
}

function buildNarrationCheckUserPrompt(newPassage) {
  return `PROPOSED REPLACEMENT TEXT:
${newPassage}

Respond with ONLY the NARRATION_FOUND line described in your instructions.`;
}

/**
 * Runs the narration-safety check. Resolves (no return value) when the
 * passage is genuinely clean. THROWS in every other case — a flagged
 * problem, a response that doesn't parse, or a flagged span that fails
 * mechanical verification against the actual passage text — because per
 * this check's own contract, ALL of those mean the same thing: the scoped
 * edit did not pass this gate. attemptScopedEdit()'s outer try/catch turns
 * any of these into the same "not applicable" outcome, so there is no need
 * for this function to distinguish "flagged" from "the check itself broke"
 * — both must fail the edit identically.
 *
 * Deliberately NOT the same fail-safe direction as
 * lib/package-draft.js's stripLeakedOpeningNarration() (which trusts
 * nothing and leaves text untouched on a verification mismatch) — that
 * function is optional cleanup inside a pipeline that proceeds regardless;
 * this check instead GATES whether the scoped edit proceeds AT ALL, so any
 * anomaly here must resolve to "did not pass," never to "trust it anyway."
 *
 * @param {string} newPassage
 * @returns {Promise<void>}
 */
async function checkNarrationSafety(newPassage) {
  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    // Headroom to echo back the ENTIRE passage verbatim if the whole thing
    // is flagged as narration — matches step 1's own 2048 ceiling for the
    // same passage.
    max_tokens: 2048,
    system: buildNarrationCheckSystemPrompt(),
    messages: [{ role: 'user', content: buildNarrationCheckUserPrompt(newPassage) }],
  });

  const textBlock = (response.content || []).find((b) => b && b.type === 'text' && typeof b.text === 'string');
  const raw = textBlock ? textBlock.text : '';

  const match = raw.match(/NARRATION_FOUND:\s*("(?:[^"\\]|\\.)*")/i);
  if (!match) {
    throw new Error(
      `narration-safety check response did not contain a parseable NARRATION_FOUND field: ${JSON.stringify(raw).slice(0, 300)}`
    );
  }

  let flagged;
  try {
    flagged = JSON.parse(match[1]);
  } catch (e) {
    throw new Error(`narration-safety check's NARRATION_FOUND JSON did not parse: ${e.message}`);
  }
  if (typeof flagged !== 'string') {
    throw new Error('narration-safety check returned a non-string NARRATION_FOUND value');
  }

  const candidate = flagged.trim();
  if (!candidate) return; // genuinely clean — passed

  if (!newPassage.includes(candidate)) {
    throw new Error(
      'narration-safety check flagged a span that is not a genuine substring of the proposed passage — treating the check as failed'
    );
  }

  throw new Error(`narration-safety check flagged genuine narration in the proposed passage: "${candidate}"`);
}

// ============================================================
// STEP 4 — APPLY
// ============================================================

/** Plain, single-occurrence find-and-replace — safe because step 2 already
 * verified `oldPassage` appears in `body` exactly once. Uses String#replace
 * with a literal string argument (not a RegExp), so no regex-special-char
 * escaping is needed and only the first (here, only) match is touched. */
function applyScopedReplacement(body, oldPassage, newPassage) {
  return body.replace(oldPassage, newPassage);
}

function truncateForSummary(text, maxLen) {
  const trimmed = (text || '').trim().replace(/\s+/g, ' ');
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
}

/**
 * Deterministic (no extra Claude call) one-line summary stored as the AI
 * turn's own message for a successful scoped edit — this IS what
 * lib/chat.js's buildHistoryForPrompt() shows in place of the original
 * request on every later turn, same role lib/chat.js's own summarizeEdit()
 * plays for a full regeneration. No extra AI call is needed here (unlike
 * summarizeEdit(), which has to diff a whole rewritten article) because
 * step 1 already handed back the exact old/new passage pair — there is
 * nothing left to summarize that isn't already sitting in hand.
 *
 * Per Peter's own explicit decision, this reads as a "small, targeted
 * edit" — distinct language from the full-rewrite summary — so the chat
 * log visibly distinguishes the two kinds of exchange even before the
 * turn_type-driven badge (see content-review/server.js's renderChatTurn())
 * is taken into account.
 */
function buildScopedEditSummaryMessage({ oldPassage, newPassage }) {
  const snippet = truncateForSummary(oldPassage, 70);
  const hasNeedsReview = /\[NEEDS HUMAN REVIEW:/.test(newPassage);
  const hasLegalPending = /\[LEGAL CLAIM PENDING REVIEW:/.test(newPassage);
  let flagNote = '';
  if (hasNeedsReview && hasLegalPending) {
    flagNote = ' One item was flagged for human review, and a newly researched legal fact is pending review.';
  } else if (hasNeedsReview) {
    flagNote = ' One item was flagged for human review — no grounding claim covers it yet.';
  } else if (hasLegalPending) {
    flagNote = ' A newly researched legal fact is pending review before it can be treated as verified.';
  }
  return `Made a small, targeted edit — updated the passage starting "${snippet}".${flagNote}`;
}

function logNotApplicable(contentItemId, reason) {
  console.log(
    `[scoped-edit.js] attemptScopedEdit(): not applicable for content_item ${contentItemId} — ${reason}. ` +
      'Falling back to full regeneration.'
  );
}

/**
 * Attempt a scoped (single-passage) edit for one chat EDIT request. See this
 * file's own header comment for the full four-step design.
 *
 * @param {object} opts
 * @param {string} opts.contentItemId
 * @param {string} opts.message - Peter's trimmed chat message
 * @param {string} opts.currentBody - the draft's current body (a snapshot;
 *   same "caller already fetched the item" pattern lib/chat.js's own
 *   handleChatMessage() already uses for the full-regen path)
 * @param {string} [opts.editedBy] - attribution string for the content_edits
 *   row this writes, if it succeeds
 * @returns {Promise<{applicable: false} | {applicable: true, contentItem: object, resultingContentEditId: string, summaryMessage: string}>}
 */
async function attemptScopedEdit({ contentItemId, message, currentBody, editedBy = 'AI (scoped edit via chat)' }) {
  if (!contentItemId) throw new Error('attemptScopedEdit() requires a contentItemId');
  if (!message || !message.trim()) throw new Error('attemptScopedEdit() requires a message');
  if (currentBody == null) throw new Error('attemptScopedEdit() requires currentBody');

  let proposal;
  let claims;
  try {
    const [linkedClaims, topicIds] = await Promise.all([
      getLinkedClaims(contentItemId),
      getLinkedTopicIds(contentItemId),
    ]);
    claims = linkedClaims;
    const hasTopics = topicIds.length > 0;

    // STEP 1 — PROPOSE
    proposal = await proposeScopedEdit({ message, currentBody, claims, hasTopics });
    if (!proposal.eligible) {
      logNotApplicable(contentItemId, `not scoped-eligible per the propose call (${proposal.reason})`);
      return { applicable: false };
    }

    // STEP 2 — VERIFY (plain code, no AI)
    if (!currentBody.includes(proposal.oldPassage)) {
      logNotApplicable(contentItemId, 'proposed OLD PASSAGE was not found verbatim in the current body');
      return { applicable: false };
    }
    const occurrences = countOccurrences(currentBody, proposal.oldPassage);
    if (occurrences !== 1) {
      logNotApplicable(contentItemId, `proposed OLD PASSAGE is ambiguous — found ${occurrences} times in the current body`);
      return { applicable: false };
    }

    // STEP 3 — NARRATION-SAFETY CHECK (separate Claude call — see comment above)
    await checkNarrationSafety(proposal.newPassage);
  } catch (e) {
    // ANY problem up through here (a malformed propose response, a Claude
    // API error, a narration-check failure or flag) is "uncertain" per this
    // file's own guarantee — quietly not-applicable, never surfaced to
    // Peter. Nothing has been written to the database yet at this point.
    console.warn(
      `[scoped-edit.js] attemptScopedEdit(): steps 1-3 failed unexpectedly for content_item ${contentItemId} — ` +
        `falling back to full regeneration. ${e.message}`
    );
    return { applicable: false };
  }

  // STEP 4 — APPLY. From here on, a failure is a real error (same posture
  // lib/revise.js's own step 4 takes for its content_items/content_edits
  // writes) rather than a silent "not applicable" — see this file's own
  // header comment for why swallowing a failure here would risk a stale
  // full-regen overwrite racing an already-partially-applied scoped edit.
  const newBody = applyScopedReplacement(currentBody, proposal.oldPassage, proposal.newPassage);

  const [updatedItem] = await update('content_items', `id=eq.${contentItemId}`, {
    body: newBody,
    status: 'ready_for_review',
  });

  const [editRow] = await insert('content_edits', {
    content_item_id: contentItemId,
    edited_by: editedBy,
    field_changed: 'body',
    before_text: currentBody,
    after_text: newBody,
    edit_note: `Scoped edit via chat, addressing: "${truncateForSummary(message, 200)}"`,
  });

  // Same legal-review write sequence lib/revise.js runs after a full
  // rewrite (its own step 6) — reused directly, not reimplemented, and
  // wrapped in the same try/catch for the same reason: a failure here must
  // never undo or hide an edit that already saved successfully above.
  let legalReviewStatus = updatedItem.legal_review_status;
  try {
    const bodyForLegalScan = stripSourcesSectionForLegalScan(newBody);
    const legalClaimFindings = await detectLegalClaims(bodyForLegalScan, claims);
    const newFindings = await filterNewLegalClaimFindings(contentItemId, legalClaimFindings);

    let insertedReviewRows = [];
    if (newFindings.length > 0) {
      insertedReviewRows = await insert(
        'legal_claim_reviews',
        newFindings.map((f) => ({
          content_item_id: contentItemId,
          claim_text: f.claimText,
          claim_context: f.context,
          source_url: f.sourceUrl || '(no source found in article text — flagged for review)',
          jurisdiction_scope: 'unknown',
          detected_by: f.detectedBy,
        }))
      );
    }

    const missingBracketFindings = await findMissingLegalClaimBracketFindings(contentItemId, bodyForLegalScan);
    if (missingBracketFindings.length > 0) {
      console.warn(
        `[scoped-edit.js] STRUCTURAL BACKSTOP fired for content_item ${contentItemId}: found ` +
          `${missingBracketFindings.length} [LEGAL CLAIM PENDING REVIEW] bracket(s) with no matching ` +
          'legal_claim_reviews row — detectLegalClaims() missed it this run. Inserting fallback row(s) now.'
      );
      const structuralRows = await insert(
        'legal_claim_reviews',
        missingBracketFindings.map((f) => ({
          content_item_id: contentItemId,
          claim_text: f.claimText,
          claim_context: f.context,
          source_url: f.sourceUrl || '(no source found in article text — flagged for review)',
          jurisdiction_scope: 'unknown',
          detected_by: f.detectedBy,
        }))
      );
      insertedReviewRows = insertedReviewRows.concat(structuralRows);
    }

    legalReviewStatus = await recomputeLegalReviewStatus(contentItemId);

    for (const row of insertedReviewRows) {
      try {
        await reviewClaimAsMason(row.id);
      } catch (e) {
        console.warn(
          `[scoped-edit.js] Mason's automatic review failed for legal_claim_reviews row ${row.id} ` +
            `(content_item ${contentItemId}) — mason_finding stays null until a manual or retried review runs. ${e.message}`
        );
      }
    }
  } catch (e) {
    console.warn(
      `[scoped-edit.js] Legal-claim detection write/recompute failed for content_item ${contentItemId} — ` +
        `the scoped edit itself was saved successfully; only the legal-review safety net did not run this time. ${e.message}`
    );
  }
  updatedItem.legal_review_status = legalReviewStatus;

  return {
    applicable: true,
    contentItem: updatedItem,
    resultingContentEditId: editRow.id,
    summaryMessage: buildScopedEditSummaryMessage({ oldPassage: proposal.oldPassage, newPassage: proposal.newPassage }),
  };
}

module.exports = {
  attemptScopedEdit,
  // Exported for direct unit testing — the pure parsing/matching logic
  // (steps 1's parser and step 2's ambiguity check) needs no API call at
  // all; checkNarrationSafety() (step 3) does make a real Claude call but is
  // exported so its "point at it, verify, fail closed" contract can be
  // exercised directly against a deliberately-narrating sample, the same way
  // lib/chat.js exports summarizeEdit() despite it also being a real API
  // call. Same convention this codebase already follows elsewhere (e.g.
  // extractNewNeedsHumanReviewFlags, stripSourcesSectionForLegalScan).
  parseProposeResponse,
  countOccurrences,
  applyScopedReplacement,
  buildScopedEditSummaryMessage,
  checkNarrationSafety,
};
