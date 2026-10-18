#!/usr/bin/env node
/**
 * backtest/a0-replay.js
 * Phase A0 proof: the numbers pipeline moved from server.js / router.js into
 * lib/analyze.js changed NOTHING. Runs the frozen pre-move code
 * (tests/a0-legacy-pipeline.js) and the new lib/analyze.js computeNumbers() on
 * the same inputs and asserts the outputs are identical, for every complete
 * saved analysis (read-only Supabase GETs of rental_analyses, rental_comps,
 * rental_comp_sources and properties; no writes of any kind).
 *
 * For each saved analysis it feeds both versions the analysis's stored comps,
 * rebuilt into the shape runActiveSources() hands the pipeline (source_name
 * restored from rental_comp_sources; the match columns removed so they are
 * recomputed). Because stored comps were already de-duplicated once, two
 * harder inputs are also run so dedupe winners are really exercised:
 *   - reversed: the same comps in the opposite order
 *   - stress:   the comps plus synthetic duplicates (same address, different
 *               status and source) and a few comps re-addressed to real
 *               Rincon-managed properties
 * The subject is given WITHOUT square footage or the form's furnished / lease /
 * 55+ facts, which switches the Phase B rules (size band, MLS facts) off in
 * lib/, so the frozen old code and the new file can still be compared exactly.
 * Compared, field for field (assert.deepStrictEqual): the full comp rows
 * including is_rincon_managed and comp_property_id, which copy survived
 * dedupe, the exclusion reason of every comp, the recommended range
 * (low/mid/high), the raw range (low/high), the counted-comp count, and the
 * before-dedupe count.
 *
 * Usage:
 *   node backtest/a0-replay.js
 *   node backtest/a0-replay.js --help
 */
const assert = require('node:assert/strict');
const { loadEnv, requireEnv } = require('./env');

if (process.argv.includes('--help')) {
  console.log(`
a0-replay.js - proves lib/analyze.js gives the same numbers as the old inline code.

Reads (GET only) the saved analyses and their comps from Supabase, runs the
frozen old code and the new lib/analyze.js on the same inputs, and checks they
match exactly. Prints what was compared and exits 1 on any difference.
Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (repo-root .env). No writes.
`);
  process.exit(0);
}

loadEnv();
requireEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

const { getAll } = require('./db');
const { computeNumbers } = require('../lib/analyze');
const { legacyNumbers } = require('./tests/a0-legacy-pipeline');
const { addressesMatch, fullAddress } = require('../lib/property-matching');
const { exclusionReason } = require('../lib/weighting');

const STORED_ONLY = new Set(['id', 'analysis_id', 'narrative', 'created_at', 'updated_at', 'comp_property_id', 'is_rincon_managed']);

function rebuildRawComp(row, sourceNameById) {
  const raw = {};
  for (const [k, v] of Object.entries(row)) if (!STORED_ONLY.has(k)) raw[k] = v;
  raw.source_name = sourceNameById.get(row.source_id) || null;
  return raw;
}

// Synthetic duplicates and Rincon-managed addresses, deterministic by index.
function stressInput(rawComps, properties) {
  const names = ['RentCast', 'CRMLS', 'LeadSimple Move-Ins'];
  const flipStatus = { leased: 'off_market', off_market: 'leased', active: 'off_market' };
  const out = [...rawComps];
  rawComps.forEach((c, i) => {
    if (i % 3 === 0) {
      out.push({
        ...c,
        address: c.address.replace(/\bSt\b/, 'Street').replace(/\bAve\b/, 'Avenue'),
        listing_status: flipStatus[c.listing_status] || c.listing_status,
        source_name: names[(names.indexOf(c.source_name) + 1 + names.length) % names.length],
        distance_miles: i % 6 === 0 ? null : c.distance_miles,
      });
    }
    if (i % 5 === 0 && properties.length) {
      out.push({ ...c, address: fullAddress(properties[(i * 7) % properties.length]), source_name: names[i % names.length] });
    }
  });
  return out;
}

function compare(label, input, subject, properties, tally) {
  const legacy = legacyNumbers({ rawComps: input, bedrooms: subject.bedrooms, subject_property_type: subject.propertyType, properties });
  const modern = computeNumbers({ comps: input, subject, properties });
  // computeNumbers() now also returns the counted totals, the headline range and the confidence label (Phase C).
  // The frozen old code knows only the first five fields, so exactly those are compared; "no number changed in the
  // old fields" is still what this proof says.
  const sameFields = { compsWithMatch: modern.compsWithMatch, matchedCount: modern.matchedCount, recommended: modern.recommended, raw: modern.raw, exclusionReasons: modern.exclusionReasons };
  assert.deepStrictEqual(sameFields, legacy, `${label}: computeNumbers() differs from the frozen old code`);
  tally.runs++;
  tally.compRows += modern.compsWithMatch.length;
  tally.rinconManagedRows += modern.compsWithMatch.filter(c => c.is_rincon_managed).length;
  tally.excludedRows += modern.exclusionReasons.filter(r => r !== null).length;
  tally.countedComps += modern.exclusionReasons.filter(r => r === null).length;
  tally.dedupeCollapsed += modern.matchedCount - modern.compsWithMatch.length;
  tally.rangesCompared += modern.recommended.mid === null ? 0 : 1;
  return modern;
}

