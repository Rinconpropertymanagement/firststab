/**
 * lib/gather.js
 *
 * Approval Briefing's gather step — approval-briefing-SPEC.md Section 4,
 * NOW EXTENDED WITH SECTION 5 (Phase 4, this build): the risk-assessment
 * prompt (lib/risk-assessment.js), the unconditional two-layer content
 * check on its output (content-check.js, unmodified), the property-gated
 * `claims` mirror, and — closing the gap Judge flagged after Phase 3 —
 * actually persisting the access-instructions check this file already
 * computed but had nowhere to write (see "ACCESS INSTRUCTIONS, NOW
 * PERSISTED" below). Explicitly still NOT built here: Section 6 emergency
 * matching (Phase 5), Section 7 cost benchmark (Phase 5), Section 8 email
 * generation (Phase 6).
 *
 * ============================================================
 * WHAT GETS PERSISTED vs. WHAT GETS COMPUTED-ON-DEMAND — read this before
 * changing what this file writes to `approval_briefings`
 * ============================================================
 * approval_briefings' Phase 1 schema (supabase/migrations/
 * 20260827000000_approval_briefing_phase1.sql) has columns for exactly
 * the Section 2.3 "structured snapshot" fields (estimate, max_cost,
 * issue_id, category, is_urgent, is_emergency, severity, state_name),
 * plus appfolio_maintenance_limit, plus (Phase 1's own risk_assessment_*
 * columns and, as of migration 20260828010000, the access_instructions_*
 * columns — both wired below). It has NO columns for property job
 * history, property maintenance spend, tenant lease tenure, or tenant
 * job-count.
 *
 * That group (property history, spend, tenure, tenant count) is a
 * deliberate omission, matching this schema's own established pattern
 * for `getJobStateHistory()` — deterministic, cheaply re-fetchable facts
 * that would go stale between gather time and whenever Phase 6 actually
 * renders an email are computed live by the functions below, not
 * snapshotted. gatherApprovalBriefing() below returns them in its result
 * for a caller (a script, a test, eventually Phase 6) to use, but does
 * NOT write them to any column — the risk-assessment prompt below reads
 * them fresh from that same in-memory result, not from a stale column.
 *
 * ACCESS INSTRUCTIONS, NOW PERSISTED (this build): Phase 3 computed
 * checkAccessInstructions()'s result but could only hold it in memory —
 * migration 20260828010000_add_access_instructions_columns_to_
 * approval_briefings.sql (Neo) has since added access_instructions_text /
 * _status / _held_category, mirroring risk_assessment_status's own
 * pending/completed/held shape exactly. That migration's own header left
 * one naming decision to Q: checkAccessInstructions()'s three states are
 * 'none' | 'cleared' | 'held'; this column's CHECK is 'pending' |
 * 'completed' | 'held'. Decision made here, in mapAccessCheckToColumns()
 * below: 'held' maps directly; both 'cleared' (checked text is safe to
 * render) AND 'none' (the field was empty — nothing to check) map to
 * 'completed', not 'pending' — because the check step genuinely ran to
 * completion in both cases (checkAccessInstructions() is called
 * unconditionally below, every gather); 'pending' is reserved for a row
 * this gather step hasn't touched at all. Both cases leave
 * access_instructions_text NULL, which is exactly what Section 8's
 * template rendering needs to treat identically ("no access instructions
 * on this ticket") regardless of which of the two produced it. The
 * console.warn Phase 3 logged for this gap is removed — it was a loud
 * flag for exactly this gap, not a permanent feature (migration
 * 20260828010000's own header says so directly).
 * ============================================================
 */

const latchel = require('../../maintenance-history/lib/latchel-connector');
const { checkAccessInstructions } = require('./access-instructions-check');
const { checkClaim } = require('../../maintenance-history/lib/content-check');
const { generateRiskAssessment, EXTRACTOR_ACTOR_ID: RISK_ACTOR_ID } = require('./risk-assessment');

