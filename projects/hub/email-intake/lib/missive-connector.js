/**
 * lib/missive-connector.js
 * Talks to Rincon's real, live Missive account (REST API, real production
 * data — not a sandbox). Scoped locally to this tool, same reasoning
 * maintenance-history/lib/latchel-connector.js gives for not sharing a
 * connector module before a second consumer exists — that file is this
 * one's direct model (projects/hub/email-intake/missive-connection-plan.md,
 * "Built from, read in full").
 *
 * ============================================================
 * CRITICAL — READ BEFORE ADDING ANYTHING TO THIS FILE
 * ============================================================
 * 1. GET ONLY. Same discipline as latchel-connector.js: there is no generic
 *    "request(method, path)" helper here on purpose. If a future change
 *    needs a new Missive read, add a new narrowly-named function that calls
 *    missiveGet() — never add a way to pass an HTTP method in from outside
 *    this file.
 * 2. NEVER log a Missive response body, for ANY endpoint, on success or
 *    error. This is stricter than latchel-connector.js's own
 *    `res.text().slice(0, 300)` error-logging pattern — deliberately not
 *    reused here. Every endpoint in this file can return real tenant/owner/
 *    staff correspondence (subjects, addresses, quoted message text) even
 *    inside an error body (e.g. a validation error echoing back part of the
 *    request), so the rule is simple and absolute rather than "safe for
 *    this endpoint, risky for that one": status code and request path only,
 *    never response text.
 * 3. MISSIVE_API_BASE below is Q's best-effort default
 *    ('https://public.missiveapp.com/v1'), not independently re-verified
 *    against a live Missive response in this build — Oracle's connection
 *    plan (missive-connection-plan.md) verified every documented path,
 *    parameter, and field name against Missive's live docs, but never
 *    states the literal base hostname in so many words, and this build had
 *    no live Missive credential to test against. CONFIRM THIS on Peter's
 *    first real manual trigger (a 401/404 on every call, instead of real
 *    data, is the tell that this default is wrong) — override with
 *    MISSIVE_API_BASE in .env if it needs to change; nothing else in this
 *    file needs to know.
 * 4. The exact JSON shape of each response below (which top-level key wraps
 *    the array/object) is Q's best-effort reading of Missive's documented
 *    REST conventions, also not independently re-verified live for the same
 *    reason as #3. Every function below fails loudly with a clear error —
 *    never silently — if the shape it expects isn't there, so a wrong
 *    guess surfaces immediately as a sync-run error, not as silently
 *    mis-parsed or dropped data.
 * ============================================================
 */

const MISSIVE_API_BASE = process.env.MISSIVE_API_BASE || 'https://public.missiveapp.com/v1';

function apiToken() {
  const token = process.env.MISSIVE_API_TOKEN;
  if (!token) throw new Error('MISSIVE_API_TOKEN is not set. See .env.example.');
  return token;
}

// The one and only place an HTTP request is made to Missive in this file.
// Always GET. Always this exact call shape. Never logs or returns response
// body text on a failure — see file header note #2.
async function missiveGet(path) {
  const url = path.startsWith('http') ? path : MISSIVE_API_BASE + path;

  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiToken()}` },
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    throw new Error(`Missive rate limit hit (429) on GET ${path}. Retry-After: ${retryAfter || 'unknown'}.`);
  }
  if (!res.ok) {
    throw new Error(`Missive GET ${path} failed: ${res.status}${res.statusText ? ' ' + res.statusText : ''}`);
  }
  return res.json();
}

/**
 * One page of conversations for a single Team Inbox, newest-to-oldest by
 * last_activity_at (Missive's only sort order — no ascending option, no
 * `since` filter; plan Section 1.3). Pass `until` (the oldest
 * last_activity_at already seen) to page backward for the next-older page.
 * limit is capped at Missive's documented max of 50.
 */
async function listConversationsPage({ teamId, until }) {
  let path = `/conversations?team_inbox=${encodeURIComponent(teamId)}&limit=50`;
  if (until != null) path += `&until=${encodeURIComponent(until)}`;

  const body = await missiveGet(path);
  const conversations = body.conversations;
  if (!Array.isArray(conversations)) {
    throw new Error(
      'Missive GET /conversations response did not contain a "conversations" array — ' +
      'the response shape may differ from what this connector assumes (see this file\'s ' +
      'header note #4). Verify against a real response before assuming this is a transient error.'
    );
  }
  return conversations;
}

/**
 * One page of a conversation's messages, newest-to-oldest by delivered_at
 * (plan Section 1.4). Metadata only — no message body here; that requires
 * getMessage() below, one call per message. limit is capped at Missive's
 * documented hard max of 10 for this endpoint (smaller than the
 * conversations list's 50).
 */
async function listConversationMessagesPage({ conversationId, until }) {
  let path = `/conversations/${encodeURIComponent(conversationId)}/messages?limit=10`;
  if (until != null) path += `&until=${encodeURIComponent(until)}`;

  const body = await missiveGet(path);
  const messages = body.messages;
  if (!Array.isArray(messages)) {
    throw new Error(
      'Missive GET /conversations/:id/messages response did not contain a "messages" array — ' +
      'the response shape may differ from what this connector assumes (see this file\'s ' +
      'header note #4). Verify against a real response before assuming this is a transient error.'
    );
  }
  return messages;
}

/**
 * Full content for one message, including the HTML `body` — the only
 * endpoint that returns it (plan Section 1.5). Confirmed against a real
 * response (live-tested 2026-09-06, real Faria Team message): Missive
 * returns `{"messages": {...}}` — the plural key `messages`, but holding a
 * single object, not an array. This is a genuine Missive API quirk (the
 * plural key name doesn't match the singular value shape), not a
 * documented convention — the original code assumed either an array under
 * `messages` or a plain object under a singular `message` key, and the
 * real shape is neither exactly, which is why every message fetch failed
 * with this function's own "not a recognizable message object" error on
 * the first live run. Handles all three possible shapes now: `messages`
 * as an array (take the first element), `messages` as a plain object (the
 * real, confirmed case — use it directly), or a singular `message` key
 * (kept as a fallback in case a future Missive API version changes this).
 * Still fails loudly if none of the three match, rather than guessing.
 */
async function getMessage(messageId) {
  const body = await missiveGet(`/messages/${encodeURIComponent(messageId)}`);
  const message = Array.isArray(body.messages)
    ? body.messages[0]
    : (body.messages || body.message);
  if (!message) {
    throw new Error(
      `Missive GET /messages/${messageId} response did not contain a recognizable message object ` +
      '("messages": [...], "messages": {...}, or "message": {...}) — the response shape may differ ' +
      'from what this connector assumes (see this file\'s header note #4).'
    );
  }
  return message;
}

module.exports = {
  listConversationsPage,
  listConversationMessagesPage,
  getMessage,
};
