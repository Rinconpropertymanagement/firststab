/**
 * lib/process-pending-messages.js
 * RETIRED, 2026-09-13 — archive-search-significance-technical-spec.md
 * (v2), Section 8 ("Retiring Complaint-Tracking's Own Pipeline"). This
 * file's own `runProcessPendingMessages()` (the AI-call-driving ingestion
 * pipeline, its `pipeline_status = 'pending'` driver query, its held-path
 * handler, and its checkThread()/categorizeComplaint() calls) is GONE —
 * not dead-ended, not left importing things it no longer calls. Two
 * reasons, both real and already-materialized, not hypothetical (spec
 * Section 2):
 *   1. This file's own driver query was structurally starved from before
 *      it ever ran: archive-search's Fair Housing screening pass sets
 *      `pipeline_status = 'processed'` on every row it screens, as a side
 *      effect of its own, unrelated job — 254,302 of 254,307 real rows,
 *      confirmed live 2026-09-13.
 *   2. Running two independent categorizers against the same mail (this
 *      one, and archive-search/lib/significance-pass.js) would produce
 *      silent disagreement with no reconciliation surface.
 *
 * The merged pass's own driver query and per-conversation pipeline —
 * Call 1 (significance tagging) and Call 2 (complaint-tracking's own six
 * categories, reframed as `escalation_signal`) — now live in
 * archive-search/lib/significance-pass.js, triggered via
 * archive-search/router.js's internalRouter (the same manually-triggered,
 * x-cron-secret-gated posture this file's own route used to have). The
 * corresponding internalRouter route in complaint-tracking/router.js now
 * dead-ends with a 410 Gone explaining the move — see that file.
 *
 * WHAT SURVIVES, AND WHY (confirmed via grep before anything was removed
 * — both functions below have real, live callers outside the retired
 * pipeline; deleting this whole file would have broken them):
 *   - computeSilenceContext() — reused directly by significance-pass.js's
 *     Call 2 for LIVE mail's silence-context text (spec Section 5: "the
 *     silence-context text is unchanged from categorize-complaint.js's
 *     existing wording" for live mail — computeSilenceContext() is that
 *     same, unmodified logic; only historical mail gets the separate
 *     historicalFraming fix, entirely inside significance-pass.js, not
 *     here).
 *   - lookupSingleDirectorOfOperations() — still called by
 *     complaint-tracking/router.js's manual "Report an issue" path
 *     (POST /api/complaint-tracking/report) and now also by
 *     significance-pass.js for live_pipeline DO assignment (spec Section
 *     6's hard gate: never for a historical_backfill row).
 *
 * categorize-complaint.js, subject-match.js, thread-adapter.js,
 * duplicate-check.js: this file no longer requires any of them.
 * categorize-complaint.js has zero remaining callers anywhere in this
 * codebase as of this change (confirmed via grep) and has been deleted.
 * subject-match.js and thread-adapter.js are explicitly NOT retired — the
 * merged pass reuses them directly (imported from archive-search/lib/
 * significance-pass.js, not duplicated). duplicate-check.js is reused the
 * same way, for live_pipeline complaints only.
 */

// Same two Rincon staff domains this codebase uses elsewhere (insurance/
// router.js, security-deposit/router.js, maintenance-history/router.js's
// ALLOWED_DOMAINS) — reused here only to tell whether the LAST message in
// a thread was sent BY Rincon staff (for the silence clock below), not
// for any access-control purpose. Unchanged from before this retirement.
const STAFF_DOMAINS = ['rinconmanagement.com', 'quickturnmaintenance.com'];
function isStaffAddress(address) {
  if (!address) return false;
  const match = String(address).match(/@([a-z0-9.-]+)/i);
  const domain = match ? match[1].toLowerCase() : null;
  return !!domain && STAFF_DOMAINS.includes(domain);
}

// Design Decision 5's "blocked_resolution_silence_days is a classification
// trigger" — computed deterministically here (message dates are plain
// facts). Unchanged from before this retirement — still the one real
// place this logic lives; significance-pass.js calls this directly for
// live mail rather than re-deriving it.
function computeSilenceContext(thread, silenceDays) {
  const messages = thread.messages || [];
  if (!messages.length) return { daysSinceLastMessage: null, lastMessageFromStaff: false, silenceThresholdDays: silenceDays };
  const last = messages[messages.length - 1]; // toThreadShape already sorts oldest -> newest
  const days = last.date ? (Date.now() - new Date(last.date).getTime()) / 86400000 : null;
  return {
    daysSinceLastMessage: days == null ? null : Math.round(days * 10) / 10,
    lastMessageFromStaff: isStaffAddress(last.from),
    silenceThresholdDays: silenceDays,
  };
}

// Design Decision 12's DO lookup — "if zero or more than one active DO
// holds that role, the lookup logs an error and the complaint is created
// with owner_team_member_id = NULL plus needs_human_call = TRUE rather
// than guessing." Unchanged from before this retirement. Lazily creates
// its own Supabase client (rather than the module-level client this file
// used to share with the now-removed ingestion pipeline) so this file has
// zero side effects at require() time — no env-var check, no client
// construction — until a caller actually invokes one of these two
// functions.
let _supabase = null;
function supabase() {
  if (!_supabase) {
    const { createClient } = require('@supabase/supabase-js');
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return _supabase;
}

async function lookupSingleDirectorOfOperations() {
  const db = supabase();
  const { data: roleRows, error: roleErr } = await db
    .from('team_member_tool_roles').select('team_member_id')
    .eq('tool', 'complaint_tracking').eq('role', 'director_of_operations');
  if (roleErr) {
    console.error('[complaint-tracking] DO role lookup failed:', roleErr.message);
    return { ok: false };
  }
  if (!roleRows || roleRows.length === 0) return { ok: false };

  const { data: members, error: memberErr } = await db
    .from('team_members').select('id, is_active').in('id', roleRows.map((r) => r.team_member_id));
  if (memberErr) {
    console.error('[complaint-tracking] DO team_member lookup failed:', memberErr.message);
    return { ok: false };
  }
  const active = (members || []).filter((m) => m.is_active);
  if (active.length !== 1) return { ok: false }; // zero or more than one — never guess which
  return { ok: true, teamMemberId: active[0].id };
}

module.exports = { computeSilenceContext, lookupSingleDirectorOfOperations };
