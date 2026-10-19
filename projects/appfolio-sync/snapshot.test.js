'use strict';

/**
 * Tests for the daily vacancy snapshot (vacancy-snapshot.js and its hook in sync.js).
 *
 *   node snapshot.test.js
 *
 * Safe to run anywhere: nothing here talks to AppFolio or Supabase. Part 1 uses
 * a pretend database that is as strict as the real one (it refuses repeated
 * units in one save, bad foreign keys, uneven keys, negative numbers). Part 2
 * runs the real sync.js in a child process with every network call replaced by
 * canned answers, to prove a snapshot problem can never change the sync.
 * No tenant data is used: all fixtures are made up.
 *
 * TO TEST SALLY'S FILE: copy sync.js, vacancy-snapshot.js and snapshot.test.js
 * into one folder that also has node_modules (dotenv), then run
 * `node snapshot.test.js` there. The pretend network answers every link-up
 * step Sally's sync.js calls (see respond() below).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ─── SAFETY: these tests must NEVER touch the real AppFolio or the real database ───
// (Added after a deliberately broken copy of the code, run by the mutation checks,
// reached the real credentials through the repo's .env file and wrote 50 real rows.)
// 1. Every secret-looking setting is removed from this process, so nothing inherits it.
//    That covers known name families, anything ending in _KEY / _SECRET / _TOKEN /
//    _PASSWORD, and every NAME (never a value) listed in the repo's .env and .env.example.
// 2. The network is closed from three sides, and the attempts are recorded: https.request /
//    https.get throw, fetch is replaced, and the socket layer underneath (which http, https,
//    tls, http2 and fetch all use) refuses every host except this computer. The LAST test
//    fails the whole run if there was even one attempt, even if the code under test swallowed
//    the error.
// 3. Child processes (the sync and the command-line tool) run from a sandbox copy that has
//    no .env file above it and with the sandbox as their working folder, with pretend
//    credentials and a pretend network.
const SECRET_FAMILIES = /^(SUPABASE_|APPFOLIO_|GOOGLE_|GMAIL_|ANTHROPIC_|RENTCAST_|RECORE_|HUBSPOT_|MISSIVE_|LATCHEL_|LEADSIMPLE_|AIRCALL_|LEGISCAN_|LOCATIONIQ_|MAPTILER_|YOUTUBE_|CRON_|SESSION_|HUB_|B2_|ENABLE_)/;
const SECRET_ENDINGS = /(_KEY|_SECRET|_TOKEN|_PASSWORD|_PASS|_PASSPHRASE)$/;
const NEVER_SCRUB = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TZ', 'LANG', 'PWD', 'TERM', 'NODE_OPTIONS']);
function settingNamesIn(file) { // NAMES only: the part before "=" , never a value
  try {
    return fs.readFileSync(file, 'utf8').split('\n')
      .map((line) => /^\s*#?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line))
      .filter(Boolean).map((m) => m[1]);
  } catch (_) { return []; }
}
const LISTED_SETTING_NAMES = new Set(
  settingNamesIn(path.join(__dirname, '../../.env')).concat(settingNamesIn(path.join(__dirname, '../../.env.example')))
);
function isSecretSetting(name) {
  if (NEVER_SCRUB.has(name)) return false;
  return SECRET_FAMILIES.test(name) || SECRET_ENDINGS.test(name) || LISTED_SETTING_NAMES.has(name);
}
for (const key of Object.keys(process.env)) {
  if (isSecretSetting(key)) delete process.env[key];
}
const realNetworkAttempts = [];
(function blockRealNetwork() {
  const https = require('https');
  const http = require('http');
  const net = require('net');
  const refuse = (who, target) => {
    realNetworkAttempts.push(`${who} ${target}`);
    throw new Error(`REAL NETWORK BLOCKED BY TEST (${who} ${target})`);
  };
  const hostOf = (options) => (typeof options === 'string' ? options : ((options && (options.hostname || options.host)) || 'unknown'));
  https.request = (options) => refuse('https.request', hostOf(options));
  https.get = (options) => refuse('https.get', hostOf(options));
  const realHttpRequest = http.request;
  http.request = function (options, ...rest) {
    if (hostOf(options) !== '127.0.0.1') refuse('http.request', hostOf(options));
    return realHttpRequest.call(this, options, ...rest);
  };
  http.get = (options) => refuse('http.get', hostOf(options));

  // The socket layer: everything above (and fetch, tls, http2) ends up here.
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    let first = args[0];
    if (Array.isArray(first)) first = first[0]; // Node passes [options, callback] to itself
    let host = 'localhost';
    if (first && typeof first === 'object') host = first.path ? 'localhost' : (first.host || first.hostname || 'localhost');
    else if (typeof first === 'number') host = typeof args[1] === 'string' ? args[1] : 'localhost';
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) refuse('socket', host);
    return realConnect.apply(this, args);
  };

  globalThis.fetch = (url) => refuse('fetch', typeof url === 'string' ? url : String(url && url.url || url));
})();

const vs = require('./vacancy-snapshot');

const FAKE_URL = 'https://fake-project.supabase.test';
const FAKE_KEY = 'fake-service-key';

let passed = 0;
const failed = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed.push(name);
    console.log(`  FAIL  ${name}\n        ${err && err.message}`);
  }
}

// ─── fixtures ────────────────────────────────────────────────────────────────

// A made-up unit_vacancy row with the same field names AppFolio returns
// (checked on a real row, 2026-10-18), plus bait fields that must never be stored.
function rawRow(afId, extra) {
  return Object.assign({
    advertised_rent: '2750.00', posted_to_website: 'Yes', property: 'Example Plaza', property_name: 'Example Plaza',
    amenities: 'Bait: tenant Jane Doe 555-0100', address: '100 Example St', street: '100 Example St', city: 'Ventura',
    state: 'CA', zip: '93001', unit: '100 Example St', unit_status: 'Vacant-Unrented', rent_ready: 'Yes',
    days_vacant: 12, last_rent: '2600.00', schd_rent: '2750.00', new_rent: null,
    last_move_in: '2023-01-01', last_move_out: '2026-10-01', available_on: '2026-10-20',
    description: 'Bait: lease info for Jane Doe, jane@example.test', computed_market_rent: '2750.00',
    property_id: 500 + (afId % 7), unit_id: afId,
  }, extra || {});
}

function uuid(n) { return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`; }

// Pretend database. Models the real table's strictness.
function makeFakeDb(opts) {
  const o = Object.assign({ unitCount: 0, propertyLinked: true, previousDay: null, previousCount: 0, poisonUnits: [], saveStatus: null, readStatus: null, missingUnits: [] }, opts);
  const units = [];
  const propertyIds = new Set();
  for (let n = 1; n <= o.unitCount; n++) {
    if (o.missingUnits.includes(1000 + n)) continue;
    const afProp = 500 + ((1000 + n) % 7);
    propertyIds.add(uuid(9000 + afProp));
    units.push({ id: uuid(n), appfolio_id: String(1000 + n), property_id: o.propertyLinked ? uuid(9000 + afProp) : null });
  }
  const properties = [];
  for (let p = 500; p < 507; p++) { properties.push({ id: uuid(9000 + p), appfolio_id: String(p) }); propertyIds.add(uuid(9000 + p)); }
  const db = { requests: [], stored: new Map(), units, properties };

  db.http = async (options, body) => {
    const req = { method: options.method, hostname: options.hostname, path: options.path, headers: options.headers, body: body || null };
    db.requests.push(req);
    const p = options.path;
    const reply = (statusCode, b, headers) => ({ statusCode, headers: headers || {}, body: b });

    if (options.method === 'GET') {
      if (o.readStatus) return reply(o.readStatus, { message: 'pretend outage' });
      let m;
      if ((m = /^\/rest\/v1\/units\?.*appfolio_id=in\.\(([^)]*)\)$/.exec(p))) {
        const want = new Set(m[1].split(','));
        return reply(200, units.filter(u => want.has(u.appfolio_id)));
      }
      if ((m = /^\/rest\/v1\/properties\?.*appfolio_id=in\.\(([^)]*)\)$/.exec(p))) {
        const want = new Set(m[1].split(','));
        return reply(200, properties.filter(x => want.has(x.appfolio_id)));
      }
      if (/^\/rest\/v1\/unit_vacancy_snapshots\?select=snapshot_date&order=snapshot_date\.desc&limit=1$/.test(p)) {
        return reply(200, o.previousDay ? [{ snapshot_date: o.previousDay }] : []);
      }
      if ((m = /^\/rest\/v1\/unit_vacancy_snapshots\?select=unit_id&snapshot_date=eq\.(\d{4}-\d{2}-\d{2})&limit=1$/.exec(p))) {
        return reply(200, [], { 'content-range': `0-0/${o.previousCount}` });
      }
      return reply(404, { message: `unexpected GET ${p}` });
    }

    if (options.method === 'POST' && p === '/rest/v1/unit_vacancy_snapshots?on_conflict=unit_id,snapshot_date') {
      if (o.saveStatus) return reply(o.saveStatus, { message: 'pretend outage' });
      let rows;
      try { rows = JSON.parse(body); } catch (_) { return reply(400, { message: 'bad json' }); }
      if (!Array.isArray(rows)) return reply(400, { message: 'expected array' });
      const sig = new Set(rows.map(r => Object.keys(r).sort().join('|')));
      if (sig.size > 1) return reply(400, { code: 'PGRST102', message: 'All object keys must match' });
      const seen = new Set();
      for (const r of rows) {
        if (seen.has(r.unit_id)) return reply(500, { message: 'ON CONFLICT DO UPDATE command cannot affect row a second time' });
        seen.add(r.unit_id);
        if (!units.some(u => u.id === r.unit_id)) return reply(409, { message: 'foreign key violation on unit_id' });
        if (r.property_id != null && !propertyIds.has(r.property_id)) return reply(409, { message: 'foreign key violation on property_id' });
        if (!['occupied', 'vacant', 'notice', 'maintenance'].includes(r.unit_status)) return reply(400, { message: 'unit_status check' });
        if (r.asking_rent != null && r.asking_rent < 0) return reply(400, { message: 'asking_rent check' });
        if (r.scheduled_rent != null && r.scheduled_rent < 0) return reply(400, { message: 'scheduled_rent check' });
        if (r.days_vacant != null && (!Number.isInteger(r.days_vacant) || r.days_vacant < 0)) return reply(400, { message: 'days_vacant check' });
        if (o.poisonUnits.includes(r.unit_id)) return reply(400, { message: 'pretend bad row' });
      }
      for (const r of rows) db.stored.set(`${r.unit_id}|today`, r); // the database stamps the date; one row per unit per day
      return reply(201, '');
    }
    return reply(404, { message: `unexpected ${options.method} ${p}` });
  };
  return db;
}

function capture() {
  const lines = [];
  return { lines, log: (s) => lines.push(String(s)), logError: (s) => lines.push(String(s)) };
}

async function run(db, rows, extra) {
  const cap = capture();
  const result = await vs.runVacancySnapshot(Object.assign({ rows, sbUrl: FAKE_URL, sbKey: FAKE_KEY, http: db.http, log: cap.log, logError: cap.logError }, extra || {}));
  return { result, cap };
}

const posts = (db) => db.requests.filter(r => r.method === 'POST');
const ids = (n, from) => Array.from({ length: n }, (_, i) => (from || 1001) + i);

// ─── part 1: the pieces ──────────────────────────────────────────────────────

async function part1() {
  console.log('\nPart 1: the snapshot code against a pretend database');

  await test('rents: positive numbers kept, everything else becomes empty', () => {
    assert.strictEqual(vs.cleanRent('2750.00'), 2750);
    assert.strictEqual(vs.cleanRent('$1,234.5'), 1234.5);
    assert.strictEqual(vs.cleanRent(3000), 3000);
    assert.strictEqual(vs.cleanRent(2750.456), 2750.46);
    for (const bad of [0, '0.00', -5, '-1', 'abc', '', null, undefined, NaN, Infinity, 1e9, true, {}]) {
      assert.strictEqual(vs.cleanRent(bad), null, `expected null for ${String(bad)}`);
    }
  });

  await test('days vacant: whole numbers 0 and up, everything else becomes empty', () => {
    assert.strictEqual(vs.cleanDays(0), 0);
    assert.strictEqual(vs.cleanDays('12'), 12);
    assert.strictEqual(vs.cleanDays(1637), 1637);
    assert.strictEqual(vs.cleanDays(1.6), 2);
    for (const bad of [-1, 'x', '', null, undefined, NaN, 1e9]) assert.strictEqual(vs.cleanDays(bad), null);
  });

  await test('ids: plain ids are trimmed, odd values rejected', () => {
    assert.strictEqual(vs.cleanId(259), '259');
    assert.strictEqual(vs.cleanId(' 259 '), '259');
    for (const bad of [null, undefined, '', 'null', 'undefined', 'a b', '1;drop table', '1),(2', 'x'.repeat(50)]) assert.strictEqual(vs.cleanId(bad), null);
  });

  await test('status: "Notice-..." becomes notice, everything else vacant', () => {
    assert.strictEqual(vs.mapUnitStatus('Notice-Unrented'), 'notice');
    assert.strictEqual(vs.mapUnitStatus('Vacant-Unrented'), 'vacant');
    assert.strictEqual(vs.mapUnitStatus('Vacant-Rented'), 'vacant');
    assert.strictEqual(vs.mapUnitStatus(null), 'vacant');
  });

  await test('mapping a raw row: exactly the six listed fields, asking rent is advertised_rent, no snapshot_date', () => {
    const row = vs.buildSnapshotRow(rawRow(1001, { new_rent: '9999.00' }), uuid(1), uuid(9500));
    assert.deepStrictEqual(row, {
      unit_id: uuid(1), property_id: uuid(9500), unit_status: 'vacant',
      asking_rent: 2750, scheduled_rent: 2750, days_vacant: 12,
    });
    assert.ok(!('snapshot_date' in row));
    assert.deepStrictEqual(Object.keys(row).sort(), ['asking_rent', 'days_vacant', 'property_id', 'scheduled_rent', 'unit_id', 'unit_status']);
  });

  await test('mapping: blanks are explicit nulls (every key always present)', () => {
    const row = vs.buildSnapshotRow(rawRow(1001, { advertised_rent: null, schd_rent: null, days_vacant: null, unit_status: 'Notice-Unrented' }), uuid(1), null);
    assert.deepStrictEqual(row, { unit_id: uuid(1), property_id: null, unit_status: 'notice', asking_rent: null, scheduled_rent: null, days_vacant: null });
  });

  await test('prepare: repeated unit is reduced to one row (later wins) and counted', () => {
    const units = new Map([['1001', { id: uuid(1), property_id: null }]]);
    const out = vs.prepareSnapshot([rawRow(1001, { schd_rent: '1000.00', advertised_rent: '1000.00' }), rawRow(1001, { schd_rent: '1200.00', advertised_rent: '1200.00' })], units, new Map());
    assert.strictEqual(out.entries.length, 1);
    assert.strictEqual(out.entries[0].row.asking_rent, 1200);
    assert.strictEqual(out.skipped.duplicate, 1);
  });

  await test('prepare: unknown unit, missing id and junk rows are skipped and counted, not fatal', () => {
    const units = new Map([['1001', { id: uuid(1), property_id: uuid(9500) }]]);
    const out = vs.prepareSnapshot([rawRow(1001), rawRow(4242), rawRow(null), null, 'junk', 7], units, new Map());
    assert.strictEqual(out.entries.length, 1);
    assert.deepStrictEqual(out.skipped, { bad_row: 3, no_unit_id: 1, unit_not_in_database: 1, duplicate: 0 });
    assert.strictEqual(out.skippedTotal, 5);
  });

  await test('prepare: unit property is used first; the report property only fills a gap', () => {
    const units = new Map([['1001', { id: uuid(1), property_id: uuid(111) }], ['1002', { id: uuid(2), property_id: null }], ['1003', { id: uuid(3), property_id: null }]]);
    const props = new Map([['503', uuid(222)], ['501', uuid(333)]]);
    const out = vs.prepareSnapshot([rawRow(1001, { property_id: 501 }), rawRow(1002, { property_id: 503 }), rawRow(1003, { property_id: 999 })], units, props);
    assert.deepStrictEqual(out.entries.map(e => e.row.property_id), [uuid(111), uuid(222), null]);
  });

  await test('truncation rule: fewer than 20% of the last saved day is cut short', () => {
    assert.strictEqual(vs.looksTruncated(9, 50), true);
    assert.strictEqual(vs.looksTruncated(10, 50), false);
    assert.strictEqual(vs.looksTruncated(0, 50), true);
    assert.strictEqual(vs.looksTruncated(3, 0), false); // no history yet: nothing to compare with
    assert.strictEqual(vs.looksTruncated(50, 50), false);
  });

  await test('chunking: 250 rows go out as 100 + 100 + 50, no repeated unit anywhere', async () => {
    assert.deepStrictEqual(vs.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    const db = makeFakeDb({ unitCount: 250 });
    const { result } = await run(db, ids(250).map(n => rawRow(n)));
    assert.strictEqual(result.status, 'ok');
    assert.deepStrictEqual(posts(db).map(r => JSON.parse(r.body).length), [100, 100, 50]);
    assert.strictEqual(db.stored.size, 250);
  });

  await test('happy path: one save, URL / method / headers / body exactly as agreed', async () => {
    const db = makeFakeDb({ unitCount: 5, previousDay: '2026-10-17', previousCount: 5 });
    const { result, cap } = await run(db, ids(5).map(n => rawRow(n)));
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.upserted, 5);
    const sent = posts(db);
    assert.strictEqual(sent.length, 1);
    const req = sent[0];
    assert.strictEqual(req.method, 'POST');
    assert.strictEqual(req.hostname, 'fake-project.supabase.test');
    assert.strictEqual(req.path, '/rest/v1/unit_vacancy_snapshots?on_conflict=unit_id,snapshot_date');
    assert.strictEqual(req.headers.Prefer, 'resolution=merge-duplicates');
    assert.strictEqual(req.headers.apikey, FAKE_KEY);
    assert.strictEqual(req.headers.Authorization, `Bearer ${FAKE_KEY}`);
    assert.strictEqual(req.headers['Content-Type'], 'application/json');
    assert.strictEqual(req.headers['Content-Length'], Buffer.byteLength(req.body));
    assert.deepStrictEqual(Object.keys(req.headers).sort(), ['Authorization', 'Content-Length', 'Content-Type', 'Prefer', 'apikey']);
    const rows = JSON.parse(req.body);
    assert.strictEqual(rows.length, 5);
    for (const r of rows) {
      assert.deepStrictEqual(Object.keys(r).sort(), ['asking_rent', 'days_vacant', 'property_id', 'scheduled_rent', 'unit_id', 'unit_status']);
    }
    assert.strictEqual(new Set(rows.map(r => r.unit_id)).size, 5);
    assert.ok(!req.body.includes('snapshot_date'), 'snapshot_date must be left to the database');
    assert.strictEqual(cap.lines.length, 1, 'one log line per run');
    assert.match(cap.lines[0], /report rows seen 5, upserted 5, skipped 0\./);
  });

  await test('no personal data: bait names, phones, emails and lease dates never reach the database', async () => {
    const db = makeFakeDb({ unitCount: 3 });
    await run(db, ids(3).map(n => rawRow(n)));
    const body = posts(db)[0].body;
    for (const bait of ['Jane', 'Doe', '555-', 'example.test', '2023-01-01', '2026-10-01', 'Example Plaza', 'Bait']) {
      assert.ok(!body.includes(bait), `found "${bait}" in what was sent`);
    }
  });

  await test('running twice in one day leaves one row per unit (latest state wins)', async () => {
    const db = makeFakeDb({ unitCount: 4 });
    await run(db, ids(4).map(n => rawRow(n, { advertised_rent: '2000.00', schd_rent: '2000.00' })));
    await run(db, ids(4).map(n => rawRow(n, { advertised_rent: '1900.00', schd_rent: '1900.00' })));
    assert.strictEqual(db.stored.size, 4);
    assert.ok([...db.stored.values()].every(r => r.asking_rent === 1900));
  });

  await test('date label follows Los Angeles time (the database stamps the real date)', async () => {
    const db = makeFakeDb({ unitCount: 1 });
    const { cap } = await run(db, [rawRow(1001)], { now: new Date('2026-10-19T03:30:00Z') });
    assert.match(cap.lines[0], /2026-10-18/);
  });

  await test('unit missing from the database: skipped and counted, the rest of the batch still saves', async () => {
    const db = makeFakeDb({ unitCount: 5, missingUnits: [1003] });
    const { result, cap } = await run(db, ids(5).map(n => rawRow(n)));
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.upserted, 4);
    assert.strictEqual(posts(db).length, 1, 'still one batch');
    assert.match(cap.lines[0], /seen 5, upserted 4, skipped 1 \(1 unit not in database\)/);
  });

  await test('a unit repeated in the report cannot sink the batch (the database would refuse it)', async () => {
    const db = makeFakeDb({ unitCount: 3 });
    const rows = [rawRow(1001), rawRow(1002), rawRow(1002), rawRow(1003), rawRow(1001)];
    const { result, cap } = await run(db, rows);
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.upserted, 3);
    assert.match(cap.lines[0], /seen 5, upserted 3, skipped 2 \(2 repeated unit\)/);
  });

  await test('property gap filled from the report; unit with no property anywhere is saved with an empty property', async () => {
    const db = makeFakeDb({ unitCount: 3, propertyLinked: false });
    const { result } = await run(db, [rawRow(1001), rawRow(1002), rawRow(1003, { property_id: 99999 })]);
    assert.strictEqual(result.status, 'ok');
    const sent = JSON.parse(posts(db)[0].body);
    assert.ok(sent[0].property_id && sent[1].property_id);
    assert.strictEqual(sent[2].property_id, null);
  });

  await test('one refused row cannot cost the others their day (retry one by one)', async () => {
    const db = makeFakeDb({ unitCount: 5, poisonUnits: [uuid(3)] });
    const { result, cap } = await run(db, ids(5).map(n => rawRow(n)));
    assert.strictEqual(result.status, 'partial');
    assert.strictEqual(result.upserted, 4);
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(db.stored.size, 4);
    assert.match(cap.lines[0], /upserted 4, skipped 0, 1 FAILED to save/);
  });

  await test('database down while saving: no crash, gives up quickly, no deletes', async () => {
    const db = makeFakeDb({ unitCount: 20, saveStatus: 503 });
    const { result } = await run(db, ids(20).map(n => rawRow(n)));
    assert.strictEqual(result.status, 'partial');
    assert.strictEqual(result.upserted, 0);
    assert.strictEqual(result.failed, 20);
    assert.ok(posts(db).length <= 4, `too many retries: ${posts(db).length}`);
    assert.ok(db.requests.every(r => r.method === 'GET' || r.method === 'POST'));
  });

  await test('lookup problem: reported as one line, nothing written, never thrown', async () => {
    const db = makeFakeDb({ unitCount: 3, readStatus: 500 });
    const { result, cap } = await run(db, ids(3).map(n => rawRow(n)));
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(posts(db).length, 0);
    assert.strictEqual(cap.lines.length, 1);
    assert.match(cap.lines[0], /snapshot step failed, nothing else affected/);
  });

  await test('even an exception thrown by the network layer is caught', async () => {
    const cap = capture();
    const result = await vs.runVacancySnapshot({
      rows: [rawRow(1001)], sbUrl: FAKE_URL, sbKey: FAKE_KEY,
      http: () => { throw new Error('socket exploded'); }, log: cap.log, logError: cap.logError,
    });
    assert.strictEqual(result.status, 'failed');
    assert.match(cap.lines[0], /socket exploded/);
  });

  await test('report returned zero rows: nothing written, not even a lookup', async () => {
    const db = makeFakeDb({ unitCount: 3, previousDay: '2026-10-17', previousCount: 50 });
    const { result, cap } = await run(db, []);
    assert.strictEqual(result.status, 'skipped');
    assert.strictEqual(db.requests.length, 0);
    assert.match(cap.lines[0], /returned 0 rows/);
  });

  await test('report not an array: nothing written', async () => {
    const db = makeFakeDb({ unitCount: 1 });
    const { result } = await run(db, undefined);
    assert.strictEqual(result.status, 'skipped');
    assert.strictEqual(db.requests.length, 0);
  });

  await test('report looks cut short (5 rows vs 50 yesterday): nothing written', async () => {
    const db = makeFakeDb({ unitCount: 50, previousDay: '2026-10-17', previousCount: 50 });
    const { result, cap } = await run(db, ids(5).map(n => rawRow(n)));
    assert.strictEqual(result.status, 'skipped');
    assert.strictEqual(result.reason, 'truncated');
    assert.strictEqual(posts(db).length, 0);
    assert.match(cap.lines[0], /looks cut short \(5 rows now vs 50 on 2026-10-17/);
  });

  await test('exactly 20% of yesterday is accepted; first ever run (no history) is accepted', async () => {
    const edge = makeFakeDb({ unitCount: 10, previousDay: '2026-10-17', previousCount: 50 });
    assert.strictEqual((await run(edge, ids(10).map(n => rawRow(n)))).result.status, 'ok');
    const first = makeFakeDb({ unitCount: 3 });
    assert.strictEqual((await run(first, ids(3).map(n => rawRow(n)))).result.status, 'ok');
  });

  await test('days vacant: NULL when AppFolio has no move-out date (its 0 means unknown), a real number otherwise', () => {
    const days = (x) => vs.buildSnapshotRow(rawRow(1001, x), uuid(1), null).days_vacant;
    // real shapes seen on the live report
    assert.strictEqual(days({ days_vacant: 0, last_move_out: null }), null, 'zero days + no move-out date = unknown');
    assert.strictEqual(days({ days_vacant: 0, last_move_out: '' }), null, 'empty text counts as no date');
    assert.strictEqual(days({ days_vacant: 0, last_move_out: '   ' }), null);
    assert.strictEqual(days({ days_vacant: 0, last_move_out: undefined }), null);
    assert.strictEqual(days({ days_vacant: 227, last_move_out: '2026-03-05' }), 227, 'real number kept');
    assert.strictEqual(days({ days_vacant: 1637, last_move_out: '2022-04-25' }), 1637);
    assert.strictEqual(days({ days_vacant: 0, last_move_out: '2026-10-18' }), 0, 'moved out within a day: a genuine 0 is kept');
    assert.strictEqual(days({ unit_status: 'Notice-Unrented', days_vacant: null, last_move_out: '2026-10-20' }), null, 'notice rows have blank days');
    assert.strictEqual(days({ unit_status: 'Notice-Unrented', days_vacant: null, last_move_out: '2026-10-20' }), null);
    assert.strictEqual(days({ days_vacant: 11, last_move_out: '2026-10-07' }), 11);
  });

  await test('days vacant on a whole report: unknown and notice rows are NULL, the rest keep their number', async () => {
    const db = makeFakeDb({ unitCount: 5 });
    const rows = [
      rawRow(1001, { days_vacant: 0, last_move_out: null }),                                    // unknown
      rawRow(1002, { days_vacant: 227, last_move_out: '2026-03-05' }),                          // real
      rawRow(1003, { days_vacant: 0, last_move_out: '2026-10-18' }),                            // real zero
      rawRow(1004, { unit_status: 'Notice-Unrented', days_vacant: null, last_move_out: '2026-11-08' }), // notice
      rawRow(1005, { days_vacant: 0, last_move_out: null }),                                    // unknown
    ];
    const { result } = await run(db, rows);
    assert.strictEqual(result.status, 'ok');
    const sent = JSON.parse(posts(db)[0].body);
    assert.deepStrictEqual(sent.map(r => r.days_vacant), [null, 227, 0, null, null]);
  });

  await test('--force (manual use) bypasses the cut-short check and says so; without it the run is skipped', async () => {
    const db1 = makeFakeDb({ unitCount: 5, previousDay: '2026-10-17', previousCount: 50 });
    const skipped = (await run(db1, ids(5).map(n => rawRow(n)))).result;
    assert.strictEqual(skipped.status, 'skipped');
    assert.strictEqual(posts(db1).length, 0);
    const db2 = makeFakeDb({ unitCount: 5, previousDay: '2026-10-17', previousCount: 50 });
    const forced = await run(db2, ids(5).map(n => rawRow(n)), { force: true });
    assert.strictEqual(forced.result.status, 'ok');
    assert.strictEqual(posts(db2).length, 1);
    assert.match(forced.cap.lines[0], /\[--force: the cut-short check was bypassed\]/);
    const db3 = makeFakeDb({ unitCount: 5, previousDay: '2026-10-17', previousCount: 50 });
    const zero = await run(db3, [], { force: true });
    assert.strictEqual(zero.result.status, 'skipped', '--force never lets an EMPTY report through');
  });

  await test('the sync hook can never use --force (it is not in the sync.js hook, so cron cannot reach it)', () => {
    const src = fs.readFileSync(SYNC_JS, 'utf8');
    const start = src.indexOf('Daily vacancy snapshot');
    const end = src.indexOf('=== Summary ===', start);
    assert.ok(start > 0 && end > start, 'could not find the snapshot hook in sync.js');
    const hook = src.slice(start, end);
    assert.ok(/runVacancySnapshot\(/.test(hook));
    assert.ok(!/force/i.test(hook), 'the hook must not pass force');
  });

  await test('dry run: shows counts, unit ids and sample rents; sends only reads', async () => {
    const db = makeFakeDb({ unitCount: 6 });
    const { result, cap } = await run(db, ids(6).map(n => rawRow(n)), { dryRun: true });
    assert.strictEqual(result.status, 'dry-run');
    assert.strictEqual(result.wouldSave, 6);
    assert.ok(db.requests.length > 0 && db.requests.every(r => r.method === 'GET'), 'dry run must only read');
    assert.strictEqual(db.stored.size, 0);
    const text = cap.lines.join('\n');
    assert.match(text, /DRY RUN, nothing is written\. Report rows seen 6, would save 6, skipped 0/);
    assert.match(text, /unit ids that would be saved: 1001, 1002, 1003, 1004, 1005, 1006/);
    assert.match(text, /sample unit 1001: status=vacant asking_rent=2750 scheduled_rent=2750 days_vacant=12/);
  });
}

// ─── part 1b: bad connections, using Node's real http module on this computer ───

const nodeHttp = require('http');

async function withServer(handler, fn) {
  const sockets = new Set();
  const server = nodeHttp.createServer(handler);
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(server.address().port, sockets);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

// Wait for a promise, but never longer than ms (so a hang shows up as a failed test, not a stuck test run).
function settleWithin(promise, ms) {
  return Promise.race([
    promise.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
    new Promise((resolve) => setTimeout(() => resolve({ hung: true }), ms)),
  ]);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const aim = (port) => ({ hostname: '127.0.0.1', port, path: '/x', method: 'GET', headers: {} });

async function part1b() {
  console.log('\nPart 1b: bad connections (real Node http against a local server)');

  await test('connection: a normal answer comes back with status, headers and parsed body', async () => {
    await withServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-range': '0-0/7' }); res.end('{"hello":1}'); }, async (port) => {
      const out = await settleWithin(vs.makeHttp(nodeHttp, 2000)(aim(port)), 3000);
      assert.ok(out.ok, 'request failed');
      assert.strictEqual(out.v.statusCode, 200);
      assert.deepStrictEqual(out.v.body, { hello: 1 });
      assert.strictEqual(out.v.headers['content-range'], '0-0/7');
    });
  });

  // Node reports a cut connection through two routes at once ('error' and 'close'),
  // so a real server cannot tell which handler did the work. These feed each route alone.
  const fakeTransport = (script) => ({
    request(options, cb) {
      const { EventEmitter } = require('events');
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.destroy = () => {};
      req.write = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = {};
        res.complete = false;
        cb(res);
        script(res);
      };
      return req;
    },
  });

  await test('connection: closing before the answer is complete (no error event) counts as a failure', async () => {
    const t = fakeTransport((res) => { res.emit('data', Buffer.from('{"a":')); res.emit('close'); });
    const out = await settleWithin(vs.makeHttp(t, 10000)(aim(1)), 1000);
    assert.ok(!out.hung, 'never settled');
    assert.strictEqual(out.ok, false);
    assert.match(out.e.message, /connection closed before the answer finished/);
  });

  await test('connection: an error while the answer is arriving (no close event) counts as a failure', async () => {
    const t = fakeTransport((res) => {
      if (res.listenerCount('error') === 0) throw new Error('nobody is listening for errors on the answer');
      res.emit('data', Buffer.from('{"a":'));
      res.emit('error', new Error('socket hang up'));
    });
    const out = await settleWithin(vs.makeHttp(t, 10000)(aim(1)), 1000);
    assert.ok(!out.hung, 'never settled');
    assert.strictEqual(out.ok, false);
    assert.match(out.e.message, /socket hang up/);
  });

  await test('connection: a complete answer followed by the normal close is a success (not mistaken for a cut)', async () => {
    const t = fakeTransport((res) => {
      res.emit('data', Buffer.from('{"ok":true}'));
      res.complete = true;
      res.emit('end');
      res.emit('close');
    });
    const out = await settleWithin(vs.makeHttp(t, 10000)(aim(1)), 1000);
    assert.ok(out.ok);
    assert.deepStrictEqual(out.v.body, { ok: true });
  });

  await test('connection cut off in the middle of the answer (clean close): fails fast instead of hanging', async () => {
    await withServer((req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('{"a":');
      setTimeout(() => req.socket.end(), 30);
    }, async (port) => {
      const started = Date.now();
      const out = await settleWithin(vs.makeHttp(nodeHttp, 10000)(aim(port)), 3000);
      assert.ok(!out.hung, 'the request never finished (this is the silent-exit bug)');
      assert.strictEqual(out.ok, false);
      assert.ok(Date.now() - started < 2500, 'should fail because of the cut, not the 10 s idle timeout');
      assert.ok(!/timed out/.test(out.e.message), out.e.message);
    });
  });

  await test('connection cut off in the middle of the answer (hard reset): fails fast instead of hanging', async () => {
    await withServer((req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('{"a":');
      setTimeout(() => { if (req.socket.resetAndDestroy) req.socket.resetAndDestroy(); else req.socket.destroy(); }, 30);
    }, async (port) => {
      const started = Date.now();
      const out = await settleWithin(vs.makeHttp(nodeHttp, 10000)(aim(port)), 3000);
      assert.ok(!out.hung, 'the request never finished (this is the silent-exit bug)');
      assert.strictEqual(out.ok, false);
      assert.ok(Date.now() - started < 2500);
    });
  });

  await test('connection goes silent in the middle of the answer: fails when the idle timeout passes', async () => {
    await withServer((req, res) => { res.writeHead(200, { 'content-length': '1000' }); res.write('{"a":'); }, async (port) => {
      const out = await settleWithin(vs.makeHttp(nodeHttp, 300)(aim(port)), 3000);
      assert.ok(!out.hung, 'the request never finished');
      assert.strictEqual(out.ok, false);
      assert.match(out.e.message, /timed out/);
    });
  });

  await test('connection that never answers at all: fails when the idle timeout passes', async () => {
    await withServer(() => { /* never answers */ }, async (port) => {
      const out = await settleWithin(vs.makeHttp(nodeHttp, 300)(aim(port)), 3000);
      assert.ok(!out.hung);
      assert.strictEqual(out.ok, false);
      assert.match(out.e.message, /timed out/);
    });
  });

  await test('slow drip (a byte every 40 ms, never finishes): the idle timeout alone cannot catch it, the 150 s deadline step does', async () => {
    let serverSawClose = false;
    await withServer((req, res) => {
      res.writeHead(200, { 'content-length': '100000' });
      const t = setInterval(() => res.write('x'), 40);
      res.on('close', () => { serverSawClose = true; clearInterval(t); });
    }, async (port) => {
      const lone = await settleWithin(vs.makeHttp(nodeHttp, 300)(aim(port)), 1000);
      assert.ok(lone.hung, 'a drip is not caught by the idle timeout, which is why the deadline exists');
      serverSawClose = false;
      // now through the real step, aimed at the local server, with a short deadline
      const local = vs.makeHttp(nodeHttp, 300);
      const cap = capture();
      const started = Date.now();
      const out = await settleWithin(vs.runVacancySnapshot({
        rows: [rawRow(1001)], sbUrl: FAKE_URL, sbKey: FAKE_KEY, deadlineMs: 400, log: cap.log, logError: cap.logError,
        http: (options, body) => local(Object.assign({}, options, { hostname: '127.0.0.1', port }), body),
      }), 4000);
      assert.ok(!out.hung, 'the step did not stop at its deadline');
      assert.strictEqual(out.v.status, 'gave_up');
      assert.ok(Date.now() - started < 3000);
      assert.deepStrictEqual(cap.lines, ['[vacancy-snapshot] snapshot step gave up after waiting too long, nothing else affected.']);
      for (let i = 0; i < 20 && !serverSawClose; i++) await sleep(50);
      assert.ok(serverSawClose, 'the open connection should be closed when the step gives up');
    });
  });

  await test('deadline: a request that never settles cannot hold the step past deadlineMs', async () => {
    const cap = capture();
    const started = Date.now();
    const out = await settleWithin(vs.runVacancySnapshot({
      rows: [rawRow(1001)], sbUrl: FAKE_URL, sbKey: FAKE_KEY, deadlineMs: 200, log: cap.log, logError: cap.logError,
      http: () => new Promise(() => {}),
    }), 3000);
    assert.ok(!out.hung);
    assert.strictEqual(out.v.status, 'gave_up');
    assert.ok(Date.now() - started < 1500);
    assert.deepStrictEqual(cap.lines, ['[vacancy-snapshot] snapshot step gave up after waiting too long, nothing else affected.']);
  });

  await test('after the deadline nothing more is written or logged, even if slow requests finish later', async () => {
    const db = makeFakeDb({ unitCount: 5 });
    const cap = capture();
    const slow = (options, body) => new Promise((resolve) => setTimeout(() => resolve(db.http(options, body)), 150));
    const out = await vs.runVacancySnapshot({
      rows: ids(5).map(n => rawRow(n)), sbUrl: FAKE_URL, sbKey: FAKE_KEY, deadlineMs: 250, http: slow, log: cap.log, logError: cap.logError,
    });
    assert.strictEqual(out.status, 'gave_up');
    await sleep(1200); // let every slow request finish
    assert.strictEqual(posts(db).length, 0, 'a write happened after the step gave up');
    assert.strictEqual(cap.lines.length, 1, `extra log lines after giving up: ${cap.lines.join(' | ')}`);
  });

  await test('a normal run does not trip the deadline and leaves no timer behind', async () => {
    const db = makeFakeDb({ unitCount: 3 });
    const { result, cap } = await run(db, ids(3).map(n => rawRow(n)), { deadlineMs: 5000 });
    assert.strictEqual(result.status, 'ok');
    assert.ok(!cap.lines.join('').includes('gave up'));
  });
}

