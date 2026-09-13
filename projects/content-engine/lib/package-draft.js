/**
 * lib/package-draft.js
 * Pass 2 ("Package") of the two-pass draft/revise pipeline. Pass 1
 * (lib/draft.js's / lib/revise.js's own Claude call) has ONE job: research
 * (when applicable) and write the finished article. This module is the
 * SEPARATE, second Claude call that runs after Pass 1 and does everything
 * else the old single-pass design used to ask for in the same breath as
 * writing: the SEO title/description, which grounding claims got used and
 * where, which outside sources support any general/non-legal claims, which
 * already-written quotations can be sourced, and which related posts are a
 * genuinely close match.
 *
 * WHY THIS SPLIT EXISTS: a side-by-side test against plain Claude Chat on
 * the same topic showed the old single-call design caused the model to
 * under-research even with web_search technically available — it was
 * juggling six jobs (research, write, respect legal grounding, respect
 * brand voice, track citations, fill SEO metadata) in one response. Pass 1
 * now only ever does two of those (write + legal-grounding/brand-voice
 * constraints that shape the writing itself); this module does the rest,
 * reading the FINISHED article rather than writing it.
 *
 * Shared by both lib/draft.js and lib/revise.js — their Pass 2 job is
 * IDENTICAL (finished article + fact list + related-post candidates in,
 * metadata out), so this is the one function both call rather than a third
 * near-duplicate copy (draft.js and revise.js already each duplicate a fair
 * amount of Pass 1 prompt/parsing code between themselves — see their own
 * file comments — but this piece is genuinely identical between them, not
 * just similar, so it lives here once).
 *
 * Two real differences between how draft.js and revise.js call this,
 * handled via plain parameters rather than a mode string:
 *   - `includeClaimsUsedField`: true for draft.js (a fresh draft has to
 *     figure out which of the CANDIDATE grounding claims it actually ended
 *     up discussing, so content_item_compliance_claims gets linked
 *     correctly), false for revise.js (a revision's linked-claims set is
 *     fixed and never added to or removed from — see reviseContent()'s own
 *     comment on why — so there's nothing to "figure out"; the given
 *     `claims` list is used as-is).
 *   - `pass1HasWebSearch`: whether Pass 1 actually had the web_search tool
 *     attached (i.e. `!hasTopics` at the time Pass 1 ran) — gates whether
 *     QUOTED_TEXT is asked for at all, same reasoning as the old single-pass
 *     design: a proposed quote can only ever be verified against real
 *     search-citation evidence, which only exists when Pass 1 could search.
 *
 * Does NOT call web_search itself — it never re-researches anything. Per an
 * explicit build decision, GENERAL_CITATIONS may draw on the model's own
 * knowledge same as before, not only on real evidence Pass 1's search
 * actually turned up — the SEARCH RESULTS section below is real evidence
 * shown to improve/ground those proposals when it's a genuine match, not a
 * hard restriction.
 *
 * Also does NOT get the brand voice guide (lib/brand-guide.js) — a build
 * decision, since an SEO title/meta description is invisible search-result
 * metadata, not reader-facing prose, so keeping this call lean and skipping
 * brand-guide injection entirely was chosen over threading it through for
 * consistency's sake.
 *
 * SECONDARY NARRATION SAFETY NET (added after a third leaked-narration
 * variant got past both lib/draft.js's/lib/revise.js's own Pass 1 marker
 * (their ARTICLE_MARKER instruction/parsing) and lib/seo.js's regex-based
 * layers — see TARS's 2026-07-29 finding): before producing its normal
 * metadata fields, Pass 2 now ALSO makes one COMPREHENSION judgment —
 * whether the article body's own opening text is genuinely the writer
 * talking ABOUT the piece/its research/an editorial decision, rather than
 * being part of the article itself — and reports it via
 * LEAKED_OPENING_NARRATION (see buildUserPrompt()/parsePass2Response()
 * below). This is deliberately NOT "Pass 2 may now edit the article": the
 * model only ever points at an exact leading substring to remove (same
 * "name it, don't retype it" contract as CITATION_ANCHORS/GENERAL_CITATIONS/
 * QUOTED_TEXT/RELATED_POSTS' anchor_text below), and
 * stripLeakedOpeningNarration() mechanically verifies that substring is a
 * genuine literal prefix of the given articleBody before removing it —
 * packageDraft() returns the result as `cleanedArticleBody`, alongside
 * (never instead of) the normal metadata fields.
 */

const { getClient } = require('./anthropic');

const MODEL = 'claude-opus-4-8';

/**
 * Collect every real page Pass 1's web_search tool actually surfaced, from
 * the RAW response.content array of Pass 1's Claude call — real
 * {title, url} pairs from `web_search_tool_result` blocks' own `content`
 * array (confirmed against a live API response, 2026-07-27: each entry is
 * `{type: "web_search_result", title, url, page_age, encrypted_content}` —
 * `encrypted_content` is opaque to us, only usable by Anthropic's own
 * servers, so it's dropped here), merged with any real quoted excerpt
 * (`cited_text`) a text block's `.citations` array attached to that same
 * url — the same raw evidence lib/draft.js's/lib/revise.js's own
 * extractCitedTextEvidence() already pulls out for quote verification, just
 * grouped here by source page instead of flattened to a quote list, so Pass
 * 2 sees "here's a real page Pass 1 looked at, and here's what it actually
 * quoted from it, if anything" — not just Pass 1's finished prose, as the
 * build spec calls for. A page with no quoted excerpt still appears (with
 * an empty `excerpts` list) — it was still real evidence Pass 1 considered,
 * even if nothing from it got quoted verbatim.
 *
 * Exported so lib/draft.js/lib/revise.js can call this once, right after
 * their own Pass 1 call, on the exact same raw `response.content` they
 * already extract citedTextEvidence from — rather than tripling this
 * extraction logic a third time inside each of those files.
 *
 * @param {object[]} content - response.content from Pass 1's
 *   client.messages.create() call
 * @returns {{title: string, url: string, excerpts: string[]}[]}
 */
