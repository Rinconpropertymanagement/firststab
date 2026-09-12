/**
 * lib/metrics.js
 * The per-person Call Stats arithmetic — every number the pod tables show,
 * in one place. Pure math: no network calls, no database calls, no Express,
 * same split from router.js that lib/sync.js already uses for the write
 * side. router.js's GET /api/call-stats/stats calls this and contains no
 * metric arithmetic of its own.
 *
 * ============================================================
 * WHY THIS FILE EXISTS AS A SEPARATE MODULE
 * ============================================================
 * TREND-VIEW-SPEC.md Design Decision 3 makes this a build requirement
 * rather than a tidiness preference. Its exact words:
 *
 *   "Q extracts the per-person metric computation out of
 *    /api/call-stats/stats into a shared module in
 *    projects/hub/call-stats/lib/ — an accumulator that folds a call_stats
 *    row into a running total, and a function that turns a finished
 *    accumulator into the metric values. Both the existing Stats route and
 *    the new Trend route call it. Neither route contains metric arithmetic
 *    of its own."
 *
 * The reason is specific and it is the reason this file is being written
 * during THIS change rather than during the trend build: the answer rate is
 * being redefined right now (answer-rate-redefinition-SPEC.md). If the
 * trend route copied today's arithmetic instead of sharing it, a later
 * change to the definition would fix one tab and silently leave the other
 * wrong — and the discrepancy would be found in a weekly staff meeting
 * rather than in a test. Shared here, both views move together in one
 * commit, whatever the definition becomes.
 *
 * That is also why this is an ACCUMULATOR plus a COMPUTE STEP rather than
 * one function over a row. The trend view buckets rows into (person,
 * period) cells and computes each cell's metric ONCE, from that cell's raw
 * sums. It must never compute a rate per day and then average the daily
 * rates: a person who answered 1 of 1 inbound calls one week and 50 of 100
 * the next has a two-week answer rate of 51%, not 75%. That is SPEC.md
 * Design Decision 2's "never store a number pre-divided" rule applied one
 * level up, and the accumulator shape is what enforces it.
 *
 * ============================================================
 * THE ANSWER RATE, AS OF 2026-09-10 — AND WHAT IT USED TO BE
 * ============================================================
 * Answer Rate = inbound answered / (inbound answered + inbound missed).
 * BOTH halves now come from the same TWO sources, which are disjoint by
 * construction:
 *
 *   1. call_stats on that person's own inbound rows — answered_calls into
 *      the numerator, missed_calls into the denominator. These are the
 *      calls Aircall credited to them by name. missed_calls is 0 on every
 *      inbound row in Rincon's real data, all-time (TARS, 2026-09-10
 *      against the live database). It is folded in anyway rather than
 *      dropped: "it is zero today" is not the same fact as "it can only
 *      ever be zero," and if Aircall ever starts attributing an unanswered
 *      inbound call to a person, this half starts counting it with no code
 *      change.
 *
 *   2. call_stats_line_misses on inbound rows whose line rang EXACTLY ONE
 *      person on the day of the call, snapshotted onto the row at sync time
 *      (sole_user_email / ring_user_count — see
 *      20260910010000_add_sole_user_attribution_to_call_stats_line_misses.sql).
 *      missed_calls_agents_did_not_answer goes into the denominator (see the
 *      next section — it was missed_calls until 2026-09-10); total_calls -
 *      missed_calls goes into the NUMERATOR. This is the half that was
 *      missing, and its absence is why the column could only ever read 100%
 *      or a dash: source 1's misses are structurally always 0, so the
 *      denominator could never exceed the numerator. Not an edge case —
 *      arithmetic.
 *
 * ============================================================
 * THE DENOMINATOR NARROWED, 2026-09-10 — ONLY `agents_did_not_answer`
 * COUNTS AGAINST A PERSON
 * ============================================================
 * Source 2's contribution to the denominator is no longer that row's whole
 * missed_calls. It is only the subset Aircall reported as
 * `agents_did_not_answer` — somebody was available and the phone rang out.
 * Peter's rule, approved 2026-09-10, and the reasons are facts about the
 * phone system rather than a softening of the metric:
 *
 *   - `no_available_agent` — nobody was logged in. Confirmed by Peter as
 *     Kristen manually switching to the phone tree for lunch, plus her 9am
 *     start. A schedule, not a performance failure.
 *   - `short_abandoned` — the caller hung up after a MEDIAN OF NINE SECONDS.
 *     Nobody could have answered these.
 *   - Three more values confirmed live on 2026-09-10 that the build brief
 *     did not mention at all — `out_of_opening_hours`, `abandoned_in_ivr`,
 *     `abandoned_in_classic`. Same treatment: visible, charged to nobody.
 *
 * Both the Answer Rate and the Missed column read the new term. Fixing only
 * one would leave the page contradicting itself, which is the precise
 * failure answer-rate-redefinition-SPEC.md exists to correct.
 * Measured effect on Kristen, her two lines 2026-09-01..09-09: 53% -> 69%.
 * (WHOLE days only. The window originally recorded here ended 09-10, a day
 * still in progress at the time, which produced three different rates for the
 * same person on the same day — 55%, 70%, 71% — depending on the hour it was
 * measured. TARS settled it on 2026-09-10 over 09-01..09-09: 69% is correct.)
 *
 * *** AND NULL ON THAT COLUMN MEANS "NOT MEASURED," NOT ZERO. *** It is the
 * opposite convention to sole_user_email's NULL, and conflating the two
 * produces a wrong number quietly. foldAttributedLineMissRow() removes an
 * unmeasured row from BOTH halves of the fraction and counts it separately;
 * read that function's first block before changing anything here.
 *
 * ============================================================
 * OPEN ITEM 11 (fixed 2026-09-10, second pass) — WHY THE NUMERATOR READS
 * total_calls - missed_calls AND NOT JUST missed_calls
 * ============================================================
 * The first pass of this change folded ONLY missed_calls from source 2.
 * That made attribution asymmetric in a way that is not defensible on a
 * scorecard reviewed with named staff in the room: a MISSED inbound call on
 * a line ringing exactly one person was charged to that person, but an
 * ANSWERED inbound call on the SAME line, arriving with no `user` attached,
 * was credited to nobody. The bad half counted, the good half did not.
 *
 * Peter's decision, 2026-09-10: credit answered calls on a sole-user line
 * to that person, the same way misses are charged to them. His reasoning —
 * charging someone for the bad half while withholding the good half is not
 * defensible. So the rule is now stated once and applies to the whole row:
 * an inbound call on a line that rings exactly one person counts toward
 * that person, answered or missed.
 *
 * *** THIS NEEDED NO SYNC CHANGE AND NO SCHEMA CHANGE, AND THAT WAS
 * VERIFIED AGAINST THE REAL TABLE RATHER THAN ASSUMED. *** The table is
 * named for misses, but per its own migration total_calls is a deliberate
 * SUPERSET of missed_calls: lib/sync.js's buildLineMissAggregates() counts
 * EVERY closed call with no `user` into total_calls and increments
 * missed_calls only when answered_at is null. So the answered calls were
 * already sitting in rows this route already reads, as the arithmetic
 * difference between two columns already selected. What was checked live on
 * 2026-09-10 before a line of this was written:
 *
 *   - call_stats_line_misses holds 13 OUTBOUND answered user-less calls in
 *     the 2026-08-15..2026-09-09 window (total_calls > missed_calls on
 *     those rows). Direct proof that the sync does record an ANSWERED
 *     user-less call, in this table, in total_calls, today.
 *   - For 2026-09-08 and 2026-09-09, Aircall itself reports 0 answered and
 *     52 missed inbound user-less calls; the stored rows for those two days
 *     sum to total_calls 52 / missed_calls 52. The stored superset matches
 *     Aircall exactly — the sync is faithful and loses nothing.
 *   - The answered inbound user-less calls DO occur and are concentrated on
 *     "RSC Solimar Team" (sole user Leo O'Gorman). Three sampled days from
 *     the window (2026-08-18, 08-25, 09-02) carry 4 of them: 2 on RSC
 *     Solimar Team, 2 on the after-hours phone tree (a three-user line, so
 *     unattributable either way).
 *
 * One consequence worth stating plainly so nobody re-opens this later
 * thinking the fix failed: as of 2026-09-10 this change moves NO displayed
 * number, because call_stats_line_misses only holds 8 days (2026-08-29 and
 * 2026-09-03..09) and every inbound row in it has total_calls ===
 * missed_calls. TARS's 29 answered-on-a-sole-user-line calls are real, but
 * they fall on days that were never synced. They arrive — with no further
 * code change, correctly split into answered and missed — when the
 * six-month backfill runs. That backfill is a separate task and is
 * deliberately not written here.
 *
 * No double counting, and this is verifiable in lib/sync.js rather than
 * assumed: a call with `call.user` set goes to call_stats and is skipped by
 * buildLineMissAggregates(); a call with `call.user === null` goes to
 * call_stats_line_misses and is skipped by buildDailyAggregates(). Every
 * call lands in exactly one of the two tables, never both. That is the only
 * reason a line-keyed count may legitimately be added into a person-keyed
 * denominator — together with the fact that the line rang exactly one
 * person, which is the entire content of Peter's rule and why it does NOT
 * generalise to the two lines that ring three people each.
 *
 * ============================================================
 * THE PAGE'S OWN ARITHMETIC — THE IDENTITY HAS THREE TERMS, NOT TWO
 * (corrected 2026-09-10 after TARS measured it on backfilled data)
 * ============================================================
 * This file used to claim, in two places, that
 *
 *     Calls - Outbound === inbound answered + inbound missed
 *
 * closes exactly. It does not, and it has not since the denominator narrowed
 * to `agents_did_not_answer` earlier the same day. The missing term is the
 * misses Peter's rule charges to nobody. TARS measured the gap on real
 * backfilled data — 7 of 8 people, and in every case the gap equals
 * inbound_missed_calls_not_charged_reason to the call: Dio 1600 vs 1166 (gap
 * 434), Leo 1950 vs 1558 (392), Kristen 1510 vs 1139 (371), Caylee 123,
 * Liz 99, Shane 91, Marci 61.
 *
 * THE TRUE IDENTITY, and it closes exactly:
 *
 *     Calls - Outbound
 *       === inbound_answered_calls
 *         + inbound_missed_calls                      (charged)
 *         + inbound_missed_calls_not_charged_reason   (charged to nobody)
 *
 * with unmeasured attributed rows in NONE of the four terms — they are out of
 * total_calls as well as out of the fraction, which is why
 * has_unmeasured_line_misses has to be shown beside these numbers.
 *
 * *** THE FIX WAS TO THE CLAIM, NOT TO total_calls. NO DISPLAYED NUMBER
 * MOVES. *** The alternative was to stop folding uncharged misses into
 * total_calls so the two-term identity closed again. It was considered
 * properly and rejected, for three reasons:
 *
 *   1. It would delete real calls from the "Calls" column — 434 of Dio's,
 *      392 of Leo's, 371 of Kristen's. Those calls happened. They rang a real
 *      line and a real caller was on them. Peter's rule about them is
 *      "visible, charged to NOBODY" — it is a rule about FAULT, not about
 *      EXISTENCE, and a volume column is not the place to apply it.
 *   2. It would make a sentence already on the page FALSE. dashboard/index.html
 *      tells the reader "Inbound is the subtraction: Calls minus Outbound."
 *      Keep total_calls whole and that stays true. Narrow it and "Calls minus
 *      Outbound" silently becomes "the calls this person could be held
 *      responsible for," which no plain-English column label can carry and
 *      which nobody in a staff meeting would guess.
 *   3. A person's Calls would stop reconciling against their own line's rows
 *      in the Shared Line Misses section below it, which counts every miss on
 *      the line whatever its reason. Two sections of one page would disagree
 *      about how many calls a line took — the same class of failure this
 *      whole change exists to remove.
 *
 * *** WHAT TRON MUST RENDER AS A CONSEQUENCE (defect E, Tron's to fix, not
 * fixed here): *** the pod-table note that ends "Inbound is the subtraction:
 * Calls minus Outbound" must go on to say that the inbound total includes
 * misses charged to nobody, so answered plus Missed is smaller than it by
 * exactly inbound_missed_calls_not_charged_reason — a per-person field this
 * module already returns. Nothing else on the page changes: the Answer Rate's
 * denominator IS answered plus exactly the Missed column (dashboard
 * index.html's column-order note is correct and stays), and every number in
 * every column is unchanged. Both statements stay true; the page just has to
 * stop implying they add up to each other.
 *
 * OUTBOUND IS STILL EXCLUDED FROM BOTH HALVES. That half of SPEC.md Design
 * Decision 7 was never dependent on the mistaken premise the redefinition
 * spec corrects (Design Decision 9), and this change does not disturb it:
 * an outbound call a vendor doesn't pick up says nothing about a staff
 * member's responsiveness, and folding it in would quietly penalize
 * whoever places the most outbound calls.
 *
 * EVERY PERCENTAGE THIS PRODUCES IS AN UPPER BOUND — the true figure is
 * this or lower, never higher. Aircall reports which users a line RINGS,
 * not where it FORWARDS (SPEC.md Open Item 7, still open — nobody has read
 * Rincon's phone-tree configuration yet). Unmodelled forwarding can only
 * ever ADD misses to someone's denominator, never remove them. The
 * dashboard says so on the page; it is recorded here too so the next reader
 * of this arithmetic knows the number is deliberately conservative rather
 * than complete.
 */

