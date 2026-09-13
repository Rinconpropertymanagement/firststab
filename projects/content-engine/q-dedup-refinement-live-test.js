// Live DB test for the dedup refinement (TARS, 2026-08-02): a
// legal_claim_reviews row with peter_decision='removed_from_draft' must be
// EXCLUDED from filterNewLegalClaimFindings()'s dedup set, so that exact
// wording reappearing in a later revision round gets a fresh row and a
// fresh, unresolved legal_review_status — instead of silently reading
// 'cleared' while a previously-rejected claim has slipped back in
// unreviewed. Confirms the other three peter_decision states (pending null,
// approved_as_is, consulting_attorney) still dedup as before — TARS
// confirmed those are fine to keep deduping against.
require('dotenv').config({ path: '../../.env' });
const { select, insert } = require('./lib/supabase');
const { filterNewLegalClaimFindings, recomputeLegalReviewStatus } = require('./lib/legal-review');

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
    const [item] = await insert('content_items', {
      content_type: 'faq',
      title: 'Q TEST — dedup refinement, removed_from_draft re-flagging (DELETE ME)',
      body: 'placeholder',
      status: 'draft',
    });
    contentItemId = item.id;
    console.log(`Created test content_item ${contentItemId}\n`);

    // --- Part 1: mixed peter_decision states, confirm ONLY removed_from_draft
    // is excluded from the dedup set ---
    const rows = {
      rejected: {
        claim_text: 'Landlords must pay $5,000 in relocation assistance under Ordinance 9999.',
        peter_decision: 'removed_from_draft',
      },
      approved: {
        claim_text: 'AB 1482 caps annual rent increases at 5% plus CPI, or 10%, whichever is lower.',
        peter_decision: 'approved_as_is',
      },
      approvedEdited: {
        claim_text: 'Security deposits must be returned within 21 days of move-out.',
        peter_decision: 'approved_with_edit',
      },
      consulting: {
        claim_text: 'Ordinance 3012 requires just-cause eviction protections in Oxnard.',
        peter_decision: 'consulting_attorney',
      },
      pending: {
        claim_text: 'Civil Code section 1950.5 requires photo documentation of unit condition.',
        peter_decision: null,
      },
    };

    for (const key of Object.keys(rows)) {
      const r = rows[key];
      const insertPayload = {
        content_item_id: contentItemId,
        claim_text: r.claim_text,
        claim_context: r.claim_text,
        source_url: '(test)',
        jurisdiction_scope: 'unknown',
        detected_by: 'pattern_match',
      };
      if (r.peter_decision) {
        insertPayload.peter_decision = r.peter_decision;
        insertPayload.decided_by = 'peter@rinconmanagement.com';
        insertPayload.decided_at = new Date().toISOString();
        if (r.peter_decision === 'approved_with_edit') {
          insertPayload.peter_edited_text = r.claim_text; // CHECK constraint requires this to be set
        }
      }
      await insert('legal_claim_reviews', insertPayload);
    }
    console.log('Inserted 5 legal_claim_reviews rows: rejected, approved, approvedEdited, consulting, pending.\n');

    // Candidates: exact same wording as every existing row above, PLUS one
    // genuinely new claim.
    const candidates = [
      { claimText: rows.rejected.claim_text },
      { claimText: rows.approved.claim_text },
      { claimText: rows.approvedEdited.claim_text },
      { claimText: rows.consulting.claim_text },
      { claimText: rows.pending.claim_text },
      { claimText: 'A genuinely new claim never seen before on this item.' },
    ];
    const filtered = await filterNewLegalClaimFindings(contentItemId, candidates);
    const filteredTexts = filtered.map((c) => c.claimText);
    console.log('Candidates surviving the dedup filter:', JSON.stringify(filteredTexts, null, 2));

    assert(
      filteredTexts.includes(rows.rejected.claim_text),
      'a REJECTED (removed_from_draft) claim reappearing verbatim IS treated as new and survives the dedup filter'
    );
    assert(
      !filteredTexts.includes(rows.approved.claim_text),
      'an approved_as_is claim reappearing verbatim is STILL deduped (filtered out)'
    );
    assert(
      !filteredTexts.includes(rows.approvedEdited.claim_text),
      'an approved_with_edit claim reappearing verbatim is STILL deduped (filtered out)'
    );
    assert(
      !filteredTexts.includes(rows.consulting.claim_text),
      'a consulting_attorney (unresolved) claim reappearing verbatim is STILL deduped (filtered out)'
    );
    assert(
      !filteredTexts.includes(rows.pending.claim_text),
      'a pending (null decision) claim reappearing verbatim is STILL deduped (filtered out)'
    );
    assert(
      filteredTexts.includes('A genuinely new claim never seen before on this item.'),
      'a genuinely new claim (no existing row at all) survives the dedup filter'
    );
    assert(filtered.length === 2, `exactly 2 candidates survive (rejected + genuinely-new) — got ${filtered.length}`);

    // --- Part 2: full lifecycle — insert the re-flagged row for real, and
    // confirm legal_review_status flips from 'cleared' back to
    // 'needs_review' even though every OTHER row is resolved. ---
    console.log('\n--- Part 2: full lifecycle check ---');
    // Resolve every row except the freshly-surviving rejected claim first,
    // so we start from a 'cleared' baseline (every row resolved).
    const statusBefore = await recomputeLegalReviewStatus(contentItemId);
    console.log(`Status with the original 5 rows (1 unresolved: pending) : ${statusBefore}`);
    assert(statusBefore === 'needs_review', `baseline is needs_review because the 'pending' row is still unresolved (got ${statusBefore})`);

    // Resolve the pending row AND the consulting_attorney row — both are
    // currently unresolved (consulting_attorney is deliberately treated as
    // unresolved per the migration's own rule: it's a flag review is in
    // flight, not a verdict), so both need a real decision before the item
    // can legitimately read 'cleared'.
    const { update } = require('./lib/supabase');
    await update(
      'legal_claim_reviews',
      `content_item_id=eq.${contentItemId}&claim_text=eq.${encodeURIComponent(rows.pending.claim_text)}`,
      { peter_decision: 'approved_as_is', decided_by: 'peter@rinconmanagement.com', decided_at: new Date().toISOString() }
    );
    await update(
      'legal_claim_reviews',
      `content_item_id=eq.${contentItemId}&claim_text=eq.${encodeURIComponent(rows.consulting.claim_text)}`,
      { peter_decision: 'approved_as_is', decided_by: 'peter@rinconmanagement.com', decided_at: new Date().toISOString() }
    );
    const statusAllResolved = await recomputeLegalReviewStatus(contentItemId);
    assert(statusAllResolved === 'cleared', `all existing rows now resolved -> 'cleared' (got ${statusAllResolved})`);

    // Now simulate a new revision round where the REJECTED claim's exact
    // wording reappears — this is the real-world trigger for the bug.
    const newFindings = await filterNewLegalClaimFindings(contentItemId, [
      { claimText: rows.rejected.claim_text, context: rows.rejected.claim_text, detectedBy: 'pattern_match', sourceUrl: null },
    ]);
    assert(newFindings.length === 1, 'the rejected claim reappearing produces exactly one new candidate to insert');

    await insert(
      'legal_claim_reviews',
      newFindings.map((f) => ({
        content_item_id: contentItemId,
        claim_text: f.claimText,
        claim_context: f.context,
        source_url: '(test)',
        jurisdiction_scope: 'unknown',
        detected_by: f.detectedBy,
      }))
    );
    const statusAfterReappearance = await recomputeLegalReviewStatus(contentItemId);
    assert(
      statusAfterReappearance === 'needs_review',
      `content_items.legal_review_status correctly flips back to 'needs_review' after the rejected claim reappears and gets a fresh row (got ${statusAfterReappearance})`
    );

    const [statusRow] = await select('content_items', `select=legal_review_status&id=eq.${contentItemId}`);
    assert(
      statusRow.legal_review_status === 'needs_review',
      'content_items.legal_review_status column itself was actually written as needs_review, not silently left as cleared'
    );

    console.log('\nALL DEDUP REFINEMENT LIVE TESTS PASSED.');
  } finally {
    if (contentItemId) {
      await del('content_items', `id=eq.${contentItemId}`);
      console.log(`\nCleaned up: deleted test content_item ${contentItemId} (cascade-deleted its legal_claim_reviews rows).`);
    }
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