// ============================================================
// Property maintenance spend — Section 4.2, "Resolved 2026-08-28."
// gl_account_id values confirmed live against Rincon's real chart of
// accounts (this build, 2026-08-28: queried appfolio_property_actuals
// for each of the 11 category names Peter confirmed in the spec; two —
// HVAC and Janitorial — needed a wildcard search because their real
// AppFolio names ("HVAC (Heat, Ventilation, Air)", "Janitorial Expense")
// don't exactly match the spec's shorthand names). This is a maintained
// code asset, not a database table — same reasoning
// protected-class-terms.js gives for its own category list: reviewable,
// versionable, not worth a schema migration for 11 fixed integers that
// only change if Rincon's chart of accounts itself changes.
// ============================================================
const MAINTENANCE_SPEND_GL_ACCOUNTS = {
  33: 'Keys',
  34: 'Repair',
  35: 'Carpet Cleaning',
  36: 'Painting',
  37: 'HVAC (Heat, Ventilation, Air)',
  38: 'Gardening',
  39: 'Janitorial Expense',
  53: 'Plumbing',
  54: 'Flooring',
  55: 'Maintenance Labor',
  67: 'Miscellaneous Expense',
};
const MAINTENANCE_SPEND_GL_IDS = Object.keys(MAINTENANCE_SPEND_GL_ACCOUNTS).map(Number);

// Section 4.2's tenant/vendor research proved a 6-month pull, filtered
// client-side, produces correct real per-property counts. Reused here
// for both the property-history row (4.2) and the tenant maintenance-
// pattern row (4.4) — "same pagination-safe filtering logic built once
// and reused twice" (Section 12, Phase 3).
const HISTORY_WINDOW_MONTHS = 6;

// Real-data-measured (this build, 2026-08-28): a portfolio-wide 6-month
// listJobsUpdatedSince() pull is ~1,550 jobs / ~155 pages / ~35-40s —
// genuinely expensive, and there's no server-side per-property filter to
// avoid it (Section 4.2). A single hourly reconciliation pass can gather
// several newly-tracked jobs in the same run; without this cache each one
// would re-pay the full ~35s pull for what is, within one run, the same
// data. TTL is generous (30 min) because the window itself only advances
// by whole days.
let windowCache = null; // { since, fetchedAt, jobs }
const WINDOW_CACHE_TTL_MS = 30 * 60 * 1000;

function isoMonthsAgo(months) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

