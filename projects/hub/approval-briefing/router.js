/**
 * projects/hub/approval-briefing/router.js
 *
 * Phase 2 (approval-briefing-SPEC.md Section 12) — the trigger layer —
 * PLUS Phase 3's gather step wired in as of this build (Section 3.6 step
 * 5: "Kick off the gather step... after a row is inserted"). Per
 * Asimov's re-confirmation addendum
 * (compliance/approval-briefing-spec-governance-precheck.md), Phase 2's
 * own job was to prove "a real approval event reliably produces exactly
 * one tracked approval_briefings row" — that part of this file is
 * unchanged. lib/gather.js now also covers Section 5 (Phase 4, this
 * build: the risk-assessment prompt, its unconditional content-check
 * gate, and the property-gated `claims` mirror) in addition to Section
 * 4.1/4.2/4.4 (Phase 3) — this router file itself needed no change for
 * that, since it already calls gatherApprovalBriefing() as one step.
 * Still NOT built here: Section 6 emergency matching + Section 7 cost
 * benchmark (Phase 5), Section 8 email generation (Phase 6) — later
 * phases.
 *
 * Spec Section 3.6 step 4 is explicit that the initial insert writes ONLY
 * latchel_job_id, trigger_reason, trigger_source, and
 * entered_needs_approval_at. Every other column on approval_briefings
 * (property linkage, estimate/max_cost, category, risk assessment, emails)
 * stays NULL until gatherInBackground() below (lib/gather.js) runs — which
 * happens right after a new row is inserted, not synchronously in the
 * same request/response cycle (see gatherInBackground()'s own comment for
 * why).
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
 *
 * ALSO AS OF THIS BUILD: Work Order Notes Alert (work-order-notes-alert-
 * SPEC.md), a second, independent feature riding the same webhook and the
 * same checkCronSecret()/CRON_SECRET pattern, per that spec's own
 * instruction to extend this endpoint rather than build a new,
 * separately-secured one. It does not touch, reorder, or depend on the
 * "Needs Approval" (state 27) logic described above — see the webhook
 * handler's own comment for exactly where its branch sits, and
 * lib/work-order-notes-alert.js for the feature itself. Its own backstop
 * poll lives at a new, separate route (POST .../internal/reconcile-work-
 * order-notes, below /internal/reconcile) rather than as a branch on the
 * existing reconcile route, because that route's own Latchel query
 * (state 27 only) is structurally different from this feature's
 * (updated-since a rolling window).
 */

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const latchel = require('../maintenance-history/lib/latchel-connector');
const { gatherApprovalBriefing } = require('./lib/gather');
const { handleWorkOrderJob, reconcileWorkOrderNotes } = require('./lib/work-order-notes-alert');

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
 * Returns { inserted: boolean, id: string|null } — id is the new row's id
 * when inserted is true (needed by callers to kick off the Phase 3 gather
 * step, spec Section 3.6 step 5), null otherwise.
 */
async function insertBriefingIfNew(latchelJobId, triggerReason, triggerSource, enteredNeedsApprovalAt) {
  const { data: existing, error: lookupError } = await supabase
    .from('approval_briefings')
    .select('id')
    .eq('latchel_job_id', latchelJobId)
    .is('resolved_at', null)
    .limit(1);
  if (lookupError) throw lookupError;
  if (existing && existing.length > 0) return { inserted: false, id: null };

  const { data: insertedRow, error: insertError } = await supabase
    .from('approval_briefings')
    .insert({
      latchel_job_id: latchelJobId,
      trigger_reason: triggerReason,
      trigger_source: triggerSource,
      entered_needs_approval_at: enteredNeedsApprovalAt,
    })
    .select('id')
    .single();
  if (insertError) {
    // 23505 = unique_violation — the webhook and the poll raced each other
    // and the other one won. Not a failure, exactly the case
    // idx_approval_briefings_open_job exists to catch.
    if (insertError.code === '23505') return { inserted: false, id: null };
    throw insertError;
  }
  return { inserted: true, id: insertedRow.id };
}

/**
 * Kicks off the Phase 3 gather step (spec Section 3.6 step 5, lib/gather.js)
 * for a newly-tracked row. Never lets a gather failure look like a webhook/
 * reconcile failure — this always resolves, logging any error itself. The
 * row stays valid and trackable (its Section 4.1 snapshot columns just stay
 * NULL) even if this fails; nothing downstream depends on gather succeeding
 * synchronously with insert, per Section 3.6's own "synchronously if fast
 * enough, otherwise queued... Q's call" latitude — real-data-measured
 * latency (this build, 2026-08-28) is ~1-2s on a warm per-process job-
 * window cache but up to ~40s on a cold one (a portfolio-wide 6-month
 * Latchel pull, no server-side per-property filter exists — spec Section
 * 4.2), so this is never awaited inline with a request a human or Latchel
 * is waiting on.
 */
