/**
 * lib/seo.js
 * Mechanical, no-AI-call post-processing shared by lib/draft.js and
 * lib/revise.js:
 *   - insertCitationLinks() — turn a cited claim's fact into a Markdown
 *     link to its source, by matching the AI's own named anchor phrase
 *     (CITATION_ANCHORS) against the body — NOT the citation string, which
 *     the model rarely quotes verbatim in prose (see comment on that
 *     function for why)
 *   - insertGeneralCitations() — turn an AI-proposed general/non-legal
 *     citation into a Markdown link, but ONLY when its domain (or a genuine
 *     subdomain of one) is on the hardcoded lib/general-citation-domains.js
 *     allowlist. Architecturally isolated from insertCitationLinks(): no
 *     shared call path, no shared input data. The AI proposes a
 *     title/url/anchor_text/supports for a general citation; this function
 *     is the only gate between that proposal and a link actually appearing.
 *   - insertVerifiedQuotes() — the QUOTED_TEXT counterpart to
 *     insertGeneralCitations(), but a failed proposal is NEVER just left as
 *     silent, unflagged prose the way a failed general citation is (see that
 *     function's own comment for why quotes need a stricter contract): every
 *     proposal whose anchor is located in the body becomes either a real
 *     blockquote (domain allowed AND independently confirmed against real
 *     search evidence) or a visible "[NEEDS HUMAN REVIEW: ...]" flag naming
 *     which check it failed.
 *   - insertRelatedReadingAndSourcesSections() — build/replace BOTH the
 *     "## Related Reading" section (linking to other published Rincon posts
 *     the model declared as relevant, after validating each declared title
 *     against the real candidate list, and ALSO attempting an inline link
 *     within the body's own prose via the model's declared anchor_text — see
 *     insertRelatedPostLinks() below, same "anchor text from the AI's own
 *     writing" pattern as insertCitationLinks()/insertGeneralCitations())
 *     and the "## Sources" bibliography
 *     section (listing every claim actually used and every general citation
 *     that passed the allowlist gate, regardless of whether either also got
 *     a mid-paragraph link) in one pass. The two are handled together,
 *     rather than as two independent functions, specifically so their
 *     relative order in the body stays fixed (Related Reading before
 *     Sources) no matter which one has fresh content on a given round — see
 *     the function's own comment for why that matters.
 *   - extractFaqSchema() — parse a "## Frequently Asked Questions" section
 *     into a FAQPage schema.org JSON-LD object
 *   - stripLeadingTitleHeading() — remove a stray leading "# Title" line
 *     the model sometimes writes despite being told not to
 *
 * None of these call the AI model. insertCitationLinks(), insertGeneral
 * Citations(), and insertRelatedReadingAndSourcesSections()'s Related
 * Reading half only ever produce a link for a
 * candidate that is independently verified (a real claim's real URL behind
 * an AI-named phrase actually found in its own draft, an AI-proposed URL
 * whose domain is on a hardcoded allowlist, or a declared title matched
 * case-insensitively against the real candidate list) — the AI never
 * supplies a URL that reaches the page on its word alone, and an unverified
 * or hallucinated proposal is always silently dropped rather than linked.
 * Every match is a fail-safe: no match found means the text is left alone,
 * never an error and never a forced link. insertVerifiedQuotes() is the one
 * exception to "silently dropped": a quote proposal whose anchor IS found in
 * the body but fails a check is never silently dropped — see that
 * function's own comment for why a quote's failure mode has to be visible
 * rather than silent.
 */

// Matches the exact "[NEEDS HUMAN REVIEW: ...]" flag format draft.js and
// revise.js instruct the model to use (see draft.js's buildSystemPrompt(),
// hard rule 2). Kept as its own copy here rather than requiring across the
// project boundary — content-engine and content-review are separate
// deployed apps with their own node_modules. This must stay in sync with
// projects/content-review/lib/highlight.js's FLAG_REGEX; update both
// together if the flag format ever changes.
const FLAG_REGEX = /\[NEEDS HUMAN REVIEW:[^\]]*\]/gi;

// The exact link-title marker insertVerifiedQuotes() (below) writes into a
// verified quote's attribution link — the same "hide the flag inside
// Markdown link-title syntax" technique insertGeneralCitations() uses for
// "AI-SUGGESTED SOURCE", but a visibly DIFFERENT string, so
// content-review/lib/highlight.js can tell the two apart and render a
// distinct badge (a wrong quote is more serious than a wrong citation — see
// this function's own comment below). Must stay in sync with
// content-review/lib/highlight.js's VERIFIED_QUOTE_LINE_REGEX if this string
// ever changes. Deliberately a plain hyphen, not an em dash — the em dash is
// reserved for the quote/attribution separator on the same line (see
// insertVerifiedQuotes() below), so the two never risk being confused by a
// regex looking for one or the other.
const QUOTED_TEXT_MARKER_TITLE =
  'AI-SOURCED QUOTE - matched to search result, please confirm before publishing';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Is the character range [start, end) of `text` fully inside a
 * "[NEEDS HUMAN REVIEW: ...]" flag span? Used so we never linkify text that
 * is only present because it's flagged as unverified.
 */
function isInsideReviewFlag(text, start, end) {
  FLAG_REGEX.lastIndex = 0;
  let match;
  while ((match = FLAG_REGEX.exec(text))) {
    const flagStart = match.index;
    const flagEnd = match.index + match[0].length;
    if (start >= flagStart && end <= flagEnd) return true;
  }
  return false;
}

/**
 * Is the match at [start, end) already wrapped in Markdown link syntax
 * (i.e. immediately preceded by "[" and immediately followed by "]("? Cheap
 * guard against double-linking the same text twice in one pass (e.g. two
 * claims that happen to share the same citation string).
 */
function isAlreadyLinked(text, start, end) {
  const before = text.slice(Math.max(0, start - 1), start);
  const after = text.slice(end, end + 2);
  return before === '[' && after === '](';
}

/**
 * A claim's primary evidence entry ({ citation, source, url, retrieved }),
 * or null if the claim has none. Shared by insertCitationLinks() (matching
 * against an AI-named anchor phrase) and computeSourceEntries() (building
 * the bibliography), so both always read the same real, verified URL from
 * the same place — compliance_claims via claimsUsed, never anywhere else.
 */
function getClaimPrimaryEvidence(claim) {
  return claim && claim.evidence && Array.isArray(claim.evidence.primary)
    ? claim.evidence.primary[0]
    : null;
}

/**
 * Insert mid-paragraph citation links using the AI's own CITATION_ANCHORS
 * declaration, NOT the claim's citation string. Real-world testing showed
 * the model almost always paraphrases a legal citation in prose (e.g.
 * "under the Fair Housing Act") rather than quoting the citation string
 * verbatim (e.g. "42 U.S.C. §§ 3601-3619"), so linking only on an exact
 * citation-string match rarely fired even when the claim was genuinely
 * used. Instead, for each claim the model says it used, it separately names
 * the exact short phrase from its OWN already-written draft where that
 * fact is discussed — something it can point at reliably, since it's
 * already written the text. That named phrase is matched verbatim
 * (case-insensitive) against the body; only the URL is trusted from the
 * verified claim record, never from the AI.
 *
 * @param {string} body
 * @param {object[]} claimsUsed - claim objects as returned by
 *   getGroundingClaims()/getLinkedClaims() — each has `.evidence.primary`,
 *   an array of { citation, source, url, retrieved }.
 * @param {{claim_key: string, anchor_text: string}[]} citationAnchors -
 *   parsed from the model's CITATION_ANCHORS: [...] trailing line. Untrusted
 *   input: a claim_key that doesn't match any claim in claimsUsed, or an
 *   anchor_text that doesn't appear in the body, is silently skipped — never
 *   an error. Not every claim needs an anchor.
 * @returns {string} the body with citation links inserted where found
 */
function insertCitationLinks(body, claimsUsed, citationAnchors) {
  let result = body || '';
  for (const anchor of citationAnchors || []) {
    if (!anchor || typeof anchor.claim_key !== 'string' || typeof anchor.anchor_text !== 'string') {
      continue;
    }
    const claim = (claimsUsed || []).find((c) => c && c.claim_key === anchor.claim_key);
    if (!claim) continue; // claim_key doesn't match a claim actually used — silently dropped

    const primary = getClaimPrimaryEvidence(claim);
    if (!primary || !primary.url) continue;

    const anchorText = anchor.anchor_text.trim();
    if (!anchorText) continue;

    const regex = new RegExp(escapeRegExp(anchorText), 'i');
    const match = result.match(regex);
    if (!match) continue; // named phrase doesn't actually appear in the body — silently dropped

    const start = match.index;
    const end = start + match[0].length;
    if (isInsideReviewFlag(result, start, end)) continue;
    if (isAlreadyLinked(result, start, end)) continue;

    result = result.slice(0, start) + `[${match[0]}](${primary.url})` + result.slice(end);
  }
  return result;
}

