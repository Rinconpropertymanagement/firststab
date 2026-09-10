#!/usr/bin/env node
/**
 * backfill-six-months.js
 * Re-fetches Aircall calls day by day and fills in the Call Stats history
 * that was never collected. One pass, one set of aggregation functions, four
 * things populated together:
 *
 *   - call_stats rows                         (per person, day, direction)
 *   - call_stats_line_misses rows             (per line, day, direction)
 *   - sole_user_email / ring_user_count       on every line-miss row
 *   - missed_calls_agents_did_not_answer,
 *     missed_calls_by_reason, voicemails_left on every line-miss row
 *
 * DRY RUN BY DEFAULT. It writes nothing unless --apply is passed. Run it
 * without --apply first, read the report, and only then decide.
 *
 * ============================================================
 * WHY THIS EXISTS — four separate pieces of work are waiting on it
 * ============================================================
 * call_stats_line_misses holds EIGHT DAYS: 2026-08-29, then 09-03..09-09.
 * 08-31, 09-01 and 09-02 are missing outright. TARS measured Aircall's real
 * total for 2026-08-29..09-09 as 177 misses against 118 stored — every figure
 * reasoned from that table so far is roughly two-thirds of the truth. The
 * trend view would launch nearly empty. The answer-rate fix's numerator
 * correction moves no number until this runs. And every row currently in the
 * table is UNMEASURED for miss reason, so under the 2026-09-10 rules none of
 * it counts toward anybody at all.
 *
 * ============================================================
 * *** THE FLOOR IS 2026-03-10. THIS IS NOT A TUNABLE. ***
 * ============================================================
 * Backfilling attribution means stamping TODAY's line-to-user mapping onto
 * PAST rows — the one thing the snapshot design in migration 20260910010000
 * exists to prevent. It is safe over exactly one window and for exactly one
 * reason: *** Peter confirmed on 2026-09-10 that no Aircall line changed
 * hands in the last six months. *** If no line changed hands, today's mapping
 * IS the historical mapping over that window and applying it retroactively
 * rewrites nothing.
 *
 * His confirmation covers six months and no further, and Aircall exposes no
 * history of a line's ring membership (redefinition spec Open Item 12), so
 * there is no way to check any earlier date from this side. This script
 * REFUSES to run before 2026-03-10 rather than warning about it. A quietly
 * wrong attribution on a named employee's scorecard is worse than an
 * honestly missing one — that principle is the entire reason the
 * answer-rate work exists.
 *
 * ============================================================
 * *** IT MUST NOT TOUCH synced_at, AND HERE IS EXACTLY WHAT THAT MEANS ***
 * ============================================================
 * synced_at means "last confirmed by the nightly sync." A backfill is not a
 * sync, so `synced_at` is omitted from every payload this script builds.
 * Consequences, both real and both stated rather than assumed:
 *
 *   - EXISTING ROW: PostgREST's merge-duplicates upsert only SETs the
 *     columns present in the payload, so an omitted synced_at keeps whatever
 *     value the nightly sync last wrote. Correct — that is the point.
 *   - BRAND-NEW ROW: synced_at is `NOT NULL DEFAULT NOW()` on both tables
 *     (20260819010000 and 20260904000000). A new row CANNOT be inserted with
 *     it null, so the column default applies and the row gets this run's
 *     timestamp. There is no way to avoid that without a schema change, and
 *     the vast majority of what this backfill writes is new rows. It is
 *     called out in the report rather than papered over.
 *
 * `updated_at` moves on its own via trg_call_stats_line_misses_updated_at and
 * its call_stats counterpart. That is correct and is the only other trace
 * this script leaves on a row.
 *
 * ============================================================
 * WHAT IT STAMPS ON A HISTORICAL ROW, AND WHAT THAT IS WORTH
 * ============================================================
 * Two different kinds of fact end up on each backfilled row, and they do not
 * deserve equal confidence:
 *
 *   IMMUTABLE HISTORICAL FACT — everything read off the call objects
 *   themselves: total_calls, missed_calls, answered/talk/ring seconds,
 *   missed_calls_by_reason, missed_calls_agents_did_not_answer,
 *   voicemails_left. Aircall's record of a call that happened in April does
 *   not change. These are as good as a row the nightly sync wrote that night.
 *
 *   TODAY'S ANSWER, APPLIED RETROACTIVELY — sole_user_email and
 *   ring_user_count. fetchLineRingMembership() returns the membership AS OF
 *   THE MOMENT THIS SCRIPT RUNS. There is no historical version to ask for.
 *   Every backfilled row is stamped with the 2026-09-10-era mapping, and
 *   nothing on the row records that it was stamped rather than snapshotted.
 *   Peter's no-line-changed-hands confirmation is the only thing making that
 *   equivalent to the truth, which is precisely why the floor exists and why
 *   migration 20260910010000 is the provenance record for it.
 *
 * ============================================================
 * RESUMABLE, RE-RUNNABLE, AND SAFE TO INTERRUPT
 * ============================================================
 * Every write is an idempotent upsert on the tables' existing keys, so a
 * re-run overwrites rather than duplicates. Completed days are recorded in a
 * state file after each day's writes land, so an interrupted run (or one
 * killed by a rate limit it could not ride out) resumes where it stopped
 * instead of re-fetching six months. --restart clears the state.
 *
 * Aircall rate-limits aggressively — 429s were hit twice on 2026-09-10 doing
 * 30-day pulls. Every request is throttled and every 429 is backed off and
 * retried, honouring Retry-After when Aircall sends one. This script does NOT
 * use lib/aircall-connector.js's listCallsForDateRange() for the calls,
 * because that helper throws on a 429 with no retry by design (correct for a
 * nightly job that can just re-run; wrong for a two-hundred-day pull that
 * would lose an hour of work). It DOES use the connector for the line
 * mapping, unchanged.
 *
 * Usage:
 *   node backfill-six-months.js --help
 *   node backfill-six-months.js --from=2026-03-10 --to=2026-09-09
 *   node backfill-six-months.js --from=2026-03-10 --to=2026-09-09 --apply
 */

