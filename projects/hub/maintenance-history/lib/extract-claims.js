/**
 * lib/extract-claims.js
 * Turns one Latchel job's structured fields + state history + attached PDF
 * text into candidate maintenance_claims rows. Two sources of claims:
 *
 *   1. Deterministic 'event' claims straight from the state-history
 *      timeline (buildDeterministicEventClaims) — no AI involved, nothing
 *      to be uncertain about, so these get extracted_by='system' and
 *      confidence=NULL per the schema's own comment on that column.
 *   2. AI-derived claims (extractAIClaims) — decisions, outcomes,
 *      recurrence links, and any event detail the bare status timeline
 *      wouldn't show, pulled from the job's free-text fields and attached
 *      PDF files by Claude. These get extracted_by=<model version> and a
 *      confidence score.
 *
 * The extraction prompt preserves the original 10-ticket "Property Brain"
 * experiment's two hard rules verbatim (SPEC.md "Ingestion Approach" step
 * 5) — cite a source for every claim, say "unknown" rather than guess —
 * because those two rules are the reason that manual test hit 0% missed
 * and 0% wrong-source. Quality bar and output shape were read directly
 * from projects/property-brain-experiment/README.md and its
 * extractions/*.md files before this prompt was written, per the build
 * task's instruction.
 *
 * PDF handling reuses the exact pattern from
 * projects/hub/insurance/extract-policy.js: the PDF's raw bytes go to
 * Claude as a base64 'document' content block (Claude reads it directly —
 * no separate OCR step needed), not a locally pdf-parsed text dump. The
 * downloaded bytes are only ever held in memory for this one call and are
 * never written to disk or to any database column (SPEC.md — no file-
 * bytes column exists anywhere in this schema, same restraint as B2
 * photos).
 */

const Anthropic = require('@anthropic-ai/sdk');

const EXTRACTOR_ACTOR_ID = 'maintenance-history-extractor';
const MAX_FILES_PER_JOB = 6; // keeps one job's extraction call bounded and cheap

function client() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  return new Anthropic({ apiKey });
}

