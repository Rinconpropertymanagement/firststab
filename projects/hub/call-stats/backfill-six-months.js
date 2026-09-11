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
 * Attribution is withheld on any line/day that lib/line-ownership-history.js
 * says was worked by somebody other than whoever rings that line today. That
 * rule lives in buildLineMissAggregates(), not in this script, so the nightly
 * sync and the `?date=` re-run path are covered by it too.
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
 * Three different kinds of fact end up on each backfilled row, and they do
 * not deserve equal confidence:
 *
 *   STABLE PER-CALL FIELDS — what is read off a single call object: duration,
 *   answered_at, missed_call_reason, voicemail. These do appear not to change
 *   after the fact.
 *
 *   NOT IMMUTABLE, AND THIS IS THE TRAP — WHICH CALLS ARE ON THE ROW AT ALL.
 *   Aircall rewrites history when a seat is deleted: it strips the `user`
 *   field from every call that person handled (verified 2026-09-10 —
 *   GET /v1/users/1906760 returns 404 and all 1,257 of Aldo Hernandez's calls
 *   now return user: null). Because buildDailyAggregates() SKIPS user-less
 *   calls and buildLineMissAggregates() claims them, a departure MOVES a
 *   person's historical calls out of call_stats and into
 *   call_stats_line_misses. A backfilled row is therefore NOT "as good as a
 *   row the nightly sync wrote that night" for any line worked by somebody who
 *   has since left — the counts themselves differ, and the difference grows
 *   with every departure. RSC Solimar's Apr–Aug line rows will carry roughly
 *   1,046 answered and outbound calls in total_calls that were never user-less
 *   at the time. lib/line-ownership-history.js is what stops those relocated
 *   calls being charged to whoever holds the line today; it cannot put them
 *   back in call_stats, and nothing can.
 *
 *   (An earlier version of this header claimed the opposite outright —
 *   "Aircall's record of a call that happened in April does not change. These
 *   are as good as a row the nightly sync wrote that night." That was false,
 *   and it was the premise this whole retroactive-stamping argument rested on.
 *   Corrected 2026-09-10.)
 *
 *   A VISIBLE CONSEQUENCE, worth knowing before reading the dashboard: after
 *   this backfill, RSC Solimar's shared-line call VOLUME jumps across the
 *   Aug/Sep boundary. That is an artefact of Aldo's departure moving his calls
 *   into this table — not a change in how much anyone used the phone.
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
 * A DRY RUN'S PROGRESS IS RECORDED SEPARATELY FROM AN --apply RUN'S, in its
 * own ledger inside the same file, and neither can ever satisfy the other. A
 * dry run writes nothing, so a day it "finished" is not a day that has been
 * backfilled — see "Progress state" below for the failure that reasoning
 * prevents, which TARS reproduced on 2026-09-10.
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
const { buildDailyAggregates, buildLineMissAggregates, lineOwnershipRuleFor, isNamedEmail } = require('./lib/sync');
// The dashboard's OWN attribution gate, not a copy of it. The report's
// "charged to a person" figure has to be the number that will actually land
// on named people when Peter opens the page — see splitChargedMisses() below.
const { isAttributableLineMissRow } = require('./lib/metrics');
// Read ONLY to print the rules at the top of the run, so the report says what
// was held back and why. The rule itself is applied inside
// buildLineMissAggregates() — not here — so the nightly sync and the `?date=`
// manual re-run get it too. See lib/line-ownership-history.js NOTES FOR Q #1.
const { LINE_OWNERSHIP_HISTORY } = require('./lib/line-ownership-history');
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
  * It does not charge a call to the person who rings that line today if
    somebody else was working the line back then. Those calls are still
    stored and still visible — they are just charged to nobody. The dates
    are in lib/line-ownership-history.js and the report lists what was held
    back.

OPTIONS
  --from=YYYY-MM-DD   First day to backfill. Cannot be before ${BACKFILL_FLOOR}.
  --to=YYYY-MM-DD     Last day. Defaults to yesterday (today is still in
                      progress and would be written incomplete).
  --apply             Actually write to the database. Without this, dry run.
  --restart           Ignore the saved progress file and start over. Safe —
                      every write is an overwrite, never a duplicate.
  --state=PATH        Where to keep the progress file. It remembers which days
                      are finished so an interrupted run picks up where it
                      stopped. Dry runs and --apply runs are remembered
                      SEPARATELY, even in the same file: a day a dry run
                      finished is NOT treated as backfilled, because a dry run
                      writes nothing. Without that, a dry run followed by an
                      --apply run against the same file would skip every day,
                      write nothing, and still print a report saying zero rows
                      were needed.
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

