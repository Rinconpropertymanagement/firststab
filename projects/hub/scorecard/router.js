/**
 * scorecard/router.js
 * The Scoreboard — a section of the Rincon Hub, built the same way Insurance
 * Compliance, Security Deposit, Maintenance History and Call Stats were: one
 * router file mounted into projects/hub/server.js, reusing the Hub's login.
 *
 * Storage and the reasoning behind every column:
 *   supabase/migrations/20260912000000_scorecard_weekly.sql
 * Final metric definitions (these supersede the spec):
 *   projects/hub/call-stats/COMMITTED-NOT-BUILT.md §0a
 *
 * *** CALL STATS IS NOT TOUCHED BY ANY OF THIS. *** It shipped 2026-09-12 and
 * is live on Sally. This section reads one new table and shares nothing with
 * it but the Hub's login and one read-only import of its timezone primitive.
 *
 * ============================================================
 * FIVE READING RULES THE SCHEMA CANNOT ENFORCE
 * ============================================================
 *  1. RATES ARE DIVIDED AT READ TIME, and a rolling window is
 *     SUM(numerator)/SUM(denominator) over the week rows — NEVER a mean of
 *     weekly percentages. Weekly rates of 114% and 20% average to 67%; the
 *     honest four-week rate over those rows is a different number.
 *  2. A FAILED WEEK WRITES NO ROW, so "the last 4 rows" is not "the last 4
 *     weeks". Every window reports how many weeks it actually covered, and
 *     the first three weeks of the Scoreboard's life have no 4-week window
 *     at all.
 *  3. A 'statistic' ROW IS NEVER AGGREGATED. The average column renders an
 *     em-dash, driven off `metric_shape` — never off a hard-coded metric
 *     name.
 *  4. DENOMINATOR 0 IS LEGAL. A week with no leads created is not a 0% week.
 *     The division is guarded and renders an em-dash.
 *  5. A MISSING WEEK IS BLANK, NOT ZERO.
 * ============================================================
 *
 * ============================================================
 * THE OWNER ON THE PAGE COMES FROM THE ROW, NOT FROM A LOOKUP
 * ============================================================
 * `owner_email` is stored on every row and frozen there. The join to `users`
 * below is for a display NAME only and tolerates a miss — and it deliberately
 * does NOT filter on `is_active`. If it did, an owner going inactive would
 * hide their metric rows, which is exactly the silent disappearance
 * COMMITTED-NOT-BUILT.md §3's standing rule exists to prevent. The row is the
 * record; the join is decoration.
 * ============================================================
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const { METRICS, METRIC_OWNERS, SCORECARD_TOOL, SCORECARD_READ_ROLES, SEQUENCE_DEPTH_WEEK_RULE, SEQUENCE_DEPTH_HOLD_DAYS } = require('./lib/config');
const { computeAll, writeRows } = require('./lib/compute-week');
const { mondayOf, addDays, latestPublishableWeek, weeksEndingAt } = require('./lib/week');
const { GLOBAL_SEARCH_WIDGET_HTML } = require('../lib/global-search-widget');
const hubspotLeadsConnector = require('./lib/hubspot-leads-connector');
const {
  findFailingContactsForWeek,
  findFailingDealsForWeek,
  findLeadDetailsForWeek,
  findFollowupTouchesForWeek,
  findReengagementAttemptsForWeek,
  findLostDealsAddedToSequenceForWeek,
} = require('./lib/metrics');

// `mondayOf()` assumes it is handed a parseable YYYY-MM-DD string and throws
// (RangeError) on anything else — a malformed `week` query param must be
// rejected here, before mondayOf ever sees it, so a bad request 400s instead
// of throwing past the route's try/catch as an unhandled rejection. A
// date-shaped-but-wrong-weekday string (e.g. a real Tuesday) is intentionally
// let through so it still reaches mondayOf's own "must be a Monday" check.
function isParsableIsoDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str) && !Number.isNaN(new Date(str).getTime());
}

// ─── Config ─────────────────────────────────────────────────────────────
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[scorecard] Missing environment variable: SUPABASE_SERVICE_ROLE_KEY');
  console.error('[scorecard] Set it in the shared .env at the project root (see .env.example).');
  process.exit(1);
}
// HUBSPOT_PRIVATE_APP_TOKEN is checked lazily inside the connector — a
// missing key must only break the weekly compute route, never the rest of
// the Hub. Same reasoning call-stats/router.js gives for the Aircall keys.

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const DEFAULT_WEEKS_SHOWN = 8;
const MAX_WEEKS_SHOWN = 52;

// ─── Permission check ───────────────────────────────────────────────────
// Same fail-closed pattern as every other tool's router.
async function attachScorecardRole(req, res, next) {
  req.scorecardRole = null;
  req.scorecardMemberName = null;

  try {
    const { data: member, error: memberErr } = await supabase
      .from('team_members')
      .select('id, full_name, is_active')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (memberErr) throw memberErr;
    if (!member || !member.is_active) return next();

    req.scorecardMemberName = member.full_name || null;

    const { data: roleRow, error: roleErr } = await supabase
      .from('team_member_tool_roles')
      .select('role')
      .eq('team_member_id', member.id)
      .eq('tool', SCORECARD_TOOL)
      .maybeSingle();
    if (roleErr) throw roleErr;
    req.scorecardRole = roleRow ? roleRow.role : null;
    next();
  } catch (err) {
    console.error('[scorecard] permission lookup failed:', err.message);
    next();
  }
}

function requireScorecardAccess(req, res, next) {
  if (!req.scorecardRole || !SCORECARD_READ_ROLES.includes(req.scorecardRole)) {
    return res.status(403).json({
      error: 'Your Rincon Hub account does not have access to the Scoreboard yet. Ask an admin to grant you access.',
    });
  }
  next();
}

// ─── Read-time arithmetic ───────────────────────────────────────────────

/**
 * SUM(numerator)/SUM(denominator) over the rows that exist in the `n`
 * calendar weeks ending at `weekStart`.
 *
 * Reports `weeksRequested` and `weeksCovered` separately and always. They
 * differ whenever a week failed to compute (no row) or the Scoreboard has
 * not been running long enough. The page must show the difference — a window
 * computed over 3 rows while the label claims 4 is a confidently wrong
 * number, and it is invisible unless counted.
 */
