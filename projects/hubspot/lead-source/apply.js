#!/usr/bin/env node
// Lead Source backfill — APPLY the list Peter approved on 2026-11-02.
//
// Source of truth: dry-run-2026-11-02.csv (every row with decision=write)
// plus Peter's overrides from chat on 2026-11-02:
//   - "approve all 333"
//   - 325 Harbor Breeze (247930462968) -> Yelp
//   - leave the three two-contact conflicts blank
//   - any deal with "Geek" in the title -> Geek Leads
//
// Safety: re-reads every deal's lead_source right before writing and skips
// any that is no longer empty. Logs every write to write-log-<date>.csv.
// Verifies by reading every deal back after the write.
//
// Usage: node projects/hubspot/lead-source/apply.js [--dry]

const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry');
const envPath = path.join(__dirname, '..', '..', '..', '.env');
const env = Object.fromEntries(
  fs.readFileSync(envPath, 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);
const TOKEN = env.HUBSPOT_PRIVATE_APP_TOKEN;
if (!TOKEN) { console.error('HUBSPOT_PRIVATE_APP_TOKEN missing in .env'); process.exit(1); }
const BASE = 'https://api.hubapi.com';

const OVERRIDES = {
  '247930462968': 'yelp',       // 325 Harbor Breeze — Peter: Yelp
  '19414159032': 'geek_leads',  // 1206 Mission Verde Dr - Geek Lead
  '18762035117': 'geek_leads',  // 10556 Susan Ave - Geek
  '11335965077': 'geek_leads',  // 2983 E Sierra Dr - Geek Lead
  '19191011091': 'geek_leads',  // 170 N H St - Geek Lead (was skipped: cold email reply)
};

async function hs(method, url, body) {
  const res = await fetch(BASE + url, {
    method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) { await new Promise((r) => setTimeout(r, 1500)); return hs(method, url, body); }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}
const chunk = (arr, n) => arr.reduce((a, _, i) => (i % n ? a : [...a, arr.slice(i, i + n)]), []);

function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [h, ...rest] = rows;
  return rest.filter((r) => r.length === h.length).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}

async function main() {
  const rows = parseCsv(fs.readFileSync(path.join(__dirname, 'dry-run-2026-11-02.csv'), 'utf8'));
  const plan = new Map(); // dealId -> { value, name }
  for (const r of rows) if (r.decision === 'write' && r.proposedValue) plan.set(r.dealId, { value: r.proposedValue, name: r.dealName });
  for (const [id, value] of Object.entries(OVERRIDES)) {
    const r = rows.find((x) => x.dealId === id);
    plan.set(id, { value, name: r ? r.dealName : id });
  }
  console.log(`planned writes: ${plan.size} (dry-run writes ${rows.filter((r) => r.decision === 'write').length} + overrides)`);

  // re-read current values
  const ids = [...plan.keys()];
  const current = new Map();
  for (const group of chunk(ids, 100)) {
    const r = await hs('POST', '/crm/v3/objects/deals/batch/read', { inputs: group.map((id) => ({ id })), properties: ['dealname', 'lead_source'] });
    for (const d of r.results) current.set(String(d.id), d.properties);
  }
  const toWrite = []; const skipped = [];
  for (const id of ids) {
    const cur = current.get(id);
    if (!cur) { skipped.push({ id, reason: 'not found' }); continue; }
    if (cur.lead_source) { skipped.push({ id, reason: `already ${cur.lead_source}` }); continue; }
    toWrite.push({ id, properties: { lead_source: plan.get(id).value } });
  }
  console.log(`to write now: ${toWrite.length}, skipped: ${skipped.length}`);
  for (const s of skipped) console.log(`  skip ${s.id} ${plan.get(s.id)?.name || ''}: ${s.reason}`);
  if (DRY) { console.log('DRY — nothing written'); return; }

  // write in batches of 50, log each
  const date = new Date().toISOString().slice(0, 10);
  const logPath = path.join(__dirname, `write-log-${date}.csv`);
  const log = ['timestamp,dealId,dealName,before,after,result'];
  let written = 0;
  for (const group of chunk(toWrite, 50)) {
    const r = await hs('POST', '/crm/v3/objects/deals/batch/update', { inputs: group });
    const ok = new Set(r.results.map((d) => String(d.id)));
    for (const g of group) {
      const res = ok.has(g.id) ? 'ok' : 'FAILED';
      if (res === 'ok') written++;
      log.push([new Date().toISOString(), g.id, JSON.stringify(plan.get(g.id).name), '', g.properties.lead_source, res].join(','));
    }
    process.stdout.write(`.`);
  }
  fs.writeFileSync(logPath, log.join('\n') + '\n');
  console.log(`\nwritten: ${written}/${toWrite.length}  log: ${logPath}`);

  // verify: read everything back
  const after = new Map();
  for (const group of chunk(ids, 100)) {
    const r = await hs('POST', '/crm/v3/objects/deals/batch/read', { inputs: group.map((id) => ({ id })), properties: ['lead_source'] });
    for (const d of r.results) after.set(String(d.id), d.properties.lead_source || '');
  }
  let match = 0; const mismatch = [];
  for (const w of toWrite) { if (after.get(w.id) === w.properties.lead_source) match++; else mismatch.push({ id: w.id, expected: w.properties.lead_source, got: after.get(w.id) }); }
  const counts = {};
  for (const v of after.values()) if (v) counts[v] = (counts[v] || 0) + 1;
  console.log(`verify: ${match}/${toWrite.length} match HubSpot`);
  for (const m of mismatch) console.log(`  MISMATCH ${m.id}: expected ${m.expected}, got ${m.got}`);
  console.log('HubSpot now holds, across the planned deals:');
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${v}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
