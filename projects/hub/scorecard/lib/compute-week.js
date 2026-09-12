/**
 * scorecard/lib/compute-week.js
 * Turns "a week" into the rows that go in `scorecard_weekly`, and writes them.
 *
 * ============================================================
 * WRITE NOTHING RATHER THAN WRITE A GUESS
 * ============================================================
 * If HubSpot cannot be read, this produces NO ROW for that metric and the
 * week stays re-runnable. It never substitutes a zero, and it never writes
 * half a rate. The migration makes that structural rather than a convention:
 * a `rate` row carrying a numerator and no denominator violates the shape
 * CHECK and the INSERT fails loudly.
 *
 * The consequence, which the page has to handle rather than hide: A FAILED
 * WEEK WRITES NO ROW, so "the last 4 rows" and "the last 4 weeks" are not
 * the same thing. Every rolling window reports how many weeks it actually
 * covered — see buildRollingWindow() in router.js.
 * ============================================================
 *
 * TWO WEEKS, NOT ONE. The six fast metrics publish the week that just
 * closed. Sequence depth holds 7 days so every enrollment has finished
 * before its median is computed, which means its row refers to an EARLIER
 * week than the others. Each row therefore carries its own `week_start` and
 * the page must label rows individually — never stack them under one date
 * header.
 */

const { createCachedReader } = require('./read-cache');
const {
  METRIC_OWNERS,
  METRIC_BY_KEY,
  WORKFLOWS,
  SEQUENCE_DEPTH_HOLD_DAYS,
} = require('./config');
const {
  computeLeadToDiscoveryCallRate,
  computeFollowupTouches,
  computeSequenceDepth,
  computePastLeadConversions,
  computeReengagementAttempts,
  computeLostDealsAddedToSequence,
  checkWorkflowNameDrift,
} = require('./metrics');
const { latestPublishableWeek, weekBoundsIso, mondayOf } = require('./week');

const OWNER_EMAIL_FOR_TASK_POPULATION = METRIC_OWNERS.followup_touches_worked;

/**
 * A local mirror of the migration's `scorecard_weekly_shape_check`.
 *
 * The database constraint is the real guarantee and this does not replace
 * it. It exists because a CHECK violation arrives as a Postgres error naming
 * a constraint, which tells whoever is reading the log nothing about which
 * metric produced a malformed row or how. Failing here instead says so in
 * words, and says it BEFORE a batch of six rows is rejected because one of
 * them was wrong.
 *
 * Kept deliberately close in wording to the SQL so the two can be compared
 * by eye. If the migration's CHECK ever changes, change this with it.
 */
function assertShapeContract(row) {
  const has = (v) => v !== null && v !== undefined;
  const { metric_key: key, metric_shape: shape } = row;

  const ok =
    (shape === 'rate' && has(row.numerator) && has(row.denominator) && !has(row.value_numeric) && !has(row.sample_size)) ||
    (shape === 'count' && has(row.numerator) && !has(row.denominator) && !has(row.value_numeric) && !has(row.sample_size)) ||
    (shape === 'statistic' && has(row.value_numeric) && has(row.sample_size) && !has(row.numerator) && !has(row.denominator));

  if (!ok) {
    throw new Error(
      `"${key}" produced a row that does not match its declared shape "${shape}". ` +
      `Got numerator=${row.numerator}, denominator=${row.denominator}, value_numeric=${row.value_numeric}, sample_size=${row.sample_size}. ` +
      "A 'rate' needs both parts, a 'count' needs a numerator and nothing else, a 'statistic' needs a value and a sample size. " +
      'This is the same contract scorecard_weekly_shape_check enforces in the database.'
    );
  }
  if (row.week_start !== mondayOf(row.week_start)) {
    throw new Error(`"${key}" produced week_start ${row.week_start}, which is not a Monday. The database CHECK would reject it.`);
  }
}

/** Shapes one computation's output into a row the table will accept. */
function toRow(computed, weekStart) {
  const definition = METRIC_BY_KEY.get(computed.metric_key);
  if (!definition) throw new Error(`Unknown metric_key "${computed.metric_key}" — it is not in config.js's METRICS.`);
  const ownerEmail = METRIC_OWNERS[computed.metric_key];
  if (!ownerEmail) throw new Error(`No owner assigned for "${computed.metric_key}". owner_email is NOT NULL and is an assignment, not a measurement — add it to METRIC_OWNERS.`);

  const row = {
    metric_key: computed.metric_key,
    metric_shape: computed.metric_shape,
    week_start: weekStart,
    owner_email: ownerEmail.toLowerCase(),
    numerator: computed.numerator === undefined ? null : computed.numerator,
    denominator: computed.denominator === undefined ? null : computed.denominator,
    value_numeric: computed.value_numeric === undefined ? null : computed.value_numeric,
    sample_size: computed.sample_size === undefined ? null : computed.sample_size,
    computed_at: new Date().toISOString(),
  };
  assertShapeContract(row);
  return row;
}

