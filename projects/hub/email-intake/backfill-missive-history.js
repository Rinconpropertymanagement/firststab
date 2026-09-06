#!/usr/bin/env node
/**
 * backfill-missive-history.js
 *
 * One-time (but safely re-runnable / resumable) historical backfill for the
 * Missive shared-inbox connector (router.js, lib/missive-connector.js,
 * lib/shared.js — committed 2026-09-05, commit 0aec66d, already
 * governance-approved and live-tested). That connector's own route
 * (POST /api/email-intake/internal/sync-missive) is built for small,
 * frequent, ongoing checks — every 15 minutes, bounded to 10 pages / 500
 * conversations per mailbox per run, and it stops the moment it reaches its
 * stored watermark. This script does the opposite: it pages ALL THE WAY
 * BACK to the true beginning of each allowlisted mailbox's history,
 * ignoring that watermark entirely, however long that takes.
 *
 * Real measured scope (2026-09-05, live-checked against the real Missive
 * account): Faria's history goes back to Feb 2025 (~1,884 conversations);
 * Solimar's goes back to May 2024 (~17,370 conversations). Combined
 * ~19,254 conversations, an estimated ~47,000 messages, ~68,000 total
 * Missive API requests. At the pacing this script uses (see PACING below,
 * intentionally under Missive's ~60 req/min sustainable rate), that's
 * roughly a 19-24 hour job — a genuinely multi-hour, unattended run, which
 * is exactly why this is a standalone script and NOT an HTTP route: no web
 * server should hold a request open for that long. See "HOW TO LAUNCH THIS
 * FOR REAL" at the bottom of this header for how Peter actually starts it.
 *
 * ============================================================
 * REUSE, NOT DUPLICATION — WHAT THIS SCRIPT DOES AND DOES NOT REIMPLEMENT
 * ============================================================
 * Per this build's explicit instruction, nothing governance-relevant is
 * copy-pasted from router.js. Reused as-is, imported from
 * ./lib/shared.js (moved there, out of router.js, as part of this same
 * build — see that file's own header):
 *   - MISSIVE_ALLOWED_TEAM_IDS / assertAllowedTeam — the same fail-closed
 *     allowlist check, called at the same point (immediately before every
 *     message-body fetch) as router.js's syncConversationMessages.
 *   - storeMessage — the exact same verbatim-write / per-message audit-log
 *     row / body_text-derivation sequence. A message this script stores and
 *     a message the incremental job stores go through byte-identical code.
 *   - htmlToPlainText, missiveTimestampToMillis/ISO, getSyncState/
 *     upsertSyncState, getExistingMessageIds, writeAuditLog.
 * Reused as-is from ./lib/missive-connector.js: listArchiveConversationsPage
 * (team_all-scoped — NOT the same function/scope router.js's incremental
 * sync uses), listConversationMessagesPage, getMessage — including this build's new
 * 429-retry-with-backoff logic inside missiveGet(), which now benefits
 * BOTH this script and the incremental route (see that file's header note
 * #5).
 *
 * What is genuinely NEW here, not shared, and why it can't be: the
 * PAGINATION CONTROL FLOW. router.js's syncMailbox/syncConversationMessages
 * are built to STOP (bounded page counts, watermark comparison that breaks
 * the loop early) — this script's whole purpose is the opposite (page to
 * the true natural end, ignore any stop condition), so forcing one function
 * to do both would make it worse at both jobs, not simpler. Two purpose-
 * built loops, sharing every governance-relevant primitive underneath, is
 * the actual "don't duplicate" outcome here — not one loop trying to serve
 * two incompatible pagination policies.
 *
 * One deliberate scope difference from the incremental job, beyond what
 * the task specified: this script's per-conversation MESSAGE pagination is
 * also unbounded (loops until Missive returns fewer than 10 messages — its
 * documented hard page-size max for that endpoint), where router.js caps a
 * single conversation at 5 pages / 50 messages
 * (MAX_MESSAGE_PAGES_PER_CONVERSATION). A true "page to the beginning of
 * history" backfill that silently dropped any message past a conversation's
 * 50 most recent would be a real, silent gap for any thread with a longer
 * back-and-forth than that (an ongoing PM/vendor/tenant thread easily
 * exceeds 50 messages over a year-plus of history) — so this script does
 * not carry that particular bound forward. Flagged explicitly since it's an
 * inference beyond the letter of the build task, not something copied from
 * an explicit instruction.
 *
 * ============================================================
 * PROGRESS STATE — A SEPARATE CHECKPOINT, NEVER THE ONGOING SYNC'S OWN
 * ============================================================
 * This script NEVER reads or writes a 'team:<id>' row in missive_sync_state
 * — that key belongs exclusively to the 15-minute incremental job (not yet
 * scheduled by Scotty; see router.js's own header) and tracks a completely
 * different thing (the NEWEST conversation seen, i.e. "where to stop").
 * This script uses its own, distinctly-prefixed key per mailbox:
 *   'backfill:team:b56138a6-f464-43db-a861-9bd79b07c8df'   (Faria)
 *   'backfill:team:ab0d3661-fb4c-498c-a311-94c6978530d6'   (Solimar)
 * — same table (missive_sync_state), same columns, DIFFERENT MEANING:
 * last_synced_conversation_id / last_synced_activity_at here track the
 * OLDEST conversation this backfill has reached so far — i.e. exactly the
 * `until` cursor to resume paging BACKWARD from, the opposite direction
 * from what those same column names mean under a 'team:<id>' key. No CHECK
 * constraint on missive_sync_state.mailbox_key exists (confirmed in the
 * schema migration, 20260905020000, "WHAT THIS MIGRATION DELIBERATELY DOES
 * NOT BUILD") — this table has always been documented-convention-only, not
 * enforced, so a second, clearly-distinguished key namespace for the exact
 * same two already-approved teams does not require a schema change.
 *
 * IMPORTANT — this 'backfill:' prefix applies ONLY to missive_sync_state,
 * NEVER to missive_message_intake.mailbox_key. Every message this script
 * stores is written with the PLAIN 'team:<id>' mailbox_key — the exact same
 * value the incremental job uses — via storeMessage(). Two reasons this
 * matters, worked through explicitly (not assumed):
 *   1. missive_message_intake.mailbox_key is the SCOPE LOCK value the
 *      schema migration names outright ('team:b56...', 'team:ab0d...'). A
 *      backfilled message is still, factually, a message that belongs to
 *      Faria or Solimar's real Team Inbox — giving it a different
 *      mailbox_key value than the same message would get from the
 *      incremental job would be a self-inflicted inconsistency on the
 *      table Asimov's review scrutinized hardest, for no real benefit.
 *   2. Idempotency: storeMessage() upserts on missive_message_id (globally
 *      unique per Missive message, regardless of who fetched it). If this
 *      backfill stores a message today under 'team:<id>' and the
 *      incremental job independently re-fetches that same message after
 *      Scotty eventually schedules it, the upsert recognizes it as the
 *      same row and is a safe no-op. If this script instead wrote
 *      'backfill:team:<id>' into missive_message_intake, that guarantee
 *      would still technically hold (upsert key is missive_message_id, not
 *      mailbox_key) but the row's own mailbox_key would then silently
 *      disagree with what a fresh incremental-job upsert would have
 *      written for the same row — never actually happens (upsert doesn't
 *      touch columns outside the payload... actually it DOES overwrite
 *      mailbox_key on conflict, since it's in the upsert payload — so the
 *      LATER of the two runs to touch a given message would silently
 *      overwrite the row's mailbox_key, flipping between conventions
 *      depending on run order). Using the same plain key from both jobs
 *      removes this failure mode entirely rather than relying on it never
 *      mattering in practice.
 *
 * ============================================================
 * RESUMABILITY — TRACED THROUGH, NOT ASSUMED
 * ============================================================
 * Claim: safe to stop (Ctrl+C, SSH drop, server restart, anything) at any
 * point and restart with `node backfill-missive-history.js` and pick up
 * from close to where it left off, without reprocessing everything from
 * scratch. Traced through below rather than assumed:
 *
 * 1. The checkpoint (missive_sync_state, 'backfill:team:<id>' row) is
 *    written after EVERY conversation finishes processing (its messages
 *    fully paged and stored) — not once per page (50 conversations) and
 *    not once at the very end. So the worst-case reprocessing window after
 *    a crash is exactly ONE conversation: whichever one was in flight the
 *    moment the process died.
 * 2. Re-processing that one conversation is SAFE, not just tolerable:
 *    storeMessage() upserts on missive_message_id (UNIQUE, schema's own
 *    idempotency key) — any message from that conversation already
 *    committed before the crash is written again with identical values, a
 *    real no-op. Any message not yet committed gets stored for the first
 *    time, correctly. Nothing double-counts in missive_message_intake
 *    either way.
 * 3. Restart reads the SAME 'backfill:team:<id>' row via getSyncState(),
 *    gets back last_synced_activity_at from before the crash, and uses it
 *    as the very first `until` value passed to listConversationsPage() —
 *    the identical resume point a mid-run page transition would have used
 *    (the code path is literally the same: "start the next page's `until`
 *    from the oldest activity_at reached so far" — a restart is just that
 *    same step happening to occur across a process boundary instead of a
 *    loop iteration).
 * 4. A mailbox that reached its true natural end (a conversations page
 *    returning fewer than 50 results) gets last_run_status set to
 *    'complete'. On any later run of this script, a mailbox already marked
 *    'complete' is skipped outright (logged, not silently) — so re-running
 *    this script after the real backfill has actually finished does NOT
 *    re-walk 19,254 conversations to confirm there's nothing new; it just
 *    reports "already complete" and exits for that mailbox. (If Peter ever
 *    deliberately wants to re-run a completed mailbox — e.g. suspected data
 *    loss — deleting or hand-editing that one row in missive_sync_state is
 *    the escape hatch; not built as a flag, since this is a one-time
 *    backfill, not a tool meant to invite casual re-runs.)
 * 5. --dry-run never writes the checkpoint (or anything else) — so running
 *    it for testing, then running for real, starts the real run from
 *    scratch (null `until`, exactly as if dry-run never happened) rather
 *    than from wherever the dry-run's in-memory counters got to.
 * Net effect: interrupting this script at hour 14 of ~20 and restarting
 * loses, at most, the one conversation being processed at that moment —
 * not 14 hours of work.
 *
 * ============================================================
 * RESUME CURSOR FORMAT — A REAL, FLAGGED RISK (found while tracing through
 * RESUMABILITY above, not assumed away)
 * ============================================================
 * The `until` value used for the FIRST Missive API call after a resume
 * comes from missive_sync_state.last_synced_activity_at — a TIMESTAMPTZ
 * column, so whatever this script writes there, Postgres/PostgREST always
 * hands back as an ISO-8601 string on read. Every OTHER `until` value this
 * script (and router.js's own incremental job) ever sends to Missive comes
 * straight from Missive's own immediately-prior response, in whatever
 * shape Missive itself used — zero conversion, zero risk. Only the very
 * first page of a resumed run is different: it sends a DB-round-tripped,
 * ISO-normalized value where Missive itself might natively use Unix
 * seconds instead. Whether Missive's API actually accepts ISO-8601 for
 * `until` is NOT confirmed anywhere in this codebase — it's the same open
 * question flagged in missive-connector.js's own header (note #3/#4) and
 * router.js's missiveTimestampToMillis comment, just newly consequential
 * here because, unlike the incremental job, this script actually needs to
 * hand a persisted cursor back to Missive to resume pagination across a
 * process boundary — not merely compare it locally.
 *
 * RESOLVED 2026-09-06: confirmed live against the real Missive API. Neither
 * of the two directions below is what actually happens — Missive rejects
 * an ISO-8601 `until` outright with 400 Bad Request (a real resumed run hit
 * this on its very first live test). The correct format is Unix EPOCH
 * SECONDS as a plain number (confirmed live: seconds worked, milliseconds
 * still 400'd) — which is exactly what `last_activity_at` already looks
 * like in every Missive response body, i.e. every OTHER `until` value in
 * this script was already correct; only the DB round-trip was wrong. Fixed
 * below by converting the stored ISO-8601 value back to Unix seconds
 * before it's used as `until` (see the `until =` assignment just below).
 * The two-failure-direction analysis is kept here for the record, since it
 * shaped the SUSPICIOUS-empty-page safeguard further down, which stays in
 * place as a general safety net even though its original trigger (a wrong
 * cursor format) is now fixed.
 *
 * Two distinct failure directions if the format assumption is wrong:
 *   - Missive ignores/can't parse the cursor and returns from the newest
 *     conversation again: WASTEFUL (re-walks already-done history) but
 *     SAFE — storeMessage()'s upsert-on-missive_message_id and this
 *     script's own getExistingMessageIds() check make reprocessing
 *     idempotent, never duplicative.
 *   - Missive parses the cursor as a comparison that matches nothing and
 *     returns an empty page: DANGEROUS if trusted — it would look
 *     identical to "reached the true beginning of history" and mark the
 *     mailbox 'complete', which this script then SKIPS on every future
 *     run. That would silently, permanently under-collect a mailbox's
 *     history with no error anywhere.
 * Mitigation actually implemented (see backfillMailbox below): an
 * immediately-empty result is trusted as the true natural end ONLY when it
 * did NOT come from a resumed run's very first page. When it DOES, this
 * script logs a loud "SUSPICIOUS" warning, does NOT mark the mailbox
 * complete, and leaves the checkpoint exactly as it was so the next run
 * (or a human checking Missive's own UI for that mailbox's actual oldest
 * conversation date) can resolve it. This trades a small amount of "might
 * report done a little late" for eliminating "might silently think it's
 * done when it isn't" — the safer direction to err in for a one-time
 * historical record. FLAGGED FOR REAL-DATA VERIFICATION, same as the
 * pre-existing timestamp-shape questions this build inherited: if Peter
 * runs this for real and a resume ever produces the SUSPICIOUS log line,
 * that is the confirmation this assumption needs — not a bug report.
 *
 * ============================================================
 * PACING AND RETRY — PARAMETERS AND REASONING
 * ============================================================
 * Missive's documented cap is 900 requests / 15 minutes = 60 req/min
 * sustained. Two separate mechanisms here, deliberately different:
 *   - REQUEST_DELAY_MS (this file, below) = 1100ms after every Missive API
 *     call this script makes (conversation-list page, message-list page,
 *     each message body fetch) — PROACTIVE pacing, ~54.5 req/min, about
 *     10% under the documented ceiling. Chosen over racing right up to
 *     60/min for three reasons: (1) real-world timing jitter and Missive's
 *     own window-accounting could tip an aggressive 60/min average into
 *     occasional 429s anyway, trading a small, predictable slowdown now for
 *     avoiding a much less predictable stall-and-retry cycle later; (2)
 *     this job runs unattended for ~a day — a few extra hours of wall-clock
 *     time costs nothing real, where a long chain of 429 backoffs (worst
 *     case ~2 minutes per hit, see below) actively costs progress-
 *     visibility clarity and just looks like the job is stuck; (3) if
 *     Scotty ever does schedule the 15-minute incremental job while this
 *     backfill is still running, both share Missive's ONE account-wide
 *     rate-limit budget — this script deliberately does not try to consume
 *     its "fair share" up to the exact ceiling, leaving headroom for the
 *     other job to succeed on its normal schedule without this script being
 *     the reason it gets throttled. (Genuine cross-process rate-limit
 *     coordination between the two jobs is NOT built here — no scheduler
 *     references the incremental route yet per its own header, so there is
 *     no live second consumer today; if that changes later, both jobs still
 *     degrade safely via missiveGet()'s own retry-with-backoff rather than
 *     failing outright, just possibly slower than either alone.) Net: an
 *     estimated ~68,000 requests at ~54.5/min is ~20.8 hours — close to,
 *     but deliberately a bit longer than, the ~19-hour figure a bare
 *     60/min pace would imply.
 *   - MAX_429_RETRIES / backoff — lives in lib/missive-connector.js's
 *     missiveGet() now (shared with the incremental job), REACTIVE: only
 *     engages if a 429 happens anyway despite the pacing above. 6 retries,
 *     honoring the server's Retry-After header when present, else
 *     exponential backoff (2s, 4s, 8s, 16s, 32s, 60s-capped), ~2 minutes
 *     worst-case before a single request finally gives up. See that file's
 *     own comment for the full reasoning on why retry belongs in the
 *     shared client rather than a backfill-only wrapper.
 *
 * ============================================================
 * SAFETY PROPERTIES UNCHANGED FROM THE ORIGINAL CONNECTOR
 * ============================================================
 *   - assertAllowedTeam() checked immediately before every message-body
 *     fetch, fail-closed, same as router.js.
 *   - body_html committed before body_text derivation, same as router.js
 *     (via the same storeMessage() call).
 *   - One audit_log row per message stored (action:
 *     'missive_message_intake.stored'), exact same action/actor/details
 *     shape as the incremental job, via the same storeMessage() call. This
 *     script ALSO writes its own per-mailbox summary audit_log row
 *     (action: 'email_intake.missive_backfill_run') when a mailbox's run
 *     ends (complete, or stopped by an error/limit) — counts only, same
 *     Rule 1 convention as router.js's runMissiveSync() summary row, via
 *     the same writeAuditLog() helper.
 *   - Never logs a Missive response body, on success or error (see
 *     missive-connector.js header note #2) — this script's own error logs
 *     print status/path/message text only, same discipline.
 *   - No hookup to AI extraction or the Fair-Housing filter. No crontab
 *     entry. Both explicitly out of scope per the build task; neither
 *     exists anywhere in this file.
 *   - Same two hardcoded MISSIVE_ALLOWED_TEAM_IDS, imported from
 *     lib/shared.js — this file cannot add a third mailbox without editing
 *     that shared constant, which is exactly the friction Asimov's finding
 *     wants for any scope expansion.
 *
 * Usage:
 *   node backfill-missive-history.js                        Backfill both allowlisted mailboxes, all the way to the true beginning of each one's history. Real run: ~19-24 hours, ~68,000 Missive requests. Safe to stop and re-run — see RESUMABILITY above.
 *   node backfill-missive-history.js --dry-run               Pull and process real data from the real Missive API and log what would be stored, per conversation — no Supabase writes (no messages, no checkpoint, no audit rows).
 *   node backfill-missive-history.js --max-conversations 5    Process at most 5 conversations per mailbox, then stop (does NOT mark a mailbox complete) — a fast, bounded smoke test. Combine with --dry-run for a fully side-effect-free test.
 *   node backfill-missive-history.js --help                   Show this help and exit.
 *
 * Standalone script (`node backfill-missive-history.js`), same house
 * convention as maintenance-history/backfill-maintenance-snapshot.js and
 * maintenance-history/backfill-latchel-property-id.js — NOT an HTTP
 * endpoint. Deliberately not registered in server.js or any router.
 *
 * ============================================================
 * HOW TO LAUNCH THIS FOR REAL (a ~19-24 hour unattended run)
 * ============================================================
 * This script does not daemonize itself — same as every other backfill
 * script in this codebase, launching it as a long-lived background process
 * is an operational step Peter takes over SSH, not something the script
 * does to itself. Two equivalent options:
 *
 *   nohup node backfill-missive-history.js > missive-backfill.log 2>&1 &
 *   tail -f missive-backfill.log        # or: pm2 logs, if run under pm2 instead
 *
 *   pm2 start backfill-missive-history.js --name missive-backfill --no-autorestart
 *   pm2 logs missive-backfill
 *   # when it finishes (or Peter wants to stop it): pm2 delete missive-backfill
 *
 * --no-autorestart matters under pm2: this is a one-time job that finishes
 * on its own (or is deliberately stopped) — it should NOT be restarted
 * automatically forever the way the Hub's own web server process is.
 * Nothing above is wired into any crontab or process manager config by this
 * build — Peter decides if/when to actually run this, per the build task.
 */

