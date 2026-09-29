#!/usr/bin/env node
/**
 * reset-self-report-recalibration-119.js
 *
 * One-time (already run 2026-09-12 — see the audit_log entry this script
 * itself writes, action archive_search.rule6_self_report_question_
 * recalibrated) reset for the self-report recalibration build. Per
 * projects/hub/email-intake/archive-search-self-report-recalibration-spec.md
 * Section 4 (Peter's "reset the scan" decision, verbatim) and Section 6
 * item 4.
 *
 * WHAT THIS DOES
 * Identifies the conversations that reached selfReportFairHousingContent()
 * under the OLD self-report question (FAIR_HOUSING_SELF_REPORT_VERSION =
 * 'archive-search-self-report-v1') during today's real screening run, and
 * resets their screening_result back to NULL so the driver query
 * (screening-pass.js's `WHERE screening_result IS NULL`) picks them up
 * again and re-evaluates them under the new, narrower question.
 *
 * SCOPE — measured against the live table, not assumed from the spec's
 * estimate (see the guard check below, which aborts rather than writes if
 * the measured counts don't match):
 *   - 119 conversations reset (107 flagged_protected_class + 12 clear),
 *     identified as: screening_version = the OLD SCREENING_VERSION
 *     ('archive-search-screening-v2-wide-net-prefilter') AND
 *     screening_result IN ('flagged_protected_class','clear') AND
 *     screening_tags does NOT contain 'wide_net_skip'.
 *   - 279 conversations correctly auto-cleared by the wide-net pre-filter
 *     (screening_tags contains 'wide_net_skip') are explicitly excluded —
 *     never touched by this script.
 *   - 0 held conversations exist under the old version (confirmed, not
 *     assumed) — held conversations never reach self-report in the first
 *     place, so there was nothing to exclude in practice, but the guard
 *     still checks this explicitly.
 * 279 + 119 = 398, matching the spec's own stated first-chunk total.
 *
 * ONLY screening_result is reset. screening_category, screening_tags,
 * screening_version, and screening_completed_at are deliberately left as
 * historical residue from the old run — the spec's Section 4/Section 6
 * only call for a screening_result reset, and screening-pass.js's own
 * markConversationScreened() overwrites all five fields together the next
 * time a chunk actually re-screens these conversations, so leaving the old
 * values in the meantime is harmless and reversible by construction.
 *
 * INDEXING NOTE — missive_message_intake (254,000+ live rows) has no
 * usable index for an equality filter on screening_version, or on a
 * specific screening_result value beyond IS NULL (see
 * supabase/migrations/20260912020000_add_screening_result_index_to_
 * missive_message_intake.sql's own root-cause note for the same bug hit
 * elsewhere). A `.eq('screening_version', ...)` read timed out in
 * practice while building this script. The read below uses
 * `.not('screening_result','is',null)` (which returned successfully) and
 * does the screening_version / wide_net_skip narrowing in JS instead: the
 * "not yet screened" set is the huge one (254,000+), and "already
 * screened, any result" (~419 rows today) is small enough to page through
 * and filter client-side. The UPDATE and the two post-write verification
 * reads all filter by missive_conversation_id, which IS indexed
 * (idx_missive_message_intake_conversation).
 *
 * Safe to re-run: after a successful run, the old version's self-report-
 * reached count is 0, so the guard check aborts before writing anything a
 * second time (no double UPDATE, no duplicate audit_log entry).
 */

require('dotenv').config({ path: '/Users/petermckenzie/CODE/firststab/.env' });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const OLD_SCREENING_VERSION = 'archive-search-screening-v2-wide-net-prefilter';
const NEW_SCREENING_VERSION = 'archive-search-screening-v3-narrow-fh-self-report';
const OLD_SELF_REPORT_VERSION = 'archive-search-self-report-v1';
const NEW_SELF_REPORT_VERSION = 'archive-search-self-report-v2-narrow-fh-concern';

const EXPECTED_SELF_REPORT_REACHED = 119;
const EXPECTED_FLAGGED = 107;
const EXPECTED_CLEAR = 12;
const EXPECTED_WIDE_NET_SKIP = 279;

const isWideNetSkip = (row) => Array.isArray(row.screening_tags) && row.screening_tags.includes('wide_net_skip');

async function fetchAllOldVersionRows() {
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
  return rows.filter((r) => r.screening_version === OLD_SCREENING_VERSION);
}

