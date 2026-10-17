/**
 * backtest/db.js
 * Read-only Supabase access for the accuracy test: GET requests only, paged,
 * service-role key from the environment (never printed, never logged). There
 * is deliberately no insert/update/delete here, and a test asserts that every
 * request this module makes is a plain GET.
 */
const { redact } = require('./env');

const PAGE = 1000; // PostgREST's default max rows per response

async function getAll(table, query = 'select=*', fetchImpl = fetch) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${base}/rest/v1/${table}?${query}&limit=${PAGE}&offset=${offset}`;
    let res;
    try {
      res = await fetchImpl(url, { method: 'GET', headers: { apikey: key, Authorization: `Bearer ${key}` } });
    } catch (err) {
      throw new Error(`Supabase GET ${table} failed: ${redact(err.message)}`);
    }
    if (!res.ok) {
      const body = redact(await res.text().catch(() => ''));
      throw new Error(`Supabase GET ${table} failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

module.exports = { getAll, PAGE };
