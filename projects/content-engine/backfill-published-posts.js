#!/usr/bin/env node
/**
 * backfill-published-posts.js
 * One-time (but safely re-runnable) crawl of the live rinconmanagement.com
 * blog. Finds every real blog post via the site's sitemap, pulls a short
 * summary for each, and inserts it into content_items (status='published')
 * so it can act as an internal-link target for new AI-drafted content.
 *
 * This does NOT store full article text — only a title, a short 1-3
 * sentence summary, and the live URL. These rows are link targets only,
 * never a source of facts for the AI (see the migration file's comment on
 * content_items.body for why).
 *
 * Safe to re-run: any URL already present in content_items.published_url is
 * skipped, so running this again later (e.g. after Peter publishes more
 * posts) only adds what's new.
 *
 * Usage:
 *   node backfill-published-posts.js
 *   node backfill-published-posts.js --dry-run
 *   node backfill-published-posts.js --limit 10
 *   node backfill-published-posts.js --help
 */

// Same .env resolution convention as draft-content.js: look next to this
// file first (matches server deployment), fall back to the shared
// project-root .env two levels up (matches local dev's nested repo layout).
{
  const path = require('path');
  const fs = require('fs');
  const localEnvPath = path.join(__dirname, '.env');
  const sharedEnvPath = path.join(__dirname, '..', '..', '.env');
  const envPath = fs.existsSync(localEnvPath) ? localEnvPath : sharedEnvPath;
  require('dotenv').config({ path: envPath });
}

const cheerio = require('cheerio');
const { select, insert } = require('./lib/supabase');
const { listTopics } = require('./lib/compliance');

const SITE_ROOT = 'https://www.rinconmanagement.com';
const SITEMAP_CANDIDATES = ['/sitemap.xml', '/sitemap_index.xml'];

// Standard, descriptive User-Agent for a site Peter owns — polite crawling
// practice even against your own domain.
const USER_AGENT =
  'RinconManagementContentBackfill/1.0 (internal SEO tooling; contact peter@rinconmanagement.com)';

const FETCH_TIMEOUT_MS = 15000;
const DELAY_BETWEEN_REQUESTS_MS = 400; // polite delay so we don't hammer the server

const MIN_SUMMARY_LENGTH = 30; // near-empty net for broken/stub pages
const MAX_SUMMARY_LENGTH = 300; // "a couple hundred characters"

// Explicit backstop: these known stub pages must never be inserted, even if
// their content happens to pass the length check (confirmed live — the
// market-update page has a plausible-length but non-substantive meta
// description that would otherwise slip through).
const EXCLUDED_TITLES = new Set([
  'pet protection program',
  'southern california rental real estate market update',
]);

// ---------------------------------------------------------------------
// Topic keyword matching — same TOPIC_LABELS duplication pattern already
// established in content-review/server.js and content-engine/lib/viral-scan.js
// (both have a comment noting the 12-entry map is intentionally duplicated
// and should be kept in sync). Duplicated a third time here rather than
// importing from viral-scan.js, which is a YouTube-search module with its
// own unrelated dependencies (Anthropic client, YouTube API) — importing
// from it would create an odd coupling for the sake of one constant. If the
// topic list or its labels ever change, update all three places.
// ---------------------------------------------------------------------
const TOPIC_LABELS = {
  'ab-1482-statewide-and-local-variation': 'Rent control / just-cause eviction (AB 1482)',
  'security-deposits': 'Security deposits',
  'rent-increase-rules-and-notice': 'Rent increases & notice requirements',
  'notice-requirements-entry-termination': 'Notice to enter / lease termination',
  'fair-housing': 'Fair housing',
  'trust-account-handling': 'Trust account handling',
  'broker-supervision-pma': 'Broker supervision / property mgmt agreements',
  'general-liability-insurance': 'General liability insurance',
  'lease-agreement-requirements': 'Lease agreement requirements',
  'habitability-and-maintenance': 'Habitability & maintenance',
  'pest-control': 'Pest control',
  'screening-and-application-fees': 'Tenant screening & application fees',
};

// Plain keyword lists per topic_key, derived from each topic's label. Cheap,
// deterministic substring matching against title+summary text — no AI call
// per post. A post can match zero, one, or multiple topics.
const TOPIC_KEYWORDS = {
  'ab-1482-statewide-and-local-variation': ['ab 1482', 'ab1482', 'rent control', 'just cause', 'just-cause', 'rent cap'],
  'security-deposits': ['security deposit'],
  'rent-increase-rules-and-notice': ['rent increase', 'raise the rent', 'raising rent', 'rent hike'],
  'notice-requirements-entry-termination': ['notice to enter', 'lease termination', 'terminate the lease', 'terminating a lease', 'notice to vacate', 'remove a tenant', 'evict', 'eviction'],
  'fair-housing': ['fair housing', 'discrimination', 'protected class', 'reasonable accommodation', 'assistance animal', 'support animal', 'service animal'],
  'trust-account-handling': ['trust account'],
  'broker-supervision-pma': ['broker supervision', 'property management agreement', 'pma '],
  'general-liability-insurance': ['liability insurance', 'general liability'],
  'lease-agreement-requirements': ['lease agreement', 'rental agreement', 'lease requirements'],
  'habitability-and-maintenance': ['habitability', 'maintenance', 'repairs'],
  'pest-control': ['pest control', 'termite', 'rodent', 'infestation'],
  'screening-and-application-fees': ['tenant screening', 'screening process', 'application fee', 'background check', 'credit check'],
};

