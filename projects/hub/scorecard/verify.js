#!/usr/bin/env node
/**
 * scorecard/verify.js
 * Computes every Scoreboard metric against live HubSpot and prints the
 * numbers. WRITES NOTHING — not to Supabase, not to HubSpot, not to disk.
 *
 * This exists so the figures on the page can be checked against the numbers
 * that were measured by hand before the build started, and so they can be
 * re-checked later without anybody re-deriving the definitions from prose.
 */

const path = require('path');
const fs = require('fs');

{
  const localEnvPath = path.join(__dirname, '..', '.env');
  const sharedEnvPath = path.join(__dirname, '..', '..', '..', '.env');
  require('dotenv').config({ path: fs.existsSync(localEnvPath) ? localEnvPath : sharedEnvPath });
}

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
verify.js — compute the Scoreboard metrics from live HubSpot and print them

Reads Rincon's HubSpot and prints every metric, week by week, with the raw
parts each number was built from. It writes nothing anywhere — no database
row, no file, no change in HubSpot. Safe to run at any time.

Usage:
  node verify.js                    Last 15 weeks, ending with the last
                                    complete week
  node verify.js --weeks 8          A different number of weeks
  node verify.js --last-monday 2026-09-07
                                    End the range at a specific Monday
                                    (useful for reproducing an older run)
  node verify.js --help             This message

Required in .env:
  HUBSPOT_PRIVATE_APP_TOKEN         Read access to leads, deals, tasks and
                                    automation. Nothing is written with it.
