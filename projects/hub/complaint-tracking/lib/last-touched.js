'use strict';

/**
 * lib/last-touched.js
 *
 * Read-only helper behind "Last touched X ago by [name]" on the Complaint
 * Tracking list. For a list of complaint ids it finds, for each one, the
 * NEWEST audit_log row (that row says when and by whom the complaint was
 * last changed). router.js turns that row into the name shown on screen.
 *
 * Why it asks in batches: the whole list can be 1,000+ complaints. Sending
 * every id in one request puts ~37 KB of ids in the web address, the
 * database gateway refuses it ("Bad Request"), and the list then shows no
 * "last touched" at all. So the ids go out in chunks (100 per request, 5
 * requests at a time), the same pattern lib/source-email-dates.js uses.
 *
 * Correctness rule: each request is sorted newest-first and read page by
 * page (the database returns at most 1,000 rows per request), so the first
 * row seen for a complaint is its newest. A complaint is only ever given
 * that newest row. If a chunk cannot be read completely (any of its
 * requests fails) NONE of that chunk's results are used, so its complaints
 * simply show no "last touched" rather than risk showing an older one. A
 * complaint the page limit never reached is likewise left out, never given
 * an older row.
 *
 * Time limit: the whole lookup has an overall deadline (10 s by default,
 * which also bounds the database client's own retries of a failing request).
 * When it passes, no new chunk or page is started, and any chunk that has
 * not completely finished is thrown away whole; chunks that did finish keep
 * their rows. Nothing that arrives after the deadline is added to the result.
 *
 * Fail soft: findLatestAuditRows() never throws. Other chunks are
 * unaffected by a failed one. It writes at most ONE log line per call, made
 * of counts and short fixed descriptions only: never complaint ids, complaint
 * text, or an error's own message (a malformed answer arrives as the raw
 * response body in that message).
 *
 * Reads only audit_log's entity_id, actor_type, actor_id and created_at
 * (plus sequence_num for ordering). Nothing is written anywhere.
 */

// Columns returned to the caller. sequence_num is not selected: it is used
// only to order, below.
const SELECT_COLUMNS = 'entity_id, actor_type, actor_id, created_at';

const DEFAULTS = {
  chunkSize: 100, // complaint ids per request: 100 x 37 chars keeps the address ~4 KB
  pageSize: 1000, // PostgREST returns at most this many rows per request
  maxPages: 10, // per chunk: safety valve against paging through endless history
  concurrency: 5, // chunks in flight at once
  overallTimeoutMs: 10000, // give up (rows shown without it) after this long, retries included
};

// A failed lookup whose message is already safe to log (see failureText).
class LookupFailure extends Error {}

// A piece of an error (its name or code) that is safe to print: letters,
// digits and underscore, at most 24 characters. Anything else is dropped.
function token(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_]{1,24}$/.test(value) ? value : '';
}

// Short fixed description plus the error's name, code and HTTP status. It
// never includes the error's message: a malformed answer arrives with the
// raw response body as its message, and that can hold complaint ids or text.
function failureText(kind, err, status) {
  const bits = [];
  if (Number.isInteger(status) && status >= 100 && status <= 599) bits.push(`HTTP ${status}`);
  const name = token(err && err.name);
  if (name && name !== 'Error') bits.push(name);
  const code = token(err && err.code);
  if (code) bits.push(code);
  return bits.length ? `${kind} (${bits.join(' ')})` : kind;
}

async function fetchPage(supabase, ids, from, pageSize, signal) {
  // created_at alone is not unique (rows written in one statement share it),
  // and paging over ties can skip or repeat a row between pages. The
  // hash-chain sequence_num is unique and rises with every insert, so the
  // order is total and a later page can never hold a newer row than an
  // earlier one.
  let query = supabase
    .from('audit_log')
    .select(SELECT_COLUMNS)
    .eq('entity_type', 'complaint')
    .in('entity_id', ids)
    .order('created_at', { ascending: false })
    .order('sequence_num', { ascending: false })
    .range(from, from + pageSize - 1);
  // Once the lookup gives up this drops the request, and the client's retries of it.
  if (signal && typeof query.abortSignal === 'function') query = query.abortSignal(signal);
  const { data, error, status } = await query;
  if (error) {
    // A 2xx answer that still carries an error is a body that could not be read.
    const kind = status >= 200 && status < 300 ? 'unreadable answer' : (status > 0 ? 'database error' : 'request failed');
    throw new LookupFailure(failureText(kind, error, status));
  }
  if (data === null || data === undefined) return [];
  if (!Array.isArray(data)) throw new LookupFailure('unexpected answer shape');
  return data;
}

