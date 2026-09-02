/**
 * lib/component-categories.js
 * Step 1 of the Property Overview build (property-overview-SPEC.md,
 * "Step 1 — Group by system, not by ticket") — a maintained, reviewable
 * keyword-match taxonomy, same pattern as protected-class-terms.js:
 * reviewable/editable code asset, not a database config table, because
 * this is a taxonomy, not a numeric decision threshold.
 *
 * Deterministic, cheap, auditable — NOT a per-claim AI classification
 * pass. Matches each maintenance_requests.title/description against one
 * of ten fixed buckets. A ticket can land in more than one bucket if
 * its text clearly spans systems (per the spec's own 566 N Ventura
 * example: kitchen/moisture + dryer/venting + crawl space + A/C, one
 * ticket, four systems) — better to show a real cross-reference than
 * force a single wrong bucket.
 *
 * SPEC.md Open Item #2 flags this exact list as a starting taxonomy that
 * needs a sanity-check against a broader slice of real tickets before
 * it's treated as final — not a researched, closed list. Easy to revise
 * here since it's a plain code asset, not a migration.
 *
 * Validated 2026-09-01 against every real ticket in the database (529 at
 * first validation, 542 by the final round-2 pass the same day — organic
 * ticket growth, not a discrepancy).
 * Two buckets (landscaping, turnover_cleaning) and several keyword fixes
 * below trace directly to that pass. Two known limitations were found
 * and deliberately NOT fixed here (see notes at their keyword sites):
 *   - 'floor' can false-positive on ordinal references like "2nd floor
 *     hallway" tagging structural_exterior; fixing this needs a regex
 *     exclusion pattern, not a keyword change, and it only ever adds an
 *     extra tag rather than replacing a ticket's correct bucket — not
 *     worth the complexity.
 *   - Negation is invisible to keyword matching, e.g. "no signs of
 *     mildew" still matches 'mildew'. Structural limitation of this
 *     approach, not a keyword-list bug — would need real text
 *     understanding to fix.
 */

const CATEGORIES_VERSION = 'component-categories-v1';

// Order matters for card display — matches SPEC.md's own listed order.
const CATEGORY_ORDER = [
  'electrical',
  'plumbing',
  'hvac_moisture',
  'appliances',
  'structural_exterior',
  'landscaping',
  'turnover_cleaning',
  'pest_control',
  'locks_security',
  'other',
];

const CATEGORY_LABELS = {
  electrical: 'Electrical',
  plumbing: 'Plumbing',
  hvac_moisture: 'HVAC & Moisture/Mold',
  appliances: 'Appliances',
  structural_exterior: 'Structural & Exterior',
  landscaping: 'Landscaping & Irrigation',
  turnover_cleaning: 'Turnover & Cleaning',
  pest_control: 'Pest Control',
  locks_security: 'Locks & Security',
  other: 'Other',
};

