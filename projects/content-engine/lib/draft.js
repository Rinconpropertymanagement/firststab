/**
 * lib/draft.js
 * Core "topic in, grounded draft out" loop.
 *
 * 1. Look up relevant compliance claims for the topic (lib/compliance.js)
 * 2. PASS 1 — ask Claude to research (when applicable) and write the draft,
 *    grounded ONLY in those claims
 * 3. PASS 2 — ask Claude (a separate call, lib/package-draft.js) to package
 *    the finished draft: SEO title/description, which claims got cited,
 *    general/non-legal source proposals, quote proposals, related-post picks
 * 4. Insert the draft into content_items (status='draft')
 * 5. Link every claim actually cited into content_item_compliance_claims
 *
 * WHY TWO PASSES (as of this build): the old design asked ONE Claude call to
 * research, write, respect legal grounding, respect brand voice, track
 * citations, AND fill in SEO metadata simultaneously. A side-by-side test
 * against plain Claude Chat on the same topic showed this caused
 * under-research even with web_search technically available — the model was
 * juggling too much at once. Splitting into "Pass 1: research & write" and
 * "Pass 2: package" (lib/package-draft.js, shared with lib/revise.js, whose
 * Pass 2 job is identical) lets Pass 1 stay structurally simple — minimal
 * competing instructions — so it can actually focus on researching and
 * writing well. draftContent()'s own signature and return shape are
 * UNCHANGED — this two-call split is an internal implementation detail; no
 * caller needs to change.
 *
 * This module does not publish anything and does not talk to any social
 * platform, email service, or CMS — it only writes to Supabase.
 */

const { getClient } = require('./anthropic');
const {
  getGroundingClaims,
  getInternalLinkCandidates,
  getGeneralInternalLinkCandidates,
} = require('./compliance');
const { getActiveBrandGuide, formatBrandGuideForPrompt, brandGuideSystemRule } = require('./brand-guide');
const {
  insertCitationLinks,
  insertGeneralCitations,
  filterAllowedGeneralCitations,
  insertVerifiedQuotes,
  insertRelatedReadingAndSourcesSections,
  extractFaqSchema,
  stripLeadingTitleHeading,
  stripLeadingPreambleSeparator,
  stripMidDocumentNarration,
} = require('./seo');
const { GENERAL_CITATION_DOMAINS, WEB_SEARCH_ALLOWED_DOMAINS } = require('./general-citation-domains');
const { insert } = require('./supabase');
const { packageDraft, extractSearchResultsEvidence, detectLegalClaims } = require('./package-draft');
const {
  recomputeLegalReviewStatus,
  filterNewLegalClaimFindings,
  findMissingLegalClaimBracketFindings,
  reviewClaimAsMason,
} = require('./legal-review');

const VALID_CONTENT_TYPES = [
  'blog_post',
  'faq',
  'market_report',
  'flagship_report',
  'case_study',
];

const MODEL = 'claude-opus-4-8';

// Off-switch for the web_search tool (see buildWebSearchTool() below). Only
// the literal string "false" disables it — unset, empty, or any other value
// defaults to enabled. Read at call time (not cached at module load) so a
// test run can flip process.env.ENABLE_WEB_SEARCH_CITATIONS between calls
// without re-requiring this module.
function webSearchEnabled() {
  return process.env.ENABLE_WEB_SEARCH_CITATIONS !== 'false';
}

/**
 * Build the web_search tool entry for the `tools` array, or null.
 *
 * CHANGED BY THIS BUILD: web search used to be withheld entirely whenever
 * `hasTopics` was true (grounded legal content) — the model literally could
 * not search while drafting a legal-topic piece, full stop. That isolation
 * boundary is REMOVED as of this build: legal-topic pieces now get the exact
 * same tool, on the exact same on/off switch and budget, as every other
 * piece. The safety mechanism for legal content has moved from "the tool
 * isn't there" to a prompt-level hard rule (see buildSystemPrompt()'s
 * hasTopics-branched webSearchRule below): the model MAY research and state
 * one additional, real-sourced legal fact beyond the pre-approved
 * GROUNDING CLAIMS, but only wrapped in the new
 * "[LEGAL CLAIM PENDING REVIEW: ...]" flag, which routes it into
 * lib/package-draft.js's detectLegalClaims() -> legal_claim_reviews for
 * Mason's and Peter's sign-off before it's ever treated as verified (see
 * supabase/migrations/20260801000000_legal_claim_reviews.sql). Fabricating a
 * citation or source remains just as forbidden as it always was.
 *
 * The only remaining gate here is the plain on/off switch (webSearchEnabled())
 * — no longer conditioned on `hasTopics` at all, so this function no longer
 * takes that parameter.
 *
 * `allowed_domains` restricts results to WEB_SEARCH_ALLOWED_DOMAINS
 * (lib/general-citation-domains.js) — the same trusted domain set
 * GENERAL_CITATIONS proposals are gated against in lib/seo.js, minus a
 * handful that block Anthropic's search crawler outright (see that file's
 * comment — passing a crawler-blocked domain here fails the ENTIRE request,
 * not just that one domain, so this must NOT use the raw
 * GENERAL_CITATION_DOMAINS list). `max_uses: 6` caps cost/latency per
 * generation (~$0.01/search) — raised from 2 in an earlier build specifically
 * to give Pass 1 real room to research thoroughly instead of stopping after a
 * search or two; unchanged by this build.
 *
 * @returns {object|null}
 */
function buildWebSearchTool() {
  if (!webSearchEnabled()) return null;
  return {
    type: 'web_search_20250305',
    name: 'web_search',
    allowed_domains: WEB_SEARCH_ALLOWED_DOMAINS,
    max_uses: 6,
  };
}

/**
 * Concatenate the `text`-type blocks in a Claude response's `content` array
 * that make up the actual draft, in order.
 *
 * Three bugs, three fixes, stacked:
 *
 * 1. (Prior fix) `response.content.find((b) => b.type === 'text')` only ever
 *    grabbed the FIRST text block, silently truncating the draft body
 *    whenever more than one text block came back.
 *
 * 2. (Prior fix) Naively concatenating EVERY text block in order reintroduced
 *    a different bug once web_search was wired up: when the model actually
 *    searches, its response looks like
 *      text("I'll research X...") -> server_tool_use -> web_search_tool_result
 *      -> text(real content) -> text(more real content) -> ...
 *    and that pre-search narration sentence was landing verbatim as the
 *    literal opening of the stored draft. Confirmed against a real API
 *    response (2026-07-15): block types are exactly `text`,
 *    `server_tool_use`, and `web_search_tool_result` — anything that isn't
 *    `text` is tool activity. Fixed at the time by finding the FIRST non-text
 *    block and keeping only text blocks after it.
 *
 * 3. (This fix) Raising the search budget to 6 uses (see buildWebSearchTool())
 *    made multi-round searching common, and fix #2's "first non-text block"
 *    rule doesn't generalize to it. With 2+ search rounds, the real shape is:
 *      text("I'll research X...") -> tool_use -> tool_result
 *      -> text("Good, now let me also check Y...") -> tool_use -> tool_result
 *      -> text(real content) -> text(more real content) -> ...
 *    "Everything after the FIRST non-text block" keeps that SECOND narration
 *    block too, since it sits after the first tool call — it just isn't
 *    itself a tool-related block. TARS reproduced this live: leftover
 *    narration from a later search round landed at the top of the stored
 *    draft in 1 of 2 real generations on a multi-round-search topic.
 *
 * Fix: use the LAST non-text (tool-related) block, not the first. Everything
 * up through the final tool call is research activity — narration, searches,
 * and any narration BETWEEN searches — and only text blocks after that final
 * tool call are real draft content. When the model never used a tool at all
 * (the normal non-search path, or a search-enabled call where it just didn't
 * end up searching), there is no non-text block, so this falls back to
 * concatenating every text block, unchanged from before.
 *
 * Still runs on Pass 1's raw response only — Pass 2 (lib/package-draft.js)
 * never writes article prose, so it has no equivalent narration-ordering
 * concern; it grabs its one text block directly.
 * @param {object[]} content - response.content from client.messages.create()
 * @returns {string}
 */
function concatenateTextBlocks(content) {
  const blocks = content || [];
  let lastToolBlockIndex = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i] && blocks[i].type !== 'text') lastToolBlockIndex = i;
  }
  const relevantBlocks =
    lastToolBlockIndex === -1 ? blocks : blocks.slice(lastToolBlockIndex + 1);
  return relevantBlocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/**
 * ROUND 3 FIX — the PRIMARY defense against leaked narration, added after
 * TARS (2026-07-29) proved the pattern-matching approach behind
 * stripLeadingHandoffPreamble() below (and lib/seo.js's
 * stripLeadingPreambleSeparator()/stripMidDocumentNarration()) is
 * structurally unreliable: TARS found a real leaked case where the leaked
 * paragraph's FIRST sentence matched a recognized hand-off phrase ("I have
 * everything I need...") but its SECOND sentence was the model genuinely
 * explaining an editorial decision in substantive-sounding language, with no
 * stock opener at all. Real leaked narration doesn't reliably announce
 * itself — sometimes it just IS the model's actual reasoning, phrased like
 * real prose — so classifying it after the fact by how it opens can never
 * fully close this gap, no matter how many more phrasings get added.
 *
 * The fix: stop guessing. Instruct the model (see buildSystemPrompt()'s
 * articleMarkerRule below) to emit this exact literal line, alone,
 * immediately before the real article begins — nothing of any kind
 * (acknowledgment, summary, restated plan) may precede it. Parsing then
 * trusts this structural anchor completely: everything before the LAST
 * occurrence of this marker is discarded, full stop, regardless of what it
 * says or how it's phrased. No regex, no phrase list, no length ceiling.
 *
 * This is a plain module-level string, not a regex — build the matching
 * regex from it in ARTICLE_MARKER_LINE_REGEX below so the two can never
 * drift out of sync with each other.
 */
const ARTICLE_MARKER = '===ARTICLE BELOW===';