function extractSearchResultsEvidence(content) {
  const byUrl = new Map();

  for (const block of content || []) {
    if (!block || block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
    for (const item of block.content) {
      if (!item || item.type !== 'web_search_result' || typeof item.url !== 'string') continue;
      if (!byUrl.has(item.url)) {
        byUrl.set(item.url, {
          title: typeof item.title === 'string' && item.title ? item.title : item.url,
          url: item.url,
          excerpts: [],
        });
      }
    }
  }

  for (const block of content || []) {
    if (!block || !Array.isArray(block.citations)) continue;
    for (const citation of block.citations) {
      if (!citation || typeof citation.cited_text !== 'string' || typeof citation.url !== 'string') continue;
      let entry = byUrl.get(citation.url);
      if (!entry) {
        entry = {
          title: typeof citation.title === 'string' && citation.title ? citation.title : citation.url,
          url: citation.url,
          excerpts: [],
        };
        byUrl.set(citation.url, entry);
      }
      entry.excerpts.push(citation.cited_text);
    }
  }

  return Array.from(byUrl.values());
}

/**
 * Same per-claim formatting lib/draft.js's/lib/revise.js's own
 * formatClaimsForPrompt() use for THEIR (Pass 1) prompts — kept as its own
 * copy here rather than imported from either, same "don't share a small
 * helper across files with genuinely different framing needs" pattern this
 * codebase already follows (draft.js and revise.js each keep their own
 * copy too, with slightly different empty-list messaging). Pass 2's
 * empty-list message is simpler than either of Pass 1's, since Pass 2 isn't
 * being asked to avoid inventing legal facts (that constraint shaped Pass
 * 1's writing already) — it's just being told what's available to point at.
 */
function formatClaimsForPrompt(claims) {
  if (!claims || claims.length === 0) {
    return '(No grounding claims apply to this piece — write "CLAIMS_USED: []" if asked, and leave CITATION_ANCHORS empty.)';
  }
  return claims
    .map((c, i) => {
      const flag = c.status === 'NEEDS_HUMAN_REVIEW' ? ' [STATUS: NEEDS_HUMAN_REVIEW]' : '';
      return (
        `${i + 1}. claim_key: ${c.claim_key}${flag}\n` +
        `   statement: ${c.statement}`
      );
    })
    .join('\n\n');
}

/**
 * Format the list of other published Rincon posts available to reference —
 * same convention as lib/draft.js's/lib/revise.js's own copy (kept
 * separately, same reasoning as formatClaimsForPrompt() above).
 */
function formatInternalLinkCandidatesForPrompt(candidates) {
  return candidates.map((c) => `- ${c.title}`).join('\n');
}

function formatSearchEvidenceForPrompt(evidence) {
  return evidence
    .map((e, i) => {
      const excerptLines = e.excerpts.map((ex) => `   real excerpt: "${ex}"`).join('\n');
      return `${i + 1}. "${e.title}" — ${e.url}${excerptLines ? '\n' + excerptLines : ''}`;
    })
    .join('\n\n');
}

/**
 * Format the PREVIOUS round's GENERAL_CITATIONS list for the prompt — see
 * `previousGeneralCitations` on packageDraft() below for where this comes
 * from and why only {title, url} (not anchor_text/supports) survives round
 * to round.
 */
function formatPreviousCitationsForPrompt(previousGeneralCitations) {
  return previousGeneralCitations
    .map((c, i) => `${i + 1}. "${c.title}" — ${c.url}`)
    .join('\n');
}

function buildSystemPrompt() {
  return `You are a metadata-packaging assistant for Rincon Management, a
Southern California property management company. Another process already
researched (when applicable), wrote, and finalized the article below — your
job is NOT to write, edit, rewrite, or add any sentence to the article
itself, with exactly one narrow exception (rule 5 below): identifying —
never writing — leaked process-narration sitting at the article's own
opening, if it's genuinely there. Your entire job is to produce a small set
of structured fields ABOUT the finished article: whether its opening is
actually leaked narration rather than real content, an SEO title and meta
description, which of the supplied grounding claims (if any) the article
actually discusses and where, which outside sources support any
general/non-legal claims already in it, which quotation(s) already in its
body can be sourced, and which related posts (if any) are a genuinely close
topical match.

HARD RULES:

1. Do not invent, restate, or add any LEGAL fact (a rule, a deadline, a
   dollar amount, a percentage, a notice period, a citation, a statute or
   ordinance number) beyond what the article body already states and what
   the supplied GROUNDING CLAIMS list already verifies. Your job is to
   point at facts already written and name their source — never to
   introduce a new one of your own.

2. GENERAL_CITATIONS and QUOTED_TEXT may each only support a GENERAL,
   NON-LEGAL claim already present in the article (a market statistic, a
   program name, industry trend data, sentiment, a business trend, or an
   organization characterizing its own data) — never a legal fact, even if
   a legal-sounding sentence in the article would otherwise seem to want
   one. If nothing in your search-results evidence or general knowledge
   would support a legal fact stated in the article, that is correct
   behavior — leave it unsourced rather than proposing something for it.

3. Every "anchor_text" value you produce (for CITATION_ANCHORS,
   GENERAL_CITATIONS, QUOTED_TEXT, or RELATED_POSTS) must be copied EXACTLY,
   character-for-character, from the article body given to you below — not
   paraphrased, not summarized, not corrected for a typo the article
   happens to contain. If you cannot find a precise phrase to point at,
   omit that entry (or just its anchor_text) rather than inventing one.

4. Output ONLY the structured fields described below, in the exact order
   given. No preamble, no commentary, no repeating the article body, and
   nothing before the first field or after the last one.

5. LEAKED_OPENING_NARRATION is a COMPREHENSION judgment, not a phrase
   search: decide whether the article's own opening text is genuinely the
   writer talking ABOUT the article, its research, or an editorial
   decision — rather than being part of the piece itself — even when it
   never uses an obvious announcement phrase ("I'll...", "Here's...", "Let
   me..."). Real leaked narration sometimes reads as ordinary, reasonable-
   sounding prose (e.g. the writer genuinely explaining why it handled two
   conflicting facts a certain way) — judge what the opening IS about, not
   how it happens to be phrased. Never flag real article content this way
   just because it happens to open with a first-person sentence, and never
   touch anything other than a leading span you're genuinely confident is
   narration — a normal direct-answer opening paragraph is real content,
   not narration. If you are not looking at leaked narration,
   LEAKED_OPENING_NARRATION must be exactly "" (empty) — do not flag
   ordinary content out of excess caution.`;
}

function buildUserPrompt({
  articleBody,
  claims,
  includeClaimsUsedField,
  internalLinkCandidates = [],
  searchEvidence = [],
  pass1HasWebSearch = false,
  previousGeneralCitations = [],
}) {
  const claimsSection = `GROUNDING CLAIMS (${
    includeClaimsUsedField
      ? 'candidates for this piece — the article may or may not actually discuss any of these'
      : 'already linked to this piece — the article should be grounded in these and only these'
  }):
${formatClaimsForPrompt(claims)}

`;

  const candidatesSection =
    internalLinkCandidates.length > 0
      ? `RELATED POST CANDIDATES (other published Rincon posts — you may declare
0-2 of these as related via RELATED_POSTS below; do not treat these as a
source of facts):
${formatInternalLinkCandidatesForPrompt(internalLinkCandidates)}

`
      : '';

  const hasEvidence = Array.isArray(searchEvidence) && searchEvidence.length > 0;
  const searchEvidenceSection = hasEvidence
    ? `SEARCH RESULTS FOUND WHILE RESEARCHING THIS ARTICLE (real sources the
writing process actually surfaced via web_search, with any real excerpt it
quoted from each — prefer one of these for GENERAL_CITATIONS/QUOTED_TEXT
when it's a genuine match; you may still draw on your own general
knowledge for GENERAL_CITATIONS if nothing below fits):
${formatSearchEvidenceForPrompt(searchEvidence)}

`
    : '';

  // Only ever non-empty on a REVISION (lib/revise.js reads these back out of
  // the "## Sources" section the PREVIOUS round already wrote into the
  // draft's stored body, before this round's Pass 1 rewrites it — see
  // lib/revise.js's extractPreviousGeneralCitations()). Empty on a fresh
  // draft.js call — nothing to carry forward yet. Deliberately only
  // title+url, not the previous round's anchor_text/supports: Pass 2 always
  // re-derives a fresh anchor_text against the CURRENT article body below
  // (see the GENERAL_CITATIONS step's continuity instruction), rather than
  // trusting a phrase from a wording that may no longer exist verbatim.
  const hasPreviousCitations = Array.isArray(previousGeneralCitations) && previousGeneralCitations.length > 0;
  const previousCitationsSection = hasPreviousCitations
    ? `PREVIOUSLY CITED GENERAL SOURCES (proposed by this same process on the
LAST revision round — see the GENERAL_CITATIONS step below for what to do
with these):
${formatPreviousCitationsForPrompt(previousGeneralCitations)}

`
    : '';

  let stepNumber = 1;

  // Requested FIRST, deliberately — parsePass2Response() below relies on
  // this being the one field it can anchor to the very START of the raw
  // response (every other field is anchored to the END, peeled off in
  // reverse request order — see extractLeadingJsonStringField()'s own
  // comment for why this one field needs the opposite anchor).
  const leakedNarrationStep = `${stepNumber++}. LEAKED_OPENING_NARRATION: "<...>"

   Before anything else, re-read the very beginning of the ARTICLE BODY
   above — its first sentence or few sentences, before it settles into the
   real piece. Decide: is this opening actually the writer talking ABOUT the
   article/research/its own editorial decisions, rather than being part of
   the article itself — even if it never uses an obvious hand-off phrase?
   A real, previously-confirmed example: "I have everything I need to write
   a well-grounded piece. Since this piece has no legal grounding claims,
   I'll avoid stating the specific legal figures... while freely using the
   FAIR Plan/wildfire market data as general facts with named sources." —
   only its FIRST sentence sounds like an obvious hand-off; its SECOND
   sentence is the writer explaining a real editorial decision in
   substantive-sounding language, which is exactly why this requires your
   judgment rather than a keyword search.

   If the opening genuinely reads this way, copy the EXACT text (character-
   for-character, starting at the very first character of the article body,
   through the last character of the narration, stopping right before the
   article's real content begins) as a JSON string. Otherwise — including
   for a normal direct-answer opening paragraph, which is real content, not
   narration — write exactly:

   LEAKED_OPENING_NARRATION: ""

   Format exactly:

   LEAKED_OPENING_NARRATION: "<exact leaked text, or empty string>"`;

  const metaDescriptionStep = `${stepNumber++}. META_DESCRIPTION: a complete, plain-English summary of what this
   article covers, 150-160 characters long, written for a search engine
   results page. Do not state any new fact, figure, or claim that isn't
   already in the article body. Format exactly:

   META_DESCRIPTION: <the 150-160 character summary>`;

  const seoTitleStep = `${stepNumber++}. SEO_TITLE: a short (~55-60 character), literal, keyword-forward
   title for this piece, distinct from the actual on-page headline. This is
   for the invisible search-engine title tag, not the headline a reader
   sees — write it clear and direct in plain search-engine style; it does
   not need to match Rincon's brand voice. Format exactly:

   SEO_TITLE: <the ~55-60 character title>`;

  const claimsUsedStep = includeClaimsUsedField
    ? `

${stepNumber++}. CLAIMS_USED: [claim_key_1, claim_key_2, ...]

   List every claim_key from GROUNDING CLAIMS above that the article body
   actually discusses. If it discusses none of them (e.g. this piece isn't
   about a regulated legal topic), write "CLAIMS_USED: []".`
    : '';

  const citationAnchorsStep = `

${stepNumber++}. CITATION_ANCHORS: [{"claim_key": "...", "anchor_text": "..."}, ...]

   For each claim_key ${
     includeClaimsUsedField
       ? 'you listed in CLAIMS_USED above'
       : 'among the GROUNDING CLAIMS above that the article actually discusses'
   }, name the exact short phrase from the article's own body — not a
   citation string, just pointing at text already written — where that
   claim's fact is discussed, so it can be turned into a link. Copy the
   phrase EXACTLY as it appears in the article body, character-for-
   character. Not every claim needs an anchor — only include an entry when
   you can point at a precise phrase; it's fine to skip a claim you can't
   confidently anchor. If ${
     includeClaimsUsedField ? 'you listed no claims above' : 'the article discusses no grounding claims'
   }, or none can be anchored, write "CITATION_ANCHORS: []".`;

  const generalCitationsContinuityRule = hasPreviousCitations
    ? `

   CARRY FORWARD CONTINUITY FROM THE PREVIOUS ROUND: see PREVIOUSLY CITED
   GENERAL SOURCES above. For each one, check whether the article body still
   contains — even if reworded — the general claim it supported. If it does,
   propose that exact same source again (same "title" and "url"), with a
   fresh "anchor_text" pointing at wherever that claim appears NOW. Do not
   silently drop or swap out a previously-cited source whose claim is still
   present just because a different source now also seems plausible for it.
   Only leave a previously-cited source out if the claim it supported was
   genuinely removed from the article this round. It is normal — expected,
   even — for GENERAL_CITATIONS to end up mostly or entirely the same list as
   last round when most of the article's general claims didn't change.`
    : '';

  const generalCitationsStep = `

${stepNumber++}. GENERAL_CITATIONS: [{"title": "...", "url": "...", "anchor_text": "...", "supports": "..."}, ...]

   Propose 0 or more outside sources that support a GENERAL, NON-LEGAL claim
   already stated in the article — market statistics, program names,
   industry trend data, and similar contextual claims. General citations
   must NEVER be used to source a legal fact — legal facts still come only
   from the GROUNDING CLAIMS section above.

   CHECK THE ARTICLE'S OWN TEXT FIRST, BEFORE ANY OTHER CANDIDATE: for each
   general claim you're about to source, first check whether the article
   body ALREADY names a specific source for it directly in its own prose
   (e.g. "...per RentEngine's Q1 2026 leasing data...", "...Zego's 2026
   Resident Experience Management Report...", "...(USC Lusk/Yardi, October
   2025)..."). If the text already names a source this way, your citation
   for that claim MUST be that exact named source — look for its real URL in
   the SEARCH RESULTS evidence below first; if it isn't there, supply the
   real URL for that same named source from your own knowledge. Never
   substitute a different, unrelated source of your own choosing for a claim
   the article already attributes by name — that is the single most
   important rule in this step. Only reach for a source of your own choosing
   (from SEARCH RESULTS or general knowledge) when the article states a
   general claim WITHOUT already naming a source for it.${generalCitationsContinuityRule}

   For each proposed citation: "title" is the source's real title, "url" is
   its real URL, "anchor_text" is the exact short phrase from the article's
   own body where that claim appears (copied exactly, same rule as
   CITATION_ANCHORS above), and "supports" is a one-sentence note on what it
   supports. If you have no general citations to propose, write
   "GENERAL_CITATIONS: []".`;

  const quotedTextStep = pass1HasWebSearch
    ? `

${stepNumber++}. QUOTED_TEXT: [{"quote": "...", "url": "...", "attributed_to": "...", "anchor_text": "..."}, ...]

   The article's own body may already include a direct quotation (a real
   sentence found via web_search while researching, quoted verbatim and
   attributed to its source). Propose 0 or more of these, using the SEARCH
   RESULTS list above to supply the real source url the quote actually came
   from. Keep each quote to roughly one sentence, under ~150 characters —
   that is the limit of what can actually be checked against the search
   result it came from, so a longer excerpt cannot be verified and will be
   flagged for human review instead of published cleanly. For each proposed
   quote: "quote" is the exact quoted text as it appears in the article;
   "url" is the real source page URL it came from; "attributed_to" is who
   or what said/wrote it (a person's name and title, an organization, or a
   report name); "anchor_text" is the exact phrase from the article's own
   body where the quote already appears — copied EXACTLY as it appears in
   the article body, character-for-character, same rule as
   CITATION_ANCHORS/GENERAL_CITATIONS above. A quote may only ever support
   a general, non-legal point — market color, sentiment, a business trend,
   or an organization characterizing its own data — never a legal fact
   (a rule, a deadline, a dollar amount, a percentage, a notice period, a
   citation, a statute or ordinance number), even one phrased in someone
   else's words rather than the article's own. If the article has no
   quotes to propose, write "QUOTED_TEXT: []".`
    : '';

  const hasCandidates = internalLinkCandidates.length > 0;
  const relatedPostsStep = hasCandidates
    ? `

${stepNumber++}. RELATED_POSTS: [{"title": "...", "anchor_text": "..."}, ...]

   Pick 0-2 titles from the RELATED POST CANDIDATES list above. Two rules,
   in order:

   - STRONG MATCH: if a candidate is a genuinely close topical match to
     what the article is actually about — not just tangentially related,
     but clearly covering the same concept (e.g. a candidate title that
     essentially names the same thing this article covers) — include it.
     Do not skip an obvious match out of excess caution.
   - WEAK MATCH: if a candidate is only tangentially related, leave it
     out — do not force a link just to have one. An empty list is the
     right answer when nothing on the list is a genuinely close match.

   Copy each "title" EXACTLY as it appears in that list, character-for-
   character. Do not invent a title that isn't in the list. For each one,
   if you can find a natural phrase already in the article's own body to
   reference it, name that exact phrase as "anchor_text" — copied EXACTLY
   as it appears in the article body, character-for-character, same rule
   as CITATION_ANCHORS above. If no natural inline moment exists, omit
   "anchor_text" (or set it to null) — the post will still be listed in
   Related Reading either way; a missing inline moment is never a reason
   to drop a genuinely strong match. Format exactly:

   RELATED_POSTS: [{"title": "...", "anchor_text": "..."}]`
    : '';

  const steps = [
    leakedNarrationStep,
    metaDescriptionStep,
    seoTitleStep,
    claimsUsedStep,
    citationAnchorsStep,
    generalCitationsStep,
    quotedTextStep,
    relatedPostsStep,
  ].join('');

  return `Here is the FINISHED ARTICLE another process already researched and
wrote. Do not rewrite, edit, or add to it — your only job is to produce the
structured fields below, based on what it already says.

--- ARTICLE BODY ---
${articleBody}
--- END ARTICLE BODY ---

${claimsSection}${candidatesSection}${searchEvidenceSection}${previousCitationsSection}Produce ONLY the following fields, in this exact order — the order
matters:

${steps}`;
}

/**
 * Parse a "FIELD_NAME: [...]" JSON-array trailing line out of whatever text
 * currently remains, anchored to the end of the string. Ported UNCHANGED
 * from lib/draft.js's/lib/revise.js's own identical helper (see either
 * file's git history for the original) — this is the "reuse that parsing
 * code, don't rewrite it" the build spec calls for. Now lives here (and
 * only here) because Pass 2 is the only place that still parses trailing
 * JSON-array fields — Pass 1 in both draft.js and revise.js no longer
 * produces any.
 * @returns {{value: object[], remaining: string}}
 */
function extractJsonArrayField(text, fieldName) {
  const regex = new RegExp(`${fieldName}:\\s*(\\[[\\s\\S]*\\])\\s*$`, 'i');
  const match = text.match(regex);
  if (!match) return { value: [], remaining: text };

  let value = [];
  try {
    const parsed = JSON.parse(match[1]);
    if (Array.isArray(parsed)) value = parsed;
  } catch (e) {
    value = []; // malformed JSON — graceful fallback, never an error
  }
  return { value, remaining: text.slice(0, match.index) };
}

/**
 * Parse a `FIELD_NAME: "<json string>"` value anchored to the very START of
 * `text` — the opposite anchor from extractJsonArrayField() above (which
 * anchors to the END of whatever text remains). Used ONLY for
 * LEAKED_OPENING_NARRATION, the one field requested FIRST, output-order, in
 * buildUserPrompt() above — specifically so it can be trusted to sit at the
 * very front of Pass 2's response (per that prompt's own hard rule 4
 * requiring no preamble before the first field). Every OTHER field here is
 * requested (and therefore parsed) in reverse order from the end backward,
 * since stripping one off the end is what exposes the next one at the new
 * end — that scheme doesn't work for the first field, since there's nothing
 * before it to expose.
 * @returns {{value: string, remaining: string}}
 */
function extractLeadingJsonStringField(text, fieldName) {
  const regex = new RegExp(`^\\s*${fieldName}:\\s*("(?:[^"\\\\]|\\\\.)*")\\s*\\n?`, 'i');
  const match = text.match(regex);
  if (!match) return { value: '', remaining: text };

  let value = '';
  try {
    const parsed = JSON.parse(match[1]);
    if (typeof parsed === 'string') value = parsed;
  } catch (e) {
    value = ''; // malformed JSON — graceful fallback, never an error
  }
  return { value, remaining: text.slice(match[0].length) };
}

/**
 * Parse Pass 2's response text into each structured field. Same
 * strip-from-the-end-backward approach as the old single-pass
 * extractClaimsUsed()/extractTitleAndBody() (ported, not reinvented): peel
 * RELATED_POSTS first (last field when present), then QUOTED_TEXT, then
 * GENERAL_CITATIONS, then CITATION_ANCHORS, then CLAIMS_USED (when
 * requested), then SEO_TITLE, then META_DESCRIPTION — so each regex/parse
 * stays anchored to the end of whatever text remains. Every field falls
 * back gracefully (null, or [] for array fields) if that line isn't found
 * in the expected format — never an error, same contract as before.
 */
function parsePass2Response(text, { includeClaimsUsedField }) {
  let remaining = text || '';

  // Parsed FIRST, from the FRONT — see extractLeadingJsonStringField()'s own
  // comment above for why this one field is anchored differently from every
  // other field below (all of which peel from the END).
  const leakedNarrationResult = extractLeadingJsonStringField(remaining, 'LEAKED_OPENING_NARRATION');
  const leakedOpeningNarration = leakedNarrationResult.value;
  remaining = leakedNarrationResult.remaining;

  const relatedPostsResult = extractJsonArrayField(remaining, 'RELATED_POSTS');
  const relatedPosts = relatedPostsResult.value;
  remaining = relatedPostsResult.remaining;

  const quotedTextResult = extractJsonArrayField(remaining, 'QUOTED_TEXT');
  const quotedText = quotedTextResult.value;
  remaining = quotedTextResult.remaining;

  const generalCitationsResult = extractJsonArrayField(remaining, 'GENERAL_CITATIONS');
  const generalCitations = generalCitationsResult.value;
  remaining = generalCitationsResult.remaining;

  const citationAnchorsResult = extractJsonArrayField(remaining, 'CITATION_ANCHORS');
  const citationAnchors = citationAnchorsResult.value;
  remaining = citationAnchorsResult.remaining;

  let claimKeysUsed = [];
  if (includeClaimsUsedField) {
    const claimsMatch = remaining.match(/CLAIMS_USED:\s*\[([^\]]*)\]\s*$/i);
    claimKeysUsed = claimsMatch
      ? claimsMatch[1]
          .split(',')
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean)
      : [];
    if (claimsMatch) remaining = remaining.slice(0, claimsMatch.index);
  }

  const seoTitleMatch = remaining.match(/SEO_TITLE:\s*(.+?)\s*$/i);
  const seoTitle = seoTitleMatch ? seoTitleMatch[1].trim() : null;
  if (seoTitleMatch) remaining = remaining.slice(0, seoTitleMatch.index);

  const metaDescMatch = remaining.match(/META_DESCRIPTION:\s*(.+?)\s*$/i);
  const metaDescription = metaDescMatch ? metaDescMatch[1].trim() : null;

  return {
    seoTitle,
    metaDescription,
    claimKeysUsed,
    citationAnchors,
    generalCitations,
    quotedText,
    relatedPosts,
    leakedOpeningNarration,
  };
}

