/**
 * backtest/constants.js
 * Settings for the permanent blind accuracy test (CMA-QUALITY-SPEC.md, Phase A).
 * Everything the protocol fixes in advance lives here so a run can be
 * reproduced and so tests can pin it.
 */

// Ventura-area service-area box and the Ventura "core" box inside it
// (spec "What the blind tests show", Protocol). Targets must sit inside the
// county box; "core" is the subset inside the core box.
const COUNTY_BOX = { minLat: 34.05, maxLat: 34.50, minLon: -119.50, maxLon: -118.65 };
const CORE_BOX = { minLat: 34.15, maxLat: 34.35, minLon: -119.38, maxLon: -119.08 };

// Comps for a target near the county-box edge can sit up to 2 miles outside
// it, so the Recore pull is padded a little more than 2 miles (0.035 deg of
// latitude / 0.045 deg of longitude at this latitude). Targets are NOT padded.
const PULL_PAD = { lat: 0.035, lon: 0.045 };

// Where the pull starts. The earliest Rincon target starts 2025-10-16 and its
// comps reach 6 months back, so 2025-03-15 (the spec's own pull date) covers
// every target with room to spare.
const DEFAULT_DATA_FROM = '2025-03-15';

// MLS targets: leases closed on or after this date (spec protocol).
const DEFAULT_TARGET_FROM = '2026-04-15';

// Usable-target screens (spec protocol).
const USABLE = { minRent: 500, maxRent: 20000 };
const USABLE_TARGET_TYPES = ['single_family', 'condo', 'townhouse'];

// Rincon portfolio test (A.4): single-home leases started in the last 12
// months, after the plausibility screen.
const RINCON = {
  lookbackMonths: 12,
  minRent: 800, maxRent: 12000,
  minRentPerSqft: 0.80, maxRentPerSqft: 6.00,
  singleHomeTypes: ['Single Home', 'Single-Family'],
};

// Outcome matcher (A.4): a saved analysis counts as a forward outcome only if
// a Rincon lease started AFTER it was run, within this many days.
const OUTCOME_MAX_DAYS = 120;

// Walk-forward split (A.5): hold-out = the newest N months of targets.
const HOLDOUT_MONTHS = 3;

// Readings we will not publish below this many leases (A.1 "counts of 20 or more").
const MIN_GROUP_N = 20;

// A staff-facing sentence quotes a hit rate only when the label has at least
// this many leases behind it; below that it says "too few tests to say yet".
const TRACK_RECORD_MIN_LEASES = 100;

// RentCast listings are about 45% of the comps staff see (spec Appendix H) and
// are not in the replay (phase A2 is not built); every staff-facing accuracy
// sentence says so.
const RENTCAST_SHARE_PERCENT = 45;

// The county box also takes in the Los Angeles side of the Conejo Valley border.
// These cities (compared case-insensitively, spaces trimmed) form the separate
// "LA-border cities" group so the Ventura-only figures can be stated on their own.
// The comp box itself is NOT trimmed: that would change every published number.
const LA_BORDER_CITIES = ['Westlake Village', 'Agoura Hills', 'Calabasas', 'West Hills', 'Woodland Hills', 'Malibu', 'Hidden Hills', 'Canoga Park', 'Agoura', 'Los Angeles'];
const REGION_LABELS = { laBorder: 'LA-border cities', venturaOnly: 'Ventura-area excluding LA-border' };

// Grouping by the MLS's own county field (Recore CRMLS field CountyOrParish; values seen: "Ventura", "Los Angeles").
// This is for GROUPING ONLY: it never changes which comps the tool uses or any headline number. The "Ventura County"
// label is accurate because it comes from the county field; a record with no county uses the city list above instead
// (and is counted and reported). When more than COUNTY_UNKNOWN_LIMIT_PERCENT of the tested leases have no county the
// report states it as a limit and the staff sentences go back to the all-box wording.
const COUNTY_FIELD = 'CountyOrParish';
const COUNTY_LABELS = { ventura: 'Ventura County', other: 'Other counties (LA-border area)' };
const COUNTY_UNKNOWN_LIMIT_PERCENT = 2;

// The saved data must have been pulled within this many days of the run, or the
// scorecard is not trusted (so a stale cache cannot be published as fresh).
const MAX_DATA_AGE_DAYS = 45;

// A report needs this many counted comps to get a recommended range
// (spec 4.2; same number as MIN_COMPS_FOR_NARROW_RADIUS).
const HEADLINE_MIN_COMPS = 4;
const HEADLINE_RANGE_WIDTH = 200;

// Same-property guard (A.3 no-peeking rule 2): "same coordinates" tolerance.
const DUPLICATE_DISTANCE_METERS = 30;

// Leak self-test (A.2 item 5). Chosen before looking at results: planting the
// target's own lease must cut the typical miss to at most this share of the
// clean run's. The "heavy" leak plants several distinct-address copies so it
// outweighs the other comps; it must drive the typical miss to nearly zero.
const LEAK = { sampleSize: 300, heavyCopies: 8, singleMaxShare: 0.85, heavyMaxShare: 0.30 };

// Acceptance rule for adopting a change (Decision 4 / A.11). Written down
// here BEFORE any hold-out number is looked at.
const ACCEPTANCE = {
  minGainWithin300Points: 4,
  minMissImprovementDollars: 25,
  maxCoverageLossPoints: 5,
  maxLargeGroupWorsePoints: 3,
  minHoldoutLeases: 300,
  minHoldoutLeasesRinconOnly: 150,
  largeGroupMinN: 100,
};

const RECORE_PAGE = 200;            // Recore's maximum $top
const RECORE_DELAY_MS = 300;        // polite pause between requests

module.exports = {
  COUNTY_BOX, CORE_BOX, PULL_PAD, DEFAULT_DATA_FROM, DEFAULT_TARGET_FROM, USABLE, USABLE_TARGET_TYPES,
  RINCON, OUTCOME_MAX_DAYS, HOLDOUT_MONTHS, MIN_GROUP_N, TRACK_RECORD_MIN_LEASES, RENTCAST_SHARE_PERCENT, LA_BORDER_CITIES, REGION_LABELS, COUNTY_FIELD, COUNTY_LABELS, COUNTY_UNKNOWN_LIMIT_PERCENT, MAX_DATA_AGE_DAYS, HEADLINE_MIN_COMPS, HEADLINE_RANGE_WIDTH,
  DUPLICATE_DISTANCE_METERS, LEAK, ACCEPTANCE, RECORE_PAGE, RECORE_DELAY_MS,
};
