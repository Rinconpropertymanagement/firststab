/**
 * lib/db.js
 * Thin wrapper around the Supabase REST API (PostgREST) using built-in fetch.
 * Same pattern as projects/content-engine/lib/supabase.js, so this app talks
 * to the database the same way the drafting engine does.
 *
 * Uses the service role key because RLS has no permissive policies on these
 * tables yet (see supabase/migrations/20260710000000_content_engine_schema.sql).
 * This is safe ONLY because this server sits behind its own login wall
 * (see lib/auth.js / middleware/requireLogin.js) — nobody reaches these
 * functions without authenticating first.
 *
 * This file only ever reads from or writes a status/text field to Supabase.
 * It has no code path that calls any external publishing, email, or social
 * media API.
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
 * @param {string} query - raw PostgREST query string, e.g. "select=*&status=eq.draft"
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
 * SELECT a single row by id. Returns null if not found.
 */
async function selectOne(table, id, query = 'select=*') {
  const rows = await select(table, `${query}&id=eq.${id}`);
  return rows[0] || null;
}

/**
 * INSERT one or more rows into a table. Returns the inserted row(s).
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
 * UPDATE a single row by id. Returns the updated row.
 */
async function updateOne(table, id, patch) {
  const rows = await update(table, `id=eq.${id}`, patch);
  return rows[0] || null;
}

module.exports = { select, selectOne, insert, update, updateOne };
