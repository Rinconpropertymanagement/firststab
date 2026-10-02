/**
 * lib/subject-match.js
 * Deterministic, metadata-only participant-address match against
 * tenants.email / owners.email / vendors.email (technical spec Design
 * Decision 3) — no AI, no body-content read, ever, in this file.
 *
 * ============================================================
 * WHY THIS ONE FUNCTION IS SHARED BY BOTH THE HELD AND NON-HELD PATHS —
 * READ BEFORE CHANGING WHERE OR WHEN THIS IS CALLED
 * ============================================================
 * The spec's Neo review (see the technical spec's "Neo's Schema Review"
 * section, fix 3, and Design Decision 3) fixed a real GOVERNANCE.md Rule 9
 * conflict: the original draft ran an address-to-identity match on EVERY
 * thread, BEFORE the hold check — associating raw, unscreened correspondence
 * with a real tenant/owner/vendor row before privilege-filter.js's
 * checkThread() had a chance to pull a privileged thread out of automated
 * processing. The load-bearing safety property the fix established is
 * ordering, not "this match may only ever run for held threads": identity
 * association must never happen before the hold check has run.
 *
 * This module is called from two places in
 * lib/process-pending-messages.js, and BOTH satisfy that same ordering
 * property directly, never inferred:
 *   1. For a HELD thread (checkThread() already returned held:true) — this
 *      is Design Decision 3's own "Layer 0," run at the exact point the
 *      spec names (Ingestion Pipeline step 3), solely to populate the
 *      held placeholder's subject.
 *   2. For a NOT-held thread (checkThread() already returned held:false) —
 *      reused here as the first-pass, most-reliable half of "categorization's
 *      own resolution" (Ingestion Pipeline step 4's "extracted property/
 *      subject/vendor names, resolved against real rows"). The spec's own
 *      text allows this: it says Layer 0 specifically (i.e., the
 *      pre-categorization address match run at step 3's position) does not
 *      run for non-held threads — it does not say a non-held thread may
 *      never be matched against real identity rows at all; to the contrary,
 *      it explicitly requires categorization's own step to do exactly that.
 *      Reusing this one function for both call sites (instead of a second,
 *      hand-copied implementation in categorize-complaint.js that could
 *      drift from this one) is a plain DRY choice, not a reintroduction of
 *      the ordering bug — this function is never called until AFTER
 *      checkThread() has already run, on either branch, no exception.
 *
 * PRIORITY WHEN MULTIPLE ROLES MATCH (Q's own judgment call — not specified
 * by the product doc or the technical spec): tenant, then owner, then
 * vendor. A multi-recipient thread can in principle have participants in
 * more than one directory; the product doc frames "the subject" as
 * property/tenant/owner and treats vendor as a distinct field, so
 * tenant/owner is checked first. No real data in this codebase makes this
 * case observable today — documented here so it isn't mistaken for an
 * oversight if it ever comes up.
 */

