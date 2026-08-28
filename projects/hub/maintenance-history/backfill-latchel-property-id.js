#!/usr/bin/env node
/**
 * backfill-latchel-property-id.js
 * One-time (but safely re-runnable) backfill of properties.latchel_property_id,
 * built for Approval Briefing Phase 0 — see
 * projects/hub/approval-briefing-SPEC.md Section 2.4 and Section 12's
 * "Phase 0" entry. That column exists (added by
 * supabase/migrations/20260815010000_maintenance_history_schema.sql) but is
 * confirmed at 0% populated as of the Approval Briefing spec's research —
 * this script is what actually runs the matching logic and saves it.
 *
 * Matching logic is NOT new — it is the exact same logic already live at
 * POST /api/maintenance-history/internal/reconcile-properties (see
 * router.js, ~line 1075): Latchel's own `ref_property_id` field matches
 * Rincon's `properties.appfolio_id` directly, confirmed 1:1 during the
 * Approval Briefing spec's tenant/vendor research pass. That endpoint has
 * no dry-run mode and is meant to run repeatedly under cron once wired up
 * (not yet — no scheduler references it anywhere in this repo today).
 * This script is the CLI counterpart for the initial backfill: same
 * matching rule, same "never overwrite an existing match" guarantee, plus
 * a mandatory pre-write backup and a dry-run mode, matching the safety
 * discipline every prior migration/backfill in this project has used
 * (see projects/content-engine/backfill-published-posts.js). If the
 * matching rule ever changes, update both this file and router.js's
 * reconcile-properties endpoint — they are intentionally duplicated, not
 * shared, for the same reason backfill-published-posts.js gives for its
 * own TOPIC_LABELS duplication.
 *
 * Usage:
 *   node backfill-latchel-property-id.js --dry-run   Report what would
 *                                                     match, write nothing.
 *   node backfill-latchel-property-id.js              Back up current state,
 *                                                     then write matches.
 *   node backfill-latchel-property-id.js --help
 */

// Same .env resolution convention as server.js and the other backfill
// scripts in this repo: a local .env next to this file first, else the
// shared project-root .env (three levels up from
// projects/hub/maintenance-history/).
{
  const path = require('path');
  const fs = require('fs');
  const localEnvPath = path.join(__dirname, '.env');
  const sharedEnvPath = path.join(__dirname, '..', '..', '..', '.env');
  const envPath = fs.existsSync(localEnvPath) ? localEnvPath : sharedEnvPath;
  require('dotenv').config({ path: envPath });
}

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const latchel = require('./lib/latchel-connector');

const BACKUP_DIR = path.join(__dirname, 'backfill-backups');

function printHelp() {
  console.log(`
backfill-latchel-property-id.js — one-time (safely re-runnable) backfill of
properties.latchel_property_id, using the already-confirmed 1:1 match
between Latchel's ref_property_id and AppFolio's property ID
(properties.appfolio_id). Never overwrites a property that already has a
latchel_property_id set.

Flags:
  --dry-run   Fetch from Latchel + Supabase, report exactly what would be
              matched and what wouldn't, but write nothing and take no
              backup.
  --help      Show this help and exit.

With no flags: takes a backup of the current properties table (id, name,
appfolio_id, latchel_property_id) to ${path.relative(process.cwd(), BACKUP_DIR)}/,
then writes the matched latchel_property_id values.

Safe to re-run: matching is idempotent — a property that already has
latchel_property_id set is left untouched, and a fresh run only fills in
what's still missing (e.g. after Rincon or Latchel add new properties).
`);
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--dry-run') args.dryRun = true;
  }
  return args;
}

function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    console.error(`[backfill] Missing required environment variable(s): ${missing.join(', ')}`);
    console.error('[backfill] Set these in the shared .env at the project root (see .env.example).');
    process.exit(1);
  }
}

/**
 * Reproduces the exact matching rule from router.js's
 * POST /internal/reconcile-properties: Latchel's ref_property_id ==
 * Rincon's properties.appfolio_id, never overwriting an existing match.
 * Returns full classification, not just a count, so a dry run can report
 * every property that doesn't match cleanly instead of silently skipping it.
 */
