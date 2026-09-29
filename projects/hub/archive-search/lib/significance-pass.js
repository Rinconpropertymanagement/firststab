/**
 * lib/significance-pass.js
 * The merged Call 1 / Call 2 significance + complaint-triage pass —
 * projects/hub/email-intake/archive-search-significance-technical-spec.md
 * (v2, through its fifth same-day correction). Read that document's
 * Sections 3-10 and 12 before changing anything here. Governance: CLEARED
 * (compliance/archive-search-significance-final-asimov-clearance.md;
 * Mason CLEARED WITH CONDITIONS, met by this build).
 *
 * Sibling of ./screening-pass.js — same house style: fail-closed
 * discipline, a single hand-bumped version constant, a per-conversation
 * try/catch loop, a batch-summary audit_log event. Two real differences
 * from that file, both deliberate:
 *   1. This module never itself embeds a raw-base-table query — every
 *      query here goes through missive_message_intake_search_safe or (added
 *      2026-09-18, migration 20260918020000, fetchDriverPage() only)
 *      missive_message_intake_search_safe_clear_branch — the Finding-1
 *      guardrail, test/no-raw-table-access-check.js, applies to this file
 *      exactly as it does to every other file under archive-search/lib/
 *      except screening-pass.js itself. UPDATED 2026-09-21 (migration
 *      20260921020000, performance fix — see fetchDriverPage()'s own header
 *      comment): fetchDriverPage() no longer queries the clear_branch view
 *      at all — it now calls a service-role-only SQL function,
 *      archive_search_significance_driver_next_clear_page(), which reads
 *      the raw base table directly with the identical
 *      screening_result = 'clear' filter baked into the function itself
 *      (Neo's design, to escape a security_barrier planner problem the view
 *      had no other fix for). This file's own source no longer names the
 *      raw table at all (so the Finding-1 guardrail's literal-string check
 *      still passes clean), but the underlying read is, functionally, a
 *      filtered raw-table read now, one level removed — flagged here
 *      plainly rather than left implied by the (unchanged) sentence above.
 *      Reviewed and approved by Asimov — see compliance/archive-search-
 *      significance-driver-clear-page-rpc-asimov-review.md for the full
 *      review (confirmed no new exposure, independently verified against
 *      the base table's own RLS/grants history, not just the migration's
 *      own narrative) and its one follow-up condition, closed in this same
 *      change: the Finding-1 guardrail's literal-string check couldn't see
 *      this RPC-based read either, so test/no-raw-table-access-check.js now
 *      also names this specific function in its own
 *      KNOWN_RAW_TABLE_RPC_FUNCTIONS allow-list.
 *   2. The "already processed" check is against a DIFFERENT table
 *      (missive_conversation_significance's own UNIQUE(mailbox_key,
 *      missive_conversation_id) — spec Section 4), not a column on the row
 *      being scanned. See fetchNextEligibleConversations()'s own header
 *      comment for what that means for how this paginates.
 *
 * WHAT THIS FILE RETIRES (spec Section 8): complaint-tracking/lib/
 * categorize-complaint.js and complaint-tracking/lib/process-pending-
 * messages.js's own AI-call-driving logic. Neither is called from here.
 * checkThread() (privilege-filter.js) is never called anywhere in this
 * pipeline — Mason's and Asimov's Finding 1, resolved by the received
 * outside-counsel opinion (compliance/archive-search-significance-
 * outside-counsel-opinion.md) and both reviewers' confirmation passes.
 *
 * WHAT THIS FILE REUSES, UNCHANGED, RATHER THAN RE-DERIVING (spec Section
 * 4/5's own explicit instruction not to build sibling copies):
 *   - complaint-tracking/lib/thread-adapter.js (toThreadShape,
 *     collectAllAddresses, threadFullText)
 *   - complaint-tracking/lib/subject-match.js (matchParticipantsToRecords)
 *     — deterministic, email-match-only, no AI free-text subject
 *     resolution, ever. NOT modified by this build.
 *   - complaint-tracking/lib/duplicate-check.js (findPossibleDuplicate) —
 *     live_pipeline complaints only (historical rows are exempt per the
 *     migration's complaints_config_required_unless_held extension).
 *   - complaint-tracking/lib/process-pending-messages.js's
 *     computeSilenceContext() and lookupSingleDirectorOfOperations() —
 *     that file's own AI-driving functions (runProcessPendingMessages and
 *     everything only it used) were removed when this pass replaced it;
 *     see that file's own header for what's left and why.
 *   - maintenance-history/lib/content-check.js's checkClaim() — Mason's
 *     Finding 3: retained as a genuine, independent second layer on Call
 *     1's own self-report, never folded into it.
 *
 * PILOT / PHASE 2 — spec Section 10. This module only ever implements the
 * synchronous, per-conversation loop (the pilot, and the ongoing ordinary-
 * volume live loop). It deliberately does NOT implement the Message
 * Batches API run for the full ~249,850-conversation historical backfill
 * — that is a separate, later, explicitly-deferred build.
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const { checkClaim } = require('../../maintenance-history/lib/content-check');
const { toThreadShape, collectAllAddresses, threadFullText } = require('../../complaint-tracking/lib/thread-adapter');
const { matchParticipantsToRecords } = require('../../complaint-tracking/lib/subject-match');
const { findPossibleDuplicate } = require('../../complaint-tracking/lib/duplicate-check');
const { computeSilenceContext, lookupSingleDirectorOfOperations } = require('../../complaint-tracking/lib/process-pending-messages');

// `let`, not `const` — see _setSupabaseClientForTesting() just below.
let supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ============================================================
// TEST-ONLY dependency-injection seam, added 2026-09-17 for the Batches API
// build's own test suite (test/run-tests.js PART 18) — never called from
// any real code path in this file. This file's EXISTING tests fake this
// module's Supabase client via a require.cache swap-and-force-refresh
// trick (see test/run-tests.js's own withFakeSupabaseClient) — that
// remains untouched and still works for every test already using it. This
// setter exists ONLY because PART 18's own tests need the REAL
// applyCall1Result() to run (proving the Batches API write-back tool
// applies a downloaded result through this file's actual write path,
// rather than reimplementing it) without force-refreshing this module —
// doing so was proven, while building that test suite, to occasionally
// bind a DIFFERENT concurrently-running test's own fake Supabase client
// instead of the intended one, since require.cache is global, shared,
// mutable state (see lib/significance-batch.js's own identical comment on
// its own copy of this same seam for the full story). A plain settable
// reference sidesteps that: it mutates the ONE, already-loaded copy of
// this module directly, never touching require.cache at all.
// ============================================================
function _setSupabaseClientForTesting(client) { supabase = client; }

function anthropicClient() {
  const Anthropic = require('@anthropic-ai/sdk'); // lazy require — same reasoning every other Anthropic-calling lib file in this codebase gives: don't fail at module-load time for a route that never calls the model.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  return new Anthropic({ apiKey });
}

// ============================================================
// TEMPORARY DIAGNOSTIC INSTRUMENTATION — added 2026-09-17 for a one-time
// real-cost-measurement sample ahead of the ~250,000-conversation full
// archive run (Hermes's request). NOT a permanent feature — remove once
// Scotty has captured the sample batch's real token usage.
//
// A complete no-op unless HERMES_USAGE_LOG is set in the environment: the
// guard below returns immediately, before anything else in this function
// runs, so normal pilot/production runs are byte-for-byte unaffected.
// When set, appends one JSON line per real API response (both Call 1 and
// Call 2, every attempt including retries) to a local file, so a small
// real test batch can capture actual token costs — including whatever
// fields Claude Sonnet 5's response.usage object actually contains
// (input_tokens/output_tokens are documented; cache_creation_input_tokens,
// cache_read_input_tokens, and any thinking/reasoning-related fields are
// NOT assumed — the whole object is spread through untouched so the real
// shape can be inspected from the log itself). response.stop_reason is
// logged alongside it (truncation context).
//
// Never throws: a logging failure is caught and warned on only, and must
// never interrupt real conversation processing.
// ============================================================
function logHermesUsage({ call, mailbox_key, missive_conversation_id, response }) {
  if (!process.env.HERMES_USAGE_LOG) return;
  try {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const logPath = path.join(os.tmpdir(), 'hermes-usage-log.jsonl'); // os.tmpdir() resolves to the right place on whichever host this runs on (local or sally), not a hardcoded /tmp assumption.
    const line = JSON.stringify({
      call,
      mailbox_key,
      missive_conversation_id,
      timestamp: new Date().toISOString(),
      ...(response && response.usage ? response.usage : {}), // entire usage object, uncherry-picked — see header comment above.
      stop_reason: response && response.stop_reason,
    });
    fs.appendFileSync(logPath, line + '\n');
  } catch (err) {
    console.warn(`[significance-pass] HERMES_USAGE_LOG: failed to write usage log entry (non-fatal): ${err.message}`);
  }
}

// ============================================================
// Versioning — spec Section 7 "Versioning." ONE shared constant, written
// identically into complaints.extracted_by, missive_message_links.
// extracted_by (content_extracted rows), and missive_conversation_
// significance.extracted_by. Bump this whenever either prompt below
// changes materially. SCREENING_VERSION (screening-pass.js) stays fully
// independent — it gates eligibility into this pass, not this pass's own
// content.
// ============================================================
const CONTENT_PASS_VERSION = 'archive-search-content-pass-v2'; // v2, 2026-09-17: removed Call 1's protected-class self-check; removed owner-instruction note drafting in favor of a bare factual summary, now asked symmetrically on live and historical mail — both material prompt changes, per this constant's own bump-on-change convention

// The shared 8-value topic taxonomy (spec Section 3/7) — the SAME list on
// missive_conversation_significance.category and complaints.category.
// Exported so complaint-tracking/router.js's manual "Report an issue"
// path validates against the real, current list instead of categorize-
// complaint.js's now-retired 6-value enum (a real bug this retirement
// would otherwise leave behind — see that router.js's own comment at the
// CATEGORIES import for the full explanation).
const TOPIC_CATEGORIES = [
  'routine_logistics', 'maintenance_standard', 'dispute', 'safety_issue',
  'legal_exposure', 'accommodation_related', 'owner_instruction', 'other',
];

const RESOLUTION_STATUSES = ['open', 'resolved', 'unknown'];
const TONE_TRENDS = ['stable', 'escalating'];

// Call 2's five-value list (spec Section 3/5), 'none' included — 'none' is
// legal on missive_conversation_significance.escalation_signal (means
// "Call 2 ran, found nothing") but is NEVER written to complaints.
// escalation_signal (a 'none' result never creates a complaints row —
// spec Section 4).
const ESCALATION_SIGNALS = ['blocked_resolution', 'churn_risk', 'escalation_recurrence', 'major_money_property_risk', 'none'];
const BLOCKED_REASONS = ['explicit_refusal', 'inferred_from_silence'];
const BLOCKED_PARTIES = ['owner', 'tenant'];

// REMOVED 2026-09-17 (Peter's decision, Mason CLEARED — compliance/
// archive-search-significance-complaint-merge-mason-review.md, "Follow-up
// to Finding 2"): HISTORICAL_ASSESSMENT_LABEL and the fixed-wording note
// it labeled. Rincon's real-world response to an actual discriminatory
// owner instruction is to terminate the management contract, not draft
// and store a carefully-worded refusal/assessment note — so neither the
// live-mail fixed-template response nor the historical AI-drafted
// assessment (the one Question Two's outside-counsel opinion specifically
// authorized) is generated anymore. See buildCall2Prompt()'s
// ownerInstructionBlock and runCall2Phase() below for what replaced it:
// owner_instruction_rejected (true/false/uncertain) is still recorded and
// still routes to a human on true/uncertain, unchanged; the only thing
// removed is AI-authored prose about that finding.

// ============================================================
// Prompt text — Call 1 (spec Section 5). TONE reused VERBATIM from the
// spec, plus the legal_exposure category's corrected instruction text
// (Mason's Finding 1) also reused verbatim.
//
// REMOVED 2026-09-17 (Peter's decision): the spec's original second
// addition, PROTECTED-CLASS SELF-CHECK (item 5, "does this thread touch
// on a legally protected topic... set protected_class_flag: true"). The
// archive is already gated by a separate, upstream, archive-wide Fair
// Housing screening pass (screening-pass.js) before any conversation ever
// reaches this pipeline, so Call 1 asking the same style of question a
// second time here was redundant. Mason reviewed and confirmed this
// removal is reasonable and non-blocking — compliance/archive-search-
// significance-complaint-merge-mason-review.md, Finding 3 follow-up.
// Mason's one hard requirement: don't just delete the prompt question and
// leave parseCall1Response()'s fail-closed-to-TRUE default in place for a
// field the model is never asked about anymore — that would flood every
// row with a false protected_class_flag=true. See parseCall1Response()
// and processConversation() below for the other half of this fix — both
// now source protected_class_flag/protected_class_category from nowhere
// (hardcoded false/null), rather than from a Call 1 field that no longer
// exists. checkClaim() (maintenance-history/lib/content-check.js) is
// UNTOUCHED and keeps running exactly as before, as the sole remaining
// content-based protected-class check in this file (its modelFlag/
// modelCategory params are optional — see its own call site below).
// ============================================================
const LEGAL_EXPOSURE_PRIVILEGE_NOTICE = `No privilege or legal-hold filter of any kind runs before this pass sees
this content. The only upstream check is archive-search's Fair Housing
protected-class self-report — a different filter, for a different thing,
gating a different eligibility question. Do not assume attorney-client-
privileged or formally-filed legal correspondence has already been
removed from what you're reading.`;

const TONE_BLOCK = `4. TONE — read the messages in order (oldest first). Is the sender's tone
   getting more strained or frustrated over time, or steady? Set
   tone_trend to "escalating" only if you see a real progression across
   multiple messages, "stable" otherwise. Advisory only — never decides
   anything by itself.`;

const CATEGORY_BLOCK = `CATEGORY — choose exactly ONE:
- routine_logistics — ordinary scheduling, confirmations, or logistics with nothing contentious.
- maintenance_standard — an ordinary repair/maintenance request or update; nothing blocked, refused, or escalated.
- dispute — a disagreement between parties (e.g. a neighbor dispute, a billing disagreement) that is not itself a safety or legal matter.
- safety_issue — a habitability or physical-safety concern (e.g. no heat, mold, a broken lock, a fire hazard).
- legal_exposure — real, but not yet formal, legal/compliance exposure (a code enforcement mention, a habitability issue with real liability risk, non-privileged attorney-adjacent correspondence). ${LEGAL_EXPOSURE_PRIVILEGE_NOTICE}
- accommodation_related — a disability/reasonable-accommodation request or discussion.
- owner_instruction — an owner giving Rincon a standing instruction, or a one-off directive outside normal procedure.
- other — none of the above clearly applies.`;

// Prompt B only — cite-then-lookup (spec Section 4), never a directory
// handed to the model. Deliberately scoped to PROPERTY and VENDOR only,
// never tenant/owner — subject-match.js's own "no AI free-text fallback,
// full stop" discipline for a Fair-Housing-adjacent subject is Q's own
// read of the safest, most spec-consistent line to draw (a genuinely open
// question the spec itself doesn't spell out at this level of detail —
// flagged here explicitly, not silently assumed): a vendor is a business
// entity, not a protected-class-relevant subject, so an AI-cited, code-
// verified vendor guess carries none of the risk that rule protects
// against; a tenant/owner guess would. complaints.subject_type/subject_id
// stay address-match-only regardless (enforced in the write path below,
// not just here) — this only governs what content_identification even
// ATTEMPTS to identify.
const IDENTIFICATION_BLOCK = `5. IDENTIFICATION — no participant email address in this thread matched a
   tenant, owner, or vendor on file. If the thread's own text clearly
   names a specific PROPERTY (an address or property name) or a specific
   VENDOR (a company name), quote the exact sentence or phrase that tells
   you so — do not guess an id, and do not attempt to identify a specific
   tenant or owner by name alone. If you cannot confidently tell from the
   text itself, leave the relevant field null.`;

function buildCall1Prompt({ threadText, addressMatched }) {
  return `You are reviewing one email conversation from a Southern California property management company's (Rincon Management) shared-inbox archive, for a combined significance-tagging and triage pass.

1. RESOLUTION STATUS — is this conversation open, resolved, or unknown? Judge only from what the thread's own content actually shows. Silence alone is not proof of resolution — do not infer "resolved" just because nobody has replied recently.

2. ${CATEGORY_BLOCK}

3. WHY — a short (1-2 sentence), plain-English explanation of what this conversation is actually about and why you chose that category and resolution status.

${TONE_BLOCK}
${addressMatched ? '' : `\n${IDENTIFICATION_BLOCK}\n`}
Conversation (oldest message first):
"""
${threadText}
"""

Respond with EXACTLY one JSON object, no markdown fence, no explanation before or after it:
{"resolution_status": "open"|"resolved"|"unknown",
 "category": one of ["routine_logistics","maintenance_standard","dispute","safety_issue","legal_exposure","accommodation_related","owner_instruction","other"],
 "why": "...",
 "tone_trend": "stable"|"escalating"|null${addressMatched ? '' : `,
 "identification": {"property_text": "quoted text"|null, "vendor_text": "quoted text"|null}`}}`;
}

// ============================================================
// Call 1 — parsing, with the field-specific fail-closed posture spec
// Section 5 requires: the browsing fields (category/resolution_status/
// why/tone_trend/identification) retry-until-success (see runCall1()
// below).
//
// REMOVED 2026-09-17: this used to also parse protected_class_flag/
// protected_class_category, fail-closed-to-TRUE on a partial parse of
// that field alone. Call 1 no longer asks the model this question at all
// (see the removed PROTECTED-CLASS SELF-CHECK block, above) — there is no
// longer any field here to parse, fail closed on, or default. The return
// value below simply no longer carries these two keys; processConversation()
// below hardcodes protected_class_flag: false / protected_class_category:
// null when building the significance row, rather than reading them from
// this object. Getting this right (not leaving the old fail-closed-to-
// TRUE default in place with nothing to feed it) was Mason's one hard
// requirement for this removal — a bare `parsed.protected_class_flag ??
// true`-style default, kept after the prompt no longer asks the
// question, would have flooded every single row with protected_class_
// flag=true forever.
// ============================================================
function parseCall1Response(rawText, { addressMatched }) {
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

  // The pure browsing fields — invalid/missing here means "this call
  // needs a retry," never a silent default, per spec's own "no row
  // written until a parse succeeds" for these fields.
  if (!RESOLUTION_STATUSES.includes(parsed.resolution_status)) return null;
  if (!TOPIC_CATEGORIES.includes(parsed.category)) return null;
  if (typeof parsed.why !== 'string' || !parsed.why.trim()) return null;

  const tone_trend = TONE_TRENDS.includes(parsed.tone_trend) ? parsed.tone_trend : null;

  let identification = { property_text: null, vendor_text: null };
  if (!addressMatched && parsed.identification && typeof parsed.identification === 'object') {
    identification = {
      property_text: typeof parsed.identification.property_text === 'string' && parsed.identification.property_text.trim()
        ? parsed.identification.property_text.trim() : null,
      vendor_text: typeof parsed.identification.vendor_text === 'string' && parsed.identification.vendor_text.trim()
        ? parsed.identification.vendor_text.trim() : null,
    };
  }

  return {
    resolution_status: parsed.resolution_status,
    category: parsed.category,
    why: parsed.why.trim(),
    tone_trend,
    identification,
  };
}

const CALL1_MAX_ATTEMPTS = 3;
const CALL1_TIMEOUT_MS = 30000;

/**
 * Call 1 — retry-until-success for the pure browsing fields (spec Section
 * 5). Returns null (no row should be written at all) only after
 * CALL1_MAX_ATTEMPTS genuinely bad/unparseable responses in a row — a
 * necessary, bounded implementation of "retry-until-success" (same class
 * of judgment call SCREENING_PASS_CHUNK_SIZE's own comment names as "an
 * implementation detail left to Q").
 * @returns {Promise<object|null>}
 */
