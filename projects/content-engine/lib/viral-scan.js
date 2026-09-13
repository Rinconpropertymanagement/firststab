/**
 * lib/viral-scan.js
 * Core logic for the "viral trend scan" discovery feed: searches YouTube for
 * recent videos about Rincon's compliance topics, ranks them by view
 * velocity, drops anything already suggested or off-topic, and writes
 * survivors into topic_suggestions (status='pending') for Peter to review.
 *
 * This module NEVER states a legal fact. Its only job is to notice "there's
 * public interest in topic X right now" — the actual legal grounding only
 * ever happens later, in lib/draft.js's draftContent(), which reads from
 * compliance_claims. Nothing here calls draftContent() or touches
 * content_items.
 */

const { listTopics } = require('./compliance');
const { select, insert } = require('./supabase');
const { getClient } = require('./anthropic');

// ---------------------------------------------------------------------
// Plain-English labels for compliance_topics.topic_key, used to build good
// YouTube search queries (raw slugs like "ab-1482-statewide-and-local-
// variation" make bad search terms).
//
// Intentionally duplicated from content-review/server.js's TOPIC_LABELS
// (search for `const TOPIC_LABELS` in that file). content-engine and
// content-review are separate apps that don't share code today, and this is
// a small, low-churn 13-entry map — not worth building shared infrastructure
// for. If the topic list or its labels ever change, update both places.
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
  'eviction-process-and-cost': 'Eviction process & cost',
};

// Fixed suffix appended to every topic label to build the search query, e.g.
// "Security deposits California landlord". Cuts down on off-topic results
// (confirmed necessary by Oracle's research) vs. searching the bare label.
const SEARCH_QUERY_SUFFIX = 'California landlord';

const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const YOUTUBE_VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';

const LOOKBACK_DAYS = 14;               // only consider videos published in the last 14 days
const MAX_RESULTS_PER_SEARCH = 15;
const MIN_VIEWS_TO_RANK = 250;          // below this, too new to tell anything from (Oracle's finding)
const TOP_CANDIDATES_PER_TOPIC = 3;     // don't burn Claude tokens on every result, just the leaders
const RECENT_SUGGESTIONS_LOOKBACK_DAYS = 30; // window for the topic-duplicate check

// Hard ceiling on total YouTube API calls in one run. Normally needs ~13-16
// (12 search.list calls + a handful of videos.list batch calls, batched 50
// ids at a time). 30 is well above that but low enough to catch a runaway
// bug if the topic list ever grows unexpectedly.
const MAX_YOUTUBE_API_CALLS = 30;

const CLAUDE_MODEL = 'claude-opus-4-8'; // same model string used by lib/draft.js

// ---------------------------------------------------------------------
// Pure helpers (no I/O) — kept separate so they're easy to unit-test.
// ---------------------------------------------------------------------

/**
 * Views per day since publication. Minimum 1 day so a same-day video
 * doesn't divide by (near) zero and look artificially explosive.
 */
function computeVelocity(viewCount, publishedAt, now = new Date()) {
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysSincePublished = Math.max(1, (now - new Date(publishedAt)) / msPerDay);
  return viewCount / daysSincePublished;
}

/**
 * Filter out videos below the view floor, rank the rest by velocity
 * (views/day), and keep only the top N. `videos` items need viewCount and
 * publishedAt.
 */
function rankAndFilterCandidates(videos, opts = {}) {
  const minViews = opts.minViews ?? MIN_VIEWS_TO_RANK;
  const topN = opts.topN ?? TOP_CANDIDATES_PER_TOPIC;
  const now = opts.now ?? new Date();

  return videos
    .filter((v) => v.viewCount >= minViews)
    .map((v) => ({ ...v, velocity: computeVelocity(v.viewCount, v.publishedAt, now) }))
    .sort((a, b) => b.velocity - a.velocity)
    .slice(0, topN);
}

