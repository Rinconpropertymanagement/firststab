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
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

const missive = require('./lib/missive-connector');

// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are already required, hard-checked
// env vars for this Hub process (maintenance-history/router.js, loaded
// earlier in server.js, exits the process if either is missing) — not
// re-checked here to avoid a second, redundant startup guard for the same
// two variables. MISSIVE_API_TOKEN is checked lazily, inside
// missive-connector.js, the same reasoning latchel-connector.js gives for
// LATCHEL_API_KEY: a missing Missive credential should only fail the one
// route that needs it, not take down the whole Hub.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Scope lock — Asimov's governance precheck, Finding 5 ────────────────
// "The two team IDs approved for this build (Faria, Solimar) must be
// hardcoded/allowlisted constants in the connector code, checked before any
// message body is fetched (not just before storage) — fail closed on
// anything outside the allowlist. Any expansion... requires a fresh Asimov
// and Mason pass before deployment — not a config edit." Matches the values
// named in the migration's own SCOPE LOCK section.
const MISSIVE_ALLOWED_TEAM_IDS = [
  'b56138a6-f464-43db-a861-9bd79b07c8df', // Faria
  'ab0d3661-fb4c-498c-a311-94c6978530d6', // Solimar
];

// Governance requirement, enforced in code, not just by which values this
// file happens to loop over today: throws if a caller ever tries to fetch a
// message body for a team ID outside the allowlist above. Called from
// syncConversationMessages() immediately before the one call in this file
// that fetches a full message body (missive.getMessage()) — not only before
// the storeMessage() write further down. Every call site today passes a
// teamId that already came from iterating MISSIVE_ALLOWED_TEAM_IDS itself,
// so this should never actually throw in current code — it exists as
// defense-in-depth against a future refactor that widens how conversations
// get discovered (e.g. an "all teams" listing) without updating this check,
// which is exactly the scope-creep scenario Asimov's finding is guarding
// against.
function assertAllowedTeam(teamId, context) {
  if (!MISSIVE_ALLOWED_TEAM_IDS.includes(teamId)) {
    throw new Error(
      `Refusing to fetch ${context} — team ID ${teamId} is not in MISSIVE_ALLOWED_TEAM_IDS. ` +
      'Expanding this connector\'s scope requires a fresh Asimov/Mason governance review, not a code edit.'
    );
  }
}

// ─── Bounded-pagination backstops — plan Section 2.3, step 3: "page
// backward... until reaching the previous watermark or a sane backstop...
// rather than looping forever," same discipline as latchel-connector.js's
// getAllPages({ maxPages }). 10 pages x 50/page = 500 conversations per
// mailbox per run; 5 pages x 10/page = 50 messages per conversation.
const MAX_CONVERSATION_PAGES_PER_RUN = 10;
const MAX_MESSAGE_PAGES_PER_CONVERSATION = 5;

// Cap applied to body_html ONLY at parse time (see htmlToPlainText below) —
// never before the verbatim missive_message_intake.body_html write itself.
// 2MB of HTML is already an enormous single email; this exists to bound
// cheerio's parse cost against a pathological or adversarial document, per
// the build task's explicit "cap body_html size before parsing" instruction.
const MAX_HTML_CHARS_TO_PARSE = 2_000_000;

// ─── Missive timestamp handling ──────────────────────────────────────────
// Oracle's connection plan verified every field name Missive's docs
// document (last_activity_at, delivered_at, etc.) but never pinned down
// whether those values come back as Unix seconds or ISO-8601 strings — a
// real, flagged unknown (see missive-connector.js's own header note #3/#4
// for the same category of caveat). Handled defensively here rather than
// assumed: accepts either shape. FLAG FOR REAL-DATA VERIFICATION: confirm
// against Peter's first manual trigger which shape Missive actually returns
// (a sanity check is one console.log of a raw conversation object away).
function missiveTimestampToMillis(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value; // seconds vs. already-ms
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}
function missiveTimestampToISO(value) {
  const ms = missiveTimestampToMillis(value);
  return ms == null ? null : new Date(ms).toISOString();
}

