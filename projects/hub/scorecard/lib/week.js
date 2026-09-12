/**
 * scorecard/lib/week.js
 * Monday-to-Sunday weeks in Rincon's own business timezone.
 *
 * The migration's `week_start` column has a CHECK enforcing Monday-ness
 * (ISO day-of-week 1) precisely because a week boundary that slips one day
 * shifts an entire week of records, not one late-evening call. This file is
 * what keeps that CHECK from ever firing.
 *
 * The DST-correct "midnight in America/Los_Angeles as a UTC instant"
 * primitive is IMPORTED from call-stats/lib/timezone.js rather than copied.
 * That file is already live-verified against real data (a Pacific day's
 * bounds round-tripping 146 real calls) and a second copy of a boundary rule
 * is how two parts of this codebase quietly start disagreeing about what a
 * day is. The import is read-only and changes nothing in Call Stats, which
 * shipped 2026-09-12 and is live.
 */

const { zonedMidnightToUtcMs, TIMEZONE } = require('../../call-stats/lib/timezone');

const DAY_MS = 24 * 60 * 60 * 1000;

// "YYYY-MM-DD" of the Monday that starts the week containing `dateStr`,
// where `dateStr` is itself a Pacific calendar date.
function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcNoon = Date.UTC(y, m - 1, d, 12); // noon avoids any DST edge in the arithmetic
  const dow = new Date(utcNoon).getUTCDay(); // 0 = Sunday
  const backDays = dow === 0 ? 6 : dow - 1;
  return new Date(utcNoon - backDays * DAY_MS).toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12) + days * DAY_MS).toISOString().slice(0, 10);
}

// Today as a Pacific calendar date.
function todayPacific() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * The [fromIso, toIso) UTC instants bounding one Pacific Monday–Sunday week.
 * Both ends are computed independently from real Intl-backed zone rules, so
 * a 167-hour or 169-hour DST week is handled correctly — adding a fixed
 * 7 * 86400 seconds is not.
 */
function weekBoundsIso(weekStart) {
  if (mondayOf(weekStart) !== weekStart) {
    throw new Error(`weekBoundsIso expects a Monday (Pacific). Got ${weekStart}, whose week starts ${mondayOf(weekStart)}.`);
  }
  return {
    fromIso: new Date(zonedMidnightToUtcMs(weekStart)).toISOString(),
    toIso: new Date(zonedMidnightToUtcMs(addDays(weekStart, 7))).toISOString(),
  };
}

/**
 * The most recent week that is BOTH complete and past its publication hold.
 *
 * `holdDays` of 0 means "the week that ended yesterday or earlier". A larger
 * hold shifts further back — the sequence-depth metric holds 7 days so that
 * every enrollment observed (max 5.8 days first task to last) has finished
 * before its week is published.
 */
function latestPublishableWeek(holdDays = 0, today = todayPacific()) {
  const thisMonday = mondayOf(today);
  let candidate = addDays(thisMonday, -7); // last fully-closed week
  while (daysBetween(addDays(candidate, 7), today) < holdDays) {
    candidate = addDays(candidate, -7);
  }
  return candidate;
}

function daysBetween(fromDateStr, toDateStr) {
  const [y1, m1, d1] = fromDateStr.split('-').map(Number);
  const [y2, m2, d2] = toDateStr.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2, 12) - Date.UTC(y1, m1 - 1, d1, 12)) / DAY_MS);
}

/** `count` consecutive Mondays ending at `lastMonday`, oldest first. */
function weeksEndingAt(lastMonday, count) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) out.push(addDays(lastMonday, -7 * i));
  return out;
}

module.exports = { mondayOf, addDays, daysBetween, todayPacific, weekBoundsIso, latestPublishableWeek, weeksEndingAt };
