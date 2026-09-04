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
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const latchel = require('./lib/latchel-connector');
const extractClaims = require('./lib/extract-claims');
const contentCheck = require('./lib/content-check');
const { scanText, TERMS_VERSION, CATEGORIES } = require('./lib/protected-class-terms');
const componentCategories = require('./lib/component-categories');
const { synthesizeComponent } = require('./lib/synthesize-component');
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

// Roles that can see flagged-claim content for the "Needs privacy review"
// surface — shared-property-context-SPEC.md Part 2. One constant, reused
// below for both the flagged-queue route's own gate and the
// flagged_review_count field on Property Overview, so the two checks can't
// be retyped separately and drift apart.
//
// director_of_operations included as of this build. History: the prior
// build (this constant was admin/reviewer only) deliberately held this role
// back — Peter decided 2026-09-01 to include it, but Asimov required a
// separate Mason Fair Housing review before it actually shipped here (POST
// /claims/:id/review below already granted this role starting with commit
// 79c43cf and was untouched by that narrowing — see its own comment).
// Mason has since reviewed and given a conditional yes: director_of_operations
// back in, ON CONDITION that (1) a one-time acknowledgment gate stands
// between this role and any flagged claim text or Confirm/Correct/Reject
// action, and (2) the audit log captures the acting role, not just email —
// both implemented below (see PRIVACY_QUEUE_ACK_ACTION / PRIVACY_QUEUE_ACK_ROLE
// and the review route's audit_log write). Full decision trail:
// compliance/director-of-operations-privacy-review-access.md.
const PRIVACY_REVIEW_ROLES = ['admin', 'reviewer', 'director_of_operations'];

// ─── One-time privacy-queue acknowledgment gate — Mason's condition 1
// (see PRIVACY_REVIEW_ROLES comment above). admin/reviewer are NOT subject
// to this — they had this access before this build and their experience is
// unchanged. It exists specifically because director_of_operations is
// newly gaining exposure to flagged (protected-class-adjacent) claim
// content it never had a working path to before. Tracked as an audit_log
// row (action = PRIVACY_QUEUE_ACK_ACTION, actor_id = the person's email),
// not a new table/column — reusing audit_log matches this codebase's
// existing "don't build schema ahead of a proven need" pattern (see
// property-overview-SPEC.md's own reasoning for skipping a cache table),
// and audit_log already has both the indexes this lookup needs
// (idx_audit_log_action on action, idx_audit_log_actor on
// (actor_type, actor_id) — 20260720000003_foundation.sql /
// 20260815000000_audit_log_rule1_compliance.sql), so a targeted
// action+actor_id filter is a cheap indexed lookup, not a table scan.
const PRIVACY_QUEUE_ACK_ACTION = 'maintenance_claims.privacy_queue_acknowledged';
const PRIVACY_QUEUE_ACK_ROLE = 'director_of_operations';

