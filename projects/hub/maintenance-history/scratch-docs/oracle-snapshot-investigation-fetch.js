#!/usr/bin/env node
require('dotenv').config({ path: '/Users/petermckenzie/CODE/firststab/.env' });
const { createClient } = require('@supabase/supabase-js');
const { scanText } = require('../lib/protected-class-terms');
const fs = require('fs');

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const pageSize = 1000;
  let all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('maintenance_snapshot_events')
      .select('id, property_id, event_date, summary, amount, vendor_name, source, source_reference, extracted_by, flagged_protected_class, flagged_category, review_status, created_at')
      .eq('flagged_protected_class', true)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error('fetch failed: ' + error.message);
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  console.error(`Fetched ${all.length} flagged rows.`);

  // Run Layer 1 scanText() against the stored summary text (which embeds the
  // raw AppFolio `description` text verbatim as its first component — see
  // backfill-maintenance-snapshot.js's buildSummary() and its own
  // recheck-existing comment confirming this is the same real content Layer
  // 2 judged at write time). This tells us exactly which dictionary term(s)
  // matched for each row, same as the original 340-claim review did against
  // claim_text.
  const enriched = all.map((row) => {
    const layer1 = scanText(row.summary);
    return {
      ...row,
      layer1_matched_terms: layer1.matchedTerms,
      layer1_categories: layer1.categories,
      layer1_flagged: layer1.flagged,
    };
  });

  fs.writeFileSync(
    '/Users/petermckenzie/CODE/firststab/projects/hub/maintenance-history/scratch-docs/oracle-snapshot-flagged-rows.json',
    JSON.stringify(enriched, null, 2)
  );
  console.error('Wrote oracle-snapshot-flagged-rows.json');

  // Quick term-frequency breakdown for a first look.
  const termCounts = {};
  for (const row of enriched) {
    for (const t of row.layer1_matched_terms) {
      termCounts[t] = (termCounts[t] || 0) + 1;
    }
  }
  console.error('Layer 1 matched-term frequency across flagged rows:');
  console.error(JSON.stringify(termCounts, null, 2));

  const noLayer1Match = enriched.filter((r) => !r.layer1_flagged);
  console.error(`Rows flagged but with NO Layer 1 match on stored summary text (i.e. Layer-2-only flags, or flags driven by raw description text not fully captured in summary): ${noLayer1Match.length}`);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
