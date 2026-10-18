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

// Square-footage band (CMA-QUALITY-SPEC.md Item 1). A comp whose size is more
// than this many percent larger or smaller than the subject's does not count.
// One number, used everywhere (the range math, the radius search, the notes
// on the report), so changing it here changes it for the whole tool.
const SQFT_BAND_PCT = 25;
// The rule applies only to these kinds of subject. For a duplex, triplex,
// fourplex or apartment the MLS often lists the size of the whole building, so
// comparing sizes would throw out good comps.
const SQFT_BAND_PROPERTY_TYPES = ['single_family', 'townhouse', 'condo', 'manufactured'];

// MLS facts (Item 2). Every list below is the exact list the database accepts
// (supabase/migrations/20261018000000_rental_cma_quality.sql). A value outside
// its list would make the database refuse the whole batch of comps and the
// whole analysis would fail, so lib/comp-rows.js filters to these lists before
// anything is saved. To add a word, change the migration and this file together.
const FURNISHED_STATUSES = ['furnished', 'unfurnished', 'partial', 'either'];
const LEASE_TERM_CLASSES = ['long', 'short', 'six_month'];
const MLS_FLAGS = [
  'furnished', 'partly_furnished', 'short_term', 'age_restricted', 'hoa', 'private_pool',
  'utilities_included', 'water_trash_included', 'gardener_included', 'new_construction',
  'adu_or_guest_house', 'view_property',
];
const CONDITION_RATINGS = ['A+', 'A', 'B', 'C', 'D', 'F'];
const CONDITION_BASES = ['listing_text', 'unclear', 'not_available'];
const CONDITION_TAGS = [
  'remodeled', 'new_build', 'stone_counters', 'new_flooring', 'new_cabinets',
  'updated_kitchen', 'updated_baths', 'cosmetic_updates', 'original_finishes', 'needs_repair',
];
// Longest text each column accepts (text longer than this becomes "unknown").
const MAX_MLS_LISTING_ID_LENGTH = 40;
const MAX_MLS_CONDITION_LENGTH = 80;
const MAX_SUBDIVISION_LENGTH = 120;
// The year-built range the database accepts.
const MIN_YEAR_BUILT = 1800;
const MAX_YEAR_BUILT = 2100;
// A home built this many years ago or less (counting the current year) is
// flagged "new construction": built 2024 or later, when it is 2026.
const NEW_CONSTRUCTION_YEARS = 2;
// A subject whose lease is this many months or longer does not want comps on a
// month-to-month or vacation-style lease.
const SHORT_TERM_LEASE_BELOW_MONTHS = 6;

// ─── The recommended range, the prices and the confidence label (Item 4) ─────
// The headline of every report is a "recommended range" that is ALWAYS exactly
// HEADLINE_RANGE_WIDTH dollars wide with both ends on a round $100. Nothing
// wider than this is ever recommended or shown. The database enforces the same
// thing (supabase/migrations/20261018000000_rental_cma_quality.sql,
// chk_headline_range), so a bug here can never save a wide range.
const HEADLINE_RANGE_WIDTH = 200;
// Fewer than this many counted comps and there is NO recommended range, no
// prices and no confidence label: the report still finishes, and says why.
// KEEP IN STEP WITH THE DATABASE: the migration's chk_complete_requires_rent_range
// hard-codes the same number (counted_comp_count < 4). Changing it here needs a
// new migration, deployed together with the code (APPLY-GUIDE, note (f)).
const HEADLINE_MIN_COMPS = 4;
// The suggested list price is a multiple of this.
const LIST_PRICE_STEP = 50;
// The stretch price is a single price this far above the top of the range.
// It is NOT part of the range, and it carries no claim about anything.
const STRETCH_ABOVE_RANGE = 200;
// How the middle of the range is chosen: the weighted median of the counted comps.
const CENTRE_METHOD = 'median';

