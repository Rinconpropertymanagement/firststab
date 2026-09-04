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

/**
 * Closes the gap buildDailyAggregates() deliberately leaves open: every
 * call.user === null call it skips (summary.calls_unattributed_no_user)
 * gets a row here instead, keyed by the shared LINE it came in on rather
 * than a person — see 20260904000000_call_stats_line_misses.sql for the
 * full grain/column reasoning. Runs over the exact same `calls` array
 * buildDailyAggregates() does, in the same sync pass (router.js fetches
 * Aircall once and calls both) — not a second Aircall fetch.
 *
 * LIVE VERIFICATION (Q, 2026-09-04) — done before writing this function,
 * re-checking against real data rather than guessing from
 * aircall-connector.js's existing notes (which verify call.user's shape
 * but not call.number's):
 *   - Fetched 573 real Rincon calls across 7 real Pacific days (134
 *     user-less). Every user-less call's `number` object has the fields
 *     this function reads: id (e.g. 848527), name (e.g. "Maintenance
 *     Hotline"), digits (e.g. "+1 800-525-5883") — confirmed against raw
 *     JSON, not assumed from the migration's comments.
 *   - 0/134 user-less calls had `number === null` too (the "no line info
 *     at all" edge case this function still guards defensively). Not
 *     observed live, but the migration doesn't rule it out, so it's
 *     handled below rather than assumed impossible.
 *   - The missed/answered signal is `call.answered_at == null` — the same
 *     field buildDailyAggregates() already keys missed_calls on for
 *     attributed calls, NOT `call.status` (every call sampled, user-less
 *     or not, had status exactly 'done' or 'initial' — never a status
 *     value meaning "missed"; missed_call_reason exists on some calls but
 *     isn't read here, per the migration's "don't invent columns beyond
 *     the confirmed need").
 *   - Confirms the schema's total_calls-as-superset design was the right
 *     call, not just defensive over-engineering: of 133 closed user-less
 *     calls in the sample, 105 were inbound+missed, but 3 were
 *     inbound+ANSWERED and 25 were outbound+answered (a shared line
 *     placing or answering a call with nobody individually credited) —
 *     total_calls and missed_calls are genuinely different numbers in
 *     real data, confirming they may NOT always be equal.
 *   - The ended_at === null in-progress case still occurs among user-less
 *     calls too (1/134 in the sample) — same skip as buildDailyAggregates.
 *
 * @param {Array} calls - the SAME raw Aircall call objects passed to
 *   buildDailyAggregates() for this sync run
 * @returns {{ rows: Array, summary: Object }}
 */
function buildLineMissAggregates(calls) {
  const buckets = new Map(); // key: aircall_number_id|call_date|direction
  const summary = {
    calls_seen: calls.length,
    calls_skipped_in_progress: 0, // ended_at still null at fetch time — same guard as buildDailyAggregates
    calls_with_user: 0, // call.user is set — not this table's concern, buildDailyAggregates handles these
    calls_unattributed_no_user: 0, // call.user === null and not in-progress — should equal buildDailyAggregates's own same-named count from this same sync run (cross-check)
    calls_skipped_no_number: 0, // call.user === null AND call.number === null too — no line to attribute to either; not observed live, guarded anyway
    calls_aggregated: 0, // actually written into a row below
  };

  for (const call of calls) {
    if (call.ended_at == null) {
      summary.calls_skipped_in_progress++;
      continue;
    }
    if (call.user) {
      summary.calls_with_user++;
      continue;
    }
    summary.calls_unattributed_no_user++;

    if (!call.number) {
      summary.calls_skipped_no_number++;
      continue;
    }
    if (call.direction !== 'inbound' && call.direction !== 'outbound') {
      // Defensive only, same reasoning as buildDailyAggregates's identical
      // check — every call sampled live was exactly one of these two.
      continue;
    }

    const aircallNumberId = String(call.number.id);
    const callDate = pacificDateOf(call.started_at);
    const key = `${aircallNumberId}|${callDate}|${call.direction}`;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        aircall_number_id: aircallNumberId,
        line_name: call.number.name || '',
        line_digits: call.number.digits || '',
        call_date: callDate,
        direction: call.direction,
        total_calls: 0,
        missed_calls: 0,
      };
      buckets.set(key, bucket);
    }
    // Aircall calls arrive in ascending started_at order (order=asc — see
    // aircall-connector.js) — refreshing name/digits on every call for
    // this bucket means the label ends up as the most-recently-seen one
    // for the day, so a mid-day rename in Aircall's own dashboard doesn't
    // leave a stale label. Display only, never the upsert key.
    if (call.number.name) bucket.line_name = call.number.name;
    if (call.number.digits) bucket.line_digits = call.number.digits;

    bucket.total_calls++;
    if (call.answered_at == null) {
      bucket.missed_calls++;
    }
    summary.calls_aggregated++;
  }

  return { rows: Array.from(buckets.values()), summary };
}

module.exports = { buildDailyAggregates, buildLineMissAggregates };
