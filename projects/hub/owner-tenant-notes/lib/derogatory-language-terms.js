/**
 * lib/derogatory-language-terms.js
 * The soft, non-blocking "characterization vs. fact" warning required by
 * owner-tenant-operational-notes-SPEC.md Section 7's "Derogatory/subjective
 * character judgments" row and Section 4's "Deliberately not built"
 * red-line section (no risk_score/personality column of any kind —
 * this module never produces one; it only ever produces an ephemeral,
 * response-only warning string, never written to any database column).
 *
 * DISTINCT from lib/protected-class-terms.js (Layer 1 of the two-layer
 * content check, gating protected-class content into human review). This
 * list has nothing to do with protected characteristics — it flags plain
 * evaluative/subjective language ("difficult," "problem tenant") that
 * counsel's own fact-vs-characterization standard (spec Section 1: "Is
 * this OBJECTIVELY STATED information...") calls out as the thing to
 * watch for. A note can trip this list and NOT protected-class-terms.js
 * at all, or vice versa, or both (Section 7's own last row: a protected
 * activity converted into a negative attribute usually catches on both).
 *
 * DELIBERATELY A SOFT WARNING, NEVER A BLOCK (spec Section 7): "a word
 * like 'difficult' appears in plenty of legitimate facts ('difficult
 * access due to a locked gate'), and a hard block on common English words
 * would be false-positive-heavy in a way this codebase has already been
 * burned by once." Nothing in owner-tenant-notes/router.js ever rejects a
 * note submission because of this scan — see checkDerogatoryLanguage's own
 * call site.
 *
 * FIRST PASS, NOT A FINISHED COMPLIANCE ARTIFACT. Q's own judgment call,
 * flagged explicitly in the build report per the task brief (scope item
 * 8) — Mason should refine this list, the same way Mason owns
 * protected-class-terms.js's category boundaries and flagged_category
 * vocabulary elsewhere in this codebase. Treat every term here as a
 * starting point, not a final word list.
 */

const DEROGATORY_LANGUAGE_VERSION = 'derogatory-language-terms-v2';

// Grouped for readability/future Mason review, not because the grouping
// itself is meaningful anywhere in code (unlike protected-class-terms.js's
// CATEGORIES, which feed flagged_category). Matching is whole-word/phrase,
// case-insensitive — same escapeRegex + \b-boundary approach as
// protected-class-terms.js, reused here rather than reinvented, so a short
// term like "problem" doesn't false-positive inside an unrelated word.
const TERMS = [
  // Generalized character judgments about a person, not a specific fact —
  // several of these are counsel's own enumerated examples (opinion
  // Section 6: "Crazy." "Bad tenant." "Problem tenant." "Lazy."
  // "Entitled." "High maintenance.")
  'difficult tenant', 'difficult owner', 'problem tenant', 'problem owner',
  'high maintenance', 'high-maintenance', 'nightmare tenant', 'nightmare owner',
  'bad tenant', 'bad owner', 'troublemaker', 'trouble maker',
  'unstable tenant', 'unstable owner',

  // Standalone evaluative adjectives — broad on purpose (Layer-1-style,
  // recall-oriented) but soft-warning-only, so the false-positive cost is
  // low (a rephrase prompt, not a suppression) per this file's own header.
  // NOTE (Mason review, 2026-09-05): bare 'unstable' and 'demanding' were
  // deliberately removed from this list — both trigger constantly on
  // ordinary, legitimate property-fact usage that has nothing to do with
  // characterizing a person ("the deck railing is unstable," "owner is
  // demanding proof of insurance before releasing payment"). That's the
  // annoying, in-the-way false positive this tool should avoid. The
  // 'unstable tenant'/'unstable owner' phrases above still catch the
  // actual characterization case.
  'difficult', 'unreasonable', 'dramatic', 'hostile', 'aggressive', 'rude',
  'entitled', 'lazy', 'crazy', 'paranoid', 'manipulative',
  'liar', 'lying', 'dishonest', 'uncooperative', 'confrontational',
  'combative', 'volatile', 'disruptive', 'condescending', 'obnoxious',
  'hysterical', 'irrational', 'needy', 'clingy', 'high strung',
  'high-strung', 'ungrateful', 'abrasive', 'unpleasant',
  'annoying', 'nasty', 'vindictive', 'petty',

  // Complaint-framed-as-negative-attribute phrasing — Section 7's own
  // "protected activity converted into a negative attribute" example.
  'always complaining', 'constantly complaining', 'chronic complainer',
  'serial complainer', 'chip on their shoulder',

  // Counsel's own worked fact-vs-characterization pairs (Mason review,
  // 2026-09-05) — opinion Section 3 (factual "Tenant disputes the
  // plumbing charge" vs. evaluative "Tenant refuses to take
  // responsibility") and opinion Section 2 (discouraged "Tenant always
  // disputes charges" vs. permitted "Tenant disputes responsibility for
  // invoice #1234. Manager approval required before charge is posted.").
  // Added as narrow phrases, not bare 'always'/'refuses' — those words
  // alone appear in huge numbers of ordinary factual sentences and would
  // false-positive far more than they'd help.
  'refuses to take responsibility', 'always disputes', 'constantly disputes',
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const FLAT_TERMS = TERMS.map((term) => ({
  term,
  regex: new RegExp(`\\b${escapeRegex(term.trim())}\\b`, 'i'),
}));

/**
 * Scans note_text for evaluative/subjective "characterization" language.
 * Returns { flagged, matchedTerms }. NEVER call this to decide whether a
 * note may be saved — it exists purely to produce a soft, response-only
 * warning string for the author (see owner-tenant-notes/router.js's
 * DEROGATORY_LANGUAGE_WARNING and its POST /api/owner-tenant-notes call
 * site). matchedTerms is for that warning message only — it is never
 * written to audit_log or any database column (same "don't log the
 * substance, only the fact of a hit" discipline protected-class-terms.js
 * documents for its own matchedTerms).
 */
function scanDerogatoryLanguage(text) {
  const normalized = String(text || '');
  const matchedTerms = [];
  for (const { term, regex } of FLAT_TERMS) {
    if (regex.test(normalized)) matchedTerms.push(term);
  }
  return { flagged: matchedTerms.length > 0, matchedTerms };
}

module.exports = { scanDerogatoryLanguage, DEROGATORY_LANGUAGE_VERSION };