// ─── part 2: the real sync.js, with every network call replaced ───────────────

const SYNC_JS = path.join(__dirname, 'sync.js');

const PRELOAD = `
'use strict';
const fs = require('fs');
const https = require('https');
const Module = require('module');
const { EventEmitter } = require('events');
const scenario = JSON.parse(fs.readFileSync(process.env.SNAPSHOT_TEST_SCENARIO, 'utf8'));
const logFile = process.env.SNAPSHOT_TEST_LOG;
const note = (o) => fs.appendFileSync(logFile, JSON.stringify(o) + '\\n');
note({ kind: 'preload' });

// the sync waits exactly 15 s between report batches; do not wait in tests.
// (Only that one value is skipped: the snapshot's own 150 s deadline timer stays real.)
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms === 15000 ? 0 : ms, ...a);

// no real e-mail can ever go out: record the attempt instead
const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'googleapis') {
    return { google: {
      auth: { OAuth2: class { setCredentials() {} } },
      gmail: () => ({ users: { messages: { send: async () => { note({ kind: 'ALERT_EMAIL_ATTEMPT' }); } } } }),
    } };
  }
  if (/vacancy-snapshot$/.test(request) && scenario.moduleLoad === 'missing') throw new Error("Cannot find module './vacancy-snapshot'");
  if (/vacancy-snapshot$/.test(request) && scenario.moduleLoad === 'throws') return { runVacancySnapshot: async () => { throw new Error('pretend snapshot crash'); } };
  return realLoad.apply(this, arguments);
};

function respond(e) {
  if (e.host === 'rinconpm.appfolio.com') {
    const name = (/reports\\/([a-z_]+)\\.json/.exec(e.path) || [])[1];
    if ((scenario.appfolioFail || []).includes(name)) return { status: 500, body: { error: 'pretend outage' } };
    if (name === 'unit_vacancy') return { status: 200, body: { results: scenario.vacancyRows, next_page_url: null } };
    return { status: 200, body: { results: [], next_page_url: null } };
  }
  if (e.host === 'fake-project.supabase.test') {
    const p = e.path;
    if (p.startsWith('/rest/v1/rpc/resolve_appfolio_foreign_keys')) return { status: 200, body: { units_linked: 0, leases_units: 0, leases_tenants: 0, mr_units: 0 } };
    if (p.startsWith('/rest/v1/rpc/resolve_lease_tenant_foreign_keys')) return { status: 200, body: { lease_tenants_leases: 0, lease_tenants_tenants: 0 } };
    // the two extra link-up steps that Sally's sync.js has (main's does not)
    if (p.startsWith('/rest/v1/rpc/resolve_tenant_email_foreign_keys')) return { status: 200, body: { tenant_emails_resolved: 0 } };
    if (p.startsWith('/rest/v1/rpc/resolve_owner_email_foreign_keys')) return { status: 200, body: { owner_emails_resolved: 0 } };
    if (p.startsWith('/rest/v1/units?select=id,appfolio_id,property_id')) {
      if (scenario.snapshotReadStatus) return { status: scenario.snapshotReadStatus, body: { message: 'pretend outage' } };
      const m = /in\\.\\(([^)]*)\\)/.exec(p);
      const want = new Set(m ? m[1].split(',') : []);
      return { status: 200, body: scenario.units.filter(u => want.has(u.appfolio_id)) };
    }
    if (p.startsWith('/rest/v1/properties?')) return { status: 200, body: [] };
    if (p.startsWith('/rest/v1/unit_vacancy_snapshots?select=snapshot_date')) {
      if (scenario.snapshotReadStatus) return { status: scenario.snapshotReadStatus, body: { message: 'pretend outage' } };
      return { status: 200, body: scenario.previousDay ? [{ snapshot_date: scenario.previousDay }] : [] };
    }
    if (p.startsWith('/rest/v1/unit_vacancy_snapshots?select=unit_id')) return { status: 200, body: [], headers: { 'content-range': '0-0/' + (scenario.previousCount || 0) } };
    if (e.method === 'POST' && p.startsWith('/rest/v1/unit_vacancy_snapshots')) return { status: scenario.snapshotPostStatus || 201, body: scenario.snapshotPostStatus ? { message: 'pretend outage' } : '' };
    if (e.method === 'POST' && p.startsWith('/rest/v1/')) return { status: 201, body: '' };
  }
  note({ kind: 'BLOCKED', host: e.host, path: e.path });
  return { networkError: 'blocked by test' };
}

https.request = function (options, cb) {
  const req = new EventEmitter();
  const chunks = [];
  req.write = (c) => { chunks.push(Buffer.from(c)); };
  req.setTimeout = () => req;
  req.destroy = (err) => { if (err) req.emit('error', err); };
  req.end = () => {
    const entry = { kind: 'req', host: options.hostname, method: options.method, path: options.path, headers: options.headers, body: Buffer.concat(chunks).toString() };
    note(entry);
    const reply = respond(entry);
    setImmediate(() => {
      if (reply.networkError) return req.emit('error', new Error(reply.networkError));
      const res = new EventEmitter();
      res.statusCode = reply.status;
      res.headers = reply.headers || {};
      cb(res);
      res.emit('data', Buffer.from(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)));
      res.emit('end');
    });
  };
  return req;
};
`;

