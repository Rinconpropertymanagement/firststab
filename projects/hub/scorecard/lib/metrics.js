/**
 * scorecard/lib/metrics.js
 * The seven metric computations, one function each.
 *
 * Every one of them takes a week and returns the RAW PARTS the figure was
 * built from — never a finished percentage. That is the property the whole
 * table exists for: averaging four weekly percentages with different
 * denominators is not the four-week rate, and storing 62.8% loses the
 * "76 of 121" the page is required to show.
 *
 * The tenant/vendor exclusion is NOT applied in this file. It is applied
 * once, in hubspot-leads-connector.js, which no lead reaches this file
 * without passing through. A rule repeated in six places is a rule that
 * will one day be in five.
 *
 * No lead id, contact id, task id, enrollment id, name, e-mail or phone
 * number is returned by any function here or written anywhere. The
 * `hs_primary_contact_id` join in computePastLeadConversions and the
 * enrollment grouping in computeSequenceDepth are keys held in memory for
 * the length of one computation and dropped when it returns.
 *
 * *** TWO NAMED EXCEPTIONS. *** Both DO return a lead/contact/deal id and a
 * name — on purpose, for the Scoreboard's live drill-downs. Both read HubSpot
 * live on every call and hand the result straight to the browser; nothing
 * either returns is ever written to `scorecard_weekly`, any other table, or a
 * log line. That is the same "no outside-individual identifier persists"
 * property Asimov's condition on this Scoreboard protects for every stored
 * row — it is preserved by never storing this output, not by never producing
 * it. Every other function in this file keeps the no-identifier rule exactly
 * as before.
 *
 *   - ADDED 2026-09-12: `findFailingContacts` and `findFailingDeals` (metric
 *     11's drill-down helpers, alongside `scoreCrmContacts`/`scoreCrmDeals`),
 *     behind GET /api/scorecard/crm-completeness/detail.
 *   - ADDED 2026-09-13: `findLeadDetailsForWeek` (metric 1's drill-down),
 *     behind GET /api/scorecard/booking-rate/detail.
 *   - ADDED 2026-09-13: `findFollowupTouchesForWeek` (metrics 2 and 3's
 *     drill-down), behind GET /api/scorecard/followup-touches/detail.
 *   - ADDED 2026-09-13: `findReengagementAttemptsForWeek` (metric 6's
 *     drill-down), behind GET /api/scorecard/reengagement/detail.
 *   - ADDED 2026-09-13: `findLostDealsAddedToSequenceForWeek` (metric 10's
 *     drill-down), behind GET /api/scorecard/lost-deals-sequence/detail.
 */

const {
  LEAD_STAGES,
  PAST_LEAD_STAGE_IDS,
  LEAD_STAGE_LABELS,
  LEAD_ENTERED_QUALIFIED_PROPERTY,
  WORKED_TASK_SOURCE_LABELS,
  AUTOMATION_TASK_SOURCE_LABELS,
  workflowForTaskSourceName,
  SEQUENCE_DEPTH_WEEK_RULE,
  ENROLLMENT_LOOKBACK_DAYS,
  TRACKED_SEQUENCE_IDS,
  TRACKED_SEQUENCES,
} = require('./config');
const { weekBoundsIso } = require('./week');
const {
  CRM_COMPLETENESS_POPULATION_START_ISO,
  IMPORT_TYPE_DEPRECATED_VALUES,
  OWNER_PERSONA_DEPRECATED_VALUES,
} = require('./crm-completeness-config');
// Reused, not redeclared — see crm-completeness-config.js's header. This is
// the same list call-stats/lib/hubspot-connector.js already uses to decide
// "did a human do something deliberate with this contact," which is exactly
// the population test metric 11 needs: a real prospect, not exhaust.
const { PROSPECT_LIFECYCLE_STAGES } = require('../../call-stats/lib/sales-classification-config');

// ─── Small helpers ────────────────────────────────────────────────────────

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Enrollment id out of `hs_object_source_id`, which HubSpot formats as
// "enrollmentId:<N>;actionExecutionIndex:<N>". This is the only durable
// grouping key a workflow task carries — there is no workflow id on the
// task at all.
function enrollmentIdOf(task) {
  const match = /enrollmentId:(\d+)/.exec(task.properties.hs_object_source_id || '');
  return match ? match[1] : null;
}

function isInWindow(iso, fromIso, toIso) {
  return typeof iso === 'string' && iso >= fromIso && iso < toIso;
}

// ─── Metric 1 — lead → discovery call rate ────────────────────────────────
/**
 * Deals created ÷ leads created, in the week. A `rate`.
 *
 * A deal only exists once a discovery call has happened, because "Discovery
 * call complete" is literally the first stage of the only pipeline in use.
 * That is an assumption nothing in HubSpot enforces, so the connector
 * filters on `pipeline = 'default'` explicitly and counts anything found
 * outside it; `dealsOutsideDefaultPipeline` is carried all the way to the
 * page. If a second pipeline ever appears, the number stops being silently
 * wrong and starts being visibly qualified.
 *
 * DENOMINATOR 0 IS LEGAL AND MEANINGFUL. A week with no leads created is not
 * a 0% week — it is a week with no denominator. Nothing here divides; the
 * division happens at read time and the renderer shows an em-dash.
 */
async function computeLeadToDiscoveryCallRate(hubspot, weekStart) {
  const { fromIso, toIso } = weekBoundsIso(weekStart);
  const { leads, excludedCount } = await hubspot.listLeadsCreatedBetween(fromIso, toIso);
  const { deals, outsideDefaultPipeline } = await hubspot.listDealsCreatedBetween(fromIso, toIso);

  return {
    metric_key: 'lead_to_discovery_call_rate',
    metric_shape: 'rate',
    numerator: deals.length,
    denominator: leads.length,
    diagnostics: {
      tenantVendorLeadsExcluded: excludedCount,
      dealsOutsideDefaultPipeline: outsideDefaultPipeline,
    },
  };
}

