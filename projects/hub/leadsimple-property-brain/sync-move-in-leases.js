#!/usr/bin/env node
/**
 * sync-move-in-leases.js
 *
 * The LeadSimple nightly sync job behind the rental analysis tool's new
 * "LeadSimple Move-Ins" comp source (LEADSIMPLE-COMP-SOURCE-SPEC.md, in
 * projects/rental-analysis/). Writes ONLY to `leadsimple_new_leases`
 * (see the migration) — real, confirmed-current new-tenant Move-In leases
 * from Rincon's own portfolio, for the rental analysis tool
 * (projects/rental-analysis/lib/leadsimple.js) to read at analysis time.
 * Never writes to `leadsimple_property_stages` (that's
 * sync-property-stages.js's own table, a different lifecycle — see below).
 *
 * WHY THIS IS A NEW SCRIPT AND TABLE, NOT A 4TH ROW IN
 * sync-property-stages.js / leadsimple_property_stages
 * ============================================================
 * That table/script pair is deliberately scoped to "what stage is this
 * process in right now" with an upsert-while-open, delete-once-closed
 * lifecycle (a stage row only exists while there's something current to
 * show). Move-Ins data is the opposite: it needs real numbers (rent,
 * bed/bath/sqft, lease dates) and only becomes useful once a process is
 * CLOSED (a signed lease), then should be KEPT — as a comp — for up to two
 * years, not deleted. See the spec's "The new table: its own, not a 4th row
 * in sync-property-stages.js" section for the full reasoning. This script
 * reuses that script's proven MECHANISM (a nightly `updated_since` pull via
 * the existing, already-tested getProcessTypeIdByName() /
 * listProcessesUpdatedSince() connector functions — zero changes needed in
 * lib/leadsimple-connector.js) but is otherwise a separate script against a
 * separate table.
 *
 * WHY A SYNC, NOT A LIVE LOOKUP AT ANALYSIS TIME
 * ============================================================
 * Same reasoning as sync-property-stages.js's own header: LeadSimple's API
 * has no address filter (confirmed by lib/leadsimple-connector.js's own
 * header comment), so finding "Move-Ins near this one address" would mean
 * paging every Move-In record and matching in memory on every analysis run
 * — infeasible inside a request/response cycle. This script does that work
 * once, nightly (or on-demand for the initial backfill), using
 * `updated_since` (a small, bounded pull for the ongoing case), and writes
 * a table projects/rental-analysis/lib/leadsimple.js can read with a plain
 * filtered SELECT.
 *
 * THE CORE MECHANISM — "IS THIS MOVE-IN STILL THE CURRENT LEASE?"
 * ============================================================
 * LeadSimple's own `properties[0].unit` object is a LIVE SNAPSHOT as of the
 * API call, not a record pinned to the specific Move-In process — confirmed
 * live (see the spec's "Resolving rent accuracy" section) that this
 * corrupts BOTH null and populated `current_rent`/`lease_start_date`
 * values whenever a unit has turned over more than once. So this script
 * never reads or trusts those LeadSimple fields for rent/lease-start at
 * all (see DATA BOUNDARY below) — instead, for EVERY closed Move-In, it:
 *   1. Matches the LeadSimple property/unit to a row in Rincon's own
 *      `units` table (via `properties`+`units`, see PROPERTY/UNIT MATCHING
 *      below).
 *   2. Finds that unit's `leases` row whose `lease_start` is closest to
 *      this Move-In's `closed_at`.
 *   3. If that distance is within LEASE_MATCH_TOLERANCE_DAYS (45, re-
 *      validated live against the real 667-record set — see spec's "Does
 *      the tolerance mechanism need to change shape") -> CONFIRMED CURRENT:
 *      write the row, using `leases.monthly_rent` and `leases.lease_start`
 *      — real, AppFolio-synced, actively-charged figures, never an
 *      estimate. Otherwise (no match, no leases row, or outside tolerance)
 *      -> DROP the record entirely. No `market_rent` fallback exists in
 *      this design — Peter's own direct instruction: "only the current
 *      lease is really the most relevant... if we lose the two leases
 *      before on the same property that is fine."
 * Live-tested against all 667 real closed Move-Ins in the account's 2-year
 * history (2026-09-18): 279 confirmed current (kept), 170 superseded by a
 * newer tenant (dropped), 194 with no property/unit match in Rincon's own
 * tables at all (dropped), 24 matched but no `leases` row for that unit
 * (dropped). This is real data, not synthetic — this source's comp pool is
 * genuinely smaller than the raw pull (279 of 667), and that is correct
 * behavior, not a bug: every kept record is a real, ledger-confirmed,
 * currently-accurate rent.
 *
 * PROPERTY/UNIT MATCHING — reused rules, duplicated code, unit-level not
 * property-level
 * ============================================================
 * Rincon's `properties` table stores one row per unit in some cases and one
 * row per building with several `units` children in others (confirmed
 * live: 398 properties / 467 units; 350 properties have exactly 1 unit, 37
 * have 2+, up to 15 on one property) — and which table carries the actual
 * unit-distinguishing text (`properties.address` itself, e.g. "130 N Garden
 * St #3144", vs. a child `units.unit_number` row, e.g. "130 N Garden St
 * Unit 3243" sitting under an otherwise unit-less "130 N Garden St"
 * property row) is NOT consistent — confirmed live on the real "130 N
 * Garden St" building (5 property rows, one of them exactly this case). So
 * matching here builds one candidate per Rincon UNIT (not per property):
 * `${property.address}, ${property.city}, ${property.state} ${property.zip} ${unit.unit_number}`
 * — concatenating both sources means whichever one actually carries the
 * unit distinction for a given row still gets picked up by the same
 * house-number-gated, unit-identifier-gated, 0.6-word-overlap rule
 * (findBestUnitMatch() below), without needing to special-case which
 * column the data happened to land in. The match TARGET (the LeadSimple
 * side) is `properties[0].full_address.full_address` — LeadSimple's own
 * pre-formatted string, confirmed live to always include the unit when one
 * exists (LeadSimple's raw `unit.unit_number` field is NOT used as a match
 * target on its own — confirmed live it's sometimes just a bare fragment
 * like "#1" or "A" with no street text at all).
 *
 * normalizeAddress()/houseNumber()/unitIdentifier()/addressWordScore()/
 * findBestUnitMatch() below are a small, LOCAL copy of the same rules
 * already proven in projects/rental-analysis/lib/property-matching.js's
 * findBestPropertyMatch() (house-number gate, unit-identifier gate, 0.6
 * word-overlap threshold) — adapted to resolve to a specific `units.id`
 * rather than a `properties.id`. Not a cross-project `require('../../../
 * rental-analysis/lib/...')` reach — this repo's own precedent
 * (sync-property-stages.js's own header, "PROPERTY MATCHING — REUSED, NOT
 * REINVENTED, BUT NOT SHARED YET") already made this call for its own
 * simpler address matching, for the same reason: that file isn't set up to
 * export from a plain CLI script, so reusing the exact RULES while
 * duplicating the small amount of code is the established pattern here,
 * not a shortcut. Now a third consumer of this exact logic exists
 * (rental-analysis's own copy, sync-property-stages.js's copy, this one) —
 * makes a real shared library a more clearly worthwhile follow-up than
 * before, still not done here for the same reason it wasn't done there.
 *
 * DATA BOUNDARY (LEADSIMPLE-COMP-SOURCE-SPEC.md's own "Data Boundary"
 * section, narrowed further this revision)
 * ============================================================
 * Reads ONLY bedrooms/bathrooms/square_feet, address/city/state/zip_code,
 * property_type, and closed_at from LeadSimple's process/property/unit
 * objects (property_type folded in per this build's own live findings —
 * see lib/leadsimple.js's FROM_LEADSIMPLE_PROPERTY_TYPE). NEVER reads or
 * stores LeadSimple's own `current_rent`, `market_rent`, `lease_start_date`,
 * `lease_end_date`, or `current_lease_move_in` (the live-snapshot fields
 * that motivate the whole `leases` cross-reference above), and NEVER reads
 * `contact_roles` (tenant/owner name/email/phone — present on every process
 * record, never assigned to a variable anywhere in this file) or any other
 * field. Enforced by simply never assigning those fields to a variable
 * anywhere in this script, not by a runtime filter — same discipline as
 * sync-property-stages.js.
 *
 * On the Rincon-database side, the `leases` cross-reference reads exactly
 * `unit_id`, `lease_start`, and `monthly_rent` from `leases` (never
 * `tenant_id`, never joins to `tenants`, never `status`/`notes`/
 * `lease_end`/anything else), and `id`/`address`/`city`/`state`/`zip` from
 * `properties` plus `id`/`property_id`/`unit_number` from `units` (address
 * matching only — discarded once the match decision is made, except
 * `units.id` itself, kept as `matched_unit_id`).
 *
 * A NEW OPERATIONAL REQUIREMENT — RETRACTING SUPERSEDED ROWS
 * ============================================================
 * Unlike leadsimple_property_stages (pure upsert-by-process-id, never
 * revisited), this table's real invariant is "at most one row per
 * currently-confirmed unit" (matched_unit_id is UNIQUE — see the
 * migration). Before inserting a newly-confirmed-current row, this script
 * DELETEs any existing row for that same matched_unit_id first — a unit
 * that turns over again must not leave its previous tenant's row sitting
 * in the table growing stale. This is new behavior the old sync pattern
 * didn't need; skipping it would silently accumulate stale comps over time,
 * the exact risk this whole design exists to eliminate.
 *
 * THE OTHER RETRACTION CASE — A PROCESS THAT UN-CLOSES
 * ============================================================
 * Rare but real (confirmed live: `closed_at` is a plain, mutable field, not
 * an append-only log): if a previously-closed process's `closed_at` reverts
 * to null on a later sync (a walked-back or corrected case), this script
 * deletes any row already saved for that `leadsimple_process_id` — a
 * cancelled Move-In is not a real transaction and must not linger in the
 * comp pool.
 *
 * ROW LIFECYCLE / IDEMPOTENCY
 * ============================================================
 * Re-running this script against an overlapping window (the default
 * lookback intentionally overlaps the previous run's) never duplicates a
 * row: a re-confirmed-current record deletes-then-reinserts for the same
 * matched_unit_id (a no-op in effect, since the new row's data will be
 * identical unless something really changed), and a re-evaluated-superseded
 * record simply writes nothing (it was already correctly absent, or was
 * already deleted by whichever OTHER record's currency check claimed that
 * unit). This self-corrects independent of processing order within a
 * single run — two closed Move-Ins for the same unit, both updated in the
 * same pull window, each independently check the (unchanged, single)
 * `leases` snapshot; only the one genuinely closer to that unit's real
 * `lease_start` will pass the tolerance check.
 *
 * NOT YET SOLVED, FLAGGED RATHER THAN GUESSED AT: same missed-run risk
 * sync-property-stages.js's own header already names for its table — if
 * this job fails to run for several nights, a unit that turned over during
 * the gap keeps showing its previous tenant's row until a run that actually
 * sees the new Move-In's `closed_at`. No monitoring/alerting on missed runs
 * is built here — out of this build's scope, not an oversight.
 *
 * Usage:
 *   node sync-move-in-leases.js                    Pull the last 3 days (default) of updated Move-In processes, confirm currency, upsert/delete/retract in Supabase
 *   node sync-move-in-leases.js --since-days 730    Wide-window INITIAL BACKFILL — run once before the nightly cron takes over (see spec, "The initial backfill is a separate step from the nightly cron")
 *   node sync-move-in-leases.js --dry-run           Pull and log each closed process's confirmed-current/superseded/no-match verdict; no property/unit matching against real properties/units is skipped, but no Supabase WRITES happen
 *   node sync-move-in-leases.js --help
 *
 * Invoked via cron, same pattern as sync-property-stages.js — no router.js
 * exists for this domain, so there's no live server to expose an endpoint
 * on. The actual crontab entry / cron-*.sh wrapper on Sally is Scotty's
 * setup work, excluded from this repo's deploys, same documented convention
 * as sync-property-stages.js's own header and deploy-to-sally.sh.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

const { createClient } = require('@supabase/supabase-js');

const leadsimple = require('./lib/leadsimple-connector');

const TABLE = 'leadsimple_new_leases';
const MOVE_IN_PROCESS_TYPE_NAME = '02 Move Ins';

// Same reasoning as sync-property-stages.js's own DEFAULT_SINCE_DAYS: small
// overlapping window so one missed night doesn't create a gap; safe to
// re-run repeatedly (see ROW LIFECYCLE above). Move-Ins close at a much
// lower rate than Delinquency (667 closed over 2 years on this account,
// ~0.9/day on average), so 3 days gives ample margin.
const DEFAULT_SINCE_DAYS = 3;

// Re-validated live against the full 667-record set (not just a subset) —
// see file header. Genuine matches cluster densely within 40 days; the next
// -nearest false lead is 183 days away. No hard evidence to justify
// widening this into that 41-183 day gray zone (only 11 records land
// there) without a manual check that hasn't been done.
const LEASE_MATCH_TOLERANCE_DAYS = 45;

function printHelp() {
  console.log(`
Usage:
  node sync-move-in-leases.js                    Pull the last ${DEFAULT_SINCE_DAYS} days (default) of updated "${MOVE_IN_PROCESS_TYPE_NAME}" processes, confirm currency against Rincon's own leases table, upsert/retract in Supabase
  node sync-move-in-leases.js --since-days 730    Wide-window INITIAL BACKFILL — run once before the nightly cron takes over
  node sync-move-in-leases.js --dry-run           Pull and log each closed process's confirmed-current/superseded/no-match verdict; no Supabase writes
  node sync-move-in-leases.js --help              Show this help and exit
`.trim());
}

function parseArgs(argv) {
  const args = { sinceDays: DEFAULT_SINCE_DAYS, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--since-days') args.sinceDays = Number(argv[++i]);
  }
  return args;
}

// ─────────────────────────────────────────────────────────────────────────
// Address matching — a small LOCAL copy of
// rental-analysis/lib/property-matching.js's house-number-gated,
// unit-identifier-gated, 0.6-word-overlap rule, adapted to resolve to a
// specific Rincon `units.id` rather than a `properties.id`. See file
// header, "PROPERTY/UNIT MATCHING," for why this is a duplicate, not an
// import.
// ─────────────────────────────────────────────────────────────────────────

function normalizeAddress(addr) {
  if (!addr) return '';
  return addr.split(',')[0]
    .toLowerCase()
    .replace(/[.#]/g, '')
    .replace(/\bstreet\b/g,    'st')
    .replace(/\bavenue\b/g,    'ave')
    .replace(/\bboulevard\b/g, 'blvd')
    .replace(/\bdrive\b/g,     'dr')
    .replace(/\broad\b/g,      'rd')
    .replace(/\blane\b/g,      'ln')
    .replace(/\bcourt\b/g,     'ct')
    .replace(/\bplace\b/g,     'pl')
    .replace(/\bcircle\b/g,    'cir')
    .replace(/\bhighway\b/g,   'hwy')
    .replace(/\bnorth\b/g,     'n')
    .replace(/\bsouth\b/g,     's')
    .replace(/\beast\b/g,      'e')
    .replace(/\bwest\b/g,      'w')
    .replace(/\s+/g,           ' ')
    .trim();
}

function houseNumber(normalized) {
  if (!normalized) return null;
  const m = normalized.match(/^([a-z0-9-]+)/);
  return m ? m[1] : null;
}

function unitIdentifier(address) {
  if (!address) return null;
  const m = address.match(/(?:#|\bunit\b|\bapt\b|\bapartment\b|\bste\b|\bsuite\b)\.?\s*#?\s*([a-z0-9-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function addressWordScore(normA, normB) {
  const wa = normA.split(' ').filter(w => w.length > 1);
  const wb = new Set(normB.split(' ').filter(w => w.length > 1));
  if (!wa.length || !wb.size) return 0;
  return wa.filter(w => wb.has(w)).length / Math.max(wa.length, wb.size);
}

// Supabase/PostgREST caps a single .select() at 1000 rows silently — same
// fix already used across this codebase (sync-property-stages.js's own
// fetchAllProperties, maintenance-history/router.js's fetchAllRows, etc.).
async function fetchAllRows(supabase, table, columns) {
  const pageSize = 1000;
  let all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Fetching ${table} failed: ${error.message}`);
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// One candidate per Rincon unit — see file header, "PROPERTY/UNIT
// MATCHING," for why the candidate concatenates BOTH properties.address
// and the unit's own unit_number rather than picking one.
function buildUnitCandidates(properties, units) {
  const propertiesById = new Map(properties.map(p => [p.id, p]));
  const candidates = [];
  for (const unit of units) {
    const property = propertiesById.get(unit.property_id);
    if (!property || !property.address) continue;
    const base = [property.address, property.city, [property.state, property.zip].filter(Boolean).join(' ')]
      .filter(Boolean).join(', ');
    const matchAddress = unit.unit_number ? `${base} ${unit.unit_number}` : base;
    candidates.push({ unitId: unit.id, propertyId: property.id, matchAddress });
  }
  return candidates;
}

/**
 * Best-matching Rincon unit for a LeadSimple-reported address, or null.
 * Same gates/threshold as findBestPropertyMatch() in
 * rental-analysis/lib/property-matching.js — see that file's own comments
 * for the two real bugs (house-number gate, unit-identifier gate) these
 * protect against; not re-explained here.
 */
