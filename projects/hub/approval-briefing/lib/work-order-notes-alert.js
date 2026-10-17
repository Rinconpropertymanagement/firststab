/**
 * lib/work-order-notes-alert.js
 *
 * Work Order Notes Alert (work-order-notes-alert-SPEC.md, written by
 * Oracle). When Latchel reports a new work order at a property that has a
 * maintenance note on file (properties.maintenance_notes), this sends a
 * fixed-template email to that property's pod inbox (Faria/Solimar) so the
 * note reaches the right people immediately instead of waiting for
 * someone to go look. No AI-written text anywhere in the email itself —
 * a template filled with already-synced fields plus this one
 * property-level text field, quoted verbatim, plus (only when
 * WORK_ORDER_ALERT_DESCRIPTION_MODE is 'on', and the ingestion interlock
 * below is satisfied) the optional "What the work order is" block described
 * under DESCRIPTION BLOCK below.
 *
 * DESCRIPTION BLOCK (optional, off by default): the email can also say
 * what the work order is, by quoting the job's own title (job.name) and
 * description (job.description) after cleaning and a REQUIRED local screen
 * (a word-list scan that runs on this server; any hit or any error withholds
 * the whole block and substitutes one fixed sentence). THERE IS NO AI IN THIS
 * PATH: no model is called, nothing from the job text is sent to Anthropic or
 * anywhere else, in off, shadow or on mode (Peter's decision of 2026-10-16;
 * the tests prove it). That screen is Asimov's binding ruling for this
 * addition and is separate from, and not affected by, Peter's removal of
 * the check from the NOTES path below. Everything lives in
 * lib/work-order-summary.js, lib/work-order-text-clean.js and
 * lib/work-order-text-screen.js (+ -terms.js); this file only wires it in.
 * WORK_ORDER_ALERT_DESCRIPTION_MODE is 'off' | 'shadow' | 'on' (unset or
 * anything else = 'off', and the email is then byte-identical to before this
 * block existed). 'shadow' runs the whole local pipeline and writes the
 * counts-only audit event but leaves the block out of the email. 'on' takes
 * effect only when WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED is exactly
 * 'yes' (set by Jarvis or Scotty after the Missive-intake exclusion is live and
 * verified and Peter has said yes); otherwise it behaves as 'shadow' and the
 * audit event records on_downgraded. The title and description are never
 * stored (not in work_order_note_alerts, not in audit_log, not in logs, not in
 * the failure email); the sent email is the only copy. A problem building the
 * block never stops the alert: it is sent without it.
 *
 * RULE 9 (GOVERNANCE.md): THE TEXT, THE HOLD RESULT AND THE CATEGORY ONLY
 * DECIDE WHAT IS DISPLAYED. They never reach resolveRecipients(), the dedup
 * lookup, the subject, the task write, the work_order_note_alerts row, the
 * priority line or any other action about a tenant or a unit. Keep it that way:
 * the block is prepared AFTER recipients are resolved and is only ever passed
 * to buildEmailContent() as display lines.
 *
 * CONTENT CHECK ON THE NOTES — REMOVED BY PETER'S EXPLICIT, DOCUMENTED OVERRIDE, READ
 * THIS BEFORE RE-ADDING ANYTHING HERE: Asimov's original governance review
 * (compliance/work-order-note-alerts-governance-review.md) approved this
 * build CONDITIONED on a two-layer content check (keyword scan + AI
 * classification) running on every send, with redact-on-flag and a
 * proactive human alert on a flag. That check was built, tested, and
 * confirmed working — including catching a real example a keyword-only
 * scan missed. Peter then explicitly instructed it be removed entirely
 * (verbatim notes, no scanning, no AI involvement, no exceptions), after
 * Jarvis pushed back twice — once procedurally (this was a CONDITION of
 * Asimov's approval, not a discretionary layer) and once substantively
 * (citing the concrete caught example) — and after Peter's own
 * counter-argument was met with an on-point rebuttal (Mason's prior,
 * directly analogous ruling on `access_instructions`). Peter maintained
 * his instruction and explicitly declined an Asimov re-check. Full record,
 * verbatim quotes, and reasoning:
 * compliance/work-order-note-alerts-content-check-removal-decision-resolution.md
 * — read that file, not just this comment, before touching this decision.
 * `work-order-notes-content-check.js` and `work-order-notes-classifier.js`
 * still exist in this repo, deliberately left unwired rather than
 * deleted, in case this is ever revisited — nothing in this file calls
 * them anymore.
 *
 * Called from two places in ../router.js: the webhook branch (fire-and-
 * forget, one job at a time, per delivery) and the hourly
 * reconcile-work-order-notes backstop route (awaited, one job at a time,
 * in a loop). Both funnel through the same handleWorkOrderJob() below —
 * the single place that implements spec Section 2.3's "first delivery
 * this system ever sees" rule and Section 4's dedup+retry logic, so the
 * two trigger paths can never disagree about what "already handled" means.
 *
 * WHAT COUNTS AS "QUALIFYING": a job whose property resolves (via
 * properties.latchel_property_id == job.property_id, spec Section 2.2)
 * AND whose property has a non-empty maintenance_notes value. A job at an
 * unresolvable or note-free property is a silent no-op — no
 * work_order_note_alerts row, no email, nothing — the same shape as
 * approval-briefing's own webhook branch returning
 * {action:'discarded'} for a job it doesn't care about. Re-evaluating the
 * same non-qualifying job on a later redelivery or backstop pass is
 * harmless (no side effects either time), which is exactly what makes it
 * safe to keep no row recording "we saw this and it didn't qualify." An
 * unresolved property is specifically NOT lost — spec Section 2.2 notes
 * this is a real, bounded gap that the existing, separate
 * reconcile-properties job closes over time; once latchel_property_id
 * resolves, a later webhook/backstop pass re-evaluates this same job
 * fresh.
 *
 * DEDUP + RETRY (spec Section 4; Neo's migration header note in
 * supabase/migrations/20260921000000_work_order_note_alerts_schema.sql):
 * once a job DOES qualify, work_order_note_alerts.latchel_job_id (a real
 * UNIQUE constraint) is the single source of truth for "have we already
 * handled this." No row => first time, attempt send. Row with
 * send_status='sent' => already handled, skip. Row with
 * send_status='failed' => retry — re-reading the CURRENT
 * maintenance_notes value fresh (re-fetched at the top of every attempt),
 * never reusing whatever was read on the failed attempt, so a retry always
 * sends the property's latest note text, not a stale copy.
 *
 * ATOMICITY, HONESTLY STATED: this does not implement the full
 * database-level INSERT...ON CONFLICT...WHERE send_status='failed' upsert
 * Neo's migration comment describes as the ideal — that needs a raw
 * SQL/RPC call, which is a schema-adjacent change this build is not
 * authorized to make on its own (see the build report to Jarvis). Instead
 * this uses the same level of best-effort race protection this codebase
 * already accepts in ../router.js's own insertBriefingIfNew(): an
 * application-level check-then-write, backstopped by the table's real
 * UNIQUE constraint so two racing writers can never create two ROWS for
 * the same job (one always hits Postgres error 23505, handled below by
 * falling back to the same conditional UPDATE the retry path uses). Two
 * writers landing in the exact same instant could in principle both pass
 * the initial dedup check and both attempt a real send — the same
 * documented tradeoff approval-briefing's own comment accepts ("the index
 * is the backstop for the race... between webhook and poll firing close
 * together"). The webhook/backstop overlap window this actually has to
 * survive in practice is small.
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const latchel = require('../../maintenance-history/lib/latchel-connector');
const { getSharedInbox, sendMail } = require('../../lib/notify');
const {
  prepareWorkOrderSummary, descriptionMode, descriptionModeInfo, SCREEN_VERSION,
} = require('./work-order-summary');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Independent failure-notification channel (nodemailer + GMAIL_USER/
// GMAIL_APP_PASSWORD) ────────────────────────────────────────────────────
// Cloned from security-deposit/router.js's (and archive-search/router.js's
// identical) createMailer()/sendFailureAlertEmail() pattern — genuinely
// separate credentials (SMTP app-password, not lib/notify.js's Gmail
// API/OAuth2), separate code path, separate failure domain. Exists
// specifically so notifyPeterOfSendFailure() below doesn't depend on the
// SAME channel (lib/notify.js) as the alert whose failure it's reporting —
// see that function's own comment. GMAIL_USER/GMAIL_APP_PASSWORD were a
// known, pre-existing gap (unset) when this feature originally shipped
// its failure notification on lib/notify.js instead (see that build's own
// report) — Peter has since set them, closing that gap; this wires the
// independent channel in to actually use them, per his instruction.
//
// Degrades gracefully exactly like security-deposit's own createMailer():
// missing package or missing/empty credentials returns null rather than
// throwing, so a misconfigured or not-yet-configured environment never
// crashes processJob() — it just means this one notification silently
// can't send (still logged loudly below), same as before Peter set the
// credential.
let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  console.warn('[work-order-notes-alert] nodemailer not installed — the independent failure-notification channel is disabled.');
}

function createFailureNotificationMailer() {
  if (!nodemailer || !process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
}

const FAILURE_NOTIFICATION_RECIPIENT = 'peter@rinconmanagement.com';

// Same fallback shape lib/auth.js already uses for building an absolute
// Hub URL (its password-reset link) — matched here rather than inventing
// a second convention for the same env var.
const HUB_BASE_URL = process.env.HUB_BASE_URL || `http://localhost:${process.env.HUB_PORT || 3500}`;

const MISSING_POD_TASK_TITLE = 'Property missing pod assignment';

// How far back the hourly backstop poll looks (spec Section 2.4).
// listJobsUpdatedSince's own filter is date-granularity, not
// timestamp-granularity (see latchel-connector.js's JSDoc:
// "updated_at_start_date=YYYY-MM-DD"), so a 1-day window risks a job that
// updated late yesterday (server-local vs. Latchel's own timezone) never
// being pulled at all by an hourly run early today. 2 days is a small,
// safe margin over that ambiguity, not a researched number — cheap to
// widen later if real operation shows it's not enough. Over-fetching is
// explicitly safe here: work_order_note_alerts' dedup/retry logic makes
// re-scanning a job already sent (or not yet qualifying) a guaranteed
// no-op (Neo's migration header note; spec Section 2.4's own "running it
// repeatedly or on overlapping windows is always safe").
const RECONCILE_LOOKBACK_DAYS = 2;

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// ─── Audit log — system-actor shape ────────────────────────────────────
// Neo's migration guidance ("AUDIT LOG GUIDANCE FOR Q"): of this
// codebase's two existing writeAuditLog() helpers, email-intake/lib/
// shared.js's (hardcodes actor_type:'system') is the shape this
// feature's system-triggered events match — NOT maintenance-history/
// router.js's (hardcodes actor_type:'human'). Written locally here
// rather than imported from email-intake/lib/shared.js so this feature
// doesn't pull in that module's unrelated Missive-connector exports and
// its own second Supabase client — same "small, tool-scoped duplicate,
// no second consumer yet" reasoning security-deposit/router.js already
// gives for its own normalizeAddress/addressWordScore copies.
//
// Includes a `trace` object in event_data per GOVERNANCE.md Rule 1's
// literal field list and Asimov's explicit reminder in the governance
// review ("every entry still needs the full Rule 1 field set (hash
// chain, trace object)"). No real distributed tracer exists anywhere in
// this codebase today (checked — no live call site populates trace_id
// outside the Rule 1 migration's own genesis row) — trace_id is
// generated once per job-handling invocation (passed through every audit
// call for that attempt) and span_id fresh per call, parent_span_id
// null, which satisfies Rule 1's literal "event_data must include
// trace: {...}" requirement without inventing tracing infrastructure
// this build has no other reason to add.
async function writeAuditLog({ action, entity_type, entity_id, actor_id, privacy_category, risk_level, details, traceId, quietErrors = false }) {
  const { error } = await supabase.from('audit_log').insert({
    action,
    entity_type,
    entity_id,
    actor_type: 'system',
    actor_id,
    privacy_category,
    risk_level,
    details: {
      ...details,
      trace: { trace_id: traceId || null, span_id: crypto.randomUUID(), parent_span_id: null },
    },
  });
  if (error) {
    // quietErrors: the description-block event never echoes a database error
    // message (constant line only), so nothing near the job text can be logged.
    if (quietErrors) console.error(`[work-order-notes-alert] audit_log insert failed for ${action}.`);
    else console.error(`[work-order-notes-alert] audit_log insert failed for ${action}:`, error.message);
  }
}

// ─── Property resolution (spec Section 2.2) ────────────────────────────
// Same join path approval-briefing/lib/gather.js's own resolveLinkage()
// already established for this exact field pair — property-level, not
// through a matched maintenance_requests row.
async function resolvePropertyByLatchelId(latchelPropertyId) {
  if (!latchelPropertyId) return null;
  const { data, error } = await supabase
    .from('properties')
    .select('id, name, address, pod, maintenance_notes')
    .eq('latchel_property_id', latchelPropertyId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getExistingAlertRow(latchelJobId) {
  const { data, error } = await supabase
    .from('work_order_note_alerts')
    .select('id, send_status')
    .eq('latchel_job_id', latchelJobId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ─── Missing-pod tracking (spec Section 5.2) ───────────────────────────
// Deduped against an existing OPEN task for the same property so a
// property stuck unassigned doesn't accumulate one row per work order —
// the email itself still sends every time regardless (Section 5.3's
// no-throttling rule is about the email, not this secondary tracking
// write). Not specified either way by the spec; a deliberate, low-risk
// judgment call — flagged in the build report.
async function flagMissingPod(property, traceId) {
  try {
    const { data: existingTask, error: lookupError } = await supabase
      .from('tasks')
      .select('id')
      .eq('entity_type', 'property')
      .eq('entity_id', property.id)
      .eq('title', MISSING_POD_TASK_TITLE)
      .eq('status', 'open')
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!existingTask) {
      const { error: insertError } = await supabase.from('tasks').insert({
        title: MISSING_POD_TASK_TITLE,
        description: `${property.name || property.address || property.id} has a maintenance note on file but no pod assigned, so the Work Order Notes Alert emailed both pod inboxes as a fallback. Assign a pod so future alerts go to the right team only.`,
        status: 'open',
        priority: 'medium',
        entity_type: 'property',
        entity_id: property.id,
      });
      if (insertError) throw insertError;
    }
  } catch (err) {
    // Non-fatal — this is a secondary "track the data gap" write, not the
    // alert itself. Logged loudly so it's not silently lost, but never
    // blocks the actual notification pipeline.
    console.error('[work-order-notes-alert] tasks insert for missing-pod flag failed:', err.message);
  }

  await writeAuditLog({
    action: 'work_order_note_alert.pod_unassigned_flagged',
    entity_type: 'property',
    entity_id: property.id,
    actor_id: 'work-order-notes-alert',
    privacy_category: 'processing',
    risk_level: 'medium',
    details: { property_id: property.id },
    traceId,
  });
}

// ─── Recipient resolution (spec Section 5) ─────────────────────────────
// getSharedInbox() never throws (lib/notify.js's own documented
// contract) — a missing/inactive key resolves to null, not an error —
// so this function is safe to call without its own try/catch.
async function resolveRecipients(property, traceId) {
  if (property.pod === 'Solimar' || property.pod === 'Faria') {
    const key = property.pod === 'Solimar' ? 'solimar_pod_team' : 'faria_pod_team';
    const email = await getSharedInbox(key);
    return { pod: property.pod, recipients: email ? [email] : [] };
  }

  // Unassigned-pod fallback (spec Section 5.2) — mirrors insurance/
  // router.js's own "property can't be matched to a pod" shape (both
  // inboxes), plus a tracked task for the underlying data gap.
  const [fariaEmail, solimarEmail] = await Promise.all([
    getSharedInbox('faria_pod_team'),
    getSharedInbox('solimar_pod_team'),
  ]);
  const recipients = [fariaEmail, solimarEmail].filter(Boolean);

  await flagMissingPod(property, traceId);

  return { pod: 'unassigned_both', recipients };
}

// ─── Email content (spec Section 6) ────────────────────────────────────
// `descriptionLines` is the optional "What the work order is" block from
// lib/work-order-summary.js. When it is null/empty the output is exactly
// what this function produced before the block existed; when present it
// is inserted as ONE contiguous segment (a blank line, then the block)
// right after the "Created:" line. The subject never changes.
function buildEmailContent({ property, pod, job, notesText, descriptionLines }) {
  const podLabel = pod === 'unassigned_both' ? 'unassigned' : pod;
  const propertyLabel = property.name || property.address || `Property ${property.id}`;
  const link = `${HUB_BASE_URL}/property-360?property_id=${encodeURIComponent(property.id)}`;
  const createdAt = job.created_at || job.updated_at || null;

  let block = [];
  if (Array.isArray(descriptionLines) && descriptionLines.length) {
    // Defense in depth: the cleaner already removes every newline, so a
    // line that still contains one means a bug. Refuse it rather than let
    // text forge extra lines in the email.
    if (descriptionLines.some((l) => typeof l !== 'string' || /[\r\n]/.test(l))) {
      throw new Error('description block line is not a single plain-text line');
    }
    block = ['', ...descriptionLines];
  }

  const subject = `Work Order Alert — ${propertyLabel} has special handling notes`;
  const text = [
    `A new work order was just created for ${propertyLabel} (pod: ${podLabel}).`,
    '',
    'This property has maintenance notes on file:',
    `"${notesText}"`,
    '',
    `Work order: Ticket #${job.order_number != null ? job.order_number : '—'} (Latchel job ${job.job_id != null ? job.job_id : job.id})`,
    `Created: ${createdAt || '—'}`,
    ...block,
    '',
    `View this property: ${link}`,
    '',
    'This inbox is not monitored — see Property 360 above for anything that needs follow-up.',
  ].join('\n');

  return { subject, text };
}

// ─── Optional "What the work order is" block ────────────────────────────
// Runs only when WORK_ORDER_ALERT_DESCRIPTION_MODE is 'shadow' or 'on'
// (see this file's header). Returns the lines to put in the email, or null
// for "send the alert exactly as before". Never throws: whatever goes
// wrong, the alert still goes out without the block. Logs are constant
// lines; the title and description are never logged, stored or put in the
// audit event (counts-only details, Asimov's ruling). NO AI: the screen is a
// local word list, and the only outbound call possible here is the injected
// read-only Latchel lookup.
//
// Rule 9: this runs AFTER resolveRecipients(); its result is display lines
// and an audit row, nothing else. It must never be passed to, or change, the
// recipients, the dedup lookup, the subject, the tasks write or the
// work_order_note_alerts row.

const DESCRIPTION_AUDIT_ACTION = 'work_order_note_alert.description_checked';

async function writeDescriptionAudit({ property, latchelJobId, triggerSource, mode, downgraded, summary, traceId }) {
  const m = summary.meta;
  // Medium for an unavailable lookup and for every hold except the unassigned
  // pod. A scanner error (check_error), unsettled text (unsettled_text), a hold
  // the cleaner asked for by itself (link_shape) and a summary error are always
  // holds, so they are medium too; shown and none are low.
  const medium = summary.status === 'unavailable'
    || (summary.status === 'held' && m.cause !== 'pod_unassigned');
  await writeAuditLog({
    action: DESCRIPTION_AUDIT_ACTION,
    entity_type: 'property',
    entity_id: property.id,
    actor_id: 'work-order-notes-alert',
    privacy_category: 'processing',
    risk_level: medium ? 'medium' : 'low',
    // Counts only: the keys below are the whole list. No text, term, length,
    // hash, excerpt, per-term count or CATEGORY NAME (a category name next to a
    // job id and a property is a sensitive inference about a household, and
    // Peter's rule is no protected-class data in any table). These describe the
    // job's own text, so they must never be copied into
    // work_order_note_alerts.flagged_protected_class / flagged_category (those
    // columns describe the maintenance notes).
    details: {
      latchel_job_id: latchelJobId,
      trigger_source: triggerSource,
      mode,
      result: summary.status,
      cause: m.cause,
      common_word_only: m.common_word_only,
      screen_version: m.screen_version,
      truncated: m.truncated,
      fallback_getjob_used: m.fallback_getjob_used,
      pod_unassigned: m.pod_unassigned,
      on_downgraded: downgraded,
    },
    traceId,
    quietErrors: true,
  });
}

async function prepareDescriptionBlock({ job, latchelJobId, property, pod, triggerSource, traceId }) {
  const { mode, downgraded } = descriptionModeInfo();
  if (mode === 'off') return null;
  if (downgraded) {
    console.warn('[work-order-notes-alert] Description mode is "on" but the ingestion interlock is not set - running as "shadow".');
  }

  try {
    const summary = await prepareWorkOrderSummary(job, {
      podUnassigned: pod === 'unassigned_both',
      jobId: latchelJobId,
      fetchJob: (id) => latchel.getJob(id),
    });
    await writeDescriptionAudit({ property, latchelJobId, triggerSource, mode, downgraded, summary, traceId });

    // 'shadow' measures everything but changes nothing in the email.
    return mode === 'on' ? summary.lines : null;
  } catch (_err) {
    // Constant text only: the error may carry text from the job or the database.
    console.error(`[work-order-notes-alert] job ${latchelJobId}: could not prepare the description block - sending the alert without it.`);
    try {
      await writeDescriptionAudit({
        property, latchelJobId, triggerSource, mode, downgraded, traceId,
        summary: {
          status: 'held',
          meta: {
            cause: 'summary_error', common_word_only: false,
            screen_version: SCREEN_VERSION, truncated: false, fallback_getjob_used: false, pod_unassigned: pod === 'unassigned_both',
          },
        },
      });
    } catch (_err2) { /* best effort only */ }
    return null;
  }
}