// Same .env resolution convention as server.js and the other backfill
// scripts in this repo: a local .env next to this file first, else the
// shared project-root .env. THREE candidate depths, checked in order —
// not just one — because the local dev checkout and Sally's deployed copy
// are different depths: locally this file lives at
// projects/hub/email-intake/ (repo root .env is three levels up); on
// Sally it's deployed flat at /var/www/hub/email-intake/ (the equivalent
// shared .env is only ONE level up, at /var/www/hub/.env). Found live
// 2026-09-06, before ever running for real on Sally: the old single
// three-levels-up path resolves, on Sally's flatter layout, to /var/.env —
// a real, unrelated file (appfolio-sync's credentials, which happens to
// sit at that exact resolved path — see its own header comment for why).
// Since that file exists, the old code would have silently loaded IT
// instead of failing over to the correct one — not silent data corruption
// (MISSIVE_API_TOKEN just isn't in that file, so apiToken() still throws
// loudly), but a wasted unattended run that dies in its first second
// instead of running for ~19 hours. Fixed by trying local, then
// one-level-up (Sally's actual layout), then three-levels-up (local dev's
// actual layout), using the first that exists.
{
  const path = require('path');
  const fs = require('fs');
  const candidates = [
    path.join(__dirname, '.env'),
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '..', '..', '.env'),
  ];
  const envPath = candidates.find((p) => fs.existsSync(p)) || candidates[candidates.length - 1];
  require('dotenv').config({ path: envPath });
}

