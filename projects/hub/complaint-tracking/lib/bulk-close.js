'use strict';

/**
 * lib/bulk-close.js
 *
 * "Close old items": clears the backlog of OLD, UNWORKED open complaints in one
 * request, with a preview first and an undo afterwards. Peter approved this
 * build on 2026-10-21 ("90 days, hold back the urgent ones"). Nothing here
 * deletes anything, sends anything or calls an AI, and there is no schema
 * change: a batch is identified by a tag "(batch <uuid>)" written into each
 * closed item's resolution_note, and by audit_log rows.
 *
 * One function decides who qualifies (decide() / classifyRows()), and the
 * preview and the real close both use it, so the number Peter confirms is
 * the set that gets closed. The real close recomputes the set from scratch
 * and refuses (409) if it no longer matches the count AND the set code
 * (set_hash) the person confirmed.
 *
 * RECORD FIRST: before any complaint is changed, a "bulk_close_started" audit
 * row is written (the settings, the counts and the set code that was approved,
 * nothing else). If it cannot be saved, nothing is changed. If the row WAS
 * saved but its answer was lost, the retry finds it and does not write it twice
 * (every audit insert that fails is checked against what the log really holds
 * before it is repeated). Recent batches is built from those start rows, so a batch
 * that stopped halfway is still listed and can be undone.
 *
 * WHO QUALIFIES (in this order; the first reason that applies is the one the
 * item is counted under, so the skip counts add up exactly):
 *   in scope  status 'open', not merged, not held, and in the Needs a Call or
 *             Flagged for Review lane exactly as the dashboard works it out
 *             (serverLaneOf() below mirrors the page's laneOf/triagePriority;
 *             a test pins the two together).
 *   manual_report                 a report a person typed in (source
 *                                 'manual_staff'): never closed in bulk.
 *   not_open_or_other             age unknown (no source thread, no dated
 *                                 message, or the lookup failed) or waiting
 *                                 on someone (blocked_since). Never closed.
 *   recent                        last email in the thread is NOT older than
 *                                 the cutoff (strictly older is required).
 *   fair_housing_flagged          flagged_protected_class, flagged_category,
 *                                 or an accommodation_related category.
 *                                 ALWAYS kept open: no request option can
 *                                 change this.
 *   urgent_held_back              severity_tier 'urgent' (a box Peter can untick).
 *   legal_held_back               category legal_exposure, or an owner
 *                                 instruction marked rejected / uncertain.
 *                                 Only when the "also hold back legal exposure"
 *                                 box is ticked. NOT held back by default:
 *                                 Peter overrode the review's advice on this on
 *                                 2026-10-22, in his own words, after being shown
 *                                 the numbers and the risk. Asimov records that
 *                                 override verbatim; the review's condition on
 *                                 this point is NOT met and is not to be
 *                                 described as met.
 *   recently_worked_or_delegated  delegated to someone, or the newest audit
 *                                 row (this feature's own close/undo rows do not
 *                                 count) is a person's action within 30 days,
 *                                 or that could not be checked (fails closed).
 *   kept_has_note                 already carries a resolution note: never
 *                                 overwritten, so it stays open.
 *   duplicate_pending             a duplicate suggestion awaiting a decision.
 *
 * The write is guarded again at the moment it happens: besides status, merge,
 * hold, delegation, note and the Fair Housing / urgent / legal rules, it also
 * re-checks blocked_since, a typed-in source and a pending duplicate, and an
 * item whose updated_at is newer than the read (it changed since) is left alone.
 * The fence is the newest updated_at that is not later than the moment of the
 * read, so one item stamped in the future cannot widen it for the others.
 *
 * Privacy: the complaint query never selects description or resolution_note
 * for the preview or the close (whether an open item has a note is found by
 * asking for the ids of the ones that do), and audit rows carry counts and ids
 * only. Nothing here logs a database error's own message.
 */

const crypto = require('crypto');
const { createSourceEmailDates } = require('./source-email-dates');
const { findLatestAuditRows } = require('./last-touched');

// ─── Settings ────────────────────────────────────────────────────────────
const DEFAULT_DAYS = 90;
const MIN_DAYS = 30;
const MAX_DAYS = 3650;
const BATCH_CAP = 2000; // most items one request may close
const WRITE_CHUNK = 80; // ids per update / audit insert (keeps request addresses short)
const RECENT_HUMAN_DAYS = 30; // a person touched it this recently -> leave it alone
const BATCH_LIST_LIMIT = 20;
const BATCH_LIST_CONCURRENCY = 3; // live "still closed" counts at once
const PAGE_SIZE = 1000; // PostgREST answers at most this many rows per request
const MAX_ROWS_READ = 100000; // safety valve for the paged read
const LOOKUP_TIMEOUT_MS = 25000; // for the email-date and last-touched lookups
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EXPECTED_COUNT = 10000000;
const BUSY_TIMEOUT_MS = 10 * 60 * 1000; // a close or undo that has made no progress for this long is treated as hung
const BATCHES_CACHE_MS = 2000; // Recent batches is worked out at most once in this long (a close or undo makes it fresh at once)
const PREVIEW_MIN_INTERVAL_MS = 1000; // one preview per person per second
const MULTI_ROW_FAILURES_BEFORE_SINGLE = 2; // after this many refused 80-row inserts, write one row at a time from the start
const SINGLE_FAILURES_BEFORE_GIVING_UP = 5; // this many one-row inserts failing in a row: the audit table is down, stop trying

const SKIP_REASONS = [
  'fair_housing_flagged', 'urgent_held_back', 'legal_held_back', 'recent', 'manual_report',
  'recently_worked_or_delegated', 'kept_has_note', 'duplicate_pending', 'not_open_or_other',
];
// legal_held_back only exists in an answer when that box is ticked.
const skipReasonsFor = (holdBackLegal) => SKIP_REASONS.filter((r) => r !== 'legal_held_back' || holdBackLegal);

// Fair Housing / protected-class signals: ALWAYS kept open, whatever the request says.
const FAIR_HOUSING_CATEGORIES = ['accommodation_related'];
// Legal-exposure signals: kept open only when Peter ticks the box.
const LEGAL_CATEGORIES = ['legal_exposure'];
const LEGAL_REJECTED_VALUES = ['true', 'uncertain'];

