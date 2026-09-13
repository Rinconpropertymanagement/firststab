/**
 * lib/highlight.js
 * Turns draft body text into safe HTML:
 *   - HTML-escapes everything first — nothing below ever renders raw,
 *     un-escaped input.
 *   - Renders "## Heading" lines as real <h2> headings.
 *   - Highlights inline "[NEEDS HUMAN REVIEW: ...]" flags in a <mark> tag,
 *     so a reviewer cannot miss them by skimming.
 *   - Highlights inline "[LEGAL CLAIM PENDING REVIEW: ...]" flags in a
 *     separate, visually distinct (blue) <mark> tag — a DIFFERENT meaning
 *     from "[NEEDS HUMAN REVIEW: ...]" above: that one means an existing
 *     grounding claim was marked uncertain, or there's no source at all;
 *     this one means the AI found and cited a real source for a legal
 *     claim, but a human (Peter, informed by Mason's automatic review) has
 *     not yet signed off on it — see supabase/migrations/
 *     20260801000000_legal_claim_reviews.sql and
 *     content-engine/lib/legal-review.js for the review gate this flag
 *     corresponds to. A reader should be able to tell at a glance which of
 *     the three meanings (uncertain, unsourced, or sourced-but-unreviewed)
 *     they're looking at.
 *   - Renders a "> quote — [attributed_to](url "AI-SOURCED QUOTE...")" line
 *     (the drafting engine's mechanically-verified-quote format,
 *     lib/seo.js's insertVerifiedQuotes()) as a real <blockquote> with a
 *     distinct purple-bordered "AI-sourced quote" badge — DELIBERATELY a
 *     different visual treatment from the general-citation badge below, not
 *     a reuse of it, because a wrong quote is a more serious failure than a
 *     wrong citation link (Oracle's finding — see insertVerifiedQuotes()'s
 *     comment in lib/seo.js). Handled BEFORE both link regexes below, for
 *     the same reason AI_SOURCE_LINK_REGEX is: its marker text is a strict
 *     superset in appearance of what LINK_REGEX would otherwise partially,
 *     incorrectly match.
 *   - Renders "[text](url "AI-SUGGESTED SOURCE")" links (the drafting
 *     engine's general-citation format, lib/seo.js's insertGeneralCitations())
 *     as a real, clickable link followed by a purple "AI-suggested source"
 *     badge, so a reviewer can't mistake an AI-proposed source for a
 *     verified legal citation. Handled BEFORE the plain LINK_REGEX below,
 *     since that format is a strict superset in appearance and would
 *     otherwise need to be distinguished after the fact.
 *   - Renders Markdown-style "[link text](url)" links as real, clickable
 *     <a> tags — but ONLY when the url's scheme is http or https. Any
 *     other scheme (javascript:, data:, vbscript:, a bare relative path,
 *     etc.) is left as plain, escaped, non-clickable text instead, because
 *     escaping alone does not stop a javascript: URL from running if it
 *     were ever turned into a real href and clicked.
 *
 * The drafting engine (projects/content-engine/lib/draft.js) writes the
 * review flags in this exact format — see its buildSystemPrompt(). The
 * drafting/internal-linking/citation logic writes links using the same
 * "[text](url)" Markdown syntax handled here (plus the AI-suggested-source
 * and AI-sourced-quote variants above), and "##" headings per its prompt.
 */

const { escapeHtml } = require('./layout');

const FLAG_REGEX = /\[NEEDS HUMAN REVIEW:[^\]]*\]/gi;

// The content engine's legal-claim detector (a parallel build — see
// content-engine/lib/legal-review.js) writes this flag for a legal claim it
// researched and sourced itself, distinct from FLAG_REGEX above. Same
// bracket shape, different marker text, so it needs its own regex rather
// than widening FLAG_REGEX — the two must stay visually distinguishable,
// not merged.
const LEGAL_CLAIM_FLAG_REGEX = /\[LEGAL CLAIM PENDING REVIEW:[^\]]*\]/gi;