// The exact ARTICLE_MARKER line, anchored to its own line (tolerating
// leading/trailing horizontal whitespace on that line, but nothing else on
// it) — global+multiline so extractAfterArticleMarker() below can walk every
// occurrence and use the LAST one. "Prefer the last occurrence" is the same
// philosophy concatenateTextBlocks()'s own fix above already uses (favor the
// LAST tool-call boundary, not the first) — belt-and-suspenders in case the
// model still narrates AND repeats the marker more than once despite the
// hard rule against doing either.
function buildArticleMarkerLineRegex() {
  const escaped = ARTICLE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^[ \\t]*${escaped}[ \\t]*$`, 'gm');
}

/**
 * Find the LAST occurrence of the ARTICLE_MARKER line in Pass 1's raw
 * concatenated text and return everything after it — the primary defense
 * against leaked narration (see ARTICLE_MARKER's own comment above). Rather
 * than trying to classify whatever text sits before the real article as
 * narration-or-not after the fact, the model is instructed to emit an
 * unambiguous structural anchor immediately before the article, and this
 * function trusts that anchor completely: no phrase-matching, no length
 * heuristics, just "everything after the marker is the article."
 *
 * Returns null if the marker isn't found anywhere (the model didn't
 * comply) — the caller falls back to the pre-marker pipeline
 * (stripLeadingHandoffPreamble() + lib/seo.js's own regex layers, run
 * directly on the raw text) in that case, so a single non-compliant
 * response degrades to the OLD (imperfect but real) protection rather than
 * to nothing.
 *
 * @param {string} text - Pass 1's raw concatenated text (concatenateTextBlocks()'s
 *   output), before any other cleanup runs
 * @returns {string|null}
 */
function extractAfterArticleMarker(text) {
  if (!text) return null;
  const regex = buildArticleMarkerLineRegex();
  let match;
  let lastMatch = null;
  while ((match = regex.exec(text))) {
    lastMatch = match;
  }
  if (!lastMatch) return null;
  return text.slice(lastMatch.index + lastMatch[0].length);
}

// Matches the body's first "##"+ heading line, anywhere in the string —
// same regex shape as lib/seo.js's private FIRST_HEADING_REGEX, reimplemented
// here rather than imported, since lib/seo.js is a shared safety net used
// elsewhere and is deliberately left unmodified by this fix (see
// stripLeadingHandoffPreamble()'s comment below for why).
const FIRST_HEADING_REGEX = /^#{2,}[ \t]*\S.*$/m;

// A bare Markdown thematic break ("---", "***", or "___") on its own line —
// not a real sentence. Filtered out before the "every sentence must look
// like a hand-off" check below, so a divider sitting between the model's
// hand-off remark and the real heading doesn't get counted as a non-matching
// "sentence" that would otherwise block the strip.
const THEMATIC_BREAK_LINE_REGEX = /^(?:-{3,}|\*{3,}|_{3,})$/;

// Crude sentence splitter — good enough here because it only ever runs on a
// short leading candidate (everything before the body's first "##" heading),
// never the full article. Same shape as lib/seo.js's private
// splitIntoSentences(), reimplemented locally for the same reason as
// FIRST_HEADING_REGEX above.
function splitLeadingSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !THEMATIC_BREAK_LINE_REGEX.test(s));
}

// A hand-off sentence's SENTENCE START — the model narrating its own
// hand-off from research/deciding to writing: "I have...", "I've...",
// "I'll...", "I will...", "Here's...", "Here is...", "Below is...", "Let
// me...". Rincon's real voice is consistently first-person-PLURAL ("we") in
// actual article content (see buildSystemPrompt()'s role line above), so a
// first-person-SINGULAR sentence opener like this essentially never occurs
// in real substantive prose — it's a safe, narrow signal. Same pattern
// lib/seo.js's own leading-preamble check relies on, reimplemented locally
// (not imported) for the reason explained in stripLeadingHandoffPreamble()'s
// comment below.
const HANDOFF_OPENER_REGEX =
  /^(?:(?:so|now|well|look|honestly|frankly),?\s+)?(here'?s|here is|below is|i(?:'ve| have)|i(?:'ll| will)|i(?:'m| am) going to|let me)\b/i;
const HANDOFF_RESEARCH_REGEX = /\bbased on\b[^.\n]*\b(search results|my research|what i found)\b/i;

function isHandoffOpenerSentence(sentence) {
  return HANDOFF_OPENER_REGEX.test(sentence) || HANDOFF_RESEARCH_REGEX.test(sentence);
}

/**
 * Strip a leading hand-off narration PARAGRAPH from Pass 1's raw concatenated
 * text — a second, independent shape of the same "model narrates before
 * writing" problem concatenateTextBlocks() above fixes at the block level.
 * Confirmed live testing this fix against the real API (2026-07-27, a
 * maintenance-tips topic that triggered 2 rounds of web_search): the model's
 * post-search hand-off remark —
 *   "I have strong material. Now I'll write the article, using specific
 *   facts from authoritative agencies while keeping the piece firmly
 *   non-legal — treating defensible-space clearance distances and code
 *   requirements as items for professional/human verification via inline
 *   flags rather than stating them as verified law."
 * — was NOT a separate block at all; it was fused into the SAME text block
 * as the real heading and article body that immediately followed it (a
 * citation boundary later in that same block is what finally split it into
 * multiple content-array entries). concatenateTextBlocks() cannot separate
 * narration from real content INSIDE one block, no matter how the
 * block-selection boundary is drawn — this has to be handled as text, not
 * as blocks.
 *
 * lib/seo.js's stripLeadingPreambleSeparator() already handles a SHORTER
 * version of exactly this shape (<=200 characters, <=2 sentences before the
 * first heading) — but the real example above is 259 characters, just over
 * that ceiling, so it survived. lib/seo.js is a shared safety net used
 * elsewhere (see its own file comment) and is deliberately left unmodified
 * by this fix — raising its ceiling is a blunter change that risks eating
 * real content anywhere else that safety net runs, not just this one path.
 * This is a narrower, purpose-built check scoped only to Pass 1's own raw
 * response, with NO length ceiling at all. In its place, the safety
 * condition is STRUCTURAL: the candidate is stripped only when EVERY
 * sentence in it (however many, however long) reads as a hand-off opener
 * (isHandoffOpenerSentence() above). A real opening paragraph — even a long
 * one — essentially never has EVERY one of its sentences independently open
 * with "I have.../I'll.../Let me.../Here's..."; that pattern is specific to
 * a model narrating a sequence of its own decisions ("I have X. Now I'll do
 * Y."), not to genuine prose, which only ever opens that way for its first
 * sentence at most (the "direct answer" rule's "brief empathetic opening"
 * allowance) before moving into substantive, differently-shaped sentences.
 * Requiring ALL sentences to match, rather than just one, is what makes it
 * safe to drop the length ceiling entirely.
 *
 * ONE MORE guard on top of that, found necessary during testing: a candidate
 * with only ONE sentence is left alone even if that sentence matches
 * isHandoffOpenerSentence(). "Here's the direct answer to X: <the actual
 * answer>" is a real, encouraged shape per the direct-answer-first-paragraph
 * rule, and a single such sentence sitting alone right before a heading is
 * indistinguishable from real content by structure alone — the "every
 * sentence matches" rule only becomes a safe signal once there's more than
 * one sentence to require agreement across. A genuine hand-off narration
 * chain (this bug's actual shape) is never just one sentence in practice —
 * it's the model narrating a SEQUENCE of decisions, which is inherently
 * multi-sentence — so requiring 2+ leaves the real bug shape fully covered
 * while protecting the single-sentence edge case. Confirmed against a
 * synthetic test case before shipping this: a lone "Here's the direct
 * answer to the question every owner asks: keep your gutters clean."
 * sentence was being wrongly stripped without this guard.
 *
 * @param {string} text - Pass 1's raw concatenated text, before any other
 *   cleanup runs
 * @returns {string} the text with a leading hand-off paragraph removed, or
 *   unchanged if that shape isn't present
 */
function stripLeadingHandoffPreamble(text) {
  if (!text) return text || '';
  const trimmed = text.replace(/^\s+/, '');

  const headingMatch = trimmed.match(FIRST_HEADING_REGEX);
  if (!headingMatch) return text; // no "##"+ heading anywhere — nothing to anchor on

  const candidate = trimmed.slice(0, headingMatch.index).trim();
  if (!candidate) return text; // body already opens with the heading — nothing to strip
  if (/^[-*+]\s|\n[ \t]*[-*+]\s/.test(candidate)) return text; // bullet list — real content, leave alone

  const sentences = splitLeadingSentences(candidate);
  if (sentences.length < 2) return text; // a single matching sentence isn't a safe enough signal alone
  if (!sentences.every(isHandoffOpenerSentence)) return text; // real content mixed in — leave alone

  const rest = trimmed.slice(headingMatch.index).replace(/^\s+/, '');
  return rest || text; // never strip down to nothing
}

/**
 * Collect every real {cited_text, url, title} triple that appears ANYWHERE
 * in a raw Claude response's `content` array, for use as independent
 * verification evidence by lib/seo.js's insertVerifiedQuotes(). This is a
 * SEPARATE pass from concatenateTextBlocks() above, over the SAME raw
 * `content` array, deliberately BEFORE any block-type detail gets discarded
 * — concatenateTextBlocks() only ever keeps the plain `.text` string off
 * each block, which silently drops each `text` block's sibling `.citations`
 * array (present only when that block's content is genuinely grounded in a
 * search result). Losing that before verification could run would mean a
 * quote could only ever be checked against the model's own say-so.
 *
 * Real shape confirmed against a live API response (2026-07-16, building
 * this): a `text` block that Claude wrote immediately after web_search
 * results, when the text is actually grounded in something found, carries a
 * sibling `citations` array (NOT nested inside the text block itself — a
 * peer property alongside `type`/`text` on the SAME block object). Each
 * entry looks like:
 *   { type: "web_search_result_location", cited_text: "...", url: "...",
 *     title: "...", encrypted_index: "..." }
 * `cited_text` is a real excerpt (up to ~150 characters, sometimes truncated
 * mid-word with no ellipsis marker at all) copied by Anthropic's own search
 * system from the actual source page — this is the independent evidence a
 * proposed QUOTED_TEXT entry gets checked against, not anything the model
 * asserts about itself.
 *
 * Runs on Pass 1's raw response, same as before this build's two-pass split
 * — Pass 2 (lib/package-draft.js) is the one that now PROPOSES QUOTED_TEXT
 * entries, but this evidence (captured here, right after Pass 1 returns) is
 * what lib/seo.js's insertVerifiedQuotes() still checks those proposals
 * against, unchanged.
 *
 * @param {object[]} content - response.content from client.messages.create()
 * @returns {{cited_text: string, url: string, title: string|null}[]}
 */
function extractCitedTextEvidence(content) {
  const evidence = [];
  for (const block of content || []) {
    if (!block || !Array.isArray(block.citations)) continue;
    for (const citation of block.citations) {
      if (!citation || typeof citation.cited_text !== 'string' || typeof citation.url !== 'string') {
        continue;
      }
      evidence.push({
        cited_text: citation.cited_text,
        url: citation.url,
        title: typeof citation.title === 'string' ? citation.title : null,
      });
    }
  }
  return evidence;
}

/**
 * Build the block of grounding claims text injected into Pass 1's prompt.
 * Each claim shows its key, status, and statement so the model can ground
 * its writing in them, and so NEEDS_HUMAN_REVIEW claims are visible to it.
 * (Pass 2 — lib/package-draft.js — has its own, simpler copy of this, since
 * it only needs to point at facts already written, not avoid inventing new
 * ones; see that module's comment.)
 */
function formatClaimsForPrompt(claims) {
  if (claims.length === 0) {
    return '(No matching compliance claims were found in the knowledge base for this topic.)';
  }
  return claims
    .map((c, i) => {
      const flag = c.status === 'NEEDS_HUMAN_REVIEW' ? ' [STATUS: NEEDS_HUMAN_REVIEW]' : '';
      return (
        `${i + 1}. claim_key: ${c.claim_key}${flag}\n` +
        `   jurisdiction: ${c.jurisdiction_scope}\n` +
        `   confidence: ${c.confidence}\n` +
        `   statement: ${c.statement}` +
        (c.notes ? `\n   notes: ${c.notes}` : '')
      );
    })
    .join('\n\n');
}

/**
 * LENGTH REQUIREMENT DETECTION — a length/format instruction buried in one
 * sentence of the free-text BRIEF was losing to several OTHER instructions
 * elsewhere in this same prompt that actively push toward being longer/more
 * thorough (most concretely the "research this piece thoroughly... budget
 * for up to 6 searches" web-search rule below, plus the general "write the
 * full draft" framing everywhere else). REAL, CONFIRMED CASE: Peter asked
 * for three paragraphs in the brief for content_items.id =
 * e8316301-7962-4d41-9474-d3155b633445 ("Why now: seasonal demand data") and
 * got back 5 full "##" headed sections with multiple paragraphs each — the
 * length request, one sentence among many, simply lost with nothing calling
 * it out or reinforcing it.
 *
 * Fix: scan the brief for an explicit length signal — a paragraph count, a
 * word count, or a plain-language length descriptor — with coarse, high-
 * recall regexes, and when one is found, surface it in its OWN prominent
 * section right next to the brief (buildLengthRequirementSection() below),
 * plus an always-on hard rule in the system prompt (see buildSystemPrompt()'s
 * lengthRule) that this kind of instruction overrides the thoroughness
 * framing elsewhere. This is deliberately a coarse scanner, not a strict
 * parser: a false positive just adds one reinforcing sentence to the prompt
 * (harmless even if what it found wasn't really a length request); a false
 * negative leaves behavior exactly as it was before this fix. The two
 * numeric signal types (paragraphs/words) are also used AFTER generation by
 * checkLengthCompliance() further below as a real, mechanical check on the
 * actual output, not just a prompt-level ask.
 */
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
};

function parseNumberToken(token) {
  const cleaned = token.toLowerCase().replace(/,/g, '');
  if (/^\d+$/.test(cleaned)) return parseInt(cleaned, 10);
  return NUMBER_WORDS[cleaned] || null;
}

const PARAGRAPH_COUNT_REGEX =
  /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)[\s-]+(?:short\s+|brief\s+|quick\s+)?paragraphs?\b/i;

const WORD_COUNT_REGEX = /\b(\d[\d,]*)\+?\s*(?:-\s*)?words?\b/i;

// Plain-language length asks with no number attached. Not exhaustive — this
// only needs to catch the common phrasings well enough to pull them into
// their own prompt section; anything missed just falls back to the (also
// improved) general hard rule in the system prompt.
const QUALITATIVE_SHORT_REGEX =
  /\b(keep (?:it|this) (?:short|brief|tight)|make (?:it|this) (?:short|brief)|short (?:piece|post|article|draft)|quick (?:piece|post|article|read|draft)|nothing too long|just a (?:quick|short) one)\b/i;

const QUALITATIVE_LONG_REGEX =
  /\b(long-?form|in-?depth|comprehensive piece|thorough(?:ly)? piece|make (?:it|this) (?:long|longer|meaty|substantial)|more (?:thorough|detailed|comprehensive)|go deep|really dig into)\b/i;

// Grabs the sentence around a matched signal (from the start of that
// sentence to its end, or a fallback character window if no clean sentence
// boundary is found) so the callout can quote the editor's own words back
// rather than just naming a category.
function extractSnippet(text, matchIndex, matchLength) {
  const start = Math.max(0, text.lastIndexOf('.', matchIndex) + 1);
  const endSearch = text.indexOf('.', matchIndex + matchLength);
  const end = endSearch === -1 ? Math.min(text.length, matchIndex + matchLength + 80) : endSearch + 1;
  return text.slice(start, end).trim();
}

/**
 * @param {string} text - the brief (draft.js) or feedback text (revise.js
 *   has its own copy of this function — see that module for why)
 * @returns {{type: 'paragraphs'|'words'|'qualitative_short'|'qualitative_long', targetCount: number|null, snippet: string}|null}
 */
function detectLengthSignal(text) {
  if (!text) return null;
  let match = PARAGRAPH_COUNT_REGEX.exec(text);
  if (match) {
    return {
      type: 'paragraphs',
      targetCount: parseNumberToken(match[1]),
      snippet: extractSnippet(text, match.index, match[0].length),
    };
  }
  match = WORD_COUNT_REGEX.exec(text);
  if (match) {
    return {
      type: 'words',
      targetCount: parseInt(match[1].replace(/,/g, ''), 10),
      snippet: extractSnippet(text, match.index, match[0].length),
    };
  }
  match = QUALITATIVE_SHORT_REGEX.exec(text);
  if (match) {
    return { type: 'qualitative_short', targetCount: null, snippet: extractSnippet(text, match.index, match[0].length) };
  }
  match = QUALITATIVE_LONG_REGEX.exec(text);
  if (match) {
    return { type: 'qualitative_long', targetCount: null, snippet: extractSnippet(text, match.index, match[0].length) };
  }
  return null;
}

/**
 * BUG 2 FIX (TARS) — CONFIRM a detectLengthSignal() candidate against the
 * FULL surrounding text via a real Claude comprehension call, before it's
 * ever trusted as a genuine length requirement for THIS piece.
 *
 * WHY A REGEX ALONE ISN'T ENOUGH: detectLengthSignal() above is a coarse,
 * high-recall pattern-matcher — it grabs any number that sits next to
 * "words"/"paragraphs", or a short list of qualitative phrases, with no idea
 * WHAT that number is actually about. TARS's exact repro (deterministic,
 * reproduces every time): a landscaping blog post brief with the aside "the
 * Instagram caption has a 125-word limit — that's just a note for them, not
 * a constraint on this blog post itself." detectLengthSignal() grabbed
 * "125-word" as if it were the ARTICLE's own target. The model itself
 * correctly ignored the decoy when writing — but checkLengthCompliance()
 * (further below) then logged a false "may not have honored the requested
 * length" warning against that wrong 125-word target, which means a REAL
 * miss (see the sibling Bug 1 fix elsewhere in this file) would sit right
 * next to false alarms like this one in the logs, making the whole signal
 * untrustworthy. A budget figure, a different content piece's length, or a
 * date sitting near "words"/"paragraphs" for an unrelated reason are the
 * same shape of problem — no amount of regex special-casing this one
 * "Instagram caption" phrasing closes that class of bug, only reading the
 * surrounding text for what it actually means can.
 *
 * This follows the exact same "cheap targeted AI judgment call, not a
 * bigger regex" precedent already established in this codebase for
 * LEAKED_OPENING_NARRATION (lib/package-draft.js) — a plain phrase-pattern
 * classifier turned out to be structurally unable to tell "the model
 * narrating" from "the model's real content that happens to open the same
 * way" no matter how many more phrasings got added, so that was moved to a
 * real comprehension judgment instead. The length signal has the same
 * shape: no regex can know whether a nearby number is about THIS piece
 * without reading the sentence around it for meaning.
 *
 * COST/LATENCY: only runs when detectLengthSignal() already found a
 * candidate (the common case — no numbers/length phrasing anywhere in the
 * brief — costs nothing extra, unchanged from before this fix). One small,
 * cheap call, not a whole extra drafting pass.
 *
 * FAIL-SAFE DIRECTION: if this confirmation call itself fails (network
 * error, malformed response) it falls back to TRUSTING the original regex
 * candidate, logged clearly — the same "degrade to the old, imperfect
 * behavior, never to nothing" contract extractAfterArticleMarker() above
 * already follows. A transient API hiccup should not silently cost an
 * editor's real length request (that's the Bug 1 failure shape); it's only
 * this confirmation step's JOB to catch a confident false positive, not a
 * license to drop a real one whenever the call itself has trouble.
 *
 * @param {{type: string, targetCount: number|null, snippet: string}|null} candidate
 *   - detectLengthSignal()'s own output
 * @param {string} sourceText - the FULL brief (or single feedback round's
 *   edit_note — see revise.js's identical helper) the candidate was found
 *   in, so the model can read real surrounding context a regex can't see
 * @param {string} logPrefix - e.g. '[draft.js]'
 * @returns {Promise<{type: string, targetCount: number|null, snippet: string}|null>}
 */
async function confirmLengthSignal(candidate, sourceText, logPrefix) {
  if (!candidate) return null;

  try {
    const client = getClient();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: `You are a careful reading-comprehension checker. A simple pattern-matcher scanned a piece of free text (an editor's brief or feedback note for a blog article) and flagged a phrase that MIGHT specify how long the article/piece ITSELF should be.

A phrase like "3 paragraphs" or "125 words" does NOT confirm a length requirement for the article just because it contains a number next to "paragraphs" or "words" — it might instead describe something else entirely: a different platform's caption/character limit (e.g. an Instagram caption), a completely different piece of content, a budget or price figure, a date, a phone number, or any other unrelated number that happens to sit near one of those words. The same caution applies to a qualitative phrase like "keep it short" or "make this long-form" — it might be about something other than this piece too.

Read the FULL TEXT below and decide, from actual context: does it really tell the writer how long THIS article/piece itself should be?

Respond with ONLY this exact JSON object — nothing before it, nothing after it, no markdown fences:
{"appliesToThisPiece": true or false, "type": "paragraphs" or "words" or "qualitative_short" or "qualitative_long" or null, "targetCount": <integer> or null}

- appliesToThisPiece: true only if the text genuinely instructs the writer on the length of the piece itself.
- type/targetCount: if true, the CONFIRMED target — trust your own reading of the full text over the pattern-matcher's guess (correct the type/number if the pattern-matcher got the specifics wrong but the piece does have SOME length instruction). If false, both must be null.`,
      messages: [
        {
          role: 'user',
          content: `FULL TEXT:\n"""\n${sourceText}\n"""\n\nPATTERN-MATCHER'S GUESS: it thinks the phrase "${candidate.snippet}" means this piece should target ${candidate.targetCount != null ? `${candidate.targetCount} ${candidate.type}` : candidate.type}. Confirm or correct this by reading the full text above in context. Respond with the JSON object only.`,
        },
      ],
    });

    const text = (response.content || [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`no JSON object found in response: ${text.slice(0, 200)}`);
    const parsed = JSON.parse(jsonMatch[0]);

    if (parsed.appliesToThisPiece !== true) {
      console.log(
        `${logPrefix} LENGTH SIGNAL CHECK: candidate "${candidate.snippet}" was NOT ` +
          'confirmed as a real length requirement for this piece (comprehension check ' +
          'read it as referring to something else) — discarding it.'
      );
      return null;
    }

    const validTypes = ['paragraphs', 'words', 'qualitative_short', 'qualitative_long'];
    const confirmedType = validTypes.includes(parsed.type) ? parsed.type : candidate.type;
    const confirmedCount = Number.isFinite(parsed.targetCount) ? parsed.targetCount : candidate.targetCount;

    return { type: confirmedType, targetCount: confirmedCount, snippet: candidate.snippet };
  } catch (err) {
    console.warn(
      `${logPrefix} LENGTH SIGNAL CHECK failed (${err.message}) — falling back to the ` +
        `pattern-matcher's own unconfirmed guess ("${candidate.snippet}").`
    );
    return candidate;
  }
}

