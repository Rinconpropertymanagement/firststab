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

// ============================================================
// LINE-TO-USER RING MEMBERSHIP (added 2026-09-10)
// ============================================================
// Everything below exists for one reason: to answer "which staff members
// does this phone line ring?" so that a miss on a line ringing exactly ONE
// person can be charged to that person (answer-rate-redefinition-SPEC.md
// Design Decisions 10-12, migration
// 20260910010000_add_sole_user_attribution_to_call_stats_line_misses.sql).
//
// *** THE TRAP — READ THIS BEFORE RE-CHECKING ANY OF IT ***
// Ring membership is NOT returned by the `GET /v1/numbers` LIST endpoint.
// The list returns every one of Rincon's 15 lines with its `users` array
// empty or absent, for ALL 15. Only the per-number DETAIL endpoint,
// `GET /v1/numbers/:id`, returns the real membership. Trusting the list
// leads to the confident, wrong conclusion that no line rings anybody —
// which has already happened once in this project. That is the entire
// reason listNumbers() below is used ONLY to enumerate line IDs and its
// `users` field is never read, and why fetchLineRingMembership() spends a
// GET per line instead of one cheap list call.
//
// Cost: ~16 GETs per nightly run (one list page + one detail per line, plus
// at most one users page if an email needs resolving). Trivial in volume,
// but note that aircallGet() throws on a 429 with no retry — a rate-limit
// hit here fails the mapping fetch, which by design fails the line-miss
// half of the sync loudly and leaves the day re-runnable rather than
// writing an attribution nobody can distinguish from "this line rang
// nobody."
//
// These functions follow this file's CRITICAL header rule: each new Aircall
// read is its own narrowly-named function issuing one fixed GET shape
// through aircallGet(). fetchLineRingMembership() at the bottom makes no
// request of its own at all — it only composes the three GET functions
// above it — so no new way to reach Aircall is introduced here, and in
// particular nothing that could carry an HTTP method in from outside this
// file. If a future change needs another Aircall read, add another function
// like these; do not generalise them.
// ============================================================

/**
 * Every phone line on the account, used ONLY to enumerate line IDs (and to
 * carry each line's name for logging). The `users` array on these list
 * results is deliberately never read — see THE TRAP above.
 *
 * Pagination follows meta.next_page_link the same way listCallsForDateRange
 * does (LIVE VERIFICATION #1: it is a complete, ready-to-fetch URL that
 * already carries the original query params). Rincon has 15 lines, so one
 * page is expected; the loop is here so a future 60-line account doesn't
 * silently lose lines 51+.
 */
async function listNumbers({ maxPages = 50 } = {}) {
  let all = [];
  let url = `${AIRCALL_BASE}/numbers?per_page=50`;
  let pages = 0;
  while (url && pages < maxPages) {
    const body = await aircallGet(url);
    // Throw rather than treat a missing array as "this account has no
    // lines." An empty-looking success here would flow straight through to
    // "no line rings anybody," which is exactly the confidently-wrong
    // answer this whole feature has to avoid.
    if (!body || !Array.isArray(body.numbers)) {
      throw new Error('Aircall GET /numbers returned no `numbers` array — refusing to read that as "this account has no phone lines."');
    }
    all = all.concat(body.numbers);
    url = (body.meta && body.meta.next_page_link) || null;
    pages++;
  }
  if (url && pages >= maxPages) {
    throw new Error(`Aircall numbers fetch hit the ${maxPages}-page safety cap without reaching the last page — aborting rather than silently returning a partial line list.`);
  }
  return all;
}

/**
 * ONE line's full detail, including the `users` array this whole feature
 * depends on. The only endpoint that reports real ring membership.
 */
async function getNumberDetail(numberId) {
  const body = await aircallGet(`/numbers/${encodeURIComponent(String(numberId))}`);
  // Aircall wraps a single resource in a named envelope (`{ number: {...} }`).
  // If that envelope is missing, throw instead of falling back to the raw
  // body: a raw body has no `users` key either, so the fallback would read
  // as "this line rings nobody" — a silent, confidently wrong answer, on
  // the exact endpoint this feature's correctness rests on.
  if (!body || typeof body.number !== 'object' || body.number === null) {
    throw new Error(`Aircall GET /numbers/${numberId} returned no \`number\` object — refusing to guess at this line's ring membership.`);
  }
  return body.number;
}