async function runCall1({ threadText, addressMatched, mailbox_key, missive_conversation_id }) {
  const prompt = buildCall1Prompt({ threadText, addressMatched });

  for (let attempt = 1; attempt <= CALL1_MAX_ATTEMPTS; attempt++) {
    try {
      const anthropic = anthropicClient();
      const response = await anthropic.messages.create(
        {
          model: 'claude-sonnet-5',
          max_tokens: 1024,
          output_config: { effort: 'medium' },
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        },
        { timeout: CALL1_TIMEOUT_MS }
      );
      logHermesUsage({ call: 1, mailbox_key, missive_conversation_id, response }); // temporary diagnostic instrumentation — see logHermesUsage() header comment; no-op unless HERMES_USAGE_LOG is set.

      if (response.stop_reason === 'max_tokens') {
        console.error(`[significance-pass] Call 1 truncated (attempt ${attempt}/${CALL1_MAX_ATTEMPTS}) — retrying.`);
        continue;
      }
      const textBlock = response.content.find((b) => b.type === 'text');
      const parsed = textBlock ? parseCall1Response(textBlock.text, { addressMatched }) : null;
      if (parsed) return parsed;
      console.error(`[significance-pass] Call 1 unparseable (attempt ${attempt}/${CALL1_MAX_ATTEMPTS}) — retrying.`);
    } catch (err) {
      console.error(`[significance-pass] Call 1 call failed (attempt ${attempt}/${CALL1_MAX_ATTEMPTS}): ${err.message}`);
    }
  }
  return null; // total failure — caller writes no row at all; conversation stays eligible for the next run.
}

// ============================================================
// Prompt text — Call 2 (spec Section 5), conditional. historicalFraming
// fixes Bug #1 (the silence-context date-math bug complaint-tracking's
// own computeSilenceContext() has, pointed unmodified at old mail) — text
// reused verbatim from the spec for historical mail; live mail keeps
// computeSilenceContext()'s own existing wording, reproduced here (not
// exported from categorize-complaint.js, which this build retires).
// ============================================================
const HISTORICAL_SILENCE_FRAMING = `This is a historical thread (backfilled from the archive, not live mail).
The elapsed time since the last message reflects the passage of time, not
necessarily an unresolved refusal — do not infer blocked_resolution from
silence alone on a historical thread. Base your answer only on what the
thread's content actually shows.`;

function buildLiveSilenceContextText(silenceContext) {
  if (!silenceContext || silenceContext.daysSinceLastMessage == null) {
    return '(no message dates available)';
  }
  return `The most recent message in this thread was sent ${silenceContext.daysSinceLastMessage} day(s) ago, ${
    silenceContext.lastMessageFromStaff ? 'FROM Rincon staff (i.e. nobody has replied since)' : 'from someone other than Rincon staff'
  }. Rincon's own configured "silence counts as blocked" threshold is ${silenceContext.silenceThresholdDays} day(s). This is a factual signal only — use your own judgment on whether the thread's actual content is really an authorization/access request that's gone unanswered; not every silent thread is blocked_resolution.`;
}

function buildCall2Prompt({ category, resolution_status, why, threadText, discoveryContext, silenceContext }) {
  const historicalFraming = discoveryContext === 'historical_backfill'
    ? HISTORICAL_SILENCE_FRAMING
    : '';
  const silenceContextText = discoveryContext === 'historical_backfill'
    ? '(historical thread — see framing above; the silence clock does not apply)'
    : buildLiveSilenceContextText(silenceContext);

  const ownerInstructionBlock = category === 'owner_instruction' ? `
3. OWNER INSTRUCTION CHECK — is the instruction itself discriminatory
   (would require Rincon to treat someone differently based on a
   protected characteristic)?

   ${discoveryContext === 'historical_backfill' ? `HISTORICAL MAIL: set owner_instruction_rejected to true, false, or
   "uncertain" — your honest read of whether the instruction was
   discriminatory. If your read is "uncertain," also set needs_human_call:
   true.` : `LIVE MAIL: if yes, set owner_instruction_rejected: true. If it's an
   ordinary, non-discriminatory instruction, set owner_instruction_
   rejected: false.`}
   Either way, set owner_instruction_summary to a short, plain, FACTUAL
   statement of the instruction itself — no analysis, no assessment of
   whether it's discriminatory beyond the flag above, no drafted response.
   A human will read this flag and this sentence together and decide what
   happens next; you are reporting what the owner said, not what Rincon
   should do about it.
` : '';

  return `This conversation was already reviewed once and categorized as: ${category} (${resolution_status}). ${why}

${historicalFraming}

Conversation:
"""
${threadText}
"""

Answer:

1. ESCALATION SIGNAL — does this conversation show one of the following?
   Choose exactly ONE, or "none":
   - blocked_resolution — the normal path to fixing something has broken
     down: an owner refuses to authorize/pay, a tenant refuses access, or
     Rincon asked for authorization/access and got silence past the
     threshold below with no explicit "no."
   - churn_risk — an owner hinting they're unhappy with management,
     mentioning other companies or selling; a tenant threatening to break
     the lease or withhold rent.
   - escalation_recurrence — the SAME issue coming up again. Only use
     this if THIS THREAD ITSELF shows a clear repeat — do not guess at
     history you can't see in this thread.
   - major_money_property_risk — not routine spend; something at the
     scale of a roof replacement or an insurance-claim-level event.
   - none — none of the above apply.
   If blocked_resolution, also set blocked_reason ("explicit_refusal" or
   "inferred_from_silence") and blocked_party ("owner" or "tenant").

2. NEEDS A HUMAN CALL — if you are genuinely unsure whether this needs
   attention, set needs_human_call: true. This is not a category — it's
   an honest "I'm not sure," not a forced guess.
${ownerInstructionBlock}
SILENCE CONTEXT: ${silenceContextText}

Respond with EXACTLY one JSON object, no markdown fence:
{"escalation_signal": one of ["blocked_resolution","churn_risk","escalation_recurrence","major_money_property_risk","none"],
 "blocked_reason": "explicit_refusal"|"inferred_from_silence"|null,
 "blocked_party": "owner"|"tenant"|null,
 "needs_human_call": true|false,
 "owner_instruction_rejected": true|false|"uncertain"|null,
 "owner_instruction_summary": "..."|null}`;
}

function parseCall2Response(rawText, { category }) {
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
  if (!ESCALATION_SIGNALS.includes(parsed.escalation_signal)) return null;

  const escalation_signal = parsed.escalation_signal;
  const blocked_reason = escalation_signal === 'blocked_resolution' && BLOCKED_REASONS.includes(parsed.blocked_reason) ? parsed.blocked_reason : null;
  if (escalation_signal === 'blocked_resolution' && !blocked_reason) return null; // complaints_blocked_requires_reason — treat as a parse failure, not a silent drop.
  const blocked_party = escalation_signal === 'blocked_resolution' && BLOCKED_PARTIES.includes(parsed.blocked_party) ? parsed.blocked_party : null;

  const needs_human_call = typeof parsed.needs_human_call === 'boolean' ? parsed.needs_human_call : true; // higher-stakes field — fail closed toward "ask a human," never silently false.

  let owner_instruction_rejected = null;
  let owner_instruction_summary = null;
  if (category === 'owner_instruction') {
    if (parsed.owner_instruction_rejected === true || parsed.owner_instruction_rejected === false) {
      owner_instruction_rejected = parsed.owner_instruction_rejected;
    } else if (parsed.owner_instruction_rejected === 'uncertain') {
      owner_instruction_rejected = 'uncertain';
    } else {
      return null; // category is owner_instruction but this required field didn't come through — retry.
    }
    owner_instruction_summary = typeof parsed.owner_instruction_summary === 'string' && parsed.owner_instruction_summary.trim()
      ? parsed.owner_instruction_summary.trim() : null;
  }

  return { escalation_signal, blocked_reason, blocked_party, needs_human_call, owner_instruction_rejected, owner_instruction_summary };
}

const CALL2_MAX_ATTEMPTS = 2; // bounded, unlike Call 1 — Call 2's own fail-closed posture is "write a placeholder," not "retry forever."
const CALL2_TIMEOUT_MS = 30000;

/**
 * @returns {Promise<{ok:true, value:object} | {ok:false}>} ok:false means
 *   every attempt failed — caller writes the needs_human_call=true
 *   placeholder per spec Section 5, never leaves no trace at all.
 */
async function runCall2(params) {
  const prompt = buildCall2Prompt(params);
  const { mailbox_key, missive_conversation_id } = params; // only used by the temporary logHermesUsage() instrumentation below — buildCall2Prompt() ignores extra keys, so this is additive only.

  for (let attempt = 1; attempt <= CALL2_MAX_ATTEMPTS; attempt++) {
    try {
      const anthropic = anthropicClient();
      const response = await anthropic.messages.create(
        {
          model: 'claude-sonnet-5',
          max_tokens: 768,
          output_config: { effort: 'medium' },
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        },
        { timeout: CALL2_TIMEOUT_MS }
      );
      logHermesUsage({ call: 2, mailbox_key, missive_conversation_id, response }); // temporary diagnostic instrumentation — see logHermesUsage() header comment; no-op unless HERMES_USAGE_LOG is set.
      if (response.stop_reason === 'max_tokens') {
        console.error(`[significance-pass] Call 2 truncated (attempt ${attempt}/${CALL2_MAX_ATTEMPTS}).`);
        continue;
      }
      const textBlock = response.content.find((b) => b.type === 'text');
      const parsed = textBlock ? parseCall2Response(textBlock.text, params) : null;
      if (parsed) return { ok: true, value: parsed };
      console.error(`[significance-pass] Call 2 unparseable (attempt ${attempt}/${CALL2_MAX_ATTEMPTS}).`);
    } catch (err) {
      console.error(`[significance-pass] Call 2 call failed (attempt ${attempt}/${CALL2_MAX_ATTEMPTS}): ${err.message}`);
    }
  }
  return { ok: false };
}

