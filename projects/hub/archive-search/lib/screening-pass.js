/**
 * lib/screening-pass.js
 * The Archive Search screening pass — archive-search-technical-spec.md,
 * "The Screening Pass — Concretely, Against Real Tables." Called only from
 * router.js's internalRouter, POST /api/archive-search/process-pending,
 * x-cron-secret-gated, NOT on any schedule (manually triggered only,
 * matching complaint-tracking/lib/process-pending-messages.js's own
 * posture and Design Decision 16's precedent). Nothing here executes until
 * runScreeningPassChunk() is explicitly called.
 *
 * ALSO IN THIS FILE, NOT PART OF THE LIVE PATH ABOVE: dryRunWideNetMeasurement()
 * (bottom of this file) — a separate, read-only, no-AI-calls, no-writes
 * function for archive-search-fair-housing-option-b-spec.md's Section 5
 * dry-run measurement. It is never called by runScreeningPassChunk(), never
 * called by any route, and does not change how process-pending behaves. See
 * its own header comment for why it lives here rather than in a separate
 * file or script.
 *
 * THE ONE FILE ALLOWED TO READ missive_message_intake DIRECTLY. Every other
 * file under archive-search/router.js and archive-search/lib/ must query
 * missive_message_intake_search_safe or missive_message_intake_held_
 * review_safe instead — never this table by name — per the spec's Finding
 * 1 and this build's required CI guardrail (test/no-raw-table-access-
 * check.js). This module is the one named exception because it must, by
 * definition, read the base table to screen it (spec: "the screening pass
 * itself... is the one narrow exception").
 *
 * Steps below are numbered to match the spec's own numbered steps exactly.
 * Step 3 (checkThread) ALWAYS runs before the Fair Housing content check,
 * on every conversation, no exception — identical discipline to complaint-
 * tracking/lib/process-pending-messages.js's own Step 2.
 *
 * CHUNKING — Q's own design decision, required by the spec but not spelled
 * out to this level in its own sketch (spec, "Build Size and Runtime":
 * "resumable chunks... not one unbounded query" — a REQUIRED deviation from
 * complaint-tracking's own single unbounded query, because that pipeline's
 * WHERE pipeline_status = 'pending' only ever sees a normal day's trickle
 * of new mail, while this pass's WHERE screening_result IS NULL sees the
 * entire 254,000+ message historical backlog on its first run).
 *
 * How chunking is made SAFE: the driver query below only decides which
 * CONVERSATIONS get touched this call — once a conversation is selected,
 * this module re-fetches that conversation's COMPLETE row set (every
 * message, regardless of screening_result), not just whichever of its rows
 * happened to fall inside this chunk's LIMIT window. That guarantees
 * checkThread()/selfReportFairHousingContent() always see the whole, real
 * thread, and the
 * final write (which touches every row in the conversation, per spec step
 * 4/5) never stamps a row this call never actually evaluated, and never
 * overwrites an already-screened row's result based on partial context. As
 * a direct, deliberate consequence, a conversation that gets NEW mail after
 * an earlier run already marked it 'clear' is correctly RE-screened in
 * full (old + new messages together) the next time a chunk picks up its
 * new row — matching the spec's own "How It Works" step 6 ("this tool's
 * own screening pass, re-run periodically by hand, is what keeps the
 * searchable pool current").
 *
 * No cursor/offset needs to be persisted across calls: every successfully
 * screened conversation flips screening_result away from NULL for every
 * one of its rows, so the exact same "WHERE screening_result IS NULL"
 * driver query naturally surfaces fresh, still-pending rows on the next
 * call. A conversation that throws mid-processing is left with
 * screening_result still NULL on every one of its rows (never marked
 * 'clear' on a failure path) — identical safety discipline to complaint-
 * tracking's own per-conversation error handling — so the next call
 * retries it automatically.
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const { checkThread } = require('../../email-intake/lib/privilege-filter');
const { HOLD_COOCCURRENCE_PAIRS } = require('../../email-intake/lib/privilege-keywords');
const { toThreadShape, threadFullText } = require('../../complaint-tracking/lib/thread-adapter');
const { selfReportFairHousingContent, FAIR_HOUSING_SELF_REPORT_VERSION } = require('./fair-housing-batch-self-report');

// WIRED IN, live, as of 2026-09-12 — see archive-search-fair-housing-
// option-b-spec.md's Status line and compliance/archive-search-option-b-
// governance-review.md for the real, complete authorization record.
// handleNonHeldConversation() below now calls matchesWideNet() as the first
// step of its live decision path (Section 2 of the spec is the exact
// integration point this implements): a non-held conversation that matches
// nothing in the wide net is written screening_result = 'clear' directly,
// tagged 'wide_net_skip', and never reaches selfReportFairHousingContent()
// or checkClaim() (v3 and earlier — see SCREENING_VERSION's own v4 comment
// below: as of v4, a match proceeds through selfReportFairHousingContent()
// ALONE, checkClaim() no longer runs here at all). This
// note replaces an earlier "AUTHORIZED TO WIRE IN... has NOT yet been
// updated" comment, itself a replacement for a still-earlier "NOT WIRED
// IN... confirmation that does not exist yet" comment — both accurate when
// written, both now stale because the described gap (authorized but not yet
// wired) has been closed by this real code change.
const { matchesWideNet, TERMS_VERSION: WIDE_NET_TERMS_VERSION } = require('./fair-housing-wide-net-terms');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Spec, "Versioning" — a single compact string identifying the combined
// privilege-keyword / protected-class-term / self-report-classifier
// version in effect. A plain, hand-bumped constant (not composed from the
// three sub-versions at runtime) — same reasoning complaint-tracking's own
// categorize-complaint.js's CLASSIFIER_VERSION already uses for a
// comparably "really a code-version question" value (spec's own words).
// Bump this whenever privilege-keywords.js's TERMS_VERSION, protected-
// class-terms.js's TERMS_VERSION, fair-housing-batch-self-report.js's
// FAIR_HOUSING_SELF_REPORT_VERSION, or (as of v2) fair-housing-wide-net-
// terms.js's TERMS_VERSION changes materially. Bumped to v2 here because
// the wide-net pre-filter is now wired into handleNonHeldConversation()'s
// live decision path — a real change to which path a conversation takes,
// not just a term-list edit. Per the spec's own note (Section 2): this
// version string is written identically across every row of a conversation
// regardless of whether it took the skip path or the full-check path, so
// screening_version alone doesn't distinguish the two — screening_tags'
// 'wide_net_skip' marker (see handleNonHeldConversation() below) is what
// carries that distinction on the row itself.
//
// Bumped to v3 (2026-09-12) because FAIR_HOUSING_SELF_REPORT_VERSION
// changed materially — the self-report question itself was recalibrated
// from "references a protected characteristic" to counsel's narrower
// "reasonably indicates a potential Fair Housing concern" standard (see
// fair-housing-batch-self-report.js's buildPrompt() and
// projects/hub/email-intake/archive-search-self-report-recalibration-spec.md).
// This bump does not touch the wide-net pre-filter itself, so
// WIDE_NET_TERMS_VERSION and the skip-path behavior are unchanged; only
// rows that actually reach selfReportFairHousingContent() are affected by
// what changed, but this constant is still a single combined version
// string per this file's own "Versioning" rule above, so it moves too.
//
// Bumped to v4 here (2026-09-12) — ARCHIVE SEARCH ONLY — because
// handleNonHeldConversation() no longer calls checkClaim() at all
// (maintenance-history/lib/content-check.js's Layer 1 keyword scan +
// Layer 2 combining logic). The wide-net-matched, non-held path now
// derives screening_result/screening_category directly from
// selfReportFairHousingContent()'s own { flagged, category } result —
// Layer 1's keyword backstop is gone for this tool, full stop. Nothing
// else about this file's version scheme changes: WIDE_NET_TERMS_VERSION
// and FAIR_HOUSING_SELF_REPORT_VERSION are untouched by this bump.
//
// AUTHORIZATION (archive search only — checkClaim(), content-check.js,
// and protected-class-terms.js are NOT modified, and every other caller of
// checkClaim() — complaint-tracking, approval-briefing, maintenance-
// history, leadsimple-property-brain — keeps both layers exactly as they
// work today):
//   - Outside counsel's specific, unambiguous approval:
//     compliance/archive-search-layer1-removal-outside-counsel-opinion.md
//     ("I approve removing the keyword-only Fair Housing screening layer
//     from Archive Search... The fact that this eliminates an independent
//     automated backstop does not change my opinion."), extracted as
//     durable standing guidance in
//     compliance/fair-housing-standing-counsel-guidance.md.
//   - Asimov (governance) confirmation:
//     compliance/archive-search-layer1-removal-asimov-confirmation.md —
//     VERDICT: CLEARED WITH CONDITIONS (this version bump, the Rule 6
//     audit_log entry, this stated scope, and Tier 1/Auto classification
//     for the mechanism itself — no tenant/owner messaging, no housing
//     decision, only which archived internal communications a trained
//     employee can see).
//   - Mason (legal) confirmation:
//     compliance/archive-search-layer1-removal-mason-confirmation.md —
//     VERDICT: CLEARED.
//   - Owner approval: compliance/archive-search-layer1-removal-owner-
//     risk-acceptance.md, signed by Peter McKenzie.
// The validation-sample gate (pull a real sample of conversations Layer 1
// alone would have flagged that Layer 2 alone clears; confirm none are
// real Fair Housing concerns) is TARS's job against real data before this
// runs against the rest of the archive — not part of this build.
//
// Bumped to v5 (2026-09-13) — ARCHIVE SEARCH ONLY — because the blanket
// legal-hold exclusion (checkThread()'s .held branch, Step 3 above) no
// longer routes a conversation away from Fair Housing screening. Every
// conversation now goes through handleNonHeldConversation()'s path
// regardless of hold-check result. checkThread() itself, privilege-
// filter.js, and its other two live callers (email-intake/lib/index.js,
// complaint-tracking/lib/process-pending-messages.js) are UNMODIFIED —
// this bump reflects a change to this file's own use of that result only.
//
// AUTHORIZATION:
//   - Outside counsel's opinion (directly on point, unprompted about the
//     broader "does the blanket hold need to exist at all" question):
//     compliance/archive-search-held-release-outside-counsel-opinion.md
//     ("I do not believe Archive Search needs the blanket legal-hold
//     exclusion at all... searchability... should not be treated as
//     waiver").
//   - Asimov (governance) confirmation:
//     compliance/archive-search-held-release-asimov-confirmation.md —
//     VERDICT: CLEARED, after Peter's direct, on-the-record decisions
//     closing two real gaps this review found: (1) a fresh shadow-mode
//     decision for this specific change, (2) a retention-clock/spoliation
//     question outside counsel was never asked (screening_result = 'held'
//     rows are otherwise exempt from a documented 4-year deletion clock —
//     resolved by Peter's direct confirmation that no deletion job exists
//     yet and the underlying source emails are separately preserved under
//     Rincon's own document retention policy, independent of this
//     column).
//   - Mason (legal) confirmation:
//     compliance/archive-search-held-release-mason-confirmation.md —
//     VERDICT: CLEARED WITH CONDITIONS, resolved by Peter's explicit
//     decision not to build an in-tool escalation/restriction mechanism
//     for privilege concerns ("escalation will happen outside of the
//     hub") and by adding outside counsel's required Section 7 policy
//     language verbatim to projects/hub/email-intake/archive-search-
//     user-policy-note.md.
//   - Owner approval: Peter's direct, verbatim, real-time confirmation in
//     this build's own session — "i want the tool gone. we dont want to
//     create new legal holds with new emails in the future either."
// The 3,623 conversations previously marked 'held' under v4 and earlier
// have never been evaluated by Fair Housing screening at all (the hold
// check always short-circuited before it could run) — they are reset to
// screening_result = NULL as part of this same change so they flow
// through the real, now-hold-free pipeline for the first time, not
// blanket-marked 'clear' untested.
const SCREENING_VERSION = 'archive-search-screening-v5-hold-gate-removed';

// Spec, "Build Size and Runtime" — this MUST run in resumable chunks. 500
// driver rows is a conservative starting point: small enough that one HTTP
// call (and the AI-call budget it spends, one self-report call per
// non-held conversation in the chunk) stays bounded; large enough that an
// ordinary conversation (a handful of messages, not spread across a huge
// date range) is essentially never split by the driver query. Exact value
// is an implementation detail — not researched further than matching
// tier-b-classifier.js's own "exact value is an implementation detail left
// to Q" precedent for TIER_B_TIMEOUT_MS.
const SCREENING_PASS_CHUNK_SIZE = 500;

// ─── Circuit breaker (Scotty, 2026-09-18) — added as the one condition
// Asimov attached to clearing the screening pass for AUTOMATIC scheduling
// (see router.js's process-pending route and the hourly cron wrapper now
// calling it): nothing previously stopped an unattended chunk that's
// mostly failing from burning through all 500 driver rows one bad AI/DB
// call at a time. This only changes behavior when a run is GENUINELY
// unhealthy — a manually-triggered chunk with a normal handful of
// transient errors never gets near either threshold below.
//
// Two-part "minimum count AND rate" combo, whichever trips first:
//   - CIRCUIT_BREAKER_MIN_ERRORS is a floor so a chunk that hits, say, 1
//     error out of its first 2 conversations (a 50% rate on a tiny sample)
//     doesn't trip the breaker on pure noise — that's exactly the kind of
//     early-and-rare failure a retry-by-hand or next hour's run absorbs
//     fine on its own.
//   - CIRCUIT_BREAKER_ERROR_RATE (checked only once MIN_ERRORS is met) is
//     what actually distinguishes "mostly failing" from "a few real but
//     isolated failures in a large chunk" — a 500-row chunk with 10 spread
//     -out errors (2%) is healthy; the same chunk with 10 errors in its
//     first 15 conversations (67%) is not.
//   - CIRCUIT_BREAKER_MAX_ERRORS is a hard ceiling independent of rate, so
//     a slow, sustained leak (e.g. ~30% errors held steady for hundreds of
//     conversations, never quite framed as "the last handful were all
//     errors") still trips eventually instead of running to the end of a
//     500-row chunk racking up real errors the whole way.
// Deliberately hardcoded, not env-configurable — matches this file's own
// SCREENING_PASS_CHUNK_SIZE precedent ("exact value is an implementation
// detail"); these are safety-net defaults, not something that should need
// a .env edit to hold at a sane value.
const CIRCUIT_BREAKER_MIN_ERRORS = 3;
const CIRCUIT_BREAKER_ERROR_RATE = 0.5; // 50%
const CIRCUIT_BREAKER_MAX_ERRORS = 15;

function circuitBreakerShouldTrip(summary) {
  if (summary.errors >= CIRCUIT_BREAKER_MAX_ERRORS) return true;
  const attempted = summary.conversations_processed + summary.errors;
  if (summary.errors >= CIRCUIT_BREAKER_MIN_ERRORS && summary.errors / attempted >= CIRCUIT_BREAKER_ERROR_RATE) return true;
  return false;
}

async function writeAuditLog({ action, entity_type, entity_id, actor_type, actor_id, risk_level, privacy_category, details }) {
  const { error } = await supabase.from('audit_log').insert({
    action,
    entity_type,
    entity_id,
    actor_type: actor_type || 'system',
    actor_id: actor_id || 'archive-search-screening-pass',
    privacy_category: privacy_category || 'processing',
    risk_level: risk_level || 'low',
    details: details || {},
  });
  if (error) console.error(`[archive-search] audit_log insert failed for ${action}:`, error.message);
}

// Every row for one conversation, regardless of screening_result — see the
// CHUNKING note above for why this is a full re-fetch, not just whichever
// rows the driver chunk happened to return.
async function fetchFullConversation(conversationId) {
  const { data, error } = await supabase
    .from('missive_message_intake')
    .select('*')
    .eq('missive_conversation_id', conversationId);
  if (error) throw error;
  return data || [];
}

async function markConversationScreened(conversationId, { screening_result, screening_category, screening_tags }) {
  const { error } = await supabase
    .from('missive_message_intake')
    .update({
      screening_result,
      screening_category: screening_category || null,
      screening_tags: screening_tags || null,
      screening_version: SCREENING_VERSION,
      screening_completed_at: new Date().toISOString(),
      // Spec, "Resolving Finding 2" — the real, deliberate side effect that
      // structurally forecloses complaint-tracking's own ingestion query
      // (WHERE pipeline_status = 'pending') from ever seeing this backlog.
      // Confirmed, permanent, and named in the spec's own Open Item 2.
      pipeline_status: 'processed',
    })
    .eq('missive_conversation_id', conversationId);
  if (error) throw error;
}

// Which mechanism tripped the hold — domain match, keyword-PHRASE match, or
// the new co-occurrence match (spec, Finding 8 — explicitly THREE distinct
// mechanisms, not two) — NEVER the literal matched term/phrase itself.
// privilege-filter.js's own reason shape doesn't distinguish a literal
// HOLD_TERMS phrase hit from a HOLD_COOCCURRENCE_PAIRS hit — both arrive as
// type: 'hold_keyword_match' (privilege-keywords.js's scanForHoldKeywords()
// merges both into one matchedTerms array by design, so checkThread()/
// checkMessage() need no changes — see that file's own comment). The
// distinction Finding 8 wants is recovered here by checking whether a
// co-occurrence pair's own synthetic id (e.g.
// 'fair_housing_complaint_cooccurrence') appears in matchedTerms — never by
// inspecting the literal phrase itself, so this still never surfaces
// matched content, only which mechanism produced it.
const COOCCURRENCE_IDS = new Set(HOLD_COOCCURRENCE_PAIRS.map((p) => p.id));

function summarizeHoldMechanisms(holdResult) {
  const mechanisms = new Set();
  for (const reason of holdResult.holdReasons) {
    if (reason.layer === 3) mechanisms.add('staff_legal_hold_tag');
    if (reason.layer === 4) {
      for (const inner of reason.reasons || []) {
        if (inner.type === 'law_firm_domain') {
          mechanisms.add('domain_match');
        } else if (inner.type === 'hold_keyword_match') {
          const terms = inner.matchedTerms || [];
          if (terms.some((t) => COOCCURRENCE_IDS.has(t))) mechanisms.add('cooccurrence_match');
          if (terms.some((t) => !COOCCURRENCE_IDS.has(t))) mechanisms.add('keyword_phrase_match');
        }
      }
    }
  }
  return Array.from(mechanisms);
}

// Step 4 — REMOVED 2026-09-13: handleHeldConversation() used to write
// screening_result = 'held' here, permanently excluding the conversation
// from search. Removed along with the .held branch above that called it —
// see that removal's own comment for the real authorization record.
// summarizeHoldMechanisms() (defined above) is kept: it's independently
// exported and tested (test/run-tests.js), even though this file's own
// pipeline no longer calls it now that handleHeldConversation() is gone.

// Step 5: the non-held path — wide-net gate (Option B) first, then, only on
// a match, self-report (Finding 2) alone. option-b-spec.md Section 2 is the
// exact design this implements for the wide-net gate; the v4 change below
// (ARCHIVE SEARCH ONLY — ../maintenance-history/lib/content-check.js's
// checkClaim() and its Layer 1 keyword scan are untouched, and every other
// caller of checkClaim() still combines both layers exactly as before) is
// that a wide-net match no longer also calls checkClaim() — see
// SCREENING_VERSION's own comment above for the full authorization record.
async function handleNonHeldConversation(conversationId, thread, holdResult, anchorRowId) {
  const threadText = threadFullText(thread);

  // Tier 1 TAG labels from checkThread() (e.g. 'regulatory_matter') —
  // informational only, never a search filter. Never true for a held
  // thread, by construction. Collected once here (not just inside the
  // no-match branch) since both branches below need to fold it in.
  const baseTags = holdResult.tagged && holdResult.tags.length ? holdResult.tags : [];

  // NEW — the wide-net gate (option-b-spec.md Section 2). Same reasoning
  // shape as scanForHoldKeywords(): a flat phrase scan plus a
  // co-occurrence scan, ORed together, computed once inside matchesWideNet().
  const wideNet = matchesWideNet(threadText);

  if (!wideNet.matched) {
    // No match anywhere in the wide net — skip the self-report AI call
    // entirely (checkClaim() doesn't run in this file at all as of v4 — see
    // SCREENING_VERSION's own comment). Written 'clear' directly: a wide-net skip is,
    // functionally, a 'clear' outcome (spec Section 2, point 2) — the
    // 'wide_net_skip' tag on the row, not screening_result or
    // screening_version, is what distinguishes it from a full-check 'clear'
    // after the fact.
    const screening_tags = [...baseTags, 'wide_net_skip'];
    await markConversationScreened(conversationId, {
      screening_result: 'clear',
      screening_category: null,
      screening_tags,
    });
    // No audit_log event here — matches today's existing convention that a
    // 'clear' outcome writes no per-conversation event (only 'held' and
    // 'flagged_protected_class' do). The skip is counted in the chunk-level
    // summary instead (runScreeningPassChunk()'s wide_net_skipped counter).
    return 'wide_net_skip';
  }

  // v4 (2026-09-12) — run only when the wide net matched something.
  // selfReportFairHousingContent() (Layer 2) is now the ONLY check driving
  // this decision — checkClaim()/Layer 1's keyword scan no longer runs
  // here at all. See SCREENING_VERSION's own comment above for the full
  // authorization record (outside counsel, Asimov, Mason, owner). Scope:
  // archive search only — checkClaim() itself, content-check.js, and
  // protected-class-terms.js are unmodified, and every other caller of
  // checkClaim() (complaint-tracking, approval-briefing, maintenance-
  // history, leadsimple-property-brain) still combines both layers exactly
  // as before.
  const selfReport = await selfReportFairHousingContent({ threadText });

  const screening_result = selfReport.flagged ? 'flagged_protected_class' : 'clear';
  const screening_tags = baseTags.length ? baseTags : null;

  await markConversationScreened(conversationId, {
    screening_result,
    screening_category: selfReport.flagged ? selfReport.category : null,
    screening_tags,
  });

  if (selfReport.flagged) {
    await writeAuditLog({
      action: 'archive_search.screening_flagged_protected_class',
      entity_type: 'missive_message',
      entity_id: anchorRowId,
      // Layer 1 (keyword_tier_a) no longer runs for this decision at all
      // as of v4 — every flag from here on is the self-report classifier's
      // own judgment (including its fail-closed default on an AI-call
      // error), never a pure keyword hit. Unlike pre-v4, this is never
      // 'system' anymore.
      actor_type: 'ai_agent',
      risk_level: 'high',
      privacy_category: 'processing',
      // Never the self-report's own free text — spec step 6's own literal
      // details shape. matched_layer is now always 'model' (Layer 1 is
      // gone for this decision); terms_version (protected-class-terms.js)
      // no longer applies here since that scan doesn't run in this path.
      details: {
        flagged_category: selfReport.category,
        matched_layer: 'model',
        self_report_version: FAIR_HOUSING_SELF_REPORT_VERSION,
      },
    });
  }

  return screening_result;
}

function uniqueConversationIds(rows) {
  return Array.from(new Set(rows.map((r) => r.missive_conversation_id)));
}

/**
 * One chunk of the screening pass. Call repeatedly (POST /api/archive-
 * search/process-pending) until a run comes back with conversations_
 * processed === 0 and errors === 0 — that means nothing is pending.
 * @returns {Promise<{conversations_processed:number, held:number, flagged:number, clear:number, wide_net_skipped:number, errors:number, chunk_start:string|null, chunk_end:string|null}>}
 */
