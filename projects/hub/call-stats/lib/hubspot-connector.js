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

const { PROSPECT_LIFECYCLE_STAGES } = require('./sales-classification-config');

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

// ============================================================
// PROSPECT CONTACT LOOKUP BY PHONE (added 2026-09-12)
// ============================================================
// Everything below exists to answer ONE question for the sales-vs-
// operational classification (SALES-VS-OPERATIONAL-CLASSIFICATION-SPEC.md
// Design Decision 17): for a batch of phone keys, which of them are held
// by at least one contact carrying evidence a HUMAN at Rincon treated the
// number as a prospect — a lifecycle stage above the default, or an
// associated deal.
//
// It follows this file's CRITICAL header rule exactly: one new
// narrowly-named read, one fixed request shape, one fixed endpoint, no way
// to pass an HTTP method or a different path in from outside. Same
// "GET-only in effect" POST as searchVoipCallsPage above — a search, never
// a write. Nothing here creates, updates, deletes, or associates anything.
//
// ============================================================
// LIVE VERIFICATION — 2026-09-12, real HUBSPOT_PRIVATE_APP_TOKEN
// ============================================================
// These four findings are the reason this function is shaped the way it is
// rather than the way the spec described. Each was measured, not assumed.
//
//   1. *** THE SPEC'S PLAN DOES NOT WORK AS WRITTEN. *** Design Decision
//      18 says to normalize both sides and batch an IN filter against the
//      raw `phone` / `mobilephone` fields. An IN filter matches a stored
//      string LITERALLY, and those fields hold whatever a human typed:
//      "+16614870059", "Mobile: (805) 479-2229", "(805) 749-2638 ext.
//      2204", "805.288.1119". Measured:
//          phone IN ["6614870059"]  -> 0 results
//          phone IN ["+16614870059"] -> 1 result
//      A normalized key can never match the raw field except by luck. Built
//      as specified, this would have returned almost nothing and reported
//      it as "no prospect calls," indistinguishably from a quiet day.
//
//   2. The fix, and it resolves spec Open Item 19 with a YES: this portal
//      DOES expose HubSpot's calculated searchable phone properties, and
//      they ARE filterable under crm.objects.contacts.read —
//      hs_searchable_calculated_phone_number (8,868 contacts populated)
//      and hs_searchable_calculated_mobile_number (4,059). HubSpot does
//      the normalization itself, and does it better than the rule in
//      phone-key.js could: it correctly reduced "(805) 749-2638 ext. 2204"
//      to 8057492638 and "Mobile: (805) 479-2229" to 8054792229, both of
//      which a strip-non-digits rule gets wrong or mangles.
//      Coverage loss from preferring them is negligible and was measured
//      rather than hoped at: 40 of 8,908 contacts (0.45%) have a `phone`
//      but no calculated phone, and 10 of 4,069 for mobile — unparseable
//      junk in the raw field, which is precisely the population an exact
//      IN against the raw field would also have failed to match.
//
//   3. *** BOTH properties are required, not one. *** They are separate
//      fields, and a number entered only as a mobile is invisible to a
//      phone-only search. Hence two filterGroups (OR'd), not one.
//
//   4. The IN list cap on this endpoint is EXACTLY 100, and HubSpot says
//      so in the error rather than truncating silently: a 200-value list
//      returns 400 "too many IN list values (count: 200, max allowed:
//      100)". Spec Open Item 20 is answered. CHUNK_SIZE below is 100 —
//      the real, stated maximum, not a guess. A silent truncation here
//      would have dropped whole batches of numbers into "not matched."
// ============================================================

const CONTACTS_SEARCH_PATH = '/crm/v3/objects/contacts/search';

// HubSpot's hard limit on IN list length for this endpoint, stated by
// HubSpot's own 400 response (LIVE VERIFICATION #4). Not a conservative
// guess — the measured maximum.
const PHONE_IN_CHUNK_SIZE = 100;

// The two calculated searchable phone properties, which is what an IN
// filter can actually match against (LIVE VERIFICATION #1/#2/#3).
const SEARCHABLE_PHONE_PROPERTIES = [
  'hs_searchable_calculated_phone_number',
  'hs_searchable_calculated_mobile_number',
];

