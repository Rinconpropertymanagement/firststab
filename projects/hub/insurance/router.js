/**
 * insurance/router.js
 * Insurance Compliance, migrated from projects/insurance-compliance/server.js
 * into a section of the Rincon Hub, mounted at /insurance (page) and
 * /api/insurance/* (API — paths unchanged from the standalone app on
 * purpose, so dashboard/index.html's existing fetch() calls needed zero
 * changes).
 *
 * WHAT CHANGED FROM THE STANDALONE APP — READ THIS FIRST
 *   1. Login: insurance-compliance used to run its own sign-in (Google
 *      OAuth via googleapis, restricted to @rinconmanagement.com) and its
 *      own Express session (FileStore-backed). Both are gone. Everyone
 *      reaching any route in this file has ALREADY been authenticated by
 *      the hub's shared login (lib/middleware.js's requireLogin, mounted
 *      in server.js before this router) — real Supabase Auth email +
 *      password, the same login as every other hub section. There is no
 *      second sign-in screen.
 *   2. Permissions: the old requireRole() checked req.session.user.role,
 *      set once at OAuth login time from a standalone table
 *      (insurance_user_roles). That table had no connection to anything
 *      else — it was just a list of emails and roles. Neo's migration
 *      (supabase/migrations/20260812020000_shared_team_members.sql) adds
 *      two shared tables instead:
 *        - team_members            — is this person a real, active Rincon
 *                                     team member, tied to their Supabase
 *                                     Auth login (auth_user_id)?
 *        - team_member_tool_roles  — what role do they hold specifically
 *                                     for tool='insurance_compliance'?
 *      attachInsuranceRole() below looks both of these up on every request
 *      and attaches req.insuranceRole — same 4 role names as before
 *      (admin, director_of_operations, property_manager,
 *      inspection_coordinator), same meaning, just sourced from the new
 *      shared tables instead of the old standalone one.
 *   3. NOT YET LIVE: as of this migration, Neo's migration has been
 *      WRITTEN but not yet applied to the real database, and the two
 *      tables have no rows in them yet either way (they're additive/new —
 *      nothing was copied over from insurance_user_roles). Until both of
 *      those happen, every lookup below will find nobody, so
 *      req.insuranceRole will be null for everyone (including Peter) and
 *      every route past requireInsuranceAccess will correctly, safely
 *      respond "you don't have access" (403) rather than erroring or
 *      letting anyone through. That is expected right now, not a bug —
 *      see the migration handoff for the next steps (apply the migration,
 *      then seed at least one admin row).
 *   4. Business logic — extraction, review queue, approvals, escalation
 *      emails, batch upload, address matching, etc. — is UNCHANGED. Every
 *      route below does exactly what it did in the standalone app, just
 *      re-homed here.
 *
 * Two routers are exported on purpose:
 *   router          Everything a logged-in hub user can reach: the
 *                    dashboard page and all /api/insurance/* routes.
 *                    Must be mounted AFTER requireLogin in server.js.
 *   internalRouter   Just the nightly cron endpoint
 *                    (check-new-properties), which authenticates with its
 *                    own shared secret header instead of a browser login —
 *                    same as before this migration. Must be mounted
 *                    BEFORE requireLogin in server.js, or the cron job's
 *                    request would get redirected to /login and fail.
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { extractPolicy } = require('./extract-policy');
const { GLOBAL_SEARCH_WIDGET_HTML } = require('../lib/global-search-widget');

// ─── Nodemailer (email notifications) — unchanged from the standalone app ──
let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  console.warn('[insurance email] nodemailer not installed — email notifications disabled. Run: npm install nodemailer');
}

function createMailer() {
  if (!nodemailer || !process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
}

async function sendPMQueueEmail(toEmail, entries) {
  try {
    const mailer = createMailer();
    if (!mailer) return;
    const list = entries.map(e =>
      `- ${e.address}: AI flagged as ${e.aiStatus || 'pending review'}`
    ).join('\n');
    await mailer.sendMail({
      from: process.env.GMAIL_USER,
      to: toEmail,
      subject: `Insurance Review Queue: ${entries.length} new polic${entries.length === 1 ? 'y' : 'ies'} need review`,
      text: `The following policies were uploaded and need your review:\n\n${list}\n\nLog in to the Rincon Hub and open Insurance Compliance to review.`,
    });
    console.log(`[email] PM queue notification sent to ${toEmail}`);
  } catch (err) {
    console.error('[email] Failed to send PM queue email:', err.message);
  }
}

async function sendEscalationEmail(rec, reviewerName, notes, aiStatus) {
  try {
    const mailer = createMailer();
    if (!mailer || !process.env.DO_EMAIL) return;
    const addr = rec.property_address_on_policy || 'Unknown property';
    await mailer.sendMail({
      from: process.env.GMAIL_USER,
      to: process.env.DO_EMAIL,
      subject: `Insurance Escalation: ${addr} flagged as ${aiStatus}`,
      text: [
        'A policy has been escalated for your review.',
        '',
        `Property:   ${addr}`,
        `Insurer:    ${rec.insurer_name || '—'}`,
        `Policy #:   ${rec.policy_number || '—'}`,
        `Expiration: ${rec.expiration_date || '—'}`,
        `Coverage:   ${rec.coverage_amount ? '$' + Number(rec.coverage_amount).toLocaleString() : '—'}`,
        `AI Status:  ${aiStatus}`,
        `Escalated by: ${reviewerName}`,
        notes ? `Notes: ${notes}` : '',
        '',
        'Please log in to the Rincon Hub and open Insurance Compliance to confirm.',
      ].filter(l => l !== null).join('\n'),
    });
    console.log('[email] Escalation email sent to DO');
  } catch (err) {
    console.error('[email] Failed to send escalation email:', err.message);
  }
}

// ─── Config ─────────────────────────────────────────────────────────────
// SUPABASE_URL, SESSION_SECRET etc. are already validated by hub/server.js
// before this file is ever required. Only check what's specific to this
// section and not already guaranteed by the hub.
const missing = [];
if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
if (missing.length > 0) {
  console.error(`[insurance] Missing environment variables: ${missing.join(', ')}`);
  console.error('[insurance] Set these in the shared .env at the project root (see .env.example).');
  process.exit(1);
}

// Service role key — bypasses Row Level Security, same pattern used
// throughout this codebase (see supabase/migrations/20260812020000's note:
// every tool that touches Supabase today reads/writes through its backend
// with the service role key, so team_members/team_member_tool_roles work
// correctly even with zero RLS policies of their own).
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Still a sensible guard on who can be GRANTED insurance-compliance access,
// independent of how they sign in — kept from the standalone app.
const ALLOWED_DOMAIN = 'rinconmanagement.com';

// ─── Multer (file upload) — unchanged from the standalone app ─────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: '/tmp',
    filename: (req, file, cb) => {
      const ts = Date.now();
      cb(null, `insurance-upload-${ts}-${file.originalname}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}. Accepted: ${allowed.join(', ')}`));
    }
  },
});

// ─── Permission check — reads Neo's shared team tables ────────────────────
// Runs on every request to this section. req.user is already set by the
// hub's requireLogin (a real, currently-valid Supabase Auth user) by the
// time any route here executes — this middleware answers the NEXT
// question: is this specific person allowed in Insurance Compliance, and
// with what role.
async function attachInsuranceRole(req, res, next) {
  req.insuranceRole = null;
  req.teamMemberId = null;
  req.insuranceMemberName = null;

  try {
    const { data: member, error: memberErr } = await supabase
      .from('team_members')
      .select('id, full_name, is_active')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();

    if (memberErr) throw memberErr;
    if (!member || !member.is_active) return next();

    req.teamMemberId = member.id;
    req.insuranceMemberName = member.full_name || null;

    const { data: roleRow, error: roleErr } = await supabase
      .from('team_member_tool_roles')
      .select('role')
      .eq('team_member_id', member.id)
      .eq('tool', 'insurance_compliance')
      .maybeSingle();

    if (roleErr) throw roleErr;
    req.insuranceRole = roleRow ? roleRow.role : null;
    next();
  } catch (err) {
    // Fail closed: if the permission tables can't be reached (e.g. Neo's
    // migration hasn't been applied to the live database yet), treat the
    // request as having no access rather than letting it through. This is
    // the expected state until that migration lands — see the file header.
    console.error('[insurance] permission lookup failed:', err.message);
    next();
  }
}

function requireInsuranceAccess(req, res, next) {
  if (!req.insuranceRole) {
    return res.status(403).json({
      error: 'Your Rincon Hub account does not have access to Insurance Compliance yet. Ask an admin to grant you access.',
    });
  }
  next();
}

function requireInsuranceRole(...roles) {
  return (req, res, next) => {
    if (!req.insuranceRole || !roles.includes(req.insuranceRole)) {
      return res.status(403).json({ error: 'Insufficient permissions', required: roles, actual: req.insuranceRole });
    }
    next();
  };
}

// ─── Router: everyone reaching here is already hub-logged-in ──────────────
const router = express.Router();
router.use(attachInsuranceRole);

// ─── GET /insurance — the dashboard page ───────────────────────────────────
// No server-side access gate here on purpose — this is just the static
// page shell (no data embedded in it). The page's own JS calls
// /api/insurance/auth/me on load and shows a friendly "no access" message
// if that comes back 403, which reads better than a bare redirect. Every
// route that actually returns or changes data below IS gated.
// Reads the file and injects the hub-wide search widget right after
// <body> instead of a plain res.sendFile — this is a static page with no
// templating engine, so a string replace at serve time is the simplest
// way to drop the same shared widget (lib/global-search-widget.js) onto
// it without duplicating that markup by hand in this file.
router.get('/insurance', (req, res) => {
  fs.readFile(path.join(__dirname, 'dashboard', 'index.html'), 'utf8', (err, html) => {
    if (err) return res.status(500).send('Could not load page.');
    res.send(html.replace('<body>', '<body>\n' + GLOBAL_SEARCH_WIDGET_HTML));
  });
});

// ─── GET /api/insurance/auth/me ────────────────────────────────────────────
// Replaces the old OAuth-session version. Same response shape the
// dashboard already expects: { email, name, role }.
router.get('/api/insurance/auth/me', requireInsuranceAccess, (req, res) => {
  res.json({
    email: req.user.email,
    name: req.insuranceMemberName || req.user.email,
    role: req.insuranceRole,
  });
});

// ─── GET /api/insurance/records ────────────────────────────────────────────
router.get('/api/insurance/records', requireInsuranceAccess, async (req, res) => {
  const { data, error } = await supabase
    .from('property_insurance')
    .select(`
      id, document_id, policy_number, insurer_name, expiration_date, effective_date,
      coverage_amount, additional_insured_verified, coverage_amount_verified,
      status, ai_suggested_status, updated_at, created_at, notes, named_insured,
      property_address_on_policy,
      properties ( name, pod, address, appfolio_id ),
      documents ( id, file_name, file_path )
    `)
    .eq('is_current', true)
    .order('expiration_date', { ascending: true, nullsFirst: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data || []);
});

// ─── POST /api/insurance/upload ────────────────────────────────────────────
router.post('/api/insurance/upload', requireInsuranceAccess, upload.single('file'), async (req, res) => {
  const ts = new Date().toISOString();
  const appfolio_property_id = req.body.appfolio_property_id;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }
  if (!appfolio_property_id) {
    return res.status(400).json({ error: 'appfolio_property_id is required.' });
  }

  const filePath = req.file.path;
  const originalName = req.file.originalname;
  const ext = path.extname(originalName).toLowerCase();

  const MIME_MAP = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
  };
  const mimeType = MIME_MAP[ext] || 'application/octet-stream';

  console.log(`[${ts}] Upload: ${originalName} | property: ${appfolio_property_id}`);

  // Step 1: Extract policy fields via Claude
  // extractPolicy() always returns an ARRAY — one object per property found
  // in the document (see extract-policy.js) — even when only one file was
  // uploaded. This route only handles one property per upload (the caller
  // already chose it via appfolio_property_id), so take the first extracted
  // object, same as batch-upload does per property (router.js line ~645).
  // Previously `extracted` was left as the raw array, so extracted.property_
  // address / .insurer_name / .expiration_date were all undefined below,
  // which made makeCleanFilename() fall back to its default name on every
  // single upload — collapsing every file to insurance-documents/insurance-
  // document.pdf and silently overwriting the previous one.
  let extracted;
  try {
    const extractedArr = await extractPolicy(filePath);
    extracted = extractedArr[0] || {};
    console.log(`[${ts}] Extraction done. policy_number=${extracted.policy_number}`);
  } catch (err) {
    console.error(`[${ts}] Extraction error:`, err.message);
    return res.status(500).json({ error: 'Failed to extract policy fields.', detail: err.message });
  }

  // Step 2: Look up the property in Supabase
  let propertyId = null;
  let propertyName = null;
  try {
    const { data: props } = await supabase
      .from('properties')
      .select('id, name, address')
      .eq('appfolio_id', appfolio_property_id)
      .limit(1);
    if (props && props.length > 0) {
      propertyId = props[0].id;
      propertyName = props[0].name;
    }
  } catch (err) {
    // Non-fatal — property lookup failure shouldn't block the upload
    console.warn(`[${ts}] Property lookup warning:`, err.message);
  }

  // Step 3: Upload file to Supabase Storage before deleting temp copy
  await ensureStorageBucket();
  const fileBuffer = fs.readFileSync(filePath);
  const storageKey = makeCleanFilename(extracted, ext);
  const { error: uploadErr } = await supabase.storage
    .from('insurance-documents')
    .upload(storageKey, fileBuffer, { contentType: mimeType, upsert: true });

  fs.unlink(filePath, () => {}); // safe to delete now regardless of outcome

  if (uploadErr) {
    console.error(`[${ts}] Storage upload error:`, uploadErr.message);
    return res.status(500).json({ error: 'Failed to store document file.', detail: uploadErr.message });
  }

  // Step 4: Insert a row into documents (storageKey is used by the signed-URL endpoint)
  const { data: docRows, error: docErr } = await supabase
    .from('documents')
    .insert({
      file_name: storageKey,
      file_path: storageKey,
      file_type: 'insurance_certificate',
      entity_type: 'property',
      entity_id: propertyId,
      mime_type: mimeType,
    })
    .select('id')
    .single();

  if (docErr) {
    console.error(`[${ts}] documents insert error:`, docErr.message);
    return res.status(500).json({ error: 'Failed to save document record.', detail: docErr.message });
  }

  return res.json({
    document_id: docRows.id,
    appfolio_property_id,
    property_name: propertyName,
    extracted,
  });
});

// ─── POST /api/insurance/save ──────────────────────────────────────────────
router.post('/api/insurance/save', requireInsuranceAccess, async (req, res) => {
  const ts = new Date().toISOString();
  const {
    appfolio_property_id,
    property_id,
    document_id,
    policy_number,
    insurer_name,
    effective_date,
    expiration_date,
    coverage_amount,
    named_insured,
    property_address_on_policy,
    additional_insured_verified,
    coverage_amount_verified,
    notes,
  } = req.body;

  // Validation
  if (!expiration_date) {
    return res.status(400).json({ error: 'expiration_date is required.' });
  }
  if (!additional_insured_verified) {
    return res.status(400).json({ error: 'additional_insured_verified must be true before saving.' });
  }
  if (!coverage_amount_verified) {
    return res.status(400).json({ error: 'coverage_amount_verified must be true before saving.' });
  }

  console.log(`[${ts}] Save policy: property=${appfolio_property_id} policy#=${policy_number}`);

  // Step 1: Mark previous current policy as not current
  const { error: updateErr } = await supabase
    .from('property_insurance')
    .update({ is_current: false, updated_at: new Date().toISOString() })
    .eq('appfolio_property_id', appfolio_property_id)
    .eq('is_current', true);

  if (updateErr) {
    console.error(`[${ts}] Update previous policy error:`, updateErr.message);
    return res.status(500).json({ error: 'Failed to update previous policy.', detail: updateErr.message });
  }

  // Step 2: Insert new policy row
  const now = new Date().toISOString();
  const covAmt = coverage_amount != null && coverage_amount !== '' ? Number(coverage_amount) : null;
  const isExpired = expiration_date && new Date(expiration_date) < new Date();
  const daysToExp = expiration_date ? Math.floor((new Date(expiration_date) - new Date()) / 86400000) : null;
  const isExpiring = daysToExp !== null && daysToExp >= 0 && daysToExp <= 30;
  const belowMin = covAmt != null && covAmt < 500000;
  const noAddlIns = !additional_insured_verified;
  const aiStatus = isExpired ? 'expired'
    : belowMin ? 'insufficient_liability'
    : noAddlIns ? 'no_additional_insured'
    : isExpiring ? 'expiring_soon'
    : 'compliant';

  const { data: insRows, error: insErr } = await supabase
    .from('property_insurance')
    .insert({
      appfolio_property_id,
      property_id: property_id || null,
      document_id: document_id || null,
      policy_number,
      insurer_name,
      effective_date: effective_date || null,
      expiration_date,
      coverage_amount: covAmt,
      named_insured: named_insured || null,
      property_address_on_policy: property_address_on_policy || null,
      additional_insured_verified: !!additional_insured_verified,
      coverage_amount_verified: !!coverage_amount_verified,
      notes: notes || null,
      is_current: true,
      status: 'pending_review',
      ai_suggested_status: aiStatus,
      verified_at: now,
    })
    .select('id')
    .single();

  if (insErr) {
    console.error(`[${ts}] property_insurance insert error:`, insErr.message);
    return res.status(500).json({ error: 'Failed to save insurance record.', detail: insErr.message });
  }

  const insuranceId = insRows.id;

  // Step 3: Insert workflow_instances row
  const { error: wfErr } = await supabase
    .from('workflow_instances')
    .insert({
      workflow_type: 'insurance_compliance',
      entity_type: 'property',
      entity_id: property_id || null,
      status: 'completed',
      completed_at: now,
    });

  if (wfErr) {
    // Non-fatal — log and continue
    console.warn(`[${ts}] workflow_instances insert warning:`, wfErr.message);
  }

  // Step 4: Insert audit_log row
  const { error: auditErr } = await supabase
    .from('audit_log')
    .insert({
      action: 'insurance.verified',
      entity_type: 'property',
      entity_id: property_id || null,
      details: { policy_number, expiration_date, document_id },
    });

  if (auditErr) {
    console.warn(`[${ts}] audit_log insert warning:`, auditErr.message);
  }

  console.log(`[${ts}] Policy saved. insurance_id=${insuranceId}`);
  return res.json({ success: true, insurance_id: insuranceId });
});

// ─── PATCH /api/insurance/policy/:id ───────────────────────────────────────
router.patch('/api/insurance/policy/:id', requireInsuranceAccess, async (req, res) => {
  const allowed = ['additional_insured_verified', 'coverage_amount_verified'];
  const updates = {};
  for (const field of allowed) {
    if (typeof req.body[field] === 'boolean') updates[field] = req.body[field];
  }
  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'No valid fields to update.' });
  }
  updates.updated_at = new Date().toISOString();
  const { error } = await supabase
    .from('property_insurance')
    .update(updates)
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

// ─── GET /api/insurance/document/:id ───────────────────────────────────────
router.get('/api/insurance/document/:id', requireInsuranceAccess, async (req, res) => {
  const { data: doc, error } = await supabase
    .from('documents')
    .select('file_name, file_path')
    .eq('id', req.params.id)
    .single();

  if (error || !doc) return res.status(404).send('Document not found.');

  const { data: signed, error: signErr } = await supabase.storage
    .from('insurance-documents')
    .createSignedUrl(doc.file_name, 3600);

  if (signErr || !signed) return res.status(500).send('Could not generate download link.');

  res.redirect(signed.signedUrl);
});

// ─── Address helpers — unchanged ───────────────────────────────────────────
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

function findBestPropertyMatch(extractedAddress, properties) {
  if (!extractedAddress || !properties || !properties.length) return null;
  const normExt = normalizeAddress(extractedAddress);
  if (!normExt) return null;
  let best = null, bestScore = 0;
  for (const prop of properties) {
    const score = addressWordScore(normExt, normalizeAddress(prop.address || ''));
    if (score > bestScore && score >= 0.6) { bestScore = score; best = prop; }
  }
  return best;
}

// ─── Clean filename — unchanged ────────────────────────────────────────────
function makeCleanFilename(extracted, ext) {
  const parts = [];
  if (extracted && extracted.property_address)
    parts.push(extracted.property_address.split(',')[0].trim());
  if (extracted && extracted.insurer_name)
    parts.push(extracted.insurer_name);
  if (extracted && extracted.expiration_date)
    parts.push('exp ' + extracted.expiration_date);
  const name = (parts.length ? parts.join(' - ') : 'insurance-document')
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return name + (ext || '.pdf');
}

// ─── Storage bucket — unchanged ────────────────────────────────────────────
async function ensureStorageBucket() {
  const { error } = await supabase.storage.createBucket('insurance-documents', { public: false });
  // Ignore "already exists" — any other error is logged but non-fatal
  if (error && error.message && !/already exist|duplicate/i.test(error.message)) {
    console.warn('[batch] Storage bucket warn:', error.message);
  }
}

// ─── GET /api/insurance/properties ─────────────────────────────────────────
router.get('/api/insurance/properties', requireInsuranceAccess, async (req, res) => {
  const { data, error } = await supabase
    .from('properties')
    .select('id, name, address, appfolio_id')
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data || []);
});

// ─── POST /api/insurance/batch-upload ──────────────────────────────────────
router.post('/api/insurance/batch-upload', requireInsuranceAccess, upload.array('files', 50), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded.' });
  }
  const ts = new Date().toISOString();
  console.log(`[${ts}] Batch upload: ${req.files.length} file(s)`);

  const { data: properties } = await supabase
    .from('properties')
    .select('id, name, address, appfolio_id');

  const results = [];

  for (const file of req.files) {
    const ext = path.extname(file.originalname).toLowerCase();
    try {
      const fileBuffer = fs.readFileSync(file.path);
      const fileBase64 = fileBuffer.toString('base64');
      const extractedArr = await extractPolicy(file.path);
      console.log(`[${ts}] Extracted ${extractedArr.length} propert(ies) from ${file.originalname}: ${extractedArr.map(e => e.property_address).join(' | ')}`);

      for (const extracted of extractedArr) {
        // Reject non-California addresses — they're the insurer's office, not the property
        if (extracted.property_address && !/\bCA\b|California/i.test(extracted.property_address)) {
          console.log(`[${ts}] Rejected non-CA address: ${extracted.property_address}`);
          extracted.property_address = null;
        }

        const cleanFilename = makeCleanFilename(extracted, ext);
        const matched = findBestPropertyMatch(
          extracted.property_address,
          properties || []
        );

        let has_existing_policy = false;
        if (matched && matched.appfolio_id) {
          const { data: existing } = await supabase
            .from('property_insurance')
            .select('id')
            .eq('appfolio_property_id', matched.appfolio_id)
            .eq('is_current', true)
            .limit(1);
          has_existing_policy = !!(existing && existing.length > 0);
        }

        // Flag records where AI could not extract any identifying fields
        const extractionFailed = !extracted.policy_number && !extracted.insurer_name && !extracted.expiration_date;

        results.push({
          original_filename: file.originalname,
          clean_filename: cleanFilename,
          file_base64: fileBase64,
          file_mime_type: file.mimetype,
          extracted,
          matched_property: matched
            ? { id: matched.id, appfolio_id: matched.appfolio_id, name: matched.name, address: matched.address }
            : null,
          has_existing_policy,
          extraction_failed: extractionFailed,
          error: null,
        });
      }
    } catch (err) {
      console.error(`[${ts}] Batch extract error (${file.originalname}):`, err.message);
      results.push({
        original_filename: file.originalname,
        clean_filename: null,
        file_base64: null,
        file_mime_type: null,
        extracted: null,
        matched_property: null,
        has_existing_policy: false,
        error: err.message,
      });
    } finally {
      fs.unlink(file.path, () => {});
    }
  }

  return res.json({ results });
});

// ─── POST /api/insurance/batch-save ────────────────────────────────────────
router.post('/api/insurance/batch-save', requireInsuranceAccess, async (req, res) => {
  const ts = new Date().toISOString();
  const records = req.body.records;

  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'records array is required.' });
  }

  console.log(`[${ts}] Batch save: ${records.length} record(s)`);
  await ensureStorageBucket();

  const MIME_MAP = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
  };

  let saved = 0;
  const failures = [];
  const outcomes = [];
  const queueEntries = []; // accumulate for PM notification email

  for (const record of records) {
    const {
      file_data,
      file_mime_type,
      clean_filename,
      extracted,
      property_id,
      appfolio_property_id,
      additional_insured_verified,
      coverage_amount_verified,
    } = record;

    const label = (extracted && extracted.property_address)
      ? extracted.property_address.split(',')[0].trim()
      : (clean_filename || appfolio_property_id || 'unknown');

    try {
      // Upload to Supabase Storage
      const fileBuffer = Buffer.from(file_data, 'base64');
      const ext = path.extname(clean_filename || '').toLowerCase();
      const contentType = file_mime_type || MIME_MAP[ext] || 'application/octet-stream';

      const { error: uploadErr } = await supabase.storage
        .from('insurance-documents')
        .upload(clean_filename, fileBuffer, { contentType, upsert: true });
      if (uploadErr) throw new Error('Storage upload failed: ' + uploadErr.message);

      const { data: urlData } = supabase.storage
        .from('insurance-documents')
        .getPublicUrl(clean_filename);
      const fileUrl = urlData.publicUrl;

      // Flip existing current policy to inactive
      if (appfolio_property_id) {
        await supabase
          .from('property_insurance')
          .update({ is_current: false, updated_at: new Date().toISOString() })
          .eq('appfolio_property_id', appfolio_property_id)
          .eq('is_current', true);
      }

      // Insert document record
      const { data: docRow, error: docErr } = await supabase
        .from('documents')
        .insert({
          file_name: clean_filename,
          file_path: fileUrl,
          file_type: 'insurance_certificate',
          mime_type: contentType,
          entity_type: 'property',
          entity_id: property_id,
        })
        .select('id')
        .single();
      if (docErr) throw new Error('Document insert failed: ' + docErr.message);

      // Insert new property_insurance record
      const now = new Date().toISOString();
      // Parse coverage_amount as a number — it may arrive as a string or 0, and
      // (value || null) would wrongly coerce 0 to null.
      const rawCov = extracted && extracted.coverage_amount;
      const covAmt = (rawCov != null && rawCov !== '')
        ? (isNaN(Number(rawCov)) ? null : Number(rawCov))
        : null;
      const expDate = (extracted && extracted.expiration_date) || null;
      const isExpired = expDate && new Date(expDate) < new Date();
      const daysToExp = expDate ? Math.floor((new Date(expDate) - new Date()) / 86400000) : null;
      const isExpiring = daysToExp !== null && daysToExp >= 0 && daysToExp <= 30;
      const belowMin = covAmt != null && covAmt < 500000;
      const noAddlInsured = !additional_insured_verified;
      const recStatus = isExpired ? 'expired'
        : belowMin ? 'insufficient_liability'
        : noAddlInsured ? 'no_additional_insured'
        : isExpiring ? 'expiring_soon'
        : 'compliant';

      const { error: insErr } = await supabase.from('property_insurance').insert({
        property_id: property_id || null,
        appfolio_property_id,
        policy_number: (extracted && extracted.policy_number) || null,
        insurer_name: (extracted && extracted.insurer_name) || null,
        effective_date: (extracted && extracted.effective_date) || null,
        expiration_date: (extracted && extracted.expiration_date) || null,
        coverage_amount: covAmt,
        named_insured: (extracted && extracted.named_insured) || null,
        property_address_on_policy: (extracted && extracted.property_address) || null,
        additional_insured_verified: !!additional_insured_verified,
        coverage_amount_verified: !!coverage_amount_verified,
        status: 'pending_review',
        ai_suggested_status: recStatus,
        is_current: true,
        document_id: docRow.id,
        notes: belowMin && coverage_amount_verified
          ? `Low liability accepted: $${covAmt.toLocaleString()} (below $500K minimum — manually accepted)`
          : null,
      });
      if (insErr) throw new Error('Insurance insert failed: ' + insErr.message);

      // Audit log
      await supabase.from('audit_log').insert({
        action: 'insurance.batch_saved',
        entity_type: 'property',
        entity_id: property_id,
        details: {
          policy_number: (extracted && extracted.policy_number) || null,
          expiration_date: (extracted && extracted.expiration_date) || null,
          clean_filename,
        },
      });

      saved++;
      outcomes.push(label + ': saved');
      queueEntries.push({ address: label, aiStatus: recStatus, property_id: property_id || null });
    } catch (err) {
      console.error(`[${ts}] Batch save error (${label}):`, err.message);
      failures.push({ address: label, error: err.message });
      outcomes.push(label + ': error — ' + err.message);
    }
  }

  // ── Send PM notification emails, routed by pod ───────────────────────────
  if (queueEntries.length > 0) {
    try {
      // Look up pod for each saved property_id in one query
      const propIds = [...new Set(queueEntries.map(e => e.property_id).filter(Boolean))];
      let podMap = {};
      if (propIds.length > 0) {
        const { data: propRows } = await supabase
          .from('properties')
          .select('id, pod')
          .in('id', propIds);
        if (propRows) propRows.forEach(p => { podMap[p.id] = p.pod; });
      }
      // Group entries by pod
      const byPod = { Faria: [], Solimar: [], unknown: [] };
      queueEntries.forEach(e => {
        const pod = podMap[e.property_id] || null;
        if (pod === 'Faria') byPod.Faria.push(e);
        else if (pod === 'Solimar') byPod.Solimar.push(e);
        else byPod.unknown.push(e);
      });
      if (byPod.Faria.length > 0)
        await sendPMQueueEmail('fariateam@rinconmanagement.com', byPod.Faria);
      if (byPod.Solimar.length > 0)
        await sendPMQueueEmail('solimarteam@rinconmanagement.com', byPod.Solimar);
      // Unmatched properties go to both pod inboxes
      if (byPod.unknown.length > 0) {
        await sendPMQueueEmail('fariateam@rinconmanagement.com', byPod.unknown);
        await sendPMQueueEmail('solimarteam@rinconmanagement.com', byPod.unknown);
      }
    } catch (emailErr) {
      console.error(`[${ts}] PM email error:`, emailErr.message);
    }
  }

  // One summary task for the whole batch
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 1);
  const { error: taskErr } = await supabase.from('tasks').insert({
    title: `Batch insurance import: ${saved} of ${records.length} policies saved`,
    description: outcomes.join('\n'),
    status: 'open',
    priority: 'medium',
    assigned_to: null,
    due_date: dueDate.toISOString().slice(0, 10),
    entity_type: 'batch_import',
    entity_id: crypto.randomUUID(),
  });
  if (taskErr) console.warn(`[${ts}] Summary task warn: ${taskErr.message}`);

  console.log(`[${ts}] Batch save complete. Saved: ${saved} / Failed: ${failures.length}`);
  return res.json({
    saved,
    failed: failures.length,
    total: records.length,
    ...(failures.length > 0 && { errors: failures }),
  });
});

// ─── GET /api/insurance/review-queue ───────────────────────────────────────
// Returns records in 'pending_review' or 'escalated' status.
// The dashboard filters by role on the frontend.
router.get('/api/insurance/review-queue', requireInsuranceAccess, async (req, res) => {
  const { data, error } = await supabase
    .from('property_insurance')
    .select(`
      id, property_id, policy_number, insurer_name, expiration_date,
      coverage_amount, additional_insured_verified, status, ai_suggested_status,
      property_address_on_policy, named_insured, created_at, document_id,
      properties ( name, address )
    `)
    .in('status', ['pending_review', 'escalated'])
    .eq('is_current', true)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  return res.json(data || []);
});

// ─── POST /api/insurance/approve/:id ───────────────────────────────────────
// PM approves a pending record.
// If AI suggested non-compliant status → set status = 'escalated', email DO.
// If AI suggested compliant/expiring_soon → set that status directly.
router.post('/api/insurance/approve/:id', requireInsuranceRole('admin', 'director_of_operations', 'property_manager'), async (req, res) => {
  const ts = new Date().toISOString();
  const { reviewer_name, reviewer_notes } = req.body;
  const id = req.params.id;

  if (!reviewer_name) return res.status(400).json({ error: 'reviewer_name is required.' });

  const { data: rec, error: fetchErr } = await supabase
    .from('property_insurance')
    .select('ai_suggested_status, property_address_on_policy, insurer_name, expiration_date, coverage_amount, policy_number')
    .eq('id', id)
    .single();

  if (fetchErr || !rec) return res.status(404).json({ error: 'Record not found.' });

  const aiStatus = rec.ai_suggested_status || 'compliant';
  const now = new Date().toISOString();
  // Non-compliant statuses require DO confirmation
  const nonCompliant = ['expired', 'insufficient_liability', 'no_additional_insured'];
  const newStatus = nonCompliant.includes(aiStatus) ? 'escalated' : aiStatus;

  const { data: updated, error: updateErr } = await supabase
    .from('property_insurance')
    .update({
      status: newStatus,
      reviewed_by: reviewer_name,
      reviewed_at: now,
      reviewer_notes: reviewer_notes || null,
      updated_at: now,
    })
    .eq('id', id)
    .select()
    .single();

  if (updateErr) return res.status(500).json({ error: updateErr.message });

  if (newStatus === 'escalated') {
    await sendEscalationEmail(rec, reviewer_name, reviewer_notes || '', aiStatus);
    console.log(`[${ts}] Approved→escalated: id=${id} aiStatus=${aiStatus}`);
  } else {
    console.log(`[${ts}] Approved as ${newStatus}: id=${id}`);
  }

  return res.json({ success: true, record: updated });
});

// ─── POST /api/insurance/escalate-confirm/:id ──────────────────────────────
// Director of Operations confirms a non-compliant policy.
// Sets status to the AI-suggested value (expired, insufficient_liability, etc.).
router.post('/api/insurance/escalate-confirm/:id', requireInsuranceRole('admin', 'director_of_operations'), async (req, res) => {
  const ts = new Date().toISOString();
  const { reviewer_name, reviewer_notes } = req.body;
  const id = req.params.id;

  if (!reviewer_name) return res.status(400).json({ error: 'reviewer_name is required.' });

  const { data: rec, error: fetchErr } = await supabase
    .from('property_insurance')
    .select('ai_suggested_status')
    .eq('id', id)
    .single();

  if (fetchErr || !rec) return res.status(404).json({ error: 'Record not found.' });

  const finalStatus = rec.ai_suggested_status || 'expired';
  const now = new Date().toISOString();

  const { data: updated, error: updateErr } = await supabase
    .from('property_insurance')
    .update({
      status: finalStatus,
      escalated_by: reviewer_name,
      escalated_at: now,
      reviewer_notes: reviewer_notes || null,
      updated_at: now,
    })
    .eq('id', id)
    .select()
    .single();

  if (updateErr) return res.status(500).json({ error: updateErr.message });
  console.log(`[${ts}] DO confirmed non-compliant: id=${id} status=${finalStatus}`);
  return res.json({ success: true, record: updated });
});

// ─── POST /api/insurance/reject/:id ────────────────────────────────────────
// Mark a record as removed (is_current = false).
// Used when a document is wrong, unreadable, or uploaded by mistake.
router.post('/api/insurance/reject/:id', requireInsuranceRole('admin', 'director_of_operations', 'property_manager'), async (req, res) => {
  const ts = new Date().toISOString();
  const { reviewer_name, reason } = req.body;
  const id = req.params.id;

  if (!reviewer_name) return res.status(400).json({ error: 'reviewer_name is required.' });

  const now = new Date().toISOString();
  const { error } = await supabase
    .from('property_insurance')
    .update({
      is_current: false,
      reviewed_by: reviewer_name,
      reviewed_at: now,
      reviewer_notes: `REJECTED by ${reviewer_name}: ${reason || '(no reason given)'}`,
      updated_at: now,
    })
    .eq('id', id);

  if (error) return res.status(500).json({ error: error.message });
  console.log(`[${ts}] Record rejected: id=${id} by=${reviewer_name}`);
  return res.json({ success: true });
});

// ─── GET /api/insurance/notes/:insuranceId ─────────────────────────────────
router.get('/api/insurance/notes/:insuranceId', requireInsuranceAccess, async (req, res) => {
  const { data, error } = await supabase
    .from('insurance_notes')
    .select('id, note, created_by, created_at')
    .eq('insurance_id', req.params.insuranceId)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data || []);
});

// ─── POST /api/insurance/notes/:insuranceId ────────────────────────────────
router.post('/api/insurance/notes/:insuranceId', requireInsuranceAccess, async (req, res) => {
  const { note } = req.body;
  if (!note || !note.trim()) return res.status(400).json({ error: 'Note text is required.' });
  const created_by = req.insuranceMemberName || req.user.email;
  const { error } = await supabase.from('insurance_notes').insert({
    insurance_id: req.params.insuranceId,
    note: note.trim(),
    created_by,
  });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

// ─── GET /api/insurance/document/:id/download ──────────────────────────────
// Streams the file with Content-Disposition: attachment so the browser downloads
// it instead of opening it — ready to attach in AppFolio.
router.get('/api/insurance/document/:id/download', requireInsuranceAccess, async (req, res) => {
  const { data: doc, error } = await supabase
    .from('documents')
    .select('file_name, mime_type')
    .eq('id', req.params.id)
    .single();

  if (error || !doc) return res.status(404).send('Document not found.');

  const { data: fileData, error: downloadErr } = await supabase.storage
    .from('insurance-documents')
    .download(doc.file_name);

  if (downloadErr || !fileData) return res.status(500).send('Could not retrieve file.');

  const buffer = Buffer.from(await fileData.arrayBuffer());
  res.setHeader('Content-Disposition', `attachment; filename="${doc.file_name}"`);
  res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
  res.send(buffer);
});

// ─── GET /api/insurance/users ───────────────────────────────────────────────
// Admin-only: lists everyone with a role in this tool. Reads
// team_member_tool_roles joined to team_members instead of the old
// standalone insurance_user_roles table.
router.get('/api/insurance/users', requireInsuranceRole('admin'), async (req, res) => {
  const { data, error } = await supabase
    .from('team_member_tool_roles')
    .select('role, granted_by, granted_at, team_members ( email, full_name )')
    .eq('tool', 'insurance_compliance')
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

// ─── POST /api/insurance/users ──────────────────────────────────────────────
// Admin-only: grants (or updates) a role for someone who has already logged
// into the Rincon Hub at least once. Unlike the old insurance_user_roles
// table, a row can't be created here for someone with no team_members row —
// there is nothing to link the role to yet. That's expected: team_members
// rows come from the hub's own login (Supabase Auth), not from this screen.
router.post('/api/insurance/users', requireInsuranceRole('admin'), async (req, res) => {
  const { email, role } = req.body;
  if (!email || !role) return res.status(400).json({ error: 'email and role are required.' });

  const normalizedEmail = String(email).toLowerCase().trim();
  if (!normalizedEmail.endsWith('@' + ALLOWED_DOMAIN)) {
    return res.status(400).json({ error: 'Only @' + ALLOWED_DOMAIN + ' accounts allowed.' });
  }
  const validRoles = ['admin', 'director_of_operations', 'property_manager', 'inspection_coordinator'];
  if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role.' });

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
      tool: 'insurance_compliance',
      role,
      granted_by: req.user.email,
      granted_at: new Date().toISOString(),
    }, { onConflict: 'team_member_id,tool' });
  if (upsertErr) return res.status(500).json({ error: upsertErr.message });

  await supabase.from('audit_log').insert({
    action: 'team_member.role_changed',
    entity_type: 'team_member',
    entity_id: member.id,
    details: { tool: 'insurance_compliance', old_role: null, new_role: role, changed_by: req.user.email },
  });

  return res.json({ success: true });
});

// ─── PATCH /api/insurance/users/:email ──────────────────────────────────────
router.patch('/api/insurance/users/:email', requireInsuranceRole('admin'), async (req, res) => {
  const { role } = req.body;
  const targetEmail = String(req.params.email || '').toLowerCase().trim();
  const validRoles = ['admin', 'director_of_operations', 'property_manager', 'inspection_coordinator'];
  if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role.' });

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
    .eq('tool', 'insurance_compliance')
    .maybeSingle();
  const oldRole = existing ? existing.role : null;

  const { error: upsertErr } = await supabase
    .from('team_member_tool_roles')
    .upsert({
      team_member_id: member.id,
      tool: 'insurance_compliance',
      role,
      granted_by: req.user.email,
      granted_at: new Date().toISOString(),
    }, { onConflict: 'team_member_id,tool' });
  if (upsertErr) return res.status(500).json({ error: upsertErr.message });

  await supabase.from('audit_log').insert({
    action: 'team_member.role_changed',
    entity_type: 'team_member',
    entity_id: member.id,
    details: { tool: 'insurance_compliance', old_role: oldRole, new_role: role, changed_by: req.user.email },
  });

  return res.json({ success: true });
});

// ─── DELETE /api/insurance/users/:email ─────────────────────────────────────
// Removes this person's INSURANCE role only (deletes their
// team_member_tool_roles row for tool='insurance_compliance'). Their
// team_members row — and any access to other hub tools — is untouched.
router.delete('/api/insurance/users/:email', requireInsuranceRole('admin'), async (req, res) => {
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
    .eq('tool', 'insurance_compliance')
    .maybeSingle();

  const { error } = await supabase
    .from('team_member_tool_roles')
    .delete()
    .eq('team_member_id', member.id)
    .eq('tool', 'insurance_compliance');
  if (error) return res.status(500).json({ error: error.message });

  await supabase.from('audit_log').insert({
    action: 'team_member.role_changed',
    entity_type: 'team_member',
    entity_id: member.id,
    details: { tool: 'insurance_compliance', old_role: existing ? existing.role : null, new_role: null, changed_by: req.user.email },
  });

  return res.json({ success: true });
});

// ─── Upload error handler — must be registered after the upload routes ───
// multer signals a rejected upload (wrong file type from fileFilter above,
// or a file over the 20MB limit) by handing Express an error instead of
// calling the route handler. Without an error-handling middleware to catch
// that, it falls through to Express's generic error page — a bare 500 with
// no useful message for the dashboard to show, and not something to rely on
// staying identical across a multer version upgrade. This turns any upload
// rejection — multer's own MulterError (e.g. file too large) or the plain
// Error thrown by fileFilter above (unsupported file type) — into the same
// clean, expected JSON shape the rest of this file already uses everywhere
// else: { error: '...' }, with a 400 (bad request), not a 500 (server broke).
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
// Unchanged from the standalone app. Called nightly by cron after the
// AppFolio sync, not by a browser, so it was never behind requireAuth even
// before this migration. Must stay mounted BEFORE requireLogin in
// server.js.
const internalRouter = express.Router();

// ─── POST /api/insurance/internal/check-new-properties ─────────────────────
// Finds properties added in the last 48 hours with no insurance record,
// creates no_policy rows, and emails all inspection coordinators.
internalRouter.post('/api/insurance/internal/check-new-properties', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (!secret || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ts = new Date().toISOString();
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  // Properties added in the last 48 hours
  const { data: newProps, error: propErr } = await supabase
    .from('properties')
    .select('id, name, address, appfolio_id')
    .gte('created_at', cutoff);

  if (propErr) {
    console.error(`[${ts}] check-new-properties error:`, propErr.message);
    return res.status(500).json({ error: propErr.message });
  }

  if (!newProps || !newProps.length) {
    console.log(`[${ts}] check-new-properties: no new properties`);
    return res.json({ flagged: 0 });
  }

  // Filter to those with no current insurance record
  const uninsured = [];
  for (const prop of newProps) {
    const { data: existing } = await supabase
      .from('property_insurance')
      .select('id')
      .eq('property_id', prop.id)
      .eq('is_current', true)
      .limit(1);
    if (!existing || !existing.length) uninsured.push(prop);
  }

  if (!uninsured.length) {
    console.log(`[${ts}] check-new-properties: all new properties already have insurance records`);
    return res.json({ flagged: 0 });
  }

  // Create no_policy records so they show up in the dashboard
  for (const prop of uninsured) {
    const { error: insErr } = await supabase.from('property_insurance').insert({
      property_id: prop.id,
      appfolio_property_id: prop.appfolio_id || null,
      is_current: true,
      status: 'no_policy',
      ai_suggested_status: 'no_policy',
    });
    if (insErr) console.warn(`[${ts}] no_policy insert warn (${prop.name}):`, insErr.message);
  }

  // Email all inspection coordinators — sourced from the new shared tables
  // (team_member_tool_roles) instead of the old insurance_user_roles.
  try {
    const mailer = createMailer();
    if (mailer) {
      const { data: icRows } = await supabase
        .from('team_member_tool_roles')
        .select('team_members ( email, is_active )')
        .eq('tool', 'insurance_compliance')
        .eq('role', 'inspection_coordinator');

      const icEmails = (icRows || [])
        .filter(r => r.team_members && r.team_members.is_active)
        .map(r => r.team_members.email);

      if (icEmails.length) {
        const list = uninsured.map(p => `- ${p.name || p.address}`).join('\n');
        await mailer.sendMail({
          from: process.env.GMAIL_USER,
          to: icEmails.join(', '),
          subject: `Action Required: ${uninsured.length} New ${uninsured.length === 1 ? 'Property' : 'Properties'} — Insurance Documents Needed`,
          text: [
            `${uninsured.length} new ${uninsured.length === 1 ? 'property has' : 'properties have'} been added to the portfolio and need insurance documents:`,
            '',
            list,
            '',
            'Please log in to the Rincon Hub, open Insurance Compliance, and upload the declaration page for each.',
          ].join('\n'),
        });
        console.log(`[${ts}] check-new-properties: notified ${icEmails.length} inspection coordinator(s)`);
      }
    }
  } catch (emailErr) {
    console.error(`[${ts}] check-new-properties email error:`, emailErr.message);
  }

  console.log(`[${ts}] check-new-properties: flagged ${uninsured.length} properties`);
  return res.json({ flagged: uninsured.length, properties: uninsured.map(p => p.name || p.address) });
});

module.exports = { router, internalRouter };
