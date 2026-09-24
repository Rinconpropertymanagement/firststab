/**
 * audits/router.js
 * Audits & Admin Tools — a new shell page meant to grow into wherever
 * Rincon's internal oversight/admin tooling lives, starting with one real
 * section: who's viewing which property on Property 360, and when.
 *
 * ============================================================
 * COMPOSITIONAL PATTERN — same philosophy as property-360/router.js, one
 * level simpler
 * ============================================================
 * property-360/router.js's own file header explains its pattern: a shell
 * page that composes several independently-gated TOOLS' own data onto one
 * page, each card fetched in parallel, each wrapped in its own try/catch so
 * one failing source never takes the rest of the page down with it (see
 * that file's "Per-card fetch wrappers" comment). This file borrows that
 * same shape — self-contained sections, each with its own fetch function,
 * its own route, its own render block, added independently — but doesn't
 * need property-360's in-process callHandler()/runGate() machinery, because
 * this page isn't aggregating OTHER tools' already-built, already-gated
 * routes. It's a new tool in its own right, reading straight out of
 * audit_log, gated once for the whole page (see ACCESS CONTROL below), not
 * per-section. property-360's per-card partial-failure pattern is still
 * followed at the route level: each section's fetch is wrapped in its own
 * try/catch and returns a real 500 with a plain message on failure, rather
 * than throwing raw into the request.
 *
 * HOW THE NEXT SECTION PLUGS IN — three additions, same shape as the first:
 *   1. A fetch function down in "SECTION: <name>" below, taking whatever
 *      paging/filter params it needs and returning bounded, real rows —
 *      never an unbounded query (see PROPERTY_360_VIEWS_MAX_LIMIT for the
 *      pattern: clamp, don't trust the client's own limit/offset).
 *   2. A route, `GET /api/audits/<section-slug>`, registered below
 *      alongside GET /api/audits/property-360-views, gated the exact same
 *      way (this router's own `router.use(attachArchiveSearchRole)` below
 *      already ran by the time any route here executes — just add
 *      requireArchiveSearchAdmin to the new route the same way).
 *   3. A section block in dashboard/index.html — copy the "Property 360
 *      Views" <section> and its loadPropertyThreeSixtyViews()-shaped JS
 *      function, point it at the new route, and call it from init()
 *      alongside the first section's own call. See that file's own
 *      "ADD THE NEXT SECTION HERE" comment.
 * No shared registry array was built for a list of exactly one section —
 * that's speculative structure with nothing yet to prove it out. The three
 * steps above are what "add a section" concretely means today; if a third
 * or fourth section later reveals real shared plumbing (a common pager, a
 * common date-range filter), that's the point to factor it out, not before.
 *
 * ============================================================
 * ACCESS CONTROL — the one real design decision this build made, not
 * assumed. Flagged clearly here and in the build report so Peter can
 * override it.
 * ============================================================
 * This page surfaces staff activity data — who looked at what, when. That's
 * an oversight/management tool, not a day-to-day operational one like
 * Property 360 itself (which deliberately has NO gate of its own — see that
 * file's header). Default here is conservative: admins only, not every
 * logged-in Hub user.
 *
 * "Admin" is reused, not invented. This codebase has no hub-wide admin flag
 * — every "admin" that exists today is scoped to one tool's own row in
 * team_member_tool_roles (tool=<x>, role='admin'; confirmed by reading
 * lib/middleware.js's own "FUTURE: role/permission enforcement" comment,
 * which is explicit that no hub-wide role table lookup exists, and by
 * reading every other tool's own attach<Tool>Role function — each is scoped
 * to its own `tool` value). Minting a brand-new tool value (e.g.
 * 'hub_audits') for this page would be the "textbook" per-tool move every
 * other section of this Hub makes, but it's a real schema change — a new
 * migration widening team_member_tool_roles' `tool` CHECK constraint — which
 * is Neo's call, not built unasked as a side effect of a frontend pass, and
 * it would start with zero grants (same "nobody has access until Peter
 * explicitly grants it" pattern rental-analysis/router.js's own header
 * documents), meaning nobody — including Peter — could open this page today
 * without a separate, manual step in Supabase first.
 *
 * Instead, this reuses archive-search/router.js's own, already-built,
 * unmodified attachArchiveSearchRole / requireArchiveSearchAdmin pair
 * (tool='archive_search', role='admin') — imported below exactly the way
 * property-360/router.js imports other tools' real gate functions, per that
 * file's own "additive only, zero change to the function's own logic"
 * discipline. Two real, concrete reasons this specific reuse, not some
 * other tool's admin check:
 *   1. It's already the Hub's closest sibling to this page. Archive
 *      Search's own Compliance Review page (GET /archive-search/
 *      compliance-review) is already exactly this kind of thing — an
 *      admin-only internal oversight page reached by typing its URL, not a
 *      day-to-day tool — and its access is the same page-shell-ungated/
 *      API-gated shape this file follows below.
 *   2. It's not empty today. Confirmed live against Supabase (this build's
 *      own test query): Peter and Stephen both already hold role='admin'
 *      for tool='archive_search'. Reusing it means this page works for the
 *      right two people the moment it ships, with no separate grant step
 *      Peter has to remember to go do first.
 * Trade-off, named plainly: whoever holds archive_search admin gets audits
 * admin too, even though the two are logically different permissions that
 * happen to be held by the same two people today. If Peter ever wants a
 * DIFFERENT set of people to see staff-activity audits than sees Fair
 * Housing/escalations compliance review, that's the moment to ask Neo for
 * a real, dedicated tool='hub_audits' (or similar) role — a small, additive
 * migration, not a rebuild of this file.
 * ============================================================
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const { GLOBAL_SEARCH_WIDGET_HTML } = require('../lib/global-search-widget');
const { attachArchiveSearchRole, requireArchiveSearchAdmin } = require('../archive-search/router');

// ─── Config ─────────────────────────────────────────────────────────────
const missing = [];
if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
if (missing.length > 0) {
  console.error(`[audits] Missing environment variables: ${missing.join(', ')}`);
  console.error('[audits] Set these in the shared .env at the project root (see .env.example).');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// A to-one relationship embedded via PostgREST (audit_log.property_id ->
// properties, audit_log.performed_by -> users) can come back as a plain
// object OR a (possibly empty) array — a real, live-confirmed gotcha
// security-deposit/router.js's own getSecurityDepositPropertySummary
// already documents and defends against (its own extractCase helper).
// Same defense here, generalized to any single embedded relation.
function toOneRelation(rel) {
  if (!rel) return null;
  if (Array.isArray(rel)) return rel.length ? rel[0] : null;
  return rel;
}

// Clamps a query-string integer into [min, max], falling back to a default
// for anything missing or not actually a number. Every paginated route
// below uses this rather than trusting req.query directly — the one
// concrete "basic sanity, not an unbounded query" requirement this build
// was given.
function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ============================================================
// SECTION: Property 360 Views
// Reads audit_log rows written by property-360/router.js's own
// writeAuditLog() call inside GET /api/property-360/:propertyId/summary —
// action='property_360.viewed', one row per real page view (see that
// file's own "Usage logging" comment: fires once per property-360 page
// load, confirmed live in nginx logs there). property_id and performed_by
// (a users.id looked up from actor_email at write time — NOT
// team_members.id; audit_log.performed_by's own FK points at the `users`
// table, 20260720000003_foundation.sql) are both real FKs on audit_log
// (20260626000000_initial_schema.sql / 20260815000000_audit_log_rule1_
// compliance.sql), so both are embedded directly rather than fetched as a
// second round trip.
// ============================================================
const PROPERTY_360_VIEWS_DEFAULT_LIMIT = 50;
const PROPERTY_360_VIEWS_MAX_LIMIT = 200;

async function fetchPropertyThreeSixtyViewsSection({ limit, offset }) {
  const { data, error, count } = await supabase
    .from('audit_log')
    .select(
      'id, created_at, property_id, performed_by, actor_type, ' +
        'properties(id, name, address, city), users(id, name, email)',
      { count: 'exact' }
    )
    .eq('action', 'property_360.viewed')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;

  const rows = (data || []).map((row) => {
    const property = toOneRelation(row.properties);
    const viewer = toOneRelation(row.users);
    return {
      id: row.id,
      viewed_at: row.created_at,
      // property_id is set on every property_360.viewed row (the writer
      // only logs once the property is confirmed to exist — see that
      // file's own comment) but the property row itself could in
      // principle be deleted later; property_id (a plain UUID) is kept as
      // a fallback label so a row never silently disappears from this
      // list just because its property join came back empty.
      property: property
        ? { id: property.id, name: property.name, address: property.address, city: property.city }
        : row.property_id
        ? { id: row.property_id, name: null, address: null, city: null }
        : null,
      // performed_by is only set when writeAuditLog's own lookupUserId(email)
      // found a matching `users` row for the viewer's email — real gaps
      // exist (see that table's own comment: it's a separate, older roster,
      // not guaranteed to have a row for every Supabase Auth account).
      // actor_type is always 'human' for this action today (property-360's
      // writer never sets it otherwise), kept here rather than assumed so a
      // future non-human writer of this same action doesn't get mislabeled.
      viewer: viewer
        ? { id: viewer.id, name: viewer.name, email: viewer.email }
        : row.performed_by
        ? { id: row.performed_by, name: null, email: null }
        : { id: null, name: row.actor_type === 'human' ? null : 'System', email: null },
    };
  });

  return { rows, total: count == null ? rows.length : count, limit, offset };
}

// ─── Router: everyone reaching here is already Hub-logged-in (server.js
// mounts this after requireLogin), same as every other tool. Gated further
// on top of that — see ACCESS CONTROL above — for the whole router, not
// per-route: unlike property-360 (whose page shell is deliberately open,
// content gated card-by-card) or archive-search (whose page shell is open,
// 'searcher' role sees search, only 'admin' sees compliance review), there
// is no non-admin content on this page at all, so gating every route here
// the same way is simpler and correct rather than a corner cut.
// ============================================================
const router = express.Router();
router.use(attachArchiveSearchRole);

// ─── GET /audits — the page shell ──────────────────────────────────────
// No server-side access gate on this exact route, matching every other
// tool's own page-shell convention in this Hub (property-360/router.js's
// GET /property-360, archive-search/router.js's GET /archive-search/
// compliance-review) — "this is just the static page shell... every route
// that actually returns or changes data below IS gated." A non-admin who
// browses straight to /audits gets served this same HTML and then sees a
// plain "restricted to Hub admins" message client-side, the moment its own
// GET /api/audits/auth/me call below comes back 403 — same pattern
// compliance-review.html's own init() already uses.
router.get('/audits', (req, res) => {
  fs.readFile(path.join(__dirname, 'dashboard', 'index.html'), 'utf8', (err, html) => {
    if (err) return res.status(500).send('Could not load page.');
    res.send(html.replace('<body>', '<body>\n' + GLOBAL_SEARCH_WIDGET_HTML));
  });
});

// ─── GET /api/audits/auth/me — same shape as every other tool's own
// auth/me route (archive-search/router.js's GET /api/archive-search/
// auth/me is the closest precedent, reused near-verbatim). Backs both this
// page's own client-side gate and the Hub home-page tile's "check first,
// mount only on success" script (server.js).
// ============================================================
router.get('/api/audits/auth/me', requireArchiveSearchAdmin, (req, res) => {
  res.json({
    email: req.user.email,
    name: req.archiveSearchMemberName || req.user.email,
    role: req.archiveSearchRole,
  });
});

// ─── GET /api/audits/property-360-views ────────────────────────────────
router.get('/api/audits/property-360-views', requireArchiveSearchAdmin, async (req, res) => {
  const limit = clampInt(req.query.limit, PROPERTY_360_VIEWS_DEFAULT_LIMIT, 1, PROPERTY_360_VIEWS_MAX_LIMIT);
  const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  try {
    const result = await fetchPropertyThreeSixtyViewsSection({ limit, offset });
    res.json(result);
  } catch (err) {
    console.error('[audits] property-360-views fetch failed:', err.message);
    res.status(500).json({ error: 'Could not load Property 360 view history right now.' });
  }
});

module.exports = { router };