// ILIKE without wildcards is Postgres's case-insensitive equals — but `%`
// and `_` are ILIKE wildcards themselves, and `_` is a legal character in a
// real email local-part (e.g. "john_doe@..."), so an unescaped address could
// match more than one row. Escaped here so this is a real exact match,
// case-insensitive, never a pattern.
function escapeIlike(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

function cleanAddresses(addresses) {
  return Array.from(
    new Set((addresses || []).map((a) => (typeof a === 'string' ? a.trim().toLowerCase() : '')).filter(Boolean))
  );
}

// A tenant can in principle hold more than one active lease; this takes the
// first one found rather than erroring — same "best-effort, never blocks
// the record from being created" posture as every other part of this
// matcher. Never guesses which unit/property if the tenant has no active
// lease at all (returns null, not a stale/expired one).
async function resolveActivePropertyForTenant(supabase, tenantId) {
  const { data: leases, error: leaseErr } = await supabase
    .from('leases').select('unit_id').eq('tenant_id', tenantId).eq('status', 'active').limit(1);
  if (leaseErr || !leases || !leases.length) return null;
  const { data: unit, error: unitErr } = await supabase
    .from('units').select('property_id').eq('id', leases[0].unit_id).maybeSingle();
  if (unitErr || !unit) return null;
  return unit.property_id;
}

// Real pilot bug, 2026-09-14 (significance-pass.js's second pilot run —
// "JSON object requested, multiple (or no) rows returned" on 2 of 98
// conversations; live-queried and confirmed, not guessed). None of
// tenants.email / owners.email / vendors.email carries a uniqueness
// constraint (confirmed against the real migrations — 20260626000000 for
// tenants, 20260720000002 for owners, 20260720000003 for vendors: only
// appfolio_id is unique on owners/vendors). Two owners sharing one email
// address is a real, ordinary shape here — e.g. co-owners (a married
// couple, business partners) who share a single contact inbox and so get
// separate AppFolio owner records with the same email. `.maybeSingle()`
// tolerates zero rows but throws on 2+, so any thread whose participant
// address happened to match more than one row crashed the whole
// conversation before any row (significance or complaint) was ever
// written. Fix: query as a plain array and only accept the match when it
// is genuinely UNIQUE (exactly one row) — an ambiguous match is treated
// exactly like no match at all (never guessed, never thrown on), the same
// "unique match or nothing" discipline archive-search/lib/significance-
// pass.js's own resolveUniqueMatch() already documents for its property/
// vendor citation lookups.
async function findUniqueMatch(supabase, table, addr) {
  const { data, error } = await supabase.from(table).select('id').ilike('email', escapeIlike(addr));
  if (error) throw error;
  return data && data.length === 1 ? data[0] : null;
}

// ============================================================
// MULTI-EMAIL MATCHING (tenant_owner_emails_schema, 20261002000000) — a
// tenant/owner's address may now live in the old single column
// (tenants.email / owners.email, still just the first/primary address) OR
// in the new child table (tenant_emails / owner_emails, the complete set),
// OR BOTH once a person has been re-synced. These two helpers check both
// sources for the same address and union the resulting ids into a Set,
// same "unique match or nothing, never guess" discipline findUniqueMatch()
// above already enforces — exactly one distinct id across BOTH sources is a
// match; zero or 2+ is treated as no match, never thrown on.
//
// Strictly additive, by construction: a tenant/owner not yet re-synced into
// the new child table has zero rows there, so the Set is built from the old
// column alone — identical to calling findUniqueMatch() directly. Nothing
// about today's matching behavior changes until a row actually exists in
// the new table.
//
// findUniqueMatch() itself is untouched above — it's directly unit-tested
// and still used alone for the vendor loop below (vendors are out of scope
// for this fix; vendors.email has no child-table equivalent).
// ============================================================

async function findUniqueIdAcrossOldAndNew(supabase, oldTable, newTable, newTableIdCol, addr) {
  const escaped = escapeIlike(addr);
  const [oldResult, newResult] = await Promise.all([
    supabase.from(oldTable).select('id').ilike('email', escaped),
    supabase.from(newTable).select(newTableIdCol).ilike('email', escaped),
  ]);
  if (oldResult.error) throw oldResult.error;
  if (newResult.error) throw newResult.error;

  const ids = new Set();
  for (const row of oldResult.data || []) ids.add(row.id);
  for (const row of newResult.data || []) {
    const id = row[newTableIdCol];
    if (id != null) ids.add(id);
  }

  if (ids.size !== 1) return null;
  const [onlyId] = ids;
  return { id: onlyId };
}

async function findUniqueTenantIdForAddress(supabase, addr) {
  return findUniqueIdAcrossOldAndNew(supabase, 'tenants', 'tenant_emails', 'tenant_id', addr);
}

async function findUniqueOwnerIdForAddress(supabase, addr) {
  return findUniqueIdAcrossOldAndNew(supabase, 'owners', 'owner_emails', 'owner_id', addr);
}

/**
 * @param {object} supabase
 * @param {string[]} addresses - every participant address in the thread (any case/order)
 * @returns {Promise<{ subject_type: 'tenant'|'owner'|null, subject_id: string|null, vendor_id: string|null, property_id: string|null }>}
 */
async function matchParticipantsToRecords(supabase, addresses) {
  const clean = cleanAddresses(addresses);
  const none = { subject_type: null, subject_id: null, vendor_id: null, property_id: null };
  if (!clean.length) return none;

  for (const addr of clean) {
    const tenant = await findUniqueTenantIdForAddress(supabase, addr);
    if (tenant) {
      const property_id = await resolveActivePropertyForTenant(supabase, tenant.id);
      return { subject_type: 'tenant', subject_id: tenant.id, vendor_id: null, property_id };
    }
  }

  for (const addr of clean) {
    const owner = await findUniqueOwnerIdForAddress(supabase, addr);
    // No property_id resolution for an owner match — owners.properties is
    // many-to-many (property_owners junction), so a single owner can hold
    // several properties; picking one would be a guess. Same "never a
    // guessed subject" discipline the spec already states plainly for
    // owners.email's own known gap (Design Decision 3).
    if (owner) return { subject_type: 'owner', subject_id: owner.id, vendor_id: null, property_id: null };
  }

  for (const addr of clean) {
    const vendor = await findUniqueMatch(supabase, 'vendors', addr);
    if (vendor) return { subject_type: null, subject_id: null, vendor_id: vendor.id, property_id: null };
  }

  return none;
}

module.exports = {
  matchParticipantsToRecords,
  escapeIlike,
  findUniqueMatch,
  findUniqueTenantIdForAddress,
  findUniqueOwnerIdForAddress,
};
