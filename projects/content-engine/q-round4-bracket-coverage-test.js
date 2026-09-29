// Round 4 fix verification — lib/legal-review.js's
// bracketInstanceIsAlreadyCovered() / findMissingLegalClaimBracketFindings().
//
// TARS found that Round 1's fix (anchor comparison on the bracket itself,
// not the whole chunk) correctly narrowed the claim_text side of the check,
// but the SAME function also checked claim_context via identical loose
// substring containment — and claim_context is deliberately WIDE per
// buildLegalClaimsSystemPrompt() ("the same sentence, or a little more
// surrounding text"), so an unrelated row's claim_context can legitimately
// span across an adjacent, different bracket in a run-on sentence with no
// internal period. This reopened the exact same false-positive-coverage bug
// class, just via the other field.
//
// This test is a PURE function/DB test — no Claude API calls at all,
// findMissingLegalClaimBracketFindings() makes no AI calls, only a
// read-only Supabase select. Real Supabase throughout. Cleans up after
// itself.
require('dotenv').config({ path: '../../.env' });
const { select, insert } = require('./lib/supabase');
const { findMissingLegalClaimBracketFindings } = require('./lib/legal-review');

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

async function newTestItem(label) {
  const [item] = await insert('content_items', {
    content_type: 'faq',
    title: `Q ROUND4 TEST — ${label} (DELETE ME)`,
    body: 'placeholder',
    status: 'draft',
  });
  return item.id;
}

