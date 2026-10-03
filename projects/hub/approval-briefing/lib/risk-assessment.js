/**
 * lib/risk-assessment.js
 *
 * approval-briefing-SPEC.md Section 5 — the one component of this feature
 * that becomes a `claims` row (Section 2.1's single deliberate exception).
 * Generation only — reuses extract-claims.js's proven discipline (both
 * maintenance-history's and leadsimple-property-brain's copies): a bounded
 * free-text input, a self-reported protected_class_flag/category (Layer 2
 * of the two-layer content check), the same model/effort/max_tokens
 * conventions, and the same fail-closed truncation/parse-failure handling
 * — applied here to ONE qualitative risk read instead of an array of
 * claims. This file does NOT run the content check or touch Supabase —
 * that's lib/gather.js's job (computeRiskAssessment()), same separation of
 * concerns extract-claims.js / router.js already use elsewhere in this
 * codebase.
 *
 * Input is deliberately bounded (spec Section 5): the job's free-text
 * fields only (description, vendor_description, estimate_note) plus the
 * structured context Phase 3's gather.js already produced (property job
 * history count, tenant tenure, property spend, maintenance limit vs.
 * estimate) — never a raw dump of everything else Latchel returns.
 *
 * Property/situation framing, not tenant framing — Mason's Fair Housing
 * review, finding 2 (compliance/approval-briefing-fair-housing-review.md):
 * the protected-class self-check below catches protected-class-CODED
 * language, but not general tenant-characterization drift ("tenant
 * wouldn't let vendor in," "tenant is difficult to schedule with") that
 * trips no protected-class flag because it isn't protected-class language.
 * The prompt instructs the model explicitly to frame findings in terms of
 * the property or situation, never the tenant — spec Section 5's own
 * acceptable/not-acceptable examples are reused verbatim below.
 *
 * There is no separate risk_level column on approval_briefings (Phase 1's
 * schema — supabase/migrations/20260827000000 — has only
 * risk_assessment_text/_confidence/_status/_held_category). Per spec
 * Section 5's hard rule ("never a bare numeric score standing alone"), the
 * qualitative level is embedded as the leading clause of the stored text
 * itself (e.g. "Moderate risk: ...") rather than invented as a new column
 * — Q's build-time labeling choice the spec explicitly leaves open
 * ("exact labels are a build-time decision, not specified here").
 */

const Anthropic = require('@anthropic-ai/sdk');

const EXTRACTOR_ACTOR_ID = 'approval-briefing-risk-assessment';
const RISK_LEVELS = ['low', 'moderate', 'elevated'];

function client() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  return new Anthropic({ apiKey });
}

const PROMPT_HEADER = `You are reading ONE Latchel maintenance ticket sitting in "Needs Approval" for a Southern California property management company (Rincon Management), to give the property manager a cited, plain-English read of the risk represented by leaving this unresolved — never a bare numeric score standing alone.

HARD RULES:
1. CITE WHAT YOU'RE BASING THIS ON. Your explanation must be traceable to the facts given below — the ticket's own free-text fields and the structured facts already gathered. Never invent a detail that isn't in the material.
2. FRAME THE RISK IN TERMS OF THE PROPERTY OR SITUATION, NEVER THE TENANT. This is a hard rule, not a style preference. Even if the ticket's own text characterizes the tenant, extract the underlying property-risk fact it supports (if any) and leave the characterization out.
   Acceptable: "risk the property incurs further water damage if not addressed within a few days."
   NOT acceptable, even if the source text uses this framing: "tenant is negligent," "tenant failed to report promptly," "tenant caused the damage," "tenant has been uncooperative," "tenant wouldn't let the vendor in," "tenant is difficult to schedule with."
3. SAY "UNKNOWN" RATHER THAN GUESS. If the material doesn't clearly support a read, say so in your explanation rather than inventing certainty.
4. Self-check (independent of an automated keyword scan that also runs on your output): does your explanation, or the ticket text itself, touch on a legally protected personal topic — race, color, religion, sex, sexual orientation, gender identity, national origin, familial status, disability/health/medical, source of income (incl. Section 8/vouchers), marital status, age, ancestry, genetic information, citizenship/immigration status, or primary language? If yes, set "protected_class_flag": true and "protected_class_category" to a short label. Flag based on your own reading of the meaning, not just obvious keywords.

Return ONLY JSON, no markdown fences, no explanation:
{
  "risk_level": "low" | "moderate" | "elevated",
  "claim_text": "your cited, plain-English explanation only — do not restate the risk_level word inside this string, it is prefixed automatically",
  "confidence": 0.0-1.0,
  "protected_class_flag": true | false,
  "protected_class_category": "short label or null"
}`;

function money(v) {
  return v != null ? `$${v}` : '(none)';
}