/**
 * Every Aircall user on the account (id, name, email). Fetched ONLY when a
 * line's detail response gives a sole user with no email on it — the
 * fallback path described in the migration's NOTES FOR Q #2. Emails are
 * this design's join key to call_stats.staff_email and users.email; storing
 * an Aircall user ID on a line-keyed row instead would be a second
 * identifier that nothing keys or joins on, which Neo explicitly rejected.
 */
async function listUsers({ maxPages = 50 } = {}) {
  let all = [];
  let url = `${AIRCALL_BASE}/users?per_page=50`;
  let pages = 0;
  while (url && pages < maxPages) {
    const body = await aircallGet(url);
    if (!body || !Array.isArray(body.users)) {
      throw new Error('Aircall GET /users returned no `users` array — refusing to read that as "this account has no users."');
    }
    all = all.concat(body.users);
    url = (body.meta && body.meta.next_page_link) || null;
    pages++;
  }
  if (url && pages >= maxPages) {
    throw new Error(`Aircall users fetch hit the ${maxPages}-page safety cap without reaching the last page — aborting rather than silently returning a partial user list.`);
  }
  return all;
}

/**
 * The mapping the nightly sync snapshots onto each line-miss row.
 *
 * @returns {Promise<Map<string, {
 *   line_name: string,
 *   ring_user_count: number,
 *   sole_user_email: string|null,
 *   sole_user_name: string|null,
 * }>>} keyed by the line's Aircall number ID as a STRING, matching the way
 *   lib/sync.js keys call_stats_line_misses rows (String(call.number.id)).
 *
 * `sole_user_email` is non-null ONLY when ring_user_count === 1 and that one
 * user's email could actually be resolved, always lower-cased (NOTES FOR Q
 * #3 — call_stats.staff_email is stored lower-cased, and a capitalised
 * Aircall seat would make the two halves of the Answer Rate fraction fail
 * to join, silently, for that one person). ring_user_count === 1 with a
 * null email is a real, self-describing data-quality state the caller must
 * log loudly and treat as unattributed — it is NOT the dangerous ambiguity
 * the design warns about, precisely because ring_user_count is sitting
 * right there saying the line did ring exactly one person.
 *
 * This function THROWS on any failure rather than returning a partial map.
 * That is deliberate and it is the whole failure design: a NULL attribution
 * on a stored row means "this line had no sole user that day" and must
 * never also mean "we could not find out." A partial map here would produce
 * exactly that second meaning, permanently, with nothing on the row to say
 * so. The caller's contract is to fail the line-miss half of the sync and
 * leave the day re-runnable. An EMPTY map counts as a partial map and is
 * refused for the same reason — see below.
 */