// The sandbox: a temporary folder holding copies of sync.js and vacancy-snapshot.js two
// levels down (box/a/b), so the "../../.env" they look for resolves to box/.env, which
// does not exist. Real credentials therefore cannot be loaded, whatever the code does.
let sandboxDir = null;
function getSandbox() {
  if (sandboxDir) return sandboxDir;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
  const inner = path.join(tmp, 'box', 'a', 'b');
  fs.mkdirSync(inner, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'preload.js'), PRELOAD);
  for (const f of ['sync.js', 'vacancy-snapshot.js']) fs.copyFileSync(path.join(__dirname, f), path.join(inner, f));
  fs.symlinkSync(path.join(__dirname, 'node_modules'), path.join(inner, 'node_modules'), 'dir'); // only for dotenv
  assert.ok(!fs.existsSync(path.join(tmp, 'box', '.env')), 'the sandbox must not have a .env file');
  sandboxDir = tmp;
  return tmp;
}
function removeSandbox() {
  if (sandboxDir) fs.rmSync(sandboxDir, { recursive: true, force: true });
  sandboxDir = null;
}

// Runs one of the sandbox copies (sync.js or vacancy-snapshot.js) as its own program,
// with a pretend network and pretend credentials. `tmp` is the sandbox from getSandbox().
function runSync(tmp, name, scenario, flags, entryName) {
  const scenarioFile = path.join(tmp, `${name}.scenario.json`);
  const logFile = path.join(tmp, `${name}.log.jsonl`);
  fs.writeFileSync(scenarioFile, JSON.stringify(scenario));
  fs.writeFileSync(logFile, '');
  const entry = path.join(tmp, 'box', 'a', 'b', entryName || 'sync.js');
  const child = spawnSync(process.execPath, ['-r', path.join(tmp, 'preload.js'), entry].concat(flags || []), {
    encoding: 'utf8',
    timeout: 90000,
    cwd: tmp, // a default-path dotenv call in the child can then never find a real .env
    env: {
      PATH: process.env.PATH,
      APPFOLIO_CLIENT_ID: 'fake-id', APPFOLIO_CLIENT_SECRET: 'fake-secret',
      SUPABASE_URL: FAKE_URL, SUPABASE_SERVICE_ROLE_KEY: FAKE_KEY,
      GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GOOGLE_REFRESH_TOKEN: '',
      SNAPSHOT_TEST_SCENARIO: scenarioFile, SNAPSHOT_TEST_LOG: logFile,
    },
  });
  const events = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const reqs = events.filter(e => e.kind === 'req');
  assert.ok(events.some(e => e.kind === 'preload'), 'test harness did not load, refusing to trust this run');
  assert.ok(!events.some(e => e.kind === 'BLOCKED'), `an unexpected network call was blocked: ${JSON.stringify(events.find(e => e.kind === 'BLOCKED'))}`);
  return {
    status: child.status, out: `${child.stdout}\n${child.stderr}`, events, reqs,
    snapshotPosts: reqs.filter(r => r.method === 'POST' && r.path.startsWith('/rest/v1/unit_vacancy_snapshots')),
    snapshotTouches: reqs.filter(r => r.path.includes('unit_vacancy_snapshots') || (r.path.startsWith('/rest/v1/units?select=id,appfolio_id,property_id'))),
    supabaseWrites: reqs.filter(r => r.host === 'fake-project.supabase.test' && r.method !== 'GET'),
    alerts: events.filter(e => e.kind === 'ALERT_EMAIL_ATTEMPT'),
  };
}

