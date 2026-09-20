#!/usr/bin/env node
/**
 * server.js
 * Express server for the Rincon Rental Analysis Tool.
 *
 * Endpoints:
 *   GET  /api/rental-analysis/property-lookup  — Look up bedrooms/bathrooms/
 *        sqft/property type/year built for one address, to pre-fill the form
 *   GET  /api/rental-analysis/address-suggest  — Live address autocomplete
 *        as the user types (text only — no bed/bath/sqft; see property-lookup
 *        above for that, once a full address is chosen)
 *   POST /api/rental-analysis/run  — Run a rent-comp analysis for one address
 *
 * Usage:
 *   node server.js
 *   node server.js --help
 *
 * Required environment variables (in .env):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   ANTHROPIC_API_KEY
 *
 * Also needed to actually pull comps (checked per-request, not at startup,
 * since more sources will be added later — see lib/sources.js):
 *   RENTCAST_API_KEY   — developers.rentcast.io, free tier: 50 requests/month.
 *                         NOTE: a lookup-then-run analysis now spends TWO of
 *                         those 50 requests, not one — property-lookup below
 *                         is a separate RentCast call from the comps pull
 *                         inside POST /run. See lib/rentcast.js for detail.
 *
 * Also needed for live address-suggest (checked per-request, not at startup
 * — degrades to "no suggestions" rather than affecting anything else, see
 * lib/google-places.js):
 *   GOOGLE_PLACES_API_KEY  — Google Cloud Console, Places API (New). Free
 *                         tier: 10,000 Autocomplete Requests/month.
 *                         Separate vendor and separate key from RentCast —
 *                         address-suggest never spends a RentCast request.
 *                         Also separate from this repo's unrelated
 *                         GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET (Gmail
 *                         OAuth in projects/hub) — different Google
 *                         product, different credential. Switched from
 *                         LocationIQ 2026-09-20 — LocationIQ couldn't
 *                         handle a bare house-number-plus-street query
 *                         with no city (confirmed live). lib/locationiq.js
 *                         itself is unchanged; its geocodeAddress() still
 *                         powers the LeadSimple lease sync.
 *
 * Also needed for the comp map's background tiles (checked per-request via
 * GET /api/rental-analysis/map-config, not at startup — degrades to a
 * blank/gray map instead of affecting anything else):
 *   MAPTILER_API_KEY    — maptiler.com, free tier: 100,000 tile loads/month.
 *                         Unlike every other key above, this one is read by
 *                         the BROWSER, not just this server: the dashboard
 *                         fetches it from GET /api/rental-analysis/map-config
 *                         at page load and builds the MapTiler tile URL
 *                         client-side, because map tiles are images the
 *                         browser requests directly from MapTiler, not
 *                         something this server can proxy without adding a
 *                         real tile-proxying endpoint. MapTiler keys are
 *                         designed to be used this way (protected by
 *                         domain restriction in the MapTiler dashboard, not
 *                         by secrecy) — see MapTiler's own docs.
 *                         Replaces OpenStreetMap's tile servers
 *                         (*.tile.openstreetmap.org), which started
 *                         returning "Access blocked" under real usage —
 *                         confirmed live via curl, 2026-09-20. OSM's own
 *                         tile-usage policy
 *                         (operations.osmfoundation.org/policies/tiles/)
 *                         says those servers are for casual/personal use
 *                         only, not a real application's traffic.
 *
 * Optional:
 *   RENTAL_ANALYSIS_PORT  (default: 3457)
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

if (process.argv.includes('--help')) {
  console.log(`
server.js — Rincon Rental Analysis Tool server

GET /api/rental-analysis/property-lookup?address=...
  Looks up bedrooms/bathrooms/sqft/property type/year built for one address
  from RentCast, so the form can pre-fill them for you to confirm/correct
  instead of typing from scratch. Read-only — creates no records, runs no
  analysis. Returns 404 (not a server error) if RentCast has no record for
  the address — that's normal; just fall back to typing it in by hand.
  Spends a second RentCast request beyond the one POST /run already uses.

GET /api/rental-analysis/address-suggest?q=...
  Live address autocomplete as you type, via Google Places Autocomplete
  (New) — a different vendor from RentCast above, so this never spends a
  RentCast request. Always returns a JSON array, empty if the query is too
  short (under 3 characters), Google has no key configured, or Google
  errors/is down — this endpoint never fails the page, it just means no
  suggestions right now.

POST /api/rental-analysis/run
  JSON body:
    subject_address        (string, required)
    subject_bedrooms       (number, required)
    subject_bathrooms      (number, required)
    subject_sqft           (number, required)
    subject_property_type  (string, required — one of: single_family, condo,
                             townhouse, duplex, triplex, fourplex, apartment,
                             manufactured, other)
    subject_year_built     (number, optional)
    lease_term_months      (number, required)
    furnished              (boolean, optional — default false)
    run_by                 (string UUID, required — a real users.id)
    property_id            (string UUID, optional — only if you already know
                             this address matches an existing Rincon property)

  Pulls comps from every active row in rental_comp_sources (today: RentCast
  only — FlexMLS is seeded but pending real access, and Zillow has no
  buildable API and won't be added), computes a weighted recommended rent
  range, writes an AI-generated rationale and per-comp narrative, and
  returns the full analysis + its comps + zip-level market data as JSON:
  { analysis, comps, marketData }.

  marketData is the subject zip's cached RentCast market stats (median/
  average rent, rent per sqft, days on market, month-by-month history) —
  reused across every analysis in the same zip for up to
  lib/market-data.js's FRESHNESS_WINDOW_DAYS (7 days) rather than re-fetched
  every time. null if the subject's zip couldn't be determined, RentCast has
  no coverage for it, or the market-data fetch failed — never fails the
  analysis itself (see lib/market-data.js).

  Runs synchronously — the response IS the finished analysis. Returns
  quickly today (one source, one API call); see rental_analyses.status if
  this ever needs to become async once more/slower sources are added.

Environment variables required (.env file):
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  ANTHROPIC_API_KEY
  RENTAL_ANALYSIS_PORT   (optional, default 3457)
  RENTCAST_API_KEY       (needed to actually pull comps — see above)
  GOOGLE_PLACES_API_KEY  (needed for address-suggest — see above)
  MAPTILER_API_KEY       (needed for the comp map's background tiles — see above)
`);
  process.exit(0);
}

const express = require('express');
const path = require('path');
const { select, insert, update } = require('./lib/supabase');
const { runActiveSources } = require('./lib/sources');
const { lookupPropertyDetails } = require('./lib/rentcast');
const { getMarketData } = require('./lib/market-data');
const { suggestAddresses } = require('./lib/google-places');
const { findBestPropertyMatch, hasParseableHouseNumber, dedupeComps } = require('./lib/property-matching');
const { computeRecommendedRange, computeRawRange, isExcludedRinconManaged } = require('./lib/weighting');
const { generateNarrative } = require('./lib/narrative');
const { PROPERTY_TYPES } = require('./lib/constants');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.RENTAL_ANALYSIS_PORT || 3457;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const missing = [];
if (!process.env.SUPABASE_URL)              missing.push('SUPABASE_URL');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
if (!process.env.ANTHROPIC_API_KEY)         missing.push('ANTHROPIC_API_KEY');

if (missing.length > 0) {
  console.error(`[ERROR] Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

// RENTCAST_API_KEY is not a startup requirement — it's checked per-request
// inside lib/rentcast.js the moment the RentCast source handler actually
// runs, and only that source's comps are affected, not the whole server.
// This matters because more sources (each with their own key, or none)
// will be added to the same loop later — see lib/sources.js.
if (!process.env.RENTCAST_API_KEY) {
  console.warn('[rental-analysis] RENTCAST_API_KEY not set — analyses will fail until it is added to .env (developers.rentcast.io, free tier).');
}

// Same non-startup-blocking treatment as RENTCAST_API_KEY above — a missing
// key just means the address-suggest endpoint returns no suggestions
// (see lib/google-places.js), not a broken server.
if (!process.env.GOOGLE_PLACES_API_KEY) {
  console.warn('[rental-analysis] GOOGLE_PLACES_API_KEY not set — address-suggest will return no suggestions until it is added to .env (Google Cloud Console, Places API (New), free tier).');
}

// Same non-startup-blocking treatment — a missing key just means the comp
// map's GET /api/rental-analysis/map-config returns a null tileKey and the
// dashboard renders the map without background tiles (see that route and
// dashboard/index.html's initMap()), not a broken server.
if (!process.env.MAPTILER_API_KEY) {
  console.warn('[rental-analysis] MAPTILER_API_KEY not set — the comp map will render without background tiles until it is added to .env (maptiler.com, free tier).');
}

// ─── App ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '5mb' }));

// Serve the dashboard from the same origin as the API. Not strictly required
// for local single-user use (the page also works opened directly as a file —
// same convention as projects/insurance-compliance/dashboard), but same-origin
// avoids any cross-origin fetch friction and is what an eventual real
// deployment (one URL, everyone on the team) would need anyway.
app.use(express.static(path.join(__dirname, 'dashboard')));

// CORS — locked to a fixed allowlist (Scotty, 2026-09-19, deploy to Sally).
// This used to reflect ANY request origin back in the Allow-Origin header —
// fine while the only way to reach this server was localhost on Peter's own
// machine, but once this is reachable over the real network, reflecting any
// origin means literally any website that gets someone to load it in their
// browser could call this API cross-site. Flagged by Judge at first ship as
// an accepted risk specifically for local-only use, to be fixed before any
// real deployment — this is that fix.
//
// In production the dashboard is served same-origin (nginx serves
// dashboard/ and proxies /api/rental-analysis/ on the same host — see
// deploy-to-sally.sh and dashboard/index.html's API_BASE), so the browser
// never even sends a cross-origin request for the normal flow. This
// allowlist exists as defense-in-depth (a same-site request never carries
// an Origin header that needs checking) and to keep local development
// working (running the dashboard/API on localhost:3457 like before).
// Add an origin here only for a real, known caller — never widen this back
// to reflecting/allow-all.
const ALLOWED_ORIGINS = [
  'https://srv1784739.hstgr.cloud',  // Sally, production — see nginx site "calendar-assistant"
  'https://2.25.70.7',               // Sally by bare IP (same nginx server_name)
  'http://localhost:3457',           // local dev (dashboard + API on the same machine)
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function validationError(res, message) {
  return res.status(400).json({ error: message });
}

// ─── GET /api/rental-analysis/map-config ─────────────────────────────────────
// Hands the dashboard's comp map the one thing it needs to build its own
// MapTiler tile URL client-side: the key. Every OTHER external key this
// server holds (RentCast, LocationIQ) is used only server-side, behind a
// proxying endpoint that does the actual third-party call — this one is
// different because map tiles are images the BROWSER requests directly from
// MapTiler for every pan/zoom, so there's no reasonable way to proxy them
// through this server without building real tile-proxying (fetching and
// streaming each {z}/{x}/{y}.png). MapTiler keys are meant to be used this
// way — see maptiler.com's own docs — protected by domain restriction in
// the MapTiler account dashboard, not by being kept secret. tileKey is null
// (not an error) when MAPTILER_API_KEY isn't set — dashboard/index.html's
// initMap() treats that as "render the map without tiles," same graceful
// degradation as a missing GOOGLE_PLACES_API_KEY above.
app.get('/api/rental-analysis/map-config', (req, res) => {
  return res.json({ tileKey: process.env.MAPTILER_API_KEY || null });
});

// ─── GET /api/rental-analysis/users ──────────────────────────────────────────
// Read-only list of users, for the frontend's "Run by" dropdown — there's no
// login system for this tool, so the person running an analysis is picked
// from a list instead of coming from a session.
app.get('/api/rental-analysis/users', async (req, res) => {
  try {
    const users = await select('users', 'select=id,name&order=name.asc');
    return res.json(users);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] users lookup error:`, err.message);
    return res.status(500).json({ error: 'Failed to load users.', detail: err.message });
  }
});

// ─── GET /api/rental-analysis/property-lookup ────────────────────────────────
// Looks up bedrooms/bathrooms/sqft/property type/year built for one address
// from RentCast's Property Records endpoint, so the "run analysis" form can
// pre-fill those fields for Peter to confirm/correct instead of typing them
// from scratch. Read-only — writes nothing to the database and runs no
// analysis; the frontend just uses the response to pre-fill its POST /run
// request body, which is otherwise unchanged.
//
// BUDGET NOTE: this spends a SECOND RentCast request per analysis when the
// frontend calls it ahead of the real run — one request here (property
// lookup), one more inside POST /run (pullRentCastComps, the actual comps
// pull). RentCast's free tier is 50 requests/month total, so a
// lookup-then-run analysis now costs 2 of those 50, not 1. See the
// RENTCAST_API_KEY note at the top of this file and lib/rentcast.js's
// lookupPropertyDetails() doc comment.
app.get('/api/rental-analysis/property-lookup', async (req, res) => {
  const ts = new Date().toISOString();
  const address = typeof req.query.address === 'string' ? req.query.address.trim() : '';

  if (!address) {
    return validationError(res, 'address is required.');
  }
  // Same reasoning as POST /run below: don't spend a RentCast request on an
  // address that's obviously incomplete.
  if (!hasParseableHouseNumber(address)) {
    return validationError(res, 'address must include a street number (e.g. "123 Main St, Ventura, CA") — please include a street number so the lookup can trust the result.');
  }

  try {
    const details = await lookupPropertyDetails(address);
    if (!details) {
      // Not a server error — RentCast simply has no record for this
      // address. Expected and normal; manual entry is the fallback.
      return res.status(404).json({ error: 'No property record found for this address. Please enter the details manually.' });
    }
    return res.json(details);
  } catch (err) {
    console.error(`[${ts}] property-lookup error:`, err.message);
    return res.status(500).json({ error: 'Failed to look up property details.', detail: err.message });
  }
});

// ─── GET /api/rental-analysis/address-suggest ────────────────────────────────
// Live address autocomplete for the "run analysis" form's address field, via
// Google Places Autocomplete (New) — a different vendor from RentCast (see
// lib/google-places.js for why Google specifically, replacing LocationIQ).
// Completely separate concern from property-lookup above: this only
// completes address TEXT as the user types — it has no idea about
// bedrooms/bathrooms/sqft, and never touches RentCast or spends one of its
// 50 free monthly requests.
//
// Always responds 200 with a JSON array, never an error — an empty array
// means "too short to search," "no key configured," or "Google errored/is
// down," and the frontend's fallback in every case is the same: let the
// user keep typing manually. See lib/google-places.js's suggestAddresses().
app.get('/api/rental-analysis/address-suggest', async (req, res) => {
  const ts = new Date().toISOString();
  const q = typeof req.query.q === 'string' ? req.query.q : '';

  try {
    const suggestions = await suggestAddresses(q);
    return res.json(suggestions);
  } catch (err) {
    // suggestAddresses() only throws today for a missing GOOGLE_PLACES_API_KEY
    // (a real setup problem worth logging) — still degrades to "no
    // suggestions" here rather than breaking the form, per spec.
    console.error(`[${ts}] address-suggest error:`, err.message);
    return res.json([]);
  }
});

// ─── POST /api/rental-analysis/run ───────────────────────────────────────────
app.post('/api/rental-analysis/run', async (req, res) => {
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
  // Judge found "Maple St, Santa Paula, CA" (no house number at all) still
  // returned a full, confident result — RentCast geocoded it to *somewhere*
  // on that street rather than refusing. Reject addresses with no
  // parseable street number here, before a single DB lookup or RentCast
  // call happens, rather than letting RentCast guess and paying for the
  // call (RentCast's free tier is 50 requests/month).
  if (!hasParseableHouseNumber(subject_address)) {
    return validationError(res, 'subject_address must include a street number (e.g. "123 Main St, Ventura, CA") — please include a street number so the analysis can trust the result.');
  }
  // subject_bedrooms, subject_sqft, subject_year_built, and lease_term_months
  // are all INTEGER columns in the schema (subject_bathrooms is the odd one
  // out — NUMERIC(3,1), since fractional bathrooms like 2.5 are normal) —
  // reject non-whole numbers here with a clear message instead of letting
  // Postgres reject (or silently truncate) a fractional value later.
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
  // Checked before any RentCast call — a bad run_by/property_id would fail
  // at the final insert anyway, but only after already spending one of
  // RentCast's 50 free requests/month. Cheap to check first.
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

    // Best-effort address matching against `properties` — one fetch, reused
    // for the subject and every comp (same batch-fetch-then-match shape as
    // insurance-compliance's batch upload).
    const properties = await select('properties', 'select=id,address,city,state,zip');
    if (!resolvedPropertyId) {
      const subjectMatch = findBestPropertyMatch(subject_address, properties);
      if (subjectMatch) resolvedPropertyId = subjectMatch.id;
    }
    const matchedComps = rawComps.map(c => {
      const match = findBestPropertyMatch(c.address, properties);
      return { ...c, comp_property_id: match ? match.id : null, is_rincon_managed: !!match };
    });
    // Collapse the same real unit reported twice (e.g. RentCast inferring
    // 'off_market' on a unit CRMLS separately confirms as 'leased') into one
    // comp before anything downstream counts or ranges them — see
    // dedupeComps() in lib/property-matching.js. Reassigning compsWithMatch
    // (rather than introducing a new name) means every existing downstream
    // use below — recommended/raw range math, narrative, the DB insert —
    // automatically runs on the deduped list with no further changes.
    const compsWithMatch = dedupeComps(matchedComps);
    if (compsWithMatch.length !== matchedComps.length) {
      console.log(`[${ts}] Deduped comps: id=${analysis.id} before=${matchedComps.length} after=${compsWithMatch.length}`);
    }

    // Numbers first — the narrative step below only explains these, never
    // computes or overrides them.
    const recommended = computeRecommendedRange(compsWithMatch, bedrooms, subject_property_type);
    const raw = computeRawRange(compsWithMatch, bedrooms, subject_property_type);

    // Rationale + per-comp narrative text. Non-fatal on failure — the
    // numbers above already stand on their own, and rationale/narrative
    // are nullable by design for exactly this case (see migration notes).
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

    // One insert per comp, narrative already attached — avoids a wasteful
    // insert-then-update round trip.
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

    // rental_comps has no source_name column (source_name only exists in
    // memory, on compsWithMatch — see lib/sources.js's runActiveSources()
    // comment on why it's kept there and stripped before insert), and
    // dashboard/index.html is plain browser JS with no way to require()
    // lib/weighting.js's isExcludedRinconManaged() directly. So the
    // authoritative "is this comp internal-reference-only / not counted"
    // verdict is computed here, once, using the one shared helper, and
    // attached to the JSON response only (never persisted) — the dashboard
    // just renders this boolean instead of re-deriving the trusted-source
    // logic itself, so that logic can never drift out of sync across files.
    // Positional match against compsWithMatch, same assumption
    // narrativesByIndex[i] above already relies on (compRows was built by
    // mapping compsWithMatch in this exact order).
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

    // Zip-code-level market context (median/average rent, trend history) for
    // the report's area-context section — cached per zip, see
    // lib/market-data.js. Non-fatal by design, same graceful-degradation
    // philosophy as narrative generation above: the analysis is already
    // complete and saved by this point, so a RentCast market-data outage or
    // a zip with no coverage must never fail an otherwise-finished analysis.
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

// ─── Start ────────────────────────────────────────────────────────────────────
// Bound to 127.0.0.1, not all interfaces — matches projects/hub/server.js's
// convention. This process is only ever meant to be reached through Sally's
// nginx (which terminates TLS and proxies /api/rental-analysis/ to this
// port), never directly from the network. (Scotty, 2026-09-19 deploy.)
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[${new Date().toISOString()}] Rental analysis server running on port ${PORT}`);
});
