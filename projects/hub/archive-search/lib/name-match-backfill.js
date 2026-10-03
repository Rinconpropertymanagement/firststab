/**
 * lib/name-match-backfill.js
 *
 * The RETROACTIVE name-match backfill batch tool — Jarvis-relayed build
 * task, 2026-10-02. Applies the SAME narrower, Mason-cleared, human-
 * confirmed name-based-matching design the live pipeline already runs
 * (significance-pass.js's IDENTIFICATION_BLOCK_WITH_NAME / applyCall1Result /
 * findNameMatchCandidates — see that file's own header for the full
 * governance context) to the existing ~1,800+ complaints where
 * needs_matching = TRUE, instead of only new conversations going forward.
 *
 * Mirrors lib/severity-batch.js's own Message Batches API architecture
 * (read that file's header in full first) — deliberately, for the same
 * reason severity-batch.js gives for mirroring significance-batch.js: this
 * job's resumability lives on THE SAME ROW being read (complaints.
 * retroactive_name_match_checked_at IS NULL — migration 20261002070000,
 * Neo), so none of significance-batch.js's run/chunk/batch-item tracking
 * tables are needed, and complaints.id (a single UUID) is used directly as
 * the Anthropic custom_id, exactly as severity-batch.js already does for
 * the identical reason. See that file's own "WHY THIS IS SIMPLER THAN
 * significance-batch.js's RUN/CHUNK/BATCH SCHEMA" section — it applies here
 * verbatim, not re-derived.
 *
 * ============================================================================
 * OPERATIONAL WARNING — DO NOT RUN THIS FOR REAL YET
 * ============================================================================
 * This module makes real, billed Anthropic API calls and writes real rows
 * into `complaints` (the suggested_subject_ columns, and
 * retroactive_name_match_checked_at).
 * submitNameMatchBackfillBatch() REFUSES to run (throws, before touching
 * Anthropic or Supabase) unless NAME_MATCH_BACKFILL_GOVERNANCE_CLEARED=true
 * is set in the environment — see that function's own comment. As of this
 * build, it is NOT set anywhere: Peter has not yet applied the schema
 * migration this tool depends on (supabase/migrations/
 * 20261002070000_add_retroactive_name_match_checked_at_to_complaints.sql),
 * and whether this RETROACTIVE run needs its own separate Asimov/Mason
 * sign-off (distinct from the live-pipeline sign-off already on record for
 * NEW complaints — 20261002060000's own migration header flags this as
 * Jarvis's call to confirm, not a schema question) has not been confirmed.
 * Do not flip that env var on without Jarvis confirming both have happened.
 *
 * ============================================================================
 * WHAT THIS TOOL DOES, PER ELIGIBLE COMPLAINT (needs_matching = TRUE,
 * held_legal_fair_housing = FALSE, retroactive_name_match_checked_at IS
 * NULL, source_missive_conversation_id IS NOT NULL)
 * ============================================================================
 *   1. Resolve the complaint's mailbox_key via missive_conversation_
 *      significance (complaints carries no mailbox_key column — the same
 *      join path complaint-tracking/router.js's own
 *      resolveMailboxAnchorForConversation() already uses for the live
 *      name-match confirm/reject routes; read for real here, not assumed —
 *      see resolveMailboxKeyForConversation() below), then re-fetch the
 *      conversation's thread text via significance-pass.js's own exported
 *      buildConversationContext() — reused, not reimplemented.
 *   2. ONE combined AI call per complaint, asking the model to cite (never
 *      resolve) a property/vendor/name reference in the thread — the exact
 *      same IDENTIFICATION_BLOCK_WITH_NAME wording the live pipeline's Call
 *      1 already uses for this, imported directly from significance-pass.js
 *      (see buildIdentificationPrompt() below for why this is a narrower,
 *      standalone prompt rather than a call into buildCall1Prompt() itself).
 *   3. property_id: the complaint's own existing property_id if it already
 *      has one (addressMatch or an earlier content-extraction already
 *      resolved it) — skip re-resolving. Otherwise, resolve the AI's own
 *      cited property_text against the real properties directory via
 *      significance-pass.js's exported resolveUniqueMatch(), the identical
 *      deterministic citation-verification function applyCall1Result() uses
 *      for the live pipeline. This resolved property_id is used ONLY
 *      in-memory, to corroborate the name match below — see "A DELIBERATE
 *      SCOPE DECISION: PROPERTY_ID IS NEVER WRITTEN BACK" further down for
 *      why it is not persisted onto the complaint row.
 *   4. findNameMatchCandidates({ nameText, propertyId }) — the identical,
 *      unmodified live-pipeline function (significance-pass.js) — run with
 *      whatever property_id resulted from step 3. Mason's hard
 *      corroboration requirement (point 2) is enforced exactly as it is in
 *      the live pipeline: no property_id at all (neither stored nor
 *      resolvable from this call) means no candidate lookup is even
 *      attempted, full stop.
 *   5. Real candidate found -> write suggested_subject_type/_name_text/
 *      _candidate_ids/_extracted_by/_at (same five columns the live pipeline
 *      writes) AND retroactive_name_match_checked_at. No candidate -> write
 *      ONLY retroactive_name_match_checked_at; the five suggestion columns
 *      stay untouched (NULL), satisfying complaints_suggested_subject_
 *      fields_together's all-or-nothing lockstep by construction (an UPDATE
 *      that never names those five columns cannot violate a CHECK on them).
 *
 * ============================================================================
 * A DELIBERATE SCOPE DECISION: PROPERTY_ID IS NEVER WRITTEN BACK
 * ============================================================================
 * The build task's own enumerated outputs are exactly two: the five
 * suggested_subject_* columns (when a candidate is found) and
 * retroactive_name_match_checked_at (always). A property_id this tool
 * freshly resolves from the AI's own content-extracted citation (step 3
 * above) is used ONLY to gate/corroborate the name-match lookup — it is
 * never persisted onto complaints.property_id, and complaints.
 * needs_matching (a column set once, at creation, with no existing
 * retroactive-recompute code path anywhere in this codebase) is never
 * touched either. Writing it back was considered and rejected: it is not
 * one of the task's enumerated writes, and needs_matching's own formula
 * (property_id/subject_type/vendor_id all absent) was never designed to be
 * revisited after the fact — doing so here would be undocumented scope
 * creep into a question nobody has actually decided (should a retroactively
 * resolved property_id flip needs_matching? should it change what the
 * review UI shows?). Flagged explicitly, not silently assumed, as a real
 * candidate follow-up Peter may want later, not built here.
 *
 * ============================================================================
 * WHY NO DEDICATED audit_log ENTRY FOR "SUGGESTION FOUND" — MATCHING
 * EXISTING PRECEDENT, NOT INVENTING A NEW ONE
 * ============================================================================
 * Checked directly against significance-pass.js before assuming either
 * answer: applyCall1Result() computes nameMatchSuggestion and
 * createComplaintRow() attaches it to a brand-new complaint's insertRow
 * (Object.assign(insertRow, nameMatchSuggestion)), but NEITHER function
 * writes a distinct audit_log entry for the suggestion itself — the
 * generic 'complaint_tracking.created' entry's own `details` object doesn't
 * even mention the suggested_subject_* fields. The suite's own PART 23
 * tests (archive-search/test/run-tests.js) confirm this directly: the
 * "real nameMatchSuggestion attached" scenario asserts on the written row,
 * never on a second audit_log entry. The live pipeline's one real
 * audit-trail requirement for this feature (Mason's point 3) is satisfied
 * entirely on the HUMAN-REVIEW side (complaint-tracking/router.js's
 * name-match/confirm route writes a missive_message_links row + the
 * human_confirmed_subject_* columns) — never on the AI-suggestion side.
 * This tool matches that precedent exactly: no new audit_log convention is
 * invented here for either outcome (candidate found or not). If Peter or
 * Asimov later decides the retroactive run specifically needs its own
 * audit trail (a reasonable ask, given this is a 1,800+-row backfill, not
 * a per-conversation live trickle), that is a new, separate, scoped
 * request — not assumed or pre-built here.
 *
 * ============================================================================
 * COULD THIS TOOL AND lib/severity-batch.js COLLIDE? — WORKED THROUGH, NOT
 * ASSUMED. SEE lib/name-match-backfill-lock.js'S OWN HEADER FOR THE ANSWER.
 * ============================================================================
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const significancePass = require('./significance-pass');
// Whole-module reference — reusing significance-batch.js's own generic,
// pure utilities, same convention severity-batch.js already follows (see
// that file's own comment on why these are safe to reuse directly).
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

const NAME_MATCH_BACKFILL_TOOL_VERSION = 'archive-search-retroactive-name-match-backfill-v1';

// Where the one-in-flight-batch state lives — same "local, single-host,
// fails safe on reboot" design severity-batch.js's own STATE_PATH already
// uses (a dedicated JSON file, not a new DB table — this job's one
// genuinely stateful fact, which Anthropic batch is in flight, has no home
// anywhere in `complaints` itself).
const STATE_PATH = process.env.NAME_MATCH_BACKFILL_STATE_PATH
  || path.join(os.tmpdir(), 'complaint-name-match-backfill-state.json');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    return null; // missing, or corrupt/half-written — "no in-flight batch known," never a hard failure.
  }
}
function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
function clearState() {
  try { fs.unlinkSync(STATE_PATH); } catch (_) { /* already gone — fine */ }
}