async function runScreeningPassChunk() {
  const summary = {
    conversations_processed: 0,
    held: 0,
    flagged: 0,
    clear: 0,
    // Option B (archive-search-fair-housing-option-b-spec.md Section 2,
    // point 3): how many of this chunk's 'clear' outcomes skipped the
    // self-report AI call via the wide-net gate (checkClaim() is gone from
    // this file as of v4), rather
    // than going through the full check and coming back clear. A skip
    // still also increments `clear` above, since 'clear' is the real,
    // identical screening_result value either way — this is a breakdown
    // of clear, not a fifth outcome bucket.
    wide_net_skipped: 0,
    errors: 0,
    chunk_start: null,
    chunk_end: null,
    // Circuit breaker (see CIRCUIT_BREAKER_* above) — false/null on every
    // normal run; router.js's process-pending route checks
    // circuit_breaker_tripped and fires sendFailureAlertEmail() when true.
    circuit_breaker_tripped: false,
    circuit_breaker_reason: null,
  };

  // Step 1: the driver query — resumable chunks (a LIMIT, not one
  // unbounded query), ordered by delivered_at ASC per the spec.
  const { data: driverRows, error } = await supabase
    .from('missive_message_intake')
    .select('id, missive_conversation_id, delivered_at')
    .is('screening_result', null)
    .order('delivered_at', { ascending: true })
    .limit(SCREENING_PASS_CHUNK_SIZE);
  if (error) throw error;
  if (!driverRows || driverRows.length === 0) return summary;

  summary.chunk_start = driverRows[0].delivered_at;
  summary.chunk_end = driverRows[driverRows.length - 1].delivered_at;

  // Step 2: group by conversation — deduped, since several driver rows can
  // belong to the same conversation.
  const conversationIds = uniqueConversationIds(driverRows);

  for (const conversationId of conversationIds) {
    try {
      const rows = await fetchFullConversation(conversationId);
      if (rows.length === 0) continue; // defensive only — shouldn't happen

      const thread = toThreadShape(conversationId, rows);
      const anchorRowId = rows[0].id; // any member row's real UUID — see handleHeldConversation's comment

      // Step 3 — REMOVED 2026-09-13, archive search only: the blanket
      // legal-hold exclusion (checkThread()'s .held branch, which used to
      // route here to handleHeldConversation() and skip Fair Housing
      // screening entirely) is gone. Real, specific, unprompted outside
      // counsel opinion (compliance/archive-search-held-release-outside-
      // counsel-opinion.md): searchability is not a privilege
      // determination, and this shared-inbox content is already visible
      // to a broader population than Archive Search's own access list.
      // checkThread() still runs and its Tier 1 informational tags (e.g.
      // 'regulatory_matter') still flow through — only the Tier 2 .held
      // branch's search-exclusion behavior is removed. checkThread()
      // itself, privilege-filter.js, and its other two live callers
      // (email-intake/lib/index.js, complaint-tracking/lib/process-
      // pending-messages.js) are UNTOUCHED and unaffected — this change
      // is scoped to this one pipeline's own use of the result, per
      // Asimov's confirmed scope constraint (compliance/archive-search-
      // held-release-asimov-confirmation.md).
      const holdResult = checkThread(thread);

      const outcome = await handleNonHeldConversation(conversationId, thread, holdResult, anchorRowId);
      if (outcome === 'flagged_protected_class') {
        summary.flagged++;
      } else {
        summary.clear++;
        if (outcome === 'wide_net_skip') summary.wide_net_skipped++;
      }
      summary.conversations_processed++;
    } catch (err) {
      console.error(`[archive-search] Failed to screen conversation ${conversationId}:`, err.message);
      summary.errors++;
      if (circuitBreakerShouldTrip(summary)) {
        summary.circuit_breaker_tripped = true;
        summary.circuit_breaker_reason = `${summary.errors} error(s) out of ${summary.conversations_processed + summary.errors} attempted (stopped early, ${conversationIds.length - (summary.conversations_processed + summary.errors)} conversation(s) left unprocessed this chunk).`;
        console.error(`[archive-search] Circuit breaker tripped for this screening-pass chunk: ${summary.circuit_breaker_reason}`);
        break;
      }
    }
  }

  // Step 8: one summary event per whole run — matching email_intake.
  // missive_sync_run's own "one row per batch, aggregate counts"
  // convention (no natural single entity for a whole run; same
  // crypto.randomUUID() convention that event already uses).
  await writeAuditLog({
    action: 'archive_search.batch_pass_run',
    entity_type: 'archive_search_screening_run',
    entity_id: crypto.randomUUID(),
    actor_type: 'system',
    risk_level: 'low',
    privacy_category: 'collection',
    details: summary,
  });

  return summary;
}

