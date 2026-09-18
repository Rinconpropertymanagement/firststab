#!/usr/bin/env node
/**
 * reset-layer1-removal-310.js
 *
 * One-time reset for the Layer 1 removal build (SCREENING_VERSION bumped to
 * 'archive-search-screening-v4-layer1-removed' — see lib/screening-pass.js's
 * own comment on that constant for the full authorization record: outside
 * counsel's opinion, Asimov's CLEARED WITH CONDITIONS, Mason's CLEARED,
 * and Peter's signed owner risk-acceptance — all in compliance/). Mirrors
 * reset-self-report-recalibration-119.js's own structure and discipline
 * exactly (measure against the live table first, guard-check before
 * writing, verify after writing, one Rule 6 audit_log entry).
 *
 * WHAT THIS DOES
 * Identifies conversations that reached their flag/clear decision under the
 * OLD combined logic (checkClaim() = Layer 1 keyword scan OR Layer 2
 * self-report) while screening_version was still
 * 'archive-search-screening-v3-narrow-fh-self-report', and resets their
 * screening_result back to NULL so the driver query (screening-pass.js's
 * `WHERE screening_result IS NULL`) picks them up again and re-evaluates
 * them under v4 (self-report alone, no Layer 1).
 *
 * SCOPE — measured against the live table 2026-09-12, not assumed (see the
 * guard check below, which aborts rather than writes if the measured counts
 * don't match):
 *   - 310 conversations reset (255 flagged_protected_class + 55 clear),
 *     identified as: screening_version = 'archive-search-screening-v3-
 *     narrow-fh-self-report' AND screening_result IN
 *     ('flagged_protected_class','clear') AND screening_tags does NOT
 *     contain 'wide_net_skip'.
 *   - 181 conversations correctly auto-cleared by the wide-net pre-filter
 *     (screening_tags contains 'wide_net_skip') are explicitly excluded —
 *     never touched by this script. The wide-net gate runs identically
 *     before and after this build (Layer 1 removal only affects what
 *     happens AFTER a wide-net match, never the gate itself).
 *   - 0 held conversations exist under v3 (confirmed, not assumed) — held
 *     conversations never reach self-report in the first place.
 *   - 312 real missive_message_intake rows across those 310 conversations
 *     (a small number of conversations have 2 rows).
 *
 * ONLY screening_result is reset — same reasoning as the precedent script:
 * screening_category/screening_tags/screening_version/screening_completed_at
 * are left as historical residue; markConversationScreened() overwrites all
 * five fields together the next time a chunk actually re-screens these
 * conversations.
 *
 * SAFE TO RE-RUN: after a successful run, the v3 flag/clear count is 0, so
 * the guard check aborts before writing anything a second time.
 */

require('dotenv').config({ path: '/Users/petermckenzie/CODE/firststab/.env' });
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const TARGET_SCREENING_VERSION = 'archive-search-screening-v3-narrow-fh-self-report';
const NEW_SCREENING_VERSION = 'archive-search-screening-v4-layer1-removed';

const EXPECTED_TO_RESET = 310;
const EXPECTED_FLAGGED = 255;
const EXPECTED_CLEAR = 55;
const EXPECTED_WIDE_NET_SKIP = 181;

const isWideNetSkip = (row) => Array.isArray(row.screening_tags) && row.screening_tags.includes('wide_net_skip');

async function fetchAllV3Rows() {
  const rows = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('missive_message_intake')
      .select('missive_conversation_id, screening_result, screening_tags, screening_version')
      .not('screening_result', 'is', null)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows.filter((r) => r.screening_version === TARGET_SCREENING_VERSION);
}

