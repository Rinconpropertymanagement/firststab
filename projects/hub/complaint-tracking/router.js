/**
 * complaint-tracking/router.js
 * Complaint & Issue Tracking — a new Hub tool built against Neo's schema
 * (supabase/migrations/20260910000000_complaint_tracking_schema.sql, NOT
 * yet applied — Peter applies it himself via Supabase's SQL Editor) and
 * Oracle's fully-reviewed technical spec:
 * projects/hub/email-intake/complaint-tracking-technical-spec.md — read it
 * in full before changing anything here, especially "The Ingestion
 * Pipeline," the Design Decisions, and "Open Items." Product-level design:
 * projects/hub/email-intake/complaint-tracking-v1-scope.md.
 *
 * Same shape every other Hub tool uses (call-stats, owner-tenant-notes,
 * maintenance-history): one router file, an internalRouter for the
 * cron-secret-gated pipeline routes, mounted into projects/hub/server.js,
 * reusing the Hub's existing login. Access restricted to 'admin' and
 * 'director_of_operations' for tool='complaint_tracking' only (Design
 * Decision 15) — no tier system, this tool's entire reader population is
 * two people.
 *
 * ============================================================
 * WHAT THIS FILE DOES NOT BUILD (out of scope for this pass, per the task)
 * ============================================================
 *   - The dashboard page (dashboard/index.html) — Tron's job, per
 *     CLAUDE.md's agent roster. Every API route below is built and ready
 *     for that page to call; this pass deliberately ships no HTML, and no
 *     Hub home-page tile (which is itself just markup calling
 *     GET /api/complaint-tracking/home-count, already built below).
 *   - Any cron/scheduled trigger for either internal route. Both are
 *     manually-triggered only (x-cron-secret-gated POST routes, called by
 *     hand), matching Design Decision 16 and the shadow-mode posture in
 *     compliance/complaint-tracking-ai-risk-assessment.md — same posture
 *     email-intake/router.js's own sync route already established.
 *   - The Owner in Distress (LeadSimple) write path for churn_risk
 *     complaints (Open Item 6 — "confirmed as a hard gate": churn-risk
 *     complaints surface via the in-Hub flag only until a
 *     separately-reviewed write-capable module exists). Nothing here calls
 *     LeadSimple at all.
 *
 * ============================================================
 * THE RULE 9 — HOUSING-DECISION FIREWALL (the migration's own header
 * comment, Mason's technical-review Finding 2) — READ BEFORE ADDING ANY
 * NEW QUERY, JOIN, OR EXPORT TO THIS FILE
 * ============================================================
 * Any join from complaints.subject_id / held_legal_fair_housing /
 * flagged_protected_class into a screening, renewal, eviction, or other
 * adverse-action tool requires a fresh Asimov/Mason review before it is
 * ever written — never a silent reuse, not even an existence check. Every
 * query below stays inside this tool's own tables (complaints,
 * complaint_tracking_config), plus read-only existence/display lookups
 * against properties/units/owners/tenants/vendors/team_members, plus the
 * one explicit, one-way, already-reviewed call into
 * owner-tenant-notes/router.js's proposeAINote() (Design Decision 13).
 * Grep this file for 'leadsimple', 'security_deposit', 'leases' (beyond
 * the lease-end view Neo already built) before merging any change — none
 * should appear for a new reason.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const { checkClaim, TIER_B_CLASSIFIER_VERSION } = require('../maintenance-history/lib/content-check');
// CATEGORIES used to come from ./lib/categorize-complaint.js's own
// 6-value complaint-tracking-only enum. That file, and the AI pipeline it
// drove, are retired (archive-search-significance-technical-spec.md v2,
// Section 8) — complaints.category now uses the SAME shared 8-value topic
// taxonomy as missive_conversation_significance.category (the migration's
// own CHECK constraint), so this manual-report validation list must come
// from the same source of truth or it silently rejects every valid new
// category and accepts none of the old ones. Imported from archive-
// search/lib/significance-pass.js (a real cross-tool import — this
// codebase already does this, e.g. this same file's own checkClaim()
// import from maintenance-history/lib/content-check.js) rather than
// duplicated, so the two tables' category lists can never drift apart.
const { TOPIC_CATEGORIES: CATEGORIES } = require('../archive-search/lib/significance-pass');
const { findPossibleDuplicate } = require('./lib/duplicate-check');
const { lookupSingleDirectorOfOperations } = require('./lib/process-pending-messages');
const { GLOBAL_SEARCH_WIDGET_HTML } = require('../lib/global-search-widget');
// Triage redesign build (2026-10): "View original email" link. Reusing
// archive-search/router.js's own missiveConversationLink() by direct
// import, same cross-tool-import precedent as the CATEGORIES line above,
// rather than a second copy of that URL template that could silently
// drift from it (e.g. if the Missive URL shape ever changes again — see
// that function's own comment history). Importing from the router module
// itself (not a lib/ file) is heavier than the CATEGORIES import, but it's
// where the real, only copy of this function lives; module caching means
// this doesn't double-run archive-search/router.js's own setup — it's
// already required once by server.js regardless of load order.
const { missiveConversationLink } = require('../archive-search/router');

// ─── Config ─────────────────────────────────────────────────────────────
const missing = [];
if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
if (missing.length > 0) {
  console.error(`[complaint-tracking] Missing environment variables: ${missing.join(', ')}`);
  console.error('[complaint-tracking] Set these in the shared .env at the project root (see .env.example).');
  process.exit(1);
}
// ANTHROPIC_API_KEY and CRON_SECRET are checked lazily where they're
// actually needed (maintenance-history/lib/content-check.js's own AI
// call, for the manual-report path's checkClaim(); checkCronSecret()
// below) — same reasoning call-stats/router.js gives for AIRCALL_API_ID:
// a missing key for one route shouldn't take down the whole Hub process
// at startup. This file itself no longer makes any AI call directly —
// that logic moved to archive-search/lib/significance-pass.js.

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function isValidUuid(str) {
  return typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// ============================================================
// SECTION 1: Access (Design Decision 15) — binary, two roles, no tiers.
// ============================================================
const COMPLAINT_TRACKING_ALLOWED_ROLES = ['admin', 'director_of_operations'];

async function attachComplaintTrackingRole(req, res, next) {
  req.complaintTrackingRole = null;
  req.teamMemberId = null;
  req.complaintTrackingMemberName = null;

  try {
    const { data: member, error: memberErr } = await supabase
      .from('team_members').select('id, full_name, is_active').eq('auth_user_id', req.user.id).maybeSingle();
    if (memberErr) throw memberErr;
    if (!member || !member.is_active) return next();

    req.teamMemberId = member.id;
    req.complaintTrackingMemberName = member.full_name || null;

    const { data: roleRow, error: roleErr } = await supabase
      .from('team_member_tool_roles').select('role')
      .eq('team_member_id', member.id).eq('tool', 'complaint_tracking').maybeSingle();
    if (roleErr) throw roleErr;
    req.complaintTrackingRole = roleRow ? roleRow.role : null;
    next();
  } catch (err) {
    console.error('[complaint-tracking] permission lookup failed:', err.message);
    next();
  }
}

// Explicit allow-list, never a bare truthy req.complaintTrackingRole — the
// same LeadSimple-precedent discipline every other tool in this codebase
// now follows (owner-tenant-notes/router.js's own comment on this exact
// lesson).
function requireComplaintTrackingAccess(req, res, next) {
  if (!COMPLAINT_TRACKING_ALLOWED_ROLES.includes(req.complaintTrackingRole)) {
    return res.status(403).json({
      error: 'Your Rincon Hub account does not have access to Complaint Tracking. This tool is restricted to Peter and the Director of Operations.',
    });
  }
  next();
}

// Design Decision 9's first gate — any real, active team_members row (any
// real Hub login), independent of holding any role for this tool at all.
// Gates ONLY the manual "Report an issue" route.
function requireActiveTeamMember(req, res, next) {
  if (!req.teamMemberId) {
    return res.status(403).json({ error: 'Your Rincon Hub account is not linked to an active team member record.' });
  }
  next();
}

// ============================================================
// SECTION 2: Audit log — sibling implementation, same reasoning owner-
// tenant-notes/router.js gives for its own copy (not exported from
// anywhere else in this codebase for a router to import).
// ============================================================
async function lookupUserId(email) {
  const { data } = await supabase.from('users').select('id').or(`email.eq.${email},alt_email.eq.${email}`).maybeSingle();
  return data ? data.id : null;
}

async function writeAuditLog({ action, entity_type, entity_id, actor_email, actor_id, actor_type, risk_level, privacy_category, property_id, details }) {
  const performed_by = actor_email ? await lookupUserId(actor_email) : null;
  const { error } = await supabase.from('audit_log').insert({
    action,
    entity_type,
    entity_id,
    performed_by,
    actor_type: actor_type || (actor_email ? 'human' : 'system'),
    actor_id: actor_id || actor_email || 'complaint-tracking',
    privacy_category: privacy_category || 'processing',
    risk_level: risk_level || 'low',
    property_id: property_id || null,
    details: details || {},
  });
  if (error) {
    console.error(`[complaint-tracking] audit_log insert failed for ${action}:`, error.message);
    return false;
  }
  return true;
}

// ============================================================
// SECTION 3: The active versioned-config row (Design Decision 5, Rule 5).
// Small, trivial read — kept as its own copy here rather than importing
// lib/process-pending-messages.js's internal one, same "each router owns
// its own small helpers" convention as writeAuditLog above.
// ============================================================
async function getActiveConfig() {
  const { data, error } = await supabase.from('complaint_tracking_config').select('*').eq('is_active', true).maybeSingle();
  if (error) throw error;
  return data || null;
}

// ============================================================
// SECTION 4: Shared field validation for the manual-report and
// hand-attach-an-orphan routes — subject_type here includes 'team_member'
// (complaints' own real subject model, Design Decision 8), unlike
// operational_notes' validateNoteCoreFields, which this is a sibling of,
// not a copy of.
// ============================================================
async function validateComplaintSubjectFields({ property_id, unit_id, subject_type, subject_id, vendor_id }) {
  if (property_id != null && property_id !== '') {
    if (!isValidUuid(property_id)) return { error: 'property_id must be a valid property ID, or omitted.', status: 400 };
    const { data, error } = await supabase.from('properties').select('id').eq('id', property_id).maybeSingle();
    if (error) return { error: error.message, status: 500 };
    if (!data) return { error: 'Property not found.', status: 404 };
  }
  if (unit_id != null && unit_id !== '') {
    if (!isValidUuid(unit_id)) return { error: 'unit_id must be a valid unit ID, or omitted.', status: 400 };
    let q = supabase.from('units').select('id').eq('id', unit_id);
    if (property_id) q = q.eq('property_id', property_id);
    const { data, error } = await q.maybeSingle();
    if (error) return { error: error.message, status: 500 };
    if (!data) return { error: 'That unit was not found (or does not belong to the given property).', status: 404 };
  }
  if (subject_type != null && subject_type !== '') {
    if (!['owner', 'tenant', 'team_member', 'property'].includes(subject_type)) {
      return { error: "subject_type must be 'owner', 'tenant', 'team_member', or 'property'.", status: 400 };
    }
    if (subject_type === 'property') {
      if (subject_id) return { error: "subject_id must be omitted when subject_type is 'property'.", status: 400 };
    } else {
      if (!subject_id || !isValidUuid(subject_id)) {
        return { error: 'subject_id is required and must be a valid ID for this subject_type.', status: 400 };
      }
      const table = subject_type === 'owner' ? 'owners' : subject_type === 'tenant' ? 'tenants' : 'team_members';
      const { data, error } = await supabase.from(table).select('id').eq('id', subject_id).maybeSingle();
      if (error) return { error: error.message, status: 500 };
      if (!data) return { error: `That ${subject_type.replace('_', ' ')} was not found.`, status: 404 };
    }
  }
  if (vendor_id != null && vendor_id !== '') {
    if (!isValidUuid(vendor_id)) return { error: 'vendor_id must be a valid vendor ID, or omitted.', status: 400 };
    const { data, error } = await supabase.from('vendors').select('id').eq('id', vendor_id).maybeSingle();
    if (error) return { error: error.message, status: 500 };
    if (!data) return { error: 'Vendor not found.', status: 404 };
  }
  return { ok: true };
}

// ============================================================
// SECTION 4b (Tron's addition, frontend pass): display-name enrichment.
// Read-only, no new business logic, no new access rules — GET /api/
// complaint-tracking and GET /api/complaint-tracking/property/:id
// otherwise return bare complaints rows (property_id, vendor_id,
// subject_id, owner_team_member_id, delegated_to_team_member_id,
// possible_duplicate_of_id — all plain UUIDs, none of them joined),
// because Q's own build deliberately shipped API-only (see this file's
// "WHAT THIS FILE DOES NOT BUILD" header). Peter and the DO should never
// have to read a raw UUID off a screen, the same bar every other Hub
// dashboard already holds (Property 360's own p.name/address, owner.name,
// etc.) — this is the minimum lookup work needed to meet that bar, kept
// batched (one .in() query per referenced table, not one per row) and
// fully additive: it only ever adds a new `display` key to each row,
// never changes what the row's own real fields mean or who can see them.
//
// subject_id has no enforced FK (Design Decision 8 — the polymorphic
// owner/tenant/team_member/property pattern), so this is the one place
// PostgREST's own embedded-select syntax can't resolve the join for us;
// resolved here instead, batched by subject_type.
// ============================================================
async function fetchByIds(table, columns, idList) {
  if (!idList.length) return [];
  const { data, error } = await supabase.from(table).select(columns).in('id', idList);
  if (error) {
    console.error(`[complaint-tracking] display-name lookup failed for ${table}:`, error.message);
    return [];
  }
  return data || [];
}

// Triage redesign build (2026-10), Phase 3 item 11 — "Last touched X ago
// by [name]" on the collapsed card face. The complaints row itself already
// has a trigger-maintained updated_at (free — no query needed, see
// row.display.last_touched_at below), but WHO touched it only lives in
// audit_log, and there's no per-row "last_updated_by" column (a real
// schema change, which this additive-reads-only phase was told not to
// make). Getting that cheaply for ~1,000+ visible rows in one list load
// means a single batched, paginated query — same "page through in bounded
// 1000-row chunks" pattern this file's own GET /api/complaint-tracking
// route already uses for the same PostgREST row-cap reason (see that
// route's own comment) — rather than one query per card (an N+1 that
// would mean a thousand+ requests on every dashboard load).
// Capped at MAX_PAGES purely as a safety valve against paging through
// this tool's entire audit history for one list load if some id is
// somehow never covered; in practice every complaint gets a
// 'complaint_tracking.created' row at insert (both the manual-report path
// above and significance-pass.js's own complaint-creation path write one),
// so ordering newest-first and stopping once every id has at least one
// hit converges fast. Any id left uncovered when the cap is hit just gets
// no last_touched info — same "log, don't throw, show the row anyway"
// discipline as attachDisplayInfo's own enrichment lookups.
async function attachLastTouchedInfo(rows) {
  if (!rows || !rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 10;
  const latestByEntity = new Map();

  try {
    for (let page = 0; page < MAX_PAGES && latestByEntity.size < ids.length; page += 1) {
      const from = page * PAGE_SIZE;
      const { data, error } = await supabase
        .from('audit_log')
        .select('entity_id, actor_type, actor_id, created_at')
        .eq('entity_type', 'complaint')
        .in('entity_id', ids)
        .order('created_at', { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      for (const row of data || []) {
        if (!latestByEntity.has(row.entity_id)) latestByEntity.set(row.entity_id, row);
      }
      if (!data || data.length < PAGE_SIZE) break;
    }
  } catch (err) {
    console.error('[complaint-tracking] last-touched lookup failed (showing rows without it):', err.message);
    return rows;
  }

  // actor_id holds the acting human's email for a 'human' action (see
  // writeAuditLog's own actor_id fallback: actor_id || actor_email) — look
  // those up against team_members for a real name instead of a raw email.
  // team_members.email is stored lowercased (shared_team_members schema's
  // own CHECK); lowercase the comparison so case differences from whatever
  // auth handed us as req.user.email don't silently miss a match.
  const emails = [...new Set(
    [...latestByEntity.values()]
      .filter((r) => r.actor_type === 'human' && r.actor_id && r.actor_id.includes('@'))
      .map((r) => r.actor_id.toLowerCase())
  )];
  let nameByEmail = new Map();
  if (emails.length) {
    const { data: matched, error } = await supabase.from('team_members').select('full_name, email').in('email', emails);
    if (!error) nameByEmail = new Map((matched || []).map((m) => [m.email, m.full_name || m.email]));
  }

  for (const row of rows) {
    const latest = latestByEntity.get(row.id);
    if (!latest) continue;
    const by = latest.actor_type === 'system'
      ? 'System'
      : (nameByEmail.get((latest.actor_id || '').toLowerCase()) || latest.actor_id || 'Unknown');
    row.display = row.display || {};
    row.display.last_touched = { at: latest.created_at, by };
  }
  return rows;
}

async function attachDisplayInfo(rows) {
  if (!rows || !rows.length) return rows;

  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  const propertyIds = uniq(rows.map((r) => r.property_id));
  const unitIds = uniq(rows.map((r) => r.unit_id));
  const vendorIds = uniq(rows.map((r) => r.vendor_id));
  const teamMemberIds = uniq([
    ...rows.map((r) => r.owner_team_member_id),
    ...rows.map((r) => r.delegated_to_team_member_id),
    ...rows.map((r) => r.reported_by_team_member_id),
  ]);
  // Name-match suggestion candidates (migration 20261002060000) — merged
  // into the SAME owner/tenant id lists already fetched below (fetchByIds
  // dedupes via .in(), so adding these costs nothing extra) rather than a
  // third round-trip. A pending suggestion's own candidate_ids are UUIDs
  // into tenants.id | owners.id, per suggested_subject_type — same table,
  // same shape as a real subject_id, just not yet confirmed as one.
  const suggestedTenantCandidateIds = rows
    .filter((r) => r.suggested_subject_type === 'tenant' && r.suggested_subject_candidate_ids)
    .flatMap((r) => r.suggested_subject_candidate_ids);
  const suggestedOwnerCandidateIds = rows
    .filter((r) => r.suggested_subject_type === 'owner' && r.suggested_subject_candidate_ids)
    .flatMap((r) => r.suggested_subject_candidate_ids);
  const ownerIds = uniq([...rows.filter((r) => r.subject_type === 'owner').map((r) => r.subject_id), ...suggestedOwnerCandidateIds]);
  const tenantIds = uniq([...rows.filter((r) => r.subject_type === 'tenant').map((r) => r.subject_id), ...suggestedTenantCandidateIds]);
  const teamMemberSubjectIds = uniq(rows.filter((r) => r.subject_type === 'team_member').map((r) => r.subject_id));
  const dupIds = uniq(rows.map((r) => r.possible_duplicate_of_id));

  let properties = [], units = [], vendors = [], teamMembers = [], owners = [], tenants = [], teamMemberSubjects = [], duplicates = [];
  try {
    [properties, units, vendors, teamMembers, owners, tenants, teamMemberSubjects, duplicates] = await Promise.all([
      fetchByIds('properties', 'id, name, address, city', propertyIds),
      fetchByIds('units', 'id, unit_number', unitIds),
      fetchByIds('vendors', 'id, company_name', vendorIds),
      fetchByIds('team_members', 'id, full_name, email', teamMemberIds),
      fetchByIds('owners', 'id, name', ownerIds),
      fetchByIds('tenants', 'id, first_name, last_name', tenantIds),
      fetchByIds('team_members', 'id, full_name, email', teamMemberSubjectIds),
      fetchByIds('complaints', 'id, description, category, status, created_at', dupIds),
    ]);
  } catch (err) {
    // Never let a display-only lookup break the actual list — rows still
    // come back, just without resolved names, same "log, don't throw"
    // discipline as every other non-critical enrichment in this codebase.
    console.error('[complaint-tracking] display-info enrichment failed (showing rows without resolved names):', err.message);
  }

  const mapOf = (arr) => new Map(arr.map((x) => [x.id, x]));
  const propertyMap = mapOf(properties), unitMap = mapOf(units), vendorMap = mapOf(vendors),
    teamMemberMap = mapOf(teamMembers), ownerMap = mapOf(owners), tenantMap = mapOf(tenants),
    teamMemberSubjectMap = mapOf(teamMemberSubjects), duplicateMap = mapOf(duplicates);

  function teamMemberLabel(map, id) {
    if (!id) return null;
    const m = map.get(id);
    return m ? (m.full_name || m.email) : null;
  }

  for (const row of rows) {
    const property = row.property_id ? propertyMap.get(row.property_id) : null;
    const dup = row.possible_duplicate_of_id ? duplicateMap.get(row.possible_duplicate_of_id) : null;
    let subjectName = null;
    if (row.subject_type === 'owner') {
      subjectName = row.subject_id ? (ownerMap.get(row.subject_id)?.name || null) : null;
    } else if (row.subject_type === 'tenant') {
      const t = row.subject_id ? tenantMap.get(row.subject_id) : null;
      subjectName = t ? ([t.first_name, t.last_name].filter(Boolean).join(' ') || null) : null;
    } else if (row.subject_type === 'team_member') {
      subjectName = teamMemberLabel(teamMemberSubjectMap, row.subject_id);
    }

    // Name-match suggestion candidates, resolved to real display names —
    // Mason's point 1, the whole reason this build exists: "the human step
    // only earns its risk-reduction if the review surface actively exposes
    // the collision... so the reviewer is disambiguating with real
    // information, not just agreeing with a guess." Every candidate here
    // was ALREADY scoped by findNameMatchCandidates() (significance-
    // pass.js) to tenants/owners AT this row's own property_id — so by
    // construction every candidate in this list shares the SAME property
    // already shown above as `property`; there is no separate per-
    // candidate property to resolve or show.
    let nameMatchCandidates = null;
    if (row.suggested_subject_type && row.suggested_subject_candidate_ids) {
      const candidateMap = row.suggested_subject_type === 'owner' ? ownerMap : tenantMap;
      nameMatchCandidates = row.suggested_subject_candidate_ids.map((id) => {
        const person = candidateMap.get(id);
        let name = null;
        if (person) {
          name = row.suggested_subject_type === 'owner' ? person.name : [person.first_name, person.last_name].filter(Boolean).join(' ');
        }
        return { id, name: name || 'Unknown' };
      });
    }

    row.display = {
      property: property ? { name: property.name, address: property.address, city: property.city } : null,
      unit_number: row.unit_id ? (unitMap.get(row.unit_id)?.unit_number || null) : null,
      vendor_name: row.vendor_id ? (vendorMap.get(row.vendor_id)?.company_name || null) : null,
      subject_name: subjectName,
      name_match_candidates: nameMatchCandidates,
      owner_team_member_name: teamMemberLabel(teamMemberMap, row.owner_team_member_id),
      delegated_team_member_name: teamMemberLabel(teamMemberMap, row.delegated_to_team_member_id),
      reported_by_name: teamMemberLabel(teamMemberMap, row.reported_by_team_member_id),
      possible_duplicate: dup ? { description: dup.description, category: dup.category, status: dup.status, created_at: dup.created_at } : null,
      // Triage redesign build (2026-10) — "View original email" (Phase 2
      // item 8). Every row with a source_missive_conversation_id gets a
      // real, working link; rows with none (e.g. a manual_staff report)
      // get null, same "null means not applicable" convention every other
      // display{} field above already uses.
      missive_link: row.source_missive_conversation_id ? missiveConversationLink(row.source_missive_conversation_id) : null,
    };
  }
  // Phase 3 item 11 ("Last touched X ago by [name]") — a second, separate
  // batched pass (its own audit_log query, not foldable into the
  // Promise.all above since it depends on knowing every row's id, not a
  // fixed set of foreign-key ids) — see attachLastTouchedInfo's own header
  // for why this is one batched query rather than one per row.
  await attachLastTouchedInfo(rows);
  return rows;
}

// ============================================================
// SECTION 5: Router — everyone reaching here is already Hub-logged-in.
// ============================================================
const router = express.Router();
router.use(attachComplaintTrackingRole);

// ─── GET /complaint-tracking, GET /complaint-tracking/report — the two
// page shells (Tron's pass). Same "read the file, inject the shared
// search widget, send" approach every other tool's own page route already
// uses (e.g. call-stats/router.js's GET /call-stats) — no access check on
// the page route itself in either case, matching that same precedent:
// the central dashboard's real content is gated client-side via the
// GET /api/complaint-tracking/auth/me 403 handled below (Design Decision
// 9/15 — binary, two roles); the report form is gated to any active team
// member at the API layer only (requireActiveTeamMember on the POST
// route above), since the product doc's own access model is explicit
// that "any team member with a real Hub login... can open a simple,
// separate 'Report an issue' form" — no complaint_tracking role required
// to even load it. The report page skips the global search widget
// (GLOBAL_SEARCH_WIDGET_HTML) on purpose — it's a single-purpose, fast,
// mobile-first form for someone in the field, not a property-browsing
// tool, and every other tool's dashboard already carries that widget.
// ============================================================
router.get('/complaint-tracking', (req, res) => {
  fs.readFile(path.join(__dirname, 'dashboard', 'index.html'), 'utf8', (err, html) => {
    if (err) return res.status(500).send('Could not load page.');
    res.send(html.replace('<body>', '<body>\n' + GLOBAL_SEARCH_WIDGET_HTML));
  });
});

router.get('/complaint-tracking/report', (req, res) => {
  fs.readFile(path.join(__dirname, 'dashboard', 'report.html'), 'utf8', (err, html) => {
    if (err) return res.status(500).send('Could not load page.');
    res.send(html);
  });
});

router.get('/api/complaint-tracking/auth/me', requireComplaintTrackingAccess, (req, res) => {
  res.json({
    email: req.user.email,
    name: req.complaintTrackingMemberName || req.user.email,
    role: req.complaintTrackingRole,
  });
});

// ─── GET /api/complaint-tracking/team-members, GET /api/complaint-tracking/
// vendors — Tron's pass, two small read-only directory routes. Neither
// existed anywhere reusable in this Hub: every other tool's own
// GET /api/<tool>/users route lists role-GRANTS for that one tool (who
// currently holds a role here), not a plain "every active team member"
// directory — the wrong shape for a delegate-to-teammate picker, which
// needs to offer anyone active, not just the ~2 people who already hold
// a complaint_tracking role. Gated the same as every other route in this
// file (requireComplaintTrackingAccess) — no new access surface, just a
// name list for the two people who can already see every complaint's raw
// owner_team_member_id/delegated_to_team_member_id/vendor_id anyway.
// ============================================================
router.get('/api/complaint-tracking/team-members', requireComplaintTrackingAccess, async (req, res) => {
  const { data, error } = await supabase
    .from('team_members').select('id, full_name, email').eq('is_active', true).order('full_name', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ team_members: data || [] });
});

router.get('/api/complaint-tracking/vendors', requireComplaintTrackingAccess, async (req, res) => {
  const { data, error } = await supabase
    .from('vendors').select('id, company_name').eq('is_active', true).order('company_name', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ vendors: data || [] });
});

// ─── POST /api/complaint-tracking/report — the manual "Report an issue"
// path (Design Decision 9, product doc Section 4/5). requireActiveTeamMember
// only — any real Hub login, no complaint_tracking role required. Runs the
// exact same content check and duplicate-detection discipline the email
// pipeline does (Design Decision 2's "no second sibling implementation,"
// Neo's fix 2 — "manual or email_ai alike"), just with Layer 2 (the
// model's own self-report) inapplicable — no model reads a manual report
// before a human types it, so modelFlag stays false and only Layer 1
// (keyword scan) runs, same reasoning note-content-check.js's
// checkManualNoteContent gives for its own manual path.
router.post('/api/complaint-tracking/report', requireActiveTeamMember, async (req, res) => {
  const { description, property_id, unit_id, subject_type, subject_id, vendor_id, category, blocked_reason, blocked_party } = req.body;

  if (typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ error: 'description is required.' });
  }
  if (category != null && category !== '' && !CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}, or omitted.` });
  }
  // KNOWN GAP, flagged explicitly rather than silently left — not fixed
  // here, out of scope for a backend-only build (no UI phase). Under the
  // OLD 6-value enum, 'blocked_resolution' was a real category value, so
  // this branch was reachable. Under the NEW shared 8-value taxonomy
  // (CATEGORIES above), 'blocked_resolution' is an escalation_signal
  // value, never a category — the migration's own
  // complaints_blocked_requires_reason CHECK now keys on escalation_
  // signal, not category (see that constraint's own "Pre-existing typo,
  // fixed here" comment in the migration). This branch is therefore
  // permanently unreachable post-migration (category can never equal
  // 'blocked_resolution' — the validation above already rejects it with
  // a 400), which is harmless dead code, not a crash risk — but it means
  // a staff member using the manual "Report an issue" form has no way to
  // set escalation_signal at all today. Giving that form its own
  // escalation_signal field is a real, addressable product/UI gap for a
  // future pass (Tron's territory), not decided here.
  if (category === 'blocked_resolution') {
    if (!['explicit_refusal', 'inferred_from_silence'].includes(blocked_reason)) {
      return res.status(400).json({ error: "blocked_reason is required and must be 'explicit_refusal' or 'inferred_from_silence' when category is 'blocked_resolution'." });
    }
    if (!['owner', 'tenant'].includes(blocked_party)) {
      return res.status(400).json({ error: "blocked_party is required and must be 'owner' or 'tenant' when category is 'blocked_resolution'." });
    }
  }

  const validation = await validateComplaintSubjectFields({ property_id, unit_id, subject_type, subject_id, vendor_id });
  if (!validation.ok) return res.status(validation.status).json({ error: validation.error });

  let activeConfig;
  try {
    activeConfig = await getActiveConfig();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!activeConfig) return res.status(500).json({ error: 'No active complaint_tracking_config row is set up yet.' });

  let contentCheck;
  try {
    contentCheck = await checkClaim({ claim_text: description.trim(), modelFlag: false, modelCategory: null });
  } catch (err) {
    console.error('[complaint-tracking] content check failed for manual report:', err.message);
    return res.status(500).json({ error: 'Could not complete the content check for this report. Please try again.' });
  }

  const resolvedSubjectType = subject_type || null;
  const resolvedSubjectId = resolvedSubjectType === 'property' ? null : (subject_id || null);
  const needs_matching = !property_id && !resolvedSubjectType && !vendor_id;

  let duplicate = null;
  if (resolvedSubjectType && resolvedSubjectId) {
    try {
      duplicate = await findPossibleDuplicate(supabase, {
        property_id: property_id || null, subject_type: resolvedSubjectType, subject_id: resolvedSubjectId,
        windowDays: activeConfig.duplicate_window_days,
      });
    } catch (err) {
      console.error('[complaint-tracking] duplicate check failed for manual report:', err.message);
    }
  }

  const insertRow = {
    property_id: property_id || null,
    unit_id: unit_id || null,
    vendor_id: vendor_id || null,
    subject_type: resolvedSubjectType,
    subject_id: resolvedSubjectId,
    needs_matching,
    category: category || null,
    needs_human_call: false, // "needs a human call" is specifically the AI's own uncertainty flag — doesn't apply to a human-authored report
    held_legal_fair_housing: false, // manual reports never use the held/placeholder path — a human already typed this, there is nothing for the hold check to shield
    description: description.trim(),
    blocked_reason: category === 'blocked_resolution' ? blocked_reason : null,
    blocked_party: category === 'blocked_resolution' ? blocked_party : null,
    // No message-date history to anchor to on a manual report (unlike the
    // email path's "the most recent message's own date" — Design Decision
    // 4) — the moment of the report itself is the only real anchor
    // available, so that's what's used.
    blocked_since: category === 'blocked_resolution' ? new Date().toISOString() : null,
    flagged_protected_class: contentCheck.flagged_protected_class,
    flagged_category: contentCheck.flagged_category,
    status: 'open',
    source: 'manual_staff',
    // Real bug, found live 2026-09-29 (Peter's first real test of this
    // form): discovery_context is NOT NULL with only 'live_pipeline' and
    // 'historical_backfill' legal (added later, by the significance-pass
    // engine-swap migration, for the two AI-scan sources) — this manual
    // path was never updated when that column was added, so every
    // submission failed. 'manual_staff' reuses the exact name `source`
    // above already uses for this same case — see
    // supabase/migrations/20260929010000_add_manual_staff_to_complaints_
    // discovery_context_check.sql for the constraint widening this
    // requires (additive only, cannot affect any existing row).
    discovery_context: 'manual_staff',
    reported_by_team_member_id: req.teamMemberId,
    extracted_by: null,
    complaint_tracking_config_id: activeConfig.id,
    possible_duplicate_of_id: duplicate ? duplicate.id : null,
    duplicate_status: duplicate ? 'suggested' : 'none',
  };

  // Design Decision 12 — a big-deal complaint's owner is the DO. A manual
  // report becomes "big deal" only if the reporting staff member picked a
  // category outright (needs_human_call is never true for a manual report).
  if (insertRow.category) {
    const doLookup = await lookupSingleDirectorOfOperations();
    if (doLookup.ok) insertRow.owner_team_member_id = doLookup.teamMemberId;
  }

  const { data: inserted, error: insertErr } = await supabase.from('complaints').insert(insertRow).select().single();
  if (insertErr) return res.status(500).json({ error: insertErr.message });

  await writeAuditLog({
    action: 'complaint_tracking.created', entity_type: 'complaint', entity_id: inserted.id,
    actor_email: req.user.email, property_id: inserted.property_id, risk_level: 'low', privacy_category: 'collection',
    details: { category: inserted.category, reported_by_team_member_id: req.teamMemberId },
  });

  if (contentCheck.flagged_protected_class) {
    await writeAuditLog({
      action: 'complaint_tracking.protected_class_flagged', entity_type: 'complaint', entity_id: inserted.id,
      // Design Decision 11's table: "system (keyword) or ai_agent (Tier B /
      // Layer 2)" — Tier A alone (a pure keyword hit, no AI call at all) is
      // the only 'system' case. Tier B fires its own classifier call
      // (tier-b-classifier.js) even on a manual report where Layer 2 never
      // applies — so 'keyword_tier_b_confirmed' is still 'ai_agent', not
      // 'system'. A plain startsWith('keyword') check would wrongly bucket
      // Tier B with Tier A; this checks the exact Tier-A-only value instead.
      actor_type: contentCheck.matched_layer === 'keyword_tier_a' ? 'system' : 'ai_agent',
      property_id: inserted.property_id, risk_level: 'high', privacy_category: 'processing',
      details: {
        flagged_category: contentCheck.flagged_category, matched_layer: contentCheck.matched_layer,
        terms_version: contentCheck.terms_version,
        tier_b_classifier_version: (contentCheck.tier_b_results || []).length ? TIER_B_CLASSIFIER_VERSION : null,
      },
    });
  }
  if (duplicate) {
    await writeAuditLog({
      action: 'complaint_tracking.duplicate_suggested', entity_type: 'complaint', entity_id: inserted.id,
      actor_type: 'system', property_id: inserted.property_id, risk_level: 'low', privacy_category: 'processing',
      details: { possible_duplicate_of_id: duplicate.id },
    });
  }

  // Design Decision 9 — a bare acknowledgment only, never a resource the
  // submitter can query again (no GET route their own role could reach).
  return res.json({ success: true, id: inserted.id });
});

// ─── GET /api/complaint-tracking — the full filtered list (product doc
// Section 5: "filterable by property, team member, category, status").
// Returns is_big_deal per row (a real, generated column) so the dashboard
// splits big-deal-up-top vs. routine-behind-a-dropdown without re-deriving
// that logic client-side.
//
// Real bug, found live 2026-10-02 (Peter noticed the dashboard stop at
// exactly 1,000 rows once the historical backlog clear pushed the real
// count to 2,733): a single unpaginated .select() silently caps at
// Supabase/PostgREST's own default max-rows (1000), same gotcha this
// project has already hit twice elsewhere (fetchIncompleteSignificanceRows,
// significance-batch.js). The "single query, no pagination" design this
// comment used to describe was an accepted limitation ONLY while real
// volume stayed under 1000 — it silently started dropping rows the moment
// it didn't, with no error, no truncation notice, nothing. Fixed by paging
// through every 1000-row chunk server-side and concatenating — the
// response shape to the dashboard is unchanged (still every matching row,
// in one response), so no client-side change is needed.
// `include_no_issue=true` — the "admin-only way to see No-Issue rows for
// audit purposes" the severity-tier build task asks for. Deliberately NOT
// a new access tier: Design Decision 15 ("binary, two roles, no tiers",
// SECTION 1 above) already settled that question for this tool, and both
// roles requireComplaintTrackingAccess allows (admin, director_of_operations)
// are the only humans who can reach this route at all — so gating the
// toggle on "already has Complaint Tracking access" satisfies "admin-only"
// without reopening that design decision for one filter flag. Default
// (flag omitted/false) excludes severity_tier = 'no_issue' rows — per the
// build task, a No Issue row is correctly classified as not belonging in
// this tool's default view at all, not merely a low-priority lane.
// severity_tier IS NULL (not yet assessed — true for every row until the
// retroactive batch tool runs) is NEVER excluded either way: unassessed
// rows must keep behaving exactly as they do today, per the build task's
// own explicit instruction. Written as `.or('severity_tier.is.null,
// severity_tier.neq.no_issue')`, not a bare `.neq()`, because Postgres's
// own NULL semantics make `severity_tier <> 'no_issue'` evaluate to UNKNOWN
// (excluded) for a NULL row — the explicit `.is.null` branch is what keeps
// unassessed rows visible, mirroring the DB's own partial index
// (idx_complaints_severity_visible, migration 20261002010000) which uses
// the identical "IS DISTINCT FROM" idiom for the same reason.
router.get('/api/complaint-tracking', requireComplaintTrackingAccess, async (req, res) => {
  const { property_id, subject_type, subject_id, category, status, owner_team_member_id, q, include_no_issue } = req.query;

  if (property_id && !isValidUuid(property_id)) return res.status(400).json({ error: 'property_id is not valid.' });
  if (subject_id && !isValidUuid(subject_id)) return res.status(400).json({ error: 'subject_id is not valid.' });
  if (owner_team_member_id && !isValidUuid(owner_team_member_id)) return res.status(400).json({ error: 'owner_team_member_id is not valid.' });

  let query = supabase.from('complaints').select('*').order('created_at', { ascending: false });
  if (property_id) query = query.eq('property_id', property_id);
  if (subject_type) query = query.eq('subject_type', subject_type);
  if (subject_id) query = query.eq('subject_id', subject_id);
  if (category) query = query.eq('category', category);
  if (status) query = query.eq('status', status);
  if (owner_team_member_id) query = query.eq('owner_team_member_id', owner_team_member_id);
  if (q && typeof q === 'string' && q.trim()) query = query.ilike('description', `%${q.trim()}%`);
  if (include_no_issue !== 'true') query = query.or('severity_tier.is.null,severity_tier.neq.no_issue');

  const PAGE_SIZE = 1000;
  let allRows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1);
    if (error) return res.status(500).json({ error: error.message });
    allRows = allRows.concat(data || []);
    if (!data || data.length < PAGE_SIZE) break;
  }
  res.json({ complaints: await attachDisplayInfo(allRows) });
});

// ─── GET /api/complaint-tracking/home-count — the Hub home-page tile
// (Design Decision 14's complaints_needing_attention view already excludes
// resolved/merged/lease-ended rows — every reader of this count agrees by
// construction with every other reader, per that view's own header).
//
// discovery_context = 'live_pipeline' filter ADDED here — archive-search-
// significance-technical-spec.md (v2) Section 6's hard gate: "the home-
// page red-count tile... None of these may ever consider a historical_
// backfill row." This view predates that column and doesn't filter on it
// itself (it can't — discovery_context lives on complaints, which the
// view already selects from, but the view's own WHERE clause was written
// before this merge existed). Without this fix, the one-time historical
// backfill (archive-search/lib/significance-pass.js) would inflate this
// live-operational tile with thousands of old findings the moment it ran
// — exactly the failure mode Section 6 exists to prevent. Found and fixed
// while building that pass, not a pre-existing bug report.
//
// FLAGGED, NOT FIXED, 2026-10-02: the severity-tier build task asks for a
// `severity_tier IS DISTINCT FROM 'no_issue'` filter here AND on Property
// 360 (GET /api/complaint-tracking/property/:property_id, just below) —
// both read complaints_needing_attention, not `complaints` directly. This
// view was created with `SELECT c.*` (supabase/migrations/20260910000000,
// re-issued unchanged by 20260913020000) — in Postgres, `*` is expanded
// into an explicit column list AT THE MOMENT the view is created/replaced,
// not live-resolved on every read. A plain `ALTER TABLE complaints ADD
// COLUMN severity_tier ...` (20261002010000) does NOT make severity_tier
// selectable through this view — confirmed against Postgres's own
// documented view-expansion behavior, not assumed. Adding `.or(...)` on
// severity_tier here today would make BOTH routes throw (column does not
// exist on complaints_needing_attention), not silently no-op. Fixing this
// needs a new Neo migration that re-issues `CREATE OR REPLACE VIEW
// complaints_needing_attention AS SELECT c.* FROM complaints c WHERE ...`
// (every existing WHERE clause, plus the new severity_tier exclusion) —
// a schema change, not a router.js change, so it's flagged here for Jarvis
// to route to Neo rather than worked around in application code. Until
// that migration exists and is applied, these two routes are correctly
// left unchanged — they already behave exactly as they do today, with no
// regression either way.
router.get('/api/complaint-tracking/home-count', requireComplaintTrackingAccess, async (req, res) => {
  const { count, error } = await supabase
    .from('complaints_needing_attention').select('id', { count: 'exact', head: true }).eq('discovery_context', 'live_pipeline');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ count: count || 0 });
});

// ─── GET /api/complaint-tracking/property/:property_id — Property 360
// surfacing, big-deal items only, full stop (product doc Section 2: "not
// even collapsed behind a toggle").
router.get('/api/complaint-tracking/property/:property_id', requireComplaintTrackingAccess, async (req, res) => {
  if (!isValidUuid(req.params.property_id)) return res.status(400).json({ error: 'That property ID is not valid.' });
  const { data, error } = await supabase
    .from('complaints_needing_attention').select('*').eq('property_id', req.params.property_id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ complaints: await attachDisplayInfo(data || []) });
});

// ─── POST /api/complaint-tracking/:id/stage — lifecycle transitions
// (product doc Section 4, Design Decision 11). A held placeholder never
// transitions here — it has its own dedicated closure route below.
router.post('/api/complaint-tracking/:id/stage', requireComplaintTrackingAccess, async (req, res) => {
  if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'That id is not valid.' });
  const { to_status, note } = req.body;
  if (!['open', 'in_progress', 'blocked', 'resolved'].includes(to_status)) {
    return res.status(400).json({ error: "to_status must be 'open', 'in_progress', 'blocked', or 'resolved'." });
  }

  const { data: before, error: beforeErr } = await supabase
    .from('complaints').select('id, status, property_id').eq('id', req.params.id).maybeSingle();
  if (beforeErr) return res.status(500).json({ error: beforeErr.message });
  if (!before) return res.status(404).json({ error: 'Complaint not found.' });
  if (before.status === 'held') {
    return res.status(409).json({ error: 'A held Legal/Fair Housing placeholder can only be closed via the held-closure route, not a general stage change.' });
  }

  // "Every stage change gets logged... and (for anything other than a
  // straight Open -> In Progress) a short note on why" — product doc
  // Section 4, encoded structurally here, not left to a UI convention.
  const isStraightOpenToInProgress = before.status === 'open' && to_status === 'in_progress';
  if ((!isStraightOpenToInProgress || to_status === 'resolved') && (typeof note !== 'string' || !note.trim())) {
    return res.status(400).json({
      error: to_status === 'resolved'
        ? 'A resolution note describing what was done is required to mark a complaint resolved.'
        : 'A short note explaining why is required for any stage change other than Open to In Progress.',
    });
  }

  const updates = { status: to_status };
  if (to_status === 'resolved') updates.resolution_note = note.trim();

  const { data: updated, error: updateErr } = await supabase.from('complaints').update(updates).eq('id', req.params.id).select().single();
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  await writeAuditLog({
    action: 'complaint_tracking.stage_changed', entity_type: 'complaint', entity_id: req.params.id,
    actor_email: req.user.email, property_id: before.property_id,
    risk_level: to_status === 'blocked' ? 'medium' : 'low',
    details: { from_status: before.status, to_status, reason: note || null, actor_role: req.complaintTrackingRole },
  });

  res.json({ success: true, complaint: updated });
});

// ─── GET /api/complaint-tracking/:id/history — triage redesign build
// (2026-10), Phase 3 item 9. Purely additive read of audit_log, which
// already gets a row on every stage change, delegation, duplicate
// decision, and held-item closure (writeAuditLog() calls throughout this
// file) — there was simply no route reading any of it back until now.
// Newest-first, capped at the last 20 events per the task's own spec (this
// is a human-facing timeline, not an export/compliance tool — Rule 10's
// full-history CCPA/export paths are unrelated and untouched).
router.get('/api/complaint-tracking/:id/history', requireComplaintTrackingAccess, async (req, res) => {
  if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'That id is not valid.' });

  const { data, error } = await supabase
    .from('audit_log')
    .select('id, action, actor_type, actor_id, details, created_at')
    .eq('entity_type', 'complaint').eq('entity_id', req.params.id)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) return res.status(500).json({ error: error.message });

  // actor_id is the acting human's email for a 'human' action (writeAuditLog's
  // own actor_id fallback) — resolved to a real name the same way
  // attachLastTouchedInfo does, for the same reason (a raw email in a
  // staff-facing timeline is a worse read than a name when one's available).
  const emails = [...new Set(
    (data || [])
      .filter((r) => r.actor_type === 'human' && r.actor_id && r.actor_id.includes('@'))
      .map((r) => r.actor_id.toLowerCase())
  )];
  let nameByEmail = new Map();
  if (emails.length) {
    const { data: members, error: memberErr } = await supabase.from('team_members').select('full_name, email').in('email', emails);
    if (!memberErr) nameByEmail = new Map((members || []).map((m) => [m.email, m.full_name || m.email]));
  }

  const events = (data || []).map((r) => ({
    id: r.id,
    action: r.action,
    actor_type: r.actor_type,
    actor: r.actor_type === 'system' ? 'System' : (nameByEmail.get((r.actor_id || '').toLowerCase()) || r.actor_id || 'Unknown'),
    // "Note where present" (task spec) — every writeAuditLog() call site in
    // this file that carries a human-written note puts it in
    // details.reason (stage changes, held closures) or details.disposition_notes
    // (CCPA held disposition); neither key is ever set on the same row, so
    // this is a safe single fallback, not a guess between two live values.
    note: (r.details && (r.details.reason || r.details.disposition_notes)) || null,
    created_at: r.created_at,
  }));

  res.json({ events });
});

// ─── POST /api/complaint-tracking/:id/delegate — DO stays accountable
// (owner_team_member_id untouched); this only changes who's doing the work
// (product doc Section 4).
router.post('/api/complaint-tracking/:id/delegate', requireComplaintTrackingAccess, async (req, res) => {
  if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'That id is not valid.' });
  const { delegated_to_team_member_id } = req.body;
  if (!isValidUuid(delegated_to_team_member_id)) {
    return res.status(400).json({ error: 'delegated_to_team_member_id is required and must be a valid team member id.' });
  }

  const { data: member, error: memberErr } = await supabase
    .from('team_members').select('id, is_active').eq('id', delegated_to_team_member_id).maybeSingle();
  if (memberErr) return res.status(500).json({ error: memberErr.message });
  if (!member || !member.is_active) return res.status(400).json({ error: 'delegated_to_team_member_id must be a real, active team member.' });

  const { data: before, error: beforeErr } = await supabase
    .from('complaints').select('id, property_id').eq('id', req.params.id).maybeSingle();
  if (beforeErr) return res.status(500).json({ error: beforeErr.message });
  if (!before) return res.status(404).json({ error: 'Complaint not found.' });

  const { data: updated, error: updateErr } = await supabase
    .from('complaints').update({ delegated_to_team_member_id }).eq('id', req.params.id).select().single();
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  await writeAuditLog({
    action: 'complaint_tracking.delegated', entity_type: 'complaint', entity_id: req.params.id,
    actor_email: req.user.email, property_id: before.property_id, risk_level: 'low',
    details: { delegated_to_team_member_id, actor_role: req.complaintTrackingRole },
  });

  res.json({ success: true, complaint: updated });
});

// ─── POST /api/complaint-tracking/:id/match — attach an orphan
// (needs_matching = TRUE) record by hand (product doc Section 4: "a person
// can attach it to the right property/person by hand later"). Not a
// literal Design Decision 11 audit action — 'complaint_tracking.matched'
// is this build's own small, documented extension of that table's spirit
// (Rule 1 still requires this decision be logged), reusing no other
// action's name so it isn't mistaken for a stage or duplicate event.
router.post('/api/complaint-tracking/:id/match', requireComplaintTrackingAccess, async (req, res) => {
  if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'That id is not valid.' });
  const { property_id, unit_id, subject_type, subject_id, vendor_id } = req.body;

  if (!property_id && !subject_type && !vendor_id) {
    return res.status(400).json({ error: 'Provide at least a property, a subject, or a vendor to attach.' });
  }
  const validation = await validateComplaintSubjectFields({ property_id, unit_id, subject_type, subject_id, vendor_id });
  if (!validation.ok) return res.status(validation.status).json({ error: validation.error });

  const { data: before, error: beforeErr } = await supabase
    .from('complaints').select('id, needs_matching').eq('id', req.params.id).maybeSingle();
  if (beforeErr) return res.status(500).json({ error: beforeErr.message });
  if (!before) return res.status(404).json({ error: 'Complaint not found.' });

  const updates = { needs_matching: false };
  if (property_id) updates.property_id = property_id;
  if (unit_id) updates.unit_id = unit_id;
  if (subject_type) {
    updates.subject_type = subject_type;
    updates.subject_id = subject_type === 'property' ? null : (subject_id || null);
  }
  if (vendor_id) updates.vendor_id = vendor_id;

  const { data: updated, error: updateErr } = await supabase.from('complaints').update(updates).eq('id', req.params.id).select().single();
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  await writeAuditLog({
    action: 'complaint_tracking.matched', entity_type: 'complaint', entity_id: req.params.id,
    actor_email: req.user.email, property_id: updated.property_id, risk_level: 'low', privacy_category: 'processing',
    details: { property_id: property_id || null, subject_type: subject_type || null, subject_id: subject_id || null, vendor_id: vendor_id || null, actor_role: req.complaintTrackingRole },
  });

  res.json({ success: true, complaint: updated });
});

// ============================================================
// Name-match suggestion review — migration 20261002060000, the narrower,
// Mason-cleared, human-confirmed name-based-matching design (Peter's
// explicit approval for THIS version only, relayed via Jarvis — full
// automatic resolution is OUT OF SCOPE). Deliberately its OWN pair of
// routes, never folded into /match above: Mason's point 1 requires the
// reviewer to be shown and disambiguate a REAL collision (every real
// candidate this complaint's own property corroborates, per archive-
// search/lib/significance-pass.js's findNameMatchCandidates()), which is a
// fundamentally different review action from the free-form manual
// property/subject search /match already offers — confusing the two in
// one endpoint would risk a human picking a candidate without ever seeing
// the collision context that's this whole feature's safety property.
//
// resolveMailboxAnchorForConversation() below carries the same narrow,
// already-accepted multi-mailbox ambiguity significance-pass.js's own
// findExistingComplaintForConversation() documents (missive_conversation_id
// is only unique WITHIN a mailbox, and complaints carries no mailbox_key
// column) — accepted here for the identical reason, not re-litigated.
// ============================================================

async function resolveMailboxAnchorForConversation(missive_conversation_id) {
  const { data: sig, error: sigErr } = await supabase
    .from('missive_conversation_significance')
    .select('mailbox_key')
    .eq('missive_conversation_id', missive_conversation_id)
    .limit(1).maybeSingle();
  if (sigErr || !sig) return null;

  const { data: msg, error: msgErr } = await supabase
    .from('missive_message_intake_search_safe')
    .select('missive_message_id')
    .eq('mailbox_key', sig.mailbox_key)
    .eq('missive_conversation_id', missive_conversation_id)
    .order('delivered_at', { ascending: true })
    .limit(1).maybeSingle();
  if (msgErr || !msg) return null;

  return { mailbox_key: sig.mailbox_key, missive_message_id: msg.missive_message_id };
}

// Mason's point 3 (audit-trail parity) applied to the PERMANENT link
// record, not just the complaints-row review columns: a confirmed name
// match gets a real missive_message_links row with the new, distinct
// match_method, carrying who confirmed it and when. Best-effort, non-
// fatal — same posture significance-pass.js's own writeMessageLinks()
// already uses for every content-extracted row: a failure here never
// blocks the real write (complaints.subject_type/subject_id and the
// human_confirmed_subject_* audit trail on complaints itself, already
// committed by the caller before this runs) — it only means the permanent
// link record didn't also get written. The caller logs any failure
// loudly so it's never silently lost.
async function writeNameMatchConfirmedLink(complaint, actorEmail, nowIso) {
  if (!complaint.source_missive_conversation_id) return; // defensive only — every AI-created complaint that can ever carry a suggestion always has one (createComplaintRow always sets it); a manually-reported complaint can never have suggested_subject_type set in the first place.
  const anchor = await resolveMailboxAnchorForConversation(complaint.source_missive_conversation_id);
  if (!anchor) return; // logged by the caller — nothing real to anchor the link to.

  const { error } = await supabase.from('missive_message_links').insert({
    mailbox_key: anchor.mailbox_key,
    missive_message_id: anchor.missive_message_id,
    missive_conversation_id: complaint.source_missive_conversation_id,
    property_id: complaint.property_id,
    subject_type: complaint.subject_type,
    subject_id: complaint.subject_id,
    match_method: 'content_extracted_human_confirmed',
    source_reference: complaint.suggested_subject_name_text,
    confidence: 0.7, // same fixed value significance-pass.js's own vendor content_extracted path already uses (writeMessageLinks()) — this was never a model-reported confidence score to begin with.
    extracted_by: complaint.suggested_subject_extracted_by,
    human_confirmed_by: actorEmail,
    human_confirmed_at: nowIso,
  });
  if (error) throw error;
}

// ─── POST /api/complaint-tracking/:id/name-match/confirm — a human picks
// one specific candidate. This is the ONLY place in this codebase that
// writes complaints.subject_type/subject_id from a name-based (as opposed
// to address-based) match — and only ever after this explicit human
// action, never automatically.
router.post('/api/complaint-tracking/:id/name-match/confirm', requireComplaintTrackingAccess, async (req, res) => {
  if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'That id is not valid.' });
  const { candidate_id } = req.body;
  if (!isValidUuid(candidate_id)) return res.status(400).json({ error: 'candidate_id is required and must be a valid id.' });

  const { data: before, error: beforeErr } = await supabase
    .from('complaints')
    .select('id, property_id, suggested_subject_type, suggested_subject_candidate_ids, human_confirmed_subject_outcome, source_missive_conversation_id')
    .eq('id', req.params.id).maybeSingle();
  if (beforeErr) return res.status(500).json({ error: beforeErr.message });
  if (!before) return res.status(404).json({ error: 'Complaint not found.' });
  if (!before.suggested_subject_type) {
    return res.status(409).json({ error: 'This complaint has no pending name-match suggestion to review.' });
  }
  if (before.human_confirmed_subject_outcome) {
    return res.status(409).json({ error: 'This suggestion has already been reviewed.' });
  }
  if (!before.suggested_subject_candidate_ids.includes(candidate_id)) {
    return res.status(400).json({ error: 'candidate_id must be one of the candidates this complaint actually suggested.' });
  }

  const nowIso = new Date().toISOString();
  const { data: updated, error: updateErr } = await supabase
    .from('complaints')
    .update({
      subject_type: before.suggested_subject_type,
      subject_id: candidate_id,
      needs_matching: false,
      human_confirmed_subject_outcome: 'confirmed',
      human_confirmed_subject_id: candidate_id,
      human_confirmed_subject_by: req.user.email,
      human_confirmed_subject_at: nowIso,
    })
    .eq('id', req.params.id).select().single();
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  // Part D — audit log, same conventions as every other write in this
  // router (writeAuditLog's own actor_email -> performed_by lookup).
  await writeAuditLog({
    action: 'complaint_tracking.name_match_confirmed', entity_type: 'complaint', entity_id: req.params.id,
    actor_email: req.user.email, property_id: updated.property_id, risk_level: 'medium', privacy_category: 'processing',
    details: {
      subject_type: before.suggested_subject_type, subject_id: candidate_id,
      candidate_count: before.suggested_subject_candidate_ids.length, actor_role: req.complaintTrackingRole,
    },
  });

  try {
    await writeNameMatchConfirmedLink(updated, req.user.email, nowIso);
  } catch (err) {
    console.error(`[complaint-tracking] missive_message_links insert failed for name-match confirm on complaint ${req.params.id}:`, err.message);
  }

  res.json({ success: true, complaint: updated });
});

// ─── POST /api/complaint-tracking/:id/name-match/reject — "none of these
// are right." Leaves needs_matching = TRUE (the migration's own schema
// comment, "A DELIBERATE OMISSION" section) — the record goes back to
// looking exactly like any other unmatched orphan; this build makes no UI
// distinction between "never reviewed" and "reviewed and rejected" beyond
// the audit_log entry below.
router.post('/api/complaint-tracking/:id/name-match/reject', requireComplaintTrackingAccess, async (req, res) => {
  if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'That id is not valid.' });

  const { data: before, error: beforeErr } = await supabase
    .from('complaints')
    .select('id, property_id, suggested_subject_type, human_confirmed_subject_outcome')
    .eq('id', req.params.id).maybeSingle();
  if (beforeErr) return res.status(500).json({ error: beforeErr.message });
  if (!before) return res.status(404).json({ error: 'Complaint not found.' });
  if (!before.suggested_subject_type) {
    return res.status(409).json({ error: 'This complaint has no pending name-match suggestion to review.' });
  }
  if (before.human_confirmed_subject_outcome) {
    return res.status(409).json({ error: 'This suggestion has already been reviewed.' });
  }

  const { data: updated, error: updateErr } = await supabase
    .from('complaints')
    .update({
      human_confirmed_subject_outcome: 'rejected',
      human_confirmed_subject_by: req.user.email,
      human_confirmed_subject_at: new Date().toISOString(),
    })
    .eq('id', req.params.id).select().single();
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  await writeAuditLog({
    action: 'complaint_tracking.name_match_rejected', entity_type: 'complaint', entity_id: req.params.id,
    actor_email: req.user.email, property_id: updated.property_id, risk_level: 'low', privacy_category: 'processing',
    details: { suggested_subject_type: before.suggested_subject_type, actor_role: req.complaintTrackingRole },
  });

  res.json({ success: true, complaint: updated });
});

// ─── POST /api/complaint-tracking/:id/duplicate/confirm — merges the
// NEWER record (this :id) into the older primary it was suggested against.
router.post('/api/complaint-tracking/:id/duplicate/confirm', requireComplaintTrackingAccess, async (req, res) => {
  if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'That id is not valid.' });

  const { data: before, error: beforeErr } = await supabase
    .from('complaints').select('id, duplicate_status, possible_duplicate_of_id, property_id').eq('id', req.params.id).maybeSingle();
  if (beforeErr) return res.status(500).json({ error: beforeErr.message });
  if (!before) return res.status(404).json({ error: 'Complaint not found.' });
  if (before.duplicate_status !== 'suggested' || !before.possible_duplicate_of_id) {
    return res.status(409).json({ error: 'This complaint has no pending duplicate suggestion to confirm.' });
  }

  const { data: updated, error: updateErr } = await supabase
    .from('complaints').update({ duplicate_status: 'confirmed_merged', merged_into_id: before.possible_duplicate_of_id })
    .eq('id', req.params.id).select().single();
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  await writeAuditLog({
    action: 'complaint_tracking.duplicate_disposition', entity_type: 'complaint', entity_id: req.params.id,
    actor_email: req.user.email, property_id: before.property_id, risk_level: 'low',
    details: { disposition: 'confirmed_merged', merged_into_id: before.possible_duplicate_of_id, actor_role: req.complaintTrackingRole },
  });

  res.json({ success: true, complaint: updated });
});

// ─── POST /api/complaint-tracking/:id/duplicate/dismiss — both stay
// separate, permanently (product doc Section 4).
router.post('/api/complaint-tracking/:id/duplicate/dismiss', requireComplaintTrackingAccess, async (req, res) => {
  if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'That id is not valid.' });

  const { data: before, error: beforeErr } = await supabase
    .from('complaints').select('id, duplicate_status, property_id').eq('id', req.params.id).maybeSingle();
  if (beforeErr) return res.status(500).json({ error: beforeErr.message });
  if (!before) return res.status(404).json({ error: 'Complaint not found.' });
  if (before.duplicate_status !== 'suggested') {
    return res.status(409).json({ error: 'This complaint has no pending duplicate suggestion to dismiss.' });
  }

  const { data: updated, error: updateErr } = await supabase
    .from('complaints').update({ duplicate_status: 'dismissed' }).eq('id', req.params.id).select().single();
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  await writeAuditLog({
    action: 'complaint_tracking.duplicate_disposition', entity_type: 'complaint', entity_id: req.params.id,
    actor_email: req.user.email, property_id: before.property_id, risk_level: 'low',
    details: { disposition: 'dismissed', actor_role: req.complaintTrackingRole },
  });

  res.json({ success: true, complaint: updated });
});

// ─── POST /api/complaint-tracking/:id/held/close — the closure-note flow
// for a held placeholder (product doc: "once Peter or the DO has handled
// it directly... they add a short closure note"). Never AI-generated
// content — this is a human, and only a human, writing to this row.
router.post('/api/complaint-tracking/:id/held/close', requireComplaintTrackingAccess, async (req, res) => {
  if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'That id is not valid.' });
  const { resolution_note } = req.body;
  if (typeof resolution_note !== 'string' || !resolution_note.trim()) {
    return res.status(400).json({ error: 'resolution_note is required to close a held item.' });
  }

  const { data: before, error: beforeErr } = await supabase
    .from('complaints').select('id, status, held_legal_fair_housing, property_id').eq('id', req.params.id).maybeSingle();
  if (beforeErr) return res.status(500).json({ error: beforeErr.message });
  if (!before) return res.status(404).json({ error: 'Complaint not found.' });
  if (!before.held_legal_fair_housing || before.status !== 'held') {
    return res.status(409).json({ error: 'This is not an open held Legal/Fair Housing placeholder.' });
  }

  const { data: updated, error: updateErr } = await supabase
    .from('complaints').update({ status: 'resolved', resolution_note: resolution_note.trim() }).eq('id', req.params.id).select().single();
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  await writeAuditLog({
    action: 'complaint_tracking.stage_changed', entity_type: 'complaint', entity_id: req.params.id,
    actor_email: req.user.email, property_id: before.property_id, risk_level: 'medium', // "leaving held" — Design Decision 11's table
    details: { from_status: 'held', to_status: 'resolved', reason: resolution_note.trim(), actor_role: req.complaintTrackingRole },
  });

  res.json({ success: true, complaint: updated });
});

// ─── POST /api/complaint-tracking/:id/redact — the CCPA path (Rule 10),
// with the held_legal_fair_housing hard-refuse-and-disposition flow (Data
// Inventory section, reused by name pattern from operational_notes' own
// legal_privileged carve-out). No third "ambiguous" outcome — an admin/DO
// hasn't decided until they actually call this route with a real
// disposition; the row stays untouched until then.
async function applyRedaction(before) {
  const updates = { description: '[REDACTED]' };
  if (before.resolution_note) updates.resolution_note = '[REDACTED]';
  return supabase.from('complaints').update(updates).eq('id', before.id).select().single();
}

router.post('/api/complaint-tracking/:id/redact', requireComplaintTrackingAccess, async (req, res) => {
  if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'That id is not valid.' });

  const { data: before, error: beforeErr } = await supabase
    .from('complaints').select('id, property_id, description, resolution_note, held_legal_fair_housing, subject_type, subject_id')
    .eq('id', req.params.id).maybeSingle();
  if (beforeErr) return res.status(500).json({ error: beforeErr.message });
  if (!before) return res.status(404).json({ error: 'Complaint not found.' });

  if (before.held_legal_fair_housing) {
    // System-logged automatically every time this route is hit for a held
    // row, regardless of outcome — records that the automatic redaction
    // path was bypassed (Data Inventory section).
    await writeAuditLog({
      action: 'complaint_tracking.ccpa_deletion_blocked_held', entity_type: 'complaint', entity_id: before.id,
      actor_email: req.user.email, property_id: before.property_id, risk_level: 'medium',
      details: { actor_role: req.complaintTrackingRole },
    });

    const { disposition, disposition_notes } = req.body;
    if (!['hold_exception_applies', 'no_hold_confirmed_safe'].includes(disposition)) {
      return res.status(400).json({ error: "disposition must be 'hold_exception_applies' or 'no_hold_confirmed_safe'." });
    }
    if (typeof disposition_notes !== 'string' || !disposition_notes.trim()) {
      return res.status(400).json({ error: 'disposition_notes is required and must explain the determination.' });
    }

    // Human-logged determination — the reasoning, never the held row's own
    // content (which is minimal or empty anyway per Design Decision 1).
    await writeAuditLog({
      action: 'complaint_tracking.ccpa_deletion_disposition', entity_type: 'complaint', entity_id: before.id,
      actor_email: req.user.email, property_id: before.property_id, risk_level: 'medium',
      details: {
        subject_type: before.subject_type, subject_id: before.subject_id,
        disposition, disposition_notes: disposition_notes.trim(), held_legal_fair_housing: true, actor_role: req.complaintTrackingRole,
      },
    });

    if (disposition === 'hold_exception_applies') {
      return res.json({ success: true, disposition, complaint_redacted: false });
    }
    const { data: updated, error: redactErr } = await applyRedaction(before);
    if (redactErr) return res.status(500).json({ error: redactErr.message });
    return res.json({ success: true, disposition, complaint_redacted: true, complaint: updated });
  }

  const { data: updated, error: redactErr } = await applyRedaction(before);
  if (redactErr) return res.status(500).json({ error: redactErr.message });

  await writeAuditLog({
    action: 'complaint_tracking.ccpa_deletion_disposition', entity_type: 'complaint', entity_id: before.id,
    actor_email: req.user.email, property_id: before.property_id, risk_level: 'medium',
    details: { redacted: true, reason: 'ccpa_deletion_request', held_legal_fair_housing: false, actor_role: req.complaintTrackingRole },
  });

  res.json({ success: true, complaint: updated });
});

// ============================================================
// SECTION 6: handleCCPADelete(contact_id) — GOVERNANCE.md Rule 10, the
// bulk/automated half of the same redaction mechanics /:id/redact already
// implements per-row. Manual lookup via subject_id (same accepted v1
// limitation operational_notes already carries, per the Data Inventory
// section — "not automatic"). A held row is never auto-redacted here
// either — it's flagged (blocked_held, logged) for a human to resolve via
// /:id/redact's own disposition flow, same hard-refuse discipline as the
// interactive route.
// ============================================================
async function handleCCPADelete(contact_id) {
  const { data: rows, error } = await supabase
    .from('complaints').select('id, property_id, description, resolution_note, held_legal_fair_housing').eq('subject_id', contact_id);
  if (error) throw error;

  const result = { redacted: [], blocked_held: [] };
  for (const row of rows || []) {
    if (row.held_legal_fair_housing) {
      await writeAuditLog({
        action: 'complaint_tracking.ccpa_deletion_blocked_held', entity_type: 'complaint', entity_id: row.id,
        actor_type: 'system', property_id: row.property_id, risk_level: 'medium',
        details: { contact_id, reason: 'bulk_ccpa_delete_request_held_row' },
      });
      result.blocked_held.push(row.id);
      continue;
    }
    const { error: redactErr } = await applyRedaction(row);
    if (redactErr) {
      console.error(`[complaint-tracking] CCPA redaction failed for complaint ${row.id}:`, redactErr.message);
      continue;
    }
    await writeAuditLog({
      action: 'complaint_tracking.ccpa_deletion_disposition', entity_type: 'complaint', entity_id: row.id,
      actor_type: 'system', property_id: row.property_id, risk_level: 'medium',
      details: { contact_id, redacted: true, reason: 'bulk_ccpa_delete_request', held_legal_fair_housing: false, automated: true },
    });
    result.redacted.push(row.id);
  }
  return result;
}

// ============================================================
// SECTION 7: internalRouter — no login required, own x-cron-secret check.
// Same pattern as every other tool's internal router in this Hub. Neither
// route is on any schedule (Design Decision 16) — both are called by hand
// until the shadow-mode period in
// compliance/complaint-tracking-ai-risk-assessment.md is complete.
// ============================================================
const internalRouter = express.Router();

function checkCronSecret(req, res) {
  const secret = req.headers['x-cron-secret'];
  if (!secret || secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// In-process overlap guard — same reasoning as every other tool's own
// (e.g. email-intake's missiveSyncRunning): the Hub runs as a single pm2
// fork instance, so a module-level boolean is sufficient.
let checkAgingRunning = false;

/**
 * POST /api/complaint-tracking/process-pending — RETIRED, 2026-09-13.
 * archive-search-significance-technical-spec.md (v2), Section 8: this
 * route's own driver query was structurally starved before it ever ran
 * (archive-search's Fair Housing screening pass already marks
 * pipeline_status='processed' on 254,302/254,307 real rows, as a side
 * effect of its own, unrelated job), and running this pipeline alongside
 * the new merged pass would produce two independent categorizers
 * disagreeing on the same mail with no reconciliation surface. The
 * merged pass's own equivalent route is POST /api/archive-search/
 * process-significance-pending (archive-search/router.js) — same
 * x-cron-secret-gated, manually-triggered posture, now covering both
 * significance tagging and this tool's own six triage categories
 * (reframed as escalation_signal) in one pass. This route is kept,
 * dead-ended, rather than deleted outright, so a stale caller (an old
 * cron entry, a saved curl command, a bookmark) gets a clear, explicit
 * signal instead of a generic 404.
 */