// Same cheap, arbitrary, bounded-round-trip paging size convention as
// severity-batch.js's FETCH_PAGE_SIZE.
const FETCH_PAGE_SIZE = 500;

// ============================================================
// fetchEligibleComplaints — THE driver query. retroactive_name_match_
// checked_at IS NULL is the entire resumability contract (migration
// 20261002070000's own header) — a row this query returns is, by
// definition, a row this retroactive tool has never examined.
//
// held_legal_fair_housing = false is defense in depth, not reliance on the
// database CHECK alone — same explicit instruction severity-batch.js's own
// fetchUnassessedComplaints() comment already states for the identical
// reason: a held row's retroactive_name_match_checked_at is forced to stay
// NULL forever by complaints_held_excludes_ai_fields, so it would be
// returned here on every call if not excluded explicitly — excluded here so
// this tool never even builds a request for one.
//
// source_missive_conversation_id IS NOT NULL — this tool's own equivalent
// of severity-batch.js's `description IS NOT NULL` filter: nothing to read
// without a conversation to re-fetch. A manually-reported complaint
// (source = 'manual_staff') can have needs_matching = TRUE with no AI
// identification ever attempted and no conversation to read — same
// "nothing to classify, leave it unassessed rather than send empty input"
// posture, applied here to "nothing to re-fetch." These rows are excluded
// at the query level (never fetched, never stamped) rather than fetched
// and then skipped, for the same reason severity-batch.js's own query
// filters out null-description rows at the query itself, not after.
//
// PAGED via .range(), never a single unpaginated .select() — same real,
// already-hit-twice Supabase/PostgREST default-row-cap gotcha severity-
// batch.js's own fetchUnassessedComplaints() comment documents, and the
// exact scale (1,800+ rows) this build task's own numbers describe.
// ============================================================
async function fetchEligibleComplaints(limit) {
  const rows = [];
  for (let from = 0; rows.length < limit; from += FETCH_PAGE_SIZE) {
    const pageSize = Math.min(FETCH_PAGE_SIZE, limit - rows.length);
    const { data, error } = await supabase
      .from('complaints')
      .select('id, property_id, source_missive_conversation_id')
      .eq('needs_matching', true)
      .eq('held_legal_fair_housing', false)
      .is('retroactive_name_match_checked_at', null)
      .not('source_missive_conversation_id', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break; // fewer than asked for — this was the last page.
  }
  return rows;
}

// ============================================================
// resolveMailboxKeyForConversation — complaints carries no mailbox_key
// column (missive_conversation_id is only unique WITHIN a mailbox — the
// same real, already-accepted multi-mailbox ambiguity significance-pass.js's
// findExistingComplaintForConversation() and complaint-tracking/router.js's
// resolveMailboxAnchorForConversation() both already document and accept,
// not re-litigated here). Read router.js's real implementation before
// writing this, per the build task's own instruction not to assume the
// join path: this is the same query that function's own first half runs
// (missive_conversation_significance.mailbox_key, keyed on missive_
// conversation_id alone) — the message-anchor lookup router.js's version
// also does is NOT needed here, since buildConversationContext() below
// fetches every message for the conversation itself, not just one anchor.
// ============================================================
async function resolveMailboxKeyForConversation(missive_conversation_id) {
  const { data, error } = await supabase
    .from('missive_conversation_significance')
    .select('mailbox_key')
    .eq('missive_conversation_id', missive_conversation_id)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? data.mailbox_key : null;
}

// ============================================================
// buildIdentificationPrompt — a narrower, standalone prompt, NOT a call
// into significance-pass.js's buildCall1Prompt(). That function's full
// prompt also asks for resolution_status/category/why/tone_trend — all
// four already resolved and stored on this complaint (or its parent
// significance row) from the FIRST time Call 1 ran; re-asking the model to
// re-derive them here would be a second, redundant, billed judgment this
// build never asked for. Only the identification citation is genuinely
// still missing for a needs_matching=TRUE complaint, so only that section
// is asked for — reusing IDENTIFICATION_BLOCK_WITH_NAME's own exact,
// Mason-cleared wording verbatim (imported directly from
// significance-pass.js, never copy-pasted) for the part that IS reused.
//
// Always asks for property_text AND vendor_text, even on a complaint that
// already has a resolved property_id (vendor_text is never used by this
// tool at all — see applyOneNameMatchResult() below). Deliberately one
// prompt shape for both cases (already-propertied vs. not), rather than a
// second, narrower "name only" variant: the build task's own two described
// branches differ only in what happens AFTER the AI call (whether property_
// text gets resolved and used, or is ignored in favor of the already-stored
// property_id) — Q's own judgment call that one shared prompt/parser is
// simpler and carries zero drift risk between two near-identical prompt
// strings, at the cost of a few wasted output tokens on the branch that
// doesn't need property_text. Simple is better than clever, per CLAUDE.md.
// ============================================================
function buildIdentificationPrompt(threadText) {
  return `You are reviewing one email conversation from a Southern California property management company's (Rincon Management) shared-inbox archive. This conversation was already triaged once and is now a tracked complaint — but no specific tenant or owner has been identified for it yet.

${significancePass.IDENTIFICATION_BLOCK_WITH_NAME}

Conversation (oldest message first):
"""
${threadText}
"""

Respond with EXACTLY one JSON object, no markdown fence, no explanation before or after it:
{"identification": {"property_text": "quoted text"|null, "vendor_text": "quoted text"|null, "name_text": "quoted text"|null}}`;
}

// ============================================================
// parseIdentificationResponse — a dedicated, narrower parser, not a reuse
// of significance-pass.js's parseCall1Response(): that function validates
// resolution_status/category/why/tone_trend fields this prompt never asks
// for (and would therefore always reject as missing) — reusing it would
// mean fabricating dummy values to satisfy a parser built for a bigger
// shape, a worse violation of "don't reimplement" than writing this
// narrower, honest parser for the shape this tool actually produces. Same
// find-first-{-last-}/defensive-markdown-fence-tolerance discipline as
// every other parser in this codebase (parseCall1Response,
// parseSeverityResponse). vendor_text is parsed (for shape-validation
// symmetry with the live prompt) but never read by any caller in this file.
// ============================================================
function parseIdentificationResponse(rawText) {
  if (typeof rawText !== 'string') return null;
  const start = rawText.indexOf('{');
  const end = rawText.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;

  let parsed;
  try {
    parsed = JSON.parse(rawText.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  if (typeof parsed.identification !== 'object' || parsed.identification === null) return null;

  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    property_text: clean(parsed.identification.property_text),
    vendor_text: clean(parsed.identification.vendor_text),
    name_text: clean(parsed.identification.name_text),
  };
}

// Same generous token budget as significance-pass.js's runCall1()/
// severity-rubric.js's classifySeverity() (1024) rather than guessing a
// smaller number from scratch — this codebase has already hit a real
// truncation bug TWICE from under-budgeting a single-call JSON response
// (severity-rubric.js's own SEVERITY_MAX_TOKENS comment tells that exact
// story); this prompt's expected output is smaller than either of those,
// but the downside of under-budgeting (a silent, permanently-repeating
// per-row truncation in a no-retry batch context — see applyOneNameMatch
// Result()'s own comment) is worse than the upside of a tighter budget.
const NAME_MATCH_BACKFILL_MAX_TOKENS = 1024;

// ============================================================
// buildBatchRequest — one real Anthropic batch request per complaint.
// custom_id = the complaint's own id directly — same convention severity-
// batch.js already uses, for the identical reason (complaints.id is a
// single UUID, well under Anthropic's 64-character custom_id cap; no
// token-generation/collision-avoidance scheme is needed).
// ============================================================
function buildBatchRequest({ complaintId, threadText }) {
  const prompt = buildIdentificationPrompt(threadText);
  return {
    custom_id: complaintId,
    params: {
      model: 'claude-sonnet-5',
      max_tokens: NAME_MATCH_BACKFILL_MAX_TOKENS,
      output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    },
  };
}

// ============================================================
// submitNameMatchBackfillBatch — step 1. THE GOVERNANCE GATE lives here,
// not only in the CLI — defense in depth, same posture severity-batch.js's
// own submitSeverityBatch() takes. Checked first, before any Supabase or
// Anthropic call.
// ============================================================
async function submitNameMatchBackfillBatch({ limit } = {}) {
  if (process.env.NAME_MATCH_BACKFILL_GOVERNANCE_CLEARED !== 'true') {
    throw new Error(
      "submitNameMatchBackfillBatch refused: NAME_MATCH_BACKFILL_GOVERNANCE_CLEARED is not set to 'true'. This tool is built and tested but not cleared to run against real data — " +
      "Peter has not yet applied the retroactive_name_match_checked_at schema migration, and whether this retroactive run needs its own separate Asimov/Mason sign-off is still unconfirmed (relayed via Jarvis). " +
      "Do not set this environment variable yourself; only Jarvis, after confirming both have actually cleared, should turn this on."
    );
  }

  const existing = readState();
  if (existing && !existing.results_retrieved_at) {
    return { submitted: false, reason: 'unfinished_batch_exists', state: existing };
  }

  const targetCount = Math.min(limit || sigBatch.MAX_BATCH_REQUESTS, sigBatch.MAX_BATCH_REQUESTS);
  const complaints = await fetchEligibleComplaints(targetCount);
  if (complaints.length === 0) return { submitted: false, reason: 'nothing_eligible', state: null };

  const entries = [];
  const skippedUnreadable = [];
  for (const complaint of complaints) {
    try {
      const mailbox_key = await resolveMailboxKeyForConversation(complaint.source_missive_conversation_id);
      if (!mailbox_key) { skippedUnreadable.push(complaint.id); continue; } // no significance row anchors this conversation — nothing real to read; left unchecked, same as severity-batch.js's own oversized-row skip.
      const context = await significancePass.buildConversationContext(mailbox_key, complaint.source_missive_conversation_id);
      if (!context || !context.threadText) { skippedUnreadable.push(complaint.id); continue; } // the conversation's own messages are gone — nothing to re-read.
      const request = buildBatchRequest({ complaintId: complaint.id, threadText: context.threadText });
      entries.push({ complaintId: complaint.id, request, bytes: sigBatch.sizeOfRequestBytes(request) });
    } catch (err) {
      console.error(`[name-match-backfill] complaint ${complaint.id}: failed to build a batch request (left unchecked, retried next run): ${err.message}`);
      skippedUnreadable.push(complaint.id);
    }
  }
  if (skippedUnreadable.length > 0) {
    console.error(`[name-match-backfill] ${skippedUnreadable.length} complaint(s) skipped — no readable conversation content: ${skippedUnreadable.join(', ')}`);
  }
  if (entries.length === 0) return { submitted: false, reason: 'nothing_eligible_after_skips', state: null, skippedUnreadable: skippedUnreadable.length };

  const oversized = entries.filter((e) => e.bytes > sigBatch.MAX_BATCH_BYTES);
  if (oversized.length > 0) {
    console.error(`[name-match-backfill] ${oversized.length} row(s) too large to ever fit in one batch request — skipped, left unchecked, needs manual review: ${oversized.map((e) => e.complaintId).join(', ')}`);
  }
  const eligible = entries.filter((e) => e.bytes <= sigBatch.MAX_BATCH_BYTES);
  if (eligible.length === 0) return { submitted: false, reason: 'nothing_eligible_after_skips', state: null, skippedOversized: oversized.length };

  const chunks = sigBatch.partitionIntoChunks(eligible, sigBatch.MAX_BATCH_REQUESTS, sigBatch.MAX_BATCH_BYTES);
  const firstChunk = chunks[0];
  if (chunks.length > 1) {
    console.error(`[name-match-backfill] NOTE: ${eligible.length} eligible complaint(s) split into ${chunks.length} chunk(s) by real byte size/request count — this call submits ONLY the first chunk (${firstChunk.length} row(s)); re-run this same command after it completes to continue with the rest (this tool tracks one in-flight batch at a time — see this file's own header).`);
  }

  const anthropic = anthropicClient();
  const response = await anthropic.beta.messages.batches.create({ requests: firstChunk.map((e) => e.request) }); // real, billed submission — everything above this line is read-only/local and safe to re-run.

  const state = {
    anthropic_batch_id: response.id,
    anthropic_status: response.processing_status,
    submitted_at: new Date().toISOString(),
    complaint_ids: firstChunk.map((e) => e.complaintId),
    results_retrieved_at: null,
    submitted_by: NAME_MATCH_BACKFILL_TOOL_VERSION,
  };
  writeState(state);

  return {
    submitted: true,
    state,
    requestCount: firstChunk.length,
    skippedUnreadable: skippedUnreadable.length,
    skippedOversized: oversized.length,
    remainingEligibleAfterThisChunk: eligible.length - firstChunk.length,
  };
}

// ============================================================
// applyOneNameMatchResult — the write-back decision for ONE complaint.
// One-shot, no-in-batch-retry contract — same posture severity-batch.js's
// own applyOneSeverityResult() already takes: anything other than a
// successfully-parsed 'succeeded' result writes NOTHING, leaving
// retroactive_name_match_checked_at NULL so the row stays naturally
// eligible for the next run (fetchEligibleComplaints() above — this is the
// entire retry mechanism, no separate bookkeeping needed).
//
// Re-fetches the row FRESH at write-back time rather than trusting the
// snapshot taken at submission — held_legal_fair_housing and
// retroactive_name_match_checked_at itself are both re-checked (defense in
// depth, idempotent against a re-run or a race), and the final UPDATE
// itself is additionally filtered on `.is('retroactive_name_match_checked_at',
// null)` as one more belt-and-suspenders layer against a double-write —
// same three-layer discipline severity-batch.js's own applyOneSeverityResult
// already uses for severity_tier.
//
// propertyDirectory is fetched ONCE per batch run (checkAndWriteBackName
// MatchBackfillBatch, below) and passed in here — same "fetched once per
// batch run, not once per conversation" principle significance-pass.js's
// own fetchPropertyDirectory() comment already states, reused here rather
// than re-derived.
// @returns {Promise<'written_with_suggestion'|'written_no_suggestion'|'no_row_written'>}
// ============================================================
async function applyOneNameMatchResult({ complaintId, result, propertyDirectory }) {
  if (result.type !== 'succeeded') {
    console.error(`[name-match-backfill] complaint ${complaintId}: batch result "${result.type}" — no row written, stays eligible for the next run.`);
    return 'no_row_written';
  }

  const content = (result.message && result.message.content) || [];
  const textBlock = content.find((b) => b.type === 'text');
  const parsed = textBlock ? parseIdentificationResponse(textBlock.text) : null;
  if (!parsed) {
    const truncated = result.message && result.message.stop_reason === 'max_tokens';
    console.error(
      truncated
        ? `[name-match-backfill] complaint ${complaintId}: truncated by max_tokens before the JSON closed (no in-batch retry is possible) — no row written, stays eligible for the next run.`
        : `[name-match-backfill] complaint ${complaintId}: succeeded per Anthropic but the response body did not parse (no in-batch retry is possible) — no row written, stays eligible for the next run.`
    );
    return 'no_row_written';
  }

  const { data: row, error } = await supabase
    .from('complaints')
    .select('id, property_id, held_legal_fair_housing, retroactive_name_match_checked_at')
    .eq('id', complaintId)
    .maybeSingle();
  if (error) throw error;
  if (!row) {
    console.error(`[name-match-backfill] complaint ${complaintId}: no longer exists at write-back time — skipped.`);
    return 'no_row_written';
  }
  if (row.held_legal_fair_housing) {
    console.error(`[name-match-backfill] complaint ${complaintId}: now held_legal_fair_housing=true — a held row never gets an automated retroactive name-match check, even just to record "checked, found nothing." Skipped.`);
    return 'no_row_written';
  }
  if (row.retroactive_name_match_checked_at != null) {
    console.error(`[name-match-backfill] complaint ${complaintId}: already checked (retroactive_name_match_checked_at set) — skipped, not re-written.`);
    return 'no_row_written';
  }

  // Step 3 of this file's own header: use the complaint's own stored
  // property_id if it has one; only resolve the AI's own cited property_text
  // against the real directory when it doesn't. Never re-resolves (or
  // overwrites) an already-known property_id.
  let propertyId = row.property_id || null;
  if (!propertyId && parsed.property_text) {
    const propertyMatch = significancePass.resolveUniqueMatch(parsed.property_text, propertyDirectory, ['name', 'address']);
    if (propertyMatch) propertyId = propertyMatch.id;
  }

  // Mason's hard corroboration requirement (point 2), enforced exactly as
  // the live pipeline enforces it: no property_id at all (neither stored
  // nor resolvable from this call) means the candidate lookup is never even
  // attempted.
  let candidates = null;
  if (propertyId && parsed.name_text) {
    candidates = await significancePass.findNameMatchCandidates({ nameText: parsed.name_text, propertyId });
  }

  const nowIso = new Date().toISOString();
  const updateFields = { retroactive_name_match_checked_at: nowIso };
  if (candidates) {
    updateFields.suggested_subject_type = candidates.subject_type;
    updateFields.suggested_subject_name_text = parsed.name_text;
    updateFields.suggested_subject_candidate_ids = candidates.candidate_ids;
    updateFields.suggested_subject_extracted_by = NAME_MATCH_BACKFILL_TOOL_VERSION;
    updateFields.suggested_subject_at = nowIso;
  }

  const { data: updated, error: updateErr } = await supabase
    .from('complaints')
    .update(updateFields)
    .eq('id', complaintId)
    .is('retroactive_name_match_checked_at', null) // idempotency guard at the write itself — never overwrite an already-checked row, even under a race with another writer.
    .select()
    .maybeSingle();
  if (updateErr) throw updateErr;
  if (!updated) {
    console.error(`[name-match-backfill] complaint ${complaintId}: lost a race — retroactive_name_match_checked_at was set by something else between the read above and this update. Skipped, not overwritten.`);
    return 'no_row_written';
  }

  // No audit_log entry here — see this file's own header, "WHY NO
  // DEDICATED audit_log ENTRY FOR 'SUGGESTION FOUND'," for why this
  // matches existing precedent rather than inventing a new convention.

  return candidates ? 'written_with_suggestion' : 'written_no_suggestion';
}

// ============================================================
// checkAndWriteBackNameMatchBackfillBatch — step 2. Safe to re-run
// repeatedly: checks the one in-flight batch (if any), and only streams/
// applies results once Anthropic itself reports 'ended' — mirrors severity-
// batch.js's own checkAndWriteBackSeverityBatch() shape exactly. Not gated
// behind NAME_MATCH_BACKFILL_GOVERNANCE_CLEARED — by the time a batch
// exists to check, submission (which IS gated) has already happened.
// ============================================================
async function checkAndWriteBackNameMatchBackfillBatch() {
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

  const propertyDirectory = await significancePass.fetchPropertyDirectory();
  const stream = await anthropic.beta.messages.batches.results(state.anthropic_batch_id);
  const summary = { processed: 0, written_with_suggestion: 0, written_no_suggestion: 0, no_row_written: 0, errors: 0 };

  for await (const group of sigBatch.drainInGroups(stream, sigBatch.WRITEBACK_CONCURRENCY)) {
    await sigBatch.mapWithConcurrency(group, sigBatch.WRITEBACK_CONCURRENCY, async (r) => {
      try {
        const outcome = await applyOneNameMatchResult({ complaintId: r.custom_id, result: r.result, propertyDirectory });
        summary.processed++;
        if (outcome === 'written_with_suggestion') summary.written_with_suggestion++;
        else if (outcome === 'written_no_suggestion') summary.written_no_suggestion++;
        else summary.no_row_written++;
      } catch (err) {
        console.error(`[name-match-backfill] write-back failed for complaint ${r.custom_id}:`, err.message);
        summary.errors++;
      }
    });
  }

  state.results_retrieved_at = new Date().toISOString();
  writeState(state);

  return { found: true, alreadyComplete: true, justCompleted: true, summary, state };
}

module.exports = {
  NAME_MATCH_BACKFILL_TOOL_VERSION,
  STATE_PATH,
  readState,
  writeState,
  clearState,
  FETCH_PAGE_SIZE,
  fetchEligibleComplaints,
  resolveMailboxKeyForConversation,
  buildIdentificationPrompt,
  parseIdentificationResponse,
  NAME_MATCH_BACKFILL_MAX_TOKENS,
  buildBatchRequest,
  submitNameMatchBackfillBatch,
  applyOneNameMatchResult,
  checkAndWriteBackNameMatchBackfillBatch,
  _setSupabaseClientForTesting,
  _setAnthropicClientForTesting,
};
