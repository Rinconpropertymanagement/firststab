// Live end-to-end test for the Bug 2 fix (Q, 2026-08-02, extending TARS's
// round 3 finding): a revision round on a legal-topic article that already
// has a "## Related Reading" section (from a PRIOR round) sitting BEFORE its
// "## Sources" bibliography must NOT flag a citation-shaped Related Reading
// link TITLE as a "new" legal claim. Reproduces TARS's exact confirmed live
// scenario against the real Claude API + real Supabase:
//   1. Draft a real, grounded legal-topic article (real AB 1482 compliance
//      claims) via draftContent() -> produces a real body + "## Sources"
//      section.
//   2. Simulate what a PRIOR revision round's real
//      insertRelatedReadingAndSourcesSections() post-processing would have
//      stored: a "## Related Reading" section, in the real canonical
//      position (immediately before "## Sources" — see that function's own
//      comment in lib/seo.js), containing a real internal-link-shaped bullet
//      whose TITLE is citation-shaped: "Understanding Oxnard's Ordinance No.
//      9042 Move-In Fee Rules" — TARS's own confirmed repro title. Written
//      directly to content_items.body via a real Supabase update (this is
//      exactly what round N's stored body looks like walking into round
//      N+1 — draftContent() itself doesn't reliably produce a Related
//      Reading section on a fresh single-article draft, since that requires
//      OTHER already-published candidates for the model to pick from).
//   3. Leave real "Request Changes" feedback via content_edits.
//   4. Run reviseContent() for real — this is the exact path where Pass 1 is
//      handed the OLD body (Related Reading + Sources both included) and
//      naturally preserves it while rewriting, and detectLegalClaims() runs
//      on that body BEFORE this round's own
//      insertRelatedReadingAndSourcesSections() call rebuilds both sections.
//   5. Assert: no legal_claim_reviews row created by this revision has
//      claim_text that is a substring of the injected "## Related Reading"
//      section — i.e. the ordinance-numbered post title never got flagged.
// Also re-confirms the original Bug 1 invariant (nothing from "## Sources"
// leaks either) in the same run, since both sections are present here
// together — the exact combined shape production bodies actually have.
// Cleans up the created content_item afterward (cascade-deletes everything
// else this test created).
require('dotenv').config({ path: '../../.env' });
const { select, insert, update } = require('./lib/supabase');
const { draftContent } = require('./lib/draft');
const { reviseContent } = require('./lib/revise');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function del(table, filter) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`delete from ${table} failed (${res.status}): ${await res.text()}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`PASS — ${message}`);
}

const RELATED_READING_TITLE = "Understanding Oxnard's Ordinance No. 9042 Move-In Fee Rules";

async function main() {
  let contentItemId = null;
  try {
    // 1. Real grounded draft — same AB 1482 claim set TARS's own grounded
    // e2e test and the Bug 1 test used.
    const claims = await select(
      'compliance_claims',
      'select=id,claim_key,topic_id,statement,status&status=eq.OK&limit=5'
    );
    if (claims.length === 0) {
      console.log('No VERIFIED compliance_claims found — cannot run this test.');
      process.exit(1);
    }
    const topicIds = [...new Set(claims.map((c) => c.topic_id).filter(Boolean))];
    const topics = await select(
      'compliance_topics',
      `select=id,topic_key&id=in.(${topicIds.join(',')})`
    );
    const topicKeywords = topics.map((t) => t.topic_key);
    console.log('Using topicKeywords:', JSON.stringify(topicKeywords));

    const { contentItem } = await draftContent({
      contentType: 'faq',
      title: 'Q TEST — Bug 2 Related-Reading-before-Sources scan fix (DELETE ME)',
      brief:
        'A short FAQ answering: what rent-increase limits apply to a Ventura County landlord under AB 1482, and does Oxnard have any additional local rules?',
      topicKeywords,
    });
    contentItemId = contentItem.id;
    console.log(`Created draft content_item ${contentItemId}`);

    const hasSourcesSection = /^##[ \t]*Sources[ \t]*$/im.test(contentItem.body);
    if (!hasSourcesSection) {
      console.log(contentItem.body);
      throw new Error(
        'the draft did not produce a "## Sources" section, so this run cannot exercise the bug scenario — see body logged above'
      );
    }

    // 2. Inject a "## Related Reading" section immediately before "##
    // Sources" — the real canonical position
    // insertRelatedReadingAndSourcesSections() always writes both sections
    // in (see lib/seo.js) — simulating what a prior round's real
    // post-processing would have stored.
    const sourcesHeadingIndex = contentItem.body.search(/^##[ \t]*Sources[ \t]*$/im);
    const relatedReadingSection =
      `## Related Reading\n\n- [${RELATED_READING_TITLE}](https://rinconmanagement.com/blog/oxnard-ordinance-9042-move-in-fees)\n\n`;
    const bodyWithRelatedReading =
      contentItem.body.slice(0, sourcesHeadingIndex) +
      relatedReadingSection +
      contentItem.body.slice(sourcesHeadingIndex);

    await update('content_items', `id=eq.${contentItemId}`, { body: bodyWithRelatedReading });
    console.log('\nInjected "## Related Reading" section ahead of "## Sources" and saved to Supabase.');

    const injectedRelatedReadingSectionText = relatedReadingSection.trim();
    console.log('\n--- INJECTED "## Related Reading" section (must never leak into new findings) ---');
    console.log(injectedRelatedReadingSectionText);

    const originalSourcesSectionText = contentItem.body.slice(sourcesHeadingIndex);
    console.log('\n--- ORIGINAL "## Sources" section (must never leak into new findings either) ---');
    console.log(originalSourcesSectionText);

    // 3. Real "Request Changes" feedback, exactly the shape getFeedbackHistory()
    // reads (field_changed='status', after_text='needs_changes').
    await insert('content_edits', {
      content_item_id: contentItemId,
      edited_by: 'peter@rinconmanagement.com',
      field_changed: 'status',
      before_text: 'draft',
      after_text: 'needs_changes',
      edit_note:
        'Please tighten the intro paragraph — get to the direct answer faster. Everything else looks good, keep it.',
    });
    console.log('\nInserted "Request Changes" feedback.');

    // 4. Real revision round — this is the exact path Bug 2 lives in.
    const { contentItem: revisedItem } = await reviseContent({
      contentItemId,
      currentTitle: contentItem.title,
      currentBody: bodyWithRelatedReading,
      revisedBy: 'Q TEST (Bug 2 verification)',
    });
    console.log(`\nreviseContent() completed. Revised body length: ${revisedItem.body.length}`);

    // 5. Check what legal_claim_reviews rows this revision wrote, and
    // confirm none of them are text lifted from the injected Related
    // Reading section OR the original Sources section.
    const claimRows = await select(
      'legal_claim_reviews',
      `select=id,claim_text,claim_context,detected_by&content_item_id=eq.${contentItemId}`
    );
    console.log(`\nlegal_claim_reviews rows after revision: ${claimRows.length}`);
    claimRows.forEach((r, i) => {
      console.log(`  ${i + 1}. [${r.detected_by}] ${r.claim_text}`);
    });

    const leakedFromRelatedReading = claimRows.filter(
      (r) =>
        r.claim_text &&
        (injectedRelatedReadingSectionText.includes(r.claim_text) || r.claim_text.includes(RELATED_READING_TITLE))
    );
    assert(
      leakedFromRelatedReading.length === 0,
      `zero legal_claim_reviews rows were lifted from the injected "## Related Reading" section (found ${leakedFromRelatedReading.length})`
    );

    const leakedFromBibliography = claimRows.filter(
      (r) => r.claim_text && originalSourcesSectionText.includes(r.claim_text)
    );
    assert(
      leakedFromBibliography.length === 0,
      `zero legal_claim_reviews rows were lifted verbatim from the "## Sources" bibliography (found ${leakedFromBibliography.length}) — no regression on the original Bug 1 fix`
    );

    console.log('\nALL BUG 2 LIVE TESTS PASSED.');
  } finally {
    if (contentItemId) {
      await del('content_items', `id=eq.${contentItemId}`);
      console.log(`\nCleaned up: deleted test content_item ${contentItemId} (cascades to content_edits, legal_claim_reviews, content_item_compliance_claims, content_item_topics).`);
    }
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
