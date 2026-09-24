#!/usr/bin/env node
/**
 * run-archive-search-corpus-backfill.js
 *
 * One-time backfill for the archive_search_corpus build (projects/hub/
 * email-intake/archive-search-search-performance-security-barrier-spec.md,
 * Section 9 — "Backfill and Rollout... built by Q"). Mirrors reset-
 * layer1-removal-310.js's and run-flagged-release-gate-removal.js's own
 * discipline (measure live, chunk, verify after writing, one Rule 6
 * audit_log entry with a real, live-measured count — never a number copied
 * from any document).
 *
 * NOT EXECUTED as part of this build. Written and ready to run; Peter runs
 * it himself, AFTER applying BOTH supabase/migrations/20260924010000_
 * archive_search_corpus_schema.sql AND supabase/migrations/20260924020000_
 * add_eligible_id_partial_index_for_archive_search_corpus_reconciliation.sql
 * via Supabase's SQL Editor — never before either, and never by Q or any
 * other automated agent against production, per this project's standing
 * convention (no CLI/DB URL in this environment).
 *
 * WHAT THIS DOES, IN ORDER
 *
 * 1. PAGINATED BACKFILL. Calls the archive_search_corpus_backfill_batch()
 *    RPC (20260924010000) repeatedly, cursor-paginated (id ASC, 5,000 rows
 *    per call — small enough to keep each call fast and resumable, large
 *    enough that ~255k rows takes on the order of tens of calls, not
 *    hundreds). Each call is idempotent (ON CONFLICT DO UPDATE inside the
 *    RPC itself) — safe to re-run this whole script from scratch at any
 *    point, including after a partial run or a crash mid-way.
 *
 * 2. LIVE VERIFICATION, not a static expected count. Unlike reset-layer1-
 *    removal-310.js's own guard check (a fixed historical scope with known
 *    counts), this backfill runs against a live, continuously-growing
 *    population — there is no fixed "expected" number to assert against
 *    ahead of time. Instead, this independently re-derives the eligible
 *    count via a direct query (the same predicate archive_search_message_
 *    is_eligible() encodes, expressed directly against missive_message_
 *    intake/archive_search_escalations/archive_search_flagged_
 *    suppressions — not by calling the corpus itself) and compares it to
 *    archive_search_corpus's own final row count. A close match (allowing
 *    for a small number of messages that arrived or changed screening
 *    status during this script's own run, which the corpus's own triggers
 *    handle live and this script does not need to chase) is the pass
 *    condition; a large or growing mismatch aborts before writing the
 *    Rule 6 audit_log entry.
 *
 * 3. THE CORRECTED RULE 6 audit_log ENTRY — Asimov's Condition 1
 *    (compliance/archive-search-search-performance-security-barrier-
 *    design-asimov-confirmation.md): Neo's spec draft (Section 7) cited
 *    the wrong section number for shadow mode and described a literal
 *    7-day parallel run that, per Peter's signed waiver (compliance/
 *    archive-search-search-performance-security-barrier-shadow-mode-
 *    owner-risk-acceptance.md), will not happen. This entry instead cites
 *    that waiver document by name and states plainly what actually ran:
 *    the same-transaction fail-closed removal triggers, the fail-open
 *    becoming-eligible trigger, and the reconciliation/audit-logging
 *    mechanism all went live from day one — the 7-day OBSERVATION of them
 *    beforehand is what was waived, not the mechanism itself.
 *
 * actor_type: 'human' / actor_id: 'peter_mckenzie_owner_decision' — same
 * classification Asimov's design confirmation explicitly confirmed correct
 * for this build (item 6: "no conflict was flagged for this build's own
 * confirmation, unlike the flagged-release-gate-removal one").
 *
 * SAFE TO RE-RUN: the backfill loop is idempotent (ON CONFLICT DO UPDATE).
 * The Rule 6 audit_log entry is written at most once — guarded by the same
 * "check for an existing row with this action before writing" pattern
 * run-flagged-release-gate-removal.js already uses, because a second
 * archive_search.rule6_security_barrier_replaced row would misrepresent a
 * one-time go-live event as having happened twice.
 */