// ============================================================
// REMOVED 2026-09-17 (Peter's decision, Mason CLEARED): buildOwnerInstruction
// NoteText() used to construct either a fixed-template live-mail "Rincon's
// standard refusal" response or an AI-drafted historical assessment
// ("AI-assessed in <year>: ... would require Rincon's standard refusal").
// Neither is generated anymore — see the REMOVED comment above ESCALATION_
// SIGNALS/BLOCKED_REASONS/BLOCKED_PARTIES for why. What's stored in the
// owner_instruction_note_text slot now (both tables, live and historical
// alike) is nothing more than the model's own owner_instruction_summary —
// a short, plain, FACTUAL paraphrase of the instruction itself, exactly
// as buildCall2Prompt()'s ownerInstructionBlock above asks for it.
//
// Pulled out as its own named, exported, pure function — same convention
// this file already uses for shouldCreateComplaint/complaintEscalation
// Signal/needsCall2 below — specifically so a test can assert, without a
// real Supabase or Anthropic call, that this is a bare passthrough: no
// prefix, no suffix, no template wording of any kind, for EITHER
// discovery context (there is deliberately no discoveryContext parameter
// here at all — that asymmetry was exactly what the old function had and
// this one doesn't).
// ============================================================
function resolveOwnerInstructionNoteText({ category, owner_instruction_summary }) {
  return category === 'owner_instruction' ? (owner_instruction_summary ?? null) : null;
}

// ============================================================
// Complaints-creation logic — the EXACT condition from the migration's own
// header comment (20260913020000_..._schema.sql, "COMPLAINTS-CREATION
// LOGIC"), copied verbatim, not re-derived. Applies identically to
// live_pipeline and historical_backfill rows (spec Section 4's fix).
// ============================================================
function shouldCreateComplaint({ escalation_signal, needs_human_call, owner_instruction_rejected, category }) {
  return (
    escalation_signal !== 'none' && escalation_signal != null
  ) || !!needs_human_call
    || owner_instruction_rejected !== null && owner_instruction_rejected !== undefined // IS DISTINCT FROM NULL — any answered value (true/false/'uncertain')
    || category === 'legal_exposure' || category === 'owner_instruction';
}

// ============================================================
// Real pilot bug, 2026-09-13 (Scotty's diagnosis, independently confirmed
// live against the real DB). complaints.escalation_signal's CHECK
// constraint (this migration, line ~423) deliberately excludes 'none' as
// a legal value — unlike missive_conversation_significance.
// escalation_signal (ESCALATION_SIGNALS above), which allows it as its
// fifth value ("Call 2 ran, found nothing"). shouldCreateComplaint() above
// is correct and unchanged: category IN ('legal_exposure',
// 'owner_instruction') alone creates a complaints row even when
// escalation_signal is 'none' (spec Section 4/7 — that's branch 4, working
// exactly as intended). The bug was downstream of that decision:
// createComplaintRow() was copying call2Fields.escalation_signal straight
// into the complaints insert with no translation, so that exact
// combination (category qualifies, escalation_signal === 'none') threw
// complaints_escalation_signal_check on every real conversation shaped
// that way. Fix: translate 'none' to null ONLY at the one place that
// writes to complaints — missive_conversation_significance keeps storing
// the literal 'none' as-is (it's a legal value there), so this must never
// be applied before that upsert/update, only inside createComplaintRow().
// Hardened 2026-09-13 (Judge review) — previously returned `escalation_
// signal` unchanged for ANY non-'none' input, including null/undefined, so
// an undefined input produced undefined output. Harmless today only by
// coincidence (the real call site below always passes a real string or
// null, never undefined) — fragile-by-coincidence, not a guarantee. Now
// null/undefined both normalize to null explicitly, same as 'none'.
function complaintEscalationSignal(escalation_signal) {
  return escalation_signal == null || escalation_signal === 'none' ? null : escalation_signal;
}

// Call 2 gate (spec Section 4, "deliberately biased generous") — a
// conversation needs Call 2 unless Call 1 already found it routine AND
// resolved. Pulled out as its own named, exported, pure function (real
// pilot bug #2, 2026-09-13) because it now has a SECOND job beyond gating
// processConversation() below: fetchIncompleteSignificanceRows() also uses
// it, to tell genuinely-stuck existing rows (Call 2 was required and never
// completed) apart from rows that will legitimately have
// call2_completed_at NULL forever BY DESIGN — a routine_logistics +
// resolved conversation never gets a Call 2 at all (the no_call2_needed
// outcome below never touches call2_completed_at). Without this second
// use, a driver query keyed on "call2_completed_at IS NULL" alone would
// re-select every one of those by-design rows on every single run,
// forever, mistaking normal, permanent, intentional NULLs for stuck ones.
function needsCall2({ category, resolution_status }) {
  return category !== 'routine_logistics' || resolution_status !== 'resolved';
}

// The full "does this EXISTING significance row need a Call 2 retry"
// decision (real pilot bug #2 fix) — the two conditions
// fetchIncompleteSignificanceRows below is built from, named and exported
// together so the three real states a row can now be in are each a single
// call: (a) call2_completed_at is set at all -> false, fully complete,
// regardless of category/resolution_status; (b) call2_completed_at NULL
// AND needsCall2 -> true, genuinely stuck, Call 1 done and Call 2 owed;
// (c) call2_completed_at NULL but NOT needsCall2 (routine_logistics +
// resolved) -> false, no Call 2 was ever going to happen for this row, by
// design, not a stuck row. The DB query below applies the same logic
// itself (an IS NULL filter plus an equivalent .or() clause) purely as a
// fetch-size optimization; this function is the actual, unit-tested
// source of truth for the decision, same convention as dedupeNewPairs.
function rowNeedsCall2Retry({ category, resolution_status, call2_completed_at }) {
  return call2_completed_at == null && needsCall2({ category, resolution_status });
}

// ============================================================
// checkClaim() audit_log — spec Section 5, the same event complaint-
// tracking's own (never-run) design already built for a `true` result
// (process-pending-messages.js lines 357-381, before this build stripped
// that file down) — reused here at the entity this pipeline actually has
// at the moment checkClaim() runs: the significance row, not a complaint
// (which may not exist yet, or ever, for this conversation).
// ============================================================
async function writeAuditLog({ action, entity_type, entity_id, actor_type, actor_id, risk_level, privacy_category, property_id, details }) {
  const { error } = await supabase.from('audit_log').insert({
    action,
    entity_type,
    entity_id,
    actor_type: actor_type || 'system',
    actor_id: actor_id || 'archive-search-significance-pass',
    privacy_category: privacy_category || 'processing',
    risk_level: risk_level || 'low',
    property_id: property_id || null,
    details: details || {},
  });
  if (error) console.error(`[significance-pass] audit_log insert failed for ${action}:`, error.message);
}

// ============================================================
// Deterministic property/vendor resolution for Prompt B's cited text —
// "cite-then-lookup, not directory-in-prompt" (spec Section 4). Fetched
// once per batch run, not once per conversation (cheap — portfolio size
// 150-500 units, a much smaller distinct-property count; vendor list is
// currently small and, per the migration's own note, dormant until a
// vendor sync exists). Simple case-insensitive substring containment,
// accepted only on a UNIQUE match — an ambiguous or zero match is treated
// as "genuinely unmatchable" (the v1 sketch's own accepted outcome), never
// guessed. Deliberately simple, per CLAUDE.md — a fuzzy-matching pass is a
// real, addressable future improvement, not a gap this build pretends
// doesn't exist.
// ============================================================
async function fetchPropertyDirectory() {
  const { data, error } = await supabase.from('properties').select('id, name, address');
  if (error) throw error;
  return data || [];
}
async function fetchVendorDirectory() {
  const { data, error } = await supabase.from('vendors').select('id, company_name').eq('is_active', true);
  if (error) throw error;
  return data || [];
}

function resolveUniqueMatch(citedText, directory, fieldNames) {
  if (!citedText) return null;
  const needle = citedText.toLowerCase();
  const matches = directory.filter((row) =>
    fieldNames.some((f) => row[f] && needle.includes(String(row[f]).toLowerCase()))
  );
  return matches.length === 1 ? matches[0] : null;
}

// ============================================================
// The driver — spec Section 4's exact eligibility rule: every conversation
// in missive_message_intake_search_safe with no existing row yet in
// missive_conversation_significance. ONE query, forever, for both the
// historical backfill and all future live mail.
//
// PAGINATION NOTE (Q's own judgment call, documented rather than
// assumed): unlike screening-pass.js's own driver query — where "already
// processed" is a column (screening_result) on the SAME row being
// scanned, so a plain `IS NULL` filter naturally advances page over page —
// this driver's "already processed" check is against a DIFFERENT table
// (missive_conversation_significance's own UNIQUE constraint). Supabase's
// query builder cannot express a cross-table NOT EXISTS filter directly,
// so this pages through missive_message_intake_search_safe by a plain
// keyset cursor on `id` (proven fast at this table's real scale —
// screening-pass.js's own dryRunWideNetMeasurement() found and fixed the
// identical OFFSET-degradation problem; this reuses that same fix) and
// filters out already-processed (mailbox_key, missive_conversation_id)
// pairs in application code, one existence-check query per page. Real
// forward progress still happens on every call, because once a
// conversation gets a significance row it permanently stops matching
// "not yet processed" on the very next call — this is correctness by
// construction, not an assumption. What this does NOT do is persist a
// cursor across separate invocations of this module (e.g. across
// separate HTTP calls to the ongoing live-loop route): each call restarts
// its keyset scan from the beginning of missive_message_intake_search_safe
// and skips everything already done. For the pilot (a single script run,
// in-process) and the ongoing live loop (low daily trickle, per spec
// Section 10) this is simple and correct, if not maximally efficient at
// full-archive scale — full-archive-scale throughput is Phase 2's job
// (the Message Batches API run), explicitly not built here.
//
// ============================================================
// sinceDate — staged-backfill-by-recency cutoff (Peter's request, 2026-
// 09-17): an optional ISO date string (e.g. '2025-09-17'), or null/
// undefined for "no cutoff" — the DEFAULT for every existing caller, so
// nothing changes unless a caller opts in. Peter wants to run the
// ~250,487-conversation historical archive in date-scoped stages (last 1
// year first, review real results/cost, then decide whether to expand
// further back) rather than committing to the whole archive at once.
//
// SEMANTICS, worked through concretely rather than assumed: a conversation
// qualifies if its MOST RECENT message's delivered_at is on/after
// sinceDate — NOT whether the conversation started before or after
// sinceDate. A conversation that began 3 years ago but has real activity
// within the last year must still be in scope; one that's been silent for
// 3+ years must not.
//
// THE IMPLEMENTATION IS A PLAIN PER-ROW FILTER (`.gte('delivered_at',
// sinceDate)` on the search-safe view below — a MESSAGE-level view, one
// row per message, not per conversation), which looks naive at first
// glance given the driver pages through message rows, but is provably
// conversation-level-correct, not an approximation:
//   max(delivered_at) for a conversation >= sinceDate
//     IFF
//   at least one message in that conversation has delivered_at >= sinceDate
// (a set's maximum is >= a threshold exactly when some element of the set
// is >= that threshold — the message achieving the max, if no other does).
// So filtering individual message rows to delivered_at >= sinceDate, then
// taking the DISTINCT (mailbox_key, missive_conversation_id) pairs among
// the SURVIVING rows (exactly what dedupeNewPairs already does), yields
// precisely the set of conversations whose most recent message clears the
// cutoff — never more, never fewer. This holds regardless of how many
// older messages that same conversation has, and regardless of whether
// the qualifying (recent) message happens to have a low or high `id` —
// correctness here does not depend on id order tracking delivered_at
// order at all, only on the WHERE clause being evaluated per message row.
//
// Worked example (the one this file's own task explicitly asked to be
// checked, not assumed): conversation X has message A (delivered 2022,
// old) and message B (delivered 2026-08-01, within the last year).
// sinceDate = one year ago. The query returns message B's row (it alone
// satisfies delivered_at >= sinceDate); dedupeNewPairs extracts
// conversation X's pair from that surviving row. X is correctly INCLUDED,
// even though its first message (A) predates the cutoff by years — the
// naive-looking per-row filter does not wrongly exclude it. A conversation
// whose messages are ALL older than sinceDate contributes zero surviving
// rows and is correctly EXCLUDED.
//
// PERFORMANCE NOTE — UPDATED 2026-09-17, real bug found TWICE tonight, the
// second fix is the one that actually holds up (Neo). Attempt 1 (id-ordered
// keyset paging, with .gte('delivered_at', sinceDate) tacked on as an extra
// filter) timed out paging past page 1 on the real database: ordering by id
// while filtering by delivered_at gives the query planner no way to use a
// delivered_at-ordered index, so every page still has to check the full
// id-ordered scan row-by-row for delivered_at >= sinceDate. Attempt 2
// (re-order by (delivered_at, id), page with a composite keyset cursor,
// backed by a new partial index) was independently reproduced live and
// ALSO timed out on page 2 — a new index did not fix it, because the real
// problem was never "no index exists." It was combining an id-keyset
// condition with a delivered_at filter in the same SQL query at all: id is
// gen_random_uuid() (confirmed: 20260905020000) with zero real correlation
// to delivered_at, so no index changes that.
//
// The fix that actually works (see fetchDriverPage()'s own header comment
// below): stop sending delivered_at to Postgres as a filter, period. The
// driver query is now the exact same `ORDER BY id ASC` / bare `id > cursor`
// shape, unconditionally, whether or not sinceDate is set — the identical
// query shape already proven fast twice tonight (the original unfiltered
// path, and 20260914000000's own fix) and never changed by this fix. The
// date cutoff is applied as a plain JavaScript filter (passesSinceDate(),
// below fetchDriverPage()) on each page's rows before they reach
// dedupeNewPairs. Because the SQL Postgres receives never changes shape
// based on sinceDate, this cannot hit the query-planner failure mode above.
// The real, honest cost: since sinceDate no longer narrows what the DB
// returns, pages contain rows the client-side filter then discards, so
// reaching targetCount eligible conversations takes roughly 3x more page
// round-trips at today's ~33% match rate for a 1-year cutoff — a real but
// bounded trade, and one that improves (fewer round-trips per eligible
// conversation) as Peter's staged rollout moves the cutoff further back and
// the match rate rises. The composite-index migration written for attempt
// 2 (supabase/migrations/20260917010000_add_clear_delivered_at_id_
// composite_index_for_significance_driver_sincedate.sql) was never applied
// to the live database and is now unnecessary for this code path — whether
// to drop it is Neo's call, not made here.
// ============================================================
const DRIVER_PAGE_SIZE = 500;

