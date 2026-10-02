/**
 * lib/severity-rubric.js
 *
 * The validated severity-tier rubric — Jarvis-relayed build task, 2026-10-02.
 * Schema: supabase/migrations/20261002010000_add_severity_tier_to_complaints.sql
 * and .../20261002020000_add_no_issue_protected_signal_guard_to_complaints.sql
 * (Neo). Read both migration headers before changing anything here — they
 * carry the full governance context (Asimov's "this is a score" flag, the
 * Mason hold on the accommodation/protected-class interaction, the DB-level
 * CHECK backstop this module's own applySeverityFloor() exists to make
 * unnecessary in practice).
 *
 * WHY ITS OWN FILE, SHARED BY BOTH CONSUMERS: the build task is explicit that
 * both the retroactive batch tool (lib/severity-batch.js) and the live
 * pipeline hook (lib/significance-pass.js's createComplaintRow()) must use
 * the EXACT SAME rubric prompt, parser, and floor logic — "reuse the same
 * core classification function... rather than duplicating the prompt a
 * second time." Everything here is pure or Anthropic-call-only; neither
 * function touches Supabase. The two consumers differ only in HOW they call
 * Anthropic (one request per row via the synchronous Messages API here for
 * the live pipeline, vs. the async Message Batches API in severity-batch.js
 * — which builds its own batch request objects directly from
 * buildSeverityPrompt()/parseSeverityResponse(), never re-deriving the
 * prompt text).
 *
 * THE RUBRIC TEXT BELOW IS REPRODUCED WORD FOR WORD from the calibrated
 * prompt handed down with this build task — three real rounds against
 * Peter's own judgment on real complaints, 70% exact agreement on round 3,
 * every miss a single-tier, defensible call. Do not paraphrase or "clean
 * up" this text; a wording change is a recalibration, not a refactor, and
 * would invalidate the calibration this version string represents.
 */

// Bumped on any material rubric change, same convention significance-pass.js's
// own CONTENT_PASS_VERSION and screening-pass.js's SCREENING_VERSION already
// use. Stored verbatim into complaints.severity_rubric_version — see that
// column's own migration comment.
const SEVERITY_RUBRIC_VERSION = 'v3';

const SEVERITY_TIERS = ['urgent', 'worth_a_look', 'just_a_record', 'no_issue'];

// ============================================================
// buildSeverityPrompt — the exact calibrated prompt, {DESCRIPTION}
// substituted with the complaint's own `description` text. No markdown
// fence is requested in the prompt's own instructions; parseSeverityResponse
// below still defensively tolerates one anyway (find-first-{-last-}), same
// defensive posture significance-pass.js's parseCall1Response already takes
// for its own "no markdown fence" instruction.
// ============================================================
function buildSeverityPrompt(description) {
  return `You work for Rincon Management, a Southern California property management company. You're reviewing one record from their "Complaint Tracking" tool to decide whether it actually belongs there.

THE ONLY TEST THAT MATTERS: is there an ACTIVE DISPUTE — someone obstructing, refusing, or an explicit threat (legal, to leave, to escalate to an agency)? How bad the underlying situation sounds, how much money is involved, or whether a lease/legal term is permanently changing are NOT the test by themselves and must not push you to a higher tier alone.

Rincon's Maintenance Department already handles every maintenance/habitability issue through its own system — a leak, mold, no heat, a structural problem, a sewage backup, a fire-exit hazard — ALL of it, however severe or scary it sounds, stays OUT of this tool UNLESS someone is actively fighting about it. A repair simply awaiting a vendor, an estimate, or approval is normal process, not a dispute — EXCEPT: a genuinely new, completely unaddressed hazard (nobody has started fixing it yet, no work order exists) with a real near-term timing risk (e.g. new tenants about to move in) or an explicit regulatory mention (e.g. "might report to the city") is worth a look even with no dispute yet, because it's sitting unaddressed with a deadline, not progressing through a normal process.

ROUTINE OWNER/STAFF BUSINESS WITH NO DISPUTE IS ALWAYS "NO ISSUE," EVEN WHEN IT INVOLVES MONEY OR A PERMANENT CHANGE. An owner instructing a change (removing a line item, raising rent with proper notice, renewing a lease, directing a distribution), a compliance data-gathering exercise, an administrative account transfer, or a routine accounting correction — none of these need a record here just because they involve money, a lease term, or a legal notice requirement. They ALL default to "no_issue" unless someone is actually disputing or refusing something. Do not promote something to "just_a_record" just because it is "worth documenting" or "a permanent change" — that reasoning is wrong. Only use "just_a_record" for a real disagreement or open question that's genuinely being contested but hasn't escalated to obstruction or a threat (e.g. two parties still disagreeing over who owes what, with no resolution yet) — not for uncontested routine business.

A money-related DISAGREEMENT (disputed charges, disputed responsibility, questioning an amount) that is still being actively discussed or negotiated is "just_a_record" or "worth_a_look," NOT "urgent" — reserve "urgent" for when someone has actually refused to pay/resolve, made an explicit threat, or there's a real stalemate, not merely "the two sides see it differently."

A dispute tied to a disability/accommodation request (Fair Housing-adjacent) should be treated as at least "worth_a_look" even without obstruction or a threat, because of the regulatory stakes — but a passing mention of a medical reason in otherwise routine scheduling (e.g. "I can't be home before 2pm for a medical reason") is NOT itself a Fair Housing matter and stays "no_issue." The bar is: is someone actually requesting/being denied an accommodation and it's contested, vs. just mentioning a personal constraint while scheduling something routine.

Classify into exactly one of these four buckets:
- "urgent": active obstruction, an explicit threat (legal, to leave, to report to an agency), a real stalemate, or an unresolved, actively disputed accommodation/Fair-Housing request.
- "worth_a_look": real friction or an open disagreement not yet escalated, a disputed accommodation request with no obstruction yet, or a genuinely new unaddressed hazard with near-term timing risk.
- "just_a_record": a real disagreement or open question being actively discussed/negotiated, not yet escalated — NOT routine uncontested business regardless of money or permanence.
- "no_issue": the default. Routine business carried out with no dispute (however much money or legal process is involved), a plain question answered, ordinary back-and-forth, or a maintenance/habitability issue progressing through its normal process with no dispute.

Record to classify:
"""
${description}
"""

Respond with EXACTLY one JSON object, no markdown fence:
{"tier": "urgent"|"worth_a_look"|"just_a_record"|"no_issue", "why": "one short plain-English sentence"}`;
}

