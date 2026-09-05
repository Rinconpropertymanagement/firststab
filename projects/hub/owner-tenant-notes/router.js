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
 *   - The AI email-extraction pipeline (spec Section 8) — no code here
 *     ever populates `source='ai_proposed'`, `extracted_by`, or
 *     `approval_status`. Manual notes only.
 *   - CCPA deletion/redaction specifically for legal_privileged notes.
 *     POST /:id/redact below builds STANDARD redaction for
 *     operational/management_compliance_restricted notes only, and
 *     returns a loud, explicit block for legal_privileged — see that
 *     route's own comment.
 *   - Grouped/bulk review (spec Section 5's own fast-follow deferral) —
 *     the flagged-queue route below is per-property, one item at a time,
 *     matching this being "a new, low-volume-at-launch data source."
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
const { checkManualNoteContent } = require('./lib/note-content-check');

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

// PLACEHOLDER TEXT — spec Section 3, condition 3: "A written access-use
// policy, shown in that same acknowledgment notice (Mason to draft the
// actual text)." This is Q's placeholder wording only, flagged plainly in
// the build report as needing Mason's real policy language before this
// tool leaves shadow mode — not a finished compliance artifact, the same
// caveat this build's derogatory-language-terms.js carries for its own
// first-pass word list.
const TIER_ACCESS_ACK_MESSAGE =
  'You are about to see Management/Compliance-Restricted or Legal/Privileged operational notes — ' +
  'Fair Housing complaints, accommodation documentation, serious disputes, discriminatory owner instructions, ' +
  'and similar sensitive records, potentially for any property in the portfolio. This access exists for active ' +
  'operational or backup purposes only. Browsing this content outside an actual work reason is a confidentiality ' +
  'violation and is treated like any other misuse of sensitive tenant/owner data. Every time you view a note at ' +
  "this level, it is logged — who, what, and when. [PLACEHOLDER — Mason to provide the final access-use policy " +
  "text; this notice text is Q's draft only, not yet reviewed.] You'll only see this notice once.";

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
// success — never blocks submission (spec Section 7). Wording is Q's own
// draft, flagged in the build report as a first pass for Mason to refine.
const DEROGATORY_LANGUAGE_WARNING =
  'This note may describe a characterization rather than an objectively stated fact ' +
  '(e.g. "difficult" or "problem tenant" instead of what specifically happened). Consider ' +
  'rephrasing to state the observable fact — this is a suggestion only; your note was saved as written.';

router.post('/api/owner-tenant-notes', requireOwnerTenantNotesAccess, async (req, res) => {
  const { property_id, unit_id, subject_type, subject_id, note_text, category, access_tier } = req.body;

  if (!isValidUuid(property_id)) {
    return res.status(400).json({ error: 'property_id is required and must be a valid property ID.' });
  }
  if (unit_id != null && unit_id !== '' && !isValidUuid(unit_id)) {
    return res.status(400).json({ error: 'unit_id must be a valid unit ID, or omitted.' });
  }
  if (!['owner', 'tenant', 'property'].includes(subject_type)) {
    return res.status(400).json({ error: "subject_type must be 'owner', 'tenant', or 'property'." });
  }
  if (subject_type === 'property' && subject_id) {
    return res.status(400).json({ error: "subject_id must be omitted when subject_type is 'property'." });
  }
  if (subject_id != null && subject_id !== '' && !isValidUuid(subject_id)) {
    return res.status(400).json({ error: 'subject_id must be a valid ID, or omitted.' });
  }
  if (typeof note_text !== 'string' || !note_text.trim()) {
    return res.status(400).json({ error: 'note_text is required.' });
  }
  if (!NOTE_TIERS.includes(access_tier)) {
    return res.status(400).json({ error: `access_tier must be one of: ${NOTE_TIERS.join(', ')}.` });
  }

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

  const { data: property, error: propErr } = await supabase
    .from('properties').select('id').eq('id', property_id).maybeSingle();
  if (propErr) return res.status(500).json({ error: propErr.message });
  if (!property) return res.status(404).json({ error: 'Property not found.' });

  if (unit_id) {
    const { data: unit, error: unitErr } = await supabase
      .from('units').select('id').eq('id', unit_id).eq('property_id', property_id).maybeSingle();
    if (unitErr) return res.status(500).json({ error: unitErr.message });
    if (!unit) return res.status(404).json({ error: 'That unit was not found on this property.' });
  }

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

    // Being in OWNER_TENANT_NOTES_REVIEW_ROLES (Management/Compliance-
    // Restricted tier or above) does NOT mean every tier is within this
    // specific viewer's reach — e.g. a property_manager/pod_lead/reviewer/
    // director_of_operations caps out at management_compliance_restricted
    // and must never see a legal_privileged note's real text here, same
    // as anywhere else on this tool (only admin reaches legal_privileged,
    // spec Section 3). A plain per-row tier check, same as
    // classifyNoteForViewer uses elsewhere.
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
// SECTION 10: Post-hoc correction (spec Section 9, counsel's item J) and
// standard redaction (task brief's "Explicitly DO NOT build" section —
// build the standard path for operational/management_compliance_
// restricted tiers; block loudly for legal_privileged, no CCPA carve-out
// yet). Both available to admin/director_of_operations/reviewer for this
// tool at minimum, per spec Section 9 — narrower than "anyone can edit
// anything."
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

// POST /:id/redact — standard redaction ONLY for operational/
// management_compliance_restricted notes (task brief). A legal_privileged
// note gets a loud, explicit block, never a silent redaction — Mason is
// designing the actual CCPA-vs-litigation-hold carve-out for that path
// separately; until that lands, the safest failure mode is "nothing
// happens, tell a human," not "quietly destroy possibly-privileged
// content."
router.post('/api/owner-tenant-notes/:id/redact', requireOwnerTenantNotesRole(...CORRECTION_ROLES), async (req, res) => {
  if (!isValidUuid(req.params.id)) return res.status(400).json({ error: 'That id is not valid.' });

  const { data: before, error: beforeErr } = await supabase
    .from('operational_notes').select('id, access_tier, property_id, reviewer_notes').eq('id', req.params.id).maybeSingle();
  if (beforeErr) return res.status(500).json({ error: beforeErr.message });
  if (!before) return res.status(404).json({ error: 'Note not found.' });

  if (before.access_tier === 'legal_privileged') {
    return res.status(409).json({
      error: 'legal_privileged_redaction_not_supported',
      message: 'This note is Legal/Privileged. Redacting or deleting privileged content requires a separate ' +
        'process that has not been built yet (a CCPA deletion request could otherwise destroy attorney-work-product ' +
        'Rincon needs for a legal hold). Contact Mason before taking any action on this note.',
    });
  }

  if (!(await requireTierAccessAcknowledgment(req, res))) return;

  // note_text/reviewer_notes -> "[REDACTED]", preserving subject_type/
  // category/access_tier/dates — same convention as
  // maintenance_claims.claim_text (task brief). subject_id is left
  // intact (needed for "every row about a specific person is a manual
  // lookup via subject_id/property_id" per the schema's own Rule 4 note).
  const updates = { note_text: '[REDACTED]' };
  if (before.reviewer_notes) updates.reviewer_notes = '[REDACTED]';

  const { data: updated, error: updateErr } = await supabase
    .from('operational_notes').update(updates).eq('id', req.params.id).select().single();
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  // Deliberately NOT logging old_note_text here, unlike /correct above —
  // the entire point of a redaction is removing sensitive content; writing
  // the real old text into audit_log.details would defeat that. A boolean
  // marker is enough of an audit trail for "this note was redacted, by
  // whom, when."
  await writeAuditLog({
    action: 'operational_notes.corrected',
    entity_type: 'operational_note',
    entity_id: before.id,
    actor_email: req.user.email,
    property_id: before.property_id,
    risk_level: 'medium',
    details: { redacted: true, reason: 'ccpa_deletion_request', actor_role: req.ownerTenantNotesRole },
  });

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
};
