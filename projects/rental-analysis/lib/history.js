/**
 * lib/history.js
 * "Past reports": the plain rules for listing the reports that were run before
 * and for opening one of them again. Used ONLY by the Hub (hub/rental-analysis/
 * router.js, behind the Hub login). A copy of this file sits in both lib folders
 * because the two folders are kept identical, but the standalone app (server.js)
 * has no login and does NOT use it and has no "past reports" page address.
 *
 * Nothing here talks to the network or the database. The router reads the saved
 * rows and hands them in; this file shapes them. It never calls RentCast, Recore
 * or the AI writer, and it never saves anything: a past report is read-only.
 *
 * Two kinds of saved report exist:
 *   - "new" format: saved by the current method. Its range, suggested price,
 *     stretch price, goal, label and counts were SAVED with it (the headline
 *     columns, the counted-comps columns and method_version). Those saved
 *     columns are the truth. They are never worked out again here.
 *   - "older" format: saved before that method. It has only the old wide computed
 *     range (low / middle / high), an old-style written explanation and old-style
 *     notes on each home. The old range is shown ONLY inside a grey box on the opened
 *     report, marked as the previous method's result (the list shows just an
 *     "Older report" tag, no dollar figures). The old explanation and the old notes
 *     on each home are NOT shown at all (they talk about a "recommended range" that
 *     was often $500 or more wide); they stay in the database. No new range is worked
 *     out for it, and it has no stretch price.
 *
 * Peter's rule still holds for everything the current method produces: a
 * recommended range is exactly $200 wide, and no range of $500 or more is ever
 * shown as a recommendation. A saved "new" range that is not $200 wide would be
 * left out here too (the database refuses to save one, this is a second lock).
 *
 * Some extras on a rebuilt report are worked out again from the saved homes
 * (the plain reasons behind the confidence label, how many counted homes are
 * active or off market, which homes were not counted and why). They are checked
 * against what was saved. If they ever disagree, the saved value wins and a note
 * is added so nobody trusts the extras blindly.
 */

const { HEADLINE_RANGE_WIDTH, NEAR_RANGE_DOLLARS, CONFIDENCE_LABELS } = require('./constants');
const { exclusionReason, subjectExtrasFrom, goalSentenceFor, normalizeOwnerGoal, sizeBandPctFor } = require('./weighting');
const { computeConfidence } = require('./confidence');
const { buildApiResponse } = require('./outcome');
const { rentLooksImplausible } = require('./leadsimple');

// ─── Paging and search limits ────────────────────────────────────────────────
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100; // the most reports one request may ask for, however large a number is typed
const MAX_OFFSET = 100000;
const MAX_SEARCH_LENGTH = 200; // typed characters looked at
const MAX_SEARCH_WORDS = 6;
const MAX_SEARCH_WORD_LENGTH = 40;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = value => typeof value === 'string' && UUID_RE.test(value);

// ─── Exactly which saved columns are read (nothing else is ever asked for) ────
// The list: enough to draw one line. No notes, no emails, no phone numbers.
const LIST_COLUMNS = [
  'id', 'created_at', 'subject_address', 'subject_bedrooms', 'subject_bathrooms', 'subject_sqft', 'subject_property_type',
  'status', 'run_by', 'method_version', 'counted_comp_count',
  'headline_range_low', 'headline_range_high', 'suggested_list_price', 'confidence_label',
].join(',');

// One whole report. run_by is read only to look up the person's NAME and is not sent on.
const REPORT_COLUMNS = [
  'id', 'created_at', 'updated_at', 'subject_address', 'subject_bedrooms', 'subject_bathrooms', 'subject_sqft',
  'subject_property_type', 'subject_year_built', 'lease_term_months', 'furnished', 'run_by', 'status', 'rationale',
  'subject_estimated_rent', 'subject_latitude', 'subject_longitude', 'subject_zip', 'subject_age_restricted',
  'subject_subdivision', 'size_band_pct', 'owner_goal', 'headline_range_low', 'headline_range_high',
  'suggested_list_price', 'stretch_price', 'confidence_label', 'confidence_spread', 'counted_comp_count',
  'counted_leased_count', 'method_version', 'recommended_rent_low', 'recommended_rent_mid', 'recommended_rent_high',
].join(',');

