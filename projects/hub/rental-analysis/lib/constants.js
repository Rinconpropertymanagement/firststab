/**
 * lib/constants.js
 * Values that must stay in lockstep with the CHECK constraints in
 * supabase/migrations/20260812010000_rental_analysis_schema.sql. If the
 * migration's allowed values ever change, update both places — same rule
 * the migration file itself documents for its own two duplicated
 * property_type CHECK lists.
 */

const PROPERTY_TYPES = [
  'single_family',
  'condo',
  'townhouse',
  'duplex',
  'triplex',
  'fourplex',
  'apartment',
  'manufactured',
  'other',
];

const LISTING_STATUSES = ['active', 'leased', 'off_market'];

const ANALYSIS_STATUSES = ['pending', 'running', 'complete', 'failed'];

// Radius ladder shared by every comp source that can compute a real
// distance_miles (lib/rentcast.js, lib/crmls.js, lib/leadsimple.js once it
// has coordinates). Peter's own call, relayed via Jarvis: "1 mile but in a
// more rural setting maybe 2", later tightened to start close and only widen
// when there isn't enough confirmed-lease evidence nearby.
//
// WIDE_SEARCH_RADIUS_MILES is the ceiling AND the distance every source
// fetches out to, in one network call each (RentCast radius/maxRadius, the
// CRMLS bounding box, the LeadSimple cap). The ladder below is applied once,
// on the merged list, by chooseRadiusRung()/applyCombinedRadiusTiering() in
// lib/sources.js: it tries each rung in ascending order and stops at the
// first one holding at least MIN_COMPS_FOR_NARROW_RADIUS genuine comps (one
// per distinct address) of which at least MIN_LEASED_COMPS_FOR_NARROW_RADIUS
// are confirmed leases. If no rung qualifies it uses the last one (the full
// WIDE bound) and keeps everything. This file only holds the numbers.
const WIDE_SEARCH_RADIUS_MILES = 2;
const RADIUS_LADDER_MILES = [0.5, 1, 1.5, WIDE_SEARCH_RADIUS_MILES];

// The tightest rung. Kept as an export for anything that still imports it
// (lib/crmls.js re-exports it); the ladder itself is RADIUS_LADDER_MILES.
const NARROW_SEARCH_RADIUS_MILES = RADIUS_LADDER_MILES[0];

// Genuine comps needed at a rung before the ladder will stop there. Also
// reused by lib/narrative.js as its own "few comps" cutoff for
// analyst-commentary language — one definition of "few comps" for this
// whole codebase, not two independently-drifting ones.
const MIN_COMPS_FOR_NARROW_RADIUS = 4;

// Of those genuine comps, how many must be confirmed leases (CRMLS Closed or
// LeadSimple Move-Ins; RentCast can never produce one) for a rung to count.
const MIN_LEASED_COMPS_FOR_NARROW_RADIUS = 2;

// Numeric guards that mirror rental_comps' CHECK constraints exactly
// (sqft > 0; bedrooms, bathrooms, distance_miles, original_price and
// days_on_market >= 0; latitude -90..90, longitude -180..180). External feeds
// do emit placeholder values (a live CRMLS record reports LivingArea 0), and
// one violating row fails the whole batch insert and marks the analysis
// failed. A value that would break its column's CHECK is "unknown" (null),
// the same as a missing value, never a guess. Only for nullable columns;
// monthly_rent is NOT NULL and is filtered by each source instead.
function positiveOrNull(n) {
  return typeof n === 'number' && n > 0 ? n : null;
}

function nonNegativeOrNull(n) {
  return typeof n === 'number' && n >= 0 ? n : null;
}

function inRangeOrNull(n, min, max) {
  return typeof n === 'number' && n >= min && n <= max ? n : null;
}

module.exports = {
  positiveOrNull,
  nonNegativeOrNull,
  inRangeOrNull,
  PROPERTY_TYPES,
  LISTING_STATUSES,
  ANALYSIS_STATUSES,
  NARROW_SEARCH_RADIUS_MILES,
  WIDE_SEARCH_RADIUS_MILES,
  RADIUS_LADDER_MILES,
  MIN_COMPS_FOR_NARROW_RADIUS,
  MIN_LEASED_COMPS_FOR_NARROW_RADIUS,
};
