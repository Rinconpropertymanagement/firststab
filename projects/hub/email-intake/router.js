/**
 * email-intake/router.js
 * Missive shared-inbox connector — pulls messages from exactly two
 * allowlisted Team Inboxes into Rincon's own storage
 * (missive_message_intake), the concrete step that satisfies
 * compliance/owner-tenant-notes-outside-counsel-opinion.md Section 5's
 * required architecture: "Tenant sends communication → Rincon receives it →
 * it resides in Rincon's system → Rincon subsequently causes a contracted
 * processor to analyze Rincon's stored copy." This file is steps 1-3;
 * nothing here ever analyzes content.
 *
 * Design: projects/hub/email-intake/missive-connection-plan.md (Oracle) —
 * Section 2 ("The Pull Mechanism") is the spec this file implements.
 * Governance: compliance/missive-connector-governance-precheck.md (Asimov,
 * APPROVED WITH REQUIRED ADDITIONS, 2026-09-05) — every numbered required
 * addition in that document is implemented below; see the comment nearest
 * each one for exactly where.
 * Schema: supabase/migrations/20260905020000_missive_shared_inbox_intake_schema.sql
 * (Neo) — missive_sync_state, missive_message_intake. Read that file's own
 * header before touching either table; it documents several deliberate
 * omissions (no FK between the two tables, no CHECK on mailbox_key, etc.)
 * that are easy to "fix" by mistake without that context.
 *
 * REFACTOR (backfill build): the allowlist check (assertAllowedTeam), the
 * HTML-to-text conversion (htmlToPlainText), storeMessage, and the
 * missive_sync_state/audit_log helpers moved verbatim into
 * ./lib/shared.js, so the one-time historical backfill
 * (backfill-missive-history.js) can reuse them instead of carrying a second
 * copy that could drift from this one. No behavior change in this file —
 * see shared.js's own header for the full reasoning on what moved and why.
 *
 * ============================================================
 * SCOPE — READ BEFORE EXTENDING
 * ============================================================
 * - Exactly the two Team Inboxes in MISSIVE_ALLOWED_TEAM_IDS below (Faria,
 *   Solimar). Expanding this — a third mailbox, or the separate
 *   individual-staff-mailbox phase the connection plan's Section 6
 *   researches but does not approve — requires a fresh Asimov/Mason
 *   governance pass BEFORE any code changes, not a one-line edit to the
 *   array. See MISSIVE_ALLOWED_TEAM_IDS's own comment.
 * - No AI note-extraction. This file's job stops the moment a message is
 *   sitting verbatim in missive_message_intake with body_text derived.
 *   Nothing here reads that table back out, calls a model, or hands
 *   anything to the existing privilege/Fair-Housing filter
 *   (lib/index.js's processThread()) — that hookup is separate, not-yet-
 *   built work, per the migration's own "agents_with_access: NONE" note.
 * - No crontab registration. This route is callable (POST, with the
 *   x-cron-secret header) but nothing schedules it yet — Asimov's
 *   governance precheck (Finding 3) requires a 7-day monitored,
 *   manually-triggered period before Scotty wires up an unattended
 *   schedule. Peter triggers this by hand until that period is complete.
 * ============================================================
 */

const express = require('express');
const crypto = require('crypto');

const missive = require('./lib/missive-connector');
const {
  MISSIVE_ALLOWED_TEAM_IDS,
  assertAllowedTeam,
  missiveTimestampToMillis,
  missiveTimestampToISO,
  htmlToPlainText,
  getSyncState,
  upsertSyncState,
  getExistingMessageIds,
  writeAuditLog,
  storeMessage,
} = require('./lib/shared');

// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are already required, hard-checked
// env vars for this Hub process (maintenance-history/router.js, loaded
// earlier in server.js, exits the process if either is missing) — not
// re-checked here to avoid a second, redundant startup guard for the same
// two variables. MISSIVE_API_TOKEN is checked lazily, inside
// missive-connector.js, the same reasoning latchel-connector.js gives for
// LATCHEL_API_KEY: a missing Missive credential should only fail the one
// route that needs it, not take down the whole Hub. No local `supabase`
// client in this file anymore — every Supabase read/write this route makes
// now goes through lib/shared.js's own client (getSyncState/
// upsertSyncState/getExistingMessageIds/storeMessage/writeAuditLog).
//
// MISSIVE_ALLOWED_TEAM_IDS and assertAllowedTeam — the governance scope
// lock (Asimov's precheck, Finding 5) — now live in ./lib/shared.js, shared
// with backfill-missive-history.js. See that file's header for why.

// ─── Bounded-pagination backstops — plan Section 2.3, step 3: "page
// backward... until reaching the previous watermark or a sane backstop...
// rather than looping forever," same discipline as latchel-connector.js's
// getAllPages({ maxPages }). 10 pages x 50/page = 500 conversations per
// mailbox per run; 5 pages x 10/page = 50 messages per conversation.
const MAX_CONVERSATION_PAGES_PER_RUN = 10;
const MAX_MESSAGE_PAGES_PER_CONVERSATION = 5;