// ── "Charged to a person" — the one figure that must not be generous ──────
//
// `missed_calls_agents_did_not_answer` is a per-ROW count of the one miss
// reason Peter's rule charges to somebody. It is NOT the same as "charged to
// a person," because plenty of rows carry that reason while charging nobody:
// a line that rings three people, a line that rings none, an outbound row, a
// row the ownership history holds back. Summing the column across every row
// answers a different question than the report's label claims.
//
// THIS WAS WRONG UNTIL 2026-09-10 AND WRONG IN THE ONE DIRECTION THAT
// MATTERS. The old line summed the column over every row and printed 1,661
// for the six-month range where the figure that actually lands on named
// people is 1,441 — overstating attribution by 220 on the very report Peter
// reads to decide whether to run --apply. The line predates the line
// ownership history; that work made it wrong by adding a third way for a
// measured, chargeable-looking miss to end up charged to nobody.
//
// The gate is imported from lib/metrics.js — the SAME function the stats
// route applies to these rows once they are in the table — so this report
// cannot drift from the page it is predicting. Rows fresh out of
// buildLineMissAggregates() are always MEASURED (all three reason columns are
// written together, never NULL), so the route's second condition is
// satisfied by construction here and is asserted rather than re-tested.
function splitChargedMisses(lmRows, usersByEmail) {
  const split = { charged: 0, not_charged: 0, by_cause: new Map() };
  for (const row of lmRows) {
    const chargeable = row.missed_calls_agents_did_not_answer || 0;
    if (chargeable === 0) continue;
    const soleEmail = String(row.sole_user_email || '').toLowerCase();
    if (isAttributableLineMissRow(row, soleEmail, usersByEmail)) {
      split.charged += chargeable;
      continue;
    }
    split.not_charged += chargeable;
    const cause = notChargedCause(row, soleEmail);
    let bucket = split.by_cause.get(cause);
    if (!bucket) { bucket = { calls: 0, lines: new Set() }; split.by_cause.set(cause, bucket); }
    bucket.calls += chargeable;
    bucket.lines.add(row.line_name || row.aircall_number_id);
  }
  return split;
}

// Why one row's `agents_did_not_answer` misses are charged to nobody, in
// Peter's words rather than in column values.
//
// *** THE OWNERSHIP TEST COMES FIRST, AND THE ORDER IS LOAD-BEARING. *** A
// row held back by the ownership history carries sole_user_email NULL and
// ring_user_count NULL — byte for byte the same row a deleted line produces.
// Asking the columns first would report every one of Aldo's held-back rows as
// "this line is not in Aircall's current line list," which is false and is
// the kind of plausible wrong answer nobody checks. The same order lives in
// buildLineMissAggregates(), for the same reason.
function notChargedCause(row, soleEmail) {
  const ownership = lineOwnershipRuleFor(row.aircall_number_id, row.call_date);
  if (ownership && ownership.excluded) return 'held back by the line ownership history';
  if (row.direction !== 'inbound') return 'outbound row — never charged to a person';
  if (row.ring_user_count == null) return "line is not in Aircall's current line list";
  if (row.ring_user_count === 0) return 'line rings nobody';
  if (row.ring_user_count !== 1) return 'line rings several people';
  if (!soleEmail) return 'line rings one person whose email could not be resolved';
  return 'sole user is not a known Rincon user';
}

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
// reported), so an interrupted run resumes rather than re-fetching.
//
// *** A DRY RUN'S PROGRESS AND AN --apply RUN'S PROGRESS ARE TWO SEPARATE
// LEDGERS IN THE SAME FILE. THEY MUST NEVER SATISFY EACH OTHER. ***
// The default paths are mode-keyed, so this was invisible until TARS pointed
// an explicit --state=PATH at both modes on 2026-09-10 and reproduced the
// failure: the dry run recorded every day as done, the --apply run that
// followed skipped all of them, wrote nothing, and printed
//
//     call_stats rows that WOULD be written: 0
//     GAP this backfill would close: 0
//
// which reads exactly like "there is nothing left to fix" and actually means
// "nothing was looked at." That report is the deliverable Peter approves the
// real run from, so it has to be impossible to produce it by accident.
//
// Two ledgers rather than one flag test, because the hazard runs BOTH ways: a
// single `done` map would also let a dry run overwrite an --apply run's record
// of a day that really was written. Splitting them removes the whole class
// instead of the one direction TARS happened to find, costs one extra key in
// a JSON file, and makes the file self-explanatory to anyone who opens it.
// Considered and rejected: refusing to run at all when the state file's mode
// does not match — it turns a recoverable situation into an error message
// about a file the reader did not know existed, and gains nothing over just
// keeping the two records apart.