`);
  process.exit(0);
}

function flag(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const { createCachedReader } = require('./lib/read-cache');
const {
  computeLeadToDiscoveryCallRate,
  computeFollowupTouches,
  computeSequenceDepth,
  computePastLeadConversions,
  computeReengagementAttempts,
  computeLostDealsAddedToSequence,
  checkWorkflowNameDrift,
} = require('./lib/metrics');
const { METRIC_OWNERS, WORKFLOWS, TRACKED_SEQUENCES, SEQUENCE_DEPTH_WEEK_RULE, ENROLLMENT_LOOKBACK_DAYS } = require('./lib/config');
const { weeksEndingAt, latestPublishableWeek, mondayOf, weekBoundsIso } = require('./lib/week');

const pad = (v, n) => String(v === null || v === undefined ? '—' : v).padStart(n);
const pct = (n, d) => (d === 0 ? '—' : ((100 * n) / d).toFixed(1) + '%');

(async () => {
  const weekCount = Number(flag('--weeks', '15'));
  const lastMonday = flag('--last-monday', latestPublishableWeek(0));
  if (mondayOf(lastMonday) !== lastMonday) {
    console.error(`--last-monday must be a Monday. ${lastMonday} is not one (its week starts ${mondayOf(lastMonday)}).`);
    process.exit(1);
  }

  const weeks = weeksEndingAt(lastMonday, weekCount);
  console.log(`Scoreboard verification — READ ONLY, nothing is written.`);
  console.log(`Weeks: ${weeks[0]} .. ${weeks[weeks.length - 1]} (${weeks.length}), Monday–Sunday, America/Los_Angeles\n`);

  // One cached reader for the whole run, so every week and every metric sees
  // the same HubSpot rather than a moving one.
  const hubspot = createCachedReader();

  const ownerEmail = METRIC_OWNERS.followup_touches_worked;
  const ownerHubspotId = await hubspot.resolveOwnerIdByEmail(ownerEmail);
  console.log(`Task population: tasks assigned to ${ownerEmail} (HubSpot owner id ${ownerHubspotId})\n`);

  // One anchor for the enrollment lookback across every week in the range.
  const enrollmentSinceIso = new Date(
    new Date(weekBoundsIso(weeks[0]).fromIso).getTime() - ENROLLMENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const rows = [];
  for (const week of weeks) {
    const rate = await computeLeadToDiscoveryCallRate(hubspot, week);
    const [worked, automation] = await computeFollowupTouches(hubspot, week, ownerHubspotId);
    const depth = await computeSequenceDepth(hubspot, week, { sinceIso: enrollmentSinceIso });
    const conversions = await computePastLeadConversions(hubspot, week);
    const reengagement = await computeReengagementAttempts(hubspot, week);
    const lostDealsSequence = await computeLostDealsAddedToSequence(hubspot, week);
    rows.push({ week, rate, worked, automation, depth, conversions, reengagement, lostDealsSequence });
    process.stderr.write(`  computed ${week}\r`);
  }
  process.stderr.write('                                   \r');

  console.log('week         deals  leads   rate | worked  auto | depth(med) n | conv | re-eng | lost->seq');
  for (const r of rows) {
    console.log(
      r.week,
      pad(r.rate.numerator, 6),
      pad(r.rate.denominator, 6),
      pad(pct(r.rate.numerator, r.rate.denominator), 7),
      '|',
      pad(r.worked.numerator, 6),
      pad(r.automation.numerator, 5),
      '|',
      pad(r.depth.value_numeric, 10),
      pad(r.depth.sample_size, 2),
      '|',
      pad(r.conversions.numerator, 4),
      '|',
      pad(r.reengagement.numerator, 6),
      '|',
      pad(r.lostDealsSequence.numerator, 9)
    );
  }

  const totalDeals = rows.reduce((a, r) => a + r.rate.numerator, 0);
  const totalLeads = rows.reduce((a, r) => a + r.rate.denominator, 0);
  console.log(`\nMetric 1 overall: ${totalDeals} deals / ${totalLeads} leads = ${pct(totalDeals, totalLeads)}`);

  const rolling = [];
  for (let i = 3; i < rows.length; i++) {
    const window = rows.slice(i - 3, i + 1);
    const n = window.reduce((a, r) => a + r.rate.numerator, 0);
    const d = window.reduce((a, r) => a + r.rate.denominator, 0);
    rolling.push(d === 0 ? '—' : Math.round((100 * n) / d));
  }
  console.log(`Rolling 4-week (SUM/SUM, never a mean of weekly percentages): ${rolling.join('/')}`);
  console.log(`  The first 3 weeks have no 4-week window at all and are correctly absent above.`);

  const workedSeries = rows.map((r) => r.worked.numerator);
  const autoSeries = rows.map((r) => r.automation.numerator);
  console.log(`\nWorked touches:     ${workedSeries.join(', ')}  (range ${Math.min(...workedSeries)}–${Math.max(...workedSeries)})`);
  console.log(`Automation touches: ${autoSeries.join(', ')}  (range ${Math.min(...autoSeries)}–${Math.max(...autoSeries)})`);

  const depthSeries = rows.map((r) => r.depth.value_numeric).filter((v) => v !== null);
  console.log(`\nSequence depth medians (week rule: ${SEQUENCE_DEPTH_WEEK_RULE}): ${depthSeries.join(', ')}`);
  console.log(`  LOWER IS BETTER. Never averaged across weeks — medians do not combine.`);

  const convTotal = rows.reduce((a, r) => a + r.conversions.numerator, 0);
  const reengSeries = rows.map((r) => r.reengagement.numerator);
  console.log(`\nPast-lead conversions in window: ${convTotal}`);
  console.log(`Re-engagement attempts: ${reengSeries.join(', ')}  avg ${(reengSeries.reduce((a, b) => a + b, 0) / reengSeries.length).toFixed(1)}/wk`);

  const lostSeqSeries = rows.map((r) => r.lostDealsSequence.numerator);
  console.log(`\nLost deals added to sequence: ${lostSeqSeries.join(', ')}`);
  console.log(`  Tracked sequence ids: ${TRACKED_SEQUENCES.map((s) => s.id).join(', ')}`);
  console.log(`  Bucketed by Rincon's Pacific business week, same as every other row here.`);

  const last = rows[rows.length - 1];
  console.log(`\nResidues and early warnings (most recent week, ${last.week}):`);
  console.log(`  Leads excluded as Tenants/Vendor: ${last.rate.diagnostics.tenantVendorLeadsExcluded}`);
  console.log(`  Deals found outside the 'default' pipeline: ${last.rate.diagnostics.dealsOutsideDefaultPipeline}`);
  console.log(`  Task source labels counted as neither worked nor automation: ${JSON.stringify(last.worked.diagnostics.otherSourceLabels)}`);
  console.log(`  Automation tasks matching no configured workflow: ${last.depth.diagnostics.unmatchedAutomationTasks}`);
  console.log(`  Matched, by configured workflow: ${JSON.stringify(last.depth.diagnostics.matchedByWorkflow)}`);
  const topUnmatched = Object.entries(last.depth.diagnostics.unmatchedByName).sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`  Top unmatched workflow names (a rename shows up here as a NEW name with real volume):`);
  for (const [name, count] of topUnmatched) console.log(`    ${pad(count, 5)}  ${JSON.stringify(name)}`);

  const drift = await checkWorkflowNameDrift(hubspot, WORKFLOWS);
  console.log(`\nWorkflow name drift (config vs live v4 definition): ${drift.length === 0 ? 'none' : ''}`);
  for (const d of drift) console.log(`  ${d.status}: ${d.v4Id} configured ${JSON.stringify(d.configured)} live ${JSON.stringify(d.live)}`);
})().catch((err) => {
  console.error('\nverify.js failed:', err.message);
  process.exit(1);
});