function buildInputText({ job, context }) {
  const lines = [
    `Latchel job_id: ${job.job_id}`,
    `Description: ${job.description || '(none)'}`,
    `Vendor-facing description: ${job.vendor_description || '(none)'}`,
    `Estimate note: ${job.estimate_note || '(none)'}`,
    `Estimate: ${money(context.estimate)}`,
    `Latchel's own spending cap for this ticket (its own internal figure, not necessarily AppFolio's confirmed limit): ${money(context.max_cost)}`,
    `AppFolio's confirmed maintenance-approval limit for this property: ${context.appfolio_maintenance_limit != null ? money(context.appfolio_maintenance_limit) : '(not available)'}`,
    `Severity: ${context.severity || '(none)'}  Urgent (Latchel's own flag): ${!!context.is_urgent}  Emergency (Latchel's own flag): ${!!context.is_emergency}`,
    `This property's maintenance jobs in the last ${context.window_months || 6} months, not counting this one: ${context.property_job_count != null ? context.property_job_count : '(unknown)'}`,
    `This tenant's maintenance jobs at this property in the same window: ${context.tenant_job_count != null ? context.tenant_job_count : '(unknown)'}`,
    `This tenant's lease start date: ${context.lease_start || '(unknown)'}`,
    `This property's maintenance spend, last month: ${context.spend_last_month != null ? money(context.spend_last_month) : '(unknown)'}`,
    `This property's maintenance spend, trailing 12 months: ${context.spend_trailing_12mo != null ? money(context.spend_trailing_12mo) : '(unknown)'}`,
  ];
  return lines.join('\n');
}

/**
 * @param {object} params
 * @param {object} params.job - full job detail from getJob() (needs job_id,
 *   description, vendor_description, estimate_note)
 * @param {object} params.context - the deterministic facts Phase 3 already
 *   gathered (estimate, max_cost, severity, is_urgent, is_emergency,
 *   appfolio_maintenance_limit, window_months, property_job_count,
 *   tenant_job_count, lease_start, spend_last_month, spend_trailing_12mo)
 * @returns {Promise<
 *   { held: true, held_category: string, modelVersion: string|null } |
 *   { held: false, risk_level: string, claim_text: string, confidence: number,
 *     modelFlag: boolean, modelCategory: string|null, modelVersion: string }
 * >}
 *   held_category on a `held: true` result is a TECHNICAL-FAILURE code
 *   (model_call_failed / model_response_truncated / model_response_unparseable),
 *   not a content-check category — mirrors access-instructions-check.js's
 *   own fail-CLOSED philosophy (a technical failure must not silently skip
 *   the hold-and-render pattern the PM-facing templates already rely on).
 *   The content-check's own hold (a real protected-class flag) is computed
 *   by the caller (lib/gather.js's computeRiskAssessment()), not here.
 */
async function generateRiskAssessment({ job, context }) {
  const promptText = `${PROMPT_HEADER}\n\n=== TICKET AND CONTEXT ===\n${buildInputText({ job, context })}`;

  let response;
  try {
    const anthropic = client();
    response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 2048, // one short cited judgment, not a document — generous, not tight
      output_config: { effort: 'medium' }, // a real judgment call over free text, same reasoning extract-claims.js documents for its own 'medium' choice
      messages: [{ role: 'user', content: [{ type: 'text', text: promptText }] }],
    });
  } catch (err) {
    console.error(`[risk-assessment] Model call failed for job ${job.job_id} — failing closed (held): ${err.message}`);
    return { held: true, held_category: 'model_call_failed', modelVersion: null };
  }

  if (response.stop_reason === 'max_tokens') {
    console.error(`[risk-assessment] TRUNCATED response for job ${job.job_id} (stop_reason=max_tokens) — failing closed (held).`);
    return { held: true, held_category: 'model_response_truncated', modelVersion: response.model };
  }

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) {
    console.error(`[risk-assessment] No text block in model response for job ${job.job_id} — failing closed (held).`);
    return { held: true, held_category: 'model_response_unparseable', modelVersion: response.model };
  }

  const raw = textBlock.text.trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    // SECURITY: never log the raw model response — same discipline as
    // extract-claims.js's identical guard. This is exactly the unfiltered
    // content the check exists to screen before anything is logged.
    console.error(`[risk-assessment] JSON parse failed for job ${job.job_id}: ${err.message}. Failing closed (held).`);
    return { held: true, held_category: 'model_response_unparseable', modelVersion: response.model };
  }

  const riskLevel = RISK_LEVELS.includes(parsed.risk_level) ? parsed.risk_level : null;
  const claimText = typeof parsed.claim_text === 'string' ? parsed.claim_text.trim() : '';
  if (!riskLevel || !claimText) {
    console.error(`[risk-assessment] Model response missing a valid risk_level or claim_text for job ${job.job_id} — failing closed (held).`);
    return { held: true, held_category: 'model_response_unparseable', modelVersion: response.model };
  }

  return {
    held: false,
    risk_level: riskLevel,
    claim_text: claimText,
    confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
    modelFlag: !!parsed.protected_class_flag,
    modelCategory: parsed.protected_class_category || null,
    modelVersion: response.model,
  };
}

module.exports = { generateRiskAssessment, EXTRACTOR_ACTOR_ID, RISK_LEVELS };