function stateFileFor(args) {
  if (args.state) return args.state;
  return path.join(STATE_DIR, `backfill-${args.apply ? 'apply' : 'dryrun'}.json`);
}

function loadState(file, args) {
  const fresh = { done: {}, dry_run_done: {}, started_at: new Date().toISOString() };
  if (args.restart) return fresh;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fresh;
  }

  const state = { ...fresh, ...parsed };
  state.done = { ...(parsed.done || {}) };
  state.dry_run_done = { ...(parsed.dry_run_done || {}) };

  // A state file written before 2026-09-10 kept both modes in `done`, with a
  // dry-run day marked only by a `dry_run: true` flag nothing ever read. Move
  // those into the dry-run ledger where they belong, so an --apply run against
  // an old file cannot inherit the bug it is being fixed for.
  for (const [dateStr, entry] of Object.entries(state.done)) {
    if (entry && entry.dry_run) {
      state.dry_run_done[dateStr] = entry;
      delete state.done[dateStr];
    }
  }
  return state;
}

// The ledger this run reads and writes. An --apply run sees only days that
// were really written; a dry run sees only days that were really reported.
function doneDaysFor(state, args) {
  return args.apply ? state.done : state.dry_run_done;
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
  const doneDays = doneDaysFor(state, args);
  const otherLedgerDays = Object.keys(args.apply ? state.dry_run_done : state.done).length;

  console.log('='.repeat(74));
  console.log(args.apply
    ? '  CALL STATS BACKFILL — *** APPLY MODE: THIS WILL WRITE TO THE DATABASE ***'
    : '  CALL STATS BACKFILL — DRY RUN. Nothing will be written.');
  console.log('='.repeat(74));
  console.log(`  Range          ${from} .. ${to}  (${dates.length} Pacific days)`);
  console.log(`  Floor          ${BACKFILL_FLOOR} (Peter's confirmation, 2026-09-10)`);
  console.log(`  State file     ${stateFile}`);
  console.log(`  Already done   ${Object.keys(doneDays).length} day(s) recorded by a previous ${args.apply ? '--apply' : 'dry'} run`);
  if (otherLedgerDays > 0) {
    console.log(`                 (the same file also holds ${otherLedgerDays} day(s) from ${args.apply ? 'dry runs' : '--apply runs'} — a separate`);
    console.log(`                 record, deliberately ignored here: a dry run writes nothing, so it can`);
    console.log(`                 never stand in for a real write, and vice versa)`);
  }
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
  // ── The line ownership history, printed BEFORE the run ─────────────────
  // The mapping above is Aircall's answer for TODAY. This is the list of
  // dates on which that answer stops being the right one for a historical
  // day, and it is printed next to it on purpose: the two have to be read
  // together. A line with no entry here is the normal case and is attributed
  // exactly as it always was.
  console.log('\n   Line ownership history (lib/line-ownership-history.js) — where TODAY\'s mapping');
  console.log('   does NOT apply to a historical day:');
  if (LINE_OWNERSHIP_HISTORY.length === 0) {
    console.log('      (none — every line is attributed per current ring membership)');
  }
  for (const entry of LINE_OWNERSHIP_HISTORY) {
    // Three verdicts since 2026-09-11, not two. A named period is the one
    // where today's mapping does not apply AND somebody is still charged, so
    // printing it as "normal" would hide the only case where a name on a row
    // comes from this file rather than from Aircall.
    const verdict = entry.attribute_to === null
      ? 'charged to NOBODY'
      : isNamedEmail(entry.attribute_to)
        ? `charged BY NAME to ${entry.attribute_to} (closed period)`
        : 'attributed per current ring membership (normal)';
    console.log(`      ${entry.line_name} (id ${entry.aircall_number_id})  from ${entry.from}  ->  ${verdict}`);
    console.log(`          worked by: ${entry.worked_by}`);
  }
  console.log('      Anything EARLIER than a line\'s earliest date above is charged to nobody too.');

  console.log('\n' + '='.repeat(74) + '\n');

  // ── Running totals for the final report ────────────────────────────────
  const run = {
    days_processed: 0, days_skipped_already_done: 0, days_with_no_calls: 0,
    calls_fetched: 0, pages_fetched: 0,
    call_stats_rows: 0, line_miss_rows: 0,
    line_misses_total: 0, voicemails_left: 0,
    // Split, never a single total — see splitChargedMisses(). `charged_to_person`
    // is what lands on a named employee's scorecard; `not_charged_*` is the
    // rest of the `agents_did_not_answer` column, reported beside it so the
    // two numbers explain each other instead of one quietly standing in for
    // the other.
    charged_to_person: 0,
    not_charged_agents_did_not_answer: 0,
    not_charged_by_cause: new Map(),
    reasons: new Map(), unrecognized_reasons: new Map(),
    existing_line_miss_rows_found: 0, existing_line_misses_stored: 0,
    days_where_stored_differs: [],
    unresolved_sole_user_days: 0, lines_missing_from_mapping_days: 0,
    // Held back by the line ownership history. Accumulated per (line, period)
    // across the whole range, because that is the shape of the question:
    // "how many of Aldo's calls did NOT land on Leo."
    ownership_excluded_rows: 0, ownership_excluded_calls: 0,
    ownership_excluded_periods: new Map(),
    // Redirected by the line ownership history to a named person on a CLOSED
    // period (added 2026-09-11). The mirror image of the three above, and
    // reported separately for the same reason they are: "held back from the
    // current ringer" and "charged to the person who actually worked it" are
    // opposite actions on the same file, and a single merged total would
    // answer neither question.
    ownership_named_rows: 0, ownership_named_calls: 0,
    ownership_named_periods: new Map(),
    write_errors: [],
  };
  const perDay = [];

  for (const dateStr of dates) {
    // Only this mode's own ledger can skip a day. See "Progress state" above:
    // a day a DRY RUN finished has had nothing written for it, and must never
    // let an --apply run pass over it.
    if (doneDays[dateStr]) { run.days_skipped_already_done++; continue; }

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
      // Into THIS run's ledger only. A day with no calls has nothing to write
      // in either mode, but a dry run still records it as a dry run — the
      // point of the split is that no dry-run entry ever satisfies --apply,
      // including the easy days.
      doneDays[dateStr] = { calls: 0, dry_run: !args.apply, at: new Date().toISOString() };
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
    // `usersByEmail` is required by this aggregation as of 2026-09-11 — it is
    // what proves every email named in lib/line-ownership-history.js resolves
    // to a real person before any row is stamped with one. It is the same map
    // buildDailyAggregates() takes above and the same one splitChargedMisses()
    // uses below, so the name this backfill writes and the name the dashboard
    // will accept are checked against one list, once.
    const { rows: lmRows, summary: lmSummary } = buildLineMissAggregates(calls, membership, usersByEmail);

    const dayMissed = lmRows.reduce((a, r) => a + r.missed_calls, 0);
    const dayVoicemails = lmRows.reduce((a, r) => a + r.voicemails_left, 0);
    // Only the misses that will actually land on a named person. NOT the
    // whole `agents_did_not_answer` column — see splitChargedMisses().
    const daySplit = splitChargedMisses(lmRows, usersByEmail);
    const dayCharged = daySplit.charged;

    run.call_stats_rows += csRows.length;
    run.line_miss_rows += lmRows.length;
    run.line_misses_total += dayMissed;
    run.charged_to_person += daySplit.charged;
    run.not_charged_agents_did_not_answer += daySplit.not_charged;
    for (const [cause, bucket] of daySplit.by_cause) {
      let total = run.not_charged_by_cause.get(cause);
      if (!total) { total = { calls: 0, lines: new Set() }; run.not_charged_by_cause.set(cause, total); }
      total.calls += bucket.calls;
      for (const line of bucket.lines) total.lines.add(line);
    }
    run.voicemails_left += dayVoicemails;
    for (const [reason, count] of Object.entries(lmSummary.miss_reasons_seen)) {
      run.reasons.set(reason, (run.reasons.get(reason) || 0) + count);
    }
    for (const { reason, count } of lmSummary.unrecognized_miss_reasons) {
      run.unrecognized_reasons.set(reason, (run.unrecognized_reasons.get(reason) || 0) + count);
    }
    if (lmSummary.rows_sole_user_email_unresolved > 0) run.unresolved_sole_user_days++;
    if (lmSummary.rows_line_missing_from_mapping > 0) run.lines_missing_from_mapping_days++;

    run.ownership_excluded_rows += lmSummary.rows_excluded_by_line_ownership_history;
    run.ownership_excluded_calls += lmSummary.calls_excluded_by_line_ownership_history;
    for (const line of lmSummary.lines_excluded_by_ownership_history) {
      const periodKey = `${line.aircall_number_id}|${line.from || `(before ${line.before_earliest_from})`}`;
      let period = run.ownership_excluded_periods.get(periodKey);
      if (!period) {
        period = {
          line_name: line.line_name,
          from: line.from,
          before_earliest_from: line.before_earliest_from,
          worked_by: line.worked_by,
          days: 0, rows: 0, calls: 0, inbound_calls: 0, outbound_calls: 0, missed_calls: 0,
        };
        run.ownership_excluded_periods.set(periodKey, period);
      }
      period.days++;
      period.rows += line.rows;
      period.calls += line.calls;
      period.inbound_calls += line.inbound_calls;
      period.outbound_calls += line.outbound_calls;
      period.missed_calls += line.missed_calls;
    }

    run.ownership_named_rows += lmSummary.rows_named_by_line_ownership_history;
    run.ownership_named_calls += lmSummary.calls_named_by_line_ownership_history;
    for (const line of lmSummary.lines_named_by_ownership_history) {
      const periodKey = `${line.aircall_number_id}|${line.from}`;
      let period = run.ownership_named_periods.get(periodKey);
      if (!period) {
        period = {
          line_name: line.line_name,
          from: line.from,
          attributed_to: line.attributed_to,
          worked_by: line.worked_by,
          days: 0, rows: 0, calls: 0, inbound_calls: 0, outbound_calls: 0, missed_calls: 0,
        };
        run.ownership_named_periods.set(periodKey, period);
      }
      period.days++;
      period.rows += line.rows;
      period.calls += line.calls;
      period.inbound_calls += line.inbound_calls;
      period.outbound_calls += line.outbound_calls;
      period.missed_calls += line.missed_calls;
    }

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
    if (lmSummary.calls_excluded_by_line_ownership_history) flags.push(`${lmSummary.calls_excluded_by_line_ownership_history} call(s) held back by ownership history`);
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
        doneDays[dateStr] = { calls: calls.length, rows: csRows.length + lmRows.length, at: new Date().toISOString() };
        saveState(stateFile, state);
      }
    } else {
      // The dry-run ledger — a different key in the same file from the one
      // above. `dry_run: true` is kept as well, so the file still reads
      // plainly to a human and so an older reader of it is not surprised.
      doneDays[dateStr] = { calls: calls.length, dry_run: true, at: new Date().toISOString() };
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
  // Every figure below counts only the days this run actually fetched. A
  // resumed run reporting "GAP: 0" means "0 in the days I looked at," and on a
  // fully-resumed run that is 0 days — which reads like a clean bill of health
  // and is not one. TARS hit exactly that on 2026-09-10. Said out loud rather
  // than left for the reader to infer from a line further up.
  if (run.days_skipped_already_done > 0) {
    console.log('');
    if (run.days_processed === 0) {
      console.log('  *** NOTHING WAS EXAMINED THIS RUN. ***');
      console.log(`      All ${run.days_skipped_already_done} day(s) in this range were already recorded as done in`);
      console.log('      the state file above, so no calls were fetched and every total below is');
      console.log('      ZERO BECAUSE NOTHING WAS LOOKED AT — not because there is nothing to do.');
      console.log('      To re-examine the range, add --restart (safe: every write is an overwrite,');
      console.log('      never a duplicate) or point --state at a fresh path.');
    } else {
      console.log(`  NOTE: the totals below cover the ${run.days_processed} day(s) this run fetched. The other`);
      console.log(`        ${run.days_skipped_already_done} day(s) were skipped as already done and are not counted anywhere`);
      console.log('        below — including in the gap figures. Use --restart for a whole-range view.');
    }
  }
  console.log(`  Days with no calls at all     ${run.days_with_no_calls}`);
  console.log(`  Aircall calls fetched         ${run.calls_fetched}  (${run.pages_fetched} pages, ${total429s} rate-limit pauses)`);
  console.log('');
  console.log(`  call_stats rows              ${args.apply ? 'written' : 'that WOULD be written'}: ${run.call_stats_rows}`);
  console.log(`  call_stats_line_misses rows  ${args.apply ? 'written' : 'that WOULD be written'}: ${run.line_miss_rows}`);
  console.log('');
  // ── Charged to a person, and the part that only LOOKS charged ──────────
  // The two are printed together on purpose. "Charged to a person" is the
  // figure that moves a named employee's Answer Rate, and it is the smaller
  // of the two by a wide margin; the `agents_did_not_answer` column total is
  // the figure this report used to print under that label, and it is not the
  // same question. Showing one without the other is what made this report
  // overstate attribution by 220 over six months.
  const chargeableTotal = run.charged_to_person + run.not_charged_agents_did_not_answer;
  const otherReasons = run.line_misses_total - chargeableTotal;
  const nobodyTotal = run.line_misses_total - run.charged_to_person;
  const n = (v) => String(v).padStart(6);
  console.log(`  Line misses in Aircall for this range       ${n(run.line_misses_total)}`);
  console.log(`  Of those, CHARGED TO A PERSON              ${n(run.charged_to_person)}  (${pct(run.charged_to_person, run.line_misses_total)})`);
  console.log('      Lands on a named employee\'s scorecard: an agents_did_not_answer miss on an');
  console.log('      INBOUND row whose line rings exactly one person, and that person is a known');
  console.log('      Rincon user. Same gate the dashboard applies (lib/metrics.js).');
  console.log('');
  console.log(`  Charged to NOBODY                          ${n(nobodyTotal)}  (${pct(nobodyTotal, run.line_misses_total)})`);
  console.log(`      because of the MISS REASON             ${n(otherReasons)}`);
  console.log('          Not agents_did_not_answer at all — the lunchtime phone tree, the');
  console.log('          nine-second hang-up, after hours, abandoned in the IVR. Peter\'s rule:');
  console.log('          real misses, nobody\'s fault.');
  console.log('      agents_did_not_answer, on a row that');
  console.log(`      charges no individual                  ${n(run.not_charged_agents_did_not_answer)}`);
  console.log('          Somebody was available and it rang out — but no ONE person owns it:');
  for (const [cause, bucket] of Array.from(run.not_charged_by_cause.entries()).sort((a, b) => b[1].calls - a[1].calls)) {
    console.log(`              ${cause.padEnd(48)} ${String(bucket.calls).padStart(5)}`);
    console.log(`                  ${Array.from(bucket.lines).join(', ')}`);
  }
  console.log('');
  console.log(`  For reference — agents_did_not_answer summed across EVERY row: ${chargeableTotal}`);
  console.log('      *** THAT TOTAL IS NOT THE NUMBER THAT LANDS ON PEOPLE, and this report');
  console.log('      printed it under "charged to a person" until 2026-09-10. *** It counts');
  console.log('      rows that charge nobody, so it overstated attribution — on the very');
  console.log(`      report this decision is made from — by ${run.not_charged_agents_did_not_answer}. The figure that reaches a`);
  console.log(`      named employee is ${run.charged_to_person}.`);
  console.log('');
  console.log(`  Voicemails left                            ${n(run.voicemails_left)}  (${pct(run.voicemails_left, run.line_misses_total)} of misses)`);
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

  // ── Held back by the line ownership history ────────────────────────────
  // Printed whether or not anything was held back, and ZERO is a real result
  // worth seeing: if this says 0 over a range covering Apr–Aug 2026, the rule
  // is not firing and Aldo Hernandez's calls are about to be charged to Leo
  // O'Gorman. A section that only appears when it has something to say cannot
  // tell "nothing to hold back" from "the rule silently stopped matching."
  console.log('\n  ── Held back by the line ownership history ──');
  if (run.ownership_excluded_rows === 0) {
    console.log('  Nothing was held back in the days this run examined.');
    console.log('  Expected ONLY if the range contains no day on which a line was worked by');
    console.log('  somebody other than whoever rings it today. Over Apr–Aug 2026 it is NOT');
    console.log('  expected — check lib/line-ownership-history.js before running with --apply.');
  } else {
    console.log(`  Rows with attribution held back    ${run.ownership_excluded_rows}`);
    console.log(`  Calls on those rows                ${run.ownership_excluded_calls}`);
    console.log('  These calls are STORED and STAY VISIBLE, fully measured — miss reasons and');
    console.log('  voicemails included. Only the attribution is withheld: they are charged to');
    console.log('  NOBODY instead of to whoever rings the line today.');
    for (const p of run.ownership_excluded_periods.values()) {
      const period = p.from ? `from ${p.from}` : `before ${p.before_earliest_from}`;
      console.log(`\n      ${p.line_name}  (${period})`);
      console.log(`          worked by      ${p.worked_by || '(nobody individually — see the file)'}`);
      console.log(`          calls held     ${p.calls}  (${p.inbound_calls} inbound, ${p.outbound_calls} outbound, ${p.missed_calls} missed)`);
      console.log(`          rows / days    ${p.rows} row(s) across ${p.days} day(s)`);
    }
  }

  // ── Attributed BY NAME by the line ownership history ───────────────────
  // Printed on the same terms as the section above and for the same reason:
  // ZERO is a real result. If this says 0 over a range covering Mar–Sep 2026,
  // the naming rule is not firing and Leo O'Gorman's six months are about to
  // read as a flattering 99.8% again — which is the number this section
  // exists to stop Peter approving by accident.
  console.log('\n  ── Attributed BY NAME by the line ownership history ──');
  if (run.ownership_named_rows === 0) {
    console.log('  No closed period named anybody in the days this run examined.');
    console.log('  Expected ONLY if the range contains no day inside a named closed period.');
    console.log('  Over Mar–Sep 2026 it is NOT expected — check lib/line-ownership-history.js');
    console.log('  before running with --apply.');
  } else {
    console.log(`  Rows charged by name               ${run.ownership_named_rows}`);
    console.log(`  Calls on those rows                ${run.ownership_named_calls}`);
    console.log('  These rows are stamped sole_user_email + ring_user_count = 1 and are');
    console.log('  ATTRIBUTABLE exactly like any other sole-user row — the name comes from the');
    console.log('  file rather than from Aircall\'s ring membership, and from nowhere else.');
    for (const p of run.ownership_named_periods.values()) {
      console.log(`\n      ${p.line_name}  (from ${p.from})`);
      console.log(`          charged to     ${p.attributed_to}`);
      console.log(`          worked by      ${p.worked_by}`);
      console.log(`          calls charged  ${p.calls}  (${p.inbound_calls} inbound, ${p.outbound_calls} outbound, ${p.missed_calls} missed)`);
      console.log(`          rows / days    ${p.rows} row(s) across ${p.days} day(s)`);
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
  console.log('  From the call records themselves — stable per-call fields:');
  console.log('      duration, answered_at, missed_call_reason, voicemail. These do appear not');
  console.log('      to change after the fact.');
  console.log('  NOT immutable — WHICH CALLS ARE ON THE ROW AT ALL:');
  console.log('      Aircall strips the `user` field from every call a person handled when their');
  console.log('      seat is deleted, which MOVES their history out of call_stats and into');
  console.log('      call_stats_line_misses. A backfilled row is NOT the row the nightly sync');
  console.log('      would have written that night for any line worked by somebody who has since');
  console.log('      left — the counts themselves differ. Held-back periods are listed above.');
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