/**
 * A fresh, empty running total for one person. Every field is a raw sum or
 * count — nothing here is ever stored or carried pre-divided (SPEC.md
 * Design Decision 2). Division happens once, in computePersonMetrics()
 * below, at the moment a number is displayed.
 */
function createPersonAccumulator() {
  return {
    // Blended inbound+outbound activity, the "Calls" column.
    total_calls: 0,
    answered_calls: 0,
    total_talk_seconds: 0,

    // The ring time behind Avg. Speed to Answer. Only call_stats rows carry
    // it — call_stats_line_misses has no ring-seconds column at all — which
    // is why its denominator below is inbound_answered_calls_direct and not
    // the combined answered count. See computePersonMetrics().
    inbound_total_ring_seconds: 0,

    // The two SOURCES of a person's inbound calls, kept apart on purpose
    // rather than summed as they arrive, and kept apart SYMMETRICALLY:
    // answered and missed are each split the same way, because as of the
    // Open Item 11 fix both halves of the Answer Rate draw on both sources.
    // They are added together for the "Missed" column and the Answer Rate,
    // but keeping them separate makes the combined number auditable: TARS
    // (and anyone re-deriving a figure from a weekly meeting) can see
    // exactly how much of a person's Missed count AND how much of their
    // answered count came from Aircall's own per-person attribution versus
    // from a sole-user line. Costs two integers; worth it for numbers that
    // go on a scorecard next to a named employee.
    //
    // Splitting the ANSWERED side is not merely for symmetry of reporting —
    // inbound_answered_calls_direct is load-bearing arithmetic, because it
    // is the only one of the two that has ring seconds behind it.
    inbound_answered_calls_direct: 0,      // call_stats.answered_calls, inbound rows
    inbound_answered_calls_shared_line: 0, // call_stats_line_misses, sole-user lines: total_calls - missed_calls
    inbound_missed_calls_direct: 0,        // call_stats.missed_calls, inbound rows
    inbound_missed_calls_shared_line: 0,   // call_stats_line_misses, sole-user lines: missed_calls_agents_did_not_answer ONLY

    // ── The two miss populations that are visible but charged to NOBODY ──
    // (added 2026-09-10 with the miss-reason columns). Kept on the PERSON's
    // accumulator, not only on the line, because the question these answer
    // is "why is this person's Missed column lower than their line's miss
    // count" — which is asked about a person, in a meeting, while looking at
    // their row. Neither ever enters the Answer Rate fraction.
    //
    // Misses on this person's own sole-user line whose reason is not
    // `agents_did_not_answer`: no_available_agent (a schedule), the caller
    // hanging up after nine seconds, out-of-hours, abandoned in the IVR.
    // Peter's rule, 2026-09-10: visible, charged to nobody.
    inbound_missed_calls_not_charged_reason: 0,

    // ── UNMEASURED rows. NULL IS NOT ZERO. ──────────────────────────────
    // A call_stats_line_misses row written before the miss-reason sync
    // change has all three reason columns NULL, which means "this row was
    // never measured" — the OPPOSITE of sole_user_email's NULL. Such a row
    // is EXCLUDED FROM BOTH HALVES of the Answer Rate and counted here
    // instead (migration 20260910020000 NOTES FOR Q #2).
    //
    // Excluded from BOTH halves, not just the misses, and that is the whole
    // point: crediting an unmeasured row's ANSWERED calls to the numerator
    // while withholding its misses from the denominator would push every
    // affected person's rate UP — a flattering, entirely false number, which
    // is the exact failure answer-rate-redefinition-SPEC.md exists to
    // correct. It also stays out of acc.total_calls, so an unmeasured row is
    // in NO term of the page's own arithmetic rather than in one side of it —
    // see "THE PAGE'S OWN ARITHMETIC" in this file's header for the identity
    // as it actually stands (three terms, not two).
    //
    // These counts exist so the page can SAY SO. An honestly missing number
    // is better than a quietly wrong one, but only if the gap is on the
    // page — a silently smaller denominator is just a quietly wrong number
    // with extra steps.
    inbound_unmeasured_line_miss_rows: 0,
    inbound_unmeasured_line_missed_calls: 0, // the row's own missed_calls — how many misses cannot be split by reason
    inbound_unmeasured_line_total_calls: 0,

    // ── Voicemails (Peter asked for two metrics, 2026-09-10) ────────────
    // Counts only, never a link — see the migration's voicemails_left
    // comment. Only measured rows contribute; an unmeasured row's voicemail
    // count is NULL and unknowable, not zero.
    //
    // A THIRD metric, whether voicemails were RETURNED, is deliberately not
    // built and nothing here should be extended toward it: it needs storing
    // callers' phone numbers, which makes it a compliance build requiring
    // Asimov. Logged as item 1 in COMMITTED-NOT-BUILT.md so it is not
    // quietly dropped — Peter specifically asked that it not be.
    inbound_voicemails_left_shared_line: 0,
    inbound_measured_missed_calls_shared_line: 0, // the voicemail RATE's denominator: all misses on measured attributed rows, every reason

    // Outbound. NOT the same signal as an inbound miss — see SPEC.md
    // Design Decision 2 and router.js's own comments. Surfaced under its
    // own name everywhere, never folded into "Missed."
    outbound_total_calls: 0,
    outbound_not_answered: 0,

    // ── Sales vs. operational classification ────────────────────────────
    // (SALES-VS-OPERATIONAL-CLASSIFICATION-SPEC.md.) Three of Peter's
    // eleven scorecard lines read off these.
    //
    // *** NULL IS NOT ZERO, AND HERE THAT IS AN ARITHMETIC HAZARD, NOT
    // ONLY A LABELLING ONE. *** Every row written before this feature's
    // first night carries NULL in all four classification columns, and so
    // does any night whose HubSpot lookup failed. Such a row contributes
    // to NONE of the four counters below — it is counted in the
    // unclassified pair instead.
    //
    // If an unclassified row's calls were folded in as zeros, a date range
    // reaching back before the changeover would report a real, specific,
    // confidently-wrong number: "you made 3 outbound sales calls that
    // week." That is worse than a gap, because it looks like an answer.
    // The unclassified counters exist so the page can say the range is
    // partly unclassified rather than quietly averaging a wall of zeros
    // into it. Same discipline as the unmeasured-line-miss pair above.
    sales_calls: 0,
    unmatched_calls: 0,
    unknown_calls: 0,
    sales_conversations: 0,

    // Metric 2 is "number of OUTBOUND sales calls" and metric 3 is
    // "conversations from OUTBOUND sales calls," so the outbound halves
    // are accumulated separately rather than derived later — the blended
    // figure cannot be split back apart once summed.
    outbound_sales_calls: 0,
    outbound_unmatched_calls: 0,
    outbound_sales_conversations: 0,

    // The denominator that makes the three counters above interpretable:
    // how many of this person's calls in range were actually classified,
    // and how many were not.
    classified_total_calls: 0,
    unclassified_rows: 0,
    unclassified_total_calls: 0,
  };
}

