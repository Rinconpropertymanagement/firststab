/**
 * scorecard/lib/read-cache.js
 * Wraps the HubSpot read module so one run reads each thing once.
 *
 * TWO REASONS, and the second matters more than the first.
 *
 * 1. Volume. The past-lead population (411 records), the Qualified
 *    population (364) and the automation-task lookback are the same read for
 *    every week in a range, and a 15-week run re-requested each of them
 *    fifteen times. That hit HubSpot's real rate limit on the first live
 *    run — it is measured, not anticipated.
 *
 * 2. Consistency, which is the one worth keeping even if the volume problem
 *    went away. Without this, metric 5 and metric 6 can read the past-lead
 *    population seconds apart and get different answers, because HubSpot is
 *    live and a lead can move stage mid-run. Then the two numbers on the
 *    same page were computed against different worlds and nothing says so.
 *    One cache for the length of one run means every metric in that run sees
 *    the same HubSpot.
 *
 * The cache is per-instance and deliberately has no expiry: it is created at
 * the start of a run and thrown away at the end. It must NEVER be hoisted to
 * module scope or shared between runs — a week computed against last week's
 * cached population is exactly the history-rewrite this build is built to
 * avoid.
 */

const connector = require('./hubspot-leads-connector');

// Every read on the connector. Listed explicitly rather than enumerated off
// the module, so adding a read is a deliberate decision about whether one
// snapshot per run is the right semantics for it.
const CACHEABLE_READS = [
  'listLeadsCreatedBetween',
  'listDealsCreatedBetween',
  'listTasksCompletedBetween',
  'listAutomationTasksCreatedSince',
  'listLeadsInStages',
  'listQualifiedLeads',
  'listContactIdsForTasks',
  'resolveOwnerIdByEmail',
  'readWorkflowName',
];

function createCachedReader() {
  const cache = new Map();
  const stats = { calls: 0, hits: 0 };

  const reader = {};
  for (const name of CACHEABLE_READS) {
    reader[name] = (...args) => {
      const key = name + ':' + JSON.stringify(args);
      stats.calls++;
      if (cache.has(key)) {
        stats.hits++;
        return cache.get(key);
      }
      // The PROMISE is cached, not its resolved value — so two metrics
      // asking for the same population at the same moment share one request
      // instead of racing to make two.
      const promise = connector[name](...args).catch((err) => {
        // A failed read must not be cached: the next attempt should be a
        // real attempt, not a replay of the error.
        cache.delete(key);
        throw err;
      });
      cache.set(key, promise);
      return promise;
    };
  }

  reader.__stats = stats;
  return reader;
}

module.exports = { createCachedReader };