function truncate(str, max = 500) {
  if (!str) return str;
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

// ---------------------------------------------------------------------
// YouTube API calls
// ---------------------------------------------------------------------

async function youtubeSearch(query, apiKey, publishedAfterIso) {
  const params = new URLSearchParams({
    key: apiKey,
    q: query,
    type: 'video',
    part: 'snippet',
    publishedAfter: publishedAfterIso,
    // 'relevance' (default) over 'date' — the publishedAfter filter already
    // guarantees recency, so relevance ranking gets us on-topic videos
    // rather than whatever was just uploaded regardless of fit.
    order: 'relevance',
    maxResults: String(MAX_RESULTS_PER_SEARCH),
    // Soft preference for English results — YouTube docs describe this as a
    // ranking bias, not a hard filter, so a non-English video can still slip
    // through. That's why the Claude judge prompt below also checks
    // language as a backstop.
    relevanceLanguage: 'en',
  });
  const res = await fetch(`${YOUTUBE_SEARCH_URL}?${params}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube search.list failed (${res.status}): ${truncate(body)}`);
  }
  const data = await res.json();
  return (data.items || [])
    .filter((item) => item.id && item.id.videoId)
    .map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      description: item.snippet.description,
      publishedAt: item.snippet.publishedAt,
    }));
}

/**
 * Fetch view counts for up to 50 video ids in one call. Only statistics are
 * requested — title/description are already in hand from search.list, no
 * need to pay for snippet twice.
 */
async function youtubeVideoStatsBatch(videoIds, apiKey) {
  const params = new URLSearchParams({
    key: apiKey,
    id: videoIds.join(','),
    part: 'statistics',
  });
  const res = await fetch(`${YOUTUBE_VIDEOS_URL}?${params}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube videos.list failed (${res.status}): ${truncate(body)}`);
  }
  const data = await res.json();
  const statsById = new Map();
  for (const item of data.items || []) {
    statsById.set(item.id, { viewCount: Number(item.statistics?.viewCount || 0) });
  }
  return statsById;
}

// ---------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------

/**
 * Exact-match dedup: which of these video ids already exist ANYWHERE in
 * topic_suggestions (any status, any feed_source)? No AI judgment needed —
 * this is a pure lookup, done before spending any Claude tokens.
 */
async function findExistingVideoIds(videoIds) {
  if (videoIds.length === 0) return new Set();
  const rows = await select(
    'topic_suggestions',
    `select=youtube_video_id&youtube_video_id=in.(${videoIds.join(',')})`
  );
  return new Set(rows.map((r) => r.youtube_video_id));
}

async function getRecentSuggestions() {
  const since = new Date(Date.now() - RECENT_SUGGESTIONS_LOOKBACK_DAYS * 86400000).toISOString();
  // Across ALL feed_source values, per spec — a viral-scan candidate can
  // duplicate a topic that came from any feed, not just this one.
  return select('topic_suggestions', `select=topic_summary,relevance_note,created_at&created_at=gte.${since}`);
}

async function logScanRun({ succeeded, suggestionsCreated, errorMessage }) {
  try {
    await insert('topic_scan_runs', {
      feed_source: 'viral_trend_scan',
      succeeded,
      suggestions_created: suggestionsCreated || 0,
      error_message: errorMessage ? truncate(errorMessage) : null,
    });
  } catch (err) {
    // Logging the run must never itself take down the script silently —
    // this is the last line of defense, so just surface it loudly.
    console.error(`[scan-viral-topics] Failed to write topic_scan_runs row: ${err.message}`);
  }
}

// ---------------------------------------------------------------------
// Claude relevance + topic-duplicate check
// ---------------------------------------------------------------------

function formatRecentSuggestionsForPrompt(recent) {
  if (recent.length === 0) return '(No topic suggestions in the last 30 days.)';
  return recent.map((r, i) => `${i + 1}. ${r.topic_summary} — ${r.relevance_note}`).join('\n');
}

function buildJudgeSystemPrompt() {
  return `You are screening YouTube videos as candidate topic ideas for Rincon
Management, a property management company operating in Ventura County,
Southern California. You are NOT drafting content and you are NOT a legal
source — you are only judging (a) whether a video is relevant to Rincon's
audience and (b) whether it duplicates a topic already suggested recently.

CRITICAL RULE: never state, imply, or restate what any law, statute, or
ordinance actually requires. Do not assert any specific legal rule, dollar
figure, deadline, or percentage as fact, even if the video title or
description mentions one. Your summaries describe that public interest in a
topic exists right now — never what the law says. If the video's content
touches a legal detail, describe it as "this video discusses X" rather than
stating X as true.

Respond with a single JSON object and nothing else — no markdown code
fences, no commentary outside the JSON.`;
}

