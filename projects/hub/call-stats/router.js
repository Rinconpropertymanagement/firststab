/**
 * call-stats/router.js
 * Call Stats tool — a section of the Rincon Hub, built the same way
 * Insurance Compliance, Security Deposit, and Maintenance History were:
 * one router file, mounted into projects/hub/server.js, reusing the Hub's
 * existing login.
 *
 * Full spec: projects/hub/call-stats/SPEC.md — treat it as authoritative,
 * along with the header comments in
 * supabase/migrations/20260819010000_call_stats.sql (grain/column
 * decisions, live-verified Aircall API behavior) and
 * lib/aircall-connector.js (this build's own, further live verification).
 *
 * No AI, no `claims`, no review queue — this is a plain fetched-and-summed
 * fact, synced nightly, displayed read-only (SPEC.md Design Decision 3).
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const aircall = require('./lib/aircall-connector');
const hubspot = require('./lib/hubspot-connector');
const { buildDailyAggregates, buildLineMissAggregates, buildHubspotDailyAggregates } = require('./lib/sync');
// Every per-person number this route returns is computed in lib/metrics.js,
// never inline here — TREND-VIEW-SPEC.md Design Decision 3 makes that a
// build requirement, so that the trend route landing next shares this
// arithmetic instead of copying it and drifting out of step with it. See
// that file's header for the full reasoning and for what the Answer Rate
// now counts.
const {
  createPersonAccumulator,
  foldCallStatsRow,
  foldAttributedLineMissRow,
  computePersonMetrics,
  emptyPersonMetrics,
} = require('./lib/metrics');
const { pacificDayBoundsUnix, yesterdayPacificDateStr } = require('./lib/timezone');
const { GLOBAL_SEARCH_WIDGET_HTML } = require('../lib/global-search-widget');

// ─── Config ─────────────────────────────────────────────────────────────
const missing = [];
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
if (missing.length > 0) {
  console.error(`[call-stats] Missing environment variables: ${missing.join(', ')}`);
  console.error('[call-stats] Set these in the shared .env at the project root (see .env.example).');
  process.exit(1);
}
// AIRCALL_API_ID / AIRCALL_API_TOKEN and HUBSPOT_PRIVATE_APP_TOKEN are both
// checked lazily inside their own connector modules — a missing key
// shouldn't take down the whole Hub, only the nightly sync route that
// actually needs to call that API (same reasoning
// maintenance-history/router.js gives for LATCHEL_API_KEY). The HubSpot
// sync below is additionally wrapped in its own try/catch so a missing
// HUBSPOT_PRIVATE_APP_TOKEN can't even take down the Aircall half of the
// same nightly sync route, let alone the rest of the Hub.

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Pagination helper — Supabase/PostgREST caps any single .select() at
// 1000 rows by default, silently (no error). Same fix, same reasoning, as
// security-deposit/router.js's and maintenance-history/router.js's
// fetchAllRows.
const SUPABASE_PAGE_SIZE = 1000;
async function fetchAllRows(buildPage) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await buildPage(from, from + SUPABASE_PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data || []) rows.push(row);
    if (!data || data.length < SUPABASE_PAGE_SIZE) break;
    from += SUPABASE_PAGE_SIZE;
  }
  return rows;
}

// ─── Permission check — reads Neo's shared team tables ─────────────────
// Same fail-closed pattern as the other three tools' routers.
async function attachCallStatsRole(req, res, next) {
  req.callStatsRole = null;
  req.teamMemberId = null;
  req.callStatsMemberName = null;

  try {
    const { data: member, error: memberErr } = await supabase
      .from('team_members')
      .select('id, full_name, is_active')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (memberErr) throw memberErr;
    if (!member || !member.is_active) return next();

    req.teamMemberId = member.id;
    req.callStatsMemberName = member.full_name || null;

    const { data: roleRow, error: roleErr } = await supabase
      .from('team_member_tool_roles')
      .select('role')
      .eq('team_member_id', member.id)
      .eq('tool', 'call_stats')
      .maybeSingle();
    if (roleErr) throw roleErr;
    req.callStatsRole = roleRow ? roleRow.role : null;
    next();
  } catch (err) {
    console.error('[call-stats] permission lookup failed:', err.message);
    next();
  }
}

function requireCallStatsAccess(req, res, next) {
  if (!req.callStatsRole) {
    return res.status(403).json({
      error: 'Your Rincon Hub account does not have access to Call Stats yet. Ask an admin to grant you access.',
    });
  }
  next();
}

function requireCallStatsRole(...roles) {
  return (req, res, next) => {
    if (!req.callStatsRole || !roles.includes(req.callStatsRole)) {
      return res.status(403).json({ error: 'Insufficient permissions', required: roles, actual: req.callStatsRole });
    }
    next();
  };
}

// ─── Router: everyone reaching here is already hub-logged-in ───────────
const router = express.Router();
router.use(attachCallStatsRole);

// Same "read + inject the shared search widget, then send" approach as the
// other three tools' dashboard routes.
router.get('/call-stats', (req, res) => {
  fs.readFile(path.join(__dirname, 'dashboard', 'index.html'), 'utf8', (err, html) => {
    if (err) return res.status(500).send('Could not load page.');
    res.send(html.replace('<body>', '<body>\n' + GLOBAL_SEARCH_WIDGET_HTML));
  });
});

router.get('/api/call-stats/auth/me', requireCallStatsAccess, (req, res) => {
  res.json({
    email: req.user.email,
    name: req.callStatsMemberName || req.user.email,
    role: req.callStatsRole,
  });
});

// ─── GET /api/call-stats/stats?from=YYYY-MM-DD&to=YYYY-MM-DD ───────────
// SPEC.md's "v1 access is flat" (Access / Roles section) — anyone holding
// admin or pod_lead for tool='call_stats' sees BOTH pods, so there is no
// per-pod filtering here at all, same simplification already shipped for
// Security Deposit's pod_lead.
//
// Averages are computed live from stored sums/counts — never stored
// pre-divided (Design Decision 2) — and every one of them is computed in
// lib/metrics.js, not here. "Calls" and "Avg. Length" blend both directions
// (an overall activity number); "Missed", "Answer Rate" and "Avg. Speed to
// Answer" are inbound-only, per the spec's explicit "don't present
// speed-to-answer as a staff performance number for outbound rows" and
// "'Missed' means inbound calls nobody picked up, not every call that
// didn't connect." `outbound_not_answered` is the outbound counterpart —
// same missed_calls column, opposite direction, deliberately a separate
// field rather than folded into inbound_missed_calls, since the spec is
// explicit that the two aren't the same signal (a vendor not picking up
// isn't a staff responsiveness problem the way an inbound miss is).
//
// ============================================================
// CHANGED 2026-09-10 — "Missed" and "Answer Rate" now count shared-line
// misses on lines that ring exactly one person
// ============================================================
// This route used to read a person's inbound misses from call_stats alone.
// In Aircall, an inbound call nobody answers arrives with `call.user ===
// null`, so lib/sync.js's buildDailyAggregates() skips it entirely and it
// never reaches a call_stats row — it lands in call_stats_line_misses,
// keyed by LINE. TARS confirmed the consequence against the live database:
// call_stats.missed_calls is 0 on every inbound row, all-time. So the
// Answer Rate could only ever be 100% or a dash, and Missed could only ever
// be 0. Not an edge case — arithmetic.
//
// Peter's rule, approved 2026-09-10: an inbound call on a line that rings
// EXACTLY ONE person counts toward that person. Lines that ring nobody
// (Maintenance Hotline, Leasing Line) or ring several people (the two phone
// trees) stay charged to no individual and remain visible, and counted, in
// the Shared Line Misses section. Both columns are fixed together — fixing
// only one would leave the page contradicting itself, an 88% answer rate
// next to a Missed count of 0.
//
// ============================================================
// OPEN ITEM 11, fixed 2026-09-10 (second pass) — the rule covers the WHOLE
// row, answered and missed, not just the misses
// ============================================================
// The first pass of the change above charged a sole-user line's MISSES to
// its one person but credited that line's ANSWERED calls — the inbound
// calls that arrive with no `user` attached but with an answered_at — to
// nobody. Same line, same person, opposite treatment depending on whether
// the call went well. On a scorecard reviewed weekly with named staff in
// the room that is not defensible, and Peter said so: charging someone for
// the bad half while withholding the good half is not a metric, it is a
// penalty. So the sole-user rule is now applied to the row as a whole.
//
// This needed NO sync change and NO schema change, verified against the
// real table rather than assumed. call_stats_line_misses is named for
// misses, but total_calls is a deliberate superset of missed_calls — the
// sync counts every user-less call into total_calls and only the
// answered_at-is-null subset into missed_calls — so an attributed row's
// answered count is total_calls - missed_calls, already stored, already
// selected below. lib/metrics.js's header records the live checks.
//
// Nothing about the attributed/unattributed reconciliation changes shape:
// every row still increments exactly one side, now on both counters.
//
// SPEC.md Design Decision 7's "direct rings only" exclusion is superseded
// on this point and the reason is on the record: its stated factual basis
// ("Aircall already attributes misses on those two lines to her") was
// checked against real data and did not hold. See
// answer-rate-redefinition-SPEC.md Design Decision 9. The half of Design
// Decision 7 that was never dependent on that premise — outbound excluded
// from both halves of the fraction — is unchanged.
//
// Every percentage this route returns is an UPPER BOUND. Aircall reports
// which users a line RINGS, not where it FORWARDS (SPEC.md Open Item 7,
// still open). Unmodelled forwarding can only ever ADD misses to someone's
// denominator, never remove them, so the true figure is this or lower. The
// dashboard states that on the page.
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
 */
