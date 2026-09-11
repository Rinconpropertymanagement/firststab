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
// Required directly, the same way ./timezone is, because the rule it carries
// belongs to the AGGREGATION and not to any one caller — see the LINE
// OWNERSHIP HISTORY section further down for why it is applied here rather
// than in backfill-six-months.js.
const { LINE_OWNERSHIP_HISTORY } = require('./line-ownership-history');

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
 * against raw JSON from Pacific 2026-09-01..09-10, because Neo flagged both
 * field names as reported-but-not-re-verified.
 *
 * *** EVERY COUNT BELOW IS A SNAPSHOT TAKEN ON 2026-09-10, NOT A FIXED
 * TOTAL. *** The window ends on a day that was still in progress, so the
 * counts grow by the hour: this pass read 822 calls, TARS re-read the same
 * window later the same day and got 854. The counts are here to show SHAPE —
 * which fields exist, what types they carry, how many distinct values turned
 * up — and any of them can be re-measured to a different number without
 * anything being wrong. Nothing in the code depends on a count below.
 *
 *   - Both keys are present on EVERY call object returned by the same
 *     GET /v1/calls the sync already makes: missed_call_reason on all 822,
 *     voicemail on all 822. No per-call detail fetch is needed and none is
 *     added (migration NOTES FOR Q #8).
 *   - `missed_call_reason` is a STRING on inbound+missed calls and null on
 *     essentially everything else — null on all 245 inbound-answered, all
 *     381 outbound-answered, and all 26 outbound-missed calls in this
 *     sample. An outbound miss therefore USUALLY reports no reason at all
 *     and lands under "(no reason reported)".
 *
 *     *** IT IS NOT "BY DESIGN" AND IT IS NOT ALWAYS. *** This comment used
 *     to say an outbound miss carries no reason by design. TARS disproved it
 *     over six months on 2026-09-10: 1 of 78 outbound misses does carry one
 *     — 2026-06-26, Maintenance Hotline, `short_abandoned`. The ten-day
 *     sample above simply did not contain the exception. Nothing breaks:
 *     that reason is stored verbatim like any other, and an outbound row is
 *     never read into anybody's Answer Rate, so it charges no one either
 *     way. The claim is corrected because a stated absolute is what a future
 *     reader would build on.
 *   - *** SIX distinct values appeared, not the three in the build brief. ***
 *     The brief's three were measured on Kristen's two lines only; across the
 *     whole account the same ten days also produced `out_of_opening_hours`
 *     (6), `abandoned_in_ivr` (5) and `abandoned_in_classic` (4). This is the
 *     exact scenario the JSONB map exists for, arriving on day one rather
 *     than hypothetically: a fixed set of per-reason columns built from the
 *     brief would have silently dropped 15 real misses, four of them on
 *     "Property Manager - Faria," a SOLE-USER line (Marci Gray). The split at
 *     the moment of this read: agents_did_not_answer 75, no_available_agent
 *     60, short_abandoned 19, out_of_opening_hours 6, abandoned_in_ivr 5,
 *     abandoned_in_classic 4. A later read the same day gave 80 / 61 / 19 for
 *     the first three — 09-10 was still filling up. SIX DISTINCT VALUES is
 *     the finding here; the counts are illustration, not a total.
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

// The six values seen live in the 2026-09-10 sample of real calls. This set is
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

/**
 * The key a miss is counted under when Aircall sends a `missed_call_reason`
 * that is not a usable string — a number, an object, a boolean, an empty
 * string. Added 2026-09-10: before this, anything that was not a non-empty
 * string fell silently into "(no reason reported)" alongside the outbound
 * misses that legitimately have no reason, so a real change in a vendor's
 * response shape would have looked exactly like normal traffic.
 *
 * Same parentheses convention as NO_REASON_KEY, so it can never collide with
 * an Aircall enum value, and deliberately NOT in KNOWN_MISS_REASONS — that is
 * what routes it into summary.unrecognized_miss_reasons and gets it shouted
 * about by router.js the next morning, exactly like an unrecognized string.
 *
 * The value is rendered into the key rather than discarded, because "Aircall
 * sent a number" is a much less useful alarm than "Aircall sent 7". Bounded
 * and try/catch'd rather than trusted: this is a vendor-controlled value on
 * its way into a JSONB key, and JSON.stringify throws on a circular object or
 * a BigInt. Considered and rejected: String(rawReason), which is shorter but
 * can be hijacked by a Symbol.toPrimitive that throws, and renders every
 * distinct object as the same "[object Object]".
 */
function unexpectedReasonKey(rawReason) {
  const kind = Array.isArray(rawReason) ? 'array' : typeof rawReason;
  let rendered;
  try {
    rendered = JSON.stringify(rawReason);
  } catch {
    rendered = null;
  }
  if (typeof rendered !== 'string') rendered = '(unrenderable)';
  if (rendered.length > 40) rendered = rendered.slice(0, 40) + '...';
  return `(unexpected ${kind} reason: ${rendered})`;
}

/* ============================================================
 * LINE OWNERSHIP HISTORY (added 2026-09-10) — the departed-employee guard
 * ============================================================
 * Attribution below charges an unnamed call to whoever rings that line
 * TODAY. That is correct for a line nobody has left, and silently wrong for
 * a line whose worker has since been deleted from Aircall: deleting a seat
 * STRIPS the `user` field from every call that person ever handled, so their
 * whole history arrives here anonymous and lands on their replacement. On
 * Rincon's real data that is 1,257 of Aldo Hernandez's calls landing on Leo
 * O'Gorman, moving Leo's answer rate 75.9% -> 77.0% — small enough that
 * nothing would have looked wrong in the meeting. lib/line-ownership-history.js
 * holds the dated list of "do not attribute this line before this date" and
 * its header carries the full reasoning, including why it is a file and not a
 * table. Do not re-litigate that here.
 *
 * SINCE 2026-09-11 THAT FILE CAN ALSO REDIRECT A PERIOD RATHER THAN ONLY
 * WITHHOLD IT: a CLOSED period may name one person's email, and this
 * aggregation stamps it as that row's sole_user_email. Peter enabled it for
 * Leo O'Gorman's six months on Maintenance Coordinator-Solimar, where
 * withholding produced a flattering 99.8% in place of his real 76.5%. An email
 * on a RUNNING period stays illegal and the loader throws on it — that rule is
 * what keeps this file from becoming a stale second copy of Aircall's live
 * configuration, and it is enforced, not merely documented.
 *
 * APPLIED HERE, IN THE AGGREGATION, rather than in backfill-six-months.js.
 * Both the nightly sync and the backfill call this one function, so the rule
 * reaches the `?date=` manual re-run path too — which is the one that matters
 * most: putting it in the backfill would leave re-running a single April day
 * free to re-stamp today's mapping and quietly re-credit Aldo's calls to Leo,
 * one day at a time, after the backfill had already been corrected.
 */

// "Is this a real calendar date?", local to this module on purpose. router.js
// and backfill-six-months.js each carry their own copy; a fourth here is two
// lines of arithmetic, whereas hoisting one shared copy into lib/timezone.js
// would change a module three other things already depend on for a change
// that is not about timezones. Considered and rejected on that basis alone —
// if a fifth copy ever appears, hoist all five at once.
function isRealCalendarDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return false;
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return !isNaN(parsed.getTime())
    && parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

/**
 * "Is this `attribute_to` value an email naming one person?" — the shape
 * test, and deliberately a strict one.
 *
 * DELIBERATELY NOT A FULL RFC 5322 PARSER, and deliberately not a loose
 * `includes('@')` either. What it has to catch is a TYPO, because a typo'd
 * email is the one failure mode that is completely invisible downstream: the
 * row gets written with ring_user_count = 1 and an email nothing can resolve,
 * isAttributableLineMissRow() drops it to unattributed, and the person it was
 * meant to credit reads exactly the flattering number the `null` behaviour
 * produced — with nothing anywhere saying so. Shape alone cannot catch
 * `leoo@rinconmanagement.com`; that is what
 * crossCheckLineOwnershipNamedEmails() below is for. This catches the rest.
 *
 * LOWER-CASE IS REQUIRED RATHER THAN NORMALISED. Every email in this system is
 * keyed lower-cased — the Aircall connector lower-cases sole_user_email before
 * it is ever stored, metrics.js's gate is handed a lower-cased string, and the
 * `users` lookups are built on lower-cased keys. Silently lower-casing here
 * would work, and it would also mean the file says one thing and the rows say
 * another. Rejecting is the same stance this loader already takes on a numeric
 * aircall_number_id that would have coerced fine: the shape of this file is
 * the thing being vouched for.
 */
function isNamedEmail(value) {
  return typeof value === 'string'
    && value === value.toLowerCase()
    && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);
}