// ============================================================
// Real fix, 2026-09-17 (Neo's diagnosis, independently reproduced live
// twice tonight). Two earlier approaches both failed against the real
// database:
//   1. Plain id-ordered paging with .gte('delivered_at', sinceDate) tacked
//      on — timed out paging past page 1.
//   2. Re-ordering by (delivered_at, id) with a composite keyset cursor,
//      backed by a new partial index — ALSO timed out on page 2, even with
//      the index in place. The problem was never a missing index: id is
//      gen_random_uuid() (confirmed: 20260905020000) with zero real
//      correlation to delivered_at, so combining an id-keyset condition
//      with a delivered_at filter in one SQL statement gives Postgres a
//      shape its planner handles badly regardless of which index exists.
//
// The actual fix: this function never sends delivered_at to Postgres as a
// filter, and no longer takes a sinceDate parameter at all — there is only
// ONE query shape now, used unconditionally. It is the same plain
// `ORDER BY id ASC` / bare `id > cursor` query that both the original
// unfiltered path and 20260914000000's own fix already proved fast — since
// the shape never changes, it cannot hit the failure mode above.
// delivered_at IS still included in the SELECT list (a real column on this
// view already, no schema change needed) purely so the caller
// (fetchNextEligibleConversations, below) can apply the date cutoff as a
// plain JavaScript filter — see passesSinceDate() immediately below. See
// the PERFORMANCE NOTE above DRIVER_PAGE_SIZE for the full reasoning and
// the honest cost of filtering client-side instead of in SQL. The now-
// unused composite-index migration (supabase/migrations/20260917010000_
// add_clear_delivered_at_id_composite_index_for_significance_driver_
// sincedate.sql) was never applied to the live database and is no longer
// needed by this code path — dropping it is Neo's call, not made here.
//
// UPDATED 2026-09-18 (Neo's second real fix tonight, migration 20260918020000
// — read that file in full before changing anything below): the id-ordered
// keyset shape above was STILL timing out, unpredictably, run-to-run, even
// with delivered_at removed — traced to missive_message_intake_search_safe's
// own escalations NOT EXISTS anti-join, whose query plan was proven live NOT
// stable across identical repeated requests. The fix is this function now
// points at missive_message_intake_search_safe_clear_branch — the same
// screened view, minus the anti-join (screening_result = 'clear' only,
// nothing else) — independently walked live for 55 consecutive real pages
// with flat ~200-330ms timing. Query shape is otherwise UNCHANGED: same
// ORDER BY id ASC, same bare id > cursor, same LIMIT 500, same three
// selected columns. Because this view is Branch 1 only (never escalation-
// aware), the escalation exclusion that the anti-join used to provide is now
// the caller's job — see fetchEscalationExclusionSet() and
// passesEscalationExclusion() below, and fetchNextEligibleConversations()'s
// own use of both, applied BEFORE dedupeNewPairs(), same discipline as the
// existing passesSinceDate() filter.
//
// UPDATED 2026-09-21 (real production EXPLAIN evidence, Neo's migration
// 20260921020000): the clear_branch view above stopped being fast. Real
// EXPLAIN output against production showed this exact query shape — the
// view has security_barrier = true set on it — forces Postgres into a full
// parallel sequential scan of the whole table plus an in-memory sort on
// EVERY page fetch (1030ms, confirmed non-cache-related by a repeat run at
// 986ms), rather than using the existing partial index on the raw table's
// own (screening_result, id) columns, which the identical query shape
// uses in 76ms when run directly against the raw table. This is a confirmed,
// reproducible cause of the timeouts that were crashing scans. The fix does
// not touch the view, security_barrier, or anything about the database
// itself (Neo's call, not this file's) — it swaps HOW this one page of rows
// is fetched: this function now calls
// archive_search_significance_driver_next_clear_page(p_cursor_id, p_limit),
// a plain SQL function that queries the raw base table directly (same
// filter — screening_result = 'clear' — same ORDER BY id ASC, same bare
// id > cursor, same LIMIT, same three-plus-id columns),
// bypassing the security_barrier planner problem entirely. Granted to
// service_role only, same as every other RPC this file already calls
// (fetchClearBranchDigest, fetchEscalationExclusionDigest, below). Nothing
// else about this file's driver logic changes: same pagination, same
// caller, same return shape, same error handling, same escalation exclusion
// still applied by the caller (the RPC, like the view before it, is Branch 1
// only — screening_result = 'clear', nothing else).
// ============================================================
async function fetchDriverPage(cursor) {
  const { data, error } = await supabase.rpc('archive_search_significance_driver_next_clear_page', {
    p_cursor_id: cursor, // null is fine — the RPC's own default (and its `p_cursor_id IS NULL OR id > p_cursor_id` WHERE clause) handles "start from the beginning," same as the old `if (cursor !== null) query = query.gt(...)` branch did.
    p_limit: DRIVER_PAGE_SIZE,
  });
  if (error) throw error;
  return data || [];
}

// ============================================================
// passesSinceDate — the client-side half of the fix above. Pure, exported,
// directly unit-tested (no DB/AI call). sinceDate null/undefined means "no
// cutoff" (every existing caller's default) — always true in that case.
// Otherwise true only when row.delivered_at is non-null AND parses to a
// value on/after sinceDate. The explicit non-null check matters: SQL's own
// `>=` operator never matches a NULL delivered_at, so this preserves exact
// parity with what the old (broken) SQL-side `.gte('delivered_at',
// sinceDate)` filter would have done on any row with no delivered_at at
// all — excluded, not defaulted to included. Uses Date.parse rather than
// string comparison, since a cutoff string like '2025-09-17' and a stored
// ISO timestamp are not guaranteed to compare correctly as raw strings.
// ============================================================
function passesSinceDate(row, sinceDate) {
  if (sinceDate == null) return true;
  return row.delivered_at != null && Date.parse(row.delivered_at) >= Date.parse(sinceDate);
}

// ============================================================
// passesEscalationExclusion — added 2026-09-18 (migration 20260918020000's
// required handoff, point 3). The client-side half of the escalation
// exclusion that missive_message_intake_search_safe_clear_branch no longer
// applies itself (that view is Branch 1 ONLY, screening_result = 'clear',
// nothing else — see fetchDriverPage()'s own header comment). Same shape
// and same calling discipline as passesSinceDate() immediately above: a
// pure, exported, directly unit-tested per-row predicate, applied by
// fetchNextEligibleConversations() to each page's RAW rows BEFORE
// dedupeNewPairs() runs — exclusion narrows which pairs are ELIGIBLE, it
// must never narrow which rows advance the pagination cursor (that
// advances from the raw page, unconditionally, same as it already does for
// the date cutoff).
//
// escalationKeys is a Set of `${mailbox_key}::${missive_conversation_id}`
// strings — same composite-key convention dedupeNewPairs() and
// filterAlreadyProcessed() already use elsewhere in this file, reused here
// rather than inventing a second one. Built once per
// fetchNextEligibleConversations() call by fetchEscalationExclusionSet()
// below, not once per page.
// ============================================================
function passesEscalationExclusion(row, escalationKeys) {
  return !escalationKeys.has(`${row.mailbox_key}::${row.missive_conversation_id}`);
}

// Batched existence check against missive_conversation_significance —
// same "IN() on one column, filter the composite key in app code" pattern
// screening-pass.js's own fetchEarliestBodyTextForConversations() already
// uses for the identical "conversation id is only unique WITHIN a
// mailbox" ambiguity.
async function filterAlreadyProcessed(pairs) {
  if (pairs.length === 0) return [];
  const ids = Array.from(new Set(pairs.map((p) => p.missive_conversation_id)));
  const existingKeys = new Set();
  const BATCH = 200;
  for (let i = 0; i < ids.length; i += BATCH) {
    const { data, error } = await supabase
      .from('missive_conversation_significance')
      .select('mailbox_key, missive_conversation_id')
      .in('missive_conversation_id', ids.slice(i, i + BATCH));
    if (error) throw error;
    for (const row of data || []) existingKeys.add(`${row.mailbox_key}::${row.missive_conversation_id}`);
  }
  return pairs.filter((p) => !existingKeys.has(`${p.mailbox_key}::${p.missive_conversation_id}`));
}

// ============================================================
// fetchEscalationExclusionSet — added 2026-09-18, migration 20260918020000's
// required handoff, point 2. Fetches the CURRENT set of Fair-Housing
// escalations that must exclude a conversation from this pass — the exact
// condition missive_message_intake_search_safe's own live anti-join used
// (20260912050000), not the looser status IN (...) shape a temporary test
// index checked earlier the same night:
//   status = 'open' OR (status = 'confirmed' AND reopened_at IS NULL)
// Called ONCE per fetchNextEligibleConversations() call (never once per
// page) — this table is small by design, so re-fetching it 170+ times over
// an 84,408-conversation run would be wasteful, not incorrect, but there is
// no reason to pay that cost. Fetched fresh, live, every call — deliberately
// NOT cached or snapshotted across calls, so a conversation escalated
// between two runs is picked up on the very next one, matching the
// freshness guarantee the old (broken) anti-join already provided. Returns
// a Set of `${mailbox_key}::${missive_conversation_id}` keys — see
// passesEscalationExclusion() above for how the caller uses it, and, per
// the same migration's point 4, this same Set must ALSO be applied to
// whatever rows the (not-yet-built — see this file's own PENDING note near
// the override branch) flagged-overrides merge step returns, not just this
// page-loop's output.
// ============================================================
async function fetchEscalationExclusionSet() {
  const { data, error } = await supabase
    .from('archive_search_escalations')
    .select('mailbox_key, missive_conversation_id')
    .or('status.eq.open,and(status.eq.confirmed,reopened_at.is.null)');
  if (error) throw error;
  const keys = new Set();
  for (const row of data || []) keys.add(`${row.mailbox_key}::${row.missive_conversation_id}`);
  return keys;
}

// Pure — the actual "driver query" logic (deduping a raw page of rows to
// distinct (mailbox_key, missive_conversation_id) pairs, in order, then
// deduping AGAIN against everything already accumulated across earlier
// pages within this same call), pulled out of fetchNextEligibleConversations
// specifically so it's directly unit-testable without a real Supabase
// connection — the DB round-trips (fetchDriverPage, filterAlreadyProcessed)
// are the only parts of "the driver query" that genuinely need one; this
// is the part that decides correctness (no duplicates, no reprocessing,
// original order preserved).
function dedupeNewPairs(pageRows, alreadySeenKeys) {
  const pairs = [];
  const seenThisPage = new Set();
  for (const row of pageRows) {
    const key = `${row.mailbox_key}::${row.missive_conversation_id}`;
    if (seenThisPage.has(key) || alreadySeenKeys.has(key)) continue;
    seenThisPage.add(key);
    pairs.push({ mailbox_key: row.mailbox_key, missive_conversation_id: row.missive_conversation_id });
  }
  return pairs;
}

// ============================================================
// Resumable driver cursor — migration 20260920010000 (Neo). Lets
// fetchNextEligibleConversations() below skip re-walking an already-
// exhausted region of missive_message_intake_search_safe_clear_branch on a
// FRESH call, instead of restarting from id=null every single time (this
// file's own PAGINATION NOTE above fetchDriverPage() already documents why
// that was fine when a page fetch was 200-330ms; it stopped being fine once
// page fetches regressed to 10-17s against a front ~44%-exhausted table).
//
// THE CORRECTNESS ARGUMENT — why a saved cursor can never cause a silent,
// permanent skip. id is gen_random_uuid(), with zero correlation to
// insertion, delivery, or screening-completion time. TWO independent things
// can change a row's TRUE eligibility while it sits at or below a
// previously-saved cursor id, with the id itself never changing:
//   1. screening_result can leave 'clear' and later come back to 'clear'
//      with the SAME id — not hypothetical: reset-layer1-removal-310.js
//      already did exactly this to 310 real conversations.
//   2. An archive_search_escalations exclusion (status='open', or
//      status='confirmed' with reopened_at IS NULL) can resolve or reopen
//      (20260912040000's real, live reopened_at/status lifecycle),
//      changing a conversation's true eligibility with NO change to
//      screening_result at all.
// So a saved cursor is NEVER trusted on its own. Before it is used to start
// fetchDriverPage(cursor_id) instead of fetchDriverPage(null),
// resolveDriverStartCursor() below recomputes BOTH a fresh clear-branch
// digest and a fresh escalation-exclusion digest, live, and compares them
// to what was recorded the last time this cursor was confirmed safe
// (cursorIsSafeToResume()). Either mismatch — or no saved cursor at all, or
// any error reading/verifying one — means: ignore it, walk from id=null
// this run, exactly like every run did before this feature existed. This
// is self-healing, never a fatal error: the only consequence of a stale or
// unverifiable cursor is that this one run pays the full, already-proven-
// correct cost instead of the fast-forwarded one. Symmetrically,
// persistDriverCursor() below never throws either — a failure to save only
// costs the NEXT run its fast-forward, never a skipped conversation, since
// the scan this run just performed is already complete and correct on its
// own regardless of whether its result gets cached.
//
// THIRD GAP, found on a later review pass, fixed here rather than merely
// flagged: sinceDate. fetchDriverPage() never sends sinceDate to Postgres —
// passesSinceDate() filters client-side, AFTER the cursor has already
// advanced past those raw rows (see the PERFORMANCE NOTE above
// fetchDriverPage() for why). Neither digest says anything about date
// scope: a row that failed an OLDER, stricter sinceDate and sits at/below a
// saved cursor id would never be reconsidered by a LATER call sharing the
// same cursor if that later call passed a LOOSER sinceDate — both digests
// would still match (screening_result and the escalation-exclusion set
// never changed), so the fast-forward would silently skip it forever. This
// is directly live, not a remote hypothetical: Peter's own plan is to run
// the historical backfill in date-scoped stages (last 1 year first, then
// widen), which is exactly this trigger condition.
//
// THE FIX — fold sinceDate into the cursor's scope key itself
// (driverCursorScopeKey(), below), so a run with a different sinceDate
// can never look up (or overwrite) a cursor established under a different
// window in the first place. This needs no schema change and does not
// touch cursorIsSafeToResume() or either digest at all — it only changes
// which saved row a given call is even allowed to consider trusting. A
// sinceDate a caller has never used before on this driver simply finds no
// saved row for its own scope key and pays a fresh full walk the first
// time, exactly the same already-proven-safe fallback as any other
// unverifiable cursor — never a new risk, only a (bounded, one-time-per-
// distinct-sinceDate) cost.
//
// FOURTH GAP, found on Neo's review of a follow-up fix and fixed via a
// SEPARATE migration (20260920020000, not this one): a naive fix for a real
// mid-run race — a new 'clear' row landing at a low id, between
// verification and persist, during a fast-forward — applied a
// `screening_completed_at <= run_started_at` time-bound to the ENTIRE
// id<=cursor range at persist time. Neo's objection: screening-pass.js's
// markConversationScreened() re-screens an ENTIRE conversation thread on
// every new reply, with no per-row filter, so it routinely bumps
// screening_completed_at forward on old, already-verified 'clear' rows that
// never actually changed eligibility — a global time-bound would eventually
// overlap one of these routine touches, wrongly invalidate an
// already-persisted digest, force a full walk, and permanently disable the
// fast-forward optimization with no error, ever. See migration
// 20260920020000's own header for the full reasoning and the fix: scope the
// time-bound to only the territory THIS RUN newly swept (id > the cursor
// this run STARTED from), never the whole cumulative range — implemented by
// fetchClearBranchDigest()'s establishedFloorId/asOf parameters and
// fetchNextEligibleConversations()'s own startingCursorFloor/runStartedAt,
// below.
//
// Same review pass also confirmed the escalation-digest half of this
// mechanism needed a snapshot-ORDERING fix, not a schema or logic change:
// persistDriverCursor() used to re-fetch the escalation digest fresh at the
// END of a run, independent of whatever fetchEscalationExclusionSet() had
// already fetched at the START of the same run for actually filtering rows.
// Escalation exclusion has no id-range/floor split to worry about (it is
// one global set, not scoped by any cursor), so re-fetching it "fresher"
// minutes later only risked persisting a digest that no longer matches what
// this run actually filtered against. Fixed by fetching both once, together,
// at the top of fetchNextEligibleConversations(), and threading that one
// snapshot through unchanged to every persistDriverCursor() call the run
// makes — see escalationDigest below.
// ============================================================

