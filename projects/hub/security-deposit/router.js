/**
 * security-deposit/router.js
 * Security Deposit Disposition Assembly Tool — a section of the Rincon
 * Hub, built the same way Insurance Compliance was
 * (projects/hub/insurance/router.js): one router file, mounted into
 * projects/hub/server.js, reusing the Hub's existing login. No new
 * sign-in screen, no new tables beyond what Neo already migrated (see
 * supabase/migrations/20260813000000 through 20260813000004).
 *
 * Full spec: projects/hub/security-deposit/SPEC.md — treat it as
 * authoritative. This file follows its "Q — route sketch" and "Q —
 * AppFolio connector" sections.
 *
 * WHAT THIS TOOL NEVER DOES (worth repeating here, not just in SPEC.md):
 * it assembles a review packet for a human. It never decides a
 * deduction, never drafts a tenant-facing letter, and there is no route
 * anywhere in this file that sends anything to a tenant. Every
 * consequential action (the actual deposit return) happens entirely
 * outside this tool, by a person, exactly like today.
 *
 * Two routers are exported, same pattern as insurance/router.js:
 *   router          Everything a logged-in hub user can reach — the
 *                    dashboard page and all /api/security-deposit/*
 *                    routes. Must be mounted AFTER requireLogin.
 *   internalRouter   The three cron endpoints (create-cases-from-sync,
 *                    send-reminders, index-b2-photos), authenticated by
 *                    a shared secret header instead of a browser login.
 *                    Must be mounted BEFORE requireLogin.
 *
 * PERMISSIONS — team_members / team_member_tool_roles for
 * tool='security_deposit' (roles: 'admin', 'pod_lead' — added by
 * 20260813000004_security_deposit_team_roles.sql). Exactly the same
 * fail-closed pattern insurance/router.js already uses: if the shared
 * team tables can't be reached (e.g. 20260812020000 hasn't been applied
 * to the live database yet — true as of this build, see the handoff),
 * every request is treated as having no access rather than erroring or
 * letting anyone through.
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const appfolioConnector = require('./lib/appfolio-connector');
const { listPhotoFolders } = require('./lib/b2-client');
const { parseFolderName } = require('./lib/folder-parser');

// ─── Nodemailer (reminder emails) — same setup pattern as insurance ───────
let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  console.warn('[security-deposit email] nodemailer not installed — reminder emails disabled.');
}

function createMailer() {
  if (!nodemailer || !process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
}

// ─── Escalation email ───────────────────────────────────────────────────
// Unlike insurance/router.js's sendEscalationEmail (which mails a single
// fixed process.env.DO_EMAIL address), this tool has no separate
// standalone DO inbox configured — recipients are looked up the same way
// send-reminders looks up pod_lead: everyone holding the
// director_of_operations role for tool='security_deposit' in
// team_member_tool_roles (that role value already exists in the shared
// CHECK constraint — 20260813000004 only needed to add 'pod_lead', see
// SPEC.md Neo section #6). This is a manual, pod-lead-initiated
// escalation (no AI-suggested-status to trigger off of, unlike
// insurance's approve route), so there's exactly one call site: the
// escalate route below.
async function sendEscalationEmail(kase, escalatedBy, reason) {
  try {
    const mailer = createMailer();
    if (!mailer) return;

    const { data: roleRows } = await supabase
      .from('team_member_tool_roles')
      .select('team_members ( email, is_active )')
      .eq('tool', 'security_deposit')
      .eq('role', 'director_of_operations');
    const recipients = (roleRows || [])
      .filter(r => r.team_members && r.team_members.is_active)
      .map(r => r.team_members.email);

    if (!recipients.length) {
      console.warn('[security-deposit email] Case escalated but no active director_of_operations recipients found for tool=security_deposit.');
      return;
    }

    const props = kase.leases && kase.leases.units && kase.leases.units.properties;
    const addr = (props && (props.address || props.name)) || 'Unknown property';
    const unit = kase.leases && kase.leases.units && kase.leases.units.unit_number;

    await mailer.sendMail({
      from: process.env.GMAIL_USER,
      to: recipients.join(', '),
      subject: `Security Deposit Escalation: ${addr}${unit ? ' Unit ' + unit : ''}`,
      text: [
        'A security deposit disposition has been escalated for your review.',
        '',
        `Property:      ${addr}${unit ? ' Unit ' + unit : ''}`,
        `Deadline:      ${kase.disposition_deadline || '—'}`,
        `Escalated by:  ${escalatedBy}`,
        `Reason:        ${reason}`,
        '',
        'Please log in to the Rincon Hub and open Security Deposit to review.',
      ].join('\n'),
    });
    console.log(`[security-deposit email] Escalation email sent to ${recipients.length} director(s) of operations`);
  } catch (err) {
    console.error('[security-deposit email] Failed to send escalation email:', err.message);
  }
}

// ─── Config ─────────────────────────────────────────────────────────────
// SUPABASE_URL etc. are already validated by hub/server.js before this
// file is ever required. Only check what's specific to this section.
// Deliberately NOT checking B2_* or APPFOLIO_* here — those are only
// needed by specific internal-cron routes, not by every request into
// this section, and a missing B2 key shouldn't take down the whole Hub
// (including Insurance Compliance) at startup. Those are checked lazily
// inside the routes/modules that actually need them.
const missing = [];
if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
if (missing.length > 0) {
  console.error(`[security-deposit] Missing environment variables: ${missing.join(', ')}`);
  console.error('[security-deposit] Set these in the shared .env at the project root (see .env.example).');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Multer (inspection form uploads) — same pattern as insurance ─────────
const upload = multer({
  storage: multer.diskStorage({
    destination: '/tmp',
    filename: (req, file, cb) => {
      const ts = Date.now();
      cb(null, `security-deposit-upload-${ts}-${file.originalname}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${ext}. Accepted: ${allowed.join(', ')}`));
  },
});

async function ensureStorageBucket() {
  const { error } = await supabase.storage.createBucket('security-deposit-documents', { public: false });
  if (error && error.message && !/already exist|duplicate/i.test(error.message)) {
    console.warn('[security-deposit] Storage bucket warn:', error.message);
  }
}

// ─── Permission check — reads Neo's shared team tables ────────────────────
async function attachSecurityDepositRole(req, res, next) {
  req.securityDepositRole = null;
  req.teamMemberId = null;
  req.securityDepositMemberName = null;

  try {
    const { data: member, error: memberErr } = await supabase
      .from('team_members')
      .select('id, full_name, is_active')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();

    if (memberErr) throw memberErr;
    if (!member || !member.is_active) return next();

    req.teamMemberId = member.id;
    req.securityDepositMemberName = member.full_name || null;

    const { data: roleRow, error: roleErr } = await supabase
      .from('team_member_tool_roles')
      .select('role')
      .eq('team_member_id', member.id)
      .eq('tool', 'security_deposit')
      .maybeSingle();

    if (roleErr) throw roleErr;
    req.securityDepositRole = roleRow ? roleRow.role : null;
    next();
  } catch (err) {
    // Fail closed — same as insurance/router.js's attachInsuranceRole.
    // Expected today: 20260812020000_shared_team_members.sql may not be
    // applied to the live database yet (per this build's handoff notes),
    // so every lookup finds nobody and every route past
    // requireSecurityDepositAccess correctly responds 403 rather than
    // erroring or letting anyone through.
    console.error('[security-deposit] permission lookup failed:', err.message);
    next();
  }
}

function requireSecurityDepositAccess(req, res, next) {
  if (!req.securityDepositRole) {
    return res.status(403).json({
      error: 'Your Rincon Hub account does not have access to Security Deposit yet. Ask an admin to grant you access.',
    });
  }
  next();
}

function requireSecurityDepositRole(...roles) {
  return (req, res, next) => {
    if (!req.securityDepositRole || !roles.includes(req.securityDepositRole)) {
      return res.status(403).json({ error: 'Insufficient permissions', required: roles, actual: req.securityDepositRole });
    }
    next();
  };
}

// ─── Address matching helpers ──────────────────────────────────────────
// Small, tool-scoped duplicate of insurance/router.js's normalizeAddress/
// addressWordScore — same "no second consumer, don't force a shared
// module yet" reasoning SPEC.md gives for the AppFolio connector.
function normalizeAddress(addr) {
  if (!addr) return '';
  return addr.split(/[,\-]/)[0]
    .toLowerCase()
    .replace(/[.#]/g, '')
    .replace(/\bstreet\b/g, 'st')
    .replace(/\bavenue\b/g, 'ave')
    .replace(/\bboulevard\b/g, 'blvd')
    .replace(/\bdrive\b/g, 'dr')
    .replace(/\broad\b/g, 'rd')
    .replace(/\blane\b/g, 'ln')
    .replace(/\bcourt\b/g, 'ct')
    .replace(/\bplace\b/g, 'pl')
    .replace(/\bcircle\b/g, 'cir')
    .replace(/\bhighway\b/g, 'hwy')
    .replace(/\bnorth\b/g, 'n')
    .replace(/\bsouth\b/g, 's')
    .replace(/\beast\b/g, 'e')
    .replace(/\bwest\b/g, 'w')
    .replace(/\s+/g, ' ')
    .trim();
}

function addressWordScore(normA, normB) {
  const wa = normA.split(' ').filter(w => w.length > 1);
  const wb = new Set(normB.split(' ').filter(w => w.length > 1));
  if (!wa.length || !wb.size) return 0;
  return wa.filter(w => wb.has(w)).length / Math.max(wa.length, wb.size);
}

// Finds the best-matching indexed B2 photo folder for a property address,
// a target date, and an inspection type ('move_in' | 'move_out') — "match
// by normalized address + nearest date," per SPEC.md's own description
// (20260813000003_b2_photo_folders.sql's design notes). Only ever reads
// the already-built b2_photo_folders index — never touches B2 directly.
function findBestPhotoMatch(propertyAddress, targetDateStr, inspectionType, folders) {
  if (!propertyAddress || !targetDateStr || !folders || !folders.length) return null;
  const normTarget = normalizeAddress(propertyAddress);
  if (!normTarget) return null;
  const targetDate = new Date(targetDateStr + 'T00:00:00');

  let best = null;
  let bestScore = -1;
  for (const folder of folders) {
    if (folder.parsed_inspection_type && folder.parsed_inspection_type !== inspectionType && folder.parsed_inspection_type !== 'other') continue;
    const addrScore = addressWordScore(normTarget, normalizeAddress(folder.parsed_address || ''));
    if (addrScore < 0.6) continue;
    let dateScore = 0;
    if (folder.parsed_date) {
      const days = Math.abs((new Date(folder.parsed_date + 'T00:00:00') - targetDate) / 86400000);
      dateScore = 1 / (1 + days); // closer date = higher score
    }
    const combined = addrScore + dateScore;
    if (combined > bestScore) { bestScore = combined; best = folder; }
  }
  return best;
}

function daysRemaining(disposition_deadline) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const deadline = new Date(disposition_deadline + 'T00:00:00');
  return Math.round((deadline - today) / 86400000);
}

// ─── Router: everyone reaching here is already hub-logged-in ──────────────
const router = express.Router();
router.use(attachSecurityDepositRole);

// ─── GET /security-deposit — the dashboard page ────────────────────────────
// Same "no server-side gate on the page shell" approach as insurance's
// /insurance route — the page's own JS calls /api/security-deposit/auth/me
// on load and shows a friendly "no access" message on a 403. Tron owns
// dashboard/index.html; this file currently serves a placeholder so the
// route works end to end before Tron's screens land.
router.get('/security-deposit', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

// ─── GET /api/security-deposit/auth/me ─────────────────────────────────────
router.get('/api/security-deposit/auth/me', requireSecurityDepositAccess, (req, res) => {
  res.json({
    email: req.user.email,
    name: req.securityDepositMemberName || req.user.email,
    role: req.securityDepositRole,
  });
});

// ─── GET /api/security-deposit/cases — the queue ───────────────────────────
// Sorted by disposition_deadline ascending — most urgent first. Defaults
// to open cases (pending_review, escalated); ?status=all or ?status=X
// lets Tron build a "reviewed" tab without a second endpoint.
router.get('/api/security-deposit/cases', requireSecurityDepositAccess, async (req, res) => {
  let query = supabase
    .from('security_deposit_cases')
    .select(`
      id, lease_id, move_out_date, disposition_deadline, status,
      tenancy_status, ai_suggested_tenancy_status, created_at,
      leases (
        id, appfolio_id, lease_start, lease_end,
        units ( unit_number, properties ( name, address, city ) )
      )
    `)
    .order('disposition_deadline', { ascending: true });

  if (req.query.status === 'all') {
    // no filter
  } else if (req.query.status) {
    query = query.eq('status', req.query.status);
  } else {
    query = query.in('status', ['pending_review', 'escalated']);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Every leaseholder name for the cases in this page, in one query
  // instead of N+1 — the multi-tenant fix means a queue row can have more
  // than one name.
  const leaseIds = (data || []).map(c => c.lease_id).filter(Boolean);
  const tenantsByLease = {};
  if (leaseIds.length) {
    const { data: ltRows } = await supabase
      .from('lease_tenants')
      .select('lease_id, is_primary, tenants ( first_name, last_name )')
      .in('lease_id', leaseIds);
    (ltRows || []).forEach(row => {
      if (!row.tenants) return;
      const name = `${row.tenants.first_name || ''} ${row.tenants.last_name || ''}`.trim();
      if (!tenantsByLease[row.lease_id]) tenantsByLease[row.lease_id] = [];
      tenantsByLease[row.lease_id].push({ name, is_primary: !!row.is_primary });
    });
  }

  const rows = (data || []).map(c => ({
    id: c.id,
    lease_id: c.lease_id,
    status: c.status,
    move_out_date: c.move_out_date,
    disposition_deadline: c.disposition_deadline,
    days_remaining: daysRemaining(c.disposition_deadline),
    tenancy_status: c.tenancy_status,
    ai_suggested_tenancy_status: c.ai_suggested_tenancy_status,
    property_name: c.leases && c.leases.units && c.leases.units.properties ? c.leases.units.properties.name : null,
    property_address: c.leases && c.leases.units && c.leases.units.properties ? c.leases.units.properties.address : null,
    unit_number: c.leases && c.leases.units ? c.leases.units.unit_number : null,
    tenants: tenantsByLease[c.lease_id] || [],
  }));

  return res.json(rows);
});

// ─── GET /api/security-deposit/cases/:id — full assembled package ─────────
router.get('/api/security-deposit/cases/:id', requireSecurityDepositAccess, async (req, res) => {
  const { data: kase, error } = await supabase
    .from('security_deposit_cases')
    .select(`
      id, lease_id, move_out_date, disposition_deadline, status,
      tenancy_status, ai_suggested_tenancy_status,
      checklist_notice_sent, checklist_inspection_conducted, checklist_photos_documented,
      reviewed_by, reviewed_at, escalated_by, escalated_at, reviewer_notes,
      created_at, updated_at,
      leases (
        id, appfolio_id, lease_start, lease_end, monthly_rent, status,
        move_out_reason, deposit_held_total, deposit_synced_at,
        units ( id, unit_number, properties ( id, name, address, city, jurisdiction_county ) )
      )
    `)
    .eq('id', req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!kase) return res.status(404).json({ error: 'Case not found.' });

  const lease = kase.leases || {};
  const property = (lease.units && lease.units.properties) || null;

  // Every leaseholder on this lease — not just leases.tenant_id's single
  // (and, for multi-tenant leases, arbitrary) value.
  const { data: ltRows, error: ltErr } = await supabase
    .from('lease_tenants')
    .select('is_primary, tenants ( id, first_name, last_name, email, phone )')
    .eq('lease_id', kase.lease_id);
  if (ltErr) return res.status(500).json({ error: ltErr.message });
  const tenants = (ltRows || [])
    .filter(r => r.tenants)
    .map(r => Object.assign({}, r.tenants, { is_primary: !!r.is_primary }));

  // Inspection form uploads — reuses `documents`, entity_type =
  // 'security_deposit_case' (SPEC.md Neo section #4).
  const { data: docs, error: docErr } = await supabase
    .from('documents')
    .select('id, file_name, file_type, mime_type, created_at')
    .eq('entity_type', 'security_deposit_case')
    .eq('entity_id', kase.id)
    .order('created_at', { ascending: false });
  if (docErr) return res.status(500).json({ error: docErr.message });
  const inspectionFormMoveIn = (docs || []).find(d => d.file_type === 'inspection_form_move_in') || null;
  const inspectionFormMoveOut = (docs || []).find(d => d.file_type === 'inspection_form_move_out') || null;

  // Matched B2 photos — reads the already-built index only (never touches
  // B2 live on a case-open — that would be slow and re-spend AI-parsing
  // cost on unchanged folders; see 20260813000003's design notes).
  let candidateFolders = [];
  if (property && property.address) {
    const { data: folderRows, error: folderErr } = await supabase
      .from('b2_photo_folders')
      .select('id, b2_folder_path, parsed_address, parsed_unit, parsed_inspection_type, parsed_date, confidence_score, review_status')
      .not('parsed_address', 'is', null);
    if (folderErr) return res.status(500).json({ error: folderErr.message });
    candidateFolders = folderRows || [];
  }

  const moveInPhotos = findBestPhotoMatch(property && property.address, lease.lease_start, 'move_in', candidateFolders);
  const moveOutPhotos = findBestPhotoMatch(property && property.address, kase.move_out_date, 'move_out', candidateFolders);

  // Prepaid Rent — pulled live, per case, NOT nightly-synced (SPEC.md Neo
  // section #3, Mason's resolution: AB 12's deposit cap counts last
  // month's rent collected upfront, but AppFolio books it in a genuinely
  // separate account from the deposit itself, so it needs its own pull
  // and its own labeled line — never folded into deposit.held_total
  // above). Wrapped defensively: a live AppFolio call can fail (network,
  // rate limit, credentials), and that shouldn't take down the whole case
  // view — it becomes a flag instead, same as any other missing evidence.
  let prepaidRent = { found: false };
  if (lease.appfolio_id) {
    try {
      prepaidRent = await appfolioConnector.getPrepaidRentBalance(lease.appfolio_id);
    } catch (err) {
      console.error(`[security-deposit] getPrepaidRentBalance failed for case ${kase.id}:`, err.message);
      prepaidRent = { found: false, error: err.message };
    }
  }

  // Missing-evidence flags — computed HERE, at read time, from whatever
  // the assembly step actually found. Deliberately not a stored column —
  // SPEC.md Gap #8: "missing" is a derived state, not new information to
  // keep in sync, and storing it would create a second copy of the truth
  // that could drift from the real B2/AppFolio state between reads.
  const flags = [];
  if (!moveInPhotos) flags.push({ code: 'no_move_in_photos', message: 'No move-in photos found.' });
  if (!moveOutPhotos) flags.push({ code: 'no_move_out_photos', message: 'No move-out photos found.' });
  if (lease.deposit_held_total == null) {
    flags.push({ code: 'no_deposit_on_file', message: 'No deposit amount on file for this lease.' });
  } else if (Number(lease.deposit_held_total) === 0) {
    flags.push({ code: 'zero_deposit', message: 'Deposit on file is $0 — confirm this is correct and not a data gap.' });
  }
  if (prepaidRent.error) {
    flags.push({ code: 'prepaid_rent_lookup_failed', message: 'Could not check for a Prepaid Rent balance right now — try again, or confirm manually in AppFolio.' });
  }
  if (!inspectionFormMoveIn) flags.push({ code: 'no_inspection_form_move_in', message: 'Move-in inspection form not uploaded yet.' });
  if (!inspectionFormMoveOut) flags.push({ code: 'no_inspection_form_move_out', message: 'Move-out inspection form not uploaded yet.' });
  if (!kase.tenancy_status) flags.push({ code: 'tenancy_status_unconfirmed', message: 'Whether this is the whole tenancy ending, or one co-tenant moving out while the lease continues, has not been confirmed yet.' });

  return res.json({
    id: kase.id,
    status: kase.status,
    move_out_date: kase.move_out_date,
    move_out_reason: lease.move_out_reason || null,
    disposition_deadline: kase.disposition_deadline,
    days_remaining: daysRemaining(kase.disposition_deadline),
    tenancy_status: kase.tenancy_status,
    ai_suggested_tenancy_status: kase.ai_suggested_tenancy_status,
    checklist: {
      notice_sent: kase.checklist_notice_sent,
      inspection_conducted: kase.checklist_inspection_conducted,
      photos_documented: kase.checklist_photos_documented,
    },
    reviewed_by: kase.reviewed_by,
    reviewed_at: kase.reviewed_at,
    escalated_by: kase.escalated_by,
    escalated_at: kase.escalated_at,
    reviewer_notes: kase.reviewer_notes,
    lease: {
      id: lease.id,
      lease_start: lease.lease_start,
      lease_end: lease.lease_end,
      monthly_rent: lease.monthly_rent,
      status: lease.status,
    },
    property: property ? {
      name: property.name,
      address: property.address,
      city: property.city,
      jurisdiction_county: property.jurisdiction_county,
      unit_number: lease.units ? lease.units.unit_number : null,
    } : null,
    tenants,
    deposit: {
      held_total: lease.deposit_held_total,
      synced_at: lease.deposit_synced_at,
      // Tron requirement (SPEC.md Tron section) — this label must travel
      // with the number wherever it's shown, not live only in a tooltip.
      source_label: "From AppFolio's Security Deposits ledger — not an independently verified trust account balance. Does not include any last month's rent collected upfront (AppFolio tracks that separately as Prepaid Rent), which may also count toward the AB 12 deposit cap.",
    },
    // Its own separate labeled line, never folded into deposit.held_total
    // above — Mason's resolution (SPEC.md Neo section #3, "What You'll
    // See"). Pulled live per case (see the flag above if that lookup
    // failed) — always show this next to the deposit figure, not hidden
    // behind a click, per SPEC.md's "What You'll See."
    prepaid_rent: {
      balance: prepaidRent.balance != null ? prepaidRent.balance : null,
      found: !!prepaidRent.found,
      verified_amount_field: prepaidRent.verified_amount_field === true,
      source_label: "From AppFolio's Prepaid Rent ledger — a separate account from the Security Deposit total above, pulled live for this case (not nightly-synced). California's AB 12 deposit cap counts this toward the aggregate. Confirm this figure and account for it before finalizing the disposition.",
    },
    inspection_forms: {
      move_in: inspectionFormMoveIn,
      move_out: inspectionFormMoveOut,
    },
    photos: {
      move_in: moveInPhotos,
      move_out: moveOutPhotos,
    },
    flags,
  });
});

// ─── POST /api/security-deposit/cases — manual/backfill creation ──────────
// Deliberate fallback, not the primary path (SPEC.md route sketch) — for
// a move-out that predates this tool, a correction, or a move-out that
// doesn't flow cleanly through tenant_tickler. Requires an explicit
// move_out_date in the request body rather than depending on
// leases.move_out_date already being set — that column is sync-owned
// exclusively by tenant_tickler (20260813000000's comment), so a manual
// route writing to it would break that ownership rule. The date supplied
// here is stored directly as this case's own copy, same as the automatic
// path does.
router.post('/api/security-deposit/cases', requireSecurityDepositRole('admin', 'pod_lead'), async (req, res) => {
  const { lease_id, move_out_date } = req.body;
  if (!lease_id) return res.status(400).json({ error: 'lease_id is required.' });
  if (!move_out_date || isNaN(Date.parse(move_out_date))) {
    return res.status(400).json({ error: 'move_out_date is required and must be a valid date (YYYY-MM-DD).' });
  }

  const { data: lease, error: leaseErr } = await supabase
    .from('leases').select('id').eq('id', lease_id).maybeSingle();
  if (leaseErr) return res.status(500).json({ error: leaseErr.message });
  if (!lease) return res.status(404).json({ error: 'Lease not found.' });

  const { data: inserted, error: insErr } = await supabase
    .from('security_deposit_cases')
    .insert({ lease_id, move_out_date })
    .select()
    .single();

  if (insErr) {
    if (insErr.code === '23505') {
      return res.status(409).json({ error: 'A disposition case already exists for this lease.' });
    }
    return res.status(500).json({ error: insErr.message });
  }

  await supabase.from('audit_log').insert({
    action: 'security_deposit.case_created',
    entity_type: 'security_deposit_case',
    entity_id: inserted.id,
    details: { source: 'manual', lease_id, move_out_date, created_by: req.user.email },
  });

  return res.json({ success: true, case: inserted });
});

// ─── POST /api/security-deposit/cases/:id/checklist ────────────────────────
// Saves the reviewer checklist fields (Compliance Grounding, Mason-
// finalized 2026-08-13) plus, optionally, the pod lead's confirmation of
// tenancy_status — SPEC.md's route sketch doesn't list a separate
// endpoint for that field, and this is the natural "pod lead actively
// confirms something about the case" route for it to live on. All fields
// optional per-request; only supplied fields are updated.
router.post('/api/security-deposit/cases/:id/checklist', requireSecurityDepositRole('admin', 'pod_lead'), async (req, res) => {
  const { notice_sent, inspection_conducted, photos_documented, tenancy_status } = req.body;
  const updates = {};
  if (typeof notice_sent === 'boolean') updates.checklist_notice_sent = notice_sent;
  if (typeof inspection_conducted === 'boolean') updates.checklist_inspection_conducted = inspection_conducted;
  if (typeof photos_documented === 'boolean') updates.checklist_photos_documented = photos_documented;
  if (tenancy_status != null) {
    if (!['full_tenancy_ending', 'partial_co_tenant_move_out'].includes(tenancy_status)) {
      return res.status(400).json({ error: 'Invalid tenancy_status.' });
    }
    updates.tenancy_status = tenancy_status;
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update.' });

  const { data: updated, error } = await supabase
    .from('security_deposit_cases')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  if (!updated) return res.status(404).json({ error: 'Case not found.' });

  await supabase.from('audit_log').insert({
    action: 'security_deposit.checklist_saved',
    entity_type: 'security_deposit_case',
    entity_id: req.params.id,
    details: { updated_fields: updates, answered_by: req.user.email },
  });

  return res.json({ success: true, case: updated });
});

// ─── POST /api/security-deposit/cases/:id/inspection-form ─────────────────
// Plain file-attach — reuses `documents` (entity_type =
// 'security_deposit_case'), same as insurance's upload route reuses it
// for entity_type='property'. `kind` in the body distinguishes move_in
// from move_out (mirrors insurance's file_type='insurance_certificate'
// convention).
router.post('/api/security-deposit/cases/:id/inspection-form', requireSecurityDepositRole('admin', 'pod_lead'), upload.single('file'), async (req, res) => {
  const caseId = req.params.id;
  const kind = req.body.kind;
  if (!['move_in', 'move_out'].includes(kind)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'kind must be "move_in" or "move_out".' });
  }
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  const { data: kase, error: caseErr } = await supabase
    .from('security_deposit_cases').select('id').eq('id', caseId).maybeSingle();
  if (caseErr) return res.status(500).json({ error: caseErr.message });
  if (!kase) {
    fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: 'Case not found.' });
  }

  const ext = path.extname(req.file.originalname).toLowerCase();
  const MIME_MAP = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
  const mimeType = MIME_MAP[ext] || 'application/octet-stream';

  await ensureStorageBucket();
  const fileBuffer = fs.readFileSync(req.file.path);
  const storageKey = `${caseId}/${kind}-${Date.now()}${ext}`;
  const { error: uploadErr } = await supabase.storage
    .from('security-deposit-documents')
    .upload(storageKey, fileBuffer, { contentType: mimeType, upsert: true });
  fs.unlink(req.file.path, () => {});
  if (uploadErr) return res.status(500).json({ error: 'Failed to store file.', detail: uploadErr.message });

  // documents.uploaded_by references the legacy `users` table, not
  // team_members — left NULL here, the exact same workaround
  // insurance/router.js already uses. The uploader's real identity goes
  // into the audit_log entry below instead (details.uploaded_by).
  const { data: docRow, error: docErr } = await supabase
    .from('documents')
    .insert({
      file_name: storageKey,
      file_path: storageKey,
      file_type: kind === 'move_in' ? 'inspection_form_move_in' : 'inspection_form_move_out',
      entity_type: 'security_deposit_case',
      entity_id: caseId,
      mime_type: mimeType,
      uploaded_by: null,
    })
    .select('id')
    .single();
  if (docErr) return res.status(500).json({ error: 'Failed to save document record.', detail: docErr.message });

  await supabase.from('audit_log').insert({
    action: 'security_deposit.inspection_form_uploaded',
    entity_type: 'security_deposit_case',
    entity_id: caseId,
    details: { document_id: docRow.id, file_type: kind, uploaded_by: req.user.email },
  });

  return res.json({ success: true, document_id: docRow.id });
});

// ─── GET /api/security-deposit/document/:id ────────────────────────────────
// Signed-URL redirect, same pattern as insurance's document routes.
// Scoped to entity_type='security_deposit_case' so this tool's login gate
// can't be used to read an arbitrary `documents` row from another tool.
router.get('/api/security-deposit/document/:id', requireSecurityDepositAccess, async (req, res) => {
  const { data: doc, error } = await supabase
    .from('documents')
    .select('file_name, file_path, entity_type')
    .eq('id', req.params.id)
    .eq('entity_type', 'security_deposit_case')
    .single();
  if (error || !doc) return res.status(404).send('Document not found.');

  const { data: signed, error: signErr } = await supabase.storage
    .from('security-deposit-documents')
    .createSignedUrl(doc.file_name, 3600);
  if (signErr || !signed) return res.status(500).send('Could not generate download link.');

  res.redirect(signed.signedUrl);
});

// ─── GET /api/security-deposit/document/:id/download ──────────────────────
router.get('/api/security-deposit/document/:id/download', requireSecurityDepositAccess, async (req, res) => {
  const { data: doc, error } = await supabase
    .from('documents')
    .select('file_name, mime_type, entity_type')
    .eq('id', req.params.id)
    .eq('entity_type', 'security_deposit_case')
    .single();
  if (error || !doc) return res.status(404).send('Document not found.');

  const { data: fileData, error: downloadErr } = await supabase.storage
    .from('security-deposit-documents')
    .download(doc.file_name);
  if (downloadErr || !fileData) return res.status(500).send('Could not retrieve file.');

  const buffer = Buffer.from(await fileData.arrayBuffer());
  res.setHeader('Content-Disposition', `attachment; filename="${doc.file_name}"`);
  res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
  res.send(buffer);
});

// ─── POST /api/security-deposit/cases/:id/review ───────────────────────────
router.post('/api/security-deposit/cases/:id/review', requireSecurityDepositRole('admin', 'pod_lead'), async (req, res) => {
  const { reviewer_notes } = req.body;
  const reviewerName = req.securityDepositMemberName || req.user.email;
  const now = new Date().toISOString();

  const { data: updated, error } = await supabase
    .from('security_deposit_cases')
    .update({ status: 'reviewed', reviewed_by: reviewerName, reviewed_at: now, reviewer_notes: reviewer_notes || null })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  if (!updated) return res.status(404).json({ error: 'Case not found.' });

  await supabase.from('audit_log').insert({
    action: 'security_deposit.case_reviewed',
    entity_type: 'security_deposit_case',
    entity_id: req.params.id,
    details: { reviewed_by: reviewerName, reviewer_notes: reviewer_notes || null },
  });

  return res.json({ success: true, case: updated });
});

// ─── POST /api/security-deposit/cases/:id/escalate ─────────────────────────
// Manual, pod-lead-initiated — Peter confirmed this design call. Unlike
// insurance/router.js's approve route (which auto-escalates when the
// AI-suggested status is non-compliant), this tool has no AI judgment on
// deductions at all in v1, so there's no signal to auto-trigger against.
// A pod lead escalates on their own judgment — a complicated dispute, an
// unusually large deduction, evidence they're unsure how to weigh,
// anything like that — and must say why.
router.post('/api/security-deposit/cases/:id/escalate', requireSecurityDepositRole('admin', 'pod_lead'), async (req, res) => {
  const { reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'reason is required.' });

  const escalatorName = req.securityDepositMemberName || req.user.email;
  const now = new Date().toISOString();

  const { data: updated, error } = await supabase
    .from('security_deposit_cases')
    .update({
      status: 'escalated',
      escalated_by: escalatorName,
      escalated_at: now,
      reviewer_notes: reason.trim(),
    })
    .eq('id', req.params.id)
    .select(`
      id, disposition_deadline,
      leases ( units ( unit_number, properties ( name, address ) ) )
    `)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  if (!updated) return res.status(404).json({ error: 'Case not found.' });

  await supabase.from('audit_log').insert({
    action: 'security_deposit.case_escalated',
    entity_type: 'security_deposit_case',
    entity_id: req.params.id,
    details: { escalated_by: escalatorName, reason: reason.trim() },
  });

  await sendEscalationEmail(updated, escalatorName, reason.trim());

  return res.json({ success: true, case: updated });
});

// ─── POST /api/security-deposit/cases/:id/escalate-confirm ────────────────
// The director of operations (or admin) resolves the escalation. Same
// shape as insurance's escalate-confirm in spirit, but a different
// result: insurance's version FINALIZES the record at the AI's suggested
// non-compliant status. This tool has no AI-suggested status to finalize
// against, so per Peter's instruction this route just clears the case
// back to a normal reviewable state (status → 'pending_review') with the
// DO's own notes — it does not approve, deny, or decide anything about
// the disposition itself. The pod lead still finishes the case normally
// afterward via POST .../review.
//
// escalated_by/escalated_at are left untouched here (they stay a record
// of who raised the escalation and when) — the DO's own identity and
// reasoning for THIS action live in the audit_log entry below, not
// crammed into a column that already has a different meaning. The
// original escalation reason is recoverable from the
// security_deposit.case_escalated audit_log entry even though
// reviewer_notes below gets overwritten with the DO's resolution notes.
router.post('/api/security-deposit/cases/:id/escalate-confirm', requireSecurityDepositRole('admin', 'director_of_operations'), async (req, res) => {
  const { reviewer_notes } = req.body;
  const resolverName = req.securityDepositMemberName || req.user.email;

  const { data: before, error: beforeErr } = await supabase
    .from('security_deposit_cases')
    .select('status, escalated_by, escalated_at, reviewer_notes')
    .eq('id', req.params.id)
    .maybeSingle();
  if (beforeErr) return res.status(500).json({ error: beforeErr.message });
  if (!before) return res.status(404).json({ error: 'Case not found.' });

  const { data: updated, error } = await supabase
    .from('security_deposit_cases')
    .update({
      status: 'pending_review',
      reviewer_notes: reviewer_notes || null,
    })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await supabase.from('audit_log').insert({
    action: 'security_deposit.case_escalation_resolved',
    entity_type: 'security_deposit_case',
    entity_id: req.params.id,
    details: {
      resolved_by: resolverName,
      resolver_notes: reviewer_notes || null,
      prior_escalated_by: before.escalated_by,
      prior_escalated_at: before.escalated_at,
      prior_reason: before.reviewer_notes,
    },
  });

  return res.json({ success: true, case: updated });
});

// ─── GET /api/security-deposit/photo-review-queue ──────────────────────────
router.get('/api/security-deposit/photo-review-queue', requireSecurityDepositAccess, async (req, res) => {
  const { data, error } = await supabase
    .from('b2_photo_folders')
    .select('id, b2_folder_path, parsed_address, parsed_unit, parsed_inspection_type, parsed_date, confidence_score, model_version, indexed_at')
    .eq('review_status', 'needs_review')
    .order('indexed_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data || []);
});

// ─── POST /api/security-deposit/photo-review-queue/:id/resolve ────────────
// Body: { confirmed: true } to accept the AI's parse as-is, or
// { confirmed: false, address, unit, inspection_type, date } to correct it.
router.post('/api/security-deposit/photo-review-queue/:id/resolve', requireSecurityDepositRole('admin', 'pod_lead'), async (req, res) => {
  const { address, unit, inspection_type, date, confirmed } = req.body;

  const { data: before, error: beforeErr } = await supabase
    .from('b2_photo_folders')
    .select('parsed_address, parsed_unit, parsed_inspection_type, parsed_date')
    .eq('id', req.params.id)
    .maybeSingle();
  if (beforeErr) return res.status(500).json({ error: beforeErr.message });
  if (!before) return res.status(404).json({ error: 'Photo folder not found.' });

  const updates = {
    review_status: confirmed ? 'manually_confirmed' : 'manually_corrected',
    resolved_by: req.user.email,
    resolved_at: new Date().toISOString(),
  };
  if (!confirmed) {
    if (inspection_type !== undefined && inspection_type && !['move_in', 'move_out', 'other'].includes(inspection_type)) {
      return res.status(400).json({ error: 'Invalid inspection_type.' });
    }
    if (address !== undefined) updates.parsed_address = address || null;
    if (unit !== undefined) updates.parsed_unit = unit || null;
    if (inspection_type !== undefined) updates.parsed_inspection_type = inspection_type || null;
    if (date !== undefined) updates.parsed_date = date || null;
  }

  const { data: updated, error } = await supabase
    .from('b2_photo_folders')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  await supabase.from('audit_log').insert({
    action: 'security_deposit.photo_match_resolved',
    entity_type: 'b2_photo_folder',
    entity_id: req.params.id,
    details: { resolved_by: req.user.email, before, after: updated, confirmed: !!confirmed },
  });

  return res.json({ success: true, folder: updated });
});

// ─── /api/security-deposit/users — admin-only role management ─────────────
// Mirrors insurance/router.js's admin endpoints exactly, scoped to
// tool='security_deposit', roles 'admin' and 'pod_lead' (the only two
// values 20260813000004_security_deposit_team_roles.sql pairs with this
// tool).
// 'director_of_operations' added alongside 'pod_lead' — the escalate-
// confirm route requires someone able to hold this role for
// tool='security_deposit'. The CHECK constraint already allows it
// (20260813000004 only needed to add 'pod_lead' — director_of_operations
// was already a valid value shared from insurance_compliance's roles),
// but this admin UI's own allow-list needed updating too, or there'd be
// no way to actually grant it here.
const VALID_ROLES = ['admin', 'pod_lead', 'director_of_operations'];
const ALLOWED_DOMAIN = 'rinconmanagement.com';

router.get('/api/security-deposit/users', requireSecurityDepositRole('admin'), async (req, res) => {
  const { data, error } = await supabase
    .from('team_member_tool_roles')
    .select('role, granted_by, granted_at, team_members ( email, full_name )')
    .eq('tool', 'security_deposit')
    .order('granted_at');
  if (error) return res.status(500).json({ error: error.message });
  const rows = (data || [])
    .filter(r => r.team_members)
    .map(r => ({
      email: r.team_members.email,
      name: r.team_members.full_name || null,
      role: r.role,
      assigned_by: r.granted_by,
      granted_at: r.granted_at,
    }));
  return res.json(rows);
});

router.post('/api/security-deposit/users', requireSecurityDepositRole('admin'), async (req, res) => {
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
      error: `${normalizedEmail} hasn't logged into the Rincon Hub yet. Ask them to log in once, then try granting access again.`,
    });
  }

  const { error: upsertErr } = await supabase
    .from('team_member_tool_roles')
    .upsert({
      team_member_id: member.id,
      tool: 'security_deposit',
      role,
      granted_by: req.user.email,
      granted_at: new Date().toISOString(),
    }, { onConflict: 'team_member_id,tool' });
  if (upsertErr) return res.status(500).json({ error: upsertErr.message });

  await supabase.from('audit_log').insert({
    action: 'team_member.role_changed',
    entity_type: 'team_member',
    entity_id: member.id,
    details: { tool: 'security_deposit', old_role: null, new_role: role, changed_by: req.user.email },
  });

  return res.json({ success: true });
});

router.patch('/api/security-deposit/users/:email', requireSecurityDepositRole('admin'), async (req, res) => {
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
    .eq('tool', 'security_deposit')
    .maybeSingle();
  const oldRole = existing ? existing.role : null;

  const { error: upsertErr } = await supabase
    .from('team_member_tool_roles')
    .upsert({
      team_member_id: member.id,
      tool: 'security_deposit',
      role,
      granted_by: req.user.email,
      granted_at: new Date().toISOString(),
    }, { onConflict: 'team_member_id,tool' });
  if (upsertErr) return res.status(500).json({ error: upsertErr.message });

  await supabase.from('audit_log').insert({
    action: 'team_member.role_changed',
    entity_type: 'team_member',
    entity_id: member.id,
    details: { tool: 'security_deposit', old_role: oldRole, new_role: role, changed_by: req.user.email },
  });

  return res.json({ success: true });
});

router.delete('/api/security-deposit/users/:email', requireSecurityDepositRole('admin'), async (req, res) => {
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
    .eq('tool', 'security_deposit')
    .maybeSingle();

  const { error } = await supabase
    .from('team_member_tool_roles')
    .delete()
    .eq('team_member_id', member.id)
    .eq('tool', 'security_deposit');
  if (error) return res.status(500).json({ error: error.message });

  await supabase.from('audit_log').insert({
    action: 'team_member.role_changed',
    entity_type: 'team_member',
    entity_id: member.id,
    details: { tool: 'security_deposit', old_role: existing ? existing.role : null, new_role: null, changed_by: req.user.email },
  });

  return res.json({ success: true });
});

// ─── Upload error handler — must be registered after the upload route ────
// Same reasoning as insurance/router.js's identical handler: turns a
// multer rejection (bad file type, over the 20MB limit) into the same
// clean { error: '...' } / 400 shape the rest of this file uses, instead
// of falling through to Express's generic 500 error page.
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message || 'Upload failed.' });
  }
  next();
});

// ─── internalRouter: no login required — own shared-secret check ──────────
// Called by cron, not a browser — must stay mounted BEFORE requireLogin
// in server.js, same as insuranceInternalRouter.
const internalRouter = express.Router();

function checkCronSecret(req, res) {
  const secret = req.headers['x-cron-secret'];
  if (!secret || secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ─── POST /api/security-deposit/internal/create-cases-from-sync ───────────
// Runs nightly, after the AppFolio sync. The moment a lease's
// move_out_date is filled in for the first time (tenant_tickler-owned —
// see 20260813000000), this opens a case for it. Idempotent via
// UNIQUE(lease_id) + upsert ignoreDuplicates, so re-running this never
// creates a second case for the same move-out.
internalRouter.post('/api/security-deposit/internal/create-cases-from-sync', async (req, res) => {
  if (!checkCronSecret(req, res)) return;
  const ts = new Date().toISOString();

  const { data: leaseRows, error } = await supabase
    .from('leases')
    .select('id, move_out_date')
    .not('move_out_date', 'is', null);
  if (error) {
    console.error(`[${ts}] create-cases-from-sync error:`, error.message);
    return res.status(500).json({ error: error.message });
  }
  if (!leaseRows || !leaseRows.length) {
    console.log(`[${ts}] create-cases-from-sync: no leases with a move_out_date`);
    return res.json({ created: 0 });
  }

  const caseRows = leaseRows.map(l => ({ lease_id: l.id, move_out_date: l.move_out_date }));
  const { data: inserted, error: insErr } = await supabase
    .from('security_deposit_cases')
    .upsert(caseRows, { onConflict: 'lease_id', ignoreDuplicates: true })
    .select('id, lease_id');
  if (insErr) {
    console.error(`[${ts}] create-cases-from-sync upsert error:`, insErr.message);
    return res.status(500).json({ error: insErr.message });
  }

  // Best-effort ai_suggested_tenancy_status for newly created cases only.
  // A lease with exactly one leaseholder ending its lease is
  // unambiguously the whole tenancy ending. More than one leaseholder
  // can't be distinguished from sync data alone (which specific tenant is
  // leaving isn't captured anywhere today) — left null for the pod lead
  // to confirm, never guessed at (SPEC.md Neo section #4: "pod-lead-
  // confirmable, never silently trusted").
  for (const row of inserted || []) {
    const { count } = await supabase
      .from('lease_tenants')
      .select('id', { count: 'exact', head: true })
      .eq('lease_id', row.lease_id);
    if (count === 1) {
      await supabase.from('security_deposit_cases')
        .update({ ai_suggested_tenancy_status: 'full_tenancy_ending' })
        .eq('id', row.id);
    }
  }

  const createdCount = inserted ? inserted.length : 0;
  console.log(`[${ts}] create-cases-from-sync: ${createdCount} new case(s)`);
  return res.json({ created: createdCount });
});

// ─── POST /api/security-deposit/internal/send-reminders ───────────────────
// Runs nightly. Day 7/14/18 after move-out = 14/7/3 days left on the
// 21-day clock. Fires regardless of in-tool review status — SPEC.md's
// Design call (Open Item #3, Peter confirmed "agree"): the tool has no
// way to verify the actual deposit-return letter was mailed, so the
// conservative default (keep warning) wins.
internalRouter.post('/api/security-deposit/internal/send-reminders', async (req, res) => {
  if (!checkCronSecret(req, res)) return;
  const ts = new Date().toISOString();
  const REMINDER_DAYS_LEFT = [14, 7, 3];

  const { data: cases, error } = await supabase
    .from('security_deposit_cases')
    .select(`
      id, disposition_deadline, status,
      leases ( units ( unit_number, properties ( name, address ) ) )
    `)
    .in('status', ['pending_review', 'reviewed', 'escalated']);
  if (error) {
    console.error(`[${ts}] send-reminders error:`, error.message);
    return res.status(500).json({ error: error.message });
  }

  const due = (cases || []).filter(c => REMINDER_DAYS_LEFT.includes(daysRemaining(c.disposition_deadline)));
  if (!due.length) {
    console.log(`[${ts}] send-reminders: nothing due today`);
    return res.json({ sent: 0, due: 0 });
  }

  // Every active pod_lead role holder gets every reminder in v1 — no
  // per-property pod routing yet (SPEC.md Deferred list / Open Item #2,
  // Peter confirmed "fine" as the v1 starting point).
  const { data: roleRows } = await supabase
    .from('team_member_tool_roles')
    .select('team_members ( email, is_active )')
    .eq('tool', 'security_deposit')
    .eq('role', 'pod_lead');
  const recipients = (roleRows || [])
    .filter(r => r.team_members && r.team_members.is_active)
    .map(r => r.team_members.email);

  if (!recipients.length) {
    console.warn(`[${ts}] send-reminders: ${due.length} case(s) due but no active pod_lead recipients found.`);
    return res.json({ sent: 0, due: due.length, warning: 'No active pod_lead recipients.' });
  }

  const list = due.map(c => {
    const addrProps = c.leases && c.leases.units && c.leases.units.properties;
    const addr = (addrProps && (addrProps.address || addrProps.name)) || 'Unknown property';
    const unit = c.leases && c.leases.units && c.leases.units.unit_number;
    return `- ${addr}${unit ? ' Unit ' + unit : ''}: ${daysRemaining(c.disposition_deadline)} days left`;
  }).join('\n');

  try {
    const mailer = createMailer();
    if (mailer) {
      await mailer.sendMail({
        from: process.env.GMAIL_USER,
        to: recipients.join(', '),
        subject: `Security Deposit: ${due.length} disposition${due.length === 1 ? '' : 's'} approaching the 21-day deadline`,
        text: `The following security deposit dispositions are approaching their 21-day deadline:\n\n${list}\n\nLog in to the Rincon Hub and open Security Deposit to review.`,
      });
      console.log(`[${ts}] send-reminders: notified ${recipients.length} pod lead(s) about ${due.length} case(s)`);
    } else {
      console.warn(`[${ts}] send-reminders: ${due.length} case(s) due but email is not configured (GMAIL_USER/GMAIL_APP_PASSWORD).`);
    }
  } catch (emailErr) {
    console.error(`[${ts}] send-reminders email error:`, emailErr.message);
  }

  return res.json({ sent: recipients.length, due: due.length });
});

// ─── POST /api/security-deposit/internal/index-b2-photos ──────────────────
// Periodic, incremental (per SPEC.md — "only new/changed folders since
// last run," never a live re-parse of the whole bucket on every case
// load). Sends Claude the folder path/name string ONLY (Asimov hard
// requirement — see lib/folder-parser.js) and uses the versioned,
// stored confidence threshold (GOVERNANCE.md Rule 5 — never hardcoded)
// to decide auto-index vs. manual-review.
internalRouter.post('/api/security-deposit/internal/index-b2-photos', async (req, res) => {
  if (!checkCronSecret(req, res)) return;

  if (!process.env.B2_APPLICATION_KEY_ID || !process.env.B2_APPLICATION_KEY || !process.env.B2_BUCKET_NAME) {
    return res.status(500).json({ error: 'B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY, and B2_BUCKET_NAME must be set in .env.' });
  }

  const ts = new Date().toISOString();

  const { data: config, error: configErr } = await supabase
    .from('b2_match_confidence_config')
    .select('id, auto_index_threshold, version')
    .eq('is_active', true)
    .maybeSingle();
  if (configErr) return res.status(500).json({ error: configErr.message });
  if (!config) return res.status(500).json({ error: 'No active b2_match_confidence_config row — cannot decide auto-index vs. manual-review.' });

  let allPaths;
  try {
    allPaths = await listPhotoFolders();
  } catch (err) {
    console.error(`[${ts}] index-b2-photos B2 error:`, err.message);
    return res.status(500).json({ error: 'Failed to list B2 folders.', detail: err.message });
  }

  const { data: existing, error: existingErr } = await supabase.from('b2_photo_folders').select('b2_folder_path');
  if (existingErr) return res.status(500).json({ error: existingErr.message });
  const existingPaths = new Set((existing || []).map(r => r.b2_folder_path));
  const newPaths = allPaths.filter(p => !existingPaths.has(p));

  let indexed = 0;
  const errors = [];

  for (const folderPath of newPaths) {
    try {
      const parsed = await parseFolderName(folderPath);
      const reviewStatus = parsed.confidence_score >= Number(config.auto_index_threshold) ? 'auto_indexed' : 'needs_review';

      const { data: row, error: insErr } = await supabase
        .from('b2_photo_folders')
        .insert({
          b2_folder_path: folderPath,
          parsed_address: parsed.parsed_address,
          parsed_unit: parsed.parsed_unit,
          parsed_inspection_type: parsed.parsed_inspection_type,
          parsed_date: parsed.parsed_date,
          confidence_score: parsed.confidence_score,
          confidence_config_id: config.id,
          review_status: reviewStatus,
          model_version: parsed.model_version,
        })
        .select('id')
        .single();
      if (insErr) throw insErr;

      // Hard requirement (Asimov) — every AI folder-name parse gets its
      // own audit_log entry, exactly the fields SPEC.md's Q section lists.
      await supabase.from('audit_log').insert({
        action: 'security_deposit.b2_folder_parsed',
        entity_type: 'b2_photo_folder',
        entity_id: row.id,
        details: {
          raw_folder_name: folderPath,
          parsed_address: parsed.parsed_address,
          parsed_unit: parsed.parsed_unit,
          parsed_date: parsed.parsed_date,
          confidence_score: parsed.confidence_score,
          model_version: parsed.model_version,
        },
      });
      indexed++;
    } catch (err) {
      console.error(`[${ts}] index-b2-photos error on "${folderPath}":`, err.message);
      errors.push({ folderPath, error: err.message });
    }
  }

  console.log(`[${ts}] index-b2-photos: ${indexed} new folder(s) indexed, ${errors.length} error(s), ${allPaths.length - newPaths.length} already indexed.`);
  return res.json({
    indexed,
    errors,
    total_folders_seen: allPaths.length,
    skipped_already_indexed: allPaths.length - newPaths.length,
  });
});

module.exports = { router, internalRouter };
