/**
 * lib/compliance.js
 * Looks up legal claims from compliance_claims to ground a draft. This is
 * the guardrail: the drafting engine is only allowed to state legal facts
 * that come back from this lookup.
 */

const { select } = require('./supabase');

// Topics whose underlying law changed recently enough that older posts on
// this topic likely still state the outdated rule. California's security
// deposit cap changed under AB 12 in 2024; some of Peter's older posts
// almost certainly still describe the pre-AB-12 cap. Rather than risk
// auto-linking a new draft to one of those stale posts (and drawing a
// reader's attention to outdated info), topics on this list are excluded
// from internal-linking candidates entirely — Peter can still link to an
// old post manually himself if he specifically wants to. Small and meant to
// stay small: add another topic_key here if another law changes.
const STALE_LAW_TOPICS = ['security-deposits'];

/**
 * Fetch all compliance_topics rows (id + topic_key), so a topic name/keyword
 * typed by a human can be matched to the right topic_id.
 */
async function listTopics() {
  return select('compliance_topics', 'select=id,topic_key');
}

/**
 * Fetch every claim under a given topic_id, including the topic_key so the
 * prompt can show which topic each claim belongs to.
 * @param {string} topicId
 */
async function getClaimsForTopic(topicId) {
  const claims = await select(
    'compliance_claims',
    `select=*&topic_id=eq.${topicId}&order=confidence.desc`
  );
  return claims;
}

/**
 * Find topics whose topic_key contains any of the given keywords
 * (case-insensitive, simple substring match — topic_keys are short slugs
 * like "security-deposits", "ab-1482-statewide-and-local-variation").
 * @param {string[]} keywords
 */
async function findTopicsByKeyword(keywords) {
  const topics = await listTopics();
  const lowerKeywords = keywords.map((k) => k.toLowerCase());
  return topics.filter((t) =>
    lowerKeywords.some((kw) => t.topic_key.toLowerCase().includes(kw))
  );
}

/**
 * Core grounding lookup: given a list of topic keywords describing what the
 * content is about (e.g. ["security-deposit", "ab-1482"]), return every
 * claim under any matching topic. If no topic matches, returns an empty
 * array — the caller must not draft legal statements in that case.
 * @param {string[]} keywords
 */
async function getGroundingClaims(keywords) {
  const topics = await findTopicsByKeyword(keywords);
  if (topics.length === 0) return { topics: [], claims: [] };

  const claimLists = await Promise.all(
    topics.map((t) => getClaimsForTopic(t.id))
  );
  const claims = claimLists.flat();
  return { topics, claims };
}

/**
 * Find candidate posts to internally link to from a new/revised piece of
 * content: other content_items that (a) share at least one of the given
 * topics, (b) are actually published (status='published' AND
 * published_url is set), and (c) aren't the content item being written
 * right now. Returns deduped { title, published_url } pairs, ready to hand
 * to lib/seo.js's insertRelatedReadingAndSourcesSections().
 *
 * Two safety floors are applied before a match is returned as a candidate:
 *   - a 4-word minimum on title, so a short/generic title can't
 *     accidentally exact-match unrelated text elsewhere in a draft
 *   - topics on STALE_LAW_TOPICS are excluded entirely (see comment above)
 *
 * @param {string[]} topicIds
 * @param {string|null} [excludeContentItemId] - this item's own id, if it
 *   already exists (e.g. during a revision) — omit/null for a brand-new
 *   draft that hasn't been inserted yet.
 * @returns {Promise<{title: string, published_url: string}[]>}
 */
async function getInternalLinkCandidates(topicIds, excludeContentItemId = null) {
  if (!Array.isArray(topicIds) || topicIds.length === 0) return [];

  const allTopics = await listTopics();
  const staleLawTopicIds = new Set(
    allTopics.filter((t) => STALE_LAW_TOPICS.includes(t.topic_key)).map((t) => t.id)
  );
  const eligibleTopicIds = topicIds.filter((id) => !staleLawTopicIds.has(id));
  if (eligibleTopicIds.length === 0) return [];

  const excludeFilter = excludeContentItemId
    ? `&content_items.id=neq.${excludeContentItemId}`
    : '';

  const rows = await select(
    'content_item_topics',
    `select=topic_id,content_items!inner(id,title,published_url,status)` +
      `&topic_id=in.(${eligibleTopicIds.join(',')})` +
      `&content_items.status=eq.published` +
      `&content_items.published_url=not.is.null` +
      excludeFilter
  );

  const seen = new Set();
  const candidates = [];
  for (const row of rows) {
    const item = row.content_items;
    if (!item || !item.title || !item.published_url) continue;
    if (seen.has(item.id)) continue;

    const wordCount = item.title.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount < 4) continue;

    seen.add(item.id);
    candidates.push({ title: item.title, published_url: item.published_url });
  }

  return candidates;
}