const ACTIONS = {
  batchStarted: 'complaint_tracking.bulk_close_started',
  itemClosed: 'complaint_tracking.bulk_closed',
  batchClosed: 'complaint_tracking.bulk_close_batch',
  itemReopened: 'complaint_tracking.bulk_close_undone',
  batchUndone: 'complaint_tracking.bulk_close_batch_undone',
};
// This feature's own per-item audit rows are not "a person worked on it".
const OWN_ITEM_ACTIONS = [ACTIONS.itemClosed, ACTIONS.itemReopened];
// audit_log needs an entity type and a UUID for every row; a batch row uses
// its own type so the per-complaint "last touched" lookups (which read
// entity_type 'complaint' only) never see it.
const BATCH_ENTITY_TYPE = 'complaint_bulk_close';

const NOTE_PREFIX = 'Closed in bulk:';
const NOTE_START = `${NOTE_PREFIX} no email activity for over `;

// The ONLY complaint columns read for the preview and the close. No
// description, no resolution_note.
const COMPLAINT_COLUMNS = [
  'id', 'status', 'merged_into_id', 'held_legal_fair_housing', 'source', 'needs_human_call',
  'escalation_signal', 'severity_tier', 'flagged_protected_class', 'flagged_category', 'category',
  'owner_instruction_rejected', 'delegated_to_team_member_id', 'duplicate_status', 'possible_duplicate_of_id',
  'blocked_since', 'source_missive_conversation_id', 'property_id', 'updated_at',
].join(', ');

function isValidUuid(str) {
  return typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// ─── Safe error text ─────────────────────────────────────────────────────
// A database error's own message can hold column values or the raw reply, so
// it is never logged or passed on. Only its name and code, cut down to plain
// letters, digits and underscore, are used.
function token(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_]{1,24}$/.test(value) ? value : '';
}
function safeErr(err) {
  const bits = [];
  const name = token(err && err.name);
  if (name && name !== 'Error') bits.push(name);
  const code = token(err && err.code !== undefined && err.code !== null ? String(err.code) : '');
  if (code) bits.push(code);
  return bits.length ? bits.join(' ') : 'error';
}
// An error whose message is already safe to log (fixed words plus a safe code).
class BulkCloseError extends Error {
  constructor(what, source) {
    super(`${what} (${safeErr(source)})`);
    this.name = 'BulkCloseError';
    this.safe = true;
  }
}
const dbError = (what, error) => new BulkCloseError(what, error);
const logLine = (text) => console.error(`[complaint-tracking] bulk close: ${text}`);

// ─── The lane rule (mirror of the dashboard's) ───────────────────────────
// dashboard/index.html triagePriority() and laneOf(), copied rule for rule.
// test/bulk-close-tests.js runs the page's own functions and this pair over
// the same table of rows and fails if they ever disagree.
function serverTriagePriority(c) {
  if (c.source === 'manual_staff' && c.needs_human_call) return 'call';
  if (c.severity_tier != null) {
    if (c.severity_tier === 'urgent') return 'call';
    if (c.severity_tier === 'worth_a_look') return 'flagged';
    if (c.severity_tier === 'just_a_record') return 'log';
    if (c.severity_tier === 'no_issue') return 'no_issue';
  }
  if (c.needs_human_call) return 'call';
  if (c.escalation_signal) return 'flagged';
  return 'log';
}

function serverLaneOf(c) {
  if (c.held_legal_fair_housing) return 'held';
  if (c.merged_into_id) return 'merged';
  if (c.status === 'resolved') return 'resolved';
  return serverTriagePriority(c);
}

function isInScope(row) {
  if (!row || row.status !== 'open') return false;
  const lane = serverLaneOf(row);
  return lane === 'call' || lane === 'flagged';
}

const isFairHousing = (row) => !!(row.flagged_protected_class || row.flagged_category || FAIR_HOUSING_CATEGORIES.includes(row.category));
const isLegalTagged = (row) => LEGAL_CATEGORIES.includes(row.category) || LEGAL_REJECTED_VALUES.includes(row.owner_instruction_rejected);

// ─── Input checks ────────────────────────────────────────────────────────
// fromQuery: values arrive as strings in a web address. Otherwise (a JSON
// body) they must already be the right type: a number, a boolean.
// Only the keys named here are read: anything else in a request is ignored,
// so there is no way to ask for the Fair Housing hold-back to be switched off.
function parseFlag(src, key, fallback, fromQuery) {
  if (src[key] === undefined) return { value: fallback };
  const raw = src[key];
  if (fromQuery) {
    if (raw !== 'true' && raw !== 'false') return { error: `${key} must be true or false.` };
    return { value: raw === 'true' };
  }
  if (typeof raw !== 'boolean') return { error: `${key} must be true or false.` };
  return { value: raw };
}

function parseOptions(input, { fromQuery = false } = {}) {
  const src = input || {};
  let days = DEFAULT_DAYS;
  if (src.older_than_days !== undefined) {
    const raw = src.older_than_days;
    if (fromQuery) {
      if (typeof raw !== 'string' || !/^\d{1,5}$/.test(raw)) return { error: daysError() };
      days = Number(raw);
    } else {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) return { error: daysError() };
      days = raw;
    }
  }
  if (days < MIN_DAYS || days > MAX_DAYS) return { error: daysError() };

  const urgent = parseFlag(src, 'hold_back_urgent', true, fromQuery);
  if (urgent.error) return { error: urgent.error };
  const legal = parseFlag(src, 'hold_back_legal', false, fromQuery);
  if (legal.error) return { error: legal.error };
  return { olderThanDays: days, holdBackUrgent: urgent.value, holdBackLegal: legal.value };
}
const daysError = () => `older_than_days must be a whole number between ${MIN_DAYS} and ${MAX_DAYS}.`;

// ─── The one eligibility function ────────────────────────────────────────
/**
 * Decides one row. Pure: everything it needs is in `ctx`.
 *   ctx.nowMs, ctx.olderThanDays, ctx.holdBackUrgent, ctx.holdBackLegal
 *   ctx.lastEmail      Map  conversation id -> last email time in ms, or null
 *                      when the thread has no dated message; an id that is
 *                      missing from the map could not be looked up.
 *   ctx.withNote       Set of ids of open items that already carry a
 *                      resolution note.
 *   ctx.latestAudit    Map  complaint id -> newest audit row (not counting this
 *                      feature's own), or null when the audit lookup has not
 *                      run yet (then a row that gets as far as needing it
 *                      answers { needsAudit: true }).
 *   ctx.auditUnverified  Set of ids whose audit history could not be checked.
 * Returns { inScope, eligible, reason, lastMs, needsAudit }.
 */
