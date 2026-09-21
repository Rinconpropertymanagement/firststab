/**
 * lib/leadsimple.js
 * Third comp source, alongside lib/rentcast.js and lib/crmls.js — real,
 * confirmed-current new-tenant leases from Rincon's own portfolio, synced
 * nightly from LeadSimple's "02 Move Ins" process type into the
 * `leadsimple_new_leases` table (see the migration and
 * projects/hub/leadsimple-property-brain/sync-move-in-leases.js). See
 * LEADSIMPLE-COMP-SOURCE-SPEC.md for the full design and the live-tested
 * numbers behind every decision below.
 *
 * NO LIVE LEADSIMPLE API CALL HAPPENS HERE. This only ever reads the synced
 * table (lib/supabase.js's select()) — same "sync, not a live lookup"
 * reasoning as sync-property-stages.js: LeadSimple's API has no address
 * filter, so a live per-analysis lookup would mean paging the whole account
 * inside a request/response cycle. If the nightly sync has a bad night or
 * LEADSIMPLE_API_KEY lapses, this source just serves whatever's already
 * saved (possibly stale, never wrong-tenant — the table only ever holds
 * confirmed-current rows, see the sync script) — same graceful-degradation
 * shape as every other source in lib/sources.js.
 *
 * Every comp this source produces:
 *   - listing_status: 'leased' — a real, closed, confirmed-new-tenant
 *     lease, the same top trust tier CRMLS's real closed transactions get
 *     (lib/weighting.js, 3x weight). Considered and rejected: a 4th,
 *     higher tier — see spec's "Weight tier" section for why.
 *   - is_estimated_price: false, always — every row in leadsimple_new_leases
 *     already passed the sync script's `leases` cross-reference confirming
 *     currency; there is no estimated-price case left in this design (see
 *     spec, "Does market_rent/is_estimated_price still belong").
 *   - is_rincon_managed will end up true for nearly every comp this source
 *     produces once server.js's existing address-match step runs (these are
 *     Rincon's own properties, by construction) — that's expected and
 *     handled by lib/weighting.js's SELF_SOURCED_TRUSTED_SOURCE_NAMES
 *     exemption, not something this file needs to know about. This file
 *     just needs source_name to end up 'LeadSimple Move-Ins' exactly (set
 *     by lib/sources.js's runActiveSources(), from the rental_comp_sources
 *     row's own name) — that exact string is what the exemption keys off.
 *
 * COORDINATES / RADIUS (added for the distance-based comp tiering build —
 * see lib/constants.js): leadsimple_new_leases now carries a
 * latitude/longitude column pair (migration 20260919000000), geocoded by
 * sync-move-in-leases.js via LocationIQ — NOT read from LeadSimple itself,
 * which has no coordinates anywhere in its own data (confirmed live). A row
 * geocoded before this build, or one whose geocode failed, simply has null
 * coordinates — pullLeadSimpleComps() below degrades to exactly the
 * previous zip-only behavior for those, never throws. The query itself
 * stays zip-scoped either way (no DB-side radius query exists here); this
 * file computes real distance_miles and bounds each row to
 * WIDE_SEARCH_RADIUS_MILES, but no longer decides narrow vs. wide for
 * itself — that decision is now made once, across all three comp sources
 * together, by applyCombinedRadiusTiering() in lib/sources.js, after every
 * active source has reported back.
 */

const { select } = require('./supabase');
const { extractZip, haversineMiles } = require('./crmls');
const { WIDE_SEARCH_RADIUS_MILES } = require('./constants');

// "The last year or two at the most," per Peter's own words (spec, "What Q
// Needs to Build This") — scopes which of Rincon's own confirmed-current
// leases count as a recent enough new-tenant signing event to represent
// "what a new tenant recently agreed to pay," not "what everyone happens to
// be paying now" (a lease signed 4 years ago and never turned over hasn't
// been tested against today's market any more recently than a renewal has,
// even though leases.monthly_rent keeps its number fresh via nightly
// AppFolio sync — see spec, "Does the 2-year lookback window still matter").
// Easy to dial to 12-18 later; nothing else needs to change.
const MOVE_IN_LOOKBACK_MONTHS = 24;