function isAttributableLineMissRow(row, soleEmail, usersByEmail) {
  return row.direction === 'inbound'
    && row.ring_user_count === 1
    && !!soleEmail
    && usersByEmail.has(soleEmail);
}

/**
 * Whether a line is Rincon's after-hours phone tree, for labelling only.
 *
 * Peter accepted on 2026-09-10 that after-hours misses belong to nobody
 * "as long as it's obvious they were after hours." The line in question is
 * "Office Line Phone Tree - Outside Office Hours" — 19 misses in the four
 * weeks to 2026-09-09, the third-largest source of misses in the window,
 * and one of the two lines that ring three people (Liz, Marci, Dio), so it
 * attributes to nobody under the rule above regardless.
 *
 * MATCHED ON AIRCALL'S OWN LINE NAME, and that is a deliberate limit worth
 * being plain about: this is NOT a computed time-of-day fact. It cannot be.
 * call_stats_line_misses' grain is one row per line per DAY, so no clock
 * time survives the nightly aggregation — there is no time-of-day signal in
 * this data at all. What is being surfaced is the label Rincon already put
 * on the line in Aircall, which is exactly what makes it obvious to a
 * reader, and it fails safe: rename the line in Aircall and the badge
 * disappears, which is visible, rather than a hardcoded line ID silently
 * labelling the wrong line after a reconfiguration.
 *
 * Matched by NAME rather than by a hardcoded aircall_number_id on purpose:
 * an ID would be an invisible magic constant that keeps matching a line
 * whose meaning has changed, and would need a code edit if Rincon ever adds
 * a second after-hours tree (e.g. per pod).
 */
const AFTER_HOURS_LINE_NAME_PATTERN = /outside office hours|after[ -]hours/i;
function isAfterHoursLine(lineName) {
  return AFTER_HOURS_LINE_NAME_PATTERN.test(String(lineName || ''));
}

function isValidCalendarDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [year, month, day] = dateStr.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    !isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

