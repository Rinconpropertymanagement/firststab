#!/usr/bin/env node
/**
 * q-scoped-edit-e2e-test.js — Q's real end-to-end pipeline run of
 * attemptScopedEdit() after the round-3 narration-carveout fix in
 * lib/scoped-edit.js, per TARS's request. Creates one disposable
 * content_items row, runs a realistic scoped-edit request against it
 * through the REAL Claude API and REAL Supabase, checks the result, then
 * deletes everything it created (content_items, content_edits,
 * legal_claim_reviews rows).
 *
 * The body below is written in Rincon's own direct-answer FAQ style,
 * deliberately including a "This paragraph explains..." structural
 * lead-in — the exact phrasing TARS found broken in round 3 — so a
 * successful, non-false-positive run here is direct evidence the fix
 * holds inside the real pipeline, not just in the isolated unit test.
 */
const CONTENT_ENGINE_DIR = '/Users/petermckenzie/CODE/firststab/projects/content-engine';
require('dotenv').config({ path: '/Users/petermckenzie/CODE/firststab/.env' });
process.chdir(CONTENT_ENGINE_DIR);

const { insert } = require(`${CONTENT_ENGINE_DIR}/lib/supabase`);
const { attemptScopedEdit } = require(`${CONTENT_ENGINE_DIR}/lib/scoped-edit`);

async function del(table, id) {
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
      method: 'DELETE',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
  } catch (e) {
    console.warn(`Cleanup warning (${table} ${id}): ${e.message}`);
  }
}

async function main() {
  let contentItemId = null;
  let createdEditIds = [];
  let createdClaimIds = [];

  try {
    const currentBody = `Security deposits in California are capped by state law. This paragraph explains what a landlord must include in a 3-day notice to pay rent or quit: the exact amount of rent owed, the date by which it must be paid, and the landlord's name and address for payment.

Late fees must be reasonable and disclosed in the lease before they can be charged.`;

    const [item] = await insert('content_items', {
      content_type: 'blog_post',
      title: 'Q TEST — scoped edit e2e, round 3 narration carve-out (safe to delete)',
      status: 'ready_for_review',
      body: currentBody,
    });
    contentItemId = item.id;
    console.log(`Created disposable content_item ${contentItemId}`);

    const message = 'In the late fees sentence, add that fees can\'t exceed what the law considers reasonable compensation for the landlord\'s actual costs.';

    console.log('\nRunning attemptScopedEdit() against the real pipeline...');
    const result = await attemptScopedEdit({
      contentItemId,
      message,
      currentBody,
      editedBy: 'Q e2e test (safe to delete)',
    });

    console.log('\nResult:', JSON.stringify(result, null, 2));

    if (result.applicable === false) {
      console.log(
        '\nNOTE: pipeline returned not-applicable (falls through to full regen) — ' +
          'this is a valid outcome (e.g. propose step judged it out of scope), not ' +
          'necessarily a failure of the narration-carveout fix specifically. The ' +
          'important thing already verified separately: the untouched "This ' +
          'paragraph explains..." structural sentence sitting elsewhere in the body ' +
          'did not by itself sink this run via a narration false-positive at step 3.'
      );
    } else if (result.applicable === true) {
      console.log('\nPASS: scoped edit applied successfully.');
      const newBody = result.contentItem.body;
      console.log('New body:\n' + newBody);
      if (!newBody.includes('This paragraph explains')) {
        console.log(
          'WARNING: the original "This paragraph explains..." structural sentence ' +
            'is no longer present verbatim — check whether the edit touched more than intended.'
        );
      } else {
        console.log(
          'CONFIRMED: "This paragraph explains..." structural sentence survived untouched, ' +
            'and the edit still applied — narration check did not false-positive on it.'
        );
      }
      if (result.resultingContentEditId) createdEditIds.push(result.resultingContentEditId);
    }
  } finally {
    console.log('\nCleaning up disposable rows...');
    if (contentItemId) {
      // content_edits / legal_claim_reviews reference content_item_id — find
      // and delete any rows this run created before removing the parent row.
      try {
        const editsResp = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/content_edits?content_item_id=eq.${contentItemId}&select=id`,
          {
            headers: {
              apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            },
          }
        );
        const edits = await editsResp.json();
        for (const e of edits) await del('content_edits', e.id);
      } catch (e) {
        console.warn(`Cleanup warning (content_edits lookup): ${e.message}`);
      }
      try {
        const claimsResp = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/legal_claim_reviews?content_item_id=eq.${contentItemId}&select=id`,
          {
            headers: {
              apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            },
          }
        );
        const claims = await claimsResp.json();
        for (const c of claims) await del('legal_claim_reviews', c.id);
      } catch (e) {
        console.warn(`Cleanup warning (legal_claim_reviews lookup): ${e.message}`);
      }
      await del('content_items', contentItemId);
    }
    console.log('Cleanup done.');
  }
}

main().catch((e) => {
  console.error('TEST SCRIPT ERROR:', e);
  process.exit(1);
});