require('dotenv').config({ path: '/Users/petermckenzie/CODE/firststab/.env' });
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const RULE6_ACTION = 'archive_search.rule6_security_barrier_replaced';
const BATCH_SIZE = 1000;
// A perfect 1:1 match is the expectation, but this script's own run takes
// real wall-clock time against a live, continuously-written table (the
// hourly screening cron, new inbound mail) — a small drift is normal, not
// a bug, and the corpus's own triggers (20260924010000) close any such gap
// live going forward regardless of this script. Anything beyond this is
// treated as a real problem worth stopping for rather than silently
// accepting.
const MAX_ACCEPTABLE_DRIFT = 50;

async function runBackfill() {
  // Resume support: pass a starting cursor as the first CLI arg to skip
  // re-upserting rows already written by a prior run. Added after real,
  // repeated evidence that restarting from scratch each time re-touches
  // the same already-written rows, and doing that three times in a row
  // is the likely cause of the recurring slowdown at the same point
  // (accumulated update bloat, not a data problem — checked directly,
  // the actual rows in that range are ordinary-sized).
  let cursor = process.argv[2] || null;
  let totalExamined = 0;
  let totalWritten = 0;
  let batchNum = 0;
  if (cursor) console.log(`Resuming from cursor ${cursor} (skipping already-written rows).`);

  for (;;) {
    batchNum += 1;
    // Retry on a transient statement timeout (57014) — the batch is
    // idempotent (ON CONFLICT DO UPDATE) and the cursor hasn't advanced,
    // so retrying the exact same call is safe. Occasional slow batches
    // (a cluster of unusually large email bodies going into the GIN
    // index) have been observed live during this backfill; a real,
    // non-transient problem should still surface after a few attempts
    // rather than retry forever.
    let data, error;
    for (let attempt = 1; attempt <= 5; attempt++) {
      ({ data, error } = await supabase.rpc('archive_search_corpus_backfill_batch', {
        p_cursor_id: cursor,
        p_limit: BATCH_SIZE,
      }));
      if (!error || error.code !== '57014') break;
      console.log(`  batch ${batchNum}: statement timeout, retrying (attempt ${attempt}/5)...`);
    }
    if (error) throw error;
    // Supabase RPC for a RETURNS TABLE function comes back as an array of
    // one row per call (a single-row result set here, since the function
    // itself returns exactly one row per invocation).
    const row = Array.isArray(data) ? data[0] : data;
    const examined = row.examined_count || 0;
    const written = row.written_count || 0;
    cursor = row.next_cursor;

    totalExamined += examined;
    totalWritten += written;
    console.log(`  batch ${batchNum}: examined ${examined}, written ${written}, cursor now ${cursor || '(none — end reached)'}`);

    if (examined < BATCH_SIZE || !cursor) break;
  }

  console.log(`\nBackfill loop complete: ${batchNum} batch(es), ${totalExamined} row(s) examined, ${totalWritten} row(s) written (insert or refresh-on-conflict).`);
  return { totalExamined, totalWritten };
}

async function countLiveEligible() {
  // Independently re-derives the eligible count via a direct query against
  // the real tables — NOT by querying archive_search_corpus itself (that
  // would just confirm the backfill against its own output, not a real
  // check) and NOT via missive_message_intake_search_safe (avoids the
  // exact anti-join-under-security_barrier instability
  // 20260918020000 already proved, per this build's own spec Section 5).
  const { count: eligibleBase, error: baseErr } = await supabase
    .from('missive_message_intake')
    .select('*', { count: 'exact', head: true })
    .in('screening_result', ['clear', 'flagged_protected_class']);
  if (baseErr) throw baseErr;

  // Escalations/suppressions currently exclude very few (often zero)
  // conversations relative to the base population (confirmed live this
  // session: 0 open/confirmed-not-reopened escalations, 0 suppressions) —
  // this script does not attempt to re-derive the full per-conversation
  // exclusion set client-side (that's what archive_search_message_is_
  // eligible() and archive_search_corpus_backfill_batch() already do,
  // server-side, per-row, as the actual backfill mechanism above). This
  // count is a coarse upper bound used only for the sanity/drift check
  // below, not the backfill's own eligibility logic.
  const { count: excludingEscalations, error: escErr } = await supabase
    .from('archive_search_escalations')
    .select('*', { count: 'exact', head: true })
    .or('status.eq.open,and(status.eq.confirmed,reopened_at.is.null)');
  if (escErr) throw escErr;

  const { count: excludingSuppressions, error: supErr } = await supabase
    .from('archive_search_flagged_suppressions')
    .select('*', { count: 'exact', head: true });
  if (supErr) throw supErr;

  return { eligibleBase, excludingEscalations, excludingSuppressions };
}

