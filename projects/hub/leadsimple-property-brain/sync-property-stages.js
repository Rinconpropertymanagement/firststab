#!/usr/bin/env node
/**
 * sync-property-stages.js
 *
 * The LeadSimple nightly sync job for Property 360's LeadSimple card
 * (property-360-SPEC.md, LeadSimple section — "Technical blocker" and
 * "The fix — sync it like everything else on this page, not live," both
 * resolved 2026-09-02). Writes ONLY to `leadsimple_property_stages`
 * (supabase/migrations/20260902000000_leadsimple_property_stages.sql) —
 * property_id, process_type, stage, updated_at. Never writes claims, never
 * touches maintenance_requests/maintenance_claims, never reads or writes
 * any custom-field content.
 *
 * WHY THIS SCRIPT EXISTS, AND WHY IT'S A SYNC, NOT A LIVE LOOKUP
 * ============================================================
 * LeadSimple's API has no address or property filter (confirmed by
 * leadsimple-connector.js's own header — only process_type_id,
 * updated_since, and step_ids[] are real query params). Finding one
 * property's data means paging through every record of a process type and
 * matching addresses in memory, which is documented as ~110 minutes for a
 * full unbounded scan — infeasible to trigger on every Property 360 page
 * load. This script does that work once, nightly, using `updated_since`
 * (a small, bounded pull — confirmed live 2026-09-02, see below), and
 * writes a small table Property 360's read side (a separate, later build —
 * not this script) can query with plain SQL, exactly like Insurance,
 * Security Deposit, and Maintenance.
 *
 * SCOPE — STAGE NAME ONLY, PER "Card content, v1 — resolved 2026-09-02"
 * ============================================================
 * Three process types only: Delinquency, Lease Renewal, Move Out. Writes
 * only `stage` (the process's current stage name) — never a custom field,
 * never comments, never contact_roles (tenant/owner name, email, phone —
 * present on the process record but deliberately never read into a
 * variable, let alone written anywhere, by this script). The richer detail
 * originally scoped for Lease Renewal/Move Out is explicitly out of scope
 * for v1, pending its own Mason review (spec, "Access control" section).
 *
 * LIVE VERIFICATION DONE FOR THIS BUILD (2026-09-02), against Rincon's
 * real LeadSimple account — re-verifying the spec's own assumptions before
 * building, per its explicit instruction to do so. Two things the spec did
 * NOT pin down, and one thing it got right but is worth confirming stayed
 * true:
 *
 * 1. EXACT PROCESS TYPE NAMES, confirmed via GET /process_types (76 types
 *    on this account). The spec's own prose ("Delinquency," "Lease
 *    Renewal," "Move Out") is a paraphrase, not LeadSimple's literal
 *    names — see PROCESS_TYPES below for the exact strings used. Two
 *    findings worth flagging explicitly:
 *      - LeadSimple's own name for the Move Out type is "03 Move Outs"
 *        (plural). A DIFFERENT, unrelated type also exists on this
 *        account — "04 Management Company Termination Move Out" — that
 *        is NOT part of v1 scope and must never be confused with "03 Move
 *        Outs" by a future edit to PROCESS_TYPES below.
 *      - Several of this account's own process type names carry
 *        inconsistent trailing whitespace (e.g. "002 Delinquency " with a
 *        trailing space). leadsimple-connector.js's getProcessTypeIdByName
 *        trims both sides before comparing, so PROCESS_TYPES below is
 *        written without the trailing space — see that function's own
 *        comment for the live-verification detail.
 *
 * 2. OPEN/CLOSED SIGNAL — a real, previously-undocumented gap the
 *    migration's own comments flagged as "Q's call to actually implement,
 *    not fixed by this schema." No spec, compliance doc, or existing
 *    connector code in this repo names a status/is_open field on a
 *    LeadSimple Process object. Confirmed live: every Process record
 *    carries `closed_at` (null while open, a real timestamp once closed)
 *    directly on the process — NOT nested under `stage`. This is the
 *    signal this script uses for the migration's described row lifecycle
 *    ("upserts a row while LeadSimple shows an open process... DELETEs
 *    the row the first night it no longer does"): `closed_at == null` →
 *    upsert; `closed_at` set → delete any existing row for that
 *    (property_id, process_type). (`stage.status` also flips to
 *    "completed" on a closed process, confirmed live — a secondary
 *    signal, not used here since `closed_at` is the more direct one.)
 *
 * 3. PROPERTY ADDRESS SHAPE — confirmed still exactly what
 *    run-accuracy-test-sample.js already assumes: `properties[0]` on a
 *    Process, address at `full_address.line_1` (preferred) or `.address`
 *    (fallback), `.city`. No change needed to that matching approach.
 *
 * PROPERTY MATCHING — REUSED, NOT REINVENTED, BUT NOT SHARED YET
 * ============================================================
 * normalizeAddress() / fetchAllProperties() / matchProperty() below are
 * copied verbatim from run-accuracy-test-sample.js's own implementation
 * of the same problem (per this build's explicit instruction: reuse that
 * matching logic, don't reinvent it). That file doesn't export these
 * functions (it's a `#!/usr/bin/env node` CLI script, no module.exports),
 * so this is a duplicate, not a shared import — flagged here, and in this
 * build's own summary, as a real follow-up: now that a second consumer of
 * this exact matching logic exists, extracting it into a small shared lib
 * (e.g. leadsimple-property-brain/lib/property-match.js) is the cleaner
 * fix, the same situation run-accuracy-test-sample.js's own header comment
 * already flagged for contentCheck/extractClaims ("a small, separate task
 * — flagged to Peter, not done here, to avoid bundling an unrelated
 * refactor into this build"). Not done here for the same reason.
 *
 * ROW LIFECYCLE / IDEMPOTENCY
 * ============================================================
 * Upsert key is (property_id, process_type) — the table's own UNIQUE
 * constraint — so re-running this script against an overlapping window
 * (the default lookback intentionally overlaps the previous run's, see
 * DEFAULT_SINCE_DAYS below) never duplicates a row, only overwrites
 * `stage`/`updated_at` in place. Deletes are equally safe to repeat:
 * deleting a row that's already gone is a no-op, not an error.
 *
 * NOT YET SOLVED, FLAGGED RATHER THAN GUESSED AT: if this job fails to
 * run for several nights, a property whose process closed during the gap
 * keeps showing its last-known open stage until a run that actually sees
 * that process's `closed_at` change processes it — the same lingering-row
 * risk the migration's own "WHY NO RETENTION-POLICY FIGURE" section
 * already names and explicitly flags as "not a blocker to this migration."
 * No monitoring/alerting on missed runs is built here — out of this
 * build's scope, not an oversight.
 *
 * Usage:
 *   node sync-property-stages.js                  Pull the last 3 days (default) per process type, upsert/delete in Supabase
 *   node sync-property-stages.js --since-days 7    Widen the lookback window (e.g. after a missed run) — safe, see ROW LIFECYCLE above
 *   node sync-property-stages.js --dry-run         Pull and log what each process's stage/open-closed state is; no property matching, no Supabase writes
 *   node sync-property-stages.js --help
 *
 * Invoked via cron, same house pattern as projects/appfolio-sync/sync.js
 * (a plain `node <script>.js`, not an HTTP endpoint) — this domain
 * (leadsimple-property-brain) has no router.js mounted into server.js at
 * all, unlike maintenance-history's internalRouter+CRON_SECRET nightly
 * ingest pattern, so there is no live server to expose an endpoint on.
 * The actual crontab entry / cron-*.sh wrapper on Sally is Scotty's setup
 * work, not part of this script — per deploy-to-sally.sh's own documented
 * convention, those wrapper shell scripts are written directly onto Sally
 * by hand and deliberately excluded from this repo's deploys
 * (`--exclude 'cron-*.sh'`), so none is added here either.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

const { createClient } = require('@supabase/supabase-js');

const leadsimple = require('./lib/leadsimple-connector');

const TABLE = 'leadsimple_property_stages';

// v1 process types only (property-360-SPEC.md, "Why only these three for
// v1"; the migration's CHECK on process_type is deliberately narrow to
// match — widening either list is a real, visible change, not a silent
// default). `process_type` is the exact value written to that column;
// `processTypeName` is LeadSimple's own exact process type name,
// confirmed live 2026-09-02 (see file header, LIVE VERIFICATION #1).
const PROCESS_TYPES = [
  { process_type: 'delinquency', processTypeName: '002 Delinquency' },
  { process_type: 'lease_renewal', processTypeName: '05 Lease Renewal' },
  // LeadSimple's own name is plural ("Move Outs"). Do not change this to
  // "04 Management Company Termination Move Out" — a real, different
  // process type on this account, not in v1 scope. See file header.
  { process_type: 'move_out', processTypeName: '03 Move Outs' },
];

// Nightly job with a deliberately overlapping lookback window rather than
// a persisted "last run" cursor — the spec's own Size Estimate scopes this
// migration as "no other new tables," so there's no cursor table to keep.
// 3 days gives margin to survive one missed night without a gap; upserts
// and deletes are both idempotent (see file header, ROW LIFECYCLE), so
// re-covering the last run's window on every run is safe, not wasteful in
// any way that matters at this data volume (confirmed live: a 3-day
// window pulled ~200 records for Delinquency, this account's largest of
// the three types, well within a single-digit-minutes nightly run).
const DEFAULT_SINCE_DAYS = 3;

function printHelp() {
  console.log(`
Usage:
  node sync-property-stages.js                  Pull the last ${DEFAULT_SINCE_DAYS} days (default) per process type, upsert/delete in Supabase
  node sync-property-stages.js --since-days 7    Widen the lookback window (e.g. after a missed run)
  node sync-property-stages.js --dry-run         Pull and log stage/open-closed state per process; no property matching, no Supabase writes
  node sync-property-stages.js --help            Show this help and exit
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
// Property address matching — copied verbatim from
// run-accuracy-test-sample.js's own implementation. See file header,
// "PROPERTY MATCHING," for why this is a duplicate rather than a shared
// import, and the follow-up flagged as a result.
// ─────────────────────────────────────────────────────────────────────────

function normalizeAddress(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,]/g, '');
}

// Supabase/PostgREST caps a single .select() at 1000 rows silently — same
// fix already used across every other router in this codebase
// (maintenance-history/router.js's fetchAllRows, security-deposit's
// equivalent, run-accuracy-test-sample.js's own fetchAllProperties).
// properties is small (150-500 units' worth of rows) but there's no reason
// to trust that forever.
async function fetchAllProperties(supabase) {
  const pageSize = 1000;
  let all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('properties')
      .select('id, address, city, zip')
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Fetching properties failed: ${error.message}`);
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

/**
 * Matches a LeadSimple property record to a row in Rincon's own
 * `properties` table by normalized address — no ID-based join available
 * (LeadSimple's own property data carries no AppFolio ID; Rincon's
 * `properties` table has no LeadSimple ID column). Zero or
 * more-than-one match is treated as UNMATCHED, never guessed, same
 * "say unknown rather than guess" discipline as everywhere else in this
 * pipeline.
 */
