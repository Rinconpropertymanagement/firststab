/**
 * lib/outcome.js
 * The decisions at the END of an analysis, in one place so the standalone app
 * (server.js) and the Hub (router.js) cannot disagree about them
 * (CMA-QUALITY-SPEC.md Item 4, and Peter's decision of 2026-10-17 on thin reports):
 *
 *   - what to do when the sources came back with no comps at all
 *   - what is saved on the finished analysis (the recommended range, the prices,
 *     the label, the counts), all in the SAME update that marks it complete
 *   - what the screen is sent back (and what it is NOT: the old wide numbers)
 *
 * Nothing here talks to the network or the database.
 */

const { HEADLINE_MIN_COMPS, METHOD_VERSION, OWNER_GOALS, DEFAULT_OWNER_GOAL } = require('./constants');
const { normalizeOwnerGoal, sqftBandFor } = require('./weighting');
const { SQFT_BAND_PROPERTY_TYPES } = require('./constants');
const { FIRM_UP_LINE } = require('./confidence');
const { loadAccuracyScorecard, staffSentences } = require('./accuracy-sentences');
const { TYPE_CHECK_WHAT } = require('./leadsimple');
const { buildOwnerView, NOTES: OWNER_VIEW_NOTES } = require('./owner-view');

// The published accuracy results, read once when the server starts. null when the
// file is missing or damaged; the sentences that depend on it are then left out.
const PUBLISHED_SCORECARD = loadAccuracyScorecard();

// The small labels under the two ends of the range, and the fixed words beside the
// stretch price. No numbers go with any of them.
const LOW_END_LABEL = 'Lease quickly';
const HIGH_END_LABEL = 'Hold out for more';
const STRETCH_WORDS = 'Above the recommended range; may take longer to lease';

// Columns that hold the OLD wide computed range. They are still saved, for the
// audit trail, but they are never sent to the screen (Peter's range rule).
const AUDIT_ONLY_COLUMNS = ['recommended_rent_low', 'recommended_rent_mid', 'recommended_rent_high', 'raw_comp_rent_low', 'raw_comp_rent_high', 'confidence_spread'];

// ─── The "Owner goal" input ──────────────────────────────────────────────────
/**
 * Empty or missing means Balanced. Anything else must be exactly one of the three
 * goal words, or the request is refused.
 * @returns {{value: string}|{error: string}}
 */
function parseOwnerGoalInput(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: DEFAULT_OWNER_GOAL };
  if (typeof raw === 'string' && OWNER_GOALS.includes(raw)) return { value: raw };
  return { error: `owner_goal must be one of: ${OWNER_GOALS.join(', ')} (or left out, which means ${DEFAULT_OWNER_GOAL}).` };
}

// ─── When the sources return nothing ─────────────────────────────────────────
/**
 * Tells "the sources ran fine and there is simply nothing comparable near this
 * address" (a finished report with no range and no prices) apart from "something
 * broke, so we cannot say there are no comps" (a failed analysis).
 *   - some comps came back: carry on as usual
 *   - none came back, at least one source ran, and NO source errored and NO source reported that part of
 *     its search did not come back: finished, "no comps found"
 *   - none came back and any source errored (even if another one succeeded with nothing), or any source
 *     only partly worked (RentCast's listings search failing, one half of CRMLS rejected), or nothing
 *     ran at all: failed. With part of a search missing we cannot say there is nothing nearby.
 * @param {object} args
 * @param {{name: string, what: string, message: string}[]} [args.sourceWarnings] - from runActiveSources()
 * @returns {{kind: 'has_comps'}|{kind: 'none_found'}|{kind: 'failed', reason: string}}
 */
function classifySourceResult({ comps, sourcesUsed, sourceErrors, sourceWarnings }) {
  if (Array.isArray(comps) && comps.length) return { kind: 'has_comps' };
  const errors = Array.isArray(sourceErrors) ? sourceErrors : [];
  const warnings = Array.isArray(sourceWarnings) ? sourceWarnings : [];
  const used = Array.isArray(sourcesUsed) ? sourcesUsed : [];
  if (errors.length === 0 && warnings.length === 0 && used.length > 0) return { kind: 'none_found' };
  const parts = [
    ...errors.map(e => `${e.name}: ${e.error}`),
    ...warnings.map(w => `${w.name}: only partly worked, ${w.what} did not come back (${w.message})`),
  ];
  return { kind: 'failed', reason: parts.length ? parts.join(' | ') : 'No comps were returned by any active source.' };
}