// ─── Syncing one conversation's messages ─────────────────────────────────
// Per-thread "how far have we synced" is tracked implicitly by which
// missive_message_id values already exist for this conversation (plan
// Section 2.4 — "no separate column needed"), not a second bookkeeping
// table.
async function syncConversationMessages({ mailboxKey, teamId, conversationId }) {
  const existingIds = await getExistingMessageIds(conversationId);

  let stored = 0;
  let until = null;

  for (let page = 0; page < MAX_MESSAGE_PAGES_PER_CONVERSATION; page++) {
    const messages = await missive.listConversationMessagesPage({ conversationId, until });
    if (!messages.length) break;

    for (const msg of messages) {
      if (existingIds.has(String(msg.id))) continue; // already stored — nothing new to fetch

      // Asimov's Finding 5, enforced at the exact point a body fetch is
      // about to happen — see assertAllowedTeam's own comment above for why
      // this is defense-in-depth rather than a check expected to fire today.
      try {
        assertAllowedTeam(teamId, `message ${msg.id} in conversation ${conversationId}`);
      } catch (err) {
        console.error(`[email-intake] ${err.message}`);
        continue; // fail closed: skip this one message, don't abort the run
      }

      let full;
      try {
        full = await missive.getMessage(msg.id);
      } catch (err) {
        console.error(`[email-intake] Missive message fetch failed for message ${msg.id}:`, err.message);
        continue;
      }

      try {
        await storeMessage({ mailboxKey, conversationId, message: full });
        stored++;
      } catch (err) {
        console.error(`[email-intake] Failed to store message ${msg.id} (conversation ${conversationId}):`, err.message);
      }
    }

    if (messages.length < 10) break; // last page for this conversation
    until = messages[messages.length - 1].delivered_at;
  }

  return stored;
}

// ─── Syncing one mailbox ──────────────────────────────────────────────────
// Implements plan Section 2.3 steps 1-3, 8: list conversations newest-
// first, stop paging once a conversation at or before the stored watermark
// is reached, bounded by MAX_CONVERSATION_PAGES_PER_RUN on a cold start or
// unusually large gap. Never throws — internal errors are caught, logged,
// and folded into the returned `errors` count, so one mailbox's problem
// can't take down the other mailbox's run (see runMissiveSync below) and a
// partial run still gets its watermark recorded for whatever it did
// complete.
async function syncMailbox(mailboxKey, teamId) {
  let conversationsSeen = 0;
  let messagesStored = 0;
  let errors = 0;
  let lastError = null;
  let newestConversationId = null;
  let newestActivityAt = null;

  // Everything that can fail — including getSyncState() itself — is inside
  // this one try block, not just the pagination loop, so a failure reading
  // the watermark (e.g. the table doesn't exist yet, a transient connection
  // error) still falls through to the upsertSyncState call below and gets a
  // real last_run_status/last_error recorded, instead of throwing out of
  // this function before any status could be written at all.
  try {
    const state = await getSyncState(mailboxKey);
    const watermarkActivityAt = state ? state.last_synced_activity_at : null;
    newestConversationId = state ? state.last_synced_conversation_id : null;
    newestActivityAt = watermarkActivityAt;

    let until = null;
    let stop = false;

    for (let page = 0; page < MAX_CONVERSATION_PAGES_PER_RUN && !stop; page++) {
      let conversations;
      try {
        conversations = await missive.listConversationsPage({ teamId, until });
      } catch (err) {
        console.error(`[email-intake] Missive conversations list failed for mailbox ${mailboxKey}:`, err.message);
        errors++;
        lastError = err.message;
        break;
      }
      if (!conversations.length) break;

      for (const conv of conversations) {
        // Stop condition (plan Section 2.3 step 2): once we reach a
        // conversation at or before the stored watermark, everything after
        // it on this newest-first page is older still and already known.
        if (watermarkActivityAt != null && conv.last_activity_at != null &&
            missiveTimestampToMillis(conv.last_activity_at) <= missiveTimestampToMillis(watermarkActivityAt)) {
          stop = true;
          break;
        }

        conversationsSeen++;
        // Missive sorts strictly newest-to-oldest with no ties re-ordering
        // (plan Section 1.3) — the very first conversation processed this
        // run (page 0, before any stop condition can fire) is therefore
        // unconditionally the newest this run has seen, and becomes the new
        // watermark.
        if (page === 0 && conversationsSeen === 1) {
          newestConversationId = String(conv.id);
          newestActivityAt = conv.last_activity_at;
        }

        try {
          messagesStored += await syncConversationMessages({ mailboxKey, teamId, conversationId: conv.id });
        } catch (err) {
          console.error(`[email-intake] Failed to sync conversation ${conv.id} (mailbox ${mailboxKey}):`, err.message);
          errors++;
          lastError = err.message;
          // Keep going — one bad conversation shouldn't abort the whole mailbox.
        }
      }

      if (conversations.length < 50) break; // last page
      until = conversations[conversations.length - 1].last_activity_at;
    }
  } catch (err) {
    console.error(`[email-intake] Unexpected failure syncing mailbox ${mailboxKey}:`, err.message);
    errors++;
    lastError = err.message;
  }

  const status = errors === 0 ? 'ok' : (conversationsSeen > 0 || messagesStored > 0 ? 'partial' : 'error');
  try {
    await upsertSyncState(mailboxKey, {
      last_synced_conversation_id: newestConversationId,
      last_synced_activity_at: missiveTimestampToISO(newestActivityAt) || newestActivityAt,
      last_run_at: new Date().toISOString(),
      last_run_status: status,
      last_error: lastError,
    });
  } catch (err) {
    console.error(`[email-intake] Failed to record sync state for mailbox ${mailboxKey}:`, err.message);
    errors++;
  }

  return { conversationsSeen, messagesStored, errors };
}