async function part2() {
  console.log('\nPart 2: the real sync.js with all network calls pretended');
  const tmp = getSandbox();

  const vacancyRows = ids(5, 9001).map(n => rawRow(n));
  const units = ids(5, 9001).map((n, i) => ({ id: uuid(i + 1), appfolio_id: String(n), property_id: uuid(9100) }));
  const healthy = { vacancyRows, units, previousDay: '2026-10-17', previousCount: 5 };
  const idxOf = (reqs, pred) => reqs.findIndex(pred);

  try {
    await test('healthy run: one snapshot save, after the units save and the link-up step, exit 0, no alert', () => {
      const r = runSync(tmp, 'healthy', healthy);
      assert.strictEqual(r.status, 0, r.out);
      assert.strictEqual(r.snapshotPosts.length, 1);
      const snap = r.snapshotPosts[0];
      assert.strictEqual(snap.path, '/rest/v1/unit_vacancy_snapshots?on_conflict=unit_id,snapshot_date');
      assert.strictEqual(snap.headers.Prefer, 'resolution=merge-duplicates');
      assert.strictEqual(JSON.parse(snap.body).length, 5);
      const unitsSave = idxOf(r.reqs, q => q.method === 'POST' && q.path === '/rest/v1/units?on_conflict=appfolio_id');
      let fkStep = -1; // the LAST link-up step of this sync.js (main and Sally's end with different ones)
      r.reqs.forEach((q, i) => { if (q.path.startsWith('/rest/v1/rpc/')) fkStep = i; });
      const snapAt = r.reqs.indexOf(snap);
      assert.ok(unitsSave >= 0 && fkStep >= 0 && snapAt > unitsSave && snapAt > fkStep, 'snapshot must come last');
      assert.match(r.out, /\[vacancy-snapshot\] \d{4}-\d{2}-\d{2}: report rows seen 5, upserted 5, skipped 0\./);
      assert.strictEqual(r.alerts.length, 0);
      assert.match(r.out, /=== Summary ===/);
    });

    await test('snapshot lookups fail (database error): sync finishes exactly as before, exit 0, no alert', () => {
      const r = runSync(tmp, 'readfail', Object.assign({}, healthy, { snapshotReadStatus: 500 }));
      assert.strictEqual(r.status, 0, r.out);
      assert.strictEqual(r.snapshotPosts.length, 0);
      assert.match(r.out, /snapshot step failed, nothing else affected/);
      assert.strictEqual(r.alerts.length, 0);
      assert.ok(r.reqs.some(q => q.path.startsWith('/rest/v1/rpc/resolve_lease_tenant_foreign_keys')), 'later sync steps still ran');
      assert.match(r.out, /=== Summary ===/);
    });

    await test('snapshot save is refused (503): exit 0, no alert, nothing else changed', () => {
      const r = runSync(tmp, 'savefail', Object.assign({}, healthy, { snapshotPostStatus: 503 }));
      assert.strictEqual(r.status, 0, r.out);
      assert.strictEqual(r.alerts.length, 0);
      assert.match(r.out, /FAILED to save/);
      assert.match(r.out, /=== Summary ===/);
    });

    await test('snapshot code crashes: caught inside sync.js, exit 0, no alert', () => {
      const r = runSync(tmp, 'crash', Object.assign({}, healthy, { moduleLoad: 'throws' }));
      assert.strictEqual(r.status, 0, r.out);
      assert.match(r.out, /\[vacancy-snapshot\] snapshot step failed, nothing else affected: pretend snapshot crash/);
      assert.strictEqual(r.alerts.length, 0);
      assert.match(r.out, /=== Summary ===/);
    });

    await test('snapshot file missing on the server: sync still runs, exit 0, no alert', () => {
      const r = runSync(tmp, 'missing', Object.assign({}, healthy, { moduleLoad: 'missing' }));
      assert.strictEqual(r.status, 0, r.out);
      assert.match(r.out, /snapshot step failed, nothing else affected: Cannot find module/);
      assert.strictEqual(r.alerts.length, 0);
    });

    await test('--dry-run: prints what would be saved, and the sync sends no write of any kind', () => {
      const r = runSync(tmp, 'dry', healthy, ['--dry-run']);
      assert.strictEqual(r.status, 0, r.out);
      assert.strictEqual(r.supabaseWrites.length, 0, 'dry run wrote something');
      assert.match(r.out, /DRY RUN, nothing is written\. Report rows seen 5, would save 5, skipped 0/);
    });

    await test('report looks cut short: no snapshot written, sync unaffected', () => {
      const r = runSync(tmp, 'short', Object.assign({}, healthy, { vacancyRows: vacancyRows.slice(0, 1), previousCount: 50 }));
      assert.strictEqual(r.status, 0, r.out);
      assert.strictEqual(r.snapshotPosts.length, 0);
      assert.match(r.out, /looks cut short/);
    });

    await test('report has zero rows: no snapshot written', () => {
      const r = runSync(tmp, 'zero', Object.assign({}, healthy, { vacancyRows: [], previousCount: 50 }));
      assert.strictEqual(r.status, 0, r.out);
      assert.strictEqual(r.snapshotTouches.length, 0, 'not even a lookup is needed');
      assert.match(r.out, /returned 0 rows/);
    });

    await test('unit_vacancy could not be fetched: snapshot not attempted; the sync behaves as it always did (exit 1 + alert)', () => {
      const r = runSync(tmp, 'afail', Object.assign({}, healthy, { appfolioFail: ['unit_vacancy'] }));
      assert.strictEqual(r.status, 1, r.out);
      assert.strictEqual(r.snapshotTouches.length, 0);
      assert.ok(!/\[vacancy-snapshot\]/.test(r.out));
      assert.strictEqual(r.alerts.length > 0, true, 'the existing warning e-mail path should still fire');
    });

    await test('--discover: no database traffic and no snapshot', () => {
      const r = runSync(tmp, 'discover', healthy, ['--discover']);
      assert.strictEqual(r.status, 0, r.out);
      assert.strictEqual(r.reqs.filter(q => q.host === 'fake-project.supabase.test').length, 0);
      assert.ok(!/\[vacancy-snapshot\]/.test(r.out));
    });
  } finally {
    // the sandbox is removed at the very end of the run (the command-line tests use it too)
  }
}

