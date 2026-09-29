// Real end-to-end test: a properly GROUNDED legal-topic draftContent() call
// (real compliance_claims, same pattern as tars-legal-sanity-test.js), to
// confirm detectLegalClaims() does NOT false-positive on legal content that
// correctly cites its own pre-approved grounding claims — the highest-risk
// case for this feature (a noisy false positive on every single legal post
// would make the review queue useless).
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
    const claims = await select(
      'compliance_claims',
      'select=id,claim_key,topic_id,statement,status&status=eq.OK&limit=5'
    );
    if (claims.length === 0) {
      console.log('No VERIFIED compliance_claims found — cannot run this test.');
      process.exit(1);
    }
    console.log('Using claims:', JSON.stringify(claims.map((c) => c.claim_key)));
    const topicIds = [...new Set(claims.map((c) => c.topic_id).filter(Boolean))];

    const { contentItem, claimsUsed, claimsFlaggedForReview } = await draftContent({
      contentType: 'faq',
      title: 'TARS TEST — legal-claims wiring, grounded legal topic (DELETE ME)',
      brief:
        'A short FAQ answering: how much can a landlord charge for a security deposit in California, and when must it be returned?',
      topicIds,
    });
    contentItemId = contentItem.id;

    console.log('\ndraftContent() completed successfully.');
    console.log('content_item id:', contentItem.id);
    console.log('claimsUsed:', JSON.stringify(claimsUsed.map((c) => c.claim_key)));
    console.log('claimsFlaggedForReview:', JSON.stringify(claimsFlaggedForReview.map((c) => c.claim_key)));

    const [row] = await select('content_items', `select=legal_review_status&id=eq.${contentItemId}`);
    console.log('\ncontent_items.legal_review_status:', row.legal_review_status);

    const claimRows = await select(
      'legal_claim_reviews',
      `select=id,claim_text,claim_context,detected_by,source_url&content_item_id=eq.${contentItemId}`
    );
    console.log(`\nlegal_claim_reviews rows written: ${claimRows.length}`);
    if (claimRows.length > 0) {
      console.log(JSON.stringify(claimRows, null, 2));
      console.log(
        '\nReview each row above by hand: is it a GENUINE new/ungrounded fact, or should it have ' +
          'matched one of claimsUsed and been suppressed? (Not necessarily a failure either way — ' +
          'see report.)'
      );
    } else {
      console.log('PASS — properly-grounded legal content produced zero false-positive findings.');
    }
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
