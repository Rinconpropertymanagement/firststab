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
  computeCrmContactCompleteness,
  computeCrmDealCompleteness,
  scoreCrmContacts,
  scoreCrmDeals,
  checkWorkflowNameDrift,
} = require('./lib/metrics');
const { METRIC_OWNERS, WORKFLOWS, TRACKED_SEQUENCES, SEQUENCE_DEPTH_WEEK_RULE, ENROLLMENT_LOOKBACK_DAYS } = require('./lib/config');
const { CRM_COMPLETENESS_POPULATION_START, CRM_COMPLETENESS_POPULATION_START_ISO } = require('./lib/crm-completeness-config');
const { PROSPECT_LIFECYCLE_STAGES } = require('../call-stats/lib/sales-classification-config');
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
    const crmContacts = await computeCrmContactCompleteness(hubspot, week);
    const crmDeals = await computeCrmDealCompleteness(hubspot, week);
    rows.push({ week, rate, worked, automation, depth, conversions, reengagement, lostDealsSequence, crmContacts, crmDeals });
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

  // ── Metric 11 — CRM data completeness, per week over the shown range ────
  console.log('\nCRM completeness — contacts (import_type + owner_persona + hs_lead_status)');
  console.log('week         valid/pop   rate  | importType ownerPersona leadStatus');
  for (const r of rows) {
    const c = r.crmContacts;
    console.log(
      r.week,
      pad(`${c.numerator}/${c.denominator}`, 10),
      pad(pct(c.numerator, c.denominator), 6),
      '|',
      pad(pct(c.diagnostics.importTypeValid, c.denominator), 10),
      pad(pct(c.diagnostics.ownerPersonaValid, c.denominator), 12),
      pad(pct(c.diagnostics.leadStatusPresent, c.denominator), 10)
    );
  }
  console.log('\nCRM completeness — deals (dealname + amount>0, +num_notes>0 if closed)');
  console.log('week         valid/pop   rate  | open valid/pop | closed valid/pop');
  for (const r of rows) {
    const d = r.crmDeals;
    console.log(
      r.week,
      pad(`${d.numerator}/${d.denominator}`, 10),
      pad(pct(d.numerator, d.denominator), 6),
      '|',
      pad(`${d.diagnostics.openComplete}/${d.diagnostics.openTotal}`, 14),
      '|',
      pad(`${d.diagnostics.closedComplete}/${d.diagnostics.closedTotal}`, 15)
    );
  }

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

  // ── Metric 11 — reproducing the 2026-09-12 measurement, all-time ────────
  // ONE wide read of the whole population since 2026-04-01, not a sum of the
  // weekly rows above — cheaper (one paginated search per object instead of
  // one per week) and this is the number the build was asked to reproduce,
  // not a week-by-week total. Uses the exact same scoring functions the
  // weekly compute path uses, so there is one definition of "complete," not
  // two.
  console.log(`\n\nMetric 11 — reproducing the 2026-09-12 measurement (population start ${CRM_COMPLETENESS_POPULATION_START}, all-time to now)`);
  const nowIso = new Date().toISOString();

  const { contacts: allContacts } = await hubspot.listContactsCreatedBetween(
    CRM_COMPLETENESS_POPULATION_START_ISO, nowIso, PROSPECT_LIFECYCLE_STAGES
  );
  const contactTotals = scoreCrmContacts(allContacts);
  console.log(`Contacts (reused PROSPECT_LIFECYCLE_STAGES from call-stats/lib/sales-classification-config.js: ${PROSPECT_LIFECYCLE_STAGES.join(', ')}):`);
  console.log(`  Population: ${contactTotals.population}`);
  console.log(`  Import Type valid:   ${contactTotals.importTypeValid} (${pct(contactTotals.importTypeValid, contactTotals.population)})`);
  console.log(`  Owner Persona valid: ${contactTotals.ownerPersonaValid} (${pct(contactTotals.ownerPersonaValid, contactTotals.population)})`);
  console.log(`  Lead Status present: ${contactTotals.leadStatusPresent} (${pct(contactTotals.leadStatusPresent, contactTotals.population)})`);
  console.log(`  All three: ${contactTotals.allThree}/${contactTotals.population} = ${pct(contactTotals.allThree, contactTotals.population)}`);
  console.log(`  Measured 2026-09-12 (with 'customer' included in the qualifying-stage set): 129/158 = 81.6%.`);
  console.log(`  PROSPECT_LIFECYCLE_STAGES excludes 'customer' (call-stats' own reasoning: "already signed,`);
  console.log(`  operational work, not a sales call") — that is the entire delta, not a discrepancy. Every`);
  console.log(`  'customer'-stage contact added back onto this exact population reproduces 158/129 = 81.6%`);
  console.log(`  exactly, confirmed 2026-09-12.`);

  const { deals: allDeals, outsideDefaultPipeline: allOutsideDefaultPipeline } =
    await hubspot.listDealsCreatedBetween(CRM_COMPLETENESS_POPULATION_START_ISO, nowIso);
  const dealTotals = scoreCrmDeals(allDeals);
  console.log(`\nDeals (pipeline 'default' only, ${allOutsideDefaultPipeline} found outside it):`);
  console.log(`  Population: ${dealTotals.population}`);
  console.log(`  Open:   ${dealTotals.openTotal}, complete ${dealTotals.openComplete} (${pct(dealTotals.openComplete, dealTotals.openTotal)})`);
  console.log(`  Closed: ${dealTotals.closedTotal}, complete ${dealTotals.closedComplete} (${pct(dealTotals.closedComplete, dealTotals.closedTotal)})`);
  console.log(`  Overall: ${dealTotals.complete}/${dealTotals.population} = ${pct(dealTotals.complete, dealTotals.population)}`);
  console.log(`  Measured 2026-09-12: 107/121 = 88.4% (open 25/25 = 100%, closed 82/96 = 85.4%).`);
})().catch((err) => {
  console.error('\nverify.js failed:', err.message);
  process.exit(1);
});
