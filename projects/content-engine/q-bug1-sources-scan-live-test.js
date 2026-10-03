// Live end-to-end test for the Bug 1 fix (TARS, 2026-08-02): a revision
// round on a legal-topic article that already has a "## Sources"
// bibliography must NOT flag the bibliography's own citation strings as
// "new" legal claims. Reproduces TARS's exact scenario against the real
// Claude API + real Supabase:
//   1. Draft a real, grounded legal-topic article (real AB 1482 compliance
//      claims) via draftContent() -> produces a real "## Sources" section.
//   2. Leave real "Request Changes" feedback via content_edits.
//   3. Run reviseContent() for real — this is the exact path where Pass 1
//      is handed the OLD body (Sources section included) and naturally
//      preserves it while rewriting, and detectLegalClaims() used to run on
//      that unstripped text.
//   4. Assert: no legal_claim_reviews row created by this revision has
//      claim_text that is a substring of the ORIGINAL body's "## Sources"
//      section — i.e. nothing lifted verbatim from the old bibliography got
//      flagged as a new claim.
// Cleans up the created content_item afterward (cascade-deletes everything
// else this test created).
require('dotenv').config({ path: '../../.env' });
const { select, insert } = require('./lib/supabase');
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

async function main() {
  let contentItemId = null;
  try {
    // 1. Real grounded draft — same AB 1482 claim set TARS's own grounded
    // e2e test used, so this reliably produces real citation-heavy content
    // and a real "## Sources" bibliography.
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
    // draftContent() takes topicKeywords (topic_key STRINGS matched against
    // compliance_topics.topic_key via getGroundingClaims()), not topic_id
    // UUIDs — confirmed by reading lib/draft.js's own signature. Passing
    // topicIds (as tars-legal-wiring-grounded-e2e-test.js does) is silently
    // ignored by the destructuring and falls through to the ungrounded
    // (hasTopics=false) path, which is NOT the scenario this test needs.
    const topicKeywords = topics.map((t) => t.topic_key);
    console.log('Using topicKeywords:', JSON.stringify(topicKeywords));

    const { contentItem } = await draftContent({
      contentType: 'faq',
      title: 'Q TEST — Bug 1 Sources-bibliography scan fix (DELETE ME)',
      brief:
        'A short FAQ answering: what rent-increase limits apply to a Ventura County landlord under AB 1482, and does Oxnard have any additional local rules?',
      topicKeywords,
    });
    contentItemId = contentItem.id;
    console.log(`Created draft content_item ${contentItemId}`);
    console.log(`Original body length: ${contentItem.body.length}`);

    const hasSourcesSection = /^##[ \t]*Sources[ \t]*$/im.test(contentItem.body);
    console.log(`Original body has a "## Sources" heading: ${hasSourcesSection}`);
    if (!hasSourcesSection) {
      // throw, not process.exit() — process.exit() skips the finally block
      // below and leaks the just-created test content_item (confirmed: this
      // happened on this test's first real run).
      console.log(contentItem.body);
      throw new Error(
        'the draft did not produce a "## Sources" section, so this run cannot exercise the bug scenario — see body logged above'
      );
    }

    const sourcesHeadingIndex = contentItem.body.search(/^##[ \t]*Sources[ \t]*$/im);
    const originalSourcesSectionText = contentItem.body.slice(sourcesHeadingIndex);
    console.log('\n--- ORIGINAL "## Sources" section (must never leak into new findings) ---');
    console.log(originalSourcesSectionText);

    // 2. Real "Request Changes" feedback, exactly the shape getFeedbackHistory()
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

    // 3. Real revision round — this is the exact path Bug 1 lives in.
    const { contentItem: revisedItem } = await reviseContent({
      contentItemId,
      currentTitle: contentItem.title,
      currentBody: contentItem.body,
      revisedBy: 'Q TEST (Bug 1 verification)',
    });
    console.log(`\nreviseContent() completed. Revised body length: ${revisedItem.body.length}`);

    // 4. Check what legal_claim_reviews rows this revision wrote, and
    // confirm none of them are text lifted from the ORIGINAL Sources section.
    const claimRows = await select(
      'legal_claim_reviews',
      `select=id,claim_text,claim_context,detected_by&content_item_id=eq.${contentItemId}`
    );
    console.log(`\nlegal_claim_reviews rows after revision: ${claimRows.length}`);
    claimRows.forEach((r, i) => {
      console.log(`  ${i + 1}. [${r.detected_by}] ${r.claim_text}`);
    });

    const leakedFromBibliography = claimRows.filter(
      (r) => r.claim_text && originalSourcesSectionText.includes(r.claim_text)
    );
    assert(
      leakedFromBibliography.length === 0,
      `zero legal_claim_reviews rows were lifted verbatim from the OLD "## Sources" bibliography (found ${leakedFromBibliography.length})`
    );

    console.log('\nALL BUG 1 LIVE TESTS PASSED.');
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
