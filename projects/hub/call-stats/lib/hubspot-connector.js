/**
 * lib/hubspot-connector.js
 * Talks to Rincon's real, live HubSpot account (Bearer token, real
 * production call data — not a sandbox). Scoped locally to this tool, same
 * reasoning aircall-connector.js gives for not sharing a connector module
 * before a second consumer exists.
 *
 * This is the follow-on connector for the HubSpot-native-line build
 * described in SPEC.md's Design Decision 5 citation and the migration at
 * supabase/migrations/20260908000000_call_stats_hubspot_native.sql — read
 * that migration's header comment first, it has the full "why this exists"
 * story (a second, separate phone system: HubSpot's own built-in calling
 * feature, distinct from Aircall's calls, which are already fully covered
 * by call_stats/call_stats_line_misses via aircall-connector.js and must
 * never be double-counted from here).
 *
 * ============================================================
 * CRITICAL — READ BEFORE ADDING ANYTHING TO THIS FILE
 * ============================================================
 * This module is the ONLY place in this codebase allowed to call HubSpot's
 * real REST API for the Call Stats tool. It only ever needs to READ call
 * records, so — same discipline as aircall-connector.js — there is no
 * generic "request(method, path, body)" helper here on purpose. HubSpot's
 * CRM Search API is a POST-shaped endpoint by HubSpot's own API design
 * (searching/filtering isn't exposed as a plain GET the way a single-record
 * fetch is) — that POST is a real HTTP verb this file has to send, but it
 * is "GET-only in effect": exactly one fixed request shape
 * (searchVoipCallsPage below) is ever sent, it only ever asks HubSpot to
 * find and return existing call records, and nothing in this file ever
 * creates, updates, deletes, or associates anything in Rincon's real
 * HubSpot account. If a future change needs a new HubSpot read, add a new
 * narrowly-named function that calls searchVoipCallsPage() or a similarly
 * fixed-shape helper — never add a way to pass an HTTP method or a
 * different HubSpot endpoint in from outside this file.
 * ============================================================
 *
 * ============================================================
 * LIVE VERIFICATION — done 2026-09-09, against a real HUBSPOT_PRIVATE_APP_TOKEN
 * ============================================================
 * Neo's migration header (20260908000000_call_stats_hubspot_native.sql)
 * already live-verified the real FIELD SHAPES this file depends on
 * (hs_call_direction is uppercase INBOUND/OUTBOUND, hs_call_duration is a
 * STRING OF MILLISECONDS, hs_call_status's real observed values, E.164
 * phone number format, hs_call_source distinguishing VOIP from
 * INTEGRATIONS_PLATFORM) against Rincon's real, live HubSpot account,
 * 2026-09-08 — those are trusted here without re-deriving them. The four
 * points below were re-checked with a real token, per the file's own
 * instruction to do so before treating anything here as confirmed:
 *
 *   1. Scope: crm.objects.calls.read is NOT selectable in this account's
 *      private-app scope picker (confirmed by Peter directly, then by
 *      HubSpot support: a gradual platform rollout that hasn't reached
 *      this portal yet). The scope that actually works — confirmed via a
 *      real token hitting both GET /crm/v3/objects/calls and this file's
 *      own listVoipCallsForNumbers() — is crm.objects.contacts.read.
 *      HubSpot support explained this is the scope the underlying
 *      engagement-read access for calls currently rides on. .env.example
 *      has been updated to say this; if HubSpot's rollout later adds
 *      crm.objects.calls.read to this account, switching to it would be
 *      more precisely scoped but isn't required — read-only access is
 *      already fully enforced in code (see above), not by the scope name.
 *   2. filterGroups behavior: confirmed correct. A real call to
 *      listVoipCallsForNumbers(['+18054101625'], ...) against Kristen
 *      Rau's real tracked HubSpot line returned exactly her real VOIP
 *      calls in range (6 results, e.g. object id 398227336932 — a real
 *      214-second outbound COMPLETED call) — the OR'd from/to filterGroups
 *      combined with the hs_call_source = VOIP filter worked exactly as
 *      HubSpot's documented semantics predict.
 *   3. Pagination shape: the request/response cycle itself is confirmed
 *      working end-to-end (see above), but the real verification run only
 *      produced a single page of results (6 calls, well under the page
 *      size). The `paging.next.after` cursor logic itself has still NOT
 *      been exercised against a genuine multi-page result set from this
 *      endpoint — do not assume it is bug-free at a page boundary until a
 *      tracked number with enough real volume forces a second page.
 *   4. Rate-limit behavior is still NOT verified — the test run was a
 *      handful of requests, nowhere near enough to observe a real 429.
 *      This file's defensive guard (see searchVoipCallsPage below) has
 *      still never actually fired against a real HubSpot response.
 *
 * Remaining open items (3 and 4 above) are the same class of thing
 * aircall-connector.js's own header left open after its first real
 * verification pass — not blockers, but not to be asserted as confirmed
 * either.
 * ============================================================
 */

const HUBSPOT_BASE = process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com';
const CALLS_SEARCH_PATH = '/crm/v3/objects/calls/search';

// HubSpot's documented Search API properties this build needs on every
// call record — the exact set Neo's migration live-verified the real shape
// of. Requesting only these (not every property HubSpot has) keeps the
// response small and makes it obvious in one place exactly what this
// module depends on.
const CALL_PROPERTIES = [
  'hs_object_id',
  'hs_call_direction',
  'hs_call_duration',
  'hs_call_status',
  'hs_call_source',
  'hs_call_from_number',
  'hs_call_to_number',
  'hs_createdate',
];

