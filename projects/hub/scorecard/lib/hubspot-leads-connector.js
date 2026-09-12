/**
 * scorecard/lib/hubspot-leads-connector.js
 * The ONLY place the Scoreboard talks to Rincon's real, live HubSpot account.
 *
 * ============================================================
 * CRITICAL — READ BEFORE ADDING ANYTHING TO THIS FILE
 * ============================================================
 * Same rule, verbatim, as call-stats/lib/hubspot-connector.js, and this is a
 * deliberately SEPARATE module rather than an addition to that one (spec
 * Design Decision 37): that file's narrowness is its whole safety property,
 * and widening it to read leads, deals and tasks would couple two tools that
 * otherwise share nothing.
 *
 * There is NO generic `request(method, path, body)` helper here, on purpose.
 * Every function below is one fixed request shape against one fixed endpoint,
 * and every one of them only ever asks HubSpot to find and return records
 * that already exist. Nothing in this file creates, updates, deletes or
 * associates anything in Rincon's HubSpot. HubSpot's CRM Search API is
 * POST-shaped by HubSpot's own design (filtering is not exposed as a plain
 * GET) — that POST is a real HTTP verb this file sends and it is still
 * "GET-only in effect", exactly as the Call Stats connector already
 * documents.
 *
 * If a future metric needs a new HubSpot read, add a new narrowly-named
 * function with its own fixed shape. Never add a way to pass an HTTP method,
 * an endpoint, or a raw filter body in from outside this file.
 *
 * Metric 10 (lost deals added to sequence, 2026-09-12) followed exactly
 * that instruction rather than starting a sibling module:
 * `listTasksForSequenceIds()` below reads the SAME object (tasks), through
 * the SAME infra (searchAllPages, TASK_PROPERTIES, the rate-limit and
 * pagination handling) that listTasksCompletedBetween() and
 * listAutomationTasksCreatedSince() already use one screen up — it differs
 * from them only in its filter. A sibling module would duplicate all of
 * that machinery for a metric that lands on the same Scoreboard page as
 * the other five and needs no isolation from them. Design Decision 37's
 * separation from call-stats/lib/hubspot-connector.js is a separation
 * between two DIFFERENT domains (call data vs. leads/deals/tasks); this is
 * one more narrow read inside the domain this file already owns.
 * ============================================================
 *
 * ============================================================
 * THE TENANT/VENDOR EXCLUSION LIVES HERE, AND ONLY HERE
 * ============================================================
 * Asimov's condition on this build, and the mechanism behind Mason's
 * conditional clearance (spec Design Decision 34): no lead disqualified as
 * `Tenants` or `Vendor` may reach any metric. It is applied ONCE, in
 * dropExcludedLeads() below, which every lead-returning function in this
 * file passes its results through. It is deliberately NOT applied inside
 * each metric: a rule repeated in five places is a rule that will one day be
 * in four.
 *
 * Every lead-returning function also reports how many records it dropped, so
 * the number is visible rather than assumed.
 *
 * ============================================================
 * LIVE VERIFICATION — done 2026-09-12 against the real
 * HUBSPOT_PRIVATE_APP_TOKEN. Figures are what this file actually returned.
 * ============================================================
 *   1. The LEAD object uses `hs_createdate`, NOT `createdate`. A search
 *      filtering leads on `createdate` returns HTTP 400 on this portal — it
 *      does not silently return zero, which is the friendlier of the two
 *      failures but is not something to rely on. Leads:2026-06-01..09-07
 *      returned 121 records on `hs_createdate`.
 *   2. Deals use `createdate` (the ordinary one) and every deal created in
 *      the 18 weeks from 2026-05-11 sits in pipeline `default` — 0 outside
 *      it. That is checked on every run rather than assumed; see
 *      searchDealsCreatedBetween's `outsideDefaultPipeline` return value.
 *   3. The stage-entry date property is
 *      `hs_v2_date_entered_qualified_stage_id_233247981`. It is READABLE but
 *      NOT SEARCHABLE — a filter on it returns HTTP 400 — which is why
 *      listQualifiedLeads() pulls the stage and filters on the date in
 *      memory. Requesting it under the hyphenated stage-id spelling returns
 *      the records with the property silently ABSENT; see
 *      LEAD_ENTERED_QUALIFIED_PROPERTY in config.js.
 *   4. Task->contact associations are read through
 *      /crm/v4/associations/tasks/contacts/batch/read, 100 ids per call.
 *      Confirmed working and read-only (a `batch/read`, not `batch/create`).
 *   5. Pagination IS exercised here for real, unlike the Call Stats
 *      connector's own still-unverified cursor logic (its LIVE VERIFICATION
 *      point 3): the past-lead population is 411 records and the qualified
 *      population 364, both of which cross the 100-record page size several
 *      times. The loop below additionally refuses to follow a cursor it has
 *      already seen, so a server-side cursor bug becomes a thrown error
 *      rather than an infinite loop.
 *   6. /crm/v3/owners?email= resolves kristen@rinconmanagement.com to owner
 *      id 384054033. Resolved at run time, never hardcoded — see
 *      resolveOwnerIdByEmail().
 * ============================================================
 */