function buildJudgeUserPrompt(candidate, recentSuggestions) {
  const daysSincePublished = Math.max(
    1,
    Math.round((Date.now() - new Date(candidate.publishedAt).getTime()) / 86400000)
  );
  return `CANDIDATE VIDEO
Title: ${candidate.title}
Description: ${candidate.description}
Views: ${candidate.viewCount}
Published: ${candidate.publishedAt} (${daysSincePublished} day(s) ago)

RECENT TOPIC SUGGESTIONS (last 30 days, across all discovery feeds):
${formatRecentSuggestionsForPrompt(recentSuggestions)}

Judge two things:
1. relevant — true only if this video is genuinely useful to a Ventura
   County / Southern California property manager's audience: specifically
   landlord-tenant issues, rental market conditions, or property-management-
   relevant legal/regulatory topics. Generic real estate content (home
   buying, house flipping, interior design, real estate investing tips with
   no landlord/tenant angle) is NOT relevant — mark false. Also mark false
   if the title or description is not in English, or you can't tell that it
   is — Peter needs to be able to actually watch and evaluate whatever
   video is suggested to him.
2. duplicate — true if this video is substantially the same underlying
   topic as anything in the RECENT TOPIC SUGGESTIONS list above.

Return exactly this JSON shape:
{
  "relevant": true or false,
  "duplicate": true or false,
  "topic_summary": "one plain-English sentence describing the video and its recent traction, e.g. \\"A YouTube video titled 'X' has hit ${candidate.viewCount} views in the past ${daysSincePublished} day(s).\\" Never state a legal fact here.",
  "relevance_note": "one plain-English sentence on why this is relevant right now for Rincon's audience. Never state a legal fact here."
}

If relevant is false, topic_summary and relevance_note can be empty strings.`;
}

function parseJudgeResponse(text) {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      relevant: Boolean(parsed.relevant),
      duplicate: Boolean(parsed.duplicate),
      topicSummary: typeof parsed.topic_summary === 'string' ? parsed.topic_summary.trim() : '',
      relevanceNote: typeof parsed.relevance_note === 'string' ? parsed.relevance_note.trim() : '',
    };
  } catch (err) {
    console.warn(`[scan-viral-topics] Could not parse Claude's verdict as JSON, skipping candidate: ${err.message}`);
    return null;
  }
}

async function judgeCandidate(client, candidate, recentSuggestions) {
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 512,
    system: buildJudgeSystemPrompt(),
    messages: [{ role: 'user', content: buildJudgeUserPrompt(candidate, recentSuggestions) }],
  });
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) return null;
  return parseJudgeResponse(textBlock.text);
}

// ---------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------

/**
 * Run one viral-trend-scan pass: search YouTube per compliance topic, rank
 * by view velocity, dedup, relevance/duplicate-check via Claude, and write
 * survivors into topic_suggestions.
 *
 * @param {{suggestionsCreated: number}} stats - mutated in place as
 *   suggestions are created, so the caller can log an accurate count into
 *   topic_scan_runs even if this function throws partway through.
 */