function buildRollingWindow(rowsByWeek, weekStart, n) {
  let numerator = 0;
  let denominator = 0;
  let weeksCovered = 0;
  for (let i = 0; i < n; i++) {
    const row = rowsByWeek.get(addDays(weekStart, -7 * i));
    if (!row) continue;
    weeksCovered++;
    numerator += row.numerator || 0;
    denominator += row.denominator || 0;
  }
  return {
    numerator,
    denominator,
    // Guarded: a denominator of 0 is a real answer meaning "no leads were
    // created", not a 0% week. null renders as an em-dash.
    rate: denominator === 0 ? null : numerator / denominator,
    weeksRequested: n,
    weeksCovered,
    complete: weeksCovered === n,
  };
}

/**
 * The trend layout's average column, for one metric across the weeks shown.
 *
 * Returns null — an em-dash on the page — for any non-aggregable row. That
 * decision is driven off `metric_shape`, never off a metric name: a median
 * of four weeks is not the average of four weekly medians and no arithmetic
 * on the stored values recovers it.
 */
function buildAverage(definition, rows) {
  if (!definition.aggregable || definition.shape === 'statistic') {
    return { value: null, reason: 'A median cannot be combined across weeks.', weeksCovered: rows.length };
  }
  if (definition.shape === 'rate') {
    const numerator = rows.reduce((a, r) => a + (r.numerator || 0), 0);
    const denominator = rows.reduce((a, r) => a + (r.denominator || 0), 0);
    return {
      value: denominator === 0 ? null : numerator / denominator,
      numerator,
      denominator,
      weeksCovered: rows.length,
    };
  }
  if (!rows.length) return { value: null, weeksCovered: 0 };
  return {
    value: rows.reduce((a, r) => a + (r.numerator || 0), 0) / rows.length,
    weeksCovered: rows.length,
  };
}

// ─── Router ─────────────────────────────────────────────────────────────
const router = express.Router();
router.use(attachScorecardRole);

