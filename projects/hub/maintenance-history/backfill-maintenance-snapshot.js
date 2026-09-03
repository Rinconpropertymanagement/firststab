#!/usr/bin/env node
/**
 * backfill-maintenance-snapshot.js
 *
 * One-time (re-runnable) backfill for Property 360's "multi-year maintenance
 * snapshot" — property-360-SPEC.md, "Multi-year maintenance snapshot — added
 * 2026-09-03, live-researched." Pulls AppFolio's `bill_detail` report going
 * up to 5 years back, filters to the maintenance-relevant subset (a
 * populated `work_order_id`), matches each row to one of Rincon's
 * currently-active properties, builds a short one-line summary, runs the
 * two-layer protected-class content check, and upserts into
 * `maintenance_snapshot_events` (migration
 * supabase/migrations/20260903000000_maintenance_snapshot_events.sql).
 *
 * STATUS (updated 2026-09-03, governance fix build): Peter has applied the
 * migration — `maintenance_snapshot_events` is live in production, not
 * pending. Two real things have happened against it since:
 *   (a) An earlier test run (before this build's Layer 2 governance fix
 *       existed) wrote 69 real rows directly to production. None of those
 *       69 rows are flagged (flagged_protected_class = false on all of
 *       them) — expected, since Layer 2 didn't exist yet to catch anything
 *       Layer 1 alone missed.
 *   (b) A later 90-day, 911-row test run — the one that found 3 real
 *       Layer 2 catches this build's governance fix was written to
 *       surface to a human reviewer — was `--dry-run`. Nothing from that
 *       run is in the table: its own logged summary reported
 *       "rows_upserted": 0. Those 3 flagged rows exist only in that run's
 *       console output, not in the database.
 *   (c) As part of this same governance-fix build, a small, real
 *       (non-dry-run), 45-day window (`--since-days 45`) was run to seed
 *       real flagged rows for testing the new merged flagged-review queue
 *       end-to-end — see GET /api/maintenance-history/flagged-queue in
 *       router.js and the build report for the real counts and review
 *       verification. Idempotent with (a) via UNIQUE(source,
 *       source_reference): re-running this window only ever upserts, never
 *       duplicates, the 69 rows (a) already wrote.
 * The full 5-year backfill (`--since-days` at its default) is still
 * explicitly NOT approved and NOT this script's call to trigger on its
 * own — see the build report.
 *
 * ============================================================
 * LIVE VERIFICATION DONE FOR THIS BUILD (2026-09-03), full 5-year pull
 * against Rincon's real AppFolio account, re-verifying the migration's own
 * assumptions before writing this script, per its explicit instruction to
 * do so ("confirm the exact stable field live against the Reports API
 * response before writing the insert code" / "Verify live... does every
 * maintenance-relevant bill_detail row actually have a non-null paid
 * value?"). Two real corrections to what the migration assumed, and three
 * confirmations:
 *
 * 1. CORRECTION — `occurred_on_from`/`occurred_on_to` ARE honored. Pulling
 *    with a 5-year window returned bill_date values from exactly
 *    2021-09-03 (5 years before the pull date) through 2026-09-03 (today)
 *    — not the account's full history. Confirms the migration's own
 *    live-research note that a past build's belief ("AppFolio ignores
 *    historical date params") was itself wrong.
 *
 * 2. CORRECTION — `work_order_id` is populated on 17.00% of bill_detail
 *    rows (11,483 of 67,537 across a full 5-year pull, 14 pages), not the
 *    ~13% figure carried over from an earlier live check. Real, current
 *    number — used nowhere in this script's logic (the filter is just
 *    "populated or not"), but worth recording since it was re-confirmed,
 *    not assumed.
 *
 * 3. REAL CORRECTION, LOAD-BEARING — `work_order_issue` is NEVER populated
 *    on this account: 0 of 11,483 real work-order-id rows had any value in
 *    it. The migration's own column comments describe `work_order_issue`
 *    as the human-written source text the content check exists to screen
 *    ("the risk lives in AppFolio's own human-written work_order_issue
 *    text"). That text actually lives in `description` instead — confirmed
 *    present on 11,436/11,483 (99.6%) of work-order rows, with real
 *    human-written content ("Rekey", "Rodent Trapout.", "Service Call -
 *    Inspection Photos Report."). This script reads `description`
 *    everywhere the migration's comments describe reading
 *    `work_order_issue` — both as the raw text fed through the content
 *    check, and as the human-written component of the one-line summary.
 *    Flagged here, in the code below, and in the build report — not
 *    silently substituted. `account_name` is the fallback for the 47 rows
 *    (0.4%) with no `description` at all.
 *
 * 4. CONFIRMED — `payable_invoice_detail_id` is present on 100% of
 *    work-order rows and fully unique per row (11,483 distinct values
 *    across 11,483 rows). This is the real, verified-unique
 *    `source_reference` key the migration asked for — NOT `work_order_id`
 *    alone (a single work order can have more than one bill line: 142
 *    real examples found live) and NOT `txn_id` (14 collisions found in a
 *    40,000-row sample, so not reliably unique either).
 *
 * 5. CONFIRMED — `paid` (the amount) was present and non-null on 100% of
 *    the 11,483 real work-order rows checked, and none were negative.
 *    Supports the migration's NOT NULL assumption on live data — this
 *    script still treats a missing amount as a per-row, flagged error
 *    rather than assuming that holds forever (see "AMOUNT/VENDOR
 *    VALIDATION" below).
 *
 * 6. CONFIRMED — `property_id` on bill_detail matches Rincon's own
 *    `properties.appfolio_id` directly (the same field
 *    projects/appfolio-sync/sync.js's `property_directory` entry already
 *    writes there as `String(row.property_id)`) — no fuzzy/address-based
 *    matching needed, unlike LeadSimple's own property matching
 *    (sync-property-stages.js), which has no shared ID at all. Live-tested
 *    2026-09-03: 100% of real work-order rows (11,483/11,483) matched a
 *    row in Rincon's own `properties` table this way.
 *
 * ============================================================
 * WHY "ACTIVE PROPERTIES ONLY" NEEDS NO SEPARATE FLAG
 * ============================================================
 * `properties` has no is_active/status column of its own (confirmed
 * against supabase/migrations/20260626000000_initial_schema.sql — the only
 * `status` column in that migration belongs to `units`, not `properties`).
 * property_directory's nightly sync (sync.js) only ever upserts properties
 * AppFolio currently manages and never soft-deletes a row that stops
 * appearing. So "does this AppFolio property_id resolve to a row in Hub's
 * own properties table" already IS the active-properties filter
 * property-360-SPEC.md describes ("AppFolio via matching against the Hub's
 * own properties table") — nothing else to check.
 *
 * ============================================================
 * DETERMINISTIC SUMMARY, NOT AI-PARAPHRASED — AND WHY
 * ============================================================
 * The task brief left the summary construction method (deterministic vs.
 * AI-paraphrased) to Q, same as the migration's own "No AI paraphrase vs.
 * deterministic-template decision" note. This script builds the summary
 * deterministically — plain string assembly from `description`, the event
 * date, the amount, and `payee_name` — for two reasons:
 *   1. The raw fields read cleanly as a sentence on their own (see the
 *      live samples above: "Rekey — 2024-06-30, $103.00, Able Lock and
 *      Key") — an AI paraphrase wouldn't add real clarity here the way it
 *      does for a multi-paragraph Latchel ticket narrative.
 *   2. Cost/latency: a full 5-year backfill touches ~11,500 real
 *      maintenance-relevant rows today (and grows on every incremental
 *      re-run). One AI call per row would be a real, avoidable expense and
 *      a materially slower backfill for a task that reads fine without it.
 * `extracted_by` is therefore always `'system'` for every row this script
 * writes — never a model version string.
 *
 * ============================================================
 * THE TWO-LAYER CONTENT CHECK — WHAT ACTUALLY RUNS, AND WHY
 * ============================================================
 * Layer 1 (lib/protected-class-terms.js's keyword/phrase scan, via
 * lib/content-check.js's checkClaim()) runs on every row, unconditionally
 * — on BOTH the assembled `summary` text AND the raw `description` text
 * (see correction #3 above for why `description`, not `work_order_issue`),
 * exactly as the migration requires ("MUST run on the final summary text
 * before insert, no exceptions... This applies on the deterministic path
 * too"). This is the exact same `contentCheck.checkClaim(candidate)` call
 * maintenance-history/router.js's own Latchel ingest already uses for
 * maintenance_claims (see that file's ingest route) — reused here, not
 * reimplemented.
 *
 * GOVERNANCE FIX (Asimov, 2026-09-03): this script originally skipped
 * Layer 2 entirely, reasoning that Layer 2 in this codebase only ever
 * exists as a free byproduct of an AI generation call, and this path has
 * none. Asimov's verdict: that's not a valid reason to skip it — the
 * migration's own comment says the two-layer check applies "on the
 * deterministic path too," and the risk lives in the source text
 * (AppFolio's real `description` field), not in how the summary line gets
 * assembled. Fixed below: runLayer2Check() makes ONE cheap, classification-
 * only Claude Haiku call per row (LAYER2_MODEL) — NOT a paraphrase/
 * generation step, which is exactly the AI cost/latency this script's
 * deterministic-summary choice was made to avoid at ~11,500-row scale (see
 * "DETERMINISTIC SUMMARY" above). It runs on the same raw `description`
 * text (falling back to `summaryText` when `description` is empty — the
 * same fallback Layer 1's own raw-text check already used) that carries
 * the actual human-written risk, using the identical protected-class
 * category list and framing extract-claims.js's own Layer 2 self-check
 * uses (EXTRACTION_PROMPT_HEADER in lib/extract-claims.js), so both
 * pipelines flag the same things the same way. The result is fed into
 * contentCheck.checkClaim()'s existing modelFlag/modelCategory inputs —
 * the exact same merge interface extract-claims.js already uses — not a
 * new content-check architecture.
 *
 * ============================================================
 * SOURCE_REFERENCE / IDEMPOTENCY
 * ============================================================
 * `source_reference` = "AppFolio bill_detail row <payable_invoice_detail_id>,
 * work_order <work_order_id>" — a structural pointer (never a summary with
 * the source stripped off, per the migration's own column comment),
 * carrying BOTH the real unique-per-row id (see correction #4 above) and
 * the work_order_id for future cross-referencing against
 * maintenance_requests/maintenance_claims, matching the migration
 * comment's own example format. `UNIQUE(source, source_reference)` makes
 * every write below a plain upsert (onConflict: 'source,source_reference')
 * — safe to re-run this whole script (e.g. a later incremental top-up with
 * an overlapping --since-days window) without duplicating rows.
 *
 * ============================================================
 * AMOUNT/VENDOR VALIDATION — PER-ROW, NOT PORTFOLIO-WIDE TRUST
 * ============================================================
 * `amount` and `vendor_name` are both NOT NULL on the table. Live data
 * confirmed (see #5 above) that every real work-order row today has both —
 * but this script does not lean on that holding forever. A row with no
 * usable `paid` value or no `payee_name` is skipped, counted separately in
 * the run summary, and reported with its `payable_invoice_detail_id` so it
 * can be investigated — never defaulted to 0 or a placeholder vendor name,
 * and never allowed to crash the rest of the run (see per-row try/catch
 * below, same isolation convention as maintenance-history/router.js's own
 * Latchel ingest and projects/appfolio-sync/sync.js's own per-row upsert
 * fallback).
 *
 * Usage:
 *   node backfill-maintenance-snapshot.js                    Pull the last 1825 days (~5 years, default), filter to maintenance-relevant rows for active properties, upsert into maintenance_snapshot_events
 *   node backfill-maintenance-snapshot.js --since-days 3650   Widen the window (e.g. a 10-year pull)
 *   node backfill-maintenance-snapshot.js --dry-run           Pull, match, build summaries, and run the full two-layer content check (Layer 1 + Layer 2, one Haiku call per row); log what would be inserted — no Supabase writes
 *   node backfill-maintenance-snapshot.js --recheck-existing  Re-run Layer 2 against rows already written to maintenance_snapshot_events (from before this fix existed) and flag anything Layer 1 alone missed — no AppFolio pull, no new rows inserted
 *   node backfill-maintenance-snapshot.js --help              Show this help and exit
 *
 * Standalone script, invoked directly (`node backfill-maintenance-snapshot.js`),
 * same house convention as projects/appfolio-sync/sync.js and
 * leadsimple-property-brain/sync-property-stages.js — not an HTTP endpoint.
 */

