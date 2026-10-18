/**
 * lib/accuracy-sentences.js
 * The plain sentences staff see about how accurate the tool has been, written
 * from the published accuracy scorecard (lib/accuracy-scorecard.json) and from
 * nothing else. They are never typed in, so a new test run keeps them true.
 *
 * The same functions write the sentences in the accuracy test's own report
 * (backtest/report.js imports them from here), so the report staff read and the
 * preview the test prints can never disagree.
 *
 * If the scorecard file is missing, damaged or has an unexpected shape, every
 * sentence is simply left out (null). A sentence is never invented, and no
 * sentence says anything about how long a home takes to lease.
 */
const fs = require('fs');
const path = require('path');

// A rate is quoted only when at least this many past leases stand behind it.
const TRACK_RECORD_MIN_LEASES = 100;
// RentCast listings are about this share of the comps staff see, and the accuracy
// test does not include them; every sentence says so.
const RENTCAST_SHARE_PERCENT = 45;
// The county the MLS records for each lease is used for GROUPING only. The
// "Ventura County" label is true only when it comes from that field.
const COUNTY_LABELS = { ventura: 'Ventura County', other: 'Other counties (LA-border area)' };
// When more than this share of the tested leases have no MLS county, the
// sentences go back to the whole-box wording.
const COUNTY_UNKNOWN_LIMIT_PERCENT = 2;

// Rules: a rate is rounded ONCE, from the raw count (k of n), to a whole "N in
// 10" with a tie going DOWN (so 75% is "7 in 10", 73% is "7 in 10", 35% is "3
// in 10"); an interval is widened outward (low floored, high ceilinged) so the
// words never claim more than the data; a label needs TRACK_RECORD_MIN_LEASES
// leases behind it or the sentence says "too few tests to say yet"; the test did
// not include RentCast listings and the sentence says so. No "accurate to", no
// promises, no time statistic.
function inTen(k, n) {
  return Math.max(0, Math.ceil((k / n) * 10 - 0.5 - 1e-9));
}
function inTenRange(low, high) {
  return [Math.max(0, Math.floor(low / 10 + 1e-9)), Math.min(10, Math.ceil(high / 10 - 1e-9))];
}
function rentcastNote(scorecard) {
  const excluded = !scorecard.pool || !scorecard.pool.rentcast || /not included/.test(scorecard.pool.rentcast);
  return excluded ? `RentCast listings, about ${RENTCAST_SHARE_PERCENT}% of the comps staff see, were not part of this test.` : '';
}
function timesInTen(k, n, ciPct) {
  const main = inTen(k, n);
  const head = `about ${main} ${main === 1 ? 'time' : 'times'} in 10`;
  if (!ciPct) return head;
  const [lo, hi] = inTenRange(ciPct[0], ciPct[1]);
  return `${head} (roughly ${lo} to ${hi} times in 10)`;
}

const AREA_LABELS = { county: 'Ventura-area', core: 'Ventura core' };
const leaseWord = n => (n === 1 ? 'lease' : 'leases');
const dataDatePhrase = scorecard => (scorecard.dataPulledOn ? `data pulled ${scorecard.dataPulledOn}` : 'data date unknown');

// The Ventura side of the county blocks, when it can carry a staff sentence: at least TRACK_RECORD_MIN_LEASES
// leases with a range behind it, and the county really known for the leases (fewer than COUNTY_UNKNOWN_LIMIT_PERCENT
// without one), because that county label is only true when it comes from the MLS county. Otherwise null,
// and the caller uses the whole-box figures and the "Ventura-area" wording.
function countySide(scorecard, method) {
  const c = scorecard && scorecard.counties;
  if (!c) return null;
  // Fails closed: the scorecard's own exact-share flag (overLimit) must say "not over", and the rounded percent must agree.
  // A missing or malformed unknown block means we cannot show the county is known, so the whole box is quoted.
  if (!c.unknown || c.unknown.overLimit !== false || typeof c.unknown.sharePct !== 'number' || !Number.isFinite(c.unknown.sharePct) || c.unknown.sharePct > COUNTY_UNKNOWN_LIMIT_PERCENT) return null;
  const side = c[method] && c[method].venturaCounty;
  if (!side || !side.ranged || side.ranged.n < TRACK_RECORD_MIN_LEASES) return null;
  return side;
}
const LA_BORDER_NOTE = 'Figures for homes in the LA-border area (other counties) are reported separately.';

