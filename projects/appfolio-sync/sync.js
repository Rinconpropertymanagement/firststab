'use strict';

/**
 * AppFolio → Supabase Nightly Sync
 * Rincon Management
 *
 * Fetches data from 11 AppFolio reports and upserts it into Supabase.
 * Foreign-key joins (unit_id, tenant_id, property_id) are resolved at the end
 * of every run via resolve_appfolio_foreign_keys() — see the call site below
 * for why (turned on 2026-09-01, previously written but never invoked).
 *
 * Also populates (security-deposit tool build, supabase/migrations/
 * 20260813000000 through 20260813000004): leases.move_out_date/
 * move_out_reason (tenant_tickler-owned), leases.deposit_held_total/
 * deposit_synced_at (rent_roll-owned), properties.jurisdiction_county
 * (property_directory-owned), and the lease_tenants join table
 * (tenant_directory-sourced, see syncLeaseTenants() below — fixes the
 * multi-tenant bug where leases.tenant_id could only ever hold one
 * tenant per lease).
 *
 * Usage:
 *   node sync.js              Run the full sync — fetch all reports and write to Supabase
 *   node sync.js --discover   Print the exact field names AppFolio returns, then exit (no writes)
 *   node sync.js --dry-run    Fetch and map data, print row counts, no Supabase writes
 */