/**
 * Combines detectLengthSignal() (fast regex candidate) with
 * confirmLengthSignal() (AI comprehension confirmation) — this is the
 * function draftContent() actually calls; see each half's own comment for
 * why the split exists.
 * @param {string} text
 * @param {string} logPrefix
 * @returns {Promise<{type: string, targetCount: number|null, snippet: string}|null>}
 */
async function detectAndConfirmLengthSignal(text, logPrefix) {
  const candidate = detectLengthSignal(text);
  return confirmLengthSignal(candidate, text, logPrefix);
}

/**
 * The prominent, brief-adjacent callout injected by buildUserPrompt() right
 * after the brief itself when detectLengthSignal() finds something — puts
 * the length instruction directly in front of the model a second time,
 * quoted in the editor's own words, rather than trusting it to be noticed
 * once inside ordinary prose. Returns '' (nothing added) when no signal was
 * detected, which is the common case and leaves prompt output byte-for-byte
 * unchanged from before this fix.
 */
function buildLengthRequirementSection(lengthSignal) {
  if (!lengthSignal) return '';
  return `

LENGTH REQUIREMENT DETECTED IN THE BRIEF — READ THIS BEFORE WRITING:
The brief above appears to specify a target length: "${lengthSignal.snippet}"
This is a REQUIREMENT, not a suggestion, and it OVERRIDES every other
instruction in this prompt that pushes toward being longer or more thorough
— including the web-search research budget below, the grounding-claims and
legal-sourcing rules, the general instinct to be comprehensive, AND the
default instruction elsewhere in this prompt to close with a "## Frequently
Asked Questions" section or any standing brand-voice-guide boilerplate
(e.g. a closing "about us" paragraph). This requirement covers the ENTIRE
piece, not just its main paragraphs: if including a full FAQ section and/or
brand-guide boilerplate would push the piece past the requested length, cut
the FAQ section down to a single, tightest-possible Q&A pair (or omit it
entirely) and drop optional boilerplate, rather than exceeding the requested
length. Write to the length the brief actually asked for, even if that means
a noticeably shorter, tighter piece than the topic alone would suggest, or a
longer piece than usual. Being thorough within a short piece means being
well-chosen and specific, not padded — do not add extra "##" sections just
to reach a longer length than the brief requested.`;
}