// The count-only dry run the spec's "Build Size and Runtime" section
// recommends BEFORE any live pass runs ("SELECT missive_conversation_id,
// COUNT(*) FROM missive_message_intake WHERE screening_result IS NULL
// GROUP BY 1 — no AI calls, no writes") — exposed here (the one file
// allowed to read the base table) so router.js's status route never has
// to touch missive_message_intake directly itself. Paginates through every
// still-pending row's conversation id to get a real distinct count — no
// GROUP BY available through the Supabase query builder, and this route is
// occasional/admin-triggered, not a hot path, so a client-side de-dupe over
// paginated pages is an acceptable, simple cost (CLAUDE.md: "keep it as
// simple as possible") for a number the spec explicitly says not to guess.
const STATUS_PAGE_SIZE = 1000;

async function countByScreeningResult(filterValue) {
  let query = supabase.from('missive_message_intake').select('id', { count: 'exact', head: true });
  query = filterValue === null ? query.is('screening_result', null) : query.eq('screening_result', filterValue);
  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
}

async function distinctPendingConversationCount() {
  const ids = new Set();
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('missive_message_intake')
      .select('missive_conversation_id')
      .is('screening_result', null)
      .order('missive_conversation_id', { ascending: true })
      .range(from, from + STATUS_PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) ids.add(row.missive_conversation_id);
    if (data.length < STATUS_PAGE_SIZE) break;
    from += STATUS_PAGE_SIZE;
  }
  return ids.size;
}

