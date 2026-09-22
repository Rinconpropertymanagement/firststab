# Work Order Note Alerts — Rule 4 Data Inventory

**Status:** Written by Neo, 2026-09-21, alongside `supabase/migrations/20260921000000_work_order_note_alerts_schema.sql`. This is the GOVERNANCE.md Rule 4 addendum Asimov's review of `projects/hub/work-order-notes-alert-SPEC.md` asked for (relayed via Jarvis): *"a light-touch data-inventory addendum, same discipline as `maintenance_claims` — even if the conclusion is low sensitivity."* That is exactly this document's conclusion — see below.

**This document does not clear anything.** Whether it satisfies Asimov's condition, and whether Mason has separate input, is their determination to make, not Neo's and not self-certified here. No migration has been applied against real data as a result of this document — Peter applies every migration himself via Supabase's SQL Editor.

**One thing flagged plainly, same as in the migration's own header:** at the time of writing, no standalone written Asimov review document exists under `compliance/` for this specific feature, unlike every comparably-gated feature in this codebase's history (`appfolio-maintenance-notes-governance-review.md`, `leadsimple-spec-governance-precheck.md`, `archive-search-significance-complaint-merge-asimov-review.md`, and others). This document proceeds on Jarvis's relayed account of Asimov's conditions, which line up closely with what Oracle's own spec already proposed and flagged for Asimov to confirm. Recorded here so the gap is visible to whoever reads this document on its own, not just inside the migration file.

---

## Scope

One table, created fresh by the migration named above: **`work_order_note_alerts`**, one row per Latchel work order that has triggered (or attempted to trigger) an alert email to a property's pod team about a special-handling note on file. See `work-order-notes-alert-SPEC.md` Section 1 for the feature this supports and Section 4 for the table's own spec.

This is a much smaller inventory than this codebase's other Rule 4 addenda (`leadsimple-tasks-workflows-data-inventory.md`, `archive-search-significance-complaint-merge-data-inventory.md`) because the table itself is smaller in both shape and risk: one table, no tenant/applicant narrative text, no FK to `tenants`/`owners`/`contacts` at all — it is scoped to a property and a Latchel job, not to a person.

---

## Why this table's conclusion is genuinely low sensitivity, not just asserted to be

- **The free text it stores is a snapshot, not a new store of narrative.** `notes_snapshot` is a copy of `properties.maintenance_notes` exactly as it appeared in a sent email (or the fixed held-content placeholder, if the content check caught something). It does not introduce a new kind of content into this schema — `properties.maintenance_notes` already exists, is already displayed today on Property 360, and was already scanned once (2026-09-06, zero Layer-1 keyword hits across all 194 populated values, plus Peter's own manual review — `supabase/migrations/20260906000000_add_maintenance_notes_to_properties.sql`). What changes with this feature is the *use* of that field (unprompted outbound email vs. login-gated display), not its sensitivity as data — that use-change is exactly what spec Section 7 flags for Asimov, and this document doesn't re-litigate it.
- **No tenant, applicant, or owner identifier.** The table's only subject-linking column is `property_id`. There is no `tenant_id`, `owner_id`, or `contact_id` anywhere on it, unlike `maintenance_claims` (linked to a ticket, which links to a tenant) or `operational_notes` (owner/tenant narrative by design).
- **The realistic worst case is a vendor's name or phone number**, not a tenant's. `maintenance_notes` values seen live include things like "Call Zack for approval on any work order" or a vendor's personal cell number — property-operational routing information, not commentary about a resident. This is the same caveat `properties.maintenance_notes`' own migration and `appfolio-maintenance-notes-governance-review.md` already recorded for the source column; this table simply inherits it as a snapshot.
- **No AI-authored characterization of a person.** Unlike `missive_conversation_significance.owner_instruction_note_text` or `complaints.description`, nothing in this table is AI-generated commentary about anyone's conduct. `notes_snapshot` is either a verbatim copy of an already-reviewed operational field, or a fixed, identical-every-time placeholder string. `flagged_category` is a short category label, not a narrative.

---

## Data Inventory (GOVERNANCE.md Rule 4 format)

- **`pii_fields`:**
  - `notes_snapshot` — property-level operational text (vendor contacts, owner approval routing). Can incidentally carry a vendor's name or personal cell number; does not carry tenant narrative. See "Why this table's conclusion is low sensitivity" above.
  - `flagged_category` — could indirectly indicate what kind of sensitive topic a note triggered on, without containing the topic text itself (same caveat this schema uses for every `flagged_category` column — `maintenance_claims`, `operational_notes`, `missive_conversation_significance`).
  - `send_error` — free text from a mail-send failure; in practice an SMTP/API error string, not personal data, but not schema-constrained to exclude it either. Worth a glance if this table is ever exported wholesale.
  - No SSNs, no bank/financial account numbers, no government IDs, no protected-class data by design (GOVERNANCE.md Rule 9) — nothing in this table's column list is a place protected-class data would land, and `flagged_protected_class`/`flagged_category` exist specifically to catch and exclude it from `notes_snapshot` before send, not to store it.
- **`agents_with_access`:**
  - The webhook route (`POST /api/approval-briefing/internal/webhook`, new branch) and the reconcile-poll route (`POST /api/approval-briefing/internal/reconcile-work-order-notes`) — both system/service-role, no human in the loop at write time.
  - Layer 1's `scanText()` (`maintenance-history/lib/protected-class-terms.js`) — deterministic keyword match, no AI, no network call, read-only against the note text before a row is written.
  - A Layer 2 AI classifier (Claude), only if Asimov/Mason adopt it per spec Section 7 — not decided in this document.
  - Hub users, wherever spec Section 8's proposed Property 360 "Work order alerts" card surfaces this table's rows. Exact role/tier gating is Q/Tron's call at build time, not set by this migration or this document.
- **`privacy_category`:** Property-level operational record. Lower sensitivity than `maintenance_claims` (which routinely carries health-adjacent tenant narrative) or `operational_notes` (owner/tenant narrative by design) — this table carries neither. Not zero, per the vendor-contact caveat above, which is why this is a light-touch addendum and not a "no PII, skip Rule 4" conclusion.
- **`retention_policy`:** **7 years.** Set directly by Peter, 2026-09-21 — "7 years, same as everything else," matching Rincon's standing retention policy already applied to comparable tables (e.g. LeadSimple's Application Screening/Delinquency tables). Asimov had declined to set this figure unilaterally and flagged that the 7-year LeadSimple analog might not even fit a table with no tenant/applicant/owner identifier — Peter was told that distinction directly and chose to apply the same standing figure anyway, as a deliberate business decision, not a default.
- **`ccpa_exportable`:** TRUE (expected — no data type here is categorically excluded from export; confirm at build time, same as every other table in this schema notes for itself).
- **`ccpa_deletable`:** TRUE in principle, via the same targeted `notes_snapshot` → `"[REDACTED]"` convention this schema already uses (`audit_log.details`, `maintenance_claims.claim_text`), preserving `latchel_job_id`/`send_status`/`trigger_source`/timestamps for audit continuity. **Finding which rows to redact for a given person is a manual v1 step** — this table has no `tenant_id`/`owner_id`/`contact_id` column to query by; a name or phone number is only reachable by reading `notes_snapshot`'s free text. This is the same accepted limitation `properties.maintenance_notes` and `maintenance_claims.claim_text` already carry, not a new gap this table introduces.
- **RLS:** Enabled, zero permissive policies at creation — matches every table in this schema. All access denied until a tool explicitly grants it via a policy scoped to authenticated users.

