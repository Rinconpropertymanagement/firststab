'use strict';

/**
 * Daily vacancy snapshot - Rincon Management
 *
 * WHAT IT DOES (plain English)
 * The AppFolio sync overwrites a unit's rent every run, so yesterday's asking
 * rent is lost. This file keeps a daily record instead: one row per vacant
 * unit per day in the table `unit_vacancy_snapshots` (supabase/migrations/
 * 20261018010000_unit_vacancy_snapshots.sql). The sync runs several times a
 * day; the last run of the day simply overwrites that day's row, so the row
 * always shows the latest state of the day.
 *
 * It records only unit-level numbers: which unit, its property, status, rents
 * and days vacant. Never a tenant name, phone, email or lease.
 * It only ever adds or refreshes rows. It never deletes anything.
 *
 * It must never break the sync: sync.js calls it inside its own try/catch and
 * this file also catches everything itself and writes ONE plain log line.
 *
 * WHICH ROWS: the rows of AppFolio's `unit_vacancy` REPORT (about 50 a day),
 * NOT `units WHERE status = 'vacant'` (that list holds stale flags).
 *
 * HOW THE COLUMNS ARE FILLED (checked on a real report row, 2026-10-18)
 *   unit_id         the units row for the report's unit_id (units.appfolio_id)
 *   property_id     that unit's units.property_id; if the unit has none yet,
 *                   the property found through the report's property_id
 *   unit_status     'notice' for AppFolio "Notice-..." rows, else 'vacant'
 *   asking_rent     AppFolio `advertised_rent` (the rent being advertised)
 *   scheduled_rent  AppFolio `schd_rent`
 *   days_vacant     AppFolio `days_vacant`, BUT NULL (unknown) whenever AppFolio
 *                   has no move-out date for the unit (`last_move_out` empty)
 *   snapshot_date   NOT sent: the database stamps today's Los Angeles date
 * NOTE: AppFolio's `new_rent` is NOT the asking rent. It is only filled once a
 * unit is already rented (the incoming tenant's rent), so it is not stored.
 *
 * CAUTION ABOUT days_vacant: on the real report, every row that says 0 days has
 * no move-out date at all, so that 0 means "AppFolio does not know", not "just
 * vacated". That is why it is stored as NULL. It is also blank for units still
 * on notice. A real 0 (move-out within the last day) is kept as 0.
 *
 * SAFETY NETS
 *   - Everything is caught here and turned into one plain log line.
 *   - Every network call has an idle timeout, a cut-off connection counts as a
 *     failure, and the whole step has a hard deadline (150 s), so a bad
 *     connection can never leave the sync hanging or silently ending early.
 *   - Truncation guard: a report with fewer than 20% of the last saved day's
 *     rows is not written. Only a person running this file by hand can bypass
 *     that, with --force. The sync itself never can.
 *
 * Usage (stand-alone, one AppFolio request, optional - the sync does this itself):
 *   node vacancy-snapshot.js --dry-run   Show what would be saved; writes nothing
 *   node vacancy-snapshot.js             Save today's snapshot now
 *   node vacancy-snapshot.js --force     Save even if the report looks cut short
 *                                        (manual use only, after checking the report)
 *   node vacancy-snapshot.js --help      This text
 */

const https = require('https');
const path  = require('path');

const TABLE = 'unit_vacancy_snapshots';
const UPSERT_PATH = `/rest/v1/${TABLE}?on_conflict=unit_id,snapshot_date`;
const UPSERT_PREFER = 'resolution=merge-duplicates';

const CHUNK_SIZE = 100;            // rows per save request
const LOOKUP_CHUNK = 100;          // ids per lookup request
const MIN_FRACTION_OF_PREVIOUS = 0.2; // fewer rows than this share of the last saved day = report looks cut short
const GIVE_UP_AFTER = 3;           // one-by-one retry stops after this many failures in a row (database is down)
const REQUEST_TIMEOUT_MS = 30_000; // one request may sit silent this long before it counts as failed
const DEADLINE_MS = 150_000;       // the whole snapshot step gives up after this long, no matter what

