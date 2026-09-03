/**
 * lib/leadsimple-connector.js
 * Talks to Rincon's real, live LeadSimple account (REST API, real production
 * data — not a sandbox). Scoped locally to this tool and to the
 * `leadsimple_application_screening` domain only, per this build's explicit
 * scope (leadsimple-property-brain-SPEC.md Section 9, Phase 2 — Delinquency
 * and Operations are later phases, not built here).
 *
 * ============================================================
 * CRITICAL — READ BEFORE ADDING ANYTHING TO THIS FILE
 * ============================================================
 * Same discipline as maintenance-history/lib/latchel-connector.js: every
 * function below issues a plain GET and NOTHING ELSE. No generic
 * "request(method, path)" helper on purpose — never add a way to pass an
 * HTTP method in from outside this file.
 * ============================================================
 *
 * ============================================================
 * ADDENDUM, 2026-09-02 — a second, unrelated consumer
 * ============================================================
 * The scope note above (this file is Application Screening-only) describes
 * the claims-extraction functions in this file, not the two generic,
 * domain-neutral helpers added at the bottom (`getProcessTypeIdByName`,
 * `listProcessesUpdatedSince`). Those exist for Property 360's LeadSimple
 * stage sync (property-360-SPEC.md, "Technical blocker" / "The fix" —
 * ../../property-360-SPEC.md; the sync job itself is
 * ../sync-property-stages.js), a completely separate build with its own
 * scope (stage name only, three process types — Delinquency, Lease Renewal,
 * Move Out — never Application Screening, never custom-field content).
 * Added here, instead of a second copy of leadsimpleGet/getAllPages in a
 * new file, per that build's own explicit instruction: reuse this file's
 * auth/pagination/rate-limit plumbing, don't duplicate it. Nothing above
 * this addendum changed — no existing function's behavior, signature, or
 * export was touched.
 * ============================================================
 *
 * ============================================================
 * LIVE VERIFICATION DONE FOR THIS BUILD (2026-08-26), against Rincon's real
 * account — recorded here because it contradicts what the spec assumed in
 * two material ways, and a future reader should not have to rediscover
 * this by trial and error:
 *
 * 1. NO STAGE-HISTORY ENDPOINT EXISTS. Checked the full swagger surface
 *    (59 paths, /rest/swagger_doc.json) — there is no history/activity/
 *    timeline resource anywhere in this API. A Process object carries only
 *    its CURRENT `stage` (a nested Stage object). Confirmed live against a
 *    real process: `stage.updated_at` belongs to the shared Stage
 *    DEFINITION (e.g. the "Completed" stage's own last-edit date), not to
 *    when THIS process entered it — it does not move with the process. So
 *    getApplicationScreeningProcess() below returns only "what stage is
 *    this process in right now," never "when did it enter that stage."
 *    extract-claims.js's stage_entered claim reflects this honestly
 *    (claim_date: null) rather than using stage.updated_at as if it meant
 *    something it doesn't.
 *
 * 2. NO PER-PROCESS FILTER EXISTS ON /tasks. Tried process_id, processes_id,
 *    process[id], process_ids[], deal_id as query params against a known
 *    real process ID — every one silently ignored (total_count identical,
 *    110,381, with or without). A Task object does carry a nested `process`
 *    reference (task.process.id), so tasks can only be matched to a known
 *    process by pulling a page of tasks and filtering client-side — same
 *    shape as this codebase's existing Latchel-job-to-ticket matching, not
 *    a new pattern. listTasksUpdatedSince() below is built for that:
 *    ongoing syncs bound the pull with `updated_since` (confirmed working);
 *    a one-time historical backfill (e.g. for the accuracy-test sample,
 *    where a case's tasks could predate any reasonable `updated_since`
 *    window) has no such bound and must scan from the top — expensive
 *    (up to ~552 pages at the 200/page cap), which is why
 *    listAllTasksFull() exists as its own clearly-separate, clearly-costly
 *    function rather than something a caller could reach for by accident.
 *
 * Confirmed working, not assumed: Bearer auth; `updated_since` (unix
 * seconds) on GET /processes and GET /process_types/{id}/processes
 * (resolves spec Open Item 5 — incremental pull is supported);
 * `include_custom_fields=true` on both the list AND singular process GET
 * (absent it, `custom_fields` isn't even present on the response, not just
 * empty); the `link` field on Process (LeadSimple's own opaque deep-link
 * URL — captured verbatim, never reconstructed, per spec Section 5).
 * ============================================================
 */