async function fetchLineRingMembership() {
  const numbers = await listNumbers();

  // An EMPTY line list is refused, not accepted as "this account has no
  // lines." listNumbers() above already throws when the `numbers` key is
  // missing, but `{ "numbers": [] }` is a well-formed success response and
  // sails through it — reachable in real life from a token scoped down to
  // no lines, a mid-reconfiguration account, or an Aircall-side change.
  // Left unguarded it produces a Map(0), every line then misses the mapping,
  // and every row for the day is written with sole_user_email NULL and
  // ring_user_count NULL while the sync route returns 200. That is the
  // permanent, silent, self-concealing undercount the whole failure design
  // exists to prevent: the day looks like a day on which no line rang
  // anybody, understating real people's misses forever, with nothing on the
  // row saying otherwise. Throwing here routes it into the caller's existing
  // fail-loud path instead — line-miss upserts skipped entirely, 502, day
  // re-runnable.
  //
  // This is also why the users-array safety net below no longer tests
  // `numbers.length > 0`: that condition was the escape hatch the empty case
  // slipped through, and the empty case is now handled here on its own.
  if (numbers.length === 0) {
    throw new Error('Aircall GET /numbers returned an empty line list. Refusing to read that as "this account has no phone lines" — an empty mapping would write every line-miss row with no attribution, which is indistinguishable from "this line rang nobody." See lib/aircall-connector.js.');
  }

  const membership = new Map();

  // Collected across all lines, then resolved in ONE extra GET at the end
  // if needed, rather than a users fetch per line.
  const soleUsersNeedingEmail = []; // { numberId, userId }
  // The safety net for THE TRAP above, in code rather than in a comment:
  // if not a single line's DETAIL response carries a `users` ARRAY, that is
  // the signature of reading the list endpoint by mistake, or of Aircall
  // changing this endpoint's shape. Concluding "no line rings anybody" from
  // that would silently switch this whole feature off and leave every
  // percentage back at 100%, with no error anywhere. Throw instead.
  let anyLineReportedAUsersArray = false;

  for (const listedNumber of numbers) {
    const numberId = String(listedNumber.id);
    const detail = await getNumberDetail(numberId);
    const users = Array.isArray(detail.users) ? detail.users : null;
    if (users) anyLineReportedAUsersArray = true;

    const ringUserCount = users ? users.length : 0;
    const entry = {
      line_name: detail.name || listedNumber.name || '',
      ring_user_count: ringUserCount,
      sole_user_email: null,
      sole_user_name: null,
    };

    if (ringUserCount === 1) {
      const soleUser = users[0] || {};
      entry.sole_user_name = soleUser.name || null;
      const email = String(soleUser.email || '').trim().toLowerCase();
      if (email) {
        entry.sole_user_email = email;
      } else if (soleUser.id != null) {
        // The detail endpoint returned only id/name for this user — the
        // fork the redefinition spec's Open Item 10 flagged. Resolve it
        // through Aircall's own users endpoint below; do NOT store the ID
        // instead (migration NOTES FOR Q #2).
        soleUsersNeedingEmail.push({ numberId, userId: String(soleUser.id) });
      }
    }

    membership.set(numberId, entry);
  }

  if (!anyLineReportedAUsersArray) {
    throw new Error(
      'Aircall returned no `users` array on ANY line detail response. That is the signature of reading GET /v1/numbers (the LIST endpoint, which omits ring membership for every line) instead of GET /v1/numbers/:id, or of the detail endpoint changing shape. Refusing to conclude that no line rings anybody — see THE TRAP in lib/aircall-connector.js.'
    );
  }

  if (soleUsersNeedingEmail.length > 0) {
    const allUsers = await listUsers();
    const emailByUserId = new Map();
    for (const u of allUsers) {
      if (u && u.id != null && u.email) emailByUserId.set(String(u.id), String(u.email).trim().toLowerCase());
    }
    for (const { numberId, userId } of soleUsersNeedingEmail) {
      const email = emailByUserId.get(userId);
      // Left null on purpose when the id resolves to nothing (an Aircall
      // seat with no email at all). The caller logs that loudly and treats
      // the line as unattributed; it is NOT invented, and it is NOT allowed
      // to look like "this line rang nobody" — ring_user_count stays 1.
      if (email) membership.get(numberId).sole_user_email = email;
    }
  }

  return membership;
}

/**
 * Rincon's OWN line numbers, as Aircall reports them — e.g.
 * "+1 805-427-9358". Used to build the exclusion set the sales
 * classification applies BEFORE any HubSpot lookup (see lib/phone-key.js,
 * which explains why that exclusion is load-bearing rather than tidiness:
 * two contacts holding Rincon's Property Manager - Faria line currently sit
 * at `opportunity` in HubSpot, so without it every call on that line would
 * be counted as an outbound sales call).
 *
 * Reads the LIST endpoint, and that is correct here — unlike ring
 * membership (THE TRAP above), `digits` IS returned by the list endpoint,
 * on every line. One GET per night, not fifteen.
 *
 * Fetched fresh each run rather than hardcoded anywhere: lines get added
 * and retired in Aircall, and a stale literal list would silently stop
 * excluding a new line, which shows up as that line's internal calls
 * turning into "sales."
 *
 * THROWS rather than returning a partial or empty list, for the same
 * reason fetchLineRingMembership() does. A short exclusion set does not
 * fail loudly on its own — it quietly reclassifies Rincon's internal calls
 * as sales calls, which is a wrong number that looks like a good week.
 */
async function listOwnLineDigits() {
  const numbers = await listNumbers();
  if (numbers.length === 0) {
    throw new Error('Aircall GET /numbers returned an empty line list. Refusing to build an empty own-number exclusion set — that would let Rincon\'s own internal calls be looked up in HubSpot and counted as sales. See lib/phone-key.js.');
  }
  const digits = numbers.map(n => n && n.digits).filter(Boolean).map(String);
  if (digits.length === 0) {
    throw new Error(`Aircall returned ${numbers.length} line(s) but not one carried a \`digits\` field — refusing to build an empty own-number exclusion set. See lib/phone-key.js.`);
  }
  return digits;
}

/** Read-only connectivity check, same purpose as latchel-connector's implicit ping via listProperties(). */
async function ping() {
  return aircallGet('/ping');
}

module.exports = { listCallsForDateRange, fetchLineRingMembership, listOwnLineDigits, ping };
