/**
 * lib/general-citation-domains.js
 * Hardcoded allowlist of domains the drafting engine is permitted to cite
 * for GENERAL, NON-LEGAL claims (market stats, program names, trend data,
 * and similar contextual claims) via lib/seo.js's insertGeneralCitations()
 * (and, with the same allowlist rule, lib/seo.js's insertVerifiedQuotes()).
 *
 * Commented the same way STALE_LAW_TOPICS is commented in lib/compliance.js:
 * a small, deliberately curated list, meant to stay small. The model
 * proposes a title/url/anchor_text/supports for a general citation, but the
 * url only ever gets linked if its hostname (after stripping a leading
 * "www.") matches an entry here EXACTLY, OR is a genuine subdomain of one
 * (e.g. "insurance.ca.gov" matches the "ca.gov" entry below — see
 * lib/seo.js's isDomainOrSubdomain() for the exact rule, deliberately a
 * real suffix check, not a substring check, so a lookalike domain can't
 * exploit it) — this is the only gate standing between "the AI typed a URL"
 * and "a link that actually appears on Rincon's published site," so add a
 * domain here deliberately, not casually. Legal facts NEVER come from this
 * list — only compliance_claims (see lib/compliance.js) is a source of
 * legal facts.
 *
 * A handful of *.ca.gov entries are ALSO listed individually below even
 * though "ca.gov" already covers them as subdomains (harmless duplication,
 * kept for readability/self-documentation of which state agencies this has
 * actually been used for) — this is not required for them to work.
 */
const GENERAL_CITATION_DOMAINS = [
  // Government / official
  'hud.gov',
  'census.gov',
  'irs.gov',
  'bls.gov',
  'consumerfinance.gov',
  'ftc.gov',
  'ca.gov',
  'hcd.ca.gov',
  'dre.ca.gov',
  'energy.ca.gov',
  'insurance.ca.gov',

  // Local / regional (Ventura County)
  'vcstar.com',
  'pacbiztimes.com',

  // National news / business press
  'latimes.com',
  'wsj.com',
  'reuters.com',

  // Real estate / property management industry bodies
  'nar.realtor',
  'naahq.org',
  'caanet.org',
  'narpm.org',
  'irem.org',

  // Research / data institutions
  'jchs.harvard.edu',
  'urban.org',
  'freddiemac.com',
  'lusk.usc.edu', // USC Lusk Center for Real Estate (Casden Multifamily Forecast)

  // Rental market data / property-tech providers — added 2026-08-02 after
  // Judge's review found three sources named directly in a live article's
  // prose (content_items e2e55b46-9716-4224-b05e-6d8a0a43200f) that could
  // never get auto-cited because none of their real domains were listed
  // here yet. Verified live (curl + a real web_search allowed_domains call,
  // 2026-08-02) that all four are reachable and not crawler-blocked.
  'rentengine.io', // RentEngine's real domain is .io, NOT .com — rentengine.com doesn't resolve at all
  'yardimatrix.com', // Yardi Matrix — the data-provider half of "USC Lusk/Yardi" citations
  'gozego.com', // Zego's real domain — zego.com is an unrelated UK motor-insurance company
  'dropcurb.com', // the article's own citation chain routes Zego's turnover-cost figures through Dropcurb's write-up, not Zego's report directly — see the article's own "Both figures trace back through Dropcurb's write-up" line
];

/**
 * Domains excluded from web_search's `allowed_domains` specifically —
 * NOT removed from GENERAL_CITATION_DOMAINS itself, since that list is also
 * used for an unrelated purpose (gating which URLs the AI-proposed
 * GENERAL_CITATIONS are allowed to link to, matched by hostname only — no
 * crawling involved there).
 *
 * Discovered empirically on 2026-07-15 while building live web search
 * (lib/draft.js's buildWebSearchTool()): the Anthropic API validates every
 * domain in `allowed_domains` up front and returns a hard 400
 * invalid_request_error for the ENTIRE request — not a graceful
 * per-domain skip — if ANY listed domain is inaccessible to its crawler
 * ("The following domains are not accessible to our user agent: [...]").
 * These four failed that check at the time of testing:
 *   latimes.com, reuters.com, vcstar.com, wsj.com
 * (Likely robots.txt or similar blocking Anthropic's crawler — see
 * https://support.anthropic.com/en/articles/8896518 — not something this
 * codebase controls.)
 *
 * IMPORTANT: if you add a new domain to GENERAL_CITATION_DOMAINS above,
 * that domain is NOT automatically safe for web search — a single
 * newly-added, crawler-blocked domain will break EVERY no-topics
 * generation (not just that one citation) until it's added here too.
 * There's no reliable way to pre-check this other than trying a real
 * web_search call and seeing if it 400s.
 */
const WEB_SEARCH_BLOCKED_DOMAINS = ['latimes.com', 'reuters.com', 'vcstar.com', 'wsj.com'];

const WEB_SEARCH_ALLOWED_DOMAINS = GENERAL_CITATION_DOMAINS.filter(
  (d) => !WEB_SEARCH_BLOCKED_DOMAINS.includes(d)
);

module.exports = { GENERAL_CITATION_DOMAINS, WEB_SEARCH_ALLOWED_DOMAINS };