/**
 * Does `hostname` equal `domain`, or is it a genuine subdomain of it? A
 * strict suffix check — hostname must equal domain exactly, or end with
 * "." + domain — deliberately NOT a substring/includes() check, which would
 * let a lookalike attacker domain slip through (e.g. "ca.gov.evil.com" or
 * "evil-ca.gov.attacker.com" both contain "ca.gov" as a substring, but
 * neither is ca.gov or a subdomain of it, so both correctly fail this
 * check; the leading "." requirement also rejects a same-suffix-but-
 * different-domain lookalike like "notca.gov").
 *
 * This matches how Anthropic's own web_search tool treats its
 * `allowed_domains` parameter — confirmed against the real API docs:
 * "Subdomains are automatically included (example.com covers
 * docs.example.com)"
 * (https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools#domain-filtering).
 * Our own domain gate below is a separate, hand-rolled check (it gates
 * whether an AI-proposed URL gets linked/quoted in the body — it never
 * talks to web_search's allowed_domains directly), so without this it can
 * silently disagree with what the web_search tool itself already
 * considered an in-scope, real result (the insurance.ca.gov bug this
 * fixes).
 */
function isDomainOrSubdomain(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * Is `citation` a well-formed proposal on an allowlisted domain (or a
 * genuine subdomain of one — see isDomainOrSubdomain() above)? Checks URL
 * validity, scheme, and the hostname (leading "www." stripped, both sides
 * lowercased) against `allowlist` — but does NOT check whether anchor_text
 * appears anywhere in a body. Used both by insertGeneralCitations() (which
 * additionally requires the anchor text to be found, to actually link it)
 * and by callers building the "## Sources" list (which lists every
 * allowlisted proposal regardless of whether it also got a mid-paragraph
 * link) — so both consumers agree on exactly what "passed validation" means.
 */
function isAllowedGeneralCitation(citation, normalizedAllowlist) {
  if (!citation || typeof citation.url !== 'string') return false;

  let parsedUrl;
  try {
    parsedUrl = new URL(citation.url);
  } catch (e) {
    return false; // malformed URL — silently dropped
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return false;

  const hostname = parsedUrl.hostname.replace(/^www\./i, '').toLowerCase();
  for (const domain of normalizedAllowlist) {
    if (isDomainOrSubdomain(hostname, domain)) return true;
  }
  return false;
}

/**
 * Filter a raw GENERAL_CITATIONS proposal list down to only the entries
 * whose URL is well-formed, http(s), and on `allowlist` (see
 * isAllowedGeneralCitation()). Exported so draft.js/revise.js can compute
 * this once and hand the same "allowed" list to both insertGeneralCitations()
 * (to attempt mid-paragraph linking) and
 * insertRelatedReadingAndSourcesSections() (to list every allowlisted
 * proposal in the bibliography, whether or not it also got linked inline).
 *
 * @param {object[]} generalCitations - raw, untrusted proposals, each
 *   { title, url, anchor_text, supports }
 * @param {string[]} allowlist - domains from lib/general-citation-domains.js
 * @returns {object[]} the subset that passed URL/domain validation
 */
function filterAllowedGeneralCitations(generalCitations, allowlist) {
  const normalizedAllowlist = new Set(
    (allowlist || []).map((d) => d.toLowerCase().replace(/^www\./, ''))
  );
  return (generalCitations || []).filter((c) => isAllowedGeneralCitation(c, normalizedAllowlist));
}

/**
 * Insert mid-paragraph links for AI-proposed GENERAL (non-legal) citations —
 * market stats, program names, trend data, and similar contextual claims.
 * Deliberately isolated from insertCitationLinks(): it never sees
 * claimsUsed/compliance_claims data, and insertCitationLinks() never sees
 * an AI-proposed URL. The AI's word alone is never enough to produce a
 * link — a proposal only becomes a link if its domain is on the hardcoded
 * `allowlist` (see lib/general-citation-domains.js) AND its declared
 * anchor_text is actually found in the body.
 *
 * Links are written with Markdown's optional link-title syntax —
 * `[text](url "AI-SUGGESTED SOURCE")` — specifically so the "this was
 * AI-suggested, please verify" flag travels invisibly inside the stored
 * body text itself, and the review page (content-review/lib/highlight.js)
 * can render a visible badge next to it without a separate data channel.
 *
 * @param {string} body
 * @param {object[]} generalCitations - raw, untrusted proposals parsed from
 *   the model's GENERAL_CITATIONS: [...] trailing line, each
 *   { title, url, anchor_text, supports }
 * @param {string[]} allowlist - domains from lib/general-citation-domains.js
 * @returns {string} the body with general-citation links inserted where found
 */
function insertGeneralCitations(body, generalCitations, allowlist) {
  let result = body || '';
  const allowed = filterAllowedGeneralCitations(generalCitations, allowlist);

  for (const citation of allowed) {
    if (typeof citation.anchor_text !== 'string') continue;
    const anchorText = citation.anchor_text.trim();
    if (!anchorText) continue;

    const regex = new RegExp(escapeRegExp(anchorText), 'i');
    const match = result.match(regex);
    if (!match) continue; // named phrase doesn't actually appear in the body — silently dropped

    const start = match.index;
    const end = start + match[0].length;
    if (isInsideReviewFlag(result, start, end)) continue;
    if (isAlreadyLinked(result, start, end)) continue;

    result =
      result.slice(0, start) +
      `[${match[0]}](${citation.url} "AI-SUGGESTED SOURCE")` +
      result.slice(end);
  }
  return result;
}

// Strip smart quotes/apostrophes down to their plain ASCII equivalents, drop
// every remaining punctuation/symbol character, and collapse whitespace —
// leaving just lowercase words separated by single spaces. Used ONLY to
// compare a model-proposed quote against a real cited_text excerpt (never
// applied to text that ends up in the output). Punctuation is stripped
// entirely, not just normalized, because real production evidence (a live
// API response inspected while building this) showed the model's own quoted
// sentence can differ from Anthropic's cited_text at exactly a trailing
// punctuation mark — e.g. the model's "...can be misleading." (period, since
// it closed its own sentence) vs. the source's actual "...can be
// misleading," said Chris Herbert (comma, because the source's sentence kept
// going into an attribution clause). Comparing content only, with all
// punctuation removed, means that real, correct match is still recognized
// as a match instead of failing on the terminal character it happens to
// disagree on.
function normalizeForQuoteMatch(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Minimum normalized-quote length (see normalizeForQuoteMatch()) required
// before quoteTextMatchesCitedText() will even attempt a match. Guards
// against a degenerate short proposal (e.g. a 3-word fragment) trivially
// substring-matching almost anything — the whole point of this check is
// independent verification, so it must not be easy to satisfy by accident.
const MIN_QUOTE_MATCH_LENGTH = 15;

// How much of the shorter (normalized) string a longest-common-PREFIX match
// must cover, as a fraction, before it counts as a match — the fallback path
// in quoteTextMatchesCitedText() below for when neither string is fully a
// substring of the other. Exists specifically for the case where Anthropic's
// own cited_text is itself truncated mid-word (confirmed against a real
// response: cited_text values up to ~150 characters, sometimes ending
// mid-word with no trailing punctuation at all) at a slightly different
// point than the model's own ~150-character-capped proposed quote — so
// neither is quite a clean substring of the other, even though both are
// unmistakably the same excerpt. 0.7 was chosen to comfortably clear real
// truncation-boundary mismatches (which only ever differ by a handful of
// trailing characters) while still requiring the large majority of the
// shorter string to agree, character for character, from the very start.
const PREFIX_MATCH_COVERAGE = 0.7;

/**
 * Does `proposedQuote` (the model's own QUOTED_TEXT "quote" field) genuinely
 * match `citedText` (one real cited_text excerpt captured from the raw API
 * response — see draft.js's/revise.js's extractCitedTextEvidence())? This is
 * the actual independent verification check — the model's own claim that a
 * quote is real is never trusted on its own; this compares it against
 * evidence Anthropic's search system itself attached to the response.
 *
 * Three tiers, in order, on the punctuation-stripped normalized text (see
 * normalizeForQuoteMatch()):
 *   1. One is a substring of the other — the common case (the proposed quote
 *      is usually a clean excerpt of, or a superset written around, the real
 *      cited_text).
 *   2. A longest-common-prefix check covering most of the shorter string —
 *      catches the truncation-boundary case above.
 * Both require the normalized quote to clear MIN_QUOTE_MATCH_LENGTH first —
 * short strings are never trusted to substring-match safely.
 */
function quoteTextMatchesCitedText(proposedQuote, citedText) {
  const nq = normalizeForQuoteMatch(proposedQuote);
  const nc = normalizeForQuoteMatch(citedText);
  if (nq.length < MIN_QUOTE_MATCH_LENGTH || nc.length < MIN_QUOTE_MATCH_LENGTH) return false;

  if (nc.includes(nq) || nq.includes(nc)) return true;

  let commonPrefixLength = 0;
  const maxPossible = Math.min(nq.length, nc.length);
  while (commonPrefixLength < maxPossible && nq[commonPrefixLength] === nc[commonPrefixLength]) {
    commonPrefixLength++;
  }
  const shorterLength = Math.min(nq.length, nc.length);
  return commonPrefixLength >= MIN_QUOTE_MATCH_LENGTH * 2 &&
    commonPrefixLength / shorterLength >= PREFIX_MATCH_COVERAGE;
}

/**
 * Normalize a URL down to "hostname (www.-stripped) + path (trailing-slash-
 * stripped)", lowercased, for comparing a model-proposed quote's "url" field
 * against a real cited_text evidence entry's url — tolerant of http(s)
 * scheme differences, a leading "www.", and a trailing slash, none of which
 * make it a different source. Falls back to a trimmed/lowercased raw string
 * comparison if either side isn't a parseable URL at all (never throws).
 */
function normalizeUrlForQuoteMatch(url) {
  if (typeof url !== 'string') return '';
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '');
    return (parsed.hostname.replace(/^www\./i, '') + path).toLowerCase();
  } catch (e) {
    return url.trim().toLowerCase();
  }
}

/**
 * Is `quote` (one proposed QUOTED_TEXT entry, already past the domain-
 * allowlist gate) independently confirmed by `citedTextEvidence` (every real
 * {cited_text, url, title} pair captured from the raw API response)? True
 * only if AT LEAST ONE evidence entry matches BOTH the url (see
 * normalizeUrlForQuoteMatch()) AND the text (see quoteTextMatchesCitedText())
 * — matching text alone, on a different source, or a matching url with
 * unrelated cited text, is never enough.
 */
function isQuoteVerifiedByEvidence(quote, citedTextEvidence) {
  const quoteUrl = normalizeUrlForQuoteMatch(quote.url);
  if (!quoteUrl) return false;

  return (citedTextEvidence || []).some((evidence) => {
    if (!evidence || typeof evidence.cited_text !== 'string') return false;
    if (normalizeUrlForQuoteMatch(evidence.url) !== quoteUrl) return false;
    return quoteTextMatchesCitedText(quote.quote, evidence.cited_text);
  });
}

/**
 * Insert AI-proposed, mechanically verified direct quotations for GENERAL
 * (non-legal) content — the QUOTED_TEXT counterpart to insertGeneralCitations()
 * above, but with a stricter bar: a citation just needs an allowlisted
 * domain, while a quote additionally has its actual TEXT checked against
 * real search evidence, because a fabricated or misattributed quotation is a
 * more serious, more persuasive-looking failure than a bad citation link
 * (Oracle's finding, carried through to the review page's badge below —
 * see content-review/lib/highlight.js).
 *
 * Two gates, both checked for every proposal whose anchor_text is actually
 * located in the body (see "WHERE to act" below) — unlike
 * insertGeneralCitations(), a quote failing EITHER gate is never silently
 * dropped, for a reason specific to quotes (see "WHY NO SILENT DROP" below):
 *   1. DOMAIN GATE — identical rule to isAllowedGeneralCitation() above (now
 *      subdomain-aware — see isDomainOrSubdomain() above): the proposed url
 *      must be a well-formed http(s) URL whose hostname is on `allowlist`
 *      (WEB_SEARCH_ALLOWED_DOMAINS — the exact same allowlist the
 *      web_search tool itself is restricted to, per the caller) OR a
 *      genuine subdomain of one of its entries.
 *   2. EVIDENCE GATE — for a quote whose domain passed, is it independently
 *      confirmed by `citedTextEvidence` (see isQuoteVerifiedByEvidence()
 *      above)? This is the real check: the model's own claim that a quote is
 *      real is NEVER trusted by itself — only a match against evidence
 *      Anthropic's own search system attached to the response counts.
 *
 * WHERE to act in the body is found the same way every other anchor-based
 * mechanism in this file works: the model's own declared "anchor_text" —
 * the exact phrase, copied character-for-character from its OWN
 * already-written draft, where the quote already sits in prose — is matched
 * against the body, BEFORE either gate is even checked (unlike
 * insertGeneralCitations(), which checks its one domain gate first). A quote
 * whose anchor_text can't be found in the body (or sits inside an existing
 * review flag, or is already linked) is silently skipped — same fail-safe
 * contract as every other insert* function here: no match found means the
 * text is left alone, never an error. But once the anchor IS found, a
 * failure of either gate below is ALWAYS made visible — never silent.
 *
 * WHY NO SILENT DROP (unlike insertGeneralCitations()'s one gate): for a
 * general citation, a domain-gate failure just leaves an ordinary,
 * unremarkable sentence behind — nothing misleading. A quote is different:
 * its anchor_text sits in the body already wrapped in quotation marks and
 * named attribution, written by the model as a direct quotation, regardless
 * of whether this function ever touches it. If a quote fails verification
 * for ANY reason and is left as plain unflagged text, it is indistinguishable
 * from a fabricated quote to a human reviewer — silently dropping the
 * gate/link/badge doesn't un-write the quote-shaped prose already sitting in
 * the draft. So every quote whose anchor is found gets EXACTLY one of three
 * outcomes: a verified blockquote, or one of two distinctly-worded
 * NEEDS_HUMAN_REVIEW flags (below) — never plain, unflagged text.
 *
 * What happens once the anchor IS found:
 *   - DOMAIN GATE FAILED: the matched anchor text is left exactly as the
 *     model wrote it, with an inline "[NEEDS HUMAN REVIEW: ...]" flag
 *     appended right after it, worded to name the actual failure (a source
 *     outside Rincon's approved domain list) — no link to the
 *     non-allowlisted url is ever embedded, even inside the flag text.
 *   - DOMAIN GATE PASSED, EVIDENCE GATE PASSED ("verified"): the matched
 *     span is turned into a real Markdown blockquote (a "> " line, wrapped
 *     in blank lines so it actually renders as a blockquote rather than a
 *     stray ">" character mid-paragraph), attributed, with the attribution
 *     itself written as a Markdown link carrying QUOTED_TEXT_MARKER_TITLE as
 *     its link-title — the exact same "hide the flag inside link-title
 *     syntax" technique insertGeneralCitations() uses for "AI-SUGGESTED
 *     SOURCE" above, just a visibly different marker string, so
 *     content-review/lib/highlight.js can render a distinctly different
 *     "AI-sourced quote — please confirm" badge rather than reusing the
 *     general-citation one. This is still NEVER a final trust decision — a
 *     verified quote still shows a please-confirm badge and still requires
 *     human review before publishing, same as everything else in this
 *     pipeline.
 *   - DOMAIN GATE PASSED, EVIDENCE GATE FAILED ("unverified"): NOT inserted
 *     as a clean quote. Instead, the same "[NEEDS HUMAN REVIEW: ...]"
 *     mechanism is reused — the matched anchor text is left exactly as the
 *     model wrote it, with an inline flag appended right after it, worded to
 *     reflect what actually happened (a proposed quote that couldn't be
 *     confirmed against the search evidence — NOT "this is fabricated",
 *     since it may well be accurate; it just isn't independently confirmed).
 * Both flag wordings reuse content-review/lib/highlight.js's existing flag
 * rendering for free — no separate rendering path needed for either failure.
 *
 * @param {string} body
 * @param {{quote: string, url: string, attributed_to: string, anchor_text: string}[]} quotedText -
 *   raw, untrusted proposals parsed from the model's QUOTED_TEXT: [...]
 *   trailing line.
 * @param {{cited_text: string, url: string, title?: string}[]} citedTextEvidence -
 *   every real citation captured from the raw API response — see draft.js's/
 *   revise.js's extractCitedTextEvidence().
 * @param {string[]} allowlist - WEB_SEARCH_ALLOWED_DOMAINS (the same
 *   allowlist the web_search tool itself is restricted to — NOT the raw
 *   GENERAL_CITATION_DOMAINS list, per the caller).
 * @returns {string} the body with verified quotes turned into blockquotes and
 *   unverified-but-domain-allowed quotes flagged for human review, in place
 *
 * KNOWN, ACCEPTED GAP (documented here per Judge's review, 2026-07-17): this
 * function only ever acts on a quote the model actually DECLARED via
 * QUOTED_TEXT. If the model writes something that reads like a direct quote
 * in the body's prose (quotation marks + attribution) but never emits a
 * matching QUOTED_TEXT entry for it — or the trailing JSON is malformed and
 * silently parses to [] (see extractJsonArrayField()) — there is nothing for
 * this function to find, so that text is left completely untouched: no
 * blockquote, no badge, no review flag. It is indistinguishable from a
 * verified quote to someone skimming the page. This is not unique to
 * quotes — every anchor-declaration mechanism in this file (CITATION_ANCHORS,
 * GENERAL_CITATIONS, RELATED_POSTS) shares the same structural limit, since
 * none of them scan the body for undeclared claims. It matters more here
 * specifically because a wrong quote is a more consequential mistake than a
 * wrong citation. Every draft still requires a human to read it before
 * anything publishes, so this is a monitored, accepted limitation, not a
 * blocker — if undeclared quote-shaped text becomes a real, recurring
 * problem in practice, the fix would be a body-wide scan for quotation-mark
 * patterns as a backstop, similar in spirit to stripMidDocumentNarration()'s
 * whole-document approach, not a change to this function's core logic.
 */
function insertVerifiedQuotes(body, quotedText, citedTextEvidence, allowlist) {
  let result = body || '';

  const normalizedAllowlist = new Set(
    (allowlist || []).map((d) => d.toLowerCase().replace(/^www\./, ''))
  );

  for (const quote of quotedText || []) {
    if (
      !quote ||
      typeof quote.quote !== 'string' ||
      typeof quote.url !== 'string' ||
      typeof quote.anchor_text !== 'string'
    ) {
      continue;
    }

    // WHERE to act is found FIRST, before either gate — a quote that fails
    // a gate still needs its anchor located so the failure can be flagged
    // in place, rather than skipped before we even know where it sits in
    // the body (see this function's own comment above for why silent skip
    // is safe here ONLY when the anchor genuinely can't be found at all —
    // never as a substitute for flagging a gate failure).
    const anchorText = quote.anchor_text.trim();
    if (!anchorText) continue;

    const regex = new RegExp(escapeRegExp(anchorText), 'i');
    const match = result.match(regex);
    if (!match) continue; // named phrase doesn't actually appear in the body — silently dropped

    const start = match.index;
    const end = start + match[0].length;
    if (isInsideReviewFlag(result, start, end)) continue;
    if (isAlreadyLinked(result, start, end)) continue;

    const attributedTo =
      typeof quote.attributed_to === 'string' && quote.attributed_to.trim()
        ? quote.attributed_to.trim()
        : 'source';

    // GATE 1 — domain allowlist. Identical rule to general citations
    // (now subdomain-aware — see isDomainOrSubdomain()), but UNLIKE general
    // citations, failing this gate never means silent drop for a quote —
    // see "WHY NO SILENT DROP" in this function's comment above. No link to
    // the non-allowlisted url is ever embedded, even inside the flag text.
    const domainAllowed = isAllowedGeneralCitation(quote, normalizedAllowlist);

    let replacement;
    if (!domainAllowed) {
      replacement =
        `${match[0]} [NEEDS HUMAN REVIEW: a quote was proposed here from a source outside ` +
        `Rincon's approved list — verify before publishing]`;
    } else {
      // GATE 2 — independent evidence check against real search citations.
      const verified = isQuoteVerifiedByEvidence(quote, citedTextEvidence);

      replacement = verified
        ? `\n\n> ${match[0]} — [${attributedTo}](${quote.url} "${QUOTED_TEXT_MARKER_TITLE}")\n\n`
        : `${match[0]} [NEEDS HUMAN REVIEW: a quote was proposed here but could not be confirmed ` +
          `against the search results — verify before publishing]`;
    }

    result = result.slice(0, start) + replacement + result.slice(end);
  }

  return result;
}

// Deliberately [ \t]* (not \s*) around the heading text, unlike
// FAQ_HEADING_REGEX below — \s* here would be free to greedily swallow one
// of the newlines after the heading as part of the match itself (multiline
// $ can match right before ANY \n, so \s* backtracks to consuming just one
// trailing \n rather than zero), making headingMatch[0].length inconsistent
// depending on whether the source had one blank line or two after the
// heading. findRelatedReadingSection() needs headingEnd to reliably land
// right after the heading text on its own line, with no newlines consumed,
// so replacement logic can insert exactly one blank line itself.
const RELATED_READING_HEADING_REGEX = /^##[ \t]*Related Reading[ \t]*$/im;

/**
 * Find the [start, end) span of an existing "## Related Reading" section in
 * `body` — from the start of its heading line through to (but not
 * including) the next "## " heading, or the end of the body if it's the
 * last section. Returns null if no such heading is present.
 */
function findRelatedReadingSection(body) {
  const headingMatch = body.match(RELATED_READING_HEADING_REGEX);
  if (!headingMatch) return null;

  const headingEnd = headingMatch.index + headingMatch[0].length;
  const rest = body.slice(headingEnd);
  const nextHeadingMatch = rest.match(/\n##\s/);
  const sectionEnd = nextHeadingMatch ? headingEnd + nextHeadingMatch.index : body.length;

  return { start: headingMatch.index, headingEnd, end: sectionEnd };
}

/**
 * Validate the model's declared RELATED_POSTS entries against the real
 * candidate list, the same rule insertRelatedReadingAndSourcesSections()
 * below has always used: case-insensitive exact match on "title" against
 * getInternalLinkCandidates()'s output, deduped by URL, at most the first 2
 * declared entries considered (defensively, even if the model's declaration
 * ignores the "0-2" instruction). A declared title that doesn't exactly
 * match a real candidate (hallucinated, mistyped, or otherwise unverified)
 * is silently dropped — never linked, and never listed.
 *
 * Each entry may also carry an "anchor_text" — the exact phrase, from the
 * model's own draft, where it naturally referenced this post — same
 * anchor-text convention as CITATION_ANCHORS/GENERAL_CITATIONS. It is
 * carried through untouched (trimmed, or null if absent/blank) for
 * insertRelatedPostLinks() to attempt an inline link with below. A missing
 * or unmatched anchor_text never disqualifies the post from the validated
 * list — it just means no inline link will be attempted for it.
 *
 * @param {{title: string, published_url: string}[]} candidates - the real,
 *   verified candidate list (from getInternalLinkCandidates())
 * @param {{title: string, anchor_text?: string}[]} relatedPosts - entries
 *   the model declared via RELATED_POSTS: [...] — untrusted until matched
 *   against `candidates`
 * @returns {{title: string, published_url: string, anchor_text: string|null}[]}
 *   the validated subset
 */
function computeValidatedRelatedPosts(candidates, relatedPosts) {
  const declared = Array.isArray(relatedPosts) ? relatedPosts.slice(0, 2) : [];

  const seenUrls = new Set();
  const validated = [];
  for (const entry of declared) {
    if (!entry || typeof entry.title !== 'string') continue;
    const normalized = entry.title.trim().toLowerCase();
    const match = (candidates || []).find(
      (c) => c && c.title && c.published_url && c.title.trim().toLowerCase() === normalized
    );
    if (!match) continue; // unverified/hallucinated title — silently dropped
    if (seenUrls.has(match.published_url)) continue;
    seenUrls.add(match.published_url);
    const anchorText =
      typeof entry.anchor_text === 'string' && entry.anchor_text.trim()
        ? entry.anchor_text.trim()
        : null;
    validated.push({ title: match.title, published_url: match.published_url, anchor_text: anchorText });
  }
  return validated;
}

/**
 * Insert mid-paragraph links for validated related posts, using each post's
 * AI-declared anchor_text — same "anchor text from the AI's own writing"
 * pattern as insertCitationLinks()/insertGeneralCitations() above. Only ever
 * called with already-validated entries (real title matched against the
 * real candidate list, see computeValidatedRelatedPosts()); the
 * published_url used here always comes from that verified candidate record,
 * never from the AI.
 *
 * A related post with no anchor_text, or whose anchor_text doesn't actually
 * appear in the body, simply gets no inline link — never an error, and it
 * still appears in the "## Related Reading" list appended afterward
 * regardless. Inline linking is purely additive, never a replacement for
 * that list.
 *
 * @param {string} body
 * @param {{title: string, published_url: string, anchor_text: string|null}[]} validatedRelated
 * @returns {string} the body with related-post links inserted where found
 */
function insertRelatedPostLinks(body, validatedRelated) {
  let result = body || '';
  for (const post of validatedRelated || []) {
    if (!post || !post.anchor_text) continue;

    const regex = new RegExp(escapeRegExp(post.anchor_text), 'i');
    const match = result.match(regex);
    if (!match) continue; // named phrase doesn't actually appear in the body — silently dropped

    const start = match.index;
    const end = start + match[0].length;
    if (isInsideReviewFlag(result, start, end)) continue;
    if (isAlreadyLinked(result, start, end)) continue; // already linked — e.g. a prior revision round

    result = result.slice(0, start) + `[${match[0]}](${post.published_url})` + result.slice(end);
  }
  return result;
}

// Same deliberate [ \t]* (not \s*) reasoning as RELATED_READING_HEADING_REGEX
// above — keeps headingEnd landing right after the heading text with no
// newlines consumed.
const SOURCES_HEADING_REGEX = /^##[ \t]*Sources[ \t]*$/im;

/**
 * Find the [start, end) span of an existing "## Sources" section in `body`
 * — same approach as findRelatedReadingSection() above, for the same reason
 * (idempotent replace-not-append on revision).
 */
function findSourcesSection(body) {
  const headingMatch = body.match(SOURCES_HEADING_REGEX);
  if (!headingMatch) return null;

  const headingEnd = headingMatch.index + headingMatch[0].length;
  const rest = body.slice(headingEnd);
  const nextHeadingMatch = rest.match(/\n##\s/);
  const sectionEnd = nextHeadingMatch ? headingEnd + nextHeadingMatch.index : body.length;

  return { start: headingMatch.index, headingEnd, end: sectionEnd };
}

/**
 * Compute the "## Sources" bibliography entries: EVERY claim actually used
 * and every general citation that passed the allowlist gate — regardless of
 * whether either also produced a mid-paragraph link via
 * insertCitationLinks()/insertGeneralCitations(). This is normal
 * bibliography practice: an item appearing both inline and in the
 * reference list is expected, not a duplicate-looking bug, so this never
 * tries to suppress an entry just because it was also linked inline.
 *
 * @param {object[]} claimsUsed - claim objects, as passed to
 *   insertCitationLinks() — every claim here is listed, keyed off its own
 *   primary evidence (citation text + real URL), independent of whether an
 *   anchor was found for it.
 * @param {object[]} allowedGeneralCitations - the output of
 *   filterAllowedGeneralCitations() — every proposal that passed the
 *   domain-allowlist gate, independent of whether its anchor_text was found.
 * @returns {{legalEntries: {text: string, url: string}[], generalEntries: {text: string, url: string}[]}}
 */
function computeSourceEntries(claimsUsed, allowedGeneralCitations) {
  const seenUrls = new Set();
  const legalEntries = [];
  for (const claim of claimsUsed || []) {
    const primary = getClaimPrimaryEvidence(claim);
    if (!primary || !primary.citation || !primary.url) continue;
    if (seenUrls.has(primary.url)) continue;
    seenUrls.add(primary.url);
    legalEntries.push({ text: primary.citation, url: primary.url });
  }

  const seenGeneralUrls = new Set();
  const generalEntries = [];
  for (const citation of allowedGeneralCitations || []) {
    if (!citation || typeof citation.url !== 'string' || typeof citation.title !== 'string') continue;
    if (seenGeneralUrls.has(citation.url)) continue;
    seenGeneralUrls.add(citation.url);
    generalEntries.push({ text: citation.title, url: citation.url });
  }

  return { legalEntries, generalEntries };
}

/**
 * Build/replace BOTH the "## Related Reading" section and the "## Sources"
 * section in one coordinated pass, in a fixed canonical order: Related
 * Reading before Sources (Related Reading reads as "see also" content
 * belonging close to the article itself; Sources reads as the closing
 * bibliography — the natural place for a reference list to sit last).
 *
 * BUG THIS FIXES: the two sections used to be built by two fully
 * independent functions, each of which only knew how to find/replace ITS
 * OWN heading, and appended at whatever the current end of the body
 * happened to be if its heading wasn't already present. That was
 * idempotent for each section in isolation (re-running either one alone
 * never duplicated or lost content), but NOT order-stable across multiple
 * revision rounds: if e.g. Related Reading had nothing to add on one round
 * (so its section was stripped) and came back on a later round, it got
 * re-appended at the NEW end of the body — which by then was after the
 * Sources section, flipping their relative order from what a fresh
 * generation would have produced. Not a data-loss bug (nothing was ever
 * duplicated or dropped) — purely a section-ordering inconsistency.
 *
 * THE FIX: both existing sections (wherever they currently sit, if at all)
 * are stripped from the body FIRST, unconditionally, every single time this
 * runs — regardless of which one (if either) has fresh content to add this
 * round. Only then are they re-appended, fresh, in the fixed order above.
 * That means the relative order can never be inherited from a previous
 * round's positioning; it's recomputed from scratch every time. If only one
 * section has content this round, it lands in the same relative position it
 * would occupy if both were present (Related Reading right after the body,
 * Sources after that) rather than wherever the stripped tail happens to end.
 *
 * Idempotent by design, same rule the two functions individually followed
 * before: this fully REPLACES both sections with the freshly computed
 * content, never appends to whatever was already there. If a section has no
 * entries this round, it's omitted entirely (not left as an empty heading).
 *
 * @param {string} body
 * @param {{title: string, published_url: string}[]} candidates - the real,
 *   verified internal-link candidate list (from getInternalLinkCandidates())
 * @param {{title: string, anchor_text?: string}[]} relatedPosts - entries the
 *   model declared via RELATED_POSTS: [...] — untrusted until matched
 *   against `candidates`
 * @param {object[]} claimsUsed - claim objects, as passed to
 *   insertCitationLinks() (see computeSourceEntries() above)
 * @param {object[]} allowedGeneralCitations - the output of
 *   filterAllowedGeneralCitations() (see computeSourceEntries() above)
 * @returns {string} the body with both sections set to exactly the freshly
 *   computed content, in Related-Reading-then-Sources order, and with any
 *   validated related post's anchor_text linked inline within the body's own
 *   prose where found
 */
function insertRelatedReadingAndSourcesSections(
  body,
  candidates,
  relatedPosts,
  claimsUsed,
  allowedGeneralCitations
) {
  let result = body || '';

  const validatedRelated = computeValidatedRelatedPosts(candidates, relatedPosts);
  const { legalEntries, generalEntries } = computeSourceEntries(claimsUsed, allowedGeneralCitations);

  // Strip both existing sections first, unconditionally. Re-find Sources
  // AFTER removing Related Reading (rather than computing both spans up
  // front) so its span can't be stale if Related Reading happened to sit
  // before it and removing it shifted indices.
  const existingRelated = findRelatedReadingSection(result);
  if (existingRelated) {
    result = (result.slice(0, existingRelated.start) + result.slice(existingRelated.end))
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s+$/, '');
  }
  const existingSources = findSourcesSection(result);
  if (existingSources) {
    result = (result.slice(0, existingSources.start) + result.slice(existingSources.end))
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s+$/, '');
  }

  // Attempt inline links for related posts within the body's own prose,
  // using each post's AI-declared anchor_text (see insertRelatedPostLinks()
  // above) — same pattern as insertCitationLinks()/insertGeneralCitations().
  // Runs on `result` AFTER the old Related Reading/Sources sections were
  // just stripped above (so a stale bullet-list entry from a previous round
  // can never be mistaken for body prose) and BEFORE either section is
  // re-appended below (so the freshly-appended Related Reading bullets
  // themselves are never scanned as if they were prose). A phrase already
  // linked from a prior revision round is left alone — isAlreadyLinked()
  // inside insertRelatedPostLinks() skips it — so re-running this on
  // successive rounds never double-links the same phrase.
  result = insertRelatedPostLinks(result, validatedRelated);

  // Re-append fresh, in the fixed canonical order.
  if (validatedRelated.length > 0) {
    const bullets = validatedRelated.map((c) => `- [${c.title}](${c.published_url})`).join('\n');
    result = result + `\n\n## Related Reading\n\n${bullets}\n`;
  }

  if (legalEntries.length > 0 || generalEntries.length > 0) {
    const groups = [];
    if (legalEntries.length > 0) {
      groups.push(
        '**Legal & Regulatory Sources**\n\n' +
          legalEntries.map((e) => `- [${e.text}](${e.url})`).join('\n')
      );
    }
    if (generalEntries.length > 0) {
      groups.push(
        '**Additional Sources**\n\n' +
          generalEntries.map((e) => `- [${e.text}](${e.url} "AI-SUGGESTED SOURCE")`).join('\n')
      );
    }
    result = result.replace(/\s+$/, '') + `\n\n## Sources\n\n${groups.join('\n\n')}\n`;
  }

  return result;
}

const FAQ_HEADING_REGEX = /^##\s*Frequently Asked Questions\s*$/im;
const QA_PAIR_REGEX = /\*\*Q:\s*(.+?)\*\*\s*\n+A:\s*([\s\S]*?)(?=\n\s*\*\*Q:|\n##\s|$)/gi;

/**
 * Parse a "## Frequently Asked Questions" section (if present) into a real
 * FAQPage schema.org JSON-LD object, then stringify it. Building a real
 * object and calling JSON.stringify() (rather than hand-concatenating JSON
 * text) means any quote, line break, or other special character in a
 * question/answer is escaped correctly no matter what.
 *
 * @param {string} body
 * @returns {string|null} JSON.stringify() of the FAQPage object, or null if
 *   no FAQ section (or no valid Q/A pairs within it) was found.
 */
function extractFaqSchema(body) {
  if (!body) return null;

  const headingMatch = body.match(FAQ_HEADING_REGEX);
  if (!headingMatch) return null;

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const rest = body.slice(sectionStart);
  // The FAQ section runs until the next "## " heading, or the end of body.
  const nextHeadingMatch = rest.match(/\n##\s/);
  const section = nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest;

  const pairs = [];
  QA_PAIR_REGEX.lastIndex = 0;
  let match;
  while ((match = QA_PAIR_REGEX.exec(section))) {
    const question = match[1].trim();
    const answer = match[2].trim();
    if (question && answer) {
      pairs.push({ question, answer });
    }
  }

  if (pairs.length === 0) return null;

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: pairs.map((p) => ({
      '@type': 'Question',
      name: p.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: p.answer,
      },
    })),
  };

  return JSON.stringify(schema);
}

// Matches a leading single-"#" H1-style line (e.g. "# Some Title") only when
// it is literally the first line of the body — the missing "m" flag means
// "^" anchors to the very start of the string, not the start of every line.
// "#\s+" (single "#" followed by required whitespace) cannot match "##" or
// deeper headings, since the character right after the first "#" in those
// cases is another "#", not whitespace — so this never touches real
// subheadings, only a duplicated top-level title line.
const LEADING_H1_REGEX = /^#\s+.+\n+/;

/**
 * Defensive backstop for a stray leading "# <Title>" line the model
 * sometimes writes despite being told the body shouldn't repeat the title
 * (the page displays the title separately, and the renderer only converts
 * "##"+ headings, so a leading "#" line renders as an untidy plain-text
 * line). Strips only a single leading H1 line, if present; leaves the rest
 * of the body — including any "##" and deeper headings — untouched.
 *
 * @param {string} body
 * @returns {string} the body with a leading "# Title" line removed, or
 *   unchanged if it didn't start with one
 */
function stripLeadingTitleHeading(body) {
  if (!body) return body || '';
  return body.replace(LEADING_H1_REGEX, '');
}

// Matches the body's first "##"+ heading line, anywhere in the string — the
// structural anchor stripLeadingPreambleSeparator() below strips everything
// in front of. Requires a non-whitespace character right after the "#"s (so
// a bare "##" line with nothing after it isn't mistaken for a real heading).
const FIRST_HEADING_REGEX = /^#{2,}[ \t]*\S.*$/m;

// A hand-off sentence's SENTENCE START — the model narrating its own
// hand-off from research/search to writing: "I have...", "I've...",
// "I'll...", "I will...", "Here's...", "Here is...", "Below is...". This
// project's Rincon voice is consistently first-person-plural ("we") in real
// content (see lib/draft.js's/lib/revise.js's system prompts), so a
// first-person-singular sentence opener like this essentially never occurs
// in real substantive content — it's a safe, narrow signal.
//
// Deliberately checked per-SENTENCE (see splitIntoSentences() below), with
// NO requirement that a specific noun ("data", "draft", "research"...)
// follow it. The earlier version of this check required one of those nouns
// within 60 characters of "I have"/"I've" in a single regex — and missed a
// real production case: "I have solid, current figures. Let me write the
// draft." "figures" wasn't on the noun list, and the period ending that
// first sentence blocked the character class from ever reaching "draft" in
// the second clause. Matching only the sentence-opener, independent of
// whatever noun or clause follows it, catches that shape (and any future
// rewording of the same hand-off) without needing to enumerate every noun
// the model might use.
//
// The optional leading discourse-marker group ("So here's...", "Now here's
// where I'm going to...") was added after a real mid-document case slipped
// through: the bare "^(here's|...)" anchor requires the hand-off phrase to
// be the very first word, and a one-word conversational opener in front of
// it ("So", "Now", "Well", ...) — extremely common in the model's actual
// phrasing — defeated the anchor entirely. Also added "i(?:'m| am) going
// to" alongside the existing "i'll/i will", after a real case phrased the
// same hand-off as "I'm going to be straight with you" rather than "I'll be
// straight".
const HANDOFF_LEAD_IN_REGEX =
  /^(?:(?:so|now|well|look|honestly|frankly),?\s+)?(here'?s|here is|below is|i(?:'ve| have)|i(?:'ll| will)|i(?:'m| am) going to|let me)\b/i;

