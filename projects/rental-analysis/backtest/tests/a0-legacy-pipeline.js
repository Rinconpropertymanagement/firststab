/**
 * backtest/tests/a0-legacy-pipeline.js
 * FROZEN COPY of the numbers pipeline exactly as it was written inline in
 * server.js (standalone) and router.js (Hub) BEFORE Phase A0 moved it into
 * lib/analyze.js. It exists only so a replay can run the old code and the new
 * lib/analyze.js on the same inputs and assert identical output (see
 * backtest/a0-replay.js and the "A0" checks in q-mapping-unit-test.js).
 *
 * DO NOT "improve" this file or point anything in the product at it. Copied
 * line for line from server.js lines 505-537 (identical in router.js apart
 * from comments) of the 2026-10-16 working tree. Delete it once Phase B
 * changes the numbers on purpose; after that this identity no longer holds.
 */
const { findBestPropertyMatch, dedupeComps } = require('../../lib/property-matching');
const { computeRecommendedRange, computeRawRange, exclusionReason } = require('../../lib/weighting');

function legacyNumbers({ rawComps, bedrooms, subject_property_type, properties }) {
  const matchedComps = rawComps.map(c => {
    const match = findBestPropertyMatch(c.address, properties);
    return { ...c, comp_property_id: match ? match.id : null, is_rincon_managed: !!match };
  });
  const compsWithMatch = dedupeComps(matchedComps, bedrooms, subject_property_type);
  const recommended = computeRecommendedRange(compsWithMatch, bedrooms, subject_property_type);
  const raw = computeRawRange(compsWithMatch, bedrooms, subject_property_type);
  const exclusionReasons = compsWithMatch.map(c => exclusionReason(c, bedrooms, subject_property_type));
  return { compsWithMatch, matchedCount: matchedComps.length, recommended, raw, exclusionReasons };
}

module.exports = { legacyNumbers };