const crypto = require('crypto');

const missive = require('./lib/missive-connector');
const {
  MISSIVE_ALLOWED_TEAM_IDS,
  assertAllowedTeam,
  missiveTimestampToISO,
  missiveTimestampToMillis,
  getSyncState,
  upsertSyncState,
  getExistingMessageIds,
  writeAuditLog,
  storeMessage,
} = require('./lib/shared');

const MAILBOX_LABELS = {
  'b56138a6-f464-43db-a861-9bd79b07c8df': 'Faria',
  'ab0d3661-fb4c-498c-a311-94c6978530d6': 'Solimar',
};

// Reference counts only, measured live 2026-09-05 — used exclusively to
// print a rough "% done" / ETA in progress logs (see createProgressLogger
// below). The REAL stop condition is always "a conversations page returned
// fewer than 50 results" (the natural end), never this number — new mail
// arrives in both inboxes daily, so the real total by the time this
// actually runs will be a bit higher than what's below, and that's fine;
// this is a progress-display convenience, not a target.
const ESTIMATED_TOTAL_CONVERSATIONS = {
  'b56138a6-f464-43db-a861-9bd79b07c8df': 1884, // Faria, back to Feb 2025
  'ab0d3661-fb4c-498c-a311-94c6978530d6': 17370, // Solimar, back to May 2024
};

