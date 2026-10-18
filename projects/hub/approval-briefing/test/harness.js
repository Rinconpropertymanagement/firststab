/**
 * test/harness.js
 *
 * Shared test harness for the Work Order Alert tests. Makes it impossible
 * for a test to reach anything real:
 *   - every external dependency (Supabase, the Hub's mailer, Latchel,
 *     nodemailer) is replaced in require.cache BEFORE the alert module is
 *     first required (the alert module builds its Supabase client and
 *     destructures sendMail at load time, so a late spy would not work).
 *     The Anthropic SDK is replaced by a TRIPWIRE: this feature has no AI, so
 *     constructing the client at all is a failure (see `ai.constructed`);
 *   - global.fetch is replaced by a function that throws, so any
 *     unexpected network attempt fails loudly;
 *   - the real mail/OAuth/Latchel/Anthropic credentials are removed from
 *     process.env, and the fake Supabase values override whatever the
 *     shell had.
 *
 * Synthetic data only. Nothing here reads a .env file.
 */

const path = require('path');
const Module = require('module');

const HUB_DIR = path.resolve(__dirname, '../..');
const APPROVAL_DIR = path.resolve(__dirname, '..');

// ─── Environment: fake values only, real credentials removed ──────────────
process.env.SUPABASE_URL = 'https://fake-test-project.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-test-service-role-key';
process.env.CRON_SECRET = 'fake-test-cron-secret';
process.env.HUB_BASE_URL = 'https://hub.test.invalid';
for (const k of [
  'GMAIL_USER', 'GMAIL_APP_PASSWORD',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'HUB_NOTIFY_REFRESH_TOKEN',
  'LATCHEL_API_KEY', 'ANTHROPIC_API_KEY',
  'WORK_ORDER_ALERT_DESCRIPTION_MODE', 'TIER_B_CONTEXTUAL_CHECK_ENABLED',
  'WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED', 'WORK_ORDER_ALERT_DESCRIPTION_SCREEN',
]) {
  delete process.env[k];
}

// ─── Network tripwire ──────────────────────────────────────────────────────
const tripwire = { calls: 0 };
global.fetch = function fetchTripwire() {
  tripwire.calls++;
  throw new Error('TRIPWIRE: a test attempted a real network call (global.fetch).');
};

// ─── Console capture (so tests can assert nothing leaked into logs) ───────
const logs = [];
function fmt(args) {
  return args.map((a) => (typeof a === 'string' ? a : (a && a.stack) || JSON.stringify(a))).join(' ');
}
console.log = (...a) => { logs.push(fmt(a)); };
console.info = console.log;
console.warn = (...a) => { logs.push(fmt(a)); };
console.error = (...a) => { logs.push(fmt(a)); };
console.debug = console.log;

// ─── Fake Supabase ────────────────────────────────────────────────────────
const db = { tables: {}, writes: [], throwOnInsert: null, errorOnInsert: null };

class Query {
  constructor(table) {
    this.table = table;
    this.op = 'select';
    this.filters = [];
    this.payload = null;
    this.single = false;
  }
  select() { return this; }
  eq(col, val) { this.filters.push([col, val]); return this; }
  insert(row) { this.op = 'insert'; this.payload = row; return this; }
  update(row) { this.op = 'update'; this.payload = row; return this; }
  maybeSingle() { this.single = true; return this; }
  then(resolve, reject) { return Promise.resolve(this.run()).then(resolve, reject); }
  run() {
    const rows = db.tables[this.table] || (db.tables[this.table] = []);
    const matches = (r) => this.filters.every(([c, v]) => r[c] === v);
    if (this.op === 'insert') {
      if (db.throwOnInsert && db.throwOnInsert(this.table, this.payload)) throw new Error('fake db insert failure');
      if (db.errorOnInsert) {
        const msg = db.errorOnInsert(this.table, this.payload);
        if (msg) return { data: null, error: { message: msg } };
      }
      db.writes.push({ table: this.table, op: 'insert', payload: JSON.parse(JSON.stringify(this.payload)) });
      rows.push(JSON.parse(JSON.stringify(this.payload)));
      return { data: null, error: null };
    }
    if (this.op === 'update') {
      db.writes.push({ table: this.table, op: 'update', payload: JSON.parse(JSON.stringify(this.payload)), filters: this.filters.slice() });
      for (const r of rows) if (matches(r)) Object.assign(r, JSON.parse(JSON.stringify(this.payload)));
      return { data: null, error: null };
    }
    const found = rows.filter(matches);
    if (this.single) return { data: found[0] || null, error: null };
    return { data: found, error: null };
  }
}
const fakeSupabaseModule = { createClient: () => ({ from: (table) => new Query(table) }) };

// ─── Fake Hub mailer + shared inboxes (lib/notify.js) ─────────────────────
const mail = { sent: [], nextResult: null, throwNext: null };
const FAKE_INBOXES = {
  solimar_pod_team: 'solimar-pod@example.test',
  faria_pod_team: 'faria-pod@example.test',
};
const fakeNotify = {
  getSharedInbox: async (key) => FAKE_INBOXES[key] || null,
  getPersonEmail: async () => null,
  getRoleHolders: async () => [],
  sendMail: async ({ to, subject, text }) => {
    mail.sent.push({ to, subject, text });
    if (mail.throwNext) throw mail.throwNext(text);
    if (mail.nextResult) return typeof mail.nextResult === 'function' ? mail.nextResult(text) : mail.nextResult;
    const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
    return { ok: true, sent: recipients.length, failed: 0, accepted: recipients, rejected: [], error: null };
  },
};