// ─── Direct failure notification (Judge finding) ───────────────────────
// Before this, a send failure left only a work_order_note_alerts row
// (send_status='failed') and a server log line — nothing told Peter
// directly. This closes that gap with a real email.
//
// Uses the INDEPENDENT nodemailer/GMAIL_USER+GMAIL_APP_PASSWORD channel
// above (createFailureNotificationMailer()), deliberately NOT
// lib/notify.js's sendMail() that the rest of this file (the actual pod
// alert) uses. This notification exists specifically to cover the case
// where the PRIMARY channel (lib/notify.js) is what's broken — routing
// it through that same channel would mean the one time this notification
// matters most is the one time it's also most likely to be silently
// broken too. Same reasoning security-deposit/router.js's and
// archive-search/router.js's own sendFailureAlertEmail() already
// document for their own, identical channel split.
//
// Fire-and-forget (not awaited) — same reasoning as before: nothing here
// needs to be awaited for processJob() to behave correctly, and not
// awaiting means a slow/hung SMTP call can never add latency to the
// reconcile loop's per-job iteration or complicate processJob()'s own
// control flow/return value. The .catch() on the sendMail promise below
// is real defense-in-depth here (not just decorative) — nodemailer's
// sendMail, unlike lib/notify.js's own wrapper, DOES reject on a real
// SMTP failure (bad credentials, network error, etc.), so this is the
// thing that actually stops such a failure from becoming an unhandled
// promise rejection.
//
// Degrades gracefully if the credential is missing/invalid — logs it,
// never throws, never crashes processJob() — same discipline as
// createFailureNotificationMailer() itself and as every other failure
// path in this file. NEVER logs the credential value itself, only
// whether it's configured.
function notifyPeterOfSendFailure({ property, job, latchelJobId, pod, recipients, error }) {
  const propertyLabel = property.name || property.address || `Property ${property.id}`;
  const subject = `Work Order Notes Alert failed to send — ${propertyLabel}`;
  const text = [
    `The Work Order Notes Alert for ${propertyLabel} failed to send.`,
    '',
    `Work order: Ticket #${job.order_number != null ? job.order_number : '—'} (Latchel job ${latchelJobId})`,
    `Intended pod / recipients: ${pod || '—'} (${recipients && recipients.length ? recipients.join(', ') : 'none resolved'})`,
    `Error: ${error || 'unknown'}`,
    '',
    'This will be retried automatically on the next hourly backstop poll (or the next webhook delivery for the same work order) — no action needed unless it keeps failing.',
  ].join('\n');

  const mailer = createFailureNotificationMailer();
  if (!mailer) {
    console.error(`[HUB-ALERT] Could not send failure notification to ${FAILURE_NOTIFICATION_RECIPIENT} — independent mailer unavailable (GMAIL_USER/GMAIL_APP_PASSWORD not configured, or nodemailer not installed). Subject would have been: ${subject}`);
    return;
  }

  mailer.sendMail({
    from: process.env.GMAIL_USER,
    to: FAILURE_NOTIFICATION_RECIPIENT,
    subject,
    text,
  }).then(() => {
    console.error(`[HUB-ALERT] Failure notification sent to ${FAILURE_NOTIFICATION_RECIPIENT} for job ${latchelJobId}.`);
  }).catch((err) => {
    console.error(`[HUB-ALERT] Failure-notification email to Peter itself failed to send for job ${latchelJobId}:`, err.message);
  });
}

