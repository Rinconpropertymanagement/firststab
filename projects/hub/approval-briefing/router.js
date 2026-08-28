/**
 * projects/hub/approval-briefing/router.js
 *
 * Phase 2 (approval-briefing-SPEC.md Section 12) — the trigger layer only.
 * Per Asimov's re-confirmation addendum
 * (compliance/approval-briefing-spec-governance-precheck.md), this phase's
 * entire job is to prove "a real approval event reliably produces exactly
 * one tracked approval_briefings row." No gathering (Section 4), no AI
 * text, no risk assessment, no email — those are later phases, still
 * blocked on open items and not built here.
 *
 * Spec Section 3.6 step 4 is explicit that the initial insert this phase
 * performs writes ONLY latchel_job_id, trigger_reason, trigger_source, and
 * entered_needs_approval_at. Every other column on approval_briefings
 * (property linkage, estimate/max_cost, category, risk assessment, emails)
 * stays NULL until a later phase's gather step populates it.
 *
 * Two ways a job reaches this table, per spec Section 3:
 *   - Webhook (fast path, not guaranteed delivery — no retry/backoff
 *     documented anywhere in Latchel's docs across 3 official sources).
 *   - Hourly reconciliation poll (backstop, not fallback-only — spec
 *     Section 3.5).
 * Both funnel through the same idempotency rule (spec Section 3.4): an
 * existing approval_briefings row for the same latchel_job_id that hasn't
 * resolved yet means "already tracked," discard. The database enforces
 * this too (idx_approval_briefings_open_job, a partial unique index on
 * latchel_job_id WHERE resolved_at IS NULL) — this file's own check is the
 * first line of defense, the index is the backstop for the race between
 * webhook and poll firing close together.
 */

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const latchel = require('../maintenance-history/lib/latchel-connector');

const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CRON_SECRET'].filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`[approval-briefing] Missing environment variables: ${missing.join(', ')}`);
  console.error('[approval-briefing] Set these in the shared .env at the project root (see .env.example).');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const router = express.Router();

// ─── internalRouter: no login required — own shared-secret checks ─────────
const internalRouter = express.Router();

function timingSafeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function checkCronSecret(req, res) {
  const secret = req.headers['x-cron-secret'];
  const expected = process.env.CRON_SECRET;
  if (!timingSafeStringEqual(secret, expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/**
 * Spec Section 3.3: never trust the body's `secret` field alone — Latchel
 * has no IP allowlist and no cryptographic signature on this webhook, only
 * a shared token, so both copies of that token (the `x-api-key` header and
 * the JSON body's `secret` field) must independently match
 * LATCHEL_WEBHOOK_SECRET. Rejected attempts are logged to the plain app
 * log, not audit_log — spec Section 3.6 step 1 keeps that distinction:
 * audit_log is for real briefing events, not for probing traffic against a
 * public endpoint.
 */
function checkWebhookSecret(req, res) {
  const expected = process.env.LATCHEL_WEBHOOK_SECRET;
  if (!expected) {
    console.error('[approval-briefing] LATCHEL_WEBHOOK_SECRET is not set — rejecting all webhook deliveries. See .env.example.');
    res.status(503).json({ error: 'Webhook not configured.' });
    return false;
  }
  const headerKey = req.headers['x-api-key'];
  const bodySecret = req.body && req.body.secret;
  const ok = timingSafeStringEqual(headerKey, expected) && timingSafeStringEqual(bodySecret, expected);
  if (!ok) {
    console.warn(`[${new Date().toISOString()}] approval-briefing webhook: rejected delivery — secret mismatch (header present: ${!!headerKey}, body present: ${!!bodySecret}).`);
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/**
 * Spec Section 3.3: "rate-limit the endpoint." This is a public URL guarded
 * only by a shared token Latchel issues (no IP allowlist, no cryptographic
 * signature) — this limiter is defense-in-depth against a flood of
 * secret-guessing attempts, not the primary defense (the timing-safe
 * comparison in checkWebhookSecret is). 30/minute per IP is generous
 * headroom over real traffic (spec Section 3.2's live sample: a handful of
 * jobs entering approval per day, portfolio-wide) while still meaningfully
 * throttling brute-force attempts. Counts every request, including ones
 * that fail the secret check — that's the point.
 */
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests.',
});

/**
 * Spec Section 3.2: Latchel's two documented paths into state 27. A job
 * with no estimate yet is the "just created" path; a job with an estimate
 * above the vendor's authorized max is the "estimate came back too high"
 * path. trigger_reason is NOT NULL with only these two values, so a job
 * that's in state 27 but doesn't cleanly match the no-estimate case is
 * classified as the exceeds-authorization case by default — the two paths
 * are documented as exhaustive for this state (spec Section 3.2 live
 * verification, 4/10 + 6/10 sampled jobs).
 */
function classifyTriggerReason(estimate) {
  if (estimate === null || estimate === undefined) return 'new_job_no_estimate';
  return 'estimate_exceeds_authorization';
}

/**
 * spec Section 2.3: nullable, not always resolvable at insert time.
 * Prefers a timestamp already present on the job/webhook payload; falls
 * back to the job's own state-change history (the same history endpoint
 * Section 4 gathers from later) when nothing more direct is available.
 */
async function resolveEnteredNeedsApprovalAt(jobId, stateUpdatedAt) {
  if (stateUpdatedAt) return stateUpdatedAt;
  try {
    const history = await latchel.getJobStateHistory(jobId);
    const entries = (history || []).filter(h => h.state_id === 27 || h.state === 'Needs Approval' || h.state_name === 'Needs Approval');
    if (entries.length === 0) return null;
    entries.sort((a, b) => new Date(b.created_at || b.updated_at || 0) - new Date(a.created_at || a.updated_at || 0));
    return entries[0].created_at || entries[0].updated_at || null;
  } catch (err) {
    console.error(`[approval-briefing] Could not resolve entered_needs_approval_at for job ${jobId} from state history:`, err.message);
    return null;
  }
}

/**
 * Spec Section 3.4 idempotency, enforced here as the first line of defense
 * and backstopped at the database layer by idx_approval_briefings_open_job
 * (a partial unique index on latchel_job_id WHERE resolved_at IS NULL).
 * Returns true if a new row was inserted, false if one already existed.
 */
async function insertBriefingIfNew(latchelJobId, triggerReason, triggerSource, enteredNeedsApprovalAt) {
  const { data: existing, error: lookupError } = await supabase
    .from('approval_briefings')
    .select('id')
    .eq('latchel_job_id', latchelJobId)
    .is('resolved_at', null)
    .limit(1);
  if (lookupError) throw lookupError;
  if (existing && existing.length > 0) return false;

  const { error: insertError } = await supabase
    .from('approval_briefings')
    .insert({
      latchel_job_id: latchelJobId,
      trigger_reason: triggerReason,
      trigger_source: triggerSource,
      entered_needs_approval_at: enteredNeedsApprovalAt,
    });
  if (insertError) {
    // 23505 = unique_violation — the webhook and the poll raced each other
    // and the other one won. Not a failure, exactly the case
    // idx_approval_briefings_open_job exists to catch.
    if (insertError.code === '23505') return false;
    throw insertError;
  }
  return true;
}

/**
 * POST /api/approval-briefing/internal/webhook
 * Receives Latchel's Job/created and Job/updated deliveries (spec Section
 * 3.2 — two separate dashboard subscriptions, same URL). Filters down to
 * exactly the case this feature cares about: a Job object that has landed
 * in state 27 ("Needs Approval"). Everything else — non-Job objects (the
 * separate Invoice "Needs Approval" is explicitly out of scope), Jobs in
 * any other state — is discarded without action.
 */
internalRouter.post('/api/approval-briefing/internal/webhook', webhookLimiter, async (req, res) => {
  if (!checkWebhookSecret(req, res)) return;

  const ts = new Date().toISOString();
  const objectType = req.body && req.body.object_type;
  const job = req.body && req.body.object;

  if (objectType !== 'Job' || !job) {
    return res.status(200).json({ ok: true, action: 'discarded', reason: 'not_a_job' });
  }
  const stateId = job.state_id;
  const stateName = job.state_name || job.state;
  if (stateId !== 27 && stateName !== 'Needs Approval') {
    return res.status(200).json({ ok: true, action: 'discarded', reason: 'not_needs_approval' });
  }

  const jobId = String(job.job_id != null ? job.job_id : job.id);
  const triggerReason = classifyTriggerReason(job.estimate);

  try {
    const enteredAt = await resolveEnteredNeedsApprovalAt(jobId, job.state_updated_at);
    const inserted = await insertBriefingIfNew(jobId, triggerReason, 'webhook', enteredAt);
    console.log(`[${ts}] approval-briefing webhook: job ${jobId} — ${inserted ? 'tracked (new row)' : 'already tracked, discarded'}.`);
    return res.status(200).json({ ok: true, action: inserted ? 'tracked' : 'already_tracked', latchel_job_id: jobId });
  } catch (err) {
    console.error(`[${ts}] approval-briefing webhook: failed to process job ${jobId}:`, err.message);
    return res.status(500).json({ error: 'Failed to process webhook.', detail: err.message });
  }
});

/**
 * POST /api/approval-briefing/internal/reconcile
 * The hourly backstop poll (spec Section 3.5). Pulls every job Latchel
 * currently reports in state 27 and tracks any that don't already have an
 * open approval_briefings row. This is deliberately NOT the place that
 * detects a job leaving state 27 (Section 9's reminder/escalation and
 * resolved_at logic) — that's a later phase; today an open row simply
 * stays open until that phase exists.
 */
internalRouter.post('/api/approval-briefing/internal/reconcile', async (req, res) => {
  if (!checkCronSecret(req, res)) return;
  const ts = new Date().toISOString();

  let jobs;
  try {
    jobs = await latchel.listJobsNeedingApproval();
  } catch (err) {
    console.error(`[${ts}] approval-briefing reconcile: Latchel fetch failed:`, err.message);
    return res.status(502).json({ error: 'Failed to pull jobs from Latchel.', detail: err.message });
  }

  const summary = { jobs_seen: jobs.length, tracked: 0, already_tracked: 0, errors: [] };

  for (const job of jobs) {
    const jobId = String(job.job_id != null ? job.job_id : job.id);
    try {
      const triggerReason = classifyTriggerReason(job.estimate);
      const enteredAt = await resolveEnteredNeedsApprovalAt(jobId, job.state_updated_at);
      const inserted = await insertBriefingIfNew(jobId, triggerReason, 'reconciliation_poll', enteredAt);
      if (inserted) summary.tracked++; else summary.already_tracked++;
    } catch (err) {
      console.error(`[${ts}] approval-briefing reconcile: failed to process job ${jobId}:`, err.message);
      summary.errors.push({ latchel_job_id: jobId, error: err.message });
    }
  }

  console.log(`[${ts}] approval-briefing reconcile: ${JSON.stringify(summary)}`);
  return res.status(200).json({ ok: true, ...summary });
});

module.exports = { router, internalRouter };
