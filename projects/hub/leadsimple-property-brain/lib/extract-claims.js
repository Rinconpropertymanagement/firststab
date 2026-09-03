/**
 * lib/extract-claims.js
 * Turns one LeadSimple Application Screening process (spec Section 9,
 * Phase 2 — Application Screening only; Delinquency and Operations are
 * later phases, not built here) into candidate `claims` rows for the four
 * registered claim types (spec Section 2): stage_entered, task_completed,
 * task_skipped, field_recorded.
 *
 * Three of the four are purely deterministic — no AI, no uncertainty,
 * extracted_by='system', confidence=null, same discipline
 * maintenance-history/lib/extract-claims.js already uses for its
 * timeline-derived 'event' claims. Only `field_recorded` on the two
 * free-text fields (`positive_landlord_reference`, the process's own
 * `comments` field — confirmed live, see below) goes through Claude, for
 * the distilled-paraphrase-plus-self-check discipline spec Section 4
 * requires specifically for this domain's free text.
 *
 * LIVE VERIFICATION DONE FOR THIS BUILD (2026-08-26), against Rincon's
 * real account (GET /process_types/{app_screening_id}/custom_fields):
 * exactly 19 custom fields are defined on Application Screening, and
 * exactly ONE is free text — key `positive_landlord_reference`
 * (data_type "text"), matching the data-inventory doc's "19 defined
 * fields; only 1 is free-text" finding exactly. The other 18 are
 * choices/date/number/date_time — safe to record their value directly,
 * no paraphrase needed (spec Section 5: the paraphrase rule is specific
 * to the two free-text fields, not a blanket rule for every field). The
 * general `comments` field is a plain string directly on the Process
 * object (not a custom field, not on the process's `custom_fields` array)
 * — confirmed live against a real process.
 *
 * ONE HONEST GAP vs. the spec's original claim-type descriptions, discovered
 * by live verification and handled by the same rule this codebase already
 * established for maintenance ("say unknown rather than guess" —
 * extract-claims.js's own hard rule #2): see leadsimple-connector.js's
 * header comment for the full live-verification detail. Summarized here at
 * the point it actually matters:
 *   - stage_entered: LeadSimple has no per-process stage-HISTORY, only a
 *     process's CURRENT stage. claim_date is null, not a guessed date.
 *   task_completed and task_skipped do NOT have this problem — re-verified
 *   live 2026-08-31 (see buildTaskClaims below): `completed_at` is a
 *   purpose-built timestamp LeadSimple sets on a task whether it was
 *   completed OR skipped, so it's used directly as claim_date for both.
 *   (An earlier version of this file assumed skipped tasks had no reliable
 *   date and left claim_date null for them — live data showed that
 *   assumption was wrong.)
 */

const Anthropic = require('@anthropic-ai/sdk');

const EXTRACTOR_ACTOR_ID = 'leadsimple-application-screening-extractor';
const PROCESS_LABEL = '01 Application Screening';
const FREE_TEXT_CUSTOM_FIELD_KEY = 'positive_landlord_reference';

function client() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  return new Anthropic({ apiKey });
}

// Rincon Management is a Southern California property manager — every
// real business activity a claim's date describes (a task marked done, a
// field recorded) happens in Pacific time, not UTC. The original
// implementation here sliced toISOString() directly, which computes the
// UTC calendar day instead — live-verified 2026-08-31 against 171 real
// task_completed timestamps from Rincon's own accuracy-test cases: 13 of
// them (every one a task finished in the Pacific afternoon/evening,
// crossing midnight UTC) landed on a different, wrong calendar day under
// the UTC slice than under the correct Pacific date. Intl's ICU timezone
// database handles the PST/PDT DST transition automatically, unlike a
// fixed UTC offset.
const CLAIM_DATE_TIMEZONE = 'America/Los_Angeles';
const pacificDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: CLAIM_DATE_TIMEZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
});

function dateOnly(tsOrDate) {
  if (!tsOrDate) return null;
  const d = new Date(tsOrDate);
  if (isNaN(d.getTime())) return null;
  return pacificDateFormatter.format(d); // en-CA formats as YYYY-MM-DD
}