// One plain sentence, with no numbers in it, saying that measuring at the day each home was LISTED (the harder, more
// honest test) comes out slightly worse than the figures above, which are measured at the day it leased. Worked out from
// the scorecard's own listing-time check (listingTimeCheck), never assumed: left out when that check is missing, has too
// few leases behind it, or does not show the listing-time result being worse.
function listingTimeSentence(scorecard, method) {
  const lt = scorecard && scorecard.listingTimeCheck;
  const pick = basis => lt && lt[basis] && lt[basis][method] && lt[basis][method].county && lt[basis][method].county.ranged;
  const atListing = pick('listingTimeBasis');
  const atClose = pick('closeDateBasis');
  const usable = b => !!b && Number.isFinite(b.within300Pct) && Number.isFinite(b.typicalMiss) && b.n >= TRACK_RECORD_MIN_LEASES;
  if (!usable(atListing) || !usable(atClose)) return '';
  const worse = Math.round(atListing.within300Pct) < Math.round(atClose.within300Pct)
    || Math.ceil(atListing.typicalMiss / 50) * 50 > Math.ceil(atClose.typicalMiss / 50) * 50;
  return worse ? 'Measured as of the day each home was listed rather than the day it leased, the results are slightly worse.' : '';
}

function accuracyLine(scorecard, { method = 'baseline', area = 'county', areaLabel } = {}) {
  const side = !areaLabel && area === 'county' ? countySide(scorecard, method) : null;
  const label = side ? COUNTY_LABELS.ventura : (areaLabel || AREA_LABELS[area] || AREA_LABELS.county);
  const block = side || scorecard.overall[method][area];
  if (!block || !block.ranged) return null;
  const rg = block.ranged;
  const note = rentcastNote(scorecard);
  if (rg.n < TRACK_RECORD_MIN_LEASES) return `Blind-tested on only ${rg.n} past ${label} ${leaseWord(rg.n)}: too few tests to say yet (${dataDatePhrase(scorecard)}).${note ? ` ${note}` : ''}`;
  const miss = Math.ceil(rg.typicalMiss / 50) * 50; // rounded UP: never claims a smaller miss than measured
  const hit = timesInTen(rg.within300OfSuggestedCount, rg.n, rg.within300OfSuggestedCiPct);
  // Coverage next to accuracy: some homes get no range at all, and the sentence must not hide that. Rounded down.
  const coverage = block.coveragePct === null || block.coveragePct === undefined ? '' : `; a recommended range could be shown for ${Math.floor(block.coveragePct + 1e-9)}% of the homes tried`;
  const timing = listingTimeSentence(scorecard, method);
  return `Blind-tested on ${rg.n} past ${label} ${leaseWord(rg.n)}: typical miss about $${miss.toLocaleString('en-US')}; the suggested price landed within $300 of the signed rent ${hit}${coverage} (${dataDatePhrase(scorecard)}).${timing ? ` ${timing}` : ''}${side ? ` ${LA_BORDER_NOTE}` : ''}${note ? ` ${note}` : ''}`;
}