(async () => {
  const rows = await fetchAllOldVersionRows();

  const selfReportReachedIds = new Set();
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
      selfReportReachedIds.add(cid);
      flaggedIds.add(cid);
    } else if (row.screening_result === 'clear') {
      selfReportReachedIds.add(cid);
      clearIds.add(cid);
    }
  }

  console.log('Pre-update verification:');
  console.log(`  self-report-reached (to reset): ${selfReportReachedIds.size} (expected ${EXPECTED_SELF_REPORT_REACHED})`);
  console.log(`    flagged_protected_class: ${flaggedIds.size} (expected ${EXPECTED_FLAGGED})`);
  console.log(`    clear: ${clearIds.size} (expected ${EXPECTED_CLEAR})`);
  console.log(`  wide_net_skip (excluded, untouched): ${wideNetSkipIds.size} (expected ${EXPECTED_WIDE_NET_SKIP})`);
  console.log(`  held (excluded, untouched): ${heldIds.size} (expected 0)`);

  if (
    selfReportReachedIds.size !== EXPECTED_SELF_REPORT_REACHED ||
    flaggedIds.size !== EXPECTED_FLAGGED ||
    clearIds.size !== EXPECTED_CLEAR ||
    wideNetSkipIds.size !== EXPECTED_WIDE_NET_SKIP
  ) {
    console.error("ABORTING: measured counts do not match the spec's stated 119/107/12/279 — refusing to write until this is reconciled by hand. (If this is a re-run after a successful pass, 0/0/0/279 is expected and correct — nothing left to reset.)");
    process.exit(1);
  }

  const idsToReset = Array.from(selfReportReachedIds);

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

  // One Rule 6 audit_log entry — same shape as the precedent
  // archive_search.rule6_shadow_mode_waived / _option_b entries (read
  // directly from the live table before writing this one) — recording the
  // version bump AND the reset disposition together in a single record,
  // per the spec's Section 6 item 3 / Asimov's confirmation-pass addition.
  const auditDetails = {
    decision: 'GOVERNANCE.md Rule 6 Critical-tier change: the archive-search Fair Housing self-report question (fair-housing-batch-self-report.js buildPrompt()) recalibrated from "references a protected characteristic" to counsel\'s narrower "reasonably indicates a potential Fair Housing concern" standard, adopted verbatim from his own recommended language.',
    reasoning: 'Real screening pass data (2026-09-12, 500-message/398-conversation first chunk) showed the old question flagged 107 of 119 conversations that reached it (90%) — projected to ~60,000-70,000 flagged conversations for the Director of Operations to hand-review across the full 254,291-conversation archive, not workable and not reflective of actual Fair Housing risk (routine, lawful mentions of a protected characteristic were flagging just as much as genuine concerns). Outside counsel reviewed the actual concrete prompt and example pairs and approved a narrower standard (four flag categories (a)-(d): adverse/hostile treatment, unresolved accommodation requests, characteristic-influenced preferences/policies, and indirect/euphemistic language) with an unresolved-ambiguity-to-human-review backstop.',
    decided_by: 'Peter McKenzie, owner',
    reviewed_by: 'Outside counsel (concrete prompt + example pairs reviewed directly); Asimov (governance) confirmation pass, Gates 1-3 CLOSED; Mason (legal) confirmation pass, CLEAR / FLAGGED lifted — both 2026-09-12',
    decided_by_quote: 'make is less conservative. no single words. phrases.',
    previous_self_report_version: OLD_SELF_REPORT_VERSION,
    new_self_report_version: NEW_SELF_REPORT_VERSION,
    previous_screening_version: OLD_SCREENING_VERSION,
    new_screening_version: NEW_SCREENING_VERSION,
    reference_documents: [
      'projects/hub/email-intake/archive-search-self-report-recalibration-spec.md',
      'compliance/archive-search-self-report-recalibration-oracle-report.md',
      'compliance/archive-search-self-report-recalibration-attorney-question.md',
      'compliance/archive-search-self-report-recalibration-outside-counsel-opinion.md',
      'compliance/archive-search-self-report-recalibration-asimov-confirmation.md',
      'compliance/archive-search-self-report-recalibration-mason-confirmation.md',
    ],
    reset_disposition: {
      reason: "These conversations were self-report-evaluated under the OLD (v1) question during today's real screening run, before this recalibration shipped. Peter's decision, verbatim: \"reset the scan.\" screening_result reset to NULL (screening_category/screening_tags/screening_version/screening_completed_at left as-is) so the driver query (WHERE screening_result IS NULL) re-evaluates them under the new question rather than keeping stale results decided under a standard outside counsel found substantially overinclusive. Verified safe by Asimov: missive_message_intake_search_safe filters on screening_result = 'clear' (strict equality), so a NULL row can never appear in search — no exposure window before re-screening.",
      conversations_reset: idsToReset.length,
      previously_flagged_protected_class: flaggedIds.size,
      previously_clear: clearIds.size,
      rows_updated: updated.length,
      excluded_wide_net_skip_conversations_untouched: wideNetSkipIds.size,
      scoping_criteria: `missive_message_intake WHERE screening_version = '${OLD_SCREENING_VERSION}' AND screening_result IN ('flagged_protected_class','clear') AND screening_tags does NOT contain 'wide_net_skip'`,
    },
  };

  const { data: auditRow, error: auditError } = await supabase
    .from('audit_log')
    .insert({
      action: 'archive_search.rule6_self_report_question_recalibrated',
      entity_type: 'archive_search_self_report_recalibration',
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