// A second, narrower hand-off shape that's still safe to require a same-
// sentence keyword pairing for: the model explicitly naming the act of
// searching/researching itself ("Based on my research...", "Based on the
// search results..."). Unlike the retired noun check above, "based on" and
// its pairing keyword are always in the same sentence here, so there's no
// sentence-boundary gap for this one to fail across.
const HANDOFF_RESEARCH_REGEX = /\bbased on\b[^.\n]*\b(search results|my research|what i found)\b/i;

function isHandoffSentence(sentence) {
  return HANDOFF_LEAD_IN_REGEX.test(sentence) || HANDOFF_RESEARCH_REGEX.test(sentence);
}

// A bare Markdown thematic break ("---", "***", or "___", each repeated 3+
// times) on its own — not a sentence. Filtered out of splitIntoSentences()'s
// result below so a divider sitting between the hand-off remark and the
// heading doesn't count against MAX_PREAMBLE_SENTENCES. Caught live in
// testing this fix: "I have solid market context to work with. Here's the
// draft.\n\n---\n\n## ..." splits into three pieces (two real sentences plus
// the bare "---"), pushing the count to 3 and silently blocking the strip
// even though there are only two real sentences of narration.
const THEMATIC_BREAK_TOKEN_REGEX = /^(?:-{3,}|\*{3,}|_{3,})$/;

