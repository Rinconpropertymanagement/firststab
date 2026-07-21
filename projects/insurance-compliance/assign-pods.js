#!/usr/bin/env node
/**
 * assign-pods.js
 * One-time script to assign properties to Solimar or Faria pod
 * based on the AppFolio portfolio CSVs.
 *
 * Usage:
 *   node assign-pods.js --dry-run    (preview matches, no writes)
 *   node assign-pods.js              (update properties.pod in Supabase)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs   = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = process.argv.includes('--dry-run');

const SOLIMAR_PATH = path.join(require('os').homedir(), 'Downloads/Solimar.csv');
const FARIA_PATH   = path.join(require('os').homedir(), 'Downloads/Faria.csv');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function normalize(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .replace(/[.,#\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(st|street)\b/g, 'st')
    .replace(/\b(ave|avenue)\b/g, 'ave')
    .replace(/\b(dr|drive)\b/g, 'dr')
    .replace(/\b(blvd|boulevard)\b/g, 'blvd')
    .replace(/\b(rd|road)\b/g, 'rd')
    .replace(/\b(ln|lane)\b/g, 'ln')
    .replace(/\b(ct|court)\b/g, 'ct')
    .replace(/\b(pl|place)\b/g, 'pl')
    .replace(/\b(cir|circle)\b/g, 'cir')
    .replace(/\b(apt|unit|#)\b/g, '')
    .trim();
}

// Extract property addresses from a CSV — pulls the "-> Address - Full Address" header rows
function extractAddresses(csvPath) {
  const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
  const addresses = [];
  for (const line of lines) {
    // Match lines like: "-> 102 Hoover Ave - 102 Hoover Ave. Ventura, CA 93003"
    const match = line.match(/^"-> (.+?) - (.+?),\s*[A-Z]{2}\s*\d+/);
    if (match) {
      // Use the short name (before the dash) — it matches how AppFolio stores property names
      addresses.push(match[1].trim());
    }
  }
  return addresses;
}

async function main() {
  console.log('[pods] Reading pod CSVs...');
  const soli  = extractAddresses(SOLIMAR_PATH);
  const faria = extractAddresses(FARIA_PATH);
  console.log(`[pods] Solimar: ${soli.length} properties | Faria: ${faria.length} properties`);

  // Load all properties from Supabase
  console.log('[pods] Loading properties from Supabase...');
  const { data: properties, error } = await supabase
    .from('properties')
    .select('id, appfolio_id, name, address, pod');

  if (error) { console.error('[pods] Failed:', error.message); process.exit(1); }
  console.log(`[pods] Loaded ${properties.length} properties`);

  // Build normalized lookup
  const propMap = new Map();
  for (const p of properties) {
    const key = normalize(p.address || p.name || '');
    if (key) propMap.set(key, p);
    // Also index by name separately
    if (p.name) {
      const nameKey = normalize(p.name);
      if (nameKey !== key) propMap.set(nameKey, p);
    }
  }

  // Match and assign pods
  const assignments = new Map(); // property id → pod

  for (const addr of soli) {
    const key = normalize(addr);
    const prop = propMap.get(key) || findPartial(propMap, key);
    if (prop) assignments.set(prop.id, 'Solimar');
    else console.warn(`[pods] No match (Solimar): "${addr}"`);
  }

  for (const addr of faria) {
    const key = normalize(addr);
    const prop = propMap.get(key) || findPartial(propMap, key);
    if (prop) {
      if (assignments.has(prop.id) && assignments.get(prop.id) !== 'Faria') {
        console.warn(`[pods] Conflict: "${addr}" matched to both pods — keeping Solimar`);
      } else {
        assignments.set(prop.id, 'Faria');
      }
    } else {
      console.warn(`[pods] No match (Faria): "${addr}"`);
    }
  }

  console.log(`[pods] Matched: ${assignments.size} properties`);

  if (DRY_RUN) {
    let s = 0, f = 0;
    for (const [, pod] of assignments) { if (pod === 'Solimar') s++; else f++; }
    console.log(`[dry-run] Would assign: Solimar=${s}, Faria=${f}`);
    console.log('[dry-run] No data written. Run without --dry-run to update.');
    return;
  }

  // Update in batches
  let updated = 0, errors = 0;
  for (const [id, pod] of assignments) {
    const { error: updateErr } = await supabase
      .from('properties')
      .update({ pod })
      .eq('id', id);

    if (updateErr) {
      console.error(`[pods] Update failed for ${id}:`, updateErr.message);
      errors++;
    } else {
      updated++;
    }
  }

  // Count unassigned
  const unassigned = properties.filter(p => !assignments.has(p.id) && !p.pod).length;

  console.log(`\n[pods] Done.`);
  console.log(`  Updated:    ${updated}`);
  console.log(`  Errors:     ${errors}`);
  console.log(`  Unassigned: ${unassigned} (not in either pod file — likely new properties)`);
}

function findPartial(propMap, key) {
  const parts = key.split(' ');
  if (parts.length < 2) return null;
  const shortKey = parts.slice(0, 2).join(' ');
  for (const [k, v] of propMap.entries()) {
    if (k.startsWith(shortKey)) return v;
  }
  return null;
}

main().catch(err => {
  console.error('[pods] Fatal:', err);
  process.exit(1);
});