/**
 * Validates lib/line-ownership-history.js and indexes it by line, ONCE, at
 * module load. Throws on anything it cannot vouch for.
 *
 * *** IT THROWS AT REQUIRE TIME, WHICH STOPS THE HUB SERVER FROM STARTING.
 * THAT IS THE INTENDED SEVERITY. *** A malformed entry in that file is not a
 * data condition, it is a code defect in a file that ships with this code —
 * indistinguishable in kind from a syntax error in it, which already refuses
 * to load. The alternative considered and rejected was validating lazily on
 * the first aggregation, which would keep the rest of the Hub up but move the
 * failure to 2am, where a bad entry becomes a nightly 502 instead of a deploy
 * that visibly refuses to come up. The protective effect is identical either
 * way — nothing can attribute a row with an unvalidated file in hand — so the
 * choice is purely about when somebody finds out, and sooner is better.
 *
 * The failure this exists to catch is a TYPO'D aircall_number_id: nothing
 * else in the system would notice. The entry simply never matches, Leo gets
 * charged again, and no log line anywhere says so. Everything else validated
 * here is cheap by comparison and checked in the same pass. The half of that
 * check which needs Aircall's live line list is in
 * crossCheckLineOwnershipAgainstMapping() below — a well-formed ID that no
 * longer exists in Aircall is the same silent failure by a different route.
 */
