/**
 * scorecard/lib/config.js
 * The authoritative list of what the Scoreboard measures.
 *
 * Everything a metric IS — its key, its shape, its label, which direction is
 * good, and who owns it — lives here, in code, beside the query that computes
 * it. There is no `scorecard_metric_definitions` table and there will not be
 * one in v1. The migration header's "WHERE METRIC DEFINITIONS LIVE" section
 * argues that at length; the short version is that "lower is better" on
 * sequence depth is a measured finding, not a display preference, and a
 * finding stored in a row can be edited into agreement with intuition by
 * anyone with SQL access on a Tuesday afternoon. Here it is a diff somebody
 * reviews.
 *
 * Both the compute job and the page read METRICS from this file, so the
 * writer and the reader cannot disagree about a key.
 *
 * NO TARGETS. Not a gap — Neo's decision, with three reasons in the
 * migration header, and Peter's own "no targets for now (revisit after it
 * has been used a few weeks)" from COMMITTED-NOT-BUILT.md §3. Do not add a
 * target field here or a target column to the table.
 */

// ─── Metric owners ────────────────────────────────────────────────────────
// ASSIGNED BY PETER, 2026-09-12: all six keys are Kristen's.
//
// This is a management decision written down, never a field read out of
// HubSpot. The migration's Design Decision B explains why HubSpot's
// `hubspot_owner_id` on a lead is actively wrong for this: it defaults to
// the owner of the primary associated contact, so the failed August lead and
// the successful September lead for the SAME human being are recorded under
// two different people.
//
// *** WHEN PETER REASSIGNS A METRIC, change the value here and the new owner
// applies to weeks computed FROM THAT POINT ON. Historical rows are NOT
// rewritten. There is no backfill-owner job and an UPDATE across past weeks
// is the bug this comment exists to prevent, not a convenience. The migration
// carries the same prohibition as a standing rule. ***
const METRIC_OWNERS = {
  lead_to_discovery_call_rate: 'kristen@rinconmanagement.com',
  followup_touches_worked: 'kristen@rinconmanagement.com',
  followup_touches_automation: 'kristen@rinconmanagement.com',
  followup_sequence_depth: 'kristen@rinconmanagement.com',
  past_lead_conversions: 'kristen@rinconmanagement.com',
  past_lead_reengagement_attempts: 'kristen@rinconmanagement.com',
  // Metric 10, approved 2026-09-12. All Scoreboard metrics are Kristen's —
  // Peter's 2026-09-12 instruction, hard-assigned the same way the other
  // five are. Not looked up anywhere; this is the assignment.
  lost_deals_added_to_sequence: 'kristen@rinconmanagement.com',
};