// Crude sentence splitter: break on ".", "!", or "?" followed by whitespace.
// Good enough here because it only ever runs on a short (at most
// MAX_PREAMBLE_LENGTH characters) preamble candidate, never the full article
// body — a decimal number ("3.5%") inside that preamble won't cause a false
// split, since the period there isn't followed by whitespace. A bare
// thematic-break line lands as its own "sentence" here (no sentence-ending
// punctuation to attach it to a neighbor), so it's filtered out afterward.
function splitIntoSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !THEMATIC_BREAK_TOKEN_REGEX.test(s));
}

// How long a would-be narration preamble (ALL text before the first "##"
// heading, combined) is allowed to be, and how many sentences it's allowed
// to contain, before we assume it's actually real body content rather than a
// hand-off remark. Per lib/draft.js's/lib/revise.js's system prompt, a real
// Rincon article either opens with a real paragraph — which must carry "the
// direct answer to the piece's core question" within it, so it runs well
// past a bare one-or-two-sentence remark — or goes straight into "##"
// structure with no preamble at all. A genuine hand-off remark is reliably
// one or two short sentences, so both caps are kept tight; isHandoffSentence()
// below still has to agree the wording itself sounds like a hand-off before
// anything is stripped, so a real short opening isn't caught by brevity alone.
const MAX_PREAMBLE_LENGTH = 200;
const MAX_PREAMBLE_SENTENCES = 2;

