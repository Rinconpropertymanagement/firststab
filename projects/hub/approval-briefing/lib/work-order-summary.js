/**
 * lib/work-order-summary.js
 *
 * Builds the "What the work order is" block for the Work Order Alert email:
 * the job's own title (job.name) and description (job.description), quoted
 * after cleaning and ONLY after passing the local screen in
 * work-order-text-screen.js, plus a category guess from the fixed 10-label
 * list and Latchel's own emergency/urgent flags.
 *
 * NO AI, NOTHING LEAVES THIS SERVER. The screen is a word-list scan. This
 * file and the three it uses (work-order-text-clean.js,
 * work-order-text-screen.js, work-order-text-screen-terms.js) load no model
 * client and open no connection. The one outbound call in the whole feature is
 * the read-only Latchel getJob lookup, which the CALLER injects as `fetchJob`
 * and which runs only when the job in hand has no `description` key at all.
 * The tests prove this three ways (import graph, blocked network, source scan).
 *
 * Everything lives behind one function, prepareWorkOrderSummary(job, opts),
 * which returns { status, lines, meta }:
 *   status 'shown'       lines carry the cleaned title/description.
 *   status 'held'        lines are ONE fixed sentence. It is identical for
 *                        every hit and every error, names no cause or category,
 *                        and contains no byte derived from the job text.
 *   status 'none'        no title and no description at all.
 *   status 'unavailable' the description key was absent and the read-only
 *                        Latchel lookup failed.
 * `meta` is counts-only audit data: a cause, one yes/no, a version string and
 * flags. Never text, a matched word, a length, a hash, a per-word count or a
 * CATEGORY NAME: the screen knows which kind of word matched, but that is a
 * sensitive inference about a household and nothing here keeps it (round 3,
 * Peter's rule: no protected-class data in any table).
 *
 * Pod-unassigned alerts return a different fixed sentence (nothing was read or
 * checked, and the sentence says so). The text is never read, screened or
 * fetched for them.
 *
 * This function never throws. Anything unexpected returns 'held' (fail
 * closed) and logs a constant line.
 *
 * FIELD ALLOWLIST. Only name, description, is_emergency and is_urgent are
 * ever read from the job or from the lookup result (which also carries
 * access_instructions, vendor_description, estimate_note and more). The one
 * addition: the lookup result's job id (job_id, else id) is read ONCE, to
 * confirm it is the job that was asked for; it is never displayed. A test
 * wraps the job in a Proxy and fails on any other key.
 *
 * THE LOOKUP. The job id is checked to be plain digits (at most 12) BEFORE
 * anything is sent, so an id such as a path segment, an encoded dot or a query
 * can never change the address that is called; anything else is "unavailable"
 * and no call is made. The returned job must carry the same id, or it is
 * treated as "unavailable" too.
 *
 * CLEANER HOLDS. The cleaner can also ask for a hold on its own: a Title-case
 * "word.Word" with an everyday-word ending is either a sentence typed with no
 * space after its full stop or a brand-looking address, so the block is held
 * (its own cause, link_shape: no word list was involved, so the counts do not
 * read it as a sensitive-word hold; no category) and the text is not shown as typed. Text
 * that will not settle in the cleaner's passes (deeply nested entities or tags)
 * is held with its own cause, unsettled_text, and one constant log line; it is
 * NOT a scanner error and is reported on its own line.
 *
 * QUOTES. The description sits inside plain double quotes. A straight double
 * quote typed inside the title or description is shown as the double prime
 * (U+2033, which is also the inch mark), so the text can never close the quote
 * early and imitate the footer.
 *
 * WHAT IS CHECKED IS WHAT IS SHOWN, TWICE. The screen first reads the whole
 * cleaned title and description (and the cleaner's spaced reading). Then, for
 * the exact strings that will be printed (after the 100 / 300 character cut),
 * the link detector runs again, and when anything was cut the screen runs
 * again on the cut strings: a cut can end a word as a shorter word or a
 * web-like fragment that the full text did not have. Any hit holds the block.
 *
 * MODE (WORK_ORDER_ALERT_DESCRIPTION_MODE): 'off' | 'shadow' | 'on'.
 * Unset or any other value means 'off', and nothing in this file runs. 'on'
 * takes effect only when WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED is
 * exactly 'yes'; otherwise it behaves as 'shadow' (see descriptionModeInfo).
 *
 * NO DECISIONS FROM THE TEXT (GOVERNANCE.md Rule 9): the text, the hold
 * result and the category label only decide what is DISPLAYED or WITHHELD.
 * Nothing here feeds routing, recipients, the subject, priority, assignment or
 * any other action about a tenant or a unit. The priority line is copied from
 * Latchel's own booleans, never inferred from the text.
 *
 * Governance record: compliance/work-order-note-alerts-description-governance-review.md
 * and compliance/work-order-note-alerts-description-decision-resolution.md.
 * Spec: work-order-notes-alert-SPEC.md Section 6A.
 *
 * NEVER STORE, LOG OR RETURN THE TITLE/DESCRIPTION ANYWHERE BUT `lines`.
 */