// ─── One full run, across every allowlisted mailbox ──────────────────────
async function runMissiveSync() {
  const summary = { mailboxes_checked: 0, conversations_seen: 0, messages_stored: 0, errors: 0 };

  for (const teamId of MISSIVE_ALLOWED_TEAM_IDS) {
    assertAllowedTeam(teamId, `mailbox team:${teamId}`); // structurally always true — see assertAllowedTeam's own comment
    const mailboxKey = `team:${teamId}`;
    summary.mailboxes_checked++;
    try {
      const result = await syncMailbox(mailboxKey, teamId);
      summary.conversations_seen += result.conversationsSeen;
      summary.messages_stored += result.messagesStored;
      summary.errors += result.errors;
    } catch (err) {
      // syncMailbox is written to never throw (see its own comment) — this
      // catch exists only as a last-resort safety net so a truly unexpected
      // failure for one mailbox still lets the other mailbox's loop iteration
      // run.
      console.error(`[email-intake] Unexpected failure syncing mailbox ${mailboxKey}:`, err.message);
      summary.errors++;
    }
  }

  // Asimov's Finding 4 — the per-run summary row, IN ADDITION TO the
  // per-message rows above, not instead of them. Counts only, per the
  // task's instruction and this codebase's Rule 1 convention. Uses
  // lib/shared.js's writeAuditLog now (logs+swallows its own error
  // internally, same as the direct-insert version this replaced).
  await writeAuditLog({
    action: 'email_intake.missive_sync_run',
    entity_type: 'email_intake_sync_run',
    entity_id: crypto.randomUUID(), // no natural entity for a whole run — same convention as insurance/router.js's batch-import summary task (entity_id: crypto.randomUUID())
    actor_id: 'email-intake-missive-sync',
    privacy_category: 'collection',
    risk_level: 'low',
    details: summary,
  });

  return summary;
}

// ─── internalRouter: no login required — own shared-secret check ────────
// Same checkCronSecret/x-cron-secret/CRON_SECRET pattern as every other
// tool's internal router in this Hub (maintenance-history, security-deposit,
// insurance, call-stats, approval-briefing).
const internalRouter = express.Router();

// In-process overlap guard — identical reasoning to maintenance-history's
// maintenanceHistoryIngestRunning: the Hub runs as a single pm2 fork
// instance, so a module-level boolean is sufficient; set true right before
// work starts and always cleared in `finally` so a run that throws can never
// leave this stuck on.
let missiveSyncRunning = false;

function checkCronSecret(req, res) {
  const secret = req.headers['x-cron-secret'];
  if (!secret || secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/**
 * POST /api/email-intake/internal/sync-missive
 * Manually triggered only, per Asimov's governance precheck (Finding 3) —
 * a 7-day monitored period is required before this runs on an unattended
 * schedule. No crontab entry exists for this route; Peter calls it by hand
 * (curl, with the x-cron-secret header) until that period is complete.
 */
internalRouter.post('/api/email-intake/internal/sync-missive', async (req, res) => {
  if (!checkCronSecret(req, res)) return;
  const ts = new Date().toISOString();

  if (missiveSyncRunning) {
    console.log(`[${ts}] email-intake Missive sync: SKIPPED — a previous run is still in progress.`);
    return res.status(409).json({
      skipped: true,
      reason: 'already_running',
      message: 'A Missive sync run was already in progress; this run was skipped rather than starting a second concurrent sync.',
    });
  }

  missiveSyncRunning = true;
  try {
    const summary = await runMissiveSync();
    console.log(`[${ts}] email-intake Missive sync complete:`, summary);
    return res.json({ ok: true, ...summary });
  } catch (err) {
    console.error(`[${ts}] email-intake Missive sync failed:`, err.message);
    return res.status(500).json({ error: err.message });
  } finally {
    missiveSyncRunning = false;
  }
});

module.exports = { internalRouter, htmlToPlainText };