const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const contentCheck = require('./lib/content-check');

const AF_CLIENT_ID = process.env.APPFOLIO_CLIENT_ID;
const AF_CLIENT_SECRET = process.env.APPFOLIO_CLIENT_SECRET;
const AF_HOST = 'rinconpm.appfolio.com';

const TABLE = 'maintenance_snapshot_events';

// property-360-SPEC.md: "going back up to 5 years." 5 * 365 = 1825 — a
// plain constant, not a researched number, same "easy to change here since
// it lives in code" reasoning maintenance-history/router.js's own
// RECENT_MONTHS constant documents.
const DEFAULT_SINCE_DAYS = 5 * 365;

function printHelp() {
  console.log(`
Usage:
  node backfill-maintenance-snapshot.js                    Pull the last ${DEFAULT_SINCE_DAYS} days (~5 years, default), filter to maintenance-relevant rows for active properties, upsert into maintenance_snapshot_events
  node backfill-maintenance-snapshot.js --since-days 3650   Widen the window (e.g. a 10-year pull)
  node backfill-maintenance-snapshot.js --dry-run           Pull, match, build summaries, and run the full two-layer content check (Layer 1 + Layer 2); log what would be inserted — no Supabase writes
  node backfill-maintenance-snapshot.js --recheck-existing  Re-run Layer 2 against rows already written to maintenance_snapshot_events and flag anything Layer 1 alone missed — no AppFolio pull, no new rows inserted
  node backfill-maintenance-snapshot.js --help              Show this help and exit
`.trim());
}