router.get('/api/call-stats/stats', requireCallStatsAccess, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to || !isValidCalendarDate(from) || !isValidCalendarDate(to)) {
    return res.status(400).json({ error: 'from and to are required, each a valid YYYY-MM-DD date.' });
  }
  if (from > to) {
    return res.status(400).json({ error: '"from" must not be after "to".' });
  }

  let rows;
  try {
    rows = await fetchAllRows((rangeFrom, rangeTo) => supabase
      .from('call_stats')
      .select('aircall_user_id, staff_email, call_date, direction, total_calls, answered_calls, missed_calls, total_talk_seconds, total_ring_seconds, synced_at')
      .gte('call_date', from)
      .lte('call_date', to)
      .order('call_date', { ascending: true })
      .range(rangeFrom, rangeTo));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  // Pod (Solimar/Faria) is looked up here, at query time, never stored on
  // call_stats — Design Decision 1. Only the four "pod role" users have a
  // non-null pod. Everyone else's calls are still summed correctly below
  // and captured by the nightly sync regardless of pod — but historically
  // they simply didn't appear anywhere on this dashboard. That's the gap
  // this fetch (now unfiltered by pod) and the `Other` bucket below fix:
  // active staff with no pod (Business Development, Operations, Executive
  // — e.g. Kristen Rau) who have real call activity in the requested range
  // now show up too, in a third group, rather than being invisible.
  const { data: users, error: usersErr } = await supabase
    .from('users')
    .select('email, name, pod, is_active');
  if (usersErr) return res.status(500).json({ error: usersErr.message });
  const usersByEmail = new Map((users || []).map(u => [u.email.toLowerCase(), u]));

  // ─── Per-person accumulators ────────────────────────────────────────────
  // Raw running sums only — nothing is divided until computePersonMetrics()
  // at the bottom (SPEC.md Design Decision 2's "never store or carry a
  // number pre-divided," and the reason lib/metrics.js is an accumulator
  // plus a compute step rather than one function over a row).
  const accumulators = new Map(); // lowercased staff email -> accumulator
  function accumulatorFor(email) {
    let acc = accumulators.get(email);
    if (!acc) {
      acc = createPersonAccumulator();
      accumulators.set(email, acc);
    }
    return acc;
  }

  let mostRecentSync = null;
  for (const r of rows) {
    if (r.synced_at && (!mostRecentSync || r.synced_at > mostRecentSync)) mostRecentSync = r.synced_at;
    // Lower-cased here as well as at sync time: this map is now also keyed
    // by call_stats_line_misses.sole_user_email, and the two halves of the
    // Answer Rate fraction must land in the SAME bucket. A single
    // capitalised address on either side would silently split one person
    // into two accumulators — their answered calls in one, their misses in
    // the other — and the dashboard would show a confidently wrong
    // percentage with nothing anywhere reporting a problem.
    foldCallStatsRow(accumulatorFor(String(r.staff_email || '').toLowerCase()), r);
  }

  // ─── Shared-line misses (call_stats_line_misses) ────────────────────────
  // The user:null calls call_stats has no grain to hold at all (see
  // lib/sync.js's buildLineMissAggregates and its migration header). Same
  // date range this route already queried call_stats with, reusing whichever
  // preset/custom range the dashboard is showing — no separate picker.
  //
  // Fetched BEFORE the pod tables are built, not after, because as of
  // 2026-09-10 these rows are half of every person's Answer Rate: a miss on
  // a line that rang exactly one person is charged to that person. Before
  // this change the pod tables could be finished without ever looking at
  // this table, which is exactly why the Answer Rate column could only read
  // 100% or a dash and the Missed column could only read 0.
  //
  // sole_user_email / ring_user_count are the attribution snapshot the
  // nightly sync stamps on each row — see migration 20260910010000. They are
  // read here and never recomputed: a line changing hands in Aircall must
  // not retroactively move an earlier day's misses onto a different person.
  let lineMissRows;
  try {
    lineMissRows = await fetchAllRows((rangeFrom, rangeTo) => supabase
      .from('call_stats_line_misses')
      .select('aircall_number_id, line_name, line_digits, call_date, direction, total_calls, missed_calls, sole_user_email, ring_user_count, missed_calls_agents_did_not_answer, missed_calls_by_reason, voicemails_left')
      .gte('call_date', from)
      .lte('call_date', to)
      .range(rangeFrom, rangeTo));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  // Per-line display aggregate, PLUS the fold into each person's totals.
  // One pass, so the two can never disagree about which calls were charged
  // to someone: every row increments exactly one of attributed_* or
  // unattributed_*, so attributed + unattributed always equals that line's
  // own figure, and the section totals always equal the range total.
  // Nothing is allowed to go missing between the two sections (migration
  // NOTES FOR Q #5) — that is what makes the per-person percentages
  // readable next to the remainder charged to nobody.
  //
  // As of the Open Item 11 fix that invariant is tracked for the ANSWERED
  // calls on these rows as well, not only the misses. The answered figures
  // are not a column on the page — Tron owns what the Shared Line Misses
  // section renders — but they are computed and returned here for the same
  // reason the misses are: an Answer Rate whose numerator cannot be
  // reconciled against the rows it came from is a number that has to be
  // taken on trust, and this one is read out in a weekly staff meeting.
  // They cost nothing: this pass already reads both columns.
  //
  // Summed across direction for display: this section answers "how many
  // calls did this shared line handle and miss," not a per-direction
  // breakdown. Only INBOUND rows can ever be attributed (see
  // isAttributableLineMissRow), so an outbound line miss — and an outbound
  // ANSWERED call, of which this table holds 13 in the sampled window —
  // always lands in the unattributed half. Correct in both directions:
  // neither a vendor not picking up a call placed from a shared line, nor a
  // shared line successfully placing one, is any individual's
  // responsiveness signal.
  //
  // ============================================================
  // THE FOUR BUCKETS EVERY MISS FALLS INTO — added 2026-09-10 with the
  // miss-reason columns (migration 20260910020000 NOTES FOR Q #11)
  // ============================================================
  // "Attributed vs. unattributed" is no longer enough, because a miss can
  // now go uncharged for two completely different reasons and Tron cannot
  // label the section honestly without knowing which. Every miss in the
  // range lands in EXACTLY ONE of these four, and the four must sum to
  // lineMissTotals.missed_calls — TARS should test that addition directly:
  //
  //   1. charged_to_person       `agents_did_not_answer` on a line that rang
  //                              exactly one resolvable Rincon user.
  //   2. charged_to_nobody_reason  any OTHER reason, on ANY line — the
  //                              lunchtime phone tree, the nine-second
  //                              hang-up, after hours, abandoned in the IVR.
  //                              Peter's rule: real misses, nobody's fault.
  //   3. charged_to_nobody_line  `agents_did_not_answer`, but on a line that
  //                              rang nobody or rang several. Somebody was
  //                              available and it rang out — but no one
  //                              person owns the line, so no one person owns
  //                              the miss.
  //   4. unmeasured              the row predates the miss-reason sync, so
  //                              its misses cannot be split at all. NOT
  //                              zero. NOT charged. Counted and shown.
  //
  // Buckets 2 and 3 are cut this way rather than "reason first for sole-user
  // lines, line for everything else" precisely so they stay disjoint: a
  // no_available_agent miss on a three-user phone tree is a REASON exclusion
  // (bucket 2), counted once, not counted again under the line.
  const lineMissesByNumber = new Map();
  const lineMissTotals = {
    missed_calls: 0,
    attributed_missed_calls: 0,
    unattributed_missed_calls: 0,
    after_hours_missed_calls: 0,
    // total_calls on these rows is a superset of missed_calls (every
    // user-less call, answered or not), so the difference is the answered
    // count. Derived here rather than stored, because it is derived in
    // lib/metrics.js too and one definition in two places is one definition.
    answered_calls: 0,
    attributed_answered_calls: 0,
    unattributed_answered_calls: 0,

    // The four buckets above. These sum to missed_calls.
    charged_to_person_missed_calls: 0,
    charged_to_nobody_reason_missed_calls: 0,
    charged_to_nobody_line_missed_calls: 0,
    unmeasured_missed_calls: 0,
    unmeasured_rows: 0,

    // Voicemails: a COUNT and, computed at the end, a SHARE OF MISSES. Only
    // measured rows can contribute — an unmeasured row's voicemail count is
    // NULL and unknowable, so measured_missed_calls (not missed_calls) is
    // the rate's denominator. The recording URL is never stored, fetched or
    // displayed anywhere in this tool; see the migration's voicemails_left
    // comment for why that is absolute rather than a detail to revisit.
    voicemails_left: 0,
    measured_missed_calls: 0,

    // The whole-range reason breakdown, reason -> count, merged from every
    // row's missed_calls_by_reason map. Includes any value Aircall invents
    // that nobody has seen yet, verbatim and unbucketed — the map has no key
    // CHECK precisely so a new value shows up here instead of vanishing.
    missed_calls_by_reason: {},
  };
  // Data-quality alarms, surfaced in the API response rather than only in a
  // server log, because each one means a real, chargeable miss is going
  // uncharged to the person who should own it.
  const attributionAlarms = new Map();
  function raiseAlarm(kind, r) {
    const key = `${kind}|${r.aircall_number_id}`;
    let alarm = attributionAlarms.get(key);
    if (!alarm) {
      alarm = { kind, aircall_number_id: r.aircall_number_id, line_name: r.line_name, missed_calls: 0 };
      attributionAlarms.set(key, alarm);
    }
    alarm.missed_calls += r.missed_calls;
  }

  for (const r of lineMissRows) {
    let agg = lineMissesByNumber.get(r.aircall_number_id);
    if (!agg) {
      agg = {
        aircall_number_id: r.aircall_number_id,
        line_name: r.line_name,
        line_digits: r.line_digits,
        total_calls: 0,
        missed_calls: 0,
        attributed_missed_calls: 0,
        unattributed_missed_calls: 0,
        answered_calls: 0,
        attributed_answered_calls: 0,
        unattributed_answered_calls: 0,
        attributed_to: new Map(), // email -> { name, email, missed_calls, answered_calls }
        // The four disjoint buckets, per line — see the block comment above
        // lineMissTotals. Per-line as well as per-range because the question
        // "why is this line's miss count not in anybody's Answer Rate" is
        // asked about one line at a time, while looking at its row.
        charged_to_person_missed_calls: 0,
        charged_to_nobody_reason_missed_calls: 0,
        charged_to_nobody_line_missed_calls: 0,
        unmeasured_missed_calls: 0,
        unmeasured_rows: 0,
        voicemails_left: 0,
        measured_missed_calls: 0,
        missed_calls_by_reason: {},
        // Distinct ring_user_count values seen across the range. Usually one
        // value; more than one means the line's membership changed mid-range,
        // which the snapshot design handles correctly per day and which is
        // worth being able to see rather than flattening away.
        ring_user_counts: new Set(),
        after_hours: isAfterHoursLine(r.line_name),
      };
      lineMissesByNumber.set(r.aircall_number_id, agg);
    }
    // Clamped at 0 the same way lib/metrics.js clamps it, and for the same
    // reason: nothing in the schema constrains missed_calls <= total_calls,
    // and a negative answered count would quietly inflate both this
    // section's totals and someone's Answer Rate in the direction nobody
    // questions. Defined once here and reused for both the display
    // aggregate and the reconciliation totals so the two cannot disagree.
    const answeredOnRow = Math.max(0, r.total_calls - r.missed_calls);

    agg.total_calls += r.total_calls;
    agg.missed_calls += r.missed_calls;
    agg.answered_calls += answeredOnRow;
    agg.ring_user_counts.add(r.ring_user_count);
    lineMissTotals.missed_calls += r.missed_calls;
    lineMissTotals.answered_calls += answeredOnRow;
    if (agg.after_hours) lineMissTotals.after_hours_missed_calls += r.missed_calls;

    // ── Miss reasons and voicemails ───────────────────────────────────────
    // NULL on missed_calls_agents_did_not_answer means THIS ROW WAS NEVER
    // MEASURED — no sync run looked at missed_call_reason for it. The
    // all-or-none CHECK makes that one question rather than three, so this
    // single test is sufficient and cannot disagree with the other two
    // columns. It is the OPPOSITE convention to sole_user_email's NULL,
    // where NULL is a real answer ("this line had no sole user"). Reading
    // NULL as 0 here would report every historical day as having zero
    // attributable misses — flattering and entirely false.
    const measured = r.missed_calls_agents_did_not_answer != null;
    // Clamped for the same reason answeredOnRow is: Guard 1 bounds this
    // column to [0, missed_calls], but an unclamped error would run in the
    // direction nobody questions.
    const chargeableOnRow = measured ? Math.max(0, Math.min(r.missed_calls, r.missed_calls_agents_did_not_answer)) : 0;

    if (measured) {
      agg.measured_missed_calls += r.missed_calls;
      lineMissTotals.measured_missed_calls += r.missed_calls;
      agg.voicemails_left += Math.max(0, r.voicemails_left || 0);
      lineMissTotals.voicemails_left += Math.max(0, r.voicemails_left || 0);
      // Merged verbatim. Keys are NOT filtered against a known list and NOT
      // bucketed into "other" — an unrecognized Aircall value must stay
      // visible under its own name (migration NOTES FOR Q #6). Guarded for
      // shape rather than trusted: jsonb_typeof = 'object' is enforced by
      // the CHECK, so this is belt-and-braces against a hand-edited row.
      const byReason = (r.missed_calls_by_reason && typeof r.missed_calls_by_reason === 'object' && !Array.isArray(r.missed_calls_by_reason))
        ? r.missed_calls_by_reason : {};
      for (const [reason, count] of Object.entries(byReason)) {
        const n = Number(count) || 0;
        agg.missed_calls_by_reason[reason] = (agg.missed_calls_by_reason[reason] || 0) + n;
        lineMissTotals.missed_calls_by_reason[reason] = (lineMissTotals.missed_calls_by_reason[reason] || 0) + n;
      }
    } else {
      agg.unmeasured_rows++;
      agg.unmeasured_missed_calls += r.missed_calls;
      lineMissTotals.unmeasured_rows++;
      lineMissTotals.unmeasured_missed_calls += r.missed_calls;
    }

    const soleEmail = String(r.sole_user_email || '').toLowerCase();

    // Both alarm cases below are, deliberately, NOT reasons to guess. They
    // are reasons to leave the miss unattributed and say so out loud.
    if (r.ring_user_count === 1 && !soleEmail) {
      // The line rang exactly one person and the sync could not resolve
      // their email. Allowed by the table's CHECK constraint on purpose —
      // it is self-describing, because ring_user_count = 1 is right there —
      // but it means an attributable miss is going uncharged.
      raiseAlarm('sole_user_email_unresolved', r);
    } else if (soleEmail && !usersByEmail.has(soleEmail)) {
      // The line rang exactly one Aircall seat that is not a known Rincon
      // user — e.g. an external vendor's seat. Left unattributed so the
      // miss stays visible in this section instead of being charged to a
      // person row that this dashboard never renders.
      raiseAlarm('sole_user_not_a_rincon_user', r);
    }

    // ONE gate, both halves. foldAttributedLineMissRow() charges this row's
    // misses and credits its answered calls to the same person in the same
    // call — the whole point of the Open Item 11 fix is that there is no
    // branch here where one moves without the other.
    //
    // TWO conditions now, not one. `measured` joins the gate because an
    // unmeasured row cannot be charged to anyone: nobody can say how many of
    // its misses were `agents_did_not_answer`, and both guesses are wrong in
    // a direction that matters (0 under-charges everybody; missed_calls
    // over-charges Kristen by the 16 lunchtime no_available_agent misses
    // Peter explicitly excluded). It has to match lib/metrics.js exactly —
    // foldAttributedLineMissRow() returns early on the same test — or this
    // section would say a row was charged to someone while their Answer Rate
    // never saw it.
    const attributable = isAttributableLineMissRow(r, soleEmail, usersByEmail);
    if (attributable && measured) {
      foldAttributedLineMissRow(accumulatorFor(soleEmail), r);
      // *** attributed_missed_calls IS NOW THE CHARGED SUBSET, not the row's
      // whole missed_calls. *** The remainder goes to unattributed below, so
      // attributed + unattributed still equals this line's missed_calls
      // exactly and nothing goes missing between the two sections (migration
      // 20260910010000 NOTES FOR Q #5, unchanged and still enforced here).
      agg.attributed_missed_calls += chargeableOnRow;
      agg.attributed_answered_calls += answeredOnRow;
      lineMissTotals.attributed_missed_calls += chargeableOnRow;
      lineMissTotals.attributed_answered_calls += answeredOnRow;

      agg.charged_to_person_missed_calls += chargeableOnRow;
      lineMissTotals.charged_to_person_missed_calls += chargeableOnRow;
      // Bucket 2 on this row: the misses on this person's own line that
      // Peter's rule charges to nobody.
      const notChargedByReason = r.missed_calls - chargeableOnRow;
      agg.charged_to_nobody_reason_missed_calls += notChargedByReason;
      lineMissTotals.charged_to_nobody_reason_missed_calls += notChargedByReason;
      agg.unattributed_missed_calls += notChargedByReason;
      lineMissTotals.unattributed_missed_calls += notChargedByReason;

      const user = usersByEmail.get(soleEmail);
      let who = agg.attributed_to.get(soleEmail);
      if (!who) {
        who = { email: soleEmail, name: user ? user.name : soleEmail, missed_calls: 0, answered_calls: 0 };
        agg.attributed_to.set(soleEmail, who);
      }
      who.missed_calls += chargeableOnRow;
      who.answered_calls += answeredOnRow;
    } else {
      agg.unattributed_missed_calls += r.missed_calls;
      agg.unattributed_answered_calls += answeredOnRow;
      lineMissTotals.unattributed_missed_calls += r.missed_calls;
      lineMissTotals.unattributed_answered_calls += answeredOnRow;

      if (measured) {
        // Buckets 2 and 3, split. `agents_did_not_answer` misses here are
        // uncharged because of the LINE (it rang nobody, or several, or an
        // unresolvable seat); everything else is uncharged because of the
        // REASON, on any line. Disjoint, so they add up.
        agg.charged_to_nobody_line_missed_calls += chargeableOnRow;
        lineMissTotals.charged_to_nobody_line_missed_calls += chargeableOnRow;
        const notChargedByReason = r.missed_calls - chargeableOnRow;
        agg.charged_to_nobody_reason_missed_calls += notChargedByReason;
        lineMissTotals.charged_to_nobody_reason_missed_calls += notChargedByReason;
      }
      // Unmeasured rows are already counted into bucket 4 above and are
      // deliberately in none of the other three.
    }
  }

  const lineMisses = Array.from(lineMissesByNumber.values())
    .map(l => ({
      aircall_number_id: l.aircall_number_id,
      line_name: l.line_name,
      line_digits: l.line_digits,
      total_calls: l.total_calls,
      missed_calls: l.missed_calls,
      attributed_missed_calls: l.attributed_missed_calls,
      unattributed_missed_calls: l.unattributed_missed_calls,
      // The answered counterpart of the three fields above — the calls on
      // this line that Aircall attached no user to but that someone did
      // pick up. attributed_answered_calls is the share now credited to
      // this line's sole user (Open Item 11). Sorted below on misses, not
      // on these, because the section is still about misses.
      //
      // *** KNOWN DISPLAY GAP, FLAGGED NOT FIXED HERE — FOR TRON ***
      // dashboard/index.html splits this array into "Charged to a person"
      // and "Charged to nobody" on `attributed_missed_calls > 0` alone. A
      // sole-user line that has attributed ANSWERED calls but no misses in
      // the selected range therefore renders under "Charged to nobody,"
      // beneath text that says its calls are not in anyone's Answer Rate —
      // which, since this change, is wrong: they are. Not reachable in the
      // 8 days currently stored (every inbound row there has total_calls
      // === missed_calls) but reachable the moment the backfill lands, and
      // reachable today for any short range. The predicate wants to become
      // `attributed_missed_calls > 0 || attributed_answered_calls > 0`, and
      // the two headings want wording that covers calls rather than only
      // misses. Left to Tron rather than reached into from here, but
      // deliberately NOT left undocumented: shipping the numerator fix
      // while a section of the same page states the opposite would trade
      // one asymmetry for another.
      answered_calls: l.answered_calls,
      attributed_answered_calls: l.attributed_answered_calls,
      unattributed_answered_calls: l.unattributed_answered_calls,
      attributed_to: Array.from(l.attributed_to.values()).sort((a, b) => b.missed_calls - a.missed_calls),
      // null in this array means "no attribution snapshot on that row" —
      // either a day that predates the sync change, or the missing-line case
      // lib/sync.js logs. It is NOT the same as 0 ("this line rang nobody"),
      // and the dashboard says so rather than implying the line was checked.
      ring_user_counts: Array.from(l.ring_user_counts),
      after_hours: l.after_hours,

      // ── The four disjoint buckets for this line ──────────────────────
      // These four sum to missed_calls above. Tron needs them to label the
      // section honestly: "charged to nobody" is now two different
      // statements ("nobody's fault" vs. "nobody owns this line") plus an
      // "we do not know" that must not masquerade as either.
      charged_to_person_missed_calls: l.charged_to_person_missed_calls,
      charged_to_nobody_reason_missed_calls: l.charged_to_nobody_reason_missed_calls,
      charged_to_nobody_line_missed_calls: l.charged_to_nobody_line_missed_calls,
      unmeasured_missed_calls: l.unmeasured_missed_calls,
      unmeasured_rows: l.unmeasured_rows,
      // TRUE means some day in this range has no reason breakdown at all,
      // and the line's charged figure above is therefore drawn from less
      // than the whole range. The page must say so rather than render a
      // number that looks complete.
      has_unmeasured_days: l.unmeasured_rows > 0,

      // The full reason breakdown for this line over the range, verbatim
      // Aircall keys. Any value nobody has seen before appears here under
      // its own name — that is what the JSONB map is for.
      missed_calls_by_reason: l.missed_calls_by_reason,

      // Peter's two voicemail numbers, per line. voicemail_rate is the share
      // of MEASURED misses that left a message — every reason, not just the
      // charged ones: a caller who reached the lunchtime phone tree and left
      // a message still left a message. null (not 0) when there is nothing
      // to divide, same rule as every other rate in this tool.
      //
      // No recording, no transcript, no link — a voicemail is a tenant's own
      // recorded voice and SPEC.md's "Explicitly Out of Scope" is absolute.
      // Whether voicemails were RETURNED is deliberately not here and must
      // not be added: COMMITTED-NOT-BUILT.md item 1, blocked on Asimov
      // because it requires storing callers' phone numbers.
      voicemails_left: l.voicemails_left,
      voicemail_rate: l.measured_missed_calls > 0 ? l.voicemails_left / l.measured_missed_calls : null,
      measured_missed_calls: l.measured_missed_calls,
    }))
    .sort((a, b) => b.missed_calls - a.missed_calls);

  // Range-level voicemail rate, computed once at the end from the raw sums
  // rather than by averaging the per-line rates — a line with 1 miss and a
  // line with 100 must not carry equal weight (SPEC.md Design Decision 2's
  // "never store a number pre-divided," applied one level up, the same rule
  // lib/metrics.js's accumulator shape enforces for people).
  lineMissTotals.voicemail_rate = lineMissTotals.measured_missed_calls > 0
    ? lineMissTotals.voicemails_left / lineMissTotals.measured_missed_calls
    : null;
  // The reconciliation TARS should test directly: the four buckets account
  // for every miss in the range, with nothing double-counted and nothing
  // dropped. Returned rather than asserted so a mismatch is visible on the
  // page instead of 500-ing a dashboard over an arithmetic disagreement —
  // but it should never be false.
  lineMissTotals.buckets_reconcile =
    lineMissTotals.charged_to_person_missed_calls
    + lineMissTotals.charged_to_nobody_reason_missed_calls
    + lineMissTotals.charged_to_nobody_line_missed_calls
    + lineMissTotals.unmeasured_missed_calls
    === lineMissTotals.missed_calls;

  // ─── Pod tables ─────────────────────────────────────────────────────────
  const pods = { Solimar: [], Faria: [], Other: [] };
  for (const [email, acc] of accumulators.entries()) {
    const user = usersByEmail.get(email);
    // No known Rincon user for this email — not shown on this dashboard,
    // per Design Decision 1. Note this can no longer silently swallow a
    // shared-line miss: isAttributableLineMissRow() refuses to attribute to
    // an email with no `users` match precisely so those misses stay counted
    // in the unattributed half of Shared Line Misses instead of landing on a
    // row nothing renders.
    if (!user) continue;
    const row = { name: user.name, email, ...computePersonMetrics(acc) };
    if (user.pod && pods[user.pod]) {
      pods[user.pod].push(row);
    } else if (!user.pod && user.is_active) {
      // No pod (Business Development / Operations / Executive), but has
      // real call activity in this range — the `Other` bucket. Unlike
      // Solimar/Faria there's no fixed roster of "everyone not in a pod,"
      // so — deliberately — no zero-row placeholder is invented here for
      // someone with no activity; only real activity earns a spot in `Other`.
      pods.Other.push(row);
    }
  }
  // Staff with a pod but zero rows in range still show up, with all-zero
  // numbers, rather than silently vanishing from their pod's table —
  // someone with genuinely no calls in a range is a real, useful answer,
  // not the same as "we have no data on this person at all." (Only applies
  // to Solimar/Faria — see the `Other` comment above for why this same
  // placeholder treatment doesn't extend there.)
  //
  // *** DO NOT ADD AN is_active FILTER TO THIS LOOP. ***
  // Peter decided on 2026-09-10 that nobody is ever dropped from a pod
  // table automatically. Removing a person from this scorecard is always a
  // deliberate, per-person decision he makes, never a side effect of a flag
  // flipping in the `users` table. Adding `if (!user.is_active) continue;`
  // here would look like an obvious tidy-up and would quietly delete a
  // named employee from a report reviewed in a weekly staff meeting — with
  // no record that the row ever existed. It has been considered and
  // rejected; leave it out. (The `Other` bucket above is a different case
  // and does check is_active: it has no fixed roster, so without that check
  // any departed staff member's leftover activity would resurrect them into
  // a table they were never listed in.)
  for (const user of users || []) {
    if (accumulators.has(user.email.toLowerCase())) continue;
    if (!pods[user.pod]) continue;
    // Metric values come from an EMPTY accumulator rather than a
    // hand-written all-zero literal, so this placeholder row can never
    // drift out of step with the real rows beside it when a column is added
    // or a definition changes. Rates and averages are null (nothing to
    // divide, and "no inbound calls" is not "answered none of them");
    // counts are 0, which is itself the useful fact.
    pods[user.pod].push({ name: user.name, email: user.email.toLowerCase(), ...emptyPersonMetrics() });
  }
  pods.Solimar.sort((a, b) => a.name.localeCompare(b.name));
  pods.Faria.sort((a, b) => a.name.localeCompare(b.name));
  pods.Other.sort((a, b) => a.name.localeCompare(b.name));

  // ─── HubSpot native-line stats (call_stats_hubspot_native_calls) ───────
  // A second, separate phone system (SPEC.md Design Decision 5's citation;
  // migration 20260908000000_call_stats_hubspot_native.sql) — its own
  // human-maintained allowlist table, its own sync, its own aggregation.
  // Never blended into the pod tables' Aircall numbers above; Peter was
  // explicit this stays its own line. Same [from, to] range already used
  // above.
  //
  // Deliberately NOT allowed to fail the whole response the way the
  // call_stats/call_stats_line_misses fetches above do (Judge/Sentinel
  // review, 2026-09-08): those two existing tables are already live in
  // Peter's database, so a fetch error there is a genuine emergency worth
  // a hard 500. These two HubSpot tables are brand new and Peter applies
  // migrations himself, by hand, in Supabase's SQL editor — there's a real
  // window where this code is deployed before that migration has been run.
  // Without this isolation, that window (or any other HubSpot-side hiccup)
  // would 500 the entire Call Stats page, including the Aircall numbers
  // that have nothing to do with this feature and were working fine.
  // Mirrors the isolation the nightly sync route already does correctly
  // for this same pair of tables — a HubSpot-side failure here is recorded
  // and surfaced, never allowed to take the rest of the page down with it.
  let hubspotNative = [];
  let hubspotMostRecentSync = null;
  let hubspotNativeError = null;
  try {
    const hubspotNumberRows = await fetchAllRows((rangeFrom, rangeTo) => supabase
      .from('call_stats_hubspot_native_numbers')
      .select('phone_number, staff_email, notes')
      .range(rangeFrom, rangeTo));

    const hubspotCallRows = await fetchAllRows((rangeFrom, rangeTo) => supabase
      .from('call_stats_hubspot_native_calls')
      .select('phone_number, call_date, direction, total_calls, answered_calls, missed_calls, total_talk_seconds, synced_at')
      .gte('call_date', from)
      .lte('call_date', to)
      .range(rangeFrom, rangeTo));

    // Same "missed means something different per direction" reasoning as
    // the pod tables above (SPEC.md Design Decision 2): inbound_missed_calls
    // is a real responsiveness signal, outbound_not_answered isn't — kept as
    // two separate fields here too, not blended into one "Missed" number.
    // There is no avg-speed-to-answer equivalent for this table — the schema
    // deliberately has no total_ring_seconds column (HubSpot doesn't expose
    // the separate started/answered timestamps Aircall does — see the
    // migration header) — so it's simply not part of this section at all,
    // not shown as a permanent "—".
    const hubspotAggByNumber = new Map();
    for (const r of hubspotCallRows) {
      if (r.synced_at && (!hubspotMostRecentSync || r.synced_at > hubspotMostRecentSync)) hubspotMostRecentSync = r.synced_at;
      let agg = hubspotAggByNumber.get(r.phone_number);
      if (!agg) {
        agg = { total_calls: 0, answered_calls: 0, total_talk_seconds: 0, inbound_missed_calls: 0, outbound_not_answered: 0 };
        hubspotAggByNumber.set(r.phone_number, agg);
      }
      agg.total_calls += r.total_calls;
      agg.answered_calls += r.answered_calls;
      agg.total_talk_seconds += r.total_talk_seconds;
      if (r.direction === 'inbound') agg.inbound_missed_calls += r.missed_calls;
      else if (r.direction === 'outbound') agg.outbound_not_answered += r.missed_calls;
    }

    // Every row in call_stats_hubspot_native_numbers is shown, including a
    // tracked number with zero calls in the selected range — a real, useful
    // answer ("this line had no activity"), not the same as "we don't track
    // this line" — same "don't silently vanish a tracked person" reasoning
    // the pod tables above already use for Solimar/Faria staff with no
    // Aircall activity in range. Name is resolved from the SAME usersByEmail
    // map already built above for the Aircall pod tables (Design Decision 1's
    // "look it up live" convention, reused here rather than a second users
    // fetch) — falls back to the raw email if staff_email doesn't match any
    // known users row (e.g. a typo in the hand-maintained allowlist), so a
    // mismatch shows up as a visibly odd name rather than silently vanishing.
    hubspotNative = (hubspotNumberRows || []).map(n => {
      const agg = hubspotAggByNumber.get(n.phone_number) || { total_calls: 0, answered_calls: 0, total_talk_seconds: 0, inbound_missed_calls: 0, outbound_not_answered: 0 };
      const user = usersByEmail.get(n.staff_email.toLowerCase());
      return {
        phone_number: n.phone_number,
        staff_email: n.staff_email,
        name: user ? user.name : n.staff_email,
        notes: n.notes || null,
        total_calls: agg.total_calls,
        avg_length_seconds: agg.answered_calls > 0 ? Math.round(agg.total_talk_seconds / agg.answered_calls) : null,
        inbound_missed_calls: agg.inbound_missed_calls,
        outbound_not_answered: agg.outbound_not_answered,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    console.error('call-stats stats: HubSpot native-line section failed (Aircall data above is unaffected):', error.message);
    hubspotNative = [];
    hubspotNativeError = error.message;
  }

  return res.json({
    from, to, synced_at: mostRecentSync, pods,
    line_misses: lineMisses,
    // Range-wide totals for the Shared Line Misses section. Returned rather
    // than left for the dashboard to re-add, so there is exactly one place
    // the split is computed: attributed_missed_calls +
    // unattributed_missed_calls === missed_calls, and
    // attributed_answered_calls + unattributed_answered_calls ===
    // answered_calls, always, by construction of the single pass above. The
    // unattributed figure is the one that must stay next to the per-person
    // percentages — nobody should be able to read someone's Answer Rate
    // without also seeing how many misses landed on no one at all.
    //
    // The answered totals are what let the NUMERATOR be reconciled the same
    // way: summing inbound_answered_calls_shared_line across every person
    // in `pods` must equal attributed_answered_calls here, exactly, with
    // nothing counted twice. Same identity the misses already satisfy.
    line_miss_totals: lineMissTotals,
    // Each entry means a real miss is going uncharged to the person who
    // should own it. Empty array in the healthy case.
    line_miss_attribution_alarms: Array.from(attributionAlarms.values()),
    hubspot_native: hubspotNative, hubspot_native_synced_at: hubspotMostRecentSync,
    ...(hubspotNativeError ? { hubspot_native_error: hubspotNativeError } : {}),
  });
});

// ─── /api/call-stats/users — admin-only role management ─────────────────
// Mirrors the other three tools' admin endpoints exactly, scoped to
// tool='call_stats'. Both role values (admin, pod_lead) are already live
// in team_member_tool_roles_role_check — no schema change needed to add
// either one for this tool (SPEC.md "Access / Roles in the Hub").
const VALID_ROLES = ['admin', 'pod_lead'];
// quickturnmaintenance.com added 2026-09-09 — Peter confirmed it's a sister
// company he owns (not an unaffiliated outside vendor), same trust level as
// rinconmanagement.com for Hub access purposes.
const ALLOWED_DOMAINS = ['rinconmanagement.com', 'quickturnmaintenance.com'];

router.get('/api/call-stats/users', requireCallStatsRole('admin'), async (req, res) => {
  const { data, error } = await supabase
    .from('team_member_tool_roles')
    .select('role, granted_by, granted_at, team_members ( email, full_name )')
    .eq('tool', 'call_stats')
    .order('granted_at');
  if (error) return res.status(500).json({ error: error.message });
  const rows = (data || [])
    .filter(r => r.team_members)
    .map(r => ({
      email: r.team_members.email,
      name: r.team_members.full_name || null,
      role: r.role,
      assigned_by: r.granted_by,
      granted_at: r.granted_at,
    }));
  return res.json(rows);
});

router.post('/api/call-stats/users', requireCallStatsRole('admin'), async (req, res) => {
  const { email, role } = req.body;
  if (!email || !role) return res.status(400).json({ error: 'email and role are required.' });

  const normalizedEmail = String(email).toLowerCase().trim();
  if (!ALLOWED_DOMAINS.some(d => normalizedEmail.endsWith('@' + d))) {
    return res.status(400).json({ error: 'Only ' + ALLOWED_DOMAINS.map(d => '@' + d).join(' or ') + ' accounts allowed.' });
  }
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });

  const { data: member, error: memberErr } = await supabase
    .from('team_members')
    .select('id')
    .eq('email', normalizedEmail)
    .maybeSingle();
  if (memberErr) return res.status(500).json({ error: memberErr.message });
  if (!member) {
    return res.status(400).json({
      error: `${normalizedEmail} hasn't logged into the Rincon Hub yet. Ask them to log in once (same email + password as every other hub tool), then try granting access again.`,
    });
  }

  const { error: upsertErr } = await supabase
    .from('team_member_tool_roles')
    .upsert({
      team_member_id: member.id,
      tool: 'call_stats',
      role,
      granted_by: req.user.email,
      granted_at: new Date().toISOString(),
    }, { onConflict: 'team_member_id,tool' });
  if (upsertErr) return res.status(500).json({ error: upsertErr.message });

  await supabase.from('audit_log').insert({
    action: 'team_member.role_changed',
    entity_type: 'team_member',
    entity_id: member.id,
    details: { tool: 'call_stats', old_role: null, new_role: role, changed_by: req.user.email },
  });

  return res.json({ success: true });
});

router.patch('/api/call-stats/users/:email', requireCallStatsRole('admin'), async (req, res) => {
  const { role } = req.body;
  const targetEmail = String(req.params.email || '').toLowerCase().trim();
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });

  const { data: member, error: memberErr } = await supabase
    .from('team_members')
    .select('id')
    .eq('email', targetEmail)
    .maybeSingle();
  if (memberErr) return res.status(500).json({ error: memberErr.message });
  if (!member) return res.status(404).json({ error: `${targetEmail} is not a Rincon Hub team member.` });

  const { data: existing } = await supabase
    .from('team_member_tool_roles')
    .select('role')
    .eq('team_member_id', member.id)
    .eq('tool', 'call_stats')
    .maybeSingle();
  const oldRole = existing ? existing.role : null;

  const { error: upsertErr } = await supabase
    .from('team_member_tool_roles')
    .upsert({
      team_member_id: member.id,
      tool: 'call_stats',
      role,
      granted_by: req.user.email,
      granted_at: new Date().toISOString(),
    }, { onConflict: 'team_member_id,tool' });
  if (upsertErr) return res.status(500).json({ error: upsertErr.message });

  await supabase.from('audit_log').insert({
    action: 'team_member.role_changed',
    entity_type: 'team_member',
    entity_id: member.id,
    details: { tool: 'call_stats', old_role: oldRole, new_role: role, changed_by: req.user.email },
  });

  return res.json({ success: true });
});