/**
 * Count paragraph-like blocks in a finished draft — blank-line-separated
 * blocks of prose, excluding headings and bullet-list blocks (a "##"
 * heading or a "- " list isn't what an editor means by "a paragraph" when
 * they ask for a specific count). Coarse on purpose — this only needs to be
 * accurate enough to catch a gross mismatch (3 requested vs. 5 full headed
 * sections), not to be a precise word-processor-style paragraph counter.
 */
function countParagraphs(text) {
  return (text || '')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .filter((block) => !block.startsWith('#'))
    .filter((block) => !/^[-*+]\s/.test(block))
    .length;
}

function countWords(text) {
  return ((text || '').trim().match(/\S+/g) || []).length;
}

/**
 * Mechanically check a finished draft's actual length against an explicit
 * NUMERIC length signal detected in the brief (detectLengthSignal() above) —
 * logged, not enforced or auto-corrected, so a stochastic miss on this one
 * generation is visible rather than silent. Same philosophy as this
 * codebase's other post-generation backstops (the legal-claim structural
 * backstop in lib/legal-review.js, the leaked-narration secondary safety net
 * in lib/package-draft.js): the prompt-level fix above should make this rare,
 * but a plain-code check that doesn't depend on the model succeeding is the
 * only way to actually close the gap when it doesn't.
 *
 * Only runs for the two signal types with a real number to hold the output
 * to (paragraphs/words) — a qualitative signal ("keep it short") has no
 * number to check against, so there's nothing safe to mechanically flag
 * there beyond the prompt-level rule above. Tolerance is deliberately loose
 * (roughly +/-50% for paragraphs, +/-35% for words, with a floor) — this is
 * a "wildly off" backstop for the shape of bug that was actually found (3
 * paragraphs requested, 5 full sections delivered), not a strict word-count
 * enforcer that would fire on every normal, reasonable variance.
 *
 * @param {string} body - the finished draft body to check
 * @param {{type: string, targetCount: number|null, snippet: string}|null} lengthSignal
 * @param {string} logPrefix - e.g. '[draft.js]' / '[revise.js]', plus
 *   whatever identifying context (title, content_item id) is available yet
 */
function checkLengthCompliance(body, lengthSignal, logPrefix, context) {
  if (!lengthSignal || lengthSignal.targetCount == null) return;
  const ctxSuffix = context ? ` (${context})` : '';
  if (lengthSignal.type === 'paragraphs') {
    const actual = countParagraphs(body);
    const target = lengthSignal.targetCount;
    const tolerance = Math.max(1, Math.ceil(target * 0.5));
    if (Math.abs(actual - target) > tolerance) {
      console.warn(
        `${logPrefix} LENGTH CHECK: brief/feedback asked for ~${target} paragraph(s) ` +
          `("${lengthSignal.snippet}") but the generated text has ${actual} paragraph-like ` +
          `block(s)${ctxSuffix} — outside a reasonable tolerance. The model may not have ` +
          'honored the requested length.'
      );
    }
  } else if (lengthSignal.type === 'words') {
    const actual = countWords(body);
    const target = lengthSignal.targetCount;
    const tolerance = Math.max(50, Math.ceil(target * 0.35));
    if (Math.abs(actual - target) > tolerance) {
      console.warn(
        `${logPrefix} LENGTH CHECK: brief/feedback asked for ~${target} words ` +
          `("${lengthSignal.snippet}") but the generated text has ${actual} words${ctxSuffix} ` +
          '— outside a reasonable tolerance. The model may not have honored the requested length.'
      );
    }
  }
}

/**
 * PASS 1 system prompt: research (when applicable) & write ONLY. No SEO
 * metadata, no CLAIMS_USED/CITATION_ANCHORS, no GENERAL_CITATIONS, no
 * QUOTED_TEXT, no RELATED_POSTS — all of that moved to Pass 2
 * (lib/package-draft.js). What stays here is exactly what shapes the
 * writing itself and can't be bolted on after the fact: the legal-grounding
 * hard rule and NEEDS_HUMAN_REVIEW flag mechanism, the brand voice guide,
 * narration suppression, heading structure, the direct-answer-first-
 * paragraph rule, and the web_search tool itself.
 */