/**
 * @returns {Promise<{message_rows: {pending:number, held:number, flagged_protected_class:number, clear:number}, pending_conversations:number}>}
 */
async function getScreeningStatus() {
  const [pending, held, flagged, clear, pendingConversations] = await Promise.all([
    countByScreeningResult(null),
    countByScreeningResult('held'),
    countByScreeningResult('flagged_protected_class'),
    countByScreeningResult('clear'),
    distinctPendingConversationCount(),
  ]);
  return {
    message_rows: { pending, held, flagged_protected_class: flagged, clear },
    pending_conversations: pendingConversations,
  };
}

// =============================================================================
// dryRunWideNetMeasurement() — archive-search-fair-housing-option-b-spec.md,
// Section 5 ("Validation Plan"), point 1 ("Zero-cost dry run first") and
// Open Item 7. NOT WIRED IN — and, unlike matchesWideNet() itself (see this
// file's import comment above, now authorized as of 2026-09-12), this
// function is INTENTIONALLY never called from runScreeningPassChunk() or
// any route, by design, permanently — it is a standalone, manually-run
// diagnostic tool, not a gated pending-authorization feature. Read this
// whole comment before calling it or changing it.
//
// WHAT THIS IS: a real, safe, READ-ONLY measurement of how the new wide-net
// pre-filter (fair-housing-wide-net-terms.js) WOULD behave against the real
// archive, if it existed in the live code path — which it does not.
//   - Makes ZERO AI calls (never imports or calls
//     selfReportFairHousingContent).
//   - WRITES NOTHING (no markConversationScreened, no audit_log — same
//     "count-only, no writes" contract getScreeningStatus() above already
//     uses for a comparable "get a real number before committing to a live
//     pass" precedent).
//   - Does not change screening_result, screening_tags, or anything else on
//     any row.
//   - Is never called by runScreeningPassChunk(), any router.js route, or
//     any cron/internal trigger. The only way this function runs is a
//     human explicitly invoking the standalone script that calls it
//     (archive-search/dry-run-wide-net-measurement.js, a top-level script
//     next to router.js — same placement email-intake/backfill-missive-
//     history.js's own precedent uses) — matching this codebase's own
//     "manually triggered only" convention for anything not yet approved
//     to run automatically (see this file's own header, and router.js's
//     Design Decision 16 precedent).
//
// WHY THIS FILE, AND NOT A SEPARATE SCRIPT THAT QUERIES THE VIEWS: the two
// real "safe" views this schema provides are NOT a usable data source for
// this measurement. missive_message_intake_search_safe exposes ONLY rows
// where screening_result = 'clear' — and a real, live, read-only check of
// this exact table on 2026-09-12 confirms screening_result is NULL on
// EVERY one of the archive's 254,280 rows (the batch pass has never been
// run against real data — this also resolves the spec's own Open Item 4).
// So the search-safe view is empty right now and cannot serve this
// measurement at all. missive_message_intake_held_review_safe exposes only
// held-conversation metadata (no body text), and held conversations are
// exactly the ones this measurement must never inspect the content of
// anyway (see below). There is therefore no "safe view" path to real
// conversation TEXT across the archive today — only the raw base table has
// it, and this module (screening-pass.js) is the one file in this codebase
// structurally permitted, by the Finding-1 guardrail itself
// (test/no-raw-table-access-check.js's own isExemptFile()), to read it.
// Putting this measurement anywhere else — a new lib file, a script that
// queries missive_message_intake directly — would either violate that
// guardrail's real intent or (if placed outside archive-search/router.js
// and archive-search/lib/, where the guardrail's own file list doesn't
// look) quietly defeat it. This function stays here, on purpose, as the
// one narrow, reviewed exception the guardrail already names.
//
// POPULATION AND METHOD: mirrors runScreeningPassChunk()'s own real logic
// exactly (Step 3's checkThread()-first discipline), except across the
// WHOLE archive instead of one 500-row chunk, and with matchesWideNet()
// standing in for "would this actually call the AI" instead of the AI call
// itself:
//   1. Page through every row of missive_message_intake, ordered by
//      missive_conversation_id (indexed — idx_missive_message_intake_
//      conversation) so every row belonging to one conversation is
//      contiguous across pages, and only the fields toThreadShape()/
//      threadFullText() actually need are selected (not '*') to keep
//      memory bounded.
//   2. Group rows into conversations as they stream by (buffer the current
//      conversation id; flush and process it the moment a different id is
//      seen) — same reasoning as runScreeningPassChunk()'s own "always see
//      the whole, real thread" discipline, just streamed instead of
//      re-fetched per conversation (a full second read of the same table
//      isn't needed here — the driver query already returns every row it
//      needs, in conversation order).
//   3. Step 3, unchanged: checkThread(thread) FIRST, before anything else.
//      A held conversation's content is NEVER passed to matchesWideNet() —
//      held mail is out of scope for this measurement, exactly as it is
//      out of scope for the real self-report call today (both only ever
//      run on non-held threads).
//   4. For every NON-held conversation only: threadFullText(thread), then
//      matchesWideNet(threadText) — tallied as "would still call the AI"
//      (wide net matched) or "would skip the AI" (wide net did not match).
//      Never logs or returns any matched text — only counts, term names,
//      and category names, same restraint every other matched-term path in
//      this codebase already follows.
//
// @param {{ onProgress?: (partialSummary: object) => void }} [options] -
//   optional callback invoked after each page, for a long-running CLI
//   script to print progress. Never required.
// @returns {Promise<{
//   message_rows_scanned: number,
//   conversations_checked: number,
//   held_excluded: number,
//   non_held_would_call_ai: number,
//   non_held_would_skip: number,
//   would_skip_rate_pct: number,
//   matched_phrase_counts: Record<string, number>,
//   matched_cooccurrence_pair_counts: Record<string, number>,
//   matched_bare_word_exception_counts: Record<string, number>,
//   wide_net_terms_version: string
// }>}
// =============================================================================
const DRY_RUN_PAGE_SIZE = 1000; // matches PostgREST's own enforced max rows-per-request on this project (confirmed live — a requested page larger than 1000 silently comes back capped at 1000), and STATUS_PAGE_SIZE's existing precedent above.
const DRY_RUN_CONVERSATION_BATCH_SIZE = 100; // starting point smaller than router.js's own IN_BATCH_SIZE (200) — real conversation lengths in this archive are skewed enough that a 200-id batch's live message-row count came back well over the platform's 1000-row response cap in testing; fetchConversationRowsSafely() below corrects for any batch (of any size) that still overshoots, so this value only tunes how often that correction path runs, not correctness.
const DRY_RUN_SELECT_COLUMNS =
  'id, missive_conversation_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, body_text, delivered_at, missive_message_id';