async function main() {
  const [analyses, comps, sources, properties] = await Promise.all([
    getAll('rental_analyses', 'select=*&order=created_at.asc,id.asc'),
    getAll('rental_comps', 'select=*&order=id.asc'),
    getAll('rental_comp_sources', 'select=id,name'),
    getAll('properties', 'select=id,address,city,state,zip&order=id.asc'),
  ]);
  const sourceNameById = new Map(sources.map(s => [s.id, s.name]));
  const compsByAnalysis = new Map();
  for (const c of comps) {
    if (!compsByAnalysis.has(c.analysis_id)) compsByAnalysis.set(c.analysis_id, []);
    compsByAnalysis.get(c.analysis_id).push(c);
  }

  const complete = analyses.filter(a => a.status === 'complete');

  // "Distinct" = the latest complete run per address + property type, with the
  // same house typed several ways collapsed (addressesMatch), as in the spec.
  const distinct = [];
  for (const a of [...complete].reverse()) {
    if (!distinct.some(d => d.subject_property_type === a.subject_property_type && addressesMatch(d.subject_address, a.subject_address))) distinct.push(a);
  }
  const distinctIds = new Set(distinct.map(a => a.id));

  const tally = { analyses: 0, distinctAnalyses: 0, runs: 0, compRows: 0, rinconManagedRows: 0, excludedRows: 0, countedComps: 0, dedupeCollapsed: 0, rangesCompared: 0 };
  let storedRangeSame = 0, storedRangeDiffers = 0, storedManagedSame = 0, storedManagedDiffers = 0, analysesWithNoComps = 0;

  for (const a of complete) {
    const stored = compsByAnalysis.get(a.id) || [];
    if (!stored.length) { analysesWithNoComps++; continue; }
    const rawComps = stored.map(c => rebuildRawComp(c, sourceNameById));
    // No square footage and none of the form's furnished / lease / 55+ facts: that switches the Phase B rules
    // off in lib/, so this proof keeps meaning what it always did ("moving the pipeline into lib/analyze.js
    // changed no number"). What the Phase B rules themselves change is proved separately, by
    // backtest/phase-b-equivalence.js and the replay of saved reports shown in the Phase B report.
    const subject = { address: a.subject_address.trim(), propertyType: a.subject_property_type, bedrooms: a.subject_bedrooms, bathrooms: a.subject_bathrooms };
    const label = `${a.id.slice(0, 8)}`;

    const asStored = compare(`${label} as-stored`, rawComps, subject, properties, tally);
    compare(`${label} reversed`, [...rawComps].reverse(), subject, properties, tally);
    compare(`${label} stress`, stressInput(rawComps, properties), subject, properties, tally);
    tally.analyses++;
    if (distinctIds.has(a.id)) tally.distinctAnalyses++;

    // Informational only (not an assertion): did today's properties table and
    // today's code reproduce what was stored when the analysis ran?
    const sameRange = Number(a.recommended_rent_low) === asStored.recommended.low
      && Number(a.recommended_rent_mid) === asStored.recommended.mid
      && Number(a.recommended_rent_high) === asStored.recommended.high;
    if (sameRange) storedRangeSame++; else storedRangeDiffers++;
    const managedNow = asStored.compsWithMatch.map(c => c.is_rincon_managed).join();
    const managedThen = stored.map(c => c.is_rincon_managed).join();
    if (managedNow === managedThen) storedManagedSame++; else storedManagedDiffers++;
    // Sanity on the shared verdict: positional alignment.
    assert.equal(asStored.exclusionReasons.length, asStored.compsWithMatch.length);
    asStored.compsWithMatch.forEach((c, i) => assert.equal(asStored.exclusionReasons[i], exclusionReason(c, subject.bedrooms, subject.propertyType)));
  }

  console.log('A0 identity replay: PASS (old inline code and lib/analyze.js produced identical output everywhere)');
  console.log(`  saved analyses read: ${analyses.length} (${complete.length} complete; ${analysesWithNoComps} complete ones had no saved comps and were skipped)`);
  console.log(`  complete analyses compared: ${tally.analyses}; of these, distinct address+type: ${tally.distinctAnalyses} (spec says about 24)`);
  console.log(`  pipeline runs compared (3 per analysis: as-stored, reversed, stress): ${tally.runs}`);
  console.log(`  comp rows compared field-for-field after dedupe: ${tally.compRows} (is_rincon_managed true on ${tally.rinconManagedRows}; comp_property_id compared too)`);
  console.log(`  comps carrying an exclusion reason: ${tally.excludedRows}; counted comps: ${tally.countedComps}`);
  console.log(`  duplicate rows collapsed by dedupe across all runs: ${tally.dedupeCollapsed} (winner row compared by deepStrictEqual)`);
  console.log(`  recommended + raw ranges compared (non-null mid): ${tally.rangesCompared}`);
  console.log(`  info only, as-stored runs vs what was saved back then: recommended range equal ${storedRangeSame}, differs ${storedRangeDiffers} (older rules/properties changed); is_rincon_managed equal ${storedManagedSame}, differs ${storedManagedDiffers}`);
}

main().catch(err => {
  console.error('A0 identity replay: FAIL');
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