function buildSystemPrompt({
  hasTopics,
  hasInspirationPiece = false,
  hasBrandGuide = false,
  hasWebSearch = false,
}) {
  const roleLine = hasTopics
    ? `You are a legal-content drafting assistant for Rincon Management, a
Southern California property management company operating in Ventura County.
You write blog posts, FAQs, and reports for their website.`
    : `You are a content drafting assistant for Rincon Management, a Southern
California property management company operating in Ventura County. You
write blog posts, FAQs, and reports for their website. This particular piece
is not about a regulated legal topic (it might be a market update, general
property-management guidance, maintenance tips, vendor advice, seasonal
reminders, or similar) — so no legal grounding claims are provided for it.
That does not mean the piece has to avoid specifics altogether — see the
hard rules below for the difference between legal facts (forbidden without
grounding) and general/business facts (fine to include when genuinely
relevant).`;

  const hardRules = hasTopics
    ? `HARD RULES — follow these exactly:

1. You may only state a specific legal fact (a rule, a deadline, a dollar
   amount, a percentage, a notice period, a citation) if it is explicitly
   present in the "GROUNDING CLAIMS" section of this prompt, OR if it is the
   one additional fact you researched and sourced yourself per the "WEB
   SEARCH" rule further below. Do not use outside knowledge of California or
   Ventura County law, even if you believe you know the correct rule — every
   legal fact must trace back to one of those two places. If the grounding
   claims don't cover something the topic needs and you cannot find a real,
   specific source for it via web search either, say so in the draft rather
   than filling the gap from memory (use the "[NEEDS HUMAN REVIEW: ...]"
   flag format from rule 2 below to do so).

2. If a grounding claim you used has "[STATUS: NEEDS_HUMAN_REVIEW]" next to
   it, you MUST include a clearly visible flag in the draft itself — not
   just in your own reasoning — so a human reviewer cannot miss it. Use
   this exact format inline where that fact appears:
   "[NEEDS HUMAN REVIEW: <short reason, e.g. "figure not yet verified">]"
   Do not silently smooth over or omit these flags.

3. Do not fabricate a citation, statute number, or ordinance number that
   isn't in the grounding claims — and, for the one additional researched
   legal fact allowed under the "WEB SEARCH" rule further below, do not
   fabricate a source either, or attribute a stated fact to a source that
   didn't actually return it.

4. Never include any tenant's or owner's real name, address, or other
   identifying detail. Case studies must be described as illustrative/
   anonymized, not real individual accounts.

5. Do not include any call to action to "share this on Facebook" or similar
   auto-publish language — a human will handle distribution manually.

6. The direct answer to the piece's core question must land within the
   first paragraph. A brief empathetic opening (1-2 sentences) consistent
   with Rincon's established voice is fine before it, but the concrete
   answer cannot be delayed past that first paragraph. This rule controls
   timing only, not tone — the brand voice guide (if active) still controls
   how it's worded.

7. You may state general, non-legal contextual claims — market statistics,
   program names, industry trend data, and similar — when they genuinely
   strengthen the piece. A separate process reads the finished piece
   afterward and sources anything specific enough to need it, so just write
   naturally; you do not need to produce a citation list yourself. General/
   non-legal claims must NEVER be used to source a legal fact — legal facts
   still come only from the GROUNDING CLAIMS section above.`
    : `HARD RULES — follow these exactly:

1. LEGAL FACTS: This piece has no grounding claims provided, so do not
   state specific legal facts (a rule, a deadline, a dollar amount, a
   percentage, a notice period, a citation, a statute or ordinance number)
   as if they were verified California or Ventura County law. If the brief
   (or something you find via search) drifts into something that would need
   a specific legal fact to write accurately, do not state it — and do not
   explain in prose why you're leaving it out or how you decided to handle
   it. Instead, leave a clearly visible inline flag in this exact format
   wherever that fact would otherwise go:
   "[NEEDS HUMAN REVIEW: <short reason, e.g. "current FMR figure not
   verified against HUD tables">]"
   This bracket flag, placed inline in the sentence where the fact would
   appear, is the ONLY place this caveat belongs — never as a sentence or
   paragraph before the article explaining what you found, what you're
   excluding, or why. This rule is about legal facts specifically — see
   rule 2 below for general/business facts, which are not covered by this
   restriction.

2. GENERAL / BUSINESS FACTS: A market statistic, industry trend, national
   or regional data point, or program detail is NOT a legal fact, and rule
   1 above does not apply to it. When something specific would genuinely
   strengthen this piece, actively use web_search to find one and state it
   with real specificity — naming the actual source by name in your own
   prose (e.g. "according to the National Association of Realtors...") —
   rather than defaulting to vague generalities. A separate process reads
   the finished piece afterward and turns a named source into a formal
   citation link automatically; you do not need to produce any citation
   list or structured field yourself. Never force a fact in if nothing
   genuinely relevant turns up — plain qualitative language is fine, and
   better than a padded-in, low-relevance factoid. General/non-legal facts
   must NEVER be used to source a legal fact — per rule 1, this piece has
   no grounding claims, so no legal fact should be stated at all, sourced
   or not.

   TRACE EVERY GENERAL FACT TO ITS ORIGIN, NOT JUST ITS REPETITION: when you
   research a general/business claim, actively check whether it actually
   traces back to a real primary source — a government agency (e.g. HUD,
   Census, a state housing agency), a named study or report (e.g. a
   university housing-studies report), or a company's own reported data —
   versus whether it's a figure that merely shows up repeated across many
   secondary write-ups (news roundups, blog posts, listicles) with none of
   them actually naming where it originally came from. "Several sources
   repeat this" is not the same thing as "this is verified" — treat those
   as two different tiers of confidence, not one. If a stat is the
   repeated-but-untraceable kind, say so plainly in the sentence where it
   appears (e.g. "a figure widely cited online, though we couldn't trace it
   to an original study or agency") rather than either stating it as flat
   fact or vaguely hedging without explaining why. If it IS traceable to a
   real primary source, say that plainly too, naming the source right in
   the sentence (e.g. "according to the U.S. Census Bureau's Housing
   Vacancy Survey").

3. Never include any tenant's or owner's real name, address, or other
   identifying detail. Case studies must be described as illustrative/
   anonymized, not real individual accounts.

4. Do not include any call to action to "share this on Facebook" or similar
   auto-publish language — a human will handle distribution manually.

5. The direct answer to the piece's core question must land within the
   first paragraph. A brief empathetic opening (1-2 sentences) consistent
   with Rincon's established voice is fine before it, but the concrete
   answer cannot be delayed past that first paragraph. This rule controls
   timing only, not tone — the brand voice guide (if active) still controls
   how it's worded.`;

  // ALWAYS included, regardless of hasTopics/hasWebSearch — unlike
  // webSearchRule below, this is not conditional on web_search being
  // attached to the call. Production evidence showed the model narrating
  // its own editorial reasoning even on calls where web_search was never
  // offered at all (e.g. a legal-grounded revision responding to editor
  // feedback), so this can no longer live only inside the web-search-gated
  // block below. Deliberately an unnumbered bullet, same reasoning as
  // brandGuideRule below — that numbered list's numbers are hardcoded per
  // branch, so a plain bullet can't drift out of sync.
  const noNarrationRule = `

- NEVER NARRATE YOUR OWN PROCESS — ANYWHERE IN THE PIECE, NOT JUST THE
  OPENING: Never write a sentence or paragraph explaining what you're
  excluding, or why. This applies at the very start of your response, in
  the middle of the body under a heading you create for the purpose, or
  anywhere else in your response — the rule is the same everywhere. Do not
  address "the editor" or "you" directly about the writing process. Do not
  explain what you decided to include or leave out and your reasoning for
  it. Do not fabricate a heading (e.g. "A Note on ...") whose sole purpose
  is to house that kind of explanation. If something can't be stated
  confidently, the inline "[NEEDS HUMAN REVIEW: ...]" flag described above
  is the ONLY sanctioned way to say so — used inline, exactly where the
  fact would otherwise go, never with a surrounding explanatory paragraph
  and never under its own dedicated heading. Your response should read,
  start to finish, as nothing but the article itself.`;

  // ALWAYS included, same reasoning as noNarrationRule above (narration risk
  // isn't limited to the web-search path). THIS IS THE PRIMARY DEFENSE
  // against leaked narration, added after two rounds of after-the-fact
  // pattern-matching fixes (stripLeadingHandoffPreamble() below, and
  // lib/seo.js's stripLeadingPreambleSeparator()/stripMidDocumentNarration())
  // proved structurally unable to keep up — TARS found a real leaked case
  // (2026-07-29) where the leaked paragraph's FIRST sentence matched a
  // recognized hand-off phrase but its SECOND sentence was the model
  // genuinely explaining an editorial decision in substantive-sounding
  // language, with no stock opener at all. Real narration doesn't reliably
  // announce itself, so classifying it after the fact by how it opens is
  // fundamentally unreliable. This rule instead prevents the ambiguity from
  // ever reaching the stored draft: everything before this marker is
  // discarded automatically by the parsing code (see
  // extractAfterArticleMarker() above), full stop, regardless of what it
  // says or how it's phrased. The regex-based checks below and in
  // lib/seo.js remain in place underneath this as additional layers, but the
  // marker — not them — is the primary defense from this point on.
  const articleMarkerRule = `

- STRUCTURAL MARKER — THE SINGLE MOST IMPORTANT FORMATTING RULE IN THIS
  PROMPT: The instant you are ready to write the article — whether that's
  immediately, or only after one or more rounds of web_search — the very
  next thing you output, with absolutely nothing before it, must be this
  exact literal line, by itself:

  ${ARTICLE_MARKER}

  No acknowledgment that research is done, no summary of what you found or
  didn't find, no restated plan, no "Here's the article:" lead-in — nothing
  of any kind may come before that line, not even one word, whether or not
  you end up using web_search this turn. Everything you output before this
  marker is discarded automatically and never seen by anyone, so anything
  you place before it is wasted effort at best and actively confusing at
  worst. Reproduce the marker EXACTLY as shown — same characters, same
  case, on its own line — every single time. Everything AFTER the marker is
  the article, and only the article — the "NEVER NARRATE YOUR OWN PROCESS"
  rule above still applies to all of it; the marker is not a place to get
  narration "out of your system" before writing normally.`;

  // ALWAYS included, regardless of whether the brief actually contains a
  // length instruction — same reasoning as noNarrationRule/articleMarkerRule
  // above (a plain, unconditional bullet so it can never silently disappear
  // for one branch). This is the general-purpose half of the length fix; the
  // brief-specific half is buildLengthRequirementSection() above, which adds
  // a second, snippet-quoting callout right next to the brief itself
  // whenever detectLengthSignal() finds an explicit signal there. Real,
  // confirmed bug this fixes: a brief asking for "three paragraphs" produced
  // a 5-section, ~900-word draft (content_items.id =
  // e8316301-7962-4d41-9474-d3155b633445) — the length ask, one sentence
  // among many, lost to the "research thoroughly" framing elsewhere in this
  // same prompt with nothing telling the model it should win.
  //
  // ROUND 2 FIX (TARS, legal-topic length compliance): moved from its old
  // position (right after articleMarkerRule, BEFORE brandGuideRule/
  // inspirationRule/webSearchRule) to HERE — the very last hard rule before
  // headingStructureNote, after the dense webSearchRule block. On a
  // legal-topic piece, webSearchRule (webSearchRuleForLegalTopics) is the
  // single longest, most instruction-dense block in this entire prompt —
  // grounding-claims sourcing, the one-additional-legal-fact allowance, the
  // [LEGAL CLAIM PENDING REVIEW: ...]/[NEEDS HUMAN REVIEW: ...] flagging
  // mechanics, and the quotes-can-never-state-a-legal-fact rule. TARS
  // reproduced 3/3 failures (9/6/10 paragraph-like blocks vs. a requested 3)
  // specifically on a legal-topic brief with this rule sitting BEFORE that
  // block, mid-list — real evidence it was losing the fight for attention to
  // whatever comes last. Sitting last, immediately before the model moves on
  // to HEADING STRUCTURE/tone/closing instructions, gives it the strongest
  // remaining position short of repeating it a third time (which
  // buildUserPrompt's closing paragraph now also does — see there). Wording
  // updated below from "further below" to "above" to match this new
  // position; also now names the FAQ-section default and brand-guide
  // boilerplate explicitly, not just "web search" — TARS's own repro's
  // overage traced mainly to the automatic "## Frequently Asked Questions"
  // section (shouldIncludeFaq()/buildFaqInstruction() below) and, to a
  // lesser extent, a brand-guide-driven closing paragraph, neither of which
  // this rule previously called out by name.
  const lengthRule = `

- LENGTH AND FORMAT REQUIREMENTS IN THE BRIEF ARE HARD REQUIREMENTS, NOT
  SUGGESTIONS — READ THIS LAST, RIGHT BEFORE YOU WRITE: If the brief
  specifies (or a "LENGTH REQUIREMENT DETECTED" callout appears below
  highlighting) a target word count, paragraph count, or a general length
  instruction ("keep this short," "make this a quick piece," "this should be
  long-form/in-depth," and similar), that instruction controls the length of
  this piece and OVERRIDES every other instruction in this prompt that
  pushes toward being longer or more thorough — including the web-search
  research budget above, the grounding-claims and legal-sourcing rules
  above, the general instinct to be comprehensive, AND the default
  instruction elsewhere in this prompt to close with a "## Frequently Asked
  Questions" section or any standing brand-voice-guide boilerplate. A brief
  asking for "three paragraphs" means three paragraphs of actual prose
  total, for the WHOLE piece — not three body paragraphs plus a separate FAQ
  section plus a closing brand paragraph on top. If honoring every other
  instruction in this prompt in full would blow past the requested length,
  the length instruction wins: shrink or drop the FAQ section, shrink or
  drop optional boilerplate, and be more selective about which researched
  facts make it in, rather than exceeding the requested length. If the brief
  says nothing about length at all, write a normal, complete piece exactly
  as you always would — this rule only changes behavior when the brief
  actually asks for something.`;

  // Deliberately an unnumbered bullet rather than continuing the numbered
  // list above — that list's numbers are hardcoded per branch, so a plain
  // bullet can't drift out of sync if a hard rule is later added or removed.
  // Shared with revise.js (lib/brand-guide.js) so the wording never drifts.
  const brandGuideRule = hasBrandGuide
    ? brandGuideSystemRule({
        inspirationNote: hasInspirationPiece
          ? ' If an inspiration piece is also provided below and it ever suggests different style choices than this guide, follow the inspiration piece for this draft — it was chosen specifically for this piece.'
          : '',
      })
    : '';

  const inspirationRule = hasInspirationPiece
    ? `

ADDITIONAL HARD RULE — INSPIRATION PIECE:
The prompt below includes an INSPIRATION PIECE pasted in by the editor. It is
a STYLE REFERENCE ONLY. Mimic its voice, tone, and structure — never its
content. Do not treat anything stated in it as a fact you can use in the
draft, even if it seems plausible or relevant. Every legal fact in your draft
must still come only from the GROUNDING CLAIMS section (or, if there are no
grounding claims, no specific legal facts should be stated at all, per the
rules above).`
    : '';

  // CHANGED BY THIS BUILD: used to be only ever reachable when hasTopics was
  // false — hasWebSearch was only true when the caller attached the
  // web_search tool (see buildWebSearchTool()), which used to never happen
  // for legal-topic drafts at all. Now that buildWebSearchTool() no longer
  // withholds the tool from legal-topic pieces (see that function's own
  // comment), hasWebSearch can be true for BOTH branches — so this now
  // branches on hasTopics too, same as hardRules above, rather than being a
  // single shared block. The hasTopics=false variant is completely UNCHANGED
  // text from before this build; the hasTopics=true variant is new — it adds
  // the one-additional-researched-legal-fact allowance (wrapped in the new
  // "[LEGAL CLAIM PENDING REVIEW: ...]" flag) on top of the same
  // general/non-legal-fact search guidance every piece already gets.
  const webSearchRuleForLegalTopics = `

ADDITIONAL HARD RULE — WEB SEARCH:
Use the web_search tool to research this piece thoroughly — you have a real
budget for this (up to 6 searches), so use it rather than settling for the
first thing you find. This budget is about RESEARCH QUALITY, not article
length: if this piece also has a length requirement (see the LENGTH
callout), thorough research still has to land in a piece that fits that
length — do more searching to find the single best, most specific fact to
include, not to justify including more facts than the requested length has
room for. As with any piece, use it to find and state real, specific,
non-legal facts (market statistics, program names, industry trend data, and
similar) directly in the article's own prose, naming the source by name
where you state something specific — a separate process reads the finished
article afterward and turns a named source into a formal citation
automatically, so you never need to produce a citation list yourself.

You may ALSO use web_search to research and state ONE additional legal fact
that is not covered by the GROUNDING CLAIMS section above — but ONLY under
every one of these conditions:
- You must name the real, specific source in your own prose (e.g. "according
  to the Ventura County Star..." or "per the California Apartment
  Association's..."), never a vague "sources say" or "reports indicate."
- The stated fact must be wrapped in this exact inline flag, placed
  immediately around or adjacent to where the fact appears:
  "[LEGAL CLAIM PENDING REVIEW: <short description of the claim>]"
  This is a DIFFERENT flag from "[NEEDS HUMAN REVIEW: ...]" (rule 2 above),
  and the two must never be confused or used interchangeably:
  "[NEEDS HUMAN REVIEW: ...]" means you found no usable source and are
  declining to state the fact; "[LEGAL CLAIM PENDING REVIEW: ...]" means you
  DID find and name a real source and ARE stating the fact, but it still
  requires a human's sign-off before anyone treats it as verified.
- If your search does not turn up a real, specific, nameable source for a
  legal fact the piece would otherwise need, do not state it at all — flag
  it "[NEEDS HUMAN REVIEW: ...]" instead, exactly per rule 1/2 above. This
  allowance is not a way around that rule — it only ever applies when you
  actually found and can name a real source.
- Limit yourself to ONE such flagged legal fact per piece. If more than one
  genuinely new legal fact would strengthen the piece, research and state
  only the single most important one this way, and flag any others
  "[NEEDS HUMAN REVIEW: ...]" instead.
- Fabricating a citation, statute number, ordinance number, or source — or
  attributing a stated fact to a source that didn't actually return it — is
  still absolutely forbidden, exactly as it is for the GROUNDING CLAIMS
  section, with no exception for this allowance.

The moment your searching is finished, follow the "STRUCTURAL MARKER" rule
above immediately: the ${ARTICLE_MARKER} line comes first, before anything
else — no acknowledgment, no summary of findings, no restated plan. See the
"NEVER NARRATE YOUR OWN PROCESS" rule too: it applies here just as much,
including to describing your search activity specifically (examples of
what NOT to write, anywhere in your response: "I'll research...", "Let me
look up...", "Based on what I found...", "I have enough context...").

ADDITIONAL HARD RULE — QUOTES CAN NEVER STATE A LEGAL FACT:
If you include a direct quotation in the article's own prose — a real
sentence you found via web_search, quoted verbatim and attributed to its
source — that quotation can NEVER be used to state a legal fact (a rule, a
deadline, a dollar amount, a percentage, a notice period, a citation, a
statute or ordinance number), including the ONE additional legal fact
allowance above. This is stated separately from the "WEB SEARCH" rule above
on purpose: a quotation is a MORE persuasive-sounding way to slip a legal
claim past that rule than a paraphrased statistic is, precisely because it
reads as someone else's authoritative words rather than your own — so it
needs its own explicit, unambiguous rule rather than relying on you to infer
it's already covered. If a news article, press release, or any other source
you find states a specific legal deadline or rule, quoting that sentence
verbatim is still YOU stating that legal fact — merely in someone else's
words instead of your own — and it remains just as forbidden as stating it
directly. The one additional legal fact allowance above must always be
stated in your OWN prose, naming the source, never as a direct quotation. A
quote may only ever be used to support a general, non-legal point: market
color, sentiment, a business trend, or an organization characterizing its
own data.`;

  const webSearchRuleForGeneralTopics = `

ADDITIONAL HARD RULE — WEB SEARCH:
Use the web_search tool to research this piece thoroughly — you have a real
budget for this (up to 6 searches), so use it rather than settling for the
first thing you find. Use it to find and state real, specific, non-legal
facts (market statistics, program names, industry trend data, and similar)
directly in the article's own prose, naming the source by name where you
state something specific — a separate process reads the finished article
afterward and turns a named source into a formal citation automatically, so
you never need to produce a citation list yourself. Never use a search
result, no matter how authoritative it looks, to determine, state, or
modify a legal fact; there are no legal grounding claims in this piece, and
that remains true regardless of anything you find via search.

The moment your searching is finished, follow the "STRUCTURAL MARKER" rule
above immediately: the ${ARTICLE_MARKER} line comes first, before anything
else — no acknowledgment, no summary of findings, no restated plan. See the
"NEVER NARRATE YOUR OWN PROCESS" rule too: it applies here just as much,
including to describing your search activity specifically (examples of
what NOT to write, anywhere in your response: "I'll research...", "Let me
look up...", "Based on what I found...", "I have enough context...").

ADDITIONAL HARD RULE — QUOTES CAN NEVER STATE A LEGAL FACT:
If you include a direct quotation in the article's own prose — a real
sentence you found via web_search, quoted verbatim and attributed to its
source — that quotation can NEVER be used to state a legal fact (a rule, a
deadline, a dollar amount, a percentage, a notice period, a citation, a
statute or ordinance number). This is stated separately from the "WEB
SEARCH" rule above on purpose: a quotation is a MORE persuasive-sounding way
to slip a legal claim past that rule than a paraphrased statistic is,
precisely because it reads as someone else's authoritative words rather
than your own — so it needs its own explicit, unambiguous rule rather than
relying on you to infer it's already covered. If a news article, press
release, or any other source you find states a specific legal deadline or
rule, quoting that sentence verbatim is still YOU stating that legal fact —
merely in someone else's words instead of your own — and it remains just as
forbidden as stating it directly, per the LEGAL FACTS rule above. A quote
may only ever be used to support a general, non-legal point: market color,
sentiment, a business trend, or an organization characterizing its own
data.`;

  const webSearchRule = hasWebSearch
    ? (hasTopics ? webSearchRuleForLegalTopics : webSearchRuleForGeneralTopics)
    : '';

  const headingStructureNote = `

HEADING STRUCTURE:
Use Markdown "##" headings for every major section. Work the core topic of
the piece naturally into the first heading — not a vague placeholder like
"Overview." Every heading should be specific enough that a reader skimming
just the headings alone understands what each section covers. This is about
structural clarity for a human skimming the page, not real keyword-volume
optimization — you have no search-volume data, so don't try to game keyword
density. The title itself is captured and displayed separately by the page
— do NOT start the body with a repeated "# <Title>" (or any) heading that
just restates the title. Begin directly with the actual content: an opening
paragraph, or a "##" subheading if that reads better.`;

  return `${roleLine}

${hardRules}${noNarrationRule}${articleMarkerRule}${brandGuideRule}${inspirationRule}${webSearchRule}${lengthRule}${headingStructureNote}

Write in a clear, plain-English, professional tone suitable for a property
management company's website. Avoid legalese where a plain explanation
works. This is marketing/educational content, not legal advice — do not
present it as a substitute for consulting an attorney.

Your response, after the ${ARTICLE_MARKER} marker line, is the article
itself, start to finish — do not add any trailing metadata, JSON, or
structured fields of any kind after the body. A separate process handles
all of that afterward.`;
}