// PASS 1 (cheap): every distinct conversation id in the table, via simple
// primary-key keyset pagination (WHERE id > lastId ORDER BY id LIMIT 1000)
// — selecting only the two small columns needed to dedupe. This is NOT the
// same query shape as the two approaches that failed against the real
// table (see the header comment on dryRunWideNetMeasurement() below for
// what was tried and why this is the one that holds up): both a plain
// .range()/OFFSET scan and a keyset scan ordered on (missive_conversation_
// id, id) via an .or()/.and() filter were live-tested against the real
// 254,280-row table and both degraded page over page until Postgres itself
// cancelled the query ("canceling statement due to statement timeout") —
// OFFSET around row ~31,000, the OR-based keyset around row ~48,000.
// Ordering by the primary key alone, with a plain WHERE id > lastId
// (a genuine, single-column index range scan — no OR, no cross-column
// sort), was live-tested end-to-end across all 254,280 rows with flat,
// non-degrading per-page latency (~0.6-1.3s/page throughout) — this is the
// one kept.
async function fetchAllDistinctConversationIds() {
  const ids = new Set();
  let lastId = null;
  for (;;) {
    let query = supabase
      .from('missive_message_intake')
      .select('id, missive_conversation_id')
      .order('id', { ascending: true })
      .limit(DRY_RUN_PAGE_SIZE);
    if (lastId !== null) query = query.gt('id', lastId);

    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const row of data) ids.add(row.missive_conversation_id);
    lastId = data[data.length - 1].id;
    if (data.length < DRY_RUN_PAGE_SIZE) break;
  }
  return Array.from(ids);
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