function validateAndIndexLineOwnershipHistory(entries) {
  const fail = (detail) => {
    throw new Error(
      `lib/line-ownership-history.js is INVALID — refusing to load. ${detail} ` +
      'This file decides which historical calls are NOT charged to the person who rings a line today. ' +
      'Running with an entry that cannot be trusted would silently re-charge a departed employee\'s calls to their replacement, which is the exact failure the file exists to prevent. Fix the entry; do not work around this.'
    );
  };

  if (!Array.isArray(entries)) fail('LINE_OWNERSHIP_HISTORY is not an array.');

  const byNumber = new Map();
  const seenPeriods = new Set();

  entries.forEach((entry, i) => {
    const at = `Entry ${i}${entry && entry.line_name ? ` ("${entry.line_name}")` : ''}:`;
    if (!entry || typeof entry !== 'object') fail(`${at} not an object.`);

    // STRING, not a number. sync.js buckets on String(call.number.id), so a
    // numeric literal here would still coerce to a matching key — but it is
    // rejected rather than coerced, because the shape of this file is the
    // thing being vouched for and a silently-tolerated wrong type is how the
    // next wrong type gets in.
    if (typeof entry.aircall_number_id !== 'string' || !entry.aircall_number_id.trim()) {
      fail(`${at} aircall_number_id must be a non-empty STRING (Aircall's numeric line ID, quoted).`);
    }
    if (typeof entry.line_name !== 'string' || !entry.line_name.trim()) {
      fail(`${at} line_name must be a non-empty string.`);
    }
    if (!isRealCalendarDate(entry.from)) {
      fail(`${at} from must be a real calendar date in YYYY-MM-DD form, got ${JSON.stringify(entry.from)}.`);
    }
    // THREE legal values as of 2026-09-11 (Peter enabled the third):
    // 'ring_membership', null, or an email naming one person — the last of
    // which is legal ONLY on a CLOSED period, enforced in the second pass
    // below. `undefined` (a missing key) fails here: `null` means "charge this
    // period to nobody" and must be written on purpose. Never widen this to
    // "anything unrecognised behaves like null" — that would quietly uncharge
    // somebody, and never widen it to "anything with an @ is an email" —
    // isNamedEmail() is deliberately strict, because a value that LOOKS like
    // an email and cannot resolve is the silent failure this whole file
    // exists to prevent.
    if (!(entry.attribute_to === 'ring_membership'
          || entry.attribute_to === null
          || isNamedEmail(entry.attribute_to))) {
      fail(
        `${at} attribute_to must be exactly 'ring_membership', null, or a lower-case email address naming one person, got ${JSON.stringify(entry.attribute_to)}. ` +
        'An email is legal ONLY on a period that a later entry has closed (see that file\'s header). ' +
        'If this was meant to be an email: it must be lower-case, contain exactly one "@", have a dotted domain, and contain no whitespace — a malformed one is rejected here rather than written onto rows, because a name that cannot resolve attributes to NOBODY and looks exactly like a good number.'
      );
    }
    if (typeof entry.worked_by !== 'string' || !entry.worked_by.trim()) {
      fail(`${at} worked_by must be a non-empty string (documentation only, but mandatory).`);
    }
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      fail(`${at} reason must be a non-empty string. An entry with a date and no reason gets deleted in six months by somebody who assumes it is stale.`);
    }
    if (!isRealCalendarDate(entry.recorded_on)) {
      fail(`${at} recorded_on must be a real calendar date in YYYY-MM-DD form, got ${JSON.stringify(entry.recorded_on)}.`);
    }
    if (typeof entry.recorded_by !== 'string' || !entry.recorded_by.trim()) {
      fail(`${at} recorded_by must be a non-empty string — a pointer to the evidence, so a future reader can re-check the claim.`);
    }

    // Periods are contiguous by construction (no `until` field), so two
    // entries sharing a start date is not an overlap that can be resolved —
    // it is an ambiguity about which one governs.
    const periodKey = `${entry.aircall_number_id}|${entry.from}`;
    if (seenPeriods.has(periodKey)) {
      fail(`${at} a second entry for line ${entry.aircall_number_id} also starts on ${entry.from}. Two periods cannot begin on the same day — one of them would silently win.`);
    }
    seenPeriods.add(periodKey);

    if (!byNumber.has(entry.aircall_number_id)) byNumber.set(entry.aircall_number_id, []);
    byNumber.get(entry.aircall_number_id).push(entry);
  });

  // Ascending by `from`, compared as STRINGS. Lexicographic comparison on
  // zero-padded YYYY-MM-DD is exact, and parsing either side into a Date is
  // how a timezone bug gets introduced into a boundary with no time component
  // at all (that file's header is explicit about this).
  for (const list of byNumber.values()) {
    list.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

    // ── AN EMAIL IS LEGAL ONLY ON A CLOSED PERIOD ────────────────────────
    // *** THIS CHECK IS THE WHOLE SAFETY PROPERTY OF THE 2026-09-11 CHANGE,
    // AND IT IS ENFORCED HERE RATHER THAN DOCUMENTED IN THE OTHER FILE'S
    // HEADER ON PURPOSE. ***
    //
    // A period is CLOSED when a later entry exists for the same line, which —
    // because periods are contiguous by construction and have no `until`
    // field — is exactly "this is not the newest entry for this line." A
    // closed period describes a finished, measurable past: it cannot change
    // again, so naming the person who worked it is a statement about history
    // that can be checked and cannot go stale.
    //
    // The RUNNING period is the opposite. It must always say
    // 'ring_membership' (that file's NOTES FOR Q #6), because that is the one
    // rule keeping this file from holding a second, divergent copy of
    // Aircall's live configuration. An email on the newest entry would
    // hardcode today's holder — and the day the line changes hands, the file
    // keeps charging the old person with nothing failing and nobody told.
    // That is the stale-configuration failure this project has now hit three
    // times; it is exactly what the naming change must not reintroduce.
    //
    // The newest entry may still be null or 'ring_membership'. Only an email
    // is refused here.
    const newest = list[list.length - 1];
    if (isNamedEmail(newest.attribute_to)) {
      fail(
        `Entry for line ${newest.aircall_number_id} ("${newest.line_name}") from ${newest.from} names ${JSON.stringify(newest.attribute_to)}, but it is the NEWEST entry for that line — i.e. its period is still RUNNING. ` +
        'An email is legal only on a CLOSED period (one that a later entry has ended). A running period must say \'ring_membership\' so Aircall stays the source of truth for who holds the line today; naming somebody there hardcodes today\'s holder and keeps charging them after the line changes hands, silently. ' +
        'If this person has genuinely handed the line over, add the NEW period\'s entry (attribute_to: \'ring_membership\') — that closes this one and makes the name legal.'
      );
    }
  }
  return byNumber;
}

