/**
 * maintenance-history/router.js
 * Maintenance History tool — a section of the Rincon Hub, built the same
 * way Insurance Compliance and Security Deposit were: one router file,
 * mounted into projects/hub/server.js, reusing the Hub's existing login.
 *
 * Full spec: projects/hub/maintenance-history/SPEC.md — treat it as
 * authoritative, along with the "AUDIT LOG GUIDANCE FOR Q" section of
 * supabase/migrations/20260815010000_maintenance_history_schema.sql.
 *
 * ============================================================
 * JOIN-KEY CORRECTION — READ THIS BEFORE TOUCHING THE MATCHING LOGIC
 * ============================================================
 * SPEC.md's live-verification pass concluded Job.order_number is the
 * primary match to Rincon's ticket numbering, cross-checked against
 * ref_job_id. Real testing done for this build (GET-only, against 300 real
 * jobs pulled from the live account, cross-checked against all 380 live
 * maintenance_requests rows) found the OPPOSITE: order_number's numeric
 * part is Rincon's own human-facing ticket reference (what staff call a
 * ticket, e.g. "17595-1") — a DIFFERENT number from the one AppFolio's own
 * sync (projects/appfolio-sync/sync.js ~line 240, work_order_id ||
 * work_order_number) actually writes into maintenance_requests.appfolio_id.
 * `ref_job_id` is the field that actually equals appfolio_id. Concretely:
 * Latchel job 721344 (order_number "17595-1") is "Gas line leak inspection
 * and repair estimate." Matching on order_number's numeric part (17595)
 * finds a real but WRONG row — an unrelated "Floor repair" ticket that
 * happens to share that number. Matching on ref_job_id (17767) finds the
 * correct row — title "Gas line leak inspection and repair estimate,"
 * exact content match. Across every job in the test sample where any match
 * was found at all: ref_job_id was correct 8/9 times (the 9th was a
 * trivial "APPROVED" prefix, same ticket); order_number's numeric part was
 * correct 0/7 times — every single one pointed at a different, unrelated
 * ticket. See the build report for the full methodology. This file matches
 * on ref_job_id, not order_number. maintenance_requests.latchel_job_id
 * still stores Latchel's own job_id (the path-level ID) once matched, per
 * the schema column's own comment — only the MATCHING field changed.
 * ============================================================
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const latchel = require('./lib/latchel-connector');
const extractClaims = require('./lib/extract-claims');
const contentCheck = require('./lib/content-check');
const { TERMS_VERSION } = require('./lib/protected-class-terms');
const { GLOBAL_SEARCH_WIDGET_HTML } = require('../lib/global-search-widget');

// ─── Config ─────────────────────────────────────────────────────────────
const missing = [];
if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
if (missing.length > 0) {
  console.error(`[maintenance-history] Missing environment variables: ${missing.join(', ')}`);
  console.error('[maintenance-history] Set these in the shared .env at the project root (see .env.example).');
  process.exit(1);
}
// LATCHEL_API_KEY is checked lazily inside latchel-connector.js — a missing
// key shouldn't take down the whole Hub, only the routes that actually
// need to call Latchel (same reasoning security-deposit's router.js gives
// for B2_*/APPFOLIO_* checks).

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Pagination helper — Supabase/PostgREST caps any single .select() at
// 1000 rows by default, silently (no error). Same fix, same reasoning, as
// security-deposit/router.js's fetchAllRows (that file hit this for real
// with the B2 photo index — see its comment for the story). Used below
// for any query here that reads a table with no narrow per-request
// filter, so it can't rely on staying under 1000 rows just because it
// does today.
const SUPABASE_PAGE_SIZE = 1000;
async function fetchAllRows(buildPage) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await buildPage(from, from + SUPABASE_PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data || []) rows.push(row);
    if (!data || data.length < SUPABASE_PAGE_SIZE) break;
    from += SUPABASE_PAGE_SIZE;
  }
  return rows;
}

const PDF_FILE_CLASSIFICATIONS = ['Invoice', 'Estimate', 'Miscellaneous'];

// ─── Permission check — reads Neo's shared team tables ─────────────────
// Same fail-closed pattern as insurance/router.js and security-deposit/router.js.
async function attachMaintenanceHistoryRole(req, res, next) {
  req.maintenanceHistoryRole = null;
  req.teamMemberId = null;
  req.maintenanceHistoryMemberName = null;

  try {
    const { data: member, error: memberErr } = await supabase
      .from('team_members')
      .select('id, full_name, is_active')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (memberErr) throw memberErr;
    if (!member || !member.is_active) return next();

    req.teamMemberId = member.id;
    req.maintenanceHistoryMemberName = member.full_name || null;

    const { data: roleRow, error: roleErr } = await supabase
      .from('team_member_tool_roles')
      .select('role')
      .eq('team_member_id', member.id)
      .eq('tool', 'maintenance_history')
      .maybeSingle();
    if (roleErr) throw roleErr;
    req.maintenanceHistoryRole = roleRow ? roleRow.role : null;
    next();
  } catch (err) {
    console.error('[maintenance-history] permission lookup failed:', err.message);
    next();
  }
}

function requireMaintenanceHistoryAccess(req, res, next) {
  if (!req.maintenanceHistoryRole) {
    return res.status(403).json({
      error: 'Your Rincon Hub account does not have access to Maintenance History yet. Ask an admin to grant you access.',
    });
  }
  next();
}

function requireMaintenanceHistoryRole(...roles) {
  return (req, res, next) => {
    if (!req.maintenanceHistoryRole || !roles.includes(req.maintenanceHistoryRole)) {
      return res.status(403).json({ error: 'Insufficient permissions', required: roles, actual: req.maintenanceHistoryRole });
    }
    next();
  };
}

// ─── Router: everyone reaching here is already hub-logged-in ───────────
const router = express.Router();
router.use(attachMaintenanceHistoryRole);