/**
 * If Pass 2 identified genuine leaked process-narration at the very start of
 * the article it was handed (LEAKED_OPENING_NARRATION above), mechanically
 * remove that EXACT text from the front of `articleBody` — never trusting
 * Pass 2's judgment alone to rewrite anything. This only ever deletes a
 * literal, independently-VERIFIED prefix, the same "point at exact text,
 * verify it's really there, then do plain string surgery — never let the
 * model retype anything" pattern lib/seo.js's own anchor-based mechanisms
 * (CITATION_ANCHORS, GENERAL_CITATIONS, QUOTED_TEXT) already use, for the
 * identical reason: the model is trusted to RECOGNIZE and QUOTE text, never
 * to RETYPE it, since retyping risks silently corrupting something nearby
 * that was never meant to change. This is why Pass 2 is asked to copy the
 * leaked text out (LEAKED_OPENING_NARRATION) rather than return a whole
 * rewritten article.
 *
 * Returns `articleBody` completely UNCHANGED whenever `leakedOpeningNarration`
 * is empty, or isn't actually found as a genuine leading prefix of
 * `articleBody` (allowing for the body's own leading whitespace) — a
 * hallucinated, mismatched, or slightly-off proposal is silently ignored
 * rather than risking a bad cut, same fail-safe contract every anchor-based
 * function in lib/seo.js already follows ("no match found means the text is
 * left alone, never an error").
 *
 * @param {string} articleBody
 * @param {string} leakedOpeningNarration - LEAKED_OPENING_NARRATION's parsed
 *   value: '' when Pass 2 found nothing, or the exact text it says is leaked
 * @returns {string}
 */