const LINE_OWNERSHIP_BY_NUMBER = validateAndIndexLineOwnershipHistory(LINE_OWNERSHIP_HISTORY);

/**
 * The governing rule for one line on one Pacific calendar day, or null if
 * this line has no entries at all — the normal case, which almost every
 * Rincon line is in and which this whole feature must leave untouched.
 *
 * The three cases are exactly the algorithm in line-ownership-history.js's
 * header, and they are implemented here in one place so the boundary can only
 * be got wrong once:
 *   1. no entries          -> null, caller behaves exactly as before
 *   2. before the earliest -> excluded, no governing entry (nobody is named
 *                             for that era; the Office Line's pre-May phone
 *                             tree is the real example)
 *   3. otherwise           -> the LAST entry whose `from` <= callDate governs
 *
 * The governing entry produces exactly one of three verdicts, and they are
 * MUTUALLY EXCLUSIVE — `attribute_to_email` and `excluded` can never both be
 * set, because they come from the same single `attribute_to` value:
 *
 *   attribute_to_email: 'x@y.z'  charge this period to that named person
 *                                (a CLOSED period only — the loader enforces
 *                                it). `excluded` is false.
 *   excluded: true               charge this period to nobody.
 *   neither                      'ring_membership' — the normal existing
 *                                behaviour, Aircall decides.
 */
function lineOwnershipRuleFor(aircallNumberId, callDate) {
  const entries = LINE_OWNERSHIP_BY_NUMBER.get(aircallNumberId);
  if (!entries) return null;

  if (callDate < entries[0].from) {
    return {
      excluded: true,
      attribute_to_email: null,
      line_name: entries[0].line_name,
      from: null,
      earliest_from: entries[0].from,
      worked_by: null,
      reason: null,
    };
  }

  let governing = entries[0];
  for (const entry of entries) {
    if (entry.from <= callDate) governing = entry;
    else break; // sorted ascending — nothing later can govern an earlier date
  }

  return {
    excluded: governing.attribute_to === null,
    attribute_to_email: isNamedEmail(governing.attribute_to) ? governing.attribute_to : null,
    line_name: governing.line_name,
    from: governing.from,
    earliest_from: entries[0].from,
    worked_by: governing.worked_by,
    reason: governing.reason,
  };
}