// ─── Core pipeline ──────────────────────────────────────────────────────
const KNOWN_SEND_ERRORS = new Set([
  'no_recipient', 'mailer_not_configured', 'invalid_grant', 'invalid_client', 'unauthorized_client',
]);

function safeSendError(error) {
  return typeof error === 'string' && KNOWN_SEND_ERRORS.has(error) ? error : 'send_failed';
}

async function processJob(job, triggerSource) {
  const traceId = crypto.randomUUID();
  const latchelJobId = job.job_id != null ? String(job.job_id) : (job.id != null ? String(job.id) : null);
  const latchelPropertyId = job.property_id != null ? String(job.property_id) : null;

  if (!latchelJobId) {
    console.warn('[work-order-notes-alert] Job with no job_id/id — skipping.');
    return { action: 'skipped', reason: 'no_job_id' };
  }

  const property = await resolvePropertyByLatchelId(latchelPropertyId);
  if (!property) {
    // Unresolvable property (spec Section 2.2's ~12% gap) or a job with
    // no property_id at all — not lost. The existing, separate
    // reconcile-properties job will eventually populate
    // latchel_property_id, and a later webhook delivery or backstop pass
    // re-evaluates this same job fresh. No row, no email, nothing to
    // undo later.
    return { action: 'discarded', reason: 'property_not_resolved' };
  }

  const notes = typeof property.maintenance_notes === 'string' ? property.maintenance_notes.trim() : '';
  if (!notes) {
    return { action: 'discarded', reason: 'no_maintenance_notes' };
  }

  // Qualifying job from here on — dedup/retry check (spec Section 4).
  const existing = await getExistingAlertRow(latchelJobId);
  if (existing && existing.send_status === 'sent') {
    console.log(`[work-order-notes-alert] job ${latchelJobId}: already sent, skipping (${triggerSource}).`);
    return { action: 'already_sent' };
  }

  await writeAuditLog({
    action: 'work_order_note_alert.triggered',
    entity_type: 'property',
    entity_id: property.id,
    actor_id: 'work-order-notes-alert',
    privacy_category: 'processing',
    risk_level: 'low',
    details: { latchel_job_id: latchelJobId, trigger_source: triggerSource, retry: !!existing },
    traceId,
  });

  // No content check (Peter's explicit, documented override — see this
  // file's header). `notes` — property.maintenance_notes, fetched fresh
  // just above — goes into the email exactly as-is.
  const { pod, recipients } = await resolveRecipients(property, traceId);

  // With nobody to send to, the send cannot succeed, so the block (and its
  // Latchel lookup and audit row) is not built: a job whose send keeps failing
  // for want of an inbox is then not re-scanned and re-counted on every pass.
  const descriptionLines = recipients.length
    ? await prepareDescriptionBlock({ job, latchelJobId, property, pod, triggerSource, traceId })
    : null;

  let email;
  try {
    email = buildEmailContent({ property, pod, job, notesText: notes, descriptionLines });
  } catch (_err) {
    // The optional block must never be the reason an alert is not sent.
    console.error(`[work-order-notes-alert] job ${latchelJobId}: could not add the description block to the email — sending the alert without it.`);
    email = buildEmailContent({ property, pod, job, notesText: notes });
  }
  const { subject, text } = email;
  let sendResult = await sendMail({ to: recipients, subject, text });
  if (!sendResult.ok && descriptionMode() === 'on') {
    // Only while the description is really IN the email (mode 'on') can the
    // body carry job text, and a mail error could echo a body. Keep only a
    // short known code; the mail module already logs its own detail. (Modes
    // off and shadow: the original error text is kept, as before.)
    sendResult = { ...sendResult, error: safeSendError(sendResult.error) };
  }

  const now = new Date().toISOString();
  const rowFields = {
    latchel_property_id: latchelPropertyId,
    property_id: property.id,
    pod,
    recipients,
    // Always FALSE/NULL — no content check runs anymore (Peter's
    // documented override, this file's header). Matches the existing
    // schema as-is; no migration needed (Neo/Asimov confirmed this in
    // compliance/work-order-note-alerts-content-check-removal-decision-
    // resolution.md).
    flagged_protected_class: false,
    flagged_category: null,
    notes_snapshot: notes,
    send_status: sendResult.ok ? 'sent' : 'failed',
    send_error: sendResult.ok ? null : (sendResult.error || 'unknown_error'),
    trigger_source: triggerSource,
    attempted_at: now,
    sent_at: sendResult.ok ? now : null,
  };

  try {
    if (existing) {
      // Retry path — existing.send_status was 'failed' (the only other
      // case, 'sent', already returned above). Conditional on
      // send_status='failed' so a race with another writer that already
      // flipped this row to 'sent' can't be clobbered back to 'failed' —
      // see this file's header note on why this isn't the full DB-level
      // atomic WHERE-conditioned upsert Neo's migration comment
      // describes.
      const { error } = await supabase
        .from('work_order_note_alerts')
        .update(rowFields)
        .eq('latchel_job_id', latchelJobId)
        .eq('send_status', 'failed');
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from('work_order_note_alerts')
        .insert({ latchel_job_id: latchelJobId, ...rowFields });
      if (error) {
        if (error.code === '23505') {
          // Race: another writer inserted this job between our dedup
          // check and this insert. Fall back to the same conditional
          // update as the retry path — if that row is already 'sent',
          // this update matches zero rows and no-ops, which is correct
          // (never overwrite a real send record with a redundant
          // attempt's result).
          const { error: raceUpdateError } = await supabase
            .from('work_order_note_alerts')
            .update(rowFields)
            .eq('latchel_job_id', latchelJobId)
            .eq('send_status', 'failed');
          if (raceUpdateError) throw raceUpdateError;
        } else {
          throw error;
        }
      }
    }
  } catch (err) {
    // The row write is this feature's core failure-visibility mechanism
    // (spec Section 8) — if IT fails, that's the loudest possible signal
    // this file can produce. Never swallow silently.
    console.error(`[HUB-ALERT] work_order_note_alerts row write failed for job ${latchelJobId} (send_status would have been '${rowFields.send_status}'):`, err.message);
  }

  if (sendResult.ok) {
    console.log(`[work-order-notes-alert] job ${latchelJobId}: alert sent to ${recipients.join(', ') || '(no recipients)'}.`);
    await writeAuditLog({
      action: 'work_order_note_alert.sent',
      entity_type: 'property',
      entity_id: property.id,
      actor_id: 'work-order-notes-alert',
      privacy_category: 'processing',
      risk_level: 'low',
      details: { latchel_job_id: latchelJobId, property_id: property.id, pod, recipients },
      traceId,
    });
  } else {
    console.error(`[HUB-ALERT] work-order-notes-alert: send failed for job ${latchelJobId} — will retry on next delivery/poll. Reason: ${sendResult.error}`);
    notifyPeterOfSendFailure({ property, job, latchelJobId, pod, recipients, error: sendResult.error });
    await writeAuditLog({
      action: 'work_order_note_alert.send_failed',
      entity_type: 'property',
      entity_id: property.id,
      actor_id: 'work-order-notes-alert',
      privacy_category: 'processing',
      risk_level: 'high',
      details: { latchel_job_id: latchelJobId, property_id: property.id, pod, recipients, error: sendResult.error },
      traceId,
    });
  }

  return { action: sendResult.ok ? 'sent' : 'failed', latchel_job_id: latchelJobId };
}