router.delete('/api/call-stats/users/:email', requireCallStatsRole('admin'), async (req, res) => {
  const targetEmail = String(req.params.email || '').toLowerCase().trim();
  if (targetEmail === req.user.email.toLowerCase()) {
    return res.status(400).json({ error: 'You cannot remove your own access.' });
  }

  const { data: member, error: memberErr } = await supabase
    .from('team_members')
    .select('id')
    .eq('email', targetEmail)
    .maybeSingle();
  if (memberErr) return res.status(500).json({ error: memberErr.message });
  if (!member) return res.status(404).json({ error: `${targetEmail} is not a Rincon Hub team member.` });

  const { data: existing } = await supabase
    .from('team_member_tool_roles')
    .select('role')
    .eq('team_member_id', member.id)
    .eq('tool', 'call_stats')
    .maybeSingle();

  const { error } = await supabase
    .from('team_member_tool_roles')
    .delete()
    .eq('team_member_id', member.id)
    .eq('tool', 'call_stats');
  if (error) return res.status(500).json({ error: error.message });

  await supabase.from('audit_log').insert({
    action: 'team_member.role_changed',
    entity_type: 'team_member',
    entity_id: member.id,
    details: { tool: 'call_stats', old_role: existing ? existing.role : null, new_role: null, changed_by: req.user.email },
  });

  return res.json({ success: true });
});