// The screen note when the MLS check of Rincon's own leases (house, condo or townhouse) could not be finished: it failed, timed out,
// or hit its limit (lib/leadsimple.js). Every lease is still counted; the ones not checked keep LeadSimple's type.
const TYPE_CHECK_NOTE = "Rincon's own signed leases could not all be checked against the MLS (house, condo or townhouse) when this report ran, so some are counted under the type LeadSimple gives them, which is sometimes wrong. Run it again to redo that check.";

// How a source is named to the reader (the table name for Rincon's own move-in records means nothing to them).
const SOURCE_DISPLAY_NAMES = { 'LeadSimple Move-Ins': "Rincon's own move-in records" };
const displayNameOf = name => SOURCE_DISPLAY_NAMES[name] || name;

/**
 * The plain notes a finished report shows when a source did not fully come back although other sources
 * did supply comps ("RentCast was unavailable when this report ran, so it uses fewer comparable homes.
 * Run it again to include them."). Shown on the screen only: nothing is saved with them (no column exists
 * for it, and the numbers are the same either way).
 * @param {{sourceErrors?: {name: string}[], sourceWarnings?: {name: string, what: string}[]}} args
 * @returns {string[]}
 */
function buildSourceNotes({ sourceErrors, sourceWarnings } = {}) {
  const notes = [];
  const down = new Set();
  for (const e of Array.isArray(sourceErrors) ? sourceErrors : []) {
    if (!e || !e.name || down.has(e.name)) continue;
    down.add(e.name);
    notes.push(`${displayNameOf(e.name)} was unavailable when this report ran, so it uses fewer comparable homes. Run it again to include them.`);
  }
  const partial = new Map();
  for (const w of Array.isArray(sourceWarnings) ? sourceWarnings : []) {
    if (!w || !w.name || down.has(w.name)) continue;
    if (!partial.has(w.name)) partial.set(w.name, []);
    if (w.what && !partial.get(w.name).includes(w.what)) partial.get(w.name).push(w.what);
  }
  for (const [name, allWhats] of partial) {
    // The MLS check of each Rincon lease's type is not a source that went missing: every comp is still there, some just keep the
    // type LeadSimple gives them. It has its own sentence (and only that sentence), whatever else the same source reports.
    if (allWhats.includes(TYPE_CHECK_WHAT)) notes.push(TYPE_CHECK_NOTE);
    const whats = allWhats.filter(what => what !== TYPE_CHECK_WHAT);
    if (allWhats.length && !whats.length) continue;
    const missing = whats.length ? ` (${whats.join(' and ')} could not be loaded)` : '';
    notes.push(`${displayNameOf(name)} was only partly available when this report ran${missing}, so it may use fewer comparable homes. Run it again to include them.`);
  }
  return notes;
}

// The plain explanation saved with an analysis that found no comparable homes
// (no AI is used for it).
function noCompsRationale(sourcesUsed, sourcesSkipped) {
  const where = Array.isArray(sourcesUsed) && sourcesUsed.length ? ` Sources checked: ${sourcesUsed.join(', ')}.` : '';
  // a source that could not search (no zip code, no location) is not listed as checked; it is said to have been skipped
  const skipped = (Array.isArray(sourcesSkipped) ? sourcesSkipped : []).filter(s => s && s.name);
  const notSearched = skipped.length ? ` Not searched: ${skipped.map(s => `${displayNameOf(s.name)} (${s.reason || 'no details'})`).join(', ')}.` : '';
  return `No comparable homes were found near this address, so there is no recommended range and no suggested price.${where}${notSearched} Check that the address, the number of bedrooms and the property type are right, then run it again if needed.`;
}