function stripLeakedOpeningNarration(articleBody, leakedOpeningNarration) {
  const body = articleBody || '';
  const candidate = (leakedOpeningNarration || '').trim();
  if (!candidate) return body;

  const leadingWhitespaceMatch = body.match(/^\s*/);
  const leadingWhitespace = leadingWhitespaceMatch ? leadingWhitespaceMatch[0] : '';
  const bodyAfterLeadingWhitespace = body.slice(leadingWhitespace.length);

  if (!bodyAfterLeadingWhitespace.startsWith(candidate)) {
    return body; // not a genuine prefix — leave the body completely untouched
  }

  return bodyAfterLeadingWhitespace.slice(candidate.length).replace(/^\s+/, '');
}

/**
 * ============================================================
 * detectLegalClaims() — SHARED legal-claim detector
 * ============================================================
 * Built for two upcoming features at once (see the build spec this shipped
 * against): (1) legal-topic drafts being allowed to research a legal fact
 * FREELY — not only from the pre-approved compliance_claims list — as long
 * as they name a real source, and (2) a future conversational editing
 * feature (chat with the tool, eventually including a scoped in-place edit)
 * that can touch a legal-topic article outside the normal draft/revise
 * pipeline entirely. BOTH need the exact same answer to the exact same
 * question — "does this piece of text state a new, specific legal fact that
 * hasn't been human-reviewed yet?" — so this is ONE function, not two. That
 * requirement is also why this is deliberately NOT implemented as one more
 * field bolted onto packageDraft()'s existing Pass 2 call even though
 * Layer 2 below follows that exact same call shape/contract: packageDraft()
 * needs a full Pass-2 context (grounding claims, internal-link candidates,
 * search evidence, SEO/citation instructions) that a future scoped
 * conversational edit will never have and shouldn't need to build just to
 * ask this one question. detectLegalClaims() only ever needs the finished
 * text and the claims already grounding it — nothing else — so it works
 * standalone for either caller.
 *
 * Two independent layers, combined:
 *
 *   Layer 1 ("pattern_match") — plain JS, no AI call, runs first. Scans for
 *   three specific shapes: a statute/bill citation format; a number-of-
 *   days/months phrase sharing a sentence with a legal-process word; or a
 *   dollar figure sharing a sentence with a legal/court word. Requiring the
 *   number/citation AND the legal word TOGETHER in the same sentence is the
 *   whole point — it's what keeps an ordinary rent price or an unrelated
 *   scheduling line from false-positiving.
 *
 *   Layer 2 ("ai_comprehension") — one small, focused Claude call, same
 *   "point at it, don't retype it" contract this file already uses for
 *   LEAKED_OPENING_NARRATION: ask whether the text states a new, specific,
 *   checkable legal fact not already covered by an existing grounding
 *   claim, have it name the EXACT verbatim span, then mechanically verify
 *   that span is a real substring of the body before trusting it. This is
 *   what catches an informally-phrased claim Layer 1's regexes can't
 *   pattern-match — e.g. "landlords now have twice as long to expect a
 *   response" instead of "5 to 10 business days".
 *
 * Findings from either layer are filtered against `existingGroundingClaims`
 * (skip anything already substantively covered by one of those) and deduped
 * against each other by exact claim text. NOT filtered against
 * legal_claim_reviews — this function has no content_item_id and does no
 * database I/O at all (see "PURE" below), so a caller with database access
 * (lib/draft.js, lib/revise.js — see lib/legal-review.js's
 * filterNewLegalClaimFindings()) is responsible for dropping anything that
 * already has a row for that exact wording.
 *
 * PURE: makes zero database calls and writes nothing anywhere. It DOES make
 * one Claude API call (Layer 2) — "pure" here means "has no side effects on
 * stored state," the same sense the build spec uses it in, not strict
 * referential transparency. The caller decides what, if anything, to do
 * with the results.
 *
 * @param {string} articleBody - finished article/edit text to scan
 * @param {object[]} [existingGroundingClaims] - claims already grounding
 *   this piece (same shape as packageDraft()'s `claims` param — needs at
 *   least `.statement`). Pass the NARROWEST accurate set (e.g. draft.js's
 *   claimsUsed, not its full candidate `claims` list) — a broader reference
 *   list means more chances to wrongly suppress a genuinely new claim as
 *   "already covered," which is the wrong direction to err on a safety net
 *   like this one.
 * @returns {Promise<{claimText: string, context: string, detectedBy: 'pattern_match'|'ai_comprehension', sourceUrl: string|null}[]>}
 */

