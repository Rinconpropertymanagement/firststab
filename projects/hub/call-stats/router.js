/**
 * call-stats/router.js
 * Call Stats tool — a section of the Rincon Hub, built the same way
 * Insurance Compliance, Security Deposit, and Maintenance History were:
 * one router file, mounted into projects/hub/server.js, reusing the Hub's
 * existing login.
 *
 * Full spec: projects/hub/call-stats/SPEC.md — treat it as authoritative,
 * along with the header comments in
 * supabase/migrations/20260819010000_call_stats.sql (grain/column
 * decisions, live-verified Aircall API behavior) and
 * lib/aircall-connector.js (this build's own, further live verification).
 *
 * No AI, no `claims`, no review queue — this is a plain fetched-and-summed
 * fact, synced nightly, displayed read-only (SPEC.md Design Decision 3).
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const aircall = require('./lib/aircall-connector');
const { buildDailyAggregates, buildLineMissAggregates } = require('./lib/sync');
const { pacificDayBoundsUnix, yesterdayPacificDateStr } = require('./lib/timezone');
const { GLOBAL_SEARCH_WIDGET_HTML } = require('../lib/global-search-widget');

// ─── Config ─────────────────────────────────────────────────────────────
const missing = [];
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
if (missing.length > 0) {
  console.error(`[call-stats] Missing environment variables: ${missing.join(', ')}`);
  console.error('[call-stats] Set these in the shared .env at the project root (see .env.example).');
  process.exit(1);
}
// AIRCALL_API_ID / AIRCALL_API_TOKEN are checked lazily inside
// aircall-connector.js — a missing key shouldn't take down the whole Hub,
// only the nightly sync route that actually needs to call Aircall (same
// reasoning maintenance-history/router.js gives for LATCHEL_API_KEY).

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Pagination helper — Supabase/PostgREST caps any single .select() at
// 1000 rows by default, silently (no error). Same fix, same reasoning, as
// security-deposit/router.js's and maintenance-history/router.js's
// fetchAllRows.
const SUPABASE_PAGE_SIZE = 1000;
async function fetchAllRows(buildPage) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await buildPage(from, from + SUPABASE_PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data || []) rows.push(row);
    if (!data || data.length < SUPABASE_PAGE_SIZE) break;
    from += SUPABASE_PAGE_SIZE;
  }
  return rows;
}

// ─── Permission check — reads Neo's shared team tables ─────────────────
// Same fail-closed pattern as the other three tools' routers.
async function attachCallStatsRole(req, res, next) {
  req.callStatsRole = null;
  req.teamMemberId = null;
  req.callStatsMemberName = null;

  try {
    const { data: member, error: memberErr } = await supabase
      .from('team_members')
      .select('id, full_name, is_active')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (memberErr) throw memberErr;
    if (!member || !member.is_active) return next();

    req.teamMemberId = member.id;
    req.callStatsMemberName = member.full_name || null;

    const { data: roleRow, error: roleErr } = await supabase
      .from('team_member_tool_roles')
      .select('role')
      .eq('team_member_id', member.id)
      .eq('tool', 'call_stats')
      .maybeSingle();
    if (roleErr) throw roleErr;
    req.callStatsRole = roleRow ? roleRow.role : null;
    next();
  } catch (err) {
    console.error('[call-stats] permission lookup failed:', err.message);
    next();
  }
}

function requireCallStatsAccess(req, res, next) {
  if (!req.callStatsRole) {
    return res.status(403).json({
      error: 'Your Rincon Hub account does not have access to Call Stats yet. Ask an admin to grant you access.',
    });
  }
  next();
}

function requireCallStatsRole(...roles) {
  return (req, res, next) => {
    if (!req.callStatsRole || !roles.includes(req.callStatsRole)) {
      return res.status(403).json({ error: 'Insufficient permissions', required: roles, actual: req.callStatsRole });
    }
    next();
  };
}

// ─── Router: everyone reaching here is already hub-logged-in ───────────
const router = express.Router();
router.use(attachCallStatsRole);

// Same "read + inject the shared search widget, then send" approach as the
// other three tools' dashboard routes.
router.get('/call-stats', (req, res) => {
  fs.readFile(path.join(__dirname, 'dashboard', 'index.html'), 'utf8', (err, html) => {
    if (err) return res.status(500).send('Could not load page.');
    res.send(html.replace('<body>', '<body>\n' + GLOBAL_SEARCH_WIDGET_HTML));
  });
});

router.get('/api/call-stats/auth/me', requireCallStatsAccess, (req, res) => {
  res.json({
    email: req.user.email,
    name: req.callStatsMemberName || req.user.email,
    role: req.callStatsRole,
  });
});

// ─── GET /api/call-stats/stats?from=YYYY-MM-DD&to=YYYY-MM-DD ───────────
// SPEC.md's "v1 access is flat" (Access / Roles section) — anyone holding
// admin or pod_lead for tool='call_stats' sees BOTH pods, so there is no
// per-pod filtering here at all, same simplification already shipped for
// Security Deposit's pod_lead.
//
// Averages are computed here, live, from stored sums/counts — never
// stored pre-divided (Design Decision 2). "Calls" and "Avg. Length" blend
// both directions (an overall activity number); "Missed" and "Avg. Speed
// to Answer" are inbound-only, per the spec's explicit "don't present
// speed-to-answer as a staff performance number for outbound rows" and
// "'Missed' means inbound calls nobody picked up, not every call that
// didn't connect." `outbound_not_answered` is the outbound counterpart —
// same missed_calls column, opposite direction, deliberately a separate
// field rather than folded into inbound_missed_calls, since the spec is
// explicit that the two aren't the same signal (a vendor not picking up
// isn't a staff responsiveness problem the way an inbound miss is).
function isValidCalendarDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [year, month, day] = dateStr.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    !isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

router.get('/api/call-stats/stats', requireCallStatsAccess, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to || !isValidCalendarDate(from) || !isValidCalendarDate(to)) {
    return res.status(400).json({ error: 'from and to are required, each a valid YYYY-MM-DD date.' });
  }
  if (from > to) {
    return res.status(400).json({ error: '"from" must not be after "to".' });
  }

  let rows;
  try {
    rows = await fetchAllRows((rangeFrom, rangeTo) => supabase
      .from('call_stats')
      .select('aircall_user_id, staff_email, call_date, direction, total_calls, answered_calls, missed_calls, total_talk_seconds, total_ring_seconds, synced_at')
      .gte('call_date', from)
      .lte('call_date', to)
      .order('call_date', { ascending: true })
      .range(rangeFrom, rangeTo));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  // Pod (Solimar/Faria) is looked up here, at query time, never stored on
  // call_stats — Design Decision 1. Only the four "pod role" users have a
  // non-null pod. Everyone else's calls are still summed correctly below
  // and captured by the nightly sync regardless of pod — but historically
  // they simply didn't appear anywhere on this dashboard. That's the gap
  // this fetch (now unfiltered by pod) and the `Other` bucket below fix:
  // active staff with no pod (Business Development, Operations, Executive
  // — e.g. Kristen Rau) who have real call activity in the requested range
  // now show up too, in a third group, rather than being invisible.
  const { data: users, error: usersErr } = await supabase
    .from('users')
    .select('email, name, pod, is_active');
  if (usersErr) return res.status(500).json({ error: usersErr.message });
  const usersByEmail = new Map((users || []).map(u => [u.email.toLowerCase(), u]));

  const byEmail = new Map();
  let mostRecentSync = null;
  for (const r of rows) {
    if (r.synced_at && (!mostRecentSync || r.synced_at > mostRecentSync)) mostRecentSync = r.synced_at;

    let agg = byEmail.get(r.staff_email);
    if (!agg) {
      agg = {
        total_calls: 0, answered_calls: 0, total_talk_seconds: 0,
        inbound_answered_calls: 0, inbound_missed_calls: 0, inbound_total_ring_seconds: 0,
        outbound_not_answered: 0,
      };
      byEmail.set(r.staff_email, agg);
    }
    agg.total_calls += r.total_calls;
    agg.answered_calls += r.answered_calls;
    agg.total_talk_seconds += r.total_talk_seconds;
    if (r.direction === 'inbound') {
      agg.inbound_answered_calls += r.answered_calls;
      agg.inbound_missed_calls += r.missed_calls;
      agg.inbound_total_ring_seconds += r.total_ring_seconds;
    } else if (r.direction === 'outbound') {
      // NOT the same signal as inbound_missed_calls above — see this
      // route's own header comment and SPEC.md Design Decision 2. This is
      // a call a staff member PLACED that the other party never answered
      // (missed_calls on an outbound row, same column, different meaning
      // per-direction — SPEC.md line ~64). Not a staff responsiveness
      // problem the way an inbound miss is, so it's surfaced under its own
      // name everywhere (API field + dashboard column), never folded into
      // "Missed".
      agg.outbound_not_answered += r.missed_calls;
    }
  }

  const pods = { Solimar: [], Faria: [], Other: [] };
  for (const [email, agg] of byEmail.entries()) {
    const user = usersByEmail.get(email);
    if (!user) continue; // no known Rincon user for this email — not shown on this dashboard, per Design Decision 1
    const row = {
      name: user.name,
      email,
      total_calls: agg.total_calls,
      avg_length_seconds: agg.answered_calls > 0 ? Math.round(agg.total_talk_seconds / agg.answered_calls) : null,
      inbound_missed_calls: agg.inbound_missed_calls,
      avg_speed_to_answer_seconds: agg.inbound_answered_calls > 0 ? Math.round(agg.inbound_total_ring_seconds / agg.inbound_answered_calls) : null,
      outbound_not_answered: agg.outbound_not_answered,
    };
    if (user.pod && pods[user.pod]) {
      pods[user.pod].push(row);
    } else if (!user.pod && user.is_active) {
      // No pod (Business Development / Operations / Executive), but has
      // real call activity in this range — the `Other` bucket. Unlike
      // Solimar/Faria there's no fixed roster of "everyone not in a pod,"
      // so — deliberately, per this build's task — no zero-row placeholder
      // is invented here for someone with no activity; only real activity
      // earns a spot in `Other`.
      pods.Other.push(row);
    }
  }
  // Staff with a pod but zero call_stats rows in range still show up, with
  // all-zero numbers, rather than silently vanishing from their pod's
  // table — someone with genuinely no calls in a range is a real, useful
  // answer, not the same as "we have no data on this person at all."
  // (Only applies to Solimar/Faria — see the `Other` comment above for why
  // this same placeholder treatment doesn't extend there.)
  for (const user of users || []) {
    if (byEmail.has(user.email.toLowerCase())) continue;
    if (!pods[user.pod]) continue;
    pods[user.pod].push({
      name: user.name, email: user.email.toLowerCase(),
      total_calls: 0, avg_length_seconds: null, inbound_missed_calls: 0, avg_speed_to_answer_seconds: null,
      outbound_not_answered: 0,
    });
  }
  pods.Solimar.sort((a, b) => a.name.localeCompare(b.name));
  pods.Faria.sort((a, b) => a.name.localeCompare(b.name));
  pods.Other.sort((a, b) => a.name.localeCompare(b.name));

  // Shared-line misses (call_stats_line_misses) — the user:null calls
  // buildDailyAggregates()/call_stats has no grain to hold at all (see
  // lib/sync.js's buildLineMissAggregates and its migration header).
  // Same date range this route already queried call_stats with, reusing
  // whichever preset/custom range the dashboard is currently showing —
  // no separate picker for this section. Summed across direction: this
  // dashboard section is "how many calls did this shared line miss," not
  // a per-direction breakdown, so inbound+outbound are combined per line
  // for display, same simplification the pod tables' totals don't need
  // since call_stats already reduced to person-level there.
  let lineMissRows;
  try {
    lineMissRows = await fetchAllRows((rangeFrom, rangeTo) => supabase
      .from('call_stats_line_misses')
      .select('aircall_number_id, line_name, line_digits, call_date, direction, total_calls, missed_calls')
      .gte('call_date', from)
      .lte('call_date', to)
      .range(rangeFrom, rangeTo));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  const lineMissesByNumber = new Map();
  for (const r of lineMissRows) {
    let agg = lineMissesByNumber.get(r.aircall_number_id);
    if (!agg) {
      agg = { aircall_number_id: r.aircall_number_id, line_name: r.line_name, line_digits: r.line_digits, total_calls: 0, missed_calls: 0 };
      lineMissesByNumber.set(r.aircall_number_id, agg);
    }
    agg.total_calls += r.total_calls;
    agg.missed_calls += r.missed_calls;
  }
  const lineMisses = Array.from(lineMissesByNumber.values()).sort((a, b) => b.missed_calls - a.missed_calls);

  return res.json({ from, to, synced_at: mostRecentSync, pods, line_misses: lineMisses });
});

// ─── /api/call-stats/users — admin-only role management ─────────────────
// Mirrors the other three tools' admin endpoints exactly, scoped to
// tool='call_stats'. Both role values (admin, pod_lead) are already live
// in team_member_tool_roles_role_check — no schema change needed to add
// either one for this tool (SPEC.md "Access / Roles in the Hub").
const VALID_ROLES = ['admin', 'pod_lead'];
const ALLOWED_DOMAIN = 'rinconmanagement.com';

router.get('/api/call-stats/users', requireCallStatsRole('admin'), async (req, res) => {
  const { data, error } = await supabase
    .from('team_member_tool_roles')
    .select('role, granted_by, granted_at, team_members ( email, full_name )')
    .eq('tool', 'call_stats')
    .order('granted_at');
  if (error) return res.status(500).json({ error: error.message });
  const rows = (data || [])
    .filter(r => r.team_members)
    .map(r => ({
      email: r.team_members.email,
      name: r.team_members.full_name || null,
      role: r.role,
      assigned_by: r.granted_by,
      granted_at: r.granted_at,
    }));
  return res.json(rows);
});

router.post('/api/call-stats/users', requireCallStatsRole('admin'), async (req, res) => {
  const { email, role } = req.body;
  if (!email || !role) return res.status(400).json({ error: 'email and role are required.' });

  const normalizedEmail = String(email).toLowerCase().trim();
  if (!normalizedEmail.endsWith('@' + ALLOWED_DOMAIN)) {
    return res.status(400).json({ error: 'Only @' + ALLOWED_DOMAIN + ' accounts allowed.' });
  }
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });

  const { data: member, error: memberErr } = await supabase
    .from('team_members')
    .select('id')
    .eq('email', normalizedEmail)
    .maybeSingle();
  if (memberErr) return res.status(500).json({ error: memberErr.message });
  if (!member) {
    return res.status(400).json({
      error: `${normalizedEmail} hasn't logged into the Rincon Hub yet. Ask them to log in once (same email + password as every other hub tool), then try granting access again.`,
    });
  }

  const { error: upsertErr } = await supabase
    .from('team_member_tool_roles')
    .upsert({
      team_member_id: member.id,
      tool: 'call_stats',
      role,
      granted_by: req.user.email,
      granted_at: new Date().toISOString(),
    }, { onConflict: 'team_member_id,tool' });
  if (upsertErr) return res.status(500).json({ error: upsertErr.message });

  await supabase.from('audit_log').insert({
    action: 'team_member.role_changed',
    entity_type: 'team_member',
    entity_id: member.id,
    details: { tool: 'call_stats', old_role: null, new_role: role, changed_by: req.user.email },
  });

  return res.json({ success: true });
});

router.patch('/api/call-stats/users/:email', requireCallStatsRole('admin'), async (req, res) => {
  const { role } = req.body;
  const targetEmail = String(req.params.email || '').toLowerCase().trim();
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });

  const { data: member, error: memberErr } = await supabase
    .from('team_members')
    .select('id')
    .eq('email', targetEmail)
    .maybeSingle();
  if (memberErr) return res.status(500).json({ error: memberErr.message });
  if (!member) return res.status(404).json({ error: `${targetEmail} is not a Rincon Hub team member.` });

  const { data: existing } = await supabase
    .from('team_member_tool_roles')
    .select('role')
    .eq('team_member_id', member.id)
    .eq('tool', 'call_stats')
    .maybeSingle();
  const oldRole = existing ? existing.role : null;

  const { error: upsertErr } = await supabase
    .from('team_member_tool_roles')
    .upsert({
      team_member_id: member.id,
      tool: 'call_stats',
      role,
      granted_by: req.user.email,
      granted_at: new Date().toISOString(),
    }, { onConflict: 'team_member_id,tool' });
  if (upsertErr) return res.status(500).json({ error: upsertErr.message });

  await supabase.from('audit_log').insert({
    action: 'team_member.role_changed',
    entity_type: 'team_member',
    entity_id: member.id,
    details: { tool: 'call_stats', old_role: oldRole, new_role: role, changed_by: req.user.email },
  });

  return res.json({ success: true });
});

router.delete('/api/call-stats/users/:email', requireCallStatsRole('admin'), async (req, res) => {
  const targetEmail = String(req.params.email || '').toLowerCase().trim();
  if (targetEmail === req.user.email.toLowerCase()) {
    return res.status(400).json({ error: 'You cannot remove your own access.' });
  }

  const { data: member, error: memberErr } = await supabase
    .from('team_members')
    .select('id')
    .eq('email', targetEmail)
    .maybeSingle();
  if (memberErr) return res.status(500).json({ error: memberErr.message });
  if (!member) return res.status(404).json({ error: `${targetEmail} is not a Rincon Hub team member.` });

  const { data: existing } = await supabase
    .from('team_member_tool_roles')
    .select('role')
    .eq('team_member_id', member.id)
    .eq('tool', 'call_stats')
    .maybeSingle();

  const { error } = await supabase
    .from('team_member_tool_roles')
    .delete()
    .eq('team_member_id', member.id)
    .eq('tool', 'call_stats');
  if (error) return res.status(500).json({ error: error.message });

  await supabase.from('audit_log').insert({
    action: 'team_member.role_changed',
    entity_type: 'team_member',
    entity_id: member.id,
    details: { tool: 'call_stats', old_role: existing ? existing.role : null, new_role: null, changed_by: req.user.email },
  });

  return res.json({ success: true });
});

// ─── internalRouter: no login required — own shared-secret check ────────
const internalRouter = express.Router();

function checkCronSecret(req, res) {
  const secret = req.headers['x-cron-secret'];
  if (!secret || secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/**
 * POST /api/call-stats/internal/sync?date=YYYY-MM-DD
 * The nightly job. GET-only against Aircall (see aircall-connector.js).
 * Defaults to "yesterday" in Rincon's own Pacific business day — the spec's
 * "pulls the previous day's calls" — but accepts an explicit ?date= for a
 * manual backfill/rerun of a specific day, same escape hatch
 * maintenance-history's ?since_days= gives its own nightly job.
 */
