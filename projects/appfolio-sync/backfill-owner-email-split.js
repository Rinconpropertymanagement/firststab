'use strict';

/**
 * backfill-owner-email-split.js
 * Rincon Management — one-time data correction, NOT a schema migration.
 *
 * Fixes the 132 (as of 2026-10-02) existing owners.email rows that
 * already hold a broken, verbatim comma-joined string like
 * "ayad321@gmail.com, charlottefnp@hotmail.com" — the result of
 * syncOwnerDirectory() storing AppFolio's owner_directory `email` field
 * as-is, with no splitting (sync.js, ~line 912, fixed going forward in
 * the same change that adds this script).
 *
 * Needs supabase/migrations/20261002000000_tenant_owner_emails_schema.sql
 * already applied (owner_emails table must exist) before this runs.
 *
 * What it does, per affected owner (any owners.email containing a comma):
 *   1. Splits the string on commas, trims each piece, drops empties.
 *   2. Upserts every address into owner_emails (first address flagged
 *      is_primary = true), source = 'owner_directory_comma_split_backfill'.
 *      owner_id is set directly — this script queries existing owners
 *      rows, which already have a real UUID id, so unlike the nightly
 *      sync's two-phase raw-ID-then-resolve path, no separate resolution
 *      function call is needed here.
 *   3. Updates owners.email to just the first address — so the column
 *      stops being a broken literal, matching the convention
 *      tenants.email already follows (first/primary address only).
 *
 * Every address is preserved (split into owner_emails); nothing is lost.
 * owners.email's stored VALUE does change for exactly these rows — this
 * is a deliberate data correction, not a side effect, and the whole
 * reason this is a separate script instead of being folded into the
 * schema migration: Neo's migrations are additive DDL only, per this
 * project's own precedent (20260928000000_add_alt_email_to_users.sql kept
 * value-setting out of its migration; 20260813000001_lease_tenants.sql
 * kept its backfill out of its migration too, both deferring to a
 * separate script, run only after being tested on a copy first).
 *
 * Per-row isolation: one bad owner row must not abort the whole backfill
 * (same discipline as sync.js's upsertGroupWithRowFallback()).
 *
 * Usage:
 *   node backfill-owner-email-split.js --dry-run   Print what would change, no writes
 *   node backfill-owner-email-split.js             Apply it
 *
 * Safe to re-run: upserts are idempotent (ON CONFLICT (appfolio_owner_id,
 * email) is a no-op for an address already recorded), and re-normalizing
 * owners.email to its own already-split first address is a no-op too.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SB_URL || !SB_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SB_URL, SB_KEY);
const isDryRun = process.argv.includes('--dry-run');

function splitEmails(raw) {
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  console.log(isDryRun ? 'DRY RUN — no writes.\n' : 'LIVE RUN — will write to owners and owner_emails.\n');

  const { data: owners, error } = await supabase
    .from('owners')
    .select('id, appfolio_id, email')
    .not('email', 'is', null)
    .like('email', '%,%');

  if (error) throw error;

  console.log(`Found ${owners.length} owners with a comma-joined email string.\n`);

  let ok = 0;
  const failures = [];

  for (const owner of owners) {
    try {
      const addresses = splitEmails(owner.email);
      if (!addresses.length) continue;

      const emailRows = addresses.map((email, i) => ({
        appfolio_owner_id: owner.appfolio_id,
        owner_id: owner.id,
        email,
        is_primary: i === 0,
        source: 'owner_directory_comma_split_backfill',
      }));

      console.log(`[${owner.appfolio_id}] "${owner.email}" -> owner_emails: ${JSON.stringify(addresses)}, owners.email -> "${addresses[0]}"`);

      if (!isDryRun) {
        const { error: upsertErr } = await supabase
          .from('owner_emails')
          .upsert(emailRows, { onConflict: 'appfolio_owner_id,email' });
        if (upsertErr) throw upsertErr;

        const { error: updateErr } = await supabase
          .from('owners')
          .update({ email: addresses[0] })
          .eq('id', owner.id);
        if (updateErr) throw updateErr;
      }

      ok++;
    } catch (err) {
      failures.push({ appfolio_id: owner.appfolio_id, error: err.message });
      console.error(`[${owner.appfolio_id}] FAILED: ${err.message}`);
    }
  }

  console.log(`\nDone. ${ok} owners processed successfully, ${failures.length} failed.`);
  if (failures.length) {
    console.log('Failures:', JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
