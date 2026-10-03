#!/usr/bin/env node
/**
 * test/run-tests.js
 * Standalone test runner for this build — no test framework dependency,
 * matching email-intake/test/run-tests.js's own convention. Run with:
 *   node projects/hub/archive-search/test/run-tests.js
 *
 * Makes zero real network calls and touches no real Supabase project or
 * Anthropic account — fake env values are set below purely so router.js
 * and lib/screening-pass.js can be required without their own startup
 * env-var checks exiting the process (both create a Supabase client at
 * module load time, same as every other Hub tool's router.js). No route
 * handler or DB-touching function is actually INVOKED here — only pure
 * functions (middleware logic, keyword scans, CSV escaping, the guardrail
 * check itself, and the self-report classifier's fail-closed path, which
 * is exercised for real by deliberately NOT providing a real
 * ANTHROPIC_API_KEY).
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://fake-test-project.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'fake-test-service-role-key';
process.env.CRON_SECRET = process.env.CRON_SECRET || 'fake-test-cron-secret';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto'); // PART 20 (resumable driver cursor) needs a real md5, matching the digest shape the real Postgres functions in migration 20260920010000 compute.
const vm = require('vm'); // PART 22h (Needs Attention tile bug fix) runs complaint-tracking/dashboard/index.html's real inline <script> for real, rather than only grepping its source — see that PART's own header for why.

// Severity-tier build (2026-10-02) — lib/severity-batch.js computes its own
// STATE_PATH from this env var ONCE, at require() time (below), so it has
// to be set before that require happens. A dedicated, pid-suffixed test
// path keeps this suite's own in-flight-batch state file from ever
// colliding with a real one on a host where a real severity batch run
// might also be in progress (this file's own header: "touches no real
// Supabase project... makes zero real network calls" — this is part of
// making that true for this new module too).
process.env.SEVERITY_BATCH_STATE_PATH = process.env.SEVERITY_BATCH_STATE_PATH
  || path.join(os.tmpdir(), `test-severity-batch-state-${process.pid}.json`);

// Retroactive name-match backfill build (2026-10-02) — same reasoning as
// SEVERITY_BATCH_STATE_PATH immediately above, for lib/name-match-backfill.js's
// own STATE_PATH (computed once, at require() time, below).
process.env.NAME_MATCH_BACKFILL_STATE_PATH = process.env.NAME_MATCH_BACKFILL_STATE_PATH
  || path.join(os.tmpdir(), `test-name-match-backfill-state-${process.pid}.json`);

const results = [];
const asyncResults = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (err) {
    results.push({ name, pass: false, error: err.message });
  }
}

function asyncTest(name, fn) {
  asyncResults.push(
    fn()
      .then(() => ({ name, pass: true }))
      .catch((err) => ({ name, pass: false, error: err.message }))
  );
}

// ============================================================
// PART 1 — THE REQUIRED DELIVERABLE: the raw-table-access guardrail,
// proven against real files on disk, not just unit-tested in isolation.
// ============================================================
const guardrail = require('./no-raw-table-access-check');

test('Guardrail unit — bare table name is a violation', () => {
  const v = guardrail.findViolations("supabase.from('missive_message_intake').select('*')");
  assert.strictEqual(v.length, 1, 'expected exactly one violation for a bare .from(missive_message_intake) call');
});

test('Guardrail unit — the search-safe view name is allowed', () => {
  const v = guardrail.findViolations("supabase.from('missive_message_intake_search_safe').select('*')");
  assert.strictEqual(v.length, 0, 'expected the search-safe view reference to be allowed');
});

test('Guardrail unit — the held-review-safe view name is allowed', () => {
  const v = guardrail.findViolations("supabase.from('missive_message_intake_held_review_safe').select('*')");
  assert.strictEqual(v.length, 0, 'expected the held-review-safe view reference to be allowed');
});

test('Guardrail unit — the missive_message_intake_id FK column name is allowed', () => {
  const v = guardrail.findViolations("{ missive_message_intake_id: id, stratum: 'A' }");
  assert.strictEqual(v.length, 0, 'expected the real FK column name (points at a different, safe table) to be allowed');
});

test('Guardrail unit — a near-miss suffix is still a violation (word-boundary check)', () => {
  // Not a real column name anywhere in this codebase — proves the
  // allow-list is boundary-checked, not just a naive startsWith that a
  // coincidentally-similar longer identifier could slip through.
  const v = guardrail.findViolations("const x = row.missive_message_intake_ids;");
  assert.strictEqual(v.length, 1, 'expected missive_message_intake_ids (not _id alone) to still be flagged');
});

test('Guardrail unit — a violation inside a comment is still caught (deliberately blunt, matches the spec\'s own "not by a database mechanism, cheap" design)', () => {
  const v = guardrail.findViolations('// TODO: read missive_message_intake directly here later');
  assert.strictEqual(v.length, 1, 'expected a bare mention inside a comment to be flagged — the check is a literal string match, not AST-aware');
});

test('Guardrail — the real, current archive-search/router.js and lib/ files are clean', () => {
  const clean = guardrail.runCheck();
  const dirty = clean.filter((r) => r.violations.length > 0);
  assert.strictEqual(dirty.length, 0, `expected zero violations in the real build; found: ${JSON.stringify(dirty)}`);
});

test('Guardrail — screening-pass.js is exempt and never appears in the checked list', () => {
  const files = guardrail.listCheckedFiles();
  const hasScreeningPass = files.some((f) => !guardrail.isExemptFile(f) === false && path.basename(f) === 'screening-pass.js');
  // listCheckedFiles() itself doesn't filter — runCheck() does. Confirm
  // isExemptFile() correctly identifies it so runCheck()'s own .filter
  // excludes it (proven in the next test, against the real run).
  assert.ok(files.some((f) => path.basename(f) === 'screening-pass.js'), 'expected screening-pass.js to exist and be listed by listCheckedFiles()');
  assert.strictEqual(guardrail.isExemptFile(path.join(__dirname, '..', 'lib', 'screening-pass.js')), true, 'expected isExemptFile() to exempt screening-pass.js');
});

test('Guardrail — PROOF OF CATCH: a deliberately-introduced violation, written to a real temp file on disk under archive-search/lib/, is actually caught by runCheck()', () => {
  const tempFile = path.join(__dirname, '..', 'lib', '__deliberate-violation-temp-test-file.js');
  const violatingCode = `
// A deliberately bad line, planted here only for this test — never
// committed as real code.
const { createClient } = require('@supabase/supabase-js');
async function badQuery(supabase) {
  return supabase.from('missive_message_intake').select('body_text, subject, from_address');
}
module.exports = { badQuery };
`;
  fs.writeFileSync(tempFile, violatingCode, 'utf8');
  try {
    const results = guardrail.runCheck();
    const flagged = results.find((r) => r.file === tempFile);
    assert.ok(flagged, 'expected the temp violating file to appear in runCheck() results');
    assert.ok(flagged.violations.length > 0, 'expected runCheck() to report at least one violation in the deliberately bad file');
    assert.strictEqual(flagged.violations[0].text.includes("supabase.from('missive_message_intake')"), true, 'expected the flagged line to be the actual bad query line');
  } finally {
    fs.unlinkSync(tempFile);
  }
  // Confirm cleanup actually restored a clean state — the check isn't
  // just permanently red now, and isn't just checking for the file's
  // existence.
  const afterCleanup = guardrail.runCheck();
  assert.strictEqual(afterCleanup.some((r) => r.file === tempFile), false, 'expected the temp file to be gone after cleanup');
  assert.strictEqual(afterCleanup.filter((r) => r.violations.length > 0).length, 0, 'expected the real build to be clean again after removing the temp violation');
});

// ============================================================
// PART 2 — the keyword-list fixes (Finding 4).
// ============================================================
const { scanForHoldKeywords, scanForTagKeywords, TERMS_VERSION: PRIVILEGE_TERMS_VERSION } = require('../../email-intake/lib/privilege-keywords');
const { checkThread } = require('../../email-intake/lib/privilege-filter');

test('privilege-keywords — TERMS_VERSION bumped to v5', () => {
  assert.strictEqual(PRIVILEGE_TERMS_VERSION, 'privilege-keywords-v5');
});

test('privilege-keywords — "lawyer" now trips a HOLD, alongside the existing "attorney"', () => {
  const hit = scanForHoldKeywords('We spoke with our lawyer about this yesterday.');
  assert.strictEqual(hit.matched, true);
  assert.ok(hit.matchedTerms.includes('lawyer'), 'expected "lawyer" in matchedTerms');
});

test('privilege-keywords — co-occurrence: "a complaint about fair housing" (reversed word order) now trips a HOLD', () => {
  const hit = scanForHoldKeywords('The tenant filed a complaint about fair housing issues at the property.');
  assert.strictEqual(hit.matched, true);
  assert.ok(hit.matchedTerms.includes('fair_housing_complaint_cooccurrence'), 'expected the synthetic co-occurrence label in matchedTerms');
});

test('privilege-keywords — co-occurrence: "filed a complaint with HUD" (different order/wording) now trips a HOLD', () => {
  const hit = scanForHoldKeywords('She said she filed a complaint with HUD last week.');
  assert.strictEqual(hit.matched, true);
  assert.ok(hit.matchedTerms.includes('fair_housing_complaint_cooccurrence'), 'expected the synthetic co-occurrence label for the HUD/complaint pair');
});

test('privilege-keywords — the pre-existing exact-phrase match "fair housing complaint" still works unchanged (regression check)', () => {
  const hit = scanForHoldKeywords('Please see the attached fair housing complaint.');
  assert.strictEqual(hit.matched, true);
  assert.ok(hit.matchedTerms.includes('fair housing complaint'), 'expected the original literal phrase match to still fire');
});

test('privilege-keywords — co-occurrence does NOT fire on "fair housing" alone with no complaint word nearby', () => {
  const hit = scanForHoldKeywords('We updated our fair housing training materials this quarter.');
  assert.strictEqual(hit.matched, false, 'expected no HOLD — "fair housing" alone, no complaint word anywhere in the text');
});

// --- v5 bug fix regression (TARS Finding 1 / Judge blocker): the v4
// co-occurrence complaint-word regex was built on the noun stem
// "complaint" and never matched the actual verb forms people use in real
// correspondence. Covers all six word forms plus the real sentence TARS
// and Judge used to reproduce the bug, so this exact class of gap can't
// silently regress again.
test('privilege-keywords — co-occurrence fires on verb forms of "complain" (v5 bug fix), not just the noun', () => {
  const verbForms = [
    'complain',
    'complains',
    'complained',
    'complaining',
  ];
  for (const form of verbForms) {
    const hit = scanForHoldKeywords(`She wants to ${form} to HUD about how she was treated.`);
    assert.strictEqual(hit.matched, true, `expected a HOLD for the verb form "${form}"`);
    assert.ok(hit.matchedTerms.includes('fair_housing_complaint_cooccurrence'), `expected the synthetic co-occurrence label for "${form}"`);
  }
});

test('privilege-keywords — the real sentence from TARS/Judge\'s bug report now trips a HOLD', () => {
  const hit = scanForHoldKeywords('She complained to the Civil Rights Department about how she was treated.');
  assert.strictEqual(hit.matched, true, 'expected "complained" (verb, past tense) to trip the co-occurrence HOLD');
  assert.ok(hit.matchedTerms.includes('fair_housing_complaint_cooccurrence'), 'expected the synthetic co-occurrence label');
});

test('privilege-keywords — noun forms "complaint"/"complaints" still match after the v5 fix (no regression)', () => {
  const singular = scanForHoldKeywords('She filed a complaint with the CRD about how she was treated.');
  const plural = scanForHoldKeywords('She has filed multiple complaints with CRD over the years.');
  assert.strictEqual(singular.matched, true, 'expected the noun singular "complaint" to still trip the co-occurrence HOLD');
  assert.strictEqual(plural.matched, true, 'expected the noun plural "complaints" to still trip the co-occurrence HOLD');
});

test('privilege-keywords — checkThread() needs no changes: a co-occurrence hit still holds the whole thread via the unmodified privilege-filter.js', () => {
  const thread = {
    threadId: 't1',
    legalHoldTag: false,
    messages: [
      { messageId: 'm1', from: 'tenant@example.com', to: ['staff@rinconmanagement.com'], subject: 'Issue', body: 'I want to file a complaint about fair housing at my unit.', date: '2024-01-01' },
    ],
  };
  const result = checkThread(thread);
  assert.strictEqual(result.held, true, 'expected the thread to be held via the new co-occurrence mechanism, with zero changes to privilege-filter.js');
  assert.strictEqual(result.tier, 2);
});

// ============================================================
// PART 3 — protected-class-terms.js's discrimination_general category.
// ============================================================
const { scanText, TERMS_VERSION: PROTECTED_CLASS_TERMS_VERSION, CATEGORIES } = require('../../maintenance-history/lib/protected-class-terms');

test('protected-class-terms — TERMS_VERSION bumped to v2', () => {
  assert.strictEqual(PROTECTED_CLASS_TERMS_VERSION, 'protected-class-terms-v2');
});

test('protected-class-terms — discrimination_general category exists with the expected word forms', () => {
  assert.ok(Array.isArray(CATEGORIES.discrimination_general), 'expected a discrimination_general category');
  for (const term of ['discriminate', 'discriminated', 'discriminating', 'discriminates', 'discrimination', 'discriminatory']) {
    assert.ok(CATEGORIES.discrimination_general.includes(term), `expected "${term}" in discrimination_general`);
  }
});

test('protected-class-terms — a bare discrimination accusation now flags, with no other protected-class term present', () => {
  const result = scanText('The owner said we discriminated against them during the application process.');
  assert.strictEqual(result.flagged, true);
  assert.ok(result.categories.includes('discrimination_general'), 'expected discrimination_general category');
  assert.deepStrictEqual(result.categories, ['discrimination_general'], 'expected ONLY discrimination_general to fire — no other listed term is present in this sentence');
});

test('protected-class-terms — routine text with no discrimination language still does not flag', () => {
  const result = scanText('The tenant asked us to fix the garbage disposal in the kitchen.');
  assert.strictEqual(result.flagged, false);
});

// ============================================================
// PART 4 — lib/csv.js
// ============================================================
const { toCsv, escapeCsvField } = require('../lib/csv');

test('csv — plain fields are unquoted', () => {
  assert.strictEqual(escapeCsvField('hello'), 'hello');
});

test('csv — a field with a comma is quoted', () => {
  assert.strictEqual(escapeCsvField('Smith, John'), '"Smith, John"');
});

test('csv — a field with an embedded quote is quoted and the quote doubled', () => {
  assert.strictEqual(escapeCsvField('She said "hi"'), '"She said ""hi"""');
});

test('csv — null/undefined become an empty field, not the literal string "null"', () => {
  assert.strictEqual(escapeCsvField(null), '');
  assert.strictEqual(escapeCsvField(undefined), '');
});

test('csv — toCsv() produces a header row plus one row per record, correctly escaped', () => {
  const out = toCsv(['a', 'b'], [{ a: 'x,y', b: 'plain' }, { a: 'z', b: null }]);
  const lines = out.split('\r\n').filter(Boolean);
  assert.strictEqual(lines.length, 3, 'expected header + 2 data rows');
  assert.strictEqual(lines[0], 'a,b');
  assert.strictEqual(lines[1], '"x,y",plain');
  assert.strictEqual(lines[2], 'z,');
});

// --- Formula-injection guard regression (TARS Finding 2 / Judge should-fix
// before real data ever flows through the exports): a field starting with
// =, +, -, or @ can execute as a formula on open in Excel/Sheets. Each of
// the four trigger characters gets a leading single-quote prefix before
// the existing quoting logic.
test('csv — a field starting with "=" is prefixed with a leading single-quote (formula-injection guard)', () => {
  assert.strictEqual(escapeCsvField('=1+1'), "'=1+1");
});

test('csv — a field starting with "+", "-", or "@" is also prefixed with a leading single-quote', () => {
  assert.strictEqual(escapeCsvField('+1234567890'), "'+1234567890");
  assert.strictEqual(escapeCsvField('-2+3'), "'-2+3");
  assert.strictEqual(escapeCsvField('@SUM(A1:A2)'), "'@SUM(A1:A2)");
});

test('csv — a formula-injection field that also needs comma/quote escaping gets both fixes, in order', () => {
  // Leading single-quote is added first, THEN the normal comma/quote
  // quoting wraps the whole thing — the single-quote must survive inside
  // the quotes, not be treated as the field's own opening quote.
  assert.strictEqual(escapeCsvField('=HYPERLINK("evil.com"),"x"'), '"\'=HYPERLINK(""evil.com""),""x"""');
});

test('csv — a plain field that merely contains "=" or "@" NOT at the start is left alone (no false positive)', () => {
  assert.strictEqual(escapeCsvField('rent=1200'), 'rent=1200');
  assert.strictEqual(escapeCsvField('tenant@example.com'), 'tenant@example.com');
});

test('csv — toCsv() applies the formula-injection guard to real export rows (subject/from_address style fields)', () => {
  const out = toCsv(['subject', 'from_address'], [{ subject: '=cmd|\'/c calc\'!A1', from_address: 'tenant@example.com' }]);
  const lines = out.split('\r\n').filter(Boolean);
  assert.strictEqual(lines[1], '\'=cmd|\'/c calc\'!A1,tenant@example.com', 'expected the malicious subject neutralized with a leading single-quote');
});

// ============================================================
// PART 5 — archive-search/router.js: pure middleware logic and the
// Missive-link builder. No route handler that touches Supabase is called.
// ============================================================
const router = require('../router');

test('router — ARCHIVE_SEARCH_SEARCH_ROLES / ADMIN_ROLES match the spec exactly', () => {
  assert.deepStrictEqual(router.ARCHIVE_SEARCH_SEARCH_ROLES, ['searcher', 'admin']);
  assert.deepStrictEqual(router.ARCHIVE_SEARCH_ADMIN_ROLES, ['admin']);
});

test('router — missiveConversationLink() builds the expected URL and encodes the id', () => {
  const link = router.missiveConversationLink('abc 123');
  assert.strictEqual(link, 'https://mail.missiveapp.com/#inbox/conversations/abc%20123');
});

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('router — requireArchiveSearchAccess allows a "searcher" role', () => {
  const req = { archiveSearchRole: 'searcher' };
  const res = fakeRes();
  let nextCalled = false;
  router.requireArchiveSearchAccess(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null);
});

test('router — requireArchiveSearchAccess allows an "admin" role', () => {
  const req = { archiveSearchRole: 'admin' };
  const res = fakeRes();
  let nextCalled = false;
  router.requireArchiveSearchAccess(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
});

test('router — requireArchiveSearchAccess rejects no role (403), never calls next()', () => {
  const req = { archiveSearchRole: null };
  const res = fakeRes();
  let nextCalled = false;
  router.requireArchiveSearchAccess(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
});

test('router — requireArchiveSearchAccess rejects an unrelated role string (explicit allow-list, not bare truthy check)', () => {
  const req = { archiveSearchRole: 'director_of_operations' }; // a real role on OTHER tools, not this one
  const res = fakeRes();
  let nextCalled = false;
  router.requireArchiveSearchAccess(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
});

test('router — requireArchiveSearchAdmin rejects a plain "searcher" role', () => {
  const req = { archiveSearchRole: 'searcher' };
  const res = fakeRes();
  let nextCalled = false;
  router.requireArchiveSearchAdmin(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
});

test('router — requireArchiveSearchAdmin allows "admin"', () => {
  const req = { archiveSearchRole: 'admin' };
  const res = fakeRes();
  let nextCalled = false;
  router.requireArchiveSearchAdmin(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
});

// ============================================================
// PART 6 — screening-pass.js: shape only (no invocation — every exported
// function touches Supabase).
// ============================================================
const screeningPass = require('../lib/screening-pass');

test('screening-pass — exports the expected shape', () => {
  assert.strictEqual(typeof screeningPass.runScreeningPassChunk, 'function');
  assert.strictEqual(typeof screeningPass.getScreeningStatus, 'function');
  assert.strictEqual(typeof screeningPass.SCREENING_VERSION, 'string');
  assert.ok(screeningPass.SCREENING_VERSION.length > 0);
  assert.strictEqual(typeof screeningPass.SCREENING_PASS_CHUNK_SIZE, 'number');
  assert.ok(screeningPass.SCREENING_PASS_CHUNK_SIZE > 0, 'expected a positive chunk size');
});

test('screening-pass — summarizeHoldMechanisms distinguishes cooccurrence_match from keyword_phrase_match (Finding 8\'s three-way distinction, not collapsed to two)', () => {
  const cooccurrenceOnly = checkThread({
    threadId: 't-cooccur',
    legalHoldTag: false,
    messages: [{ messageId: 'm1', from: 'tenant@example.com', to: [], subject: '', body: 'I want to file a complaint about fair housing.', date: '2024-01-01' }],
  });
  assert.deepStrictEqual(screeningPass.summarizeHoldMechanisms(cooccurrenceOnly), ['cooccurrence_match'], 'expected ONLY cooccurrence_match, not keyword_phrase_match, for a co-occurrence-only hit');

  // NOTE: the three Fair Housing HOLD_TERMS phrases ("fair housing
  // complaint", "hud complaint", "crd complaint") structurally overlap
  // with the co-occurrence regex pair by construction — the co-occurrence
  // check exists specifically to generalize beyond those exact phrases, so
  // any text containing one of them legitimately trips BOTH mechanisms at
  // once (matches Finding 4's own "checked in addition to [the literal
  // list]," not instead of it). A genuinely non-overlapping Tier 2 literal
  // term ("demand letter") is used here to isolate keyword_phrase_match
  // from cooccurrence_match.
  const literalPhraseOnly = checkThread({
    threadId: 't-literal',
    legalHoldTag: false,
    messages: [{ messageId: 'm1', from: 'tenant@example.com', to: [], subject: '', body: 'We received a demand letter from their attorney.', date: '2024-01-01' }],
  });
  assert.deepStrictEqual(screeningPass.summarizeHoldMechanisms(literalPhraseOnly), ['keyword_phrase_match'], 'expected ONLY keyword_phrase_match for a literal-phrase hit, not cooccurrence_match');

  const fairHousingComplaintPhraseTripsBoth = checkThread({
    threadId: 't-both',
    legalHoldTag: false,
    messages: [{ messageId: 'm1', from: 'tenant@example.com', to: [], subject: '', body: 'Please see the attached fair housing complaint.', date: '2024-01-01' }],
  });
  assert.deepStrictEqual(
    screeningPass.summarizeHoldMechanisms(fairHousingComplaintPhraseTripsBoth).sort(),
    ['cooccurrence_match', 'keyword_phrase_match'],
    'expected the literal "fair housing complaint" phrase to legitimately trip BOTH mechanisms at once — it structurally satisfies both the literal-phrase list and the co-occurrence pair'
  );

  const lawyerOnly = checkThread({
    threadId: 't-lawyer',
    legalHoldTag: false,
    messages: [{ messageId: 'm1', from: 'tenant@example.com', to: [], subject: '', body: 'We spoke with our lawyer yesterday.', date: '2024-01-01' }],
  });
  assert.deepStrictEqual(screeningPass.summarizeHoldMechanisms(lawyerOnly), ['keyword_phrase_match'], 'expected keyword_phrase_match for the new "lawyer" term');
});

// ============================================================
// PART 6b — screening-pass.js's circuit breaker (Scotty, 2026-09-18,
// automatic-scheduling clearance's one condition). Pure function, no I/O —
// exercised directly rather than through a real (Supabase-backed)
// runScreeningPassChunk() call, matching PART 6's own "shape only, every
// exported function touches Supabase" restraint for this file.
// ============================================================
test('circuitBreakerShouldTrip — a single early error never trips it (below CIRCUIT_BREAKER_MIN_ERRORS)', () => {
  assert.strictEqual(screeningPass.circuitBreakerShouldTrip({ conversations_processed: 0, errors: 1 }), false);
  assert.strictEqual(screeningPass.circuitBreakerShouldTrip({ conversations_processed: 0, errors: 2 }), false);
});

test('circuitBreakerShouldTrip — errors reaching MIN_ERRORS with a high rate trips it (e.g. 3 failures in a row)', () => {
  assert.strictEqual(
    screeningPass.circuitBreakerShouldTrip({ conversations_processed: 0, errors: screeningPass.CIRCUIT_BREAKER_MIN_ERRORS }),
    true
  );
});

test('circuitBreakerShouldTrip — the same error COUNT spread across a much larger, mostly-successful chunk does NOT trip it (rate below threshold)', () => {
  assert.strictEqual(
    screeningPass.circuitBreakerShouldTrip({ conversations_processed: 100, errors: screeningPass.CIRCUIT_BREAKER_MIN_ERRORS }),
    false
  );
});

test('circuitBreakerShouldTrip — the hard error-count ceiling trips it even at a low, sustained rate (CIRCUIT_BREAKER_MAX_ERRORS)', () => {
  assert.strictEqual(
    screeningPass.circuitBreakerShouldTrip({ conversations_processed: 1000, errors: screeningPass.CIRCUIT_BREAKER_MAX_ERRORS }),
    true
  );
  // one below the ceiling, same low rate, should NOT trip on the ceiling
  // alone (and the rate here is nowhere near CIRCUIT_BREAKER_ERROR_RATE).
  assert.strictEqual(
    screeningPass.circuitBreakerShouldTrip({ conversations_processed: 1000, errors: screeningPass.CIRCUIT_BREAKER_MAX_ERRORS - 1 }),
    false
  );
});

test('circuitBreakerShouldTrip — exactly at the rate threshold trips (>= not >)', () => {
  // 3 errors out of 6 attempted = exactly CIRCUIT_BREAKER_ERROR_RATE (0.5).
  assert.strictEqual(screeningPass.CIRCUIT_BREAKER_ERROR_RATE, 0.5, 'this test assumes the documented 50% default — update it if that constant changes');
  assert.strictEqual(
    screeningPass.circuitBreakerShouldTrip({ conversations_processed: 3, errors: 3 }),
    true
  );
});

test('runScreeningPassChunk summary shape includes circuit_breaker_tripped/circuit_breaker_reason (source-scanned — this DB/AI-touching function is never invoked in this suite, matching PART 6\'s own restraint)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/screening-pass.js'), 'utf8');
  assert.ok(src.includes('circuit_breaker_tripped: false'), 'expected the summary object to default circuit_breaker_tripped to false');
  assert.ok(src.includes('circuitBreakerShouldTrip(summary)'), 'expected the per-conversation loop to check circuitBreakerShouldTrip() after recording an error');
});

// ============================================================
// PART 6c — lib/significance-lock.js: the cross-process lock Asimov
// flagged as a real gap (automatic-scheduling review, 2026-09-18) between
// the standalone batch/pilot scripts and any future live/scheduled route.
// Uses a REAL temp file (via ARCHIVE_SEARCH_SIGNIFICANCE_LOCK_PATH), never
// the real /tmp path a live run would use, and always cleans it up —
// same "real behavior, isolated fixture" approach PART 9's temp-file
// guardrail-catch test already establishes for this suite.
// ============================================================
const significanceLockTestPath = path.join(os.tmpdir(), `archive-search-significance-pass-TEST-${process.pid}.lock`);
process.env.ARCHIVE_SEARCH_SIGNIFICANCE_LOCK_PATH = significanceLockTestPath;
delete require.cache[require.resolve('../lib/significance-lock')];
const significanceLock = require('../lib/significance-lock');

function cleanSignificanceLockFile() {
  try { fs.unlinkSync(significanceLockTestPath); } catch (_) { /* already gone — fine */ }
}

test('significance-lock — acquireLock then releaseLock: lock file exists while held, gone after release', () => {
  cleanSignificanceLockFile();
  significanceLock.acquireLock('test-owner');
  assert.ok(fs.existsSync(significanceLockTestPath), 'expected the lock file to exist while held');
  significanceLock.releaseLock();
  assert.ok(!fs.existsSync(significanceLockTestPath), 'expected the lock file to be gone after release');
});

test('significance-lock — acquiring an already-held (live) lock throws SignificancePassLockedError, naming the real holder', () => {
  cleanSignificanceLockFile();
  significanceLock.acquireLock('first-holder');
  assert.throws(
    () => significanceLock.acquireLock('second-holder'),
    (err) => err instanceof significanceLock.SignificancePassLockedError && /first-holder/.test(err.message)
  );
  significanceLock.releaseLock();
});

test('significance-lock — a stale lock (recorded pid no longer running) is reclaimed automatically, not left blocking forever', () => {
  cleanSignificanceLockFile();
  // A pid essentially guaranteed not to be running right now.
  fs.writeFileSync(significanceLockTestPath, JSON.stringify({ pid: 999999, hostname: 'stale-host', ownerLabel: 'dead-process', acquiredAt: '2020-01-01T00:00:00.000Z' }));
  significanceLock.acquireLock('reclaimer');
  const contents = JSON.parse(fs.readFileSync(significanceLockTestPath, 'utf8'));
  assert.strictEqual(contents.pid, process.pid, 'expected the stale lock to be reclaimed by this (live) process');
  significanceLock.releaseLock();
});

test('significance-lock — releaseLock() never deletes a lock held by a DIFFERENT pid (no accidental steal)', () => {
  cleanSignificanceLockFile();
  fs.writeFileSync(significanceLockTestPath, JSON.stringify({ pid: process.pid + 1, hostname: 'other-host', ownerLabel: 'someone-else', acquiredAt: new Date().toISOString() }));
  significanceLock.releaseLock();
  assert.ok(fs.existsSync(significanceLockTestPath), 'expected releaseLock() to leave a different pid\'s lock file alone');
  cleanSignificanceLockFile();
});

// Both properties below share the same lock file fixture and must not run
// concurrently against it (two separate asyncTest() registrations would
// both start immediately and interleave) — combined into one asyncTest
// with real sequential awaits between steps, same reasoning PART 18's own
// sequential-runner IIFE gives for bundling its multi-step scenarios.
asyncResults.push((async () => {
  try {
    cleanSignificanceLockFile();
    await assert.rejects(
      () => significanceLock.withSignificanceLock('test-owner', async () => { throw new Error('boom'); }),
      /boom/
    );
    assert.ok(!fs.existsSync(significanceLockTestPath), 'expected the lock to be released even after the wrapped function threw');

    cleanSignificanceLockFile();
    const result = await significanceLock.withSignificanceLock('test-owner', async () => 'real-result');
    assert.strictEqual(result, 'real-result');
    assert.ok(!fs.existsSync(significanceLockTestPath), 'expected the lock to be released after a successful run');
  } finally {
    cleanSignificanceLockFile(); // leave no fixture file behind for a later suite run
  }
  return { name: 'significance-lock — withSignificanceLock releases on both throw and success, and returns the wrapped function\'s resolved value', pass: true };
})());

// ============================================================
// PART 7 (async) — fair-housing-batch-self-report.js's fail-closed
// contract, exercised for real: no ANTHROPIC_API_KEY is set, so the real
// client() call throws, and the real catch block must resolve to the
// fail-closed default rather than throwing out of
// selfReportFairHousingContent() itself.
// ============================================================
const { selfReportFairHousingContent, FAIR_HOUSING_SELF_REPORT_VERSION } = require('../lib/fair-housing-batch-self-report');

asyncTest('fair-housing-batch-self-report — fails CLOSED (never throws) when ANTHROPIC_API_KEY is missing', async () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = await selfReportFairHousingContent({ threadText: 'Hello, just checking on my maintenance request.' });
    assert.deepStrictEqual(result, { flagged: true, category: 'model_self_report_failed_closed' });
  } finally {
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  }
});

test('fair-housing-batch-self-report — exports a real version string', () => {
  assert.strictEqual(typeof FAIR_HOUSING_SELF_REPORT_VERSION, 'string');
  assert.ok(FAIR_HOUSING_SELF_REPORT_VERSION.length > 0);
});

// ============================================================
// PART 8 — fair-housing-wide-net-terms.js (archive-search-fair-housing-
// option-b-spec.md, build-and-validate-only). NOT wired into the live
// path — see PART 9 below for the static proof of that boundary.
// ============================================================
const wideNet = require('../lib/fair-housing-wide-net-terms');

test('fair-housing-wide-net-terms — exports a real version string', () => {
  assert.strictEqual(typeof wideNet.TERMS_VERSION, 'string');
  assert.ok(wideNet.TERMS_VERSION.length > 0);
});

test('fair-housing-wide-net-terms — a literal phrase matches on its own (Shape A, no companion needed)', () => {
  const result = wideNet.matchesWideNet('Tenant is requesting a reasonable accommodation for their service animal.');
  assert.strictEqual(result.matched, true);
  assert.ok(result.matchedPhrases.includes('reasonable accommodation'));
});

test('fair-housing-wide-net-terms — ordinary property-management correspondence does not match at all', () => {
  const result = wideNet.matchesWideNet('The kitchen sink is leaking. Vendor scheduled to arrive Tuesday 9-11am. Rent was received on the 1st, thank you.');
  assert.strictEqual(result.matched, false);
  assert.deepStrictEqual(result.matchedPhrases, []);
  assert.deepStrictEqual(result.matchedCooccurrencePairs, []);
});

test('fair-housing-wide-net-terms — race co-occurrence: identity word alone does NOT match (no adverse-treatment companion)', () => {
  const result = wideNet.matchesWideNet('We discussed the race for city council at the HOA meeting.');
  assert.strictEqual(result.matched, false);
});

test('fair-housing-wide-net-terms — race co-occurrence: identity word + adverse-treatment language DOES match', () => {
  const result = wideNet.matchesWideNet('The applicant said we refused to rent because of his race.');
  assert.strictEqual(result.matched, true);
  assert.ok(result.matchedCooccurrencePairs.includes('race_color_cooccurrence'));
  assert.ok(result.matchedCategories.includes('race_color'));
});

// --- FIX 1 (Asimov/Mason review): 'calfresh' and 'deportation' converted
// from bare-word phrases to co-occurrence pairs. ---
test('fair-housing-wide-net-terms — FIX 1: "calfresh" is NOT a bare literal phrase anymore', () => {
  assert.strictEqual(
    wideNet.WIDE_NET_PHRASES.some((p) => p.term === 'calfresh'),
    false,
    'expected "calfresh" to be removed from the flat literal-phrase list entirely'
  );
});

test('fair-housing-wide-net-terms — FIX 1: "calfresh" alone, no adverse-treatment language, does NOT match', () => {
  const result = wideNet.matchesWideNet('Please confirm the applicant\'s CalFresh benefits letter is attached to the file.');
  assert.strictEqual(result.matched, false, 'expected no match — bare "calfresh" alone must not fire the wide net after the fix');
});

test('fair-housing-wide-net-terms — FIX 1: "calfresh" + adverse-treatment language DOES match, via the new co-occurrence pair', () => {
  const result = wideNet.matchesWideNet('The applicant said we refused to rent to them because they use CalFresh.');
  assert.strictEqual(result.matched, true);
  assert.ok(result.matchedCooccurrencePairs.includes('source_of_income_calfresh_cooccurrence'));
});

test('fair-housing-wide-net-terms — FIX 1: "deportation" is NOT a bare literal phrase anymore', () => {
  assert.strictEqual(
    wideNet.WIDE_NET_PHRASES.some((p) => p.term === 'deportation'),
    false,
    'expected "deportation" to be removed from the flat literal-phrase list entirely'
  );
});

test('fair-housing-wide-net-terms — FIX 1: "deportation" alone, no adverse-treatment language, does NOT match', () => {
  const result = wideNet.matchesWideNet('Tenant mentioned a family member is dealing with a deportation matter and may need to break the lease early.');
  assert.strictEqual(result.matched, false, 'expected no match — bare "deportation" alone must not fire the wide net after the fix');
});

test('fair-housing-wide-net-terms — FIX 1: "deportation" + adverse-treatment language DOES match, via the new co-occurrence pair', () => {
  const result = wideNet.matchesWideNet('The applicant said the leasing agent declined their application because of the deportation case.');
  assert.strictEqual(result.matched, true);
  assert.ok(result.matchedCooccurrencePairs.includes('immigration_deportation_cooccurrence'));
});

// --- FIX 2 (Mason review): 'separated' removed from the marital_status
// co-occurrence pair's `a` side; replaced with 'getting divorced' /
// 'going through a divorce' / 'estranged spouse'. ---
test('fair-housing-wide-net-terms — FIX 2: ordinary, non-marital "separated" + adverse-treatment language does NOT match marital_status', () => {
  // Real property-management sense of "separated" — separate utility
  // meters — deliberately paired with adverse-treatment language to prove
  // the co-occurrence pair itself no longer fires on this word at all, not
  // just that this one sentence lacks a match for some other reason.
  const result = wideNet.matchesWideNet('The owner refused to rent until the utilities were separated between the two units.');
  assert.strictEqual(
    result.matchedCooccurrencePairs.includes('marital_status_cooccurrence'),
    false,
    'expected "separated" (utility-meter sense) + adverse-treatment language to NOT trip marital_status_cooccurrence after the fix'
  );
});

test('fair-housing-wide-net-terms — FIX 2: "estranged spouse" + adverse-treatment language DOES match marital_status', () => {
  const result = wideNet.matchesWideNet('The applicant said the manager refused to rent to her because of her estranged spouse.');
  assert.strictEqual(result.matched, true);
  assert.ok(result.matchedCooccurrencePairs.includes('marital_status_cooccurrence'));
});

test('fair-housing-wide-net-terms — FIX 2: "getting divorced" + adverse-treatment language DOES match marital_status', () => {
  const result = wideNet.matchesWideNet('She said they denied her application because she is getting divorced.');
  assert.strictEqual(result.matched, true);
  assert.ok(result.matchedCooccurrencePairs.includes('marital_status_cooccurrence'));
});

test('fair-housing-wide-net-terms — FIX 2: "going through a divorce" + adverse-treatment language DOES match marital_status', () => {
  const result = wideNet.matchesWideNet('He said they turned him down because he is going through a divorce.');
  assert.strictEqual(result.matched, true);
  assert.ok(result.matchedCooccurrencePairs.includes('marital_status_cooccurrence'));
});

test('fair-housing-wide-net-terms — FIX 2: unchanged terms ("divorced", "widow", "spouse") still fire the pair (no regression)', () => {
  const divorced = wideNet.matchesWideNet('The applicant said the manager declined her application because she is divorced.');
  assert.ok(divorced.matchedCooccurrencePairs.includes('marital_status_cooccurrence'));
  const widow = wideNet.matchesWideNet('The tenant said staff made comments about her being a widow.');
  assert.ok(widow.matchedCooccurrencePairs.includes('marital_status_cooccurrence'));
});

// --- discrimination_general: the one deliberate bare-word exception,
// unchanged from the spec, flagged for Peter's own sign-off. ---
test('fair-housing-wide-net-terms — discrimination_general fires as a bare word (deliberate, named exception)', () => {
  const result = wideNet.matchesWideNet('The owner said this is discrimination and nothing else.');
  assert.strictEqual(result.matched, true);
  assert.ok(result.matchedBareWordExceptions.includes('discrimination'));
  assert.ok(result.matchedCategories.includes('discrimination_general'));
});

test('fair-housing-wide-net-terms — "too old" / "too young for" are excluded everywhere in the file (spec Section 1.4 item 1)', () => {
  const allPhraseTerms = wideNet.WIDE_NET_PHRASES.map((p) => p.term);
  assert.strictEqual(allPhraseTerms.includes('too old'), false);
  assert.strictEqual(allPhraseTerms.includes('too young for'), false);
  const result = wideNet.matchesWideNet('This unit is too old for the current wiring code, and the tenant is too young for a long-term lease.');
  assert.strictEqual(result.matched, false, 'expected no match — these two phrases are deliberately not in the wide net at all');
});

// --- v2 addition: military_veteran_status (outside-counsel opinion,
// Section 6, safeguard #6 — genuinely missing before; see the v2 header
// note in fair-housing-wide-net-terms.js). ---
test('fair-housing-wide-net-terms — TERMS_VERSION bumped to v2', () => {
  assert.strictEqual(wideNet.TERMS_VERSION, 'fair-housing-wide-net-terms-v2');
});

test('fair-housing-wide-net-terms — "veteran status" matches on its own (Shape A phrase)', () => {
  const result = wideNet.matchesWideNet('We discussed the applicant\'s veteran status during screening.');
  assert.strictEqual(result.matched, true);
  assert.ok(result.matchedPhrases.includes('veteran status'));
  assert.ok(result.matchedCategories.includes('military_veteran_status'));
});

test('fair-housing-wide-net-terms — "military discrimination" matches on its own (Shape A phrase)', () => {
  const result = wideNet.matchesWideNet('The tenant alleged military discrimination by the property manager.');
  assert.strictEqual(result.matched, true);
  assert.ok(result.matchedPhrases.includes('military discrimination'));
});

test('fair-housing-wide-net-terms — military_veteran_status cooccurrence: "service member" + adverse-treatment language DOES match', () => {
  const result = wideNet.matchesWideNet('The applicant said the manager refused to rent to her because she is a service member.');
  assert.strictEqual(result.matched, true);
  assert.ok(result.matchedCooccurrencePairs.includes('military_veteran_status_cooccurrence'));
  assert.ok(result.matchedCategories.includes('military_veteran_status'));
});

test('fair-housing-wide-net-terms — military_veteran_status cooccurrence: "veteran" + adverse-treatment language DOES match', () => {
  const result = wideNet.matchesWideNet('The applicant said the leasing agent turned her down because she is a veteran.');
  assert.strictEqual(result.matched, true);
  assert.ok(result.matchedCooccurrencePairs.includes('military_veteran_status_cooccurrence'));
});

test('fair-housing-wide-net-terms — military_veteran_status cooccurrence: "PCS orders" + adverse-treatment language DOES match', () => {
  const result = wideNet.matchesWideNet('He said the manager declined his application because of his upcoming PCS orders.');
  assert.strictEqual(result.matched, true);
  assert.ok(result.matchedCooccurrencePairs.includes('military_veteran_status_cooccurrence'));
});

test('fair-housing-wide-net-terms — military_veteran_status cooccurrence: "active-duty" (hyphenated) + adverse-treatment language DOES match', () => {
  const result = wideNet.matchesWideNet('She said they refused to rent to her because she is active-duty.');
  assert.strictEqual(result.matched, true);
  assert.ok(result.matchedCooccurrencePairs.includes('military_veteran_status_cooccurrence'));
});

test('fair-housing-wide-net-terms — military_veteran_status cooccurrence: "active duty" alone, no adverse-treatment language, does NOT match (real SCRA lease-break correspondence is routine and not itself a Fair Housing signal)', () => {
  const result = wideNet.matchesWideNet('Tenant is on active duty and requesting early lease termination per SCRA.');
  assert.strictEqual(result.matched, false, 'expected no match — an SCRA/PCS lease-break request alone must not fire the wide net');
});

test('fair-housing-wide-net-terms — military_veteran_status cooccurrence: "PCS orders" alone, no adverse-treatment language, does NOT match', () => {
  const result = wideNet.matchesWideNet('Tenant provided a copy of their PCS orders for the early move-out request.');
  assert.strictEqual(result.matched, false, 'expected no match — bare PCS-orders relocation correspondence must not fire the wide net');
});

test('fair-housing-wide-net-terms — military_veteran_status cooccurrence: "military family" alone, no adverse-treatment language, does NOT match', () => {
  const result = wideNet.matchesWideNet('The unit is popular with military families near the base.');
  assert.strictEqual(result.matched, false, 'expected no match — "military family" alone must not fire the wide net');
});

// --- Plausible false-positive check: "military" and "veteran" are common
// bare words in ordinary, non-discriminatory business correspondence
// ("military discount", "veteran-owned business"). This is exactly why
// they sit in the cooccurrence `a` side instead of the phrase list — proves
// that placement actually holds against a realistic false-positive risk.
test('fair-housing-wide-net-terms — false-positive check: "military discount" mentioned with no adverse-treatment language does NOT match', () => {
  const result = wideNet.matchesWideNet('We offer a military discount on the application fee.');
  assert.strictEqual(result.matched, false, 'expected no match — an unrelated military discount mention must not fire the wide net');
});

test('fair-housing-wide-net-terms — false-positive check: "veteran-owned business" mentioned with no adverse-treatment language does NOT match', () => {
  const result = wideNet.matchesWideNet('Our new landscaping vendor is a veteran-owned business.');
  assert.strictEqual(result.matched, false, 'expected no match — an unrelated veteran-owned-business mention must not fire the wide net');
});

// ============================================================
// PART 9 — THE SCOPE BOUNDARY, PROVEN STATICALLY: this section originally
// proved a negative — that the wide-net module was NOT yet referenced
// anywhere in handleNonHeldConversation()'s own function body, back when
// wiring it in would have been unauthorized. That tripwire did its job: it
// never fired for an unauthorized wiring, and it has now been retired only
// because the real thing it was guarding against has actually happened, the
// right way. compliance/archive-search-option-b-governance-review.md is
// the real, complete authorization record — Asimov + Mason review of the
// real outside-counsel opinion, Peter's own recorded decisions, closing
// with "This document now DOES authorize Q to wire matchesWideNet() into
// the live screening pass." Below is the same static-proof discipline,
// pointed at the new reality: prove handleNonHeldConversation() DOES call
// matchesWideNet() now, so this build can't ship on the strength of a
// comment claiming the wiring happened when the code doesn't actually do
// it. A behavioral test can't prove which code path ran without a real
// Supabase project; a static source check on the real file on disk can.
// ============================================================
const screeningPassSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'screening-pass.js'), 'utf8');

function extractFunctionBody(source, functionSignature) {
  const start = source.indexOf(functionSignature);
  assert.ok(start !== -1, `expected to find "${functionSignature}" in screening-pass.js`);
  // Next top-level "function " or "async function " after this one marks
  // the end of this function's body for our purposes (every function in
  // this file is separated by at least one blank line before the next
  // declaration — true for every function in the real file today).
  const nextFnMarkers = ['\nasync function ', '\nfunction '];
  let end = source.length;
  for (const marker of nextFnMarkers) {
    const idx = source.indexOf(marker, start + functionSignature.length);
    if (idx !== -1 && idx < end) end = idx;
  }
  return source.slice(start, end);
}

test('screening-pass.js — SCREENING_VERSION is bumped to v5-hold-gate-removed — proves the live version tag reflects the blanket legal-hold exclusion being removed for archive search (compliance/archive-search-held-release-asimov-confirmation.md)', () => {
  assert.strictEqual(screeningPass.SCREENING_VERSION, 'archive-search-screening-v5-hold-gate-removed');
});

test('screening-pass.js — handleHeldConversation is genuinely gone, not just unreachable — proves the removal was a real deletion, not dead code left behind', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'screening-pass.js'), 'utf8');
  assert.strictEqual(/function handleHeldConversation/.test(src), false, 'expected handleHeldConversation to be fully removed from screening-pass.js');
});

test('screening-pass.js — runScreeningPassChunk() itself no longer branches on holdResult.held (dryRunWideNetMeasurement()\'s own, separate, never-wired-in .held check is a different, deliberately out-of-scope measurement and is untouched by this test)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'screening-pass.js'), 'utf8');
  const fnStart = src.indexOf('async function runScreeningPassChunk');
  const fnEnd = src.indexOf('\nasync function', fnStart + 1);
  const fnBody = src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
  assert.strictEqual(/holdResult\.held/.test(fnBody), false, 'expected no remaining branch on holdResult.held inside runScreeningPassChunk() specifically');
});

test('screening-pass.js — summarizeHoldMechanisms is still exported and tested, even though this file no longer calls it internally', () => {
  assert.strictEqual(typeof screeningPass.summarizeHoldMechanisms, 'function');
});

test('screening-pass.js — handleNonHeldConversation()\'s own function body NEVER actually CALLS checkClaim() anymore — proves Layer 1 removal is real code, not just a comment claiming it (archive search only; checkClaim() itself is untouched, see the no-import test below). Explanatory comments inside the function are allowed to name checkClaim() in prose — only a real invocation is checked for here.', () => {
  const body = extractFunctionBody(screeningPassSource, 'async function handleNonHeldConversation(');
  assert.strictEqual(/\bawait\s+checkClaim\s*\(/.test(body), false, 'expected zero real invocations of checkClaim() inside handleNonHeldConversation() itself');
  assert.ok(body.includes('selfReportFairHousingContent('), 'expected the self-report call to still exist and now be the sole determinant of screening_result');
});

test('screening-pass.js — the checkClaim import is removed from this file entirely (no lingering unused import)', () => {
  assert.strictEqual(/require\(['"]\.\.\/\.\.\/maintenance-history\/lib\/content-check['"]\)/.test(screeningPassSource), false, 'expected no require() of content-check.js — checkClaim() is not imported by this file anymore');
});

test('screening-pass.js — runScreeningPassChunk()\'s own function body contains NO reference to the wide net', () => {
  const body = extractFunctionBody(screeningPassSource, 'async function runScreeningPassChunk()');
  assert.strictEqual(/matchesWideNet|wideNet|WideNet/.test(body), false, 'expected zero references to the wide-net module inside runScreeningPassChunk() itself');
});

test('screening-pass.js — handleNonHeldConversation()\'s own function body DOES reference the wide net now — proves the authorized wiring (compliance/archive-search-option-b-governance-review.md) is real code, not just a comment claiming it', () => {
  const body = extractFunctionBody(screeningPassSource, 'async function handleNonHeldConversation(');
  assert.ok(/matchesWideNet/.test(body), 'expected a real call to matchesWideNet() inside handleNonHeldConversation() itself');
  assert.ok(body.includes('selfReportFairHousingContent('), 'expected the self-report call to still exist — now reached only on a wide-net match, not removed by the wiring');
  assert.ok(body.includes("'wide_net_skip'"), 'expected the wide_net_skip tag — the gate\'s own no-match outcome — to be present in the real code, not just claimed');
});

test('screening-pass.js — dryRunWideNetMeasurement() is exported, additive, and never called by runScreeningPassChunk() or handleNonHeldConversation()', () => {
  assert.strictEqual(typeof screeningPass.dryRunWideNetMeasurement, 'function');
  const runChunkBody = extractFunctionBody(screeningPassSource, 'async function runScreeningPassChunk()');
  const handleBody = extractFunctionBody(screeningPassSource, 'async function handleNonHeldConversation(');
  assert.strictEqual(runChunkBody.includes('dryRunWideNetMeasurement'), false);
  assert.strictEqual(handleBody.includes('dryRunWideNetMeasurement'), false);
});

test('router.js — process-pending route still calls ONLY runScreeningPassChunk() — dryRunWideNetMeasurement is never routed', () => {
  const routerSource = fs.readFileSync(path.join(__dirname, '..', 'router.js'), 'utf8');
  assert.strictEqual(routerSource.includes('dryRunWideNetMeasurement'), false, 'expected router.js to have zero references to the dry-run function — it is a manually-invoked script-only path, never an HTTP route');
  assert.ok(routerSource.includes('runScreeningPassChunk'), 'expected the existing process-pending route wiring to be unchanged');
});

// ============================================================
// PART 10 — Archive Search escalation mechanism (archive-search-
// escalation-mechanism-spec.md, Section 3.3/5). Same restraint as every
// other part of this file: no route handler or DB-touching function is
// invoked (all three new routes and fetchEarliestBodyTextForConversations
// touch Supabase) — only shape and real-source-on-disk checks, proving
// the routes exist, are wired to the correct access-control middleware,
// and (mirroring PART 9's static boundary-proof style for the wide net)
// that the escalate route is genuinely gated on the full searcher+admin
// population while the review/resolve routes are admin-only, exactly as
// spec Section 1 requires — not asserted from reading the code once, but
// checked against the real file on disk.
// ============================================================

test('screening-pass — fetchEarliestBodyTextForConversations is exported as a function (Section 3.3\'s export route dependency)', () => {
  assert.strictEqual(typeof screeningPass.fetchEarliestBodyTextForConversations, 'function');
});

test('router.js — POST /api/archive-search/escalate is gated on requireArchiveSearchAccess (the full searcher+admin population), NOT admin-only', () => {
  const line = routerSourceLine(fs.readFileSync(path.join(__dirname, '..', 'router.js'), 'utf8'), "router.post('/api/archive-search/escalate'");
  assert.ok(line.includes('requireArchiveSearchAccess'), 'expected the escalate route to use requireArchiveSearchAccess');
  assert.strictEqual(line.includes('requireArchiveSearchAdmin'), false, 'expected the escalate route to NOT be admin-only — spec Section 1 requires the full searcher+admin population');
});

test('router.js — GET /api/archive-search/escalations-review-export is admin-only', () => {
  const line = routerSourceLine(fs.readFileSync(path.join(__dirname, '..', 'router.js'), 'utf8'), "router.get('/api/archive-search/escalations-review-export'");
  assert.ok(line.includes('requireArchiveSearchAdmin'), 'expected the escalations-review-export route to use requireArchiveSearchAdmin');
});

test('router.js — POST /api/archive-search/escalations/:id/resolve is admin-only', () => {
  const line = routerSourceLine(fs.readFileSync(path.join(__dirname, '..', 'router.js'), 'utf8'), "router.post('/api/archive-search/escalations/:id/resolve'");
  assert.ok(line.includes('requireArchiveSearchAdmin'), 'expected the resolve route to use requireArchiveSearchAdmin');
});

test('router.js — the escalate route\'s audit log entry includes notification_email_sent (spec Section 4\'s own JSON schema), and actor_type is hardcoded \'human\'', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'router.js'), 'utf8');
  const start = source.indexOf("router.post('/api/archive-search/escalate'");
  const end = source.indexOf("router.get('/api/archive-search/escalations-review-export'");
  assert.ok(start !== -1 && end !== -1 && end > start, 'expected to find both route boundaries');
  const body = source.slice(start, end);
  assert.ok(body.includes('archive_search.escalation_reported'), 'expected the escalation_reported action name');
  assert.ok(body.includes('notification_email_sent: notificationSent'), 'expected notification_email_sent in the audit log details, set from the real send result');
  assert.ok(/actor_type:\s*'human'/.test(body), 'expected actor_type hardcoded to human — no code path here is automated');
});

test('router.js — the resolve route never reverts a resolved escalation back to open, and closes the same concurrent-request race window the override revoke route already closes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'router.js'), 'utf8');
  const start = source.indexOf("router.post('/api/archive-search/escalations/:id/resolve'");
  const body = source.slice(start, start + 3000);
  assert.ok(body.includes(".eq('status', 'open')"), 'expected the update to be filtered on status=open, closing the race window between the read and the write');
  assert.ok(body.includes("resolution !== 'confirmed' && resolution !== 'false_alarm'"), 'expected resolution to be validated against exactly the two real lifecycle values');
});

// ============================================================
// PART 11 — Reopen route Round 3 requirements (compliance/archive-
// search-escalation-mechanism-review.md, "Round 3"). Same static,
// source-on-disk style as PART 10 — no route handler is invoked.
// ============================================================

test('router.js — POST /api/archive-search/escalations/:id/reopen is admin-only', () => {
  const line = routerSourceLine(fs.readFileSync(path.join(__dirname, '..', 'router.js'), 'utf8'), "router.post('/api/archive-search/escalations/:id/reopen'");
  assert.ok(line.includes('requireArchiveSearchAdmin'), 'expected the reopen route to use requireArchiveSearchAdmin');
});

test('router.js — the reopen route requires litigation_hold_attestation as its own separate, non-empty field (Mason\'s Round 3 requirement #2)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'router.js'), 'utf8');
  const start = source.indexOf("router.post('/api/archive-search/escalations/:id/reopen'");
  const end = source.indexOf("router.post('/api/archive-search/escalations/:id/reopen'", start + 1);
  const body = source.slice(start, end === -1 ? start + 4000 : end);
  assert.ok(body.includes('requireNonEmptyReason(req.body.litigation_hold_attestation)'), 'expected litigation_hold_attestation to be validated the same way reopen_reason is');
  assert.ok(/if \(!litigationHoldAttestation\)[\s\S]{0,80}status\(400\)/.test(body), 'expected a 400 when litigation_hold_attestation is missing or blank');
  assert.ok(body.includes('litigation_hold_attestation: litigationHoldAttestation'), 'expected the validated attestation to actually be written to the row on reopen');
  assert.ok(!body.includes("reopen_reason} litigation"), 'expected the attestation to stay its own field, never concatenated into reopen_reason text');
});

test('router.js — the reopen route rejects a same-admin reopen in application code, and still relies on the database CHECK as defense-in-depth (Mason\'s Round 3 requirement #1)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'router.js'), 'utf8');
  const start = source.indexOf("router.post('/api/archive-search/escalations/:id/reopen'");
  const end = source.indexOf("router.post('/api/archive-search/escalations/:id/reopen'", start + 1);
  const body = source.slice(start, end === -1 ? start + 4000 : end);
  assert.ok(body.includes('resolved_by'), 'expected the route to fetch resolved_by so it can compare against the requesting admin');
  assert.ok(/existing\.resolved_by\s*&&\s*existing\.resolved_by\s*===\s*reopeningAdmin/.test(body), 'expected an explicit same-admin comparison before allowing the reopen');
  assert.ok(/status\(403\)/.test(body), 'expected a 403 when the reopening admin matches resolved_by');
  assert.ok(body.includes('reopened_by IS DISTINCT FROM'), 'expected the route comment to name the database-level CHECK backing this up as defense-in-depth');
});

test('router.js — the reopen route\'s audit log entry includes the litigation_hold_attestation actually written, and actor_type is hardcoded \'human\'', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'router.js'), 'utf8');
  const start = source.indexOf("router.post('/api/archive-search/escalations/:id/reopen'");
  const end = source.indexOf("SECTION 7", start);
  assert.ok(start !== -1 && end !== -1 && end > start, 'expected to find the reopen route and the following section boundary');
  const body = source.slice(start, end);
  assert.ok(body.includes('archive_search.escalation_reopened'), 'expected the escalation_reopened action name');
  assert.ok(body.includes('litigation_hold_attestation: updated.litigation_hold_attestation'), 'expected the audit log details to carry the attestation actually stored on the row, not the raw request body');
  assert.ok(/actor_type:\s*'human'/.test(body), 'expected actor_type hardcoded to human — no code path here ever reopens automatically');
});

// ============================================================
// PART 12 — The search routes (GET /api/archive-search/search, GET
// /api/archive-search/message/:id) — archive-search-technical-spec.md,
// "Routes Needed" and "The Search Mechanism." Same restraint as every
// other PART in this file: no route handler is invoked (both touch
// Supabase) — pure-function unit tests for buildSnippet()/
// extractQueryTerms(), plus static, source-on-disk checks proving the
// routes exist, are gated correctly, query only the safe view, and log
// the correct audit events. Real end-to-end behavior against live data is
// verified separately, directly against Supabase (see the build report).
// ============================================================

test('router — extractQueryTerms pulls plain words out of a websearch-style query, dropping operators/quotes/single letters', () => {
  assert.deepStrictEqual(router.extractQueryTerms('"fair housing" -mold OR leak'), ['fair', 'housing', 'mold', 'OR', 'leak']);
});

test('router — buildSnippet highlights the first literal match in body_text with <b>, and truncates with an ellipsis', () => {
  const body = 'Hello, ' + 'x'.repeat(100) + ' the kitchen sink is leaking badly and needs a plumber. ' + 'y'.repeat(100);
  const snippet = router.buildSnippet('', body, 'leaking');
  assert.ok(snippet.startsWith('…'), 'expected a leading ellipsis — the match is not at the very start of body_text');
  assert.ok(snippet.includes('<b>leaking</b>'), 'expected the matched term wrapped in <b>');
});

test('router — buildSnippet prefers a subject match over a body match, so a subject-only hit still shows something highlighted', () => {
  const snippet = router.buildSnippet('Renewal reminder for Unit 4B', 'Please let us know if you have questions.', 'renewal');
  assert.ok(snippet.includes('<b>Renewal</b>'), 'expected the subject match to be used, not an unhighlighted body excerpt');
});

test('router — buildSnippet falls back to a plain, unhighlighted excerpt when no query term appears literally in the text (e.g. the match came from Postgres tsvector stemming, not a literal substring)', () => {
  const body = 'The kitchen sink is dripping badly and needs a plumber.';
  const snippet = router.buildSnippet('', body, 'faucet');
  assert.strictEqual(snippet.includes('<b>'), false, 'expected no highlighting when no query term is present in the text at all');
  assert.ok(snippet.startsWith('The kitchen sink is dripping'), 'expected the fallback to be the start of body_text, not the highlighted path');
});

test('router — buildSnippet HTML-escapes body_text content before highlighting, so stored "<"/">"/"&" cannot break the response', () => {
  const snippet = router.buildSnippet('', 'The tenant wrote: cost < $500 & needs review re: leak', 'leak');
  assert.strictEqual(snippet.includes('cost < $500 & needs'), false, 'expected raw "<" and "&" to be escaped, not passed through verbatim');
  assert.ok(snippet.includes('&lt;') && snippet.includes('&amp;'), 'expected escaped entities in the excerpt');
});

test('router.js — GET /api/archive-search/search is gated on requireArchiveSearchAccess (the full searcher+admin population)', () => {
  const line = routerSourceLine(fs.readFileSync(path.join(__dirname, '..', 'router.js'), 'utf8'), "router.get('/api/archive-search/search'");
  assert.ok(line.includes('requireArchiveSearchAccess'), 'expected the search route to use requireArchiveSearchAccess');
});

test('router.js — GET /api/archive-search/message/:id is gated on requireArchiveSearchAccess', () => {
  const line = routerSourceLine(fs.readFileSync(path.join(__dirname, '..', 'router.js'), 'utf8'), "router.get('/api/archive-search/message/:id'");
  assert.ok(line.includes('requireArchiveSearchAccess'), 'expected the message route to use requireArchiveSearchAccess');
});

test('router.js — the search route defaults to missive_message_intake_search_safe, only moves to archive_search_corpus behind ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED plus a healthy kill-switch check, sorts delivered_at DESC, and uses websearch full-text search — never the raw table', () => {
  // Updated 2026-09-24 for the archive_search_corpus build (supabase/
  // migrations/20260924010000_archive_search_corpus_schema.sql): the route
  // no longer hardcodes a single literal `.from('missive_message_intake_
  // search_safe')` call — it queries a variable, searchTable, which
  // defaults to the safe view and only ever moves to archive_search_corpus
  // after an explicit, successful, request-time kill-switch check, gated
  // behind ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED (default OFF). This is an
  // intentional change to the route's contract, not a regression of the
  // original "never the raw table" guarantee — archive_search_corpus is
  // itself never the raw table (missive_message_intake), it's a second,
  // trigger-maintained, eligible-content-only table (see that migration's
  // own header). The assertions below cover the new contract directly.
  const source = fs.readFileSync(path.join(__dirname, '..', 'router.js'), 'utf8');
  const start = source.indexOf("router.get('/api/archive-search/search'");
  const end = source.indexOf("router.get('/api/archive-search/message/:id'");
  assert.ok(start !== -1 && end !== -1 && end > start, 'expected to find both route boundaries');
  const body = source.slice(start, end);
  assert.ok(body.includes("let searchTable = 'missive_message_intake_search_safe'"), 'expected the search route to default searchTable to the safe view');
  assert.ok(body.includes('ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED'), 'expected the corpus cutover to be gated behind the ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED flag');
  assert.ok(body.includes("searchTable = 'archive_search_corpus'"), 'expected the route to be able to move to archive_search_corpus once enabled and healthy');
  assert.ok(body.includes('kill_switch_active'), 'expected the route to consult the reconciliation kill-switch before trusting archive_search_corpus');
  assert.ok(body.includes('.from(searchTable)'), 'expected the actual query to run against the resolved searchTable variable, not two separately-written queries');
  assert.ok(body.includes("type: 'websearch'"), "expected websearch_to_tsquery via textSearch's websearch type");
  assert.ok(body.includes(".order('delivered_at', { ascending: false })"), 'expected newest-first ordering, not relevance-ranked');
  assert.ok(body.includes("if (!q)") && body.includes('status(400)'), 'expected an empty/missing q to be rejected with a 400');
});

test('router.js — with ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED unset (the real default), the search route source contains no unconditional path to archive_search_corpus — searchTable only ever reassigns inside the flag\'s own if-block', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'router.js'), 'utf8');
  const start = source.indexOf("router.get('/api/archive-search/search'");
  const end = source.indexOf("router.get('/api/archive-search/message/:id'");
  const body = source.slice(start, end);
  const flagBlockStart = body.indexOf('if (ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED)');
  const reassignIdx = body.indexOf("searchTable = 'archive_search_corpus'");
  assert.ok(flagBlockStart !== -1, 'expected an if (ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED) guard');
  assert.ok(reassignIdx !== -1 && reassignIdx > flagBlockStart, 'expected the archive_search_corpus reassignment to appear textually after (i.e. nested inside) the flag guard, so the flag defaulting to false is what keeps the original view as the only real query target today');
});

test('router.js — the message route queries missive_message_intake_search_safe only and 404s (never 500s) on a missing or malformed id', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'router.js'), 'utf8');
  const start = source.indexOf("router.get('/api/archive-search/message/:id'");
  const end = source.indexOf("router.get('/api/archive-search/screening-status'", start);
  assert.ok(start !== -1 && end !== -1 && end > start, 'expected to find the message route and the following screening-status route boundary');
  const body = source.slice(start, end);
  assert.ok(body.includes(".from('missive_message_intake_search_safe')"), 'expected the message route to query the safe view, never the raw table');
  assert.ok(body.includes("status(404)"), 'expected a 404 for a message not found in the safe view');
  assert.ok(body.includes("'22P02'"), 'expected malformed-UUID Postgres errors to be treated as 404, not a 500');
});

test('router.js — both search routes log the correct audit events with actor_type hardcoded human, per the technical spec\'s audit-events table', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'router.js'), 'utf8');
  const start = source.indexOf("router.get('/api/archive-search/search'");
  const end = source.indexOf("router.get('/api/archive-search/screening-status'", start);
  assert.ok(start !== -1 && end !== -1 && end > start, 'expected to find both search routes and the following screening-status route boundary');
  const body = source.slice(start, end);
  assert.ok(body.includes('archive_search.query_performed'), 'expected the query_performed action name');
  assert.ok(body.includes('query_text: q'), 'expected the literal query text logged, per the spec\'s own deliberate "who searched what" reasoning');
  assert.ok(body.includes('archive_search.message_opened'), 'expected the message_opened action name');
  assert.strictEqual((body.match(/actor_type:\s*'human'/g) || []).length, 2, 'expected both audit writes to hardcode actor_type human');
});

function routerSourceLine(source, marker) {
  const idx = source.indexOf(marker);
  assert.ok(idx !== -1, `expected to find "${marker}" in router.js`);
  const lineStart = source.lastIndexOf('\n', idx) + 1;
  const lineEnd = source.indexOf('\n', idx);
  return source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
}

// ============================================================
// PART 13 — lib/significance-pass.js (archive-search-significance-
// technical-spec.md v2) — the merged Call 1 / Call 2 significance +
// complaint-triage pass, and its retirement of complaint-tracking's own
// AI-driving pipeline. Same restraint as every other PART in this file:
// no DB-touching function is invoked (significancePass.runSignificance
// PassBatch, fetchNextEligibleConversations, processConversation all
// touch Supabase/Anthropic) — only pure functions are tested directly.
// ============================================================
const significancePass = require('../lib/significance-pass');
// significanceBatch (PART 18, the Batches API build) is required HERE,
// immediately after significancePass, rather than down at PART 18 itself —
// load-order matters and was the actual root cause of a real bug found
// while building PART 18 (see that PART's own header comment for the full
// story): lib/significance-batch.js's top-level `require('./significance-
// pass')` resolves to WHATEVER is currently in require.cache for that path
// the moment significance-batch.js itself first loads. Requiring it this
// early guarantees that happens before ANY later PART's tests (15-17) have
// had a chance to temporarily swap that same cache entry for their own
// fake — so significance-batch.js's internal significancePass reference is
// guaranteed to be this exact `significancePass` object, permanently,
// which is what makes PART 18's spyOn()-based tests (patching methods on
// this very object) actually take effect.
const significanceBatch = require('../lib/significance-batch');
// Severity-tier build (2026-10-02) — severityRubric has no cross-module
// load-order concern (it requires nothing from this codebase, only the lazy
// Anthropic SDK inside anthropicClient()); severityBatch requires
// significanceBatch (above) for its pure utilities only (sizeOfRequestBytes/
// partitionIntoChunks/mapWithConcurrency/drainInGroups), never
// significancePass, so none of PART 18's own load-order gotcha applies here.
const severityRubric = require('../lib/severity-rubric');
const severityBatch = require('../lib/severity-batch');
// Retroactive name-match backfill build (2026-10-02) — required here, same
// load-order discipline as severityBatch immediately above: this module
// requires BOTH ../lib/significance-pass (findNameMatchCandidates,
// resolveUniqueMatch, buildConversationContext, fetchPropertyDirectory,
// IDENTIFICATION_BLOCK_WITH_NAME) and ../lib/significance-batch (the pure
// Batches-API utilities), so requiring it only after both of those are
// already in require.cache (lines above) guarantees its internal
// references resolve to the SAME already-loaded significancePass/
// significanceBatch objects this suite's own later PARTs (15-23) may
// temporarily swap fakes onto — the exact load-order gotcha PART 18's own
// header comment, above, already tells the full story of.
const nameMatchBackfill = require('../lib/name-match-backfill');
const { computeSilenceContext } = require('../../complaint-tracking/lib/process-pending-messages');
// lib/notify.js — required here, the same whole-module way significance-
// batch.js itself now requires it (see that file's own comment on its
// `const notify = require(...)` line for why), so spyOn(notify, 'sendMail',
// ...) below mutates the SAME already-loaded module object significance-
// batch.js's own notify.sendMail(...) call site reads from at call time.
// Node's require cache is keyed by resolved absolute path, so this
// resolves to the identical module instance regardless of the different
// relative path each file uses to get there.
const notify = require('../../lib/notify');

// ─── Driver query correctness (dedupeNewPairs — the pure core of
// fetchNextEligibleConversations; the DB round-trips around it cannot be
// exercised without a real Supabase connection, per this file's own
// header restraint) ─────────────────────────────────────────────────────
test('significance-pass — dedupeNewPairs collapses multiple message rows belonging to the SAME conversation into one pair, preserving first-seen order', () => {
  const page = [
    { mailbox_key: 'mb1', missive_conversation_id: 'convA' },
    { mailbox_key: 'mb1', missive_conversation_id: 'convB' },
    { mailbox_key: 'mb1', missive_conversation_id: 'convA' }, // a second message row for the same conversation
  ];
  const result = significancePass.dedupeNewPairs(page, new Set());
  assert.deepStrictEqual(result, [
    { mailbox_key: 'mb1', missive_conversation_id: 'convA' },
    { mailbox_key: 'mb1', missive_conversation_id: 'convB' },
  ]);
});

test('significance-pass — dedupeNewPairs excludes pairs already accumulated in an earlier page within the same run', () => {
  const alreadySeen = new Set(['mb1::convA']);
  const page = [
    { mailbox_key: 'mb1', missive_conversation_id: 'convA' },
    { mailbox_key: 'mb1', missive_conversation_id: 'convC' },
  ];
  const result = significancePass.dedupeNewPairs(page, alreadySeen);
  assert.deepStrictEqual(result, [{ mailbox_key: 'mb1', missive_conversation_id: 'convC' }]);
});

test('significance-pass — dedupeNewPairs treats the SAME conversation_id in a DIFFERENT mailbox as a distinct pair (conversation ids are only unique within a mailbox)', () => {
  const page = [
    { mailbox_key: 'mb1', missive_conversation_id: 'conv1' },
    { mailbox_key: 'mb2', missive_conversation_id: 'conv1' },
  ];
  const result = significancePass.dedupeNewPairs(page, new Set());
  assert.strictEqual(result.length, 2, 'expected both mailboxes\' conv1 to survive as distinct pairs');
});

test('significance-pass — dedupeNewPairs returns [] for an empty page', () => {
  assert.deepStrictEqual(significancePass.dedupeNewPairs([], new Set()), []);
});

// ─── Complaints-creation trigger — the migration's own exact condition,
// all four OR branches plus the negative case (Section 4/7 of the spec;
// "COMPLAINTS-CREATION LOGIC" in the migration file). ────────────────────
test('significance-pass — shouldCreateComplaint: branch 1, a real escalation_signal alone is sufficient', () => {
  assert.strictEqual(significancePass.shouldCreateComplaint({
    escalation_signal: 'blocked_resolution', needs_human_call: false, owner_instruction_rejected: null, category: 'dispute',
  }), true);
});

test('significance-pass — shouldCreateComplaint: branch 2, needs_human_call alone is sufficient', () => {
  assert.strictEqual(significancePass.shouldCreateComplaint({
    escalation_signal: 'none', needs_human_call: true, owner_instruction_rejected: null, category: 'maintenance_standard',
  }), true);
});

test('significance-pass — shouldCreateComplaint: branch 3, owner_instruction_rejected IS DISTINCT FROM NULL — "false" and "uncertain" both count, not just "true"', () => {
  for (const value of [true, false, 'uncertain']) {
    assert.strictEqual(significancePass.shouldCreateComplaint({
      escalation_signal: 'none', needs_human_call: false, owner_instruction_rejected: value, category: 'owner_instruction',
    }), true, `expected owner_instruction_rejected=${JSON.stringify(value)} alone to trigger complaint creation`);
  }
});

test('significance-pass — shouldCreateComplaint: branch 4, category IN (legal_exposure, owner_instruction) alone is sufficient, with no escalation signal or uncertainty at all', () => {
  assert.strictEqual(significancePass.shouldCreateComplaint({
    escalation_signal: 'none', needs_human_call: false, owner_instruction_rejected: null, category: 'legal_exposure',
  }), true);
  assert.strictEqual(significancePass.shouldCreateComplaint({
    escalation_signal: 'none', needs_human_call: false, owner_instruction_rejected: null, category: 'owner_instruction',
  }), true);
});

test('significance-pass — shouldCreateComplaint: branch 5 (added 2026-10-02, Mason governance review gap #1), category=accommodation_related alone is sufficient, with no escalation signal, needs_human_call, or owner_instruction_rejected answer at all — "nothing downstream can protect a row that never gets created"', () => {
  assert.strictEqual(significancePass.shouldCreateComplaint({
    escalation_signal: 'none', needs_human_call: false, owner_instruction_rejected: null, category: 'accommodation_related',
  }), true);
});

test('significance-pass — shouldCreateComplaint: the negative case — none of the five conditions true means NO complaint row', () => {
  assert.strictEqual(significancePass.shouldCreateComplaint({
    escalation_signal: 'none', needs_human_call: false, owner_instruction_rejected: null, category: 'dispute',
  }), false);
});

// ─── Fail-closed posture, per field type (spec Section 5) ────────────────
// PROTECTED-CLASS SELF-CHECK REMOVED 2026-09-17 (Peter's decision, Mason
// confirmed non-blocking — compliance/archive-search-significance-
// complaint-merge-mason-review.md, Finding 3 follow-up): Call 1 no longer
// asks the model to self-report protected_class_flag/protected_class_
// category, and parseCall1Response() no longer parses, defaults, or
// returns either field. The old test just above this comment (now
// removed) proved the OLD fail-closed-to-TRUE-on-malformed-input
// behavior — that behavior and the field it protected are both gone. The
// two tests below replace it: proving the field is gone from the parsed
// output at all (not silently defaulted to true, which would flood the
// audit log and field with a false positive on every single conversation
// — the exact regression Mason's review named as the one real
// implementation catch to get right).
test('significance-pass — parseCall1Response: protected_class_flag/protected_class_category are gone from the parsed output entirely — a response missing the field (as every real one now will be, since Call 1 no longer asks) does NOT flood the row with a fail-closed-to-TRUE default', () => {
  const raw = JSON.stringify({ resolution_status: 'open', category: 'dispute', why: 'a dispute', tone_trend: 'stable' });
  const parsed = significancePass.parseCall1Response(raw, { addressMatched: true });
  assert.notStrictEqual(parsed, null, 'expected a normal, complete response (minus the removed field) to still parse');
  assert.strictEqual('protected_class_flag' in parsed, false, 'expected protected_class_flag to be entirely absent from the parsed result, not defaulted to true or false');
  assert.strictEqual('protected_class_category' in parsed, false, 'expected protected_class_category to be entirely absent from the parsed result');
});

test('significance-pass — parseCall1Response: a model response that still includes protected_class_flag anyway (old prompt cached client-side, a stray/stale caller, etc.) is simply ignored — not read, not echoed back, not treated as a parse error', () => {
  const raw = JSON.stringify({
    resolution_status: 'open', category: 'dispute', why: 'a dispute', tone_trend: 'stable',
    protected_class_flag: true, protected_class_category: 'race_color', // a model that answers a question no longer asked
  });
  const parsed = significancePass.parseCall1Response(raw, { addressMatched: true });
  assert.notStrictEqual(parsed, null, 'expected this to still parse — an extra, unrequested field must never fail the whole call');
  assert.strictEqual('protected_class_flag' in parsed, false, 'expected the stray field to be dropped, not passed through');
});

test('significance-pass — parseCall1Response: the pure browsing fields (category) fail the WHOLE parse (triggers a Call 1 retry) rather than defaulting silently', () => {
  const raw = JSON.stringify({ resolution_status: 'open', category: 'not_a_real_category', why: 'x' });
  assert.strictEqual(significancePass.parseCall1Response(raw, { addressMatched: true }), null);
});

test('significance-pass — parseCall1Response: totally malformed JSON returns null (retry), never throws', () => {
  assert.strictEqual(significancePass.parseCall1Response('not json at all', { addressMatched: true }), null);
});

test('significance-pass — parseCall1Response: the identification block is only read when addressMatched is false (Prompt B), even if the model includes one anyway', () => {
  const raw = JSON.stringify({
    resolution_status: 'open', category: 'other', why: 'x',
    identification: { property_text: 'Sunset Apartments', vendor_text: null },
  });
  const parsed = significancePass.parseCall1Response(raw, { addressMatched: true });
  assert.deepStrictEqual(parsed.identification, { property_text: null, vendor_text: null }, 'expected identification to be ignored on the address-matched (Prompt A) branch');
});

// ─── PROTECTED-CLASS SELF-CHECK REMOVAL — the prompt itself, not just the
// parser (2026-09-17, Peter's decision, Mason confirmed non-blocking) ────
test('significance-pass — buildCall1Prompt: the PROTECTED-CLASS SELF-CHECK question is gone from the actual prompt text sent to the model, not just from the parser', () => {
  const prompt = significancePass.buildCall1Prompt({ threadText: '(thread text)', addressMatched: true });
  assert.strictEqual(prompt.includes('PROTECTED-CLASS SELF-CHECK'), false, 'expected the self-check question to be fully removed from the prompt');
  assert.strictEqual(prompt.includes('protected_class_flag'), false, 'expected the prompt to no longer ask for protected_class_flag in its JSON response schema');
  assert.strictEqual(prompt.includes('protected_class_category'), false, 'expected the prompt to no longer ask for protected_class_category in its JSON response schema');
});

test('significance-pass — buildCall1Prompt: item 4 (TONE) is still present, verbatim — only the self-check question that used to be bundled with it in the same block was removed, not the tone question', () => {
  const prompt = significancePass.buildCall1Prompt({ threadText: '(thread text)', addressMatched: true });
  assert.ok(prompt.includes('4. TONE — read the messages in order'), 'expected the TONE question to survive, unchanged, as item 4');
  assert.ok(prompt.includes('tone_trend'), 'expected tone_trend to still be requested in the JSON response schema');
});

test('significance-pass — buildCall1Prompt: the numbered list stays sequential after removing item 5 — IDENTIFICATION (Prompt B) renumbers from 6 to 5 rather than leaving a gap', () => {
  const promptNoAddress = significancePass.buildCall1Prompt({ threadText: '(thread text)', addressMatched: false });
  assert.ok(promptNoAddress.includes('5. IDENTIFICATION'), 'expected IDENTIFICATION to be renumbered to item 5 now that the old item 5 (protected-class self-check) is gone');
  assert.strictEqual(promptNoAddress.includes('6. IDENTIFICATION'), false, 'expected no leftover "6." numbering');
});

// ─── The other half of the fix Mason required: not just removing the
// prompt question, but making sure the significance row Call 1 builds
// actually stops reading a field that no longer exists on call1 (source-
// scanned, the same technique PART 14's own tests already use for
// significance-pass.js, since processConversation() itself can only be
// exercised end-to-end with a real Anthropic call, which this suite never
// makes) ────────────────────────────────────────────────────────────────
test('significance-pass — processConversation() hardcodes protected_class_flag: false / protected_class_category: null on the significance row, and never reads call1.protected_class_flag or call1.protected_class_category (real code, not just the parser/prompt)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'significance-pass.js'), 'utf8');
  assert.strictEqual(source.includes('call1.protected_class_flag'), false, 'expected no remaining read of call1.protected_class_flag anywhere in the file');
  assert.strictEqual(source.includes('call1.protected_class_category'), false, 'expected no remaining read of call1.protected_class_category anywhere in the file');
  assert.ok(source.includes('protected_class_flag: false,') && source.includes('protected_class_category: null,'), 'expected the significance row to hardcode both fields instead');
});

test('significance-pass — the checkClaim() call site no longer passes modelFlag/modelCategory sourced from Call 1 — content-check.js itself is untouched (confirmed by git status separately); this only checks the one call site that used to feed it', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'significance-pass.js'), 'utf8');
  assert.strictEqual(source.includes('modelFlag: call1'), false, 'expected no remaining modelFlag: call1.* argument to checkClaim()');
  assert.strictEqual(source.includes('modelCategory: call1'), false, 'expected no remaining modelCategory: call1.* argument to checkClaim()');
});

test('significance-pass — parseCall2Response: needs_human_call fails closed to TRUE (not false) on a missing/invalid value — a higher-stakes field defaults toward asking a human, never toward silence', () => {
  const raw = JSON.stringify({ escalation_signal: 'none' });
  const parsed = significancePass.parseCall2Response(raw, { category: 'dispute' });
  assert.notStrictEqual(parsed, null);
  assert.strictEqual(parsed.needs_human_call, true);
});

test('significance-pass — parseCall2Response: escalation_signal=blocked_resolution WITHOUT a valid blocked_reason fails the whole parse (matches complaints_blocked_requires_reason — never a row the DB would reject outright)', () => {
  const raw = JSON.stringify({ escalation_signal: 'blocked_resolution', blocked_party: 'owner', needs_human_call: false });
  assert.strictEqual(significancePass.parseCall2Response(raw, { category: 'dispute' }), null);
});

test('significance-pass — parseCall2Response: category=owner_instruction WITHOUT a valid owner_instruction_rejected value fails the whole parse (this field is required whenever Call 2 is asked about it)', () => {
  const raw = JSON.stringify({ escalation_signal: 'none', needs_human_call: false });
  assert.strictEqual(significancePass.parseCall2Response(raw, { category: 'owner_instruction' }), null);
});

test('significance-pass — parseCall2Response: a fully valid response, including the tri-state "uncertain" owner_instruction_rejected value, parses correctly', () => {
  const raw = JSON.stringify({
    escalation_signal: 'none', needs_human_call: true,
    owner_instruction_rejected: 'uncertain', owner_instruction_summary: 'Owner said not to rent to families with kids at Building A.',
  });
  const parsed = significancePass.parseCall2Response(raw, { category: 'owner_instruction' });
  assert.strictEqual(parsed.owner_instruction_rejected, 'uncertain');
  assert.strictEqual(parsed.owner_instruction_summary, 'Owner said not to rent to families with kids at Building A.');
});

// ─── 2026-09-17 (Peter's decision, Mason CLEARED — compliance/archive-
// search-significance-complaint-merge-mason-review.md, "Follow-up to
// Finding 2"): the note-drafting logic (buildOwnerInstructionNoteText —
// a fixed-template live-mail "Rincon's standard refusal" response, and
// an AI-drafted historical "AI-assessed in <year>..." assessment) is
// gone. owner_instruction_note_text now holds nothing but the model's
// own factual owner_instruction_summary, via the new, pure, exported
// resolveOwnerInstructionNoteText(). These tests replace the old
// coverage of the deleted template strings with coverage of the new
// passthrough, and prove none of the old drafted language can appear in
// what gets stored. ─────────────────────────────────────────────────────
test('significance-pass — buildOwnerInstructionNoteText no longer exists — the drafting function itself was deleted, not just its call site', () => {
  assert.strictEqual(significancePass.buildOwnerInstructionNoteText, undefined);
});

test('significance-pass — resolveOwnerInstructionNoteText: a bare passthrough of the factual summary for category=owner_instruction — no prefix, no suffix, no template wording added', () => {
  const summary = 'Owner instructed Rincon to decline applicants with children at Building A.';
  const result = significancePass.resolveOwnerInstructionNoteText({ category: 'owner_instruction', owner_instruction_summary: summary });
  assert.strictEqual(result, summary, 'expected the exact factual summary, unmodified — not wrapped in any drafted response or assessment text');
});

test('significance-pass — resolveOwnerInstructionNoteText: identical behavior for a historical-mail-shaped summary — no discoveryContext parameter at all, proving live and historical are now treated symmetrically', () => {
  const summary = 'A 2022 email in which the owner said not to rent to families with children.';
  // Deliberately no discoveryContext passed at all — the function signature
  // doesn't take one anymore. Same call shape works for both live and
  // historical inputs, which is itself the fix for the old live-only gap.
  const result = significancePass.resolveOwnerInstructionNoteText({ category: 'owner_instruction', owner_instruction_summary: summary });
  assert.strictEqual(result, summary);
});

test('significance-pass — resolveOwnerInstructionNoteText: null for any category other than owner_instruction, even if a summary string is (implausibly) present', () => {
  assert.strictEqual(significancePass.resolveOwnerInstructionNoteText({ category: 'dispute', owner_instruction_summary: 'should never be stored' }), null);
  assert.strictEqual(significancePass.resolveOwnerInstructionNoteText({ category: 'legal_exposure', owner_instruction_summary: 'should never be stored' }), null);
});

test('significance-pass — resolveOwnerInstructionNoteText: null (not a placeholder string) when category=owner_instruction but the model returned no summary', () => {
  assert.strictEqual(significancePass.resolveOwnerInstructionNoteText({ category: 'owner_instruction', owner_instruction_summary: null }), null);
  assert.strictEqual(significancePass.resolveOwnerInstructionNoteText({ category: 'owner_instruction', owner_instruction_summary: undefined }), null);
});

test('significance-pass — resolveOwnerInstructionNoteText: none of the old drafted-response/assessment language can appear in stored output — it is a pure passthrough, never generated text', () => {
  const summary = 'Owner asked Rincon to only accept tenants over age 40.';
  const result = significancePass.resolveOwnerInstructionNoteText({ category: 'owner_instruction', owner_instruction_summary: summary });
  for (const bannedPhrase of ['Rincon cannot comply', 'standard, non-discriminatory procedure', 'AI-assessed in', 'Automated historical assessment', 'not human verified', 'would require Rincon']) {
    assert.strictEqual(result.includes(bannedPhrase), false, `expected no trace of old drafted/assessment language ("${bannedPhrase}") in stored owner_instruction_note_text`);
  }
});

test('significance-pass — buildCall2Prompt: historical mail now asks the model for owner_instruction_summary too (previously live-only) — Mason\'s recommended addition', () => {
  const historicalPrompt = significancePass.buildCall2Prompt({
    category: 'owner_instruction', resolution_status: 'unknown', why: 'An owner gave a standing instruction.',
    threadText: '(thread text)', discoveryContext: 'historical_backfill', silenceContext: null,
  });
  assert.ok(historicalPrompt.includes('owner_instruction_summary'), 'expected the historical-mail prompt to ask for owner_instruction_summary, same as live mail');
  assert.ok(/FACTUAL\s+statement of the instruction itself/.test(historicalPrompt), 'expected the same factual-only framing used for live mail');
});

test('significance-pass — buildCall2Prompt: neither live nor historical owner_instruction prompt still references the deleted fixed-template mechanism', () => {
  const liveP = significancePass.buildCall2Prompt({
    category: 'owner_instruction', resolution_status: 'unknown', why: 'An owner gave a standing instruction.',
    threadText: '(thread text)', discoveryContext: 'live_pipeline', silenceContext: null,
  });
  const historicalP = significancePass.buildCall2Prompt({
    category: 'owner_instruction', resolution_status: 'unknown', why: 'An owner gave a standing instruction.',
    threadText: '(thread text)', discoveryContext: 'historical_backfill', silenceContext: null,
  });
  for (const prompt of [liveP, historicalP]) {
    assert.strictEqual(prompt.includes('generated separately from a fixed template'), false, 'expected no reference to the deleted template mechanism');
    assert.strictEqual(prompt.includes('Rincon\'s response is generated'), false, 'expected no reference to Rincon drafting/generating a response at all — that step no longer exists');
  }
});

// ─── The historical silence-context fix (Bug #1) — the EXACT adversarial-
// review scenario: a thread that is perfectly resolved, whose last
// message happens to come from Rincon staff, a long time ago. Pointed at
// this unmodified, complaint-tracking's own computeSilenceContext() would
// read this as "unanswered for 1,046 days" and hand the model every
// reason to call it blocked_resolution. Confirms the fix at the exact
// point that matters: the text Call 2's own prompt actually contains. ────
test('significance-pass — historical silence-context fix: the exact old-but-resolved-off-channel thread no longer surfaces a raw day-count or "blocked" framing for historical mail', () => {
  const longAgo = new Date(Date.now() - 1046 * 86400000).toISOString(); // the adversarial review's own real example
  const thread = {
    messages: [
      { from: 'tenant@example.com', date: new Date(Date.parse(longAgo) - 5 * 86400000).toISOString() },
      { from: 'staff@rinconmanagement.com', date: longAgo }, // Rincon staff sent the last message — the fix got confirmed by phone, not email, a totally normal pattern
    ],
  };
  const silenceContext = computeSilenceContext(thread, 2);
  assert.ok(silenceContext.daysSinceLastMessage > 1000, 'sanity check: this really is the ~1,046-day scenario the adversarial review named');
  assert.strictEqual(silenceContext.lastMessageFromStaff, true);

  const historicalPrompt = significancePass.buildCall2Prompt({
    category: 'dispute', resolution_status: 'resolved', why: 'A maintenance dispute that appears resolved.',
    threadText: '(thread text)', discoveryContext: 'historical_backfill', silenceContext,
  });
  assert.strictEqual(historicalPrompt.includes(String(Math.round(silenceContext.daysSinceLastMessage))), false,
    'expected NO raw day-count figure in the historical prompt — the exact bug: a live day-count reads as an active, ongoing silence');
  assert.ok(historicalPrompt.includes('do not infer blocked_resolution from\nsilence alone on a historical thread'),
    'expected the spec\'s own historicalFraming caution to be present verbatim');

  const livePrompt = significancePass.buildCall2Prompt({
    category: 'dispute', resolution_status: 'resolved', why: 'A maintenance dispute that appears resolved.',
    threadText: '(thread text)', discoveryContext: 'live_pipeline', silenceContext,
  });
  assert.ok(livePrompt.includes('FROM Rincon staff'), 'expected LIVE mail to keep the real, unmodified silence-context wording — this fix must not touch live mail at all');
  assert.ok(livePrompt.includes('day(s) ago'), 'expected the real day count to still surface for live mail');
});

// ─── Retirement — the shared taxonomy, and complaint-tracking's own
// pipeline actually stopping (spec Section 8). ────────────────────────────
test('significance-pass — TOPIC_CATEGORIES is the new shared 8-value taxonomy, not complaint-tracking\'s old retired 6-value enum', () => {
  assert.deepStrictEqual(significancePass.TOPIC_CATEGORIES, [
    'routine_logistics', 'maintenance_standard', 'dispute', 'safety_issue',
    'legal_exposure', 'accommodation_related', 'owner_instruction', 'other',
  ]);
  for (const retiredValue of ['legal_compliance', 'owner_instruction_one_off', 'escalation_recurrence', 'churn_risk', 'major_money_property_risk']) {
    assert.strictEqual(significancePass.TOPIC_CATEGORIES.includes(retiredValue), false, `expected the old category "${retiredValue}" to be gone from the shared taxonomy (some of these are now escalation_signal values instead)`);
  }
});

test('categorize-complaint.js no longer exists on disk — confirmed deleted, not just unreferenced (spec Section 8: "delete... if nothing else calls it")', () => {
  const p = path.join(__dirname, '..', '..', 'complaint-tracking', 'lib', 'categorize-complaint.js');
  assert.strictEqual(fs.existsSync(p), false);
});

test('process-pending-messages.js: runProcessPendingMessages is gone; computeSilenceContext and lookupSingleDirectorOfOperations survive (both have real, live callers outside the retired pipeline)', () => {
  const ppm = require('../../complaint-tracking/lib/process-pending-messages');
  assert.strictEqual(typeof ppm.runProcessPendingMessages, 'undefined');
  assert.strictEqual(typeof ppm.computeSilenceContext, 'function');
  assert.strictEqual(typeof ppm.lookupSingleDirectorOfOperations, 'function');
});

test('process-pending-messages.js has zero side effects at require() time — no Supabase client construction, no env-var check, even with SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY unset (it used to construct a module-level client unconditionally)', () => {
  // Spawn a fresh child process so this can actually unset the env vars
  // without disturbing the rest of this suite's own fake values.
  const { spawnSync } = require('child_process');
  const result = spawnSync(process.execPath, ['-e', "require('./lib/process-pending-messages'); console.log('OK');"], {
    cwd: path.join(__dirname, '..', '..', 'complaint-tracking'),
    env: { PATH: process.env.PATH }, // deliberately no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
  });
  assert.strictEqual(result.status, 0, `expected require() alone to succeed with no env vars set; stderr: ${result.stderr && result.stderr.toString()}`);
  assert.ok(result.stdout.toString().includes('OK'));
});

test('complaint-tracking/router.js: POST /api/complaint-tracking/process-pending is dead-ended (410), not silently removed or still driving the old pipeline', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'complaint-tracking', 'router.js'), 'utf8');
  const start = source.indexOf("internalRouter.post('/api/complaint-tracking/process-pending'");
  const end = source.indexOf("POST /api/complaint-tracking/check-aging");
  assert.ok(start !== -1 && end !== -1 && end > start, 'expected to find the retired route and the following check-aging route boundary');
  const body = source.slice(start, end);
  assert.ok(body.includes('status(410)'), 'expected a 410 Gone response');
  assert.strictEqual(body.includes('runProcessPendingMessages'), false, 'expected the old pipeline call to be fully gone, not just unreachable dead code');
});

test('complaint-tracking/router.js: home-count and check-aging both hard-gate on discovery_context = \'live_pipeline\' (spec Section 6 — a historical backfill row must never inflate the live tile or trip the aging job)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'complaint-tracking', 'router.js'), 'utf8');
  const homeCountLine = routerSourceLine(source, "router.get('/api/complaint-tracking/home-count'");
  const homeCountStart = source.indexOf("router.get('/api/complaint-tracking/home-count'");
  const homeCountBody = source.slice(homeCountStart, source.indexOf('});', homeCountStart));
  assert.ok(homeCountBody.includes("eq('discovery_context', 'live_pipeline')"), 'expected home-count to filter to live_pipeline');

  const agingStart = source.indexOf("internalRouter.post('/api/complaint-tracking/check-aging'");
  const agingBody = source.slice(agingStart, source.indexOf("res.json({ ok: true, checked", agingStart));
  assert.ok(agingBody.includes("eq('discovery_context', 'live_pipeline')"), 'expected check-aging\'s candidate query to filter to live_pipeline');
  void homeCountLine;
});

test('complaint-tracking/router.js requires successfully end-to-end after the retirement (proves the cross-tool TOPIC_CATEGORIES import actually resolves, not just in isolation)', () => {
  delete require.cache[require.resolve('../../complaint-tracking/router')];
  const complaintTrackingRouter = require('../../complaint-tracking/router');
  assert.ok(complaintTrackingRouter.router, 'expected complaint-tracking/router.js to export a router');
});

// ─── archive-search/router.js — the two new routes wired up correctly ────
test('router.js — POST /api/archive-search/process-significance-pending is x-cron-secret-gated and calls runSignificancePassBatch with discoveryContext live_pipeline', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'router.js'), 'utf8');
  const start = source.indexOf("internalRouter.post('/api/archive-search/process-significance-pending'");
  const end = source.indexOf("router.get('/api/archive-search/significance-pilot-export'", start);
  assert.ok(start !== -1 && end !== -1 && end > start, 'expected to find the new route and the following pilot-export route boundary');
  const body = source.slice(start, end);
  assert.ok(body.includes('checkCronSecret(req, res)'), 'expected the same x-cron-secret gate as every other internal route');
  assert.ok(body.includes("discoveryContext: 'live_pipeline'"), 'expected this route to run the LIVE branch only, never the historical backfill');
});

test('router.js — GET /api/archive-search/significance-pilot-export is admin-only and scoped to historical_backfill rows', () => {
  const line = routerSourceLine(fs.readFileSync(path.join(__dirname, '..', 'router.js'), 'utf8'), "router.get('/api/archive-search/significance-pilot-export'");
  assert.ok(line.includes('requireArchiveSearchAdmin'), 'expected admin-only gating, matching validation-sample-export/held-review-export');
});

// ============================================================
// PART 14 — real pilot bugs found live against sally, 2026-09-13 (Scotty's
// diagnosis; independently confirmed against the real database). All new
// tests below run against significancePass's own exported pure functions
// with hand-built fixtures ONLY — none of them touch a real Supabase
// project, and none of them read or write the 28 real rows the actual
// pilot run left stuck (that verification is TARS's job, against the real
// database, not this test suite's — this suite's whole point, restated
// from PART 13's own header above, is that it makes zero real network
// calls and touches no real Supabase project).
// ============================================================

// ─── Bug #1 — complaints.escalation_signal's CHECK constraint excludes
// 'none' as a legal value; missive_conversation_significance's own CHECK
// constraint (a five-value list, ESCALATION_SIGNALS) allows it. The real
// crash: createComplaintRow() copied call2Fields.escalation_signal into
// the complaints insert with no translation, so category IN
// (legal_exposure, owner_instruction) + escalation_signal 'none' (branch 4
// of shouldCreateComplaint, working exactly as designed) threw
// complaints_escalation_signal_check on every real conversation shaped
// that way. ────────────────────────────────────────────────────────────
test('significance-pass — complaintEscalationSignal: translates the literal string \'none\' to null — the exact value that crashed the real pilot against the complaints table\'s own CHECK constraint', () => {
  assert.strictEqual(significancePass.complaintEscalationSignal('none'), null);
});

test('significance-pass — complaintEscalationSignal: every real escalation value passes through completely unchanged (only \'none\' is special-cased)', () => {
  for (const value of ['blocked_resolution', 'churn_risk', 'escalation_recurrence', 'major_money_property_risk']) {
    assert.strictEqual(significancePass.complaintEscalationSignal(value), value);
  }
});

test('significance-pass — complaintEscalationSignal: null and undefined BOTH normalize to null (hardened, Judge review 2026-09-13) — the real call site never actually passes undefined, but the old code returned it unchanged if it ever did; this makes the null guarantee real instead of accidental', () => {
  assert.strictEqual(significancePass.complaintEscalationSignal(null), null);
  assert.strictEqual(significancePass.complaintEscalationSignal(undefined), null);
});

// The actual regression test the bug report asked for: build the EXACT
// real-world shape that crashed (category qualifies for a complaint on
// its own, per shouldCreateComplaint branch 4; escalation_signal is
// 'none') and confirm the value that would actually be written to
// complaints.escalation_signal is null, never the string 'none'.
test('significance-pass — the exact crashing combination: category IN (legal_exposure, owner_instruction) with escalation_signal \'none\' must still create a complaint (shouldCreateComplaint branch 4, unchanged), and the value written to complaints.escalation_signal must be null, never \'none\'', () => {
  for (const category of ['legal_exposure', 'owner_instruction']) {
    const call2Fields = { escalation_signal: 'none', needs_human_call: false, owner_instruction_rejected: null };
    assert.strictEqual(
      significancePass.shouldCreateComplaint({ ...call2Fields, category }), true,
      `expected category=${category} + escalation_signal='none' to still trigger complaint creation (Asimov-required, must not regress)`
    );
    assert.strictEqual(
      significancePass.complaintEscalationSignal(call2Fields.escalation_signal), null,
      `expected the value actually written to complaints.escalation_signal to be null for category=${category}, never the literal string 'none'`
    );
  }
});

// Request #3 from the bug report: don't just trust mocks — read the REAL
// CHECK constraint's own allowed-value list directly out of the real
// migration file, and confirm complaintEscalationSignal()'s output would
// satisfy it for every value ESCALATION_SIGNALS can ever produce. This is
// exactly the class of bug 132/132 mocked tests missed: nothing in the old
// suite ever looked at what the real database would actually accept.
test('significance-pass — schema-aware: complaintEscalationSignal()\'s output satisfies the REAL complaints.escalation_signal CHECK constraint, parsed directly out of the real migration file (not re-typed by hand, not assumed)', () => {
  const migrationPath = path.join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations', '20260913020000_archive_search_significance_complaint_merge_schema.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  // Find the complaints table's own escalation_signal column definition —
  // scoped to start searching after "CREATE TABLE IF NOT EXISTS complaints"
  // specifically, so this can never accidentally match missive_
  // conversation_significance's own escalation_signal CHECK instead (that
  // one legitimately allows 'none' — a different column, a different rule).
  const complaintsTableStart = sql.indexOf('CREATE TABLE IF NOT EXISTS complaints');
  assert.ok(complaintsTableStart !== -1, 'expected to find the complaints table definition in the real migration file');
  const columnMatch = sql.slice(complaintsTableStart).match(/escalation_signal\s+TEXT\s+CHECK \(escalation_signal IS NULL OR escalation_signal IN \(([\s\S]*?)\)\)/);
  assert.ok(columnMatch, 'expected to find and parse complaints.escalation_signal\'s own CHECK (...) clause in the real migration file — if this fails, the migration\'s wording changed and this test needs updating, not silencing');

  const allowedValues = columnMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  assert.ok(allowedValues.length > 0, 'expected at least one allowed value parsed out of the real CHECK constraint');

  // Sanity check on the parse itself, and the premise of the whole bug:
  // the real constraint really does exclude 'none'.
  assert.strictEqual(allowedValues.includes('none'), false, 'expected the REAL complaints.escalation_signal CHECK constraint to exclude \'none\' — if this ever changes, complaintEscalationSignal()\'s translation becomes unnecessary, not wrong, but this test\'s premise would need revisiting');

  // The actual assertion: every value the significance pass can ever
  // produce (ESCALATION_SIGNALS, five values including 'none'), once run
  // through complaintEscalationSignal(), is either null or a value the
  // REAL constraint, as parsed above, actually allows.
  for (const rawSignal of significancePass.ESCALATION_SIGNALS) {
    const written = significancePass.complaintEscalationSignal(rawSignal);
    assert.ok(
      written === null || allowedValues.includes(written),
      `expected complaintEscalationSignal(${JSON.stringify(rawSignal)}) === ${JSON.stringify(written)} to satisfy the real CHECK constraint (allowed: null or one of ${JSON.stringify(allowedValues)})`
    );
  }
});

// ─── Bug #2 — the driver query only ever selected conversations with NO
// row yet in missive_conversation_significance, so a conversation whose
// Call 1 succeeded but whose Call 2 (or the complaints insert right after
// it) then threw was left with a real row, call2_completed_at NULL, and
// nothing ever selected it again — permanently, silently stuck (28 real
// rows, confirmed live). needsCall2/rowNeedsCall2Retry are the fix's own
// decision logic, unit-tested directly since the DB round-trip around
// them (fetchIncompleteSignificanceRows) cannot be exercised without a
// live connection, matching this file's existing dedupeNewPairs
// convention. ───────────────────────────────────────────────────────────
test('significance-pass — needsCall2: the ONE combination that never gets a Call 2 at all is routine_logistics + resolved — every other combination needs one', () => {
  assert.strictEqual(significancePass.needsCall2({ category: 'routine_logistics', resolution_status: 'resolved' }), false);

  const otherCombinations = [
    { category: 'routine_logistics', resolution_status: 'open' },
    { category: 'routine_logistics', resolution_status: 'unknown' },
    { category: 'dispute', resolution_status: 'resolved' },
    { category: 'legal_exposure', resolution_status: 'resolved' },
    { category: 'safety_issue', resolution_status: 'open' },
  ];
  for (const combo of otherCombinations) {
    assert.strictEqual(significancePass.needsCall2(combo), true, `expected ${JSON.stringify(combo)} to need Call 2`);
  }
});

// The three real states a row can now be in, named exactly as the bug
// report itself named them.
test('significance-pass — rowNeedsCall2Retry: state (a)/(c) — a FULLY COMPLETE row (call2_completed_at set) is excluded, regardless of category/resolution_status, including a real escalation category', () => {
  assert.strictEqual(significancePass.rowNeedsCall2Retry({
    category: 'legal_exposure', resolution_status: 'open', call2_completed_at: '2026-09-13T10:00:00.000Z',
  }), false, 'expected a completed row to never be re-selected, even though its category alone would otherwise need a Call 2');
});

test('significance-pass — rowNeedsCall2Retry: state (b) — a STUCK row (call2_completed_at NULL, Call 2 was genuinely required) IS included — this is the exact shape of the 28 real rows the pilot left behind', () => {
  assert.strictEqual(significancePass.rowNeedsCall2Retry({
    category: 'dispute', resolution_status: 'open', call2_completed_at: null,
  }), true);
  assert.strictEqual(significancePass.rowNeedsCall2Retry({
    category: 'legal_exposure', resolution_status: 'resolved', call2_completed_at: null,
  }), true, 'expected a legal_exposure row to need a Call 2 retry even if resolution_status is resolved — only routine_logistics+resolved is exempt');
});

test('significance-pass — rowNeedsCall2Retry: state (c) — routine_logistics + resolved with call2_completed_at NULL is EXCLUDED — this is the by-design case (Call 2 was never going to run for this row), not a stuck one; the bug this guards against is treating every permanent, intentional NULL as if it were stuck and re-processing it forever', () => {
  assert.strictEqual(significancePass.rowNeedsCall2Retry({
    category: 'routine_logistics', resolution_status: 'resolved', call2_completed_at: null,
  }), false);
});

test('significance-pass — rowNeedsCall2Retry: null and a real timestamp are both treated as "already has a completion time" the same way — only a genuinely absent value (null/undefined) can ever mean "retry"', () => {
  assert.strictEqual(significancePass.rowNeedsCall2Retry({ category: 'dispute', resolution_status: 'open', call2_completed_at: undefined }), true);
  assert.strictEqual(significancePass.rowNeedsCall2Retry({ category: 'dispute', resolution_status: 'open', call2_completed_at: '2026-01-01T00:00:00.000Z' }), false);
});

// fetchIncompleteSignificanceRows itself is a DB-touching function (same
// restraint as fetchNextEligibleConversations — never invoked directly in
// this suite) — confirm by reading its own source that it actually wires
// the fix in: queries the right table, filters call2_completed_at IS NULL,
// and applies the rowNeedsCall2Retry decision (not just the raw DB filter
// alone) before returning rows to the batch runner.
test('significance-pass — fetchIncompleteSignificanceRows queries missive_conversation_significance, filters call2_completed_at IS NULL at the DB level, and re-applies rowNeedsCall2Retry in application code as the real source of truth', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'significance-pass.js'), 'utf8');
  const start = source.indexOf('async function fetchIncompleteSignificanceRows');
  assert.ok(start !== -1, 'expected fetchIncompleteSignificanceRows to exist');
  const end = source.indexOf('\n}', start);
  const body = source.slice(start, end);
  assert.ok(body.includes("from('missive_conversation_significance')"), 'expected this to query missive_conversation_significance, the table the real stuck rows live in');
  assert.ok(body.includes("is('call2_completed_at', null)"), 'expected a DB-level filter for call2_completed_at IS NULL');
  assert.ok(body.includes('rowNeedsCall2Retry'), 'expected the real decision function to be applied to the returned rows, not just the raw DB filter trusted alone');
});

// runSignificancePassBatch's own two-pass structure: existing-but-
// incomplete rows first (retried via Call 2 only), new conversations
// second (full Call 1 + Call 2) — confirms the fix is actually wired into
// the batch runner both scripts (the pilot, and the live-loop route) call,
// and that a retry never re-runs Call 1.
test('significance-pass — runSignificancePassBatch retries incomplete rows via retryCall2ForExistingRow (Call 2 only) BEFORE fetching brand-new conversations via processConversation (full Call 1 + Call 2) — a retry must never re-run Call 1', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'significance-pass.js'), 'utf8');
  const start = source.indexOf('async function runSignificancePassBatch');
  assert.ok(start !== -1, 'expected runSignificancePassBatch to exist');
  const end = source.indexOf('\nmodule.exports', start);
  const body = source.slice(start, end);

  const incompleteFetchIdx = body.indexOf('fetchIncompleteSignificanceRows(limit)');
  const retryCallIdx = body.indexOf('retryCall2ForExistingRow(row)');
  const newFetchIdx = body.indexOf('fetchNextEligibleConversations(remaining, sinceDate)'); // updated 2026-09-17: this call site now threads the staged-backfill sinceDate cutoff through as a second argument (PART 17) — same call, same ordering guarantee this test checks, just with the real, current argument list.
  const freshCallIdx = body.indexOf('processConversation(pair,');

  assert.ok(incompleteFetchIdx !== -1 && retryCallIdx !== -1 && newFetchIdx !== -1 && freshCallIdx !== -1,
    'expected all four calls (fetch incomplete, retry, fetch new, process fresh) to be present');
  // Fetch order: the incomplete backlog is fetched first BECAUSE the new-
  // conversation budget (`remaining`) is computed FROM its length — this
  // is a real data dependency, not an arbitrary ordering choice.
  assert.ok(incompleteFetchIdx < newFetchIdx, 'expected the incomplete-row backlog to be fetched before the new-conversation budget is computed from its size');
  // Processing order: the actual "clear the known backlog first" priority
  // the bug report asked for — every incomplete row is retried before any
  // brand-new conversation gets a fresh Call 1.
  assert.ok(retryCallIdx < freshCallIdx, 'expected every incomplete row to be retried (Call 2 only) BEFORE any brand-new conversation is given a fresh Call 1 — clearing the known backlog takes priority');

  // retryCall2ForExistingRow's own definition, separately, never calls
  // runCall1 — the real "don't waste Call 1" requirement, checked at the
  // function that actually matters, not just at the call site above. Slice
  // up to the next top-level function (runCall2Phase, defined right after
  // it) rather than trying to match its exact closing brace.
  const retryFnStart = source.indexOf('async function retryCall2ForExistingRow');
  assert.ok(retryFnStart !== -1, 'expected retryCall2ForExistingRow to exist');
  const retryFnBody = source.slice(retryFnStart, source.indexOf('\nasync function runCall2Phase', retryFnStart));
  assert.ok(!/runCall1\(/.test(retryFnBody), 'expected retryCall2ForExistingRow to never call runCall1 — re-deriving Call 1 data that already succeeded and is already stored would waste a real, billed AI call');
});

// ============================================================
// PART 15 — Judge's fix, 2026-09-13: createComplaintRow() is no longer
// called unguarded from inside runCall2Phase(). A pre-insert existence
// check (findExistingComplaintForConversation, internal to significance-
// pass.js) makes that whole branch idempotent under retry — reusing an
// already-existing complaints row for this conversation instead of
// inserting a second one.
//
// This is the one PART in this file that actually INVOKES a DB-touching
// function — every other PART deliberately avoids that (see PART 13's own
// header). It has to, here: the bug is about what happens ACROSS two
// separate DB calls when a real run is interrupted between them, which a
// pure-function or static-source check cannot prove. To do that with zero
// real network calls, this fakes the Supabase client significance-pass.js
// builds for itself at require() time, using the same require.cache
// technique PART 13 already relies on (line ~1203: deleting a cache entry
// to force a fresh require) — taken one step further: the @supabase/
// supabase-js cache entry is REPLACED first, so the forced-fresh require
// of significance-pass.js calls a fake createClient() instead of the real
// one. ANTHROPIC_API_KEY is deliberately deleted for the duration too
// (same technique PART 7 already uses for fair-housing-batch-self-
// report.js), which deterministically drives Call 2 into its own fail-
// closed needs_human_call:true placeholder path — the exact path Judge
// named as the most likely real-world trigger for this bug, since it
// never depends on re-reading anything. Net effect: no real call to
// Supabase or Anthropic happens anywhere below.
// ============================================================

// A minimal fake Supabase query-builder — supports exactly the chain
// methods the real code paths under test actually call (fetching
// conversation messages, the new existence check, an insert, an update),
// nothing more. Each .from(table) call gets its own fresh chain/state, so
// concurrent/sequential calls against different tables in the same test
// never cross-contaminate.
function makeFakeSupabaseClient({ conversationRows, existingComplaint }) {
  const calls = { complaintsInsert: [], complaintsSelect: 0, significanceUpdates: [], auditLogInserts: [] };

  function makeChain(table) {
    const state = { op: undefined, insertRow: null, updateFields: null };
    const chain = {
      select() { if (!state.op) state.op = 'select'; return chain; },
      eq() { return chain; },
      neq() { return chain; },
      gte() { return chain; },
      is() { return chain; },
      gt() { return chain; },
      in() { return chain; },
      or() { return chain; },
      order() { return chain; },
      limit() { return chain; },
      update(fields) { state.op = 'update'; state.updateFields = fields; return chain; },
      insert(row) { state.op = 'insert'; state.insertRow = row; return chain; },
      maybeSingle() {
        if (table === 'complaints' && state.op === 'select') {
          calls.complaintsSelect++;
          return Promise.resolve({ data: existingComplaint || null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      single() {
        if (table === 'complaints' && state.op === 'insert') {
          calls.complaintsInsert.push(state.insertRow);
          return Promise.resolve({ data: { ...state.insertRow, id: 'brand-new-complaint-id' }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      // Real supabase-js query objects are themselves PromiseLike — most
      // call sites in significance-pass.js `await` the chain directly
      // (no .single()/.maybeSingle()), so this has to resolve too.
      then(resolve, reject) {
        let result;
        if (table === 'missive_message_intake_search_safe' && state.op === 'select') {
          result = { data: conversationRows, error: null };
        } else if (table === 'missive_conversation_significance' && state.op === 'update') {
          calls.significanceUpdates.push(state.updateFields);
          result = { data: null, error: null };
        } else if (table === 'audit_log' && state.op === 'insert') {
          calls.auditLogInserts.push(state.insertRow);
          result = { data: null, error: null };
        } else if (table === 'complaints' && state.op === 'insert') {
          calls.complaintsInsert.push(state.insertRow);
          result = { data: { ...state.insertRow, id: 'brand-new-complaint-id' }, error: null };
        } else {
          result = { data: [], error: null };
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }

  return { client: { from: (table) => makeChain(table) }, calls };
}

// Swaps @supabase/supabase-js's require.cache entry for a fake createClient
// (resolved relative to the target module's own location, so this matches
// exactly what ITS OWN require('@supabase/supabase-js') resolves to),
// force-refreshes the target module so it picks up the fake client, runs
// `run(freshModule)`, then restores both cache entries and ANTHROPIC_API_KEY
// no matter what — so this can never leak a fake module into any other test
// in this suite. Generalized out of what PART 15 originally wrote as a
// significance-pass.js-only helper (PART 17, below, reuses it against the
// same module with a DIFFERENT kind of fake client — one that actually
// applies query filters — rather than duplicating the cache-swap dance).
async function withFakeSupabaseClient(fakeClient, modulePath, run) {
  const targetPath = require.resolve(modulePath);
  const supabasePath = require.resolve('@supabase/supabase-js', { paths: [path.dirname(targetPath)] });

  const hadSupabaseCache = Object.prototype.hasOwnProperty.call(require.cache, supabasePath);
  const originalSupabaseModule = require.cache[supabasePath];
  const hadTargetCache = Object.prototype.hasOwnProperty.call(require.cache, targetPath);
  const originalTargetModule = require.cache[targetPath];

  require.cache[supabasePath] = {
    id: supabasePath, filename: supabasePath, loaded: true, exports: { createClient: () => fakeClient },
  };
  delete require.cache[targetPath];

  const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY; // deterministically drives Call 2 to its fail-closed placeholder path — no real Anthropic call, ever.

  try {
    const freshModule = require(targetPath);
    await run(freshModule);
  } finally {
    if (savedAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
    if (hadSupabaseCache) require.cache[supabasePath] = originalSupabaseModule; else delete require.cache[supabasePath];
    if (hadTargetCache) require.cache[targetPath] = originalTargetModule; else delete require.cache[targetPath];
  }
}

async function withFakeSignificancePass(fakeConfig, run) {
  const { client: fakeClient, calls } = makeFakeSupabaseClient(fakeConfig);
  await withFakeSupabaseClient(fakeClient, '../lib/significance-pass', (freshSignificancePass) => run(freshSignificancePass, calls));
}

const DUP_TEST_CONVERSATION_ROW = {
  id: 1, mailbox_key: 'team:abc-real-mailbox', missive_conversation_id: 'conv-interrupted-run-test',
  missive_message_id: 'msg-1',
  from_address: null, to_addresses: null, cc_addresses: null, bcc_addresses: null, // no addresses -> matchParticipantsToRecords short-circuits with zero DB calls, keeping this fake minimal
  subject: 'Test conversation', body_text: 'This is a test conversation body for the idempotency-guard test.',
  delivered_at: '2026-01-01T00:00:00.000Z', screening_completed_at: '2026-01-02T00:00:00.000Z',
};

const DUP_TEST_EXISTING_ROW = {
  id: 'sig-row-id', mailbox_key: 'team:abc-real-mailbox', missive_conversation_id: 'conv-interrupted-run-test',
  category: 'dispute', resolution_status: 'open', why: 'A test dispute, already Call-1-categorized.',
  discovery_context: 'historical_backfill',
  keyword_check_flagged_protected_class: false, keyword_check_flagged_category: null,
};

asyncTest('significance-pass — retryCall2ForExistingRow: a conversation whose complaints row ALREADY EXISTS (left behind by an earlier, interrupted run) reuses it — NO second insert, exactly the bug Judge found', async () => {
  await withFakeSignificancePass(
    { conversationRows: [DUP_TEST_CONVERSATION_ROW], existingComplaint: { id: 'existing-complaint-id' } },
    async (freshSignificancePass, calls) => {
      const result = await freshSignificancePass.retryCall2ForExistingRow(DUP_TEST_EXISTING_ROW);

      assert.strictEqual(calls.complaintsInsert.length, 0, 'expected ZERO complaints inserts — this is the one hard requirement: an interrupted run must never create a second complaints row for the same conversation');
      assert.strictEqual(calls.complaintsSelect, 1, 'expected exactly one existence check against complaints for this conversation');
      assert.strictEqual(result.complaint_id, 'existing-complaint-id', 'expected the existing complaint to be reused (linked), not replaced');
      assert.strictEqual(result.outcome, 'call2_failed_placeholder', 'sanity check: Call 2 really did fail closed (no ANTHROPIC_API_KEY) — this is the exact placeholder path Judge named as the most likely real trigger');

      assert.strictEqual(calls.significanceUpdates.length, 1, 'expected the significance row to still be updated exactly once');
      assert.strictEqual(calls.significanceUpdates[0].complaint_id, 'existing-complaint-id', 'expected the significance row to be linked to the REUSED complaint, not left null and not pointed at a phantom new one');
      assert.strictEqual(calls.significanceUpdates[0].call2_completed_at, null, 'expected call2_completed_at to stay NULL on a failed-closed Call 2 — this row must remain visibly retryable, matching rowNeedsCall2Retry\'s own contract, even though its complaint is now correctly linked');
    }
  );
});

asyncTest('significance-pass — retryCall2ForExistingRow: regression check — when NO existing complaint exists, the guard does not suppress legitimate first-time creation (exactly one insert, still happens)', async () => {
  await withFakeSignificancePass(
    { conversationRows: [DUP_TEST_CONVERSATION_ROW], existingComplaint: null },
    async (freshSignificancePass, calls) => {
      const result = await freshSignificancePass.retryCall2ForExistingRow(DUP_TEST_EXISTING_ROW);

      assert.strictEqual(calls.complaintsInsert.length, 1, 'expected exactly one real insert when no existing complaint was found — the guard must not suppress a genuinely new complaint');
      assert.strictEqual(result.complaint_id, 'brand-new-complaint-id', 'expected the newly-inserted complaint\'s id to be the one linked');
      assert.strictEqual(calls.significanceUpdates[0].complaint_id, 'brand-new-complaint-id');
    }
  );
});

// ============================================================
// PART 16 — complaint-tracking/lib/subject-match.js: the real pilot bug,
// 2026-09-14 (significance-pass.js's second pilot run — "JSON object
// requested, multiple (or no) rows returned" on 2 of 98 conversations).
// Live-queried and confirmed against the real DB before any code changed:
// BOTH failing conversations had a participant address matching MORE THAN
// ONE row in `owners` (owners.email carries no uniqueness constraint —
// confirmed against 20260720000002_owners.sql). matchParticipantsToRecords()
// used .maybeSingle() on that lookup, which tolerates zero rows but throws
// on 2+ — exactly this error, thrown from buildConversationContext(),
// BEFORE significance-pass.js ever wrote a row to missive_conversation_
// significance or complaints (consistent with the live check finding
// neither table had a row for either conversation). Fix (subject-match.js):
// query as a plain array and only accept a match when it's genuinely
// unique; 2+ rows is now treated exactly like 0 rows (no match), never
// thrown on.
//
// A minimal fake Supabase client, scoped to exactly what subject-match.js
// calls (select/ilike/eq/limit, plus units' own .maybeSingle() — a
// same-table primary-key lookup, never ambiguous, untouched by this fix).
// ============================================================
const subjectMatch = require('../../complaint-tracking/lib/subject-match');

function makeFakeSubjectMatchClient(tableData) {
  function makeChain(table) {
    const filters = [];
    let limitN = null;
    const applyFilters = () => {
      const rows = (tableData[table] || []).filter((row) => filters.every((f) => f(row)));
      return limitN != null ? rows.slice(0, limitN) : rows;
    };
    const chain = {
      select() { return chain; },
      ilike(field, pattern) {
        const needle = pattern.replace(/\\(.)/g, '$1').toLowerCase(); // undo escapeIlike()'s own escaping for this fake's plain comparison
        filters.push((row) => typeof row[field] === 'string' && row[field].toLowerCase() === needle);
        return chain;
      },
      eq(field, value) { filters.push((row) => row[field] === value); return chain; },
      limit(n) { limitN = n; return chain; },
      maybeSingle() {
        const rows = applyFilters();
        return Promise.resolve({ data: rows[0] || null, error: null }); // units lookup only — always by primary key, never 2+ rows in these tests
      },
      then(resolve, reject) {
        return Promise.resolve({ data: applyFilters(), error: null }).then(resolve, reject);
      },
    };
    return chain;
  }
  return { from: (table) => makeChain(table) };
}

asyncTest('subject-match — findUniqueMatch: two owner rows sharing the same email (the exact real pilot bug shape) returns null instead of throwing', async () => {
  const client = makeFakeSubjectMatchClient({
    owners: [{ id: 'owner-1', email: 'shared@rincon-owner-test.com' }, { id: 'owner-2', email: 'shared@rincon-owner-test.com' }],
  });
  const result = await subjectMatch.findUniqueMatch(client, 'owners', 'shared@rincon-owner-test.com');
  assert.strictEqual(result, null, 'expected an ambiguous (2-row) match to resolve to null, never throw');
});

asyncTest('subject-match — findUniqueMatch: zero matching rows still resolves to null (regression — .maybeSingle()\'s old "tolerates 0" behavior must survive the fix)', async () => {
  const client = makeFakeSubjectMatchClient({ owners: [] });
  const result = await subjectMatch.findUniqueMatch(client, 'owners', 'nobody@rincon-owner-test.com');
  assert.strictEqual(result, null);
});

asyncTest('subject-match — findUniqueMatch: exactly one matching row still resolves to that row (regression — the ordinary case must keep working)', async () => {
  const client = makeFakeSubjectMatchClient({ owners: [{ id: 'owner-solo', email: 'solo@rincon-owner-test.com' }] });
  const result = await subjectMatch.findUniqueMatch(client, 'owners', 'solo@rincon-owner-test.com');
  assert.deepStrictEqual(result, { id: 'owner-solo', email: 'solo@rincon-owner-test.com' });
});

asyncTest('subject-match — matchParticipantsToRecords: reproduces the real production failure end-to-end (a thread whose only matching address collides with 2 co-owner rows) — resolves to no match, does NOT throw', async () => {
  const client = makeFakeSubjectMatchClient({
    tenants: [],
    owners: [
      { id: 'f88148ad-f00a-404a-852a-0567688d7aff', email: 'tackettfam3@gmail.com' },
      { id: '38a8285d-3f35-43db-b3e2-6d02b0b77a96', email: 'tackettfam3@gmail.com' },
    ],
    vendors: [],
  });
  const result = await subjectMatch.matchParticipantsToRecords(client, ['tackettfam3@gmail.com', 'marci@rinconmanagement.com', 'fariateam@rinconmanagement.com']);
  assert.deepStrictEqual(result, { subject_type: null, subject_id: null, vendor_id: null, property_id: null }, 'expected the ambiguous owner match to be treated as no match, not thrown on or guessed');
});

asyncTest('subject-match — matchParticipantsToRecords: an ambiguous match on one address does not block a later address from matching a DIFFERENT role uniquely (falls through, tenant -> owner -> vendor, exactly as before this fix)', async () => {
  const client = makeFakeSubjectMatchClient({
    tenants: [],
    owners: [
      { id: 'owner-a', email: 'shared@rincon-owner-test.com' },
      { id: 'owner-b', email: 'shared@rincon-owner-test.com' },
    ],
    vendors: [{ id: 'vendor-unique', email: 'vendor@rincon-vendor-test.com' }],
  });
  const result = await subjectMatch.matchParticipantsToRecords(client, ['shared@rincon-owner-test.com', 'vendor@rincon-vendor-test.com']);
  assert.deepStrictEqual(result, { subject_type: null, subject_id: null, vendor_id: 'vendor-unique', property_id: null });
});

asyncTest('subject-match — matchParticipantsToRecords: regression — a normal, unique tenant match still resolves correctly and still resolves property_id via the active lease', () => {
  const client = makeFakeSubjectMatchClient({
    tenants: [{ id: 'tenant-1', email: 'tenant@rincon-tenant-test.com' }],
    leases: [{ tenant_id: 'tenant-1', unit_id: 'unit-1', status: 'active' }],
    units: [{ id: 'unit-1', property_id: 'property-1' }],
  });
  return subjectMatch.matchParticipantsToRecords(client, ['tenant@rincon-tenant-test.com']).then((result) => {
    assert.deepStrictEqual(result, { subject_type: 'tenant', subject_id: 'tenant-1', vendor_id: null, property_id: 'property-1' });
  });
});

// ============================================================
// PART 16b — supabase/migrations/20261002000000_tenant_owner_emails_schema.sql
// (Neo) + the sync.js / subject-match.js changes that consume it: a
// tenant/owner's address may now live in the OLD single column
// (tenants.email / owners.email — still just the first/primary address) OR
// the NEW child table (tenant_emails / owner_emails — the complete set), OR
// BOTH once a person is re-synced. findUniqueTenantIdForAddress() /
// findUniqueOwnerIdForAddress() union both sources into a Set and only
// match when that Set has exactly one id — same "unique match or nothing"
// discipline as findUniqueMatch() above, now spanning two tables instead of
// one. Vendors are untouched (out of scope) — covered by the vendor-loop
// regression test above, still going through plain findUniqueMatch().
// ============================================================

asyncTest('subject-match — findUniqueTenantIdForAddress: matches via the NEW tenant_emails table when the OLD tenants.email column has nothing for this address (e.g. a tenant with a second address AppFolio has on file, not yet reflected in tenants.email)', async () => {
  const client = makeFakeSubjectMatchClient({
    tenants: [{ id: 'tenant-1', email: 'primary@rincon-tenant-test.com' }], // different address — old column has nothing for the one we're looking up
    tenant_emails: [{ tenant_id: 'tenant-1', email: 'secondary@rincon-tenant-test.com' }],
  });
  const result = await subjectMatch.findUniqueTenantIdForAddress(client, 'secondary@rincon-tenant-test.com');
  assert.deepStrictEqual(result, { id: 'tenant-1' });
});

asyncTest('subject-match — findUniqueOwnerIdForAddress: matches via the NEW owner_emails table when the OLD owners.email column has nothing for this address (e.g. one of the 132 owners whose comma-joined string gets split across multiple owner_emails rows)', async () => {
  const client = makeFakeSubjectMatchClient({
    owners: [{ id: 'owner-1', email: 'first@rincon-owner-test.com' }],
    owner_emails: [
      { owner_id: 'owner-1', email: 'first@rincon-owner-test.com' },
      { owner_id: 'owner-1', email: 'second@rincon-owner-test.com' },
    ],
  });
  const result = await subjectMatch.findUniqueOwnerIdForAddress(client, 'second@rincon-owner-test.com');
  assert.deepStrictEqual(result, { id: 'owner-1' });
});

asyncTest('subject-match — findUniqueTenantIdForAddress: regression — still matches via the OLD tenants.email column when tenant_emails has nothing at all for this tenant (not yet re-synced into the new table) — today\'s behavior keeps working unchanged', async () => {
  const client = makeFakeSubjectMatchClient({
    tenants: [{ id: 'tenant-1', email: 'tenant@rincon-tenant-test.com' }],
    tenant_emails: [], // no rows yet — this tenant hasn't been re-synced
  });
  const result = await subjectMatch.findUniqueTenantIdForAddress(client, 'tenant@rincon-tenant-test.com');
  assert.deepStrictEqual(result, { id: 'tenant-1' });
});

asyncTest('subject-match — findUniqueOwnerIdForAddress: regression — still matches via the OLD owners.email column when owner_emails has nothing at all for this owner (not yet re-synced into the new table) — today\'s behavior keeps working unchanged', async () => {
  const client = makeFakeSubjectMatchClient({
    owners: [{ id: 'owner-1', email: 'owner@rincon-owner-test.com' }],
    owner_emails: [],
  });
  const result = await subjectMatch.findUniqueOwnerIdForAddress(client, 'owner@rincon-owner-test.com');
  assert.deepStrictEqual(result, { id: 'owner-1' });
});

asyncTest('subject-match — findUniqueTenantIdForAddress: an address resolving to 2+ DISTINCT tenants across the combined old-column-plus-new-table lookup is treated as no match, not guessed (same address on tenants.email for one tenant AND on tenant_emails for a different tenant)', async () => {
  const client = makeFakeSubjectMatchClient({
    tenants: [{ id: 'tenant-A', email: 'shared@rincon-tenant-test.com' }],
    tenant_emails: [{ tenant_id: 'tenant-B', email: 'shared@rincon-tenant-test.com' }],
  });
  const result = await subjectMatch.findUniqueTenantIdForAddress(client, 'shared@rincon-tenant-test.com');
  assert.strictEqual(result, null, 'expected 2 distinct ids (one from each source) to resolve to null, never guessed');
});

asyncTest('subject-match — findUniqueOwnerIdForAddress: an address resolving to 2+ DISTINCT owners across the combined old-column-plus-new-table lookup is treated as no match, not guessed (same address on owners.email for one owner AND on owner_emails for a different owner)', async () => {
  const client = makeFakeSubjectMatchClient({
    owners: [{ id: 'owner-A', email: 'shared@rincon-owner-test.com' }],
    owner_emails: [{ owner_id: 'owner-B', email: 'shared@rincon-owner-test.com' }],
  });
  const result = await subjectMatch.findUniqueOwnerIdForAddress(client, 'shared@rincon-owner-test.com');
  assert.strictEqual(result, null, 'expected 2 distinct ids (one from each source) to resolve to null, never guessed');
});

asyncTest('subject-match — findUniqueTenantIdForAddress: the SAME real tenant appearing in BOTH tenants.email and tenant_emails for this address (re-synced, is_primary copy) is deduped to one id and still matches — not mistaken for an ambiguous 2-row case', async () => {
  const client = makeFakeSubjectMatchClient({
    tenants: [{ id: 'tenant-1', email: 'tenant@rincon-tenant-test.com' }],
    tenant_emails: [{ tenant_id: 'tenant-1', email: 'tenant@rincon-tenant-test.com' }], // is_primary copy of the same address, same tenant
  });
  const result = await subjectMatch.findUniqueTenantIdForAddress(client, 'tenant@rincon-tenant-test.com');
  assert.deepStrictEqual(result, { id: 'tenant-1' }, 'expected the Set to dedupe the same id from both sources down to one, still a clean unique match');
});

asyncTest('subject-match — findUniqueTenantIdForAddress: a tenant_emails row whose tenant_id is still NULL (written by the sync before resolve_tenant_email_foreign_keys() has run) is not counted as a match on its own — never surfaces a null id', async () => {
  const client = makeFakeSubjectMatchClient({
    tenants: [],
    tenant_emails: [{ tenant_id: null, email: 'unresolved@rincon-tenant-test.com' }],
  });
  const result = await subjectMatch.findUniqueTenantIdForAddress(client, 'unresolved@rincon-tenant-test.com');
  assert.strictEqual(result, null, 'expected an unresolved (null tenant_id) row to never produce a match');
});

asyncTest('subject-match — matchParticipantsToRecords: end-to-end — a tenant matches ONLY via tenant_emails (old tenants.email column has a different, unrelated address) and property_id still resolves via the active lease', async () => {
  const client = makeFakeSubjectMatchClient({
    tenants: [{ id: 'tenant-1', email: 'primary@rincon-tenant-test.com' }],
    tenant_emails: [{ tenant_id: 'tenant-1', email: 'secondary@rincon-tenant-test.com' }],
    leases: [{ tenant_id: 'tenant-1', unit_id: 'unit-1', status: 'active' }],
    units: [{ id: 'unit-1', property_id: 'property-1' }],
  });
  const result = await subjectMatch.matchParticipantsToRecords(client, ['secondary@rincon-tenant-test.com']);
  assert.deepStrictEqual(result, { subject_type: 'tenant', subject_id: 'tenant-1', vendor_id: null, property_id: 'property-1' });
});

asyncTest('subject-match — matchParticipantsToRecords: end-to-end — an owner whose AppFolio record held a broken comma-joined email (the real 132-owner bug) now matches on the SECOND split address via owner_emails, where it would have matched nothing before this fix', async () => {
  const client = makeFakeSubjectMatchClient({
    tenants: [],
    owners: [{ id: 'owner-1', email: 'ayad321@gmail.com' }], // normalized to first address only, per the backfill/sync fix
    owner_emails: [
      { owner_id: 'owner-1', email: 'ayad321@gmail.com' },
      { owner_id: 'owner-1', email: 'charlottefnp@hotmail.com' },
    ],
    vendors: [],
  });
  const result = await subjectMatch.matchParticipantsToRecords(client, ['charlottefnp@hotmail.com']);
  assert.deepStrictEqual(result, { subject_type: 'owner', subject_id: 'owner-1', vendor_id: null, property_id: null });
});

// ============================================================
// PART 17 — staged-by-recency backfill date cutoff (Peter's request,
// 2026-09-17): an optional sinceDate on the significance-pass driver, so
// Peter can run the ~250,487-conversation historical archive in stages by
// recency (last 1 year first) instead of committing to the whole archive
// at once. Two layers tested:
//   (a) run-significance-pilot.js's CLI flag parsing (--since-years/
//       --since-date) — pure functions, no I/O, tested directly.
//   (b) the driver's actual DB-query behavior — a REAL exercise of
//       fetchNextEligibleConversations()/fetchDriverPage() against a fake
//       Supabase client that genuinely APPLIES gte/gt/eq/in/order/limit
//       (unlike PART 15's makeFakeSupabaseClient, whose chain methods are
//       no-ops beyond select/insert/update) — necessary because the
//       property under test IS the query's filtering behavior, most
//       importantly the named edge case: a conversation with an OLD first
//       message and a RECENT last message must be INCLUDED, not excluded,
//       by a per-row delivered_at filter on a message-level view.
// ============================================================
const runSignificancePilot = require('../run-significance-pilot');

// ─── (a) CLI flag parsing ──────────────────────────────────────────────
test('run-significance-pilot — parseSinceArgs: neither flag passed means no cutoff — the exact "unchanged for existing callers" default this task requires', () => {
  assert.deepStrictEqual(runSignificancePilot.parseSinceArgs([]), { sinceDate: null, error: null });
  assert.deepStrictEqual(runSignificancePilot.parseSinceArgs(['--count=200']), { sinceDate: null, error: null });
});

test('run-significance-pilot — parseSinceArgs: --since-date=YYYY-MM-DD parses to that exact date string', () => {
  const result = runSignificancePilot.parseSinceArgs(['--since-date=2025-09-17']);
  assert.deepStrictEqual(result, { sinceDate: '2025-09-17', error: null });
});

test('run-significance-pilot — parseSinceArgs: an invalid --since-date (bad format, or a format-valid but non-existent calendar date) is rejected with a clear error, sinceDate null', () => {
  for (const bad of ['09-17-2025', 'not-a-date', '2025/09/17', '2025-13-40']) {
    const result = runSignificancePilot.parseSinceArgs([`--since-date=${bad}`]);
    assert.strictEqual(result.sinceDate, null, `expected null sinceDate for invalid --since-date=${bad}`);
    assert.ok(result.error, `expected a non-empty error message for invalid --since-date=${bad}`);
  }
});

test('run-significance-pilot — parseSinceArgs: --since-years=1 computes a real cutoff date matching computeSinceDateFromYears(1) — same "now", same result', () => {
  const viaArgs = runSignificancePilot.parseSinceArgs(['--since-years=1']);
  const direct = runSignificancePilot.computeSinceDateFromYears(1);
  assert.strictEqual(viaArgs.error, null);
  assert.strictEqual(viaArgs.sinceDate, direct, 'expected --since-years=1 to compute the same cutoff as calling computeSinceDateFromYears(1) directly');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(viaArgs.sinceDate), 'expected an ISO YYYY-MM-DD date string');
});

test('run-significance-pilot — parseSinceArgs: --since-years accepts a fractional value (e.g. 0.5)', () => {
  const result = runSignificancePilot.parseSinceArgs(['--since-years=0.5']);
  assert.strictEqual(result.error, null);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(result.sinceDate));
});

test('run-significance-pilot — parseSinceArgs: a non-positive or non-numeric --since-years is rejected', () => {
  for (const bad of ['0', '-1', 'abc', '']) {
    const result = runSignificancePilot.parseSinceArgs([`--since-years=${bad}`]);
    assert.strictEqual(result.sinceDate, null, `expected null sinceDate for --since-years=${bad}`);
    assert.ok(result.error, `expected an error for --since-years=${bad}`);
  }
});

test('run-significance-pilot — parseSinceArgs: passing BOTH --since-date and --since-years is rejected as ambiguous, rather than silently preferring one', () => {
  const result = runSignificancePilot.parseSinceArgs(['--since-date=2025-09-17', '--since-years=1']);
  assert.strictEqual(result.sinceDate, null);
  assert.ok(/only one/i.test(result.error), 'expected an error explaining only one of the two flags is allowed');
});

test('run-significance-pilot — computeSinceDateFromYears: 1 year back from a fixed reference date lands on the expected calendar date', () => {
  const fixedNow = new Date('2026-09-17T12:00:00.000Z');
  const result = runSignificancePilot.computeSinceDateFromYears(1, fixedNow);
  assert.strictEqual(result, '2025-09-17');
});

// ─── passesSinceDate — the client-side half of Neo's REAL sinceDate fix
// (2026-09-17, second and final attempt): fetchDriverPage() no longer
// filters by delivered_at in SQL at all (see its own header comment in
// lib/significance-pass.js for why the SQL-side approach — twice — timed
// out on the real database); this pure function is now the ONLY place the
// date cutoff is actually applied, so it gets its own direct unit tests
// rather than relying solely on the higher-level driver tests below. ──────
test('passesSinceDate — sinceDate null or undefined always passes, regardless of delivered_at (including a null delivered_at)', () => {
  assert.strictEqual(significancePass.passesSinceDate({ delivered_at: '2020-01-01T00:00:00.000Z' }, null), true);
  assert.strictEqual(significancePass.passesSinceDate({ delivered_at: '2020-01-01T00:00:00.000Z' }, undefined), true);
  assert.strictEqual(significancePass.passesSinceDate({ delivered_at: null }, null), true);
  assert.strictEqual(significancePass.passesSinceDate({ delivered_at: null }, undefined), true);
});

test('passesSinceDate — a null delivered_at fails once a sinceDate is set, matching exact parity with what SQL\'s own >= would have done (NULL never matches >=), never defaulting to included', () => {
  assert.strictEqual(significancePass.passesSinceDate({ delivered_at: null }, '2025-09-17'), false);
  assert.strictEqual(significancePass.passesSinceDate({}, '2025-09-17'), false); // delivered_at missing entirely — same as null.
});

test('passesSinceDate — delivered_at strictly before sinceDate fails, strictly after passes', () => {
  assert.strictEqual(significancePass.passesSinceDate({ delivered_at: '2024-01-01T00:00:00.000Z' }, '2025-09-17'), false);
  assert.strictEqual(significancePass.passesSinceDate({ delivered_at: '2026-01-01T00:00:00.000Z' }, '2025-09-17'), true);
});

test('passesSinceDate — a boundary-exact timestamp (delivered_at === sinceDate) passes, matching SQL\'s own >= (inclusive, not exclusive)', () => {
  assert.strictEqual(significancePass.passesSinceDate({ delivered_at: '2025-09-17T00:00:00.000Z' }, '2025-09-17'), true);
  assert.strictEqual(significancePass.passesSinceDate({ delivered_at: '2025-09-17T00:00:00.000Z' }, '2025-09-17T00:00:00.000Z'), true);
});

test('passesSinceDate — uses Date.parse, not raw string comparison, so a date-only cutoff ("YYYY-MM-DD") correctly compares against a full ISO timestamp delivered_at', () => {
  // A raw string comparison would put '2025-09-17T00:00:00.000Z' BEFORE '2025-09-17' (the shorter string), wrongly failing this case.
  assert.strictEqual(significancePass.passesSinceDate({ delivered_at: '2025-09-17T00:00:00.000Z' }, '2025-09-17'), true);
  assert.strictEqual(significancePass.passesSinceDate({ delivered_at: '2025-09-16T23:59:59.999Z' }, '2025-09-17'), false);
});

// ─── (b) The driver's real query behavior — the edge case that matters ──
// A minimal fake Supabase query-builder that ACTUALLY filters/sorts/limits
// its table data (unlike PART 15's makeFakeSupabaseClient), since the
// thing under test here is precisely whether fetchNextEligibleConversations'
// client-side date filter (passesSinceDate) produces conversation-level,
// not message-level, date filtering.
//
// UPDATED 2026-09-17, SECOND TIME (Neo's real fix — see fetchDriverPage()'s
// own header comment in lib/significance-pass.js): the first version of
// this mock (same day, first attempt) added .gte() and .or() support to
// mimic a composite (delivered_at, id) keyset cursor sent to Postgres. That
// approach is abandoned — fetchDriverPage() no longer sends delivered_at to
// Postgres as a filter at all, in either branch, ever — so that scaffolding
// is removed rather than kept as unused surface area. This mock now only
// needs what the real, single, unconditional query shape actually uses:
// one .order() call (plain `ORDER BY id ASC`), .gt() for the bare-id
// cursor, .in() for filterAlreadyProcessed's existence check against
// missive_conversation_significance, and .limit().
//
// UPDATED AGAIN 2026-09-18 (migration 20260918020000's handoff):
// fetchNextEligibleConversations() now unconditionally calls
// fetchEscalationExclusionSet() once per call, which sends a real .or()
// against archive_search_escalations — .or() is added back here as a
// plain no-op passthrough (same as the general-purpose
// makeFakeSupabaseClient above already does) purely so that call doesn't
// throw; none of the tests using this fake client below configure any
// archive_search_escalations rows, so tableData['archive_search_
// escalations'] || [] already yields the correct empty exclusion set
// without this mock needing to actually parse the OR condition. Tests that
// DO need real escalation-exclusion filtering behavior use their own
// dedicated fake client (makeEscalationAwareFakeClient, below) instead of
// growing this one further, matching this suite's own convention of one
// small fake per concern.
//
// UPDATED 2026-09-21 (migration 20260921020000, performance fix):
// fetchDriverPage() no longer queries missive_message_intake_search_safe_
// clear_branch via .from() — it calls the
// archive_search_significance_driver_next_clear_page RPC instead (see that
// function's own header comment in significance-pass.js). rpc() below
// serves that call directly out of tableData's own
// missive_message_intake_search_safe_clear_branch entry — same backing
// fixture data every test below already builds, just read through the new
// call shape instead of the old .from() chain.

// withAbortSignalStub — added 2026-09-22 alongside DB_CALL_ABORT_TIMEOUT_MS.
// fetchDriverPage() now chains .abortSignal(AbortSignal.timeout(...)) onto
// its RPC call, same as filterAlreadyProcessed() does onto its .in() call
// (that one's covered by each fake .from() chain's own abortSignal() method
// instead — see makeFilteringFakeClient's chain below). A plain
// Promise.resolve(...) has no .abortSignal method, so every fake rpc()
// below that serves archive_search_significance_driver_next_clear_page
// wraps its return value with this — same no-op-passthrough shape as the
// real client's .abortSignal(), just ignoring the signal since these fakes
// never hang.
function withAbortSignalStub(promise) {
  promise.abortSignal = () => promise;
  return promise;
}

function makeFilteringFakeClient(tableData) {
  function makeChain(table) {
    const filters = [];
    let orderField = null;
    let orderAsc = true;
    let limitN = null;
    const chain = {
      select() { return chain; },
      order(field, opts) { orderField = field; orderAsc = !(opts && opts.ascending === false); return chain; },
      limit(n) { limitN = n; return chain; },
      gt(field, value) { filters.push((row) => row[field] > value); return chain; },
      eq(field, value) { filters.push((row) => row[field] === value); return chain; },
      in(field, values) { filters.push((row) => values.includes(row[field])); return chain; },
      or() { return chain; },
      abortSignal() { return chain; }, // added 2026-09-22 alongside DB_CALL_ABORT_TIMEOUT_MS — filterAlreadyProcessed() now chains .abortSignal() onto every .in() call; this fake just needs to accept and ignore it, same as the real client does for a signal that never fires.
      then(resolve, reject) {
        let rows = (tableData[table] || []).filter((row) => filters.every((f) => f(row)));
        if (orderField) {
          rows = rows.slice().sort((a, b) => {
            if (a[orderField] < b[orderField]) return orderAsc ? -1 : 1;
            if (a[orderField] > b[orderField]) return orderAsc ? 1 : -1;
            return 0;
          });
        }
        if (limitN != null) rows = rows.slice(0, limitN);
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      },
    };
    return chain;
  }
  function rpc(name, args) {
    if (name === 'archive_search_significance_driver_next_clear_page') {
      const cursor = args && args.p_cursor_id != null ? args.p_cursor_id : null;
      const limitN = args && args.p_limit;
      let rows = (tableData.missive_message_intake_search_safe_clear_branch || []).slice();
      if (cursor !== null) rows = rows.filter((row) => row.id > cursor);
      rows = rows.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (limitN != null) rows = rows.slice(0, limitN);
      return withAbortSignalStub(Promise.resolve({ data: rows, error: null }));
    }
    return Promise.reject(new Error(`makeFilteringFakeClient: unexpected rpc '${name}'`));
  }
  return { from: (table) => makeChain(table), rpc };
}

// The exact edge case this task named: an OLD first message + a RECENT
// last message. id values are plain sortable strings standing in for the
// view's real ordering column (confirmed separately — real research this
// session — to be a random UUID; the driver's correctness argument never
// depends on id/delivered_at correlation, only on id giving a stable total
// order to page through, which any sortable id type provides).
const CUTOFF = '2025-09-17'; // matches this task's real 1-year-ago reference point.
const EDGE_CASE_MESSAGE_ROWS = [
  // conv-old-but-recently-active: first message from 2022 (long before the
  // cutoff), last message from 2026-08-01 (within the cutoff window) —
  // MUST be included.
  { id: 'm1', mailbox_key: 'mb1', missive_conversation_id: 'conv-old-but-recently-active', delivered_at: '2022-01-01T00:00:00.000Z' },
  { id: 'm2', mailbox_key: 'mb1', missive_conversation_id: 'conv-old-but-recently-active', delivered_at: '2026-08-01T00:00:00.000Z' },
  // conv-fully-silent: both messages predate the cutoff — every message in
  // this conversation is old. MUST be excluded.
  { id: 'm3', mailbox_key: 'mb1', missive_conversation_id: 'conv-fully-silent', delivered_at: '2021-01-01T00:00:00.000Z' },
  { id: 'm4', mailbox_key: 'mb1', missive_conversation_id: 'conv-fully-silent', delivered_at: '2022-06-01T00:00:00.000Z' },
];

asyncTest('significance-pass driver — sinceDate INCLUDES a conversation with an old first message and a recent last message (the exact edge case this task named) — a per-row delivered_at filter on a message-level view is conversation-level correct, not message-level', async () => {
  const fakeClient = makeFilteringFakeClient({
    missive_message_intake_search_safe_clear_branch: EDGE_CASE_MESSAGE_ROWS,
    missive_conversation_significance: [],
  });
  await withFakeSupabaseClient(fakeClient, '../lib/significance-pass', async (freshSignificancePass) => {
    const pairs = await freshSignificancePass.fetchNextEligibleConversations(10, CUTOFF);
    assert.deepStrictEqual(pairs, [{ mailbox_key: 'mb1', missive_conversation_id: 'conv-old-but-recently-active' }],
      'expected ONLY the old-but-recently-active conversation to survive a 1-year cutoff — the fully-silent one must be excluded, and the recently-active one must NOT be wrongly excluded just because its FIRST message predates the cutoff');
  });
});

asyncTest('significance-pass driver — sinceDate omitted (undefined, i.e. the exact call shape every existing caller already uses) returns every eligible conversation regardless of age — completely unchanged default behavior', async () => {
  const fakeClient = makeFilteringFakeClient({
    missive_message_intake_search_safe_clear_branch: EDGE_CASE_MESSAGE_ROWS,
    missive_conversation_significance: [],
  });
  await withFakeSupabaseClient(fakeClient, '../lib/significance-pass', async (freshSignificancePass) => {
    const pairs = await freshSignificancePass.fetchNextEligibleConversations(10);
    const keys = pairs.map((p) => p.missive_conversation_id).sort();
    assert.deepStrictEqual(keys, ['conv-fully-silent', 'conv-old-but-recently-active'],
      'expected BOTH conversations when no sinceDate is passed at all — the exact no-argument call shape every pre-existing caller uses');
  });
});

asyncTest('significance-pass driver — sinceDate explicitly null behaves identically to omitting it entirely', async () => {
  const fakeClient = makeFilteringFakeClient({
    missive_message_intake_search_safe_clear_branch: EDGE_CASE_MESSAGE_ROWS,
    missive_conversation_significance: [],
  });
  await withFakeSupabaseClient(fakeClient, '../lib/significance-pass', async (freshSignificancePass) => {
    const pairs = await freshSignificancePass.fetchNextEligibleConversations(10, null);
    assert.strictEqual(pairs.length, 2, 'expected sinceDate: null to include both conversations, same as omitting the argument');
  });
});

asyncTest('significance-pass driver — a conversation already processed (has a missive_conversation_significance row) stays excluded even when it would otherwise pass the date cutoff — the date filter composes with, and never bypasses, the existing "already processed" check', async () => {
  const fakeClient = makeFilteringFakeClient({
    missive_message_intake_search_safe_clear_branch: EDGE_CASE_MESSAGE_ROWS,
    missive_conversation_significance: [{ mailbox_key: 'mb1', missive_conversation_id: 'conv-old-but-recently-active' }],
  });
  await withFakeSupabaseClient(fakeClient, '../lib/significance-pass', async (freshSignificancePass) => {
    const pairs = await freshSignificancePass.fetchNextEligibleConversations(10, CUTOFF);
    assert.deepStrictEqual(pairs, [], 'expected zero eligible conversations — the only one that would pass the date cutoff was already processed');
  });
});

// ─── Real pagination across a page boundary using the plain id cursor,
// with a full page of pre-cutoff rows in between (Neo's REAL sinceDate
// query-timeout fix, 2026-09-17 — second and final attempt) ───────────────
// The three tests above never actually exercise a second page — both
// EDGE_CASE_MESSAGE_ROWS conversations fit inside one page, so the cursor
// built from page 1 (page.length < DRIVER_PAGE_SIZE) is never even used to
// fetch a page 2. There is no longer a composite {delivered_at, id} cursor
// to tie-break (that approach was tried and abandoned — see fetchDriverPage
// ()'s own header comment in lib/significance-pass.js) — fetchDriverPage()
// now takes a single bare `id` cursor, unconditionally, and the sinceDate
// filter is applied client-side (passesSinceDate) AFTER each page comes
// back. The real risk this fix could regress is different from a tie-break:
// if fetchNextEligibleConversations ever advanced its cursor from the
// DATE-FILTERED rows instead of the RAW page, a full page where every row
// fails passesSinceDate would leave the cursor stuck at its previous value,
// and the loop would keep re-fetching the exact same page forever. This
// test forces exactly that shape: a full page of rows that are ALL before
// the cutoff (so passesSinceDate discards every one of them), followed by
// a second page holding the one qualifying conversation. DRIVER_PAGE_SIZE
// itself is read out of the real source rather than hardcoded here, so
// this test tracks that constant if it's ever changed rather than silently
// going stale.
const DRIVER_PAGE_SIZE_FOR_TEST = (() => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'significance-pass.js'), 'utf8');
  const m = source.match(/const DRIVER_PAGE_SIZE = (\d+);/);
  if (!m) throw new Error('significance-pass.js: could not find "const DRIVER_PAGE_SIZE = <n>;" — update this test if that constant was renamed.');
  return Number.parseInt(m[1], 10);
})();

asyncTest('significance-pass driver — sinceDate pagination advances past a FULL page of entirely pre-cutoff rows using the plain id cursor (advanced from the raw page, not the date-filtered rows) and still finds the one qualifying conversation on page 2 — the real risk this fix could regress, not a tie-break (there is no composite cursor left to tie-break)', async () => {
  const fillerCount = DRIVER_PAGE_SIZE_FOR_TEST; // exactly one full page, so the qualifying row is forced onto page 2.
  const fillerRows = [];
  for (let i = 0; i < fillerCount; i++) {
    fillerRows.push({
      id: `filler-${String(i).padStart(6, '0')}`, // sorts before 'zz-qualifies' below under plain ascending id order.
      mailbox_key: 'mb1',
      missive_conversation_id: `conv-filler-${i}`,
      delivered_at: '2021-01-01T00:00:00.000Z', // well before CUTOFF — every filler row must be discarded by passesSinceDate.
    });
  }
  const qualifyingRow = {
    id: 'zz-qualifies', mailbox_key: 'mb1', missive_conversation_id: 'conv-qualifies', delivered_at: '2026-01-01T00:00:00.000Z',
  };

  const fakeClient = makeFilteringFakeClient({
    missive_message_intake_search_safe_clear_branch: [...fillerRows, qualifyingRow],
    missive_conversation_significance: [],
  });

  await withFakeSupabaseClient(fakeClient, '../lib/significance-pass', async (freshSignificancePass) => {
    const pairs = await freshSignificancePass.fetchNextEligibleConversations(1, CUTOFF);
    assert.deepStrictEqual(pairs, [{ mailbox_key: 'mb1', missive_conversation_id: 'conv-qualifies' }],
      'expected the one qualifying conversation to be found on page 2 — if the cursor had been advanced from the date-filtered rows instead of the raw page, this would hang or return nothing, since page 1 has zero rows surviving the date filter');
  });
});

// ============================================================
// Escalation exclusion — migration 20260918020000's required handoff
// (2026-09-18). missive_message_intake_search_safe_clear_branch (see
// fetchDriverPage() above) is Branch 1 ONLY — screening_result = 'clear',
// no escalation awareness at all, by design (that's the fix: the old
// anti-join's query plan was proven live NOT stable across identical
// repeated requests). fetchNextEligibleConversations() now has to provide
// that exclusion itself, in application code, via
// fetchEscalationExclusionSet() + passesEscalationExclusion() — the tests
// below are the required proof this actually happens, matches the exact
// PostgREST condition Neo's migration specifies, is fetched once per call
// rather than once per page, and never breaks pagination the same way
// passesSinceDate() already had to prove above.
//
// A dedicated fake client, not a reuse/extension of makeFilteringFakeClient
// above — that one deliberately treats .or() as a no-op (see its own
// updated header comment) since none of ITS tests configure any
// archive_search_escalations rows. This one adds a real call-count/
// argument spy on .or() against that one table specifically, matching this
// suite's established convention of one small, purpose-built fake per
// concern rather than one shared mock accreting every feature.
//
// UPDATED 2026-09-21 (migration 20260921020000, performance fix): same
// change as makeFilteringFakeClient above — fetchDriverPage() now calls the
// archive_search_significance_driver_next_clear_page RPC instead of
// .from('missive_message_intake_search_safe_clear_branch'), so rpc() below
// serves that page fetch directly, reading the same
// missive_message_intake_search_safe_clear_branch fixture entry every test
// in this section already builds.
// ============================================================
function makeEscalationAwareFakeClient(tableData) {
  const calls = { escalationOrCalls: [] }; // one entry per real .or() call against archive_search_escalations — length IS the fetch count.
  function makeChain(table) {
    const filters = [];
    let orderField = null;
    let orderAsc = true;
    let limitN = null;
    const chain = {
      select() { return chain; },
      order(field, opts) { orderField = field; orderAsc = !(opts && opts.ascending === false); return chain; },
      limit(n) { limitN = n; return chain; },
      gt(field, value) { filters.push((row) => row[field] > value); return chain; },
      eq(field, value) { filters.push((row) => row[field] === value); return chain; },
      in(field, values) { filters.push((row) => values.includes(row[field])); return chain; },
      or(condition) {
        if (table === 'archive_search_escalations') calls.escalationOrCalls.push(condition);
        return chain;
      },
      abortSignal() { return chain; }, // added 2026-09-22 alongside DB_CALL_ABORT_TIMEOUT_MS — see withAbortSignalStub's own comment above makeFilteringFakeClient.
      then(resolve, reject) {
        let rows = (tableData[table] || []).filter((row) => filters.every((f) => f(row)));
        if (orderField) {
          rows = rows.slice().sort((a, b) => {
            if (a[orderField] < b[orderField]) return orderAsc ? -1 : 1;
            if (a[orderField] > b[orderField]) return orderAsc ? 1 : -1;
            return 0;
          });
        }
        if (limitN != null) rows = rows.slice(0, limitN);
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      },
    };
    return chain;
  }
  function rpc(name, args) {
    if (name === 'archive_search_significance_driver_next_clear_page') {
      const cursor = args && args.p_cursor_id != null ? args.p_cursor_id : null;
      const limitN = args && args.p_limit;
      let rows = (tableData.missive_message_intake_search_safe_clear_branch || []).slice();
      if (cursor !== null) rows = rows.filter((row) => row.id > cursor);
      rows = rows.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (limitN != null) rows = rows.slice(0, limitN);
      return withAbortSignalStub(Promise.resolve({ data: rows, error: null }));
    }
    return Promise.reject(new Error(`makeEscalationAwareFakeClient: unexpected rpc '${name}'`));
  }
  return { client: { from: (table) => makeChain(table), rpc }, calls };
}

test('significance-pass — fetchDriverPage() calls the archive_search_significance_driver_next_clear_page RPC, not the clear_branch view or the wider missive_message_intake_search_safe (migration 20260921020000, performance fix — source-scanned, matching this suite\'s own established convention for a single, unambiguous call-site check)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'significance-pass.js'), 'utf8');
  const start = source.indexOf('async function fetchDriverPage');
  assert.ok(start !== -1, 'expected to find fetchDriverPage()');
  const body = source.slice(start, source.indexOf('\n}', start));
  assert.ok(body.includes(".rpc('archive_search_significance_driver_next_clear_page'"), 'expected fetchDriverPage() to call the new, faster RPC function');
  assert.ok(!body.includes(".from('missive_message_intake_search_safe_clear_branch')"), 'expected fetchDriverPage() to no longer query the clear_branch view directly — the security_barrier view forced a slow sequential scan');
  assert.ok(!body.includes(".from('missive_message_intake_search_safe')"), 'expected fetchDriverPage() to no longer query the wider, anti-join view directly');
});

asyncTest('significance-pass driver — fetchEscalationExclusionSet is fetched exactly ONCE per fetchNextEligibleConversations call, even across multiple pages, using the EXACT condition migration 20260918020000 specifies', async () => {
  const fillerCount = DRIVER_PAGE_SIZE_FOR_TEST; // forces a real second page, same technique as the sinceDate pagination test above.
  const fillerRows = [];
  for (let i = 0; i < fillerCount; i++) {
    fillerRows.push({ id: `filler-${String(i).padStart(6, '0')}`, mailbox_key: 'mb1', missive_conversation_id: `conv-filler-${i}`, delivered_at: '2026-01-01T00:00:00.000Z' });
  }
  const page2Row = { id: 'zz-page2', mailbox_key: 'mb1', missive_conversation_id: 'conv-page2', delivered_at: '2026-01-01T00:00:00.000Z' };

  const { client: fakeClient, calls } = makeEscalationAwareFakeClient({
    missive_message_intake_search_safe_clear_branch: [...fillerRows, page2Row],
    missive_conversation_significance: [],
    archive_search_escalations: [],
  });

  await withFakeSupabaseClient(fakeClient, '../lib/significance-pass', async (freshSignificancePass) => {
    const pairs = await freshSignificancePass.fetchNextEligibleConversations(fillerCount + 1);
    assert.strictEqual(pairs.length, fillerCount + 1, 'expected every filler row plus the page-2 row back — nothing in the exclusion set, nothing should be dropped');
  });

  assert.strictEqual(calls.escalationOrCalls.length, 1, `expected fetchEscalationExclusionSet's .or() to be called exactly ONCE across the whole (2-page) run, not once per page; saw ${calls.escalationOrCalls.length}`);
  assert.strictEqual(calls.escalationOrCalls[0], 'status.eq.open,and(status.eq.confirmed,reopened_at.is.null)', 'expected the exact condition migration 20260918020000 specifies — matching the live main view\'s own real exclusion logic (20260912050000), not a looser status IN (...) shape');
});

asyncTest('significance-pass driver — a conversation in the escalation-exclusion set is correctly dropped from the page-loop output, while an unrelated conversation in the same page survives', async () => {
  const rows = [
    { id: 'm1', mailbox_key: 'mb1', missive_conversation_id: 'conv-escalated', delivered_at: '2026-01-01T00:00:00.000Z' },
    { id: 'm2', mailbox_key: 'mb1', missive_conversation_id: 'conv-clean', delivered_at: '2026-01-01T00:00:00.000Z' },
  ];
  const { client: fakeClient } = makeEscalationAwareFakeClient({
    missive_message_intake_search_safe_clear_branch: rows,
    missive_conversation_significance: [],
    // Only the fields fetchEscalationExclusionSet() actually selects — status/reopened_at are never read back by application code (the WHERE-equivalent .or() condition is Postgres's job in production; this fake, like makeFilteringFakeClient's .or(), doesn't re-filter server-side, so listing a row here IS "the query returned it").
    archive_search_escalations: [{ mailbox_key: 'mb1', missive_conversation_id: 'conv-escalated' }],
  });

  await withFakeSupabaseClient(fakeClient, '../lib/significance-pass', async (freshSignificancePass) => {
    const pairs = await freshSignificancePass.fetchNextEligibleConversations(10);
    assert.deepStrictEqual(pairs, [{ mailbox_key: 'mb1', missive_conversation_id: 'conv-clean' }],
      'expected conv-escalated to be dropped (real, open Fair-Housing escalation) and conv-clean to survive, unaffected');
  });
});

asyncTest('significance-pass driver — a conversation in the escalation-exclusion set in a DIFFERENT mailbox is NOT wrongly excluded (mailbox_key + missive_conversation_id is a composite key, same discipline dedupeNewPairs/filterAlreadyProcessed already use)', async () => {
  const rows = [
    { id: 'm1', mailbox_key: 'mb2', missive_conversation_id: 'conv-same-id-different-mailbox', delivered_at: '2026-01-01T00:00:00.000Z' },
  ];
  const { client: fakeClient } = makeEscalationAwareFakeClient({
    missive_message_intake_search_safe_clear_branch: rows,
    missive_conversation_significance: [],
    archive_search_escalations: [{ mailbox_key: 'mb1', missive_conversation_id: 'conv-same-id-different-mailbox' }], // escalated in mb1, NOT mb2.
  });

  await withFakeSupabaseClient(fakeClient, '../lib/significance-pass', async (freshSignificancePass) => {
    const pairs = await freshSignificancePass.fetchNextEligibleConversations(10);
    assert.deepStrictEqual(pairs, [{ mailbox_key: 'mb2', missive_conversation_id: 'conv-same-id-different-mailbox' }],
      'expected the mb2 conversation to survive — the escalation is recorded against the SAME conversation id in a DIFFERENT mailbox, which must not match');
  });
});

asyncTest('significance-pass driver — escalation exclusion pagination advances past a FULL page of entirely excluded rows using the plain id cursor (advanced from the raw page, not the exclusion-filtered rows) and still finds the one surviving conversation on page 2 — mirrors the identical sinceDate pagination property above, for the same "cursor advances from raw page" reason', async () => {
  const fillerCount = DRIVER_PAGE_SIZE_FOR_TEST;
  const fillerRows = [];
  const escalatedKeys = [];
  for (let i = 0; i < fillerCount; i++) {
    const missive_conversation_id = `conv-excluded-${i}`;
    fillerRows.push({ id: `filler-${String(i).padStart(6, '0')}`, mailbox_key: 'mb1', missive_conversation_id, delivered_at: '2026-01-01T00:00:00.000Z' });
    escalatedKeys.push({ mailbox_key: 'mb1', missive_conversation_id });
  }
  const survivingRow = { id: 'zz-survives', mailbox_key: 'mb1', missive_conversation_id: 'conv-survives', delivered_at: '2026-01-01T00:00:00.000Z' };

  const { client: fakeClient } = makeEscalationAwareFakeClient({
    missive_message_intake_search_safe_clear_branch: [...fillerRows, survivingRow],
    missive_conversation_significance: [],
    archive_search_escalations: escalatedKeys,
  });

  await withFakeSupabaseClient(fakeClient, '../lib/significance-pass', async (freshSignificancePass) => {
    const pairs = await freshSignificancePass.fetchNextEligibleConversations(1);
    assert.deepStrictEqual(pairs, [{ mailbox_key: 'mb1', missive_conversation_id: 'conv-survives' }],
      'expected the one surviving conversation to be found on page 2 — if the cursor had been advanced from the exclusion-filtered rows instead of the raw page, this would hang or return nothing, since page 1 has zero rows surviving exclusion');
  });
});

// ─── passesEscalationExclusion — pure unit tests, same shape as
// passesSinceDate's own unit tests above ──────────────────────────────────
test('passesEscalationExclusion — a row whose composite key is NOT in the exclusion set passes', () => {
  const keys = new Set(['mb1::conv-a']);
  assert.strictEqual(significancePass.passesEscalationExclusion({ mailbox_key: 'mb1', missive_conversation_id: 'conv-b' }, keys), true);
});

test('passesEscalationExclusion — a row whose composite key IS in the exclusion set fails', () => {
  const keys = new Set(['mb1::conv-a']);
  assert.strictEqual(significancePass.passesEscalationExclusion({ mailbox_key: 'mb1', missive_conversation_id: 'conv-a' }, keys), false);
});

test('passesEscalationExclusion — an empty exclusion set never excludes anything', () => {
  assert.strictEqual(significancePass.passesEscalationExclusion({ mailbox_key: 'mb1', missive_conversation_id: 'conv-a' }, new Set()), true);
});

test('passesEscalationExclusion — matches on the FULL composite key, not mailbox_key or missive_conversation_id alone (same mailbox, different conversation)', () => {
  const keys = new Set(['mb1::conv-a']);
  assert.strictEqual(significancePass.passesEscalationExclusion({ mailbox_key: 'mb1', missive_conversation_id: 'conv-z' }, keys), true);
});

// ============================================================
// PART 20 — Resumable driver cursor (migration 20260920010000, Neo).
// fetchNextEligibleConversations() now persists a keyset resume point so a
// fresh call does not have to re-walk missive_message_intake_search_safe_
// clear_branch from id=null every single time (see that function's own
// header comment in significance-pass.js, above cursorIsSafeToResume(),
// for the full correctness argument). TWO independent things must each
// stay unchanged for a saved cursor to be safe to reuse — screening-result
// membership below the cursor, and the escalation-exclusion set applied on
// top of it — and this suite proves BOTH real failure shapes end-to-end,
// not just the pure digest-comparison logic in isolation:
//   1. A screening reset-and-reclear (reset-layer1-removal-310.js's real,
//      already-executed shape): a conversation becomes newly 'clear' with
//      an id sitting behind an already-saved cursor.
//   2. An escalation reopening (20260912040000's real reopened_at/status
//      lifecycle — the SECOND gap, found on review, distinct from #1): a
//      conversation's escalation-exclusion status changes with NO change
//      to screening_result at all.
// Both must cause the NEXT call to fall back to a full walk and actually
// FIND the newly-eligible conversation — proven below by asserting on the
// real pairs returned AND on the real cursor value fetchDriverPage() was
// called with, so a test cannot pass "by accident" (a design that always
// falls back would trivially pass the two failure-shape tests without
// proving the fast-forward optimization exists at all — the first test
// below, the happy path, is what rules that out).
//
// sinceDate varying across separate calls sharing this cursor scope IS
// tested — see "Failure shape #3" further down this same PART, added after
// Asimov's review found this exact gap. driverCursorScopeKey() folds
// sinceDate into the scope key itself, so a call with a different sinceDate
// can never reuse another call's cursor — see significance-pass.js's own
// comment above driverCursorScopeKey() for the full reasoning.
//
// A dedicated, purpose-built fake client (not a reuse of
// makeFilteringFakeClient/makeEscalationAwareFakeClient) — this is the
// first thing in this suite that needs the archive_search_escalations fake
// to apply the REAL status/reopened_at predicate rather than "any row
// present is excluded," because these tests mutate that predicate BETWEEN
// two separate calls to fetchNextEligibleConversations() and need the fake
// escalation-exclusion RPC digest and the fake fetchEscalationExclusionSet
// query to agree with each other, exactly like the real database's own
// view and function must agree. State lives in one mutable object so a
// test can mutate it between two calls, simulating two genuinely separate
// invocations (a fresh process, a fresh HTTP request) sharing only the
// database — never any in-process cache, matching this design's own real
// architecture (see significance-pass.js's own header: the mechanism is
// specifically NOT an in-process running total, always a fresh query).
// ============================================================

function md5Hex(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

// TARS addition (migration 20260920020000): a fixed, safely-in-the-past
// screening_completed_at for every PART 20 fixture row that isn't itself
// the thing being raced in. Needed because persistDriverCursor() now
// ALWAYS passes a real run_started_at as p_as_of — even on a genuine
// first-ever run (only p_established_floor_id can be null) — so once
// makeResumableCursorFakeClient's rpc() actually honors that parameter
// (rather than ignoring it, as it did before this fix), any fixture row
// with no screening_completed_at at all would silently fail the new
// `screening_completed_at <= p_as_of` check and never make it into a
// persisted digest — breaking every existing fast-forward assertion below
// for reasons that have nothing to do with what each test actually means
// to prove. This constant is deliberately a fixed date in the past, not
// "now," so it is unconditionally <= any run_started_at these tests ever
// capture.
const RESUMABLE_CURSOR_OLD_TS = '2020-01-01T00:00:00.000Z';

// The exact predicate archive_search_escalation_exclusion_digest_check()
// and fetchEscalationExclusionSet() both use (status = 'open' OR
// (status = 'confirmed' AND reopened_at IS NULL)) — applied for REAL here,
// unlike makeEscalationAwareFakeClient's deliberate "any row present"
// shortcut, because these tests need this predicate to actually change
// between two calls.
function realEscalationExcludes(row) {
  return row.status === 'open' || (row.status === 'confirmed' && row.reopened_at == null);
}

function resumableCursorTableKey(table) {
  if (table === 'missive_message_intake_search_safe_clear_branch') return 'clearBranch';
  if (table === 'missive_conversation_significance') return 'significance';
  if (table === 'archive_search_escalations') return 'escalations';
  if (table === 'archive_search_significance_driver_cursors') return 'cursors';
  throw new Error(`makeResumableCursorFakeClient: unexpected table '${table}'`);
}

// state: { clearBranch: [], significance: [], escalations: [], cursors: [] }
// — a plain mutable object a test can edit BETWEEN two calls to
// fetchNextEligibleConversations(), standing in for two separate real
// invocations sharing only the database.
function makeResumableCursorFakeClient(state) {
  const calls = { clearBranchPageCursors: [], rpcCalls: [] }; // clearBranchPageCursors: one entry per real driver-page fetch, in order — null means "started from the beginning," a real id means "fast-forwarded from that saved cursor." THE key observable for proving which path a run actually took.

  function makeChain(table) {
    const filters = [];
    let orderField = null;
    let orderAsc = true;
    let limitN = null;
    let pendingUpsert = null;

    const chain = {
      select() { return chain; },
      order(field, opts) { orderField = field; orderAsc = !(opts && opts.ascending === false); return chain; },
      limit(n) { limitN = n; return chain; },
      gt(field, value) { filters.push((row) => row[field] > value); return chain; },
      eq(field, value) { filters.push((row) => row[field] === value); return chain; },
      in(field, values) { filters.push((row) => values.includes(row[field])); return chain; },
      or() { return chain; }, // archive_search_escalations is filtered for real in then()/maybeSingle(), below — see this section's own header for why this fake can't use the other fakes' "any row present" shortcut.
      abortSignal() { return chain; }, // added 2026-09-22 alongside DB_CALL_ABORT_TIMEOUT_MS — see withAbortSignalStub's own comment above makeFilteringFakeClient.
      maybeSingle() {
        const rows = (state[resumableCursorTableKey(table)] || []).filter((row) => filters.every((f) => f(row)));
        return Promise.resolve({ data: rows[0] || null, error: null });
      },
      upsert(row, opts) { pendingUpsert = { row, opts }; return chain; },
      then(resolve, reject) {
        if (pendingUpsert) {
          const key = resumableCursorTableKey(table);
          const arr = state[key] || (state[key] = []);
          const onConflict = pendingUpsert.opts && pendingUpsert.opts.onConflict;
          const idx = onConflict ? arr.findIndex((r) => r[onConflict] === pendingUpsert.row[onConflict]) : -1;
          if (idx >= 0) arr[idx] = { ...arr[idx], ...pendingUpsert.row }; else arr.push({ ...pendingUpsert.row });
          return Promise.resolve({ data: [pendingUpsert.row], error: null }).then(resolve, reject);
        }

        let rows = state[resumableCursorTableKey(table)] || [];
        if (table === 'archive_search_escalations') rows = rows.filter(realEscalationExcludes); // the REAL predicate, not "any row present" — see this section's own header.
        rows = rows.filter((row) => filters.every((f) => f(row)));
        if (orderField) {
          rows = rows.slice().sort((a, b) => {
            if (a[orderField] < b[orderField]) return orderAsc ? -1 : 1;
            if (a[orderField] > b[orderField]) return orderAsc ? 1 : -1;
            return 0;
          });
        }
        if (limitN != null) rows = rows.slice(0, limitN);

        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      },
    };
    return chain;
  }

  // TARS addition (migration 20260920020000): the REAL WHERE clause, not the
  // old ignore-floor-and-asOf shortcut this fake shipped with. Read
  // literally off the migration's own SQL (three OR'd escape hatches):
  //   p_as_of IS NULL
  //     -> the verification call site (resolveDriverStartCursor -> fetchClearBranchDigest,
  //        called with no floor/asOf) — unscoped, byte-for-byte the original
  //        20260920010000 behavior.
  //   p_established_floor_id IS NOT NULL AND id <= p_established_floor_id
  //     -> OLD territory (already covered before this run started) always
  //        counts, time-bound or not.
  //   screening_completed_at <= p_as_of
  //     -> NEW territory (id > floor, what THIS run actually swept) only
  //        counts if it was screened before this run began — this is what
  //        excludes a row that raced in mid-run, after verification/start
  //        but before persist.
  function realClearBranchCursorCheck(cursorId, establishedFloorId, asOf) {
    const rows = (state.clearBranch || []).filter((r) => {
      if (!(r.id <= cursorId)) return false;
      if (asOf == null) return true;
      if (establishedFloorId != null && r.id <= establishedFloorId) return true;
      return r.screening_completed_at != null && r.screening_completed_at <= asOf;
    });
    const ids = rows.map((r) => r.id).sort();
    return { row_count: ids.length, digest: md5Hex(ids.join(',')) };
  }

  function rpc(name, args) {
    calls.rpcCalls.push({ name, args });
    // UPDATED 2026-09-21 (migration 20260921020000, performance fix):
    // fetchDriverPage() itself now calls this RPC instead of .from(
    // 'missive_message_intake_search_safe_clear_branch') — this branch
    // replaces what used to be the .from() chain's own clear-branch
    // handling in makeChain()/then() above (see that function's own
    // now-simplified body). clearBranchPageCursors tracking and the
    // onClearBranchPageFetched race-repro hook move here with it, same
    // semantics as before: cursor null means "started from the beginning,"
    // a real id means "fast-forwarded"; onClearBranchPageFetched still
    // fires AFTER this page's own rows are read out of state.clearBranch
    // into a filtered/sliced COPY, so a mutation it makes can never leak
    // into the page currently resolving — see this section's own header
    // comment (TARS addition, migration 20260920020000) for why that
    // ordering matters.
    if (name === 'archive_search_significance_driver_next_clear_page') {
      const cursor = args && args.p_cursor_id != null ? args.p_cursor_id : null;
      calls.clearBranchPageCursors.push(cursor);
      let rows = (state.clearBranch || []).filter((row) => cursor === null || row.id > cursor);
      rows = rows.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const limitN = args && args.p_limit;
      if (limitN != null) rows = rows.slice(0, limitN);
      if (typeof state.onClearBranchPageFetched === 'function') state.onClearBranchPageFetched(cursor);
      return withAbortSignalStub(Promise.resolve({ data: rows, error: null }));
    }
    if (name === 'archive_search_missive_clear_branch_cursor_check') {
      const result = realClearBranchCursorCheck(args.p_cursor_id, args.p_established_floor_id ?? null, args.p_as_of ?? null);
      return Promise.resolve({ data: [result], error: null });
    }
    if (name === 'archive_search_escalation_exclusion_digest_check') {
      const keys = (state.escalations || []).filter(realEscalationExcludes).map((r) => `${r.mailbox_key}::${r.missive_conversation_id}`).sort();
      return Promise.resolve({ data: [{ row_count: keys.length, digest: md5Hex(keys.join(',')) }], error: null });
    }
    return Promise.reject(new Error(`makeResumableCursorFakeClient: unexpected rpc '${name}'`));
  }

  return { client: { from: (table) => makeChain(table), rpc }, calls };
}

// ─── cursorIsSafeToResume — pure unit tests, no DB ─────────────────────────
test('cursorIsSafeToResume — both digests matching returns true (the only case a saved cursor may be trusted)', () => {
  const saved = { established_clear_branch_digest: 'AAA', established_escalation_digest: 'BBB' };
  assert.strictEqual(significancePass.cursorIsSafeToResume(saved, { digest: 'AAA' }, { digest: 'BBB' }), true);
});

test('cursorIsSafeToResume — a clear-branch digest mismatch alone is unsafe, even when the escalation digest still matches', () => {
  const saved = { established_clear_branch_digest: 'AAA', established_escalation_digest: 'BBB' };
  assert.strictEqual(significancePass.cursorIsSafeToResume(saved, { digest: 'CHANGED' }, { digest: 'BBB' }), false);
});

test('cursorIsSafeToResume — an escalation digest mismatch alone is unsafe, even when the clear-branch digest still matches — the second gap found on review of the first draft of this design, distinct from the screening-reset gap above', () => {
  const saved = { established_clear_branch_digest: 'AAA', established_escalation_digest: 'BBB' };
  assert.strictEqual(significancePass.cursorIsSafeToResume(saved, { digest: 'AAA' }, { digest: 'CHANGED' }), false);
});

test('cursorIsSafeToResume — no saved cursor row at all is always unsafe (first-ever run for this scope)', () => {
  assert.strictEqual(significancePass.cursorIsSafeToResume(null, { digest: 'AAA' }, { digest: 'BBB' }), false);
});

// ─── The happy path — proves the optimization actually engages, not just
// that it fails safe ────────────────────────────────────────────────────
asyncTest('significance-pass driver — resumable cursor: an unchanged region behind a saved cursor is FAST-FORWARDED on the next run (the real performance win — rules out a design that always falls back)', async () => {
  const state = {
    clearBranch: [
      { id: 'id-1', mailbox_key: 'mb1', missive_conversation_id: 'conv-1', delivered_at: '2026-01-01T00:00:00.000Z', screening_completed_at: RESUMABLE_CURSOR_OLD_TS },
      { id: 'id-2', mailbox_key: 'mb1', missive_conversation_id: 'conv-2', delivered_at: '2026-01-01T00:00:00.000Z', screening_completed_at: RESUMABLE_CURSOR_OLD_TS },
    ],
    significance: [], escalations: [], cursors: [],
  };
  const { client: fakeClient, calls } = makeResumableCursorFakeClient(state);

  await withFakeSupabaseClient(fakeClient, '../lib/significance-pass', async (freshSignificancePass) => {
    const run1 = await freshSignificancePass.fetchNextEligibleConversations(10);
    assert.deepStrictEqual(run1.map((p) => p.missive_conversation_id).sort(), ['conv-1', 'conv-2'], 'run 1: expected both conversations found on a fresh, cursor-less walk');
    assert.strictEqual(calls.clearBranchPageCursors[0], null, 'run 1: expected the very first page fetch to start from null — no saved cursor exists yet');
    assert.strictEqual(state.cursors.length, 1, 'expected run 1 to persist exactly one cursor row for this scope');

    const run2 = await freshSignificancePass.fetchNextEligibleConversations(10);
    assert.deepStrictEqual(run2, [], 'run 2: nothing new exists beyond the saved cursor, so nothing should be (re)found');
    assert.strictEqual(calls.clearBranchPageCursors[calls.clearBranchPageCursors.length - 1], 'id-2', 'run 2: expected the fast-forward to actually engage — the page fetch should start from the SAVED cursor (id-2), not null, since nothing changed underneath it');
  });
});

// ─── Failure shape #1 — screening reset-and-reclear (reset-layer1-removal-
// 310.js's real, already-executed shape) ────────────────────────────────
asyncTest('significance-pass driver — resumable cursor: a screening reset-and-reclear BEHIND the saved cursor is caught, and the newly-eligible conversation IS found on the very next run — never silently, permanently skipped', async () => {
  const state = {
    clearBranch: [
      { id: 'id-2', mailbox_key: 'mb1', missive_conversation_id: 'conv-2', delivered_at: '2026-01-01T00:00:00.000Z', screening_completed_at: RESUMABLE_CURSOR_OLD_TS },
      { id: 'id-3', mailbox_key: 'mb1', missive_conversation_id: 'conv-3', delivered_at: '2026-01-01T00:00:00.000Z', screening_completed_at: RESUMABLE_CURSOR_OLD_TS },
    ],
    significance: [], escalations: [], cursors: [],
  };
  const { client: fakeClient, calls } = makeResumableCursorFakeClient(state);

  await withFakeSupabaseClient(fakeClient, '../lib/significance-pass', async (freshSignificancePass) => {
    const run1 = await freshSignificancePass.fetchNextEligibleConversations(10);
    assert.deepStrictEqual(run1.map((p) => p.missive_conversation_id).sort(), ['conv-2', 'conv-3']);

    // Between runs: conv-1 becomes newly 'clear' (screening_result reset, then re-screened — reset-layer1-removal-310.js's real shape) with an id sitting BEHIND the cursor run 1 just saved ('id-3'). id is gen_random_uuid() in production; nothing about it correlates to when a row was screened.
    state.clearBranch.unshift({ id: 'id-1', mailbox_key: 'mb1', missive_conversation_id: 'conv-1', delivered_at: '2026-02-01T00:00:00.000Z', screening_completed_at: '2026-02-01T00:00:00.000Z' });

    const run2 = await freshSignificancePass.fetchNextEligibleConversations(10);
    assert.ok(run2.some((p) => p.missive_conversation_id === 'conv-1'), 'expected conv-1 to be found on run 2 — a naive fast-forward past id-3 would never re-fetch id-1 at all and would permanently miss it');
    assert.strictEqual(calls.clearBranchPageCursors[calls.clearBranchPageCursors.length - 1], null, 'expected run 2 to fall back to a full walk from null (the clear-branch digest must have detected the mismatch below the cursor) rather than trusting the stale cursor');
  });
});

// ─── Failure shape #2 — an escalation reopening (20260912040000's real
// reopened_at/status lifecycle) — the SECOND gap, distinct from #1, found
// on review of the first draft of this design ───────────────────────────
asyncTest('significance-pass driver — resumable cursor: an escalation reopening BEHIND the saved cursor is caught, and the newly-eligible conversation IS found on the very next run — the second gap found on review of the first draft of this design, with screening_result never changing at all', async () => {
  const state = {
    clearBranch: [
      { id: 'id-1', mailbox_key: 'mb1', missive_conversation_id: 'conv-1', delivered_at: '2026-01-01T00:00:00.000Z', screening_completed_at: RESUMABLE_CURSOR_OLD_TS },
      { id: 'id-2', mailbox_key: 'mb1', missive_conversation_id: 'conv-2', delivered_at: '2026-01-01T00:00:00.000Z', screening_completed_at: RESUMABLE_CURSOR_OLD_TS },
    ],
    significance: [],
    escalations: [
      { mailbox_key: 'mb1', missive_conversation_id: 'conv-1', status: 'confirmed', reopened_at: null }, // status='confirmed' with reopened_at IS NULL still excludes, per 20260912040000 — conv-1 stays hidden until reopened.
    ],
    cursors: [],
  };
  const { client: fakeClient, calls } = makeResumableCursorFakeClient(state);

  await withFakeSupabaseClient(fakeClient, '../lib/significance-pass', async (freshSignificancePass) => {
    const run1 = await freshSignificancePass.fetchNextEligibleConversations(10);
    assert.deepStrictEqual(run1, [{ mailbox_key: 'mb1', missive_conversation_id: 'conv-2' }], 'run 1: expected conv-1 excluded (active escalation) and conv-2 found — both rows are already screening_result=\'clear\' the whole time in this test');

    // Between runs: a human reopens the confirmed escalation (20260912040000's real reversal path) — conv-1 becomes newly eligible with NO change to screening_result, and its id (id-1) sits BEHIND the saved cursor ('id-2').
    state.escalations[0].reopened_at = '2026-03-01T00:00:00.000Z';

    const run2 = await freshSignificancePass.fetchNextEligibleConversations(10);
    assert.ok(run2.some((p) => p.missive_conversation_id === 'conv-1'), 'expected conv-1 to be found on run 2 — a cursor design that only watches screening_result (Gap 1 alone) would fast-forward past id-2 since it never changed, and would never reconsider conv-1 at all');
    assert.strictEqual(calls.clearBranchPageCursors[calls.clearBranchPageCursors.length - 1], null, 'expected run 2 to fall back to a full walk from null — the escalation-exclusion digest must have detected the reopening even though the clear-branch digest alone would have matched');
  });
});

// ─── Failure shape #3 — mid-page targetCount stop (TARS repro, found live
// while testing this same PART 20 driver): a saved cursor is worthless if
// the value persisted under it is wrong in the first place. Distinct from
// the two failure shapes above (both about whether a STALE cursor is
// correctly distrusted) — this one is about whether a cursor persisted from
// a run that stopped PARTWAY THROUGH a page (hit targetCount before reaching
// the page's own end) points at the right place at all. Before this fix,
// fetchNextEligibleConversations() persisted the RAW page's last row id
// (captured before the per-pair loop ever ran) regardless of where the
// early-exit actually happened — so a 500-row page with targetCount=3 would
// persist a cursor at row 500 after returning only 3, and the very next run
// would fast-forward straight past the other 497 genuinely eligible,
// never-processed conversations in that same page, forever. ────────────────
asyncTest('significance-pass driver — resumable cursor: hitting targetCount PARTWAY THROUGH a single page persists a cursor at the LAST row actually examined, not the page boundary — the next run finds the rest of that same page instead of silently, permanently skipping it (TARS repro)', async () => {
  const PAGE_SIZE = 500;
  const clearBranch = [];
  for (let i = 0; i < PAGE_SIZE; i++) {
    const n = String(i).padStart(4, '0');
    clearBranch.push({
      id: `id-${n}`,
      mailbox_key: 'mb1',
      missive_conversation_id: `conv-${n}`,
      delivered_at: '2026-01-01T00:00:00.000Z',
      screening_completed_at: RESUMABLE_CURSOR_OLD_TS,
    });
  }
  const state = { clearBranch, significance: [], escalations: [], cursors: [] };
  const { client: fakeClient, calls } = makeResumableCursorFakeClient(state);

  await withFakeSupabaseClient(fakeClient, '../lib/significance-pass', async (freshSignificancePass) => {
    const targetCount = 3;
    const run1 = await freshSignificancePass.fetchNextEligibleConversations(targetCount);
    assert.strictEqual(run1.length, targetCount, 'run 1: expected exactly targetCount conversations, stopping mid-page (500 eligible were available)');
    assert.strictEqual(state.cursors.length, 1, 'expected run 1 to persist exactly one cursor row for this scope');

    const persistedCursorId = state.cursors[0].cursor_id;
    const lastRealIdInPage = clearBranch[clearBranch.length - 1].id;
    assert.notStrictEqual(persistedCursorId, lastRealIdInPage, 'bug: cursor was persisted at the full page boundary even though only 3 of 500 eligible conversations in that page were ever returned — the other 497 were never examined by this run and would be permanently skipped by the next one');

    // Later, real production run resuming with the same scope — nothing in
    // the underlying clear-branch or escalation state has changed, so the
    // saved cursor should verify as safe and be fast-forwarded to.
    const run2 = await freshSignificancePass.fetchNextEligibleConversations(PAGE_SIZE);
    assert.strictEqual(calls.clearBranchPageCursors[calls.clearBranchPageCursors.length - 1], persistedCursorId, 'run 2: expected the fast-forward to actually engage, resuming from the cursor run 1 persisted — proves this is exercising the real resume path, not an accidental full walk');

    const foundSoFar = new Set([...run1, ...run2].map((p) => p.missive_conversation_id));
    const neverFound = clearBranch.map((r) => r.missive_conversation_id).filter((id) => !foundSoFar.has(id));
    assert.strictEqual(run2.length, PAGE_SIZE - targetCount, 'run 2: expected every remaining eligible conversation from run 1\'s page that run 1 itself never returned');
    assert.strictEqual(neverFound.length, 0, `expected no conversations lost across run 1 + run 2, but ${neverFound.length} were never found (first few: ${neverFound.slice(0, 5).join(', ')})`);
  });
});

// ─── driverCursorScopeKey — pure unit tests, no DB. Reads the real
// DRIVER_CURSOR_SCOPE constant out of the source (same technique as
// DRIVER_PAGE_SIZE_FOR_TEST above) so this test tracks a real rename of
// that constant rather than silently going stale against a hardcoded
// duplicate ────────────────────────────────────────────────────────────
const DRIVER_CURSOR_SCOPE_FOR_TEST = (() => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'significance-pass.js'), 'utf8');
  const m = source.match(/const DRIVER_CURSOR_SCOPE = '([^']+)';/);
  if (!m) throw new Error('significance-pass.js: could not find "const DRIVER_CURSOR_SCOPE = \'...\';" — update this test if that constant was renamed.');
  return m[1];
})();

test('driverCursorScopeKey — folds a real sinceDate into the scope key', () => {
  assert.strictEqual(significancePass.driverCursorScopeKey('2025-09-17'), `${DRIVER_CURSOR_SCOPE_FOR_TEST}::sinceDate=2025-09-17`);
});

test('driverCursorScopeKey — null and undefined both map to the SAME explicit "none" token, not the literal strings "null"/"undefined"', () => {
  assert.strictEqual(significancePass.driverCursorScopeKey(null), significancePass.driverCursorScopeKey(undefined));
  assert.strictEqual(significancePass.driverCursorScopeKey(null), `${DRIVER_CURSOR_SCOPE_FOR_TEST}::sinceDate=none`);
});

test('driverCursorScopeKey — two different real sinceDate values produce two different keys', () => {
  assert.notStrictEqual(significancePass.driverCursorScopeKey('2025-01-01'), significancePass.driverCursorScopeKey('2025-09-17'));
});

test('driverCursorScopeKey — a real sinceDate and the no-cutoff default produce different keys — a run must never accidentally share a cursor across the two', () => {
  assert.notStrictEqual(significancePass.driverCursorScopeKey('2025-09-17'), significancePass.driverCursorScopeKey(null));
});

// ─── Failure shape #3 — a LATER call reusing this driver with a DIFFERENT
// (wider) sinceDate than the run that established the saved cursor. The
// third gap, found on a later review pass: neither digest says anything
// about date scope, and Peter's own real staged-by-recency backfill plan
// (last 1 year first, then widen) is exactly this trigger condition, not a
// remote hypothetical ────────────────────────────────────────────────────
asyncTest('significance-pass driver — resumable cursor: a later call with a DIFFERENT sinceDate never reuses an earlier call\'s cursor, so a conversation excluded by the OLDER, stricter window is still found once a looser window actually asks for it — and a repeated, UNCHANGED sinceDate still gets the fast-forward, so this fix does not cost the existing optimization', async () => {
  const STRICT_CUTOFF = '2025-01-01T00:00:00.000Z';
  const state = {
    clearBranch: [
      { id: 'id-1', mailbox_key: 'mb1', missive_conversation_id: 'conv-old', delivered_at: '2020-01-01T00:00:00.000Z', screening_completed_at: RESUMABLE_CURSOR_OLD_TS }, // fails STRICT_CUTOFF; would pass no cutoff at all.
      { id: 'id-2', mailbox_key: 'mb1', missive_conversation_id: 'conv-recent', delivered_at: '2026-06-01T00:00:00.000Z', screening_completed_at: RESUMABLE_CURSOR_OLD_TS }, // passes STRICT_CUTOFF.
    ],
    significance: [], escalations: [], cursors: [],
  };
  const { client: fakeClient, calls } = makeResumableCursorFakeClient(state);

  await withFakeSupabaseClient(fakeClient, '../lib/significance-pass', async (freshSignificancePass) => {
    const run1 = await freshSignificancePass.fetchNextEligibleConversations(10, STRICT_CUTOFF);
    assert.deepStrictEqual(run1, [{ mailbox_key: 'mb1', missive_conversation_id: 'conv-recent' }], 'run 1 (strict cutoff): expected only conv-recent — conv-old correctly excluded by the date filter itself, nothing cursor-related yet');

    // A second call with the SAME sinceDate must still get the fast-forward — this fix must not cost the existing optimization for the ordinary, unchanged-sinceDate case (an ongoing live loop, or a single backfill stage calling repeatedly with the same cutoff).
    const run1b = await freshSignificancePass.fetchNextEligibleConversations(10, STRICT_CUTOFF);
    assert.deepStrictEqual(run1b, [], 'run 1b (same strict cutoff, nothing changed): expected nothing new');
    assert.strictEqual(calls.clearBranchPageCursors[calls.clearBranchPageCursors.length - 1], 'id-2', 'run 1b: expected the fast-forward to still engage for a repeated, unchanged sinceDate');

    // Now: a LATER call shares the same underlying driver but asks with a WIDER window (no cutoff at all) — Peter's own real staged-backfill plan (last 1 year first, then widen).
    const run2 = await freshSignificancePass.fetchNextEligibleConversations(10, null);
    assert.ok(run2.some((p) => p.missive_conversation_id === 'conv-old'), 'expected conv-old to be found once a looser sinceDate actually asks for it — reusing run 1\'s cursor (established under the stricter window) would silently and permanently skip it, since it would never be re-fetched at all');
    assert.strictEqual(calls.clearBranchPageCursors[calls.clearBranchPageCursors.length - 1], null, 'expected the different-sinceDate run to fall back to a full walk from null — it must not find (or trust) a cursor saved under a different sinceDate scope');
    assert.strictEqual(state.cursors.length, 2, 'expected TWO independent saved cursor rows to now exist — one per distinct sinceDate scope, neither overwriting the other');
  });
});

// ─── Failure shape #4 (TARS repro, migration 20260920020000) — the ORIGINAL
// mid-run race this whole migration exists to fix: a low-id 'clear' row
// appears BETWEEN two page fetches of the SAME run (not between two
// separate runs, unlike Failure shapes #1-#3 above), landing behind this
// run's own advancing cursor before persistDriverCursor() ever runs. Forced
// onto a real second page via the DRIVER_PAGE_SIZE_FOR_TEST filler
// technique (see the sinceDate pagination test, above the "Escalation
// exclusion" PART). Uses makeResumableCursorFakeClient's new
// state.onClearBranchPageFetched hook (added for this repro) to inject the
// race row the instant page 1's own snapshot has already been read — i.e.
// too late for THIS run's own pagination to ever see it, exactly modeling
// "became clear mid-run."
//
// Without Fix #2 (floor/asOf), the digest computed at persist time is
// captured live, AFTER the race row already exists in the table — so it
// gets silently baked into the persisted digest despite never having been
// scanned by this run's own fetchDriverPage() calls. The very next run's
// verification would then find that "baked-in" digest still matches a
// fresh, live recheck (nothing has changed since persist), wrongly trust
// the cursor, and permanently skip the race row. WITH the fix: on a
// genuine first-ever run, floor is null, so the WHERE clause degenerates to
// a plain global time-bound (migration 20260920020000's own header) — the
// race row's screening_completed_at lands strictly AFTER this run's own
// run_started_at, so it is excluded from what gets persisted, the next
// run's verification catches the resulting drift, falls back to a full
// walk, and actually finds it. ──────────────────────────────────────────
asyncTest('significance-pass driver — resumable cursor: a low-id \'clear\' row injected BETWEEN two pages of the SAME first-ever (null-cursor) run is excluded from what gets persisted, so the next run\'s verification catches the drift and still finds it — the original mid-run race this whole migration chain exists to fix', async () => {
  const fillerCount = DRIVER_PAGE_SIZE_FOR_TEST; // exactly one full page, forcing a real page 2 — same technique as the sinceDate pagination test above.
  const fillerRows = [];
  for (let i = 0; i < fillerCount; i++) {
    fillerRows.push({
      id: `filler-${String(i).padStart(6, '0')}`, // sorts before 'zz-real' below under plain ascending id order.
      mailbox_key: 'mb1',
      missive_conversation_id: `conv-filler-${i}`,
      delivered_at: '2026-01-01T00:00:00.000Z',
      screening_completed_at: RESUMABLE_CURSOR_OLD_TS,
    });
  }
  const realRow = {
    id: 'zz-real', mailbox_key: 'mb1', missive_conversation_id: 'conv-real', delivered_at: '2026-01-01T00:00:00.000Z', screening_completed_at: RESUMABLE_CURSOR_OLD_TS,
  };
  const state = { clearBranch: [...fillerRows, realRow], significance: [], escalations: [], cursors: [] };
  const { client: fakeClient, calls } = makeResumableCursorFakeClient(state);

  // The race: injected the instant page 1's own snapshot has already been
  // read, landing at an id ('0-race-row') that sorts BEFORE every filler
  // row — behind this run's own advancing cursor, so this run's own page 2
  // fetch (id > the last filler's id) can never see it. screening_completed_at
  // is set safely in the FUTURE relative to whatever run_started_at this
  // real run captures (captured before the page loop even starts),
  // modeling "became clear mid-run, after this run had already started."
  let injected = false;
  state.onClearBranchPageFetched = (cursorUsed) => {
    if (cursorUsed === null && !injected) { // fires once, right after page 1 (the null-cursor fetch) is read
      injected = true;
      state.clearBranch.push({
        id: '0-race-row', mailbox_key: 'mb1', missive_conversation_id: 'conv-race', delivered_at: '2026-01-01T00:00:00.000Z',
        screening_completed_at: new Date(Date.now() + 60000).toISOString(), // 1 minute in the future — guaranteed after run_started_at regardless of clock resolution.
      });
    }
  };

  await withFakeSupabaseClient(fakeClient, '../lib/significance-pass', async (freshSignificancePass) => {
    const run1 = await freshSignificancePass.fetchNextEligibleConversations(fillerCount + 1000);
    assert.strictEqual(run1.length, fillerCount + 1, 'run 1: expected every filler plus the one real row — nothing else yet');
    assert.ok(!run1.some((p) => p.missive_conversation_id === 'conv-race'), 'run 1: conv-race was injected AFTER page 1 already advanced past it — this run\'s own pagination must never see it (models the real race: it appeared too late for this run\'s own scan)');

    const cursorsBeforeRun2 = calls.clearBranchPageCursors.length;
    const run2 = await freshSignificancePass.fetchNextEligibleConversations(10);
    assert.strictEqual(calls.clearBranchPageCursors[cursorsBeforeRun2], null, 'run 2: expected the drift to be caught — a full walk from null, not a fast-forward trusting a cursor that silently baked the race row in');
    assert.ok(run2.some((p) => p.missive_conversation_id === 'conv-race'), 'run 2: expected conv-race to be found — the original mid-run race this whole migration chain exists to fix (a low-id row landing between two pages of the SAME null-cursor run, before persist ever runs)');
  });
});

// ─── Failure shape #5 (TARS repro, migration 20260920020000) — Neo's
// specific follow-up: the shape Failure shape #4 above does NOT cover. #4's
// race row lands behind a null floor on a first-ever run. This one injects
// a low-id 'clear' row into a genuine FAST-FORWARD run's own NEW-TERRITORY
// delta — between the floor it resumed from and the new cursor it ends on
// — which is the exact case migration 20260920020000's floor/as_of
// scoping was built for (its established_floor_id/as_of parameters would
// be no-ops if every race row always landed behind an existing floor).
//
// Run 1 establishes a real floor at 'id-2'. Run 2 is a genuine fast-forward
// (floor='id-2'): it legitimately finds one real new row (conv-5, id-5,
// already screened long before run 2 starts). The race row (conv-race,
// id-3) sorts BETWEEN the floor and that new cursor, but is injected via
// the hook only after run 2's own single page fetch has already resolved —
// too late for run 2's own scan to see it, with a screening_completed_at
// strictly after run 2's own run_started_at. Without the floor/asOf fix, a
// naive unscoped digest computed at persist time (i.e. after the race
// already happened) would already include the race row, matching a fresh
// recheck perfectly and permanently hiding it. With the fix, the race row
// is neither old territory (id-3 > floor id-2) nor screened before run 2
// started, so persistDriverCursor() correctly excludes it — the next run's
// verification catches the drift and finds it on a full walk. ───────────
asyncTest('significance-pass driver — resumable cursor: a low-id \'clear\' row injected into a FAST-FORWARD run\'s own NEW-TERRITORY delta (between its floor and its new cursor) is excluded from what gets persisted, so the next run\'s verification catches the drift and still finds it — the exact case Neo\'s floor-scoping fix (migration 20260920020000) targets, distinct from the null-cursor case above', async () => {
  const state = {
    clearBranch: [
      { id: 'id-1', mailbox_key: 'mb1', missive_conversation_id: 'conv-1', delivered_at: '2026-01-01T00:00:00.000Z', screening_completed_at: RESUMABLE_CURSOR_OLD_TS },
      { id: 'id-2', mailbox_key: 'mb1', missive_conversation_id: 'conv-2', delivered_at: '2026-01-01T00:00:00.000Z', screening_completed_at: RESUMABLE_CURSOR_OLD_TS },
    ],
    significance: [], escalations: [], cursors: [],
  };
  const { client: fakeClient, calls } = makeResumableCursorFakeClient(state);

  await withFakeSupabaseClient(fakeClient, '../lib/significance-pass', async (freshSignificancePass) => {
    // Run 1 — establishes a real, trusted floor at 'id-2'.
    const run1 = await freshSignificancePass.fetchNextEligibleConversations(10);
    assert.deepStrictEqual(run1.map((p) => p.missive_conversation_id).sort(), ['conv-1', 'conv-2']);
    assert.strictEqual(calls.clearBranchPageCursors[0], null, 'run 1: no saved cursor yet');

    // Run 2 — a genuine fast-forward (floor='id-2'). Seed the one REAL
    // new-territory row it should legitimately find (conv-5, id-5, already
    // screened well before this run starts). The race row (conv-race,
    // id-3 — deliberately between the floor and id-5) is injected via the
    // hook the instant run 2's own (one and only) page fetch has already
    // been read.
    state.clearBranch.push({ id: 'id-5', mailbox_key: 'mb1', missive_conversation_id: 'conv-5', delivered_at: '2026-01-01T00:00:00.000Z', screening_completed_at: RESUMABLE_CURSOR_OLD_TS });
    let injected = false;
    state.onClearBranchPageFetched = (cursorUsed) => {
      if (cursorUsed === 'id-2' && !injected) {
        injected = true;
        state.clearBranch.push({
          id: 'id-3', mailbox_key: 'mb1', missive_conversation_id: 'conv-race', delivered_at: '2026-01-01T00:00:00.000Z',
          screening_completed_at: new Date(Date.now() + 60000).toISOString(), // future relative to run 2's own run_started_at
        });
      }
    };

    const cursorsBeforeRun2 = calls.clearBranchPageCursors.length;
    const run2 = await freshSignificancePass.fetchNextEligibleConversations(10);
    assert.strictEqual(calls.clearBranchPageCursors[cursorsBeforeRun2], 'id-2', 'run 2: expected the fast-forward to actually engage, starting from the floor established by run 1 — this test is meaningless if run 2 doesn\'t genuinely fast-forward');
    assert.deepStrictEqual(run2, [{ mailbox_key: 'mb1', missive_conversation_id: 'conv-5' }], 'run 2: expected only conv-5 to be found by this run\'s OWN scan — conv-race was injected only after run 2\'s one page fetch already resolved, so it must not appear in run 2\'s own result, same as the real race it\'s modeling');

    // Run 3 — the proof. If the fix is working, run 2's persisted digest
    // must have EXCLUDED conv-race (screening_completed_at is after run
    // 2's own run_started_at, and it is NOT old territory — id-3 > floor
    // id-2) — so a fresh, live verification digest (which DOES see
    // conv-race, now sitting in the table) mismatches what was persisted,
    // and run 3 falls back to a full walk that actually finds it. Without
    // the floor/asOf fix, persisting an unscoped digest computed live
    // (i.e. AFTER conv-race already existed) would have matched a fresh
    // recheck perfectly, trusted the cursor, and permanently skipped
    // conv-race.
    const cursorsBeforeRun3 = calls.clearBranchPageCursors.length;
    const run3 = await freshSignificancePass.fetchNextEligibleConversations(10);
    assert.strictEqual(calls.clearBranchPageCursors[cursorsBeforeRun3], null, 'run 3: expected the drift to be caught — a full walk from null, not a fast-forward from run 2\'s cursor');
    assert.ok(run3.some((p) => p.missive_conversation_id === 'conv-race'), 'run 3: expected conv-race to be found — the exact case migration 20260920020000\'s floor-scoping was built for: a low-id clear row landing in a fast-forward run\'s own NEW-TERRITORY delta (between its floor and its new cursor), not merely behind an already-established floor');
  });
});

// ─── PENDING — override-branch exclusion (migration 20260918020000, point
// 4) is intentionally NOT tested here. See lib/significance-pass.js's own
// "PENDING" comment immediately after fetchNextEligibleConversations() for
// the full reasoning: the override branch (archive_search_flagged_
// overrides -> missive_message_intake_search_safe merge) does not exist
// anywhere in this file yet, so there is no override-merge code path to
// apply passesEscalationExclusion() to or write a regression test against.
// passesEscalationExclusion() itself is a plain, generic, exported pure
// function (any row with mailbox_key/missive_conversation_id, any exclusion
// Set) — the four unit tests immediately above already cover the exact
// behavior that branch will need to reuse, verbatim, once it's built. ─────

// ─── Wiring — confirm the plumbing from batch runner -> driver, and from
// the live route -> batch runner, actually passes sinceDate through
// (source-scanned, matching this suite's own established convention for
// wiring checks — see PART 13/14) ────────────────────────────────────────
test('significance-pass — runSignificancePassBatch accepts sinceDate and passes it to fetchNextEligibleConversations (not to fetchIncompleteSignificanceRows, which has no date concept — see that call site\'s own comment)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'significance-pass.js'), 'utf8');
  const start = source.indexOf('async function runSignificancePassBatch');
  assert.ok(start !== -1);
  const end = source.indexOf('\nmodule.exports', start);
  const body = source.slice(start, end);
  assert.ok(body.includes('fetchNextEligibleConversations(remaining, sinceDate)'), 'expected sinceDate to be threaded into the new-conversation fetch');
  assert.ok(body.includes('fetchIncompleteSignificanceRows(limit)'), 'expected the incomplete-row retry fetch to remain untouched by sinceDate (it operates on rows already in scope from an earlier run)');
});

test('router.js — process-significance-pending route reads an optional ?since_date and passes it through to runSignificancePassBatch as sinceDate (source-scanned — this DB/AI-touching route is never invoked in this suite, matching PART 6\'s own restraint)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'router.js'), 'utf8');
  const start = source.indexOf("post('/api/archive-search/process-significance-pending'");
  assert.ok(start !== -1, 'expected the route handler to exist');
  const end = source.indexOf('\n});', start);
  const body = source.slice(start, end);
  assert.ok(body.includes('req.query.since_date'), 'expected the route to read an optional since_date query param');
  assert.ok(body.includes('sinceDate: sinceDateParam'), 'expected the parsed since_date to be passed through to runSignificancePassBatch');
});

// ============================================================
// PART 17b — mapWithConcurrency, added 2026-09-19 alongside the
// buildDispatchEntries() concurrency fix (see that function's own header in
// lib/significance-batch.js for the real timing evidence this fix responds
// to). Pure — touches neither significancePass nor any fake Supabase/
// Anthropic client, so unlike every PART 18/19 test below it is safe as an
// ordinary concurrent asyncTest() rather than needing runSerialCheck()'s
// strict sequencing.
// ============================================================
asyncTest('significance-batch — mapWithConcurrency: bounded concurrency (never exceeds the requested limit), output array stays index-aligned to INPUT order even though completion order is deliberately scrambled, and every item is processed exactly once', async () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const limit = 3;
  let inFlight = 0;
  let maxInFlight = 0;
  const callCounts = new Map();

  const results = await significanceBatch.mapWithConcurrency(items, limit, async (item) => {
    callCounts.set(item, (callCounts.get(item) || 0) + 1);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // Deliberately INVERTED delays — item 0 (first in input order) finishes
    // LAST, item 9 (last in input order) finishes FIRST. A naive "push to
    // the output array as each promise resolves" implementation would get
    // the output order backwards; index-based assignment must not.
    await new Promise((resolve) => setTimeout(resolve, (items.length - item) * 4));
    inFlight--;
    return item * 10;
  });

  assert.deepStrictEqual(results, items.map((i) => i * 10), 'expected the output array in the same order as the input array, not completion order');
  assert.ok(maxInFlight <= limit, `expected concurrency to never exceed the requested limit of ${limit}, but saw ${maxInFlight} in flight at once`);
  assert.ok(maxInFlight > 1, 'expected genuine concurrency (more than 1 call in flight at some point) — a maxInFlight of 1 would mean this silently regressed to sequential execution');
  for (const item of items) {
    assert.strictEqual(callCounts.get(item), 1, `expected item ${item} to be processed exactly once, was processed ${callCounts.get(item) || 0} times`);
  }
});

asyncTest('significance-batch — mapWithConcurrency: an empty items array resolves to an empty array without spawning any workers', async () => {
  let called = false;
  const results = await significanceBatch.mapWithConcurrency([], 5, async () => { called = true; });
  assert.deepStrictEqual(results, []);
  assert.strictEqual(called, false, 'expected asyncFn to never be called for an empty input');
});

asyncTest('significance-batch — mapWithConcurrency: fewer items than the concurrency limit still processes every item exactly once (worker count is capped to items.length, not a fixed limit)', async () => {
  const items = ['a', 'b'];
  const results = await significanceBatch.mapWithConcurrency(items, 10, async (item) => item.toUpperCase());
  assert.deepStrictEqual(results, ['A', 'B']);
});

// ============================================================
// PART 18 — lib/significance-batch.js + run-significance-batch.js (the
// Message Batches API "bulk method" build, 2026-09-17). All mocked — zero
// real Supabase or Anthropic calls anywhere below.
//
// TWO testing strategies, chosen per test by how much of the real
// synchronous pipeline it actually needs to exercise:
//   (a) MOST tests monkey-patch specific significance-pass.js EXPORTS in
//       place, on the SAME cached module object significance-batch.js's own
//       require('./significance-pass') resolves to (`significancePass`,
//       already declared above at PART 13). This both isolates
//       significance-batch.js's own orchestration logic from the real
//       pipeline's DB/AI calls, AND directly proves reuse: if significance-
//       batch.js ever stopped calling one of these and reimplemented its
//       logic inline instead, the spy would simply never fire and the
//       assertion on its call count would fail.
//   (b) ONE end-to-end test (18h) additionally uses lib/significance-pass.js's
//       OWN _setSupabaseClientForTesting() (a small DI seam added to that
//       file alongside this build, for exactly this test) so the REAL,
//       un-spied applyCall1Result() runs and genuinely upserts into
//       missive_conversation_significance against a fake table — proving
//       "do not reimplement the database write" isn't just a naming
//       coincidence.
//
// NEITHER strategy touches require.cache — a REAL, demonstrated hazard
// found and fixed while building this suite, not a theoretical one, worth
// recording so it isn't reintroduced later: lib/significance-pass.js's own
// EXISTING tests (PART 15-17) fake its Supabase client via a require.cache
// swap-and-force-refresh trick, which is safe there because every one of
// those tests only ever touches a module it force-refreshes itself. This
// build's lib/significance-batch.js additionally REQUIRES lib/significance-
// pass.js as a dependency — the first time anything in this suite has two
// separate library modules under test that share a common dependency both
// sides fake. Force-refreshing significance-batch.js the same way (delete
// its require.cache entry, re-require it) transitively forces its own
// `require('./significance-pass')` to resolve fresh too — and since
// asyncTest() runs every registered async test CONCURRENTLY (each fn() is
// invoked immediately at registration time; main() only awaits them all at
// the very end — verified by reading asyncTest()/main() above, not
// assumed), that fresh resolution can land at a moment when a WHOLLY
// UNRELATED, concurrently-running PART 15-17 test has ITS OWN fake
// temporarily sitting in that exact same require.cache slot (require.cache
// is global, shared, mutable state) — binding significance-batch.js to the
// WRONG test's fixture data. This was not a hypothetical: an earlier
// version of this PART did exactly that, and it manifested as significance-
// batch.js's own submitBatch() silently pulling conversation ids like
// "conv-old-but-recently-active" and "conv-interrupted-run-test" out of
// PART 15's and PART 17's own fake data, confirmed by adding a temporary
// console.error inside buildCall1BatchRequests() and re-running the full
// suite. The fix: lib/significance-batch.js (and, for test 18h only, lib/
// significance-pass.js too) instead expose plain, settable, TEST-ONLY
// module-level references (_setSupabaseClientForTesting /
// _setAnthropicClientForTesting — see each file's own comment on them) that
// mutate the ONE already-loaded copy of each module directly. Nothing here
// is ever re-required, so nothing here can be affected by what any other
// concurrently-running test does to require.cache.
//
// Strategy (a)'s spyOn() below has its OWN, separate hazard under the same
// concurrency model: it mutates method PROPERTIES on one shared, long-lived
// object that significance-batch.js reads AT CALL TIME on every invocation,
// not just at module-evaluation time — two of THIS PART's OWN tests both
// patching (or one patching while another restores) the same property
// would race for real. runSerialCheck()/the single IIFE below close that
// gap by running every PART 18 scenario in a strict, awaited sequence
// inside ONE async function (still reported individually, by name, in the
// normal PASS/FAIL list — runSerialCheck() pushes straight into the same
// `results` array test()/asyncTest() already share). A single real
// `for`-of-`await` sequence has no gap: scenario N+1 cannot even begin
// constructing its own fakes until scenario N's `await` has fully returned.
// ============================================================
// significanceBatch itself is required much earlier in this file (right
// after significancePass, near PART 13) — see that require site's own
// comment for why load order matters here.
const runSignificanceBatchCli = require('../run-significance-batch');

async function runSerialCheck(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (err) {
    results.push({ name, pass: false, error: err.message });
  }
}

function spyOn(obj, methodName, impl) {
  const original = obj[methodName];
  const calls = [];
  obj[methodName] = (...args) => { calls.push(args); return impl(...args); };
  return { calls, restore: () => { obj[methodName] = original; } };
}

function makeFakeAnthropicBatchesClient({ create, retrieve, results } = {}) {
  const calls = { create: [], retrieve: [], results: [] };
  return {
    client: {
      beta: { messages: { batches: {
        create: async (...args) => { calls.create.push(args); if (!create) throw new Error('unexpected batches.create() call'); return create(...args); },
        retrieve: async (...args) => { calls.retrieve.push(args); if (!retrieve) throw new Error('unexpected batches.retrieve() call'); return retrieve(...args); },
        results: async (...args) => { calls.results.push(args); if (!results) throw new Error('unexpected batches.results() call'); return results(...args); },
      } } },
    },
    calls,
  };
}

function asyncIterableFromArray(arr) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return { next: () => (i < arr.length ? Promise.resolve({ value: arr[i++], done: false }) : Promise.resolve({ value: undefined, done: true })) };
    },
  };
}

function matchesFilters(row, filters) {
  return filters.every((f) => {
    if (f.type === 'eq') return row[f.col] === f.val;
    if (f.type === 'is') return f.val === null ? (row[f.col] === null || row[f.col] === undefined) : row[f.col] === f.val;
    if (f.type === 'gt') return row[f.col] > f.val;
    if (f.type === 'in') return Array.isArray(f.val) && f.val.includes(row[f.col]); // added PART 19 (submission_run_items bulk dispatch update, keyed by .in('id', [...]))
    return true;
  });
}

// A real, stateful, filtering fake covering the two Batches tracking
// tables significance-batch.js's OWN code touches directly, plus (only for
// reportNeedsCall2) a minimal missive_conversation_significance select —
// every OTHER table (missive_message_intake_search_safe, the significance
// upsert used by a real write-back, properties/vendors, message links,
// audit_log) goes through significancePass's own exported functions,
// monkey-patched per-test with spyOn() instead of faked here (PART 18h is
// the one exception, with its own dedicated fake — see that test).
function makeBatchTrackingFakeClient({ batchRow = null, itemRows = [], significanceRows = [] } = {}) {
  const state = { batch: batchRow ? { ...batchRow } : null, items: itemRows.map((r) => ({ ...r })), nextItemId: 1 };
  const calls = { batchInserts: [], batchUpdates: [], itemInserts: [], itemUpdates: [] };

  function batchesChain() {
    const filters = [];
    let op = null, insertRow = null, updateFields = null;
    const chain = {
      select() { op = op || 'select'; return chain; },
      insert(row) { op = 'insert'; insertRow = row; return chain; },
      update(fields) { op = 'update'; updateFields = fields; return chain; },
      eq(col, val) { filters.push({ col, type: 'eq', val }); return chain; },
      is(col, val) { filters.push({ col, type: 'is', val }); return chain; },
      order() { return chain; },
      limit() { return chain; },
      single() {
        if (op === 'insert') {
          const row = { id: `batch-${calls.batchInserts.length + 1}`, completed_at: null, failed_at: null, results_retrieved_at: null, last_checked_at: null, ...insertRow };
          calls.batchInserts.push(insertRow);
          state.batch = row;
          return Promise.resolve({ data: row, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      maybeSingle() {
        if (op === 'select') {
          const match = state.batch && matchesFilters(state.batch, filters) ? state.batch : null;
          return Promise.resolve({ data: match, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve, reject) {
        let result = { data: null, error: null };
        if (op === 'update') {
          calls.batchUpdates.push({ ...updateFields });
          if (state.batch) Object.assign(state.batch, updateFields);
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }

  function itemsChain() {
    const filters = [];
    let op = null, insertRows = null, updateFields = null, orderCol = null, limitN = null, countMode = false;
    const chain = {
      select(cols, opts) { op = op || 'select'; if (opts && opts.count) countMode = true; return chain; },
      insert(rows) { op = 'insert'; insertRows = Array.isArray(rows) ? rows : [rows]; return chain; },
      update(fields) { op = 'update'; updateFields = fields; return chain; },
      eq(col, val) { filters.push({ col, type: 'eq', val }); return chain; },
      is(col, val) { filters.push({ col, type: 'is', val }); return chain; },
      gt(col, val) { filters.push({ col, type: 'gt', val }); return chain; },
      order(col) { orderCol = col; return chain; },
      limit(n) { limitN = n; return chain; },
      then(resolve, reject) {
        let result;
        if (op === 'insert') {
          const inserted = insertRows.map((r) => {
            const row = { id: `item-${String(state.nextItemId++).padStart(6, '0')}`, result_status: 'pending', error_detail: null, written_back_at: null, ...r };
            state.items.push(row);
            return row;
          });
          calls.itemInserts.push(...insertRows);
          result = { data: inserted, error: null };
        } else if (op === 'update') {
          const matching = state.items.filter((it) => matchesFilters(it, filters));
          matching.forEach((it) => { calls.itemUpdates.push({ id: it.id, fields: { ...updateFields } }); Object.assign(it, updateFields); });
          result = { data: null, error: null };
        } else if (op === 'select') {
          let matching = state.items.filter((it) => matchesFilters(it, filters));
          if (orderCol) matching = [...matching].sort((a, b) => (a[orderCol] > b[orderCol] ? 1 : a[orderCol] < b[orderCol] ? -1 : 0));
          if (countMode) result = { data: null, error: null, count: matching.length };
          else result = { data: limitN != null ? matching.slice(0, limitN) : matching, error: null };
        } else {
          result = { data: null, error: null };
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }

  function significanceChain() {
    let inVals = null;
    const chain = {
      select() { return chain; },
      in(col, vals) { inVals = vals; return chain; },
      then(resolve, reject) {
        const matching = significanceRows.filter((r) => inVals.includes(r.missive_conversation_id));
        return Promise.resolve({ data: matching, error: null }).then(resolve, reject);
      },
    };
    return chain;
  }

  return {
    client: {
      from(table) {
        if (table === 'archive_search_significance_batches') return batchesChain();
        if (table === 'archive_search_significance_batch_items') return itemsChain();
        if (table === 'missive_conversation_significance') return significanceChain();
        throw new Error(`makeBatchTrackingFakeClient: unexpected table "${table}" — this fake only serves the Batches tracking tables (everything else should go through a monkey-patched significance-pass.js export).`);
      },
    },
    state,
    calls,
  };
}

// ============================================================
// makeRunTrackingFakeClient — added for PART 19 (the submission-run
// redesign, 2026-09-18). Covers the two NEW tables (archive_search_
// significance_submission_runs / _run_items) plus the two EXISTING Batches
// tracking tables (archive_search_significance_batches / _batch_items, same
// shape as makeBatchTrackingFakeClient's own batchesChain/itemsChain above —
// deliberately not re-derived, copied verbatim, so checkAndResumeOneBatch/
// writeBackBatch/maybeMarkBatchCompleted/insertBatchItems — all UNCHANGED
// production code — work identically against this fake as they already do
// against makeBatchTrackingFakeClient in PART 18) and a minimal missive_
// conversation_significance select (for reportNeedsCall2, reused unchanged
// by run-scoped call sites in the CLI).
// ============================================================
function makeRunTrackingFakeClient({ runRow = null, runItemRows = [], batchRows = [], batchItemRows = [], significanceRows = [], historicalReviewRows = [] } = {}) {
  const state = {
    run: runRow ? { ...runRow } : null,
    runItems: runItemRows.map((r) => ({ ...r })),
    batches: batchRows.map((r) => ({ ...r })),
    batchItems: batchItemRows.map((r) => ({ ...r })),
  };
  let nextRunItemId = 1;
  let nextBatchId = 1;
  let nextBatchItemId = 1;
  const calls = {
    runInserts: [], runUpdates: [],
    runItemInserts: [], runItemUpdates: [],
    batchInserts: [], batchUpdates: [],
    batchItemInserts: [], batchItemUpdates: [],
  };

  function runsChain() {
    const filters = [];
    let op = null, insertRow = null, updateFields = null;
    const chain = {
      select() { op = op || 'select'; return chain; },
      insert(row) { op = 'insert'; insertRow = row; return chain; },
      update(fields) { op = 'update'; updateFields = fields; return chain; },
      eq(col, val) { filters.push({ col, type: 'eq', val }); return chain; },
      is(col, val) { filters.push({ col, type: 'is', val }); return chain; },
      order() { return chain; },
      limit() { return chain; },
      maybeSingle() {
        const match = state.run && matchesFilters(state.run, filters) ? state.run : null;
        return Promise.resolve({ data: match, error: null });
      },
      single() {
        if (op === 'insert') {
          const row = {
            id: `run-${calls.runInserts.length + 1}`,
            assembled_at: null, eligible_count: null, fully_processed_at: null, failed_at: null, failure_reason: null, notes: null,
            ...insertRow,
          };
          calls.runInserts.push({ ...insertRow });
          state.run = row;
          return Promise.resolve({ data: { ...row }, error: null });
        }
        if (op === 'update') {
          calls.runUpdates.push({ ...updateFields });
          if (state.run) Object.assign(state.run, updateFields);
          return Promise.resolve({ data: state.run ? { ...state.run } : null, error: null });
        }
        const match = state.run && matchesFilters(state.run, filters) ? state.run : null;
        return Promise.resolve({ data: match, error: null });
      },
      then(resolve, reject) {
        let result = { data: null, error: null };
        if (op === 'update' && state.run && matchesFilters(state.run, filters)) {
          calls.runUpdates.push({ ...updateFields });
          Object.assign(state.run, updateFields);
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }

  function runItemsChain() {
    const filters = [];
    let op = null, insertRows = null, updateFields = null, orderCol = null, orderAsc = true, limitN = null;
    const chain = {
      select() { op = op || 'select'; return chain; },
      insert(rows) { op = 'insert'; insertRows = Array.isArray(rows) ? rows : [rows]; return chain; },
      update(fields) { op = 'update'; updateFields = fields; return chain; },
      eq(col, val) { filters.push({ col, type: 'eq', val }); return chain; },
      is(col, val) { filters.push({ col, type: 'is', val }); return chain; },
      gt(col, val) { filters.push({ col, type: 'gt', val }); return chain; },
      in(col, vals) { filters.push({ col, type: 'in', val: vals }); return chain; },
      order(col, opts) { orderCol = col; orderAsc = !(opts && opts.ascending === false); return chain; },
      limit(n) { limitN = n; return chain; },
      then(resolve, reject) {
        let result;
        if (op === 'insert') {
          const inserted = insertRows.map((r) => {
            const row = { id: `runitem-${String(nextRunItemId++).padStart(6, '0')}`, chunk_number: null, batch_id: null, dispatched_at: null, ...r };
            state.runItems.push(row);
            return row;
          });
          calls.runItemInserts.push(...insertRows);
          result = { data: inserted, error: null };
        } else if (op === 'update') {
          const matching = state.runItems.filter((it) => matchesFilters(it, filters));
          matching.forEach((it) => { calls.runItemUpdates.push({ id: it.id, fields: { ...updateFields } }); Object.assign(it, updateFields); });
          result = { data: null, error: null };
        } else {
          let matching = state.runItems.filter((it) => matchesFilters(it, filters));
          if (orderCol) {
            matching = [...matching].sort((a, b) => {
              const av = a[orderCol], bv = b[orderCol];
              if (av === bv) return 0;
              return orderAsc ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
            });
          }
          if (limitN != null) matching = matching.slice(0, limitN);
          result = { data: matching, error: null };
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }

  // Same shape as makeBatchTrackingFakeClient's own batchesChain() above,
  // extended with plain multi-row select (via then(), no .maybeSingle())
  // and order/limit — needed for fetchNextChunkNumberForRun's MAX(chunk_
  // number) lookup and checkAndResumeRun's "every batch for this run" scan,
  // neither of which the single-batch-per-stage PART 18 tests ever needed.
  function batchesChain() {
    const filters = [];
    let op = null, insertRow = null, updateFields = null, orderCol = null, orderAsc = true, limitN = null;
    const chain = {
      select() { op = op || 'select'; return chain; },
      insert(row) { op = 'insert'; insertRow = row; return chain; },
      update(fields) { op = 'update'; updateFields = fields; return chain; },
      eq(col, val) { filters.push({ col, type: 'eq', val }); return chain; },
      is(col, val) { filters.push({ col, type: 'is', val }); return chain; },
      order(col, opts) { orderCol = col; orderAsc = !(opts && opts.ascending === false); return chain; },
      limit(n) { limitN = n; return chain; },
      maybeSingle() {
        const matching = state.batches.filter((b) => matchesFilters(b, filters));
        return Promise.resolve({ data: matching[0] || null, error: null });
      },
      single() {
        if (op === 'insert') {
          const row = { id: `batch-${nextBatchId++}`, completed_at: null, failed_at: null, results_retrieved_at: null, last_checked_at: null, ...insertRow };
          calls.batchInserts.push({ ...insertRow });
          state.batches.push(row);
          return Promise.resolve({ data: { ...row }, error: null });
        }
        if (op === 'update') {
          const matching = state.batches.filter((b) => matchesFilters(b, filters));
          matching.forEach((b) => { calls.batchUpdates.push({ id: b.id, fields: { ...updateFields } }); Object.assign(b, updateFields); });
          return Promise.resolve({ data: matching[0] ? { ...matching[0] } : null, error: null });
        }
        const matching = state.batches.filter((b) => matchesFilters(b, filters));
        return Promise.resolve({ data: matching[0] || null, error: null });
      },
      then(resolve, reject) {
        let result;
        if (op === 'update') {
          const matching = state.batches.filter((b) => matchesFilters(b, filters));
          matching.forEach((b) => { calls.batchUpdates.push({ id: b.id, fields: { ...updateFields } }); Object.assign(b, updateFields); });
          result = { data: null, error: null };
        } else {
          let matching = state.batches.filter((b) => matchesFilters(b, filters));
          if (orderCol) {
            matching = [...matching].sort((a, b) => {
              const av = a[orderCol], bv = b[orderCol];
              if (av === bv) return 0;
              if (av == null) return orderAsc ? -1 : 1;
              if (bv == null) return orderAsc ? 1 : -1;
              return orderAsc ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
            });
          }
          if (limitN != null) matching = matching.slice(0, limitN);
          result = { data: matching, error: null };
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }

  // Identical shape to makeBatchTrackingFakeClient's own itemsChain() above —
  // copied, not re-derived, so writeBackBatch/maybeMarkBatchCompleted/
  // insertBatchItems/checkAndResumeOneBatch (all UNCHANGED production code)
  // work against this fake exactly as already proven in PART 18.
  function batchItemsChain() {
    const filters = [];
    let op = null, insertRows = null, updateFields = null, orderCol = null, limitN = null, countMode = false;
    const chain = {
      select(cols, opts) { op = op || 'select'; if (opts && opts.count) countMode = true; return chain; },
      insert(rows) { op = 'insert'; insertRows = Array.isArray(rows) ? rows : [rows]; return chain; },
      update(fields) { op = 'update'; updateFields = fields; return chain; },
      eq(col, val) { filters.push({ col, type: 'eq', val }); return chain; },
      is(col, val) { filters.push({ col, type: 'is', val }); return chain; },
      gt(col, val) { filters.push({ col, type: 'gt', val }); return chain; },
      order(col) { orderCol = col; return chain; },
      limit(n) { limitN = n; return chain; },
      then(resolve, reject) {
        let result;
        if (op === 'insert') {
          const inserted = insertRows.map((r) => {
            const row = { id: `batchitem-${String(nextBatchItemId++).padStart(6, '0')}`, result_status: 'pending', error_detail: null, written_back_at: null, ...r };
            state.batchItems.push(row);
            return row;
          });
          calls.batchItemInserts.push(...insertRows);
          result = { data: inserted, error: null };
        } else if (op === 'update') {
          const matching = state.batchItems.filter((it) => matchesFilters(it, filters));
          matching.forEach((it) => { calls.batchItemUpdates.push({ id: it.id, fields: { ...updateFields } }); Object.assign(it, updateFields); });
          result = { data: null, error: null };
        } else if (op === 'select') {
          let matching = state.batchItems.filter((it) => matchesFilters(it, filters));
          if (orderCol) matching = [...matching].sort((a, b) => (a[orderCol] > b[orderCol] ? 1 : a[orderCol] < b[orderCol] ? -1 : 0));
          if (countMode) result = { data: null, error: null, count: matching.length };
          else result = { data: limitN != null ? matching.slice(0, limitN) : matching, error: null };
        } else {
          result = { data: null, error: null };
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }

  function significanceChain() {
    let inVals = null;
    const chain = {
      select() { return chain; },
      in(col, vals) { inVals = vals; return chain; },
      then(resolve, reject) {
        const matching = significanceRows.filter((r) => inVals.includes(r.missive_conversation_id));
        return Promise.resolve({ data: matching, error: null }).then(resolve, reject);
      },
    };
    return chain;
  }

  // Added for computeCall2RunNotificationCounts() (2026-09-29, Asimov's
  // Call 2 batch-completion-notification requirement) — a real, count-only
  // read against the view Asimov found has zero application code touching
  // it anywhere today. Only the one shape that function actually calls,
  // .select('id', { count: 'exact', head: true }) with no filter, is
  // supported — matching how narrowly the other chains here are scoped.
  function historicalReviewRequiredChain() {
    const chain = {
      select() { return chain; },
      then(resolve, reject) {
        return Promise.resolve({ data: null, error: null, count: historicalReviewRows.length }).then(resolve, reject);
      },
    };
    return chain;
  }

  return {
    client: {
      from(table) {
        if (table === 'archive_search_significance_submission_runs') return runsChain();
        if (table === 'archive_search_significance_submission_run_items') return runItemsChain();
        if (table === 'archive_search_significance_batches') return batchesChain();
        if (table === 'archive_search_significance_batch_items') return batchItemsChain();
        if (table === 'missive_conversation_significance') return significanceChain();
        if (table === 'complaints_historical_review_required') return historicalReviewRequiredChain();
        throw new Error(`makeRunTrackingFakeClient: unexpected table "${table}" — this fake covers the submission-run tables plus the Batches tracking tables; everything else should go through a monkey-patched significance-pass.js export.`);
      },
    },
    state,
    calls,
  };
}

// ============================================================
// makeCall2EndToEndFakeClient — added 2026-09-29 for the Call 2 Batches API
// build's own end-to-end write-back tests, same purpose and same "strategy
// (b)" as PART 18h's own dedicated fake (see that test's own comment,
// above, for why a real end-to-end test needs its own fake rather than
// makeBatchTrackingFakeClient/makeRunTrackingFakeClient): it lets the REAL,
// un-spied parseCall2Response/applyCall2Fields/findExistingComplaintFor
// Conversation/createComplaintRow run against a fake Supabase client,
// proving "do not reimplement Call 2's own write path" the same way PART
// 18h already proved it for Call 1's applyCall1Result.
//
// Covers exactly the tables that path touches for a HISTORICAL (never
// live_pipeline) row with no address match — the real, expected shape of
// the ~27,000-conversation backlog this build exists to process — same
// deliberately narrow scope PART 18h's own fake already takes for Call 1:
// archive_search_significance_batch_items (write-back bookkeeping),
// missive_conversation_significance (both the fetchSignificanceRowsForPairs
// select+in lookup AND the final applyCall2Fields update-by-id),
// missive_message_intake_search_safe (buildConversationContext's own
// message fetch), complaints (findExistingComplaintForConversation's
// lookup + createComplaintRow's insert), and audit_log
// (writeAuditLog — createComplaintRow's own 'complaint_tracking.created'
// event). tenants/owners/vendors are deliberately NOT covered: the fixture
// conversationRow's own address fields are all null, so matchParticipant
// sToRecords(supabase, []) short-circuits before ever calling supabase at
// all (subject-match.js: `if (!clean.length) return none;`) — confirmed by
// reading that function, not assumed, before relying on it here.
// ============================================================
function makeCall2EndToEndFakeClient({ itemRows, significanceRows, conversationRow }) {
  const state = {
    items: itemRows.map((r) => ({ ...r })),
    significanceRows: significanceRows.map((r) => ({ ...r })),
    complaintsInserted: [],
  };

  function matchesEq(row, filters) {
    return filters.every((f) => (f.gt ? row[f.col] > f.val : f.isNull ? (row[f.col] === null || row[f.col] === undefined) : row[f.col] === f.val));
  }

  function itemsChain() {
    const filters = [];
    let op = null, updateFields = null, orderCol = null, limitN = null;
    const chain = {
      select() { op = op || 'select'; return chain; },
      update(fields) { op = 'update'; updateFields = fields; return chain; },
      eq(col, val) { filters.push({ col, val }); return chain; },
      is(col, val) { filters.push({ col, val, isNull: val === null }); return chain; },
      gt(col, val) { filters.push({ col, val, gt: true }); return chain; },
      order(col) { orderCol = col; return chain; },
      limit(n) { limitN = n; return chain; },
      then(resolve, reject) {
        let result;
        if (op === 'update') {
          state.items.filter((it) => matchesEq(it, filters)).forEach((it) => Object.assign(it, updateFields));
          result = { data: null, error: null };
        } else {
          let matching = state.items.filter((it) => matchesEq(it, filters));
          if (orderCol) matching = [...matching].sort((a, b) => (a[orderCol] > b[orderCol] ? 1 : a[orderCol] < b[orderCol] ? -1 : 0));
          if (limitN != null) matching = matching.slice(0, limitN);
          result = { data: matching, error: null };
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }

  function significanceChain() {
    let mode = null, inVals = null, updateFields = null;
    const filters = [];
    const chain = {
      select() { mode = mode || 'select'; return chain; },
      in(col, vals) { inVals = vals; return chain; },
      update(fields) { mode = 'update'; updateFields = fields; return chain; },
      eq(col, val) { filters.push({ col, val }); return chain; },
      then(resolve, reject) {
        let result;
        if (mode === 'update') {
          state.significanceRows.filter((r) => matchesEq(r, filters)).forEach((r) => Object.assign(r, updateFields));
          result = { data: null, error: null };
        } else {
          result = { data: state.significanceRows.filter((r) => inVals.includes(r.missive_conversation_id)), error: null };
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }

  function complaintsChain() {
    let op = null, insertRow = null;
    const chain = {
      select() { op = op || 'select'; return chain; },
      insert(row) { op = 'insert'; insertRow = row; return chain; },
      eq() { return chain; },
      order() { return chain; },
      limit() { return chain; },
      // findExistingComplaintForConversation's own lookup — this fake never
      // seeds a pre-existing complaint, so there is always nothing to find.
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      single() {
        if (op === 'insert') {
          const row = { id: `complaint-${state.complaintsInserted.length + 1}`, created_at: new Date().toISOString(), ...insertRow };
          state.complaintsInserted.push(row);
          return Promise.resolve({ data: row, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
    return chain;
  }

  return {
    client: {
      from(table) {
        if (table === 'archive_search_significance_batch_items') return itemsChain();
        if (table === 'missive_conversation_significance') return significanceChain();
        if (table === 'missive_message_intake_search_safe') {
          return { select() { return this; }, eq() { return this; }, order() { return this; }, then(resolve) { return Promise.resolve({ data: [conversationRow], error: null }).then(resolve); } };
        }
        if (table === 'complaints') return complaintsChain();
        if (table === 'audit_log') return { insert: () => Promise.resolve({ data: null, error: null }) };
        throw new Error(`makeCall2EndToEndFakeClient: unexpected table "${table}" — this fake only covers a historical, no-address-match Call 2 write-back (see its own header comment for exactly why that scope is enough).`);
      },
    },
    state,
  };
}

// Uses significance-batch.js's own TEST-ONLY DI seam (_setSupabaseClient
// ForTesting / _setAnthropicClientForTesting — see that file's own header
// comment on those two functions for exactly why they exist instead of the
// require.cache swap-and-force-refresh trick lib/significance-pass.js's
// own test suite uses) rather than touching require.cache at all. Runs
// against the ONE, already-loaded `significanceBatch` module (required
// once, at this PART's own top) for the life of the process — never
// re-required, so it can never accidentally pick up some OTHER,
// concurrently-running test's own fake dependency.
async function withFakeSignificanceBatch({ supabaseClient, anthropicClient: fakeAnthropicClient }, run) {
  significanceBatch._setSupabaseClientForTesting(supabaseClient);
  significanceBatch._setAnthropicClientForTesting(fakeAnthropicClient);
  try {
    await run(significanceBatch);
  } finally {
    significanceBatch._setSupabaseClientForTesting(null);
    significanceBatch._setAnthropicClientForTesting(null);
  }
}

// ─── 18a — pure functions, no mocking (env vars are already the fake
// placeholders this whole file's header sets; createClient() itself makes
// no network call at construction time) ───────────────────────────────────
test('significance-batch — generateToken: matches the real custom_id CHECK regex (^[a-zA-Z0-9_-]{1,64}$)', () => {
  for (let i = 0; i < 25; i++) {
    const token = significanceBatch.generateToken();
    assert.ok(/^[a-zA-Z0-9_-]{1,64}$/.test(token), `expected token "${token}" to match the real custom_id CHECK`);
  }
});

test('significance-batch — generateUniqueTokensForBatch: returns exactly N unique, valid tokens', () => {
  const tokens = significanceBatch.generateUniqueTokensForBatch(500);
  assert.strictEqual(tokens.length, 500);
  assert.strictEqual(new Set(tokens).size, 500, 'expected all 500 tokens to be unique');
  for (const t of tokens) assert.ok(/^[a-zA-Z0-9_-]{1,64}$/.test(t));
});

test('significance-batch — chunkArray: splits into fixed-size chunks, preserving order, including a final short chunk', () => {
  assert.deepStrictEqual(significanceBatch.chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('significance-batch — chunkArray: an empty array produces zero chunks', () => {
  assert.deepStrictEqual(significanceBatch.chunkArray([], 500), []);
});

test('run-significance-batch — parseStageArg: defaults to call_1, accepts call_2, rejects anything else', () => {
  assert.deepStrictEqual(runSignificanceBatchCli.parseStageArg([]), { stage: 'call_1', error: null });
  assert.deepStrictEqual(runSignificanceBatchCli.parseStageArg(['--stage=call_2']), { stage: 'call_2', error: null });
  const bad = runSignificanceBatchCli.parseStageArg(['--stage=call_3']);
  assert.strictEqual(bad.stage, null);
  assert.ok(bad.error);
});

test('run-significance-batch — parseLimitArg: undefined when omitted (submitBatch\'s own 100,000-cap default then applies), a positive integer when given, rejected otherwise', () => {
  assert.deepStrictEqual(runSignificanceBatchCli.parseLimitArg([]), { limit: undefined, error: null });
  assert.deepStrictEqual(runSignificanceBatchCli.parseLimitArg(['--limit=50']), { limit: 50, error: null });
  assert.ok(runSignificanceBatchCli.parseLimitArg(['--limit=0']).error, 'expected 0 to be rejected');
  assert.ok(runSignificanceBatchCli.parseLimitArg(['--limit=abc']).error, 'expected a non-numeric value to be rejected');
});

test('run-significance-batch — parseForceArg: false when omitted, true when --force is present anywhere in the args', () => {
  assert.deepStrictEqual(runSignificanceBatchCli.parseForceArg([]), { force: false });
  assert.deepStrictEqual(runSignificanceBatchCli.parseForceArg(['--stage=call_1']), { force: false });
  assert.deepStrictEqual(runSignificanceBatchCli.parseForceArg(['--force']), { force: true });
  assert.deepStrictEqual(runSignificanceBatchCli.parseForceArg(['--since-date=2025-09-17', '--force']), { force: true });
});

// ADDED 2026-09-29 — parseWatchArgs, the --watch/--poll-interval= CLI
// parsing for the "check-once-per-invocation, no internal poll loop" fix
// (Hermes's ~55-minute detection-lag finding — see run-significance-batch.js's
// own "ADDED 2026-09-29 — --watch" header for the full root-cause story).
// Pure, no I/O — same directly-testable shape as parseStageArg/parseLimitArg/
// parseForceArg above.
test('run-significance-batch — parseWatchArgs: omitted entirely defaults to watch:false with the default poll interval (unused, but present) and no error', () => {
  assert.deepStrictEqual(
    runSignificanceBatchCli.parseWatchArgs([]),
    { watch: false, pollIntervalMinutes: runSignificanceBatchCli.DEFAULT_POLL_INTERVAL_MINUTES, error: null }
  );
});

test('run-significance-batch — parseWatchArgs: --watch alone is accepted and uses the default poll interval', () => {
  assert.deepStrictEqual(
    runSignificanceBatchCli.parseWatchArgs(['--stage=call_1', '--watch']),
    { watch: true, pollIntervalMinutes: runSignificanceBatchCli.DEFAULT_POLL_INTERVAL_MINUTES, error: null }
  );
});

test('run-significance-batch — parseWatchArgs: --watch with --poll-interval=N uses N', () => {
  assert.deepStrictEqual(
    runSignificanceBatchCli.parseWatchArgs(['--watch', '--poll-interval=10']),
    { watch: true, pollIntervalMinutes: 10, error: null }
  );
});

test('run-significance-batch — parseWatchArgs: --poll-interval given WITHOUT --watch is rejected, not silently ignored', () => {
  const result = runSignificanceBatchCli.parseWatchArgs(['--poll-interval=10']);
  assert.strictEqual(result.watch, false);
  assert.strictEqual(result.pollIntervalMinutes, null);
  assert.ok(result.error, 'expected an error when --poll-interval is given without --watch');
});

test('run-significance-batch — parseWatchArgs: --poll-interval must be a positive integer', () => {
  assert.ok(runSignificanceBatchCli.parseWatchArgs(['--watch', '--poll-interval=0']).error, 'expected 0 to be rejected');
  assert.ok(runSignificanceBatchCli.parseWatchArgs(['--watch', '--poll-interval=-5']).error, 'expected a negative value to be rejected');
  assert.ok(runSignificanceBatchCli.parseWatchArgs(['--watch', '--poll-interval=abc']).error, 'expected a non-numeric value to be rejected');
});

// ============================================================
// PART 19 — lib/significance-batch.js's SUBMISSION RUN / size-aware
// chunking / resumable dispatch redesign (2026-09-18, the real-incident
// fix — see that file's own "ADDED 2026-09-18" header). All mocked — zero
// real Supabase or Anthropic calls. Pure functions (partitionIntoChunks,
// sizeOfRequestBytes) are tested directly, with small/fast numbers standing
// in for the real MAX_BATCH_REQUESTS (100,000) / MAX_BATCH_BYTES (200MB)
// constants — see partitionIntoChunks' and dispatchRunChunks' own comments
// in significance-batch.js for why those are parameters, not hardcoded, in
// the first place (constructing 100,000+ real entries or a ~200MB mock
// request just to exercise a boundary would make this suite both slow and
// unreadable for no extra correctness gained).
// ============================================================
test('significance-batch — partitionIntoChunks: cuts a new chunk on REQUEST COUNT alone when every entry is tiny (the byte limit never comes close to triggering)', () => {
  const entries = [1, 2, 3, 4, 5].map((n) => ({ n, bytes: 10 }));
  const chunks = significanceBatch.partitionIntoChunks(entries, 2, 1000000);
  assert.deepStrictEqual(chunks.map((c) => c.map((e) => e.n)), [[1, 2], [3, 4], [5]]);
});

test('significance-batch — partitionIntoChunks: cuts a new chunk on REAL BYTE SIZE alone when one entry is individually large enough to force it, even though the count limit is nowhere near reached — the exact shape of tonight\'s incident (84,408 requests, well under the 100,000 count cap, but over the real 256MB byte cap)', () => {
  const entries = [
    { n: 1, bytes: 10 },
    { n: 2, bytes: 90 }, // running total 10 -> 100, exactly at maxBytes — still fits, the limit is inclusive
    { n: 3, bytes: 1 },  // one more byte would exceed maxBytes (100) — must start a new chunk
    { n: 4, bytes: 5 },
  ];
  const chunks = significanceBatch.partitionIntoChunks(entries, 1000, 100);
  assert.deepStrictEqual(chunks.map((c) => c.map((e) => e.n)), [[1, 2], [3, 4]]);
});

test('significance-batch — partitionIntoChunks: an empty entries array produces zero chunks', () => {
  assert.deepStrictEqual(significanceBatch.partitionIntoChunks([], 100, 100), []);
});

test('significance-batch — partitionIntoChunks: a single entry that alone exceeds neither limit stays in a chunk of one, never dropped', () => {
  assert.deepStrictEqual(significanceBatch.partitionIntoChunks([{ n: 1, bytes: 50 }], 100, 100), [[{ n: 1, bytes: 50 }]]);
});

test('significance-batch — sizeOfRequestBytes: uses the REAL UTF-8 byte length (Buffer.byteLength), not JS string .length — the exact bug tonight\'s incident traces back to (a non-ASCII character must count as MORE than one byte, unlike .length which counts UTF-16 code units)', () => {
  const asciiRequest = { text: 'aaaa' };
  const nonAsciiRequest = { text: 'café café café café' }; // real accented characters, exactly the kind tenant/owner email text routinely has
  assert.strictEqual(significanceBatch.sizeOfRequestBytes(asciiRequest), JSON.stringify(asciiRequest).length, 'pure ASCII should match .length exactly — not a useful test on its own, but confirms the two measures agree when there is nothing to disagree about');
  assert.ok(
    significanceBatch.sizeOfRequestBytes(nonAsciiRequest) > JSON.stringify(nonAsciiRequest).length,
    'expected the real UTF-8 byte count to exceed .length once real non-ASCII characters are present — if this ever fails, sizeOfRequestBytes has regressed back to the exact undercount bug this fix exists to close'
  );
});

// ============================================================
// PART 20a — evaluatePoolRatio: the pure comparison half of the expected-
// pool sanity check (2026-09-19, the real-incident-class safeguard — see
// significance-batch.js's own EXPECTED_POOL_MIN_RATIO header for the full
// incident story and threshold reasoning). No DB call, no significancePass
// dependency, no fake client — plain numbers in, a pass/fail + ratio out.
// ============================================================
test('evaluatePoolRatio — tonight\'s real incident numbers (33,755 found vs. an 84,192 estimate, ~40.1%) FAIL the check', () => {
  const result = significanceBatch.evaluatePoolRatio({ eligibleCount: 33755, expectedPool: 84192 });
  assert.strictEqual(result.passed, false, 'expected the real incident shape to fail the sanity check');
  assert.ok(Math.abs(result.ratio - 0.4009) < 0.001, `expected ratio ~0.401, got ${result.ratio}`);
});

test('evaluatePoolRatio — a normal, healthy run (3,000 found against a proportionally-sized 3,100 estimate, ~96.8%) PASSES the check', () => {
  const result = significanceBatch.evaluatePoolRatio({ eligibleCount: 3000, expectedPool: 3100 });
  assert.strictEqual(result.passed, true, 'expected an ordinary, small legitimate shortfall to pass');
  assert.ok(Math.abs(result.ratio - (3000 / 3100)) < 1e-9);
});

test('evaluatePoolRatio — exactly at the 70% threshold PASSES (>=, not >)', () => {
  const result = significanceBatch.evaluatePoolRatio({ eligibleCount: 700, expectedPool: 1000 });
  assert.strictEqual(result.passed, true);
  assert.strictEqual(result.ratio, 0.7);
});

test('evaluatePoolRatio — just below the 70% threshold FAILS', () => {
  const result = significanceBatch.evaluatePoolRatio({ eligibleCount: 699, expectedPool: 1000 });
  assert.strictEqual(result.passed, false);
});

test('evaluatePoolRatio — a custom minRatio overrides the module default', () => {
  const result = significanceBatch.evaluatePoolRatio({ eligibleCount: 500, expectedPool: 1000, minRatio: 0.4 });
  assert.strictEqual(result.passed, true, 'expected 50% to pass a deliberately looser 40% threshold');
});

test('evaluatePoolRatio — expectedPool of zero or negative is treated as "nothing meaningful to compare against", never a false alarm', () => {
  assert.deepStrictEqual(significanceBatch.evaluatePoolRatio({ eligibleCount: 5, expectedPool: 0 }), { passed: true, ratio: null });
  assert.deepStrictEqual(significanceBatch.evaluatePoolRatio({ eligibleCount: 5, expectedPool: -10 }), { passed: true, ratio: null });
});

test('evaluatePoolRatio — an eligibleCount of zero against a real positive expected pool fails (ratio 0) — a defensive edge case, even though startSubmissionRun never persists a run with zero eligible conversations', () => {
  const result = significanceBatch.evaluatePoolRatio({ eligibleCount: 0, expectedPool: 500 });
  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.ratio, 0);
});

test('evaluatePoolRatio — EXPECTED_POOL_MIN_RATIO is exported and is 0.7 (70%) — documents the actual live threshold so this test tracks a real change to it, not a hardcoded guess', () => {
  assert.strictEqual(significanceBatch.EXPECTED_POOL_MIN_RATIO, 0.7);
});

// ============================================================
// PART 20b — estimateExpectedEligiblePool (lib/significance-pass.js): the
// real, DB-touching half of the sanity check's estimate.
//
// FIXED 2026-09-21 (Neo's finding): this used to be a single COUNT-only
// query per table (see git history / this function's own header comment for
// the incident story) — the old makeCountFakeClient this block used to use
// only had to fake a .select().gte() count. Now that term (1) walks
// missive_message_intake_search_safe_clear_branch page by page (reusing
// fetchDriverPage()'s exact query shape) to count DISTINCT conversations
// instead of raw message rows, this fake client has to serve BOTH real
// query shapes this function now issues: an RPC page fetch for the
// clear-branch data, and a count-mode .from().select() for
// missive_conversation_significance — same split PART 13-17's
// makeFilteringFakeClient and this file's count-mode fakes already model
// separately, combined here because one real function call now hits both
// shapes in a row.
//
// UPDATED 2026-09-21, SAME DAY (migration 20260921020000, performance fix):
// fetchDriverPage() — which countDistinctEligibleConversations() (and so
// estimateExpectedEligiblePool()) reuses exactly as
// fetchNextEligibleConversations() does — no longer queries the clear-branch
// view via .from(); it calls the archive_search_significance_driver_next_
// clear_page RPC instead. The pagination logic that used to live in
// makePaginatedChain() (returned from from() for that one table) moves into
// rpc() below, unchanged in behavior — same sort, same cursor, same limit.
// ============================================================
function makeEstimatePoolFakeClient(tableData) {
  function makeCountChain(rows) {
    const chain = {
      select() { return chain; }, // count/head mode is a select() option in the real client — the actual count is just the fake table's row count, this fake never needs to inspect the options object.
      then(resolve, reject) {
        return Promise.resolve({ data: null, error: null, count: rows.length }).then(resolve, reject);
      },
    };
    return chain;
  }
  function rpc(name, args) {
    if (name === 'archive_search_significance_driver_next_clear_page') {
      const cursor = args && args.p_cursor_id != null ? args.p_cursor_id : null;
      let rows = (tableData.missive_message_intake_search_safe_clear_branch || []).slice()
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (cursor !== null) rows = rows.filter((row) => row.id > cursor);
      const limitN = args && args.p_limit;
      if (limitN != null) rows = rows.slice(0, limitN);
      return withAbortSignalStub(Promise.resolve({ data: rows, error: null }));
    }
    return Promise.reject(new Error(`makeEstimatePoolFakeClient: unexpected rpc '${name}'`));
  }
  return {
    from(table) { return makeCountChain(tableData[table] || []); },
    rpc,
  };
}

asyncTest('significance-pass — estimateExpectedEligiblePool: counts DISTINCT conversations (scoped by sinceDate), not raw message rows — the exact bug Neo found (2.513x messages-per-conversation inflation) — minus ALL already-processed conversations (table-wide, not date-scoped)', async () => {
  const fakeClient = makeEstimatePoolFakeClient({
    missive_message_intake_search_safe_clear_branch: [
      { id: 'm1', mailbox_key: 'mb1', missive_conversation_id: 'conv-1', delivered_at: '2026-08-01T00:00:00.000Z' }, // on/after cutoff
      { id: 'm2', mailbox_key: 'mb1', missive_conversation_id: 'conv-1', delivered_at: '2026-09-01T00:00:00.000Z' }, // on/after cutoff, SAME conversation as m1 — must be deduped, not double-counted
      { id: 'm3', mailbox_key: 'mb1', missive_conversation_id: 'conv-2', delivered_at: '2020-01-01T00:00:00.000Z' }, // before cutoff — excluded
    ],
    missive_conversation_significance: [{ id: 's1' }, { id: 's2' }],
  });
  await withFakeSupabaseClient(fakeClient, '../lib/significance-pass', async (freshSignificancePass) => {
    const result = await freshSignificancePass.estimateExpectedEligiblePool('2025-09-17');
    assert.strictEqual(result.totalMatchingConversations, 1, 'expected the 2 on/after-cutoff messages (m1, m2) to collapse into 1 distinct conversation (conv-1), not counted as 2');
    assert.strictEqual(result.totalAlreadyProcessed, 2, 'expected the full, table-wide already-processed count, not scoped by date');
    assert.strictEqual(result.expectedPool, 0, 'expected max(0, 1 - 2) = 0');
  });
});

asyncTest('significance-pass — estimateExpectedEligiblePool: sinceDate omitted counts every DISTINCT conversation with no date filter applied at all (same "no cutoff" default as fetchNextEligibleConversations) — still deduped across multiple messages per conversation', async () => {
  const fakeClient = makeEstimatePoolFakeClient({
    missive_message_intake_search_safe_clear_branch: [
      { id: 'm1', mailbox_key: 'mb1', missive_conversation_id: 'conv-1', delivered_at: '2020-01-01T00:00:00.000Z' },
      { id: 'm2', mailbox_key: 'mb1', missive_conversation_id: 'conv-1', delivered_at: '2020-02-01T00:00:00.000Z' },
      { id: 'm3', mailbox_key: 'mb1', missive_conversation_id: 'conv-1', delivered_at: '2020-03-01T00:00:00.000Z' },
      { id: 'm4', mailbox_key: 'mb2', missive_conversation_id: 'conv-2', delivered_at: '2026-01-01T00:00:00.000Z' },
    ],
    missive_conversation_significance: [],
  });
  await withFakeSupabaseClient(fakeClient, '../lib/significance-pass', async (freshSignificancePass) => {
    const result = await freshSignificancePass.estimateExpectedEligiblePool();
    assert.strictEqual(result.totalMatchingConversations, 2, 'expected 4 messages across 2 conversations to count as 2, not 4 — the old message-counting bug would have returned 4 here');
    assert.strictEqual(result.expectedPool, 2);
  });
});

asyncTest('significance-pass — estimateExpectedEligiblePool: the composite (mailbox_key, missive_conversation_id) key is what defines a distinct conversation, not missive_conversation_id alone — two different mailboxes sharing the same conversation id count as 2, matching the same composite-key convention dedupeNewPairs()/passesEscalationExclusion() already use elsewhere in this file', async () => {
  const fakeClient = makeEstimatePoolFakeClient({
    missive_message_intake_search_safe_clear_branch: [
      { id: 'm1', mailbox_key: 'mb1', missive_conversation_id: 'conv-shared', delivered_at: '2026-01-01T00:00:00.000Z' },
      { id: 'm2', mailbox_key: 'mb2', missive_conversation_id: 'conv-shared', delivered_at: '2026-01-01T00:00:00.000Z' },
    ],
    missive_conversation_significance: [],
  });
  await withFakeSupabaseClient(fakeClient, '../lib/significance-pass', async (freshSignificancePass) => {
    const result = await freshSignificancePass.estimateExpectedEligiblePool();
    assert.strictEqual(result.totalMatchingConversations, 2, 'expected the same missive_conversation_id in two different mailboxes to count as 2 distinct conversations, not 1');
  });
});

asyncTest('significance-pass — estimateExpectedEligiblePool: floors expectedPool at 0 rather than going negative when already-processed exceeds matching conversations', async () => {
  const fakeClient = makeEstimatePoolFakeClient({
    missive_message_intake_search_safe_clear_branch: [{ id: 'm1', mailbox_key: 'mb1', missive_conversation_id: 'conv-1', delivered_at: '2026-01-01T00:00:00.000Z' }],
    missive_conversation_significance: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
  });
  await withFakeSupabaseClient(fakeClient, '../lib/significance-pass', async (freshSignificancePass) => {
    const result = await freshSignificancePass.estimateExpectedEligiblePool();
    assert.strictEqual(result.expectedPool, 0, 'expected max(0, 1 - 3) = 0, never a negative pool');
  });
});

asyncTest('significance-pass — estimateExpectedEligiblePool: walks past a full page boundary using the same plain id cursor as fetchDriverPage(), still finding and deduping a conversation whose messages land on page 2', async () => {
  const fillerCount = DRIVER_PAGE_SIZE_FOR_TEST; // exactly one full page of distinct, unmatched-by-nothing-in-particular filler conversations, forcing the real conversation below onto page 2.
  const fillerRows = [];
  for (let i = 0; i < fillerCount; i++) {
    fillerRows.push({
      id: `filler-${String(i).padStart(6, '0')}`, // sorts before 'zz-*' below under plain ascending id order.
      mailbox_key: 'mb1',
      missive_conversation_id: `conv-filler-${i}`,
      delivered_at: '2026-01-01T00:00:00.000Z',
    });
  }
  const page2Rows = [
    { id: 'zz-1', mailbox_key: 'mb1', missive_conversation_id: 'conv-page2', delivered_at: '2026-01-01T00:00:00.000Z' },
    { id: 'zz-2', mailbox_key: 'mb1', missive_conversation_id: 'conv-page2', delivered_at: '2026-02-01T00:00:00.000Z' }, // same conversation as zz-1, second message, must still dedupe across the page boundary
  ];
  const fakeClient = makeEstimatePoolFakeClient({
    missive_message_intake_search_safe_clear_branch: [...fillerRows, ...page2Rows],
    missive_conversation_significance: [],
  });
  await withFakeSupabaseClient(fakeClient, '../lib/significance-pass', async (freshSignificancePass) => {
    const result = await freshSignificancePass.estimateExpectedEligiblePool();
    assert.strictEqual(result.totalMatchingConversations, fillerCount + 1, 'expected every filler conversation (1 each) plus exactly 1 for conv-page2, despite its 2 messages spanning the page-1/page-2 boundary');
  });
});

// Every 18b-18i scenario below runs inside this ONE async IIFE, in a real,
// awaited sequence — see the header comment above runSerialCheck() for why
// this replaced an earlier, subtly-broken chained-promise approach. Its
// own promise is pushed into asyncResults so main() waits for the whole
// sequence (each scenario has already reported its own PASS/FAIL into
// `results` by the time this resolves) before printing the final report.
asyncResults.push((async () => {

// ─── 18b — the 'call_2' submission guard (Q's own documented scope
// decision) — no mocking needed, this throws before any DB/AI call ────────
  await runSerialCheck('significance-batch — submitBatch: a stage other than call_1 is refused with a clear, explicit error — never silently attempted', async () => {
  await assert.rejects(() => significanceBatch.submitBatch({ stage: 'call_2' }), /not implemented yet/);
});

// ─── 18c — refuses to double-submit (the schema's own one-unfinished-
// batch-per-stage constraint, checked in application code first) ──────────
  await runSerialCheck('significance-batch — submitBatch: an existing unfinished batch for the stage refuses to submit a new one, and makes ZERO Anthropic calls', async () => {
  const existingBatchRow = { id: 'batch-existing', stage: 'call_1', anthropic_batch_id: 'msgbatch_existing', anthropic_status: 'in_progress', completed_at: null, failed_at: null, results_retrieved_at: null };
  const { client: supabaseClient } = makeBatchTrackingFakeClient({ batchRow: existingBatchRow });
  const { client: anthropicClientFake, calls: anthropicCalls } = makeFakeAnthropicBatchesClient({});

  await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
    const result = await freshBatchModule.submitBatch({ stage: 'call_1' });
    assert.strictEqual(result.submitted, false);
    assert.strictEqual(result.reason, 'unfinished_batch_exists');
    assert.strictEqual(result.batch.anthropic_batch_id, 'msgbatch_existing');
  });
  assert.strictEqual(anthropicCalls.create.length, 0, 'expected zero batches.create() calls — a real double-submission would have called this');
});

// ─── 18d — happy-path submission: proves reuse (buildCall1Prompt/
// buildConversationContext/fetchNextEligibleConversations are the REAL
// significance-pass.js functions, spied not reimplemented), and proves the
// real request/insert shapes are correct ───────────────────────────────────
  await runSerialCheck('significance-batch — submitBatch: happy path builds one request per eligible conversation via the REUSED buildCall1Prompt, submits ONE Anthropic batch, and records one batches row + one batch_items row per conversation', async () => {
  const pairs = [
    { mailbox_key: 'mb1', missive_conversation_id: 'conv-1' },
    { mailbox_key: 'mb1', missive_conversation_id: 'conv-2' },
  ];
  const contexts = {
    'conv-1': { rows: [{ missive_message_id: 'm1' }], thread: {}, addressMatch: {}, addressMatched: false, threadText: 'Conversation 1 text.' },
    'conv-2': { rows: [{ missive_message_id: 'm2' }], thread: {}, addressMatch: {}, addressMatched: true, threadText: 'Conversation 2 text.' },
  };

  const fetchSpy = spyOn(significancePass, 'fetchNextEligibleConversations', async () => pairs);
  const contextSpy = spyOn(significancePass, 'buildConversationContext', async (mailboxKey, convId) => contexts[convId]);
  const promptSpy = spyOn(significancePass, 'buildCall1Prompt', ({ threadText, addressMatched }) => `PROMPT[${addressMatched}]: ${threadText}`);

  const { client: supabaseClient, state } = makeBatchTrackingFakeClient({});
  const { client: anthropicClientFake, calls: anthropicCalls } = makeFakeAnthropicBatchesClient({
    create: async ({ requests }) => ({ id: 'msgbatch_new123', processing_status: 'in_progress', request_counts: { processing: requests.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 } }),
  });

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const result = await freshBatchModule.submitBatch({ stage: 'call_1', sinceDate: '2025-09-17' });
      assert.strictEqual(result.submitted, true);
      assert.strictEqual(result.requestCount, 2);
      assert.strictEqual(result.batch.anthropic_batch_id, 'msgbatch_new123');
    });
  } finally {
    fetchSpy.restore(); contextSpy.restore(); promptSpy.restore();
  }

  assert.strictEqual(fetchSpy.calls.length, 1, 'expected fetchNextEligibleConversations to be called exactly once');
  assert.deepStrictEqual(fetchSpy.calls[0], [100000, '2025-09-17'], 'expected the default 100,000-request cap and the given sinceDate to be threaded through');
  assert.strictEqual(contextSpy.calls.length, 2, 'expected the REAL buildConversationContext to be called once per eligible conversation, not reimplemented');
  assert.strictEqual(promptSpy.calls.length, 2, 'expected the REAL buildCall1Prompt to be called once per conversation, not reimplemented');

  assert.strictEqual(anthropicCalls.create.length, 1, 'expected exactly ONE Anthropic batch for both conversations');
  const [{ requests }] = anthropicCalls.create[0];
  assert.strictEqual(requests.length, 2);
  for (const req of requests) {
    assert.ok(/^[a-zA-Z0-9_-]{1,64}$/.test(req.custom_id), 'expected each request\'s custom_id to be a valid token');
    assert.strictEqual(req.params.model, 'claude-sonnet-5');
    assert.strictEqual(req.params.output_config.effort, 'medium');
  }
  assert.ok(requests.some((r) => r.params.messages[0].content[0].text.startsWith('PROMPT[false]: Conversation 1 text.')));
  assert.ok(requests.some((r) => r.params.messages[0].content[0].text.startsWith('PROMPT[true]: Conversation 2 text.')));

  assert.strictEqual(state.items.length, 2, 'expected one archive_search_significance_batch_items row per conversation');
  assert.deepStrictEqual(state.items.map((it) => it.token).sort(), requests.map((r) => r.custom_id).sort(), 'expected the SAME tokens sent to Anthropic to be the ones persisted for later lookup');
  assert.deepStrictEqual(new Set(state.items.map((it) => it.missive_conversation_id)), new Set(['conv-1', 'conv-2']));
});

// ─── 18e — fail loudly, write nothing partial ─────────────────────────────
  await runSerialCheck('significance-batch — submitBatch: a failure fetching the eligible set throws and writes NOTHING to the database', async () => {
  const fetchSpy = spyOn(significancePass, 'fetchNextEligibleConversations', async () => { throw new Error('simulated DB failure fetching eligible conversations'); });
  const { client: supabaseClient, state } = makeBatchTrackingFakeClient({});
  const { client: anthropicClientFake, calls: anthropicCalls } = makeFakeAnthropicBatchesClient({});

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      await assert.rejects(() => freshBatchModule.submitBatch({ stage: 'call_1' }), /simulated DB failure/);
    });
  } finally {
    fetchSpy.restore();
  }
  assert.strictEqual(anthropicCalls.create.length, 0, 'expected zero Anthropic calls when the eligible-set fetch itself failed');
  assert.strictEqual(state.batch, null, 'expected no batch row to have been written');
  assert.strictEqual(state.items.length, 0, 'expected no batch_items rows to have been written');
});

  await runSerialCheck('significance-batch — submitBatch: a failure from Anthropic\'s own create() call throws and writes nothing — the tracking row is only ever inserted AFTER a successful create()', async () => {
  const fetchSpy = spyOn(significancePass, 'fetchNextEligibleConversations', async () => [{ mailbox_key: 'mb1', missive_conversation_id: 'conv-1' }]);
  const contextSpy = spyOn(significancePass, 'buildConversationContext', async () => ({ rows: [{ missive_message_id: 'm1' }], thread: {}, addressMatch: {}, addressMatched: false, threadText: 'hi' }));
  const promptSpy = spyOn(significancePass, 'buildCall1Prompt', () => 'a prompt');
  const { client: supabaseClient, state } = makeBatchTrackingFakeClient({});
  const { client: anthropicClientFake } = makeFakeAnthropicBatchesClient({ create: async () => { throw new Error('simulated Anthropic outage'); } });

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      await assert.rejects(() => freshBatchModule.submitBatch({ stage: 'call_1' }), /simulated Anthropic outage/);
    });
  } finally {
    fetchSpy.restore(); contextSpy.restore(); promptSpy.restore();
  }
  assert.strictEqual(state.batch, null);
  assert.strictEqual(state.items.length, 0);
});

// ─── 18f — checkAndResume: the four real result_status outcomes ──────────
  await runSerialCheck('significance-batch — checkAndResume: streams all four real result_status outcomes, records each correctly, and sets results_retrieved_at once every item is non-pending', async () => {
  const existingBatchRow = { id: 'batch-1', stage: 'call_1', anthropic_batch_id: 'msgbatch_abc', anthropic_status: 'in_progress', completed_at: null, failed_at: null, results_retrieved_at: null };
  const itemRows = [
    { batch_id: 'batch-1', token: 'tok-succeed', mailbox_key: 'mb1', missive_conversation_id: 'conv-1', result_status: 'pending', written_back_at: null },
    { batch_id: 'batch-1', token: 'tok-error', mailbox_key: 'mb1', missive_conversation_id: 'conv-2', result_status: 'pending', written_back_at: null },
    { batch_id: 'batch-1', token: 'tok-cancel', mailbox_key: 'mb1', missive_conversation_id: 'conv-3', result_status: 'pending', written_back_at: null },
    { batch_id: 'batch-1', token: 'tok-expire', mailbox_key: 'mb1', missive_conversation_id: 'conv-4', result_status: 'pending', written_back_at: null },
  ];
  const { client: supabaseClient, state } = makeBatchTrackingFakeClient({ batchRow: existingBatchRow, itemRows });

  const fakeResults = [
    { custom_id: 'tok-succeed', result: { type: 'succeeded', message: { content: [{ type: 'text', text: '{}' }] } } },
    { custom_id: 'tok-error', result: { type: 'errored', error: { type: 'invalid_request', message: 'bad' } } },
    { custom_id: 'tok-cancel', result: { type: 'canceled' } },
    { custom_id: 'tok-expire', result: { type: 'expired' } },
  ];
  const { client: anthropicClientFake, calls: anthropicCalls } = makeFakeAnthropicBatchesClient({
    retrieve: async () => ({ processing_status: 'ended', request_counts: { processing: 0, succeeded: 1, errored: 1, canceled: 1, expired: 1 } }),
    results: async () => asyncIterableFromArray(fakeResults),
  });

  await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
    const outcome = await freshBatchModule.checkAndResume({ stage: 'call_1' });
    assert.strictEqual(outcome.found, true);
    assert.strictEqual(outcome.remote.processing_status, 'ended');
    assert.strictEqual(outcome.resultsJustRetrieved, true);
  });

  assert.strictEqual(anthropicCalls.retrieve.length, 1);
  assert.strictEqual(anthropicCalls.results.length, 1);

  const byToken = Object.fromEntries(state.items.map((it) => [it.token, it]));
  assert.strictEqual(byToken['tok-succeed'].result_status, 'succeeded');
  assert.strictEqual(byToken['tok-succeed'].error_detail, null);
  assert.strictEqual(byToken['tok-error'].result_status, 'errored');
  assert.ok(byToken['tok-error'].error_detail.includes('invalid_request'));
  assert.strictEqual(byToken['tok-cancel'].result_status, 'canceled');
  assert.strictEqual(byToken['tok-expire'].result_status, 'expired');

  assert.ok(state.batch.results_retrieved_at, 'expected results_retrieved_at to be set once every item is non-pending');
  assert.strictEqual(state.batch.anthropic_status, 'ended');
});

  await runSerialCheck('significance-batch — checkAndResume: does NOT set results_retrieved_at if any item is still pending after streaming — an honest partial-download signal, never a false completion', async () => {
  const existingBatchRow = { id: 'batch-1', stage: 'call_1', anthropic_batch_id: 'msgbatch_abc', anthropic_status: 'in_progress', completed_at: null, failed_at: null, results_retrieved_at: null };
  const itemRows = [
    { batch_id: 'batch-1', token: 'tok-a', mailbox_key: 'mb1', missive_conversation_id: 'conv-1', result_status: 'pending', written_back_at: null },
    { batch_id: 'batch-1', token: 'tok-b', mailbox_key: 'mb1', missive_conversation_id: 'conv-2', result_status: 'pending', written_back_at: null },
  ];
  const { client: supabaseClient, state } = makeBatchTrackingFakeClient({ batchRow: existingBatchRow, itemRows });
  const { client: anthropicClientFake } = makeFakeAnthropicBatchesClient({
    retrieve: async () => ({ processing_status: 'ended', request_counts: {} }),
    results: async () => asyncIterableFromArray([{ custom_id: 'tok-a', result: { type: 'succeeded', message: { content: [] } } }]), // tok-b never appears in the stream
  });

  await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
    const outcome = await freshBatchModule.checkAndResume({ stage: 'call_1' });
    assert.strictEqual(outcome.resultsJustRetrieved, false);
  });
  assert.strictEqual(state.batch.results_retrieved_at, null);
});

// ─── 18f-2 — checkAndResumeOneBatch concurrency fix (2026-09-20): the old
// one-at-a-time `for await` loop over Anthropic's results stream is now
// drained in DISPATCH_CONCURRENCY-sized groups (drainInGroups()) with each
// group's database updates run concurrently (mapWithConcurrency()) — see
// both functions' own header comments in lib/significance-batch.js.
// statusCounts must come out identical to what the old sequential loop
// would have produced regardless of which of a group's concurrent writes
// actually finishes first (it's tallied straight off the stream, before any
// write is even attempted), and a single item's write failure must still
// only be logged, never abort the batch. A dedicated timing-aware fake is
// used here (rather than makeBatchTrackingFakeClient, which resolves every
// call instantly) specifically so completion order can be deliberately
// scrambled and real concurrency can be measured, mirroring the technique
// test 19h below already uses for buildDispatchEntries' own concurrency
// fix. ────────────────────────────────────────────────────────────────────
function makeTimingAwareItemsBatchFakeClient({ batchRow, itemRows, delayForToken, errorForToken }) {
  const state = { batch: { ...batchRow }, items: itemRows.map((r) => ({ ...r })) };
  const timing = { inFlight: 0, maxInFlight: 0 };
  return {
    client: {
      from(table) {
        if (table === 'archive_search_significance_batches') {
          const filters = [];
          let op = null, updateFields = null;
          const chain = {
            select() { op = op || 'select'; return chain; },
            update(fields) { op = 'update'; updateFields = fields; return chain; },
            eq(col, val) { filters.push({ col, type: 'eq', val }); return chain; },
            is(col, val) { filters.push({ col, type: 'is', val }); return chain; },
            maybeSingle() {
              const match = state.batch && filters.every((f) => (f.type === 'is' ? (state.batch[f.col] ?? null) === f.val : state.batch[f.col] === f.val)) ? state.batch : null;
              return Promise.resolve({ data: match, error: null });
            },
            then(resolve, reject) {
              if (op === 'update') Object.assign(state.batch, updateFields);
              return Promise.resolve({ data: null, error: null }).then(resolve, reject);
            },
          };
          return chain;
        }
        if (table === 'archive_search_significance_batch_items') {
          const filters = [];
          let op = null, updateFields = null, countMode = false;
          const chain = {
            select(cols, opts) { op = op || 'select'; if (opts && opts.count) countMode = true; return chain; },
            update(fields) { op = 'update'; updateFields = fields; return chain; },
            eq(col, val) { filters.push({ col, val }); return chain; },
            then(resolve, reject) {
              const run = async () => {
                if (op === 'update') {
                  const token = (filters.find((f) => f.col === 'token') || {}).val;
                  timing.inFlight++;
                  timing.maxInFlight = Math.max(timing.maxInFlight, timing.inFlight);
                  await new Promise((res) => setTimeout(res, delayForToken ? delayForToken(token) : 0));
                  timing.inFlight--;
                  if (errorForToken && errorForToken(token)) return { data: null, error: { message: `simulated write failure for ${token}` } };
                  const item = state.items.find((it) => it.token === token);
                  if (item) Object.assign(item, updateFields);
                  return { data: null, error: null };
                }
                if (op === 'select') {
                  const matching = state.items.filter((it) => filters.every((f) => it[f.col] === f.val));
                  return countMode ? { data: null, error: null, count: matching.length } : { data: matching, error: null };
                }
                return { data: null, error: null };
              };
              return run().then(resolve, reject);
            },
          };
          return chain;
        }
        throw new Error(`makeTimingAwareItemsBatchFakeClient: unexpected table "${table}"`);
      },
    },
    state,
    timing,
  };
}

  await runSerialCheck('significance-batch — checkAndResumeOneBatch (via checkAndResume): processes a group of results with REAL bounded concurrency — completion order is deliberately scrambled, yet statusCounts comes out identical to what the old sequential loop would have produced', async () => {
  const existingBatchRow = { id: 'batch-1', stage: 'call_1', anthropic_batch_id: 'msgbatch_abc', anthropic_status: 'in_progress', completed_at: null, failed_at: null, results_retrieved_at: null };
  const N = 12;
  const itemRows = Array.from({ length: N }, (_, i) => ({ batch_id: 'batch-1', token: `tok-${i}`, mailbox_key: 'mb1', missive_conversation_id: `conv-${i}`, result_status: 'pending', written_back_at: null }));
  const { client: supabaseClient, state, timing } = makeTimingAwareItemsBatchFakeClient({
    batchRow: existingBatchRow,
    itemRows,
    // Deliberately inverted: tok-0 (first in the stream) finishes LAST,
    // tok-11 (last in the stream) finishes FIRST.
    delayForToken: (token) => (N - Number(token.split('-')[1])) * 3,
  });
  const statusForIndex = (i) => (i % 4 === 0 ? 'succeeded' : i % 4 === 1 ? 'errored' : i % 4 === 2 ? 'canceled' : 'expired');
  const fakeResults = itemRows.map((it, i) => ({
    custom_id: it.token,
    result: statusForIndex(i) === 'succeeded'
      ? { type: 'succeeded', message: { content: [{ type: 'text', text: '{}' }] } }
      : statusForIndex(i) === 'errored'
      ? { type: 'errored', error: { type: 'invalid_request', message: 'bad' } }
      : { type: statusForIndex(i) },
  }));
  const { client: anthropicClientFake } = makeFakeAnthropicBatchesClient({
    retrieve: async () => ({ processing_status: 'ended', request_counts: {} }),
    results: async () => asyncIterableFromArray(fakeResults),
  });

  await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
    const outcome = await freshBatchModule.checkAndResume({ stage: 'call_1' });
    assert.strictEqual(outcome.resultsJustRetrieved, true);
    assert.deepStrictEqual(outcome.statusCounts, { succeeded: 3, errored: 3, canceled: 3, expired: 3 }, 'expected the exact same tally the old sequential loop would have produced, regardless of concurrent completion order');
  });

  assert.ok(timing.maxInFlight > 1, `expected genuine concurrency (more than 1 database write in flight at once), saw ${timing.maxInFlight}`);
  assert.ok(timing.maxInFlight <= significanceBatch.DISPATCH_CONCURRENCY, `expected concurrency capped at DISPATCH_CONCURRENCY (${significanceBatch.DISPATCH_CONCURRENCY}), saw ${timing.maxInFlight}`);

  const byToken = Object.fromEntries(state.items.map((it) => [it.token, it]));
  itemRows.forEach((it, i) => {
    assert.strictEqual(byToken[it.token].result_status, statusForIndex(i), `expected ${it.token} to be recorded as ${statusForIndex(i)}`);
  });
});

  await runSerialCheck('significance-batch — checkAndResumeOneBatch (via checkAndResume): a single item\'s database-update failure during concurrent result streaming is logged, not thrown — the rest of the group is still recorded correctly, the batch is not aborted, and the failed item honestly stays pending (never falsely marked complete)', async () => {
  const existingBatchRow = { id: 'batch-1', stage: 'call_1', anthropic_batch_id: 'msgbatch_abc', anthropic_status: 'in_progress', completed_at: null, failed_at: null, results_retrieved_at: null };
  const itemRows = Array.from({ length: 6 }, (_, i) => ({ batch_id: 'batch-1', token: `tok-${i}`, mailbox_key: 'mb1', missive_conversation_id: `conv-${i}`, result_status: 'pending', written_back_at: null }));
  const { client: supabaseClient, state } = makeTimingAwareItemsBatchFakeClient({
    batchRow: existingBatchRow,
    itemRows,
    errorForToken: (token) => token === 'tok-3',
  });
  const fakeResults = itemRows.map((it) => ({ custom_id: it.token, result: { type: 'succeeded', message: { content: [{ type: 'text', text: '{}' }] } } }));
  const { client: anthropicClientFake } = makeFakeAnthropicBatchesClient({
    retrieve: async () => ({ processing_status: 'ended', request_counts: {} }),
    results: async () => asyncIterableFromArray(fakeResults),
  });

  await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
    const outcome = await freshBatchModule.checkAndResume({ stage: 'call_1' });
    assert.strictEqual(outcome.found, true, 'expected checkAndResume to complete normally despite one item\'s DB-write failure');
    assert.strictEqual(outcome.statusCounts.succeeded, 6, 'expected the tally itself to be unaffected by a downstream write failure — tallied straight off the stream, before the write is even attempted');
    assert.strictEqual(outcome.resultsJustRetrieved, false, 'expected the honest partial-completion signal — tok-3 never became non-pending, so results_retrieved_at must not be set');
  });

  const byToken = Object.fromEntries(state.items.map((it) => [it.token, it]));
  assert.strictEqual(byToken['tok-3'].result_status, 'pending', 'expected tok-3\'s row to remain untouched after its simulated write failure');
  for (const i of [0, 1, 2, 4, 5]) {
    assert.strictEqual(byToken[`tok-${i}`].result_status, 'succeeded', `expected tok-${i} to still be recorded correctly despite tok-3's unrelated failure`);
  }
});

// ─── 18g — writeBackBatch: resumability after a simulated partial failure ─
  await runSerialCheck('significance-batch — writeBackBatch: resumable after a simulated partial failure — a re-run only reprocesses the item that never got written_back_at, skipping the one already done even though its result still appears in the stream', async () => {
  const batchId = 'batch-1';
  const itemRows = [
    { id: 'item-000001', batch_id: batchId, token: 'tok-1', mailbox_key: 'mb1', missive_conversation_id: 'conv-1', result_status: 'succeeded', written_back_at: null },
    { id: 'item-000002', batch_id: batchId, token: 'tok-2', mailbox_key: 'mb1', missive_conversation_id: 'conv-2', result_status: 'succeeded', written_back_at: null },
  ];
  const { client: supabaseClient, state } = makeBatchTrackingFakeClient({ itemRows });

  let conv1Attempts = 0;
  const contextSpy = spyOn(significancePass, 'buildConversationContext', async (mailboxKey, convId) => {
    if (convId === 'conv-1') {
      conv1Attempts++;
      if (conv1Attempts === 1) throw new Error('simulated transient failure on the first attempt');
      return { rows: [{ missive_message_id: 'm1' }], thread: {}, addressMatch: {}, addressMatched: false, threadText: 'conv 1 text' };
    }
    return { rows: [{ missive_message_id: 'm2' }], thread: {}, addressMatch: {}, addressMatched: false, threadText: 'conv 2 text' };
  });
  const parseSpy = spyOn(significancePass, 'parseCall1Response', () => ({ resolution_status: 'open', category: 'dispute', why: 'test', tone_trend: null, identification: { property_text: null, vendor_text: null } }));
  const applySpy = spyOn(significancePass, 'applyCall1Result', async () => ({ significanceId: 'sig-1', property_id: null, vendor_id: null, keywordCheck: { flagged_protected_class: false, flagged_category: null } }));
  const propDirSpy = spyOn(significancePass, 'fetchPropertyDirectory', async () => []);
  const vendorDirSpy = spyOn(significancePass, 'fetchVendorDirectory', async () => []);

  const bothResults = [
    { custom_id: 'tok-1', result: { type: 'succeeded', message: { content: [{ type: 'text', text: '{}' }] } } },
    { custom_id: 'tok-2', result: { type: 'succeeded', message: { content: [{ type: 'text', text: '{}' }] } } },
  ];
  const { client: anthropicClientFake } = makeFakeAnthropicBatchesClient({ results: async () => asyncIterableFromArray(bothResults) });

  try {
    // First run — conv-1 throws (simulated crash mid-write-back), conv-2 succeeds.
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const summary1 = await freshBatchModule.writeBackBatch({ batchId, anthropicBatchId: 'msgbatch_abc' });
      assert.strictEqual(summary1.processed, 1, 'expected only conv-2 to be successfully processed on the first run');
      assert.strictEqual(summary1.errors, 1, 'expected conv-1\'s failure to be counted as an error, not to abort the whole run');
    });

    const byToken1 = Object.fromEntries(state.items.map((it) => [it.token, it]));
    assert.strictEqual(byToken1['tok-1'].written_back_at, null, 'expected conv-1 to remain un-written-back after its simulated failure');
    assert.ok(byToken1['tok-2'].written_back_at, 'expected conv-2 to be marked written back after succeeding');

    // Second run ("a re-run picks up exactly where it left off") — conv-1
    // now succeeds; conv-2's result is STILL in the stream (both tokens are
    // yielded again) but must be skipped, not reprocessed, because it
    // already has written_back_at set.
    applySpy.calls.length = 0;
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const summary2 = await freshBatchModule.writeBackBatch({ batchId, anthropicBatchId: 'msgbatch_abc' });
      assert.strictEqual(summary2.processed, 1, 'expected exactly one item (conv-1, the one still pending) to be processed on the re-run');
      assert.strictEqual(summary2.errors, 0);
    });

    assert.strictEqual(applySpy.calls.length, 1, 'expected applyCall1Result to be called exactly once on the re-run — for conv-1 only, never re-applied to conv-2');
    assert.strictEqual(applySpy.calls[0][0].missive_conversation_id, 'conv-1');

    const byToken2 = Object.fromEntries(state.items.map((it) => [it.token, it]));
    assert.ok(byToken2['tok-1'].written_back_at, 'expected conv-1 to be written back after the re-run succeeds');
  } finally {
    contextSpy.restore(); parseSpy.restore(); applySpy.restore(); propDirSpy.restore(); vendorDirSpy.restore();
  }
});

  await runSerialCheck('significance-batch — writeBackBatch: an errored/canceled/expired item writes NO significance row (mirrors processConversation\'s own Call 1 failure contract exactly) yet is still marked written back', async () => {
  const itemRows = [
    { id: 'item-000001', batch_id: 'batch-1', token: 'tok-err', mailbox_key: 'mb1', missive_conversation_id: 'conv-err', result_status: 'errored', written_back_at: null },
  ];
  const { client: supabaseClient, state } = makeBatchTrackingFakeClient({ itemRows });
  const contextSpy = spyOn(significancePass, 'buildConversationContext', async () => { throw new Error('buildConversationContext should never be called for a non-succeeded result'); });
  // writeBackBatch() fetches both directories unconditionally before its
  // per-item loop (regardless of whether any item actually needs them) —
  // spied here purely so this test never attempts a real network call
  // against significancePass's own (fake-URL, but otherwise real) Supabase
  // client; the errored item itself never reads either directory.
  const propDirSpy = spyOn(significancePass, 'fetchPropertyDirectory', async () => []);
  const vendorDirSpy = spyOn(significancePass, 'fetchVendorDirectory', async () => []);
  const { client: anthropicClientFake } = makeFakeAnthropicBatchesClient({
    results: async () => asyncIterableFromArray([{ custom_id: 'tok-err', result: { type: 'errored', error: { type: 'invalid_request', message: 'bad' } } }]),
  });

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const summary = await freshBatchModule.writeBackBatch({ batchId: 'batch-1', anthropicBatchId: 'msgbatch_abc' });
      assert.strictEqual(summary.written_significance, 0);
      assert.strictEqual(summary.no_row_written, 1);
    });
  } finally {
    contextSpy.restore(); propDirSpy.restore(); vendorDirSpy.restore();
  }
  assert.ok(state.items[0].written_back_at, 'expected the item to be marked written back even though no significance row was ever written for it');
});

// ─── 18h — END-TO-END: the REAL applyCall1Result / parseCall1Response
// genuinely upsert into missive_conversation_significance — proof "do not
// reimplement the database write" actually holds, not just by naming
// convention. This is the one test in this PART that also uses lib/
// significance-pass.js's own _setSupabaseClientForTesting() (its DI seam,
// added alongside this build for exactly this test) so the REAL,
// un-spied applyCall1Result/buildConversationContext run against the SAME
// fake Supabase client as significance-batch.js's own DI seam. ────────────
  await runSerialCheck('significance-batch — writeBackBatch END-TO-END: a real \'succeeded\' result is parsed with the REAL parseCall1Response and applied through the REAL applyCall1Result, genuinely upserting into missive_conversation_significance', async () => {
  const conversationRow = {
    id: 1, mailbox_key: 'mb1', missive_conversation_id: 'conv-real-1', missive_message_id: 'msg-1',
    from_address: null, to_addresses: null, cc_addresses: null, bcc_addresses: null,
    subject: 'Test', body_text: 'A perfectly ordinary test conversation body, nothing protected-class-related.',
    delivered_at: '2026-01-01T00:00:00.000Z', screening_completed_at: '2026-01-02T00:00:00.000Z',
  };
  const itemRows = [
    { id: 'item-000001', batch_id: 'batch-1', token: 'tok-real', mailbox_key: 'mb1', missive_conversation_id: 'conv-real-1', result_status: 'succeeded', written_back_at: null },
  ];

  const state = { items: itemRows.map((r) => ({ ...r })), significanceUpserts: [] };
  const fakeClient = {
    from(table) {
      if (table === 'archive_search_significance_batch_items') {
        const filters = [];
        let op = null, updateFields = null;
        const chain = {
          select() { op = op || 'select'; return chain; },
          update(fields) { op = 'update'; updateFields = fields; return chain; },
          eq(col, val) { filters.push({ col, val }); return chain; },
          is(col, val) { filters.push({ col, val: val === null ? undefined : val, isNull: val === null }); return chain; },
          order() { return chain; },
          limit() { return chain; },
          then(resolve, reject) {
            let result;
            const matches = (row) => filters.every((f) => (f.isNull ? (row[f.col] === null || row[f.col] === undefined) : row[f.col] === f.val));
            if (op === 'update') {
              state.items.filter(matches).forEach((it) => Object.assign(it, updateFields));
              result = { data: null, error: null };
            } else {
              result = { data: state.items.filter(matches), error: null };
            }
            return Promise.resolve(result).then(resolve, reject);
          },
        };
        return chain;
      }
      if (table === 'missive_message_intake_search_safe') {
        return { select() { return this; }, eq() { return this; }, order() { return this; }, then(resolve) { return Promise.resolve({ data: [conversationRow], error: null }).then(resolve); } };
      }
      if (table === 'missive_conversation_significance') {
        let insertRow = null;
        return {
          select() { return this; },
          upsert(row) { insertRow = row; return this; },
          single: () => { state.significanceUpserts.push(insertRow); return Promise.resolve({ data: { id: 'sig-integration-1', ...insertRow }, error: null }); },
        };
      }
      if (table === 'missive_message_links') return { insert: () => Promise.resolve({ data: null, error: null }) };
      if (table === 'properties' || table === 'vendors') return { select() { return this; }, eq() { return this; }, then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); } };
      throw new Error(`PART 18h fake: unexpected table "${table}"`);
    },
  };

  const rawResponseText = JSON.stringify({ resolution_status: 'open', category: 'routine_logistics', why: 'A routine test conversation.', tone_trend: 'stable' });
  const { client: anthropicClientFake } = makeFakeAnthropicBatchesClient({
    results: async () => asyncIterableFromArray([{ custom_id: 'tok-real', result: { type: 'succeeded', message: { content: [{ type: 'text', text: rawResponseText }] } } }]),
  });

  // Both DI seams — significancePass._setSupabaseClientForTesting() lets
  // the REAL (non-spied) applyCall1Result()/buildConversationContext() run
  // against the SAME fake client, and significanceBatch's own two setters
  // (already used by withFakeSignificanceBatch, above) cover
  // writeBackBatch()'s own direct table access. Neither touches
  // require.cache — see both files' own header comments on these setters
  // for why that specifically matters in this suite.
  significancePass._setSupabaseClientForTesting(fakeClient);
  const savedApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'fake-test-key-for-integration';

  try {
    await withFakeSignificanceBatch({ supabaseClient: fakeClient, anthropicClient: anthropicClientFake }, async (batchLib) => {
      const summary = await batchLib.writeBackBatch({ batchId: 'batch-1', anthropicBatchId: 'msgbatch_real' });
      assert.strictEqual(summary.processed, 1);
      assert.strictEqual(summary.written_significance, 1);
      assert.strictEqual(summary.errors, 0);
    });
  } finally {
    if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey; else delete process.env.ANTHROPIC_API_KEY;
    significancePass._setSupabaseClientForTesting(null);
  }

  assert.strictEqual(state.significanceUpserts.length, 1, 'expected exactly one REAL missive_conversation_significance upsert — proving applyCall1Result (not a reimplementation) actually ran');
  const upserted = state.significanceUpserts[0];
  assert.strictEqual(upserted.category, 'routine_logistics');
  assert.strictEqual(upserted.resolution_status, 'open');
  assert.strictEqual(upserted.discovery_context, 'historical_backfill');
  assert.strictEqual(upserted.extracted_by, significancePass.CONTENT_PASS_VERSION, 'expected the SAME version constant the synchronous pipeline stamps — proof this went through the shared write path, not a parallel one');

  const byToken = Object.fromEntries(state.items.map((it) => [it.token, it]));
  assert.ok(byToken['tok-real'].written_back_at, 'expected the batch item to be marked written back after a successful integration write');
});

// ─── 18h-2 — writeBackBatch concurrency fix (2026-09-20): the old
// one-at-a-time `for await` loop is now drained in WRITEBACK_CONCURRENCY-
// sized groups (drainInGroups()) with each group's items run concurrently
// (mapWithConcurrency()) — see writeBackBatch()'s own comment in lib/
// significance-batch.js. Three properties must survive the move off the
// sequential loop: (1) real concurrency, with totals unaffected by
// completion order, (2) unmatched (pending items that never appear in the
// stream at all) still counted correctly, (3) one item's error still only
// counted, never aborting the rest of a group. ────────────────────────────
  await runSerialCheck('significance-batch — writeBackBatch: processes items with REAL bounded concurrency (~WRITEBACK_CONCURRENCY) — completion order is deliberately scrambled via buildConversationContext\'s own delay, yet processed/written_significance/no_row_written/unmatched come out identical to what the old sequential loop would have produced', async () => {
  const N = 10;
  const itemRows = Array.from({ length: N }, (_, i) => ({ id: `item-${String(i).padStart(6, '0')}`, batch_id: 'batch-1', token: `tok-${i}`, mailbox_key: 'mb1', missive_conversation_id: `conv-${i}`, result_status: 'succeeded', written_back_at: null }));
  const { client: supabaseClient, state } = makeBatchTrackingFakeClient({ itemRows });

  let inFlight = 0, maxInFlight = 0;
  const contextSpy = spyOn(significancePass, 'buildConversationContext', async (mb, convId) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const n = Number(convId.split('-')[1]);
    await new Promise((resolve) => setTimeout(resolve, (N - n) * 3)); // conv-0 (first in the stream) resolves LAST, conv-9 resolves FIRST
    inFlight--;
    return { rows: [{ missive_message_id: `m-${n}`, screening_completed_at: '2026-01-01T00:00:00.000Z' }], thread: {}, addressMatch: {}, addressMatched: false, threadText: `text ${convId}` };
  });
  const parseSpy = spyOn(significancePass, 'parseCall1Response', () => ({ resolution_status: 'open', category: 'dispute', why: 'test', tone_trend: null, identification: { property_text: null, vendor_text: null } }));
  const applySpy = spyOn(significancePass, 'applyCall1Result', async () => ({ significanceId: 'sig-x', property_id: null, vendor_id: null, keywordCheck: { flagged_protected_class: false, flagged_category: null } }));
  const propDirSpy = spyOn(significancePass, 'fetchPropertyDirectory', async () => []);
  const vendorDirSpy = spyOn(significancePass, 'fetchVendorDirectory', async () => []);

  const fakeResults = itemRows.map((it) => ({ custom_id: it.token, result: { type: 'succeeded', message: { content: [{ type: 'text', text: '{}' }] } } }));
  const { client: anthropicClientFake } = makeFakeAnthropicBatchesClient({ results: async () => asyncIterableFromArray(fakeResults) });

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const summary = await freshBatchModule.writeBackBatch({ batchId: 'batch-1', anthropicBatchId: 'msgbatch_abc' });
      assert.strictEqual(summary.processed, N);
      assert.strictEqual(summary.written_significance, N);
      assert.strictEqual(summary.no_row_written, 0);
      assert.strictEqual(summary.errors, 0);
      assert.strictEqual(summary.unmatched, 0);
    });
  } finally {
    contextSpy.restore(); parseSpy.restore(); applySpy.restore(); propDirSpy.restore(); vendorDirSpy.restore();
  }

  assert.ok(maxInFlight > 1, `expected genuine concurrency (more than 1 buildConversationContext call in flight at once), saw ${maxInFlight}`);
  assert.ok(maxInFlight <= significanceBatch.WRITEBACK_CONCURRENCY, `expected concurrency capped at WRITEBACK_CONCURRENCY (${significanceBatch.WRITEBACK_CONCURRENCY}), saw ${maxInFlight}`);
  assert.strictEqual(applySpy.calls.length, N, 'expected every item to be individually applied exactly once, none skipped or duplicated');

  const byToken = Object.fromEntries(state.items.map((it) => [it.token, it]));
  itemRows.forEach((it) => assert.ok(byToken[it.token].written_back_at, `expected ${it.token} to be marked written back`));
});

  await runSerialCheck('significance-batch — writeBackBatch: unmatched still counts correctly under concurrent processing when some pending items never appear in the mocked results stream at all', async () => {
  const pendingCount = 10, appearingCount = 6;
  const itemRows = Array.from({ length: pendingCount }, (_, i) => ({ id: `item-${String(i).padStart(6, '0')}`, batch_id: 'batch-1', token: `tok-${i}`, mailbox_key: 'mb1', missive_conversation_id: `conv-${i}`, result_status: 'succeeded', written_back_at: null }));
  const { client: supabaseClient, state } = makeBatchTrackingFakeClient({ itemRows });

  const contextSpy = spyOn(significancePass, 'buildConversationContext', async (mb, convId) => {
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 6)); // real jitter — proves the count doesn't depend on any particular completion order
    return { rows: [{ missive_message_id: 'm1', screening_completed_at: '2026-01-01T00:00:00.000Z' }], thread: {}, addressMatch: {}, addressMatched: false, threadText: `text ${convId}` };
  });
  const parseSpy = spyOn(significancePass, 'parseCall1Response', () => ({ resolution_status: 'open', category: 'dispute', why: 'test', tone_trend: null, identification: { property_text: null, vendor_text: null } }));
  const applySpy = spyOn(significancePass, 'applyCall1Result', async () => ({ significanceId: 'sig-x', property_id: null, vendor_id: null, keywordCheck: { flagged_protected_class: false, flagged_category: null } }));
  const propDirSpy = spyOn(significancePass, 'fetchPropertyDirectory', async () => []);
  const vendorDirSpy = spyOn(significancePass, 'fetchVendorDirectory', async () => []);

  // Only the first 6 of 10 pending tokens ever show up in the stream — the
  // other 4 (tok-6..tok-9) never appear at all, simulating results
  // Anthropic never returned for whatever reason.
  const fakeResults = itemRows.slice(0, appearingCount).map((it) => ({ custom_id: it.token, result: { type: 'succeeded', message: { content: [{ type: 'text', text: '{}' }] } } }));
  const { client: anthropicClientFake } = makeFakeAnthropicBatchesClient({ results: async () => asyncIterableFromArray(fakeResults) });

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const summary = await freshBatchModule.writeBackBatch({ batchId: 'batch-1', anthropicBatchId: 'msgbatch_abc' });
      assert.strictEqual(summary.processed, appearingCount);
      assert.strictEqual(summary.unmatched, pendingCount - appearingCount, 'expected the 4 tokens that never appeared in the stream to be counted as unmatched');
    });
  } finally {
    contextSpy.restore(); parseSpy.restore(); applySpy.restore(); propDirSpy.restore(); vendorDirSpy.restore();
  }

  const byToken = Object.fromEntries(state.items.map((it) => [it.token, it]));
  for (let i = 0; i < appearingCount; i++) assert.ok(byToken[`tok-${i}`].written_back_at, `expected tok-${i} to be written back`);
  for (let i = appearingCount; i < pendingCount; i++) assert.strictEqual(byToken[`tok-${i}`].written_back_at, null, `expected tok-${i} (never in the stream) to remain un-written-back`);
});

  await runSerialCheck('significance-batch — writeBackBatch: under real concurrency (more items than WRITEBACK_CONCURRENCY), one item\'s error during applyCall1Result is caught and counted, never aborting the rest of the batch', async () => {
  const N = 10;
  const itemRows = Array.from({ length: N }, (_, i) => ({ id: `item-${String(i).padStart(6, '0')}`, batch_id: 'batch-1', token: `tok-${i}`, mailbox_key: 'mb1', missive_conversation_id: `conv-${i}`, result_status: 'succeeded', written_back_at: null }));
  const { client: supabaseClient, state } = makeBatchTrackingFakeClient({ itemRows });

  const contextSpy = spyOn(significancePass, 'buildConversationContext', async (mb, convId) => {
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 6));
    return { rows: [{ missive_message_id: 'm1', screening_completed_at: '2026-01-01T00:00:00.000Z' }], thread: {}, addressMatch: {}, addressMatched: false, threadText: `text ${convId}` };
  });
  const parseSpy = spyOn(significancePass, 'parseCall1Response', () => ({ resolution_status: 'open', category: 'dispute', why: 'test', tone_trend: null, identification: { property_text: null, vendor_text: null } }));
  const applySpy = spyOn(significancePass, 'applyCall1Result', async ({ missive_conversation_id }) => {
    if (missive_conversation_id === 'conv-4') throw new Error('simulated write failure for conv-4');
    return { significanceId: 'sig-x', property_id: null, vendor_id: null, keywordCheck: { flagged_protected_class: false, flagged_category: null } };
  });
  const propDirSpy = spyOn(significancePass, 'fetchPropertyDirectory', async () => []);
  const vendorDirSpy = spyOn(significancePass, 'fetchVendorDirectory', async () => []);

  const fakeResults = itemRows.map((it) => ({ custom_id: it.token, result: { type: 'succeeded', message: { content: [{ type: 'text', text: '{}' }] } } }));
  const { client: anthropicClientFake } = makeFakeAnthropicBatchesClient({ results: async () => asyncIterableFromArray(fakeResults) });

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const summary = await freshBatchModule.writeBackBatch({ batchId: 'batch-1', anthropicBatchId: 'msgbatch_abc' });
      assert.strictEqual(summary.errors, 1);
      assert.strictEqual(summary.processed, N - 1, 'expected every OTHER item to still be processed despite conv-4\'s failure');
      assert.strictEqual(summary.written_significance, N - 1);
    });
  } finally {
    contextSpy.restore(); parseSpy.restore(); applySpy.restore(); propDirSpy.restore(); vendorDirSpy.restore();
  }

  const byToken = Object.fromEntries(state.items.map((it) => [it.token, it]));
  assert.strictEqual(byToken['tok-4'].written_back_at, null, 'expected conv-4\'s item to remain un-written-back after its simulated failure (resumable on a later retry)');
  for (let i = 0; i < N; i++) {
    if (i === 4) continue;
    assert.ok(byToken[`tok-${i}`].written_back_at, `expected tok-${i} to still be written back despite tok-4's unrelated failure`);
  }
});

// ─── 18i — reportNeedsCall2: reuses the real needsCall2, scoped to only
// this batch's own conversations ───────────────────────────────────────────
  await runSerialCheck('significance-batch — reportNeedsCall2: reuses the REAL needsCall2 (spied, not reimplemented) and scopes its count to only this batch\'s own conversations', async () => {
  const needsCall2Spy = spyOn(significancePass, 'needsCall2', ({ category, resolution_status }) => category !== 'routine_logistics' || resolution_status !== 'resolved');
  const itemRows = [
    { batch_id: 'batch-1', token: 't1', mailbox_key: 'mb1', missive_conversation_id: 'conv-a', result_status: 'succeeded', written_back_at: 'x' },
    { batch_id: 'batch-1', token: 't2', mailbox_key: 'mb1', missive_conversation_id: 'conv-b', result_status: 'succeeded', written_back_at: 'x' },
  ];
  const significanceRows = [
    { mailbox_key: 'mb1', missive_conversation_id: 'conv-a', category: 'routine_logistics', resolution_status: 'resolved' }, // does NOT need Call 2
    { mailbox_key: 'mb1', missive_conversation_id: 'conv-b', category: 'dispute', resolution_status: 'open' }, // needs Call 2
  ];
  const { client: supabaseClient } = makeBatchTrackingFakeClient({ itemRows, significanceRows });
  const { client: anthropicClientFake } = makeFakeAnthropicBatchesClient({});

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const report = await freshBatchModule.reportNeedsCall2({ batchId: 'batch-1' });
      assert.strictEqual(report.totalWithSignificanceRow, 2);
      assert.strictEqual(report.needsCall2Count, 1);
      assert.deepStrictEqual(report.needsCall2List, [{ mailbox_key: 'mb1', missive_conversation_id: 'conv-b' }]);
    });
  } finally {
    needsCall2Spy.restore();
  }
  assert.ok(needsCall2Spy.calls.length >= 2, 'expected the REAL needsCall2 to be consulted for each matched conversation, not a reimplemented equivalent');
  });

// ============================================================================
// PART 19 (continued, same sequential runner as PART 18 — deliberately NOT a
// separate asyncResults.push((async()=>{...})()) IIFE: a second, concurrently
// running IIFE spying on the SAME significancePass object would reintroduce
// exactly the race PART 18's own header comment documents finding and fixing.
// Appending here keeps every spyOn() in this whole file strictly serialized).
// ============================================================================

// ─── 19a — the single most important property given tonight's incident:
// fetchNextEligibleConversations is called EXACTLY ONCE per startSubmissionRun,
// and its full result is durably recorded (assembled_at/eligible_count set,
// every pair persisted in order) before the call returns ────────────────────
  await runSerialCheck('significance-batch — startSubmissionRun: calls fetchNextEligibleConversations EXACTLY ONCE, and durably records the run row + every submission_run_item (in order) BEFORE returning', async () => {
  const pairs = [
    { mailbox_key: 'mb1', missive_conversation_id: 'conv-1' },
    { mailbox_key: 'mb1', missive_conversation_id: 'conv-2' },
    { mailbox_key: 'mb1', missive_conversation_id: 'conv-3' },
  ];
  const fetchSpy = spyOn(significancePass, 'fetchNextEligibleConversations', async () => pairs);
  const { client: supabaseClient, state } = makeRunTrackingFakeClient({});
  const { client: anthropicClientFake } = makeFakeAnthropicBatchesClient({});

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const result = await freshBatchModule.startSubmissionRun({ stage: 'call_1', sinceDate: '2025-09-17' });
      assert.strictEqual(result.started, true);
      assert.strictEqual(result.eligibleCount, 3);
      assert.ok(result.run.assembled_at, 'expected assembled_at to be set — the durability checkpoint');
      assert.strictEqual(result.run.eligible_count, 3);
    });
  } finally {
    fetchSpy.restore();
  }

  assert.strictEqual(fetchSpy.calls.length, 1, 'THE key property: fetchNextEligibleConversations must be called EXACTLY once per startSubmissionRun call — this is the entire no-double-submission/no-double-scan guarantee tonight\'s incident needs');
  assert.strictEqual(state.runItems.length, 3, 'expected one submission_run_item per eligible pair, durably recorded');
  assert.deepStrictEqual(state.runItems.map((it) => it.sequence_in_run), [0, 1, 2], 'expected sequence_in_run to preserve the exact order fetchNextEligibleConversations returned');
  assert.deepStrictEqual(new Set(state.runItems.map((it) => it.missive_conversation_id)), new Set(['conv-1', 'conv-2', 'conv-3']));
});

// ─── 19b — the one-active-run-per-stage guard ─────────────────────────────
  await runSerialCheck('significance-batch — startSubmissionRun: an existing unfinished run for the stage refuses to start a new one, and makes ZERO calls to fetchNextEligibleConversations — never re-running the expensive scan while a run is still active', async () => {
  const existingRun = { id: 'run-existing', stage: 'call_1', assembled_at: new Date().toISOString(), eligible_count: 5, fully_processed_at: null, failed_at: null };
  const fetchSpy = spyOn(significancePass, 'fetchNextEligibleConversations', async () => { throw new Error('fetchNextEligibleConversations should NEVER be called while a run is already active'); });
  const { client: supabaseClient } = makeRunTrackingFakeClient({ runRow: existingRun });
  const { client: anthropicClientFake } = makeFakeAnthropicBatchesClient({});

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const result = await freshBatchModule.startSubmissionRun({ stage: 'call_1' });
      assert.strictEqual(result.started, false);
      assert.strictEqual(result.reason, 'unfinished_run_exists');
      assert.strictEqual(result.run.id, 'run-existing');
    });
  } finally {
    fetchSpy.restore();
  }
  assert.strictEqual(fetchSpy.calls.length, 0, 'expected ZERO calls to the expensive eligibility scan while a run is already active');
});

// ─── 19c — chunk-boundary logic, REQUEST COUNT as the binding constraint ──
  await runSerialCheck('significance-batch — dispatchRunChunks: cuts chunks on REQUEST COUNT when maxRequests is the binding constraint (5 small conversations, maxRequests=2) — submits 3 separate Anthropic batches in order, chunk_number 0/1/2, every item ends up dispatched', async () => {
  const runId = 'run-count-cut';
  const runRow = { id: runId, stage: 'call_1', since_date: null, assembled_at: new Date().toISOString(), eligible_count: 5, fully_processed_at: null, failed_at: null };
  const runItemRows = [1, 2, 3, 4, 5].map((n) => ({ id: `ri-${n}`, run_id: runId, sequence_in_run: n - 1, mailbox_key: 'mb1', missive_conversation_id: `conv-${n}`, chunk_number: null, batch_id: null, dispatched_at: null }));
  const { client: supabaseClient, state } = makeRunTrackingFakeClient({ runRow, runItemRows });

  const contextSpy = spyOn(significancePass, 'buildConversationContext', async (mb, convId) => ({ addressMatched: false, threadText: `text for ${convId}` }));
  const promptSpy = spyOn(significancePass, 'buildCall1Prompt', ({ threadText }) => threadText);
  // Neutralizes the 2026-09-19 expected-pool sanity check (dispatchRunChunks
  // now calls this before dispatching anything) — this test's own subject is
  // chunk-cutting, not the sanity check, so the estimate is stubbed to
  // exactly match eligible_count (ratio 1.0), guaranteeing a pass. PART 19h/
  // 19j-19l test the sanity check itself.
  const poolSpy = spyOn(significancePass, 'estimateExpectedEligiblePool', async () => ({ expectedPool: runRow.eligible_count, totalMatchingConversations: runRow.eligible_count, totalAlreadyProcessed: 0 }));
  let createCount = 0;
  const { client: anthropicClientFake, calls: anthropicCalls } = makeFakeAnthropicBatchesClient({
    create: async () => { createCount++; return { id: `msgbatch_chunk${createCount}`, processing_status: 'in_progress' }; },
  });

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const summary = await freshBatchModule.dispatchRunChunks({ runId, maxRequests: 2, maxBytes: 10000000 });
      assert.strictEqual(summary.chunksSubmitted, 3, 'expected 5 items split into chunks of 2, 2, 1 by request count alone');
      assert.strictEqual(summary.itemsDispatched, 5);
    });
  } finally {
    contextSpy.restore(); promptSpy.restore(); poolSpy.restore();
  }

  assert.strictEqual(anthropicCalls.create.length, 3);
  assert.deepStrictEqual(anthropicCalls.create.map(([{ requests }]) => requests.length), [2, 2, 1]);
  assert.strictEqual(state.batches.length, 3);
  assert.deepStrictEqual(state.batches.map((b) => b.chunk_number).sort((a, b) => a - b), [0, 1, 2]);
  assert.ok(state.runItems.every((it) => it.batch_id != null), 'expected every run item to have been assigned a batch_id');
});

// ─── 19d — chunk-boundary logic, REAL BYTE SIZE as the binding constraint —
// the exact fix for tonight's 413 ──────────────────────────────────────────
  await runSerialCheck('significance-batch — dispatchRunChunks: cuts a chunk on REAL BYTE SIZE (Buffer.byteLength, not .length) when one conversation\'s own request is individually large enough to force it, even though the request count is nowhere near maxRequests', async () => {
  const runId = 'run-byte-cut';
  const bigText = 'é'.repeat(200); // each 'é' is 2 UTF-8 bytes but 1 UTF-16 code unit — proves REAL byte counting, not .length, drives the cut
  const runRow = { id: runId, stage: 'call_1', since_date: null, assembled_at: new Date().toISOString(), eligible_count: 2, fully_processed_at: null, failed_at: null };
  const runItemRows = [
    { id: 'ri-big', run_id: runId, sequence_in_run: 0, mailbox_key: 'mb1', missive_conversation_id: 'conv-big', chunk_number: null, batch_id: null, dispatched_at: null },
    { id: 'ri-small', run_id: runId, sequence_in_run: 1, mailbox_key: 'mb1', missive_conversation_id: 'conv-small', chunk_number: null, batch_id: null, dispatched_at: null },
  ];
  const { client: supabaseClient, state } = makeRunTrackingFakeClient({ runRow, runItemRows });

  const contextSpy = spyOn(significancePass, 'buildConversationContext', async (mb, convId) => ({ addressMatched: false, threadText: convId === 'conv-big' ? bigText : 'x' }));
  const promptSpy = spyOn(significancePass, 'buildCall1Prompt', ({ threadText }) => threadText);
  // Neutralizes the 2026-09-19 expected-pool sanity check — see 19c's own
  // identical comment; this test's own subject is byte-size chunk-cutting.
  const poolSpy = spyOn(significancePass, 'estimateExpectedEligiblePool', async () => ({ expectedPool: runRow.eligible_count, totalMatchingConversations: runRow.eligible_count, totalAlreadyProcessed: 0 }));
  let createCount = 0;
  const { client: anthropicClientFake, calls: anthropicCalls } = makeFakeAnthropicBatchesClient({
    create: async () => { createCount++; return { id: `msgbatch_bytecut${createCount}`, processing_status: 'in_progress' }; },
  });

  // Real byte size of the big request, via the module's own exported
  // sizeOfRequestBytes — maxBytes is then set just ABOVE it, so the cut this
  // test proves is driven by a real measured size, not a hardcoded guess
  // about how 200 'é' characters happen to serialize.
  const bigRequestBytes = significanceBatch.sizeOfRequestBytes({
    custom_id: 'x'.repeat(12), // real tokens are always exactly 12 base64url chars (crypto.randomBytes(9)) — same length, so byte-identical to a real request for sizing purposes
    params: { model: 'claude-sonnet-5', max_tokens: 1024, output_config: { effort: 'medium' }, messages: [{ role: 'user', content: [{ type: 'text', text: bigText }] }] },
  });

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const summary = await freshBatchModule.dispatchRunChunks({ runId, maxRequests: 1000, maxBytes: bigRequestBytes + 1 });
      assert.strictEqual(summary.chunksSubmitted, 2, 'expected the big request to occupy its own chunk, forcing the small one into a second chunk');
    });
  } finally {
    contextSpy.restore(); promptSpy.restore(); poolSpy.restore();
  }

  assert.strictEqual(anthropicCalls.create.length, 2);
  assert.strictEqual(anthropicCalls.create[0][0].requests.length, 1, 'expected the big conversation alone in the first chunk (sequence order preserved — it was sequence_in_run 0)');
  assert.ok(anthropicCalls.create[0][0].requests[0].params.messages[0].content[0].text.includes('é'), 'expected the big-text conversation to be the one placed first');
  assert.strictEqual(anthropicCalls.create[1][0].requests[0].params.messages[0].content[0].text, 'x');
});

// ─── 19e — resumability: an item that already has batch_id set is skipped
// entirely by a later dispatchRunChunks call ───────────────────────────────
  await runSerialCheck('significance-batch — dispatchRunChunks: resumable after a simulated partial failure — an item that already has batch_id set (dispatched by an earlier, interrupted call) is skipped entirely; only the genuinely undispatched items are built into new requests and submitted, with chunk numbering resuming after the existing chunk rather than colliding with it', async () => {
  const runId = 'run-resume';
  const runRow = { id: runId, stage: 'call_1', since_date: null, assembled_at: new Date().toISOString(), eligible_count: 3, fully_processed_at: null, failed_at: null };
  const runItemRows = [
    { id: 'ri-1', run_id: runId, sequence_in_run: 0, mailbox_key: 'mb1', missive_conversation_id: 'conv-already-dispatched', chunk_number: 0, batch_id: 'batch-earlier', dispatched_at: '2026-09-18T00:00:00.000Z' },
    { id: 'ri-2', run_id: runId, sequence_in_run: 1, mailbox_key: 'mb1', missive_conversation_id: 'conv-2', chunk_number: null, batch_id: null, dispatched_at: null },
    { id: 'ri-3', run_id: runId, sequence_in_run: 2, mailbox_key: 'mb1', missive_conversation_id: 'conv-3', chunk_number: null, batch_id: null, dispatched_at: null },
  ];
  const batchRows = [{ id: 'batch-earlier', stage: 'call_1', anthropic_batch_id: 'msgbatch_earlier', anthropic_status: 'in_progress', run_id: runId, chunk_number: 0, completed_at: null, failed_at: null, results_retrieved_at: null }];
  const { client: supabaseClient, state } = makeRunTrackingFakeClient({ runRow, runItemRows, batchRows });

  const contextSpy = spyOn(significancePass, 'buildConversationContext', async (mb, convId) => {
    assert.notStrictEqual(convId, 'conv-already-dispatched', 'expected the already-dispatched item to NEVER be re-fetched/re-built');
    return { addressMatched: false, threadText: `text ${convId}` };
  });
  const promptSpy = spyOn(significancePass, 'buildCall1Prompt', ({ threadText }) => threadText);
  // Neutralizes the 2026-09-19 expected-pool sanity check — see 19c's own
  // identical comment; this test's own subject is resumability.
  const poolSpy = spyOn(significancePass, 'estimateExpectedEligiblePool', async () => ({ expectedPool: runRow.eligible_count, totalMatchingConversations: runRow.eligible_count, totalAlreadyProcessed: 0 }));
  const { client: anthropicClientFake, calls: anthropicCalls } = makeFakeAnthropicBatchesClient({
    create: async () => ({ id: 'msgbatch_resumed', processing_status: 'in_progress' }),
  });

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const summary = await freshBatchModule.dispatchRunChunks({ runId });
      assert.strictEqual(summary.chunksSubmitted, 1);
      assert.strictEqual(summary.itemsDispatched, 2, 'expected only the two genuinely undispatched items to be dispatched');
    });
  } finally {
    contextSpy.restore(); promptSpy.restore(); poolSpy.restore();
  }

  assert.strictEqual(anthropicCalls.create.length, 1);
  assert.strictEqual(anthropicCalls.create[0][0].requests.length, 2);
  const newBatch = state.batches.find((b) => b.id !== 'batch-earlier');
  assert.ok(newBatch, 'expected a new batch row for the newly dispatched chunk');
  assert.strictEqual(newBatch.chunk_number, 1, 'expected chunk numbering to resume after the existing chunk_number 0, not collide with it');
  const alreadyDispatchedItem = state.runItems.find((it) => it.id === 'ri-1');
  assert.strictEqual(alreadyDispatchedItem.batch_id, 'batch-earlier', 'expected the already-dispatched item to be completely untouched');
});

// ─── 19f — a 429 leaves that chunk's items undispatched, never crashes the
// whole dispatch, and a later call retries exactly those items ────────────
  await runSerialCheck('significance-batch — dispatchRunChunks: a 429 (rate limit) from Anthropic on one chunk leaves that chunk\'s items undispatched (batch_id stays NULL) rather than crashing the whole dispatch — later chunks still get attempted, and a later dispatchRunChunks call retries exactly the rate-limited items', async () => {
  const runId = 'run-429';
  const runRow = { id: runId, stage: 'call_1', since_date: null, assembled_at: new Date().toISOString(), eligible_count: 4, fully_processed_at: null, failed_at: null };
  const runItemRows = [1, 2, 3, 4].map((n) => ({ id: `ri-${n}`, run_id: runId, sequence_in_run: n - 1, mailbox_key: 'mb1', missive_conversation_id: `conv-${n}`, chunk_number: null, batch_id: null, dispatched_at: null }));
  const { client: supabaseClient, state } = makeRunTrackingFakeClient({ runRow, runItemRows });

  const contextSpy = spyOn(significancePass, 'buildConversationContext', async (mb, convId) => ({ addressMatched: false, threadText: `text ${convId}` }));
  const promptSpy = spyOn(significancePass, 'buildCall1Prompt', ({ threadText }) => threadText);
  // Neutralizes the 2026-09-19 expected-pool sanity check — see 19c's own
  // identical comment; this test's own subject is 429 handling. Left active
  // across BOTH dispatchRunChunks calls below (the initial rate-limited
  // attempt and the later retry) since both have undispatched items and so
  // both now run the check.
  const poolSpy = spyOn(significancePass, 'estimateExpectedEligiblePool', async () => ({ expectedPool: runRow.eligible_count, totalMatchingConversations: runRow.eligible_count, totalAlreadyProcessed: 0 }));

  try {
    let createCallCount = 0;
    const rateLimitError = new Error('Rate limited');
    rateLimitError.status = 429; // matches @anthropic-ai/sdk's real RateLimitError shape (error.js: this.status = 429) — confirmed against the installed SDK, not assumed
    const { client: anthropicClientFake, calls: anthropicCalls } = makeFakeAnthropicBatchesClient({
      create: async () => {
        createCallCount++;
        if (createCallCount === 1) throw rateLimitError; // first chunk (conv-1, conv-2) rate-limited
        return { id: `msgbatch_after429_${createCallCount}`, processing_status: 'in_progress' };
      },
    });

    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const summary = await freshBatchModule.dispatchRunChunks({ runId, maxRequests: 2, maxBytes: 10000000 });
      assert.strictEqual(summary.chunksRateLimited, 1, 'expected the first chunk\'s 429 to be counted, never thrown');
      assert.strictEqual(summary.chunksSubmitted, 1, 'expected the SECOND chunk to still be attempted and succeed despite the first one\'s 429');
      assert.strictEqual(summary.itemsDispatched, 2);
    });

    assert.strictEqual(anthropicCalls.create.length, 2, 'expected both chunks to have been attempted — a 429 on one must not abort the whole dispatch loop');
    for (const convId of ['conv-1', 'conv-2']) {
      assert.strictEqual(state.runItems.find((r) => r.missive_conversation_id === convId).batch_id, null, `expected ${convId} (rate-limited chunk) to remain undispatched`);
    }
    for (const convId of ['conv-3', 'conv-4']) {
      assert.ok(state.runItems.find((r) => r.missive_conversation_id === convId).batch_id, `expected ${convId} (successfully submitted chunk) to have a batch_id`);
    }

    // A later call (e.g. the next cron run) retries EXACTLY the previously
    // rate-limited items — the real resumability guarantee this design
    // exists to provide.
    const { client: anthropicClientFake2, calls: anthropicCalls2 } = makeFakeAnthropicBatchesClient({
      create: async () => ({ id: 'msgbatch_retry', processing_status: 'in_progress' }),
    });
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake2 }, async (freshBatchModule) => {
      const summary2 = await freshBatchModule.dispatchRunChunks({ runId, maxRequests: 2, maxBytes: 10000000 });
      assert.strictEqual(summary2.chunksSubmitted, 1);
      assert.strictEqual(summary2.itemsDispatched, 2, 'expected exactly the two previously rate-limited items to be retried, nothing else');
    });
    assert.strictEqual(anthropicCalls2.create.length, 1);
    assert.strictEqual(anthropicCalls2.create[0][0].requests.length, 2);
    for (const convId of ['conv-1', 'conv-2']) {
      assert.ok(state.runItems.find((r) => r.missive_conversation_id === convId).batch_id, `expected ${convId} to be dispatched on the retry`);
    }
  } finally {
    contextSpy.restore(); promptSpy.restore(); poolSpy.restore();
  }
});

// ─── 19g — checkAndResumeRun loops the unchanged per-batch logic over every
// chunk of a run, and only marks the run fully processed once ALL chunks
// have reached completed_at ─────────────────────────────────────────────
  await runSerialCheck('significance-batch — checkAndResumeRun: loops the EXISTING per-batch checkAndResumeOneBatch/writeBackBatch/maybeMarkBatchCompleted logic over every batch in a run, and only sets the run\'s fully_processed_at once EVERY chunk has reached completed_at — not merely once every chunk has ended at Anthropic', async () => {
  const runId = 'run-multi-chunk';
  const runRow = { id: runId, stage: 'call_1', since_date: null, assembled_at: new Date().toISOString(), eligible_count: 2, fully_processed_at: null, failed_at: null };
  const batchRows = [
    { id: 'batch-a', stage: 'call_1', anthropic_batch_id: 'msgbatch_a', anthropic_status: 'in_progress', run_id: runId, chunk_number: 0, completed_at: null, failed_at: null, results_retrieved_at: null },
    { id: 'batch-b', stage: 'call_1', anthropic_batch_id: 'msgbatch_b', anthropic_status: 'in_progress', run_id: runId, chunk_number: 1, completed_at: null, failed_at: null, results_retrieved_at: null },
  ];
  const batchItemRows = [
    { id: 'bi-a1', batch_id: 'batch-a', token: 'tok-a1', mailbox_key: 'mb1', missive_conversation_id: 'conv-a1', result_status: 'pending', written_back_at: null },
    { id: 'bi-b1', batch_id: 'batch-b', token: 'tok-b1', mailbox_key: 'mb1', missive_conversation_id: 'conv-b1', result_status: 'pending', written_back_at: null },
  ];
  const { client: supabaseClient, state } = makeRunTrackingFakeClient({ runRow, batchRows, batchItemRows });

  const contextSpy = spyOn(significancePass, 'buildConversationContext', async () => ({ rows: [{ missive_message_id: 'm1' }], thread: {}, addressMatch: {}, addressMatched: false, threadText: 'x' }));
  const parseSpy = spyOn(significancePass, 'parseCall1Response', () => ({ resolution_status: 'open', category: 'dispute', why: 'test', tone_trend: null, identification: { property_text: null, vendor_text: null } }));
  const applySpy = spyOn(significancePass, 'applyCall1Result', async () => ({}));
  const propDirSpy = spyOn(significancePass, 'fetchPropertyDirectory', async () => []);
  const vendorDirSpy = spyOn(significancePass, 'fetchVendorDirectory', async () => []);

  try {
    // Round 1: batch-a has ENDED at Anthropic; batch-b is still in_progress.
    const { client: anthropicClientFake1 } = makeFakeAnthropicBatchesClient({
      retrieve: async (id) => (id === 'msgbatch_a' ? { processing_status: 'ended' } : { processing_status: 'in_progress' }),
      results: async () => asyncIterableFromArray([{ custom_id: 'tok-a1', result: { type: 'succeeded', message: { content: [{ type: 'text', text: '{}' }] } } }]),
    });
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake1 }, async (freshBatchModule) => {
      const outcome = await freshBatchModule.checkAndResumeRun({ runId });
      assert.strictEqual(outcome.fullyProcessed, false, 'expected NOT fully processed — batch-b has not even ended yet at Anthropic');
    });
    assert.ok(state.batches.find((b) => b.id === 'batch-a').completed_at, 'expected batch-a to be fully written back and marked completed');
    assert.strictEqual(state.batches.find((b) => b.id === 'batch-b').completed_at, null);
    assert.strictEqual(state.run.fully_processed_at, null);

    // Round 2: batch-b now also ends.
    const { client: anthropicClientFake2 } = makeFakeAnthropicBatchesClient({
      retrieve: async () => ({ processing_status: 'ended' }),
      results: async () => asyncIterableFromArray([{ custom_id: 'tok-b1', result: { type: 'succeeded', message: { content: [{ type: 'text', text: '{}' }] } } }]),
    });
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake2 }, async (freshBatchModule) => {
      const outcome2 = await freshBatchModule.checkAndResumeRun({ runId });
      assert.strictEqual(outcome2.fullyProcessed, true, 'expected fully processed once EVERY chunk has reached completed_at');
    });
    assert.ok(state.run.fully_processed_at, 'expected the run row itself to have fully_processed_at set');
  } finally {
    contextSpy.restore(); parseSpy.restore(); applySpy.restore(); propDirSpy.restore(); vendorDirSpy.restore();
  }
  });

// ─── 19h — buildDispatchEntries concurrency fix (2026-09-19): output order
// matches INPUT order despite deliberately scrambled completion times, real
// bounded concurrency, and token uniqueness all survive the move off the
// old one-at-a-time `for...of` loop ─────────────────────────────────────────
  await runSerialCheck('significance-batch — buildDispatchEntries: entries come back in the SAME order as the input items even when buildConversationContext resolves in a deliberately scrambled (reverse) order, concurrency never exceeds the requested limit, and every token is still unique', async () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ id: `ri-${i}`, sequence_in_run: i, mailbox_key: 'mb1', missive_conversation_id: `conv-${i}` }));
  let inFlight = 0;
  let maxInFlight = 0;

  const contextSpy = spyOn(significancePass, 'buildConversationContext', async (mb, convId) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const n = Number(convId.split('-')[1]);
    await new Promise((resolve) => setTimeout(resolve, (items.length - n) * 4)); // conv-0 (first in input order) resolves LAST
    inFlight--;
    return { addressMatched: false, threadText: `text ${convId}` };
  });
  const promptSpy = spyOn(significancePass, 'buildCall1Prompt', ({ threadText }) => threadText);

  try {
    const { entries, skippedEmpty, skippedOversized } = await significanceBatch.buildDispatchEntries(items, 'call_1', significanceBatch.MAX_BATCH_BYTES, 3);
    assert.strictEqual(entries.length, 9);
    assert.deepStrictEqual(entries.map((e) => e.item.missive_conversation_id), items.map((it) => it.missive_conversation_id), 'expected entries in the exact same order as the input items, not completion order');
    assert.strictEqual(skippedEmpty, 0);
    assert.strictEqual(skippedOversized, 0);
    assert.ok(maxInFlight <= 3, `expected concurrency capped at the requested limit of 3, saw ${maxInFlight} in flight at once`);
    assert.ok(maxInFlight > 1, 'expected genuine concurrency (more than 1 in flight at some point) — a maxInFlight of 1 would mean this silently regressed to sequential execution');

    const tokens = entries.map((e) => e.token);
    assert.strictEqual(new Set(tokens).size, tokens.length, 'expected every token to be unique across the whole concurrent run');
  } finally {
    contextSpy.restore(); promptSpy.restore();
  }
});

// ─── 19i — skipped_empty/skipped_oversized counting survives concurrency,
// and the surviving entries still preserve input order around the gaps ─────
  await runSerialCheck('significance-batch — buildDispatchEntries: skipped_empty (context disappeared) and skipped_oversized (single request over the byte cap) are both still correctly counted under concurrent execution, with the surviving entries preserving their original relative order', async () => {
  const items = [
    { id: 'ri-0', mailbox_key: 'mb1', missive_conversation_id: 'conv-0' },
    { id: 'ri-1', mailbox_key: 'mb1', missive_conversation_id: 'conv-1-missing' }, // context disappeared -> skipped_empty
    { id: 'ri-2', mailbox_key: 'mb1', missive_conversation_id: 'conv-2' },
    { id: 'ri-3', mailbox_key: 'mb1', missive_conversation_id: 'conv-3-big' }, // oversized -> skipped_oversized
    { id: 'ri-4', mailbox_key: 'mb1', missive_conversation_id: 'conv-4' },
  ];
  const bigText = 'x'.repeat(1000);
  const contextSpy = spyOn(significancePass, 'buildConversationContext', async (mb, convId) => {
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 10)); // real jitter — proves the correct counts don't depend on any particular completion order
    if (convId === 'conv-1-missing') return null;
    if (convId === 'conv-3-big') return { addressMatched: false, threadText: bigText };
    return { addressMatched: false, threadText: `text ${convId}` };
  });
  const promptSpy = spyOn(significancePass, 'buildCall1Prompt', ({ threadText }) => threadText);

  // maxBytes set just above a normal (small) request's real size but below
  // the big one's — same technique test 19d already uses to force the cut
  // off a real measured size rather than a hardcoded guess.
  const smallRequestBytes = significanceBatch.sizeOfRequestBytes({
    custom_id: 'x'.repeat(12),
    params: { model: 'claude-sonnet-5', max_tokens: 1024, output_config: { effort: 'medium' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'text conv-0' }] }] },
  });

  try {
    const { entries, skippedEmpty, skippedOversized } = await significanceBatch.buildDispatchEntries(items, 'call_1', smallRequestBytes + 50, 3);
    assert.strictEqual(skippedEmpty, 1, 'expected exactly one skipped_empty (conv-1-missing)');
    assert.strictEqual(skippedOversized, 1, 'expected exactly one skipped_oversized (conv-3-big)');
    assert.strictEqual(entries.length, 3, 'expected the 3 surviving normal items');
    assert.deepStrictEqual(entries.map((e) => e.item.missive_conversation_id), ['conv-0', 'conv-2', 'conv-4'], 'expected the surviving entries in the same relative order as the input, with the skipped items\' gaps simply closed up');
  } finally {
    contextSpy.restore(); promptSpy.restore();
  }
});

// ─── 19j — the expected-pool sanity check ITSELF, wired live into
// dispatchRunChunks: a failing ratio (tonight's real incident shape, scaled
// down) refuses to dispatch anything, makes ZERO Anthropic calls, and never
// even builds a single conversation's request ──────────────────────────────
  await runSerialCheck('significance-batch — dispatchRunChunks: REFUSES to dispatch when the expected-pool sanity check fails (tonight\'s real ~40% incident shape, scaled down to 337-of-842) — zero Anthropic calls, every item stays undispatched, nothing lost', async () => {
  const runId = 'run-sanity-fail';
  const runRow = { id: runId, stage: 'call_1', since_date: '2025-09-17', assembled_at: new Date().toISOString(), eligible_count: 337, fully_processed_at: null, failed_at: null };
  const runItemRows = [1, 2, 3].map((n) => ({ id: `ri-${n}`, run_id: runId, sequence_in_run: n - 1, mailbox_key: 'mb1', missive_conversation_id: `conv-${n}`, chunk_number: null, batch_id: null, dispatched_at: null }));
  const { client: supabaseClient, state } = makeRunTrackingFakeClient({ runRow, runItemRows });

  // 337 / 842 ≈ 40.0% — the same ratio as the real 2026-09-18 incident.
  const poolSpy = spyOn(significancePass, 'estimateExpectedEligiblePool', async (sinceDate) => {
    assert.strictEqual(sinceDate, '2025-09-17', 'expected the run\'s own since_date to be threaded through to the estimate');
    return { expectedPool: 842, totalMatchingConversations: 900, totalAlreadyProcessed: 58 };
  });
  const contextSpy = spyOn(significancePass, 'buildConversationContext', async () => { throw new Error('buildConversationContext should NEVER be called — a failing sanity check must block BEFORE any per-conversation dispatch work begins'); });
  const { client: anthropicClientFake, calls: anthropicCalls } = makeFakeAnthropicBatchesClient({});

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const summary = await freshBatchModule.dispatchRunChunks({ runId });
      assert.strictEqual(summary.blockedBySanityCheck, true);
      assert.strictEqual(summary.chunksSubmitted, 0);
      assert.strictEqual(summary.itemsDispatched, 0);
      assert.strictEqual(summary.sanityCheck.passed, false);
      assert.strictEqual(summary.sanityCheck.eligibleCount, 337);
      assert.strictEqual(summary.sanityCheck.expectedPool, 842);
      assert.ok(Math.abs(summary.sanityCheck.ratio - (337 / 842)) < 1e-9);
    });
  } finally {
    poolSpy.restore(); contextSpy.restore();
  }

  assert.strictEqual(anthropicCalls.create.length, 0, 'expected ZERO Anthropic calls when the sanity check fails');
  assert.ok(state.runItems.every((it) => it.batch_id == null), 'expected every item to remain undispatched — the run\'s durably-saved eligible list is untouched, nothing lost, nothing silently sent');
});

// ─── 19k — force: true bypasses a failing check for exactly this one call,
// never persisted anywhere on the run row ───────────────────────────────────
  await runSerialCheck('significance-batch — dispatchRunChunks: force: true bypasses a failing sanity check for this one call and dispatches normally — the deliberate human override this design requires, never a persisted decision (estimateExpectedEligiblePool is never even called)', async () => {
  const runId = 'run-sanity-forced';
  const runRow = { id: runId, stage: 'call_1', since_date: null, assembled_at: new Date().toISOString(), eligible_count: 2, fully_processed_at: null, failed_at: null };
  const runItemRows = [1, 2].map((n) => ({ id: `ri-${n}`, run_id: runId, sequence_in_run: n - 1, mailbox_key: 'mb1', missive_conversation_id: `conv-${n}`, chunk_number: null, batch_id: null, dispatched_at: null }));
  const { client: supabaseClient, state } = makeRunTrackingFakeClient({ runRow, runItemRows });

  const poolSpy = spyOn(significancePass, 'estimateExpectedEligiblePool', async () => { throw new Error('estimateExpectedEligiblePool should NEVER be called when force: true is passed — the whole point of force is to skip the check, not to check and ignore the result'); });
  const contextSpy = spyOn(significancePass, 'buildConversationContext', async (mb, convId) => ({ addressMatched: false, threadText: `text ${convId}` }));
  const promptSpy = spyOn(significancePass, 'buildCall1Prompt', ({ threadText }) => threadText);
  const { client: anthropicClientFake, calls: anthropicCalls } = makeFakeAnthropicBatchesClient({
    create: async () => ({ id: 'msgbatch_forced', processing_status: 'in_progress' }),
  });

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const summary = await freshBatchModule.dispatchRunChunks({ runId, force: true });
      assert.strictEqual(summary.blockedBySanityCheck, false);
      assert.strictEqual(summary.chunksSubmitted, 1);
      assert.strictEqual(summary.itemsDispatched, 2);
    });
  } finally {
    poolSpy.restore(); contextSpy.restore(); promptSpy.restore();
  }

  assert.strictEqual(anthropicCalls.create.length, 1, 'expected the dispatch to actually go through under force: true');
  assert.ok(state.runItems.every((it) => it.batch_id != null), 'expected every item to actually be dispatched under force: true');
});

// ─── 19l — a run with nothing new to dispatch skips the sanity check
// entirely — there is nothing left to protect once every item is already
// sent, so this must never fire an extra, pointless (or blocking) check ────
  await runSerialCheck('significance-batch — dispatchRunChunks: a run with nothing left to dispatch skips the sanity check entirely (never calls estimateExpectedEligiblePool) — an already-fully-dispatched run\'s resume/poll path must never be gated on a fresh count query', async () => {
  const runId = 'run-nothing-to-dispatch';
  const runRow = { id: runId, stage: 'call_1', since_date: null, assembled_at: new Date().toISOString(), eligible_count: 1, fully_processed_at: null, failed_at: null };
  const runItemRows = [
    { id: 'ri-1', run_id: runId, sequence_in_run: 0, mailbox_key: 'mb1', missive_conversation_id: 'conv-1', chunk_number: 0, batch_id: 'batch-done', dispatched_at: '2026-09-18T00:00:00.000Z' },
  ];
  const { client: supabaseClient } = makeRunTrackingFakeClient({ runRow, runItemRows });

  const poolSpy = spyOn(significancePass, 'estimateExpectedEligiblePool', async () => { throw new Error('estimateExpectedEligiblePool should NEVER be called when there is nothing undispatched left for this run'); });
  const { client: anthropicClientFake, calls: anthropicCalls } = makeFakeAnthropicBatchesClient({});

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const summary = await freshBatchModule.dispatchRunChunks({ runId });
      assert.strictEqual(summary.blockedBySanityCheck, false);
      assert.strictEqual(summary.chunksSubmitted, 0);
    });
  } finally {
    poolSpy.restore();
  }
  assert.strictEqual(anthropicCalls.create.length, 0);
});

// ─── 19m — a healthy ratio just above the 70% threshold proceeds normally
// through the REAL checkEligiblePoolSanity()/evaluatePoolRatio() wiring —
// unlike 19c-19f above, this is NOT neutralized to a flat 100% stub, so it
// actually exercises the real comparison math end-to-end ───────────────────
  await runSerialCheck('significance-batch — dispatchRunChunks: a healthy ratio just above the 70% threshold (71%) proceeds normally through the REAL checkEligiblePoolSanity/evaluatePoolRatio wiring, not a neutralized 100% stub', async () => {
  const runId = 'run-sanity-pass';
  // eligible_count/runItemRows are deliberately independent here (1 real
  // item row is enough to prove dispatch actually happens) — the sanity
  // check itself only ever reads run.eligible_count, never the item count.
  const runRow = { id: runId, stage: 'call_1', since_date: null, assembled_at: new Date().toISOString(), eligible_count: 71, fully_processed_at: null, failed_at: null };
  const runItemRows = [{ id: 'ri-1', run_id: runId, sequence_in_run: 0, mailbox_key: 'mb1', missive_conversation_id: 'conv-1', chunk_number: null, batch_id: null, dispatched_at: null }];
  const { client: supabaseClient } = makeRunTrackingFakeClient({ runRow, runItemRows });

  const poolSpy = spyOn(significancePass, 'estimateExpectedEligiblePool', async () => ({ expectedPool: 100, totalMatchingConversations: 100, totalAlreadyProcessed: 0 })); // 71/100 = 71%, just above the 70% threshold
  const contextSpy = spyOn(significancePass, 'buildConversationContext', async (mb, convId) => ({ addressMatched: false, threadText: `text ${convId}` }));
  const promptSpy = spyOn(significancePass, 'buildCall1Prompt', ({ threadText }) => threadText);
  const { client: anthropicClientFake, calls: anthropicCalls } = makeFakeAnthropicBatchesClient({
    create: async () => ({ id: 'msgbatch_healthy', processing_status: 'in_progress' }),
  });

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const summary = await freshBatchModule.dispatchRunChunks({ runId });
      assert.strictEqual(summary.blockedBySanityCheck, false);
      assert.strictEqual(summary.chunksSubmitted, 1);
    });
  } finally {
    poolSpy.restore(); contextSpy.restore(); promptSpy.restore();
  }
  assert.strictEqual(anthropicCalls.create.length, 1, 'expected the healthy-ratio run to actually dispatch');
});

// ============================================================================
// PART 20 — lib/significance-batch.js's CALL 2 SUBMISSION/DISPATCH/WRITE-BACK
// (2026-09-29). The exact same sequential runSerialCheck() convention as
// PART 18-19 above, for the identical reason (every scenario here spies on
// the SAME shared significancePass object).
// ============================================================================

// ─── 20a — startSubmissionRun: call_2 draws from fetchIncompleteSignificanceRows,
// never fetchNextEligibleConversations, and sinceDate (meaningless for call_2)
// is ignored/forced null rather than silently recorded as if it were applied ──
  await runSerialCheck('significance-batch — startSubmissionRun: stage call_2 calls fetchIncompleteSignificanceRows (never the call_1-only fetchNextEligibleConversations), and forces since_date to null on the run row even when a sinceDate was passed in', async () => {
  const rows = [
    { mailbox_key: 'mb1', missive_conversation_id: 'conv-c2-1', category: 'dispute', resolution_status: 'open', why: 'w1', discovery_context: 'historical_backfill' },
    { mailbox_key: 'mb1', missive_conversation_id: 'conv-c2-2', category: 'owner_instruction', resolution_status: 'open', why: 'w2', discovery_context: 'historical_backfill' },
  ];
  const incompleteSpy = spyOn(significancePass, 'fetchIncompleteSignificanceRows', async (n) => { assert.strictEqual(n, 50); return rows; });
  const eligibleSpy = spyOn(significancePass, 'fetchNextEligibleConversations', async () => { throw new Error('fetchNextEligibleConversations should NEVER be called for a call_2 run'); });
  const { client: supabaseClient, state } = makeRunTrackingFakeClient({});
  const { client: anthropicClientFake } = makeFakeAnthropicBatchesClient({});

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const result = await freshBatchModule.startSubmissionRun({ stage: 'call_2', sinceDate: '2025-01-01', limit: 50 });
      assert.strictEqual(result.started, true);
      assert.strictEqual(result.eligibleCount, 2);
      assert.strictEqual(result.run.since_date, null, 'expected sinceDate to be ignored/forced null for a call_2 run');
    });
  } finally {
    incompleteSpy.restore(); eligibleSpy.restore();
  }
  assert.strictEqual(incompleteSpy.calls.length, 1);
  assert.strictEqual(eligibleSpy.calls.length, 0);
  assert.strictEqual(state.runItems.length, 2);
  assert.deepStrictEqual(new Set(state.runItems.map((it) => it.missive_conversation_id)), new Set(['conv-c2-1', 'conv-c2-2']));
});

// ─── 20b — the stage guard still rejects anything beyond call_1/call_2 ─────
  await runSerialCheck('significance-batch — startSubmissionRun: an unsupported stage is refused with a clear, explicit error before any DB or Anthropic call', async () => {
  await assert.rejects(() => significanceBatch.startSubmissionRun({ stage: 'call_3' }), /not implemented — only 'call_1' and 'call_2'/);
});

  await runSerialCheck('significance-batch — dispatchRunChunks: a run row somehow stamped with an unsupported stage is refused with a clear, explicit error rather than silently treating it as call_1', async () => {
  const runRow = { id: 'run-bad-stage', stage: 'call_3', since_date: null, assembled_at: new Date().toISOString(), eligible_count: 1, fully_processed_at: null, failed_at: null };
  const { client: supabaseClient } = makeRunTrackingFakeClient({ runRow });
  const { client: anthropicClientFake } = makeFakeAnthropicBatchesClient({});
  await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
    await assert.rejects(() => freshBatchModule.dispatchRunChunks({ runId: 'run-bad-stage' }), /not implemented — only 'call_1' and 'call_2'/);
  });
});

// ─── 20c — dispatchRunChunks: call_2 skips the Call-1-only expected-pool
// sanity check entirely, and builds real Call 2 requests fed by a lookup of
// each item's own missive_conversation_significance row ───────────────────
  await runSerialCheck('significance-batch — dispatchRunChunks: stage call_2 NEVER calls estimateExpectedEligiblePool (that check estimates Call 1\'s own pool, which has no Call 2 equivalent — Q\'s own documented scope decision), fetches complaint_tracking_config exactly ONCE for the whole call, and builds real Call 2 requests via buildCall2Prompt fed by each item\'s own looked-up category/resolution_status/why/discovery_context, with max_tokens: 768', async () => {
  const runId = 'run-c2-dispatch';
  const runRow = { id: runId, stage: 'call_2', since_date: null, assembled_at: new Date().toISOString(), eligible_count: 2, fully_processed_at: null, failed_at: null };
  const runItemRows = [
    { id: 'ri-c2-1', run_id: runId, sequence_in_run: 0, mailbox_key: 'mb1', missive_conversation_id: 'conv-c2-1', chunk_number: null, batch_id: null, dispatched_at: null },
    { id: 'ri-c2-2', run_id: runId, sequence_in_run: 1, mailbox_key: 'mb1', missive_conversation_id: 'conv-c2-2', chunk_number: null, batch_id: null, dispatched_at: null },
  ];
  const significanceRows = [
    { mailbox_key: 'mb1', missive_conversation_id: 'conv-c2-1', category: 'dispute', resolution_status: 'open', why: 'why one', discovery_context: 'historical_backfill' },
    { mailbox_key: 'mb1', missive_conversation_id: 'conv-c2-2', category: 'owner_instruction', resolution_status: 'unresolved', why: 'why two', discovery_context: 'historical_backfill' },
  ];
  const { client: supabaseClient, state } = makeRunTrackingFakeClient({ runRow, runItemRows, significanceRows });

  const poolSpy = spyOn(significancePass, 'estimateExpectedEligiblePool', async () => { throw new Error('estimateExpectedEligiblePool should NEVER be called for a call_2 run'); });
  const contextSpy = spyOn(significancePass, 'buildConversationContext', async (mb, convId) => ({ addressMatched: false, threadText: `text ${convId}`, thread: { fake: convId } }));
  const configSpy = spyOn(significancePass, 'getActiveComplaintTrackingConfig', async () => null);
  const silenceSpy = spyOn(significancePass, 'computeSilenceContext', () => { throw new Error('computeSilenceContext should never be called for a historical_backfill row'); });
  const promptSpy = spyOn(significancePass, 'buildCall2Prompt', (args) => `PROMPT[${args.category}|${args.resolution_status}|${args.why}|${args.discoveryContext}|${args.threadText}]`);

  let createCount = 0;
  const { client: anthropicClientFake, calls: anthropicCalls } = makeFakeAnthropicBatchesClient({
    create: async () => { createCount++; return { id: `msgbatch_c2_${createCount}`, processing_status: 'in_progress' }; },
  });

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const summary = await freshBatchModule.dispatchRunChunks({ runId });
      assert.strictEqual(summary.blockedBySanityCheck, false);
      assert.strictEqual(summary.chunksSubmitted, 1);
      assert.strictEqual(summary.itemsDispatched, 2);
    });
  } finally {
    poolSpy.restore(); contextSpy.restore(); configSpy.restore(); silenceSpy.restore(); promptSpy.restore();
  }

  assert.strictEqual(poolSpy.calls.length, 0, 'expected the sanity check to never run for a call_2 stage run');
  assert.strictEqual(configSpy.calls.length, 1, 'expected complaint_tracking_config to be fetched exactly once per dispatch call, not once per item');
  assert.strictEqual(anthropicCalls.create.length, 1);
  const requests = anthropicCalls.create[0][0].requests;
  assert.strictEqual(requests.length, 2);
  for (const req of requests) {
    assert.strictEqual(req.params.model, 'claude-sonnet-5');
    assert.strictEqual(req.params.max_tokens, 768, 'expected Call 2 batch requests to use max_tokens: 768, matching runCall2()\'s own live call');
  }
  const texts = requests.map((r) => r.params.messages[0].content[0].text);
  assert.ok(texts.some((t) => t === 'PROMPT[dispute|open|why one|historical_backfill|text conv-c2-1]'));
  assert.ok(texts.some((t) => t === 'PROMPT[owner_instruction|unresolved|why two|historical_backfill|text conv-c2-2]'));
  assert.ok(state.runItems.every((it) => it.batch_id != null));
});

// ─── 20d — buildDispatchEntries' own call_2 branch: a live_pipeline row gets
// a REAL computeSilenceContext call (fed the active config's own threshold,
// or the same default of 2 runCall2Phase itself falls back to), while a
// historical_backfill row in the very same call never triggers it at all ──
  await runSerialCheck('significance-batch — buildDispatchEntries: stage call_2 computes a live_pipeline row\'s own real silence context via computeSilenceContext (fed the active complaint_tracking_config\'s blocked_resolution_silence_days), while a historical_backfill row in the SAME call gets silenceContext: null and never triggers computeSilenceContext for itself', async () => {
  const items = [
    { id: 'ri-live', mailbox_key: 'mb1', missive_conversation_id: 'conv-live' },
    { id: 'ri-hist', mailbox_key: 'mb1', missive_conversation_id: 'conv-hist' },
  ];
  const significanceRows = [
    { mailbox_key: 'mb1', missive_conversation_id: 'conv-live', category: 'dispute', resolution_status: 'open', why: 'live why', discovery_context: 'live_pipeline' },
    { mailbox_key: 'mb1', missive_conversation_id: 'conv-hist', category: 'dispute', resolution_status: 'open', why: 'hist why', discovery_context: 'historical_backfill' },
  ];
  const { client: supabaseClient } = makeRunTrackingFakeClient({ significanceRows });

  const contextSpy = spyOn(significancePass, 'buildConversationContext', async (mb, convId) => ({ addressMatched: false, threadText: `text ${convId}`, thread: { convId } }));
  const configSpy = spyOn(significancePass, 'getActiveComplaintTrackingConfig', async () => ({ blocked_resolution_silence_days: 5 }));
  const silenceCalls = [];
  const silenceSpy = spyOn(significancePass, 'computeSilenceContext', (thread, days) => { silenceCalls.push({ thread, days }); return { fake: 'silence' }; });
  const promptSpy = spyOn(significancePass, 'buildCall2Prompt', (args) => `PROMPT[${args.discoveryContext}|${JSON.stringify(args.silenceContext)}]`);

  let result;
  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: {} }, async (freshBatchModule) => {
      result = await freshBatchModule.buildDispatchEntries(items, 'call_2', freshBatchModule.MAX_BATCH_BYTES, 2);
    });
  } finally {
    contextSpy.restore(); configSpy.restore(); silenceSpy.restore(); promptSpy.restore();
  }

  assert.strictEqual(result.entries.length, 2);
  assert.strictEqual(configSpy.calls.length, 1, 'expected getActiveComplaintTrackingConfig to be fetched exactly once for the whole call');
  assert.strictEqual(silenceCalls.length, 1, 'expected computeSilenceContext to be called exactly once — only for the live_pipeline row');
  assert.strictEqual(silenceCalls[0].days, 5, 'expected the active config\'s own blocked_resolution_silence_days to be threaded through, not a hardcoded default');
  const liveEntry = result.entries.find((e) => e.item.missive_conversation_id === 'conv-live');
  const histEntry = result.entries.find((e) => e.item.missive_conversation_id === 'conv-hist');
  assert.strictEqual(liveEntry.request.params.messages[0].content[0].text, 'PROMPT[live_pipeline|{"fake":"silence"}]');
  assert.strictEqual(histEntry.request.params.messages[0].content[0].text, 'PROMPT[historical_backfill|null]');
});

// ─── 20e — writeBackCall2Batch END-TO-END (happy path): a real escalation
// result is parsed with the REAL parseCall2Response and applied through the
// REAL applyCall2Fields, genuinely creating a complaints row ───────────────
  await runSerialCheck('significance-batch — writeBackCall2Batch END-TO-END: a real \'succeeded\' escalation result is parsed with the REAL parseCall2Response and applied through the REAL applyCall2Fields, genuinely creating a complaints row and updating the existing missive_conversation_significance row (never reimplementing Call 2\'s own write path)', async () => {
  const conversationRow = {
    id: 1, mailbox_key: 'mb1', missive_conversation_id: 'conv-c2-real-1', missive_message_id: 'msg-c2-1',
    from_address: null, to_addresses: null, cc_addresses: null, bcc_addresses: null,
    subject: 'Owner refusing repair', body_text: 'The owner has refused to authorize this repair and has gone silent.',
    delivered_at: '2026-02-01T00:00:00.000Z', screening_completed_at: '2026-02-02T00:00:00.000Z',
  };
  const itemRows = [
    { id: 'item-c2-real-1', batch_id: 'batch-c2-real', token: 'tok-c2-real', mailbox_key: 'mb1', missive_conversation_id: 'conv-c2-real-1', result_status: 'succeeded', written_back_at: null },
  ];
  const significanceRows = [
    { id: 'sig-c2-real-1', mailbox_key: 'mb1', missive_conversation_id: 'conv-c2-real-1', category: 'dispute', why: 'Owner has refused to authorize a repair.', discovery_context: 'historical_backfill', keyword_check_flagged_protected_class: false, keyword_check_flagged_category: null },
  ];
  const { client: fakeClient, state } = makeCall2EndToEndFakeClient({ itemRows, significanceRows, conversationRow });

  const rawResponseText = JSON.stringify({ escalation_signal: 'blocked_resolution', blocked_reason: 'explicit_refusal', blocked_party: 'owner', needs_human_call: false, owner_instruction_rejected: null, owner_instruction_summary: null });
  const { client: anthropicClientFake } = makeFakeAnthropicBatchesClient({
    results: async () => asyncIterableFromArray([{ custom_id: 'tok-c2-real', result: { type: 'succeeded', message: { content: [{ type: 'text', text: rawResponseText }] } } }]),
  });

  significancePass._setSupabaseClientForTesting(fakeClient);
  try {
    await withFakeSignificanceBatch({ supabaseClient: fakeClient, anthropicClient: anthropicClientFake }, async (batchLib) => {
      const summary = await batchLib.writeBackCall2Batch({ batchId: 'batch-c2-real', anthropicBatchId: 'msgbatch_c2_real' });
      assert.strictEqual(summary.processed, 1);
      assert.strictEqual(summary.written_significance, 1);
      assert.strictEqual(summary.errors, 0);
    });
  } finally {
    significancePass._setSupabaseClientForTesting(null);
  }

  assert.strictEqual(state.complaintsInserted.length, 1, 'expected exactly one REAL complaints insert — proving createComplaintRow (not a reimplementation) actually ran');
  const complaint = state.complaintsInserted[0];
  assert.strictEqual(complaint.category, 'dispute');
  assert.strictEqual(complaint.escalation_signal, 'blocked_resolution');
  assert.strictEqual(complaint.blocked_reason, 'explicit_refusal');
  assert.strictEqual(complaint.blocked_party, 'owner');
  assert.strictEqual(complaint.description, 'Owner has refused to authorize a repair.');
  assert.strictEqual(complaint.source_missive_conversation_id, 'conv-c2-real-1');
  assert.strictEqual(complaint.discovery_context, 'historical_backfill');
  assert.strictEqual(complaint.extracted_by, significancePass.CONTENT_PASS_VERSION, 'expected the SAME version constant the synchronous pipeline stamps — proof this went through the shared write path, not a parallel one');

  const sigRow = state.significanceRows.find((r) => r.id === 'sig-c2-real-1');
  assert.ok(sigRow.call2_completed_at, 'expected call2_completed_at to be stamped on the REAL significance-row update');
  assert.strictEqual(sigRow.complaint_id, complaint.id, 'expected the significance row to be updated with the newly created complaint\'s id');

  const byToken = Object.fromEntries(state.items.map((it) => [it.token, it]));
  assert.ok(byToken['tok-c2-real'].written_back_at, 'expected the batch item to be marked written back');
});

// ─── 20f — writeBackCall2Batch END-TO-END (no-escalation path): the real
// write path still stamps call2_completed_at but correctly creates NO
// complaint when shouldCreateComplaint's real conditions aren't met ────────
  await runSerialCheck('significance-batch — writeBackCall2Batch END-TO-END: a real \'succeeded\' result with escalation_signal: \'none\' and needs_human_call: false updates call2_completed_at via the REAL applyCall2Fields but creates NO complaint', async () => {
  const conversationRow = {
    id: 2, mailbox_key: 'mb1', missive_conversation_id: 'conv-c2-none-1', missive_message_id: 'msg-c2-none-1',
    from_address: null, to_addresses: null, cc_addresses: null, bcc_addresses: null,
    subject: 'Routine question', body_text: 'Just a routine, already-resolved logistics question, nothing more.',
    delivered_at: '2026-02-05T00:00:00.000Z', screening_completed_at: '2026-02-06T00:00:00.000Z',
  };
  const itemRows = [
    { id: 'item-c2-none-1', batch_id: 'batch-c2-none', token: 'tok-c2-none', mailbox_key: 'mb1', missive_conversation_id: 'conv-c2-none-1', result_status: 'succeeded', written_back_at: null },
  ];
  const significanceRows = [
    { id: 'sig-c2-none-1', mailbox_key: 'mb1', missive_conversation_id: 'conv-c2-none-1', category: 'dispute', why: 'A minor dispute that turned out to be nothing.', discovery_context: 'historical_backfill', keyword_check_flagged_protected_class: false, keyword_check_flagged_category: null },
  ];
  const { client: fakeClient, state } = makeCall2EndToEndFakeClient({ itemRows, significanceRows, conversationRow });

  const rawResponseText = JSON.stringify({ escalation_signal: 'none', blocked_reason: null, blocked_party: null, needs_human_call: false, owner_instruction_rejected: null, owner_instruction_summary: null });
  const { client: anthropicClientFake } = makeFakeAnthropicBatchesClient({
    results: async () => asyncIterableFromArray([{ custom_id: 'tok-c2-none', result: { type: 'succeeded', message: { content: [{ type: 'text', text: rawResponseText }] } } }]),
  });

  significancePass._setSupabaseClientForTesting(fakeClient);
  try {
    await withFakeSignificanceBatch({ supabaseClient: fakeClient, anthropicClient: anthropicClientFake }, async (batchLib) => {
      const summary = await batchLib.writeBackCall2Batch({ batchId: 'batch-c2-none', anthropicBatchId: 'msgbatch_c2_none' });
      assert.strictEqual(summary.written_significance, 1);
    });
  } finally {
    significancePass._setSupabaseClientForTesting(null);
  }

  assert.strictEqual(state.complaintsInserted.length, 0, 'expected NO complaint to be created when escalation_signal is none and needs_human_call is false');
  const sigRow = state.significanceRows.find((r) => r.id === 'sig-c2-none-1');
  assert.ok(sigRow.call2_completed_at, 'expected call2_completed_at to still be stamped even though no complaint was created');
  assert.strictEqual(sigRow.complaint_id, undefined, 'expected complaint_id to never even be included in the update when no complaint was created');
});

// ─── 20g — Call 2's OWN fail-closed contract (unlike Call 1's "no row,
// stays eligible"): a non-succeeded result AND a succeeded-but-unparseable
// result both still reach the REAL write path with call2Result: {ok:false},
// never silently skipped the way an equivalent Call 1 result would be ──────
  await runSerialCheck('significance-batch — applyOneCall2BatchItem (via writeBackCall2Batch): a non-succeeded (errored) result AND a succeeded-but-unparseable result both still reach applyCall2Fields with call2Result: {ok:false} — Call 2\'s own fail-closed contract, never silently skipped the way Call 1\'s equivalent failure is', async () => {
  const itemRows = [
    { id: 'item-c2-err', batch_id: 'batch-c2-fail', token: 'tok-err', mailbox_key: 'mb1', missive_conversation_id: 'conv-c2-err', result_status: 'errored', written_back_at: null },
    { id: 'item-c2-unparseable', batch_id: 'batch-c2-fail', token: 'tok-unparseable', mailbox_key: 'mb1', missive_conversation_id: 'conv-c2-unparseable', result_status: 'succeeded', written_back_at: null },
  ];
  const significanceRows = [
    { id: 'sig-err', mailbox_key: 'mb1', missive_conversation_id: 'conv-c2-err', category: 'dispute', why: 'why err', discovery_context: 'historical_backfill', keyword_check_flagged_protected_class: false, keyword_check_flagged_category: null },
    { id: 'sig-unparseable', mailbox_key: 'mb1', missive_conversation_id: 'conv-c2-unparseable', category: 'dispute', why: 'why unparseable', discovery_context: 'historical_backfill', keyword_check_flagged_protected_class: false, keyword_check_flagged_category: null },
  ];
  const { client: supabaseClient, state } = makeBatchTrackingFakeClient({ itemRows, significanceRows });

  const contextSpy = spyOn(significancePass, 'buildConversationContext', async (mb, convId) => ({ rows: [{ delivered_at: '2026-01-01T00:00:00.000Z' }], addressMatch: { subject_type: null, subject_id: null, vendor_id: null, property_id: null }, addressMatched: false, threadText: `text ${convId}` }));
  const applyCall2FieldsCalls = [];
  const applySpy = spyOn(significancePass, 'applyCall2Fields', async (args) => { applyCall2FieldsCalls.push(args); return { outcome: args.call2Result.ok ? 'call2_completed' : 'call2_failed_placeholder', significance_id: args.significanceId, complaint_id: null }; });

  const results = [
    { custom_id: 'tok-err', result: { type: 'errored', error: { type: 'invalid_request', message: 'bad' } } },
    { custom_id: 'tok-unparseable', result: { type: 'succeeded', message: { content: [{ type: 'text', text: 'not json at all' }] } } },
  ];
  const { client: anthropicClientFake } = makeFakeAnthropicBatchesClient({ results: async () => asyncIterableFromArray(results) });

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const summary = await freshBatchModule.writeBackCall2Batch({ batchId: 'batch-c2-fail', anthropicBatchId: 'msgbatch_c2_fail' });
      assert.strictEqual(summary.processed, 2);
      assert.strictEqual(summary.errors, 0);
    });
  } finally {
    contextSpy.restore(); applySpy.restore();
  }

  assert.strictEqual(applyCall2FieldsCalls.length, 2, 'expected BOTH the errored item and the unparseable item to still reach applyCall2Fields — never silently skipped');
  for (const call of applyCall2FieldsCalls) assert.strictEqual(call.call2Result.ok, false, `expected call2Result.ok === false for ${call.missive_conversation_id}`);
  assert.ok(state.items.every((it) => it.written_back_at), 'expected both items to be marked written back');
});

// ─── 20h — the two pre-AI-call gaps: no significance row at all (checked
// FIRST, before ever calling buildConversationContext), and a conversation
// whose messages have disappeared since dispatch — both write NO
// significance row yet are still marked written back, never a hard crash ──
  await runSerialCheck('significance-batch — writeBackCall2Batch: an item with no matching missive_conversation_significance row at write-back time is caught BEFORE ever calling buildConversationContext, and one whose conversation messages have disappeared is caught after — both write no significance row (no_row_written) yet are still marked written back', async () => {
  const itemRows = [
    { id: 'item-no-sig', batch_id: 'batch-c2-gaps', token: 'tok-no-sig', mailbox_key: 'mb1', missive_conversation_id: 'conv-no-sig', result_status: 'succeeded', written_back_at: null },
    { id: 'item-no-msgs', batch_id: 'batch-c2-gaps', token: 'tok-no-msgs', mailbox_key: 'mb1', missive_conversation_id: 'conv-no-msgs', result_status: 'succeeded', written_back_at: null },
  ];
  const significanceRows = [
    // Only conv-no-msgs has a significance row; conv-no-sig has none at all.
    { id: 'sig-no-msgs', mailbox_key: 'mb1', missive_conversation_id: 'conv-no-msgs', category: 'dispute', why: 'why', discovery_context: 'historical_backfill', keyword_check_flagged_protected_class: false, keyword_check_flagged_category: null },
  ];
  const { client: supabaseClient, state } = makeBatchTrackingFakeClient({ itemRows, significanceRows });

  const contextSpy = spyOn(significancePass, 'buildConversationContext', async (mb, convId) => {
    if (convId === 'conv-no-sig') throw new Error('buildConversationContext should never be called when there is no significance row at all — that check happens first');
    if (convId === 'conv-no-msgs') return null;
    return { addressMatched: false, threadText: 'x' };
  });
  const applySpy = spyOn(significancePass, 'applyCall2Fields', async () => { throw new Error('applyCall2Fields should never be reached for either of these two items'); });

  const results = [
    { custom_id: 'tok-no-sig', result: { type: 'succeeded', message: { content: [{ type: 'text', text: '{}' }] } } },
    { custom_id: 'tok-no-msgs', result: { type: 'succeeded', message: { content: [{ type: 'text', text: '{}' }] } } },
  ];
  const { client: anthropicClientFake } = makeFakeAnthropicBatchesClient({ results: async () => asyncIterableFromArray(results) });

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const summary = await freshBatchModule.writeBackCall2Batch({ batchId: 'batch-c2-gaps', anthropicBatchId: 'msgbatch_c2_gaps' });
      assert.strictEqual(summary.processed, 2);
      assert.strictEqual(summary.no_row_written, 2);
      assert.strictEqual(summary.written_significance, 0);
      assert.strictEqual(summary.errors, 0);
    });
  } finally {
    contextSpy.restore(); applySpy.restore();
  }

  const byToken = Object.fromEntries(state.items.map((it) => [it.token, it]));
  assert.ok(byToken['tok-no-sig'].written_back_at, 'expected the item with no significance row to still be marked written back');
  assert.ok(byToken['tok-no-msgs'].written_back_at, 'expected the item whose conversation messages disappeared to still be marked written back');
});

// ─── 20i — checkAndResumeRun: a batch row stamped stage: 'call_2' is routed
// through writeBackCall2Batch (parseCall2Response/applyCall2Fields), never
// through the call_1 write-back path (parseCall1Response/applyCall1Result) ─
  await runSerialCheck('significance-batch — checkAndResumeRun: a batch row stamped stage: \'call_2\' is written back through writeBackCall2Batch (parseCall2Response/applyCall2Fields) — the call_1-only parseCall1Response/applyCall1Result are never called', async () => {
  const runId = 'run-c2-resume';
  const runRow = { id: runId, stage: 'call_2', since_date: null, assembled_at: new Date().toISOString(), eligible_count: 1, fully_processed_at: null, failed_at: null };
  const batchRows = [
    { id: 'batch-c2-x', stage: 'call_2', anthropic_batch_id: 'msgbatch_c2_x', anthropic_status: 'in_progress', run_id: runId, chunk_number: 0, completed_at: null, failed_at: null, results_retrieved_at: null },
  ];
  const batchItemRows = [
    { id: 'bi-c2-x1', batch_id: 'batch-c2-x', token: 'tok-c2-x1', mailbox_key: 'mb1', missive_conversation_id: 'conv-c2-x1', result_status: 'pending', written_back_at: null },
  ];
  const significanceRows = [
    { id: 'sig-c2-x1', mailbox_key: 'mb1', missive_conversation_id: 'conv-c2-x1', category: 'dispute', why: 'w', discovery_context: 'historical_backfill', keyword_check_flagged_protected_class: false, keyword_check_flagged_category: null },
  ];
  const { client: supabaseClient, state } = makeRunTrackingFakeClient({ runRow, batchRows, batchItemRows, significanceRows });

  const contextSpy = spyOn(significancePass, 'buildConversationContext', async () => ({ rows: [{ delivered_at: '2026-01-01T00:00:00.000Z' }], addressMatch: {}, addressMatched: false, threadText: 'x' }));
  const call1ParseSpy = spyOn(significancePass, 'parseCall1Response', () => { throw new Error('parseCall1Response should NEVER be called for a call_2 batch row'); });
  const call1ApplySpy = spyOn(significancePass, 'applyCall1Result', async () => { throw new Error('applyCall1Result should NEVER be called for a call_2 batch row'); });
  const call2ParseCalls = [];
  const call2ParseSpy = spyOn(significancePass, 'parseCall2Response', (text, opts) => { call2ParseCalls.push({ text, opts }); return { escalation_signal: 'none', blocked_reason: null, blocked_party: null, needs_human_call: false, owner_instruction_rejected: null, owner_instruction_summary: null }; });
  const call2ApplyCalls = [];
  const call2ApplySpy = spyOn(significancePass, 'applyCall2Fields', async (args) => { call2ApplyCalls.push(args); return { outcome: 'call2_completed', significance_id: args.significanceId, complaint_id: null }; });

  const { client: anthropicClientFake } = makeFakeAnthropicBatchesClient({
    retrieve: async () => ({ processing_status: 'ended' }),
    results: async () => asyncIterableFromArray([{ custom_id: 'tok-c2-x1', result: { type: 'succeeded', message: { content: [{ type: 'text', text: '{}' }] } } }]),
  });

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const outcome = await freshBatchModule.checkAndResumeRun({ runId });
      assert.strictEqual(outcome.fullyProcessed, true);
    });
  } finally {
    contextSpy.restore(); call1ParseSpy.restore(); call1ApplySpy.restore(); call2ParseSpy.restore(); call2ApplySpy.restore();
  }

  assert.strictEqual(call2ParseCalls.length, 1, 'expected parseCall2Response to be consulted for the call_2 batch item');
  assert.strictEqual(call2ApplyCalls.length, 1, 'expected applyCall2Fields to be called for the call_2 batch item');
  assert.strictEqual(call2ApplyCalls[0].call2Result.ok, true);
  assert.ok(state.batches.find((b) => b.id === 'batch-c2-x').completed_at, 'expected the call_2 batch to be marked completed via the SAME maybeMarkBatchCompleted used by call_1');
});

// ============================================================================
// PART 21z — significance-pass per-run failure alert (Asimov's governance
// review, 2026-10-01 — the condition attached to process-significance-pending-
// scheduled ever running on a cron). See lib/significance-pass.js's own header
// comment, directly above runSignificancePassBatch's module.exports entry, for
// the full reasoning. Pure/synchronous — significancePassFailureCount and
// significancePassAlertShouldFire touch no DB/network, so these run as plain
// test() calls, same as PART 6's circuitBreakerShouldTrip tests above.
// ============================================================================
test('significancePassFailureCount — sums errors + call1_failed + call2_failed_placeholder, treating missing fields as 0', () => {
  assert.strictEqual(significancePass.significancePassFailureCount({ errors: 1, call1_failed: 1, call2_failed_placeholder: 1 }), 3);
  assert.strictEqual(significancePass.significancePassFailureCount({ errors: 0, call1_failed: 0, call2_failed_placeholder: 0 }), 0);
  assert.strictEqual(significancePass.significancePassFailureCount({}), 0, 'expected missing fields to count as 0, not throw or produce NaN');
});

test('significancePassAlertShouldFire — a clean run (zero failures) never fires', () => {
  assert.strictEqual(
    significancePass.significancePassAlertShouldFire({ conversations_processed: 20, call2_completed: 20, call2_failed_placeholder: 0, call1_failed: 0, errors: 0 }),
    false
  );
});

test('significancePassAlertShouldFire — below SIGNIFICANCE_PASS_ALERT_THRESHOLD (a couple of isolated failures spread across different counters) does not fire', () => {
  assert.strictEqual(
    significancePass.significancePassAlertShouldFire({ conversations_processed: 18, call2_completed: 17, call2_failed_placeholder: 1, call1_failed: 1, errors: 0 }),
    false
  );
});

test('significancePassAlertShouldFire — exactly at SIGNIFICANCE_PASS_ALERT_THRESHOLD fires (>= not >)', () => {
  assert.strictEqual(significancePass.SIGNIFICANCE_PASS_ALERT_THRESHOLD, 3, 'this test assumes the documented threshold value — update it deliberately if that constant intentionally changes');
  assert.strictEqual(
    significancePass.significancePassAlertShouldFire({ conversations_processed: 17, call2_completed: 17, call2_failed_placeholder: 0, call1_failed: 0, errors: 3 }),
    true
  );
});

test('significancePassAlertShouldFire — one short of the threshold does not fire (regression guard on the off-by-one)', () => {
  assert.strictEqual(
    significancePass.significancePassAlertShouldFire({ conversations_processed: 18, call2_completed: 18, call2_failed_placeholder: 0, call1_failed: 0, errors: 2 }),
    false
  );
});

test('significancePassAlertShouldFire — failures spread across errors/call1_failed/call2_failed_placeholder still sum to trip it, matching Asimov\'s own "errors/call1_failed/...placeholders" combined wording', () => {
  assert.strictEqual(
    significancePass.significancePassAlertShouldFire({ conversations_processed: 17, call2_completed: 16, call2_failed_placeholder: 1, call1_failed: 1, errors: 1 }),
    true
  );
});

test('router.js — BOTH process-significance-pending and process-significance-pending-scheduled check significancePassAlertShouldFire(summary) and call sendSignificancePassAlertEmail() with their own real route name after runSignificancePassBatch() completes — source-scanned, the same way PART 6 already proves process-pending\'s own screening-pass circuit-breaker alert call site, since neither route is invoked live in this suite', () => {
  const routerSource = fs.readFileSync(path.join(__dirname, '..', 'router.js'), 'utf8');

  const manualStart = routerSource.indexOf("internalRouter.post('/api/archive-search/process-significance-pending',");
  const manualEnd = routerSource.indexOf("internalRouter.post('/api/archive-search/process-significance-pending-scheduled',");
  const scheduledStart = manualEnd;
  const scheduledEnd = routerSource.indexOf("router.get('/api/archive-search/significance-pilot-export',");
  assert.ok(manualStart > -1 && manualEnd > manualStart && scheduledEnd > scheduledStart, 'expected to find all three route boundaries — route names may have changed');

  const manualBody = routerSource.slice(manualStart, manualEnd);
  const scheduledBody = routerSource.slice(scheduledStart, scheduledEnd);

  for (const [name, body] of [['process-significance-pending', manualBody], ['process-significance-pending-scheduled', scheduledBody]]) {
    assert.ok(body.includes('significancePassAlertShouldFire(summary)'), `expected ${name} to check significancePassAlertShouldFire(summary) after its own run`);
    assert.ok(body.includes(`route: '${name}'`), `expected ${name} to pass its own real route name to sendSignificancePassAlertEmail()`);
    assert.ok(body.includes('sendSignificancePassAlertEmail({'), `expected ${name} to actually call sendSignificancePassAlertEmail()`);
    // The alert call must be gated behind the threshold check, not unconditional —
    // confirmed by checking the alert call site textually falls inside an `if`
    // block whose condition is the threshold check, not merely that both
    // substrings exist somewhere in the route.
    const ifIdx = body.indexOf('if (significancePassAlertShouldFire(summary))');
    const alertIdx = body.indexOf('sendSignificancePassAlertEmail({');
    assert.ok(ifIdx > -1 && alertIdx > ifIdx && alertIdx - ifIdx < 200, `expected ${name}'s sendSignificancePassAlertEmail() call to sit directly inside the significancePassAlertShouldFire(summary) if-guard, not fire unconditionally`);
  }
});

// ============================================================================
// PART 21 — Call 2 batch-completion notification (Asimov's governance
// review, 2026-09-29): computeCall2RunNotificationCounts, sendCall2Batch
// CompletionNotification, and the checkAndResumeRun hook that fires it. See
// each function's own header comment in lib/significance-batch.js for the
// full reasoning. All still run through runSerialCheck() inside this same
// IIFE — these tests share the identical _setSupabaseClientForTesting/
// spyOn(significancePass, ...) hazards PART 18-20's own header comment
// documents, plus a new one: notify.sendMail is now ALSO a shared,
// property-mutated spy target (spyOn(notify, 'sendMail', ...)), so it needs
// the same strict-sequence discipline as everything else here.
// ============================================================================

// ─── 21a — computeCall2RunNotificationCounts: correct counts against
// constructed fake data, scoped to the given run's own batches only (never
// "every recent significance row"), with a same-conversation-id-different-
// mailbox row correctly excluded — the same composite-key collision guard
// reportNeedsCall2() already relies on ──────────────────────────────────
  await runSerialCheck('significance-batch — computeCall2RunNotificationCounts: real counts against constructed fake data, scoped to this run\'s own batches, with a cross-mailbox same-conversation-id collision correctly excluded', async () => {
  const historicalReviewRows = [{ id: 'hr-1' }, { id: 'hr-2' }, { id: 'hr-3' }]; // portfolio-wide total — deliberately unrelated to any batch/run id below.
  const batchItemRows = [
    { id: 'bi-1', batch_id: 'batch-n1', token: 't1', mailbox_key: 'mb1', missive_conversation_id: 'conv-1', result_status: 'pending', written_back_at: null },
    { id: 'bi-2', batch_id: 'batch-n1', token: 't2', mailbox_key: 'mb1', missive_conversation_id: 'conv-2', result_status: 'pending', written_back_at: null },
    { id: 'bi-3', batch_id: 'batch-n2', token: 't3', mailbox_key: 'mb1', missive_conversation_id: 'conv-3', result_status: 'pending', written_back_at: null },
    // A batch item belonging to a DIFFERENT run's batch — proves scoping is
    // by the passed batchIds, not "every batch item in the table."
    { id: 'bi-x', batch_id: 'batch-other-run', token: 'tx', mailbox_key: 'mb1', missive_conversation_id: 'conv-x', result_status: 'pending', written_back_at: null },
  ];
  const significanceRows = [
    { id: 'sig-1', mailbox_key: 'mb1', missive_conversation_id: 'conv-1', needs_human_call: true, owner_instruction_rejected: 'true' },
    { id: 'sig-2', mailbox_key: 'mb1', missive_conversation_id: 'conv-2', needs_human_call: false, owner_instruction_rejected: null },
    { id: 'sig-3', mailbox_key: 'mb1', missive_conversation_id: 'conv-3', needs_human_call: true, owner_instruction_rejected: 'uncertain' },
    // Same missive_conversation_id as conv-1 but a DIFFERENT mailbox — a
    // real, documented collision risk elsewhere in this codebase
    // (reportNeedsCall2's own comment). needs_human_call: true here must
    // NOT be counted — this run's own batch item for conv-1 is mb1, not mb2.
    { id: 'sig-1-other-mailbox', mailbox_key: 'mb2', missive_conversation_id: 'conv-1', needs_human_call: true, owner_instruction_rejected: 'true' },
    // conv-x belongs to a batch outside this run's own batchIds — must
    // never be counted either.
    { id: 'sig-x', mailbox_key: 'mb1', missive_conversation_id: 'conv-x', needs_human_call: true, owner_instruction_rejected: 'true' },
  ];
  const { client: supabaseClient } = makeRunTrackingFakeClient({ batchItemRows, significanceRows, historicalReviewRows });

  significanceBatch._setSupabaseClientForTesting(supabaseClient);
  try {
    const counts = await significanceBatch.computeCall2RunNotificationCounts({ batchIds: ['batch-n1', 'batch-n2'] });
    assert.strictEqual(counts.historicalReviewBacklogCount, 3, 'expected the portfolio-wide historical-review count, unaffected by run scoping');
    assert.strictEqual(counts.runConversationCount, 3, 'expected exactly conv-1/conv-2/conv-3 — conv-x is scoped out by batchIds');
    assert.strictEqual(counts.needsHumanCallCount, 2, 'expected conv-1 and conv-3 only — the mb2 collision row and conv-x must not be counted');
    assert.strictEqual(counts.ownerInstructionRejectedCount, 1, 'expected only conv-1\'s owner_instruction_rejected === \'true\' — conv-3\'s \'uncertain\' does not count');
  } finally {
    significanceBatch._setSupabaseClientForTesting(null);
  }
  });

// ─── 21b — sendCall2BatchCompletionNotification: sends exactly one real
// email via the SAME lib/notify.js sendMail() sendEscalationEmail() already
// uses, to DO_EMAIL + PETER_EMAIL, carrying the real computed counts ─────
  await runSerialCheck('significance-batch — sendCall2BatchCompletionNotification: sends exactly one email via notify.sendMail(), to DO_EMAIL + PETER_EMAIL, carrying the real computed counts', async () => {
  const historicalReviewRows = [{ id: 'hr-1' }];
  const batchItemRows = [
    { id: 'bi-1', batch_id: 'batch-n', token: 't1', mailbox_key: 'mb1', missive_conversation_id: 'conv-1', result_status: 'pending', written_back_at: null },
  ];
  const significanceRows = [
    { id: 'sig-1', mailbox_key: 'mb1', missive_conversation_id: 'conv-1', needs_human_call: true, owner_instruction_rejected: 'true' },
  ];
  const { client: supabaseClient } = makeRunTrackingFakeClient({ batchItemRows, significanceRows, historicalReviewRows });

  const prevDoEmail = process.env.DO_EMAIL;
  const prevPeterEmail = process.env.PETER_EMAIL;
  process.env.DO_EMAIL = 'do@example.test';
  process.env.PETER_EMAIL = 'peter@example.test';

  significanceBatch._setSupabaseClientForTesting(supabaseClient);
  const sendMailCalls = [];
  const sendMailSpy = spyOn(notify, 'sendMail', async (args) => { sendMailCalls.push(args); return { ok: true, sent: 2, failed: 0, accepted: args.to, rejected: [], error: null }; });

  try {
    const result = await significanceBatch.sendCall2BatchCompletionNotification({ runId: 'run-notify-1', batchIds: ['batch-n'] });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(sendMailCalls.length, 1, 'expected sendMail to be called exactly once');
    assert.deepStrictEqual(sendMailCalls[0].to, ['do@example.test', 'peter@example.test'], 'expected the SAME DO_EMAIL/PETER_EMAIL recipient pattern sendEscalationEmail() already uses');
    assert.ok(sendMailCalls[0].subject.includes('1 need a human call'), 'expected the real needsHumanCallCount in the subject line');
    assert.ok(sendMailCalls[0].text.includes('run-notify-1'), 'expected the run id in the email body');
    assert.ok(sendMailCalls[0].text.includes('Flagged needs_human_call (this run):    1'), 'expected the real computed needsHumanCallCount in the body');
    assert.ok(sendMailCalls[0].text.includes('historical review checklist (complaints_historical_review_required), portfolio-wide: 1'), 'expected the real computed historicalReviewBacklogCount in the body');
    assert.strictEqual(result.counts.needsHumanCallCount, 1);
    assert.strictEqual(result.counts.historicalReviewBacklogCount, 1);
  } finally {
    sendMailSpy.restore();
    significanceBatch._setSupabaseClientForTesting(null);
    process.env.DO_EMAIL = prevDoEmail;
    process.env.PETER_EMAIL = prevPeterEmail;
  }
  });

// ─── 21c — sendCall2BatchCompletionNotification: a realistic notify.sendMail
// failure (its own real contract — resolves { ok: false, ... }, never
// throws) is reported back honestly as ok:false, never thrown ────────────
  await runSerialCheck('significance-batch — sendCall2BatchCompletionNotification: a realistic notify.sendMail() failure (resolves ok:false, per its own real contract) is reported back as ok:false, never thrown', async () => {
  const batchItemRows = [
    { id: 'bi-1', batch_id: 'batch-n', token: 't1', mailbox_key: 'mb1', missive_conversation_id: 'conv-1', result_status: 'pending', written_back_at: null },
  ];
  const significanceRows = [
    { id: 'sig-1', mailbox_key: 'mb1', missive_conversation_id: 'conv-1', needs_human_call: false, owner_instruction_rejected: null },
  ];
  const { client: supabaseClient } = makeRunTrackingFakeClient({ batchItemRows, significanceRows, historicalReviewRows: [] });

  const prevDoEmail = process.env.DO_EMAIL;
  const prevPeterEmail = process.env.PETER_EMAIL;
  process.env.DO_EMAIL = 'do@example.test';
  process.env.PETER_EMAIL = 'peter@example.test';

  significanceBatch._setSupabaseClientForTesting(supabaseClient);
  const sendMailSpy = spyOn(notify, 'sendMail', async () => ({ ok: false, sent: 0, failed: 2, accepted: [], rejected: [], error: 'mailer_not_configured' }));

  try {
    const result = await significanceBatch.sendCall2BatchCompletionNotification({ runId: 'run-notify-2', batchIds: ['batch-n'] });
    assert.strictEqual(result.ok, false, 'expected ok:false to be reported honestly, matching notify.sendMail\'s own resolved outcome');
    assert.ok(result.error, 'expected a real error message reported back');
  } finally {
    sendMailSpy.restore();
    significanceBatch._setSupabaseClientForTesting(null);
    process.env.DO_EMAIL = prevDoEmail;
    process.env.PETER_EMAIL = prevPeterEmail;
  }
  });

// ─── 21d — checkAndResumeRun: the notification fires exactly ONCE, only on
// the transition into fully processed (never again on a later, redundant
// re-check of an already-completed run), and a simulated failure — here the
// most defensive case, notify.sendMail itself THROWING, contrary to its own
// real contract — still never affects the run's own fully_processed_at,
// which is written BEFORE the notification is even attempted ─────────────
  await runSerialCheck('significance-batch — checkAndResumeRun: fires the call_2 completion notification exactly once on the transition to fully processed (never again on a redundant re-check), and a simulated notify failure never affects the run\'s own fully_processed_at', async () => {
  const runId = 'run-c2-notify';
  const runRow = { id: runId, stage: 'call_2', since_date: null, assembled_at: new Date().toISOString(), eligible_count: 1, fully_processed_at: null, failed_at: null };
  const batchRows = [
    { id: 'batch-c2n', stage: 'call_2', anthropic_batch_id: 'msgbatch_c2n', anthropic_status: 'in_progress', run_id: runId, chunk_number: 0, completed_at: null, failed_at: null, results_retrieved_at: null },
  ];
  const batchItemRows = [
    { id: 'bi-c2n1', batch_id: 'batch-c2n', token: 'tok-c2n1', mailbox_key: 'mb1', missive_conversation_id: 'conv-c2n1', result_status: 'pending', written_back_at: null },
  ];
  const significanceRows = [
    { id: 'sig-c2n1', mailbox_key: 'mb1', missive_conversation_id: 'conv-c2n1', category: 'dispute', why: 'w', discovery_context: 'historical_backfill', keyword_check_flagged_protected_class: false, keyword_check_flagged_category: null, needs_human_call: true, owner_instruction_rejected: null },
  ];
  const { client: supabaseClient, state } = makeRunTrackingFakeClient({ runRow, batchRows, batchItemRows, significanceRows, historicalReviewRows: [{ id: 'hr-1' }] });

  const contextSpy = spyOn(significancePass, 'buildConversationContext', async () => ({ rows: [{ delivered_at: '2026-01-01T00:00:00.000Z' }], addressMatch: {}, addressMatched: false, threadText: 'x' }));
  const call2ParseSpy = spyOn(significancePass, 'parseCall2Response', () => ({ escalation_signal: 'none', blocked_reason: null, blocked_party: null, needs_human_call: false, owner_instruction_rejected: null, owner_instruction_summary: null }));
  const call2ApplySpy = spyOn(significancePass, 'applyCall2Fields', async (args) => ({ outcome: 'call2_completed', significance_id: args.significanceId, complaint_id: null }));

  const prevDoEmail = process.env.DO_EMAIL;
  const prevPeterEmail = process.env.PETER_EMAIL;
  process.env.DO_EMAIL = 'do@example.test';
  process.env.PETER_EMAIL = 'peter@example.test';

  const sendMailCalls = [];
  const sendMailSpy = spyOn(notify, 'sendMail', async (args) => {
    sendMailCalls.push(args);
    throw new Error('simulated notify outage — must never affect the run\'s own fully_processed_at');
  });

  const { client: anthropicClientFake } = makeFakeAnthropicBatchesClient({
    retrieve: async () => ({ processing_status: 'ended' }),
    results: async () => asyncIterableFromArray([{ custom_id: 'tok-c2n1', result: { type: 'succeeded', message: { content: [{ type: 'text', text: '{}' }] } } }]),
  });

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const outcome = await freshBatchModule.checkAndResumeRun({ runId });
      assert.strictEqual(outcome.fullyProcessed, true);
    });
    assert.ok(state.run.fully_processed_at, 'expected fully_processed_at to be set despite the notify failure — the run\'s own completion must never depend on the email succeeding');
    assert.strictEqual(sendMailCalls.length, 1, 'expected the notification to be attempted exactly once, on the transition to fully processed');

    // A redundant re-check (e.g. a later cron tick) must never re-send —
    // the run is already fully_processed_at from the call above.
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const outcome2 = await freshBatchModule.checkAndResumeRun({ runId });
      assert.strictEqual(outcome2.fullyProcessed, true);
    });
    assert.strictEqual(sendMailCalls.length, 1, 'expected NO second notification on a redundant re-check of an already-fully-processed run');
  } finally {
    contextSpy.restore(); call2ParseSpy.restore(); call2ApplySpy.restore(); sendMailSpy.restore();
    process.env.DO_EMAIL = prevDoEmail;
    process.env.PETER_EMAIL = prevPeterEmail;
  }
  });

// ─── 21e — checkAndResumeRun: a stage: 'call_1' run completing never calls
// the Call 2 completion notification at all — call_1 already has its own
// separate, already-reviewed live trigger (Asimov's own finding) ─────────
  await runSerialCheck('significance-batch — checkAndResumeRun: a stage: \'call_1\' run completing never calls the Call 2 completion notification — call_1 already has its own separate, already-reviewed live trigger', async () => {
  const runId = 'run-c1-no-notify';
  const runRow = { id: runId, stage: 'call_1', since_date: null, assembled_at: new Date().toISOString(), eligible_count: 1, fully_processed_at: null, failed_at: null };
  const batchRows = [
    { id: 'batch-c1n', stage: 'call_1', anthropic_batch_id: 'msgbatch_c1n', anthropic_status: 'in_progress', run_id: runId, chunk_number: 0, completed_at: null, failed_at: null, results_retrieved_at: null },
  ];
  const batchItemRows = [
    { id: 'bi-c1n1', batch_id: 'batch-c1n', token: 'tok-c1n1', mailbox_key: 'mb1', missive_conversation_id: 'conv-c1n1', result_status: 'pending', written_back_at: null },
  ];
  const { client: supabaseClient, state } = makeRunTrackingFakeClient({ runRow, batchRows, batchItemRows });

  const contextSpy = spyOn(significancePass, 'buildConversationContext', async () => ({ rows: [{ missive_message_id: 'm1' }], thread: {}, addressMatch: {}, addressMatched: false, threadText: 'x' }));
  const parseSpy = spyOn(significancePass, 'parseCall1Response', () => ({ resolution_status: 'open', category: 'dispute', why: 'test', tone_trend: null, identification: { property_text: null, vendor_text: null } }));
  const applySpy = spyOn(significancePass, 'applyCall1Result', async () => ({}));
  const propDirSpy = spyOn(significancePass, 'fetchPropertyDirectory', async () => []);
  const vendorDirSpy = spyOn(significancePass, 'fetchVendorDirectory', async () => []);

  const sendMailCalls = [];
  const sendMailSpy = spyOn(notify, 'sendMail', async (args) => { sendMailCalls.push(args); return { ok: true, sent: 1, failed: 0, accepted: [], rejected: [], error: null }; });

  const { client: anthropicClientFake } = makeFakeAnthropicBatchesClient({
    retrieve: async () => ({ processing_status: 'ended' }),
    results: async () => asyncIterableFromArray([{ custom_id: 'tok-c1n1', result: { type: 'succeeded', message: { content: [{ type: 'text', text: '{}' }] } } }]),
  });

  try {
    await withFakeSignificanceBatch({ supabaseClient, anthropicClient: anthropicClientFake }, async (freshBatchModule) => {
      const outcome = await freshBatchModule.checkAndResumeRun({ runId });
      assert.strictEqual(outcome.fullyProcessed, true);
    });
  } finally {
    contextSpy.restore(); parseSpy.restore(); applySpy.restore(); propDirSpy.restore(); vendorDirSpy.restore(); sendMailSpy.restore();
  }
  assert.ok(state.run.fully_processed_at, 'expected the call_1 run to still be marked fully processed normally');
  assert.strictEqual(sendMailCalls.length, 0, 'expected the Call 2 completion notification to never fire for a call_1 run');
  });

// ─── 21f-21i — significance-pass per-run failure alert (Asimov's condition,
// 2026-10-01 — see lib/significance-pass.js's own header comment). Run inside
// THIS SAME sequential IIFE, not a separate asyncTest()/IIFE of their own,
// because they also spyOn(notify, 'sendMail', ...) — the identical shared,
// property-mutated spy target 21b-21e above already use, so they need the
// same strict-sequence discipline this whole PART's header comment documents
// (asyncTest()-registered IIFEs run CONCURRENTLY with each other; only
// runSerialCheck() calls INSIDE one IIFE are guaranteed ordered) ───────────

// ─── 21f — sendSignificancePassAlertEmail: a run that crosses the alert
// threshold sends exactly one real email via notify.sendMail(), to DO_EMAIL +
// PETER_EMAIL, carrying the real run counts, route name, and run time ─────
  await runSerialCheck('significance-pass — sendSignificancePassAlertEmail: a run that crosses the alert threshold sends exactly one email via notify.sendMail(), to DO_EMAIL + PETER_EMAIL, carrying the real run counts and route name', async () => {
  const summary = { conversations_processed: 17, call2_completed: 16, call2_failed_placeholder: 1, call2_retried: 0, complaints_created: 2, call1_failed: 1, errors: 1 };

  const prevDoEmail = process.env.DO_EMAIL;
  const prevPeterEmail = process.env.PETER_EMAIL;
  process.env.DO_EMAIL = 'do@example.test';
  process.env.PETER_EMAIL = 'peter@example.test';

  const sendMailCalls = [];
  const sendMailSpy = spyOn(notify, 'sendMail', async (args) => { sendMailCalls.push(args); return { ok: true, sent: 2, failed: 0, accepted: args.to, rejected: [], error: null }; });

  try {
    const result = await significancePass.sendSignificancePassAlertEmail({ route: 'process-significance-pending-scheduled', summary, ts: '2026-10-01T12:00:00.000Z' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(sendMailCalls.length, 1, 'expected sendMail to be called exactly once');
    assert.deepStrictEqual(sendMailCalls[0].to, ['do@example.test', 'peter@example.test'], 'expected the same DO_EMAIL/PETER_EMAIL recipient pattern this codebase\'s other alert emails already use');
    assert.ok(sendMailCalls[0].subject.includes('process-significance-pending-scheduled'), 'expected the real route name in the subject line');
    assert.ok(sendMailCalls[0].subject.includes('3 failure'), 'expected the real combined failure count (1 error + 1 call1_failed + 1 call2_failed_placeholder = 3) in the subject line');
    assert.ok(sendMailCalls[0].text.includes('process-significance-pending-scheduled'), 'expected the route name in the email body');
    assert.ok(sendMailCalls[0].text.includes('2026-10-01T12:00:00.000Z'), 'expected the real run timestamp in the email body');
    assert.ok(sendMailCalls[0].text.includes('Conversations processed:                17'), 'expected the real conversations_processed count in the body');
    assert.ok(sendMailCalls[0].text.includes('Errors:                                 1'), 'expected the real errors count in the body');
    assert.ok(sendMailCalls[0].text.includes('Call 1 failed:                          1'), 'expected the real call1_failed count in the body');
    assert.ok(sendMailCalls[0].text.includes('Call 2 fail-closed placeholders:        1'), 'expected the real call2_failed_placeholder count in the body');
    assert.ok(sendMailCalls[0].text.includes('Complaints created:                     2'), 'expected the real complaints_created count in the body');
    assert.strictEqual(result.ok, true);
  } finally {
    sendMailSpy.restore();
    process.env.DO_EMAIL = prevDoEmail;
    process.env.PETER_EMAIL = prevPeterEmail;
  }
  });

// ─── 21g — sendSignificancePassAlertEmail: no recipient configured (DO_EMAIL
// and PETER_EMAIL both unset) is reported back honestly as ok:false/
// no_recipient, never throws, and never even attempts notify.sendMail() —
// same contract sendCall2BatchCompletionNotification's own 'no_recipient'
// path already establishes ──────────────────────────────────────────────
  await runSerialCheck('significance-pass — sendSignificancePassAlertEmail: no recipient configured (DO_EMAIL and PETER_EMAIL both unset) is reported back as ok:false/no_recipient, never throws, and never even attempts to call notify.sendMail()', async () => {
  const summary = { conversations_processed: 17, call2_completed: 16, call2_failed_placeholder: 1, call1_failed: 1, errors: 1 };

  const prevDoEmail = process.env.DO_EMAIL;
  const prevPeterEmail = process.env.PETER_EMAIL;
  delete process.env.DO_EMAIL;
  delete process.env.PETER_EMAIL;

  const sendMailCalls = [];
  const sendMailSpy = spyOn(notify, 'sendMail', async (args) => { sendMailCalls.push(args); return { ok: true, sent: 0, failed: 0, accepted: [], rejected: [], error: null }; });

  try {
    const result = await significancePass.sendSignificancePassAlertEmail({ route: 'process-significance-pending', summary, ts: '2026-10-01T12:00:00.000Z' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'no_recipient');
    assert.strictEqual(sendMailCalls.length, 0, 'expected notify.sendMail to never be called when no recipients are configured');
  } finally {
    sendMailSpy.restore();
    if (prevDoEmail === undefined) delete process.env.DO_EMAIL; else process.env.DO_EMAIL = prevDoEmail;
    if (prevPeterEmail === undefined) delete process.env.PETER_EMAIL; else process.env.PETER_EMAIL = prevPeterEmail;
  }
  });

// ─── 21h — sendSignificancePassAlertEmail: a realistic notify.sendMail()
// failure (its own real contract — resolves { ok: false, ... }, never
// throws) is reported back honestly as ok:false, never thrown ────────────
  await runSerialCheck('significance-pass — sendSignificancePassAlertEmail: a realistic notify.sendMail() failure (resolves ok:false, per its own real contract) is reported back as ok:false, never thrown', async () => {
  const summary = { conversations_processed: 17, call2_completed: 16, call2_failed_placeholder: 1, call1_failed: 1, errors: 1 };

  const prevDoEmail = process.env.DO_EMAIL;
  const prevPeterEmail = process.env.PETER_EMAIL;
  process.env.DO_EMAIL = 'do@example.test';
  process.env.PETER_EMAIL = 'peter@example.test';

  const sendMailSpy = spyOn(notify, 'sendMail', async () => ({ ok: false, sent: 0, failed: 2, accepted: [], rejected: [], error: 'mailer_not_configured' }));

  try {
    const result = await significancePass.sendSignificancePassAlertEmail({ route: 'process-significance-pending', summary, ts: '2026-10-01T12:00:00.000Z' });
    assert.strictEqual(result.ok, false, 'expected ok:false to be reported honestly, matching notify.sendMail\'s own resolved outcome');
    assert.ok(result.error, 'expected a real error message reported back');
  } finally {
    sendMailSpy.restore();
    process.env.DO_EMAIL = prevDoEmail;
    process.env.PETER_EMAIL = prevPeterEmail;
  }
  });

// ─── 21i — sendSignificancePassAlertEmail: notify.sendMail() itself THROWING
// (contrary to its own real contract — the most defensive case, same choice
// 21d above makes for the Call 2 completion notification) is still caught and
// reported back as ok:false — NEVER propagates past this function, so a
// broken mailer can never crash or block the route that just finished a real
// pipeline run ──────────────────────────────────────────────────────────
  await runSerialCheck('significance-pass — sendSignificancePassAlertEmail: notify.sendMail() itself THROWING (contrary to its own real contract) is still caught and reported back as ok:false — never propagates past this function, so a broken mailer can never crash or block the route that just finished a real pipeline run', async () => {
  const summary = { conversations_processed: 17, call2_completed: 16, call2_failed_placeholder: 1, call1_failed: 1, errors: 1 };

  const prevDoEmail = process.env.DO_EMAIL;
  const prevPeterEmail = process.env.PETER_EMAIL;
  process.env.DO_EMAIL = 'do@example.test';
  process.env.PETER_EMAIL = 'peter@example.test';

  const sendMailSpy = spyOn(notify, 'sendMail', async () => { throw new Error('simulated mail-server outage'); });

  try {
    const result = await significancePass.sendSignificancePassAlertEmail({ route: 'process-significance-pending-scheduled', summary, ts: '2026-10-01T12:00:00.000Z' });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('simulated mail-server outage'), 'expected the real thrown error message reported back, not swallowed silently');
  } finally {
    sendMailSpy.restore();
    process.env.DO_EMAIL = prevDoEmail;
    process.env.PETER_EMAIL = prevPeterEmail;
  }
  });

  return { name: 'significance-batch — PART 18-20 sequential runner completed (each scenario above already reported its own PASS/FAIL)', pass: true };
})());

// ============================================================================
// PART 22 — severity-tier build (2026-10-02, Jarvis-relayed build task).
// Schema: supabase/migrations/20261002010000_add_severity_tier_to_complaints.sql,
// .../20261002020000_add_no_issue_protected_signal_guard_to_complaints.sql.
// Covers: (a) lib/severity-rubric.js's pure parser/floor logic — plain,
// synchronous test()s, no shared mutable state, safe at any concurrency;
// (b) lib/severity-batch.js's governance gate / fetch / write-back, and
// significance-pass.js's createComplaintRow() severity hook — both mutate
// shared module-level test-override singletons (severityRubric's/
// severityBatch's own _setAnthropicClientForTesting/_setSupabaseClientForTesting,
// and significance-pass.js's require.cache swap), so these run inside their
// OWN sequential runSerialCheck runner, same discipline as PART 18-20's own
// IIFE just above and for the identical reason — never mixed into that
// existing runner itself, to avoid touching its already-large, working body;
// (c) static source-on-disk checks for the router.js/dashboard.html/
// run-severity-batch.js changes, same routerSourceLine/extractFunctionBody
// style PART 9-14 already use.
// ============================================================================

// ─── 22a — buildSeverityPrompt: the exact calibrated text is reproduced
// word for word, substituting {DESCRIPTION} — proven against a few of the
// rubric's own most load-bearing sentences (the active-dispute test, the
// no_issue-even-with-money rule, the four tier definitions), not just that
// SOME text comes out. A wording drift here would be a silent recalibration,
// not a refactor. ──────────────────────────────────────────────────────────
test('severity-rubric — buildSeverityPrompt substitutes the description verbatim into the """ ... """ block', () => {
  const prompt = severityRubric.buildSeverityPrompt('A tenant is refusing to pay a disputed late fee.');
  assert.ok(prompt.includes('"""\nA tenant is refusing to pay a disputed late fee.\n"""'), 'expected the description substituted verbatim inside the triple-quoted block');
});

test('severity-rubric — buildSeverityPrompt carries the exact "ONLY TEST THAT MATTERS" active-dispute sentence, word for word', () => {
  const prompt = severityRubric.buildSeverityPrompt('x');
  assert.ok(prompt.includes('THE ONLY TEST THAT MATTERS: is there an ACTIVE DISPUTE — someone obstructing, refusing, or an explicit threat (legal, to leave, to escalate to an agency)?'));
});

test('severity-rubric — buildSeverityPrompt carries the exact "ROUTINE OWNER/STAFF BUSINESS" no_issue-even-with-money rule, word for word', () => {
  const prompt = severityRubric.buildSeverityPrompt('x');
  assert.ok(prompt.includes('ROUTINE OWNER/STAFF BUSINESS WITH NO DISPUTE IS ALWAYS "NO ISSUE," EVEN WHEN IT INVOLVES MONEY OR A PERMANENT CHANGE.'));
});

test('severity-rubric — buildSeverityPrompt requests exactly the {tier, why} JSON shape, no markdown fence', () => {
  const prompt = severityRubric.buildSeverityPrompt('x');
  assert.ok(prompt.includes('Respond with EXACTLY one JSON object, no markdown fence:'));
  assert.ok(prompt.includes('{"tier": "urgent"|"worth_a_look"|"just_a_record"|"no_issue", "why": "one short plain-English sentence"}'));
});

test('severity-rubric — SEVERITY_RUBRIC_VERSION is \'v3\' (the calibrated version stamped into complaints.severity_rubric_version)', () => {
  assert.strictEqual(severityRubric.SEVERITY_RUBRIC_VERSION, 'v3');
});

test('severity-rubric — SEVERITY_TIERS is exactly the four values the CHECK constraint allows, in the migration\'s own order', () => {
  assert.deepStrictEqual(severityRubric.SEVERITY_TIERS, ['urgent', 'worth_a_look', 'just_a_record', 'no_issue']);
});

// ─── 22b — parseSeverityResponse: valid, invalid tier, missing/blank why,
// malformed JSON, and a stray markdown fence (defensive, even though the
// prompt asks for none — same posture parseCall1Response already takes). ──
test('severity-rubric — parseSeverityResponse accepts a clean, valid response', () => {
  const parsed = severityRubric.parseSeverityResponse('{"tier": "urgent", "why": "Tenant threatened legal action."}');
  assert.deepStrictEqual(parsed, { tier: 'urgent', why: 'Tenant threatened legal action.' });
});

test('severity-rubric — parseSeverityResponse tolerates a stray markdown fence (defensive, even though the prompt asks for none)', () => {
  const parsed = severityRubric.parseSeverityResponse('```json\n{"tier": "no_issue", "why": "Routine, no dispute."}\n```');
  assert.deepStrictEqual(parsed, { tier: 'no_issue', why: 'Routine, no dispute.' });
});

test('severity-rubric — parseSeverityResponse rejects an invalid tier value (not one of the four)', () => {
  assert.strictEqual(severityRubric.parseSeverityResponse('{"tier": "critical", "why": "x"}'), null);
});

test('severity-rubric — parseSeverityResponse rejects a missing why', () => {
  assert.strictEqual(severityRubric.parseSeverityResponse('{"tier": "urgent"}'), null);
});

test('severity-rubric — parseSeverityResponse rejects a blank/whitespace-only why', () => {
  assert.strictEqual(severityRubric.parseSeverityResponse('{"tier": "urgent", "why": "   "}'), null);
});

test('severity-rubric — parseSeverityResponse rejects malformed JSON', () => {
  assert.strictEqual(severityRubric.parseSeverityResponse('{"tier": "urgent", "why": '), null);
});

test('severity-rubric — parseSeverityResponse rejects a non-string response', () => {
  assert.strictEqual(severityRubric.parseSeverityResponse(null), null);
  assert.strictEqual(severityRubric.parseSeverityResponse(undefined), null);
});

// ─── 22c — applySeverityFloor: THE DATABASE-ENFORCED SAFETY FLOOR, in
// application code. Originally three trigger conditions; widened 2026-10-02
// (Mason governance review, gap #2 of 3) with two more: category ===
// 'legal_exposure', and owner_instruction_rejected === 'true' || === 'uncertain'.
// Each of the five trigger conditions individually, combined, and the two
// "never touches" cases (a non-no_issue tier; a no_issue tier with none of
// the five conditions). ───────────────────────────────────────────────────
test('severity-rubric — applySeverityFloor leaves a non-no_issue tier completely untouched, even when every trigger condition is also true', () => {
  const result = severityRubric.applySeverityFloor({ tier: 'urgent', why: 'Active dispute.', needs_human_call: true, category: 'accommodation_related', flagged_protected_class: true, owner_instruction_rejected: 'true' });
  assert.deepStrictEqual(result, { tier: 'urgent', why: 'Active dispute.', floored: false });
});

test('severity-rubric — applySeverityFloor leaves no_issue untouched when none of the five trigger conditions apply', () => {
  const result = severityRubric.applySeverityFloor({ tier: 'no_issue', why: 'Routine, no dispute.', needs_human_call: false, category: 'routine_logistics', flagged_protected_class: false, owner_instruction_rejected: null });
  assert.deepStrictEqual(result, { tier: 'no_issue', why: 'Routine, no dispute.', floored: false });
});

test('severity-rubric — applySeverityFloor leaves no_issue untouched when owner_instruction_rejected is \'false\' (the instruction was not rejected) — only \'true\'/\'uncertain\' trigger, never \'false\'', () => {
  const result = severityRubric.applySeverityFloor({ tier: 'no_issue', why: 'Routine.', needs_human_call: false, category: 'owner_instruction', flagged_protected_class: false, owner_instruction_rejected: 'false' });
  assert.deepStrictEqual(result, { tier: 'no_issue', why: 'Routine.', floored: false });
});

test('severity-rubric — applySeverityFloor floors no_issue to worth_a_look when needs_human_call=true, alone', () => {
  const result = severityRubric.applySeverityFloor({ tier: 'no_issue', why: 'Routine.', needs_human_call: true, category: 'routine_logistics', flagged_protected_class: false, owner_instruction_rejected: null });
  assert.strictEqual(result.tier, 'worth_a_look');
  assert.strictEqual(result.floored, true);
  assert.ok(result.why.includes('Routine.'), 'expected the original why text preserved');
  assert.ok(result.why.includes("Floored from no_issue: flagged by the AI's own uncertainty signal (needs_human_call)"), 'expected the specific needs_human_call floor note');
});

test('severity-rubric — applySeverityFloor floors no_issue to worth_a_look when category=accommodation_related, alone', () => {
  const result = severityRubric.applySeverityFloor({ tier: 'no_issue', why: 'Routine.', needs_human_call: false, category: 'accommodation_related', flagged_protected_class: false, owner_instruction_rejected: null });
  assert.strictEqual(result.tier, 'worth_a_look');
  assert.strictEqual(result.floored, true);
  assert.ok(result.why.includes('category is accommodation_related'));
});

test('severity-rubric — applySeverityFloor floors no_issue to worth_a_look when flagged_protected_class=true, alone', () => {
  const result = severityRubric.applySeverityFloor({ tier: 'no_issue', why: 'Routine.', needs_human_call: false, category: 'routine_logistics', flagged_protected_class: true, owner_instruction_rejected: null });
  assert.strictEqual(result.tier, 'worth_a_look');
  assert.strictEqual(result.floored, true);
  assert.ok(result.why.includes('flagged_protected_class is set'));
});

test('severity-rubric — applySeverityFloor floors no_issue to worth_a_look when category=legal_exposure, alone (added 2026-10-02, Mason governance review gap #2)', () => {
  const result = severityRubric.applySeverityFloor({ tier: 'no_issue', why: 'Routine.', needs_human_call: false, category: 'legal_exposure', flagged_protected_class: false, owner_instruction_rejected: null });
  assert.strictEqual(result.tier, 'worth_a_look');
  assert.strictEqual(result.floored, true);
  assert.ok(result.why.includes('category is legal_exposure'));
});

test('severity-rubric — applySeverityFloor floors no_issue to worth_a_look when owner_instruction_rejected=\'true\', alone (added 2026-10-02, Mason governance review gap #2)', () => {
  const result = severityRubric.applySeverityFloor({ tier: 'no_issue', why: 'Routine.', needs_human_call: false, category: 'owner_instruction', flagged_protected_class: false, owner_instruction_rejected: 'true' });
  assert.strictEqual(result.tier, 'worth_a_look');
  assert.strictEqual(result.floored, true);
  assert.ok(result.why.includes("owner_instruction_rejected is 'true'"));
});

test('severity-rubric — applySeverityFloor floors no_issue to worth_a_look when owner_instruction_rejected=\'uncertain\', alone (added 2026-10-02, Mason governance review gap #2)', () => {
  const result = severityRubric.applySeverityFloor({ tier: 'no_issue', why: 'Routine.', needs_human_call: false, category: 'owner_instruction', flagged_protected_class: false, owner_instruction_rejected: 'uncertain' });
  assert.strictEqual(result.tier, 'worth_a_look');
  assert.strictEqual(result.floored, true);
  assert.ok(result.why.includes("owner_instruction_rejected is 'uncertain'"));
});

test('severity-rubric — applySeverityFloor combines all three ORIGINAL trigger conditions into one honest, combined note (never only names the first one checked)', () => {
  const result = severityRubric.applySeverityFloor({ tier: 'no_issue', why: 'Routine.', needs_human_call: true, category: 'accommodation_related', flagged_protected_class: true, owner_instruction_rejected: null });
  assert.strictEqual(result.tier, 'worth_a_look');
  assert.strictEqual(result.floored, true);
  assert.ok(result.why.includes("needs_human_call"), 'expected the needs_human_call reason present');
  assert.ok(result.why.includes('accommodation_related'), 'expected the category reason present');
  assert.ok(result.why.includes('flagged_protected_class'), 'expected the flagged_protected_class reason present');
});

test('severity-rubric — applySeverityFloor combines all FIVE trigger conditions into one honest, combined note, including the two added 2026-10-02 (category can only be one value, so legal_exposure is swapped in for this combined case — a real row can still trip needs_human_call + flagged_protected_class + legal_exposure + owner_instruction_rejected together)', () => {
  const result = severityRubric.applySeverityFloor({
    tier: 'no_issue', why: 'Routine.', needs_human_call: true, category: 'legal_exposure', flagged_protected_class: true, owner_instruction_rejected: 'uncertain',
  });
  assert.strictEqual(result.tier, 'worth_a_look');
  assert.strictEqual(result.floored, true);
  assert.ok(result.why.includes('needs_human_call'), 'expected the needs_human_call reason present');
  assert.ok(result.why.includes('legal_exposure'), 'expected the category reason present');
  assert.ok(result.why.includes('flagged_protected_class'), 'expected the flagged_protected_class reason present');
  assert.ok(result.why.includes("owner_instruction_rejected is 'uncertain'"), 'expected the owner_instruction_rejected reason present');
});

// ─── 22d — lib/severity-batch.js + significance-pass.js's severity hook —
// sequential (see this PART's own header for why). ──────────────────────
asyncResults.push((async () => {

// A minimal, stateful, filtering fake for the `complaints`/`audit_log`
// tables severity-batch.js actually touches — deliberately NOT the
// existing makeFilteringFakeClient/makeFakeSupabaseClient helpers above
// (both are shaped around significance-pass.js's/significance-batch.js's
// own, different table set and call shapes); small and purpose-built here
// instead, same "each PART's own fake, sized to what it actually needs"
// convention this file already follows throughout (e.g. makeFakeSubjectMatchClient
// vs. makeEscalationAwareFakeClient).
function severityRowMatchesFilters(row, filters) {
  return filters.every((f) => {
    if (f.type === 'eq') return row[f.col] === f.val;
    if (f.type === 'is') return f.val === null ? (row[f.col] === null || row[f.col] === undefined) : row[f.col] === f.val;
    if (f.type === 'not-is-null') return !(row[f.col] === null || row[f.col] === undefined); // .not(col, 'is', null)
    return true;
  });
}
function makeSeverityFakeClient(initialComplaintRows) {
  const complaintRows = initialComplaintRows.map((r) => ({ ...r }));
  const auditLogInserts = [];
  function makeChain(table) {
    const filters = [];
    let op = null, insertRow = null, updateFields = null, rangeArgs = null;
    const chain = {
      select() { if (!op) op = 'select'; return chain; },
      insert(row) { op = 'insert'; insertRow = row; return chain; },
      update(fields) { op = 'update'; updateFields = fields; return chain; },
      eq(col, val) { filters.push({ type: 'eq', col, val }); return chain; },
      is(col, val) { filters.push({ type: 'is', col, val }); return chain; },
      not(col, operator, val) { if (operator === 'is' && val === null) filters.push({ type: 'not-is-null', col }); return chain; },
      order() { return chain; },
      range(from, to) { rangeArgs = [from, to]; return chain; },
      maybeSingle() {
        if (table === 'complaints' && op === 'select') {
          const match = complaintRows.find((r) => severityRowMatchesFilters(r, filters));
          return Promise.resolve({ data: match ? { ...match } : null, error: null });
        }
        if (table === 'complaints' && op === 'update') {
          const idx = complaintRows.findIndex((r) => severityRowMatchesFilters(r, filters));
          if (idx === -1) return Promise.resolve({ data: null, error: null });
          complaintRows[idx] = { ...complaintRows[idx], ...updateFields };
          return Promise.resolve({ data: { ...complaintRows[idx] }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve, reject) {
        let result;
        if (table === 'complaints' && op === 'select') {
          let matches = complaintRows.filter((r) => severityRowMatchesFilters(r, filters));
          if (rangeArgs) matches = matches.slice(rangeArgs[0], rangeArgs[1] + 1);
          result = { data: matches, error: null };
        } else if (table === 'audit_log' && op === 'insert') {
          auditLogInserts.push(insertRow);
          result = { data: null, error: null };
        } else {
          result = { data: [], error: null };
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }
  return { client: { from: (t) => makeChain(t) }, complaintRows, auditLogInserts };
}

const succeededResult = (tierWhy) => ({ type: 'succeeded', message: { content: [{ type: 'text', text: JSON.stringify(tierWhy) }] } });

await runSerialCheck('severity-batch — submitSeverityBatch refuses to run when SEVERITY_BATCH_GOVERNANCE_CLEARED is not \'true\' (the governance gate, checked BEFORE any Supabase/Anthropic call)', async () => {
  const prevFlag = process.env.SEVERITY_BATCH_GOVERNANCE_CLEARED;
  delete process.env.SEVERITY_BATCH_GOVERNANCE_CLEARED;
  try {
    await assert.rejects(
      severityBatch.submitSeverityBatch({}),
      (err) => { assert.ok(err.message.includes('SEVERITY_BATCH_GOVERNANCE_CLEARED')); return true; }
    );
  } finally {
    if (prevFlag === undefined) delete process.env.SEVERITY_BATCH_GOVERNANCE_CLEARED; else process.env.SEVERITY_BATCH_GOVERNANCE_CLEARED = prevFlag;
  }
});

await runSerialCheck('severity-batch — fetchUnassessedComplaints excludes held rows, already-assessed rows, and null-description rows; returns only the genuinely unassessed ones', async () => {
  const { client } = makeSeverityFakeClient([
    { id: 'c-unassessed', description: 'Needs assessment.', needs_human_call: false, category: 'dispute', flagged_protected_class: false, severity_tier: null, held_legal_fair_housing: false },
    { id: 'c-held', description: 'A held legal matter.', needs_human_call: false, category: null, flagged_protected_class: false, severity_tier: null, held_legal_fair_housing: true },
    { id: 'c-already-assessed', description: 'Already done.', needs_human_call: false, category: 'dispute', flagged_protected_class: false, severity_tier: 'urgent', held_legal_fair_housing: false },
    { id: 'c-no-description', description: null, needs_human_call: false, category: 'dispute', flagged_protected_class: false, severity_tier: null, held_legal_fair_housing: false },
  ]);
  severityBatch._setSupabaseClientForTesting(client);
  try {
    const rows = await severityBatch.fetchUnassessedComplaints(500);
    assert.deepStrictEqual(rows.map((r) => r.id), ['c-unassessed'], 'expected only the genuinely unassessed, non-held, described row');
  } finally {
    severityBatch._setSupabaseClientForTesting(null);
  }
});

await runSerialCheck('severity-batch — applyOneSeverityResult writes nothing for a non-succeeded batch result (errored/canceled/expired contract)', async () => {
  const { client, complaintRows, auditLogInserts } = makeSeverityFakeClient([{ id: 'c-1', description: 'x', needs_human_call: false, category: 'dispute', flagged_protected_class: false, severity_tier: null, held_legal_fair_housing: false }]);
  severityBatch._setSupabaseClientForTesting(client);
  try {
    const outcome = await severityBatch.applyOneSeverityResult({ complaintId: 'c-1', result: { type: 'errored', error: { type: 'api_error' } } });
    assert.strictEqual(outcome, 'no_row_written');
    assert.strictEqual(complaintRows[0].severity_tier, null, 'expected severity_tier left untouched');
    assert.strictEqual(auditLogInserts.length, 0, 'expected no audit_log write');
  } finally {
    severityBatch._setSupabaseClientForTesting(null);
  }
});

await runSerialCheck('severity-batch — applyOneSeverityResult writes nothing for a succeeded-but-unparseable response (no in-batch retry is possible)', async () => {
  const { client, complaintRows } = makeSeverityFakeClient([{ id: 'c-1', description: 'x', needs_human_call: false, category: 'dispute', flagged_protected_class: false, severity_tier: null, held_legal_fair_housing: false }]);
  severityBatch._setSupabaseClientForTesting(client);
  try {
    const outcome = await severityBatch.applyOneSeverityResult({ complaintId: 'c-1', result: { type: 'succeeded', message: { content: [{ type: 'text', text: 'not json at all' }] } } });
    assert.strictEqual(outcome, 'no_row_written');
    assert.strictEqual(complaintRows[0].severity_tier, null);
  } finally {
    severityBatch._setSupabaseClientForTesting(null);
  }
});

await runSerialCheck('severity-batch — applyOneSeverityResult never assigns severity_tier to a row that is held_legal_fair_housing at write-back time (defense in depth, even though the DB constraint would also reject it)', async () => {
  const { client, complaintRows } = makeSeverityFakeClient([{ id: 'c-1', description: 'x', needs_human_call: false, category: null, flagged_protected_class: false, severity_tier: null, held_legal_fair_housing: true }]);
  severityBatch._setSupabaseClientForTesting(client);
  try {
    const outcome = await severityBatch.applyOneSeverityResult({ complaintId: 'c-1', result: succeededResult({ tier: 'urgent', why: 'Active dispute.' }) });
    assert.strictEqual(outcome, 'no_row_written');
    assert.strictEqual(complaintRows[0].severity_tier, null, 'expected a held row to never get an automated severity_tier');
  } finally {
    severityBatch._setSupabaseClientForTesting(null);
  }
});

await runSerialCheck('severity-batch — applyOneSeverityResult skips a row that is already severity-assessed at write-back time (idempotent against a re-run or a race)', async () => {
  const { client, complaintRows } = makeSeverityFakeClient([{ id: 'c-1', description: 'x', needs_human_call: false, category: 'dispute', flagged_protected_class: false, severity_tier: 'just_a_record', held_legal_fair_housing: false }]);
  severityBatch._setSupabaseClientForTesting(client);
  try {
    const outcome = await severityBatch.applyOneSeverityResult({ complaintId: 'c-1', result: succeededResult({ tier: 'urgent', why: 'Active dispute.' }) });
    assert.strictEqual(outcome, 'no_row_written');
    assert.strictEqual(complaintRows[0].severity_tier, 'just_a_record', 'expected the already-assessed value to never be overwritten');
  } finally {
    severityBatch._setSupabaseClientForTesting(null);
  }
});

await runSerialCheck('severity-batch — applyOneSeverityResult happy path (no floor needed): writes all four severity fields and one complaint_tracking.severity_assessed audit_log entry', async () => {
  const { client, complaintRows, auditLogInserts } = makeSeverityFakeClient([{ id: 'c-1', description: 'x', needs_human_call: false, category: 'dispute', flagged_protected_class: false, severity_tier: null, held_legal_fair_housing: false }]);
  severityBatch._setSupabaseClientForTesting(client);
  try {
    const outcome = await severityBatch.applyOneSeverityResult({ complaintId: 'c-1', result: succeededResult({ tier: 'urgent', why: 'Tenant made an explicit legal threat.' }) });
    assert.strictEqual(outcome, 'written');
    assert.strictEqual(complaintRows[0].severity_tier, 'urgent');
    assert.strictEqual(complaintRows[0].severity_rationale, 'Tenant made an explicit legal threat.');
    assert.strictEqual(complaintRows[0].severity_rubric_version, 'v3');
    assert.ok(complaintRows[0].severity_assessed_at, 'expected a timestamp');
    assert.strictEqual(auditLogInserts.length, 1);
    assert.strictEqual(auditLogInserts[0].action, 'complaint_tracking.severity_assessed');
    assert.strictEqual(auditLogInserts[0].entity_type, 'complaint');
    assert.strictEqual(auditLogInserts[0].entity_id, 'c-1');
    assert.strictEqual(auditLogInserts[0].actor_type, 'system');
    assert.strictEqual(auditLogInserts[0].details.floored, false);
  } finally {
    severityBatch._setSupabaseClientForTesting(null);
  }
});

await runSerialCheck('severity-batch — applyOneSeverityResult happy path (floor needed): a fresh needs_human_call=true at write-back time floors a no_issue result to worth_a_look, re-fetched rather than trusting a stale snapshot', async () => {
  const { client, complaintRows, auditLogInserts } = makeSeverityFakeClient([{ id: 'c-1', description: 'x', needs_human_call: true, category: 'routine_logistics', flagged_protected_class: false, severity_tier: null, held_legal_fair_housing: false }]);
  severityBatch._setSupabaseClientForTesting(client);
  try {
    const outcome = await severityBatch.applyOneSeverityResult({ complaintId: 'c-1', result: succeededResult({ tier: 'no_issue', why: 'Looked routine.' }) });
    assert.strictEqual(outcome, 'written');
    assert.strictEqual(complaintRows[0].severity_tier, 'worth_a_look', 'expected the floor to apply using the FRESH needs_human_call=true, never the raw no_issue call');
    assert.ok(complaintRows[0].severity_rationale.includes('Floored from no_issue'));
    assert.strictEqual(auditLogInserts[0].details.floored, true);
    assert.strictEqual(auditLogInserts[0].details.raw_tier_before_floor, 'no_issue');
  } finally {
    severityBatch._setSupabaseClientForTesting(null);
  }
});

await runSerialCheck('severity-batch — applyOneSeverityResult happy path (floor needed, added 2026-10-02 Mason governance review gap #2): a fresh owner_instruction_rejected=\'uncertain\' at write-back time floors a no_issue result to worth_a_look, proving the new column is actually read from the fresh fetch, not just added to the function signature and left undefined', async () => {
  const { client, complaintRows, auditLogInserts } = makeSeverityFakeClient([{ id: 'c-1', description: 'x', needs_human_call: false, category: 'owner_instruction', flagged_protected_class: false, severity_tier: null, held_legal_fair_housing: false, owner_instruction_rejected: 'uncertain' }]);
  severityBatch._setSupabaseClientForTesting(client);
  try {
    const outcome = await severityBatch.applyOneSeverityResult({ complaintId: 'c-1', result: succeededResult({ tier: 'no_issue', why: 'Looked routine.' }) });
    assert.strictEqual(outcome, 'written');
    assert.strictEqual(complaintRows[0].severity_tier, 'worth_a_look', 'expected the floor to apply using the FRESH owner_instruction_rejected=\'uncertain\'');
    assert.ok(complaintRows[0].severity_rationale.includes("owner_instruction_rejected is 'uncertain'"));
    assert.strictEqual(auditLogInserts[0].details.floored, true);
  } finally {
    severityBatch._setSupabaseClientForTesting(null);
  }
});

await runSerialCheck('severity-batch — applyOneSeverityResult does NOT floor when owner_instruction_rejected=\'false\' at write-back time (only \'true\'/\'uncertain\' trigger)', async () => {
  const { client, complaintRows } = makeSeverityFakeClient([{ id: 'c-1', description: 'x', needs_human_call: false, category: 'owner_instruction', flagged_protected_class: false, severity_tier: null, held_legal_fair_housing: false, owner_instruction_rejected: 'false' }]);
  severityBatch._setSupabaseClientForTesting(client);
  try {
    const outcome = await severityBatch.applyOneSeverityResult({ complaintId: 'c-1', result: succeededResult({ tier: 'no_issue', why: 'Looked routine.' }) });
    assert.strictEqual(outcome, 'written');
    assert.strictEqual(complaintRows[0].severity_tier, 'no_issue', 'expected no floor for owner_instruction_rejected=\'false\'');
  } finally {
    severityBatch._setSupabaseClientForTesting(null);
  }
});

await runSerialCheck('severity-batch — checkAndWriteBackSeverityBatch reports {found:false} when no in-flight batch is known', async () => {
  severityBatch.clearState();
  const result = await severityBatch.checkAndWriteBackSeverityBatch();
  assert.deepStrictEqual(result, { found: false });
});

await runSerialCheck('severity-batch — checkAndWriteBackSeverityBatch reports status, not complete, while Anthropic still shows the batch in_progress (and never streams results early)', async () => {
  severityBatch.writeState({ anthropic_batch_id: 'batch_test_1', anthropic_status: 'in_progress', submitted_at: new Date().toISOString(), complaint_ids: ['c-1'], results_retrieved_at: null, submitted_by: 'test' });
  const fakeAnthropic = { beta: { messages: { batches: {
    retrieve: async () => ({ processing_status: 'in_progress' }),
    results: async () => { throw new Error('must not be called while still in_progress'); },
  } } } };
  severityBatch._setAnthropicClientForTesting(fakeAnthropic);
  try {
    const result = await severityBatch.checkAndWriteBackSeverityBatch();
    assert.strictEqual(result.alreadyComplete, false);
    assert.strictEqual(result.status, 'in_progress');
  } finally {
    severityBatch._setAnthropicClientForTesting(null);
    severityBatch.clearState();
  }
});

await runSerialCheck('severity-batch — checkAndWriteBackSeverityBatch, once Anthropic reports \'ended\', streams real results, writes them back, and marks the state file fully retrieved', async () => {
  const { client, complaintRows } = makeSeverityFakeClient([
    { id: 'c-1', description: 'x', needs_human_call: false, category: 'dispute', flagged_protected_class: false, severity_tier: null, held_legal_fair_housing: false },
    { id: 'c-2', description: 'y', needs_human_call: false, category: 'dispute', flagged_protected_class: false, severity_tier: null, held_legal_fair_housing: false },
  ]);
  severityBatch._setSupabaseClientForTesting(client);
  severityBatch.writeState({ anthropic_batch_id: 'batch_test_2', anthropic_status: 'in_progress', submitted_at: new Date().toISOString(), complaint_ids: ['c-1', 'c-2'], results_retrieved_at: null, submitted_by: 'test' });

  const fakeAnthropic = { beta: { messages: { batches: {
    retrieve: async () => ({ processing_status: 'ended' }),
    results: async () => asyncIterableFromArray([
      { custom_id: 'c-1', result: succeededResult({ tier: 'urgent', why: 'Threatened to sue.' }) },
      { custom_id: 'c-2', result: { type: 'errored', error: { type: 'api_error' } } },
    ]),
  } } } };
  severityBatch._setAnthropicClientForTesting(fakeAnthropic);
  try {
    const result = await severityBatch.checkAndWriteBackSeverityBatch();
    assert.strictEqual(result.alreadyComplete, true);
    assert.strictEqual(result.justCompleted, true);
    assert.strictEqual(result.summary.processed, 2);
    assert.strictEqual(result.summary.written, 1);
    assert.strictEqual(result.summary.no_row_written, 1);
    assert.strictEqual(complaintRows.find((r) => r.id === 'c-1').severity_tier, 'urgent');
    assert.strictEqual(complaintRows.find((r) => r.id === 'c-2').severity_tier, null);
    assert.ok(result.state.results_retrieved_at, 'expected the state file to record completion');

    // Re-running now must be a pure no-op — proves the file-based
    // resumability contract actually holds, not just the happy path once.
    const second = await severityBatch.checkAndWriteBackSeverityBatch();
    assert.strictEqual(second.alreadyComplete, true);
    assert.strictEqual(second.justCompleted, undefined);
  } finally {
    severityBatch._setSupabaseClientForTesting(null);
    severityBatch._setAnthropicClientForTesting(null);
    severityBatch.clearState();
  }
});

// ─── significance-pass.js's createComplaintRow() severity hook — reuses
// the existing PART 15 fake-client harness (makeFakeSupabaseClient/
// withFakeSignificancePass, above), calling createComplaintRow() directly
// with hand-built Call 1/Call 2-shaped inputs rather than driving the whole
// pipeline, so each scenario below isolates the hook itself. ────────────
const SEVERITY_HOOK_BASE_ARGS = {
  mailbox_key: 'team:test-mailbox', missive_conversation_id: 'conv-severity-hook-test', discoveryContext: 'historical_backfill',
  property_id: null, vendor_id: null, addressMatch: { subject_type: null, subject_id: null },
};

await runSerialCheck('significance-pass — createComplaintRow: severity hook stays a true no-op when SEVERITY_LIVE_PIPELINE_ENABLED is unset (default) — severity_tier stays null, no severity_assessed audit entry', async () => {
  const prevFlag = process.env.SEVERITY_LIVE_PIPELINE_ENABLED;
  delete process.env.SEVERITY_LIVE_PIPELINE_ENABLED;
  try {
    await withFakeSignificancePass({ conversationRows: [], existingComplaint: null }, async (freshSignificancePass, calls) => {
      await freshSignificancePass.createComplaintRow({
        ...SEVERITY_HOOK_BASE_ARGS, category: 'dispute', why: 'A routine dispute for the flag-off test.',
        call2Fields: { needs_human_call: false, blocked_reason: null, blocked_party: null, escalation_signal: 'none', owner_instruction_rejected: null, owner_instruction_note_text: null },
        keywordCheck: { flagged_protected_class: false, flagged_category: null },
      });
      assert.strictEqual(calls.complaintsInsert[0].severity_tier, null);
      assert.strictEqual(calls.complaintsInsert[0].severity_rationale, null);
      assert.strictEqual(calls.auditLogInserts.filter((a) => a.action === 'complaint_tracking.severity_assessed').length, 0, 'expected zero severity_assessed audit entries while the flag is off');
    });
  } finally {
    if (prevFlag === undefined) delete process.env.SEVERITY_LIVE_PIPELINE_ENABLED; else process.env.SEVERITY_LIVE_PIPELINE_ENABLED = prevFlag;
  }
});

await runSerialCheck('significance-pass — createComplaintRow: flag ON but the AI call itself fails (no ANTHROPIC_API_KEY, as withFakeSignificancePass already forces) — severity_tier stays null, creation still succeeds, no crash', async () => {
  const prevFlag = process.env.SEVERITY_LIVE_PIPELINE_ENABLED;
  process.env.SEVERITY_LIVE_PIPELINE_ENABLED = 'true';
  try {
    await withFakeSignificancePass({ conversationRows: [], existingComplaint: null }, async (freshSignificancePass, calls) => {
      const id = await freshSignificancePass.createComplaintRow({
        ...SEVERITY_HOOK_BASE_ARGS, category: 'dispute', why: 'A routine dispute for the AI-call-fails test.',
        call2Fields: { needs_human_call: false, blocked_reason: null, blocked_party: null, escalation_signal: 'none', owner_instruction_rejected: null, owner_instruction_note_text: null },
        keywordCheck: { flagged_protected_class: false, flagged_category: null },
      });
      assert.strictEqual(id, 'brand-new-complaint-id', 'expected creation to still succeed');
      assert.strictEqual(calls.complaintsInsert[0].severity_tier, null);
    });
  } finally {
    if (prevFlag === undefined) delete process.env.SEVERITY_LIVE_PIPELINE_ENABLED; else process.env.SEVERITY_LIVE_PIPELINE_ENABLED = prevFlag;
  }
});

await runSerialCheck('significance-pass — createComplaintRow: flag ON and the AI call succeeds, no floor needed — severity fields written at creation, plus one severity_assessed audit entry', async () => {
  const prevFlag = process.env.SEVERITY_LIVE_PIPELINE_ENABLED;
  process.env.SEVERITY_LIVE_PIPELINE_ENABLED = 'true';
  const fakeAnthropic = { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"tier": "urgent", "why": "Active dispute, explicit threat."}' }] }) } };
  severityRubric._setAnthropicClientForTesting(fakeAnthropic);
  try {
    await withFakeSignificancePass({ conversationRows: [], existingComplaint: null }, async (freshSignificancePass, calls) => {
      await freshSignificancePass.createComplaintRow({
        ...SEVERITY_HOOK_BASE_ARGS, category: 'dispute', why: 'An urgent dispute for the happy-path test.',
        call2Fields: { needs_human_call: false, blocked_reason: null, blocked_party: null, escalation_signal: 'none', owner_instruction_rejected: null, owner_instruction_note_text: null },
        keywordCheck: { flagged_protected_class: false, flagged_category: null },
      });
      assert.strictEqual(calls.complaintsInsert[0].severity_tier, 'urgent');
      assert.strictEqual(calls.complaintsInsert[0].severity_rationale, 'Active dispute, explicit threat.');
      assert.strictEqual(calls.complaintsInsert[0].severity_rubric_version, 'v3');
      const severityAudit = calls.auditLogInserts.filter((a) => a.action === 'complaint_tracking.severity_assessed');
      assert.strictEqual(severityAudit.length, 1);
      assert.strictEqual(severityAudit[0].details.floored, false);
    });
  } finally {
    severityRubric._setAnthropicClientForTesting(null);
    if (prevFlag === undefined) delete process.env.SEVERITY_LIVE_PIPELINE_ENABLED; else process.env.SEVERITY_LIVE_PIPELINE_ENABLED = prevFlag;
  }
});

await runSerialCheck('significance-pass — createComplaintRow: flag ON, AI says no_issue, but THIS row\'s own needs_human_call is true (set by the live_pipeline DO-lookup-failed branch, AFTER the base insertRow literal) — the floor still catches it, using the post-mutation value', async () => {
  const prevFlag = process.env.SEVERITY_LIVE_PIPELINE_ENABLED;
  process.env.SEVERITY_LIVE_PIPELINE_ENABLED = 'true';
  const fakeAnthropic = { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"tier": "no_issue", "why": "Looked routine to the model."}' }] }) } };
  severityRubric._setAnthropicClientForTesting(fakeAnthropic);
  try {
    await withFakeSignificancePass({ conversationRows: [], existingComplaint: null }, async (freshSignificancePass, calls) => {
      await freshSignificancePass.createComplaintRow({
        ...SEVERITY_HOOK_BASE_ARGS, category: 'dispute', why: 'A test row whose needs_human_call is true going in.',
        // needs_human_call: true here directly (historical_backfill never runs the live_pipeline
        // DO-lookup branch that could ALSO set it — this proves the floor reads whatever
        // insertRow.needs_human_call ends up being, regardless of which branch set it).
        call2Fields: { needs_human_call: true, blocked_reason: null, blocked_party: null, escalation_signal: 'none', owner_instruction_rejected: null, owner_instruction_note_text: null },
        keywordCheck: { flagged_protected_class: false, flagged_category: null },
      });
      assert.strictEqual(calls.complaintsInsert[0].severity_tier, 'worth_a_look', 'expected the floor to override the raw no_issue call');
      assert.ok(calls.complaintsInsert[0].severity_rationale.includes('Floored from no_issue'));
      const severityAudit = calls.auditLogInserts.filter((a) => a.action === 'complaint_tracking.severity_assessed');
      assert.strictEqual(severityAudit[0].details.floored, true);
    });
  } finally {
    severityRubric._setAnthropicClientForTesting(null);
    if (prevFlag === undefined) delete process.env.SEVERITY_LIVE_PIPELINE_ENABLED; else process.env.SEVERITY_LIVE_PIPELINE_ENABLED = prevFlag;
  }
});

await runSerialCheck('significance-pass — createComplaintRow: flag ON, AI says no_issue, but THIS row\'s call2Fields.owner_instruction_rejected is \'uncertain\' (added 2026-10-02, Mason governance review gap #2) — the floor catches it, proving owner_instruction_rejected is actually threaded from call2Fields through insertRow into applySeverityFloor, not left undefined', async () => {
  const prevFlag = process.env.SEVERITY_LIVE_PIPELINE_ENABLED;
  process.env.SEVERITY_LIVE_PIPELINE_ENABLED = 'true';
  const fakeAnthropic = { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"tier": "no_issue", "why": "Looked routine to the model."}' }] }) } };
  severityRubric._setAnthropicClientForTesting(fakeAnthropic);
  try {
    await withFakeSignificancePass({ conversationRows: [], existingComplaint: null }, async (freshSignificancePass, calls) => {
      await freshSignificancePass.createComplaintRow({
        ...SEVERITY_HOOK_BASE_ARGS, category: 'owner_instruction', why: 'A test row with an uncertain owner_instruction_rejected answer.',
        call2Fields: { needs_human_call: false, blocked_reason: null, blocked_party: null, escalation_signal: 'none', owner_instruction_rejected: 'uncertain', owner_instruction_note_text: 'Owner said no pets at Building C.' },
        keywordCheck: { flagged_protected_class: false, flagged_category: null },
      });
      assert.strictEqual(calls.complaintsInsert[0].severity_tier, 'worth_a_look', 'expected the floor to override the raw no_issue call using owner_instruction_rejected');
      assert.ok(calls.complaintsInsert[0].severity_rationale.includes("owner_instruction_rejected is 'uncertain'"));
      const severityAudit = calls.auditLogInserts.filter((a) => a.action === 'complaint_tracking.severity_assessed');
      assert.strictEqual(severityAudit[0].details.floored, true);
    });
  } finally {
    severityRubric._setAnthropicClientForTesting(null);
    if (prevFlag === undefined) delete process.env.SEVERITY_LIVE_PIPELINE_ENABLED; else process.env.SEVERITY_LIVE_PIPELINE_ENABLED = prevFlag;
  }
});

// ─── classifySeverity() itself — the live pipeline's retry-until-success
// loop (SEVERITY_LIVE_MAX_ATTEMPTS=3), exercised directly against a fake
// Anthropic client rather than only indirectly through createComplaintRow()
// above, same "exercise the retry mechanism on its own" discipline this
// file already applies to other retry/concurrency primitives (e.g.
// mapWithConcurrency, DISPATCH_CONCURRENCY). Neither existing runCall1()
// (significance-pass.js) has a direct test of this shape today — this is a
// genuine, deliberate step beyond that precedent, not a gap left behind,
// because the build task explicitly asked for "the classification
// function's parsing/retry behavior" to be covered. ──────────────────────
await runSerialCheck('severity-rubric — classifySeverity retries past an unparseable response and returns the eventual good result (retry-until-success, not fail-on-first-bad-response)', async () => {
  let callCount = 0;
  const fakeAnthropic = { messages: { create: async () => {
    callCount++;
    if (callCount === 1) return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not valid json' }] };
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"tier": "just_a_record", "why": "A real disagreement, still being discussed."}' }] };
  } } };
  severityRubric._setAnthropicClientForTesting(fakeAnthropic);
  try {
    const result = await severityRubric.classifySeverity('A real disagreement, still being discussed.');
    assert.deepStrictEqual(result, { tier: 'just_a_record', why: 'A real disagreement, still being discussed.' });
    assert.strictEqual(callCount, 2, 'expected exactly one retry — succeeded on the second attempt');
  } finally {
    severityRubric._setAnthropicClientForTesting(null);
  }
});

await runSerialCheck('severity-rubric — classifySeverity returns null (never a guessed default) after exhausting every retry on consistently unparseable responses', async () => {
  let callCount = 0;
  const fakeAnthropic = { messages: { create: async () => { callCount++; return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'still not valid json' }] }; } } };
  severityRubric._setAnthropicClientForTesting(fakeAnthropic);
  try {
    const result = await severityRubric.classifySeverity('x');
    assert.strictEqual(result, null);
    assert.strictEqual(callCount, 3, 'expected all 3 attempts (SEVERITY_LIVE_MAX_ATTEMPTS) to be used before giving up');
  } finally {
    severityRubric._setAnthropicClientForTesting(null);
  }
});

await runSerialCheck('severity-rubric — classifySeverity retries past a truncated (max_tokens) response, exactly like an unparseable one', async () => {
  let callCount = 0;
  const fakeAnthropic = { messages: { create: async () => {
    callCount++;
    if (callCount === 1) return { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"tier": "urg' }] };
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"tier": "urgent", "why": "Explicit legal threat."}' }] };
  } } };
  severityRubric._setAnthropicClientForTesting(fakeAnthropic);
  try {
    const result = await severityRubric.classifySeverity('x');
    assert.deepStrictEqual(result, { tier: 'urgent', why: 'Explicit legal threat.' });
    assert.strictEqual(callCount, 2);
  } finally {
    severityRubric._setAnthropicClientForTesting(null);
  }
});

await runSerialCheck('severity-rubric — classifySeverity retries past a thrown error (e.g. a transient network/timeout failure) and still returns the eventual good result', async () => {
  let callCount = 0;
  const fakeAnthropic = { messages: { create: async () => {
    callCount++;
    if (callCount === 1) throw new Error('simulated transient timeout');
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"tier": "no_issue", "why": "Routine, no dispute."}' }] };
  } } };
  severityRubric._setAnthropicClientForTesting(fakeAnthropic);
  try {
    const result = await severityRubric.classifySeverity('x');
    assert.deepStrictEqual(result, { tier: 'no_issue', why: 'Routine, no dispute.' });
    assert.strictEqual(callCount, 2);
  } finally {
    severityRubric._setAnthropicClientForTesting(null);
  }
});

// ─── max_tokens bug fix, 2026-10-02 — real complaint d471ed02-06d3-4257-
// 91eb-9643725bbe72 truncated (stop_reason: 'max_tokens') on three separate
// real batch runs at the old 512 budget; the description was unremarkable,
// so this was a token-budget problem, not a content/parser problem. Two
// things proven below: (1) BOTH real callers of this classification
// (classifySeverity's live, synchronous path AND buildBatchRequest's
// batch-submission path) now share the exact same, raised
// SEVERITY_MAX_TOKENS constant — never two independent literals that could
// silently drift apart again — and (2) a batch result that comes back
// truncated is still handled as a retry-worthy, stays-eligible outcome
// (same as the classifySeverity retry test above already proves for the
// live path), just with a log message that now names the real cause. ────
await runSerialCheck('severity-rubric — SEVERITY_MAX_TOKENS is 1024 (bumped from 512), matching runCall1()\'s own max_tokens in significance-pass.js — the most generous existing precedent for one classification-style call in this codebase, real headroom rather than a guessed number', async () => {
  assert.strictEqual(severityRubric.SEVERITY_MAX_TOKENS, 1024);
});

await runSerialCheck('severity-rubric — classifySeverity calls Anthropic with max_tokens === SEVERITY_MAX_TOKENS, not a second, independent literal that could drift out of sync with it', async () => {
  let capturedParams = null;
  const fakeAnthropic = { messages: { create: async (params) => {
    capturedParams = params;
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"tier": "no_issue", "why": "Routine, no dispute."}' }] };
  } } };
  severityRubric._setAnthropicClientForTesting(fakeAnthropic);
  try {
    await severityRubric.classifySeverity('x');
    assert.ok(capturedParams, 'expected the fake Anthropic client to have been called');
    assert.strictEqual(capturedParams.max_tokens, severityRubric.SEVERITY_MAX_TOKENS);
  } finally {
    severityRubric._setAnthropicClientForTesting(null);
  }
});

await runSerialCheck('severity-batch — buildBatchRequest uses severityRubric.SEVERITY_MAX_TOKENS directly for the batch submission\'s max_tokens — the exact same classification call as classifySeverity\'s, just submitted via the Batches API, so it needs the exact same token budget', async () => {
  const request = severityBatch.buildBatchRequest({ id: 'c-1', description: 'A routine safety/habitability report.' });
  assert.strictEqual(request.custom_id, 'c-1');
  assert.strictEqual(request.params.model, 'claude-sonnet-5');
  assert.strictEqual(request.params.max_tokens, severityRubric.SEVERITY_MAX_TOKENS);
});

await runSerialCheck('severity-batch — applyOneSeverityResult reproduces the real complaint d471ed02-06d3-4257-91eb-9643725bbe72 failure shape (succeeded per Anthropic, but stop_reason max_tokens cut the JSON off mid-rationale): still the same retry-worthy "no_row_written, stays eligible for the next run" outcome as any other non-parse, but now logs the real, specific cause instead of a generic "did not parse"', async () => {
  const { client, complaintRows } = makeSeverityFakeClient([{ id: 'c-1', description: 'A routine safety/habitability report.', needs_human_call: false, category: 'dispute', flagged_protected_class: false, severity_tier: null, held_legal_fair_housing: false }]);
  severityBatch._setSupabaseClientForTesting(client);
  const errSpy = spyOn(console, 'error', () => {});
  try {
    const truncatedResult = { type: 'succeeded', message: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"tier": "worth_a_look", "why": "A real disagree' }] } };
    const outcome = await severityBatch.applyOneSeverityResult({ complaintId: 'c-1', result: truncatedResult });
    assert.strictEqual(outcome, 'no_row_written');
    assert.strictEqual(complaintRows[0].severity_tier, null, 'expected severity_tier to stay NULL — naturally re-eligible for the very next run, exactly the existing retry mechanism this file\'s own header describes');
    const loggedTruncationSpecifically = errSpy.calls.some((args) => typeof args[0] === 'string' && args[0].includes('truncated by max_tokens'));
    assert.ok(loggedTruncationSpecifically, 'expected a log message explicitly naming the max_tokens truncation, distinct from the generic "did not parse" wording the unparseable-response test above already covers');
  } finally {
    errSpy.restore();
    severityBatch._setSupabaseClientForTesting(null);
  }
});

return { name: 'severity-tier build — PART 22d sequential runner completed (each scenario above already reported its own PASS/FAIL)', pass: true };
})());

// ─── 22e — run-severity-batch.js: pure argument parsing (require.main
// guard keeps this a safe, no-op require — same convention run-
// significance-batch.js's own module.exports already follows). ─────────
test('run-severity-batch.js — parseLimitArg accepts a positive integer', () => {
  const { parseLimitArg } = require('../run-severity-batch');
  assert.deepStrictEqual(parseLimitArg(['--limit=25']), { limit: 25, error: null });
});

test('run-severity-batch.js — parseLimitArg rejects a non-positive value', () => {
  const { parseLimitArg } = require('../run-severity-batch');
  const result = parseLimitArg(['--limit=0']);
  assert.strictEqual(result.limit, undefined);
  assert.ok(result.error);
});

// ─── run-name-match-backfill.js: pure argument parsing (same require.main
// guard / no-op-require convention as run-severity-batch.js, just above). ──
test('run-name-match-backfill.js — parseLimitArg accepts a positive integer', () => {
  const { parseLimitArg } = require('../run-name-match-backfill');
  assert.deepStrictEqual(parseLimitArg(['--limit=25']), { limit: 25, error: null });
});

test('run-name-match-backfill.js — parseLimitArg rejects a non-positive value', () => {
  const { parseLimitArg } = require('../run-name-match-backfill');
  const result = parseLimitArg(['--limit=0']);
  assert.strictEqual(result.limit, undefined);
  assert.ok(result.error);
});

// ─── 22f — complaint-tracking/router.js: the main list endpoint's new
// no_issue exclusion + admin audit toggle, and confirmation that home-count/
// Property 360 (both reading complaints_needing_attention, a view that does
// NOT yet expose severity_tier — see this file's own comment) are correctly
// left UNCHANGED rather than worked around. ──────────────────────────────
test('complaint-tracking/router.js — GET /api/complaint-tracking excludes severity_tier=no_issue by default, via an IS NULL-preserving .or(), never a bare .neq()', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'complaint-tracking', 'router.js'), 'utf8');
  const start = source.indexOf("router.get('/api/complaint-tracking', requireComplaintTrackingAccess");
  const end = source.indexOf("router.get('/api/complaint-tracking/home-count'", start);
  assert.ok(start !== -1 && end !== -1 && end > start, 'expected to find both route boundaries');
  const body = source.slice(start, end);
  assert.ok(body.includes('include_no_issue'), 'expected the admin audit toggle query param');
  assert.ok(body.includes("query.or('severity_tier.is.null,severity_tier.neq.no_issue')"), 'expected the IS NULL-preserving .or() filter, applied conditionally on the toggle');
});

test('complaint-tracking/router.js — home-count and Property 360 are left UNCHANGED by the severity-tier build — both still read complaints_needing_attention with no severity_tier reference (the view does not expose that column yet; see this file\'s own flagged comment)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'complaint-tracking', 'router.js'), 'utf8');
  const start = source.indexOf("router.get('/api/complaint-tracking/home-count'");
  const end = source.indexOf("router.get('/api/complaint-tracking/property/:property_id'");
  assert.ok(start !== -1 && end !== -1 && end > start, 'expected to find both route boundaries');
  const body = source.slice(start, end);
  assert.strictEqual(/severity_tier/.test(body), false, 'expected zero references to severity_tier inside the home-count route — the view does not expose that column, so referencing it here would throw at runtime, not no-op');
  assert.ok(body.includes(".from('complaints_needing_attention')"));
});

// ─── 22g — complaint-tracking/dashboard/index.html: severity_tier as the
// primary triage signal, with the exact legacy fallback preserved for an
// unassessed (NULL) row, and the new no_issue lane. Static source checks,
// same style PART 9-14 already use for router.js. ────────────────────────
function readDashboardSource() {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'complaint-tracking', 'dashboard', 'index.html'), 'utf8');
}
function extractJsFunctionBody(source, functionSignature) {
  const start = source.indexOf(functionSignature);
  assert.ok(start !== -1, `expected to find "${functionSignature}" in dashboard/index.html`);
  const nextFnMarkers = ['\n    function ', '\n    var '];
  let end = source.length;
  for (const marker of nextFnMarkers) {
    const idx = source.indexOf(marker, start + functionSignature.length);
    if (idx !== -1 && idx < end) end = idx;
  }
  return source.slice(start, end);
}

test('dashboard/index.html — triagePriority() uses severity_tier as the PRIMARY signal when a row has been assessed', () => {
  const body = extractJsFunctionBody(readDashboardSource(), 'function triagePriority(c) {');
  assert.ok(/severity_tier\s*===\s*'urgent'[\s\S]{0,20}return 'call'/.test(body));
  assert.ok(/severity_tier\s*===\s*'worth_a_look'[\s\S]{0,20}return 'flagged'/.test(body));
  assert.ok(/severity_tier\s*===\s*'just_a_record'[\s\S]{0,20}return 'log'/.test(body));
  assert.ok(/severity_tier\s*===\s*'no_issue'[\s\S]{0,20}return 'no_issue'/.test(body));
});

test('dashboard/index.html — triagePriority() falls through to the EXACT pre-existing needs_human_call/escalation_signal logic, byte-for-byte, when severity_tier is NULL (not yet assessed)', () => {
  const body = extractJsFunctionBody(readDashboardSource(), 'function triagePriority(c) {');
  assert.ok(body.includes("if (c.needs_human_call) return 'call';"), 'expected the original needs_human_call fallback line, unchanged');
  assert.ok(body.includes("if (c.escalation_signal) return 'flagged';"), 'expected the original escalation_signal fallback line, unchanged');
});

test('dashboard/index.html — applyFilters() hides severity_tier=no_issue rows unless filters.includeNoIssue is checked', () => {
  const source = readDashboardSource();
  const start = source.indexOf('function applyFilters(items) {');
  const end = source.indexOf('function renderTiles(items) {');
  assert.ok(start !== -1 && end !== -1 && end > start);
  const body = source.slice(start, end);
  assert.ok(body.includes("if (!filters.includeNoIssue && laneOf(c) === 'no_issue') return false;"));
});

test('dashboard/index.html — the admin audit toggle checkbox exists and is wired to filters.includeNoIssue, mirroring the pre-existing includeMerged checkbox pattern', () => {
  const source = readDashboardSource();
  assert.ok(source.includes('id="includeNoIssueCheck"'));
  assert.ok(source.includes("filters.includeNoIssue = includeNoIssueCheck.checked;"));
  assert.ok(source.includes('includeNoIssue: false'), 'expected the filters state object to carry the new field with the correct default (hidden by default)');
});

test('dashboard/index.html — No Issue rows get their own clearly-separate section inside the Log tab, never folded into the real Log lane', () => {
  const source = readDashboardSource();
  assert.ok(source.includes("var noIssueItems = filters.includeNoIssue ? filtered.filter(function (c) { return laneOf(c) === 'no_issue'; }) : [];"));
  assert.ok(source.includes("'<div class=\"quiet-section-title\">No Issue ('"));
});

// ─── 22h — complaint-tracking/dashboard/index.html: "Needs Attention" tile
// bug fix, 2026-10-02. The PART 22g tests above confirm triagePriority()/
// laneOf() themselves use severity_tier correctly; this bug was that the
// "Needs Attention" stat tile and its matching tile-filter were never
// switched over when that happened — they still counted c.is_big_deal,
// which the comment above triagePriority() documents as true on
// effectively every row (2,732/2,733 real rows), so the number drifted
// from the real Needs a Call / Flagged for Review lanes directly below it.
//
// Static source checks alone (PART 22g's own style) would pass even if
// needsAttentionSignal() were accidentally defined as `return true;` —
// they can only confirm the right tokens appear in the right place, not
// that the counts come out right. So this PART goes one step further and
// actually RUNS the dashboard's real inline <script> (via Node's vm
// module, with the minimum possible DOM/fetch stubbing to let it load
// without throwing) and calls the real, unmodified needsAttentionSignal/
// applyFilters/renderTiles/triagePriority functions against fixture rows —
// proving the real counting behavior, not just the source text. No
// existing convention for this exists elsewhere in this file (dashboard
// tests so far are static-source-only); this is a deliberate, scoped
// exception for a bug that is specifically about wrong counts, not a
// general new testing pattern for this file.
function loadDashboardScript() {
  const source = readDashboardSource();
  const start = source.indexOf('<script>') + '<script>'.length;
  const end = source.indexOf('</script>', start);
  assert.ok(start !== -1 && end !== -1 && end > start, 'expected to find the dashboard\'s <script> tag');
  const scriptText = source.slice(start, end);

  // Minimum stubbing to let the WHOLE script run top-to-bottom without
  // throwing (it is not wrapped in a function — every top-level
  // function/var declaration runs immediately, ending in a real call to
  // init()). Confirmed by inspection that document/fetch/window/setTimeout/
  // clearTimeout/confirm are the only browser globals this script
  // references, and that init() is the only one of them actually INVOKED
  // at top level (everything else is only ever called from inside an
  // event handler or a fetch callback, never reached by this stub).
  const fakeElement = { addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} }, style: {}, set innerHTML(_) {}, get innerHTML() { return ''; } };
  const sandbox = {
    document: { getElementById: () => fakeElement, addEventListener() {}, querySelector: () => fakeElement, querySelectorAll: () => [] },
    window: {},
    fetch: () => Promise.reject(new Error('no network in tests')), // init()'s own .catch(...) swallows this harmlessly.
    setTimeout: () => 0,
    clearTimeout() {},
    confirm: () => true,
    console,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(scriptText, context, { filename: 'dashboard/index.html (inline script)' });
  return context;
}

// One shared load — the script has no side effects that would make reuse
// across assertions unsafe (init()'s fetch rejects into a swallowed
// .catch(), nothing else runs at top level), and re-running vm.runInContext
// for every single assertion below would be wasteful for no real benefit.
const dashboardCtx = loadDashboardScript();

test('dashboard/index.html (real code, executed) — needsAttentionSignal/triagePriority/laneOf/applyFilters/renderTiles all actually load from the real <script> with no top-level throw', () => {
  assert.strictEqual(typeof dashboardCtx.needsAttentionSignal, 'function');
  assert.strictEqual(typeof dashboardCtx.triagePriority, 'function');
  assert.strictEqual(typeof dashboardCtx.laneOf, 'function');
  assert.strictEqual(typeof dashboardCtx.applyFilters, 'function');
  assert.strictEqual(typeof dashboardCtx.renderTiles, 'function');
});

test('dashboard/index.html (real code, executed) — needsAttentionSignal() is true for severity_tier urgent/worth_a_look, false for just_a_record/no_issue, regardless of is_big_deal', () => {
  const { needsAttentionSignal } = dashboardCtx;
  // The exact regression this bug was: is_big_deal=true on every one of
  // these, so the OLD code would have called every single row below
  // "Needs Attention" — the new code must not.
  assert.strictEqual(needsAttentionSignal({ is_big_deal: true, severity_tier: 'urgent' }), true);
  assert.strictEqual(needsAttentionSignal({ is_big_deal: true, severity_tier: 'worth_a_look' }), true);
  assert.strictEqual(needsAttentionSignal({ is_big_deal: true, severity_tier: 'just_a_record' }), false);
  assert.strictEqual(needsAttentionSignal({ is_big_deal: true, severity_tier: 'no_issue' }), false);
});

test('dashboard/index.html (real code, executed) — needsAttentionSignal() falls through to the legacy needs_human_call/escalation_signal signal for an unassessed (severity_tier NULL) row, same as triagePriority() always has', () => {
  const { needsAttentionSignal } = dashboardCtx;
  assert.strictEqual(needsAttentionSignal({ severity_tier: null, needs_human_call: true }), true);
  assert.strictEqual(needsAttentionSignal({ severity_tier: null, escalation_signal: true }), true);
  assert.strictEqual(needsAttentionSignal({ severity_tier: null, needs_human_call: false, escalation_signal: false }), false);
});

test('dashboard/index.html (real code, executed) — renderTiles() Needs Attention number exactly equals the real count of active, non-resolved call+flagged rows (the actual bug: this used to count is_big_deal instead)', () => {
  const { renderTiles } = dashboardCtx;
  const rows = [
    { id: 1, is_big_deal: true, severity_tier: 'urgent', status: 'open' },           // counts (call)
    { id: 2, is_big_deal: true, severity_tier: 'worth_a_look', status: 'open' },     // counts (flagged)
    { id: 3, is_big_deal: true, severity_tier: 'just_a_record', status: 'open' },    // does NOT count — old code would have, this is the bug
    { id: 4, is_big_deal: true, severity_tier: 'no_issue', status: 'open' },         // does NOT count — old code would have, this is the bug
    { id: 5, is_big_deal: true, severity_tier: 'urgent', status: 'resolved' },       // does NOT count — resolved, exclusion preserved
    { id: 6, is_big_deal: true, severity_tier: 'urgent', merged_into_id: 'm-1' },    // does NOT count — merged, excluded from `active` before the filter even runs
    { id: 7, is_big_deal: false, severity_tier: null, needs_human_call: true, status: 'open' }, // counts — legacy fallback preserved
  ];
  const html = renderTiles(rows);
  const match = /tile-red[^>]*data-tile="needs_attention">\s*<div class="tile-number">(\d+)</.exec(html);
  assert.ok(match, 'expected to find the Needs Attention tile\'s rendered number');
  assert.strictEqual(Number(match[1]), 3, 'expected exactly rows 1, 2, and 7 to count — not is_big_deal\'s 6 out of 7');
});

test('dashboard/index.html (real code, executed) — applyFilters() with tile=\'needs_attention\' returns exactly the same rows renderTiles() counted (the top tile and the filtered list it drills into can never disagree)', () => {
  const { applyFilters } = dashboardCtx;
  const rows = [
    { id: 1, is_big_deal: true, severity_tier: 'urgent', status: 'open' },
    { id: 2, is_big_deal: true, severity_tier: 'worth_a_look', status: 'open' },
    { id: 3, is_big_deal: true, severity_tier: 'just_a_record', status: 'open' },
    { id: 4, is_big_deal: true, severity_tier: 'no_issue', status: 'open' },
    { id: 7, is_big_deal: false, severity_tier: null, needs_human_call: true, status: 'open' },
  ];
  dashboardCtx.filters.tile = 'needs_attention';
  try {
    const result = dashboardCtx.applyFilters(rows);
    assert.deepStrictEqual(result.map((c) => c.id), [1, 2, 7]);
  } finally {
    dashboardCtx.filters.tile = ''; // restore the default so later tests in this PART aren't affected.
  }
});

// ─── nameMatchCallout() (migration 20261002060000) — real code, executed
// via the same dashboardCtx the tests just above already load. ──────────
test('dashboard/index.html (real code, executed) — nameMatchCallout() renders nothing for a complaint with no suggestion, or one already reviewed', () => {
  const { nameMatchCallout } = dashboardCtx;
  assert.strictEqual(nameMatchCallout({ suggested_subject_type: null }), '');
  assert.strictEqual(nameMatchCallout({ suggested_subject_type: 'tenant', human_confirmed_subject_outcome: 'confirmed' }), '');
});

test('dashboard/index.html (real code, executed) — nameMatchCallout() renders every real candidate (Mason\'s point 1: the collision itself, not just one guess) with a dedicated confirm button carrying its own candidate id, plus one reject button, for a pending suggestion', () => {
  const { nameMatchCallout } = dashboardCtx;
  const html = nameMatchCallout({
    suggested_subject_type: 'tenant',
    suggested_subject_name_text: 'Jane Doe called about the leak',
    human_confirmed_subject_outcome: null,
    display: {
      property: { name: 'Sunset Apartments', address: '123 Main St' },
      name_match_candidates: [
        { id: 'tenant-aaa', name: 'Jane Doe' },
        { id: 'tenant-bbb', name: 'Jane A. Doe' },
      ],
    },
  });
  assert.ok(html.includes('2 tenants named like'), 'expected the plural collision headline naming the real candidate count');
  assert.ok(html.includes('Sunset Apartments'), 'expected the corroborating property shown, per Mason\'s point 1');
  assert.ok(html.includes('Jane Doe'));
  assert.ok(html.includes('Jane A. Doe'), 'expected BOTH real candidates rendered, neither dropped');
  assert.ok(html.includes('data-action="name-match-confirm"') && html.includes('data-candidate="tenant-aaa"'));
  assert.ok(html.includes('data-candidate="tenant-bbb"'));
  assert.ok(html.includes('data-action="name-match-reject"'));
});

test('dashboard/index.html (real code, executed) — nameMatchCallout() escapes a hostile candidate name/quoted text rather than injecting raw HTML', () => {
  const { nameMatchCallout } = dashboardCtx;
  const html = nameMatchCallout({
    suggested_subject_type: 'owner',
    suggested_subject_name_text: '<img src=x onerror=alert(1)>',
    human_confirmed_subject_outcome: null,
    display: { property: null, name_match_candidates: [{ id: 'owner-xxx', name: '<script>alert(1)</script>' }] },
  });
  assert.ok(!html.includes('<script>alert(1)</script>'), 'expected the candidate name to be escaped');
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'), 'expected the quoted AI text to be escaped');
});

test('dashboard/index.html (real code, executed) — renderCard() includes nameMatchCallout()\'s output for a card with a pending suggestion (wired into the real card, not just a standalone function nobody calls)', () => {
  const { renderCard } = dashboardCtx;
  const html = renderCard({
    id: 'c-nm-1', created_at: new Date().toISOString(), status: 'open', category: 'dispute', description: 'A tenant mentioned something.',
    suggested_subject_type: 'tenant', suggested_subject_name_text: 'Jane Doe', human_confirmed_subject_outcome: null,
    display: { property: { name: 'Sunset Apartments' }, name_match_candidates: [{ id: 'tenant-aaa', name: 'Jane Doe' }] },
  });
  assert.ok(html.includes('data-action="name-match-confirm"'), 'expected the name-match callout to actually appear inside a real rendered card');
});

// ============================================================================
// PART 23 — name-based complaint-to-person matching, the narrower, Mason-
// cleared, human-confirmed build (2026-10-02, Jarvis-relayed, Peter's
// explicit approval for THIS version only — full automatic resolution is
// OUT OF SCOPE). Schema: supabase/migrations/20261002060000_add_name_
// match_human_review_to_complaints.sql. Covers: (a) namesPlausiblyMatch —
// pure; (b) buildCall1Prompt/parseCall1Response's NAME_MATCH_SUGGESTIONS_
// ENABLED gating — pure, env-var save/restore; (c) findNameMatchCandidates —
// DB-touching, via significancePass._setSupabaseClientForTesting (never
// resolveUniqueMatch()'s "collapse to null on 2+" behavior — this function's
// entire point is the opposite); (d) applyCall1Result's own gating (shadow-
// mode flag AND property corroboration, both hard requirements) — same DI
// seam, run end-to-end rather than spied, because applyCall1Result() calls
// findNameMatchCandidates() as a bare same-module identifier, not through
// an imported module object, so spyOn() (which only intercepts property
// access on an imported module reference, e.g. significanceBatch.js calling
// significancePass.xyz()) cannot see this particular call at all — the
// real reason PART 20's own spyOn precedent doesn't apply here, confirmed
// by reading how spyOn and every one of its existing call sites actually
// work before reaching for it; (e) createComplaintRow's nameMatchSuggestion
// merge — reuses PART 15's existing makeFakeSupabaseClient/
// withFakeSignificancePass harness, same as PART 22d's severity-hook tests
// just above. (c)/(d)/(e) run inside ONE sequential IIFE for the same
// reason PART 18-22 already do: _setSupabaseClientForTesting mutates a
// single shared module-level binding, which concurrent asyncTest()s could
// race on.
// ============================================================================

// ─── 23a — namesPlausiblyMatch: containment, case-insensitivity, and the
// null-safety both callers (fetchActiveTenantsAtProperty's tenant names,
// fetchOwnersAtProperty's nullable owner.name) actually rely on. ──────────
test('significance-pass — namesPlausiblyMatch: a quoted sentence containing the candidate\'s name (case-insensitive) matches', () => {
  assert.strictEqual(significancePass.namesPlausiblyMatch('Jane Doe called about a leak in unit 4', 'Jane Doe'), true);
  assert.strictEqual(significancePass.namesPlausiblyMatch('jane doe called about a leak', 'Jane Doe'), true, 'expected case-insensitive match');
});

test('significance-pass — namesPlausiblyMatch: no match when the name is not actually contained in the quoted text', () => {
  assert.strictEqual(significancePass.namesPlausiblyMatch('John Smith called about a leak', 'Jane Doe'), false);
});

test('significance-pass — namesPlausiblyMatch: false (never throws) for a null/empty citedText or candidateName — the real shape owners.name (nullable) and a missing AI quote can both take', () => {
  assert.strictEqual(significancePass.namesPlausiblyMatch(null, 'Jane Doe'), false);
  assert.strictEqual(significancePass.namesPlausiblyMatch('Jane Doe called', null), false);
  assert.strictEqual(significancePass.namesPlausiblyMatch('Jane Doe called', ''), false);
  assert.strictEqual(significancePass.namesPlausiblyMatch('', 'Jane Doe'), false);
});

// ─── 23b — buildCall1Prompt / parseCall1Response gating: OFF means
// literally byte-for-byte the pre-existing prompt/parse behavior; ON adds
// exactly one new, parallel, citation-only field. ──────────────────────────
test('significance-pass — buildCall1Prompt: NAME_MATCH_SUGGESTIONS_ENABLED unset (default) produces a prompt BYTE-FOR-BYTE identical to the flag never having existed', () => {
  const prevFlag = process.env.NAME_MATCH_SUGGESTIONS_ENABLED;
  delete process.env.NAME_MATCH_SUGGESTIONS_ENABLED;
  try {
    const prompt = significancePass.buildCall1Prompt({ threadText: '(thread text)', addressMatched: false });
    assert.ok(prompt.includes('do not attempt to identify a specific\n   tenant or owner by name alone'), 'expected the ORIGINAL identification block wording, unchanged');
    assert.ok(!prompt.includes('name_text'), 'expected no name_text field in the requested JSON shape while the flag is off');
    assert.ok(!prompt.includes('If the thread\'s own text clearly names a\n   specific TENANT or OWNER'), 'expected none of the name-match variant\'s added sentences');
  } finally {
    if (prevFlag === undefined) delete process.env.NAME_MATCH_SUGGESTIONS_ENABLED; else process.env.NAME_MATCH_SUGGESTIONS_ENABLED = prevFlag;
  }
});

test('significance-pass — buildCall1Prompt: flag explicitly \'false\' (not just unset) behaves identically to unset — only the literal string \'true\' ever turns this on', () => {
  const prevFlag = process.env.NAME_MATCH_SUGGESTIONS_ENABLED;
  process.env.NAME_MATCH_SUGGESTIONS_ENABLED = 'false';
  try {
    const prompt = significancePass.buildCall1Prompt({ threadText: '(thread text)', addressMatched: false });
    assert.ok(!prompt.includes('name_text'));
  } finally {
    if (prevFlag === undefined) delete process.env.NAME_MATCH_SUGGESTIONS_ENABLED; else process.env.NAME_MATCH_SUGGESTIONS_ENABLED = prevFlag;
  }
});

test('significance-pass — buildCall1Prompt: flag \'true\' adds the name-citation sentence AND the name_text field to the requested JSON shape, never for an addressMatched=true call (identification block is omitted entirely either way)', () => {
  const prevFlag = process.env.NAME_MATCH_SUGGESTIONS_ENABLED;
  process.env.NAME_MATCH_SUGGESTIONS_ENABLED = 'true';
  try {
    const promptNoAddress = significancePass.buildCall1Prompt({ threadText: '(thread text)', addressMatched: false });
    assert.ok(promptNoAddress.includes('If the thread\'s own text clearly names a\n   specific TENANT or OWNER'));
    assert.ok(promptNoAddress.includes('"name_text": "quoted text"|null'));

    const promptAddressed = significancePass.buildCall1Prompt({ threadText: '(thread text)', addressMatched: true });
    assert.ok(!promptAddressed.includes('name_text'), 'expected no identification block AT ALL (so no name_text either) once an address already matched');
  } finally {
    if (prevFlag === undefined) delete process.env.NAME_MATCH_SUGGESTIONS_ENABLED; else process.env.NAME_MATCH_SUGGESTIONS_ENABLED = prevFlag;
  }
});

test('significance-pass — parseCall1Response: flag OFF never parses a name_text key, even if the raw response somehow contains one (defense in depth beyond "the model was never asked")', () => {
  const prevFlag = process.env.NAME_MATCH_SUGGESTIONS_ENABLED;
  delete process.env.NAME_MATCH_SUGGESTIONS_ENABLED;
  try {
    const raw = JSON.stringify({ resolution_status: 'open', category: 'dispute', why: 'x', tone_trend: null, identification: { property_text: null, vendor_text: null, name_text: 'Jane Doe' } });
    const parsed = significancePass.parseCall1Response(raw, { addressMatched: false });
    assert.strictEqual('name_text' in parsed.identification, false, 'expected the key to not even exist, not just be null');
  } finally {
    if (prevFlag === undefined) delete process.env.NAME_MATCH_SUGGESTIONS_ENABLED; else process.env.NAME_MATCH_SUGGESTIONS_ENABLED = prevFlag;
  }
});

test('significance-pass — parseCall1Response: flag ON parses a real name_text, trims it, and null-coerces a blank/missing one', () => {
  const prevFlag = process.env.NAME_MATCH_SUGGESTIONS_ENABLED;
  process.env.NAME_MATCH_SUGGESTIONS_ENABLED = 'true';
  try {
    const raw1 = JSON.stringify({ resolution_status: 'open', category: 'dispute', why: 'x', tone_trend: null, identification: { property_text: null, vendor_text: null, name_text: '  Jane Doe mentioned the leak  ' } });
    assert.strictEqual(significancePass.parseCall1Response(raw1, { addressMatched: false }).identification.name_text, 'Jane Doe mentioned the leak');

    const raw2 = JSON.stringify({ resolution_status: 'open', category: 'dispute', why: 'x', tone_trend: null, identification: { property_text: null, vendor_text: null, name_text: '   ' } });
    assert.strictEqual(significancePass.parseCall1Response(raw2, { addressMatched: false }).identification.name_text, null);

    const raw3 = JSON.stringify({ resolution_status: 'open', category: 'dispute', why: 'x', tone_trend: null, identification: { property_text: null, vendor_text: null } });
    assert.strictEqual(significancePass.parseCall1Response(raw3, { addressMatched: false }).identification.name_text, null);
  } finally {
    if (prevFlag === undefined) delete process.env.NAME_MATCH_SUGGESTIONS_ENABLED; else process.env.NAME_MATCH_SUGGESTIONS_ENABLED = prevFlag;
  }
});

// ─── 23c/d — findNameMatchCandidates + applyCall1Result's gating, both
// DB-touching via the same _setSupabaseClientForTesting seam PART 18h
// already proved safe for this exact module (no require.cache swap). One
// small, purpose-built fake — sized to exactly the tables this feature's
// own lookup touches (units/leases/tenants/properties/property_owners/
// owners) plus the handful of tables applyCall1Result's write path always
// touches regardless (missive_conversation_significance/missive_message_
// links/audit_log) — same "each PART's own fake, sized to what it actually
// needs" convention PART 22's severity fake client comment already states.
// maybeSingle()/single() added beyond makeFilteringFakeClient's own shape
// (used elsewhere in this file) because fetchOwnersAtProperty() needs it
// and that shared helper deliberately isn't touched here, to avoid any risk
// of changing behavior for the many other tests already using it. ────────
asyncResults.push((async () => {

function makeNameMatchDataFakeClient(tableData) {
  const state = { significanceUpserts: [], messageLinkInserts: [], auditLogInserts: [] };

  function makeChain(table) {
    const filters = [];
    let op = null, payload = null;
    const chain = {
      select() { if (!op) op = 'select'; return chain; },
      eq(field, value) { filters.push((row) => row[field] === value); return chain; },
      in(field, values) { filters.push((row) => values.includes(row[field])); return chain; },
      order() { return chain; },
      limit() { return chain; },
      upsert(row) { op = 'upsert'; payload = row; return chain; },
      insert(row) { op = 'insert'; payload = row; return chain; },
      maybeSingle() {
        const rows = (tableData[table] || []).filter((row) => filters.every((f) => f(row)));
        return Promise.resolve({ data: rows[0] || null, error: null });
      },
      single() {
        if (table === 'missive_conversation_significance' && op === 'upsert') {
          state.significanceUpserts.push(payload);
          return Promise.resolve({ data: { id: 'sig-23-test', ...payload }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve, reject) {
        let result;
        if (table === 'missive_message_links' && op === 'insert') {
          state.messageLinkInserts.push(payload);
          result = { data: null, error: null };
        } else if (table === 'audit_log' && op === 'insert') {
          state.auditLogInserts.push(payload);
          result = { data: null, error: null };
        } else {
          const rows = (tableData[table] || []).filter((row) => filters.every((f) => f(row)));
          result = { data: rows, error: null };
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }
  return { client: { from: (t) => makeChain(t) }, state };
}

// One small, realistic fixture: property "prop-1" (AppFolio id "af-prop-1")
// has one active tenant, Jane Doe, and one owner, John Owner — reused,
// with small variations, across every scenario below.
const PROP_1 = { id: 'prop-1', name: 'Sunset Apartments', address: '123 Main St', appfolio_id: 'af-prop-1' };
const BASE_TABLE_DATA = () => ({
  units: [{ id: 'unit-1', property_id: 'prop-1' }],
  leases: [{ unit_id: 'unit-1', tenant_id: 'tenant-1', status: 'active' }],
  tenants: [{ id: 'tenant-1', first_name: 'Jane', last_name: 'Doe' }],
  properties: [PROP_1],
  property_owners: [{ appfolio_property_id: 'af-prop-1', appfolio_owner_id: 'af-owner-1' }],
  owners: [{ id: 'owner-1', appfolio_id: 'af-owner-1', name: 'John Owner' }],
});

await runSerialCheck('significance-pass — findNameMatchCandidates: a single real tenant match at the given property is surfaced', async () => {
  significancePass._setSupabaseClientForTesting(makeNameMatchDataFakeClient(BASE_TABLE_DATA()).client);
  try {
    const result = await significancePass.findNameMatchCandidates({ nameText: 'Jane Doe called about a leak', propertyId: 'prop-1' });
    assert.deepStrictEqual(result, { subject_type: 'tenant', candidate_ids: ['tenant-1'] });
  } finally {
    significancePass._setSupabaseClientForTesting(null);
  }
});

await runSerialCheck('significance-pass — findNameMatchCandidates: TWO real tenant matches at the same property are BOTH surfaced, neither silently dropped (the exact opposite of resolveUniqueMatch\'s own "2+ matches = no match" behavior)', async () => {
  const tableData = BASE_TABLE_DATA();
  tableData.leases.push({ unit_id: 'unit-1', tenant_id: 'tenant-2', status: 'active' });
  tableData.tenants.push({ id: 'tenant-2', first_name: 'Jane', last_name: 'Doe' });
  significancePass._setSupabaseClientForTesting(makeNameMatchDataFakeClient(tableData).client);
  try {
    const result = await significancePass.findNameMatchCandidates({ nameText: 'Jane Doe called about a leak', propertyId: 'prop-1' });
    assert.strictEqual(result.subject_type, 'tenant');
    assert.deepStrictEqual(result.candidate_ids.slice().sort(), ['tenant-1', 'tenant-2'].sort(), 'expected BOTH real tenant candidates, not just one');
  } finally {
    significancePass._setSupabaseClientForTesting(null);
  }
});

await runSerialCheck('significance-pass — findNameMatchCandidates: TWO real owner matches are also both surfaced (same non-collapsing behavior on the owner side)', async () => {
  const tableData = BASE_TABLE_DATA();
  tableData.leases = []; tableData.tenants = []; // no tenant named "John Owner" — isolate the owner path.
  tableData.property_owners.push({ appfolio_property_id: 'af-prop-1', appfolio_owner_id: 'af-owner-2' });
  tableData.owners.push({ id: 'owner-2', appfolio_id: 'af-owner-2', name: 'John Owner' });
  significancePass._setSupabaseClientForTesting(makeNameMatchDataFakeClient(tableData).client);
  try {
    const result = await significancePass.findNameMatchCandidates({ nameText: 'spoke with John Owner this morning', propertyId: 'prop-1' });
    assert.strictEqual(result.subject_type, 'owner');
    assert.deepStrictEqual(result.candidate_ids.slice().sort(), ['owner-1', 'owner-2'].sort());
  } finally {
    significancePass._setSupabaseClientForTesting(null);
  }
});

await runSerialCheck('significance-pass — findNameMatchCandidates: a name plausibly matching BOTH a tenant and an owner at the same property returns null (Q\'s own judgment call — a cross-type collision can\'t be expressed in one suggestion row without silently dropping real candidates of the other type)', async () => {
  const tableData = BASE_TABLE_DATA();
  tableData.owners[0].name = 'Jane Doe'; // now the SAME name as the tenant fixture.
  significancePass._setSupabaseClientForTesting(makeNameMatchDataFakeClient(tableData).client);
  try {
    const result = await significancePass.findNameMatchCandidates({ nameText: 'Jane Doe called about a leak', propertyId: 'prop-1' });
    assert.strictEqual(result, null);
  } finally {
    significancePass._setSupabaseClientForTesting(null);
  }
});

await runSerialCheck('significance-pass — findNameMatchCandidates: no real candidate at all returns null, never a guess', async () => {
  significancePass._setSupabaseClientForTesting(makeNameMatchDataFakeClient(BASE_TABLE_DATA()).client);
  try {
    const result = await significancePass.findNameMatchCandidates({ nameText: 'a totally unrelated name, Bob Nobody', propertyId: 'prop-1' });
    assert.strictEqual(result, null);
  } finally {
    significancePass._setSupabaseClientForTesting(null);
  }
});

// Shared applyCall1Result() inputs — a benign, non-protected-class thread
// (so checkClaim()'s own Layer 1/2 never fires and never needs an
// ANTHROPIC_API_KEY), content-identified (addressMatch all-null) rather
// than address-matched, so Prompt B's own property/name resolution path is
// what's actually exercised, same as every other property/vendor
// resolution test elsewhere in this suite.
const APPLY_CALL1_BASE_ARGS = {
  mailbox_key: 'mb1', missive_conversation_id: 'conv-name-match-test', discoveryContext: 'historical_backfill',
  rows: [{ missive_message_id: 'm1', screening_completed_at: '2026-01-01T00:00:00.000Z' }],
  addressMatch: { subject_type: null, subject_id: null, vendor_id: null, property_id: null },
  threadText: 'Just a routine note about parking — nothing contentious here.',
  sharedDirectories: { properties: [PROP_1], vendors: [] },
};

await runSerialCheck('significance-pass — applyCall1Result: NAME_MATCH_SUGGESTIONS_ENABLED unset (default) is a TRUE no-op — nameMatchSuggestion is always null, and the new tenant/owner tables are NEVER even queried, even when the AI quoted both a resolvable property AND a real matching name', async () => {
  const prevFlag = process.env.NAME_MATCH_SUGGESTIONS_ENABLED;
  delete process.env.NAME_MATCH_SUGGESTIONS_ENABLED;
  const tableData = BASE_TABLE_DATA();
  const fake = makeNameMatchDataFakeClient(tableData);
  // Poison the three tables findNameMatchCandidates() would need, so this
  // test FAILS LOUDLY (not just "happens not to assert on it") if the flag
  // being off ever lets that lookup run anyway.
  const realUnits = fake.client.from;
  fake.client.from = (table) => {
    if (table === 'units' || table === 'leases' || table === 'property_owners') throw new Error(`true no-op violated: table "${table}" was queried while NAME_MATCH_SUGGESTIONS_ENABLED is unset`);
    return realUnits(table);
  };
  significancePass._setSupabaseClientForTesting(fake.client);
  try {
    const result = await significancePass.applyCall1Result({
      ...APPLY_CALL1_BASE_ARGS,
      call1: { resolution_status: 'open', category: 'dispute', why: 'A routine test.', tone_trend: null, identification: { property_text: 'Sunset Apartments', vendor_text: null, name_text: 'Jane Doe called about a leak' } },
    });
    assert.strictEqual(result.nameMatchSuggestion, null);
    assert.strictEqual(result.property_id, 'prop-1', 'expected property resolution itself to be completely unaffected by this flag');
  } finally {
    significancePass._setSupabaseClientForTesting(null);
    if (prevFlag === undefined) delete process.env.NAME_MATCH_SUGGESTIONS_ENABLED; else process.env.NAME_MATCH_SUGGESTIONS_ENABLED = prevFlag;
  }
});

await runSerialCheck('significance-pass — applyCall1Result: flag ON but NO property corroboration (property_text never resolved to a real property) — the hard requirement: no suggestion is ever computed, not even attempted, regardless of how clearly a name was quoted', async () => {
  const prevFlag = process.env.NAME_MATCH_SUGGESTIONS_ENABLED;
  process.env.NAME_MATCH_SUGGESTIONS_ENABLED = 'true';
  const tableData = BASE_TABLE_DATA();
  const fake = makeNameMatchDataFakeClient(tableData);
  const realFrom = fake.client.from;
  fake.client.from = (table) => {
    if (table === 'units' || table === 'leases' || table === 'property_owners') throw new Error(`hard requirement violated: table "${table}" was queried with no property corroboration at all`);
    return realFrom(table);
  };
  significancePass._setSupabaseClientForTesting(fake.client);
  try {
    const result = await significancePass.applyCall1Result({
      ...APPLY_CALL1_BASE_ARGS,
      call1: { resolution_status: 'open', category: 'dispute', why: 'A routine test.', tone_trend: null, identification: { property_text: null, vendor_text: null, name_text: 'Jane Doe called about a leak' } },
    });
    assert.strictEqual(result.nameMatchSuggestion, null);
    assert.strictEqual(result.property_id, null);
  } finally {
    significancePass._setSupabaseClientForTesting(null);
    if (prevFlag === undefined) delete process.env.NAME_MATCH_SUGGESTIONS_ENABLED; else process.env.NAME_MATCH_SUGGESTIONS_ENABLED = prevFlag;
  }
});

await runSerialCheck('significance-pass — applyCall1Result: flag ON, property_text resolves to a real property, AND a real tenant name-matches at THAT property — a full, correctly-shaped suggestion is computed (never writing subject_type/subject_id — those stay off this return value entirely)', async () => {
  const prevFlag = process.env.NAME_MATCH_SUGGESTIONS_ENABLED;
  process.env.NAME_MATCH_SUGGESTIONS_ENABLED = 'true';
  const { client } = makeNameMatchDataFakeClient(BASE_TABLE_DATA());
  significancePass._setSupabaseClientForTesting(client);
  try {
    const result = await significancePass.applyCall1Result({
      ...APPLY_CALL1_BASE_ARGS,
      call1: { resolution_status: 'open', category: 'dispute', why: 'A routine test.', tone_trend: null, identification: { property_text: 'Sunset Apartments', vendor_text: null, name_text: 'Jane Doe called about a leak' } },
    });
    assert.strictEqual(result.property_id, 'prop-1');
    assert.ok(result.nameMatchSuggestion, 'expected a real suggestion to be computed');
    assert.strictEqual(result.nameMatchSuggestion.suggested_subject_type, 'tenant');
    assert.deepStrictEqual(result.nameMatchSuggestion.suggested_subject_candidate_ids, ['tenant-1']);
    assert.strictEqual(result.nameMatchSuggestion.suggested_subject_name_text, 'Jane Doe called about a leak');
    assert.strictEqual(result.nameMatchSuggestion.suggested_subject_extracted_by, significancePass.CONTENT_PASS_VERSION);
    assert.ok(result.nameMatchSuggestion.suggested_subject_at);
  } finally {
    significancePass._setSupabaseClientForTesting(null);
    if (prevFlag === undefined) delete process.env.NAME_MATCH_SUGGESTIONS_ENABLED; else process.env.NAME_MATCH_SUGGESTIONS_ENABLED = prevFlag;
  }
});

await runSerialCheck('significance-pass — applyCall1Result: flag ON, property corroborated, but the quoted name matches NOBODY real at that property — no suggestion (null), same as no corroboration at all', async () => {
  const prevFlag = process.env.NAME_MATCH_SUGGESTIONS_ENABLED;
  process.env.NAME_MATCH_SUGGESTIONS_ENABLED = 'true';
  const { client } = makeNameMatchDataFakeClient(BASE_TABLE_DATA());
  significancePass._setSupabaseClientForTesting(client);
  try {
    const result = await significancePass.applyCall1Result({
      ...APPLY_CALL1_BASE_ARGS,
      call1: { resolution_status: 'open', category: 'dispute', why: 'A routine test.', tone_trend: null, identification: { property_text: 'Sunset Apartments', vendor_text: null, name_text: 'Bob Nobody called about a leak' } },
    });
    assert.strictEqual(result.property_id, 'prop-1');
    assert.strictEqual(result.nameMatchSuggestion, null);
  } finally {
    significancePass._setSupabaseClientForTesting(null);
    if (prevFlag === undefined) delete process.env.NAME_MATCH_SUGGESTIONS_ENABLED; else process.env.NAME_MATCH_SUGGESTIONS_ENABLED = prevFlag;
  }
});

// ─── 23e — createComplaintRow's nameMatchSuggestion merge: reuses PART
// 15's existing makeFakeSupabaseClient/withFakeSignificancePass harness
// (require.cache-swap-based — a DIFFERENT DI seam from _setSupabaseClient
// ForTesting above, proven safe to mix within one sequential IIFE already,
// by PART 18h's own identical pairing of both seams in a single test). ──
const NAME_MATCH_HOOK_BASE_ARGS = {
  mailbox_key: 'mb1', missive_conversation_id: 'conv-name-match-createrow-test', discoveryContext: 'historical_backfill',
  property_id: 'prop-1', vendor_id: null, addressMatch: { subject_type: null, subject_id: null },
  category: 'dispute', why: 'A routine test for the name-match createComplaintRow hook.',
  call2Fields: { needs_human_call: false, blocked_reason: null, blocked_party: null, escalation_signal: 'none', owner_instruction_rejected: null, owner_instruction_note_text: null },
  keywordCheck: { flagged_protected_class: false, flagged_category: null },
};

await runSerialCheck('significance-pass — createComplaintRow: nameMatchSuggestion omitted/null (the default — flag off, or no corroboration, or no real candidate) writes NONE of the suggested_subject_* columns, and subject_type/subject_id stay exactly what addressMatch said (never written from this path)', async () => {
  await withFakeSignificancePass({ conversationRows: [], existingComplaint: null }, async (freshSignificancePass, calls) => {
    await freshSignificancePass.createComplaintRow({ ...NAME_MATCH_HOOK_BASE_ARGS });
    const row = calls.complaintsInsert[0];
    assert.strictEqual('suggested_subject_type' in row, false);
    assert.strictEqual(row.subject_type, null);
    assert.strictEqual(row.subject_id, null);
  });
});

await runSerialCheck('significance-pass — createComplaintRow: a real nameMatchSuggestion is attached to the newly-created row\'s suggested_subject_* columns, and subject_type/subject_id are STILL never written from it (Mason\'s hard "full automatic resolution is OUT OF SCOPE" rule, enforced structurally: this function has no code path that copies a suggestion into subject_type/subject_id)', async () => {
  const suggestion = {
    suggested_subject_type: 'tenant',
    suggested_subject_name_text: 'Jane Doe called about a leak',
    suggested_subject_candidate_ids: ['tenant-1', 'tenant-2'],
    suggested_subject_extracted_by: significancePass.CONTENT_PASS_VERSION,
    suggested_subject_at: new Date().toISOString(),
  };
  await withFakeSignificancePass({ conversationRows: [], existingComplaint: null }, async (freshSignificancePass, calls) => {
    await freshSignificancePass.createComplaintRow({ ...NAME_MATCH_HOOK_BASE_ARGS, nameMatchSuggestion: suggestion });
    const row = calls.complaintsInsert[0];
    assert.strictEqual(row.suggested_subject_type, 'tenant');
    assert.strictEqual(row.suggested_subject_name_text, 'Jane Doe called about a leak');
    assert.deepStrictEqual(row.suggested_subject_candidate_ids, ['tenant-1', 'tenant-2']);
    assert.strictEqual(row.suggested_subject_extracted_by, significancePass.CONTENT_PASS_VERSION);
    assert.ok(row.suggested_subject_at);
    // The hard rule, checked directly on the actual row sent to the DB —
    // not inferred from the absence of a code path.
    assert.strictEqual(row.subject_type, null, 'expected subject_type to NEVER be set from a suggestion — only a later human confirm action (router.js) may ever do that');
    assert.strictEqual(row.subject_id, null, 'expected subject_id to NEVER be set from a suggestion');
    // needs_matching's existing formula (unchanged by this build) is keyed
    // on property_id/subject_type/vendor_id, not on whether a SUBJECT is
    // resolved specifically — and a name-match suggestion can only ever
    // exist when property_id is ALREADY resolved (Mason's hard
    // corroboration requirement), so needs_matching is correctly false
    // here, same as any other property-only-resolved complaint today. The
    // router.js test suite (complaint-tracking/test/run-tests.js) is where
    // "a rejection leaves needs_matching=TRUE" is actually proven, against
    // a complaint that was needs_matching=true to begin with.
    assert.strictEqual(row.needs_matching, false, 'expected needs_matching to follow the existing, unchanged formula (property_id is resolved here, same as any other content-identified complaint)');
  });
});

return { name: 'name-match build (PART 23) — sequential runner completed (each scenario above already reported its own PASS/FAIL)', pass: true };
})());

// ============================================================================
// PART 24 — retroactive name-match backfill build (2026-10-02, Jarvis-relayed
// build task). Schema: supabase/migrations/
// 20261002070000_add_retroactive_name_match_checked_at_to_complaints.sql
// (not yet applied — see lib/name-match-backfill.js's own header).
// Applies the SAME narrower, Mason-cleared, human-confirmed name-based-
// matching design PART 23 just proved for the live pipeline to the existing
// needs_matching=TRUE backlog instead. Covers: (a) pure prompt/parser
// functions — plain, synchronous test()s; (b) the driver query, mailbox-key
// join, batch submission, and write-back decision — sequential, inside its
// own runSerialCheck IIFE, same discipline as PART 22/23 above, for the
// identical reason (shared mutable test-override singletons on
// significancePass/nameMatchBackfill).
// ============================================================================

// ─── 24a — buildIdentificationPrompt: reuses significancePass's own
// IDENTIFICATION_BLOCK_WITH_NAME verbatim (imported, never copy-pasted —
// proven here by checking the prompt contains that exact exported string),
// substitutes threadText, and asks for the right JSON shape. ─────────────
test('name-match-backfill — buildIdentificationPrompt embeds significancePass.IDENTIFICATION_BLOCK_WITH_NAME verbatim (sourced from one place, never a second, copy-pasted wording)', () => {
  const prompt = nameMatchBackfill.buildIdentificationPrompt('some thread text');
  assert.ok(prompt.includes(significancePass.IDENTIFICATION_BLOCK_WITH_NAME), 'expected the exact, exported IDENTIFICATION_BLOCK_WITH_NAME text to appear in the prompt, unmodified');
});

test('name-match-backfill — buildIdentificationPrompt substitutes the thread text verbatim inside the """ ... """ block', () => {
  const prompt = nameMatchBackfill.buildIdentificationPrompt('Jane Doe called about a leak at Sunset Apartments.');
  assert.ok(prompt.includes('"""\nJane Doe called about a leak at Sunset Apartments.\n"""'));
});

test('name-match-backfill — buildIdentificationPrompt never asks for resolution_status/category/why/tone_trend — this complaint\'s original Call 1 already answered those; re-asking would be a second, redundant, billed judgment', () => {
  const prompt = nameMatchBackfill.buildIdentificationPrompt('x');
  assert.strictEqual(/resolution_status|tone_trend/.test(prompt), false);
});

test('name-match-backfill — buildIdentificationPrompt requests exactly the {identification: {property_text, vendor_text, name_text}} JSON shape, no markdown fence', () => {
  const prompt = nameMatchBackfill.buildIdentificationPrompt('x');
  assert.ok(prompt.includes('Respond with EXACTLY one JSON object, no markdown fence'));
  assert.ok(prompt.includes('{"identification": {"property_text": "quoted text"|null, "vendor_text": "quoted text"|null, "name_text": "quoted text"|null}}'));
});

// ─── 24b — parseIdentificationResponse: valid, missing/malformed, stray
// markdown fence (defensive, same posture every other parser in this
// codebase takes), non-string input. ─────────────────────────────────────
test('name-match-backfill — parseIdentificationResponse accepts a clean, valid response with all three fields', () => {
  const parsed = nameMatchBackfill.parseIdentificationResponse('{"identification": {"property_text": "123 Main St", "vendor_text": null, "name_text": "Jane Doe"}}');
  assert.deepStrictEqual(parsed, { property_text: '123 Main St', vendor_text: null, name_text: 'Jane Doe' });
});

test('name-match-backfill — parseIdentificationResponse tolerates a stray markdown fence', () => {
  const parsed = nameMatchBackfill.parseIdentificationResponse('```json\n{"identification": {"property_text": null, "vendor_text": null, "name_text": "Bob Nobody"}}\n```');
  assert.deepStrictEqual(parsed, { property_text: null, vendor_text: null, name_text: 'Bob Nobody' });
});

test('name-match-backfill — parseIdentificationResponse treats blank/whitespace-only strings as null', () => {
  const parsed = nameMatchBackfill.parseIdentificationResponse('{"identification": {"property_text": "   ", "vendor_text": null, "name_text": null}}');
  assert.deepStrictEqual(parsed, { property_text: null, vendor_text: null, name_text: null });
});

test('name-match-backfill — parseIdentificationResponse rejects a response with no "identification" object at all', () => {
  assert.strictEqual(nameMatchBackfill.parseIdentificationResponse('{"foo": "bar"}'), null);
});

test('name-match-backfill — parseIdentificationResponse rejects malformed JSON', () => {
  assert.strictEqual(nameMatchBackfill.parseIdentificationResponse('{"identification": {'), null);
});

test('name-match-backfill — parseIdentificationResponse rejects a non-string response', () => {
  assert.strictEqual(nameMatchBackfill.parseIdentificationResponse(null), null);
  assert.strictEqual(nameMatchBackfill.parseIdentificationResponse(undefined), null);
});

// ─── 24c — lib/name-match-backfill.js's driver/submit/write-back — sequential
// (see this PART's own header for why). ──────────────────────────────────
asyncResults.push((async () => {

// Every asyncResults.push((async () => {...})()) entry starts running
// IMMEDIATELY and interleaves with every other one at each other's own
// await boundaries — this is what "its own sequential runSerialCheck
// runner" (this PART's own header) means: sequential WITHIN itself, not
// isolated FROM the others. PART 23, just above, and this PART are the only
// two that both mutate the SAME shared singleton
// (significancePass._setSupabaseClientForTesting / spyOn(significancePass,
// ...)) — without waiting for every earlier entry to fully settle first,
// this PART's own setup/teardown could stomp on PART 23's fake client or
// spy mid-test (a real race, caught live while building this PART: PART
// 23's own "NAME_MATCH_SUGGESTIONS_ENABLED unset... TRUE no-op" test failed
// with "Cannot read properties of null" when this PART's cleanup ran
// concurrently and reset the shared client to null mid-test). Snapshotting
// the array BEFORE this IIFE's own promise is pushed into it (a few lines
// above) and awaiting that snapshot ensures this waits for exactly
// "everything already running," never itself.
await Promise.all(asyncResults.slice());

// A minimal, stateful, filtering fake for the `complaints`/
// `missive_conversation_significance` tables this module actually touches —
// purpose-built, same "each PART's own fake, sized to what it actually
// needs" convention PART 22's own makeSeverityFakeClient already states and
// follows. Deliberately does NOT attempt to fake missive_message_intake_
// search_safe/tenants/owners/leases/units/property_owners/vendors — tests
// below that need buildConversationContext() or findNameMatchCandidates()
// to actually run instead spy on/inject significancePass's own real,
// already-tested functions (via _setSupabaseClientForTesting and spyOn),
// exactly the isolation style PART 22/23 already use for the identical
// reason: those functions are already proven correct elsewhere in this
// suite (PART 13/23) — re-simulating their entire dependency chain here
// would test this build's own glue code through a maze of unrelated fakes,
// not the glue code itself.
function complaintsRowMatchesFilters(row, filters) {
  return filters.every((f) => {
    if (f.type === 'eq') return row[f.col] === f.val;
    if (f.type === 'is') return f.val === null ? (row[f.col] === null || row[f.col] === undefined) : row[f.col] === f.val;
    if (f.type === 'not-is-null') return !(row[f.col] === null || row[f.col] === undefined);
    return true;
  });
}
function makeNameMatchBackfillFakeClient(initialComplaintRows, sigRows = []) {
  const complaintRows = initialComplaintRows.map((r) => ({ ...r }));
  function makeChain(table) {
    const filters = [];
    let op = null, updateFields = null, rangeArgs = null, limitArg = null;
    const chain = {
      select() { if (!op) op = 'select'; return chain; },
      update(fields) { op = 'update'; updateFields = fields; return chain; },
      eq(col, val) { filters.push({ type: 'eq', col, val }); return chain; },
      is(col, val) { filters.push({ type: 'is', col, val }); return chain; },
      not(col, operator, val) { if (operator === 'is' && val === null) filters.push({ type: 'not-is-null', col }); return chain; },
      order() { return chain; },
      range(from, to) { rangeArgs = [from, to]; return chain; },
      limit(n) { limitArg = n; return chain; },
      maybeSingle() {
        if (table === 'complaints' && op === 'select') {
          const match = complaintRows.find((r) => complaintsRowMatchesFilters(r, filters));
          return Promise.resolve({ data: match ? { ...match } : null, error: null });
        }
        if (table === 'complaints' && op === 'update') {
          const idx = complaintRows.findIndex((r) => complaintsRowMatchesFilters(r, filters));
          if (idx === -1) return Promise.resolve({ data: null, error: null });
          complaintRows[idx] = { ...complaintRows[idx], ...updateFields };
          return Promise.resolve({ data: { ...complaintRows[idx] }, error: null });
        }
        if (table === 'missive_conversation_significance' && op === 'select') {
          const matches = sigRows.filter((r) => complaintsRowMatchesFilters(r, filters));
          const limited = limitArg ? matches.slice(0, limitArg) : matches;
          return Promise.resolve({ data: limited[0] || null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve, reject) {
        let result;
        if (table === 'complaints' && op === 'select') {
          let matches = complaintRows.filter((r) => complaintsRowMatchesFilters(r, filters));
          if (rangeArgs) matches = matches.slice(rangeArgs[0], rangeArgs[1] + 1);
          result = { data: matches.map((r) => ({ ...r })), error: null };
        } else {
          result = { data: [], error: null };
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  }
  return { client: { from: (t) => makeChain(t) }, complaintRows };
}

const succeededResult = (identification) => ({ type: 'succeeded', message: { content: [{ type: 'text', text: JSON.stringify({ identification }) }] } });

// ─── governance gate ──────────────────────────────────────────────────────
await runSerialCheck('name-match-backfill — submitNameMatchBackfillBatch refuses to run when NAME_MATCH_BACKFILL_GOVERNANCE_CLEARED is not \'true\' (checked BEFORE any Supabase/Anthropic call)', async () => {
  const prevFlag = process.env.NAME_MATCH_BACKFILL_GOVERNANCE_CLEARED;
  delete process.env.NAME_MATCH_BACKFILL_GOVERNANCE_CLEARED;
  try {
    await assert.rejects(
      nameMatchBackfill.submitNameMatchBackfillBatch({}),
      (err) => { assert.ok(err.message.includes('NAME_MATCH_BACKFILL_GOVERNANCE_CLEARED')); return true; }
    );
  } finally {
    if (prevFlag === undefined) delete process.env.NAME_MATCH_BACKFILL_GOVERNANCE_CLEARED; else process.env.NAME_MATCH_BACKFILL_GOVERNANCE_CLEARED = prevFlag;
  }
});

// ─── fetchEligibleComplaints — the driver query's own filters ────────────
await runSerialCheck('name-match-backfill — fetchEligibleComplaints excludes held rows, already-checked rows, and rows with no conversation to re-read; returns only the genuinely eligible ones', async () => {
  const { client } = makeNameMatchBackfillFakeClient([
    { id: 'c-eligible', needs_matching: true, held_legal_fair_housing: false, retroactive_name_match_checked_at: null, source_missive_conversation_id: 'conv-1', property_id: null },
    { id: 'c-held', needs_matching: true, held_legal_fair_housing: true, retroactive_name_match_checked_at: null, source_missive_conversation_id: 'conv-2', property_id: null },
    { id: 'c-already-checked', needs_matching: true, held_legal_fair_housing: false, retroactive_name_match_checked_at: '2026-10-01T00:00:00.000Z', source_missive_conversation_id: 'conv-3', property_id: null },
    { id: 'c-no-conversation', needs_matching: true, held_legal_fair_housing: false, retroactive_name_match_checked_at: null, source_missive_conversation_id: null, property_id: null },
    { id: 'c-not-needs-matching', needs_matching: false, held_legal_fair_housing: false, retroactive_name_match_checked_at: null, source_missive_conversation_id: 'conv-4', property_id: 'prop-1' },
  ]);
  nameMatchBackfill._setSupabaseClientForTesting(client);
  try {
    const rows = await nameMatchBackfill.fetchEligibleComplaints(500);
    assert.deepStrictEqual(rows.map((r) => r.id), ['c-eligible'], 'expected only the genuinely eligible row');
  } finally {
    nameMatchBackfill._setSupabaseClientForTesting(null);
  }
});

// ─── resolveMailboxKeyForConversation ─────────────────────────────────────
await runSerialCheck('name-match-backfill — resolveMailboxKeyForConversation returns the mailbox_key for a known conversation, and null when none is on file', async () => {
  const { client } = makeNameMatchBackfillFakeClient([], [{ missive_conversation_id: 'conv-1', mailbox_key: 'mb-1' }]);
  nameMatchBackfill._setSupabaseClientForTesting(client);
  try {
    assert.strictEqual(await nameMatchBackfill.resolveMailboxKeyForConversation('conv-1'), 'mb-1');
    assert.strictEqual(await nameMatchBackfill.resolveMailboxKeyForConversation('conv-unknown'), null);
  } finally {
    nameMatchBackfill._setSupabaseClientForTesting(null);
  }
});

// ─── submitNameMatchBackfillBatch — happy path + the unreadable-conversation
// skip, isolating buildConversationContext via spyOn (already proven
// correct by PART 13 — not re-tested here). ───────────────────────────────
await runSerialCheck('name-match-backfill — submitNameMatchBackfillBatch: happy path builds one request per eligible, readable complaint, submits ONE Anthropic batch, and records state; a complaint with no resolvable mailbox_key is skipped, left unchecked', async () => {
  process.env.NAME_MATCH_BACKFILL_GOVERNANCE_CLEARED = 'true';
  nameMatchBackfill.clearState();
  const { client, complaintRows } = makeNameMatchBackfillFakeClient(
    [
      { id: 'c-1', needs_matching: true, held_legal_fair_housing: false, retroactive_name_match_checked_at: null, source_missive_conversation_id: 'conv-1', property_id: null },
      { id: 'c-no-mailbox', needs_matching: true, held_legal_fair_housing: false, retroactive_name_match_checked_at: null, source_missive_conversation_id: 'conv-missing', property_id: null },
    ],
    [{ missive_conversation_id: 'conv-1', mailbox_key: 'mb-1' }]
  );
  nameMatchBackfill._setSupabaseClientForTesting(client);
  const contextSpy = spyOn(significancePass, 'buildConversationContext', async () => ({ threadText: 'Jane Doe called about a leak.' }));
  const batchesCreateCalls = [];
  nameMatchBackfill._setAnthropicClientForTesting({ beta: { messages: { batches: { create: async (args) => { batchesCreateCalls.push(args); return { id: 'batch_nm_1', processing_status: 'in_progress' }; } } } } });
  try {
    const result = await nameMatchBackfill.submitNameMatchBackfillBatch({});
    assert.strictEqual(result.submitted, true);
    assert.strictEqual(result.requestCount, 1, 'expected only the one readable complaint to produce a request');
    assert.strictEqual(result.skippedUnreadable, 1, 'expected the no-mailbox complaint to be skipped as unreadable');
    assert.strictEqual(batchesCreateCalls.length, 1);
    assert.strictEqual(batchesCreateCalls[0].requests.length, 1);
    assert.strictEqual(batchesCreateCalls[0].requests[0].custom_id, 'c-1');
    assert.strictEqual(complaintRows.find((r) => r.id === 'c-1').retroactive_name_match_checked_at, null, 'expected submission alone to write nothing to complaints yet — only write-back writes anything');
    assert.strictEqual(complaintRows.find((r) => r.id === 'c-no-mailbox').retroactive_name_match_checked_at, null, 'expected the skipped-as-unreadable row to stay unchecked, not stamped');

    const state = nameMatchBackfill.readState();
    assert.strictEqual(state.anthropic_batch_id, 'batch_nm_1');
    assert.deepStrictEqual(state.complaint_ids, ['c-1']);
  } finally {
    contextSpy.restore();
    nameMatchBackfill._setSupabaseClientForTesting(null);
    nameMatchBackfill._setAnthropicClientForTesting(null);
    nameMatchBackfill.clearState();
    delete process.env.NAME_MATCH_BACKFILL_GOVERNANCE_CLEARED;
  }
});

await runSerialCheck('name-match-backfill — submitNameMatchBackfillBatch: an unfinished in-flight batch refuses to submit a new one, and makes ZERO Anthropic calls', async () => {
  process.env.NAME_MATCH_BACKFILL_GOVERNANCE_CLEARED = 'true';
  nameMatchBackfill.writeState({ anthropic_batch_id: 'batch_in_flight', anthropic_status: 'in_progress', submitted_at: new Date().toISOString(), complaint_ids: ['c-1'], results_retrieved_at: null, submitted_by: 'test' });
  nameMatchBackfill._setAnthropicClientForTesting({ beta: { messages: { batches: { create: async () => { throw new Error('must not be called while a batch is already in flight'); } } } } });
  try {
    const result = await nameMatchBackfill.submitNameMatchBackfillBatch({});
    assert.strictEqual(result.submitted, false);
    assert.strictEqual(result.reason, 'unfinished_batch_exists');
  } finally {
    nameMatchBackfill._setAnthropicClientForTesting(null);
    nameMatchBackfill.clearState();
    delete process.env.NAME_MATCH_BACKFILL_GOVERNANCE_CLEARED;
  }
});

// ─── applyOneNameMatchResult — the write-back decision, the task's own
// required scenarios. Tests below that need findNameMatchCandidates() to
// actually run give significancePass its OWN directory fixture via this
// small, purpose-built fake — it must support .maybeSingle() (fetchOwnersAtProperty's
// own `.from('properties')...eq('id', propertyId).maybeSingle()` call,
// significance-pass.js, needed on EVERY findNameMatchCandidates() call,
// property-less or not) as well as plain array results (.eq/.in without
// .maybeSingle(), for units/leases/tenants/property_owners/owners) — a real
// gap an earlier draft of these tests had (no .maybeSingle() at all),
// caught by these very tests failing for real against significance-pass.js's
// actual query shape rather than a guessed one. ───────────────────────────
function makeNameMatchDirectoryFakeClient(tableData) {
  function makeChain(table) {
    const filters = [];
    const chain = {
      select() { return chain; },
      eq(col, val) { filters.push((row) => row[col] === val); return chain; },
      in(col, vals) { filters.push((row) => vals.includes(row[col])); return chain; },
      maybeSingle() {
        const rows = (tableData[table] || []).filter((row) => filters.every((f) => f(row)));
        return Promise.resolve({ data: rows[0] || null, error: null });
      },
      then(resolve, reject) {
        const rows = (tableData[table] || []).filter((row) => filters.every((f) => f(row)));
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      },
    };
    return chain;
  }
  return { from: (t) => makeChain(t) };
}

const PROP_1 = { id: 'prop-1', name: 'Sunset Apartments', address: '123 Main St', appfolio_id: 'af-prop-1' };
const PROPERTY_DIRECTORY = [PROP_1];
// Shared fixture: one property, one active tenant (Jane Doe), no owners —
// reused, as-is, by every scenario below that needs a real name-match
// candidate lookup to actually run.
const NAME_MATCH_TABLE_DATA = () => ({
  units: [{ id: 'unit-1', property_id: 'prop-1' }],
  leases: [{ unit_id: 'unit-1', tenant_id: 'tenant-1', status: 'active' }],
  tenants: [{ id: 'tenant-1', first_name: 'Jane', last_name: 'Doe' }],
  property_owners: [],
  owners: [],
  properties: [PROP_1],
});

await runSerialCheck('name-match-backfill — applyOneNameMatchResult: a non-succeeded batch result writes nothing (errored/canceled/expired contract) — stays eligible for the next run', async () => {
  const { client, complaintRows } = makeNameMatchBackfillFakeClient([{ id: 'c-1', property_id: null, held_legal_fair_housing: false, retroactive_name_match_checked_at: null }]);
  nameMatchBackfill._setSupabaseClientForTesting(client);
  try {
    const outcome = await nameMatchBackfill.applyOneNameMatchResult({ complaintId: 'c-1', result: { type: 'errored', error: { type: 'api_error' } }, propertyDirectory: PROPERTY_DIRECTORY });
    assert.strictEqual(outcome, 'no_row_written');
    assert.strictEqual(complaintRows[0].retroactive_name_match_checked_at, null);
  } finally {
    nameMatchBackfill._setSupabaseClientForTesting(null);
  }
});

await runSerialCheck('name-match-backfill — applyOneNameMatchResult: a succeeded-but-unparseable response writes nothing (no in-batch retry is possible)', async () => {
  const { client, complaintRows } = makeNameMatchBackfillFakeClient([{ id: 'c-1', property_id: null, held_legal_fair_housing: false, retroactive_name_match_checked_at: null }]);
  nameMatchBackfill._setSupabaseClientForTesting(client);
  try {
    const outcome = await nameMatchBackfill.applyOneNameMatchResult({ complaintId: 'c-1', result: { type: 'succeeded', message: { content: [{ type: 'text', text: 'not json at all' }] } }, propertyDirectory: PROPERTY_DIRECTORY });
    assert.strictEqual(outcome, 'no_row_written');
    assert.strictEqual(complaintRows[0].retroactive_name_match_checked_at, null);
  } finally {
    nameMatchBackfill._setSupabaseClientForTesting(null);
  }
});

await runSerialCheck('name-match-backfill — applyOneNameMatchResult: a held row at write-back time is NEVER touched, even just to stamp "checked, found nothing" (defense in depth, even though the DB CHECK would also reject it)', async () => {
  significancePass._setSupabaseClientForTesting(makeNameMatchBackfillFakeClient([]).client); // poisoned-by-omission: findNameMatchCandidates must never be reached for a held row.
  const { client, complaintRows } = makeNameMatchBackfillFakeClient([{ id: 'c-1', property_id: 'prop-1', held_legal_fair_housing: true, retroactive_name_match_checked_at: null }]);
  nameMatchBackfill._setSupabaseClientForTesting(client);
  try {
    const outcome = await nameMatchBackfill.applyOneNameMatchResult({ complaintId: 'c-1', result: succeededResult({ property_text: null, vendor_text: null, name_text: 'Jane Doe called about a leak' }), propertyDirectory: PROPERTY_DIRECTORY });
    assert.strictEqual(outcome, 'no_row_written');
    assert.strictEqual(complaintRows[0].retroactive_name_match_checked_at, null, 'expected a held row to never get retroactive_name_match_checked_at set');
    assert.strictEqual('suggested_subject_type' in complaintRows[0], false);
  } finally {
    nameMatchBackfill._setSupabaseClientForTesting(null);
    significancePass._setSupabaseClientForTesting(null);
  }
});

await runSerialCheck('name-match-backfill — applyOneNameMatchResult: a row already checked at write-back time is skipped, not re-written (idempotent against a re-run or a race)', async () => {
  const { client, complaintRows } = makeNameMatchBackfillFakeClient([{ id: 'c-1', property_id: 'prop-1', held_legal_fair_housing: false, retroactive_name_match_checked_at: '2026-10-01T00:00:00.000Z' }]);
  nameMatchBackfill._setSupabaseClientForTesting(client);
  try {
    const outcome = await nameMatchBackfill.applyOneNameMatchResult({ complaintId: 'c-1', result: succeededResult({ property_text: null, vendor_text: null, name_text: 'Jane Doe called about a leak' }), propertyDirectory: PROPERTY_DIRECTORY });
    assert.strictEqual(outcome, 'no_row_written');
    assert.strictEqual(complaintRows[0].retroactive_name_match_checked_at, '2026-10-01T00:00:00.000Z', 'expected the already-checked timestamp to never be overwritten');
  } finally {
    nameMatchBackfill._setSupabaseClientForTesting(null);
  }
});

await runSerialCheck('name-match-backfill — applyOneNameMatchResult: PROPERTY-LESS complaint — property_text is resolved against the real directory FIRST, then a real name-match candidate at that resolved property is found and written, alongside retroactive_name_match_checked_at', async () => {
  significancePass._setSupabaseClientForTesting(makeNameMatchDirectoryFakeClient(NAME_MATCH_TABLE_DATA()));
  const { client, complaintRows } = makeNameMatchBackfillFakeClient([{ id: 'c-1', property_id: null, held_legal_fair_housing: false, retroactive_name_match_checked_at: null }]);
  nameMatchBackfill._setSupabaseClientForTesting(client);
  try {
    const outcome = await nameMatchBackfill.applyOneNameMatchResult({
      complaintId: 'c-1',
      result: succeededResult({ property_text: 'Sunset Apartments', vendor_text: null, name_text: 'Jane Doe called about a leak' }),
      propertyDirectory: PROPERTY_DIRECTORY,
    });
    assert.strictEqual(outcome, 'written_with_suggestion');
    const row = complaintRows[0];
    assert.strictEqual(row.suggested_subject_type, 'tenant');
    assert.strictEqual(row.suggested_subject_name_text, 'Jane Doe called about a leak');
    assert.deepStrictEqual(row.suggested_subject_candidate_ids, ['tenant-1']);
    assert.strictEqual(row.suggested_subject_extracted_by, nameMatchBackfill.NAME_MATCH_BACKFILL_TOOL_VERSION);
    assert.ok(row.suggested_subject_at);
    assert.ok(row.retroactive_name_match_checked_at);
    assert.strictEqual(row.property_id, null, 'expected the freshly-resolved property_id to be used only in-memory, never written back onto the complaint (a deliberate, documented scope decision)');
  } finally {
    nameMatchBackfill._setSupabaseClientForTesting(null);
    significancePass._setSupabaseClientForTesting(null);
  }
});

await runSerialCheck('name-match-backfill — applyOneNameMatchResult: ALREADY-PROPERTIED complaint — skips re-resolving property_text entirely (resolveUniqueMatch never called), uses the complaint\'s own stored property_id directly for the name-match corroboration', async () => {
  const resolveUniqueMatchSpy = spyOn(significancePass, 'resolveUniqueMatch', () => { throw new Error('must not be called — property_id was already resolved on the row'); });
  significancePass._setSupabaseClientForTesting(makeNameMatchDirectoryFakeClient(NAME_MATCH_TABLE_DATA()));
  const { client, complaintRows } = makeNameMatchBackfillFakeClient([{ id: 'c-1', property_id: 'prop-1', held_legal_fair_housing: false, retroactive_name_match_checked_at: null }]);
  nameMatchBackfill._setSupabaseClientForTesting(client);
  try {
    const outcome = await nameMatchBackfill.applyOneNameMatchResult({
      complaintId: 'c-1',
      // property_text present but must be IGNORED — this complaint already has a property_id.
      result: succeededResult({ property_text: 'A totally different, unrelated address', vendor_text: null, name_text: 'Jane Doe called about a leak' }),
      propertyDirectory: PROPERTY_DIRECTORY,
    });
    assert.strictEqual(outcome, 'written_with_suggestion');
    assert.deepStrictEqual(complaintRows[0].suggested_subject_candidate_ids, ['tenant-1'], 'expected the candidate lookup to use the EXISTING property_id, never the (ignored) property_text');
  } finally {
    resolveUniqueMatchSpy.restore();
    nameMatchBackfill._setSupabaseClientForTesting(null);
    significancePass._setSupabaseClientForTesting(null);
  }
});

await runSerialCheck('name-match-backfill — applyOneNameMatchResult: NO property corroboration at all (no stored property_id, and property_text never resolves to a real property) — the candidate lookup is never even attempted; checked_at is stamped, suggestion fields stay null', async () => {
  significancePass._setSupabaseClientForTesting({ from: () => { throw new Error('must not be queried — no property corroboration exists, so findNameMatchCandidates must never run'); } });
  const { client, complaintRows } = makeNameMatchBackfillFakeClient([{ id: 'c-1', property_id: null, held_legal_fair_housing: false, retroactive_name_match_checked_at: null }]);
  nameMatchBackfill._setSupabaseClientForTesting(client);
  try {
    const outcome = await nameMatchBackfill.applyOneNameMatchResult({
      complaintId: 'c-1',
      result: succeededResult({ property_text: 'a property that matches nothing on file', vendor_text: null, name_text: 'Jane Doe called about a leak' }),
      propertyDirectory: PROPERTY_DIRECTORY,
    });
    assert.strictEqual(outcome, 'written_no_suggestion');
    const row = complaintRows[0];
    assert.ok(row.retroactive_name_match_checked_at, 'expected checked_at to be stamped even with zero property corroboration');
    assert.strictEqual('suggested_subject_type' in row, false, 'expected the five suggestion columns to be completely absent from the update, not just null');
  } finally {
    nameMatchBackfill._setSupabaseClientForTesting(null);
    significancePass._setSupabaseClientForTesting(null);
  }
});

await runSerialCheck('name-match-backfill — applyOneNameMatchResult: real property corroboration, but the quoted name matches NOBODY real at that property — checked_at stamped, suggestion fields stay null (same observable outcome as no corroboration at all)', async () => {
  significancePass._setSupabaseClientForTesting(makeNameMatchDirectoryFakeClient(NAME_MATCH_TABLE_DATA()));
  const { client, complaintRows } = makeNameMatchBackfillFakeClient([{ id: 'c-1', property_id: 'prop-1', held_legal_fair_housing: false, retroactive_name_match_checked_at: null }]);
  nameMatchBackfill._setSupabaseClientForTesting(client);
  try {
    const outcome = await nameMatchBackfill.applyOneNameMatchResult({
      complaintId: 'c-1',
      result: succeededResult({ property_text: null, vendor_text: null, name_text: 'a totally unrelated name, Bob Nobody' }),
      propertyDirectory: PROPERTY_DIRECTORY,
    });
    assert.strictEqual(outcome, 'written_no_suggestion');
    assert.ok(complaintRows[0].retroactive_name_match_checked_at);
    assert.strictEqual('suggested_subject_type' in complaintRows[0], false);
  } finally {
    nameMatchBackfill._setSupabaseClientForTesting(null);
    significancePass._setSupabaseClientForTesting(null);
  }
});

await runSerialCheck('name-match-backfill — applyOneNameMatchResult: lost a race (retroactive_name_match_checked_at set by something else between the read and the write) — skipped, not overwritten', async () => {
  significancePass._setSupabaseClientForTesting(makeNameMatchDirectoryFakeClient(NAME_MATCH_TABLE_DATA()));
  // The fresh re-fetch (inside applyOneNameMatchResult) sees NULL (so it proceeds), but
  // the update's own `.is('retroactive_name_match_checked_at', null)` filter — applied
  // against the fake client's CURRENT row state at update time — is what actually
  // models the race: flip the row to already-checked between the read and the update
  // by using a client whose maybeSingle() (the read) always reports the ORIGINAL row,
  // while the row array itself has already moved on.
  const { client, complaintRows } = makeNameMatchBackfillFakeClient([{ id: 'c-1', property_id: 'prop-1', held_legal_fair_housing: false, retroactive_name_match_checked_at: null }]);
  const realFrom = client.from;
  client.from = (table) => {
    const chain = realFrom(table);
    if (table === 'complaints') {
      const realMaybeSingle = chain.maybeSingle.bind(chain);
      const realUpdate = chain.update.bind(chain);
      chain.update = (fields) => { complaintRows[0].retroactive_name_match_checked_at = '2026-10-01T00:00:00.000Z'; return realUpdate(fields); }; // simulates another process winning the race the instant this update is issued.
      chain.maybeSingle = realMaybeSingle;
    }
    return chain;
  };
  nameMatchBackfill._setSupabaseClientForTesting(client);
  try {
    const outcome = await nameMatchBackfill.applyOneNameMatchResult({
      complaintId: 'c-1',
      result: succeededResult({ property_text: null, vendor_text: null, name_text: 'Jane Doe called about a leak' }),
      propertyDirectory: PROPERTY_DIRECTORY,
    });
    assert.strictEqual(outcome, 'no_row_written');
    assert.strictEqual(complaintRows[0].retroactive_name_match_checked_at, '2026-10-01T00:00:00.000Z', 'expected the concurrent writer\'s value to survive, never overwritten');
    assert.strictEqual('suggested_subject_type' in complaintRows[0], false, 'expected this call\'s own suggestion to never be written once it lost the race');
  } finally {
    nameMatchBackfill._setSupabaseClientForTesting(null);
    significancePass._setSupabaseClientForTesting(null);
  }
});

// ─── checkAndWriteBackNameMatchBackfillBatch ──────────────────────────────
await runSerialCheck('name-match-backfill — checkAndWriteBackNameMatchBackfillBatch reports {found:false} when no in-flight batch is known', async () => {
  nameMatchBackfill.clearState();
  const result = await nameMatchBackfill.checkAndWriteBackNameMatchBackfillBatch();
  assert.deepStrictEqual(result, { found: false });
});

await runSerialCheck('name-match-backfill — checkAndWriteBackNameMatchBackfillBatch reports status, not complete, while Anthropic still shows the batch in_progress (never streams results early)', async () => {
  nameMatchBackfill.writeState({ anthropic_batch_id: 'batch_nm_test_1', anthropic_status: 'in_progress', submitted_at: new Date().toISOString(), complaint_ids: ['c-1'], results_retrieved_at: null, submitted_by: 'test' });
  nameMatchBackfill._setAnthropicClientForTesting({ beta: { messages: { batches: {
    retrieve: async () => ({ processing_status: 'in_progress' }),
    results: async () => { throw new Error('must not be called while still in_progress'); },
  } } } });
  try {
    const result = await nameMatchBackfill.checkAndWriteBackNameMatchBackfillBatch();
    assert.strictEqual(result.alreadyComplete, false);
    assert.strictEqual(result.status, 'in_progress');
  } finally {
    nameMatchBackfill._setAnthropicClientForTesting(null);
    nameMatchBackfill.clearState();
  }
});

await runSerialCheck('name-match-backfill — checkAndWriteBackNameMatchBackfillBatch, once Anthropic reports \'ended\', streams real results, writes them back (including the resumability proof: re-running it is a pure no-op), and marks the state file fully retrieved', async () => {
  significancePass._setSupabaseClientForTesting(makeNameMatchDirectoryFakeClient(NAME_MATCH_TABLE_DATA()));
  const { client, complaintRows } = makeNameMatchBackfillFakeClient([
    { id: 'c-1', property_id: 'prop-1', held_legal_fair_housing: false, retroactive_name_match_checked_at: null },
    { id: 'c-2', property_id: null, held_legal_fair_housing: false, retroactive_name_match_checked_at: null },
  ]);
  nameMatchBackfill._setSupabaseClientForTesting(client);
  nameMatchBackfill.writeState({ anthropic_batch_id: 'batch_nm_test_2', anthropic_status: 'in_progress', submitted_at: new Date().toISOString(), complaint_ids: ['c-1', 'c-2'], results_retrieved_at: null, submitted_by: 'test' });

  const fakeAnthropic = { beta: { messages: { batches: {
    retrieve: async () => ({ processing_status: 'ended' }),
    results: async () => asyncIterableFromArray([
      { custom_id: 'c-1', result: succeededResult({ property_text: null, vendor_text: null, name_text: 'Jane Doe called about a leak' }) },
      { custom_id: 'c-2', result: { type: 'errored', error: { type: 'api_error' } } },
    ]),
  } } } };
  nameMatchBackfill._setAnthropicClientForTesting(fakeAnthropic);
  try {
    const result = await nameMatchBackfill.checkAndWriteBackNameMatchBackfillBatch();
    assert.strictEqual(result.alreadyComplete, true);
    assert.strictEqual(result.justCompleted, true);
    assert.strictEqual(result.summary.processed, 2);
    assert.strictEqual(result.summary.written_with_suggestion, 1);
    assert.strictEqual(result.summary.no_row_written, 1);
    assert.strictEqual(complaintRows.find((r) => r.id === 'c-1').suggested_subject_type, 'tenant');
    assert.strictEqual(complaintRows.find((r) => r.id === 'c-2').retroactive_name_match_checked_at, null, 'expected the errored item to stay unchecked');
    assert.ok(result.state.results_retrieved_at);

    const second = await nameMatchBackfill.checkAndWriteBackNameMatchBackfillBatch();
    assert.strictEqual(second.alreadyComplete, true);
    assert.strictEqual(second.justCompleted, undefined, 'expected a re-run to be a pure no-op — proves the file-based resumability contract actually holds');
  } finally {
    nameMatchBackfill._setSupabaseClientForTesting(null);
    nameMatchBackfill._setAnthropicClientForTesting(null);
    significancePass._setSupabaseClientForTesting(null);
    nameMatchBackfill.clearState();
  }
});

return { name: 'name-match backfill build (PART 24) — sequential runner completed (each scenario above already reported its own PASS/FAIL)', pass: true };
})());

// ─── Report ──────────────────────────────────────────────────────────────
async function main() {
  const resolvedAsync = await Promise.all(asyncResults);
  const all = [...results, ...resolvedAsync];

  console.log('\nArchive Search — Build Test Suite\n' + '='.repeat(60));
  let failCount = 0;
  for (const r of all) {
    if (r.pass) {
      console.log(`PASS  ${r.name}`);
    } else {
      failCount += 1;
      console.log(`FAIL  ${r.name}`);
      console.log(`      ${r.error}`);
    }
  }
  console.log('='.repeat(60));
  console.log(`${all.length - failCount}/${all.length} passed`);

  if (failCount > 0) process.exitCode = 1;
}

main();