router.get('/scorecard', (req, res) => {
  fs.readFile(path.join(__dirname, 'dashboard', 'index.html'), 'utf8', (err, html) => {
    if (err) return res.status(500).send('Could not load page.');
    res.send(html.replace('<body>', '<body>\n' + GLOBAL_SEARCH_WIDGET_HTML));
  });
});

router.get('/api/scorecard/auth/me', requireScorecardAccess, (req, res) => {
  res.json({
    email: req.user.email,
    name: req.scorecardMemberName || req.user.email,
    role: req.scorecardRole,
  });
});

/**
 * GET /api/scorecard/metrics?weeks=8
 *
 * One query — "every metric, last N weeks" — grouped here into the trend
 * layout: metrics down the left, periods across, an average column.
 */
router.get('/api/scorecard/metrics', requireScorecardAccess, async (req, res) => {
  const requested = Number(req.query.weeks || DEFAULT_WEEKS_SHOWN);
  const weeksShown = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), MAX_WEEKS_SHOWN) : DEFAULT_WEEKS_SHOWN;

  const lastWeek = latestPublishableWeek(0);
  // Pull extra weeks beyond the display range so a rolling window on the
  // OLDEST displayed week still has its earlier weeks to sum. Without this
  // the left-hand column of the page would silently be a 1-week window
  // labelled as a 4-week one.
  const maxRolling = Math.max(...METRICS.map((m) => m.rollingWeeks || 1));
  const fetchFrom = addDays(lastWeek, -7 * (weeksShown + maxRolling));

  const { data, error } = await supabase
    .from('scorecard_weekly')
    .select('metric_key, metric_shape, week_start, owner_email, numerator, denominator, value_numeric, sample_size, computed_at')
    .gte('week_start', fetchFrom)
    .order('week_start', { ascending: true });

  if (error) {
    console.error('[scorecard] metrics read failed:', error.message);
    return res.status(500).json({ error: 'Could not load the Scoreboard.' });
  }

  const rows = data || [];

  // Display name for each owner, best-effort. NOT filtered on is_active —
  // see this file's header.
  const ownerEmails = [...new Set(rows.map((r) => r.owner_email))];
  const namesByEmail = new Map();
  if (ownerEmails.length) {
    // The users table's name column is `name`, not `full_name` -- this
    // query asked for a column that has never existed, so it silently
    // returned no rows and ownerName has been null for every metric since
    // launch, with the page falling back to the raw email every time.
    // Found and fixed 2026-09-13.
    const { data: users } = await supabase.from('users').select('email, name').in('email', ownerEmails);
    for (const u of users || []) namesByEmail.set(u.email, u.name);
  }

  const weeks = weeksEndingAt(lastWeek, weeksShown);

  const metrics = METRICS.map((definition) => {
    const all = rows.filter((r) => r.metric_key === definition.key);
    const byWeek = new Map(all.map((r) => [r.week_start, r]));
    const shown = weeks.map((w) => byWeek.get(w)).filter(Boolean);
    const latest = all.length ? all[all.length - 1] : null;

    return {
      key: definition.key,
      label: definition.label,
      shape: definition.shape,
      display: definition.display,
      higherIsBetter: definition.higherIsBetter,
      aggregable: definition.aggregable,
      note: definition.note,
      numeratorLabel: definition.numeratorLabel || null,
      denominatorLabel: definition.denominatorLabel || null,
      ownerEmail: latest ? latest.owner_email : null,
      ownerName: latest ? namesByEmail.get(latest.owner_email) || null : null,
      // Every row carries its OWN week. Sequence depth publishes an earlier
      // week than the other five (it holds 7 days), so the page must label
      // rows individually and never stack them under one date header.
      latestWeek: latest ? latest.week_start : null,
      cells: weeks.map((week) => {
        const row = byWeek.get(week);
        const cell = { week, present: Boolean(row) };
        if (!row) return cell; // a missing week is BLANK, not zero
        cell.numerator = row.numerator;
        cell.denominator = row.denominator;
        cell.valueNumeric = row.value_numeric === null ? null : Number(row.value_numeric);
        cell.sampleSize = row.sample_size;
        cell.rate = row.metric_shape === 'rate'
          ? (row.denominator === 0 ? null : row.numerator / row.denominator)
          : null;
        if (definition.display === 'rolling_rate') {
          cell.rolling = buildRollingWindow(byWeek, week, definition.rollingWeeks);
        }
        return cell;
      }),
      average: buildAverage(definition, shown),
    };
  });

  res.json({
    weeks,
    metrics,
    // The Scoreboard cannot be backfilled — stage-exit history for leads
    // that have since moved on does not survive — so it starts from the
    // first Monday it ran and the page says so.
    countedFrom: rows.length ? rows[0].week_start : null,
    sequenceDepth: {
      weekRule: SEQUENCE_DEPTH_WEEK_RULE,
      holdDays: SEQUENCE_DEPTH_HOLD_DAYS,
    },
  });
});

