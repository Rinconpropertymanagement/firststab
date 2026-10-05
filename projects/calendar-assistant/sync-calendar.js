#!/usr/bin/env node
/**
 * sync-calendar.js
 * Pulls events from Peter's Google Calendars into Supabase.
 * Runs every 15 minutes via cron on Sally.
 *
 * Usage:
 *   node sync-calendar.js
 */

require('dotenv').config({ path: '/var/www/calendar-assistant/.env' });

const { google } = require('googleapis');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CLIENT_ID    = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const missing = [];
if (!SUPABASE_URL)   missing.push('SUPABASE_URL');
if (!SUPABASE_KEY)   missing.push('SUPABASE_SERVICE_ROLE_KEY');
if (!CLIENT_ID)      missing.push('GOOGLE_CLIENT_ID');
if (!CLIENT_SECRET)  missing.push('GOOGLE_CLIENT_SECRET');
if (!REFRESH_TOKEN)  missing.push('GOOGLE_REFRESH_TOKEN');
if (missing.length) {
  console.error('[ERROR] Missing env vars:', missing.join(', '));
  process.exit(1);
}

// Calendars to sync
const CALENDARS = [
  { id: 'peter@rinconmanagement.com',                      name: 'Rincon' },
  { id: 'thecoastalinn@hotmail.com',                       name: 'Coastal Inn' },
  { id: 'en.usa#holiday@group.v.calendar.google.com',      name: 'Holiday' },
];

// Sync window: 30 days back, 90 days forward
const TIME_MIN = new Date();
TIME_MIN.setDate(TIME_MIN.getDate() - 30);
const TIME_MAX = new Date();
TIME_MAX.setDate(TIME_MAX.getDate() + 90);

// ── Google Calendar client ──────────────────────────────────────────────────
const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
auth.setCredentials({ refresh_token: REFRESH_TOKEN });
const gcal = google.calendar({ version: 'v3', auth });

// ── Supabase upsert ─────────────────────────────────────────────────────────
async function upsertEvents(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/calendar_events`, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase upsert failed (${res.status}): ${body}`);
  }
}

// ── Sync one calendar ───────────────────────────────────────────────────────
async function syncCalendar(cal) {
  let pageToken = null;
  let total = 0;

  do {
    const res = await gcal.events.list({
      calendarId:   cal.id,
      timeMin:      TIME_MIN.toISOString(),
      timeMax:      TIME_MAX.toISOString(),
      singleEvents: true,       // expand recurring events into individual instances
      orderBy:      'startTime',
      maxResults:   250,
      pageToken:    pageToken || undefined,
    });

    const items = res.data.items || [];
    if (items.length === 0) break;

    const rows = items.map(ev => {
      const allDay = !!ev.start.date;
      // All-day events: store as midnight UTC on that date so start_at is never null
      const startAt = allDay
        ? new Date(ev.start.date + 'T00:00:00Z').toISOString()
        : ev.start.dateTime;
      const endAt = allDay
        ? new Date(ev.end.date + 'T00:00:00Z').toISOString()
        : ev.end.dateTime;

      return {
        google_event_id: ev.id,
        calendar_id:     cal.id,
        calendar_name:   cal.name,
        title:           ev.summary || '(No title)',
        start_at:        startAt,
        end_at:          endAt,
        all_day:         allDay,
        location:        ev.location   || null,
        description:     ev.description ? ev.description.slice(0, 2000) : null,
        status:          ev.status     || 'confirmed',
        synced_at:       new Date().toISOString(),
      };
    });

    await upsertEvents(rows);
    total += rows.length;
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return total;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toISOString()}] Calendar sync starting…`);

  for (const cal of CALENDARS) {
    try {
      const count = await syncCalendar(cal);
      console.log(`  ✓ ${cal.name}: ${count} events`);
    } catch (err) {
      console.error(`  ✗ ${cal.name}: ${err.message}`);
    }
  }

  console.log('Done.');
}

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
