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

// ─── Shared viewer attribution — used by BOTH the paginated list below and
// the trends/summary section further down. Factored out here (rather than
// a second inline copy) the moment a second caller needed the exact same
// resolution: performed_by's own embed first, then (only when that embed
// came back empty) a batched actor_id match against users.email OR
// users.alt_email.
//
// READ-TIME FALLBACK, why it exists at all: some Hub users log in under
// more than one real email (see seed-user-alt-email.js and the alt_email
// column it seeds), and audit_log rows written before alt_email existed
// for a given user can never be re-attributed by writing to audit_log —
// that table is append-only/immutable after insert (GOVERNANCE.md Rule 4;
// supabase/migrations/20260720000003_foundation.sql ~line 311-314). Fixing
// it here, at read time, off the row's own untouched actor_id (the email
// lookupUserId was given at write time — permanently correct, never
// changes), means audit_log itself is never written to.
// ────────────────────────────────────────────────────────────────────────

// Batched, not one lookup per row: collect the distinct actor_id emails for
// rows still unresolved (no users embed, no performed_by) across whatever
// set of rows the caller passed in, and do exactly one .or() query against
// users for the whole set — same email-OR-alt_email pattern already used
// by every lookupUserId() in this codebase (e.g. property-360/router.js).
async function resolveFallbackUsersByActorId(rows) {
  const unresolvedEmails = new Set();
  for (const row of rows) {
    const viewer = toOneRelation(row.users);
    if (!viewer && !row.performed_by && row.actor_id) {
      unresolvedEmails.add(row.actor_id);
    }
  }

  const userByEmail = new Map();
  if (unresolvedEmails.size === 0) return userByEmail;

  const emails = [...unresolvedEmails];
  const orFilter = emails.map((email) => `email.eq.${email},alt_email.eq.${email}`).join(',');
  const { data: matchedUsers, error: matchError } = await supabase
    .from('users')
    .select('id, name, email, alt_email')
    .or(orFilter);
  if (matchError) throw matchError;
  for (const user of matchedUsers || []) {
    if (user.email) userByEmail.set(user.email, user);
    if (user.alt_email) userByEmail.set(user.alt_email, user);
  }
  return userByEmail;
}

// Resolves ONE row's viewer given the batched fallback map above. Same
// priority order everywhere this is called, so a person is identified the
// same way no matter which section is asking:
//   1. embedded users row (performed_by matched a real users.id at read time)
//   2. raw performed_by id (embed came back empty but the id is still there —
//      a real gap: that table is a separate, older roster, not guaranteed to
//      have a row for every Supabase Auth account)
//   3. actor_id matched against users.email/alt_email (the fallback above)
//   4. unresolved — actor_type is always 'human' for this action today
//      (property-360's writer never sets it otherwise), kept here rather
//      than assumed so a future non-human writer of this same action
//      doesn't get mislabeled as a person.
// `resolved: true` on cases 1-3 is what callers use to decide whether they
// got a real person back or need their own unresolved-actor handling.
function resolveAuditLogViewer(row, userByEmail) {
  const viewer = toOneRelation(row.users);
  if (viewer) {
    return { id: viewer.id, name: viewer.name, email: viewer.email, actorId: row.actor_id, resolved: true };
  }
  if (row.performed_by) {
    return { id: row.performed_by, name: null, email: null, actorId: row.actor_id, resolved: true };
  }
  const fallbackUser = row.actor_id ? userByEmail.get(row.actor_id) : null;
  if (fallbackUser) {
    return {
      id: fallbackUser.id,
      name: fallbackUser.name,
      email: fallbackUser.email,
      actorId: row.actor_id,
      resolved: true,
    };
  }
  return {
    id: null,
    name: row.actor_type === 'human' ? null : 'System',
    email: null,
    actorId: row.actor_id,
    resolved: false,
  };
}

