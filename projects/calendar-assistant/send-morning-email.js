#!/usr/bin/env node
/**
 * send-morning-email.js
 * Sends Peter McKenzie's daily morning briefing via Gmail.
 *
 * Usage:
 *   node send-morning-email.js
 *   node send-morning-email.js --help
 *
 * Reads calendar blocks and tasks from Supabase, builds an HTML email
 * from the email-template.html structure, and sends it via Gmail API.
 *
 * Required environment variables (in .env or shell):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { google } = require('googleapis');

// ─── Help flag ────────────────────────────────────────────────────────────────
if (process.argv.includes('--help')) {
  console.log(`
send-morning-email.js — Daily morning briefing for Rincon Management

Reads today's calendar blocks and open tasks from Supabase, then sends
an HTML briefing email to peter@rinconmanagement.com via Gmail.

Usage:
  node send-morning-email.js

Environment variables required (.env file):
  SUPABASE_URL              Your Supabase project URL
  SUPABASE_SERVICE_ROLE_KEY Supabase service role key
  GOOGLE_CLIENT_ID          Google OAuth client ID
  GOOGLE_CLIENT_SECRET      Google OAuth client secret
  GOOGLE_REFRESH_TOKEN      Gmail refresh token (run get-gmail-token.js once to get this)

Scheduled via cron on Sally at 8:30am Pacific (16:30 UTC), Mon–Fri.
`);
  process.exit(0);
}

// ─── Config ───────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const RECIPIENT = 'peter@rinconmanagement.com';

// Validate required env vars before doing anything
const missing = [];
if (!SUPABASE_URL) missing.push('SUPABASE_URL');
if (!SUPABASE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
if (!CLIENT_ID) missing.push('GOOGLE_CLIENT_ID');
if (!CLIENT_SECRET) missing.push('GOOGLE_CLIENT_SECRET');
if (!REFRESH_TOKEN) missing.push('GOOGLE_REFRESH_TOKEN');

if (missing.length > 0) {
  console.error(`[ERROR] Missing environment variables: ${missing.join(', ')}`);
  console.error('Run get-gmail-token.js if GOOGLE_REFRESH_TOKEN is missing.');
  process.exit(1);
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
// All dates are in Pacific time (where Peter operates)
function getPacificDate() {
  const now = new Date();
  // Format as YYYY-MM-DD in Pacific time
  const pacific = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  return pacific; // e.g. "2026-06-26"
}

function getPacificDayOfWeek() {
  const now = new Date();
  // 0=Sun, 1=Mon, ..., 6=Sat
  return parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      weekday: 'narrow', // we'll use a numeric trick below
    }).formatToParts(now).find(p => p.type === 'weekday') ?
    new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(now)).getDay() :
    new Date().getDay()
  );
}

// Simpler approach: get day-of-week from Pacific date string
function getDayOfWeekFromDateStr(dateStr) {
  // dateStr is "YYYY-MM-DD"
  // new Date("YYYY-MM-DD") parses as UTC midnight, so we add T12:00 to keep it local-safe
  const d = new Date(dateStr + 'T12:00:00');
  return d.getDay(); // 0=Sun, 1=Mon...
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatDateLong(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// Format "07:30:00" → "7:30 AM"
function formatTime(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
}

// ─── Supabase fetch helpers ────────────────────────────────────────────────────
async function supabaseFetch(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}?${qs}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase error ${res.status} on ${path}: ${body}`);
  }
  return res.json();
}

// Fetch today's calendar blocks (by day_of_week)
async function fetchTodayBlocks(dayOfWeek) {
  return supabaseFetch('calendar_blocks', {
    day_of_week: `eq.${dayOfWeek}`,
    is_active: 'eq.true',
    order: 'start_time.asc',
  });
}

// Fetch all blocks for the current week (Mon–Sun) for the week-at-a-glance section
async function fetchWeekBlocks() {
  return supabaseFetch('calendar_blocks', {
    is_active: 'eq.true',
    order: 'day_of_week.asc,start_time.asc',
  });
}

// Fetch today's real Google Calendar events (synced by sync-calendar.js)
async function fetchTodayEvents(todayDate) {
  // Need two start_at filters — use URLSearchParams with append so both keys are preserved
  const params = new URLSearchParams();
  params.append('start_at', `gte.${todayDate}T00:00:00.000Z`);
  params.append('start_at', `lte.${todayDate}T23:59:59.999Z`);
  params.append('status',   'neq.cancelled');
  params.append('order',    'start_at.asc');

  const res = await fetch(`${SUPABASE_URL}/rest/v1/calendar_events?${params.toString()}`, {
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    // Non-fatal: table may not exist yet
    console.warn(`Events fetch warning (${res.status}): ${body}`);
    return [];
  }
  return res.json();
}

// Fetch today's open tasks (due today, not done)
async function fetchTodayTasks(todayDate) {
  return supabaseFetch('tasks', {
    due_date: `eq.${todayDate}`,
    status: 'neq.done',
    order: 'priority.asc,title.asc',
  });
}

// ─── Block type → color mapping ───────────────────────────────────────────────
// Maps block_type (or the color field) to a badge color in the email
const TYPE_COLORS = {
  gym:              { bg: '#FEE2E2', text: '#991B1B' },
  deep_work:        { bg: '#D1FAE5', text: '#065F46' },
  meeting_window:   { bg: '#DBEAFE', text: '#1E40AF' },
  partnership:      { bg: '#EDE9FE', text: '#5B21B6' },
  focus:            { bg: '#D1FAE5', text: '#065F46' },
  admin:            { bg: '#FEF3C7', text: '#92400E' },
  default:          { bg: '#F3F4F6', text: '#374151' },
};

function blockColors(block) {
  return TYPE_COLORS[block.block_type] || TYPE_COLORS[block.color] || TYPE_COLORS.default;
}

// ─── HTML builders ────────────────────────────────────────────────────────────
const CALENDAR_COLORS_EMAIL = {
  'Rincon':      { dot: '#534AB7' },
  'Coastal Inn': { dot: '#0EA5E9' },
  'Holiday':     { dot: '#F59E0B' },
};

function formatEventTimeEmail(startAt) {
  const d = new Date(startAt);
  const h = d.getHours(), m = d.getMinutes();
  return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function buildScheduleHtml(blocks, calEvents) {
  // Merge structure blocks + real events, sorted by time
  const items = [];

  (blocks || []).forEach(b => {
    items.push({
      sortKey:  b.start_time || '00:00',
      timeLabel: b.end_time
        ? `${formatTime(b.start_time)} – ${formatTime(b.end_time)}`
        : formatTime(b.start_time),
      title:  b.title,
      dot:    '#888780',
      badge:  null,
    });
  });

  (calEvents || []).filter(e => e.calendar_name !== 'Holiday').forEach(e => {
    const color = (CALENDAR_COLORS_EMAIL[e.calendar_name] || {}).dot || '#534AB7';
    items.push({
      sortKey:   e.all_day ? '00:00' : new Date(e.start_at).toTimeString().slice(0, 5),
      timeLabel: e.all_day ? 'All day' : formatEventTimeEmail(e.start_at),
      title:     e.title,
      dot:       color,
      badge:     e.calendar_name !== 'Rincon' ? e.calendar_name : null,
    });
  });

  items.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  if (items.length === 0) {
    return `<tr><td style="padding:12px 0;color:#6B6B6B;font-size:14px;">Nothing on the schedule today.</td></tr>`;
  }

  return items.map(item => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #F3F4F6;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="width:12px;vertical-align:middle;padding-right:10px;">
              <div style="width:10px;height:10px;border-radius:50%;background:${item.dot};"></div>
            </td>
            <td style="width:90px;font-size:12px;color:#6B6B6B;vertical-align:middle;">
              ${item.timeLabel}
            </td>
            <td style="font-size:14px;color:#1A1A1A;vertical-align:middle;">
              ${escapeHtml(item.title)}
              ${item.badge ? `<span style="margin-left:6px;font-size:11px;color:#6B6B6B;">${escapeHtml(item.badge)}</span>` : ''}
            </td>
          </tr>
        </table>
      </td>
    </tr>`).join('');
}

function buildTasksHtml(tasks) {
  if (!tasks || tasks.length === 0) {
    return `<tr><td style="padding:12px 0;color:#6B6B6B;font-size:14px;">No open tasks due today.</td></tr>`;
  }

  return tasks.map(t => {
    // Priority dot color
    const dotColor = t.priority === 'high' ? '#EF4444'
                   : t.priority === 'medium' ? '#F59E0B'
                   : '#9CA3AF';

    return `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #F3F4F6;font-size:14px;color:#1A1A1A;">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dotColor};margin-right:8px;vertical-align:middle;"></span>
        ${escapeHtml(t.title)}${t.notes ? `<br><span style="font-size:12px;color:#6B6B6B;margin-left:16px;">${escapeHtml(t.notes)}</span>` : ''}
      </td>
    </tr>`;
  }).join('');
}

function buildWeekRowsHtml(allBlocks, todayDow) {
  // Show Mon–Fri only (DOW 1–5)
  const rows = [];
  for (let dow = 1; dow <= 5; dow++) {
    const dayBlocks = allBlocks.filter(b => b.day_of_week === dow);
    const isToday = dow === todayDow;
    const dayLabel = DAY_SHORT[dow];
    const blockList = dayBlocks.length > 0
      ? dayBlocks.map(b => escapeHtml(b.title)).join(', ')
      : '<span style="color:#9CA3AF">—</span>';

    rows.push(`
    <tr style="${isToday ? 'background:#F5F3FF;' : ''}">
      <td style="padding:6px 8px;font-size:13px;font-weight:${isToday ? '700' : '400'};color:${isToday ? '#534AB7' : '#1A1A1A'};">
        ${dayLabel}${isToday ? ' ←' : ''}
      </td>
      <td style="padding:6px 8px;font-size:13px;color:#374151;">
        ${blockList}
      </td>
    </tr>`);
  }
  return rows.join('');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Email builder ────────────────────────────────────────────────────────────
function buildEmailHtml({ dayName, dateStr, meetingsHtml, tasksHtml, weekRowsHtml, alerts }) {
  const alertDisplay = alerts ? 'block' : 'none';
  const alertText = alerts || '';

  // Inline the template structure directly — avoids file I/O issues on Sally
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Good morning, Peter</title>
</head>
<body style="margin:0;padding:0;background:#F5F5F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5F5F5;padding:24px 0;">
    <tr>
      <td align="center">

        <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:#534AB7;padding:28px 32px;">
              <p style="margin:0;color:rgba(255,255,255,0.7);font-size:13px;text-transform:uppercase;letter-spacing:0.08em;">Rincon Management</p>
              <h1 style="margin:6px 0 0;color:#ffffff;font-size:24px;font-weight:700;">Good morning, Peter</h1>
              <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:15px;">${dayName}, ${dateStr}</p>
            </td>
          </tr>

          <!-- Alert bar -->
          <tr style="display:${alertDisplay}">
            <td style="background:#FFFBEB;border-bottom:1px solid #FDE68A;padding:12px 32px;font-size:13px;color:#92400E;">
              ${alertText}
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:28px 32px;">

              <h2 style="margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#6B6B6B;">Today's Schedule</h2>
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
                ${meetingsHtml}
              </table>

              <h2 style="margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#6B6B6B;">Today's Tasks</h2>
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
                ${tasksHtml}
              </table>

              <h2 style="margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#6B6B6B;">This Week</h2>
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:32px;">
                <tr>
                  <th style="text-align:left;font-size:11px;color:#6B6B6B;padding-bottom:6px;font-weight:600;">Day</th>
                  <th style="text-align:left;font-size:11px;color:#6B6B6B;padding-bottom:6px;font-weight:600;">Blocks</th>
                </tr>
                ${weekRowsHtml}
              </table>

              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center">
                    <a href="https://srv1784739.hstgr.cloud"
                       style="display:inline-block;background:#534AB7;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 32px;border-radius:8px;">
                      Open My Dashboard
                    </a>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 32px;border-top:1px solid #E5E5E5;font-size:12px;color:#6B6B6B;text-align:center;">
              Rincon Management &middot; Southern California<br>
              <a href="https://srv1784739.hstgr.cloud" style="color:#534AB7;text-decoration:none;">Open dashboard</a>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>`;
}

// ─── Gmail send ───────────────────────────────────────────────────────────────
async function sendEmail({ subject, htmlBody }) {
  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // RFC 2822 format email
  const rawMessage = [
    `From: "Rincon Management Assistant" <${RECIPIENT}>`,
    `To: ${RECIPIENT}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    htmlBody,
  ].join('\r\n');

  // Gmail API requires base64url encoding
  const encoded = Buffer.from(rawMessage).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encoded },
  });

  return response.data;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const todayDate = getPacificDate();           // "2026-06-26"
  const todayDow  = getDayOfWeekFromDateStr(todayDate); // 0–6
  const dayName   = DAY_NAMES[todayDow];        // "Friday"
  const dateStr   = formatDateLong(todayDate);  // "June 26, 2026"

  console.log(`[${new Date().toISOString()}] Running morning email for ${dayName}, ${dateStr}`);

  // Fetch data from Supabase
  let todayBlocks, allWeekBlocks, todayTasks, todayEvents;
  try {
    [todayBlocks, allWeekBlocks, todayTasks, todayEvents] = await Promise.all([
      fetchTodayBlocks(todayDow),
      fetchWeekBlocks(),
      fetchTodayTasks(todayDate),
      fetchTodayEvents(todayDate),
    ]);
    console.log(`  Blocks: ${todayBlocks.length} | Events: ${todayEvents.length} | Tasks: ${todayTasks.length}`);
  } catch (err) {
    console.error('[ERROR] Failed to fetch data from Supabase:', err.message);
    process.exit(1);
  }

  // Build email content
  const meetingsHtml = buildScheduleHtml(todayBlocks, todayEvents);
  const tasksHtml    = buildTasksHtml(todayTasks);
  const weekRowsHtml = buildWeekRowsHtml(allWeekBlocks, todayDow);

  const htmlBody = buildEmailHtml({
    dayName,
    dateStr,
    meetingsHtml,
    tasksHtml,
    weekRowsHtml,
    alerts: null, // reserved for future use (e.g. late rent alerts)
  });

  const subject = `Good morning, Peter — ${dayName}, ${dateStr}`;

  // Send via Gmail
  try {
    const result = await sendEmail({ subject, htmlBody });
    console.log(`[SUCCESS] Email sent. Gmail message ID: ${result.id}`);
  } catch (err) {
    console.error('[ERROR] Failed to send email via Gmail:', err.message);
    if (err.message.includes('invalid_grant')) {
      console.error('  Your refresh token has expired or been revoked.');
      console.error('  Run get-gmail-token.js again to get a new one.');
    }
    process.exit(1);
  }
}

main();