const path = require('path');
const fs = require('fs');

const envPath = path.join(__dirname, '..', '..', '..', '.env');
if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });

const { createClient } = require('@supabase/supabase-js');
const aircall = require('./lib/aircall-connector');
const { buildDailyAggregates, buildLineMissAggregates } = require('./lib/sync');
const { pacificDayBoundsUnix, yesterdayPacificDateStr } = require('./lib/timezone');

// ── Constants that are decisions, not settings ────────────────────────────

// Peter's confirmation reaches back six months from 2026-09-10 and no
// further. Not a flag. See the header.
const BACKFILL_FLOOR = '2026-03-10';

// Aircall's rate limit is the binding constraint on this whole job, not
// Supabase. ~1.3s between call pages was chosen against a real 429 (twice on
// 2026-09-10 during 30-day pulls) rather than from documentation.
const PAGE_DELAY_MS = 1300;
const DAY_DELAY_MS = 500;
const MAX_429_RETRIES = 8;

const STATE_DIR = path.join(__dirname, '.backfill-state');

// ── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { apply: false, restart: false, help: false, from: null, to: null, state: null };
  for (const a of argv.slice(2)) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--apply') args.apply = true;
    else if (a === '--restart') args.restart = true;
    else if (a.startsWith('--from=')) args.from = a.slice(7);
    else if (a.startsWith('--to=')) args.to = a.slice(5);
    else if (a.startsWith('--state=')) args.state = a.slice(8);
    else { console.error(`Unknown option: ${a}\nRun with --help.`); process.exit(2); }
  }
  return args;
}