const https  = require('https');
const path   = require('path');
const { google } = require('googleapis');

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
// SYNC CONFLICT RULE
//
// Supabase upserts with `Prefer: resolution=merge-duplicates` only update the
// columns present in the JSON body — columns not in the body are left untouched.
//
// Rule: buildRow() must NEVER include fields that the workflow system owns:
//   - properties.pod          (set by ops team, managed by workflow)
//   - units.property_id       (set by FK-join process, not by sync)
//   - leases.unit_id          (set by FK-join process)
//   - leases.tenant_id        (set by FK-join process)
//   - maintenance_requests.unit_id  (set by FK-join process)
//
// Omit these fields entirely — do not send them as null. Sending null overwrites.
// ─────────────────────────────────────────────────────────────────────────────

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
      const built = {
        name:        row.property_name || row.property_street || row.property_address || null,
        address:     row.property_street || null,
        city:        row.property_city   || null,
        state:       row.property_state  || 'CA',
        zip:         row.property_zip    || null,
        unit_count:  parseInt(row.units) || null,
        appfolio_id: String(row.property_id),
      };
      // jurisdiction_county — sync-owned exclusively by property_directory
      // (supabase/migrations/20260813000000_security_deposit_leases_
      // extension.sql). Omit entirely when absent — never send null, which
      // would clear a previously-synced value.
      if (row.property_county) built.jurisdiction_county = row.property_county;

      // year_built / maintenance_limit — sync-owned exclusively by
      // property_directory (supabase/migrations/20260828000000_add_
      // year_built_and_maintenance_limit_to_properties.sql), for the
      // Approval Briefing feature (approval-briefing-SPEC.md Section
      // 4.1/4.2). Confirmed live field names via --discover: "year_built"
      // and "maintenance_limit" (both present on the real property_directory
      // response, alongside maintenance_notes). Same omit-when-absent rule
      // as jurisdiction_county above — never send null for either, which
      // would clear a previously-synced value.
      if (row.year_built) built.year_built = parseInt(row.year_built, 10) || null;
      // CRITICAL (see the migration's own column comment, verbatim): AppFolio
      // returns maintenance_limit as a formatted string ("500.00" or "0.00").
      // parseFloat(x) || null — the idiom used elsewhere in this file — would
      // silently turn a genuine $0.00 limit into NULL, because 0 is falsy in
      // JS, erasing a real "zero PM authority without the owner" value and
      // making it indistinguishable from "never configured." Number.isFinite()
      // on the parsed result is required here instead. row.maintenance_limit
      // itself can be "0.00" (a real value, truthy as a non-empty string) or
      // absent/undefined (never configured) — checking the raw field first,
      // not the parsed number, is what keeps those two cases apart.
      if (row.maintenance_limit != null && row.maintenance_limit !== '') {
        const parsedLimit = parseFloat(row.maintenance_limit);
        if (Number.isFinite(parsedLimit)) built.maintenance_limit = parsedLimit;
      }
      return built;
    },
  },

  // ── 2. Units ─────────────────────────────────────────────────────────────
  {
    reportName: 'unit_directory',
    table: 'units',

    buildRow(row) {
      return {
        unit_number:  row.unit_name                    || null,
        bedrooms:     parseInt(row.bedrooms)           || null,
        bathrooms:    parseFloat(row.bathrooms)        || null,
        sqft:         parseInt(row.sqft)               || null,
        monthly_rent: parseFloat(row.market_rent)      || null,
        // Every unit in the portfolio (all ~455) comes through this report,
        // so it's the full-portfolio baseline for status. Was 'vacant' —
        // confirmed live 2026-09-01 this left EVERY unit stuck at 'vacant'
        // forever, because nothing else in this file ever wrote 'occupied':
        // unit_vacancy (below) also wrote 'vacant', to the very same value,
        // for the subset of units it returns. The two reports were meant to
        // divide the work (this one marks everyone occupied, unit_vacancy
        // flips just the actually-vacant ones), but both wrote the same
        // literal. unit_vacancy runs strictly after this report in
        // REPORT_CONFIG and only touches the units it returns (merge-
        // duplicates upsert — see the SYNC CONFLICT RULE note above), so
        // 'occupied' here is safe: it's a baseline every later, more
        // specific report is free to override.
        status:       'occupied',
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
      const built = {
        lease_start:  row.lease_from || null,
        lease_end:    row.lease_to   || null,
        monthly_rent: parseFloat(row.rent) || null,
        status,
        notes:        moveOut
          ? `Move-out: ${moveOut} — ${row.move_out_reason || 'reason not recorded'}`
          : `Move-in: ${row.move_in_date || 'date unknown'}`,
        appfolio_id:  String(row.occupancy_id),
      };
      // move_out_date / move_out_reason — sync-owned EXCLUSIVELY by this
      // report (supabase/migrations/20260813000000). No other report's
      // buildRow() may ever set these two columns — that's the entire fix
      // for the clobbering bug the migration describes. Omit entirely
      // (never send null) when this row has no move-out data, so an
      // active/move-in row never clears a previously-recorded move-out.
      if (moveOut) built.move_out_date = moveOut;
      if (row.move_out_reason) built.move_out_reason = row.move_out_reason;
      // appfolio_unit_id / appfolio_tenant_id — 20260803000000_fk_join_
      // columns.sql added these specifically so "occupancy reports" like
      // this one would populate them, feeding resolve_appfolio_foreign_
      // keys()'s leases.unit_id/tenant_id resolution. That wiring was
      // never actually done in any buildRow() until now (confirmed live,
      // 2026-08-27 — real leases exist with both columns permanently
      // null). rent_roll also sets these (shared ownership, like
      // deposit_held_total's "most complete report" precedent) since it's
      // the more complete source for currently-occupied leases — but
      // rent_roll never sees an already-departed occupancy, so this
      // report is the only path for a lease whose tenant is gone before
      // the lease row is ever touched again. Same omit-don't-null rule.
      if (row.unit_id != null) built.appfolio_unit_id = String(row.unit_id);
      if (row.tenant_id != null) built.appfolio_tenant_id = String(row.tenant_id);
      return built;
    },
  },

  // ── 6. Lease expirations ──────────────────────────────────────────────────
  {
    reportName: 'lease_expiration_detail',
    table: 'leases',

    buildRow(row) {
      return {
        lease_start:  row.move_in        || null,
        lease_end:    row.lease_expires  || null,
        monthly_rent: parseFloat(row.rent) || null,
        status:       'active',
        notes:        `Expiring: ${row.lease_expires_month || row.lease_expires || 'soon'}`,
        appfolio_id:  String(row.occupancy_id),
      };
    },
  },

  // ── 7. Vacant units (overrides status = vacant for units in this report) ──
  {
    reportName: 'unit_vacancy',
    table: 'units',

    buildRow(row) {
      return {
        unit_number:  row.unit    || null,
        sqft:         parseInt(row.sqft)           || null,
        monthly_rent: parseFloat(row.new_rent || row.schd_rent) || null,
        // Unchanged — this was already correct. AppFolio's own "currently
        // vacant units" report, so 'vacant' here is right for every row it
        // returns. Runs after unit_directory (#2 above) in REPORT_CONFIG,
        // so it overrides that report's 'occupied' baseline for just this
        // subset; units this report doesn't return are left at 'occupied'
        // untouched (merge-duplicates upsert only sets columns present in
        // the JSON body — see the SYNC CONFLICT RULE note above).
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

      const built = {
        title:        desc ? String(desc).substring(0, 100) : `Work order ${row.work_order_number || ''}`,
        description:  desc || null,
        status:       STATUS_MAP[rawStatus]   || 'open',
        priority:     PRIORITY_MAP[rawPriority] || 'medium',
        vendor_name:  row.vendor || null,
        cost:         parseFloat(row.amount) || null,
        completed_at: completedAt,
        appfolio_id:  String(row.work_order_id || row.work_order_number),
      };
      // appfolio_unit_id feeds resolve_appfolio_foreign_keys()'s
      // maintenance_requests.unit_id resolution (20260803000000/000001).
      // This was never wired up here — confirmed live 2026-09-01: the
      // work_order report does return row.unit_id (present on ~80% of
      // rows; the rest are property-level work orders with no unit),
      // but this buildRow silently dropped it, so unit_id has stayed
      // permanently NULL for every work order ever synced, portfolio-
      // wide (229 of 529 existing rows) — invisible to any property- or
      // unit-scoped view, including Property Overview's per-property
      // ticket list. Same omit-don't-null rule as tenant_tickler's
      // appfolio_unit_id above: a work order legitimately can have no
      // unit (property-level), so absence must stay absence, not become
      // a stored null that looks the same as "not yet checked."
      if (row.unit_id != null) built.appfolio_unit_id = String(row.unit_id);
      return built;
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
      const built = {
        lease_start:  row.lease_from || null,
        lease_end:    row.lease_to   || null,
        monthly_rent: parseFloat(row.rent || row.market_rent) || null,
        status,
        notes:        pastDueNote,
        appfolio_id:  String(row.occupancy_id),
      };
      // deposit_held_total / deposit_synced_at — sync-owned EXCLUSIVELY by
      // rent_roll (supabase/migrations/20260813000000). tenant_directory,
      // lease_expiration_detail, and delinquency also carry a `deposit`
      // value in their raw AppFolio response, but must NEVER write this
      // column — that would recreate the exact single-field clobber bug
      // the multi-tenant fix solves elsewhere on this same table. Set
      // together, omit both when the row has no deposit field (never send
      // null, which would clear a previously-synced value).
      if (row.deposit != null && row.deposit !== '') {
        const depositNum = parseFloat(String(row.deposit).replace(/[$,]/g, ''));
        if (!isNaN(depositNum)) {
          built.deposit_held_total = depositNum;
          built.deposit_synced_at  = new Date().toISOString();
        }
      }
      // appfolio_unit_id / appfolio_tenant_id — see tenant_tickler's entry
      // above for the full explanation. rent_roll is the primary owner for
      // any lease it can see (it's the most complete report and already
      // wins on conflict for every other shared leases field); tenant_
      // tickler is the only fallback that still catches a lease after the
      // tenant has fully departed and rent_roll no longer lists them.
      if (row.unit_id != null) built.appfolio_unit_id = String(row.unit_id);
      if (row.tenant_id != null) built.appfolio_tenant_id = String(row.tenant_id);
      return built;
    },
  },

  // ── 11. Property budgets (Maintenance Budget Cross-Check, Part 2) ──────────
  // budget-crosscheck-SPEC.md's Open Items #1/#2 flagged the exact report
  // name and field shape as unconfirmed. Confirmed LIVE against this
  // account (2026-08-17) by probing candidate report names the same way
  // --discover already works for every other entry here:
  //   - 'annual_budget_comparative' and 'budget_comparative' BOTH exist and
  //     return real numbers, but BOTH are portfolio-wide — 48 GL-account
  //     rows total, no property_id/property_name field anywhere in the
  //     response, and passing property_id/property_ids in the POST body
  //     makes no difference at all (confirmed with a bogus property_id —
  //     identical totals came back). Not usable for a per-property screen.
  //   - 'annual_budget_forecast' is the one that actually breaks out by
  //     property: property_id + property_name are present on every row,
  //     one row per property x GL account (4207 rows across the whole
  //     portfolio in one call — no need to loop per property). This is
  //     the report this entry uses.
  //   - This report also silently IGNORES year/fiscal_year/period/
  //     from_date/to_date params — it always returns the current fiscal
  //     year only, no matter what's passed. fiscal_year below is read out
  //     of the data itself (the row's own month keys), never assumed from
  //     this machine's clock. A second fiscal_year's rows will only start
  //     appearing here after a real calendar-year rollover happens and the
  //     nightly sync runs again — there is no way to backfill last year's
  //     budget from this endpoint.
  //   - NO PER-PROPERTY "ACTUAL SPEND" REPORT WAS FOUND. income_statement
  //     and income_statement_comparative exist but are portfolio-wide,
  //     same problem as the budget-comparative reports above. AppFolio's
  //     general_ledger report DOES carry property_id on individual
  //     transactions, so a real actual-spend figure could theoretically be
  //     built by summing debits/credits per property per account per year
  //     — but that's new aggregation logic (sign conventions per account
  //     type, an unclear default date window on that report), a
  //     materially bigger and riskier piece of work than a straight sync,
  //     not something to guess at here. actual_amount is correctly never
  //     set below — see the SYNC CONFLICT RULE above and the migration's
  //     own comment on why that column is nullable. Flagged to Peter as a
  //     separate decision, not built around a guess.
  //   - gl_account_name is AppFolio's real chart-of-accounts text,
  //     confirmed live — there is NO single "Repairs & Maintenance"
  //     account in this account's chart of accounts. The closest matches
  //     are "Repair", "Maintenance Labor", "Roof Repairs and Maintenance",
  //     and "Maintenance Only-OBP" (54 categories returned in total, all
  //     synced — the "sync broad, filter at display time" pattern this
  //     file already uses elsewhere; the Budget tab decides what to
  //     surface first, this table doesn't).
  {
    reportName: 'annual_budget_forecast',
    table: 'appfolio_property_budgets',
    conflictCols: ['appfolio_property_id', 'fiscal_year', 'gl_account_name'], // composite upsert key — matches the table's UNIQUE constraint
    requiredField: 'appfolio_property_id', // this table has no single appfolio_id column (see the migration's "why no FK-resolution" note)

    buildRow(row) {
      const months = Array.isArray(row.months) ? row.months : [];
      const firstMonthId = months.length && months[0] && months[0].id ? String(months[0].id) : null;
      const fiscalYear = firstMonthId ? parseInt(firstMonthId.slice(0, 4), 10) : null;
      const accountName = row.account_name ? String(row.account_name).trim() : null;
      const propertyId = row.property_id != null ? String(row.property_id) : null;

      // appfolio_property_id / fiscal_year / gl_account_name are all
      // NOT NULL on the table and together make up the upsert conflict
      // key. Supabase upserts write the whole batch as one request — one
      // row missing any of these would fail the WHOLE night's budget
      // upsert, not just that row. Drop it here instead of finding out
      // the hard way.
      if (!propertyId || !accountName || !Number.isInteger(fiscalYear)) return null;

      const budgeted = parseFloat(row.total);
      return {
        appfolio_property_id: propertyId,
        fiscal_year: fiscalYear,
        gl_account_name: accountName,
        budgeted_amount: Number.isFinite(budgeted) ? budgeted : null,
        // actual_amount deliberately omitted — see the entry comment above.
        // synced_at is set explicitly (not left to the column DEFAULT)
        // because DEFAULT NOW() only fires on INSERT — an UPSERT that
        // matches an existing row is an UPDATE, which needs this written
        // every run for the Budget tab's "as of [date]" label to be true.
        synced_at: new Date().toISOString(),
      };
    },
  },

  // ── 12. General ledger → actual spend (Maintenance Budget — Actual Spend,
  //         Part 3, actual-spend-SPEC.md) ─────────────────────────────────
  // Fills in the Budget tab's "Actual (AppFolio)" column, which has shown
  // "not available from AppFolio" since launch (see the entry-11 comment
  // above — this is the "materially bigger and riskier piece of work"
  // flagged there, now built out per Oracle's spec and Neo's migration
  // 20260817010000_appfolio_property_actuals.sql).
  //
  // Re-confirmed LIVE against this account (2026-08-18), one day after the
  // spec's own live check, while building this entry:
  //   - Response shape is actually { results: [...], next_page_url: null }
  //     — not the bare array the spec's Decision 1 described. Doesn't
  //     matter: fetchAllPages() below already handles both shapes and
  //     already follows next_page_url if AppFolio ever returns a non-null
  //     one, so no special-casing was needed here. 4,429 rows in one call
  //     today, next_page_url explicitly null. Spec Open Item #3 (does a
  //     FULL month's transactions ever paginate?) is still genuinely
  //     unconfirmed — today's sample is a partial 17/18-day month, so this
  //     only confirms the code follows pagination correctly IF AppFolio
  //     ever sends it, not that AppFolio never will once volume is higher.
  //   - row.month comes back as "Aug 2026" (human text), NOT the 'YYYY-MM'
  //     ID shape entry 11's annual_budget_forecast rows use — confirmed
  //     live, and a live correction to what the spec assumed. period below
  //     is derived from row.post_date ("2026-08-18", ISO) instead, which
  //     reliably slices to 'YYYY-MM' and satisfies the table's CHECK
  //     constraint.
  //   - account_id already arrives as a JS number, not a string.
  //   - debit and credit are never both populated on the same row —
  //     confirmed across all 4,429 live rows today (spec Finding B).
  //   - party_type vocabulary confirmed live, exact match to spec Finding
  //     E: null, "Occupancy", "Owner", "Vendor", "Management Company".
  //   - Spec Open Item #1 (does AppFolio's "current month" window reset
  //     exactly on the calendar month boundary, or something else?) is
  //     STILL UNCONFIRMED — today's pull is again a mid-month snapshot,
  //     not a boundary crossing. Flagged, not guessed past; worth Peter or
  //     Scotty checking right around a month-end.
  //
  // This report needs real aggregation across MANY raw transaction rows
  // into ONE row per property + gl_account_id + month — a fundamentally
  // different shape than every buildRow() above, which maps one raw row to
  // one upsert row. Sending one (unaggregated) row per raw transaction with
  // a shared conflict key would make Postgres's ON CONFLICT clause fail
  // ("cannot affect row a second time") on the very first duplicate within
  // a group — so this entry defines aggregate(rows) instead of buildRow(row)
  // (see the main() loop below for how that's dispatched). The raw rows
  // (which carry a tenant's real name in party_name — spec Finding D) are
  // summed here, in memory, and ONLY the six aggregate columns below are
  // ever handed to Supabase — never party_name, party_id, description, or
  // txn_id. See the migration's "WHY NOT RAW TRANSACTION LINES" block for
  // why that boundary is load-bearing, not incidental.
  {
    reportName: 'general_ledger',
    table: 'appfolio_property_actuals',
    conflictCols: ['appfolio_property_id', 'period', 'gl_account_id'], // matches the table's UNIQUE constraint
    requiredField: 'appfolio_property_id', // same reasoning as entry 11 — no single appfolio_id column here

    aggregate(rows) {
      const groups = new Map();
      for (const row of rows) {
        const propertyId = row.property_id != null ? String(row.property_id) : null;
        const accountId = Number.isInteger(row.account_id) ? row.account_id : parseInt(row.account_id, 10);
        // period comes from post_date, NOT row.month — see the entry
        // comment above (row.month is "Aug 2026" text, not 'YYYY-MM').
        const period = row.post_date ? String(row.post_date).slice(0, 7) : null;
        // Can't place this row in any group safely without all three keys
        // — drop it rather than guess where it belongs. A full year's
        // worth of GL rows will always carry property_id/account_id/
        // post_date in practice; this is a safety net, not an expected path.
        if (!propertyId || !Number.isInteger(accountId) || !period) continue;

        const key = `${propertyId}|${period}|${accountId}`;
        let g = groups.get(key);
        if (!g) {
          // "NNNN - " prefix stripped so this matches
          // appfolio_property_budgets.gl_account_name character-for-
          // character (spec Finding A / the table's own column comment) —
          // e.g. "6210 - Repair" becomes "Repair".
          const rawName = row.account_name ? String(row.account_name) : '';
          const glAccountName = rawName.replace(/^\d+\s*-\s*/, '').trim() || rawName || 'Unknown';
          g = {
            appfolio_property_id: propertyId,
            period,
            fiscal_year: parseInt(period.slice(0, 4), 10),
            gl_account_id: accountId,
            gl_account_name: glAccountName,
            net_amount: 0,
            reimbursable_amount: 0,
          };
          groups.set(key, g);
        }

        const debit = parseFloat(row.debit) || 0;
        const credit = parseFloat(row.credit) || 0;
        g.net_amount += debit - credit; // spec Finding B — every transaction, no counterparty filter

        // spec Decision 3 / Finding E: only CREDIT-side dollars from a
        // tenant counterparty count as "reimbursed." The DEBIT-side
        // Occupancy rows (money paid TO a tenant — e.g. relocation/hotel
        // costs during a repair) are ordinary spend and must stay inside
        // net_amount only, never counted here.
        if (row.party_type === 'Occupancy' && credit > 0) {
          g.reimbursable_amount += credit;
        }
      }

      const nowIso = new Date().toISOString();
      return Array.from(groups.values()).map(g => ({
        appfolio_property_id: g.appfolio_property_id,
        period: g.period,
        fiscal_year: g.fiscal_year,
        gl_account_id: g.gl_account_id,
        gl_account_name: g.gl_account_name,
        net_amount: Math.round(g.net_amount * 100) / 100,
        reimbursable_amount: Math.round(g.reimbursable_amount * 100) / 100,
        // synced_at set explicitly, same reasoning as entry 11 — DEFAULT
        // NOW() only fires on INSERT, and this row gets re-upserted every
        // night while its month is still "current" in AppFolio's window.
        synced_at: nowIso,
      }));
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

// Most AppFolio reports return { results: [{...row...}, ...], next_page_url:
// "..." }. Confirmed live while building the annual_budget_forecast entry
// above: the budget report family (annual_budget_forecast,
// annual_budget_comparative, budget_comparative, budget_comparison,
// income_statement, income_statement_comparative — every one tried) does
// NOT use that wrapper at all. They return a bare JSON array directly,
// with no next_page_url anywhere (and no pagination was observed on any
// of them — annual_budget_forecast alone returned all 4207 rows in one
// call). Handle both shapes here, once, rather than special-casing it
// inside any one REPORT_CONFIG entry's buildRow — every other entry's
// response is still an object with a .results array, so this is purely
// additive, not a behavior change for the reports already working today.
async function fetchAllPages(reportName) {
  const first    = await afPost(reportName);
  let rows       = Array.isArray(first) ? first : (Array.isArray(first.results) ? first.results : []);
  let nextUrl    = Array.isArray(first) ? null : (first.next_page_url || null);

  while (nextUrl) {
    // AppFolio isn't consistent about this across reports: some return an
    // absolute next_page_url, others (confirmed live 2026-08-28 on
    // general_ledger, only once it started paginating at full-month
    // volume — see actual-spend-SPEC.md's own flagged-but-unconfirmed
    // Open Item 3) return a host-relative path instead, e.g.
    // "/api/v2/reports/general_ledger.json?...&page=1". `new URL()` throws
    // "Invalid URL" on a bare relative path with no base — passing AF_HOST
    // as the base handles both shapes: it's used only when nextUrl isn't
    // already absolute.
    const parsed = new URL(nextUrl, `https://${AF_HOST}`);
    // Also confirmed live 2026-08-28, same investigation: this endpoint's
    // continuation link is POST-only — a GET to the exact same resolved
    // URL returns a bare 404, while a POST with the same empty '{}' body
    // as the very first request returns the next page correctly. No other
    // report in this file has ever been observed exercising this
    // pagination loop at all (general_ledger, at ~5,040 rows for a full
    // month, is the first to cross AppFolio's ~5,000-row single-page
    // limit), so there's no confirmed-working GET behavior here to
    // preserve — POST matches how every other request in this file
    // already talks to AppFolio's report endpoints.
    const pageBody = '{}';
    const page   = await httpsRequest({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  {
        'Authorization':  afAuthHeader(),
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(pageBody),
      },
    }, pageBody);
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

async function supabaseRpc(fnName) {
  const sbHost = new URL(SB_URL).hostname;
  const body   = JSON.stringify({});
  const result = await httpsRequest({
    hostname: sbHost,
    path:     `/rest/v1/rpc/${fnName}`,
    method:   'POST',
    headers:  {
      'apikey':         SB_KEY,
      'Authorization':  `Bearer ${SB_KEY}`,
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  if (result.statusCode < 200 || result.statusCode >= 300) {
    const detail = typeof result.body === 'object'
      ? JSON.stringify(result.body)
      : String(result.body).substring(0, 300);
    throw new Error(`Supabase RPC "${fnName}" returned HTTP ${result.statusCode}: ${detail}`);
  }
  return typeof result.body === 'object' ? result.body : JSON.parse(result.body);
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

// PostgREST's batch upsert requires every object in one request array to
// have the EXACT same set of JSON keys — it builds a single INSERT
// statement from the array, and a mismatched key set across rows fails
// the whole batch with PGRST102 "All object keys must match" (confirmed
// live, 2026-08-18, real-run: property_directory's 379/380-row split on
// jurisdiction_county and tenant_tickler's 4/10-row split on
// move_out_date both failed this way — rent_roll's deposit_held_total
// happened to succeed only because it had 100% row coverage that day,
// not because the underlying approach was safe).
//
// The "sync-owned field" convention (top of this file, and every
// buildRow() that sets move_out_date/move_out_reason/deposit_held_total/
// deposit_synced_at/jurisdiction_county) requires OMITTING an optional
// field entirely when a row has no data for it — sending null would
// clear a previously-synced real value. That's fundamentally at odds
// with PostgREST's uniform-keys requirement whenever a batch mixes rows
// that do and don't have the optional field. This groups rows by their
// exact key signature and lets the caller send one upsert per group —
// each group is internally uniform, so both rules hold at once. For any
// report where every row already has identical keys (every report in
// this file except the ones above), this returns exactly one group
// containing all rows — functionally identical to not grouping at all.
function groupByKeySignature(rows) {
  const groups = new Map();
  for (const row of rows) {
    const signature = Object.keys(row).sort().join('|');
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(row);
  }
  return Array.from(groups.values());
}

// Upserts one key-signature group. Tries the whole group in a single
// request first — the normal, fast path, unchanged for every report that
// never hits this. If THAT fails for any reason (found live, 2026-08-27:
// two real security-deposit move-outs — and, it turned out, five more —
// went silently missing for weeks because one bad/duplicate row in a
// shared batch request took the whole request down with it, including
// every OTHER row's real, correct data), falls back to one request per
// row in the group, so a single bad row can never cost every other row
// its update. Returns which rows actually saved and which didn't, with
// the real per-row error, instead of an all-or-nothing exception that
// hides which specific row was the problem.
async function upsertGroupWithRowFallback(table, group, conflictCols) {
  const doUpsert = conflictCols
    ? (rows) => supabaseUpsertComposite(table, conflictCols, rows)
    : (rows) => supabaseUpsert(table, rows);

  try {
    await doUpsert(group);
    return { succeeded: group.length, failed: [] };
  } catch (groupErr) {
    const failed = [];
    let succeeded = 0;
    for (const row of group) {
      try {
        await doUpsert([row]);
        succeeded++;
      } catch (rowErr) {
        failed.push({ row, error: rowErr.message });
      }
    }
    return { succeeded, failed, groupError: groupErr.message };
  }
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

  // Same per-row isolation as the main REPORT_CONFIG loop above — one bad
  // owner or property-link row can no longer take its batch-mates down
  // with it (see upsertGroupWithRowFallback()'s comment for the full
  // "one bad row killed the whole batch" history).
  const failures = [];

  let ownersUpserted = 0;
  try {
    const result = await upsertGroupWithRowFallback('owners', ownerRows, null);
    ownersUpserted = result.succeeded;
    if (result.failed.length) {
      failures.push(...result.failed.map(f => ({ idField: 'appfolio_id', idValue: f.row.appfolio_id, error: f.error })));
    }
    console.log(`[${reportName}] Upserted ${ownersUpserted} rows to owners${result.failed.length ? ` (${result.failed.length} FAILED)` : ''}.`);
  } catch (err) {
    console.error(`[${reportName}] UPSERT ERROR (owners): ${err.message}\n`);
    summary.push({ reportName, table: 'owners', status: 'UPSERT_ERROR', error: err.message });
    return;
  }

  let propertyOwnersUpserted = 0;
  try {
    const result = await upsertGroupWithRowFallback(
      'property_owners',
      propertyOwnerRows,
      ['appfolio_property_id', 'appfolio_owner_id'],
    );
    propertyOwnersUpserted = result.succeeded;
    if (result.failed.length) {
      failures.push(...result.failed.map(f => ({ idField: 'appfolio_property_id', idValue: f.row.appfolio_property_id, error: f.error })));
    }
    console.log(`[${reportName}] Upserted ${propertyOwnersUpserted} rows to property_owners${result.failed.length ? ` (${result.failed.length} FAILED)` : ''}.\n`);
  } catch (err) {
    console.error(`[${reportName}] UPSERT ERROR (property_owners): ${err.message}\n`);
    summary.push({ reportName, table: 'property_owners', status: 'UPSERT_ERROR', error: err.message });
    return;
  }

  const rowsUpserted = ownersUpserted + propertyOwnersUpserted;
  if (failures.length === 0) {
    summary.push({ reportName, table: 'owners + property_owners', status: 'OK', rowsUpserted });
  } else {
    console.error(`[${reportName}] PARTIAL FAILURE: ${rowsUpserted} row(s) upserted, ${failures.length} row(s) FAILED and were NOT saved:`);
    failures.forEach(f => console.error(`[${reportName}]   ${f.idField} ${f.idValue}: ${f.error}`));
    console.error('');
    summary.push({ reportName, table: 'owners + property_owners', status: 'PARTIAL_ERROR', rowsUpserted, failures });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LEASE TENANTS — tenant_directory also populates this table
// (supabase/migrations/20260813000001_lease_tenants.sql — fixes the
// multi-tenant bug: leases.tenant_id can only ever hold one tenant per
// lease, silently dropping every co-tenant).
//
// tenant_directory ALREADY runs through REPORT_CONFIG above for the
// `tenants` table (entry 3) — that entry's buildRow() is left completely
// untouched here. This is a second, independent fetch of the same
// report, mirroring syncOwnerDirectory()'s proven "one report writes to
// two tables" pattern above (owner_directory → owners + property_owners)
// rather than restructuring tenant_directory's existing REPORT_CONFIG
// entry. The extra fetch costs exactly one additional "initial request"
// against AppFolio's rate limit — pagination requests are exempt (see
// the rate-limit note at the top of this file) — not a multiplied cost,
// and tenant_directory's `tenants`-populating behavior stays byte-for-
// byte unchanged.
//
// Field mapping, per Neo's live discovery (20260813000001's comments):
//   - occupancy_id      → appfolio_occupancy_id (raw field, confirmed present)
//   - selected_tenant_id (or occupancy_import_uid as fallback) → appfolio_tenant_id
//     — this MUST match tenant_directory's own REPORT_CONFIG entry's
//     `const afId = row.selected_tenant_id || row.occupancy_import_uid`
//     exactly, or resolve_lease_tenant_foreign_keys()'s join against
//     tenants.appfolio_id below would silently fail to resolve.
//   - primary_tenant ("Yes"/"No" text) → is_primary boolean
//
// ── DEPARTED-TENANT GAP (found live, 2026-08-19) ────────────────────────
// tenant_directory only ever lists CURRENT occupants — confirmed live: 3
// of 4 real move-out cases in the system today (occupancy 366, 1079, 988)
// return ZERO tenant_directory rows, meaning a disposition packet for an
// already-departed lease got no tenant name at all, not even the primary
// one. Checked every other candidate report live against these exact
// occupancies before picking a fix (live discovery pass, 2026-08-19):
//   - lease_expiration_detail: 0 rows for all 5 test occupancies (366,
//     1079, 988, 568, 1162) — not scoped to departed leases at all.
//   - delinquency: 0 rows for 366/1079/988/568, 1 row for 1162 (only
//     because that lease happens to carry a balance) — no reliable
//     departed-tenant signal.
//   - tenant_tickler DOES carry every one of the 3 real gaps — one row
//     each, with a real tenant_id, tenant name, email, and phone,
//     confirmed live. It's the report AppFolio uses for move-in/move-out/
//     notice EVENTS, so it naturally retains identity right at the moment
//     tenant_directory drops it. Only ONE tenant per row though — no
//     rent_roll-style additional_tenant_ids field exists on it (confirmed
//     against its full field list live) — so a co-tenant on an
//     already-departed multi-tenant lease is still lost. Accepted for v1:
//     the single tenant tenant_tickler names is always the one whose
//     move-out actually triggered the event, which cross-checked exactly
//     against legacy leases.tenant_id for all 3 real cases.
//   - tenant_tickler is a small, rolling report (10 rows total the day
//     this was checked, not "full history" like tenant_directory's 1149+)
//     — it covers TODAY's real gap completely, but there's no guarantee
//     an occupancy that moved out long before this fix shipped, and has
//     since aged out of tenant_tickler's window, would still be caught.
//     Only used as a supplement for occupancies tenant_directory has zero
//     rows for — never overrides a tenant_directory row, so it can't
//     demote a real co-tenant to "the only tenant."
async function syncLeaseTenants(isDryRun, isDiscover, summary) {
  const label = 'tenant_directory + tenant_tickler (lease_tenants)';

  if (isDiscover) {
    // Already discovered by these reports' own REPORT_CONFIG entries above
    // — nothing new to fetch or print for this second pass.
    return;
  }

  console.log(`[${label}] Fetching tenant_directory...`);
  let tdRows;
  try {
    tdRows = await fetchAllPages('tenant_directory');
  } catch (err) {
    console.error(`[${label}] FETCH ERROR (tenant_directory): ${err.message}`);
    summary.push({ reportName: label, status: 'FETCH_ERROR', error: err.message });
    return;
  }
  console.log(`[${label}] Fetched ${tdRows.length} tenant_directory rows.`);

  const leaseTenantRows = [];
  const coveredOccupancies = new Set();
  let skipped = 0;
  let rowErrors = 0;
  for (const row of tdRows) {
    // Per-row isolation — same pattern as the main REPORT_CONFIG loop's
    // buildRow() try/catch (above, in the loop over REPORT_CONFIG). Before
    // this fix, one malformed tenant_directory row threw straight out of
    // syncLeaseTenants(), which main() calls with no try/catch of its own
    // — and main()'s top-level `.catch()` treats ANY uncaught error as
    // FATAL, emails a failure alert, and exits 1, aborting the entire
    // nightly sync (every other report, the lease-tenant FK resolution,
    // everything) over one bad row, not just this step.
    try {
      const occupancyId = row.occupancy_id != null ? String(row.occupancy_id) : null;
      const afTenantId  = row.selected_tenant_id || row.occupancy_import_uid;
      if (!occupancyId || !afTenantId) { skipped++; continue; }

      leaseTenantRows.push({
        appfolio_occupancy_id: occupancyId,
        appfolio_tenant_id:    String(afTenantId),
        is_primary:            String(row.primary_tenant || '').trim().toLowerCase() === 'yes',
      });
      coveredOccupancies.add(occupancyId);
    } catch (err) {
      rowErrors++;
    }
  }
  const skipNote = skipped > 0 ? ` (${skipped} skipped — missing occupancy_id or tenant id)` : '';
  const errorNote = rowErrors > 0 ? ` (${rowErrors} row error(s) skipped)` : '';
  console.log(`[${label}] Mapped ${leaseTenantRows.length} rows from tenant_directory${skipNote}${errorNote}.`);

  // Departed-tenant fallback — see the DEPARTED-TENANT GAP comment above.
  // Only fills occupancies tenant_directory returned nothing for; never
  // touches one it already covered.
  console.log(`[${label}] Fetching tenant_tickler (departed-tenant fallback)...`);
  let ttRows;
  try {
    ttRows = await fetchAllPages('tenant_tickler');
  } catch (err) {
    console.error(`[${label}] FETCH ERROR (tenant_tickler): ${err.message} — continuing with tenant_directory rows only.`);
    ttRows = [];
  }
  let fallbackAdded = 0;
  let fallbackRowErrors = 0;
  const fallbackSeenOccupancies = new Set(); // dedupe within tenant_tickler itself before it ever reaches the upsert
  for (const row of ttRows) {
    // Same per-row isolation as the tenant_directory loop above.
    try {
      const occupancyId = row.occupancy_id != null ? String(row.occupancy_id) : null;
      const afTenantId  = row.tenant_id != null ? String(row.tenant_id) : null;
      if (!occupancyId || !afTenantId) continue;
      if (coveredOccupancies.has(occupancyId)) continue; // tenant_directory already has this one — never override it
      if (fallbackSeenOccupancies.has(occupancyId)) continue; // one row per occupancy from this fallback

      leaseTenantRows.push({
        appfolio_occupancy_id: occupancyId,
        appfolio_tenant_id:    afTenantId,
        is_primary:            true, // the only tenant this fallback knows about
      });
      fallbackSeenOccupancies.add(occupancyId);
      fallbackAdded++;
    } catch (err) {
      fallbackRowErrors++;
    }
  }
  const fallbackErrorNote = fallbackRowErrors > 0 ? ` (${fallbackRowErrors} row error(s) skipped)` : '';
  console.log(`[${label}] Recovered ${fallbackAdded} additional occupancy(ies) from tenant_tickler that tenant_directory had zero rows for${fallbackErrorNote}.`);

  if (isDryRun) {
    console.log(`[${label}] DRY RUN — would upsert ${leaseTenantRows.length} rows total.`);
    // Explicit spot-check against known live examples: 568/1162 (active
    // multi-tenant, from tenant_directory) and 366/1079/988 (departed,
    // recovered via the tenant_tickler fallback above).
    for (const testOcc of ['568', '1162', '366', '1079', '988']) {
      const group = leaseTenantRows.filter(r => r.appfolio_occupancy_id === testOcc);
      console.log(`[${label}] DRY RUN — occupancy ${testOcc}: ${group.length} tenant(s)${group.length ? ' → ' + group.map(g => g.appfolio_tenant_id + (g.is_primary ? ' (primary)' : '')).join(', ') : ' — NOT FOUND'}.`);
    }
    console.log('');
    summary.push({ reportName: label, table: 'lease_tenants', status: 'DRY_RUN', rowsMapped: leaseTenantRows.length, fallbackAdded });
    return;
  }

  try {
    // Same per-row isolation as the main REPORT_CONFIG loop above — one bad
    // lease-tenant link row can no longer take its batch-mates down with it.
    const result = await upsertGroupWithRowFallback(
      'lease_tenants',
      leaseTenantRows,
      ['appfolio_occupancy_id', 'appfolio_tenant_id'],
    );
    if (result.failed.length === 0) {
      console.log(`[${label}] Upserted ${result.succeeded} rows to lease_tenants (${fallbackAdded} via tenant_tickler fallback).\n`);
      summary.push({ reportName: label, table: 'lease_tenants', status: 'OK', rowsUpserted: result.succeeded, fallbackAdded });
    } else {
      const failures = result.failed.map(f => ({ idField: 'appfolio_occupancy_id', idValue: f.row.appfolio_occupancy_id, error: f.error }));
      console.error(`[${label}] PARTIAL FAILURE: ${result.succeeded} row(s) upserted to lease_tenants, ${failures.length} row(s) FAILED and were NOT saved:`);
      failures.forEach(f => console.error(`[${label}]   ${f.idField} ${f.idValue}: ${f.error}`));
      console.error('');
      summary.push({ reportName: label, table: 'lease_tenants', status: 'PARTIAL_ERROR', rowsUpserted: result.succeeded, fallbackAdded, failures });
    }
  } catch (err) {
    console.error(`[${label}] UPSERT ERROR: ${err.message}\n`);
    summary.push({ reportName: label, table: 'lease_tenants', status: 'UPSERT_ERROR', error: err.message });
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

    // Most entries key off appfolio_id (a single-column upsert conflict
    // key). appfolio_property_budgets has no such column (see its own
    // entry's comment above) — its rows key off a composite of three
    // columns instead, so a REPORT_CONFIG entry can override which field
    // this presence check looks for via requiredField.
    const idField = config.requiredField || 'appfolio_id';

    // general_ledger (and anything else that needs to sum many raw rows
    // into one upsert row per group — see its entry's comment above)
    // defines aggregate(rows) instead of buildRow(row). Everything else
    // keeps the original one-row-in/one-row-out path unchanged.
    let skipped = 0;
    let mapped;
    if (typeof config.aggregate === 'function') {
      mapped = config.aggregate(rows).filter(
        r => r && r[idField] && r[idField] !== 'null' && r[idField] !== 'undefined'
      );
    } else {
      mapped = [];
      for (const row of rows) {
        try {
          const built = config.buildRow(row);
          if (built && built[idField] && built[idField] !== 'null' && built[idField] !== 'undefined') {
            mapped.push(built);
          } else {
            skipped++;
          }
        } catch (_) {
          skipped++;
        }
      }
    }

    const skipNote = skipped > 0 ? ` (${skipped} skipped — no ${idField})` : '';
    const aggregateNote = typeof config.aggregate === 'function' ? ` (aggregated from ${rows.length} raw rows)` : '';
    console.log(`[${reportName}] Mapped ${mapped.length} rows → ${table}${skipNote}${aggregateNote}.`);

    if (isDryRun) {
      console.log(`[${reportName}] DRY RUN — would upsert ${mapped.length} rows.`);
      // Targeted, additive-only diagnostics for the three fields this
      // build added — dry-run mode only, doesn't touch real-run behavior
      // or any other report's logging.
      if (reportName === 'tenant_tickler') {
        const withMoveOut = mapped.filter(r => r.move_out_date);
        console.log(`[${reportName}] DRY RUN — ${withMoveOut.length} of ${mapped.length} rows include a real move_out_date.`);
        withMoveOut.slice(0, 3).forEach(r => console.log(`[${reportName}]   sample: occupancy ${r.appfolio_id} move_out_date=${r.move_out_date} move_out_reason=${r.move_out_reason || '(none)'}`));
      }
      if (reportName === 'rent_roll') {
        const withDeposit = mapped.filter(r => r.deposit_held_total != null);
        console.log(`[${reportName}] DRY RUN — ${withDeposit.length} of ${mapped.length} rows include a real deposit_held_total.`);
        withDeposit.slice(0, 3).forEach(r => console.log(`[${reportName}]   sample: occupancy ${r.appfolio_id} deposit_held_total=${r.deposit_held_total} deposit_synced_at=${r.deposit_synced_at}`));
      }
      if (reportName === 'property_directory') {
        const withCounty = mapped.filter(r => r.jurisdiction_county);
        console.log(`[${reportName}] DRY RUN — ${withCounty.length} of ${mapped.length} rows include jurisdiction_county.`);
        // Approval Briefing (approval-briefing-SPEC.md Section 4.1/4.2):
        // confirm year_built/maintenance_limit mapped correctly, and
        // specifically that a genuine $0.00 maintenance_limit survived as
        // 0, not null (the gotcha the schema migration's own column
        // comment warns about — see this entry's buildRow() above).
        const withYearBuilt = mapped.filter(r => r.year_built != null);
        const withLimit = mapped.filter(r => r.maintenance_limit != null);
        const zeroLimit = mapped.filter(r => r.maintenance_limit === 0);
        console.log(`[${reportName}] DRY RUN — ${withYearBuilt.length} of ${mapped.length} rows include year_built.`);
        console.log(`[${reportName}] DRY RUN — ${withLimit.length} of ${mapped.length} rows include maintenance_limit (${zeroLimit.length} of those are a genuine $0.00, preserved as 0, not null).`);
      }
      console.log('');
      summary.push({ reportName, table, status: 'DRY_RUN', rowsMapped: mapped.length });
      continue;
    }

    try {
      // conflictCols (present only on appfolio_property_budgets today)
      // routes through the same composite-key upsert helper owner_directory
      // already uses for property_owners — everything else keeps using the
      // plain single-column appfolio_id upsert as before.
      //
      // Grouped by key signature first (see groupByKeySignature() above) —
      // required whenever an optional, sync-owned field is present on some
      // rows and omitted on others within the same report's batch. A
      // report where every row already has identical keys produces
      // exactly one group here, so this is a no-op for every report that
      // isn't affected.
      //
      // Each group goes through upsertGroupWithRowFallback() (above) —
      // NOT a plain upsert — so one bad row within a group can no longer
      // take every other row in that group down with it silently.
      const keyGroups = groupByKeySignature(mapped);
      let rowsUpserted = 0;
      const failures = [];
      for (const group of keyGroups) {
        const result = await upsertGroupWithRowFallback(table, group, config.conflictCols);
        rowsUpserted += result.succeeded;
        if (result.failed.length) {
          // idField travels with the value so the label is always the real
          // id column for this table (appfolio_property_id for composite-
          // key tables, appfolio_id otherwise) — never a hardcoded guess.
          failures.push(...result.failed.map(f => ({ idField, idValue: f.row[idField], error: f.error })));
        }
      }
      const batchNote = keyGroups.length > 1 ? ` (${keyGroups.length} batches — mixed optional fields)` : '';
      if (failures.length === 0) {
        console.log(`[${reportName}] Upserted ${rowsUpserted} rows to ${table}${batchNote}.\n`);
        summary.push({ reportName, table, status: 'OK', rowsUpserted });
      } else {
        console.error(`[${reportName}] PARTIAL FAILURE: ${rowsUpserted} row(s) upserted to ${table}${batchNote}, ${failures.length} row(s) FAILED and were NOT saved:`);
        failures.forEach(f => console.error(`[${reportName}]   ${f.idField} ${f.idValue}: ${f.error}`));
        console.error('');
        summary.push({ reportName, table, status: 'PARTIAL_ERROR', rowsUpserted, failures });
      }
    } catch (err) {
      // Only reachable for a failure outside the per-row fallback itself
      // (e.g. a bug in this loop, or groupByKeySignature throwing) — still
      // caught per-report so one report's failure can never abort the
      // rest of the night's sync.
      console.error(`[${reportName}] UPSERT ERROR: ${err.message}\n`);
      summary.push({ reportName, table, status: 'UPSERT_ERROR', error: err.message });
    }
  }

  await syncOwnerDirectory(isDryRun, isDiscover, summary);
  await syncLeaseTenants(isDryRun, isDiscover, summary);

  // ── Portfolio-wide FK resolution — run after all tables are populated ───
  // resolve_appfolio_foreign_keys() (20260803000001_resolve_fk_function.sql)
  // matches units.property_id, leases.unit_id/tenant_id, and
  // maintenance_requests.unit_id from the raw appfolio_*_id columns each
  // report writes. Existed in the database but was never called from this
  // regular sync — approved by Peter 2026-09-01 to turn on, after tracing
  // 229 of 529 maintenance_requests rows (43%) sitting permanently
  // unlinked to any unit/property because nothing ever ran this for them.
  // Purely corrective (UPDATE ... WHERE ... IS DISTINCT FROM — matches
  // existing appfolio_*_id values to real rows, changes nothing else,
  // never deletes), so safe to run every sync alongside the lease_tenants
  // resolution below, which already worked the same way.
  if (!isDryRun && !isDiscover) {
    try {
      const fkResult = await supabaseRpc('resolve_appfolio_foreign_keys');
      console.log(`[appfolio-fk-resolution] units→properties: ${fkResult.units_linked}, leases→units: ${fkResult.leases_units}, leases→tenants: ${fkResult.leases_tenants}, maintenance_requests→units: ${fkResult.mr_units}\n`);
      summary.push({ reportName: 'appfolio-fk-resolution', status: 'OK', ...fkResult });
    } catch (err) {
      console.error(`[appfolio-fk-resolution] ERROR: ${err.message}\n`);
      summary.push({ reportName: 'appfolio-fk-resolution', status: 'ERROR', error: err.message });
    }
  }

  // ── lease_tenants FK resolution ──────────────────────────────────────
  // lease_tenants.lease_id / .tenant_id — its own function
  // (supabase/migrations/20260813000001_lease_tenants.sql), part of the
  // security-deposit build's multi-tenant fix.
  if (!isDryRun && !isDiscover) {
    try {
      const ltFkResult = await supabaseRpc('resolve_lease_tenant_foreign_keys');
      console.log(`[lease-tenant-fk-resolution] lease_tenants→leases: ${ltFkResult.lease_tenants_leases}, lease_tenants→tenants: ${ltFkResult.lease_tenants_tenants}\n`);
      summary.push({ reportName: 'lease-tenant-fk-resolution', status: 'OK', ...ltFkResult });
    } catch (err) {
      console.error(`[lease-tenant-fk-resolution] ERROR: ${err.message}\n`);
      summary.push({ reportName: 'lease-tenant-fk-resolution', status: 'ERROR', error: err.message });
    }
  }

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
    // Found live, 2026-08-27: this used to be the ONLY signal a per-report
    // failure produced — a console line and an exit code, neither of
    // which anyone was watching. Real move-out dates went missing for up
    // to seven weeks with no alert anywhere. main()'s top-level .catch()
    // below already emails on a FATAL error; this is the same alert for
    // the non-fatal case, where the run finishes but didn't actually save
    // everything it should have.
    await sendSyncWarningAlert(summary);
  }

  console.log(`\nFinished: ${new Date().toISOString()}\n`);
}

async function sendAlertEmail(subject, body) {
  const recipients = ['peter@rinconmanagement.com', 'stephen@rinconmanagement.com'].filter(Boolean);
  try {
    // GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN — same
    // three env var names (and the same OAuth2 + gmail.users.messages.send
    // pattern below) as projects/calendar-assistant/send-morning-email.js,
    // which already sends real Gmail mail in production (cron on Sally,
    // see deploy-to-sally.sh). Reusing those exact names so the working
    // values can be copied in verbatim — no separate credential set to
    // set up. These get loaded from the repo ROOT .env (see this file's
    // `require('dotenv').config(...)` call near the top, path
    // '../../.env'), not from a .env inside this project folder.
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    for (const to of recipients) {
      const message = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\n');
      const encoded = Buffer.from(message).toString('base64url');
      await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
      console.error(`[alert] Alert sent to ${to}`);
    }
  } catch (alertErr) {
    console.error(`[alert] Could not send alert email: ${alertErr.message}`);
  }
}

async function sendSyncFailureAlert(err) {
  const timestamp = new Date().toISOString();
  await sendAlertEmail(
    `[ALERT] AppFolio sync failed — ${timestamp}`,
    `The AppFolio → Supabase nightly sync failed at ${timestamp}.\n\nError: ${err.message}\n\n${err.stack || ''}`
  );
}

// The non-fatal counterpart to sendSyncFailureAlert() — the run completed,
// but one or more reports didn't fully save. Lists every failing report
// and, for a PARTIAL_ERROR (see upsertGroupWithRowFallback() above), the
// exact row(s) that failed and why, so this is actionable from the email
// alone rather than requiring someone to go find and re-run the sync log.
async function sendSyncWarningAlert(summary) {
  const timestamp = new Date().toISOString();
  const failingReports = summary.filter(r => r.status.includes('ERROR'));
  const lines = failingReports.map(r => {
    if (r.status === 'PARTIAL_ERROR') {
      const rowLines = (r.failures || [])
        .map(f => `    - ${f.idField} ${f.idValue}: ${f.error}`)
        .join('\n');
      return `- ${r.reportName} (${r.table}): ${r.rowsUpserted} row(s) saved, ${r.failures.length} row(s) FAILED and were NOT saved:\n${rowLines}`;
    }
    return `- ${r.reportName}${r.table ? ` (${r.table})` : ''}: ${r.error}`;
  });
  await sendAlertEmail(
    `[WARNING] AppFolio sync had ${failingReports.length} failing report(s) — ${timestamp}`,
    `The AppFolio → Supabase nightly sync finished, but ${failingReports.length} report(s) did not fully save. Some real AppFolio data may now be missing or stale in Supabase until this is investigated:\n\n${lines.join('\n\n')}\n\nRun "node sync.js" manually for full logs.`
  );
}

main().catch(async (err) => {
  console.error('\nFATAL ERROR:', err.message);
  await sendSyncFailureAlert(err);
  process.exit(1);
});
