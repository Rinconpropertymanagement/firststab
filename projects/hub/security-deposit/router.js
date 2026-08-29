/**
 * security-deposit/router.js
 * Security Deposit Disposition Assembly Tool — a section of the Rincon
 * Hub, built the same way Insurance Compliance was
 * (projects/hub/insurance/router.js): one router file, mounted into
 * projects/hub/server.js, reusing the Hub's existing login. No new
 * sign-in screen, no new tables beyond what Neo already migrated (see
 * supabase/migrations/20260813000000 through 20260813000004, plus
 * 20260819000000 — additive columns on security_deposit_cases for the
 * manually-reported Prepaid Rent balance, replacing the earlier live
 * AppFolio pull; see the comment above GET /api/security-deposit/cases/:id
 * below for the full history).
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
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const { listPhotoFolders, listFilesInFolder, listAllFilesInFolder, downloadFileBytes, MAX_CANDIDATE_SCAN_FILES } = require('./lib/b2-client');
const { parseFolderName } = require('./lib/folder-parser');
const { matchPhoto } = require('./lib/photo-matcher');
const { resizeForMatching } = require('./lib/image-resize');
const { readExifCaptureDate } = require('./lib/exif-date');
const { GLOBAL_SEARCH_WIDGET_HTML } = require('../lib/global-search-widget');

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
//
// Returns true only when the email actually went out — false for every
// other case (no mailer configured, no active recipients, send threw).
// The escalate route below reports this back to the caller instead of
// assuming success, and fires sendFailureAlertEmail() when it's false —
// found live via code audit, 2026-08-28: this used to swallow every
// failure into a console.error nobody watches, so a broken mail send
// looked identical to a successful one from the outside.
async function sendEscalationEmail(kase, escalatedBy, reason) {
  try {
    const mailer = createMailer();
    if (!mailer) {
      console.error('[security-deposit email] Escalation email NOT sent — mailer unavailable (GMAIL_USER/GMAIL_APP_PASSWORD not configured).');
      return false;
    }

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
      return false;
    }

    const props = kase.leases && kase.leases.units && kase.leases.units.properties;
    const addr = (props && (props.address || props.name)) || 'Unknown property';
    const unit = kase.leases && kase.leases.units && kase.leases.units.unit_number;

    const info = await mailer.sendMail({
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
    // Nodemailer can resolve successfully while still rejecting individual
    // addresses (bad address, full mailbox, etc.) — info.rejected lists
    // those, same signal send-reminders below uses. Only truly clean if
    // every recipient landed in .accepted and nothing came back rejected.
    const rejected = info.rejected || [];
    if (rejected.length) {
      console.error(`[security-deposit email] Escalation email: ${rejected.length} of ${recipients.length} recipient(s) rejected: ${rejected.join(', ')}`);
      return false;
    }
    console.log(`[security-deposit email] Escalation email sent to ${recipients.length} director(s) of operations`);
    return true;
  } catch (err) {
    console.error('[security-deposit email] Failed to send escalation email:', err.message);
    return false;
  }
}

// ─── Failure alert — "something failed, tell a human" ─────────────────────
// Same shape/purpose as appfolio-sync/sync.js's sendSyncWarningAlert (found
// live 2026-08-27 there: a silent failure with only a console.error nobody
// watched let real data go missing for seven weeks with no one warned).
// This tool's whole point is not missing the statutory 21-day disposition
// deadline, so a reminder or escalation email that silently fails to send
// is the same class of risk.
//
// Deliberately reuses THIS file's own createMailer() (nodemailer +
// GMAIL_USER/GMAIL_APP_PASSWORD) rather than appfolio-sync's separate
// OAuth2/googleapis setup (GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN) — that
// credential set and the googleapis package aren't part of the Hub's stack
// (see projects/hub/package.json), and pulling them in here would be a new
// integration, not a reliability fix. This does mean that if the failure
// IS "GMAIL_USER/GMAIL_APP_PASSWORD is wrong," this alert can't send
// either — that's a real gap, not hidden: it's why the JSON responses
// below are fixed to honestly report failure too, so a broken mailer is
// still visible (to a person checking the tool, or a health check hitting
// these endpoints) even on the one night this alert can't get out.
//
// Sent straight to Peter's own inbox — not looked up from
// team_member_tool_roles — so an empty or broken roles table can't also
// take out the alert that something's broken.
const FAILURE_ALERT_RECIPIENT = 'peter@rinconmanagement.com';
async function sendFailureAlertEmail(subject, body) {
  try {
    const mailer = createMailer();
    if (!mailer) {
      console.error(`[security-deposit ALERT] Could not send failure alert — mailer unavailable (GMAIL_USER/GMAIL_APP_PASSWORD not configured). Subject would have been: ${subject}`);
      return false;
    }
    await mailer.sendMail({
      from: process.env.GMAIL_USER,
      to: FAILURE_ALERT_RECIPIENT,
      subject: `[ALERT] ${subject}`,
      text: body,
    });
    console.error(`[security-deposit ALERT] Failure alert sent to ${FAILURE_ALERT_RECIPIENT}: ${subject}`);
    return true;
  } catch (err) {
    console.error(`[security-deposit ALERT] Failure alert itself failed to send: ${err.message} — original subject: ${subject}`);
    return false;
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

// ─── Pagination helper — Supabase/PostgREST caps any single .select() at
// 1000 rows by default, silently (no error) — see the B2-photo-folder
// indexing bug this same file already hit once (fetchAllExistingB2FolderPaths
// below, near the index-b2-photos route) for how that showed up in
// practice. This generalizes that fix for every other query in this file
// that reads a table with no narrow per-request filter, so it can't rely
// on staying under 1000 rows just because it does today.
const SUPABASE_PAGE_SIZE = 1000;
async function fetchAllRows(buildPage) {
  // buildPage(from, to) must return a FRESH Supabase query (with .range()
  // already applied) each call — a query builder can't be re-awaited, so
  // this always asks the caller for a brand new one per page.
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

// ─── Multer (inspection form uploads) — same pattern as insurance ─────────
const upload = multer({
  storage: multer.diskStorage({
    destination: '/tmp',
    filename: (req, file, cb) => {
      // Filename must NOT be derived from file.originalname — it's fully
      // client-controlled, and a crafted value like '../../../etc/x.pdf'
      // would traverse outside /tmp past the extension check below (which
      // only inspects the extension, not the rest of the string). Generate
      // the on-disk name randomly; if the original name is ever needed for
      // display, store it separately in the database record instead.
      const random = crypto.randomBytes(16).toString('hex');
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `security-deposit-upload-${Date.now()}-${random}${ext}`);
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

// Small, tool-scoped duplicate of ../lib/property-search.js's own
// buildIlikeValue — same "no second consumer, don't force a shared
// module yet" reasoning as normalizeAddress above. PostgREST's .or()
// filter syntax treats "," "." ":" "(" ")" as reserved (comma separates
// conditions, parens group them); wrapping the value in double quotes is
// its documented escape hatch, so a typed search containing any of those
// characters (e.g. "708 B Calle Pensamiento") is treated as literal text
// instead of being parsed as filter syntax.
function buildIlikeValue(rawQuery) {
  const withWildcards = `%${rawQuery}%`;
  const escaped = withWildcards.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

// Finds the best-matching indexed B2 photo folder for a property address,
// a target date, and an inspection type ('move_in' | 'move_out') — "match
// by normalized address + nearest date," per SPEC.md's own description
// (20260813000003_b2_photo_folders.sql's design notes). Only ever reads
// the already-built b2_photo_folders index — never touches B2 directly.
//
// SECURITY (Viper finding, 2026-08-19): a folder's review_status matters
// as much as its address/date score. 'needs_review' means the AI was NOT
// confident about its own parse AND no human has looked at it yet — the
// exact same "nothing gets silently trusted" gate this build already
// applies to checklist fields and tenancy_status. Without this filter,
// anyone with write access to the B2 bucket could name a folder to match
// a real property/unit/date and have it silently substituted as a real
// case's move-in/move-out evidence. Pass excludeReviewStatuses to keep a
// caller from ever matching those rows; the case route below never calls
// this without it for the folder that becomes `photos.move_in`/`move_out`.
function findBestPhotoMatch(propertyAddress, targetDateStr, inspectionType, folders, options = {}) {
  const excludeReviewStatuses = options.excludeReviewStatuses || [];
  if (!propertyAddress || !targetDateStr || !folders || !folders.length) return null;
  const normTarget = normalizeAddress(propertyAddress);
  if (!normTarget) return null;
  const targetDate = new Date(targetDateStr + 'T00:00:00');

  let best = null;
  let bestScore = -1;
  for (const folder of folders) {
    if (excludeReviewStatuses.includes(folder.review_status)) continue;
    // 'other' is a CONFIRMED classification (the AI folder-parser explicitly
    // ruled out move_in/move_out — see lib/folder-parser.js's prompt), not
    // "type unknown yet." It must never satisfy a move_in or move_out
    // search. NULL means the parse genuinely produced no type (parse
    // failure or invalid enum value from the model) and is still eligible,
    // same as before this fix.
    if (folder.parsed_inspection_type && folder.parsed_inspection_type !== inspectionType) continue;
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

// ─── Targeted Photo Matching — shared helpers (addendum:
// targeted-photo-matching-SPEC.md) ──────────────────────────────────────

// Same portfolio-wide, paginated read of the indexed B2 folders GET
// /cases/:id already runs inline for its own folder match (see that
// route's own `candidateFolders` fetch). Factored out here so the new
// address-search route and the new photo-matching routes below share one
// implementation. GET /cases/:id itself is deliberately left untouched —
// its own inline copy keeps working exactly as before; duplicating this
// one query is lower-risk than refactoring an already-live route for
// this addendum.
async function fetchAllIndexedB2Folders() {
  return fetchAllRows((from, to) => supabase
    .from('b2_photo_folders')
    .select('id, b2_folder_path, parsed_address, parsed_unit, parsed_inspection_type, parsed_date, confidence_score, review_status')
    .not('parsed_address', 'is', null)
    .order('id', { ascending: true })
    .range(from, to));
}

// Same "only a folder a human has actively confirmed, or the AI
// auto-indexed above threshold, may ever be presented as case evidence"
// rule GET /cases/:id already applies (see that route's own
// CONFIRMED_ONLY constant) — needs_review folders are excluded from ever
// becoming a case's move_in/move_out evidence automatically.
const CONFIRMED_FOLDER_STATUSES_EXCLUDED = { excludeReviewStatuses: ['needs_review'] };

// Resolves a case's own currently-matched move-in and move-out B2 photo
// folders — the exact same matching GET /cases/:id already computes for
// its own response, recomputed independently here (rather than shared)
// for the same "don't touch an already-live route" reasoning as
// fetchAllIndexedB2Folders above. Every new route this addendum adds
// needs this same answer — "which B2 folder, if any, is this case's
// confirmed move-in/move-out evidence right now" — to know what a
// coordinator/pod lead is even allowed to browse, submit, or stream bytes
// from.
async function getCaseMatchedFolders(caseId) {
  const { data: kase, error } = await supabase
    .from('security_deposit_cases')
    .select(`
      id, move_out_date,
      leases ( lease_start, units ( properties ( address ) ) )
    `)
    .eq('id', caseId)
    .maybeSingle();
  if (error) throw error;
  if (!kase) return null;

  const lease = kase.leases || {};
  const property = (lease.units && lease.units.properties) || null;
  const candidateFolders = (property && property.address) ? await fetchAllIndexedB2Folders() : [];

  const moveIn = findBestPhotoMatch(property && property.address, lease.lease_start, 'move_in', candidateFolders, CONFIRMED_FOLDER_STATUSES_EXCLUDED);
  const moveOut = findBestPhotoMatch(property && property.address, kase.move_out_date, 'move_out', candidateFolders, CONFIRMED_FOLDER_STATUSES_EXCLUDED);

  return { caseId: kase.id, moveIn, moveOut };
}

// HARD REQUIREMENT (spec's own flagged security requirement, called out
// explicitly for Viper/Sentinel review — targeted-photo-matching-SPEC.md's
// GET .../photo-file route description): a photo path is only ever
// servable, submittable for matching, or resolvable if it actually falls
// under one of THIS case's own two matched folders, computed server-side
// above — never trusted from the request as-is. Without this, an
// authenticated user could swap in an arbitrary B2 path (e.g. a different
// tenant's case) and read it straight through this tool's own login gate.
// Prefix-bounded with a trailing slash so "123 Main St/..." can never
// match a distinct folder "123 Main St 2/..." that merely shares a text
// prefix, and rejects any path containing ".." as defense-in-depth even
// though B2 paths carry no real filesystem meaning.
//
// SECURITY FIX (TARS, 2026-08-24, live-bucket repro): a plain
// startsWith(folderPath + '/') check only bounds the LEFT edge of the
// match — it says nothing about how many more '/' segments follow, so a
// different case's photos sitting several folders deeper than this
// case's matched folder (a real hand-filing mistake TARS found in the
// live bucket, not a contrived test) still passed as "inside" it and were
// servable cross-tenant through this case's own login gate. The
// authoritative definition of "this file is in this folder" already
// exists elsewhere in this codebase: listFilesInFolder (lib/b2-client.js)
// asks B2 for delimiter='/' listings, which is B2's own native way of
// saying "direct children only" — anything nested deeper than one level
// comes back as a rolled-up "folder" common-prefix entry instead of a
// file, and is never returned as a candidate file at all. Matching that
// same definition here (not just prefix-bounding) means checking that,
// after the folder-path prefix is stripped, nothing but a single path
// segment remains — no further '/'. A file nested one or more folders
// deeper than the matched folder starts with the same string prefix but
// is NOT "inside" it by this definition, exactly the shape TARS's repro
// needs rejected regardless of how deep the nesting goes.
function pathBelongsToFolder(filePath, folderPath) {
  if (!filePath || !folderPath || typeof filePath !== 'string' || typeof folderPath !== 'string') return false;
  if (filePath.includes('..')) return false;
  const boundary = folderPath.replace(/\/+$/, '') + '/';
  if (!filePath.startsWith(boundary)) return false;
  const remainder = filePath.slice(boundary.length);
  return remainder.length > 0 && !remainder.includes('/');
}

function pathBelongsToCaseFolders(filePath, matchedFolders) {
  const moveInPath = matchedFolders.moveIn && matchedFolders.moveIn.b2_folder_path;
  const moveOutPath = matchedFolders.moveOut && matchedFolders.moveOut.b2_folder_path;
  return pathBelongsToFolder(filePath, moveInPath) || pathBelongsToFolder(filePath, moveOutPath);
}

// ─── Targeted Photo Matching — constants ────────────────────────────────
const PHOTO_LIST_DEFAULT_LIMIT = 60;    // gallery page size (Tron's lazy-loaded grid)
const PHOTO_LIST_MAX_LIMIT = 200;       // hard cap regardless of what a client requests
// FIX (TARS accuracy study, 2026-08-24, 23 real submissions across 8
// properties): the AI only ever got to compare against 3-8 candidates out
// of typical ~100-photo move-in folders, for two compounding reasons —
// (1) candidates were the first CANDIDATE_BATCH_SIZE files ALPHABETICALLY,
// and real folders sort in ways that cluster similar shots together (all
// exterior shots first, a run of near-duplicate close-ups), so a fixed
// alphabetical window was frequently unrepresentative of the folder as a
// whole; (2) even that unrepresentative batch got truncated further by
// the byte budget below, because full-resolution 2-5MB phone originals
// ran the budget out after only a handful of downloads. Net effect: the
// AI was answering "does this narrow, often-unlucky slice contain a
// match" instead of "does this folder contain a match" — TARS traced 78%
// of the no_match_found results in the sample to this, not to the model
// failing to recognize a real match it was actually shown.
//
// The 2026-08-24 fix addressed this with lib/image-resize.js (shrinks
// every photo to ~1280px/JPEG, ~150-350KB instead of 2-5MB) plus an
// evenly-spaced 40-photo SAMPLE across the whole folder, instead of
// always the same alphabetically-first slice. That was a real
// improvement but still a sample — Peter reviewed it 2026-08-25 and
// rejected sampling outright: "build it to check all photos. its
// important." This block implements that instead: every real photo in
// the move-in folder (from listAllFilesInFolder — already filtered to
// real images, already draining the whole folder) is a candidate, no
// exceptions below the folder's own MAX_CANDIDATE_SCAN_FILES safety cap
// in lib/b2-client.js. The resize fix from 2026-08-24 is what makes this
// affordable — see CANDIDATE_DOWNLOAD_CONCURRENCY and the batch-packing
// logic below for how a folder's full candidate list is now split across
// as many Claude calls as it actually needs, run a few at a time.
const MAX_SINGLE_IMAGE_BYTES = 3 * 1024 * 1024;
// Byte budget for ONE match call (one move-out photo + one batch of
// candidates), measured AFTER resizing. Batches are packed to this
// budget (see the packing loop in the photo-matches route below) — this
// is a backstop, not the usual binding constraint: at ~150-350KB per
// resized photo, MAX_CANDIDATES_PER_BATCH below (Anthropic's own
// per-request image-count ceiling) fills up long before this many bytes
// does for any realistic Rincon folder. Kept as its own check anyway in
// case an unusual folder's photos resize larger than typical. Well under
// Claude's real 32MB total-request ceiling either way.
const MAX_TOTAL_MATCH_REQUEST_BYTES = 18 * 1024 * 1024;
// Anthropic's Messages API caps a single request at 100 images for a
// 200k-context model — claude-sonnet-5 (lib/photo-matcher.js's MODEL) is
// one (confirmed against Anthropic's current API docs, 2026-08-25: "100
// per request on the API, for models with a 200k-token context window").
// One batch's request = 1 move-out photo + its candidates, so that alone
// would allow up to 99 candidates per batch. This constant is NOT set
// near that ceiling, though — see the reliability finding below for why.
//
// RELIABILITY FIX (TARS, 2026-08-25, two independent live test runs — 13
// submissions, 6 properties, ~81 real batch requests): at the old value of
// 95, roughly 25-30% of individual batch requests failed outright with
// "no text block in Claude response." The ACTUAL root cause of that
// specific failure — found live, via the diagnostic logging in
// lib/photo-matcher.js — turned out to be a max_tokens/adaptive-thinking
// interaction (claude-sonnet-5 runs internal "thinking" by default unless
// a request explicitly disables it, and thinking tokens were eating the
// whole max_tokens budget before the model ever reached its JSON answer)
// and has been fixed AT THE SOURCE in lib/photo-matcher.js
// (`thinking: { type: 'disabled' }`) — see that file's own, much longer
// comment for the full story and the live before/after numbers (0
// failures in 14 real batches after the fix, vs. 4 of the same 30 batches
// failing on their first attempt before it, across two different real B2
// folders). That fix alone may well have been enough on its own.
//
// This constant is still being lowered anyway, independent of that fix,
// because any batch failing used to fail the WHOLE submission (see the
// per-batch retry below, which now also protects against that) and
// failure compounded with batch count — 4+ batch folders, which is most
// real Rincon move-in folders (105-950+ photos = 5-11 batches at the old
// size), failed most or all attempts before either fix. A batch at 95
// candidates is also just genuinely huge on its own terms: at ~1610
// visual tokens per resized 1280px photo (Anthropic's own documented
// visual-token formula, ⌈width/28⌉ × ⌈height/28⌉ — platform.claude.com/
// docs/en/build-with-claude/vision, confirmed 2026-08-25) that's roughly
// 150,000+ input tokens and a ~20-25MB upload in a single non-streaming
// request — more total latency, more bytes to move over the network, and
// (plausibly, though not confirmed as the mechanism here) more room for
// adaptive thinking to run longer on a harder/bigger comparison before
// the disable-thinking fix existed. A smaller, faster, cheaper request
// per batch is still the more robust design even with the specific bug
// that motivated this investigation now fixed at its source.
//
// Lowered to 25 candidates (26 images including the move-out photo) —
// roughly 42,000 input tokens and a ~6.5MB upload per request — while not
// multiplying total batch count as extremely as going all the way down to
// the ~20-image ceiling Anthropic separately documents for its stricter
// per-image-size rule (moot for us either way — every photo is already
// resized to <=1280px, under the 2000px that rule cares about). This does
// mean more total batches for a big folder (a 950-photo folder goes from
// ~10 batches to ~38) — more Claude calls, more total wall-clock time —
// but combined with the per-batch retry below, a folder that reliably
// finishes beats one that fails outright most of the time, and
// full-folder coverage (no sampling) is the explicit, non-negotiable
// requirement this feature exists to meet. If real data after this change
// shows the total-batch-count cost is a bigger problem than the
// reliability this bought, that's a signal to raise this number again —
// now that the actual "no text block" bug is fixed, there's much less
// reliability reason to keep it this low, so a future revisit purely for
// cost/latency (e.g. back toward 50-95) would be reasonable to consider,
// not something this fix ruled out.
const MAX_CANDIDATES_PER_BATCH = 25;
// Bounds simultaneous B2 downloads and simultaneous Anthropic API calls —
// not a queueing system, just "never fire more than this many of the
// same kind of request at once," so a large folder can't hammer either
// service with dozens of parallel requests at submission time. "A handful
// at a time," per spec. Left unchanged by the 2026-08-25 reliability fix
// above — the batch-size cut already reduces concurrent token throughput
// by roughly the same 95-to-25 ratio at this same concurrency (4 batches
// in flight at ~42k tokens each vs. the old ~150k each), which is the
// more direct lever on load than lowering this further. See the
// ANTHROPIC_API_KEY-concurrency note above the photo-matches route below
// for the one other concurrency question this fix looked at (the 401
// TARS saw) and why it's flagged, not changed here.
const CANDIDATE_DOWNLOAD_CONCURRENCY = 5;
const MATCH_BATCH_CONCURRENCY = 4;
const SEARCH_MIN_QUERY_LENGTH = 3;
const SEARCH_MAX_RESULTS = 15;

// Runs `fn` over `items`, at most `limit` calls in flight at once — the
// one concurrency primitive this route needs for both the candidate
// download/resize step and the per-batch matchPhoto() calls below.
// Deliberately not a real queue/pool library: chunks `items` into groups
// of `limit` and awaits each group (via Promise.all) before starting the
// next, so results always come back in the same order as `items`
// regardless of how any one call's timing shakes out. `fn` is expected to
// catch its own errors and return a sentinel (both call sites below do
// this) rather than reject, so one failure in a chunk never silently
// drops its neighbors' results.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const chunkResults = await Promise.all(chunk.map((item, j) => fn(item, i + j)));
    for (let j = 0; j < chunkResults.length; j++) results[i + j] = chunkResults[j];
  }
  return results;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Per-batch retry (TARS reliability fix, 2026-08-25) ────────────────
// Retries ONE failed batch in place, at the route level — the fix for the
// half of the reliability problem that isn't about request size (see
// MAX_CANDIDATES_PER_BATCH above for that half). Before this fix, ANY
// batch failing (even after lib/photo-matcher.js's own internal retry for
// the "no text block" case) failed the WHOLE submission — meaning a
// resubmission redid every batch from scratch, including ones that had
// already succeeded and cost a real AI call. That whole-submission-fails
// behavior is still correct and unchanged as a LAST resort (see the
// failedBatches check below, still present, still refusing to insert a
// row built from an incomplete batch set) — this just makes reaching that
// last resort far less likely, by giving the one batch that actually
// failed a real, generous, independent shot at succeeding on its own
// before giving up on it.
//
// Deliberately a SEPARATE retry layer from photo-matcher.js's internal
// one, not a bigger number plugged into that same loop: photo-matcher.js
// retries the narrow "no text block" case specifically; this retries
// matchPhoto() as a whole, so it also covers a network error or an
// HTTP-level failure that exhausted the Anthropic SDK's own default
// retries before ever reaching photo-matcher's retry loop. Exponential
// backoff with jitter, same reasoning as photo-matcher.js's own (more
// recovery time between attempts, and concurrently-retrying batches
// shouldn't all retry at the same instant).
const BATCH_RETRY_ATTEMPTS = 4;
const BATCH_RETRY_BASE_DELAY_MS = 1500;
const BATCH_RETRY_MAX_DELAY_MS = 15000;

function batchRetryDelay(attempt) {
  const exp = Math.min(BATCH_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), BATCH_RETRY_MAX_DELAY_MS);
  return exp + Math.floor(Math.random() * 500);
}

function daysRemaining(disposition_deadline) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const deadline = new Date(disposition_deadline + 'T00:00:00');
  return Math.round((deadline - today) / 86400000);
}

// ─── Optimistic-lock guard (Ralph finding) ─────────────────────────────
// checklist / prepaid-rent / escalate / escalate-confirm all did a plain
// `.update().eq('id', ...)` with no version check — two pod leads editing
// the same case within moments of each other got silent last-write-wins,
// with no signal to either of them that it happened. `security_deposit_
// cases.updated_at` is already auto-bumped on every write by the
// set_updated_at trigger (20260813000002_security_deposit_cases.sql), so
// no schema change is needed — this is a lightweight guard, not a real
// locking system: the client echoes back the `updated_at` it last loaded
// (GET .../cases/:id now returns it — see that route below), and a write
// is rejected with 409 if the case's real updated_at has since moved.
//
// Deliberately permissive when the client sends no updated_at at all
// (undefined/null/''): this only starts protecting a given screen once
// its caller is actually passing the value back. As of this build, the
// dashboard (dashboard/index.html) does NOT yet send it on any of these
// four routes — see the handoff note above internalRouter below. Until
// Tron wires it through, these routes behave exactly as before.
function isStaleUpdate(currentUpdatedAt, clientUpdatedAt) {
  if (clientUpdatedAt == null || clientUpdatedAt === '') return false;
  // Compared as parsed Date values (millisecond precision), not raw
  // strings — tolerates any harmless formatting difference between two
  // separate reads of the same TIMESTAMPTZ column. Verified against real
  // Supabase output (2026-08-19): this does mean two genuinely different
  // writes landing in the same millisecond would be treated as equal —
  // acceptable for a lightweight guard against human-paced edits (seconds
  // to minutes apart), not a serializable lock.
  const currentMs = new Date(currentUpdatedAt).getTime();
  const clientMs = new Date(clientUpdatedAt).getTime();
  return !isFinite(clientMs) || currentMs !== clientMs;
}

const STALE_CASE_ERROR = 'This case was changed by someone else since you loaded it. Reload the case and try again.';

// Fetch-then-compare version, for routes that don't already select the
// case row for another reason. Routes that already fetch the row first
// (escalate-confirm) call isStaleUpdate() directly against that row
// instead of paying for a second SELECT.
async function checkOptimisticLock(caseId, clientUpdatedAt) {
  if (clientUpdatedAt == null || clientUpdatedAt === '') return { ok: true };
  const { data: current, error } = await supabase
    .from('security_deposit_cases')
    .select('updated_at')
    .eq('id', caseId)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!current) return { ok: false, status: 404, error: 'Case not found.' };
  if (isStaleUpdate(current.updated_at, clientUpdatedAt)) {
    return { ok: false, status: 409, error: STALE_CASE_ERROR };
  }
  return { ok: true };
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
// Same "read + inject the shared search widget, then send" approach as
// insurance/router.js's GET /insurance — see that route's comment for why.
router.get('/security-deposit', (req, res) => {
  fs.readFile(path.join(__dirname, 'dashboard', 'index.html'), 'utf8', (err, html) => {
    if (err) return res.status(500).send('Could not load page.');
    res.send(html.replace('<body>', '<body>\n' + GLOBAL_SEARCH_WIDGET_HTML));
  });
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
  // ?status=all (used for the "reviewed" history tab) has no filter at
  // all, and even the default open-cases view only narrows by status, not
  // by time — this table only grows as more move-outs happen, so it can't
  // rely on a single .select() staying under Supabase's 1000-row cap
  // forever. Paginated with fetchAllRows the same way the B2 photo index
  // had to be. Paged by `id` (the primary key, always unique) so pages
  // can't skip or double up a row on a disposition_deadline tie; the
  // actually-requested sort is applied in JS below, after every page is in.
  let data;
  try {
    data = await fetchAllRows((from, to) => {
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
        .order('id', { ascending: true })
        .range(from, to);

      if (req.query.status === 'all') {
        // no filter
      } else if (req.query.status) {
        query = query.eq('status', req.query.status);
      } else {
        query = query.in('status', ['pending_review', 'escalated']);
      }
      return query;
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  // disposition_deadline ascending, nulls last — matches the original
  // single-query .order('disposition_deadline', { ascending: true }).
  data.sort((a, b) => {
    if (a.disposition_deadline == null && b.disposition_deadline == null) return 0;
    if (a.disposition_deadline == null) return 1;
    if (b.disposition_deadline == null) return -1;
    return a.disposition_deadline < b.disposition_deadline ? -1 : a.disposition_deadline > b.disposition_deadline ? 1 : 0;
  });

  // Every leaseholder name for the cases in this page, in one query
  // instead of N+1 — the multi-tenant fix means a queue row can have more
  // than one name. Also paginated: leaseIds grows with the cases list
  // above (?status=all especially), and .in() doesn't exempt a query from
  // the same 1000-row response cap.
  const leaseIds = (data || []).map(c => c.lease_id).filter(Boolean);
  const tenantsByLease = {};
  if (leaseIds.length) {
    let ltRows;
    try {
      ltRows = await fetchAllRows((from, to) => supabase
        .from('lease_tenants')
        .select('lease_id, is_primary, tenants ( first_name, last_name )')
        .in('lease_id', leaseIds)
        .order('id', { ascending: true })
        .range(from, to));
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
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
      prepaid_rent_balance, prepaid_rent_reported_by, prepaid_rent_reported_at,
      reviewed_by, reviewed_at, escalated_by, escalated_at, reviewer_notes,
      created_at, updated_at,
      leases (
        id, appfolio_id, lease_start, lease_end, monthly_rent, status,
        move_out_date, move_out_reason, deposit_held_total, deposit_synced_at,
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

  // Inspection form uploads AND damage photos — both reuse `documents`,
  // entity_type = 'security_deposit_case' (SPEC.md Neo section #4;
  // damage_photo is the "Add a Damage Photo to a Case" addendum's
  // file_type, added here rather than with a second query). description
  // and captured_at are only ever populated on damage_photo rows today
  // (captured_at added by 20260827010000_add_captured_at_to_documents.sql)
  // but are harmless, always-null columns on the inspection-form rows.
  const { data: docs, error: docErr } = await supabase
    .from('documents')
    .select('id, file_name, file_type, mime_type, description, captured_at, created_at')
    .eq('entity_type', 'security_deposit_case')
    .eq('entity_id', kase.id)
    .order('created_at', { ascending: false });
  if (docErr) return res.status(500).json({ error: docErr.message });
  const inspectionFormMoveIn = (docs || []).find(d => d.file_type === 'inspection_form_move_in') || null;
  const inspectionFormMoveOut = (docs || []).find(d => d.file_type === 'inspection_form_move_out') || null;
  // Mason requirement — flag any photo uploaded after this case's own
  // 21-day disposition deadline instead of showing it identically to
  // timely evidence. Compares the DOCUMENT ROW'S created_at (upload
  // time) against disposition_deadline, deliberately NOT captured_at
  // (the EXIF date, when present) — CC 1950.5's 21-day clock governs
  // when Rincon must act on the evidence it has, not when the photo was
  // physically taken, and captured_at is best-effort/frequently absent
  // so it can't be the thing this flag depends on.
  const damagePhotos = (docs || [])
    .filter(d => d.file_type === 'damage_photo')
    .map(d => ({
      id: d.id,
      description: d.description,
      captured_at: d.captured_at,
      created_at: d.created_at,
      uploaded_after_deadline: !!(kase.disposition_deadline &&
        new Date(d.created_at) > new Date(kase.disposition_deadline + 'T23:59:59')),
    }));

  // Matched B2 photos — reads the already-built index only (never touches
  // B2 live on a case-open — that would be slow and re-spend AI-parsing
  // cost on unchanged folders; see 20260813000003's design notes). This is
  // the SAME b2_photo_folders table that already silently truncated past
  // row 1,000 in the index-b2-photos job (see fetchAllExistingB2FolderPaths
  // below) — this read has no filter narrower than "has a parsed address,"
  // so every case-detail page load was exposed to the identical bug.
  // Paginated the same way.
  let candidateFolders = [];
  if (property && property.address) {
    try {
      candidateFolders = await fetchAllRows((from, to) => supabase
        .from('b2_photo_folders')
        .select('id, b2_folder_path, parsed_address, parsed_unit, parsed_inspection_type, parsed_date, confidence_score, review_status')
        .not('parsed_address', 'is', null)
        .order('id', { ascending: true })
        .range(from, to));
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  // Only a folder a human has actively confirmed (or that the AI indexed
  // above the governed confidence threshold — 'auto_indexed') may ever be
  // presented as this case's evidence. 'needs_review' is explicitly
  // excluded — see findBestPhotoMatch's comment above.
  const CONFIRMED_ONLY = { excludeReviewStatuses: ['needs_review'] };
  const moveInPhotos = findBestPhotoMatch(property && property.address, lease.lease_start, 'move_in', candidateFolders, CONFIRMED_ONLY);
  const moveOutPhotos = findBestPhotoMatch(property && property.address, kase.move_out_date, 'move_out', candidateFolders, CONFIRMED_ONLY);

  // If nothing confirmed matched, check separately whether an unconfirmed
  // (needs_review) folder WOULD have matched — never assigned to
  // moveInPhotos/moveOutPhotos above, so it can never be returned in the
  // `photos` object and can never render identically to a confirmed match
  // on the case screen (Viper's finding). Surfaced only as a pointer, in
  // the flags[] warning below, toward the existing manual-review queue
  // (GET /api/security-deposit/photo-review-queue, resolved via POST
  // .../photo-review-queue/:id/resolve) — a pod lead must actively
  // confirm or correct it there before it can ever become this case's
  // evidence. No new confirmation mechanism needed; that gate already
  // existed, findBestPhotoMatch just wasn't respecting it.
  const moveInUnconfirmed = moveInPhotos ? null : findBestPhotoMatch(property && property.address, lease.lease_start, 'move_in', candidateFolders);
  const moveOutUnconfirmed = moveOutPhotos ? null : findBestPhotoMatch(property && property.address, kase.move_out_date, 'move_out', candidateFolders);

  // Prepaid Rent — NOT a live AppFolio pull (superseded 2026-08-19).
  // Automatic retrieval via appfolioConnector.getPrepaidRentBalance()
  // (a general_ledger lookup) was confirmed a dead end for driving a
  // hard review gate: it can return found:false or an outright error,
  // and there's no way to force a human decision out of a live lookup
  // that might just fail. Peter's decision, on Mason's recommendation:
  // the pod lead looks up "2300 - Prepaid Rent" for this tenant in
  // AppFolio themselves and enters the balance (or $0) via
  // POST .../prepaid-rent below — same "human does what software can't
  // guarantee" pattern as the checklist and the inspection-form upload.
  // getPrepaidRentBalance() itself is untouched (see lib/appfolio-
  // connector.js) — this route just stops calling it. See
  // 20260819000000_add_prepaid_rent_reported_to_security_deposit_cases.sql
  // for the schema and SPEC.md Neo section #3 for the full history.

  // Missing-evidence flags — computed HERE, at read time, from whatever
  // the assembly step actually found. Deliberately not a stored column —
  // SPEC.md Gap #8: "missing" is a derived state, not new information to
  // keep in sync, and storing it would create a second copy of the truth
  // that could drift from the real B2/AppFolio state between reads.
  const flags = [];
  if (!moveInPhotos) {
    if (moveInUnconfirmed && moveInUnconfirmed.review_status === 'needs_review') {
      flags.push({
        code: 'move_in_photos_unconfirmed_match',
        message: 'UNCONFIRMED MATCH, NOT SHOWN AS EVIDENCE: a possible move-in photo folder was found ("' + moveInUnconfirmed.b2_folder_path + '", AI confidence ' + Math.round((moveInUnconfirmed.confidence_score || 0) * 100) + '%) but no human has reviewed it yet — it is sitting in the B2 photo manual-review queue. It will NOT appear as this case’s move-in photos until a pod lead confirms or corrects it in that queue.',
      });
    } else {
      flags.push({ code: 'no_move_in_photos', message: 'No move-in photos found.' });
    }
  }
  if (!moveOutPhotos) {
    if (moveOutUnconfirmed && moveOutUnconfirmed.review_status === 'needs_review') {
      flags.push({
        code: 'move_out_photos_unconfirmed_match',
        message: 'UNCONFIRMED MATCH, NOT SHOWN AS EVIDENCE: a possible move-out photo folder was found ("' + moveOutUnconfirmed.b2_folder_path + '", AI confidence ' + Math.round((moveOutUnconfirmed.confidence_score || 0) * 100) + '%) but no human has reviewed it yet — it is sitting in the B2 photo manual-review queue. It will NOT appear as this case’s move-out photos until a pod lead confirms or corrects it in that queue.',
      });
    } else {
      flags.push({ code: 'no_move_out_photos', message: 'No move-out photos found.' });
    }
  }
  if (lease.deposit_held_total == null) {
    flags.push({ code: 'no_deposit_on_file', message: 'No deposit amount on file for this lease.' });
  } else if (Number(lease.deposit_held_total) === 0) {
    flags.push({ code: 'zero_deposit', message: 'Deposit on file is $0 — confirm this is correct and not a data gap.' });
  }
  if (kase.prepaid_rent_balance == null) {
    flags.push({ code: 'prepaid_rent_not_reported', message: 'Prepaid Rent balance has not been entered yet. Look up "2300 - Prepaid Rent" for this tenant in AppFolio and enter the balance (or $0 if none exists) — required before this case can be marked reviewed.' });
  }
  if (!inspectionFormMoveIn) flags.push({ code: 'no_inspection_form_move_in', message: 'Move-in inspection form not uploaded yet.' });
  if (!inspectionFormMoveOut) flags.push({ code: 'no_inspection_form_move_out', message: 'Move-out inspection form not uploaded yet.' });
  if (!tenants.length) {
    flags.push({ code: 'no_tenants_on_lease', message: 'No tenant(s) resolved for this lease — lease_tenants has no matching rows. A disposition packet with no known tenant is likely incomplete; check the lease record before proceeding.' });
  }
  if (!kase.tenancy_status) flags.push({ code: 'tenancy_status_unconfirmed', message: 'Whether this is the whole tenancy ending, or one co-tenant moving out while the lease continues, has not been confirmed yet.' });
  if (kase.checklist_notice_sent == null) {
    flags.push({ code: 'checklist_notice_sent_unconfirmed', message: 'Whether the move-out notice was sent to the tenant has not been answered yet.' });
  }
  if (kase.checklist_inspection_conducted == null) {
    flags.push({ code: 'checklist_inspection_conducted_unconfirmed', message: 'Whether the move-out inspection was conducted has not been answered yet.' });
  }
  if (kase.checklist_photos_documented == null) {
    flags.push({ code: 'checklist_photos_documented_unconfirmed', message: 'Whether move-out photos were documented has not been answered yet.' });
  }
  // Defense-in-depth for the create-cases-from-sync deadline-correction
  // fix below: that job re-syncs this case's move_out_date from
  // leases.move_out_date whenever AppFolio's date changes, for every
  // status. This flag only fires in the narrow window before that job
  // next runs (or if a correction failed for some reason) — see that
  // route's comment for the full reasoning, including why a 'reviewed'
  // case still gets corrected rather than silently left stale.
  if (lease.move_out_date && kase.move_out_date && String(lease.move_out_date) !== String(kase.move_out_date)) {
    flags.push({
      code: 'move_out_date_mismatch',
      message: `This case's move-out date (${kase.move_out_date}) no longer matches the lease's current move-out date in AppFolio (${lease.move_out_date}) — the 21-day deadline above is computed from the case's date. This should self-correct the next time the nightly sync runs; contact an admin if it doesn't.`,
    });
  }

  return res.json({
    id: kase.id,
    status: kase.status,
    move_out_date: kase.move_out_date,
    updated_at: kase.updated_at,
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
    // See"). As of 2026-08-19, this is a required, manually-entered
    // figure (POST .../prepaid-rent below), not a live AppFolio pull —
    // see the comment above this block for why. reported=false means the
    // pod lead hasn't entered it yet, which also blocks marking this case
    // reviewed (see POST .../review).
    prepaid_rent: {
      balance: kase.prepaid_rent_balance != null ? Number(kase.prepaid_rent_balance) : null,
      reported: kase.prepaid_rent_balance != null,
      reported_by: kase.prepaid_rent_reported_by || null,
      reported_at: kase.prepaid_rent_reported_at || null,
      source_label: "From AppFolio's \"2300 - Prepaid Rent\" account for this tenant — looked up and entered manually by a pod lead (not an automated pull), since AppFolio books it in a separate account from the Security Deposit total above. California's AB 12 deposit cap counts this toward the aggregate. Required before this case can be marked reviewed.",
    },
    inspection_forms: {
      move_in: inspectionFormMoveIn,
      move_out: inspectionFormMoveOut,
    },
    damage_photos: damagePhotos,
    photos: {
      move_in: moveInPhotos,
      move_out: moveOutPhotos,
    },
    flags,
  });
});

// ─── GET /api/security-deposit/lease-search — find a lease for the manual
// "Create Case" form ─────────────────────────────────────────────────────
// Backs the Queue tab's "Create Case" button (Tron) — the safety valve for
// a move-out that never flowed through tenant_tickler, so no automatic
// case was ever queued for it (confirmed live, 2026-08-28: 9 terminated
// leases have a NULL move_out_date and therefore no case). A pod lead
// rarely knows a lease's UUID, so this lets them type a property
// name/address or a tenant's name and get back candidate LEASES — never
// exposing the raw lease_id as something to type. Same role gate as the
// POST route right below, since finding a lease is only useful to someone
// who can also submit it.
//
// Leases that already have a security_deposit_case are left out — the
// POST route below would just reject them with a 409, so surfacing them
// here would only invite a confusing failed submission.
//
// TWO SEPARATE QUERIES, merged in JS, not one combined query — same
// reasoning as ../lib/property-search.js's own "WHY TWO SEPARATE
// QUERIES" note: PostgREST's embedded-resource filter syntax can't
// cleanly OR a condition on the embedded properties table together with
// a condition on the embedded tenants table. Each leg here instead
// mirrors an already-proven shape in this codebase: the properties ilike
// search is lib/property-search.js's own query verbatim, and the
// lease_tenants join is the exact one GET /cases above already uses
// (~line 847) to build tenantsByLease.
router.get('/api/security-deposit/lease-search', requireSecurityDepositRole('admin', 'pod_lead', 'director_of_operations'), async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (q.length < 3) return res.json({ results: [] });

  const ilikeValue = buildIlikeValue(q);
  const LEG_LIMIT = 8;     // candidate properties/tenants fetched per leg
  const RESULT_LIMIT = 15; // total leases returned after merging both legs
  const LEASE_COLUMNS = `
    id, status, lease_start, lease_end, move_out_date,
    units ( unit_number, properties ( name, address, city ) ),
    security_deposit_cases ( id ),
    lease_tenants ( is_primary, tenants ( first_name, last_name ) )
  `;

  const leasesById = new Map();
  // security_deposit_cases.lease_id carries its own UNIQUE constraint
  // (20260813000002_security_deposit_cases.sql), so PostgREST embeds it
  // from the leases side as a to-one relation — a plain object (or null),
  // never an array — unlike every other embed in this file. Confirmed
  // live, 2026-08-28: an Array.isArray() check here silently let a lease
  // that already has a case back into the results.
  function hasExistingCase(l) {
    const sdc = l.security_deposit_cases;
    if (!sdc) return false;
    return Array.isArray(sdc) ? sdc.length > 0 : true;
  }
  function addLease(l) {
    if (!l || leasesById.has(l.id)) return;
    if (hasExistingCase(l)) return;
    const property = l.units && l.units.properties ? l.units.properties : null;
    leasesById.set(l.id, {
      lease_id: l.id,
      status: l.status,
      lease_start: l.lease_start,
      lease_end: l.lease_end,
      move_out_date: l.move_out_date,
      property_name: property ? property.name : null,
      property_address: property ? property.address : null,
      unit_number: l.units ? l.units.unit_number : null,
      tenants: (l.lease_tenants || [])
        .filter(lt => lt.tenants)
        .map(lt => ({
          name: `${lt.tenants.first_name || ''} ${lt.tenants.last_name || ''}`.trim(),
          is_primary: !!lt.is_primary,
        })),
    });
  }

  // Leg 1 — property name/address match.
  try {
    const { data: props, error: propErr } = await supabase
      .from('properties')
      .select('id')
      .or(`name.ilike.${ilikeValue},address.ilike.${ilikeValue}`)
      .limit(LEG_LIMIT);
    if (propErr) throw propErr;
    const propertyIds = (props || []).map(p => p.id);
    if (propertyIds.length) {
      const { data: units, error: unitErr } = await supabase
        .from('units')
        .select(`leases ( ${LEASE_COLUMNS} )`)
        .in('property_id', propertyIds);
      if (unitErr) throw unitErr;
      (units || []).forEach(u => (u.leases || []).forEach(addLease));
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  // Leg 2 — tenant first/last name match.
  try {
    const { data: tenantRows, error: tenantErr } = await supabase
      .from('tenants')
      .select('id')
      .or(`first_name.ilike.${ilikeValue},last_name.ilike.${ilikeValue}`)
      .limit(LEG_LIMIT);
    if (tenantErr) throw tenantErr;
    const tenantIds = (tenantRows || []).map(t => t.id);
    if (tenantIds.length) {
      const { data: lts, error: ltErr } = await supabase
        .from('lease_tenants')
        .select(`leases ( ${LEASE_COLUMNS} )`)
        .in('tenant_id', tenantIds);
      if (ltErr) throw ltErr;
      (lts || []).forEach(row => addLease(row.leases));
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  // Most recently ended lease first (nulls last) — leases without a case
  // yet skew toward being the ones someone actually needs to find here.
  const results = Array.from(leasesById.values())
    .sort((a, b) => (a.lease_end < b.lease_end ? 1 : a.lease_end > b.lease_end ? -1 : 0))
    .slice(0, RESULT_LIMIT);

  return res.json({ results });
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
router.post('/api/security-deposit/cases', requireSecurityDepositRole('admin', 'pod_lead', 'director_of_operations'), async (req, res) => {
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
router.post('/api/security-deposit/cases/:id/checklist', requireSecurityDepositRole('admin', 'pod_lead', 'director_of_operations'), async (req, res) => {
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

  const lock = await checkOptimisticLock(req.params.id, req.body.updated_at);
  if (!lock.ok) return res.status(lock.status).json({ error: lock.error });

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

// ─── POST /api/security-deposit/cases/:id/prepaid-rent ────────────────────
// Saves the pod lead's manually-looked-up Prepaid Rent balance (AppFolio
// account "2300 - Prepaid Rent" for this tenant) — replaces the live
// AppFolio pull (see the comment in GET /cases/:id for why). `balance`
// is required and must be a non-negative number; 0 is a valid, meaningful
// answer ("looked it up, none exists"), distinct from never having
// answered at all (NULL). This is the field POST .../review gates on
// before allowing a case to be marked reviewed.
router.post('/api/security-deposit/cases/:id/prepaid-rent', requireSecurityDepositRole('admin', 'pod_lead', 'director_of_operations'), async (req, res) => {
  const { balance } = req.body;
  // Reject '' explicitly before the Number() coercion below — JS quirk:
  // Number('') is 0, not NaN, which would otherwise let a blank form
  // field silently save as a confirmed "$0 balance" instead of being
  // rejected as missing.
  const value = typeof balance === 'string' ? (balance.trim() === '' ? NaN : Number(balance)) : balance;
  // Upper bound matches the database's NUMERIC(10,2) column constraint —
  // rejecting here gives a clean 400 instead of letting an absurd value
  // fall through to a raw 500 when the DB constraint trips.
  const MAX_PREPAID_RENT_BALANCE = 10000000;
  if (typeof value !== 'number' || !isFinite(value) || isNaN(value) || value < 0 || value > MAX_PREPAID_RENT_BALANCE) {
    return res.status(400).json({ error: `balance is required and must be a non-negative number no greater than $${MAX_PREPAID_RENT_BALANCE.toLocaleString()} (0 is valid if no Prepaid Rent balance exists).` });
  }

  const lock = await checkOptimisticLock(req.params.id, req.body.updated_at);
  if (!lock.ok) return res.status(lock.status).json({ error: lock.error });

  const reporterName = req.securityDepositMemberName || req.user.email;
  const now = new Date().toISOString();
  const rounded = Math.round(value * 100) / 100;

  const { data: updated, error } = await supabase
    .from('security_deposit_cases')
    .update({
      prepaid_rent_balance: rounded,
      prepaid_rent_reported_by: reporterName,
      prepaid_rent_reported_at: now,
    })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  if (!updated) return res.status(404).json({ error: 'Case not found.' });

  await supabase.from('audit_log').insert({
    action: 'security_deposit.prepaid_rent_reported',
    entity_type: 'security_deposit_case',
    entity_id: req.params.id,
    details: { prepaid_rent_balance: rounded, reported_by: reporterName },
  });

  return res.json({ success: true, case: updated });
});

// ─── POST /api/security-deposit/cases/:id/inspection-form ─────────────────
// Plain file-attach — reuses `documents` (entity_type =
// 'security_deposit_case'), same as insurance's upload route reuses it
// for entity_type='property'. `kind` in the body distinguishes move_in
// from move_out (mirrors insurance's file_type='insurance_certificate'
// convention).
router.post('/api/security-deposit/cases/:id/inspection-form', requireSecurityDepositRole('admin', 'pod_lead', 'director_of_operations'), upload.single('file'), async (req, res) => {
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

// ─── POST /api/security-deposit/cases/:id/damage-photo ────────────────────
// "Add a Damage Photo to a Case" addendum. Same plain file-attach shape as
// the inspection-form route above (reuses `documents`, entity_type =
// 'security_deposit_case', the same multer instance, storage bucket, and
// audit-log pattern) but with three differences the spec calls out:
//   - file_type='damage_photo', JPG/PNG only (no PDF)
//   - storage path gets a random suffix, not a fixed kind — a case can
//     have many damage photos, unlike the one-per-slot inspection form
//   - a required caption (documents.description) instead of an optional
//     one, and it's an evidence photo, not a form
// No edit/delete route exists for these in this version (spec, "Not in
// this version") — once added, a damage photo has no route that can
// change or remove it.
//
// PERMISSIONS — deliberately its own inline role list, not shared with
// the stricter /review gate (admin/pod_lead/director_of_operations,
// used by requireSecurityDepositRole above at line ~1320) or reused from
// the photo-viewing routes' list (which happens to be the same four
// roles today, near line ~1591) — Peter's decision, SPEC.md: every role
// with any access to this tool may add a damage photo. Declared
// independently so a future change to either of those other gates can't
// silently change who can add evidence here, and vice versa.
router.post('/api/security-deposit/cases/:id/damage-photo', requireSecurityDepositRole('admin', 'pod_lead', 'director_of_operations', 'inspection_coordinator'), upload.single('file'), async (req, res) => {
  const caseId = req.params.id;
  const description = (req.body.description || '').trim();

  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  if (!description) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Add a caption describing what this photo shows.' });
  }

  // The shared `upload` multer instance also accepts .pdf (for inspection
  // forms) — narrow to photos only here, same plain-rejection UX as the
  // inspection-form route's own kind check.
  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!['.jpg', '.jpeg', '.png'].includes(ext)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: `Unsupported file type: ${ext}. Damage photos must be JPG or PNG.` });
  }

  const { data: kase, error: caseErr } = await supabase
    .from('security_deposit_cases').select('id').eq('id', caseId).maybeSingle();
  if (caseErr) return res.status(500).json({ error: caseErr.message });
  if (!kase) {
    fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: 'Case not found.' });
  }

  const MIME_MAP = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
  const mimeType = MIME_MAP[ext];

  await ensureStorageBucket();
  const fileBuffer = fs.readFileSync(req.file.path);

  // Mason requirement #2 — capture when the photo was actually taken,
  // not just uploaded. Best-effort only (see lib/exif-date.js): most
  // phone/camera photos carry an EXIF DateTimeOriginal tag, plenty
  // don't, and this must never block the upload either way.
  const capturedAt = readExifCaptureDate(fileBuffer);

  // Random suffix (not a fixed kind-based name like the inspection-form
  // route uses) — a case can have many damage photos.
  const randomSuffix = crypto.randomBytes(6).toString('hex');
  const storageKey = `${caseId}/damage-${Date.now()}-${randomSuffix}${ext}`;
  const { error: uploadErr } = await supabase.storage
    .from('security-deposit-documents')
    .upload(storageKey, fileBuffer, { contentType: mimeType, upsert: true });
  fs.unlink(req.file.path, () => {});
  if (uploadErr) return res.status(500).json({ error: 'Failed to store file.', detail: uploadErr.message });

  // documents.uploaded_by references the legacy `users` table, not
  // team_members — left NULL here, the same known workaround the
  // inspection-form upload above already uses. The uploader's real
  // identity goes into the audit_log entry below instead.
  const { data: docRow, error: docErr } = await supabase
    .from('documents')
    .insert({
      file_name: storageKey,
      file_path: storageKey,
      file_type: 'damage_photo',
      entity_type: 'security_deposit_case',
      entity_id: caseId,
      mime_type: mimeType,
      description,
      captured_at: capturedAt,
      uploaded_by: null,
    })
    .select('id, created_at')
    .single();
  if (docErr) return res.status(500).json({ error: 'Failed to save document record.', detail: docErr.message });

  await supabase.from('audit_log').insert({
    action: 'security_deposit.damage_photo_uploaded',
    entity_type: 'security_deposit_case',
    entity_id: caseId,
    details: {
      document_id: docRow.id,
      uploaded_by: req.user.email,
      captured_at: capturedAt,
    },
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
// Hard gate (added 2026-08-19, Peter's decision on Mason's recommendation;
// extended same day to cover the remaining unanswered-field gap flagged in
// that build's report): a case cannot be marked reviewed while any of
// these are still NULL/unanswered —
//   prepaid_rent_balance             (0 counts as answered; NULL does not)
//   checklist_notice_sent            (false counts as answered; NULL does not)
//   checklist_inspection_conducted   (false counts as answered; NULL does not)
//   checklist_photos_documented      (false counts as answered; NULL does not)
//   tenancy_status                   (must be one of the two enum values)
// Enforced here in application code, not as a database CHECK constraint —
// see 20260819000000_add_prepaid_rent_reported_to_security_deposit_cases.sql
// for why (same reasoning applies to the checklist/tenancy_status columns,
// which predate that migration). Checked with its own SELECT (rather than
// trusting the client's last-loaded copy of the case) so a stale page
// can't bypass this by submitting a review for a case whose fields were
// never actually saved. All missing fields are collected and named in one
// response — not just the first one found — so a pod lead fixing this
// doesn't have to resubmit repeatedly to discover each blocker in turn.
router.post('/api/security-deposit/cases/:id/review', requireSecurityDepositRole('admin', 'pod_lead', 'director_of_operations'), async (req, res) => {
  const { reviewer_notes } = req.body;
  const reviewerName = req.securityDepositMemberName || req.user.email;
  const now = new Date().toISOString();

  const { data: existing, error: existingErr } = await supabase
    .from('security_deposit_cases')
    .select('prepaid_rent_balance, checklist_notice_sent, checklist_inspection_conducted, checklist_photos_documented, tenancy_status, updated_at')
    .eq('id', req.params.id)
    .maybeSingle();
  if (existingErr) return res.status(500).json({ error: existingErr.message });
  if (!existing) return res.status(404).json({ error: 'Case not found.' });
  // Already have the row from the fetch above — compare directly instead
  // of paying for checkOptimisticLock()'s own SELECT (same approach as
  // escalate-confirm).
  if (isStaleUpdate(existing.updated_at, req.body.updated_at)) {
    return res.status(409).json({ error: STALE_CASE_ERROR });
  }

  const missing = [];
  if (existing.prepaid_rent_balance == null) {
    missing.push({
      field: 'prepaid_rent_balance',
      message: 'Prepaid Rent balance has not been entered. Look up "2300 - Prepaid Rent" for this tenant in AppFolio and enter the balance (or $0 if none exists).',
    });
  }
  if (existing.checklist_notice_sent == null) {
    missing.push({
      field: 'checklist_notice_sent',
      message: 'Whether the move-out notice was sent to the tenant has not been answered yet.',
    });
  }
  if (existing.checklist_inspection_conducted == null) {
    missing.push({
      field: 'checklist_inspection_conducted',
      message: 'Whether the move-out inspection was conducted has not been answered yet.',
    });
  }
  if (existing.checklist_photos_documented == null) {
    missing.push({
      field: 'checklist_photos_documented',
      message: 'Whether move-out photos were documented has not been answered yet.',
    });
  }
  if (!existing.tenancy_status) {
    missing.push({
      field: 'tenancy_status',
      message: 'Whether this is the whole tenancy ending, or one co-tenant moving out while the lease continues, has not been confirmed yet.',
    });
  }

  if (missing.length) {
    return res.status(400).json({
      error: `This case cannot be marked reviewed until the following are answered: ${missing.map(m => m.message).join(' ')}`,
      missing_fields: missing.map(m => m.field),
    });
  }

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
router.post('/api/security-deposit/cases/:id/escalate', requireSecurityDepositRole('admin', 'pod_lead', 'director_of_operations'), async (req, res) => {
  const { reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'reason is required.' });

  const lock = await checkOptimisticLock(req.params.id, req.body.updated_at);
  if (!lock.ok) return res.status(lock.status).json({ error: lock.error });

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

  // The case update above is the real, already-committed action — its
  // success doesn't depend on this email. But a health check or a person
  // reading this response has no other way to know the director-of-
  // operations notification actually went out, so that gets reported
  // honestly as its own field instead of folded into the overall
  // "success: true" (which used to imply the email sent too, even when it
  // silently didn't — found via code audit, 2026-08-28).
  const escalationEmailSent = await sendEscalationEmail(updated, escalatorName, reason.trim());
  if (!escalationEmailSent) {
    await sendFailureAlertEmail(
      'Security Deposit: escalation notification email failed to send',
      `Case ${req.params.id} was escalated by ${escalatorName}, but the director-of-operations notification email did not send. The escalation itself was saved — this is only the email notification.\n\nReason for escalation: ${reason.trim()}\n\nCheck the server logs and GMAIL_USER/GMAIL_APP_PASSWORD.`
    );
  }

  return res.json({ success: true, case: updated, escalation_email_sent: escalationEmailSent });
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
    .select('status, escalated_by, escalated_at, reviewer_notes, updated_at')
    .eq('id', req.params.id)
    .maybeSingle();
  if (beforeErr) return res.status(500).json({ error: beforeErr.message });
  if (!before) return res.status(404).json({ error: 'Case not found.' });
  // Already have the row from the fetch above — compare directly instead
  // of paying for checkOptimisticLock()'s own SELECT.
  if (isStaleUpdate(before.updated_at, req.body.updated_at)) {
    return res.status(409).json({ error: STALE_CASE_ERROR });
  }

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
// Narrower than candidateFolders above (review_status='needs_review' only,
// not every parsed folder) but still reads from b2_photo_folders with no
// time bound — if the review backlog isn't kept current, it can grow the
// same way the unfiltered read did. Paginated defensively for the same
// reason. Paged by `id`; the real sort (indexed_at desc) is applied in JS.
router.get('/api/security-deposit/photo-review-queue', requireSecurityDepositAccess, async (req, res) => {
  let data;
  try {
    data = await fetchAllRows((from, to) => supabase
      .from('b2_photo_folders')
      .select('id, b2_folder_path, parsed_address, parsed_unit, parsed_inspection_type, parsed_date, confidence_score, model_version, indexed_at')
      .eq('review_status', 'needs_review')
      .order('id', { ascending: true })
      .range(from, to));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
  data.sort((a, b) => (a.indexed_at < b.indexed_at ? 1 : a.indexed_at > b.indexed_at ? -1 : 0));
  return res.json(data);
});

// ─── POST /api/security-deposit/photo-review-queue/:id/resolve ────────────
// Body: { confirmed: true } to accept the AI's parse as-is, or
// { confirmed: false, address, unit, inspection_type, date } to correct it.
router.post('/api/security-deposit/photo-review-queue/:id/resolve', requireSecurityDepositRole('admin', 'pod_lead', 'director_of_operations'), async (req, res) => {
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

// ═══════════════════════════════════════════════════════════════════════
// TARGETED PHOTO MATCHING (addendum: targeted-photo-matching-SPEC.md)
// Three pieces, all additive to the base tool above and to each other:
// general photo browsing, AI-assisted move-out -> move-in photo matching,
// and an in-context address search fallback. Governance-cleared by Asimov
// (7 conditions) and Mason (1 condition) before this spec was written —
// see that spec's "Compliance Grounding" section for the full list. Every
// route below is scoped to a case the requester's role can already see;
// the photo-file route additionally verifies the requested path actually
// belongs to THAT case's own matched folders before streaming anything
// (see pathBelongsToCaseFolders above and that route's own comment) —
// flagged explicitly for Viper/Sentinel review, same as the spec itself
// flags it.
// ═══════════════════════════════════════════════════════════════════════

// ─── GET /api/security-deposit/cases/:id/photos ────────────────────────
// Powers BOTH general browsing (folder=move_in or move_out, freely
// scrollable the moment the case screen opens) AND the move-out matching
// picker (folder=move_out only) — one route, not two UIs each with their
// own listing logic (spec's own revision note). Paginated via B2's own
// cursor, one page at a time — never drains a whole folder (see
// lib/b2-client.js's listFilesInFolder comment).
router.get('/api/security-deposit/cases/:id/photos', requireSecurityDepositRole('admin', 'pod_lead', 'inspection_coordinator', 'director_of_operations'), async (req, res) => {
  const folderKind = req.query.folder;
  if (!['move_in', 'move_out'].includes(folderKind)) {
    return res.status(400).json({ error: 'folder must be "move_in" or "move_out".' });
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || PHOTO_LIST_DEFAULT_LIMIT, 1), PHOTO_LIST_MAX_LIMIT);

  let matched;
  try {
    matched = await getCaseMatchedFolders(req.params.id);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
  if (!matched) return res.status(404).json({ error: 'Case not found.' });

  const folder = folderKind === 'move_in' ? matched.moveIn : matched.moveOut;
  if (!folder) {
    // Not an error — an unmatched folder is exactly the state the address
    // search (below) exists to fix. The UI shows the search box front and
    // center in this state (spec's Tron section).
    return res.json({ files: [], next_cursor: null, folder_matched: false, folder_path: null });
  }

  try {
    const page = await listFilesInFolder(folder.b2_folder_path, { startFileName: req.query.cursor || null, maxFileCount: limit });
    return res.json({
      files: page.files,
      next_cursor: page.nextFileName,
      folder_matched: true,
      folder_path: folder.b2_folder_path,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to list photos from Backblaze B2.', detail: error.message });
  }
});

// ─── GET /api/security-deposit/cases/:id/photo-file ────────────────────
// Streams one photo's actual bytes — same endpoint for a gallery
// thumbnail and the click-to-enlarge full view (B2 has no resized copy to
// serve instead — spec's own performance note). HARD REQUIREMENT
// (spec-flagged for Viper/Sentinel review): `path` is only ever served if
// it actually falls under THIS case's own matched move-in or move-out
// folder, computed server-side above — never trusted as-is. Without this
// check, an authenticated user could swap in an arbitrary B2 path and
// read a different tenant's case photos through this case's own login
// gate.
router.get('/api/security-deposit/cases/:id/photo-file', requireSecurityDepositRole('admin', 'pod_lead', 'inspection_coordinator', 'director_of_operations'), async (req, res) => {
  const filePath = req.query.path;
  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: 'path is required.' });
  }

  let matched;
  try {
    matched = await getCaseMatchedFolders(req.params.id);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
  if (!matched) return res.status(404).json({ error: 'Case not found.' });

  if (!pathBelongsToCaseFolders(filePath, matched)) {
    return res.status(403).json({ error: "This photo does not belong to this case's matched folders." });
  }

  try {
    const file = await downloadFileBytes(filePath);
    res.setHeader('Content-Type', file.contentType || 'application/octet-stream');
    // Real caching headers from B2's own file metadata — a browser that's
    // already loaded a photo shouldn't re-fetch it on scroll-back (spec's
    // own "no waiting" requirement, extended to repeat views). `private`
    // because this sits behind the Hub's own login, not a public asset.
    if (file.etag) res.setHeader('ETag', file.etag);
    if (file.lastModified) res.setHeader('Last-Modified', file.lastModified);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.send(file.buffer);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch photo from Backblaze B2.', detail: error.message });
  }
});

// Inserts a security_deposit_photo_matches row, falling back to fetching
// the already-existing row on a UNIQUE(case_id, move_out_photo_path)
// conflict (Postgres 23505) instead of erroring — the migration's own
// design notes name the exact race this guards against: a coordinator
// double-clicking submit, or a retried request after a slow response
// that actually succeeded. The upfront existingRow check in the route
// below already handles the common case; this is the race-condition
// backstop for two near-simultaneous requests both passing that check
// before either one's insert lands.
async function insertPhotoMatchRow(fields) {
  const { data: row, error } = await supabase
    .from('security_deposit_photo_matches')
    .insert(fields)
    .select()
    .single();
  if (!error) return { row, alreadyExisted: false };
  if (error.code === '23505') {
    const { data: existing, error: fetchErr } = await supabase
      .from('security_deposit_photo_matches')
      .select('*')
      .eq('case_id', fields.case_id)
      .eq('move_out_photo_path', fields.move_out_photo_path)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (existing) return { row: existing, alreadyExisted: true };
  }
  throw error;
}

// ─── POST /api/security-deposit/cases/:id/photo-matches ────────────────
// THIS is the photo-selection/submission endpoint the coordinator
// actually uses: runs the byte-fetch + AI match, stores the result,
// returns it. Idempotent per (case, move-out photo) — see the migration's
// own UNIQUE(case_id, move_out_photo_path); re-submitting the same photo
// returns the already-computed row instead of re-spending an AI call.
//
// ANTHROPIC_API_KEY CONCURRENCY (TARS, 2026-08-25 — investigated, not
// changed): one of the two 2026-08-25 test runs hit an HTTP 401 "API key
// is invalid" on ALL batches of one submission simultaneously. Checked
// Anthropic's published rate-limit model for this: limits (requests/min,
// tokens/min) are enforced per-ORGANIZATION, shared across every API key
// under that org, and exceeding them returns 429 ("Too Many Requests") —
// there is no documented mechanism by which concurrent requests from a
// valid key produce a 401 ("authentication is invalid," a completely
// different failure class from rate limiting). A single Node process
// calling `new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })`
// fresh inside every matchPhoto() call (lib/photo-matcher.js) is also not
// itself a documented source of auth failures — the SDK doesn't do
// anything key-related beyond reading that one env var per client. That
// combination — a real auth-layer error with no documented concurrency
// trigger, seen only when two independent test processes were racing
// against the same ANTHROPIC_API_KEY — points at a test-environment
// artifact (e.g. one process's .env reload racing the other's, or a key
// rotation mid-test) rather than a product bug this fix needs to change
// code for. Flagged, not fixed: if a 401 (specifically 401, not 429)
// shows up again during genuine single-operator use of this route — not
// two test suites sharing a key — that would contradict this conclusion
// and is worth a fresh look. MATCH_BATCH_CONCURRENCY (4 batches at once,
// same key, same org) is exactly the kind of legitimate concurrent use
// Anthropic's own rate-limit design (429, with retry-after) already
// expects and the SDK's own default retry-on-429 already handles — that
// part was not touched by this investigation because nothing pointed at
// it as a problem.
router.post('/api/security-deposit/cases/:id/photo-matches', requireSecurityDepositRole('admin', 'pod_lead', 'inspection_coordinator', 'director_of_operations'), async (req, res) => {
  const caseId = req.params.id;
  const moveOutPhotoPath = req.body.move_out_photo_path;
  if (!moveOutPhotoPath || typeof moveOutPhotoPath !== 'string') {
    return res.status(400).json({ error: 'move_out_photo_path is required.' });
  }

  let matched;
  try {
    matched = await getCaseMatchedFolders(caseId);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
  if (!matched) return res.status(404).json({ error: 'Case not found.' });

  // Same path-scope defense as photo-file — a submitted move-out photo
  // must actually belong to this case's own matched move-out folder, not
  // an arbitrary path the client supplied.
  if (!pathBelongsToFolder(moveOutPhotoPath, matched.moveOut && matched.moveOut.b2_folder_path)) {
    return res.status(403).json({ error: "This photo does not belong to this case's matched move-out folder." });
  }

  // Idempotent re-submission — return the existing row rather than
  // re-spending an AI call or hitting the UNIQUE(case_id,
  // move_out_photo_path) constraint (migration design note).
  const { data: existingRow, error: existingErr } = await supabase
    .from('security_deposit_photo_matches')
    .select('*')
    .eq('case_id', caseId)
    .eq('move_out_photo_path', moveOutPhotoPath)
    .maybeSingle();
  if (existingErr) return res.status(500).json({ error: existingErr.message });
  if (existingRow) return res.json({ success: true, match: existingRow, already_existed: true });

  if (!matched.moveIn) {
    return res.status(400).json({
      error: 'No move-in photo folder is matched for this case yet. Use "Search by address" to find and confirm one before matching photos.',
    });
  }

  const { data: config, error: configErr } = await supabase
    .from('photo_match_confidence_config')
    .select('id, auto_show_threshold')
    .eq('is_active', true)
    .maybeSingle();
  if (configErr) return res.status(500).json({ error: configErr.message });
  if (!config) return res.status(500).json({ error: 'No active photo_match_confidence_config row — cannot decide auto-show vs. needs-confirmation.' });

  const selectorName = req.securityDepositMemberName || req.user.email;
  const now = new Date().toISOString();

  try {
    // Full-folder coverage, no sampling — see the block comment above
    // MAX_SINGLE_IMAGE_BYTES near the top of this file for why (Peter's
    // 2026-08-25 decision: "build it to check all photos"). listAllFilesInFolder
    // already excludes B2 folder markers, zero-byte placeholders, and
    // non-image file types; `folderScanTruncated` is only true if this
    // folder has more real photos than lib/b2-client.js's own
    // MAX_CANDIDATE_SCAN_FILES safety cap scanned — a real, honestly-
    // disclosed limit (see the notes[] block below), not the normal case.
    const { files: allCandidateFiles, truncated: folderScanTruncated } = await listAllFilesInFolder(matched.moveIn.b2_folder_path);

    if (!allCandidateFiles.length) {
      // Nothing to compare against — a real, deterministic outcome, not a
      // failure. No AI call spent, so no photo_matched entry either
      // beyond this one still-logged selection + result.
      let inserted;
      try {
        inserted = await insertPhotoMatchRow({
          case_id: caseId,
          move_out_photo_path: moveOutPhotoPath,
          move_in_photo_path: null,
          confidence_score: 0,
          confidence_config_id: config.id,
          model_version: null,
          match_status: 'no_match_found',
          selected_by: selectorName,
          selected_at: now,
        });
      } catch (insErr) {
        return res.status(500).json({ error: insErr.message });
      }
      if (inserted.alreadyExisted) return res.json({ success: true, match: inserted.row, already_existed: true });

      await supabase.from('audit_log').insert({
        action: 'security_deposit.photo_match_selected',
        entity_type: 'security_deposit_case',
        entity_id: caseId,
        details: { move_out_photo_path: moveOutPhotoPath, selected_by: selectorName, case_id: caseId },
      });
      await supabase.from('audit_log').insert({
        action: 'security_deposit.photo_matched',
        entity_type: 'security_deposit_case',
        entity_id: caseId,
        details: { move_out_photo_path: moveOutPhotoPath, move_in_photo_path: null, confidence_score: 0, model_version: null, case_id: caseId },
      });

      return res.json({ success: true, match: inserted.row, note: 'The matched move-in folder has no photos to compare against.' });
    }

    const moveOutFileRaw = await downloadFileBytes(moveOutPhotoPath);
    // Resize BEFORE the size check below — a full-resolution phone photo
    // shrinks to a small fraction of its original bytes, so this 400 now
    // only fires on a genuinely pathological input (or a resize failure
    // that fell back to the original — see image-resize.js's own
    // fallback behavior), not on an ordinary full-res camera original.
    const moveOutFile = await resizeForMatching(moveOutFileRaw.buffer, moveOutFileRaw.contentType);
    if (moveOutFile.buffer.length > MAX_SINGLE_IMAGE_BYTES) {
      return res.status(400).json({ error: 'This photo is too large to match automatically. Browse the move-in gallery and match it manually instead.' });
    }

    // Download + resize EVERY candidate in the folder — a handful of B2
    // downloads in flight at once (CANDIDATE_DOWNLOAD_CONCURRENCY), not
    // one-at-a-time, since a full ~100-photo folder would otherwise pay
    // for ~100 sequential B2 round trips before a single Claude call could
    // even start. A candidate that fails to download is skipped (logged,
    // not fatal — same as before this change); a candidate that's still
    // oversized after resizing is counted in skippedForSize, same as
    // before.
    const downloadResults = await mapWithConcurrency(allCandidateFiles, CANDIDATE_DOWNLOAD_CONCURRENCY, async (f) => {
      let bytesRaw;
      try {
        bytesRaw = await downloadFileBytes(f.filePath);
      } catch (err) {
        console.error(`[security-deposit photo-match] failed to download candidate "${f.filePath}":`, err.message);
        return null;
      }
      const bytes = await resizeForMatching(bytesRaw.buffer, bytesRaw.contentType);
      return { filePath: f.filePath, buffer: bytes.buffer, contentType: bytes.contentType };
    });

    const candidates = [];
    let skippedForSize = 0;
    for (const c of downloadResults) {
      if (!c) continue; // download failed — already logged above
      if (c.buffer.length > MAX_SINGLE_IMAGE_BYTES) { skippedForSize++; continue; }
      candidates.push(c);
    }

    if (!candidates.length) {
      return res.status(502).json({ error: 'Could not download any move-in candidate photos from Backblaze B2 to match against.' });
    }

    // Coordinator's selection is logged once we know a real match attempt
    // is actually happening (past the "nothing to compare against" and
    // download-failure early exits above) — Asimov condition 2 /
    // audit-logging section.
    await supabase.from('audit_log').insert({
      action: 'security_deposit.photo_match_selected',
      entity_type: 'security_deposit_case',
      entity_id: caseId,
      details: { move_out_photo_path: moveOutPhotoPath, selected_by: selectorName, case_id: caseId },
    });

    // Pack every downloaded candidate into batches sized to fit BOTH
    // Claude's per-request image-count ceiling (MAX_CANDIDATES_PER_BATCH)
    // and the byte budget (MAX_TOTAL_MATCH_REQUEST_BYTES) alongside the
    // move-out photo, which is resent with every batch since each batch
    // is an independent Claude request. Computed from the REAL resized
    // sizes, not a hardcoded batch count, so this adapts correctly
    // whether a folder has 50 photos or 300. For Rincon's typical
    // ~100-photo folder at ~73KB per resized photo (last measured), the
    // byte budget alone would fit every candidate in ONE batch (~7.3MB of
    // ~18MB) — it's MAX_CANDIDATES_PER_BATCH (25, since the 2026-08-25
    // reliability fix — see that constant's own comment), not bytes, that
    // ends up splitting a 100-photo folder into ~4 batches in practice.
    const perBatchByteBudget = MAX_TOTAL_MATCH_REQUEST_BYTES - moveOutFile.buffer.length;
    const batches = [];
    let current = [];
    let currentBytes = 0;
    for (const c of candidates) {
      const wouldOverflow = current.length > 0 &&
        (current.length >= MAX_CANDIDATES_PER_BATCH || currentBytes + c.buffer.length > perBatchByteBudget);
      if (wouldOverflow) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(c);
      currentBytes += c.buffer.length;
    }
    if (current.length) batches.push(current);

    // One matchPhoto() call per batch, a few batches in flight at once
    // (MATCH_BATCH_CONCURRENCY) instead of strictly one after another —
    // keeps total wait time closer to one batch's duration instead of
    // every batch's duration added together. Most batches are expected to
    // come back with matched_index: null — that's normal, not a bug,
    // since only one batch (if any) actually contains the real match.
    //
    // RELIABILITY FIX (TARS, 2026-08-25 — see BATCH_RETRY_ATTEMPTS above
    // for the full reasoning): each batch now gets its own generous retry
    // loop, in place, before it's counted as failed. A batch that
    // succeeds on attempt 1 behaves exactly as before; a batch that fails
    // gets BATCH_RETRY_ATTEMPTS total tries (with backoff) — and every
    // one of those tries ALSO gets lib/photo-matcher.js's own internal
    // retry for the specific "no text block" case, so a genuinely
    // stubborn batch gets a real, layered, generous retry effort before
    // this loop gives up on it. A batch's ALREADY-SUCCEEDED result is
    // never discarded because a DIFFERENT batch is still retrying —
    // mapWithConcurrency awaits each batch independently.
    const batchResults = await mapWithConcurrency(batches, MATCH_BATCH_CONCURRENCY, async (batchCandidates, batchIndex) => {
      let lastError;
      for (let attempt = 1; attempt <= BATCH_RETRY_ATTEMPTS; attempt++) {
        try {
          const result = await matchPhoto({
            moveOutPhoto: { buffer: moveOutFile.buffer, contentType: moveOutFile.contentType },
            candidates: batchCandidates.map(c => ({ buffer: c.buffer, contentType: c.contentType })),
          });
          return { batchIndex, result, candidates: batchCandidates, error: null };
        } catch (error) {
          lastError = error;
          const willRetry = attempt < BATCH_RETRY_ATTEMPTS;
          console.error(
            `[security-deposit photo-match] batch ${batchIndex + 1}/${batches.length} failed on attempt ${attempt}/${BATCH_RETRY_ATTEMPTS}:`,
            error.message,
            willRetry ? '— retrying this batch.' : '— out of retries for this batch, giving up.'
          );
          if (willRetry) await sleep(batchRetryDelay(attempt));
        }
      }
      return { batchIndex, result: null, candidates: batchCandidates, error: lastError };
    });

    // A batch that STILL failed after its full retry effort above (not
    // just its first attempt) is NOT the same as "no match in that
    // batch": that slice of the folder was never actually checked, and
    // this route's whole job is checking every photo. Because this route
    // is idempotent per (case, move-out photo) — a resubmission just
    // returns whatever row already exists — quietly downgrading an
    // unchecked batch to "no match" here risks permanently recording a
    // wrong answer if the real match happened to live in the batch that
    // failed. So instead, a batch that exhausts its retries still fails
    // the WHOLE submission (no row is inserted below) — this safety
    // property is unchanged from before the 2026-08-25 fix. What DID
    // change: reaching this point now means a specific batch failed a
    // real, generous, independent retry effort of its own, not just one
    // unlucky attempt — so a resubmission after this point is much more
    // likely to be hitting a genuinely persistent problem (folder-specific
    // or otherwise) worth a human's attention, not routine flakiness. The
    // existing manual recovery path (a pod lead confirming or correcting a
    // match via POST .../photo-matches/:id/resolve) is unaffected either
    // way.
    const failedBatches = batchResults.filter(br => br.error);
    if (failedBatches.length) {
      throw new Error(`AI photo match failed on ${failedBatches.length} of ${batches.length} batch(es) after ${BATCH_RETRY_ATTEMPTS} attempts each: ${failedBatches[0].error.message}`);
    }

    // Overall best result across all batches: the highest-confidence
    // non-null match wins. Only the one batch that actually contains the
    // real match (if any) should ever return non-null with meaningful
    // confidence; every other batch is expected to correctly return no
    // match. In the unlikely event the AI returns a false-positive
    // plausible-looking match in a batch that does NOT hold the real
    // photo, highest confidence is still the reasonable tie-breaker — it's
    // the only signal this route has for which candidate to trust, and a
    // false positive confident enough to beat the real match still lands
    // as 'needs_confirmation' below the auto-show threshold (or gets
    // corrected by a pod lead via the resolve route) exactly like any
    // other imperfect match already did before this change.
    let best = null;
    let overallModelVersion = null;
    for (const br of batchResults) {
      if (!br.result) continue;
      if (overallModelVersion == null) overallModelVersion = br.result.model_version;
      if (br.result.matched_index == null) continue;
      if (!best || br.result.confidence > best.confidence) {
        best = {
          moveInPhotoPath: br.candidates[br.result.matched_index].filePath,
          confidence: br.result.confidence,
        };
      }
    }

    const moveInPhotoPath = best ? best.moveInPhotoPath : null;
    const confidence = best ? best.confidence : 0;
    const matchStatus = moveInPhotoPath == null
      ? 'no_match_found'
      : (confidence >= Number(config.auto_show_threshold) ? 'auto_shown' : 'needs_confirmation');

    // Routed through insertPhotoMatchRow (not a raw .insert()) so a losing
    // race here — two near-simultaneous submissions for the same (case,
    // move-out photo) both past the existingRow check above — hits the
    // same 23505 conflict backstop as the zero-candidate branch above,
    // instead of surfacing a raw Postgres duplicate-key error to the user.
    let inserted;
    try {
      inserted = await insertPhotoMatchRow({
        case_id: caseId,
        move_out_photo_path: moveOutPhotoPath,
        move_in_photo_path: moveInPhotoPath,
        confidence_score: confidence,
        confidence_config_id: config.id,
        model_version: overallModelVersion,
        match_status: matchStatus,
        selected_by: selectorName,
        selected_at: now,
      });
    } catch (insErr) {
      return res.status(500).json({ error: insErr.message });
    }
    const row = inserted.row;

    if (inserted.alreadyExisted) {
      // Lost the race — another request already inserted (and already
      // audit-logged) this exact (case, move-out photo) match. Return its
      // row gracefully; logging photo_matched again here would create a
      // duplicate audit entry for a match this request didn't actually
      // record.
      return res.json({ success: true, match: row, already_existed: true });
    }

    // Every AI photo match gets its own audit_log entry (Asimov condition
    // 2) — metadata only, exactly the fields the spec lists, plus two new
    // plain numbers (batches_run, total_candidates_compared) describing
    // HOW the match was computed — still just numbers, never a
    // description of either photo's content.
    await supabase.from('audit_log').insert({
      action: 'security_deposit.photo_matched',
      entity_type: 'security_deposit_case',
      entity_id: caseId,
      details: {
        move_out_photo_path: moveOutPhotoPath,
        move_in_photo_path: moveInPhotoPath,
        confidence_score: confidence,
        model_version: overallModelVersion,
        case_id: caseId,
        batches_run: batches.length,
        total_candidates_compared: candidates.length,
      },
    });

    const notes = [];
    if (batches.length > 1) {
      notes.push(`This move-in folder has ${allCandidateFiles.length} photos — every one was compared against this move-out photo, split across ${batches.length} batches (a single AI request can only hold so many images at once).`);
    }
    if (skippedForSize) notes.push(`${skippedForSize} candidate photo(s) were too large to include in this match attempt.`);
    if (folderScanTruncated) {
      notes.push(`This move-in folder has more than ${MAX_CANDIDATE_SCAN_FILES} photos — only the first ${MAX_CANDIDATE_SCAN_FILES} were scanned (a safety limit on how large a folder this tool will read). Contact an admin if this folder is unusually large.`);
    }

    return res.json({ success: true, match: row, note: notes.length ? notes.join(' ') : undefined });
  } catch (error) {
    console.error('[security-deposit photo-match] error:', error.message);
    return res.status(500).json({ error: 'Failed to run the photo match.', detail: error.message });
  }
});

// ─── GET /api/security-deposit/cases/:id/photo-matches ─────────────────
// Lists already-computed matches for this case, so re-opening it doesn't
// re-spend an AI call.
router.get('/api/security-deposit/cases/:id/photo-matches', requireSecurityDepositRole('admin', 'pod_lead', 'inspection_coordinator', 'director_of_operations'), async (req, res) => {
  const { data, error } = await supabase
    .from('security_deposit_photo_matches')
    .select('*')
    .eq('case_id', req.params.id)
    .order('selected_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data || []);
});

// ─── POST /api/security-deposit/photo-matches/:id/resolve ──────────────
// pod lead/admin ONLY — confirms or corrects a needs_confirmation (or
// no_match_found) row. inspection_coordinator does NOT get this route —
// separation of duties (spec's Q section): the coordinator submits and
// browses, it doesn't decide.
router.post('/api/security-deposit/photo-matches/:id/resolve', requireSecurityDepositRole('admin', 'pod_lead', 'director_of_operations'), async (req, res) => {
  const { confirmed, move_in_photo_path } = req.body;

  const { data: before, error: beforeErr } = await supabase
    .from('security_deposit_photo_matches')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();
  if (beforeErr) return res.status(500).json({ error: beforeErr.message });
  if (!before) return res.status(404).json({ error: 'Photo match not found.' });

  const updates = { resolved_by: req.securityDepositMemberName || req.user.email, resolved_at: new Date().toISOString() };

  if (confirmed) {
    if (!before.move_in_photo_path) {
      return res.status(400).json({ error: 'There is no matched move-in photo to confirm — correct this instead by supplying move_in_photo_path.' });
    }
    updates.match_status = 'manually_confirmed';
  } else {
    if (!move_in_photo_path || typeof move_in_photo_path !== 'string') {
      return res.status(400).json({ error: 'move_in_photo_path is required to correct a match.' });
    }
    let matched;
    try {
      matched = await getCaseMatchedFolders(before.case_id);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
    if (!matched || !pathBelongsToFolder(move_in_photo_path, matched.moveIn && matched.moveIn.b2_folder_path)) {
      return res.status(403).json({ error: "This photo does not belong to this case's matched move-in folder." });
    }
    updates.match_status = 'manually_corrected';
    updates.move_in_photo_path = move_in_photo_path;
  }

  const { data: updated, error } = await supabase
    .from('security_deposit_photo_matches')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // Corrected action name — see spec's own naming-correction note: NOT
  // 'security_deposit.photo_match_resolved' (that string is already used
  // by the existing b2_photo_folders resolve route above, for a different
  // table). This one is 'case_photo_match_resolved' so the two
  // conceptually different resolutions stay distinguishable by action
  // name, not just entity_type.
  await supabase.from('audit_log').insert({
    action: 'security_deposit.case_photo_match_resolved',
    entity_type: 'security_deposit_photo_match',
    entity_id: req.params.id,
    details: {
      case_id: before.case_id,
      move_out_photo_path: before.move_out_photo_path,
      move_in_photo_path: updates.move_in_photo_path || before.move_in_photo_path,
      match_status: updates.match_status,
      resolved_by: updates.resolved_by,
    },
  });

  return res.json({ success: true, match: updated });
});

// ─── GET /api/security-deposit/cases/:id/photo-folder-search ───────────
// Reuses findBestPhotoMatch's own scoring primitives (normalizeAddress /
// addressWordScore) against user-typed text instead of the case's
// recorded address, without the automatic matcher's 0.6 cutoff or its
// needs_review exclusion — the whole point is to surface candidates the
// automatic matcher rejected or never found. Read-only, not logged (this
// tool's existing practice for reads).
router.get('/api/security-deposit/cases/:id/photo-folder-search', requireSecurityDepositRole('admin', 'pod_lead', 'inspection_coordinator', 'director_of_operations'), async (req, res) => {
  const q = String(req.query.q || '').trim();
  const inspectionType = req.query.inspection_type;
  if (!['move_in', 'move_out'].includes(inspectionType)) {
    return res.status(400).json({ error: 'inspection_type must be "move_in" or "move_out".' });
  }
  if (q.length < SEARCH_MIN_QUERY_LENGTH) {
    return res.status(400).json({ error: `q must be at least ${SEARCH_MIN_QUERY_LENGTH} characters.` });
  }

  let folders;
  try {
    folders = await fetchAllIndexedB2Folders();
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  // Same inspection-type filter findBestPhotoMatch already applies
  // (exclude only when the parse is confident AND disagrees AND isn't
  // 'other') — but, unlike findBestPhotoMatch, no address-score cutoff
  // and no needs_review exclusion. That's the entire point of this route.
  const normQ = normalizeAddress(q);
  const results = folders
    .filter(f => !f.parsed_inspection_type || f.parsed_inspection_type === inspectionType || f.parsed_inspection_type === 'other')
    .map(f => ({ folder: f, score: addressWordScore(normQ, normalizeAddress(f.parsed_address || '')) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, SEARCH_MAX_RESULTS)
    .map(r => ({
      id: r.folder.id,
      b2_folder_path: r.folder.b2_folder_path,
      parsed_address: r.folder.parsed_address,
      parsed_unit: r.folder.parsed_unit,
      parsed_date: r.folder.parsed_date,
      parsed_inspection_type: r.folder.parsed_inspection_type,
      review_status: r.folder.review_status,
      score: r.score,
    }));

  return res.json({ results });
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
// 'inspection_coordinator' added by the targeted-photo-matching addendum
// (targeted-photo-matching-SPEC.md, Open Item #1 — RESOLVED). The value
// itself is already legal in the shared team_member_tool_roles.role CHECK
// and already granted/used by two other Hub tools (insurance_compliance,
// maintenance_history) — nothing to migrate. What was missing was local
// to this tool: this allow-list, so an admin can actually grant it
// through this tool's own Users tab, and the new photo routes' own
// requireSecurityDepositRole(...) calls below. Deliberately NOT added to
// any existing pod-lead-only route (checklist, review, prepaid-rent,
// escalate, escalate-confirm, inspection-form) — separation of duties,
// see the new photo-matches/:id/resolve route below for the one place
// this role is explicitly excluded.
const VALID_ROLES = ['admin', 'pod_lead', 'director_of_operations', 'inspection_coordinator'];
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
  const expected = process.env.CRON_SECRET;
  // Constant-time comparison — a plain !== leaks timing information that
  // could help an attacker guess the secret one byte at a time. Buffers
  // must be equal length for timingSafeEqual, so mismatched lengths are
  // rejected up front (that length check itself isn't constant-time, but
  // it leaks only the length, not any byte of the secret).
  const ok =
    typeof secret === 'string' &&
    typeof expected === 'string' &&
    secret.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(expected));
  if (!ok) {
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
//
// DEADLINE-CORRECTION FIX (Ralph finding, 2026-08-19) — the blocker this
// build exists to close: security_deposit_cases.move_out_date is copied
// onto the case ONCE, at creation time, and disposition_deadline is
// GENERATED ALWAYS AS (move_out_date + 21) STORED from that frozen copy
// (20260813000002's own design note already anticipates this: "if
// AppFolio's move_out_date is ever corrected... this case's copy should
// be re-synced from there, not hand-edited"). Before this fix, the ONLY
// thing that ran on every nightly sync was the upsert below with
// ignoreDuplicates:true — so once a case existed, a later correction to
// leases.move_out_date (AppFolio data entry fixed, a sync mapping bug
// resolved, etc.) was silently discarded forever and the case kept
// counting down from the wrong date. Exactly the "legal-exposure, not
// cosmetic" class of bug SPEC.md calls out for the 21-day clock.
//
// DESIGN CALL — does a 'reviewed'/'escalated' case also get corrected,
// or does it get left alone with just a signal that the dates disagree?
// Chose: correct it too, unconditionally, regardless of status. Two
// reasons: (1) 20260813000002's own comment above is unconditional — it
// doesn't carve out an exception for a case a human has already acted
// on, because the deadline is a fact about the real world, not a fact
// about this tool's workflow state. (2) send-reminders fires for
// pending_review, reviewed, AND escalated cases alike — deliberately,
// because this tool has no way to verify the real disposition letter was
// actually mailed (see that route's own comment). Leaving
// disposition_deadline stale on a 'reviewed' case wouldn't just be an
// inaccurate label — it would keep sending the 7/14/18-day reminders on
// the WRONG day, which is the live compliance risk this build is meant
// to close, not a cosmetic one. A case that already got marked reviewed
// under the old date does get an extra, distinctly-flagged audit_log
// entry (requires_attention: true) rather than being corrected silently
// like an open case — a human should know their prior review was done
// against a date that has since moved, even though this job isn't going
// to decide FOR them whether that review needs redoing (that's a
// judgment call, not something a sync job should do by reopening the
// case on its own). GET /cases/:id also carries a live move_out_date_
// mismatch flag (see that route) as a defense-in-depth signal for the
// narrow window before this job's next run, or if a correction below
// ever fails.
internalRouter.post('/api/security-deposit/internal/create-cases-from-sync', async (req, res) => {
  if (!checkCronSecret(req, res)) return;
  const ts = new Date().toISOString();

  // Every lease with a move_out_date EVER recorded, portfolio-wide, no
  // time filter — this list only grows as more move-outs happen, and (per
  // the idempotent upsert below) is re-fetched in full on every nightly
  // run, not just "since yesterday." A silent 1,000-row truncation here
  // wouldn't error — it would just mean move-outs past whatever row the
  // cap landed on never get a security deposit case opened, with no
  // warning to anyone. Paginated for that reason.
  let leaseRows;
  try {
    leaseRows = await fetchAllRows((from, to) => supabase
      .from('leases')
      .select('id, move_out_date')
      .not('move_out_date', 'is', null)
      .order('id', { ascending: true })
      .range(from, to));
  } catch (error) {
    console.error(`[${ts}] create-cases-from-sync error:`, error.message);
    return res.status(500).json({ error: error.message });
  }
  if (!leaseRows || !leaseRows.length) {
    console.log(`[${ts}] create-cases-from-sync: no leases with a move_out_date`);
    return res.json({ created: 0 });
  }

  // Every existing case, portfolio-wide — needed to detect a
  // move_out_date correction (see the design-call comment above). Read
  // as a full-table page-through rather than filtering by a dynamic
  // .in(lease_id list) — same reasoning as leaseRows above (this table
  // can't be time-bounded either), and it avoids ever building an .in()
  // clause sized to a portfolio's entire lease count.
  let existingCases;
  try {
    existingCases = await fetchAllRows((from, to) => supabase
      .from('security_deposit_cases')
      .select('id, lease_id, move_out_date, status')
      .order('id', { ascending: true })
      .range(from, to));
  } catch (error) {
    console.error(`[${ts}] create-cases-from-sync existing-cases fetch error:`, error.message);
    return res.status(500).json({ error: error.message });
  }
  const existingCaseByLeaseId = new Map();
  for (const c of existingCases || []) existingCaseByLeaseId.set(c.lease_id, c);

  // Any lease whose current move_out_date no longer matches its case's
  // stored copy — the correction this fix exists for. String compare is
  // safe here: both sides are Postgres DATE columns serialized the same
  // way (YYYY-MM-DD) by PostgREST.
  const correctionCandidates = [];
  for (const l of leaseRows) {
    const existing = existingCaseByLeaseId.get(l.id);
    if (existing && String(existing.move_out_date) !== String(l.move_out_date)) {
      correctionCandidates.push({ existing, newMoveOutDate: l.move_out_date });
    }
  }

  let corrected = 0;
  for (const { existing, newMoveOutDate } of correctionCandidates) {
    const oldMoveOutDate = existing.move_out_date;
    // Update only move_out_date — disposition_deadline recomputes on its
    // own (GENERATED column). One bad correction is isolated so it can't
    // abort the rest of this job or the case-creation pass below.
    const { error: correctErr } = await supabase
      .from('security_deposit_cases')
      .update({ move_out_date: newMoveOutDate })
      .eq('id', existing.id);
    if (correctErr) {
      console.error(`[${ts}] create-cases-from-sync move_out_date correction error (case ${existing.id}):`, correctErr.message);
      continue;
    }
    corrected++;
    const wasReviewed = existing.status === 'reviewed';
    await supabase.from('audit_log').insert({
      action: 'security_deposit.move_out_date_corrected',
      entity_type: 'security_deposit_case',
      entity_id: existing.id,
      details: {
        old_move_out_date: oldMoveOutDate,
        new_move_out_date: newMoveOutDate,
        case_status_at_correction: existing.status,
        source: 'sync_correction', // not a human edit — AppFolio's leases.move_out_date changed after this case already existed
        requires_attention: wasReviewed,
        note: wasReviewed
          ? 'This case was already marked reviewed under the old move-out date. The underlying AppFolio move-out date has since changed — confirm whether the disposition needs a second look.'
          : null,
      },
    });
    console.log(`[${ts}] create-cases-from-sync: corrected move_out_date for case ${existing.id} (lease ${existing.lease_id}) ${oldMoveOutDate} -> ${newMoveOutDate} (status was ${existing.status}${wasReviewed ? ' — flagged for attention' : ''})`);
  }

  // The upsert's own response is subject to the same 1,000-row cap as a
  // plain .select() — with thousands of leases now possible above, the
  // write side needs to batch too, or "which rows actually got returned"
  // would silently shrink along with it (breaking the tenancy_status
  // best-effort loop right below, which only runs for rows it can see).
  const caseRows = leaseRows.map(l => ({ lease_id: l.id, move_out_date: l.move_out_date }));
  const inserted = [];
  for (let i = 0; i < caseRows.length; i += SUPABASE_PAGE_SIZE) {
    const batch = caseRows.slice(i, i + SUPABASE_PAGE_SIZE);
    const { data: batchInserted, error: insErr } = await supabase
      .from('security_deposit_cases')
      .upsert(batch, { onConflict: 'lease_id', ignoreDuplicates: true })
      .select('id, lease_id');
    if (insErr) {
      console.error(`[${ts}] create-cases-from-sync upsert error:`, insErr.message);
      return res.status(500).json({ error: insErr.message });
    }
    inserted.push(...(batchInserted || []));
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
  console.log(`[${ts}] create-cases-from-sync: ${createdCount} new case(s), ${corrected} move_out_date correction(s)`);
  return res.json({ created: createdCount, corrected });
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

  // pending_review/reviewed/escalated covers nearly every case a
  // disposition hasn't actually been mailed for yet, with no time bound —
  // this keeps growing as more move-outs are processed. Missing a case
  // here because of a silent 1,000-row cutoff means its reminder simply
  // never fires, with the 21-day statutory deadline (and no one warned)
  // — the same class of risk as the create-cases-from-sync fetch above,
  // so it gets the same fix.
  let cases;
  try {
    cases = await fetchAllRows((from, to) => supabase
      .from('security_deposit_cases')
      .select(`
        id, disposition_deadline, status,
        leases ( units ( unit_number, properties ( name, address ) ) )
      `)
      .in('status', ['pending_review', 'reviewed', 'escalated'])
      .order('id', { ascending: true })
      .range(from, to));
  } catch (error) {
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

  const list = due.map(c => {
    const addrProps = c.leases && c.leases.units && c.leases.units.properties;
    const addr = (addrProps && (addrProps.address || addrProps.name)) || 'Unknown property';
    const unit = c.leases && c.leases.units && c.leases.units.unit_number;
    return `- ${addr}${unit ? ' Unit ' + unit : ''}: ${daysRemaining(c.disposition_deadline)} days left`;
  }).join('\n');

  if (!recipients.length) {
    console.warn(`[${ts}] send-reminders: ${due.length} case(s) due but no active pod_lead recipients found.`);
    await sendFailureAlertEmail(
      `Security Deposit: ${due.length} disposition(s) approaching deadline, but no recipient configured`,
      `The nightly security-deposit deadline-reminder job found ${due.length} case(s) approaching their 21-day deadline, but there is no active pod_lead configured to receive the reminder — nobody was notified:\n\n${list}\n\nAdd an active pod_lead under Security Deposit team roles.`
    );
    return res.json({ due: due.length, recipients_attempted: 0, sent: 0, failed: 0, warning: 'No active pod_lead recipients.' });
  }

  // sent/failed below are real per-recipient outcomes, not just "we
  // attempted N recipients" — found via code audit, 2026-08-28: this
  // route used to always report sent: recipients.length regardless of
  // whether the send actually succeeded, so a completely broken mailer
  // (missing credentials or a thrown error) still looked like a clean
  // "sent" response to anything checking this endpoint. Nodemailer's
  // sendMail can also resolve successfully while rejecting individual
  // addresses (bad address, full mailbox) — info.rejected/.accepted is
  // the real per-recipient signal, same one sendEscalationEmail uses.
  let sent = 0;
  let failed = recipients.length;
  let emailError = null;
  let rejectedAddrs = [];
  try {
    const mailer = createMailer();
    if (mailer) {
      const info = await mailer.sendMail({
        from: process.env.GMAIL_USER,
        to: recipients.join(', '),
        subject: `Security Deposit: ${due.length} disposition${due.length === 1 ? '' : 's'} approaching the 21-day deadline`,
        text: `The following security deposit dispositions are approaching their 21-day deadline:\n\n${list}\n\nLog in to the Rincon Hub and open Security Deposit to review.`,
      });
      rejectedAddrs = info.rejected || [];
      sent = (info.accepted || []).length;
      failed = rejectedAddrs.length;
      if (failed) {
        console.error(`[${ts}] send-reminders: ${failed} of ${recipients.length} recipient(s) rejected: ${rejectedAddrs.join(', ')}`);
      } else {
        console.log(`[${ts}] send-reminders: notified ${sent} pod lead(s) about ${due.length} case(s)`);
      }
    } else {
      emailError = 'Email not configured (GMAIL_USER/GMAIL_APP_PASSWORD missing).';
      console.warn(`[${ts}] send-reminders: ${due.length} case(s) due but email is not configured (GMAIL_USER/GMAIL_APP_PASSWORD).`);
    }
  } catch (emailErr) {
    emailError = emailErr.message;
    console.error(`[${ts}] send-reminders email error:`, emailErr.message);
  }

  if (sent === 0 || failed > 0) {
    await sendFailureAlertEmail(
      `Security Deposit: reminder email ${sent === 0 ? 'FAILED to send' : 'partially failed'} — ${due.length} case(s) approaching deadline`,
      [
        'The nightly security-deposit deadline-reminder job ran, but the notification email did not fully send.',
        '',
        `Cases due (${due.length}):`,
        list,
        '',
        `Recipients attempted: ${recipients.join(', ')}`,
        emailError ? `Error: ${emailError}` : `Rejected: ${rejectedAddrs.join(', ')}`,
      ].join('\n')
    );
  }

  return res.json({ due: due.length, recipients_attempted: recipients.length, sent, failed, email_error: emailError });
});

// Supabase/PostgREST caps any single .select() at 1000 rows by default —
// silent truncation, no error. b2_photo_folders passed that row count
// during real testing, which was silently dropping everything past row
// 1,000 from existingPaths below and causing this job to re-attempt
// (and duplicate-key-fail on) folders it had already indexed. Same
// incremental-fetch pattern as maintenance-history/lib/latchel-
// connector.js's getAllPages fix for an equivalent "only got page 1" bug
// — loop with .range() until a page comes back short, so this is correct
// no matter how large the table grows.
const B2_EXISTING_PATHS_PAGE_SIZE = 1000;
async function fetchAllExistingB2FolderPaths() {
  const paths = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('b2_photo_folders')
      .select('b2_folder_path')
      .range(from, from + B2_EXISTING_PATHS_PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data || []) paths.push(row.b2_folder_path);
    if (!data || data.length < B2_EXISTING_PATHS_PAGE_SIZE) break; // short page = last page
    from += B2_EXISTING_PATHS_PAGE_SIZE;
  }
  return paths;
}

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

  // Whole-body try/catch — this job makes hundreds/thousands of
  // sequential B2, Supabase, and Claude calls in one request. Express 4
  // does not catch a rejected promise thrown out of an async route
  // handler; left unguarded, one unexpected failure here would become an
  // unhandled rejection that (on Node's current default) kills the
  // entire Hub server process, not just this request — which is what
  // happened during real testing. Every per-folder failure is already
  // isolated below; this is the outer backstop for anything else.
  try {
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

    let existingPathList;
    try {
      existingPathList = await fetchAllExistingB2FolderPaths();
    } catch (err) {
      console.error(`[${ts}] index-b2-photos existing-paths fetch error:`, err.message);
      return res.status(500).json({ error: 'Failed to load already-indexed folders.', detail: err.message });
    }
    const existingPaths = new Set(existingPathList);
    const newPaths = allPaths.filter(p => !existingPaths.has(p));

    let indexed = 0;
    let duplicateSkipped = 0;
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

        if (insErr) {
          if (insErr.code === '23505') {
            // Duplicate on b2_folder_path means this folder actually was
            // already indexed — we just didn't know it (e.g. indexed by
            // a run that finished after this run's existingPaths
            // snapshot was taken). Harmless: skip quietly. Not pushed
            // into `errors` (that would wrongly flag it as needing
            // attention) and not logged per-occurrence (would flood the
            // log at scale) — just counted, with the total reported once
            // below.
            duplicateSkipped++;
            continue;
          }
          throw insErr;
        }

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

    console.log(`[${ts}] index-b2-photos: ${indexed} new folder(s) indexed, ${duplicateSkipped} duplicate(s) skipped (already indexed), ${errors.length} real error(s), ${allPaths.length - newPaths.length} already indexed (pre-filtered).`);
    return res.json({
      indexed,
      duplicate_skipped: duplicateSkipped,
      errors,
      total_folders_seen: allPaths.length,
      skipped_already_indexed: allPaths.length - newPaths.length,
    });
  } catch (err) {
    console.error(`[${ts}] index-b2-photos unexpected error:`, err.message);
    return res.status(500).json({ error: 'Unexpected error during indexing.', detail: err.message });
  }
});

module.exports = { router, internalRouter };