// Newest audit row for every id in ONE chunk that could be reached, plus how
// many of its complaints the page limit stopped it from reaching. Throws if
// any request fails, so the caller can drop the whole chunk. If the deadline
// passes it stops early; the caller discards what it returns.
async function resolveChunk(supabase, ids, cfg, signal) {
  const wanted = new Set(ids);
  const found = new Map();
  let reachedEnd = false;
  for (let page = 0; page < cfg.maxPages && found.size < wanted.size && !signal.aborted; page += 1) {
    const rows = await fetchPage(supabase, ids, page * cfg.pageSize, cfg.pageSize, signal);
    for (const row of rows) {
      if (!row || !wanted.has(row.entity_id) || found.has(row.entity_id)) continue;
      found.set(row.entity_id, row);
    }
    if (rows.length < cfg.pageSize) { reachedEnd = true; break; }
  }
  return { found, missedByLimit: reachedEnd ? 0 : wanted.size - found.size };
}

// The one log line for a lookup, or null when nothing went wrong.
function summaryLine(stats, cfg) {
  const parts = [];
  if (stats.timedOut) {
    const notFinished = stats.total - stats.finished - stats.failed;
    parts.push(`time limit of ${cfg.overallTimeoutMs} ms reached with ${stats.finished} of ${stats.total} batch(es) finished (${notFinished} left out)`);
  }
  if (stats.failed) {
    const top = [...stats.reasons].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason, n]) => `${reason} x${n}`).join(', ');
    parts.push(`${stats.failed} of ${stats.total} batch(es) failed (${top})`);
  }
  if (stats.limitBatches) {
    parts.push(`page limit hit in ${stats.limitBatches} batch(es), at most ${stats.limitMissed} complaint(s) there are shown without it because of that (the count includes any with no history at all)`);
  }
  return parts.length ? `[complaint-tracking] last-touched lookup: ${parts.join('; ')}; the rows affected are shown without it` : null;
}

// Map of complaint id -> its newest audit_log row. A complaint with no row,
// or in a chunk that failed or did not finish in time, is simply absent from
// the map.
async function findLatestAuditRows(supabase, complaintIds, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const out = new Map();
  const ids = [...new Set((complaintIds || []).filter((id) => typeof id === 'string' && id))];
  if (!ids.length) return out;

  const chunks = [];
  for (let i = 0; i < ids.length; i += cfg.chunkSize) chunks.push(ids.slice(i, i + cfg.chunkSize));

  const stats = { total: chunks.length, finished: 0, failed: 0, reasons: new Map(), limitBatches: 0, limitMissed: 0, timedOut: false };
  // Aborted when the deadline passes. From that moment on a chunk that is still
  // running can no longer change `out` or `stats`, whenever it finishes.
  const stop = new AbortController();
  let cursor = 0;
  const worker = async () => {
    while (cursor < chunks.length) {
      const chunk = chunks[cursor];
      cursor += 1;
      try {
        const { found, missedByLimit } = await resolveChunk(supabase, chunk, cfg, stop.signal);
        // Past the deadline: drop this batch whole and start no further one.
        if (stop.signal.aborted) return;
        for (const [id, row] of found) out.set(id, row);
        stats.finished += 1;
        if (missedByLimit) { stats.limitBatches += 1; stats.limitMissed += missedByLimit; }
      } catch (err) {
        if (stop.signal.aborted) return;
        stats.failed += 1;
        const reason = (err instanceof LookupFailure ? err.message : failureText('request failed', err)).slice(0, 80);
        stats.reasons.set(reason, (stats.reasons.get(reason) || 0) + 1);
      }
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(cfg.concurrency, chunks.length); i += 1) workers.push(worker());

  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => { stop.abort(); resolve(); }, cfg.overallTimeoutMs);
  });
  try {
    await Promise.race([Promise.all(workers), deadline]);
  } finally {
    clearTimeout(timer);
  }
  stats.timedOut = stop.signal.aborted;

  const line = summaryLine(stats, cfg);
  if (line) console.error(line);
  return out;
}

module.exports = { findLatestAuditRows, SELECT_COLUMNS, DEFAULTS };