/**
 * The `users` half of the named-email validation, run once per aggregation
 * with the staff list in hand.
 *
 * ============================================================
 * WHY THIS IS "MUST EXIST IN `users`" AND NOT "MUST BE ACTIVE" — the two are
 * different tests with different consequences, and only one of them is right
 * ============================================================
 * The purpose of a named period is to give a FINISHED period of work back to
 * the person who did it. The two people this could ever be about make the
 * distinction concrete:
 *
 *   ALDO HERNANDEZ is `is_active: false` — he left Rincon and Peter marked him
 *   inactive on 2026-09-11. He is precisely the case the extension point was
 *   written for ("the day Peter decides a departed person's history should
 *   still carry their name"). A "must be active" rule would REFUSE to name the
 *   one person the feature exists to be able to name. Requiring active would
 *   not make the data safer; it would make the feature unusable for its own
 *   stated purpose. `is_active` is a DISPLAY decision Peter makes per person
 *   (see router.js's is_active block) — it says whether to render someone on a
 *   scorecard today, not whose work six months of calls were.
 *
 *   REGINA FRANCO MENDEZ is on an external vendor domain
 *   (`regina@quickturnmaintenance.com`) and DOES have a `users` row — measured
 *   2026-09-11, contradicting a prediction in the other file's header. So "is
 *   this a Rincon email address?" is not a test this system can make from the
 *   string; `users` membership is the only real answer, and it is the same
 *   answer isAttributableLineMissRow() will give the row downstream.
 *
 * SO THE TEST IS: the named email must resolve to a `users` row. That is
 * chosen because it is EXACTLY the condition isAttributableLineMissRow()
 * applies to the stored row later. An email that passes here is guaranteed to
 * be attributable downstream; an email that fails here would have produced a
 * row that is stamped, constraint-legal, and then silently dropped to
 * unattributed — indistinguishable on the dashboard from the `null` behaviour
 * this change replaces. Checking the same condition the consumer checks is
 * what turns an invisible failure into a loud one.
 *
 * THE CONSEQUENCE OF ALLOWING AN INACTIVE PERSON, STATED RATHER THAN
 * DISCOVERED: their pod row is not rendered (router.js skips inactive users in
 * both the accumulator loop and the placeholder loop), so a period named to an
 * inactive person shows up in the Shared Line Misses section — "charged to
 * Aldo Hernandez" — and in no pod table. That is visible and honest, not
 * missing, and it is the same treatment his `call_stats` rows already get.
 *
 * WHY IT IS NOT AT LOAD TIME, given that the shape check is. This module is
 * required synchronously at server start and has no database access — `users`
 * lives in Supabase. So the check runs at the only moment the answer is
 * knowable, and it runs BEFORE a single row is built, throwing into the
 * callers' existing fail-loud paths (router.js skips every line-miss upsert
 * and returns 502 with the day re-runnable; the backfill stops before writing
 * anything). Nothing can be stamped with a name that does not resolve.
 */
function crossCheckLineOwnershipNamedEmails(usersByEmail) {
  for (const [numberId, entries] of LINE_OWNERSHIP_BY_NUMBER) {
    for (const entry of entries) {
      if (!isNamedEmail(entry.attribute_to)) continue;
      if (usersByEmail.has(entry.attribute_to)) continue;
      throw new Error(
        `lib/line-ownership-history.js charges line ${numberId} ("${entry.line_name}") from ${entry.from} to ${entry.attribute_to}, but no row in \`users\` has that email. ` +
        'Refusing to aggregate. A named email that does not resolve is the WORST outcome available here: the rows would be stamped with it, pass the table\'s CHECK constraint, and then be dropped to unattributed by isAttributableLineMissRow() — so the person would read the same flattering, uncharged number that naming them was meant to fix, with nothing anywhere reporting a failure. ' +
        'Either the address is a typo, or that person has no `users` row yet. Fix the file, or add the user. (Note: an INACTIVE user passes this check on purpose — see this function\'s header.)'
      );
    }
  }
}

// Warned-about (line, live name) pairs, so a rename does not print the same
// line 184 times during a six-month backfill and smear the report Peter reads.
// Deliberately per-process rather than per-run: on the long-lived Hub server
// that means one warning until the next restart, which is quiet, but the
// alternative — the same sentence every night forever — is the kind of noise
// that teaches people to skip log lines.
const ownershipLineNameMismatchesWarned = new Set();

/**
 * The half of the ownership-history validation that needs Aircall's own line
 * list, run once per aggregation with the live mapping in hand.
 *
 * A line ID in that file which Aircall does not return is an ERROR WORTH
 * STOPPING FOR, not a warning: the entry can never match, so the exclusion
 * silently stops applying and the departed employee's calls go straight back
 * onto their replacement — with nothing anywhere saying so. Throwing routes
 * this into the callers' existing fail-loud paths (router.js skips every
 * line-miss upsert and returns 502 with the day re-runnable; the backfill
 * stops before writing anything), which is the right outcome for "the rule
 * this run depends on cannot be applied."
 *
 * THE COST, STATED RATHER THAN BURIED: if Rincon ever DELETES a line that has
 * an entry here, the nightly sync fails every night until somebody edits this
 * file. That is deliberate — a deleted line's history still needs its
 * exclusion, and the fix is a considered edit, not an automatic downgrade to
 * a warning nobody reads. Warning instead was considered and rejected for
 * exactly the reason above: the failure it would allow is invisible.
 */
