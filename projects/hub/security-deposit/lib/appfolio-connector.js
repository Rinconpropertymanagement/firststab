'use strict';

/**
 * lib/appfolio-connector.js
 * The one place this tool talks to AppFolio. Every route in router.js that
 * needs lease/ledger data from AppFolio goes through the functions
 * exported here — never a direct AppFolio call from a route handler. This
 * is the "built so it can be swapped later" requirement from SPEC.md's
 * Q — AppFolio connector section: if Peter ever adopts Skywalk (a
 * third-party layer over AppFolio) or AppFolio ever supports attachment
 * retrieval, that upgrade happens inside this file, behind the same
 * function signatures, without touching routes, Tron's screens, or the
 * assembly logic.
 *
 * Scoped to this tool only (projects/hub/security-deposit/lib/), not a
 * shared Hub-wide module — see SPEC.md's "Where it lives" reasoning:
 * sync.js is the only other place in this codebase that calls AppFolio
 * directly, and it's a nightly batch job (pull everything, once a night),
 * a fundamentally different access pattern from this tool's need (pull
 * one lease's data, on demand). No second live consumer exists yet to
 * validate a shared interface against.
 *
 * v1 calls AppFolio's own native API directly — Basic Auth against
 * rinconpm.appfolio.com, the exact same pattern projects/appfolio-sync/
 * sync.js already uses (see its afAuthHeader/afPost/fetchAllPages). That
 * logic is duplicated here in miniature rather than imported from
 * sync.js, because sync.js isn't built as a reusable module (it's a
 * standalone CLI script with its own dotenv/process.exit side effects at
 * load time) and because this tool's access pattern (fetch-and-filter one
 * report, on demand) is different enough from sync.js's (pull everything,
 * write straight to Supabase) that forcing a shared abstraction today
 * would mean guessing at an interface before a second real use case
 * exists — the same reasoning SPEC.md gives for not sharing this
 * connector module itself.
 *
 * NOT LIVE-TESTED: unlike sync.js's report configs (which Neo confirmed
 * against real AppFolio data before finalizing the schema — see
 * 20260813000000/20260813000001's LIVE DISCOVERY FINDINGS), the exact
 * shape of a live rent_roll pull through THIS module has not been
 * exercised against the real AppFolio API by this build. The field names
 * used below (occupancy_id, tenant_id, additional_tenant_ids, deposit,
 * rent, past_due, lease_from, lease_to, status) are the ones Neo's
 * migrations already confirmed live against rent_roll for the sync — this
 * connector reads the same report, so they should hold — but TARS should
 * run this against a real case before it's trusted end to end.
 */

const https = require('https');

const AF_HOST = 'rinconpm.appfolio.com';

function afAuthHeader() {
  const id = process.env.APPFOLIO_CLIENT_ID;
  const secret = process.env.APPFOLIO_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error('APPFOLIO_CLIENT_ID and APPFOLIO_CLIENT_SECRET must be set in .env.');
  }
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

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