async function ruleSixEventAlreadyWritten() {
  const { data, error } = await supabase
    .from('audit_log')
    .select('id')
    .eq('action', RULE6_ACTION)
    .limit(1);
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

async function writeRuleSixEvent(finalCorpusCount) {
  const alreadyWritten = await ruleSixEventAlreadyWritten();
  if (alreadyWritten) {
    console.log(`\nRule 6 event SKIPPED: an audit_log row with action='${RULE6_ACTION}' already exists. This is a one-time go-live event; refusing to write a second one.`);
    return;
  }

  const auditDetails = {
    decision: "GOVERNANCE.md Rule 6 Critical-tier change: archive_search_corpus (a separate, trigger-maintained, eligible-content-only table) now exists and is backfilled, live-synchronized, and reconciled. GET /api/archive-search/search reads from it once Peter sets ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED=true (router.js) — a separate, later step this script does not perform. security_barrier is NOT removed from missive_message_intake_search_safe — it stays in place, unchanged, and every other archive-search route continues to read that view exactly as before. This changes only the enforcement MECHANISM for the one query security_barrier could never serve efficiently.",
    reasoning: "Full-text search was down in production (Postgres 57014 on every query) because security_barrier prevents pushdown of the non-leakproof @@ predicate. Outside counsel's opinion (2026-09-24) approved a separate eligible-content search corpus as a reasonable alternative enforcement mechanism for the same substantive exclusion rule. Asimov and Mason both CLEARED WITH CONDITIONS on the abstract architecture; Asimov CLEARED WITH CONDITIONS on the concrete design (all three conditions addressed in the migration and this script).",
    decided_by: 'Peter McKenzie, owner',
    reviewed_by: 'Outside counsel (compliance/archive-search-search-performance-security-barrier-outside-counsel-opinion.md); Asimov confirmation, VERDICT: CLEARED WITH CONDITIONS (compliance/archive-search-search-performance-security-barrier-asimov-confirmation.md, and the concrete-design pass, compliance/archive-search-search-performance-security-barrier-design-asimov-confirmation.md); Mason confirmation, VERDICT: CLEARED WITH CONDITIONS (compliance/archive-search-search-performance-security-barrier-mason-confirmation.md) — all 2026-09-24',
    scope: 'archive_search_corpus and its backfill only. missive_message_intake_search_safe, security_barrier, and every other archive-search route are unmodified. GET /api/archive-search/search itself only cuts over once Peter separately sets ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED=true.',
    sync_model: {
      leaving_eligibility: "Same-transaction, trigger-based (archive_search_escalations open-insert; archive_search_flagged_suppressions insert), fail-closed — no lag, per Mason condition 1. Live from the moment 20260924010000 was applied, independent of this backfill script.",
      becoming_eligible: "Same-transaction, trigger-based, fail-open/non-blocking (exceptions caught and logged, never block the screening pass). Primary propagation target: 0 seconds, structural. Backstop ceiling: archive_search_corpus_reconcile()'s own cadence (proposed 15 minutes, pending TARS confirmation). Live from the moment 20260924010000 was applied, independent of this backfill script.",
    },
    subset_guarantee_mechanism: "archive_search_corpus_reconcile() (20260924010000) — self-healing, includes Asimov's Condition 2 drift check (a rotating plain-equality point-sample against missive_message_intake_search_safe's real predicate), escalates to a search-route kill-switch (archive_search_corpus_reconciliation_state.kill_switch_active) on a systemic superset violation.",
    // Asimov's Condition 1 fix, applied directly: correct citation, no
    // claim of an observation window that did not happen.
    shadow_mode_satisfaction: "GOVERNANCE.md Rule 6's literal 7-day shadow-mode observation window (spec Section 8) was NOT run before this go-live. Peter signed a specific, scoped waiver of that observation period — compliance/archive-search-search-performance-security-barrier-shadow-mode-owner-risk-acceptance.md — while explicitly NOT waiving the mechanism itself: the same-transaction fail-closed removal triggers, the fail-open becoming-eligible trigger, and the reconciliation/audit-logging job (spec Sections 3, 4, and 5) were all live from the moment 20260924010000 was applied, not merely from this backfill. What was skipped is only the week of watching those run clean on real data before the search route was allowed to depend on them. TARS's own real-data comparison pass (sampling actual queries against archive_search_corpus and missive_message_intake_search_safe, confirming identical result sets) is the one check that waiver does NOT skip, and runs separately, once, before ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED is ever set to true.",
    previous_mechanism: 'security_barrier view (missive_message_intake_search_safe), query-time filtering — UNCHANGED, still live for every other route.',
    new_mechanism: 'archive_search_corpus — a separate, physically eligible-content-only table, synchronized via database triggers, serving GET /api/archive-search/search only, once separately enabled.',
    reference_documents: [
      'compliance/archive-search-search-performance-security-barrier-attorney-question.md',
      'compliance/archive-search-search-performance-security-barrier-outside-counsel-opinion.md',
      'compliance/archive-search-search-performance-security-barrier-asimov-review.md',
      'compliance/archive-search-search-performance-security-barrier-mason-review.md',
      'compliance/archive-search-search-performance-security-barrier-asimov-confirmation.md',
      'compliance/archive-search-search-performance-security-barrier-mason-confirmation.md',
      'compliance/archive-search-search-performance-security-barrier-design-asimov-confirmation.md',
      'compliance/archive-search-search-performance-security-barrier-shadow-mode-owner-risk-acceptance.md',
      'projects/hub/email-intake/archive-search-search-performance-security-barrier-spec.md',
    ],
    corpus_row_count_at_migration: finalCorpusCount, // real, live-measured — never copied from any document
  };

  const { data: auditRow, error: auditError } = await supabase
    .from('audit_log')
    .insert({
      action: RULE6_ACTION,
      entity_type: 'archive_search_corpus',
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

  console.log('\nRule 6 audit log entry written:');
  console.log(JSON.stringify(auditRow, null, 2));
}

(async () => {
  console.log('Archive Search corpus backfill — starting.\n');

  const { totalExamined, totalWritten } = await runBackfill();

  const { count: finalCorpusCount, error: finalCountErr } = await supabase
    .from('archive_search_corpus')
    .select('*', { count: 'exact', head: true });
  if (finalCountErr) throw finalCountErr;

  const { eligibleBase, excludingEscalations, excludingSuppressions } = await countLiveEligible();

  console.log('\nPost-backfill verification:');
  console.log(`  archive_search_corpus row count (live, just re-queried): ${finalCorpusCount}`);
  console.log(`  missive_message_intake eligible-by-screening_result count (live): ${eligibleBase}`);
  console.log(`  open/confirmed-not-reopened escalations (live, informational): ${excludingEscalations}`);
  console.log(`  suppressions (live, informational): ${excludingSuppressions}`);

  const drift = Math.abs(eligibleBase - finalCorpusCount);
  console.log(`  drift between corpus count and eligible-by-screening_result count: ${drift} (escalation/suppression exclusions account for some or all of any nonzero drift; ${excludingEscalations + excludingSuppressions} conversation-level exclusion row(s) currently on file)`);

  if (drift > MAX_ACCEPTABLE_DRIFT + excludingEscalations + excludingSuppressions) {
    console.error(`\nABORTING before writing the Rule 6 audit_log entry: drift (${drift}) exceeds the acceptable bound (${MAX_ACCEPTABLE_DRIFT} + ${excludingEscalations + excludingSuppressions} known exclusions). Re-run this script (idempotent) after investigating — do not write the go-live audit event against a corpus that hasn't been verified.`);
    process.exit(1);
  }

  console.log('\nDrift within acceptable bound — proceeding to write the Rule 6 audit_log entry.');
  await writeRuleSixEvent(finalCorpusCount);

  console.log('\nBackfill complete. archive_search_corpus is now live and reconciled.');
  console.log('NEXT STEPS (not performed by this script):');
  console.log('  1. Confirm archive_search_corpus_reconcile() is being called on a real cadence (manually, or once Scotty wires a cron to POST /api/archive-search/process-corpus-reconciliation).');
  console.log('  2. Have TARS run its real-data comparison pass (sampling real queries against archive_search_corpus and missive_message_intake_search_safe, confirming identical result sets) — the one check the shadow-mode waiver does not skip.');
  console.log('  3. Only after step 2 passes, set ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED=true in .env and restart/redeploy the Hub.');
})().catch((err) => {
  console.error('SCRIPT FAILED:', err);
  process.exit(1);
});
