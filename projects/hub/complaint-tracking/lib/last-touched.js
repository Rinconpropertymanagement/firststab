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
 * Fail soft: findLatestAuditRows() never throws. Other chunks are
 * unaffected by a failed one. Logs carry the error text and counts only,
 * never complaint ids or complaint text.
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
};

async function fetchPage(supabase, ids, from, pageSize) {
  // created_at alone is not unique (rows written in one statement share it),
  // and paging over ties can skip or repeat a row between pages. The
  // hash-chain sequence_num is unique and rises with every insert, so the
  // order is total and a later page can never hold a newer row than an
  // earlier one.
  const { data, error } = await supabase
    .from('audit_log')
    .select(SELECT_COLUMNS)
    .eq('entity_type', 'complaint')
    .in('entity_id', ids)
    .order('created_at', { ascending: false })
    .order('sequence_num', { ascending: false })
    .range(from, from + pageSize - 1);
  if (error) throw new Error(error.message || 'lookup failed');
  if (data === null || data === undefined) return [];
  if (!Array.isArray(data)) throw new Error('unexpected response shape');
  return data;
}

// Newest audit row for every id in ONE chunk that could be reached. Throws
// if any request fails, so the caller can drop the whole chunk.
async function resolveChunk(supabase, ids, cfg, stats) {
  const wanted = new Set(ids);
  const found = new Map();
  let reachedEnd = false;
  for (let page = 0; page < cfg.maxPages && found.size < wanted.size; page += 1) {
    const rows = await fetchPage(supabase, ids, page * cfg.pageSize, cfg.pageSize);
    for (const row of rows) {
      if (!row || !wanted.has(row.entity_id) || found.has(row.entity_id)) continue;
      found.set(row.entity_id, row);
    }
    if (rows.length < cfg.pageSize) { reachedEnd = true; break; }
  }
  if (!reachedEnd && found.size < wanted.size) stats.unreachedIds += wanted.size - found.size;
  return found;
}

// Map of complaint id -> its newest audit_log row. A complaint with no row,
// or in a chunk that failed, is simply absent from the map.
async function findLatestAuditRows(supabase, complaintIds, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const out = new Map();
  const ids = [...new Set((complaintIds || []).filter((id) => typeof id === 'string' && id))];
  if (!ids.length) return out;

  const chunks = [];
  for (let i = 0; i < ids.length; i += cfg.chunkSize) chunks.push(ids.slice(i, i + cfg.chunkSize));

  const stats = { failedChunks: 0, unreachedIds: 0 };
  let cursor = 0;
  const worker = async () => {
    while (cursor < chunks.length) {
      const chunk = chunks[cursor];
      cursor += 1;
      try {
        const found = await resolveChunk(supabase, chunk, cfg, stats);
        for (const [id, row] of found) out.set(id, row);
      } catch (err) {
        stats.failedChunks += 1;
        const reason = err && err.message ? err.message : 'lookup failed';
        console.error('[complaint-tracking] last-touched lookup failed for a batch (showing those rows without it):', reason);
      }
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(cfg.concurrency, chunks.length); i += 1) workers.push(worker());
  await Promise.all(workers);

  if (stats.unreachedIds) {
    console.error(`[complaint-tracking] last-touched lookup hit its page limit; ${stats.unreachedIds} row(s) shown without it`);
  }
  return out;
}

module.exports = { findLatestAuditRows, SELECT_COLUMNS, DEFAULTS };