// Why there is no range, in words the screen can show as it is.
function noRangeMessage(countedTotal, totalComps) {
  if (!totalComps) return 'No comparable homes were found near this address, so there is no recommended range and no suggested price.';
  if (!countedTotal) {
    return totalComps === 1
      ? 'The 1 home found could not be counted as comparable (see the home reviewed but not used below), so there is no recommended range and no suggested price.'
      : `None of the ${totalComps} homes found could be counted as comparable (see the homes reviewed but not used below), so there is no recommended range and no suggested price.`;
  }
  return `Only ${countedTotal} comparable ${countedTotal === 1 ? 'home' : 'homes'} found (at least ${HEADLINE_MIN_COMPS} are needed), so there is no recommended range and no suggested price.`;
}

// ─── What is saved when the analysis finishes ────────────────────────────────
/**
 * The ONE update that marks an analysis complete. Everything about the outcome goes
 * in it together, because the database checks the pieces against each other:
 *   - 4 or more counted comps: the recommended range (exactly $200 wide), the
 *     suggested price, the stretch price (not saved on a Low report, since it is
 *     not shown there), the label, and the old computed range (audit only; the
 *     database requires all three recommended_rent_* then)
 *   - fewer than 4: counted_comp_count is saved, and every price field is NULL
 *     (the database allows a finished report with no numbers ONLY in this case)
 * @param {object} args
 * @param {object} args.numbers - the result of computeNumbers()
 */
function buildCompletionPatch({ numbers, ownerGoal, propertyId, subjectEstimatedRent, subjectLatitude, subjectLongitude, subjectZip, rationale }) {
  const { headline, confidence, counted, recommended, raw } = numbers;
  const haveRange = !!headline;
  return {
    status: 'complete',
    property_id: propertyId,
    recommended_rent_low: haveRange ? recommended.low : null,
    recommended_rent_mid: haveRange ? recommended.mid : null,
    recommended_rent_high: haveRange ? recommended.high : null,
    subject_estimated_rent: subjectEstimatedRent,
    subject_latitude: subjectLatitude,
    subject_longitude: subjectLongitude,
    subject_zip: subjectZip,
    raw_comp_rent_low: haveRange ? raw.low : null,
    raw_comp_rent_high: haveRange ? raw.high : null,
    rationale,
    headline_range_low: haveRange ? headline.low : null,
    headline_range_high: haveRange ? headline.high : null,
    suggested_list_price: haveRange ? headline.listPrice : null,
    stretch_price: haveRange && confidence && confidence.label !== 'low' ? headline.stretchPrice : null,
    // the goal the suggested price was actually worked out with (it cannot disagree with the price)
    owner_goal: haveRange ? headline.goal : normalizeOwnerGoal(ownerGoal),
    confidence_label: haveRange && confidence ? confidence.label : null,
    confidence_spread: haveRange ? headline.spread : null,
    counted_comp_count: counted.total,
    counted_leased_count: counted.leased,
    method_version: METHOD_VERSION,
  };
}

// ─── What the screen is sent ─────────────────────────────────────────────────
// The saved analysis row without the audit-only columns (the old wide range and
// the internal agreement figure).
function stripAuditColumns(row) {
  const out = { ...(row || {}) };
  for (const key of AUDIT_ONLY_COLUMNS) delete out[key];
  return out;
}

/**
 * The recommended range as a reader is allowed to see it: the stretch price is
 * left out of a Low-confidence report (it is shown on Medium and High only). Used
 * for the screen AND for what the written explanation is told, so the two always
 * agree. null when there is no range.
 */
function headlineForDisplay(numbers) {
  const { headline, confidence } = numbers;
  if (!headline) return null;
  const label = confidence ? confidence.label : null;
  return {
    low: headline.low,
    high: headline.high,
    lowLabel: LOW_END_LABEL,
    highLabel: HIGH_END_LABEL,
    listPrice: headline.listPrice,
    goal: headline.goal,
    goalSentence: headline.goalSentence,
    stretchPrice: label === 'low' ? null : headline.stretchPrice,
    stretchWords: label === 'low' ? null : STRETCH_WORDS,
  };
}

/**
 * The plain line about the square-footage band for the screen: the band when the
 * size rule was used, otherwise why it was not (home size missing, or a property
 * type the rule does not cover).
 * @returns {{band: {pct: number, low: number, high: number}|null, text: string}}
 */
