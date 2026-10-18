/**
 * lib/comp-rows.js
 * The one place that turns a comp (as the sources and lib/analyze.js hand it
 * around) into the row saved in the rental_comps table. Both entry points,
 * server.js (standalone) and router.js (Hub), call buildCompRows(), so they can
 * never save different things.
 *
 * Why this exists (CMA-QUALITY-SPEC.md "Files that change", and the warnings in
 * supabase/migrations/20261018_APPLY-GUIDE.md):
 *
 *   1. Every row is saved with EVERY column, always. The comps from RentCast,
 *      CRMLS and LeadSimple are saved to the database together, in one go. When
 *      some rows leave a column out, the database fills that gap with "nothing"
 *      (NULL), NOT with the column's usual starting value. The two tag-list
 *      columns (mls_flags and condition_tags) are not allowed to be "nothing",
 *      so a single row without them would make the database refuse the whole
 *      batch and the whole analysis would end "failed". That is why those two
 *      are always a list (an empty list when there is nothing to say), for every
 *      source.
 *   2. Every value is forced into what the database accepts: the fixed word
 *      lists in lib/constants.js and the length limits. A word outside its list
 *      would also make the database refuse the whole batch, so it becomes
 *      "unknown" (nothing, or an empty list) instead. A condition rating is only
 *      kept when it was read from listing text, because the database refuses any
 *      other rating.
 *   3. Only the columns named below are ever saved. Working notes that live on a
 *      comp while the analysis runs (which source it came from, why it was left
 *      out, anything starting with an underscore such as listing text) are never
 *      copied into a row.
 */

const {
  FURNISHED_STATUSES,
  LEASE_TERM_CLASSES,
  MLS_FLAGS,
  CONDITION_RATINGS,
  CONDITION_BASES,
  CONDITION_TAGS,
  MAX_MLS_CONDITION_LENGTH,
  MAX_SUBDIVISION_LENGTH,
} = require('./constants');
const { cleanListingId, cleanYearBuilt, textOrNull } = require('./mls-facts');

// Every column buildCompRow() sends, in order. Exported so a test (and anyone
// adding a column) can see the full list in one place.
const COMP_ROW_COLUMNS = [
  'analysis_id', 'source_id', 'address', 'property_type', 'bedrooms', 'bathrooms', 'sqft',
  'distance_miles', 'latitude', 'longitude', 'monthly_rent', 'is_estimated_price', 'original_price',
  'had_price_cut', 'listing_status', 'days_on_market', 'listed_date', 'leased_date',
  'is_rincon_managed', 'comp_property_id', 'narrative',
  'mls_listing_id', 'year_built', 'subdivision_name', 'furnished_status', 'lease_term_class',
  'age_restricted', 'mls_condition', 'mls_flags',
  'condition_rating', 'condition_basis', 'condition_tags',
];

// A list reduced to the words the database allows, each once, never null.
function onlyAllowed(list, allowed) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter(item => typeof item === 'string' && allowed.includes(item)))];
}

function oneOf(value, allowed) {
  return typeof value === 'string' && allowed.includes(value) ? value : null;
}

/**
 * @param {object} comp - one comp after lib/analyze.js computeNumbers()
 * @param {{analysisId: string, narrative?: string|null}} opts
 * @returns {object} one rental_comps row, every column present
 */
function buildCompRow(comp, { analysisId, narrative = null }) {
  const c = comp || {};
  const conditionBasis = oneOf(c.condition_basis, CONDITION_BASES);
  // The database only accepts a rating whose basis is "listing_text".
  const conditionRating = conditionBasis === 'listing_text' ? oneOf(c.condition_rating, CONDITION_RATINGS) : null;
  return {
    analysis_id: analysisId,
    source_id: c.source_id,
    address: c.address,
    property_type: c.property_type ?? null,
    bedrooms: c.bedrooms ?? null,
    bathrooms: c.bathrooms ?? null,
    sqft: c.sqft ?? null,
    distance_miles: c.distance_miles ?? null,
    latitude: c.latitude ?? null,
    longitude: c.longitude ?? null,
    monthly_rent: c.monthly_rent,
    is_estimated_price: c.is_estimated_price === true,
    original_price: c.original_price ?? null,
    had_price_cut: c.had_price_cut === true,
    listing_status: c.listing_status,
    days_on_market: c.days_on_market ?? null,
    listed_date: c.listed_date ?? null,
    leased_date: c.leased_date ?? null,
    is_rincon_managed: c.is_rincon_managed === true,
    comp_property_id: c.comp_property_id ?? null,
    narrative: narrative ?? null,
    // The extra MLS facts (Item 2). Unknown is null; the two lists are always lists.
    mls_listing_id: cleanListingId(c.mls_listing_id),
    year_built: cleanYearBuilt(c.year_built),
    subdivision_name: textOrNull(c.subdivision_name, MAX_SUBDIVISION_LENGTH),
    furnished_status: oneOf(c.furnished_status, FURNISHED_STATUSES),
    lease_term_class: oneOf(c.lease_term_class, LEASE_TERM_CLASSES),
    age_restricted: typeof c.age_restricted === 'boolean' ? c.age_restricted : null,
    mls_condition: textOrNull(c.mls_condition, MAX_MLS_CONDITION_LENGTH),
    mls_flags: onlyAllowed(c.mls_flags, MLS_FLAGS),
    // Condition ratings (a later phase). Nothing sets these yet, so today every
    // row sends no rating, no basis and an empty tag list.
    condition_rating: conditionRating,
    condition_basis: conditionBasis,
    condition_tags: onlyAllowed(c.condition_tags, CONDITION_TAGS),
  };
}

/**
 * @param {object[]} comps - the comps in the same order as `narratives`
 * @param {{analysisId: string, narratives?: (string|null)[]}} opts
 * @returns {object[]} the rows to save together in rental_comps
 */
function buildCompRows(comps, { analysisId, narratives = [] }) {
  return (comps || []).map((c, i) => buildCompRow(c, { analysisId, narrative: narratives[i] ?? null }));
}

module.exports = { COMP_ROW_COLUMNS, buildCompRow, buildCompRows };
