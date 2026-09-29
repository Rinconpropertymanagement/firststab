/**
 * lib/csv.js
 * A small, dependency-free CSV serializer for the two export routes
 * (validation-sample-export, held-review-export — archive-search-
 * technical-spec.md, Finding 5 and Finding 8, both "exported as CSV").
 * No CSV library exists anywhere in this codebase's dependencies today
 * (package.json) — this is intentionally minimal rather than pulling in a
 * new dependency for two small, bounded exports (Finding 5's own 1,000-row
 * sample; Finding 8's held bucket, expected to be small), matching
 * CLAUDE.md's "keep it as simple as possible."
 *
 * RFC 4180-ish quoting: a field containing a comma, a double quote, or a
 * newline is wrapped in double quotes, with any embedded double quote
 * doubled. null/undefined become an empty field. Every other value is
 * stringified with String().
 *
 * Formula-injection guard (TARS/Judge bug fix, 2026-09-10): these two
 * exports carry raw, attacker-controlled email content (subject,
 * from_address, body_text) into a CSV that Peter/the DO/counsel will open
 * in Excel or Sheets. A field starting with =, +, -, or @ can execute as a
 * formula on open. Standard fix: prefix such a field with a leading
 * single-quote before the existing quoting logic, which forces spreadsheet
 * tools to treat it as text.
 */

function escapeCsvField(value) {
  if (value === null || value === undefined) return '';
  let str = String(value);
  if (/^[=+\-@]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * @param {string[]} columns - header row, in order
 * @param {object[]} rows - each row's keys must match `columns`
 * @returns {string} CSV text, CRLF line endings (the common convention for
 *   maximum spreadsheet-tool compatibility), header row first
 */
function toCsv(columns, rows) {
  const lines = [columns.map(escapeCsvField).join(',')];
  for (const row of rows) {
    lines.push(columns.map((col) => escapeCsvField(row[col])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

module.exports = { toCsv, escapeCsvField };
