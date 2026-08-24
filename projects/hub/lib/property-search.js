/**
 * lib/property-search.js
 * Shared, hub-wide property search — GET /api/hub/search-properties?q=...
 *
 * Lets a logged-in hub user type a property name or address on ANY page
 * (the search box server.js's page() helper and each tool's dashboard
 * inject — see lib/global-search-widget.js) and get back matching
 * properties plus which of the three tools (Insurance, Maintenance
 * History, Security Deposit) actually have data for each one. This route
 * only checks EXISTENCE of related rows — it never returns the
 * underlying insurance, maintenance, or deposit data itself. Each tool's
 * own login + role check still gates the real data when the user clicks
 * through.
 *
 * TABLE RELATIONSHIPS — confirmed against the live schema, not assumed
 * (per the build task's explicit instruction to read the actual
 * migrations rather than guess):
 *   property_insurance.property_id   -> properties.id   (direct — see
 *     supabase/migrations/20260720000004_insurance_compliance.sql)
 *   units.property_id                -> properties.id
 *   maintenance_requests.unit_id     -> units.id   (so Maintenance
 *     History reaches a property via unit_id -> units -> property_id —
 *     same join maintenance-history/router.js's own queries use)
 *   leases.unit_id                   -> units.id
 *   security_deposit_cases.lease_id  -> leases.id   (so Security Deposit
 *     reaches a property via lease_id -> leases -> unit_id -> units ->
 *     property_id, a 3-hop join — confirmed against
 *     20260626000000_initial_schema.sql (leases, units) and
 *     20260813000002_security_deposit_cases.sql (the case table))
 *
 * WHY TWO SEPARATE QUERIES, NOT ONE:
 *   As of this build, 20260813000002_security_deposit_cases.sql (Neo's
 *   migration) exists in this repo but has NOT been applied to the live
 *   database yet — confirmed live, the table does not exist there today.
 *   PostgREST needs an embedded table to exist to resolve a nested
 *   select at all, so one combined query touching all five tables would
 *   fail OUTRIGHT — breaking Insurance and Maintenance History search
 *   results too, not just Security Deposit's. Querying Security Deposit
 *   separately and catching a missing-table error means the search stays
 *   fully working for the two tools that have real data today, and
 *   Security Deposit links simply won't appear (correctly — there is no
 *   Security Deposit data anywhere yet) until that migration is applied,
 *   with no code change needed then.
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const missing = [];
if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
if (missing.length > 0) {
  console.error(`[hub search] Missing environment variables: ${missing.join(', ')}`);
  console.error('[hub search] Set these in the shared .env at the project root (see .env.example).');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Keep the query itself narrowly scoped (build task requirement #4) — a
// reasonable result cap so this stays fast typed on every page, not a
// full unbounded scan.
const RESULT_LIMIT = 10;

// PostgREST's .or() filter syntax treats "," "." ":" "(" ")" as reserved
// (comma separates conditions, parens group them) — a search typed with
// any of those characters (e.g. pasting a full "123 Main St, Ventura, CA"
// address) would otherwise be parsed as filter syntax instead of literal
// text. PostgREST's documented fix is to wrap the whole value in double
// quotes (not backslash-escape each reserved character individually —
// that was tried first and PostgREST still rejected it); inside the
// quotes, only '"' and '\' themselves need escaping.
function buildIlikeValue(rawQuery) {
  const withWildcards = `%${rawQuery}%`;
  const escaped = withWildcards.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

const router = express.Router();

router.get('/api/hub/search-properties', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.json([]);

  const ilikeValue = buildIlikeValue(q);

  // Insurance + Maintenance History in one query — both tables are
  // guaranteed to exist (see file header). Only `id` is selected on each
  // embedded table: this route needs to know whether a related row
  // EXISTS, not what's in it, which keeps the query small.
  //
  // The maintenance_requests embed is filtered to latchel_job_id IS NOT
  // NULL — matching the exact filter maintenance-history/router.js's own
  // ticket list applies (.not('latchel_job_id', 'is', null), see
  // maintenance-history/router.js ~line 155). A maintenance_requests row
  // with no Latchel match yet has nothing extracted to show, so the
  // Maintenance History tool never displays it — flagging a property as
  // having Maintenance History data on the strength of that row alone
  // sent users to an empty "No synced tickets yet" page. This filter is
  // a PostgREST embedded-resource filter, not an inner join: properties
  // still come back even when their maintenance_requests array is empty
  // after filtering, so Insurance/Security Deposit flags on that same
  // row are unaffected.
  const { data, error } = await supabase
    .from('properties')
    .select(`
      id, name, address, city,
      property_insurance ( id ),
      units (
        id,
        maintenance_requests ( id )
      )
    `)
    .or(`name.ilike.${ilikeValue},address.ilike.${ilikeValue}`)
    .not('units.maintenance_requests.latchel_job_id', 'is', null)
    .limit(RESULT_LIMIT);

  if (error) return res.status(500).json({ error: error.message });

  const properties = data || [];
  const propertyIds = properties.map(p => p.id);

  // Security Deposit — separate, defensive query (see file header). A
  // missing table (migration not applied yet) or any other lookup
  // failure degrades to "no Security Deposit data" instead of breaking
  // the whole search.
  const securityDepositPropertyIds = new Set();
  if (propertyIds.length) {
    try {
      const { data: sdUnits, error: sdErr } = await supabase
        .from('units')
        .select('property_id, leases ( security_deposit_cases ( id ) )')
        .in('property_id', propertyIds);
      if (sdErr) throw sdErr;
      for (const u of sdUnits || []) {
        const hasCase = (u.leases || []).some(
          l => Array.isArray(l.security_deposit_cases) && l.security_deposit_cases.length > 0
        );
        if (hasCase) securityDepositPropertyIds.add(u.property_id);
      }
    } catch (err) {
      console.warn('[hub search] Security Deposit lookup skipped:', err.message);
    }
  }

  const results = properties.map(p => {
    const units = p.units || [];
    const hasInsurance = Array.isArray(p.property_insurance) && p.property_insurance.length > 0;
    const hasMaintenance = units.some(
      u => Array.isArray(u.maintenance_requests) && u.maintenance_requests.length > 0
    );
    return {
      id: p.id,
      name: p.name,
      address: p.address,
      city: p.city,
      tools: {
        insurance: hasInsurance,
        maintenance_history: hasMaintenance,
        security_deposit: securityDepositPropertyIds.has(p.id),
      },
    };
  });

  return res.json(results);
});

module.exports = { router };
