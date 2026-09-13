// TARS confirm-only re-test (2026-08-02): pure-function check of
// stripSourcesSectionForLegalScan() in lib/revise.js, independent of Q's own
// q-bug2-related-reading-scan-live-test.js. No API calls, no Supabase writes
// — exercises the exported helper directly against several body shapes to
// confirm the fix (cut at whichever of "## Related Reading" / "## Sources"
// comes first) holds generally, not just for the one exact repro string
// already covered by Q's live test.
const { stripSourcesSectionForLegalScan } = require('./lib/revise');

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`PASS — ${message}`);
}

// Case 1: my original confirmed repro shape — Related Reading (citation-
// shaped title, DIFFERENT ordinance/city than Q's test used) immediately
// before Sources, both present. Real canonical order
// insertRelatedReadingAndSourcesSections() writes.
{
  const prose = 'Landlords in Ventura County must comply with AB 1482 rent caps.\n\n';
  const relatedReading =
    '## Related Reading\n\n- [Camarillo Ordinance No. 1177 Security Deposit Rules](https://rinconmanagement.com/blog/camarillo-ordinance-1177)\n\n';
  const sources =
    '## Sources\n\n- [Civil Code § 1950.5](https://leginfo.legislature.ca.gov/civ-1950.5 "AI-SUGGESTED SOURCE")\n';
  const body = prose + relatedReading + sources;

  const stripped = stripSourcesSectionForLegalScan(body);
  assert(stripped === prose, 'Case 1 (Related Reading before Sources): strips to exactly the prose, nothing more');
  assert(!stripped.includes('Camarillo Ordinance'), 'Case 1: Related Reading citation-shaped title is gone from scanned text');
  assert(!stripped.includes('Civil Code'), 'Case 1: Sources bibliography is gone from scanned text');
}

// Case 2: Bug 1 regression — Sources only, no Related Reading section at all.
{
  const prose = 'Tenants must receive 24 hours notice before entry.\n\n';
  const sources = '## Sources\n\n- [Civil Code § 1954](https://leginfo.legislature.ca.gov/civ-1954 "AI-SUGGESTED SOURCE")\n';
  const body = prose + sources;

  const stripped = stripSourcesSectionForLegalScan(body);
  assert(stripped === prose, 'Case 2 (Sources only, no regression): strips to exactly the prose');
}

// Case 3: fail-safe — neither heading present (first-ever revision round).
{
  const body = 'Just plain article prose with no sections at all.';
  const stripped = stripSourcesSectionForLegalScan(body);
  assert(stripped === body, 'Case 3 (neither heading present): body returned completely unchanged');
}

// Case 4: Related Reading present with NO Sources section yet (edge case not
// covered by either Q's test or the original repro — worth checking since
// the fix takes Math.min() of whichever indexes are actually found).
{
  const prose = 'Short answer about rent control.\n\n';
  const relatedReading =
    '## Related Reading\n\n- [Understanding Ordinance No. 9042 Move-In Fee Rules](https://rinconmanagement.com/blog/x)\n\n';
  const body = prose + relatedReading;

  const stripped = stripSourcesSectionForLegalScan(body);
  assert(stripped === prose, 'Case 4 (Related Reading only, no Sources yet): strips to exactly the prose');
}

// Case 5: defensive — headings in the WRONG order (Sources before Related
// Reading). Never happens in production per insertRelatedReadingAndSourcesSections()'s
// own canonical ordering, but the fix is documented as taking Math.min() of
// both regardless of order, not assuming the canonical one — confirm that
// claim holds.
{
  const prose = 'Prose paragraph.\n\n';
  const sources = '## Sources\n\n- [Civil Code § 1946.2](https://leginfo.legislature.ca.gov/civ-1946.2 "AI-SUGGESTED SOURCE")\n\n';
  const relatedReading = '## Related Reading\n\n- [Ordinance No. 200 Late Fee Caps](https://rinconmanagement.com/blog/y)\n';
  const body = prose + sources + relatedReading;

  const stripped = stripSourcesSectionForLegalScan(body);
  assert(stripped === prose, 'Case 5 (reversed heading order): still cuts at the earliest heading found, not just Sources');
}

console.log('\nALL UNIT-LEVEL CHECKS PASSED.');
