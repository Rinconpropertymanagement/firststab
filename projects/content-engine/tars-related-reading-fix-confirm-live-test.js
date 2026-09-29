// TARS confirm-only re-test (2026-08-02) of the Related Reading leak fix in
// lib/revise.js's stripSourcesSectionForLegalScan(). This is an INDEPENDENT
// live re-run of my own originally confirmed repro — same scenario shape
// (Related Reading section, citation-shaped title, sitting immediately
// before a real Sources bibliography, real grounded AB 1482 draft, real
// reviseContent() call) but with a DIFFERENT injected title/city/ordinance
// than Q's own q-bug2-related-reading-scan-live-test.js used, so this isn't
// just re-running Q's exact script — it confirms the fix generalizes.
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

// Deliberately DIFFERENT from Q's test's "Understanding Oxnard's Ordinance
// No. 9042 Move-In Fee Rules" — different city, different ordinance number,
// different phrasing — to confirm the fix isn't somehow keyed to that exact
// string.
const RELATED_READING_TITLE = "Thousand Oaks Ordinance No. 1284 Late Rent Fee Limits Explained";

async function main() {
  let contentItemId = null;
  try {
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
      title: 'TARS CONFIRM TEST — Related Reading leak re-test (DELETE ME)',
      brief:
        'A short FAQ answering: what rent-increase limits apply to a Ventura County landlord under AB 1482, and does a landlord need to give written notice before raising rent?',
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

    // Inject a "## Related Reading" section immediately before "## Sources"
    // — the real canonical position, same as production round-N+1 bodies.
    const sourcesHeadingIndex = contentItem.body.search(/^##[ \t]*Sources[ \t]*$/im);
    const relatedReadingSection =
      `## Related Reading\n\n- [${RELATED_READING_TITLE}](https://rinconmanagement.com/blog/thousand-oaks-ordinance-1284)\n\n`;
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
    console.log('\n--- ORIGINAL "## Sources" section (must never leak into new findings either — Bug 1 regression check) ---');
    console.log(originalSourcesSectionText);

    await insert('content_edits', {
      content_item_id: contentItemId,
      edited_by: 'peter@rinconmanagement.com',
      field_changed: 'status',
      before_text: 'draft',
      after_text: 'needs_changes',
      edit_note: 'Can you make the second paragraph a bit shorter? Otherwise this looks good.',
    });
    console.log('\nInserted "Request Changes" feedback.');

    const { contentItem: revisedItem } = await reviseContent({
      contentItemId,
      currentTitle: contentItem.title,
      currentBody: bodyWithRelatedReading,
      revisedBy: 'TARS CONFIRM TEST (Related Reading re-test)',
    });
    console.log(`\nreviseContent() completed. Revised body length: ${revisedItem.body.length}`);

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
      `zero legal_claim_reviews rows were lifted verbatim from the "## Sources" bibliography (found ${leakedFromBibliography.length}) — Bug 1 regression check`
    );

    console.log('\nALL LIVE RE-TEST CHECKS PASSED.');
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