function hasRealValue(v) {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

/**
 * Custom fields typed "date" or "date_time" come back from LeadSimple as a
 * raw Unix-seconds number in `value` (e.g. "1788274800"), unlike every
 * other timestamp this API returns (created_at/updated_at/etc. are all
 * ISO 8601 strings) — found by actually running this against a real
 * process (field "What is the Desired Move in Date?"), not assumed.
 * Converts to a plain date (or date+time for date_time) for claim_text;
 * anything that isn't a bare-digits value for one of those two data types
 * is passed through unchanged rather than guessed at.
 */
function formatFieldValue(field) {
  const raw = field.value;
  const isTimestampType = field.data_type === 'date' || field.data_type === 'date_time';
  if (isTimestampType && /^\d+$/.test(String(raw).trim())) {
    const d = new Date(Number(raw) * 1000);
    if (!isNaN(d.getTime())) {
      return field.data_type === 'date_time' ? d.toISOString() : d.toISOString().slice(0, 10);
    }
  }
  return raw;
}

/** claim_type: stage_entered — always exactly one claim per process. */
function buildStageClaim(process) {
  const stage = process.stage;
  if (!stage || !stage.name) return null;
  return {
    claim_type: 'stage_entered',
    claim_text:
      `Process is currently in stage "${stage.name}" (LeadSimple's API has no per-process stage-history endpoint — ` +
      `this reflects the current stage as of this sync, not when the process entered it).`,
    claim_date: null,
    source_type: 'leadsimple_process_stage',
    source_reference: `LeadSimple process ${process.id} (${PROCESS_LABEL}), current stage`,
    source_link: process.link || null,
    confidence: null,
    extracted_by: 'system',
    modelFlag: false,
    modelCategory: null,
  };
}

/**
 * claim_type: task_completed / task_skipped — one claim per task that has
 * actually resolved one way or the other. A task that's neither completed
 * nor skipped (still open/pending) produces no claim — nothing happened
 * yet to record, same "don't force a claim" discipline as maintenance's
 * recurrence claims.
 *
 * `skipped` MUST be checked before `completed_at`, not after — live-
 * verified 2026-08-31 against Rincon's real account (swagger's Task model
 * plus 77 real skipped tasks sampled directly): skipping a task in
 * LeadSimple stamps its `completed_at` exactly like completing it does
 * (100% of the 77 skipped tasks sampled had completed_at set, every one of
 * them equal to updated_at). `completed_at` is really "resolved at," not
 * "completed-and-not-skipped at." Under the old `if (completed_at) ... else
 * if (skipped)` order, the completed branch caught every skipped task
 * first, so `task_skipped` could never fire — confirmed as the actual cause
 * of a real accuracy-test run producing zero task_skipped claims across 20
 * real cases, including ones where a task was genuinely skipped. Also means
 * completed_at is a reliable skip-date now, not the "no dedicated skip-date
 * field" fallback-to-updated_at this branch used to assume.
 */
function buildTaskClaims(process, tasks) {
  const claims = [];
  for (const task of tasks || []) {
    const label = task.description || (task.step && task.step.name) || `LeadSimple task ${task.id}`;
    if (task.skipped === true) {
      const skipDate = dateOnly(task.completed_at);
      claims.push({
        claim_type: 'task_skipped',
        claim_text: skipDate
          ? `Task "${label}" marked skipped on ${skipDate}.`
          : `Task "${label}" marked skipped (no date recorded).`,
        claim_date: skipDate,
        source_type: 'leadsimple_task',
        source_reference: `LeadSimple process ${process.id} (${PROCESS_LABEL}), task "${label}" (task ${task.id})`,
        source_link: process.link || null,
        confidence: null,
        extracted_by: 'system',
        modelFlag: false,
        modelCategory: null,
      });
    } else if (task.completed_at) {
      claims.push({
        claim_type: 'task_completed',
        claim_text: `Task "${label}" marked complete on ${dateOnly(task.completed_at)}.`,
        claim_date: dateOnly(task.completed_at),
        source_type: 'leadsimple_task',
        source_reference: `LeadSimple process ${process.id} (${PROCESS_LABEL}), task "${label}" (task ${task.id})`,
        source_link: process.link || null,
        confidence: null,
        extracted_by: 'system',
        modelFlag: false,
        modelCategory: null,
      });
    }
  }
  return claims;
}

/**
 * claim_type: field_recorded — deterministic path only, for the 18
 * non-free-text custom fields. The 19th (positive_landlord_reference) and
 * the process's own `comments` field are routed to extractFreeTextClaims
 * instead (this function explicitly skips them). Fields with no value
 * recorded yet produce no claim (nothing to record — "say unknown" applies
 * to omission too, not just to dates).
 */
function buildStructuredFieldClaims(process) {
  const claims = [];
  for (const field of process.custom_fields || []) {
    if (field.key === FREE_TEXT_CUSTOM_FIELD_KEY) continue; // routed to AI paraphrase path
    if (!hasRealValue(field.value)) continue;
    const date = dateOnly(field.updated_at);
    const displayValue = formatFieldValue(field);
    claims.push({
      claim_type: 'field_recorded',
      claim_text: `Field "${field.label}" recorded value "${displayValue}"${date ? ` on ${date}` : ''}.`,
      claim_date: date,
      source_type: 'leadsimple_custom_field',
      source_reference: `LeadSimple process ${process.id} (${PROCESS_LABEL}), field "${field.label}"${date ? `, recorded ${date}` : ''}`,
      source_link: process.link || null,
      confidence: null,
      extracted_by: 'system',
      modelFlag: false,
      modelCategory: null,
    });
  }
  return claims;
}

const FREE_TEXT_PROMPT = `You are paraphrasing short free-text fields from a real Southern California property management company's (Rincon Management) applicant-screening records, for a system that is NOT allowed to store the applicant's actual words — only a distilled paraphrase of what the field establishes (never a verbatim quote, never close enough to reconstruct the original wording).

HARD RULES:
1. Your "claim_text" must be a DISTILLED PARAPHRASE, not a quote. Do not reuse more than two consecutive words from the original text.
2. Do not add anything not stated in the field. Do not infer, score, characterize, or recommend anything about the applicant.
3. For EACH field, self-check: does this field's content touch on a legally protected personal topic — race, color, religion, sex, sexual orientation, gender identity, national origin, familial status, disability/health/medical, source of income (incl. Section 8/vouchers), marital status, age, ancestry, genetic information, citizenship/immigration status, or primary language? If yes, set "protected_class_flag": true and "protected_class_category" to a short label. This runs independent of, and in addition to, an automated keyword scan on your output — flag based on your own reading of the meaning, not just obvious keywords.

Return ONLY a JSON array, no markdown fences, no explanation. One element per field given below:
{
  "field_key": "the exact field key you were given",
  "claim_text": "distilled paraphrase, in plain English",
  "protected_class_flag": true | false,
  "protected_class_category": "short label or null"
}

If a field's value is empty or says nothing worth recording, omit it from the array entirely rather than inventing something.`;

/**
 * AI-derived field_recorded claims for the two free-text fields,
 * whichever of them actually have a value on this process. Returns [] with
 * no API call at all if neither field has content — matches the
 * deterministic paths' "nothing to record" discipline exactly, just also
 * saving the cost of a call that would return nothing anyway.
 */
async function extractFreeTextClaims(process) {
  const fields = [];
  const landlordRef = (process.custom_fields || []).find(f => f.key === FREE_TEXT_CUSTOM_FIELD_KEY);
  if (landlordRef && hasRealValue(landlordRef.value)) {
    fields.push({
      field_key: FREE_TEXT_CUSTOM_FIELD_KEY,
      label: landlordRef.label || 'Positive Landlord Reference',
      value: landlordRef.value,
      // Custom fields have their own purpose-built updated_at — trustworthy
      // as "date this value was recorded," unlike the process-level
      // comments field below, which has no field-specific timestamp at all.
      date: dateOnly(landlordRef.updated_at),
    });
  }
  if (hasRealValue(process.comments)) {
    fields.push({
      field_key: 'comments',
      label: 'comments',
      value: process.comments,
      // No independent timestamp exists for this field — it's a single
      // plain string on the process, not a dated custom-field record.
      // Deliberately null, not process.updated_at (which reflects ANY
      // change to the process, not specifically to this field — same
      // reasoning that rules out stage.updated_at for stage_entered).
      date: null,
    });
  }
  if (fields.length === 0) return [];

  const anthropic = client();
  const fieldsText = fields
    .map((f, i) => `Field ${i + 1} — key: "${f.field_key}", label: "${f.label}"\nValue: ${f.value}`)
    .join('\n\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 2048, // short field values, not a document — this is generous, not tight
    output_config: { effort: 'medium' },
    messages: [{ role: 'user', content: `${FREE_TEXT_PROMPT}\n\n=== FIELDS ===\n${fieldsText}` }],
  });

  if (response.stop_reason === 'max_tokens') {
    console.error(
      `[leadsimple extract-claims] TRUNCATED response for process ${process.id}. This process needs a retry.`
    );
    return { claims: [], modelVersion: response.model, truncated: true };
  }

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
    // SECURITY: never log the raw model response — it is exactly the
    // unfiltered, paraphrase-target free text the content check exists to
    // screen BEFORE anything is written anywhere. Same discipline as
    // maintenance-history/lib/extract-claims.js's identical guard.
    console.error(
      `[leadsimple extract-claims] JSON parse failed for process ${process.id}. ` +
      `Response length: ${raw.length} chars. Error: ${err.message}`
    );
    return { claims: [], modelVersion: response.model };
  }

  const byKey = new Map(fields.map(f => [f.field_key, f]));
  const arr = Array.isArray(parsed) ? parsed : [];
  const claims = arr
    .filter(c => c && c.field_key && c.claim_text && byKey.has(c.field_key))
    .map(c => {
      const f = byKey.get(c.field_key);
      return {
        claim_type: 'field_recorded',
        claim_text: String(c.claim_text),
        claim_date: f.date,
        source_type: 'leadsimple_custom_field',
        // Structural pointer only, per spec Section 5 item 1 — field name
        // and timestamp, NEVER the field's own text content.
        source_reference:
          `LeadSimple process ${process.id} (${PROCESS_LABEL}), field "${f.label}"` +
          (f.date ? `, recorded ${f.date}` : ''),
        source_link: process.link || null,
        confidence: null, // AI-paraphrased but not a judgment call with a confidence dimension — it's a restatement, not an inference
        extracted_by: response.model,
        modelFlag: !!c.protected_class_flag,
        modelCategory: c.protected_class_category || null,
      };
    });

  return { claims, modelVersion: response.model };
}