function classifyMatches(latchelProperties, rinconProperties) {
  const byAppfolioId = new Map(rinconProperties.map((p) => [String(p.appfolio_id), p]));

  const alreadyMatched = []; // Rincon property that already had latchel_property_id set
  const noRefId = [];        // Latchel property with no ref_property_id at all
  const noRinconMatch = [];  // Latchel property whose ref_property_id matches no Rincon appfolio_id

  // Rincon target (not already matched) -> every candidate Latchel property
  // that maps to it. Grouped first, not written immediately, because more
  // than one Latchel property can point at the same Rincon appfolio_id
  // (confirmed live below — apparent per-unit Latchel property records
  // against one AppFolio-level building record). Picking one of several
  // candidates automatically would be forcing a match, exactly what the
  // Approval Briefing spec's Section 2.4 and this script's own job
  // explicitly rule out.
  const candidatesByRinconId = new Map();

  for (const lp of latchelProperties) {
    const refPropertyId = lp.ref_property_id != null ? String(lp.ref_property_id) : null;
    const latchelLabel = lp.name || lp.property_name || lp.address || `latchel property_id ${lp.property_id}`;

    if (!refPropertyId) {
      noRefId.push({ latchel_property_id: lp.property_id, label: latchelLabel });
      continue;
    }
    const rp = byAppfolioId.get(refPropertyId);
    if (!rp) {
      noRinconMatch.push({ latchel_property_id: lp.property_id, ref_property_id: refPropertyId, label: latchelLabel });
      continue;
    }
    if (rp.latchel_property_id) {
      alreadyMatched.push(rp);
      continue;
    }
    if (!candidatesByRinconId.has(rp.id)) candidatesByRinconId.set(rp.id, { rp, candidates: [] });
    candidatesByRinconId.get(rp.id).candidates.push({ latchelPropertyId: String(lp.property_id), label: latchelLabel });
  }

  const toWrite = [];       // { rinconId, rinconName, appfolioId, latchelPropertyId }
  const ambiguous = [];     // { rinconId, rinconName, appfolioId, candidates: [...] } — reported, never written

  for (const { rp, candidates } of candidatesByRinconId.values()) {
    if (candidates.length === 1) {
      toWrite.push({
        rinconId: rp.id,
        rinconName: rp.name,
        appfolioId: rp.appfolio_id,
        latchelPropertyId: candidates[0].latchelPropertyId,
      });
    } else {
      ambiguous.push({ rinconId: rp.id, rinconName: rp.name, appfolioId: rp.appfolio_id, candidates });
    }
  }

  const accountedForRinconIds = new Set([
    ...toWrite.map((m) => m.rinconId),
    ...alreadyMatched.map((rp) => rp.id),
    ...ambiguous.map((a) => a.rinconId),
  ]);
  const rinconUnmatched = rinconProperties.filter((rp) => !accountedForRinconIds.has(rp.id));

  return { toWrite, ambiguous, alreadyMatched, noRefId, noRinconMatch, rinconUnmatched };
}

