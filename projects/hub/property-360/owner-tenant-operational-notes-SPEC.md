# Owner & Tenant Operational Notes

**Status:** Draft — role-tier mapping resolved and approved. Peter resolved the role-tier open items (`pod_lead`/`property_manager` merged and confirmed as genuinely portfolio-wide, `contributor` gets no access, `admin` alone reaches Legal/Privileged, no new `legal_access` role — Section 3). Asimov and Mason both reviewed the mapping, raised the portfolio-wide `property_manager`/`pod_lead` grant specifically, and — after Peter confirmed the underlying operational fact (routine, structural cross-property coverage) — approved it with conditions (Section 3, Section 9, Section 11 #1a), which are now written into this document. Peter declined a follow-up to outside counsel on this specific point. Remaining before Neo/Q build: the few unrelated "Still Open" items below, and Peter's final go-ahead to build. Nothing in this document connects to a real inbox, table, or credential yet.
**Written by:** Oracle
**Date:** 2026-09-05
**Origin:** Peter's original ask (`property-360-known-issues-CONCEPT.md`, 2026-09-04): surface known owner preferences and tenant/property issues to staff as context, never as a housing decision input. An internal (non-attorney) review ran most of the night of 2026-09-04 and proposed a narrow, suppression-first design. **Real outside counsel reviewed that design overnight and issued a formal opinion (`compliance/owner-tenant-notes-outside-counsel-opinion.md`, received 2026-09-05) that authorizes a substantially broader system than the internal review proposed, on specific conditions.** Per Jarvis's brief, counsel's opinion is authoritative and supersedes the internal review wherever they conflict. This spec implements counsel's actual framework — a three-tier, role-based, human-escalation model — not the internal review's narrower one.
**Governance:** This is a compliance build under GOVERNANCE.md's own trigger ("stores personal data," "influences how staff treat a tenant"). Counsel's opinion resolves the *legal* risk question (Fair Housing, FEHA, CIPA) — it does **not** waive Rincon's own internal engineering discipline. GOVERNANCE.md Rule 6 (Critical: compliance-logic/permission-tier changes require owner approval + attorney review + 7-day shadow mode) and Rule 7 (agent lifecycle: spec → risk assessment → shadow mode → owner approval) both still apply in full, layered on top of what counsel has now cleared. See "What Still Has to Happen Before This Goes Live."

**Built from, read in full:**
- `compliance/owner-tenant-notes-outside-counsel-opinion.md` — the controlling document for every judgment call below.
- `projects/hub/property-360-known-issues-CONCEPT.md` — original scope, Peter's own words, the internal review's now-superseded proposal.
- `GOVERNANCE.md` — Rules 1, 4, 6, 7, 9, 10; the Fair Housing Standard.
- `projects/hub/maintenance-history/router.js` (full file) — `attachMaintenanceHistoryRole`/`requireMaintenanceHistoryRole`/`requireMaintenanceHistoryAccess`, `PRIVACY_REVIEW_ROLES`, `PRIVACY_QUEUE_ACK_ROLE`/`requireAcknowledgment`, `writeAuditLog`, `applyReviewAction`, the flagged-queue/grouped-review/bulk-review routes — the real precedent for every access-gating and review-workflow decision below.
- `projects/hub/property-360/router.js` — `LEADSIMPLE_ALLOWED_ROLES`, `attachLeadSimpleDelinquencyRole` — the real precedent for "explicit allow-list per tool, never a bare truthy role check."
- `supabase/migrations/20260812020000_shared_team_members.sql`, `20260818000000_fix_role_check_regression.sql`, `20260902020000_add_maintenance_coordinator_role.sql`, `20260827000000_approval_briefing_phase1.sql` — the real, current state of `team_member_tool_roles`' `tool`/`role` CHECK constraints.
- `supabase/migrations/20260815010000_maintenance_history_schema.sql`, `20260903000000_maintenance_snapshot_events.sql` — the real schema conventions for a content-checked, human-reviewed fact table (`maintenance_claims`, `maintenance_snapshot_events`), their decision-safe views, and their Rule 4 data-inventory format.
- `supabase/migrations/20260720000003_foundation.sql`, `20260815000000_audit_log_rule1_compliance.sql` — `audit_log`'s real current columns.
- `projects/hub/maintenance-history/lib/content-check.js`, `protected-class-terms.js`, `extract-claims.js` — the real two-layer content check and AI-extraction pattern this spec reuses.
- `projects/hub/maintenance-history/flagged-review-grouping-and-exclusions-SPEC.md` — Asimov's and Mason's real findings on this exact codebase's existing flagged-content review infrastructure, including two hard requirements this spec must not repeat the mistakes of.
- `projects/hub/email-intake/SPEC.md` and `projects/hub/email-intake/lib/*.js` (`index.js`, `privilege-filter.js`, `fair-housing-filter.js`, `privilege-keywords.js`, `government-legal-domains.js`) — the real, already-built (legally cleared, not yet connected to anything) content filter and the real, still-draft ingestion-pipeline design this spec's Section 4 evaluates against counsel's architecture.
- `supabase/migrations/20260626000000_initial_schema.sql`, `20260720000002_owners.sql` — `tenants`/`owners`/`properties`/`units` real columns.
- `compliance/maintenance-coordinator-leadsimple-access.md`, `compliance/director-of-operations-privacy-review-access.md` — real precedent for how a role-to-sensitive-data mapping gets decided and documented in this codebase.

---

## 1. What Changed, Concretely

The internal review's three load-bearing assumptions are each directly rejected by counsel:

| Internal review said | Counsel says |
|---|---|
| When uncertain, suppress permanently | "I would not require the system to operate under a 'when uncertain, suppress the information permanently' model." |
| Flagged content should never be shown to a human reviewer — only a category label | "I would not give the automated Fair Housing filter absolute authority to suppress information permanently... Authorized compliance reviewer → may inspect the underlying content... Risk assessment: LOW — I would specifically approve this feature." |
| Tenant-side scope limited to safety/legal facts only | "I do not see Fair Housing authority requiring Rincon to confine itself to that narrow universe" — counsel authorizes factual operational notes **and** individual factual complaint/dispute records, role-gated instead of content-starved. |

Counsel's own restated standard, which this spec treats as the literal content bar for every note (quote this to Q, Mason, and any future reviewer verbatim — it is the single sentence everything else in this spec exists to implement):

> **"Is this objectively stated information that is reasonably necessary or useful for a legitimate property-management, maintenance, safety, compliance, customer-service, or dispute-management purpose, and is it appropriate for the intended employee to receive it?"**

Two things counsel did **not** change, and this spec carries forward unchanged:
- **No complaint counts, behavioral profiling, or tenant scoring.** Individual factual records only (Red line, unchanged).
- **No AI in an actual housing decision** (approve/deny/renew/evict/screen). This system is read-only context for a human already doing an operational task (Red line, unchanged — see Section 7).

---

## 2. What This Builds

One new Hub-adjacent capability, surfaced primarily on Property 360 (a labeled, collapsible section on the property page, matching how "Needs Privacy Review" and the Maintenance Snapshot already work — click to open, never force-displayed): a place to record and see factual operational notes about an owner, a tenant, or a property in general, at the right access tier for who's looking, with a real human-review path for anything the Fair Housing filter flags, and (behind its own separate, later gate — see Section 8) an AI-assisted path that proposes notes from email content Rincon already has stored.

**New tool value:** `owner_tenant_notes`, added to `team_member_tool_roles.tool`'s CHECK constraint (currently: `insurance_compliance`, `maintenance_history`, `security_deposit`, `call_stats`, `content_engine`, `leadsimple_application_screening`, `leadsimple_delinquency`, `leadsimple_operations`, `approval_briefing` — per `20260827000000`, the most recent migration to touch this constraint). No existing role value is reused blindly for this tool's access — see Section 3 for the per-role reasoning. No new role is added to `team_member_tool_roles.role`; Peter confirmed `admin`'s existing access already covers Legal/Privileged (Section 3).

**New table:** `operational_notes` (Section 3). **Not** a new claim_type on `maintenance_claims` and **not** a rename of the concept doc's "known issues" idea — this is a different content type with a different access model (three ordered tiers, not binary flagged/not-flagged) and, in one specific way, a genuinely different review-outcome model than anything else in this codebase (see the callout in Section 5). Reuses `maintenance_claims`' and `maintenance_snapshot_events`' schema conventions everywhere they actually fit; diverges explicitly, and only, where counsel's framework requires it to.

---

## 3. Mapping Counsel's Three Tiers Onto Real Roles

Counsel's tiers, verbatim intent: **Operational** (available to staff with a legitimate operational need), **Management/Compliance Restricted** (Fair Housing complaints, accommodation documentation beyond a bare instruction, serious disputes, restraining orders, threats, discrimination allegations, misconduct allegations, discriminatory owner instructions, highly sensitive disputes), **Legal/Privileged** (attorney communications, attorney-directed investigations, litigation strategy).

**The real current state of `team_member_tool_roles.role`** (per `20260902020000`, the most recent migration to touch it): `admin`, `director_of_operations`, `property_manager`, `inspection_coordinator`, `pod_lead`, `reviewer`, `contributor`, `leasing_reviewer`, `maintenance_coordinator` — 9 values, shared across every tool via one CHECK constraint, but each tool grants and evaluates them independently (holding `reviewer` for `maintenance_history` grants nothing on `owner_tenant_notes` — same isolation this codebase has already proven twice, in `20260902020000`'s own comment and in the LeadSimple access decision).

**The mechanism, reused exactly as-is (not reinvented):** `attachOwnerTenantNotesRole`/`requireOwnerTenantNotesAccess`/`requireOwnerTenantNotesRole(...)`, the same three-function shape every tool in this Hub already implements independently (`maintenance-history/router.js`'s `attachMaintenanceHistoryRole` is the direct template — read `team_members` by `req.user.id`, fail closed to `null` on any error, then read `team_member_tool_roles` filtered to `tool='owner_tenant_notes'`). **Access is an explicit allow-list keyed to a tier ordinal, never a bare "has any role for this tool" check** — this is not a style preference, it's a hard-won lesson from this exact codebase: the LeadSimple card originally granted access to *any* role value found for its tool, a real bug caught only because Asimov happened to re-read the code before it shipped (`compliance/maintenance-coordinator-leadsimple-access.md`, "Technical notes for the build"). This spec does not repeat that mistake.

```js
// Tier ordinals — a role's granted max tier determines every tier at or
// below it that role can see, same ordinal-comparison pattern already
// used for outcome_level (1-5) and REVIEW_STATUS_RANK in this codebase.
const NOTE_TIER_RANK = { operational: 1, management_compliance_restricted: 2, legal_privileged: 3 };

// Explicit allow-list, evaluated independently for THIS tool — none of
// these mappings are inherited from what these role names mean on
// maintenance_history or leadsimple_delinquency.
//
// Peter's decisions (2026-09-05), resolving every open item below:
// no new role is created — admin alone reaches legal_privileged, and
// pod_lead is confirmed as the same real-world job as property_manager
// at Rincon, so the two are mapped identically rather than treated as
// distinct roles that happen to agree.
const OWNER_TENANT_NOTES_ROLE_MAX_TIER = {
  admin:                    'legal_privileged',
  director_of_operations:   'management_compliance_restricted',
  reviewer:                 'management_compliance_restricted', // granted per-tool; NOT inherited from a maintenance_history 'reviewer' row
  property_manager:         'management_compliance_restricted', // same job as pod_lead at Rincon — see below
  pod_lead:                 'management_compliance_restricted', // same job as property_manager at Rincon, confirmed by Peter — not a distinct mapping
  leasing_reviewer:         'operational',
  maintenance_coordinator:  'operational',                  // further scoped — see note below
  inspection_coordinator:   'operational',
  // contributor: no mapping — confirmed by Peter as no access, not an open item
};
```

| Role | Operational | Mgmt/Compliance Restricted | Legal/Privileged | Reasoning |
|---|---|---|---|---|
| `admin` | ✅ | ✅ | ✅ | Full control everywhere, matching every other tool's convention. **Confirmed by Peter (2026-09-05):** no narrower gate needed — admin reaches Legal/Privileged by default, and no separate named-individual role is created for it (see removed `legal_access` below). |
| `director_of_operations` | ✅ | ✅ | — | Same structural reasoning Mason already accepted for this exact role on Maintenance History's privacy queue (`compliance/director-of-operations-privacy-review-access.md`): "everything property_manager can do, plus final confirmation" is a superset relationship, evaluated on its own terms here rather than assumed. |
| `reviewer` | ✅ | ✅ | — | This tool's *own* compliance-reviewer function — granted per-tool (a person needs a `reviewer` row for `tool='owner_tenant_notes'` specifically; holding `reviewer` on `maintenance_history` grants nothing here), same precedent `email-intake/SPEC.md` already used ("No new role — reuse `admin` and `reviewer` as-is... who gets `reviewer` for this specific tool is Peter's call"). |
| `property_manager` | ✅ | ✅ | — | **Confirmed by Peter (2026-09-05): `property_manager` and `pod_lead` are the same real-world job at Rincon** — mapped identically rather than as two roles that happen to agree. Both reach Management/Compliance-Restricted, since this is the frontline audience most likely to receive a Fair Housing complaint or a discriminatory owner instruction and need to record it (Section 6). |
| `pod_lead` | ✅ | ✅ | — | **Same as `property_manager` — confirmed by Peter as the same job, not a separate evaluation.** No longer an Open Item. |
| `leasing_reviewer` | ✅ | — | — | Leasing/collections function naturally touches tenant dispute records, per the same "actual leasing or collections function" bar Asimov applied when evaluating this exact role for LeadSimple access. |
| `maintenance_coordinator` | ✅, **owner/property-subject notes only** | — | — | Directly maps to the job for owner-side maintenance-standard notes (Peter's own original example). **Does not** get tenant-subject dispute/complaint notes by default — same per-subject-type precision the LeadSimple decision already required for this exact role (Lease Renewal excluded there; tenant-subject notes excluded here), pending its own Asimov/Mason look if Peter wants to widen it. Enforced as a `subject_type != 'tenant'` filter layered on top of the tier check, not a separate tier. |
| `inspection_coordinator` | ✅ | — | — | "Submit/browse, never decide" is this role's documented function everywhere else in this codebase (Asimov's own finding, `maintenance-coordinator-leadsimple-access.md`) — Operational tier fits that function; nothing above it does. |
| `contributor` | — | — | — | **Confirmed by Peter (2026-09-05): no access.** No mapping exists for this role on this tool — same as any role with no row at all, so no dead code is needed to express "none." No longer an Open Item. |
| Anyone with no row for this tool | — | — | — | No card, full stop — same convention as every other tool ("a tool you have no role in simply has no card, no lock icon, no 'ask for access' message"). |

**`admin` roster for this tool — documented per Asimov's requirement, not assumed.** Verified directly against live data (2026-09-05): `admin` is currently held, across all tools combined, by exactly 2 people — Peter (peter@rinconmanagement.com) and Stephen (stephen@rinconmanagement.com, `admin` on `maintenance_history` and `call_stats` only). **Nobody currently holds `admin` for `tool='owner_tenant_notes'`** — this migration only makes the tool value valid to grant; no seed/grant row is created by it, so the roster starts empty. Whether Stephen (or anyone besides Peter) should be granted `admin` on this specific tool — and therefore reach Legal/Privileged attorney-communications content — is a real, live decision Peter needs to make when access is actually assigned, not a hypothetical. Per Asimov's requirement: **widening this tool's `admin` roster beyond whoever Peter initially grants is itself a Rule 6 Critical-tier change**, requiring the same review cycle this section just went through — not a routine account change.

**Removed from this spec, per Peter's decision (2026-09-05): the proposed new `legal_access` role.** The original draft invented a role so Peter could name specific individuals for Legal/Privileged access without relying on `admin`. Peter confirmed `admin`'s existing full access already covers this and no narrower, named-individual gate is needed — so no new role is added to `team_member_tool_roles`'s CHECK constraint for this tool. Every reference elsewhere in this spec to "`admin`/`legal_access`" should be read as `admin` alone.

**Portfolio-wide `property_manager`/`pod_lead` access to Management/Compliance-Restricted content — resolved, not provisional.** Asimov and Mason both initially flagged that this codebase has no property-scoping mechanism anywhere (`team_member_tool_roles` has no `property_id` column — confirmed directly against the schema), so this grant means every `property_manager`/`pod_lead` can read every Fair Housing complaint, threat, discrimination allegation, and discriminatory owner instruction across the entire portfolio, not just their own properties. Both reviewers reconsidered and approved this given Peter's confirmed operational fact (2026-09-05): **property manager coverage at Rincon is genuinely portfolio-wide** — any property manager may end up covering any property as a normal, structural part of the job, not occasionally or as a convenience. Mason's own analysis: "if that's true, portfolio-wide access isn't an overgrant relative to the job — it's an accurate description of the job." **Property-scoping (limiting access to only a PM's assigned properties) was considered and explicitly rejected** — not deferred as a fast-follow — because it would misdescribe how the team actually operates and would gate a covering PM out of exactly the properties they may need to handle that day. Peter has confirmed this is the intended, permanent design, not a stepping-stone pending future narrowing.

Because the underlying exposure this creates (more people able to read Fair Housing-sensitive material, a weaker "need to know" story if ever challenged — the Revock v. Cowpet Bay West concern both reviewers cited) doesn't disappear just because the access is operationally justified, both reviewers required specific safeguards as a condition of this breadth, layered on top of the tier mechanism itself, not a redesign of it:

1. **Read-event audit logging, not just write/review logging.** Every time a `property_manager`/`pod_lead` (or anyone) opens a Management/Compliance-Restricted or Legal-Privileged note, log it — actor, role, property, timestamp. This is new relative to Section 9's original audit table, which only logged creation/proposal/approval/review/correction events, not plain reads. With a broad, portfolio-wide read population, this log is the only way to answer "who looked at this" later. See Section 9's updated audit table.
2. **The one-time acknowledgment gate covers all Management/Compliance-Restricted and Legal-Privileged content, not just flagged items.** Unlike Maintenance History (where "flagged" is a subset of claims), every note at these tiers is sensitive by design — the notice must fire before a `property_manager`/`pod_lead` sees any Tier 2/3 content for the first time, reusing `requireAcknowledgment` per Section 5.
3. **A written access-use policy, shown in that same acknowledgment notice** (Mason to draft the actual text): this tier exists for active operational/backup purposes; browsing outside an actual work reason is a confidentiality violation, treated like any other misuse of sensitive data.
4. **A heightened initial review period of 30–60 days** after this feature leaves the standard 7-day Rule 6 shadow mode (Section 11), during which Asimov/Mason actively pull the new read-audit log and confirm access patterns track real property involvement rather than undirected browsing — a defined checkpoint, not an indefinite commitment.
5. **The periodic sampling audit (Section 9, counsel's Item I) is extended to cover access patterns, not just note content** — who's viewing what, sampled periodically, for the life of this tool, not only during the initial 30–60 day window.

Documented here, with today's date, as the actual contemporaneous record of this decision — Peter's rationale, both reviewers' reconsidered positions, and the resulting conditions — rather than leaving it to be reconstructed later if ever questioned.

**Who can author a note at which tier — not the same question as who can read it.** Any team member holding *any* real role for `tool='owner_tenant_notes'` (i.e., at least Operational-tier access) can author a note at **any** tier, including a tier they cannot themselves read back — this is deliberate and matches counsel's own worked example precisely: a frontline property manager who receives a discriminatory owner instruction needs to be able to record it into the restricted tier (Section 6) even though they don't otherwise see restricted content. The one exception: **only `admin` may author a note declared `legal_privileged`** — ordinary staff shouldn't be initiating an attorney-privileged record at all, only escalating into it.

---

## 4. The Note Record — Schema

New table, new tool value, no changes to any existing table (no natural single-ID join exists between "a fact about an owner or tenant" and any existing row the way Latchel's `order_number` gave Maintenance History one).

```sql
CREATE TABLE operational_notes (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Every note is anchored to a property — matches the concept doc's own
  -- property-page framing and Peter's original ask ("visible to staff
  -- before they act" on a specific property).
  property_id           UUID          NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  unit_id                UUID          REFERENCES units(id) ON DELETE SET NULL, -- nullable; populated when the note ties to a specific unit/tenancy, not the whole property

  -- Polymorphic subject reference — same TEXT-discriminator + UUID
  -- pattern audit_log already uses (entity_type/entity_id), not a new
  -- mechanism. No enforced FK: subject_id points into owners.id or
  -- tenants.id depending on subject_type, and Postgres CHECK constraints
  -- can't express "FK into one of two tables" natively — same limitation
  -- audit_log already accepts. NULL for subject_type='property' (a
  -- general/neighbor-dispute fact not tied to one named person).
  subject_type           TEXT          NOT NULL CHECK (subject_type IN ('owner', 'tenant', 'property')),
  subject_id             UUID,         -- owners.id | tenants.id | NULL — see above

  note_text              TEXT          NOT NULL,   -- the fact itself, objectively stated, per counsel's exact standard (Section 1)
  category               TEXT,         -- free text, not a rigid enum — e.g. 'maintenance_standard', 'access_preference', 'dispute', 'accommodation_instruction', 'owner_instruction_rejected' — Mason should be able to refine without a migration, same convention as flagged_category

  access_tier            TEXT          NOT NULL CHECK (access_tier IN ('operational', 'management_compliance_restricted', 'legal_privileged')),

  source                 TEXT          NOT NULL CHECK (source IN ('manual', 'ai_proposed')),
  author_team_member_id  UUID          NOT NULL REFERENCES team_members(id), -- who typed it (manual), or who approved the AI's draft (ai_proposed — see approval_status below)
  extracted_by            TEXT,         -- NULL for 'manual'; the model version string for 'ai_proposed' — mirrors maintenance_claims.extracted_by exactly

  -- AI-drafted notes require human approval before they are visible to
  -- ANYONE at their declared tier, full stop — the concept doc's own
  -- "AI drafts, human approves" design, which counsel's opinion (Section
  -- 5: "I would permit AI to propose factual notes, subject to human and
  -- automated controls") does not remove. Manual notes skip this entirely
  -- — a human already exercised judgment by typing the fact; only the
  -- content-check/flagging path (below) gates a manual note, not a
  -- second blanket approval step. This is the one place this spec
  -- deliberately departs from the internal review's stricter "admin
  -- approves every note, manual or AI" proposal (concept doc, Open
  -- Question 3c) — counsel's framework requires human review of FLAGGED
  -- content, not a standing pre-publication gate on every fact a person
  -- writes down themselves.
  approval_status          TEXT         CHECK (approval_status IN ('pending_approval', 'approved', 'declined')),
                                        -- NULL for source='manual' (not applicable); NOT NULL, starting
                                        -- 'pending_approval', for source='ai_proposed' — enforced in
                                        -- application code at insert, not a DB CHECK tying two columns
                                        -- together (matches this schema's general discipline of enforcing
                                        -- only the clearly-stated invariants, e.g. outcome_level's claim_type
                                        -- scope, and leaving looser conventions to app code + comments)

  -- The two-layer content check (GOVERNANCE.md Rule 9) — identical
  -- columns, identical enforcement to maintenance_claims/
  -- maintenance_snapshot_events. Layer 1 (lib/protected-class-terms.js,
  -- reused as-is, no changes) runs on every note's note_text regardless
  -- of source. Layer 2 differs by source — see Section 5.
  flagged_protected_class  BOOLEAN      NOT NULL DEFAULT FALSE,
  flagged_category          TEXT,        -- required whenever flagged_protected_class = TRUE, enforced below

  -- Disposition of a FLAGGED note, decided by a human reviewer holding
  -- Management/Compliance-Restricted tier or above. Deliberately NOT the
  -- confirm/correct/reject vocabulary maintenance_claims uses — see
  -- Section 5 for why a new vocabulary is required here, not a stylistic
  -- choice.
  review_status              TEXT       NOT NULL DEFAULT 'unreviewed'
                                CHECK (review_status IN (
                                  'unreviewed', 'retained_restricted',
                                  'rephrased_and_released', 'false_positive_released'
                                )),
  reviewed_by                 TEXT,       -- reviewer's email, same TEXT-email convention as maintenance_claims.reviewed_by
  reviewed_at                  TIMESTAMPTZ,
  reviewer_notes                 TEXT,

  created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT operational_notes_flag_requires_category
    CHECK (flagged_protected_class = FALSE OR flagged_category IS NOT NULL),

  -- A note declared legal_privileged must be authored (or AI-drafted and
  -- approved) only by admin — enforced in application code at write
  -- time (Section 3's authorship rule), not a DB CHECK, since "is this
  -- team member admin" requires a join this table can't see on its own.
  CONSTRAINT operational_notes_ai_requires_approval_status
    CHECK ((source = 'manual' AND approval_status IS NULL) OR (source = 'ai_proposed' AND approval_status IS NOT NULL))
);

ALTER TABLE operational_notes ENABLE ROW LEVEL SECURITY; -- locked by default, matches every table in this schema

CREATE INDEX idx_operational_notes_property        ON operational_notes(property_id);
CREATE INDEX idx_operational_notes_subject          ON operational_notes(subject_type, subject_id) WHERE subject_id IS NOT NULL;
CREATE INDEX idx_operational_notes_flagged           ON operational_notes(flagged_protected_class) WHERE flagged_protected_class = TRUE;
CREATE INDEX idx_operational_notes_unreviewed_flagged ON operational_notes(review_status) WHERE flagged_protected_class = TRUE AND review_status = 'unreviewed';
CREATE INDEX idx_operational_notes_pending_approval    ON operational_notes(approval_status) WHERE approval_status = 'pending_approval';

DROP TRIGGER IF EXISTS trg_operational_notes_updated_at ON operational_notes;
CREATE TRIGGER trg_operational_notes_updated_at
  BEFORE UPDATE ON operational_notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

**Deliberately not built, considered and rejected:**
- **A `related_note_id` self-reference** to link a restricted-tier note to its sanitized Operational-tier companion (counsel's "frontline staff gets the routing instruction, compliance keeps the sensitive detail" pattern). Two independent notes, optionally cross-referenced in free text, is enough for v1 — inventing a new linking column for a traceability nicety nobody has asked for yet matches this schema's own repeated "don't build ahead of a proven need" discipline (`maintenance_snapshot_events`' own "no join/cross-reference column... a v2 concern if it turns out to matter in practice"). Flagged as an Open Item for Tron: consider a lightweight "also add a public-facing note" prompt when someone files a restricted-tier note, without automating the redaction itself (a human still has to write the sanitized version — auto-redaction is exactly the kind of thing Rule 9's human-judgment discipline warns against automating carelessly).
- **A `risk_score`/`personality`-type column of any kind.** Not "restricted," not "flagged" — simply does not exist in this schema, anywhere. This is the concrete enforcement mechanism for counsel's "AI-generated personality or risk assessments — I would not build this" prohibition: there is no field capable of holding one.
- **A retention/expiry column** (`archived_at`, `expires_at`). The concept doc's own proposal (tenant notes expire at tenancy end; owner notes get periodic re-confirmation) is a reasonable v1 direction but is a Mason decision, not an engineering guess — `retention_policy` stays a documented PLACEHOLDER in the Rule 4 data inventory below, matching this schema's standing practice (`maintenance_claims`, `maintenance_snapshot_events`, `security_deposit_cases` all shipped the same way). See Section 9.

**Rule 4 data inventory:**
- `pii_fields`: `note_text` — highest density by design; `reviewer_notes` — same PII-adjacent caveat used everywhere in this schema; `flagged_category` — could indirectly reveal the sensitive topic without containing it.
- `agents_with_access`: Claude (`ANTHROPIC_API_KEY`), only for the `ai_proposed` path (Section 5's Layer 2 and Section 8's extraction step); Hub users holding a role mapped to Operational tier or above for `tool='owner_tenant_notes'` (Section 3), scoped per-note by `access_tier`.
- `privacy_category`: Owner/tenant operational record — same category `maintenance_claims` uses, extended to cover owner-side content this schema hasn't stored before.
- `retention_policy`: **PLACEHOLDER pending Mason** — see above.
- `ccpa_exportable`: TRUE. `ccpa_deletable`: TRUE for `operational`/`management_compliance_restricted` tier notes, via the same targeted `note_text`/`reviewer_notes` → `"[REDACTED]"` redaction convention as `maintenance_claims.claim_text`, preserving `subject_type`, `category`, `access_tier`, dates for audit continuity. Same accepted v1 limitation: finding every row about a specific person is a manual lookup via `subject_id`/`property_id`, not automatic.

  **`legal_privileged` notes are a categorical exception to the above — designed by Mason (2026-09-05), not left to the general redaction path.** A CCPA deletion request touching a `legal_privileged` note (attorney communications, litigation strategy) risks either spoliation of a litigation hold or destroying Rincon's own defensive documentation (e.g., a `retained_restricted` `owner_instruction_rejected` note). CCPA itself anticipates this — a business may deny deletion to the extent necessary to comply with a legal obligation or defend a legal claim (Cal. Civ. Code § 1798.105(d); Mason flags this citation as directional, to be confirmed by actual counsel before it's ever cited to a real requester). The concrete process: the standard redaction function must **hard-refuse** to act on any `access_tier = 'legal_privileged'` row (never a silent skip) and route it instead to a manual hold/exception check — does an active or reasonably anticipated litigation hold cover this note's matter, and would redacting it impair Rincon's ability to defend a legal claim. No schema change (no `legal_hold` column — a hold attaches to a matter, not a row; the check is done fresh at request time, not cached as stale row-level state). Three outcomes: hold/exception applies → deletion denied, note unchanged; no hold, confirmed safe → admin executes standard redaction; unresolved/ambiguous → **default to not redacting** until resolved (a deliberate inversion of this spec's usual "don't default to suppression" posture — here the risk being guarded against is irreversible erroneous destruction, not under-disclosure). Two new `audit_log` actions: `operational_notes.ccpa_deletion_blocked_privileged` (system, automatic block) and `operational_notes.ccpa_deletion_disposition` (human, the actual determination — `details` captures the hold/exception finding and who confirmed it, never the note's own privileged text). **Approval — resolved by Peter (2026-09-05): entirely an `admin` call, no standing attorney-confirmation requirement.** Mason's original design recommended the hold/exception determination be made or confirmed by an actual attorney each time, reasoning that `admin` is an app-permission tier, not legal authority, on its own. Peter declined that specific element and confirmed this stays entirely an internal `admin` decision — Mason had explicitly framed this as a question for Peter to confirm, not a hard legal requirement, so this is within the scope Mason left to Rincon. The rest of Mason's design is unchanged: the hard-refuse guard on the standard redaction path, the fresh hold/exception check at request time (no cached `legal_hold` column), the three outcomes (denied-citing-exception / redacted / default-to-not-redacting-when-unresolved), and both new `audit_log` actions all stand as designed — only the identity of who makes the substantive call changes, from "attorney confirms, admin executes" to "admin alone decides and executes." Whoever holds `admin` for this tool is now the sole judgment point on a decision with real spoliation/litigation-hold stakes if gotten wrong — worth keeping in mind given how few people that currently is (Section 3).

---

## 5. Human Review of Flagged Content — Extend or Build New?

**Verdict: extend the underlying mechanical infrastructure; do not extend the actual review vocabulary or the decision-safe view's exclusion logic — those two pieces are genuinely different here, not stylistically different.**

**What reuses cleanly:**
- **The two-layer content check itself.** Layer 1 is `lib/protected-class-terms.js`'s `scanText()`, imported unchanged — no new keyword list, no fork. Layer 2 differs by `source`: for `ai_proposed` notes, the drafting model self-reports via the same `modelFlag`/`modelCategory` convention `extract-claims.js` already uses. For `manual` notes there is no model already in the pipeline to self-report — this spec recommends Q add one small, new, cheap classification-only Claude call at write time (same defense-in-depth principle `content-check.js`'s header already documents, applied to a manually-typed source instead of an in-flight AI extraction) rather than relying on Layer 1 alone for staff-typed text. This is genuinely new code, not a reuse — flagged here so it isn't assumed to already exist.
- **The acknowledgment gate and audit-log helper.** `requireAcknowledgment`/`writeAuditLog` (`maintenance-history/router.js`) are already written generically enough (keyed by action string and actor email, not by table) to call as-is for this tool's own privacy-queue acknowledgment, with a tool-specific `PRIVACY_QUEUE_ACK_ACTION` constant (e.g. `'operational_notes.privacy_queue_acknowledged'`) — same one-time-notice pattern, same reasoning (a role newly gaining exposure to protected-class-adjacent content should see the same warning `director_of_operations` sees on Maintenance History today).
- **The grouped/bulk-review UI concept** (`flagged-review-grouping-and-exclusions-SPEC.md` Part 1) — clustering by matched term/category so a reviewer isn't opening 250 items one at a time — is worth building the same way here once volume justifies it, but is not required for v1 given this is a new, low-volume-at-launch data source. Flagged as a fast-follow, not a blocker.

**What must NOT be reused as-is, and why — the single most important schema-design decision in this spec:**

`maintenance_claims_decision_safe`/`maintenance_snapshot_events_decision_safe` both permanently exclude any row where `flagged_protected_class = TRUE`, **regardless of `review_status`** — confirmed directly against the live view definition (`supabase/migrations/20260815010000_maintenance_history_schema.sql`): `WHERE flagged_protected_class = FALSE AND review_status != 'rejected'`. That behavior is correct for maintenance ticket narrative, where "flagged" means "this content should never appear in the normal ticket view again, full stop, only the privacy queue shows it." (Correction, 2026-09-05: an earlier draft of this section attributed this requirement to a specific quote from Asimov's review of the grouped-review spec; that quote does not exist anywhere in this codebase and was a fabricated citation, caught by Asimov's own reconsideration. The underlying technical description above is independently verified against the real SQL and remains accurate — only the false attribution is removed.)

**Counsel's model for this feature requires the opposite outcome for two of the three review dispositions.** Quoting Section 4 of the opinion directly: *"Compliance reviewer decides → retain restricted; convert to operationally appropriate language; or classify as a false positive and release."* Two of those three outcomes — rephrase-and-release, false-positive-release — **require the item to become normally visible again**, at whatever tier the reviewer assigns. A decision-safe view that permanently excludes anything ever flagged would make counsel's explicitly-approved feature impossible to build correctly. This is a deliberate, counsel-required divergence from this codebase's existing pattern, not an oversight — call it out to Asimov by name when this spec is reviewed, precisely because it looks, on the surface, like repeating a mistake this codebase already fixed once.

```sql
CREATE VIEW operational_notes_visible AS
SELECT * FROM operational_notes
WHERE (source = 'manual' OR approval_status = 'approved')     -- AI drafts stay invisible until approved, always
  AND (
    flagged_protected_class = FALSE
    OR review_status IN ('rephrased_and_released', 'false_positive_released')
  );
```

A flagged-and-`retained_restricted` note stays permanently excluded from this view for anyone below Management/Compliance-Restricted tier — same exclusion outcome as `maintenance_claims_decision_safe` for that one specific disposition, just not for all three. The application layer additionally filters this view's rows by the viewer's `NOTE_TIER_RANK` against each row's `access_tier` (Section 3) — `operational_notes_visible` handles "should this be visible to anyone at all," the app layer handles "should this specific viewer see it."

**What an ordinary employee sees for a flagged-and-unreviewed note — a real, deliberate improvement over the existing pattern, not an oversight either.** `maintenance_claims`' flagged rows are simply absent from the normal view — no notice, nothing. Counsel's own described UX is different and better: *"Ordinary employee → sees sanitized note or notice that something was withheld."* This spec adopts that: a flagged, `unreviewed` note renders a placeholder (`"A note here is pending compliance review."`) to anyone below Management/Compliance-Restricted tier who would otherwise see it at its declared `access_tier`, rather than silent absence — reusing the same placeholder-string convention `safeTicketTitle()` already established (`APPFOLIO_TEXT_PLACEHOLDER`) for exactly this "something is here, you just can't see it" case.

**The reviewer action itself — a new function, `applyNoteReviewDisposition`, sibling to `applyReviewAction`, not a fork of it:**

| Counsel's disposition | `review_status` set to | What happens to `note_text` | What happens to `access_tier` |
|---|---|---|---|
| Retain in restricted tier | `retained_restricted` | Unchanged, unless the reviewer also edits it | Forced to (or confirmed as) `management_compliance_restricted` — never lowered |
| Rephrase and release in operationally-appropriate language | `rephrased_and_released` | **Required** — reviewer must submit new text; the API rejects this action with no `note_text` supplied, same required-field discipline `applyReviewAction`'s `correct` action already enforces | Reviewer's choice, typically downgraded to `operational` |
| False positive — release as-is | `false_positive_released` | Unchanged | Unchanged (whatever the author originally declared) |

Every disposition writes one `audit_log` row (`action: 'operational_notes.reviewed'`), reusing `writeAuditLog` exactly, with `details: { review_status, reviewer_notes, actor_role, previous_access_tier, new_access_tier }` — never the note's own text, same restraint `maintenance_claims.reviewed`'s audit entries already use.

---

## 6. AI-Proposed Notes and the Discriminatory-Owner-Instruction Case

A discriminatory owner instruction ("no Section 8," "no families with children") does not need a special code path — it is handled correctly by the mechanism that already exists. Any note text naming a protected characteristic (source of income, familial status, etc.) will, in the ordinary course, trip Layer 1 of the content check (`protected-class-terms.js` already carries a `source_of_income` category covering vouchers/Section 8) and land in the flagged-review queue automatically. The **recommended authoring pattern**, per counsel's own template, is documentation Mason should put in front of staff, not a schema feature:

> Owner instruction: "[quote the instruction]." Rincon response: request could not be implemented because [reason — e.g., California Government Code / FEHA protects source of income].

Filed as `category: 'owner_instruction_rejected'`, `access_tier: 'management_compliance_restricted'`, `subject_type: 'owner'`. When it reaches human review, the correct disposition is almost always `retained_restricted` — this is a real, legitimately sensitive record Rincon wants to keep, permanently, in the restricted tier, exactly as counsel recommends ("That documentation can be useful protection for Rincon"). It is not a false positive and should not be rephrased into something more visible — training/review guidance for Mason to write, not a rule this spec encodes in code.

---

## 7. Absolute Prohibitions — What's Actually Enforceable in Software

| Prohibition | Software-enforceable today? | Mechanism | Residual human-judgment gap |
|---|---|---|---|
| AI-generated personality/risk scores | **Yes, fully** | No such column exists anywhere in this schema (Section 4) — there is no code path that could produce one. | None — this is a "don't build the feature" prohibition, not a filter. |
| Protected-class profiling without legitimate purpose | **Yes, structurally** | The two-layer content check + tiered human review (Section 5) *is* the enforcement mechanism — any protected-class mention routes to a human who must affirmatively judge whether a legitimate purpose exists before the note is ever released more broadly than the restricted tier. | The judgment itself ("is there a legitimate purpose here") is inherently human — software can force the review, not make the call. |
| Discriminatory owner instructions recorded as plain operational instructions | **Yes, structurally** | Same mechanism as above — the instruction's own protected-class language triggers the flag automatically (Section 6). | None beyond the review judgment already covered above. |
| Derogatory/subjective character judgments ("difficult," "problem tenant") | **Partially** | Recommend a small, new, separate keyword/phrase list (distinct from `protected-class-terms.js` — this is evaluative language, not protected-class content) producing a **soft, non-blocking warning at entry** ("this may be a characterization rather than a fact — consider rephrasing," citing counsel's own fact-vs-characterization examples). Deliberately not a hard block: a word like "difficult" appears in plenty of legitimate facts ("difficult access due to a locked gate"), and a hard block on common English words would be false-positive-heavy in a way this codebase has already been burned by once (`flagged-review-grouping-and-exclusions-SPEC.md`'s own ~2.3% false-positive rate on a much narrower list). | The real backstop is counsel's own item I — periodic sampling audit — not a keyword list. Flag this plainly rather than overstating what a keyword scan can catch. |
| Unnecessary medical/disability detail | **Partially** | `disability_health` is already a Layer 1 category — any such detail is already flagged and routed to human review by construction. | Whether a given level of detail is "necessary" (vs. excess) is a judgment call for the reviewer, not something a keyword scan can decide on its own. |
| Protected activity converted into a negative attribute ("filed a complaint — problem tenant") | **Partially** | Usually catches on the same protected-class terms (mentions the complaint) or the same evaluative-language soft-warning (the "problem tenant" half) — the combination of both checks covers most real phrasing, but neither is a perfect catch on its own. | Same audit-sampling backstop as the derogatory-language row above. |

---

## 8. AI Email Extraction — What's Verified vs. What Peter Must Confirm

Counsel's required architecture: Rincon receives the communication → it resides in Rincon's own system → a **contracted processor** then analyzes Rincon's already-stored copy, under contract terms barring independent use. This section separates what's technically verifiable from what is a business/contract question — per the task brief, not blurring the two.

**What's true today, verified by reading the actual code, not assumed:**
- Rincon's tenant/owner/vendor email lives in **Gmail** (Google Workspace); shared pod inboxes live in **Missive**, explicitly not Gmail (per `CLAUDE.md`). Both are third-party-hosted mailboxes that receive and store a message before anything else can act on it — that part of counsel's "Rincon receives, Rincon stores, then a processor analyzes the stored copy" sequence is **already structurally true today, with no code change needed**, *provided* the eventual pipeline reads from Gmail's/Missive's own already-stored copy rather than intercepting mail in transit.
- `projects/hub/email-intake/lib/` contains a real, already-built, already-legally-cleared privilege/Fair-Housing content filter (`index.js`, `privilege-filter.js`, `fair-housing-filter.js`, and their keyword lists) — confirmed by reading all five files. It operates on text already in memory; it does **not** itself connect to Gmail or Missive.
- `projects/hub/email-intake/SPEC.md` is a **draft, not yet built** (confirmed: no `router.js`, no ingestion code exists in that project directory today — only `lib/`, `test/`, and the spec file). Its own "Ingestion Approach" section already describes the counsel-compliant shape: *"a scheduled pull... that lists new/updated threads in the shared inbox"* — a periodic read of Missive's own stored data, not a live intercept. **This is the one concrete technical guardrail to hold whoever eventually builds the real Missive/Gmail connection to:** it must be a scheduled pull against the mailbox's own stored copy, never a live SMTP-relay/BCC-forward/webhook-fires-before-storage design — the latter would reproduce exactly the "outside company intercepting communications simultaneously with transmission" pattern counsel explicitly rejects.
- `lib/extract-claims.js` demonstrates the real, working pattern for the extraction step itself: a standard `@anthropic-ai/sdk` call (`anthropic.messages.create(...)`) against Rincon's own `ANTHROPIC_API_KEY`, reading content already pulled into Rincon's own process. Reusing this exact pattern for note extraction is a straightforward, already-proven build — not new architecture.

**Resolved (2026-09-05): the Anthropic contract-terms question.** Peter confirmed directly with Anthropic. Their response, matched against counsel's specific list: (1) no training on API inputs/outputs by default, absent explicit opt-in — Rincon's account has not opted into anything like that; (2) no combining Rincon's data with data from other sources — an explicit Data Processing Addendum (DPA) commitment; (3) no sale or sharing of Rincon's data under CCPA-style definitions — also explicit in the DPA. These commitments are automatically incorporated the moment Anthropic's Commercial Terms of Service are accepted — no special tier or separately negotiated contract is required to get them in writing; the DPA and Commercial Terms are both publicly posted (anthropic.com/legal/data-processing-addendum, anthropic.com/legal/commercial-terms) for counsel to review directly. **One condition this depends on, verified from this codebase**: this all applies to Anthropic's own direct API/Console — a third-party reseller or platform would be governed by that party's own terms instead. This codebase's actual credential is a plain `ANTHROPIC_API_KEY` (`.env.example`), the standard convention for Anthropic's own direct API, not a reseller integration — consistent with, though not a substitute for, Peter's own confirmation of the account's actual contractual basis.
- The exact Missive/Gmail connection mechanism (API scope, OAuth vs. delegated account, webhook vs. poll) — `email-intake/SPEC.md`'s own Open Item #1, still unresolved, needing its own Sentinel/Scotty pass once a connection is actually being built.
- Whether Rincon qualifies as a covered CCPA business for this specific processing, and whether California's ADMT regulations apply — counsel's own open question (Section 5), unresolved by this spec.

---

## 9. Audit Trail, Retention, Correction

**Audit trail — reuses `audit_log` exactly, no new logging mechanism**, following the same Rule 1 field guidance `20260815010000`'s "AUDIT LOG GUIDANCE FOR Q" section already established for `maintenance_claims`:

| Event | `action` | `actor_type` | `privacy_category` | `risk_level` |
|---|---|---|---|---|
| Note created (manual) | `operational_notes.created` | `human` | `collection` | `low`, unless created directly at `management_compliance_restricted`/`legal_privileged` (`medium`) |
| Note proposed (AI) | `operational_notes.ai_proposed` | `ai_agent` | `collection` | `medium` |
| AI proposal approved/declined | `operational_notes.approval_decided` | `human` | `processing` | `low` |
| Content-check flag | `operational_notes.protected_class_flagged` | `system` (Layer 1) or `ai_agent` (Layer 2) | `processing` | `high` — same as `maintenance_claims.protected_class_excluded`, `details` never carries the flagged text itself |
| Human review disposition | `operational_notes.reviewed` | `human` | `processing` | `low`, unless disposition is `rephrased_and_released` or `false_positive_released` on originally-flagged content (`medium`) — same asymmetry `maintenance_claims.reviewed` already uses |
| Post-hoc correction (Item J) | `operational_notes.corrected` | `human` | `processing` | `low`, `details: { old_note_text, new_note_text }` per GOVERNANCE.md Rule 6 ("previous and new values") |
| Privacy-queue acknowledgment | `operational_notes.privacy_queue_acknowledged` | `human` | `processing` | `low` |
| **Tier 2/3 access acknowledgment** (new, added per Asimov/Mason's reconsideration, 2026-09-05) | `operational_notes.tier_access_acknowledged` | `human` | `processing` | `low` — one-time per team member, fires before first view of any `management_compliance_restricted`/`legal_privileged` note, separate from the flagged-content privacy-queue acknowledgment above |
| **Note viewed** (new, added per Asimov/Mason's reconsideration, 2026-09-05) | `operational_notes.viewed` | `human` | `processing` | `low` individually, but this is the load-bearing log for the portfolio-wide `property_manager`/`pod_lead` grant (Section 3) — `details: { note_id, property_id, access_tier, actor_role }`, never the note's own text. Logged on every view of a `management_compliance_restricted`/`legal_privileged` note, not just Operational-tier notes — this is what makes the periodic access-pattern sampling below possible at all. |

**Correction mechanism (counsel's item J)** — deliberately **not** a new versioning table. A materially inaccurate note is corrected the same way a `maintenance_claims` row is corrected today: one `UPDATE` to `note_text` (preserving `updated_at`) plus one `audit_log` row carrying old and new text. Available to `admin`/`director_of_operations`/`reviewer` for this tool at minimum — narrower than "anyone can edit anything," matching this tool's own tiered-access philosophy rather than a blanket edit right.

**Periodic sampling audit (counsel's item I)** — not built here; this is a recurring Mason/Asimov process, not a feature. Flagged as an ongoing operational commitment Peter is taking on by shipping this tool, not a one-time engineering task. **Extended per Asimov/Mason's reconsideration (2026-09-05) to explicitly cover access patterns, not just note content** — given the portfolio-wide `property_manager`/`pod_lead` grant (Section 3), this sample must periodically check *who's viewing what* against the new `operational_notes.viewed` log, confirming access tracks real property involvement rather than undirected browsing, for the life of this tool — not only during the initial 30–60 day window in Section 11.

**Retention (counsel's item K)** — `retention_policy` ships as a documented **PLACEHOLDER**, same standing practice as `maintenance_claims`, `maintenance_snapshot_events`, and `security_deposit_cases` before Mason set an actual figure for each. The concept doc's own proposal (tenant notes archive at tenancy end; owner notes get periodic re-confirmation rather than indefinite retention) is a reasonable starting point for that conversation, not decided by this spec.

---

## 10. The Housing-Decision Firewall

This system has, and must continue to have, **zero** connection to: `leases` status changes, any LeadSimple `leadsimple_application_screening`/`leadsimple_delinquency`/`leadsimple_operations` decision workflow, `security_deposit_cases` dispositions, any renewal or eviction process, or any future applicant-screening tool. No foreign key, no join, no API call, no scheduled job reads `operational_notes` into any of those systems. The only consumer of this data is a human, reading a property/owner/tenant's own page, already in the middle of an operational task that already exists independent of this tool (dispatching a vendor, responding to a complaint, talking to an owner).

**If a future feature ever wants to use `operational_notes` as an input to any automated or human housing decision, that is a new build requiring its own fresh Fair Housing review** — this spec's existence, and counsel's clearance of it, does not pre-approve that. State this plainly to Q at build time: this table's existence must never quietly become a shortcut for "we already have data on this tenant" inside a screening or renewal feature later.

---

## 11. What Still Has to Happen Before This Goes Live

Distinct from "what's now clear to build," per Jarvis's brief:

1. **Rincon's own internal governance discipline (GOVERNANCE.md Rule 6/7) — unaffected by counsel's opinion.** This is a Critical-tier compliance-logic/permission-tier change: owner approval, attorney review (now satisfied — this is that attorney review), and **7 days of shadow mode** before the flagged-review disposition workflow goes live for real use, same as `flagged-review-grouping-and-exclusions-SPEC.md`'s Part 2 requires for its own, smaller exclusion feature. Rule 7's lifecycle (`proposed → risk-assessed → development → shadow → active`) applies to the AI-proposal path specifically, given it's the part with the least precedent in this codebase.
1a. **New, added per Asimov/Mason's reconsideration (2026-09-05): a 30–60 day heightened initial review period for the portfolio-wide `property_manager`/`pod_lead` read grant specifically**, starting after the standard 7-day shadow mode above. Distinct from that shadow mode and from the ongoing periodic sampling audit (Section 9) — this is a defined, time-boxed checkpoint where Asimov/Mason actively pull the new `operational_notes.viewed` log and confirm access patterns track real property involvement before treating the grant as fully proven out, not an indefinite commitment.
2. **The CIPA/privacy technical architecture review counsel requires before production** (Section 8) — not before development. This is a real, separate Sentinel/Scotty/outside-counsel pass on the actual Missive/Gmail connection once it's being built, exactly like `email-intake/SPEC.md`'s own unresolved Open Item #1.
3. **The AI-vendor contractual confirmation (Section 8) — resolved 2026-09-05.** Peter confirmed directly with Anthropic; their Data Processing Addendum and Commercial Terms of Service satisfy counsel's list (no training, no combining with other data, no sale/sharing) with no special tier or negotiated contract needed. See Section 8's own updated text for the full answer and the one condition it depends on (Anthropic's direct API, not a reseller — consistent with this codebase's plain `ANTHROPIC_API_KEY` credential).
4. **The role-tier mapping in Section 3 — Asimov's and Mason's sanity-check is complete.** Peter resolved the three staffing/business open items (`pod_lead` = `property_manager`, both at Management/Compliance-Restricted, portfolio-wide; `contributor` gets no access; `admin` alone reaches Legal/Privileged, no new `legal_access` role). Both reviewers then specifically reconsidered the portfolio-wide `property_manager`/`pod_lead` grant given Peter's confirmed operational fact (routine, structural cross-property coverage) and approved it with the conditions now written into Section 3 and Section 9 (read-event audit logging, an expanded acknowledgment gate, a written access-use policy, the 30–60 day review period above, and access-pattern sampling folded into the ongoing periodic audit). Peter declined a follow-up confirmation to outside counsel on this specific point, proceeding on his own authority as owner. No open items remain here.
5. **Mason's staff-facing content guidance — done, 2026-09-05.** See `projects/hub/owner-tenant-notes/staff-guidance.md`: the final Tier 2/3 access-use policy text (live in `router.js`'s `TIER_ACCESS_ACK_MESSAGE`), the refined derogatory-language warning and word list (`v2`), and the owner-instruction-rejection guidance referenced in Sections 6 and 7. One item within it is still open: the specific statutory citations in the rejection-template examples are illustrative, not confirmed by counsel — flagged in that document, not yet closed out.

---

## Open Items — Needs Confirming Before Neo/Q Build

**Resolved by Peter (2026-09-05):**
- `pod_lead` and `property_manager` are the same real-world job at Rincon — mapped identically, both at Management/Compliance-Restricted (Section 3).
- `contributor` gets no access to this tool (Section 3).
- `admin` reaches `legal_privileged` by default; no new `legal_access` role is created (Section 3).

**Still open:**
1. Whether to widen `maintenance_coordinator` beyond owner/property-subject notes later — deliberately not decided here, same "confirm before widening" discipline the LeadSimple decision already modeled.
2. The Section 5 "new, small Layer-2 classification call for manually-typed notes" is a real, new build item, not yet estimated — worth a size check from Q before this ships, since it adds a synchronous AI call to every manual note submission (latency/cost tradeoff worth seeing in practice, not just in theory).
3. Grouped/bulk review (Section 5) — recommended as a fast-follow once volume justifies it, not required for v1. Confirm that's an acceptable v1 cut.
