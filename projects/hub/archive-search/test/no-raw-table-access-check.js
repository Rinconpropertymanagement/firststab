/**
 * test/no-raw-table-access-check.js
 *
 * THE REQUIRED, NAMED DELIVERABLE (archive-search-technical-spec.md,
 * "Resolving Finding 1") — promoted from a recommendation to a binding
 * build requirement by Asimov's and Mason's real technical-spec review,
 * 2026-09-10: "a test or CI check asserting that no file under
 * archive-search/router.js or archive-search/lib/, other than
 * screening-pass.js, contains the literal string 'missive_message_intake'
 * outside of missive_message_intake_search_safe." This is the one, real,
 * enforced backstop for that rule, given that every Hub route shares one
 * Supabase service-role connection with full table access regardless of
 * any view or RLS policy (Finding 1's own "the real, honest limit that
 * remains" — this is convention plus a lint check, not a database
 * guarantee, stated there plainly and not repeated here).
 *
 * SCOPE OF THE EXEMPTIONS — a documented, deliberate call, flagged
 * explicitly (not a silent deviation from the spec's own literal
 * sentence), verified against the real files below (see the FALSE
 * POSITIVE note under ALLOWED_SUFFIX_PATTERNS for the third one, found by
 * actually running this check against the real code, not assumed up
 * front):
 *
 *   1. missive_message_intake_search_safe — the exact suffix the spec's
 *      own sentence names (Finding 1's search surface).
 *   2. missive_message_intake_held_review_safe — NOT named in Finding 1's
 *      own literal sentence, which was written before Finding 8 (the
 *      held-review export) existed later in the same document. Both
 *      suffixes name real, screened VIEWS this build's own schema provides
 *      (20260910030000_archive_search_schema.sql, Sections C and F) —
 *      never the raw base table. Excluding this one would make the check
 *      reject held-review-export's own spec-required, Mason-Condition-4
 *      code as a false positive, which is not what Finding 1 protects
 *      against.
 *   3. missive_message_intake_id — the real FOREIGN KEY COLUMN NAME Neo's
 *      migration gives archive_search_validation_sample (a UUID pointer
 *      column on a DIFFERENT, already-safe table, referencing
 *      missive_message_intake(id) — never a query against the base table
 *      itself). Found by literally running this check against the real
 *      router.js and watching it flag validation-sample-export's own
 *      correct, spec-required code — not a hypothetical guarded against in
 *      advance. A query or comment mentioning this column is not a base-
 *      table read; the check would otherwise be unusable without
 *      contorting legitimate code around a naive string match, which
 *      defeats the point of a guardrail people are meant to trust.
 *   4. missive_message_intake_flagged_review_safe — added 2026-09-12,
 *      archive-search-flagged-review-spec.md, Section 7: "the required CI/
 *      test guardrail... needs a small, necessary update... allow-list
 *      missive_message_intake_flagged_review_safe as a legitimate view
 *      name, the same way it already had to account for
 *      missive_message_intake_held_review_safe." A real, screened VIEW
 *      (20260912010000_archive_search_flagged_overrides_schema.sql) —
 *      never the raw base table. Without this, the flagged-review-export
 *      route's own spec-required code would be flagged as a false
 *      positive, exactly like exemption 2 above.
 *   5. missive_message_intake_search_safe_clear_branch — added 2026-09-18,
 *      migration 20260918020000 (see that file's own "THE FIX" and
 *      "WHAT Q'S DRIVER CODE MUST DO" sections). A real, screened,
 *      security_barrier VIEW — never the raw base table — that
 *      significance-pass.js's fetchDriverPage() now queries instead of
 *      missive_message_intake_search_safe, to escape a Postgres query-plan
 *      instability the wider view's escalations anti-join produced under
 *      real, live, repeated pagination. Same class of exemption as 2 and 4
 *      above (a real view name this check's own word-boundary pattern for
 *      plain "_search_safe" doesn't cover, because it's a suffix of that
 *      suffix, not a bare match) — flagged here rather than silently
 *      widened, matching this file's own established convention of citing
 *      the real spec/migration behind each addition. NOT independently
 *      re-confirmed with Asimov/Mason as of this addition — migration
 *      20260918020000's own governance section recommends a quick Asimov
 *      nod on the application-code change that completes its effect
 *      (fetchDriverPage() querying this view plus the escalation-exclusion
 *      code around it, not just the view existing); that nod had not
 *      happened as of this test-suite update. Flagging plainly rather than
 *      assuming: unlike exemptions 2 and 4 above, this one does not yet
 *      have a closing governance-review citation of its own.
 *
 * All five exemptions are still narrow, word-boundary-checked patterns
 * (see ALLOWED_SUFFIX_PATTERNS) — the check still catches the one thing
 * Finding 1 actually cares about: a route or lib file naming the raw base
 * table as a query source.
 *
 * Run standalone: node projects/hub/archive-search/test/
 * no-raw-table-access-check.js
 * Exits non-zero on any real violation. See run-tests.js in this same
 * directory for the proof-of-catch test (a deliberately-introduced
 * violation, written to a real temp file on disk and confirmed caught by
 * this exact module, not just asserted about in isolation).
 */