function decide(row, ctx) {
  const out = { inScope: false, eligible: false, reason: null, lastMs: null, needsAudit: false };
  if (!isInScope(row)) return out;
  out.inScope = true;
  const skip = (reason) => { out.reason = reason; return out; };

  if (row.source === 'manual_staff') return skip('manual_report');

  const conv = row.source_missive_conversation_id;
  const lastMs = conv && ctx.lastEmail.has(conv) ? ctx.lastEmail.get(conv) : null;
  if (lastMs === null || lastMs === undefined || Number.isNaN(lastMs)) return skip('not_open_or_other');
  out.lastMs = lastMs;

  const cutoffMs = ctx.nowMs - ctx.olderThanDays * DAY_MS;
  if (!(lastMs < cutoffMs)) return skip('recent');

  if (isFairHousing(row)) return skip('fair_housing_flagged');
  if (ctx.holdBackUrgent && row.severity_tier === 'urgent') return skip('urgent_held_back');
  if (ctx.holdBackLegal && isLegalTagged(row)) return skip('legal_held_back');
  if (row.blocked_since) return skip('not_open_or_other');
  if (row.delegated_to_team_member_id) return skip('recently_worked_or_delegated');
  if (ctx.withNote && ctx.withNote.has(row.id)) return skip('kept_has_note');

  if (ctx.latestAudit === null) { out.needsAudit = true; return out; }
  if (ctx.auditUnverified && ctx.auditUnverified.has(row.id)) return skip('recently_worked_or_delegated');
  const latest = ctx.latestAudit.get(row.id);
  if (latest && latest.actor_type === 'human') {
    const touchedMs = Date.parse(latest.created_at);
    // An unreadable time on a person's action is treated as "just now".
    if (Number.isNaN(touchedMs) || touchedMs >= ctx.nowMs - RECENT_HUMAN_DAYS * DAY_MS) {
      return skip('recently_worked_or_delegated');
    }
  }

  const duplicatePending = row.duplicate_status === 'suggested'
    || (row.possible_duplicate_of_id && !['dismissed', 'confirmed_merged'].includes(row.duplicate_status));
  if (duplicatePending) return skip('duplicate_pending');

  out.eligible = true;
  return out;
}

function emptySkipped(holdBackLegal) {
  const skipped = {};
  for (const reason of skipReasonsFor(holdBackLegal)) skipped[reason] = 0;
  return skipped;
}

// Tallies a list of rows with decide(). `eligible` is sorted oldest last-email
// first (ties by id) so a partly finished close always did the oldest first.
function classifyRows(rows, ctx) {
  const result = {
    open_in_scope: 0, eligible: [], eligible_by_year: {}, legal_tagged: 0,
    skipped: emptySkipped(!!ctx.holdBackLegal), needsAudit: [],
  };
  for (const row of rows) {
    const d = decide(row, ctx);
    if (!d.inScope) continue;
    result.open_in_scope += 1;
    if (d.needsAudit) { result.needsAudit.push(row.id); continue; }
    if (d.eligible) {
      result.eligible.push({ row, lastMs: d.lastMs });
      if (isLegalTagged(row)) result.legal_tagged += 1;
      const year = String(new Date(d.lastMs).getUTCFullYear());
      result.eligible_by_year[year] = (result.eligible_by_year[year] || 0) + 1;
    } else {
      result.skipped[d.reason] += 1;
    }
  }
  result.eligible.sort((a, b) => (a.lastMs - b.lastMs) || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));
  return result;
}

// A short code for exactly which items qualify, so a close can be refused if
// the set is not the one that was previewed (even when the count is the same).
function setHash(ids) {
  return crypto.createHash('sha256').update([...ids].sort().join('\n')).digest('hex');
}

// ─── Wording ─────────────────────────────────────────────────────────────
const batchTag = (batchId) => `(batch ${batchId})`;
// What the database is asked for: the note starts with the fixed words, then
// the days, then this batch's tag and the ", approved by " that follows it.
const batchLikePattern = (batchId) => `${NOTE_START}% days ${batchTag(batchId)}, approved by %`;
// A note holds exactly one "(batch " (names have their brackets taken out), so
// a note holding two is never a note of ours, whatever else it says.
const TWO_TAGS_PATTERN = '%(batch %(batch %';
// The one way the database is asked for a batch's notes.
const matchBatchNotes = (query, batchId) => query
  .like('resolution_note', batchLikePattern(batchId))
  .not('resolution_note', 'like', TWO_TAGS_PATTERN);
// The same thing checked exactly, in code: the id captured from the tag that
// sits right after the days. A person's name can never reach this spot.
const NOTE_RE = /^Closed in bulk: no email activity for over \d{1,5} days \(batch ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\), approved by /;
function batchIdOfNote(note) {
  const m = typeof note === 'string' ? NOTE_RE.exec(note) : null;
  return m ? m[1] : null;
}

// Brackets are taken out of the name, so a name can never carry a "(batch ...)"
// of its own and be mistaken for a batch tag.
function cleanName(value) {
  const s = String(value || '').replace(/[\u0000-\u001f\u007f()]/g, ' ').replace(/\s+/g, ' ').trim();
  return (s || 'a signed-in user').slice(0, 80);
}

function dateText(ms) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch (err) {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

function buildNote({ olderThanDays, batchId, approverName, nowMs }) {
  return `${NOTE_START}${olderThanDays} days ${batchTag(batchId)}, approved by ${cleanName(approverName)} on ${dateText(nowMs)}.`;
}

// The latest of a list of timestamp strings, returned exactly as given (the
// database's own text, microseconds and all), or null if there are none.
function newestTimestamp(values) {
  let best = null;
  for (const v of values) {
    if (!v || Number.isNaN(Date.parse(v))) continue;
    if (best === null) { best = v; continue; }
    const a = Date.parse(v);
    const b = Date.parse(best);
    if (a > b || (a === b && v > best)) best = v;
  }
  return best;
}

// The updated_at fence for a close: the newest value among the items, but never
// later than the moment they were read. An item stamped in the future (a bad
// clock, a hand edit) is itself left alone, and cannot push the fence out for
// everyone else.
function fenceTimestamp(values, readMs) {
  const sane = values.filter((v) => v && Date.parse(v) <= readMs);
  return newestTimestamp(sane) || new Date(readMs).toISOString();
}

function chunksOf(list, size) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
}

// Runs fn over the items, at most `limit` at a time, keeping the order.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ─── Same-origin check for the two POST routes ───────────────────────────
// The Hub's session cookie is SameSite=Lax, which already keeps another
// site's page from sending these requests with a login. This also refuses a
// browser request that says it came from another site. Requests with no
// Sec-Fetch-Site header (older browsers, scripts) pass as before.
function requireSameOrigin(req, res, next) {
  const site = typeof req.get === 'function' ? req.get('sec-fetch-site') : (req.headers && req.headers['sec-fetch-site']);
  if (site && site !== 'same-origin' && site !== 'none') {
    return res.status(403).json({ error: 'This request did not come from the Complaint Tracking page. Nothing was changed.' });
  }
  next();
}