/**
 * Build the one-off "style reference" block injected into the prompt when
 * the caller pastes in an inspiration piece via the "Submit an Idea" form.
 * This text is never persisted anywhere — it only exists for the lifetime of
 * this one prompt string. The instructions here are deliberately explicit
 * and repeated (not just stated once) because this is the one place in the
 * prompt where ungrounded outside text is being handed to the model, and it
 * must not be mistaken for a second source of facts alongside the grounding
 * claims.
 */
function formatInspirationForPrompt(inspirationPiece) {
  return `INSPIRATION PIECE (STYLE REFERENCE ONLY — READ THIS CAREFULLY):
The editor has pasted in an example article below because they want THIS
draft's voice, tone, and structure to be modeled after it. Study its sentence
rhythm, paragraph length, level of formality, use of headers/lists, and
overall shape, and write your draft in a similar style.

Do NOT do any of the following with this inspiration piece:
- Do not treat anything it says as a fact, statistic, rule, deadline, dollar
  amount, or legal claim you can use in the draft.
- Do not copy or paraphrase specific claims, numbers, examples, or case
  details from it into the draft.
- Do not treat it as a second source of grounding alongside the GROUNDING
  CLAIMS section. The grounding claims section (if present above) remains the
  ONLY source of legal facts for this draft — that rule is unchanged by this
  inspiration piece being here.

If the inspiration piece happens to cover the same topic and states a legal
fact that conflicts with, duplicates, or goes beyond the grounding claims,
ignore that fact entirely — only mimic the writing style, never the content.

--- START INSPIRATION PIECE (style reference only, not a factual source) ---
${inspirationPiece}
--- END INSPIRATION PIECE ---

`;
}

/**
 * Whether this draft should end with a "## Frequently Asked Questions"
 * section: always for content_type='faq' itself, and also for blog posts /
 * market reports that are grounded in real legal topics (general content
 * with no topics has no grounding claims to draw specific FAQ answers from).
 */
function shouldIncludeFaq(contentType, hasTopics) {
  return (
    contentType === 'faq' ||
    (hasTopics && (contentType === 'blog_post' || contentType === 'market_report'))
  );
}

/**
 * CHANGED BY THIS FIX (TARS, legal-topic length compliance): now takes the
 * detected lengthSignal so the FAQ section itself can be told to shrink or
 * disappear when the brief also asked for a short piece — before this fix,
 * this instruction was unconditional ("End the body with a FAQ section",
 * full stop) regardless of anything else in the prompt, including an
 * explicit "exactly 3 paragraphs" request. CONFIRMED as the dominant driver
 * of TARS's repro (Q, live test): a "3 paragraphs" brief on security-deposits
 * produced 4 real body paragraphs (already close to the request) PLUS a
 * 4-pair FAQ section the model added because shouldIncludeFaq() forced it —
 * the FAQ alone accounted for most of the overage (9 total paragraph-like
 * blocks vs. 3 requested). The base FAQ instruction is unchanged for the
 * common case (no length signal, or a generous one) — this only adds an
 * extra paragraph when isTight below is true.
 */
function buildFaqInstruction(lengthSignal) {
  const base = ` End the body with a "## Frequently Asked Questions" section.
Format each pair exactly as:

**Q: <question>**
A: <answer>

Write FAQ questions that reflect this piece's specific angle from the brief
and grounding claims above, not the topic's most generic/obvious question —
assume other posts on this site may already cover the basic version of this
topic.`;

  // "Tight" thresholds are deliberately generous (6 paragraphs / 400 words)
  // — the goal isn't to catch every edge case exactly, it's to catch the
  // shape of brief that a full multi-question FAQ obviously can't fit
  // inside (TARS's repro asked for 3). A brief with no signal, or a signal
  // well above these thresholds, gets the unchanged base instruction.
  const isTight =
    lengthSignal &&
    ((lengthSignal.type === 'paragraphs' && lengthSignal.targetCount != null && lengthSignal.targetCount <= 6) ||
      (lengthSignal.type === 'words' && lengthSignal.targetCount != null && lengthSignal.targetCount <= 400) ||
      lengthSignal.type === 'qualitative_short');

  if (!isTight) return base;

  return `${base}

This piece ALSO has a length requirement (see the LENGTH REQUIREMENT
callout above) — the FAQ section counts toward that total; it is not
"extra" content on top of it. Keep this FAQ section to at most ONE tight
Q&A pair, or omit the FAQ section entirely, whichever actually fits within
the requested length alongside the rest of the piece. A short brief with a
full multi-question FAQ tacked on is exactly the kind of overage this length
requirement exists to prevent.`;
}

/**
 * PASS 1 user prompt: title, brief, grounding claims, brand guide,
 * inspiration piece, and the instruction to write the full draft. No
 * RELATED POST CANDIDATES and no trailing-fields instruction — both moved
 * to Pass 2 (lib/package-draft.js), which sees the finished body instead.
 */
function buildUserPrompt({
  title,
  brief,
  contentType,
  claims,
  hasTopics,
  inspirationPiece,
  brandGuideContent,
  lengthSignal,
}) {
  const groundingSection = hasTopics
    ? `GROUNDING CLAIMS (the only source of legal facts you may use):
${formatClaimsForPrompt(claims)}

`
    : '';

  const brandGuideSection = brandGuideContent
    ? formatBrandGuideForPrompt(brandGuideContent)
    : '';

  const inspirationSection = inspirationPiece
    ? formatInspirationForPrompt(inspirationPiece)
    : '';

  const faqInstruction = shouldIncludeFaq(contentType, hasTopics) ? buildFaqInstruction(lengthSignal) : '';

  // See buildLengthRequirementSection()'s own comment — '' (nothing added)
  // when the brief has no detectable length signal, which is the common
  // case and leaves this prompt byte-for-byte unchanged from before this fix
  // (buildLengthRequirementSection()'s own leading "\n\n" supplies the blank
  // line before it when non-empty, so nothing extra is added here).
  const lengthRequirementSection = buildLengthRequirementSection(lengthSignal);

  // Final, closest-to-generation reminder — repeated a third time (after the
  // brief-adjacent callout above and the system prompt's lengthRule) because
  // this is the literal last thing the model reads before it starts writing.
  // '' when there's no signal, so this leaves the prompt byte-for-byte
  // unchanged from before this fix in the common case.
  const finalLengthReminder = lengthSignal
    ? ` Before you start writing: this piece has a length requirement
(${lengthSignal.snippet.length > 80 ? `${lengthSignal.snippet.slice(0, 80)}...` : lengthSignal.snippet}) that
still wins over every research/grounding/FAQ instruction above — hold to it.`
    : '';

  return `Draft a ${contentType.replace('_', ' ')} with the working title:
"${title}"

Angle / brief from the editor:
${brief}${lengthRequirementSection}

${groundingSection}${brandGuideSection}${inspirationSection}Write the full draft now. The moment you're ready to write (after any
research), the very next thing you output must be the line
${ARTICLE_MARKER} by itself, with nothing before it — then continue
immediately with the draft itself. Structure it appropriately for a ${contentType.replace('_', ' ')}
(e.g. a blog post gets a headline, intro, subheadings, and conclusion; an FAQ
gets a list of Q&A pairs).${faqInstruction}${finalLengthReminder}`;
}