async function main() {
  const createdIds = [];
  try {
    // ================================================================
    // TEST 1 — TARS's exact deterministic repro: mold/habitability
    // bracket in a run-on (comma-joined, no internal period) followed
    // immediately by unrelated parking-enforcement prose. One existing row:
    // claim_text = ONLY the unrelated parking prose (narrow, correct per
    // Round 1's fix), claim_context = a WIDE span that happens to include
    // the mold bracket's literal text (simulating what Layer 2's own
    // "same sentence, or a little more" prompt would realistically produce
    // for a run-on with no internal period).
    // ================================================================
    {
      const contentItemId = await newTestItem('mold-vs-parking');
      createdIds.push(contentItemId);

      const moldBracket =
        '[LEGAL CLAIM PENDING REVIEW: landlords must remediate mold within 30 days under the implied warranty of habitability]';
      const body =
        `Tenants who report visible mold should expect a prompt response, and ` +
        `landlords must remediate mold within 30 days under the implied warranty of habitability ${moldBracket}, ` +
        `while a totally separate issue — cars parked in fire lanes are subject to towing without further warning ` +
        `under the property's posted parking rules.`;

      const parkingClaimText =
        `cars parked in fire lanes are subject to towing without further warning under the property's posted parking rules`;
      // claim_context is realistically wide (the "same sentence, or a
      // little more" the prompt asks for) — wide enough to also contain
      // the mold bracket's literal text, purely because it's the same
      // run-on sentence.
      const parkingClaimContext = body; // the whole run-on, worst case

      await insert('legal_claim_reviews', {
        content_item_id: contentItemId,
        claim_text: parkingClaimText,
        claim_context: parkingClaimContext,
        source_url: '(no source found in article text — flagged for review)',
        jurisdiction_scope: 'unknown',
        detected_by: 'ai_comprehension',
      });

      const missing = await findMissingLegalClaimBracketFindings(contentItemId, body);
      assert(
        missing.length === 1,
        `TEST 1 (TARS repro): mold bracket correctly reported as missing despite an unrelated row's wide claim_context containing its literal text (got ${missing.length} missing finding(s))`
      );
      if (missing.length === 1) {
        assert(
          missing[0].claimText.includes('mold'),
          `TEST 1: the missing finding is actually about mold, not something else (got: "${missing[0].claimText}")`
        );
      }
    }

    // ================================================================
    // TEST 2 — different topic, em-dash run-on: security-deposit bracket
    // immediately followed by unrelated late-fee prose, joined by an
    // em-dash with no internal period. Existing row's claim_text is the
    // narrow late-fee sentence; claim_context is widened to also swallow
    // the deposit bracket.
    // ================================================================
    {
      const contentItemId = await newTestItem('deposit-vs-latefee');
      createdIds.push(contentItemId);

      const depositBracket =
        '[LEGAL CLAIM PENDING REVIEW: security deposits must be itemized and returned within 21 days of move-out]';
      const body =
        `Move-out inspections should be scheduled promptly — security deposits must be itemized and ` +
        `returned within 21 days of move-out ${depositBracket} — and on an unrelated note, late fees for rent ` +
        `paid after the 5th of the month may not exceed a reasonable estimate of actual damages.`;

      const lateFeeClaimText =
        `late fees for rent paid after the 5th of the month may not exceed a reasonable estimate of actual damages`;
      const lateFeeClaimContext = body;

      await insert('legal_claim_reviews', {
        content_item_id: contentItemId,
        claim_text: lateFeeClaimText,
        claim_context: lateFeeClaimContext,
        source_url: '(no source found in article text — flagged for review)',
        jurisdiction_scope: 'unknown',
        detected_by: 'ai_comprehension',
      });

      const missing = await findMissingLegalClaimBracketFindings(contentItemId, body);
      assert(
        missing.length === 1,
        `TEST 2 (em-dash run-on, different topic): security-deposit bracket correctly reported as missing (got ${missing.length})`
      );
      if (missing.length === 1) {
        assert(
          missing[0].claimText.includes('security deposit') || missing[0].claimText.includes('21 days'),
          `TEST 2: the missing finding is actually about the deposit claim (got: "${missing[0].claimText}")`
        );
      }
    }

    // ================================================================
    // TEST 3 — different run-on shape: semicolon-joined run-on, pet-policy
    // bracket followed by unrelated smoke-detector prose.
    // ================================================================
    {
      const contentItemId = await newTestItem('pets-vs-smoke-detectors');
      createdIds.push(contentItemId);

      const petBracket =
        '[LEGAL CLAIM PENDING REVIEW: a landlord may not charge a pet deposit exceeding two months rent for an assistance animal]';
      const body =
        `Pet policies vary by building; a landlord may not charge a pet deposit exceeding two months rent for ` +
        `an assistance animal ${petBracket}; separately, smoke detectors must be tested by the landlord at the ` +
        `start of every new tenancy regardless of pet policy.`;

      const smokeClaimText =
        `smoke detectors must be tested by the landlord at the start of every new tenancy regardless of pet policy`;
      const smokeClaimContext = body;

      await insert('legal_claim_reviews', {
        content_item_id: contentItemId,
        claim_text: smokeClaimText,
        claim_context: smokeClaimContext,
        source_url: '(no source found in article text — flagged for review)',
        jurisdiction_scope: 'unknown',
        detected_by: 'ai_comprehension',
      });

      const missing = await findMissingLegalClaimBracketFindings(contentItemId, body);
      assert(
        missing.length === 1,
        `TEST 3 (semicolon run-on, third topic): pet-deposit bracket correctly reported as missing (got ${missing.length})`
      );
    }

    // ================================================================
    // TEST 4 — regression: Round 1's original fix (the claim_text-side
    // false-negative) must still work. An unrelated row's claim_text is
    // narrow and genuinely does NOT overlap the bracket's own text/
    // description at all (Round 1's real fix target — before Round 1, the
    // OLD chunk-vs-claim_text check compared the whole oversized chunk,
    // not the bracket itself, so it wrongly treated any row from the same
    // chunk as covering). Must still be reported as missing.
    // ================================================================
    {
      const contentItemId = await newTestItem('round1-real-regression');
      createdIds.push(contentItemId);

      const retentionBracket =
        '[LEGAL CLAIM PENDING REVIEW: records must be retained for three years under Civil Code section 1950.5]';
      const body =
        `Recordkeeping matters — records must be retained for three years under Civil Code section 1950.5 ` +
        `${retentionBracket}, and, unrelated, showings may only be scheduled with 24 hours advance notice ` +
        `to the current tenant.`;

      const showingsClaimText =
        `showings may only be scheduled with 24 hours advance notice to the current tenant`;

      await insert('legal_claim_reviews', {
        content_item_id: contentItemId,
        claim_text: showingsClaimText,
        claim_context: showingsClaimText, // narrow this time on BOTH fields
        source_url: '(no source found in article text — flagged for review)',
        jurisdiction_scope: 'unknown',
        detected_by: 'ai_comprehension',
      });

      const missing = await findMissingLegalClaimBracketFindings(contentItemId, body);
      assert(
        missing.length === 1,
        `TEST 4 (Round 1 regression, narrow unrelated claim_text): retention bracket still correctly reported as missing (got ${missing.length})`
      );
    }

    // ================================================================
    // TEST 5 — sanity check: a row that GENUINELY covers the bracket
    // (claim_text is exactly the bracket's own sentence, including the
    // bracket wrapper — the realistic shape when Layer 2 catches it
    // correctly) must still be recognized as covered. Makes sure the fix
    // isn't so aggressive it defeats legitimate coverage too.
    // ================================================================
    {
      const contentItemId = await newTestItem('genuine-coverage-sanity');
      createdIds.push(contentItemId);

      const bracket =
        '[LEGAL CLAIM PENDING REVIEW: landlords must remediate mold within 30 days under the implied warranty of habitability]';
      const sentence =
        `Landlords must remediate mold within 30 days under the implied warranty of habitability ${bracket}.`;
      const body = `${sentence} Separately, parking rules are posted at the leasing office.`;

      // Realistic Layer 2 catch: claim_text is the same sentence,
      // including the bracket wrapper verbatim (copied character-for-
      // character from TEXT, per buildLegalClaimsSystemPrompt()'s own
      // rule).
      await insert('legal_claim_reviews', {
        content_item_id: contentItemId,
        claim_text: sentence,
        claim_context: sentence,
        source_url: 'https://example.gov/mold-rule',
        jurisdiction_scope: 'statewide',
        detected_by: 'ai_comprehension',
      });

      const missing = await findMissingLegalClaimBracketFindings(contentItemId, body);
      assert(
        missing.length === 0,
        `TEST 5 (sanity — genuine coverage still recognized): expected 0 missing findings, got ${missing.length}`
      );
    }

    console.log('\nALL ROUND 4 BRACKET-COVERAGE TESTS PASSED.');
  } finally {
    for (const id of createdIds) {
      try {
        await del('content_items', `id=eq.${id}`);
      } catch (e) {
        console.warn(`cleanup failed for ${id}: ${e.message}`);
      }
    }
    console.log(`\nCleaned up ${createdIds.length} test content_item(s) (cascade-deleted their legal_claim_reviews rows).`);
    for (const id of createdIds) {
      const remaining = await select('legal_claim_reviews', `select=id&content_item_id=eq.${id}`);
      if (remaining.length !== 0) {
        console.warn(`WARNING: ${remaining.length} legal_claim_reviews rows still remain for ${id}`);
      }
    }
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
