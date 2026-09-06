/**
 * email-intake/lib/shared.js
 * Pieces of the Missive shared-inbox connector that are genuinely shared
 * between the ongoing 15-minute incremental sync (router.js's
 * POST /api/email-intake/internal/sync-missive) and the one-time historical
 * backfill (backfill-missive-history.js) — extracted here, on the backfill
 * build, so both consumers import ONE implementation instead of two that
 * could silently drift apart. Everything in this file was moved verbatim
 * (no behavior change) out of router.js, which held all of it as internal,
 * non-exported functions before this build.
 *
 * What's here and why it's shared:
 *   - MISSIVE_ALLOWED_TEAM_IDS / assertAllowedTeam — the governance scope
 *     lock (Asimov's precheck, Finding 5). Both the incremental sync and the
 *     backfill fetch message bodies for the same two mailboxes and must
 *     enforce the exact same fail-closed check before every body fetch —
 *     two independent copies of an allowlist is exactly the kind of thing
 *     that quietly drifts (one gets updated, the other doesn't).
 *   - htmlToPlainText / missiveTimestampToMillis / missiveTimestampToISO —
 *     pure data-shape helpers with no reason to have two implementations.
 *   - getSyncState / upsertSyncState — generic, mailbox-keyed watermark
 *     read/write against missive_sync_state. Already fully generic in
 *     router.js before this move (mailboxKey was always passed in, never
 *     hardcoded) — the backfill reuses these AS-IS with its own
 *     'backfill:team:<id>' keys, which is exactly why moving them here
 *     needed zero logic changes. IMPORTANT: this table has ONE watermark
 *     semantics for the incremental job (newest conversation seen — where
 *     to STOP) and a DIFFERENT semantics for the backfill (oldest
 *     conversation reached — where to RESUME from). Same columns, same
 *     upsert mechanics, different meaning per mailbox_key namespace. Never
 *     read or write a 'team:<id>' key from the backfill, or a
 *     'backfill:team:<id>' key from the incremental job — see
 *     backfill-missive-history.js's own header for the full reasoning.
 *   - writeAuditLog — the common shape behind every audit_log row this
 *     connector writes (system actor, no human in the loop). storeMessage's
 *     per-message row and each caller's own per-run summary row both use
 *     it now instead of two separate inline .insert() calls.
 *   - storeMessage — the verbatim-write-then-audit-then-derive-body_text
 *     sequence (plan Section 2.3 steps 6-7). The single highest-value thing
 *     to never have two copies of: it's the literal "Rincon receives and
 *     stores" step the whole build exists to satisfy
 *     (compliance/owner-tenant-notes-outside-counsel-opinion.md Section 5).
 *
 * What stayed in router.js (deliberately NOT moved here): the incremental
 * job's bounded pagination (MAX_CONVERSATION_PAGES_PER_RUN,
 * MAX_MESSAGE_PAGES_PER_CONVERSATION), its watermark STOP condition, and
 * syncConversationMessages/syncMailbox/runMissiveSync themselves. Those are
 * "stop once caught up" logic, structurally the opposite of the backfill's
 * "page to the true beginning, ignoring any stop condition" logic — forcing
 * them into a shared function would mean one function trying to do two
 * incompatible things, which is worse than two short, purpose-built loops.
 */

const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

// Own Supabase client, same convention as missive-connector.js managing its
// own MISSIVE_API_TOKEN access and lib/property-search.js managing its own
// client — every connector/lib module in this codebase reads its own env
// vars rather than requiring a caller to thread a client through. Cheap to
// construct (a thin REST wrapper, not a persistent connection pool), so a
// second instance alongside a caller's own `supabase` const costs nothing
// real.
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
// named in the migration's own SCOPE LOCK section. UNCHANGED from router.js.
const MISSIVE_ALLOWED_TEAM_IDS = [
  'b56138a6-f464-43db-a861-9bd79b07c8df', // Faria
  'ab0d3661-fb4c-498c-a311-94c6978530d6', // Solimar
];

// Governance requirement, enforced in code: throws if a caller ever tries to
// fetch a message body for a team ID outside the allowlist above. Both
// router.js's syncConversationMessages and backfill-missive-history.js's own
// per-conversation message loop call this immediately before the one call
// that fetches a full message body (missive.getMessage()) — not only before
// the storeMessage() write further down.
function assertAllowedTeam(teamId, context) {
  if (!MISSIVE_ALLOWED_TEAM_IDS.includes(teamId)) {
    throw new Error(
      `Refusing to fetch ${context} — team ID ${teamId} is not in MISSIVE_ALLOWED_TEAM_IDS. ` +
      'Expanding this connector\'s scope requires a fresh Asimov/Mason governance review, not a code edit.'
    );
  }
}

// ─── Missive timestamp handling ──────────────────────────────────────────
// Oracle's connection plan verified every field name Missive's docs
// document but never pinned down whether values come back as Unix seconds
// or ISO-8601 strings. Handled defensively: accepts either shape.
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
// Cap applied to body_html ONLY at parse time — never before the verbatim
// missive_message_intake.body_html write itself.
const MAX_HTML_CHARS_TO_PARSE = 2_000_000;

