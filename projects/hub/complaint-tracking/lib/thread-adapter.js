/**
 * lib/thread-adapter.js
 * Maps a group of missive_message_intake rows (one conversation) into the
 * plain-object thread shape email-intake/lib/privilege-filter.js's
 * checkThread() expects — technical spec Design Decision 1:
 *
 *   { threadId, legalHoldTag, messages: [{ messageId, from, to, cc, bcc,
 *     subject, body, date }] }
 *
 * Column mapping (spec Design Decision 1, confirmed against the real
 * migration, 20260905020000_missive_shared_inbox_intake_schema.sql):
 *   from_address -> from, to_addresses/cc_addresses/bcc_addresses (JSONB,
 *   Missive's own {address,name} field shape per lib/shared.js's
 *   storeMessage) -> to/cc/bcc, subject -> subject, body_text -> body,
 *   missive_message_id -> messageId, delivered_at -> date.
 *
 * legalHoldTag (Layer 3 — a staff "Legal Hold" override) has no real,
 * populated data source today (Open Item 3) — Peter's explicit,
 * on-the-record 2026-09-10 decision was to proceed without building the
 * Missive-label wiring for v1, not just "until built." This stays `false`
 * unconditionally, matching that decision exactly, not a placeholder for
 * later.
 */

// Missive's own address-field shape is [{ address, name }, ...] (per
// email-intake/lib/shared.js's storeMessage, which writes message.to_fields
// etc. straight into the JSONB columns) — but this adapter accepts a plain
// string too, so it degrades gracefully if that shape ever changes upstream
// rather than silently dropping every participant.
function addressStringOf(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'object' && entry.address) return String(entry.address);
  return null;
}

function normalizeAddressList(value) {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.map(addressStringOf).filter(Boolean);
}

/**
 * @param {string} conversationId - missive_message_intake.missive_conversation_id
 * @param {object[]} rows - every missive_message_intake row for that conversation
 * @returns {{ threadId: string, legalHoldTag: boolean, messages: object[] }}
 */
function toThreadShape(conversationId, rows) {
  const sorted = [...(rows || [])].sort((a, b) => {
    const ta = a.delivered_at ? new Date(a.delivered_at).getTime() : 0;
    const tb = b.delivered_at ? new Date(b.delivered_at).getTime() : 0;
    return ta - tb;
  });

  return {
    threadId: conversationId,
    legalHoldTag: false, // Open Item 3 — Peter's explicit decision, see header comment above
    messages: sorted.map((r) => ({
      messageId: r.missive_message_id,
      from: addressStringOf(r.from_address) || r.from_address || null,
      to: normalizeAddressList(r.to_addresses),
      cc: normalizeAddressList(r.cc_addresses),
      bcc: normalizeAddressList(r.bcc_addresses),
      subject: r.subject || '',
      body: r.body_text || '',
      date: r.delivered_at,
    })),
  };
}

// Every participant address across every message in a thread, deduped —
// what both the held-only Layer 0 match and the non-held pipeline's own
// post-hold-check identity match (lib/subject-match.js) compare against
// tenants/owners/vendors.email.
function collectAllAddresses(thread) {
  const set = new Set();
  for (const m of thread.messages || []) {
    if (m.from) set.add(m.from);
    for (const a of m.to || []) set.add(a);
    for (const a of m.cc || []) set.add(a);
    for (const a of m.bcc || []) set.add(a);
  }
  return Array.from(set);
}

// Full thread text for checkClaim() (Design Decision 2) and the
// categorization prompt (Design Decision 6) — subject + body of every
// message, oldest first (toThreadShape already sorts), each message
// labeled by sender so the model (and the keyword scan) reads it as a real
// conversation rather than one undifferentiated blob.
function threadFullText(thread) {
  return (thread.messages || [])
    .map((m) => `From: ${m.from || '(unknown)'}\nDate: ${m.date || '(unknown)'}\nSubject: ${m.subject || '(none)'}\n\n${m.body || ''}`)
    .join('\n\n---\n\n');
}

// --- PROTOTYPE, added 2026-09-17 for cost-reduction validation ---
// threadFullText() above concatenates every message in a thread, which
// gets very expensive on the rare long-running threads (some real ones hit
// 50,000+ tokens, almost entirely from email reply-quoting). An earlier,
// smaller test tried reading just the LAST message's raw body (relying on
// email quote-nesting) and that was UNSAFE — it silently miscategorized a
// real Fair-Housing-relevant owner_instruction thread as legal_exposure,
// because raw reverse-order email quoting is genuinely harder for the
// model to parse than this pipeline's own clean reconstruction. A
// different small test — same clean chronological formatting
// threadFullText() already produces, just capped to the most recent N
// messages — passed 5/5 on a small sample and needs real-scale validation
// before it ships.
//
// threadFullTextBounded() below is that second approach, factored out as
// its own function so TARS can validate it independently. It is purely
// additive: threadFullText() above is completely untouched, this is not
// wired into significance-pass.js or any other real pipeline code, and no
// existing exported function's behavior changes. This is a disposable
// prototype awaiting TARS's real-data validation — not a shipped change.
//
// Deliberately duplicates threadFullText()'s own per-message template
// string (`From: ... Date: ... Subject: ...`) rather than having
// threadFullText() call out to a shared helper, so that editing this
// prototype can never change threadFullText()'s real, live output. The
// test suite (test/run-tests.js) proves the two stay byte-identical for
// shared messages rather than relying on that being true by inspection.
//
// @param {{ messages: object[] }} thread - the same thread shape
//   threadFullText() takes (i.e. toThreadShape()'s output)
// @param {number} maxMessages - keep at most this many of the most recent
//   messages; must be a positive integer
// @returns {string} byte-for-byte identical to threadFullText(thread) when
//   thread.messages.length <= maxMessages; otherwise the same per-message
//   formatting for only the most recent maxMessages messages, preceded by
//   an explicit marker stating how many earlier messages were omitted
function threadFullTextBounded(thread, maxMessages) {
  if (!Number.isInteger(maxMessages) || maxMessages <= 0) {
    throw new Error(`threadFullTextBounded: maxMessages must be a positive integer, got ${maxMessages}`);
  }

  const messages = thread.messages || [];
  if (messages.length <= maxMessages) {
    return threadFullText(thread);
  }

  const omittedCount = messages.length - maxMessages;
  const marker = `[${omittedCount} earlier message${omittedCount === 1 ? '' : 's'} omitted — thread continues below]`;
  const recentFormatted = messages
    .slice(-maxMessages)
    .map((m) => `From: ${m.from || '(unknown)'}\nDate: ${m.date || '(unknown)'}\nSubject: ${m.subject || '(none)'}\n\n${m.body || ''}`)
    .join('\n\n---\n\n');

  return `${marker}\n\n---\n\n${recentFormatted}`;
}

module.exports = { addressStringOf, normalizeAddressList, toThreadShape, collectAllAddresses, threadFullText, threadFullTextBounded };