async function fetchPropertyThreeSixtyViewsSection({ limit, offset }) {
  const { data, error, count } = await supabase
    .from('audit_log')
    .select(
      'id, created_at, property_id, performed_by, actor_type, actor_id, ' +
        'properties(id, name, address, city), users(id, name, email)',
      { count: 'exact' }
    )
    .eq('action', 'property_360.viewed')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;

  const rows = data || [];

  // Bounded to one extra query per page regardless of
  // PROPERTY_360_VIEWS_MAX_LIMIT (200) — see resolveFallbackUsersByActorId.
  const userByEmail = await resolveFallbackUsersByActorId(rows);

  const mappedRows = rows.map((row) => {
    const property = toOneRelation(row.properties);
    const resolvedViewer = resolveAuditLogViewer(row, userByEmail);
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
      viewer: { id: resolvedViewer.id, name: resolvedViewer.name, email: resolvedViewer.email },
    };
  });

  return { rows: mappedRows, total: count == null ? mappedRows.length : count, limit, offset };
}

// ============================================================
// SECTION: Property 360 Views — Trends/Usage Summary
// Peter's own framing (already approved): "pick a time range (last
// 7/30/90 days)... a small chart of total views per day... a leaderboard
// of who's viewed how many properties in that window, sorted
// most-active-first." Backs a new chart+leaderboard block on the same
// /audits page, next to the existing raw list — same data (audit_log,
// action='property_360.viewed'), aggregated instead of paginated.
//
// DAY-BOUNDARY CONVENTION — checked for an existing house convention
// before picking one, per this build's own instructions. Two tools in
// this Hub DO bucket by America/Los_Angeles (call-stats/lib/timezone.js,
// scorecard/lib/week.js), but both document that as a business
// requirement specific to THEIR OWN metric — Aircall call attribution and
// work-week reporting, per timezone.js's own header ("required per
// SPEC.md and the call_stats migration's call_date column comment") — not
// a general "how this codebase buckets any created_at column" rule. Every
// other date-stamped report in this Hub (approval-briefing/lib/gather.js,
// maintenance-history/router.js's `since` cutoff, property-360/router.js's
// own todayStr) just takes `new Date().toISOString().slice(0, 10)` — plain
// UTC, no Pacific conversion. No general "audit_log per-day rollup"
// precedent exists either way, so this uses UTC calendar days, explicitly,
// rather than inventing a third convention. If Peter later finds the chart
// "off by a few hours" against his own Pacific workday, that's the
// concrete signal to switch this one file to timezone.js's helpers.
// ============================================================
const PROPERTY_360_VIEWS_SUMMARY_ALLOWED_DAYS = { '7': 7, '30': 30, '90': 90 };
const PROPERTY_360_VIEWS_SUMMARY_DEFAULT_DAYS = 30;
const PROPERTY_360_VIEWS_SUMMARY_FETCH_PAGE_SIZE = 500;

// Only ever 7, 30, or 90 — deliberately not a general date-range picker
// (see the route comment below). Anything else, including missing,
// defaults to 30.
function parsePropertyThreeSixtyViewsSummaryDays(raw) {
  return PROPERTY_360_VIEWS_SUMMARY_ALLOWED_DAYS[raw] || PROPERTY_360_VIEWS_SUMMARY_DEFAULT_DAYS;
}

function toUtcDateStr(date) {
  return date.toISOString().slice(0, 10);
}

// Fetches every audit_log row in [rangeStartIso, rangeEndIso) for this
// action — bounded paging (same shape as archive-search/router.js's own
// fetchAllPages), not a single unbounded query, because a 90-day window's
// row count isn't known ahead of time. The aggregation below needs every
// row's own actor_id/performed_by to resolve viewers correctly, so a
// SQL-side count/group-by alone wouldn't be enough here.
async function fetchAllPropertyThreeSixtyViewRowsInRange(rangeStartIso, rangeEndIso) {
  let all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('audit_log')
      .select('created_at, performed_by, actor_type, actor_id, users(id, name, email)')
      .eq('action', 'property_360.viewed')
      .gte('created_at', rangeStartIso)
      .lt('created_at', rangeEndIso)
      .order('created_at', { ascending: true })
      .range(from, from + PROPERTY_360_VIEWS_SUMMARY_FETCH_PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < PROPERTY_360_VIEWS_SUMMARY_FETCH_PAGE_SIZE) break;
    from += PROPERTY_360_VIEWS_SUMMARY_FETCH_PAGE_SIZE;
  }
  return all;
}

