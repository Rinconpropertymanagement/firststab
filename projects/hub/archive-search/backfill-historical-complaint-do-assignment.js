#!/usr/bin/env node
/**
 * backfill-historical-complaint-do-assignment.js
 *
 * One-time fix — Mason's scoped governance review of the severity-tier
 * build, gap #3 of 3 (Jarvis-relayed build task, 2026-10-02). NOT a new
 * pipeline hook — a single, re-runnable cleanup pass.
 *
 * ============================================================================
 * THE GAP
 * ============================================================================
 * lib/significance-pass.js's createComplaintRow() only calls
 * lookupSingleDirectorOfOperations() to set owner_team_member_id for
 * discovery_context = 'live_pipeline' rows ("Section 6's hard gate — DO
 * assignment is live_pipeline only. A historical row NEVER gets
 * owner_team_member_id set, by construction," that function's own comment,
 * ~line 2310). That was a deliberate original design choice, not a bug — but
 * it leaves every historical_backfill row with no one actually assigned to
 * look at it, including the ones severity-tiered 'urgent' or 'worth_a_look'
 * after this same build's severity-tier work ran retroactively against the
 * historical corpus. This script is the one-time safety net historical rows
 * never got: the same DO assignment live rows get, applied once, after the
 * fact.
 *
 * discovery_context = 'historical_backfill' is a FIXED, one-time corpus — no
 * new historical_backfill row will ever be created (every new complaint from
 * here on is 'live_pipeline' or 'manual_staff', both already DO-assigned at
 * creation: see createComplaintRow() and complaint-tracking/router.js's own
 * manual-report insert). That is exactly why this is a standalone script,
 * never a new pipeline hook — there's nothing ongoing to hook into.
 *
 * ============================================================================
 * WHAT THIS DOES
 * ============================================================================
 * 1. Finds every complaint where:
 *      discovery_context = 'historical_backfill'
 *      AND severity_tier IN ('urgent', 'worth_a_look')
 *      AND owner_team_member_id IS NULL
 * 2. For each one, calls lookupSingleDirectorOfOperations() DIRECTLY — the
 *    exact same function significance-pass.js's live_pipeline branch calls,
 *    imported from complaint-tracking/lib/process-pending-messages.js, never
 *    reimplemented. Design Decision 12's rule, unchanged: if zero or more
 *    than one active Director of Operations holds the role at the moment of
 *    the call, the lookup returns {ok:false} rather than guessing.
 * 3. On a successful lookup: sets owner_team_member_id to the looked-up id.
 * 4. On a FAILED lookup (ok:false): mirrors the live pipeline's own
 *    fail-closed behavior at that exact branch (createComplaintRow(), `else
 *    insertRow.needs_human_call = true`) — sets needs_human_call = true on
 *    that row instead of silently leaving it unassigned with no trace. This
 *    is a deliberate judgment call, flagged here for review before the real
 *    write runs: "the same way the live pipeline does" is read as the same
 *    CODE BEHAVIOR at that branch, not just the happy path. If Peter/Jarvis
 *    want owner_team_member_id-only with no needs_human_call side effect,
 *    that's a one-line change (search SET_NEEDS_HUMAN_CALL_ON_LOOKUP_FAILURE
 *    below) — called out explicitly rather than silently decided.
 * 5. Writes one complaint_tracking.historical_do_assignment_backfill
 *    audit_log entry per row actually changed (never on a dry run, never for
 *    a row the lookup failed for with nothing else to record... actually see
 *    below: a failed-lookup row still gets its own audit entry, since
 *    needs_human_call flipping true is itself a real change worth a trail).
 *
 * The DO lookup is called fresh, PER ROW, not cached — if the lookup were
 * instead the same real-time snapshot that a live_pipeline conversation gets
 * at the single moment it's created, caching across hundreds of historical
 * rows processed in one run would be a meaningfully different contract than
 * "the same way the live pipeline does." A one-time cost against a fixed,
 * historical, (expected) low-hundreds-row corpus.
 *
 * ============================================================================
 * SAFE TO RE-RUN / IDEMPOTENT
 * ============================================================================
 * Same mechanism severity-batch.js's fetchUnassessedComplaints() already
 * relies on: the driver query's own `owner_team_member_id IS NULL` filter
 * means a row this script has already successfully assigned is never
 * selected again. A row left behind because the DO lookup failed (0 or 2+
 * active DOs at the time) STAYS eligible and is retried on the next run —
 * exactly the outcome wanted, since that's a transient org-chart state, not
 * a permanent one.
 *
 * ============================================================================
 * DO NOT RUN THIS FOR REAL YET
 * ============================================================================
 * Per the build task: build and dry-run test it, report the real dry-run
 * output, then WAIT for Peter's go-ahead (via Jarvis) on the actual write.
 * --dry-run (below) makes zero writes to `complaints` or `audit_log` — it
 * only reports exactly what a real run would do.
 *
 * Usage:
 *   node backfill-historical-complaint-do-assignment.js --dry-run   Report only, no writes.
 *   node backfill-historical-complaint-do-assignment.js             Apply it (DO NOT RUN until Peter says go).
 *   node backfill-historical-complaint-do-assignment.js --help      Show this help and exit.
 */

