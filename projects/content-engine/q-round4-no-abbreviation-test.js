// Round 4 fix verification — lib/package-draft.js's
// splitIntoSentenceLikeChunks() / buildSentenceSplitRegex() "No." handling.
//
// TARS found that adding "No" to SENTENCE_BOUNDARY_ABBREVIATIONS (for
// "Ordinance No. 3012"-style citations) also suppressed the split on a
// genuine standalone English sentence "No." — e.g. "Can a landlord charge
// for ordinary carpet wear? No. State law treats that as normal
// depreciation..." merged into one chunk instead of splitting after "No.".
// That's exactly the run-on-widening mechanism behind the primary
// legal-review coverage bug fixed in lib/legal-review.js this same round.
//
// Pure function test — no AI calls, no database. Just requires
// splitIntoSentenceLikeChunks() and checks chunk boundaries directly.
const { splitIntoSentenceLikeChunks } = require('./lib/package-draft');

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`PASS — ${message}`);
}

function main() {
  // ================================================================
  // CASE 1 — citation shape: "Ordinance No. 3012" must NOT split (the
  // original reason "No" was added to the abbreviation list at all).
  // ================================================================
  {
    const text = 'This is governed by Ordinance No. 3012 of the city code. A separate rule applies to commercial units.';
    const chunks = splitIntoSentenceLikeChunks(text);
    assert(
      chunks.length === 2,
      `CASE 1 (citation, "No. 3012"): text splits into exactly 2 real sentences, not 3 (got ${chunks.length}): ${JSON.stringify(chunks)}`
    );
    assert(
      chunks[0] === 'This is governed by Ordinance No. 3012 of the city code.',
      `CASE 1: first chunk keeps "Ordinance No. 3012" intact, not split after "No." (got: "${chunks[0]}")`
    );
  }

  // ================================================================
  // CASE 2 — real sentence-ending "No.": TARS's exact example. There are
  // actually THREE real sentences here ("...wear?", "No.", "State law
  // treats..."), and the fix must recover all three — both the
  // "wear?"|"No." boundary (which already worked pre-fix, since the text
  // immediately before that boundary is "wear?", not "No.") AND the
  // "No."|"State" boundary (which is what this fix actually repairs: the
  // old code merged "No." into the following sentence).
  // ================================================================
  {
    const text = 'Can a landlord charge for ordinary carpet wear? No. State law treats that as normal depreciation and the landlord must absorb the cost.';
    const chunks = splitIntoSentenceLikeChunks(text);
    assert(
      chunks.length === 3,
      `CASE 2 (real sentence "No."): splits into exactly 3 chunks — the question, "No.", and "State law treats..." (got ${chunks.length}): ${JSON.stringify(chunks)}`
    );
    if (chunks.length === 3) {
      assert(
        chunks[0] === 'Can a landlord charge for ordinary carpet wear?',
        `CASE 2: first chunk is just the question (got: "${chunks[0]}")`
      );
      assert(chunks[1] === 'No.', `CASE 2: second chunk is exactly "No." on its own (got: "${chunks[1]}")`);
      assert(
        chunks[2].startsWith('State law treats'),
        `CASE 2: third chunk starts with "State law treats..." — no longer merged onto "No." (got: "${chunks[2]}")`
      );
    }
  }

  // ================================================================
  // CASE 3 — a FOURTH sentence after the "No." one, to make sure the split
  // isn't just working by accident at end-of-string.
  // ================================================================
  {
    const text = 'Is the deposit refundable? No. It becomes non-refundable once the lease is signed. Ask before signing.';
    const chunks = splitIntoSentenceLikeChunks(text);
    assert(
      chunks.length === 4,
      `CASE 3 (four real sentences incl. standalone "No."): splits into exactly 4 chunks (got ${chunks.length}): ${JSON.stringify(chunks)}`
    );
  }

  // ================================================================
  // CASE 4 — regression: other abbreviations in the list must still work
  // unconditionally (e.g. "Gov. Code", "Civ. Code" — "Proc" is NOT in
  // SENTENCE_BOUNDARY_ABBREVIATIONS, a separate pre-existing gap unrelated
  // to this fix, so deliberately not used here).
  // ================================================================
  {
    const text = 'This is required under Gov. Code section 12345. A separate notice period applies under Civ. Code section 1161.';
    const chunks = splitIntoSentenceLikeChunks(text);
    assert(
      chunks.length === 2,
      `CASE 4 (regression — Gov./Civ. abbreviations still suppress split unconditionally): got ${chunks.length} chunks: ${JSON.stringify(chunks)}`
    );
  }

  // ================================================================
  // CASE 5 — lowercase "no" (not a sentence-ending abbreviation candidate
  // at all — regex is case-sensitive on "No") must not be affected either
  // way; sanity check that ordinary text still splits normally.
  // ================================================================
  {
    const text = 'There is no grace period for rent. Payment is due on the 1st.';
    const chunks = splitIntoSentenceLikeChunks(text);
    assert(
      chunks.length === 2,
      `CASE 5 (ordinary text, lowercase "no" mid-sentence): unaffected, splits normally (got ${chunks.length}): ${JSON.stringify(chunks)}`
    );
  }

  console.log('\nALL ROUND 4 "No." ABBREVIATION TESTS PASSED.');
}

main();
