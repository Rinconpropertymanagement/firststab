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
 *   1. 'call_2' batches are not actually submittable yet. submitBatch()
 *      throws a clear, explicit error for any stage other than 'call_1'.
 *      Call 1 submission draws its conversations from significance-pass.js's
 *      fetchNextEligibleConversations() and its prompt from buildCall1Prompt()
 *      — a 'call_2' batch would need a COMPLETELY different conversation
 *      source (existing missive_conversation_significance rows that
 *      needsCall2() flags — reportNeedsCall2() below already computes that
 *      exact list) and buildCall2Prompt()'s richer inputs (category,
 *      resolution_status, why, silence context). That is real, separate,
 *      deliberate follow-on work — this build only had to get Call 1's real
 *      results in front of Peter before Call 2 was ever authorized to run
 *      at this scale (see reportNeedsCall2()'s own header), so it stops
 *      exactly there rather than guessing at 'call_2' submission's shape.
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
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const significancePass = require('./significance-pass');

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
// checkAndResume — step 2. Always updates anthropic_status/last_checked_at,
// whether or not the status actually changed (the migration's own
// documented reasoning: "did the resume script even check on this today" is
// its own useful signal). Only streams results (and only once — guarded by
// results_retrieved_at) once Anthropic itself reports 'ended'. Never loads
// the results stream into memory — each yielded item triggers one direct,
// indexed (batch_id, token) update and is then discarded.
// ============================================================
async function checkAndResume({ stage }) {
  const batch = await findUnfinishedBatch(stage);
  if (!batch) return { found: false, batch: null, remote: null };

  const anthropic = anthropicClient();
  const remote = await anthropic.beta.messages.batches.retrieve(batch.anthropic_batch_id);

  const checkedAtIso = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from('archive_search_significance_batches')
    .update({ anthropic_status: remote.processing_status, last_checked_at: checkedAtIso })
    .eq('id', batch.id);
  if (updateErr) throw updateErr;

  const updatedBatch = { ...batch, anthropic_status: remote.processing_status, last_checked_at: checkedAtIso };
  const outcome = { found: true, batch: updatedBatch, remote, resultsJustRetrieved: false, statusCounts: null };

  if (remote.processing_status === 'ended' && !batch.results_retrieved_at) {
    const stream = await anthropic.beta.messages.batches.results(batch.anthropic_batch_id);
    const statusCounts = { succeeded: 0, errored: 0, canceled: 0, expired: 0 };

    for await (const r of stream) {
      const resultType = r.result.type;
      statusCounts[resultType] = (statusCounts[resultType] || 0) + 1;
      const errorDetail = resultType === 'succeeded' ? null : JSON.stringify(r.result.error || { type: resultType });
      const { error: itemErr } = await supabase
        .from('archive_search_significance_batch_items')
        .update({ result_status: resultType, error_detail: errorDetail })
        .eq('batch_id', batch.id)
        .eq('token', r.custom_id);
      if (itemErr) console.error(`[significance-batch] failed to record result status for token ${r.custom_id}:`, itemErr.message);
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

  for await (const r of stream) {
    const item = pendingMap.get(r.custom_id);
    if (!item) continue; // already written back by an earlier run, or an unrecognized token — never reprocess.
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
// reportNeedsCall2 — step 4. Only ever called after a 'call_1' stage batch
// reaches completed_at. Deliberately reports only — never submits a
// 'call_2' batch itself (that is a separate, later, DELIBERATE invocation
// of submitBatch({stage: 'call_2', ...}), once that path is actually built
// — see this file's own header). Scoped to THIS batch's own conversations
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

module.exports = {
  BATCH_TOOL_VERSION,
  MAX_BATCH_REQUESTS,
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
  _setSupabaseClientForTesting,
  _setAnthropicClientForTesting,
};