/**
 * Defensive backstop for a second, subtler shape of the same "model narrates
 * before writing the real content" problem that stripLeadingTitleHeading()
 * addresses for stray title lines. When web_search is used, Claude reliably
 * hands off from its search turn with one or two short sentences before the
 * real content begins — sometimes separated by a Markdown thematic break
 * ("---"), sometimes just a blank line — but always landing immediately
 * before the body's first "##" heading with nothing else of substance in
 * between. Critically, this hand-off text lands in the SAME text block as
 * the real draft (confirmed against real API responses), so it survives even
 * after lib/draft.js's/lib/revise.js's concatenateTextBlocks() correctly
 * drops the earlier, separate pre-search narration block — that block-level
 * fix and this one are two different layers of the same problem.
 *
 * STRUCTURAL approach (rewritten from an earlier keyword-based version — see
 * HANDOFF_LEAD_IN_REGEX's comment above for the real production case that
 * broke it): rather than trying to recognize every possible way the model
 * might phrase a hand-off sentence, this detects the SHAPE. It finds the
 * body's very first "##" heading and strips everything before it, but ONLY
 * when that preamble looks like a bare hand-off remark rather than real
 * content:
 *   1. Non-empty (an empty preamble means the body already opens with the
 *      heading — nothing to strip).
 *   2. Short: at most MAX_PREAMBLE_LENGTH characters combined, and at most
 *      MAX_PREAMBLE_SENTENCES sentences — a real intro paragraph runs longer
 *      than a bare hand-off line (see MAX_PREAMBLE_LENGTH's comment).
 *   3. No bullet-list markers (real content organized as a list before its
 *      first heading is left alone).
 *   4. At least one of its sentences reads as narration about the act of
 *      writing/researching itself, per isHandoffSentence() above.
 * A preamble that fails any of these is left completely alone — including a
 * real short opening sentence that happens to be brief, since check 4 still
 * requires it to actually sound like a hand-off remark, not just be short.
 * A body with no "##" heading at all has nothing to anchor on and is also
 * left alone.
 *
 * @param {string} body
 * @returns {string} the body with a leading hand-off preamble removed, or
 *   unchanged if that shape isn't present
 */