---

## Rule 9 — Protected-Class Data

`flagged_protected_class`/`flagged_category` exist specifically so this table structurally records when Layer 1 (and, if adopted, Layer 2) catch protected-class-adjacent content in a note before it goes out — the exclusion itself (holding the note, sending the placeholder instead) happens in application code (Q's build), this table just durably records that it happened and why, same pattern and same column names as `maintenance_claims`. No protected-class category vocabulary is invented here; `flagged_category` is free text, same reasoning as `maintenance_claims.flagged_category`, so Mason can refine categories without a migration.

## Rule 10 — CCPA Cascade

Not built by this migration — application code, per Rule 4's own inventory requirement, not something a migration implements. See `ccpa_deletable` above for the real, current shape of the gap: a deletion request naming a vendor mentioned in a note would need a manual text search across `notes_snapshot`, the same limitation already accepted for the field it's a snapshot of.

---

## Governance status

- **Asimov (AI governance):** Conditions relayed via Jarvis, addressed in the migration and this document — see the migration header's list of four conditions and where each is satisfied. This document is the artifact for condition 2. Not independently confirmed by a written Asimov document specific to this feature as of this writing — see the flag at the top of this document.
- **Mason (Fair Housing/legal):** Not engaged on this feature — Peter explicitly overrode the Mason-routing recommendation; see `compliance/work-order-note-alerts-mason-override-decision-resolution.md` for the full record. Asimov's Layer 1 + Layer 2 condition stands regardless (Asimov's call, not Mason's, and not waived) — see `compliance/work-order-note-alerts-governance-review.md`. The `retention_policy` figure above was resolved directly by Peter, not Mason.
- **Peter:** Applies the migration himself via Supabase's SQL Editor, per this project's standing process. Nothing in this document or the migration sends any data anywhere — it creates an empty table.

---

## What This Document Does and Does Not Settle

**Does:** gives Asimov and Mason a complete, proportionate inventory for the one table this feature's schema piece creates — `pii_fields`, `agents_with_access`, `privacy_category`, `retention_policy`, `ccpa_exportable`, `ccpa_deletable`, RLS — matching the field format `leadsimple-tasks-workflows-data-inventory.md` and `archive-search-significance-complaint-merge-data-inventory.md` both use, scoped to this table's actual (lower) risk rather than copied at their length.

**Does not:**
- Mark anything CLEARED. That was Asimov's call (made — see `work-order-note-alerts-governance-review.md`) and, for Mason's slice specifically, Peter's own explicit override (see `work-order-note-alerts-mason-override-decision-resolution.md`).

**Update, 2026-09-21:** the gaps flagged above at time of writing are now closed. Asimov's written review exists (`compliance/work-order-note-alerts-governance-review.md`), the spec's status line reflects it, and `retention_policy` above is set. This document's own content otherwise stands as originally written.
