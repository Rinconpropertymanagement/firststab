// Real-world test: run detectLegalClaims() against Peter's actual live
// article body (content_items.id = e2e55b46-9716-4224-b05e-6d8a0a43200f),
// with no grounding claims linked to it (getLinkedClaims returns [] for
// this item — the vacancy-cost piece is a general/non-legal-topic post),
// per the build task's own suggested real-world test case.
require('dotenv').config({ path: '../../.env' });
const { select } = require('./lib/supabase');
const { detectLegalClaims } = require('./lib/package-draft');
const { getLinkedClaims } = require('./lib/revise');

const CONTENT_ITEM_ID = 'e2e55b46-9716-4224-b05e-6d8a0a43200f';

async function main() {
  const rows = await select(
    'content_items',
    `select=id,title,content_type,body&id=eq.${CONTENT_ITEM_ID}`
  );
  if (rows.length === 0) {
    console.log('Content item not found.');
    process.exit(1);
  }
  const item = rows[0];
  const linkedClaims = await getLinkedClaims(CONTENT_ITEM_ID);
  console.log('title:', item.title);
  console.log('content_type:', item.content_type);
  console.log('linked grounding claims:', linkedClaims.length);
  console.log('body length:', item.body.length);

  const findings = await detectLegalClaims(item.body, linkedClaims);
  console.log(`\n${findings.length} finding(s):\n`);
  findings.forEach((f, i) => {
    console.log(`${i + 1}. [${f.detectedBy}] sourceUrl=${f.sourceUrl}`);
    console.log(`   claimText: ${f.claimText}`);
    console.log(`   context:   ${f.context}`);
    console.log('');
  });
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
