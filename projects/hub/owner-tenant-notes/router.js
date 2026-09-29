/**
 * owner-tenant-notes/router.js
 * Owner & Tenant Operational Notes — a new Hub tool built against Neo's
 * schema (supabase/migrations/20260905000000_owner_tenant_operational_
 * notes_schema.sql) and Oracle's fully-approved spec:
 * projects/hub/property-360/owner-tenant-operational-notes-SPEC.md — read
 * it in full before changing anything here, especially Sections 3, 5, 9,
 * and 10.
 *
 * ============================================================
 * WHAT THIS FILE DOES NOT BUILD (explicitly out of scope for this pass —
 * see the build report for the full reasoning)
 * ============================================================
 *   - UPDATED (this pass): `source='ai_proposed'` rows can now be CREATED
 *     — via `proposeAINote`, an exported, in-process function, NOT an HTTP
 *     route — and REVIEWED, via the `/:id/approve`, `/:id/decline`, and
 *     `/property/:property_id/pending-approval` routes below. This closes
 *     the gap the file's header used to describe ("no code here ever
 *     populates source='ai_proposed'...") — that sentence is no longer
 *     true and has been removed.
 *   - STILL NOT BUILT: the actual AI pipeline that would call
 *     `proposeAINote` — the email-reading/extraction logic, and the
 *     judgment about WHEN a piece of content is worth proposing as a note
 *     (e.g. the complaint-tracking tool's Category 6, "a one-off
 *     instruction from an owner that falls outside normal procedure" —
 *     `projects/hub/email-intake/complaint-tracking-v1-scope.md`, itself
 *     still an unbuilt draft scope document as of this pass). This pass
 *     only builds the capability such a pipeline will call into — the
 *     drafting/detection logic, the email connection, and the decision of
 *     what counts as worth proposing all remain entirely unbuilt here.
 *   - Grouped/bulk review (spec Section 5's own fast-follow deferral) —
 *     the flagged-queue route below is per-property, one item at a time,
 *     matching this being "a new, low-volume-at-launch data source." The
 *     new pending-approval queue below follows the same per-property,
 *     one-item-at-a-time shape for the same reason.
 *   - A portfolio-wide notes/review page. This tool's only surface is the
 *     Property 360 collapsible section (spec Section 2/9 UI item) — no
 *     standalone dashboard page, matching the spec's own framing
 *     throughout ("surfaced primarily on Property 360").
 *
 * ============================================================
 * THE HOUSING-DECISION FIREWALL (spec Section 10) — READ BEFORE ADDING
 * ANY NEW QUERY OR IMPORT TO THIS FILE
 * ============================================================
 * This file must never gain a foreign key, join, API call, or scheduled
 * job connecting operational_notes to `leases`, any LeadSimple decision
 * workflow, `security_deposit_cases`, or any renewal/eviction process.
 * Every query below touches only: operational_notes, team_members,
 * team_member_tool_roles, audit_log, properties (existence check only),
 * units (existence check only), owners/tenants (display-name lookup
 * only, read-only, never written). Grep this file for 'leases',
 * 'leadsimple', 'security_deposit' before merging any change — none
 * should ever appear.
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const { scanText, TERMS_VERSION } = require('../maintenance-history/lib/protected-class-terms');
const { scanDerogatoryLanguage } = require('./lib/derogatory-language-terms');
const { checkManualNoteContent, checkAIProposedNoteContent } = require('./lib/note-content-check');

// ─── Config ─────────────────────────────────────────────────────────────
const missing = [];
if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
if (missing.length > 0) {
  console.error(`[owner-tenant-notes] Missing environment variables: ${missing.join(', ')}`);
  console.error('[owner-tenant-notes] Set these in the shared .env at the project root (see .env.example).');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// properties.id / units.id / operational_notes.id are all UUID columns —
// same guard every other tool's property-scoped route already has.
function isValidUuid(str) {
  return typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// ============================================================
// SECTION 1: Role-tier mapping — spec Section 3, copied verbatim from the
// spec's own code block. Do not "clean up" or re-derive this mapping —
// every value here is a dated, quoted business decision made by Peter
// (2026-09-05), reviewed by Asimov and Mason. See the spec for the full
// per-role reasoning table.
// ============================================================

// Tier ordinals — a role's granted max tier determines every tier at or
// below it that role can see, same ordinal-comparison pattern already
// used for outcome_level (1-5) and REVIEW_STATUS_RANK in maintenance-
// history/router.js.
const NOTE_TIER_RANK = { operational: 1, management_compliance_restricted: 2, legal_privileged: 3 };
const NOTE_TIERS = Object.keys(NOTE_TIER_RANK);

// Explicit allow-list, evaluated independently for THIS tool — none of
// these mappings are inherited from what these role names mean on
// maintenance_history or leadsimple_delinquency (spec Section 3's own
// "hard-won lesson from this exact codebase" — the LeadSimple
// bare-truthy-role bug).
const OWNER_TENANT_NOTES_ROLE_MAX_TIER = {
  admin:                    'legal_privileged',
  director_of_operations:   'management_compliance_restricted',
  reviewer:                 'management_compliance_restricted', // granted per-tool; NOT inherited from a maintenance_history 'reviewer' row
  property_manager:         'management_compliance_restricted', // same job as pod_lead at Rincon — Peter, 2026-09-05
  pod_lead:                 'management_compliance_restricted', // same job as property_manager at Rincon, confirmed by Peter — not a distinct mapping
  leasing_reviewer:         'operational',
  maintenance_coordinator:  'operational',                      // further scoped — see MAINTENANCE_COORDINATOR_EXCLUDED_SUBJECT_TYPE below
  inspection_coordinator:   'operational',
  // contributor: no mapping — confirmed by Peter as no access, not an open item
};

function roleMaxTierRank(role) {
  const tier = OWNER_TENANT_NOTES_ROLE_MAX_TIER[role];
  return tier ? NOTE_TIER_RANK[tier] : 0; // 0 = no access at all (unmapped role, or no role/no row)
}

function roleHasAnyAccess(role) {
  return roleMaxTierRank(role) > 0;
}

// Generalized ceiling guard — spec Section 3's authorship-time rule ("only
// admin may author a note declared legal_privileged," enforced below at
// note creation) generalized to every place a caller-supplied access_tier
// gets WRITTEN to a note: a caller can never move any note to a tier above
// their own role's ceiling, not just the legal_privileged special case.
// Added 2026-09-05 after Judge found /:id/review accepted a caller-
// supplied access_tier after only checking "is this a real tier name,"
// never "is this within the caller's own reach" — letting a
// property_manager (capped at management_compliance_restricted) escalate
// a note straight to legal_privileged via that route.
function tierWithinCallerReach(tier, role) {
  return NOTE_TIER_RANK[tier] <= roleMaxTierRank(role);
}

// maintenance_coordinator's Operational-tier grant is scoped to
// owner/property-subject notes only (spec Section 3's table + "Enforced
// as a subject_type != 'tenant' filter layered on top of the tier check,
// not a separate tier"). Applied both to reads (the property-listing
// route below silently omits tenant-subject rows for this role, same as
// any role with no access at all — no placeholder, no hint) and to
// authorship: Section 3's general "any role can author any tier" rule
// does not override this subject-type scope — letting a
// maintenance_coordinator author a tenant-subject dispute/complaint note
// at a tier they can't read back would defeat the reason this exclusion
// exists (this role was never evaluated for tenant-dispute content at
// all, per the LeadSimple precedent this spec cites).
const MAINTENANCE_COORDINATOR_EXCLUDED_SUBJECT_TYPE = 'tenant';
function roleCanAccessSubjectType(role, subjectType) {
  if (role === 'maintenance_coordinator' && subjectType === MAINTENANCE_COORDINATOR_EXCLUDED_SUBJECT_TYPE) return false;
  return true;
}

// Roles that can review a flagged note (spec Section 5: "a human reviewer
// holding Management/Compliance-Restricted tier or above") — derived from
// the mapping above, not a second hand-typed list, so it can't drift from
// Section 3's own table if that mapping ever changes.
const OWNER_TENANT_NOTES_REVIEW_ROLES = Object.keys(OWNER_TENANT_NOTES_ROLE_MAX_TIER)
  .filter((role) => roleMaxTierRank(role) >= NOTE_TIER_RANK.management_compliance_restricted);

// Roles subject to the NEW Tier 2/3 acknowledgment gate (spec Section 3,
// added 2026-09-05 per Asimov/Mason's reconsideration) — any role whose
// max tier reaches Management/Compliance-Restricted or above, i.e. the
// exact same set that can ever be shown Tier 2/3 content at all. Derived,
// not hand-typed, for the same reason as OWNER_TENANT_NOTES_REVIEW_ROLES
// above (today these two sets are identical; kept as two separately-named
// constants because they answer two different questions and could
// legitimately diverge later — e.g. if a future role reaches
// Mgmt/Compliance-Restricted without being a "reviewer").
const TIER_ACCESS_ACK_APPLICABLE_ROLES = Object.keys(OWNER_TENANT_NOTES_ROLE_MAX_TIER)
  .filter((role) => roleMaxTierRank(role) >= NOTE_TIER_RANK.management_compliance_restricted);

// ============================================================
// SECTION 2: attachOwnerTenantNotesRole / requireOwnerTenantNotesAccess /
// requireOwnerTenantNotesRole — the exact same three-function shape as
// maintenance-history/router.js's attachMaintenanceHistoryRole (spec
// Section 3's own instruction: "the same mechanism, reused exactly
// as-is, not reinvented").
// ============================================================
async function attachOwnerTenantNotesRole(req, res, next) {
  req.ownerTenantNotesRole = null;
  req.teamMemberId = req.teamMemberId || null;
  req.ownerTenantNotesMemberName = null;

  try {
    const { data: member, error: memberErr } = await supabase
      .from('team_members')
      .select('id, full_name, is_active')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (memberErr) throw memberErr;
    if (!member || !member.is_active) return next();

    req.teamMemberId = member.id;
    req.ownerTenantNotesMemberName = member.full_name || null;

    const { data: roleRow, error: roleErr } = await supabase
      .from('team_member_tool_roles')
      .select('role')
      .eq('team_member_id', member.id)
      .eq('tool', 'owner_tenant_notes')
      .maybeSingle();
    if (roleErr) throw roleErr;
    req.ownerTenantNotesRole = roleRow ? roleRow.role : null;
    next();
  } catch (err) {
    console.error('[owner-tenant-notes] permission lookup failed:', err.message);
    next();
  }
}

// requireOwnerTenantNotesAccess — "at least Operational-tier access," per
// spec Section 3. Deliberately checks roleHasAnyAccess(), NOT a bare
// truthy req.ownerTenantNotesRole — a role value with no mapping in
// OWNER_TENANT_NOTES_ROLE_MAX_TIER (e.g. 'contributor', or any future role
// added to the shared CHECK constraint for a different tool) must get NO
// access here, even though the column holds a real, non-null string. This
// is the exact allow-list discipline spec Section 3 requires, not the
// bare-truthy-role bug the LeadSimple card originally shipped with.
function requireOwnerTenantNotesAccess(req, res, next) {
  if (!roleHasAnyAccess(req.ownerTenantNotesRole)) {
    return res.status(403).json({
      error: 'Your Rincon Hub account does not have access to Owner & Tenant Operational Notes yet. Ask an admin to grant you access.',
    });
  }
  next();
}

function requireOwnerTenantNotesRole(...roles) {
  return (req, res, next) => {
    if (!req.ownerTenantNotesRole || !roles.includes(req.ownerTenantNotesRole)) {
      return res.status(403).json({ error: 'Insufficient permissions', required: roles, actual: req.ownerTenantNotesRole });
    }
    next();
  };
}

// ============================================================
// SECTION 3: Audit log — reused exactly, sibling implementation of
// maintenance-history/router.js's writeAuditLog/lookupUserId (not
// exported from that file, so re-implemented here byte-for-byte rather
// than imported — same fields, same conventions, per spec's "reuses
// audit_log exactly, no new logging mechanism").
// ============================================================
async function lookupUserId(email) {
  const { data } = await supabase.from('users').select('id').or(`email.eq.${email},alt_email.eq.${email}`).maybeSingle();
  return data ? data.id : null;
}

// actor_id defaults to actor_email (every existing call site's behavior,
// unchanged) but can be overridden — needed starting this pass for the
// operational_notes.ai_proposed event, whose actor is a pipeline, not a
// human with an email/Hub login. Mirrors the real precedent already in
// this codebase for a non-human actor (maintenance-history/router.js's
// ingestion-run audit insert: `actor_id: extractClaims.EXTRACTOR_ACTOR_ID`,
// no `performed_by`) rather than forcing an AI actor through the
// human-email shape. performed_by is looked up only when actor_email is
// actually given — there is no Hub user row to resolve for an AI actor,
// and forcing lookupUserId(undefined) would be a wasted/wrong query.
async function writeAuditLog({ action, entity_type, entity_id, actor_email, actor_id, actor_type, risk_level, privacy_category, property_id, details }) {
  const performed_by = actor_email ? await lookupUserId(actor_email) : null;
  const { error } = await supabase.from('audit_log').insert({
    action,
    entity_type,
    entity_id,
    performed_by,
    actor_type: actor_type || 'human',
    actor_id: actor_id || actor_email,
    privacy_category: privacy_category || 'processing',
    risk_level: risk_level || 'low',
    property_id: property_id || null,
    details: details || {},
  });
  if (error) {
    console.error(`[owner-tenant-notes] audit_log insert failed for ${action}:`, error.message);
    return false;
  }
  return true;
}

// ============================================================
// SECTION 4: Tier 2/3 acknowledgment gate — spec Section 3, condition 2
// (added 2026-09-05 per Asimov/Mason's reconsideration of the
// portfolio-wide property_manager/pod_lead grant). Covers ALL
// Management/Compliance-Restricted and Legal-Privileged content, not just
// flagged items — a genuinely broader gate than Maintenance History's
// PRIVACY_QUEUE_ACK (which only guards flagged claims). Mechanically
// reuses the exact same requireAcknowledgment/audit_log pattern
// maintenance-history/router.js established, per the spec's own
// instruction, under a new action constant.
// ============================================================
const TIER_ACCESS_ACK_ACTION = 'operational_notes.tier_access_acknowledged';

// count:'exact'+head:true — same established pattern as
// maintenance-history/router.js's hasAcknowledgedPrivacyQueue.
async function hasAcknowledgedTierAccess(email) {
  const { count, error } = await supabase
    .from('audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('action', TIER_ACCESS_ACK_ACTION)
    .eq('actor_id', email);
  if (error) throw error;
  return (count || 0) > 0;
}

// Final access-use policy text — spec Section 3, condition 3. Written and
// approved by Mason (legal review, 2026-09-05); see
// owner-tenant-notes/staff-guidance.md Section 1 for the reasoning.
const TIER_ACCESS_ACK_MESSAGE =
  "Before you continue: this section can contain Fair Housing complaints, discrimination allegations, threats, restraining orders, and other sensitive disputes — for any property in the portfolio, not just the ones you normally handle. You have this access because property manager coverage at Rincon is portfolio-wide: you may be asked to step in on a property that isn't normally yours, and this is where the sensitive facts about it live.\n\n" +
  "Open a note only when you have an actual work reason to look. Browsing without one is a confidentiality violation — the same as misusing any other sensitive tenant or owner information — and every time you view a note at this level, it is logged: who, what property, and when.\n\n" +
  "Most important: nothing in this section should change how you treat a tenant. A Fair Housing complaint or a dispute is a fact to be aware of, not a reason to treat someone differently — doing that is retaliation, and it is illegal.\n\n" +
  "You'll only see this notice once.";

async function requireTierAccessAcknowledgment(req, res) {
  if (!TIER_ACCESS_ACK_APPLICABLE_ROLES.includes(req.ownerTenantNotesRole)) return true;
  let acknowledged;
  try {
    acknowledged = await hasAcknowledgedTierAccess(req.user.email);
  } catch (err) {
    res.status(500).json({ error: err.message });
    return false;
  }
  if (!acknowledged) {
    res.status(403).json({ error: 'tier_access_acknowledgment_required', message: TIER_ACCESS_ACK_MESSAGE });
    return false;
  }
  return true;
}

// Read-event audit logging (spec Section 3 condition 1 / Section 9's new
// `operational_notes.viewed` row) — "Logged on every view of a
// management_compliance_restricted/legal_privileged note, not just
// Operational-tier notes." Deliberately does NOT log Operational-tier
// views — this is the load-bearing safeguard for the portfolio-wide
// property_manager/pod_lead grant specifically, not a general access log.
// Fire-and-forget per note (log-and-continue on failure, same as every
// other writeAuditLog call site in this codebase) — never blocks the
// response the viewer is waiting on.
async function logNotesViewed(rows, req) {
  const sensitiveRows = (rows || []).filter((r) => r.access_tier === 'management_compliance_restricted' || r.access_tier === 'legal_privileged');
  await Promise.all(sensitiveRows.map((r) => writeAuditLog({
    action: 'operational_notes.viewed',
    entity_type: 'operational_note',
    entity_id: r.id,
    actor_email: req.user.email,
    risk_level: 'low',
    details: { note_id: r.id, property_id: r.property_id, access_tier: r.access_tier, actor_role: req.ownerTenantNotesRole },
  })));
}

// ============================================================
// SECTION 5: Router
// ============================================================
const router = express.Router();
router.use(attachOwnerTenantNotesRole);

router.get('/api/owner-tenant-notes/auth/me', requireOwnerTenantNotesAccess, (req, res) => {
  res.json({
    email: req.user.email,
    name: req.ownerTenantNotesMemberName || req.user.email,
    role: req.ownerTenantNotesRole,
    max_tier: OWNER_TENANT_NOTES_ROLE_MAX_TIER[req.ownerTenantNotesRole] || null,
    can_author_legal_privileged: req.ownerTenantNotesRole === 'admin',
    review_role: OWNER_TENANT_NOTES_REVIEW_ROLES.includes(req.ownerTenantNotesRole),
  });
});

// ─── POST /api/owner-tenant-notes/tier-access/acknowledge ───────────────
// Spec Section 3 condition 2. Role-gated to TIER_ACCESS_ACK_APPLICABLE_ROLES
// — anyone outside that set never needs this and can't legally reach
// Tier 2/3 content anyway. Idempotent, same check-then-insert shape as
// maintenance-history/router.js's own privacy-queue acknowledge route.
router.post('/api/owner-tenant-notes/tier-access/acknowledge', requireOwnerTenantNotesRole(...TIER_ACCESS_ACK_APPLICABLE_ROLES), async (req, res) => {
  try {
    const already = await hasAcknowledgedTierAccess(req.user.email);
    if (!already) {
      const ok = await writeAuditLog({
        action: TIER_ACCESS_ACK_ACTION,
        entity_type: 'team_member',
        entity_id: req.teamMemberId,
        actor_email: req.user.email,
        details: { role: req.ownerTenantNotesRole },
      });
      // Unlike writeAuditLog's other call sites, a failed write here must
      // fail the request — this IS the acknowledgment record itself.
      if (!ok) return res.status(500).json({ error: 'Could not save acknowledgment.' });
    }
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SECTION 6: Note creation — manual notes only (spec Section 8's AI-
// extraction path is explicitly out of scope for this build).
// ============================================================

// Derogatory-language soft-warning message, shown to the author on
// success — never blocks submission (spec Section 7). Final text written
// and approved by Mason (legal review, 2026-09-05); see
// owner-tenant-notes/staff-guidance.md Section 2.
const DEROGATORY_LANGUAGE_WARNING =
  "This note may describe a characterization rather than an objectively stated fact — for example, 'difficult tenant' describes the person, while 'tenant declined the last three proposed access times' describes what happened. Words like these aren't always wrong (e.g. 'difficult access due to a locked gate' is a legitimate fact) — but if this note labels a person rather than describing an event, consider rephrasing to state what was said or done, and when. This is a suggestion only — your note was saved as written.";

// Shared field validation — the property/unit/subject_type/subject_id/
// note_text/access_tier checks every note-creation path needs, regardless
// of source. Factored out this pass (previously inline only in the manual
// POST route below) so `proposeAINote` (the new ai_proposed creation path)
// runs the exact same checks rather than a second hand-typed copy that
// could quietly drift from this one over time — the same "derive, don't
// duplicate" discipline this file already uses for
// OWNER_TENANT_NOTES_REVIEW_ROLES. Returns { error, status } on the first
// failing check, or { ok: true } — every check here is presence/shape
// validation and existence lookups, not a role/authorship decision (those
// differ by source and stay in each route/function separately).
async function validateNoteCoreFields({ property_id, unit_id, subject_type, subject_id, note_text, access_tier }) {
  if (!isValidUuid(property_id)) {
    return { error: 'property_id is required and must be a valid property ID.', status: 400 };
  }
  if (unit_id != null && unit_id !== '' && !isValidUuid(unit_id)) {
    return { error: 'unit_id must be a valid unit ID, or omitted.', status: 400 };
  }
  if (!['owner', 'tenant', 'property'].includes(subject_type)) {
    return { error: "subject_type must be 'owner', 'tenant', or 'property'.", status: 400 };
  }
  if (subject_type === 'property' && subject_id) {
    return { error: "subject_id must be omitted when subject_type is 'property'.", status: 400 };
  }
  if (subject_id != null && subject_id !== '' && !isValidUuid(subject_id)) {
    return { error: 'subject_id must be a valid ID, or omitted.', status: 400 };
  }
  if (typeof note_text !== 'string' || !note_text.trim()) {
    return { error: 'note_text is required.', status: 400 };
  }
  if (!NOTE_TIERS.includes(access_tier)) {
    return { error: `access_tier must be one of: ${NOTE_TIERS.join(', ')}.`, status: 400 };
  }

  const { data: property, error: propErr } = await supabase
    .from('properties').select('id').eq('id', property_id).maybeSingle();
  if (propErr) return { error: propErr.message, status: 500 };
  if (!property) return { error: 'Property not found.', status: 404 };

  if (unit_id) {
    const { data: unit, error: unitErr } = await supabase
      .from('units').select('id').eq('id', unit_id).eq('property_id', property_id).maybeSingle();
    if (unitErr) return { error: unitErr.message, status: 500 };
    if (!unit) return { error: 'That unit was not found on this property.', status: 404 };
  }

  return { ok: true };
}

router.post('/api/owner-tenant-notes', requireOwnerTenantNotesAccess, async (req, res) => {
  const { property_id, unit_id, subject_type, subject_id, note_text, category, access_tier } = req.body;

  const validation = await validateNoteCoreFields({ property_id, unit_id, subject_type, subject_id, note_text, access_tier });
  if (!validation.ok) return res.status(validation.status).json({ error: validation.error });

  // Spec Section 3: maintenance_coordinator's whole grant on this tool
  // excludes tenant-subject content, authorship included — see
  // roleCanAccessSubjectType's own comment for why this isn't relaxed by
  // the general "any role can author any tier" rule below.
  if (!roleCanAccessSubjectType(req.ownerTenantNotesRole, subject_type)) {
    return res.status(403).json({ error: 'Your role cannot author tenant-subject notes on this tool.' });
  }

  // Spec Section 3: "Any team member holding any real role for this tool
  // can author a note at any tier, including a tier they cannot themselves
  // read back... The one exception: only admin may author a note declared
  // legal_privileged."
  if (access_tier === 'legal_privileged' && req.ownerTenantNotesRole !== 'admin') {
    return res.status(403).json({ error: 'Only admin may author a Legal/Privileged note.' });
  }

  // Deliberately no requireTierAccessAcknowledgment() call here, even when
  // access_tier is management_compliance_restricted/legal_privileged —
  // confirmed by Peter, 2026-09-05 (Judge flagged this as worth
  // confirming, not a bug): the acknowledgment gate exists to warn someone
  // before they see SOMEONE ELSE'S restricted content for the first time;
  // authoring your own note isn't "seeing" restricted content, it's
  // writing text the author already knows. Not an oversight.

  // ── The two-layer content check (spec Section 5) — Layer 1
  // (protected-class-terms.js, unchanged) + Layer 2 (this build's new
  // classification-only Claude call, note-content-check.js). Runs on
  // EVERY manual note's note_text, regardless of declared access_tier —
  // a note authored at management_compliance_restricted or
  // legal_privileged is not exempt just because it's already "in the
  // restricted tier" (spec Section 6's own worked example — an
  // owner_instruction_rejected note IS expected to trip this and land in
  // human review, even though it's filed straight into the restricted
  // tier at authorship).
  let check;
  try {
    check = await checkManualNoteContent(note_text);
  } catch (err) {
    console.error('[owner-tenant-notes] content check failed unexpectedly:', err.message);
    return res.status(500).json({ error: 'Could not complete the content check for this note. Please try again.' });
  }

  // Soft, non-blocking derogatory-language warning (spec Section 7) —
  // never stored, never affects access_tier/flagged_protected_class,
  // purely an ephemeral response field for the author to see.
  const derogatoryScan = scanDerogatoryLanguage(note_text);

  const insertRow = {
    property_id,
    unit_id: unit_id || null,
    subject_type,
    subject_id: subject_type === 'property' ? null : (subject_id || null),
    note_text: note_text.trim(),
    category: category ? String(category).trim() : null,
    access_tier,
    source: 'manual',
    author_team_member_id: req.teamMemberId,
    extracted_by: null,
    approval_status: null,
    flagged_protected_class: check.flagged_protected_class,
    flagged_category: check.flagged_category,
  };

  const { data: inserted, error: insertErr } = await supabase
    .from('operational_notes').insert(insertRow).select().single();
  if (insertErr) return res.status(500).json({ error: insertErr.message });

  // Rule 1 audit trail (spec Section 9) — creation event, risk_level
  // elevated for anything filed directly above Operational tier.
  await writeAuditLog({
    action: 'operational_notes.created',
    entity_type: 'operational_note',
    entity_id: inserted.id,
    actor_email: req.user.email,
    property_id,
    risk_level: access_tier === 'operational' ? 'low' : 'medium',
    privacy_category: 'collection',
    details: { access_tier, subject_type, actor_role: req.ownerTenantNotesRole },
  });

  if (check.flagged_protected_class) {
    await writeAuditLog({
      action: 'operational_notes.protected_class_flagged',
      entity_type: 'operational_note',
      entity_id: inserted.id,
      actor_email: req.user.email,
      property_id,
      actor_type: check.matched_layer === 'keyword' ? 'system' : 'ai_agent',
      risk_level: 'high',
      details: {
        flagged_category: check.flagged_category,
        matched_layer: check.matched_layer,
        terms_version: TERMS_VERSION,
        classifier_model: check.layer2 ? check.layer2.modelVersion : null,
      },
    });
  }

  return res.json({
    success: true,
    note: {
      id: inserted.id,
      property_id: inserted.property_id,
      unit_id: inserted.unit_id,
      subject_type: inserted.subject_type,
      subject_id: inserted.subject_id,
      note_text: inserted.note_text,
      category: inserted.category,
      access_tier: inserted.access_tier,
      flagged_protected_class: inserted.flagged_protected_class,
      review_status: inserted.review_status,
      created_at: inserted.created_at,
    },
    warnings: derogatoryScan.flagged ? { derogatory_language: true, message: DEROGATORY_LANGUAGE_WARNING } : null,
  });
});

// ============================================================
// SECTION 6b: proposeAINote — the ai_proposed creation path (spec Section
// 8, not itself built by this pass — see the file header). NOT an HTTP
// route: an exported, in-process function, same "reuse across tools"
// pattern already established in this codebase for property-360 importing
// getInsurancePropertySummary/getMaintenanceHistoryPropertySummary/etc.
// directly from other tools' router.js files — here the caller is a
// future AI pipeline (e.g. complaint-tracking's Category 6, still unbuilt)
// rather than another Hub tool's route, but the "call the function
// in-process, don't stand up a second HTTP hop for code that's already in
// the same server" shape is the same.
//
// Throws a plain Error (with a caller-readable .message) on invalid input
// or a database failure, rather than writing an HTTP response — there is
// no res object here. A caller wraps this in try/catch, same as
// property-360's own fetchInsuranceCard/etc. wrappers do around the
// functions they call in-process.
// ============================================================

// ── A REAL, GENUINE SPEC GAP, AND THE DECISION MADE HERE TO CLOSE IT ──
// operational_notes.author_team_member_id is UUID NOT NULL REFERENCES
// team_members(id). The column's own comment (migration + spec Section 4)
// says it means "who typed it (manual), or who approved the AI's draft
// (ai_proposed)" — but neither the spec nor the migration ever says what
// value this column should hold WHILE a proposal is still
// pending_approval, before anyone has approved anything yet. There is no
// sentinel/system team_members row anywhere in this schema, and NOT NULL
// requires something at insert time. This is a real gap in the spec
// itself, not a check this build is skipping.
//
// DECISION (made in this build pass, recorded here plainly as a decision,
// not a discovered fact — this has NOT been through Oracle for a spec
// amendment or through Mason/Asimov review, and should be before this
// path is ever activated for real use, per Rule 6/7 and spec Section 11):
// at proposal time, author_team_member_id is set to the team_member_id of
// whoever the proposal is routed to for review — passed in by the caller
// as `routed_to_team_member_id`, REQUIRED, not inferred or defaulted. On
// approval (see the /:id/approve route below), author_team_member_id is
// OVERWRITTEN to the real approver's team_member_id, matching the column's
// own stated final meaning once approved (which may or may not be the
// same person as who it was routed to). On decline, author_team_member_id
// is left exactly as it already is (the routed-to person) — nobody
// "approved" anything, and approval_status='declined' is itself what
// signals this was never really authored by anyone in the accountable
// sense; there is no reason to touch the column on a decline.
//
// A DELIBERATE NON-CHECK, EXPLAINED: this function does NOT require
// routed_to_team_member_id to hold any particular role on this tool (e.g.
// it does not have to be a director_of_operations, even though that's the
// complaint-tracker's own intended routing target). Being "routed to" for
// review is not the same claim as "authoring" a note — the authorship-time
// rules elsewhere in this file (roleCanAccessSubjectType,
// legal_privileged-requires-admin) are about a human who is actively
// exercising judgment about the CONTENT of a note they are creating right
// now, which is exactly what has NOT happened yet for a still-pending
// proposal. The rule that actually matters — can this specific person act
// on a note at this specific tier — is enforced once, correctly, at
// /:id/approve and /:id/decline below (the same tier-reach check every
// other reviewer-facing route in this file already uses), not duplicated
// or half-applied here at creation time.
//
// LEGAL_PRIVILEGED AT CREATION TIME: spec Section 3's "only admin may
// author a note declared legal_privileged" is an AUTHORSHIP rule, and
// nobody has authored this note yet — an AI pipeline proposing a
// legal_privileged draft is not "admin" and isn't meant to be; the
// eventual human accountable for it is not known at creation time (it
// could be whoever `routed_to_team_member_id` names, or, after escalation,
// someone else entirely). So this function does NOT check
// routed_to_team_member_id's role against 'admin' for a legal_privileged
// proposal — that would incorrectly treat "routed to" as "authored by."
// Instead, the admin-only rule is enforced at the one point it actually
// applies: only admin can ever APPROVE a legal_privileged proposal, via
// the same roleMaxTierRank tier-ceiling check already used everywhere else
// in this file (only admin's roleMaxTierRank reaches legal_privileged at
// all — no separate special-case check is needed, same reasoning
// /:id/redact's own comment already gives for the identical pattern).
//
// @param {object} params
// @param {string} params.property_id
// @param {string} [params.unit_id]
// @param {'owner'|'tenant'|'property'} params.subject_type
// @param {string} [params.subject_id]
// @param {string} params.note_text
// @param {string} [params.category]
// @param {'operational'|'management_compliance_restricted'|'legal_privileged'} params.access_tier
// @param {string} params.extracted_by - REQUIRED. The model version string for this proposal (mirrors maintenance_claims.extracted_by / extract-claims.js's own `response.model` convention) — also reused below as this audit event's actor_id/actor_version, since it already identifies which model/pipeline version drafted the note and this build does not add a second, separate "which pipeline is this" parameter the task didn't ask for.
// @param {string} params.routed_to_team_member_id - REQUIRED. A real, active team_members.id — see the design-decision comment above. The caller (e.g. the complaint-tracker) decides who this is; this function only validates that the row is real and active.
// @param {boolean} [params.modelFlag] - the drafting pipeline's own Layer-2 self-report (extract-claims.js's protected_class_flag convention). Defaults to false if omitted — Layer 1 still runs regardless.
// @param {string|null} [params.modelCategory] - paired with modelFlag (extract-claims.js's protected_class_category convention).
// @returns {Promise<{ success: true, note: object }>}
// @throws {Error} on invalid input, a missing property/unit/team member, or a database failure
async function proposeAINote({
  property_id, unit_id, subject_type, subject_id, note_text, category, access_tier,
  extracted_by, routed_to_team_member_id, modelFlag, modelCategory,
}) {
  if (typeof extracted_by !== 'string' || !extracted_by.trim()) {
    throw new Error('extracted_by is required for an AI-proposed note (the drafting model\'s version string).');
  }
  if (!isValidUuid(routed_to_team_member_id)) {
    throw new Error('routed_to_team_member_id is required and must be a valid team member ID.');
  }

  const validation = await validateNoteCoreFields({ property_id, unit_id, subject_type, subject_id, note_text, access_tier });
  if (!validation.ok) throw new Error(validation.error);

  // Confirm the routed-to team member is real and active — the FK
  // constraint would catch a nonexistent id at insert time regardless, but
  // a clear error here (same "check existence explicitly, don't rely on a
  // raw FK error" discipline validateNoteCoreFields already uses for
  // property_id/unit_id) is far more useful to a calling pipeline than a
  // raw Postgres constraint-violation message. Also rejects an inactive
  // member — same is_active gate attachOwnerTenantNotesRole already
  // applies to a human's own access to this tool; someone no longer active
  // shouldn't be the value routed to for review either.
  const { data: routedToMember, error: memberErr } = await supabase
    .from('team_members').select('id, is_active').eq('id', routed_to_team_member_id).maybeSingle();
  if (memberErr) throw new Error(memberErr.message);
  if (!routedToMember || !routedToMember.is_active) {
    throw new Error('routed_to_team_member_id must be a real, active team member.');
  }

  // The two-layer content check (spec Section 5) — Layer 1 independent and
  // unconditional; Layer 2 is the caller's own self-report, not a fresh
  // classification call (see checkAIProposedNoteContent's own header for
  // why this differs from the manual path's checkManualNoteContent).
  const check = checkAIProposedNoteContent(note_text, { modelFlag, modelCategory });

  const insertRow = {
    property_id,
    unit_id: unit_id || null,
    subject_type,
    subject_id: subject_type === 'property' ? null : (subject_id || null),
    note_text: note_text.trim(),
    category: category ? String(category).trim() : null,
    access_tier,
    source: 'ai_proposed',
    author_team_member_id: routed_to_team_member_id, // see design-decision comment above
    extracted_by: extracted_by.trim(),
    approval_status: 'pending_approval',
    flagged_protected_class: check.flagged_protected_class,
    flagged_category: check.flagged_category,
  };

  const { data: inserted, error: insertErr } = await supabase
    .from('operational_notes').insert(insertRow).select().single();
  if (insertErr) throw new Error(insertErr.message);

  // Rule 1 audit trail (spec Section 9: "Note proposed (AI)" —
  // operational_notes.ai_proposed, actor_type: ai_agent, privacy_category:
  // collection, risk_level: medium). No actor_email/performed_by — the
  // actor is a pipeline, not a Hub user; actor_id/actor_version both reuse
  // extracted_by, the one identifier this function already requires (see
  // the @param comment above for why no second identifier is added).
  await writeAuditLog({
    action: 'operational_notes.ai_proposed',
    entity_type: 'operational_note',
    entity_id: inserted.id,
    actor_type: 'ai_agent',
    actor_id: extracted_by.trim(),
    property_id,
    risk_level: 'medium',
    privacy_category: 'collection',
    details: {
      access_tier, subject_type, extracted_by: extracted_by.trim(),
      routed_to_team_member_id,
    },
  });

  // Same dual audit-log behavior the manual path uses (spec Section 9's
  // "Content-check flag" row applies to any note, not just manual ones) —
  // GOVERNANCE.md Rule 9 requires logging a protected-class exclusion/flag
  // regardless of a note's source.
  if (check.flagged_protected_class) {
    await writeAuditLog({
      action: 'operational_notes.protected_class_flagged',
      entity_type: 'operational_note',
      entity_id: inserted.id,
      actor_type: check.matched_layer === 'keyword' ? 'system' : 'ai_agent',
      actor_id: extracted_by.trim(),
      property_id,
      risk_level: 'high',
      details: {
        flagged_category: check.flagged_category,
        matched_layer: check.matched_layer,
        terms_version: TERMS_VERSION,
      },
    });
  }

  return {
    success: true,
    note: {
      id: inserted.id,
      property_id: inserted.property_id,
      unit_id: inserted.unit_id,
      subject_type: inserted.subject_type,
      subject_id: inserted.subject_id,
      note_text: inserted.note_text,
      category: inserted.category,
      access_tier: inserted.access_tier,
      source: inserted.source,
      approval_status: inserted.approval_status,
      extracted_by: inserted.extracted_by,
      flagged_protected_class: inserted.flagged_protected_class,
      created_at: inserted.created_at,
    },
  };
}

// ============================================================
// SECTION 7: Best-effort subject-name resolution — display only, never
// written anywhere. owners.name / tenants.first_name+last_name, per the
// real schema (20260720000002_owners.sql, 20260626000000_initial_
// schema.sql). Failure here never blocks the notes list — a note with an
// unresolved subject name still shows, just without a friendly label.
// ============================================================
async function resolveSubjectNames(rows) {
  const ownerIds = Array.from(new Set(rows.filter((r) => r.subject_type === 'owner' && r.subject_id).map((r) => r.subject_id)));
  const tenantIds = Array.from(new Set(rows.filter((r) => r.subject_type === 'tenant' && r.subject_id).map((r) => r.subject_id)));
  const names = {};
  try {
    if (ownerIds.length) {
      const { data } = await supabase.from('owners').select('id, name').in('id', ownerIds);
      for (const o of data || []) names[o.id] = o.name || null;
    }
    if (tenantIds.length) {
      const { data } = await supabase.from('tenants').select('id, first_name, last_name').in('id', tenantIds);
      for (const t of data || []) names[t.id] = [t.first_name, t.last_name].filter(Boolean).join(' ') || null;
    }
  } catch (err) {
    console.error('[owner-tenant-notes] subject-name resolution failed (non-fatal):', err.message);
  }
  return names;
}

// ============================================================
// SECTION 8: Per-viewer visibility — spec Section 5's operational_notes_
// visible view answers "visible to anyone at all"; this function is the
// application-layer piece the spec explicitly says the view can't do:
// per-viewer tier filtering, the maintenance_coordinator subject filter,
// and the flagged-and-unreviewed placeholder (spec Section 5: "a real,
// deliberate improvement over the existing pattern... a flagged,
// unreviewed note renders a placeholder... rather than silent absence").
//
// Implemented directly against the RAW operational_notes table (not the
// operational_notes_visible view) in one pass, reproducing that view's
// exact WHERE logic in JS below (see the inline comments) rather than
// querying the view for "included" rows and separately querying raw rows
// for placeholders — one query, one place the visibility rule lives,
// less risk of the two diverging. The view itself is still the schema's
// documented, reusable answer to "is this row eligible for anyone" (e.g.
// for any future consumer that doesn't need placeholder/per-viewer logic)
// and is untouched by this choice.
// ============================================================
function classifyNoteForViewer(row, role) {
  // operational_notes_visible's first condition: AI drafts stay invisible
  // until approved, always. No ai_proposed rows exist yet in this build
  // (Section 8 not built), but this guards correctly the day they do.
  if (row.source === 'ai_proposed' && row.approval_status !== 'approved') {
    return { include: false };
  }

  const viewerMaxRank = roleMaxTierRank(role);
  const rowTierRank = NOTE_TIER_RANK[row.access_tier] || 0;

  if (!row.flagged_protected_class) {
    // Ordinary, never-flagged row — plain tier check.
    return rowTierRank <= viewerMaxRank ? { include: true, placeholder: false } : { include: false };
  }

  if (row.review_status === 'rephrased_and_released' || row.review_status === 'false_positive_released') {
    // operational_notes_visible includes these again, at whatever tier
    // the reviewer assigned (spec Section 5) — plain tier check, same as
    // an unflagged row.
    return rowTierRank <= viewerMaxRank ? { include: true, placeholder: false } : { include: false };
  }

  if (row.review_status === 'retained_restricted') {
    // Permanently excluded from operational_notes_visible for anyone
    // below Management/Compliance-Restricted tier (spec Section 5) — for
    // a viewer AT or above that tier, this is now ordinary
    // restricted-tier content (the whole point of "retain in restricted
    // tier"), so a plain tier check against its (forced-restricted-or-
    // above) access_tier is correct.
    return rowTierRank <= viewerMaxRank ? { include: true, placeholder: false } : { include: false };
  }

  // review_status === 'unreviewed' and flagged — excluded from
  // operational_notes_visible entirely. Spec Section 5: render a
  // placeholder specifically to "anyone BELOW Management/Compliance-
  // Restricted tier who would otherwise see it at its declared
  // access_tier." A viewer AT OR ABOVE that tier is, by this file's own
  // OWNER_TENANT_NOTES_REVIEW_ROLES derivation, always review-capable —
  // same "reviewer/admin sees real content via a separate queue, never a
  // placeholder" split maintenance_claims already draws between its
  // normal ticket view (structurally excludes every flagged row, for
  // EVERYONE, admin included) and its own flagged-queue route. Excluded
  // here entirely (not shown at all in the general list) so a
  // reviewer-tier viewer isn't shown two different renderings of the same
  // unreviewed note (a placeholder here AND the real item in "Needs
  // Compliance Review" below) — the flagged-queue route is their one path
  // to it.
  if (viewerMaxRank >= NOTE_TIER_RANK.management_compliance_restricted) return { include: false };
  if (rowTierRank > viewerMaxRank) return { include: false };
  return { include: true, placeholder: true };
}

// ─── GET /api/owner-tenant-notes/property/:property_id — the listing
// behind Property 360's collapsible section. ────────────────────────────
router.get('/api/owner-tenant-notes/property/:property_id', requireOwnerTenantNotesAccess, async (req, res) => {
  const propertyId = req.params.property_id;
  if (!isValidUuid(propertyId)) {
    return res.status(400).json({ error: 'That property ID is not valid.' });
  }

  // Single query, no pagination — this is a new, low-volume-at-launch
  // data source scoped to one property (spec Section 5's own framing);
  // revisit with the same fetchAllRows pattern maintenance-history/
  // router.js uses if a property ever approaches 1000 notes.
  const { data: rows, error } = await supabase
    .from('operational_notes')
    .select('*')
    .eq('property_id', propertyId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const role = req.ownerTenantNotesRole;
  const visible = [];
  for (const row of rows || []) {
    if (!roleCanAccessSubjectType(role, row.subject_type)) continue; // maintenance_coordinator + tenant-subject — silent omission, no hint
    const classification = classifyNoteForViewer(row, role);
    if (!classification.include) continue;
    visible.push({ row, placeholder: !!classification.placeholder });
  }

  // Tier 2/3 acknowledgment gate (spec Section 3 condition 2) — fires
  // before ANY Tier 2/3 content is returned, not partially. Placeholders
  // never trigger this: a viewer who only ever sees a placeholder is, by
  // definition, below Management/Compliance-Restricted tier and so is
  // never in TIER_ACCESS_ACK_APPLICABLE_ROLES to begin with.
  const hasSensitiveContent = visible.some((v) => !v.placeholder && (v.row.access_tier === 'management_compliance_restricted' || v.row.access_tier === 'legal_privileged'));
  if (hasSensitiveContent) {
    if (!(await requireTierAccessAcknowledgment(req, res))) return;
  }

  const names = await resolveSubjectNames(visible.filter((v) => !v.placeholder).map((v) => v.row));

  const notes = visible.map(({ row, placeholder }) => {
    if (placeholder) {
      // Minimal shape — never the real note_text, category, or
      // flagged_category (Rule 4: flagged_category "could indirectly
      // reveal the sensitive topic without containing it").
      return {
        id: row.id,
        property_id: row.property_id,
        subject_type: row.subject_type,
        access_tier: row.access_tier,
        created_at: row.created_at,
        pending_review: true,
        note_text: 'A note here is pending compliance review.',
      };
    }
    return {
      id: row.id,
      property_id: row.property_id,
      unit_id: row.unit_id,
      subject_type: row.subject_type,
      subject_id: row.subject_id,
      subject_name: row.subject_id ? (names[row.subject_id] || null) : null,
      note_text: row.note_text,
      category: row.category,
      access_tier: row.access_tier,
      flagged_protected_class: row.flagged_protected_class,
      review_status: row.review_status,
      created_at: row.created_at,
      pending_review: false,
    };
  });

  // Read-event audit logging (spec Section 3/9) — only for real (non-
  // placeholder) Tier 2/3 rows actually being returned.
  await logNotesViewed(visible.filter((v) => !v.placeholder).map((v) => v.row), req);

  return res.json({ notes });
});

// ─── GET /api/owner-tenant-notes/property/:property_id/flagged-queue ────
// The reviewer-facing queue — real content (not a placeholder), for
// OWNER_TENANT_NOTES_REVIEW_ROLES only. Per-property, one item at a time
// (spec Section 5's own "not required for v1" on grouped/bulk review).
router.get(
  '/api/owner-tenant-notes/property/:property_id/flagged-queue',
  requireOwnerTenantNotesRole(...OWNER_TENANT_NOTES_REVIEW_ROLES),
  async (req, res) => {
    const propertyId = req.params.property_id;
    const role = req.ownerTenantNotesRole;
    if (!isValidUuid(propertyId)) {
      return res.status(400).json({ error: 'That property ID is not valid.' });
    }
    if (!(await requireTierAccessAcknowledgment(req, res))) return;

    const { data: allRows, error } = await supabase
      .from('operational_notes')
      .select('*')
      .eq('property_id', propertyId)
      .eq('flagged_protected_class', true)
      .eq('review_status', 'unreviewed')
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    // Added this pass, now that ai_proposed rows can actually exist: a
    // still-pending (or declined) AI proposal that also happens to trip
    // the content check must NOT surface its real note_text here just
    // because it's flagged — that would let a Fair Housing content
    // reviewer read an AI draft's full text before anyone has approved its
    // very existence as a note at all, contradicting this file's own
    // "AI drafts stay invisible until approved, always" rule
    // (classifyNoteForViewer's first check, and operational_notes_visible's
    // own first WHERE condition). This route queries the raw table
    // directly (not the view) and, until now, had no reason to also check
    // source/approval_status — nothing could produce an ai_proposed row
    // yet. Same exclusion the view already applies, reproduced here since
    // this route bypasses the view (same "one rule, two evaluation sites"
    // situation classifyNoteForViewer's own header comment already
    // documents for the same reason).
    const reviewEligibleRows = (allRows || []).filter((row) => row.source === 'manual' || row.approval_status === 'approved');

    // Being in OWNER_TENANT_NOTES_REVIEW_ROLES (Management/Compliance-
    // Restricted tier or above) does NOT mean every tier is within this
    // specific viewer's reach — e.g. a property_manager/pod_lead/reviewer/
    // director_of_operations caps out at management_compliance_restricted
    // and must never see a legal_privileged note's real text here, same
    // as anywhere else on this tool (only admin reaches legal_privileged,
    // spec Section 3). A plain per-row tier check, same as
    // classifyNoteForViewer uses elsewhere.
    const viewerMaxRank = roleMaxTierRank(role);
    const rows = reviewEligibleRows.filter((row) => (NOTE_TIER_RANK[row.access_tier] || 0) <= viewerMaxRank);

    const names = await resolveSubjectNames(rows || []);
    const items = (rows || []).map((row) => ({
      id: row.id,
      property_id: row.property_id,
      unit_id: row.unit_id,
      subject_type: row.subject_type,
      subject_id: row.subject_id,
      subject_name: row.subject_id ? (names[row.subject_id] || null) : null,
      note_text: row.note_text,
      category: row.category,
      access_tier: row.access_tier,
      flagged_category: row.flagged_category,
      created_at: row.created_at,
    }));

    await logNotesViewed(rows || [], req);
    return res.json({ items });
  }
);

// ============================================================
// SECTION 9: applyNoteReviewDisposition — spec Section 5, sibling to
// maintenance-history/router.js's applyReviewAction, NOT a fork of it.
// Genuinely different outcome model (see the migration's own comment on
// operational_notes.review_status): two of the three dispositions here
// must make a note visible again, which applyReviewAction's confirm/
// correct/reject vocabulary was never designed to express.
// ============================================================
router.post(
  '/api/owner-tenant-notes/:id/review',
  requireOwnerTenantNotesRole(...OWNER_TENANT_NOTES_REVIEW_ROLES),
  async (req, res) => {
    const { action, note_text, access_tier, reviewer_notes } = req.body;
    if (!isValidUuid(req.params.id)) {
      return res.status(400).json({ error: 'That id is not valid.' });
    }
    if (!['retained_restricted', 'rephrased_and_released', 'false_positive_released'].includes(action)) {
      return res.status(400).json({ error: "action must be 'retained_restricted', 'rephrased_and_released', or 'false_positive_released'." });
    }

    const { data: before, error: beforeErr } = await supabase
      .from('operational_notes')
      .select('id, access_tier, flagged_protected_class, review_status, property_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (beforeErr) return res.status(500).json({ error: beforeErr.message });
    if (!before) return res.status(404).json({ error: 'Note not found.' });

    // Same tier-reach check as the flagged-queue route above — being in
    // OWNER_TENANT_NOTES_REVIEW_ROLES does not mean every tier is within
    // THIS viewer's own reach. A property_manager/pod_lead/reviewer/
    // director_of_operations must never be able to act on (or, via the
    // updated row this route returns, read) a legal_privileged note —
    // only admin reaches that tier, spec Section 3.
    if ((NOTE_TIER_RANK[before.access_tier] || 0) > roleMaxTierRank(req.ownerTenantNotesRole)) {
      return res.status(403).json({ error: 'Your role cannot review a note at this access tier.' });
    }

    // This route's entire disposition model (retain/rephrase/false-positive)
    // only makes sense against a note that is actually flagged and still
    // awaiting a human decision — added 2026-09-05 after Judge found this
    // was ASSERTED in a comment further down ("this route only ever runs
    // against flagged rows") but never actually enforced, which meant the
    // route could be called against any arbitrary note at all, flagged or
    // not, already-reviewed or not.
    if (!before.flagged_protected_class || before.review_status !== 'unreviewed') {
      return res.status(409).json({ error: 'This note is not currently flagged and awaiting compliance review.' });
    }

    if (!(await requireTierAccessAcknowledgment(req, res))) return;

    // Rule 1 audit trail (spec Section 3/9) — this route reads a Tier 2/3
    // note (and, for rephrased_and_released, returns its full updated row
    // including note_text) before/after applying a disposition. Added
    // 2026-09-05 after Judge found this route wasn't logging that read,
    // unlike the listing and flagged-queue routes above, which do.
    // logNotesViewed itself already filters to management_compliance_
    // restricted/legal_privileged rows only — an Operational-tier `before`
    // here is silently skipped, same intentional exclusion as everywhere
    // else in this file.
    await logNotesViewed([before], req);

    // rephrased_and_released: note_text is REQUIRED — spec Section 5's
    // table, "same required-field discipline applyReviewAction's own
    // 'correct' action already enforces."
    if (action === 'rephrased_and_released' && (typeof note_text !== 'string' || !note_text.trim())) {
      return res.status(400).json({ error: 'note_text is required when rephrasing and releasing a note.' });
    }

    const reviewerEmail = req.user.email;
    const updates = {
      review_status: action,
      reviewed_by: reviewerEmail,
      reviewed_at: new Date().toISOString(),
      reviewer_notes: reviewer_notes || null,
    };

    if (action === 'retained_restricted') {
      // "Forced to (or confirmed as) management_compliance_restricted —
      // never lowered." A reviewer MAY optionally raise it further to
      // legal_privileged (own choice), but can never lower below the
      // current tier or below management_compliance_restricted.
      const currentRank = NOTE_TIER_RANK[before.access_tier] || 0;
      const restrictedRank = NOTE_TIER_RANK.management_compliance_restricted;
      let requestedRank = null;
      if (access_tier != null && access_tier !== '') {
        if (!NOTE_TIERS.includes(access_tier)) {
          return res.status(400).json({ error: `access_tier must be one of: ${NOTE_TIERS.join(', ')}.` });
        }
        // Ceiling guard (see tierWithinCallerReach above) — added
        // 2026-09-05, Judge's finding: without this, a property_manager
        // could pass access_tier: 'legal_privileged' here and have it
        // accepted, because only before.access_tier (the note's CURRENT
        // tier) was ever checked against the caller's role — never the
        // NEW tier being requested in this same request body.
        if (!tierWithinCallerReach(access_tier, req.ownerTenantNotesRole)) {
          return res.status(403).json({ error: 'Your role cannot set a note to this access tier.' });
        }
        requestedRank = NOTE_TIER_RANK[access_tier];
      }
      const targetRank = Math.max(currentRank, restrictedRank, requestedRank || 0);
      updates.access_tier = NOTE_TIERS.find((t) => NOTE_TIER_RANK[t] === targetRank);
      // note_text: "Unchanged, unless the reviewer also edits it."
      if (typeof note_text === 'string' && note_text.trim()) updates.note_text = note_text.trim();
    } else if (action === 'rephrased_and_released') {
      updates.note_text = note_text.trim();
      // "Reviewer's choice, typically downgraded to operational" — any
      // valid tier is accepted here, including a lower one (this
      // disposition's whole purpose allows loosening, unlike
      // retained_restricted above).
      if (access_tier != null && access_tier !== '') {
        if (!NOTE_TIERS.includes(access_tier)) {
          return res.status(400).json({ error: `access_tier must be one of: ${NOTE_TIERS.join(', ')}.` });
        }
        // Same ceiling guard as retained_restricted above — this
        // disposition allows LOWERING a tier freely (its whole purpose),
        // but must never allow RAISING one above the caller's own role
        // ceiling. Added 2026-09-05, same Judge finding as above.
        if (!tierWithinCallerReach(access_tier, req.ownerTenantNotesRole)) {
          return res.status(403).json({ error: 'Your role cannot set a note to this access tier.' });
        }
        updates.access_tier = access_tier;
      }
    }
    // false_positive_released: note_text and access_tier both "unchanged
    // (whatever the author originally declared)" — no body fields applied.

    const { data: updated, error: updateErr } = await supabase
      .from('operational_notes').update(updates).eq('id', req.params.id).select().single();
    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // Every disposition here is, by construction, on originally-flagged
    // content (this route only ever runs against flagged rows) — same
    // asymmetry maintenance_claims.reviewed already uses: retaining in
    // restriction is 'low' (no new exposure), the two release dispositions
    // are 'medium' (previously-flagged content becomes visible again).
    await writeAuditLog({
      action: 'operational_notes.reviewed',
      entity_type: 'operational_note',
      entity_id: before.id,
      actor_email: reviewerEmail,
      property_id: before.property_id,
      risk_level: action === 'retained_restricted' ? 'low' : 'medium',
      details: {
        review_status: action,
        reviewer_notes: updates.reviewer_notes,
        actor_role: req.ownerTenantNotesRole,
        previous_access_tier: before.access_tier,
        new_access_tier: updated.access_tier,
      },
    });

    return res.json({ success: true, note: updated });
  }
);

// ============================================================
// SECTION 9b: AI-proposal review — approve/decline a pending ai_proposed
// note, plus the queue route a reviewer uses to find one (added this pass;
// proposeAINote above is what creates the rows these routes act on).
//
// Gated the same way as /:id/review and /:id/correct above:
// OWNER_TENANT_NOTES_REVIEW_ROLES at the route level (a role must reach at
// least Management/Compliance-Restricted tier to review ANYTHING on this
// tool, same as every other reviewer-facing route here — spec Section 5:
// "a human reviewer holding Management/Compliance-Restricted tier or
// above"), then a per-row tier-ceiling check against the SPECIFIC note's
// own access_tier. That second check is also, with no separate
// special-case code, exactly how "legal_privileged specifically requires
// admin" is enforced here — only admin's roleMaxTierRank reaches
// legal_privileged at all (Section 1 above), same reasoning /:id/redact's
// own comment already gives for the identical pattern.
// ============================================================

// ─── GET /api/owner-tenant-notes/property/:property_id/pending-approval ──
// Mirrors the flagged-queue route's shape exactly (per-property, real
// content not a placeholder, REVIEW_ROLES-gated) — the queue a reviewer
// uses to find an ai_proposed note actually awaiting their decision,
// requested explicitly per the task brief ("so a reviewer can actually
// find what needs approving").
router.get(
  '/api/owner-tenant-notes/property/:property_id/pending-approval',
  requireOwnerTenantNotesRole(...OWNER_TENANT_NOTES_REVIEW_ROLES),
  async (req, res) => {
    const propertyId = req.params.property_id;
    const role = req.ownerTenantNotesRole;
    if (!isValidUuid(propertyId)) {
      return res.status(400).json({ error: 'That property ID is not valid.' });
    }
    if (!(await requireTierAccessAcknowledgment(req, res))) return;

    const { data: allRows, error } = await supabase
      .from('operational_notes')
      .select('*')
      .eq('property_id', propertyId)
      .eq('source', 'ai_proposed')
      .eq('approval_status', 'pending_approval')
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    // Same tier-reach filter as the flagged-queue route above — being
    // REVIEW-capable at all does not mean every tier is within THIS
    // viewer's own reach.
    const viewerMaxRank = roleMaxTierRank(role);
    const rows = (allRows || []).filter((row) => (NOTE_TIER_RANK[row.access_tier] || 0) <= viewerMaxRank);

    const names = await resolveSubjectNames(rows || []);
    const items = (rows || []).map((row) => ({
      id: row.id,
      property_id: row.property_id,
      unit_id: row.unit_id,
      subject_type: row.subject_type,
      subject_id: row.subject_id,
      subject_name: row.subject_id ? (names[row.subject_id] || null) : null,
      note_text: row.note_text,
      category: row.category,
      access_tier: row.access_tier,
      flagged_protected_class: row.flagged_protected_class,
      flagged_category: row.flagged_category,
      extracted_by: row.extracted_by,
      created_at: row.created_at,
    }));

    await logNotesViewed(rows || [], req);
    return res.json({ items });
  }
);

// Shared existence/eligibility/tier-reach load for both /:id/approve and
// /:id/decline below — same "one place the rule lives" reasoning as
// validateNoteCoreFields above, so the two routes' guards can't drift
// apart. Returns { before } on success, or writes the error response
// itself and returns { before: null } (caller returns immediately on
// that, same calling convention requireTierAccessAcknowledgment already
// uses in this file).
async function loadPendingAIProposalForReview(req, res) {
  if (!isValidUuid(req.params.id)) {
    res.status(400).json({ error: 'That id is not valid.' });
    return { before: null };
  }

  const { data: before, error: beforeErr } = await supabase
    .from('operational_notes')
    .select('id, access_tier, source, approval_status, author_team_member_id, property_id, note_text')
    .eq('id', req.params.id)
    .maybeSingle();
  if (beforeErr) {
    res.status(500).json({ error: beforeErr.message });
    return { before: null };
  }
  if (!before) {
    res.status(404).json({ error: 'Note not found.' });
    return { before: null };
  }

  if (before.source !== 'ai_proposed' || before.approval_status !== 'pending_approval') {
    res.status(409).json({ error: 'This note is not an AI proposal currently awaiting approval.' });
    return { before: null };
  }

  // Same tier-reach check as /:id/review, /:id/correct, /:id/redact above.
  if ((NOTE_TIER_RANK[before.access_tier] || 0) > roleMaxTierRank(req.ownerTenantNotesRole)) {
    res.status(403).json({ error: 'Your role cannot review a note at this access tier.' });
    return { before: null };
  }

  if (!(await requireTierAccessAcknowledgment(req, res))) return { before: null };

  // Approving/declining means reading this note's real content to decide
  // — same read-event audit logging every other route that exposes a
  // Tier 2/3 note's real text already does (logNotesViewed itself already
  // no-ops for Operational-tier rows).
  await logNotesViewed([before], req);

  return { before };
}

// ─── POST /api/owner-tenant-notes/:id/approve ────────────────────────────
router.post(
  '/api/owner-tenant-notes/:id/approve',
  requireOwnerTenantNotesRole(...OWNER_TENANT_NOTES_REVIEW_ROLES),
  async (req, res) => {
    const { before } = await loadPendingAIProposalForReview(req, res);
    if (!before) return; // loadPendingAIProposalForReview already wrote the error response

    const approverTeamMemberId = req.teamMemberId;
    const { data: updated, error: updateErr } = await supabase
      .from('operational_notes')
      .update({
        approval_status: 'approved',
        // Overwrite to the real approver — matches author_team_member_id's
        // own stated final meaning once approved (see proposeAINote's
        // design-decision comment above for the full reasoning; this is
        // the other half of that same decision).
        author_team_member_id: approverTeamMemberId,
      })
      .eq('id', req.params.id)
      .select()
      .single();
    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // Rule 1 audit trail (spec Section 9: "AI proposal approved/declined" —
    // operational_notes.approval_decided, actor_type: human,
    // privacy_category: processing, risk_level: low).
    await writeAuditLog({
      action: 'operational_notes.approval_decided',
      entity_type: 'operational_note',
      entity_id: before.id,
      actor_email: req.user.email,
      property_id: before.property_id,
      risk_level: 'low',
      privacy_category: 'processing',
      details: {
        outcome: 'approved',
        actor_role: req.ownerTenantNotesRole,
        approver_team_member_id: approverTeamMemberId,
        previous_author_team_member_id: before.author_team_member_id,
      },
    });

    return res.json({ success: true, note: updated });
  }
);

// ─── POST /api/owner-tenant-notes/:id/decline ────────────────────────────
// note_text/access_tier/author_team_member_id all left exactly as they
// are — never delete a declined proposal (this file's own "never silently
// drop anything" discipline, same reasoning as applyStandardRedaction's
// comment above); it simply stays permanently invisible via
// classifyNoteForViewer's/operational_notes_visible's existing
// "ai_proposed AND NOT approved" exclusion — no new visibility code was
// needed for this, it already works (see the file header note on this
// pass).
router.post(
  '/api/owner-tenant-notes/:id/decline',
  requireOwnerTenantNotesRole(...OWNER_TENANT_NOTES_REVIEW_ROLES),
  async (req, res) => {
    const { before } = await loadPendingAIProposalForReview(req, res);
    if (!before) return; // loadPendingAIProposalForReview already wrote the error response

    const { decline_reason } = req.body;
    const { data: updated, error: updateErr } = await supabase
      .from('operational_notes')
      .update({ approval_status: 'declined' })
      .eq('id', req.params.id)
      .select()
      .single();
    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // decline_reason (optional, free text from the reviewer) is recorded
    // only in the audit log's details — never written onto the row itself,
    // per the task's own "note_text/everything else untouched" instruction
    // (reviewer_notes is this table's own column for the /:id/review
    // disposition workflow's reviewer commentary, a different, unrelated
    // workflow — reusing it here would blur two genuinely separate review
    // concerns, the same distinction spec Section 5 already draws between
    // this table's approval_status and review_status columns).
    await writeAuditLog({
      action: 'operational_notes.approval_decided',
      entity_type: 'operational_note',
      entity_id: before.id,
      actor_email: req.user.email,
      property_id: before.property_id,
      risk_level: 'low',
      privacy_category: 'processing',
      details: {
        outcome: 'declined',
        actor_role: req.ownerTenantNotesRole,
        decline_reason: typeof decline_reason === 'string' && decline_reason.trim() ? decline_reason.trim() : null,
      },
    });

    return res.json({ success: true, note: updated });
  }
);

// ============================================================
// SECTION 10: Post-hoc correction (spec Section 9, counsel's item J) and
// redaction — standard path for operational/management_compliance_
// restricted tiers, plus the admin-only disposition flow for
// legal_privileged notes (Mason's design, Peter's no-outside-attorney-
// sign-off-required decision, 2026-09-05 — see POST /:id/redact's own
// comment). Both routes available to admin/director_of_operations/
// reviewer for this tool at minimum, per spec Section 9 — narrower than
// "anyone can edit anything," and further narrowed to admin-only for
// legal_privileged specifically by the tier-ceiling check each route
// applies against `before.access_tier`.
// ============================================================
const CORRECTION_ROLES = ['admin', 'director_of_operations', 'reviewer'];

router.post('/api/owner-tenant-notes/:id/correct', requireOwnerTenantNotesRole(...CORRECTION_ROLES), async (req, res) => {
  const { note_text } = req.body;
  if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'That id is not valid.' });
  if (typeof note_text !== 'string' || !note_text.trim()) {
    return res.status(400).json({ error: 'note_text is required.' });
  }

  const { data: before, error: beforeErr } = await supabase
    .from('operational_notes').select('id, note_text, property_id, access_tier').eq('id', req.params.id).maybeSingle();
  if (beforeErr) return res.status(500).json({ error: beforeErr.message });
  if (!before) return res.status(404).json({ error: 'Note not found.' });

  // Same tier-reach check as /:id/review above — CORRECTION_ROLES includes
  // director_of_operations/reviewer, both capped at management_compliance_
  // restricted, and this route's own response echoes back the note's real
  // text — without this check, either role could read (and overwrite) a
  // legal_privileged note's content purely by calling this endpoint,
  // bypassing the "only admin reaches legal_privileged" rule everywhere
  // else in this file.
  if ((NOTE_TIER_RANK[before.access_tier] || 0) > roleMaxTierRank(req.ownerTenantNotesRole)) {
    return res.status(403).json({ error: 'Your role cannot correct a note at this access tier.' });
  }

  if (!(await requireTierAccessAcknowledgment(req, res))) return;

  // Rule 1 audit trail (spec Section 3/9) — this route reads (in `before`)
  // and then returns (in `updated`) the note's real current note_text.
  // Added 2026-09-05 after Judge found this route wasn't logging that
  // read, unlike the listing and flagged-queue routes above, which do.
  await logNotesViewed([before], req);

  const { data: updated, error: updateErr } = await supabase
    .from('operational_notes').update({ note_text: note_text.trim() }).eq('id', req.params.id).select().single();
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  // GOVERNANCE.md Rule 6: corrections log old and new values. Real
  // content correction (not deletion) — unlike redaction below, logging
  // the actual old/new text here is the whole point (Rule 6's own
  // requirement) and does not itself destroy anything.
  await writeAuditLog({
    action: 'operational_notes.corrected',
    entity_type: 'operational_note',
    entity_id: before.id,
    actor_email: req.user.email,
    property_id: before.property_id,
    risk_level: 'low',
    details: { old_note_text: before.note_text, new_note_text: updated.note_text, actor_role: req.ownerTenantNotesRole },
  });

  return res.json({ success: true, note: updated });
});

// Shared standard-redaction mechanics — note_text/reviewer_notes ->
// "[REDACTED]", preserving subject_type/category/access_tier/dates (same
// convention as maintenance_claims.claim_text). subject_id is left intact
// (needed for "every row about a specific person is a manual lookup via
// subject_id/property_id" per the schema's own Rule 4 note). Used by the
// standard-tier path below AND by the legal_privileged
// no_hold_confirmed_safe disposition, so the two paths can never drift
// apart on what "redacted" actually means.
async function applyStandardRedaction(before, req) {
  const updates = { note_text: '[REDACTED]' };
  if (before.reviewer_notes) updates.reviewer_notes = '[REDACTED]';

  const { data: updated, error: updateErr } = await supabase
    .from('operational_notes').update(updates).eq('id', before.id).select().single();
  if (updateErr) return { error: updateErr };

  // Deliberately NOT logging old_note_text here — the entire point of a
  // redaction is removing sensitive content; writing the real old text
  // into audit_log.details would defeat that. A boolean marker is enough
  // of an audit trail for "this note was redacted, by whom, when."
  await writeAuditLog({
    action: 'operational_notes.corrected',
    entity_type: 'operational_note',
    entity_id: before.id,
    actor_email: req.user.email,
    property_id: before.property_id,
    risk_level: 'medium',
    details: { redacted: true, reason: 'ccpa_deletion_request', actor_role: req.ownerTenantNotesRole },
  });

  return { updated };
}

// POST /:id/redact — standard redaction for operational/management_
// compliance_restricted notes (unchanged behavior), plus the real
// admin-only disposition flow for legal_privileged notes: designed by
// Mason in an earlier review round, with one explicit change Peter made on
// top of it — the determination stays entirely an admin call, no outside
// attorney sign-off required per request (Mason's original design wanted
// that; Peter declined it). This endpoint never auto-redacts a
// legal_privileged note: it requires an admin to submit an explicit
// disposition every time it's hit for one. There is no third "ambiguous"
// action — per Mason's design, "unresolved" just means an admin hasn't
// decided yet, so the note stays untouched until one actually calls this
// endpoint with a real disposition.
router.post('/api/owner-tenant-notes/:id/redact', requireOwnerTenantNotesRole(...CORRECTION_ROLES), async (req, res) => {
  if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'That id is not valid.' });

  const { data: before, error: beforeErr } = await supabase
    .from('operational_notes')
    .select('id, access_tier, property_id, reviewer_notes, subject_type, subject_id')
    .eq('id', req.params.id).maybeSingle();
  if (beforeErr) return res.status(500).json({ error: beforeErr.message });
  if (!before) return res.status(404).json({ error: 'Note not found.' });

  // Same tier-reach check as /:id/review and /:id/correct above — being in
  // CORRECTION_ROLES does not mean every tier is within THIS viewer's own
  // reach. For a legal_privileged note this single check IS Mason's "only
  // admin may act on a deletion/redaction request touching a
  // legal_privileged note" rule: admin is the only role whose
  // roleMaxTierRank reaches legal_privileged (Section 1 above), so no
  // separate admin-only check is needed — same tier-ceiling pattern
  // already used elsewhere in this file, not a new permission check style.
  if ((NOTE_TIER_RANK[before.access_tier] || 0) > roleMaxTierRank(req.ownerTenantNotesRole)) {
    return res.status(403).json({ error: 'Your role cannot redact a note at this access tier.' });
  }

  if (before.access_tier === 'legal_privileged') {
    // System-logged automatically every time this endpoint is hit for a
    // legal_privileged note, regardless of outcome (including a request
    // that fails the validation below) — records that the automatic
    // redaction path was bypassed for this note (Mason's design).
    await writeAuditLog({
      action: 'operational_notes.ccpa_deletion_blocked_privileged',
      entity_type: 'operational_note',
      entity_id: before.id,
      actor_email: req.user.email,
      property_id: before.property_id,
      risk_level: 'medium',
      details: { note_id: before.id, actor_role: req.ownerTenantNotesRole },
    });

    if (!(await requireTierAccessAcknowledgment(req, res))) return;

    const { disposition, disposition_notes } = req.body;
    if (!['hold_exception_applies', 'no_hold_confirmed_safe'].includes(disposition)) {
      return res.status(400).json({
        error: "disposition must be 'hold_exception_applies' or 'no_hold_confirmed_safe'.",
      });
    }
    if (typeof disposition_notes !== 'string' || !disposition_notes.trim()) {
      return res.status(400).json({ error: 'disposition_notes is required and must explain the determination.' });
    }

    // Human-logged determination — the admin's stated reasoning, never the
    // note's own privileged text (Mason's design: this record is about the
    // decision, not a copy of the thing being decided about).
    await writeAuditLog({
      action: 'operational_notes.ccpa_deletion_disposition',
      entity_type: 'operational_note',
      entity_id: before.id,
      actor_email: req.user.email,
      property_id: before.property_id,
      risk_level: 'medium',
      details: {
        note_id: before.id,
        subject_type: before.subject_type,
        subject_id: before.subject_id,
        disposition,
        disposition_notes: disposition_notes.trim(),
        actor_role: 'admin',
      },
    });

    if (disposition === 'hold_exception_applies') {
      // Deletion denied — note left completely unchanged.
      return res.json({ success: true, disposition, note_redacted: false });
    }

    // no_hold_confirmed_safe — proceed with the same standard redaction
    // used for other tiers.
    const { updated, error: redactErr } = await applyStandardRedaction(before, req);
    if (redactErr) return res.status(500).json({ error: redactErr.message });
    return res.json({ success: true, disposition, note_redacted: true, note: updated });
  }

  if (!(await requireTierAccessAcknowledgment(req, res))) return;

  const { updated, error: redactErr } = await applyStandardRedaction(before, req);
  if (redactErr) return res.status(500).json({ error: redactErr.message });
  return res.json({ success: true, note: updated });
});

module.exports = {
  router,
  attachOwnerTenantNotesRole,
  requireOwnerTenantNotesAccess,
  requireOwnerTenantNotesRole,
  roleHasAnyAccess,
  OWNER_TENANT_NOTES_ROLE_MAX_TIER,
  NOTE_TIER_RANK,
  // Added this pass — the in-process AI-proposal creation function a
  // future pipeline (e.g. complaint-tracking's Category 6, not yet built)
  // calls into. Not an HTTP route.
  proposeAINote,
};