function periodOf(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function getRecentJobsWindow() {
  const since = isoMonthsAgo(HISTORY_WINDOW_MONTHS);
  if (windowCache && windowCache.since === since && (Date.now() - windowCache.fetchedAt) < WINDOW_CACHE_TTL_MS) {
    return windowCache.jobs;
  }
  const jobs = await latchel.listJobsUpdatedSince(since);
  windowCache = { since, fetchedAt: Date.now(), jobs };
  return jobs;
}

/**
 * Resolves property_id / maintenance_request_id the way spec Section 2.4
 * describes: property_id via properties.latchel_property_id ==
 * job.property_id (Latchel's own property id — confirmed live, this is
 * NOT the same field as ref_property_id, which lives on Latchel's
 * Property object from GET /properties, not on Job); maintenance_
 * request_id opportunistically via maintenance_requests.latchel_job_id.
 * Both are expected to miss for a lot of real rows today (Section 2.4) —
 * that's normal, not an error.
 */
async function resolveLinkage(supabase, job) {
  const latchelPropertyId = job.property_id != null ? String(job.property_id) : null;
  let property = null;
  if (latchelPropertyId) {
    const { data, error } = await supabase
      .from('properties')
      .select('id, appfolio_id, maintenance_limit')
      .eq('latchel_property_id', latchelPropertyId)
      .maybeSingle();
    if (error) {
      // Live-confirmed gotcha (this build, 2026-08-28): the maintenance_
      // limit column from supabase/migrations/20260828000000 has not been
      // applied to the live database yet as of this build. A missing-
      // column error (Postgres 42703) on this specific select must not
      // take down the whole gather step — degrade to resolving property
      // linkage without maintenance_limit rather than failing the row.
      if (error.code === '42703') {
        console.error('[approval-briefing gather] properties.maintenance_limit does not exist yet on the live database (migration 20260828000000 not applied) — resolving property linkage without it.');
        const fallback = await supabase
          .from('properties')
          .select('id, appfolio_id')
          .eq('latchel_property_id', latchelPropertyId)
          .maybeSingle();
        if (fallback.error) throw fallback.error;
        property = fallback.data;
      } else {
        throw error;
      }
    } else {
      property = data;
    }
  }

  const jobId = job.job_id != null ? String(job.job_id) : null;
  let maintenanceRequestId = null;
  if (jobId) {
    const { data, error } = await supabase
      .from('maintenance_requests')
      .select('id')
      .eq('latchel_job_id', jobId)
      .maybeSingle();
    if (error) throw error;
    maintenanceRequestId = data ? data.id : null;
  }

  return {
    latchel_property_id: latchelPropertyId,
    appfolio_property_id: property ? property.appfolio_id : null,
    property_id: property ? property.id : null,
    // undefined (not null) when the column couldn't be read at all, so
    // the caller can tell "genuinely no limit configured" apart from
    // "couldn't check" — see the $0.00-is-real gotcha this whole field
    // carries (spec Section 4.2, migration 20260828000000's own comment).
    maintenance_limit: property ? (Object.prototype.hasOwnProperty.call(property, 'maintenance_limit') ? property.maintenance_limit : undefined) : null,
    maintenance_request_id: maintenanceRequestId,
  };
}

/**
 * Section 4.1's structured snapshot, straight off job/getJob() fields —
 * per spec Section 2.3's hard rule, deliberately excludes description/
 * vendor_description/estimate_note (free text — read only by the Section
 * 5 risk-assessment prompt, not by this snapshot).
 *
 * `category` is deliberately left null: Latchel's Job object has no
 * top-level "category" field (confirmed live, this build) — mapping
 * issue_id to a category name requires the cached issues/categories
 * reference table Section 7's build requirement #1 calls for, which is
 * Phase 5 work, not built yet. issue_id itself IS captured now (it's
 * already on the job object) so Phase 5 has what it needs to backfill
 * category later without re-reading Latchel.
 */
function buildStructuredSnapshot(job) {
  return {
    estimate: job.estimate != null ? Number(job.estimate) : null,
    max_cost: job.max_cost != null ? Number(job.max_cost) : null,
    issue_id: job.issue_id != null ? String(job.issue_id) : null,
    category: null, // Phase 5 dependency — see function comment
    is_urgent: job.is_urgent != null ? !!job.is_urgent : null,
    is_emergency: job.is_emergency != null ? !!job.is_emergency : null,
    severity: job.severity || null,
    state_name: (job.state && job.state.name) || null,
  };
}

/**
 * Section 4.2's "brief history of past work at the property" + Section
 * 4.4's "recent maintenance-request pattern" (bare count) — computed
 * together since both reuse the identical windowed, client-side-filtered
 * pull (Section 12 Phase 3's own instruction). Excludes the triggering
 * job itself — this describes HISTORY, not the ticket currently being
 * briefed.
 *
 * Tenant scoping reuses the triggering job's own tenant_id (Latchel's
 * own id, already known from getJob() — no cross-system tenant matching
 * needed, unlike property matching).
 */
async function gatherJobHistory({ latchelPropertyId, latchelTenantId, excludeJobId }) {
  if (!latchelPropertyId) {
    return { window_months: HISTORY_WINDOW_MONTHS, property_job_count: null, property_jobs: [], tenant_job_count: null, reason: 'no_latchel_property_id' };
  }
  const jobs = await getRecentJobsWindow();
  const propertyJobs = jobs.filter(j =>
    String(j.property_id) === String(latchelPropertyId) &&
    (excludeJobId == null || String(j.job_id) !== String(excludeJobId))
  );
  const tenantJobs = latchelTenantId
    ? propertyJobs.filter(j => String(j.tenant_id) === String(latchelTenantId))
    : [];

  return {
    window_months: HISTORY_WINDOW_MONTHS,
    property_job_count: propertyJobs.length,
    // Bare facts only, per Section 4.4's hard rule ("no framing, no
    // adjectives") — a caller renders these, it does not editorialize
    // them. Capped to a handful for a briefing, not the full list.
    property_jobs: propertyJobs
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 10)
      .map(j => ({ job_id: j.job_id, name: j.name, created_at: j.created_at, state: j.state && j.state.name })),
    tenant_job_count: latchelTenantId ? tenantJobs.length : null,
  };
}

/**
 * Section 4.2's "property's maintenance spend (last month / 12mo /
 * all-time)" — SUM(net_amount) from appfolio_property_actuals, scoped to
 * the 11 confirmed categories, per property (Peter's call: not
 * aggregated to the owner). No owner join needed.
 */