// Deliberately NARROW. Everything here is needed to decide the
// classification or to print the Design Decision 19 precedence cascade in
// the diagnostic. Notably absent: email, address, company, and every other
// contact field. Design Decision 23 keeps outside people's data out of
// Supabase; requesting fewer properties keeps it out of the process
// memory and the HTTP response as well. firstname/lastname are read ONLY
// so the operator-run diagnostic can name a record on a terminal, and are
// never returned to the sync path — see listQualifyingPhoneKeys below.
const CONTACT_PROPERTIES = [
  'hs_object_id',
  'lifecyclestage',
  'num_associated_deals',
  'createdate',
  'firstname',
  'lastname',
  'hs_searchable_calculated_phone_number',
  'hs_searchable_calculated_mobile_number',
];

// One page of one fixed search: "contacts whose calculated phone OR
// calculated mobile is in this chunk of keys." The prospect/deal test is
// deliberately NOT pushed into the filter — see searchContactsByPhoneKeys.
async function searchContactsByPhonePage(phoneKeyChunk, after) {
  const body = {
    // OR'd across groups, AND'd within one — the same documented semantics
    // buildTrackedNumberFilterGroups above relies on. One group per phone
    // property, because a contact may carry the number in either field.
    filterGroups: SEARCHABLE_PHONE_PROPERTIES.map(propertyName => ({
      filters: [{ propertyName, operator: 'IN', values: phoneKeyChunk }],
    })),
    properties: CONTACT_PROPERTIES,
    limit: PAGE_SIZE,
    // Stable sort so a multi-page result can't repeat or skip a record
    // between pages. hs_object_id is immutable; hs_lastmodifieddate is NOT
    // usable here because the Aircall exhaust integration keeps touching
    // records, so it moves underneath a paging cursor mid-run.
    sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
  };
  if (after) body.after = after;

  const res = await fetch(HUBSPOT_BASE + CONTACTS_SEARCH_PATH, {
    method: 'POST', // A search/filter request, not a write — see header's "GET-only in effect" note.
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    throw new Error(`HubSpot rate limit hit (429) on contacts search. Retry-After: ${retryAfter || 'unknown'}.`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HubSpot contacts search failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Every contact holding any of `phoneKeys`, chunked to HubSpot's real
 * IN-list maximum and paged to exhaustion.
 *
 * *** WHY THE QUALIFYING TEST IS NOT PUSHED INTO THE HUBSPOT FILTER. ***
 * It could be — adding a lifecyclestage IN filter would return fewer
 * records. It is evaluated in JavaScript instead, on purpose, because the
 * classification rule is set-wide (Design Decision 19: "does ANY contact
 * matching this key qualify"). Filtering server-side returns only the
 * qualifying records and therefore destroys the information needed to see
 * that a key ALSO matched 57 non-qualifying ones — which is exactly the
 * switchboard case phone-key.js warns about, and exactly what the
 * diagnostic has to be able to show. The volume is small (a night's
 * distinct numbers), so the saving would be real but tiny, and it would
 * buy a rule that cannot be audited.
 *
 * @param {string[]} phoneKeys - canonical keys from lib/phone-key.js.
 *   Returns [] with NO HubSpot request at all when empty.
 * @returns {Promise<Array>} flattened contact records
 */
async function searchContactsByPhoneKeys(phoneKeys, { maxPagesPerChunk = 200 } = {}) {
  if (!phoneKeys || phoneKeys.length === 0) return [];

  const all = [];
  for (let i = 0; i < phoneKeys.length; i += PHONE_IN_CHUNK_SIZE) {
    const chunk = phoneKeys.slice(i, i + PHONE_IN_CHUNK_SIZE);
    let after;
    let pages = 0;
    for (;;) {
      if (pages >= maxPagesPerChunk) {
        throw new Error(`HubSpot contacts search hit the ${maxPagesPerChunk}-page safety cap on one chunk without reaching the last page — aborting rather than silently returning a partial set. A partial set would read as "these numbers matched nothing," i.e. as operational calls.`);
      }
      const body = await searchContactsByPhonePage(chunk, after);
      for (const result of (body.results || [])) {
        const props = result.properties || {};
        all.push({
          hs_object_id: props.hs_object_id || result.id,
          lifecyclestage: props.lifecyclestage || null,
          num_associated_deals: Number(props.num_associated_deals || 0),
          createdate: props.createdate || null,
          firstname: props.firstname || null,
          lastname: props.lastname || null,
          // DEDUPED, and that is not cosmetic. A contact very often holds
          // the SAME number in both `phone` and `mobilephone`, so both
          // calculated properties come back with the identical value.
          // Left duplicated, a caller that groups contacts by key counts
          // that one contact twice — which is harmless for the qualifying
          // Set below, but silently inflates the diagnostic's
          // contacts-per-number figure and would fire the SWITCHBOARD
          // warning on ordinary two-field contacts.
          phone_keys: [...new Set(
            SEARCHABLE_PHONE_PROPERTIES
              .map(p => props[p])
              .filter(Boolean)
              .map(String)
          )],
        });
      }
      after = body.paging && body.paging.next ? body.paging.next.after : null;
      pages++;
      if (!after) break;
    }
  }
  return all;
}

/**
 * THE function the nightly sync calls. Takes phone keys, returns the SET of
 * keys carrying qualifying prospect evidence — and nothing else.
 *
 * *** THIS RETURN TYPE IS THE GOVERNANCE BOUNDARY, NOT A CONVENIENCE. ***
 * Design Decision 23 requires that no outside individual's name, number or
 * HubSpot contact ID reaches Supabase, and states plainly that this is "a
 * property of the code, not a policy" — one ordinary-looking debugging
 * change away from being gone. Returning a Set of phone keys rather than
 * the matched contact records is what makes that property hold at the
 * narrowest point: the sync path is never handed a contact ID or a name,
 * so it cannot persist one even by accident.
 *
 * If you are here to add the matched contact to the return value so it can
 * be stored: DON'T. That single change moves this build across CLAUDE.md's
 * compliance-build line and requires Asimov. The troubleshooting need it
 * would serve is already met by diagnose-sales-classification.js, which
 * calls searchContactsByPhoneKeys() directly, prints to a terminal, and
 * persists nothing.
 *
 * @param {string[]} phoneKeys - canonical keys, Rincon's own numbers
 *   ALREADY EXCLUDED by the caller (lib/phone-key.js explains why that
 *   exclusion is load-bearing and not tidiness).
 * @returns {Promise<Set<string>>} the subset of phoneKeys that qualify
 */
async function listQualifyingPhoneKeys(phoneKeys) {
  const contacts = await searchContactsByPhoneKeys(phoneKeys);
  const qualifying = new Set();
  // Only keys we actually ASKED about may be returned. HubSpot matched on
  // its own calculated value, and a contact can carry a second number in
  // its other phone field — that second number was never looked up and
  // must not be marked qualifying off the back of this contact.
  const requested = new Set(phoneKeys);
  for (const c of contacts) {
    if (!contactQualifies(c)) continue;
    for (const key of c.phone_keys) {
      if (requested.has(key)) qualifying.add(key);
    }
  }
  return qualifying;
}

/**
 * Design Decision 17's rule against one contact: a prospect lifecycle
 * stage, OR at least one associated deal. Exported so the diagnostic and
 * any test apply the IDENTICAL predicate rather than a second copy that
 * could drift — the same reasoning lib/sync.js gives for exporting
 * CHARGEABLE_MISS_REASON.
 */
function contactQualifies(contact) {
  if (!contact) return false;
  if (PROSPECT_LIFECYCLE_STAGES.includes(contact.lifecyclestage)) return true;
  // See sales-classification-config.js on why this is a contact-level deal
  // count and not a per-deal pipeline check.
  if (Number(contact.num_associated_deals || 0) > 0) return true;
  return false;
}

module.exports = { listVoipCallsForNumbers, listQualifyingPhoneKeys, searchContactsByPhoneKeys, contactQualifies };
