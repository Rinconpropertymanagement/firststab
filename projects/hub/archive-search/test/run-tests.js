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

test('router.js — the search route queries missive_message_intake_search_safe only, sorts delivered_at DESC, and uses websearch full-text search — never the raw table', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'router.js'), 'utf8');
  const start = source.indexOf("router.get('/api/archive-search/search'");
  const end = source.indexOf("router.get('/api/archive-search/message/:id'");
  assert.ok(start !== -1 && end !== -1 && end > start, 'expected to find both route boundaries');
  const body = source.slice(start, end);
  assert.ok(body.includes(".from('missive_message_intake_search_safe')"), 'expected the search route to query the safe view');
  assert.ok(body.includes("type: 'websearch'"), "expected websearch_to_tsquery via textSearch's websearch type");
  assert.ok(body.includes(".order('delivered_at', { ascending: false })"), 'expected newest-first ordering, not relevance-ranked');
  assert.ok(body.includes("if (!q)") && body.includes('status(400)'), 'expected an empty/missing q to be rejected with a 400');
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
const { computeSilenceContext } = require('../../complaint-tracking/lib/process-pending-messages');

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

test('significance-pass — shouldCreateComplaint: the negative case — none of the four conditions true means NO complaint row', () => {
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
  return { from: (table) => makeChain(table) };
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
  return { client: { from: (table) => makeChain(table) }, calls };
}

test('significance-pass — fetchDriverPage() queries missive_message_intake_search_safe_clear_branch, not the wider missive_message_intake_search_safe (migration 20260918020000, point 1 — source-scanned, matching this suite\'s own established convention for a single, unambiguous call-site check)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'significance-pass.js'), 'utf8');
  const start = source.indexOf('async function fetchDriverPage');
  assert.ok(start !== -1, 'expected to find fetchDriverPage()');
  const body = source.slice(start, source.indexOf('\n}', start));
  assert.ok(body.includes(".from('missive_message_intake_search_safe_clear_branch')"), 'expected fetchDriverPage() to query the new clear_branch view');
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

  return { name: 'significance-batch — PART 18 sequential runner completed (each scenario above already reported its own PASS/FAIL)', pass: true };
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