// ─── Pacing — see file header "PACING AND RETRY" for the full reasoning. ──
const REQUEST_DELAY_MS = 1100; // ~54.5 req/min, ~10% under Missive's ~60/min sustainable cap

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ts() {
  return new Date().toISOString();
}

function printHelp() {
  console.log(`
backfill-missive-history.js — one-time historical backfill of the Missive
shared-inbox connector, paging all the way back to the true beginning of
each allowlisted mailbox's history (Faria, Solimar). Real run: an estimated
~19,254 conversations / ~47,000 messages / ~68,000 Missive API requests,
roughly 19-24 hours at this script's pacing. Safe to stop (Ctrl+C, SSH
drop, restart) and re-run — resumes from a per-mailbox checkpoint in
missive_sync_state ('backfill:team:<id>' rows), never the ongoing
15-minute sync's own watermark. See this file's own header for the full
design.

Flags:
  --dry-run                    Pull and process real data from the real
                                Missive API; log what would be stored. No
                                Supabase writes at all (no messages, no
                                checkpoint, no audit rows).
  --max-conversations <n>      Stop after at most <n> conversations per
                                mailbox (a bounded smoke test). Does NOT
                                mark a mailbox complete, so a later run
                                without this flag continues from there.
  --help                        Show this help and exit.

With no flags: runs for real, for as long as it takes, against both
allowlisted mailboxes, until each reaches the true end of its history.
`.trim());
}

function parseArgs(argv) {
  const args = { dryRun: false, maxConversations: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--max-conversations') args.maxConversations = Number(argv[++i]);
  }
  return args;
}

// ─── Progress visibility (build task item 6) ─────────────────────────────
// Logs every PROGRESS_LOG_EVERY_N_CONVERSATIONS conversations OR every
// PROGRESS_LOG_EVERY_MS, whichever comes first — so `pm2 logs` /
// `tail -f` shows real movement within minutes, not just at the very end
// of an ~20-hour run.
const PROGRESS_LOG_EVERY_N_CONVERSATIONS = 100;
const PROGRESS_LOG_EVERY_MS = 5 * 60 * 1000; // 5 minutes

// Shared by the console progress logger below AND every new
// missive_backfill.* audit row that reports "how far back has this
// mailbox's walk reached" (checkpoint/completed/stopped_early) — one
// implementation so the value logged to the console and the value written
// to audit_log are always identical, never two independently-derived
// approximations of the same thing. Returns null (not the string 'unknown')
// when there's nothing to report yet, since these values also land in a
// structured JSONB audit column, not just a console line.
function oldestDateReachedFrom(conv) {
  return conv && conv.last_activity_at ? missiveTimestampToISO(conv.last_activity_at) : null;
}