/**
 * Computes every metric for the weeks that are currently publishable.
 * Reads only — nothing is written here.
 *
 * @returns {Promise<{rows: Array, diagnostics: Object, failures: Array}>}
 */
async function computeAll({ fastWeek, depthWeek, today } = {}) {
  const fast = fastWeek || latestPublishableWeek(0, today);
  const depth = depthWeek || latestPublishableWeek(SEQUENCE_DEPTH_HOLD_DAYS, today);

  // One reader per run — so the six metrics are computed against one
  // snapshot of a live CRM, not six. See read-cache.js.
  const hubspot = createCachedReader();

  const ownerHubspotId = await hubspot.resolveOwnerIdByEmail(OWNER_EMAIL_FOR_TASK_POPULATION);
  if (!ownerHubspotId) {
    throw new Error(`Could not resolve a HubSpot owner id for ${OWNER_EMAIL_FOR_TASK_POPULATION}. Refusing to compute touch metrics against an unfiltered population rather than silently counting the whole portal.`);
  }

  const rows = [];
  const failures = [];
  const diagnostics = { fastWeek: fast, depthWeek: depth, metrics: {} };

  // Each metric is attempted independently: one metric failing must not cost
  // the other five their week.
  const attempts = [
    ['lead_to_discovery_call_rate', fast, () => computeLeadToDiscoveryCallRate(hubspot, fast)],
    ['followup_touches', fast, () => computeFollowupTouches(hubspot, fast, ownerHubspotId)],
    ['followup_sequence_depth', depth, () => computeSequenceDepth(hubspot, depth)],
    ['past_lead_conversions', fast, () => computePastLeadConversions(hubspot, fast)],
    ['past_lead_reengagement_attempts', fast, () => computeReengagementAttempts(hubspot, fast)],
    ['lost_deals_added_to_sequence', fast, () => computeLostDealsAddedToSequence(hubspot, fast)],
  ];

  for (const [name, weekStart, run] of attempts) {
    try {
      const result = await run();
      for (const computed of Array.isArray(result) ? result : [result]) {
        // A statistic with no observations has no median. Writing 0 would be
        // a guess; writing nothing keeps the week re-runnable.
        if (computed.metric_shape === 'statistic' && computed.value_numeric === null) {
          failures.push({ metric: computed.metric_key, week: weekStart, reason: 'no enrollments belonged to this week — no median exists, so no row is written' });
          diagnostics.metrics[computed.metric_key] = computed.diagnostics;
          continue;
        }
        rows.push(toRow(computed, weekStart));
        diagnostics.metrics[computed.metric_key] = computed.diagnostics;
      }
    } catch (err) {
      failures.push({ metric: name, week: weekStart, reason: err.message });
    }
  }

  try {
    diagnostics.workflowNameDrift = await checkWorkflowNameDrift(hubspot, WORKFLOWS);
  } catch (err) {
    diagnostics.workflowNameDrift = [{ status: 'check-failed', reason: err.message }];
  }

  return { rows, diagnostics, failures };
}

/**
 * Upserts rows into `scorecard_weekly` on (metric_key, week_start).
 *
 * A re-run of a week that failed overwrites in place rather than adding a
 * second row. owner_email is deliberately not in the conflict key: every
 * metric has one owner today, and including it would mean a reassignment
 * silently produced two rows for the same metric-week and the page showed
 * the metric twice.
 *
 * Takes the Supabase client as an argument so this module never creates one
 * and so the verification runner can call computeAll() without ever
 * constructing a writer.
 */
async function writeRows(supabase, rows) {
  if (!rows.length) return { written: 0 };
  const { error } = await supabase
    .from('scorecard_weekly')
    .upsert(rows, { onConflict: 'metric_key,week_start' });
  if (error) throw new Error(`scorecard_weekly upsert failed: ${error.message}`);
  return { written: rows.length };
}

module.exports = { computeAll, writeRows, toRow, assertShapeContract, weekBoundsIso };
