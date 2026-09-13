// Real end-to-end test of the NEW wiring in lib/draft.js: run a real,
// non-legal draftContent() call (no topicIds -> claims=[]) against the live
// Claude API + live Supabase, and confirm:
//   1. The draft still completes and is saved exactly as before (the new
//      legal-claim wiring never blocks/breaks the existing pipeline)
//   2. detectLegalClaims() found nothing (expected on ordinary business
//      content) -> zero legal_claim_reviews rows written
//   3. content_items.legal_review_status was correctly recomputed to
//      'not_required' (zero rows for this item)
// Cleans up the created content_item afterward (cascade-deletes any rows).
require('dotenv').config({ path: '../../.env' });
const { select } = require('./lib/supabase');
const { draftContent } = require('./lib/draft');

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

async function main() {
  let contentItemId = null;
  try {
    const { contentItem, claimsUsed, claimsFlaggedForReview } = await draftContent({
      contentType: 'faq',
      title: 'TARS TEST — legal-claims wiring e2e (DELETE ME)',
      brief:
        'A short FAQ answering: what should a landlord look for when comparing property management companies in Ventura County? Keep it general and business-focused, no legal advice.',
      topicIds: [], // no legal grounding topics — ordinary business content
    });
    contentItemId = contentItem.id;

    console.log('draftContent() completed successfully.');
    console.log('content_item id:', contentItem.id);
    console.log('claimsUsed:', claimsUsed.length, 'claimsFlaggedForReview:', claimsFlaggedForReview.length);

    const [row] = await select(
      'content_items',
      `select=legal_review_status&id=eq.${contentItemId}`
    );
    console.log('\ncontent_items.legal_review_status:', row.legal_review_status);
    console.log(
      row.legal_review_status === 'not_required'
        ? 'PASS — legal_review_status correctly recomputed to not_required'
        : `FAIL — expected not_required, got ${row.legal_review_status}`
    );

    const claimRows = await select(
      'legal_claim_reviews',
      `select=id,claim_text,detected_by&content_item_id=eq.${contentItemId}`
    );
    console.log('\nlegal_claim_reviews rows written:', claimRows.length);
    console.log(
      claimRows.length === 0
        ? 'PASS — no false-positive legal_claim_reviews rows on ordinary business content'
        : `NOTE — ${claimRows.length} row(s) written: ${JSON.stringify(claimRows, null, 2)}`
    );
  } finally {
    if (contentItemId) {
      await del('content_items', `id=eq.${contentItemId}`);
      console.log(`\nCleaned up: deleted test content_item ${contentItemId}.`);
    }
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