/**
 * The live drill-down behind GET /api/scorecard/booking-rate/detail.
 *
 * Unlike metric 11's drill-downs, this is not "failing records" — a rate has
 * no pass/fail line. Every lead in the returned list is a legitimate entry;
 * what a human wants to see is which ones already turned into a deal and
 * which are still just leads, which is why each one carries a
 * `convertedToDeal` flag instead of a `missingFields` list.
 *
 * `population` and `convertedCount` come STRAIGHT from the same
 * listLeadsCreatedBetween/listDealsCreatedBetween calls
 * computeLeadToDiscoveryCallRate makes — never a second population query —
 * so they equal the stored denominator/numerator for the week EXACTLY, by
 * construction. That matters because the per-lead join below does NOT add up
 * to `convertedCount`, and building the totals from the join instead would
 * have made the drill-down disagree with the Scoreboard's own stored number,
 * which is the one thing a drill-down must never do.
 *
 * *** WHY THE JOIN UNDERCOUNTS, MEASURED RATHER THAN ASSUMED. *** A lead is
 * marked `convertedToDeal: true` only if its `hs_primary_contact_id` matches
 * the contact of a deal ALSO created in this same week. `convertedCount` is
 * every deal created in the week, full stop — and a deal's contact's lead did
 * not have to be created in that same week. Checked live against three real
 * weeks (2026-09-13): 2026-06-01 (8 leads, 8 deals, join matches 4),
 * 2026-04-06 (4 leads, 5 deals, join matches 3) and 2026-08-31 (15 leads, 6
 * deals, join matches 5). In every one of them the join count is LOWER than
 * `convertedCount` — sometimes by a lot — because some of the week's deals
 * belong to contacts whose lead was created a different week. The page must
 * show both numbers and must not imply the per-lead flags sum to the
 * headline count.
 *
 * Contact names are joined in a single batched call
 * (`hubspot.getContactsByIds`) over every lead's `hs_primary_contact_id` for
 * the week — never one lookup per lead — because a lead record itself has no
 * name field (see LEAD_PROPERTIES in hubspot-leads-connector.js).
 */
async function findLeadDetailsForWeek(hubspot, weekStart) {
  const { fromIso, toIso } = weekBoundsIso(weekStart);
  const { leads, excludedCount } = await hubspot.listLeadsCreatedBetween(fromIso, toIso);
  const { deals, outsideDefaultPipeline } = await hubspot.listDealsCreatedBetween(fromIso, toIso);

  // Join 1: this week's deals -> their contact ids, so a lead can be checked
  // against "did one of this week's deals belong to my contact."
  const contactIdsByDeal = await hubspot.listContactIdsForDeals(deals.map((d) => d.id));
  const dealContactIds = new Set();
  for (const ids of contactIdsByDeal.values()) {
    for (const id of ids) dealContactIds.add(id);
  }

  // Join 2: every lead's contact id -> that contact's name, batched once
  // over the whole week rather than once per lead.
  const contactIds = [...new Set(leads.map((l) => l.properties.hs_primary_contact_id).filter(Boolean))];
  const contactsById = await hubspot.getContactsByIds(contactIds);

  let matchedToWeekDeal = 0;
  const leadDetails = leads.map((lead) => {
    const contactId = lead.properties.hs_primary_contact_id || null;
    const convertedToDeal = Boolean(contactId && dealContactIds.has(contactId));
    if (convertedToDeal) matchedToWeekDeal++;

    const contactProps = contactId ? contactsById.get(contactId) : null;
    const name = contactProps
      ? [contactProps.firstname, contactProps.lastname].map((s) => (s || '').trim()).filter(Boolean).join(' ')
      : '';

    const rawStage = lead.properties.hs_pipeline_stage;
    return {
      id: lead.id,
      name: name || (contactProps && contactProps.email) || null,
      createdDate: lead.properties.hs_createdate,
      // Falls back to the raw id for a stage this map hasn't been updated
      // for yet, rather than showing nothing — see LEAD_STAGE_LABELS.
      stage: LEAD_STAGE_LABELS[rawStage] || rawStage,
      convertedToDeal,
    };
  });

  return {
    population: leads.length,
    convertedCount: deals.length,
    leads: leadDetails,
    diagnostics: {
      tenantVendorLeadsExcluded: excludedCount,
      dealsOutsideDefaultPipeline: outsideDefaultPipeline,
      // Informational only — see this function's header for why it will
      // typically be lower than convertedCount, never a way to derive it.
      leadsMatchedToASameWeekDeal: matchedToWeekDeal,
    },
  };
}

// ─── Metrics 2 and 3 — follow-up touches, worked and automation ───────────
/**
 * Two `count` rows from one pass over the week's completed tasks.
 *
 * Population: tasks ASSIGNED TO the metric's owner, keyed on
 * `hs_task_completion_date` — a task created in March and completed in
 * September is a September touch.
 *
 * On filtering by assignee. This reads a task's `hubspot_owner_id`, which is
 * NOT the lead-level field the migration's Design Decision B forbids. On a
 * lead that field is inherited from the primary contact and records who
 * happens to own the contact; on a task it is a deliberate assignment that
 * the follow-up workflows set explicitly. Different field, different object,
 * different meaning. Nothing in this build reads the lead-level one.
 *
 * The split is by source: CRM_UI is a touch a person typed into HubSpot,
 * AUTOMATION_PLATFORM and SEQUENCES are touches a machine produced. Both
 * halves are labelled ACTIVITY, never quality, and are stored as two keys
 * rather than one row with a segment column — summing them hides the only
 * half a human controls.
 *
 * Anything with another source label (INTEGRATION, TASK — 41 records across
 * a 15-week window) lands in neither and is reported as `otherSourceLabels`
 * rather than quietly folded into one side.
 */

/**
 * The owner filter and worked/automation split, pulled out so the stored
 * aggregate (`computeFollowupTouches` below) and the live drill-down
 * (`findFollowupTouchesForWeek`, further down) run the EXACT SAME population
 * query rather than two copies that could drift apart. Returns the matching
 * task objects themselves, not just counts, since the drill-down needs the
 * tasks and the aggregate only needs their length.
 */
function splitFollowupTasksByOwner(tasks, ownerHubspotId) {
  const worked = [];
  const automation = [];
  const otherSourceLabels = {};

  for (const task of tasks) {
    if (String(task.properties.hubspot_owner_id || '') !== String(ownerHubspotId)) continue;
    const label = (task.properties.hs_object_source_label || '').trim();
    if (WORKED_TASK_SOURCE_LABELS.includes(label)) worked.push(task);
    else if (AUTOMATION_TASK_SOURCE_LABELS.includes(label)) automation.push(task);
    else otherSourceLabels[label || '(none)'] = (otherSourceLabels[label || '(none)'] || 0) + 1;
  }

  return { worked, automation, otherSourceLabels };
}

async function computeFollowupTouches(hubspot, weekStart, ownerHubspotId) {
  const { fromIso, toIso } = weekBoundsIso(weekStart);
  const tasks = await hubspot.listTasksCompletedBetween(fromIso, toIso);
  const { worked, automation, otherSourceLabels } = splitFollowupTasksByOwner(tasks, ownerHubspotId);

  return [
    {
      metric_key: 'followup_touches_worked',
      metric_shape: 'count',
      numerator: worked.length,
      diagnostics: { otherSourceLabels, tasksConsidered: tasks.length },
    },
    {
      metric_key: 'followup_touches_automation',
      metric_shape: 'count',
      numerator: automation.length,
      diagnostics: { otherSourceLabels, tasksConsidered: tasks.length },
    },
  ];
}

