// Round 4 fix verification — the STALE RETURN VALUE bug in
// lib/revise.js's reviseContent(): the returned `contentItem` object was
// captured at update() time (step 4), BEFORE the legal-claim-detection/
// recompute step (step 6) runs, so the object handed back to the caller
// could report a stale content_items.legal_review_status even though the
// database's own column was correctly updated.
//
// Real Claude API + real Supabase throughout. Sets up a real content_item
// (linked to the real 'security-deposits' compliance topic) with an
// existing body that deliberately omits a specific, real, well-known 2025
// California law change (AB 2801's move-out photo-documentation
// requirement), then simulates a real "Request Changes" round asking for
// exactly that fact to be added with a source — nudging Pass 1 to use its
// "[LEGAL CLAIM PENDING REVIEW: ...]" allowance during the revision, same
// mechanism confirmed live in q-round4-stale-return-draft-test.js.
//
// Cleans up the created content_item afterward (cascades content_edits,
// content_item_topics, legal_claim_reviews).
require('dotenv').config({ path: '../../.env' });
const { select, insert } = require('./lib/supabase');
const { reviseContent } = require('./lib/revise');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECURITY_DEPOSITS_TOPIC_ID = '7754a1f5-bf88-4775-b992-6833ceacf788';

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
    const currentTitle = 'Q ROUND4 TEST — stale return value, reviseContent (DELETE ME)';
    const currentBody =
      'California caps a security deposit at one month\'s rent for an unfurnished unit and requires ' +
      'landlords to return it, or an itemized statement of deductions, within 21 days of move-out.';

    const [item] = await insert('content_items', {
      content_type: 'faq',
      title: currentTitle,
      body: currentBody,
      status: 'needs_changes',
    });
    contentItemId = item.id;
    console.log('Created test content_item', contentItemId);

    // Link the real security-deposits compliance topic so this revision
    // runs through the SAME hasTopics=true code path (and its
    // "[LEGAL CLAIM PENDING REVIEW: ...]" allowance) as the draftContent
    // test that already confirmed this mechanism works live.
    await insert('content_item_topics', {
      content_item_id: contentItemId,
      topic_id: SECURITY_DEPOSITS_TOPIC_ID,
    });

    // Simulate a real "Request Changes" round — this is exactly what
    // getFeedbackHistory() (lib/revise.js) queries for.
    await insert('content_edits', {
      content_item_id: contentItemId,
      edited_by: 'peter@rinconmanagement.com',
      field_changed: 'status',
      before_text: 'ready_for_review',
      after_text: 'needs_changes',
      edit_note:
        'This is missing a specific fact I need covered: California recently added a move-out photo-' +
        'documentation requirement for security deposits under AB 2801 (effective April 1, 2025). Please ' +
        'research and add that specific fact, naming your real source.',
    });

    const { contentItem } = await reviseContent({
      contentItemId,
      currentTitle,
      currentBody,
      revisedBy: 'Q ROUND4 TEST (AI revision)',
    });

    console.log('\nreviseContent() completed.');
    console.log('returned contentItem.legal_review_status:', contentItem.legal_review_status);

    const [freshRow] = await select(
      'content_items',
      `select=legal_review_status&id=eq.${contentItemId}`
    );
    console.log('fresh DB content_items.legal_review_status:', freshRow.legal_review_status);

    const claimRows = await select(
      'legal_claim_reviews',
      `select=id,claim_text,detected_by&content_item_id=eq.${contentItemId}`
    );
    console.log(`legal_claim_reviews rows written: ${claimRows.length}`);
    if (claimRows.length > 0) {
      console.log(JSON.stringify(claimRows, null, 2));
    }

    // The actual bug-fix assertion: the RETURNED object must match the
    // FRESH database value.
    assert(
      contentItem.legal_review_status === freshRow.legal_review_status,
      `returned contentItem.legal_review_status ("${contentItem.legal_review_status}") matches fresh DB value ("${freshRow.legal_review_status}")`
    );

    if (freshRow.legal_review_status !== 'not_required') {
      console.log(
        `\nPASS (meaningful case) — this run's legal_review_status ("${freshRow.legal_review_status}") ` +
          `differs from the pre-revision default ("not_required"), and the returned object correctly ` +
          `reflects it — this is exactly the case the stale-return bug would have gotten wrong.`
      );
    } else {
      console.log(
        '\nNOTE — this run did not produce any legal_claim_reviews row this time (Pass 1 did not use ' +
          'the bracket allowance), so legal_review_status stayed at "not_required" on both the object ' +
          'and the DB. The equality assertion above still holds, but this particular run does not by ' +
          'itself demonstrate the fix on a value that actually changed.'
      );
    }

    console.log('\nALL STALE-RETURN-VALUE (reviseContent) CHECKS PASSED.');
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
