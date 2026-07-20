'use strict';

/**
 * AppFolio → Supabase Nightly Sync
 * Rincon Management
 *
 * Fetches data from 10 AppFolio reports and upserts it into Supabase.
 * Foreign-key joins (unit_id, tenant_id, property_id) are deferred to a future release.
 *
 * Usage:
 *   node sync.js              Run the full sync — fetch all reports and write to Supabase
 *   node sync.js --discover   Print the exact field names AppFolio returns, then exit (no writes)
 *   node sync.js --dry-run    Fetch and map data, print row counts, no Supabase writes
 */

const https = require('https');
const path  = require('path');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const AF_CLIENT_ID     = process.env.APPFOLIO_CLIENT_ID;
const AF_CLIENT_SECRET = process.env.APPFOLIO_CLIENT_SECRET;
const AF_HOST          = 'rinconpm.appfolio.com';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// AppFolio rate limit: 7 initial report requests per 15 seconds
// Pagination requests are exempt and do not count toward this limit
const RATE_LIMIT_BATCH = 7;
const RATE_LIMIT_PAUSE = 15_000;

// ─────────────────────────────────────────────────────────────────────────────
// REPORT CONFIG
// Field names here are the real AppFolio field names confirmed by --discover.
// ─────────────────────────────────────────────────────────────────────────────