// ─────────────────────────────────────────────────────────────────────────────
// SMALL CLEANERS (pure functions, no network)
// ─────────────────────────────────────────────────────────────────────────────

function oneLine(msg) {
  return String(msg == null ? '' : msg).replace(/\s+/g, ' ').trim().slice(0, 300);
}

// AppFolio ids arrive as numbers; the database stores them as text. Only plain
// id-looking values are accepted so a strange value can never end up in a URL.
function cleanId(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === 'null' || s === 'undefined') return null;
  return /^[A-Za-z0-9_-]{1,40}$/.test(s) ? s : null;
}

// A rent is a positive number or null. Zero and blank both mean "no rent".
function cleanRent(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n <= 0 || n >= 100000000) return null; // column is NUMERIC(10,2)
  return Math.round(n * 100) / 100;
}

// Is there anything in this field? (AppFolio uses null or "" for "none".)
function hasValue(v) {
  return v != null && String(v).trim() !== '';
}

// Days vacant is a whole number >= 0 or null.
function cleanDays(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || n < 0 || n > 100000) return null;
  return Math.round(n);
}

// The table only accepts occupied / vacant / notice / maintenance.
function mapUnitStatus(raw) {
  return /^\s*notice/i.test(String(raw == null ? '' : raw)) ? 'notice' : 'vacant';
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function todayInLosAngeles(now) {
  return (now || new Date()).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAPPING (pure)
// ─────────────────────────────────────────────────────────────────────────────

// Builds the exact row that gets saved. Only the six listed fields, every one
// present on every row (a blank is an explicit null) so one batch is uniform.
// snapshot_date is deliberately left out - the database fills it in.
function buildSnapshotRow(raw, unitUuid, propertyUuid) {
  return {
    unit_id:        unitUuid,
    property_id:    propertyUuid || null,
    unit_status:    mapUnitStatus(raw.unit_status),
    asking_rent:    cleanRent(raw.advertised_rent),
    scheduled_rent: cleanRent(raw.schd_rent),
    // With no move-out date AppFolio's days_vacant is always 0 and means
    // "unknown" (see CAUTION in the header), so it is stored as NULL then.
    days_vacant:    hasValue(raw.last_move_out) ? cleanDays(raw.days_vacant) : null,
  };
}

// Turns the whole report into rows ready to save. One bad row is skipped and
// counted, never allowed to spoil the rest. The same unit twice is reduced to
// one row here, because a repeat inside one save makes Postgres reject the
// WHOLE batch, and a lost day cannot be recreated.
function prepareSnapshot(rawRows, unitsByAfId, propsByAfId) {
  const skipped = { bad_row: 0, no_unit_id: 0, unit_not_in_database: 0, duplicate: 0 };
  const byUnit = new Map(); // units.id -> { afUnitId, row }; the later row wins
  for (const raw of rawRows) {
    if (!raw || typeof raw !== 'object') { skipped.bad_row++; continue; }
    const afId = cleanId(raw.unit_id);
    if (!afId) { skipped.no_unit_id++; continue; }
    const unit = unitsByAfId.get(afId);
    if (!unit || !unit.id) { skipped.unit_not_in_database++; continue; }
    const propertyUuid = unit.property_id || propsByAfId.get(cleanId(raw.property_id)) || null;
    if (byUnit.has(unit.id)) skipped.duplicate++;
    byUnit.set(unit.id, { afUnitId: afId, row: buildSnapshotRow(raw, unit.id, propertyUuid) });
  }
  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
  return { entries: Array.from(byUnit.values()), skipped, skippedTotal };
}

// True when the report has far fewer rows than the last saved day, which
// points to an AppFolio hiccup rather than a real change.
function looksTruncated(seen, previousCount) {
  return previousCount > 0 && seen < previousCount * MIN_FRACTION_OF_PREVIOUS;
}

function describeSkips(skipped) {
  const labels = {
    unit_not_in_database: 'unit not in database',
    no_unit_id: 'no unit id',
    duplicate: 'repeated unit',
    bad_row: 'unreadable row',
  };
  return Object.keys(labels).filter(k => skipped[k] > 0).map(k => `${skipped[k]} ${labels[k]}`).join(', ');
}

// ─────────────────────────────────────────────────────────────────────────────
// NETWORK (http can be swapped out so tests never touch a real server)
// ─────────────────────────────────────────────────────────────────────────────

// Builds the function that makes one web request. `transport` is Node's https
// (tests pass the plain http module and a short timeout).
// A request counts as FAILED, and the promise settles, in all of these cases:
//   - nothing arrives for timeoutMs (a stalled connection),
//   - the connection is cut while the answer is still arriving (the answer
//     would otherwise never finish and the sync would stop silently),
//   - the connection errors.
// A connection that keeps trickling bytes is not caught here; the overall
// deadline in runVacancySnapshot() handles that.
function makeHttp(transport, timeoutMs) {
  const tr = transport || https;
  const idleMs = timeoutMs || REQUEST_TIMEOUT_MS;
  return function http(options, body) {
    return new Promise((resolve, reject) => {
      const req = tr.request(options, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', reject);
        res.on('close', () => {
          if (!res.complete) reject(new Error('connection closed before the answer finished'));
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed;
          try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
          resolve({ statusCode: res.statusCode, headers: res.headers || {}, body: parsed });
        });
      });
      // Never let a stuck connection hold up the whole sync.
      req.setTimeout(idleMs, () => req.destroy(new Error('request timed out')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  };
}

const defaultHttp = makeHttp();

function errorDetail(body) {
  return oneLine(typeof body === 'object' ? JSON.stringify(body) : body);
}

function makeSupabase({ sbUrl, sbKey, http, readOnly }) {
  const hostname = new URL(sbUrl).hostname;
  const authHeaders = { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` };
  return {
    async get(pathAndQuery, extraHeaders) {
      const res = await http({
        hostname, path: pathAndQuery, method: 'GET',
        headers: Object.assign({}, authHeaders, extraHeaders || {}),
      });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new Error(`Supabase read of ${pathAndQuery.split('?')[0]} returned HTTP ${res.statusCode}: ${errorDetail(res.body)}`);
      }
      return res;
    },
    async upsert(rows) {
      if (readOnly) throw new Error('internal error: write attempted in dry-run');
      const body = JSON.stringify(rows);
      const res = await http({
        hostname, path: UPSERT_PATH, method: 'POST',
        headers: Object.assign({}, authHeaders, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Prefer': UPSERT_PREFER,
        }),
      }, body);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new Error(`Supabase save to ${TABLE} returned HTTP ${res.statusCode}: ${errorDetail(res.body)}`);
      }
    },
  };
}

async function lookupUnits(sb, afIds) {
  const map = new Map();
  for (const ids of chunk(afIds, LOOKUP_CHUNK)) {
    const res = await sb.get(`/rest/v1/units?select=id,appfolio_id,property_id&appfolio_id=in.(${ids.join(',')})`);
    if (!Array.isArray(res.body)) throw new Error('unexpected answer when looking up units');
    for (const u of res.body) {
      if (u && u.id && u.appfolio_id != null) map.set(String(u.appfolio_id), { id: u.id, property_id: u.property_id || null });
    }
  }
  return map;
}

async function lookupProperties(sb, afIds) {
  const map = new Map();
  for (const ids of chunk(afIds, LOOKUP_CHUNK)) {
    const res = await sb.get(`/rest/v1/properties?select=id,appfolio_id&appfolio_id=in.(${ids.join(',')})`);
    if (!Array.isArray(res.body)) throw new Error('unexpected answer when looking up properties');
    for (const p of res.body) {
      if (p && p.id && p.appfolio_id != null) map.set(String(p.appfolio_id), p.id);
    }
  }
  return map;
}

// How many rows the most recent saved day has (0 when the table is empty).
async function lastSavedDay(sb) {
  const latest = await sb.get(`/rest/v1/${TABLE}?select=snapshot_date&order=snapshot_date.desc&limit=1`);
  if (!Array.isArray(latest.body)) throw new Error('unexpected answer when reading the last saved day');
  if (latest.body.length === 0) return { date: null, count: 0 };
  const date = String(latest.body[0].snapshot_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('unexpected date when reading the last saved day');
  const counted = await sb.get(`/rest/v1/${TABLE}?select=unit_id&snapshot_date=eq.${date}&limit=1`, { 'Prefer': 'count=exact' });
  const m = /\/(\d+)$/.exec(String((counted.headers || {})['content-range'] || ''));
  if (!m) throw new Error('could not read the row count of the last saved day');
  return { date, count: Number(m[1]) };
}

// Saves in chunks. If a chunk is refused, retry its rows one by one so a
// single bad row cannot cost the other rows their day. Stops retrying after a
// few failures in a row (the database is probably down).
async function saveAll(sb, rows) {
  let upserted = 0;
  let failed = 0;
  let firstError = null;
  for (const group of chunk(rows, CHUNK_SIZE)) {
    try {
      await sb.upsert(group);
      upserted += group.length;
    } catch (groupErr) {
      firstError = firstError || oneLine(groupErr.message);
      let inARow = 0;
      for (const row of group) {
        if (inARow >= GIVE_UP_AFTER) { failed++; continue; }
        try {
          await sb.upsert([row]);
          upserted++;
          inARow = 0;
        } catch (rowErr) {
          failed++;
          inARow++;
        }
      }
    }
  }
  return { upserted, failed, firstError };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE STEP sync.js CALLS
// ─────────────────────────────────────────────────────────────────────────────

// `rows` = the raw rows of the unit_vacancy report. Never throws: any problem
// becomes one plain log line and the sync carries on exactly as before.
// Also never waits longer than the deadline (opts.deadlineMs, default 150 s):
// at that point it stops any request still open, writes nothing more, logs one
// line and returns normally, so the sync can go on to print its Summary.
async function runVacancySnapshot(opts) {
  const log = opts.log || console.log;
  const logError = opts.logError || console.error;
  const deadlineMs = opts.deadlineMs != null ? opts.deadlineMs : DEADLINE_MS;
  const baseHttp = opts.http || defaultHttp;
  const stop = new AbortController();
  const GAVE_UP = Symbol('gave up');

  // After the deadline nothing new may start and nothing more may be logged.
  const http = (options, body) => {
    if (stop.signal.aborted) return Promise.reject(new Error('snapshot step already stopped'));
    return baseHttp(Object.assign({}, options, { signal: stop.signal }), body);
  };
  const quietAfterStop = (fn) => (line) => { if (!stop.signal.aborted) fn(line); };

  let timer;
  try {
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(GAVE_UP), deadlineMs); });
    const inner = runInner(Object.assign({}, opts, { http }), quietAfterStop(log), quietAfterStop(logError));
    inner.catch(() => {}); // if we gave up, a late failure must not turn into an unhandled error
    const outcome = await Promise.race([inner, deadline]);
    if (outcome === GAVE_UP) {
      stop.abort();
      logError('[vacancy-snapshot] snapshot step gave up after waiting too long, nothing else affected.');
      return { status: 'gave_up', reason: 'deadline' };
    }
    return outcome;
  } catch (err) {
    logError(`[vacancy-snapshot] snapshot step failed, nothing else affected: ${oneLine(err && err.message)}`);
    return { status: 'failed', reason: oneLine(err && err.message) };
  } finally {
    clearTimeout(timer);
  }
}

async function runInner(opts, log, logError) {
  const { rows, dryRun, sbUrl, sbKey } = opts;
  const http = opts.http;
  const day = todayInLosAngeles(opts.now);
  const tag = '[vacancy-snapshot]';

  if (!Array.isArray(rows)) {
    logError(`${tag} ${day}: nothing written, the report rows were not available.`);
    return { status: 'skipped', reason: 'no report rows' };
  }
  if (rows.length === 0) {
    log(`${tag} ${day}: nothing written, the vacancy report returned 0 rows (not recorded as an empty day).`);
    return { status: 'skipped', reason: 'zero rows', seen: 0 };
  }
  if (!sbUrl || !sbKey) {
    log(`${tag} ${day}: ${dryRun ? 'DRY RUN, ' : ''}nothing written, database address or key not set (${rows.length} report rows seen).`);
    return { status: 'skipped', reason: 'no database credentials', seen: rows.length };
  }

  const sb = makeSupabase({ sbUrl, sbKey, http, readOnly: !!dryRun });

  // 1. Does this report look cut short compared with the last saved day?
  // opts.force exists only for a person running vacancy-snapshot.js by hand;
  // sync.js never passes it.
  const previous = await lastSavedDay(sb);
  const cutShort = looksTruncated(rows.length, previous.count);
  const forceNote = (opts.force && cutShort) ? ' [--force: the cut-short check was bypassed]' : '';
  if (cutShort && !opts.force) {
    log(`${tag} ${day}: nothing written, the report looks cut short (${rows.length} rows now vs ${previous.count} on ${previous.date}; limit is ${Math.round(MIN_FRACTION_OF_PREVIOUS * 100)}%).`);
    return { status: 'skipped', reason: 'truncated', seen: rows.length, previousCount: previous.count };
  }

  // 2. Find each unit (and, where the unit has none yet, its property).
  const afIds = Array.from(new Set(rows.map(r => cleanId(r && r.unit_id)).filter(Boolean)));
  const unitsByAfId = await lookupUnits(sb, afIds);
  const needProperty = new Set();
  for (const r of rows) {
    const unit = unitsByAfId.get(cleanId(r && r.unit_id));
    const afProp = cleanId(r && r.property_id);
    if (unit && !unit.property_id && afProp) needProperty.add(afProp);
  }
  const propsByAfId = needProperty.size ? await lookupProperties(sb, Array.from(needProperty)) : new Map();

  // 3. Map, validate, de-duplicate.
  const prepared = prepareSnapshot(rows, unitsByAfId, propsByAfId);
  const saveRows = prepared.entries.map(e => e.row);
  const skipText = prepared.skippedTotal ? ` (${describeSkips(prepared.skipped)})` : '';

  if (dryRun) {
    log(`${tag} DRY RUN, nothing is written. Report rows seen ${rows.length}, would save ${saveRows.length}, skipped ${prepared.skippedTotal}${skipText}. Last saved day: ${previous.date ? `${previous.date} (${previous.count} rows)` : 'none yet'}.${forceNote}`);
    log(`${tag} DRY RUN, AppFolio unit ids that would be saved: ${prepared.entries.map(e => e.afUnitId).join(', ') || '(none)'}`);
    const withRent = prepared.entries.filter(e => e.row.asking_rent != null || e.row.scheduled_rent != null);
    const sample = withRent.concat(prepared.entries.filter(e => !withRent.includes(e))).slice(0, 5);
    for (const e of sample) {
      log(`${tag} DRY RUN, sample unit ${e.afUnitId}: status=${e.row.unit_status} asking_rent=${e.row.asking_rent} scheduled_rent=${e.row.scheduled_rent} days_vacant=${e.row.days_vacant} property_linked=${e.row.property_id ? 'yes' : 'no'}`);
    }
    return { status: 'dry-run', seen: rows.length, wouldSave: saveRows.length, skipped: prepared.skipped, rows: saveRows };
  }

  if (saveRows.length === 0) {
    log(`${tag} ${day}: nothing written, none of the ${rows.length} report rows could be matched to a unit${skipText}.`);
    return { status: 'skipped', reason: 'no matching units', seen: rows.length, skipped: prepared.skipped };
  }

  // 4. Save.
  const saved = await saveAll(sb, saveRows);
  const failText = saved.failed ? `, ${saved.failed} FAILED to save (first error: ${saved.firstError})` : '';
  const line = `${tag} ${day}: report rows seen ${rows.length}, upserted ${saved.upserted}, skipped ${prepared.skippedTotal}${skipText}${failText}.${forceNote}`;
  (saved.failed ? logError : log)(line);
  return {
    status: saved.failed ? 'partial' : 'ok',
    seen: rows.length, upserted: saved.upserted, failed: saved.failed, skipped: prepared.skipped,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STAND-ALONE USE (optional): node vacancy-snapshot.js [--dry-run]
// ─────────────────────────────────────────────────────────────────────────────

const USAGE = [
  'vacancy-snapshot.js - save today\'s vacant-unit rents into unit_vacancy_snapshots',
  '',
  '  node vacancy-snapshot.js --dry-run   Show what would be saved. Writes nothing.',
  '  node vacancy-snapshot.js             Fetch the AppFolio unit_vacancy report and save the snapshot.',
  '  node vacancy-snapshot.js --force     Save even if the report looks cut short (fewer than 20% of the',
  '                                       last saved day). Only after checking the report yourself.',
  '  node vacancy-snapshot.js --help      Show this text.',
  '',
  'Uses ONE AppFolio request. Reads APPFOLIO_CLIENT_ID, APPFOLIO_CLIENT_SECRET,',
  'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the repo .env. The normal sync',
  'already does this step by itself; this is only for checking or re-running it.',
  'Any other option is refused, so a typo such as --dryrun can never cause a real write.',
].join('\n');

async function cli() {
  const args = process.argv.slice(2);
  const known = ['--dry-run', '--force', '--help', '-h'];
  const unknown = args.filter(a => !known.includes(a));
  if (unknown.length) {
    console.error(`Unknown option: ${unknown.join(' ')}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');
  require('dotenv').config({ path: path.join(__dirname, '../../.env') });
  const { APPFOLIO_CLIENT_ID, APPFOLIO_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!APPFOLIO_CLIENT_ID || !APPFOLIO_CLIENT_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('ERROR: APPFOLIO_CLIENT_ID, APPFOLIO_CLIENT_SECRET, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
    process.exitCode = 1;
    return;
  }
  console.log(dryRun ? 'DRY RUN: nothing will be written.' : 'REAL RUN: this writes to unit_vacancy_snapshots.');
  if (force) console.log('--force: the "report looks cut short" check will be skipped.');

  const body = '{}';
  const res = await defaultHttp({
    hostname: 'rinconpm.appfolio.com',
    path: '/api/v2/reports/unit_vacancy.json',
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${APPFOLIO_CLIENT_ID}:${APPFOLIO_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    console.error(`ERROR: AppFolio returned HTTP ${res.statusCode} for unit_vacancy.`);
    process.exitCode = 1;
    return;
  }
  const rows = Array.isArray(res.body) ? res.body : (res.body && Array.isArray(res.body.results) ? res.body.results : null);
  if (!rows) {
    console.error('ERROR: unit_vacancy answered in a shape this tool does not recognise.');
    process.exitCode = 1;
    return;
  }
  if (!Array.isArray(res.body) && res.body.next_page_url) {
    console.error('ERROR: the report has more than one page. Use the normal sync (node sync.js), which follows pages, instead.');
    process.exitCode = 1;
    return;
  }
  const result = await runVacancySnapshot({ rows, dryRun, force, sbUrl: SUPABASE_URL, sbKey: SUPABASE_SERVICE_ROLE_KEY });
  if (result.status === 'failed' || result.status === 'partial') process.exitCode = 1;
}

if (require.main === module) {
  cli().catch((err) => {
    console.error('ERROR:', oneLine(err && err.message));
    process.exitCode = 1;
  });
}

module.exports = {
  runVacancySnapshot,
  // exported so snapshot.test.js can check each piece on its own
  makeHttp,
  cleanId, cleanRent, cleanDays, mapUnitStatus, chunk,
  buildSnapshotRow, prepareSnapshot, looksTruncated,
  TABLE, UPSERT_PATH, UPSERT_PREFER, CHUNK_SIZE, DEADLINE_MS,
};
