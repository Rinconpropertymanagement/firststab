require('dotenv').config({ path: '/Users/petermckenzie/CODE/firststab/.env' });
const { detectLegalClaims } = require('/Users/petermckenzie/CODE/firststab/projects/content-engine/lib/package-draft.js');

async function main() {
  // --- Test A: already-covered citation should NOT be flagged ---
  const groundingClaims = [
    {
      claim_key: 'ab1482-statewide-01',
      statement:
        'Under AB 1482, most California multifamily properties are subject to statewide rent increase caps and just-cause eviction protections.',
      status: 'OK',
    },
  ];
  const alreadyGroundedText =
    'Under AB 1482, most multifamily properties are subject to statewide rent caps.';
  const resultA = await detectLegalClaims(alreadyGroundedText, groundingClaims);
  console.log('--- Test A: already-covered AB 1482 citation ---');
  console.log('findings:', JSON.stringify(resultA, null, 2));
  console.log(
    resultA.length === 0
      ? 'PASS — correctly found nothing (already covered by grounding claim)'
      : 'FAIL — should have found nothing, found ' + resultA.length
  );

  // --- Test B: a DIFFERENT, uncovered citation should still be flagged ---
  const differentCitationText =
    'Under AB 1482, most multifamily properties are subject to statewide rent caps. Separately, SB 91 extended certain pandemic-era protections.';
  const resultB = await detectLegalClaims(differentCitationText, groundingClaims);
  console.log('\n--- Test B: AB 1482 (covered) + SB 91 (NOT covered) ---');
  console.log('findings:', JSON.stringify(resultB, null, 2));
  const foundSb91 = resultB.some((f) => f.claimText.includes('SB 91'));
  const foundAb1482 = resultB.some((f) => f.claimText.includes('AB 1482'));
  console.log(
    foundSb91 && !foundAb1482
      ? 'PASS — SB 91 flagged, AB 1482 correctly suppressed as already-covered'
      : `FAIL — foundSb91=${foundSb91}, foundAb1482=${foundAb1482}`
  );

  // --- Test C: informal phrasing, NO digit/citation pattern — Oracle's example ---
  // Should be caught ONLY by Layer 2 (ai_comprehension), not Layer 1.
  const informalText =
    'Here is the good news for landlords: after the recent change, landlords now have twice as long to expect a response from a tenant before they can move forward, which takes real pressure off the timeline.';
  const resultC = await detectLegalClaims(informalText, []);
  console.log('\n--- Test C: informal phrasing (Oracle\'s example) ---');
  console.log('findings:', JSON.stringify(resultC, null, 2));
  const aiFound = resultC.some((f) => f.detectedBy === 'ai_comprehension');
  const patternFound = resultC.some((f) => f.detectedBy === 'pattern_match');
  console.log(
    aiFound && !patternFound
      ? 'PASS — caught by ai_comprehension only, not pattern_match'
      : `RESULT — aiFound=${aiFound}, patternFound=${patternFound} (see findings above)`
  );

  // --- Test D: non-legal text — should find nothing at all ---
  const nonLegalText = `Ventura County single-family rentals are running $3,200-$4,500 a month right now.
For a home renting at $3,300 a month, every vacant day costs roughly $108 in rent you will never get back.
A vacancy is not a pause in your investment; it is an active daily drain on your returns.
Professional marketing, pricing discipline, and a ready pipeline of screened applicants keep turnover time down.`;
  const resultD = await detectLegalClaims(nonLegalText, []);
  console.log('\n--- Test D: non-legal market/business text ---');
  console.log('findings:', JSON.stringify(resultD, null, 2));
  console.log(
    resultD.length === 0
      ? 'PASS — correctly found nothing on non-legal text'
      : 'FAIL — should have found nothing, found ' + resultD.length
  );
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