function dateOnly(tsOrDate) {
  if (!tsOrDate) return null;
  const d = new Date(tsOrDate);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Event claims built directly from the state-change timeline — no AI, no
 * uncertainty. One claim per transition. source_reference mirrors the
 * 10-ticket test's own citation style ("Latchel job 6903, state history
 * entry 2026-07-30").
 */
function buildDeterministicEventClaims(job, stateHistory) {
  const jobId = job.job_id;
  return (stateHistory || [])
    .filter(entry => entry && entry.state && entry.state.name)
    .map(entry => ({
      claim_type: 'event',
      claim_text: `Ticket status changed to "${entry.state.name}".`,
      claim_date: dateOnly(entry.updated_at),
      outcome_level: null,
      related_ticket_ref: null,
      source_type: 'latchel_state_history',
      source_reference: `Latchel job ${jobId}, state history entry ${entry.updated_at}`,
      confidence: null,
      extracted_by: 'system',
      modelFlag: false,
      modelCategory: null,
    }));
}

const EXTRACTION_PROMPT_HEADER = `You are extracting maintenance-ticket history for a Southern California property management company (Rincon Management), from real Latchel maintenance-ticket data. This is the automated version of a manual test that scored 80% fully correct, 0% missed, and 0% wrong-source — your job is to hit that same bar.

TWO HARD RULES (these are why the manual test scored 0% missed / 0% wrong-source — do not violate them):
1. CITE A SOURCE FOR EVERY CLAIM. Every claim's "source_reference" must say exactly which record it came from (e.g. "Latchel job 719363, job description field", "Latchel job 719363, file invoice_1562771-719363-1.pdf"). Never produce a claim without one.
2. SAY "UNKNOWN" RATHER THAN GUESS. If something isn't clearly stated in the material, do not infer it. Leave claim_date null, skip the claim, or say so in claim_text — never invent a date, a name, or an outcome that isn't actually there.

Extract claims into exactly these four types, matching what the original manual test proved valuable:
- "event" — something that happened, with a date if one is stated. Do NOT restate simple status changes (the status timeline is already recorded separately, given to you below for context only) — only add an event claim for something the timeline itself wouldn't show (a specific detail, a callback, a same-day event mentioned in the text).
- "decision" — who decided what, and the stated reason if one is given. Include any dollar/scope limit attached. If no reason is stated, say so plainly in claim_text rather than inventing one (e.g. "Reason not stated in the material.").
- "outcome" — set outcome_level 1-5 using this ladder (use the LOWEST level you have solid evidence for; higher levels require their own evidence, do not assume they follow from a lower one):
  1 = vendor/contractor says the work is done
  2 = something objective confirms it (a photo, a reading, a passed inspection)
  3 = the resident actively confirmed it
  4 = no recurrence in a stated time window
  5 = verified by a later, independent inspection
- "recurrence" — a link to an earlier related ticket, ONLY if one is clearly identifiable (e.g. a ticket number or an unambiguous description of the same problem recurring). If the material mentions something that sounds like it might be related but isn't clearly identifiable, do not force a recurrence claim — say so in an event claim instead, or skip it.

For EACH claim, also self-check (defense in depth, independent of any keyword list): does this claim's text touch on a legally protected personal topic — race, color, religion, sex, sexual orientation, gender identity, national origin, familial status, disability/health/medical, source of income (incl. Section 8/vouchers), marital status, age, ancestry, genetic information, citizenship/immigration status, or primary language? If yes, set "protected_class_flag": true and "protected_class_category" to a short label (e.g. "disability_health", "source_of_income"). This is independent of, and in addition to, an automated keyword scan that also runs on your output — flag based on your own reading of the meaning, not just obvious keywords.

Return ONLY a JSON array, no markdown fences, no explanation. Each element:
{
  "claim_type": "event" | "decision" | "outcome" | "recurrence",
  "claim_text": "the fact, in plain English",
  "claim_date": "YYYY-MM-DD" or null,
  "outcome_level": 1-5 (only for claim_type "outcome", else null),
  "source_type": "latchel_job_field" | "latchel_state_history" | "latchel_job_file",
  "source_reference": "exactly which record this came from",
  "confidence": 0.0-1.0 (your confidence this claim is accurately stated),
  "protected_class_flag": true | false,
  "protected_class_category": "short label or null"
}

If there is nothing worth extracting, return an empty array [].`;

function buildJobFieldsText(job, stateHistory) {
  const lines = [
    `Latchel job_id: ${job.job_id}`,
    `Title: ${job.name || '(none)'}`,
    `Description: ${job.description || '(none)'}`,
    `Vendor-facing description: ${job.vendor_description || '(none)'}`,
    `Estimate note: ${job.estimate_note || '(none)'}`,
    `Current state: ${job.state && job.state.name}`,
    `Created: ${job.created_at}`,
    `Last updated: ${job.updated_at}`,
    `Scheduled: ${job.scheduled_start || '(none)'} - ${job.scheduled_end || '(none)'}`,
    `Max cost (budget): ${job.max_cost != null ? job.max_cost : '(none)'}`,
    `Severity: ${job.severity || '(none)'}  Urgent: ${!!job.is_urgent}  Emergency: ${!!job.is_emergency}`,
  ];

  const historyLines = (stateHistory || [])
    .map(e => `  - ${e.updated_at}: ${e.state && e.state.name}`)
    .join('\n');

  return `${lines.join('\n')}\n\nStatus timeline (context only — do not restate these as event claims):\n${historyLines || '  (none)'}`;
}

/**
 * @param {object} params
 * @param {object} params.job - full job detail from getJob()
 * @param {Array}  params.stateHistory - from getJobStateHistory()
 * @param {Array<{buffer: Buffer, filename: string, classification: string, sourceLabel: string}>} params.pdfFiles
 * @returns {Promise<{claims: Array, modelVersion: string, filesRead: string[]}>}
 */
async function extractAIClaims({ job, stateHistory, pdfFiles }) {
  const anthropic = client();

  const content = [];
  const filesRead = [];
  for (const f of (pdfFiles || []).slice(0, MAX_FILES_PER_JOB)) {
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: f.buffer.toString('base64') },
    });
    filesRead.push(f.filename);
  }

  const jobFieldsText = buildJobFieldsText(job, stateHistory);
  const promptText = `${EXTRACTION_PROMPT_HEADER}\n\n=== JOB FIELDS ===\n${jobFieldsText}\n\n=== ATTACHED FILES ===\n${
    filesRead.length ? filesRead.map((n, i) => `File ${i + 1}: ${n}`).join('\n') : '(no PDF files attached to this job)'
  }`;
  content.push({ type: 'text', text: promptText });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4096,
    messages: [{ role: 'user', content }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text block in Claude response.');
  const raw = textBlock.text.trim();
  const jsonStart = raw.search(/[[{]/);
  const trimmed = jsonStart > 0 ? raw.slice(jsonStart) : raw;
  const cleaned = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    // SECURITY: never log the raw model response here. It is exactly the
    // unfiltered text the content check (content-check.js) exists to screen
    // BEFORE anything is written anywhere — claims are extracted from real
    // Latchel ticket content and may routinely describe tenant health,
    // disability, or other protected-class-adjacent detail (see SPEC.md
    // "The Content Check"). Logging it here, pre-parse, would put that
    // content into server logs having never passed the check at all. Log
    // only metadata needed to diagnose a parse failure.
    console.error(
      `[extract-claims] JSON parse failed for job ${job && job.job_id}. ` +
      `Response length: ${raw.length} chars. Error: ${err.message}`
    );
    return { claims: [], modelVersion: response.model, filesRead };
  }

  const arr = Array.isArray(parsed) ? parsed : [];
  const claims = arr
    .filter(c => c && c.claim_type && c.claim_text && c.source_reference)
    .map(c => ({
      claim_type: c.claim_type,
      claim_text: String(c.claim_text),
      claim_date: c.claim_date || null,
      outcome_level: c.claim_type === 'outcome' && c.outcome_level != null ? Number(c.outcome_level) : null,
      related_ticket_ref: null, // see SPEC.md limitation note — resolving a text-mentioned ticket ref to a row is out of scope for v1
      source_type: ['latchel_job_field', 'latchel_state_history', 'latchel_invoice_field', 'latchel_job_file'].includes(c.source_type)
        ? c.source_type
        : 'latchel_job_field',
      source_reference: String(c.source_reference),
      confidence: typeof c.confidence === 'number' ? Math.max(0, Math.min(1, c.confidence)) : 0.5,
      extracted_by: response.model,
      modelFlag: !!c.protected_class_flag,
      modelCategory: c.protected_class_category || null,
    }));

  return { claims, modelVersion: response.model, filesRead };
}

module.exports = {
  buildDeterministicEventClaims,
  extractAIClaims,
  EXTRACTOR_ACTOR_ID,
};