// HubSpot's own object-type ids for building a record link — fixed and
// documented publicly by HubSpot, not something this portal configures.
const CONTACT_OBJECT_TYPE_ID = '0-1';
const DEAL_OBJECT_TYPE_ID = '0-3';
// Leads: '0-136', confirmed live 2026-09-13 — see LIVE VERIFICATION point 11
// in hubspot-leads-connector.js for how, since this portal's own token
// cannot read the schema endpoint that would confirm it directly.
const LEAD_OBJECT_TYPE_ID = '0-136';

function hubspotRecordUrl(portalId, objectTypeId, objectId) {
  return `https://app.hubspot.com/contacts/${portalId}/record/${objectTypeId}/${objectId}`;
}

// Leads do NOT use the `/record/{typeId}/{id}` shape above — confirmed live
// 2026-09-13 (same source as the type id itself, see LIVE VERIFICATION point
// 11): a lead opens as `/objects/{typeId}/views/all/list?leadId={id}`, a
// list view with the record as a side panel, not a standalone record page.
function hubspotLeadUrl(portalId, leadId) {
  return `https://app.hubspot.com/contacts/${portalId}/objects/${LEAD_OBJECT_TYPE_ID}/views/all/list?leadId=${leadId}`;
}

// A task's URL is a THIRD shape, neither the contact/deal record shape nor
// the lead list-view shape above — confirmed live 2026-09-13 against a real
// task, see hubspot-leads-connector.js's LIVE VERIFICATION point 12.
function hubspotTaskUrl(portalId, taskId) {
  return `https://app.hubspot.com/tasks/${portalId}/view/all/task/${taskId}`;
}

/**
 * GET /api/scorecard/crm-completeness/detail?type=contacts|deals&week=YYYY-MM-DD
 *
 * *** THIS ENDPOINT PUTS REAL PEOPLE'S NAMES AND LIVE HUBSPOT RECORD LINKS
 * IN THE BROWSER. *** It exists so a human looking at a bad completeness
 * week can see which records to go fix, without hand-searching HubSpot for
 * them. Same discipline as the rest of the Scoreboard and the connector's
 * own CRITICAL header: this reads HubSpot LIVE on every single call and
 * hands the result straight back in the response. Nothing it returns is
 * written anywhere — no table, no cache, no log line carrying a name or an
 * id. That is the exact "no outside-individual identifier persists"
 * property Asimov's condition on this Scoreboard protects for the stored
 * weekly rows; here it is kept by never storing this output at all, rather
 * than by not producing it. If you are the next person to touch this route:
 * display-only, live-only, never stored.
 *
 * Reuses computeCrmContactCompleteness/computeCrmDealCompleteness's own
 * population query and scoring rule (via findFailingContactsForWeek /
 * findFailingDealsForWeek in lib/metrics.js) rather than a second
 * implementation — so the count this returns can never silently disagree
 * with the percentage stored on the Scoreboard for the same week.
 */
