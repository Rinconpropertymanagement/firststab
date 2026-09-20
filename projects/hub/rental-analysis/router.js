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
const { findBestPropertyMatch, hasParseableHouseNumber, dedupeComps } = require('./lib/property-matching');
const { computeRecommendedRange, computeRawRange, isExcludedRinconManaged } = require('./lib/weighting');
const { generateNarrative } = require('./lib/narrative');
const { PROPERTY_TYPES } = require('./lib/constants');
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
  const {
    subject_address,
    subject_bedrooms,
    subject_bathrooms,
    subject_sqft,
    subject_property_type,
    subject_year_built,
    lease_term_months,
    furnished,
    run_by,
    property_id,
  } = body;

  // ── Validation ──────────────────────────────────────────────────────────
  if (!subject_address || typeof subject_address !== 'string' || !subject_address.trim()) {
    return validationError(res, 'subject_address is required.');
  }
  if (!hasParseableHouseNumber(subject_address)) {
    return validationError(res, 'subject_address must include a street number (e.g. "123 Main St, Ventura, CA") — please include a street number so the analysis can trust the result.');
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
  const isFurnished = !!furnished;
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
    const { comps: rawComps, subjectEstimatedRent, subjectLatitude, subjectLongitude, subjectZip, sourcesUsed, sourceErrors } = await runActiveSources(
      activeSources,
      { address: subject_address.trim(), propertyType: subject_property_type, bedrooms, bathrooms, sqft }
    );

    if (!rawComps.length) {
      const reason = sourceErrors.length
        ? sourceErrors.map(e => `${e.name}: ${e.error}`).join(' | ')
        : 'No comps were returned by any active source.';
      await update('rental_analyses', `id=eq.${analysis.id}`, { status: 'failed' });
      console.error(`[${ts}] Analysis failed, no comps: id=${analysis.id} reason=${reason}`);
      return res.status(500).json({
        error: `Could not produce a recommendation for this address — ${reason}`,
        analysis_id: analysis.id,
      });
    }

    const properties = await select('properties', 'select=id,address,city,state,zip');
    if (!resolvedPropertyId) {
      const subjectMatch = findBestPropertyMatch(subject_address, properties);
      if (subjectMatch) resolvedPropertyId = subjectMatch.id;
    }
    const matchedComps = rawComps.map(c => {
      const match = findBestPropertyMatch(c.address, properties);
      return { ...c, comp_property_id: match ? match.id : null, is_rincon_managed: !!match };
    });
    const compsWithMatch = dedupeComps(matchedComps);
    if (compsWithMatch.length !== matchedComps.length) {
      console.log(`[${ts}] Deduped comps: id=${analysis.id} before=${matchedComps.length} after=${compsWithMatch.length}`);
    }

    const recommended = computeRecommendedRange(compsWithMatch, bedrooms, subject_property_type);
    const raw = computeRawRange(compsWithMatch, bedrooms, subject_property_type);

    let rationale = null;
    let narrativesByIndex = compsWithMatch.map(() => null);
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
        comps: compsWithMatch,
        recommended,
        raw,
        subjectEstimatedRent,
        sourcesUsed,
      });
      rationale = result.rationale;
      narrativesByIndex = result.narrativesByIndex;
    } catch (err) {
      console.error(`[${ts}] Narrative generation failed (numbers still saved): id=${analysis.id}`, err.message);
    }

    const compRows = compsWithMatch.map((c, i) => ({
      analysis_id: analysis.id,
      source_id: c.source_id,
      address: c.address,
      property_type: c.property_type,
      bedrooms: c.bedrooms,
      bathrooms: c.bathrooms,
      sqft: c.sqft,
      distance_miles: c.distance_miles,
      latitude: c.latitude,
      longitude: c.longitude,
      monthly_rent: c.monthly_rent,
      is_estimated_price: c.is_estimated_price,
      original_price: c.original_price,
      had_price_cut: c.had_price_cut,
      listing_status: c.listing_status,
      days_on_market: c.days_on_market,
      listed_date: c.listed_date,
      leased_date: c.leased_date,
      is_rincon_managed: c.is_rincon_managed,
      comp_property_id: c.comp_property_id,
      narrative: narrativesByIndex[i],
    }));

    const insertedComps = await insert('rental_comps', compRows);

    const responseComps = insertedComps.map((row, i) => ({
      ...row,
      is_excluded_rincon_managed: isExcludedRinconManaged(compsWithMatch[i]),
    }));

    const [updatedAnalysis] = await update('rental_analyses', `id=eq.${analysis.id}`, {
      status: 'complete',
      property_id: resolvedPropertyId,
      recommended_rent_low: recommended.low,
      recommended_rent_mid: recommended.mid,
      recommended_rent_high: recommended.high,
      subject_estimated_rent: subjectEstimatedRent,
      subject_latitude: subjectLatitude,
      subject_longitude: subjectLongitude,
      subject_zip: subjectZip,
      raw_comp_rent_low: raw.low,
      raw_comp_rent_high: raw.high,
      rationale,
    });

    console.log(`[${ts}] Analysis complete: id=${analysis.id} comps=${insertedComps.length} recommended=${recommended.low}-${recommended.high}`);

    let marketData = null;
    if (subjectZip) {
      try {
        marketData = await getMarketData(subjectZip);
      } catch (err) {
        console.error(`[${ts}] Market data fetch failed (analysis still complete): id=${analysis.id} zip=${subjectZip}`, err.message);
      }
    }

    return res.json({ analysis: updatedAnalysis, comps: responseComps, marketData });
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