// ─── HTML → plain text (plan Section 3.5) ────────────────────────────────
// Static parsing only — cheerio parses a string into a DOM-like tree; it
// never executes scripts, never renders, and never makes a network request
// of its own, so this is safe to run against untrusted HTML by
// construction, not because of any option set here. Size-capped before
// parsing (see MAX_HTML_CHARS_TO_PARSE above), independent of whatever
// length body_html itself was stored at.
function htmlToPlainText(html) {
  const capped = html.length > MAX_HTML_CHARS_TO_PARSE ? html.slice(0, MAX_HTML_CHARS_TO_PARSE) : html;
  const $ = cheerio.load(capped);
  $('script, style').remove(); // never let their contents leak into extracted text

  // cheerio's .text() concatenates element boundaries with no whitespace of
  // its own — e.g. "<div>Hello</div><div>World</div>" collapses to
  // "HelloWorld", not "Hello World". Insert an explicit line break at every
  // block-ish boundary first so words that were visually separated in the
  // source HTML stay separated in the extracted text. This directly matters
  // for whatever future keyword filter eventually reads body_text (plan
  // Section 3.5's own flagged concern: "a keyword split across nested tags"
  // defeating a scan) — not exercised by this file itself, since this file
  // never calls that filter, but worth getting right at the source.
  $('br').replaceWith('\n');
  $('p, div, tr, li, h1, h2, h3, h4, h5, h6, blockquote').each((_, el) => {
    $(el).after('\n');
  });

  return $.root().text()
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── missive_sync_state helpers ───────────────────────────────────────────
async function getSyncState(mailboxKey) {
  const { data, error } = await supabase
    .from('missive_sync_state')
    .select('mailbox_key, last_synced_conversation_id, last_synced_activity_at')
    .eq('mailbox_key', mailboxKey)
    .maybeSingle();
  if (error) throw error;
  return data; // null on a mailbox's first-ever run
}

// Only ever writes the specific fields passed in `fields` — on conflict,
// every OTHER column keeps its previously stored value (Supabase upsert
// semantics), which is what lets the error path below record a failed run
// without touching a watermark it never actually advanced.
async function upsertSyncState(mailboxKey, fields) {
  const { error } = await supabase
    .from('missive_sync_state')
    .upsert({ mailbox_key: mailboxKey, ...fields }, { onConflict: 'mailbox_key' });
  if (error) throw error;
}

// ─── Storing one message ──────────────────────────────────────────────────
// Implements plan Section 2.3 steps 6-7 in order: verbatim write commits
// first (the actual "Rincon receives and stores" step), THEN the per-
// message audit_log row, THEN — only after both have committed — the
// body_text derivation. Returns the new/existing row's id.
async function storeMessage({ mailboxKey, conversationId, message }) {
  const bodyHtml = typeof message.body === 'string' ? message.body : null;

  // Step 6 — verbatim, untouched, before anything else. Upsert on
  // missive_message_id (the schema's own idempotency key) so a re-fetch of
  // an already-stored message after a crash mid-run is a safe no-op, not a
  // duplicate row (migration comment, plan Section 2.3 step 8).
  const { data: row, error: insertErr } = await supabase
    .from('missive_message_intake')
    .upsert({
      mailbox_key: mailboxKey,
      missive_conversation_id: String(conversationId),
      missive_message_id: String(message.id),
      email_message_id: message.email_message_id || null,
      subject: message.subject || null,
      from_address: (message.from_field && message.from_field.address) || null,
      to_addresses: message.to_fields || null,
      cc_addresses: message.cc_fields || null,
      bcc_addresses: message.bcc_fields || null,
      delivered_at: missiveTimestampToISO(message.delivered_at),
      body_html: bodyHtml,
    }, { onConflict: 'missive_message_id' })
    .select('id')
    .single();
  if (insertErr) throw insertErr;

  // Asimov's governance precheck, Finding 4 — one audit_log row PER
  // MESSAGE, in addition to (not instead of) the per-run summary row
  // further down. Direct insert, not a shared writeAuditLog() helper: this
  // codebase's existing writeAuditLog() (maintenance-history/router.js)
  // hardcodes actor_type: 'human', which is wrong here — this is a
  // system-triggered write with no human in the loop. Same direct-insert
  // pattern maintenance-history/router.js's safeTicketTitle() already uses
  // for its own actor_type: 'system' audit rows. Structural metadata only
  // in `details` — never body/subject/addresses, per the task's explicit
  // instruction and this table's own Rule 4 sensitivity classification.
  const { error: auditErr } = await supabase.from('audit_log').insert({
    action: 'missive_message_intake.stored',
    entity_type: 'missive_message',
    entity_id: row.id,
    actor_type: 'system',
    actor_id: 'email-intake-missive-sync',
    privacy_category: 'collection',
    risk_level: 'low',
    details: {
      mailbox_key: mailboxKey,
      missive_conversation_id: String(conversationId),
      pipeline_status: 'pending',
    },
  });
  if (auditErr) {
    console.error(`[email-intake] audit_log insert failed for missive_message_intake.stored (row ${row.id}):`, auditErr.message);
  }

  // Step 7 — only after the row above has committed. Never the only copy
  // kept; body_html remains the system of record (migration column
  // comment). A body_text failure here is logged and swallowed, not
  // rethrown — the row this message needed to land in (counsel's Section 5
  // requirement) already succeeded; a stalled plain-text derivation is a
  // lesser, recoverable problem, not a reason to fail the whole message.
  if (bodyHtml) {
    let bodyText;
    try {
      bodyText = htmlToPlainText(bodyHtml);
    } catch (err) {
      console.error(`[email-intake] HTML-to-text conversion failed for message row ${row.id}:`, err.message);
      return row.id;
    }
    const { error: updateErr } = await supabase
      .from('missive_message_intake')
      .update({ body_text: bodyText })
      .eq('id', row.id);
    if (updateErr) {
      console.error(`[email-intake] body_text update failed for message row ${row.id}:`, updateErr.message);
    }
  }

  return row.id;
}

// ─── Syncing one conversation's messages ─────────────────────────────────
// Per-thread "how far have we synced" is tracked implicitly by which
// missive_message_id values already exist for this conversation (plan
// Section 2.4 — "no separate column needed"), not a second bookkeeping
// table.
async function syncConversationMessages({ mailboxKey, teamId, conversationId }) {
  const { data: existingRows, error: existingErr } = await supabase
    .from('missive_message_intake')
    .select('missive_message_id')
    .eq('missive_conversation_id', String(conversationId));
  if (existingErr) throw existingErr;
  const existingIds = new Set((existingRows || []).map(r => r.missive_message_id));

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
  // task's instruction and this codebase's Rule 1 convention.
  const { error: auditErr } = await supabase.from('audit_log').insert({
    action: 'email_intake.missive_sync_run',
    entity_type: 'email_intake_sync_run',
    entity_id: crypto.randomUUID(), // no natural entity for a whole run — same convention as insurance/router.js's batch-import summary task (entity_id: crypto.randomUUID())
    actor_type: 'system',
    actor_id: 'email-intake-missive-sync',
    privacy_category: 'collection',
    risk_level: 'low',
    details: summary,
  });
  if (auditErr) {
    console.error('[email-intake] audit_log insert failed for email_intake.missive_sync_run:', auditErr.message);
  }

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
