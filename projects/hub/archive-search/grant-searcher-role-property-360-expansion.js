#!/usr/bin/env node
/**
 * grant-searcher-role-property-360-expansion.js
 *
 * WRITTEN, NOT RUN. This script has not been executed against Supabase —
 * Peter reviews the printed grant list and runs it himself (same
 * discipline this repo already follows for every migration: Neo/Tron
 * write the file, Peter applies it). Nothing in this file has touched
 * production as part of writing it.
 *
 * WHY THIS SCRIPT EXISTS
 * Grants Archive Search's 'searcher' role (team_member_tool_roles,
 * tool='archive_search') to the Hub's active population, per Asimov's
 * condition 1 on the Property 360 search-widget build:
 *   "Grant `searcher` role (not a bypass of the role table) to the
 *   current Hub population via `team_member_tool_roles`..."
 * (compliance/archive-search-property-360-embed-asimov-confirmation.md,
 * "Rule 6 mechanics required in the build spec," item 1). This is the
 * real access mechanism the new Property 360 search widget checks
 * (property-360/router.js's attachArchiveSearchRole gate,
 * archive-search/router.js's requireArchiveSearchAccess on the search/
 * message routes) — not a parallel bypass gate.
 *
 * FULL AUTHORIZATION CHAIN — read before running this
 *   - compliance/archive-search-property-360-embed-owner-risk-acceptance.md
 *     (original + all three addenda) — Peter's owner risk-acceptance,
 *     reaffirmed live twice, then reaffirmed a third time once both
 *     specialists below moved from NOT CLEARED to CLEARED WITH CONDITIONS.
 *   - compliance/archive-search-property-360-access-expansion-outside-counsel-opinion.md
 *     — the opinion that closed the population-ceiling question both
 *     specialists' NOT CLEARED verdicts had anchored on.
 *   - compliance/archive-search-property-360-embed-asimov-confirmation.md
 *     — VERDICT: CLEARED WITH CONDITIONS (governance).
 *   - compliance/archive-search-property-360-embed-mason-confirmation.md
 *     — VERDICT: CLEARED WITH CONDITIONS (Fair Housing/legal).
 *
 * WHAT THIS SCRIPT DOES NOT RESOLVE — READ THIS BEFORE RUNNING
 *   1. Mason's condition 1: report and confirm, via the existing
 *      archive_search_escalations mechanism, the specific
 *      accommodation/harassment/eviction thread (and ideally the other
 *      four) TARS's validation sample already found — BEFORE the broader
 *      population can reach it. Peter has explicitly declined this
 *      (owner-risk-acceptance's third addendum, verbatim: "no dont
 *      suppress"). Running this script grants search access to everyone
 *      below WITHOUT that thread being excluded. This is a knowing owner
 *      override, on the record — not this script's decision to make or
 *      unmake, and not something this script implements.
 *   2. Mason's condition 2: independent verification (Asimov's kind, "not
 *      mine to close by reading a document") that Fair Housing/system-use
 *      training and a real escalation path actually exist TODAY for the
 *      people this script grants access to. Nothing in the compliance/
 *      chain as of this writing shows that check was done. This script
 *      does not perform it — it only grants the role.
 *   3. Asimov's condition 5: confirm the granted population is in fact
 *      limited to staff with property-management job responsibilities.
 *      team_members carries no job-title column, so this script cannot
 *      verify that programmatically — it prints the full email/name list
 *      below for Peter to eyeball before running, per Asimov's own "note
 *      this for Peter, don't block the build on verifying every account's
 *      job title."
 *   4. Folding this grant into normal employee provisioning going forward
 *      (Asimov's own suggested model, condition 1) — this script is a
 *      one-time backfill for the population active today, not that
 *      ongoing process change.
 *
 * WHAT THIS DOES
 * 1. Reads every team_members row where is_active = true — Property
 *    360's own definition of "the Hub population" (property-360/
 *    router.js's file header: "anyone logged into the Hub at all can
 *    open /property-360").
 * 2. Reads every existing team_member_tool_roles row where tool =
 *    'archive_search' — today, per the owner-risk-acceptance document's
 *    own live-queried numbers, exactly 2 rows (peter@rinconmanagement.com
 *    and stephen@rinconmanagement.com, both role='admin').
 * 3. Computes the active members with NO existing archive_search role at
 *    all — existing admins are never touched or downgraded.
 * 4. Prints that full list (email + name) and stops for review — nothing
 *    is written until the printed list has been read.
 * 5. INSERTs one team_member_tool_roles row per person in that list,
 *    role='searcher'.
 * 6. Re-reads and verifies the insert.
 * 7. Writes ONE Rule 6 audit_log entry, action
 *    'archive_search.rule6_population_expanded', citing this exact
 *    authorization chain and both open items above by name — same
 *    "reference_documents + honest reset_disposition" shape as
 *    reset-layer1-removal-310.js and reset-self-report-recalibration-
 *    119.js before it.
 *
 * SAFE TO RE-RUN: step 3's "no existing role" filter means a second run
 * finds nobody left to grant (existing 'searcher'/'admin' rows are never
 * touched) and exits cleanly without writing a second audit_log entry.
 *
 * SANITY CHECK, NOT A HARD ABORT: unlike reset-layer1-removal-310.js and
 * reset-self-report-recalibration-119.js (which reconstruct one fixed
 * historical scope and correctly hard-abort on any mismatch), this
 * script's population is live and, per Asimov's own condition, expected
 * to keep growing as Rincon hires — so it warns rather than aborts if the
 * count found is far outside "~9," rather than hard-coding a number that
 * would break the next time headcount changes.
 */