// Exported entrypoint — never throws, so a bug here can never crash the
// webhook handler or abort a reconcile loop partway through. Both call
// sites in ../router.js rely on this.
//
// Same-job concurrency guard, ONLY while the description block is active
// (mode 'shadow' or 'on'; in 'off' nothing here changes). Latchel often
// delivers a Job/created and a Job/updated for the same job seconds apart,
// and the block adds a moment between the "already sent?" look-up and the
// send (a possible Latchel lookup). That would widen the small, documented
// window in which two deliveries both pass the dedup check and both send (see
// the ATOMICITY note in this file's header). A job already being handled in
// this process is skipped instead; if that attempt fails, the row is
// 'failed' and the next delivery or backstop pass retries it as usual.
//
// EXPIRY: an entry older than IN_FLIGHT_MAX_AGE_MS is ignored and
// overwritten, so one hung send can never block later deliveries of that job
// for good. Each entry carries a token, and the finally block removes the
// entry only if its token is still the one it wrote, so a stale run that
// finally returns cannot delete a newer run's entry. Expired entries are
// pruned on every guarded call, which keeps the map bounded.
const IN_FLIGHT_MAX_AGE_MS = 5 * 60 * 1000;
const inFlightJobs = new Map();   // jobId -> { token, startedAtMs }
// A monotonic clock (milliseconds since an arbitrary start), NOT the wall
// clock: if the system clock is stepped back, a stuck entry must still expire
// after 5 real minutes.
const monotonicNowMs = () => Number(process.hrtime.bigint()) / 1e6;
let nowMs = monotonicNowMs;
let flightCounter = 0;