'use strict';

const {
  categorize, CATEGORY_ORDER, CATEGORY_LABELS,
} = require('../../maintenance-history/lib/component-categories');
const { cleanTextBoth, containsLink, hasFoldedLink } = require('./work-order-text-clean');
const { screenWorkOrderText, SCREEN_VERSION } = require('./work-order-text-screen');

// ─── THE LIMITS (the knobs) ─────────────────────────────────────────────────
// Everything that sets how long the block can get is in this paragraph and in
// the fixed lines just below it (HEADER, SHOWN_FOOTER, CUT_POINTER). Change a
// number here to shorten or lengthen the block; the tests work out the longest
// possible block from these constants, so they follow the change.
// HONEST NUMBER: with a 100 character title, a 300 character description, the
// two longest category labels, "Emergency / Urgent" and the fixed last line,
// the longest possible block is 733 characters over 6 lines (706 to 733 with two
// category labels, 694 to 710 with one, about 606 with none, whichever labels
// the keywords pick; a typical block is about 330). Peter's "about 600" was a
// soft target and nothing has been cut to meet it. Up to 500 for the
// description may be revisited after the shadow week.
const TITLE_MAX = 100;        // code points (Asimov ruling)
const DESCRIPTION_MAX = 300;  // code points.
const FETCH_TIMEOUT_MS = 10000;
const MAX_CATEGORY_LABELS = 2;
const JOB_ID_PATTERN = /^[0-9]{1,12}$/;   // the only job ids a lookup may be asked for

const HEADER = 'What the work order is:';
const NONE_LINE = `${HEADER} (no title or description came through with this work order, see Latchel)`;
const UNAVAILABLE_LINE = `${HEADER} (could not be retrieved, see Latchel)`;
// One fixed sentence for every hold, whatever the cause (a word-list hit, a
// scanner error, an unexpected error). It points at the Latchel job and ticket
// number the email already prints above it and repeats no id.
const HELD_NOTICE = '  The title and description are not included in this email. Open the Latchel job and ticket number listed above to read them.';
// Pod-unassigned: nothing was read or checked, and the sentence says why.
const UNASSIGNED_NOTICE = '  The title and description are not included because this property has no pod assigned yet. Open the Latchel job and ticket number listed above to read them.';
const NO_DESCRIPTION = '(none was entered in Latchel)';
const CUT_POINTER = ' (shortened; full text is in Latchel)';
// Last line of every shown block, so the email never implies a clearance that
// does not exist: the screen is a word list, it does not look for names,
// phone numbers or access codes.
const SHOWN_FOOTER = '  (Quoted as typed in Latchel. Not checked for names, phone numbers or access codes. Internal use only.)';