router.get('/api/scorecard/crm-completeness/detail', requireScorecardAccess, async (req, res) => {
  const type = String(req.query.type || '');
  if (type !== 'contacts' && type !== 'deals') {
    return res.status(400).json({ error: 'type must be "contacts" or "deals".' });
  }
  const week = String(req.query.week || '');
  if (!week || !isParsableIsoDate(week) || mondayOf(week) !== week) {
    return res.status(400).json({ error: 'week must be a Monday (Pacific), formatted YYYY-MM-DD.' });
  }

  try {
    const portalId = await hubspotLeadsConnector.getPortalId();

    if (type === 'contacts') {
      const { population, failing } = await findFailingContactsForWeek(hubspotLeadsConnector, week);
      return res.json({
        type: 'contacts',
        week,
        population,
        failingCount: failing.length,
        failing: failing.map((f) => ({
          name: f.name,
          url: hubspotRecordUrl(portalId, CONTACT_OBJECT_TYPE_ID, f.id),
          missingFields: f.missingFields,
        })),
      });
    }

    const { population, failing } = await findFailingDealsForWeek(hubspotLeadsConnector, week);
    return res.json({
      type: 'deals',
      week,
      population,
      failingCount: failing.length,
      failing: failing.map((f) => ({
        name: f.name,
        url: hubspotRecordUrl(portalId, DEAL_OBJECT_TYPE_ID, f.id),
        closed: f.closed,
        missingFields: f.missingFields,
      })),
    });
  } catch (err) {
    console.error('[scorecard] crm-completeness detail failed:', err.message);
    // No trailing "try again" here — the page appends that once itself so
    // the message is never duplicated on screen.
    res.status(500).json({ error: 'Could not read HubSpot for this week.' });
  }
});

/**
 * GET /api/scorecard/booking-rate/detail?week=YYYY-MM-DD
 *
 * Same discipline as /api/scorecard/crm-completeness/detail directly above —
 * read this file's header comment on that route first, it all applies here
 * unchanged: reads HubSpot LIVE on every call, nothing it returns is written
 * anywhere, display-only.
 *
 * What's different: lead → discovery call is a RATE, not a pass/fail check,
 * so there is no "failing" population here — every lead returned is a
 * legitimate record. `findLeadDetailsForWeek` (lib/metrics.js) reuses
 * computeLeadToDiscoveryCallRate's own population/numerator calls, so
 * `population` and `convertedCount` below equal the stored denominator and
 * numerator for the week EXACTLY — see that function's header for why the
 * per-lead `convertedToDeal` flags do NOT sum to `convertedCount` (a deal
 * created this week can belong to a lead created a different week) and must
 * never be presented as if they did.
 */
router.get('/api/scorecard/booking-rate/detail', requireScorecardAccess, async (req, res) => {
  const week = String(req.query.week || '');
  if (!week || !isParsableIsoDate(week) || mondayOf(week) !== week) {
    return res.status(400).json({ error: 'week must be a Monday (Pacific), formatted YYYY-MM-DD.' });
  }

  try {
    const portalId = await hubspotLeadsConnector.getPortalId();
    const { population, convertedCount, leads, diagnostics } = await findLeadDetailsForWeek(hubspotLeadsConnector, week);

    res.json({
      week,
      population,
      convertedCount,
      leads: leads.map((l) => ({
        name: l.name,
        createdDate: l.createdDate,
        stage: l.stage,
        url: hubspotLeadUrl(portalId, l.id),
        convertedToDeal: l.convertedToDeal,
      })),
      diagnostics,
    });
  } catch (err) {
    console.error('[scorecard] booking-rate detail failed:', err.message);
    // No trailing "try again" here — the page appends that once itself so
    // the message is never duplicated on screen.
    res.status(500).json({ error: 'Could not read HubSpot for this week.' });
  }
});

/**
 * GET /api/scorecard/followup-touches/detail?type=worked|automation&week=YYYY-MM-DD
 *
 * Same discipline as the two drill-downs above — read this file's header
 * comment on crm-completeness/detail first, it all applies here unchanged:
 * reads HubSpot LIVE on every call, nothing it returns is written anywhere,
 * display-only.
 *
 * One route for both metrics, `type` selecting which half of
 * findFollowupTouchesForWeek's single pass to serve — the same shape
 * crm-completeness/detail already uses for its `type=contacts|deals`, not
 * two near-identical route handlers for what is one function's two outputs.
 *
 * Every task returned is a legitimate touch, same framing as the
 * booking-rate drill-down: this is activity, not a defect list, so there is
 * no "failing" population here.
 */