function htmlToPlainText(html) {
  const capped = html.length > MAX_HTML_CHARS_TO_PARSE ? html.slice(0, MAX_HTML_CHARS_TO_PARSE) : html;
  const $ = cheerio.load(capped);
  $('script, style').remove(); // never let their contents leak into extracted text

  // cheerio's .text() concatenates element boundaries with no whitespace of
  // its own. Insert an explicit line break at every block-ish boundary first
  // so words that were visually separated in the source HTML stay separated
  // in the extracted text.
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
// Generic, mailbox-keyed — see file header for the two DIFFERENT watermark
// semantics ('team:<id>' vs 'backfill:team:<id>') that share this same
// CRUD shape without sharing meaning.
async function getSyncState(mailboxKey) {
  const { data, error } = await supabase
    .from('missive_sync_state')
    .select('mailbox_key, last_synced_conversation_id, last_synced_activity_at, last_run_at, last_run_status, last_error')
    .eq('mailbox_key', mailboxKey)
    .maybeSingle();
  if (error) throw error;
  return data; // null on a mailbox's first-ever run under this key
}

// Only ever writes the specific fields passed in `fields` — on conflict,
// every OTHER column keeps its previously stored value (Supabase upsert
// semantics).
async function upsertSyncState(mailboxKey, fields) {
  const { error } = await supabase
    .from('missive_sync_state')
    .upsert({ mailbox_key: mailboxKey, ...fields }, { onConflict: 'mailbox_key' });
  if (error) throw error;
}

// ─── Existing-message lookup for one conversation ────────────────────────
// Used by router.js's syncConversationMessages to know which messages in a
// conversation are already stored, so a conversation whose watermark makes
// it "still newest" on a later incremental run doesn't re-fetch (and
// re-bill an API call for) a message body it already has. Not used by the
// backfill's own per-conversation loop — see backfill-missive-history.js's
// header for why that loop doesn't need this same pre-check (each
// conversation is visited once during a monotonic backward walk, not
// revisited across runs the way "still newest activity" can make one be
// here).
async function getExistingMessageIds(conversationId) {
  const { data, error } = await supabase
    .from('missive_message_intake')
    .select('missive_message_id')
    .eq('missive_conversation_id', String(conversationId));
  if (error) throw error;
  return new Set((data || []).map(r => r.missive_message_id));
}

// ─── Audit log — system-actor, no human in the loop ──────────────────────
// Common shape behind every audit_log row this connector writes (the
// per-message row inside storeMessage below, and each caller's own per-run
// summary row). Direct insert, not this codebase's OTHER writeAuditLog()
// (maintenance-history/router.js), which hardcodes actor_type: 'human' —
// wrong here, since nothing in this connector has a human triggering it
// per-row. Non-fatal by design: logs and swallows an insert failure rather
// than throwing, matching both original call sites' behavior — an audit
// row failing to write is never a reason to fail (or retroactively
// invalidate) the actual data write it's describing.
async function writeAuditLog({ action, entity_type, entity_id, actor_id, privacy_category, risk_level, details }) {
  const { error } = await supabase.from('audit_log').insert({
    action,
    entity_type,
    entity_id,
    actor_type: 'system',
    actor_id,
    privacy_category,
    risk_level,
    details,
  });
  if (error) {
    console.error(`[email-intake] audit_log insert failed for ${action} (entity ${entity_id}):`, error.message);
  }
}

// ─── Storing one message ──────────────────────────────────────────────────
// Implements plan Section 2.3 steps 6-7 in order: verbatim write commits
// first (the actual "Rincon receives and stores" step), THEN the per-
// message audit_log row, THEN — only after both have committed — the
// body_text derivation. Returns the new/existing row's id. UNCHANGED
// behavior from router.js's original inline version — moved, not rewritten.
async function storeMessage({ mailboxKey, conversationId, message }) {
  const bodyHtml = typeof message.body === 'string' ? message.body : null;

  // Step 6 — verbatim, untouched, before anything else. Upsert on
  // missive_message_id (the schema's own idempotency key) so a re-fetch of
  // an already-stored message — after a crash mid-run, OR the backfill
  // encountering the same conversation twice at a page boundary — is a
  // safe no-op, not a duplicate row.
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
  // MESSAGE, in addition to (not instead of) each caller's own per-run
  // summary row. Structural metadata only in `details` — never body/
  // subject/addresses, per the task's explicit instruction and this
  // table's own Rule 4 sensitivity classification. `mailboxKey` here is
  // whichever namespace the caller passed in ('team:<id>' for the
  // incremental job, 'backfill:team:<id>' for the backfill) — this row is
  // simply recording which run stored the message, not a governance
  // distinction of its own.
  await writeAuditLog({
    action: 'missive_message_intake.stored',
    entity_type: 'missive_message',
    entity_id: row.id,
    actor_id: 'email-intake-missive-sync',
    privacy_category: 'collection',
    risk_level: 'low',
    details: {
      mailbox_key: mailboxKey,
      missive_conversation_id: String(conversationId),
      pipeline_status: 'pending',
    },
  });

  // Step 7 — only after the row above has committed. Never the only copy
  // kept; body_html remains the system of record. A body_text failure here
  // is logged and swallowed, not rethrown.
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

module.exports = {
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
};