function printHelp() {
  console.log(`
backfill-published-posts.js — one-time (safely re-runnable) crawl of
rinconmanagement.com/blog. Finds every real blog post, extracts a title +
short summary + URL, and inserts it into content_items (status='published')
as an internal-link target for future AI-drafted content.

Does NOT store full article text. Does NOT publish anything, send anything,
or touch content_item_compliance_claims.

Flags:
  --dry-run       Crawl and report what would happen, but don't write to
                  the database.
  --limit <n>     Only process the first <n> blog post URLs found. Useful
                  for a quick test run before doing the full crawl.
  --help          Show this help and exit.

Safe to re-run: any URL already in content_items.published_url is skipped,
so a later re-run only adds newly published posts.
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--limit') {
      args.limit = Number(argv[i + 1]);
      i++;
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------
// Step 1: find every blog post URL via the sitemap.
// ---------------------------------------------------------------------

async function fetchSitemapUrls() {
  for (const path of SITEMAP_CANDIDATES) {
    const url = `${SITE_ROOT}${path}`;
    let res;
    try {
      res = await fetchWithTimeout(url);
    } catch (err) {
      console.warn(`[backfill] Could not fetch ${url}: ${err.message}`);
      continue;
    }
    if (!res.ok) {
      console.warn(`[backfill] ${url} returned HTTP ${res.status}, trying next candidate.`);
      continue;
    }
    const xml = await res.text();
    const $ = cheerio.load(xml, { xmlMode: true });
    const urls = $('url > loc')
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);
    if (urls.length > 0) {
      console.log(`[backfill] Found ${urls.length} URLs in ${url}`);
      return urls;
    }
  }
  throw new Error(
    `No usable sitemap found at any of: ${SITEMAP_CANDIDATES.join(', ')}. ` +
      'Falling back to crawling the blog index page was not implemented ' +
      'because a sitemap was confirmed to exist during investigation — if ' +
      'the site has changed, this needs a human look.'
  );
}

/**
 * Real blog posts live at /blog/<slug> — /blog itself is the listing/index
 * page, not a post, and is excluded.
 */
function filterToBlogPostUrls(allUrls) {
  return allUrls.filter((url) => {
    let path;
    try {
      path = new URL(url).pathname;
    } catch {
      return false;
    }
    return /^\/blog\/[^/]+\/?$/.test(path);
  });
}

// ---------------------------------------------------------------------
// Step 2: extract title + short summary from each post page.
// ---------------------------------------------------------------------

function cleanText(text) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

function truncateToSummary(text, maxLen = MAX_SUMMARY_LENGTH) {
  const cleaned = cleanText(text);
  if (cleaned.length <= maxLen) return cleaned;
  // Try to cut at the last sentence-ending punctuation before the limit so
  // we don't chop a sentence in half; fall back to a hard cut + ellipsis.
  const slice = cleaned.slice(0, maxLen);
  const lastSentenceEnd = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('.’'));
  if (lastSentenceEnd > maxLen * 0.4) {
    return slice.slice(0, lastSentenceEnd + 1);
  }
  return `${slice.trim()}…`;
}

function extractPost(html, url) {
  const $ = cheerio.load(html);
  const title = cleanText($('title').first().text()) || cleanText($('h1').first().text());

  const metaDescription = cleanText($('meta[name="description"]').attr('content'));
  let summarySource = metaDescription;
  if (!summarySource) {
    // Fall back to the article's first real paragraph.
    const firstParagraph = $('article p, .post-content p, main p, p')
      .toArray()
      .map((el) => cleanText($(el).text()))
      .find((t) => t.length > 0);
    summarySource = firstParagraph || '';
  }

  return {
    url,
    title,
    summary: truncateToSummary(summarySource),
  };
}

// ---------------------------------------------------------------------
// Step 4: topic tagging via keyword match.
// ---------------------------------------------------------------------

function matchTopics(title, summary) {
  const haystack = `${title} ${summary}`.toLowerCase();
  const matched = [];
  for (const [topicKey, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (keywords.some((kw) => haystack.includes(kw))) {
      matched.push(topicKey);
    }
  }
  return matched;
}

// ---------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const missingLabels = Object.keys(TOPIC_KEYWORDS).filter((k) => !TOPIC_LABELS[k]);
  if (missingLabels.length > 0) {
    console.warn(`[backfill] TOPIC_KEYWORDS has entries with no TOPIC_LABELS match: ${missingLabels.join(', ')}`);
  }

  console.log('[backfill] Fetching sitemap...');
  const allUrls = await fetchSitemapUrls();
  let postUrls = filterToBlogPostUrls(allUrls);
  console.log(`[backfill] ${postUrls.length} of ${allUrls.length} sitemap URLs look like blog posts (/blog/<slug>).`);

  if (args.limit && args.limit > 0) {
    postUrls = postUrls.slice(0, args.limit);
    console.log(`[backfill] --limit applied: processing first ${postUrls.length} URL(s).`);
  }

  // Fetch existing published_url values once, up front, so the per-post
  // dedup check is a local Set lookup instead of a query per URL.
  const existingRows = await select('content_items', 'select=published_url&published_url=not.is.null');
  const existingUrls = new Set(existingRows.map((r) => r.published_url));

  // Fetch real topic ids once, keyed by topic_key.
  const topicRows = await listTopics();
  const topicIdByKey = new Map(topicRows.map((t) => [t.topic_key, t.id]));

  const stats = {
    found: postUrls.length,
    skippedStub: 0,
    skippedExisting: 0,
    added: 0,
    fetchErrors: 0,
    topicTagsApplied: 0,
  };

  const exampleRows = [];

  for (const url of postUrls) {
    if (existingUrls.has(url)) {
      stats.skippedExisting++;
      continue;
    }

    let res;
    try {
      res = await fetchWithTimeout(url);
    } catch (err) {
      console.warn(`[backfill] Fetch failed for ${url}: ${err.message}`);
      stats.fetchErrors++;
      await sleep(DELAY_BETWEEN_REQUESTS_MS);
      continue;
    }
    if (!res.ok) {
      console.warn(`[backfill] ${url} returned HTTP ${res.status}, skipping.`);
      stats.fetchErrors++;
      await sleep(DELAY_BETWEEN_REQUESTS_MS);
      continue;
    }

    const html = await res.text();
    const post = extractPost(html, url);

    const titleLower = post.title.toLowerCase();
    const isExcludedStub = EXCLUDED_TITLES.has(titleLower);
    const isNearEmpty = post.summary.length < MIN_SUMMARY_LENGTH;

    if (isExcludedStub || isNearEmpty) {
      stats.skippedStub++;
      console.log(`[backfill] Skipping stub/near-empty: "${post.title}" (${url})`);
      await sleep(DELAY_BETWEEN_REQUESTS_MS);
      continue;
    }

    const matchedTopicKeys = matchTopics(post.title, post.summary);

    if (args.dryRun) {
      console.log(`[backfill] (dry-run) Would insert: "${post.title}" — topics: ${matchedTopicKeys.join(', ') || '(none)'}`);
      stats.added++;
      stats.topicTagsApplied += matchedTopicKeys.length;
      await sleep(DELAY_BETWEEN_REQUESTS_MS);
      continue;
    }

    let inserted;
    try {
      inserted = await insert('content_items', {
        title: post.title,
        body: post.summary,
        content_type: 'blog_post',
        status: 'published',
        published_url: post.url,
      });
    } catch (err) {
      console.warn(`[backfill] Insert failed for ${url}: ${err.message}`);
      stats.fetchErrors++;
      await sleep(DELAY_BETWEEN_REQUESTS_MS);
      continue;
    }
    const contentItem = Array.isArray(inserted) ? inserted[0] : inserted;

    if (matchedTopicKeys.length > 0) {
      const topicRowsToInsert = matchedTopicKeys
        .map((key) => topicIdByKey.get(key))
        .filter(Boolean)
        .map((topicId) => ({ content_item_id: contentItem.id, topic_id: topicId }));
      if (topicRowsToInsert.length > 0) {
        try {
          await insert('content_item_topics', topicRowsToInsert);
          stats.topicTagsApplied += topicRowsToInsert.length;
        } catch (err) {
          console.warn(`[backfill] Topic-tag insert failed for ${url}: ${err.message}`);
        }
      }
    }

    stats.added++;
    if (exampleRows.length < 5) {
      exampleRows.push({ title: post.title, url: post.url, summary: post.summary, topics: matchedTopicKeys });
    }

    await sleep(DELAY_BETWEEN_REQUESTS_MS);
  }

  console.log('\n--- BACKFILL SUMMARY ---');
  console.log(`URLs found (blog posts):     ${stats.found}`);
  console.log(`Skipped (stub/near-empty):   ${stats.skippedStub}`);
  console.log(`Skipped (already existed):   ${stats.skippedExisting}`);
  console.log(`Fetch/insert errors:         ${stats.fetchErrors}`);
  console.log(`Newly added:                 ${stats.added}${args.dryRun ? ' (dry-run, nothing written)' : ''}`);
  console.log(`Topic tags applied:          ${stats.topicTagsApplied}`);

  if (exampleRows.length > 0) {
    console.log('\n--- EXAMPLE ROWS ---');
    exampleRows.forEach((r) => {
      console.log(`- ${r.title}\n  ${r.url}\n  topics: ${r.topics.join(', ') || '(none)'}\n  summary: ${r.summary}\n`);
    });
  }
}

main().catch((err) => {
  console.error(`\n[ERROR] ${err.message}`);
  process.exit(1);
});