/**
 * Folds one `call_stats` row (person / calendar day / direction) into a
 * running total. Exactly the accumulation that used to sit inline in
 * router.js's stats route — moved, not rewritten.
 *
 * @param {Object} acc  from createPersonAccumulator()
 * @param {Object} row  a call_stats row: total_calls, answered_calls,
 *   missed_calls, total_talk_seconds, total_ring_seconds, direction
 */
function foldCallStatsRow(acc, row) {
  acc.total_calls += row.total_calls;
  acc.answered_calls += row.answered_calls;
  acc.total_talk_seconds += row.total_talk_seconds;

  if (row.direction === 'inbound') {
    acc.inbound_answered_calls_direct += row.answered_calls;
    acc.inbound_missed_calls_direct += row.missed_calls;
    acc.inbound_total_ring_seconds += row.total_ring_seconds;
  } else if (row.direction === 'outbound') {
    // missed_calls on an OUTBOUND row is the same column meaning something
    // different: a call this person PLACED that the other party never
    // picked up. A vendor not answering is not a staff responsiveness
    // problem, so it never reaches the Answer Rate or the Missed column.
    acc.outbound_not_answered += row.missed_calls;
    acc.outbound_total_calls += row.total_calls;
  }

  // ── Classification, folded only when the row was actually classified ──
  // The test is on sales_calls being non-null. The migration's CHECK
  // guarantees all four columns move together, so one test is enough and
  // testing all four would imply they can disagree — they cannot, by
  // constraint.
  //
  // A row from before the changeover date, or from a night whose HubSpot
  // lookup failed, lands in the unclassified pair and in NO other counter.
  // It is deliberately NOT treated as three zeros: see the accumulator's
  // own comment on why a confidently-wrong zero is worse than a visible
  // gap.
  if (row.sales_calls == null) {
    acc.unclassified_rows++;
    acc.unclassified_total_calls += row.total_calls;
    return;
  }
  acc.classified_total_calls += row.total_calls;
  acc.sales_calls += row.sales_calls;
  acc.unmatched_calls += row.unmatched_calls;
  acc.unknown_calls += row.unknown_calls;
  acc.sales_conversations += row.sales_conversations;
  if (row.direction === 'outbound') {
    acc.outbound_sales_calls += row.sales_calls;
    acc.outbound_unmatched_calls += row.unmatched_calls;
    // sales_conversations is outbound-only by definition (see the
    // migration's column comment), so on an inbound row it is always 0 —
    // added here anyway rather than assumed, so that if the definition
    // ever widens to inbound this split stays correct instead of silently
    // dropping half of it.
    acc.outbound_sales_conversations += row.sales_conversations;
  }
}