async function gatherPropertySpend(supabase, appfolioPropertyId) {
  if (!appfolioPropertyId) {
    return { last_month: null, trailing_12mo: null, all_time: null, reason: 'no_appfolio_property_id' };
  }

  const { data, error } = await supabase
    .from('appfolio_property_actuals')
    .select('period, gl_account_id, net_amount')
    .eq('appfolio_property_id', appfolioPropertyId)
    .in('gl_account_id', MAINTENANCE_SPEND_GL_IDS);
  if (error) throw error;
  const rows = data || [];

  const now = new Date();
  const lastMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastMonthPeriod = periodOf(lastMonthDate);
  const twelveMoAgoDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  const twelveMoAgoPeriod = periodOf(twelveMoAgoDate);

  const sumWhere = (pred) => Math.round(rows.filter(pred).reduce((s, r) => s + (Number(r.net_amount) || 0), 0) * 100) / 100;

  return {
    last_month: { period: lastMonthPeriod, amount: sumWhere(r => r.period === lastMonthPeriod) },
    trailing_12mo: { since_period: twelveMoAgoPeriod, amount: sumWhere(r => r.period >= twelveMoAgoPeriod) },
    // Honest caveat carried straight from the spec (Section 4.2): "only
    // reaches back to whenever this table's history began" — not a
    // multi-year figure yet.
    all_time: { amount: sumWhere(() => true), caveat: 'Only reaches back to whenever appfolio_property_actuals sync history began, not a true lifetime figure.' },
    categories_included: Object.values(MAINTENANCE_SPEND_GL_ACCOUNTS),
  };
}

/**
 * Section 4.4's "how long they've lived at the property" — AppFolio
 * leases.lease_start for the property's currently active lease.
 *
 * Real gap this build found, not resolved by the spec text: a property
 * with more than one unit can have more than one currently-active lease,
 * and neither the job nor the spec identifies which unit/tenant a given
 * briefing is actually about (Latchel's job.location_id was null on
 * every real job checked). Most-recent-lease_start is used as a
 * defensible default when this happens, and multiple_active_leases: true
 * is returned so a caller can render that honestly rather than silently
 * picking one tenant's tenure and presenting it as certain. Not observed
 * on any of Rincon's real single-family properties tested against
 * during this build, but the schema allows for it and this function
 * doesn't assume it away.
 */
async function gatherTenantTenure(supabase, propertyId) {
  if (!propertyId) return { lease_start: null, multiple_active_leases: false, reason: 'no_property_id' };

  const { data: units, error: unitsErr } = await supabase.from('units').select('id').eq('property_id', propertyId);
  if (unitsErr) throw unitsErr;
  const unitIds = (units || []).map(u => u.id);
  if (!unitIds.length) return { lease_start: null, multiple_active_leases: false, reason: 'no_units' };

  const { data: leases, error: leaseErr } = await supabase
    .from('leases')
    .select('id, unit_id, lease_start, status')
    .in('unit_id', unitIds)
    .eq('status', 'active')
    .order('lease_start', { ascending: false });
  if (leaseErr) throw leaseErr;
  if (!leases || leases.length === 0) return { lease_start: null, multiple_active_leases: false, reason: 'no_active_lease' };

  return {
    lease_start: leases[0].lease_start,
    multiple_active_leases: leases.length > 1,
    active_lease_count: leases.length,
  };
}

/**
 * Section 4.4's naming-nuance decision (migration 20260828010000's header
 * — see this file's own header for the full reasoning): 'held' maps
 * directly; 'cleared' and 'none' both map to 'completed', since
 * checkAccessInstructions() genuinely runs to completion in both cases —
 * only the 'held' case ever populates access_instructions_held_category.
 */
function mapAccessCheckToColumns(accessCheck) {
  if (accessCheck.status === 'held') {
    return {
      access_instructions_status: 'held',
      access_instructions_text: null,
      access_instructions_held_category: accessCheck.held_category,
    };
  }
  return {
    access_instructions_status: 'completed',
    access_instructions_text: accessCheck.text, // null for 'none', the checked copy for 'cleared'
    access_instructions_held_category: null,
  };
}

/**
 * Section 5's risk-assessment generation PLUS the content-check gate,
 * combined here because the gate "runs once, unconditionally, immediately
 * after generation... regardless of whether property_id has resolved...
 * and regardless of whether a claims row will ever be written" (spec
 * Section 5) — it is not optional, and nothing downstream may read the
 * generated text before it passes. Returns the exact shape
 * gatherApprovalBriefing() needs to write to approval_briefings' three
 * risk_assessment_* columns, never leaking the flagged text out of this
 * function in any other form.
 *
 * Two distinct reasons a result can come back `status: 'held'`, both
 * satisfying the DB's own held-requires-category / held-text-not-
 * populated constraints (20260827000000) the identical way:
 *   - A TECHNICAL failure (API error, truncation, unparseable response) —
 *     risk-assessment.js already fails closed on these, matching
 *     access-instructions-check.js's own philosophy. held_category is one
 *     of risk-assessment.js's technical-failure codes, matched_layer is
 *     null (no content-check layer ever ran — there was no text to check).
 *   - A genuine CONTENT-CHECK flag (Layer 1 keyword scan or Layer 2 the
 *     model's own self-check) — held_category is content-check.js's
 *     flagged_category vocabulary, matched_layer records which layer(s)
 *     fired, for the audit_log entry below.
 */