async function dryRunWideNetMeasurement(options) {
  const onProgress = options && typeof options.onProgress === 'function' ? options.onProgress : null;

  const summary = {
    message_rows_scanned: 0,
    conversations_checked: 0,
    held_excluded: 0,
    non_held_would_call_ai: 0,
    non_held_would_skip: 0,
  };
  const matchedPhraseCounts = {};
  const matchedCooccurrencePairCounts = {};
  const matchedBareWordExceptionCounts = {};

  function tally(counter, key) {
    counter[key] = (counter[key] || 0) + 1;
  }

  function processConversation(conversationId, rows) {
    const thread = toThreadShape(conversationId, rows);
    const holdResult = checkThread(thread);

    if (holdResult.held) {
      summary.held_excluded++;
    } else {
      const threadText = threadFullText(thread);
      const wideNet = matchesWideNet(threadText);
      if (wideNet.matched) summary.non_held_would_call_ai++;
      else summary.non_held_would_skip++;
      for (const term of wideNet.matchedPhrases) tally(matchedPhraseCounts, term);
      for (const id of wideNet.matchedCooccurrencePairs) tally(matchedCooccurrencePairCounts, id);
      for (const term of wideNet.matchedBareWordExceptions) tally(matchedBareWordExceptionCounts, term);
    }
    summary.conversations_checked++;
  }

  // PASS 1 — every distinct conversation id in the archive (see the
  // function's own comment for why this exact query shape, and not the
  // two that were tried and failed against the real table).
  const allConversationIds = await fetchAllDistinctConversationIds();

  // PASS 2 — fetch each batch of conversations' FULL row sets via one
  // .in() lookup per batch (bounded, indexed exact-match on missive_
  // conversation_id — the same kind of lookup fetchFullConversation()
  // above already does per-conversation, just batched here since PASS 1
  // already gave us every id up front; there is no chunk-by-chunk
  // "discover ids as you go" need the live screening pass has). Grouped by
  // conversation within just this one batch at a time (bounded memory —
  // at most DRY_RUN_CONVERSATION_BATCH_SIZE conversations' rows held at
  // once, never the whole archive).
  //
  // fetchConversationRowsSafely() exists because a first, real, live run
  // of this exact code silently under-counted: this project's real
  // PostgREST response cap silently truncates any single request's result
  // to at most 1000 rows (confirmed live — a .range() request for 5000
  // rows came back with exactly 1000; an .in() request for 200
  // conversation ids with no explicit .limit() came back with exactly
  // 1000 rows out of a real, confirmed { count: 'exact' } of 1537 for
  // that same batch), with NO error — count:'exact' still reports the
  // real total even though data itself is cut short, so that mismatch is
  // the only signal a truncation happened at all. An unnoticed truncation
  // here would have silently DROPPED whole conversations from a batch
  // whose combined message count happened to exceed 1000 (ordinary
  // property-management batches of 200 conversations, at ~2.2 messages/
  // conversation on average, sit well under that most of the time, but
  // not always — real batches during this exact live run hit it). Fixed
  // by requesting the exact count alongside the data and, whenever data
  // came back short of that count, splitting the batch in half and
  // retrying each half recursively (down to a single conversation id if
  // truly needed) until every sub-batch's data length matches its own
  // reported count — self-correcting regardless of how unevenly message
  // counts are distributed across conversations, not a fixed batch-size
  // guess.
  async function fetchConversationRowsSafely(idBatch) {
    const { data, error, count } = await supabase
      .from('missive_message_intake')
      .select(DRY_RUN_SELECT_COLUMNS, { count: 'exact' })
      .in('missive_conversation_id', idBatch);
    if (error) throw error;
    const rows = data || [];
    if (idBatch.length > 1 && typeof count === 'number' && rows.length < count) {
      const mid = Math.ceil(idBatch.length / 2);
      const [firstHalf, secondHalf] = await Promise.all([
        fetchConversationRowsSafely(idBatch.slice(0, mid)),
        fetchConversationRowsSafely(idBatch.slice(mid)),
      ]);
      return firstHalf.concat(secondHalf);
    }
    // idBatch.length === 1 and still truncated (a single real conversation
    // with over 1000 messages) — fall back to the same paginated full
    // fetch fetchFullConversation() above already uses, rather than
    // silently returning a partial thread for it.
    if (idBatch.length === 1 && typeof count === 'number' && rows.length < count) {
      return fetchFullConversation(idBatch[0]);
    }
    return rows;
  }

  for (const idBatch of chunkArray(allConversationIds, DRY_RUN_CONVERSATION_BATCH_SIZE)) {
    const rows = await fetchConversationRowsSafely(idBatch);

    const rowsByConversation = new Map();
    for (const row of rows || []) {
      summary.message_rows_scanned++;
      if (!rowsByConversation.has(row.missive_conversation_id)) rowsByConversation.set(row.missive_conversation_id, []);
      rowsByConversation.get(row.missive_conversation_id).push(row);
    }
    // Every id in this batch gets processed, even one whose rows vanished
    // between PASS 1 and PASS 2 (nothing in this codebase deletes
    // missive_message_intake rows, but defensive rather than assumed) —
    // an empty row set for the id is simply skipped, not miscounted.
    for (const conversationId of idBatch) {
      const conversationRows = rowsByConversation.get(conversationId);
      if (conversationRows && conversationRows.length > 0) processConversation(conversationId, conversationRows);
    }

    if (onProgress) onProgress({ ...summary });
  }

  const nonHeldTotal = summary.non_held_would_call_ai + summary.non_held_would_skip;

  return {
    ...summary,
    would_skip_rate_pct: nonHeldTotal > 0 ? Math.round((summary.non_held_would_skip / nonHeldTotal) * 1000) / 10 : 0,
    matched_phrase_counts: matchedPhraseCounts,
    matched_cooccurrence_pair_counts: matchedCooccurrencePairCounts,
    matched_bare_word_exception_counts: matchedBareWordExceptionCounts,
    wide_net_terms_version: WIDE_NET_TERMS_VERSION,
  };
}