// ─── part 3: the stand-alone command-line tool, in the sandbox ────────────────
// The tool is run as its own program (a sandbox copy), against the pretend network.
// So even a broken copy of the code can only ever talk to the pretend server.

async function partCli() {
  console.log('\nPart 3: node vacancy-snapshot.js (stand-alone), sandbox copy, pretend network');
  const tmp = getSandbox();
  const vacancyRows = ids(5, 9001).map(n => rawRow(n));
  const units = ids(5, 9001).map((n, i) => ({ id: uuid(i + 1), appfolio_id: String(n), property_id: uuid(9100) }));
  const healthy = { vacancyRows, units, previousDay: '2026-10-17', previousCount: 5 };
  const cli = (name, scenario, flags) => runSync(tmp, name, scenario, flags, 'vacancy-snapshot.js');

  await test('command line: an unknown option (such as --dryrun) is refused with usage and exit 1, and sends no request at all', () => {
    const r = cli('cli-typo', healthy, ['--dryrun']);
    assert.strictEqual(r.reqs.length, 0, `a request was sent: ${r.reqs.map(q => q.method + ' ' + q.path).join(' | ')}`);
    assert.strictEqual(r.status, 1, r.out);
    assert.match(r.out, /Unknown option: --dryrun/);
    assert.match(r.out, /--dry-run/);
    const two = cli('cli-typo2', healthy, ['--dry-run', '--forse']);
    assert.strictEqual(two.reqs.length, 0, 'a request was sent');
    assert.strictEqual(two.status, 1);
    assert.match(two.out, /Unknown option: --forse/);
    const stray = cli('cli-stray', healthy, ['dry-run']);
    assert.strictEqual(stray.reqs.length, 0);
    assert.strictEqual(stray.status, 1);
  });

  await test('command line: --help prints the usage (including --force) and exits 0, no request', () => {
    const r = cli('cli-help', healthy, ['--help']);
    assert.strictEqual(r.status, 0, r.out);
    assert.strictEqual(r.reqs.length, 0);
    assert.match(r.out, /--force/);
    assert.match(r.out, /--dry-run/);
  });

  await test('command line: --dry-run goes through the whole tool and sends only reads (never a write)', () => {
    const r = cli('cli-dry', healthy, ['--dry-run']);
    assert.strictEqual(r.status, 0, r.out);
    assert.strictEqual(r.reqs.filter(q => q.host === 'rinconpm.appfolio.com').length, 1, 'exactly one AppFolio request');
    assert.strictEqual(r.supabaseWrites.length, 0, `dry run wrote: ${r.supabaseWrites.map(q => q.method + ' ' + q.path).join(' | ')}`);
    assert.ok(r.reqs.filter(q => q.host === 'fake-project.supabase.test').every(q => q.method === 'GET'));
    assert.match(r.out, /DRY RUN: nothing will be written\./);
    assert.match(r.out, /DRY RUN, nothing is written\. Report rows seen 5, would save 5/);
    const dryWithForce = cli('cli-dry-force', Object.assign({}, healthy, { previousCount: 50 }), ['--dry-run', '--force']);
    assert.strictEqual(dryWithForce.status, 0, dryWithForce.out);
    assert.strictEqual(dryWithForce.supabaseWrites.length, 0, '--dry-run --force must still write nothing');
  });

  await test('command line: without --dry-run it makes exactly one save (this is the only way the tool writes)', () => {
    const r = cli('cli-real', healthy, []);
    assert.strictEqual(r.status, 0, r.out);
    assert.strictEqual(r.snapshotPosts.length, 1);
    assert.match(r.out, /REAL RUN: this writes to unit_vacancy_snapshots\./);
    assert.match(r.out, /report rows seen 5, upserted 5, skipped 0/);
  });

  await test('command line: a cut-short report is refused unless --force is given', () => {
    const cut = Object.assign({}, healthy, { vacancyRows: vacancyRows.slice(0, 1), previousCount: 50 });
    const refused = cli('cli-cut', cut, []);
    assert.strictEqual(refused.status, 0, refused.out);
    assert.strictEqual(refused.snapshotPosts.length, 0);
    assert.match(refused.out, /looks cut short/);
    const forced = cli('cli-cut-force', cut, ['--force']);
    assert.strictEqual(forced.status, 0, forced.out);
    assert.strictEqual(forced.snapshotPosts.length, 1);
    assert.match(forced.out, /--force/);
  });

  await test('sandbox: the copies run with no .env above them and pretend credentials only', () => {
    const inner = path.join(tmp, 'box', 'a', 'b');
    assert.ok(!fs.existsSync(path.join(inner, '..', '..', '.env')));
    assert.ok(fs.existsSync(path.join(inner, 'vacancy-snapshot.js')) && fs.existsSync(path.join(inner, 'sync.js')));
    for (const key of Object.keys(process.env)) assert.ok(!isSecretSetting(key), `${key} is still set in the test process`);
  });
}

