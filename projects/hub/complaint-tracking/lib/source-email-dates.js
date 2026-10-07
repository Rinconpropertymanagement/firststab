'use strict';

/**
 * lib/source-email-dates.js
 *
 * Read-only helper for the Complaint Tracking list endpoints. For every
 * complaint that came from an email thread (complaints.source_missive_
 * conversation_id), looks up the date of the FIRST and the LAST message in
 * that thread (missive_message_intake.delivered_at) so the dashboard can
 * list items in the order the emails actually arrived, not the order the
 * AI happened to log them.
 *
 * Adds exactly two fields to each complaint object, and nothing else:
 *   source_email_first_at  ISO string, or null
 *   source_email_last_at   ISO string, or null
 * Both are null for a complaint with no source thread (a manual "Report an
 * Issue"), for a thread with no dated messages on file, and whenever the
 * lookup fails. Nothing is written anywhere and no new data is stored.
 *
 * Privacy: the query selects the conversation id and the delivery
 * timestamp only. It never selects subject, body or addresses, so no email
 * content passes through this helper, and nothing it logs contains any.
 *
 * Fail soft: attach() never throws. A failed or slow lookup leaves the
 * affected rows with null dates and the list loads exactly as it did
 * before this helper existed.
 */

// The ONLY columns this helper ever asks for. Kept as one constant so the
// tests can prove no content column is ever requested.
const SELECT_COLUMNS = 'missive_conversation_id, delivered_at';

const DEFAULTS = {
  chunkSize: 80, // conversation ids per query — keeps the request URL short
  rowCap: 1000, // PostgREST returns at most this many rows per request
  concurrency: 6, // chunks in flight at once
  ttlMs: 5 * 60 * 1000, // how long a looked-up thread date is reused
  maxCacheEntries: 20000, // safety valve, far above ~3,000 complaints
  overallTimeoutMs: 10000, // give up (show rows without dates) after this long
};

function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function createSourceEmailDates({ supabase, now = Date.now, ...options } = {}) {
  if (!supabase) throw new Error('createSourceEmailDates: a supabase client is required.');
  const cfg = { ...DEFAULTS, ...options };
  const cache = new Map(); // conversation id -> { value: {first,last}|null, expiresAt }

  function remember(id, value) {
    if (cache.size >= cfg.maxCacheEntries) cache.clear();
    cache.set(id, { value, expiresAt: now() + cfg.ttlMs });
  }

  // One query for a list of conversation ids. Throws on a Supabase error.
  async function fetchRows(ids) {
    const { data, error } = await supabase
      .from('missive_message_intake')
      .select(SELECT_COLUMNS)
      .in('missive_conversation_id', ids);
    if (error) throw new Error(error.message || 'lookup failed');
    return data || [];
  }

  // Resolves one chunk of ids into `out` (and the cache). If the response
  // is as long as the row cap it may have been cut off, so the chunk is
  // split in half and retried; a single thread that alone fills the cap is
  // left undated rather than shown with a possibly wrong date.
  async function resolveChunk(ids, out, stats) {
    let rows;
    try {
      rows = await fetchRows(ids);
    } catch (err) {
      stats.failedIds += ids.length;
      console.error('[complaint-tracking] source-email date lookup failed for a batch (showing those rows without email dates):', err.message);
      return;
    }

    if (rows.length >= cfg.rowCap) {
      if (ids.length === 1) {
        stats.failedIds += 1;
        console.error('[complaint-tracking] source-email date lookup: one thread filled the row cap, leaving it without email dates');
        return;
      }
      const mid = Math.ceil(ids.length / 2);
      await resolveChunk(ids.slice(0, mid), out, stats);
      await resolveChunk(ids.slice(mid), out, stats);
      return;
    }

    const range = new Map(); // id -> { first, last } in ms
    for (const row of rows) {
      const ms = toMs(row.delivered_at);
      if (ms === null) continue;
      const cur = range.get(row.missive_conversation_id);
      if (!cur) range.set(row.missive_conversation_id, { first: ms, last: ms });
      else {
        if (ms < cur.first) cur.first = ms;
        if (ms > cur.last) cur.last = ms;
      }
    }
    for (const id of ids) {
      const r = range.get(id);
      const value = r ? { first: new Date(r.first).toISOString(), last: new Date(r.last).toISOString() } : null;
      out.set(id, value);
      remember(id, value);
    }
  }

  // Map of conversation id -> { first, last } | null. Ids that could not be
  // looked up (error, timeout) are simply absent from the map, and are not
  // cached, so the next call tries them again.
  async function lookup(conversationIds) {
    const out = new Map();
    const ids = [...new Set((conversationIds || []).filter((id) => typeof id === 'string' && id))];
    const t = now();
    const misses = [];
    for (const id of ids) {
      const hit = cache.get(id);
      if (hit && hit.expiresAt > t) out.set(id, hit.value);
      else misses.push(id);
    }
    if (!misses.length) return out;

    const chunks = [];
    for (let i = 0; i < misses.length; i += cfg.chunkSize) chunks.push(misses.slice(i, i + cfg.chunkSize));

    const stats = { failedIds: 0 };
    let cursor = 0;
    let gaveUp = false;
    const worker = async () => {
      while (!gaveUp && cursor < chunks.length) {
        const chunk = chunks[cursor];
        cursor += 1;
        await resolveChunk(chunk, out, stats);
      }
    };
    const workers = [];
    for (let i = 0; i < Math.min(cfg.concurrency, chunks.length); i += 1) workers.push(worker());

    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => { gaveUp = true; resolve('timeout'); }, cfg.overallTimeoutMs);
    });
    try {
      const outcome = await Promise.race([Promise.all(workers), timeout]);
      if (outcome === 'timeout') {
        console.error(`[complaint-tracking] source-email date lookup timed out after ${cfg.overallTimeoutMs} ms (showing the remaining rows without email dates)`);
      }
    } finally {
      clearTimeout(timer);
    }
    return out;
  }

  // Adds source_email_first_at / source_email_last_at to every row in place
  // and returns the same array. Never throws.
  async function attach(rows) {
    if (!Array.isArray(rows) || !rows.length) return rows;
    let dates = new Map();
    try {
      dates = await lookup(rows.map((r) => r.source_missive_conversation_id));
    } catch (err) {
      console.error('[complaint-tracking] source-email date lookup failed (showing rows without email dates):', err.message);
    }
    for (const row of rows) {
      const d = row.source_missive_conversation_id ? dates.get(row.source_missive_conversation_id) : null;
      row.source_email_first_at = d ? d.first : null;
      row.source_email_last_at = d ? d.last : null;
    }
    return rows;
  }

  return { lookup, attach, clearCache: () => cache.clear(), cacheSize: () => cache.size };
}

module.exports = { createSourceEmailDates, SELECT_COLUMNS, DEFAULTS };