// ─── The metric registry ──────────────────────────────────────────────────
// `shape` must match the migration's CHECK: 'rate' fills numerator +
// denominator, 'count' fills numerator only, 'statistic' fills value_numeric
// + sample_size. A row whose shape and columns disagree fails on INSERT
// rather than storing half a number.
//
// `higherIsBetter: false` on sequence depth is the measured finding, not
// taste: leads that became deals averaged 4.7 touches, leads that went
// nowhere 6.5. A naive "more follow-up is more diligence" reading scores the
// best weeks lowest.
//
// `aggregable: false` follows from shape === 'statistic' and is written out
// so the renderer never has to infer it. Medians do not combine; no
// arithmetic on four weekly medians recovers the four-week median. The
// average column renders an em-dash for these rows — driven off this flag,
// never off a metric name.
const METRICS = [
  {
    key: 'lead_to_discovery_call_rate',
    shape: 'rate',
    label: 'Lead → discovery call',
    // Displayed as a rolling 4-week rate because weekly swings of 20–114%
    // come purely from cohort mismatch (a lead arriving Friday books the
    // following week). Stored weekly; the window is a number in a query.
    display: 'rolling_rate',
    rollingWeeks: 4,
    higherIsBetter: true,
    aggregable: true,
    numeratorLabel: 'deals created',
    denominatorLabel: 'leads created',
    note: 'A deal only exists once a discovery call has happened — "Discovery call complete" is the first stage of the only pipeline in use.',
  },
  {
    key: 'followup_touches_worked',
    shape: 'count',
    label: 'Follow-up touches — worked',
    display: 'count',
    higherIsBetter: null, // activity, not quality — see `note`
    aggregable: true,
    numeratorLabel: 'touches',
    note: 'Activity, not quality. Counts follow-up tasks a person created and completed themselves.',
  },
  {
    key: 'followup_touches_automation',
    shape: 'count',
    label: 'Follow-up touches — automation',
    display: 'count',
    higherIsBetter: null,
    aggregable: true,
    numeratorLabel: 'touches',
    note: 'Activity, not quality. Shown separately from worked touches on purpose — summing them hides the only half a human controls.',
  },
  {
    key: 'followup_sequence_depth',
    shape: 'statistic',
    label: 'Sequence depth (median touches)',
    display: 'statistic',
    higherIsBetter: false,
    aggregable: false,
    note: 'LOWER IS BETTER. The workflow stops touching a lead the moment they respond, so a high number means leads stayed silent longer. Leads that became deals averaged 4.7 touches; leads that went nowhere averaged 6.5.',
  },
  {
    key: 'past_lead_conversions',
    shape: 'count',
    label: 'Past-lead conversions',
    display: 'count',
    higherIsBetter: true,
    aggregable: true,
    numeratorLabel: 'conversions',
    note: 'A count, never a percentage — 9 in the entire history of the lead object since 2024-06-21, so a long run of legitimate zeroes is expected. A blank week means the week could not be computed; a zero means zero.',
  },
  {
    key: 'past_lead_reengagement_attempts',
    shape: 'count',
    label: 'Past-lead re-engagement attempts',
    display: 'count',
    higherIsBetter: true,
    aggregable: true,
    numeratorLabel: 'attempts',
    // Peter chose the strictest of three candidate readings on 2026-09-12
    // (they measured 28, 82 and 105 per week). Needed no migration — it is
    // one more `count`-shaped key, which is exactly what Design Decision F
    // bought by leaving metric_key out of the CHECK set.
    note: 'Completed tasks against leads sitting in a past-lead stage. Counts attempts a PERSON made — automated nurture emails create no task and are invisible to this number.',
  },
  {
    key: 'lost_deals_added_to_sequence',
    shape: 'count',
    label: 'Lost deals added to sequence',
    display: 'count',
    higherIsBetter: true,
    aggregable: true,
    numeratorLabel: 'contacts enrolled',
    // Approved 2026-09-12 (COMMITTED-NOT-BUILT.md §0a, "Metric 10"). No
    // ambiguity about "current state" here — an enrollment either happened
    // in the week or it didn't, so unlike sequence depth there is no
    // snapshotting concern and no held week.
    note: 'Distinct contacts newly entering a lost-leads re-engagement sequence. 24 of 25 traced enrollees had a genuinely lost deal, confirming the population. The real trend has collapsed from 47–80/week in May–June to single digits by September — say so plainly, do not smooth it over.',
  },
];

const METRIC_KEYS = METRICS.map((m) => m.key);
const METRIC_BY_KEY = new Map(METRICS.map((m) => [m.key, m]));

// ─── HubSpot stage ids ────────────────────────────────────────────────────
// Read from the live portal 2026-09-12. The two past-lead stages are
// Rincon's own definition of "we stopped getting anywhere with this one" —
// they are explicitly named for it and together hold 411 leads.
const LEAD_STAGES = {
  qualified: 'qualified-stage-id',
  backToMarketingForNurture: '201593994',
  noResponse: '201593995',
};
const PAST_LEAD_STAGE_IDS = [LEAD_STAGES.backToMarketingForNurture, LEAD_STAGES.noResponse];