// Each category maps to an array of lowercase terms/phrases, same
// matching approach as protected-class-terms.js (case-insensitive,
// whole-word-ish via \b boundaries — see matchesTerm below).
const CATEGORIES = {
  electrical: [
    'electrical', 'electric', 'outlet', 'outlets', 'receptacle', 'breaker', 'breakers',
    'circuit', 'panel', 'panels', 'wiring', 'rewire', 'fuse', 'gfci', 'light fixture',
    'lighting', 'photocell', 'light switch', 'voltage', 'short circuit',
    'electrician', 'power outage', 'no power', 'sparking',
    // Life-safety devices: 18 real tickets mention these and were only
    // getting tagged incidentally, when they shared a ticket with an
    // unrelated matched word.
    // Both singular and plural forms are listed explicitly (same pattern
    // as 'rat'/'rats', 'door'/'doors' elsewhere in this file) because \b
    // doesn't make the trailing 's' optional — 'detectors'/'alarms'
    // otherwise fail to match.
    'smoke detector', 'smoke detectors', 'smoke alarm', 'smoke alarms',
    'fire alarm', 'fire alarms', 'co detector', 'co detectors',
    'co alarm', 'co alarms', 'carbon monoxide',
  ],
  plumbing: [
    'plumbing', 'pipe', 'pipes', 'leak', 'leaks', 'leaking', 'faucet', 'toilet',
    'drain', 'sewer', 'water heater', 'garbage disposal', 'disposal',
    'sump pump', 'sink', 'shower', 'bathtub', 'water line', 'clog',
    'clogged', 'plumber', 'running water', 'water shut off', 'hose bib',
    // 'hose bibb' (double-b) is the industry-standard spelling and the
    // word-boundary regex on 'hose bib' alone doesn't match it — a real
    // ticket titled "Hose Bibb Vacuum Breakers" was missed without this.
    'hose bibb',
    'gas line', 'gas leak', 'water softener',
  ],
  hvac_moisture: [
    'hvac', 'air condition', 'a/c', 'ac unit',
    // Bare 'ac' catches real tickets titled just "AC Install" or
    // "(URGENT) AC not cooling properly" that 'a/c' and 'ac unit' miss.
    // Safe: word-boundary matching means it won't false-positive on
    // words that merely contain "ac" (e.g. "space").
    'ac',
    'heater', 'heating',
    'furnace', 'thermostat',
    // 'vent' removed: it wrongly matched "dryer vent clean" and "vent
    // hood replacement" — routine appliance/cleaning tickets, not HVAC
    // problems — inflating this bucket by 15% in real data. 'venting',
    // 'ductwork', 'duct' are specific enough to keep.
    'venting', 'ductwork', 'duct',
    'mold', 'mildew', 'water damage', 'humidity', 'crawl space',
    'condensation', 'dehumidifier', 'moisture',
  ],
  appliances: [
    'appliance', 'appliances', 'refrigerator', 'fridge', 'dishwasher', 'oven', 'stove',
    'range', 'microwave', 'washer', 'dryer', 'washing machine',
    'ice maker', 'vent hood', 'exhaust fan',
  ],
  structural_exterior: [
    'roof', 'roofing', 'foundation', 'structural', 'exterior', 'stucco',
    'fence', 'fencing', 'gutter', 'gutters', 'siding', 'window',
    'windows', 'door', 'doors', 'deck', 'patio', 'driveway', 'sidewalk',
    'drywall',
    // Two-word spelling seen in real tickets alongside the one-word form.
    'dry wall',
    'ceiling',
    // NOTE (known, accepted limitation): 'floor' can false-positive on
    // ordinal references like "2nd floor hallway", tagging this bucket
    // on a ticket that isn't about flooring at all. Fixing it needs a
    // regex exclusion pattern, not a keyword change, and the validation
    // pass found it only ever adds an extra tag rather than replacing a
    // ticket's correct bucket — not worth the added complexity. Left
    // as-is.
    'flooring', 'floor', 'paint', 'painting',
    'garage door',
    'carpet', 'cabinet', 'cabinets', 'vanity', 'closet', 'baseboard',
    'tile', 'blind', 'blinds', 'screen', 'screens', 'pressure wash',
  ],
  landscaping: [
    'gardening', 'garden', 'landscaping', 'landscape', 'sprinkler',
    'sprinklers', 'irrigation', 'tree trimming', 'tree pruning',
    'artificial grass', 'lawn',
  ],
  turnover_cleaning: [
    'move in clean', 'move out clean', 'turnover clean', 'deep clean',
    'touch up clean', 'rent ready clean',
    // -ing forms added: real tickets are dominated by gerund phrasing
    // ("Move Out Cleaning", "Turnover Cleaning", "Deep Cleaning") — the
    // bare-verb forms above miss most of them. Kept alongside, not
    // replacing, in case bare-verb tickets exist too.
    'move in cleaning', 'move out cleaning', 'turnover cleaning',
    'deep cleaning', 'touch up cleaning', 'rent ready cleaning',
    // Carpet cleaning is a turnover workflow item, not just a structural
    // reference to carpet as a surface — lands here in addition to
    // structural_exterior's bare 'carpet' (a ticket can be in both
    // buckets, per this file's header).
    'carpet clean', 'carpet cleaning',
  ],
  pest_control: [
    'pest', 'rodent', 'rodents', 'rat', 'rats', 'mice', 'mouse',
    'termite', 'termites', 'ant', 'ants', 'cockroach', 'roach',
    'bed bug', 'bedbug', 'wasp', 'wasps', 'bee', 'bees',
    // 'bee'/'bees' don't match inside the unbroken word "beehive" under
    // word-boundary matching — a real ticket titled "Beehive needs
    // removal" was missed without this explicit entry.
    'beehive',
    'infestation', 'exterminator',
  ],
  locks_security: [
    'lock', 'locks', 'locked out', 'lockout', 'rekey', 'deadbolt', 'key',
    'keys', 'security', 'camera', 'cameras', 'gate', 'gates', 'intercom',
    'garage door opener',
    // Bare 'alarm' removed: 5 of 6 real "alarm" tickets are smoke/fire/CO
    // alarms (life-safety devices, now tagged under electrical above),
    // not security alarms — it was polluting this bucket. Replaced with
    // terms specific to security/burglar alarms.
    // Plural forms listed explicitly too, same reason as electrical's
    // life-safety devices above.
    'security alarm', 'security alarms', 'burglar alarm', 'burglar alarms',
    'alarm system', 'alarm systems', 'alarm panel', 'alarm panels',
  ],
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const FLAT_TERMS = Object.entries(CATEGORIES).flatMap(([category, terms]) =>
  terms.map(term => ({
    term,
    category,
    regex: new RegExp(`\\b${escapeRegex(term.trim())}\\b`, 'i'),
  }))
);

/**
 * Categorizes one ticket's text into one or more component buckets.
 * Returns an array of category keys (from CATEGORY_ORDER); falls back to
 * ['other'] when nothing matches rather than an empty array, so every
 * ticket always lands somewhere.
 */
function categorize(text) {
  const normalized = String(text || '');
  const matched = new Set();
  for (const { category, regex } of FLAT_TERMS) {
    if (regex.test(normalized)) matched.add(category);
  }
  if (matched.size === 0) matched.add('other');
  return Array.from(matched);
}

module.exports = { categorize, CATEGORY_ORDER, CATEGORY_LABELS, CATEGORIES, CATEGORIES_VERSION };
