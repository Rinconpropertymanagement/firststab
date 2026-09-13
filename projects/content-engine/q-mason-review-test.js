#!/usr/bin/env node
/**
 * q-mason-review-test.js — Q's own verification of reviewClaimAsMason()
 * before touching the real backfill row. Creates its own temp content_items
 * + legal_claim_reviews rows (cleaned up at the end), NOT the real row on
 * e2e55b46-9716-4224-b05e-6d8a0a43200f.
 */
const CONTENT_ENGINE_DIR = '/Users/petermckenzie/CODE/firststab/projects/content-engine';
require('dotenv').config({ path: '/Users/petermckenzie/CODE/firststab/.env' });
process.chdir(CONTENT_ENGINE_DIR);

const { select, insert } = require(`${CONTENT_ENGINE_DIR}/lib/supabase`);
const { reviewClaimAsMason, MASON_FINDINGS, MASON_SOURCE_TIERS } = require(`${CONTENT_ENGINE_DIR}/lib/legal-review`);

async function main() {
  const createdContentItemIds = [];
  const createdClaimIds = [];

  try {
    // ---- Test 1: should land CONFIRMED — real primary .gov source that
    // actually says what the claim states, properly hedged.
    const [item1] = await insert('content_items', {
      content_type: 'blog_post',
      title: 'Q TEST — Mason review CONFIRMED case (safe to delete)',
      status: 'draft',
    });
    createdContentItemIds.push(item1.id);
    const [claim1] = await insert('legal_claim_reviews', {
      content_item_id: item1.id,
      claim_text:
        'As of July 1, 2024, California law caps most residential security deposits at one month’s rent, per Civil Code § 1950.5.',
      claim_context:
        'Landlords should note that as of July 1, 2024, California law caps most residential security deposits at one month’s rent, per Civil Code § 1950.5, with a limited exception for small landlords.',
      source_url: 'https://www.oag.ca.gov/system/files/media/Know-Your-Rights-Security-Deposits-English.pdf',
      jurisdiction_scope: 'statewide',
      detected_by: 'pattern_match',
    });
    createdClaimIds.push(claim1.id);

    console.log('--- TEST 1 (expect CONFIRMED) ---');
    const result1 = await reviewClaimAsMason(claim1.id);
    console.log(JSON.stringify(result1, null, 2));

    // ---- Test 2: should land NEEDS_SOURCE_CHECK (or similar non-CONFIRMED)
    // — source is real but is a CITY government page describing San
    // Francisco's own local rules, cited to support a claim stated as
    // general CALIFORNIA STATEWIDE law with a Ventura-specific framing —
    // jurisdiction-scope mismatch, secondary-ish sourcing.
    const [item2] = await insert('content_items', {
      content_type: 'blog_post',
      title: 'Q TEST — Mason review NEEDS_SOURCE_CHECK case (safe to delete)',
      status: 'draft',
    });
    createdContentItemIds.push(item2.id);
    const [claim2] = await insert('legal_claim_reviews', {
      content_item_id: item2.id,
      claim_text:
        'Ventura County landlords must now cap every security deposit at exactly one month’s rent with no exceptions of any kind.',
      claim_context:
        'Ventura County landlords must now cap every security deposit at exactly one month’s rent with no exceptions of any kind, effective immediately statewide.',
      source_url: 'https://www.sf.gov/news--security-deposit-laws-are-changing-july-1-2024',
      jurisdiction_scope: 'unknown',
      detected_by: 'ai_comprehension',
    });
    createdClaimIds.push(claim2.id);

    console.log('\n--- TEST 2 (expect NEEDS_SOURCE_CHECK / REJECT / FLAG_FOR_ATTORNEY, NOT CONFIRMED) ---');
    const result2 = await reviewClaimAsMason(claim2.id);
    console.log(JSON.stringify(result2, null, 2));

    // ---- Verify peter_decision / decided_by / decided_at were never
    // touched by either call.
    console.log('\n--- Verifying peter_decision untouched ---');
    const rows = await select(
      'legal_claim_reviews',
      `select=id,mason_finding,mason_note,mason_reviewed_at,source_tier,peter_decision,peter_edited_text,decided_by,decided_at&id=in.(${claim1.id},${claim2.id})`
    );
    for (const r of rows) {
      const untouched =
        r.peter_decision === null && r.peter_edited_text === null && r.decided_by === null && r.decided_at === null;
      const findingValid = MASON_FINDINGS.includes(r.mason_finding);
      const tierValid = r.source_tier === null || MASON_SOURCE_TIERS.includes(r.source_tier);
      console.log(
        `${r.id}: mason_finding=${r.mason_finding} source_tier=${r.source_tier} ` +
          `mason_reviewed_at_set=${Boolean(r.mason_reviewed_at)} ` +
          `peter_decision_untouched=${untouched} finding_valid_enum=${findingValid} tier_valid_enum=${tierValid}`
      );
      if (!untouched) throw new Error(`FAIL: peter_decision fields were touched for row ${r.id}`);
      if (!findingValid) throw new Error(`FAIL: invalid mason_finding for row ${r.id}`);
      if (!tierValid) throw new Error(`FAIL: invalid source_tier for row ${r.id}`);
      if (!r.mason_reviewed_at) throw new Error(`FAIL: mason_reviewed_at not set for row ${r.id}`);
      if (!r.mason_note) throw new Error(`FAIL: mason_note not set for row ${r.id}`);
    }

    console.log('\nALL ASSERTIONS PASSED');
  } finally {
    // Clean up ALL test data created by this script (not the real backfill row).
    console.log('\n--- Cleaning up test data ---');
    for (const id of createdClaimIds) {
      try {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/legal_claim_reviews?id=eq.${id}`, {
          method: 'DELETE',
          headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
        });
      } catch (e) {
        console.warn(`Cleanup warning (claim ${id}): ${e.message}`);
      }
    }
    for (const id of createdContentItemIds) {
      try {
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/content_items?id=eq.${id}`, {
          method: 'DELETE',
          headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
        });
      } catch (e) {
        console.warn(`Cleanup warning (content_item ${id}): ${e.message}`);
      }
    }
    console.log('Cleanup done.');
  }
}

main().catch((e) => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