require('dotenv').config({ path: '/Users/petermckenzie/CODE/firststab/.env' });
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const TOOL = 'archive_search';
const GRANTED_ROLE = 'searcher';
const EXPECTED_APPROX_COUNT = 9; // "the ~9 Hub accounts" — Asimov's/Mason's own framing; soft check only, see header
const SANITY_WARN_ABOVE = 30; // well outside "~9" — worth a human look before proceeding, not a hard stop

async function fetchActiveTeamMembers() {
  const rows = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('team_members')
      .select('id, email, full_name, is_active')
      .eq('is_active', true)
      .order('email', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function fetchExistingArchiveSearchRoles() {
  const { data, error } = await supabase
    .from('team_member_tool_roles')
    .select('team_member_id, role')
    .eq('tool', TOOL);
  if (error) throw error;
  return data || [];
}

(async () => {
  const activeMembers = await fetchActiveTeamMembers();
  const existingRoles = await fetchExistingArchiveSearchRoles();
  const alreadyGrantedIds = new Set(existingRoles.map((r) => r.team_member_id));

  const toGrant = activeMembers.filter((m) => !alreadyGrantedIds.has(m.id));

  console.log(`Active Hub team_members: ${activeMembers.length}`);
  console.log(`Existing tool='${TOOL}' roles (untouched by this script): ${existingRoles.length}`);
  existingRoles.forEach((r) => console.log(`  team_member_id=${r.team_member_id} role=${r.role}`));
  console.log(`\nTo grant '${GRANTED_ROLE}' (active, no existing archive_search role): ${toGrant.length}`);
  toGrant.forEach((m) => console.log(`  ${m.email}${m.full_name ? ' — ' + m.full_name : ''}`));

  if (toGrant.length === 0) {
    console.log('\nNothing to grant — every active team member already holds an archive_search role. Exiting without writing anything.');
    return;
  }

  if (Math.abs(toGrant.length - EXPECTED_APPROX_COUNT) > SANITY_WARN_ABOVE - EXPECTED_APPROX_COUNT) {
    console.warn(
      `\nWARNING: ${toGrant.length} people would be granted 'searcher' — that's well outside the "~9" this build's ` +
      `compliance chain (Asimov's and Mason's confirmations) was reasoned against. This is a warning, not an abort. ` +
      `Read the printed list above before proceeding; consider whether is_active's real population has grown or ` +
      `changed in a way the compliance chain should see before this runs.`
    );
  }

  console.log('\n--- Proceeding to INSERT the rows above. Ctrl+C now to abort before anything is written. ---\n');

  const insertRows = toGrant.map((m) => ({
    team_member_id: m.id,
    tool: TOOL,
    role: GRANTED_ROLE,
    granted_by: 'peter_mckenzie_owner_decision',
  }));

  const { data: inserted, error: insertError } = await supabase
    .from('team_member_tool_roles')
    .insert(insertRows)
    .select('id, team_member_id, role');
  if (insertError) throw insertError;

  console.log(`INSERT complete: ${inserted.length} new team_member_tool_roles rows (tool='${TOOL}', role='${GRANTED_ROLE}').`);

  // Post-write verification — re-read the exact set granted, confirm every
  // targeted member now has a row, same "verify after writing" discipline
  // as reset-layer1-removal-310.js.
  const { data: verifyRows, error: verifyError } = await supabase
    .from('team_member_tool_roles')
    .select('team_member_id, role')
    .eq('tool', TOOL)
    .in('team_member_id', toGrant.map((m) => m.id));
  if (verifyError) throw verifyError;
  const verifiedIds = new Set(verifyRows.filter((r) => r.role === GRANTED_ROLE).map((r) => r.team_member_id));
  const allVerified = toGrant.every((m) => verifiedIds.has(m.id));
  console.log(`Post-insert check: ${verifiedIds.size} / ${toGrant.length} target members now hold role='${GRANTED_ROLE}' for tool='${TOOL}'. All verified: ${allVerified}.`);

  // ── Rule 6 audit_log entry — same shape as reset-layer1-removal-310.js
  // and reset-self-report-recalibration-119.js: a full, honest
  // reference_documents list and a reset_disposition-equivalent block
  // that states plainly what was NOT resolved by this action, not just
  // what was.
  const auditDetails = {
    decision: `GOVERNANCE.md Rule 6 Critical-tier change (permission-tier change): archive_search 'searcher' role granted via team_member_tool_roles to ${toGrant.length} active Hub team member(s) who previously held no archive_search role, expanding Archive Search's authorized population beyond the 2 existing named admins (peter@rinconmanagement.com, stephen@rinconmanagement.com). This is the same role table Property 360's new search widget (property-360/router.js's attachArchiveSearchRole gate) and archive-search/router.js's own requireArchiveSearchAccess check against — a real grant, not a bypass.`,
    decided_by: 'Peter McKenzie, owner',
    reviewed_by: "Outside counsel (compliance/archive-search-property-360-access-expansion-outside-counsel-opinion.md); Asimov (governance) confirmation pass, VERDICT: CLEARED WITH CONDITIONS; Mason (legal/Fair Housing) confirmation pass, VERDICT: CLEARED WITH CONDITIONS — all 2026-09-24.",
    reference_documents: [
      'compliance/archive-search-property-360-embed-owner-risk-acceptance.md',
      'compliance/archive-search-property-360-embed-asimov-review.md',
      'compliance/archive-search-property-360-embed-mason-review.md',
      'compliance/archive-search-property-360-access-expansion-attorney-question.md',
      'compliance/archive-search-property-360-access-expansion-outside-counsel-opinion.md',
      'compliance/archive-search-property-360-embed-asimov-confirmation.md',
      'compliance/archive-search-property-360-embed-mason-confirmation.md',
    ],
    open_items_not_resolved_by_this_grant: {
      mason_condition_1_suppression_declined: "Mason's confirmation asks that the accommodation/harassment/eviction thread (and ideally the other four validation-sample findings) be reported and confirmed via archive_search_escalations, excluding it from search, BEFORE the broader population can reach it. Peter explicitly declined this — owner-risk-acceptance's third addendum, verbatim: \"no dont suppress.\" That thread remains reachable by the population granted here, by explicit, informed owner decision, not by oversight.",
      mason_condition_2_training_escalation_path_unverified: "Mason's confirmation separately asks Asimov to independently verify that Fair Housing/system-use training and a real escalation path actually exist today for this population, the same 'queried live, not taken on faith' standard used to verify team_member_tool_roles itself. Nothing in the compliance/ record as of this script shows that verification happened. Not performed by this script.",
      asimov_condition_5_job_roles_not_individually_verified: "Asimov's confirmation asks that the granted population be confirmed as limited to staff with property-management job responsibilities. team_members has no job-title column; this script cannot check that programmatically. The full email/name list was printed to the console for Peter's own review before this script wrote anything, per Asimov's own 'note this for Peter, don't block the build on verifying every account's job title.'",
    },
    grant_disposition: {
      tool: TOOL,
      role_granted: GRANTED_ROLE,
      active_team_members_at_grant_time: activeMembers.length,
      existing_roles_untouched: existingRoles.length,
      newly_granted_count: toGrant.length,
      newly_granted_emails: toGrant.map((m) => m.email),
      rows_inserted: inserted.length,
      all_verified_post_insert: allVerified,
    },
  };

  const { data: auditRow, error: auditError } = await supabase
    .from('audit_log')
    .insert({
      action: 'archive_search.rule6_population_expanded',
      entity_type: 'team_member_tool_roles',
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