// Small hardcoded stopword list for extractMeaningfulWords() below — common
// words that would otherwise dilute keyword-overlap scoring by matching
// almost every title/brief regardless of actual topical relevance.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this', 'that',
  'these', 'those', 'it', 'its', 'as', 'at', 'by', 'from', 'into', 'about',
  'your', 'you', 'what', 'how', 'why', 'when', 'will', 'can', 'not', 'but',
]);

/**
 * Extract "meaningful words" from a piece of text for keyword-overlap
 * scoring: lowercase, strip punctuation, drop stopwords, drop words under 4
 * characters. Shared by getGeneralInternalLinkCandidates() below to score
 * both a new piece's title/brief against a candidate's own title.
 * @param {string} text
 * @returns {Set<string>}
 */
function extractMeaningfulWords(text) {
  if (!text) return new Set();
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => w.length >= 4)
    .filter((w) => !STOPWORDS.has(w));
  return new Set(words);
}

/**
 * Find candidate posts to internally link to from a new/revised piece of
 * GENERAL content — one with no legal topic selected, so
 * getInternalLinkCandidates() above (which requires topicIds) never runs
 * for it. Rather than leaving Related Reading empty for these pieces (the
 * ~4/5 of real articles with no legal topic), this scores every published
 * post's title against the new piece's own title/brief by plain keyword
 * overlap.
 *
 * Same safety floors as getInternalLinkCandidates(): a 4-word minimum on
 * title, and topics on STALE_LAW_TOPICS excluded entirely (so an old,
 * possibly-outdated security-deposit post never gets auto-linked here
 * either — Peter can still link to one manually if he wants to).
 *
 * Scoring: +3 for each of a candidate's own meaningful title words that
 * also appears in the new piece's title, +1 for each that appears in the
 * new piece's brief/body. Only candidates with score > 0 are kept, sorted
 * descending, top 5 returned — kept deliberately short so a genuinely
 * strong match doesn't get lost in a long list of weaker ones when the
 * model reads RELATED POST CANDIDATES in the prompt.
 *
 * @param {string} title - the new/revised piece's own title
 * @param {string} secondaryText - the brief (draft.js) or current body
 *   (revise.js) of the new/revised piece
 * @param {string|null} [excludeContentItemId] - this item's own id, if it
 *   already exists (e.g. during a revision) — omit/null for a brand-new
 *   draft that hasn't been inserted yet.
 * @returns {Promise<{title: string, published_url: string}[]>}
 */
async function getGeneralInternalLinkCandidates(title, secondaryText, excludeContentItemId = null) {
  const titleWords = extractMeaningfulWords(title);
  const secondaryWords = extractMeaningfulWords(secondaryText);
  if (titleWords.size === 0 && secondaryWords.size === 0) return [];

  // 1. Every published post with a real URL, excluding this item itself.
  const excludeFilter = excludeContentItemId
    ? `&id=neq.${excludeContentItemId}`
    : '';
  const publishedItems = await select(
    'content_items',
    `select=id,title,published_url&status=eq.published&published_url=not.is.null${excludeFilter}`
  );

  // 2. Exclude anything tagged with a STALE_LAW_TOPICS topic — same safety
  // property getInternalLinkCandidates() preserves above.
  const allTopics = await listTopics();
  const staleLawTopicIds = allTopics
    .filter((t) => STALE_LAW_TOPICS.includes(t.topic_key))
    .map((t) => t.id);

  let staleItemIds = new Set();
  if (staleLawTopicIds.length > 0) {
    const staleRows = await select(
      'content_item_topics',
      `select=content_item_id&topic_id=in.(${staleLawTopicIds.join(',')})`
    );
    staleItemIds = new Set(staleRows.map((r) => r.content_item_id));
  }

  // 3. Score every remaining candidate against the new piece's own
  // title/brief, applying the same 4-word title-length floor.
  const scored = [];
  for (const item of publishedItems) {
    if (!item.title || !item.published_url) continue;
    if (staleItemIds.has(item.id)) continue;

    const wordCount = item.title.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount < 4) continue;

    const candidateWords = extractMeaningfulWords(item.title);
    let score = 0;
    for (const w of candidateWords) {
      if (titleWords.has(w)) score += 3;
      if (secondaryWords.has(w)) score += 1;
    }
    if (score > 0) {
      scored.push({ title: item.title, published_url: item.published_url, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map((c) => ({ title: c.title, published_url: c.published_url }));
}

module.exports = {
  listTopics,
  getClaimsForTopic,
  findTopicsByKeyword,
  getGroundingClaims,
  getInternalLinkCandidates,
  getGeneralInternalLinkCandidates,
  STALE_LAW_TOPICS,
};