// LeadSimple's own property_type free text -> our CHECK-constraint list
// (rental_comps.property_type, identical list to lib/crmls.js's
// FROM_CRMLS_PROPERTY_TYPE / lib/rentcast.js's FROM_RENTCAST_PROPERTY_TYPE
// target). Live-sampled real values across all 667 closed "02 Move Ins"
// records this session: 8 distinct values total, only these two clean
// enough to map 1:1 — 'Multi-Family', 'Multi-Family 2-4 units', 'Student',
// two legacy price-range labels, and nulls are all left unmapped -> null,
// same "say unknown rather than guess" discipline as every other mapper in
// this pipeline (see spec, "What Q Needs to Build This").
const FROM_LEADSIMPLE_PROPERTY_TYPE = {
  'Single Home': 'single_family',
  'Single-Family': 'single_family',
};

function toDateOnly(dateString) {
  if (!dateString || typeof dateString !== 'string') return null;
  return dateString.slice(0, 10); // already 'YYYY-MM-DD' from the sync script; slice is a safe no-op if ever fuller
}

// Builds one comparable-format address string from the table's separate
// address/city/state/zip_code columns — same free-text join shape as
// lib/crmls.js's buildAddress(), needed here because rental_comps.address
// (and this pipeline's dedupeComps()/findBestPropertyMatch() address
// matching) expects one formatted string, not decomposed parts.
function buildAddress(row) {
  const cityStateZip = [row.city, [row.state, row.zip_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [row.address, cityStateZip].filter(Boolean).join(', ');
}

/**
 * Maps one leadsimple_new_leases row into a partial rental_comps row.
 * Exported (like every other source's mapComparable) so the test suite can
 * exercise it directly without a real Supabase table.
 *
 * @param {object} row
 * @param {number|null} [distanceMiles] - real Haversine distance from the
 *   subject, computed by pullLeadSimpleComps() when both the subject and
 *   this row have real coordinates (see the migration adding
 *   leadsimple_new_leases.latitude/longitude). Omitted (-> null) for a row
 *   with no coordinates of its own (not yet backfilled, or its geocode
 *   failed) or when the subject has none — never guessed, same convention
 *   as lib/crmls.js's own mapComparable().
 */
function mapComparable(row, distanceMiles = null) {
  const hasCoords = typeof row.latitude === 'number' && typeof row.longitude === 'number';
  return {
    address: buildAddress(row),
    property_type: FROM_LEADSIMPLE_PROPERTY_TYPE[row.property_type] || null,
    bedrooms: typeof row.bedrooms === 'number' ? row.bedrooms : null,
    bathrooms: typeof row.bathrooms === 'number' ? row.bathrooms : null,
    sqft: typeof row.sqft === 'number' ? row.sqft : null,
    // Real, computed distance when pullLeadSimpleComps() could compute one
    // (subject + this row both geocoded); null otherwise — this source is
    // zip-scoped at the query level either way (see pullLeadSimpleComps()),
    // same as lib/crmls.js's own zip-fallback path. Never guessed.
    distance_miles: typeof distanceMiles === 'number' ? distanceMiles : null,
    latitude: hasCoords ? row.latitude : null,
    longitude: hasCoords ? row.longitude : null,
    monthly_rent: typeof row.rent === 'number' ? row.rent : Number(row.rent),
    // Always false — see file header. leadsimple_new_leases carries no
    // is_estimated_price column at all; hardcoded here, same pattern
    // lib/crmls.js uses for its own certain-price (Closed) case.
    is_estimated_price: false,
    original_price: null,
    had_price_cut: false,
    // The whole point of this source: a real, confirmed, new-tenant lease —
    // see lib/weighting.js for the 3x weight this earns.
    listing_status: 'leased',
    days_on_market: null,
    // "when it went off market / lease began" per rental_comps' dual-purpose
    // comment on this column (see the original schema migration) — this is
    // a real confirmed lease start date (leases.lease_start, via the sync
    // script's currency cross-reference), consistent with only
    // leased-status comps ever setting this field (CRMLS's own leased
    // comps do the same with CloseDate).
    leased_date: toDateOnly(row.lease_start_date),
    listed_date: null,
  };
}

/**
 * Pulls Rincon's own confirmed-current new-lease comps for one analysis,
 * from the synced leadsimple_new_leases table — zip-scoped at the query
 * level (unchanged: no DB-side radius query exists for this table, see the
 * migration) and lookback-windowed on `closed_at` (MOVE_IN_LOOKBACK_MONTHS
 * above). Same {comps: [...]} shape every other source returns, so
 * lib/sources.js's loop doesn't need to know which source it called.
 *
 * Self-sufficient, like lib/crmls.js's own extractZip() fallback path:
 * parses the zip straight off the subject's typed address, so the QUERY
 * itself doesn't depend on RentCast running first. Radius TIERING (see
 * below) does opt into lib/sources.js's enrichedSubject.latitude/longitude
 * when RentCast already geocoded the subject — same mechanism
 * lib/crmls.js's box search uses — but degrades to exactly the previous
 * zip-only behavior (no tiering, every fetched row kept, distance_miles
 * null) whenever those coordinates aren't available, never throws over it.
 *
 * @param {{address: string, latitude?: number, longitude?: number}} subject
 * @returns {Promise<{comps: object[], subjectEstimatedRent: null, subjectLatitude: null, subjectLongitude: null, subjectZip: string|null}>}
 */
async function pullLeadSimpleComps(subject) {
  const zip = extractZip(subject.address);
  if (!zip) {
    console.warn(`[rental-analysis] LeadSimple Move-Ins: could not find a 5-digit zip at the end of "${subject.address}" — skipping (this source is zip-scoped only, no coordinate fallback).`);
    return { comps: [], subjectEstimatedRent: null, subjectLatitude: null, subjectLongitude: null, subjectZip: null };
  }

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - MOVE_IN_LOOKBACK_MONTHS);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const query = `select=*&zip_code=eq.${encodeURIComponent(zip)}&closed_at=gte.${cutoffDate}`;
  const rows = await select('leadsimple_new_leases', query);

  // Distance/radius bound — same policy as lib/rentcast.js/lib/crmls.js (see
  // lib/constants.js), applied on top of the zip-scoped rows already
  // fetched above rather than a second query (no DB-side radius query
  // exists for this table). Only runs when the subject itself has real
  // coordinates (fed forward by lib/sources.js from RentCast, when active);
  // otherwise every row is mapped as-is, distance_miles null throughout —
  // exactly today's zip-only behavior, never a throw. The narrow/wide
  // decision itself no longer happens here — see applyCombinedRadiusTiering()
  // in lib/sources.js.
  const hasSubjectCoords = typeof subject.latitude === 'number' && typeof subject.longitude === 'number';
  let comps;
  if (hasSubjectCoords) {
    const withDistance = (rows || []).map(row => {
      const hasRowCoords = typeof row.latitude === 'number' && typeof row.longitude === 'number';
      const distanceMiles = hasRowCoords
        ? haversineMiles(subject.latitude, subject.longitude, row.latitude, row.longitude)
        : null;
      return { row, distanceMiles };
    });
    // A row beyond WIDE_SEARCH_RADIUS_MILES is dropped, same as CRMLS's own
    // box-corner post-filter — a zip code can span well past 2 miles, so
    // this is the one place that bound gets enforced for this source. A row
    // with no distance (not yet geocoded/backfilled) is kept as-is, same
    // "no basis to compute or drop it" rule lib/crmls.js uses.
    const bounded = withDistance.filter(({ distanceMiles }) => distanceMiles === null || distanceMiles <= WIDE_SEARCH_RADIUS_MILES);
    comps = bounded.map(({ row, distanceMiles }) => mapComparable(row, distanceMiles));
  } else {
    comps = (rows || []).map(row => mapComparable(row));
  }

  return {
    comps,
    // This source does no AVM-style estimate and doesn't geocode the
    // subject — same reasoning as lib/crmls.js's own nulls here.
    subjectEstimatedRent: null,
    subjectLatitude: null,
    subjectLongitude: null,
    subjectZip: zip,
  };
}

module.exports = {
  pullLeadSimpleComps,
  mapComparable,
  buildAddress,
  toDateOnly,
  FROM_LEADSIMPLE_PROPERTY_TYPE,
  MOVE_IN_LOOKBACK_MONTHS,
};
