#!/usr/bin/env node
require('dotenv').config({ path: '/Users/petermckenzie/CODE/firststab/.env' });
const { createClient } = require('@supabase/supabase-js');

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { count: totalCount, error: totalErr } = await supabase
    .from('maintenance_snapshot_events')
    .select('*', { count: 'exact', head: true });
  if (totalErr) throw new Error('total count failed: ' + totalErr.message);

  const { count: flaggedCount, error: flagErr } = await supabase
    .from('maintenance_snapshot_events')
    .select('*', { count: 'exact', head: true })
    .eq('flagged_protected_class', true);
  if (flagErr) throw new Error('flagged count failed: ' + flagErr.message);

  console.log(JSON.stringify({
    total_rows: totalCount,
    flagged_rows: flaggedCount,
  }, null, 2));
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