/**
 * The live drill-down behind GET /api/scorecard/followup-touches/detail.
 *
 * Runs `splitFollowupTasksByOwner` over the SAME `listTasksCompletedBetween`
 * call `computeFollowupTouches` makes, so `worked.count` and
 * `automation.count` below equal the stored numerator for
 * `followup_touches_worked`/`followup_touches_automation` for this week
 * EXACTLY, by construction — not by re-deriving the same filter a second
 * time, which is exactly the kind of drift this file's header warns about.
 *
 * CONTACT NAME JOIN, BATCHED ONCE. A task carries no name of its own, only
 * an association to whichever contact it was worked against. The naive
 * approach — one `listContactIdsForTasks` call per task — would be N
 * requests for a week that can hold over a hundred touches; instead this
 * calls it ONCE for every task in both halves combined (worked concat
 * automation), exactly the same batching `findLeadDetailsForWeek` above uses
 * for the booking-rate drill-down (`listContactIdsForDeals` there,
 * `listContactIdsForTasks` here — same association-batch-read family), then
 * `getContactsByIds` ONCE more for every contact id that came back. Two
 * network round-trips total for the whole week, not one per task.
 *
 * A task can carry more than one associated contact in principle; this build
 * has not observed that in practice and takes the first id HubSpot returns.
 * If a task genuinely has none (a touch logged without an association), its
 * `contactName` is simply null — the task itself is still listed, since the
 * touch happened regardless of whether a contact join succeeded.
 */
async function findFollowupTouchesForWeek(hubspot, weekStart, ownerHubspotId) {
  const { fromIso, toIso } = weekBoundsIso(weekStart);
  const tasks = await hubspot.listTasksCompletedBetween(fromIso, toIso);
  const { worked, automation, otherSourceLabels } = splitFollowupTasksByOwner(tasks, ownerHubspotId);

  const relevantTasks = worked.concat(automation);
  const contactIdsByTask = await hubspot.listContactIdsForTasks(relevantTasks.map((t) => t.id));
  const allContactIds = new Set();
  for (const ids of contactIdsByTask.values()) {
    for (const id of ids) allContactIds.add(id);
  }
  const contactsById = await hubspot.getContactsByIds([...allContactIds]);

  function detailFor(task) {
    const contactIds = contactIdsByTask.get(task.id) || [];
    const contactId = contactIds[0] || null;
    const contactProps = contactId ? contactsById.get(contactId) : null;
    const name = contactProps
      ? [contactProps.firstname, contactProps.lastname].map((s) => (s || '').trim()).filter(Boolean).join(' ')
      : '';
    return {
      id: task.id,
      subject: task.properties.hs_task_subject || null,
      sourceLabel: (task.properties.hs_object_source_label || '').trim(),
      completedDate: task.properties.hs_task_completion_date,
      contactName: name || (contactProps && contactProps.email) || null,
    };
  }

  return {
    worked: { count: worked.length, tasks: worked.map(detailFor) },
    automation: { count: automation.length, tasks: automation.map(detailFor) },
    diagnostics: { otherSourceLabels, tasksConsidered: tasks.length },
  };
}

// ─── Metric 4 — sequence depth ────────────────────────────────────────────
/**
 * The MEDIAN number of touches an enrollment reached, over the enrollments
 * belonging to this week. A `statistic`, and the only one.
 *
 * *** LOWER IS BETTER, AND THE PAGE SAYS SO. *** The workflow stops touching
 * a lead the moment they respond, so a high number measures how long someone
 * stayed silent. Leads that became deals averaged 4.7 touches; leads that
 * went nowhere averaged 6.5.
 *
 * *** THIS ROW MUST NEVER BE AGGREGATED ACROSS WEEKS. *** A median of four
 * weeks is not the average of four weekly medians and no arithmetic on the
 * stored values recovers it. The average column renders an em-dash, driven
 * off metric_shape.
 *
 * ONLY the 11-touch workflow feeds this. PMW creates exactly one task and
 * then triggers the 11-touch workflow — the two are chained, 4 of PMW's 5
 * contacts appear in both, and folding it in would count the same lead
 * twice and average a one-task admin item against an eleven-touch cadence.
 * APM is a genuinely different cadence (median 12 tasks, some running to 16)
 * and blending it moves this median from 3 to 4, at which point the number
 * describes neither. Both are still configured, so their tasks are
 * recognised rather than counted as unmatched, and both still contribute to
 * the automation touch count.
 *
 * WHICH WEEK AN ENROLLMENT BELONGS TO is the one definition that was
 * genuinely open. Chosen: the week its LAST TASK WAS CREATED — see
 * SEQUENCE_DEPTH_WEEK_RULE in config.js for the reasoning and for the
 * rejected alternative. Changing it is a one-word change there.
 *
 * `unmatchedAutomationTasks` is the early-warning signal the whole config
 * design rests on: a workflow rename shows up as a new name with a real task
 * count instead of a metric quietly falling toward zero. It is NOT expected
 * to be zero — this portal runs many workflows that were never in scope —
 * so what matters is the per-name breakdown and a configured workflow's
 * count dropping off a cliff.
 */