function loadDotEnv() {
  const path = require('path');
  const fs = require('fs');
  // Same candidate-path convention run-severity-batch.js's own loadDotEnv()
  // already uses — tries archive-search's own directory first, then walks
  // up to the real repo-root .env, so this runs correctly regardless of
  // which directory it's invoked from.
  const candidates = [
    path.join(__dirname, '.env'),
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '..', '..', '.env'),
  ];
  const envPath = candidates.find((p) => fs.existsSync(p)) || candidates[candidates.length - 1];
  require('dotenv').config({ path: envPath });
}

function printHelp() {
  console.log(`
backfill-historical-complaint-do-assignment.js

One-time fix (Mason governance review, gap #3): assigns a Director of
Operations (owner_team_member_id) to historical_backfill complaints that
severity-tiered 'urgent' or 'worth_a_look' but, by the original pipeline
design, never got a DO assigned the way live_pipeline/manual_staff
complaints do. Reuses lookupSingleDirectorOfOperations() directly — never
reimplements it. On a failed lookup (0 or 2+ active DOs right now), sets
needs_human_call = true instead, mirroring the live pipeline's own
fail-closed branch.

Safe to re-run: the driver query excludes any row already assigned, so a
second run only ever touches whatever is still eligible.

Usage:
  node backfill-historical-complaint-do-assignment.js --dry-run   Report only, no writes.
  node backfill-historical-complaint-do-assignment.js             Apply it for real.
  node backfill-historical-complaint-do-assignment.js --help      Show this help and exit.

DO NOT run without --dry-run until Peter has reviewed the dry-run output
and given an explicit go-ahead (relayed via Jarvis).
`);
}

// Flip to false only on explicit instruction from Peter/Jarvis to assign
// owner_team_member_id alone, with no needs_human_call side effect on a
// failed lookup. See this file's own header, point 4, for the reasoning.
const SET_NEEDS_HUMAN_CALL_ON_LOOKUP_FAILURE = true;

const BACKFILL_SCRIPT_VERSION = 'historical-do-assignment-backfill-v1';
const FETCH_PAGE_SIZE = 500; // Same bounded-round-trip instinct as severity-batch.js's own FETCH_PAGE_SIZE.