// ─── The service ─────────────────────────────────────────────────────────
function createBulkClose({
  supabase, lookupUserId = async () => null, now = Date.now, randomUUID = () => crypto.randomUUID(),
  lookupTimeoutMs = LOOKUP_TIMEOUT_MS, clock = Date.now, busyTimeoutMs = BUSY_TIMEOUT_MS, previewMinIntervalMs = 0, batchesCacheMs = 0,
} = {}) {
  if (!supabase) throw new Error('createBulkClose: a supabase client is required.');

  // One bulk close or undo at a time (the Hub is one process). A call that has
  // made no progress for longer than busyTimeoutMs (progress = it finished
  // reading, saved its start row, or finished a group) is treated as hung: the
  // next call may take over, and the hung one stops before its next write. A
  // long, healthy close keeps resetting the clock, so it is never taken over.
  let lock = null; // { since, batchId }
  function takeLock() {
    const t = clock();
    if (lock && t - lock.since < busyTimeoutMs) return null;
    if (lock) logLine('an earlier close or undo has held the lock without progress for over the time limit; letting a new one start');
    lock = { since: t, batchId: null };
    forgetBatchesAnswer();
    return lock;
  }
  const releaseLock = (mine) => { if (lock === mine) { lock = null; forgetBatchesAnswer(); } };
  const noteProgress = (mine) => { if (lock === mine) lock.since = clock(); };

  // Recent batches costs about two dozen database reads. When asked for again
  // within batchesCacheMs, the answer just worked out is handed back (and
  // callers who arrive while it is being worked out share that one piece of
  // work). Any close or undo starting or finishing throws the answer away, so
  // what the page shows right after one is always fresh.
  let batchesAnswer = null; // { at, body }
  let batchesPending = null;
  let batchesGeneration = 0;
  function forgetBatchesAnswer() { batchesAnswer = null; batchesPending = null; batchesGeneration += 1; }
  const copyBody = (body) => JSON.parse(JSON.stringify(body));

  // One preview per person per interval (the preview reads every open item).
  const lastPreviewAt = new Map();
  function previewTooSoon(actor) {
    if (!(previewMinIntervalMs > 0)) return false;
    const key = (actor && actor.email) || 'anonymous';
    const t = clock();
    const last = lastPreviewAt.get(key);
    if (last !== undefined && t - last >= 0 && t - last < previewMinIntervalMs) return true;
    lastPreviewAt.set(key, t);
    if (lastPreviewAt.size > 200) {
      // forget people who have not asked for a minute (a fresh map, so no key is ever removed one by one)
      const recent = [...lastPreviewAt].filter(([, v]) => t - v <= 60000);
      lastPreviewAt.clear();
      for (const [k, v] of recent) lastPreviewAt.set(k, v);
    }
    return false;
  }

  async function loadOpenRows() {
    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('complaints')
        .select(COMPLAINT_COLUMNS)
        .eq('status', 'open')
        .is('merged_into_id', null)
        .eq('held_legal_fair_housing', false)
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw dbError('could not read the open complaints', error);
      const page = data || [];
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
      if (rows.length >= MAX_ROWS_READ) throw new BulkCloseError('too many open complaints to read safely');
    }
    return rows;
  }

  // The ids of open items that already carry a resolution note. Only ids come
  // back, never the note: whether a note is there is all that matters.
  async function loadIdsWithNote() {
    const ids = new Set();
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('complaints')
        .select('id')
        .eq('status', 'open')
        .is('merged_into_id', null)
        .eq('held_legal_fair_housing', false)
        .not('resolution_note', 'is', null)
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw dbError('could not check which open complaints already have a note', error);
      const page = data || [];
      for (const r of page) ids.add(r.id);
      if (page.length < PAGE_SIZE) break;
      if (ids.size >= MAX_ROWS_READ) throw new BulkCloseError('too many open complaints with notes to read safely');
    }
    return ids;
  }

  // Reads everything and decides every row. Used by BOTH the preview and the
  // real close.
  async function evaluate({ olderThanDays, holdBackUrgent, holdBackLegal = false }) {
    const nowMs = now();
    const rows = await loadOpenRows();
    const withNote = await loadIdsWithNote();
    const scoped = rows.filter(isInScope);

    const convIds = [...new Set(scoped.filter((r) => r.source !== 'manual_staff').map((r) => r.source_missive_conversation_id).filter(Boolean))];
    const lastEmail = new Map();
    let lookupIncomplete = false;
    if (convIds.length) {
      const dates = await createSourceEmailDates({ supabase, ttlMs: 0, overallTimeoutMs: lookupTimeoutMs }).lookup(convIds);
      for (const id of convIds) {
        if (!dates.has(id)) { lookupIncomplete = true; continue; }
        const d = dates.get(id);
        lastEmail.set(id, d && d.last ? Date.parse(d.last) : null);
      }
    }

    const ctx = { nowMs, olderThanDays, holdBackUrgent, holdBackLegal, lastEmail, withNote, latestAudit: null, auditUnverified: new Set() };
    const needAudit = classifyRows(scoped, ctx).needsAudit;
    if (needAudit.length) {
      const unverified = new Set();
      ctx.latestAudit = await findLatestAuditRows(supabase, needAudit, { overallTimeoutMs: lookupTimeoutMs, unverified, excludeActions: OWN_ITEM_ACTIONS });
      ctx.auditUnverified = unverified;
      if (unverified.size) lookupIncomplete = true;
    } else {
      ctx.latestAudit = new Map();
    }

    const result = classifyRows(scoped, ctx);
    return { ...result, nowMs, olderThanDays, holdBackUrgent, holdBackLegal, lookupIncomplete };
  }

  // ── GET preview ──
  async function preview(input, actor) {
    const opts = parseOptions(input, { fromQuery: true });
    if (opts.error) return { status: 400, body: { error: opts.error } };
    if (previewTooSoon(actor)) {
      return { status: 429, body: { error: 'That was checked a moment ago. Please wait a second, then try again.' } };
    }
    const r = await evaluate(opts);
    return {
      status: 200,
      body: {
        older_than_days: opts.olderThanDays,
        hold_back_urgent: opts.holdBackUrgent,
        hold_back_legal: opts.holdBackLegal,
        open_in_scope: r.open_in_scope,
        eligible: r.eligible.length,
        eligible_by_year: r.eligible_by_year,
        legal_tagged_in_eligible: r.legal_tagged,
        set_hash: setHash(r.eligible.map((e) => e.row.id)),
        skipped: r.skipped,
        cap: BATCH_CAP,
        over_cap: r.eligible.length > BATCH_CAP,
        lookup_incomplete: r.lookupIncomplete,
      },
    };
  }

  // ── Audit writes ──
  async function resolvePerformedBy(email) {
    if (!email) return null;
    try { return (await lookupUserId(email)) || null; } catch (err) { return null; }
  }

  function auditRow({ action, entityType = 'complaint', entityId, performedBy, email, propertyId = null, risk = 'low', details }) {
    return {
      action,
      entity_type: entityType,
      entity_id: entityId,
      performed_by: performedBy,
      actor_type: email ? 'human' : 'system',
      actor_id: email || 'complaint-tracking',
      privacy_category: 'processing',
      risk_level: risk,
      property_id: propertyId,
      details,
    };
  }

  const newAuditState = () => ({ multiFailures: 0, singleStreak: 0, down: false });

  // The same audit row is recognised by who it is about (entity_id), which batch
  // it belongs to, and, for an undo summary, which undo it was.
  const sameAuditRow = (saved, row) => saved.entity_id === row.entity_id
    && !!saved.details && !!row.details
    && saved.details.batch_id === row.details.batch_id
    && (row.details.undo_id === undefined || saved.details.undo_id === row.details.undo_id);

  // An insert whose answer was lost may still have been saved. Looks the rows
  // up and returns the entity_ids already there, or null when that could not
  // be told (then the caller carries on as before).
  async function savedAuditEntities(rows) {
    try {
      const groups = new Map();
      for (const row of rows) {
        const key = `${row.action}|${row.entity_type}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      const saved = new Set();
      for (const group of groups.values()) {
        const { data, error } = await supabase
          .from('audit_log')
          .select('entity_id, details')
          .eq('action', group[0].action)
          .eq('entity_type', group[0].entity_type)
          .in('entity_id', group.map((g) => g.entity_id));
        if (error) return null;
        for (const found of (data || [])) {
          const row = group.find((g) => sameAuditRow(found, g));
          if (row) saved.add(row.entity_id);
        }
      }
      return saved;
    } catch (err) {
      return null;
    }
  }

  // Returns { ok, saved }. After a failed attempt it looks at what is really in
  // the log before trying again (or before reporting failure), so a row that
  // was saved while its answer was lost is never written a second time.
  async function tryInsert(rows, attempts) {
    let saved = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const { error } = await supabase.from('audit_log').insert(rows);
        if (!error) return { ok: true, saved: null };
        logLine(`an audit_log insert of ${rows.length} row(s) failed (${safeErr(error)})`);
      } catch (err) {
        logLine(`an audit_log insert of ${rows.length} row(s) threw (${safeErr(err)})`);
      }
      saved = await savedAuditEntities(rows);
      if (saved && rows.every((row) => saved.has(row.entity_id))) return { ok: true, saved };
    }
    return { ok: false, saved };
  }

  // Writes the rows and returns how many could NOT be saved. A group is tried
  // as one statement first; if that is refused it is tried again one row at a
  // time (the log's hash chain was built for one row per statement), so a
  // single bad row costs one row, not the whole group. Once two groups have been
  // refused, later groups go straight to one at a time; once five single rows
  // in a row have failed, the log is taken as down and the rest are not tried.
  async function insertAuditRows(rows, state) {
    if (!rows.length) return 0;
    if (rows.length === 1) return (await tryInsert(rows, 2)).ok ? 0 : 1;
    let alreadySaved = new Set();
    if (state.multiFailures < MULTI_ROW_FAILURES_BEFORE_SINGLE) {
      const group = await tryInsert(rows, 1);
      if (group.ok) { state.multiFailures = 0; return 0; }
      state.multiFailures += 1;
      if (group.saved) alreadySaved = group.saved;
    }
    let failedRows = 0;
    for (const row of rows) {
      if (alreadySaved.has(row.entity_id)) continue;
      if (state.down) { failedRows += 1; continue; }
      if ((await tryInsert([row], 2)).ok) {
        state.singleStreak = 0;
      } else {
        failedRows += 1;
        state.singleStreak += 1;
        if (state.singleStreak >= SINGLE_FAILURES_BEFORE_GIVING_UP) state.down = true;
      }
    }
    return failedRows;
  }

  // The write that closes one group of items. Every guard here repeats a rule
  // from decide(), so an item that changed after it was read is left alone.
  // (Not repeated here: the lane an item sits in, and the "a person worked on
  // it" test, which comes from the audit log. The updated_at fence below covers
  // those.)
  function closeQuery(ids, note, { holdBackUrgent, holdBackLegal, snapshot }) {
    let query = supabase
      .from('complaints')
      .update({ status: 'resolved', resolution_note: note })
      .in('id', ids)
      .eq('status', 'open')
      .is('merged_into_id', null)
      .eq('held_legal_fair_housing', false)
      .is('delegated_to_team_member_id', null)
      .is('blocked_since', null)
      .neq('source', 'manual_staff')
      .neq('duplicate_status', 'suggested')
      .or('possible_duplicate_of_id.is.null,duplicate_status.eq.dismissed,duplicate_status.eq.confirmed_merged')
      .is('resolution_note', null)
      .eq('flagged_protected_class', false)
      .is('flagged_category', null)
      .or('category.is.null,category.neq.accommodation_related');
    if (holdBackUrgent) query = query.or('severity_tier.is.null,severity_tier.neq.urgent');
    if (holdBackLegal) {
      query = query
        .or('category.is.null,category.neq.legal_exposure')
        .or('owner_instruction_rejected.is.null,owner_instruction_rejected.eq.false');
    }
    if (snapshot) query = query.lte('updated_at', snapshot);
    return query;
  }

  // ── POST close ──
  async function execute(input, actor) {
    const opts = parseOptions(input, { fromQuery: false });
    if (opts.error) return { status: 400, body: { error: opts.error } };
    const expected = input && input.expected_count;
    if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 1 || expected > MAX_EXPECTED_COUNT) {
      return { status: 400, body: { error: 'expected_count must be the whole number of items shown in the preview (1 or more).' } };
    }
    const expectedHash = input && input.expected_hash;
    if (typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/i.test(expectedHash)) {
      return { status: 400, body: { error: 'expected_hash must be the set code shown by the preview.' } };
    }
    const mine = takeLock();
    if (!mine) {
      return { status: 409, body: { error: 'Another bulk close or undo is running right now. Wait for it to finish, then preview again.' } };
    }
    try {
      const r = await evaluate(opts);
      noteProgress(mine);
      const eligible = r.eligible.length;
      if (eligible > BATCH_CAP) {
        return { status: 422, body: { error: `That is more than one batch can close (${eligible} items; the limit is ${BATCH_CAP}). Nothing was closed. Choose a larger number of days to make the group smaller.`, eligible, cap: BATCH_CAP } };
      }
      if (eligible !== expected) {
        return { status: 409, body: { error: `The list changed since you previewed it (${eligible} items qualify now, not ${expected}). Nothing was closed. Please preview again.`, eligible } };
      }
      const eligibleHash = setHash(r.eligible.map((e) => e.row.id));
      if (eligibleHash !== expectedHash.toLowerCase()) {
        return { status: 409, body: { error: 'The list changed since you previewed it (the same number of items, but not the same ones). Nothing was closed. Please preview again.', eligible } };
      }

      const batchId = randomUUID();
      mine.batchId = batchId;
      const email = actor && actor.email ? actor.email : null;
      const note = buildNote({ olderThanDays: opts.olderThanDays, batchId, approverName: (actor && actor.name) || email, nowMs: r.nowMs });
      const performedBy = await resolvePerformedBy(email);
      const auditState = newAuditState();

      // RECORD FIRST. Nothing is changed unless this row is saved.
      const startNotSaved = await insertAuditRows([auditRow({
        action: ACTIONS.batchStarted, entityType: BATCH_ENTITY_TYPE, entityId: batchId, performedBy, email, risk: 'medium',
        details: {
          batch_id: batchId, older_than_days: opts.olderThanDays, hold_back_urgent: opts.holdBackUrgent,
          hold_back_legal: opts.holdBackLegal, open_in_scope: r.open_in_scope, eligible,
          legal_tagged_in_eligible: r.legal_tagged, set_hash: eligibleHash, skipped: r.skipped, cap: BATCH_CAP,
        },
      })], auditState);
      if (startNotSaved) {
        return { status: 500, body: { error: 'The record of this close could not be saved, so nothing was changed. Please try again. If it keeps happening, tell Jarvis.' } };
      }
      noteProgress(mine);
      forgetBatchesAnswer(); // the start row is in: Recent batches lists this batch from now on

      // Anything that changed after this read (a new note, a delegation, a
      // new flag) stamps updated_at later than every value read here, so the
      // update below simply leaves that item alone.
      const snapshot = fenceTimestamp(r.eligible.map((e) => e.row.updated_at), r.nowMs);
      const guards = { holdBackUrgent: opts.holdBackUrgent, holdBackLegal: opts.holdBackLegal, snapshot };

      let closed = 0;
      let failed = 0;
      let skippedChanged = 0;
      let auditFailed = 0;
      let stoppedEarly = false;

      const groups = chunksOf(r.eligible.map((e) => e.row), WRITE_CHUNK);
      for (let g = 0; g < groups.length; g += 1) {
        // A newer call took over the lock (this one was taken as hung): stop here.
        if (lock !== mine) {
          stoppedEarly = true;
          for (let rest = g; rest < groups.length; rest += 1) failed += groups[rest].length;
          logLine('stopped before the next group because the lock was taken over');
          break;
        }
        const ids = groups[g].map((c) => c.id);

        let outcome; // { rows, errored } or null when what was saved cannot be told
        try {
          const { data, error } = await closeQuery(ids, note, guards).select('id, property_id');
          if (error) throw dbError('a group could not be updated', error);
          outcome = { rows: data || [], errored: false };
        } catch (err) {
          logLine(`a group of ${ids.length} could not be updated (${safeErr(err)}); checking what was saved`);
          const saved = await closedByBatch(ids, batchId);
          outcome = saved ? { rows: saved, errored: true } : null;
        }
        if (!outcome) { failed += ids.length; continue; }

        const changedRows = outcome.rows;
        const notChanged = ids.length - changedRows.length;
        // After an error, the ones not saved are failures; after a clean answer
        // they are items that changed since the read and were left alone.
        if (outcome.errored) failed += notChanged; else skippedChanged += notChanged;
        closed += changedRows.length;

        const rowsForAudit = changedRows.map((x) => auditRow({
          action: ACTIONS.itemClosed, entityId: x.id, performedBy, email, propertyId: x.property_id || null,
          details: {
            batch_id: batchId, older_than_days: opts.olderThanDays, hold_back_urgent: opts.holdBackUrgent,
            hold_back_legal: opts.holdBackLegal, from_status: 'open', to_status: 'resolved', reason: note,
          },
        }));
        auditFailed += await insertAuditRows(rowsForAudit, auditState);
        noteProgress(mine);
      }

      const summary = {
        batch_id: batchId, closed, failed, skipped_changed: skippedChanged, audit_failed: auditFailed,
        older_than_days: opts.olderThanDays, hold_back_urgent: opts.holdBackUrgent, hold_back_legal: opts.holdBackLegal, cap: BATCH_CAP,
      };
      if (stoppedEarly) summary.stopped_early = true;
      auditFailed += await insertAuditRows([auditRow({
        action: ACTIONS.batchClosed, entityType: BATCH_ENTITY_TYPE, entityId: batchId, performedBy, email, risk: 'medium', details: summary,
      })], auditState);

      const body = {
        batch_id: batchId, closed, failed, skipped_changed: skippedChanged,
        older_than_days: opts.olderThanDays, hold_back_urgent: opts.holdBackUrgent, hold_back_legal: opts.holdBackLegal,
        audit_failed: auditFailed,
      };
      if (stoppedEarly) body.stopped_early = true;
      return { status: 200, body };
    } finally {
      releaseLock(mine);
    }
  }

  // After an update call errored, find out which of its ids really carry this
  // batch's tag (an answer lost on the way back does not mean nothing was
  // saved). Returns those rows, or null when even that check failed.
  async function closedByBatch(ids, batchId) {
    try {
      const { data, error } = await matchBatchNotes(supabase
        .from('complaints')
        .select('id, property_id')
        .in('id', ids)
        .eq('status', 'resolved'), batchId);
      return error ? null : (data || []);
    } catch (err) {
      return null;
    }
  }

  async function countStillClosed(batchId) {
    try {
      const res = await matchBatchNotes(supabase
        .from('complaints')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'resolved'), batchId);
      return res.error ? null : (res.count || 0);
    } catch (err) {
      return null;
    }
  }

  // ── GET recent batches ──
  // Built from the start rows (one per batch, written before anything was
  // changed), so a batch that stopped halfway is still listed. The closed count
  // comes from the end-of-batch row when there is one, otherwise from the live
  // count of items still closed.
  async function listBatches() {
    const { data, error } = await supabase
      .from('audit_log')
      .select('entity_id, actor_id, details, created_at')
      .eq('action', ACTIONS.batchStarted)
      .eq('entity_type', BATCH_ENTITY_TYPE)
      .order('created_at', { ascending: false })
      .order('sequence_num', { ascending: false })
      .limit(BATCH_LIST_LIMIT);
    if (error) throw dbError('could not read the recent batches', error);
    // A batch is listed once. If its start row was saved twice (an answer lost
    // on the way back and then written again), the earlier row is the true start.
    const firstByBatch = new Map();
    for (const row of (data || [])) {
      if (!isValidUuid(row.entity_id)) continue;
      const seen = firstByBatch.get(row.entity_id);
      if (!seen) firstByBatch.set(row.entity_id, row);
      else if (Date.parse(row.created_at) < Date.parse(seen.created_at)) firstByBatch.set(row.entity_id, row);
    }
    const rows = [...firstByBatch.values()];

    // Their end-of-batch rows (at most 20 ids), and the names of who closed them.
    const summaryById = new Map();
    let endRowsKnown = true; // false when the end rows could not be read: then no batch can be called finished or not
    if (rows.length) {
      try {
        const res = await supabase
          .from('audit_log')
          .select('entity_id, details')
          .eq('action', ACTIONS.batchClosed)
          .eq('entity_type', BATCH_ENTITY_TYPE)
          .in('entity_id', [...new Set(rows.map((r) => r.entity_id))]);
        if (res.error) endRowsKnown = false;
        else for (const s of (res.data || [])) if (!summaryById.has(s.entity_id)) summaryById.set(s.entity_id, s.details || {});
      } catch (err) {
        endRowsKnown = false;
      }
    }

    // Only plain-looking email addresses are used in the name lookup.
    const emails = [...new Set(rows.map((r) => String(r.actor_id || '').toLowerCase()).filter((e) => /^[^\s,()"'\\]{1,120}@[^\s,()"'\\]{1,120}$/.test(e)))];
    let nameByEmail = new Map();
    if (emails.length) {
      const res = await supabase.from('team_members').select('full_name, email').in('email', emails);
      if (!res.error) nameByEmail = new Map((res.data || []).map((m) => [String(m.email || '').toLowerCase(), m.full_name || m.email]));
    }

    const stillClosed = await mapLimit(rows, BATCH_LIST_CONCURRENCY, (r) => countStillClosed(r.entity_id));

    const batches = rows.map((r, i) => {
      const d = r.details || {};
      const summary = summaryById.get(r.entity_id) || null;
      let state = 'unfinished'; // started, but no end-of-batch row: it may have stopped halfway
      if (!endRowsKnown) state = 'unknown';
      else if (summary) state = 'finished';
      else if (lock && lock.batchId === r.entity_id) state = 'running';
      let closedCount = null;
      if (summary && Number.isInteger(summary.closed)) closedCount = summary.closed;
      else if (stillClosed[i] !== null) closedCount = stillClosed[i];
      const entry = {
        batch_id: r.entity_id,
        closed_at: r.created_at,
        closed_by_name: nameByEmail.get(String(r.actor_id || '').toLowerCase()) || r.actor_id || 'Unknown',
        closed: closedCount,
        older_than_days: Number.isInteger(d.older_than_days) ? d.older_than_days : null,
        hold_back_urgent: typeof d.hold_back_urgent === 'boolean' ? d.hold_back_urgent : null,
        hold_back_legal: typeof d.hold_back_legal === 'boolean' ? d.hold_back_legal : null,
        state,
        still_closed: stillClosed[i],
      };
      // The close stopped on its own before the last group (it was taken as hung).
      if (summary && summary.stopped_early === true) entry.stopped_early = true;
      return entry;
    });
    return { status: 200, body: { batches } };
  }

  async function listBatchesThrottled() {
    if (!(batchesCacheMs > 0)) return listBatches();
    const t = clock();
    if (batchesAnswer && t - batchesAnswer.at >= 0 && t - batchesAnswer.at < batchesCacheMs) {
      return { status: 200, body: copyBody(batchesAnswer.body) };
    }
    if (batchesPending) {
      const shared = await batchesPending;
      return { status: 200, body: copyBody(shared.body) };
    }
    const generation = batchesGeneration;
    const work = listBatches().then((out) => {
      if (generation === batchesGeneration) batchesAnswer = { at: t, body: copyBody(out.body) };
      return out;
    }).finally(() => {
      if (batchesPending === work) batchesPending = null;
    });
    batchesPending = work;
    return work;
  }

  // The batch-level audit rows for one batch (start, end, undo summaries), or
  // null when they could not be read.
  async function readBatchHistory(batchId) {
    try {
      const { data, error } = await supabase
        .from('audit_log')
        .select('action, details')
        .eq('entity_type', BATCH_ENTITY_TYPE)
        .eq('entity_id', batchId)
        .limit(100);
      return error ? null : (data || []);
    } catch (err) {
      return null;
    }
  }

  // How many items this batch closed that no longer carry its tag and were not
  // reopened by an undo: someone replaced their note since. Zero when the
  // batch's end row is missing (the true number cannot be told).
  function replacedCount(history, taggedNow) {
    if (!history) return 0;
    const end = history.find((h) => h.action === ACTIONS.batchClosed);
    if (!end || !end.details || !Number.isInteger(end.details.closed)) return 0;
    const reopenedBefore = history
      .filter((h) => h.action === ACTIONS.batchUndone)
      .reduce((sum, h) => sum + (h.details && Number.isInteger(h.details.reopened) ? h.details.reopened : 0), 0);
    return Math.max(0, end.details.closed - taggedNow - reopenedBefore);
  }

  // ── POST undo ──
  async function undo(rawBatchId, actor) {
    if (!isValidUuid(rawBatchId)) return { status: 400, body: { error: 'That batch id is not valid.' } };
    const batchId = rawBatchId.toLowerCase(); // the tag in the notes is always written in lower case
    const mine = takeLock();
    if (!mine) {
      return { status: 409, body: { error: 'Another bulk close or undo is running right now. Wait for it to finish, then try again.' } };
    }
    try {
      const tagged = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await matchBatchNotes(supabase
          .from('complaints')
          .select('id, status, merged_into_id, held_legal_fair_housing, resolution_note, property_id'), batchId)
          .order('id', { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw dbError('could not read the batch', error);
        const page = data || [];
        tagged.push(...page);
        if (page.length < PAGE_SIZE) break;
        if (tagged.length >= MAX_ROWS_READ) throw new BulkCloseError('too many rows in one batch to read safely');
      }

      const history = await readBatchHistory(batchId);

      if (!tagged.length) {
        // Nothing carries this batch's tag. Fine if the batch is known (it was
        // already undone, or every item was changed since); otherwise there is
        // no such batch.
        if (history === null) throw new BulkCloseError('could not look up the batch');
        if (!history.length) return { status: 404, body: { error: 'No bulk close with that batch id was found.' } };
        return { status: 200, body: { batch_id: batchId, reopened: 0, skipped_changed: replacedCount(history, 0) } };
      }

      // The tag is checked exactly: it must be the one right after the days,
      // never text inside a person's name.
      const candidates = tagged.filter((r) => r.status === 'resolved'
        && !r.merged_into_id && !r.held_legal_fair_housing
        && batchIdOfNote(r.resolution_note) === batchId);
      let skippedChanged = tagged.length - candidates.length + replacedCount(history, tagged.length);
      let reopened = 0;
      let failed = 0;
      let auditFailed = 0;
      let attempted = 0;
      let stoppedEarly = false;
      noteProgress(mine);

      const email = actor && actor.email ? actor.email : null;
      const performedBy = await resolvePerformedBy(email);
      const auditState = newAuditState();

      for (const chunk of chunksOf(candidates, WRITE_CHUNK)) {
        if (lock !== mine) {
          logLine('undo stopped before the next group because the lock was taken over');
          failed += candidates.length - attempted;
          stoppedEarly = true;
          break;
        }
        const ids = chunk.map((c) => c.id);
        attempted += ids.length;
        let changedRows;
        try {
          const { data, error } = await matchBatchNotes(supabase
            .from('complaints')
            .update({ status: 'open', resolution_note: null })
            .in('id', ids)
            .eq('status', 'resolved')
            .is('merged_into_id', null)
            .eq('held_legal_fair_housing', false), batchId)
            .select('id, property_id');
          if (error) throw dbError('a group could not be reopened', error);
          changedRows = data || [];
        } catch (err) {
          logLine(`undo: a group of ${ids.length} could not be updated (${safeErr(err)})`);
          failed += ids.length;
          continue;
        }
        reopened += changedRows.length;
        skippedChanged += ids.length - changedRows.length;
        const rowsForAudit = changedRows.map((x) => auditRow({
          action: ACTIONS.itemReopened, entityId: x.id, performedBy, email, propertyId: x.property_id || null,
          details: { batch_id: batchId, from_status: 'resolved', to_status: 'open' },
        }));
        auditFailed += await insertAuditRows(rowsForAudit, auditState);
        noteProgress(mine);
      }

      if (reopened > 0) {
        // undo_id tells this undo's summary apart from an earlier undo's, so a
        // lost answer can be checked for without mistaking one for the other.
        auditFailed += await insertAuditRows([auditRow({
          action: ACTIONS.batchUndone, entityType: BATCH_ENTITY_TYPE, entityId: batchId, performedBy, email, risk: 'medium',
          details: { batch_id: batchId, undo_id: crypto.randomUUID(), reopened, skipped_changed: skippedChanged, failed, audit_failed: auditFailed },
        })], auditState);
      }

      const body = { batch_id: batchId, reopened, skipped_changed: skippedChanged };
      if (failed) body.failed = failed;
      if (stoppedEarly) body.stopped_early = true;
      if (auditFailed) body.audit_failed = auditFailed;
      return { status: 200, body };
    } finally {
      releaseLock(mine);
    }
  }

  return { preview, execute, listBatches: listBatchesThrottled, undo, evaluate };
}

// ─── Routes ──────────────────────────────────────────────────────────────
// router.js calls this once. Every route sits behind the same access check as
// the rest of the tool; the two POSTs also get the same-origin check.
// serviceOptions is for tests only (a fixed clock, fixed ids); router.js leaves it out.
function mountBulkCloseRoutes(router, {
  requireAccess, supabase, lookupUserId, previewMinIntervalMs = PREVIEW_MIN_INTERVAL_MS, batchesCacheMs = BATCHES_CACHE_MS, serviceOptions = {},
}) {
  const service = createBulkClose({ ...serviceOptions, supabase, lookupUserId, previewMinIntervalMs, batchesCacheMs });
  const base = '/api/complaint-tracking/bulk-close';

  const actorOf = (req) => ({
    email: req.user && req.user.email ? req.user.email : null,
    name: req.complaintTrackingMemberName || (req.user && req.user.email) || null,
  });

  const wrap = (what, fn) => async (req, res) => {
    try {
      const out = await fn(req);
      res.status(out.status).json(out.body);
    } catch (err) {
      console.error(`[complaint-tracking] bulk close ${what} failed: ${err && err.safe ? err.message : safeErr(err)}`);
      res.status(500).json({ error: `Could not ${what}. Nothing further was changed. Please try again.` });
    }
  };

  router.get(`${base}/preview`, requireAccess, wrap('build the preview', (req) => service.preview(req.query, actorOf(req))));
  router.get(`${base}/batches`, requireAccess, wrap('read the recent batches', () => service.listBatches()));
  router.post(base, requireAccess, requireSameOrigin, wrap('close the old items', (req) => service.execute(req.body, actorOf(req))));
  router.post(`${base}/:batch_id/undo`, requireAccess, requireSameOrigin, wrap('undo the batch', (req) => service.undo(req.params.batch_id, actorOf(req))));
  return service;
}

module.exports = {
  createBulkClose,
  mountBulkCloseRoutes,
  requireSameOrigin,
  decide,
  classifyRows,
  parseOptions,
  serverLaneOf,
  serverTriagePriority,
  isInScope,
  isFairHousing,
  isLegalTagged,
  buildNote,
  batchTag,
  batchLikePattern,
  TWO_TAGS_PATTERN,
  batchIdOfNote,
  setHash,
  safeErr,
  COMPLAINT_COLUMNS,
  SKIP_REASONS,
  skipReasonsFor,
  ACTIONS,
  OWN_ITEM_ACTIONS,
  BATCH_ENTITY_TYPE,
  NOTE_PREFIX,
  DEFAULT_DAYS,
  MIN_DAYS,
  MAX_DAYS,
  BATCH_CAP,
  WRITE_CHUNK,
  RECENT_HUMAN_DAYS,
  BUSY_TIMEOUT_MS,
  BATCHES_CACHE_MS,
  PREVIEW_MIN_INTERVAL_MS,
  BATCH_LIST_CONCURRENCY,
};