async function computeRiskAssessment({ job, context }) {
  const generated = await generateRiskAssessment({ job, context });

  if (generated.held) {
    return {
      status: 'held',
      text: null,
      confidence: null,
      held_category: generated.held_category,
      matched_layer: null,
      // 'n/a', not RISK_ACTOR_ID — this field describes a MODEL VERSION
      // (feeds audit_log's actor_version, which already carries actor_id
      // separately), and a total call failure genuinely has none to
      // report, same fallback precedent as maintenance-history/router.js.
      extracted_by: generated.modelVersion || 'n/a',
    };
  }

  // content-screening-tier-redesign-SPEC.md Section 3.2: checkClaim() is
  // now async (Tier B makes a network call for six specific terms) —
  // awaited here, same as every other real call site in the codebase.
  const check = await checkClaim({
    claim_text: generated.claim_text,
    modelFlag: generated.modelFlag,
    modelCategory: generated.modelCategory,
  });

  if (check.flagged_protected_class) {
    return {
      status: 'held',
      text: null, // hard rule (spec Section 5): flagged text must never land in a field a template can read
      confidence: null,
      held_category: check.flagged_category,
      matched_layer: check.matched_layer,
      terms_version: check.terms_version, // for the audit_log entry's actor_version when matched_layer is 'keyword' — see writeGatherAuditLog()
      extracted_by: generated.modelVersion,
    };
  }

  // Section 5: "never a bare numeric score standing alone" — the
  // qualitative level is the leading clause of the stored text itself,
  // since Phase 1's schema has no separate risk_level column (see this
  // file's header and risk-assessment.js's own header for why).
  const label = generated.risk_level.charAt(0).toUpperCase() + generated.risk_level.slice(1);
  return {
    status: 'completed',
    text: `${label} risk: ${generated.claim_text}`,
    confidence: generated.confidence,
    held_category: null,
    matched_layer: null,
    extracted_by: generated.modelVersion,
  };
}

/**
 * Mirrors a cleared risk assessment into `claims` (spec Section 2.1's
 * single deliberate exception; Section 5's "mirrored into claims...
 * whenever property_id has resolved"). Caller only invokes this when
 * riskResult.status === 'completed' AND linkage.property_id is set —
 * both are guarded at the call site, not re-checked here, so this
 * function has no silent no-op path that could mask a caller bug.
 *
 * source_reference is a structural pointer only, per
 * PROPERTY-BRAIN-ARCHITECTURE.md Section 1.2.1 / spec Section 5 — the
 * job number and which fields were read, a timestamp, never the ticket's
 * own wording. source_type reuses 'latchel_job_field', already valid on
 * `claims` (claims_source_type_check, 20260816000000) — no migration
 * needed, these free-text fields ARE job fields.
 */
async function mirrorRiskAssessmentClaim(supabase, { propertyId, maintenanceRequestId, jobId, text, confidence, extractedBy }) {
  const today = new Date().toISOString().slice(0, 10);
  const row = {
    domain: 'approval_briefing',
    claim_type: 'risk_assessment',
    property_id: propertyId,
    maintenance_request_id: maintenanceRequestId || null,
    claim_text: text,
    claim_date: today,
    source_type: 'latchel_job_field',
    source_reference: `Latchel job ${jobId}, description field + vendor_description field + estimate_note field, read ${today}`,
    confidence,
    extracted_by: extractedBy,
    flagged_protected_class: false, // only ever called when computeRiskAssessment cleared it
    flagged_category: null,
    review_status: 'unreviewed', // ALWAYS — no code path here sets anything else
  };
  const { data, error } = await supabase.from('claims').insert(row).select('id').single();
  if (error) throw error;
  return data.id;
}

/**
 * GOVERNANCE.md Rule 1 audit entries for this gather's risk-assessment
 * step (spec Section 10.1 #2, "approval_briefing.risk_assessed") plus
 * Rule 9's "log the exclusion" requirement whenever EITHER of this
 * gather's two content-checked fields (risk assessment or access
 * instructions) came back held for a genuine content-check flag —
 * matching the `<domain>.protected_class_excluded` pattern already used
 * identically by maintenance-history/router.js and the leadsimple
 * accuracy-test script. Best-effort: an audit_log write failure is logged
 * to the console and never allowed to fail the gather step itself — the
 * row's actual data is already durable by the time this runs.
 */