function crossCheckLineOwnershipAgainstMapping(lineRingMembership) {
  for (const [numberId, entries] of LINE_OWNERSHIP_BY_NUMBER) {
    const membership = lineRingMembership.get(numberId);
    if (!membership) {
      throw new Error(
        `lib/line-ownership-history.js names Aircall line ${numberId} ("${entries[0].line_name}"), but Aircall's current line list does not contain that ID. ` +
        'Refusing to aggregate: the entry cannot match, so its exclusion would silently stop applying and those historical calls would be charged to whoever rings that line today. ' +
        'Either the ID is a typo, or the line was deleted from Aircall — check Aircall, then correct the file.'
      );
    }

    // A renamed line may simply have been renamed, or may have been
    // repurposed entirely — which is itself an ownership event somebody needs
    // to look at. Never used for matching either way: the ID is the key.
    const liveName = String(membership.line_name || '');
    for (const entry of entries) {
      if (!liveName || entry.line_name === liveName) continue;
      const warnKey = `${numberId}|${entry.line_name}|${liveName}`;
      if (ownershipLineNameMismatchesWarned.has(warnKey)) continue;
      ownershipLineNameMismatchesWarned.add(warnKey);
      console.warn(
        `call-stats: LINE OWNERSHIP HISTORY NAME MISMATCH — line ${numberId} is called "${liveName}" in Aircall today, ` +
        `but lib/line-ownership-history.js calls it "${entry.line_name}" (period from ${entry.from}). ` +
        'The exclusion still applies — matching is by ID, never by name — but check whether this line was merely renamed or actually repurposed. A repurposed line is an ownership event and needs its own entry.'
      );
    }
  }
}

/**
 * @param {Array} calls
 * @param {Map} lineRingMembership  Aircall's line list — see the guard below.
 * @param {Map} usersByEmail  lower-cased email -> `users` row.
 *
 * *** WHY `usersByEmail` IS A REQUIRED THIRD ARGUMENT AND NOT AN OPTIONAL
 * ONE, ADDED 2026-09-11. *** It is used for one thing only:
 * crossCheckLineOwnershipNamedEmails(), which proves that every email
 * lib/line-ownership-history.js names resolves to a real user BEFORE any row
 * is stamped with one. Making it optional — or exporting the cross-check for
 * callers to remember to call — would mean a future call site can build named
 * rows without ever proving the names resolve, and the resulting failure is
 * invisible by construction (see that function's header). Required here, the
 * proof is impossible to skip: you cannot produce a named row without having
 * supplied the list that validates the name. Both existing callers already
 * hold this map a few lines above their call.
 */
