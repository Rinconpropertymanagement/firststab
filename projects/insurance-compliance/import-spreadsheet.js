#!/usr/bin/env node
/**
 * import-spreadsheet.js
 * One-time import of the existing insurance spreadsheet into property_insurance.
 *
 * The spreadsheet tracks Yes/No compliance checkboxes per property address.
 * It does NOT contain policy numbers, insurer names, or expiration dates —
 * those will be filled in as declaration pages are uploaded going forward.
 *
 * Matching strategy: normalize both the spreadsheet "Unit Name" and the
 * Supabase properties.address to lowercase, strip punctuation, and compare.
 * Unmatched rows are written to unmatched.csv for manual review.
 *
 * Usage:
 *   node import-spreadsheet.js --dry-run    (preview matches, no writes)
 *   node import-spreadsheet.js              (write to Supabase)
 *
 * Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Required npm packages: @supabase/supabase-js, xlsx (install with: npm install xlsx)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');

const SPREADSHEET_PATH = path.join(
  require('os').homedir(),
  'Downloads/Insurance Spreadsheet.xlsx'
);
const UNMATCHED_PATH = path.join(__dirname, 'unmatched.csv');
const DRY_RUN = process.argv.includes('--dry-run');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Normalize an address string for fuzzy matching
function normalize(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .replace(/[.,#\-]/g, ' ')   // punctuation → space
    .replace(/\s+/g, ' ')       // collapse whitespace
    .replace(/\b(st|street)\b/g, 'st')
    .replace(/\b(ave|avenue)\b/g, 'ave')
    .replace(/\b(dr|drive)\b/g, 'dr')
    .replace(/\b(blvd|boulevard)\b/g, 'blvd')
    .replace(/\b(rd|road)\b/g, 'rd')
    .replace(/\b(ln|lane)\b/g, 'ln')
    .replace(/\b(ct|court)\b/g, 'ct')
    .replace(/\b(pl|place)\b/g, 'pl')
    .replace(/\b(cir|circle)\b/g, 'cir')
    .replace(/\b(hwy|highway)\b/g, 'hwy')
    .replace(/\b(apt|unit|#)\b/g, '')
    .trim();
}

function yesNo(val) {
  if (!val) return false;
  return String(val).trim().toLowerCase() === 'yes';
}

async function main() {
  console.log(`[import] Reading spreadsheet: ${SPREADSHEET_PATH}`);
  const wb = XLSX.readFile(SPREADSHEET_PATH);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  // Data starts at row 18 (index 17), headers at row 17 (index 16)
  const dataRows = raw.slice(17).filter(r => r[0] && String(r[0]).trim() && !String(r[0]).includes('Properties Onboarded'));

  console.log(`[import] Found ${dataRows.length} rows in spreadsheet`);

  // Load all properties from Supabase
  console.log('[import] Loading properties from Supabase...');
  const { data: properties, error: propError } = await supabase
    .from('properties')
    .select('id, appfolio_id, name, address');

  if (propError) {
    console.error('[import] Failed to load properties:', propError.message);
    process.exit(1);
  }

  console.log(`[import] Loaded ${properties.length} properties from Supabase`);

  // Build normalized lookup map: normalized_address → property row
  const propMap = new Map();
  for (const p of properties) {
    const key = normalize(p.address || p.name || '');
    if (key) propMap.set(key, p);
  }

  // Match spreadsheet rows to properties
  const matched   = [];
  const unmatched = [];

  for (const row of dataRows) {
    const unitName = String(row[0] || '').trim();
    // Skip sub-unit rows that are just numbers (e.g. "332.0", "748 1/2")
    if (/^[\d\s./]+$/.test(unitName)) continue;

    const normName = normalize(unitName);
    let property = propMap.get(normName);

    // Fallback: try matching just the street number + first word of street name
    if (!property) {
      const parts = normName.split(' ');
      if (parts.length >= 2) {
        const shortKey = parts.slice(0, 2).join(' ');
        for (const [k, v] of propMap.entries()) {
          if (k.startsWith(shortKey)) {
            property = v;
            break;
          }
        }
      }
    }

    const spreadsheetData = {
      unit_name:              unitName,
      ls_process_started:     yesNo(row[1]),
      file_in_appfolio:       yesNo(row[2]),
      expiry_updated:         yesNo(row[3]),
      additional_insured:     yesNo(row[4]),
      coverage_ok:            yesNo(row[5]),
    };

    if (property) {
      matched.push({ property, spreadsheetData });
    } else {
      unmatched.push(spreadsheetData);
    }
  }

  console.log(`[import] Matched: ${matched.length} | Unmatched: ${unmatched.length}`);

  // Write unmatched to CSV for manual review
  if (unmatched.length > 0) {
    const csvLines = [
      'Unit Name,LS Process Started,File in AF,Expiry Updated,Additional Insured,Coverage OK',
      ...unmatched.map(u =>
        `"${u.unit_name}",${u.ls_process_started},${u.file_in_appfolio},${u.expiry_updated},${u.additional_insured},${u.coverage_ok}`
      )
    ];
    fs.writeFileSync(UNMATCHED_PATH, csvLines.join('\n'));
    console.log(`[import] Unmatched rows written to: ${UNMATCHED_PATH}`);
  }

  if (DRY_RUN) {
    console.log('\n[dry-run] Sample matches (first 10):');
    matched.slice(0, 10).forEach(({ property, spreadsheetData }) => {
      console.log(`  "${spreadsheetData.unit_name}" → ${property.address || property.name} (${property.appfolio_id})`);
    });
    console.log('\n[dry-run] No data written. Run without --dry-run to import.');
    return;
  }

  // Determine status for each matched property
  // The spreadsheet has no expiration dates — all imported rows get status
  // 'pending_review' so PMs know to upload the actual declaration page.
  // If additional_insured and coverage are both Yes, we mark as pending_review
  // (not compliant) since we don't have the actual policy on file yet.
  let inserted = 0;
  let skipped  = 0;
  let errors   = 0;

  for (const { property, spreadsheetData } of matched) {
    // Check if a current policy already exists for this property
    const { data: existing } = await supabase
      .from('property_insurance')
      .select('id')
      .eq('appfolio_property_id', property.appfolio_id)
      .eq('is_current', true)
      .maybeSingle();

    if (existing) {
      skipped++;
      continue;
    }

    const record = {
      property_id:                  property.id,
      appfolio_property_id:         property.appfolio_id,
      additional_insured_verified:  spreadsheetData.additional_insured,
      coverage_amount_verified:     spreadsheetData.coverage_ok,
      status:                       'pending_review',
      is_current:                   true,
      notes: [
        spreadsheetData.file_in_appfolio   ? null : 'File not yet in AppFolio',
        spreadsheetData.expiry_updated     ? null : 'Expiration date not on record — upload declaration page',
        !spreadsheetData.additional_insured ? 'Rincon not listed as additional insured — needs correction' : null,
        !spreadsheetData.coverage_ok        ? 'Coverage amount needs verification' : null,
      ].filter(Boolean).join('; ') || null,
    };

    const { error } = await supabase.from('property_insurance').insert(record);

    if (error) {
      console.error(`[import] Error inserting ${property.address || property.name}:`, error.message);
      errors++;
    } else {
      inserted++;
      if (inserted % 50 === 0) console.log(`[import] Progress: ${inserted} inserted...`);
    }
  }

  console.log(`\n[import] Done.`);
  console.log(`  Inserted:  ${inserted}`);
  console.log(`  Skipped:   ${skipped} (already had a current policy)`);
  console.log(`  Errors:    ${errors}`);
  console.log(`  Unmatched: ${unmatched.length} (see unmatched.csv)`);

  if (unmatched.length > 0) {
    console.log('\n[import] Review unmatched.csv and add those properties manually.');
  }
}

main().catch(err => {
  console.error('[import] Fatal error:', err);
  process.exit(1);
});
