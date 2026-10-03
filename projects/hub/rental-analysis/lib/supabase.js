/**
 * lib/supabase.js
 * Thin wrapper around the Supabase REST API (PostgREST) using built-in fetch.
 * Same pattern as projects/content-engine/lib/supabase.js — no SDK needed
 * for simple reads/writes.
 *
 * Always uses the service role key: RLS is enabled on rental_analyses,
 * rental_comps, and rental_comp_sources with no permissive policies yet
 * (see the migration file), so only the service role key can read/write
 * these tables until Q adds a policy for an interface later.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function assertConfigured() {
  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.join(', ')}. Check your .env file.`);
  }
}

function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/**
 * SELECT rows from a table.
 * @param {string} table
 * @param {string} query - raw PostgREST query string, e.g. "select=*&status=eq.OK"
 */
async function select(table, query = 'select=*') {
  assertConfigured();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: headers(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase select from ${table} failed (${res.status}): ${body}`);
  }
  return res.json();
}

/**
 * INSERT one or more rows into a table. Returns the inserted row(s).
 * @param {string} table
 * @param {object|object[]} rows
 */
async function insert(table, rows) {
  assertConfigured();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: headers({ Prefer: 'return=representation' }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase insert into ${table} failed (${res.status}): ${body}`);
  }
  return res.json();
}

/**
 * UPDATE rows matching a filter. Returns the updated row(s).
 * @param {string} table
 * @param {string} filter - PostgREST filter, e.g. "id=eq.<uuid>"
 * @param {object} patch
 */
async function update(table, filter, patch) {
  assertConfigured();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: headers({ Prefer: 'return=representation' }),
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase update on ${table} failed (${res.status}): ${body}`);
  }
  return res.json();
}

/**
 * UPSERT one or more rows into a table, keyed on a column with a UNIQUE
 * index — a real ON CONFLICT (<conflictColumn>) DO UPDATE via PostgREST's
 * `Prefer: resolution=merge-duplicates` + `on_conflict` param, not a
 * select-then-branch. First user: rental_market_data, refreshed in place
 * against its UNIQUE index on zip (see the migration file).
 * @param {string} table
 * @param {object|object[]} rows
 * @param {string} conflictColumn - column(s) with a UNIQUE index to upsert against, e.g. "zip"
 */
async function upsert(table, rows, conflictColumn) {
  assertConfigured();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictColumn}`, {
    method: 'POST',
    headers: headers({ Prefer: 'return=representation,resolution=merge-duplicates' }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase upsert into ${table} failed (${res.status}): ${body}`);
  }
  return res.json();
}

module.exports = { select, insert, update, upsert };
