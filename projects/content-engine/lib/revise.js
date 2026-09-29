/**
 * lib/revise.js
 * "Feedback in, revised draft out" loop — the AI revision step that runs
 * when Peter clicks "Revise with AI" on a draft sitting in needs_changes.
 *
 * Mirrors lib/draft.js's structure and safety rules, but instead of
 * starting from a brief, it starts from:
 *   1. The draft's current title + body (the only surviving record of the
 *      draft — content_items does not store the original brief/angle)
 *   2. Every round of feedback Peter has left in content_edits for this
 *      item (field_changed='status', after_text='needs_changes'), oldest
 *      first, so multiple rounds of notes are all addressed
 *   3. Whatever compliance claims are already linked to this item via
 *      content_item_compliance_claims — so the revision stays grounded in
 *      the same verified facts as the original draft, rather than
 *      silently losing its legal grounding on a rewrite
 *
 * Same hard rule as first-draft generation: the model may not introduce a
 * new legal fact that isn't already in the linked claims. If addressing
 * feedback would require a new legal fact, it must flag that inline with
 * "[NEEDS HUMAN REVIEW: ...]" instead of inventing one.
 *
 * TWO-PASS PIPELINE (same split as lib/draft.js, same reasoning): PASS 1
 * (this file's own Claude call) addresses the feedback and rewrites the
 * article — nothing else. PASS 2 (lib/package-draft.js, shared with
 * draft.js — its job is identical there: finished article + fact list +
 * related-post candidates in, metadata out) packages the result: SEO title/
 * description, citation anchors for the (already-fixed) linked claims,
 * general/non-legal citation proposals, quote proposals, related-post
 * picks. reviseContent()'s own signature and return shape are UNCHANGED —
 * this is an internal implementation detail; the content-review app needs
 * zero changes.
 *
 * This module does not publish anything and does not talk to any social
 * platform, email service, or CMS — it only writes to Supabase.
 */

const { getClient } = require('./anthropic');
const { select, insert, update } = require('./supabase');
const { getActiveBrandGuide, formatBrandGuideForPrompt, brandGuideSystemRule } = require('./brand-guide');
const { getInternalLinkCandidates, getGeneralInternalLinkCandidates } = require('./compliance');
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
  escapeRegExp,
} = require('./seo');
const { GENERAL_CITATION_DOMAINS, WEB_SEARCH_ALLOWED_DOMAINS } = require('./general-citation-domains');
const { packageDraft, extractSearchResultsEvidence, detectLegalClaims } = require('./package-draft');
const {
  recomputeLegalReviewStatus,
  filterNewLegalClaimFindings,
  findMissingLegalClaimBracketFindings,
  reviewClaimAsMason,
} = require('./legal-review');

const MODEL = 'claude-opus-4-8';

// Off-switch for the web_search tool (see buildWebSearchTool() below). Only
// the literal string "false" disables it — unset, empty, or any other value
// defaults to enabled. Read at call time (not cached at module load) so a
// test run can flip process.env.ENABLE_WEB_SEARCH_CITATIONS between calls
// without re-requiring this module. Kept as its own copy here, same as
// draft.js's identical helper — see that module's copy for the fuller
// comment on why these two files don't share a prompt-fragment module.
function webSearchEnabled() {
  return process.env.ENABLE_WEB_SEARCH_CITATIONS !== 'false';
}

/**
 * Build the web_search tool entry for the `tools` array, or null.
 *
 * CHANGED BY THIS BUILD, same change as draft.js's identical helper: this
 * used to return null outright whenever `hasTopics` was true (legal grounding
 * claims linked to this item) — the tool was withheld entirely, not merely
 * instructed against. That isolation boundary is REMOVED as of this build:
 * an item with linked legal topics now gets the exact same tool, on the
 * exact same on/off switch and budget, as any other item. The safety
 * mechanism for legal-topic revisions has moved from "the tool isn't there"
 * to a prompt-level hard rule (see buildSystemPrompt()'s hasTopics-branched
 * webSearchRule below): the model MAY research and state one additional,
 * real-sourced legal fact beyond the linked GROUNDING CLAIMS, but only
 * wrapped in the new "[LEGAL CLAIM PENDING REVIEW: ...]" flag, which routes
 * it into lib/package-draft.js's detectLegalClaims() -> legal_claim_reviews
 * for Mason's and Peter's sign-off before it's ever treated as verified (see
 * supabase/migrations/20260801000000_legal_claim_reviews.sql). Fabricating a
 * citation or source remains just as forbidden as it always was.
 *
 * The only remaining gate here is the plain on/off switch (webSearchEnabled())
 * — no longer conditioned on `hasTopics` at all, so this function no longer
 * takes that parameter. Uses WEB_SEARCH_ALLOWED_DOMAINS, NOT the raw
 * GENERAL_CITATION_DOMAINS — see that file's comment on why a handful of
 * crawler-blocked domains must be excluded from allowed_domains specifically
 * (a single blocked domain in that param fails the whole request). `max_uses:
 * 6` — real room for Pass 1 to research thoroughly instead of stopping after
 * a search or two; unchanged by this build.
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
 * that make up the actual revision, in order. Same fix as draft.js's
 * identical helper — see that module's copy for the fuller comment. Short
 * version: naively joining every text block put the model's pre-search
 * narration ("I'll research X...") at the top of the stored body whenever
 * web_search actually fired. First fix: drop every text block before the
 * FIRST non-text (tool-related — `server_tool_use` / `web_search_tool_result`)
 * block. That didn't generalize once the search budget was raised to 6 uses
 * and multi-round searching became common — narration sitting BETWEEN two
 * search rounds still sits after the first tool block, so it survived. Fix:
 * drop every text block up through the LAST non-text block instead of the
 * first — only text after the FINAL tool call is real content. When there is
 * no non-text block at all (the normal non-search path), fall back to
 * concatenating every text block, unchanged from before.
 *
 * Runs on Pass 1's raw response only — Pass 2 (lib/package-draft.js) never
 * writes article prose, so it grabs its one text block directly.
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
 * ROUND 3 FIX — the PRIMARY defense against leaked narration. Kept as its
 * own copy here, same as concatenateTextBlocks() above — see draft.js's
 * identical helper/ARTICLE_MARKER constant for the fuller reasoning: TARS
 * (2026-07-29) proved the pattern-matching approach behind
 * stripLeadingHandoffPreamble() below (and lib/seo.js's
 * stripLeadingPreambleSeparator()/stripMidDocumentNarration()) is
 * structurally unreliable — a real leaked case had a first sentence that
 * matched a recognized hand-off phrase but a second sentence that was
 * genuine substantive editorial reasoning with no stock opener at all. The
 * fix: instruct the model (see buildSystemPrompt()'s articleMarkerRule
 * below) to emit this exact literal line, alone, immediately before the
 * revised article begins — nothing may precede it — and trust that
 * structural anchor completely during parsing, rather than continuing to
 * guess at what counts as narration after the fact.
 */
const ARTICLE_MARKER = '===ARTICLE BELOW===';

