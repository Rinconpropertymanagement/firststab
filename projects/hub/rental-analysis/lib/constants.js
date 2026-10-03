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

// Radius tiering shared by every comp source that can compute a real
// distance_miles (lib/rentcast.js, lib/crmls.js, lib/leadsimple.js once it
// has coordinates). Peter's own call, relayed via Jarvis: "1 mile but in a
// more rural setting maybe 2" — reacting to CRMLS's then-current flat
// 2-mile search feeling too wide. Each source queries out to the WIDE bound
// in one network call, computes real per-comp distance, then locally
// prefers the NARROW subset when it has enough comps and falls back to the
// full WIDE set otherwise — see each source file for its own tiering logic.
// This file only holds the shared numbers; the decision itself is made
// per-source, not coordinated across sources (see build notes).
const NARROW_SEARCH_RADIUS_MILES = 1;
const WIDE_SEARCH_RADIUS_MILES = 2;

// "Enough comps" threshold for preferring the narrow radius over the wide
// one. Also reused by lib/narrative.js as its own "few comps" cutoff for
// analyst-commentary language — one definition of "few comps" for this
// whole codebase, not two independently-drifting ones.
const MIN_COMPS_FOR_NARROW_RADIUS = 4;

module.exports = {
  PROPERTY_TYPES,
  LISTING_STATUSES,
  ANALYSIS_STATUSES,
  NARROW_SEARCH_RADIUS_MILES,
  WIDE_SEARCH_RADIUS_MILES,
  MIN_COMPS_FOR_NARROW_RADIUS,
};
