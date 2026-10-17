/**
 * test/test-kit.js
 *
 * Shared helpers for the Work Order Alert test files: a tiny runner (no test
 * framework, matching archive-search/test/run-tests.js), and the helpers that
 * drive the real alert code through the stubbed harness.
 *
 * Load this FIRST in a test file: it loads harness.js, which sets the fake
 * environment, installs the stubs and trips a wire on global.fetch before the
 * alert module is ever required.
 *
 * SAFETY: no real email, no real database, no real Latchel, no model, no
 * .env read. All text in the tests is invented.
 */

'use strict';

const H = require('./harness');
const assert = require('assert');
const path = require('path');
const { SCENARIOS, baseProperty, baseJob } = require('./scenarios');
const golden = require('./golden-emails.json');

const alert = H.load('lib/work-order-notes-alert.js');
const summaryMod = H.load('lib/work-order-summary.js');
const cleanMod = H.load('lib/work-order-text-clean.js');
const screenMod = H.load('lib/work-order-text-screen.js');

const HEADER = summaryMod.HEADER;
const HELD_NOTICE = summaryMod.HELD_NOTICE;
const UNASSIGNED_NOTICE = summaryMod.UNASSIGNED_NOTICE;
const DESC_ACTION = 'work_order_note_alert.description_checked';
const CANARY = 'ZZCANARY-8841';
// Identifiers of the retired AI check, built from pieces so no test file contains them literally.
const RETIRED_AI_WORDS = [
  ['CLASSIFIER', 'PROMPT', 'VERSION'].join('_'), ['classifier', 'prompt', 'version'].join('_'),
  `claude-sonnet${'-5'}`, `output${'_config'}`,
];

// ─── Tiny runner ────────────────────────────────────────────────────────────
function makeRunner(title) {
  const tests = [];
  const test = (name, fn) => { tests.push({ name, fn }); };
  async function run() {
    let failures = 0;
    process.stdout.write(`\n${title}\n${'='.repeat(60)}\n`);
    for (const t of tests) {
      try {
        await t.fn();
        if (H.tripwire.calls > 0) throw new Error(`TRIPWIRE: ${H.tripwire.calls} real network call(s) attempted`);
        if (H.ai.constructed > 0) throw new Error('TRIPWIRE: the Anthropic client was constructed');
        process.stdout.write(`PASS  ${t.name}\n`);
      } catch (err) {
        failures += 1;
        process.stdout.write(`FAIL  ${t.name}\n      ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n      ')}\n`);
      }
    }
    process.stdout.write('='.repeat(60) + `\n${tests.length - failures}/${tests.length} passed\n`);
    if (failures) process.exitCode = 1;
    return { total: tests.length, failures };
  }
  return { test, run, tests };
}

// ─── Helpers ────────────────────────────────────────────────────────────────
const clone = (o) => JSON.parse(JSON.stringify(o));
const goldenByName = new Map(golden.map((g) => [g.name, g]));
const FORBIDDEN_WORDS = /undefined|\bnull\b|\[object Object\]|NaN/;
const hasLoneSurrogate = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

/**
 * Runs one job through the real handleWorkOrderJob with everything stubbed.
 * mode 'on' sets the ingestion interlock to 'yes' unless interlock:false.
 */
async function send({ mode = 'on', job = baseJob(), property = baseProperty(), interlock = true, before } = {}) {
  H.reset();
  if (mode) process.env.WORK_ORDER_ALERT_DESCRIPTION_MODE = mode;
  if (mode === 'on' && interlock) process.env.WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED = 'yes';
  H.db.tables.properties.push(clone(property));
  if (before) before();
  const result = await alert.handleWorkOrderJob(clone(job), 'webhook');
  return { result, email: H.mail.sent[0] || null, count: H.mail.sent.length };
}

function auditEvents(action) {
  return H.db.writes.filter((w) => w.table === 'audit_log').map((w) => w.payload).filter((p) => !action || p.action === action);
}

/** The lines between "Created:" and "View this property:" (without the blank separators). */
function blockLines(text) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.startsWith('Created:'));
  const j = lines.findIndex((l) => l.startsWith('View this property:'));
  return lines.slice(i + 2, j - 1);
}

/** Everything that is not the email body, stringified, for "never leaked" checks. */
function everythingExceptBody(email) {
  return [
    email ? email.subject : '',
    JSON.stringify(H.db.writes),
    H.logs.join('\n'),
    JSON.stringify(H.nm.sent),
  ].join('\n');
}

function assertIdenticalToGolden(email, name) {
  const g = goldenByName.get(name);
  assert.ok(g, `no golden for ${name}`);
  assert.strictEqual(email.subject, g.subject, `${name}: subject differs`);
  assert.strictEqual(email.text, g.text, `${name}: text differs`);
  assert.strictEqual(Buffer.compare(Buffer.from(email.text, 'utf8'), Buffer.from(g.text, 'utf8')), 0, `${name}: UTF-8 bytes differ`);
  assert.deepStrictEqual(email.to, g.to, `${name}: recipients differ`);
}

/** Loads the alert module as a brand-new instance with some dependencies replaced. */
function freshAlert({ stubs = {}, evict = [] } = {}) {
  const lib = (f) => path.resolve(H.APPROVAL_DIR, 'lib', f);
  return H.loadFresh({
    target: lib('work-order-notes-alert.js'),
    evict: [lib('work-order-notes-alert.js'), lib('work-order-summary.js'), ...evict],
    stubs,
  });
}

/**
 * The real path in one call, wired exactly as prepareWorkOrderSummary wires it: the cleaner (every
 * reading, and its own hold request) then the screen with every reading. Returns the screen's verdict;
 * a hold the cleaner asks for by itself comes back as { status: 'held', cause: 'link_shape', ambiguousLink: true }.
 */
function screenFull(title, description) {
  const t = cleanMod.cleanTextBoth(title);
  const d = cleanMod.cleanTextBoth(description);
  if (t.ambiguousLink || d.ambiguousLink) return { status: 'held', cause: 'link_shape', categories: [], common_word_only: false, ambiguousLink: true };
  return screenMod.screenWorkOrderText({
    title: t.shown,
    description: d.shown,
    spaced: { title: t.spaced, description: d.spaced },
    symbols: { title: t.symbols, description: d.symbols },
    both: { title: t.both, description: d.both },
  });
}

/** Small seeded random generator (mulberry32), so generated tests are repeatable. */
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = {
  H, assert, path,
  alert, summaryMod, SCENARIOS, baseProperty, baseJob, golden,
  HEADER, HELD_NOTICE, UNASSIGNED_NOTICE, DESC_ACTION, CANARY, RETIRED_AI_WORDS,
  makeRunner, clone, goldenByName, FORBIDDEN_WORDS, hasLoneSurrogate,
  send, auditEvents, blockLines, everythingExceptBody, assertIdenticalToGolden, freshAlert, rng, screenFull,
};