const DRIVER_CURSOR_SCOPE = 'missive_message_intake_search_safe_clear_branch';

// Pure — directly unit-testable. null/undefined sinceDate (the "no cutoff"
// default every existing caller already uses) maps to a fixed, explicit
// 'none' token rather than being folded in as the literal string "null" or
// "undefined" — cheap insurance against a future refactor accidentally
// passing the wrong falsy value and silently landing on a different scope
// key than intended.
function driverCursorScopeKey(sinceDate) {
  return `${DRIVER_CURSOR_SCOPE}::sinceDate=${sinceDate == null ? 'none' : sinceDate}`;
}

// Pure — the actual trust decision, directly unit-testable with no DB. Both
// digests must match; either mismatch (or no saved row at all) means "do
// not trust this cursor."
function cursorIsSafeToResume(savedCursorRow, freshClearBranch, freshEscalation) {
  if (!savedCursorRow) return false;
  return savedCursorRow.established_clear_branch_digest === freshClearBranch.digest
    && savedCursorRow.established_escalation_digest === freshEscalation.digest;
}

// Both verification RPCs (migration 20260920010000) return the same
// TABLE(row_count BIGINT, digest TEXT) shape — PostgREST's JS client
// returns that as a one-row array.
function normalizeDigestRpcResult(data) {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.digest !== 'string') throw new Error('driver-cursor verification RPC returned an unexpected shape');
  return { rowCount: Number(row.row_count) || 0, digest: row.digest };
}

// Fix #2 (Neo's review of migration 20260920020000 — read that file's own
// header before changing anything here): p_established_floor_id/p_as_of
// both default to null, which collapses the RPC's WHERE clause to exactly
// the original, unscoped 20260920010000 behavior — this is what the
// VERIFICATION call site (resolveDriverStartCursor, below) always uses, by
// calling this function with no second argument at all. Only the PERSIST
// call site (persistDriverCursor) ever passes real floor/asOf values,
// scoping the time-bound to the territory the run that's persisting
// actually swept, not the whole cumulative range — see that migration's own
// header for why a global (unscoped) time-bound is unsafe.
async function fetchClearBranchDigest(cursorId, { establishedFloorId = null, asOf = null } = {}) {
  const { data, error } = await supabase.rpc('archive_search_missive_clear_branch_cursor_check', {
    p_cursor_id: cursorId,
    p_established_floor_id: establishedFloorId,
    p_as_of: asOf,
  });
  if (error) throw error;
  return normalizeDigestRpcResult(data);
}

async function fetchEscalationExclusionDigest() {
  const { data, error } = await supabase.rpc('archive_search_escalation_exclusion_digest_check');
  if (error) throw error;
  return normalizeDigestRpcResult(data);
}