function buildLineMissAggregates(calls, lineRingMembership, usersByEmail) {
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

  // Same reasoning as the mapping guard directly above, for the same reason:
  // an unusable list must never be mistaken for a list that says nobody
  // matches. Rincon's `users` table is never legitimately empty, so an empty
  // Map here is a failed read wearing a success's clothes — and it would
  // reject every named period in lib/line-ownership-history.js as
  // "unresolvable," which is a loud failure rather than a silent one but
  // still the wrong diagnosis on the wrong day.
  if (!(usersByEmail instanceof Map) || usersByEmail.size === 0) {
    throw new Error('buildLineMissAggregates() requires a NON-EMPTY `users` Map (lower-cased email -> user row). It is what proves every email named in lib/line-ownership-history.js resolves to a real person before any row is stamped with one. Refusing to build line-miss rows without it.');
  }

  // Runs before a single row is built: an ownership entry that cannot match
  // is a silently-disabled exclusion, and the whole point is that nothing
  // gets attributed while that is true.
  crossCheckLineOwnershipAgainstMapping(lineRingMembership);
  // Same timing, same severity, the other half of the same question: an entry
  // that names somebody `users` does not know would stamp a name that the
  // dashboard then silently ignores.
  crossCheckLineOwnershipNamedEmails(usersByEmail);

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
    // ── Line ownership history (added 2026-09-10) ───────────────────────
    // NOT AN ALARM. These rows are a deliberate, correct exclusion — the
    // line was worked by somebody other than whoever rings it today — and
    // they increment no alarm counter, so they cannot drown the two real
    // ones above in noise. Counted separately precisely so a reader can tell
    // "held back on purpose" from "we could not find out," which look
    // identical on the row itself (both attribution columns NULL).
    rows_excluded_by_line_ownership_history: 0,
    calls_excluded_by_line_ownership_history: 0, // the number Peter reads — 1,257 for Aldo's period
    lines_excluded_by_ownership_history: [], // { aircall_number_id, line_name, from, worked_by, rows, calls, ... } — filled below
    // ── Named closed periods (added 2026-09-11) ─────────────────────────
    // ALSO NOT AN ALARM, and the mirror image of the three counters above:
    // rows whose attribution the file REDIRECTED to a named person instead of
    // withholding it. Counted separately from rows_attributed_to_sole_user
    // (which means "Aircall's live ring membership named exactly one person")
    // because the two answer different questions about where a name came
    // from, and collapsing them would hide the only rows on the dashboard
    // whose attribution comes from a file rather than from Aircall.
    rows_named_by_line_ownership_history: 0,
    calls_named_by_line_ownership_history: 0,
    lines_named_by_ownership_history: [], // { aircall_number_id, line_name, from, attributed_to, worked_by, rows, calls, ... } — filled below
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
  // key: aircall_number_id|governing period -> the reporting group below.
  const excludedByOwnership = new Map();
  // The same, for periods the file NAMES rather than withholds. Two maps
  // rather than one with a flag, because the two populations are reported
  // separately and summed against different figures: "held back from the
  // current ringer" and "redirected to a named person" are opposite actions,
  // and a reader who has to filter a merged list by a boolean will eventually
  // report their total as one number.
  const namedByOwnership = new Map();
  // bucket key -> its reporting group, for the per-CALL counts. A flag on the
  // bucket itself would be simpler and is WRONG: bucket objects are handed
  // straight to .upsert(), so an extra key becomes an extra column and the
  // write fails. Kept alongside instead. Carries both kinds; each group knows
  // which it is via its own `attributed_to` (null = held back).
  const ownershipBucketGroups = new Map();
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

      const ownership = lineOwnershipRuleFor(aircallNumberId, callDate);

      if (ownership && ownership.attribute_to_email) {
        // ── NAMED BY THE LINE OWNERSHIP HISTORY (added 2026-09-11) ─────────
        // A CLOSED period that names one person. Tested first, alongside the
        // exclusion branch and ahead of the missing-mapping branch, for the
        // identical reason: this is a statement about a DATE, and it is the
        // more specific and more correct answer than anything today's mapping
        // can say about the line.
        //
        // *** THE ROW IS STAMPED EXACTLY LIKE A NORMAL SOLE-USER ROW:
        // sole_user_email = the named email, ring_user_count = 1. *** It is
        // not a new row shape and it deliberately does not get one — the whole
        // value of naming a period is that the row flows through
        // isAttributableLineMissRow() and the pod tables by the ordinary path,
        // with no consumer needing to know where the name came from.
        //
        // Checked against the table's constraints, all three pass:
        //   - call_stats_line_misses_sole_user_requires_one_ringer says
        //     `sole_user_email IS NULL OR ring_user_count = 1`. We write
        //     ring_user_count = 1 alongside the email, so it holds.
        //   - the ring_user_count >= 0 CHECK holds trivially.
        //   - the rows_sole_user_email_unresolved ALARM does NOT fire: it
        //     needs ring_user_count === 1 with NO email, and this row has one.
        //     That alarm exists for "the line rang exactly one person whose
        //     email could not be resolved," which is a different condition and
        //     must not be diluted by rows that are correctly named.
        //
        // *** ring_user_count = 1 HERE IS A CLAIM ABOUT ATTRIBUTION, NOT A
        // MEASUREMENT OF THAT DAY'S RING MEMBERSHIP. *** The exclusion branch
        // below refuses to write a count precisely because it would assert a
        // membership fact about a date this system cannot know. This branch
        // writes 1 because it is not asserting membership — it is recording a
        // decision Peter made, with evidence, that this period's calls belong
        // to exactly one named person. The constraint requires the 1 for the
        // email to be legal at all, and the column's meaning ("how many users
        // this line rang") is satisfied as far as any consumer reads it: every
        // consumer uses it only as the gate for "is there exactly one person
        // to charge." Writing the line's real current count instead would be
        // both wrong and, when that count is not 1, constraint-violating.
        summary.rows_named_by_line_ownership_history++;
        soleUserEmail = ownership.attribute_to_email;
        ringUserCount = 1;

        const groupKey = `${aircallNumberId}|${ownership.from}`;
        let group = namedByOwnership.get(groupKey);
        if (!group) {
          group = {
            aircall_number_id: aircallNumberId,
            line_name: ownership.line_name || call.number.name || '',
            from: ownership.from,
            attributed_to: ownership.attribute_to_email,
            worked_by: ownership.worked_by,
            reason: ownership.reason,
            rows: 0,
            calls: 0,
            inbound_calls: 0,
            outbound_calls: 0,
            missed_calls: 0,
          };
          namedByOwnership.set(groupKey, group);
        }
        group.rows++;
        ownershipBucketGroups.set(key, group);
      } else if (ownership && ownership.excluded) {
        // ── HELD BACK BY THE LINE OWNERSHIP HISTORY ───────────────────────
        // Tested BEFORE the missing-mapping branch below, because this is a
        // statement about a DATE and that one is a statement about a LINE:
        // if a line is both excluded for this date and absent from today's
        // mapping, the exclusion is the more specific and the more correct
        // answer, and it is not an alarm.
        //
        // BOTH attribution columns stay NULL — the state the missing-mapping
        // branch below already writes, meaning "this run does not know who
        // this line rang on that date," which is exactly true here. It
        // satisfies call_stats_line_misses_sole_user_requires_one_ringer,
        // isAttributableLineMissRow() drops the row to unattributed so it
        // stays visible in Shared Line Misses, and the
        // rows_sole_user_email_unresolved alarm does NOT fire (it needs
        // ring_user_count === 1).
        //
        // *** DO NOT WRITE THE LINE'S REAL CURRENT RING COUNT ALONGSIDE A
        // NULL EMAIL. *** It would trip that alarm on every excluded row, and
        // worse, it would assert a membership fact about a date this system
        // has no way to know — the exact claim the exclusion exists to refuse.
        //
        // Everything else on the row — total_calls, missed_calls, the reason
        // map, voicemails — is still measured and written in full below. The
        // exclusion is about ATTRIBUTION only. An excluded row is MEASURED and
        // UNATTRIBUTED; NULLing the reason columns would instead mean "no sync
        // ever looked," which is false and would make the row unmeasured on
        // the dashboard permanently.
        summary.rows_excluded_by_line_ownership_history++;
        const periodLabel = ownership.from || `(before ${ownership.earliest_from})`;
        const groupKey = `${aircallNumberId}|${periodLabel}`;
        let group = excludedByOwnership.get(groupKey);
        if (!group) {
          group = {
            aircall_number_id: aircallNumberId,
            line_name: ownership.line_name || call.number.name || '',
            from: ownership.from,
            before_earliest_from: ownership.from ? null : ownership.earliest_from,
            // Plain English, for the report and the dashboard: "Apr–Aug 2026:
            // Aldo Hernandez (departed), charged to nobody" beats the useless
            // "unattributed." Documentation only — never parsed, never matched
            // against `users`, never turned into an email.
            worked_by: ownership.worked_by,
            reason: ownership.reason,
            // Held back, not redirected. Present so the two ownership groups
            // have the same shape and a reader of either can tell which is
            // which without knowing which array it came out of.
            attributed_to: null,
            rows: 0,
            calls: 0,
            inbound_calls: 0,
            outbound_calls: 0,
            missed_calls: 0,
          };
          excludedByOwnership.set(groupKey, group);
        }
        group.rows++;
        ownershipBucketGroups.set(key, group);
      } else if (!membership) {
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
        // *** Object.create(null), NOT {}. THIS IS LOAD-BEARING. ***
        // The keys of this map are chosen by AIRCALL, not by us — that is the
        // entire reason it is an open-ended map with no key CHECK. On a plain
        // {} the key `__proto__` is not a key at all: the assignment below
        // silently does nothing, the map stays empty while missed_calls
        // climbs, invariant (a) throws, the line-miss half of the sync is
        // skipped, and router.js returns 502 — every night, until somebody
        // reads the stack trace. `constructor` and `toString` corrupt it
        // differently (they read back as a function, so `|| 0` hides it) and
        // also throw. A vendor value must never be able to do that: "an
        // unknown reason must never crash the sync" is the guarantee this map
        // exists to provide, and a null-prototype object is what actually
        // provides it. JSON.stringify serializes it identically, so nothing
        // downstream — the upsert, the API response — sees any difference.
        missed_calls_by_reason: Object.create(null),
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
      //
      // THREE OUTCOMES, NOT TWO (fixed 2026-09-10). A usable string is the
      // reason. NULL/undefined is "(no reason reported)" — the real, expected
      // case for every outbound miss. ANYTHING ELSE — a number, an object, an
      // empty string — is an anomaly and gets its own self-describing key so
      // it is counted, stored and SHOUTED about rather than quietly joining
      // the outbound misses under "(no reason reported)", where a vendor
      // changing its response shape would be indistinguishable from a normal
      // day. An empty string is treated as an anomaly rather than as "no
      // reason" on purpose: Aircall sends null when it has nothing to say,
      // and a blank string where a null belongs is a change worth seeing.
      const rawReason = call.missed_call_reason;
      let reasonKey;
      if (typeof rawReason === 'string' && rawReason.trim()) {
        reasonKey = rawReason.trim();
      } else if (rawReason == null) {
        reasonKey = NO_REASON_KEY;
      } else {
        reasonKey = unexpectedReasonKey(rawReason);
      }

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

    // Per-CALL exclusion counts, for the report only — nothing on the row
    // changes here. Peter's question is "how many calls were held back," and
    // a row count cannot answer it: one excluded row can carry hundreds of
    // calls. The inbound/outbound/missed split is tracked because it is what
    // makes the figure checkable against the measurement in
    // line-ownership-history.js's own `reason` text.
    const ownershipGroup = ownershipBucketGroups.get(key);
    if (ownershipGroup) {
      if (ownershipGroup.attributed_to) summary.calls_named_by_line_ownership_history++;
      else summary.calls_excluded_by_line_ownership_history++;
      ownershipGroup.calls++;
      if (call.direction === 'inbound') ownershipGroup.inbound_calls++;
      else ownershipGroup.outbound_calls++;
      if (call.answered_at == null) ownershipGroup.missed_calls++;
    }

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
  summary.lines_excluded_by_ownership_history = Array.from(excludedByOwnership.values());
  summary.lines_named_by_ownership_history = Array.from(namedByOwnership.values());
  // Accumulated in a Map and converted once, rather than summed into a plain
  // object as the loop goes — Object.fromEntries DEFINES each key as an own
  // property, so a vendor reason of `__proto__` survives the conversion
  // intact. *** Do not "simplify" this into a reduce that does
  // `out[reason] = ...`: that is the exact assignment `__proto__` silently
  // discards. *** Same hazard the buckets' own reason maps use
  // Object.create(null) for.
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
  // Exported so the date boundary can be checked directly rather than only
  // through a full aggregation — `from` is INCLUSIVE, and an off-by-one day
  // on it is a whole month of somebody's calls landing on the wrong person.
  lineOwnershipRuleFor,
  // Exported for the SAME reason and with the same warning attached: it is a
  // predicate, not a permission. Calling it does not make a named row safe —
  // buildLineMissAggregates() is where the proof happens, and it is the only
  // place that may stamp a name.
  isNamedEmail,
};