// ─── Fake Latchel connector ───────────────────────────────────────────────
const latchelState = { getJobCalls: [], getJobImpl: null };
const fakeLatchel = {
  getJob: async (id) => {
    latchelState.getJobCalls.push(String(id));
    if (!latchelState.getJobImpl) throw new Error('no fake job configured');
    return latchelState.getJobImpl(id);
  },
  listJobsUpdatedSince: async () => [],
};

// ─── Fake nodemailer (failure-notification channel) ───────────────────────
const nm = { created: 0, sent: [] };
const fakeNodemailer = {
  createTransport: () => {
    nm.created++;
    return { sendMail: async (m) => { nm.sent.push(m); return {}; } };
  },
};

// ─── Anthropic tripwire ───────────────────────────────────────────────────
// This feature has NO AI. The SDK slot in require.cache holds a class whose
// constructor records the attempt and throws, so any code path that builds a
// model client fails the test that caused it.
const ai = { constructed: 0, calls: 0 };
class AnthropicTripwire {
  constructor() {
    ai.constructed++;
    throw new Error('TRIPWIRE: the Anthropic client was constructed, but this feature has no AI.');
  }
}

// ─── require.cache seeding ────────────────────────────────────────────────
function seed(filename, exports) {
  const m = new Module(filename);
  m.filename = filename;
  m.loaded = true;
  m.exports = exports;
  require.cache[filename] = m;
}
function seedPackage(id, exports) {
  seed(require.resolve(id, { paths: [HUB_DIR] }), exports);
}
seedPackage('@supabase/supabase-js', fakeSupabaseModule);
seedPackage('nodemailer', fakeNodemailer);
seedPackage('@anthropic-ai/sdk', AnthropicTripwire);
seed(path.resolve(HUB_DIR, 'lib/notify.js'), fakeNotify);
seed(path.resolve(HUB_DIR, 'maintenance-history/lib/latchel-connector.js'), fakeLatchel);

// ─── Per-test reset ───────────────────────────────────────────────────────
function reset() {
  db.tables = { properties: [], work_order_note_alerts: [], tasks: [], audit_log: [] };
  db.writes.length = 0;
  db.throwOnInsert = null;
  mail.sent.length = 0;
  mail.nextResult = null;
  latchelState.getJobCalls.length = 0;
  latchelState.getJobImpl = null;
  nm.created = 0;
  nm.sent.length = 0;
  ai.constructed = 0;
  ai.calls = 0;
  db.errorOnInsert = null;
  mail.throwNext = null;
  logs.length = 0;
  tripwire.calls = 0;
  delete process.env.WORK_ORDER_ALERT_DESCRIPTION_MODE;
  delete process.env.WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED;
  delete process.env.WORK_ORDER_ALERT_DESCRIPTION_SCREEN;
  delete process.env.TIER_B_CONTEXTUAL_CHECK_ENABLED;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GMAIL_USER;
  delete process.env.GMAIL_APP_PASSWORD;
}

/** Loads a module fresh-or-cached by path (relative to approval-briefing/). */
function load(relFromApprovalDir) {
  return require(path.resolve(APPROVAL_DIR, relFromApprovalDir));
}

/**
 * Loads `target` as a brand-new instance with some of its dependencies
 * replaced, then puts require.cache back exactly as it was. Used to make a
 * dependency fail on purpose (e.g. the keyword scan throwing) without
 * disturbing the instances the rest of the suite uses.
 *   evict: absolute paths to drop from the cache first
 *   stubs: { absolutePath: exportsObject } to seed
 */
function loadFresh({ target, evict = [], stubs = {} }) {
  const before = new Set(Object.keys(require.cache));
  const saved = new Map();
  for (const abs of [...evict, ...Object.keys(stubs)]) {
    if (!saved.has(abs)) saved.set(abs, require.cache[abs]);
    delete require.cache[abs];
  }
  for (const [abs, exp] of Object.entries(stubs)) seed(abs, exp);
  try {
    return require(target);
  } finally {
    for (const key of Object.keys(require.cache)) if (!before.has(key)) delete require.cache[key];
    for (const [abs, orig] of saved) {
      if (orig) require.cache[abs] = orig; else delete require.cache[abs];
    }
  }
}

/**
 * Sets every environment variable that could ever make an AI path run: a
 * dummy model key and the shared Tier B contextual-check switch turned ON.
 * The feature must behave identically (no model call) with these set.
 */
function setDummyAiEnv() {
  process.env.ANTHROPIC_API_KEY = 'dummy-not-a-real-key';
  process.env.TIER_B_CONTEXTUAL_CHECK_ENABLED = 'true';
}

module.exports = {
  HUB_DIR, APPROVAL_DIR,
  db, mail, nm, ai, latchelState, logs, tripwire, FAKE_INBOXES,
  reset, load, loadFresh, setDummyAiEnv, seed,
};