internalRouter.post('/api/call-stats/internal/sync', async (req, res) => {
  if (!checkCronSecret(req, res)) return;
  const ts = new Date().toISOString();

  const dateStr = req.query.date || yesterdayPacificDateStr();
  if (!isValidCalendarDate(dateStr)) {
    return res.status(400).json({ error: '?date must be a valid YYYY-MM-DD date.' });
  }
  const { from, to } = pacificDayBoundsUnix(dateStr);

  console.log(`[${ts}] call-stats sync: pulling Aircall calls for Pacific day ${dateStr} (unix ${from}-${to})...`);

  let calls;
  try {
    calls = await aircall.listCallsForDateRange(from, to);
  } catch (err) {
    console.error(`[${ts}] call-stats sync: Aircall fetch failed:`, err.message);
    return res.status(502).json({ error: 'Failed to pull calls from Aircall.', detail: err.message });
  }

  // Every Rincon staff email, portfolio-wide, no filter — this is the
  // match target every call.user.email gets checked against (Design
  // Decision 1). Not filtered to pod IS NOT NULL: a call from a real
  // Rincon employee outside the four pod roles (e.g. the CEO) still
  // belongs to a real person and gets written to call_stats — it simply
  // won't render on this dashboard's two pod tables, same as the stats
  // route above.
  let userRows;
  try {
    userRows = await fetchAllRows((rangeFrom, rangeTo) => supabase
      .from('users')
      .select('id, email')
      .order('id', { ascending: true })
      .range(rangeFrom, rangeTo));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
  const usersByEmail = new Map((userRows || []).map(u => [u.email.toLowerCase(), u]));

  const { rows, summary } = buildDailyAggregates(calls, usersByEmail);

  let upserted = 0;
  const upsertErrors = [];
  for (const row of rows) {
    const { error } = await supabase
      .from('call_stats')
      .upsert({ ...row, synced_at: new Date().toISOString() }, { onConflict: 'aircall_user_id,call_date,direction' });
    if (error) {
      upsertErrors.push({ key: `${row.aircall_user_id}|${row.call_date}|${row.direction}`, error: error.message });
    } else {
      upserted++;
    }
  }

  // Same `calls` array, second aggregation pass — the shared-line-miss
  // rows buildDailyAggregates() has no grain to represent (its own
  // calls_unattributed_no_user count above). No second Aircall fetch.
  const { rows: lineMissRows, summary: lineMissSummary } = buildLineMissAggregates(calls);

  let lineMissesUpserted = 0;
  const lineMissUpsertErrors = [];
  for (const row of lineMissRows) {
    const { error } = await supabase
      .from('call_stats_line_misses')
      .upsert({ ...row, synced_at: new Date().toISOString() }, { onConflict: 'aircall_number_id,call_date,direction' });
    if (error) {
      lineMissUpsertErrors.push({ key: `${row.aircall_number_id}|${row.call_date}|${row.direction}`, error: error.message });
    } else {
      lineMissesUpserted++;
    }
  }

  const result = {
    date: dateStr,
    ...summary,
    rows_upserted: upserted,
    upsert_errors: upsertErrors,
    line_misses: {
      ...lineMissSummary,
      rows_upserted: lineMissesUpserted,
      upsert_errors: lineMissUpsertErrors,
    },
  };
  console.log(`[${ts}] call-stats sync done:`, JSON.stringify(result));
  return res.json(result);
});

module.exports = { router, internalRouter };