const fs = require('fs');
const path = require('path');

const ARCHIVE_SEARCH_DIR = path.join(__dirname, '..');
const RAW_TABLE_NAME = 'missive_message_intake';

// The real, screened views, plus the one real FK column name — see header
// comment for the full reasoning on each. Word-boundary-checked (the
// suffix must end there, not just start there) so a coincidentally similar
// longer identifier can't slip through. NOTE: _search_safe_clear_branch
// needs its OWN entry, separate from the plain _search_safe pattern below
// — that shorter pattern's negative lookahead rejects the "_clear_branch"
// continuation (an underscore is not a word boundary), so it does not also
// match the longer name; order among entries doesn't matter (checked via
// Array.prototype.some, which just needs one match), but the longer
// suffix's own explicit pattern does.
const ALLOWED_SUFFIX_PATTERNS = [
  /^_search_safe_clear_branch(?![A-Za-z0-9_])/,
  /^_search_safe(?![A-Za-z0-9_])/,
  /^_held_review_safe(?![A-Za-z0-9_])/,
  /^_flagged_review_safe(?![A-Za-z0-9_])/,
  /^_id(?![A-Za-z0-9_])/,
];

// The one named exception — screening-pass.js must read the base table by
// definition, to screen it.
function isExemptFile(filePath) {
  return path.basename(filePath) === 'screening-pass.js';
}

function listCheckedFiles() {
  const files = [];
  const routerFile = path.join(ARCHIVE_SEARCH_DIR, 'router.js');
  if (fs.existsSync(routerFile)) files.push(routerFile);

  const libDir = path.join(ARCHIVE_SEARCH_DIR, 'lib');
  if (fs.existsSync(libDir)) {
    for (const name of fs.readdirSync(libDir)) {
      if (name.endsWith('.js')) files.push(path.join(libDir, name));
    }
  }
  return files;
}

/**
 * Finds every occurrence of RAW_TABLE_NAME in `text` that is NOT
 * immediately followed by one of ALLOWED_SUFFIXES — i.e. a genuine
 * reference to the raw base table, whether in real code or in a comment
 * (this is a deliberately blunt, literal-string check — Finding 1's own
 * "cheap, catches the mistake... not by a database mechanism" — not an
 * AST-aware one that would treat comments differently from code).
 * @returns {{line: number, column: number, text: string}[]}
 */
function findViolations(text) {
  const violations = [];
  const lines = text.split('\n');
  lines.forEach((line, lineIdx) => {
    let searchFrom = 0;
    for (;;) {
      const at = line.indexOf(RAW_TABLE_NAME, searchFrom);
      if (at === -1) break;
      const after = line.slice(at + RAW_TABLE_NAME.length);
      const isAllowed = ALLOWED_SUFFIX_PATTERNS.some((pattern) => pattern.test(after));
      if (!isAllowed) {
        violations.push({ line: lineIdx + 1, column: at + 1, text: line.trim() });
      }
      searchFrom = at + RAW_TABLE_NAME.length;
    }
  });
  return violations;
}

function checkFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return findViolations(content);
}

/**
 * @returns {{file: string, violations: Array}[]} one entry per checked
 *   (non-exempt) file, violations: [] for a clean file
 */
function runCheck() {
  return listCheckedFiles()
    .filter((f) => !isExemptFile(f))
    .map((file) => ({ file, violations: checkFile(file) }));
}

module.exports = { runCheck, findViolations, listCheckedFiles, isExemptFile, RAW_TABLE_NAME, ALLOWED_SUFFIX_PATTERNS };

if (require.main === module) {
  const results = runCheck();
  let violationCount = 0;

  console.log('\nArchive Search — Raw Table Access Guardrail\n' + '='.repeat(60));
  for (const { file, violations } of results) {
    const rel = path.relative(process.cwd(), file);
    if (violations.length === 0) {
      console.log(`PASS  ${rel}`);
    } else {
      violationCount += violations.length;
      console.log(`FAIL  ${rel}`);
      for (const v of violations) {
        console.log(`      line ${v.line}, col ${v.column}: ${v.text}`);
      }
    }
  }
  console.log('='.repeat(60));

  if (violationCount > 0) {
    console.log(`${violationCount} violation(s) — a file under archive-search/router.js or archive-search/lib/ (other than screening-pass.js) references the raw missive_message_intake table directly.`);
    process.exitCode = 1;
  } else {
    console.log('Clean — no raw missive_message_intake table access found outside screening-pass.js.');
  }
}