async function writeGatherAuditLog(supabase, { briefingId, propertyId, riskResult, accessCheck }) {
  const riskEntityData = {
    briefing_id: briefingId,
    status: riskResult.status,
    held_category: riskResult.status === 'held' ? riskResult.held_category : null,
  };
  const { error: riskLogErr } = await supabase.from('audit_log').insert({
    action: 'approval_briefing.risk_assessed',
    entity_type: 'approval_briefing',
    entity_id: briefingId,
    actor_type: 'ai_agent',
    actor_id: RISK_ACTOR_ID,
    actor_version: riskResult.extracted_by || 'unknown',
    // Section 10.1 #2: "risk_level = 'medium' by default (an AI read
    // ticket free text to produce a judgment a PM will act on)" — bumped
    // to 'high' only when this specific hold is a genuine content-check
    // flag (matched_layer set), matching the 'high' precedent every other
    // domain's protected_class_excluded event already uses.
    risk_level: riskResult.matched_layer ? 'high' : 'medium',
    privacy_category: 'processing',
    property_id: propertyId || null,
    details: riskEntityData,
  });
  if (riskLogErr) console.error(`[approval-briefing gather] audit_log insert failed (risk_assessed): ${riskLogErr.message}`);

  const excludedFields = [];
  if (riskResult.status === 'held' && riskResult.matched_layer) {
    excludedFields.push({ field: 'risk_assessment', held_category: riskResult.held_category, matched_layer: riskResult.matched_layer });
  }
  if (accessCheck.status === 'held') {
    excludedFields.push({ field: 'access_instructions', held_category: accessCheck.held_category, matched_layer: accessCheck.matched_layer });
  }
  // Per-field actor identity — deliberately NOT a single shared
  // computation, because risk_assessment and access_instructions run
  // through two different Layer-2 self-checks (risk-assessment.js's own
  // model call vs. access-instructions-check.js's), each with its own
  // actor id. Attributing an access_instructions model-layer hit to the
  // risk-assessment actor (or vice versa) would misidentify which AI call
  // actually produced the self-check that fired — a real accuracy issue
  // for a GOVERNANCE.md Rule 1 log, not just cosmetic.
  const ACCESS_CHECK_ACTOR_ID = 'approval-briefing-access-instructions-check';
  for (const excluded of excludedFields) {
    // content-screening-tier-redesign-SPEC.md Section 3.2 changed
    // maintenance-history/lib/content-check.js's matched_layer vocabulary
    // from the bare 'keyword'/'model'/'keyword+model' to tier-specific
    // values ('keyword_tier_a', 'keyword_tier_a+model',
    // 'keyword_tier_b_confirmed', 'keyword_tier_b_confirmed+model') — an
    // exact-equality check against the old bare string would silently
    // stop matching anything. Checked by suffix instead, preserving this
    // file's own original distinction (was Layer 2 — the extraction/risk-
    // assessment model's own self-report — involved, yes or no), which is
    // what actor_type below actually needs to know. This file has no
    // actor identity of its own for the Tier B classifier specifically
    // (that's maintenance-history/router.js's concern, which logs it as
    // its own audit_log action) — a Tier B term confirmed with no Layer 2
    // hit still reads as "system" here, same simplification this file
    // already made for a pure keyword hit before this redesign existed.
    const isKeywordLayer = typeof excluded.matched_layer === 'string' &&
      excluded.matched_layer.startsWith('keyword') && !excluded.matched_layer.endsWith('+model');
    const isRisk = excluded.field === 'risk_assessment';
    const actor_id = isKeywordLayer ? 'approval-briefing-content-check' : (isRisk ? RISK_ACTOR_ID : ACCESS_CHECK_ACTOR_ID);
    // access-instructions-check.js's checkAccessInstructions() does not
    // return the model version its own Layer-2 call used, unlike
    // risk-assessment.js's generateRiskAssessment() — 'unknown' here is
    // honest, not a stand-in borrowed from a different AI call.
    const actor_version = isKeywordLayer
      ? ((isRisk ? riskResult.terms_version : accessCheck.terms_version) || 'unknown')
      : (isRisk ? (riskResult.extracted_by || 'unknown') : 'unknown');

    const { error } = await supabase.from('audit_log').insert({
      action: 'approval_briefing.protected_class_excluded',
      entity_type: 'approval_briefing',
      entity_id: briefingId,
      actor_type: isKeywordLayer ? 'system' : 'ai_agent',
      actor_id,
      actor_version,
      risk_level: 'high',
      privacy_category: 'processing',
      property_id: propertyId || null,
      // AUDIT LOG GUIDANCE, same as every other domain's identical entry:
      // never the flagged text itself — category and which layer matched
      // only.
      details: { briefing_id: briefingId, field: excluded.field, flagged_category: excluded.held_category, matched_layer: excluded.matched_layer },
    });
    if (error) console.error(`[approval-briefing gather] audit_log insert failed (protected_class_excluded, ${excluded.field}): ${error.message}`);
  }
}

