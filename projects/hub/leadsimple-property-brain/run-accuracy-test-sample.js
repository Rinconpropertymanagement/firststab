#!/usr/bin/env node
/**
 * run-accuracy-test-sample.js
 *
 * Runs the Phase 2 extraction pipeline (leadsimple-connector.js +
 * extract-claims.js + the reused maintenance-history content-check)
 * against a SPECIFIC, BOUNDED list of LeadSimple Application Screening
 * process IDs — built for spec Section 8's accuracy test (the ~20-case
 * sealed-answer-key, blind-graded sample Asimov's pre-check approved
 * running now).
 *
 * Deliberately NOT a nightly/scheduled ingestion endpoint and NOT mounted
 * into server.js. Asimov's pre-check
 * (compliance/leadsimple-spec-governance-precheck.md) approved building
 * this pipeline and running the accuracy test — explicitly NOT approved:
 * entering shadow mode (continuous extraction against new, real
 * applicants). A standing cron/HTTP ingest route is shadow-mode
 * infrastructure; a script you run by hand against a list of case IDs you
 * already chose is not. Keep it that way until shadow mode is actually
 * cleared (see the precheck doc's own three conditions).
 *
 * Usage:
 *   node run-accuracy-test-sample.js --process-ids <id1,id2,...> [options]
 *   node run-accuracy-test-sample.js --process-ids-file <path> [options]
 *
 * Options:
 *   --process-ids <ids>       Comma-separated LeadSimple process IDs.
 *   --process-ids-file <path> Text file, one process ID per line.
 *   --since <ISO date>        Pull tasks updated since this date only —
 *                             cheap, but WILL MISS a case's older tasks.
 *                             Use only when you know every sampled case's
 *                             tasks fall inside this window.
 *   --scoped-task-scan        Scan every task belonging to an Application
 *                             Screening workflow step (no date bound,
 *                             correct for old cases, same as
 *                             --full-task-scan) but filtered by step_ids[]
 *                             to this process type's own ~60 steps instead
 *                             of the whole account. Live-confirmed
 *                             2026-08-28: cuts the pool from ~110,381 tasks
 *                             to ~15,267 — prefer this over
 *                             --full-task-scan whenever every sampled
 *                             process is confirmed Application Screening
 *                             (true for this script always, since
 *                             getApplicationScreeningProcess already
 *                             refuses any other process type).
 *   --full-task-scan          Scan the entire account's tasks (no date
 *                             bound) and keep only ones matching your
 *                             process IDs. Correct for old cases; slow —
 *                             bounded by LeadSimple's 1,000-records/min
 *                             limit, not the 100-requests/min limit, so
 *                             expect roughly 2 minutes per 200 tasks
 *                             scanned account-wide (~110 minutes for a
 *                             full unbounded scan as of this account's
 *                             current task volume). Kept for a future
 *                             caller that isn't scoped to one process type;
 *                             --scoped-task-scan is strictly better for
 *                             this script's own use case. Exactly one of
 *                             --since / --scoped-task-scan / --full-task-scan
 *                             is required.
 *   --dry-run                 Extract and content-check but do not write
 *                             anything to Supabase. Prints every
 *                             candidate claim so you can sanity-check the
 *                             pipeline before it touches the real table.
 *   --help                    Show this help and exit.
 *
 * What it writes (unless --dry-run): rows into `claims`
 * (domain='leadsimple_application_screening', review_status ALWAYS
 * 'unreviewed' — no code path here sets anything else) and matching
 * `audit_log` entries, exactly mirroring maintenance-history/router.js's
 * ingestion pattern, generalized per PROPERTY-BRAIN-ARCHITECTURE.md
 * Section 2.6 — using audit_log's real, currently-used columns (action,
 * details) rather than the doc's event_type/event_data naming, since
 * that's what the live table and every existing writer (router.js)
 * actually use.
 *
 * Idempotency: unlike router.js (which gates reprocessing per-ticket via
 * maintenance_requests.latchel_claims_synced_at), this script has no
 * per-process "synced_at" column to manage — it's a standalone script,
 * not a router with a row to update between runs. The equivalent guard
 * here is per-claim: before inserting a candidate, this script checks
 * whether a claim with the same domain + source_reference already exists
 * (spec Section 5 — source_reference already uniquely identifies the
 * specific LeadSimple record + field/task a claim is about, since it
 * always embeds the process ID) and skips it, reporting the skip in the
 * run summary, rather than inserting a duplicate. This matters because
 * --since vs. --full-task-scan and a retry after a truncated AI response
 * both make re-running this script against the same process IDs a
 * realistic scenario, and a duplicate claim would directly corrupt the
 * sealed-answer-key accuracy sample (Section 8) it's built to feed.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

const { createClient } = require('@supabase/supabase-js');

const leadsimple = require('./lib/leadsimple-connector');
const extractClaims = require('./lib/extract-claims');
// Reused exactly as built for maintenance, not duplicated — see this
// file's own note on PROPERTY-BRAIN-ARCHITECTURE.md Section 3, which
// recommends eventually relocating these two modules to a domain-neutral
// projects/hub/lib/content-safety/ home now that a second consumer
// (this file) exists. That relocation is its own small, separate task —
// flagged to Peter, not done here, to avoid bundling an unrelated
// refactor into this build.
const contentCheck = require('../maintenance-history/lib/content-check');
const { TERMS_VERSION } = require('../maintenance-history/lib/protected-class-terms');

const DOMAIN = 'leadsimple_application_screening';

function printHelp() {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 64).join('\n'));
}

function parseArgs(argv) {
  const args = { processIds: [], sinceIso: null, fullTaskScan: false, scopedTaskScan: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--full-task-scan') args.fullTaskScan = true;
    else if (a === '--scoped-task-scan') args.scopedTaskScan = true;
    else if (a === '--since') args.sinceIso = argv[++i];
    else if (a === '--process-ids') args.processIds.push(...argv[++i].split(',').map(s => s.trim()).filter(Boolean));
    else if (a === '--process-ids-file') {
      const contents = fs.readFileSync(argv[++i], 'utf8');
      args.processIds.push(...contents.split('\n').map(s => s.trim()).filter(Boolean));
    }
  }
  return args;
}

function normalizeAddress(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,]/g, '');
}

// Supabase/PostgREST caps a single .select() at 1000 rows silently — same
// fix already used across every other router in this codebase
// (maintenance-history/router.js's fetchAllRows, security-deposit's
// equivalent). properties is small (150-500 units' worth of rows) but
// there's no reason to trust that forever.
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

// Idempotency guard (see file header) — returns the subset of
// `sourceReferences` that already have a claims row for this domain, so
// the per-process insert loop can skip them instead of duplicating. Run
// once per process, right after extraction, against that process's own
// candidate source_references — never against the whole table, so this
// stays a small, bounded query no matter how big `claims` grows.
async function fetchExistingSourceReferences(supabase, domain, sourceReferences) {
  if (sourceReferences.length === 0) return new Set();
  const { data, error } = await supabase
    .from('claims')
    .select('source_reference')
    .eq('domain', domain)
    .in('source_reference', sourceReferences);
  if (error) throw new Error(`Checking for existing claims failed: ${error.message}`);
  return new Set((data || []).map(r => r.source_reference));
}

/**
 * Matches a LeadSimple property record to a row in Rincon's own
 * `properties` table by normalized address. There is no ID-based join
 * available — checked live (spec doesn't say, and LeadSimple's Property
 * object carries no AppFolio ID field, per this build's own live
 * verification against the swagger schema and a real record; Rincon's
 * `properties` table has no LeadSimple ID column either). Address is the
 * only shared key both systems actually carry, since LeadSimple's own
 * property data is itself synced FROM AppFolio (.env.example's own note).
 * Zero or more-than-one match is treated as UNMATCHED, never guessed —
 * same "say unknown rather than guess" discipline as everywhere else in
 * this pipeline. claims_has_a_subject requires a property_id, so an
 * unmatched process gets no claims written at all, and is reported as its
 * own bucket in the run summary rather than silently dropped.
 */