// ============================================================
// parseSeverityResponse — same shape/discipline as significance-pass.js's
// parseCall1Response: find the first "{" and last "}" (tolerates a stray
// markdown fence even though the prompt asks for none), JSON.parse, then
// validate every field. Returns null on ANY failure — the caller's own
// retry-until-success (classifySeverity, below, for the live pipeline) or
// one-shot-no-retry (severity-batch.js's write-back, for the batch tool)
// contract decides what "null" means for that call site; this function
// itself never retries or defaults.
// ============================================================
function parseSeverityResponse(rawText) {
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
  if (!SEVERITY_TIERS.includes(parsed.tier)) return null;
  if (typeof parsed.why !== 'string' || !parsed.why.trim()) return null;

  return { tier: parsed.tier, why: parsed.why.trim() };
}

// ============================================================
// applySeverityFloor — THE DATABASE-ENFORCED SAFETY FLOOR, applied in our
// own application logic BEFORE any write is even attempted (per the build
// task: "don't rely on the DB rejecting a mistake — get the logic right").
// The database's own complaints_no_issue_excludes_protected_signals CHECK
// (20261002020000) is the real backstop if this function is ever bypassed
// or has a bug — this function's job is to make that backstop never
// actually need to fire.
//
// Only ever touches a 'no_issue' call — any other tier passes through
// completely unchanged, floor note untouched, exactly matching the
// constraint's own "severity_tier IS DISTINCT FROM 'no_issue' OR (safe
// conditions)" shape (every non-'no_issue' value trivially satisfies it).
//
// Widened 2026-10-02 (Mason's scoped governance review, gap #2 of 3) with
// two more trigger conditions, on top of the original three:
//   - category === 'legal_exposure' — a row the model itself routed down
//     the legal-exposure path should never read as "no issue" on the
//     severity rubric, for the same reason accommodation_related doesn't.
//   - owner_instruction_rejected === 'true' || owner_instruction_rejected
//     === 'uncertain' — an owner instruction that was actually rejected, or
//     where it's unclear whether it was, is never "no issue" either; only
//     owner_instruction_rejected === 'false' (the instruction was followed/
//     not rejected) or null (not an owner-instruction row at all) are safe
//     to leave unfloored. Note this field is stored on complaints as a
//     STRING ('true'/'false'/'uncertain') or null, per createComplaintRow's
//     own `String(v.owner_instruction_rejected)` cast — never a real
//     boolean — so the comparison here is deliberately to the string
//     literals, not to `true`.
// This is the application-layer half of Neo's matching DB migration
// widening complaints_no_issue_excludes_protected_signals the same way —
// this function's job is to floor BEFORE that constraint would ever need
// to fire, same "don't rely on the DB rejecting a mistake" principle the
// original three conditions already followed.
//
// All five trigger conditions are checked independently and their notes
// joined, so a row tripping more than one (e.g. flagged_protected_class AND
// needs_human_call) gets one combined, honest explanation rather than only
// naming the first condition checked.
// ============================================================
function applySeverityFloor({ tier, why, needs_human_call, category, flagged_protected_class, owner_instruction_rejected }) {
  if (tier !== 'no_issue') return { tier, why, floored: false };

  const reasons = [];
  if (needs_human_call) reasons.push("flagged by the AI's own uncertainty signal (needs_human_call)");
  if (category === 'accommodation_related') reasons.push("category is accommodation_related");
  if (flagged_protected_class) reasons.push("flagged_protected_class is set");
  if (category === 'legal_exposure') reasons.push("category is legal_exposure");
  if (owner_instruction_rejected === 'true' || owner_instruction_rejected === 'uncertain') {
    reasons.push(`owner_instruction_rejected is '${owner_instruction_rejected}'`);
  }

  if (reasons.length === 0) return { tier, why, floored: false };

  return {
    tier: 'worth_a_look',
    why: `${why} (Floored from no_issue: ${reasons.join('; ')}.)`,
    floored: true,
  };
}