const REPORT_CONFIG = [

  // ── 1. Properties ────────────────────────────────────────────────────────
  {
    reportName: 'property_directory',
    table: 'properties',

    buildRow(row) {
      return {
        name:        row.property_name || row.property_street || row.property_address || null,
        address:     row.property_street || null,
        city:        row.property_city   || null,
        state:       row.property_state  || 'CA',
        zip:         row.property_zip    || null,
        unit_count:  parseInt(row.units) || null,
        appfolio_id: String(row.property_id),
      };
    },
  },

  // ── 2. Units ─────────────────────────────────────────────────────────────
  {
    reportName: 'unit_directory',
    table: 'units',

    buildRow(row) {
      return {
        property_id:  null,
        unit_number:  row.unit_name                    || null,
        bedrooms:     parseInt(row.bedrooms)           || null,
        bathrooms:    parseFloat(row.bathrooms)        || null,
        sqft:         parseInt(row.sqft)               || null,
        monthly_rent: parseFloat(row.market_rent)      || null,
        status:       'vacant', // unit_vacancy will override occupied units
        appfolio_id:  String(row.unit_id),
      };
    },
  },

  // ── 3. Tenants ───────────────────────────────────────────────────────────
  {
    reportName: 'tenant_directory',
    table: 'tenants',

    buildRow(row) {
      // emails and phone_numbers may be comma-separated strings — take the first
      const email = row.emails
        ? String(row.emails).split(',')[0].trim() || null
        : null;
      const phone = row.phone_numbers
        ? String(row.phone_numbers).split(',')[0].trim() || null
        : null;
      // selected_tenant_id is AppFolio's own ID for this tenant
      const afId = row.selected_tenant_id || row.occupancy_import_uid;
      return {
        first_name:  row.first_name || null,
        last_name:   row.last_name  || null,
        email,
        phone,
        appfolio_id: String(afId),
      };
    },
  },

  // ── 4. Delinquency (writes to leases — runs before rent_roll) ────────────
  {
    reportName: 'delinquency',
    table: 'leases',

    buildRow(row) {
      const balance = row.amount_receivable || null;
      return {
        unit_id:      null,
        tenant_id:    null,
        lease_start:  row.move_in  || null,
        lease_end:    row.move_out || null,
        monthly_rent: parseFloat(row.rent) || null,
        status:       'active',
        notes:        balance ? `Delinquent — balance due: ${balance}` : null,
        appfolio_id:  String(row.occupancy_id),
      };
    },
  },

  // ── 5. Tenant tickler (move-ins/move-outs) ────────────────────────────────
  {
    reportName: 'tenant_tickler',
    table: 'leases',

    buildRow(row) {
      const event   = (row.event || '').toLowerCase();
      const moveOut = row.move_out_date || null;
      let status = 'active';
      if (event.includes('move-out') || event.includes('notice')) status = 'terminated';
      else if (event.includes('move-in')) status = 'pending';
      return {
        unit_id:      null,
        tenant_id:    null,
        lease_start:  row.lease_from || null,
        lease_end:    row.lease_to   || null,
        monthly_rent: parseFloat(row.rent) || null,
        status,
        notes:        moveOut
          ? `Move-out: ${moveOut} — ${row.move_out_reason || 'reason not recorded'}`
          : `Move-in: ${row.move_in_date || 'date unknown'}`,
        appfolio_id:  String(row.occupancy_id),
      };
    },
  },

  // ── 6. Lease expirations ──────────────────────────────────────────────────
  {
    reportName: 'lease_expiration_detail',
    table: 'leases',

    buildRow(row) {
      return {
        unit_id:      null,
        tenant_id:    null,
        lease_start:  row.move_in        || null,
        lease_end:    row.lease_expires  || null, // AppFolio field is lease_expires here
        monthly_rent: parseFloat(row.rent) || null,
        status:       'active',
        notes:        `Expiring: ${row.lease_expires_month || row.lease_expires || 'soon'}`,
        appfolio_id:  String(row.occupancy_id),
      };
    },
  },

  // ── 7. Vacant units (sets status = vacant for units in this report) ───────
  {
    reportName: 'unit_vacancy',
    table: 'units',

    buildRow(row) {
      return {
        property_id:  null,
        unit_number:  row.unit    || null,
        bedrooms:     null, // not in vacancy report — unit_directory has it
        bathrooms:    null,
        sqft:         parseInt(row.sqft)           || null,
        monthly_rent: parseFloat(row.new_rent || row.schd_rent) || null,
        status:       'vacant',
        appfolio_id:  String(row.unit_id),
      };
    },
  },

  // owner_directory is handled by syncOwnerDirectory() — see below.

  // ── 9. Work orders ───────────────────────────────────────────────────────
  {
    reportName: 'work_order',
    table: 'maintenance_requests',

    buildRow(row) {
      const STATUS_MAP = {
        new: 'open', open: 'open',
        assigned: 'assigned',
        in_progress: 'in_progress', 'in progress': 'in_progress',
        completed: 'completed', complete: 'completed',
        closed: 'closed',
      };
      const PRIORITY_MAP = {
        low: 'low',
        normal: 'medium', medium: 'medium',
        high: 'high',
        urgent: 'urgent', emergency: 'urgent',
      };

      const rawStatus   = (row.status   || '').toLowerCase().replace(/\s+/g, '_');
      const rawPriority = (row.priority || '').toLowerCase();
      const desc = row.job_description || row.service_request_description || null;

      let completedAt = null;
      const completedRaw = row.work_completed_on || row.completed_on;
      if (completedRaw) {
        const d = new Date(completedRaw);
        if (!isNaN(d.getTime())) completedAt = d.toISOString();
      }

      return {
        unit_id:      null,
        title:        desc ? String(desc).substring(0, 100) : `Work order ${row.work_order_number || ''}`,
        description:  desc || null,
        status:       STATUS_MAP[rawStatus]   || 'open',
        priority:     PRIORITY_MAP[rawPriority] || 'medium',
        vendor_name:  row.vendor || null,
        cost:         parseFloat(row.amount) || null,
        completed_at: completedAt,
        appfolio_id:  String(row.work_order_id || row.work_order_number),
      };
    },
  },

  // ── 10. Rent roll (most complete lease data — runs LAST, wins on conflict) ─
  {
    reportName: 'rent_roll',
    table: 'leases',

    buildRow(row) {
      const pastDue = row.past_due || null;
      const pastDueNote = pastDue && pastDue !== '0' && pastDue !== '0.00' && pastDue !== '$0.00'
        ? `Past due: ${pastDue}`
        : null;
      const statusRaw = (row.status || '').toLowerCase();
      let status = 'active';
      if (statusRaw.includes('notice')) status = 'terminated';
      else if (statusRaw.includes('past')) status = 'expired';
      return {
        unit_id:      null,
        tenant_id:    null,
        lease_start:  row.lease_from || null,
        lease_end:    row.lease_to   || null,
        monthly_rent: parseFloat(row.rent || row.market_rent) || null,
        status,
        notes:        pastDueNote,
        appfolio_id:  String(row.occupancy_id),
      };
    },
  },

];

