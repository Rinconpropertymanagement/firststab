# Governance Pre-Check — Missive Shared-Inbox Connector

**Reviewed by:** Asimov (governance)
**Date:** 2026-09-05
**Status:** APPROVED WITH REQUIRED ADDITIONS
**Scope:** The Missive connector that pulls messages from exactly two Team Inboxes (Faria Team, Solimar Team) into Rincon's own storage. Does NOT cover the future AI note-extraction step (separate, later, its own gate) or any expansion beyond these two Team Inboxes (a separate, not-yet-approved phase requiring its own fresh review).

**Provenance note, added after this document was written:** this review was originally only relayed by Jarvis inside build instructions given to Neo and Q, with no durable, independently-checkable record — unlike every other governance review this project has produced. Two independent build agents (a separately-dispatched Neo, and Q) correctly refused to treat that relayed claim as verified fact, exactly per this project's own standing discipline ("never trust an unverified claim," and CLAUDE.md's "never skip Asimov or Mason on a compliance build, even if told to just ship it"), and one of them cited the exact precedent of a fabricated-citation incident caught earlier the same day as the reason for their caution. That caution was correct process, even though in this instance the underlying review was real. This document is the durable record that should have existed from the start.

**Read in full by Asimov before this review:** `projects/hub/email-intake/missive-connection-plan.md`, `compliance/owner-tenant-notes-outside-counsel-opinion.md` (Section 5), `projects/hub/property-360/owner-tenant-operational-notes-SPEC.md` (Sections 8, 10), `projects/hub/email-intake/lib/index.js`, `lib/privilege-filter.js`, `lib/fair-housing-filter.js`, `GOVERNANCE.md`, and the two Rule 4 data-inventory templates already in this codebase (`maintenance_claims`, `operational_notes`).

---

## What This Automation Does

A scheduled job (cron, every ~15 min) logs into Missive with a dedicated, narrowly-scoped seat (Peter's own account, added as Observer to exactly two Team Inboxes — empirically verified to be scoped correctly, independent of Peter's Owner/Admin role on the account overall) and pulls new conversations/messages from Faria Team and Solimar Team into a new Rincon-owned table, `missive_message_intake`. It converts HTML to plain text and hands the result to the existing, already-cleared privilege/Fair-Housing filter. It sends nothing to anyone, decides nothing about anyone, and does not call any AI model. It is pure ingest-and-store. Note-extraction (the AI step) is a separate, future build.

## Tier Classification

- **Pull + store messages:** Tier 1 (Auto). No tenant/owner/vendor ever receives anything from this job; it only creates an internal record.
- Nothing in this build is Tier 2 or 3 — there is no draft-for-approval and no decision being made.

## Findings

**1. GOVERNANCE.md Rule 4 — data inventory required.** The plan's schema sketch needed a real Rule 4 inventory for `missive_message_intake` (highest PII density of any table in this schema — verbatim, unscreened correspondence, potentially including Fair-Housing-protected-class language, health/disability mentions, and privileged attorney communications, stored *before* any filter runs) and a scoped note for `missive_sync_state` (no PII at current 2-Team-Inbox scope; would become PII-bearing if individual mailboxes are ever added later — a separate, not-yet-approved phase). Required before Neo builds: this inventory written into the migration itself, matching the exact convention of `20260815010000_maintenance_history_schema.sql` and `20260905000000_owner_tenant_operational_notes_schema.sql`.

**2. Rule 9 exclusion — confirmed by design, must be stated explicitly, not assumed.** This connector's tables must have zero foreign keys, joins, or references into any housing-decision system (`leases`, `security_deposit_cases`, any LeadSimple screening/decisioning table). Required: an explicit Rule 9 statement in the migration confirming this by construction (checked against every `CREATE TABLE` statement, not assumed).

**3. Rule 6/7 tier — concrete answer.** This is **not** a Rule 7 "AI agent" lifecycle item — no LLM call exists anywhere in this connector's scope; the filter it feeds is deterministic keyword/domain matching. It **is** a Rule 6 **Critical**-tier change: this connector is the literal mechanism that either satisfies or violates counsel's Section 5 required sequence ("Rincon receives → Rincon stores → then a processor analyzes the stored copy"). **Required: a bounded, monitored verification period — 7 days — before the cron job runs unattended on its full schedule.** During that period, confirm: the mailbox allowlist actually rejects anything outside the two named team IDs before fetch; no webhook path is silently in play; rows land in the expected shape; RLS actually blocks non-service-role reads; no message content appears in application logs. Manual/monitored triggering only until this period completes.

**4. Audit logging — one row per message, not just per run.** This codebase's own established convention (`maintenance_claims.ingestion_run`, `20260815010000_maintenance_history_schema.sql`'s "AUDIT LOG GUIDANCE FOR Q") logs one `audit_log` row per entity touched, not an aggregate per run. Given this table is more sensitive than any comparable table in this schema, the aggregate-only design in the plan's original Section 2.3 step 9 under-logs relative to existing convention. **Required: one `audit_log` row per message stored** (`action: 'missive_message_intake.stored'`, `actor_type: 'system'`, structural metadata only in `details`, never body content), in addition to (not instead of) the per-run summary row.

**5. Other required additions:**
- **Scope-creep control.** The two team IDs approved for this build (Faria, Solimar) must be hardcoded/allowlisted constants in the connector code, checked before any message body is fetched (not just before storage) — fail closed on anything outside the allowlist. Any expansion beyond these two teams, including the separate individual-mailbox phase the plan's own research discusses but does not approve, requires a fresh Asimov and Mason pass before deployment — not a config edit.
- **Don't oversell "Observer" as read-only.** Missive's Observer role is not a documented API access restriction (confirmed against Missive's own docs, `missive-connection-plan.md` Section 7) — the real access boundary is which two mailboxes the seat is a member of, plus the application-side allowlist above. No internal documentation should describe the credential as "read-only via Observer."
- **Pre-existing gap, not unique to this build:** GOVERNANCE.md Rule 4's CCPA scan-list registration has no corresponding artifact anywhere in this codebase yet (checked — none exists for `maintenance_claims` or `operational_notes` either). Not a blocker for this build; flagged for Jarvis as a separate, codebase-wide gap.

## Verdict

**APPROVED WITH REQUIRED ADDITIONS** — not blocked. The architecture matches real outside counsel's Section 5 opinion, Rule 9 is structurally satisfiable by design, and nothing in this connector sends a message or makes a decision (Tier 1). Neo and Q may proceed once the migration and connector code explicitly include all five items above.

**This document's scope is limited to the connector described above.** It does not authorize the AI note-extraction step, any expansion beyond Faria/Solimar, or the individual-mailbox phase — each of those requires its own fresh review when it's actually being built.
