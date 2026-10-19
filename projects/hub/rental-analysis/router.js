/**
 * rental-analysis/router.js
 * Rental Analysis, migrated from the standalone projects/rental-analysis
 * deployment (https://srv1784739.hstgr.cloud/rental-analysis/) into a
 * section of the Rincon Hub, mounted at /rental-analysis (page) and
 * /api/rental-analysis/* (API — paths unchanged from the standalone app on
 * purpose, so dashboard/index.html's existing fetch() calls needed zero
 * changes; its own API_BASE = '' already resolves correctly against any
 * origin/path combination for absolute-path fetches like this).
 *
 * Full spec: projects/rental-analysis/HUB-INTEGRATION-SPEC.md — treat it as
 * authoritative. This file follows its "What Q Needs to Build" section.
 *
 * WHAT CHANGED FROM THE STANDALONE APP — READ THIS FIRST
 *   1. Login: the standalone app had NO login of any kind — anyone with the
 *      link could run analyses and see Rincon's internal comp data. That
 *      was a real, flagged gap. It's gone: everyone reaching any route in
 *      this file has already been authenticated by the hub's shared login
 *      (lib/middleware.js's requireLogin, mounted in server.js before this
 *      router) — real Supabase Auth email + password, same login as every
 *      other hub section.
 *   2. Permissions: the standalone app had no concept of "who's allowed" at
 *      all — reaching the link was the only gate, and there wasn't one.
 *      attachRentalAnalysisRole() below is new work, same shape as
 *      attachInsuranceRole/attachSecurityDepositRole in the other tools'
 *      router.js files — looks up Neo's shared team_members /
 *      team_member_tool_roles tables (tool='rental_analysis') on every
 *      request and attaches req.rentalAnalysisRole. Rental analysis has no
 *      internal permission tiers of its own (unlike Insurance Compliance's
 *      four roles) — the only role value ever paired with
 *      tool='rental_analysis' is the shared 'admin' value, reused as-is
 *      rather than inventing a tool-specific role nothing in this tool's
 *      own logic distinguishes.
 *   3. NOT YET LIVE for anyone: Neo's migration (supabase/migrations/
 *      ..._rental_analysis_team_roles.sql) widens team_member_tool_roles'
 *      tool CHECK to allow 'rental_analysis', but inserts zero rows —
 *      granting access to specific sales/ops people is Peter's own,
 *      separate, later decision ("nothing actually gives them access until
 *      i say — i need the tool to be better before i roll it out"). Until
 *      Peter/Neo grant a role row to someone, every request past
 *      requireRentalAnalysisAccess correctly, safely responds 403 rather
 *      than erroring or letting anyone through — same fail-closed
 *      convention every other tool in this codebase already uses (see
 *      attachRentalAnalysisRole's catch block below).
 *   4. Business logic — comp pulling (RentCast/CRMLS/LeadSimple), scoring,
 *      weighting, narrative generation — is completely UNCHANGED. Every
 *      lib/*.js file here is a byte-for-byte copy of the standalone app's
 *      own lib/ files; nothing about this session's comp-scoring/
 *      radius-tiering/dedup logic was touched by this migration. This
 *      file only re-homes the three routes that used to live directly in
 *      the standalone server.js.
 *   5. CORS: the standalone app's own CORS allowlist middleware (needed
 *      because it was reachable from a different origin than the
 *      dashboard) is dropped entirely, not carried over — mounted
 *      in-process inside the Hub, the dashboard and the API are always
 *      same-origin, so there is no cross-origin request to guard against.
 *   6. Leaflet map (dashboard/index.html): previously loaded live from
 *      unpkg.com. The Hub runs helmet() with a Content-Security-Policy
 *      that does not allow script-src from any external CDN — moved in
 *      unchanged, the map would have silently failed to load. Fixed by
 *      self-hosting leaflet@1.9.4 (dashboard/vendor/leaflet/, byte-for-byte
 *      the same pinned version/build the standalone app used) and serving
 *      it same-origin — see the static mount below — rather than widening
 *      the Hub's shared CSP to trust unpkg.com. Self-hosting was chosen
 *      over widening the CSP specifically because the Hub's helmet()
 *      config is applied once, app-wide (projects/hub/server.js) — trusting
 *      unpkg.com in script-src would have opened that door for every other
 *      tool in the Hub too, not just this one page. No CSP change was
 *      needed anywhere as a result of this choice.
 *
 *   7. Past reports (added later): GET /api/rental-analysis/history and
 *      GET /api/rental-analysis/history/:id list and reopen saved reports,
 *      read-only. They exist only here, never in the standalone server.js
 *      (which has no login). See the "Past reports" block below.
 *
 * Only one router is exported (no internalRouter): confirmed by reading
 * the standalone rental-analysis/server.js in full — it has no cron/
 * webhook endpoint today, unlike tools that export one.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const { select, insert, update } = require('./lib/supabase');
const { runActiveSources } = require('./lib/sources');
const { lookupPropertyDetails } = require('./lib/rentcast');
const { getMarketData } = require('./lib/market-data');
const { suggestAddresses } = require('./lib/google-places');
const { findBestPropertyMatch, hasParseableHouseNumber, hasStreetName } = require('./lib/property-matching');
const { computeNumbers } = require('./lib/analyze');
const { buildCompRows } = require('./lib/comp-rows');
const { parseAgeRestrictedInput, parseSubdivisionInput } = require('./lib/mls-facts');
const { stripControlChars, checkSubjectLimits, parseFurnishedInput, parseSubjectConditionInput, MAX_ADDRESS_LENGTH } = require('./lib/subject-inputs');
const { sizeBandPctFor } = require('./lib/weighting');
const { parseOwnerGoalInput, classifySourceResult, noCompsRationale, buildCompletionPatch, headlineForDisplay, buildApiResponse, buildSourceNotes } = require('./lib/outcome');
const { generateNarrative } = require('./lib/narrative');
const { PROPERTY_TYPES } = require('./lib/constants');
const { isUuid, parseHistoryQuery, buildListQuery, shapeListRow, rebuildReport, REPORT_COLUMNS, COMP_COLUMNS } = require('./lib/history');
const { GLOBAL_SEARCH_WIDGET_HTML } = require('../lib/global-search-widget');

// ─── Config ─────────────────────────────────────────────────────────────
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY are already
// validated by hub/server.js before this file is ever required — same
// defensive re-check every other tool's router.js does anyway (insurance/
// router.js, security-deposit/router.js), so a future change to server.js's
// own startup checks can't silently leave this section half-configured.
const missing = [];
if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
if (missing.length > 0) {
  console.error(`[rental-analysis] Missing environment variables: ${missing.join(', ')}`);
  console.error('[rental-analysis] Set these in the shared .env at the project root (see .env.example).');
  process.exit(1);
}

// RENTCAST_API_KEY and GOOGLE_PLACES_API_KEY are NOT startup requirements
// here either — same as the standalone app's own server.js, each is
// checked per-request inside its own lib/*.js file the moment that source
// actually runs (lib/rentcast.js, lib/google-places.js), so a missing key
// degrades that one source/feature rather than taking down this whole
// section.
if (!process.env.RENTCAST_API_KEY) {
  console.warn('[rental-analysis] RENTCAST_API_KEY not set — analyses will fail until it is added to the Hub\'s .env (developers.rentcast.io, free tier).');
}
if (!process.env.GOOGLE_PLACES_API_KEY) {
  console.warn('[rental-analysis] GOOGLE_PLACES_API_KEY not set — address-suggest will return no suggestions until it is added to the Hub\'s .env (Google Cloud Console, Places API (New), free tier).');
}
// Same non-startup-blocking treatment — a missing key just means GET
// /api/rental-analysis/map-config below returns a null tileKey and the
// dashboard renders the comp map without background tiles, not a broken
// section. See that route's own comment for why this key (unlike the two
// above) is read by the browser, not just this server.
if (!process.env.MAPTILER_API_KEY) {
  console.warn('[rental-analysis] MAPTILER_API_KEY not set — the comp map will render without background tiles until it is added to the Hub\'s .env (maptiler.com, free tier).');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Service role key — bypasses Row Level Security, same pattern every other
// tool's router.js uses for its own team_members/team_member_tool_roles
// lookups (see insurance/router.js's own comment on this). Only used here
// for the ROLE lookup below — the tool's actual business data (rental_
// analyses, rental_comps, etc.) still goes through lib/supabase.js's own
// plain-fetch REST wrapper, unchanged from the standalone app.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Permission check — reads Neo's shared team tables ────────────────────
// Same shape as attachInsuranceRole (insurance/router.js) and
// attachSecurityDepositRole (security-deposit/router.js). Runs on every
// request to this section. req.user is already set by the hub's
// requireLogin (a real, currently-valid Supabase Auth user) by the time any
// route here executes — this middleware answers the NEXT question: is this
// specific person allowed in Rental Analysis, and with what role.
async function attachRentalAnalysisRole(req, res, next) {
  req.rentalAnalysisRole = null;
  req.teamMemberId = null;
  req.rentalAnalysisMemberName = null;

  try {
    const { data: member, error: memberErr } = await supabase
      .from('team_members')
      .select('id, full_name, is_active')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();

    if (memberErr) throw memberErr;
    if (!member || !member.is_active) return next();

    req.teamMemberId = member.id;
    req.rentalAnalysisMemberName = member.full_name || null;

    const { data: roleRow, error: roleErr } = await supabase
      .from('team_member_tool_roles')
      .select('role')
      .eq('team_member_id', member.id)
      .eq('tool', 'rental_analysis')
      .maybeSingle();

    if (roleErr) throw roleErr;
    req.rentalAnalysisRole = roleRow ? roleRow.role : null;
    next();
  } catch (err) {
    // Fail closed: if the permission tables can't be reached (e.g. Neo's
    // migration hasn't been applied to the live database yet, or nobody has
    // been granted a role for tool='rental_analysis' at all), treat the
    // request as having no access rather than letting it through. This is
    // the expected state until Peter explicitly grants someone a role — see
    // the file header.
    console.error('[rental-analysis] permission lookup failed:', err.message);
    next();
  }
}

function requireRentalAnalysisAccess(req, res, next) {
  if (!req.rentalAnalysisRole) {
    return res.status(403).json({
      error: 'Your Rincon Hub account does not have access to Rental Analysis yet. Ask an admin to grant you access.',
    });
  }
  next();
}

function validationError(res, message) {
  return res.status(400).json({ error: message });
}

// ─── Router: everyone reaching here is already hub-logged-in ──────────────
const router = express.Router();
router.use(attachRentalAnalysisRole);

// ─── Self-hosted Leaflet assets — no access gate ───────────────────────────
// Plain static library files (JS/CSS/marker images), not tool data — same
// "static shell, no gate needed" reasoning as GET /rental-analysis below.
// Mounted at /rental-analysis/vendor/... so dashboard/index.html's relative
// <link>/<script> tags (edited to point here instead of unpkg.com) resolve
// correctly, and so leaflet.css's own relative url(images/marker-icon.png)
// references resolve to dashboard/vendor/leaflet/images/ alongside it.
router.use('/rental-analysis/vendor', express.static(path.join(__dirname, 'dashboard', 'vendor')));

// ─── GET /rental-analysis — the dashboard page ─────────────────────────────
// No server-side access gate here on purpose — same reasoning insurance's
// GET /insurance and security-deposit's GET /security-deposit both use:
// this is just the static page shell (no data embedded in it). The page
// itself has no client-side access check yet either (Tron's follow-up build
// adds one, calling GET /api/rental-analysis/auth/me below) — every route
// that actually returns or changes data IS gated.
router.get('/rental-analysis', (req, res) => {
  fs.readFile(path.join(__dirname, 'dashboard', 'index.html'), 'utf8', (err, html) => {
    if (err) return res.status(500).send('Could not load page.');
    res.send(html.replace('<body>', '<body>\n' + GLOBAL_SEARCH_WIDGET_HTML));
  });
});

// ─── GET /api/rental-analysis/auth/me ──────────────────────────────────────
// New — the standalone app never had a login to check against. Same shape
// every other tool's auth/me already returns: { email, name, role }.
router.get('/api/rental-analysis/auth/me', requireRentalAnalysisAccess, (req, res) => {
  res.json({
    email: req.user.email,
    name: req.rentalAnalysisMemberName || req.user.email,
    role: req.rentalAnalysisRole,
  });
});

// ─── GET /api/rental-analysis/map-config ───────────────────────────────────
// New (this migration didn't have a comp map to speak of yet when the rest
// of this file's "unchanged from standalone" routes were written). Hands
// the dashboard's comp map the MapTiler key it needs to build its own tile
// URL client-side — see the standalone app's own server.js
// (projects/rental-analysis/server.js) for the full reasoning on why this
// one key, unlike RentCast/LocationIQ above, is read by the browser rather
// than proxied through this server. Gated the same as every other data
// route here even though the key itself isn't sensitive Rincon data —
// consistent with this file's "every route that actually returns anything
// IS gated" rule (see GET /rental-analysis above).
router.get('/api/rental-analysis/map-config', requireRentalAnalysisAccess, (req, res) => {
  res.json({ tileKey: process.env.MAPTILER_API_KEY || null });
});

// ─── GET /api/rental-analysis/users ────────────────────────────────────────
// Unchanged from the standalone app: read-only list of users for the
// frontend's "Run by" dropdown. Note this is the tool's own `users` table
// (who ran an analysis), not team_members/Hub login identity — kept exactly
// as it worked before, just gated now.
router.get('/api/rental-analysis/users', requireRentalAnalysisAccess, async (req, res) => {
  try {
    const users = await select('users', 'select=id,name&order=name.asc');
    return res.json(users);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] users lookup error:`, err.message);
    return res.status(500).json({ error: 'Failed to load users.', detail: err.message });
  }
});

// ─── Past reports (read-only) ──────────────────────────────────────────────
// Added after the migration: a way for staff to list and reopen reports that
// were run before. Hub only: the standalone app has no login, so it has no
// copy of these two routes on purpose. Both sit behind the same two gates as
// every other route here (the Hub login that runs before this router, then
// requireRentalAnalysisAccess). They only READ saved rows: no RentCast, Recore
// or AI call is ever made, and nothing is written. The rules (what is listed,
// how a saved report is shown again) are in lib/history.js.
//
// Who may open what: anyone who may use Rental Analysis may open any saved
// report, the same as the tool has always shown every report's comps to every
// person with access. The only thing said about who ran it is their NAME, taken
// from the same `users` table the "Run by" list uses; nobody's email or phone
// number is ever read, and database error text never goes to the browser.
async function lookupRunByNames(ids) {
  const wanted = [...new Set((ids || []).filter(isUuid))];
  if (!wanted.length) return {};
  const rows = await select('users', `select=id,name&id=in.(${wanted.join(',')})`);
  return Object.fromEntries(rows.map(u => [u.id, u.name]));
}

// ─── GET /api/rental-analysis/history ──────────────────────────────────────
// ?limit= (default 50, at most 100) &offset= &q= (address text) &show_failed=1
// Newest first. Failed (and never-finished) reports are left out unless asked for.
router.get('/api/rental-analysis/history', requireRentalAnalysisAccess, async (req, res) => {
  const parsed = parseHistoryQuery(req.query);
  if (parsed.error) return validationError(res, parsed.error);
  try {
    const rows = await select('rental_analyses', buildListQuery(parsed));
    const page = rows.slice(0, parsed.limit);
    // a name that cannot be looked up leaves that column empty; it never stops the list
    const names = await lookupRunByNames(page.map(r => r.run_by)).catch(err => {
      console.error(`[${new Date().toISOString()}] past reports: names lookup error:`, err.message);
      return {};
    });
    res.set('Cache-Control', 'no-store');
    return res.json({
      rows: page.map(r => shapeListRow(r, names[r.run_by])),
      limit: parsed.limit,
      offset: parsed.offset,
      hasMore: rows.length > parsed.limit,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] past reports list error:`, err.message);
    return res.status(500).json({ error: 'Could not load past reports.' });
  }
});

// ─── GET /api/rental-analysis/history/:id ──────────────────────────────────
// One saved report, in the same shape POST /run answers with, so the page draws
// it with the same code. 400 for an id that is not a UUID, 404 when there is no such report.
router.get('/api/rental-analysis/history/:id', requireRentalAnalysisAccess, async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id)) return validationError(res, 'id must be a report id (a UUID).');
  try {
    const found = await select('rental_analyses', `select=${REPORT_COLUMNS}&id=eq.${id}`);
    if (!found.length) return res.status(404).json({ error: 'No saved report was found with that id.' });
    const analysis = found[0];
    // only the saved area-figures row for this zip is read (never getMarketData(), which can spend a RentCast request)
    const zip = typeof analysis.subject_zip === 'string' && /^\d{5}$/.test(analysis.subject_zip) ? analysis.subject_zip : null;
    // a figures lookup that FAILS is worded differently on screen from figures that were never saved
    let marketLookupFailed = false;
    const [comps, sources, names, marketRows] = await Promise.all([
      select('rental_comps', `select=${COMP_COLUMNS}&analysis_id=eq.${id}&limit=500`),
      select('rental_comp_sources', 'select=id,name'),
      lookupRunByNames([analysis.run_by]).catch(() => ({})),
      zip ? select('rental_market_data', `select=*&zip=eq.${zip}`).catch(err => {
        marketLookupFailed = true;
        console.error(`[${new Date().toISOString()}] past report ${id}: area figures lookup error:`, err.message);
        return [];
      }) : Promise.resolve([]),
    ]);
    const { report, flags } = rebuildReport({
      analysis,
      comps,
      sourceNamesById: Object.fromEntries(sources.map(s => [s.id, s.name])),
      runByName: names[analysis.run_by] || null,
      marketData: marketRows[0] || null,
      marketLookupFailed,
    });
    if (flags.length) console.warn(`[${new Date().toISOString()}] past report ${id}: a recount from the saved homes did not match the saved values (${flags.join(', ')}); the saved values are shown.`);
    res.set('Cache-Control', 'no-store');
    return res.json(report);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] past report ${id} error:`, err.message);
    return res.status(500).json({ error: 'Could not load this saved report.' });
  }
});

// ─── GET /api/rental-analysis/property-lookup ──────────────────────────────
// Unchanged from the standalone app. See that file's own doc comment
// (projects/rental-analysis/server.js) for the full RentCast budget note.
router.get('/api/rental-analysis/property-lookup', requireRentalAnalysisAccess, async (req, res) => {
  const ts = new Date().toISOString();
  const address = typeof req.query.address === 'string' ? req.query.address.trim() : '';

  if (!address) {
    return validationError(res, 'address is required.');
  }
  if (!hasParseableHouseNumber(address)) {
    return validationError(res, 'address must include a street number (e.g. "123 Main St, Ventura, CA") — please include a street number so the lookup can trust the result.');
  }
  if (!hasStreetName(address)) {
    return validationError(res, 'address needs a street name.');
  }

  try {
    const details = await lookupPropertyDetails(address);
    if (!details) {
      return res.status(404).json({ error: 'No property record found for this address. Please enter the details manually.' });
    }
    return res.json(details);
  } catch (err) {
    console.error(`[${ts}] property-lookup error:`, err.message);
    return res.status(500).json({ error: 'Failed to look up property details.', detail: err.message });
  }
});

// ─── GET /api/rental-analysis/address-suggest ──────────────────────────────
// Same as the standalone app — switched from LocationIQ to Google Places
// Autocomplete (New) 2026-09-20, see lib/google-places.js.
router.get('/api/rental-analysis/address-suggest', requireRentalAnalysisAccess, async (req, res) => {
  const ts = new Date().toISOString();
  const q = typeof req.query.q === 'string' ? req.query.q : '';

  try {
    const suggestions = await suggestAddresses(q);
    return res.json(suggestions);
  } catch (err) {
    console.error(`[${ts}] address-suggest error:`, err.message);
    return res.json([]);
  }
});

// ─── POST /api/rental-analysis/run ─────────────────────────────────────────
// Unchanged from the standalone app — same validation, same pipeline, same
// response shape. See projects/rental-analysis/server.js's own doc comment
// for the full field-by-field rationale.
router.post('/api/rental-analysis/run', requireRentalAnalysisAccess, async (req, res) => {
  const ts = new Date().toISOString();
  const body = req.body || {};
  // a zero byte or other hidden control character in the typed address is dropped before anything uses it
  if (typeof body.subject_address === 'string') body.subject_address = stripControlChars(body.subject_address);
  const {
    subject_address,
    subject_bedrooms,
    subject_bathrooms,
    subject_sqft,
    subject_property_type,
    subject_year_built,
    lease_term_months,
    furnished,
    subject_age_restricted,
    subject_subdivision,
    subject_condition,
    owner_goal,
    run_by,
    property_id,
  } = body;

  // ── Validation ──────────────────────────────────────────────────────────
  if (!subject_address || typeof subject_address !== 'string' || !subject_address.trim()) {
    return validationError(res, 'subject_address is required.');
  }
  if (subject_address.length > MAX_ADDRESS_LENGTH) {
    return validationError(res, `subject_address must be ${MAX_ADDRESS_LENGTH} characters or fewer.`);
  }
  if (!hasParseableHouseNumber(subject_address)) {
    return validationError(res, 'subject_address must include a street number (e.g. "123 Main St, Ventura, CA") — please include a street number so the analysis can trust the result.');
  }
  // a bare number ("2461") has no street name to search by; refused before any lookup so no paid call is spent on it
  if (!hasStreetName(subject_address)) {
    return validationError(res, 'subject_address needs a street name.');
  }
  const bedrooms = Number(subject_bedrooms);
  if (subject_bedrooms === undefined || subject_bedrooms === null || subject_bedrooms === '' || !Number.isInteger(bedrooms) || bedrooms < 0) {
    return validationError(res, 'subject_bedrooms is required and must be a whole number >= 0.');
  }
  const bathrooms = Number(subject_bathrooms);
  if (subject_bathrooms === undefined || subject_bathrooms === null || subject_bathrooms === '' || !Number.isFinite(bathrooms) || bathrooms < 0) {
    return validationError(res, 'subject_bathrooms is required and must be a number >= 0.');
  }
  const sqft = Number(subject_sqft);
  if (!Number.isInteger(sqft) || sqft <= 0) {
    return validationError(res, 'subject_sqft is required and must be a whole number > 0.');
  }
  if (!PROPERTY_TYPES.includes(subject_property_type)) {
    return validationError(res, `subject_property_type must be one of: ${PROPERTY_TYPES.join(', ')}`);
  }
  let yearBuilt = null;
  if (subject_year_built !== undefined && subject_year_built !== null && subject_year_built !== '') {
    yearBuilt = Number(subject_year_built);
    if (!Number.isInteger(yearBuilt) || yearBuilt < 1800 || yearBuilt > 2100) {
      return validationError(res, 'subject_year_built must be a whole number between 1800 and 2100, or omitted.');
    }
  }
  const leaseTermMonths = Number(lease_term_months);
  if (!Number.isInteger(leaseTermMonths) || leaseTermMonths <= 0) {
    return validationError(res, 'lease_term_months is required and must be a whole number > 0.');
  }
  // Furnished must be a real true/false (the text "false" is not quietly read as yes), and no size may be absurd.
  const furnishedInput = parseFurnishedInput(furnished);
  if (furnishedInput.error) return validationError(res, furnishedInput.error);
  const isFurnished = furnishedInput.value;
  const limitError = checkSubjectLimits({ bedrooms, bathrooms, sqft, leaseTermMonths });
  if (limitError) return validationError(res, limitError);
  // "Subject is in a 55+ community" (optional, default no) and the subject's
  // neighborhood name (optional). Same checks as the standalone server.js.
  const ageRestrictedInput = parseAgeRestrictedInput(subject_age_restricted);
  if (ageRestrictedInput.error) return validationError(res, ageRestrictedInput.error);
  const ageRestricted = ageRestrictedInput.value;
  const subdivisionInput = parseSubdivisionInput(subject_subdivision);
  if (subdivisionInput.error) return validationError(res, subdivisionInput.error);
  const subjectSubdivision = subdivisionInput.value;
  // "Condition of your home" (optional, only if someone has seen it). Same check as the standalone server.js. Saved and
  // shown for reference; it is deliberately NOT put in `subject` below, so nothing that works out a number, a label or
  // the written explanation can ever read it.
  const subjectConditionInput = parseSubjectConditionInput(subject_condition);
  if (subjectConditionInput.error) return validationError(res, subjectConditionInput.error);
  const subjectCondition = subjectConditionInput.value;
  // "Owner goal" (optional): which price inside the recommended range to suggest. Empty means Balanced.
  const ownerGoalInput = parseOwnerGoalInput(owner_goal);
  if (ownerGoalInput.error) return validationError(res, ownerGoalInput.error);
  const ownerGoal = ownerGoalInput.value;
  if (!run_by || typeof run_by !== 'string' || !UUID_RE.test(run_by)) {
    return validationError(res, 'run_by is required and must be a real users.id (UUID).');
  }
  if (property_id !== undefined && property_id !== null && property_id !== '' && !UUID_RE.test(property_id)) {
    return validationError(res, 'property_id must be a UUID, if provided.');
  }

  // ── Pre-flight existence checks ──────────────────────────────────────────
  try {
    const userRows = await select('users', `select=id&id=eq.${run_by}`);
    if (!userRows.length) return validationError(res, `No user found with id ${run_by}. run_by must be a real users.id.`);
  } catch (err) {
    console.error(`[${ts}] run_by lookup error:`, err.message);
    return res.status(500).json({ error: 'Failed to validate run_by.', detail: err.message });
  }

  let resolvedPropertyId = null;
  if (property_id) {
    try {
      const propRows = await select('properties', `select=id&id=eq.${property_id}`);
      if (!propRows.length) return validationError(res, `No property found with id ${property_id}.`);
      resolvedPropertyId = property_id;
    } catch (err) {
      console.error(`[${ts}] property_id lookup error:`, err.message);
      return res.status(500).json({ error: 'Failed to validate property_id.', detail: err.message });
    }
  }

  let activeSources;
  try {
    activeSources = await select('rental_comp_sources', 'select=id,name&is_active=eq.true');
  } catch (err) {
    console.error(`[${ts}] rental_comp_sources lookup error:`, err.message);
    return res.status(500).json({ error: 'Failed to load comp sources.', detail: err.message });
  }
  if (!activeSources.length) {
    return res.status(500).json({ error: 'No active comp sources are configured in rental_comp_sources.' });
  }

  // The subject as the comp search and the numbers see it. The last four
  // fields feed the size and MLS-fact rules (square footage within the size band, furnished,
  // month-to-month, 55+); lib/weighting.js applies them, one shared decision.
  const subject = {
    address: subject_address.trim(),
    propertyType: subject_property_type,
    bedrooms,
    bathrooms,
    sqft,
    furnished: isFurnished,
    leaseTermMonths,
    ageRestricted,
    ownerGoal,
  };

  // ── Create the analysis row ──────────────────────────────────────────────
  let analysis;
  try {
    const rows = await insert('rental_analyses', {
      subject_address: subject_address.trim(),
      subject_bedrooms: bedrooms,
      subject_bathrooms: bathrooms,
      subject_sqft: sqft,
      subject_property_type,
      subject_year_built: yearBuilt,
      lease_term_months: leaseTermMonths,
      furnished: isFurnished,
      subject_age_restricted: ageRestricted, // always true or false, never blank (the database does not accept a blank here)
      subject_subdivision: subjectSubdivision,
      subject_condition: subjectCondition, // one of the six grades, or null for "not seen / not sure"
      size_band_pct: sizeBandPctFor(subject_property_type, sqft), // 25, or null when the size rule does not apply to this property type
      owner_goal: ownerGoal,
      property_id: resolvedPropertyId,
      run_by,
      status: 'running',
    });
    analysis = rows[0];
  } catch (err) {
    console.error(`[${ts}] rental_analyses insert error:`, err.message);
    return res.status(500).json({ error: 'Failed to create analysis record.', detail: err.message });
  }

  console.log(`[${ts}] Analysis started: id=${analysis.id} address="${subject_address}" sources=${activeSources.map(s => s.name).join(',')}`);

  // ── Run the pipeline. Anything that throws from here on marks the row
  //    'failed' before responding, so it never sits at 'running' forever. ──
  try {
    const { comps: rawComps, subjectEstimatedRent, subjectLatitude, subjectLongitude, subjectZip, sourcesUsed, sourceErrors, sourceWarnings, sourcesSkipped } = await runActiveSources(
      activeSources,
      subject
    );

    // No comps at all. If any source broke (or none ran) we cannot say there are
    // no comparable homes, so the analysis FAILS. If every source that ran came
    // back fine with nothing, it is a finished report that says so, with no range
    // and no prices (Peter, 2026-10-17). See lib/outcome.js.
    const sourceOutcome = classifySourceResult({ comps: rawComps, sourcesUsed, sourceErrors, sourceWarnings });
    if (sourceOutcome.kind === 'failed') {
      await update('rental_analyses', `id=eq.${analysis.id}`, { status: 'failed' });
      console.error(`[${ts}] Analysis failed, no comps: id=${analysis.id} reason=${sourceOutcome.reason}`);
      return res.status(500).json({
        error: `Could not produce a recommendation for this address — ${sourceOutcome.reason}`,
        analysis_id: analysis.id,
      });
    }

    const properties = await select('properties', 'select=id,address,city,state,zip');
    if (!resolvedPropertyId) {
      const subjectMatch = findBestPropertyMatch(subject_address, properties);
      if (subjectMatch) resolvedPropertyId = subjectMatch.id;
    }

    // Everything between "the sources returned" and "save" (comp-to-property
    // matching, duplicate-unit collapse, recommended/raw range, the shared
    // per-comp "why doesn't this count" verdict) lives in lib/analyze.js —
    // the same file the standalone server.js and the accuracy test (backtest/)
    // call, so none of them can run different code. exclusionReasons is a
    // positional array, same order as compsWithMatch.
    const numbers = computeNumbers({
      comps: rawComps,
      subject,
      properties,
    });
    const { compsWithMatch, matchedCount, exclusionReasons } = numbers;
    if (compsWithMatch.length !== matchedCount) {
      console.log(`[${ts}] Deduped comps: id=${analysis.id} before=${matchedCount} after=${compsWithMatch.length}`);
    }

    let rationale = null;
    let narrativesByIndex = compsWithMatch.map(() => null);
    if (sourceOutcome.kind === 'none_found') {
      // Nothing comparable was found: a plain sentence says so, no AI call is needed.
      rationale = noCompsRationale(sourcesUsed, sourcesSkipped);
    } else {
      try {
        const result = await generateNarrative({
          subject: {
            address: subject_address.trim(),
            bedrooms, bathrooms, sqft,
            propertyType: subject_property_type,
            yearBuilt,
            leaseTermMonths,
            furnished: isFurnished,
          },
          // Each comp annotated with its exclusion_reason (or null) so
          // describeComp()/buildPrompt() (lib/narrative.js) can tell Claude
          // plainly which comps contributed zero weight. compsWithMatch
          // itself is untouched (spread, not mutated) since it still needs
          // to feed compRows below with only real DB columns.
          comps: compsWithMatch.map((c, i) => ({ ...c, exclusion_reason: exclusionReasons[i] })),
          // The write-up is told the recommended range, the suggested price, the stretch price (not on a
          // Low report) and the label, and NOTHING about the old wide computed range.
          headline: headlineForDisplay(numbers),
          confidence: numbers.confidence,
          subjectEstimatedRent,
          // Only the sources that actually supplied a comp are named in the write-up. A source that ran fine but
          // returned nothing (or was skipped) is not "where the comps came from".
          sourcesUsed: [...new Set(compsWithMatch.map(c => c.source_name).filter(Boolean))],
        });
        rationale = result.rationale;
        narrativesByIndex = result.narrativesByIndex;
      } catch (err) {
        console.error(`[${ts}] Narrative generation failed (numbers still saved): id=${analysis.id}`, err.message);
      }
    }

    // Every comp from every source becomes one row through the shared mapper
    // (lib/comp-rows.js), same as the standalone server.js: one place decides
    // what is saved, and every row carries every column.
    const compRows = buildCompRows(compsWithMatch, { analysisId: analysis.id, narratives: narrativesByIndex });

    // A finished "no comparable homes" report has no comps to save.
    const insertedComps = compRows.length ? await insert('rental_comps', compRows) : [];

    // rental_comps has no source_name column and dashboard/index.html is
    // plain browser JS with no way to require() lib/weighting.js's
    // exclusionReason() directly — see server.js's copy of this comment for
    // the full explanation. Same reason codes narrative.js's
    // EXCLUSION_LABELS keys off of.
    // property_type_source ('mls', 'unit_number' or 'label') is how the screen can say, beside a Rincon
    // lease that is not used, that the MLS lists it as a different kind of home. Like exclusion_reason it
    // is sent to the screen only; there is no column for it.
    const responseComps = insertedComps.map((row, i) => ({
      ...row,
      exclusion_reason: exclusionReasons[i],
      property_type_source: compsWithMatch[i].property_type_source || null,
    }));

    // ONE update marks the analysis complete and carries the whole outcome with it:
    // the recommended range, suggested and stretch prices, the label and the counts
    // (the database checks them against each other, and allows a finished report
    // with no numbers only when the count says fewer than 4 comps counted).
    const [updatedAnalysis] = await update('rental_analyses', `id=eq.${analysis.id}`, buildCompletionPatch({
      numbers,
      ownerGoal,
      propertyId: resolvedPropertyId,
      subjectEstimatedRent,
      subjectLatitude,
      subjectLongitude,
      subjectZip,
      rationale,
    }));

    console.log(`[${ts}] Analysis complete: id=${analysis.id} comps=${insertedComps.length} counted=${numbers.counted.total} range=${numbers.headline ? `${numbers.headline.low}-${numbers.headline.high}` : 'none'} confidence=${numbers.confidence ? numbers.confidence.label : 'none'}`);

    let marketData = null;
    if (subjectZip) {
      try {
        marketData = await getMarketData(subjectZip);
      } catch (err) {
        console.error(`[${ts}] Market data fetch failed (analysis still complete): id=${analysis.id} zip=${subjectZip}`, err.message);
      }
    }

    // The answer carries the recommended range, prices and label. It does NOT carry the old wide computed
    // range (recommended_rent_*, raw_comp_rent_*): those are saved for the audit trail only.
    // A source that did not fully come back (while others supplied comps) is said so on the screen, in plain words;
    // nothing is saved for it and the numbers are unchanged.
    // The answer also carries `ownerView` (the one-page owner view, built by lib/owner-view.js from this report's saved
    // data; nothing staff-only is in it) or, when it cannot be offered, null plus a plain reason in `ownerViewNote`.
    // Nothing about it is saved, and nothing here ever sends it anywhere: staff print it to PDF and email it themselves.
    return res.json(buildApiResponse({ analysis: updatedAnalysis, comps: responseComps, marketData, numbers, sourceNotes: buildSourceNotes({ sourceErrors, sourceWarnings }) }));
  } catch (err) {
    console.error(`[${ts}] Analysis pipeline error: id=${analysis.id}`, err.message);
    try {
      await update('rental_analyses', `id=eq.${analysis.id}`, { status: 'failed' });
    } catch (updateErr) {
      console.error(`[${ts}] Failed to mark analysis as failed: id=${analysis.id}`, updateErr.message);
    }
    return res.status(500).json({ error: err.message, analysis_id: analysis.id });
  }
});

module.exports = { router };