// ─── internalRouter: no login required — own shared-secret check ────────
const internalRouter = express.Router();

function checkCronSecret(req, res) {
  const secret = req.headers['x-cron-secret'];
  if (!secret || secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/**
 * POST /api/call-stats/internal/sync?date=YYYY-MM-DD
 * The nightly job. GET-only against Aircall (see aircall-connector.js).
 * Defaults to "yesterday" in Rincon's own Pacific business day — the spec's
 * "pulls the previous day's calls" — but accepts an explicit ?date= for a
 * manual backfill/rerun of a specific day, same escape hatch
 * maintenance-history's ?since_days= gives its own nightly job.
 *
 * ============================================================
 * !!! THE ?date= RE-RUN HAZARD — READ BEFORE RE-RUNNING AN OLD DAY !!!
 * ============================================================
 * As of 2026-09-10 this route also snapshots WHO each phone line rang onto
 * every call_stats_line_misses row it writes (sole_user_email /
 * ring_user_count). That snapshot is the whole reason a line changing hands
 * in Aircall can never retroactively rewrite an earlier day's numbers.
 *
 * Re-running an old day through ?date= reads the CURRENT ring membership
 * and stamps it onto that day's misses, overwriting the snapshot taken on
 * the night it happened. That is precisely the history rewrite the snapshot
 * design exists to prevent — now available as a one-line manual command.
 *
 * Concretely: Dio Lopes is the sole user of "Property Manager - Solimar"
 * (35 misses in four weeks). If that line is ever reassigned and someone
 * then re-runs ?date=2026-08-20 to fix an unrelated problem, those August
 * misses silently move off Dio and onto whoever holds the line that day —
 * changing a performance number about a named employee that was already
 * read out in a weekly staff meeting.
 *
 * This is ACCEPTABLE because it is an explicit, rare operator action rather
 * than something that happens on its own — but it must be a known hazard,
 * not a surprise. Before re-running any day older than the last line
 * reassignment in Aircall, confirm no line has changed hands since that
 * day. If one has, the attribution for the re-run day will be wrong and
 * cannot be recovered — Aircall's detail endpoint reports CURRENT
 * membership only, with no history (redefinition spec Open Item 12).
 * ============================================================
 *
 * ============================================================
 * ?date= HAS A SECOND EFFECT AS OF 2026-09-10, AND IT IS A GOOD ONE
 * ============================================================
 * The same command now also fills in that day's miss reasons and voicemail
 * counts. Unlike the ring mapping, those come off the re-fetched CALL
 * OBJECTS themselves — immutable historical facts that cannot drift — so a
 * re-run captures them CORRECTLY for that day. Re-running an old day is
 * therefore the sanctioned way to measure a single past day whose three
 * reason columns are still NULL, and it is the mechanism the six-month
 * backfill uses.
 *
 * *** ONE COMMAND, ONE GOOD EFFECT AND ONE SHARP ONE. *** Both happen
 * together and neither can be requested without the other: you cannot fill
 * in a day's miss reasons without also re-stamping today's line mapping onto
 * that day's sole_user_email. Before re-running any day older than the last
 * line reassignment in Aircall, confirm no line has changed hands since —
 * exactly as the hazard above says. Peter's confirmation that none has since
 * 2026-03-10 is what makes the backfill safe over that window and nothing
 * older.
 * ============================================================
 */
internalRouter.post('/api/call-stats/internal/sync', async (req, res) => {
  if (!checkCronSecret(req, res)) return;
  const ts = new Date().toISOString();

  const dateStr = req.query.date || yesterdayPacificDateStr();
  if (!isValidCalendarDate(dateStr)) {
    return res.status(400).json({ error: '?date must be a valid YYYY-MM-DD date.' });
  }
  const { from, to } = pacificDayBoundsUnix(dateStr);

  console.log(`[${ts}] call-stats sync: pulling Aircall calls for Pacific day ${dateStr} (unix ${from}-${to})...`);

  let calls;
  try {
    calls = await aircall.listCallsForDateRange(from, to);
  } catch (err) {
    console.error(`[${ts}] call-stats sync: Aircall fetch failed:`, err.message);
    return res.status(502).json({ error: 'Failed to pull calls from Aircall.', detail: err.message });
  }

  // Every Rincon staff email, portfolio-wide, no filter — this is the
  // match target every call.user.email gets checked against (Design
  // Decision 1). Not filtered to pod IS NOT NULL: a call from a real
  // Rincon employee outside the four pod roles (e.g. the CEO) still
  // belongs to a real person and gets written to call_stats — it simply
  // won't render on this dashboard's two pod tables, same as the stats
  // route above.
  let userRows;
  try {
    userRows = await fetchAllRows((rangeFrom, rangeTo) => supabase
      .from('users')
      .select('id, email')
      .order('id', { ascending: true })
      .range(rangeFrom, rangeTo));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
  const usersByEmail = new Map((userRows || []).map(u => [u.email.toLowerCase(), u]));

  const { rows, summary } = buildDailyAggregates(calls, usersByEmail);

  let upserted = 0;
  const upsertErrors = [];
  for (const row of rows) {
    const { error } = await supabase
      .from('call_stats')
      .upsert({ ...row, synced_at: new Date().toISOString() }, { onConflict: 'aircall_user_id,call_date,direction' });
    if (error) {
      upsertErrors.push({ key: `${row.aircall_user_id}|${row.call_date}|${row.direction}`, error: error.message });
    } else {
      upserted++;
    }
  }

  // ─── Line-miss half of the sync ─────────────────────────────────────────
  // Same `calls` array, second aggregation pass — the shared-line-miss
  // rows buildDailyAggregates() has no grain to represent (its own
  // calls_unattributed_no_user count above). No second Aircall fetch for
  // the CALLS; the one extra fetch below is for the line-to-user mapping,
  // which is per-line, not per-call (~16 GETs).
  //
  // *** FAIL LOUD, NEVER WRITE A NULL ATTRIBUTION ***
  // (migration 20260910010000's NOTES FOR Q #1, and Design Decision 10.)
  // A NULL sole_user_email on a stored row means "this line had no sole
  // user that day." It must NEVER also mean "we could not find out." So if
  // this mapping fetch fails for any reason — Aircall down, a 429,
  // credentials missing, the detail endpoint changing shape — the line-miss
  // half is SKIPPED ENTIRELY and the day stays re-runnable. It does not
  // fall back to writing rows with nulls: that failure would be permanent,
  // silent and self-concealing, understating real people's misses forever
  // with nothing on the row to say otherwise.
  //
  // The failure is isolated the same way the HubSpot half below is: the
  // Aircall call fetch and every call_stats upsert above have already
  // completed and are left alone. The difference is the HTTP status — this
  // route returns 502 when the line-miss half is skipped, deliberately,
  // because a nightly job that quietly returns 200 after skipping the
  // attribution is exactly the silent failure this design exists to
  // prevent. Re-running the day is safe and is the fix: every write in this
  // route is an idempotent upsert.
  // The AGGREGATION runs inside this same try, not after it. Its own guard
  // rejects an unusable mapping (a non-Map, or an empty one) by throwing,
  // and that throw has to arrive at the skip-and-502 path below like any
  // other mapping failure. Left outside, it would escape an async Express
  // handler that has no outer catch — the request hangs, no status is ever
  // sent, and the operator learns nothing except that the nightly job never
  // came back. Same outcome either way, one code path: nothing written, day
  // re-runnable, loud.
  let lineMissBuild = null;
  let lineMissMappingError = null;
  try {
    const lineRingMembership = await aircall.fetchLineRingMembership();
    lineMissBuild = buildLineMissAggregates(calls, lineRingMembership);
  } catch (err) {
    lineMissMappingError = err.message;
    console.error(`[${ts}] call-stats sync: LINE-MISS HALF SKIPPED — Aircall line-to-user ring membership is unusable: ${err.message}`);
    console.error(`[${ts}] call-stats sync: no call_stats_line_misses rows were written for ${dateStr}. The call_stats rows above are unaffected. Re-run this day once Aircall is reachable: POST /api/call-stats/internal/sync?date=${dateStr}`);
  }

  let lineMissResult;
  if (lineMissMappingError) {
    lineMissResult = {
      skipped: true,
      error: `Aircall line-to-user ring mapping unusable — line-miss rows deliberately NOT written so this day stays re-runnable. ${lineMissMappingError}`,
      rows_upserted: 0,
    };
  } else {
    const { rows: lineMissRows, summary: lineMissSummary } = lineMissBuild;

    // Data-quality alarms, logged at error level rather than folded quietly
    // into the result object. Both mean a real, chargeable miss is going
    // uncharged to the person who should own it — the exact failure mode
    // this whole change exists to fix, so it must not be discoverable only
    // by reading a JSON blob.
    if (lineMissSummary.rows_sole_user_email_unresolved > 0) {
      console.error(`[${ts}] call-stats sync: DATA QUALITY ALARM — ${lineMissSummary.rows_sole_user_email_unresolved} row(s) have ring_user_count = 1 but no resolvable email, so those misses are going UNATTRIBUTED. Lines:`, JSON.stringify(lineMissSummary.unresolved_sole_user_lines));
    }
    if (lineMissSummary.rows_line_missing_from_mapping > 0) {
      console.error(`[${ts}] call-stats sync: DATA QUALITY ALARM — ${lineMissSummary.rows_line_missing_from_mapping} row(s) are on a line Aircall's own line list doesn't return (deleted line?). Both attribution columns left NULL and those misses stay unattributed. Lines:`, JSON.stringify(lineMissSummary.lines_missing_from_mapping));
    }
    // A miss reason nobody has seen before. NOT an error and NOT a reason to
    // fail the sync — the value has already been written into
    // missed_calls_by_reason verbatim, unbucketed and unlost, which is the
    // entire purpose of a JSONB map with no key CHECK (migration
    // 20260910020000 NOTES FOR Q #6). It is logged at error level anyway so
    // it surfaces the next morning instead of sitting quietly in a blob for
    // a month: only `agents_did_not_answer` charges a person, so a new value
    // is charged to nobody until Peter decides otherwise, and somebody has
    // to be told that a decision is now available to make.
    //
    // This fires more readily than it looks. The build brief listed three
    // reasons; a live check of 822 real calls on 2026-09-10 found six. Three
    // of those six — out_of_opening_hours, abandoned_in_ivr,
    // abandoned_in_classic — are in KNOWN_MISS_REASONS only because that
    // check was run first.
    if (lineMissSummary.unrecognized_miss_reasons.length > 0) {
      console.error(`[${ts}] call-stats sync: NEW AIRCALL MISS REASON — ${lineMissSummary.unrecognized_miss_reasons.length} value(s) not in KNOWN_MISS_REASONS. They ARE stored, verbatim, in missed_calls_by_reason and nothing is lost; they are charged to nobody until Peter decides otherwise. Review and add to KNOWN_MISS_REASONS in lib/sync.js once seen:`, JSON.stringify(lineMissSummary.unrecognized_miss_reasons));
    }

    let lineMissesUpserted = 0;
    const lineMissUpsertErrors = [];
    for (const row of lineMissRows) {
      const { error } = await supabase
        .from('call_stats_line_misses')
        .upsert({ ...row, synced_at: new Date().toISOString() }, { onConflict: 'aircall_number_id,call_date,direction' });
      if (error) {
        lineMissUpsertErrors.push({ key: `${row.aircall_number_id}|${row.call_date}|${row.direction}`, error: error.message });
      } else {
        lineMissesUpserted++;
      }
    }

    lineMissResult = {
      ...lineMissSummary,
      rows_upserted: lineMissesUpserted,
      upsert_errors: lineMissUpsertErrors,
    };
  }

  const result = {
    date: dateStr,
    ...summary,
    rows_upserted: upserted,
    upsert_errors: upsertErrors,
    line_misses: lineMissResult,
  };
  console.log(`[${ts}] call-stats sync done:`, JSON.stringify(result));

  // ─── HubSpot native-line sync — a SECOND, SEPARATE phone system ────────
  // (SPEC.md Design Decision 5's citation, migration
  // 20260908000000_call_stats_hubspot_native.sql). Genuinely independent of
  // everything above: its own connector (lib/hubspot-connector.js), its own
  // aggregation function (buildHubspotDailyAggregates), its own tables. Not
  // blended into call_stats/call_stats_line_misses or their `result` above
  // in any way — Peter was explicit this stays its own separate line.
  //
  // Wrapped in its own try/catch, on purpose: everything above this point
  // has already run and `result` is already final. The single most likely
  // failure here is HUBSPOT_PRIVATE_APP_TOKEN not being set yet (Peter
  // still needs to generate one — see .env.example) — that must never turn
  // a working Aircall sync into a failed nightly job. Per this build's task
  // instructions: a HubSpot-side failure is recorded and returned, never
  // thrown past this point.
  let hubspotResult;
  try {
    const trackedNumberRows = await fetchAllRows((rangeFrom, rangeTo) => supabase
      .from('call_stats_hubspot_native_numbers')
      .select('phone_number')
      .range(rangeFrom, rangeTo));
    const trackedPhoneNumbers = (trackedNumberRows || []).map(r => r.phone_number);

    if (trackedPhoneNumbers.length === 0) {
      // Real, expected state until Peter (or whoever maintains this
      // allowlist by hand) adds a first row — not an error. See the
      // migration's own header: a number is tracked only if a row exists.
      hubspotResult = { skipped: true, reason: 'No rows in call_stats_hubspot_native_numbers yet — nothing to track.' };
    } else {
      // Same Pacific-day bounds already computed above for Aircall,
      // expressed as ISO-8601 UTC strings — HubSpot's hs_createdate filter
      // takes ISO strings, not unix seconds (see hubspot-connector.js).
      const fromIso = new Date(from * 1000).toISOString();
      const toIso = new Date(to * 1000).toISOString();

      const hubspotCalls = await hubspot.listVoipCallsForNumbers(trackedPhoneNumbers, fromIso, toIso);
      const trackedPhoneNumberSet = new Set(trackedPhoneNumbers);
      const { rows: hubspotRows, summary: hubspotSummary } = buildHubspotDailyAggregates(hubspotCalls, trackedPhoneNumberSet);

      let hubspotUpserted = 0;
      const hubspotUpsertErrors = [];
      for (const row of hubspotRows) {
        const { error } = await supabase
          .from('call_stats_hubspot_native_calls')
          .upsert({ ...row, synced_at: new Date().toISOString() }, { onConflict: 'phone_number,call_date,direction' });
        if (error) {
          hubspotUpsertErrors.push({ key: `${row.phone_number}|${row.call_date}|${row.direction}`, error: error.message });
        } else {
          hubspotUpserted++;
        }
      }

      hubspotResult = {
        ...hubspotSummary,
        rows_upserted: hubspotUpserted,
        upsert_errors: hubspotUpsertErrors,
      };
    }
  } catch (err) {
    console.error(`[${ts}] call-stats sync: HubSpot native-line sync failed (Aircall sync above already completed and is unaffected):`, err.message);
    hubspotResult = { error: err.message };
  }
  result.hubspot_native = hubspotResult;
  console.log(`[${ts}] call-stats sync: HubSpot native-line result:`, JSON.stringify(hubspotResult));

  // 502 ONLY when the line-miss half was skipped for a missing ring-mapping
  // — see the fail-loud block above. Everything else about this run
  // succeeded and is already committed (call_stats rows, and the HubSpot
  // half if it ran), and the full result object is returned either way so
  // whoever reads the failure can see exactly what did land. The non-2xx is
  // the point: it is what stops a nightly job from quietly reporting
  // success on a night when nobody's misses got attributed. Re-running the
  // day fixes it and is always safe — every write here is an upsert.
  if (lineMissMappingError) {
    return res.status(502).json(result);
  }
  return res.json(result);
});

module.exports = { router, internalRouter };