// =============================================================================
// fetchFlaggedEarliestBodyTextByConversation() — archive-search-flagged-
// review-spec.md, Section 3.3's flagged-review-export route (router.js):
// "body_text fetched separately per conversation's earliest message."
//
// WHY THIS LIVES HERE, NOT IN router.js: missive_message_intake_flagged_
// review_safe (the admin-facing view that route otherwise reads) deliberately
// excludes body_text — see that view's own COMMENT ON VIEW in the migration.
// A reviewer judging whether a flag is a false positive needs the REAL text
// (same "the reviewer needs the real content to judge it" reasoning the
// validation-sample export already uses) — and no other view carries flagged
// body_text (missive_message_intake_search_safe only ever exposes 'clear' or
// already-overridden rows, never a raw, un-overridden flag). This module is
// the ONE file the Finding-1 guardrail (test/no-raw-table-access-check.js)
// lets read missive_message_intake directly, by definition, so this reader
// lives here rather than adding a second exempt file. router.js must call
// this function, exactly as it already does for runScreeningPassChunk()/
// getScreeningStatus() — never query missive_message_intake itself.
//
// SCOPED IDENTICALLY TO THE REVIEW-SAFE VIEW'S OWN PREDICATE
// (screening_result = 'flagged_protected_class') — this never returns
// anything the flagged-review-safe view doesn't already say exists at the
// metadata level; it only adds the message text for the earliest message in
// each (conversation, mailbox) group. Paginated, narrow column selection —
// same "occasional/admin-triggered, not a hot path" reasoning
// getScreeningStatus() already gives for its own pagination.
// =============================================================================
const FLAGGED_BODY_PAGE_SIZE = 1000;
const FLAGGED_BODY_SELECT_COLUMNS = 'missive_conversation_id, mailbox_key, delivered_at, body_text';

