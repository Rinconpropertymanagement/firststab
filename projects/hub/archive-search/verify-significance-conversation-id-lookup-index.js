// Regression check for migration 20260922000000_add_missive_conversation_id_
// covering_index_to_significance_table.
//
// Times the EXACT query shape filterAlreadyProcessed() issues
// (significance-pass.js:995-1009) against missive_conversation_significance,
// plus two controls, so the effect of the new index can be measured on real
// data rather than argued from theory alone. Read-only — no writes, no
// deletes, no schema changes.
//
// HOW TO USE:
//   1. Run this BEFORE applying the migration (node
//      verify-significance-conversation-id-lookup-index.js > before.txt).
//   2. Apply the migration in Supabase's SQL Editor.
//   3. Run this AGAIN (> after.txt) and compare the two.
//
// Honest caveat from the "before" run done while writing this migration
// (2026-09-22): end-to-end HTTP/PostgREST round-trip overhead on this
// project's connection is itself noisy (roughly 75-270ms even for a
// no-filter, count-only HEAD request — see control A below), and at this
// table's current size (~34,000 rows) the query under test did NOT reproduce
// the >1,000ms figure originally reported. Read the printed comparison
// against control A (the floor) and control D (a query that already uses
// the existing index efficiently) rather than the raw number for B alone —
// a real regression shows up as B moving further from D, not just as B's
// absolute number.

require('dotenv').config({ path: '/Users/petermckenzie/CODE/firststab/.env' });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const TRIALS = 10;

function stats(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    mean: sum / sorted.length,
    max: sorted[sorted.length - 1],
  };
}

async function timeIt(label, fn, trials = TRIALS) {
  const timings = [];
  for (let i = 0; i < trials; i++) {
    const start = process.hrtime.bigint();
    const result = await fn();
    const end = process.hrtime.bigint();
    if (result && result.error) throw result.error;
    timings.push(Number(end - start) / 1e6);
  }
  const s = stats(timings);
  console.log(`${label}\n  min=${s.min.toFixed(1)}ms median=${s.median.toFixed(1)}ms mean=${s.mean.toFixed(1)}ms max=${s.max.toFixed(1)}ms`);
  return s;
}

async function main() {
  const { count: totalCount } = await supabase
    .from('missive_conversation_significance')
    .select('*', { count: 'exact', head: true });
  console.log(`missive_conversation_significance total rows: ${totalCount}\n`);

  const { data: sampleRows, error: sampleErr } = await supabase
    .from('missive_conversation_significance')
    .select('id, mailbox_key, missive_conversation_id')
    .limit(200);
  if (sampleErr) throw sampleErr;
  if (sampleRows.length === 0) throw new Error('Table is empty — cannot build a real test batch.');

  const ids200 = sampleRows.map((r) => r.missive_conversation_id);
  const pks200 = sampleRows.map((r) => r.id);
  const mailboxKey = sampleRows[0].mailbox_key;
  console.log(`Sample acquired: ${sampleRows.length} real rows.\n`);

  await timeIt('A) baseline floor — count-only HEAD, no filter (pure round-trip overhead)', () =>
    supabase.from('missive_conversation_significance').select('id', { count: 'exact', head: true })
  );

  await timeIt('B) QUERY UNDER TEST — filterAlreadyProcessed() shape: .in(missive_conversation_id, 200 ids)', () =>
    supabase.from('missive_conversation_significance').select('mailbox_key, missive_conversation_id').in('missive_conversation_id', ids200)
  );

  await timeIt('C) control — .in(id [primary key], 200 ids) — always index-backed', () =>
    supabase.from('missive_conversation_significance').select('id').in('id', pks200)
  );

  await timeIt('D) control — .eq(mailbox_key) limit 200 — uses the existing composite index\'s leading column', () =>
    supabase.from('missive_conversation_significance').select('mailbox_key, missive_conversation_id').eq('mailbox_key', mailboxKey).limit(200)
  );

  console.log('\nRead the printed medians for B relative to A and D, not B alone:');
  console.log('- Before the fix, B should sit noticeably above D (same-shape lookup that already uses an index).');
  console.log('- After the fix, B should move down toward D (ideally close to C, since the new index makes this an index-only scan).');
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1); });