const HUBSPOT_BASE = process.env.HUBSPOT_API_BASE || 'https://api.hubapi.com';

const LEADS_SEARCH_PATH = '/crm/v3/objects/leads/search';
const DEALS_SEARCH_PATH = '/crm/v3/objects/deals/search';
const TASKS_SEARCH_PATH = '/crm/v3/objects/tasks/search';
const TASK_CONTACT_ASSOCIATIONS_PATH = '/crm/v4/associations/tasks/contacts/batch/read';
const OWNERS_PATH = '/crm/v3/owners';
const FLOW_PATH_PREFIX = '/automation/v4/flows/';

const PAGE_SIZE = 100;
const ASSOCIATION_BATCH_SIZE = 100;
const MAX_PAGES = 200;

// Disqualification reasons that remove a lead from every count. Rincon added
// both of these to HubSpot's stock list by hand.
//
// Dated 2026-09-12. Measured before shipping and recorded honestly: across
// the 15 weeks 2026-06-01..2026-09-07 this rule removed ZERO leads from ZERO
// denominators. All 53 flagged leads in the object are already Unqualified
// and the most recent was resolved 2026-04-22. It is forward protection, not
// a filter doing daily work. (COMMITTED-NOT-BUILT.md §0a corrects the
// governance write-up that called it "load-bearing".)
const EXCLUDED_DISQUALIFICATION_REASONS = ['Tenants', 'Vendor'];

const LEAD_PROPERTIES = [
  'hs_object_id',
  'hs_createdate',
  'hs_pipeline_stage',
  'hs_primary_contact_id',
  'hs_lead_disqualification_reason',
  // Underscores and a numeric suffix, NOT the hyphenated stage id. See
  // LEAD_ENTERED_QUALIFIED_PROPERTY in config.js — getting this wrong makes
  // past-lead conversions read a plausible zero forever.
  'hs_v2_date_entered_qualified_stage_id_233247981',
];

const DEAL_PROPERTIES = ['hs_object_id', 'createdate', 'pipeline'];

const TASK_PROPERTIES = [
  'hs_object_id',
  'hs_createdate',
  'hs_task_completion_date',
  'hs_object_source_label',
  'hs_object_source_detail_1',
  'hs_object_source_id',
  'hs_task_sequence_id',
  // Metric 10's per-PERSON key. NOT hs_object_source_id's enrollment id
  // (used elsewhere in this file for workflow enrollments) — that one is
  // per-TASK and overcounts a multi-touch sequence enrollment as several
  // enrollments. Confirmed live 2026-09-12.
  'hs_task_sequence_step_enrollment_contact_id',
  'hubspot_owner_id',
];

function authHeader() {
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) throw new Error('HUBSPOT_PRIVATE_APP_TOKEN is not set. See .env.example.');
  return 'Bearer ' + token;
}