async function fetchEligibleRows(supabase) {
  const rows = [];
  for (let from = 0; ; from += FETCH_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('complaints')
      .select('id, property_id, severity_tier, needs_human_call')
      .eq('discovery_context', 'historical_backfill')
      .in('severity_tier', ['urgent', 'worth_a_look'])
      .is('owner_team_member_id', null)
      .order('id', { ascending: true })
      .range(from, from + FETCH_PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < FETCH_PAGE_SIZE) break;
  }
  return rows;
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  loadDotEnv();
  const { createClient } = require('@supabase/supabase-js');
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SB_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exitCode = 1;
    return;
  }
  const supabase = createClient(SB_URL, SB_KEY);
  const { lookupSingleDirectorOfOperations } = require('./../complaint-tracking/lib/process-pending-messages');

  console.log(isDryRun ? 'DRY RUN — no writes to complaints or audit_log.\n' : 'LIVE RUN — will write to complaints and audit_log.\n');

  const rows = await fetchEligibleRows(supabase);
  console.log(`Found ${rows.length} historical_backfill complaint(s) with severity_tier IN ('urgent','worth_a_look') and owner_team_member_id IS NULL.\n`);

  let assigned = 0;
  let flaggedForHuman = 0;
  const failures = [];
  const byTier = { urgent: 0, worth_a_look: 0 };

  for (const row of rows) {
    try {
      byTier[row.severity_tier] = (byTier[row.severity_tier] || 0) + 1;
      const doLookup = await lookupSingleDirectorOfOperations();

      if (doLookup.ok) {
        console.log(`[${row.id}] severity_tier=${row.severity_tier} -> owner_team_member_id = ${doLookup.teamMemberId}`);
        assigned++;
        if (!isDryRun) {
          const { error: updateErr } = await supabase
            .from('complaints')
            .update({ owner_team_member_id: doLookup.teamMemberId })
            .eq('id', row.id)
            .is('owner_team_member_id', null); // idempotency guard at the write itself, same posture severity-batch.js's own write already takes.
          if (updateErr) throw updateErr;

          await supabase.from('audit_log').insert({
            action: 'complaint_tracking.historical_do_assignment_backfill',
            entity_type: 'complaint',
            entity_id: row.id,
            actor_type: 'system',
            actor_id: BACKFILL_SCRIPT_VERSION,
            risk_level: 'medium',
            privacy_category: 'processing',
            property_id: row.property_id || null,
            details: { severity_tier: row.severity_tier, owner_team_member_id: doLookup.teamMemberId, script_version: BACKFILL_SCRIPT_VERSION },
          });
        }
      } else {
        console.log(`[${row.id}] severity_tier=${row.severity_tier} -> DO lookup failed (0 or 2+ active DOs) -> ${SET_NEEDS_HUMAN_CALL_ON_LOOKUP_FAILURE ? 'needs_human_call = true' : 'left untouched'}`);
        if (SET_NEEDS_HUMAN_CALL_ON_LOOKUP_FAILURE && !row.needs_human_call) {
          flaggedForHuman++;
          if (!isDryRun) {
            const { error: updateErr } = await supabase
              .from('complaints')
              .update({ needs_human_call: true })
              .eq('id', row.id)
              .is('owner_team_member_id', null);
            if (updateErr) throw updateErr;

            await supabase.from('audit_log').insert({
              action: 'complaint_tracking.historical_do_assignment_backfill',
              entity_type: 'complaint',
              entity_id: row.id,
              actor_type: 'system',
              actor_id: BACKFILL_SCRIPT_VERSION,
              risk_level: 'medium',
              privacy_category: 'processing',
              property_id: row.property_id || null,
              details: { severity_tier: row.severity_tier, owner_team_member_id: null, do_lookup_failed: true, needs_human_call_set: true, script_version: BACKFILL_SCRIPT_VERSION },
            });
          }
        }
      }
    } catch (err) {
      failures.push({ id: row.id, error: err.message });
      console.error(`[${row.id}] FAILED: ${err.message}`);
    }
  }

  console.log(`\nDone. ${rows.length} eligible row(s) examined.`);
  console.log(`  By tier: urgent=${byTier.urgent || 0}, worth_a_look=${byTier.worth_a_look || 0}`);
  console.log(`  ${isDryRun ? 'Would assign' : 'Assigned'} owner_team_member_id: ${assigned}`);
  console.log(`  ${isDryRun ? 'Would flag' : 'Flagged'} needs_human_call (failed DO lookup): ${flaggedForHuman}`);
  console.log(`  Failures: ${failures.length}`);
  if (failures.length) {
    console.log('Failure detail:', JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
