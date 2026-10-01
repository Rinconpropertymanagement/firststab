/**
 * lib/significance-batch.js
 *
 * The Message Batches API ("bulk method") build for the archive-search
 * historical significance backfill — lib/significance-pass.js's own header
 * comment names this as separate, later, explicitly-deferred work ("PILOT /
 * PHASE 2"); this is that Phase 2 build. Read significance-pass.js's own
 * header first — this file exists ONLY to get a large volume of Call 1 (and,
 * later, Call 2) requests through Anthropic's asynchronous Batches API
 * instead of the synchronous per-conversation loop run-significance-
 * pilot.js already uses; every prompt, parser, and database write below is
 * borrowed from that file, unchanged, never re-derived here.
 *
 * OPERATIONAL WARNING: this module makes real, billed API calls to
 * Anthropic and writes real rows into archive_search_significance_batches /
 * archive_search_significance_batch_items (and, once results come back,
 * missive_conversation_significance / complaints). The actual "never from a
 * laptop, only from sally" warning lives on run-significance-batch.js (the
 * command this module is meant to be driven by) — same convention as
 * significance-pass.js itself carrying no such warning while run-
 * significance-pilot.js (its own CLI) carries it.
 *
 * ============================================================================
 * WHY THIS FILE, NOT A NEW SIGNIFICANCE-PASS.JS MODE
 * ============================================================================
 * significance-pass.js's synchronous loop (runCall1/runCall2) makes ONE
 * Anthropic call, waits for the HTTP response, and only then moves to the
 * next conversation — fine for a 100-200 conversation pilot, hopeless for
 * the ~250,487-conversation full historical archive (Peter's staged-by-
 * recency plan starts with a 1-year window, 84,408 conversations). The
 * Batches API instead accepts up to 100,000 requests in ONE call, processes
 * them asynchronously (up to 24 hours), and makes results downloadable for
 * 29 days afterward — all three of those numbers independently confirmed
 * against the installed SDK (@anthropic-ai/sdk 0.30.1) before this file was
 * written, not assumed from training-time memory:
 *   - Batches live at `anthropic.beta.messages.batches` in this SDK version
 *     (node_modules/@anthropic-ai/sdk/resources/beta/messages/batches.d.ts)
 *     — NOT a top-level `anthropic.messages.batches` (that only exists in
 *     newer SDK releases where Batches has graduated out of beta; 0.30.1 is
 *     what's actually installed here, confirmed via package.json).
 *   - .create({ requests: [{ custom_id, params }, ...] }) returns a
 *     BetaMessageBatch: { id, processing_status: 'in_progress'|'canceling'|
 *     'ended', request_counts: {processing,succeeded,errored,canceled,
 *     expired}, results_url, ended_at, ... }.
 *   - .retrieve(id) re-fetches that same shape — used to poll status.
 *   - .results(id) returns a Promise of an async-iterable JSONL decoder —
 *     each yielded item is { custom_id, result: { type: 'succeeded'|
 *     'errored'|'canceled'|'expired', message? , error? } }. Results are
 *     NOT guaranteed to arrive in request order — every lookup below keys
 *     on custom_id (this pipeline's own short "token"), never on position.
 *
 * Everything else (the actual database home for batch state, why a child
 * table not JSON, why tokens not real IDs, the one-unfinished-batch-per-
 * stage constraint) is Neo's migration — supabase/migrations/
 * 20260917020000_archive_search_significance_batch_tracking_schema.sql.
 * Read its header in full before changing anything below; this file's own
 * design decisions are direct consequences of that schema's own documented
 * reasoning, not independent choices.
 *
 * ============================================================================
 * WHAT THIS FILE DOES NOT DO (Q's own scope decisions — flagged, not silent)
 * ============================================================================
 *   1. UPDATED 2026-09-29: 'call_2' batches ARE now submittable/dispatchable/
 *      write-back-able — via the RUN-based flow only (startSubmissionRun/
 *      dispatchRunChunks/checkAndResumeRun, below), which is what run-
 *      significance-batch.js's own CLI actually drives. The original,
 *      LEGACY single-batch flow (submitBatch()/checkAndResume(), just below
 *      this header) was deliberately left call_1-only — it is dead code as
 *      far as the real CLI is concerned (confirmed by reading run-
 *      significance-batch.js: it calls startSubmissionRun/dispatchRunChunks/
 *      checkAndResumeRun exclusively), so extending it to call_2 would have
 *      been unused surface area, not a real capability gap. Q's own call,
 *      flagged rather than silent: submitBatch()'s own stage guard (below)
 *      is UNCHANGED and still throws for anything but 'call_1'.
 *      Call 2's run-based dispatch draws its conversations from
 *      significance-pass.js's fetchIncompleteSignificanceRows() (the
 *      existing Call-1-done-but-Call-2-never-run backlog) and its prompt
 *      from buildCall2Prompt()'s richer inputs (category, resolution_status,
 *      why, discovery_context, silence context) — looked up from
 *      missive_conversation_significance at dispatch time, since the
 *      submission-run-items table itself only ever stores mailbox_key/
 *      missive_conversation_id (see fetchSignificanceRowsForPairs() and
 *      buildDispatchEntries()'s own call_2 branch, below). Write-back has
 *      its own dedicated path (applyOneCall2BatchItem()/writeBackCall2Batch(),
 *      below) built on significance-pass.js's applyCall2Fields() — extracted
 *      from runCall2Phase() there for the exact same "do not reimplement
 *      the database write" reason applyCall1Result() was extracted from
 *      processConversation() back on 2026-09-17 (see that file's own header
 *      comment on applyCall2Fields for the full story).
 *   2. Splitting one submission across MULTIPLE Anthropic batches is not
 *      implemented as true parallel submission — it can't be, structurally:
 *      the schema's own one-unfinished-batch-per-stage UNIQUE index (Neo's
 *      migration) means only ONE archive_search_significance_batches row
 *      can be unfinished per stage at any moment, so two concurrent
 *      Anthropic batches for the same stage could never both have a row.
 *      "Build it generically" (the spec's own words) is satisfied instead
 *      by capping every single submission at MAX_BATCH_REQUESTS (Anthropic's
 *      real 100,000-request ceiling) regardless of how many conversations
 *      are eligible — if more than that are eligible, the remainder simply
 *      waits for this stage's NEXT submission (once the current batch
 *      reaches completed_at and frees the per-stage slot), a serial split
 *      across separate tool invocations, not a concurrent one. At the
 *      1-year window's real 84,408 eligible conversations this never even
 *      triggers — one submission covers the whole window in one batch.
 *
 * ============================================================================
 * ADDED 2026-09-18 — RUNS AND SIZE-AWARE CHUNKING (the real-incident fix)
 * ============================================================================
 * Tonight, submitBatch()'s single real 84,408-request .create() call was
 * REJECTED by Anthropic with a real 413 ("request_too_large ... up to
 * 256MBs") — scope decision #2 above (cap by REQUEST COUNT alone, never by
 * byte size) was wrong: Anthropic's real limit is 100,000 requests OR 256MB,
 * WHICHEVER IS REACHED FIRST, and nothing before tonight ever checked the
 * byte side of that. Because submitBatch() writes nothing to the database
 * until AFTER a successful .create() call, the entire 8-hour
 * fetchNextEligibleConversations() scan that produced those 84,408
 * conversations was lost outright. Full incident narrative, design
 * reasoning, and the exact schema this fix relies on: Neo's migration —
 * supabase/migrations/20260918060000_archive_search_significance_batch_
 * chunking_and_resumability_schema.sql. Read that file's header in full
 * before changing anything below; everything here is a direct, literal
 * consequence of its own documented reasoning, not an independent choice.
 *
 * THE FIX, IN TWO PARTS:
 *   1. SIZE-AWARE CHUNKING — MAX_BATCH_BYTES (below) is Neo's recommended
 *      ~20% safety margin under Anthropic's real 256MB cap. Every request's
 *      real serialized size is measured with
 *      Buffer.byteLength(JSON.stringify(request), 'utf8') — see
 *      sizeOfRequestBytes() below — NEVER `.length`, which counts UTF-16
 *      code units, not bytes, and would silently under-count any non-ASCII
 *      character in real tenant/owner email text (Neo's own explicit
 *      warning). partitionIntoChunks() (pure, directly unit-tested with
 *      small numbers) cuts a new chunk the moment adding the next request
 *      would exceed EITHER MAX_BATCH_REQUESTS or MAX_BATCH_BYTES for the
 *      chunk being built, whichever triggers first.
 *   2. RESUMABILITY / RUNS — a SUBMISSION RUN (archive_search_significance_
 *      submission_runs/_run_items, Neo's new tables) durably persists the
 *      ENTIRE eligible list returned by ONE fetchNextEligibleConversations()
 *      call BEFORE any Anthropic call is ever made (startSubmissionRun()'s
 *      own "durability checkpoint," below) — so a crash, a rate limit, or an
 *      oversized outlier conversation can never again cost the expensive
 *      scan itself. dispatchRunChunks() then assigns already-persisted,
 *      still-undispatched rows (batch_id IS NULL) to chunks and submits each
 *      chunk as its own real Anthropic batch, safe to call repeatedly.
 *      fetchNextEligibleConversations() itself, and the existing single-
 *      batch checkAndResume()/writeBackBatch()/maybeMarkBatchCompleted()
 *      write-back/polling logic, are BOTH unchanged by this fix — see THE
 *      RUN MODEL in the migration's own header for exactly why calling that
 *      one function exactly once per run is the only new discipline this
 *      design needs from it, and checkAndResumeRun() below for how the
 *      per-batch logic is reused, unmodified, across every chunk of a run.
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const significancePass = require('./significance-pass');
// Whole-module reference, not destructured — same reason significancePass
// above is required this way: test/run-tests.js's own spyOn() (PART 18's
// header comment explains why) mutates a METHOD PROPERTY on an already-
// loaded module object, which only affects call sites that look the
// property up at call time (notify.sendMail(...)), never a destructured
// `const { sendMail } = require(...)` local that would keep pointing at
// the ORIGINAL function object forever.
const notify = require('../../lib/notify');

// `let`, not `const` — see _setSupabaseClientForTesting()'s own comment
// just below for why this needs to be reassignable in place, rather than
// tested via the require.cache-swap-and-refresh trick lib/significance-
// pass.js's own test suite already uses.
let supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

let anthropicClientOverrideForTesting = null;
function anthropicClient() {
  if (anthropicClientOverrideForTesting) return anthropicClientOverrideForTesting; // see _setAnthropicClientForTesting() below.
  const Anthropic = require('@anthropic-ai/sdk'); // lazy require — same reasoning significance-pass.js's own anthropicClient() already gives: don't fail at module-load time for a code path that never calls the model (e.g. a pure-function unit test).
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  return new Anthropic({ apiKey });
}

// ============================================================
// TEST-ONLY dependency-injection seam (both prefixed and documented as
// such — never called from any real code path in this file). Deliberately
// NOT the require.cache-swap-and-force-refresh trick test/run-tests.js
// already uses for lib/significance-pass.js: that trick relies on
// deleting a module's require.cache entry and re-requiring it fresh, which
// is only safe when NOTHING ELSE concurrently re-requires the SAME shared
// dependency mid-test-run. This file's own require('./significance-pass')
// is exactly such a shared dependency — proven, not assumed, while
// building this file's own test suite: forcing significance-batch.js to
// re-require fresh caused it to occasionally pick up a DIFFERENT, already-
// in-flight fake instance of significance-pass.js that a wholly unrelated,
// concurrently-running test (test/run-tests.js's own asyncTest bodies all
// run concurrently — see that file's own PART 18 header) had temporarily
// swapped in for ITS OWN purposes, since require.cache is global, shared,
// mutable state. A plain settable module-level reference sidesteps this
// entirely: this module is required exactly ONCE per process and never
// re-evaluated, so its own require('./significance-pass') reference stays
// stable and correct for the life of the process regardless of what any
// other test does to that shared module's OWN require.cache entry.
// ============================================================
function _setSupabaseClientForTesting(client) { supabase = client; }
function _setAnthropicClientForTesting(client) { anthropicClientOverrideForTesting = client; }

// Free text stamped into archive_search_significance_batches.submitted_by —
// same convention as significance-pass.js's own CONTENT_PASS_VERSION /
// complaint_tracking_config.set_by elsewhere in this schema.
const BATCH_TOOL_VERSION = 'archive-search-significance-batch-v1';

// Anthropic's own real, confirmed cap — see this file's header. A single
// .create() call can never exceed this many requests.
const MAX_BATCH_REQUESTS = 100000;

// Anthropic's real cap is 256MB per batch (re-verified live against
// platform.claude.com/docs while diagnosing tonight's incident, 2026-09-18 —
// not assumed). MAX_BATCH_BYTES is Neo's recommended ~20% safety margin
// under that real number (200MB, not 256MB) — a deliberate cushion, never
// the exact limit, the same margin-not-max-value discipline this file
// already applies nowhere else because nothing before tonight checked byte
// size at all. See sizeOfRequestBytes()/partitionIntoChunks() below for how
// this is actually enforced.
const MAX_BATCH_BYTES = 209715200;

// The real byte size of one request as Anthropic will actually receive it —
// Buffer.byteLength(...), NEVER JSON.stringify(request).length. .length
// counts UTF-16 CODE UNITS, not bytes: it silently under-counts any
// non-ASCII character (real tenant/owner email text routinely has one — a
// curly quote, an accented name, an emoji), which would make this pipeline
// UNDER-estimate exactly the kind of large, real-world request most likely
// to matter. Buffer.byteLength('utf8') is the real UTF-8 byte count
// Anthropic's own HTTP layer will measure the request against.
function sizeOfRequestBytes(request) {
  return Buffer.byteLength(JSON.stringify(request), 'utf8');
}

// How many archive_search_significance_batch_items rows go in one insert()
// call at submission time, and how many rows one write-back page-fetch pulls
// at a time — both cheap, arbitrary chunk sizes (not a real API or DB limit)
// chosen only to keep any single round-trip small at this table's real
// ~84,000-row-per-batch scale, same "keep any one query/insert bounded"
// instinct DRIVER_PAGE_SIZE already applies in significance-pass.js.
const ITEM_CHUNK_SIZE = 500;

// ============================================================
// generateToken / generateUniqueTokensForBatch — the custom_id every
// request in a batch actually gets. Never the real (mailbox_key,
// missive_conversation_id) pair — see the migration's own TOKENS note for
// why (two UUIDs blow past custom_id's 64-character ceiling). base64url
// output is a strict subset of custom_id's own ^[a-zA-Z0-9_-]{1,64}$ CHECK,
// so a malformed token can never even reach the database (both the CHECK
// itself and generateToken()'s own alphabet enforce the identical rule,
// belt-and-suspenders, not a single point of trust). 9 random bytes -> 12
// base64url characters — chosen short purely for readability in logs/DB
// browsing; 72 bits of randomness makes a collision inside one ~84,408-item
// batch astronomically unlikely, and generateUniqueTokensForBatch() below
// re-rolls on the rare collision anyway, so correctness never depends on
// chance alone.
// ============================================================
function generateToken() {
  return crypto.randomBytes(9).toString('base64url');
}

function generateUniqueTokensForBatch(count) {
  const tokens = [];
  const seen = new Set();
  while (tokens.length < count) {
    const token = generateToken();
    if (seen.has(token)) continue; // re-roll on collision — see this block's own header comment for how unlikely this branch is to ever actually run.
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

// Pure — splits an array into fixed-size chunks, preserving order. Used for
// both the submission-time item insert and needed nowhere else at this
// file's real scale (the write-back page-fetch below uses a keyset cursor
// instead, since its filter — written_back_at IS NULL — shrinks between
// pages and a plain OFFSET/chunk split would either skip or repeat rows).
function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

// ============================================================
// findUnfinishedBatch — the ONE query this whole tool's resume logic keys
// on. Matches the migration's own partial unique index exactly
// (completed_at IS NULL AND failed_at IS NULL) — this is the read-side of
// the same condition; the index itself is what actually prevents a second
// unfinished row from ever being inserted, this is just how the
// application asks "does one already exist" before trying.
// ============================================================
async function findUnfinishedBatch(stage) {
  const { data, error } = await supabase
    .from('archive_search_significance_batches')
    .select('*')
    .eq('stage', stage)
    .is('completed_at', null)
    .is('failed_at', null)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// ============================================================
// Builds the real Anthropic batch request array for a set of eligible
// (mailbox_key, missive_conversation_id) pairs — the Call 1 prompt for
// each, reusing buildConversationContext() (fetch messages + resolve
// address match + thread text — the exact same context processConversation()
// builds in the synchronous path) and buildCall1Prompt() (the exact same
// prompt text) verbatim. No AI call happens here — this only prepares what
// gets sent to Anthropic's batches.create().
//
// A pair whose messages have disappeared since fetchNextEligibleConversations
// found it is skipped (the same defensive "skipped_empty" case
// processConversation() already treats as a no-op elsewhere in this
// pipeline) — counted, never silently dropped without a trace.
// ============================================================
async function buildCall1BatchRequests(pairs) {
  const tokens = generateUniqueTokensForBatch(pairs.length);
  const requests = [];
  const items = [];
  let skipped = 0;

  for (let i = 0; i < pairs.length; i++) {
    const { mailbox_key, missive_conversation_id } = pairs[i];
    const context = await significancePass.buildConversationContext(mailbox_key, missive_conversation_id);
    if (!context) { skipped++; continue; }
    const { addressMatched, threadText } = context;
    const prompt = significancePass.buildCall1Prompt({ threadText, addressMatched });
    const token = tokens[i];
    requests.push({
      custom_id: token,
      params: {
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        output_config: { effort: 'medium' },
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      },
    });
    items.push({ token, mailbox_key, missive_conversation_id });
  }

  return { requests, items, skipped };
}

async function insertBatchItems(batchId, items) {
  const rows = items.map((it) => ({ batch_id: batchId, token: it.token, mailbox_key: it.mailbox_key, missive_conversation_id: it.missive_conversation_id }));
  for (const chunk of chunkArray(rows, ITEM_CHUNK_SIZE)) {
    const { error } = await supabase.from('archive_search_significance_batch_items').insert(chunk);
    if (error) throw error;
  }
}

// ============================================================
// submitBatch — step 1. Checks for an existing unfinished batch for this
// stage FIRST (never attempts a submission if one exists — this is a
// "check status" run instead, checkAndResume()'s job, below). If eligible-
// set fetch or the Anthropic create() call itself fails, this throws before
// any database row is written — nothing partial is ever left behind for
// that failure mode. The one real race this cannot fully close (Anthropic
// has already accepted and started billing the batch by the time the
// tracking-row insert could fail on the unique index) is handled explicitly
// below, not silently — see the catch block's own comment.
// ============================================================
async function submitBatch({ stage, sinceDate = null, limit = MAX_BATCH_REQUESTS }) {
  if (stage !== 'call_1') {
    throw new Error(`submitBatch: stage '${stage}' is not implemented yet — only 'call_1' submission is built (see this file's own header for why 'call_2' submission is real, separate, deliberate follow-on work).`);
  }

  const existing = await findUnfinishedBatch(stage);
  if (existing) return { submitted: false, reason: 'unfinished_batch_exists', batch: existing };

  const targetCount = Math.min(limit, MAX_BATCH_REQUESTS);
  const pairs = await significancePass.fetchNextEligibleConversations(targetCount, sinceDate);
  if (pairs.length === 0) return { submitted: false, reason: 'nothing_eligible', batch: null };

  const { requests, items, skipped } = await buildCall1BatchRequests(pairs);
  if (requests.length === 0) return { submitted: false, reason: 'nothing_eligible_after_skips', batch: null, skipped };

  const anthropic = anthropicClient();
  const response = await anthropic.beta.messages.batches.create({ requests }); // real, billed submission — everything above this line is read-only/local and safe to re-run.

  let batchRow;
  try {
    const { data, error } = await supabase
      .from('archive_search_significance_batches')
      .insert({
        stage,
        anthropic_batch_id: response.id,
        anthropic_status: response.processing_status,
        request_count_total: requests.length,
        submitted_by: BATCH_TOOL_VERSION,
        notes: sinceDate ? `sinceDate=${sinceDate}` : null,
      })
      .select()
      .single();
    if (error) throw error;
    batchRow = data;
  } catch (err) {
    if (err && err.code === '23505') {
      // The exact race the migration's own header names: another run
      // created an unfinished batch for this stage between the check above
      // and this insert. Anthropic has ALREADY accepted and started billing
      // real money for response.id — that real batch now has no local
      // tracking row. Treating the unique-violation itself as expected
      // (never re-thrown as a bug, per the spec's own instruction) does NOT
      // mean silently losing track of the now-orphaned batch id — it is
      // logged loudly here specifically so it can be reconciled by hand.
      console.error(`[significance-batch] URGENT: a real Anthropic batch (${response.id}, ${requests.length} requests) was just created but could not be recorded — another unfinished '${stage}' batch already exists. This real batch has NO local tracking row. Record its id manually and reconcile.`);
      const alreadyExisting = await findUnfinishedBatch(stage);
      return { submitted: false, reason: 'unfinished_batch_exists', batch: alreadyExisting, orphanedAnthropicBatchId: response.id };
    }
    throw err;
  }

  await insertBatchItems(batchRow.id, items);

  return { submitted: true, batch: batchRow, requestCount: requests.length, skipped };
}

// ============================================================
// checkAndResumeOneBatch — the real polling/results-streaming logic,
// extracted 2026-09-18 (unchanged behavior — a pure refactor, not a new
// design) so checkAndResumeRun() below can reuse it per-batch-row instead of
// re-deriving a batch via findUnfinishedBatch(stage). That matters now for a
// real, concrete reason: since 20260918060000's migration DROPPED the old
// one-unfinished-batch-per-stage unique index (multiple chunks of the same
// run are now meant to be concurrently unfinished — see that migration's own
// "PARALLEL CHUNKS" section), findUnfinishedBatch(stage)'s .maybeSingle()
// would throw once more than one unfinished batch for a stage really exists,
// which a multi-chunk run makes an ordinary, expected state, not a rare one.
// checkAndResume(stage) below (kept for backward compatibility/its own
// existing tests) still calls findUnfinishedBatch(stage) first, so it
// remains correct only for a stage with at most one unfinished batch — the
// legacy, pre-run shape. checkAndResumeRun() never goes through
// findUnfinishedBatch at all; it is handed each batch row directly.
// ============================================================
async function checkAndResumeOneBatch(batch) {
  const anthropic = anthropicClient();
  const remote = await anthropic.beta.messages.batches.retrieve(batch.anthropic_batch_id);

  const checkedAtIso = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from('archive_search_significance_batches')
    .update({ anthropic_status: remote.processing_status, last_checked_at: checkedAtIso })
    .eq('id', batch.id);
  if (updateErr) throw updateErr;

  const updatedBatch = { ...batch, anthropic_status: remote.processing_status, last_checked_at: checkedAtIso };
  const outcome = { batch: updatedBatch, remote, resultsJustRetrieved: false, statusCounts: null };

  if (remote.processing_status === 'ended' && !batch.results_retrieved_at) {
    const stream = await anthropic.beta.messages.batches.results(batch.anthropic_batch_id);
    const statusCounts = { succeeded: 0, errored: 0, canceled: 0, expired: 0 };

    // Drained and processed DISPATCH_CONCURRENCY items at a time (see that
    // constant's own comment) instead of one item at a time — each item
    // here is a single indexed Supabase update, the same lightweight
    // profile buildDispatchEntries() already runs at this concurrency, so
    // the same number is reused rather than re-derived. statusCounts is
    // tallied synchronously straight off each group as it's read from the
    // stream, BEFORE any of that group's database writes even start — so
    // the tally is entirely unaffected by which of a group's concurrent
    // writes happens to finish first, and matches what the old strictly
    // sequential loop would have counted regardless of order.
    for await (const group of drainInGroups(stream, DISPATCH_CONCURRENCY)) {
      for (const r of group) {
        statusCounts[r.result.type] = (statusCounts[r.result.type] || 0) + 1;
      }
      await mapWithConcurrency(group, DISPATCH_CONCURRENCY, async (r) => {
        const resultType = r.result.type;
        const errorDetail = resultType === 'succeeded' ? null : JSON.stringify(r.result.error || { type: resultType });
        const { error: itemErr } = await supabase
          .from('archive_search_significance_batch_items')
          .update({ result_status: resultType, error_detail: errorDetail })
          .eq('batch_id', batch.id)
          .eq('token', r.custom_id);
        if (itemErr) console.error(`[significance-batch] failed to record result status for token ${r.custom_id}:`, itemErr.message);
      });
    }
    outcome.statusCounts = statusCounts;

    const { count: pendingCount, error: countErr } = await supabase
      .from('archive_search_significance_batch_items')
      .select('id', { count: 'exact', head: true })
      .eq('batch_id', batch.id)
      .eq('result_status', 'pending');
    if (countErr) throw countErr;

    if ((pendingCount || 0) === 0) {
      const retrievedAtIso = new Date().toISOString();
      const { error: retrievedErr } = await supabase
        .from('archive_search_significance_batches')
        .update({ results_retrieved_at: retrievedAtIso })
        .eq('id', batch.id);
      if (retrievedErr) throw retrievedErr;
      outcome.resultsJustRetrieved = true;
      outcome.batch.results_retrieved_at = retrievedAtIso;
    } else {
      console.error(`[significance-batch] ${pendingCount} item(s) still 'pending' after streaming results for batch ${batch.anthropic_batch_id} — results_retrieved_at NOT set; re-run to retry.`);
    }
  }

  return outcome;
}

// ============================================================
// checkAndResume — step 2, legacy single-batch-per-stage entry point. Always
// updates anthropic_status/last_checked_at, whether or not the status
// actually changed (the migration's own documented reasoning: "did the
// resume script even check on this today" is its own useful signal). Only
// streams results (and only once — guarded by results_retrieved_at) once
// Anthropic itself reports 'ended'. Never loads the results stream into
// memory — each yielded item triggers one direct, indexed (batch_id, token)
// update and is then discarded. See checkAndResumeOneBatch()'s own comment
// above for why this is no longer the entry point run-significance-batch.js
// itself calls (checkAndResumeRun(), below, is).
// ============================================================
async function checkAndResume({ stage }) {
  const batch = await findUnfinishedBatch(stage);
  if (!batch) return { found: false, batch: null, remote: null };
  const outcome = await checkAndResumeOneBatch(batch);
  return { found: true, ...outcome };
}

// ============================================================
// fetchAllPendingWriteBackItems — the resume query, keyset-paginated
// (written_back_at IS NULL shrinks as write-back proceeds, so a plain id
// cursor makes forward progress on every page without skipping or
// repeating a row). Only ever pulls the small tracking columns (never the
// actual AI response content, which lives at Anthropic, not here) — up to
// ~84,000 rows of a few short columns each is a modest, safe amount to hold
// in memory at once; the thing this build must never buffer wholesale is
// Anthropic's OWN results stream (each conversation's actual message
// content), which writeBackBatch() below still processes one at a time.
// ============================================================
async function fetchAllPendingWriteBackItems(batchId) {
  const all = [];
  let lastId = null;
  for (;;) {
    let query = supabase
      .from('archive_search_significance_batch_items')
      .select('id, token, mailbox_key, missive_conversation_id, result_status')
      .eq('batch_id', batchId)
      .is('written_back_at', null)
      .order('id', { ascending: true })
      .limit(ITEM_CHUNK_SIZE);
    if (lastId !== null) query = query.gt('id', lastId);
    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    lastId = data[data.length - 1].id;
    if (data.length < ITEM_CHUNK_SIZE) break;
  }
  return all;
}

// ============================================================
// applyOneBatchItem — the actual write-back decision for ONE conversation.
// result.type !== 'succeeded' mirrors processConversation()'s own Call 1
// failure contract exactly (see significance-pass.js: "no row — stays
// eligible for the next run") — never invents new failure behavior for
// 'errored'/'canceled'/'expired'. A 'succeeded' result whose text doesn't
// actually parse (parseCall1Response returns null) is treated the same way
// — functionally identical to runCall1() exhausting its own in-process
// retries, except a batch request is one-shot: there is no retry to attempt
// here. This narrower case (spec didn't name it) is Q's own judgment call,
// flagged in the build report.
// @returns {Promise<'written'|'no_row_written'>}
// ============================================================
async function applyOneBatchItem({ item, result, discoveryContext, sharedDirectories }) {
  const { id: itemId, mailbox_key, missive_conversation_id } = item;
  const nowIso = new Date().toISOString();

  if (result.type !== 'succeeded') {
    const { error } = await supabase
      .from('archive_search_significance_batch_items')
      .update({ written_back_at: nowIso })
      .eq('id', itemId);
    if (error) throw error;
    return 'no_row_written';
  }

  const context = await significancePass.buildConversationContext(mailbox_key, missive_conversation_id);
  if (!context) {
    const { error } = await supabase
      .from('archive_search_significance_batch_items')
      .update({ written_back_at: nowIso, error_detail: 'Conversation messages no longer found at write-back time.' })
      .eq('id', itemId);
    if (error) throw error;
    return 'no_row_written';
  }

  const { rows, addressMatch, addressMatched, threadText } = context;
  const content = (result.message && result.message.content) || [];
  const textBlock = content.find((b) => b.type === 'text');
  const call1 = textBlock ? significancePass.parseCall1Response(textBlock.text, { addressMatched }) : null;

  if (!call1) {
    const { error } = await supabase
      .from('archive_search_significance_batch_items')
      .update({ written_back_at: nowIso, error_detail: 'Call 1 succeeded per Anthropic but the response body did not parse (no in-batch retry is possible).' })
      .eq('id', itemId);
    if (error) throw error;
    return 'no_row_written';
  }

  await significancePass.applyCall1Result({ mailbox_key, missive_conversation_id, discoveryContext, call1, rows, addressMatch, threadText, sharedDirectories });

  const { error } = await supabase
    .from('archive_search_significance_batch_items')
    .update({ written_back_at: nowIso })
    .eq('id', itemId);
  if (error) throw error;
  return 'written';
}

// ============================================================
// writeBackBatch — step 3. Loads the (small) set of still-pending items
// into memory ONCE, then makes exactly ONE pass over Anthropic's results
// stream, matching each yielded result against that in-memory set by
// custom_id and discarding it immediately after processing — never
// buffering the results stream itself. An item already written back by an
// earlier, interrupted run is simply absent from the pending set and is
// silently skipped when its result is streamed past — this IS the
// resumability contract, not an afterthought bolted on top of it.
// ============================================================
async function writeBackBatch({ batchId, anthropicBatchId, discoveryContext = 'historical_backfill' }) {
  const summary = { processed: 0, written_significance: 0, no_row_written: 0, errors: 0, unmatched: 0 };

  const pendingItems = await fetchAllPendingWriteBackItems(batchId);
  if (pendingItems.length === 0) return summary; // nothing pending — batch may already be fully written back (caller checks maybeMarkBatchCompleted()).

  const pendingMap = new Map(pendingItems.map((item) => [item.token, item]));
  const sharedDirectories = {
    properties: await significancePass.fetchPropertyDirectory(),
    vendors: await significancePass.fetchVendorDirectory(),
  };

  const anthropic = anthropicClient();
  const stream = await anthropic.beta.messages.batches.results(anthropicBatchId);

  // Drained and processed WRITEBACK_CONCURRENCY items at a time (see that
  // constant's own comment) instead of one at a time. Every summary counter
  // below is only ever touched by a single synchronous statement inside a
  // worker — JS async concurrency is cooperative on one thread, never truly
  // parallel, so two workers can never execute a statement at the exact
  // same instant — meaning processed/written_significance/no_row_written/
  // errors add up to the same totals regardless of completion order, same
  // as pendingMap.get/delete below never racing either. The per-item
  // try/catch (a single item's failure must never abort the batch) and the
  // "unrecognized/already-written-back token" skip are both preserved
  // exactly as they were in the old sequential loop, just moved inside the
  // per-item worker function.
  for await (const group of drainInGroups(stream, WRITEBACK_CONCURRENCY)) {
    await mapWithConcurrency(group, WRITEBACK_CONCURRENCY, async (r) => {
      const item = pendingMap.get(r.custom_id);
      if (!item) return; // already written back by an earlier run, or an unrecognized token — never reprocess.
      try {
        const outcome = await applyOneBatchItem({ item, result: r.result, discoveryContext, sharedDirectories });
        summary.processed++;
        if (outcome === 'written') summary.written_significance++;
        else summary.no_row_written++;
      } catch (err) {
        console.error(`[significance-batch] write-back failed for token ${r.custom_id} (${item.mailbox_key}/${item.missive_conversation_id}):`, err.message);
        summary.errors++;
      }
      pendingMap.delete(r.custom_id);
    });
  }

  summary.unmatched = pendingMap.size; // pending items that never appeared in the results stream at all — a genuine anomaly, surfaced rather than silently dropped.
  return summary;
}

// ============================================================
// maybeMarkBatchCompleted — the real "fully done" check the migration's own
// completed_at column comment describes: every child item has
// written_back_at set. Safe to call after every writeBackBatch() run,
// including one that processed zero items (a no-op count query either way).
// ============================================================
async function maybeMarkBatchCompleted(batchId) {
  const { count, error } = await supabase
    .from('archive_search_significance_batch_items')
    .select('id', { count: 'exact', head: true })
    .eq('batch_id', batchId)
    .is('written_back_at', null);
  if (error) throw error;
  if ((count || 0) > 0) return false;

  const { error: updateErr } = await supabase
    .from('archive_search_significance_batches')
    .update({ completed_at: new Date().toISOString() })
    .eq('id', batchId);
  if (updateErr) throw updateErr;
  return true;
}

// ============================================================
// applyOneCall2BatchItem — Call 2's write-back counterpart to
// applyOneBatchItem() above. Unlike Call 1's own write-back contract
// (result.type !== 'succeeded' -> write NOTHING, "stays eligible for the
// next run" — Call 1 requests are idempotent to simply retry), Call 2's
// fail-closed contract is different and is mirrored here exactly:
// runCall2Phase()'s own synchronous path (significance-pass.js) still
// writes a needs_human_call=true PLACEHOLDER (and can still create a
// complaint off of it) whenever the AI call itself fails or its response
// doesn't parse — "never no trace at all" (spec Section 5). So here, EVERY
// result — succeeded-and-parsed, succeeded-but-unparseable, errored,
// canceled, or expired — is turned into a call2Result ({ok:true,...} or
// {ok:false}) and run through the real, shared applyCall2Fields(); only the
// two failure modes that happen BEFORE there's even a call2Result to build
// (the significance row itself is gone, or the conversation's own messages
// are gone) skip straight to a bare written_back_at stamp with no
// significance-row write at all, same as applyOneBatchItem()'s own
// "conversation messages no longer found" branch.
//
// Looks up the item's existing missive_conversation_significance row
// (populated by Call 1, already stored, fetched via the shared
// fetchSignificanceRowsForPairs() batch lookup, once per writeBackCall2Batch
// call — see that function, below) for category/why/discovery_context/
// keyword-check flags — the submission-run-item/batch-item itself only
// ever stored mailbox_key/missive_conversation_id (see buildDispatchEntries'
// own call_2 branch, above, for the identical lookup need at dispatch
// time). Property/vendor resolution mirrors retryCall2ForExistingRow()'s
// own already-accepted, narrower, address-match-only scope (see that
// function's own header comment in significance-pass.js for why) — never
// Call 1's own content-extracted citation, which isn't available here
// either (only Call 1's OWN write path, at Call 1 write-back time, ever
// sees that citation).
// @returns {Promise<'written'|'no_row_written'>}
// ============================================================
async function applyOneCall2BatchItem({ item, result, significanceRowsByKey }) {
  const { id: itemId, mailbox_key, missive_conversation_id } = item;
  const nowIso = new Date().toISOString();

  const sigRow = significanceRowsByKey.get(`${mailbox_key}::${missive_conversation_id}`);
  if (!sigRow) {
    const { error } = await supabase
      .from('archive_search_significance_batch_items')
      .update({ written_back_at: nowIso, error_detail: 'No missive_conversation_significance row found for this conversation at write-back time (its Call 1 result may have been deleted).' })
      .eq('id', itemId);
    if (error) throw error;
    return 'no_row_written';
  }

  const context = await significancePass.buildConversationContext(mailbox_key, missive_conversation_id);
  if (!context) {
    const { error } = await supabase
      .from('archive_search_significance_batch_items')
      .update({ written_back_at: nowIso, error_detail: 'Conversation messages no longer found at write-back time.' })
      .eq('id', itemId);
    if (error) throw error;
    return 'no_row_written';
  }

  const { rows, addressMatch } = context;

  let call2Result;
  if (result.type === 'succeeded') {
    const content = (result.message && result.message.content) || [];
    const textBlock = content.find((b) => b.type === 'text');
    const parsed = textBlock ? significancePass.parseCall2Response(textBlock.text, { category: sigRow.category }) : null;
    call2Result = parsed ? { ok: true, value: parsed } : { ok: false }; // succeeded per Anthropic but unparseable — no in-batch retry is possible, same posture as applyOneBatchItem()'s own unparseable-Call-1 case, except Call 2's own contract (unlike Call 1's) still writes a fail-closed placeholder for this, via applyCall2Fields below.
  } else {
    call2Result = { ok: false }; // errored/canceled/expired — mirrors runCall2Phase()'s own AI-call-failure branch exactly.
  }

  await significancePass.applyCall2Fields({
    significanceId: sigRow.id,
    mailbox_key,
    missive_conversation_id,
    discoveryContext: sigRow.discovery_context,
    category: sigRow.category,
    why: sigRow.why,
    call2Result,
    rows,
    addressMatch,
    flaggedProtectedClass: sigRow.keyword_check_flagged_protected_class,
    flaggedCategory: sigRow.keyword_check_flagged_category,
    property_id: addressMatch.property_id || null,
    vendor_id: addressMatch.vendor_id || null,
  });

  const { error } = await supabase
    .from('archive_search_significance_batch_items')
    .update({ written_back_at: nowIso })
    .eq('id', itemId);
  if (error) throw error;
  return 'written';
}

// ============================================================
// writeBackCall2Batch — Call 2's write-back counterpart to writeBackBatch()
// above. Same shape and same resumability contract (load the small pending
// set once, stream Anthropic's results exactly once, drainInGroups/
// mapWithConcurrency at WRITEBACK_CONCURRENCY, per-item try/catch, an
// already-written-back or unrecognized token is silently skipped) — only
// the per-item write path differs (applyOneCall2BatchItem, above, instead
// of applyOneBatchItem), plus ONE Call-2-specific prefetch:
// missive_conversation_significance rows for every pending item, fetched
// ONCE via fetchSignificanceRowsForPairs() before the concurrent loop
// starts, mirroring writeBackBatch()'s own once-per-call sharedDirectories
// prefetch.
// ============================================================
async function writeBackCall2Batch({ batchId, anthropicBatchId }) {
  const summary = { processed: 0, written_significance: 0, no_row_written: 0, errors: 0, unmatched: 0 };

  const pendingItems = await fetchAllPendingWriteBackItems(batchId);
  if (pendingItems.length === 0) return summary; // nothing pending — batch may already be fully written back (caller checks maybeMarkBatchCompleted()).

  const pendingMap = new Map(pendingItems.map((item) => [item.token, item]));
  const significanceRowsByKey = await fetchSignificanceRowsForPairs(
    pendingItems,
    'id, mailbox_key, missive_conversation_id, category, why, discovery_context, keyword_check_flagged_protected_class, keyword_check_flagged_category'
  );

  const anthropic = anthropicClient();
  const stream = await anthropic.beta.messages.batches.results(anthropicBatchId);

  for await (const group of drainInGroups(stream, WRITEBACK_CONCURRENCY)) {
    await mapWithConcurrency(group, WRITEBACK_CONCURRENCY, async (r) => {
      const item = pendingMap.get(r.custom_id);
      if (!item) return; // already written back by an earlier run, or an unrecognized token — never reprocess.
      try {
        const outcome = await applyOneCall2BatchItem({ item, result: r.result, significanceRowsByKey });
        summary.processed++;
        if (outcome === 'written') summary.written_significance++;
        else summary.no_row_written++;
      } catch (err) {
        console.error(`[significance-batch] Call 2 write-back failed for token ${r.custom_id} (${item.mailbox_key}/${item.missive_conversation_id}):`, err.message);
        summary.errors++;
      }
      pendingMap.delete(r.custom_id);
    });
  }

  summary.unmatched = pendingMap.size;
  return summary;
}

// ============================================================
// computeCall2RunNotificationCounts — the three real, at-the-moment-it-
// fires counts sendCall2BatchCompletionNotification() (below) reports.
// Asimov's governance review, 2026-09-29: a live, one-at-a-time Call 2
// run today always has a human present watching it; a silent bulk
// backlog run has no equivalent, so this is the one new place a human
// actually finds out — and it must report real counts, never estimates.
//
//   - historicalReviewBacklogCount: total rows in
//     complaints_historical_review_required RIGHT NOW — Asimov's own
//     finding was that this view (spec Section 6's bounded, must-be-
//     affirmatively-cleared checklist) has zero application code
//     touching it anywhere today. Portfolio-wide, not scoped to this
//     run — the view's own definition (supabase/migrations/20260913020000_
//     archive_search_significance_complaint_merge_schema.sql) is not
//     run-specific, and Asimov's ask was "how many are sitting there,"
//     not "how many this run added."
//   - needsHumanCallCount / ownerInstructionRejectedCount: scoped to
//     THIS run's own conversations only — same reportNeedsCall2()
//     reasoning just above (never "every recent significance row," which
//     a concurrent live-pipeline trickle could leak into). Gathered via
//     every batch this run ever dispatched (batchIds, passed in by the
//     caller — see checkAndResumeRun below), not just the batch that
//     happened to complete last.
//   - needs_human_call/owner_instruction_rejected are read directly off
//     missive_conversation_significance (applyCall2Fields' own write
//     target) rather than off complaints: shouldCreateComplaint() in
//     significance-pass.js treats needs_human_call=true as an
//     unconditional trigger, so every such significance row always has
//     a companion complaints row with the same needs_human_call — this
//     is the same count either way, without the extra hop through
//     complaint_id.
// ============================================================
async function computeCall2RunNotificationCounts({ batchIds }) {
  const { count: historicalReviewBacklogCount, error: reviewErr } = await supabase
    .from('complaints_historical_review_required')
    .select('id', { count: 'exact', head: true });
  if (reviewErr) throw reviewErr;

  // Same "IN() on one column, filter the composite key in app code" pattern
  // reportNeedsCall2() above already uses — missive_conversation_id is only
  // unique WITHIN a mailbox.
  let items = [];
  for (const batchId of (batchIds || [])) {
    const { data, error } = await supabase
      .from('archive_search_significance_batch_items')
      .select('mailbox_key, missive_conversation_id')
      .eq('batch_id', batchId);
    if (error) throw error;
    items.push(...(data || []));
  }

  const ids = Array.from(new Set(items.map((i) => i.missive_conversation_id)));
  const itemKeys = new Set(items.map((i) => `${i.mailbox_key}::${i.missive_conversation_id}`));

  const rows = [];
  const LOOKUP_CHUNK = 200; // same chunk size reportNeedsCall2() already uses for this identical lookup shape.
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from('missive_conversation_significance')
      .select('mailbox_key, missive_conversation_id, needs_human_call, owner_instruction_rejected')
      .in('missive_conversation_id', ids.slice(i, i + LOOKUP_CHUNK));
    if (error) throw error;
    rows.push(...(data || []));
  }

  const matched = rows.filter((r) => itemKeys.has(`${r.mailbox_key}::${r.missive_conversation_id}`));

  return {
    historicalReviewBacklogCount: historicalReviewBacklogCount || 0,
    runConversationCount: ids.length,
    needsHumanCallCount: matched.filter((r) => r.needs_human_call === true).length,
    ownerInstructionRejectedCount: matched.filter((r) => r.owner_instruction_rejected === 'true').length,
  };
}

// ============================================================
// sendCall2BatchCompletionNotification — Asimov's one remaining condition
// before a call_2 backlog run can go live against real data (governance
// review, 2026-09-29): fired exactly once, at the moment a call_2 run
// transitions to fully processed (see checkAndResumeRun's own hook,
// below — this is NOT a new completion-detection mechanism, it reuses
// that existing transition point). Recipients and send mechanism
// deliberately match sendEscalationEmail() in router.js exactly (DO_EMAIL
// + PETER_EMAIL, both independently, via lib/notify.js's shared
// sendMail() over the Gmail API) — this codebase's own established
// pattern for "something happened that a human needs to know about,"
// not a new one invented for this build.
//
// Same defensive posture as every other non-critical side effect in this
// codebase: wrapped in try/catch, logged loudly with the shared
// [HUB-ALERT] prefix on any failure, and NEVER throws past this function
// — a broken mailer must never leave the run's own completion status
// (already durably written by the caller before this is invoked) in a
// bad state.
// ============================================================
async function sendCall2BatchCompletionNotification({ runId, batchIds }) {
  try {
    const counts = await computeCall2RunNotificationCounts({ batchIds });

    const recipients = [process.env.DO_EMAIL, process.env.PETER_EMAIL].filter(Boolean);
    if (!recipients.length) {
      console.error(`[HUB-ALERT] Call 2 batch completion notification not sent — DO_EMAIL and PETER_EMAIL are both unset. Run ${runId} finished: ${counts.needsHumanCallCount} of ${counts.runConversationCount} conversation(s) need a human call; ${counts.historicalReviewBacklogCount} complaint(s) currently sit in complaints_historical_review_required.`);
      return { ok: false, counts, error: 'no_recipient' };
    }

    const result = await notify.sendMail({
      to: recipients,
      subject: `Archive Search: historical complaint backlog run finished — ${counts.needsHumanCallCount} need a human call`,
      text: [
        'A Call 2 historical complaint backlog run has finished processing on the Rincon Hub.',
        '',
        `Run:                                    ${runId}`,
        `Conversations processed in this run:    ${counts.runConversationCount}`,
        `Flagged needs_human_call (this run):    ${counts.needsHumanCallCount}`,
        `Flagged owner_instruction_rejected (this run, informational): ${counts.ownerInstructionRejectedCount}`,
        '',
        `Complaints currently sitting in the historical review checklist (complaints_historical_review_required), portfolio-wide: ${counts.historicalReviewBacklogCount}`,
        'This checklist is not yet surfaced in any Hub dashboard — ask Q/Neo if you want a way to review and clear it from the UI.',
        '',
        'No AI system has made a final decision here — this email is so a human finds out a batch of historical complaints landed, the same way someone already would for today\'s live, one-at-a-time Call 2 flow. Log in to the Rincon Hub and open Complaint Tracking to review the flagged conversations.',
      ].join('\n'),
    });

    if (!result.ok) {
      const detail = result.error || `${result.rejected.length} of ${recipients.length} recipient(s) rejected: ${result.rejected.join(', ')}`;
      console.error(`[HUB-ALERT] Call 2 batch completion notification failed to send for run ${runId}: ${detail}`);
      return { ok: false, counts, error: detail };
    }

    console.log(`[significance-batch] Call 2 batch completion notification sent for run ${runId} to ${recipients.length} recipient(s).`);
    return { ok: true, counts };
  } catch (err) {
    // MUST NEVER throw past this function — see the header comment above.
    console.error(`[HUB-ALERT] Call 2 batch completion notification threw and was swallowed for run ${runId}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ============================================================
// reportNeedsCall2 — step 4. Only ever called after a 'call_1' stage batch
// reaches completed_at. Deliberately reports only — never submits a
// 'call_2' run itself (that is a separate, later, DELIBERATE invocation of
// startSubmissionRun({stage: 'call_2', ...}) — see this file's own header,
// "UPDATED 2026-09-29", for that path). Scoped to THIS batch's own conversations
// (via archive_search_significance_batch_items), not "every recent
// significance row" — a concurrent live-pipeline trickle elsewhere in this
// codebase could otherwise leak unrelated rows into the count.
// ============================================================
async function reportNeedsCall2({ batchId }) {
  const { data: items, error } = await supabase
    .from('archive_search_significance_batch_items')
    .select('mailbox_key, missive_conversation_id')
    .eq('batch_id', batchId);
  if (error) throw error;

  const ids = Array.from(new Set((items || []).map((i) => i.missive_conversation_id)));
  const itemKeys = new Set((items || []).map((i) => `${i.mailbox_key}::${i.missive_conversation_id}`));

  const rows = [];
  const LOOKUP_CHUNK = 200; // same "IN() on one column, filter the composite key in app code" pattern significance-pass.js's own filterAlreadyProcessed() already uses, for the identical reason (missive_conversation_id is only unique within a mailbox).
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const { data, error: fetchErr } = await supabase
      .from('missive_conversation_significance')
      .select('mailbox_key, missive_conversation_id, category, resolution_status')
      .in('missive_conversation_id', ids.slice(i, i + LOOKUP_CHUNK));
    if (fetchErr) throw fetchErr;
    rows.push(...(data || []));
  }

  const matched = rows.filter((r) => itemKeys.has(`${r.mailbox_key}::${r.missive_conversation_id}`));
  const needing = matched.filter((r) => significancePass.needsCall2({ category: r.category, resolution_status: r.resolution_status }));

  return {
    totalWithSignificanceRow: matched.length,
    needsCall2Count: needing.length,
    needsCall2List: needing.map((r) => ({ mailbox_key: r.mailbox_key, missive_conversation_id: r.missive_conversation_id })),
  };
}

// ============================================================================
// SUBMISSION RUNS — added 2026-09-18. See this file's own top-of-file
// "ADDED 2026-09-18" header section and Neo's migration (supabase/
// migrations/20260918060000_..._schema.sql) for the full incident/design
// story. Everything below this line is new; everything above is unchanged
// (submitBatch/checkAndResume/writeBackBatch/maybeMarkBatchCompleted/
// reportNeedsCall2 all stay exactly as they were, and are directly reused —
// never reimplemented — by the functions below).
// ============================================================================

// ============================================================
// findUnfinishedRun — the run-level replacement for findUnfinishedBatch(),
// matching archive_search_significance_submission_runs' own real, database-
// enforced guarantee: idx_archive_search_significance_submission_runs_
// one_active_per_stage (fully_processed_at IS NULL AND failed_at IS NULL).
// ============================================================
async function findUnfinishedRun(stage) {
  const { data, error } = await supabase
    .from('archive_search_significance_submission_runs')
    .select('*')
    .eq('stage', stage)
    .is('fully_processed_at', null)
    .is('failed_at', null)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function fetchRunById(runId) {
  const { data, error } = await supabase
    .from('archive_search_significance_submission_runs')
    .select('*')
    .eq('id', runId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// ============================================================
// startSubmissionRun — step 1 of the new flow. Checks for an already-active
// run for this stage FIRST (mirrors submitBatch()'s own existing
// findUnfinishedBatch() check — never starts a second run while one is
// active). If none exists, calls significancePass.fetchNextEligibleConversations()
// EXACTLY ONCE — the expensive, hours-long call this whole design exists to
// protect — then durably records its full result in two checkpointed steps
// BEFORE returning:
//   1. Insert the run row itself (stage/since_date/requested_count).
//   2. Bulk-insert EVERY returned pair into submission_run_items, in the
//      exact order fetchNextEligibleConversations() returned them
//      (sequence_in_run), chunked with the same ITEM_CHUNK_SIZE/chunkArray
//      pattern insertBatchItems() already uses.
//   3. Only once step 2 has fully succeeded: stamp assembled_at/
//      eligible_count together on the run row — THE durability checkpoint.
//      From this moment on, this run's eligible list can never be lost
//      again, regardless of what happens to dispatch/submission afterward.
//
// A crash between steps 1 and 2 finishing leaves a real, narrow, honestly-
// documented gap: the run row exists (so it still correctly holds the
// one-active-run-per-stage slot, and a retry will NOT re-call
// fetchNextEligibleConversations — the one thing this design must never do
// tw ice) but assembled_at stays NULL, so its item list may be incomplete.
// This is a real accepted risk, not a silently ignored one — see
// dispatchRunChunks()'s own guard on assembled_at below, and run-
// significance-batch.js's own handling of a not-yet-assembled run. It is a
// MUCH smaller, narrower window than tonight's incident: steps 1-2 are fast,
// local, already-in-memory bulk inserts (typically well under a second even
// at ~84,000 rows), not an hours-long scan — the actual expensive operation
// this whole redesign protects is fully durable the instant it returns.
// ============================================================
async function startSubmissionRun({ stage, sinceDate = null, limit } = {}) {
  if (stage !== 'call_1' && stage !== 'call_2') {
    throw new Error(`startSubmissionRun: stage '${stage}' is not implemented — only 'call_1' and 'call_2' submission are built.`);
  }

  const existing = await findUnfinishedRun(stage);
  if (existing) return { started: false, reason: 'unfinished_run_exists', run: existing };

  const requestedCount = Math.min(limit || MAX_BATCH_REQUESTS, MAX_BATCH_REQUESTS);

  // sinceDate is meaningless for call_2 (fetchIncompleteSignificanceRows
  // below takes no date parameter — it works off already-processed rows'
  // own call2_completed_at, not a message date window) — forced to null
  // both for the fetch below and for what gets durably recorded on the run
  // row, so a run's own record never implies a date filter that was never
  // actually applied, even if a caller passed one by mistake (e.g. a stale
  // --since-date left over from a call_1 run of the same CLI command).
  const effectiveSinceDate = stage === 'call_2' ? null : sinceDate;

  // THE expensive, hours-long call — exactly ONCE per run, ever. This
  // discipline (never call this a second time for the same run, and the
  // one-active-run-per-stage guard above ensuring no second run can start
  // while this one is still unresolved) is the ENTIRE no-double-submission
  // guarantee — see the migration's own "THE RUN MODEL" section. Call 2's
  // own eligible set (the ~27,000-conversation Call 1-done-but-Call-2-never-
  // run backlog) is comparatively cheap — a single indexed query against
  // missive_conversation_significance, not Call 1's own hours-long
  // screening-pipeline scan — but is still fetched exactly once here, for
  // the identical reason: the one-active-run-per-stage guard above is what
  // makes "exactly once" true, and that guarantee must not depend on which
  // stage's own fetch happens to be cheap or expensive.
  const pairs = stage === 'call_1'
    ? await significancePass.fetchNextEligibleConversations(requestedCount, effectiveSinceDate)
    : await significancePass.fetchIncompleteSignificanceRows(requestedCount);
  if (pairs.length === 0) return { started: false, reason: 'nothing_eligible', run: null };

  let runRow;
  try {
    const { data, error } = await supabase
      .from('archive_search_significance_submission_runs')
      .insert({
        stage,
        since_date: effectiveSinceDate,
        requested_count: requestedCount,
        submitted_by: BATCH_TOOL_VERSION,
        notes: effectiveSinceDate ? `sinceDate=${effectiveSinceDate}` : null,
      })
      .select()
      .single();
    if (error) throw error;
    runRow = data;
  } catch (err) {
    if (err && err.code === '23505') {
      // The same real, named race submitBatch()'s own catch block documents
      // for the old single-batch flow (see that function's own comment),
      // now scoped to a run instead of a stage-wide submission: another
      // process started a run for this stage between the check above and
      // this insert. Unlike submitBatch()'s race, no Anthropic call has
      // happened yet at this point in startSubmissionRun() — so nothing is
      // orphaned or billed here. The only real cost is that
      // fetchNextEligibleConversations() itself just ran redundantly
      // (wasted scan time, not wasted money) — logged loudly so that's
      // visible, never silently swallowed. In real operation, lib/
      // significance-lock.js's cross-process file lock (which wraps this
      // whole CLI run) already prevents two processes from ever reaching
      // this far concurrently — this handler is defense in depth, not the
      // primary guard.
      console.error(`[significance-batch] startSubmissionRun: another run for stage '${stage}' was created between this call's own check and its insert — this call's own fetchNextEligibleConversations() scan (${pairs.length} conversation(s)) ran redundantly, but nothing was lost or double-billed (no Anthropic call had happened yet). Returning the other, already-active run instead.`);
      const alreadyExisting = await findUnfinishedRun(stage);
      return { started: false, reason: 'unfinished_run_exists', run: alreadyExisting };
    }
    throw err;
  }

  // THE DURABILITY CHECKPOINT, part 1: persist the whole eligible list, in
  // its own returned order, before anything else touches Anthropic.
  const itemRows = pairs.map((pair, index) => ({
    run_id: runRow.id,
    sequence_in_run: index,
    mailbox_key: pair.mailbox_key,
    missive_conversation_id: pair.missive_conversation_id,
  }));
  for (const chunk of chunkArray(itemRows, ITEM_CHUNK_SIZE)) {
    const { error } = await supabase.from('archive_search_significance_submission_run_items').insert(chunk);
    if (error) throw error;
  }

  // THE DURABILITY CHECKPOINT, part 2: only once every row above has
  // actually landed. assembled_at/eligible_count are set together (the
  // migration's own lockstep CHECK) specifically so a partial failure
  // between the two checkpoints stays visible (assembled_at stays NULL)
  // rather than ever being silently reported as fully assembled.
  const assembledAtIso = new Date().toISOString();
  {
    const { data, error } = await supabase
      .from('archive_search_significance_submission_runs')
      .update({ assembled_at: assembledAtIso, eligible_count: pairs.length })
      .eq('id', runRow.id)
      .select()
      .single();
    if (error) throw error;
    runRow = data;
  }

  return { started: true, run: runRow, eligibleCount: pairs.length };
}

// ============================================================
// fetchUndispatchedRunItems — THE resume-dispatch query (run_id, batch_id IS
// NULL, ordered by sequence_in_run), keyset-paginated on sequence_in_run —
// UNIQUE(run_id, sequence_in_run) makes it a safe, gap-tolerant cursor
// (batch_id IS NULL shrinks the matching set as dispatch proceeds, exactly
// the same "the filter narrows as work completes" shape
// fetchAllPendingWriteBackItems() above already handles with its own
// written_back_at keyset cursor — same pattern, reused, not reinvented).
// ============================================================
async function fetchUndispatchedRunItems(runId) {
  const all = [];
  let lastSeq = null;
  for (;;) {
    let query = supabase
      .from('archive_search_significance_submission_run_items')
      .select('id, sequence_in_run, mailbox_key, missive_conversation_id')
      .eq('run_id', runId)
      .is('batch_id', null)
      .order('sequence_in_run', { ascending: true })
      .limit(ITEM_CHUNK_SIZE);
    if (lastSeq !== null) query = query.gt('sequence_in_run', lastSeq);
    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    lastSeq = data[data.length - 1].sequence_in_run;
    if (data.length < ITEM_CHUNK_SIZE) break;
  }
  return all;
}

// Resume-safe chunk numbering: pick up after the highest chunk_number
// already dispatched for this run, so a re-run of dispatchRunChunks() after
// an earlier partial run never reuses a chunk_number
// (idx_archive_search_significance_batches_run_chunk's own UNIQUE(run_id,
// chunk_number) would reject a reused one anyway — this is the read-side
// half of not even attempting to).
async function fetchNextChunkNumberForRun(runId) {
  const { data, error } = await supabase
    .from('archive_search_significance_batches')
    .select('chunk_number')
    .eq('run_id', runId)
    .order('chunk_number', { ascending: false })
    .limit(1);
  if (error) throw error;
  if (!data || data.length === 0) return 0;
  return (data[0].chunk_number == null ? -1 : data[0].chunk_number) + 1;
}

// How many buildConversationContext() calls run concurrently inside
// buildDispatchEntries() (below) — added 2026-09-19 after real timing
// evidence (407ms-4053ms per conversation, ~1.77s average, timed directly
// against 5 real items from a live run on sally) showed the previous plain
// sequential `for...of` loop would take ~40+ real hours over the full
// 84,408-conversation historical run. buildConversationContext() is
// I/O-bound (thread-message fetch, then up to 3 sequential address-lookup
// queries per participant via matchParticipantsToRecords/findUniqueMatch —
// all Supabase round-trips, no meaningful CPU work), so real concurrency
// gives a large, close-to-linear speedup up to whatever the real Supabase
// connection/rate-limit ceiling turns out to be.
//
// 15 is a conservative starting point, not a measured ceiling: at 15
// concurrent conversations, each itself issuing up to ~4 sequential
// Supabase round-trips (1 message fetch + up to 3 address lookups), at most
// ~15 requests are ever in flight to Supabase's PostgREST API at once
// (never 15 x 4 — each worker's own calls are still sequential, only the
// workers themselves run in parallel) — comfortably inside normal HTTP
// concurrency limits and nowhere near Supabase's connection-pool ceiling,
// while still being high enough to cut the ~40-hour real-world estimate by
// close to an order of magnitude. If a real timed run shows Supabase has
// headroom for more, raise this number and re-time — this file has no way
// to discover the real ceiling itself, only to stay well clear of it.
const DISPATCH_CONCURRENCY = 15;

// WRITEBACK_CONCURRENCY — same reasoning posture as DISPATCH_CONCURRENCY
// above, but set lower (8, not 15) because writeBackBatch()'s own per-item
// work (applyOneBatchItem(), via significance-pass.js's applyCall1Result())
// is heavier than buildDispatchEntries()'s: it runs buildConversationContext
// (the same ~4-round-trip call DISPATCH_CONCURRENCY was timed against) AND
// THEN, for every item, checkClaim()'s own query plus the significance-row
// upsert plus message-link inserts plus an audit-log write — roughly double
// the sequential Supabase round trips per item. Since each worker's own
// calls stay sequential (only the workers themselves run in parallel,
// exactly as DISPATCH_CONCURRENCY's comment already establishes), halving
// the worker count keeps the number of requests in flight to Supabase at
// any instant in the same conservative range this file has already been
// careful to stay inside. Not a measured ceiling, just a reasoned starting
// point — raise and re-time against a real run if it turns out there's
// headroom, same posture DISPATCH_CONCURRENCY's own comment already takes.
const WRITEBACK_CONCURRENCY = 8;

// ============================================================
// mapWithConcurrency — small, generic, dependency-free bounded-concurrency
// worker pool. No existing concurrency-limiting utility was found anywhere
// else in this codebase (checked before writing this — see this fix's own
// build report), and a plain `for`-of-`await` "pull the next index off a
// shared cursor" loop needs no new npm dependency for something this size.
//
// Runs asyncFn(item, index) for every item in `items`, at most `limit`
// calls in flight at once — NOT `items.map(asyncFn)` wrapped in
// `Promise.all` (that would kick off every call at once, unbounded, the
// exact "overwhelms the connection pool" failure mode this fix exists to
// avoid). Returns a results array in the SAME order as `items`
// (index-based assignment, not completion order) even though the
// underlying work finishes out of order — callers that need output order
// to match input order (buildDispatchEntries(), below) get that for free
// without any separate re-sorting step.
// ============================================================
async function mapWithConcurrency(items, limit, asyncFn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await asyncFn(items[i], i);
    }
  }
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// ============================================================
// drainInGroups — pairs with mapWithConcurrency() above to let
// checkAndResumeOneBatch()/writeBackBatch() (below) consume Anthropic's own
// results stream (an async iterator, not a pre-built array — mapWithConcurrency
// needs items.length up front, so it cannot run directly over a stream)
// without ever buffering the whole stream in memory, which is exactly the
// failure mode this file's own comments elsewhere (see
// fetchAllPendingWriteBackItems()) already warn against for the results
// stream specifically. Reads at most `groupSize` items off `asyncIterable`
// at a time and yields each group as a plain array, so a caller can run
// mapWithConcurrency(group, groupSize, ...) on each group before this pulls
// the next one off the stream — bounded memory (never more than one
// group's worth of results held at once) AND bounded concurrency (never
// more than groupSize items processed at once), one group fully processed
// before the next is even read.
// ============================================================
async function* drainInGroups(asyncIterable, groupSize) {
  let group = [];
  for await (const item of asyncIterable) {
    group.push(item);
    if (group.length >= groupSize) {
      yield group;
      group = [];
    }
  }
  if (group.length > 0) yield group;
}

// Anthropic's own real RateLimitError sets status 429 (@anthropic-ai/sdk
// 0.30.1, node_modules/@anthropic-ai/sdk/error.js — confirmed, not assumed,
// while building this fix). Checked defensively on .error.type too, in case
// a differently-shaped error object ever reaches here (e.g. a raw fetch
// failure some proxy layer wraps differently) — belt-and-suspenders, same
// posture this file already takes elsewhere (see generateToken()'s own
// comment on its CHECK-plus-alphabet redundancy).
function isRateLimitError(err) {
  return !!(err && (err.status === 429 || (err.error && err.error.type === 'rate_limit_error')));
}

// ============================================================
// partitionIntoChunks — PURE. Greedily partitions an ordered list of
// {bytes, ...} entries into chunks, cutting a new chunk the moment adding
// the next entry would exceed EITHER maxRequests or maxBytes for the chunk
// currently being built — whichever triggers first, exactly Anthropic's own
// real "100,000 requests OR 256MB, whichever is reached first" rule.
// maxRequests/maxBytes are parameters, not the module's own MAX_BATCH_
// REQUESTS/MAX_BATCH_BYTES constants directly, specifically so this can be
// unit-tested with small, fast numbers instead of constructing 100,000+ real
// entries just to prove the count-based cut actually works. Assumes every
// single entry's own bytes is already <= maxBytes (dispatchRunChunks()
// filters out any single request that alone exceeds MAX_BATCH_BYTES before
// this ever runs — see its own itemsSkippedOversized handling) — an entry
// larger than maxBytes all by itself would otherwise become its own
// permanently-oversized chunk of one, silently violating the very limit this
// function exists to enforce.
// ============================================================
function partitionIntoChunks(entries, maxRequests, maxBytes) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  for (const entry of entries) {
    if (current.length > 0 && (current.length + 1 > maxRequests || currentBytes + entry.bytes > maxBytes)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += entry.bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ============================================================
// fetchSignificanceRowsForPairs — batch-fetches missive_conversation_
// significance rows for a set of (mailbox_key, missive_conversation_id)
// pairs, keyed by "mailbox_key::missive_conversation_id" for O(1) per-item
// lookup. Needed because the submission-run-items/batch-items tables only
// ever store mailbox_key/missive_conversation_id (see startSubmissionRun's
// own item rows and insertBatchItems above) — Call 2's own dispatch
// (buildDispatchEntries, below) and write-back (writeBackCall2Batch, below)
// both need category/resolution_status/why/discovery_context (dispatch) or
// category/why/discovery_context/keyword-check flags (write-back), which
// live only on that OTHER table, never on the run/batch item rows
// themselves. Same "IN() on one column, filter the composite key in app
// code" pattern reportNeedsCall2() above already uses, for the identical
// reason (missive_conversation_id is only unique within a mailbox) — a
// separate constant/function rather than reusing reportNeedsCall2()'s own
// inline LOOKUP_CHUNK, since that one is scoped to a single batch's own
// items and a fixed column list, not a general-purpose fetch. Called ONCE
// per dispatch/write-back call (never per item) — see buildDispatchEntries'
// and writeBackCall2Batch's own callers for why.
// ============================================================
const SIGNIFICANCE_ROWS_LOOKUP_CHUNK = 200;

async function fetchSignificanceRowsForPairs(pairs, selectColumns) {
  const ids = Array.from(new Set(pairs.map((p) => p.missive_conversation_id)));
  const wantedKeys = new Set(pairs.map((p) => `${p.mailbox_key}::${p.missive_conversation_id}`));
  const byKey = new Map();
  for (let i = 0; i < ids.length; i += SIGNIFICANCE_ROWS_LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from('missive_conversation_significance')
      .select(selectColumns)
      .in('missive_conversation_id', ids.slice(i, i + SIGNIFICANCE_ROWS_LOOKUP_CHUNK));
    if (error) throw error;
    for (const row of (data || [])) {
      const key = `${row.mailbox_key}::${row.missive_conversation_id}`;
      if (wantedKeys.has(key)) byKey.set(key, row);
    }
  }
  return byKey;
}

// ============================================================
// buildDispatchEntries — builds one real Call 1 request per undispatched
// item, reusing buildConversationContext()/buildCall1Prompt() exactly like
// buildCall1BatchRequests() above already does (never reimplemented), plus
// this run's own two new per-item concerns: a real byte size
// (sizeOfRequestBytes()) for partitionIntoChunks() to cut on, and a token
// generated fresh per item (unique across this whole call, a strictly
// stronger and simpler guarantee than "unique within one eventual chunk" —
// chunk boundaries aren't known yet at this point, since they're decided
// AFTER every entry is built, by partitionIntoChunks()).
//
// A pair whose messages have disappeared since fetchNextEligibleConversations
// found it (skipped_empty) is handled exactly like buildCall1BatchRequests()
// already does — counted, excluded, never a hard failure. A single
// conversation whose own request alone exceeds maxBytes (skipped_oversized)
// is new to this build — real emails are nowhere near 200MB, so this should
// never fire in practice at the real MAX_BATCH_BYTES, but a fail-loud skip
// (logged clearly, left permanently undispatched for manual review) is far
// safer than either crashing the whole dispatch run or silently producing an
// over-limit chunk.
//
// maxBytes is a parameter (defaulting to the real MAX_BATCH_BYTES), not the
// module constant read directly, for the same reason partitionIntoChunks()
// takes its limits as parameters — see that function's own comment: it lets
// dispatchRunChunks()'s own tests force this codepath with a small, fast
// mock request instead of constructing something close to a real 200MB
// payload just to prove the skip actually fires.
//
// ADDED 2026-09-19 — CONCURRENCY. The per-item work (buildConversationContext
// + buildCall1Prompt + token/request assembly) now runs through
// mapWithConcurrency() (above) at DISPATCH_CONCURRENCY-wide concurrency
// instead of one item at a time — see that constant's own comment for the
// real timing evidence and reasoning. Two properties the sequential version
// gave for free had to be preserved explicitly under concurrent execution:
//   1. OUTPUT ORDER matches `items`' own order (partitionIntoChunks()
//      downstream needs a stable, deterministic sequence) — mapWithConcurrency
//      already returns per-item results index-aligned to the input regardless
//      of completion order, so the final for-of below that turns those
//      results into `entries`/skip counts just walks them in that same,
//      already-correct order. Nothing here re-sorts by completion time.
//   2. seenTokens uniqueness (a single Set shared across every concurrent
//      worker) stays correct DESPITE concurrent workers because the
//      generate-check-add sequence has no `await` in it anywhere — JS's
//      single-threaded, run-to-completion-between-awaits execution model
//      means that whole block is already atomic with respect to every other
//      concurrently-running worker, exactly as if it were still sequential.
// concurrency is a parameter (defaulting to DISPATCH_CONCURRENCY), not the
// module constant read directly, for the same testability reason maxBytes
// already is one call up in this same header comment.
//
// ADDED 2026-09-29 — stage-aware, for the Call 2 batch build. `stage` picks
// which prompt gets built (buildCall1Prompt vs buildCall2Prompt) and which
// max_tokens the request carries (1024 for Call 1, unchanged; 768 for Call
// 2, matching runCall2()'s own live call — significance-pass.js ~line
// 563-570). Call 2's own prompt needs category/resolution_status/why/
// discovery_context, which — unlike Call 1's own eligible pairs, which
// carry nothing beyond mailbox_key/missive_conversation_id either, but
// need nothing more than that — must be looked up from missive_
// conversation_significance (fetchSignificanceRowsForPairs, above); done
// ONCE for the whole `items` array before the per-item concurrent loop
// starts, not once per item, same "one round trip for the whole call"
// discipline getActiveComplaintTrackingConfig() below is also given.
// silenceContext (needed by buildCall2Prompt() for a 'live_pipeline' row —
// most of the historical backlog is 'historical_backfill', where it's
// simply null, per buildCall2Prompt()'s own historicalFraming branch)
// reuses significancePass.computeSilenceContext() directly — the exact
// same call runCall2Phase() itself makes — rather than re-deriving that
// silence-window logic here.
// ============================================================
async function buildDispatchEntries(items, stage, maxBytes = MAX_BATCH_BYTES, concurrency = DISPATCH_CONCURRENCY) {
  const seenTokens = new Set();

  let call2SignificanceByKey = null;
  let complaintTrackingConfig = null;
  if (stage === 'call_2') {
    call2SignificanceByKey = await fetchSignificanceRowsForPairs(
      items,
      'mailbox_key, missive_conversation_id, category, resolution_status, why, discovery_context'
    );
    complaintTrackingConfig = await significancePass.getActiveComplaintTrackingConfig();
  }

  const perItemResults = await mapWithConcurrency(items, concurrency, async (item) => {
    const context = await significancePass.buildConversationContext(item.mailbox_key, item.missive_conversation_id);
    if (!context) return { outcome: 'skipped_empty' };
    const { addressMatched, threadText, thread } = context;

    let prompt;
    if (stage === 'call_1') {
      prompt = significancePass.buildCall1Prompt({ threadText, addressMatched });
    } else {
      const sigFields = call2SignificanceByKey.get(`${item.mailbox_key}::${item.missive_conversation_id}`);
      if (!sigFields) {
        console.error(`[significance-batch] item ${item.id} (${item.mailbox_key}/${item.missive_conversation_id}) has no missive_conversation_significance row at dispatch time (Call 1's own result may have been deleted since this run was assembled) — skipping, same as a disappeared conversation; left undispatched, needs manual review.`);
        return { outcome: 'skipped_empty' };
      }
      const silenceContext = sigFields.discovery_context === 'live_pipeline'
        ? significancePass.computeSilenceContext(thread, complaintTrackingConfig ? complaintTrackingConfig.blocked_resolution_silence_days : 2)
        : null;
      prompt = significancePass.buildCall2Prompt({
        category: sigFields.category,
        resolution_status: sigFields.resolution_status,
        why: sigFields.why,
        threadText,
        discoveryContext: sigFields.discovery_context,
        silenceContext,
      });
    }

    let token;
    do { token = generateToken(); } while (seenTokens.has(token)); // re-roll on collision — see generateToken()'s own header for how unlikely this branch is to ever run.
    seenTokens.add(token);

    const request = {
      custom_id: token,
      params: {
        model: 'claude-sonnet-5',
        max_tokens: stage === 'call_1' ? 1024 : 768,
        output_config: { effort: 'medium' },
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      },
    };
    const bytes = sizeOfRequestBytes(request);

    if (bytes > maxBytes) {
      console.error(`[significance-batch] item ${item.id} (${item.mailbox_key}/${item.missive_conversation_id}) is ${bytes} bytes by itself — exceeds the ${maxBytes}-byte chunk cap and could never fit in any chunk. Skipping — left undispatched (batch_id stays NULL); needs manual review.`);
      return { outcome: 'skipped_oversized' };
    }

    return { outcome: 'entry', entry: { token, item, request, bytes } };
  });

  const entries = [];
  let skippedEmpty = 0;
  let skippedOversized = 0;
  for (const result of perItemResults) {
    if (result.outcome === 'entry') entries.push(result.entry);
    else if (result.outcome === 'skipped_empty') skippedEmpty++;
    else skippedOversized++;
  }

  return { entries, skippedEmpty, skippedOversized };
}

// ============================================================================
// EXPECTED POOL SANITY CHECK — added 2026-09-19, the real-incident-class
// safeguard. See significance-pass.js's own estimateExpectedEligiblePool()
// header for the full incident story: a real production run's eligibility
// scan found 33,755 conversations against an independently-verified real
// pool of ~84,192 — a silent ~60% undercount, no error thrown anywhere,
// root cause never proven, and it did not reproduce on two clean re-runs.
//
// dispatchRunChunks() (below) calls checkEligiblePoolSanity() before
// sending anything NEW to Anthropic for a run, comparing that run's own
// eligible_count (set ONCE, durably, by startSubmissionRun() — the
// expensive scan's real, already-persisted result) against a freshly
// computed, cheap estimate of what the pool should roughly be. Deliberately
// re-computed on every single dispatchRunChunks() call that has something
// new to dispatch, rather than decided once and stamped onto the run row as
// a flag: a run's own eligible_count never changes after assembly, so
// nothing is lost by re-deriving the comparison fresh each time, and doing
// so means there is no stale, one-time "cleared" flag on the row for a
// human or a later run to ever trust past the moment it was actually
// checked. `force` (below) is how a human deliberately proceeds anyway,
// for one specific call, once they've reviewed the real numbers.
//
// THE THRESHOLD — EXPECTED_POOL_MIN_RATIO = 0.7 (70%), chosen and reasoned
// through, not copied blindly: tonight's real incident was 33,755 / 84,192
// = 40.1% of the estimated pool — any threshold above ~41% would have
// caught it. A genuinely healthy run, per everything measured tonight, only
// loses a small, single-digit percentage to legitimate causes (an open Fair
// Housing escalation, a conversation whose messages disappeared between the
// scan and now, plus this estimate's own approximation slop — see
// estimateExpectedEligiblePool()'s own header for the two directions that
// slop can run, one of which already makes the estimate self-conservative).
// 70% leaves a wide, deliberate margin below where a normal run's real
// ratio should sit (comfortably above 90% in practice) while staying well
// clear of the 40% incident shape — loose enough to never cry wolf on an
// ordinary run, tight enough that a similarly-sized future undercount could
// not sail through silently a second time.
// ============================================================================
const EXPECTED_POOL_MIN_RATIO = 0.7;

// Pure — directly unit-tested with tonight's own real numbers, no DB call
// or significancePass dependency at all. expectedPool <= 0 means the
// estimate itself has nothing meaningful to compare against (e.g. a fully-
// drained pool) — treated as "nothing to flag," never as a false alarm
// (there is no divide-by-zero/negative-ratio nonsense to reason about).
function evaluatePoolRatio({ eligibleCount, expectedPool, minRatio = EXPECTED_POOL_MIN_RATIO }) {
  if (!(expectedPool > 0)) return { passed: true, ratio: null };
  const ratio = eligibleCount / expectedPool;
  return { passed: ratio >= minRatio, ratio };
}

// Orchestrates the pure check above against a freshly-computed real
// estimate. Kept separate from evaluatePoolRatio() specifically so the pure
// comparison logic can be unit-tested with plain numbers, with no
// significancePass dependency or fake Supabase client required at all.
async function checkEligiblePoolSanity({ eligibleCount, sinceDate }) {
  const { expectedPool, totalMatchingConversations, totalAlreadyProcessed } = await significancePass.estimateExpectedEligiblePool(sinceDate);
  const evaluation = evaluatePoolRatio({ eligibleCount, expectedPool });
  return { ...evaluation, eligibleCount, expectedPool, totalMatchingConversations, totalAlreadyProcessed };
}

// ============================================================
// dispatchRunChunks — step 2 of the new flow. Resumable: safe to call
// repeatedly. Only ever reads/acts on this run's still-undispatched rows
// (batch_id IS NULL), so an earlier call's already-dispatched chunks are
// never touched again, even across separate, crash-interrupted invocations.
//
// Refuses to run against a run whose own durability checkpoint hasn't
// finished (assembled_at IS NULL) — see startSubmissionRun()'s own comment
// on that narrow gap. Dispatching against a partially-assembled run's items
// would silently under-submit the real eligible set without any record that
// anything was missing.
//
// Submits chunks back-to-back — each chunk's own .create() call is awaited
// before the next chunk's begins, but NONE of them wait for an earlier
// chunk's Anthropic processing to reach 'ended' (which can take up to 24
// hours) before continuing — see the migration's own "PARALLEL CHUNKS"
// section for why serializing on PROCESSING (not on the network round trip
// of .create() itself) would be unacceptable at this scale.
//
// A 429 (rate limit) from .create() is treated as a genuine, expected,
// non-fatal outcome — see isRateLimitError() above — never a crash: that
// chunk's items are simply left undispatched (batch_id stays NULL) for the
// next dispatchRunChunks() call to retry, and this loop continues on to try
// the run's remaining chunks rather than aborting the whole dispatch.
//
// maxRequests/maxBytes default to the real MAX_BATCH_REQUESTS/MAX_BATCH_BYTES
// constants (identical production behavior to calling this with no
// overrides) but can be overridden — purely so this function's own tests can
// force a real count-based or byte-based chunk cut with a handful of small
// mock items instead of constructing 100,000+ real entries or a ~200MB mock
// request just to exercise the boundary. The CLI (run-significance-batch.js)
// never passes either override.
//
// ADDED 2026-09-19 — force: EXPECTED POOL SANITY CHECK guard. Before this
// function ever calls buildDispatchEntries()/Anthropic for any NEWLY
// undispatched item, it compares this run's own eligible_count against
// checkEligiblePoolSanity()'s fresh estimate (see that function's own
// header, above, for the full incident story and the threshold reasoning).
// A run with nothing new to dispatch (undispatchedItems.length === 0, e.g.
// every chunk already sent) skips the check entirely and returns the empty
// summary exactly as before this addition — there is nothing left to
// protect once a run's items are already out the door, and gating an
// already-fully-dispatched run's resume/poll path on a fresh count query
// would only add cost and risk, never safety. `force: true` (CLI: --force)
// skips the check for this one call only — never persisted anywhere on the
// run row — so a human who has reviewed a flagged run's real numbers can
// deliberately proceed; every OTHER call to this function, for this or any
// other run, still checks fresh, exactly per this file's own "never trust a
// one-time decision baked into the row" design choice (see that header).
//
// ADDED 2026-09-29 — stage-aware (Call 2 build). The EXPECTED POOL SANITY
// CHECK above is deliberately run for run.stage === 'call_1' ONLY (Q's own
// scope decision, flagged here rather than silently assumed): checkEligible
// PoolSanity()/estimateExpectedEligiblePool() estimate Call 1's OWN eligible
// pool — the same screening-cleared-conversations-minus-already-processed
// scan Call 1's real eligibility fetch itself runs — which has no Call 2
// equivalent. Call 2's eligible_count is a small, already-known, fixed
// subset of conversations Call 1 has ALREADY fully processed (the ~27,000-
// conversation backlog), not an independently-estimable "pool" with its own
// undercount failure mode — comparing it against Call 1's own pool estimate
// would compare two unrelated denominators and, in the ~27k-of-~250k real
// case, would ALWAYS fail (roughly 11%, nowhere near the 70% threshold),
// making --force mandatory on every single call2 dispatch rather than the
// deliberate, occasional human override this check is designed to be.
// ============================================================
async function dispatchRunChunks({ runId, maxRequests = MAX_BATCH_REQUESTS, maxBytes = MAX_BATCH_BYTES, force = false }) {
  const run = await fetchRunById(runId);
  if (!run) throw new Error(`dispatchRunChunks: no submission run found with id "${runId}".`);
  if (run.stage !== 'call_1' && run.stage !== 'call_2') {
    throw new Error(`dispatchRunChunks: stage '${run.stage}' is not implemented — only 'call_1' and 'call_2' dispatch are built.`);
  }
  if (!run.assembled_at) {
    throw new Error(`dispatchRunChunks: run ${runId} has not finished being durably assembled (assembled_at is not set) — its eligible list may be incomplete. This should only happen if startSubmissionRun crashed between inserting the run row and finishing its submission_run_items inserts (a narrow, documented window — see this file's own header). Needs manual review before dispatching; re-running will not fix this on its own.`);
  }

  const summary = { chunksSubmitted: 0, chunksRateLimited: 0, itemsDispatched: 0, itemsSkippedEmpty: 0, itemsSkippedOversized: 0, blockedBySanityCheck: false, sanityCheck: null };

  const undispatchedItems = await fetchUndispatchedRunItems(runId);
  if (undispatchedItems.length === 0) return summary;

  if (!force && run.stage === 'call_1') {
    const sanityCheck = await checkEligiblePoolSanity({ eligibleCount: run.eligible_count, sinceDate: run.since_date });
    if (!sanityCheck.passed) {
      console.error(`[significance-batch] SANITY CHECK FAILED for run ${runId}: eligible_count=${sanityCheck.eligibleCount} is only ${(sanityCheck.ratio * 100).toFixed(1)}% of the estimated expected pool (~${sanityCheck.expectedPool}, from ${sanityCheck.totalMatchingConversations} matching conversation(s) minus ${sanityCheck.totalAlreadyProcessed} already-processed conversation(s)) — below the ${(EXPECTED_POOL_MIN_RATIO * 100).toFixed(0)}% threshold. Refusing to dispatch anything to Anthropic for this run — this looks like the same class of silent undercount seen on 2026-09-18 (33,755 found vs. ~84,192 expected). Pass force: true (CLI: --force) once a human has reviewed this run and confirmed the low count is real.`);
      return { ...summary, blockedBySanityCheck: true, sanityCheck };
    }
  }

  const { entries, skippedEmpty, skippedOversized } = await buildDispatchEntries(undispatchedItems, run.stage, maxBytes);
  summary.itemsSkippedEmpty = skippedEmpty;
  summary.itemsSkippedOversized = skippedOversized;
  if (entries.length === 0) return summary;

  const chunks = partitionIntoChunks(entries, maxRequests, maxBytes);
  let nextChunkNumber = await fetchNextChunkNumberForRun(runId);
  const anthropic = anthropicClient();

  for (const chunkEntries of chunks) {
    const requests = chunkEntries.map((e) => e.request);
    let response;
    try {
      response = await anthropic.beta.messages.batches.create({ requests }); // real, billed submission for this one chunk — everything above this line (for this chunk) is read-only/local and safe to re-run.
    } catch (err) {
      if (isRateLimitError(err)) {
        summary.chunksRateLimited++;
        console.error(`[significance-batch] run ${runId}: a chunk of ${requests.length} request(s) hit a rate limit (429) submitting to Anthropic — leaving these items undispatched (batch_id stays NULL); they will be retried on the next dispatchRunChunks call, not treated as a failure.`);
        continue; // do not throw, do not advance nextChunkNumber, do not touch these rows.
      }
      throw err;
    }

    let batchRow;
    try {
      const { data, error } = await supabase
        .from('archive_search_significance_batches')
        .insert({
          stage: run.stage,
          anthropic_batch_id: response.id,
          anthropic_status: response.processing_status,
          request_count_total: requests.length,
          submitted_by: BATCH_TOOL_VERSION,
          run_id: runId,
          chunk_number: nextChunkNumber,
          notes: run.since_date ? `sinceDate=${run.since_date}` : null,
        })
        .select()
        .single();
      if (error) throw error;
      batchRow = data;
    } catch (err) {
      // Anthropic has ALREADY accepted and started billing response.id by
      // this point — same real risk submitBatch()'s own comment documents
      // for the old single-batch flow, now scoped to one chunk of a run.
      // Logged loudly so it can be reconciled by hand, then re-thrown: an
      // insert failure here (a genuine DB outage, or an otherwise-impossible
      // chunk_number collision) is not a condition dispatchRunChunks can
      // safely paper over and keep going as if nothing happened.
      console.error(`[significance-batch] URGENT: a real Anthropic batch (${response.id}, ${requests.length} requests, run ${runId}, chunk ${nextChunkNumber}) was just created but could not be recorded: ${err.message}. This real batch has NO local tracking row — record its id manually and reconcile.`);
      throw err;
    }

    await insertBatchItems(batchRow.id, chunkEntries.map((e) => ({ token: e.token, mailbox_key: e.item.mailbox_key, missive_conversation_id: e.item.missive_conversation_id })));

    // Lockstep update of these rows' chunk_number/batch_id/dispatched_at —
    // the migration's own CHECK requires all three together or none.
    const dispatchedAtIso = new Date().toISOString();
    const itemIds = chunkEntries.map((e) => e.item.id);
    for (const idChunk of chunkArray(itemIds, ITEM_CHUNK_SIZE)) {
      const { error: updateErr } = await supabase
        .from('archive_search_significance_submission_run_items')
        .update({ chunk_number: nextChunkNumber, batch_id: batchRow.id, dispatched_at: dispatchedAtIso })
        .in('id', idChunk);
      if (updateErr) throw updateErr;
    }

    summary.chunksSubmitted++;
    summary.itemsDispatched += chunkEntries.length;
    nextChunkNumber++;
  }

  return summary;
}

// ============================================================
// checkAndResumeRun — step 3 of the new flow. Loops the EXISTING, UNCHANGED
// per-batch checkAndResumeOneBatch()/writeBackBatch()/maybeMarkBatchCompleted()
// logic over every archive_search_significance_batches row belonging to this
// run — never re-deriving or reimplementing any of that per-batch logic.
// Once every one of this run's batches has completed_at set, stamps the
// run's own fully_processed_at (this — not "every chunk dispatched," and not
// merely "every chunk's Anthropic status is 'ended'" — is the real "fully
// done" marker idx_archive_search_significance_submission_runs_
// one_active_per_stage actually keys on; see the migration's own comment on
// that column).
//
// A run with zero batches yet (dispatch hasn't happened, or every chunk so
// far has been rate-limited) can never be marked fully processed here —
// correctly: there is nothing yet to have finished.
//
// ADDED 2026-09-29 — stage-aware write-back (Call 2 build). Each batches
// row already carries its OWN stage column (stamped from run.stage at
// dispatch time — see dispatchRunChunks' own insert, above), so this reads
// batchRow.stage directly rather than re-fetching the parent run — correct
// even in the (currently impossible, since a run's own stage never
// changes) hypothetical of a run whose batches somehow disagreed with its
// own stage. checkAndResumeOneBatch()/maybeMarkBatchCompleted() themselves
// are genuinely stage-agnostic (neither reads or writes anything Call-1-
// or Call-2-specific) and stay completely unchanged, exactly as this
// function's own header already promises.
// ============================================================
async function checkAndResumeRun({ runId }) {
  const { data: batchRows, error } = await supabase
    .from('archive_search_significance_batches')
    .select('*')
    .eq('run_id', runId);
  if (error) throw error;

  const results = [];
  for (const batchRow of (batchRows || [])) {
    if (batchRow.completed_at) {
      results.push({ batchId: batchRow.id, anthropicBatchId: batchRow.anthropic_batch_id, alreadyCompleted: true });
      continue;
    }
    if (batchRow.failed_at) {
      results.push({ batchId: batchRow.id, anthropicBatchId: batchRow.anthropic_batch_id, failed: true });
      continue;
    }

    const checked = await checkAndResumeOneBatch(batchRow);
    let writeBackSummary = null;
    let nowCompleted = false;

    if (checked.remote.processing_status === 'ended' && checked.batch.results_retrieved_at) {
      writeBackSummary = batchRow.stage === 'call_2'
        ? await writeBackCall2Batch({ batchId: batchRow.id, anthropicBatchId: batchRow.anthropic_batch_id })
        : await writeBackBatch({ batchId: batchRow.id, anthropicBatchId: batchRow.anthropic_batch_id });
      nowCompleted = await maybeMarkBatchCompleted(batchRow.id);
    }

    results.push({
      batchId: batchRow.id,
      anthropicBatchId: batchRow.anthropic_batch_id,
      anthropicStatus: checked.remote.processing_status,
      resultsJustRetrieved: checked.resultsJustRetrieved,
      writeBackSummary,
      nowCompleted,
    });
  }

  const { data: allBatchRows, error: allErr } = await supabase
    .from('archive_search_significance_batches')
    .select('id, completed_at')
    .eq('run_id', runId);
  if (allErr) throw allErr;

  const fullyProcessed = (allBatchRows || []).length > 0 && (allBatchRows || []).every((b) => !!b.completed_at);
  if (fullyProcessed) {
    // Read the run row BEFORE stamping fully_processed_at, so this can tell
    // "this call is the one that just finished the run" apart from "this
    // run was already fully processed and checkAndResumeRun got called
    // again anyway" (a redundant cron re-check, for example) — the ONLY
    // guard standing between sendCall2BatchCompletionNotification() (below)
    // firing exactly once per run, per Asimov's own requirement, and firing
    // again on every subsequent call. stage is read from the same row, so a
    // call_1 run (which already has a live, human-present trigger — today's
    // one-at-a-time flow — per Asimov's own finding) never gets this email.
    const runBeforeUpdate = await fetchRunById(runId);
    const alreadyFullyProcessed = !!(runBeforeUpdate && runBeforeUpdate.fully_processed_at);

    const { error: updateErr } = await supabase
      .from('archive_search_significance_submission_runs')
      .update({ fully_processed_at: new Date().toISOString() })
      .eq('id', runId);
    if (updateErr) throw updateErr;

    // Asimov's governance review, 2026-09-29 — cleared to build, not
    // cleared to run against real data until this existed: a real
    // notification firing once a call_2 backlog run finishes, so a human
    // actually finds out. Hooked into the SAME transition point the run
    // itself already uses to mark itself done (immediately above), not a
    // new completion-detection mechanism. Never awaited in a way that
    // could affect the return value or throw past this function — see
    // sendCall2BatchCompletionNotification's own try/catch.
    if (!alreadyFullyProcessed && runBeforeUpdate && runBeforeUpdate.stage === 'call_2') {
      await sendCall2BatchCompletionNotification({
        runId,
        batchIds: (allBatchRows || []).map((b) => b.id),
      });
    }
  }

  return { results, fullyProcessed };
}

module.exports = {
  BATCH_TOOL_VERSION,
  MAX_BATCH_REQUESTS,
  MAX_BATCH_BYTES,
  sizeOfRequestBytes,
  generateToken,
  generateUniqueTokensForBatch,
  chunkArray,
  findUnfinishedBatch,
  buildCall1BatchRequests,
  insertBatchItems,
  submitBatch,
  checkAndResume,
  fetchAllPendingWriteBackItems,
  applyOneBatchItem,
  writeBackBatch,
  maybeMarkBatchCompleted,
  reportNeedsCall2,
  // Added 2026-09-18 — submission runs / size-aware chunking / resumable
  // dispatch (this file's own "ADDED 2026-09-18" header section).
  findUnfinishedRun,
  startSubmissionRun,
  dispatchRunChunks,
  checkAndResumeRun,
  partitionIntoChunks,
  // Added 2026-09-19 — the expected-pool sanity check (this file's own
  // "EXPECTED POOL SANITY CHECK" header, above dispatchRunChunks).
  EXPECTED_POOL_MIN_RATIO,
  evaluatePoolRatio,
  checkEligiblePoolSanity,
  // Added 2026-09-19 — buildDispatchEntries() concurrency fix (see
  // DISPATCH_CONCURRENCY's own comment for the real timing evidence).
  // buildDispatchEntries and mapWithConcurrency are exported directly
  // (rather than only exercised indirectly through dispatchRunChunks, as
  // before) so the concurrency behavior itself — bounded parallelism,
  // in-order output despite out-of-order completion, correct skip counts —
  // can be unit-tested on its own, same "pure/small function exported for
  // its own direct test" discipline partitionIntoChunks already follows.
  DISPATCH_CONCURRENCY,
  mapWithConcurrency,
  buildDispatchEntries,
  // Added 2026-09-20 — checkAndResumeOneBatch()/writeBackBatch() concurrency
  // fix (see WRITEBACK_CONCURRENCY's and drainInGroups()'s own comments,
  // above, for the reasoning). Exported directly for the same "exercise the
  // concurrency behavior on its own, not just indirectly" reason
  // DISPATCH_CONCURRENCY/mapWithConcurrency already are.
  WRITEBACK_CONCURRENCY,
  drainInGroups,
  // Added 2026-09-29 — Call 2 batch submission/dispatch/write-back (this
  // file's own header note on submitBatch()'s untouched legacy guard, plus
  // the stage-aware startSubmissionRun/dispatchRunChunks/checkAndResumeRun
  // above, and buildDispatchEntries' own new call_2 branch). Exported for
  // the same direct-unit-test reasons as their Call 1 counterparts above.
  fetchSignificanceRowsForPairs,
  applyOneCall2BatchItem,
  writeBackCall2Batch,
  // Added 2026-09-29 — Call 2 batch-completion notification (Asimov's
  // governance review; see computeCall2RunNotificationCounts' and
  // sendCall2BatchCompletionNotification's own header comments, above).
  // Exported directly for the same "exercise it on its own, not just
  // indirectly through checkAndResumeRun" reason every other unit in this
  // file's own "Added" export groups already is.
  computeCall2RunNotificationCounts,
  sendCall2BatchCompletionNotification,
  _setSupabaseClientForTesting,
  _setAnthropicClientForTesting,
};