const CITATION_REGEX = /\b(?:AB|SB)\s?\d+\b|Civil Code\s*§+\s*[\d.]+[a-z]?|CCP\s*§+\s*[\d.,\-–—]+|(?:Municipal|City)\s+Code\s*§+\s*[\d.]+|Ordinance\s+(?:No\.?\s*)?\d+[\w-]*/gi;

const DAYS_MONTHS_NUMBER_REGEX = /\b\d+(?:\s*(?:to|-|–|—)\s*\d+)?\s*(?:business\s+|calendar\s+)?(?:days?|weeks?|months?)\b/gi;

const LEGAL_PROCESS_WORD_REGEX = /\b(?:notice|eviction|cure|vacate|unlawful detainer|security deposit|rent increase|response window)\b/i;

const DOLLAR_REGEX = /\$[\d,]+(?:\.\d+)?\+?(?:\s*[-–—]\s*\$?[\d,]+(?:\.\d+)?\+?)?/g;

const LEGAL_COURT_WORD_REGEX = /\b(?:filing fees?|relocation assistance|statutory damages|attorney fees?|writ)\b/i;

// Short legal/statutory abbreviations whose OWN trailing period is NOT a
// sentence boundary — e.g. "under Gov. Code", "per Civ. Proc. Code". A
// narrow, explicit list rather than a general heuristic (e.g. "any short
// capitalized word before a period") on purpose: a missed abbreviation just
// means Layer 1/2 sees one extra, slightly-fragmented chunk — annoying, not
// unsafe, since Layer 2's comprehension pass still reads the article's real
// prose regardless of how it's chunked. A heuristic broad enough to catch
// every possible abbreviation risks the opposite mistake — silently merging
// two genuinely separate sentences into one chunk — which is a bigger,
// riskier behavior change than this fix is meant to make.
//
// BUG FIX (TARS, 2026-08-08): confirmed live — splitIntoSentenceLikeChunks()
// was splitting "...under Gov. Code per SB 564]." right after "Gov." (a
// period followed by a space and a capital letter, which the original regex
// always treated as a sentence boundary), producing a garbage claim
// ("Code per SB 564].") that Mason then had to review as NEEDS_SOURCE_CHECK
// — not a safety hole (Mason still handles it gracefully), but wasted
// queue noise and a wasted Mason API call on every occurrence.
//
// "No" is deliberately NOT in this list — see NO_ABBREVIATION_REGEX below
// for why it needs its own, narrower rule instead of joining this
// unconditional list.
const SENTENCE_BOUNDARY_ABBREVIATIONS = [
  'Gov', 'Civ', 'Cal', 'Penal', 'Evid', 'Welf', 'Inst', 'Bus', 'Prof',
  'Corp', 'Fin', 'Pub', 'Res', 'Sec', 'Art', 'Ch', 'Div', 'Tit',
  'St', 'Ord', 'Assem', 'Sen',
];