// Same regex-building approach as draft.js's identical helper — kept as a
// function (not a top-level compiled regex) so a fresh, rewound `lastIndex`
// is guaranteed on every call.
function buildArticleMarkerLineRegex() {
  const escaped = ARTICLE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^[ \\t]*${escaped}[ \\t]*$`, 'gm');
}

/**
 * Find the LAST occurrence of the ARTICLE_MARKER line in Pass 1's raw
 * concatenated text and return everything after it. Same primary-defense
 * role as draft.js's identical helper — see that module's copy for the
 * fuller comment. Returns null if the marker isn't found anywhere (the
 * model didn't comply), so the caller can fall back to the pre-marker
 * pipeline (extractTitleAndBody()'s own search-anywhere TITLE match, plus
 * stripLeadingHandoffPreamble() and lib/seo.js's regex layers).
 * @param {string} text - Pass 1's raw concatenated text
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
// never the full revision. Same shape as lib/seo.js's private
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
// actual article content, so a first-person-SINGULAR sentence opener like
// this essentially never occurs in real substantive prose — it's a safe,
// narrow signal. Same pattern lib/seo.js's own leading-preamble check relies
// on, reimplemented locally (not imported) for the reason explained in
// stripLeadingHandoffPreamble()'s comment below.
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
 * maintenance-tips topic that triggered 2 rounds of web_search — see
 * draft.js's identical helper for the exact reproduced example): the model's
 * post-search hand-off remark was NOT a separate block at all; it was fused
 * into the SAME text block as the real heading and body content that
 * immediately followed it (a citation boundary later in that same block is
 * what finally split it into multiple content-array entries).
 * concatenateTextBlocks() cannot separate narration from real content INSIDE
 * one block, no matter how the block-selection boundary is drawn — this has
 * to be handled as text, not as blocks.
 *
 * lib/seo.js's stripLeadingPreambleSeparator() already handles a SHORTER
 * version of exactly this shape (<=200 characters, <=2 sentences before the
 * first heading) — but the real repro case (draft.js's identical helper) ran
 * 259 characters, just over that ceiling, so it survived. lib/seo.js is a
 * shared safety net used elsewhere (see its own file comment) and is
 * deliberately left unmodified by this fix — raising its ceiling is a
 * blunter change that risks eating real content anywhere else that safety
 * net runs, not just this one path. This is a narrower, purpose-built check
 * scoped only to Pass 1's own raw response, with NO length ceiling at all.
 * In its place, the safety condition is STRUCTURAL: the candidate is
 * stripped only when EVERY sentence in it (however many, however long)
 * reads as a hand-off opener (isHandoffOpenerSentence() above). A real
 * opening paragraph — even a long one — essentially never has EVERY one of
 * its sentences independently open with "I have.../I'll.../Let
 * me.../Here's..."; that pattern is specific to a model narrating a sequence
 * of its own decisions ("I have X. Now I'll do Y."), not to genuine prose,
 * which only ever opens that way for its first sentence at most before
 * moving into substantive, differently-shaped sentences. Requiring ALL
 * sentences to match, rather than just one, is what makes it safe to drop
 * the length ceiling entirely.
 *
 * ONE MORE guard on top of that, found necessary during testing (see
 * draft.js's identical helper for the fuller comment and the synthetic case
 * that caught it): a candidate with only ONE sentence is left alone even if
 * it matches isHandoffOpenerSentence() — a real hand-off narration CHAIN
 * (this bug's actual shape) is inherently multi-sentence, so requiring 2+
 * leaves the real bug fully covered while protecting a lone, legitimate
 * "Here's the direct answer: ..." opening sentence from being mistaken for
 * narration.
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
 * verification evidence by lib/seo.js's insertVerifiedQuotes(). Kept as its
 * own copy here, same as concatenateTextBlocks() above — see draft.js's
 * identical helper for the fuller comment on the real, confirmed response
 * shape (a `text` block's sibling `.citations` array, each entry
 * `{ type: "web_search_result_location", cited_text, url, title,
 * encrypted_index }`) and why this is a separate pass over the SAME raw
 * `content` array rather than something derived from concatenateTextBlocks()'s
 * already-flattened output.
 *
 * Runs on Pass 1's raw response, same as before this build's two-pass split
 * — Pass 2 is the one that now PROPOSES QUOTED_TEXT entries, but this
 * evidence is what lib/seo.js's insertVerifiedQuotes() still checks those
 * proposals against, unchanged.
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

// Matches the "## Sources" heading — same shape as lib/seo.js's own private
// SOURCES_HEADING_REGEX, reimplemented locally rather than imported/exported
// from that file. Kept out of lib/seo.js deliberately: this build's own
// constraints scope that file to "how a proposal gets turned into a real
// link" (link-insertion/quote-verification mechanics), left untouched here —
// this is a read-only EXTRACTION of what a PRIOR round already wrote into
// the stored body, feeding what Pass 2 PROPOSES next round, not a change to
// how any link gets inserted.
const SOURCES_HEADING_REGEX = /^##[ \t]*Sources[ \t]*$/im;

// Matches the "## Related Reading" heading — same shape as lib/seo.js's own
// private RELATED_READING_HEADING_REGEX, reimplemented locally for the exact
// same reason SOURCES_HEADING_REGEX above is kept local rather than imported.
// Used only by stripSourcesSectionForLegalScan() below (see that function's
// comment) — extractPreviousGeneralCitations() above deliberately does NOT
// need this one, since a "## Related Reading" bullet never uses the
// "AI-SUGGESTED SOURCE" link-title marker GENERAL_SOURCE_BULLET_REGEX/
// INLINE_GENERAL_CITATION_REGEX match on, so it was never at risk of being
// misread as a general citation.
const RELATED_READING_HEADING_REGEX = /^##[ \t]*Related Reading[ \t]*$/im;

// One "## Sources" bibliography bullet for a GENERAL (non-legal) citation —
// exactly the line shape lib/seo.js's insertRelatedReadingAndSourcesSections()
// writes for one: `- [title](url "AI-SUGGESTED SOURCE")`. A legal-citation
// bullet has no title attribute at all (`- [text](url)`), so matching on the
// "AI-SUGGESTED SOURCE" link-title alone already tells the two apart — no
// separate "**Additional Sources**" sub-heading match needed.
const GENERAL_SOURCE_BULLET_REGEX = /^-\s*\[(.+?)\]\((\S+)\s+"AI-SUGGESTED SOURCE"\)\s*$/gim;

// A MID-PARAGRAPH "AI-SUGGESTED SOURCE" link — i.e. exactly what lib/seo.js's
// insertGeneralCitations() itself writes at the matched anchor_text location
// inside the body's own prose: `[anchor phrase](url "AI-SUGGESTED SOURCE")`,
// with no leading "- " bullet and not anchored to a full line the way
// GENERAL_SOURCE_BULLET_REGEX is. Reuses the identical marker, so this MUST
// only ever be run against prose that has already had the "## Sources"
// section (and everything after it) removed — see
// extractPreviousGeneralCitations() below — otherwise a bibliography bullet's
// own title would be misread as an anchor phrase.
const INLINE_GENERAL_CITATION_REGEX = /\[(.+?)\]\((\S+)\s+"AI-SUGGESTED SOURCE"\)/g;

/**
 * CONTINUITY FIX: recover the GENERAL (non-legal) citations the LAST round
 * actually ended up with, by reading them back out of the "## Sources"
 * section (for title/url) AND the article's own prose (for the actual
 * anchor phrase that was linked there) that round's own lib/seo.js
 * post-processing already wrote into the draft's stored body — i.e. exactly
 * what reviseContent() receives as its own `currentBody` parameter, BEFORE
 * this round's Pass 1 rewrites it.
 *
 * Needs no new database column and no new table: title+url+anchor text is
 * exactly what already survives round to round inside the stored article
 * text itself. title+url tells Pass 2 "this same source was already cited"
 * (see lib/package-draft.js's buildUserPrompt()/generalCitationsStep, which
 * still asks Pass 2 to re-derive a FRESH anchor_text against this round's
 * body rather than trusting a stale phrase verbatim). The anchorText
 * captured here serves a DIFFERENT, narrower purpose:
 * carryForwardVerbatimGeneralCitations() below uses it as a structural
 * backstop — if Pass 2 fails to re-propose a source whose exact previous
 * anchor phrase is still sitting untouched in the new body, it gets carried
 * forward deterministically, without relying on the model having decided to
 * keep it. See that function's own comment for why prompting alone (the
 * generalCitationsContinuityRule in lib/package-draft.js) wasn't reliable
 * enough on its own.
 *
 * A citation can appear in the "## Sources" bibliography WITHOUT ever having
 * gotten a working inline link (lib/seo.js's computeSourceEntries() lists
 * every allowlisted proposal "independent of whether an anchor was found for
 * it") — for that entry, anchorText comes back null (nothing was found in
 * the prose-only scan) and carryForwardVerbatimGeneralCitations() correctly
 * leaves continuity for it to Pass 2's own judgment, since there is no
 * previously-verified phrase to structurally check against.
 *
 * A first-ever revision round (no "## Sources" section yet, or one with no
 * general entries — e.g. a piece grounded only in legal claims) correctly
 * returns [] — there is nothing to carry forward yet, same as before this
 * fix.
 *
 * @param {string} body - the draft's CURRENT (pre-revision) stored body,
 *   i.e. reviseContent()'s own `currentBody` parameter, unmodified
 * @returns {{title: string, url: string, anchorText: string|null}[]} deduped
 *   by url
 */
function extractPreviousGeneralCitations(body) {
  const text = body || '';
  const headingMatch = text.match(SOURCES_HEADING_REGEX);
  if (!headingMatch) return [];

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const rest = text.slice(sectionStart);
  const nextHeadingMatch = rest.match(/\n##\s/);
  const section = nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest;

  // Everything BEFORE the "## Sources" heading — the article's real prose
  // (plus "## Related Reading", if present, which never uses this marker —
  // see INLINE_GENERAL_CITATION_REGEX's own comment for why that's safe).
  // Excluding the bibliography itself is what stops its own title-as-link-
  // text bullets from being misread as anchor phrases below.
  const proseBeforeSources = text.slice(0, headingMatch.index);

  const seenUrls = new Set();
  const citations = [];
  GENERAL_SOURCE_BULLET_REGEX.lastIndex = 0;
  let match;
  while ((match = GENERAL_SOURCE_BULLET_REGEX.exec(section))) {
    const title = match[1].trim();
    const url = match[2].trim();
    if (!title || !url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    citations.push({ title, url });
  }

  // Build a url -> first-matched-anchor-phrase map from the prose itself.
  const inlineAnchorsByUrl = new Map();
  INLINE_GENERAL_CITATION_REGEX.lastIndex = 0;
  let inlineMatch;
  while ((inlineMatch = INLINE_GENERAL_CITATION_REGEX.exec(proseBeforeSources))) {
    const anchorText = inlineMatch[1].trim();
    const url = inlineMatch[2].trim();
    if (!anchorText || !url || inlineAnchorsByUrl.has(url)) continue;
    inlineAnchorsByUrl.set(url, anchorText);
  }

  for (const citation of citations) {
    citation.anchorText = inlineAnchorsByUrl.get(citation.url) || null;
  }

  return citations;
}

/**
 * LEGAL-CLAIM-SCAN FIX: strip everything from whichever of the "##  Related
 * Reading" or "## Sources" headings appears FIRST in the body, onward,
 * before running detectLegalClaims() on a revision's body — reuses the SAME
 * SOURCES_HEADING_REGEX boundary extractPreviousGeneralCitations() above
 * already relies on (plus RELATED_READING_HEADING_REGEX, added below),
 * rather than reinventing a second way to find where either section starts.
 *
 * WHY THIS IS NEEDED: at the point step 3c (below, in reviseContent()) calls
 * detectLegalClaims(revisedBody, claims), `revisedBody` still contains BOTH
 * of the PREVIOUS round's "## Related Reading" and "## Sources" sections —
 * Pass 1 is handed the whole `currentBody` (both sections included) and
 * naturally preserves/reproduces them while rewriting the rest of the
 * article, and THIS round's own versions of both sections aren't rebuilt
 * until insertRelatedReadingAndSourcesSections() runs later (see
 * reviseContent()'s own comment on why that ordering is what it is).
 * Confirmed live (TARS, 2026-08-02): running detectLegalClaims() on the
 * unstripped text produced 3 "new" legal_claim_reviews rows that were just
 * citation strings lifted verbatim from the article's own "## Sources"
 * reference list (e.g. "Civil Code § 1950.5, photo documentation
 * requirement...") — not real new claims in the article's prose. Stripping
 * only "## Sources" fixed that, but left a second leak of the same shape:
 * confirmed live (TARS, 2026-08-02, round 3) that a "## Related Reading"
 * entry whose internal-link TITLE happens to be citation-shaped (e.g. a post
 * titled "Understanding Oxnard's Ordinance No. 9042 Move-In Fee Rules") gets
 * scanned too, since insertRelatedReadingAndSourcesSections() in lib/seo.js
 * always writes "## Related Reading" BEFORE "## Sources" — i.e. strictly
 * EARLIER in the body — when both are present, so cutting only at "##
 * Sources" left the Related Reading section sitting in the scanned text.
 * Left unfixed, either leak spams the review queue with a spurious
 * legal_claim_reviews row on essentially every revision of a legal-topic
 * article (Rincon's own legal-topic post titles routinely contain ordinance/
 * statute numbers, so the Related Reading leak recurs routinely, not
 * rarely).
 *
 * Deliberately strips to the END of the string from that earliest heading,
 * not just to the next "##" heading the way extractPreviousGeneralCitations()'s
 * own `section` local does — that function needs the bibliography's own
 * contents (to read title/url pairs back out of it); this one only needs
 * everything from the earliest of the two headings gone, since none of it is
 * the article's real prose regardless of what sections might structurally
 * follow (Related Reading always precedes Sources when both are present —
 * see insertRelatedReadingAndSourcesSections()'s own comment in lib/seo.js —
 * but this takes the earlier of the two matches rather than assuming that
 * ordering, so it stays correct even if only one section is present, or if
 * that canonical order ever changes).
 *
 * Returns `body` completely unchanged when NEITHER heading is found (a
 * first-ever revision round, or a piece with no related posts and no general
 * citations at all) — same fail-safe contract every other anchor-based
 * helper in this codebase follows: no match means leave the text alone.
 *
 * @param {string} body
 * @returns {string}
 */
function stripSourcesSectionForLegalScan(body) {
  const text = body || '';
  const sourcesMatch = text.match(SOURCES_HEADING_REGEX);
  const relatedMatch = text.match(RELATED_READING_HEADING_REGEX);

  const cutIndexes = [sourcesMatch, relatedMatch]
    .filter(Boolean)
    .map((m) => m.index);
  if (cutIndexes.length === 0) return text;

  return text.slice(0, Math.min(...cutIndexes));
}

/**
 * STRUCTURAL SAFETY NET for GENERAL_CITATIONS continuity, sitting alongside
 * (not instead of) the prompted version of this same rule — see
 * generalCitationsContinuityRule in lib/package-draft.js. Real testing (a
 * revision that reworded exactly one paragraph while explicitly leaving two
 * other named-source paragraphs 100% untouched) found Pass 2 still silently
 * dropping a previously-cited source even though the exact sentence naming
 * it hadn't changed at all and previousGeneralCitations was passed in
 * correctly — i.e. the model doesn't reliably follow this instruction just
 * because the supporting text provably didn't move. Rather than trying a
 * fourth wording of the same prompt rule, this makes the common case
 * (untouched paragraph, untouched claim) independent of the model's
 * cooperation entirely.
 *
 * For every citation the LAST round ended up with (title/url/anchorText from
 * extractPreviousGeneralCitations()): if Pass 2 THIS round didn't already
 * re-propose the same url, AND that citation had a verified inline anchor
 * phrase last round (anchorText non-null — see that function's comment for
 * when it isn't), AND that EXACT phrase is still found verbatim
 * (case-insensitive — same matching rule lib/seo.js's insertGeneralCitations()
 * itself uses when it goes to actually link it) somewhere in THIS round's
 * revised body, force it back into the list. Deliberately conservative in
 * one direction only: this ADDS a citation whose supporting phrase is proven
 * still present, verbatim; it never removes anything Pass 2 proposed, and it
 * never adds one back just because the model claims the underlying fact is
 * "still true" — only because the literal previously-cited phrase is still
 * sitting in the body, unchanged.
 *
 * @param {object[]} proposedCitations - GENERAL_CITATIONS as returned by
 *   Pass 2 this round, each {title, url, anchor_text, supports}
 * @param {{title: string, url: string, anchorText: string|null}[]} previousCitations
 *   - extractPreviousGeneralCitations()'s output
 * @param {string} newBody - this round's revised body, i.e. the exact text
 *   lib/seo.js's insertGeneralCitations() is about to run its own anchor
 *   search against
 * @returns {object[]} proposedCitations with any missing-but-still-verbatim
 *   previous citation appended
 */
function carryForwardVerbatimGeneralCitations(proposedCitations, previousCitations, newBody) {
  const proposed = Array.isArray(proposedCitations) ? proposedCitations.slice() : [];
  const proposedUrls = new Set(
    proposed.filter((c) => c && typeof c.url === 'string').map((c) => c.url)
  );
  const body = newBody || '';

  for (const prev of previousCitations || []) {
    if (!prev || !prev.url || proposedUrls.has(prev.url)) continue;
    if (!prev.anchorText) continue; // no previously-verified phrase to check — leave to Pass 2's judgment

    const regex = new RegExp(escapeRegExp(prev.anchorText), 'i');
    if (!regex.test(body)) continue; // phrase genuinely gone this round — correctly not carried forward

    proposed.push({
      title: prev.title,
      url: prev.url,
      anchor_text: prev.anchorText,
      supports:
        "Carried forward structurally: this source's previously-cited phrase is still present verbatim in the article.",
    });
    proposedUrls.add(prev.url);
  }

  return proposed;
}

/**
 * Fetch every "Request Changes" note left on a content item, oldest first.
 * @param {string} contentItemId
 * @returns {Promise<{edit_note: string, created_at: string, edited_by: string}[]>}
 */
async function getFeedbackHistory(contentItemId) {
  const rows = await select(
    'content_edits',
    `select=edit_note,created_at,edited_by&content_item_id=eq.${contentItemId}` +
      `&field_changed=eq.status&after_text=eq.needs_changes&order=created_at.asc`
  );
  return rows.filter((r) => r.edit_note && r.edit_note.trim());
}

/**
 * Fetch the compliance claims already linked to a content item (via
 * content_item_compliance_claims), so the revision can stay grounded in the
 * same verified facts as the original draft.
 * @param {string} contentItemId
 */
async function getLinkedClaims(contentItemId) {
  const links = await select(
    'content_item_compliance_claims',
    `select=compliance_claims(*)&content_item_id=eq.${contentItemId}`
  );
  return links.map((l) => l.compliance_claims).filter(Boolean);
}

/**
 * Fetch the topic_ids this content item was tagged with (content_item_topics),
 * so a revision can reuse the same topic set for internal-linking and FAQ
 * gating that the original draft was tagged with — without re-deriving it
 * from topic keywords, which revise.js never had access to in the first
 * place (only draft.js's caller supplies topicKeywords).
 * @param {string} contentItemId
 * @returns {Promise<string[]>}
 */
async function getLinkedTopicIds(contentItemId) {
  const rows = await select(
    'content_item_topics',
    `select=topic_id&content_item_id=eq.${contentItemId}`
  );
  return rows.map((r) => r.topic_id);
}

function formatFeedbackForPrompt(feedbackHistory) {
  return feedbackHistory
    .map((f, i) => `${i + 1}. (${new Date(f.created_at).toLocaleDateString()}) ${f.edit_note.trim()}`)
    .join('\n');
}

function formatClaimsForPrompt(claims) {
  if (claims.length === 0) {
    return '(No compliance claims are currently linked to this draft. This means the draft was not grounded in specific legal facts to begin with — do not introduce any new legal facts (a rule, a deadline, a dollar amount, a percentage, a notice period, a citation) now, and flag anything that would need legal grounding. This restriction is about legal facts specifically — a general market or business fact (a market statistic, industry trend, or similar) is not covered by it and should be stated with real specificity when genuinely relevant, not avoided altogether.)';
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
 * LENGTH REQUIREMENT DETECTION — same fix, and same reasoning, as draft.js's
 * identical helpers (kept as its own copy here, same convention as this
 * file's other duplicated prompt helpers — see e.g. formatClaimsForPrompt()
 * above or concatenateTextBlocks() up top for why draft.js/revise.js don't
 * share a prompt-fragment module). A length/format instruction buried in one
 * round of free-text feedback competes for attention against the same
 * thoroughness-pushing instructions this file's own prompt carries (the
 * "research this revision thoroughly... budget for up to 6 searches"
 * web-search rule below, plus the general "address the feedback, write the
 * full revised piece" framing). Nothing before this fix called a length
 * request in the feedback out as a priority, or checked the result against
 * it — see draft.js's identical helper for the real, confirmed case this
 * class of bug produced on first-draft generation.
 *
 * detectLengthSignalFromFeedback() below is the one difference from
 * draft.js's copy: revise.js has no single "brief" field — the equivalent
 * free text is potentially SEVERAL rounds of feedback
 * (formatFeedbackForPrompt() above lists them oldest-first) — so this scans
 * every round and keeps the LAST one that contains a signal, on the
 * assumption that the most recent length instruction is the one still in
 * effect (same "prefer the last occurrence" convention this file's own
 * extractAfterArticleMarker() and draft.js's identical helper already use
 * for the same reason: a later statement supersedes an earlier one).
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

const QUALITATIVE_SHORT_REGEX =
  /\b(keep (?:it|this) (?:short|brief|tight)|make (?:it|this) (?:short|brief)|shorten (?:it|this)|cut (?:it|this) down|trim (?:it|this) down|short (?:piece|post|article|draft)|quick (?:piece|post|article|read|draft)|nothing too long|just a (?:quick|short) one)\b/i;

const QUALITATIVE_LONG_REGEX =
  /\b(long-?form|in-?depth|comprehensive piece|thorough(?:ly)? piece|make (?:it|this) (?:long|longer|meaty|substantial)|lengthen (?:it|this)|expand (?:it|this)|more (?:thorough|detailed|comprehensive)|go deep|really dig into)\b/i;

function extractSnippet(text, matchIndex, matchLength) {
  const start = Math.max(0, text.lastIndexOf('.', matchIndex) + 1);
  const endSearch = text.indexOf('.', matchIndex + matchLength);
  const end = endSearch === -1 ? Math.min(text.length, matchIndex + matchLength + 80) : endSearch + 1;
  return text.slice(start, end).trim();
}

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
 * @param {{edit_note: string}[]} feedbackHistory - oldest first, same shape
 *   getFeedbackHistory() returns
 * @returns {{signal: {type: string, targetCount: number|null, snippet: string}, sourceText: string}|null}
 *   the LAST feedback round's length signal candidate PLUS the exact
 *   edit_note text it was found in (needed by confirmLengthSignal() below,
 *   which reads that same source text for context a regex can't see) — or
 *   null if none of the rounds have one. CHANGED BY THE BUG 2 FIX: used to
 *   return just the signal; now also returns sourceText, since
 *   confirmLengthSignal() needs the specific round's own text, not the
 *   whole multi-round history, to judge whether the candidate is really
 *   about this piece.
 */
function detectLengthSignalCandidateFromFeedback(feedbackHistory) {
  let last = null;
  for (const f of feedbackHistory || []) {
    const signal = detectLengthSignal(f && f.edit_note);
    if (signal) last = { signal, sourceText: f.edit_note };
  }
  return last;
}

/**
 * BUG 2 FIX (TARS) — same confirmation call as draft.js's identical helper;
 * see that module's copy for the full reasoning (a plain regex match on
 * "125-word" grabbed an unrelated Instagram-caption limit as if it were the
 * ARTICLE's own target — the fix is a real comprehension check, not more
 * regex special-casing, following the same precedent already set by
 * LEAKED_OPENING_NARRATION in lib/package-draft.js). Kept as its own copy
 * here, same convention as this file's other duplicated prompt helpers.
 * Reworded for "feedback" rather than "the brief". Same fail-safe direction
 * as draft.js's copy: on any failure of this confirmation call itself, falls
 * back to trusting the original regex candidate (logged), never silently
 * drops a possibly-real request just because this extra check had trouble.
 * @param {{type: string, targetCount: number|null, snippet: string}|null} candidate
 * @param {string} sourceText - the specific feedback round's own edit_note
 *   text the candidate was found in
 * @param {string} logPrefix
 * @returns {Promise<{type: string, targetCount: number|null, snippet: string}|null>}
 */
async function confirmLengthSignal(candidate, sourceText, logPrefix) {
  if (!candidate) return null;

  try {
    const client = getClient();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: `You are a careful reading-comprehension checker. A simple pattern-matcher scanned a piece of free text (an editor's feedback note on a draft blog article) and flagged a phrase that MIGHT specify how long the article/piece ITSELF should be.

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
 * Combines detectLengthSignalCandidateFromFeedback() (fast regex candidate,
 * scanning every feedback round) with confirmLengthSignal() (AI
 * comprehension confirmation against that specific round's own text) — this
 * is the function reviseContent() actually calls.
 * @param {{edit_note: string}[]} feedbackHistory
 * @param {string} logPrefix
 * @returns {Promise<{type: string, targetCount: number|null, snippet: string}|null>}
 */
async function detectAndConfirmLengthSignalFromFeedback(feedbackHistory, logPrefix) {
  const found = detectLengthSignalCandidateFromFeedback(feedbackHistory);
  if (!found) return null;
  return confirmLengthSignal(found.signal, found.sourceText, logPrefix);
}

/**
 * Same callout as draft.js's identical helper, reworded for "feedback"
 * rather than "the brief" — see that module's comment for the full
 * reasoning. Returns '' when no signal was detected.
 */
function buildLengthRequirementSection(lengthSignal) {
  if (!lengthSignal) return '';
  return `

LENGTH REQUIREMENT DETECTED IN THE FEEDBACK — READ THIS BEFORE WRITING:
The feedback above appears to specify a target length: "${lengthSignal.snippet}"
This is a REQUIREMENT, not a suggestion, and it OVERRIDES every other
instruction in this prompt that pushes toward being longer or more thorough
— including the web-search research budget below, the grounding-claims and
legal-sourcing rules, the general instinct to be comprehensive, AND the
default instruction elsewhere in this prompt to include a "## Frequently
Asked Questions" section or any standing brand-voice-guide boilerplate
(e.g. a closing "about us" paragraph). This requirement covers the ENTIRE
piece, not just its main paragraphs: if keeping a full FAQ section and/or
brand-guide boilerplate would push the piece past the requested length, cut
the FAQ section down to a single, tightest-possible Q&A pair (or drop it
entirely) and drop optional boilerplate, rather than exceeding the requested
length. Revise to the length the feedback actually asked for, even if that
means a noticeably shorter, tighter piece than the current draft, or a
longer piece than usual. Being thorough within a short piece means being
well-chosen and specific, not padded — do not add extra "##" sections just
to reach a longer length than requested.`;
}

// Same coarse, "good enough for a gross-mismatch backstop" counters as
// draft.js's identical helpers — see that module's comment.
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
 * Same post-generation length backstop as draft.js's identical helper — see
 * that module's comment for the full reasoning (logged, not enforced; only
 * fires for the two numeric signal types; deliberately loose tolerance).
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
 * PASS 1 system prompt: address the feedback and rewrite the article ONLY.
 * No SEO metadata, no CITATION_ANCHORS, no GENERAL_CITATIONS, no
 * QUOTED_TEXT, no RELATED_POSTS — all of that moved to Pass 2
 * (lib/package-draft.js). What stays here is exactly what shapes the
 * rewrite itself: the legal-grounding hard rule and NEEDS_HUMAN_REVIEW flag
 * mechanism, the brand voice guide, narration suppression, heading
 * structure, and the direct-answer-first-paragraph rule.
 */
function buildSystemPrompt({ hasBrandGuide = false, hasWebSearch = false, hasTopics = false } = {}) {
  // Shared with draft.js (lib/brand-guide.js) so the wording never drifts.
  // Revision has no "inspiration piece" concept, so no tie-breaker note.
  const brandGuideRule = hasBrandGuide ? brandGuideSystemRule() : '';

  // ALWAYS included, regardless of hasWebSearch — unlike the old version of
  // this file, where the "don't narrate your own process" instruction lived
  // ONLY inside the hasWebSearch-gated block below. That meant it was
  // completely ABSENT from the prompt for the majority of real revisions —
  // any item with linked grounding claims never gets the web_search tool
  // (see buildWebSearchTool()), so hasWebSearch is false there and this
  // rule simply never appeared. Confirmed as the shape of a real production
  // leak: a revision responding to editor feedback on a grounded piece
  // ("is there a security deposit cap I should mention here for context?")
  // wrote a full narration paragraph under a fabricated "## A Note on ..."
  // heading, unconstrained by any prompt instruction against it. Deliberately
  // an unnumbered bullet, same reasoning as brandGuideRule below — that
  // numbered list's numbers are hardcoded, so a plain bullet can't drift out
  // of sync.
  const noNarrationRule = `

- NEVER NARRATE YOUR OWN PROCESS — ANYWHERE IN THE PIECE, NOT JUST THE
  OPENING: Never write a sentence or paragraph explaining what you're
  excluding, or why. This applies at the very start of your response, in
  the middle of the body under a heading you create for the purpose, or
  anywhere else in your response — the rule is the same everywhere. Do not
  address "the editor" or "you" directly about the writing process, even
  when responding to specific feedback they left (e.g. a question like "is
  there a cap I should mention here?") — answer it, or flag it, without
  narrating that you're doing so. Do not explain what you decided to
  include or leave out and your reasoning for it. Do not fabricate a
  heading (e.g. "A Note on ...") whose sole purpose is to house that kind
  of explanation. If something can't be stated confidently, the inline
  "[NEEDS HUMAN REVIEW: ...]" flag (see hard rule 2 above) is the ONLY
  sanctioned way to say so — used inline, exactly where the fact would
  otherwise go, never with a surrounding explanatory paragraph and never
  under its own dedicated heading. Your response should read, start to
  finish, as nothing but the article itself.`;

  // ALWAYS included, same reasoning as noNarrationRule above. THIS IS THE
  // PRIMARY DEFENSE against leaked narration — see draft.js's identical
  // articleMarkerRule/ARTICLE_MARKER for the fuller reasoning (TARS's
  // 2026-07-29 finding that phrase-pattern classification is structurally
  // unreliable). The regex-based checks below and in lib/seo.js remain in
  // place underneath this as additional layers, but the marker is the
  // primary defense from this point on.
  const articleMarkerRule = `

- STRUCTURAL MARKER — THE SINGLE MOST IMPORTANT FORMATTING RULE IN THIS
  PROMPT: The instant you are ready to write the revision — whether that's
  immediately, or only after one or more rounds of web_search — the very
  next thing you output, with absolutely nothing before it (including
  before the TITLE line described elsewhere in this prompt), must be this
  exact literal line, by itself:

  ${ARTICLE_MARKER}

  No acknowledgment that research is done, no summary of what you found or
  didn't find, no restated plan, no "Here's the revision:" lead-in —
  nothing of any kind may come before that line, not even one word, whether
  or not you end up using web_search this turn. Everything you output
  before this marker is discarded automatically and never seen by anyone,
  so anything you place before it is wasted effort at best and actively
  confusing at worst. Reproduce the marker EXACTLY as shown — same
  characters, same case, on its own line — every single time. Everything
  AFTER the marker (starting with the TITLE line) is the real output — the
  "NEVER NARRATE YOUR OWN PROCESS" rule above still applies to all of it;
  the marker is not a place to get narration "out of your system" before
  writing normally.`;

  // ALWAYS included, same reasoning as draft.js's identical lengthRule — a
  // plain, unconditional bullet so it can never silently disappear for one
  // branch. General-purpose half of the length fix; the feedback-specific
  // half is buildLengthRequirementSection() above, which adds a second,
  // snippet-quoting callout right next to the feedback whenever
  // detectLengthSignalFromFeedback() finds an explicit signal in it.
  //
  // ROUND 2 FIX (TARS, legal-topic length compliance) — same fix as draft.js's
  // identical lengthRule, moved here for the same reason: this used to sit
  // BEFORE brandGuideRule/webSearchRule, mid-list, ahead of the single
  // densest block in this prompt (webSearchRuleForLegalTopics — grounding-
  // claims sourcing, the one-additional-legal-fact allowance, the
  // [LEGAL CLAIM PENDING REVIEW: ...]/[NEEDS HUMAN REVIEW: ...] flagging
  // mechanics, and the quotes-can-never-state-a-legal-fact rule). Moved to
  // the very end of the concatenated hard-rules block (see the return
  // statement below) so it's the last thing read before HEADING STRUCTURE —
  // the strongest remaining position short of repeating it again (which
  // buildUserPrompt's closing paragraph now also does — see there). Wording
  // updated from "further below" to "above" to match; now also names the
  // FAQ-section default and brand-guide boilerplate explicitly, not just
  // "web search" — see draft.js's identical fix for the live-tested repro
  // (a "3 paragraphs" brief on security-deposits) that traced the actual
  // overage mainly to an unconditional FAQ section, not just prompt
  // attention dilution.
  const lengthRule = `

- LENGTH AND FORMAT REQUESTS IN THE FEEDBACK ARE HARD REQUIREMENTS, NOT
  SUGGESTIONS — READ THIS LAST, RIGHT BEFORE YOU WRITE: If the feedback asks
  for (or a "LENGTH REQUIREMENT DETECTED" callout appears below
  highlighting) a target word count, paragraph count, or a general length
  change ("make this shorter," "cut this down to a few short paragraphs,"
  "this needs to be longer/more in-depth," and similar), that instruction
  controls the length of the revised piece and OVERRIDES every other
  instruction in this prompt that pushes toward being longer or more
  thorough — including the web-search research budget above, the
  grounding-claims and legal-sourcing rules above, the general instinct to
  be comprehensive, AND the default instruction elsewhere in this prompt to
  include a "## Frequently Asked Questions" section or any standing
  brand-voice-guide boilerplate. Feedback asking for "three paragraphs"
  means three paragraphs of actual prose total, for the WHOLE piece — not
  three body paragraphs plus a separate FAQ section plus a closing brand
  paragraph on top. If honoring every other instruction in this prompt in
  full would blow past the requested length, the length instruction wins:
  shrink or drop the FAQ section, shrink or drop optional boilerplate, and
  be more selective about which researched facts make it in, rather than
  exceeding the requested length. If the feedback says nothing about length,
  revise to whatever length the feedback's actual content changes naturally
  produce — this rule only changes behavior when the feedback actually asks
  for a length change.`;

  // CHANGED BY THIS BUILD: used to be only ever reachable when this item had
  // no linked topics — hasWebSearch was only true when the caller attached
  // the web_search tool (see buildWebSearchTool()), which used to never
  // happen when grounding claims were linked. Now that buildWebSearchTool()
  // no longer withholds the tool from linked-claims items (see that
  // function's own comment), hasWebSearch can be true for BOTH cases — so
  // this now branches on hasTopics too, same as draft.js's identical split.
  // The hasTopics=false variant is completely UNCHANGED text from before
  // this build; the hasTopics=true variant is new — it adds the
  // one-additional-researched-legal-fact allowance (wrapped in the new
  // "[LEGAL CLAIM PENDING REVIEW: ...]" flag) on top of the same
  // general/non-legal-fact search guidance every revision already gets.
  const webSearchRuleForLegalTopics = `

ADDITIONAL HARD RULE — WEB SEARCH:
Use the web_search tool to research this revision thoroughly — you have a
real budget for this (up to 6 searches), so use it rather than settling for
the first thing you find. This budget is about RESEARCH QUALITY, not
revision length: if this revision also has a length requirement (see the
LENGTH callout), thorough research still has to land in a piece that fits
that length — do more searching to find the single best, most specific fact
to include, not to justify including more facts than the requested length
has room for. As with any revision, use it to find and state real, specific,
non-legal facts (market statistics, program names, industry trend data, and
similar) directly in the revision's own prose, naming the source by name
where you state something specific — a separate process reads the finished
revision afterward and turns a named source into a
formal citation automatically, so you never need to produce a citation list
yourself.

You may ALSO use web_search to research and state ONE additional legal fact
that is not covered by the GROUNDING CLAIMS section above — but ONLY under
every one of these conditions:
- You must name the real, specific source in your own prose (e.g. "according
  to the Ventura County Star..." or "per the California Apartment
  Association's..."), never a vague "sources say" or "reports indicate."
- The stated fact must be wrapped in this exact inline flag, placed
  immediately around or adjacent to where the fact appears:
  "[LEGAL CLAIM PENDING REVIEW: <short description of the claim>]"
  This is a DIFFERENT flag from "[NEEDS HUMAN REVIEW: ...]" (hard rule 2
  above), and the two must never be confused or used interchangeably:
  "[NEEDS HUMAN REVIEW: ...]" means you found no usable source and are
  declining to state the fact; "[LEGAL CLAIM PENDING REVIEW: ...]" means you
  DID find and name a real source and ARE stating the fact, but it still
  requires a human's sign-off before anyone treats it as verified.
- If your search does not turn up a real, specific, nameable source for a
  legal fact the revision would otherwise need, do not state it at all —
  flag it "[NEEDS HUMAN REVIEW: ...]" instead, exactly per hard rule 2
  above. This allowance is not a way around that rule — it only ever
  applies when you actually found and can name a real source.
- Limit yourself to ONE such flagged legal fact per revision. If more than
  one genuinely new legal fact would strengthen the piece, research and
  state only the single most important one this way, and flag any others
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
If you include a direct quotation in the revision's own prose — a real
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
directly, per hard rule 1 above. The one additional legal fact allowance
above must always be stated in your OWN prose, naming the source, never as a
direct quotation. A quote may only ever be used to support a general,
non-legal point: market color, sentiment, a business trend, or an
organization characterizing its own data.`;

  const webSearchRuleForGeneralTopics = `

ADDITIONAL HARD RULE — WEB SEARCH:
Use the web_search tool to research this revision thoroughly — you have a
real budget for this (up to 6 searches), so use it rather than settling for
the first thing you find. Use it to find and state real, specific,
non-legal facts (market statistics, program names, industry trend data, and
similar) directly in the revision's own prose, naming the source by name
where you state something specific — a separate process reads the finished
revision afterward and turns a named source into a formal citation
automatically, so you never need to produce a citation list yourself.
Never use a search result, no matter how authoritative it looks, to
determine, state, or modify a legal fact; there are no legal grounding
claims in this piece, and that remains true regardless of anything you find
via search.

The moment your searching is finished, follow the "STRUCTURAL MARKER" rule
above immediately: the ${ARTICLE_MARKER} line comes first, before anything
else — no acknowledgment, no summary of findings, no restated plan. See the
"NEVER NARRATE YOUR OWN PROCESS" rule too: it applies here just as much,
including to describing your search activity specifically (examples of
what NOT to write, anywhere in your response: "I'll research...", "Let me
look up...", "Based on what I found...", "I have enough context...").

ADDITIONAL HARD RULE — QUOTES CAN NEVER STATE A LEGAL FACT:
If you include a direct quotation in the revision's own prose — a real
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
forbidden as stating it directly, per hard rule 1 above. A quote may only
ever be used to support a general, non-legal point: market color,
sentiment, a business trend, or an organization characterizing its own
data.`;

  const webSearchRule = hasWebSearch
    ? (hasTopics ? webSearchRuleForLegalTopics : webSearchRuleForGeneralTopics)
    : '';

  return `You are a legal-content revision assistant for Rincon Management, a
Southern California property management company operating in Ventura County.
You are revising an existing draft based on an editor's feedback — you are
not starting from scratch, and you are not writing on a brand-new topic.

HARD RULES — follow these exactly:

1. You may only state a specific legal fact (a rule, a deadline, a dollar
   amount, a percentage, a notice period, a citation) if it is explicitly
   present in the "GROUNDING CLAIMS" section of this prompt. Do not use
   outside knowledge of California or Ventura County law, even if you
   believe you know the correct rule. If this draft is linked to a legal
   topic and its grounding claims don't cover something the feedback needs,
   you may alternatively research and state ONE additional legal fact
   yourself — see the "WEB SEARCH" rule further below for exactly how and
   under what conditions. Otherwise, flag it per rule 2 below rather than
   inventing it.

2. If the feedback asks you to add or change something that would require a
   NEW legal fact not already covered by the grounding claims, do NOT
   invent it. Instead, write the revision with a clearly visible inline
   flag in this exact format wherever that fact would go:
   "[NEEDS HUMAN REVIEW: <short reason, e.g. "feedback asks for the notice
   period but no grounding claim covers it">]"
   Do not silently smooth over or omit these flags, and do not quietly
   ignore that part of the feedback either — flag it so a human sees it.

3. If a grounding claim you use has "[STATUS: NEEDS_HUMAN_REVIEW]" next to
   it, carry that same inline flag format into the revised text wherever
   that fact appears, even if it was already unflagged text in the draft
   before.

4. Do not fabricate a citation, statute number, or ordinance number that
   isn't in the grounding claims — and, for the one additional researched
   legal fact allowed under the "WEB SEARCH" rule further below, do not
   fabricate a source either, or attribute a stated fact to a source that
   didn't actually return it.

5. Never include any tenant's or owner's real name, address, or other
   identifying detail. Case studies must be described as illustrative/
   anonymized, not real individual accounts.

6. Do not include any call to action to "share this on Facebook" or similar
   auto-publish language — a human will handle distribution manually.

7. Address every piece of feedback listed. If a piece of feedback is
   ambiguous or you're not sure how to apply it, make a reasonable
   interpretation and keep going — do not refuse to revise.

8. Preserve what isn't being complained about. This is a revision, not a
   rewrite from nothing — keep the parts of the draft that the feedback
   doesn't ask you to change.

9. The direct answer to the piece's core question must land within the
   first paragraph. A brief empathetic opening (1-2 sentences) consistent
   with Rincon's established voice is fine before it, but the concrete
   answer cannot be delayed past that first paragraph. This rule controls
   timing only, not tone — the brand voice guide (if active) still controls
   how it's worded.

10. GENERAL/NON-LEGAL FACTS (market statistics, program names, industry
    trend data, and similar) are fine to state with real specificity when
    something here would genuinely strengthen the revision — a separate
    process reads the finished revision afterward and sources anything
    specific enough to need it, so just write naturally; you do not need to
    produce a citation list yourself. Never force one in if nothing is
    genuinely relevant — plain qualitative language is fine, and better
    than a padded-in, low-relevance factoid. These facts must NEVER be used
    to source a legal fact — legal facts still come only from the
    GROUNDING CLAIMS section above (or not at all, if none are currently
    linked to this draft).

    TRACE EVERY GENERAL FACT TO ITS ORIGIN, NOT JUST ITS REPETITION: when
    you research a general/business claim via web_search, actively check
    whether it actually traces back to a real primary source — a
    government agency, a named study or report, or a company's own
    reported data — versus whether it's a figure that merely shows up
    repeated across many secondary write-ups with none of them actually
    naming where it originally came from. "Several sources repeat this" is
    not the same thing as "this is verified" — treat those as two
    different tiers of confidence, not one. If a stat is the
    repeated-but-untraceable kind, say so plainly in the sentence where it
    appears rather than either stating it as flat fact or vaguely hedging
    without explaining why. If it IS traceable to a real primary source,
    say that plainly too, naming the source right in the sentence.${noNarrationRule}${articleMarkerRule}${brandGuideRule}${webSearchRule}${lengthRule}

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
paragraph, or a "##" subheading if that reads better.

Write in a clear, plain-English, professional tone suitable for a property
management company's website. Avoid legalese where a plain explanation
works. This is marketing/educational content, not legal advice — do not
present it as a substitute for consulting an attorney.

Other than the leading ${ARTICLE_MARKER} marker line and the "TITLE: ..."
line immediately after it (both described above/below), your response is
the revised article itself, start to finish — do not add any trailing
metadata, JSON, or structured fields of any kind after the body. A separate
process handles all of that afterward.`;
}

/**
 * Whether this revision should end with a "## Frequently Asked Questions"
 * section — same gating rule as draft.js's shouldIncludeFaq(), kept as its
 * own copy here since draft.js and revise.js don't share a prompt-fragment
 * module (formatClaimsForPrompt() above is duplicated the same way).
 */
function shouldIncludeFaq(contentType, hasTopics) {
  return (
    contentType === 'faq' ||
    (hasTopics && (contentType === 'blog_post' || contentType === 'market_report'))
  );
}

/**
 * CHANGED BY THIS FIX (TARS, legal-topic length compliance) — same fix as
 * draft.js's identical helper: now takes the detected lengthSignal so the
 * FAQ section can be told to shrink or disappear when the feedback also
 * asked for a short piece. See draft.js's copy for the fuller reasoning and
 * the live-tested repro this addresses.
 */
function buildFaqInstruction(lengthSignal) {
  const base = ` If the revised piece should have a "## Frequently Asked
Questions" section (add one if the current draft doesn't have one, or keep
revising the existing one), format each pair exactly as:

**Q: <question>**
A: <answer>

Write FAQ questions that reflect this piece's specific angle from the brief
and grounding claims above, not the topic's most generic/obvious question —
assume other posts on this site may already cover the basic version of this
topic.`;

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
Q&A pair, or drop it entirely, whichever actually fits within the requested
length alongside the rest of the piece. A short-length request with a full
multi-question FAQ tacked on is exactly the kind of overage this length
requirement exists to prevent.`;
}

/**
 * PASS 1 user prompt: current title/body, feedback history, grounding
 * claims, brand guide, and the instruction to revise. No RELATED POST
 * CANDIDATES and no trailing-fields instruction — both moved to Pass 2
 * (lib/package-draft.js), which sees the finished revised body instead. The
 * leading "TITLE: <revised title>" line stays here — revising the title is
 * part of the rewrite itself, not packaging metadata.
 */
function buildUserPrompt({
  title,
  body,
  feedbackHistory,
  claims,
  brandGuideContent,
  contentType,
  hasTopics,
  lengthSignal,
}) {
  const brandGuideSection = brandGuideContent
    ? formatBrandGuideForPrompt(brandGuideContent)
    : '';

  const faqInstruction = shouldIncludeFaq(contentType, hasTopics) ? buildFaqInstruction(lengthSignal) : '';

  // See buildLengthRequirementSection()'s own comment — '' (nothing added)
  // when none of the feedback rounds have a detectable length signal, which
  // is the common case and leaves this prompt byte-for-byte unchanged from
  // before this fix (buildLengthRequirementSection()'s own leading "\n\n"
  // supplies the blank line before it when non-empty, so nothing extra is
  // added here).
  const lengthRequirementSection = buildLengthRequirementSection(lengthSignal);

  // Final, closest-to-generation reminder — same fix as draft.js's identical
  // helper, repeated a third time (after the feedback-adjacent callout above
  // and the system prompt's lengthRule) because this is the literal last
  // thing the model reads before it starts writing. '' when there's no
  // signal, leaving the prompt unchanged in the common case.
  const finalLengthReminder = lengthSignal
    ? ` Before you start writing: this piece has a length requirement
(${lengthSignal.snippet.length > 80 ? `${lengthSignal.snippet.slice(0, 80)}...` : lengthSignal.snippet}) that
still wins over every research/grounding/FAQ instruction above — hold to it.`
    : '';

  return `Here is the CURRENT DRAFT that needs revision:

CURRENT TITLE:
${title}

CURRENT BODY:
${body}

EDITOR FEEDBACK (in the order it was given — address all of it):
${formatFeedbackForPrompt(feedbackHistory)}${lengthRequirementSection}

GROUNDING CLAIMS (the only source of legal facts you may use):
${formatClaimsForPrompt(claims)}

${brandGuideSection}Revise the draft to address the feedback above. Output the full revised
piece now.

The moment you're ready to write (after any research), the very next thing
you output must be the line ${ARTICLE_MARKER} by itself, with nothing
before it — see the STRUCTURAL MARKER rule above. Immediately after that
marker line, output the revised title in this exact format:

TITLE: <revised title>

Then a blank line, then the full revised body.${faqInstruction}${finalLengthReminder}

Do not include any other commentary before, between, or after these parts —
just the marker line, the TITLE line, and the revised body.`;
}

/**
 * Parse the model's response into title and body only. Much simpler than
 * the old single-pass version (which also stripped SEO_TITLE/
 * META_DESCRIPTION/CITATION_ANCHORS/GENERAL_CITATIONS/QUOTED_TEXT/
 * RELATED_POSTS trailing fields off the end) — Pass 1 no longer produces any
 * of those, so there's nothing left to strip but the leading "TITLE: ..."
 * line.
 *
 * The "TITLE: ..." line is searched for ANYWHERE in the text (first match,
 * multiline), not anchored to the literal start of the string. The model is
 * instructed to open its response with that line, but occasionally violates
 * the "never narrate" rule and emits some preamble first — a strict `^`
 * anchor then fails to match at all, silently falling back to the STALE
 * fallbackTitle while dumping the model's raw response (preamble and the
 * leaked "TITLE: ..." line both) straight into the stored body. Everything
 * before the matched TITLE line is discarded as preamble; everything after
 * it is the body. If no TITLE line is found anywhere, that's a real
 * anomaly (not just a formatting quirk) — it's logged so it doesn't pass
 * through silently, and we fall back to the old behavior (stale title, full
 * text as body) since there's nothing better to do with an unparseable
 * response.
 * @param {string} text
 * @param {string} fallbackTitle
 * @param {string} [contentItemId] - only used to make the console warning
 *   below actionable; has no effect on parsing.
 */
function extractTitleAndBody(text, fallbackTitle, contentItemId) {
  const titleMatch = text.match(/^\s*TITLE:\s*(.+?)\s*$/m);
  let title;
  let remaining;
  if (titleMatch) {
    title = titleMatch[1].trim();
    remaining = text.slice(titleMatch.index + titleMatch[0].length);
  } else {
    console.warn(
      `[revise.js] extractTitleAndBody: no "TITLE:" line found anywhere in ` +
        `Claude's response${contentItemId ? ` for content_item ${contentItemId}` : ''} — ` +
        `keeping the existing title and using the raw response as the body. ` +
        `This usually means the model narrated before/instead of following the ` +
        `expected "TITLE: ..." format; the body may need a manual check.`
    );
    title = fallbackTitle;
    remaining = text;
  }

  // Belt-and-suspenders: even with the search-anywhere match above, strip a
  // stray leading "TITLE: ..." line from whatever remains, so this exact
  // failure mode (a literal "TITLE: ..." line leaking into the published
  // body) can never resurface via some other edge case.
  remaining = remaining.replace(/^\s*TITLE:\s*.*(?:\n|$)/, '');

  return { title, body: remaining.trim() };
}