internalRouter.post('/api/complaint-tracking/process-pending', async (req, res) => {
  if (!checkCronSecret(req, res)) return;
  res.status(410).json({
    error: 'retired',
    message: 'This route is retired — complaint-tracking\'s own ingestion pipeline has been replaced by the merged archive-search significance + complaint-triage pass. Call POST /api/archive-search/process-significance-pending instead.',
  });
});

/**
 * POST /api/complaint-tracking/check-aging
 * NOT in the spec's own literal "Routes Needed" list — added here because
 * Design Decision 12 explicitly requires "a scheduled job" that writes a
 * complaint_tracking.aging_nudge audit row (GOVERNANCE.md Rule 1: this
 * computation is itself a logged decision, not just a UI computation) for
 * every non-resolved big-deal complaint that has stalled past
 * big_deal_aging_clock_hours and hasn't been nudged in the current cycle.
 * v1's own stated scope (Design Decision 12): this drives an in-Hub visual
 * signal only, no outbound notification — the dashboard can compute a
 * "stalled" badge live from created_at/last_aging_nudge_at without calling
 * this route at all; running this route is what produces the Rule 1 audit
 * trail for the underlying decision. Same manually-triggered, x-cron-
 * secret-gated, unscheduled posture as process-pending above.
 *
 * discovery_context = 'live_pipeline' filter ADDED to the query below —
 * the identical Section 6 hard-gate fix as GET /api/complaint-tracking/
 * home-count above. This route predates the historical backfill and its
 * candidate query has no way to know about discovery_context on its own;
 * without this filter, a historical row past the aging cutoff would get
 * nudged (and audit-logged as a live aging event) exactly like a real,
 * same-day stalled complaint — the spec's own named example of this
 * mistake ("the 24-hour aging/escalation job... None of these may ever
 * consider a historical_backfill row").
 */