function labelHitRates(scorecard, label, { method = 'size25_item2', area = 'county', areaLabel } = {}) {
  const side = !areaLabel && area === 'county' ? countySide(scorecard, method) : null;
  const g = side ? side.confidence : (scorecard.groups[method] && scorecard.groups[method][area] && scorecard.groups[method][area].confidence);
  const b = g && g[label];
  if (!b || !b.ranged) return { n: 0, enough: false, county: !!side };
  const rg = b.ranged;
  return {
    county: !!side,
    n: rg.n, enough: rg.n >= TRACK_RECORD_MIN_LEASES,
    rangeHitCount: rg.rangeHit200Count, rangeHitCiPct: rg.rangeHit200CiPct,
    within300Count: rg.within300OfSuggestedCount, within300CiPct: rg.within300OfSuggestedCiPct,
  };
}

function trackRecordSentence(scorecard, label, opts = {}) {
  const h = labelHitRates(scorecard, label, opts);
  if (!h.enough) return `${label} confidence: too few tests to say yet.`;
  const where = h.county ? COUNTY_LABELS.ventura : (opts.areaLabel || AREA_LABELS[opts.area || 'county'] || AREA_LABELS.county);
  const note = rentcastNote(scorecard);
  return `${label} confidence. In blind tests on ${h.n} past ${where} ${leaseWord(h.n)}, reports like this held the signed rent inside the recommended range ${timesInTen(h.rangeHitCount, h.n, h.rangeHitCiPct)} and landed within $300 of the suggested price ${timesInTen(h.within300Count, h.n, h.within300CiPct)}.${h.county ? ` ${LA_BORDER_NOTE}` : ''}${note ? ` ${note}` : ''}`;
}

// ── reading the published scorecard ──────────────────────────────────────────
const SCORECARD_PATH = path.join(__dirname, 'accuracy-scorecard.json');

// The scorecard the sentences need must at least have these parts. Anything else
// missing is handled inside the sentence functions (they return null).
function looksLikeScorecard(sc) {
  return !!sc && typeof sc === 'object' && !Array.isArray(sc)
    && sc.overall && typeof sc.overall === 'object'
    && sc.groups && typeof sc.groups === 'object';
}

/**
 * Reads the published scorecard. Returns null (never throws) when the file is
 * missing, is not valid JSON or does not look like a scorecard, and also when
 * the test run behind it was not trusted: an untrusted scorecard is not quoted.
 * @param {string} [file] - override for tests
 */
function loadAccuracyScorecard(file = SCORECARD_PATH) {
  try {
    if (!fs.existsSync(file)) return null;
    const sc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return looksLikeScorecard(sc) && sc.trusted === true ? sc : null;
  } catch (_) {
    return null;
  }
}

/**
 * The sentence for a report's accuracy line and for its confidence label,
 * or null for either when there is nothing true to say.
 * @param {object|null} scorecard - from loadAccuracyScorecard()
 * @param {'high'|'medium'|'low'|null} label
 */
function staffSentences(scorecard, label) {
  const out = { accuracyLine: null, trackRecord: null };
  if (!looksLikeScorecard(scorecard)) return out;
  try {
    out.accuracyLine = accuracyLine(scorecard, { method: 'size25_item2' }) || null;
    if (label) out.trackRecord = trackRecordSentence(scorecard, label.charAt(0).toUpperCase() + label.slice(1), { method: 'size25_item2' }) || null;
    // Both sentences end with the same two notes (the LA-border figures are reported separately; RentCast listings
    // were not part of the test). On the screen they sit together, so the notes are said once, in the accuracy line.
    if (out.accuracyLine && out.trackRecord) {
      out.trackRecord = out.trackRecord.split(` ${LA_BORDER_NOTE}`).join('').split(` ${rentcastNote(scorecard)}`).join('').trim();
    }
  } catch (_) {
    return { accuracyLine: null, trackRecord: null };
  }
  return out;
}

module.exports = {
  TRACK_RECORD_MIN_LEASES, RENTCAST_SHARE_PERCENT, COUNTY_LABELS, COUNTY_UNKNOWN_LIMIT_PERCENT,
  inTen, inTenRange, countySide, accuracyLine, listingTimeSentence, labelHitRates, trackRecordSentence,
  loadAccuracyScorecard, looksLikeScorecard, staffSentences, SCORECARD_PATH,
};