// HubSpot's search endpoints rate-limit at four requests a second per
// portal, and this build makes hundreds of them in a row when it walks
// several weeks. A 429 is therefore an expected, recoverable condition here,
// not an error — unlike in the Call Stats connector, whose defensive guard
// had never actually fired because that job makes a handful of requests a
// night. Hit live on the first full verification run, so this is measured
// behaviour rather than precaution.
//
// Bounded on purpose: after RATE_LIMIT_MAX_RETRIES it gives up and throws,
// so a genuinely exhausted daily quota surfaces as a failed week that writes
// no row, rather than a job that retries silently for an hour.
const RATE_LIMIT_MAX_RETRIES = 6;
const RATE_LIMIT_BASE_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hubspotJson(path, init, what) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(HUBSPOT_BASE + path, init);

    if (res.status === 429) {
      if (attempt >= RATE_LIMIT_MAX_RETRIES) {
        const retryAfter = res.headers.get('retry-after');
        throw new Error(`HubSpot rate limit hit (429) on ${what} and did not clear after ${RATE_LIMIT_MAX_RETRIES} retries. Retry-After: ${retryAfter || 'unknown'}.`);
      }
      const retryAfterSeconds = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HubSpot ${what} failed: ${res.status} ${text.slice(0, 300)}`);
    }
    return res.json();
  }
}

// One page of a CRM search. Every search in this file goes through here, and
// the CALLER supplies only an object name, a filter list and a property list
// — never a method, never a path, never a raw body.
async function searchPage(objectPath, what, filters, properties, sortProperty, after) {
  const body = {
    filterGroups: [{ filters }],
    properties,
    limit: PAGE_SIZE,
    sorts: [{ propertyName: sortProperty, direction: 'ASCENDING' }],
  };
  if (after) body.after = after;

  return hubspotJson(
    objectPath,
    {
      method: 'POST', // A search, not a write — see this file's CRITICAL header.
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    what
  );
}

// Follows HubSpot's `paging.next.after` cursor to exhaustion. Refuses to
// follow a cursor it has already returned once: the Call Stats connector's
// cursor logic has never been proven at a page boundary, and an endpoint
// that hands back the same cursor forever would otherwise spin until the
// page-cap error, silently accumulating duplicates until it did.
async function searchAllPages(objectPath, what, filters, properties, sortProperty) {
  const out = [];
  const seenCursors = new Set();
  let after;
  let pages = 0;

  for (;;) {
    if (pages >= MAX_PAGES) {
      throw new Error(`HubSpot ${what} hit the ${MAX_PAGES}-page safety cap without reaching the last page — aborting rather than returning a partial result.`);
    }
    const body = await searchPage(objectPath, what, filters, properties, sortProperty, after);
    for (const result of body.results || []) out.push({ id: String(result.id), properties: result.properties || {} });

    const next = body.paging && body.paging.next ? body.paging.next.after : null;
    pages++;
    if (!next) break;
    if (seenCursors.has(next)) {
      throw new Error(`HubSpot ${what} returned a paging cursor it had already returned — refusing to loop. Got ${out.length} records over ${pages} pages.`);
    }
    seenCursors.add(next);
    after = next;
  }
  return out;
}

// ─── The exclusion, applied in exactly one place ─────────────────────────
// Returns { leads, excludedCount }. Reason values are trimmed before
// comparison: eight workflow and sequence names in this portal's live data
// carry leading or trailing whitespace, so untrimmed string equality is not
// safe anywhere in this codebase.
function dropExcludedLeads(rows) {
  const leads = [];
  let excludedCount = 0;
  for (const row of rows) {
    const reason = (row.properties.hs_lead_disqualification_reason || '').trim();
    if (EXCLUDED_DISQUALIFICATION_REASONS.includes(reason)) {
      excludedCount++;
      continue;
    }
    leads.push(row);
  }
  return { leads, excludedCount };
}

/**
 * Leads CREATED in [fromIso, toIso) — the denominator of metric 1.
 *
 * `hs_createdate`, not `createdate`. See LIVE VERIFICATION point 1.
 *
 * @returns {Promise<{leads: Array, excludedCount: number}>}
 */
async function listLeadsCreatedBetween(fromIso, toIso) {
  const rows = await searchAllPages(
    LEADS_SEARCH_PATH,
    'leads-created search',
    [
      { propertyName: 'hs_createdate', operator: 'GTE', value: fromIso },
      { propertyName: 'hs_createdate', operator: 'LT', value: toIso },
    ],
    LEAD_PROPERTIES,
    'hs_createdate'
  );
  return dropExcludedLeads(rows);
}

/**
 * Deals CREATED in [fromIso, toIso) — the numerator of metric 1.
 *
 * Metric 1's numerator rests on an assumption nothing in HubSpot enforces: a
 * deal implies a discovery call happened, because "Discovery call complete"
 * is the first stage of the only pipeline in use. If a second pipeline
 * appears, or a stage is inserted before that one, the metric silently
 * changes meaning while continuing to produce a plausible number. So the
 * pipeline filter is explicit and the residue is COUNTED rather than
 * discarded — `outsideDefaultPipeline` is surfaced on the page.
 *
 * @returns {Promise<{deals: Array, outsideDefaultPipeline: number}>}
 */
async function listDealsCreatedBetween(fromIso, toIso) {
  const rows = await searchAllPages(
    DEALS_SEARCH_PATH,
    'deals-created search',
    [
      { propertyName: 'createdate', operator: 'GTE', value: fromIso },
      { propertyName: 'createdate', operator: 'LT', value: toIso },
    ],
    DEAL_PROPERTIES,
    'createdate'
  );

  const deals = [];
  let outsideDefaultPipeline = 0;
  for (const row of rows) {
    if ((row.properties.pipeline || '').trim() === 'default') deals.push(row);
    else outsideDefaultPipeline++;
  }
  return { deals, outsideDefaultPipeline };
}

/**
 * Tasks COMPLETED in [fromIso, toIso), across all owners.
 * `hs_task_completion_date` is the week key — a task created in March and
 * completed in September is a September touch.
 */
async function listTasksCompletedBetween(fromIso, toIso) {
  return searchAllPages(
    TASKS_SEARCH_PATH,
    'tasks-completed search',
    [
      { propertyName: 'hs_task_completion_date', operator: 'GTE', value: fromIso },
      { propertyName: 'hs_task_completion_date', operator: 'LT', value: toIso },
    ],
    TASK_PROPERTIES,
    'hs_task_completion_date'
  );
}

/**
 * Every automation-created task whose task record was CREATED on or after
 * `sinceIso`. Used to reconstruct whole enrollments for the sequence-depth
 * median: an enrollment's tasks span several weeks, so the week's own tasks
 * are not enough to count how deep it went.
 */
async function listAutomationTasksCreatedSince(sinceIso) {
  return searchAllPages(
    TASKS_SEARCH_PATH,
    'automation-tasks search',
    [
      { propertyName: 'hs_object_source_label', operator: 'EQ', value: 'AUTOMATION_PLATFORM' },
      { propertyName: 'hs_createdate', operator: 'GTE', value: sinceIso },
    ],
    TASK_PROPERTIES,
    'hs_createdate'
  );
}

/**
 * Every task belonging to one of the given HubSpot sequences
 * (`hs_task_sequence_id` IN sequenceIds), across the sequence's whole life —
 * metric 10, lost deals added to sequence.
 *
 * Unbounded by date, on purpose and unlike the other task reads in this
 * file: the three tracked sequences hold roughly 1,300 tasks combined
 * (measured 2026-09-12), comfortably inside one bounded page walk, and the
 * metric's own rule — count a contact once across ALL tracked sequences,
 * keyed on the week they were FIRST seen — requires comparing every task
 * against every earlier one for the same contact. A windowed read risks
 * missing the earlier appearance and double-counting a later week as a
 * fresh enrollment.
 *
 * Filtered on `hs_task_sequence_id`, never on a sequence's display name —
 * see TRACKED_SEQUENCES in config.js: sequence 646033139 carried two names
 * across its life ("Lost Leads - Kristen's", then "Old Lost Leads Sequence
 * - do not use") with the same id throughout, the identical trap already
 * hit twice today on workflows.
 */
async function listTasksForSequenceIds(sequenceIds) {
  return searchAllPages(
    TASKS_SEARCH_PATH,
    'sequence-tasks search',
    [{ propertyName: 'hs_task_sequence_id', operator: 'IN', values: sequenceIds }],
    TASK_PROPERTIES,
    'hs_createdate'
  );
}

/**
 * Every lead currently sitting in one of the given pipeline stages.
 * Used for the past-lead population (stages 201593994 "Back to Marketing for
 * Nurture" and 201593995 "No Response" — 411 leads as of 2026-09-12).
 */
async function listLeadsInStages(stageIds) {
  const rows = await searchAllPages(
    LEADS_SEARCH_PATH,
    'leads-by-stage search',
    [{ propertyName: 'hs_pipeline_stage', operator: 'IN', values: stageIds }],
    LEAD_PROPERTIES,
    'hs_createdate'
  );
  return dropExcludedLeads(rows);
}

/**
 * Every lead currently in the Qualified stage, carrying its stage-entry date
 * so the caller can pick out the ones that entered during a given week.
 *
 * The date filter is deliberately NOT pushed down to HubSpot: that property
 * is readable but not searchable and a filter on it returns HTTP 400 (LIVE
 * VERIFICATION point 3).
 */
async function listQualifiedLeads(qualifiedStageId) {
  const rows = await searchAllPages(
    LEADS_SEARCH_PATH,
    'qualified-leads search',
    [{ propertyName: 'hs_pipeline_stage', operator: 'EQ', value: qualifiedStageId }],
    LEAD_PROPERTIES,
    'hs_createdate'
  );
  return dropExcludedLeads(rows);
}

/**
 * Contact ids associated with each of `taskIds`.
 * A batch READ — HubSpot's own endpoint name — never batch/create.
 *
 * The returned map is a join key held in memory for the length of one
 * computation and discarded by the caller. No contact id is ever written to
 * `scorecard_weekly` or to a log line.
 *
 * @returns {Promise<Map<string, string[]>>} task id -> contact ids
 */
async function listContactIdsForTasks(taskIds) {
  const map = new Map();
  if (!taskIds || taskIds.length === 0) return map;

  for (let i = 0; i < taskIds.length; i += ASSOCIATION_BATCH_SIZE) {
    const inputs = taskIds.slice(i, i + ASSOCIATION_BATCH_SIZE).map((id) => ({ id: String(id) }));
    const body = await hubspotJson(
      TASK_CONTACT_ASSOCIATIONS_PATH,
      {
        method: 'POST', // batch READ — HubSpot exposes it as a POST; nothing is created.
        headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs }),
      },
      'task-contact associations batch read'
    );
    for (const row of body.results || []) {
      map.set(String(row.from.id), (row.to || []).map((t) => String(t.toObjectId)));
    }
  }
  return map;
}

/**
 * The HubSpot owner id for an email address, resolved at run time.
 *
 * Never hardcoded. Note carefully what this is and is not: it resolves an
 * identity so that TASK ASSIGNEE can be filtered on, which is a deliberate
 * assignment (the follow-up workflows explicitly set the task owner). It is
 * NOT the lead-level `hubspot_owner_id`, which the migration's Design
 * Decision B establishes is inherited from the primary contact and is
 * actively wrong for attribution. Nothing in this build reads that field.
 *
 * @returns {Promise<string|null>}
 */
async function resolveOwnerIdByEmail(email) {
  const body = await hubspotJson(
    `${OWNERS_PATH}?email=${encodeURIComponent(email)}`,
    { method: 'GET', headers: { Authorization: authHeader() } },
    'owners lookup'
  );
  const hit = (body.results || []).find((o) => (o.email || '').toLowerCase() === email.toLowerCase());
  return hit ? String(hit.id) : null;
}

/**
 * A workflow's CURRENT name, from the v4 flows endpoint.
 *
 * This is the name-drift check (spec Design Decision 41): a rename is then
 * detected the week it happens, by the tool, rather than six months later by
 * archaeology. Read from v4 and never from v3 — the two APIs use different
 * ids for the same workflow and the v3 view of these flows is wrong about
 * their length.
 *
 * Returns null rather than throwing if the flow cannot be read: a drift
 * check failing must not stop a week's metrics from being computed.
 */
async function readWorkflowName(v4FlowId) {
  try {
    const body = await hubspotJson(
      FLOW_PATH_PREFIX + encodeURIComponent(v4FlowId),
      { method: 'GET', headers: { Authorization: authHeader() } },
      'workflow definition read'
    );
    return typeof body.name === 'string' ? body.name : null;
  } catch (err) {
    return null;
  }
}

module.exports = {
  EXCLUDED_DISQUALIFICATION_REASONS,
  listLeadsCreatedBetween,
  listDealsCreatedBetween,
  listTasksCompletedBetween,
  listAutomationTasksCreatedSince,
  listTasksForSequenceIds,
  listLeadsInStages,
  listQualifiedLeads,
  listContactIdsForTasks,
  resolveOwnerIdByEmail,
  readWorkflowName,
};