function stripLeadingPreambleSeparator(body) {
  if (!body) return body || '';
  const trimmed = body.replace(/^\s+/, '');

  const headingMatch = trimmed.match(FIRST_HEADING_REGEX);
  if (!headingMatch) return body; // no "##"+ heading anywhere — nothing to anchor on

  const preamble = trimmed.slice(0, headingMatch.index).trim();
  if (!preamble) return body; // body already opens with the heading — nothing to strip
  if (preamble.length > MAX_PREAMBLE_LENGTH) return body; // too long to be a bare hand-off remark
  if (/^[-*+]\s|\n[ \t]*[-*+]\s/.test(preamble)) return body; // bullet list — real content, leave alone

  const sentences = splitIntoSentences(preamble);
  if (sentences.length === 0 || sentences.length > MAX_PREAMBLE_SENTENCES) return body;
  if (!sentences.some(isHandoffSentence)) return body;

  const rest = trimmed.slice(headingMatch.index).replace(/^\s+/, '');
  return rest || body; // never strip down to nothing
}

// Two tiers of the SAME signal — the model narrating its own editorial
// process instead of writing article content — for the same shape
// stripLeadingPreambleSeparator() detects above, but landing anywhere in the
// body, sometimes under a heading the model fabricates for the purpose (e.g.
// "## A Note on Security Deposit Limits"), directly addressing "the editor"
// about a question they asked, or explaining what it decided to state or
// leave out and why.
//
// STRONG markers are specific enough to justify dropping the ONE sentence
// that matches them, regardless of what the surrounding sentences look like.
// This split exists because real production output showed the two things
// live in the SAME paragraph: a narration sentence sitting right next to a
// sentence that reads fine in isolation (e.g. "So here's my honest answer:
// yes, California has moved..." — an unremarkable transition on its own, but
// bracketed on both sides by sentences that unambiguously address "the
// editor" and refuse to state a figure). Requiring the WHOLE block to read
// as narration (an earlier version of this list) let that one
// ordinary-looking sentence shield the two narration sentences next to it —
// confirmed missed live against real API output. Per-sentence removal on a
// STRONG match fixes that without needing every sentence to qualify.
const STRONG_NARRATION_SENTENCE_REGEXES = [
  // "The editor asked whether..." / "...the editor wants..." — the model
  // narrating a reviewer's question back instead of just answering it. Also
  // covers "the brief"/"the feedback"/"the prompt" — caught live in testing
  // with "the brief asked me to touch on whether there's a security deposit
  // cap...": the same shape, just narrating about a different piece of its
  // own input instructions instead of "the editor" specifically.
  /\bthe (?:editor|brief|feedback|prompt)\b[^.!?\n]*\b(asked|asks|wants|wanted|requested|is asking)\b/i,
  // "That's a fair question, but..." — a hand-off into declining to answer.
  /^that'?s a fair question\b/i,
  // "So here's my honest answer: ..." / "Here's my honest answer: ..."
  /\bhere'?s my honest answer\b/i,
  // "I'm not going to state/print/hand you/guess ..."
  /\bi(?:'m| am) not going to\b/i,
  // "...what I can and can't responsibly put in print", "I won't state a
  // specific figure", "I can't hand you a number", etc.
  /\bi (?:can|can't|cannot|won'?t|will not)\b[^.!?\n]*\b(responsibly|confidently)?\s*(state|include|say|write|put (?:that|this|it)?\s*in print|verify|speculate|guess|tell you|give you|hand you)\b/i,
  // "I'd rather flag that plainly than guess."
  /\bi'?d rather\b[^.!?\n]*\bthan guess\b/i,
  // "I decided not to/against ..." — deliberately NOT the bare "I decided
  // to <do something>" shape (caught in testing: it matches equally well at
  // the start of a real, substantive sentence like "I decided to focus this
  // section on..."). "not to" / "against" are inherently exclusion-flavored
  // and don't have that problem.
  /\bi decided (?:not to|against)\b/i,
  // "I'll keep X out because..." / "I'll leave that out..."
  /\bi(?:'ll| will) (?:keep|leave)\b[^.!?\n]*\bout\b/i,
  // "...here's where I'm going to be straight with you about my own
  // confidence..." — caught live in testing as a variant of the same
  // confessional hand-off as "here's my honest answer" above, but phrased
  // differently enough (and sitting in a multi-sentence block next to an
  // unrelated real sentence) that the generic WEAK opener alone wasn't
  // enough to justify dropping it — this targets the confessional phrase
  // itself, independent of tense or which discourse marker (if any)
  // precedes it, so it's safe to treat as STRONG.
  /\bbe (?:straight|honest|upfront|frank) with you\b/i,
  // "...rather than a made-up number" / "rather than guessing" — the same
  // shape as "I'd rather flag that plainly than guess" above, but as the
  // tail of a longer sentence rather than its own short one.
  /\brather than (?:a )?made[- ]up\b/i,
];

// KNOWN, ACCEPTED GAP (documented here per Judge's review, not an oversight):
// a fourth narration shape — the model explaining a SOURCE-CONFLICT or
// METHODOLOGY judgment call ("I weighed the county's fact sheet more heavily
// than the older post because it's the more recently updated source")
// — is NOT caught by either tier above. It doesn't match any STRONG pattern
// (no "editor asked", no "can't/won't state", no "decided not to"), and it
// doesn't match a WEAK opener either, since HANDOFF_LEAD_IN_REGEX requires
// the sentence to OPEN with a hand-off phrase ("here's.../I'll.../let
// me..."), which this shape never does. Confirmed live and reproduced 3/3
// under revision feedback that asks the model to explain why it favored one
// of two conflicting data sources over the other (see TARS's report,
// 2026-07-16). Peter reviewed this finding and explicitly decided to accept
// it as a residual, monitored limitation rather than chase a fifth
// detection round: every draft still requires a human review-and-publish
// step (see content-review/server.js's login-gated approve/reject/publish
// routes — there is no auto-publish path anywhere in this pipeline), so a
// sentence that slips through this gap lands in a draft awaiting review,
// never in front of a tenant or owner. If this becomes a live nuisance
// during real use, the fix is a fifth STRONG pattern targeting
// "weighed/favored/trusted X (more/over) Y" framing — not a rewrite of the
// existing tiers, which have held up under extensive adversarial testing.

// WEAK markers — generic hand-off openers (reused from
// stripLeadingPreambleSeparator()'s vocabulary above). In THAT function
// they're safe to act on with nothing else required, because they're only
// ever checked against a short (<=200 char), <=2-sentence LEADING preamble —
// in that narrow context, a bare "Here's..."/"I'll..." opener is
// overwhelmingly likely to be a hand-off remark. Extended to arbitrary
// mid-document blocks with no length cap at all, that assumption breaks:
// confirmed live with a real false positive — "Here's the split we work
// with:", an entirely ordinary transition into a bullet list, was removed
// because it was the sole sentence in its block and a bare WEAK match
// trivially satisfies "every sentence in the block matches" for a
// single-sentence block. The fix is PROCESS_VOCABULARY_REGEX below: a WEAK
// opener only counts here when the SAME sentence also contains an actual
// self-referential/process word (confidence, verify, honestly, the editor,
// etc.) — the corroboration that was safe to skip in the leading-preamble
// case (thanks to the length cap) but isn't safe to skip here.
const WEAK_NARRATION_SENTENCE_REGEXES = [HANDOFF_LEAD_IN_REGEX, HANDOFF_RESEARCH_REGEX];

// Corroborating vocabulary required alongside a WEAK opener match (see
// above) before a mid-document sentence is treated as narration. Broad on
// purpose — it only ever narrows down a sentence that ALREADY matched a
// hand-off opener, so a false match here just means a real hand-off
// sentence is (correctly) kept as narration; it can never by itself cause a
// sentence with no opener match to be flagged.
const PROCESS_VOCABULARY_REGEX =
  /\b(responsib\w*|confiden\w*|verif\w*|guess\w*|speculat\w*|honest\w*|straight\w*|state\b|states\b|stating\b|stated\b|print\w*|source\w*|statute\w*|editor\w*|\bbrief\b|feedback|decid\w*|process\b|reasoning|flag\w*|figure\w*|made[- ]up)\b/i;

function isStrongNarrationSentence(sentence) {
  return STRONG_NARRATION_SENTENCE_REGEXES.some((re) => re.test(sentence));
}

function isWeakNarrationSentence(sentence) {
  return (
    WEAK_NARRATION_SENTENCE_REGEXES.some((re) => re.test(sentence)) && PROCESS_VOCABULARY_REGEX.test(sentence)
  );
}

function isNarrationSentence(sentence) {
  return isStrongNarrationSentence(sentence) || isWeakNarrationSentence(sentence);
}

// Strips Markdown emphasis markers (bold/italic asterisks or underscores,
// inline code backticks) for CLASSIFICATION PURPOSES ONLY — never applied to
// text that ends up in the output. Added after a real production case
// slipped through: "What I am **not** going to do is print a specific
// figure..." — the model's own bold emphasis on "not" broke the direct word
// adjacency the "i am not going to" regex above depends on. The narration
// regexes above are checked against this cleaned copy of each sentence;
// whatever survives is still reassembled from the ORIGINAL (unstripped)
// sentence text in stripNarrationSentencesFromBlock() below, so real
// emphasis formatting in kept content is never altered.
function forNarrationMatching(sentence) {
  return sentence.replace(/[*_`]+/g, '');
}

// Matches any "##"+ heading line, anywhere in the body (global, multiline) —
// unlike FIRST_HEADING_REGEX above, which only ever finds the first one.
// Same non-whitespace-after-hashes requirement, for the same reason.
const ANY_HEADING_LINE_REGEX = /^#{2,}[ \t]*\S.*$/;
const ANY_HEADING_GLOBAL_REGEX = /^#{2,}[ \t]*\S.*$/gm;

// A Markdown bullet-list line, at any indent. Blocks that open with one are
// never treated as narration prose — same "real content organized as a
// list" exemption stripLeadingPreambleSeparator() applies to its preamble.
const BULLET_LINE_REGEX = /^[ \t]*[-*+]\s/;

/**
 * Split `body` into blank-line-delimited blocks (Markdown's own paragraph
 * unit), each with its [start, end) character offsets in the original
 * string. A block is one or more consecutive non-blank lines; a blank line
 * is the separator and is never itself part of a block. This is the same
 * mechanical unit the rest of this file already leans on (a heading, a
 * bullet list, a paragraph) without needing a real Markdown parser.
 *
 * @param {string} body
 * @returns {{text: string, start: number, end: number}[]}
 */
function splitIntoBlocksWithOffsets(body) {
  const blocks = [];
  const blockRegex = /[^\n]+(?:\n[^\n]+)*/g;
  let match;
  while ((match = blockRegex.exec(body))) {
    blocks.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return blocks;
}

// A protected flag placeholder never contains real sentence-ending
// punctuation, so it can never be mid-split by splitIntoSentences() below —
// it always survives as (part of) exactly one "sentence" token. Uses plain
// ASCII text (not a Unicode escape) deliberately — kept simple and visible
// rather than a control character, to avoid any ambiguity about what's
// actually stored in this file.
// No leading/trailing space in the token itself — deliberately, since
// splitIntoSentences() trims() each sentence it returns, which would strip
// any space placed immediately at a placeholder's own edges and break these
// regexes whenever a flag lands alone as its own "sentence" (confirmed live
// in testing). Any real whitespace/punctuation the flag was already
// surrounded by in the source text is untouched by this substitution, so
// natural spacing is preserved regardless.
const FLAG_PLACEHOLDER_ONLY_REGEX = /^FLAGPLACEHOLDER\d+$/;
const FLAG_PLACEHOLDER_FIND_REGEX = /FLAGPLACEHOLDER\d+/g;
const FLAG_PLACEHOLDER_RESTORE_REGEX = /FLAGPLACEHOLDER(\d+)/g;

/**
 * Remove narration SENTENCES from `blockText` (a single blank-line-delimited
 * paragraph), sentence by sentence, rather than requiring the whole block to
 * read as narration. Returns the rewritten block text, or null if nothing in
 * it needed to change (so the caller can leave the ORIGINAL text — including
 * its exact original spacing — untouched rather than needlessly
 * reconstructing a block that was already fine).
 *
 * Any "[NEEDS HUMAN REVIEW: ...]" flag in the block is protected before
 * sentence-splitting and always survives, even when the sentence that
 * contained it is otherwise dropped as narration — never lost.
 *
 * Two-tier removal (see STRONG_/WEAK_NARRATION_SENTENCE_REGEXES above):
 *   - A STRONG match is dropped on its own, regardless of neighboring
 *     sentences.
 *   - A WEAK match is only dropped when EVERY sentence in the block is at
 *     least a WEAK (or STRONG) match — the original, more conservative
 *     all-or-nothing rule, kept for this weaker tier specifically because a
 *     single generic hand-off word alone isn't a confident enough signal to
 *     act on in isolation.
 * A sentence that matches neither tier is always kept as-is. This is what
 * lets a real, substantive sentence sitting right next to a narration
 * sentence in the SAME paragraph survive, instead of one non-matching
 * sentence protecting the whole block (the gap confirmed live: "So here's my
 * honest answer: yes, California has moved..." sat between two unambiguous
 * narration sentences and, under the old all-or-nothing rule, shielded both).
 *
 * @param {string} blockText
 * @returns {string|null}
 */
function stripNarrationSentencesFromBlock(blockText) {
  const flags = [];
  const withPlaceholders = blockText.replace(FLAG_REGEX, (m) => {
    flags.push(m);
    return `FLAGPLACEHOLDER${flags.length - 1}`;
  });

  const sentences = splitIntoSentences(withPlaceholders);
  const contentSentences = sentences.filter((s) => !FLAG_PLACEHOLDER_ONLY_REGEX.test(s));
  if (contentSentences.length === 0) return null; // only flags (or nothing) here — nothing to classify

  const allNarration = contentSentences.every((s) => isNarrationSentence(forNarrationMatching(s)));

  let changed = false;
  const survivors = [];
  for (const sentence of sentences) {
    if (FLAG_PLACEHOLDER_ONLY_REGEX.test(sentence)) {
      survivors.push(sentence); // never drop a standalone flag
      continue;
    }
    const cleaned = forNarrationMatching(sentence);
    const strong = isStrongNarrationSentence(cleaned);
    const weak = !strong && isWeakNarrationSentence(cleaned);
    if (strong || (weak && allNarration)) {
      changed = true;
      const embeddedFlags = sentence.match(FLAG_PLACEHOLDER_FIND_REGEX);
      if (embeddedFlags) survivors.push(...embeddedFlags); // keep a flag embedded in a dropped sentence
      // else: sentence fully dropped
    } else {
      survivors.push(sentence);
    }
  }

  if (!changed) return null; // nothing needed changing — caller keeps the original text untouched

  let result = survivors.join(' ').replace(/\s+/g, ' ').trim();
  result = result.replace(FLAG_PLACEHOLDER_RESTORE_REGEX, (_, i) => flags[Number(i)]);
  return result; // '' is possible if literally every content sentence was narration
}

/**
 * A heading whose entire section (everything up to the next "##"+ heading,
 * or the end of the body) is now empty, or contains nothing but a
 * "[NEEDS HUMAN REVIEW: ...]" flag, is a dangling fabricated heading —
 * stripMidDocumentNarration() below just emptied out the narration
 * paragraph(s) that were its only reason to exist. Strip the heading line
 * itself too, but leave any surviving flag text exactly where it is (never
 * delete a flag, even an orphaned one with no heading above it).
 *
 * Processes headings from the END of the body backward, so removing an
 * earlier heading's line never shifts the offsets already computed for a
 * later one.
 *
 * @param {string} body
 * @returns {string}
 */
function stripHeadingsWithEmptiedSections(body) {
  let result = body;
  const headings = [];
  ANY_HEADING_GLOBAL_REGEX.lastIndex = 0;
  let match;
  while ((match = ANY_HEADING_GLOBAL_REGEX.exec(result))) {
    headings.push({ start: match.index, end: match.index + match[0].length });
  }

  for (let i = headings.length - 1; i >= 0; i--) {
    const heading = headings[i];
    const sectionEnd = i + 1 < headings.length ? headings[i + 1].start : result.length;
    const sectionTrimmed = result.slice(heading.end, sectionEnd).trim();

    const isEmpty = sectionTrimmed === '';
    const isFlagOnly = !isEmpty && sectionTrimmed.replace(FLAG_REGEX, '').trim() === '';
    if (!isEmpty && !isFlagOnly) continue; // real content remains under this heading — leave it alone

    result = result.slice(0, heading.start) + result.slice(heading.end);
  }

  return result;
}

/**
 * Defensive backstop for a THIRD shape of the same "model narrates its own
 * process instead of writing article content" problem
 * stripLeadingPreambleSeparator() (leading hand-off remark) and the inline
 * "[NEEDS HUMAN REVIEW: ...]" mechanism (an uncertain fact, flagged in
 * place) already address. Confirmed against real production output: the
 * model can also write this kind of self-narration THREE PARAGRAPHS INTO
 * THE BODY, under its own fabricated "## A Note on ..." subheading, in
 * direct response to a reviewer's question — a shape invisible to both
 * existing backstops, since stripLeadingPreambleSeparator() only ever looks
 * at text before the body's FIRST heading, and concatenateTextBlocks() only
 * ever drops text blocks before the first tool-use block.
 *
 * Same structural philosophy as stripLeadingPreambleSeparator() (detect the
 * SHAPE of narration, not an enumerable list of phrasings), extended to scan
 * every blank-line-delimited block in the WHOLE body, not just the leading
 * one:
 *   1. Headings and bullet-list blocks are never touched directly — only
 *      plain prose paragraphs are candidates.
 *   2. Any "[NEEDS HUMAN REVIEW: ...]" flag inside a block is extracted and
 *      protected before classification, and is ALWAYS preserved in the
 *      output even when the rest of that block is stripped as narration —
 *      never lost.
 *   3. Within each candidate block, narration is removed SENTENCE BY
 *      SENTENCE, not as an all-or-nothing block decision — see
 *      stripNarrationSentencesFromBlock() above for the two-tier STRONG/WEAK
 *      rule and why (a real sentence sitting next to a narration sentence in
 *      the same paragraph must survive; requiring the whole block to read as
 *      narration missed exactly that shape against real API output).
 *   4. After block-level stripping, a heading left with nothing (or only a
 *      flag) under it is also removed, via stripHeadingsWithEmptiedSections()
 *      — since a heading like "## A Note on Security Deposit Limits" only
 *      ever existed to house the narration paragraph(s) just stripped.
 * A block that fails any of these checks — including "genuinely unsure" —
 * is left completely alone; this errs toward a false negative (a narration
 * paragraph survives) over the false positive of deleting real content.
 *
 * @param {string} body
 * @returns {string} the body with mid-document narration blocks (and any
 *   fabricated heading left empty by their removal) stripped out, with all
 *   "[NEEDS HUMAN REVIEW: ...]" flags preserved
 */
function stripMidDocumentNarration(body) {
  if (!body) return body || '';

  const blocks = splitIntoBlocksWithOffsets(body);
  let result = body;

  // Process from the end backward so an earlier removal never shifts the
  // offsets already computed for a later block.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (ANY_HEADING_LINE_REGEX.test(block.text) || BULLET_LINE_REGEX.test(block.text)) continue;

    const rewritten = stripNarrationSentencesFromBlock(block.text);
    if (rewritten === null) continue; // nothing in this block needed to change

    result = result.slice(0, block.start) + rewritten + result.slice(block.end);
  }

  result = stripHeadingsWithEmptiedSections(result);

  return result.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '');
}

module.exports = {
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
  QUOTED_TEXT_MARKER_TITLE,
};