// BUG FIX (TARS, 2026-08-08, round 4 of the legal-review gap): "No." (added
// above for "Ordinance No. 3012"-style citations) is unlike every other
// entry in SENTENCE_BOUNDARY_ABBREVIATIONS — "Gov", "Civ", "Cal", etc. are
// never, in real content, a standalone English sentence ending in "."; "No."
// genuinely is one, constantly, as a one-word answer ("Can a landlord charge
// for ordinary carpet wear? No. State law treats that as normal
// depreciation..."). Putting "No" in the unconditional list suppressed the
// split there too, silently merging the answer sentence into the next one —
// exactly the run-on-widening mechanism behind the primary legal-review
// coverage bug this same round fixes in lib/legal-review.js.
//
// The two cases are distinguished by what comes right after: a citation's
// "No." is always followed by the ordinance number itself ("No. 3012" —
// digit right after the whitespace), while a real sentence-ending "No." is
// followed by a new sentence starting with a capital letter, never a
// number. So "No." only blocks the split when a number follows it.
const NO_ABBREVIATION_REGEX = '\\bNo\\.(?=\\s*\\d)';

/**
 * Build the sentence-splitting regex fresh each call (not a cached top-level
 * regex) so a rewound `lastIndex` is guaranteed, matching this file's own
 * convention elsewhere (see buildArticleMarkerLineRegex()-style helpers in
 * lib/draft.js/lib/revise.js). Same shape as the original inline regex, with
 * two added negative lookbehinds: the split point (right after the
 * sentence-ending punctuation) must not be immediately preceded by (a) one
 * of SENTENCE_BOUNDARY_ABBREVIATIONS above followed by its own period —
 * i.e. "Gov." doesn't count as a sentence end, but "notice." does — or (b)
 * "No." followed by a number (NO_ABBREVIATION_REGEX above) — i.e.
 * "No. 3012" doesn't count as a sentence end, but "No. State ..." does.
 */
function buildSentenceSplitRegex() {
  const abbrevAlternation = SENTENCE_BOUNDARY_ABBREVIATIONS.join('|');
  return new RegExp(
    `(?<!\\b(?:${abbrevAlternation})\\.)(?<!${NO_ABBREVIATION_REGEX})(?<=[.!?])\\s+(?=[A-Z0-9"'(\\[])`,
    'g'
  );
}

/**
 * Split article text into sentence-like chunks for Layer 1 to scan one at a
 * time — first by line (so markdown headings/list items each stand alone),
 * then by sentence-ending punctuation within a line. Deliberately simple:
 * false negatives here (an oddly-split sentence Layer 1 then misses) are
 * fine, since Layer 2's comprehension pass is the backstop for anything
 * Layer 1's regexes don't catch. Every chunk returned is guaranteed to be a
 * verbatim substring of the original text (only .trim() is applied, which
 * never changes interior characters), so callers never need to re-verify it.
 */