function createProgressLogger(label, estimatedTotal) {
  const runStart = Date.now();
  let lastLogAt = runStart;
  let lastLogCount = 0;

  // Returns { due: false } when this call didn't hit a logging interval, or
  // { due: true, currentDate } when it did — callers (the checkpoint audit
  // write below) key off `due` so a batch-level audit row is written at
  // exactly the same cadence as the existing console progress line, not a
  // second, independently-tracked interval.
  return function maybeLog(conversationsThisRun, messagesThisRun, latestConv) {
    const now = Date.now();
    const dueByCount = conversationsThisRun - lastLogCount >= PROGRESS_LOG_EVERY_N_CONVERSATIONS;
    const dueByTime = now - lastLogAt >= PROGRESS_LOG_EVERY_MS;
    if (!dueByCount && !dueByTime && conversationsThisRun > 0) return { due: false };

    lastLogAt = now;
    lastLogCount = conversationsThisRun;

    const elapsedMin = (now - runStart) / 60000;
    const pace = elapsedMin > 0 ? conversationsThisRun / elapsedMin : 0; // conversations/min, this run
    const oldestDateReached = oldestDateReachedFrom(latestConv);

    let etaNote = '';
    if (estimatedTotal && pace > 0) {
      const remaining = Math.max(estimatedTotal - conversationsThisRun, 0);
      const etaMin = Math.round(remaining / pace);
      etaNote = ` | ~${etaMin} min remaining (rough estimate vs. a ${estimatedTotal}-conversation reference count measured 2026-09-05, not a hard target)`;
    }

    console.log(
      `[${ts()}] ${label}: ${conversationsThisRun} conversation(s) processed, ${messagesThisRun} message(s) stored, ` +
      `current date reached: ${oldestDateReached == null ? 'unknown' : oldestDateReached}, pace: ${pace.toFixed(1)} conversations/min${etaNote}`
    );

    return { due: true, currentDate: oldestDateReached };
  };
}

// ─── Per-conversation message walk — unbounded, unlike router.js's ───────
// (see file header for why message pagination is unbounded here). Reuses
// assertAllowedTeam/storeMessage/getExistingMessageIds from lib/shared.js —
// NOT copy-pasted. `contentMailboxKey` is always the PLAIN 'team:<id>'
// value (see file header "PROGRESS STATE" for why this must never be the
// 'backfill:'-prefixed key).
async function syncConversationMessagesBackfill({ contentMailboxKey, teamId, conversationId, dryRun }) {
  const existingIds = await getExistingMessageIds(conversationId);

  let stored = 0;
  let until = null;

  for (;;) {
    let messages;
    try {
      messages = await missive.listConversationMessagesPage({ conversationId, until });
    } finally {
      await sleep(REQUEST_DELAY_MS); // proactive pacing — after every Missive call, success or failure
    }
    if (!messages.length) break;

    for (const msg of messages) {
      if (existingIds.has(String(msg.id))) continue; // already stored — nothing new to fetch

      try {
        assertAllowedTeam(teamId, `message ${msg.id} in conversation ${conversationId}`);
      } catch (err) {
        console.error(`[email-intake-backfill] ${err.message}`);
        continue; // fail closed: skip this one message, don't abort the run
      }

      let full;
      try {
        full = await missive.getMessage(msg.id);
      } catch (err) {
        console.error(`[email-intake-backfill] Missive message fetch failed for message ${msg.id}:`, err.message);
        continue;
      } finally {
        await sleep(REQUEST_DELAY_MS);
      }

      if (dryRun) {
        stored++; // count only — no Supabase write in dry-run mode
        continue;
      }

      try {
        await storeMessage({ mailboxKey: contentMailboxKey, conversationId, message: full });
        stored++;
      } catch (err) {
        console.error(`[email-intake-backfill] Failed to store message ${msg.id} (conversation ${conversationId}):`, err.message);
      }
    }

    if (messages.length < 10) break; // last page for this conversation (Missive's documented hard max for this endpoint)
    until = messages[messages.length - 1].delivered_at;
  }

  return stored;
}

// Common error-recording path — used both when the initial checkpoint read
// fails and when the main pagination loop throws unrecoverably. Recording
// this the same way in both places (rather than only in one) is what makes
// EVERY failure mode of this mailbox's run show up as a real
// last_run_status='error' row and a real audit_log row — not just the ones
// that happen to occur inside the pagination loop's own try block. Skips
// all Supabase writes (checkpoint AND audit log) in --dry-run, matching
// this script's documented "zero Supabase writes in dry-run" guarantee.
async function recordMailboxFailure({ label, progressKey, dryRun, err, conversationsThisRun, messagesThisRun, priorErrors = 0, batchId }) {
  const totalErrors = priorErrors + 1; // every per-conversation error already counted, plus this fatal one
  console.error(`[${ts()}] ${label}: backfill stopped due to an unrecoverable error:`, err.message);
  if (!dryRun) {
    await upsertSyncState(progressKey, {
      last_run_at: new Date().toISOString(),
      last_run_status: 'error',
      last_error: err.message,
    }).catch((e2) => console.error(`[${ts()}] ${label}: failed to record error state:`, e2.message));

    await writeAuditLog({
      action: 'email_intake.missive_backfill_run',
      entity_type: 'email_intake_backfill_run',
      entity_id: crypto.randomUUID(),
      actor_id: 'email-intake-missive-backfill',
      privacy_category: 'collection',
      risk_level: 'low',
      details: { mailbox_key: progressKey, conversations_seen: conversationsThisRun, messages_stored: messagesThisRun, errors: totalErrors, status: 'error', dry_run: dryRun },
    });

    // Distinct batch-level event, on top of (not instead of) the pre-existing
    // per-run summary row just above — Asimov's backfill-specific governance
    // follow-up: a person reconstructing this batch's history needs a
    // 'failed' action distinguishable from 'completed'/'stopped_early', all
    // three sharing one batch_id. Never a raw stack trace or response body —
    // err.message only, same discipline as every other error log in this
    // file. Non-fatal like every audit write here: a failed audit write is
    // never a reason to hide that the actual backfill run failed.
    try {
      await writeAuditLog({
        action: 'missive_backfill.failed',
        entity_type: 'missive_backfill_batch',
        entity_id: batchId,
        actor_id: 'email-intake-missive-backfill',
        privacy_category: 'collection',
        risk_level: 'medium',
        details: {
          batch_id: batchId,
          mailbox_key: progressKey,
          error_message: err.message,
          conversations_processed_before_failure: conversationsThisRun,
        },
      });
    } catch (auditErr) {
      console.error(`[${ts()}] ${label}: failed to write missive_backfill.failed audit row (batch ${batchId}):`, auditErr.message);
    }
  }
  return { label, conversationsThisRun, messagesThisRun, errors: totalErrors, status: 'error' };
}

