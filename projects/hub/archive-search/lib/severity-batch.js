/**
 * lib/severity-batch.js
 *
 * The retroactive severity-tier backfill batch tool — Jarvis-relayed build
 * task, 2026-10-02. Mirrors lib/significance-batch.js's own Message Batches
 * API architecture (read that file's header in full first) deliberately
 * SIMPLIFIED for this job's real shape, not a blind copy — the difference
 * is explained below so the simplification is a flagged judgment call, not
 * a silent shortcut.
 *
 * ============================================================================
 * OPERATIONAL WARNING — DO NOT RUN THIS FOR REAL YET
 * ============================================================================
 * This module makes real, billed Anthropic API calls and writes real rows
 * into `complaints` (severity_tier/severity_rationale/severity_assessed_at/
 * severity_rubric_version) and `audit_log`. submitSeverityBatch() REFUSES to
 * run (throws, before touching Anthropic or Supabase) unless
 * SEVERITY_BATCH_GOVERNANCE_CLEARED=true is set in the environment — see
 * that function's own comment. As of this build, it is NOT set anywhere:
 * Peter has not yet applied either schema migration this tool depends on
 * (supabase/migrations/20261002010000_... and .../20261002020000_...), and
 * Mason's scoped review of the accommodation/protected-class interaction is
 * still in progress (relayed via Jarvis). Do not flip that env var on
 * without Jarvis confirming both have actually cleared.
 *
 * ============================================================================
 * WHY THIS IS SIMPLER THAN significance-batch.js's RUN/CHUNK/BATCH SCHEMA —
 * A DELIBERATE, FLAGGED SCOPE DECISION, NOT A MISSED REQUIREMENT
 * ============================================================================
 * significance-batch.js's run/chunk/batch-item tracking tables
 * (archive_search_significance_submission_runs/_run_items,
 * archive_search_significance_batches/_batch_items) exist to solve a
 * problem THIS job does not have: for the significance pass, "has this
 * conversation been processed yet" lives on a DIFFERENT table
 * (missive_conversation_significance) than the one being scanned, and the
 * in-flight Anthropic request's own custom_id has to be mapped back to a
 * (mailbox_key, missive_conversation_id) pair that isn't itself a usable
 * Anthropic custom_id (two UUIDs together blow past its 64-character cap).
 *
 * Severity tiering has neither problem:
 *   1. "Has this complaint been assessed yet" lives on THE SAME ROW being
 *      read (complaints.severity_tier IS NULL) — the resumability this
 *      job needs ("which rows still need work") is already free, straight
 *      off the real data, with no separate tracking table required at all.
 *      A crash, a re-run, or a second invocation naturally only ever picks
 *      up rows nobody has successfully written severity fields for yet.
 *   2. complaints.id is already a single UUID — well under Anthropic's
 *      64-character custom_id limit — so it is used AS the custom_id
 *      directly, below. No token-generation/collision-avoidance scheme or
 *      item-tracking table is needed just to map a result back to a row.
 *
 * What's genuinely still needed, and still real, is tracking for the ONE
 * thing that doesn't already live in `complaints`: which Anthropic batch
 * (if any) is currently in flight, so a crash between submission and
 * write-back doesn't orphan a real, billed batch. That's STATE_PATH below —
 * a single small JSON file (not a new DB table), same "local, single-host,
 * fails safe on reboot" design lib/severity-lock.js's own header already
 * argues for significance-lock.js's lock file. This is a real, intentional
 * simplification relative to "mirror the architecture exactly," flagged
 * here rather than silently deviating — a DB-table-based version (new Neo
 * migration: complaint_severity_batches, keyed by anthropic_batch_id) would
 * be a reasonable future upgrade if this job ever needs to track MULTIPLE
 * concurrent in-flight batches (it doesn't today: this tool enforces at
 * most one at a time, same discipline significance-batch.js's own
 * one-unfinished-batch-per-stage index enforces structurally — this file
 * enforces it in application code instead, since there's no unique index
 * to lean on here).
 *
 * At today's real scale (2,733 complaints, well under both Anthropic's
 * 100,000-request and 256MB-per-batch ceilings) the ENTIRE backfill is one
 * batch, submitted once. The size-aware chunking machinery below
 * (partitionIntoChunks, reused directly from significance-batch.js, never
 * reimplemented) still runs for real — it just produces exactly one chunk
 * at this volume — so this tool stays correct if complaint volume ever
 * grows into multi-chunk territory, without needing a redesign; only ONE
 * chunk is ever submitted per invocation of submitSeverityBatch() (the
 * local state file tracks one in-flight batch at a time, by design) — a
 * second chunk, if one ever exists, waits for the first to finish and a
 * fresh call to pick it up, same "serial split across invocations, never
 * true parallel submission" posture significance-batch.js's own header
 * already accepts for the identical reason.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const severityRubric = require('./severity-rubric');
// Whole-module reference — reusing significance-batch.js's own generic,
// pure utilities (sizeOfRequestBytes, chunkArray, partitionIntoChunks,
// mapWithConcurrency, drainInGroups, the two real Anthropic ceiling
// constants) rather than re-deriving any of them. None of these touch
// Supabase or Anthropic themselves — they are safe, dependency-free pure
// functions, exactly why significance-batch.js exports them directly (see
// that file's own module.exports comments).
const sigBatch = require('./significance-batch');

let supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
function _setSupabaseClientForTesting(client) { supabase = client; }

let anthropicClientOverrideForTesting = null;
function anthropicClient() {
  if (anthropicClientOverrideForTesting) return anthropicClientOverrideForTesting;
  const Anthropic = require('@anthropic-ai/sdk');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  return new Anthropic({ apiKey });
}
function _setAnthropicClientForTesting(client) { anthropicClientOverrideForTesting = client; }

const SEVERITY_BATCH_TOOL_VERSION = 'complaint-severity-batch-v1';

// Where the one-in-flight-batch state lives — see this file's own header,
// "WHY THIS IS SIMPLER..." above. Overridable for tests, same convention
// significance-lock.js's own LOCK_PATH already uses.
const STATE_PATH = process.env.SEVERITY_BATCH_STATE_PATH
  || path.join(os.tmpdir(), 'complaint-severity-batch-state.json');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    return null; // missing, or corrupt/half-written — treated as "no in-flight batch known," never as a hard failure.
  }
}
function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
function clearState() {
  try { fs.unlinkSync(STATE_PATH); } catch (_) { /* already gone — fine */ }
}