async function computeSequenceDepth(hubspot, weekStart, { sinceIso } = {}) {
  const { fromIso, toIso } = weekBoundsIso(weekStart);
  // `sinceIso` lets a multi-week run pass ONE anchor for every week, so the
  // automation-task universe is fetched once instead of fifteen times with
  // fifteen slightly different start dates that share no cache entry.
  const lookbackFrom = sinceIso || new Date(
    new Date(fromIso).getTime() - ENROLLMENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const tasks = await hubspot.listAutomationTasksCreatedSince(lookbackFrom);

  // Group every in-scope automation task by its enrollment, and count the
  // unmatched residue by name so a rename is visible.
  const enrollments = new Map(); // enrollment id -> { count, lastCreated, lastCompleted }
  const unmatchedByName = {};
  const matchedByWorkflow = {};

  for (const task of tasks) {
    const rawName = task.properties.hs_object_source_detail_1;
    const workflow = workflowForTaskSourceName(rawName);
    if (!workflow) {
      const key = typeof rawName === 'string' ? rawName.trim() : '(none)';
      unmatchedByName[key] = (unmatchedByName[key] || 0) + 1;
      continue;
    }
    matchedByWorkflow[workflow.displayName] = (matchedByWorkflow[workflow.displayName] || 0) + 1;
    if (!workflow.inDepthMetric) continue;

    const enrollmentId = enrollmentIdOf(task);
    if (!enrollmentId) continue;

    const entry = enrollments.get(enrollmentId) || { count: 0, lastCreated: null, lastCompleted: null };
    entry.count++;
    const created = task.properties.hs_createdate;
    const completed = task.properties.hs_task_completion_date;
    if (created && (!entry.lastCreated || created > entry.lastCreated)) entry.lastCreated = created;
    if (completed && (!entry.lastCompleted || completed > entry.lastCompleted)) entry.lastCompleted = completed;
    enrollments.set(enrollmentId, entry);
  }

  const depths = [];
  for (const entry of enrollments.values()) {
    const weekKey = SEQUENCE_DEPTH_WEEK_RULE === 'last_task_completed' ? entry.lastCompleted : entry.lastCreated;
    if (isInWindow(weekKey, fromIso, toIso)) depths.push(entry.count);
  }

  const unmatchedTotal = Object.values(unmatchedByName).reduce((a, b) => a + b, 0);

  return {
    metric_key: 'followup_sequence_depth',
    metric_shape: 'statistic',
    value_numeric: median(depths),
    sample_size: depths.length,
    diagnostics: {
      weekRule: SEQUENCE_DEPTH_WEEK_RULE,
      unmatchedAutomationTasks: unmatchedTotal,
      unmatchedByName,
      matchedByWorkflow,
      enrollmentsSeenInLookback: enrollments.size,
    },
  };
}

// ─── Metric 5 — past-lead conversions ─────────────────────────────────────
/**
 * A `count`, never a percentage — 9 in the entire history of the lead object
 * since 2024-06-21, and 13 of the last 15 weeks are zero. A weekly
 * percentage would print 0.0% almost every week.
 *
 * The rule, and it could not have been written without looking at the data:
 * when a past lead re-engages, HubSpot's workflow creates a SECOND lead
 * record for the same person rather than advancing the first. The naive
 * definition — a lead moving from a past-lead stage into Qualified —
 * returns zero, always, and a tool built on it would confidently report 0%
 * forever.
 *
 * So: a lead that entered Qualified during the week counts if an EARLIER
 * lead for the same `hs_primary_contact_id` is sitting in a past-lead stage.
 * That contact id is a join key. It lives in memory for the length of this
 * function and is never written anywhere.
 *
 * `hs_v2_date_entered_qualified-stage-id` is readable but NOT searchable on
 * this portal (a filter on it returns HTTP 400), so the whole Qualified
 * population comes back and the date is matched here.
 */
async function computePastLeadConversions(hubspot, weekStart) {
  const { fromIso, toIso } = weekBoundsIso(weekStart);

  const { leads: qualified } = await hubspot.listQualifiedLeads(LEAD_STAGES.qualified);
  const { leads: pastLeads } = await hubspot.listLeadsInStages(PAST_LEAD_STAGE_IDS);

  const earliestPastLeadByContact = new Map();
  for (const lead of pastLeads) {
    const contactId = lead.properties.hs_primary_contact_id;
    if (!contactId) continue;
    const created = lead.properties.hs_createdate;
    const existing = earliestPastLeadByContact.get(contactId);
    if (!existing || (created && created < existing)) earliestPastLeadByContact.set(contactId, created);
  }

  // *** THE GUARD. *** This metric legitimately reads zero in 13 of 15 weeks,
  // which means a zero caused by reading the WRONG PROPERTY is
  // indistinguishable from a correct answer — forever. So the read is
  // checked rather than trusted: if not one lead in the whole Qualified
  // population carries a stage-entry date, the property name is wrong or
  // HubSpot stopped returning it, and this throws. A thrown metric writes no
  // row and leaves the week re-runnable; a silent zero would have been
  // written down as fact. The first build of this file had exactly that bug.
  let leadsWithEntryDate = 0;
  let conversions = 0;
  for (const lead of qualified) {
    const enteredQualified = lead.properties[LEAD_ENTERED_QUALIFIED_PROPERTY];
    if (typeof enteredQualified === 'string' && enteredQualified) leadsWithEntryDate++;
    if (!isInWindow(enteredQualified, fromIso, toIso)) continue;
    const contactId = lead.properties.hs_primary_contact_id;
    if (!contactId) continue;
    const earlierPast = earliestPastLeadByContact.get(contactId);
    if (earlierPast && earlierPast < lead.properties.hs_createdate) conversions++;
  }

  if (qualified.length > 0 && leadsWithEntryDate === 0) {
    throw new Error(
      `Not one of ${qualified.length} Qualified leads carried "${LEAD_ENTERED_QUALIFIED_PROPERTY}". ` +
      'The property name is wrong or HubSpot has stopped returning it. Refusing to report 0 conversions, ' +
      'which would be indistinguishable from a correct answer. Check GET /crm/v3/properties/leads.'
    );
  }

  return {
    metric_key: 'past_lead_conversions',
    metric_shape: 'count',
    numerator: conversions,
    diagnostics: {
      qualifiedPopulation: qualified.length,
      qualifiedLeadsCarryingEntryDate: leadsWithEntryDate,
      pastLeadPopulation: pastLeads.length,
    },
  };
}

// ─── Metric 6 — past-lead re-engagement attempts ──────────────────────────
/**
 * A `count`. Peter chose the strictest of three candidate readings on
 * 2026-09-12 (they measured 28, 82 and 105 per week): COMPLETED TASKS
 * AGAINST LEADS IN A PAST-LEAD STAGE.
 *
 * Needed no migration — Design Decision F left `metric_key` out of the CHECK
 * set exactly so that this could be one more `count` key on the day Peter
 * chose.
 *
 * A past lead is one sitting in "Back to Marketing for Nurture" or "No
 * Response". Those two stages are the business's own definition of "we
 * stopped getting anywhere with this one"; a day-count threshold would be an
 * invented rule on top of a rule Rincon already applies deliberately.
 *
 * Tasks reach leads through the contact: a lead carries
 * `hs_primary_contact_id`, and a task's associated contacts come back from
 * the batch association read. Both are join keys held in memory.
 *
 * AN HONEST UNDERCOUNT, NAMED: emails sent inside the "Drip campaign #1"
 * nurture workflow create no task, so automated nurture is invisible here.
 * This measures attempts a PERSON made, and the page says so.
 */
async function computeReengagementAttempts(hubspot, weekStart) {
  const { fromIso, toIso } = weekBoundsIso(weekStart);

  const { leads: pastLeads } = await hubspot.listLeadsInStages(PAST_LEAD_STAGE_IDS);
  const pastContactIds = new Set(
    pastLeads.map((l) => l.properties.hs_primary_contact_id).filter(Boolean)
  );

  const tasks = await hubspot.listTasksCompletedBetween(fromIso, toIso);
  const contactsByTask = await hubspot.listContactIdsForTasks(tasks.map((t) => t.id));

  let attempts = 0;
  for (const task of tasks) {
    const contactIds = contactsByTask.get(task.id) || [];
    if (contactIds.some((id) => pastContactIds.has(id))) attempts++;
  }

  return {
    metric_key: 'past_lead_reengagement_attempts',
    metric_shape: 'count',
    numerator: attempts,
    diagnostics: {
      pastLeadPopulation: pastLeads.length,
      pastLeadContacts: pastContactIds.size,
      tasksConsidered: tasks.length,
    },
  };
}

/**
 * The live drill-down behind GET /api/scorecard/reengagement/detail.
 *
 * Runs the SAME population computeReengagementAttempts does —
 * listLeadsInStages(PAST_LEAD_STAGE_IDS) for the past-lead contact set,
 * listTasksCompletedBetween for the week's completed tasks, and the same
 * "is any of this task's associated contacts a past-lead contact" test — so
 * `count` below equals the stored numerator for
 * `past_lead_reengagement_attempts` for this week EXACTLY, by construction.
 * Never a second population query.
 *
 * Every task returned is a legitimate attempt, same framing as the
 * booking-rate and follow-up-touches drill-downs: this is activity, not a
 * defect list.
 *
 * CONTACT NAME JOIN, BATCHED ONCE. `listContactIdsForTasks` is already
 * called once for the whole week (computeReengagementAttempts needs it to
 * build the filter itself), so no second association call is added for
 * that. Naming the contact each attempt was against only needs one more
 * batched call: `getContactsByIds`, once, over the distinct past-lead
 * contact ids the qualifying tasks matched — not one lookup per task. Same
 * two-round-trips-for-the-whole-week shape findFollowupTouchesForWeek uses
 * above.
 */
async function findReengagementAttemptsForWeek(hubspot, weekStart) {
  const { fromIso, toIso } = weekBoundsIso(weekStart);

  const { leads: pastLeads } = await hubspot.listLeadsInStages(PAST_LEAD_STAGE_IDS);
  const pastContactIds = new Set(
    pastLeads.map((l) => l.properties.hs_primary_contact_id).filter(Boolean)
  );

  const tasks = await hubspot.listTasksCompletedBetween(fromIso, toIso);
  const contactsByTask = await hubspot.listContactIdsForTasks(tasks.map((t) => t.id));

  // The matched past-lead contact id per qualifying task — a task can carry
  // more than one associated contact in principle; this takes the first one
  // that is actually in the past-lead set, since that is the one the reader
  // wants a name for.
  const matchedContactIdByTask = new Map();
  for (const task of tasks) {
    const contactIds = contactsByTask.get(task.id) || [];
    const matched = contactIds.find((id) => pastContactIds.has(id));
    if (matched) matchedContactIdByTask.set(task.id, matched);
  }

  const attemptTasks = tasks.filter((task) => matchedContactIdByTask.has(task.id));
  const contactsById = await hubspot.getContactsByIds(
    [...new Set(matchedContactIdByTask.values())]
  );

  const attemptDetails = attemptTasks.map((task) => {
    const contactId = matchedContactIdByTask.get(task.id);
    const contactProps = contactId ? contactsById.get(contactId) : null;
    const name = contactProps
      ? [contactProps.firstname, contactProps.lastname].map((s) => (s || '').trim()).filter(Boolean).join(' ')
      : '';
    return {
      id: task.id,
      subject: task.properties.hs_task_subject || null,
      completedDate: task.properties.hs_task_completion_date,
      contactName: name || (contactProps && contactProps.email) || null,
    };
  });

  return {
    count: attemptTasks.length,
    tasks: attemptDetails,
    diagnostics: {
      pastLeadPopulation: pastLeads.length,
      pastLeadContacts: pastContactIds.size,
      tasksConsidered: tasks.length,
    },
  };
}

// ─── Metric 10 — lost deals added to sequence ─────────────────────────────
/**
 * Distinct contacts newly entering a lost-leads re-engagement sequence in
 * the week. A `count`.
 *
 * No snapshotting concern here, unlike sequence depth or the tenant/vendor
 * exclusion: an enrollment either happened in the week or it did not, and
 * nothing about "current state" can drift out from under a past week — Q
 * confirmed this rather than assuming it, per the build instructions.
 *
 * KEYED ON hs_task_sequence_step_enrollment_contact_id, THE PER-PERSON KEY —
 * never hs_object_source_id's enrollment id (used elsewhere in this file
 * for workflow enrollments), which is one-per-TASK and overcounts a
 * multi-touch sequence enrollment as several enrollments. This is the exact
 * arithmetic mistake already made once today on a different metric.
 *
 * An enrollment's date is MIN(hs_createdate) across all of a contact's
 * tasks in ANY tracked sequence — "only count a contact once across ALL
 * tracked sequence ids for a given week" from the build instructions. That
 * rule falls out for free from grouping by contact id over every task this
 * function reads, since the read itself already spans every tracked
 * sequence: a contact who appears in two tracked sequences contributes one
 * entry to the map, not two.
 *
 * Sequences are tracked BY ID, never by name — TRACKED_SEQUENCE_IDS in
 * config.js, and the same trap already hit twice today on workflow names
 * (sequence 646033139 carried two names across its life with the same id
 * throughout).
 *
 * *** A WEEK-BOUNDARY FINDING, RECORDED RATHER THAN SILENTLY PICKED ***
 * This function buckets by `weekBoundsIso`/`isInWindow`, exactly like every
 * other metric in this file — Rincon's business weeks, Monday–Sunday in
 * America/Los_Angeles. That is a deliberate consistency choice, not an
 * oversight: three real enrollment batches (47, 27 and 41 contacts) were
 * created between roughly 04:00–04:06 UTC on a Monday, which is Sunday
 * evening Pacific — one calendar day and one ISO week earlier. Bucketing
 * those same tasks by their raw UTC calendar date instead (no Pacific
 * conversion) reassigns all three batches into the following week and
 * reproduces a since-superseded hand-measurement exactly for every week
 * from 2026-05-11 through 2026-08-31. This function intentionally does NOT
 * do that — a raw-UTC bucket is the exact class of bug week.js's own header
 * warns against, and every other row on this Scoreboard is Pacific-bucketed
 * — so a reader comparing this output against an older ad hoc measurement
 * should expect 2026-05-25, 2026-06-01, 2026-06-08 and 2026-06-15 to differ
 * from it by tens of contacts while every other week matches exactly. The
 * total across that span is identical either way (409 contacts): nothing is
 * gained or lost, only reassigned to the week Rincon's own clock says it
 * happened in.
 */
/**
 * Every tracked-sequence task, reduced to one entry per CONTACT: the task
 * whose `hs_createdate` is earliest for that contact. Pulled out of
 * `computeLostDealsAddedToSequence` so the stored aggregate and the live
 * drill-down (`findLostDealsAddedToSequenceForWeek`, below) run the exact
 * same per-person grouping rather than two copies that could drift apart —
 * the same reasoning `splitFollowupTasksByOwner` was extracted for, above.
 *
 * Keyed on `hs_task_sequence_step_enrollment_contact_id`, the per-person
 * key — see the header comment above `computeLostDealsAddedToSequence` for
 * why that is NOT `hs_object_source_id`'s per-task enrollment id.
 *
 * Returns the TASK itself for each contact, not just its date. The stored
 * aggregate only ever needed the date; the drill-down additionally needs
 * that task's own `hs_task_sequence_id` to say which tracked sequence the
 * contact's earliest touch belongs to, so the whole task is kept rather than
 * two near-identical grouping passes over the same list.
 */
function earliestTaskByContact(tasks) {
  const byContact = new Map(); // contact id -> earliest task
  let tasksMissingContactOrDate = 0;
  for (const task of tasks) {
    const contactId = task.properties.hs_task_sequence_step_enrollment_contact_id;
    const created = task.properties.hs_createdate;
    if (!contactId || !created) {
      tasksMissingContactOrDate++;
      continue;
    }
    const existing = byContact.get(contactId);
    if (!existing || created < existing.properties.hs_createdate) byContact.set(contactId, task);
  }
  return { byContact, tasksMissingContactOrDate };
}

// Sequence id -> a display-only label, built from TRACKED_SEQUENCES'
// `names_seen` in config.js: the LAST recorded name is the most recently
// observed one. Never matched on — see config.js's own header on
// TRACKED_SEQUENCES for why these names drift mid-life while the id stays
// fixed. Falls back to the raw id for a sequence id this map hasn't seen,
// which should not occur since the population is already filtered to
// TRACKED_SEQUENCE_IDS, but is not assumed.
const SEQUENCE_LABEL_BY_ID = new Map(
  TRACKED_SEQUENCES.map((s) => [s.id, s.names_seen[s.names_seen.length - 1]])
);
function sequenceLabelFor(sequenceId) {
  return SEQUENCE_LABEL_BY_ID.get(sequenceId) || sequenceId || '(unknown sequence)';
}

async function computeLostDealsAddedToSequence(hubspot, weekStart) {
  const { fromIso, toIso } = weekBoundsIso(weekStart);
  const tasks = await hubspot.listTasksForSequenceIds(TRACKED_SEQUENCE_IDS);
  const { byContact, tasksMissingContactOrDate } = earliestTaskByContact(tasks);

  let enrollments = 0;
  for (const task of byContact.values()) {
    if (isInWindow(task.properties.hs_createdate, fromIso, toIso)) enrollments++;
  }

  return {
    metric_key: 'lost_deals_added_to_sequence',
    metric_shape: 'count',
    numerator: enrollments,
    diagnostics: {
      trackedSequenceIds: TRACKED_SEQUENCE_IDS,
      tasksConsidered: tasks.length,
      tasksMissingContactOrDate,
      distinctContactsAllTime: byContact.size,
    },
  };
}

/**
 * The live drill-down behind GET /api/scorecard/lost-deals-sequence/detail.
 *
 * Runs `earliestTaskByContact` over the SAME `listTasksForSequenceIds`
 * call `computeLostDealsAddedToSequence` makes, so `count` below equals the
 * stored numerator for `lost_deals_added_to_sequence` for this week EXACTLY,
 * by construction — never a second population query.
 *
 * Every contact returned is a legitimate new enrollment, same framing as the
 * booking-rate/follow-up-touches/reengagement drill-downs above: this is
 * activity, not a defect list.
 *
 * *** "WHICH TRACKED SEQUENCE," CHECKED RATHER THAN ASSUMED. ***
 * `computeLostDealsAddedToSequence` itself does not care which tracked
 * sequence a contact's earliest task belongs to — it only cares THAT an
 * earliest task exists and WHEN. But a HubSpot task carries exactly one
 * `hs_task_sequence_id`, so a contact's single earliest task belongs to
 * exactly one tracked sequence; there is no ambiguity to resolve and no case
 * to pick between two. A contact could separately have LATER tasks in a
 * second tracked sequence — the grouping rule folds all tracked sequences
 * together specifically so that does not create a second enrollment — but
 * that does not change which sequence they entered THIS week, since only
 * their earliest touch across every tracked sequence decides the week (see
 * the header above `computeLostDealsAddedToSequence`). So "which sequence"
 * is simply `task.properties.hs_task_sequence_id` off the same earliest task
 * already selected for the count, looked up against config.js's
 * `TRACKED_SEQUENCES` for a human-readable (but never matched-on) label.
 *
 * CONTACT NAME JOIN, BATCHED ONCE — `getContactsByIds` over every
 * qualifying contact id for the week, the same batching family every other
 * drill-down in this file uses, never one lookup per contact.
 */
async function findLostDealsAddedToSequenceForWeek(hubspot, weekStart) {
  const { fromIso, toIso } = weekBoundsIso(weekStart);
  const tasks = await hubspot.listTasksForSequenceIds(TRACKED_SEQUENCE_IDS);
  const { byContact, tasksMissingContactOrDate } = earliestTaskByContact(tasks);

  const entering = [];
  for (const [contactId, task] of byContact.entries()) {
    if (isInWindow(task.properties.hs_createdate, fromIso, toIso)) entering.push({ contactId, task });
  }

  const contactsById = await hubspot.getContactsByIds(entering.map((e) => e.contactId));

  const contacts = entering.map(({ contactId, task }) => {
    const contactProps = contactsById.get(contactId) || null;
    const name = contactProps
      ? [contactProps.firstname, contactProps.lastname].map((s) => (s || '').trim()).filter(Boolean).join(' ')
      : '';
    const sequenceId = task.properties.hs_task_sequence_id || null;
    return {
      contactId,
      name: name || (contactProps && contactProps.email) || null,
      enteredDate: task.properties.hs_createdate,
      sequenceId,
      sequenceLabel: sequenceLabelFor(sequenceId),
    };
  });

  return {
    count: contacts.length,
    contacts,
    diagnostics: {
      trackedSequenceIds: TRACKED_SEQUENCE_IDS,
      tasksConsidered: tasks.length,
      tasksMissingContactOrDate,
    },
  };
}

// ─── Metric 11 — CRM data completeness (two rows, not one blended score) ──
/**
 * Two `rate` metrics built strictly from Rincon's own written SOP for
 * `import_type`, `owner_persona` and `hs_lead_status`, and for the deal-side
 * line "After a Lead Is Finished: Set the Deal as Lost or Won, Add clear
 * notes." Approved by Peter 2026-09-12 as TWO Scoreboard rows —
 * `crm_contact_completeness` and `crm_deal_completeness` — because they
 * measure different objects with different population sizes, and blending
 * them into one score would hide which side is actually weak (measured
 * 2026-09-12: contacts 81.6%, the weak field inside it being owner_persona
 * at 82.9%; deals 88.4%, dragged down entirely by the closed side at 85.4%
 * against open deals' 100%).
 *
 * POPULATION START, BOTH METRICS: contacts/deals created on or after
 * 2026-04-01 — see crm-completeness-config.js for why. `computeAll()` only
 * ever calls these for the current week, so the population-start clamp
 * below matters only when this function is called directly for an earlier
 * week (verify.js reproducing the all-time measured figures) — a week
 * entirely before 2026-04-01 has a legitimately empty population, not a
 * failure, so it returns a 0/0 rate rather than throwing or skipping.
 *
 * SNAPSHOT AT COMPUTE TIME, SAME AS EVERY OTHER SCOREBOARD METRIC. This is a
 * data-hygiene measurement, not a performance-attribution one — there is no
 * tenant/departure-style drift risk here the way line-ownership-history.js
 * guards against for Call Stats, because nothing about "did this contact
 * ever get filled in correctly" can be rewritten by someone leaving. So a
 * week is computed once and never recomputed, exactly like the other six
 * metrics, rather than inventing a live-recompute path this table has no
 * precedent for and gains nothing from.
 *
 * DEAL COMPLETENESS DOES NOT JOIN BACK TO A CONTACT. Deals are measured
 * directly as their own population, exactly as Peter's 2026-09-12
 * measurement did — a contact without a deal yet is not a defect on either
 * row, it simply has not reached metric 2's denominator yet.
 */

/**
 * Per-contact evaluation against the SOP's three fields. Pure, no network
 * calls. This is the ONE place the pass/fail rule for a contact is written
 * down — `scoreCrmContacts` (the stored aggregate) and `findFailingContacts`
 * (the live drill-down) both call it, so the two can never quietly drift
 * apart the way two hand-written copies of the same rule eventually do.
 */
function evaluateContact(contact) {
  const importType = (contact.properties.import_type || '').trim();
  const ownerPersona = (contact.properties.owner_persona || '').trim();
  const leadStatus = (contact.properties.hs_lead_status || '').trim();

  const importOk = importType !== '' && !IMPORT_TYPE_DEPRECATED_VALUES.includes(importType);
  const personaOk = ownerPersona !== '' && !OWNER_PERSONA_DEPRECATED_VALUES.includes(ownerPersona);
  const statusOk = leadStatus !== '';

  return { importOk, personaOk, statusOk, complete: importOk && personaOk && statusOk };
}

/**
 * Per-deal evaluation. Pure, no network calls. Same one-definition reasoning
 * as `evaluateContact` above: `scoreCrmDeals` and `findFailingDeals` both
 * call this rather than each keeping its own copy of the rule.
 *
 * Open vs. closed is decided by hs_is_closed_won/hs_is_closed_lost, NEVER
 * the raw dealstage id — see LIVE VERIFICATION point 8 in
 * hubspot-leads-connector.js for the "Onsite Consultation Complete" trap
 * (dealstage id `closedlost`, hs_is_closed_lost correctly `false`) that
 * makes the id unsafe to use here.
 */
function evaluateDeal(deal) {
  const isClosedWon = String(deal.properties.hs_is_closed_won).trim().toLowerCase() === 'true';
  const isClosedLost = String(deal.properties.hs_is_closed_lost).trim().toLowerCase() === 'true';
  const closed = isClosedWon || isClosedLost;

  const hasName = Boolean((deal.properties.dealname || '').trim());
  const amount = Number(deal.properties.amount);
  const hasPositiveAmount = Number.isFinite(amount) && amount > 0;
  const numNotes = Number(deal.properties.num_notes || 0);
  const hasNotes = numNotes > 0;

  const complete = closed ? (hasName && hasPositiveAmount && hasNotes) : (hasName && hasPositiveAmount);
  return { closed, hasName, hasPositiveAmount, hasNotes, complete };
}

/**
 * A week that falls entirely before the 2026-04-01 population start has a
 * legitimately EMPTY population, not a failure — same "denominator 0 is
 * legal" rule metric 1 relies on. Shared by the two stored aggregates below
 * and the two drill-down finders so the boundary is checked identically by
 * both.
 */
function clampToPopulationStart(fromIso, toIso) {
  const clampedFromIso = fromIso < CRM_COMPLETENESS_POPULATION_START_ISO ? CRM_COMPLETENESS_POPULATION_START_ISO : fromIso;
  return { clampedFromIso, emptyWeek: clampedFromIso >= toIso };
}

/** Pure scoring over an already-fetched contact list. No network calls. */
function scoreCrmContacts(contacts) {
  let importTypeValid = 0;
  let ownerPersonaValid = 0;
  let leadStatusPresent = 0;
  let allThree = 0;

  for (const contact of contacts) {
    const r = evaluateContact(contact);
    if (r.importOk) importTypeValid++;
    if (r.personaOk) ownerPersonaValid++;
    if (r.statusOk) leadStatusPresent++;
    if (r.complete) allThree++;
  }

  return { population: contacts.length, allThree, importTypeValid, ownerPersonaValid, leadStatusPresent };
}

/**
 * Pure scoring over an already-fetched deal list. No network calls.
 */
function scoreCrmDeals(deals) {
  let openTotal = 0;
  let openComplete = 0;
  let closedTotal = 0;
  let closedComplete = 0;

  for (const deal of deals) {
    const r = evaluateDeal(deal);
    if (r.closed) {
      closedTotal++;
      if (r.complete) closedComplete++;
    } else {
      openTotal++;
      if (r.complete) openComplete++;
    }
  }

  return {
    population: openTotal + closedTotal,
    complete: openComplete + closedComplete,
    openTotal,
    openComplete,
    closedTotal,
    closedComplete,
  };
}

/**
 * The FAILING contacts out of an already-fetched contact list, each with
 * which field(s) tripped it up. Live drill-down only — see this file's
 * header for the named exception to the no-identifier rule. Uses the exact
 * same `evaluateContact` scoreCrmContacts uses, so a contact never appears
 * here without also being excluded from `allThree` above, or vice versa.
 */
function findFailingContacts(contacts) {
  const failing = [];
  for (const contact of contacts) {
    const r = evaluateContact(contact);
    if (r.complete) continue;
    const missingFields = [];
    if (!r.importOk) missingFields.push('import_type');
    if (!r.personaOk) missingFields.push('owner_persona');
    if (!r.statusOk) missingFields.push('hs_lead_status');
    const name = [contact.properties.firstname, contact.properties.lastname]
      .map((s) => (s || '').trim())
      .filter(Boolean)
      .join(' ');
    failing.push({
      id: contact.id,
      name: name || contact.properties.email || null,
      missingFields,
    });
  }
  return failing;
}

/**
 * The FAILING deals out of an already-fetched deal list, each with which
 * requirement it's missing and whether it's open or closed. Live drill-down
 * only — see this file's header. Uses the exact same `evaluateDeal`
 * scoreCrmDeals uses.
 */
function findFailingDeals(deals) {
  const failing = [];
  for (const deal of deals) {
    const r = evaluateDeal(deal);
    if (r.complete) continue;
    const missingFields = [];
    if (!r.hasName) missingFields.push('deal name');
    if (!r.hasPositiveAmount) missingFields.push('amount');
    if (r.closed && !r.hasNotes) missingFields.push('activity notes (required once closed)');
    failing.push({
      id: deal.id,
      name: (deal.properties.dealname || '').trim() || null,
      closed: r.closed,
      missingFields,
    });
  }
  return failing;
}

async function computeCrmContactCompleteness(hubspot, weekStart) {
  const { fromIso, toIso } = weekBoundsIso(weekStart);
  const { clampedFromIso, emptyWeek } = clampToPopulationStart(fromIso, toIso);

  // Only reachable when this is called directly for a week outside
  // computeAll()'s "current week only" usage (verify.js reproducing older
  // weeks).
  if (emptyWeek) {
    return {
      metric_key: 'crm_contact_completeness',
      metric_shape: 'rate',
      numerator: 0,
      denominator: 0,
      diagnostics: { skippedReason: 'week entirely precedes the 2026-04-01 population start' },
    };
  }

  const { contacts } = await hubspot.listContactsCreatedBetween(clampedFromIso, toIso, PROSPECT_LIFECYCLE_STAGES);
  const score = scoreCrmContacts(contacts);

  return {
    metric_key: 'crm_contact_completeness',
    metric_shape: 'rate',
    numerator: score.allThree,
    denominator: score.population,
    diagnostics: {
      importTypeValid: score.importTypeValid,
      ownerPersonaValid: score.ownerPersonaValid,
      leadStatusPresent: score.leadStatusPresent,
    },
  };
}

async function computeCrmDealCompleteness(hubspot, weekStart) {
  const { fromIso, toIso } = weekBoundsIso(weekStart);
  const { clampedFromIso, emptyWeek } = clampToPopulationStart(fromIso, toIso);

  if (emptyWeek) {
    return {
      metric_key: 'crm_deal_completeness',
      metric_shape: 'rate',
      numerator: 0,
      denominator: 0,
      diagnostics: { skippedReason: 'week entirely precedes the 2026-04-01 population start' },
    };
  }

  const { deals, outsideDefaultPipeline } = await hubspot.listDealsCreatedBetween(clampedFromIso, toIso);
  const score = scoreCrmDeals(deals);

  return {
    metric_key: 'crm_deal_completeness',
    metric_shape: 'rate',
    numerator: score.complete,
    denominator: score.population,
    diagnostics: {
      openTotal: score.openTotal,
      openComplete: score.openComplete,
      closedTotal: score.closedTotal,
      closedComplete: score.closedComplete,
      dealsOutsideDefaultPipeline: outsideDefaultPipeline,
    },
  };
}

/**
 * The live drill-down behind GET /api/scorecard/crm-completeness/detail:
 * the SAME population computeCrmContactCompleteness would score for this
 * week (reusing listContactsCreatedBetween and PROSPECT_LIFECYCLE_STAGES,
 * never a second population query), reduced to just the contacts that fail.
 * Reads HubSpot fresh on every call; returns nothing that gets stored.
 */
async function findFailingContactsForWeek(hubspot, weekStart) {
  const { fromIso, toIso } = weekBoundsIso(weekStart);
  const { clampedFromIso, emptyWeek } = clampToPopulationStart(fromIso, toIso);
  if (emptyWeek) return { population: 0, failing: [] };

  const { contacts } = await hubspot.listContactsCreatedBetween(clampedFromIso, toIso, PROSPECT_LIFECYCLE_STAGES);
  return { population: contacts.length, failing: findFailingContacts(contacts) };
}

/** Same idea as findFailingContactsForWeek, for metric 11's deal side. */
async function findFailingDealsForWeek(hubspot, weekStart) {
  const { fromIso, toIso } = weekBoundsIso(weekStart);
  const { clampedFromIso, emptyWeek } = clampToPopulationStart(fromIso, toIso);
  if (emptyWeek) return { population: 0, failing: [] };

  const { deals } = await hubspot.listDealsCreatedBetween(clampedFromIso, toIso);
  return { population: deals.length, failing: findFailingDeals(deals) };
}

// ─── The name-drift check ─────────────────────────────────────────────────
/**
 * Re-reads each configured workflow's CURRENT name from the v4 flows
 * endpoint and reports any that no longer match config.
 *
 * Worth being precise about what this catches and what it does not: it
 * catches a rename between config and today's live definition. It is BLIND
 * to the failure that is already live — tasks carrying a frozen older name
 * that is not in the alias list. That one is caught by the unmatched-by-name
 * breakdown in computeSequenceDepth, which is why both exist.
 *
 * Never throws. A drift check failing must not stop a week being computed.
 */
async function checkWorkflowNameDrift(hubspot, workflows) {
  const drift = [];
  for (const workflow of workflows) {
    const liveName = await hubspot.readWorkflowName(workflow.v4Id);
    if (liveName === null) {
      drift.push({ v4Id: workflow.v4Id, configured: workflow.displayName, live: null, status: 'unreadable' });
      continue;
    }
    if (liveName.trim() !== workflow.displayName.trim()) {
      drift.push({ v4Id: workflow.v4Id, configured: workflow.displayName, live: liveName, status: 'renamed' });
    }
  }
  return drift;
}

module.exports = {
  median,
  computeLeadToDiscoveryCallRate,
  findLeadDetailsForWeek,
  computeFollowupTouches,
  findFollowupTouchesForWeek,
  computeSequenceDepth,
  computePastLeadConversions,
  computeReengagementAttempts,
  findReengagementAttemptsForWeek,
  computeLostDealsAddedToSequence,
  findLostDealsAddedToSequenceForWeek,
  computeCrmContactCompleteness,
  computeCrmDealCompleteness,
  scoreCrmContacts,
  scoreCrmDeals,
  findFailingContacts,
  findFailingDeals,
  findFailingContactsForWeek,
  findFailingDealsForWeek,
  checkWorkflowNameDrift,
};