// ============================================================
// anthropicClient — same lazy-require + test-override-seam pattern
// significance-pass.js/significance-batch.js each already carry their own
// copy of (never shared as one module — see those files' own comments on
// why each needs its own settable reference rather than a shared one).
// ============================================================
let anthropicClientOverrideForTesting = null;
function anthropicClient() {
  if (anthropicClientOverrideForTesting) return anthropicClientOverrideForTesting;
  const Anthropic = require('@anthropic-ai/sdk'); // lazy — never fail at module-load time for a code path that never calls the model.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  return new Anthropic({ apiKey });
}
function _setAnthropicClientForTesting(client) { anthropicClientOverrideForTesting = client; }

// Same retry-until-success shape as significance-pass.js's CALL1_MAX_ATTEMPTS/
// CALL1_TIMEOUT_MS — classifySeverity() is only ever used for ONE row at a
// time, synchronously, by the live pipeline (createComplaintRow(), feature-
// flagged — see that file's own comment), so a bounded in-process retry
// loop is the right shape here, unlike the batch tool's one-shot-no-retry
// contract (severity-batch.js's own applyOneSeverityResult()).
const SEVERITY_LIVE_MAX_ATTEMPTS = 3;
const SEVERITY_LIVE_TIMEOUT_MS = 30000;

// Bumped 512 -> 1024 2026-10-02 (real bug: complaint d471ed02-06d3-4257-
// 91eb-9643725bbe72 truncated at 512 on every attempt — an unremarkable
// description, but the model's own rationale ran long enough to get cut off
// before the JSON closed, so it never parsed; 512 simply had no headroom).
// Matches runCall1()'s own max_tokens in significance-pass.js — the most
// generous existing precedent for a single classification-style call in
// this codebase — rather than guessing a new number from scratch.
const SEVERITY_MAX_TOKENS = 1024;

/**
 * classifySeverity — retry-until-success for ONE complaint's raw severity
 * call (BEFORE the floor is applied — callers apply applySeverityFloor()
 * themselves, using whatever needs_human_call/category/flagged_protected_class
 * values are current for them at the moment they call it; this function has
 * no opinion on freshness, it only runs the AI call and parses the result).
 * @returns {Promise<{tier: string, why: string}|null>} null only after
 *   SEVERITY_LIVE_MAX_ATTEMPTS genuinely bad/unparseable responses in a row.
 */
async function classifySeverity(description) {
  const prompt = buildSeverityPrompt(description);

  for (let attempt = 1; attempt <= SEVERITY_LIVE_MAX_ATTEMPTS; attempt++) {
    try {
      const anthropic = anthropicClient();
      const response = await anthropic.messages.create(
        {
          model: 'claude-sonnet-5',
          max_tokens: SEVERITY_MAX_TOKENS,
          output_config: { effort: 'medium' },
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        },
        { timeout: SEVERITY_LIVE_TIMEOUT_MS }
      );

      if (response.stop_reason === 'max_tokens') {
        console.error(`[severity-rubric] classifySeverity truncated (attempt ${attempt}/${SEVERITY_LIVE_MAX_ATTEMPTS}) — retrying.`);
        continue;
      }
      const textBlock = response.content.find((b) => b.type === 'text');
      const parsed = textBlock ? parseSeverityResponse(textBlock.text) : null;
      if (parsed) return parsed;
      console.error(`[severity-rubric] classifySeverity unparseable (attempt ${attempt}/${SEVERITY_LIVE_MAX_ATTEMPTS}) — retrying.`);
    } catch (err) {
      console.error(`[severity-rubric] classifySeverity call failed (attempt ${attempt}/${SEVERITY_LIVE_MAX_ATTEMPTS}): ${err.message}`);
    }
  }
  return null; // total failure — caller leaves severity_tier NULL ("not yet assessed"), never a default guess.
}

module.exports = {
  SEVERITY_RUBRIC_VERSION,
  SEVERITY_TIERS,
  SEVERITY_MAX_TOKENS,
  buildSeverityPrompt,
  parseSeverityResponse,
  applySeverityFloor,
  classifySeverity,
  _setAnthropicClientForTesting,
};