router.get('/api/scorecard/followup-touches/detail', requireScorecardAccess, async (req, res) => {
  const type = String(req.query.type || '');
  if (type !== 'worked' && type !== 'automation') {
    return res.status(400).json({ error: 'type must be "worked" or "automation".' });
  }
  const week = String(req.query.week || '');
  if (!week || !isParsableIsoDate(week) || mondayOf(week) !== week) {
    return res.status(400).json({ error: 'week must be a Monday (Pacific), formatted YYYY-MM-DD.' });
  }

  try {
    const portalId = await hubspotLeadsConnector.getPortalId();
    // Both metrics share one owner (METRIC_OWNERS — see config.js), resolved
    // live rather than hardcoded, exactly like compute-week.js does for the
    // stored aggregate.
    const ownerHubspotId = await hubspotLeadsConnector.resolveOwnerIdByEmail(METRIC_OWNERS.followup_touches_worked);
    if (!ownerHubspotId) {
      return res.status(500).json({ error: 'Could not resolve the metric owner in HubSpot.' });
    }

    const { worked, automation, diagnostics } = await findFollowupTouchesForWeek(hubspotLeadsConnector, week, ownerHubspotId);
    const half = type === 'worked' ? worked : automation;

    res.json({
      type,
      week,
      count: half.count,
      tasks: half.tasks.map((t) => ({
        subject: t.subject,
        sourceLabel: t.sourceLabel,
        completedDate: t.completedDate,
        contactName: t.contactName,
        url: hubspotTaskUrl(portalId, t.id),
      })),
      diagnostics,
    });
  } catch (err) {
    console.error('[scorecard] followup-touches detail failed:', err.message);
    // No trailing "try again" here — the page appends that once itself so
    // the message is never duplicated on screen.
    res.status(500).json({ error: 'Could not read HubSpot for this week.' });
  }
});

/**
 * GET /api/scorecard/reengagement/detail?week=YYYY-MM-DD
 *
 * Same discipline as the drill-downs above — read this file's header
 * comment on crm-completeness/detail first, it all applies here unchanged:
 * reads HubSpot LIVE on every call, nothing it returns is written anywhere,
 * display-only.
 *
 * Every task returned is a legitimate re-engagement attempt, same framing as
 * the booking-rate and follow-up-touches drill-downs: this is activity, not
 * a defect list, so there is no "failing" population here.
 * `findReengagementAttemptsForWeek` (lib/metrics.js) reuses
 * computeReengagementAttempts's own population/filter calls, so `count`
 * below equals the stored numerator for the week EXACTLY.
 */
router.get('/api/scorecard/reengagement/detail', requireScorecardAccess, async (req, res) => {
  const week = String(req.query.week || '');
  if (!week || !isParsableIsoDate(week) || mondayOf(week) !== week) {
    return res.status(400).json({ error: 'week must be a Monday (Pacific), formatted YYYY-MM-DD.' });
  }

  try {
    const portalId = await hubspotLeadsConnector.getPortalId();
    const { count, tasks, diagnostics } = await findReengagementAttemptsForWeek(hubspotLeadsConnector, week);

    res.json({
      week,
      count,
      tasks: tasks.map((t) => ({
        subject: t.subject,
        completedDate: t.completedDate,
        contactName: t.contactName,
        url: hubspotTaskUrl(portalId, t.id),
      })),
      diagnostics,
    });
  } catch (err) {
    console.error('[scorecard] reengagement detail failed:', err.message);
    // No trailing "try again" here — the page appends that once itself so
    // the message is never duplicated on screen.
    res.status(500).json({ error: 'Could not read HubSpot for this week.' });
  }
});

