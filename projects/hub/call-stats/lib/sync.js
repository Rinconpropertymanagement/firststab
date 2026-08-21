/**
 * lib/sync.js
 * Turns a day's worth of raw Aircall call records into the
 * one-row-per-(staff member, day, direction) shape call_stats expects
 * (SPEC.md Design Decision 2, 20260819010000_call_stats.sql). Pure
 * aggregation logic, no network/database calls in this file — router.js's
 * internal sync route fetches from Aircall, calls this, then upserts the
 * result. Kept separate so the math can be tested/reasoned about on its
 * own, same split latchel-connector.js/router.js already use elsewhere.
 *
 * Per this build's task instructions (not left to guesswork — see
 * aircall-connector.js's LIVE VERIFICATION section for the real cases this
 * covers):
 *   - A call with no attached Aircall user (`call.user === null`) is
 *     skipped from attribution entirely — this table's grain requires a
 *     staff_email and there is no fallback shape for a pod-level-only
 *     miss. Counted in the summary, never written to a row.
 *   - A call whose attached user's email doesn't match any row in
 *     Rincon's own `users.email` (an external vendor's Aircall seat, e.g.
 *     Quick Turn Maintenance) is logged and its contribution is skipped —
 *     the rest of the day's sync still completes.
 *   - A call with no `ended_at` (still in progress at fetch time) is
 *     skipped entirely rather than guessed at — see aircall-connector.js
 *     LIVE VERIFICATION #5.
 */

const { pacificDateOf } = require('./timezone');

/**
 * @param {Array} calls - raw Aircall call objects for one Pacific day
 * @param {Map<string,{id:string,email:string}>} usersByEmail - lowercased
 *   users.email -> {id, email} lookup, built by the caller from a fresh
 *   `users` table read (name/pod are looked up again at DASHBOARD read
 *   time per Design Decision 1, not needed here)
 * @returns {{ rows: Array, summary: Object }}
 */
function buildDailyAggregates(calls, usersByEmail) {
  const buckets = new Map(); // key: aircall_user_id|call_date|direction
  const unmatchedEmails = new Map(); // email (lowercased) -> count, for the sync log
  const summary = {
    calls_seen: calls.length,
    calls_unattributed_no_user: 0, // call.user === null (inbound pod-line miss, or an unattributed outbound line)
    calls_unmatched_email: 0, // call.user set, but email isn't a known Rincon staff member (e.g. a vendor's Aircall seat)
    calls_skipped_in_progress: 0, // ended_at still null at fetch time
    calls_aggregated: 0,
    unmatched_emails: [], // filled in below, distinct + counted
  };

  for (const call of calls) {
    if (call.ended_at == null) {
      summary.calls_skipped_in_progress++;
      continue;
    }
    if (!call.user) {
      summary.calls_unattributed_no_user++;
      continue;
    }
    const rawEmail = (call.user.email || '').trim();
    const email = rawEmail.toLowerCase();
    if (!email || !usersByEmail.has(email)) {
      summary.calls_unmatched_email++;
      unmatchedEmails.set(email || '(no email on call.user)', (unmatchedEmails.get(email) || 0) + 1);
      continue;
    }
    if (call.direction !== 'inbound' && call.direction !== 'outbound') {
      // Defensive only — every call sampled live was exactly one of these
      // two (matches the schema's CHECK constraint). Not expected to ever
      // fire; skipped rather than crashing the sync if Aircall ever adds
      // a third value.
      continue;
    }

    const aircallUserId = String(call.user.id);
    const callDate = pacificDateOf(call.started_at);
    const key = `${aircallUserId}|${callDate}|${call.direction}`;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        aircall_user_id: aircallUserId,
        staff_email: email,
        call_date: callDate,
        direction: call.direction,
        total_calls: 0,
        answered_calls: 0,
        missed_calls: 0,
        total_talk_seconds: 0,
        total_ring_seconds: 0,
      };
      buckets.set(key, bucket);
    }

    bucket.total_calls++;
    if (call.answered_at != null) {
      bucket.answered_calls++;
      // Computed directly from the three raw timestamps, never from
      // Aircall's own `duration` field — see aircall-connector.js LIVE
      // VERIFICATION #4 for why that field can't be trusted for this.
      const talk = call.ended_at - call.answered_at;
      const ring = call.answered_at - call.started_at;
      // Guard against a malformed/out-of-order timestamp producing a
      // negative contribution — never observed live, but a single bad
      // call silently pulling a whole day's average negative would be
      // worse than clamping it to 0 and moving on.
      bucket.total_talk_seconds += talk > 0 ? talk : 0;
      bucket.total_ring_seconds += ring > 0 ? ring : 0;
    } else {
      bucket.missed_calls++;
    }
    summary.calls_aggregated++;
  }

  summary.unmatched_emails = Array.from(unmatchedEmails.entries()).map(([email, count]) => ({ email, count }));
  return { rows: Array.from(buckets.values()), summary };
}

module.exports = { buildDailyAggregates };