function pruneInFlight(t) {
  for (const [k, v] of inFlightJobs) {
    if (t - v.startedAtMs > IN_FLIGHT_MAX_AGE_MS) inFlightJobs.delete(k);
  }
}

async function handleWorkOrderJob(job, triggerSource) {
  const jobId = job && (job.job_id != null ? job.job_id : job.id);
  const active = descriptionMode() !== 'off';
  const guardKey = (active && jobId != null) ? String(jobId) : null;
  let token = null;
  if (guardKey) {
    const t = nowMs();
    const existing = inFlightJobs.get(guardKey);
    if (existing) {
      if (t - existing.startedAtMs <= IN_FLIGHT_MAX_AGE_MS) {
        console.log(`[work-order-notes-alert] job ${guardKey}: another delivery is already being handled, skipping (${triggerSource}).`);
        return { action: 'already_sent', in_flight: true };
      }
      console.warn('[work-order-notes-alert] An old in-flight entry was ignored (older than 5 minutes).');
    }
    pruneInFlight(t);
    flightCounter += 1;
    token = flightCounter;
    inFlightJobs.set(guardKey, { token, startedAtMs: t });
  }
  try {
    return await processJob(job, triggerSource);
  } catch (err) {
    if (!active) {
      console.error(`[work-order-notes-alert] unexpected error handling job ${jobId}:`, err.message);
      return { action: 'error', error: err.message };
    }
    // While the description block is active an error message could carry job
    // text, so only the error's class name (not its message) is recorded.
    const kind = (err && typeof err.name === 'string' && /^[A-Za-z]{1,40}$/.test(err.name)) ? err.name : 'Error';
    console.error(`[work-order-notes-alert] unexpected error handling job ${jobId} (${kind}); details withheld.`);
    return { action: 'error', error: 'unexpected_error' };
  } finally {
    if (guardKey) {
      const cur = inFlightJobs.get(guardKey);
      if (cur && cur.token === token) inFlightJobs.delete(guardKey);
    }
  }
}