// Same "read + inject the shared search widget, then send" approach as
// insurance/router.js's GET /insurance — see that route's comment for why.
router.get('/maintenance-history', (req, res) => {
  fs.readFile(path.join(__dirname, 'dashboard', 'index.html'), 'utf8', (err, html) => {
    if (err) return res.status(500).send('Could not load page.');
    res.send(html.replace('<body>', '<body>\n' + GLOBAL_SEARCH_WIDGET_HTML));
  });
});

router.get('/api/maintenance-history/auth/me', requireMaintenanceHistoryAccess, (req, res) => {
  res.json({
    email: req.user.email,
    name: req.maintenanceHistoryMemberName || req.user.email,
    role: req.maintenanceHistoryRole,
  });
});

// ─── GET /api/maintenance-history/tickets — synced tickets, with counts ──
// Only tickets that have actually been matched to a Latchel job
// (latchel_job_id set) show up here — nothing to review before that.
router.get('/api/maintenance-history/tickets', requireMaintenanceHistoryAccess, async (req, res) => {
  // Every ticket ever matched to a Latchel job, portfolio-wide, no time
  // filter — this is the main tickets browser and it only grows as more
  // tickets get ingested. Paginated the same way security-deposit's
  // router.js had to fix its case list and B2 photo index reads. Paged by
  // `id`; the real sort (latchel_claims_synced_at desc) is applied in JS.
  let data;
  try {
    data = await fetchAllRows((from, to) => supabase
      .from('maintenance_requests')
      .select(`
        id, title, status, appfolio_id, latchel_job_id, latchel_claims_synced_at,
        units ( unit_number, properties ( name, address ) )
      `)
      .not('latchel_job_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, to));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
  data.sort((a, b) => {
    if (a.latchel_claims_synced_at == null && b.latchel_claims_synced_at == null) return 0;
    if (a.latchel_claims_synced_at == null) return 1;
    if (b.latchel_claims_synced_at == null) return -1;
    return a.latchel_claims_synced_at < b.latchel_claims_synced_at ? 1 : a.latchel_claims_synced_at > b.latchel_claims_synced_at ? -1 : 0;
  });

  const ids = data.map(r => r.id);
  const counts = {};
  if (ids.length) {
    // Claim rows scale with the ticket list above, so this needs the same
    // fix — .in(ids) doesn't exempt a query from the 1000-row cap.
    let claimRows;
    try {
      claimRows = await fetchAllRows((from, to) => supabase
        .from('maintenance_claims')
        .select('maintenance_request_id, review_status, flagged_protected_class')
        .in('maintenance_request_id', ids)
        .order('id', { ascending: true })
        .range(from, to));
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
    for (const c of claimRows || []) {
      const bucket = counts[c.maintenance_request_id] || { total: 0, unreviewed: 0, flagged: 0 };
      bucket.total++;
      if (c.review_status === 'unreviewed' && !c.flagged_protected_class) bucket.unreviewed++;
      if (c.flagged_protected_class) bucket.flagged++;
      counts[c.maintenance_request_id] = bucket;
    }
  }

  const q = (req.query.q || '').toLowerCase().trim();
  let rows = (data || []).map(r => ({
    id: r.id,
    title: (r.title || '').split('\n')[0],
    status: r.status,
    appfolio_id: r.appfolio_id,
    latchel_job_id: r.latchel_job_id,
    latchel_claims_synced_at: r.latchel_claims_synced_at,
    property_name: r.units && r.units.properties ? r.units.properties.name : null,
    property_address: r.units && r.units.properties ? r.units.properties.address : null,
    unit_number: r.units ? r.units.unit_number : null,
    claim_counts: counts[r.id] || { total: 0, unreviewed: 0, flagged: 0 },
  }));
  if (q) {
    rows = rows.filter(r =>
      (r.title || '').toLowerCase().includes(q) ||
      (r.property_name || '').toLowerCase().includes(q) ||
      (r.property_address || '').toLowerCase().includes(q) ||
      (r.appfolio_id || '').toLowerCase().includes(q)
    );
  }

  return res.json(rows);
});

// ─── GET /api/maintenance-history/tickets/:id — four-section ticket view ─
// Flagged claims are structurally excluded from this normal view (they
// only ever appear in the flagged-queue route below) — SPEC.md "The
// Content Check": "Routed to a separate 'Needs privacy review' queue...
// distinct from the normal per-ticket claims view."
router.get('/api/maintenance-history/tickets/:id', requireMaintenanceHistoryAccess, async (req, res) => {
  const { data: mr, error } = await supabase
    .from('maintenance_requests')
    .select(`
      id, title, description, status, appfolio_id, latchel_job_id, latchel_claims_synced_at,
      units ( unit_number, properties ( name, address, city ) )
    `)
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!mr) return res.status(404).json({ error: 'Ticket not found.' });

  const { data: claims, error: claimsErr } = await supabase
    .from('maintenance_claims')
    .select('*')
    .eq('maintenance_request_id', mr.id)
    .eq('flagged_protected_class', false)
    .order('claim_date', { ascending: true, nullsFirst: false });
  if (claimsErr) return res.status(500).json({ error: claimsErr.message });

  const grouped = { event: [], decision: [], outcome: [], recurrence: [] };
  for (const c of claims || []) {
    if (grouped[c.claim_type]) grouped[c.claim_type].push(c);
  }

  return res.json({
    id: mr.id,
    title: mr.title,
    description: mr.description,
    status: mr.status,
    appfolio_id: mr.appfolio_id,
    latchel_job_id: mr.latchel_job_id,
    latchel_claims_synced_at: mr.latchel_claims_synced_at,
    property: mr.units && mr.units.properties ? {
      name: mr.units.properties.name,
      address: mr.units.properties.address,
      city: mr.units.properties.city,
      unit_number: mr.units.unit_number,
    } : null,
    claims: grouped,
  });
});

// Round-trip calendar validation — `new Date("2026-02-30")` does NOT return
// an invalid date the way you'd expect; JS silently rolls it forward to
// March 2nd instead of failing. That let bad month-end dates (Apr 31, Jun
// 31, Sep 31, Nov 31, Feb 29/30/31, month 13, etc.) sail past the old check
// and crash into Postgres, which leaked a raw DB error to the user. Building
// the date from its own year/month/day with Date.UTC and reading it back
// with the matching getUTC* accessors (not the local-time ones, which would
// shift near timezone boundaries) means any "correction" JS made shows up
// as a mismatch against what was actually typed in.
function isValidCalendarDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [year, month, day] = dateStr.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    !isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

// properties.id is a UUID column (20260626000000_initial_schema.sql). A
// malformed :property_id (not something normal UI clicking can produce —
// IDs always come from real search results — but still reachable by
// hitting the route directly) makes Postgres itself reject the query with
// "invalid input syntax for type uuid," which came back as a raw 500
// before this check existed. Same shape guard as isValidCalendarDate
// above: catch it before it ever reaches the database.
function isValidUuid(str) {
  return typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// ─── POST /api/maintenance-history/claims/:id/review ───────────────────
// Confirm / correct / reject one claim. Works the same for a flagged claim
// as an unflagged one — a reviewer/admin can (and must) be able to read a
// flagged claim's real text to judge it; that's what human review means
// here. Only the audit_log entry below is barred from carrying the text.
router.post('/api/maintenance-history/claims/:id/review', requireMaintenanceHistoryRole('admin', 'reviewer', 'director_of_operations'), async (req, res) => {
  const { action, claim_text, claim_date, outcome_level, reviewer_notes } = req.body;
  if (!['confirm', 'correct', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'action must be "confirm", "correct", or "reject".' });
  }

  const { data: before, error: beforeErr } = await supabase
    .from('maintenance_claims')
    .select('id, claim_type, flagged_protected_class, maintenance_request_id')
    .eq('id', req.params.id)
    .maybeSingle();
  if (beforeErr) return res.status(500).json({ error: beforeErr.message });
  if (!before) return res.status(404).json({ error: 'Claim not found.' });

  const reviewerName = req.maintenanceHistoryMemberName || req.user.email;
  const review_status = action === 'confirm' ? 'confirmed' : action === 'correct' ? 'corrected' : 'rejected';

  // Basic validation before anything hits the database — a bad value here
  // should come back as a clean 400, not a raw Postgres error.
  if (action === 'correct') {
    if (claim_text !== undefined && (typeof claim_text !== 'string' || !claim_text.trim())) {
      return res.status(400).json({ error: 'claim_text cannot be empty.' });
    }
    if (claim_date !== undefined && claim_date !== null && claim_date !== '') {
      if (!isValidCalendarDate(claim_date)) {
        return res.status(400).json({ error: 'claim_date must be a valid date in YYYY-MM-DD format.' });
      }
    }
    if (before.claim_type === 'outcome' && outcome_level !== undefined && outcome_level !== null && outcome_level !== '') {
      const lvl = Number(outcome_level);
      if (!Number.isInteger(lvl) || lvl < 1 || lvl > 5) {
        return res.status(400).json({ error: 'outcome_level must be a whole number from 1 to 5.' });
      }
    }
  }

  const updates = {
    review_status,
    reviewed_by: reviewerName,
    reviewed_at: new Date().toISOString(),
    reviewer_notes: reviewer_notes || null,
  };
  if (action === 'correct') {
    if (claim_text !== undefined) updates.claim_text = claim_text;
    if (claim_date !== undefined) updates.claim_date = claim_date || null;
    if (before.claim_type === 'outcome' && outcome_level !== undefined) {
      updates.outcome_level = outcome_level === null ? null : Number(outcome_level);
    }
  }

  const { data: updated, error } = await supabase
    .from('maintenance_claims')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // Rule 1 fields per the migration's "AUDIT LOG GUIDANCE FOR Q" #3.
  //
  // audit_log.performed_by is a foreign key into the older `users` table
  // (20260720000003_foundation.sql: performed_by UUID REFERENCES users(id)),
  // NOT into Supabase Auth. req.user.id is the Auth login ID (it's what
  // team_members.auth_user_id holds) — that ID was never written into
  // `users`, whose rows only line up with a person by email. Writing
  // req.user.id straight into performed_by violated the FK constraint on
  // every single review action, which silently killed the whole insert
  // (the .insert() call's result was never checked). Fixed by looking up
  // the matching `users` row by email instead. actor_id below is
  // unaffected — it's a free-text column already correctly holding the
  // reviewer's email, not a foreign key.
  const { data: userRow } = await supabase
    .from('users')
    .select('id')
    .eq('email', req.user.email)
    .maybeSingle();

  const riskLevel = (before.flagged_protected_class && (action === 'correct' || action === 'reject')) ? 'medium' : 'low';
  const { error: auditErr } = await supabase.from('audit_log').insert({
    action: 'maintenance_claims.reviewed',
    entity_type: 'maintenance_claim',
    entity_id: req.params.id,
    performed_by: userRow ? userRow.id : null,
    actor_type: 'human',
    actor_id: req.user.email,
    privacy_category: 'processing',
    risk_level: riskLevel,
    details: { review_status, reviewer_notes: reviewer_notes || null },
  });
  if (auditErr) {
    console.error('[maintenance-history] audit_log insert failed for claim review:', auditErr.message);
  }

  return res.json({ success: true, claim: updated });
});

// ─── GET /api/maintenance-history/flagged-queue ─────────────────────────
// "Needs privacy review" — reviewer/admin only, per SPEC.md. Shows the
// real claim text (a reviewer has to be able to read it to judge it) —
// never logged, only displayed to an authorized human.
router.get('/api/maintenance-history/flagged-queue', requireMaintenanceHistoryRole('admin', 'reviewer', 'director_of_operations'), async (req, res) => {
  // No time bound and no review_status filter — every claim ever flagged
  // as touching a protected class stays visible here forever (by design:
  // this is the Fair Housing / privacy review queue). A silent 1,000-row
  // cutoff wouldn't just lose data, it would hide real flagged content
  // from the humans who are supposed to review it — worth fixing
  // regardless of exactly how fast this table grows. Paged by `id`; the
  // real sort (created_at desc) is applied in JS.
  let data;
  try {
    data = await fetchAllRows((from, to) => supabase
      .from('maintenance_claims')
      .select(`
        id, claim_type, claim_text, claim_date, outcome_level, source_type, source_reference,
        confidence, extracted_by, flagged_category, review_status, reviewed_by, reviewed_at, created_at,
        maintenance_request_id,
        maintenance_requests!maintenance_claims_maintenance_request_id_fkey ( title, appfolio_id, units ( unit_number, properties ( name, address ) ) )
      `)
      .eq('flagged_protected_class', true)
      .order('id', { ascending: true })
      .range(from, to));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
  data.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

  const rows = data.map(c => ({
    id: c.id,
    claim_type: c.claim_type,
    claim_text: c.claim_text,
    claim_date: c.claim_date,
    outcome_level: c.outcome_level,
    source_type: c.source_type,
    source_reference: c.source_reference,
    confidence: c.confidence,
    extracted_by: c.extracted_by,
    flagged_category: c.flagged_category,
    review_status: c.review_status,
    reviewed_by: c.reviewed_by,
    reviewed_at: c.reviewed_at,
    created_at: c.created_at,
    ticket_id: c.maintenance_request_id,
    ticket_title: c.maintenance_requests ? (c.maintenance_requests.title || '').split('\n')[0] : null,
    property_name: c.maintenance_requests && c.maintenance_requests.units && c.maintenance_requests.units.properties
      ? c.maintenance_requests.units.properties.name : null,
    unit_number: c.maintenance_requests && c.maintenance_requests.units ? c.maintenance_requests.units.unit_number : null,
  }));
  return res.json(rows);
});

// ─── GET /api/maintenance-history/property/:property_id/budget ─────────
// Maintenance Budget Cross-Check, Part 2 (budget-crosscheck-SPEC.md). A
// plain fetched fact from AppFolio's own Budget report, synced nightly by
// projects/appfolio-sync/sync.js into appfolio_property_budgets — no AI
// involved, no claims/review-gate wrapper (see the spec's and the
// migration's own "Why this doesn't go through claims" sections). Two
// numbers are returned, clearly separate, never merged: AppFolio's own
// budgeted figures per GL category, and — for context only — a rollup of
// this property's actual maintenance_requests.cost rows for the same
// year(s). They will not tie out to the penny on purpose (timing lag,
// non-Latchel-tracked costs) — that is expected, not a bug, per the
// spec's "What Could Go Wrong" section.
//
// MAINT_RELATED_ACCOUNTS / SUBTOTAL_ACCOUNTS confirmed live against this
// account's real chart of accounts while building sync.js's
// annual_budget_forecast entry — there is no single "Repairs &
// Maintenance" GL line, and the report includes two synthetic subtotal
// rows ("Total Forecast Income"/"Total Forecast Expense") that are sums
// of the other rows, not real spending categories — mixing them into a
// per-category list would double-count. They're split out here instead.
const MAINT_RELATED_ACCOUNTS = ['Repair', 'Maintenance Labor', 'Roof Repairs and Maintenance', 'Maintenance Only-OBP'];
const SUBTOTAL_ACCOUNTS = ['Total Forecast Income', 'Total Forecast Expense'];

router.get('/api/maintenance-history/property/:property_id/budget', requireMaintenanceHistoryAccess, async (req, res) => {
  if (!isValidUuid(req.params.property_id)) {
    return res.status(400).json({ error: 'That property ID is not valid.' });
  }

  const { data: property, error: propErr } = await supabase
    .from('properties')
    .select('id, name, address, city, appfolio_id')
    .eq('id', req.params.property_id)
    .maybeSingle();
  if (propErr) return res.status(500).json({ error: propErr.message });
  if (!property) return res.status(404).json({ error: 'Property not found.' });

  let budgetRows = [];
  if (property.appfolio_id) {
    const { data, error } = await supabase
      .from('appfolio_property_budgets')
      .select('fiscal_year, gl_account_name, budgeted_amount, actual_amount, synced_at')
      .eq('appfolio_property_id', property.appfolio_id)
      .order('fiscal_year', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    budgetRows = data || [];
  }

  // Most recent 1-2 fiscal years actually present in the data — not an
  // assumption that two years always exist. annual_budget_forecast (see
  // sync.js) only ever returns AppFolio's CURRENT fiscal year; a second
  // year only appears here once a real calendar-year rollover has
  // happened and the nightly sync has run again.
  const years = [...new Set(budgetRows.map(r => r.fiscal_year))].sort((a, b) => b - a).slice(0, 2);
  const mostRecentSync = budgetRows.length
    ? budgetRows.reduce((latest, r) => (!latest || r.synced_at > latest ? r.synced_at : latest), null)
    : null;

  const budgetsByYear = {};
  for (const year of years) {
    const rows = budgetRows.filter(r => r.fiscal_year === year && !SUBTOTAL_ACCOUNTS.includes(r.gl_account_name));
    const subtotals = budgetRows.filter(r => r.fiscal_year === year && SUBTOTAL_ACCOUNTS.includes(r.gl_account_name));
    // Repair-related categories surfaced first — see MAINT_RELATED_ACCOUNTS
    // comment above for why there's no single canonical match. Everything
    // else still comes back, alphabetical, rather than a guessed-at filter
    // hiding real budget lines from Peter.
    rows.sort((a, b) => {
      const aM = MAINT_RELATED_ACCOUNTS.includes(a.gl_account_name) ? 0 : 1;
      const bM = MAINT_RELATED_ACCOUNTS.includes(b.gl_account_name) ? 0 : 1;
      if (aM !== bM) return aM - bM;
      return (a.gl_account_name || '').localeCompare(b.gl_account_name || '');
    });
    budgetsByYear[year] = { categories: rows, subtotals };
  }

  // Actual spend (Maintenance Budget — Actual Spend, Part 3,
  // actual-spend-SPEC.md). appfolio_property_actuals is synced nightly by
  // sync.js's general_ledger entry — one row per property + gl_account_id
  // + month. Query-time rollup, not a second write path, same as this
  // route's other numbers (spec's "Query pattern" / migration's own
  // comment): SUM(net_amount) and SUM(reimbursable_amount) per category,
  // for the same fiscal year(s) already established above by the budget
  // data. reimbursed is a breakout of spent, never merged into or
  // subtracted from it (spec Decision 3) — the UI must keep them separate.
  let actualsRows = [];
  if (property.appfolio_id && years.length) {
    const { data, error } = await supabase
      .from('appfolio_property_actuals')
      .select('fiscal_year, gl_account_id, gl_account_name, net_amount, reimbursable_amount')
      .eq('appfolio_property_id', property.appfolio_id)
      .in('fiscal_year', years);
    if (error) return res.status(500).json({ error: error.message });
    actualsRows = data || [];
  }

  const actualSpendByYear = {};
  for (const year of years) {
    const byAccount = new Map();
    for (const r of actualsRows.filter(r => r.fiscal_year === year)) {
      const bucket = byAccount.get(r.gl_account_id) || { category: r.gl_account_name, spent: 0, reimbursed: 0 };
      bucket.spent += Number(r.net_amount) || 0;
      bucket.reimbursed += Number(r.reimbursable_amount) || 0;
      byAccount.set(r.gl_account_id, bucket);
    }
    actualSpendByYear[year] = Array.from(byAccount.values()).map(b => ({
      category: b.category,
      spent: Math.round(b.spent * 100) / 100,
      reimbursed: Math.round(b.reimbursed * 100) / 100,
    }));
  }

  // Whether ANY actual-spend data has ever synced for this property, not
  // just whether this year's number happens to be zero — the UI needs to
  // tell "genuinely $0 spent so far" apart from "this feature hasn't
  // started tracking this property yet" (spec's "What You'll See"). Both
  // read as "$0" from the numbers alone, so this flag (plus the
  // always-shown "tracked since launch" note the dashboard renders) is
  // what keeps them from looking identical.
  const hasActualSpendData = actualsRows.length > 0;

  // Ticket cost rollup — supporting context only, kept in its own object,
  // never merged into the AppFolio numbers above (spec's explicit design
  // guard against recreating a false "these should match" impression).
  const { data: units, error: unitsErr } = await supabase
    .from('units')
    .select('id')
    .eq('property_id', property.id);
  if (unitsErr) return res.status(500).json({ error: unitsErr.message });
  const unitIds = (units || []).map(u => u.id);

  let tickets = [];
  if (unitIds.length) {
    const { data: mrRows, error: mrErr } = await supabase
      .from('maintenance_requests')
      .select('id, title, cost, status, completed_at, created_at')
      .in('unit_id', unitIds);
    if (mrErr) return res.status(500).json({ error: mrErr.message });
    tickets = mrRows || [];
  }

  const ticketsByYear = {};
  for (const year of years) {
    const yearTickets = tickets
      .filter(t => {
        // A ticket's cost is finalized at completion, so bucket by
        // completed_at when it exists; fall back to created_at for a
        // still-open ticket so it isn't silently dropped from the list.
        const d = t.completed_at || t.created_at;
        return d && new Date(d).getUTCFullYear() === year;
      })
      .map(t => ({
        id: t.id,
        title: (t.title || '').split('\n')[0],
        status: t.status,
        cost: t.cost,
        completed_at: t.completed_at,
      }));
    const totalCost = yearTickets.reduce((sum, t) => sum + (typeof t.cost === 'number' ? t.cost : 0), 0);
    ticketsByYear[year] = {
      total_cost: Math.round(totalCost * 100) / 100,
      count: yearTickets.length,
      tickets: yearTickets,
    };
  }

  return res.json({
    property: { id: property.id, name: property.name, address: property.address, city: property.city },
    has_appfolio_link: !!property.appfolio_id,
    fiscal_years: years,
    synced_at: mostRecentSync,
    budgets_by_year: budgetsByYear,
    actual_spend_by_year: actualSpendByYear,
    has_actual_spend_data: hasActualSpendData,
    ticket_costs_by_year: ticketsByYear,
  });
});

// ─── /api/maintenance-history/users — admin-only role management ────────
// Mirrors insurance/router.js's and security-deposit/router.js's admin
// endpoints exactly, scoped to tool='maintenance_history'. Allow-list
// matches the role values this file's own requireMaintenanceHistoryRole(...)
// gates actually check for above — 'admin' and 'reviewer' originally, plus
// 'director_of_operations' (added so the Director of Operations role can
// reach claim-review and the flagged-queue the same way 'reviewer' can —
// see those two routes above). All three are already live in
// team_member_tool_roles_role_check (see
// supabase/migrations/20260818000000_fix_role_check_regression.sql and
// 20260825000000_leadsimple_property_brain_phase1.sql) — no schema change
// needed, this is purely the application-side allow-list catching up.
// Deliberately still admin-only on the four routes directly below
// (granting/changing/removing someone else's role in this tool) — see the
// build notes for why director_of_operations wasn't added there too.
const VALID_ROLES = ['admin', 'reviewer', 'director_of_operations'];
const ALLOWED_DOMAIN = 'rinconmanagement.com';

router.get('/api/maintenance-history/users', requireMaintenanceHistoryRole('admin'), async (req, res) => {
  const { data, error } = await supabase
    .from('team_member_tool_roles')
    .select('role, granted_by, granted_at, team_members ( email, full_name )')
    .eq('tool', 'maintenance_history')
    .order('granted_at');
  if (error) return res.status(500).json({ error: error.message });
  const rows = (data || [])
    .filter(r => r.team_members) // guard against an orphaned row
    .map(r => ({
      email: r.team_members.email,
      name: r.team_members.full_name || null,
      role: r.role,
      assigned_by: r.granted_by,
      granted_at: r.granted_at,
    }));
  return res.json(rows);
});

// Admin-only: grants (or updates) a role for someone who has already
// logged into the Rincon Hub at least once. A row can't be created here
// for someone with no team_members row — there is nothing to link the
// role to yet. team_members rows come from the hub's own login (Supabase
// Auth), not from this screen — same rule insurance/security-deposit
// already enforce.
router.post('/api/maintenance-history/users', requireMaintenanceHistoryRole('admin'), async (req, res) => {
  const { email, role } = req.body;
  if (!email || !role) return res.status(400).json({ error: 'email and role are required.' });

  const normalizedEmail = String(email).toLowerCase().trim();
  if (!normalizedEmail.endsWith('@' + ALLOWED_DOMAIN)) {
    return res.status(400).json({ error: 'Only @' + ALLOWED_DOMAIN + ' accounts allowed.' });
  }
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });

  const { data: member, error: memberErr } = await supabase
    .from('team_members')
    .select('id')
    .eq('email', normalizedEmail)
    .maybeSingle();
  if (memberErr) return res.status(500).json({ error: memberErr.message });
  if (!member) {
    return res.status(400).json({
      error: `${normalizedEmail} hasn't logged into the Rincon Hub yet. Ask them to log in once (same email + password as every other hub tool), then try granting access again.`,
    });
  }

  const { error: upsertErr } = await supabase
    .from('team_member_tool_roles')
    .upsert({
      team_member_id: member.id,
      tool: 'maintenance_history',
      role,
      granted_by: req.user.email,
      granted_at: new Date().toISOString(),
    }, { onConflict: 'team_member_id,tool' });
  if (upsertErr) return res.status(500).json({ error: upsertErr.message });

  await supabase.from('audit_log').insert({
    action: 'team_member.role_changed',
    entity_type: 'team_member',
    entity_id: member.id,
    details: { tool: 'maintenance_history', old_role: null, new_role: role, changed_by: req.user.email },
  });

  return res.json({ success: true });
});

router.patch('/api/maintenance-history/users/:email', requireMaintenanceHistoryRole('admin'), async (req, res) => {
  const { role } = req.body;
  const targetEmail = String(req.params.email || '').toLowerCase().trim();
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });

  const { data: member, error: memberErr } = await supabase
    .from('team_members')
    .select('id')
    .eq('email', targetEmail)
    .maybeSingle();
  if (memberErr) return res.status(500).json({ error: memberErr.message });
  if (!member) return res.status(404).json({ error: `${targetEmail} is not a Rincon Hub team member.` });

  const { data: existing } = await supabase
    .from('team_member_tool_roles')
    .select('role')
    .eq('team_member_id', member.id)
    .eq('tool', 'maintenance_history')
    .maybeSingle();
  const oldRole = existing ? existing.role : null;

  const { error: upsertErr } = await supabase
    .from('team_member_tool_roles')
    .upsert({
      team_member_id: member.id,
      tool: 'maintenance_history',
      role,
      granted_by: req.user.email,
      granted_at: new Date().toISOString(),
    }, { onConflict: 'team_member_id,tool' });
  if (upsertErr) return res.status(500).json({ error: upsertErr.message });

  await supabase.from('audit_log').insert({
    action: 'team_member.role_changed',
    entity_type: 'team_member',
    entity_id: member.id,
    details: { tool: 'maintenance_history', old_role: oldRole, new_role: role, changed_by: req.user.email },
  });

  return res.json({ success: true });
});

// Removes this person's MAINTENANCE HISTORY role only (deletes their
// team_member_tool_roles row for tool='maintenance_history'). Their
// team_members row — and any access to other hub tools — is untouched.
router.delete('/api/maintenance-history/users/:email', requireMaintenanceHistoryRole('admin'), async (req, res) => {
  const targetEmail = String(req.params.email || '').toLowerCase().trim();
  if (targetEmail === req.user.email.toLowerCase()) {
    return res.status(400).json({ error: 'You cannot remove your own access.' });
  }

  const { data: member, error: memberErr } = await supabase
    .from('team_members')
    .select('id')
    .eq('email', targetEmail)
    .maybeSingle();
  if (memberErr) return res.status(500).json({ error: memberErr.message });
  if (!member) return res.status(404).json({ error: `${targetEmail} is not a Rincon Hub team member.` });

  const { data: existing } = await supabase
    .from('team_member_tool_roles')
    .select('role')
    .eq('team_member_id', member.id)
    .eq('tool', 'maintenance_history')
    .maybeSingle();

  const { error } = await supabase
    .from('team_member_tool_roles')
    .delete()
    .eq('team_member_id', member.id)
    .eq('tool', 'maintenance_history');
  if (error) return res.status(500).json({ error: error.message });

  await supabase.from('audit_log').insert({
    action: 'team_member.role_changed',
    entity_type: 'team_member',
    entity_id: member.id,
    details: { tool: 'maintenance_history', old_role: existing ? existing.role : null, new_role: null, changed_by: req.user.email },
  });

  return res.json({ success: true });
});

// ─── internalRouter: no login required — own shared-secret check ────────
const internalRouter = express.Router();

function checkCronSecret(req, res) {
  const secret = req.headers['x-cron-secret'];
  if (!secret || secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/**
 * POST /api/maintenance-history/internal/ingest?since_days=30
 * The nightly job. GET-only against Latchel (see latchel-connector.js).
 * Defaults to the last 30 days of updated jobs per the build task's
 * explicit instruction to start with recent/live data only, not a full
 * historical backfill — that is a separate, later decision.
 */
internalRouter.post('/api/maintenance-history/internal/ingest', async (req, res) => {
  if (!checkCronSecret(req, res)) return;
  const ts = new Date().toISOString();
  const sinceDays = Number(req.query.since_days) || 30;
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  console.log(`[${ts}] maintenance-history ingest: pulling Latchel jobs updated since ${since}...`);

  let jobs;
  try {
    jobs = await latchel.listJobsUpdatedSince(since);
  } catch (err) {
    console.error(`[${ts}] ingest: Latchel fetch failed:`, err.message);
    return res.status(502).json({ error: 'Failed to pull jobs from Latchel.', detail: err.message });
  }

  // Every maintenance_requests row, portfolio-wide, no filter at all —
  // this builds the byAppfolioId/byLatchelJobId lookup maps every single
  // incoming Latchel job gets matched against. A silent 1,000-row
  // truncation here wouldn't error — every job whose matching Rincon
  // ticket fell outside whatever page came back would just be counted as
  // "unmatched" below and its claims would permanently stop syncing, with
  // nothing in the logs to say why. This is the same class of bug as the
  // B2 photo index and security-deposit's leases fetch, on the table this
  // whole tool is built around, so it gets the same fix.
  let mrRows;
  try {
    mrRows = await fetchAllRows((from, to) => supabase
      .from('maintenance_requests')
      .select('id, appfolio_id, latchel_job_id, latchel_claims_synced_at, unit_id, units ( property_id )')
      .order('id', { ascending: true })
      .range(from, to));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  const byAppfolioId = new Map((mrRows || []).map(r => [String(r.appfolio_id), r]));
  const byLatchelJobId = new Map((mrRows || []).filter(r => r.latchel_job_id).map(r => [String(r.latchel_job_id), r]));

  const summary = {
    jobs_pulled: jobs.length,
    tickets_matched: 0,
    tickets_unmatched: 0,
    tickets_already_current: 0,
    tickets_processed: 0,
    claims_inserted: 0,
    claims_flagged: 0,
    errors: [],
  };

  for (const jobSummary of jobs) {
    const jobId = String(jobSummary.job_id);
    try {
      // Primary match path: this job's Latchel job_id was already linked
      // to a ticket by an earlier run. Fallback path: match Latchel's
      // ref_job_id against maintenance_requests.appfolio_id (see the
      // JOIN-KEY CORRECTION note at the top of this file for why
      // ref_job_id, not order_number).
      let mr = byLatchelJobId.get(jobId);
      if (!mr) {
        const refJobId = jobSummary.ref_job_id != null ? String(jobSummary.ref_job_id) : null;
        mr = refJobId ? byAppfolioId.get(refJobId) : null;
      }
      if (!mr) {
        summary.tickets_unmatched++;
        continue;
      }
      summary.tickets_matched++;

      // Idempotency: only reprocess if this job actually changed since the
      // last sync — mirrors leases.deposit_synced_at's exact purpose (per
      // the schema column's own comment), avoiding duplicate claim inserts
      // on every nightly run for a ticket that hasn't moved.
      if (mr.latchel_claims_synced_at && jobSummary.updated_at &&
          new Date(jobSummary.updated_at) <= new Date(mr.latchel_claims_synced_at)) {
        summary.tickets_already_current++;
        continue;
      }

      const job = await latchel.getJob(jobSummary.job_id);
      const stateHistory = await latchel.getJobStateHistory(jobSummary.job_id);
      const files = await latchel.getJobFiles(jobSummary.job_id);

      const pdfFileMeta = (files || []).filter(
        f => PDF_FILE_CLASSIFICATIONS.includes(f.classification) && f.extension === 'pdf' && f.download_link && f.download_link.uri
      );
      const pdfFiles = [];
      for (const f of pdfFileMeta) {
        try {
          const buffer = await latchel.downloadFile(f.download_link.uri);
          pdfFiles.push({ buffer, filename: f.name, classification: f.classification });
        } catch (dlErr) {
          console.error(`[${ts}] ingest: file download failed, job ${jobId}, file ${f.name}:`, dlErr.message);
        }
      }

      const deterministicClaims = extractClaims.buildDeterministicEventClaims(job, stateHistory);
      let aiResult = { claims: [], modelVersion: null, filesRead: [] };
      try {
        aiResult = await extractClaims.extractAIClaims({ job, stateHistory, pdfFiles });
        if (aiResult.truncated) {
          // Loud and distinct from the generic 'extraction' error below —
          // this ticket's AI response was cut off before it finished (see
          // extract-claims.js), not malformed. Surfaced here too so it
          // shows up in the ingest summary, not just the server log.
          summary.errors.push({
            job_id: jobId,
            stage: 'extraction_truncated',
            error: 'AI response was cut off (max_tokens) before it finished — this ticket needs a retry.',
          });
        }
      } catch (aiErr) {
        console.error(`[${ts}] ingest: AI extraction failed, job ${jobId}:`, aiErr.message);
        summary.errors.push({ job_id: jobId, stage: 'extraction', error: aiErr.message });
      }

      const candidates = [...deterministicClaims, ...aiResult.claims];
      const insertedClaimIds = [];
      const insertedClaimTypes = [];
      let flaggedThisTicket = 0;
      const propertyId = mr.units ? mr.units.property_id : null;

      for (const candidate of candidates) {
        const check = contentCheck.checkClaim(candidate);
        const row = {
          maintenance_request_id: mr.id,
          claim_type: candidate.claim_type,
          claim_text: candidate.claim_text,
          claim_date: candidate.claim_date,
          outcome_level: candidate.claim_type === 'outcome' ? candidate.outcome_level : null,
          related_maintenance_request_id: null, // v1 limitation — see extract-claims.js
          source_type: candidate.source_type,
          source_reference: candidate.source_reference,
          confidence: candidate.confidence,
          extracted_by: candidate.extracted_by,
          flagged_protected_class: check.flagged_protected_class,
          flagged_category: check.flagged_category,
          review_status: 'unreviewed', // ALWAYS — no code path here sets anything else
        };

        const { data: inserted, error: insErr } = await supabase
          .from('maintenance_claims').insert(row).select('id').single();
        if (insErr) {
          summary.errors.push({ job_id: jobId, stage: 'insert', error: insErr.message });
          continue;
        }
        insertedClaimIds.push(inserted.id);
        insertedClaimTypes.push(candidate.claim_type);
        summary.claims_inserted++;

        if (check.flagged_protected_class) {
          flaggedThisTicket++;
          summary.claims_flagged++;
          // AUDIT LOG GUIDANCE #2 — never the flagged text itself.
          await supabase.from('audit_log').insert({
            action: 'maintenance_claims.protected_class_excluded',
            entity_type: 'maintenance_claim',
            entity_id: inserted.id,
            actor_type: check.matched_layer === 'keyword' ? 'system' : 'ai_agent',
            actor_id: check.matched_layer === 'keyword' ? 'maintenance-history-content-check' : extractClaims.EXTRACTOR_ACTOR_ID,
            actor_version: check.matched_layer === 'keyword' ? TERMS_VERSION : (candidate.extracted_by || aiResult.modelVersion || 'unknown'),
            privacy_category: 'processing',
            risk_level: 'high',
            property_id: propertyId || null,
            details: {
              flagged_category: check.flagged_category,
              matched_layer: check.matched_layer,
              claim_type: candidate.claim_type,
              source_reference: candidate.source_reference,
            },
          });
        }
      }

      // Only stamp latchel_claims_synced_at when the AI extraction actually
      // completed (Judge's finding: a truncated ticket was being stamped
      // "synced" same as a complete one, so the idempotency check above —
      // mr.latchel_claims_synced_at vs jobSummary.updated_at — treated it as
      // already current and it never got retried). Leaving this column
      // unset (first-ever sync) or unchanged (reprocessing an
      // already-synced ticket whose Latchel update triggered a retry that
      // then also truncated) means jobSummary.updated_at stays newer than
      // mr.latchel_claims_synced_at, so this ticket is picked up again on
      // the next nightly run instead of silently looking done. The
      // dashboard's "Last synced" column (dashboard/index.html) already
      // renders a null/stale value distinctly from a fresh one, so this
      // alone also makes an incomplete ticket visibly different from a
      // properly completed one — no separate flag column needed.
      const mrUpdates = {};
      if (!mr.latchel_job_id) mrUpdates.latchel_job_id = jobId;
      if (!aiResult.truncated) mrUpdates.latchel_claims_synced_at = new Date().toISOString();
      if (Object.keys(mrUpdates).length > 0) {
        await supabase.from('maintenance_requests').update(mrUpdates).eq('id', mr.id);
      }

      // AUDIT LOG GUIDANCE #1 — one entry per ticket touched.
      await supabase.from('audit_log').insert({
        action: 'maintenance_claims.ingestion_run',
        entity_type: 'maintenance_request',
        entity_id: mr.id,
        actor_type: insertedClaimIds.length > 0 ? 'ai_agent' : 'system',
        actor_id: extractClaims.EXTRACTOR_ACTOR_ID,
        actor_version: aiResult.modelVersion || 'n/a',
        privacy_category: 'collection',
        risk_level: flaggedThisTicket > 0 ? 'medium' : 'low',
        property_id: propertyId || null,
        details: {
          claim_ids: insertedClaimIds,
          claim_types: insertedClaimTypes,
          source_files_read: aiResult.filesRead,
        },
      });

      summary.tickets_processed++;
    } catch (err) {
      console.error(`[${ts}] ingest: error on job ${jobId}:`, err.message);
      summary.errors.push({ job_id: jobId, stage: 'ticket', error: err.message });
    }
  }

  console.log(`[${ts}] maintenance-history ingest done:`, JSON.stringify(summary));
  return res.json(summary);
});

/**
 * POST /api/maintenance-history/internal/reconcile-properties
 * Periodic, not nightly (properties change rarely — SPEC.md Data Model
 * #1). Matches Latchel's ref_property_id against properties.appfolio_id.
 * Never overwrites an existing match, never writes null over one.
 */
internalRouter.post('/api/maintenance-history/internal/reconcile-properties', async (req, res) => {
  if (!checkCronSecret(req, res)) return;
  const ts = new Date().toISOString();

  let latchelProperties;
  try {
    latchelProperties = await latchel.listProperties();
  } catch (err) {
    console.error(`[${ts}] reconcile-properties: Latchel fetch failed:`, err.message);
    return res.status(502).json({ error: 'Failed to pull properties from Latchel.', detail: err.message });
  }

  const { data: rinconProperties, error } = await supabase
    .from('properties')
    .select('id, appfolio_id, latchel_property_id')
    .not('appfolio_id', 'is', null);
  if (error) return res.status(500).json({ error: error.message });

  const byAppfolioId = new Map((rinconProperties || []).map(p => [String(p.appfolio_id), p]));

  let matched = 0;
  for (const lp of latchelProperties) {
    const refPropertyId = lp.ref_property_id != null ? String(lp.ref_property_id) : null;
    if (!refPropertyId) continue;
    const rp = byAppfolioId.get(refPropertyId);
    if (!rp || rp.latchel_property_id) continue; // no match, or already matched — never overwrite

    const { error: updErr } = await supabase
      .from('properties')
      .update({ latchel_property_id: String(lp.property_id) })
      .eq('id', rp.id);
    if (!updErr) matched++;
  }

  console.log(`[${ts}] reconcile-properties: ${matched} newly matched of ${latchelProperties.length} Latchel properties seen.`);
  return res.json({ matched, latchel_properties_seen: latchelProperties.length });
});

module.exports = { router, internalRouter };