function printHelp() {
  console.log(`
backfill-six-months.js — fill in the Call Stats history Aircall still has but
this database never collected.

WHAT IT DOES
  Walks one Pacific calendar day at a time, re-fetches that day's calls from
  Aircall, and runs them through the SAME aggregation the nightly sync uses.
  Each day it would write:
    * call_stats rows                per staff member / day / direction
    * call_stats_line_misses rows    per phone line / day / direction,
                                     including who the line rang, why each
                                     miss was missed, and how many callers
                                     left a voicemail

WHAT IT DOES NOT DO
  * It writes NOTHING unless you pass --apply. The default is a dry run that
    reports what it would write and then stops.
  * It never touches synced_at on a row that already exists. That column
    means "last confirmed by the nightly sync" and a backfill is not a sync.
  * It never runs before ${BACKFILL_FLOOR} and will refuse if asked to. Before
    that date nobody can confirm which staff member each phone line rang, so
    attributing a miss to a named person would be a guess printed on a
    scorecard.
  * It stores no caller phone numbers and no voicemail recordings — it counts
    voicemails and never keeps the link.

OPTIONS
  --from=YYYY-MM-DD   First day to backfill. Cannot be before ${BACKFILL_FLOOR}.
  --to=YYYY-MM-DD     Last day. Defaults to yesterday (today is still in
                      progress and would be written incomplete).
  --apply             Actually write to the database. Without this, dry run.
  --restart           Ignore the saved progress file and start over. Safe —
                      every write is an overwrite, never a duplicate.
  --state=PATH        Where to keep the progress file.
  --help              This message.

HOW LONG IT TAKES
  Aircall limits how fast it will answer, so this deliberately goes slowly —
  roughly a second and a half per page of calls. Six months is on the order of
  fifteen to thirty minutes. It is safe to stop it (Ctrl-C) and start it again
  later: it remembers which days it finished.

EXAMPLES
  node backfill-six-months.js --from=${BACKFILL_FLOOR} --to=2026-09-09
  node backfill-six-months.js --from=${BACKFILL_FLOOR} --to=2026-09-09 --apply
`);
}

// ── Small helpers ─────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isValidCalendarDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return !isNaN(parsed.getTime())
    && parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

