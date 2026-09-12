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
 */

const {
  LEAD_STAGES,
  PAST_LEAD_STAGE_IDS,
  LEAD_ENTERED_QUALIFIED_PROPERTY,
  WORKED_TASK_SOURCE_LABELS,
  AUTOMATION_TASK_SOURCE_LABELS,
  workflowForTaskSourceName,
  SEQUENCE_DEPTH_WEEK_RULE,
  ENROLLMENT_LOOKBACK_DAYS,
  TRACKED_SEQUENCE_IDS,
} = require('./config');
const { weekBoundsIso } = require('./week');

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
async function computeFollowupTouches(hubspot, weekStart, ownerHubspotId) {
  const { fromIso, toIso } = weekBoundsIso(weekStart);
  const tasks = await hubspot.listTasksCompletedBetween(fromIso, toIso);

  let worked = 0;
  let automation = 0;
  const otherSourceLabels = {};

  for (const task of tasks) {
    if (String(task.properties.hubspot_owner_id || '') !== String(ownerHubspotId)) continue;
    const label = (task.properties.hs_object_source_label || '').trim();
    if (WORKED_TASK_SOURCE_LABELS.includes(label)) worked++;
    else if (AUTOMATION_TASK_SOURCE_LABELS.includes(label)) automation++;
    else otherSourceLabels[label || '(none)'] = (otherSourceLabels[label || '(none)'] || 0) + 1;
  }

  return [
    {
      metric_key: 'followup_touches_worked',
      metric_shape: 'count',
      numerator: worked,
      diagnostics: { otherSourceLabels, tasksConsidered: tasks.length },
    },
    {
      metric_key: 'followup_touches_automation',
      metric_shape: 'count',
      numerator: automation,
      diagnostics: { otherSourceLabels, tasksConsidered: tasks.length },
    },
  ];
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
async function computeLostDealsAddedToSequence(hubspot, weekStart) {
  const { fromIso, toIso } = weekBoundsIso(weekStart);
  const tasks = await hubspot.listTasksForSequenceIds(TRACKED_SEQUENCE_IDS);

  const firstSeenByContact = new Map();
  let tasksMissingContactOrDate = 0;
  for (const task of tasks) {
    const contactId = task.properties.hs_task_sequence_step_enrollment_contact_id;
    const created = task.properties.hs_createdate;
    if (!contactId || !created) {
      tasksMissingContactOrDate++;
      continue;
    }
    const existing = firstSeenByContact.get(contactId);
    if (!existing || created < existing) firstSeenByContact.set(contactId, created);
  }

  let enrollments = 0;
  for (const firstCreated of firstSeenByContact.values()) {
    if (isInWindow(firstCreated, fromIso, toIso)) enrollments++;
  }

  return {
    metric_key: 'lost_deals_added_to_sequence',
    metric_shape: 'count',
    numerator: enrollments,
    diagnostics: {
      trackedSequenceIds: TRACKED_SEQUENCE_IDS,
      tasksConsidered: tasks.length,
      tasksMissingContactOrDate,
      distinctContactsAllTime: firstSeenByContact.size,
    },
  };
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
  computeFollowupTouches,
  computeSequenceDepth,
  computePastLeadConversions,
  computeReengagementAttempts,
  computeLostDealsAddedToSequence,
  checkWorkflowNameDrift,
};