// *** A SILENT-ZERO TRAP, FOUND AND FIXED 2026-09-12. READ THIS BEFORE
// CHANGING THE STRING BELOW. ***
//
// The property that records WHEN a lead entered Qualified is NOT named after
// the stage id. The stage id on `hs_pipeline_stage` is the hyphenated
// `qualified-stage-id`, but the stage-entry property is
// `hs_v2_date_entered_qualified_stage_id_233247981` — underscores, plus a
// numeric suffix that appears nowhere else in this build. Requesting the
// hyphenated name does not error: HubSpot returns the record with that
// property simply absent.
//
// That is the worst possible failure for THIS metric. Past-lead conversions
// legitimately read zero in 13 of 15 weeks, so a version reading the wrong
// property would have printed a plausible zero every week, forever, and
// nobody would have had any reason to doubt it. The first build of this file
// did exactly that and it was caught only by checking the count against the
// known figure of 9 since 2024-06-21.
//
// computePastLeadConversions() therefore ALSO asserts that the property came
// back populated on at least one record, and throws if it did not. Verified
// against the live portal 2026-09-12: the full property list is at
// GET /crm/v3/properties/leads.
const LEAD_ENTERED_QUALIFIED_PROPERTY = 'hs_v2_date_entered_qualified_stage_id_233247981';

// The only deal pipeline in use. Filtered on explicitly; deals found outside
// it are counted and surfaced rather than silently included or dropped.
const DEAL_PIPELINE_ID = 'default';

// ─── Tracked sequences — metric 10, lost deals added to sequence ─────────
// Keyed on `hs_task_sequence_id`, the durable identifier, exactly the
// pattern WORKFLOWS above and line-ownership-history.js already establish:
// names are recorded for a human reading this file and are NEVER matched
// on. HubSpot sequences get renamed mid-life — the same trap already hit
// twice on workflows today (see WORKFLOWS above) hit sequence
// `646033139` too: "Lost Leads - Kristen's" through ~July, then "Old Lost
// Leads Sequence - do not use" through Sept 4, same id throughout.
//
// One line to add a fourth sequence later: append an entry below. Do not
// edit an existing entry's `id` — that changes which historical tasks it
// matched.
const TRACKED_SEQUENCES = [
  {
    id: '646033139',
    names_seen: ["Lost Leads - Kristen's", 'Old Lost Leads Sequence - do not use'],
    notes: '1,178 tasks measured 2026-09-12. Renamed mid-life to a "do not use" label but the id never changed — matching on name would have silently dropped it the day of the rename.',
    added_on: '2026-09-12',
    added_by: 'Q, from live HubSpot measurement approved by Peter the same day.',
  },
  {
    id: '713717482',
    names_seen: ['Kristen Lost Leads 9 Touches'],
    notes: '136 tasks, Aug 7 – Sept 11 2026, currently active. The main sequence carrying this metric today.',
    added_on: '2026-09-12',
    added_by: 'Q, from live HubSpot measurement approved by Peter the same day.',
  },
  // EXPLICITLY EXCLUDED, do not add: '644265661' ("New Sequence") — 1 task,
  // looks like a stray test. Named here so nobody re-adds it believing it
  // was simply missed.
  //
  // EXPLICITLY EXCLUDED, do not add: '744027841' ("Gone Quiet Recovery Run
  // Sequence"). Added 2026-09-12 on the theory that it might be the
  // successor to 713717482 as it winds down. Peter confirmed the same day it
  // is NOT a replacement. TARS then traced both of its enrolled contacts to
  // their deals — the same check that validated the two sequences above at
  // 96% — and found neither is a lost deal:
  //   contact 496451741381 -> deal 328232958660: dealstage
  //     'decisionmakerboughtin' (this portal's first, OPEN stage —
  //     "Discovery call complete"), hs_is_closed_lost = false.
  //   contact 537955507959 -> deal 343127654110: same pipeline, same open
  //     stage, hs_is_closed_lost = false.
  // This sequence targets a different population (open deals going cold),
  // not lost ones. Both enrollments had landed in the then-current week,
  // overstating it from 5 to 7. Removed 2026-09-12; TARS finding, verified
  // against live HubSpot, not a judgment call. If a "gone quiet" recovery
  // metric is ever wanted, it needs its own metric definition — it does not
  // belong folded into this one.
];

const TRACKED_SEQUENCE_IDS = TRACKED_SEQUENCES.map((s) => s.id);