function eachDate(fromStr, toStr) {
  const out = [];
  const [fy, fm, fd] = fromStr.split('-').map(Number);
  const end = Date.UTC(...toStr.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
  for (let t = Date.UTC(fy, fm - 1, fd); t <= end; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function pct(n, d) { return d > 0 ? `${Math.round((n / d) * 100)}%` : '—'; }

// Live "fetching page 3..." progress is only useful on a real terminal. Piped
// to a file or a log, carriage returns are literal and turn the report into
// an unreadable smear — which matters here, because the dry-run report is the
// deliverable Peter reads before approving the real run.
const IS_TTY = Boolean(process.stdout.isTTY);
function progress(text) { if (IS_TTY) process.stdout.write(`\r${text}   `); }

// ── Aircall fetch with real 429 backoff ───────────────────────────────────
// Deliberately NOT lib/aircall-connector.js's listCallsForDateRange(): that
// one throws on a 429 with no retry, which is right for a nightly job that
// can simply re-run the day and wrong for a two-hundred-day pull. Same URL
// shape, same pagination, same GET-only discipline — the connector's CRITICAL
// header rule (never a generic request(method, path) helper) is respected:
// this is one narrowly-scoped GET-only function that exists for one job.
function authHeader() {
  const id = process.env.AIRCALL_API_ID;
  const token = process.env.AIRCALL_API_TOKEN;
  if (!id || !token) throw new Error('AIRCALL_API_ID / AIRCALL_API_TOKEN are not set. See .env.example.');
  return 'Basic ' + Buffer.from(`${id}:${token}`).toString('base64');
}

let total429s = 0;

async function aircallGetWithBackoff(url, attempt = 0) {
  const res = await fetch(url, { method: 'GET', headers: { Authorization: authHeader() } });

  if (res.status === 429) {
    total429s++;
    const retryAfter = Number(res.headers.get('retry-after')) || 0;
    // Aircall's own Retry-After wins when it sends one; otherwise exponential
    // backoff capped at a minute. Backing off is the whole point — failing
    // here would throw away however many days had been fetched but not yet
    // committed to the state file.
    const waitMs = retryAfter > 0 ? (retryAfter + 1) * 1000 : Math.min(60000, 4000 * Math.pow(2, attempt));
    if (attempt >= MAX_429_RETRIES) {
      throw new Error(`Aircall rate limit (429) survived ${MAX_429_RETRIES} backoffs. Stopping so the day is not written half-fetched — re-run later and it resumes from the state file.`);
    }
    console.warn(`      [429] rate limited — waiting ${Math.round(waitMs / 1000)}s (retry ${attempt + 1}/${MAX_429_RETRIES})`);
    await sleep(waitMs);
    return aircallGetWithBackoff(url, attempt + 1);
  }

  // A 5xx is worth one patient retry too: a transient Aircall blip should not
  // end a half-hour job. A 4xx that is not 429 is a real problem (bad
  // credentials, bad request) and is thrown immediately.
  if (res.status >= 500 && attempt < 3) {
    const waitMs = 5000 * (attempt + 1);
    console.warn(`      [${res.status}] Aircall server error — waiting ${waitMs / 1000}s (retry ${attempt + 1}/3)`);
    await sleep(waitMs);
    return aircallGetWithBackoff(url, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Aircall GET failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function listCallsThrottled(fromUnix, toUnix, onPage) {
  let all = [];
  let url = `https://api.aircall.io/v1/calls?order=asc&per_page=50&from=${fromUnix}&to=${toUnix}`;
  let pages = 0;
  while (url && pages < 500) {
    const body = await aircallGetWithBackoff(url);
    all = all.concat(body.calls || []);
    url = (body.meta && body.meta.next_page_link) || null;
    pages++;
    if (onPage) onPage(pages, all.length);
    if (url) await sleep(PAGE_DELAY_MS);
  }
  if (pages >= 500 && url) {
    throw new Error('Aircall calls fetch hit the 500-page safety cap without reaching the last page — aborting rather than silently backfilling a partial day.');
  }
  return { calls: all, pages };
}

// ── Progress state ────────────────────────────────────────────────────────
// Written after each day's WRITES land (or, in a dry run, after each day is
// reported), so an interrupted run resumes rather than re-fetching. Keyed by
// mode: a dry run must never mark a day as backfilled for a later --apply.

function stateFileFor(args) {
  if (args.state) return args.state;
  return path.join(STATE_DIR, `backfill-${args.apply ? 'apply' : 'dryrun'}.json`);
}

function loadState(file, args) {
  if (args.restart) return { done: {}, started_at: new Date().toISOString() };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { done: {}, started_at: new Date().toISOString() };
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); return; }

  const from = args.from || BACKFILL_FLOOR;
  const to = args.to || yesterdayPacificDateStr();

  if (!isValidCalendarDate(from) || !isValidCalendarDate(to)) {
    console.error('--from and --to must each be a valid YYYY-MM-DD date. Run with --help.');
    process.exit(2);
  }
  if (from > to) {
    console.error(`--from (${from}) is after --to (${to}). Nothing to do.`);
    process.exit(2);
  }
  // The floor is a refusal, not a warning. See the header.
  if (from < BACKFILL_FLOOR) {
    console.error(`
REFUSING TO RUN.

  You asked to start at ${from}, but the earliest safe date is ${BACKFILL_FLOOR}.

  Filling in older days means guessing which staff member each phone line
  rang back then. Peter confirmed on 2026-09-10 that no Aircall line changed
  hands in the last six months — that confirmation is what makes this backfill
  safe, and it does not reach further back than ${BACKFILL_FLOOR}. Aircall keeps no
  history of who a line used to ring, so there is no way to check.

  Those older misses would land on a named employee's scorecard with nothing
  behind them. Leave them out.
`);
    process.exit(2);
  }
  const todayPacific = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  if (to >= todayPacific) {
    console.error(`--to (${to}) must be before today (${todayPacific} in Pacific time). Today is still in progress and would be backfilled incomplete, then never corrected.`);
    process.exit(2);
  }

  for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'AIRCALL_API_ID', 'AIRCALL_API_TOKEN']) {
    if (!process.env[k]) { console.error(`${k} is not set. See .env.example.`); process.exit(2); }
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const dates = eachDate(from, to);
  const stateFile = stateFileFor(args);
  const state = loadState(stateFile, args);

  console.log('='.repeat(74));
  console.log(args.apply
    ? '  CALL STATS BACKFILL — *** APPLY MODE: THIS WILL WRITE TO THE DATABASE ***'
    : '  CALL STATS BACKFILL — DRY RUN. Nothing will be written.');
  console.log('='.repeat(74));
  console.log(`  Range          ${from} .. ${to}  (${dates.length} Pacific days)`);
  console.log(`  Floor          ${BACKFILL_FLOOR} (Peter's confirmation, 2026-09-10)`);
  console.log(`  State file     ${stateFile}`);
  console.log(`  Already done   ${Object.keys(state.done || {}).length} day(s)`);
  console.log(`  synced_at      never written on an existing row (a backfill is not a sync)`);
  console.log('='.repeat(74) + '\n');

  // ── The line mapping. ONCE for the whole run. ──────────────────────────
  // It is per-line, not per-call, and it is TODAY's answer whichever day we
  // are writing — re-fetching it per day would cost 16 GETs x 184 days for an
  // identical result. Fetched through the real connector so the empty-map and
  // detail-endpoint guards apply unchanged.
  console.log('Fetching Aircall line ring membership (GET /v1/numbers, then one detail per line)...');
  let membership;
  try {
    membership = await aircall.fetchLineRingMembership();
  } catch (err) {
    console.error(`\nFAILED to read the line-to-user mapping from Aircall: ${err.message}`);
    console.error('Refusing to continue. Without it every backfilled row would say "this line rang nobody," which is indistinguishable from the truth and permanent.');
    process.exit(1);
  }
  console.log(`  ${membership.size} lines. Ring membership AS OF NOW — this is what gets stamped on every historical row:\n`);
  const soleLines = [], nobodyLines = [], severalLines = [], unresolvedLines = [];
  for (const [id, m] of membership) {
    if (m.ring_user_count === 1 && m.sole_user_email) soleLines.push(`      ${m.line_name} -> ${m.sole_user_email}`);
    else if (m.ring_user_count === 1) unresolvedLines.push(`      ${m.line_name} (id ${id}) — rings ONE person whose email could not be resolved`);
    else if (m.ring_user_count === 0) nobodyLines.push(`      ${m.line_name}`);
    else severalLines.push(`      ${m.line_name} (${m.ring_user_count} people)`);
  }
  console.log(`   Rings exactly one person — these misses become attributable (${soleLines.length}):`);
  soleLines.forEach(l => console.log(l));
  console.log(`\n   Rings nobody — charged to no individual (${nobodyLines.length}):`);
  nobodyLines.forEach(l => console.log(l));
  console.log(`\n   Rings several — charged to no individual (${severalLines.length}):`);
  severalLines.forEach(l => console.log(l));
  if (unresolvedLines.length) {
    console.log(`\n   *** DATA QUALITY ALARM — sole user, no resolvable email (${unresolvedLines.length}): ***`);
    unresolvedLines.forEach(l => console.log(l));
  }

  // Every Rincon staff email — the match target for call.user.email, and the
  // same list the stats route uses to decide whether a sole_user_email is
  // actually a Rincon employee.
  const { data: userRows, error: usersErr } = await supabase.from('users').select('id, email, name');
  if (usersErr) { console.error(`Failed to read users: ${usersErr.message}`); process.exit(1); }
  const usersByEmail = new Map((userRows || []).map(u => [String(u.email).toLowerCase(), u]));

  // A sole user who is not a Rincon employee is worth saying out loud BEFORE
  // a long run rather than discovering in the totals: their line's misses are
  // stamped with an email, pass the schema's constraint, and then fall out of
  // every dashboard number because isAttributableLineMissRow() requires a
  // `users` match. Nothing is lost — the misses stay visible as unattributed
  // — but it is not obvious from the row.
  const externalSoleUsers = [];
  for (const [, m] of membership) {
    if (m.ring_user_count === 1 && m.sole_user_email && !usersByEmail.has(m.sole_user_email)) {
      externalSoleUsers.push(`      ${m.line_name} -> ${m.sole_user_email} (no matching row in \`users\`)`);
    }
  }
  if (externalSoleUsers.length) {
    console.log(`\n   *** NOTE — sole user is not a known Rincon user (${externalSoleUsers.length}): ***`);
    externalSoleUsers.forEach(l => console.log(l));
    console.log('      Their misses will be stored and stay VISIBLE, but charged to nobody.');
  }
  console.log('\n' + '='.repeat(74) + '\n');

  // ── Running totals for the final report ────────────────────────────────
  const run = {
    days_processed: 0, days_skipped_already_done: 0, days_with_no_calls: 0,
    calls_fetched: 0, pages_fetched: 0,
    call_stats_rows: 0, line_miss_rows: 0,
    line_misses_total: 0, agents_did_not_answer: 0, voicemails_left: 0,
    reasons: new Map(), unrecognized_reasons: new Map(),
    existing_line_miss_rows_found: 0, existing_line_misses_stored: 0,
    days_where_stored_differs: [],
    unresolved_sole_user_days: 0, lines_missing_from_mapping_days: 0,
    write_errors: [],
  };
  const perDay = [];

  for (const dateStr of dates) {
    if (state.done && state.done[dateStr]) { run.days_skipped_already_done++; continue; }

    const { from: dayFrom, to: dayTo } = pacificDayBoundsUnix(dateStr);

    let calls, pages;
    try {
      ({ calls, pages } = await listCallsThrottled(dayFrom, dayTo, (p, n) => {
        progress(`${dateStr}  fetching... page ${p}, ${n} calls`);
      }));
    } catch (err) {
      console.log(`\n   FETCH FAILED: ${err.message}`);
      console.log('   Stopping. Progress is saved — re-run to resume from here.');
      break;
    }
    run.calls_fetched += calls.length;
    run.pages_fetched += pages;

    if (calls.length === 0) {
      run.days_with_no_calls++;
      progress('');
      console.log(`${dateStr}  no calls`);
      state.done[dateStr] = { calls: 0, at: new Date().toISOString() };
      saveState(stateFile, state);
      await sleep(DAY_DELAY_MS);
      continue;
    }

    // *** THE SAME TWO FUNCTIONS THE NIGHTLY SYNC CALLS. *** Not a parallel
    // implementation. If the aggregation rules ever change, this backfill
    // changes with them automatically — a second copy would drift, and the
    // drift would show up as two different answers for the same day
    // depending on which code path happened to write it.
    const { rows: csRows, summary: csSummary } = buildDailyAggregates(calls, usersByEmail);
    const { rows: lmRows, summary: lmSummary } = buildLineMissAggregates(calls, membership);

    const dayMissed = lmRows.reduce((a, r) => a + r.missed_calls, 0);
    const dayCharged = lmRows.reduce((a, r) => a + r.missed_calls_agents_did_not_answer, 0);
    const dayVoicemails = lmRows.reduce((a, r) => a + r.voicemails_left, 0);

    run.call_stats_rows += csRows.length;
    run.line_miss_rows += lmRows.length;
    run.line_misses_total += dayMissed;
    run.agents_did_not_answer += dayCharged;
    run.voicemails_left += dayVoicemails;
    for (const [reason, count] of Object.entries(lmSummary.miss_reasons_seen)) {
      run.reasons.set(reason, (run.reasons.get(reason) || 0) + count);
    }
    for (const { reason, count } of lmSummary.unrecognized_miss_reasons) {
      run.unrecognized_reasons.set(reason, (run.unrecognized_reasons.get(reason) || 0) + count);
    }
    if (lmSummary.rows_sole_user_email_unresolved > 0) run.unresolved_sole_user_days++;
    if (lmSummary.rows_line_missing_from_mapping > 0) run.lines_missing_from_mapping_days++;

    // What is ALREADY stored for this day. In a dry run this is the whole
    // point: it turns "the table is incomplete" into a per-day number.
    const { data: existing, error: existingErr } = await supabase
      .from('call_stats_line_misses')
      .select('aircall_number_id, direction, missed_calls, missed_calls_agents_did_not_answer')
      .eq('call_date', dateStr);
    if (existingErr) {
      console.log(`\n   Could not read existing rows for ${dateStr}: ${existingErr.message}`);
    }
    const existingRows = existing || [];
    const existingMissed = existingRows.reduce((a, r) => a + (r.missed_calls || 0), 0);
    const existingMeasured = existingRows.filter(r => r.missed_calls_agents_did_not_answer != null).length;
    run.existing_line_miss_rows_found += existingRows.length;
    run.existing_line_misses_stored += existingMissed;
    if (existingRows.length > 0 && existingMissed !== dayMissed) {
      run.days_where_stored_differs.push({ date: dateStr, stored: existingMissed, aircall: dayMissed });
    }

    const flags = [];
    if (existingRows.length === 0) flags.push('NEW DAY');
    else if (existingMissed !== dayMissed) flags.push(`STORED ${existingMissed} != AIRCALL ${dayMissed}`);
    else flags.push('counts match');
    if (existingRows.length > 0 && existingMeasured === 0) flags.push('all stored rows UNMEASURED');
    if (lmSummary.unrecognized_miss_reasons.length) flags.push(`NEW REASON: ${lmSummary.unrecognized_miss_reasons.map(u => u.reason).join(',')}`);
    if (lmSummary.rows_sole_user_email_unresolved) flags.push(`${lmSummary.rows_sole_user_email_unresolved} unresolved sole user`);
    if (lmSummary.rows_line_missing_from_mapping) flags.push(`${lmSummary.rows_line_missing_from_mapping} line(s) missing from mapping`);

    progress('');
    console.log(
      `${dateStr}  ${String(calls.length).padStart(4)} calls  ` +
      `call_stats ${String(csRows.length).padStart(3)}  line-miss ${String(lmRows.length).padStart(3)}  ` +
      `misses ${String(dayMissed).padStart(3)} (charged ${String(dayCharged).padStart(3)})  ` +
      `vm ${String(dayVoicemails).padStart(3)}  ${flags.join('; ')}`
    );

    perDay.push({
      date: dateStr, calls: calls.length,
      call_stats_rows: csRows.length, line_miss_rows: lmRows.length,
      missed: dayMissed, charged: dayCharged, voicemails: dayVoicemails,
      stored_missed: existingRows.length ? existingMissed : null,
      unattributed_calls: csSummary.calls_unattributed_no_user,
    });

    if (args.apply) {
      // ── THE ONLY WRITES IN THIS FILE ───────────────────────────────────
      // Both loops omit `synced_at` deliberately — see the header. Both are
      // upserts on the tables' existing keys, so a re-run overwrites in place
      // and never duplicates.
      let dayErrors = 0;
      for (const row of csRows) {
        const { error } = await supabase
          .from('call_stats')
          .upsert(row, { onConflict: 'aircall_user_id,call_date,direction' });
        if (error) { run.write_errors.push({ date: dateStr, table: 'call_stats', key: `${row.aircall_user_id}|${row.direction}`, error: error.message }); dayErrors++; }
      }
      for (const row of lmRows) {
        const { error } = await supabase
          .from('call_stats_line_misses')
          .upsert(row, { onConflict: 'aircall_number_id,call_date,direction' });
        if (error) { run.write_errors.push({ date: dateStr, table: 'call_stats_line_misses', key: `${row.aircall_number_id}|${row.direction}`, error: error.message }); dayErrors++; }
      }
      if (dayErrors > 0) {
        console.log(`   ${dayErrors} write error(s) on ${dateStr} — NOT marking the day done, so a re-run retries it.`);
      } else {
        state.done[dateStr] = { calls: calls.length, rows: csRows.length + lmRows.length, at: new Date().toISOString() };
        saveState(stateFile, state);
      }
    } else {
      state.done[dateStr] = { calls: calls.length, dry_run: true, at: new Date().toISOString() };
      saveState(stateFile, state);
    }

    run.days_processed++;
    await sleep(DAY_DELAY_MS);
  }

  // ── Report ─────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(74));
  console.log(args.apply ? '  BACKFILL COMPLETE — rows were written' : '  DRY RUN COMPLETE — NOTHING WAS WRITTEN');
  console.log('='.repeat(74));
  console.log(`  Days processed this run       ${run.days_processed}`);
  console.log(`  Days skipped (already done)   ${run.days_skipped_already_done}`);
  console.log(`  Days with no calls at all     ${run.days_with_no_calls}`);
  console.log(`  Aircall calls fetched         ${run.calls_fetched}  (${run.pages_fetched} pages, ${total429s} rate-limit pauses)`);
  console.log('');
  console.log(`  call_stats rows              ${args.apply ? 'written' : 'that WOULD be written'}: ${run.call_stats_rows}`);
  console.log(`  call_stats_line_misses rows  ${args.apply ? 'written' : 'that WOULD be written'}: ${run.line_miss_rows}`);
  console.log('');
  console.log(`  Line misses in Aircall for this range     ${run.line_misses_total}`);
  console.log(`  Of those, charged to a person            ${run.agents_did_not_answer}  (${pct(run.agents_did_not_answer, run.line_misses_total)} — agents_did_not_answer only)`);
  console.log(`  Charged to nobody (other reasons)        ${run.line_misses_total - run.agents_did_not_answer}  (${pct(run.line_misses_total - run.agents_did_not_answer, run.line_misses_total)})`);
  console.log(`  Voicemails left                          ${run.voicemails_left}  (${pct(run.voicemails_left, run.line_misses_total)} of misses)`);
  console.log('');
  console.log('  Miss reasons across the range:');
  for (const [reason, count] of Array.from(run.reasons.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${reason.padEnd(28)} ${String(count).padStart(5)}  ${pct(count, run.line_misses_total)}`);
  }

  console.log('\n  ── What is already in the database for this range ──');
  console.log(`  Existing call_stats_line_misses rows found   ${run.existing_line_miss_rows_found}`);
  console.log(`  Misses those rows record                     ${run.existing_line_misses_stored}`);
  console.log(`  Misses Aircall actually has                  ${run.line_misses_total}`);
  const gap = run.line_misses_total - run.existing_line_misses_stored;
  console.log(`  GAP this backfill would close                ${gap}`);
  if (run.days_where_stored_differs.length) {
    console.log(`\n  Days where the stored count disagrees with Aircall (${run.days_where_stored_differs.length}):`);
    for (const d of run.days_where_stored_differs) {
      console.log(`      ${d.date}  stored ${String(d.stored).padStart(3)}  Aircall ${String(d.aircall).padStart(3)}  ${d.aircall > d.stored ? `(${d.aircall - d.stored} missing)` : `(${d.stored - d.aircall} MORE stored than Aircall reports — investigate)`}`);
    }
  }

  if (run.unrecognized_reasons.size) {
    console.log('\n  *** MISS REASONS NOT IN KNOWN_MISS_REASONS ***');
    console.log('  These ARE stored verbatim in missed_calls_by_reason — nothing is lost — and');
    console.log('  they are charged to nobody until Peter decides otherwise. Review, then add');
    console.log('  them to KNOWN_MISS_REASONS in lib/sync.js so they stop being flagged:');
    for (const [reason, count] of run.unrecognized_reasons) console.log(`      ${reason.padEnd(28)} ${count}`);
  }
  if (run.unresolved_sole_user_days) {
    console.log(`\n  *** ${run.unresolved_sole_user_days} day(s) had a line ringing exactly one person whose email could not be resolved.`);
    console.log('      Those misses are stored and visible but charged to nobody.');
  }
  if (run.lines_missing_from_mapping_days) {
    console.log(`\n  *** ${run.lines_missing_from_mapping_days} day(s) had calls on a line Aircall's current line list does not return`);
    console.log("      (a deleted line). Both attribution columns left NULL; misses stay visible, charged to nobody.");
  }
  if (run.write_errors.length) {
    console.log(`\n  *** ${run.write_errors.length} WRITE ERROR(S) — those days were NOT marked done and will be retried on a re-run:`);
    for (const e of run.write_errors.slice(0, 20)) console.log(`      ${e.date} ${e.table} ${e.key}: ${e.error}`);
    if (run.write_errors.length > 20) console.log(`      ... and ${run.write_errors.length - 20} more`);
  }

  console.log('\n  ── What every backfilled row would carry ──');
  console.log('  From the call records themselves (immutable historical fact):');
  console.log('      total_calls, missed_calls, answered/talk/ring seconds,');
  console.log('      missed_calls_by_reason, missed_calls_agents_did_not_answer, voicemails_left');
  console.log("  From TODAY's Aircall configuration, applied retroactively:");
  console.log('      sole_user_email, ring_user_count — the mapping printed at the top of this');
  console.log("      report. Aircall keeps no history of who a line used to ring, so there is no");
  console.log("      historical version to ask for. Peter's confirmation that no line changed");
  console.log(`      hands since ${BACKFILL_FLOOR} is the only thing making this equal to the truth,`);
  console.log('      and nothing on the row records that it was stamped rather than snapshotted.');
  console.log('  synced_at:');
  console.log('      Never written on a row that already exists. A brand-new row gets the column');
  console.log('      default (NOW()) because the column is NOT NULL and cannot be inserted empty.');

  if (!args.apply) {
    console.log('\n  ' + '-'.repeat(70));
    console.log('  THIS WAS A DRY RUN. The database was not modified.');
    console.log('  To actually write these rows, re-run the same command with --apply.');
    console.log('  ' + '-'.repeat(70));
  }
  console.log('');
}

main().catch((err) => {
  console.error('\nBackfill failed:', err.message);
  console.error('Progress is saved — re-running resumes from the last completed day.');
  process.exit(1);
});