/**
 * The ONE gate that decides whether a shared-line row is charged to a
 * person. Peter's rule, approved 2026-09-10: an inbound call on a line that
 * rings EXACTLY ONE person counts toward that person; a call on a line that
 * rings nobody, or rings several people, stays charged to no individual.
 *
 * IT IS ONE GATE FOR BOTH HALVES, AND THAT IS THE POINT (Open Item 11).
 * A row that passes here contributes its misses to the person's denominator
 * AND its answered calls to their numerator. There is deliberately no
 * second, looser or stricter test for the answered side: two tests would be
 * two things to keep in step, and the asymmetry this function's callers
 * exist to remove is exactly what happens when they fall out of step.
 *
 * IT LIVES HERE, NOT IN router.js, AND THAT IS ALSO THE POINT (moved
 * 2026-09-10). It is pure — the caller passes the `users` lookup in, so this
 * module still touches no database and no Express — and it now has TWO
 * callers that must never disagree: the stats route, and
 * backfill-six-months.js's dry-run report. That report is what Peter reads
 * to decide whether to run the six-month backfill, and it has to answer
 * "how many of these misses will land on a named person" with the rule the
 * dashboard will actually apply, not with an approximation of it. It
 * previously used its own: it summed missed_calls_agents_did_not_answer
 * across EVERY row, including rows charged to nobody, and over six months
 * printed 1,661 where the true charged figure was 1,441. A second copy of
 * this rule is exactly how that happens, so there is one copy.
 *
 * A NOTE ON WHAT THIS GATE DOES NOT COVER. Callers must ALSO require that
 * the row is MEASURED (`missed_calls_agents_did_not_answer != null`) before
 * charging anything to anybody — see foldAttributedLineMissRow() below,
 * which returns early on exactly that test. That check is deliberately not
 * folded in here: it is a question about whether a sync ever looked at the
 * row, not about whose the calls are, and the two have different answers for
 * different callers. Rows fresh out of buildLineMissAggregates() are always
 * measured; rows read back from the table may not be.
 *
 * All four conditions are load-bearing:
 *
 *   direction === 'inbound' — an outbound call the other party didn't pick
 *     up is not a staff responsiveness signal (SPEC.md Design Decision 2),
 *     and an outbound call a shared line placed and connected is not a
 *     responsiveness signal either, so neither half of an outbound row is
 *     read back into anyone's numbers. The attribution columns are stamped
 *     onto outbound rows too, because "who did this line ring" is a fact
 *     about the line, but they are never read back into anyone's Answer
 *     Rate. In the 2026-08-15..2026-09-09 window this is not hypothetical:
 *     13 answered user-less OUTBOUND calls sit in this table, all on the
 *     Maintenance Hotline, and this condition is what keeps them out of a
 *     person's numerator.
 *
 *   ring_user_count === 1 — the entire justification for adding a
 *     LINE-keyed count into a PERSON-keyed denominator. It does not
 *     generalise to the two lines that ring three people each.
 *
 *   sole_user_email is set — a row with ring_user_count === 1 and a NULL
 *     email means the line rang exactly one person whose email could not be
 *     resolved. Neo's column comment is explicit: log it loudly, treat it as
 *     unattributed. A real miss going uncharged is bad; guessing who it
 *     belongs to would be worse.
 *
 *   the email matches a known Rincon user — without this, a miss attributed
 *     to an external vendor's Aircall seat would vanish from BOTH sections:
 *     it would count as attributed here, while the person's row is never
 *     rendered (the pods loop skips emails with no `users` match). Nothing
 *     is allowed to go missing between the two sections (migration NOTES FOR
 *     Q #5), so an unmatched email falls back to unattributed and stays
 *     visible in Shared Line Misses.
 *
 * @param {Object} row  a call_stats_line_misses row, or a row about to be
 *   written as one by lib/sync.js's buildLineMissAggregates()
 * @param {string} soleEmail  row.sole_user_email, lower-cased by the caller
 * @param {Map} usersByEmail  lower-cased email -> `users` row
 */