// What the owner wants. It changes ONLY which price inside the range is suggested.
// The words here are the exact words the database accepts (owner_goal).
const OWNER_GOALS = ['lease_quickly', 'balanced', 'maximize_rent'];
const DEFAULT_OWNER_GOAL = 'balanced';
// How each goal reads in the plain sentence under the range.
const OWNER_GOAL_PHRASES = {
  lease_quickly: 'leasing quickly',
  balanced: 'a balanced approach',
  maximize_rent: 'maximizing rent',
};

// The confidence label (spec 4.3). These are STARTING values, to be re-checked
// against the accuracy test before they change.
//   Low    : the comps are spread out (CONF_DISAGREE_SPREAD or more), or fewer than
//            CONF_LOW_BELOW_COMPS comps counted, or none is a confirmed lease, or
//            no counted comp is priced near the range.
//   High   : the comps agree (under CONF_AGREE_SPREAD), at least CONF_HIGH_MIN_COMPS
//            counted, and at least CONF_HIGH_MIN_LEASES are confirmed leases.
//   Medium : everything else.
const CONF_AGREE_SPREAD = 250;
const CONF_DISAGREE_SPREAD = 500;
const CONF_HIGH_MIN_COMPS = 6;
const CONF_HIGH_MIN_LEASES = 2;
const CONF_LOW_BELOW_COMPS = 5;
// "Near the range" means priced within this many dollars of either end.
const NEAR_RANGE_DOLLARS = 100;
// The words the database accepts for confidence_label (lower case).
const CONFIDENCE_LABELS = ['high', 'medium', 'low'];

// Short name for the rules that produced a report, saved with it
// (rental_analyses.method_version, 40 characters at most). Change it whenever the
// way the range, prices or label are worked out changes, so the accuracy test can
// tell the old reports from the new ones.
const METHOD_VERSION = 'cma-2026-10-v2';

// ─── Rincon's own signed leases: the "does this rent make sense" screen ───────
// A handful of Rincon's own lease records carry a rent that cannot be right for
// the home (a 3-bedroom house at $280 a month, a 613 sq ft condo at $199). The
// first two limits are the rent itself, the last two are the rent per square
// foot. A lease outside any of them is a data error: it is still shown on the
// report as "not used", but it never counts. ONE definition: the accuracy test
// (backtest/) uses these same four numbers to pick the leases it tests, and the
// report page uses them to leave such leases out, through rentLooksImplausible()
// in lib/leadsimple.js.
const RINCON_RENT_SCREEN = {
  minRent: 800, maxRent: 12000,
  minRentPerSqft: 0.80, maxRentPerSqft: 6.00,
};

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
  RINCON_RENT_SCREEN,
  SQFT_BAND_PCT,
  SQFT_BAND_PROPERTY_TYPES,
  FURNISHED_STATUSES,
  LEASE_TERM_CLASSES,
  MLS_FLAGS,
  CONDITION_RATINGS,
  CONDITION_BASES,
  CONDITION_TAGS,
  MAX_MLS_LISTING_ID_LENGTH,
  MAX_MLS_CONDITION_LENGTH,
  MAX_SUBDIVISION_LENGTH,
  MIN_YEAR_BUILT,
  MAX_YEAR_BUILT,
  NEW_CONSTRUCTION_YEARS,
  SHORT_TERM_LEASE_BELOW_MONTHS,
  HEADLINE_RANGE_WIDTH,
  HEADLINE_MIN_COMPS,
  LIST_PRICE_STEP,
  STRETCH_ABOVE_RANGE,
  CENTRE_METHOD,
  OWNER_GOALS,
  DEFAULT_OWNER_GOAL,
  OWNER_GOAL_PHRASES,
  CONF_AGREE_SPREAD,
  CONF_DISAGREE_SPREAD,
  CONF_HIGH_MIN_COMPS,
  CONF_HIGH_MIN_LEASES,
  CONF_LOW_BELOW_COMPS,
  NEAR_RANGE_DOLLARS,
  CONFIDENCE_LABELS,
  METHOD_VERSION,
};
