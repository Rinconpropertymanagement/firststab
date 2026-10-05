#!/usr/bin/env node
/**
 * push-blocks-to-calendar.js
 * Creates recurring "Busy" events on Peter's Google Calendar for each
 * protected time block (gym, deep work, meeting windows, partnerships).
 *
 * Run once — skips blocks that already have a google_event_id.
 * Re-run safely if new blocks are added.
 *
 * Usage:
 *   node push-blocks-to-calendar.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { google } = require('googleapis');

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CALENDAR_ID   = 'peter@rinconmanagement.com';
const TIMEZONE      = 'America/Los_Angeles';

const auth = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);
auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const gcal = google.calendar({ version: 'v3', auth });

const DOW_LABEL   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DOW_RRULE   = ['SU','MO','TU','WE','TH','FR','SA'];

// Color IDs match Google Calendar's built-in palette
const BLOCK_COLOR = {
  gym:            '11', // Tomato (red)
  deep_work:      '9',  // Blueberry (dark blue)
  meeting_window: '7',  // Peacock (teal)
  partnership:    '3',  // Grape (purple)
};

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function fetchBlocks() {
  return sbFetch('calendar_blocks?is_active=eq.true&order=day_of_week.asc,start_time.asc');
}

async function saveGoogleEventId(blockId, googleEventId) {
  return sbFetch(`calendar_blocks?id=eq.${blockId}`, {
    method: 'PATCH',
    body: JSON.stringify({ google_event_id: googleEventId }),
  });
}

// ── Google Calendar helpers ───────────────────────────────────────────────────

// Get the next occurrence of a given day_of_week (0=Sun) from today
function nextOccurrenceDate(dayOfWeek) {
  const today    = new Date();
  const todayDow = today.getDay();
  const diff     = (dayOfWeek - todayDow + 7) % 7;
  const result   = new Date(today);
  result.setDate(today.getDate() + diff);
  return result.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function createRecurringBlock(block) {
  const startDate = nextOccurrenceDate(block.day_of_week);
  const colorId   = BLOCK_COLOR[block.block_type] || '8'; // Graphite as default

  const event = {
    summary:      block.title,
    description:  'Protected time — managed by Rincon Assistant\nDo not book over this block.',
    colorId,
    start: {
      dateTime: `${startDate}T${block.start_time}`,
      timeZone: TIMEZONE,
    },
    end: {
      dateTime: `${startDate}T${block.end_time}`,
      timeZone: TIMEZONE,
    },
    recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=${DOW_RRULE[block.day_of_week]}`],
    transparency: 'opaque',   // shows as "Busy" to anyone viewing the calendar
    status:       'confirmed',
    reminders:    { useDefault: false, overrides: [] }, // no reminders for structure blocks
  };

  const res = await gcal.events.insert({
    calendarId:  CALENDAR_ID,
    requestBody: event,
  });

  return res.data.id;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('Pushing protected blocks to Google Calendar...');
  console.log('');

  const blocks = await fetchBlocks();
  console.log(`${blocks.length} active blocks found.\n`);

  let created = 0, skipped = 0, failed = 0;

  for (const block of blocks) {
    const label = `${block.title} (${DOW_LABEL[block.day_of_week]})`;

    if (block.google_event_id) {
      console.log(`  ⏭  ${label} — already on calendar`);
      skipped++;
      continue;
    }

    try {
      const googleId = await createRecurringBlock(block);
      await saveGoogleEventId(block.id, googleId);
      console.log(`  ✓  ${label} → recurring every ${DOW_LABEL[block.day_of_week]}`);
      created++;
    } catch (err) {
      console.error(`  ✗  ${label}: ${err.message}`);
      failed++;
    }
  }

  console.log('');
  console.log(`Done. Created: ${created} | Skipped: ${skipped} | Failed: ${failed}`);
  console.log('');
  if (created > 0) {
    console.log('Open Google Calendar — your protected blocks are now showing as Busy.');
    console.log('Anyone viewing your calendar cannot book over them.');
  }
}

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