/**
 * Full extraction for one process: every deterministic claim plus the
 * AI-derived free-text claims, as one flat array ready for the content
 * check (content-check.js) and insert. Does not touch Supabase or run the
 * content check itself — that's the caller's job (see run-accuracy-
 * test-sample.js), same separation of concerns as maintenance-history's
 * extract-claims.js / router.js split.
 */
async function extractProcessClaims({ process, tasks }) {
  const deterministic = [
    buildStageClaim(process),
    ...buildTaskClaims(process, tasks),
    ...buildStructuredFieldClaims(process),
  ].filter(Boolean);

  let aiResult = { claims: [], modelVersion: null };
  try {
    aiResult = await extractFreeTextClaims(process);
  } catch (err) {
    console.error(`[leadsimple extract-claims] free-text extraction failed for process ${process.id}:`, err.message);
    aiResult = { claims: [], modelVersion: null, error: err.message };
  }

  return {
    claims: [...deterministic, ...(aiResult.claims || [])],
    truncated: !!aiResult.truncated,
    aiModelVersion: aiResult.modelVersion,
  };
}

module.exports = {
  buildStageClaim,
  buildTaskClaims,
  buildStructuredFieldClaims,
  extractFreeTextClaims,
  extractProcessClaims,
  EXTRACTOR_ACTOR_ID,
  FREE_TEXT_CUSTOM_FIELD_KEY,
};
