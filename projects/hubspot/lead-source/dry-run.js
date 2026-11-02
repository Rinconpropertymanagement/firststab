#!/usr/bin/env node
// Lead Source backfill — DRY RUN (read-only).
//
// Reads HubSpot, never writes. Produces the list Peter approves before any
// deal is updated. See claude/firstab-brief-hubspot-lead-source.md for the
// approved mapping and the rules (never overwrite a non-empty value; deals
// with no clean answer stay blank).
//
// Usage:  node projects/hubspot/lead-source/dry-run.js
// Output: projects/hubspot/lead-source/dry-run-<date>.csv  (+ summary on stdout)

const fs = require('fs');
const path = require('path');

// --- token from .env (never printed) ---------------------------------------
const envPath = path.join(__dirname, '..', '..', '..', '.env');
const env = Object.fromEntries(
  fs.readFileSync(envPath, 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);
const TOKEN = env.HUBSPOT_PRIVATE_APP_TOKEN;
if (!TOKEN) { console.error('HUBSPOT_PRIVATE_APP_TOKEN missing in .env'); process.exit(1); }
const BASE = 'https://api.hubapi.com';

// --- approved mapping: contact import_type -> deal lead_source --------------
const MAPPING = {
  'APM Lead': 'apm',
  'Geek Lead': 'geek_leads',
  'Yelp': 'yelp',
  'PPC Campaign': 'google_ads',
  'Contact Form': 'website_form',
  'Rental Analysis': 'rental_analysis',
  'Live Chat': 'live_chat_meeting_link',
  'Meeting Link': 'live_chat_meeting_link',
  'Direct Phone Call': 'phone',
  'PMW - Inbound Call': 'phone',
  'Owner Referral': 'referral_partner',
  'Realtor Referral': 'referral_partner',
  'Other Referral': 'referral_partner',
  'Sales Networking': 'networking_events',
  'Events': 'networking_events',
  // everything else -> blank (Purchased Lists, cold email reply, high intent *, N/A)
};
const LABELS = {
  apm: 'APM', geek_leads: 'Geek Leads', yelp: 'Yelp', google_ads: 'Google Ads', meta_ads: 'Meta Ads',
  website_form: 'Website form', rental_analysis: 'Rental analysis', live_chat_meeting_link: 'Live chat / meeting link',
  phone: 'Phone', referral_partner: 'Referral partner', existing_client: 'Existing client',
  networking_events: 'Networking/Events', other: 'Other',
};
// Known Yelp deals (rule a) — applied last, only if still blank.
const KNOWN_YELP_DEALS = { '326812009180': '1220 Nautical Way', '247930462968': '325 Harbor Breeze' };

async function hs(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) { await new Promise((r) => setTimeout(r, 1500)); return hs(method, url, body); }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}
const chunk = (arr, n) => arr.reduce((a, _, i) => (i % n ? a : [...a, arr.slice(i, i + n)]), []);

