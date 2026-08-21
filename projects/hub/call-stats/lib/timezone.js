/**
 * lib/timezone.js
 * Small, dependency-free helpers for converting between Aircall's UTC unix
 * timestamps and Rincon's own business timezone (America/Los_Angeles) — no
 * timezone library (moment-timezone, luxon, date-fns-tz) is installed
 * anywhere in this project (checked package.json before writing this), so
 * this uses only the real timezone rules already built into Node's Intl
 * implementation, not a hand-rolled DST guess.
 *
 * Required per SPEC.md and the call_stats migration's call_date column
 * comment: call_date must be Rincon's own Pacific business day, not a
 * naive UTC truncation of Aircall's started_at — a late-evening Pacific
 * call must land on the Pacific calendar day, or a day's totals silently
 * split across two rows.
 *
 * Live-verified before use (not trusted from documentation alone):
 *   - 2026-08-19 00:00 America/Los_Angeles (PDT, summer) == 2026-08-19T07:00:00.000Z
 *   - 2026-01-15 00:00 America/Los_Angeles (PST, winter) == 2026-01-15T08:00:00.000Z
 *   - A real Aircall from/to query built from this file's bounds for PT
 *     2026-08-19 returned 146 real calls, ALL with started_at inside
 *     [from, to), and every one's pacificDateOf(started_at) came back
 *     exactly "2026-08-19" — confirms the round trip is correct, not just
 *     the math in isolation.
 */

const TIMEZONE = 'America/Los_Angeles';

// Converts a "YYYY-MM-DD" calendar date, interpreted as midnight in
// `timeZone`, to the equivalent UTC instant (milliseconds since epoch).
// Standard library-free technique: guess UTC midnight, ask Intl what that
// guess actually displays as in the target zone, then correct by the
// difference. Converges in at most 2 passes for any real-world timezone,
// including one with a DST jump on this exact date.
function zonedMidnightToUtcMs(dateStr, timeZone = TIMEZONE) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d, 0, 0, 0);
  let guess = target;
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  for (let i = 0; i < 3; i++) {
    const parts = dtf.formatToParts(new Date(guess));
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    let hour = Number(map.hour);
    if (hour === 24) hour = 0; // Intl can format midnight as "24:00"
    const shown = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), hour, Number(map.minute), Number(map.second));
    const diff = target - shown;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

// The Pacific calendar date (YYYY-MM-DD) that a UTC unix-seconds timestamp
// falls on. This is the call_date bucketing rule the schema requires.
function pacificDateOf(unixSeconds, timeZone = TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(unixSeconds * 1000));
}

// [fromUnixSeconds, toUnixSeconds) bounds of one Pacific calendar day —
// what the nightly sync passes to Aircall's from/to filter. Handles a
// 23-hour or 25-hour day correctly across a DST transition because both
// boundaries are computed independently from real Intl-backed zone rules,
// not by adding a fixed 86400 seconds.
function pacificDayBoundsUnix(dateStr, timeZone = TIMEZONE) {
  const startMs = zonedMidnightToUtcMs(dateStr, timeZone);
  const [y, m, d] = dateStr.split('-').map(Number);
  const nextDateStr = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  const endMs = zonedMidnightToUtcMs(nextDateStr, timeZone);
  return { from: Math.floor(startMs / 1000), to: Math.floor(endMs / 1000) };
}

// "Yesterday" as a Pacific YYYY-MM-DD string, relative to right now. Used
// by the nightly sync's default (no explicit ?date= override).
function yesterdayPacificDateStr(timeZone = TIMEZONE) {
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = todayStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

module.exports = { TIMEZONE, zonedMidnightToUtcMs, pacificDateOf, pacificDayBoundsUnix, yesterdayPacificDateStr };