function sizeBandNote(analysis) {
  const type = analysis && analysis.subject_property_type;
  const sqft = analysis && analysis.subject_sqft;
  const band = sqftBandFor(type, sqft);
  const fmt = n => Number(n).toLocaleString('en-US');
  if (band) return { band, text: `Size band: ${fmt(band.low)}-${fmt(band.high)} sq ft (within ${band.pct}% of your home)` };
  if (SQFT_BAND_PROPERTY_TYPES.includes(type)) return { band: null, text: 'Home size not entered, so the size rule was not used.' };
  return { band: null, text: 'The size rule is not used for this property type.' };
}

/**
 * The JSON the "run analysis" request answers with. It has NO recommended_rent_*,
 * raw_comp_rent_* or confidence_spread (see AUDIT_ONLY_COLUMNS): the screen gets
 * the recommended range, the prices and the label instead.
 * @param {object} args
 * @param {object} args.analysis - the updated analysis row
 * @param {object[]} args.comps - the saved comps, each with exclusion_reason
 * @param {object|null} args.marketData
 * @param {object} args.numbers - the result of computeNumbers()
 * @param {object|null} [args.scorecard] - override for tests; defaults to the published results
 * @param {string[]} [args.sourceNotes] - from buildSourceNotes(): which source did not fully come back
 * @param {number|null} [args.ownerMidpoint] - the internal middle of the counted comps, used only to leave odd-priced
 *   homes off the owner view. Left out for a live run (it is taken from numbers.recommended); a reopened report passes
 *   the one saved with it.
 */
function buildApiResponse({ analysis, comps, marketData, numbers, scorecard = PUBLISHED_SCORECARD, sourceNotes = [], ownerMidpoint }) {
  const { headline, confidence, counted } = numbers;
  const label = confidence ? confidence.label : null;
  const countedComps = (comps || []).filter(c => !c.exclusion_reason);
  const sentences = staffSentences(scorecard, label);
  // The one-page owner view (lib/owner-view.js): built here, for a live run and a reopened report alike, so both
  // entry points and the past-reports page get the same thing. null (with a plain note) when it cannot be offered.
  // A fault in building it must never cost staff the report that is already saved, so it is caught here.
  let owner;
  try {
    owner = buildOwnerView({
      analysis,
      comps,
      headline,
      confidenceLabel: label,
      midpoint: ownerMidpoint !== undefined ? ownerMidpoint : (numbers.recommended ? numbers.recommended.mid : null),
      countedTotal: counted.total,
    });
  } catch (err) {
    console.error(`[rental-analysis] The owner view could not be built: ${err.message}`);
    owner = { ownerView: null, ownerViewNote: OWNER_VIEW_NOTES.error };
  }
  return {
    analysis: stripAuditColumns(analysis),
    comps,
    marketData,
    headline: headlineForDisplay(numbers),
    confidence: confidence ? {
      label,
      reasons: confidence.reasons,
      reasonText: confidence.reasonText,
      startingPoint: label === 'low',
      trackRecord: sentences.trackRecord,
      firmUp: label === 'high' ? null : FIRM_UP_LINE,
    } : null,
    counted: {
      total: counted.total,
      leased: counted.leased,
      active: countedComps.filter(c => c.listing_status === 'active').length,
      offMarket: countedComps.filter(c => c.listing_status === 'off_market').length,
    },
    noRange: headline ? null : noRangeMessage(counted.total, (comps || []).length),
    sizeBand: sizeBandNote(analysis).band,
    sizeNote: sizeBandNote(analysis).text,
    accuracyLine: sentences.accuracyLine,
    // plain notes about a source that did not fully come back (screen only, nothing saved)
    sourceNotes: Array.isArray(sourceNotes) ? sourceNotes : [],
    // the one-page owner view, ready to format (nothing staff-only in it), or null with the reason in ownerViewNote
    ownerView: owner.ownerView,
    ownerViewNote: owner.ownerViewNote,
  };
}

module.exports = {
  LOW_END_LABEL,
  HIGH_END_LABEL,
  STRETCH_WORDS,
  AUDIT_ONLY_COLUMNS,
  PUBLISHED_SCORECARD,
  parseOwnerGoalInput,
  classifySourceResult,
  buildSourceNotes,
  noCompsRationale,
  noRangeMessage,
  buildCompletionPatch,
  headlineForDisplay,
  sizeBandNote,
  stripAuditColumns,
  buildApiResponse,
};
