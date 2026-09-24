/**
 * property-360/router.js
 * Property 360 — one page that composes Insurance, Security Deposit,
 * Maintenance History, and LeadSimple's own already-gated data into a
 * single per-property summary. Full spec:
 * projects/hub/property-360-SPEC.md — treat it as authoritative,
 * especially "How It Works," "Access Control," and "Where It Lives."
 *
 * ============================================================
 * ACCESS CONTROL — no new permission of this page's own
 * ============================================================
 * Per the spec's Access Control section: this page composes three
 * already-gated tools' own, real, UNMODIFIED access-check functions
 * (attachInsuranceRole / attachSecurityDepositRole /
 * attachMaintenanceHistoryRole, imported below from each tool's own
 * router.js — these are the exact ground-truth names/paths each tool's
 * own build reported) plus one new gate for LeadSimple (see that
 * section further down for why it's written here rather than imported).
 * Nobody sees anything on this page they couldn't already see by
 * opening that tool directly — composing four tools onto one page must
 * never become a fifth, broader way in. No new `tool` value on
 * team_member_tool_roles, no new role, no gate of this page itself:
 * anyone logged into the Hub at all can open /property-360; what they
 * see on it is entirely a function of what they're already allowed to
 * see elsewhere (spec: "someone with zero roles in any of the three
 * tools sees a real, honest 'nothing to show you here' page instead of
 * a 403").
 *
 * ARCHIVE SEARCH — added per compliance/archive-search-property-360-
 * embed-owner-risk-acceptance.md (all three addenda) and the CLEARED
 * WITH CONDITIONS confirmations it records:
 * compliance/archive-search-property-360-embed-asimov-confirmation.md
 * and compliance/archive-search-property-360-embed-mason-confirmation.md.
 * Same compose-only shape as the other four tools, on purpose — Asimov's
 * confirmation is explicit that a real `searcher`/`admin` role check via
 * attachArchiveSearchRole (imported from archive-search/router.js,
 * unmodified) is required here specifically so this page's own stated
 * design principle keeps holding: this must stay a real re-check of
 * that tool's own access table, never a bypass that hands out search
 * just because someone can open this page. archiveSearchRouter is
 * mounted AFTER this router in server.js (see that file's own mount-
 * order comments), so — like attachMaintenanceHistoryRole and
 * attachLeadSimpleDelinquencyRole below — the gate is called explicitly
 * here every time, not inherited from an earlier middleware run.
 * `archive_search_access` is reported as a plain boolean flag on the
 * response (same shape as `maintenance_admin` below), not folded into
 * `cards` — it carries no data of its own from this route (the search
 * widget calls archive-search's own already-gated
 * /api/archive-search/search and /api/archive-search/message/:id
 * directly, which independently re-check the same role), and per
 * Asimov's condition it must never feed computeNeedsAttentionAndOrder
 * (search access is not an urgency signal).
 *
 * IMPORTANT — READ BEFORE ASSUMING THIS MEANS THE POPULATION IS FULLY
 * SETTLED: Mason's confirmation (linked above) clears the population
 * question itself but leaves two conditions open, and is explicit that
 * neither blocks building this page — they gate treating the
 * population as fully authorized, not the code. (1) The specific
 * accommodation/harassment/eviction thread TARS's validation sample
 * found should be run through the existing archive_search_escalations
 * mechanism before the broader population can reach it — Peter has
 * explicitly declined this (owner-risk-acceptance's third addendum,
 * verbatim: "no dont suppress"), so that thread remains reachable by
 * design, not by oversight. (2) Asimov was asked to independently
 * verify that Fair Housing/system-use training and a real escalation
 * path actually exist today for the Hub population this ships to —
 * nothing in this chain confirms that was done. Both are Peter's and
 * Asimov's open items, not this file's to resolve.
 *
 * ============================================================
 * WHY THE PER-TOOL SUMMARY FUNCTIONS ARE IMPORTED, NOT RE-QUERIED HERE
 * ============================================================
 * The spec's own Access Control section explicitly rejects a real HTTP
 * call from this server back into each tool's own already-gated route
 * ("adds real complexity for no real benefit here — forwarding the
 * session cookie correctly, handling three extra network round-trips,
 * and building a route that calls itself") in favor of in-process reuse
 * — the same reasoning this file applies one level further: Insurance's
 * and Maintenance History's own new GET .../summary routes were built as
 * anonymous handlers with no way to call them in-process, and Security
 * Deposit's own new route reuses B2-photo-matching helpers
 * (fetchAllIndexedB2Folders / findBestPhotoMatch /
 * CONFIRMED_FOLDER_STATUSES_EXCLUDED) that live only inside that file
 * and aren't exported. Rather than duplicate that query logic a second
 * time in a different file (a real drift risk, the same class of
 * problem the spec's Access Control section names for the gate
 * functions themselves), each tool's summary handler was named and
 * added to that file's own module.exports, alongside its
 * attach<Tool>Role/require<Tool>Access — the exact same "additive only,
 * zero change to the function's own logic" pattern Asimov's review
 * already approved for the gate functions, just extended to the data
 * function too. See getInsurancePropertySummary /
 * getSecurityDepositPropertySummary / getMaintenanceHistoryPropertySummary
 * for that change in each file. callHandler() below is what lets this
 * file invoke those Express handlers directly, without an HTTP call —
 * literally the same function, called the same way, per this page's
 * request.
 *
 * ============================================================
 * WHY LEADSIMPLE'S GATE IS WRITTEN HERE, NOT IMPORTED
 * ============================================================
 * projects/hub/leadsimple-property-brain/ has no router.js today —
 * confirmed by directory listing (only lib/leadsimple-connector.js,
 * lib/extract-claims.js, run-accuracy-test-sample.js, and this build's
 * own sync-property-stages.js exist there). The ACCESS MECHANISM the
 * spec's Access Control section requires this card to use already
 * exists at the database level — 'leadsimple_delinquency' is already a
 * valid `tool` value and 'leasing_reviewer' is already a valid `role`
 * value on team_member_tool_roles (both added eight days before this
 * build, 20260825000000_leadsimple_property_brain_phase1.sql, Section
 * C) — there's just no application-code router yet to host the gate
 * function that reads them. Written below in the exact same
 * attach.../require...Access shape every other tool in this Hub uses,
 * because Property 360 is the first and only consumer of this check
 * today. If leadsimple-property-brain later gets its own router.js,
 * this pair should move there and be imported the same way the other
 * three are — not duplicated a second time.
 * ============================================================
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const { GLOBAL_SEARCH_WIDGET_HTML } = require('../lib/global-search-widget');
const { attachInsuranceRole, getInsurancePropertySummary } = require('../insurance/router');
const { attachSecurityDepositRole, getSecurityDepositPropertySummary } = require('../security-deposit/router');
const {
  attachMaintenanceHistoryRole,
  getMaintenanceHistoryPropertySummary,
} = require('../maintenance-history/router');
const {
  attachOwnerTenantNotesRole,
  roleHasAnyAccess: ownerTenantNotesRoleHasAnyAccess,
} = require('../owner-tenant-notes/router');
const {
  attachArchiveSearchRole,
  ARCHIVE_SEARCH_SEARCH_ROLES,
} = require('../archive-search/router');

// ─── Config ─────────────────────────────────────────────────────────────
const missing = [];
if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
if (missing.length > 0) {
  console.error(`[property-360] Missing environment variables: ${missing.join(', ')}`);
  console.error('[property-360] Set these in the shared .env at the project root (see .env.example).');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// properties.id is a UUID column (20260626000000_initial_schema.sql) —
// same guard every other tool's property-scoped route already has (see
// e.g. maintenance-history/router.js's own isValidUuid), redefined here
// rather than imported since none of those copies are exported and this
// is a two-line, well-established pattern, not real duplication risk.
function isValidUuid(str) {
  return typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// ─── LeadSimple access allow-list — property-360-SPEC.md's "Access
// control — RESOLVED 2026-09-02, then WIDENED 2026-09-02" table, decided
// in full in compliance/maintenance-coordinator-leadsimple-access.md.
// Explicit allow-list, not a bare truthy check on req.leadSimpleDelinquencyRole
// — that field can legally hold any value on the shared role CHECK (see
// the comment inside attachLeadSimpleDelinquencyRole below), most of
// which (reviewer, contributor, inspection_coordinator, pod_lead) were
// never evaluated for this category of data and must get no card at all.
const LEADSIMPLE_ALLOWED_ROLES = new Set([
  'admin',
  'leasing_reviewer',
  'property_manager',
  'director_of_operations',
  'maintenance_coordinator',
]);

// ─── LeadSimple access — see file header "WHY LEADSIMPLE'S GATE IS
// WRITTEN HERE" above. Same fail-closed shape as
// attachInsuranceRole/attachSecurityDepositRole/attachMaintenanceHistoryRole.
async function attachLeadSimpleDelinquencyRole(req, res, next) {
  req.leadSimpleDelinquencyRole = null;
  try {
    const { data: member, error: memberErr } = await supabase
      .from('team_members')
      .select('id, is_active')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (memberErr) throw memberErr;
    if (!member || !member.is_active) return next();

    const { data: roleRow, error: roleErr } = await supabase
      .from('team_member_tool_roles')
      .select('role')
      .eq('team_member_id', member.id)
      .eq('tool', 'leadsimple_delinquency')
      .maybeSingle();
    if (roleErr) throw roleErr;
    // team_member_tool_roles.role is ONE shared CHECK constraint across
    // every tool on this table (admin, director_of_operations,
    // property_manager, inspection_coordinator, pod_lead, reviewer,
    // contributor, leasing_reviewer, maintenance_coordinator — see
    // 20260902020000's own "CURRENT STATE CHECK" comment for the full,
    // current list) — NOT a per-tool allow-list. Any of those values is
    // legal to store against tool='leadsimple_delinquency', so this field
    // being non-null does not by itself mean "this person should see the
    // LeadSimple card." Whether it grants access is decided below, by
    // LEADSIMPLE_ALLOWED_ROLES, not here.
    req.leadSimpleDelinquencyRole = roleRow ? roleRow.role : null;
    next();
  } catch (err) {
    console.error('[property-360] LeadSimple permission lookup failed:', err.message);
    next();
  }
}

// ─── runGate: invokes one tool's attach<Tool>Role middleware in-process
// against this page's own request, without an HTTP round trip. Every
// attach<Tool>Role function (confirmed by reading all four) only ever
// reads req.user and writes a couple of req.* fields — it never touches
// res — so a bare {} stands in safely. Each one also always eventually
// calls next() itself, even after catching its own internal error
// (fail-closed: role stays null, next() still runs) — this wrapper's
// own .catch is therefore just a backstop for something these functions
// aren't expected to do, resolving instead of rejecting so one gate
// misbehaving can't take the whole aggregation route down with it.
function runGate(gateFn, req) {
  return new Promise((resolve) => {
    Promise.resolve(gateFn(req, {}, resolve)).catch((err) => {
      console.error('[property-360] a gate function threw unexpectedly:', err.message);
      resolve();
    });
  });
}

// ─── callHandler: invokes one tool's exported summary handler
// (getInsurancePropertySummary / getSecurityDepositPropertySummary /
// getMaintenanceHistoryPropertySummary — all `async (req, res) => {...}`
// Express handlers, confirmed by reading each) in-process, capturing
// whatever it would have sent as the HTTP response instead of actually
// sending one. Every one of these three handlers always resolves by
// calling res.json(...) or res.status(n).json(...) — never res.send()
// or any other response method (confirmed by reading each in full) — so
// this fake res only needs to implement those two.
function callHandler(handler, req) {
  return new Promise((resolve) => {
    let statusCode = 200;
    const fakeRes = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        resolve({ statusCode, body });
      },
    };
    Promise.resolve(handler(req, fakeRes)).catch((err) => {
      resolve({ statusCode: 500, body: { error: err.message } });
    });
  });
}

// ─── Property header — property-360-SPEC.md's "What You'll See": name/
// address/city, real occupancy and nearest upcoming lease-end (NOT
// units.status — confirmed elsewhere in this codebase to always read
// "vacant" portfolio-wide), and the current owner's name/phone/email.
// Reuses the exact query shape maintenance-history/router.js's own
// GET .../overview route already computes this from (that file's
// router.js:469-534) rather than re-deriving it a second way — the same
// units -> leases occupancy signal, and the same property_owners (joins
// on AppFolio's own text id, no FK) -> owners lookup. Not imported
// as a function for the same reason the LeadSimple gate isn't: /overview
// computes this as one step inside a much larger response (ticket
// aggregation, per-component synthesis) with no standalone exported
// function to call for just this piece, and duplicating ~40 lines of
// plain two-table SQL here is a materially smaller, lower-risk
// duplication than re-implementing Security Deposit's B2 photo-matching
// would have been (see file header) — this was re-typed rather than
// exported-and-imported for that reason.
async function fetchPropertyHeader(propertyId) {
  const { data: property, error: propErr } = await supabase
    .from('properties')
    .select('id, name, address, city, state, zip, unit_count, appfolio_id')
    .eq('id', propertyId)
    .maybeSingle();
  if (propErr) throw propErr;
  if (!property) return null;

  const { data: units, error: unitsErr } = await supabase
    .from('units')
    .select('id')
    .eq('property_id', property.id);
  if (unitsErr) throw unitsErr;
  const unitIds = (units || []).map((u) => u.id);

  const leaseByUnit = {};
  if (unitIds.length) {
    const { data: leases, error: leasesErr } = await supabase
      .from('leases')
      .select('unit_id, status, lease_end')
      .in('unit_id', unitIds)
      .order('lease_end', { ascending: false });
    if (leasesErr) throw leasesErr;
    // Sorted lease_end desc, so the first row seen per unit is already
    // its most-recent lease; only replace it if a later row is 'active'
    // and the one already stored isn't — same rule /overview uses.
    for (const l of leases || []) {
      const existing = leaseByUnit[l.unit_id];
      if (!existing || (l.status === 'active' && existing.status !== 'active')) {
        leaseByUnit[l.unit_id] = l;
      }
    }
  }

  const occupiedCount = unitIds.filter(
    (id) => leaseByUnit[id] && leaseByUnit[id].status === 'active'
  ).length;

  // Nearest upcoming lease-end — the earliest lease_end, among active
  // leases, that hasn't already passed. /overview's own response
  // doesn't reduce this to one value (it returns lease_end per unit and
  // leaves finding "the nearest one" to its own dashboard's JS) — this
  // is the same signal, reduced to the single date this page's header
  // needs. String comparison is safe here: lease_end is a DATE column,
  // Postgres/PostgREST returns it as 'YYYY-MM-DD', which sorts
  // correctly as a plain string.
  const todayStr = new Date().toISOString().slice(0, 10);
  let nextLeaseEnd = null;
  for (const unitId of unitIds) {
    const lease = leaseByUnit[unitId];
    if (lease && lease.status === 'active' && lease.lease_end && lease.lease_end >= todayStr) {
      if (!nextLeaseEnd || lease.lease_end < nextLeaseEnd) nextLeaseEnd = lease.lease_end;
    }
  }

  // Current owner — property_owners has no FK here (joins on AppFolio's
  // own text ids) and only ever holds the CURRENT owner-property link,
  // same has_owner_history_gap limitation /overview's own response
  // already documents. Shows the first row when more than one comes
  // back (rare, co-owned properties) rather than picking arbitrarily
  // among several as if one were more "current" than another.
  let owner = null;
  if (property.appfolio_id) {
    const { data: poRows, error: poErr } = await supabase
      .from('property_owners')
      .select('appfolio_owner_id')
      .eq('appfolio_property_id', property.appfolio_id);
    if (poErr) throw poErr;
    const ownerIds = (poRows || []).map((p) => p.appfolio_owner_id);
    if (ownerIds.length) {
      const { data: ownerRows, error: ownerErr } = await supabase
        .from('owners')
        .select('name, phone, email')
        .in('appfolio_id', ownerIds);
      if (ownerErr) throw ownerErr;
      owner = ownerRows && ownerRows[0]
        ? { name: ownerRows[0].name, phone: ownerRows[0].phone, email: ownerRows[0].email }
        : null;
    }
  }

  return {
    property: {
      id: property.id,
      name: property.name,
      address: property.address,
      city: property.city,
      state: property.state,
      zip: property.zip,
      unit_count: property.unit_count,
    },
    owner,
    has_owner_history_gap: true, // property_owners holds current ownership only — see comment above
    occupancy: { occupied: occupiedCount, total: unitIds.length },
    next_lease_end: nextLeaseEnd,
  };
}

// ─── Per-card fetch wrappers — property-360-SPEC.md's "Partial-failure
// handling" (added 2026-09-02 by the world-class review): each card's
// data-fetch runs independently, in parallel, each in its own try/catch,
// so one failing source never takes the rest of the page down with it.
// Three distinct outcomes, never collapsed into one: 'no_data' (the tool
// genuinely has nothing for this property — an honest, non-error state,
// "No records yet"), 'error' (the fetch itself failed — "Couldn't load
// this right now"), or 'ok' (real data). A card the viewer has no role
// in is left out of the response's `cards` object entirely, before any
// of these even run for it (see the aggregation route below) — "not
// included-but-blank, not a 403 for the whole page, just genuinely
// absent" (spec, "How It Works" step 5).
async function fetchInsuranceCard(req) {
  const { statusCode, body } = await callHandler(getInsurancePropertySummary, req);
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`insurance summary returned ${statusCode}: ${body && body.error}`);
  }
  // getInsurancePropertySummary returns a bare `null` (200) for "no
  // current policy anywhere for this property" — see that function's own
  // comment.
  return body === null ? { status: 'no_data' } : { status: 'ok', data: body };
}

async function fetchSecurityDepositCard(req) {
  const { statusCode, body } = await callHandler(getSecurityDepositPropertySummary, req);
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`security deposit summary returned ${statusCode}: ${body && body.error}`);
  }
  // getSecurityDepositPropertySummary returns { has_case: false } (never
  // null) for "no case anywhere at this property" — see that function's
  // own comment.
  return body && body.has_case === false ? { status: 'no_data' } : { status: 'ok', data: body };
}

async function fetchMaintenanceCard(req) {
  const { statusCode, body } = await callHandler(getMaintenanceHistoryPropertySummary, req);
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`maintenance history summary returned ${statusCode}: ${body && body.error}`);
  }
  // getMaintenanceHistoryPropertySummary always returns an object (never
  // null) with its own has_data boolean — true only once at least one
  // maintenance_requests row exists for this property's units (a real
  // ticket, real AppFolio actuals, or real snapshot spend — see that
  // function's own has_data comment). has_data was never designed to
  // reflect maintenance_notes, though — that's AppFolio's own separate
  // property-level notes field (supabase/migrations/20260906000000_
  // add_maintenance_notes_to_properties.sql), a plain passthrough with no
  // relationship to ticket/spend activity. Without this check, a property
  // with a real note on file but genuinely zero tickets/actuals/snapshot
  // spend collapsed to `no_data` below and the note never reached the
  // page at all, even though it's real, present data. `status: 'ok'` here
  // (with the rest of the body honestly empty/zero) is exactly what
  // already makes renderMaintenancePieChart (dashboard/index.html) render
  // the notes block standalone with no chart beside it — see that
  // function's own "No spend data to chart" comment — so no frontend
  // change is needed to show it once this card stops being collapsed.
  // Maintenance Limit joins the same exemption, same reasoning — also a
  // plain property-level passthrough unrelated to ticket/spend activity
  // (supabase/migrations/20260828000000_add_year_built_and_maintenance_
  // limit_to_properties.sql), and 0 is a real, meaningful value here (a
  // genuine $0.00 limit), not "nothing to show" — checked with `== null`,
  // not a falsy check, so a real $0.00 limit doesn't fall through to
  // no_data the way a falsy check would wrongly treat it.
  if (body && body.has_data === false && !body.maintenance_notes && body.maintenance_limit == null) {
    return { status: 'no_data' };
  }
  return { status: 'ok', data: body };
}

// LeadSimple's card is a plain read of the nightly-synced table
// (leadsimple_property_stages, 20260902000000_leadsimple_property_stages.sql)
// — not a live LeadSimple call, per the spec's own "Technical blocker"
// and "The fix" sections. One row per (property_id, process_type) for
// whichever of the three v1 process types currently has an OPEN process
// at this property; no row for a type means "nothing open," the exact
// "no data = no card content" convention this whole page already uses
// elsewhere (see that migration's own "GRAIN AND ROW LIFECYCLE" note).
async function fetchLeadSimpleCard(propertyId, role) {
  const { data, error } = await supabase
    .from('leadsimple_property_stages')
    .select('process_type, stage')
    .eq('property_id', propertyId);
  if (error) throw error;
  const rows = data || [];
  if (!rows.length) return { status: 'no_data' };

  const byType = {};
  for (const r of rows) byType[r.process_type] = r.stage;
  return {
    status: 'ok',
    data: {
      delinquency_stage: byType.delinquency || null,
      // maintenance_coordinator is approved for Delinquency and Move Out
      // only, not Lease Renewal (compliance/maintenance-coordinator-
      // leadsimple-access.md — Mason's habitability argument for
      // Delinquency is maintenance-specific and doesn't extend to
      // renewal timing, so that denial wasn't revisited). Every other
      // approved role sees all three process types.
      lease_renewal_stage: role === 'maintenance_coordinator' ? null : (byType.lease_renewal || null),
      move_out_stage: byType.move_out || null,
    },
  };
}

// ─── "Needs attention" + severity card ordering — property-360-SPEC.md's
// own explicit instruction: "compute the 'needs attention' summary and
// severity ordering as one reusable, standalone function (not inlined)
// — derive it from data already being fetched for the cards (no new
// queries)." Exported below alongside the router (not just used
// in-file) so a future portfolio-wide "which properties need attention"
// rollup — named as a real v2 candidate in the spec's own "World-Class
// Review" section — can reuse this exact logic instead of re-deriving
// the same rules a second time, per that section's own suggestion.
//
// Two severity tiers, not a flat list: CRITICAL always outranks WARNING
// regardless of which card it came from; within the same tier, fewer
// days remaining sorts first ("soonest due" — spec's own framing).
// SD_SOON_DUE_DAYS is a plain constant, not a researched number — same
// "easy to change here since it lives in code, not a database value"
// reasoning maintenance-history/router.js's own RECENT_MONTHS constant
// documents — chosen to match the spec's own illustrative example
// verbatim ("2 things need attention: insurance expires in 12 days ·
// deposit deadline in 5 days").
const ATTENTION_TIER = { CRITICAL: 100, WARNING: 50 };
const SD_SOON_DUE_DAYS = 5;
const INSURANCE_CRITICAL_STATUSES = new Set(['expired', 'no_policy']);

function severityScore(tier, daysRemaining) {
  const daysComponent = typeof daysRemaining === 'number' ? Math.max(0, 100 - daysRemaining) : 0;
  return tier * 1000 + daysComponent;
}

// Base render order when nothing on the page is actually urgent — keeps
// Security Deposit next to LeadSimple ("Rendered adjacent to the
// LeadSimple card below... same real-world event, two systems' views of
// it," per the spec's own "What You'll See" and "World-Class Review"
// sections) rather than falling back to an arbitrary or alphabetical
// tie-break once every card's score is equal.
// 'owner_tenant_notes' appended at the end, deliberately last and
// deliberately never scored into needs_attention below (see the card's own
// fetch site further down) — owner-tenant-operational-notes-SPEC.md
// Section 7/10: this data must never become a source of urgency/priority
// signal that could read as nudging staff toward a housing-relevant
// judgment about a specific tenant. It only ever sorts by this fixed
// position, same as any other card with no attention items.
const BASE_CARD_ORDER = ['insurance', 'security_deposit', 'leadsimple', 'maintenance', 'owner_tenant_notes'];

function computeNeedsAttentionAndOrder(cards) {
  const items = [];

  const insurance = cards.insurance;
  if (insurance && insurance.status === 'ok' && insurance.data) {
    const d = insurance.data;
    if (INSURANCE_CRITICAL_STATUSES.has(d.status)) {
      const message = d.status === 'no_policy' ? 'no insurance policy on file' : 'insurance has expired';
      items.push({ key: 'insurance', message, score: severityScore(ATTENTION_TIER.CRITICAL, d.days_until_expiration) });
    } else if (d.status === 'expiring_soon') {
      const days = d.days_until_expiration;
      const message = days != null ? `insurance expires in ${days} day${days === 1 ? '' : 's'}` : 'insurance is expiring soon';
      items.push({ key: 'insurance', message, score: severityScore(ATTENTION_TIER.WARNING, days) });
    }
  }

  const sd = cards.security_deposit;
  if (sd && sd.status === 'ok' && sd.data && sd.data.has_case) {
    const d = sd.data;
    if (d.escalated) {
      items.push({ key: 'security_deposit', message: 'security deposit case is escalated', score: severityScore(ATTENTION_TIER.CRITICAL, d.days_remaining) });
    } else if (typeof d.days_remaining === 'number' && d.days_remaining <= SD_SOON_DUE_DAYS) {
      const message = d.days_remaining < 0
        ? 'security deposit deadline has passed'
        : `deposit deadline in ${d.days_remaining} day${d.days_remaining === 1 ? '' : 's'}`;
      items.push({ key: 'security_deposit', message, score: severityScore(ATTENTION_TIER.WARNING, d.days_remaining) });
    }
  }

  // Only ever populated for viewers in PRIVACY_REVIEW_ROLES to begin
  // with (maintenance-history/router.js omits the key entirely for
  // anyone else, and omits it on a real zero too) — this line inherits
  // that same "nobody else sees any hint that field exists" guarantee
  // for free, since it only ever reads a key that's already gated.
  const maint = cards.maintenance;
  if (maint && maint.status === 'ok' && maint.data && maint.data.flagged_review_count) {
    const count = maint.data.flagged_review_count;
    items.push({
      key: 'maintenance',
      message: `${count} item${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} privacy review`,
      score: severityScore(ATTENTION_TIER.WARNING),
    });
  }

  const ls = cards.leadsimple;
  if (ls && ls.status === 'ok' && ls.data && ls.data.delinquency_stage === 'Eviction') {
    items.push({ key: 'leadsimple', message: 'delinquency case in Eviction stage', score: severityScore(ATTENTION_TIER.CRITICAL) });
  }

  items.sort((a, b) => b.score - a.score);

  const scoreByKey = {};
  for (const item of items) scoreByKey[item.key] = Math.max(scoreByKey[item.key] || 0, item.score);

  // card_order lists every card key actually present in `cards` (i.e.
  // ones the viewer has access to, whether or not they have data or
  // errored) — never a key that's absent entirely, since an absent key
  // means "this tool doesn't exist for this viewer" and must not be
  // implied to exist just by appearing in an ordering list.
  const cardOrder = Object.keys(cards)
    .filter((k) => cards[k] !== undefined)
    .sort((a, b) => {
      const diff = (scoreByKey[b] || 0) - (scoreByKey[a] || 0);
      if (diff !== 0) return diff;
      return BASE_CARD_ORDER.indexOf(a) - BASE_CARD_ORDER.indexOf(b);
    });

  if (!items.length) return { summary: null, items: [], card_order: cardOrder };

  const summary = `${items.length} thing${items.length === 1 ? '' : 's'} need${items.length === 1 ? 's' : ''} attention: ` +
    items.map((i) => i.message).join(' · ') + '.';
  return { summary, items: items.map((i) => ({ key: i.key, message: i.message })), card_order: cardOrder };
}

// ─── Usage logging — audits/router.js's "Property 360 Views" section reads
// these rows. Sibling implementation, same house style every router.js in
// this codebase already uses (not a shared import) — matching
// owner-tenant-notes/router.js's own writeAuditLog/lookupUserId exactly.
async function lookupUserId(email) {
  const { data } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
  return data ? data.id : null;
}

async function writeAuditLog({ action, entity_type, entity_id, actor_email, actor_type, risk_level, privacy_category, property_id, details }) {
  const performed_by = await lookupUserId(actor_email);
  const { error } = await supabase.from('audit_log').insert({
    action,
    entity_type,
    entity_id,
    performed_by,
    actor_type: actor_type || 'human',
    actor_id: actor_email,
    privacy_category: privacy_category || 'processing',
    risk_level: risk_level || 'low',
    property_id: property_id || null,
    details: details || {},
  });
  if (error) {
    console.error(`[property-360] audit_log insert failed for ${action}:`, error.message);
    return false;
  }
  return true;
}

// ─── Router: everyone reaching here is already hub-logged-in (server.js
// mounts this after requireLogin) — see file header, "no gate of this
// page itself."
const router = express.Router();

// ─── GET /property-360 — the page shell ─────────────────────────────────
// No server-side access gate here, same convention every other tool's
// page route already follows (insurance/router.js's GET /insurance
// comment: "this is just the static page shell... every route that
// actually returns or changes data below IS gated"). Reads the file and
// injects the hub-wide search widget right after <body>, same
// read-then-string-replace approach every other dashboard uses (no
// templating engine anywhere in this codebase).
router.get('/property-360', (req, res) => {
  fs.readFile(path.join(__dirname, 'dashboard', 'index.html'), 'utf8', (err, html) => {
    if (err) return res.status(500).send('Could not load page.');
    res.send(html.replace('<body>', '<body>\n' + GLOBAL_SEARCH_WIDGET_HTML));
  });
});

// ─── GET /maintenance-history — retired page, now a redirect ──────────
// property-360-SPEC.md, "Where It Lives," retiring the old entry points:
// "The /maintenance-history route itself — should redirect to
// /property-360?property_id= when a property context is available, or
// to the bare /property-360 search-first landing page otherwise, rather
// than 404ing or continuing to serve a half-retired page." Registered
// HERE — not edited in place inside maintenance-history/router.js's own
// `router.get('/maintenance-history', ...)` — and mounted in server.js
// BEFORE maintenanceHistoryRouter. Express runs registered route
// handlers in registration order and stops at the first one that sends
// a response, so this handler always answers an exact `/maintenance-
// history` request first; that other file's own page-shell handler for
// the same path becomes unreachable dead code, left in place rather
// than deleted (see this build's own report for the full reasoning —
// short version: that file isn't this build's to rewrite, and Express's
// own ordering already makes the retirement real without touching it).
//
// Every in-app link now points straight at /property-360?property_id=
// <real id> (lib/global-search-widget.js, updated by this same build) —
// the only realistic way this route is still reached is a stale
// bookmark or an external link carrying the old `?property=<name>` text
// label. Best-effort resolves that label back to a real property id
// against the same `properties` table every other lookup in this Hub
// reads from; falls back to the bare landing page (never a 404, never a
// half-retired page) when nothing resolves.
async function resolvePropertyIdByLabel(label) {
  // Exact (case-insensitive) name/address match first — the widget
  // always sent p.name || p.address verbatim as this label, so an exact
  // match is the common case, not a fallback. .ilike() takes its pattern
  // as a plain parameter value (not embedded in a mini filter-language
  // string the way .or() is), so property names containing a comma,
  // period, colon, or parenthesis need no special escaping here the way
  // lib/property-search.js's own buildIlikeValue has to handle for its
  // .or()-based search.
  const { data: byName, error: byNameErr } = await supabase
    .from('properties').select('id').ilike('name', label).limit(1);
  if (byNameErr) throw byNameErr;
  if (byName && byName[0]) return byName[0].id;

  const { data: byAddress, error: byAddressErr } = await supabase
    .from('properties').select('id').ilike('address', label).limit(1);
  if (byAddressErr) throw byAddressErr;
  if (byAddress && byAddress[0]) return byAddress[0].id;

  // Partial match fallback — a stale/truncated old link still lands
  // somewhere useful rather than falling straight through to the bare
  // landing page.
  const { data: byNamePartial, error: byNamePartialErr } = await supabase
    .from('properties').select('id').ilike('name', `%${label}%`).limit(1);
  if (byNamePartialErr) throw byNamePartialErr;
  if (byNamePartial && byNamePartial[0]) return byNamePartial[0].id;

  const { data: byAddressPartial, error: byAddressPartialErr } = await supabase
    .from('properties').select('id').ilike('address', `%${label}%`).limit(1);
  if (byAddressPartialErr) throw byAddressPartialErr;
  if (byAddressPartial && byAddressPartial[0]) return byAddressPartial[0].id;

  return null;
}

router.get('/maintenance-history', async (req, res) => {
  const label = (req.query.property || '').toString().trim();
  if (!label) return res.redirect('/property-360');
  try {
    const propertyId = await resolvePropertyIdByLabel(label);
    if (propertyId) return res.redirect('/property-360?property_id=' + encodeURIComponent(propertyId));
  } catch (err) {
    console.error('[property-360] legacy /maintenance-history redirect lookup failed:', err.message);
  }
  return res.redirect('/property-360');
});

// ─── GET /api/property-360/:propertyId/summary — the aggregation route ──
router.get('/api/property-360/:propertyId/summary', async (req, res) => {
  const propertyId = req.params.propertyId;
  if (!isValidUuid(propertyId)) {
    return res.status(400).json({ error: 'That property ID is not valid.' });
  }
  // Both param names populated up front — getInsurancePropertySummary and
  // getSecurityDepositPropertySummary read req.params.propertyId,
  // getMaintenanceHistoryPropertySummary reads req.params.property_id
  // (that file's own convention, snake_case, unlike the other two —
  // confirmed by reading each handler, not assumed). Every handler below
  // reads from this one shared req object, so both aliases are set once
  // here rather than per-call.
  req.params.propertyId = propertyId;
  req.params.property_id = propertyId;

  let header;
  try {
    header = await fetchPropertyHeader(propertyId);
  } catch (err) {
    console.error('[property-360] header fetch failed:', err.message);
    return res.status(500).json({ error: 'Could not load this property right now.' });
  }
  if (!header) return res.status(404).json({ error: 'Property not found.' });

  // Usage logging — one row per real page view, once the property is
  // confirmed to exist. Fire-and-forget-adjacent: awaited so a genuine
  // insert failure is visible in logs, but writeAuditLog() itself never
  // throws, so this can't slow down or break the actual page.
  writeAuditLog({
    action: 'property_360.viewed',
    entity_type: 'property',
    entity_id: propertyId,
    actor_email: req.user.email,
    actor_type: 'human',
    risk_level: 'low',
    privacy_category: 'processing',
    property_id: propertyId,
  });

  // ── Access Control — run each tool's own real gate function in-process
  // against this one request. insuranceRouter and securityDepositRouter
  // are both mounted (server.js) BEFORE property360Router with no path
  // prefix, so their own `router.use(attach<Tool>Role)` middleware —
  // exactly like every other tool's — already ran, unconditionally, on
  // EVERY request reaching this point in the chain, this one included;
  // req.insuranceRole/req.securityDepositRole are therefore already set
  // (to a role, or to null — attach<Tool>Role's own first line always
  // assigns one or the other, never leaves the field untouched) by the
  // time this handler runs. Re-running those two here would just be two
  // extra, redundant Supabase round trips for the exact same answer —
  // skipped below. maintenanceHistoryRouter, by contrast, is mounted
  // AFTER property360Router specifically so this router's own
  // `/maintenance-history` redirect above wins (see that route's
  // comment) — which means its global middleware never gets a chance to
  // run before THIS route sends its response, so
  // attachMaintenanceHistoryRole has to be called explicitly here, every
  // time. LeadSimple has no router/middleware position of its own at
  // all, so attachLeadSimpleDelinquencyRole always runs here too. Safe
  // to run whichever of these four actually run in parallel: each is an
  // independent lookup, and every attach<Tool>Role function writes
  // req.teamMemberId to the same (correct, invariant-per-person) value —
  // whichever finishes last "wins" a field that was already going to
  // hold that value, not a real race.
  const gates = [
    runGate(attachMaintenanceHistoryRole, req),
    runGate(attachLeadSimpleDelinquencyRole, req),
    // Archive Search — see file header "ARCHIVE SEARCH" above. Explicit
    // call, not a defensive undefined-check, because archiveSearchRouter
    // mounts AFTER this router (server.js) and its own
    // `router.use(attachArchiveSearchRole)` has not run yet on this
    // request.
    runGate(attachArchiveSearchRole, req),
  ];
  if (typeof req.insuranceRole === 'undefined') gates.push(runGate(attachInsuranceRole, req));
  if (typeof req.securityDepositRole === 'undefined') gates.push(runGate(attachSecurityDepositRole, req));
  // ownerTenantNotesRouter is mounted BEFORE property360Router (server.js)
  // with no path prefix, same as insuranceRouter/securityDepositRouter, so
  // its own `router.use(attachOwnerTenantNotesRole)` already ran on this
  // exact request by the time this handler runs — req.ownerTenantNotesRole
  // is normally already set. Re-run defensively only if it somehow isn't
  // (e.g. mount-order change), same "undefined check" guard already used
  // for insurance/security-deposit above.
  if (typeof req.ownerTenantNotesRole === 'undefined') gates.push(runGate(attachOwnerTenantNotesRole, req));
  await Promise.all(gates);

  // ── Per-card data — property-360-SPEC.md's "Partial-failure handling":
  // every card whose role check passed fetches independently, in
  // parallel, each wrapped in its own try/catch so one failing source
  // never takes the rest of the page down with it. A card the viewer has
  // no role in never gets a fetch attempted at all — the key is simply
  // never set on `cards`, which is what tells the frontend "no access"
  // apart from "no data" (key present, status: 'no_data') and "fetch
  // failed" (key present, status: 'error').
  const cards = {};
  const fetches = [];

  if (req.insuranceRole) {
    fetches.push(
      fetchInsuranceCard(req)
        .then((r) => { cards.insurance = r; })
        .catch((err) => {
          console.error('[property-360] insurance card failed:', err.message);
          cards.insurance = { status: 'error' };
        })
    );
  }
  if (req.securityDepositRole) {
    fetches.push(
      fetchSecurityDepositCard(req)
        .then((r) => { cards.security_deposit = r; })
        .catch((err) => {
          console.error('[property-360] security deposit card failed:', err.message);
          cards.security_deposit = { status: 'error' };
        })
    );
  }
  if (req.maintenanceHistoryRole) {
    fetches.push(
      fetchMaintenanceCard(req)
        .then((r) => { cards.maintenance = r; })
        .catch((err) => {
          console.error('[property-360] maintenance card failed:', err.message);
          cards.maintenance = { status: 'error' };
        })
    );
  }
  // Owner & Tenant Operational Notes — deliberately NOT an async fetch
  // here. This card carries only an access flag; the actual notes are
  // lazy-loaded client-side the first time the collapsible section is
  // opened (same discipline as the Maintenance section's own Snapshot/
  // Needs Privacy Review subsections — see dashboard/index.html's
  // loadMaintenanceSnapshot). Also deliberately excluded from
  // computeNeedsAttentionAndOrder below — see BASE_CARD_ORDER's own
  // comment for why this data must never feed an urgency signal.
  if (ownerTenantNotesRoleHasAnyAccess(req.ownerTenantNotesRole)) {
    cards.owner_tenant_notes = { status: 'ok', data: { role: req.ownerTenantNotesRole } };
  }
  if (LEADSIMPLE_ALLOWED_ROLES.has(req.leadSimpleDelinquencyRole)) {
    fetches.push(
      fetchLeadSimpleCard(propertyId, req.leadSimpleDelinquencyRole)
        .then((r) => { cards.leadsimple = r; })
        .catch((err) => {
          console.error('[property-360] leadsimple card failed:', err.message);
          cards.leadsimple = { status: 'error' };
        })
    );
  }
  await Promise.all(fetches);

  const attention = computeNeedsAttentionAndOrder(cards);

  return res.json({
    property: header.property,
    owner: header.owner,
    has_owner_history_gap: header.has_owner_history_gap,
    occupancy: header.occupancy,
    next_lease_end: header.next_lease_end,
    cards,
    needs_attention: attention.summary ? { summary: attention.summary, items: attention.items } : null,
    card_order: attention.card_order,
    // Admin Users section (property-360-SPEC.md "What You'll See" —
    // "A Maintenance Users section (admin-only)... Visible only to
    // admin"). This is the exact same admin-only role Maintenance
    // History's own /api/maintenance-history/users GET/POST/PATCH/DELETE
    // routes already gate on (requireMaintenanceHistoryRole('admin'),
    // unmodified, still mounted — see this build's own report for why
    // Property 360's Admin section calls that existing API directly
    // instead of a new, duplicate one). This flag just tells the
    // frontend whether to render/call that section at all.
    maintenance_admin: req.maintenanceHistoryRole === 'admin',
    // Archive Search — see file header "ARCHIVE SEARCH" above. A plain
    // access flag, same shape as maintenance_admin: this route carries
    // no search data of its own; the widget calls archive-search's own
    // already-gated routes directly, which independently re-check this
    // exact same role. Real `searcher`/`admin` membership only — never a
    // bypass.
    archive_search_access: ARCHIVE_SEARCH_SEARCH_ROLES.includes(req.archiveSearchRole),
  });
});

module.exports = { router, computeNeedsAttentionAndOrder };