/**
 * @returns {Promise<Map<string, {delivered_at: string, body_text: string}>>}
 *   keyed by `${missive_conversation_id}::${mailbox_key}`, earliest
 *   delivered_at per key.
 */
async function fetchFlaggedEarliestBodyTextByConversation() {
  const earliestByKey = new Map();
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('missive_message_intake')
      .select(FLAGGED_BODY_SELECT_COLUMNS)
      .eq('screening_result', 'flagged_protected_class')
      .order('missive_conversation_id', { ascending: true })
      .range(from, from + FLAGGED_BODY_PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) {
      const key = `${row.missive_conversation_id}::${row.mailbox_key}`;
      const existing = earliestByKey.get(key);
      if (!existing || row.delivered_at < existing.delivered_at) {
        earliestByKey.set(key, { delivered_at: row.delivered_at, body_text: row.body_text });
      }
    }
    if (data.length < FLAGGED_BODY_PAGE_SIZE) break;
    from += FLAGGED_BODY_PAGE_SIZE;
  }
  return earliestByKey;
}

// =============================================================================
// fetchEarliestBodyTextForConversations() — archive-search-escalation-
// mechanism-spec.md, Section 3.3's escalations-review-export route: "body_text
// fetched via a small, generalized sibling of
// fetchFlaggedEarliestBodyTextByConversation()... keyed off the escalations
// table's own (conversation, mailbox) pairs instead of screening_result =
// 'flagged_protected_class'." Q's implementation choice, per the spec's own
// Open Item 5: a second, narrowly-scoped function beside the existing one
// (rather than generalizing that one to take an optional id list), so
// neither call site's own intent — "every currently-flagged conversation" vs.
// "exactly this admin-supplied set of reported conversations" — gets blurred
// into one more-complicated shared signature. Lives here, not in router.js,
// for the identical Finding-1-guardrail reason
// fetchFlaggedEarliestBodyTextByConversation()'s own header already gives:
// this module is the one file the CI guardrail (test/no-raw-table-access-
// check.js) lets read missive_message_intake directly.
//
// Fetches by missive_conversation_id alone (batched via .in(), same
// IN_BATCH_SIZE-style chunking router.js's own fetchByIdsBatched() uses),
// then filters down to the exact requested (conversation, mailbox) pairs in
// application code — the same "a conversation id is only unique WITHIN a
// mailbox" discipline router.js's flagged-override route already applies for
// its own identical ambiguity, so a same-id conversation in an unrelated
// mailbox can never leak into the wrong escalation's exported body text.
// =============================================================================
const EARLIEST_BODY_FOR_CONVERSATIONS_BATCH_SIZE = 200;

/**
 * @param {{missive_conversation_id: string, mailbox_key: string}[]} pairs
 * @returns {Promise<Map<string, {delivered_at: string, body_text: string}>>}
 *   keyed by `${missive_conversation_id}::${mailbox_key}`, earliest
 *   delivered_at per key. Pairs with no matching row are simply absent from
 *   the returned map (never a thrown error) — the caller is responsible for
 *   treating a missing key as "no body text available."
 */
async function fetchEarliestBodyTextForConversations(pairs) {
  const wantedKeys = new Set(pairs.map((p) => `${p.missive_conversation_id}::${p.mailbox_key}`));
  const conversationIds = Array.from(new Set(pairs.map((p) => p.missive_conversation_id)));
  const earliestByKey = new Map();

  for (let i = 0; i < conversationIds.length; i += EARLIEST_BODY_FOR_CONVERSATIONS_BATCH_SIZE) {
    const batch = conversationIds.slice(i, i + EARLIEST_BODY_FOR_CONVERSATIONS_BATCH_SIZE);
    const { data, error } = await supabase
      .from('missive_message_intake')
      .select(FLAGGED_BODY_SELECT_COLUMNS)
      .in('missive_conversation_id', batch);
    if (error) throw error;
    for (const row of (data || [])) {
      const key = `${row.missive_conversation_id}::${row.mailbox_key}`;
      // A conversation id matched, but for a DIFFERENT mailbox than any
      // requested pair — not one of the escalations this export is
      // building, so it's skipped rather than merged in.
      if (!wantedKeys.has(key)) continue;
      const existing = earliestByKey.get(key);
      if (!existing || row.delivered_at < existing.delivered_at) {
        earliestByKey.set(key, { delivered_at: row.delivered_at, body_text: row.body_text });
      }
    }
  }
  return earliestByKey;
}

module.exports = {
  runScreeningPassChunk,
  getScreeningStatus,
  summarizeHoldMechanisms,
  SCREENING_VERSION,
  SCREENING_PASS_CHUNK_SIZE,
  fetchFlaggedEarliestBodyTextByConversation,
  fetchEarliestBodyTextForConversations,
  // NOT WIRED IN — see the function's own header comment above.
  dryRunWideNetMeasurement,
  // Circuit breaker (automatic-scheduling clearance, 2026-09-18) — exported
  // so test/run-tests.js can exercise the trip logic directly as a pure
  // function, without needing a real Supabase-backed chunk run.
  circuitBreakerShouldTrip,
  CIRCUIT_BREAKER_MIN_ERRORS,
  CIRCUIT_BREAKER_ERROR_RATE,
  CIRCUIT_BREAKER_MAX_ERRORS,
};