function matchProperty(propertiesByAddress, leadsimpleProperty) {
  const addr = (leadsimpleProperty.full_address && leadsimpleProperty.full_address.line_1) || leadsimpleProperty.address;
  const key = normalizeAddress(addr);
  const candidates = propertiesByAddress.get(key) || [];
  if (candidates.length === 1) return candidates[0];
  return null;
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

  console.log(`[${ts}] leadsimple property-stages sync: pulling processes updated since ${new Date(sinceUnix * 1000).toISOString()} (${args.sinceDays} day(s) back). Dry run: ${args.dryRun}.`);

  let propertiesByAddress = new Map();
  if (!args.dryRun) {
    const properties = await fetchAllProperties(supabase);
    for (const p of properties) {
      const key = normalizeAddress(p.address);
      if (!propertiesByAddress.has(key)) propertiesByAddress.set(key, []);
      propertiesByAddress.get(key).push(p);
    }
    console.log(`[${ts}] Loaded ${properties.length} known properties for address matching.`);
  }

  const summary = {
    process_types_checked: PROCESS_TYPES.length,
    processes_pulled: 0,
    processes_no_property_on_record: 0,
    processes_property_unmatched: 0,
    rows_upserted: 0,
    rows_deleted: 0,
    errors: [],
  };

  for (const pt of PROCESS_TYPES) {
    let processTypeId;
    try {
      processTypeId = await leadsimple.getProcessTypeIdByName(pt.processTypeName);
    } catch (err) {
      console.error(`[${ts}] ${pt.process_type}: could not resolve process type "${pt.processTypeName}": ${err.message}`);
      summary.errors.push({ process_type: pt.process_type, stage: 'process_type_lookup', error: err.message });
      continue;
    }

    let processes;
    try {
      processes = await leadsimple.listProcessesUpdatedSince(processTypeId, sinceUnix);
    } catch (err) {
      console.error(`[${ts}] ${pt.process_type}: fetch failed: ${err.message}`);
      summary.errors.push({ process_type: pt.process_type, stage: 'fetch', error: err.message });
      continue;
    }
    summary.processes_pulled += processes.length;
    console.log(`[${ts}] ${pt.process_type}: pulled ${processes.length} updated process(es).`);

    for (const proc of processes) {
      const isOpen = !proc.closed_at;
      const stageName = proc.stage && proc.stage.name ? proc.stage.name : null;

      if (args.dryRun) {
        console.log(`  [dry-run] ${pt.process_type} process ${proc.id}: ${isOpen ? `OPEN, stage "${stageName}"` : 'CLOSED'}`);
        continue;
      }

      const leadsimpleProperty = (proc.properties || [])[0];
      if (!leadsimpleProperty) {
        summary.processes_no_property_on_record++;
        continue;
      }
      const property = matchProperty(propertiesByAddress, leadsimpleProperty);
      if (!property) {
        summary.processes_property_unmatched++;
        const addr = (leadsimpleProperty.full_address && leadsimpleProperty.full_address.line_1) || leadsimpleProperty.address;
        summary.errors.push({ process_id: proc.id, process_type: pt.process_type, stage: 'property_match', error: `No unique match in Rincon's properties table for address "${addr}".` });
        continue;
      }

      if (isOpen) {
        if (!stageName) {
          // Genuinely unexpected — every process seen in live verification
          // (2026-09-02) carried a stage. Flagged loudly rather than
          // upserting a null/blank stage, same say-unknown-rather-than-
          // guess discipline as the rest of this pipeline.
          summary.errors.push({ process_id: proc.id, property_id: property.id, process_type: pt.process_type, stage: 'missing_stage_name', error: 'Process is open but has no stage.name.' });
          continue;
        }
        const { data: upserted, error: upsertErr } = await supabase
          .from(TABLE)
          .upsert(
            { property_id: property.id, process_type: pt.process_type, stage: stageName },
            { onConflict: 'property_id,process_type' }
          )
          .select('id');
        if (upsertErr) {
          // Includes the migration's own stage-length CHECK (max 100 chars)
          // firing loudly by design — surfaced here, never silently
          // truncated to fit. See migration's own comment on `stage`.
          summary.errors.push({ process_id: proc.id, property_id: property.id, process_type: pt.process_type, stage: 'upsert', error: upsertErr.message });
          continue;
        }
        summary.rows_upserted += upserted ? upserted.length : 0;
      } else {
        const { data: deleted, error: deleteErr } = await supabase
          .from(TABLE)
          .delete()
          .eq('property_id', property.id)
          .eq('process_type', pt.process_type)
          .select('id');
        if (deleteErr) {
          summary.errors.push({ process_id: proc.id, property_id: property.id, process_type: pt.process_type, stage: 'delete', error: deleteErr.message });
          continue;
        }
        summary.rows_deleted += deleted ? deleted.length : 0;
      }
    }
  }

  console.log(`[${ts}] leadsimple property-stages sync done:`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(err => {
  console.error('[leadsimple property-stages sync] Fatal error:', err);
  process.exit(1);
});