function isAttributableLineMissRow(row, soleEmail, usersByEmail) {
  return row.direction === 'inbound'
    && row.ring_user_count === 1
    && !!soleEmail
    && usersByEmail.has(soleEmail);
}

/**
 * Folds one ATTRIBUTED `call_stats_line_misses` row into the same running
 * total — the half that was missing before 2026-09-10. The WHOLE row is
 * folded: its misses into the denominator and its answers into the
 * numerator (Open Item 11, fixed 2026-09-10 — see this file's header for
 * the live verification that the answers were already stored).
 *
 * The caller decides what "attributed" means and does the checking; this
 * function does not re-check, because the decision needs the `users` table
 * (to confirm the email belongs to a real Rincon staff member) and this
 * module deliberately has no database access — the caller reads `users` and
 * passes the lookup in. isAttributableLineMissRow() directly above is that
 * gate, and it is the ONLY place a row may be judged attributable. The rule
 * it enforces:
 *
 *     direction === 'inbound'
 *       AND ring_user_count === 1
 *       AND sole_user_email is set
 *       AND that email matches a known Rincon user
 *
 * Anything else is unattributed and stays visible in the Shared Line Misses
 * section instead. In particular a row with ring_user_count === 1 and a
 * NULL sole_user_email is a data-quality ALARM, not an attribution — the
 * line rang exactly one person whose email could not be resolved, which
 * means a real, chargeable miss is going uncharged. Neo's column comment is
 * explicit that such a row is to be logged loudly and treated as
 * unattributed for every dashboard number.
 *
 * WHY total_calls MOVES TOO, AND WHY THAT IS NOT SCOPE CREEP. This row's
 * calls are added to the blended "Calls" column as well as to "Missed."
 * SPEC.md Design Decision 8's "the existing Calls column is deliberately
 * unchanged" was about not SPLITTING the column when the Outbound column
 * was added beside it — it is not a promise that the count never grows when
 * the underlying definition of a person's calls is corrected. Leaving these
 * out of total_calls would break the page's own internal arithmetic:
 * "Calls" minus "Outbound" is how a reader gets a person's inbound volume,
 * and Kristen's Missed column would then show 31 misses that her inbound
 * volume says never happened. The two columns have to agree, which is the
 * whole point of fixing them together.
 *
 * *** THE WHOLE ROW MOVES — row.total_calls, NOT row.missed_calls, AND NOT
 * total_calls MINUS THE UNCHARGED MISSES EITHER. *** An earlier version of
 * this comment claimed the identity "Calls - Outbound === answered + missed"
 * therefore holds exactly. It does not: this row's misses that Peter's rule
 * charges to nobody are in total_calls and in neither half of the fraction,
 * which is correct and deliberate — they are real calls on a real line, and
 * the rule about them is about fault, not existence. The identity has a third
 * term and closes exactly with it. See "THE PAGE'S OWN ARITHMETIC" in this
 * file's header for the measured gap, the full statement, and why narrowing
 * total_calls to make the two-term version true was rejected.
 *
 * ============================================================
 * WHAT THIS FIX DELIBERATELY DOES NOT TOUCH — the two averages, and why
 * leaving them alone is the choice that AVOIDS a new asymmetry rather than
 * creating one
 * ============================================================
 * A sole-user line row records how many calls there were and how many were
 * missed. It records NO TIME AT ALL — call_stats_line_misses has neither a
 * total_talk_seconds nor a total_ring_seconds column, by its own migration's
 * "don't invent columns beyond the confirmed need." So:
 *
 *   - acc.answered_calls (the blended count behind AVG. LENGTH) is NOT
 *     incremented here. Incrementing a denominator whose numerator
 *     (total_talk_seconds) cannot move would drag every affected person's
 *     Avg. Length down by an amount that is pure artefact — it would report
 *     shorter calls where nothing about the calls changed.
 *
 *   - AVG. SPEED TO ANSWER is divided by inbound_answered_calls_DIRECT, not
 *     by the combined answered count, for exactly the same reason on the
 *     ring-time side. This is the one place the Open Item 11 fix could have
 *     quietly introduced a NEW asymmetry while removing the old one, and it
 *     is the reason the answered side of the accumulator is split in two
 *     rather than summed on arrival. Getting this wrong would have made
 *     Leo O'Gorman — the person this fix exists to stop under-crediting —
 *     look like he answers the phone dramatically faster than he does,
 *     because his own line's answered calls would be counted as instant.
 *     Trading an understated Answer Rate for an overstated Speed to Answer
 *     is not a fix.
 *
 * Both averages therefore stay "computed over the calls we hold timings
 * for," which is what they already were. That is a real limitation and it
 * is named rather than hidden: a person with many answered calls on a
 * sole-user line has an Avg. Length and an Avg. Speed to Answer drawn from
 * a subset of their calls, while their Answer Rate and Missed count are
 * drawn from all of them.
 *
 * @param {Object} acc  from createPersonAccumulator()
 * @param {Object} row  a call_stats_line_misses row the caller has already
 *   confirmed is attributable to this person
 */