async function fetchPropertyThreeSixtyViewsSummary({ days }) {
  const todayStr = toUtcDateStr(new Date());
  const [y, m, d] = todayStr.split('-').map(Number);
  // Exclusive upper bound: UTC midnight the day AFTER today, so a view
  // logged earlier today (even though today isn't over yet) is included.
  const rangeEndUtcMs = Date.UTC(y, m - 1, d + 1);
  const rangeStartUtcMs = rangeEndUtcMs - days * 24 * 60 * 60 * 1000;
  const rangeStartIso = new Date(rangeStartUtcMs).toISOString();
  const rangeEndIso = new Date(rangeEndUtcMs).toISOString();

  const rows = await fetchAllPropertyThreeSixtyViewRowsInRange(rangeStartIso, rangeEndIso);
  const userByEmail = await resolveFallbackUsersByActorId(rows);

  // daily — zero-filled, oldest first, one entry per UTC calendar day in
  // range. Seeded with every day at 0 BEFORE counting real rows, so a day
  // with no activity still shows up as a real zero, not a gap.
  const dailyMap = new Map();
  for (let i = 0; i < days; i++) {
    dailyMap.set(toUtcDateStr(new Date(rangeStartUtcMs + i * 24 * 60 * 60 * 1000)), 0);
  }
  for (const row of rows) {
    // created_at comes back from PostgREST as an ISO string already in UTC
    // (a timestamptz column) — slicing it is the same calendar day as
    // toUtcDateStr(new Date(row.created_at)), just without the parse.
    const dateStr = row.created_at.slice(0, 10);
    if (dailyMap.has(dateStr)) dailyMap.set(dateStr, dailyMap.get(dateStr) + 1);
  }
  const daily = [...dailyMap.entries()].map(([date, count]) => ({ date, count }));

  // by_viewer — same resolveAuditLogViewer() priority as the list section
  // above, so a person whose rows resolve partly via performed_by and
  // partly via the alt_email fallback still collapses into ONE row here,
  // keyed on the resolved users.id rather than on which path resolved it.
  // Rows that can't be resolved to any known user at all are grouped by
  // their own raw actor_id email — one row per distinct unresolvable
  // email, never lumped together.
  const byViewerMap = new Map();
  for (const row of rows) {
    const resolved = resolveAuditLogViewer(row, userByEmail);
    let key, name, email;
    if (resolved.resolved) {
      key = `user:${resolved.id}`;
      name = resolved.name;
      email = resolved.email;
    } else if (resolved.actorId) {
      key = `raw:${resolved.actorId}`;
      name = null;
      email = resolved.actorId;
    } else {
      // No actor_id at all — never observed live for this action (it's
      // always 'human' with a real login email today), but grouped under
      // one System bucket rather than silently dropped if it ever happens.
      key = 'system';
      name = 'System';
      email = null;
    }
    const existing = byViewerMap.get(key);
    if (existing) {
      existing.count += 1;
      // Prefer a real name/email over one a different row for this same
      // person came back without (e.g. a performed_by-only row with no
      // users embed, mixed in with rows that resolved a full name).
      if (!existing.name && name) existing.name = name;
      if (!existing.email && email) existing.email = email;
      if (row.created_at > existing.last_viewed_at) existing.last_viewed_at = row.created_at;
    } else {
      byViewerMap.set(key, { name, email, count: 1, last_viewed_at: row.created_at });
    }
  }
  const by_viewer = [...byViewerMap.values()].sort((a, b) => b.count - a.count);

  return {
    range_days: days,
    total_views: rows.length,
    daily,
    by_viewer,
  };
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

// ─── GET /api/audits/property-360-views/summary ────────────────────────
// `days` is deliberately restricted to 7/30/90, not a general date-range
// picker — any other value (or none) silently falls back to 30, same
// "clamp, don't trust the client" discipline as clampInt above, just a
// fixed allow-list instead of a numeric range since this is a UI toggle,
// not a paginator.
router.get('/api/audits/property-360-views/summary', requireArchiveSearchAdmin, async (req, res) => {
  const days = parsePropertyThreeSixtyViewsSummaryDays(req.query.days);
  try {
    const result = await fetchPropertyThreeSixtyViewsSummary({ days });
    res.json(result);
  } catch (err) {
    console.error('[audits] property-360-views summary fetch failed:', err.message);
    res.status(500).json({ error: 'Could not load Property 360 usage trends right now.' });
  }
});

module.exports = { router };