// ─── Per-mailbox backfill — pages to the true natural end, ignoring any ──
// ongoing-sync watermark. See file header "RESUMABILITY" for the exact
// checkpoint-per-conversation guarantee this loop provides.
async function backfillMailbox(teamId, { dryRun, maxConversations, batchId }) {
  assertAllowedTeam(teamId, `backfill mailbox team:${teamId}`); // structurally always true here (teamId always comes from MISSIVE_ALLOWED_TEAM_IDS) — defense-in-depth, same reasoning as router.js's own call site
  const label = MAILBOX_LABELS[teamId] || teamId;
  const progressKey = `backfill:team:${teamId}`; // THIS backfill's own checkpoint — never the ongoing sync's 'team:<id>' key
  const contentMailboxKey = `team:${teamId}`; // what actually gets written to missive_message_intake — same convention the incremental job uses
  const mailboxRunStart = Date.now(); // for this mailbox's wall_clock_seconds in the new completed/stopped_early audit rows
  const retryCountAtMailboxStart = missive.getRetryCount(); // snapshot — mailboxes run sequentially (see main()), so a diff against this gives THIS mailbox's 429 retries, not the whole batch's

  // Reading the checkpoint is inside its own try/catch (not left to throw
  // uncaught out of this function) for the exact reason router.js's own
  // syncMailbox gives for wrapping its getSyncState call: a failure here
  // (transient connection error, etc.) should still produce a real
  // last_run_status='error' + audit row, not just an unstructured
  // "unexpected failure" line from main()'s last-resort catch with nothing
  // persisted.
  let state;
  try {
    state = await getSyncState(progressKey);
  } catch (err) {
    return recordMailboxFailure({ label, progressKey, dryRun, err, conversationsThisRun: 0, messagesThisRun: 0, batchId });
  }

  if (state && state.last_run_status === 'complete') {
    console.log(`[${ts()}] ${label}: already marked complete (finished ${state.last_run_at}) — skipping. This mailbox's backfill has nothing left to do.`);
    return { label, conversationsThisRun: 0, messagesThisRun: 0, errors: 0, status: 'already_complete' };
  }

  // Convert the DB's ISO-8601 value back to Unix seconds — Missive's
  // `until` param rejects ISO-8601 with 400 Bad Request (see "RESUME
  // CURSOR FORMAT" above). Every other `until` in this script comes
  // straight from Missive's own response and is already in this format.
  let until = state && state.last_synced_activity_at
    ? Math.floor(missiveTimestampToMillis(state.last_synced_activity_at) / 1000)
    : null;
  const isResumedRun = until != null; // see file header "RESUME CURSOR FORMAT" for why this matters
  if (until) {
    console.log(`[${ts()}] ${label}: resuming from checkpoint '${progressKey}' — oldest conversation reached so far: ${state.last_synced_conversation_id} @ ${state.last_synced_activity_at} (until=${until}).`);
  } else {
    console.log(`[${ts()}] ${label}: starting fresh — no prior backfill checkpoint found for '${progressKey}'.`);
  }

  const logProgress = createProgressLogger(label, ESTIMATED_TOTAL_CONVERSATIONS[teamId]);

  let conversationsThisRun = 0;
  let messagesThisRun = 0;
  let errors = 0;
  let naturalEndReached = false;
  let stoppedForLimit = false;
  let suspiciousResumeEnd = false;
  let latestConv = null;
  let pageNumber = 0;

  try {
    outer:
    for (;;) {
      let conversations;
      try {
        // Archive-scoped (team_all), NOT listConversationsPage's team_inbox
        // (open-only) — confirmed live 2026-09-06 these return very
        // different result sets; this script's whole purpose is the full
        // archive. See lib/missive-connector.js's listArchiveConversationsPage
        // header for the live-verification details.
        conversations = await missive.listArchiveConversationsPage({ teamId, until });
      } finally {
        await sleep(REQUEST_DELAY_MS);
      }
      if (!conversations.length) {
        // See file header "RESUME CURSOR FORMAT — A REAL, FLAGGED RISK": the
        // `until` value on a resumed run's FIRST page came from the
        // database (always ISO-8601, since last_synced_activity_at is a
        // TIMESTAMPTZ column), not from Missive's own immediately-prior
        // response the way every other `until` value in this script is —
        // and whether Missive's API actually accepts that shape for `until`
        // is still an open, unconfirmed question elsewhere in this
        // codebase (missive-connector.js header note #3/#4). An immediately
        // -empty result right here is genuinely ambiguous: it could mean
        // "this mailbox's history is now fully covered," or it could mean
        // "Missive silently didn't match anything against a cursor shape it
        // doesn't recognize." Getting this wrong in the optimistic
        // direction would PERMANENTLY under-collect history (a mailbox
        // marked 'complete' is skipped on every future run) — so refuse to
        // treat this specific case as proof of completion. Every other
        // empty/short-page result in this script came from an `until` this
        // SAME run derived directly from Missive's own prior response
        // (zero format ambiguity, identical to how router.js's already-
        // live-tested incremental job works) and is trusted normally.
        if (pageNumber === 0 && isResumedRun) {
          suspiciousResumeEnd = true;
          console.error(
            `[${ts()}] ${label}: SUSPICIOUS — the first page fetched after resuming returned ZERO conversations ` +
            `immediately. This could mean the mailbox's history is now fully covered, OR that Missive did not ` +
            `recognize the resumed 'until' cursor's format. NOT marking this mailbox complete on this signal alone — ` +
            `will retry from the same checkpoint (${until}) on the next run. Recommend confirming manually (e.g. ` +
            `check Missive's own UI for this mailbox's oldest conversation date) before assuming this mailbox is ` +
            `actually done.`
          );
        } else {
          naturalEndReached = true;
        }
        break;
      }
      pageNumber++;

      for (const conv of conversations) {
        if (maxConversations != null && conversationsThisRun >= maxConversations) {
          stoppedForLimit = true;
          break outer;
        }

        conversationsThisRun++;
        latestConv = conv;

        let stored = 0;
        try {
          stored = await syncConversationMessagesBackfill({ contentMailboxKey, teamId, conversationId: conv.id, dryRun });
        } catch (err) {
          console.error(`[${ts()}] ${label}: failed to sync conversation ${conv.id}:`, err.message);
          errors++;
          // Keep going — one bad conversation shouldn't abort the whole
          // mailbox's backfill (same isolation convention as router.js's
          // syncMailbox).
        }
        messagesThisRun += stored;

        // Checkpoint after EVERY conversation — see "RESUMABILITY" above
        // for why this granularity is what makes a crash lose at most one
        // conversation's worth of (safely re-doable) work.
        if (!dryRun) {
          try {
            await upsertSyncState(progressKey, {
              last_synced_conversation_id: String(conv.id),
              last_synced_activity_at: missiveTimestampToISO(conv.last_activity_at) || conv.last_activity_at,
              last_run_at: new Date().toISOString(),
              last_run_status: 'in_progress',
              last_error: null,
            });
          } catch (err) {
            console.error(`[${ts()}] ${label}: failed to record backfill checkpoint after conversation ${conv.id}:`, err.message);
            errors++;
            // Don't abort — worst case, a crash right after this loses one
            // extra conversation of resume progress than it otherwise
            // would; the conversation's own messages are already stored.
          }
        }

        const progressResult = logProgress(conversationsThisRun, messagesThisRun, latestConv);

        // Batch-level checkpoint audit row — Asimov's backfill-specific
        // governance follow-up: NOT one per conversation (excessive volume
        // on top of the existing per-message rows), but one at exactly the
        // same cadence as the console progress line above (every
        // PROGRESS_LOG_EVERY_N_CONVERSATIONS or PROGRESS_LOG_EVERY_MS,
        // whichever comes first — see createProgressLogger). Reuses the
        // counters this loop already tracks for that console line rather
        // than tracking anything new, except rate-limit retries, which
        // nothing in this script tracked before this addition — see
        // missive-connector.js's getRetryCount(). Skipped entirely in
        // --dry-run, matching this script's zero-Supabase-writes guarantee.
        if (!dryRun && progressResult.due) {
          try {
            await writeAuditLog({
              action: 'missive_backfill.checkpoint',
              entity_type: 'missive_backfill_batch',
              entity_id: batchId,
              actor_id: 'email-intake-missive-backfill',
              privacy_category: 'collection',
              risk_level: 'low',
              details: {
                batch_id: batchId,
                mailbox_key: progressKey,
                conversations_processed_so_far: conversationsThisRun,
                messages_stored_so_far: messagesThisRun,
                oldest_date_reached: progressResult.currentDate,
                rate_limit_retries_so_far: missive.getRetryCount() - retryCountAtMailboxStart,
              },
            });
          } catch (err) {
            console.error(`[${ts()}] ${label}: failed to write checkpoint audit row (batch ${batchId}):`, err.message);
            // Non-fatal — same reasoning as the checkpoint write to
            // missive_sync_state just above: a missed audit row doesn't
            // affect where this run actually resumes from, and the next
            // due checkpoint tries again.
          }
        }
      }

      if (conversations.length < 50) { naturalEndReached = true; break; } // natural end — Missive's documented page size
      until = conversations[conversations.length - 1].last_activity_at;
    }
  } catch (err) {
    return recordMailboxFailure({ label, progressKey, dryRun, err, conversationsThisRun, messagesThisRun, priorErrors: errors, batchId });
  }

  const status = naturalEndReached
    ? 'complete'
    : (stoppedForLimit ? 'partial_test_limit' : (suspiciousResumeEnd ? 'suspicious_resume_end' : 'partial'));

  if (naturalEndReached) {
    if (!dryRun) {
      await upsertSyncState(progressKey, {
        last_run_at: new Date().toISOString(),
        last_run_status: 'complete',
        last_error: null,
      });
    }
    console.log(`[${ts()}] ${label}: reached the true beginning of this mailbox's history — marked complete.${dryRun ? ' (DRY RUN — checkpoint not actually written)' : ''}`);
  } else if (stoppedForLimit) {
    console.log(`[${ts()}] ${label}: stopped after --max-conversations ${maxConversations} (testing limit) — NOT marked complete; a later run without the limit continues from here.`);
  } else if (suspiciousResumeEnd) {
    // Deliberately NOT marked complete — see the SUSPICIOUS log line above.
    // last_run_status stays whatever the last per-conversation checkpoint
    // write left it as ('in_progress'), so a plain re-run tries the exact
    // same resume point again rather than silently accepting an ambiguous
    // "done."
    console.log(`[${ts()}] ${label}: stopped due to a suspicious empty result on resume — see the warning above. Checkpoint left as-is for manual review or a retry.`);
  }

  if (!dryRun) {
    await writeAuditLog({
      action: 'email_intake.missive_backfill_run',
      entity_type: 'email_intake_backfill_run',
      entity_id: crypto.randomUUID(),
      actor_id: 'email-intake-missive-backfill',
      privacy_category: 'collection',
      risk_level: 'low',
      details: { mailbox_key: progressKey, conversations_seen: conversationsThisRun, messages_stored: messagesThisRun, errors, status, dry_run: dryRun },
    });

    // Distinct batch-level events, on top of (not instead of) the
    // steady-state per-run summary row just above — Asimov's backfill-
    // specific governance follow-up. 'completed' only for a true natural
    // end; the --max-conversations bounded-test-run case gets its OWN
    // action ('stopped_early'), specifically so a smoke test never looks
    // like a real completion (or a failure) in the audit trail. The
    // 'suspicious_resume_end' status is left to the pre-existing summary
    // row above only — not asked for as a distinct action here.
    const commonDetails = {
      batch_id: batchId,
      mailbox_key: progressKey,
      total_conversations: conversationsThisRun,
      total_messages: messagesThisRun,
      oldest_date_reached: oldestDateReachedFrom(latestConv),
      wall_clock_seconds: Math.round((Date.now() - mailboxRunStart) / 1000),
    };
    if (naturalEndReached) {
      try {
        await writeAuditLog({
          action: 'missive_backfill.completed',
          entity_type: 'missive_backfill_batch',
          entity_id: batchId,
          actor_id: 'email-intake-missive-backfill',
          privacy_category: 'collection',
          risk_level: 'low',
          details: commonDetails,
        });
      } catch (err) {
        console.error(`[${ts()}] ${label}: failed to write missive_backfill.completed audit row (batch ${batchId}):`, err.message);
      }
    } else if (stoppedForLimit) {
      try {
        await writeAuditLog({
          action: 'missive_backfill.stopped_early',
          entity_type: 'missive_backfill_batch',
          entity_id: batchId,
          actor_id: 'email-intake-missive-backfill',
          privacy_category: 'collection',
          risk_level: 'low',
          details: commonDetails,
        });
      } catch (err) {
        console.error(`[${ts()}] ${label}: failed to write missive_backfill.stopped_early audit row (batch ${batchId}):`, err.message);
      }
    }
  }

  return { label, conversationsThisRun, messagesThisRun, errors, status };
}