internalRouter.post('/api/complaint-tracking/check-aging', async (req, res) => {
  if (!checkCronSecret(req, res)) return;
  if (checkAgingRunning) {
    return res.status(409).json({ skipped: true, reason: 'already_running', message: 'A previous aging-check run is still in progress.' });
  }
  checkAgingRunning = true;
  try {
    const activeConfig = await getActiveConfig();
    if (!activeConfig) return res.status(500).json({ error: 'No active complaint_tracking_config row is set up yet.' });

    const cutoffMs = activeConfig.big_deal_aging_clock_hours * 60 * 60 * 1000;
    const cutoffIso = new Date(Date.now() - cutoffMs).toISOString();

    const { data: candidates, error } = await supabase
      .from('complaints')
      .select('id, property_id, created_at, last_aging_nudge_at, owner_team_member_id, delegated_to_team_member_id')
      .eq('is_big_deal', true).eq('discovery_context', 'live_pipeline').neq('status', 'resolved').lte('created_at', cutoffIso);
    if (error) return res.status(500).json({ error: error.message });

    let nudged = 0;
    for (const c of candidates || []) {
      // "Hasn't been nudged in the last cycle" — skip if the last nudge is
      // still within one full threshold window.
      if (c.last_aging_nudge_at && (Date.now() - new Date(c.last_aging_nudge_at).getTime()) < cutoffMs) continue;

      const nowIso = new Date().toISOString();
      const { error: updateErr } = await supabase.from('complaints').update({ last_aging_nudge_at: nowIso }).eq('id', c.id);
      if (updateErr) {
        console.error(`[complaint-tracking] Failed to record aging nudge for complaint ${c.id}:`, updateErr.message);
        continue;
      }
      await writeAuditLog({
        action: 'complaint_tracking.aging_nudge', entity_type: 'complaint', entity_id: c.id,
        actor_type: 'system', property_id: c.property_id, risk_level: 'low',
        details: { owner_team_member_id: c.owner_team_member_id, delegated_to_team_member_id: c.delegated_to_team_member_id, created_at: c.created_at },
      });
      nudged++;
    }

    res.json({ ok: true, checked: (candidates || []).length, nudged });
  } catch (err) {
    console.error('[complaint-tracking] check-aging failed:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    checkAgingRunning = false;
  }
});

module.exports = {
  router,
  internalRouter,
  attachComplaintTrackingRole,
  requireComplaintTrackingAccess,
  COMPLAINT_TRACKING_ALLOWED_ROLES,
  handleCCPADelete, // GOVERNANCE.md Rule 10
};
