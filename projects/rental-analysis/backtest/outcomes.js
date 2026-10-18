/**
 * backtest/outcomes.js
 * The closed-loop outcome matcher (CMA-QUALITY-SPEC.md A.4, A.7).
 *
 * Matches each complete saved report (rental_analyses) to a Rincon lease that
 * STARTED AFTER the report was run, within OUTCOME_MAX_DAYS, using the real
 * addressesMatch(). That is a genuine forward test: the report was written
 * before the rent was signed. A lease that started on or before the report's
 * run date is counted separately as "retrospective" (staff ran the tool on an
 * already-leased unit) and is never scored.
 *
 * For a forward match it compares the signed rent with what the report said:
 *   - the $200 recommended range and suggested list price, once the report has
 *     them (Phase C adds headline_range_low/high and suggested_list_price);
 *   - until then, the stored computed range (recommended_rent_low/mid/high),
 *     which is audit-only and is labelled as such. It is used for nothing but
 *     this comparison.
 * Each lease is matched to the LATEST complete report run before it started.
 */
const { addressesMatch } = require('../lib/property-matching');
const { buildAddress } = require('../lib/leadsimple');
const { OUTCOME_MAX_DAYS } = require('./constants');
const { daysBetween } = require('./asof-sources');

function dateOnly(ts) { return typeof ts === 'string' ? ts.slice(0, 10) : null; }

function matchOutcomes(analyses, leaseRows, { maxDays = OUTCOME_MAX_DAYS } = {}) {
  const complete = analyses.filter(a => a.status === 'complete');
  const leases = leaseRows
    .filter(l => Number(l.rent) > 0 && dateOnly(l.lease_start_date))
    .map(l => ({ lease: l, address: buildAddress(l), start: dateOnly(l.lease_start_date), rent: Number(l.rent) }));

  const counts = { analyses: analyses.length, complete: complete.length, analysesWithAnyAddressMatch: 0, retrospectiveMatches: 0, forwardMatches: 0 };
  const forward = [];
  const matchedAnalysisIds = new Set();

  // Per lease: the latest complete report run strictly before the lease started.
  const bestForLease = new Map();
  for (const a of complete) {
    const run = dateOnly(a.created_at);
    if (!run) continue;
    for (const L of leases) {
      if (!addressesMatch(a.subject_address, L.address)) continue;
      matchedAnalysisIds.add(a.id);
      if (L.start <= run) { counts.retrospectiveMatches++; continue; }
      const gap = daysBetween(run, L.start);
      if (gap > maxDays) continue;
      const cur = bestForLease.get(L.lease.id);
      if (!cur || a.created_at > cur.analysis.created_at) bestForLease.set(L.lease.id, { analysis: a, L, gap });
    }
  }
  counts.analysesWithAnyAddressMatch = matchedAnalysisIds.size;

  for (const { analysis: a, L, gap } of bestForLease.values()) {
    const hasHeadline = a.headline_range_low != null && a.headline_range_high != null;
    const low = hasHeadline ? Number(a.headline_range_low) : Number(a.recommended_rent_low);
    const high = hasHeadline ? Number(a.headline_range_high) : Number(a.recommended_rent_high);
    const mid = hasHeadline && a.suggested_list_price != null ? Number(a.suggested_list_price) : Number(a.recommended_rent_mid);
    forward.push({
      analysisId: a.id,
      address: L.address, // local detail only
      runDate: dateOnly(a.created_at),
      leaseStart: L.start,
      daysFromReportToLease: gap,
      signedRent: L.rent,
      basis: hasHeadline ? 'recommended range and suggested price' : 'computed range (audit only; no recommended-range columns on this report)',
      rangeLow: low,
      rangeHigh: high,
      centre: mid,
      insideRange: L.rent >= low && L.rent <= high,
      missVsCentre: L.rent - mid,
    });
  }
  counts.forwardMatches = forward.length;
  forward.sort((x, y) => (x.leaseStart < y.leaseStart ? -1 : 1));
  return { counts, forward };
}

module.exports = { matchOutcomes };
