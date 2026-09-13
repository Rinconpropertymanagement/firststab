/**
 * lib/supabase.js
 * Thin wrapper around the Supabase REST API (PostgREST) using built-in fetch.
 * Same pattern as projects/calendar-assistant/sync-calendar.js — no SDK needed
 * for simple reads/writes.
 *
 * Always uses the service role key: RLS has no permissive policies yet, so
 * only service role can read/write these tables (see migration file).
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

module.exports = { select, insert, update };