async function runViralTrendScan(stats = { suggestionsCreated: 0 }) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Missing YOUTUBE_API_KEY. Get one from Google Cloud Console (enable ' +
        '"YouTube Data API v3", then create an API key) and add it to the ' +
        'root .env as YOUTUBE_API_KEY — same pattern as ANTHROPIC_API_KEY.'
    );
  }

  const topics = await listTopics();
  const missingLabels = topics.filter((t) => !TOPIC_LABELS[t.topic_key]);
  if (missingLabels.length > 0) {
    console.warn(
      `[scan-viral-topics] No TOPIC_LABELS entry for: ${missingLabels
        .map((t) => t.topic_key)
        .join(', ')} — using the raw topic_key as the search term.`
    );
  }

  let apiCallCount = 0;
  const canCall = () => apiCallCount < MAX_YOUTUBE_API_CALLS;
  let capHit = false;

  const publishedAfter = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();

  // 1. Search per topic, collecting candidates plus a dedup'd video index
  // (a video could theoretically surface under more than one topic search;
  // we only want to fetch its stats once).
  const candidatesByTopic = []; // { topicKey, videoId }
  const videoIndex = new Map(); // videoId -> { title, description, publishedAt }

  for (const topic of topics) {
    if (!canCall()) {
      capHit = true;
      break;
    }
    const label = TOPIC_LABELS[topic.topic_key] || topic.topic_key;
    const query = `${label} ${SEARCH_QUERY_SUFFIX}`;
    apiCallCount++;
    let results;
    try {
      results = await youtubeSearch(query, apiKey, publishedAfter);
    } catch (err) {
      console.warn(`[scan-viral-topics] Search failed for topic "${topic.topic_key}": ${err.message}`);
      continue;
    }
    for (const r of results) {
      videoIndex.set(r.videoId, r);
      candidatesByTopic.push({ topicKey: topic.topic_key, videoId: r.videoId });
    }
  }

  // 2. Fetch view counts for every unique candidate video, batched 50/call.
  const allVideoIds = Array.from(videoIndex.keys());
  const statsById = new Map();
  for (let i = 0; i < allVideoIds.length; i += 50) {
    if (!canCall()) {
      capHit = true;
      break;
    }
    const batch = allVideoIds.slice(i, i + 50);
    apiCallCount++;
    try {
      const batchStats = await youtubeVideoStatsBatch(batch, apiKey);
      for (const [id, s] of batchStats) statsById.set(id, s);
    } catch (err) {
      console.warn(`[scan-viral-topics] videos.list batch failed: ${err.message}`);
    }
  }

  if (capHit) {
    console.warn(
      `[scan-viral-topics] Hit the ${MAX_YOUTUBE_API_CALLS}-call YouTube API cap this run — ` +
        'some topics or stats lookups were skipped.'
    );
  }

  // 3. Rank per topic by view velocity, top 3 each.
  const topicToVideos = new Map();
  for (const c of candidatesByTopic) {
    const video = videoIndex.get(c.videoId);
    const s = statsById.get(c.videoId);
    if (!video || !s) continue; // dropped from videos.list response (e.g. private/deleted since search)
    const list = topicToVideos.get(c.topicKey) || [];
    list.push({ ...video, viewCount: s.viewCount });
    topicToVideos.set(c.topicKey, list);
  }

  const now = new Date();
  let finalCandidates = [];
  for (const [topicKey, videos] of topicToVideos) {
    const top = rankAndFilterCandidates(videos, { now });
    for (const v of top) finalCandidates.push({ topicKey, ...v });
  }

  if (finalCandidates.length === 0) return stats;

  // 4. Dedup across topics: the same video can rank as a top candidate under
  // more than one topic search (e.g. one popular video matches both "rent
  // control" and "notice requirements"). Collapse to one candidate per
  // unique video ID now, before the database check or any Claude calls —
  // otherwise the same video gets judged and inserted once per topic that
  // surfaced it. Keep whichever occurrence has the highest velocity
  // (deterministic tie-break: Map keeps first-seen on equal velocity).
  const byVideoId = new Map();
  for (const c of finalCandidates) {
    const existing = byVideoId.get(c.videoId);
    if (!existing || c.velocity > existing.velocity) {
      byVideoId.set(c.videoId, c);
    }
  }
  finalCandidates = Array.from(byVideoId.values());

  // 5. Exact-match dedup against topic_suggestions.youtube_video_id — pure
  // lookup, before spending any Claude tokens.
  const existingIds = await findExistingVideoIds(finalCandidates.map((c) => c.videoId));
  const surviving = finalCandidates.filter((c) => !existingIds.has(c.videoId));

  if (surviving.length === 0) return stats;

  // 6. Relevance + topic-duplicate check via Claude, one call per candidate.
  const recentSuggestions = await getRecentSuggestions();
  const client = getClient();

  for (const candidate of surviving) {
    let verdict;
    try {
      verdict = await judgeCandidate(client, candidate, recentSuggestions);
    } catch (err) {
      console.warn(`[scan-viral-topics] Claude judgment failed for video ${candidate.videoId}: ${err.message}`);
      continue;
    }
    if (!verdict || !verdict.relevant || verdict.duplicate) continue;
    if (!verdict.topicSummary || !verdict.relevanceNote) {
      console.warn(`[scan-viral-topics] Claude verdict missing summary/note for video ${candidate.videoId}, skipping.`);
      continue;
    }

    await insert('topic_suggestions', {
      feed_source: 'viral_trend_scan',
      status: 'pending',
      youtube_video_id: candidate.videoId,
      topic_summary: verdict.topicSummary,
      relevance_note: verdict.relevanceNote,
    });
    stats.suggestionsCreated++;
  }

  return stats;
}

module.exports = {
  TOPIC_LABELS,
  computeVelocity,
  rankAndFilterCandidates,
  findExistingVideoIds,
  logScanRun,
  runViralTrendScan,
};