const LEADSIMPLE_BASE = process.env.LEADSIMPLE_API_BASE || 'https://api.leadsimple.com/rest';
const APPLICATION_SCREENING_PROCESS_TYPE_NAME = '01 Application Screening';

function apiKey() {
  const key = process.env.LEADSIMPLE_API_KEY;
  if (!key) throw new Error('LEADSIMPLE_API_KEY is not set. See .env.example.');
  return key;
}

// The one and only place an HTTP request is made to LeadSimple in this file.
// Always GET. Always this exact call shape.
async function leadsimpleGet(pathOrUrl) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : LEADSIMPLE_BASE + pathOrUrl;

  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey()}` },
  });

  if (res.status === 429) {
    // Confirmed live in swagger's own response headers for this API:
    // X-RateLimit-Metric-Error tells you which budget was exceeded
    // ("records" or "requests" — two separate budgets, 100 req/min and
    // 1,000 records/min per this build's task brief), X-RateLimit-Retry-
    // After tells you how long to wait. Surfaced in the thrown error so a
    // caller doing a long paginated pull (listAllTasksFull) can decide
    // whether to back off and retry rather than just failing the whole run.
    const metric = res.headers.get('x-ratelimit-metric-error');
    const retryAfter = res.headers.get('x-ratelimit-retry-after');
    const err = new Error(
      `LeadSimple rate limit hit (429) on metric "${metric || 'unknown'}". Retry-After: ${retryAfter || 'unknown'} seconds.`
    );
    err.rateLimited = true;
    err.retryAfterSeconds = retryAfter ? Number(retryAfter) : null;
    throw err;
  }
  if (res.status >= 500) {
    // Confirmed live 2026-08-28: a plain transient 500 from LeadSimple's own
    // server, mid-way through an otherwise-healthy request — the identical
    // request succeeded seconds later with no change on our end. Flagged
    // separately from the generic !res.ok case below so getAllPages can
    // retry it the way it already retries a 429, instead of losing an
    // entire long-running scan (listAllTasksFull, ~552 pages) to one blip.
    const text = await res.text().catch(() => '');
    const err = new Error(`LeadSimple GET ${pathOrUrl} failed: ${res.status} ${text.slice(0, 300)}`);
    err.serverError = true;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LeadSimple GET ${pathOrUrl} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// LeadSimple's pagination shape is `{ data: [...], meta: { page_number,
// total_count, total_pages, per_page } }` — a plain page-number scheme, not
// Latchel's `links.next` style. Simpler: just increment `page` until
// page_number >= total_pages. `delayMs` between pages lets a caller
// self-pace under the two rate-limit budgets (see leadsimpleGet's 429
// handling above) instead of relying on retry-after-the-fact.
async function getAllPages(basePath, { maxPages = 5000, perPage = 100, delayMs = 0, onPage = null } = {}) {
  const all = [];
  let page = 1;
  let totalPages = 1;
  const sep = basePath.includes('?') ? '&' : '?';
  do {
    const url = `${basePath}${sep}per_page=${perPage}&page=${page}`;
    let body;
    try {
      body = await leadsimpleGet(url);
    } catch (err) {
      // One bounded retry on a rate-limit hit — real accounts can trip this
      // even with correct self-pacing (e.g. another process sharing the
      // same key), and a single wait-and-retry is enough to recover
      // without masking a genuinely wrong pacing calculation (a second
      // consecutive 429 still throws and stops the run, loudly).
      if (err.rateLimited && err.retryAfterSeconds) {
        console.error(`[leadsimple-connector] Rate limited, waiting ${err.retryAfterSeconds + 1}s before retrying page ${page}...`);
        await sleep((err.retryAfterSeconds + 1) * 1000);
        body = await leadsimpleGet(url);
      } else if (err.serverError) {
        // Up to 3 bounded retries with backoff — confirmed live that a bare
        // 500 here is transient (identical request succeeded seconds
        // later), but with no Retry-After signal to time it precisely.
        // Losing an ~110-minute, ~552-page scan to one blip (as happened
        // 2026-08-28) is a worse failure mode than a few extra seconds of
        // backoff; three consecutive 500s on the same page still throws and
        // stops the run, loudly, rather than masking a real outage.
        let attempt = 0;
        let lastErr = err;
        while (attempt < 3) {
          const waitSeconds = 5 * (attempt + 1);
          console.error(`[leadsimple-connector] LeadSimple server error on page ${page}, retry ${attempt + 1}/3 in ${waitSeconds}s...`);
          await sleep(waitSeconds * 1000);
          try {
            body = await leadsimpleGet(url);
            lastErr = null;
            break;
          } catch (retryErr) {
            lastErr = retryErr;
            attempt++;
          }
        }
        if (lastErr) throw lastErr;
      } else {
        throw err;
      }
    }
    const items = body.data || [];
    all.push(...items);
    if (onPage) await onPage(items, body.meta || {});
    totalPages = (body.meta && body.meta.total_pages) || 1;
    page++;
    if (delayMs && page <= totalPages) await sleep(delayMs);
  } while (page <= totalPages && page <= maxPages);
  return all;
}

// Cached after first lookup — the process_type_id for "01 Application
// Screening" doesn't change within a run. Looked up by exact name rather
// than hardcoded as a bare UUID so this file stays self-documenting and
// doesn't silently break if the account's process types are ever
// reordered/recreated (unlikely, but a name lookup costs one cheap call
// and removes the need to trust a magic string).
let cachedProcessTypeId = null;
async function getApplicationScreeningProcessTypeId() {
  if (cachedProcessTypeId) return cachedProcessTypeId;
  const types = await getAllPages('/process_types', { perPage: 200 });
  const match = types.find(t => (t.name || '').trim() === APPLICATION_SCREENING_PROCESS_TYPE_NAME);
  if (!match) {
    throw new Error(
      `Could not find a LeadSimple process type named exactly "${APPLICATION_SCREENING_PROCESS_TYPE_NAME}". ` +
      `Found ${types.length} process types total — the account's naming may have changed; check manually before retrying.`
    );
  }
  cachedProcessTypeId = match.id;
  return cachedProcessTypeId;
}

/**
 * Application Screening processes updated on/after `sinceUnixSeconds`.
 * The ongoing "what changed since last run" pull, once this domain has a
 * real sync schedule (not built in this phase — see spec Section 9,
 * "90-day shadow mode" is explicitly NOT approved yet). Built now so the
 * accuracy-test runner and any future scheduled sync share one function.
 */
async function listApplicationScreeningProcessesUpdatedSince(sinceUnixSeconds) {
  const processTypeId = await getApplicationScreeningProcessTypeId();
  const path = `/processes?process_type_id=${processTypeId}&include_custom_fields=true&updated_since=${sinceUnixSeconds}`;
  return getAllPages(path, { perPage: 100 });
}

/**
 * One Application Screening process by ID, with custom fields included
 * (confirmed live: absent include_custom_fields=true, the `custom_fields`
 * key isn't present on the response at all). Defensively verifies the
 * fetched process actually IS an Application Screening case — a stray ID
 * belonging to a different process type must never be silently treated as
 * this domain's data (this domain's whole claim-vocabulary discipline,
 * spec Section 2, assumes every claim it writes really is an Application
 * Screening fact).
 */
async function getApplicationScreeningProcess(processId) {
  const processTypeId = await getApplicationScreeningProcessTypeId();
  const body = await leadsimpleGet(`/processes/${processId}?include_custom_fields=true`);
  const process = body.data || body;
  if (process.process_type_id !== processTypeId) {
    throw new Error(
      `LeadSimple process ${processId} is not an Application Screening process ` +
      `(process_type_id was "${process.process_type_id}", expected "${processTypeId}"). Refusing to extract claims for it.`
    );
  }
  return process;
}

/**
 * Tasks updated on/after `sinceUnixSeconds`, ACROSS THE WHOLE ACCOUNT —
 * there is no per-process filter (see header note #2). Caller must match
 * each returned task to a known process via `task.process && task.process.id`.
 * Fine for an ongoing "what changed recently" sync; NOT sufficient for a
 * historical backfill of an old process's tasks (use listAllTasksFull for
 * that, and only for that — see its own warning).
 */
// delayMs default of 6500ms between 100-record pages keeps this under the
// 1,000-records/min budget (100 records per 6s = 1,000/min exactly; 6.5s
// leaves margin) — the binding constraint here, not the 100-requests/min
// budget, which this pacing stays well under regardless. Bug found and
// fixed by actually running this against the real account (first attempt
// used 700ms, based on the requests/min budget alone, and hit a real 429
// within the first few pages).
async function listTasksUpdatedSince(sinceUnixSeconds, { delayMs = 6500 } = {}) {
  return getAllPages(`/tasks?updated_since=${sinceUnixSeconds}`, { perPage: 100, delayMs });
}

/**
 * Full, unfiltered scan of every task on the account, oldest data included.
 * ONLY use this for the one-time Section 8 accuracy-test backfill, where a
 * sampled case's tasks could predate any reasonable updated_since window
 * and there is no other way to reach them (confirmed above — no working
 * process filter exists at all). This is expensive on purpose-built rate
 * limits: 1,000 records/min means even at the 100-req/min request budget,
 * pulling all ~110K tasks at 100/page is bounded by the RECORDS budget,
 * not the request budget — roughly 110 minutes minimum, not the few
 * minutes a naive request-count estimate would suggest. `delayMs` paces
 * requests to stay under both budgets; `onPage` lets the caller filter and
 * discard each page immediately (matching only the known process IDs it
 * actually needs) instead of holding ~110K task objects in memory.
 */
async function listAllTasksFull({ matchProcessIds, onMatch, delayMs = 6500, perPage = 100, maxPages = 5000 } = {}) {
  const idSet = matchProcessIds instanceof Set ? matchProcessIds : new Set(matchProcessIds || []);
  let matched = 0;
  let scanned = 0;
  await getAllPages('/tasks', {
    perPage,
    delayMs,
    maxPages,
    onPage: async (items) => {
      scanned += items.length;
      for (const task of items) {
        const pid = task.process && task.process.id;
        if (pid && idSet.has(pid)) {
          matched++;
          if (onMatch) await onMatch(task);
        }
      }
    },
  });
  return { scanned, matched };
}

// Cached after first lookup, same reasoning as cachedProcessTypeId — the
// Application Screening process type's own step IDs don't change within a
// run. /tasks has no per-process filter (confirmed above), but it DOES
// support step_ids[] (confirmed live via the account's full swagger spec,
// 2026-08-28 — a parameter neither this file's original research nor its
// own header comment above tried). A step belongs to exactly one process
// type, so filtering /tasks by every step ID this process type owns scopes
// the scan to only tasks that could possibly belong to an Application
// Screening process — narrower than "everything," without needing a date
// bound that a wide-spanning sample (see run-accuracy-test-sample.js's own
// accuracy-sample use case) can't safely use anyway.
let cachedApplicationScreeningStepIds = null;
async function listApplicationScreeningStepIds() {
  if (cachedApplicationScreeningStepIds) return cachedApplicationScreeningStepIds;
  const processTypeId = await getApplicationScreeningProcessTypeId();
  const stages = await getAllPages(`/process_types/${processTypeId}/stages`, { perPage: 200 });
  const stepIds = [];
  for (const stage of stages) {
    const steps = await getAllPages(`/process_types/${processTypeId}/stages/${stage.id}/steps`, { perPage: 200 });
    for (const step of steps) stepIds.push(step.id);
  }
  cachedApplicationScreeningStepIds = stepIds;
  return stepIds;
}

/**
 * Same purpose and shape as listAllTasksFull, scoped to Application
 * Screening's own step_ids instead of every task on the account.
 * Live-confirmed 2026-08-28 against Rincon's real account: this cuts the
 * pool from ~110,381 tasks account-wide to 15,267 — no date bound, correct
 * for a sample spanning the account's full history (as the Section 8
 * accuracy sample's real case ages turned out to), and roughly 7x faster
 * than listAllTasksFull for exactly the case that function's own docstring
 * says to reach for it. Prefer this over listAllTasksFull whenever every
 * matched process is confirmed Application Screening (true for
 * run-accuracy-test-sample.js today) — reach for listAllTasksFull only if
 * a future caller ever needs tasks across process types this scoping
 * would exclude.
 */
async function listApplicationScreeningTasksFull({ matchProcessIds, onMatch, delayMs = 6500, perPage = 100, maxPages = 5000 } = {}) {
  const idSet = matchProcessIds instanceof Set ? matchProcessIds : new Set(matchProcessIds || []);
  const stepIds = await listApplicationScreeningStepIds();
  const stepParams = stepIds.map(id => `step_ids[]=${encodeURIComponent(id)}`).join('&');
  let matched = 0;
  let scanned = 0;
  await getAllPages(`/tasks?${stepParams}&updated_since=1`, {
    perPage,
    delayMs,
    maxPages,
    onPage: async (items) => {
      scanned += items.length;
      for (const task of items) {
        const pid = task.process && task.process.id;
        if (pid && idSet.has(pid)) {
          matched++;
          if (onMatch) await onMatch(task);
        }
      }
    },
  });
  return { scanned, matched };
}

// Cached after first lookup, keyed by exact process-type name — same
// reasoning as cachedProcessTypeId above (Application Screening's own
// single-name cache), generalized to more than one name since this
// function's caller (sync-property-stages.js — see ADDENDUM at the top of
// this file) needs three: Delinquency, Lease Renewal, Move Out.
const cachedProcessTypeIdsByName = new Map();

/**
 * Generic version of getApplicationScreeningProcessTypeId above, taking
 * the exact process type name as an argument instead of assuming
 * Application Screening. Same exact-match-then-throw-loudly shape,
 * same reasoning (self-documenting name lookup over a hardcoded UUID that
 * would silently break if the account's process types were ever
 * reordered/recreated).
 *
 * `.trim()` on both sides of the comparison is required, not defensive
 * paranoia — confirmed live 2026-09-02 against this account's real
 * /process_types response: several of this account's own process type
 * names carry inconsistent trailing whitespace (e.g. "002 Delinquency "
 * with a trailing space). getApplicationScreeningProcessTypeId above only
 * trims the LeadSimple side because its one caller already knows to pass
 * an exact, pre-trimmed constant; this version trims both sides so a
 * caller doesn't have to know that quirk exists.
 */
async function getProcessTypeIdByName(exactName) {
  const key = exactName.trim();
  if (cachedProcessTypeIdsByName.has(key)) return cachedProcessTypeIdsByName.get(key);
  const types = await getAllPages('/process_types', { perPage: 200 });
  const match = types.find(t => (t.name || '').trim() === key);
  if (!match) {
    throw new Error(
      `Could not find a LeadSimple process type named exactly "${exactName}". ` +
      `Found ${types.length} process types total — the account's naming may have changed; check manually before retrying.`
    );
  }
  cachedProcessTypeIdsByName.set(key, match.id);
  return match.id;
}

/**
 * Processes of a given type, updated on/after sinceUnixSeconds. Generic
 * version of listApplicationScreeningProcessesUpdatedSince above, taking
 * processTypeId directly instead of resolving Application Screening's own
 * ID internally.
 *
 * include_custom_fields is deliberately OMITTED here, unlike the
 * Application Screening version — this function's only known caller
 * (sync-property-stages.js) is scoped to stage-name-only content, never
 * custom-field content (that build's own explicit v1 boundary, per
 * property-360-SPEC.md's LeadSimple section). Not requesting custom
 * fields at all is one less place that boundary could accidentally be
 * crossed later by a future edit to this function or its caller.
 *
 * No delayMs pacing, matching listApplicationScreeningProcessesUpdatedSince
 * above's own precedent — an updated_since-bounded /processes pull is
 * confirmed live (2026-09-02) to return a small page count for a normal
 * nightly window (a few hundred records at most across all three v1
 * process types), unlike the account-wide /tasks pulls elsewhere in this
 * file that do need self-pacing.
 */
async function listProcessesUpdatedSince(processTypeId, sinceUnixSeconds) {
  const path = `/processes?process_type_id=${processTypeId}&updated_since=${sinceUnixSeconds}`;
  return getAllPages(path, { perPage: 100 });
}

module.exports = {
  getApplicationScreeningProcessTypeId,
  listApplicationScreeningProcessesUpdatedSince,
  getApplicationScreeningProcess,
  listTasksUpdatedSince,
  listAllTasksFull,
  listApplicationScreeningStepIds,
  listApplicationScreeningTasksFull,
  getProcessTypeIdByName,
  listProcessesUpdatedSince,
};