// How many rows one fetchUnassessedComplaints() page pulls at a time — cheap,
// arbitrary, bounded-round-trip chunk size, same instinct as significance-
// batch.js's own ITEM_CHUNK_SIZE.
const FETCH_PAGE_SIZE = 500;

// ============================================================
// fetchUnassessedComplaints — THE driver query. severity_tier IS NULL is
// the entire resumability contract (see this file's header) — a row this
// query returns is, by definition, a row nobody has successfully written
// severity fields for yet. held_legal_fair_housing = false is defense in
// depth, not reliance on the database CHECK alone (the build task's own
// instruction): a held row's severity_tier is already forced to stay NULL
// forever by the schema (complaints_held_excludes_ai_fields), so it would
// be returned here on every single call — excluded explicitly so this tool
// never even builds a request for one, rather than building one and
// relying on the database to reject the eventual write.
// `description IS NOT NULL` — nothing to classify without any text; a row
// with a null description (should not happen in practice — createComplaintRow
// always sets it from Call 1's `why`, see that function's own comment) is
// left unassessed rather than sent to the model with empty input.
//
// PAGED via .range(), never a single unpaginated .select().limit(N) for
// N > ~1000 — the exact real gotcha complaint-tracking/router.js's own GET
// /api/complaint-tracking comment documents hitting twice already in this
// codebase (Supabase/PostgREST silently caps an unpaginated select at its
// own default max-rows, with no error and no truncation notice). At today's
// real 2,733-row volume this matters immediately (well past 1000); fixed
// here from the start rather than waiting to hit it a third time.
// ============================================================
async function fetchUnassessedComplaints(limit) {
  const rows = [];
  for (let from = 0; rows.length < limit; from += FETCH_PAGE_SIZE) {
    const pageSize = Math.min(FETCH_PAGE_SIZE, limit - rows.length);
    const { data, error } = await supabase
      .from('complaints')
      .select('id, description, needs_human_call, category, flagged_protected_class')
      .is('severity_tier', null)
      .eq('held_legal_fair_housing', false)
      .not('description', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break; // fewer than asked for — this was the last page.
  }
  return rows;
}

// ============================================================
// buildBatchRequest — one real Anthropic batch request per row.
// custom_id = the complaint's own id directly (see this file's header,
// point 2) — no token-generation scheme needed.
// ============================================================
// max_tokens reused directly from severityRubric.SEVERITY_MAX_TOKENS (never
// a second literal here) — this is the exact same classification call as
// classifySeverity()'s, just submitted via the Batches API instead of a
// synchronous one, so it needs the exact same token budget. Bumped
// 512 -> 1024 2026-10-02 after a real batch row (complaint d471ed02-06d3-
// 4257-91eb-9643725bbe72) truncated at 512 on three separate real runs —
// see severity-rubric.js's own comment on SEVERITY_MAX_TOKENS for the full
// story. Unlike the live, synchronous path, a batch request can't retry
// in-process on a truncation (there is no live call to retry — see
// applyOneSeverityResult below), so an under-sized budget here is worse: it
// doesn't just risk one bad attempt, it deterministically re-truncates the
// exact same row on every future run until the budget itself is raised.
function buildBatchRequest(row) {
  const prompt = severityRubric.buildSeverityPrompt(row.description);
  return {
    custom_id: row.id,
    params: {
      model: 'claude-sonnet-5',
      max_tokens: severityRubric.SEVERITY_MAX_TOKENS,
      output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    },
  };
}

// ============================================================
// writeAuditLog — same shape/defaults convention as significance-pass.js's
// and complaint-tracking/router.js's own copies of this helper (neither is
// exported for reuse — "each tool owns its own small helper," the existing
// convention both of those files already follow for the identical reason).
// ============================================================
async function writeAuditLog({ action, entity_type, entity_id, actor_type, actor_id, risk_level, privacy_category, property_id, details }) {
  const { error } = await supabase.from('audit_log').insert({
    action,
    entity_type,
    entity_id,
    actor_type: actor_type || 'system',
    actor_id: actor_id || SEVERITY_BATCH_TOOL_VERSION,
    privacy_category: privacy_category || 'processing',
    risk_level: risk_level || 'low',
    property_id: property_id || null,
    details: details || {},
  });
  if (error) console.error(`[severity-batch] audit_log insert failed for ${action}:`, error.message);
}

// ============================================================
// submitSeverityBatch — step 1. THE GOVERNANCE GATE lives here, not only in
// the CLI (run-severity-batch.js) — defense in depth, same posture the
// database's own CHECK constraint takes for the floor logic: this function
// must refuse to run for ANY caller, not just one that happens to go through
// the CLI's own guard. Checked first, before any Supabase or Anthropic call.
// ============================================================
async function submitSeverityBatch({ limit } = {}) {
  if (process.env.SEVERITY_BATCH_GOVERNANCE_CLEARED !== 'true') {
    throw new Error(
      "submitSeverityBatch refused: SEVERITY_BATCH_GOVERNANCE_CLEARED is not set to 'true'. This tool is built and tested but not cleared to run against real data — " +
      "Peter has not yet applied the severity_tier schema migrations, and Mason's review of the accommodation/protected-class interaction is still in progress (relayed via Jarvis). " +
      "Do not set this environment variable yourself; only Jarvis, after confirming both have actually cleared, should turn this on."
    );
  }

  const existing = readState();
  if (existing && !existing.results_retrieved_at) {
    return { submitted: false, reason: 'unfinished_batch_exists', state: existing };
  }

  const targetCount = Math.min(limit || sigBatch.MAX_BATCH_REQUESTS, sigBatch.MAX_BATCH_REQUESTS);
  const rows = await fetchUnassessedComplaints(targetCount);
  if (rows.length === 0) return { submitted: false, reason: 'nothing_eligible', state: null };

  const entries = rows.map((row) => {
    const request = buildBatchRequest(row);
    return { complaintId: row.id, request, bytes: sigBatch.sizeOfRequestBytes(request) };
  });

  const oversized = entries.filter((e) => e.bytes > sigBatch.MAX_BATCH_BYTES);
  if (oversized.length > 0) {
    console.error(`[severity-batch] ${oversized.length} row(s) too large to ever fit in one batch request — skipped, left unassessed, needs manual review: ${oversized.map((e) => e.complaintId).join(', ')}`);
  }
  const eligible = entries.filter((e) => e.bytes <= sigBatch.MAX_BATCH_BYTES);
  if (eligible.length === 0) return { submitted: false, reason: 'nothing_eligible_after_skips', state: null, skippedOversized: oversized.length };

  const chunks = sigBatch.partitionIntoChunks(eligible, sigBatch.MAX_BATCH_REQUESTS, sigBatch.MAX_BATCH_BYTES);
  const firstChunk = chunks[0];
  if (chunks.length > 1) {
    console.error(`[severity-batch] NOTE: ${eligible.length} eligible row(s) split into ${chunks.length} chunk(s) by real byte size/request count — this call submits ONLY the first chunk (${firstChunk.length} row(s)); re-run this same command after it completes to continue with the rest (this tool tracks one in-flight batch at a time — see this file's own header).`);
  }

  const anthropic = anthropicClient();
  const response = await anthropic.beta.messages.batches.create({ requests: firstChunk.map((e) => e.request) }); // real, billed submission — everything above this line is read-only/local and safe to re-run.

  const state = {
    anthropic_batch_id: response.id,
    anthropic_status: response.processing_status,
    submitted_at: new Date().toISOString(),
    complaint_ids: firstChunk.map((e) => e.complaintId),
    results_retrieved_at: null,
    submitted_by: SEVERITY_BATCH_TOOL_VERSION,
  };
  writeState(state);

  return {
    submitted: true,
    state,
    requestCount: firstChunk.length,
    skippedOversized: oversized.length,
    remainingEligibleAfterThisChunk: eligible.length - firstChunk.length,
  };
}

// ============================================================
// applyOneSeverityResult — the write-back decision for ONE complaint.
// One-shot, no-in-batch-retry contract — same posture significance-batch.js's
// own applyOneBatchItem() already takes for Call 1: anything other than a
// successfully-parsed 'succeeded' result writes NOTHING, leaving
// severity_tier NULL so the row stays naturally eligible for the next run
// (see fetchUnassessedComplaints()'s own comment — this is the entire retry
// mechanism, no separate bookkeeping needed).
//
// Re-fetches the row FRESH at write-back time rather than trusting the
// snapshot taken at submission — needs_human_call/category/
// flagged_protected_class are the exact inputs the safety floor depends on,
// and a batch can sit at Anthropic for hours; using stale values here would
// be exactly the kind of "calibration-likely, not guaranteed" gap Asimov's
// review (20261002020000's own header) was about. Also re-checks
// held_legal_fair_housing and severity_tier themselves (defense in depth,
// idempotent against a re-run or a race), and the final UPDATE itself is
// filtered on `.is('severity_tier', null)` as one more belt-and-suspenders
// layer against a double-write.
// @returns {Promise<'written'|'no_row_written'>}
// ============================================================
async function applyOneSeverityResult({ complaintId, result }) {
  if (result.type !== 'succeeded') {
    console.error(`[severity-batch] complaint ${complaintId}: batch result "${result.type}" — no row written, stays eligible for the next run.`);
    return 'no_row_written';
  }

  const content = (result.message && result.message.content) || [];
  const textBlock = content.find((b) => b.type === 'text');
  const parsed = textBlock ? severityRubric.parseSeverityResponse(textBlock.text) : null;
  if (!parsed) {
    // Distinguished from a generic unparseable response (e.g. genuinely
    // malformed JSON) so this is diagnosable at a glance — a truncation is
    // a token-budget problem, worth raising SEVERITY_MAX_TOKENS further if
    // it recurs, not a prompt/parser bug. Either way the outcome is the
    // same, and is already retry-worthy by construction, same as every
    // other non-parse here: severity_tier stays NULL, so
    // fetchUnassessedComplaints() naturally re-offers this row to the very
    // next run — no separate retry bookkeeping exists or is needed (see
    // this file's own header).
    const truncated = result.message && result.message.stop_reason === 'max_tokens';
    console.error(
      truncated
        ? `[severity-batch] complaint ${complaintId}: truncated by max_tokens before the JSON closed (no in-batch retry is possible) — no row written, stays eligible for the next run.`
        : `[severity-batch] complaint ${complaintId}: succeeded per Anthropic but the response body did not parse (no in-batch retry is possible) — no row written, stays eligible for the next run.`
    );
    return 'no_row_written';
  }

  const { data: row, error } = await supabase
    .from('complaints')
    // owner_instruction_rejected added 2026-10-02 (Mason governance review,
    // gap #2) — the floor below needs it, read fresh same as the other four
    // columns here, never trusted from the submission-time snapshot.
    .select('id, needs_human_call, category, flagged_protected_class, held_legal_fair_housing, severity_tier, owner_instruction_rejected')
    .eq('id', complaintId)
    .maybeSingle();
  if (error) throw error;
  if (!row) {
    console.error(`[severity-batch] complaint ${complaintId}: no longer exists at write-back time — skipped.`);
    return 'no_row_written';
  }
  if (row.held_legal_fair_housing) {
    console.error(`[severity-batch] complaint ${complaintId}: now held_legal_fair_housing=true — a held row never gets an automated severity assessment. Skipped.`);
    return 'no_row_written';
  }
  if (row.severity_tier != null) {
    console.error(`[severity-batch] complaint ${complaintId}: already severity-assessed (severity_tier=${row.severity_tier}) — skipped, not re-written.`);
    return 'no_row_written';
  }

  const floored = severityRubric.applySeverityFloor({
    tier: parsed.tier,
    why: parsed.why,
    needs_human_call: row.needs_human_call,
    category: row.category,
    flagged_protected_class: row.flagged_protected_class,
    owner_instruction_rejected: row.owner_instruction_rejected,
  });
  const nowIso = new Date().toISOString();

  const { data: updated, error: updateErr } = await supabase
    .from('complaints')
    .update({
      severity_tier: floored.tier,
      severity_rationale: floored.why,
      severity_assessed_at: nowIso,
      severity_rubric_version: severityRubric.SEVERITY_RUBRIC_VERSION,
    })
    .eq('id', complaintId)
    .is('severity_tier', null) // idempotency guard at the write itself — never overwrite an already-set value, even under a race with another writer.
    .select()
    .maybeSingle();
  if (updateErr) throw updateErr;
  if (!updated) {
    console.error(`[severity-batch] complaint ${complaintId}: lost a race — severity_tier was set by something else between the read above and this update. Skipped, not overwritten.`);
    return 'no_row_written';
  }

  await writeAuditLog({
    action: 'complaint_tracking.severity_assessed',
    entity_type: 'complaint',
    entity_id: complaintId,
    actor_type: 'system',
    actor_id: SEVERITY_BATCH_TOOL_VERSION,
    risk_level: 'medium',
    privacy_category: 'processing',
    details: {
      severity_tier: floored.tier,
      severity_rationale: floored.why,
      severity_rubric_version: severityRubric.SEVERITY_RUBRIC_VERSION,
      floored: floored.floored,
      raw_tier_before_floor: floored.floored ? parsed.tier : null,
    },
  });

  return 'written';
}

// ============================================================
// checkAndWriteBackSeverityBatch — step 2. Safe to re-run repeatedly: checks
// the one in-flight batch (if any), and only streams/applies results once
// Anthropic itself reports 'ended' — mirrors significance-batch.js's own
// checkAndResumeOneBatch() shape, reusing drainInGroups/mapWithConcurrency
// at that file's own WRITEBACK_CONCURRENCY for the identical "bounded
// concurrency, never buffer the whole results stream" reasons given there.
// Not gated behind SEVERITY_BATCH_GOVERNANCE_CLEARED — by the time a batch
// exists to check, submission (which IS gated) has already happened; this
// only ever completes work already underway, same as significance-batch.js's
// own writeBackBatch() is never re-gated behind anything submitBatch()
// already checked.
// ============================================================
async function checkAndWriteBackSeverityBatch() {
  const state = readState();
  if (!state) return { found: false };
  if (state.results_retrieved_at) return { found: true, alreadyComplete: true, state };

  const anthropic = anthropicClient();
  const remote = await anthropic.beta.messages.batches.retrieve(state.anthropic_batch_id);
  state.anthropic_status = remote.processing_status;
  writeState(state);

  if (remote.processing_status !== 'ended') {
    return { found: true, alreadyComplete: false, status: remote.processing_status, state };
  }

  const stream = await anthropic.beta.messages.batches.results(state.anthropic_batch_id);
  const summary = { processed: 0, written: 0, no_row_written: 0, errors: 0 };

  for await (const group of sigBatch.drainInGroups(stream, sigBatch.WRITEBACK_CONCURRENCY)) {
    await sigBatch.mapWithConcurrency(group, sigBatch.WRITEBACK_CONCURRENCY, async (r) => {
      try {
        const outcome = await applyOneSeverityResult({ complaintId: r.custom_id, result: r.result });
        summary.processed++;
        if (outcome === 'written') summary.written++; else summary.no_row_written++;
      } catch (err) {
        console.error(`[severity-batch] write-back failed for complaint ${r.custom_id}:`, err.message);
        summary.errors++;
      }
    });
  }

  state.results_retrieved_at = new Date().toISOString();
  writeState(state);

  return { found: true, alreadyComplete: true, justCompleted: true, summary, state };
}

module.exports = {
  SEVERITY_BATCH_TOOL_VERSION,
  STATE_PATH,
  readState,
  writeState,
  clearState,
  FETCH_PAGE_SIZE,
  fetchUnassessedComplaints,
  buildBatchRequest,
  writeAuditLog,
  submitSeverityBatch,
  applyOneSeverityResult,
  checkAndWriteBackSeverityBatch,
  _setSupabaseClientForTesting,
  _setAnthropicClientForTesting,
};