function findBestUnitMatch(targetAddress, candidates) {
  if (!targetAddress || !candidates || !candidates.length) return null;
  const normTarget = normalizeAddress(targetAddress);
  if (!normTarget) return null;
  const targetHouseNumber = houseNumber(normTarget);
  const targetUnit = unitIdentifier(targetAddress);
  let best = null, bestScore = 0;
  for (const candidate of candidates) {
    const normCandidate = normalizeAddress(candidate.matchAddress);
    const candidateHouseNumber = houseNumber(normCandidate);
    if (targetHouseNumber && candidateHouseNumber && targetHouseNumber !== candidateHouseNumber) continue;
    const candidateUnit = unitIdentifier(candidate.matchAddress);
    if ((targetUnit || candidateUnit) && targetUnit !== candidateUnit) continue;
    const score = addressWordScore(normTarget, normCandidate);
    if (score > bestScore && score >= 0.6) { bestScore = score; best = candidate; }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────
// Currency cross-reference against Rincon's own `leases` table.
// ─────────────────────────────────────────────────────────────────────────

// Whole-day distance between two date-ish strings ('YYYY-MM-DD' or a fuller
// ISO datetime — sliced to the date portion first either way), computed on
// UTC calendar dates so this never drifts by a fraction of a day from
// timezone-of-day noise.
// LeadSimple's own zip_code field is zip+4 in practice — confirmed live
// against a real closed record ("93036-6265", not "93036"). Normalized to a
// plain 5-digit zip here, at write time, because that's this table's other
// real query key: lib/leadsimple.js filters with an EXACT zip_code=eq.<zip>
// match against the 5-digit zip it parses off the subject's typed address
// (extractZip(), lib/crmls.js) — storing the raw zip+4 value unmodified
// would mean that filter never matches anything, silently producing zero
// comps for every single zip. Same "never guess, but do the honest,
// necessary normalization" spirit as the rest of this build.
function extractZip5(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/(\d{5})/);
  return m ? m[1] : null;
}

// LeadSimple's own num_bedrooms/num_bathrooms fields come back as NUMERIC
// STRINGS in practice — confirmed live against a real closed record
// ("num_bedrooms": "3.0", "num_bathrooms": "2.5"), not JS numbers the way
// square_feet is (a real number, 1652, on the same record). A plain
// `typeof x === 'number'` check (this codebase's usual "don't guess, check
// the real type" convention — see lib/crmls.js/lib/rentcast.js's own
// mappers) would silently store null for every bedroom/bathroom count if
// applied here unchanged, so this parses the numeric string explicitly
// instead, still returning null (never guessing) for anything that isn't a
// real, finite number either way.
function toNumberOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// square_feet specifically: confirmed live against the real backfill that
// some LeadSimple unit records carry square_feet: 0 (bad/placeholder data
// on LeadSimple's own side, not a real square footage) — leadsimple_new_
// leases.sqft has a CHECK (sqft > 0) (a 0 sqft is nonsensical, per the
// migration), so a literal 0 fails the insert outright rather than being
// silently accepted. Treated the same as missing/unparseable: unknown,
// stored as null, never guessed — same discipline every other mapper in
// this pipeline already uses for ambiguous data. Not applied to
// bedrooms/bathrooms (0 bedrooms is a real, valid value — a studio).
function toPositiveNumberOrNull(value) {
  const n = toNumberOrNull(value);
  return typeof n === 'number' && n > 0 ? n : null;
}

function daysBetween(dateStringA, dateStringB) {
  const [ya, ma, da] = dateStringA.slice(0, 10).split('-').map(Number);
  const [yb, mb, db] = dateStringB.slice(0, 10).split('-').map(Number);
  const a = Date.UTC(ya, ma - 1, da);
  const b = Date.UTC(yb, mb - 1, db);
  return Math.abs(a - b) / 86400000;
}

// Groups every leases row (unit_id, lease_start, monthly_rent — nothing
// else, see file header, DATA BOUNDARY) by unit_id, so the per-record
// currency check below is a plain in-memory lookup rather than one Supabase
// round trip per closed Move-In. `leases` holds 433 rows account-wide
// (confirmed live) — small enough to hold entirely in memory for one run.
function groupLeasesByUnit(leaseRows) {
  const byUnit = new Map();
  for (const row of leaseRows) {
    if (!byUnit.has(row.unit_id)) byUnit.set(row.unit_id, []);
    byUnit.get(row.unit_id).push(row);
  }
  return byUnit;
}

/**
 * @returns {{status: 'confirmed_current', rent: number, leaseStart: string} | {status: 'superseded'} | {status: 'no_leases_row'}}
 */
function checkCurrency(unitId, closedAt, leasesByUnit) {
  const allCandidates = leasesByUnit.get(unitId) || [];
  // Confirmed live, real, on the initial backfill: 14 rows in Rincon's own
  // `leases` table have monthly_rent = NULL — even though that column is
  // NOT NULL in this repo's own tracked schema migration (the live database
  // has apparently drifted from it, or an old row predates a constraint
  // that was added later; either way, it's real, present data, not a
  // hypothetical). `Number(null)` evaluates to 0 in JavaScript — left
  // unguarded, this would have silently written a $0 "confirmed current"
  // comp into the pool for real, matched units (caught live: 3491 Kings
  // Canyon Dr, Oxnard). A lease row with no real rent figure can't confirm
  // a rent at all, so it's filtered out of consideration BEFORE picking
  // the closest-by-date candidate — same "a lease row that can't tell us
  // the rent isn't a usable lease row" logic as a unit with no leases row
  // at all having no rent to report.
  const candidateLeases = allCandidates.filter(l => {
    const rent = Number(l.monthly_rent);
    return Number.isFinite(rent) && rent > 0;
  });
  if (!candidateLeases.length) return { status: 'no_leases_row' };

  let closest = null;
  let closestDistance = Infinity;
  for (const lease of candidateLeases) {
    const distance = daysBetween(lease.lease_start, closedAt);
    if (distance < closestDistance) {
      closestDistance = distance;
      closest = lease;
    }
  }

  if (closestDistance <= LEASE_MATCH_TOLERANCE_DAYS) {
    return { status: 'confirmed_current', rent: Number(closest.monthly_rent), leaseStart: closest.lease_start };
  }
  return { status: 'superseded' };
}

// ─────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!Number.isFinite(args.sinceDays) || args.sinceDays <= 0) {
    console.error(`Invalid --since-days value. Must be a positive number. See --help.`);
    process.exit(1);
  }

  const missing = [];
  if (!process.env.LEADSIMPLE_API_KEY) missing.push('LEADSIMPLE_API_KEY');
  if (!args.dryRun && !process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!args.dryRun && !process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(', ')}. See .env.example.`);
    process.exit(1);
  }

  const supabase = args.dryRun ? null : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const ts = new Date().toISOString();
  const sinceUnix = Math.floor(Date.now() / 1000) - args.sinceDays * 24 * 60 * 60;

  console.log(`[${ts}] leadsimple move-in-leases sync: pulling "${MOVE_IN_PROCESS_TYPE_NAME}" processes updated since ${new Date(sinceUnix * 1000).toISOString()} (${args.sinceDays} day(s) back). Dry run: ${args.dryRun}.`);

  let candidates = [];
  let leasesByUnit = new Map();
  if (!args.dryRun) {
    const [properties, units, leases] = await Promise.all([
      fetchAllRows(supabase, 'properties', 'id, address, city, state, zip'),
      fetchAllRows(supabase, 'units', 'id, property_id, unit_number'),
      fetchAllRows(supabase, 'leases', 'unit_id, lease_start, monthly_rent'),
    ]);
    candidates = buildUnitCandidates(properties, units);
    leasesByUnit = groupLeasesByUnit(leases);
    console.log(`[${ts}] Loaded ${properties.length} properties / ${units.length} units (${candidates.length} match candidates) / ${leases.length} leases rows for the currency cross-reference.`);
  }

  const summary = {
    processes_pulled: 0,
    closed: 0,
    reopened_retracted: 0,
    no_property_on_record: 0,
    missing_required_address_field: 0,
    no_unit_match: 0,
    no_leases_row: 0,
    superseded: 0,
    confirmed_current_kept: 0,
    // Real records that were confirmed-current AND successfully written,
    // but were then immediately retracted by a LATER record in this SAME
    // run confirmed-current for the SAME unit (see the processes.sort()
    // comment above for why this can legitimately happen, and why sorting
    // ascending by closed_at makes the later one always the genuinely
    // newer, correct survivor). confirmed_current_kept below is the final,
    // reconciled count of distinct units actually holding a row at the end
    // of this run — NOT a running total of every insert that ever
    // succeeded — so it always matches a real SELECT count() against the
    // table for a fresh backfill.
    retracted_within_this_run: 0,
    errors: [],
  };
  const confirmedUnitIdsThisRun = new Set();

  let processTypeId;
  try {
    processTypeId = await leadsimple.getProcessTypeIdByName(MOVE_IN_PROCESS_TYPE_NAME);
  } catch (err) {
    console.error(`[${ts}] Could not resolve process type "${MOVE_IN_PROCESS_TYPE_NAME}": ${err.message}`);
    process.exit(1);
  }

  let processes;
  try {
    processes = await leadsimple.listProcessesUpdatedSince(processTypeId, sinceUnix);
  } catch (err) {
    console.error(`[${ts}] Fetch failed: ${err.message}`);
    process.exit(1);
  }
  summary.processes_pulled = processes.length;
  console.log(`[${ts}] Pulled ${processes.length} updated "${MOVE_IN_PROCESS_TYPE_NAME}" process(es).`);

  // Process oldest-closed-first. Found live, on the real initial backfill:
  // LeadSimple's own pull order is NOT sorted by closed_at (it tracks
  // updated_at), so when the SAME Rincon unit has more than one closed
  // Move-In confirmed-current in a single run (real, if rare — happens
  // when `leases` genuinely holds more than one row close enough to its
  // own unit's respective closed_at, e.g. a terminated lease row sitting
  // alongside a fresh one), the delete-before-insert retraction step (see
  // file header, "A NEW OPERATIONAL REQUIREMENT") means whichever record
  // is processed LAST for that unit is the one that survives — a race
  // that must resolve to the genuinely most-recent Move-In, not whichever
  // happened to come back later in LeadSimple's own pagination order.
  // Sorting ascending by closed_at first guarantees that: the newest
  // Move-In for any contested unit is always processed last, so it always
  // wins the race. (Open/reopened processes have no closed_at — sorted
  // first via the `|| ''` fallback; harmless, since their retraction path
  // is keyed by leadsimple_process_id, not matched_unit_id, and doesn't
  // race with anything.)
  processes.sort((a, b) => (a.closed_at || '').localeCompare(b.closed_at || ''));

  for (const proc of processes) {
    // Un-close case: a previously-closed process reverted to open (a
    // walked-back/corrected case, confirmed live to be possible — see file
    // header). Retract any row already saved for it and move on; this
    // Move-In is not a real transaction right now.
    if (!proc.closed_at) {
      if (args.dryRun) {
        console.log(`  [dry-run] process ${proc.id}: OPEN (or reopened) — would retract any existing row for this process_id, nothing to write.`);
        continue;
      }
      const { data: deleted, error: deleteErr } = await supabase
        .from(TABLE)
        .delete()
        .eq('leadsimple_process_id', proc.id)
        .select('id');
      if (deleteErr) {
        summary.errors.push({ process_id: proc.id, stage: 'reopen_retract', error: deleteErr.message });
        continue;
      }
      if (deleted && deleted.length) {
        summary.reopened_retracted += deleted.length;
        console.log(`  process ${proc.id}: reverted to open — retracted ${deleted.length} previously-saved row(s).`);
      }
      continue;
    }

    summary.closed++;

    const leadsimpleProperty = (proc.properties || [])[0];
    if (!leadsimpleProperty) {
      summary.no_property_on_record++;
      continue;
    }

    const fullAddress = (leadsimpleProperty.full_address && leadsimpleProperty.full_address.full_address)
      || leadsimpleProperty.address;
    const unit = leadsimpleProperty.unit || {};

    // address/city/zip_code are NOT NULL on leadsimple_new_leases (see the
    // migration) — confirmed live that zip_code specifically is missing on
    // 2/667 real closed records (and, separately, is zip+4 on every record
    // that DOES have one — see extractZip5() above). Checked here, against
    // the NORMALIZED zip (not the raw field), before any matching work, as
    // its own clean "dropped" reason rather than letting a would-be insert
    // fail later and land in the generic error bucket — a row with no
    // 5-digit zip could never be found by lib/leadsimple.js's zip-scoped
    // query anyway, so there's nothing lost by dropping it explicitly.
    const zip5 = extractZip5(leadsimpleProperty.zip_code);
    if (!leadsimpleProperty.address || !leadsimpleProperty.city || !zip5) {
      summary.missing_required_address_field++;
      continue;
    }

    if (args.dryRun) {
      console.log(`  [dry-run] process ${proc.id} closed ${proc.closed_at}: "${fullAddress}" — property/unit matching and currency check are skipped in dry-run (no properties/units/leases fetched); would confirm against Rincon's leases table for real.`);
      continue;
    }

    const match = findBestUnitMatch(fullAddress, candidates);
    if (!match) {
      summary.no_unit_match++;
      summary.errors.push({ process_id: proc.id, stage: 'unit_match', error: `No unique Rincon unit match for "${fullAddress}".` });
      continue;
    }

    const currency = checkCurrency(match.unitId, proc.closed_at, leasesByUnit);
    if (currency.status === 'no_leases_row') {
      summary.no_leases_row++;
      continue;
    }
    if (currency.status === 'superseded') {
      summary.superseded++;
      continue;
    }

    // CONFIRMED CURRENT. Retract any row already saved for this unit (the
    // real invariant — see file header, "A NEW OPERATIONAL REQUIREMENT")
    // before inserting the fresh one.
    const { error: retractErr } = await supabase
      .from(TABLE)
      .delete()
      .eq('matched_unit_id', match.unitId);
    if (retractErr) {
      summary.errors.push({ process_id: proc.id, unit_id: match.unitId, stage: 'retract', error: retractErr.message });
      continue;
    }

    const row = {
      leadsimple_process_id: proc.id,
      matched_unit_id: match.unitId,
      address: leadsimpleProperty.address || null,
      city: leadsimpleProperty.city || null,
      state: leadsimpleProperty.state || null,
      zip_code: zip5,
      property_type: leadsimpleProperty.property_type || null,
      bedrooms: toNumberOrNull(unit.num_bedrooms),
      bathrooms: toNumberOrNull(unit.num_bathrooms),
      sqft: toPositiveNumberOrNull(unit.square_feet),
      rent: currency.rent,
      lease_start_date: currency.leaseStart,
      closed_at: proc.closed_at,
    };

    const { error: insertErr } = await supabase.from(TABLE).insert(row);
    if (insertErr) {
      summary.errors.push({ process_id: proc.id, unit_id: match.unitId, stage: 'insert', error: insertErr.message });
      continue;
    }
    if (confirmedUnitIdsThisRun.has(match.unitId)) summary.retracted_within_this_run++;
    confirmedUnitIdsThisRun.add(match.unitId);
  }

  summary.confirmed_current_kept = confirmedUnitIdsThisRun.size;

  console.log(`[${ts}] leadsimple move-in-leases sync done:`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(err => {
  console.error('[leadsimple move-in-leases sync] Fatal error:', err);
  process.exit(1);
});