// ─── Task source labels ───────────────────────────────────────────────────
// Measured on the live portal 2026-09-12 over 2026-06-01..2026-09-14: five
// labels exist — AUTOMATION_PLATFORM (1,265), SEQUENCES (1,061), CRM_UI
// (617), INTEGRATION (25), TASK (16).
//
// The worked/automation split is exactly this: a touch a person typed into
// HubSpot (CRM_UI) versus a touch a machine produced (a workflow or a
// sequence). Counting SEQUENCES as worked was the first thing tried and it
// pushed "worked" to 111 in a week the real figure is 17.
const WORKED_TASK_SOURCE_LABELS = ['CRM_UI'];
const AUTOMATION_TASK_SOURCE_LABELS = ['AUTOMATION_PLATFORM', 'SEQUENCES'];

// ─── Workflow configuration ───────────────────────────────────────────────
// Keyed on the v4 flow id — the durable identifier. Names are NEVER the key.
//
// WHY: `hs_object_source_detail_1` on a task is a frozen snapshot of the
// workflow's name at the moment the task was created, and it is never
// updated. Matching on today's name loses 49.6% of tasks in this portal
// right now — APM loses 100% of its 422 tasks and PMW 80%. Measured
// 2026-09-12, live, including a THIRD PMW name nobody had recorded:
// `"PMW Incoming Call leads - In progress "` — with a trailing space. Eight
// workflow and sequence names in live data carry leading or trailing
// whitespace, so every comparison in this build trims first.
//
// `inDepthMetric` is separate from being configured. All five are configured
// so their tasks are recognised rather than counted as unmatched; only the
// 11-touch workflow feeds the sequence-depth median — see the block below
// METRIC_OWNERS in metrics.js for why blending them would be wrong.
const WORKFLOWS = [
  {
    v4Id: '4259746541',
    v3Id: '36143443',
    displayName: 'New lead follow up - 11 touches - Testing Phase',
    aliases: [
      'New lead follow up - 11 touches - Testing Phase',
      'New lead follow up - 11 touches - Active',
    ],
    inDepthMetric: true,
    inScope: true,
  },
  {
    v4Id: '3950514911',
    v3Id: '31570873',
    displayName: 'PMW Incoming Call leads - Active',
    aliases: [
      'PMW Incoming Call leads - Active',
      'PMW Incoming Call leads - Testing Phase',
      'PMW Incoming Call leads - In progress', // third name, carries a trailing space in live data
    ],
    // PMW and the 11-touch workflow are CHAINED, not parallel: PMW creates
    // exactly one task, then sets hs_lead_status = NEW, which is the
    // 11-touch workflow's enrollment trigger. 4 of its 5 contacts appear in
    // both. Measuring it alongside 11-touch in the depth median would count
    // the same lead twice and average a one-task admin item against an
    // eleven-touch cadence. It is a lead-source tag, not a cadence.
    inDepthMetric: false,
    inScope: true,
  },
  {
    v4Id: '4288923329',
    v3Id: '36585716',
    displayName: 'APM leads - New lead follow up touches - active',
    aliases: [
      'APM leads - New lead follow up touches - active',
      'APM leads - New lead follow up touches - In progress',
      'APM leads - updated and active',
      'APM leads - to new - Active',
      'APM leads - active and updated',
      'APM leads - Active',
      'APM leads - testing phase', // found unmatched in live data 2026-09-12, 33 tasks
    ],
    // A genuinely different cadence — measured 2026-09-12: 35 enrollments,
    // median 12 tasks, 13 of them running to 16. Blending it with the
    // 11-touch workflow moves the depth median from 3 to 4 and the number
    // stops describing either cadence. Its tasks still count as automation
    // touches; it just does not feed the median.
    inDepthMetric: false,
    inScope: true,
  },
  {
    v4Id: '4265048812',
    v3Id: '36226104',
    displayName: 'PPC campaign leads - to new - active',
    aliases: ['PPC campaign leads - to new - active'],
    inDepthMetric: false,
    inScope: false, // Peter 2026-09-11: "still needs work"
  },
  {
    v4Id: '615829021',
    v3Id: '66034306',
    displayName: 'Geek Leads - Active',
    aliases: ['Geek Leads - Active', 'Geek Leads - Under Test Phase'],
    inDepthMetric: false,
    inScope: false, // Peter 2026-09-11: "still needs work"
  },
];