// `params` (optional) is sent as the JSON POST body instead of the bare
// '{}' sync.js always sends — needed for getPrepaidRentBalance below,
// which has to scope general_ledger to a date range (Neo's live
// discovery pass confirmed general_ledger respects posted_on_from/
// posted_on_to in the body — see 20260813000000's LIVE DISCOVERY
// FINDINGS). Every other caller here still passes no params, same as
// before.
async function afPost(reportName, params) {
  const body = JSON.stringify(params || {});
  const result = await httpsRequest({
    hostname: AF_HOST,
    path: `/api/v2/reports/${reportName}.json`,
    method: 'POST',
    headers: {
      Authorization: afAuthHeader(),
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(`AppFolio returned HTTP ${result.statusCode} for "${reportName}": ${JSON.stringify(result.body).substring(0, 200)}`);
  }
  return result.body;
}

async function fetchAllPages(reportName, params) {
  const first = await afPost(reportName, params);
  let rows = Array.isArray(first.results) ? first.results : [];
  let nextUrl = first.next_page_url || null;

  while (nextUrl) {
    const parsed = new URL(nextUrl);
    const page = await httpsRequest({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { Authorization: afAuthHeader() },
    });
    if (page.statusCode < 200 || page.statusCode >= 300) {
      throw new Error(`AppFolio pagination returned HTTP ${page.statusCode}`);
    }
    const pBody = page.body;
    rows = rows.concat(Array.isArray(pBody.results) ? pBody.results : []);
    nextUrl = pBody.next_page_url || null;
  }

  return rows;
}

// ─── Report cache ───────────────────────────────────────────────────────
// A pod lead opening a case triggers a live AppFolio call, not a Supabase
// read. AppFolio's own rate limit (7 initial report requests per 15s —
// see sync.js) means an uncached implementation would risk failing if
// more than a few cases are opened in quick succession, or if the same
// case is reloaded a few times while a pod lead works through it. This
// cache holds one full report pull for a short window so a burst of
// requests only costs one real AppFolio call. 2 minutes is a pragmatic
// v1 choice, not a tuned value — short enough that "as of" data stays
// close to live, long enough to absorb normal usage.
const CACHE_TTL_MS = 2 * 60 * 1000;
const reportCache = new Map(); // cacheKey -> { rows, fetchedAt }

async function fetchReportCached(cacheKey, reportName, params) {
  const cached = reportCache.get(cacheKey);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) return cached.rows;
  const rows = await fetchAllPages(reportName, params);
  reportCache.set(cacheKey, { rows, fetchedAt: Date.now() });
  return rows;
}

// ─── getLeaseDetails(occupancyId) ──────────────────────────────────────
// occupancyId is leases.appfolio_id. Reads the live rent_roll report
// (same report sync.js calls "the most complete lease data" — it runs
// last and wins on conflict in the nightly sync) and returns the row
// matching this occupancy.
async function getLeaseDetails(occupancyId) {
  if (!occupancyId) return { found: false };
  const rows = await fetchReportCached('rent_roll', 'rent_roll');
  const row = rows.find(r => String(r.occupancy_id) === String(occupancyId));
  if (!row) return { found: false };

  return {
    found: true,
    occupancy_id: String(row.occupancy_id),
    lease_start: row.lease_from || null,
    lease_end: row.lease_to || null,
    monthly_rent: row.rent != null && row.rent !== '' ? parseFloat(row.rent) : null,
    status: row.status || null,
    tenant_id: row.tenant_id ? String(row.tenant_id) : null,
    additional_tenant_ids: row.additional_tenant_ids
      ? String(row.additional_tenant_ids).split(',').map(s => s.trim()).filter(Boolean)
      : [],
    fetched_at: new Date().toISOString(),
    source: 'appfolio_live:rent_roll',
  };
}

// ─── getTenantLedger(tenantId) ─────────────────────────────────────────
// tenantId is tenants.appfolio_id for one of the leaseholders. Finds the
// occupancy row on the live rent_roll report where this tenant appears
// either as the primary tenant_id or inside additional_tenant_ids (the
// multi-tenant field Neo's discovery pass confirmed is real — see
// 20260813000001_lease_tenants.sql), and returns the deposit figure
// AS-IS off that row.
//
// "As-is" is deliberate, not a shortcut: Neo's live discovery against
// Rincon's actual AppFolio chart of accounts found exactly one
// deposit-liability account family (2101/2130) and confirmed there is
// nothing to decompose into pet/cleaning/key sub-types — see
// 20260813000000_security_deposit_leases_extension.sql. There IS a real,
// separate "2300 - Prepaid Rent" account that AB 12 also counts toward
// the deposit cap — Mason has since resolved this (SPEC.md Neo section
// #3): it's pulled separately, live, by getPrepaidRentBalance() below,
// and shown as its own labeled line rather than folded into this figure.
// Call both when assembling a case; this function alone never includes
// prepaid rent (see prepaid_rent_included below).
async function getTenantLedger(tenantId) {
  if (!tenantId) return { found: false };
  const rows = await fetchReportCached('rent_roll', 'rent_roll');
  const row = rows.find(r => {
    if (String(r.tenant_id) === String(tenantId)) return true;
    const additional = r.additional_tenant_ids
      ? String(r.additional_tenant_ids).split(',').map(s => s.trim())
      : [];
    return additional.includes(String(tenantId));
  });
  if (!row) return { found: false };

  const depositRaw = row.deposit;
  const deposit_held_total = depositRaw != null && depositRaw !== ''
    ? parseFloat(String(depositRaw).replace(/[$,]/g, ''))
    : null;

  const pastDueRaw = row.past_due;
  const balance = pastDueRaw != null && pastDueRaw !== ''
    ? parseFloat(String(pastDueRaw).replace(/[$,]/g, ''))
    : null;

  return {
    found: true,
    occupancy_id: row.occupancy_id ? String(row.occupancy_id) : null,
    deposit_held_total,
    prepaid_rent_included: false, // always false — call getPrepaidRentBalance() separately, see comment above
    balance,
    monthly_rent: row.rent != null && row.rent !== '' ? parseFloat(row.rent) : null,
    fetched_at: new Date().toISOString(),
    source: 'appfolio_live:rent_roll',
  };
}

// ─── getPrepaidRentBalance(occupancyId) ────────────────────────────────
// AB 12's aggregate deposit cap counts last month's rent collected
// upfront, but AppFolio books it in a genuinely separate account
// ("2300 - Prepaid Rent") from the Security Deposits family
// getTenantLedger reads above. Mason resolved this (SPEC.md Neo section
// #3, "Prepaid Rent — flagged by Neo mid-build, resolved by Mason, sent
// to Q for the build"): pull it live, per case — not nightly-synced,
// since general_ledger is a transaction-level report, not a one-row-per-
// occupancy report like rent_roll, so there's no single column to sync
// nightly the way deposit_held_total is.
//
// FIELD NAMES CONFIRMED BY NEO AGAINST REAL DATA (live-tested, not
// guessed — see the earlier placeholder version's caveat in git history
// for what was assumed before this pass):
//   - party_type='Occupancy' is the correct, safe scoping filter — every
//     one of 366 real rows on account 2300 in a one-month test was
//     Occupancy-type, zero collisions with owner/vendor-side rows.
//   - There is no occupancy_id field on general_ledger at all. Use
//     party_id (integer) + party_type='Occupancy' — party_id is the same
//     numbering as occupancy_id elsewhere when party_type='Occupancy'.
//   - There is no single signed amount field. debit and credit are
//     separate string-decimal fields (e.g. "280.00"), never both
//     populated on the same row.
//   - credit_debit_balance exists in the schema but was null on every
//     row tested — never use it, it's not populated.
//   - Formula: current balance = SUM(credit) − SUM(debit), summed over
//     the occupancy's FULL history, not one period — credits are new
//     money received, debits are the balance being drawn down against
//     charges (standard liability accounting).
//   - general_ledger has no server-side account filter (silently ignores
//     account_name/account_id/gl_account_id/account_number params) —
//     this function pulls broad and filters client-side, same pattern
//     every other report in sync.js already uses.
//
// SINGLE PAGE ONLY, DELIBERATELY — not a shortcut, a known limitation:
// Neo found a real, separate bug in sync.js's shared fetchAllPages()
// helper (relative next_page_url breaks it, and general_ledger
// pagination looks flaky beyond that too) — out of scope for this build,
// flagged separately. This function does NOT follow next_page_url. A
// single occupancy's real Prepaid Rent history fits within one page in
// practice, so this sidesteps that bug rather than needing it fixed
// first. If that ever stops holding true for a specific occupancy, this
// would undercount — an accepted v1 tradeoff, not something to "fix" by
// adding pagination here without addressing the shared bug first.
async function getPrepaidRentBalance(occupancyId) {
  if (!occupancyId) return { found: false };

  // "Full history" means a wide, fixed lower bound rather than a rolling
  // window — 2000-01-01 is well before any plausible AppFolio usage
  // start for this portfolio. These params must always be sent
  // explicitly: general_ledger defaults to the CURRENT MONTH ONLY when
  // posted_on_from/posted_on_to are omitted (confirmed by Neo's
  // discovery pass — see 20260813000000's LIVE DISCOVERY FINDINGS),
  // which would badly undercount a real balance.
  const params = {
    posted_on_from: '2000-01-01',
    posted_on_to: new Date().toISOString().slice(0, 10),
  };

  let firstPage;
  try {
    firstPage = await afPost('general_ledger', params); // single page only — see comment above, do not add pagination here
  } catch (err) {
    return { found: false, error: err.message };
  }
  const rows = Array.isArray(firstPage.results) ? firstPage.results : [];

  const matches = rows.filter(r => {
    const account = String(r.account_name || '').trim();
    const partyType = String(r.party_type || '').trim().toLowerCase();
    const partyId = r.party_id != null ? String(r.party_id) : null;
    return account === '2300 - Prepaid Rent' && partyType === 'occupancy' && partyId === String(occupancyId);
  });

  if (!matches.length) {
    return { found: false, balance: null, occupancy_id: String(occupancyId) };
  }

  let totalCredit = 0;
  let totalDebit = 0;
  for (const row of matches) {
    const credit = row.credit != null && row.credit !== '' ? parseFloat(String(row.credit).replace(/[$,]/g, '')) : 0;
    const debit = row.debit != null && row.debit !== '' ? parseFloat(String(row.debit).replace(/[$,]/g, '')) : 0;
    if (!isNaN(credit)) totalCredit += credit;
    if (!isNaN(debit)) totalDebit += debit;
  }

  return {
    found: true,
    balance: totalCredit - totalDebit,
    verified_amount_field: true, // confirmed against real data by Neo — see comment above
    transaction_count: matches.length,
    occupancy_id: String(occupancyId),
    fetched_at: new Date().toISOString(),
    source: 'appfolio_live:general_ledger',
  };
}

// ─── getLeaseAttachments(occupancyId) ──────────────────────────────────
// v1: not available. Peter decided inspection forms are a manual pod-lead
// upload for v1 (SPEC.md Open Item #7) rather than an automatic AppFolio
// pull — router.js's upload route is what actually carries v1, not a
// fallback for this method failing. This function exists only so the
// connector's interface shape is already correct for whenever automatic
// retrieval becomes real (native AppFolio API, Skywalk, or otherwise) —
// swapping it in later is a upgrade behind this same signature, not a
// rebuild.
async function getLeaseAttachments(occupancyId) {
  return { available: false, reason: 'not_implemented_v1', attachments: [] };
}

module.exports = { getLeaseDetails, getTenantLedger, getPrepaidRentBalance, getLeaseAttachments };