// Matches lib/seo.js's insertVerifiedQuotes() verified-quote output: a
// single line, on its own (surrounded by blank lines by the writer, though
// this regex only needs the line itself), of the shape
//   > <quote text> — [<attributed to>](<url> "AI-SOURCED QUOTE - ...")
// checked against the ALREADY HTML-ESCAPED string (this function escapes
// first, then runs every regex below) — so the leading ">" has already
// become "&gt;" and the literal double-quotes around the marker title have
// already become "&quot;" by the time this pattern runs. Must stay in sync
// with projects/content-engine/lib/seo.js's QUOTED_TEXT_MARKER_TITLE
// constant if that marker string ever changes. Group 1 is the quote text
// (non-greedy — see the comment above QUOTED_TEXT_MARKER_TITLE in that file
// for why a plain hyphen inside the marker, not an em dash, keeps this safe
// even if the quote text itself happens to contain an em dash), group 2 is
// the attribution text, group 3 is the source url.
const VERIFIED_QUOTE_LINE_REGEX =
  /^&gt;[ \t]+([\s\S]+?)[ \t]+—[ \t]+\[([^\]]+)\]\(([^\s]+)[ \t]+&quot;AI-SOURCED QUOTE - matched to search result, please confirm before publishing&quot;\)[ \t]*$/gm;

// Matches "[link text](url)". The url group excludes only whitespace (not
// parens), so it can correctly capture urls that themselves contain
// parentheses (e.g. "javascript:alert(1)") — greedy matching plus regex
// backtracking walks back to the LAST ")" that lets the rest of the
// pattern match, which is exactly the closing delimiter we want. The text
// group excludes "]" entirely, so it can never run past its own bracket.
// Note: this does NOT match the AI-suggested-source format below —
// after "(", url chars (non-whitespace) are consumed up to the first
// whitespace, and the very next character must then be ")" for the whole
// pattern to match. The AI-suggested-source format has
// ` &quot;AI-SUGGESTED SOURCE&quot;)` right there instead (a space, not a
// ")"), so this regex fails to match it and leaves it for
// AI_SOURCE_LINK_REGEX below to handle first.
const LINK_REGEX = /\[([^\]]+)\]\(([^\s]+)\)/g;

// Matches lib/seo.js's insertGeneralCitations() output:
// [text](url "AI-SUGGESTED SOURCE") — matched against the ALREADY
// HTML-ESCAPED string (this function escapes first, then runs every regex
// below), so the literal double-quote around AI-SUGGESTED SOURCE has
// already become "&quot;" by the time this pattern runs — hence matching
// &quot; here, not ".
const AI_SOURCE_LINK_REGEX = /\[([^\]]+)\]\(([^\s]+)\s+&quot;AI-SUGGESTED SOURCE&quot;\)/g;

// "## Heading" at the start of a line (CommonMark allows up to 3 leading
// spaces) becomes a real <h2>. Only level-2 headings are handled — that's
// the only heading syntax the drafting prompt uses.
const HEADING_REGEX = /^[ \t]{0,3}##[ \t]+(.+)$/gm;

function isSafeHttpUrl(url) {
  // Checked against the already-escaped string, but escapeHtml never
  // changes any of the characters that make up "http://" / "https://", so
  // this check is unaffected by running after escaping.
  return /^https?:\/\//i.test(url);
}