/**
 * GET /api/scorecard/lost-deals-sequence/detail?week=YYYY-MM-DD
 *
 * Same discipline as the drill-downs above — read this file's header
 * comment on crm-completeness/detail first, it all applies here unchanged:
 * reads HubSpot LIVE on every call, nothing it returns is written anywhere,
 * display-only.
 *
 * Every contact returned is a legitimate new enrollment, same framing as the
 * booking-rate/follow-up-touches/reengagement drill-downs above: this is
 * activity, not a defect list. `findLostDealsAddedToSequenceForWeek`
 * (lib/metrics.js) reuses computeLostDealsAddedToSequence's own population
 * call and per-contact-earliest grouping — the exact same
 * listTasksForSequenceIds(TRACKED_SEQUENCE_IDS) read — so `count` below
 * equals the stored numerator for `lost_deals_added_to_sequence` for this
 * week EXACTLY. Uses the same contact record URL shape
 * (hubspotRecordUrl + CONTACT_OBJECT_TYPE_ID) the CRM-completeness and
 * booking-rate drill-downs already confirmed live — no new URL discovery.
 */
router.get('/api/scorecard/lost-deals-sequence/detail', requireScorecardAccess, async (req, res) => {
  const week = String(req.query.week || '');
  if (!week || !isParsableIsoDate(week) || mondayOf(week) !== week) {
    return res.status(400).json({ error: 'week must be a Monday (Pacific), formatted YYYY-MM-DD.' });
  }

  try {
    const portalId = await hubspotLeadsConnector.getPortalId();
    const { count, contacts, diagnostics } = await findLostDealsAddedToSequenceForWeek(hubspotLeadsConnector, week);

    res.json({
      week,
      count,
      contacts: contacts.map((c) => ({
        name: c.name,
        enteredDate: c.enteredDate,
        sequenceLabel: c.sequenceLabel,
        url: hubspotRecordUrl(portalId, CONTACT_OBJECT_TYPE_ID, c.contactId),
      })),
      diagnostics,
    });
  } catch (err) {
    console.error('[scorecard] lost-deals-sequence detail failed:', err.message);
    // No trailing "try again" here — the page appends that once itself so
    // the message is never duplicated on screen.
    res.status(500).json({ error: 'Could not read HubSpot for this week.' });
  }
});

// ─── Internal route — the weekly compute ────────────────────────────────
// Authenticated with the same x-cron-secret header as every other tool's
// internal router, so it must be mounted BEFORE requireLogin in server.js.
const internalRouter = express.Router();

function checkCronSecret(req, res) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    res.status(503).json({ error: 'CRON_SECRET is not configured on this server.' });
    return false;
  }
  if (req.get('x-cron-secret') !== expected) {
    res.status(403).json({ error: 'Forbidden.' });
    return false;
  }
  return true;
}

/**
 * POST /api/scorecard/internal/compute
 *   ?dry=1                      compute and return the rows WITHOUT writing
 *   ?fast_week=YYYY-MM-DD       override which week the six fast metrics cover
 *   ?depth_week=YYYY-MM-DD      override the sequence-depth week
 *
 * `dry=1` exists because it is the only safe thing to run until the
 * migration has been applied by hand — and because a week's numbers are
 * worth looking at before they become a row that is never recomputed.
 */
internalRouter.post('/api/scorecard/internal/compute', async (req, res) => {
  if (!checkCronSecret(req, res)) return;

  const dryRun = req.query.dry === '1' || req.query.dry === 'true';
  const fastWeek = req.query.fast_week ? String(req.query.fast_week) : undefined;
  const depthWeek = req.query.depth_week ? String(req.query.depth_week) : undefined;

  for (const [name, value] of [['fast_week', fastWeek], ['depth_week', depthWeek]]) {
    if (value && (!isParsableIsoDate(value) || mondayOf(value) !== value)) {
      return res.status(400).json({ error: `${name} must be a Monday (Pacific). ${value} is not one.` });
    }
  }

  try {
    const { rows, diagnostics, failures } = await computeAll({ fastWeek, depthWeek });

    if (dryRun) {
      return res.json({ ok: true, dryRun: true, written: 0, rows, failures, diagnostics });
    }

    const { written } = await writeRows(supabase, rows);
    // Failures are reported, never papered over. A metric that failed has no
    // row and its week stays re-runnable — running this route again
    // overwrites in place rather than adding a second row.
    console.log(`[scorecard] compute wrote ${written} row(s); ${failures.length} metric(s) produced none.`);
    res.json({ ok: true, dryRun: false, written, failures, diagnostics });
  } catch (err) {
    console.error('[scorecard] compute failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = { router, internalRouter, buildRollingWindow, buildAverage };