// ─── Backstop reconciliation (spec Section 2.4) ────────────────────────
// Called by the new POST /internal/reconcile-work-order-notes route.
// Sequential, not parallel — same "internal cron call, not a delivery
// something is waiting to ack" reasoning approval-briefing's own
// /internal/reconcile route already gives for awaiting gatherInBackground
// in its own loop.
async function reconcileWorkOrderNotes() {
  const since = isoDaysAgo(RECONCILE_LOOKBACK_DAYS);
  const jobs = await latchel.listJobsUpdatedSince(since);
  const summary = { jobs_seen: jobs.length, sent: 0, already_sent: 0, discarded: 0, failed: 0, errors: 0 };

  for (const job of jobs) {
    const result = await handleWorkOrderJob(job, 'reconciliation_poll');
    if (result.action === 'sent') summary.sent++;
    else if (result.action === 'already_sent') summary.already_sent++;
    else if (result.action === 'discarded' || result.action === 'skipped') summary.discarded++;
    else if (result.action === 'failed') summary.failed++;
    else summary.errors++;
  }

  return summary;
}

module.exports = {
  handleWorkOrderJob,
  reconcileWorkOrderNotes,
  // test seam: a fake clock for the in-flight expiry tests
  _setClockForTesting(fn) { nowMs = typeof fn === 'function' ? fn : monotonicNowMs; },
  _inFlightSizeForTesting() { return inFlightJobs.size; },
};
