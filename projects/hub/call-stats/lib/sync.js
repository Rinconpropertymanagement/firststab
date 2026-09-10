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

// hs_createdate arrives as an ISO-8601 UTC string (e.g.
// "2026-09-08T22:46:19.824Z" — confirmed live, see the migration header),
// not Aircall's unix seconds. pacificDateOf() itself only needs unix
// seconds to do its Intl-based Pacific-day conversion — this just gets an
// ISO string into that same unit rather than duplicating the timezone
// logic for a second input format.
function pacificDateOfIso(isoString) {
  return pacificDateOf(Date.parse(isoString) / 1000);
}

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
 *     value meaning "missed". (This note originally added "missed_call_reason
 *     exists on some calls but isn't read here, per the migration's 'don't
 *     invent columns beyond the confirmed need'." That stopped being true on
 *     2026-09-10, when a confirmed need arrived — see MISS REASONS AND
 *     VOICEMAILS below. `answered_at` is still the missed/answered signal;
 *     the reason only explains a miss, it never decides whether there was
 *     one.)
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
 * ============================================================
 * SOLE-USER ATTRIBUTION (added 2026-09-10) — the second argument
 * ============================================================
 * Each row now also carries WHO the line rang that day, snapshotted here at
 * sync time and never recomputed afterwards:
 *
 *   sole_user_email  the ONE staff member this line rang, lower-cased, or
 *                    null if it rang nobody or rang several people
 *   ring_user_count  how many people it rang (0, 1 or 3 in Rincon's data)
 *
 * Why the snapshot rather than a lookup at dashboard time: Dio Lopes is the
 * sole user of "Property Manager - Solimar," which accounted for 35 misses
 * in four weeks. If that line changes hands in November and attribution
 * were computed from the line's CURRENT sole user, all 35 of Dio's August
 * misses would silently become someone else's, and a number Peter read out
 * in a September staff meeting would be a different number with nothing
 * recording that it changed. Full reasoning: Design Decision 11 in
 * answer-rate-redefinition-SPEC.md and the migration header.
 *
 * *** NULL sole_user_email MEANS "NO SOLE USER THAT DAY." IT MUST NEVER
 * MEAN "WE COULD NOT FIND OUT." *** If the mapping fetch fails, the CALLER
 * fails the line-miss half of the sync loudly and skips its upserts,
 * leaving the day re-runnable — it does not call this function with a
 * partial or empty map. That is why `lineRingMembership` is a required
 * argument with no default: an accidental call with nothing passed throws
 * here rather than quietly writing a day's worth of rows that look like a
 * day on which no line rang anybody. That failure would be permanent,
 * silent and self-concealing — it would understate real people's misses
 * forever, with nothing on the row to say otherwise.
 *
 * ============================================================
 * MISS REASONS AND VOICEMAILS (added 2026-09-10) — three more columns
 * ============================================================
 * Each row now also records WHY its misses were missed, and how many
 * callers left a message:
 *
 *   missed_calls_agents_did_not_answer  the ONLY reason that counts against
 *                                       a person (Peter, 2026-09-10)
 *   missed_calls_by_reason              the complete reason -> count map for
 *                                       this row's MISSED calls
 *   voicemails_left                     a COUNT. never the URL.
 *
 * Why the split: `no_available_agent` is Kristen switching to the phone tree
 * at lunch plus her 9am start — a schedule, not a performance failure — and
 * `short_abandoned` is the caller hanging up after a median of nine seconds,
 * which nobody could have answered. Both stay visible and are charged to
 * nobody. Full reasoning in migration
 * 20260910020000_add_miss_reason_and_voicemail_to_call_stats_line_misses.sql.
 *
 * *** NULL ON THESE THREE MEANS "NOT MEASURED" — THE OPPOSITE OF
 * sole_user_email. *** This function always writes all three (the all-or-none
 * CHECK rejects a partial row), so every row IT produces is measured. Rows
 * written before this change exist with all three NULL and must never be read
 * as zero — that is the reader's problem, handled in lib/metrics.js and
 * router.js.
 *
 * *** THE VOICEMAIL URL IS NEVER READ INTO A VARIABLE THAT IS STORED OR
 * LOGGED. *** `call.voicemail` is a link to a recording of a tenant's or
 * owner's own voice, barred by SPEC.md's "Explicitly Out of Scope" in
 * absolute terms. The only thing this function ever asks of it is whether it
 * is null. Do not add a column, a variable or a log line that carries it —
 * that line gets crossed by accident while debugging, not on purpose.
 * (`call.asset`, `call.recording`, `call.recording_short_url` and
 * `call.voicemail_short_url` are the same category and are likewise never
 * read here.)
 *
 * LIVE VERIFICATION (Q, 2026-09-10) — done BEFORE writing any of this,
 * against raw JSON from 822 real Rincon calls, Pacific 2026-09-01..09-10,
 * because Neo flagged both field names as reported-but-not-re-verified:
 *   - Both keys are present on EVERY call object returned by the same
 *     GET /v1/calls the sync already makes: missed_call_reason 822/822,
 *     voicemail 822/822. No per-call detail fetch is needed and none is
 *     added (migration NOTES FOR Q #8).
 *   - `missed_call_reason` is a STRING on inbound+missed calls and null
 *     everywhere else — null on all 245 inbound-answered, all 381
 *     outbound-answered, AND all 26 outbound-missed calls in the sample.
 *     So an outbound miss reports no reason at all and lands under
 *     "(no reason reported)" by design, not by accident.
 *   - *** SIX distinct values appeared, not the three in the build brief. ***
 *     The brief's three were measured on Kristen's two lines only; across the
 *     whole account the same ten days also produced `out_of_opening_hours`
 *     (6), `abandoned_in_ivr` (5) and `abandoned_in_classic` (4). This is the
 *     exact scenario the JSONB map exists for, arriving on day one rather
 *     than hypothetically: a fixed set of per-reason columns built from the
 *     brief would have silently dropped 15 real misses, four of them on
 *     "Property Manager - Faria," a SOLE-USER line (Marci Gray). The full
 *     live split: agents_did_not_answer 75, no_available_agent 60,
 *     short_abandoned 19, out_of_opening_hours 6, abandoned_in_ivr 5,
 *     abandoned_in_classic 4.
 *   - The brief's Kristen figures reproduce exactly: her two lines
 *     (Office Line + Business Development Coordinator) total 41 misses =
 *     21 agents_did_not_answer + 16 no_available_agent + 4 short_abandoned,
 *     with 18 voicemails. That is what confirms the field is the right one.
 *   - `voicemail` is null or an https URL string — never any other type.
 *     69 of 822 were non-null and EVERY ONE was an inbound MISSED call
 *     (0 on answered calls of either direction, 0 on outbound misses).
 *     Not asserted as impossible, though: it is counted over every call on
 *     the row, matching the column's own definition and the schema's choice
 *     to bound voicemails_left by total_calls rather than missed_calls.
 *   - Voicemails do NOT track miss volume: 37 of 75 agents_did_not_answer,
 *     30 of 60 no_available_agent, 2 of 4 abandoned_in_classic, and 0 of the
 *     other three reasons. The fact carries real information, which is why
 *     it is captured.
 *
 * @param {Array} calls - the SAME raw Aircall call objects passed to
 *   buildDailyAggregates() for this sync run
 * @param {Map<string, {line_name:string, ring_user_count:number,
 *   sole_user_email:string|null, sole_user_name:string|null}>}
 *   lineRingMembership - from aircall-connector's
 *   fetchLineRingMembership(), keyed by the line's Aircall number ID as a
 *   string. REQUIRED — see above.
 * @returns {{ rows: Array, summary: Object }}
 */

// The Aircall `missed_call_reason` value that — and only which — counts
// against a person. Named as a constant used in exactly one place, because
// the string is a vendor's enum value and a typo in it would not fail: it
// would silently charge everyone zero misses. The column name in the schema
// spells it out verbatim for the same reason.
const CHARGEABLE_MISS_REASON = 'agents_did_not_answer';

// The key a miss with no reason at all is counted under. Spaces and
// parentheses so it can never collide with an Aircall enum value (migration
// NOTES FOR Q #5). Every miss must be counted somewhere in the map or the
// sum invariant breaks — this is where the ones Aircall says nothing about
// go, and in real data that is every OUTBOUND miss.
const NO_REASON_KEY = '(no reason reported)';

// The six values seen live on 2026-09-10 across 822 real calls. This set is
// NOT a filter and NOT a validator — an unrecognized value is written into
// the map unmodified either way (migration NOTES FOR Q #6). Its only job is
// to decide whether the sync SHOUTS about a value nobody has seen before, so
// a new Aircall enum surfaces the next morning instead of sitting quietly in
// a blob for a month. Adding a value here after it has been reviewed is a
// one-line change; leaving it out costs nothing but a log line.
const KNOWN_MISS_REASONS = new Set([
  'agents_did_not_answer',
  'no_available_agent',
  'short_abandoned',
  'out_of_opening_hours',
  'abandoned_in_ivr',
  'abandoned_in_classic',
]);

function buildLineMissAggregates(calls, lineRingMembership) {
  // NON-EMPTY is part of the requirement, not a nicety. `instanceof Map`
  // alone rejects undefined, null and plain objects but waves an empty Map
  // straight through — and an empty Map is the single most dangerous input
  // this function can receive, because every line then misses the mapping
  // and every row gets written with both attribution columns NULL, which is
  // exactly the "we could not find out" masquerading as "no sole user" the
  // comment above forbids. Rincon has 15 lines; a mapping with zero entries
  // is a failed fetch wearing a success's clothes, never a real account
  // state. The connector refuses the empty case at source too — this guard
  // stays so the contract holds for any future caller, not just that one.
  if (!(lineRingMembership instanceof Map) || lineRingMembership.size === 0) {
    throw new Error('buildLineMissAggregates() requires a NON-EMPTY line ring-membership Map. Refusing to write line-miss rows with no attribution — a NULL sole_user_email means "this line had no sole user that day" and must never be produced to mean "the mapping was unavailable."');
  }

  const buckets = new Map(); // key: aircall_number_id|call_date|direction
  const summary = {
    calls_seen: calls.length,
    calls_skipped_in_progress: 0, // ended_at still null at fetch time — same guard as buildDailyAggregates
    calls_with_user: 0, // call.user is set — not this table's concern, buildDailyAggregates handles these
    calls_unattributed_no_user: 0, // call.user === null and not in-progress — should equal buildDailyAggregates's own same-named count from this same sync run (cross-check)
    calls_skipped_no_number: 0, // call.user === null AND call.number === null too — no line to attribute to either; not observed live, guarded anyway
    calls_aggregated: 0, // actually written into a row below
    // ── Attribution counters (rows, not calls) ──────────────────────────
    rows_attributed_to_sole_user: 0, // ring_user_count === 1 AND an email was resolved
    rows_line_rings_nobody: 0, // ring_user_count === 0 — Maintenance Hotline, Leasing Line
    rows_line_rings_several: 0, // ring_user_count > 1 — the two phone-tree lines
    // ── Data-quality ALARMS. Both mean a real miss may be going uncharged.
    // Named loudly, surfaced in the sync result, and logged by the caller —
    // never silently absorbed.
    rows_sole_user_email_unresolved: 0, // ring_user_count === 1 but no email could be found for that one user
    rows_line_missing_from_mapping: 0, // a line that appears in call data but not in Aircall's own line list
    unresolved_sole_user_lines: [], // { aircall_number_id, line_name } — filled below
    lines_missing_from_mapping: [], // { aircall_number_id, line_name } — filled below
    // ── Miss reasons and voicemails (added 2026-09-10) ──────────────────
    miss_reasons_seen: {}, // reason -> count, across every row this run wrote
    missed_calls_agents_did_not_answer: 0, // the run's total of the one charged reason
    voicemails_left: 0,
    // A THIRD ALARM, and the one most likely to matter later: an Aircall
    // miss reason nobody has seen before. It is DATA, not an error — written
    // into the map under whatever string Aircall sent, unmodified, never
    // normalized into "other" and never dropped (migration NOTES FOR Q #6).
    // Counted and named here purely so the caller can shout about it.
    unrecognized_miss_reasons: [], // { reason, count } — filled below
  };
  // Distinct lines, so a busy day doesn't repeat the same alarm 35 times.
  const unresolvedSoleUserLines = new Map();
  const linesMissingFromMapping = new Map();
  const missReasonsSeen = new Map();
  const unrecognizedMissReasons = new Map();

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
      const membership = lineRingMembership.get(aircallNumberId);

      // The mapping is per LINE and the columns live on a per-(line, day,
      // direction) row, so it is stamped once when the bucket is created
      // and never touched again below. Written onto OUTBOUND rows too, not
      // just inbound: "which staff member did this line ring on this day"
      // is a fact about the line, not about a direction. Only inbound rows
      // are ever read back into a person's Answer Rate (an outbound call
      // the other party didn't pick up is not a staff responsiveness
      // signal), but recording it on both keeps the column's meaning
      // uniform and costs nothing.
      let soleUserEmail = null;
      let ringUserCount = null;

      if (!membership) {
        // This line appeared in real call data but is not in Aircall's own
        // line list. Realistically: a line deleted between the call day and
        // this sync run, which is a wider window on a manual ?date= re-run
        // of an old day than on the nightly job.
        //
        // JUDGMENT CALL, recorded rather than buried — the migration's
        // NOTES FOR Q cover a mapping FETCH failure (fail loud, skip every
        // upsert) but not a single line missing from an otherwise-good
        // mapping. Both columns are left NULL and the row is still WRITTEN,
        // for two reasons. First, dropping the row would delete real misses
        // from the dashboard's totals, and nothing is allowed to go missing
        // between the attributed and unattributed sections (NOTES FOR Q
        // #5). Second, an unknown-membership line is unattributed under
        // Peter's rule regardless — attribution requires positively
        // identifying a sole user, which cannot be done here. What makes
        // this different from the forbidden case is scope and visibility: a
        // failed fetch would mark EVERY line as "no sole user" silently and
        // permanently, whereas this is one named line, counted in
        // rows_line_missing_from_mapping and logged loudly by the caller.
        // ring_user_count stays NULL rather than 0 so the row does not
        // claim "this line rang nobody" — a fact this run does not have.
        summary.rows_line_missing_from_mapping++;
        if (!linesMissingFromMapping.has(aircallNumberId)) {
          linesMissingFromMapping.set(aircallNumberId, {
            aircall_number_id: aircallNumberId,
            line_name: call.number.name || '',
          });
        }
      } else {
        ringUserCount = membership.ring_user_count;
        if (membership.ring_user_count === 1) {
          if (membership.sole_user_email) {
            soleUserEmail = membership.sole_user_email; // already lower-cased by the connector
            summary.rows_attributed_to_sole_user++;
          } else {
            // The line rang exactly one person and their email could not be
            // resolved. Allowed by the table's CHECK constraint and
            // deliberately so — it is self-describing, because
            // ring_user_count = 1 is sitting right there. But it means a
            // genuinely chargeable miss is going uncharged, so it is an
            // alarm, not a shrug.
            summary.rows_sole_user_email_unresolved++;
            if (!unresolvedSoleUserLines.has(aircallNumberId)) {
              unresolvedSoleUserLines.set(aircallNumberId, {
                aircall_number_id: aircallNumberId,
                line_name: membership.line_name || call.number.name || '',
              });
            }
          }
        } else if (membership.ring_user_count === 0) {
          summary.rows_line_rings_nobody++;
        } else {
          summary.rows_line_rings_several++;
        }
      }

      bucket = {
        aircall_number_id: aircallNumberId,
        line_name: call.number.name || '',
        line_digits: call.number.digits || '',
        call_date: callDate,
        direction: call.direction,
        total_calls: 0,
        missed_calls: 0,
        sole_user_email: soleUserEmail,
        ring_user_count: ringUserCount,
        // All three initialised together and always written together — the
        // table's all-or-none CHECK rejects a partial row, and there is no
        // legitimate partial state because all three come off the same call
        // array in the same loop below (migration NOTES FOR Q #3). A row
        // this function creates is therefore always MEASURED; the NULL
        // "not measured" state belongs only to rows written before this
        // change and is never produced here.
        missed_calls_agents_did_not_answer: 0,
        missed_calls_by_reason: {},
        voicemails_left: 0,
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

      // The reason key, taken verbatim from Aircall or replaced by the
      // literal no-reason key. NOT normalized, NOT bucketed into "other",
      // NOT matched against KNOWN_MISS_REASONS before being counted — an
      // unrecognized value is real data about real misses and lands in the
      // map exactly as Aircall sent it. Confirmed live 2026-09-10 that this
      // enum is wider than the build brief described (six values, not
      // three), which is precisely why the map has no key CHECK.
      const rawReason = call.missed_call_reason;
      const reasonKey = (typeof rawReason === 'string' && rawReason.trim())
        ? rawReason.trim()
        : NO_REASON_KEY;

      bucket.missed_calls_by_reason[reasonKey] = (bucket.missed_calls_by_reason[reasonKey] || 0) + 1;
      if (reasonKey === CHARGEABLE_MISS_REASON) bucket.missed_calls_agents_did_not_answer++;

      missReasonsSeen.set(reasonKey, (missReasonsSeen.get(reasonKey) || 0) + 1);
      if (reasonKey !== NO_REASON_KEY && !KNOWN_MISS_REASONS.has(reasonKey)) {
        unrecognizedMissReasons.set(reasonKey, (unrecognizedMissReasons.get(reasonKey) || 0) + 1);
      }
    }

    // Counted over EVERY call on the row, answered or missed — matching the
    // column's own definition and the schema's decision to bound
    // voicemails_left by total_calls rather than missed_calls. Live data
    // says every voicemail sits on an inbound miss (69/69 on 2026-09-10),
    // but the schema deliberately declines to assert that is impossible and
    // so does this.
    //
    // *** THE URL ITSELF IS NEVER READ. *** The only question asked of
    // `call.voicemail` is whether it is null. It is not assigned to a
    // variable, not logged, not returned, not stored. See this function's
    // header.
    if (call.voicemail != null) bucket.voicemails_left++;

    summary.calls_aggregated++;
  }

  // ── The two invariants the schema CANNOT enforce (NOTES FOR Q #4) ──────
  // Both are cheap, both are checked on every row, and both throw rather
  // than warn. A violation here is a code bug, not a data condition: all
  // three values come off the same call array in the same loop above, so
  // they cannot legitimately disagree. Throwing routes this into router.js's
  // existing fail-loud path — no line-miss rows written, 502, day
  // re-runnable — which is the correct outcome for "this run's arithmetic
  // does not add up." Writing the rows anyway and letting the CHECK
  // constraints catch what they can would leave (a) uncaught entirely:
  // Postgres cannot express "the map's values sum to missed_calls" without
  // a non-immutable aggregate over JSONB.
  for (const b of buckets.values()) {
    const reasonSum = Object.values(b.missed_calls_by_reason).reduce((a, n) => a + n, 0);
    if (reasonSum !== b.missed_calls) {
      throw new Error(`buildLineMissAggregates() invariant (a) FAILED on ${b.aircall_number_id}|${b.call_date}|${b.direction}: missed_calls_by_reason sums to ${reasonSum} but missed_calls is ${b.missed_calls}. Every miss must be counted under exactly one reason key. Refusing to write a row whose reason breakdown does not account for all of its misses.`);
    }
    const fromMap = b.missed_calls_by_reason[CHARGEABLE_MISS_REASON] || 0;
    if (fromMap !== b.missed_calls_agents_did_not_answer) {
      throw new Error(`buildLineMissAggregates() invariant (b) FAILED on ${b.aircall_number_id}|${b.call_date}|${b.direction}: typed column says ${b.missed_calls_agents_did_not_answer} but the map's '${CHARGEABLE_MISS_REASON}' entry says ${fromMap}. These must be equal — the typed column IS the map entry, denormalized so the one number that charges a named employee has a real integer type.`);
    }
    summary.missed_calls_agents_did_not_answer += b.missed_calls_agents_did_not_answer;
    summary.voicemails_left += b.voicemails_left;
  }

  summary.unresolved_sole_user_lines = Array.from(unresolvedSoleUserLines.values());
  summary.lines_missing_from_mapping = Array.from(linesMissingFromMapping.values());
  summary.miss_reasons_seen = Object.fromEntries(Array.from(missReasonsSeen.entries()).sort((a, b) => b[1] - a[1]));
  summary.unrecognized_miss_reasons = Array.from(unrecognizedMissReasons.entries()).map(([reason, count]) => ({ reason, count }));
  return { rows: Array.from(buckets.values()), summary };
}

/**
 * Turns a batch of raw HubSpot VOIP call records (already filtered to
 * hs_call_source='VOIP' and to/from a tracked number by
 * hubspot-connector.js's own search filter) into the
 * one-row-per-(tracked phone number, day, direction) shape
 * call_stats_hubspot_native_calls expects — see the migration header
 * (20260908000000_call_stats_hubspot_native.sql) for the full grain/column
 * reasoning. Pure aggregation, no network/database calls, same split from
 * router.js as buildDailyAggregates/buildLineMissAggregates above.
 *
 * Per the migration header's own flagged items — not left to guesswork:
 *   - hs_call_duration is a STRING OF MILLISECONDS (confirmed live, e.g.
 *     "214000" = 214 seconds) — converted to seconds here before it's ever
 *     written to total_talk_seconds. The raw value is never inserted.
 *   - hs_call_direction is UPPERCASE ("INBOUND"/"OUTBOUND") — a different
 *     casing convention than Aircall's own lowercase values. Lowercased
 *     here before use so it matches this schema's shared `direction` CHECK
 *     (call_stats, call_stats_line_misses, and this table all use the same
 *     lowercase convention).
 *   - OPEN ITEM (named in the migration header, not resolved here):
 *     hs_call_status's real observed values are COMPLETED, MISSED, BUSY,
 *     and QUEUED. Only COMPLETED (-> answered_calls) and MISSED (->
 *     missed_calls) are bucketed. BUSY and QUEUED are counted in
 *     total_calls but bucketed into neither column — inventing that
 *     mapping now, on a single sampled QUEUED example, would be a guess
 *     dressed up as a confirmed decision. `total_calls - answered_calls -
 *     missed_calls` on the resulting row is always a real, inspectable
 *     "other status" count, never silently dropped data.
 *   - OPEN ITEM (not resolved here, flagged rather than guessed): a call
 *     that touches TWO tracked numbers at once (e.g. two Rincon staff
 *     members who both have a HubSpot-native line, calling each other) is
 *     credited to both numbers, using the SAME hs_call_direction value for
 *     each — HubSpot exposes one direction per call record, not one per
 *     party, so this can only be exactly correct for one side of such a
 *     call. Not observed in the one real tracked number (Kristen Rau's)
 *     live-verified so far; not designed around further on a guess.
 *
 * @param {Array} calls - flattened HubSpot call records from
 *   hubspot-connector.js's listVoipCallsForNumbers() — real property names
 *   throughout (hs_call_direction, hs_call_duration, etc.)
 * @param {Set<string>} trackedPhoneNumbers - the exact E.164 strings from
 *   call_stats_hubspot_native_numbers.phone_number this sync run is
 *   tracking, built by the caller from a fresh table read. Resolving a
 *   phone number to a staff name/pod happens at DASHBOARD read time (a
 *   join through call_stats_hubspot_native_numbers -> users), not needed
 *   here — same "look it up live, don't copy it onto the row" discipline
 *   buildDailyAggregates() already uses for staff pod.
 * @returns {{ rows: Array, summary: Object }}
 */
function buildHubspotDailyAggregates(calls, trackedPhoneNumbers) {
  const buckets = new Map(); // key: phone_number|call_date|direction
  const summary = {
    calls_seen: calls.length,
    calls_skipped_no_tracked_number: 0, // neither from nor to matched a tracked number — shouldn't happen if the connector's own search filter did its job, but this sync doesn't trust that blindly, same "log it, don't silently assume" discipline as buildDailyAggregates's calls_unmatched_email
    calls_skipped_bad_direction: 0, // hs_call_direction wasn't INBOUND/OUTBOUND — defensive only, every real call sampled live was exactly one of these two (matches this schema's CHECK constraint)
    calls_status_completed: 0,
    calls_status_missed: 0,
    calls_status_other: 0, // BUSY / QUEUED / any future value — see "OPEN ITEM: QUEUED / BUSY" in this function's own header comment above
    rows_contributed: 0, // number of (number, date, direction) bucket contributions written below — can exceed calls_seen if a call touches two tracked numbers (see the "two tracked numbers" OPEN ITEM above)
  };

  for (const call of calls) {
    const direction = String(call.hs_call_direction || '').toLowerCase();
    if (direction !== 'inbound' && direction !== 'outbound') {
      summary.calls_skipped_bad_direction++;
      continue;
    }

    const touchedNumbers = [];
    if (call.hs_call_from_number && trackedPhoneNumbers.has(call.hs_call_from_number)) {
      touchedNumbers.push(call.hs_call_from_number);
    }
    if (call.hs_call_to_number && trackedPhoneNumbers.has(call.hs_call_to_number) && call.hs_call_to_number !== call.hs_call_from_number) {
      touchedNumbers.push(call.hs_call_to_number);
    }
    if (touchedNumbers.length === 0) {
      summary.calls_skipped_no_tracked_number++;
      continue;
    }

    const callDate = pacificDateOfIso(call.hs_createdate);
    const status = String(call.hs_call_status || '').toUpperCase();
    // hs_call_duration is a STRING OF MILLISECONDS (confirmed live) — never
    // insert the raw value. Guarded against a missing/non-numeric value the
    // same defensive way buildDailyAggregates guards a negative timestamp
    // delta: fall back to 0 rather than writing NaN.
    const durationMs = Number(call.hs_call_duration) || 0;
    const durationSeconds = durationMs > 0 ? Math.round(durationMs / 1000) : 0;

    if (status === 'COMPLETED') summary.calls_status_completed++;
    else if (status === 'MISSED') summary.calls_status_missed++;
    else summary.calls_status_other++;

    for (const phoneNumber of touchedNumbers) {
      const key = `${phoneNumber}|${callDate}|${direction}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          phone_number: phoneNumber,
          call_date: callDate,
          direction,
          total_calls: 0,
          answered_calls: 0,
          missed_calls: 0,
          total_talk_seconds: 0,
        };
        buckets.set(key, bucket);
      }
      // Every call seen for this number/day/direction, regardless of
      // status — a deliberate superset of answered_calls + missed_calls,
      // same reasoning call_stats_line_misses.total_calls already uses
      // relative to its own missed_calls (see this function's header).
      bucket.total_calls++;
      if (status === 'COMPLETED') {
        bucket.answered_calls++;
        bucket.total_talk_seconds += durationSeconds;
      } else if (status === 'MISSED') {
        bucket.missed_calls++;
      }
      // BUSY / QUEUED / anything else: counted in total_calls above,
      // bucketed into neither answered_calls nor missed_calls — see this
      // function's header "OPEN ITEM: QUEUED / BUSY bucketing."
      summary.rows_contributed++;
    }
  }

  return { rows: Array.from(buckets.values()), summary };
}

module.exports = {
  buildDailyAggregates,
  buildLineMissAggregates,
  buildHubspotDailyAggregates,
  // Exported so the backfill script and any test reuse the SAME strings this
  // aggregation uses rather than retyping them. A second copy of
  // 'agents_did_not_answer' that drifts by one character would not fail — it
  // would silently charge everybody zero misses.
  CHARGEABLE_MISS_REASON,
  NO_REASON_KEY,
  KNOWN_MISS_REASONS,
};