// Trimmed alias -> workflow, built once. Every lookup trims its input too.
const WORKFLOW_BY_ALIAS = new Map();
for (const wf of WORKFLOWS) {
  for (const alias of wf.aliases) WORKFLOW_BY_ALIAS.set(alias.trim(), wf);
  WORKFLOW_BY_ALIAS.set(wf.displayName.trim(), wf);
}

function workflowForTaskSourceName(rawName) {
  if (typeof rawName !== 'string') return null;
  return WORKFLOW_BY_ALIAS.get(rawName.trim()) || null;
}

// ─── Sequence-depth week rule ─────────────────────────────────────────────
// *** THE ONE DEFINITION THAT WAS GENUINELY OPEN. Q's call, 2026-09-12,
// stated here so Peter can overrule it with a one-word change. ***
//
//   'last_task_created'   — CHOSEN. The enrollment belongs to the week its
//                           LAST TASK WAS CREATED, which is the week the
//                           lead responded: the workflow's LIST_BRANCH gates
//                           stop creating tasks the instant a lead resolves,
//                           so the last task created is HubSpot's own record
//                           of when the lead stopped being silent. Peter's
//                           2026-09-12 wording is "median touches before a
//                           lead responds", and this is the closest
//                           observable to the response itself.
//
//   'last_task_completed' — the spec's Design Decision 42 shape. The week
//                           the enrollment CLOSED. Rejected because a task's
//                           completion date records when Kristen ticked it
//                           off, which is her admin behaviour, not the
//                           lead's — and the close-and-immediately-recreate
//                           pattern (a task completed and its successor
//                           created 0.35 seconds later) clusters completions
//                           on admin days. It also needs a longer hold.
//
// The hold below follows from the rule, and is not a free choice. Measured
// across the 81 enrollments: first task to last task CREATED is median 0.0
// days, p90 4.8, max 5.8 — so 7 days covers every enrollment observed.
// First task to last COMPLETION is p90 7.0 and needs 10 days to reach 98%.
// Choosing the created-date rule buys back three days of freshness.
const SEQUENCE_DEPTH_WEEK_RULE = 'last_task_created';
const SEQUENCE_DEPTH_HOLD_DAYS = 7;

// How far back to pull automation tasks when reconstructing enrollments. An
// enrollment's tasks span several weeks, so a week's own tasks are not
// enough to count how deep it went. 120 days is comfortably past the longest
// observed enrollment (5.8 days first-to-last) with room for a stalled one.
const ENROLLMENT_LOOKBACK_DAYS = 120;

// Which Hub roles may read the Scoreboard. Both already exist in
// team_member_tool_roles' role CHECK — the migration adds no role value.
// Peter and his Director of Operations are the natural pair for a page read
// in a weekly meeting.
const SCORECARD_TOOL = 'scorecard';
const SCORECARD_READ_ROLES = ['admin', 'director_of_operations'];

module.exports = {
  METRICS,
  METRIC_KEYS,
  METRIC_BY_KEY,
  METRIC_OWNERS,
  LEAD_STAGES,
  PAST_LEAD_STAGE_IDS,
  LEAD_ENTERED_QUALIFIED_PROPERTY,
  DEAL_PIPELINE_ID,
  TRACKED_SEQUENCES,
  TRACKED_SEQUENCE_IDS,
  WORKED_TASK_SOURCE_LABELS,
  AUTOMATION_TASK_SOURCE_LABELS,
  WORKFLOWS,
  workflowForTaskSourceName,
  SEQUENCE_DEPTH_WEEK_RULE,
  SEQUENCE_DEPTH_HOLD_DAYS,
  ENROLLMENT_LOOKBACK_DAYS,
  SCORECARD_TOOL,
  SCORECARD_READ_ROLES,
};
