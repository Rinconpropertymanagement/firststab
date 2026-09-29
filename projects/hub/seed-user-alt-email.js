#!/usr/bin/env node
/**
 * seed-user-alt-email.js
 *
 * One-time (but safely re-runnable) fix for the Regina Franco Mendez audit
 * attribution gap: she logs into the Hub under two real emails — her
 * current one (regina@rinconmanagement.com) and an old vendor email
 * (regina@quickturnmaintenance.com), which is the only one on file for her
 * in `users` today. Every audit-logging write path resolves "who did this"
 * via a locally-defined lookupUserId(email) helper (duplicated per-file by
 * this codebase's existing convention — see complaint-tracking/router.js,
 * archive-search/router.js, property-360/router.js,
 * owner-tenant-notes/router.js, maintenance-history/router.js) that looks
 * up the login email against `users.email` OR `users.alt_email`. When she
 * logs in under her Rincon email, the OR-match only works once alt_email is
 * actually set — this script does that one seed.
 *
 * Seeds alt_email = 'regina@rinconmanagement.com' on the users row where
 * email = 'regina@quickturnmaintenance.com'. Confirms the exact row first
 * with a read-only SELECT and prints what it found before writing anything.
 * Idempotent: checks the row's current alt_email before writing and skips
 * it if already correct.
 *
 * GOVERNANCE NOTE: this script used to also carry a second step that
 * retroactively rewrote existing audit_log.performed_by values for rows
 * logged before alt_email existed. Asimov reviewed that step and rejected
 * it — audit_log is append-only/immutable after insert by design
 * (GOVERNANCE.md Rule 4; table comment in supabase/migrations/
 * 20260720000003_foundation.sql, ~line 311-314), and attribution gaps for
 * already-written rows are fixed at read time instead (see
 * audits/router.js's fetchPropertyThreeSixtyViewsSection, which resolves
 * performed_by IS NULL rows against actor_id at display time, without
 * ever writing to audit_log). That step was removed from this file
 * entirely, not disabled, so there's no dead code path that could get
 * re-enabled later and run an UPDATE against audit_log. This file now only
 * ever reads and writes to `users`.
 *
 * Requires `users.alt_email` to already exist (that migration is written
 * and applied separately — this script does NOT create it). Run against a
 * database that doesn't have it yet and Supabase will fail loudly with a
 * clear "column does not exist" error rather than silently doing the
 * wrong thing.
 *
 * Usage:
 *   node seed-user-alt-email.js --dry-run   Report what would change,
 *                                            write nothing.
 *   node seed-user-alt-email.js              Seed Regina's alt_email.
 *   node seed-user-alt-email.js --help
 */

// Same .env resolution convention as setup-notify-oauth.js: the shared
// project-root .env, two levels up from projects/hub/.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { createClient } = require('@supabase/supabase-js');

const REGINA_OLD_EMAIL = 'regina@quickturnmaintenance.com';
const REGINA_NEW_EMAIL = 'regina@rinconmanagement.com';

function printHelp() {
  console.log(`
seed-user-alt-email.js — one-time (safely re-runnable) fix for the Regina
Franco Mendez audit attribution gap: seeds her alt_email onto her existing
users row so lookupUserId's email-OR-alt_email match resolves her actions
under either address going forward.

Flags:
  --dry-run   Read from Supabase and report exactly what would change, but
              write nothing.
  --help      Show this help and exit.

With no flags:
  Seeds alt_email = '${REGINA_NEW_EMAIL}' on the users row where
  email = '${REGINA_OLD_EMAIL}' (skipped if already set correctly).

Requires users.alt_email to already exist in the database (added by a
separate migration — this script does not create it).
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
    console.error(`[seed] Missing required environment variable(s): ${missing.join(', ')}`);
    console.error('[seed] Set these in the shared .env at the project root (see .env.example).');
    process.exit(1);
  }
}

// Seeds Regina's own alt_email. Returns without writing (dry-run or
// already-correct) or after a successful write.
async function seedReginaAltEmail(supabase, dryRun) {
  console.log(`[seed] Looking up users row for ${REGINA_OLD_EMAIL}...`);
  const { data: row, error } = await supabase
    .from('users')
    .select('id, name, email, alt_email')
    .eq('email', REGINA_OLD_EMAIL)
    .maybeSingle();

  if (error) {
    console.error(`[seed] Read failed: ${error.message}`);
    process.exit(1);
  }
  if (!row) {
    console.log(`[seed] No users row found with email = ${REGINA_OLD_EMAIL}. Nothing to do.`);
    return;
  }

  console.log(`[seed] Found: id=${row.id}, name="${row.name}", email=${row.email}, alt_email=${row.alt_email ?? 'null'}`);

  if (row.alt_email === REGINA_NEW_EMAIL) {
    console.log('[seed] alt_email is already correct — nothing to write.');
    return;
  }
  if (row.alt_email && row.alt_email !== REGINA_NEW_EMAIL) {
    console.warn(`[seed] WARNING: alt_email is already set to a DIFFERENT value ("${row.alt_email}") than expected ("${REGINA_NEW_EMAIL}"). Not overwriting — resolve this by hand before re-running.`);
    return;
  }

  if (dryRun) {
    console.log(`[seed] [dry-run] Would set alt_email = "${REGINA_NEW_EMAIL}" on users.id = ${row.id}.`);
    return;
  }

  const { error: writeError } = await supabase
    .from('users')
    .update({ alt_email: REGINA_NEW_EMAIL })
    .eq('id', row.id);

  if (writeError) {
    console.error(`[seed] Write failed: ${writeError.message}`);
    process.exit(1);
  }
  console.log(`[seed] Set alt_email = "${REGINA_NEW_EMAIL}" on users.id = ${row.id}.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  requireEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (args.dryRun) {
    console.log('[seed] Running in --dry-run mode: reads only, nothing will be written.\n');
  }

  await seedReginaAltEmail(supabase, args.dryRun);

  console.log('\n[seed] Done.');
}

main().catch((err) => {
  console.error('[seed] Unexpected error:', err);
  process.exit(1);
});