// count:'exact'+head:true — same established pattern as the
// flagged_review_count check below (and security-deposit/router.js's
// lease_tenants count check) rather than fetching and comparing rows.
async function hasAcknowledgedPrivacyQueue(email) {
  const { count, error } = await supabase
    .from('audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('action', PRIVACY_QUEUE_ACK_ACTION)
    .eq('actor_id', email);
  if (error) throw error;
  return (count || 0) > 0;
}

const PRIVACY_QUEUE_ACK_MESSAGE =
  'This queue contains real tenant claims touching Fair Housing-protected characteristics ' +
  '(race, disability, immigration status, health, familial status, and similar). Treat everything ' +
  "here as confidential, and use it only for legitimate review — not for any other purpose. " +
  "You'll only see this notice once.";

// ─── Shared review-action helpers ───────────────────────────────────────
// Factored out for the maintenance_snapshot_events review route added
// below (governance fix, 2026-09-03: flagged snapshot-event rows had no
// path to a human reviewer — see GET /flagged-queue's own comment) so its
// acknowledgment gate and audit-log write are the exact same code as
// POST /claims/:id/review's, not a hand-copied second version that could
// drift. The three existing call sites (claims review, the ack route
// itself, and the flagged-queue view-log) were rewritten to use these
// too, with no change in what gets written to audit_log — same action
// strings, same entity_type values, same details shape as before this
// build.

// audit_log.performed_by is a foreign key into the older `users` table
// (20260720000003_foundation.sql), not into Supabase Auth — see POST
// /claims/:id/review's git history for the original FK-violation story
// if that context is ever needed again. Returns null (a valid "system
// action" performed_by) if no matching `users` row exists for this email.
async function lookupUserId(email) {
  const { data } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
  return data ? data.id : null;
}

// Rule 1 fields (GOVERNANCE.md / the snapshot-events migration's "AUDIT
// LOG GUIDANCE FOR Q") written the same way at every call site:
// performed_by resolved via lookupUserId, actor_type/actor_id always the
// human's own email, privacy_category defaulted to 'processing' (every
// call site here uses that value; pass a different one explicitly if
// that ever changes). Returns true/false so a caller that must fail
// closed on a write error (the acknowledgment route below) still can —
// every other caller just ignores the return value, matching the
// log-and-continue behavior this code already had before this helper
// existed.
async function writeAuditLog({ action, entity_type, entity_id, actor_email, risk_level, privacy_category, details }) {
  const performed_by = await lookupUserId(actor_email);
  const { error } = await supabase.from('audit_log').insert({
    action,
    entity_type,
    entity_id,
    performed_by,
    actor_type: 'human',
    actor_id: actor_email,
    privacy_category: privacy_category || 'processing',
    risk_level: risk_level || 'low',
    details: details || {},
  });
  if (error) {
    console.error(`[maintenance-history] audit_log insert failed for ${action}:`, error.message);
    return false;
  }
  return true;
}

// Acknowledgment gate, Mason's condition 1 (PRIVACY_REVIEW_ROLES comment
// above) — director_of_operations only. Writes the 403 itself on failure
// so every caller's error handling is identical; a caller awaits this and
// returns immediately if it's false. The role check happens first, so
// calling this unconditionally is always safe for admin/reviewer (a
// no-op — returns true immediately, no query run). Callers that must
// only gate a FLAGGED item (claims/snapshot-event review) additionally
// guard the call with `before.flagged_protected_class &&` themselves;
// GET /flagged-queue calls it unconditionally, since everything that
// route returns is flagged by definition.
async function requireAcknowledgment(req, res) {
  if (req.maintenanceHistoryRole !== PRIVACY_QUEUE_ACK_ROLE) return true;
  let acknowledged;
  try {
    acknowledged = await hasAcknowledgedPrivacyQueue(req.user.email);
  } catch (err) {
    res.status(500).json({ error: err.message });
    return false;
  }
  if (!acknowledged) {
    res.status(403).json({ error: 'privacy_queue_acknowledgment_required', message: PRIVACY_QUEUE_ACK_MESSAGE });
    return false;
  }
  return true;
}

// Flagged-count helper for maintenance_snapshot_events — governance fix,
// 2026-09-03. Always scoped to a single property: property_id is a real,
// direct column on this table (see the migration's "WHY A REAL
// property_id FK" note), so no unit/ticket hop is needed the way
// maintenance_claims' own flagged count requires. Shared by both
// property-scoped flaggedReviewCount blocks below (/overview and
// /summary) so the two badge counts can't drift apart from each other,
// and by the merged flagged-queue route further down.
async function countFlaggedSnapshotEvents(propertyId) {
  const { count, error } = await supabase
    .from('maintenance_snapshot_events')
    .select('id', { count: 'exact', head: true })
    .eq('property_id', propertyId)
    .eq('flagged_protected_class', true)
    .eq('review_status', 'unreviewed');
  if (error) throw error;
  return count || 0;
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

// ─── GET /privacy-review — portfolio-wide "Needs privacy review" entry
// point ────────────────────────────────────────────────────────────────
// server.js mounts property360Router before this router, and
// property-360/router.js's own GET /maintenance-history handler answers
// that exact path first (its documented old-bookmark redirect — see that
// file's comment) — so this file's GET /maintenance-history handler right
// above never actually runs today. That redirect is untouched by this
// change. This is a NEW, un-shadowed path serving the exact same
// dashboard/index.html this file has always served, same read-file-and-
// inject-search-widget approach as above, so a reviewer has one direct
// link to the portfolio-wide grouped flagged-items queue instead of
// clicking into ~390 properties one at a time (Peter, 2026-09-03 — going
// property-by-property for 290+ flagged items was too slow).
//
// The one difference from the handler above: this also injects a small
// inline script setting window.MH_DEFAULT_TAB = 'flagged', read by
// dashboard/index.html's init() to open straight on the "Needs privacy
// review" tab, portfolio-wide (no property filter), instead of Property
// Overview. That flag is only ever set by THIS route's response — the
// handler above never sets it — so this is scoped entirely to this new
// path and changes nothing about how GET /maintenance-history behaves
// (moot today anyway, since it's unreachable, but kept byte-for-byte
// identical regardless, per the build instructions).
//
// No new access gate here, on purpose — same as every other tool's page
// shell in this Hub (e.g. insurance/router.js's GET /insurance): the real
// protection is on the API calls the page makes once loaded
// (requireMaintenanceHistoryAccess, the PRIVACY_REVIEW_ROLES gate on
// GET /api/maintenance-history/flagged-queue, and director_of_operations'
// one-time acknowledgment gate), all unchanged by this route.
router.get('/privacy-review', (req, res) => {
  fs.readFile(path.join(__dirname, 'dashboard', 'index.html'), 'utf8', (err, html) => {
    if (err) return res.status(500).send('Could not load page.');
    const injected = '<body>\n' + GLOBAL_SEARCH_WIDGET_HTML +
      '\n<script>window.MH_DEFAULT_TAB = \'flagged\';</script>';
    res.send(html.replace('<body>', injected));
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
        units ( unit_number, properties ( id, name, address ) )
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
    property_id: r.units && r.units.properties ? r.units.properties.id : null,
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

// ─── Property Overview — property-overview-SPEC.md, Steps 1-5 ──────────
// Request-time aggregation + synthesis, no caching table (spec's
// "Deliberately not built for v1" — this is a first-day/decision-support
// lookup tool, not a high-traffic dashboard). Reads
// maintenance_claims_decision_safe exactly as the spec directs — flagged
// and rejected claims are already structurally excluded upstream; this
// route does not invent a second exclusion path for claims.
//
// Step 4's recency cutoff — a plain constant, not a researched number
// (SPEC.md Open Item #3), matching the RESULT_LIMIT pattern already used
// in lib/property-search.js. Easy to change here since it lives in code,
// not a database value.
const RECENT_MONTHS = 12;

function monthsAgo(n) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return d;
}

// Asimov governance review, 2026-08-31, condition 2: when a synthesized
// sentence cites claims with mixed review_status, the displayed marker
// must show the LEAST-confirmed status of the set — any 'unreviewed'
// citation makes the whole sentence read 'unreviewed', never
// 'confirmed'/'corrected' just because another cited claim happens to be
// reviewed. Rejected claims never reach here (excluded by
// maintenance_claims_decision_safe), so only these three ever appear.
const REVIEW_STATUS_RANK = { unreviewed: 0, corrected: 1, confirmed: 2 };
function leastConfirmedStatus(statuses) {
  if (!statuses.length) return 'unreviewed';
  return statuses.reduce((worst, s) =>
    (REVIEW_STATUS_RANK[s] ?? 0) < (REVIEW_STATUS_RANK[worst] ?? 0) ? s : worst
  );
}

// Asimov governance review, 2026-08-31, condition 1 (Finding 3): this
// page's "unmatched ticket" path shows maintenance_requests.title/
// description straight from AppFolio (appfolio-sync/sync.js ~line 280,
// job_description/service_request_description) — raw staff/vendor free
// text that has NEVER passed through the two-layer content check that
// gates maintenance_claims (that check only runs on the Latchel-derived
// extraction pipeline). Applied here to every raw title this page shows
// — unmatched-ticket one-liners, the older-history compressed line, and
// the "Currently Open" list — not only the literal unmatched path Asimov
// named, since all three pull from the same unscreened AppFolio fields.
// On a hit: show a generic placeholder instead of the raw text, and log
// the exclusion the same way a flagged claim is logged today.
const APPFOLIO_EXCLUSION_ACTION = 'maintenance_history.appfolio_text_excluded';
const APPFOLIO_TEXT_PLACEHOLDER = 'AppFolio record — see ticket for details';

async function safeTicketTitle(ticket, propertyId) {
  const raw = (ticket.title || '').split('\n')[0] || '(no title)';
  const scan = scanText(`${ticket.title || ''} ${ticket.description || ''}`);
  if (!scan.flagged) return { text: raw, flagged: false };

  // Log once per ticket, not once per page view — check for an existing
  // entry first so repeat visits to the same property don't write a new
  // audit_log row every time for a flag that's already on record.
  try {
    const { data: existing, error: existingErr } = await supabase
      .from('audit_log')
      .select('id')
      .eq('action', APPFOLIO_EXCLUSION_ACTION)
      .eq('entity_id', ticket.id)
      .maybeSingle();
    if (existingErr) throw existingErr;
    if (!existing) {
      await supabase.from('audit_log').insert({
        action: APPFOLIO_EXCLUSION_ACTION,
        entity_type: 'maintenance_request',
        entity_id: ticket.id,
        actor_type: 'system',
        actor_id: 'maintenance-history-content-check',
        actor_version: TERMS_VERSION,
        privacy_category: 'processing',
        risk_level: 'high',
        property_id: propertyId || null,
        details: { flagged_category: scan.categories.join(', '), matched_layer: 'keyword', source: 'appfolio_title_description' },
      });
    }
  } catch (err) {
    console.error('[maintenance-history] audit_log check/insert failed for AppFolio text exclusion:', err.message);
  }

  return { text: APPFOLIO_TEXT_PLACEHOLDER, flagged: true };
}

router.get('/api/maintenance-history/property/:property_id/overview', requireMaintenanceHistoryAccess, async (req, res) => {
  const propertyId = req.params.property_id;
  if (!isValidUuid(propertyId)) {
    return res.status(400).json({ error: 'That property ID is not valid.' });
  }

  const { data: property, error: propErr } = await supabase
    .from('properties')
    .select('id, name, address, city, state, zip, unit_count, appfolio_id')
    .eq('id', propertyId)
    .maybeSingle();
  if (propErr) return res.status(500).json({ error: propErr.message });
  if (!property) return res.status(404).json({ error: 'Property not found.' });

  // Per-ticket safe-title lookups are cached for the life of this request
  // — the same ticket can appear in "Currently Open," a component's
  // detail list, and its compressed line, and safeTicketTitle's audit-log
  // check/insert shouldn't run three times for one page view.
  const safeTitleCache = new Map();
  async function getSafeTitle(ticket) {
    if (safeTitleCache.has(ticket.id)) return safeTitleCache.get(ticket.id);
    const result = await safeTicketTitle(ticket, property.id);
    safeTitleCache.set(ticket.id, result);
    return result;
  }

  // ── Header: units + occupancy/lease status ──────────────────────────
  const { data: units, error: unitsErr } = await supabase
    .from('units')
    .select('id, unit_number, status')
    .eq('property_id', property.id)
    .order('unit_number', { ascending: true });
  if (unitsErr) return res.status(500).json({ error: unitsErr.message });
  const unitIds = (units || []).map(u => u.id);

  const leaseByUnit = {};
  if (unitIds.length) {
    const { data: leases, error: leasesErr } = await supabase
      .from('leases')
      .select('unit_id, status, lease_end')
      .in('unit_id', unitIds)
      .order('lease_end', { ascending: false });
    if (leasesErr) return res.status(500).json({ error: leasesErr.message });
    // Sorted lease_end desc above, so the first row seen per unit is
    // already its most-recent lease; only replace it if a later row is
    // 'active' and the one already stored isn't (prefer an active lease
    // over a more-recent-but-lapsed one).
    for (const l of leases || []) {
      const existing = leaseByUnit[l.unit_id];
      if (!existing || (l.status === 'active' && existing.status !== 'active')) {
        leaseByUnit[l.unit_id] = l;
      }
    }
  }

  // Occupancy is derived from a real active lease, not units.status —
  // confirmed live 2026-09-01 that the AppFolio sync writes 'vacant' for
  // every unit on every run (unit_directory's default, never overwritten
  // to 'occupied' anywhere) and nothing else ever sets it, so units.status
  // reads "vacant" portfolio-wide regardless of real occupancy. This
  // endpoint already fetches each unit's active lease for lease_end above;
  // reusing it here is the correct signal, not a workaround.
  const unitRows = (units || []).map(u => ({
    id: u.id,
    unit_number: u.unit_number,
    status: leaseByUnit[u.id] && leaseByUnit[u.id].status === 'active' ? 'occupied' : 'vacant',
    lease_end: leaseByUnit[u.id] ? leaseByUnit[u.id].lease_end : null,
  }));

  // ── Header: current owner. property_owners has no FK here — it joins
  // on AppFolio's own text IDs (20260720000002_owners.sql) — and only
  // ever holds the CURRENT owner-property link (no start/end date), a
  // limitation this response surfaces via has_owner_history_gap so the UI
  // can show it honestly rather than implying this is full ownership
  // history. ─────────────────────────────────────────────────────────
  let owners = [];
  if (property.appfolio_id) {
    const { data: poRows, error: poErr } = await supabase
      .from('property_owners')
      .select('appfolio_owner_id')
      .eq('appfolio_property_id', property.appfolio_id);
    if (poErr) return res.status(500).json({ error: poErr.message });
    const ownerIds = (poRows || []).map(p => p.appfolio_owner_id);
    if (ownerIds.length) {
      const { data: ownerRows, error: ownerErr } = await supabase
        .from('owners')
        .select('name, phone, email')
        .in('appfolio_id', ownerIds);
      if (ownerErr) return res.status(500).json({ error: ownerErr.message });
      owners = ownerRows || [];
    }
  }

  // ── Every maintenance_requests row for this property, Latchel-matched
  // or not — SPEC.md's "completeness point": an unmatched ticket still
  // exists with real AppFolio fields and must not be silently dropped
  // from "everything that's going on." ─────────────────────────────────
  let tickets = [];
  if (unitIds.length) {
    const { data: mrRows, error: mrErr } = await supabase
      .from('maintenance_requests')
      .select('id, title, description, status, cost, vendor_name, completed_at, created_at, appfolio_id, latchel_job_id, unit_id')
      .in('unit_id', unitIds);
    if (mrErr) return res.status(500).json({ error: mrErr.message });
    tickets = mrRows || [];
  }

  // ── Spend rollup — pure SQL-shape sum over already-synced cost values,
  // not itemized invoice reconciliation (spec's "light context, not full
  // financial reconciliation"). ────────────────────────────────────────
  const twelveMonthsAgo = monthsAgo(RECENT_MONTHS);
  let spendTrailing12 = 0;
  let spendAllTime = 0;
  for (const t of tickets) {
    const cost = typeof t.cost === 'number' ? t.cost : 0;
    spendAllTime += cost;
    const d = t.completed_at || t.created_at;
    if (d && new Date(d) >= twelveMonthsAgo) spendTrailing12 += cost;
  }

  const baseResponse = {
    property: {
      id: property.id, name: property.name, address: property.address,
      city: property.city, state: property.state, zip: property.zip, unit_count: property.unit_count,
    },
    owners: owners.map(o => ({ name: o.name, phone: o.phone, email: o.email })),
    has_owner_history_gap: true, // property_owners holds current ownership only — see comment above
    units: unitRows,
    spend: {
      trailing_12mo: Math.round(spendTrailing12 * 100) / 100,
      all_time: Math.round(spendAllTime * 100) / 100,
      note: 'Sum of maintenance_requests.cost as synced from AppFolio — not every work order has a cost populated, so this is a lower bound, not full invoice reconciliation.',
    },
    has_data: tickets.length > 0,
  };

  if (tickets.length === 0) {
    return res.json({
      ...baseResponse,
      open_items: [],
      components: [],
      no_data_message: 'No maintenance ticket data synced for this property yet.',
    });
  }

  // ── Flagged-privacy-review count, role-gated — shared-property-context-
  // SPEC.md Part 2. Queried against the raw maintenance_claims table, not
  // maintenance_claims_decision_safe above — that view structurally
  // excludes flagged rows, which is exactly what this count needs to see.
  // count:'exact'+head:true matches the established pattern
  // (security-deposit/router.js's lease_tenants count check) rather than
  // fetching and counting rows client-side.
  //
  // Left undefined (never spread into the response) for any role outside
  // PRIVACY_REVIEW_ROLES, and also when the real count is 0 — same
  // omit-don't-send-a-zero discipline in both cases, so there is no code
  // path where presence of the key itself doesn't already mean "a person
  // with real reviewer access should look at this."
  const ticketIds = tickets.map(t => t.id);
  let flaggedReviewCount = null;
  if (PRIVACY_REVIEW_ROLES.includes(req.maintenanceHistoryRole)) {
    const { count: flaggedCount, error: flaggedCountErr } = await supabase
      .from('maintenance_claims')
      .select('id', { count: 'exact', head: true })
      .in('maintenance_request_id', ticketIds)
      .eq('flagged_protected_class', true)
      .eq('review_status', 'unreviewed');
    if (flaggedCountErr) return res.status(500).json({ error: flaggedCountErr.message });
    // Governance fix, 2026-09-03: flagged maintenance_snapshot_events rows
    // for this property need to feed the same badge count as flagged
    // claims — see countFlaggedSnapshotEvents' own comment above.
    let flaggedSnapshotCount;
    try {
      flaggedSnapshotCount = await countFlaggedSnapshotEvents(property.id);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    flaggedReviewCount = (flaggedCount || 0) + flaggedSnapshotCount;
  }

  // ── Claims for every ticket on this property, decision-safe only —
  // reused exactly as SPEC.md directs, no new exclusion path for claims.
  const { data: claimRows, error: claimsErr } = await supabase
    .from('maintenance_claims_decision_safe')
    .select('id, maintenance_request_id, claim_type, claim_text, claim_date, outcome_level, review_status')
    .in('maintenance_request_id', ticketIds);
  if (claimsErr) return res.status(500).json({ error: claimsErr.message });

  const claimsByTicket = {};
  for (const c of claimRows || []) {
    (claimsByTicket[c.maintenance_request_id] = claimsByTicket[c.maintenance_request_id] || []).push(c);
  }
  const allClaimIds = new Set((claimRows || []).map(c => c.id));
  const claimById = new Map((claimRows || []).map(c => [c.id, c]));

  // ── Per-ticket derived facts — Steps 1-4: component bucket(s),
  // open/resolved, recurrence, recency. ────────────────────────────────
  const enriched = tickets.map(t => {
    const claims = claimsByTicket[t.id] || [];
    const hasClaims = claims.length > 0;
    const outcomeLevels = claims.filter(c => c.claim_type === 'outcome' && c.outcome_level != null).map(c => c.outcome_level);
    const maxOutcomeLevel = outcomeLevels.length ? Math.max(...outcomeLevels) : 0;
    const hasRecurrenceClaim = claims.some(c => c.claim_type === 'recurrence');
    const statusResolved = ['completed', 'closed'].includes(t.status);
    // Step 2 — made from the claims' own outcome evidence when claims
    // exist, not just the AppFolio status field: a "Completed" ticket
    // whose only outcome claim is level 1 ("vendor says done") still
    // reads as unresolved here, exactly the 17445-1 case the spec calls
    // out. Falls back to AppFolio status alone for tickets with no
    // Latchel claims at all — nothing to check outcome evidence against.
    const resolved = hasClaims ? (statusResolved && maxOutcomeLevel >= 3) : statusResolved;
    const recencyDate = t.completed_at || t.created_at || null;
    const recent = !resolved || hasRecurrenceClaim || (recencyDate && new Date(recencyDate) >= twelveMonthsAgo);
    const components = componentCategories.categorize(`${t.title || ''} ${t.description || ''}`);
    return { ticket: t, claims, hasClaims, maxOutcomeLevel, hasRecurrenceClaim, resolved, recencyDate, recent, components };
  });

  // ── "Currently Open / Unresolved" — pinned above the component
  // breakdown, per spec's "single most important section." One row per
  // ticket (not per component), listing every component it touches. ────
  const openItemsRaw = enriched.filter(e => !e.resolved);
  const open_items = [];
  for (const e of openItemsRaw) {
    const label = await getSafeTitle(e.ticket);
    open_items.push({
      ticket_id: e.ticket.id,
      title: label.text,
      title_redacted: label.flagged,
      status: e.ticket.status,
      appfolio_id: e.ticket.appfolio_id,
      cost: e.ticket.cost,
      components: e.components.map(k => componentCategories.CATEGORY_LABELS[k]),
      last_activity: e.recencyDate,
    });
  }
  open_items.sort((a, b) => (a.last_activity < b.last_activity ? 1 : a.last_activity > b.last_activity ? -1 : 0));

  // ── By System — one card per component bucket that actually has data
  // for this property (empty buckets don't show). ─────────────────────
  const components = [];
  for (const key of componentCategories.CATEGORY_ORDER) {
    const bucketTickets = enriched
      .filter(e => e.components.includes(key))
      .sort((a, b) => (a.recencyDate || '') < (b.recencyDate || '') ? 1 : (a.recencyDate || '') > (b.recencyDate || '') ? -1 : 0);
    if (!bucketTickets.length) continue;

    // Step 3 — recurring marker: any claim_type='recurrence' row, or two
    // or more tickets in this bucket.
    const recurring = bucketTickets.length >= 2 || bucketTickets.some(e => e.hasRecurrenceClaim);

    // Step 4 — recent gets detail, old gets compressed.
    const detailed = bucketTickets.filter(e => e.recent);
    const compressed = bucketTickets.filter(e => !e.recent);

    // Step 5 — synthesis, built only from claims belonging to "detailed"
    // tickets in this bucket. Compressed old history gets a deterministic
    // one-line summary below, not an AI call.
    //
    // Judge's finding, this build: ticket_title here used to be raw
    // (e.ticket.title || '').split('\n')[0] — never scanned, even though
    // this same title IS scanned via getSafeTitle()/safeTicketTitle() before
    // DISPLAY everywhere else on this page (open_items above, the
    // compressed_line and unmatched_entries below). A flagged title reaching
    // the synthesis prompt as AI context could influence or leak into a
    // generated sentence shown to every role (this page has no role gate at
    // all). Reusing getSafeTitle() here — not a second scan implementation —
    // closes that gap the same way display already is closed: a flagged
    // title is replaced with the same safe placeholder before it ever
    // becomes prompt text, not just before it's rendered. One lookup per
    // ticket (not per claim) via the same request-scoped cache getSafeTitle
    // already uses.
    const detailedClaims = [];
    for (const e of detailed) {
      if (!e.hasClaims) continue;
      const label = await getSafeTitle(e.ticket);
      for (const c of e.claims) {
        detailedClaims.push({
          id: c.id, claim_type: c.claim_type, claim_text: c.claim_text, claim_date: c.claim_date,
          ticket_title: label.text,
        });
      }
    }

    let synthesis = null;
    if (detailedClaims.length) {
      try {
        const result = await synthesizeComponent({
          componentLabel: componentCategories.CATEGORY_LABELS[key],
          propertyLabel: property.name || property.address,
          claims: detailedClaims,
        });
        // Citation validation (spec Step 5) — every cited claim_id must
        // actually exist and actually belong to this property's real
        // claim set, or that sentence is dropped rather than shown.
        const validatedSentences = [];
        for (const s of result.sentences) {
          const validIds = s.claim_ids.filter(id => allClaimIds.has(id));
          if (!validIds.length) continue; // fully hallucinated citation — drop the sentence
          // Defense-in-depth, per Judge's alternative suggestion this build:
          // the claims fed into this prompt already passed the two-layer
          // content check at ingestion (maintenance_claims_decision_safe),
          // and the ticket title feeding it is now scanned too (above), but
          // the model's own generated wording is a third, independent
          // surface — a borderline-but-passed claim could still combine
          // into a sentence that itself reads as protected-class-flagged.
          // Same drop-and-continue as the hallucinated-citation check right
          // above: if the generated text itself trips the scan, the
          // sentence is dropped, not shown.
          if (scanText(s.text).flagged) continue;
          const statuses = validIds.map(id => claimById.get(id).review_status);
          validatedSentences.push({ text: s.text, claim_ids: validIds, review_status: leastConfirmedStatus(statuses) });
        }
        synthesis = { sentences: validatedSentences, truncated: !!result.truncated && validatedSentences.length === 0 };
      } catch (err) {
        console.error(`[maintenance-history] overview synthesis failed for component "${key}", property ${property.id}:`, err.message);
        synthesis = { sentences: [], truncated: false, error: true };
      }
    }

    // Step 4's compressed line — deterministic, not AI: "Also resolved,
    // no recurrence since: X (Mon YYYY); Y (Mon YYYY)." Covers BOTH
    // matched and unmatched old/resolved/non-recurring tickets.
    let compressed_line = null;
    if (compressed.length) {
      const parts = [];
      for (const e of compressed) {
        const label = await getSafeTitle(e.ticket);
        const dateStr = e.recencyDate ? new Date(e.recencyDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'date unknown';
        parts.push(`${label.text} (${dateStr})`);
      }
      compressed_line = `Also resolved, no recurrence since: ${parts.join('; ')}.`;
    }

    // Unmatched-ticket minimal one-liners — SPEC.md's completeness point:
    // "a matched ticket gets the full synthesized treatment; an unmatched
    // one still gets a minimal one-line entry sourced straight from
    // AppFolio's own fields." Only covers DETAILED unmatched tickets —
    // compressed unmatched tickets are already folded into
    // compressed_line above.
    const unmatched_entries = [];
    for (const e of detailed) {
      if (e.hasClaims) continue;
      const label = await getSafeTitle(e.ticket);
      const costStr = typeof e.ticket.cost === 'number' ? `$${e.ticket.cost.toFixed(2)}` : 'cost not recorded';
      const dateStr = e.ticket.completed_at ? e.ticket.completed_at.slice(0, 10) : null;
      const statusStr = e.resolved
        ? `completed ${dateStr || '(date not recorded)'}`
        : 'still open';
      unmatched_entries.push({
        ticket_id: e.ticket.id,
        text: `${label.text} — ${statusStr}, ${costStr}${e.ticket.vendor_name ? ', vendor: ' + e.ticket.vendor_name : ''} — no detailed Latchel history available.`,
        title_redacted: label.flagged,
      });
    }

    const bucketDates = bucketTickets.map(e => e.recencyDate).filter(Boolean).sort();

    components.push({
      key,
      label: componentCategories.CATEGORY_LABELS[key],
      ticket_count: bucketTickets.length,
      date_range: { earliest: bucketDates[0] || null, latest: bucketDates[bucketDates.length - 1] || null },
      recurring,
      synthesis,
      compressed_line,
      unmatched_entries,
      open_ticket_ids: detailed.filter(e => !e.resolved).map(e => e.ticket.id),
    });
  }

  return res.json({
    ...baseResponse,
    open_items,
    components,
    ...(flaggedReviewCount ? { flagged_review_count: flaggedReviewCount } : {}),
  });
});

// MAINT_RELATED_ACCOUNTS — AppFolio gl_account_name values that count as
// maintenance/repair spend. Confirmed live against this account's real
// chart of accounts while building sync.js's annual_budget_forecast entry
// — there is no single "Repairs & Maintenance" GL line. Defined once here
// (not duplicated) and reused by both getMaintenanceHistoryPropertySummary
// below and the Budget route further down this file — same list, same
// convention, so they can't drift into two different definitions of
// "maintenance spend."
const MAINT_RELATED_ACCOUNTS = ['Repair', 'Maintenance Labor', 'Roof Repairs and Maintenance', 'Maintenance Only-OBP'];

// ─── Vendor -> repair-type category, for the Maintenance card's "where the
// money went" pie chart (Property 360). Deliberately infers the trade from
// the VENDOR'S OWN NAME ONLY — never from a ticket/bill's free-text
// description (work_order_issue, claim_text, summary) — so this never
// touches the same fields the Fair Housing privacy-review pipeline gates,
// and needs no privacy review of its own (Peter's explicit approval for
// this build). A plain keyword heuristic, not AI: this is a one-time-ish
// classification of trade names in a vendor list, not a judgment call
// about a person or a situation.
//
// Order matters — rules are checked top-to-bottom, first match wins, so a
// narrower/more-specific keyword is placed before a broader one that could
// appear as a false-positive substring inside it (e.g. "PuroClean
// Disaster Recovery Services" contains "Clean" — Restoration is checked
// before Cleaning so it resolves correctly).
//
// Built and verified live, 2026-09-03, against the real 107 distinct
// vendor_name values in maintenance_snapshot_events (see this build's
// report for the full vendor -> category listing Peter reviewed). Any
// vendor name that doesn't clearly signal a trade — including a bare
// person's name ("Rodriguez, Jorge Luis") or a generic company name
// ("Paramount", "Two Trees Home Services Inc") — or a trade this list
// doesn't cover (e.g. life-safety/fire-alarm vendors) — deliberately
// falls through to 'Other / Handyman' rather than guessing. "Quick Turn
// Maintenance" used to be one of these (a generic name with no
// self-reported trade) but got its own known-vendor special case below,
// 2026-09-04, once Peter confirmed what it does — see that special case's
// own comment.
const VENDOR_CATEGORY_RULES = [
  ['Restoration & Water Damage', /restoration|disaster recovery|flood|environmental|\benviro\b/i],
  ['Pest Control', /pest|termite/i],
  ['Locksmith', /locksmith|lock and key|lock & key/i],
  ['Roofing', /\broof|gutter/i],
  ['Plumbing', /plumb|backflow|\bdrain|rooter|sewer/i],
  ['Electrical', /\belectric/i],
  ['HVAC', /heating|\bhvac\b|air condition|\baire\b|\bair\b|\bmechanical\b/i],
  ['Painting', /\bpaint/i],
  ['Flooring', /\bfloor/i],
  ['Cleaning', /\bclean|\blint\b|carpet|upholstery/i],
  ['Landscaping & Tree Service', /landscap|\blawn\b|\btree\b/i],
  ['Doors, Windows & Glass', /window|glass|garage door|\bscreen\b/i],
  ['Appliance Repair', /appliance|refrigerat/i],
  ['Fireplace & Chimney', /fireplace|chimney/i],
  ['Fencing', /\bfence\b|fencing/i],
];

function categorizeMaintenanceVendor(vendorName) {
  const name = (vendorName || '').trim();
  if (!name) return 'Other / Handyman';
  // Rincon's own markup/admin-fee line items riding on top of another
  // vendor's real line item for the same job (confirmed against
  // backfill-maintenance-snapshot.js's own ingest comments — AppFolio's
  // bill_detail report carries both as separate rows for one job). Not a
  // trade, and there's no reliable job-pairing column in this schema to
  // fold it into whichever vendor it rode in with, so it gets its own
  // honest "Maintenance Coordination Fee" slice instead of being
  // misattributed to a trade or silently dropped. Named "Management
  // Fee" until 2026-09-04 — renamed at Peter's request, this fee is
  // specifically for coordinating maintenance, not general management.
  if (/rincon/i.test(name) && /management/i.test(name)) return 'Maintenance Coordination Fee';
  // Known-vendor special case, not a general rule — "Quick Turn
  // Maintenance" is 33% of ALL 5-year maintenance dollars portfolio-wide
  // ($1.09M) and its name doesn't self-report a trade, so it fell through
  // to 'Other / Handyman' with every other unclear vendor. Peter, asked
  // directly what this vendor does (2026-09-04): "general handyman and
  // turnover work and preventative maintenance." Matched on the vendor's
  // known name specifically (not a broad keyword like "quick" or "turn")
  // so this can't accidentally catch an unrelated vendor — e.g. "Quick
  // Turn Cleaners" (a real, different vendor in this database) still
  // correctly falls through to the Cleaning rule below, untouched.
  if (/quick turn maintenance/i.test(name)) return 'Handyman, Turnover & Preventative Maint.';
  for (const [category, regex] of VENDOR_CATEGORY_RULES) {
    if (regex.test(name)) return category;
  }
  return 'Other / Handyman';
}

// ─── GET /api/maintenance-history/property/:property_id/summary ────────
// Property 360's Maintenance summary card — property-360-SPEC.md's
// "Maintenance History — summary card" section. Deliberately NOT a call
// into the /overview route above: that route groups tickets by system and
// calls Claude once per non-empty component bucket
// (property-overview-SPEC.md's Step 5) — real AI cost and latency a
// glance-only summary card shouldn't pay every time someone opens a
// property. This route is pure SQL, reusing the exact trailing-12mo-spend
// math already written above (RECENT_MONTHS / monthsAgo()) and the exact
// gated flagged_review_count pattern already written for /overview — as
// the same functions/constants, not a second copy that could drift.
//
// Asimov's condition on this build, verified again at Judge review: this
// route must never read maintenance_claims or maintenance_claims_decision_safe
// for CONTENT. The one place it touches maintenance_claims at all is the
// same count-only, head:true lookup /overview's flagged_review_count
// already uses — already reviewed and approved by Asimov ("the reused
// count function does technically query maintenance_claims for a
// count-only head query, never content... what actually matters — no
// claim text ever leaves that function — holds"). No claim row, of any
// shape, is ever selected or returned here.
// Named (not an inline arrow function) and exported below, alongside
// attachMaintenanceHistoryRole/requireMaintenanceHistoryAccess/
// requireMaintenanceHistoryRole — property-360-SPEC.md's aggregation
// route calls this in-process to get the Maintenance summary card's
// actual data. Same "literally the same function, called the same way"
// reuse already established for the access-check functions, rather than
// a second HTTP round-trip back into this same server or a duplicated
// copy of this query logic (which reuses RECENT_MONTHS/monthsAgo() and
// the PRIVACY_REVIEW_ROLES-gated flagged-count pattern defined above)
// living in two files. Zero change to this function's own behavior —
// same handler, same route, just also reachable in-process.
async function getMaintenanceHistoryPropertySummary(req, res) {
  const propertyId = req.params.property_id;
  if (!isValidUuid(propertyId)) {
    return res.status(400).json({ error: 'That property ID is not valid.' });
  }

  const { data: property, error: propErr } = await supabase
    .from('properties')
    .select('id, name, address, city, appfolio_id')
    .eq('id', propertyId)
    .maybeSingle();
  if (propErr) return res.status(500).json({ error: propErr.message });
  if (!property) return res.status(404).json({ error: 'Property not found.' });

  const { data: units, error: unitsErr } = await supabase
    .from('units')
    .select('id')
    .eq('property_id', property.id);
  if (unitsErr) return res.status(500).json({ error: unitsErr.message });
  const unitIds = (units || []).map(u => u.id);

  // Same fields /overview's own spend math reads (status, cost,
  // completed_at/created_at) — nothing from maintenance_claims. Open
  // ticket count uses the plain AppFolio status field only, per
  // property-360-SPEC.md's own table ("maintenance_requests.status for
  // this property's units, not closed/completed") — deliberately NOT
  // /overview's richer claims-informed "resolved" logic above (which
  // reads outcome claims' text to override a stale "Completed" status).
  // Pulling that richer logic in here would mean this route reading
  // claim content, which is exactly what it must never do.
  let tickets = [];
  if (unitIds.length) {
    const { data: mrRows, error: mrErr } = await supabase
      .from('maintenance_requests')
      .select('id, status, cost, completed_at, created_at, latchel_vendor_id, latchel_vendor_name')
      .in('unit_id', unitIds);
    if (mrErr) return res.status(500).json({ error: mrErr.message });
    tickets = mrRows || [];
  }

  const openTicketCount = tickets.filter(t => !['completed', 'closed'].includes(t.status)).length;

  // Same trailing-12mo sum as /overview's baseResponse.spend, reusing
  // RECENT_MONTHS/monthsAgo() defined above — not a second copy of the
  // math. last_activity is new here (not something /overview's response
  // already surfaces as a single field) but uses the exact same
  // completed_at-then-created_at fallback /overview's own recencyDate
  // logic uses per ticket.
  const twelveMonthsAgo = monthsAgo(RECENT_MONTHS);
  let spendTrailing12 = 0;
  let lastActivity = null;
  // Vendor history (property-360-SPEC.md "Vendor history") — both columns
  // are written only by the nightly Latchel ingest (internal/ingest route
  // below), never looked up live here. Distinct count is keyed on
  // latchel_vendor_id, not the display name — the migration's own
  // "many-to-one" identity (the same vendor legitimately does many
  // tickets) — so two tickets for the same vendor never double-count.
  // "Most recent" reuses this same activityDate fallback, restricted to
  // tickets that actually resolved a name: a ticket whose vendor_id is set
  // but whose one-night name lookup failed still counts toward the
  // distinct total, but is skipped here in favor of the next-most-recent
  // ticket that does have a name — showing no name at all would be worse
  // than skipping to one that has it.
  const vendorIds = new Set();
  let mostRecentVendorName = null;
  let mostRecentVendorDate = null;
  for (const t of tickets) {
    const cost = typeof t.cost === 'number' ? t.cost : 0;
    const activityDate = t.completed_at || t.created_at;
    if (activityDate && new Date(activityDate) >= twelveMonthsAgo) spendTrailing12 += cost;
    if (activityDate && (!lastActivity || activityDate > lastActivity)) lastActivity = activityDate;
    if (t.latchel_vendor_id) vendorIds.add(t.latchel_vendor_id);
    if (t.latchel_vendor_name && activityDate && (!mostRecentVendorDate || activityDate > mostRecentVendorDate)) {
      mostRecentVendorDate = activityDate;
      mostRecentVendorName = t.latchel_vendor_name;
    }
  }

  // AppFolio actual maintenance-category spend — Property 360 follow-up
  // fix (2026-09). The Latchel-ticket figures above (open_ticket_count,
  // spend_trailing_12mo) only ever reflect maintenance_requests rows that
  // got a real Latchel job match. AppFolio's own general ledger can carry
  // real repair/maintenance spend that never went through Latchel at all
  // (a direct AppFolio entry) — a property can show zero Latchel tickets
  // and still have real recorded repair spend, which used to render as a
  // flat "nothing to report" card. Reuses MAINT_RELATED_ACCOUNTS (defined
  // above, shared with the Budget route) and the same real-$0-vs-
  // not-tracked-yet distinction the Budget route's own
  // has_actual_spend_data already established, rather than inventing a
  // second convention.
  //
  // Scoped to the CURRENT fiscal year only, not trailing-12mo like the
  // Latchel spend figure above — actual-spend tracking (sync.js's
  // general_ledger entry) has no historical backfill, so there's no full
  // trailing-12mo window to sum even if this wanted one. fiscal_year on
  // appfolio_property_actuals is the calendar year taken from each
  // transaction's own post_date (see sync.js's general_ledger entry) —
  // AppFolio's own fiscal-year convention, the same one the Budget route
  // filters by.
  let appfolioMaintenanceSpend = null;
  let hasAppfolioActualData = null;
  if (property.appfolio_id) {
    const currentFiscalYear = new Date().getUTCFullYear();
    const { data: actualsRows, error: actualsErr } = await supabase
      .from('appfolio_property_actuals')
      .select('fiscal_year, gl_account_name, net_amount')
      .eq('appfolio_property_id', property.appfolio_id);
    if (actualsErr) return res.status(500).json({ error: actualsErr.message });
    // ANY row, any GL category, any year — "has actual-spend tracking
    // started for this property at all," not narrowed to maintenance
    // categories. A property with real actuals in other categories but
    // genuinely $0 in maintenance categories this year must still read as
    // "tracked" here, not "not tracked" — same reasoning Budget's own
    // has_actual_spend_data flag uses.
    hasAppfolioActualData = (actualsRows || []).length > 0;
    const maintSpend = (actualsRows || [])
      .filter(r => r.fiscal_year === currentFiscalYear && MAINT_RELATED_ACCOUNTS.includes(r.gl_account_name))
      .reduce((sum, r) => sum + (Number(r.net_amount) || 0), 0);
    appfolioMaintenanceSpend = Math.round(maintSpend * 100) / 100;
  }

  // "Where the money went" by repair type — Property 360 Maintenance
  // card pie chart (2026-09). Combines both real dollar sources this
  // route already has access to: maintenance_snapshot_events_decision_safe
  // (the up-to-5-year AppFolio bill-history backfill — read via the
  // decision-safe view, never the raw table, same governance discipline
  // as the /snapshot route above, so a flagged or rejected row never
  // contributes a dollar here) and this property's own `tickets` (the
  // ongoing Latchel pipeline, already fetched above). Category is
  // inferred from the VENDOR NAME ONLY via categorizeMaintenanceVendor
  // (defined near MAINT_RELATED_ACCOUNTS above) — never from any
  // free-text description — so this deliberately never touches a
  // privacy-review-gated field and needed no privacy review of its own.
  //
  // Live-verified 2026-09-03: maintenance_requests.cost is NULL on every
  // one of this database's 568 rows today — the Latchel pipeline has
  // never recorded a dollar figure for a ticket, so in practice 100% of
  // today's real category spend comes from maintenance_snapshot_events.
  // The ticket loop below still runs (costing nothing when cost is null)
  // so a real figure, once Latchel/AppFolio actually starts populating
  // one, is picked up automatically instead of silently ignored.
  const categoryTotals = {};
  const addToCategorySpend = (vendorName, amount) => {
    const amt = Number(amount) || 0;
    if (!amt) return; // skip null/0 — e.g. every current maintenance_requests.cost
    const category = categorizeMaintenanceVendor(vendorName);
    categoryTotals[category] = (categoryTotals[category] || 0) + amt;
  };
  const { data: snapshotSpendRows, error: snapshotSpendErr } = await supabase
    .from('maintenance_snapshot_events_decision_safe')
    .select('vendor_name, amount')
    .eq('property_id', property.id);
  if (snapshotSpendErr) return res.status(500).json({ error: snapshotSpendErr.message });
  for (const r of (snapshotSpendRows || [])) addToCategorySpend(r.vendor_name, r.amount);
  for (const t of tickets) addToCategorySpend(t.latchel_vendor_name, t.cost);

  // Percentages are computed from the exact (unrounded) category totals,
  // not from the rounded `amount` below — keeps the pie chart's arcs
  // mathematically exact (fractions sum to 1) even though the displayed
  // amount/percent are each rounded for display. Sorted descending by
  // dollar amount, largest slice first, matching how the vendor history
  // fact above already reads ("most recent vendor").
  const categorySpendTotal = Object.values(categoryTotals).reduce((sum, v) => sum + v, 0);
  const spendByCategory = Object.entries(categoryTotals)
    .map(([category, amount]) => ({
      category,
      amount: Math.round(amount * 100) / 100,
      percent: categorySpendTotal ? Math.round((amount / categorySpendTotal) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  // Gated flagged-review count — identical pattern to /overview's own
  // (count:'exact'+head:true, never fetching a row's content), same
  // PRIVACY_REVIEW_ROLES gate, same omit-don't-zero discipline as
  // /overview: left out of the response entirely for a role outside that
  // set, and also when the real count is 0, so there is no code path
  // where presence of the key itself doesn't already mean "a person with
  // real reviewer access should look at this." Skips the query entirely
  // on a known-empty ticket list, same convention flagged-queue's own
  // property filter already follows below.
  let flaggedReviewCount = null;
  if (PRIVACY_REVIEW_ROLES.includes(req.maintenanceHistoryRole)) {
    const ticketIds = tickets.map(t => t.id);
    let flaggedClaimsCount = 0;
    if (ticketIds.length > 0) {
      const { count: flaggedCount, error: flaggedCountErr } = await supabase
        .from('maintenance_claims')
        .select('id', { count: 'exact', head: true })
        .in('maintenance_request_id', ticketIds)
        .eq('flagged_protected_class', true)
        .eq('review_status', 'unreviewed');
      if (flaggedCountErr) return res.status(500).json({ error: flaggedCountErr.message });
      flaggedClaimsCount = flaggedCount || 0;
    }
    // Governance fix, 2026-09-03 — see countFlaggedSnapshotEvents' own
    // comment above. NOT skipped on an empty ticket list the way the
    // claims count is above: a property can have real flagged snapshot
    // events (sourced from AppFolio bills, not Latchel tickets) even with
    // zero Latchel-matched tickets.
    let flaggedSnapshotCount;
    try {
      flaggedSnapshotCount = await countFlaggedSnapshotEvents(property.id);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    flaggedReviewCount = flaggedClaimsCount + flaggedSnapshotCount;
  }

  return res.json({
    property: { id: property.id, name: property.name, address: property.address, city: property.city },
    // Real data exists if ANY source has it — a real Latchel-ticket row,
    // real AppFolio actual-spend tracking for this property (see the
    // appfolioMaintenanceSpend comment above; hasAppfolioActualData is
    // true on ANY actuals row for this property, any GL account, any
    // year — not scoped to the current fiscal year the way the dollar
    // sum above is), or real 5-year snapshot spend (spendByCategory,
    // computed above from maintenance_snapshot_events_decision_safe —
    // the same result the pie chart itself renders, not a second
    // query). This third condition is the 2026-09-04 fix: a property
    // can have real, priced AppFolio bill history going back up to 5
    // years with zero matched Latchel tickets and zero AppFolio GL
    // actuals of any kind — that property's own maintenance history was
    // real, it just wasn't reflected by either of the first two
    // conditions, so the whole card (including this same pie chart)
    // wrongly fell back to the "no data" empty state. Full live sweep,
    // 2026-09-04, calling this exact function against every one of the
    // 360 properties with real priced snapshot history: 3 were actually
    // flipped false->true by this condition (the other 357 already had
    // a real ticket or actuals row and were unaffected) — a smaller
    // count than an earlier same-day estimate of 96 of 289, most likely
    // because AppFolio actuals coverage (appfolio_property_actuals) has
    // since grown to cover 372 of 391 properties; re-run the sweep if
    // that seems off. A property with real, honest $0 AppFolio tracking
    // and zero Latchel tickets and zero snapshot spend still correctly
    // counts as "has data" — the AppFolio line on the card is what
    // makes that zero legible, instead of the card falling back to the
    // generic "nothing to report" message that started this fix.
    has_data: tickets.length > 0 || hasAppfolioActualData === true || spendByCategory.length > 0,
    open_ticket_count: openTicketCount,
    spend_trailing_12mo: Math.round(spendTrailing12 * 100) / 100,
    last_activity: lastActivity,
    // Vendor history (property-360-SPEC.md "Vendor history") — the short
    // summary-card line ("3 vendors used, most recent: [name]"). Always
    // included (0 / null when there's no vendor data yet), same as
    // open_ticket_count/spend_trailing_12mo above — this is a plain
    // aggregate fact, not a gated privacy-review flag like
    // flagged_review_count below. The full per-vendor breakdown (every
    // vendor, job count, most recent date) is explicitly a separate,
    // not-yet-built piece living on Overview's synthesis output per the
    // spec's own "glance here, full detail there" framing — not this route.
    vendor_count: vendorIds.size,
    most_recent_vendor_name: mostRecentVendorName,
    // "Where the money went" pie chart data — see the comment above this
    // route's categoryTotals block. Always an array (possibly empty when
    // this property has no priced maintenance_snapshot_events rows and no
    // priced tickets) — same "always present, empty/zero when there's
    // nothing yet" convention as vendor_count/open_ticket_count above,
    // not a gated field like flagged_review_count below.
    spend_by_category: spendByCategory,
    // AppFolio actual maintenance-category spend, current fiscal year only
    // — see the comment above this route's flaggedReviewCount block. Both
    // null/absent-in-spirit (null, not omitted — same convention
    // most_recent_vendor_name already uses for "no value") when this
    // property has no appfolio_id at all, since there's no AppFolio table
    // to look this up against.
    appfolio_maintenance_spend: appfolioMaintenanceSpend,
    has_appfolio_actual_data: hasAppfolioActualData,
    ...(flaggedReviewCount ? { flagged_review_count: flaggedReviewCount } : {}),
  });
}

router.get('/api/maintenance-history/property/:property_id/summary', requireMaintenanceHistoryAccess, getMaintenanceHistoryPropertySummary);

/**
 * GET /api/maintenance-history/property/:property_id/open-tickets
 * Property 360 Maintenance card — the actual ticket list behind
 * open_ticket_count (getMaintenanceHistoryPropertySummary above, its own
 * `openTicketCount = tickets.filter(t => !['completed', 'closed']
 * .includes(t.status)).length`). Uses that EXACT SAME open definition —
 * not /overview's richer claims-informed "resolved" logic (which reads
 * outcome-claim text to override a stale "Completed" status) — so this
 * list's length can never disagree with the count already shown on the
 * card. See getMaintenanceHistoryPropertySummary's own comment for why
 * that distinction matters.
 *
 * Reads only maintenance_requests (id, title, status, cost, completed_at,
 * created_at) plus the existing safeTicketTitle() content-safety lookup
 * below — no maintenance_claims, no maintenance_snapshot_events, no AI
 * synthesis call. That's what keeps this route cheap enough to lazy-load
 * on an expand click, unlike /overview.
 *
 * Gated by the same requireMaintenanceHistoryAccess every other read
 * route in this file uses (ANY real maintenance_history role) — the same
 * gate already protecting the count this list expands on Property 360.
 */
router.get('/api/maintenance-history/property/:property_id/open-tickets', requireMaintenanceHistoryAccess, async (req, res) => {
  const propertyId = req.params.property_id;
  if (!isValidUuid(propertyId)) {
    return res.status(400).json({ error: 'That property ID is not valid.' });
  }

  const { data: property, error: propErr } = await supabase
    .from('properties')
    .select('id')
    .eq('id', propertyId)
    .maybeSingle();
  if (propErr) return res.status(500).json({ error: propErr.message });
  if (!property) return res.status(404).json({ error: 'Property not found.' });

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
      .select('id, title, status, cost, completed_at, created_at')
      .in('unit_id', unitIds);
    if (mrErr) return res.status(500).json({ error: mrErr.message });
    tickets = mrRows || [];
  }

  // Same open definition as getMaintenanceHistoryPropertySummary's
  // openTicketCount above — deliberately the plain status check, not
  // /overview's claims-informed "resolved" logic. Must stay identical so
  // this list's length always matches the card's own open_ticket_count.
  const openTickets = tickets.filter(t => !['completed', 'closed'].includes(t.status));

  // safeTicketTitle() unmodified — same Fair Housing keyword+AI content
  // check already applied everywhere else a raw AppFolio ticket title is
  // shown (see that function's own comment above). Never skipped, never
  // reimplemented here.
  const withTitles = await Promise.all(openTickets.map(async (t) => {
    const { text, flagged } = await safeTicketTitle(t, property.id);
    return {
      id: t.id,
      title: text,
      title_redacted: flagged,
      status: t.status,
      cost: typeof t.cost === 'number' ? t.cost : null,
      last_activity: t.completed_at || t.created_at || null,
    };
  }));

  // Most-recent-activity first; tickets with no completed_at/created_at
  // at all (shouldn't happen in practice — created_at is always set on
  // ingest — but handled defensively) sort last.
  withTitles.sort((a, b) => {
    if (!a.last_activity && !b.last_activity) return 0;
    if (!a.last_activity) return 1;
    if (!b.last_activity) return -1;
    return a.last_activity < b.last_activity ? 1 : -1;
  });

  return res.json({ open_tickets: withTitles });
});

/**
 * GET /api/maintenance-history/property/:property_id/snapshot
 * Multi-year maintenance snapshot — property-360-SPEC.md "Multi-year
 * maintenance snapshot," migration 20260903000000_maintenance_snapshot_
 * events.sql, populated by maintenance-history/backfill-maintenance-
 * snapshot.js. A short, chronological, up-to-5-years-back list of
 * AppFolio bill-history facts for this property ("Kitchen faucet repair —
 * 2022-03-14, $180, ABC Plumbing") — a different, separate glance from
 * both the summary card above (open ticket count / trailing-12mo spend)
 * and the flagged Privacy Review queue below.
 *
 * Gated by the same requireMaintenanceHistoryAccess every other read
 * route in this file uses (ANY real maintenance_history role) — per the
 * migration's own "ACCESS/GATING NOTE FOR Q": this table adds no new
 * team_member_tool_roles value, and general reads of the decision-safe
 * view need no narrower gate than the rest of the Maintenance section.
 * Reads ONLY maintenance_snapshot_events_decision_safe — never the raw
 * maintenance_snapshot_events table — so a flagged or rejected row can
 * never reach this route regardless of role, same discipline the
 * migration's own view comment requires ("the Property 360 card... should
 * read ONLY the view, never this base table directly").
 */
router.get('/api/maintenance-history/property/:property_id/snapshot', requireMaintenanceHistoryAccess, async (req, res) => {
  const propertyId = req.params.property_id;
  if (!isValidUuid(propertyId)) {
    return res.status(400).json({ error: 'That property ID is not valid.' });
  }

  const { data, error } = await supabase
    .from('maintenance_snapshot_events_decision_safe')
    .select('id, event_date, summary, amount, vendor_name, source')
    .eq('property_id', propertyId)
    .order('event_date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  return res.json(data || []);
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

// ─── Shared claim/snapshot-event review executor ────────────────────────
// flagged-review-grouping-and-exclusions-SPEC.md, Asimov's Part 1 approval
// condition 4: "refactor the shared parts (validation, the acknowledgment
// check, the audit_log write) into a shared function both the single-item
// routes and the new bulk route call." Extracted from what POST
// /claims/:id/review and POST /snapshot-events/:id/review each used to do
// independently (fetch the "before" row, gate acknowledgment for a flagged
// row, validate a correction's fields, apply the update, write the Rule 1
// audit_log row) — now one implementation, called by both of those routes
// AND the new POST /flagged-queue/bulk-review route below.
//
// Both existing single-item routes were rewritten to call this with
// requireAck:true, respondOnError:true, and no auditExtra — reproducing
// their exact prior behavior (same status codes, same response shapes,
// same audit_log rows) byte-for-byte, not a new behavior. Neither route's
// own pre-checks (the snapshot-events route's explicit action/uuid checks
// before it ever calls this) were touched — this function does not
// re-decide anything either of those routes had already decided about
// itself before this refactor; it just centralizes what both bodies did
// next.
//
// itemType: 'claim' | 'snapshot_event' — the only real branch point below;
// the acknowledgment gate, the update-then-audit-log sequence, and the
// response contract are identical for both tables.
//
// fields: the request body's editable fields — only read/validated when
// action === 'correct'. { claim_text, claim_date, outcome_level,
// reviewer_notes } for a claim; { summary, event_date, reviewer_notes }
// for a snapshot event. Bulk-review (confirm/reject only, never correct)
// passes {} — no editable fields are ever read for those two actions.
//
// requireAck: true from both single-item routes (each already gated
// acknowledgment itself before this refactor). false from bulk-review,
// which gates the whole batch once, up front, instead of once per item
// (see that route's own comment for why — everything it ever touches is
// flagged content by definition, same reasoning GET /flagged-queue's own
// unconditional gate already uses).
//
// respondOnError: true from both single-item routes — on any failure this
// function writes res.status(...).json({error}) itself, exactly matching
// each route's own prior inline error handling, and the caller just
// returns. false from bulk-review, which turns a failure into one entry
// in its own per-id `failed` array instead of an HTTP response.
//
// guardUnreviewed: bulk-review only. Adds `.eq('review_status',
// 'unreviewed')` to the UPDATE itself and treats zero rows affected as a
// failure — a last-instant guard against another request reviewing the
// same item in the moment between this function's own "before" fetch and
// the UPDATE actually committing, on top of (not instead of)
// bulk-review's own fresh re-check right before calling this. Never
// applied to the single-item routes — their UPDATE is unchanged
// (`.select().single()`), so their existing behavior for an
// already-reviewed item (silently overwrite, last write wins) is
// unchanged too; this build was only asked to add race protection to the
// new bulk path, not to change how single-item review already works.
//
// auditExtra: merged into the audit_log details object. Bulk-review passes
// { bulk: true, cluster_key, batch_size } per condition 5 ("one audit_log
// row per item... marked bulk: true with the cluster key and batch
// size"); the single-item routes pass nothing, so their audit_log rows are
// unchanged from before this refactor.
async function applyReviewAction({ itemType, id, action, fields, req, res, requireAck, respondOnError, guardUnreviewed, auditExtra }) {
  function fail(status, error) {
    if (respondOnError && res) {
      res.status(status).json({ error });
      return { ok: false, responded: true };
    }
    return { ok: false, status, error };
  }

  if (!['confirm', 'correct', 'reject'].includes(action)) {
    return fail(400, 'action must be "confirm", "correct", or "reject".');
  }

  const table = itemType === 'snapshot_event' ? 'maintenance_snapshot_events' : 'maintenance_claims';
  const beforeSelect = itemType === 'snapshot_event'
    ? 'id, flagged_protected_class, property_id'
    : 'id, claim_type, flagged_protected_class, maintenance_request_id';

  const { data: before, error: beforeErr } = await supabase.from(table).select(beforeSelect).eq('id', id).maybeSingle();
  if (beforeErr) return fail(500, beforeErr.message);
  if (!before) {
    return fail(404, itemType === 'snapshot_event' ? 'Maintenance snapshot event not found.' : 'Claim not found.');
  }

  if (requireAck && before.flagged_protected_class) {
    const acknowledged = await requireAcknowledgment(req, res);
    if (!acknowledged) return { ok: false, responded: true };
  }

  const reviewerName = req.maintenanceHistoryMemberName || req.user.email;
  const review_status = action === 'confirm' ? 'confirmed' : action === 'correct' ? 'corrected' : 'rejected';
  const reviewer_notes = fields.reviewer_notes || null;

  const updates = {
    review_status,
    reviewed_by: reviewerName,
    reviewed_at: new Date().toISOString(),
    reviewer_notes,
  };

  if (action === 'correct') {
    if (itemType === 'snapshot_event') {
      const { summary, event_date } = fields;
      if (summary !== undefined && (typeof summary !== 'string' || !summary.trim())) {
        return fail(400, 'summary cannot be empty.');
      }
      if (summary !== undefined && summary.length > 300) {
        return fail(400, 'summary must be 300 characters or fewer.');
      }
      if (event_date !== undefined && event_date !== null && event_date !== '') {
        if (!isValidCalendarDate(event_date)) {
          return fail(400, 'event_date must be a valid date in YYYY-MM-DD format.');
        }
      }
      if (summary !== undefined) updates.summary = summary;
      // event_date is NOT NULL on this table — an explicit null/empty
      // string is left alone (no change) rather than sent to the
      // database, where it would fail the NOT NULL constraint.
      if (event_date) updates.event_date = event_date;
    } else {
      const { claim_text, claim_date, outcome_level } = fields;
      if (claim_text !== undefined && (typeof claim_text !== 'string' || !claim_text.trim())) {
        return fail(400, 'claim_text cannot be empty.');
      }
      if (claim_date !== undefined && claim_date !== null && claim_date !== '') {
        if (!isValidCalendarDate(claim_date)) {
          return fail(400, 'claim_date must be a valid date in YYYY-MM-DD format.');
        }
      }
      if (before.claim_type === 'outcome' && outcome_level !== undefined && outcome_level !== null && outcome_level !== '') {
        const lvl = Number(outcome_level);
        if (!Number.isInteger(lvl) || lvl < 1 || lvl > 5) {
          return fail(400, 'outcome_level must be a whole number from 1 to 5.');
        }
      }
      if (claim_text !== undefined) updates.claim_text = claim_text;
      if (claim_date !== undefined) updates.claim_date = claim_date || null;
      if (before.claim_type === 'outcome' && outcome_level !== undefined) {
        updates.outcome_level = outcome_level === null ? null : Number(outcome_level);
      }
    }
  }

  let updated, updateErr;
  if (guardUnreviewed) {
    ({ data: updated, error: updateErr } = await supabase
      .from(table).update(updates).eq('id', id).eq('review_status', 'unreviewed').select().maybeSingle());
  } else {
    ({ data: updated, error: updateErr } = await supabase.from(table).update(updates).eq('id', id).select().single());
  }
  if (updateErr) return fail(500, updateErr.message);
  if (guardUnreviewed && !updated) {
    // Someone else reviewed this exact item in the moment between this
    // function's own "before" fetch above and this UPDATE committing —
    // bulk-review's own fresh re-check right before calling this already
    // catches the common case; this is the last-instant guard for the
    // genuine race, treated the same way as any other per-id bulk
    // failure, not a 500.
    return fail(409, 'Already reviewed by someone else since this list was loaded.');
  }

  const riskLevel = (before.flagged_protected_class && (action === 'correct' || action === 'reject')) ? 'medium' : 'low';
  await writeAuditLog({
    action: itemType === 'snapshot_event' ? 'maintenance_snapshot_events.reviewed' : 'maintenance_claims.reviewed',
    entity_type: itemType === 'snapshot_event' ? 'maintenance_snapshot_event' : 'maintenance_claim',
    entity_id: id,
    actor_email: req.user.email,
    risk_level: riskLevel,
    details: { review_status, reviewer_notes, actor_role: req.maintenanceHistoryRole, ...(auditExtra || {}) },
  });

  return { ok: true, row: updated };
}

// ─── POST /api/maintenance-history/claims/:id/review ───────────────────
// Confirm / correct / reject one claim. Works the same for a flagged claim
// as an unflagged one — a reviewer/admin can (and must) be able to read a
// flagged claim's real text to judge it; that's what human review means
// here. Only the audit_log entry below is barred from carrying the text.
router.post('/api/maintenance-history/claims/:id/review', requireMaintenanceHistoryRole('admin', 'reviewer', 'director_of_operations'), async (req, res) => {
  const { action, claim_text, claim_date, outcome_level, reviewer_notes } = req.body;
  // Everything below this line — the "before" fetch, the acknowledgment
  // gate (Mason's condition 1: director_of_operations only, and only for a
  // flagged claim), correct-field validation, the update, and the Rule 1
  // audit_log write — now lives in applyReviewAction (grouped-review-
  // SPEC.md's Part 1 condition 4), shared with POST /snapshot-events/:id/
  // review and the new bulk-review route below. requireAck:true and
  // respondOnError:true reproduce this route's own prior behavior exactly
  // (same status codes, same response shape) — nothing about what
  // admin/reviewer/director_of_operations can do here changes.
  const result = await applyReviewAction({
    itemType: 'claim',
    id: req.params.id,
    action,
    fields: { claim_text, claim_date, outcome_level, reviewer_notes },
    req, res,
    requireAck: true,
    respondOnError: true,
  });
  if (!result.ok) return; // applyReviewAction already wrote the error response
  return res.json({ success: true, claim: result.row });
});

// ─── POST /api/maintenance-history/snapshot-events/:id/review ──────────
// Confirm / correct / reject one maintenance_snapshot_events row —
// governance fix, 2026-09-03 (see GET /flagged-queue's own top comment
// for the gap this closes: flagged snapshot-event rows had no path to a
// human reviewer at all before this build). A parallel route, not an
// extension of POST /claims/:id/review above: the two tables don't share
// a row shape (summary/event_date/amount/vendor_name here vs.
// claim_type/claim_text/claim_date/outcome_level there — outcome_level's
// own claim_type-conditional validation alone would make one shared
// route's body-validation branch on id type, not action, which is worse
// than two small routes). What IS shared, via the helpers above, is
// everything id-type-independent — the acknowledgment gate
// (requireAcknowledgment) and the audit-log write (writeAuditLog) — the
// two pieces this build was explicitly told not to duplicate.
//
// Same "works the same for a flagged row as an unflagged one" principle
// as claims review above — a reviewer/admin can (and must) be able to
// read a flagged row's real summary to judge it; only the audit_log entry
// is barred from carrying it.
router.post('/api/maintenance-history/snapshot-events/:id/review', requireMaintenanceHistoryRole('admin', 'reviewer', 'director_of_operations'), async (req, res) => {
  const { action, summary, event_date, reviewer_notes } = req.body;
  // Both pre-checks kept here, unchanged, exactly as before this route was
  // refactored to call the shared applyReviewAction (grouped-review-
  // SPEC.md's Part 1 condition 4) — this route validated action AND
  // req.params.id itself before this refactor (unlike claims review, which
  // never validated the id shape); that asymmetry is a pre-existing fact
  // about these two routes, not something this build was asked to change,
  // so it's preserved rather than folded into the now-shared function.
  if (!['confirm', 'correct', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'action must be "confirm", "correct", or "reject".' });
  }
  if (!isValidUuid(req.params.id)) {
    return res.status(400).json({ error: 'That id is not valid.' });
  }

  const result = await applyReviewAction({
    itemType: 'snapshot_event',
    id: req.params.id,
    action,
    fields: { summary, event_date, reviewer_notes },
    req, res,
    requireAck: true,
    respondOnError: true,
  });
  if (!result.ok) return; // applyReviewAction already wrote the error response
  return res.json({ success: true, snapshot_event: result.row });
});

// ─── POST /api/maintenance-history/privacy-queue/acknowledge ────────────
// Mason's condition 1 (PRIVACY_REVIEW_ROLES comment above). Role-gated to
// PRIVACY_QUEUE_ACK_ROLE specifically, not the whole PRIVACY_REVIEW_ROLES
// set — admin/reviewer never need to call this, and there's no reason to
// let them. Idempotent: a second acknowledgment from someone who already
// has one on record is a silent no-op, not a duplicate row — same
// check-then-insert shape as safeTicketTitle's audit_log dedup above.
router.post('/api/maintenance-history/privacy-queue/acknowledge', requireMaintenanceHistoryRole(PRIVACY_QUEUE_ACK_ROLE), async (req, res) => {
  try {
    const already = await hasAcknowledgedPrivacyQueue(req.user.email);
    if (!already) {
      const ok = await writeAuditLog({
        action: PRIVACY_QUEUE_ACK_ACTION,
        entity_type: 'team_member',
        entity_id: req.teamMemberId,
        actor_email: req.user.email,
        details: { role: req.maintenanceHistoryRole },
      });
      // Unlike writeAuditLog's other call sites, a failed write here must
      // fail the request — this IS the acknowledgment record itself, not a
      // log describing some other action that already succeeded. A
      // swallowed failure would silently grant access without ever
      // actually recording that Mason's condition 1 was met.
      if (!ok) return res.status(500).json({ error: 'Could not save acknowledgment.' });
    }
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Grouped review view — Part 1 of flagged-review-grouping-and-
// exclusions-SPEC.md, built per that spec's own "Asimov's Review" section
// (2026-09-03), which is the actually-binding version of Part 1's
// conditions. Two pieces: clusterFlaggedRows() below (used by
// ?grouped=true on GET /flagged-queue) and POST /flagged-queue/bulk-review
// further down.
//
// TERM_TO_CATEGORY — built once at module load from protected-class-
// terms.js's already-exported CATEGORIES object. Not a change to that
// file (or to scanText()/content-check.js — this build was told explicitly
// not to touch any of those three): CATEGORIES was already exported;
// this just consumes it the same way scanText() itself already is
// consumed elsewhere in this file.
const TERM_TO_CATEGORY = {};
for (const [category, terms] of Object.entries(CATEGORIES)) {
  for (const term of terms) {
    if (!(term in TERM_TO_CATEGORY)) TERM_TO_CATEGORY[term] = category;
  }
}

function firstCategory(flaggedCategory) {
  const first = (flaggedCategory || '').split(',')[0].trim();
  return first || 'unspecified';
}

// clusterFlaggedRows — the ONLY thing this function does is label/group
// rows the caller has already determined belong in the queue (via the
// persisted flagged_protected_class filter GET /flagged-queue's own query
// already applies, above). It never decides membership — Asimov's hard
// requirement: "the live re-scan may only ever compute a display/cluster
// label for an item already known to belong there — never decide
// inclusion." rows passed in here are exactly the same rows the flat
// (non-grouped) response would have returned; clustering can only ever
// re-bucket that fixed set, never add to or drop from it — see this
// build's own verification note (total_items below, checked against the
// flat query's own row count) for how that invariant was actually tested.
//
// WHY THIS DOESN'T READ A `matched_layer` COLUMN, THE WAY THE APPROVED
// SPEC ASSUMED: checked both tables' migrations and the ingest code that
// computes matched_layer (lib/content-check.js's checkClaim(), and
// router.js's own ingest route further down this file) — matched_layer is
// written only into audit_log.details at ingest time for
// maintenance_claims (action: 'maintenance_claims.protected_class_
// excluded'), and for maintenance_snapshot_events it is not persisted
// ANYWHERE — backfill-maintenance-snapshot.js never writes an audit_log
// row at all. Neither table has a matched_layer column, and there is no
// single join that would cover both item types.
//
// Fix used instead: condition 3's own actual test is "no shared matched
// term," which is exactly what a live rescan's matchedTerms answers,
// computed straight off each row's CURRENT text — same live scanText()
// call this function already has to make to derive matched_term/category
// for the cluster label. If the rescan finds a term, this is a real,
// currently-visible, shared word/phrase — bulk_eligible = true, same bar
// clustering-by-matched-term already implies. If it finds none, this
// behaves exactly like a genuine Layer-2-only item — grouped for
// browsing, bulk_eligible = false. This can only ever be MORE
// conservative than the originally-specified column, never less: a
// Layer-1 term present at ingest but since edited out of the text via a
// "correct" action now correctly reads as "no shared term" instead of
// staying falsely bulk-eligible off a stale ingest-time fact. Re-enforced
// server-side in POST /flagged-queue/bulk-review below (not just hidden
// in the dashboard) with this exact same live-rescan test, so a client
// can't bypass condition 3 by calling the bulk route directly.
function clusterFlaggedRows(rows) {
  const clusters = new Map();
  for (const row of rows) {
    const text = row.item_type === 'snapshot_event' ? (row.summary || '') : (row.claim_text || '');
    const scan = scanText(text);
    const term = scan.matchedTerms.length ? scan.matchedTerms[0] : null;
    const category = term
      ? (TERM_TO_CATEGORY[term] || scan.categories[0] || firstCategory(row.flagged_category))
      : firstCategory(row.flagged_category);
    const clusterKey = term ? `term:${category}:${term}` : `category:${category}`;

    let cluster = clusters.get(clusterKey);
    if (!cluster) {
      cluster = {
        cluster_key: clusterKey,
        category,
        matched_term: term, // null for a Layer-2-only-style cluster
        // 'keyword' when a live rescan of current text finds the shared
        // term this cluster is named for; 'model' otherwise (no
        // persisted column backs this — see the function comment above
        // for why a live rescan is the correct, safe substitute here).
        matched_layer: term ? 'keyword' : 'model',
        bulk_eligible: !!term,
        count: 0,
        sample_text: text,
        // Full row objects (same shape the flat, non-grouped response
        // already returns per item — claim_text/summary and all),  not
        // bare {id, item_type} pairs: this lets the dashboard's expand-to-
        // individual-items view reuse the EXISTING renderClaim/
        // renderSnapshotEvent (renderPrivacyClaim/renderPrivacySnapshotEvent
        // on Property 360) functions directly, per condition 7, with no
        // second fetch. Nothing new is exposed by this — a reviewer
        // already receives every one of these same fields in the flat
        // response today. POST /flagged-queue/bulk-review's own request
        // body only needs { id, item_type } — the dashboard extracts just
        // those two fields per item when it builds that call.
        items: [],
      };
      clusters.set(clusterKey, cluster);
    }
    cluster.count++;
    cluster.items.push(row);
  }
  // Largest cluster first — most useful for triage (a repeat false
  // positive like a brand name is exactly what this view exists to let a
  // reviewer clear in one action).
  return Array.from(clusters.values()).sort((a, b) => b.count - a.count);
}

// Bulk-review is a real-time, human-initiated action against a real
// portfolio flag rate the spec's own header measured at ~250-300 items
// total — not a bulk-import job. A cap here is a sanity/abuse guard, not
// a number anyone should ever need to raise to get real work done.
const BULK_REVIEW_MAX_ITEMS = 500;

// ─── GET /api/maintenance-history/flagged-queue ─────────────────────────
// "Needs privacy review" — gated to PRIVACY_REVIEW_ROLES (admin, reviewer,
// director_of_operations — see that constant's own comment for the full
// history of why director_of_operations was out, then back in with
// conditions). Shows the real claim text (a reviewer has to be able to
// read it to judge it) — never logged itself, only the fact that the queue
// was opened (see the view-logging block below, added by this build for
// the first time).
//
// Governance fix, 2026-09-03: this route now ALSO returns flagged
// maintenance_snapshot_events rows, merged into the exact same list as
// flagged maintenance_claims rows — one queue, not two parallel screens
// (see the migration and backfill script for how those rows get flagged
// in the first place; before this fix, a flagged snapshot-event row was
// correctly hidden from maintenance_snapshot_events_decision_safe but had
// no path to ever reach a human reviewer at all). Each row in the
// response carries `item_type` ('claim' or 'snapshot_event') so the front
// end can render each correctly without confusing them — the two tables
// don't share a field shape (claim_text/claim_date/outcome_level vs.
// summary/event_date/amount/vendor_name). Reviewing a snapshot-event row
// goes through the separate POST /snapshot-events/:id/review route below
// (not this route's own POST /claims/:id/review) for the same reason.
//
// Optional ?property_id= — shared-property-context-SPEC.md Part 2,
// "caught on review": additive only. With no filter this is the same
// portfolio-wide query as before, unchanged, and stays the default when
// this route is reached normally (not via the Property Overview badge) —
// that comprehensive-sweep behavior is the whole point of this queue.
// Applies to snapshot-event rows too, straight against their own real
// property_id column (no unit/ticket hop needed — see
// countFlaggedSnapshotEvents' own comment above).
//
// Optional ?include_reviewed=true — property-360-SPEC.md's Privacy Review
// section, resolved 2026-09-02, approved by Mason with conditions. Same
// additive pattern as ?property_id= above: omitted or any value other
// than the literal string 'true' keeps today's queue a real, shrinking
// to-do list (adds .eq('review_status', 'unreviewed') below); 'true'
// removes that filter and reveals the exact same full history this route
// has always returned, unchanged. Mason's condition 2: this toggle is
// available to all three PRIVACY_REVIEW_ROLES equally — this route's own
// role gate below already grants all three the same access, and this
// param adds no further role distinction on top of it. Mason's condition
// 3: this is a display filter only, applied to the SELECT below — the
// view-logging audit_log write further down is untouched by this change,
// on purpose. Applies identically to snapshot-event rows, same param.
router.get('/api/maintenance-history/flagged-queue', requireMaintenanceHistoryRole(...PRIVACY_REVIEW_ROLES), async (req, res) => {
  // Acknowledgment gate, Mason's condition 1 — director_of_operations only
  // (see PRIVACY_REVIEW_ROLES comment above and requireAcknowledgment's own
  // comment). This route returns real claim_text/summary in its response
  // body, so the gate has to sit at the API level, not just hide a button
  // in the front-end — hiding the button still lets the browser receive
  // the text. admin/reviewer never hit this branch, so nothing changes for
  // them. Applied unconditionally here (not guarded by a flagged check the
  // way claims/snapshot-event review are) because everything this route
  // returns is flagged by definition.
  if (!(await requireAcknowledgment(req, res))) return;

  const propertyIdFilter = req.query.property_id;
  if (propertyIdFilter !== undefined && !isValidUuid(propertyIdFilter)) {
    return res.status(400).json({ error: 'That property ID is not valid.' });
  }

  // Resolved 2026-09-02 — reviewed items drop out of the default view.
  // Anything other than the literal string 'true' keeps today's behavior
  // (filtered to unreviewed). See this route's own top comment for
  // Mason's conditions.
  const includeReviewed = req.query.include_reviewed === 'true';

  // maintenance_claims has no property_id of its own — it only reaches a
  // property through maintenance_request_id -> units -> properties, same
  // path the Property Overview route above already walks. Resolve that
  // property's ticket ids first, then narrow the claims query to them.
  // ticketIds stays null (no filter applied below) when no property_id
  // was given; it can also resolve to a real, correctly-empty array — a
  // property with zero tickets has zero flagged claims, a genuine
  // "nothing flagged here" case, not an error.
  let ticketIds = null;
  if (propertyIdFilter) {
    const { data: units, error: unitsErr } = await supabase
      .from('units').select('id').eq('property_id', propertyIdFilter);
    if (unitsErr) return res.status(500).json({ error: unitsErr.message });
    const unitIds = (units || []).map(u => u.id);
    ticketIds = [];
    if (unitIds.length) {
      const { data: mrRows, error: mrErr } = await supabase
        .from('maintenance_requests').select('id').in('unit_id', unitIds);
      if (mrErr) return res.status(500).json({ error: mrErr.message });
      ticketIds = (mrRows || []).map(r => r.id);
    }
  }

  // No time bound and no review_status filter — every claim ever flagged
  // as touching a protected class stays visible here forever (by design:
  // this is the Fair Housing / privacy review queue). A silent 1,000-row
  // cutoff wouldn't just lose data, it would hide real flagged content
  // from the humans who are supposed to review it — worth fixing
  // regardless of exactly how fast this table grows. Paged by `id`; the
  // real sort (created_at desc) is applied in JS.
  //
  // Skip the query entirely (rather than calling .in() with an empty
  // array) when a property filter resolved to zero tickets — same
  // "don't query on a known-empty id list" convention the ingest route
  // above already follows for unitIds/tickets.
  let claimsData;
  if (ticketIds !== null && ticketIds.length === 0) {
    claimsData = [];
  } else {
    try {
      claimsData = await fetchAllRows((from, to) => {
        let query = supabase
          .from('maintenance_claims')
          .select(`
            id, claim_type, claim_text, claim_date, outcome_level, source_type, source_reference,
            confidence, extracted_by, flagged_category, review_status, reviewed_by, reviewed_at, created_at,
            maintenance_request_id,
            maintenance_requests!maintenance_claims_maintenance_request_id_fkey ( title, appfolio_id, units ( unit_number, properties ( name, address ) ) )
          `)
          .eq('flagged_protected_class', true);
        if (ticketIds !== null) query = query.in('maintenance_request_id', ticketIds);
        if (!includeReviewed) query = query.eq('review_status', 'unreviewed');
        return query.order('id', { ascending: true }).range(from, to);
      });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  // Flagged maintenance_snapshot_events rows — governance fix, 2026-09-03
  // (see this route's own top comment). No time bound and no separate
  // "skip on empty id list" step: property_id is a direct column here, so
  // the property filter (when given) applies straight to the query below,
  // no ticketIds-style resolution needed first.
  let snapshotData;
  try {
    snapshotData = await fetchAllRows((from, to) => {
      let query = supabase
        .from('maintenance_snapshot_events')
        .select(`
          id, event_date, summary, amount, vendor_name, source, source_reference, extracted_by,
          flagged_category, review_status, reviewed_by, reviewed_at, created_at, property_id,
          properties ( name, address )
        `)
        .eq('flagged_protected_class', true);
      if (propertyIdFilter) query = query.eq('property_id', propertyIdFilter);
      if (!includeReviewed) query = query.eq('review_status', 'unreviewed');
      return query.order('id', { ascending: true }).range(from, to);
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  // One merged, sorted queue — item_type ('claim' / 'snapshot_event')
  // distinguishes a claim row from a snapshot-event row so the front end
  // can render (and act on) each correctly without confusing them, per
  // this build's own instruction: one queue, not two parallel screens.
  const claimRows = claimsData.map(c => ({
    item_type: 'claim',
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

  const snapshotRows = snapshotData.map(s => ({
    item_type: 'snapshot_event',
    id: s.id,
    summary: s.summary,
    event_date: s.event_date,
    amount: s.amount,
    vendor_name: s.vendor_name,
    source: s.source,
    source_reference: s.source_reference,
    extracted_by: s.extracted_by,
    flagged_category: s.flagged_category,
    review_status: s.review_status,
    reviewed_by: s.reviewed_by,
    reviewed_at: s.reviewed_at,
    created_at: s.created_at,
    property_id: s.property_id,
    property_name: s.properties ? s.properties.name : null,
  }));

  const rows = claimRows.concat(snapshotRows);
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

  // View-logging — Asimov's condition on this build: before now, nothing
  // logged the act of *viewing* the flagged queue at all (only ingest-time
  // flagging and review-time decisions were audited). Same performed_by/
  // actor_type/actor_id lookup as POST /claims/:id/review above, now via
  // the shared writeAuditLog helper. Never the claim text, snapshot-event
  // summary, ids, or any tenant-identifying field — only the
  // property/filter/result-count shape below. Action name kept as-is
  // (maintenance_claims.flagged_queue_viewed, unchanged from before this
  // build) rather than renamed for the merged queue — SPEC.md and
  // compliance/director-of-operations-privacy-review-access.md both
  // reference this exact string; claim_count/snapshot_event_count are
  // added to `details` instead, so any existing report filtering on this
  // action keeps working, and the breakdown is still fully recoverable.
  //
  // audit_log.entity_id is UUID NOT NULL (20260720000003_foundation.sql),
  // so a literal null isn't possible for the unfiltered (portfolio-wide)
  // case even though there's no single real entity this open is "about."
  // Same fix insurance/router.js's batch-import summary task already uses
  // for that exact situation: a synthetic crypto.randomUUID() placeholder,
  // never reused or looked up anywhere — the real fact of whether this was
  // filtered, and to what property, lives in `details` below, which does
  // allow null.
  await writeAuditLog({
    action: 'maintenance_claims.flagged_queue_viewed',
    entity_type: 'flagged_queue',
    entity_id: propertyIdFilter || crypto.randomUUID(),
    actor_email: req.user.email,
    details: {
      property_id: propertyIdFilter || null,
      filtered: !!propertyIdFilter,
      result_count: rows.length,
      claim_count: claimRows.length,
      snapshot_event_count: snapshotRows.length,
      grouped: req.query.grouped === 'true',
    },
  });

  // ?grouped=true — grouped-review-SPEC.md Part 1. Clusters the exact same
  // `rows` this route would otherwise return flat (built above from the
  // persisted flagged_protected_class filter, untouched by grouping) —
  // see clusterFlaggedRows' own comment for why membership can never
  // change here, only labeling. total_items is `rows.length`, the same
  // number the flat (non-grouped) call against this same query would
  // return — the sum of every cluster's own count always equals it,
  // because clusterFlaggedRows only re-buckets rows, never drops or adds
  // one.
  if (req.query.grouped === 'true') {
    return res.json({ grouped: true, total_items: rows.length, clusters: clusterFlaggedRows(rows) });
  }

  return res.json(rows);
});

// ─── POST /api/maintenance-history/flagged-queue/bulk-review ───────────
// Grouped-review-SPEC.md Part 1 — one-click Confirm-all/Reject-all for a
// cluster from the grouped view above. Same role gate as the queue itself
// (PRIVACY_REVIEW_ROLES), one acknowledgment check for the whole batch —
// not per item — because everything this route ever touches is, by
// definition, still-flagged content, the same reasoning GET
// /flagged-queue's own unconditional gate above already uses. Confirm/
// reject only, never correct — a bulk correction would mean applying one
// edited text to many different underlying claims/summaries at once,
// which doesn't mean anything; a real correction needs per-item text
// editing, unchanged, through the individual routes above.
//
// Every id is re-verified fresh against the database, immediately before
// acting on it — never trusts the client's cluster snapshot (Asimov's
// second, more serious finding on this build: a client-held list can be
// stale by the time this request arrives — another reviewer already
// acted on one of these items, or the underlying text was corrected out
// from under a keyword match). An id that's no longer flagged, already
// reviewed, or no longer has a shared matched term by the time this runs
// is skipped and reported as a per-id failure, never silently applied or
// silently dropped. applyReviewAction's own guardUnreviewed option closes
// the remaining, genuinely-concurrent race (two bulk actions landing on
// the same item in the same instant) on top of this pre-check.
//
// Layer-2-only items never get a bulk button in either dashboard (per
// condition 3), but this route enforces that server-side too, with the
// same live-rescan test clusterFlaggedRows uses — a client can't bypass
// the UI restriction by calling this route directly with a hand-built id
// list.
//
// Rule 1: applyReviewAction's own writeAuditLog call runs once per item
// (never once for the whole batch), each with details.bulk=true, this
// batch's cluster key, and its total size — condition 5.
//
// cluster_key IS NOT taken from the request body, and is NEVER the literal
// matched term/phrase — CATEGORY ONLY. Caught by this build's own
// end-to-end verification: condition 5's literal text asks for "the
// batch's cluster key (matched term + category...)" written into
// audit_log, but protected-class-terms.js's own header is explicit and
// pre-existing: "callers MUST NOT write matchedTerms or the source text
// into audit_log." Writing the actual matched word (e.g. "wheelchair")
// into an audit_log row — even alongside a category — would violate that
// already-established rule, which this build was separately told not to
// weaken. Category alone (e.g. "disability_health") is the same thing
// already written into audit_log everywhere else in this file (the
// ingest-time flagged_category writes, safeTicketTitle's own write) — a
// real, useful, already-accepted-as-safe trace of what a bulk action was
// about, without ever logging the term itself. Computed fresh, per item,
// from that item's own live rescan below — not trusted from the client.
router.post('/api/maintenance-history/flagged-queue/bulk-review', requireMaintenanceHistoryRole(...PRIVACY_REVIEW_ROLES), async (req, res) => {
  if (!(await requireAcknowledgment(req, res))) return;

  const { items, action } = req.body;
  if (!['confirm', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'action must be "confirm" or "reject" for a bulk action — bulk-correct is not supported (edit items individually).' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array of { id, item_type }.' });
  }
  if (items.length > BULK_REVIEW_MAX_ITEMS) {
    return res.status(400).json({ error: `A single bulk action is limited to ${BULK_REVIEW_MAX_ITEMS} items.` });
  }

  const succeeded = [];
  const failed = [];
  const batchSize = items.length;

  for (const raw of items) {
    const id = raw && raw.id;
    const itemType = raw && raw.item_type;
    if (!isValidUuid(id) || !['claim', 'snapshot_event'].includes(itemType)) {
      failed.push({ id: id || null, reason: 'Malformed item — each must have a valid id and item_type ("claim" or "snapshot_event").' });
      continue;
    }

    // Fresh re-check, right before acting — never the client's list.
    const table = itemType === 'snapshot_event' ? 'maintenance_snapshot_events' : 'maintenance_claims';
    const textColumn = itemType === 'snapshot_event' ? 'summary' : 'claim_text';
    const { data: current, error: currentErr } = await supabase
      .from(table)
      .select(`id, flagged_protected_class, flagged_category, review_status, ${textColumn}`)
      .eq('id', id)
      .maybeSingle();
    if (currentErr) { failed.push({ id, reason: currentErr.message }); continue; }
    if (!current) { failed.push({ id, reason: 'Item no longer exists.' }); continue; }
    if (!current.flagged_protected_class) {
      failed.push({ id, reason: 'No longer flagged — it may have been corrected since this list was loaded.' });
      continue;
    }
    if (current.review_status !== 'unreviewed') {
      failed.push({ id, reason: 'Already reviewed — someone else may have acted on this item since this list was loaded.' });
      continue;
    }
    // Condition 3, enforced server-side (not just a hidden button) — same
    // live-rescan test clusterFlaggedRows uses above. term (not just
    // whether one exists) is kept here only long enough to derive a
    // CATEGORY for the audit_log write below — the term itself is never
    // put in auditExtra (see this route's own top comment).
    const scan = scanText(current[textColumn] || '');
    const term = scan.matchedTerms.length ? scan.matchedTerms[0] : null;
    if (!term) {
      failed.push({ id, reason: 'This item has no shared matched keyword — Layer-2-only items must be reviewed individually, not in bulk.' });
      continue;
    }
    const category = TERM_TO_CATEGORY[term] || scan.categories[0] || firstCategory(current.flagged_category);

    const result = await applyReviewAction({
      itemType, id, action, fields: {},
      req, res,
      requireAck: false, // gated once for the whole batch, above
      respondOnError: false, // a failure here becomes a `failed` entry, not an HTTP response
      guardUnreviewed: true, // last-instant race guard — see this route's own comment
      auditExtra: { bulk: true, cluster_key: category, batch_size: batchSize },
    });
    if (result.ok) succeeded.push(id);
    else failed.push({ id, reason: result.error || 'Could not save review.' });
  }

  return res.json({ succeeded, failed });
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
// MAINT_RELATED_ACCOUNTS is now defined once, up near the Property 360
// summary route above (it's shared with getMaintenanceHistoryPropertySummary's
// appfolio_maintenance_spend field as of the Property 360 Maintenance-card
// follow-up fix — same constant, not a second copy that could drift).
//
// SUBTOTAL_ACCOUNTS confirmed live against this account's real chart of
// accounts while building sync.js's annual_budget_forecast entry — the
// report includes two synthetic subtotal rows ("Total Forecast Income"/
// "Total Forecast Expense") that are sums of the other rows, not real
// spending categories — mixing them into a per-category list would
// double-count. They're split out here instead.
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

// ─── In-process overlap guard for the ingest route below ───────────────
// The cron trigger for POST .../internal/ingest is moving from nightly to
// every 15 minutes (Scotty, separately, after this ships). Measured live
// against production: a typical run with nothing new takes ~9s, but a run
// with real new tickets to process can take ~3.5min — comfortably under 15
// minutes normally, but with no guard, a slow run (a busy day, or Latchel
// responding slowly) could still overlap the next cron trigger and run two
// syncs at once. Confirmed live: the Hub runs as a single pm2 process
// (fork mode, 1 instance), so a plain module-level flag is sufficient —
// no database-backed or cross-process lock is needed here. Set true right
// before the real work starts and always cleared in a `finally` (see the
// route below) so a run that throws partway through can never leave this
// stuck on — a permanently stuck lock would be worse than the overlap
// problem this exists to prevent.
let maintenanceHistoryIngestRunning = false;

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

  // Skip immediately if a previous run is still going — see
  // maintenanceHistoryIngestRunning's own comment above for why this is a
  // safe, sufficient guard for this route. 409 (Conflict), and a
  // skipped:true body, so this is unambiguous in the cron log/response —
  // never confusable with a normal completed run (which always returns
  // the summary object below, with no `skipped` key at all).
  if (maintenanceHistoryIngestRunning) {
    console.log(`[${ts}] maintenance-history ingest: SKIPPED — a previous run is still in progress.`);
    return res.status(409).json({
      skipped: true,
      reason: 'already_running',
      message: 'A maintenance-history ingest run was already in progress; this run was skipped rather than starting a second concurrent sync.',
    });
  }

  maintenanceHistoryIngestRunning = true;
  try {
    return await runMaintenanceHistoryIngest(req, res, ts);
  } finally {
    // Always runs — normal return, an early `return res.status(...)` from
    // inside runMaintenanceHistoryIngest (the 502 Latchel-fetch failure
    // and the 500 mrRows-fetch failure below both return from there, not
    // from here), or an uncaught throw. Nothing in this route can leave
    // the lock stuck on.
    maintenanceHistoryIngestRunning = false;
  }
});

async function runMaintenanceHistoryIngest(req, res, ts) {
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

      // Vendor capture — property-360-SPEC.md "Vendor history." Every real
      // Latchel Job carries a vendor_id (getJob() already returns it, no
      // extra API call needed for this part); the real name comes from
      // getVendor(vendorId), called here at nightly ingest time only —
      // deliberately never looked up live on page load (spec: "name
      // resolved and stored at nightly ingest, never fetched live"). Same
      // per-row isolation as the AI extraction call below: a failed vendor
      // lookup is logged and this ticket keeps processing — it does not
      // abort ingest for this job or any other.
      const vendorId = job.vendor_id != null ? String(job.vendor_id) : null;
      let vendorName = null;
      if (vendorId) {
        try {
          const vendor = await latchel.getVendor(vendorId);
          vendorName = vendor && vendor.name ? vendor.name : null;
        } catch (vendorErr) {
          console.error(`[${ts}] ingest: vendor lookup failed, job ${jobId}, vendor ${vendorId}:`, vendorErr.message);
          summary.errors.push({ job_id: jobId, stage: 'vendor_lookup', error: vendorErr.message });
        }
      }

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
      // Vendor columns — only included when this run actually resolved a
      // fresh value, same "omit rather than send null over an existing
      // good value" discipline as this migration's own comment describes
      // (contrasted with vendor_name, which sync.js's upsert always
      // includes even as null and so silently clobbers). vendorId is set
      // whenever this job carries one; vendorName only when this run's
      // getVendor() call actually succeeded above.
      if (vendorId) mrUpdates.latchel_vendor_id = vendorId;
      if (vendorName) mrUpdates.latchel_vendor_name = vendorName;
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
}

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

// attachMaintenanceHistoryRole / requireMaintenanceHistoryAccess /
// requireMaintenanceHistoryRole exported for the first time here —
// property-360-SPEC.md's Access Control section: composing this tool's
// already-gated summary onto Property 360 reuses these exact, unmodified
// functions in-process, the same way opening this tool's own dashboard
// would gate a viewer, rather than reimplementing the check a second
// time. Nothing about the functions' own logic changes by exporting them.
module.exports = {
  router,
  internalRouter,
  attachMaintenanceHistoryRole,
  requireMaintenanceHistoryAccess,
  requireMaintenanceHistoryRole,
  getMaintenanceHistoryPropertySummary,
};