function matchProperty(propertiesByAddress, leadsimpleProperty) {
  const addr = (leadsimpleProperty.full_address && leadsimpleProperty.full_address.line_1) || leadsimpleProperty.address;
  const key = normalizeAddress(addr);
  const candidates = propertiesByAddress.get(key) || [];
  if (candidates.length === 1) return candidates[0];
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.processIds.length === 0) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }
  if (!args.sinceIso && !args.fullTaskScan && !args.scopedTaskScan) {
    console.error('Error: pass exactly one of --since <ISO date>, --scoped-task-scan, or --full-task-scan. See --help.');
    process.exit(1);
  }

  const missing = [];
  if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (!process.env.LEADSIMPLE_API_KEY) missing.push('LEADSIMPLE_API_KEY');
  if (!args.dryRun && !process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!args.dryRun && !process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(', ')}. See .env.example.`);
    process.exit(1);
  }

  const supabase = args.dryRun ? null : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  console.log(`[leadsimple accuracy-test] Processing ${args.processIds.length} process ID(s). Dry run: ${args.dryRun}.`);

  const propertiesByAddress = new Map();
  if (!args.dryRun) {
    const properties = await fetchAllProperties(supabase);
    for (const p of properties) {
      const key = normalizeAddress(p.address);
      if (!propertiesByAddress.has(key)) propertiesByAddress.set(key, []);
      propertiesByAddress.get(key).push(p);
    }
    console.log(`[leadsimple accuracy-test] Loaded ${properties.length} known properties for address matching.`);
  }

  // Fetch every process up front so listAllTasksFull only needs one pass
  // over /tasks to serve all of them, instead of one full scan per case.
  const processes = [];
  for (const id of args.processIds) {
    try {
      const p = await leadsimple.getApplicationScreeningProcess(id);
      processes.push(p);
    } catch (err) {
      console.error(`[leadsimple accuracy-test] Could not fetch process ${id}: ${err.message}`);
    }
  }

  const tasksByProcessId = new Map(processes.map(p => [p.id, []]));
  if (args.scopedTaskScan) {
    console.log(`[leadsimple accuracy-test] Scoped task scan starting (Application Screening step_ids only — see --help). This is faster than --full-task-scan but still uncapped, so it can take several minutes.`);
    const idSet = new Set(processes.map(p => p.id));
    const result = await leadsimple.listApplicationScreeningTasksFull({
      matchProcessIds: idSet,
      onMatch: async (task) => {
        tasksByProcessId.get(task.process.id).push(task);
      },
    });
    console.log(`[leadsimple accuracy-test] Scoped task scan complete — scanned ${result.scanned}, matched ${result.matched}.`);
  } else if (args.fullTaskScan) {
    console.log(`[leadsimple accuracy-test] Full task scan starting — this can take a while (see --help). Progress logs every page.`);
    const idSet = new Set(processes.map(p => p.id));
    let pages = 0;
    await leadsimple.listAllTasksFull({
      matchProcessIds: idSet,
      onMatch: async (task) => {
        tasksByProcessId.get(task.process.id).push(task);
      },
    });
    console.log(`[leadsimple accuracy-test] Full task scan complete.`);
  } else {
    const sinceUnix = Math.floor(new Date(args.sinceIso).getTime() / 1000);
    if (isNaN(sinceUnix)) {
      console.error(`Invalid --since date: "${args.sinceIso}". Use an ISO date like 2026-01-01.`);
      process.exit(1);
    }
    const idSet = new Set(processes.map(p => p.id));
    const tasks = await leadsimple.listTasksUpdatedSince(sinceUnix);
    for (const t of tasks) {
      if (t.process && idSet.has(t.process.id)) tasksByProcessId.get(t.process.id).push(t);
    }
  }

  const summary = {
    processes_requested: args.processIds.length,
    processes_fetched: processes.length,
    processes_property_matched: 0,
    processes_property_unmatched: 0,
    claims_inserted: 0,
    claims_flagged: 0,
    claims_skipped_duplicate: 0,
    errors: [],
  };

  for (const proc of processes) {
    let property = null;
    if (!args.dryRun) {
      const leadsimpleProperty = (proc.properties || [])[0];
      if (!leadsimpleProperty) {
        summary.processes_property_unmatched++;
        summary.errors.push({ process_id: proc.id, stage: 'property_match', error: 'Process has no property attached in LeadSimple.' });
        continue;
      }
      property = matchProperty(propertiesByAddress, leadsimpleProperty);
      if (!property) {
        summary.processes_property_unmatched++;
        const addr = (leadsimpleProperty.full_address && leadsimpleProperty.full_address.line_1) || leadsimpleProperty.address;
        summary.errors.push({ process_id: proc.id, stage: 'property_match', error: `No unique match in Rincon's properties table for address "${addr}".` });
        continue;
      }
      summary.processes_property_matched++;
    }

    let result;
    try {
      result = await extractClaims.extractProcessClaims({ process: proc, tasks: tasksByProcessId.get(proc.id) || [] });
    } catch (err) {
      summary.errors.push({ process_id: proc.id, stage: 'extraction', error: err.message });
      continue;
    }

    console.log(`\n[leadsimple accuracy-test] Process ${proc.id} (${proc.name || '(no name)'}) — ${result.claims.length} candidate claim(s):`);

    // Idempotency guard (see file header): find which of this process's
    // candidate claims already exist in `claims` before inserting any of
    // them, so a second run against the same process IDs — a realistic
    // scenario per --since vs. --full-task-scan and truncated-response
    // retries — skips duplicates instead of doubling them up.
    let existingSourceRefs = new Set();
    if (!args.dryRun && result.claims.length > 0) {
      try {
        existingSourceRefs = await fetchExistingSourceReferences(
          supabase, DOMAIN, result.claims.map(c => c.source_reference)
        );
      } catch (err) {
        // Fail closed: if we can't confirm what's already there, don't
        // risk inserting blind — skip this process's inserts entirely
        // and surface it as an error rather than silently duplicating.
        summary.errors.push({ process_id: proc.id, stage: 'duplicate_check', error: err.message });
        continue;
      }
    }

    const insertedIds = [];
    const insertedTypes = [];
    const sourceTypes = new Set();

    for (const candidate of result.claims) {
      const check = contentCheck.checkClaim(candidate);
      const isDuplicate = existingSourceRefs.has(candidate.source_reference);
      console.log(`  - [${candidate.claim_type}]${check.flagged_protected_class ? ' [FLAGGED: ' + check.flagged_category + ']' : ''}${isDuplicate ? ' [SKIPPED — claim already exists for this source_reference]' : ''} ${candidate.claim_text}`);

      if (args.dryRun) continue;

      if (isDuplicate) {
        summary.claims_skipped_duplicate++;
        continue;
      }

      const row = {
        domain: DOMAIN,
        property_id: property.id,
        claim_type: candidate.claim_type,
        claim_text: candidate.claim_text,
        claim_date: candidate.claim_date,
        source_type: candidate.source_type,
        source_reference: candidate.source_reference,
        source_link: candidate.source_link,
        confidence: candidate.confidence,
        extracted_by: candidate.extracted_by,
        flagged_protected_class: check.flagged_protected_class,
        flagged_category: check.flagged_category,
        review_status: 'unreviewed', // ALWAYS — no code path here sets anything else
      };

      const { data: inserted, error: insErr } = await supabase.from('claims').insert(row).select('id').single();
      if (insErr) {
        summary.errors.push({ process_id: proc.id, stage: 'insert', error: insErr.message });
        continue;
      }
      insertedIds.push(inserted.id);
      insertedTypes.push(candidate.claim_type);
      sourceTypes.add(candidate.source_type);
      existingSourceRefs.add(candidate.source_reference); // guard against a duplicate candidate later in this same run
      summary.claims_inserted++;

      if (check.flagged_protected_class) {
        summary.claims_flagged++;
        await supabase.from('audit_log').insert({
          action: 'claims.protected_class_excluded',
          entity_type: 'claim',
          entity_id: inserted.id,
          actor_type: check.matched_layer === 'keyword' ? 'system' : 'ai_agent',
          actor_id: check.matched_layer === 'keyword' ? 'leadsimple-content-check' : extractClaims.EXTRACTOR_ACTOR_ID,
          actor_version: check.matched_layer === 'keyword' ? TERMS_VERSION : (candidate.extracted_by || result.aiModelVersion || 'unknown'),
          privacy_category: 'processing',
          risk_level: 'high',
          property_id: property.id,
          details: {
            domain: DOMAIN,
            flagged_category: check.flagged_category,
            matched_layer: check.matched_layer,
            claim_type: candidate.claim_type,
            source_reference: candidate.source_reference,
          },
        }).then(({ error }) => {
          if (error) console.error(`[leadsimple accuracy-test] audit_log insert failed (protected_class_excluded): ${error.message}`);
        });
      }
    }

    if (!args.dryRun && insertedIds.length > 0) {
      await supabase.from('audit_log').insert({
        action: 'claims.extraction_run',
        entity_type: 'property',
        entity_id: property.id,
        actor_type: 'ai_agent',
        actor_id: extractClaims.EXTRACTOR_ACTOR_ID,
        actor_version: result.aiModelVersion || 'n/a',
        privacy_category: 'collection',
        risk_level: 'low',
        property_id: property.id,
        details: {
          domain: DOMAIN,
          claim_ids: insertedIds,
          claim_types: insertedTypes,
          source_types: Array.from(sourceTypes),
          leadsimple_process_id: proc.id,
        },
      }).then(({ error }) => {
        if (error) console.error(`[leadsimple accuracy-test] audit_log insert failed (extraction_run): ${error.message}`);
      });
    }

    if (result.truncated) {
      summary.errors.push({ process_id: proc.id, stage: 'extraction_truncated', error: 'AI response was cut off (max_tokens) before it finished — this process needs a retry.' });
    }
  }

  console.log('\n[leadsimple accuracy-test] Run summary:');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(err => {
  console.error('[leadsimple accuracy-test] Fatal error:', err);
  process.exit(1);
});