function renderDraftBody(bodyText) {
  if (!bodyText) return '<p><em>(No draft text yet.)</em></p>';

  // Escape HTML first, and only ever transform the escaped string from
  // here on — every replace below works on already-safe text.
  let html = escapeHtml(bodyText);

  // "## Heading" -> <h2>Heading</h2>
  html = html.replace(HEADING_REGEX, (match, headingText) => `<h2>${headingText}</h2>`);

  // "> quote — [attributed_to](url \"AI-SOURCED QUOTE...\")" -> a real
  // <blockquote> plus a distinct "AI-sourced quote" badge. MUST run before
  // AI_SOURCE_LINK_REGEX/LINK_REGEX below (see VERIFIED_QUOTE_LINE_REGEX's
  // comment above for why — its marker text is a strict superset in
  // appearance of what those two would otherwise partially match) and before
  // FLAG_REGEX has any chance to matter, though in practice a verified quote
  // line never contains a "[NEEDS HUMAN REVIEW: ...]" flag in the first
  // place (lib/seo.js's insertVerifiedQuotes() only ever produces one or the
  // other for a given proposal, never both). Same http(s)-only safety gate
  // as every other link render below — an unsafe scheme is left as inert,
  // already-escaped plain text rather than becoming a clickable link.
  html = html.replace(VERIFIED_QUOTE_LINE_REGEX, (match, quoteText, attributedTo, url) => {
    if (!isSafeHttpUrl(url)) return match;
    return (
      `<blockquote class="ai-quote">${quoteText}<footer>— ` +
      `<a href="${url}" target="_blank" rel="noopener">${attributedTo}</a></footer></blockquote>\n` +
      `<span class="badge ai-quote-badge">AI-sourced quote — matched to search result, please confirm before publishing</span>`
    );
  });

  // Highlight review flags BEFORE converting Markdown links. A
  // "[NEEDS HUMAN REVIEW: ...]" flag has no "(url)" immediately after its
  // closing "]", so LINK_REGEX (which requires one right there) can't
  // match it as-is — but wrapping the flag in <mark> first also means
  // that if a flag were ever directly followed by "(...)" in the source
  // text, the flag's "]" would land right before "</mark>" instead of
  // "(", which keeps LINK_REGEX from being able to swallow the flag as if
  // it were link text. Doing this first costs nothing and removes the
  // ambiguity entirely.
  html = html.replace(FLAG_REGEX, (match) => `<mark class="review-flag">${match}</mark>`);

  // Same reasoning, same "before the link regexes" ordering requirement, for
  // the separate "[LEGAL CLAIM PENDING REVIEW: ...]" flag — a distinct,
  // blue-styled <mark> so it reads as a different meaning at a glance from
  // the amber "[NEEDS HUMAN REVIEW: ...]" flag above.
  html = html.replace(LEGAL_CLAIM_FLAG_REGEX, (match) => `<mark class="legal-claim-flag">${match}</mark>`);

  // "[text](url "AI-SUGGESTED SOURCE")" -> real link + a visible badge,
  // MUST run before the plain LINK_REGEX pass below (see the comment on
  // AI_SOURCE_LINK_REGEX above for why LINK_REGEX can't already match this
  // format). Same http(s)-only safety gate as the plain link pass.
  html = html.replace(AI_SOURCE_LINK_REGEX, (match, linkText, url) => {
    if (!isSafeHttpUrl(url)) return match; // leave as inert, already-escaped plain text
    return (
      `<a href="${url}" target="_blank" rel="noopener">${linkText}</a> ` +
      `<span class="badge ai-source">AI-suggested source — please verify before publishing</span>`
    );
  });

  // "[text](url)" -> real link, only when the url is http(s). Both text
  // and url were already HTML-escaped above (escapeHtml ran on the whole
  // body before either regex touched it), so they're safe to drop
  // directly into the tag as-is — nothing here trusts either one raw.
  html = html.replace(LINK_REGEX, (match, linkText, url) => {
    if (!isSafeHttpUrl(url)) return match; // leave as inert, already-escaped plain text
    return `<a href="${url}" target="_blank" rel="noopener">${linkText}</a>`;
  });

  return html;
}

function countReviewFlags(bodyText) {
  if (!bodyText) return 0;
  const matches = bodyText.match(FLAG_REGEX);
  return matches ? matches.length : 0;
}

module.exports = { renderDraftBody, countReviewFlags, FLAG_REGEX, LEGAL_CLAIM_FLAG_REGEX };