function foldAttributedLineMissRow(acc, row) {
  // ── UNMEASURED ROWS LEAVE THE FRACTION ENTIRELY ────────────────────────
  // NULL on these three columns means "no sync run ever looked at
  // missed_call_reason for this row," not "zero misses had a reason." The
  // all-or-none CHECK makes that one question rather than three, so testing
  // the typed column alone is sufficient and cannot disagree with the others.
  //
  // Reading NULL as 0 here would report every historical day as having zero
  // attributable misses — every affected person's Answer Rate snaps back to
  // 100%, which is exactly the false number this whole change exists to
  // remove, wearing the new code's clothes.
  //
  // *** CONSEQUENCE, STATED PLAINLY BECAUSE IT WILL LOOK LIKE A REGRESSION:
  // every row in call_stats_line_misses today is unmeasured. Until the
  // nightly sync has run with the change above, or the six-month backfill
  // lands, this branch takes ALL of them and the pod tables show no
  // shared-line misses at all. That is honest, not broken — for an
  // unmeasured row nobody can say how many of its misses were
  // `agents_did_not_answer`, and both alternatives are wrong: reading NULL
  // as 0 under-charges, reading missed_calls as if every miss were
  // chargeable over-charges (it would charge Kristen the 16 lunchtime
  // no_available_agent misses Peter explicitly excluded). The counts below
  // are what lets the page say which days are affected. ***
  if (row.missed_calls_agents_did_not_answer == null) {
    acc.inbound_unmeasured_line_miss_rows++;
    acc.inbound_unmeasured_line_missed_calls += row.missed_calls;
    acc.inbound_unmeasured_line_total_calls += row.total_calls;
    return;
  }

  // total_calls is a deliberate SUPERSET of missed_calls on this table (see
  // lib/sync.js's buildLineMissAggregates and its migration header): every
  // closed call with no `user` on Aircall's record is counted in
  // total_calls, and missed_calls counts only the subset with no
  // answered_at. So the difference IS the answered count, already stored —
  // no new collection, no schema change. Verified against the real table on
  // 2026-09-10; see this file's header for what was checked.
  //
  // Clamped at 0 rather than trusted, matching the defensive clamp
  // buildDailyAggregates() already applies to its timestamp deltas. The
  // schema does not constrain missed_calls <= total_calls, and a negative
  // contribution here would inflate someone's Answer Rate above 100% —
  // silently, on a scorecard, in the direction nobody would question.
  const answered = row.total_calls - row.missed_calls;
  acc.inbound_answered_calls_shared_line += answered > 0 ? answered : 0;

  // ── THE DENOMINATOR CHANGE, 2026-09-10 ────────────────────────────────
  // This line used to read `row.missed_calls`. It now reads ONLY the misses
  // Aircall reported as `agents_did_not_answer` — somebody was available and
  // the phone rang out. Peter's rule, approved 2026-09-10: the other reasons
  // stay visible and are charged to nobody, because `no_available_agent` is
  // Kristen manually switching to the phone tree for lunch plus her 9am
  // start (a schedule, not a performance failure) and `short_abandoned` is
  // the caller hanging up after a median of NINE seconds, which nobody could
  // have answered. Measured effect on Kristen, her two lines, WHOLE days
  // 2026-09-01..09-09: 53% -> 69%.
  //
  // Clamped for the same reason the answered count is: Guard 1 on the table
  // bounds this column to [0, missed_calls], but the clamp costs nothing and
  // the direction of an unclamped error here (charging someone MORE misses
  // than their line took) is the one nobody would question either.
  //
  // Clamped at BOTH ends as of 2026-09-10, which is what router.js's
  // chargeableOnRow already did — the two are the same number computed twice
  // and had no business disagreeing. The upper clamp is what makes the
  // header's three-term identity hold unconditionally rather than only on
  // rows that satisfy Guard 1: without it, a row claiming more charged misses
  // than it had misses would push `charged` up and `notCharged` down to its
  // own floor of 0, and the two would stop cancelling.
  const charged = Math.max(0, Math.min(row.missed_calls, row.missed_calls_agents_did_not_answer));
  acc.inbound_missed_calls_shared_line += charged;

  // The remainder: real misses on this person's own line, for reasons that
  // are not theirs. Never in the fraction; surfaced so the page can explain
  // the difference between this person's Missed column and their line's own
  // miss count instead of leaving a reader to wonder where the rest went.
  //
  // This is the third term of the header's identity, and the reason it is
  // returned to the page rather than only accumulated here: it is exactly the
  // gap TARS measured between "Calls - Outbound" and "answered + missed."
  const notCharged = row.missed_calls - charged;
  acc.inbound_missed_calls_not_charged_reason += notCharged > 0 ? notCharged : 0;

  // Voicemail rate is a share of MISSES — all of them, every reason, not
  // just the charged ones. A caller who left a message after reaching the
  // lunchtime phone tree still left a message; that is the fact Peter asked
  // for. Its denominator is therefore this row's whole missed_calls, and it
  // is accumulated separately from the Answer Rate's denominator rather than
  // reusing it, because the two are now genuinely different numbers.
  acc.inbound_voicemails_left_shared_line += row.voicemails_left > 0 ? row.voicemails_left : 0;
  acc.inbound_measured_missed_calls_shared_line += row.missed_calls;

  acc.total_calls += row.total_calls;
}