// ─────────────────────────────────────────────────────────────────────────────
// HTTP HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
        resolve({ statusCode: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function afAuthHeader() {
  return 'Basic ' + Buffer.from(`${AF_CLIENT_ID}:${AF_CLIENT_SECRET}`).toString('base64');
}

async function afPost(reportName) {
  const body = '{}';
  const result = await httpsRequest({
    hostname: AF_HOST,
    path:     `/api/v2/reports/${reportName}.json`,
    method:   'POST',
    headers:  {
      'Authorization': afAuthHeader(),
      'Content-Type':  'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(`AppFolio returned HTTP ${result.statusCode} for "${reportName}": ${JSON.stringify(result.body).substring(0, 200)}`);
  }
  return result.body;
}

// AppFolio returns { results: [{...row...}, ...], next_page_url: "..." }
// The results array contains plain objects — no field/data conversion needed.
async function fetchAllPages(reportName) {
  const first    = await afPost(reportName);
  let rows       = Array.isArray(first.results) ? first.results : [];
  let nextUrl    = first.next_page_url || null;

  while (nextUrl) {
    const parsed = new URL(nextUrl);
    const page   = await httpsRequest({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  { 'Authorization': afAuthHeader() },
    });
    if (page.statusCode < 200 || page.statusCode >= 300) {
      throw new Error(`AppFolio pagination returned HTTP ${page.statusCode}`);
    }
    const pBody = page.body;
    rows    = rows.concat(Array.isArray(pBody.results) ? pBody.results : []);
    nextUrl = pBody.next_page_url || null;
  }

  return rows;
}

async function supabaseUpsert(table, rows) {
  if (rows.length === 0) return;
  const sbHost = new URL(SB_URL).hostname;
  const body   = JSON.stringify(rows);
  const result = await httpsRequest({
    hostname: sbHost,
    path:     `/rest/v1/${table}?on_conflict=appfolio_id`,
    method:   'POST',
    headers:  {
      'apikey':          SB_KEY,
      'Authorization':   `Bearer ${SB_KEY}`,
      'Content-Type':    'application/json',
      'Content-Length':  Buffer.byteLength(body),
      'Prefer':          'resolution=merge-duplicates',
    },
  }, body);
  if (result.statusCode < 200 || result.statusCode >= 300) {
    const detail = typeof result.body === 'object'
      ? JSON.stringify(result.body)
      : String(result.body).substring(0, 300);
    throw new Error(`Supabase upsert to "${table}" returned HTTP ${result.statusCode}: ${detail}`);
  }
}

// Like supabaseUpsert but takes an explicit list of conflict columns.
// Used for tables whose unique key spans more than one column (e.g. property_owners).
async function supabaseUpsertComposite(table, conflictCols, rows) {
  if (rows.length === 0) return;
  const sbHost   = new URL(SB_URL).hostname;
  const body     = JSON.stringify(rows);
  const conflict = conflictCols.join(',');
  const result   = await httpsRequest({
    hostname: sbHost,
    path:     `/rest/v1/${table}?on_conflict=${conflict}`,
    method:   'POST',
    headers:  {
      'apikey':         SB_KEY,
      'Authorization':  `Bearer ${SB_KEY}`,
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Prefer':         'resolution=merge-duplicates',
    },
  }, body);
  if (result.statusCode < 200 || result.statusCode >= 300) {
    const detail = typeof result.body === 'object'
      ? JSON.stringify(result.body)
      : String(result.body).substring(0, 300);
    throw new Error(`Supabase upsert to "${table}" returned HTTP ${result.statusCode}: ${detail}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// OWNER DIRECTORY — special case: one report writes to two tables
// ─────────────────────────────────────────────────────────────────────────────

// Fetches owner_directory, writes unique owners to `owners` and per-property
// links to `property_owners`. Logs counts only — no names or phone numbers.
async function syncOwnerDirectory(isDryRun, isDiscover, summary) {
  const reportName = 'owner_directory';

  console.log(`[${reportName}] Fetching...`);

  let rows;
  try {
    rows = await fetchAllPages(reportName);
  } catch (err) {
    console.error(`[${reportName}] FETCH ERROR: ${err.message}`);
    summary.push({ reportName, status: 'FETCH_ERROR', error: err.message });
    return;
  }

  if (isDiscover) {
    const keys = rows.length > 0 ? Object.keys(rows[0]) : [];
    console.log(`[${reportName}] ${rows.length} rows — FIELDS: ${JSON.stringify(keys)}\n`);
    summary.push({ reportName, status: 'DISCOVERED', rowCount: rows.length });
    return;
  }

  console.log(`[${reportName}] Fetched ${rows.length} rows.`);

  // owner_directory has one row per owner (not per property).
  // properties_owned_i_ds is a comma-separated list of AppFolio property IDs.
  const ownerRows         = [];
  const propertyOwnerRows = [];

  for (const row of rows) {
    const ownerId = String(row.owner_id || '').trim();
    if (!ownerId || ownerId === 'null') continue;

    // Phone numbers come as "Mobile: (805) 555-1234, Work: (805) 555-5678" — take the first number only
    let phone = null;
    if (row.phone_numbers) {
      const firstPhone = String(row.phone_numbers).split(',')[0];
      phone = firstPhone.replace(/^[^(]+/, '').trim() || null; // strip label like "Mobile: "
    }

    // Count how many properties this owner owns by splitting the IDs
    const propIds = row.properties_owned_i_ds
      ? String(row.properties_owned_i_ds).split(',').map(s => s.trim()).filter(Boolean)
      : [];

    ownerRows.push({
      appfolio_id: ownerId,
      name:        row.name       || null,
      phone,
      email:       row.email      || null,
      total_units: null, // not available per-owner in this report; calculated from property_owners
    });

    for (const propId of propIds) {
      propertyOwnerRows.push({
        appfolio_property_id: propId,
        appfolio_owner_id:    ownerId,
        unit_count:           null, // unit count per property not in owner_directory
      });
    }
  }

  console.log(`[${reportName}] Mapped ${ownerRows.length} unique owners → owners.`);
  console.log(`[${reportName}] Mapped ${propertyOwnerRows.length} links → property_owners.`);

  if (isDryRun) {
    console.log(`[${reportName}] DRY RUN — would upsert ${ownerRows.length} to owners, ${propertyOwnerRows.length} to property_owners.\n`);
    summary.push({
      reportName, table: 'owners + property_owners', status: 'DRY_RUN',
      rowsMapped: ownerRows.length + propertyOwnerRows.length,
    });
    return;
  }

  try {
    await supabaseUpsert('owners', ownerRows);
    console.log(`[${reportName}] Upserted ${ownerRows.length} rows to owners.`);
  } catch (err) {
    console.error(`[${reportName}] UPSERT ERROR (owners): ${err.message}\n`);
    summary.push({ reportName, table: 'owners', status: 'UPSERT_ERROR', error: err.message });
    return;
  }

  try {
    await supabaseUpsertComposite(
      'property_owners',
      ['appfolio_property_id', 'appfolio_owner_id'],
      propertyOwnerRows,
    );
    console.log(`[${reportName}] Upserted ${propertyOwnerRows.length} rows to property_owners.\n`);
    summary.push({
      reportName, table: 'owners + property_owners', status: 'OK',
      rowsUpserted: ownerRows.length + propertyOwnerRows.length,
    });
  } catch (err) {
    console.error(`[${reportName}] UPSERT ERROR (property_owners): ${err.message}\n`);
    summary.push({ reportName, table: 'property_owners', status: 'UPSERT_ERROR', error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const isDiscover = process.argv.includes('--discover');
  const isDryRun   = process.argv.includes('--dry-run');
  const mode       = isDiscover ? 'DISCOVER' : isDryRun ? 'DRY RUN' : 'SYNC';

  if (!AF_CLIENT_ID || !AF_CLIENT_SECRET) {
    console.error('ERROR: APPFOLIO_CLIENT_ID and APPFOLIO_CLIENT_SECRET must be set in .env');
    process.exit(1);
  }
  if (!isDiscover && !isDryRun && (!SB_URL || !SB_KEY)) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
    process.exit(1);
  }

  console.log(`\n=== Rincon Management: AppFolio → Supabase [${mode}] ===`);
  console.log(`Started: ${new Date().toISOString()}`);
  if (isDiscover) console.log('DISCOVER mode — printing raw AppFolio fields, no writes.\n');
  if (isDryRun)   console.log('DRY RUN mode — no Supabase writes.\n');

  const summary = [];
  let   initialRequestCount = 0;

  for (const config of REPORT_CONFIG) {
    const { reportName, table } = config;

    if (initialRequestCount > 0 && initialRequestCount % RATE_LIMIT_BATCH === 0) {
      console.log(`[rate-limit] Pausing ${RATE_LIMIT_PAUSE / 1000}s...`);
      await sleep(RATE_LIMIT_PAUSE);
    }

    console.log(`[${reportName}] Fetching...`);
    initialRequestCount++;

    let rows;
    try {
      rows = await fetchAllPages(reportName);
    } catch (err) {
      console.error(`[${reportName}] FETCH ERROR: ${err.message}`);
      summary.push({ reportName, status: 'FETCH_ERROR', error: err.message });
      continue;
    }

    if (isDiscover) {
      const keys = rows.length > 0 ? Object.keys(rows[0]) : [];
      console.log(`[${reportName}] ${rows.length} rows — FIELDS: ${JSON.stringify(keys)}\n`);
      summary.push({ reportName, status: 'DISCOVERED', rowCount: rows.length });
      continue;
    }

    console.log(`[${reportName}] Fetched ${rows.length} rows.`);

    if (!table) {
      console.log(`[${reportName}] No Supabase table configured — skipping.\n`);
      summary.push({ reportName, status: 'SKIPPED_NO_TABLE', rowsFetched: rows.length });
      continue;
    }

    let skipped = 0;
    const mapped = [];
    for (const row of rows) {
      try {
        const built = config.buildRow(row);
        if (built && built.appfolio_id && built.appfolio_id !== 'null' && built.appfolio_id !== 'undefined') {
          mapped.push(built);
        } else {
          skipped++;
        }
      } catch (_) {
        skipped++;
      }
    }

    const skipNote = skipped > 0 ? ` (${skipped} skipped — no appfolio_id)` : '';
    console.log(`[${reportName}] Mapped ${mapped.length} rows → ${table}${skipNote}.`);

    if (isDryRun) {
      console.log(`[${reportName}] DRY RUN — would upsert ${mapped.length} rows.\n`);
      summary.push({ reportName, table, status: 'DRY_RUN', rowsMapped: mapped.length });
      continue;
    }

    try {
      await supabaseUpsert(table, mapped);
      console.log(`[${reportName}] Upserted ${mapped.length} rows to ${table}.\n`);
      summary.push({ reportName, table, status: 'OK', rowsUpserted: mapped.length });
    } catch (err) {
      console.error(`[${reportName}] UPSERT ERROR: ${err.message}\n`);
      summary.push({ reportName, table, status: 'UPSERT_ERROR', error: err.message });
    }
  }

  await syncOwnerDirectory(isDryRun, isDiscover, summary);

  console.log('\n=== Summary ===');
  for (const r of summary) {
    const parts = [`  ${r.reportName.padEnd(28)}`, r.status.padEnd(16)];
    if (r.rowsUpserted != null) parts.push(`${r.rowsUpserted} rows upserted`);
    if (r.rowsMapped   != null) parts.push(`${r.rowsMapped} rows mapped`);
    if (r.rowsFetched  != null) parts.push(`${r.rowsFetched} rows fetched`);
    if (r.rowCount     != null) parts.push(`${r.rowCount} rows`);
    if (r.error)                parts.push(`Error: ${r.error}`);
    console.log(parts.join(' | '));
  }

  const errorCount = summary.filter(r => r.status.includes('ERROR')).length;
  if (errorCount > 0) {
    console.log(`\nWARNING: ${errorCount} report(s) had errors.`);
    process.exitCode = 1;
  }

  console.log(`\nFinished: ${new Date().toISOString()}\n`);
}

main().catch((err) => {
  console.error('\nFATAL ERROR:', err.message);
  process.exit(1);
});