// ─── Mode ───────────────────────────────────────────────────────────────────
/**
 * @returns {{mode: 'off'|'shadow'|'on', downgraded: boolean}} 'on' without the
 * ingestion interlock (WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED exactly
 * 'yes') is downgraded to 'shadow'. That variable is set only by Jarvis or
 * Scotty after the Missive-intake exclusion is verified and Peter says yes.
 */
function descriptionModeInfo() {
  const v = process.env.WORK_ORDER_ALERT_DESCRIPTION_MODE;
  if (v === 'shadow') return { mode: 'shadow', downgraded: false };
  if (v === 'on') {
    if (process.env.WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED === 'yes') return { mode: 'on', downgraded: false };
    return { mode: 'shadow', downgraded: true };
  }
  return { mode: 'off', downgraded: false };
}

function descriptionMode() {
  return descriptionModeInfo().mode;
}

// ─── Truncation: code points, last whole word if one falls in the last quarter ───
function truncate(text, limit) {
  const cps = Array.from(text);
  if (cps.length <= limit) return { text, cut: false };
  let head = cps.slice(0, limit);
  const lastSpace = head.lastIndexOf(' ');
  if (lastSpace >= Math.floor(limit * 0.75)) head = head.slice(0, lastSpace);
  return { text: head.join('').replace(/[\s\p{P}]+$/u, '') + ' ...', cut: true };
}

