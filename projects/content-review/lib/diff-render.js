/**
 * lib/diff-render.js
 * Renders a word-level diff between the before/after text of a content_edits
 * row, so the "Edit history" card on the draft detail page can show exactly
 * what changed on a revision instead of just a one-line "body changed" note.
 *
 * Safety: diffWords() runs on the raw, unescaped before/after strings (it
 * needs the real text to diff correctly). Every resulting token is then
 * escaped individually via escapeHtml() before it's wrapped in a <span> —
 * nothing unescaped ever reaches the HTML string.
 *
 * Cost guard: diffWords() is roughly quadratic on heavily-rewritten text
 * (AI revision passes scatter changes throughout instead of making one
 * contiguous edit), and it runs synchronously in the request handler, so a
 * single large/heavily-rewritten revision can block the whole app for every
 * user. Real blog post bodies in this app run a few KB up to ~13KB, so
 * anything past 25KB combined is already well outside normal content and
 * gets a plain before/after render instead (same O(n) pattern already used
 * for section edits below) rather than the word-level diff.
 */

const { diffWords } = require('diff');
const { escapeHtml } = require('./layout');

const DIFF_LENGTH_THRESHOLD = 25000; // combined before+after chars

function renderBodyDiff(beforeText, afterText) {
  const before = beforeText || '';
  const after = afterText || '';

  if (before.length + after.length >= DIFF_LENGTH_THRESHOLD) {
    return `<p class="diff-fallback-note" style="color:#777;font-size:0.85rem;">This revision is large — showing full before/after instead of an inline diff.</p>
      <p><strong>Before:</strong></p>
      <div>${escapeHtml(before)}</div>
      <p><strong>After:</strong></p>
      <div>${escapeHtml(after)}</div>`;
  }

  const parts = diffWords(before, after);
  return parts
    .map((part) => {
      const safe = escapeHtml(part.value);
      if (part.added) return `<span class="diff-added">${safe}</span>`;
      if (part.removed) return `<span class="diff-removed">${safe}</span>`;
      return safe;
    })
    .join('');
}

module.exports = { renderBodyDiff };
