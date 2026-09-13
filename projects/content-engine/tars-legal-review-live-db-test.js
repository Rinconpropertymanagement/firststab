// Real live-database test of lib/legal-review.js — recomputeLegalReviewStatus()
// and filterNewLegalClaimFindings() — against the now-applied
// supabase/migrations/20260801000000_legal_claim_reviews.sql schema.
// Creates one throwaway content_items row, exercises the full
// resolved/unresolved lifecycle against real legal_claim_reviews rows, then
// deletes everything it created (cascade deletes the legal_claim_reviews
// rows automatically).
require('dotenv').config({ path: '../../.env' });
const { select, insert, update } = require('./lib/supabase');
const { recomputeLegalReviewStatus, filterNewLegalClaimFindings } = require('./lib/legal-review');

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
  if (!res.ok) {
    throw new Error(`delete from ${table} failed (${res.status}): ${await res.text()}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`PASS — ${message}`);
}

async function main() {
  let contentItemId = null;
  try {
    // 0. Throwaway content item to attach test rows to.
    const [item] = await insert('content_items', {
      content_type: 'faq',
      title: 'TARS TEST — legal-review status recompute (DELETE ME)',
      body: 'placeholder',
      status: 'draft',
    });
    contentItemId = item.id;
    console.log(`Created test content_item ${contentItemId}\n`);

    // 1. Zero rows -> not_required
    const status1 = await recomputeLegalReviewStatus(contentItemId);
    assert(status1 === 'not_required', `zero rows -> 'not_required' (got '${status1}')`);
    const [row1] = await select('content_items', `select=legal_review_status&id=eq.${contentItemId}`);
    assert(row1.legal_review_status === 'not_required', 'content_items.legal_review_status column actually written as not_required');

    // 2. Insert one row with peter_decision null -> needs_review
    const [claimRow] = await insert('legal_claim_reviews', {
      content_item_id: contentItemId,
      claim_text: 'AB 2347 extended the tenant-response window from 5 to 10 business days.',
      claim_context: 'AB 2347 extended the tenant-response window from 5 to 10 business days, effective January 2025.',
      source_url: 'https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=202320240AB2347',
      jurisdiction_scope: 'statewide',
      detected_by: 'pattern_match',
    });
    console.log(`\nInserted legal_claim_reviews row ${claimRow.id}`);
    assert(claimRow.peter_decision === null, 'freshly-inserted row has peter_decision = null (DB default, not app-set)');
    assert(claimRow.mason_finding === null, 'freshly-inserted row has mason_finding = null');

    const status2 = await recomputeLegalReviewStatus(contentItemId);
    assert(status2 === 'needs_review', `one unresolved (null) row -> 'needs_review' (got '${status2}')`);

    // 3. Mason records a finding — independent of peter_decision. Confirm
    // mason_finding and peter_decision really are independently settable
    // (the migration's central rule), and that a Mason finding ALONE does
    // NOT resolve the claim.
    await update('legal_claim_reviews', `id=eq.${claimRow.id}`, {
      mason_finding: 'CONFIRMED',
      mason_note: 'Verified against LegInfo — AB 2347 confirmed chaptered, effective 2025-01-01.',
      mason_reviewed_at: new Date().toISOString(),
    });
    const [afterMason] = await select(
      'legal_claim_reviews',
      `select=mason_finding,peter_decision&id=eq.${claimRow.id}`
    );
    assert(afterMason.mason_finding === 'CONFIRMED', 'mason_finding independently settable to CONFIRMED');
    assert(afterMason.peter_decision === null, 'peter_decision still null after ONLY mason_finding was set — no cross-derivation');

    const status3 = await recomputeLegalReviewStatus(contentItemId);
    assert(
      status3 === 'needs_review',
      `mason_finding=CONFIRMED alone does NOT resolve the row — still 'needs_review' (got '${status3}')`
    );

    // 4. peter_decision = 'consulting_attorney' — must NOT count as resolved
    // (the migration's explicit rule: this is a flag, not a verdict).
    await update('legal_claim_reviews', `id=eq.${claimRow.id}`, {
      peter_decision: 'consulting_attorney',
      decided_by: 'peter@rinconmanagement.com',
      decided_at: new Date().toISOString(),
    });
    const status4 = await recomputeLegalReviewStatus(contentItemId);
    assert(
      status4 === 'needs_review',
      `peter_decision='consulting_attorney' still counts as UNRESOLVED -> 'needs_review' (got '${status4}')`
    );

    // 5. peter_decision = 'approved_as_is' — now genuinely resolved.
    await update('legal_claim_reviews', `id=eq.${claimRow.id}`, {
      peter_decision: 'approved_as_is',
      decided_by: 'peter@rinconmanagement.com',
      decided_at: new Date().toISOString(),
    });
    const status5 = await recomputeLegalReviewStatus(contentItemId);
    assert(status5 === 'cleared', `all rows resolved (approved_as_is) -> 'cleared' (got '${status5}')`);
    const [row5] = await select('content_items', `select=legal_review_status&id=eq.${contentItemId}`);
    assert(row5.legal_review_status === 'cleared', 'content_items.legal_review_status column actually written as cleared');

    // 6. Add a SECOND row, still unresolved -> back to needs_review, proving
    // this is a real per-item aggregate over ALL rows, not cached/stale.
    const [claimRow2] = await insert('legal_claim_reviews', {
      content_item_id: contentItemId,
      claim_text: 'Court filing fees for an unlawful detainer run $240 to $435.',
      claim_context: 'Court filing fees for an unlawful detainer run $240 to $435 depending on the county.',
      source_url: '(no source found in article text — flagged for review)',
      jurisdiction_scope: 'unknown',
      detected_by: 'pattern_match',
    });
    const status6 = await recomputeLegalReviewStatus(contentItemId);
    assert(
      status6 === 'needs_review',
      `adding a second, unresolved row flips a 'cleared' item back to 'needs_review' (got '${status6}')`
    );

    // 7. filterNewLegalClaimFindings(): the same exact wording as an
    // existing row must be filtered out; a genuinely different wording must
    // survive.
    const candidates = [
      { claimText: 'AB 2347 extended the tenant-response window from 5 to 10 business days.' }, // exact dup of claimRow (now resolved)
      { claimText: 'Court filing fees for an unlawful detainer run $240 to $435.' }, // exact dup of claimRow2 (unresolved)
      { claimText: 'Attorney fees for a contested eviction typically run $1,500 to $5,000.' }, // genuinely new
    ];
    const filtered = await filterNewLegalClaimFindings(contentItemId, candidates);
    assert(filtered.length === 1, `filterNewLegalClaimFindings() drops both exact-wording dupes (resolved AND unresolved), keeps only the genuinely new one (got ${filtered.length})`);
    assert(
      filtered[0].claimText.includes('Attorney fees'),
      'the surviving candidate is the genuinely new attorney-fees claim'
    );

    console.log('\nALL LIVE-DB TESTS PASSED.');
  } finally {
    if (contentItemId) {
      // legal_claim_reviews rows cascade-delete via ON DELETE CASCADE.
      await del('content_items', `id=eq.${contentItemId}`);
      console.log(`\nCleaned up: deleted test content_item ${contentItemId} (cascade-deleted its legal_claim_reviews rows).`);
      const remaining = await select('legal_claim_reviews', `select=id&content_item_id=eq.${contentItemId}`);
      console.log(`Verification: ${remaining.length} legal_claim_reviews rows remain for that id (expect 0).`);
    }
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