// A straight double quote inside the text would close the quote that wraps the
// description and let the text imitate the footer. It is shown as the double
// prime instead (the inch mark, so 5" pipe stays a 5-inch pipe). Same length.
function quoteSafe(text) {
  return text.replace(/"/g, '\u2033');
}

function categoryLabels(text) {
  const keys = categorize(cap(text, 5000)).filter((k) => k !== 'other');
  const ordered = CATEGORY_ORDER.filter((k) => keys.includes(k)).slice(0, MAX_CATEGORY_LABELS);
  return ordered.length ? ordered.map((k) => CATEGORY_LABELS[k]).join(', ') : null;
}

function cap(str, n) {
  const cps = Array.from(str);
  return cps.length > n ? cps.slice(0, n).join('') : str;
}

function priorityLabel(source) {
  const em = source.is_emergency === true;
  const ur = source.is_urgent === true;
  if (em && ur) return 'Emergency / Urgent';
  if (em) return 'Emergency';
  if (ur) return 'Urgent';
  return null;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function newMeta(podUnassigned) {
  return {
    cause: null,                 // null | 'local_screen' | 'link_shape' | 'pod_unassigned' | 'check_error' | 'unsettled_text' | 'summary_error'
    common_word_only: false,
    screen_version: SCREEN_VERSION,
    truncated: false,
    fallback_getjob_used: false,
    pod_unassigned: !!podUnassigned,
  };
}

// A hold never carries a category line, a priority line or anything else
// derived from the text. The same two lines for every cause.
function heldBlock() { return [HEADER, HELD_NOTICE]; }
function unassignedBlock() { return [HEADER, UNASSIGNED_NOTICE]; }

// Test seam: lets a test make the screen throw or misbehave through the real
// alert code path. null means the real screen.
let screenOverride = null;

/** Calls the screen; a throw, a promise or anything unexpected is "no verdict" (the caller holds). */
function runScreen(screen, input) {
  let verdict = null;
  try { verdict = screen(input); } catch (_err) { verdict = null; }
  if (verdict && typeof verdict.then === 'function') {
    // A screen that answers with a promise is a bug; never leave a rejection unhandled.
    try { verdict.then(() => {}, () => {}); } catch (_err) { /* ignored */ }
    verdict = null;
  }
  const wellFormed = verdict && typeof verdict === 'object'
    && (verdict.status === 'cleared' || verdict.status === 'held');
  return wellFormed ? verdict : null;
}

/** Records a screen verdict in `meta`. Returns true when it is a hold. */
function recordVerdict(verdict, meta) {
  if (!verdict) { meta.cause = 'check_error'; return true; }
  if (typeof verdict.screen_version === 'string') meta.screen_version = verdict.screen_version;
  if (verdict.status === 'cleared') return false;
  // verdict.title and verdict.description do not exist by contract and are not read.
  if (verdict.cause === 'local_screen') {
    meta.cause = 'local_screen';
    // verdict.categories exists by contract and is deliberately NOT read: nothing here may keep a category name.
    meta.common_word_only = verdict.common_word_only === true;
  } else {
    meta.cause = 'check_error';
  }
  return true;
}

/**
 * @param {object} job - the Latchel job already in hand (webhook or list).
 * @param {object} [opts]
 * @param {boolean} [opts.podUnassigned] - pod resolved to unassigned_both:
 *   always the pointer-only form, nothing is read, checked or fetched.
 * @param {string}  [opts.jobId] - for the read-only fallback lookup.
 * @param {(id: string) => Promise<object>} [opts.fetchJob] - read-only
 *   Latchel getJob; called only when job has no `description` key at all.
 * @param {Function} [opts.screen] - test seam; defaults to the real local screen.
 * @param {number} [opts.fetchTimeoutMs] - test seam for the lookup timeout.
 * @returns {Promise<{status: 'shown'|'held'|'none'|'unavailable', lines: string[], meta: object}>}
 */
async function prepareWorkOrderSummary(job, opts = {}) {
  const {
    podUnassigned = false, jobId: rawJobId = null, fetchJob = null,
    screen = screenOverride || screenWorkOrderText,
    fetchTimeoutMs = FETCH_TIMEOUT_MS,
  } = opts;
  const meta = newMeta(podUnassigned);

  try {
    if (podUnassigned) {
      meta.cause = 'pod_unassigned';
      return { status: 'held', lines: unassignedBlock(), meta };
    }

    let source = job && typeof job === 'object' ? job : {};
    if (!Object.prototype.hasOwnProperty.call(source, 'description')) {
      // The job in hand has no description key at all (some list shapes
      // may not carry it). One read-only lookup, nothing else is logged.
      meta.fallback_getjob_used = true;
      const jobId = (typeof rawJobId === 'string' || typeof rawJobId === 'number') ? String(rawJobId) : '';
      let detail = null;
      try {
        // Digits only, checked before anything is sent: no path segment, encoded dot or query can reach the address.
        if (fetchJob && JOB_ID_PATTERN.test(jobId)) detail = await withTimeout(fetchJob(jobId), fetchTimeoutMs);
      } catch (_err) {
        detail = null; // an error message could quote a response body; log only a constant
      }
      if (detail && typeof detail === 'object') {
        // The answer must be the job that was asked for (its id is read only for this check).
        const returnedId = detail.job_id != null ? detail.job_id : detail.id;
        if (returnedId == null || String(returnedId) !== jobId) detail = null;
      }
      if (!detail || typeof detail !== 'object') {
        console.error('[work-order-summary] Could not retrieve the work order from Latchel for the description block.');
        return { status: 'unavailable', lines: [UNAVAILABLE_LINE], meta };
      }
      source = detail;
    }

    // The cleaner throws (constant message) for a value that is not text.
    let title;
    let description;
    let otherReadings = null;
    let ambiguousLink = false;
    try {
      const t = cleanTextBoth(source.name);
      const d = cleanTextBoth(source.description);
      title = t.shown;
      description = d.shown;
      // The same text read the other ways (spaced, symbols, both): see the cleaner.
      otherReadings = {
        spaced: { title: t.spaced, description: d.spaced },
        symbols: { title: t.symbols, description: d.symbols },
        both: { title: t.both, description: d.both },
      };
      ambiguousLink = t.ambiguousLink === true || d.ambiguousLink === true;
    } catch (err) {
      if (err && (err.code === 'clean_did_not_settle' || err.code === 'clean_over_budget')) {
        // The job's own text is what will not settle (nested entities or tags): its own cause, one constant line.
        meta.cause = 'unsettled_text';
        console.error('[work-order-summary] The title or description did not settle in the cleaner - block held (unsettled_text).');
      } else {
        meta.cause = 'check_error';
      }
      return { status: 'held', lines: heldBlock(), meta };
    }
    if (ambiguousLink) {
      // A sentence typed with no space after its full stop reads exactly like a brand-looking address: never shown as typed, so hold.
      // Its own cause, so the counts do not read it as a sensitive-word hold (no word list was involved).
      meta.cause = 'link_shape';
      return { status: 'held', lines: heldBlock(), meta };
    }
    if (!title && !description) {
      return { status: 'none', lines: [NONE_LINE], meta };
    }

    meta.truncated = Array.from(title).length > TITLE_MAX || Array.from(description).length > DESCRIPTION_MAX;

    // 1. The screen reads exactly the strings that would be displayed (and the
    // cleaner's other readings of the same text).
    const first = runScreen(screen, { title, description, ...otherReadings });
    if (recordVerdict(first, meta)) return { status: 'held', lines: heldBlock(), meta };

    // 2. The exact strings that will be printed, after the cut.
    const titleIsJustTheStart = title && description
      && description.toLowerCase().startsWith(title.toLowerCase());
    const shownTitle = title && !titleIsJustTheStart ? truncate(title, TITLE_MAX) : null;
    const shownDescription = description ? truncate(description, DESCRIPTION_MAX) : null;
    const printed = [shownTitle, shownDescription].filter(Boolean).map((x) => x.text);
    if (printed.some((x) => containsLink(x) || hasFoldedLink(x))) {
      // The cut left a web-like fragment (or the cleaner let one through): hold, with no category to name.
      meta.cause = 'link_shape';
      return { status: 'held', lines: heldBlock(), meta };
    }
    if ((shownTitle && shownTitle.cut) || (shownDescription && shownDescription.cut)) {
      const second = runScreen(screen, {
        title: shownTitle ? shownTitle.text : '',
        description: shownDescription ? shownDescription.text : '',
      });
      if (recordVerdict(second, meta)) return { status: 'held', lines: heldBlock(), meta };
    }

    let categoryLabel = null;
    try { categoryLabel = categoryLabels(`${title} ${description}`); } catch (_err) { categoryLabel = null; }

    const lines = [HEADER];
    if (shownTitle) lines.push(`  Title: ${quoteSafe(shownTitle.text)}`);
    if (categoryLabel) lines.push(`  Category (auto-sorted guess): ${categoryLabel}`);
    const priority = priorityLabel(source);
    if (priority) lines.push(`  Priority: ${priority} (flagged in Latchel)`);
    if (shownDescription) {
      lines.push(`  Description: "${quoteSafe(shownDescription.text)}"${shownDescription.cut ? CUT_POINTER : ''}`);
    } else {
      lines.push(`  Description: ${NO_DESCRIPTION}`);
    }
    lines.push(SHOWN_FOOTER);
    return { status: 'shown', lines, meta };
  } catch (_err) {
    console.error('[work-order-summary] Unexpected error building the description block - failing closed (held).');
    meta.cause = 'summary_error';
    meta.common_word_only = false;
    return { status: 'held', lines: heldBlock(), meta };
  }
}

module.exports = {
  prepareWorkOrderSummary,
  descriptionMode,
  descriptionModeInfo,
  SCREEN_VERSION,
  // exported for tests
  truncate,
  HEADER, HELD_NOTICE, UNASSIGNED_NOTICE, NONE_LINE, UNAVAILABLE_LINE, NO_DESCRIPTION,
  CUT_POINTER, SHOWN_FOOTER, TITLE_MAX, DESCRIPTION_MAX, MAX_CATEGORY_LABELS, JOB_ID_PATTERN,
  _setScreenForTesting(fn) { screenOverride = fn || null; },
};