async function fetchSavedDriverCursor(scopeKey) {
  const { data, error } = await supabase
    .from('archive_search_significance_driver_cursors')
    .select('*')
    .eq('scope', scopeKey)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// Never throws — see this section's own header for why "no usable cursor"
// (null) is always a safe fallback, never a correctness risk. scopeKey
// (driverCursorScopeKey(sinceDate)) means a call can only ever resume a
// cursor saved by an earlier call that used the SAME sinceDate — see this
// section's own "THIRD GAP" note above for why that, not the two digests,
// is what makes date-scope safe.
async function resolveDriverStartCursor(scopeKey) {
  try {
    const saved = await fetchSavedDriverCursor(scopeKey);
    if (!saved) return null;
    const [freshClearBranch, freshEscalation] = await Promise.all([
      fetchClearBranchDigest(saved.cursor_id),
      fetchEscalationExclusionDigest(),
    ]);
    if (cursorIsSafeToResume(saved, freshClearBranch, freshEscalation)) return saved.cursor_id;
    console.error(`[significance-pass] driver cursor for scope '${scopeKey}' exists but no longer matches live state (a screening reset or an escalation resolve/reopen happened behind it) — falling back to a full walk from the beginning this run. Expected/self-healing, not an error.`);
    return null;
  } catch (err) {
    console.error(`[significance-pass] could not verify saved driver cursor for scope '${scopeKey}' (${err.message}) — falling back to a full walk from the beginning this run.`);
    return null;
  }
}

// Never throws — see this section's own header for why a failed save can
// only cost the NEXT run its fast-forward, never a skipped conversation.
// scopeKey (driverCursorScopeKey(sinceDate)) is written as the row's own
// scope column, so a later call with a DIFFERENT sinceDate can never read
// this row back as if it applied to its own window.
//
// Fix #2 (floor/runStartedAt — migration 20260920020000): floorId is the
// cursor THIS RUN started from (captured by the caller BEFORE its
// pagination loop mutates its own cursor variable — see
// fetchNextEligibleConversations()'s own use of startingCursorFloor, below)
// and runStartedAt is this run's own start time. Passed straight through to
// fetchClearBranchDigest() so the persisted clear-branch digest only applies
// the screening_completed_at time-bound to territory this run actually
// swept (id > floorId), never to the whole cumulative id <= cursorId range —
// see that migration's own header for why a global bound is unsafe (routine
// re-screen-on-reply touches an old, unchanged 'clear' row's
// screening_completed_at with no real change to its eligibility). Both
// default to null, reproducing 20260920010000's original, unscoped
// behavior for any caller that doesn't pass them.
//
// Fix #3 (escalation snapshot reordering — Neo confirmed sound, no schema
// change): escalationDigest is no longer fetched fresh in here. The caller
// (fetchNextEligibleConversations) fetches it once, at the same moment it
// fetches fetchEscalationExclusionSet() for this run's own row-filtering,
// and threads that SAME snapshot through to every persistDriverCursor()
// call this run makes — never a second, independent fetch minutes later.
// Escalation exclusion has no id-range/floor split to worry about (it's one
// global set, not scoped by cursor), so a single start-of-run snapshot is
// simply correct, and reusing it (rather than re-fetching "fresher" state at
// the end of a long run) is what keeps the persisted digest consistent with
// the actual set this run filtered against.
//
// escalationDigest can be null (the caller's own best-effort fetch of it
// failed) — that is treated exactly like any other unpersistable state: skip
// the save entirely and log why, never throw. This matters more than it did
// before this fix: escalationDigest is now fetched once, up front, outside
// any per-call try/catch of its own (see fetchNextEligibleConversations()),
// specifically so a failure there can NEVER take down real eligibility
// scanning — only the ability to persist a cursor for THIS run.
async function persistDriverCursor(cursorId, scopeKey, { exhausted, floorId = null, runStartedAt = null, escalationDigest = null } = {}) {
  if (!escalationDigest) {
    console.error(`[significance-pass] skipping driver-cursor persist for scope '${scopeKey}' — no escalation-exclusion digest snapshot was available for this run; next run will simply re-walk from the beginning instead of fast-forwarding; no conversation is at risk from this.`);
    return;
  }
  try {
    const clearBranch = await fetchClearBranchDigest(cursorId, { establishedFloorId: floorId, asOf: runStartedAt });
    const escalation = escalationDigest;
    const nowIso = new Date().toISOString();
    const { error } = await supabase
      .from('archive_search_significance_driver_cursors')
      .upsert({
        scope: scopeKey,
        cursor_id: cursorId,
        established_clear_branch_count: clearBranch.rowCount,
        established_clear_branch_digest: clearBranch.digest,
        established_escalation_count: escalation.rowCount,
        established_escalation_digest: escalation.digest,
        last_confirmed_at: nowIso,
        exhausted_at: exhausted ? nowIso : null,
      }, { onConflict: 'scope' });
    if (error) throw error;
  } catch (err) {
    console.error(`[significance-pass] could not persist driver cursor for scope '${scopeKey}' (${err.message}) — next run will simply re-walk from the beginning instead of fast-forwarding; no conversation is at risk from this failure.`);
  }
}

/**
 * @param {number} targetCount
 * @param {string|null} [sinceDate] ISO date string, or null/undefined for
 *   no cutoff (default — unchanged behavior for every existing caller).
 *   Applied as a client-side filter (passesSinceDate(), defined just below
 *   fetchDriverPage() above) on each page's raw rows — see the PERFORMANCE
 *   NOTE above DRIVER_PAGE_SIZE for why this isn't a SQL WHERE clause.
 * @returns {Promise<{mailbox_key:string, missive_conversation_id:string}[]>}
 *   up to targetCount NEW (not-yet-processed) conversations, deduped.
 */
async function fetchNextEligibleConversations(targetCount, sinceDate = null) {
  const found = [];
  const foundKeys = new Set();

  // escalationKeys is REQUIRED — the actual row-filtering predicate this
  // whole function's real job (finding eligible conversations) depends on;
  // if this fails, the caller has no safe way to guess exclusion, so this
  // still throws and fails the whole call, exactly as it always has.
  const escalationKeys = await fetchEscalationExclusionSet(); // fetched ONCE per call, not once per page — see that function's own header comment.

  // Fix #3 (Neo's review, migration 20260920020000): fetch the escalation
  // DIGEST from the SAME moment as escalationKeys above, so the digest
  // persisted at the end of this run matches the actual set this run
  // filtered against — never a second, independent fetch minutes later (see
  // persistDriverCursor()'s own comment for why that matters). Deliberately
  // best-effort, NOT awaited alongside escalationKeys in the same
  // Promise.all/try: this digest only feeds the PERSIST side of this
  // mechanism, never eligibility itself, so a failure here must never take
  // down real scanning — null just means this run's cursor won't be
  // persisted (no fast-forward next time), the same safe degradation every
  // other part of this mechanism already uses.
  let escalationDigest = null;
  try {
    escalationDigest = await fetchEscalationExclusionDigest();
  } catch (err) {
    console.error(`[significance-pass] could not snapshot an escalation-exclusion digest at the start of this run (${err.message}) — this run's cursor will not be persisted, but eligibility scanning itself is unaffected.`);
  }

  // Fix #2 (Neo's review, migration 20260920020000): run_started_at and the
  // STARTING cursor ("floor") are what let persistDriverCursor() scope its
  // time-bound to only the territory THIS RUN newly swept, instead of the
  // entire cumulative id<=cursor range. floor MUST be captured here, right
  // after resolveDriverStartCursor() resolves it and BEFORE the pagination
  // loop below starts reassigning lastId — lastId ends the loop pointing at
  // the run's FINAL cursor, never the one it started from. On a genuine
  // first-ever run (no saved cursor to resume), floor is null, which
  // correctly degenerates the RPC's time-bound to the original, whole-range
  // bound — the entire walked range really is new territory in that case.
  const runStartedAt = new Date().toISOString();
  const cursorScopeKey = driverCursorScopeKey(sinceDate); // this call can only ever resume/overwrite a cursor saved by an earlier call using the SAME sinceDate — see the "THIRD GAP" note above cursorIsSafeToResume() for why.
  let lastId = await resolveDriverStartCursor(cursorScopeKey); // null = full walk from the beginning (no saved cursor for this scope, or it failed verification — see that function's own header for why this is always safe).
  const startingCursorFloor = lastId; // captured NOW — before the loop below ever reassigns lastId.

  const persistThisRunsCursor = (cursorId, { exhausted }) =>
    persistDriverCursor(cursorId, cursorScopeKey, { exhausted, floorId: startingCursorFloor, runStartedAt, escalationDigest });

  for (;;) {
    const page = await fetchDriverPage(lastId);
    if (page.length === 0) {
      if (lastId !== null) await persistThisRunsCursor(lastId, { exhausted: true }); // nothing new since lastId — record it as confirmed-current, not just confirmed-at-a-past-moment.
      break;
    }
    lastId = page[page.length - 1].id; // advance from the RAW page, before the date/escalation filters below — pagination must progress through every message row regardless of whether it passes either filter, or a long run of filtered-out messages would re-fetch the same page forever. NOTE: this is only a safe cursor value once the WHOLE page has actually been walked (the two persistThisRunsCursor() calls below this line, both reached only after the per-pair loop runs to completion) — see firstRowIdForPair below for the mid-page early-exit case, where it is NOT safe.

    const datePassingRows = page.filter((row) => passesSinceDate(row, sinceDate));
    const eligibleRows = datePassingRows.filter((row) => passesEscalationExclusion(row, escalationKeys));

    // Bug fix (TARS repro, mid-page targetCount stop): mirrors dedupeNewPairs'
    // own first-seen-wins dedup below, purely to remember which RAW row id
    // each surviving pair FIRST appeared at in this page — kept as a separate
    // pass rather than changing dedupeNewPairs' own return shape (its unit
    // tests below assert the exact {mailbox_key, missive_conversation_id}
    // shape, untouched here). Needed because `lastId` above is the id of the
    // page's LAST row, computed before any row in this page has actually been
    // examined for eligibility — correct to persist only once the per-pair
    // loop below runs to completion (every row in the page really was
    // examined). If that loop instead returns early because targetCount was
    // hit partway through, persisting `lastId` would tell the NEXT run to
    // fast-forward past rows this run never looked at — rows 4-500 of a
    // 500-row page, in TARS's repro, silently and permanently skipped. The
    // fix: when stopping early, persist the id of the row where the LAST
    // pair actually added to `found` first appeared, not the page's end — so
    // the next run resumes exactly where examination left off, not past it.
    const firstRowIdForPair = new Map();
    for (const row of eligibleRows) {
      const key = `${row.mailbox_key}::${row.missive_conversation_id}`;
      if (!firstRowIdForPair.has(key)) firstRowIdForPair.set(key, row.id);
    }

    const pairs = dedupeNewPairs(eligibleRows, foundKeys);
    const eligible = await filterAlreadyProcessed(pairs);
    for (const pair of eligible) {
      const key = `${pair.mailbox_key}::${pair.missive_conversation_id}`;
      foundKeys.add(key);
      found.push(pair);
      if (found.length >= targetCount) {
        // Stopped early (hit target): rows after this pair's first-seen row
        // were never examined this run (not filtered, not checked, not
        // returned) — persist THAT row's id, not this page's end, so they
        // are re-examined, not skipped, next run.
        const examinedThroughId = firstRowIdForPair.get(key);
        await persistThisRunsCursor(examinedThroughId, { exhausted: false });
        return found;
      }
    }

    if (page.length < DRIVER_PAGE_SIZE) { // exhausted the view — the per-pair loop above ran to completion, so every row in this page really was examined; lastId (this page's true last row) is a safe resume point.
      await persistThisRunsCursor(lastId, { exhausted: true });
      break;
    }
  }
  return found;
}

// ============================================================
// countDistinctEligibleConversations — the conversation-level counting half
// of estimateExpectedEligiblePool() (below), added 2026-09-21 to fix the
// message-vs-conversation bug documented in that function's own header.
// Reuses fetchDriverPage() and passesSinceDate() exactly as
// fetchNextEligibleConversations() itself does — same underlying data
// source (2026-09-21: fetchDriverPage() itself switched from the
// clear_branch view to an equivalent RPC function; see that function's own
// header comment for why — this function needed no change of its own
// because it never queried anything directly, it only ever called
// fetchDriverPage()), same plain `ORDER BY id ASC` / bare `id > cursor`
// query shape, same three-plus-id columns back. sinceDate is therefore
// never sent to Postgres here either — it is applied client-side, per row,
// via passesSinceDate(), the same as the real scan.
//
// Walks every page to exhaustion — unlike fetchNextEligibleConversations(),
// this needs the TRUE total, not "enough to fill one batch," so it never
// stops early at a target count. Returns the number of DISTINCT
// `${mailbox_key}::${missive_conversation_id}` pairs seen, using the same
// composite-key convention already used elsewhere in this file
// (dedupeNewPairs, passesEscalationExclusion, filterAlreadyProcessed). This
// is a metadata-only walk (id/mailbox_key/missive_conversation_id/
// delivered_at only — no escalation-set fetch, no filterAlreadyProcessed
// round trip, no AI call), so even a full walk of the view stays cheap
// relative to an actual submission pass. A single COUNT-only query would be
// faster still, but PostgREST/supabase-js has no way to ask Postgres for a
// DISTINCT count of a composite key without a new database function or
// view — a schema change, out of scope for this fix (see
// estimateExpectedEligiblePool()'s own header).
// ============================================================
async function countDistinctEligibleConversations(sinceDate) {
  const seen = new Set();
  let cursor = null;
  for (;;) {
    const page = await fetchDriverPage(cursor);
    if (page.length === 0) break;
    cursor = page[page.length - 1].id; // advance from the RAW page, same discipline fetchNextEligibleConversations() uses — see that function's own comment for why.
    for (const row of page) {
      if (passesSinceDate(row, sinceDate)) seen.add(`${row.mailbox_key}::${row.missive_conversation_id}`);
    }
    if (page.length < DRIVER_PAGE_SIZE) break; // exhausted the view
  }
  return seen.size;
}

// ============================================================
// estimateExpectedEligiblePool — added 2026-09-19, the real-incident-class
// safeguard. THE INCIDENT: a real production submission run's eligibility
// scan (fetchNextEligibleConversations, above) found only 33,755 eligible
// conversations when the real, independently-verified pool was ~84,192 — a
// silent ~60% undercount, with no error thrown anywhere in the chain from
// the database call up through the CLI entry point. Two extensive
// investigations (Neo's, and a second one directly) could not prove the
// exact root cause, and it did not reproduce on two independent clean
// re-runs of the identical code. Given that, this is deliberately NOT an
// attempt to re-derive or double-check the exact eligible set — it is a
// cheap, independent SANITY CHECK that makes this whole CLASS of silent
// undercount impossible to ship past without a human looking at it, no
// matter what actually caused any individual occurrence of it. The
// consuming half of this check (the actual pass/fail threshold) lives in
// lib/significance-batch.js's checkEligiblePoolSanity()/dispatchRunChunks()
// — see that file's own EXPECTED_POOL_MIN_RATIO comment for the threshold
// reasoning; this function only produces the estimate.
//
// FIXED 2026-09-21 (Neo's finding, database specialist): term (1) below
// used to count MESSAGE rows matching the date cutoff via a single
// COUNT-only query, not distinct CONVERSATIONS — one conversation routinely
// contributes several matching message rows, and Neo measured the real
// production messages-per-conversation ratio at 2.513x. That inflated (1)
// by roughly 2.5x before the subtraction below ever happened, which
// inflated expectedPool by the same ~2.5x — the false-alarm direction this
// safeguard must never produce (see the "safer direction to be wrong"
// reasoning below, which the old message-counting approach violated,
// despite an earlier version of this comment incorrectly rationalizing it
// as "conservative"). Confirmed live: a verified-correct real count of
// 10,107 eligible conversations for since_date=2025-09-17 looked like only
// ~16.7% of the old, message-counted ~60,544 estimate, tripping the 70%
// guard and forcing an unnecessary manual --force override.
//
// (1) now counts DISTINCT conversations — via
// countDistinctEligibleConversations(), immediately above — matching how
// the actual eligibility scan (fetchNextEligibleConversations(), above)
// itself counts things. This can no longer be a single COUNT-only query the
// way (2) still is; see countDistinctEligibleConversations()'s own header
// for why:
//   1. How many DISTINCT (mailbox_key, missive_conversation_id) pairs in
//      missive_message_intake_search_safe_clear_branch — the SAME table
//      fetchDriverPage() itself pages through — have at least one row
//      matching the same delivered_at >= sinceDate condition
//      passesSinceDate() applies client-side.
//   2. How many rows exist, TOTAL, in missive_conversation_significance —
//      every conversation this pass has ever fully processed, table-wide,
//      deliberately NOT scoped by sinceDate (this task's own explicit
//      instruction) — a coarse, cheap upper bound on "already done," not an
//      authoritative per-window count.
//
// expectedPool = max(0, (1) - (2)) — an APPROXIMATION, stated plainly, not
// a second authoritative computation:
//   - (1) now counts CONVERSATIONS, matching the true grain of the pool
//     this estimate approximates — no longer inflated by
//     messages-per-conversation.
//   - (2) is NOT scoped to sinceDate at all, so it can push the other way:
//     whenever a meaningful share of already-processed conversations sit
//     outside this run's own date window, expectedPool comes out LOWER
//     than the true pool. That is the safer direction to be wrong in for a
//     check whose whole job is "don't demand more from the real scan than
//     is fair" — it never manufactures a false alarm by overstating what
//     was expected.
//   - Neither term accounts for the small, legitimate exclusions
//     fetchNextEligibleConversations() itself applies (an open Fair
//     Housing escalation, a conversation whose messages disappeared
//     between the scan and now) — measured, not assumed, to be small
//     relative to the ~60% gap this check exists to catch.
// @param {string|null} [sinceDate] same ISO-date-string/null semantics as
//   fetchNextEligibleConversations' own sinceDate parameter.
// @returns {Promise<{expectedPool:number, totalMatchingConversations:number, totalAlreadyProcessed:number}>}
// ============================================================
async function estimateExpectedEligiblePool(sinceDate = null) {
  const totalMatchingConversations = await countDistinctEligibleConversations(sinceDate);

  const { count: totalAlreadyProcessed, error: processedErr } = await supabase
    .from('missive_conversation_significance')
    .select('id', { count: 'exact', head: true });
  if (processedErr) throw processedErr;

  const expectedPool = Math.max(0, totalMatchingConversations - (totalAlreadyProcessed || 0));
  return { expectedPool, totalMatchingConversations, totalAlreadyProcessed: totalAlreadyProcessed || 0 };
}

// ============================================================
// PENDING — the override branch (archive_search_flagged_overrides, ~127
// active rows) is NOT implemented anywhere in this file. Migration
// 20260918020000's own "THE FIX" section confirms this directly: the
// design for it (fetch the small active-override set, then ask the full,
// unmodified missive_message_intake_search_safe view for exactly those
// conversations) was specified by 20260918000000 but "still not yet
// implemented in significance-pass.js." fetchNextEligibleConversations()
// above therefore only ever returns Branch 1 (clear, non-escalated)
// conversations today — overridden conversations are simply not part of
// this pass's eligible set yet, in either direction.
//
// Flagged explicitly here, rather than built, because building it is new
// functionality (a fetch mechanism that does not exist to extend), not a
// wire-up of an existing one — outside this handoff's scope ("don't touch
// the override branch's own fetch mechanism" presumes one exists). When
// that branch is built, its own rows MUST be run through
// passesEscalationExclusion() / the same escalationKeys Set
// fetchEscalationExclusionSet() produces, before merging into the eligible
// set — see fetchEscalationExclusionSet()'s own header comment and
// migration 20260918020000's point 4 for exactly why (an overridden
// conversation with a later, real, open Fair-Housing escalation must still
// be excluded).
// ============================================================

// ============================================================
// Real pilot bug #2, 2026-09-13 (Scotty's diagnosis, independently
// confirmed live: 28 real conversations stuck this way after the pilot's
// escalation_signal crash). fetchNextEligibleConversations() above only
// ever selects conversations with NO row yet in
// missive_conversation_significance. A conversation whose Call 1
// succeeded (so a row WAS upserted) but whose Call 2 — or the complaints
// insert immediately after it — then threw, is left with a real row,
// call2_completed_at still NULL, and now has an existing row, so the
// query above will never select it again: permanently, silently stuck.
// This is the other side of that gap: existing rows that still need Call
// 2. needsCall2 (not just "call2_completed_at IS NULL" alone) is required
// to exclude the routine_logistics+resolved rows that legitimately never
// get a Call 2 at all — see needsCall2's own comment above for why that
// distinction matters. The .or() clause below pushes the same needsCall2
// condition into the query for efficiency; needsCall2 is re-applied in
// application code right after as the actual, unit-tested source of
// truth, matching this file's existing convention (dedupeNewPairs' own
// header comment) of never trusting an untested DB round-trip alone for
// the part that decides correctness.
async function fetchIncompleteSignificanceRows(targetCount) {
  const { data, error } = await supabase
    .from('missive_conversation_significance')
    .select('id, mailbox_key, missive_conversation_id, category, resolution_status, why, discovery_context, keyword_check_flagged_protected_class, keyword_check_flagged_category')
    .is('call2_completed_at', null)
    .or('category.neq.routine_logistics,resolution_status.neq.resolved')
    .order('computed_at', { ascending: true })
    .limit(targetCount);
  if (error) throw error;
  return (data || []).filter((row) => rowNeedsCall2Retry({
    category: row.category, resolution_status: row.resolution_status, call2_completed_at: null, // the .is() filter above already guarantees this; spelled out for rowNeedsCall2Retry's own shared signature.
  }));
}

// ============================================================
// Per-conversation processing.
// ============================================================
async function fetchConversationMessages(mailbox_key, missive_conversation_id) {
  const { data, error } = await supabase
    .from('missive_message_intake_search_safe')
    .select('id, mailbox_key, missive_conversation_id, missive_message_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, body_text, delivered_at, screening_completed_at')
    .eq('mailbox_key', mailbox_key)
    .eq('missive_conversation_id', missive_conversation_id)
    .order('delivered_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

// missive_message_links — address-match rows (always attempted) and
// content-extracted VENDOR rows only (never tenant/owner — see
// IDENTIFICATION_BLOCK's own comment above for why). Best-effort: a
// failure here is logged and does not fail the whole conversation, since
// this is an enrichment table, not core to the significance row itself.
async function writeMessageLinks({ mailbox_key, missive_conversation_id, addressMatch, identification, vendorDirectory, anchorMessageId }) {
  const rows = [];

  if (addressMatch.subject_type && addressMatch.subject_id) {
    rows.push({
      mailbox_key,
      missive_message_id: anchorMessageId,
      missive_conversation_id,
      property_id: addressMatch.property_id || null,
      subject_type: addressMatch.subject_type,
      subject_id: addressMatch.subject_id,
      match_method: 'address_match',
      matched_field: 'email',
    });
  } else if (addressMatch.vendor_id) {
    rows.push({
      mailbox_key,
      missive_message_id: anchorMessageId,
      missive_conversation_id,
      property_id: null,
      subject_type: 'vendor',
      subject_id: addressMatch.vendor_id,
      match_method: 'address_match',
      matched_field: 'email',
    });
  } else if (identification && identification.vendor_text) {
    const vendorMatch = resolveUniqueMatch(identification.vendor_text, vendorDirectory, ['company_name']);
    if (vendorMatch) {
      rows.push({
        mailbox_key,
        missive_message_id: anchorMessageId,
        missive_conversation_id,
        property_id: null,
        subject_type: 'vendor',
        subject_id: vendorMatch.id,
        match_method: 'content_extracted',
        source_reference: identification.vendor_text,
        confidence: 0.7,
        extracted_by: CONTENT_PASS_VERSION,
      });
    }
  }

  for (const row of rows) {
    const { error } = await supabase.from('missive_message_links').insert(row);
    if (error) console.error(`[significance-pass] missive_message_links insert failed for ${missive_conversation_id}:`, error.message);
  }
}

async function getActiveComplaintTrackingConfig() {
  const { data, error } = await supabase.from('complaint_tracking_config').select('*').eq('is_active', true).maybeSingle();
  if (error) throw error;
  return data || null;
}

// The deterministic, DB-only half of per-conversation setup — everything
// both processConversation() (fresh) and retryCall2ForExistingRow() (Bug 2
// fix, existing-but-incomplete rows) need before their two different
// starting points (run Call 1, vs. reuse a stored Call 1 result) converge
// on the same Call 2 phase. Pulled out so the two callers cannot drift.
async function buildConversationContext(mailbox_key, missive_conversation_id) {
  const rows = await fetchConversationMessages(mailbox_key, missive_conversation_id);
  if (rows.length === 0) return null;

  const thread = toThreadShape(missive_conversation_id, rows);
  const addresses = collectAllAddresses(thread);
  const addressMatch = await matchParticipantsToRecords(supabase, addresses);
  const addressMatched = !!(addressMatch.subject_type || addressMatch.vendor_id);
  const threadText = threadFullText(thread);
  return { rows, thread, addresses, addressMatch, addressMatched, threadText };
}

/**
 * The full per-conversation pipeline for a conversation that has NEVER
 * been processed before — runs Call 1, writes the significance row, then
 * hands off to runCall2Phase() for everything from the Call 2 gate onward.
 * Never throws for an ordinary AI/DB hiccup on Call 2 (fails closed into a
 * placeholder write instead, inside runCall2Phase) — only throws on a
 * genuine total Call 1 failure (caller's job to log and skip) or an
 * unexpected DB error, matching screening-pass.js's own per-conversation
 * try/catch contract.
 * @returns {Promise<{outcome:string, significance_id:string|null, complaint_id:string|null}>}
 */
async function processConversation({ mailbox_key, missive_conversation_id }, discoveryContext, sharedDirectories) {
  const context = await buildConversationContext(mailbox_key, missive_conversation_id);
  if (!context) return { outcome: 'skipped_empty', significance_id: null, complaint_id: null };
  const { rows, thread, addressMatch, addressMatched, threadText } = context;

  const call1 = await runCall1({ threadText, addressMatched, mailbox_key, missive_conversation_id });
  if (!call1) return { outcome: 'call1_failed', significance_id: null, complaint_id: null }; // no row — stays eligible for the next run.

  const applied = await applyCall1Result({ mailbox_key, missive_conversation_id, discoveryContext, call1, rows, addressMatch, threadText, sharedDirectories });

  return runCall2Phase({
    significanceId: applied.significanceId, mailbox_key, missive_conversation_id, discoveryContext,
    category: call1.category, resolution_status: call1.resolution_status, why: call1.why,
    thread, threadText, rows, addressMatch,
    flaggedProtectedClass: applied.keywordCheck.flagged_protected_class, flaggedCategory: applied.keywordCheck.flagged_category,
    property_id: applied.property_id, vendor_id: applied.vendor_id,
  });
}

// ============================================================
// The database-write half of Call 1 — pulled out of processConversation()
// (2026-09-17, the Batches API build) purely so a SECOND caller can reuse it
// verbatim: lib/significance-batch.js's write-back tool obtains a Call 1
// result from a downloaded Anthropic batch result (parseCall1Response on
// text that came back from client.beta.messages.batches.results(), not from
// runCall1()) and needs to apply it through the exact same property/vendor
// resolution -> checkClaim -> significance upsert -> message links -> audit
// log sequence processConversation always used — "do not reimplement the
// database write" was that build's own explicit instruction. Zero behavior
// change from the code this replaced: same order, same fields, same
// conditionals — only relocated and given a name, same precedent as
// buildConversationContext/runCall2Phase already being pulled out earlier
// for the identical "two callers must never drift" reason.
//
// Deliberately stops short of runCall2Phase — processConversation (the
// synchronous path, just above) chains into it immediately after this
// returns; the Batches API write-back path does NOT, on purpose. Call 2
// is never triggered synchronously off of a Call 1 batch result — see
// significance-batch.js's own header for why (Peter reviews Call 1's real
// results before Call 2 is ever submitted, deliberately, as its own later
// batch).
// @returns {Promise<{significanceId:string, property_id:string|null, vendor_id:string|null, keywordCheck:object}>}
// ============================================================
async function applyCall1Result({ mailbox_key, missive_conversation_id, discoveryContext, call1, rows, addressMatch, threadText, sharedDirectories }) {
  const addressMatched = !!(addressMatch.subject_type || addressMatch.vendor_id);

  // Prompt B property/vendor resolution — deterministic, verified against
  // real rows (never the model's own guess used directly).
  let property_id = addressMatch.property_id || null;
  let vendor_id = addressMatch.vendor_id || null;
  if (!addressMatched) {
    if (call1.identification.property_text) {
      const propertyMatch = resolveUniqueMatch(call1.identification.property_text, sharedDirectories.properties, ['name', 'address']);
      if (propertyMatch) property_id = propertyMatch.id;
    }
    if (call1.identification.vendor_text) {
      const vendorMatch = resolveUniqueMatch(call1.identification.vendor_text, sharedDirectories.vendors, ['company_name']);
      if (vendorMatch) vendor_id = vendorMatch.id;
    }
  }

  // checkClaim() — Mason's Finding 3: an independent second layer.
  // REMOVED 2026-09-17: modelFlag/modelCategory used to carry Call 1's own
  // protected-class self-report through to checkClaim()'s Layer 2. Call 1
  // no longer asks that question (see this file's own header/prompt
  // comments above), so there is nothing to pass here anymore. checkClaim()
  // treats modelFlag as optional (content-check.js: `!!claim.modelFlag`
  // — undefined is falsy) — omitting it simply means this check now runs
  // on Layer 1 (the keyword/Tier A/Tier B scan) alone, exactly the
  // "genuine, independent second layer" this file's own header already
  // promised, never dependent on or folded into Call 1's output.
  // checkClaim() itself is completely unmodified by this change.
  const keywordCheck = await checkClaim({ claim_text: threadText });

  const significanceRow = {
    mailbox_key,
    missive_conversation_id,
    resolution_status: call1.resolution_status,
    category: call1.category,
    why: call1.why,
    tone_trend: call1.tone_trend,
    // Hardcoded, not read from call1 — Call 1 no longer produces these
    // fields at all (2026-09-17 removal, Peter's decision, Mason
    // confirmed non-blocking). The columns stay in the schema (no
    // migration — Neo's call, not made here) and simply go permanently
    // false/null for every row processed from this change forward.
    // Verified independently (not just trusting Mason's summary): neither
    // column is read by is_big_issue (its GENERATED formula only
    // references category/escalation_signal/human_confirmed_big_issue —
    // supabase/migrations/20260913020000_..._schema.sql), by
    // shouldCreateComplaint() (below — keys only on escalation_signal/
    // needs_human_call/owner_instruction_rejected/category), or by the
    // audit_log trigger just below (keyed on keywordCheck.
    // flagged_protected_class, the keyword-check output, never this
    // field). The one real reader is the pilot CSV export (router.js,
    // GET .../significance-pilot-export) — a cosmetic display column,
    // left as a plain passthrough of whatever's in the DB; it will simply
    // read false for every row processed after this change, which is
    // accurate, not broken or misleading.
    protected_class_flag: false,
    protected_class_category: null,
    keyword_check_flagged_protected_class: keywordCheck.flagged_protected_class,
    keyword_check_flagged_category: keywordCheck.flagged_category,
    keyword_check_matched_layer: keywordCheck.matched_layer,
    keyword_check_terms_version: keywordCheck.terms_version,
    content_identification_attempted: !addressMatched,
    source_screening_completed_at: rows[0].screening_completed_at,
    discovery_context: discoveryContext,
    extracted_by: CONTENT_PASS_VERSION,
  };

  const { data: upserted, error: upsertErr } = await supabase
    .from('missive_conversation_significance')
    .upsert(significanceRow, { onConflict: 'mailbox_key,missive_conversation_id' })
    .select()
    .single();
  if (upsertErr) throw upsertErr;

  await writeMessageLinks({
    mailbox_key, missive_conversation_id, addressMatch,
    identification: call1.identification, vendorDirectory: sharedDirectories.vendors,
    anchorMessageId: rows[0].missive_message_id,
  });

  if (keywordCheck.flagged_protected_class) {
    await writeAuditLog({
      action: 'complaint_tracking.protected_class_flagged',
      entity_type: 'missive_conversation_significance',
      entity_id: upserted.id,
      actor_type: keywordCheck.matched_layer === 'keyword_tier_a' ? 'system' : 'ai_agent',
      actor_id: CONTENT_PASS_VERSION,
      property_id,
      risk_level: 'high',
      privacy_category: 'processing',
      details: { flagged_category: keywordCheck.flagged_category, matched_layer: keywordCheck.matched_layer, terms_version: keywordCheck.terms_version },
    });
  }

  return { significanceId: upserted.id, property_id, vendor_id, keywordCheck };
}

/**
 * Real pilot bug #2 fix, 2026-09-13 — Call 2 (+ complaints-creation) retry
 * for a conversation whose significance row already exists with valid
 * Call 1 data (category/resolution_status/why already stored, per
 * fetchIncompleteSignificanceRows above) but call2_completed_at is still
 * NULL. Deliberately does NOT call runCall1() again — Call 1 already
 * succeeded the first time; re-running it would waste a real, billed AI
 * call re-deriving data this pipeline already has and has already stored.
 * Address-match resolution IS re-run (cheap, deterministic, DB-only, no AI
 * call) since property_id/vendor_id aren't columns on missive_
 * conversation_significance and so were never persisted from the first
 * attempt.
 *
 * Known, deliberate, narrower scope than the fresh path (flagged
 * explicitly, not silently assumed): if the ORIGINAL Call 1 run resolved a
 * property or vendor only via its own content-extracted citation (Prompt
 * B — no address match at all), that citation was Call 1's own output and
 * is not recoverable here without re-running Call 1, which this function
 * deliberately avoids. This retry path only ever recovers an address-
 * match-based property_id/vendor_id, same as the fresh path gets when
 * addressMatched is true. This can only ever leave a retried complaint's
 * property_id/vendor_id less enriched than the original attempt would
 * have gotten it (falls back to needs_matching: true) — never wrong.
 * @returns {Promise<{outcome:string, significance_id:string|null, complaint_id:string|null}>}
 */
async function retryCall2ForExistingRow(existingRow) {
  const {
    id, mailbox_key, missive_conversation_id, category, resolution_status, why, discovery_context,
    keyword_check_flagged_protected_class, keyword_check_flagged_category,
  } = existingRow;

  const context = await buildConversationContext(mailbox_key, missive_conversation_id);
  if (!context) return { outcome: 'skipped_empty', significance_id: id, complaint_id: null };
  const { rows, thread, addressMatch, threadText } = context;

  return runCall2Phase({
    significanceId: id, mailbox_key, missive_conversation_id, discoveryContext: discovery_context,
    category, resolution_status, why, thread, threadText, rows, addressMatch,
    flaggedProtectedClass: keyword_check_flagged_protected_class, flaggedCategory: keyword_check_flagged_category,
    property_id: addressMatch.property_id || null, vendor_id: addressMatch.vendor_id || null,
  });
}

/**
 * Everything from the Call 2 gate onward — shared by the fresh path
 * (processConversation, just after Call 1 + the significance upsert) and
 * the retry path (retryCall2ForExistingRow, real pilot bug #2 fix, against
 * an existing row's already-stored category/resolution_status/why). Never
 * throws for an ordinary AI/DB hiccup on Call 2 itself (fails closed into
 * a placeholder write) — only on a genuine DB error, same contract as
 * processConversation always had.
 * @returns {Promise<{outcome:string, significance_id:string|null, complaint_id:string|null}>}
 */
async function runCall2Phase({
  significanceId, mailbox_key, missive_conversation_id, discoveryContext,
  category, resolution_status, why, thread, threadText, rows, addressMatch,
  flaggedProtectedClass, flaggedCategory, property_id, vendor_id,
}) {
  // Call 2 gate — spec Section 4, deliberately biased generous.
  const gate = needsCall2({ category, resolution_status });
  if (!gate) return { outcome: 'no_call2_needed', significance_id: significanceId, complaint_id: null };

  let silenceContext = null;
  if (discoveryContext === 'live_pipeline') {
    const config = await getActiveComplaintTrackingConfig();
    silenceContext = computeSilenceContext(thread, config ? config.blocked_resolution_silence_days : 2);
  }

  const call2Result = await runCall2({
    category, resolution_status, why,
    threadText, discoveryContext, silenceContext,
    mailbox_key, missive_conversation_id, // temporary — only consumed by logHermesUsage() inside runCall2(); buildCall2Prompt() does not read these keys.
  });

  let call2Fields;
  if (call2Result.ok) {
    const v = call2Result.value;

    // Reuses the existing owner_instruction_note_text slot (both tables)
    // rather than adding a new column — Mason's recommendation (Follow-up
    // to Finding 2, point 3): this is a straight passthrough of the
    // model's own factual owner_instruction_summary, never a drafted
    // response or an assessment. Populated identically for live and
    // historical mail now (previously live-only) — a human clearing a
    // historical "uncertain" needs the source sentence at least as much
    // as one clearing a live "true". null when Call 2 didn't ask about an
    // owner instruction at all, or the model didn't return one.
    const owner_instruction_note_text = resolveOwnerInstructionNoteText({ category, owner_instruction_summary: v.owner_instruction_summary });

    call2Fields = {
      escalation_signal: v.escalation_signal,
      blocked_reason: v.blocked_reason,
      blocked_party: v.blocked_party,
      needs_human_call: v.needs_human_call,
      owner_instruction_rejected: v.owner_instruction_rejected === null ? null : String(v.owner_instruction_rejected),
      owner_instruction_note_text,
      call2_completed_at: new Date().toISOString(),
    };
  } else {
    // Fail-closed placeholder — spec Section 5: write the row with
    // needs_human_call=true and call2_completed_at left NULL, never no
    // trace at all.
    call2Fields = {
      escalation_signal: null, blocked_reason: null, blocked_party: null,
      needs_human_call: true, owner_instruction_rejected: null, owner_instruction_note_text: null,
      call2_completed_at: null,
    };
  }

  let complaintId = null;
  if (shouldCreateComplaint({
    escalation_signal: call2Fields.escalation_signal, needs_human_call: call2Fields.needs_human_call,
    owner_instruction_rejected: call2Fields.owner_instruction_rejected, category,
  })) {
    // Idempotency guard — see findExistingComplaintForConversation()'s own
    // header comment above for the full reasoning. Short version: this is
    // the fix for the exact gap Judge found — reuse an already-existing
    // complaint for this conversation (left behind by an earlier,
    // interrupted run) instead of inserting a second one.
    const existingComplaint = await findExistingComplaintForConversation(missive_conversation_id);
    if (existingComplaint) {
      complaintId = existingComplaint.id;
      await writeAuditLog({
        action: 'complaint_tracking.duplicate_insert_prevented',
        entity_type: 'complaint',
        entity_id: complaintId,
        actor_type: 'system',
        risk_level: 'low',
        privacy_category: 'processing',
        property_id,
        details: { category, discovery_context: discoveryContext, source_missive_conversation_id: missive_conversation_id },
      });
    } else {
      // "When the refusal was received, or when the silence clock started"
      // (complaint-tracking's own Design Decision 4) — the most recent
      // message's own date is the one real anchor available either way, for
      // BOTH live and historical mail (a historical blocked_resolution read
      // — rare, since historicalFraming steers the model away from
      // inferring it from silence alone, but still possible from the
      // thread's actual content — should anchor to when that happened, not
      // to the moment this backfill run happened to process the row).
      const lastMessageDate = rows[rows.length - 1] && rows[rows.length - 1].delivered_at;
      complaintId = await createComplaintRow({
        mailbox_key, missive_conversation_id, discoveryContext,
        category, call2Fields,
        keywordCheck: { flagged_protected_class: flaggedProtectedClass, flagged_category: flaggedCategory },
        property_id, vendor_id, addressMatch,
        blockedSinceIso: lastMessageDate || new Date().toISOString(),
      });
    }
    call2Fields.complaint_id = complaintId;
  }

  const { error: updateErr } = await supabase
    .from('missive_conversation_significance')
    .update(call2Fields)
    .eq('id', significanceId);
  if (updateErr) throw updateErr;

  return { outcome: call2Result.ok ? 'call2_completed' : 'call2_failed_placeholder', significance_id: significanceId, complaint_id: complaintId };
}

// ============================================================
// Idempotency guard for createComplaintRow() — Judge review, 2026-09-13.
// The gap: createComplaintRow() and runCall2Phase()'s own significance-row
// update just after it (call2_completed_at/complaint_id) are two separate,
// non-transactional Supabase calls. If the process is interrupted between
// them — exactly the kind of mid-run interruption that already happened
// once tonight (Scotty killing a hung pilot process) — a real complaints
// row now exists but the significance row still shows call2_completed_at
// IS NULL. The next run's fetchIncompleteSignificanceRows() selects that
// row again as "stuck" (it doesn't even select complaint_id — it has no
// way to know one might already exist), retryCall2ForExistingRow() runs
// Call 2 again, and shouldCreateComplaint() — especially likely on the
// fail-closed needs_human_call:true placeholder path just above, which
// doesn't depend on re-reading anything — returns true again, creating a
// SECOND complaints row for the same conversation. findPossibleDuplicate()
// does not catch this: it's skipped entirely for historical_backfill, and
// even where it runs (live_pipeline) it only tags a "suggested" duplicate
// by subject+time heuristic, never blocks the insert.
//
// Fix: before ever inserting, check whether a complaints row already
// exists for this exact conversation, and reuse it instead. This makes
// the whole branch idempotent under retry regardless of where an earlier
// run got interrupted.
//
// Scoped to source_missive_conversation_id alone, deliberately, not
// (mailbox_key, source_missive_conversation_id) — mailbox_key is not a
// column on complaints today. missive_conversation_id is only unique
// WITHIN a mailbox (this file's own filterAlreadyProcessed() above and
// screening-pass.js's fetchEarliestBodyTextForConversations() both already
// document and work around the identical fact), so at real multi-mailbox
// scope this check could in principle reuse a complaint from the wrong
// mailbox's unrelated, same-ID conversation. Checked, not assumed, before
// accepting that gap: per missive_sync_state's own column comment
// (20260905020000), mailbox_key is currently a Missive Team UUID and this
// pipeline runs at "2-Team-Inbox scope" — a real, live possibility of
// collision, not a theoretical one. Flagged for Neo as a candidate
// follow-up migration (add a mailbox_key column to complaints) — not built
// here: that is a schema change, and this fix's job is the application-
// code idempotency gap Judge found, not a new migration. Accepted as Q's
// own judgment call for the same reason Judge named it an acceptable
// stopgap: the failure mode this leaves open (wrongly reusing a different
// mailbox's complaint) is narrower and less severe than the bug being
// fixed (an unbounded, silently growing number of duplicate rows for the
// SAME conversation), and only becomes live once a second mailbox is
// added under the individual-mailbox phase that schema's own comment says
// is "separate, not-yet-approved."
//
// Ordering left deliberately unchanged (complaint write, then significance
// update) rather than flipping it or wrapping both in a transaction:
// call2_completed_at IS NULL is the ONLY signal fetchIncompleteSignificance
// Rows() has for "this row needs a Call 2 retry" (rowNeedsCall2Retry's own
// header comment). Writing call2_completed_at first, or in the same "step"
// as the complaint, would remove that signal — an interruption right after
// would leave a row that looks fully done with no complaint and no way to
// ever retry it, a WORSE failure mode than the one being fixed here, not a
// better one. A true Postgres transaction (e.g. via an RPC function) was
// also considered and rejected: Supabase's JS client has no clean multi-
// table transaction primitive without one, and this check-then-reuse
// approach already satisfies the one hard requirement — an interrupted run
// can never create two complaints rows for the same conversation.
// ============================================================
async function findExistingComplaintForConversation(missive_conversation_id) {
  const { data, error } = await supabase
    .from('complaints')
    .select('id')
    .eq('source_missive_conversation_id', missive_conversation_id)
    .order('created_at', { ascending: true }) // the original, if this ever finds more than one (e.g. a real duplicate created before this fix shipped) — never the newest.
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// ============================================================
// complaints row creation — spec Section 4/7. subject_type/subject_id
// ONLY from address_match (never the content-extracted property/vendor
// guess) — the same rule enforced structurally in writeMessageLinks()
// above, restated here since this is the OTHER place that rule matters.
// duplicate detection and complaint_tracking_config_id are live_pipeline
// only (complaints_config_required_unless_held's historical exemption);
// DO assignment is live_pipeline only (spec Section 6's hard gate).
// ============================================================
async function createComplaintRow({ mailbox_key, missive_conversation_id, discoveryContext, category, call2Fields, keywordCheck, property_id, vendor_id, addressMatch, blockedSinceIso }) {
  const insertRow = {
    property_id,
    vendor_id,
    subject_type: addressMatch.subject_type || null,
    subject_id: addressMatch.subject_id || null,
    needs_matching: !property_id && !addressMatch.subject_type && !vendor_id,
    category,
    needs_human_call: call2Fields.needs_human_call,
    held_legal_fair_housing: false,
    blocked_reason: call2Fields.blocked_reason,
    blocked_party: call2Fields.blocked_party,
    blocked_since: call2Fields.escalation_signal === 'blocked_resolution' ? blockedSinceIso : null,
    // Bug fix — see complaintEscalationSignal()'s own comment above:
    // 'none' is legal on missive_conversation_significance but not on
    // complaints; never pass it through untranslated here.
    escalation_signal: complaintEscalationSignal(call2Fields.escalation_signal),
    owner_instruction_rejected: call2Fields.owner_instruction_rejected,
    owner_instruction_note_text: call2Fields.owner_instruction_note_text,
    flagged_protected_class: keywordCheck.flagged_protected_class,
    flagged_category: keywordCheck.flagged_category,
    status: 'open',
    source: 'email_ai',
    extracted_by: CONTENT_PASS_VERSION,
    source_missive_conversation_id: missive_conversation_id,
    discovery_context: discoveryContext,
    complaint_tracking_config_id: null,
    owner_team_member_id: null,
  };

  if (discoveryContext === 'live_pipeline') {
    const config = await getActiveComplaintTrackingConfig();
    if (config) {
      insertRow.complaint_tracking_config_id = config.id;
      if (addressMatch.subject_type && addressMatch.subject_id) {
        const duplicate = await findPossibleDuplicate(supabase, {
          property_id, subject_type: addressMatch.subject_type, subject_id: addressMatch.subject_id,
          windowDays: config.duplicate_window_days,
        });
        if (duplicate) {
          insertRow.possible_duplicate_of_id = duplicate.id;
          insertRow.duplicate_status = 'suggested';
        }
      }
    }
    // Section 6's hard gate — DO assignment is live_pipeline only. A
    // historical row NEVER gets owner_team_member_id set, by construction.
    const doLookup = await lookupSingleDirectorOfOperations();
    if (doLookup.ok) insertRow.owner_team_member_id = doLookup.teamMemberId;
    else insertRow.needs_human_call = true;
  }

  const { data: inserted, error } = await supabase.from('complaints').insert(insertRow).select().single();
  if (error) throw error;

  await writeAuditLog({
    action: 'complaint_tracking.created', entity_type: 'complaint', entity_id: inserted.id,
    actor_type: 'ai_agent', actor_id: CONTENT_PASS_VERSION, property_id: inserted.property_id,
    risk_level: 'medium', privacy_category: 'collection',
    details: { category: inserted.category, escalation_signal: inserted.escalation_signal, discovery_context: discoveryContext, source_missive_conversation_id: missive_conversation_id },
  });

  return inserted.id;
}

// ============================================================
// Batch runner — used by BOTH the pilot script (discoveryContext:
// 'historical_backfill') and the ongoing internalRouter route
// (discoveryContext: 'live_pipeline').
//
// Real pilot bug #2 fix, 2026-09-13: this now does TWO passes, not one.
// The existing-but-incomplete backlog (fetchIncompleteSignificanceRows) is
// worked FIRST, up to `limit` — a conversation stuck there has already
// cost one real, billed AI call (Call 1); leaving it sitting behind an
// unbounded queue of never-touched conversations on every future run
// would be worse than prioritizing it. Whatever budget is left after that
// goes to brand-new conversations (fetchNextEligibleConversations),
// exactly as before this fix. Each retried row keeps its OWN stored
// discovery_context (a historical row retried during a live-pipeline run,
// or vice versa, must never switch which context it's stamped with) —
// independent of this call's own discoveryContext argument, which only
// ever governs the brand-new conversations fetched in the second pass.
// ============================================================
async function runSignificancePassBatch({ limit, discoveryContext, sinceDate = null }) {
  const summary = {
    conversations_processed: 0, call2_completed: 0, call2_failed_placeholder: 0,
    call2_retried: 0, complaints_created: 0, call1_failed: 0, errors: 0,
  };

  // fetchIncompleteSignificanceRows is deliberately NOT sinceDate-filtered:
  // every row it returns already HAS a significance row (Call 1 already
  // ran and was stored) — it was already in scope for an earlier run, so
  // there is no "is this conversation in the staged date window" question
  // left to ask here. sinceDate only governs which BRAND-NEW conversations
  // (fetchNextEligibleConversations, below) get pulled into scope at all.
  const incompleteRows = await fetchIncompleteSignificanceRows(limit);
  const remaining = limit - incompleteRows.length;
  const pairs = remaining > 0 ? await fetchNextEligibleConversations(remaining, sinceDate) : [];
  if (incompleteRows.length === 0 && pairs.length === 0) return summary;

  const sharedDirectories = { properties: await fetchPropertyDirectory(), vendors: await fetchVendorDirectory() };

  for (const row of incompleteRows) {
    try {
      const result = await retryCall2ForExistingRow(row);
      if (result.outcome === 'skipped_empty') continue; // defensive only — the conversation's own messages disappeared since Call 1 ran.
      summary.conversations_processed++;
      summary.call2_retried++;
      if (result.outcome === 'call2_completed') summary.call2_completed++;
      if (result.outcome === 'call2_failed_placeholder') summary.call2_failed_placeholder++;
      if (result.complaint_id) summary.complaints_created++;
    } catch (err) {
      console.error(`[significance-pass] Failed to retry Call 2 for conversation ${row.mailbox_key}/${row.missive_conversation_id}:`, err.message);
      summary.errors++;
    }
  }

  for (const pair of pairs) {
    try {
      const result = await processConversation(pair, discoveryContext, sharedDirectories);
      if (result.outcome === 'call1_failed') { summary.call1_failed++; continue; }
      if (result.outcome === 'skipped_empty') continue; // defensive only — shouldn't happen, matches screening-pass.js's own precedent for the identical case.
      summary.conversations_processed++;
      if (result.outcome === 'call2_completed') summary.call2_completed++;
      if (result.outcome === 'call2_failed_placeholder') summary.call2_failed_placeholder++;
      if (result.complaint_id) summary.complaints_created++;
    } catch (err) {
      console.error(`[significance-pass] Failed to process conversation ${pair.mailbox_key}/${pair.missive_conversation_id}:`, err.message);
      summary.errors++;
    }
  }

  await writeAuditLog({
    action: 'archive_search.significance_pass_run',
    entity_type: 'archive_search_significance_run',
    entity_id: crypto.randomUUID(),
    actor_type: 'system',
    risk_level: 'low',
    privacy_category: 'collection',
    details: { discovery_context: discoveryContext, since_date: sinceDate, ...summary },
  });

  return summary;
}

module.exports = {
  CONTENT_PASS_VERSION,
  TOPIC_CATEGORIES,
  ESCALATION_SIGNALS,
  runSignificancePassBatch,
  fetchDriverPage,
  passesSinceDate,
  passesEscalationExclusion,
  fetchEscalationExclusionSet,
  fetchNextEligibleConversations,
  countDistinctEligibleConversations,
  estimateExpectedEligiblePool,
  // Resumable driver cursor (migration 20260920010000) — exported for direct
  // unit tests (cursorIsSafeToResume) and for the real, end-to-end
  // fake-Supabase scenario tests proving the fallback actually fires (see
  // this section's own header comment, above fetchNextEligibleConversations).
  cursorIsSafeToResume,
  driverCursorScopeKey,
  resolveDriverStartCursor,
  persistDriverCursor,
  fetchIncompleteSignificanceRows,
  retryCall2ForExistingRow,
  dedupeNewPairs,
  shouldCreateComplaint,
  complaintEscalationSignal,
  needsCall2,
  rowNeedsCall2Retry,
  resolveOwnerInstructionNoteText,
  buildCall1Prompt,
  buildCall2Prompt,
  parseCall1Response,
  parseCall2Response,
  // Added 2026-09-17 for the Batches API build (lib/significance-batch.js) —
  // pure additions, nothing above this line changed behavior. Exported so
  // that build can reuse this file's own conversation-context/write/
  // complaint logic instead of reimplementing any of it against a downloaded
  // batch result (its own module-level header explains exactly which of
  // these it calls and why).
  buildConversationContext,
  applyCall1Result,
  fetchPropertyDirectory,
  fetchVendorDirectory,
  findExistingComplaintForConversation,
  createComplaintRow,
  _setSupabaseClientForTesting,
};