/**
 * The orchestrator. Fetches one approval_briefings row + its Latchel job,
 * resolves linkage, writes back exactly the columns Phase 1's schema
 * provides (see file header for what's deliberately NOT written), and
 * returns the full gathered result — including the pieces that have
 * nowhere to be written yet — so a caller (a test, a future Phase 6) has
 * everything Section 4.1/4.2/4.4 produced for this row.
 */
async function gatherApprovalBriefing(supabase, briefingId) {
  const { data: briefing, error: briefingErr } = await supabase
    .from('approval_briefings')
    .select('id, latchel_job_id')
    .eq('id', briefingId)
    .maybeSingle();
  if (briefingErr) throw briefingErr;
  if (!briefing) throw new Error(`No approval_briefings row with id ${briefingId}`);

  const job = await latchel.getJob(briefing.latchel_job_id);
  if (!job) throw new Error(`Latchel job ${briefing.latchel_job_id} not found (deleted or inaccessible).`);

  const linkage = await resolveLinkage(supabase, job);
  const snapshot = buildStructuredSnapshot(job);

  const [jobHistory, spend, tenure, accessCheck] = await Promise.all([
    gatherJobHistory({
      latchelPropertyId: linkage.latchel_property_id,
      latchelTenantId: job.tenant_id != null ? String(job.tenant_id) : null,
      excludeJobId: job.job_id,
    }),
    gatherPropertySpend(supabase, linkage.appfolio_property_id),
    gatherTenantTenure(supabase, linkage.property_id),
    checkAccessInstructions(job.access_instructions),
  ]);

  // Section 5: the risk-assessment prompt reads the free-text fields only
  // from `job` (never anything Phase 3 already summarized) plus the
  // deterministic facts Phase 3 just gathered above (jobHistory/spend/
  // tenure/linkage) — computed here, not earlier, precisely so it can use
  // this same-gather-cycle data instead of a stale column.
  let riskResult;
  try {
    riskResult = await computeRiskAssessment({
      job,
      context: {
        estimate: snapshot.estimate,
        max_cost: snapshot.max_cost,
        severity: snapshot.severity,
        is_urgent: snapshot.is_urgent,
        is_emergency: snapshot.is_emergency,
        appfolio_maintenance_limit: linkage.maintenance_limit !== undefined ? linkage.maintenance_limit : null,
        window_months: jobHistory.window_months,
        property_job_count: jobHistory.property_job_count,
        tenant_job_count: jobHistory.tenant_job_count,
        lease_start: tenure.lease_start,
        spend_last_month: spend.last_month ? spend.last_month.amount : null,
        spend_trailing_12mo: spend.trailing_12mo ? spend.trailing_12mo.amount : null,
      },
    });
  } catch (err) {
    // Defense in depth only — generateRiskAssessment() already fails
    // CLOSED (returns held, never throws) on every failure mode it knows
    // about; a throw here means a genuine bug in this orchestration, not
    // a Latchel/model failure. Left un-persisted (risk_assessment_status
    // stays at its 'pending' default) rather than mis-recorded as a
    // content-check hold it never actually reached — this row is a
    // candidate for a future retry (Phase 7), not a permanent hold.
    console.error(`[approval-briefing gather] briefing ${briefingId}: risk-assessment step failed unexpectedly — leaving risk_assessment_status at its default for a future retry: ${err.message}`);
    riskResult = null;
  }

  // Section 5 / Section 2.4: mirror into `claims` ONLY when both the
  // content check cleared AND property_id has resolved — degrades
  // gracefully, never fails the row, when either isn't true (Phase 0's
  // backfill is a separate, still-in-progress prerequisite; a claims
  // insert failure here must not lose the already-cleared, already-
  // self-contained copy this function is about to write to
  // risk_assessment_text below).
  let riskAssessmentClaimId = null;
  if (riskResult && riskResult.status === 'completed' && linkage.property_id) {
    try {
      riskAssessmentClaimId = await mirrorRiskAssessmentClaim(supabase, {
        propertyId: linkage.property_id,
        maintenanceRequestId: linkage.maintenance_request_id,
        jobId: job.job_id,
        text: riskResult.text,
        confidence: riskResult.confidence,
        extractedBy: riskResult.extracted_by,
      });
    } catch (err) {
      console.error(`[approval-briefing gather] briefing ${briefingId}: claims mirror failed — approval_briefings.risk_assessment_text is still written below, only the cross-domain claims copy is missing for this row: ${err.message}`);
    }
  }

  const accessColumns = mapAccessCheckToColumns(accessCheck);

  // appfolio_maintenance_limit: write the resolved value (including a
  // genuine $0.00 — never coerce that to null, per the same gotcha
  // migration 20260828000000 documents for sync.js) only when it was
  // actually read successfully. `undefined` means the column couldn't be
  // read (not applied to this database yet) — omit the key entirely
  // rather than writing null, which would incorrectly assert "AppFolio
  // has no limit configured" for a property this gather step never
  // actually got to check.
  const updatePayload = {
    latchel_property_id: linkage.latchel_property_id,
    appfolio_property_id: linkage.appfolio_property_id,
    property_id: linkage.property_id,
    maintenance_request_id: linkage.maintenance_request_id,
    ...snapshot,
    ...accessColumns,
    last_data_refresh_at: new Date().toISOString(),
  };
  if (linkage.maintenance_limit !== undefined) {
    updatePayload.appfolio_maintenance_limit = linkage.maintenance_limit;
  }
  if (riskResult) {
    updatePayload.risk_assessment_text = riskResult.text;
    updatePayload.risk_assessment_confidence = riskResult.confidence;
    updatePayload.risk_assessment_status = riskResult.status;
    updatePayload.risk_assessment_held_category = riskResult.held_category;
    if (riskAssessmentClaimId) updatePayload.risk_assessment_claim_id = riskAssessmentClaimId;
  }

  let updateErr = (await supabase.from('approval_briefings').update(updatePayload).eq('id', briefingId)).error;
  if (updateErr && updateErr.code === 'PGRST204') {
    // Live-confirmed gotcha (this build, 2026-08-28), same class as
    // resolveLinkage()'s existing maintenance_limit fallback above but a
    // DIFFERENT error code — worth noting since it's easy to assume it'd
    // match that one: migration 20260828010000 (access_instructions_
    // status/_text/_held_category) has not been applied to the live
    // database yet, and PostgREST reports an unrecognized column on a
    // write (UPDATE) as its own schema-cache-miss code, PGRST204 — NOT
    // Postgres's raw 42703, which is what a plain SELECT of a missing
    // column returns instead (live-confirmed both ways, this build; see
    // resolveLinkage() above for the 42703/SELECT case). A missing-column
    // error on this update must not take down the whole gather step —
    // retry without those three keys so linkage/snapshot/risk-assessment
    // still get written; access-instructions persistence simply waits for
    // that migration the same way appfolio_maintenance_limit already
    // waited for its own.
    console.error(`[approval-briefing gather] briefing ${briefingId}: access_instructions_* columns do not exist yet on the live database (migration 20260828010000 not applied) — writing every other field, retrying without them.`);
    const { access_instructions_status, access_instructions_text, access_instructions_held_category, ...withoutAccessColumns } = updatePayload;
    updateErr = (await supabase.from('approval_briefings').update(withoutAccessColumns).eq('id', briefingId)).error;
  }
  if (updateErr) throw updateErr;

  if (riskResult) {
    await writeGatherAuditLog(supabase, { briefingId, propertyId: linkage.property_id, riskResult, accessCheck });
  }

  return {
    briefing_id: briefingId,
    latchel_job_id: briefing.latchel_job_id,
    linkage,
    snapshot,
    job_history: jobHistory,
    property_spend: spend,
    tenant_tenure: tenure,
    access_instructions: accessCheck,
    risk_assessment: riskResult,
    risk_assessment_claim_id: riskAssessmentClaimId,
  };
}

module.exports = {
  gatherApprovalBriefing,
  resolveLinkage,
  buildStructuredSnapshot,
  gatherJobHistory,
  gatherPropertySpend,
  gatherTenantTenure,
  mapAccessCheckToColumns,
  computeRiskAssessment,
  mirrorRiskAssessmentClaim,
  writeGatherAuditLog,
  MAINTENANCE_SPEND_GL_ACCOUNTS,
};