(async () => {
  const rows = await fetchAllV3Rows();

  const toResetIds = new Set();
  const flaggedIds = new Set();
  const clearIds = new Set();
  const wideNetSkipIds = new Set();
  const heldIds = new Set();

  for (const row of rows) {
    const cid = row.missive_conversation_id;
    if (row.screening_result === 'held') {
      heldIds.add(cid);
    } else if (isWideNetSkip(row)) {
      wideNetSkipIds.add(cid);
    } else if (row.screening_result === 'flagged_protected_class') {
      toResetIds.add(cid);
      flaggedIds.add(cid);
    } else if (row.screening_result === 'clear') {
      toResetIds.add(cid);
      clearIds.add(cid);
    }
  }

  console.log('Pre-update verification:');
  console.log(`  to reset (flagged+clear, non-wide-net-skip): ${toResetIds.size} (expected ${EXPECTED_TO_RESET})`);
  console.log(`    flagged_protected_class: ${flaggedIds.size} (expected ${EXPECTED_FLAGGED})`);
  console.log(`    clear: ${clearIds.size} (expected ${EXPECTED_CLEAR})`);
  console.log(`  wide_net_skip (excluded, untouched): ${wideNetSkipIds.size} (expected ${EXPECTED_WIDE_NET_SKIP})`);
  console.log(`  held (excluded, untouched): ${heldIds.size} (expected 0)`);

  if (
    toResetIds.size !== EXPECTED_TO_RESET ||
    flaggedIds.size !== EXPECTED_FLAGGED ||
    clearIds.size !== EXPECTED_CLEAR ||
    wideNetSkipIds.size !== EXPECTED_WIDE_NET_SKIP ||
    heldIds.size !== 0
  ) {
    console.error('ABORTING: measured counts do not match the expected 310/255/55/181/0 — refusing to write until this is reconciled by hand. (If this is a re-run after a successful pass, 0/0/0/181/0 is expected and correct — nothing left to reset.)');
    process.exit(1);
  }

  const idsToReset = Array.from(toResetIds);

  const { data: updated, error: updateError } = await supabase
    .from('missive_message_intake')
    .update({ screening_result: null })
    .in('missive_conversation_id', idsToReset)
    .select('id');
  if (updateError) throw updateError;

  console.log(`\nUPDATE complete: ${updated.length} missive_message_intake rows (across ${idsToReset.length} conversations) reset to screening_result = NULL.`);

  const { data: nullCheck, error: nullCheckError } = await supabase
    .from('missive_message_intake')
    .select('missive_conversation_id')
    .in('missive_conversation_id', idsToReset)
    .is('screening_result', null);
  if (nullCheckError) throw nullCheckError;
  const nullCheckIds = new Set(nullCheck.map((r) => r.missive_conversation_id));
  console.log(`Post-update check: ${nullCheckIds.size} / ${idsToReset.length} target conversations now have screening_result = NULL on every fetched row.`);

  const wideNetSkipIdList = Array.from(wideNetSkipIds);
  const { data: wideNetRecheck, error: wideNetRecheckError } = await supabase
    .from('missive_message_intake')
    .select('missive_conversation_id, screening_result')
    .in('missive_conversation_id', wideNetSkipIdList);
  if (wideNetRecheckError) throw wideNetRecheckError;
  const wideNetStillClear = wideNetRecheck.every((r) => r.screening_result === 'clear');
  console.log(`Wide-net-skip rows untouched check: ${wideNetRecheck.length} rows re-fetched across ${wideNetSkipIdList.length} conversations, all still screening_result='clear': ${wideNetStillClear}.`);

  // Rule 6 audit_log entry — same shape as reset-self-report-recalibration-
  // 119.js's own precedent entry, citing this build's real authorization
  // chain by document path.
  const auditDetails = {
    decision: "GOVERNANCE.md Rule 6 Critical-tier change: archive search's handleNonHeldConversation() (lib/screening-pass.js) no longer calls checkClaim() (maintenance-history/lib/content-check.js's Layer 1 keyword scan + Layer 2 combining logic). screening_result/screening_category are now derived directly from selfReportFairHousingContent()'s own result. Archive search only — checkClaim(), content-check.js, and protected-class-terms.js are unmodified; every other caller of checkClaim() (complaint-tracking, approval-briefing, maintenance-history, leadsimple-property-brain) keeps both layers exactly as before.",
    reasoning: "Real production data under v3 (this reset's own measured scope) shows Layer 1's keyword scan alone still drives 255/310 (82%) of wide-net-matched conversations to flagged_protected_class, largely negating the self-report recalibration shipped earlier tonight. Outside counsel, on a direct, specific question disclosing both layers, approved removing the keyword-only layer and relying on the contextual self-report classifier alone.",
    decided_by: 'Peter McKenzie, owner',
    reviewed_by: 'Outside counsel (specific opinion on this exact change, extracted as standing guidance); Asimov (governance) confirmation pass, VERDICT: CLEARED WITH CONDITIONS; Mason (legal) confirmation pass, VERDICT: CLEARED — all 2026-09-12',
    scope: 'Archive search only (handleNonHeldConversation() in projects/hub/archive-search/lib/screening-pass.js). checkClaim(), maintenance-history/lib/content-check.js, and maintenance-history/lib/protected-class-terms.js are NOT modified. Every other caller of checkClaim() is unaffected: complaint-tracking (router.js, lib/process-pending-messages.js), approval-briefing (lib/access-instructions-check.js, lib/gather.js), maintenance-history (router.js, backfill-maintenance-snapshot.js), leadsimple-property-brain (run-accuracy-test-sample.js).',
    validation_sample_gate: "Per Asimov's confirmation, this is the substitute for GOVERNANCE.md Rule 6's 7-day-shadow-mode requirement: pull a real sample of conversations Layer 1 alone currently flags that Layer 2 alone would clear; confirm none are real Fair Housing concerns; zero-confirmed-miss bar; before this runs against the rest of the archive. That gate is TARS's job next — not run as part of this build.",
    previous_screening_version: TARGET_SCREENING_VERSION,
    new_screening_version: NEW_SCREENING_VERSION,
    reference_documents: [
      'compliance/archive-search-layer1-removal-attorney-question.md',
      'compliance/archive-search-layer1-removal-outside-counsel-opinion.md',
      'compliance/fair-housing-standing-counsel-guidance.md',
      'compliance/archive-search-layer1-removal-asimov-confirmation.md',
      'compliance/archive-search-layer1-removal-mason-confirmation.md',
      'compliance/archive-search-layer1-removal-owner-risk-acceptance.md',
    ],
    reset_disposition: {
      reason: "These conversations were flag/clear-decided under the OLD combined logic (checkClaim() = Layer 1 OR Layer 2) while screening_version was v3. screening_result reset to NULL (screening_category/screening_tags/screening_version/screening_completed_at left as-is) so the driver query (WHERE screening_result IS NULL) re-evaluates them under v4 (self-report alone). Verified safe by the same reasoning as the precedent reset: missive_message_intake_search_safe filters on screening_result = 'clear' (strict equality), so a NULL row can never appear in search — no exposure window before re-screening.",
      conversations_reset: idsToReset.length,
      previously_flagged_protected_class: flaggedIds.size,
      previously_clear: clearIds.size,
      rows_updated: updated.length,
      excluded_wide_net_skip_conversations_untouched: wideNetSkipIds.size,
      scoping_criteria: `missive_message_intake WHERE screening_version = '${TARGET_SCREENING_VERSION}' AND screening_result IN ('flagged_protected_class','clear') AND screening_tags does NOT contain 'wide_net_skip'`,
    },
  };

  const { data: auditRow, error: auditError } = await supabase
    .from('audit_log')
    .insert({
      action: 'archive_search.rule6_layer1_removed',
      entity_type: 'archive_search_layer1_removal',
      entity_id: crypto.randomUUID(),
      actor_type: 'human',
      actor_id: 'peter_mckenzie_owner_decision',
      risk_level: 'high',
      privacy_category: 'unclassified',
      details: auditDetails,
    })
    .select('*')
    .single();
  if (auditError) throw auditError;

  console.log('\nAudit log entry written:');
  console.log(JSON.stringify(auditRow, null, 2));
})().catch((err) => {
  console.error('SCRIPT FAILED:', err);
  process.exit(1);
});