/**
 * Draft a piece of content grounded in the compliance knowledge base.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.brief - the angle/summary of what to write
 * @param {string} opts.contentType - one of VALID_CONTENT_TYPES
 * @param {string[]} [opts.topicKeywords] - keywords to match against compliance_topics.topic_key.
 *   Optional — leave empty/omitted for general content that isn't legal in nature (e.g.
 *   maintenance tips, vendor advice, seasonal reminders). When empty, the compliance-claims
 *   lookup is skipped entirely and the draft is written from title + brief alone, with no
 *   legal citations and nothing linked in content_item_compliance_claims.
 * @param {string} [opts.sourceTopicSuggestionId] - if drafted from a topic_suggestions row
 * @param {string} [opts.authorName]
 * @param {string} [opts.inspirationPiece] - a one-off reference article pasted in by the
 *   editor for THIS draft only. Used purely as a voice/tone/structure model in the prompt —
 *   never treated as a source of facts, and never persisted anywhere (not on content_items,
 *   not anywhere else). Omit/leave empty for the normal (unchanged) drafting behavior.
 * @returns {Promise<{contentItem: object, claimsUsed: object[], claimsFlaggedForReview: object[]}>}
 */
async function draftContent({
  title,
  brief,
  contentType,
  topicKeywords = [],
  sourceTopicSuggestionId = null,
  authorName = null,
  inspirationPiece = null,
}) {
  if (!title || !brief) {
    throw new Error('title and brief are required');
  }
  if (!VALID_CONTENT_TYPES.includes(contentType)) {
    throw new Error(
      `contentType must be one of: ${VALID_CONTENT_TYPES.join(', ')} (got "${contentType}")`
    );
  }
  if (!Array.isArray(topicKeywords)) {
    throw new Error('topicKeywords must be an array of strings (or omitted/empty)');
  }

  // Detected once here (rather than re-derived inside buildUserPrompt) so
  // the same signal object can also drive the post-generation
  // checkLengthCompliance() call further below — see detectLengthSignal()'s
  // own comment for the bug this addresses. CHANGED BY THE BUG 2 FIX: now
  // goes through detectAndConfirmLengthSignal() (regex candidate + AI
  // comprehension confirmation), not detectLengthSignal() alone — see that
  // function's own comment for why a plain regex candidate is no longer
  // trusted directly (a decoy number elsewhere in the brief, e.g. an
  // Instagram caption's own word limit, was being mistaken for the
  // article's own length target).
  const lengthSignal = await detectAndConfirmLengthSignal(brief, '[draft.js]');

  // 1. Ground the draft in the actual legal knowledge base — but only if the
  // caller actually selected topics. No topics means this isn't legal content
  // (e.g. maintenance tips, vendor advice, seasonal reminders), so we skip the
  // lookup entirely rather than asking getGroundingClaims to match zero
  // keywords against every topic (which would just return nothing anyway,
  // but skipping is clearer about intent and cheaper).
  const hasTopics = topicKeywords.length > 0;
  const [groundingResult, brandGuide] = await Promise.all([
    hasTopics ? getGroundingClaims(topicKeywords) : Promise.resolve({ topics: [], claims: [] }),
    // Persistent voice/style guidance saved in the database — independent of
    // topics/grounding. Returns null if Peter hasn't uploaded one yet (the
    // seed row has content=NULL), in which case generation is unaffected.
    getActiveBrandGuide(),
  ]);
  const { topics, claims } = groundingResult;
  const brandGuideContent = brandGuide ? brandGuide.content : null;

  // 1b. Look up internal-link candidates BEFORE Pass 2 (not needed by Pass 1
  // at all now — RELATED_POSTS moved entirely to Pass 2, see
  // lib/package-draft.js) so it can be shown the real title list and asked
  // to declare 0-2 of them. When this piece has no legal topic (the majority
  // of real articles), fall back to keyword-overlap scoring against
  // title+brief instead of the topic-based lookup, which would otherwise
  // return nothing at all here.
  let internalLinkCandidates = [];
  if (hasTopics && topics.length > 0) {
    internalLinkCandidates = await getInternalLinkCandidates(topics.map((t) => t.id), null);
  } else if (!hasTopics) {
    internalLinkCandidates = await getGeneralInternalLinkCandidates(title, brief, null);
  }

  // 2. PASS 1 — ask Claude to research and write, grounded in those claims
  // (when there are any). CHANGED BY THIS BUILD: the web_search tool is now
  // attached regardless of hasTopics (see buildWebSearchTool()) — legal-topic
  // drafts are no longer denied the tool outright. The safety boundary for
  // legal-topic pieces now lives in the prompt (buildSystemPrompt()'s
  // hasTopics-branched webSearchRule) plus the downstream
  // detectLegalClaims()/legal_claim_reviews review gate, not in withholding
  // the tool.
  const webSearchTool = buildWebSearchTool();
  const tools = webSearchTool ? [webSearchTool] : undefined;

  const client = getClient();
  const pass1Response = await client.messages.create({
    model: MODEL,
    // Pass 1 no longer needs headroom for trailing SEO/citation/quote/
    // related-post fields (all moved to Pass 2 — see lib/package-draft.js),
    // but a full article body (especially a flagship report) can still
    // legitimately run long, so this stays generous. max_tokens is a cap,
    // not a cost floor — headroom that isn't actually used doesn't cost
    // anything.
    max_tokens: 8192,
    ...(tools ? { tools } : {}),
    system: buildSystemPrompt({
      hasTopics,
      hasInspirationPiece: Boolean(inspirationPiece),
      hasBrandGuide: Boolean(brandGuideContent),
      hasWebSearch: Boolean(webSearchTool),
    }),
    messages: [
      {
        role: 'user',
        content: buildUserPrompt({
          title,
          brief,
          contentType,
          claims,
          hasTopics,
          inspirationPiece,
          brandGuideContent,
          lengthSignal,
        }),
      },
    ],
  });

  const pass1Text = concatenateTextBlocks(pass1Response.content);
  if (!pass1Text) {
    throw new Error('Claude response contained no text block');
  }
  // Collected from the SAME raw Pass 1 response, separately from
  // concatenateTextBlocks() above and BEFORE anything about block-type
  // detail is discarded — the only evidence lib/seo.js's
  // insertVerifiedQuotes() is allowed to trust when deciding whether a
  // proposed QUOTED_TEXT quote (now proposed by Pass 2) is real.
  const citedTextEvidence = extractCitedTextEvidence(pass1Response.content);
  // Real pages Pass 1's web_search tool actually surfaced (titles/URLs, plus
  // any real excerpt actually quoted from each) — handed to Pass 2 below so
  // its GENERAL_CITATIONS/QUOTED_TEXT proposals can draw on what was really
  // found, not just Pass 1's finished prose. Empty when hasTopics is true
  // (no web_search tool attached at all) or when Pass 1 simply didn't search.
  const searchEvidence = extractSearchResultsEvidence(pass1Response.content);

  // PRIMARY defense against leaked narration — see ARTICLE_MARKER's own
  // comment above. Trust the structural marker over trying to classify
  // whatever text comes before it. Falls back to the raw pass1Text (the old
  // behavior, protected only by the regex layers below) if the model didn't
  // emit the marker — logged so a real regression here doesn't pass through
  // silently, since compliance with this instruction should be very close to
  // 100%.
  const afterMarker = extractAfterArticleMarker(pass1Text);
  if (afterMarker === null) {
    console.warn(
      `[draft.js] Pass 1 response did not contain the expected "${ARTICLE_MARKER}" ` +
        'marker — falling back to the full response text and the pre-marker ' +
        'narration cleanup layers only.'
    );
  }
  const rawBody = afterMarker !== null ? afterMarker : pass1Text;

  // Narration/preamble/stray-title-heading cleanup runs here, right after
  // Pass 1, rather than after Pass 2 — Pass 1 is still the pass doing the
  // searching and writing, so this is still its problem to have cleaned up
  // before anyone else reads its output. Handing Pass 2 the ALREADY-CLEANED
  // article also means every anchor_text it names is guaranteed to match
  // text that's actually still in the final stored body. These layers are
  // now a SECONDARY safety net underneath the marker above (the marker
  // already removed the leading narration in the normal case) — kept in
  // place as belt-and-suspenders, and as the full fallback path when the
  // marker itself is missing.
  // stripLeadingHandoffPreamble() runs FIRST — it catches a longer hand-off
  // paragraph fused into the same text block as the real content (see its
  // own comment above for why concatenateTextBlocks() can't catch this at
  // the block level) that lib/seo.js's stripLeadingPreambleSeparator()'s
  // 200-character ceiling misses. Running it first means
  // stripLeadingPreambleSeparator() still gets a clean, unmodified shot at
  // the shorter cases it already handles.
  let body = stripLeadingHandoffPreamble(rawBody);
  body = stripLeadingPreambleSeparator(body);
  body = stripLeadingTitleHeading(body);
  body = stripMidDocumentNarration(body);

  // Post-generation length backstop (see checkLengthCompliance()'s own
  // comment) — checked against Pass 1's own body, BEFORE Pass 2 appends a
  // FAQ section and/or "## Related Reading"/"## Sources" sections below,
  // since those are separate structural add-ons, not part of what a brief's
  // length request is asking about, and would otherwise skew this check
  // toward false positives on an otherwise-compliant draft.
  checkLengthCompliance(body, lengthSignal, '[draft.js]', title);

  // 3. PASS 2 — package the finished draft: SEO title/description, which
  // claims got used, general/non-legal citation proposals, quote proposals,
  // related-post picks (lib/package-draft.js, shared with lib/revise.js).
  const packaged = await packageDraft({
    articleBody: body,
    claims,
    includeClaimsUsedField: true,
    internalLinkCandidates,
    searchEvidence,
    pass1HasWebSearch: Boolean(webSearchTool),
  });
  const {
    seoTitle,
    metaDescription,
    claimKeysUsed,
    citationAnchors,
    generalCitations,
    quotedText,
    relatedPosts,
    cleanedArticleBody,
  } = packaged;

  // SECONDARY safety net: Pass 2 makes a COMPREHENSION judgment (not a
  // phrase match) about whether the text it was handed opens with leaked
  // process-narration, and lib/package-draft.js's stripLeakedOpeningNarration()
  // mechanically verifies and removes it before returning cleanedArticleBody
  // — see that file's header comment ("SECONDARY NARRATION SAFETY NET").
  // cleanedArticleBody equals `body` unchanged whenever Pass 2 found nothing
  // to flag, which should be nearly every run now that the marker above is
  // the primary defense. Logged when it DOES differ, since that means
  // narration survived the marker AND every regex layer above — useful
  // signal if this keeps happening.
  if (cleanedArticleBody !== body) {
    console.warn(
      '[draft.js] Pass 2 detected and stripped leaked opening narration that ' +
        'survived the Pass 1 marker and the earlier regex cleanup layers — ' +
        'see lib/package-draft.js\'s stripLeakedOpeningNarration(). This should ' +
        'be rare; if it keeps happening, investigate why ARTICLE_MARKER isn\'t ' +
        'being honored.'
    );
  }
  body = cleanedArticleBody;

  // Only link claims that were both retrieved AND actually cited by the model.
  const claimsUsed = claims.filter((c) => claimKeysUsed.includes(c.claim_key));
  const claimsFlaggedForReview = claimsUsed.filter((c) => c.status === 'NEEDS_HUMAN_REVIEW');

  // 3c. Legal-claim detection (lib/package-draft.js's detectLegalClaims(),
  // shared with lib/revise.js). Runs on the same finished, already-cleaned
  // body Pass 2 packaged — BEFORE the mechanical link-insertion passes below,
  // so a flagged claim_text is plain prose for a reviewer, not markdown link
  // syntax. `claimsUsed` (not the broader `claims` candidate list) is the
  // reference set of "already grounded" facts — the narrowest accurate
  // choice, so this safety net errs toward flagging rather than toward
  // silently missing something (see detectLegalClaims()'s own comment).
  // Detection itself is pure/DB-free and safe to always run; the DB write
  // right after step 4 below is wrapped in try/catch (see there) since
  // legal_claim_reviews is a newer table that may not exist yet on every
  // environment this code runs against.
  //
  // Captured into bodyForLegalScan, not just inlined, because the
  // STRUCTURAL BACKSTOP below (findMissingLegalClaimBracketFindings())
  // must scan this EXACT SAME pre-link-insertion text — not the `body`
  // variable as it stands after the insertVerifiedQuotes()/
  // insertCitationLinks()/insertGeneralCitations()/
  // insertRelatedReadingAndSourcesSections() calls below reassign it.
  // CONFIRMED LIVE (Q, first real end-to-end test run of this backstop):
  // link insertion can rewrite text inside the same sentence a bracket sits
  // in (turning a nearby phrase into a markdown link), which changed the
  // sentence-chunk text enough that the backstop's own coverage check
  // against Layer 1/2's claim_text (itself captured from THIS pre-insertion
  // text) spuriously read as "not covered" — creating a redundant second
  // row for a bracket Layer 1/2 had already caught correctly, while a
  // genuinely different bracket went unchecked. Scanning the same text
  // basis Layer 1/2 used keeps the two aligned; same fix already applied in
  // lib/revise.js's own bodyForLegalScan for the identical reason.
  const bodyForLegalScan = body;
  const legalClaimFindings = await detectLegalClaims(bodyForLegalScan, claimsUsed);

  // General/non-legal citations that passed the domain-allowlist gate
  // (lib/general-citation-domains.js) — computed once and reused by both
  // insertGeneralCitations() (mid-paragraph linking) and
  // insertRelatedReadingAndSourcesSections() (bibliography half), so both agree
  // on exactly which
  // AI-proposed sources are trustworthy enough to appear anywhere on the
  // page. Independent of claimsUsed/compliance_claims — see lib/seo.js.
  const allowedGeneralCitations = filterAllowedGeneralCitations(
    generalCitations,
    GENERAL_CITATION_DOMAINS
  );

  // 3b. SEO post-processing — mechanical, no further AI calls (lib/seo.js).
  // Verified quotes (from QUOTED_TEXT, checked against citedTextEvidence —
  // runs BEFORE citation/general-citation linking specifically so a wrong
  // quote — the more serious failure per Oracle's finding, see
  // insertVerifiedQuotes()'s comment in lib/seo.js — gets first claim on its
  // own anchor_text rather than possibly losing it to an unrelated citation
  // anchor), then legal citation links (from claimsUsed, matched via Pass 2's
  // own CITATION_ANCHORS), then general/non-legal citation links (from the
  // allowlist-gated proposals), then a "Related Reading" section built from
  // Pass 2's declared+validated RELATED_POSTS together with a "Sources"
  // bibliography listing every claim used and every allowlisted general
  // citation regardless of whether it also got linked inline — the two are
  // built together, in a fixed order, so that order stays stable across
  // revision rounds even if one section has nothing to add on a given round
  // (see insertRelatedReadingAndSourcesSections()'s comment in lib/seo.js).
  // FAQ schema extraction runs last against whatever body text survives.
  body = insertVerifiedQuotes(body, quotedText, citedTextEvidence, WEB_SEARCH_ALLOWED_DOMAINS);
  body = insertCitationLinks(body, claimsUsed, citationAnchors);
  body = insertGeneralCitations(body, allowedGeneralCitations, GENERAL_CITATION_DOMAINS);
  body = insertRelatedReadingAndSourcesSections(
    body,
    internalLinkCandidates,
    relatedPosts,
    claimsUsed,
    allowedGeneralCitations
  );
  const faqSchemaJson = extractFaqSchema(body);

  // 4. Insert the draft into content_items. faq_schema is parsed back into
  // a real object here (rather than stored as the JSON.stringify()'d
  // string extractFaqSchema() returns) so it lands in the JSONB column as
  // an actual JSON object, not a JSON string containing escaped JSON.
  const [contentItem] = await insert('content_items', {
    content_type: contentType,
    title,
    body,
    status: 'draft',
    author_name: authorName,
    source_topic_suggestion_id: sourceTopicSuggestionId,
    meta_description: metaDescription,
    seo_title: seoTitle,
    faq_schema: faqSchemaJson ? JSON.parse(faqSchemaJson) : null,
  });

  // 5. Link every claim actually used.
  if (claimsUsed.length > 0) {
    await insert(
      'content_item_compliance_claims',
      claimsUsed.map((c) => ({
        content_item_id: contentItem.id,
        compliance_claim_id: c.id,
      }))
    );
  }

  // 6. Tag this item with every matched topic, so this brand-new post
  // participates in future internal-linking the same way backfilled
  // historical posts do (both read from content_item_topics).
  if (hasTopics && topics.length > 0) {
    await insert(
      'content_item_topics',
      topics.map((t) => ({
        content_item_id: contentItem.id,
        topic_id: t.id,
      }))
    );
  }

  // 7. Write any legal-claim findings from step 3c and recompute
  // legal_review_status — needs contentItem.id, so this can only happen now
  // that step 4 has inserted the row. Wrapped in try/catch: this is a new,
  // purely additive safety net bolted onto an otherwise-working pipeline —
  // a failure here (a transient Claude API error on Layer 2, a Supabase
  // hiccup) must never prevent a draft that Pass 1/Pass 2 already
  // successfully wrote from being saved and returned to Peter.
  try {
    const newFindings = await filterNewLegalClaimFindings(contentItem.id, legalClaimFindings);
    let insertedReviewRows = [];
    if (newFindings.length > 0) {
      insertedReviewRows = await insert(
        'legal_claim_reviews',
        newFindings.map((f) => ({
          content_item_id: contentItem.id,
          claim_text: f.claimText,
          claim_context: f.context,
          // NOT NULL with no DB default — detectLegalClaims() only fills
          // this in on a best-effort basis (a markdown link sitting right
          // in the flagged text). No source found is itself useful signal
          // for Mason's review, not an error, so it's recorded plainly
          // rather than papered over.
          source_url: f.sourceUrl || '(no source found in article text — flagged for review)',
          // Same "unknown until a human assesses it" convention the
          // migration already uses for source_tier's own DB default.
          jurisdiction_scope: 'unknown',
          detected_by: f.detectedBy,
        }))
      );
    }
    // STRUCTURAL BACKSTOP (TARS, 2026-08-08): a plain-code, no-AI-call scan
    // of the saved article body for every "[LEGAL CLAIM PENDING REVIEW: ...]"
    // bracket, run regardless of whether Layer 1/2 above caught everything —
    // see lib/legal-review.js's findMissingLegalClaimBracketFindings() for
    // the full reasoning (a real, live-reproduced gap: Layer 2's
    // AI-comprehension call can stochastically miss a bracketed claim, so a
    // deterministic check that doesn't depend on that call succeeding is the
    // only way to actually close it). Runs AFTER the Layer 1/2 insert above
    // so its own DB read sees those rows too and correctly treats them as
    // already covered. detected_by: 'structural_flag_scan' keeps a
    // backstop-created row visibly distinguishable in the data from a normal
    // Layer 1/2 catch. Scans bodyForLegalScan (the SAME pre-link-insertion
    // text detectLegalClaims() above just scanned, captured above) — NOT
    // `body`, which by this point has been reassigned by the SEO
    // link-insertion passes below in the pipeline (see bodyForLegalScan's
    // own comment for why that mismatch mattered in practice).
    const missingBracketFindings = await findMissingLegalClaimBracketFindings(contentItem.id, bodyForLegalScan);
    if (missingBracketFindings.length > 0) {
      console.warn(
        `[draft.js] STRUCTURAL BACKSTOP fired for content_item ${contentItem.id}: found ` +
          `${missingBracketFindings.length} [LEGAL CLAIM PENDING REVIEW] bracket(s) with no ` +
          'matching legal_claim_reviews row — detectLegalClaims() Layer 1/2 missed it this run. ' +
          'Inserting fallback row(s) now. This should be rare; if it keeps happening, investigate ' +
          'why Layer 2 is missing it.'
      );
      const structuralRows = await insert(
        'legal_claim_reviews',
        missingBracketFindings.map((f) => ({
          content_item_id: contentItem.id,
          claim_text: f.claimText,
          claim_context: f.context,
          source_url: f.sourceUrl || '(no source found in article text — flagged for review)',
          jurisdiction_scope: 'unknown',
          detected_by: f.detectedBy,
        }))
      );
      insertedReviewRows = insertedReviewRows.concat(structuralRows);
    }

    // BUG FIX (TARS, 2026-08-08): recomputeLegalReviewStatus() writes the
    // fresh status straight to the database, but `contentItem` below (this
    // function's return value) was captured back at step 4's insert() call,
    // BEFORE this detection/recompute step ran — so the OBJECT this function
    // returns to its caller kept whatever legal_review_status the DB
    // default gave it at insert time ('not_required'), even on a run where
    // the real, current value is 'needs_review'. Confirmed live: the
    // database's actual column was correctly 'needs_review' while the
    // returned object still read 'not_required'. The live publish gate
    // itself was never affected (content-review's server always re-queries
    // fresh from the database rather than trusting a passed-in object), but
    // any future code that trusts this returned value on this specific
    // safety-relevant field would have been silently wrong. Patching the
    // already-captured object's field (rather than re-selecting the whole
    // row) is enough — recomputeLegalReviewStatus()'s return value IS the
    // authoritative fresh status it just wrote, so there's no reason to
    // pay for a second round-trip to re-fetch what we already have.
    contentItem.legal_review_status = await recomputeLegalReviewStatus(contentItem.id);

    // Mason's automatic review pass (lib/legal-review.js's
    // reviewClaimAsMason()) — runs for each row just inserted above
    // (including any structural-backstop row from just above), right after
    // insert, per this feature's own build spec. Each claim is reviewed
    // independently and wrapped in its OWN try/catch: one claim's review
    // failing (a flaky web_fetch, a transient rate limit) must never stop
    // Mason from reviewing the OTHER claims in this same batch, and must
    // never undo the draft/legal_claim_reviews rows that already saved
    // successfully above. A failed review just leaves mason_finding null —
    // exactly the state it was already in — so there's nothing to roll back.
    for (const row of insertedReviewRows) {
      try {
        await reviewClaimAsMason(row.id);
      } catch (e) {
        console.warn(
          `[draft.js] Mason's automatic review failed for legal_claim_reviews row ` +
            `${row.id} (content_item ${contentItem.id}) — mason_finding stays null ` +
            `until a manual or retried review runs. ${e.message}`
        );
      }
    }
  } catch (e) {
    console.warn(
      `[draft.js] Legal-claim detection write/recompute failed for content_item ` +
        `${contentItem.id} — the draft itself was saved successfully; only the ` +
        `legal-review safety net did not run this time. ${e.message}`
    );
  }

  return { contentItem, claimsUsed, claimsFlaggedForReview };
}

module.exports = { draftContent, VALID_CONTENT_TYPES };