// Per-page result size. 100 is a conservative choice pending the real
// verification named above (point 1) — not HubSpot's confirmed max for
// this endpoint, just a value picked to keep any single response small
// while pagination behavior is still unverified. Passed explicitly so
// behavior doesn't silently change if this file's assumption about
// HubSpot's default ever turns out to be wrong.
const PAGE_SIZE = 100;

function authHeader() {
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) throw new Error('HUBSPOT_PRIVATE_APP_TOKEN is not set. See .env.example.');
  return 'Bearer ' + token;
}

// filterGroups are OR'd across groups, AND'd within one group (HubSpot's
// documented Search API semantics — see LIVE VERIFICATION point 4 above
// for what's not yet confirmed about it in practice). To match "VOIP
// source AND created in [fromIso, toIso) AND (from-number tracked OR
// to-number tracked)" this needs two groups, each carrying the shared
// source/date filters plus one half of the number match.
function buildTrackedNumberFilterGroups(trackedPhoneNumbers, fromIso, toIso) {
  const sharedFilters = [
    { propertyName: 'hs_call_source', operator: 'EQ', value: 'VOIP' },
    { propertyName: 'hs_createdate', operator: 'GTE', value: fromIso },
    { propertyName: 'hs_createdate', operator: 'LT', value: toIso },
  ];
  return [
    { filters: [...sharedFilters, { propertyName: 'hs_call_from_number', operator: 'IN', values: trackedPhoneNumbers }] },
    { filters: [...sharedFilters, { propertyName: 'hs_call_to_number', operator: 'IN', values: trackedPhoneNumbers }] },
  ];
}

// The one and only place an HTTP request is made to HubSpot in this file.
// Always this exact search shape against this exact endpoint. See the
// header's "CRITICAL" section for why there is no generic version of this.
async function searchVoipCallsPage(trackedPhoneNumbers, fromIso, toIso, after) {
  const body = {
    filterGroups: buildTrackedNumberFilterGroups(trackedPhoneNumbers, fromIso, toIso),
    properties: CALL_PROPERTIES,
    limit: PAGE_SIZE,
    sorts: [{ propertyName: 'hs_createdate', direction: 'ASCENDING' }],
  };
  if (after) body.after = after;

  const res = await fetch(HUBSPOT_BASE + CALLS_SEARCH_PATH, {
    method: 'POST', // A search/filter request, not a write — see header's "GET-only in effect" note.
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    throw new Error(`HubSpot rate limit hit (429). Retry-After: ${retryAfter || 'unknown'}. (Real rate-limit behavior on this endpoint is not yet independently verified — see this file's header.)`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HubSpot calls search failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Flattens one HubSpot search-result item (`{ id, properties: {...} }`)
// into the plain `{ hs_object_id, hs_call_direction, ... }` shape the rest
// of this codebase (lib/sync.js) reads — using HubSpot's own real property
// names throughout, matching the migration's own column comments field for
// field, rather than inventing a renamed shape here.
function flattenCallResult(result) {
  const props = result.properties || {};
  return {
    hs_object_id: props.hs_object_id || result.id,
    hs_call_direction: props.hs_call_direction || null,
    hs_call_duration: props.hs_call_duration || null,
    hs_call_status: props.hs_call_status || null,
    hs_call_source: props.hs_call_source || null,
    hs_call_from_number: props.hs_call_from_number || null,
    hs_call_to_number: props.hs_call_to_number || null,
    hs_createdate: props.hs_createdate || null,
  };
}

/**
 * Every VOIP-sourced HubSpot call (hs_call_source = 'VOIP' — never
 * INTEGRATIONS_PLATFORM, which is Aircall's own calls relayed into
 * HubSpot and must never be double-counted here, see this file's header)
 * whose from-number OR to-number is one of trackedPhoneNumbers, created in
 * [fromIso, toIso) — follows HubSpot's documented `paging.next.after`
 * cursor until exhausted (see LIVE VERIFICATION point 1 above for what's
 * not yet confirmed about that cursor in practice).
 *
 * @param {string[]} trackedPhoneNumbers - E.164 numbers, e.g.
 *   ["+18054101625"], read from call_stats_hubspot_native_numbers by the
 *   caller. Returns [] immediately, with no HubSpot request at all, if this
 *   is empty — there is nothing to search for.
 * @param {string} fromIso - ISO-8601 UTC start of the range (inclusive)
 * @param {string} toIso - ISO-8601 UTC end of the range (exclusive)
 * @returns {Promise<Array>} flattened call records (see flattenCallResult)
 */
async function listVoipCallsForNumbers(trackedPhoneNumbers, fromIso, toIso, { maxPages = 500 } = {}) {
  if (!trackedPhoneNumbers || trackedPhoneNumbers.length === 0) return [];

  let all = [];
  let after;
  let pages = 0;
  for (;;) {
    if (pages >= maxPages) {
      throw new Error(`HubSpot calls search hit the ${maxPages}-page safety cap without reaching the last page — aborting rather than silently returning a partial day.`);
    }
    const body = await searchVoipCallsPage(trackedPhoneNumbers, fromIso, toIso, after);
    all = all.concat((body.results || []).map(flattenCallResult));
    after = body.paging && body.paging.next ? body.paging.next.after : null;
    pages++;
    if (!after) break;
  }
  return all;
}

module.exports = { listVoipCallsForNumbers };