/**
 * Revise a content item based on its accumulated "Request Changes" feedback.
 *
 * @param {object} opts
 * @param {string} opts.contentItemId
 * @param {string} opts.currentTitle
 * @param {string} opts.currentBody
 * @param {string} [opts.revisedBy] - who/what triggered this, for the edit log
 * @returns {Promise<{contentItem: object, feedbackHistory: object[], claims: object[]}>}
 */
async function reviseContent({ contentItemId, currentTitle, currentBody, revisedBy = 'AI (revision from feedback)' }) {
  if (!contentItemId || !currentTitle || currentBody == null) {
    throw new Error('contentItemId, currentTitle, and currentBody are required');
  }

  // 1. Gather every round of feedback, the claims already linked, this
  // item's content_type (needed to gate the FAQ instruction the same way
  // draft.js does), the topic_ids it was tagged with (needed for the same
  // gate, and for internal-linking below), and the active brand voice guide
  // (same persistent, database-backed guidance draft.js applies to first
  // drafts — revisions should respect it too). Brand guide returns null if
  // Peter hasn't uploaded one yet.
  const [feedbackHistory, claims, brandGuide, itemRows, topicIds] = await Promise.all([
    getFeedbackHistory(contentItemId),
    getLinkedClaims(contentItemId),
    getActiveBrandGuide(),
    select('content_items', `select=content_type&id=eq.${contentItemId}`),
    getLinkedTopicIds(contentItemId),
  ]);
  const brandGuideContent = brandGuide ? brandGuide.content : null;
  const contentType = itemRows[0] ? itemRows[0].content_type : null;
  const hasTopics = topicIds.length > 0;

  if (feedbackHistory.length === 0) {
    throw new Error(
      'No "Request Changes" feedback found for this draft — nothing to revise against.'
    );
  }

  // Detected once here (rather than re-derived inside buildUserPrompt) so
  // the same signal object can also drive the post-generation
  // checkLengthCompliance() call further below — see
  // detectLengthSignalCandidateFromFeedback()'s own comment for the bug this
  // addresses (the same one draft.js's identical fix addresses for a first
  // draft's brief, applied here to a revision's feedback history). CHANGED
  // BY THE BUG 2 FIX: now goes through detectAndConfirmLengthSignalFromFeedback()
  // (regex candidate + AI comprehension confirmation) — see that function's
  // own comment for why a plain regex candidate is no longer trusted
  // directly.
  const lengthSignal = await detectAndConfirmLengthSignalFromFeedback(feedbackHistory, '[revise.js]');

  // 1b. Look up internal-link candidates BEFORE Pass 2 (not needed by Pass 1
  // at all now — RELATED_POSTS moved entirely to Pass 2, see
  // lib/package-draft.js). When this item has no linked topics (the
  // majority of real articles), fall back to keyword-overlap scoring
  // against title+body instead of the topic-based lookup, which would
  // otherwise return nothing at all here.
  const internalLinkCandidates = hasTopics
    ? await getInternalLinkCandidates(topicIds, contentItemId)
    : await getGeneralInternalLinkCandidates(currentTitle, currentBody, contentItemId);

  // 2. PASS 1 — ask Claude to revise, grounded in the already-linked claims
  // (when there are any). CHANGED BY THIS BUILD: the web_search tool is now
  // attached regardless of hasTopics (see buildWebSearchTool()) — items with
  // linked grounding claims are no longer denied the tool outright. The
  // safety boundary for legal-topic revisions now lives in the prompt
  // (buildSystemPrompt()'s hasTopics-branched webSearchRule) plus the
  // downstream detectLegalClaims()/legal_claim_reviews review gate, not in
  // withholding the tool.
  const webSearchTool = buildWebSearchTool();
  const tools = webSearchTool ? [webSearchTool] : undefined;

  const client = getClient();
  const pass1Response = await client.messages.create({
    model: MODEL,
    // Pass 1 no longer needs headroom for trailing SEO/citation/quote/
    // related-post fields (all moved to Pass 2 — see lib/package-draft.js),
    // but a full revised article can still legitimately run long, so this
    // stays generous — max_tokens is a cap, not a cost floor.
    max_tokens: 8192,
    ...(tools ? { tools } : {}),
    system: buildSystemPrompt({
      hasBrandGuide: Boolean(brandGuideContent),
      hasWebSearch: Boolean(webSearchTool),
      hasTopics,
    }),
    messages: [
      {
        role: 'user',
        content: buildUserPrompt({
          title: currentTitle,
          body: currentBody,
          feedbackHistory,
          claims,
          brandGuideContent,
          contentType,
          hasTopics,
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
  // detail is discarded — see draft.js's identical call for the fuller
  // reasoning. The only evidence lib/seo.js's insertVerifiedQuotes() is
  // allowed to trust when deciding whether a proposed QUOTED_TEXT quote
  // (now proposed by Pass 2) is real.
  const citedTextEvidence = extractCitedTextEvidence(pass1Response.content);
  // Real pages Pass 1's web_search tool actually surfaced — handed to Pass 2
  // below so its GENERAL_CITATIONS/QUOTED_TEXT proposals can draw on what
  // was really found, not just Pass 1's finished prose. Empty when
  // hasTopics is true or Pass 1 simply didn't search.
  const searchEvidence = extractSearchResultsEvidence(pass1Response.content);

  // PRIMARY defense against leaked narration — see draft.js's identical
  // pipeline step/ARTICLE_MARKER for the fuller reasoning. Scoping
  // extractTitleAndBody() to the post-marker text (rather than the raw
  // pass1Text) means any leaked narration before the marker can never be
  // mistaken for the TITLE line either. Falls back to the raw pass1Text
  // (extractTitleAndBody()'s own existing search-anywhere behavior) if the
  // model didn't emit the marker — logged so a real regression here doesn't
  // pass through silently.
  const afterMarker = extractAfterArticleMarker(pass1Text);
  if (afterMarker === null) {
    console.warn(
      `[revise.js] Pass 1 response did not contain the expected "${ARTICLE_MARKER}" ` +
        'marker — falling back to the full response text and the pre-marker ' +
        'narration cleanup layers only.'
    );
  }
  const textForTitleExtraction = afterMarker !== null ? afterMarker : pass1Text;

  const { title: revisedTitle, body: rawRevisedBody } = extractTitleAndBody(
    textForTitleExtraction,
    currentTitle,
    contentItemId
  );

  // Narration/preamble/stray-title-heading cleanup runs here, right after
  // Pass 1 — same reasoning as draft.js's identical pipeline step: Pass 1 is
  // still the pass doing the searching and writing, so this is still its
  // problem to have cleaned up before Pass 2 (or the stored body) ever sees
  // it. Handing Pass 2 the ALREADY-CLEANED revision also means every
  // anchor_text it names is guaranteed to match text that's actually still
  // in the final stored body.
  // stripLeadingHandoffPreamble() runs FIRST — same reasoning as draft.js's
  // identical pipeline step: it catches a longer hand-off paragraph fused
  // into the same text block as the real content (see its own comment above)
  // that lib/seo.js's stripLeadingPreambleSeparator()'s 200-character ceiling
  // misses. Running it first means stripLeadingPreambleSeparator() still
  // gets a clean, unmodified shot at the shorter cases it already handles.
  let revisedBody = stripLeadingHandoffPreamble(rawRevisedBody);
  revisedBody = stripLeadingPreambleSeparator(revisedBody);
  revisedBody = stripLeadingTitleHeading(revisedBody);
  revisedBody = stripMidDocumentNarration(revisedBody);

  // Post-generation length backstop (see checkLengthCompliance()'s own
  // comment) — checked against Pass 1's own revised body, BEFORE Pass 2
  // appends/rebuilds a FAQ section and/or "## Related Reading"/"## Sources"
  // sections below, for the same reason as draft.js's identical check: those
  // are separate structural add-ons, not part of what a feedback round's
  // length request is asking about.
  checkLengthCompliance(revisedBody, lengthSignal, '[revise.js]', contentItemId);

  // 3. PASS 2 — package the finished revision: SEO title/description,
  // citation anchors for the (already-fixed) linked claims, general/
  // non-legal citation proposals, quote proposals, related-post picks
  // (lib/package-draft.js, shared with draft.js). includeClaimsUsedField is
  // false here — unlike a fresh draft, a revision's linked-claims set is
  // fixed and never added to or removed from (see step 4's comment below),
  // so `claims` is used exactly as given, with no "which were actually
  // used" filtering step.
  // CONTINUITY FIX: read the GENERAL citations the last round ended up with
  // back out of the ORIGINAL `currentBody` (untouched by anything above —
  // Pass 1 only ever reads/rewrites the `revisedBody` local variable) so
  // Pass 2 can be told to keep citing a source whose claim survived this
  // round, rather than silently re-deriving GENERAL_CITATIONS from scratch
  // every time. See extractPreviousGeneralCitations()'s own comment above.
  const previousGeneralCitations = extractPreviousGeneralCitations(currentBody);

  const packaged = await packageDraft({
    articleBody: revisedBody,
    claims,
    includeClaimsUsedField: false,
    internalLinkCandidates,
    searchEvidence,
    pass1HasWebSearch: Boolean(webSearchTool),
    previousGeneralCitations,
  });
  const {
    seoTitle,
    metaDescription,
    citationAnchors,
    generalCitations,
    quotedText,
    relatedPosts,
    cleanedArticleBody,
  } = packaged;

  // SECONDARY safety net — see draft.js's identical pipeline step for the
  // fuller reasoning. cleanedArticleBody equals `revisedBody` unchanged
  // whenever Pass 2 found nothing to flag (expected to be nearly every run).
  if (cleanedArticleBody !== revisedBody) {
    console.warn(
      '[revise.js] Pass 2 detected and stripped leaked opening narration that ' +
        'survived the Pass 1 marker and the earlier regex cleanup layers — ' +
        'see lib/package-draft.js\'s stripLeakedOpeningNarration(). This should ' +
        'be rare; if it keeps happening, investigate why ARTICLE_MARKER isn\'t ' +
        'being honored.'
    );
  }
  revisedBody = cleanedArticleBody;

  // 3c. Legal-claim detection (lib/package-draft.js's detectLegalClaims(),
  // shared with lib/draft.js). Runs on the same finished, already-cleaned
  // body Pass 2 packaged — BEFORE the mechanical link-insertion passes
  // below, so a flagged claim_text is plain prose for a reviewer, not
  // markdown link syntax. `claims` is already this item's fixed, linked
  // grounding set (revise.js never adds/removes from it — see this
  // function's own comment above), so it's used as-is, same reasoning as
  // draft.js's narrower claimsUsed. Detection itself is pure/DB-free and
  // safe to always run; the DB write after step 4 below is wrapped in
  // try/catch (see there).
  //
  // BUG FIX (TARS, 2026-08-02, extended round 3): scan
  // stripSourcesSectionForLegalScan(revisedBody), NOT revisedBody itself —
  // at this point revisedBody still carries the PREVIOUS round's "##
  // Related Reading" and "## Sources" sections (neither is rebuilt until
  // the insertRelatedReadingAndSourcesSections() call below), so scanning
  // the raw body was flagging the article's own reference-list citation
  // strings AND citation-shaped Related Reading link titles as "new" legal
  // claims. See that function's own comment above for the full reasoning.
  // Captured into a variable, not just inlined, because the STRUCTURAL
  // BACKSTOP below (findMissingLegalClaimBracketFindings()) must scan this
  // exact same Sources/Related-Reading-stripped text — not the raw
  // revisedBody — so its own bracket scan stays perfectly aligned with what
  // Layer 1/2 actually saw. Scanning a different text basis than
  // detectLegalClaims() itself used risks the backstop flagging (or
  // missing) something for a reason that has nothing to do with whether
  // Layer 1/2 actually caught it.
  const bodyForLegalScan = stripSourcesSectionForLegalScan(revisedBody);
  const legalClaimFindings = await detectLegalClaims(bodyForLegalScan, claims);

  // STRUCTURAL SAFETY NET, on top of Pass 2's own (prompted) continuity
  // attempt: force back in any previously-cited source whose exact anchor
  // phrase is still sitting verbatim in THIS round's cleaned body but that
  // Pass 2 didn't re-propose. Runs against the final `revisedBody` (post
  // cleanedArticleBody) — the same text insertGeneralCitations() below is
  // about to search — so what gets verified here is exactly what will
  // actually be linked. See carryForwardVerbatimGeneralCitations()'s own
  // comment for why this doesn't just trust the prompt instruction alone.
  const generalCitationsWithContinuity = carryForwardVerbatimGeneralCitations(
    generalCitations,
    previousGeneralCitations,
    revisedBody
  );
  if (generalCitationsWithContinuity.length !== (generalCitations || []).length) {
    console.log(
      `[revise.js] Structural citation continuity added back ${
        generalCitationsWithContinuity.length - (generalCitations || []).length
      } source(s) Pass 2 didn't re-propose but whose previous anchor phrase is still verbatim in this round's body.`
    );
  }

  // General/non-legal citations that passed the domain-allowlist gate
  // (lib/general-citation-domains.js) — computed once and reused by both
  // insertGeneralCitations() (mid-paragraph linking) and
  // insertRelatedReadingAndSourcesSections() (bibliography half), same as
  // draft.js. Independent of
  // claims/compliance_claims — see lib/seo.js.
  const allowedGeneralCitations = filterAllowedGeneralCitations(
    generalCitationsWithContinuity,
    GENERAL_CITATION_DOMAINS
  );

  // 3b. SEO post-processing — same mechanical, no-AI-call passes draft.js
  // applies (lib/seo.js). Verified quotes (from QUOTED_TEXT, checked against
  // citedTextEvidence — runs BEFORE citation/general-citation linking, same
  // reasoning as draft.js: a wrong quote is more serious than a wrong
  // citation, so it gets first claim on its own anchor_text), then legal
  // citation links from the claims already grounding this item (matched via
  // Pass 2's own CITATION_ANCHORS this round), then general/non-legal
  // citation links (from the allowlist-gated proposals), then the "Related
  // Reading" and "Sources" sections rebuilt fresh every round together, in a
  // fixed order, so that order stays stable across rounds even if one
  // section has nothing to add on a given round (see
  // insertRelatedReadingAndSourcesSections()'s comment in lib/seo.js — this
  // exact ordering bug was found and fixed there). Then a fresh FAQ schema
  // extraction — re-run every time rather than reused, since the body may
  // have changed this round.
  revisedBody = insertVerifiedQuotes(revisedBody, quotedText, citedTextEvidence, WEB_SEARCH_ALLOWED_DOMAINS);
  revisedBody = insertCitationLinks(revisedBody, claims, citationAnchors);
  revisedBody = insertGeneralCitations(revisedBody, allowedGeneralCitations, GENERAL_CITATION_DOMAINS);
  revisedBody = insertRelatedReadingAndSourcesSections(
    revisedBody,
    internalLinkCandidates,
    relatedPosts,
    claims,
    allowedGeneralCitations
  );
  const faqSchemaJson = extractFaqSchema(revisedBody);

  // 4. Update the content_item with the revised title/body and move it back
  // to ready_for_review (not 'draft' — it's already had a review round).
  // Also writes the freshly-generated meta_description/seo_title/faq_schema
  // — without this, those fields would silently go stale after the very
  // first AI revision round (they used to not be written here at all).
  // Note: this does NOT touch content_item_compliance_claims. The revision
  // is grounded in the same claims that were already linked; we don't add
  // or remove links here since Pass 2 isn't asked to determine "which
  // claims were used" the way draft.js's Pass 2 call is (see
  // includeClaimsUsedField above).
  const [contentItem] = await update('content_items', `id=eq.${contentItemId}`, {
    title: revisedTitle,
    body: revisedBody,
    status: 'ready_for_review',
    meta_description: metaDescription,
    seo_title: seoTitle,
    faq_schema: faqSchemaJson ? JSON.parse(faqSchemaJson) : null,
  });

  // 5. Log the revision as its own content_edits row, honestly attributed
  // to the AI rather than to Peter, so the edit history isn't misleading.
  await insert('content_edits', {
    content_item_id: contentItemId,
    edited_by: revisedBy,
    field_changed: 'body',
    before_text: currentBody,
    after_text: revisedBody,
    edit_note:
      `Revised by AI in response to ${feedbackHistory.length} round(s) of feedback: ` +
      feedbackHistory.map((f) => `"${f.edit_note.trim()}"`).join('; '),
  });

  // 6. Write any legal-claim findings from step 3c and recompute
  // legal_review_status — see draft.js's identical step for the fuller
  // reasoning, including why this is wrapped in try/catch: a failure here
  // must never prevent a revision that Pass 1/Pass 2 already successfully
  // wrote from being saved and returned to Peter.
  try {
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

    // STRUCTURAL BACKSTOP — see draft.js's identical step and
    // lib/legal-review.js's findMissingLegalClaimBracketFindings() for the
    // full reasoning. Scans bodyForLegalScan (the SAME Sources/Related-
    // Reading-stripped text detectLegalClaims() above just scanned, captured
    // above), run AFTER the Layer 1/2 insert so its own DB read sees those
    // rows too and correctly treats them as already covered.
    const missingBracketFindings = await findMissingLegalClaimBracketFindings(contentItemId, bodyForLegalScan);
    if (missingBracketFindings.length > 0) {
      console.warn(
        `[revise.js] STRUCTURAL BACKSTOP fired for content_item ${contentItemId}: found ` +
          `${missingBracketFindings.length} [LEGAL CLAIM PENDING REVIEW] bracket(s) with no ` +
          'matching legal_claim_reviews row — detectLegalClaims() Layer 1/2 missed it this run. ' +
          'Inserting fallback row(s) now. This should be rare; if it keeps happening, investigate ' +
          'why Layer 2 is missing it.'
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

    // BUG FIX (TARS, 2026-08-08) — see draft.js's identical fix for the
    // fuller reasoning: `contentItem` below (this function's return value)
    // was captured back at step 4's update() call, BEFORE this detection/
    // recompute step runs, so the returned object's legal_review_status
    // could read stale (e.g. still 'cleared' from before this revision
    // round) even after this line writes a fresh 'needs_review' to the
    // database. recomputeLegalReviewStatus()'s return value IS the
    // authoritative status it just wrote, so patching it onto the
    // already-captured object is enough — no extra round-trip needed.
    contentItem.legal_review_status = await recomputeLegalReviewStatus(contentItemId);

    // Mason's automatic review pass — see draft.js's identical step for the
    // fuller reasoning. Each newly-inserted row (including any structural-
    // backstop row from just above) is reviewed independently, each wrapped
    // in its own try/catch, so one claim's review failing never stops the
    // others or undoes what already saved successfully above.
    for (const row of insertedReviewRows) {
      try {
        await reviewClaimAsMason(row.id);
      } catch (e) {
        console.warn(
          `[revise.js] Mason's automatic review failed for legal_claim_reviews row ` +
            `${row.id} (content_item ${contentItemId}) — mason_finding stays null ` +
            `until a manual or retried review runs. ${e.message}`
        );
      }
    }
  } catch (e) {
    console.warn(
      `[revise.js] Legal-claim detection write/recompute failed for content_item ` +
        `${contentItemId} — the revision itself was saved successfully; only the ` +
        `legal-review safety net did not run this time. ${e.message}`
    );
  }

  return { contentItem, feedbackHistory, claims };
}

module.exports = {
  reviseContent,
  getFeedbackHistory,
  getLinkedClaims,
  getLinkedTopicIds,
  extractPreviousGeneralCitations,
  carryForwardVerbatimGeneralCitations,
  stripSourcesSectionForLegalScan,
};