(async () => {
  await part1();
  await part1b();
  await part2();
  await partCli();
  await test('safety: nothing in this whole run tried to reach a real server', () => {
    assert.deepStrictEqual(realNetworkAttempts, [], `real network attempts: ${realNetworkAttempts.join(', ')}`);
  });
  await test('safety: the test process has no secret-looking setting at all', () => {
    const left = Object.keys(process.env).filter(isSecretSetting);
    assert.deepStrictEqual(left, [], `still set: ${left.join(', ')}`);
  });
  await test('safety: the network guard really blocks fetch, plain sockets and tls (and the attempts are recorded)', async () => {
    const before = realNetworkAttempts.length;
    await assert.rejects(async () => { await fetch('https://example.invalid/x'); }, /REAL NETWORK BLOCKED/);
    assert.throws(() => require('net').connect({ host: 'example.invalid', port: 443 }), /REAL NETWORK BLOCKED/);
    assert.throws(() => require('net').connect(443, 'example.invalid'), /REAL NETWORK BLOCKED/);
    assert.throws(() => require('tls').connect({ host: 'example.invalid', port: 443 }), /REAL NETWORK BLOCKED/);
    assert.throws(() => require('https').request({ hostname: 'example.invalid' }), /REAL NETWORK BLOCKED/);
    assert.strictEqual(realNetworkAttempts.length - before, 5);
    realNetworkAttempts.length = before; // these were deliberate; do not count them in the final check below
  });
  await test('safety: this computer is still allowed (a local server works)', async () => {
    await withServer((req, res) => res.end('ok'), async (port) => {
      const out = await settleWithin(vs.makeHttp(nodeHttp, 2000)(aim(port)), 3000);
      assert.ok(out.ok);
    });
  });
  removeSandbox();
  console.log(`\n${passed} passed, ${failed.length} failed`);
  if (failed.length) {
    console.log('Failed: ' + failed.join(' | '));
    process.exit(1);
  }
})();