// ─── Graceful-enough shutdown — see "RESUMABILITY" above: nothing needs ──
// draining, since the checkpoint is already committed as of the last
// completed conversation. This exists purely so `pm2 logs` / an operator
// watching the terminal sees a clear, deliberate final line instead of the
// process just vanishing mid-line.
let shuttingDown = false;
function handleShutdownSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(
    `\n[${ts()}] Received ${signal} — stopping now. Progress is checkpointed per-conversation in ` +
    `missive_sync_state ('backfill:team:<id>' rows), so re-running ` +
    `\`node backfill-missive-history.js\` resumes from here — nothing to clean up first.`
  );
  process.exit(0);
}
process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));

// Last-resort safety nets for an unattended ~20-hour run. Every real
// operation above already has its own try/catch at the conversation/
// mailbox level, so reaching here means something genuinely unexpected —
// logged loudly, but deliberately NOT auto-killing the whole run over one
// unexpected rejection the way a short-lived request-handling process
// might; an operator checking `pm2 logs` hours later should see this
// clearly rather than the job having silently died at 2am over something
// that didn't actually corrupt any state (every write path above is either
// idempotent or already isolated in its own try/catch).
process.on('unhandledRejection', (reason) => {
  console.error(`[${ts()}] Unhandled promise rejection in Missive backfill:`, reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error(`[${ts()}] Uncaught exception in Missive backfill:`, err.message);
});

// ─────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.maxConversations != null && (!Number.isFinite(args.maxConversations) || args.maxConversations <= 0)) {
    console.error('Invalid --max-conversations value. Must be a positive number. See --help.');
    process.exit(1);
  }

  const missing = [];
  if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!process.env.MISSIVE_API_TOKEN) missing.push('MISSIVE_API_TOKEN');
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(', ')}. See .env.example.`);
    process.exit(1);
  }

  // One batch ID for the whole invocation — shared across BOTH mailboxes,
  // not generated per-mailbox — so every missive_backfill.* audit row this
  // run writes (started/checkpoint/completed/stopped_early/failed, across
  // Faria AND Solimar) can be correlated back into one reconstructible
  // "what did this specific run do, start to finish" trail. Per Asimov's
  // backfill-specific governance follow-up (see file header's own summary
  // of that requirement, and compliance/missive-connector-governance-
  // precheck.md for the original connector's review).
  const batchId = crypto.randomUUID();

  const startedAt = ts();
  console.log(`[${startedAt}] Missive historical backfill starting. Dry run: ${args.dryRun}.${args.maxConversations != null ? ` Max conversations per mailbox: ${args.maxConversations} (testing limit).` : ''} Batch ID: ${batchId}.`);
  console.log(`[${startedAt}] Pacing: ~${Math.round(60000 / REQUEST_DELAY_MS * 10) / 10} req/min (${REQUEST_DELAY_MS}ms between Missive requests). Mailboxes: ${MISSIVE_ALLOWED_TEAM_IDS.map((id) => MAILBOX_LABELS[id] || id).join(', ')}.`);

  // 'started' — one row, once, only for a real (non-dry-run) run. Dry runs
  // write ZERO audit rows of any kind, batch-level included (see file
  // header's dry-run guarantee, now extended to cover this whole new
  // audit-event family too).
  if (!args.dryRun) {
    try {
      await writeAuditLog({
        action: 'missive_backfill.started',
        entity_type: 'missive_backfill_batch',
        entity_id: batchId,
        actor_id: 'email-intake-missive-backfill',
        privacy_category: 'collection',
        risk_level: 'low',
        details: {
          batch_id: batchId,
          mailboxes: [...MISSIVE_ALLOWED_TEAM_IDS],
          dry_run: false,
          max_conversations: args.maxConversations,
        },
      });
    } catch (err) {
      console.error(`[${ts()}] Failed to write missive_backfill.started audit row (batch ${batchId}):`, err.message);
    }
  }

  const results = [];
  for (const teamId of MISSIVE_ALLOWED_TEAM_IDS) {
    try {
      const result = await backfillMailbox(teamId, { dryRun: args.dryRun, maxConversations: args.maxConversations, batchId });
      results.push(result);
    } catch (err) {
      // backfillMailbox is written to catch everything it can meaningfully
      // recover from — this is a last-resort net so one mailbox's
      // completely unexpected failure still lets the other mailbox run.
      console.error(`[${ts()}] Unexpected failure backfilling mailbox team:${teamId}:`, err.message);
      results.push({ label: MAILBOX_LABELS[teamId] || teamId, conversationsThisRun: 0, messagesThisRun: 0, errors: 1, status: 'error' });

      // This is the one failure path backfillMailbox itself can't record
      // (it never got the chance to) — still worth a 'failed' audit row
      // rather than leaving this genuinely-unexpected case with no batch-
      // level trail at all. conversations_processed_before_failure is
      // unknown here (this catch has no access to backfillMailbox's
      // internal counters), so it's recorded as null rather than guessed.
      if (!args.dryRun) {
        try {
          await writeAuditLog({
            action: 'missive_backfill.failed',
            entity_type: 'missive_backfill_batch',
            entity_id: batchId,
            actor_id: 'email-intake-missive-backfill',
            privacy_category: 'collection',
            risk_level: 'medium',
            details: {
              batch_id: batchId,
              mailbox_key: `backfill:team:${teamId}`,
              error_message: err.message,
              conversations_processed_before_failure: null,
            },
          });
        } catch (auditErr) {
          console.error(`[${ts()}] Failed to write missive_backfill.failed audit row for unexpected mailbox failure (batch ${batchId}):`, auditErr.message);
        }
      }
    }
  }

  const totals = results.reduce((acc, r) => ({
    conversations: acc.conversations + r.conversationsThisRun,
    messages: acc.messages + r.messagesThisRun,
    errors: acc.errors + r.errors,
  }), { conversations: 0, messages: 0, errors: 0 });

  console.log(`\n[${ts()}] Missive historical backfill run finished${args.dryRun ? ' (DRY RUN — nothing written)' : ''}:`);
  console.log(JSON.stringify({ started_at: startedAt, finished_at: ts(), dry_run: args.dryRun, max_conversations: args.maxConversations, results, totals }, null, 2));
}

main().catch((err) => {
  console.error(`[${ts()}] [missive-backfill] Fatal error:`, err.message);
  process.exit(1);
});