async function gatherInBackground(briefingId, ts, source) {
  try {
    await gatherApprovalBriefing(supabase, briefingId);
    console.log(`[${ts}] approval-briefing ${source}: gather completed for briefing ${briefingId}.`);
  } catch (err) {
    console.error(`[${ts}] approval-briefing ${source}: gather FAILED for briefing ${briefingId} — row stays tracked with its Section 4 fields unpopulated until the next successful gather:`, err.message);
  }
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

  // Work Order Notes Alert — independent branch (work-order-notes-alert-
  // SPEC.md Section 2.1): "the parsed job object feeds two independent
  // branches... in either order, since neither reads or writes anything
  // the other touches." Deliberately runs on EVERY Job delivery, not just
  // ones reaching state 27 below — a brand-new work order (this feature's
  // whole trigger) will almost never be in "Needs Approval" yet. Fire-
  // and-forget, same reasoning as gatherInBackground further down: never
  // let this feature's own latency (a Layer 2 Claude call, a Supabase
  // write, an email send) or a failure inside it delay the webhook's ack
  // to Latchel or affect the approval-briefing logic that follows.
  // handleWorkOrderJob() never throws (see its own header), so this
  // .catch() is defense-in-depth, not a real expectation.
  handleWorkOrderJob(job, 'webhook').catch((err) => {
    console.error(`[${ts}] work-order-notes-alert webhook branch: unexpected error for job ${job.job_id}:`, err.message);
  });

  const stateId = job.state_id;
  const stateName = job.state_name || job.state;
  if (stateId !== 27 && stateName !== 'Needs Approval') {
    return res.status(200).json({ ok: true, action: 'discarded', reason: 'not_needs_approval' });
  }

  const jobId = String(job.job_id != null ? job.job_id : job.id);
  const triggerReason = classifyTriggerReason(job.estimate);

  try {
    const enteredAt = await resolveEnteredNeedsApprovalAt(jobId, job.state_updated_at);
    const { inserted, id } = await insertBriefingIfNew(jobId, triggerReason, 'webhook', enteredAt);
    console.log(`[${ts}] approval-briefing webhook: job ${jobId} — ${inserted ? 'tracked (new row)' : 'already tracked, discarded'}.`);
    // Fire-and-forget: Latchel's own delivery contract documents no
    // timeout it waits before treating this as a failed delivery (spec
    // Section 3.5 — no retry/backoff/timeout documented anywhere), but a
    // fast ack is still the responsible default for a public webhook
    // receiver. Never awaited inline with the response — see
    // gatherInBackground()'s own comment for the measured latency this is
    // avoiding blocking on.
    if (inserted) gatherInBackground(id, ts, 'webhook');
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
      const { inserted, id } = await insertBriefingIfNew(jobId, triggerReason, 'reconciliation_poll', enteredAt);
      if (inserted) {
        summary.tracked++;
        // Awaited (unlike the webhook path) — this is an internal cron
        // call, not a delivery Latchel is waiting to ack, and the
        // existing per-job loop here is already sequential. The
        // per-process job-window cache (lib/gather.js) means only the
        // first newly-tracked job in a given poll pays the full ~40s
        // Latchel pull; every other job gathered in the same poll run
        // reuses it (real-data-measured, this build: ~1-2s each).
        await gatherInBackground(id, ts, 'reconcile');
      } else {
        summary.already_tracked++;
      }
    } catch (err) {
      console.error(`[${ts}] approval-briefing reconcile: failed to process job ${jobId}:`, err.message);
      summary.errors.push({ latchel_job_id: jobId, error: err.message });
    }
  }

  console.log(`[${ts}] approval-briefing reconcile: ${JSON.stringify(summary)}`);
  return res.status(200).json({ ok: true, ...summary });
});

/**
 * POST /api/approval-briefing/internal/reconcile-work-order-notes
 * Work Order Notes Alert's own hourly backstop poll (work-order-notes-
 * alert-SPEC.md Section 2.4) — a separate route from /internal/reconcile
 * above because that one pulls a structurally different query
 * (listJobsNeedingApproval, state 27 only); this pulls
 * listJobsUpdatedSince() over a rolling lookback window and runs every
 * returned job through lib/work-order-notes-alert.js's resolve -> dedup
 * -> content-check -> send pipeline. Same checkCronSecret()/CRON_SECRET
 * auth as /internal/reconcile, reused exactly, not reinvented. Safe to
 * run repeatedly or on overlapping windows — the dedup/retry logic in
 * lib/work-order-notes-alert.js makes re-scanning a job already sent (or
 * one that still doesn't qualify) a guaranteed no-op.
 *
 * Actually scheduling this on a cron is Scotty's job, not built here —
 * see the build report to Jarvis.
 */
internalRouter.post('/api/approval-briefing/internal/reconcile-work-order-notes', async (req, res) => {
  if (!checkCronSecret(req, res)) return;
  const ts = new Date().toISOString();

  let summary;
  try {
    summary = await reconcileWorkOrderNotes();
  } catch (err) {
    console.error(`[${ts}] work-order-notes-alert reconcile: Latchel fetch failed:`, err.message);
    return res.status(502).json({ error: 'Failed to pull jobs from Latchel.', detail: err.message });
  }

  console.log(`[${ts}] work-order-notes-alert reconcile: ${JSON.stringify(summary)}`);
  return res.status(200).json({ ok: true, ...summary });
});

module.exports = { router, internalRouter };