const COMP_COLUMNS = [
  'id', 'source_id', 'address', 'property_type', 'bedrooms', 'bathrooms', 'sqft', 'distance_miles', 'monthly_rent',
  'is_estimated_price', 'original_price', 'had_price_cut', 'listing_status', 'days_on_market', 'listed_date',
  'leased_date', 'is_rincon_managed', 'narrative', 'latitude', 'longitude', 'mls_listing_id', 'year_built',
  'subdivision_name', 'furnished_status', 'lease_term_class', 'age_restricted', 'mls_condition', 'mls_flags',
  'condition_rating', 'condition_basis', 'condition_tags',
].join(',');

// ─── What was asked for: the list's web address options ─────────────────────
/**
 * Splits typed search text into safe words. Only letters, digits, spaces and a few
 * address marks (. ' # / & -) are kept; everything else (the wildcard marks * % _,
 * backslashes, commas, brackets, quotes) is turned into a space, so typed text can
 * never act as a database pattern or filter. At most 6 words of 40 characters each.
 * A full address pasted with commas still works because every word has to match.
 * @returns {string[]}
 */
function searchWords(raw) {
  if (typeof raw !== 'string') return [];
  const cleaned = raw.slice(0, MAX_SEARCH_LENGTH).normalize('NFKC')
    .replace(/[^\p{L}\p{N} .'#/&-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  return cleaned.split(' ').filter(Boolean).slice(0, MAX_SEARCH_WORDS).map(w => w.slice(0, MAX_SEARCH_WORD_LENGTH));
}

/**
 * Reads ?limit=&offset=&q=&show_failed= from the web address.
 * limit: 1 or more, default 50, anything above 100 is brought down to 100.
 * offset: 0 or more. q: address text (see searchWords). show_failed: "1" or "true".
 * @returns {{limit: number, offset: number, words: string[], showFailed: boolean}|{error: string}}
 */
function parseHistoryQuery(query) {
  const q = query && typeof query === 'object' ? query : {};
  for (const key of ['limit', 'offset', 'q', 'show_failed']) {
    if (q[key] !== undefined && typeof q[key] !== 'string') return { error: `${key} must be given once, as plain text.` };
  }
  let limit = DEFAULT_LIMIT;
  if (q.limit !== undefined && q.limit !== '') {
    if (!/^\d{1,6}$/.test(q.limit) || Number(q.limit) < 1) return { error: 'limit must be a whole number of 1 or more.' };
    limit = Math.min(Number(q.limit), MAX_LIMIT);
  }
  let offset = 0;
  if (q.offset !== undefined && q.offset !== '') {
    if (!/^\d{1,7}$/.test(q.offset) || Number(q.offset) > MAX_OFFSET) return { error: `offset must be a whole number from 0 to ${MAX_OFFSET}.` };
    offset = Number(q.offset);
  }
  return { limit, offset, words: searchWords(q.q), showFailed: q.show_failed === '1' || q.show_failed === 'true' };
}

/**
 * The database request for one page of the list: newest first, one extra row asked
 * for so the caller can tell whether there is another page. Finished reports only,
 * unless failed (and unfinished) ones were asked for. Every search word is URL-encoded
 * and must appear in the address (any capitals).
 */
function buildListQuery({ limit, offset, words, showFailed }) {
  const parts = [`select=${LIST_COLUMNS}`, 'order=created_at.desc,id.desc', `limit=${limit + 1}`, `offset=${offset}`];
  if (!showFailed) parts.push('status=eq.complete');
  for (const word of words || []) parts.push(`subject_address=ilike.*${encodeURIComponent(word)}*`);
  return parts.join('&');
}

// ─── Which kind of report is this? ───────────────────────────────────────────
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * 'new'        saved by the current method (any of its saved columns is set)
 * 'older'      finished, but saved before that method (only the old wide range)
 * 'unfinished' failed, or never finished, with nothing from either method
 */
function reportFormat(row) {
  const r = row || {};
  const hasNewColumns = (r.method_version !== null && r.method_version !== undefined)
    || (r.headline_range_low !== null && r.headline_range_low !== undefined)
    || (r.counted_comp_count !== null && r.counted_comp_count !== undefined);
  if (hasNewColumns) return 'new';
  return r.status === 'complete' ? 'older' : 'unfinished';
}

// The junk-rent mark on one of Rincon's own leases (lib/leadsimple.js) is worked out while a report runs and is NOT saved, so a
// reopened report has to work it out again from the saved rent and size, or a lease the report left out as a data error would
// show as counted and the recount would no longer match the saved counts. Only reports saved by a method that applies the screen
// (METHOD_VERSION cma-2026-10-v2 and later) get it: a report saved as cma-2026-10-v1 was counted without the screen, and rebuilding
// it WITH the screen would break its counts. An older-format or unfinished report never gets it.
const METHOD_BEFORE_RENT_SCREEN = 'cma-2026-10-v1';
const RINCON_SOURCE_NAME = 'LeadSimple Move-Ins';
function savedWithRentScreen(row, format) {
  return format === 'new' && typeof row.method_version === 'string' && row.method_version !== '' && row.method_version !== METHOD_BEFORE_RENT_SCREEN;
}

// A saved recommended range that may be shown: all three prices saved, exactly $200 wide, the price inside it.
function savedHeadlineNumbers(row) {
  const low = num(row.headline_range_low), high = num(row.headline_range_high), listPrice = num(row.suggested_list_price);
  if (low === null && high === null && listPrice === null) return { ok: false, problem: false };
  if (low === null || high === null || listPrice === null) return { ok: false, problem: true };
  if (high - low !== HEADLINE_RANGE_WIDTH || listPrice < low || listPrice > high) return { ok: false, problem: true };
  return { ok: true, low, high, listPrice };
}

// ─── One line of the list ────────────────────────────────────────────────────
/**
 * @param {object} row - one saved analysis, only the LIST_COLUMNS
 * @param {string|null} runByName - the person's name (the only thing ever shown about them)
 */
function shapeListRow(row, runByName) {
  const format = reportFormat(row);
  const out = {
    id: row.id,
    created_at: row.created_at,
    subject_address: row.subject_address,
    subject_bedrooms: row.subject_bedrooms,
    subject_bathrooms: row.subject_bathrooms,
    subject_sqft: row.subject_sqft,
    subject_property_type: row.subject_property_type,
    status: row.status,
    run_by_name: typeof runByName === 'string' && runByName ? runByName : null,
    format,
    headline: null,
    suggested_list_price: null,
    confidence_label: null,
  };
  if (format === 'new') {
    const saved = savedHeadlineNumbers(row);
    if (saved.ok) {
      out.headline = { low: saved.low, high: saved.high };
      out.suggested_list_price = saved.listPrice;
      out.confidence_label = CONFIDENCE_LABELS.includes(row.confidence_label) ? row.confidence_label : null;
    }
  }
  // An older report carries no figures in the list at all: the screen shows only an "Older report" tag. Its old wide
  // range is seen only inside the grey box when the report is opened.
  return out;
}

// ─── One whole report, rebuilt from what was saved ───────────────────────────
const OLDER_NO_RANGE = 'This report was run with the previous method, which did not produce a recommended range.';
const UNFINISHED_NO_RANGE = {
  failed: 'This report did not finish, so it has no recommended range and no suggested price.',
  other: 'This report had not finished when it was last saved, so it has no recommended range and no suggested price.',
};
const RANGE_NOT_SHOWN = 'The recommended range saved with this report could not be shown, so this report has no recommended range and no suggested price.';
const NOT_MATCHING_NOTE = 'Some details on this saved report were worked out again from its saved homes and did not fully match what was saved. The saved figures are the ones shown.';
const NO_MARKET_NOTE = 'Area market figures were not saved with this report, so that section is left out.';
const MARKET_FAILED_NOTE = 'Area market figures could not be loaded just now, so that section is left out.';
const ORDER_NOTE = 'Comparable homes are listed nearest first; the order may differ from the original run.';

function marketNote(marketData) {
  const when = marketData && marketData.fetched_at ? new Date(marketData.fetched_at) : null;
  const date = when && !Number.isNaN(when.getTime()) ? when.toISOString().slice(0, 10) : null;
  return `Area market figures are the latest saved for this zip code${date ? ` (updated ${date})` : ''}, not necessarily the figures from the day this report was run.`;
}

// Nearest first, then the higher rent, then address: a fixed order, because the order the homes came back in on the
// day is not saved.
function compareComps(a, b) {
  const da = num(a.distance_miles), db = num(b.distance_miles);
  if (da !== db) {
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  }
  const ra = num(a.monthly_rent) || 0, rb = num(b.monthly_rent) || 0;
  if (ra !== rb) return rb - ra;
  const byAddress = String(a.address || '').localeCompare(String(b.address || ''));
  return byAddress || String(a.id || '').localeCompare(String(b.id || ''));
}

/**
 * Builds the same answer the "run analysis" request gives, from the saved rows.
 * @param {object} args
 * @param {object} args.analysis - the saved analysis row (REPORT_COLUMNS)
 * @param {object[]} args.comps - its saved comp rows (COMP_COLUMNS)
 * @param {Object<string,string>} [args.sourceNamesById] - rental_comp_sources id -> name (decides who counts as Rincon-managed)
 * @param {string|null} [args.runByName]
 * @param {object|null} [args.marketData] - the saved area figures for the zip, or null when none are saved
 * @param {boolean} [args.marketLookupFailed] - true when reading the saved area figures FAILED (a different note than "not saved")
 * @param {object|null} [args.scorecard] - for tests only. Normally left out, which means the CURRENT published
 *   accuracy scorecard (lib/accuracy-scorecard.json, read when the server starts), not the one that existed on the
 *   day the report was run. The accuracy sentences are about the tool as it stands today.
 * @returns {{report: object, flags: string[]}} flags is a list of short codes for anything that did not match
 *   (empty when everything agrees); the same fact is also on the screen as a plain note
 */
function rebuildReport({ analysis, comps, sourceNamesById = {}, runByName = null, marketData = null, marketLookupFailed = false, scorecard } = {}) {
  const row = { ...analysis };
  const format = reportFormat(row);
  const flags = [];
  const notes = [];
  delete row.run_by; // only ever used to look the name up

  // The homes that were not counted, and why: the one shared verdict (lib/weighting.js), applied to the saved homes.
  // For a new report the subject's extra facts (size, furnished, lease length, 55+) were saved with it and are used the
  // same way as on the day. An older report ran before those rules existed, so only the original three reasons apply.
  const extras = format === 'new'
    ? subjectExtrasFrom({ sqft: row.subject_sqft, furnished: row.furnished, leaseTermMonths: row.lease_term_months, ageRestricted: row.subject_age_restricted })
    : undefined;
  const withRentScreen = savedWithRentScreen(row, format);
  const outComps = (Array.isArray(comps) ? comps : []).map(saved => {
    const sourceName = sourceNamesById[saved.source_id];
    // the junk-rent mark, put back (see savedWithRentScreen above); a comp that is not marked is left exactly as saved
    const c = withRentScreen && sourceName === RINCON_SOURCE_NAME && rentLooksImplausible(Number(saved.monthly_rent), typeof saved.sqft === 'number' ? saved.sqft : null)
      ? { ...saved, implausible_rent: true }
      : saved;
    return { ...c, exclusion_reason: exclusionReason({ ...c, source_name: sourceName }, row.subject_bedrooms, row.subject_property_type, extras) };
  }).sort(compareComps);
  const countedComps = outComps.filter(c => !c.exclusion_reason);
  const recounted = { total: countedComps.length, leased: countedComps.filter(c => c.listing_status === 'leased').length };

  let numbers;
  if (format === 'new') {
    const saved = savedHeadlineNumbers(row);
    if (saved.problem) flags.push('range_not_valid');

    // The saved counts are the truth. The recount from the saved homes must agree.
    const total = Number.isInteger(row.counted_comp_count) ? row.counted_comp_count : recounted.total;
    const leased = Number.isInteger(row.counted_leased_count) ? row.counted_leased_count : recounted.leased;
    if (!Number.isInteger(row.counted_comp_count) || !Number.isInteger(row.counted_leased_count) || total !== recounted.total || leased !== recounted.leased) flags.push('counts');
    // the size-band percent saved with the report must be the one the size rule gives
    if (sizeBandPctFor(row.subject_property_type, row.subject_sqft) !== (row.size_band_pct === undefined ? null : row.size_band_pct)) flags.push('size_band');

    let headline = null;
    let confidence = null;
    if (saved.ok) {
      const goal = normalizeOwnerGoal(row.owner_goal);
      if (goal !== row.owner_goal) flags.push('goal');
      const label = CONFIDENCE_LABELS.includes(row.confidence_label) ? row.confidence_label : null;
      if (!label) flags.push('label_missing');
      headline = {
        low: saved.low,
        high: saved.high,
        listPrice: saved.listPrice,
        goal,
        goalSentence: goalSentenceFor(goal, saved.listPrice),
        // not saved on a Low report (headlineForDisplay() also hides it there); and with no valid label it is not shown either,
        // because the stretch price is for Medium and High reports only
        stretchPrice: label ? num(row.stretch_price) : null,
      };
      // the plain reasons: worked out from the saved counts, the saved agreement figure and the homes priced near the range
      const compsNear = countedComps.filter(c => {
        const rent = num(c.monthly_rent);
        return rent !== null && rent >= saved.low - NEAR_RANGE_DOLLARS && rent <= saved.high + NEAR_RANGE_DOLLARS;
      }).length;
      const spread = num(row.confidence_spread);
      const worked = computeConfidence({ countedTotal: total, leasedCounted: leased, spread: spread === null ? 0 : spread, compsNear });
      if (label) {
        const agrees = spread !== null && worked.label === label;
        if (spread === null || worked.label !== label) flags.push('label');
        // when the reasons would describe a different label than the saved one, only the plain count sentence is kept
        const reasons = agrees ? worked.reasons : [worked.reasons[0]];
        confidence = { label, reasons, reasonText: `${reasons.join('; ')}.` };
      }
    }
    numbers = { headline, confidence, counted: { total, leased } };
  } else {
    numbers = { headline: null, confidence: null, counted: recounted };
  }

  if (flags.length) notes.push(NOT_MATCHING_NOTE);
  if (outComps.length > 1) notes.push(ORDER_NOTE);
  notes.push(marketData ? marketNote(marketData) : (marketLookupFailed ? MARKET_FAILED_NOTE : NO_MARKET_NOTE));

  const cleanAnalysis = { ...row };
  // the stretch price is shown on Medium and High reports only: never on a Low one, one with no valid label, or an older or unfinished one
  if (format !== 'new' || !numbers.confidence || numbers.confidence.label === 'low') cleanAnalysis.stretch_price = null;
  // Anything the previous method WROTE is not shown: its explanation and its notes on each home speak of a "recommended
  // range" that was often $500 or more wide. It all stays saved in the database; it is just not sent. (A report that never
  // finished cannot be told apart from an older one, so it is treated the same way.)
  if (format !== 'new') {
    cleanAnalysis.rationale = null;
    for (const c of outComps) c.narrative = null;
  }
  // a saved range that cannot be shown (not $200 wide, or a price missing) is not passed on in any field either
  if (flags.includes('range_not_valid')) {
    for (const col of ['headline_range_low', 'headline_range_high', 'suggested_list_price', 'stretch_price', 'confidence_label']) cleanAnalysis[col] = null;
  }

  // `scorecard` is passed on as given: left out, buildApiResponse() uses the CURRENT published accuracy scorecard
  // (the same one a live run quotes today), so the accuracy sentences describe the tool as it stands now.
  const report = buildApiResponse({ analysis: cleanAnalysis, comps: outComps, marketData: marketData || null, numbers, scorecard, sourceNotes: notes });

  report.format = format;
  if (format === 'new' && flags.includes('range_not_valid')) {
    report.noRange = RANGE_NOT_SHOWN;
    report.accuracyLine = null;
  }
  report.runByName = typeof runByName === 'string' && runByName ? runByName : null;
  report.olderFormat = format === 'older';
  if (format === 'older') {
    // The old wide numbers, kept apart from the headline and marked as the previous method's result. This is not
    // a recommendation: there is no headline, no label, no suggested price and no stretch price on this report.
    report.legacyRange = { low: num(row.recommended_rent_low), mid: num(row.recommended_rent_mid), high: num(row.recommended_rent_high) };
    report.noRange = OLDER_NO_RANGE;
    report.accuracyLine = null; // the accuracy results are about the current method
    report.sizeBand = null;
    report.sizeNote = null; // the size rule did not exist when this report was run
  } else if (format === 'unfinished') {
    report.noRange = row.status === 'failed' ? UNFINISHED_NO_RANGE.failed : UNFINISHED_NO_RANGE.other;
    report.accuracyLine = null;
    report.sizeBand = null;
    report.sizeNote = null;
  }
  return { report, flags };
}

module.exports = {
  DEFAULT_LIMIT, MAX_LIMIT, MAX_OFFSET, MAX_SEARCH_LENGTH, MAX_SEARCH_WORDS, MAX_SEARCH_WORD_LENGTH,
  LIST_COLUMNS, REPORT_COLUMNS, COMP_COLUMNS,
  OLDER_NO_RANGE, UNFINISHED_NO_RANGE, RANGE_NOT_SHOWN, NOT_MATCHING_NOTE, NO_MARKET_NOTE, MARKET_FAILED_NOTE, ORDER_NOTE,
  METHOD_BEFORE_RENT_SCREEN, isUuid, searchWords, parseHistoryQuery, buildListQuery, reportFormat, savedHeadlineNumbers, shapeListRow, rebuildReport,
};