/**
 * Turns a finished accumulator into the numbers the dashboard renders. The
 * only place in this tool where anything is divided.
 *
 * Every rate/average is null — never 0 — when there is nothing to divide.
 * "Had no inbound calls" and "answered none of their inbound calls" are
 * different facts, and these numbers are read off a scorecard in a weekly
 * meeting where a 0% would be read as the second one. The dashboard renders
 * null as an em dash. The plain COUNTS below are the opposite and on
 * purpose: someone who placed no outbound calls placed zero, which is
 * itself the useful fact.
 */
function computePersonMetrics(acc) {
  // Both halves of the fraction are built the same way from the same two
  // sources — that symmetry IS the Open Item 11 fix, and writing them as a
  // matched pair here is what stops the two from drifting apart again.
  const inboundAnswered = acc.inbound_answered_calls_direct + acc.inbound_answered_calls_shared_line;
  const inboundMissed = acc.inbound_missed_calls_direct + acc.inbound_missed_calls_shared_line;
  const inboundTotal = inboundAnswered + inboundMissed;

  return {
    // Blended inbound + outbound. See foldAttributedLineMissRow() above for
    // why sole-user line misses are part of this now.
    total_calls: acc.total_calls,
    outbound_total_calls: acc.outbound_total_calls,
    avg_length_seconds: acc.answered_calls > 0
      ? Math.round(acc.total_talk_seconds / acc.answered_calls)
      : null,

    // The "Missed" column: this person's real inbound miss count, from both
    // sources. Before 2026-09-10 this read 0 for everyone, always.
    inbound_missed_calls: inboundMissed,
    // This person's inbound answered count, from both sources. Not a column
    // on the page today, but returned because it is now the numerator of
    // the Answer Rate and a percentage nobody can see the numerator of is
    // not auditable in a meeting.
    inbound_answered_calls: inboundAnswered,
    // Both numbers broken out by where they came from — returned so the
    // combined figures can be audited rather than taken on trust, and so
    // that "is this person's rate moving because of their own rows or their
    // line's rows" is answerable without a database query.
    inbound_answered_calls_direct: acc.inbound_answered_calls_direct,
    inbound_answered_calls_shared_line: acc.inbound_answered_calls_shared_line,
    inbound_missed_calls_direct: acc.inbound_missed_calls_direct,
    inbound_missed_calls_shared_line: acc.inbound_missed_calls_shared_line,

    // Real misses on this person's own sole-user line that Peter's rule
    // charges to nobody — a schedule, a nine-second hang-up, an after-hours
    // call. Returned so the page can account for the gap between this
    // person's Missed column and their line's miss count. NOT in the
    // fraction above, by design and by Peter's explicit decision — but it IS
    // in total_calls, which makes it the third term of the identity in this
    // file's header and the number the page needs to reconcile "Calls minus
    // Outbound" against "answered plus Missed."
    inbound_missed_calls_not_charged_reason: acc.inbound_missed_calls_not_charged_reason,

    // ── The unmeasured gap. Present so the page can be honest about it. ──
    // Every one of these is a row whose misses could not be split by reason
    // because no sync run ever looked. They are in NEITHER half of the
    // Answer Rate. If this is non-zero for a range, that range's Answer Rate
    // is computed over less than the whole story and the dashboard must say
    // so — a silently smaller denominator is a quietly wrong number.
    inbound_unmeasured_line_miss_rows: acc.inbound_unmeasured_line_miss_rows,
    inbound_unmeasured_line_missed_calls: acc.inbound_unmeasured_line_missed_calls,
    inbound_unmeasured_line_total_calls: acc.inbound_unmeasured_line_total_calls,
    // One boolean so Tron does not have to decide which of the three above
    // is the right test — and so the answer is the same everywhere.
    has_unmeasured_line_misses: acc.inbound_unmeasured_line_miss_rows > 0,

    // ── The two voicemail numbers Peter asked for, 2026-09-10 ───────────
    // A COUNT and a SHARE. Never a link to a recording — see the migration.
    // The rate is null, not 0, when there were no measured misses to divide
    // by: "nobody left a voicemail" and "there were no misses" are different
    // facts, same rule every other rate in this file follows. Raw 0-1
    // fraction; the dashboard formats it.
    //
    // Voicemails RETURNED is deliberately absent and must stay absent —
    // COMMITTED-NOT-BUILT.md item 1, blocked on Asimov because it requires
    // storing callers' phone numbers.
    voicemails_left: acc.inbound_voicemails_left_shared_line,
    voicemail_rate: acc.inbound_measured_missed_calls_shared_line > 0
      ? acc.inbound_voicemails_left_shared_line / acc.inbound_measured_missed_calls_shared_line
      : null,

    // Raw 0–1 fraction, never a pre-formatted percent — same split of
    // responsibilities as avg_length_seconds returning plain seconds and
    // leaving "3m 05s" to the dashboard.
    answer_rate: inboundTotal > 0 ? inboundAnswered / inboundTotal : null,

    // Divided by the DIRECT answered count only, never the combined one.
    // call_stats_line_misses carries no total_ring_seconds column, so a
    // shared-line answered call adds to this denominator with nothing to
    // add to the numerator — it would report a ring time of zero for a call
    // whose ring time is simply unknown. See foldAttributedLineMissRow()'s
    // "WHAT THIS FIX DELIBERATELY DOES NOT TOUCH" for the full reasoning.
    // *** Do not "tidy" this to inboundAnswered. ***
    avg_speed_to_answer_seconds: acc.inbound_answered_calls_direct > 0
      ? Math.round(acc.inbound_total_ring_seconds / acc.inbound_answered_calls_direct)
      : null,

    outbound_not_answered: acc.outbound_not_answered,

    // ── The three scorecard lines this classification exists to serve ───
    // Raw counts, never a rate, and never pre-divided — same rule as every
    // other number in this file.
    //
    // *** "unmatched" IS PETER'S OPERATIONAL-CALL COUNT AND IT IS NOT
    // NAMED THAT. *** Design Decision 24: the tool has positive evidence
    // for exactly one of the three buckets. Sales is a finding — a human
    // at Rincon marked this number as a prospect. Unmatched is the ABSENCE
    // of a finding, and it holds at least three different things: genuine
    // tenant and vendor calls, prospects nobody advanced in HubSpot, and
    // personal or wrong-number calls. Renaming it "operational" here would
    // assert a fact about all three, on a page read out in a meeting.
    // The dashboard must label it "Not matched."
    sales_calls: acc.sales_calls,
    unmatched_calls: acc.unmatched_calls,
    unknown_calls: acc.unknown_calls,
    sales_conversations: acc.sales_conversations,
    outbound_sales_calls: acc.outbound_sales_calls,
    outbound_unmatched_calls: acc.outbound_unmatched_calls,
    outbound_sales_conversations: acc.outbound_sales_conversations,

    // ── The gap, so the page can be honest about it ─────────────────────
    // Non-zero means the requested range reaches back before this feature's
    // first night, or includes a night whose lookup failed. Those calls are
    // in NO classification counter above. A range like that must render as
    // partly unclassified — NOT as a smaller sales number, which is what it
    // would look like otherwise.
    classified_total_calls: acc.classified_total_calls,
    unclassified_rows: acc.unclassified_rows,
    unclassified_total_calls: acc.unclassified_total_calls,
    // One boolean so Tron does not have to pick which of the three above is
    // the right test, and so the answer is the same everywhere on the page.
    has_unclassified_calls: acc.unclassified_rows > 0,

    // The portfolio-level health figure Design Decision 24 asks for, per
    // person: what share of this person's classified calls carried a usable
    // number at all. Null rather than 1 when nothing was classified —
    // "no classified calls" and "100% usable" are different facts. Raw
    // 0–1 fraction; the dashboard formats it.
    usable_number_rate: acc.classified_total_calls > 0
      ? (acc.classified_total_calls - acc.unknown_calls) / acc.classified_total_calls
      : null,
  };
}

/**
 * The metric values for a person with no activity at all in a range. Used
 * for the Solimar/Faria roster placeholders — staff who have a pod but no
 * rows in range still appear in their pod's table with all-zero numbers
 * rather than silently vanishing, because "this person had no calls" is a
 * real answer and "we have no data on this person" is not the same thing.
 *
 * Computed from an empty accumulator rather than hand-written as a literal,
 * so it can never drift out of step with computePersonMetrics() when a
 * column is added or a definition changes.
 */
function emptyPersonMetrics() {
  return computePersonMetrics(createPersonAccumulator());
}

module.exports = {
  createPersonAccumulator,
  foldCallStatsRow,
  foldAttributedLineMissRow,
  // The attribution gate. Exported so router.js and backfill-six-months.js
  // share ONE definition of "charged to a person" rather than two that can
  // drift — see the function's own header for what drifting cost last time.
  isAttributableLineMissRow,
  computePersonMetrics,
  emptyPersonMetrics,
};