async function writeBackup(rinconProperties) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `properties-latchel_property_id-${ts}.json`);
  const snapshot = rinconProperties.map((p) => ({
    id: p.id,
    name: p.name,
    appfolio_id: p.appfolio_id,
    latchel_property_id: p.latchel_property_id,
  }));
  fs.writeFileSync(backupPath, JSON.stringify({ taken_at: ts, row_count: snapshot.length, properties: snapshot }, null, 2));
  return backupPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  requireEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'LATCHEL_API_KEY']);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  console.log('[backfill] Fetching properties from Latchel (GET-only)...');
  const latchelProperties = await latchel.listProperties();
  console.log(`[backfill] ${latchelProperties.length} properties returned by Latchel.`);

  console.log('[backfill] Fetching properties from Supabase...');
  const { data: rinconProperties, error } = await supabase
    .from('properties')
    .select('id, name, appfolio_id, latchel_property_id')
    .not('appfolio_id', 'is', null);
  if (error) {
    console.error(`[backfill] Supabase read failed: ${error.message}`);
    process.exit(1);
  }
  console.log(`[backfill] ${rinconProperties.length} Rincon properties have an appfolio_id to match against.`);

  const result = classifyMatches(latchelProperties, rinconProperties);
  // Match rate is stated against Rincon's own property count, not
  // Latchel's — that's what Approval Briefing Section 2.4 actually needs
  // resolved (property_id on approval_briefings), and Latchel's count
  // includes duplicate/stale property records that don't correspond to a
  // distinct Rincon property at all (see "no Rincon match" section below).
  const rinconMatchable = result.toWrite.length + result.alreadyMatched.length;
  const rinconMatchRate = rinconProperties.length > 0
    ? ((rinconMatchable / rinconProperties.length) * 100).toFixed(1)
    : '0.0';

  console.log('\n--- MATCH SUMMARY ---');
  console.log(`Latchel properties seen:                       ${latchelProperties.length}`);
  console.log(`Rincon properties with an appfolio_id:          ${rinconProperties.length}`);
  console.log(`Already matched (untouched):                    ${result.alreadyMatched.length}`);
  console.log(`${args.dryRun ? 'Would newly match (unambiguous, 1:1)' : 'Newly matched (unambiguous, 1:1)'}:  ${result.toWrite.length}`);
  console.log(`Ambiguous — Rincon property with 2+ candidate Latchel matches, NOT written: ${result.ambiguous.length}`);
  console.log(`Latchel property missing ref_property_id:       ${result.noRefId.length}`);
  console.log(`Latchel ref_property_id with no Rincon match:   ${result.noRinconMatch.length}`);
  console.log(`Rincon match rate after this run (unambiguous matches / Rincon properties): ${rinconMatchRate}%`);
  console.log(`Rincon properties with no candidate at all:     ${result.rinconUnmatched.length}`);

  if (result.ambiguous.length > 0) {
    console.log('\n--- AMBIGUOUS: RINCON PROPERTY WITH MULTIPLE CANDIDATE LATCHEL MATCHES (not forced, needs a human decision) ---');
    result.ambiguous.forEach((a) => {
      console.log(`  rincon id=${a.rinconId}  appfolio_id=${a.appfolioId}  "${a.rinconName}"`);
      a.candidates.forEach((c) => console.log(`      candidate: latchel property_id=${c.latchelPropertyId}  "${c.label}"`));
    });
  }
  if (result.noRinconMatch.length > 0) {
    console.log('\n--- LATCHEL PROPERTIES WITH NO RINCON MATCH (not forced, reported for review) ---');
    result.noRinconMatch.forEach((r) =>
      console.log(`  latchel property_id=${r.latchel_property_id}  ref_property_id=${r.ref_property_id}  "${r.label}"`)
    );
  }
  if (result.noRefId.length > 0) {
    console.log('\n--- LATCHEL PROPERTIES WITH NO ref_property_id AT ALL ---');
    result.noRefId.forEach((r) => console.log(`  latchel property_id=${r.latchel_property_id}  "${r.label}"`));
  }
  if (result.rinconUnmatched.length > 0) {
    console.log('\n--- RINCON PROPERTIES STILL UNMATCHED (has appfolio_id, no Latchel counterpart found) ---');
    result.rinconUnmatched.forEach((rp) => console.log(`  rincon id=${rp.id}  appfolio_id=${rp.appfolio_id}  "${rp.name}"`));
  }

  if (args.dryRun) {
    console.log('\n[backfill] --dry-run: nothing written, no backup taken.');
    return;
  }

  if (result.toWrite.length === 0) {
    console.log('\n[backfill] Nothing new to write. Skipping backup (no changes to protect against).');
    return;
  }

  const backupPath = await writeBackup(rinconProperties);
  console.log(`\n[backfill] Backup written: ${backupPath} (${rinconProperties.length} rows).`);

  console.log(`[backfill] Writing ${result.toWrite.length} new latchel_property_id match(es)...`);
  let written = 0;
  const writeErrors = [];
  for (const m of result.toWrite) {
    // .is('latchel_property_id', null) is an extra guard against writing
    // over a match set by something else between the read above and now
    // (e.g. the reconcile-properties cron route running concurrently) —
    // belt-and-suspenders on top of the in-memory check already done.
    // NOTE: count: 'exact' was tested live against this project's
    // supabase-js version and came back null even on a confirmed no-op —
    // not a reliable signal here. `data` (the updated row, via .select())
    // came back correctly as [] for the no-op and would be a 1-element
    // array for a real match, so success is checked off data.length, not
    // count.
    const { error: updErr, data: updData } = await supabase
      .from('properties')
      .update({ latchel_property_id: m.latchelPropertyId })
      .eq('id', m.rinconId)
      .is('latchel_property_id', null)
      .select('id');
    if (updErr) {
      writeErrors.push({ rinconId: m.rinconId, name: m.rinconName, error: updErr.message });
      continue;
    }
    if (!updData || updData.length === 0) {
      writeErrors.push({ rinconId: m.rinconId, name: m.rinconName, error: 'no row updated — already matched by something else since the read above' });
      continue;
    }
    written++;
  }

  console.log(`\n--- WRITE RESULT ---`);
  console.log(`Written: ${written} of ${result.toWrite.length}`);
  if (writeErrors.length > 0) {
    console.log(`Errors: ${writeErrors.length}`);
    writeErrors.forEach((e) => console.log(`  rincon id=${e.rinconId} "${e.name}": ${e.error}`));
  }
  console.log(`\nTo re-run periodically (e.g. after new properties are added in AppFolio or Latchel), just run this script again with no flags — it only fills in what's still missing.`);
}

main().catch((err) => {
  console.error(`\n[ERROR] ${err.message}`);
  process.exit(1);
});
