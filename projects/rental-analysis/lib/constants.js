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

module.exports = { PROPERTY_TYPES, LISTING_STATUSES, ANALYSIS_STATUSES };