function splitIntoSentenceLikeChunks(text) {
  const chunks = [];
  for (const line of (text || '').split(/\n+/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    for (const sentence of trimmedLine.split(buildSentenceSplitRegex())) {
      const trimmed = sentence.trim();
      if (trimmed) chunks.push(trimmed);
    }
  }
  return chunks;
}

/** Lowercase, alphanumeric-only — for comparing a specific number/citation
 * token against grounding-claim statement text without $, §, commas, or
 * spacing differences causing a false "not covered" result. */
function normalizeForCoverageCheck(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Small set of long-but-still-generic landlord-tenant/property-management/
// legal words that show up in nearly every grounding claim's statement AND
// nearly every legal-sounding article sentence alike — excluded from
// extractTopicalWords() below so two claims that are actually about
// DIFFERENT topics don't register as "overlapping" just because they're
// both broadly about landlord-tenant law. This is NOT a general-purpose
// English stopword list (a, the, is, of, ...) — ordinary short filler words
// are already excluded by the 5-character floor in extractTopicalWords();
// this list exists specifically for longer domain words that floor alone
// wouldn't catch.
const GENERIC_LEGAL_WORDS = new Set([
  'tenant', 'tenants', 'landlord', 'landlords', 'rental', 'rentals',
  'lease', 'leases', 'notice', 'notices', 'california', 'section',
  'sections', 'ordinance', 'ordinances', 'dwelling', 'dwellings',
  'housing', 'require', 'required', 'requires', 'provide', 'provided',
  'written', 'within', 'shall', 'covered', 'property', 'properties',
  'certain', 'unit', 'units', 'ventura', 'county',
]);

/**
 * Extract the lowercase "topical" words (5+ letters, not purely numeric, not
 * in GENERIC_LEGAL_WORDS above) from a piece of text — used by
 * isTokenAlreadyCovered() below to judge whether a sentence and a grounding
 * claim's statement are actually about the same underlying fact, not merely
 * sharing a coincidental number. See isTokenAlreadyCovered()'s own comment
 * for the real case this exists to catch.
 * @param {string} text
 * @returns {Set<string>}
 */
function extractTopicalWords(text) {
  const words = (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 5 && !/^\d+$/.test(w) && !GENERIC_LEGAL_WORDS.has(w));
  return new Set(words);
}

// Minimum number of shared topical words (see extractTopicalWords() above)
// required between the sentence a matched token was found in and a
// grounding claim's own statement before that token is treated as "the same
// fact, already covered" — see isTokenAlreadyCovered()'s own comment for
// why a bare token match alone is not enough. A single shared topical word
// is deliberately not sufficient on its own (two genuinely different claims
// can each happen to mention one same specific-sounding term without being
// the same fact); 2 is a low bar that a coincidental token collision
// essentially never clears on its own, while a genuine restatement of the
// same grounding claim clears easily (confirmed against this file's own
// regression test — see detectLegalClaims()'s test suite, Test A).
const MIN_SHARED_TOPICAL_WORDS = 2;

/**
 * True if `token` (a specific citation/number/dollar figure Layer 1 just
 * matched, found inside `context` — the sentence-like chunk it was matched
 * in) is already covered, in substance, by at least one grounding claim's
 * own statement — i.e. this isn't a NEW fact, it's the article correctly
 * citing something already pre-approved.
 *
 * BUG FIX (TARS, 2026-08-02): this used to be plain substring matching on
 * the bare token alone — "does this number appear anywhere inside an
 * approved claim's statement text." That is fundamentally unreliable for a
 * GENERIC quantity (a dollar figure, a day/month count), because two
 * completely unrelated legal claims can trivially share one. Confirmed both
 * by code inspection and by a real, repeated test: an APPROVED grounding
 * claim about Oxnard relocation assistance (its statement contains
 * "$5,000") silently suppressed a completely unrelated article claim about
 * attorney fees (also "$5,000", different topic, different legal context)
 * purely because the digits matched — a real false-negative safety gap,
 * since Layer 2 (the AI comprehension check) is NOT guaranteed to catch
 * what Layer 1 wrongly waves through (confirmed: both layers stayed silent
 * in 1 of 4 repeated runs before this fix).
 *
 * Fix: for a GENERIC quantity token (`requireTopicalOverlap: true` — see
 * detectPatternMatchClaims()'s DAYS_MONTHS_NUMBER_REGEX/DOLLAR_REGEX call
 * sites below), a bare token match is now necessary but not sufficient —
 * the sentence the token was found in must ALSO share real topical
 * vocabulary with the claim's own statement
 * (extractTopicalWords()/MIN_SHARED_TOPICAL_WORDS above) before the token is
 * treated as "the same fact." This stays intentionally conservative in the
 * SAME safe direction the original substring check already documented:
 * raising the bar for suppression can only make this check MORE likely to
 * flag something for review that turns out to already be grounded (mildly
 * annoying, Mason/Peter dismiss it quickly) — it can never make it more
 * likely to silently miss a genuinely new claim, which remains the outcome
 * this whole feature exists to prevent.
 *
 * DELIBERATELY NOT applied to a CITATION_REGEX match
 * (`requireTopicalOverlap: false` — a statute/bill/ordinance/municipal-code
 * number, e.g. "AB 1482" or "Civil Code § 1950.5") — a real citation number
 * is a precise, essentially-unique identifier, unlike a bare dollar figure
 * or day count; two unrelated claims essentially never coincidentally share
 * one, so the original plain substring check remains reliable there.
 * Confirmed necessary, not just simpler, by a real regression caught in live
 * testing: word-by-word topical-overlap matching treats "AB 1482" (as
 * grounding claims are normally written, with a space) and "AB1482" (as it
 * appeared in a real article's own internal-link title, no space) as
 * non-overlapping token sets, wrongly un-suppressing an already-covered
 * citation — normalizeForCoverageCheck's full-string, whitespace-insensitive
 * comparison already handles that correctly for citations and is not
 * replaced for them.
 *
 * @param {string} token
 * @param {string} context - the sentence-like chunk `token` was matched in
 *   (detectPatternMatchClaims()'s own `chunk`)
 * @param {object[]} existingGroundingClaims
 * @param {object} [opts]
 * @param {boolean} [opts.requireTopicalOverlap] - true for a generic
 *   quantity token (dollar figure, day/month count); false for a citation
 *   token (see this function's own comment above for why the two need
 *   different treatment)
 */
function isTokenAlreadyCovered(token, context, existingGroundingClaims, { requireTopicalOverlap = true } = {}) {
  const normalizedToken = normalizeForCoverageCheck(token);
  if (!normalizedToken) return false;
  const contextWords = requireTopicalOverlap ? extractTopicalWords(context) : null;
  return (existingGroundingClaims || []).some((c) => {
    const statement = c && c.statement;
    const normalizedStatement = normalizeForCoverageCheck(statement);
    if (!normalizedStatement || !normalizedStatement.includes(normalizedToken)) return false;
    if (!requireTopicalOverlap) return true;

    let sharedCount = 0;
    const statementWords = extractTopicalWords(statement);
    for (const w of contextWords) {
      if (statementWords.has(w)) sharedCount++;
    }
    return sharedCount >= MIN_SHARED_TOPICAL_WORDS;
  });
}

/**
 * Layer 1: plain-JS pattern matching, no AI call. See this section's own
 * header comment above for the three shapes scanned for. Returns at most
 * one finding per sentence-like chunk (a chunk matching more than one
 * pattern — e.g. both a citation AND a dollar+legal-word pair — still only
 * produces one row; there's nothing more for a reviewer to see twice).
 */
function detectPatternMatchClaims(articleBody, existingGroundingClaims) {
  const body = articleBody || '';
  const chunks = splitIntoSentenceLikeChunks(body);
  const findings = [];

  for (const chunk of chunks) {
    let matchedToken = null;

    const citationMatches = chunk.match(CITATION_REGEX);
    if (citationMatches) {
      // requireTopicalOverlap: false — a citation number is a precise,
      // essentially-unique identifier; see isTokenAlreadyCovered()'s own
      // comment for why this branch deliberately keeps the plain substring
      // check rather than the word-overlap check the two generic-quantity
      // branches below use.
      matchedToken =
        citationMatches.find(
          (t) => !isTokenAlreadyCovered(t, chunk, existingGroundingClaims, { requireTopicalOverlap: false })
        ) || null;
    }

    if (!matchedToken && LEGAL_PROCESS_WORD_REGEX.test(chunk)) {
      const daysMatches = chunk.match(DAYS_MONTHS_NUMBER_REGEX);
      if (daysMatches) {
        matchedToken = daysMatches.find((t) => !isTokenAlreadyCovered(t, chunk, existingGroundingClaims)) || null;
      }
    }

    if (!matchedToken && LEGAL_COURT_WORD_REGEX.test(chunk)) {
      const dollarMatches = chunk.match(DOLLAR_REGEX);
      if (dollarMatches) {
        matchedToken = dollarMatches.find((t) => !isTokenAlreadyCovered(t, chunk, existingGroundingClaims)) || null;
      }
    }

    if (matchedToken && body.includes(chunk)) {
      findings.push({ claimText: chunk, context: chunk, detectedBy: 'pattern_match' });
    }
  }

  return findings;
}

function buildLegalClaimsSystemPrompt() {
  return `You are a legal-claims screening assistant for Rincon Management, a
Southern California property management company. You are given a finished
piece of writing and a list of legal facts that have ALREADY been reviewed
and pre-approved for use (GROUNDING CLAIMS). Your only job is to identify
whether the TEXT states any NEW, specific, checkable legal fact that is NOT
already covered by one of the GROUNDING CLAIMS below.

A "specific, checkable legal fact" means something a reader could actually
go verify against a real source: a rule, a deadline, a notice period, a
dollar figure, a percentage, a statute/ordinance citation, or a similarly
concrete legal claim. This is a COMPREHENSION judgment, not a keyword
search — an informally-phrased claim counts just as much as a precisely-
worded one (e.g. "landlords now have twice as long to expect a response" is
just as much a specific legal fact as "10 business days" would be, since a
reader could look it up and find out whether it's true). A claim that is
already substantively covered by one of the GROUNDING CLAIMS below is NOT
new, even if the TEXT phrases it differently — do not report it.

Never report a vague or general legal-sounding statement ("give proper
notice," "the eviction process takes time," "follow the correct legal
steps") — only a claim specific enough that a reviewer could actually check
it against a real source. Never report ordinary market/business content
(prices, statistics, opinions, general advice) — those are not legal claims.

HARD RULES:

1. For each new claim you find, copy "claim_text" EXACTLY, character-for-
   character, from the TEXT given below — never paraphrase, correct, or
   retype it. If you cannot find a precise verbatim span to point at, do
   not report that claim.
2. "context" should be the same sentence (or a little more surrounding text,
   if useful for a reviewer) — also copied EXACTLY, character-for-character,
   from the TEXT.
3. Output ONLY the field below, in this exact format, nothing before or
   after it:

   NEW_LEGAL_CLAIMS: [{"claim_text": "...", "context": "..."}, ...]

   If the TEXT states no new, specific, checkable legal fact beyond the
   GROUNDING CLAIMS, write exactly:

   NEW_LEGAL_CLAIMS: []`;
}

function buildLegalClaimsUserPrompt({ articleBody, existingGroundingClaims }) {
  return `GROUNDING CLAIMS (already reviewed and pre-approved — do not report
anything already substantively covered by one of these, even if phrased
differently below):
${formatClaimsForPrompt(existingGroundingClaims)}

--- TEXT ---
${articleBody}
--- END TEXT ---

Produce ONLY the NEW_LEGAL_CLAIMS field described above.`;
}

/**
 * Layer 2: one small, focused Claude call — see this section's own header
 * comment above for why this is its OWN call rather than a field on
 * packageDraft()'s Pass 2 call. Never throws: a failure here (network,
 * rate limit, malformed response) is logged and treated as "Layer 2 found
 * nothing this run," so a hiccup in this additive safety net can never
 * block the drafting/revision pipeline it's bolted onto. Same
 * "hallucinated span means silently ignore it" contract
 * stripLeakedOpeningNarration() already uses.
 */
async function detectAiComprehensionClaims(articleBody, existingGroundingClaims) {
  const body = articleBody || '';
  if (!body.trim()) return [];

  let responseText = '';
  try {
    const client = getClient();
    const response = await client.messages.create({
      model: MODEL,
      // A handful of short {claim_text, context} pairs at most — far less
      // headroom than Pass 2's full metadata set needs.
      max_tokens: 1024,
      system: buildLegalClaimsSystemPrompt(),
      messages: [
        {
          role: 'user',
          content: buildLegalClaimsUserPrompt({ articleBody: body, existingGroundingClaims }),
        },
      ],
    });
    const textBlock = (response.content || []).find((b) => b && b.type === 'text' && typeof b.text === 'string');
    responseText = textBlock ? textBlock.text : '';
  } catch (e) {
    console.warn(
      '[package-draft.js] detectLegalClaims(): Layer 2 (ai_comprehension) Claude ' +
        `call failed — continuing with pattern_match findings only. ${e.message}`
    );
    return [];
  }

  const { value: rawClaims } = extractJsonArrayField(responseText, 'NEW_LEGAL_CLAIMS');

  const verified = [];
  for (const raw of rawClaims) {
    if (!raw || typeof raw.claim_text !== 'string') continue;
    const claimText = raw.claim_text;
    // Mechanical verification — same "the model points, it never retypes"
    // contract as stripLeakedOpeningNarration()/CITATION_ANCHORS/etc: a
    // hallucinated or slightly-off span is silently dropped, never trusted.
    if (!claimText.trim() || !body.includes(claimText)) continue;
    const contextCandidate = typeof raw.context === 'string' ? raw.context : '';
    const context = contextCandidate && body.includes(contextCandidate) ? contextCandidate : claimText;
    verified.push({ claimText, context, detectedBy: 'ai_comprehension' });
  }
  return verified;
}

/** Best-effort: if a finding's context contains a markdown link, surface
 * that URL as a starting point for Mason's source_tier review — never
 * required, never verified as "the" real source, just a convenience so an
 * obvious inline citation isn't ignored. Returns null when no link is
 * present; the caller (lib/draft.js/lib/revise.js) decides what to store in
 * legal_claim_reviews.source_url (NOT NULL) when this comes back null. */
function extractNearbySourceUrl(text) {
  const match = (text || '').match(/\[[^\]]*\]\((https?:\/\/[^\s)]+)/);
  return match ? match[1] : null;
}

async function detectLegalClaims(articleBody, existingGroundingClaims = []) {
  const body = articleBody || '';
  const claims = existingGroundingClaims || [];

  const patternFindings = detectPatternMatchClaims(body, claims);
  const aiFindings = await detectAiComprehensionClaims(body, claims);

  const seenClaimText = new Set(patternFindings.map((f) => f.claimText));
  const combined = [...patternFindings];
  for (const finding of aiFindings) {
    if (seenClaimText.has(finding.claimText)) continue; // same span, both layers — one row, not two
    seenClaimText.add(finding.claimText);
    combined.push(finding);
  }

  return combined.map((f) => ({
    claimText: f.claimText,
    context: f.context,
    detectedBy: f.detectedBy,
    sourceUrl: extractNearbySourceUrl(f.context),
  }));
}

/**
 * Run Pass 2 ("Package") for real: one Claude call, no tools, reading the
 * FINISHED Pass 1 article rather than writing anything itself.
 *
 * @param {object} opts
 * @param {string} opts.articleBody - Pass 1's finished, already-cleaned
 *   article text (narration/preamble/title-heading already stripped — see
 *   lib/draft.js's/lib/revise.js's own pipeline for where that happens).
 * @param {object[]} opts.claims - the same grounding-claims list Pass 1 had:
 *   for draft.js, every CANDIDATE claim matched by topic keyword; for
 *   revise.js, the claims ALREADY linked to this content item (fixed, not
 *   re-derived — see includeClaimsUsedField below).
 * @param {boolean} opts.includeClaimsUsedField - true (draft.js): ask the
 *   model which of `claims` the article actually discusses, and return that
 *   as claimKeysUsed for the caller to filter `claims` down with. false
 *   (revise.js): skip this entirely — the caller already knows exactly
 *   which claims apply (its fixed linked set) and uses `claims` as-is;
 *   claimKeysUsed always returns [] in this mode and should be ignored.
 * @param {object[]} [opts.internalLinkCandidates] - from
 *   lib/compliance.js's getInternalLinkCandidates()/
 *   getGeneralInternalLinkCandidates(), same as Pass 1 used to receive.
 * @param {object[]} [opts.searchEvidence] - from
 *   extractSearchResultsEvidence() above, run on Pass 1's raw response.
 * @param {boolean} [opts.pass1HasWebSearch] - whether Pass 1 actually had
 *   the web_search tool attached (i.e. `!hasTopics`) — gates whether
 *   QUOTED_TEXT is asked for at all, same as the old single-pass design.
 * @param {{title: string, url: string}[]} [opts.previousGeneralCitations] -
 *   ONLY ever supplied by lib/revise.js, on a revision round: the GENERAL
 *   citations the LAST round ended up with (read back out of the "## Sources"
 *   section already sitting in the draft's stored body — see
 *   lib/revise.js's extractPreviousGeneralCitations()). Empty/omitted for a
 *   fresh draft.js call. Used to keep GENERAL_CITATIONS continuous across
 *   revision rounds instead of being silently re-derived from scratch every
 *   time — see buildUserPrompt()'s PREVIOUSLY CITED GENERAL SOURCES section
 *   and the GENERAL_CITATIONS step's continuity instruction above.
 * @returns {Promise<{seoTitle: string|null, metaDescription: string|null,
 *   claimKeysUsed: string[], citationAnchors: object[],
 *   generalCitations: object[], quotedText: object[], relatedPosts: object[],
 *   cleanedArticleBody: string}>} cleanedArticleBody is `articleBody`
 *   unchanged unless Pass 2 identified (and stripLeakedOpeningNarration()
 *   independently verified) genuine leaked narration at the article's own
 *   opening — see this file's own header comment ("SECONDARY NARRATION
 *   SAFETY NET"). Callers should use `cleanedArticleBody`, not the
 *   `articleBody` they passed in, for every subsequent step (anchor
 *   matching, insertion, FAQ-schema extraction, the final DB write).
 */
async function packageDraft({
  articleBody,
  claims,
  includeClaimsUsedField,
  internalLinkCandidates = [],
  searchEvidence = [],
  pass1HasWebSearch = false,
  previousGeneralCitations = [],
}) {
  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    // Pass 2 only ever outputs metadata fields, never a full article body —
    // 2048 gives comfortable headroom for several GENERAL_CITATIONS/
    // CITATION_ANCHORS/QUOTED_TEXT/RELATED_POSTS entries plus the two short
    // SEO fields, without the 8192 Pass 1 needs for a full article. The new
    // LEAKED_OPENING_NARRATION field adds at most a couple hundred
    // characters (it only ever quotes a short leading span, never the whole
    // article), so this ceiling still has comfortable headroom.
    max_tokens: 2048,
    system: buildSystemPrompt(),
    messages: [
      {
        role: 'user',
        content: buildUserPrompt({
          articleBody,
          claims,
          includeClaimsUsedField,
          internalLinkCandidates,
          searchEvidence,
          pass1HasWebSearch,
          previousGeneralCitations,
        }),
      },
    ],
  });

  const textBlock = (response.content || []).find((b) => b && b.type === 'text' && typeof b.text === 'string');
  const responseText = textBlock ? textBlock.text : '';

  const parsed = parsePass2Response(responseText, { includeClaimsUsedField });
  const cleanedArticleBody = stripLeakedOpeningNarration(articleBody, parsed.leakedOpeningNarration);

  return { ...parsed, cleanedArticleBody };
}

module.exports = {
  packageDraft,
  extractSearchResultsEvidence,
  stripLeakedOpeningNarration,
  detectLegalClaims,
  // Exported for lib/legal-review.js's structural [LEGAL CLAIM PENDING
  // REVIEW: ...] bracket backstop (findMissingLegalClaimBracketFindings()):
  // reuses the SAME sentence-chunking and best-effort source-URL heuristics
  // detectLegalClaims() itself already uses, rather than a second copy of
  // either — both are pure/DB-free, so exporting them here doesn't change
  // this file's own no-side-effects contract.
  splitIntoSentenceLikeChunks,
  extractNearbySourceUrl,
};