async function main() {
  // 1. contacts that have deals AND an import_type
  const contacts = [];
  let after;
  do {
    const page = await hs('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [
        { propertyName: 'num_associated_deals', operator: 'GT', value: '0' },
        { propertyName: 'import_type', operator: 'HAS_PROPERTY' },
      ] }],
      properties: ['firstname', 'lastname', 'import_type'],
      limit: 200, after,
    });
    contacts.push(...page.results);
    after = page.paging?.next?.after;
  } while (after);
  console.error(`contacts with deals + import type: ${contacts.length}`);

  // 2. contact -> deal associations
  const dealContacts = new Map(); // dealId -> [{contact}]
  for (const group of chunk(contacts, 100)) {
    const r = await hs('POST', '/crm/v4/associations/contacts/deals/batch/read', { inputs: group.map((c) => ({ id: c.id })) });
    for (const row of r.results || []) {
      const c = group.find((x) => String(x.id) === String(row.from.id));
      for (const t of row.to) {
        if (!dealContacts.has(String(t.toObjectId))) dealContacts.set(String(t.toObjectId), []);
        dealContacts.get(String(t.toObjectId)).push(c);
      }
    }
  }
  for (const id of Object.keys(KNOWN_YELP_DEALS)) if (!dealContacts.has(id)) dealContacts.set(id, []);
  console.error(`deals reached: ${dealContacts.size}`);

  // 3. deal details
  const deals = new Map();
  for (const ids of chunk([...dealContacts.keys()], 100)) {
    const r = await hs('POST', '/crm/v3/objects/deals/batch/read', {
      inputs: ids.map((id) => ({ id })),
      properties: ['dealname', 'lead_source', 'dealstage', 'createdate', 'pipeline', 'hs_is_closed_won', 'hs_is_closed_lost'],
    });
    for (const d of r.results) deals.set(String(d.id), d);
  }

  // 4. propose
  const rows = [];
  for (const [dealId, cs] of dealContacts) {
    const d = deals.get(dealId);
    if (!d) { rows.push({ dealId, note: 'deal not found (archived?)', decision: 'skip' }); continue; }
    const p = d.properties;
    const current = p.lead_source || '';
    const mapped = [...new Set(cs.map((c) => MAPPING[c.properties.import_type]).filter(Boolean))];
    const importTypes = [...new Set(cs.map((c) => c.properties.import_type))].join(' | ');
    const contactNames = cs.map((c) => `${c.properties.firstname || ''} ${c.properties.lastname || ''}`.trim()).join(' | ');
    let proposed = ''; let decision = ''; let note = '';
    if (current) { decision = 'skip'; note = 'already has a value — never overwritten'; }
    else if (mapped.length === 1) { proposed = mapped[0]; decision = 'write'; }
    else if (mapped.length > 1) { decision = 'skip'; note = `conflict: contacts map to ${mapped.map((m) => LABELS[m]).join(' vs ')}`; }
    else { decision = 'skip'; note = cs.length ? 'import type not in mapping → blank' : 'no mapped contact'; }
    if (!current && !proposed && KNOWN_YELP_DEALS[dealId]) { proposed = 'yelp'; decision = 'write'; note = 'rule a: known Yelp deal'; }
    if (KNOWN_YELP_DEALS[dealId] && proposed && proposed !== 'yelp') { decision = 'skip'; note = `known Yelp deal but mapping says ${LABELS[proposed]} — Peter decides`; proposed = ''; }
    const status = p.hs_is_closed_won === 'true' ? 'won' : p.hs_is_closed_lost === 'true' ? 'lost' : 'open';
    rows.push({ dealId, dealName: p.dealname, created: (p.createdate || '').slice(0, 10), status, contactNames, importTypes, current, proposed: proposed ? LABELS[proposed] : '', proposedValue: proposed, decision, note });
  }
  rows.sort((a, b) => (a.decision === b.decision ? (b.created || '').localeCompare(a.created || '') : a.decision === 'write' ? -1 : 1));

  // 5. output
  const date = new Date().toISOString().slice(0, 10);
  const out = path.join(__dirname, `dry-run-${date}.csv`);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const cols = ['dealId', 'dealName', 'created', 'status', 'contactNames', 'importTypes', 'current', 'proposed', 'proposedValue', 'decision', 'note'];
  fs.writeFileSync(out, [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n');

  const writes = rows.filter((r) => r.decision === 'write');
  const byValue = {};
  for (const r of writes) byValue[r.proposed] = (byValue[r.proposed] || 0) + 1;
  console.log(`\nDRY RUN ${date} — nothing written`);
  console.log(`deals reviewed: ${rows.length}`);
  console.log(`proposed writes: ${writes.length}`);
  for (const [k, v] of Object.entries(byValue).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(26)} ${v}`);
  console.log(`skipped: ${rows.length - writes.length}`);
  const skipReasons = {};
  for (const r of rows.filter((r) => r.decision !== 'write')) { const k = r.note.split(':')[0]; skipReasons[k] = (skipReasons[k] || 0) + 1; }
  for (const [k, v] of Object.entries(skipReasons)) console.log(`  ${k.padEnd(40)} ${v}`);
  console.log(`\nfull list: ${out}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
