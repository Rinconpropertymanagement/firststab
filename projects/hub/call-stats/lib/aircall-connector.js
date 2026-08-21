/**
 * lib/aircall-connector.js
 * Talks to Rincon's real, live Aircall account (Basic Auth, real production
 * call data — not a sandbox). Scoped locally to this tool, same reasoning
 * maintenance-history/lib/latchel-connector.js gives for not sharing a
 * connector module before a second consumer exists.
 *
 * ============================================================
 * CRITICAL — READ BEFORE ADDING ANYTHING TO THIS FILE
 * ============================================================
 * AIRCALL_API_ID / AIRCALL_API_TOKEN is one account-wide credential with no
 * documented read-only variant (SPEC.md Design Decision 6 — Sentinel still
 * needs to confirm this the same way it's flagged, not yet resolved, for
 * the Latchel key). This module is the ONLY place in this codebase allowed
 * to call Aircall, and it enforces "read-only in practice" the only way
 * this credential allows: every function below issues a plain GET and
 * NOTHING ELSE. There is no generic "request(method, path)" helper here on
 * purpose, same discipline as latchel-connector.js — a generic helper
 * would be one careless call site away from a POST/PUT/DELETE against a
 * real Aircall account (which can create, edit, or delete real
 * lines/users/calls). If a future change needs a new Aircall read, add a
 * new narrowly-named function that calls aircallGet() — never add a way
 * to pass an HTTP method in from outside this file.
 * ============================================================
 *
 * ============================================================
 * LIVE VERIFICATION — done before writing this file (Q, 2026-08-20),
 * re-checking Neo's own live findings in the migration header rather than
 * trusting them secondhand, per this project's live-verification
 * discipline
 * ============================================================
 * Fetched 600 real Rincon calls (12 pages, GET /v1/calls, Basic Auth) plus
 * a real from/to-filtered day (146 calls). Findings:
 *
 *   1. Pagination: `meta.next_page_link` is a complete, ready-to-fetch URL
 *      that already carries every original query param (from, to, order,
 *      per_page) — confirmed by inspecting a real next_page_link string.
 *      Unlike Latchel's `links.next` (which drops query params and needs
 *      manual rebuilding), Aircall's can just be fetched directly. This
 *      file does exactly that — no URL reconstruction needed here.
 *
 *   2. Date filtering: `from`/`to` query params (unix seconds) filter on
 *      `started_at`, confirmed live — every call in a from/to-bounded
 *      fetch had `started_at` inside the requested window, no exceptions
 *      across 146 real calls.
 *
 *   3. Per-user attribution (`call.user`) matches Neo's migration finding
 *      exactly: populated with {id, name, email} on every call that has
 *      an individual attached, null when a call goes fully unattributed.
 *      Refined further, across a larger 600-call sample than Neo's
 *      original 50-call check:
 *        - Every INBOUND call with a `user` attached was answered by that
 *          user (0/183 inbound+user calls had a null answered_at) — the
 *          "inbound miss nobody personally picked up" case is carried
 *          ENTIRELY by user:null rows (128/600), never by a user-attached
 *          row with answered_at:null. Matches this build's task
 *          instruction to skip attribution on user:null calls rather than
 *          inventing a per-person "missed" case that real data doesn't
 *          produce.
 *        - OUTBOUND calls DO show up with a real user attached and
 *          answered_at:null (6/600) — a staff member placed a call the
 *          other party never picked up. This is the real "outbound
 *          missed" case the schema's missed_calls column expects.
 *        - A THIRD case Neo's original 50-call sample didn't surface:
 *          outbound calls with user:null that WERE answered (19/600) —
 *          calls placed from a shared line (e.g. "Maintenance Hotline")
 *          with no individual staff attribution at all. These can't be
 *          attributed to any one person either, for the same reason the
 *          inbound user:null case can't — handled the same way (skip
 *          attribution, log it, per this build's task instructions).
 *
 *   4. `call.duration` does NOT equal `ended_at - started_at` as SPEC.md's
 *      "confirmed per brief" line assumed — a real call with
 *      started_at/answered_at/ended_at of 1787183583/1787183598/1787183792
 *      has duration: 194, which equals `ended_at - answered_at` (talk
 *      time only), not `ended_at - started_at` (209). Doesn't change
 *      anything about this build — total_talk_seconds and
 *      total_ring_seconds are always computed here from the three raw
 *      timestamps directly, `duration` is never read — but worth flagging
 *      since the spec document asserted this as "confirmed," not
 *      "needs verification," and it was live-verified wrong.
 *
 *   5. A currently-in-progress call has `status: "answered"` (not "done")
 *      and `ended_at: null` even though `answered_at` is set — 1/600 in
 *      this sample (the single most recent call at fetch time). The
 *      nightly sync only ever asks for a full PAST Pacific day, so a real
 *      still-in-progress call should never appear in what it fetches —
 *      but lib/sync.js guards for it defensively anyway (skips + logs any
 *      call with a null ended_at rather than assuming it's done).
 * ============================================================
 */

const AIRCALL_BASE = process.env.AIRCALL_API_BASE || 'https://api.aircall.io/v1';

function authHeader() {
  const id = process.env.AIRCALL_API_ID;
  const token = process.env.AIRCALL_API_TOKEN;
  if (!id || !token) throw new Error('AIRCALL_API_ID / AIRCALL_API_TOKEN are not set. See .env.example.');
  return 'Basic ' + Buffer.from(`${id}:${token}`).toString('base64');
}

// The one and only place an HTTP request is made to Aircall in this file.
// Always GET. Always this exact call shape.
async function aircallGet(pathOrUrl) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : AIRCALL_BASE + pathOrUrl;

  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: authHeader() },
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    throw new Error(`Aircall rate limit hit (429). Retry-After: ${retryAfter || 'unknown'}.`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Aircall GET ${pathOrUrl} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Every call that started in [fromUnixSeconds, toUnixSeconds) — follows
 * meta.next_page_link until exhausted (see LIVE VERIFICATION #1/#2 above).
 * per_page 50 is Aircall's own default page size for this endpoint;
 * passed explicitly so behavior doesn't silently change if Aircall's
 * default ever does.
 */
async function listCallsForDateRange(fromUnixSeconds, toUnixSeconds, { maxPages = 500 } = {}) {
  let all = [];
  let url = `${AIRCALL_BASE}/calls?order=asc&per_page=50&from=${fromUnixSeconds}&to=${toUnixSeconds}`;
  let pages = 0;
  while (url && pages < maxPages) {
    const body = await aircallGet(url);
    all = all.concat(body.calls || []);
    url = (body.meta && body.meta.next_page_link) || null;
    pages++;
  }
  if (pages >= maxPages) {
    throw new Error(`Aircall calls fetch hit the ${maxPages}-page safety cap without reaching the last page — aborting rather than silently returning a partial day.`);
  }
  return all;
}

/** Read-only connectivity check, same purpose as latchel-connector's implicit ping via listProperties(). */
async function ping() {
  return aircallGet('/ping');
}

module.exports = { listCallsForDateRange, ping };