function parseArgs(argv) {
  const args = { sinceDays: DEFAULT_SINCE_DAYS, dryRun: false, recheckExisting: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--recheck-existing') args.recheckExisting = true;
    else if (a === '--since-days') args.sinceDays = Number(argv[++i]);
  }
  return args;
}

// ─────────────────────────────────────────────────────────────────────────
// AppFolio auth/request pattern — reused in shape from
// projects/appfolio-sync/sync.js's own httpsRequest/afAuthHeader/pagination
// (per this build's instruction to reuse that connector, not build a
// second one). afPost() below is new, not copied: bill_detail is the first
// report in this codebase that needs a real POST-body param
// (occurred_on_from/occurred_on_to) — every REPORT_CONFIG entry in sync.js
// sends a bare '{}' body.
// ─────────────────────────────────────────────────────────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
        resolve({ statusCode: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function afAuthHeader() {
  return 'Basic ' + Buffer.from(`${AF_CLIENT_ID}:${AF_CLIENT_SECRET}`).toString('base64');
}

async function afPost(reportName, params) {
  const body = JSON.stringify(params || {});
  const result = await httpsRequest({
    hostname: AF_HOST,
    path: `/api/v2/reports/${reportName}.json`,
    method: 'POST',
    headers: {
      'Authorization': afAuthHeader(),
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(`AppFolio returned HTTP ${result.statusCode} for "${reportName}": ${JSON.stringify(result.body).substring(0, 300)}`);
  }
  return result.body;
}

// Pagination — same mechanics sync.js's own fetchAllPages() documents
// finding live for general_ledger (next_page_url can be host-relative, the
// continuation endpoint is POST-only, body is always '{}' on continuation
// pages). bill_detail behaves the same way — confirmed live while
// researching this build: a real 5-year pull took 14 pages (5000
// rows/page), next_page_url null on the last page. Only ONE initial
// request is ever made here (bill_detail), well under AppFolio's 7
// initial-requests-per-15-seconds limit (pagination requests are exempt,
// per sync.js's own rate-limit comment) — no rate-limit pause needed in
// this script.
async function fetchAllBillDetailPages(occurredOnFrom, occurredOnTo) {
  const first = await afPost('bill_detail', { occurred_on_from: occurredOnFrom, occurred_on_to: occurredOnTo });
  let rows = Array.isArray(first) ? first : (Array.isArray(first.results) ? first.results : []);
  let nextUrl = Array.isArray(first) ? null : (first.next_page_url || null);
  let pageCount = 1;

  while (nextUrl) {
    const parsed = new URL(nextUrl, `https://${AF_HOST}`);
    const pageBody = '{}';
    const page = await httpsRequest({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Authorization': afAuthHeader(),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(pageBody),
      },
    }, pageBody);
    if (page.statusCode < 200 || page.statusCode >= 300) {
      throw new Error(`AppFolio bill_detail pagination returned HTTP ${page.statusCode}`);
    }
    const pBody = page.body;
    rows = rows.concat(Array.isArray(pBody.results) ? pBody.results : []);
    nextUrl = pBody.next_page_url || null;
    pageCount++;
  }

  return { rows, pageCount };
}

// ─────────────────────────────────────────────────────────────────────────
// Property matching — see file header "WHY 'ACTIVE PROPERTIES ONLY' NEEDS
// NO SEPARATE FLAG" and finding #6. Pagination guard (1000-row page cap)
// matches every other full-table read in this codebase
// (maintenance-history/router.js's fetchAllRows, sync-property-stages.js's
// fetchAllProperties) — properties is small (150-500 units' worth of rows)
// but there's no reason to trust that forever.
// ─────────────────────────────────────────────────────────────────────────
async function fetchActivePropertiesByAppfolioId(supabase) {
  const pageSize = 1000;
  let all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('properties')
      .select('id, appfolio_id, name')
      .not('appfolio_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Fetching properties failed: ${error.message}`);
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  const byAppfolioId = new Map();
  for (const p of all) byAppfolioId.set(String(p.appfolio_id), p);
  return byAppfolioId;
}

// ─────────────────────────────────────────────────────────────────────────
// Summary construction + content check — see file header for the
// deterministic-path and Layer-1-only decisions and why.
// ─────────────────────────────────────────────────────────────────────────
function sanitizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function buildSummary(row, eventDateStr) {
  // `description` stands in for `work_order_issue` — see file header
  // correction #3. account_name is the fallback for the small share of
  // rows (0.4%, live-confirmed) with no description at all.
  const desc = sanitizeText(row.description) || sanitizeText(row.account_name) || 'Maintenance-related expense';
  const vendor = sanitizeText(row.payee_name);
  const amountNum = parseFloat(row.paid);
  const amountStr = Number.isFinite(amountNum) ? `$${amountNum.toFixed(2)}` : '$0.00';
  const summary = `${desc} — ${eventDateStr}, ${amountStr}, ${vendor}`;
  // Structural guardrail matching the table's own CHECK (char_length <=
  // 300) — this deterministic template never gets close in practice, but
  // truncating defensively costs nothing and avoids a constraint failure
  // on a genuinely oversized `description` value.
  return summary.length > 300 ? summary.slice(0, 297) + '...' : summary;
}

// ─────────────────────────────────────────────────────────────────────────
// Layer 2 — governance fix (Asimov, 2026-09-03). See file header
// "GOVERNANCE FIX" section for why this exists now. ONE cheap,
// classification-only call per row — a fast/cheap model (Claude Haiku),
// short prompt, yes/no + category. Deliberately NOT the extraction model
// (claude-sonnet-5) extract-claims.js uses, and deliberately NOT a
// paraphrase/generation step — this never writes or alters `summary`,
// it only judges it, same narrow scope as Layer 1.
//
// The category list and question framing are copied verbatim from
// extract-claims.js's own Layer 2 self-check (EXTRACTION_PROMPT_HEADER,
// the "For EACH claim, also self-check..." paragraph) — same categories
// protected-class-terms.js's CATEGORIES keys use, so a modelCategory
// value here merges cleanly into checkClaim()'s category Set alongside
// any Layer-1 keyword hit, exactly like extract-claims.js's own
// protected_class_category does today.
// ─────────────────────────────────────────────────────────────────────────
const LAYER2_MODEL = 'claude-haiku-4-5'; // fast/cheap classification model — not the sonnet-5 extraction model

const LAYER2_PROMPT_PREFIX = `Does the following maintenance-related text touch on a legally protected personal topic — race, color, religion, sex, sexual orientation, gender identity, national origin, familial status, disability/health/medical, source of income (incl. Section 8/vouchers), marital status, age, ancestry, genetic information, citizenship/immigration status, or primary language?

Answer on exactly two lines and nothing else:
Line 1: YES or NO
Line 2 (only if line 1 is YES): a short category label, one of: race_color, religion, sex_gender, national_origin_immigration, familial_status, disability_health, source_of_income, marital_status, age, genetic_information

Text: `;

function layer2Client() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  return new Anthropic({ apiKey });
}

// Deliberately no try/catch here that defaults to "not flagged" on error —
// per protected-class-terms.js's own design call ("when in doubt, this
// list errs toward flagging"), a Layer 2 failure must never silently look
// like a clean pass. Callers let this throw; main()'s per-row try/catch
// (see below) then routes the row to row_errors and skips inserting it,
// rather than inserting it with an unrun safeguard.
async function runLayer2Check(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { modelFlag: false, modelCategory: null };

  const anthropic = layer2Client();
  const response = await anthropic.messages.create({
    model: LAYER2_MODEL,
    max_tokens: 20, // yes/no + a short category label — never a paraphrase
    messages: [{ role: 'user', content: `${LAYER2_PROMPT_PREFIX}${trimmed}` }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const raw = ((textBlock && textBlock.text) || '').trim();
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const flagged = (lines[0] || '').toUpperCase().startsWith('YES');
  if (!flagged) return { modelFlag: false, modelCategory: null };

  return { modelFlag: true, modelCategory: lines[1] || 'model_judgment_unspecified' };
}

// Two-layer content check (GOVERNANCE.md Rule 9) — reuses the exact
// contentCheck.checkClaim(candidate) call maintenance-history/router.js's
// own Latchel ingest already uses for maintenance_claims. Layer 1 runs on
// BOTH the assembled summary AND the raw description text; Layer 2 (see
// above) runs ONCE per row, on the raw description text (falling back to
// summaryText — same fallback the caller already passes for Layer 1's raw
// check), because that raw text is where the actual risk lives (file
// header "GOVERNANCE FIX"), and its result is merged into whichever
// Layer-1 call scanned that same text — never double-counted.
//
// Returns `layer2CaughtAdditional: true` when the final flag would NOT
// have been raised by Layer 1 alone — the false-negative signal Asimov
// specifically asked to be able to see in a re-test (no extra AI call:
// this is a second, free, deterministic checkClaim() comparison, not a
// second Layer 2 request).
async function checkRowContent(summaryText, rawDescriptionText) {
  const layer2Text = rawDescriptionText || summaryText;
  const layer2 = await runLayer2Check(layer2Text);

  const summaryCheck = contentCheck.checkClaim({ claim_text: summaryText });
  const rawCheck = contentCheck.checkClaim({
    claim_text: layer2Text,
    modelFlag: layer2.modelFlag,
    modelCategory: layer2.modelCategory,
  });
  const rawCheckLayer1Only = contentCheck.checkClaim({ claim_text: layer2Text });

  const flagged = summaryCheck.flagged_protected_class || rawCheck.flagged_protected_class;
  const layer1OnlyFlagged = summaryCheck.flagged_protected_class || rawCheckLayer1Only.flagged_protected_class;
  if (!flagged) return { flagged_protected_class: false, flagged_category: null, layer2CaughtAdditional: false };

  const categories = new Set();
  (summaryCheck.flagged_category || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((c) => categories.add(c));
  (rawCheck.flagged_category || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((c) => categories.add(c));
  return {
    flagged_protected_class: true,
    flagged_category: Array.from(categories).join(', '),
    layer2CaughtAdditional: !layer1OnlyFlagged, // true only when Layer 1 alone would have missed this row
  };
}

// ─────────────────────────────────────────────────────────────────────────
// --recheck-existing — governance fix (Asimov, 2026-09-03). 69 real rows
// were already written to maintenance_snapshot_events by an earlier test
// run, before Layer 2 existed — those rows were only ever screened by
// Layer 1. This mode re-runs Layer 2 against each already-stored row's own
// `summary` text (the only text this table persists — the migration's own
// column comment; note buildSummary() above embeds the raw `description`
// text verbatim as summary's first component, so re-checking `summary` is
// the same real content Layer 2 would have judged at write time, not a
// degraded substitute) and updates flagged_protected_class/flagged_category/
// review_status on any row Layer 2 newly flags that Layer 1 alone missed.
// Never un-flags or downgrades a row Layer 1 already caught — this mode
// only ever adds a flag, matching protected-class-terms.js's own "when in
// doubt, err toward flagging" design call. A newly-flagged row's
// review_status is reset to 'unreviewed' so it enters the human review
// queue (PRIVACY_REVIEW_ROLES in router.js) — it was never auto-confirmed
// in the first place (migration: every row starts 'unreviewed'
// unconditionally), so this is belt-and-suspenders, not a downgrade.
// ─────────────────────────────────────────────────────────────────────────
async function fetchAllSnapshotRows(supabase) {
  const pageSize = 1000;
  let all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('id, summary, flagged_protected_class, flagged_category, review_status')
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Fetching ${TABLE} rows failed: ${error.message}`);
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function recheckExistingRows(supabase) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] Rechecking existing ${TABLE} rows against Layer 2 (governance fix, 2026-09-03)...`);
  const rows = await fetchAllSnapshotRows(supabase);
  console.log(`[${ts}] Loaded ${rows.length} existing row(s).`);

  const result = {
    rows_checked: rows.length,
    already_flagged_by_layer1: rows.filter((r) => r.flagged_protected_class).length,
    rows_newly_flagged_by_layer2: [],
    row_errors: [],
  };

  for (const row of rows) {
    try {
      if (row.flagged_protected_class) continue; // already caught by Layer 1 — never downgraded, nothing to do

      const layer2 = await runLayer2Check(row.summary);
      const check = contentCheck.checkClaim({
        claim_text: row.summary,
        modelFlag: layer2.modelFlag,
        modelCategory: layer2.modelCategory,
      });

      if (!check.flagged_protected_class) continue; // still clean — no change

      const { error: updateErr } = await supabase
        .from(TABLE)
        .update({
          flagged_protected_class: true,
          flagged_category: check.flagged_category,
          review_status: 'unreviewed',
        })
        .eq('id', row.id);
      if (updateErr) {
        result.row_errors.push({ id: row.id, stage: 'update', error: updateErr.message });
        continue;
      }
      result.rows_newly_flagged_by_layer2.push({ id: row.id, flagged_category: check.flagged_category });
    } catch (err) {
      result.row_errors.push({ id: row.id, stage: 'row', error: err.message });
    }
  }

  console.log(`\n[${ts}] Recheck done: ${result.rows_checked} row(s) checked, ${result.already_flagged_by_layer1} already flagged by Layer 1, ${result.rows_newly_flagged_by_layer2.length} newly flagged by Layer 2 (Layer 1 missed these):`);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!Number.isFinite(args.sinceDays) || args.sinceDays <= 0) {
    console.error('Invalid --since-days value. Must be a positive number. See --help.');
    process.exit(1);
  }

  const missing = [];
  if (!AF_CLIENT_ID || !AF_CLIENT_SECRET) missing.push('APPFOLIO_CLIENT_ID / APPFOLIO_CLIENT_SECRET');
  if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(', ')}. See .env.example.`);
    process.exit(1);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (args.recheckExisting) {
    await recheckExistingRows(supabase);
    return;
  }

  const today = new Date();
  const sinceDate = new Date(today.getTime() - args.sinceDays * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const occurredOnFrom = fmt(sinceDate);
  const occurredOnTo = fmt(today);

  const ts = new Date().toISOString();
  console.log(`[${ts}] maintenance-snapshot backfill: AppFolio bill_detail from ${occurredOnFrom} to ${occurredOnTo} (${args.sinceDays} day(s) back). Dry run: ${args.dryRun}.`);

  console.log(`[${ts}] Loading Hub's active properties (properties.appfolio_id)...`);
  const propertiesByAppfolioId = await fetchActivePropertiesByAppfolioId(supabase);
  console.log(`[${ts}] Loaded ${propertiesByAppfolioId.size} properties with a real AppFolio id.`);

  console.log(`[${ts}] Fetching AppFolio bill_detail (a full 5-year pull is ~14 pages / ~65-70k rows and can take a couple of minutes)...`);
  const { rows, pageCount } = await fetchAllBillDetailPages(occurredOnFrom, occurredOnTo);
  console.log(`[${ts}] Fetched ${rows.length} bill_detail row(s) across ${pageCount} page(s).`);

  const workOrderRows = rows.filter((r) => r.work_order_id != null && String(r.work_order_id).trim() !== '');
  const pct = rows.length ? (100 * workOrderRows.length / rows.length).toFixed(1) : '0.0';
  console.log(`[${ts}] ${workOrderRows.length} of ${rows.length} rows (${pct}%) have a populated work_order_id — the maintenance-relevant subset.`);

  const summary = {
    bill_detail_rows_pulled: rows.length,
    pages_pulled: pageCount,
    work_order_rows: workOrderRows.length,
    ready_to_insert: 0,
    unmatched_property: 0,
    missing_amount: 0,
    missing_vendor_name: 0,
    missing_or_invalid_date: 0,
    rows_flagged_protected_class: 0,
    rows_flagged_by_layer2_only: 0, // Layer 1 alone would have missed these — see file header "GOVERNANCE FIX"
    rows_upserted: 0,
    row_errors: [],
  };

  let dryRunPreviewCount = 0;
  const DRY_RUN_PREVIEW_CAP = 10;

  for (const row of workOrderRows) {
    try {
      const appfolioPropertyId = row.property_id != null ? String(row.property_id) : null;
      const property = appfolioPropertyId ? propertiesByAppfolioId.get(appfolioPropertyId) : null;
      if (!property) {
        summary.unmatched_property++;
        continue;
      }

      const eventDate = row.bill_date; // see file header — occurred_on isn't a real response field; bill_date is what occurred_on_from/to actually filters on
      if (!eventDate || !DATE_RE.test(eventDate)) {
        summary.missing_or_invalid_date++;
        summary.row_errors.push({
          payable_invoice_detail_id: row.payable_invoice_detail_id,
          property_id: appfolioPropertyId,
          stage: 'missing_or_invalid_date',
          error: `bill_detail row has no usable bill_date (raw: ${JSON.stringify(row.bill_date)}).`,
        });
        continue;
      }

      const amountNum = parseFloat(row.paid);
      if (!Number.isFinite(amountNum)) {
        // amount is NOT NULL on the table — flagged, never defaulted to 0
        // or allowed to crash the run. See file header "AMOUNT/VENDOR
        // VALIDATION."
        summary.missing_amount++;
        summary.row_errors.push({
          payable_invoice_detail_id: row.payable_invoice_detail_id,
          property_id: appfolioPropertyId,
          stage: 'missing_amount',
          error: `bill_detail row has no usable "paid" value (raw: ${JSON.stringify(row.paid)}). amount is NOT NULL on maintenance_snapshot_events — this row cannot be inserted as-is.`,
        });
        continue;
      }

      const vendorName = sanitizeText(row.payee_name);
      if (!vendorName) {
        // vendor_name is NOT NULL on the table too — same treatment.
        summary.missing_vendor_name++;
        summary.row_errors.push({
          payable_invoice_detail_id: row.payable_invoice_detail_id,
          property_id: appfolioPropertyId,
          stage: 'missing_vendor_name',
          error: 'bill_detail row has no payee_name. vendor_name is NOT NULL on maintenance_snapshot_events — this row cannot be inserted as-is.',
        });
        continue;
      }

      const rawDescription = sanitizeText(row.description); // stands in for work_order_issue — see file header correction #3
      const summaryText = buildSummary(row, eventDate);
      const sourceReference = `AppFolio bill_detail row ${row.payable_invoice_detail_id}, work_order ${row.work_order_id}`;

      const check = await checkRowContent(summaryText, rawDescription || summaryText);

      summary.ready_to_insert++;
      if (check.flagged_protected_class) summary.rows_flagged_protected_class++;
      if (check.layer2CaughtAdditional) summary.rows_flagged_by_layer2_only++;

      if (args.dryRun) {
        if (dryRunPreviewCount < DRY_RUN_PREVIEW_CAP || check.flagged_protected_class) {
          dryRunPreviewCount++;
          console.log(
            `  [dry-run] ${property.name || appfolioPropertyId} | ${eventDate} | ${summaryText}` +
            (check.flagged_protected_class ? `  [FLAGGED: ${check.flagged_category}]` : '') +
            (check.layer2CaughtAdditional ? `  [LAYER 2 CAUGHT — Layer 1 alone would have missed this]` : '')
          );
        }
        continue;
      }

      const dbRow = {
        property_id: property.id,
        event_date: eventDate,
        summary: summaryText,
        amount: Math.round(amountNum * 100) / 100,
        vendor_name: vendorName,
        source: 'appfolio_bill',
        source_reference: sourceReference,
        extracted_by: 'system',
        flagged_protected_class: check.flagged_protected_class,
        flagged_category: check.flagged_category,
      };

      // Upsert, not insert — UNIQUE(source, source_reference) is this
      // backfill's real dedupe key (migration's own "BACKFILL
      // IDEMPOTENCY" note), so re-running this script (or a later
      // incremental top-up with an overlapping window) never duplicates a
      // row. Per-row, not batched — same isolation convention as
      // maintenance-history/router.js's own Latchel ingest (one claim
      // insert at a time) and appfolio-sync/sync.js's own per-row
      // fallback: one bad row can never take the rest of the run down
      // with it. Will fail with "relation does not exist" until Peter
      // applies the migration — expected, not a code bug (see file
      // header).
      const { error: upsertErr } = await supabase
        .from(TABLE)
        .upsert(dbRow, { onConflict: 'source,source_reference' })
        .select('id');
      if (upsertErr) {
        summary.row_errors.push({
          payable_invoice_detail_id: row.payable_invoice_detail_id,
          property_id: appfolioPropertyId,
          stage: 'upsert',
          error: upsertErr.message,
        });
        continue;
      }
      summary.rows_upserted++;
    } catch (err) {
      // Per-row isolation — same convention as maintenance-history/
      // router.js's Latchel ingest (ticket-level try/catch) and
      // appfolio-sync/sync.js's own per-row fallback: one bad bill row can
      // never take the rest of the backfill down with it.
      summary.row_errors.push({
        payable_invoice_detail_id: row && row.payable_invoice_detail_id,
        stage: 'row',
        error: err.message,
      });
    }
  }

  console.log(`\n[${ts}] maintenance-snapshot backfill done${args.dryRun ? ' (DRY RUN — nothing written)' : ''}:`);
  console.log(JSON.stringify(summary, null, 2));
  if (summary.row_errors.length) {
    console.log(`\n${summary.row_errors.length} row error(s) (showing up to 20):`);
    summary.row_errors.slice(0, 20).forEach((e) => console.log(`  - ${JSON.stringify(e)}`));
    if (summary.row_errors.length > 20) console.log(`  ...and ${summary.row_errors.length - 20} more.`);
  }
}

main().catch((err) => {
  console.error('[maintenance-snapshot backfill] Fatal error:', err.message);
  process.exit(1);
});
