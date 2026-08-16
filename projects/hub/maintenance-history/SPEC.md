# Maintenance History — v1 Build Spec

**Status:** Draft — awaiting Peter's approval before Neo/Q start building. Not a build yet.
**Written by:** Oracle
**Date:** 2026-08-15
**Origin:** Follows the 10-ticket "Property Brain" experiment (`projects/property-brain-experiment/`) — a manual test where 10 real Latchel maintenance tickets were hand-exported and fed to an AI extractor. Result: 80% fully correct, 17% partial, 3% wrong, **0% missed, 0% wrong-source**, graded by a team member against an independently-written answer key sealed before the AI saw anything. This spec is the automated version of that same extraction — same extraction discipline, same output shape, real Latchel API instead of a manual export.
**Governance:** Asimov reviewed this project and cleared a path with six conditions (see "Governance Requirements Traceability" below). This spec is written to satisfy all six. Nothing in this document authorizes a build — Neo/Q start only after Peter approves.

**Built from:**
- `projects/property-brain-experiment/README.md` and its 10 `extractions/*.md` files (read in full — these define what "valuable" looks like: dated event sequences, decisions with stated reasons, a 1–5 outcome ladder, recurrence links, everything cited to a source, "unknown" stated rather than guessed)
- Latchel's real public API documentation — `https://app.latchel.com/api-docs/papi/` (OpenAPI spec, fetched and read directly — not summarized secondhand) and `https://help.latchel.com/` (webhook docs, API key docs)
- This codebase's own established patterns: `supabase/migrations/20260813000003_b2_photo_folders.sql` (AI-parsed-field-with-confidence pattern), `supabase/migrations/20260813000001_lease_tenants.sql` and `20260813000000_security_deposit_leases_extension.sql` (additive-column and data-inventory conventions), `supabase/migrations/20260720000003_foundation.sql` (`audit_log`'s current shape and CCPA redaction convention), `projects/hub/security-deposit/SPEC.md` (the most recent comparable Hub build — same shape of problem: external API + AI extraction + review gate), `compliance/ventura-county-compliance-kb.json` (`topics.fair-housing` — Mason's already-reviewed CA protected-class list), `.env.example` (the B2 read-only-key documentation pattern), and `GOVERNANCE.md` (Rules 4, 5, 9, 10 and the Fair Housing Standard)

**Where this tool will live:** `projects/hub/maintenance-history/` — a new section inside the Rincon Hub, built the same way Insurance Compliance and Security Deposit were: one router file, mounted into `projects/hub/server.js`, reusing the Hub's existing login. No new sign-in screen, no new standalone project.

---

## What This Does

Today, if anyone at Rincon wants to know "what actually happened on this maintenance ticket, what got decided and why, and whether the fix held" — they have to open Latchel and read through a messy timeline by hand. The 10-ticket test proved an AI can do that reading accurately (80% fully right, nothing missed, nothing pulled from the wrong source) when someone manually exports the ticket first. This build removes the manual export step: it connects directly to Latchel (read-only) and automatically keeps a running, searchable history of "what happened, what was decided, whether it held, and whether it's happened before" for every maintenance ticket — available inside the Hub, next to Insurance Compliance and Security Deposit.

It does not make decisions, does not talk to tenants or vendors, and does not touch Latchel's data — it only reads. Every fact it pulls out is clearly labeled as AI-derived until a person confirms it, and anything that touches a sensitive personal topic (health, disability, and similar) is automatically pulled aside so it never quietly becomes part of a maintenance record someone might reference when making a decision about a tenant.

## How It Works

1. **Every night, a connector reads new and updated tickets from Latchel** using a read-only API key (Latchel's real, documented Partner API) — no manual export, no copy-pasting. It only ever asks Latchel for data; it never creates, edits, or cancels anything in Latchel.
2. **Each Latchel ticket gets matched to the existing maintenance record** Rincon already has (the same `maintenance_requests` table already synced nightly from AppFolio). This is additive — it does not replace or duplicate anything already there.
3. **The system reads the ticket's full content** — the structured details (dates, vendor, cost, status) plus any attached files (vendor reports, invoices, inspection notes) — and pulls out four kinds of facts, matching exactly what the 10-ticket test proved valuable:
   - **What happened** — a dated timeline of events
   - **What was decided, and why** — who made a call, what they said the reason was, any dollar/scope limit attached
   - **Whether it held** — the same 1-to-5 confidence ladder the test used (vendor says done → something objective confirms it → resident confirmed it → nothing came back → verified by a later inspection)
   - **Whether this has happened before** — a link to an earlier related ticket, when one can be identified
   Every single fact is stored with exactly where it came from (which ticket, which document, which line) — never a summary with the source stripped off, the same discipline that got the test to 0% "wrong source."
4. **Before anything is saved, it's screened for sensitive personal content** — health conditions, disability, familial status, source of income, and the other legally protected topics. If a fact touches one of these (the test itself turned up a real example — a vendor's report that said "Tenant is complaining of health concerns"), it's automatically set aside into its own separate, clearly-labeled queue instead of the regular ticket history, and the fact that something was set aside gets logged. It is never silently deleted and never silently included.
5. **Nothing is ever presented as settled fact until a person looks at it.** Every AI-pulled fact is visibly labeled "unreviewed" until someone on the team confirms it, corrects it, or rejects it — the same review-before-trust pattern already used in Insurance Compliance and Security Deposit.
6. **A person opens the Hub and sees a ticket's history laid out exactly like the test's own answer sheet** — event timeline, decisions, outcome ladder, related tickets — so what took a team member 10-15 minutes per ticket to write by hand now takes seconds to read and a couple of minutes to check.

## What You'll See

- A new **"Maintenance History"** tile on the Rincon Hub home page, next to Insurance Compliance and Security Deposit. Same login, nothing new to remember.
- Opening a property or a specific maintenance ticket shows its history laid out in four sections — **What Happened** (dated timeline), **Decisions** (who decided what and why), **Outcome** (a plain 1-5 strength-of-evidence indicator, e.g. "vendor says fixed" vs. "confirmed by a later inspection"), and **Related Tickets** (earlier tickets on the same problem, if any were found).
- Every fact shows a small "source" tag (which document or ticket it came from) and, until someone checks it, an "unreviewed" label. A person can mark a fact confirmed, correct it, or reject it in one click — it then shows as reviewed.
- A separate, clearly marked **"Needs privacy review"** queue — visible only to admins/reviewers — listing anything the system set aside because it touched a protected topic (health, disability, etc.). This is not shown in the normal ticket history.
- Nothing in this tool ever creates, edits, or sends anything in Latchel, AppFolio, or to a tenant or vendor. It only ever reads and displays.

## What Could Go Wrong

- **Confirmed 2026-08-15 against live data: the richest content (the short human notes — "I want this redone," "Correct SP" — that made decisions traceable in the 10-ticket test) is genuinely not reachable through Latchel's documented API, anywhere.** Real read-only `GET` calls against the two tickets that contain these exact notes (17432-1, 17537-1) checked the Job object, the state-history endpoint, and the file list — none carry it, and neither does any other documented endpoint (there is no `/tasks`, `/notes`, or `/activity` endpoint at all). This is no longer an open risk to confirm — it is a known, permanent limitation of the automated version, accepted and planned for (see "Live API Verification" below). The "Decisions" section will capture decisions that leave a trace in a structured field or an attached file (a budget approval with a note, a vendor's invoice/estimate narrative, a scope edit visible as a diff between nightly syncs) but will not capture terse internal PM notes attached to a vendor-reassignment, reschedule, or cancellation action — those exist only inside Latchel's own internal UI timeline. Peter should expect this gap going in, not be surprised by it later.
- **Latchel's API key is not read-only at the credential level, unlike the B2 photo key.** Every option the documented API exposes is a single account-wide key with full read *and* write access — there's no visible way to generate a key that Latchel itself restricts to reading. This build's read-only guarantee has to be enforced in Rincon's own code (the connector only ever calls "get" endpoints, never "create/update/delete") rather than guaranteed by Latchel the way the B2 key guarantees it. That's a real, weaker guarantee and needs Sentinel and Peter to both sign off on accepting it, or Latchel support needs to confirm a scoped-key option exists that isn't in the public docs.
- **A wrong match between a Latchel ticket and the wrong Rincon property/unit would put one tenant's maintenance history under another tenant's record.** This is exactly the kind of error the B2 photo-matching tool already solved with a confidence score and a manual-review queue for anything uncertain — this build reuses that same solved pattern rather than risking a fresh mistake.

## Known Limitation — CCPA Deletion Is a Manual Step for This Table

If a tenant asks for their data deleted, the extracted facts (`maintenance_claims`, described below) can be redacted — but because a fact is a sentence of free text, not a clean "tenant ID" field, the system can't automatically and reliably find every fact that mentions a specific person by name. Fulfilling a real deletion request means a person looks up which maintenance tickets belonged to that tenant's unit/lease (already possible today) and redacts the related facts by hand. This is the same kind of accepted, documented trade-off as the Security Deposit tool's B2-photo limitation — flagged here so it's a known decision, not a surprise later.

---

## Governance Requirements Traceability

Asimov's review set six conditions before this can go to Neo/Q. Each is addressed below, with a pointer to where.

1. **Read-only, narrowly-scoped credential** → see "Latchel API — What's Actually There" and "What Could Go Wrong" above. Partially satisfied: scoped to this tool, documented like the B2 key, but *not* cryptographically read-only the way B2 is — flagged as an open item needing Sentinel/Peter sign-off or a direct answer from Latchel.
2. **Data-inventory entry matching the established pattern** → see "Data Model" below, written in the exact `pii_fields` / `agents_with_access` / `privacy_category` / `retention_policy` / `ccpa_exportable` / `ccpa_deletable` shape used in the last four migrations.
3. **RLS locked down by default** → every new/changed table below: enabled, no permissive policies, same as every table in this schema.
4. **Content-check for protected-class-adjacent language** → see "The Content Check" below — a two-layer design (keyword scan + model judgment), a quarantine queue, and an audit-log entry for every exclusion, per GOVERNANCE.md Rule 9.
5. **CCPA delete handling** → see "Data Model" (`ccpa_deletable` per table) and "Known Limitation" above, per GOVERNANCE.md Rule 10.
6. **Logs through `audit_log`** → see "Audit Logging" below, written against `audit_log`'s current real columns, with an explicit flagged dependency on Neo's in-progress hash-chain/privacy-category upgrade.

---

## Latchel API — What's Actually There

Real, public documentation exists and was read directly (not guessed at): `https://app.latchel.com/api-docs/papi/papi.yaml` (the actual OpenAPI spec) plus Latchel's help-center articles on API keys and webhooks.

**Base URL:** `https://papi.latchel.com/v1` (production). A separate sandbox exists at `https://latchel-demo.com/v1` with its own key — useful for Q to test against before touching real data.

**Auth:** A single API key per Latchel account, generated by a Property Manager in Latchel's own dashboard (Account Settings → Integrations → API Key). Sent as an `x-api-key` HTTP header on every request. **There is no documented option to generate a scoped-down or read-only key** — one key, full account access, full read/write. See "What Could Go Wrong" above for how this build compensates.

**Rate limit:** 600 requests per API key per 10 minutes, with `x-ratelimit-limit`/`x-ratelimit-remaining` response headers and a 429 + `Retry-After` when exceeded. For a nightly batch pull across a 150–500 unit portfolio, this is not a real constraint.

**Relevant read endpoints (confirmed from the real spec):**
- `GET /jobs` — list tickets, filterable by `created_at_start_date`, `created_at_end_date`, `updated_at_start_date`, `updated_at_end_date`, `in_states` — exactly the incremental-pull filter this build needs for a nightly "what changed since last run" query, the same shape `sync.js` already uses for AppFolio.
- `GET /jobs/{job_id}` — full ticket detail (state, dates, budget/estimate, `estimate_note`, urgency flags).
- `GET /jobs/{job_id}/history/state` — the state-change timeline (timestamps + state only, per the documented schema — no note text attached, see the risk flagged above).
- `GET /jobs/{job_id}/files` — attached files (vendor reports, invoices, photos), each with a time-limited download link.
- `GET /invoices` / `GET /invoices/{invoice_id}` — invoice amount, number, vendor, linked file.
- `GET /properties`, `GET /tenants`, `GET /vendor-companies` — reference data, each carrying a `ref_property_id`/`ref_user_id`-style field that appears designed to point back to the source PM system's own ID (confirmed present on Property; not confirmed yet whether Job has an equivalent field — see "Open Items").

**Webhooks — real, documented, and genuinely a candidate for a later phase:** Latchel supports webhook subscriptions on Job, Property, Resident, Invoice, File, and Owner, firing on create/update, with a documented JSON payload (`object_type`, `event`, `object`, `updated`, plus `x-api-key`/`secret` verification). This is a real option, not a maybe. **This spec still recommends nightly polling for v1, not webhooks**, for reasons laid out under "Ingestion Approach" below — webhooks stay a well-scoped, no-rebuild-needed upgrade for later.

**What the documented API does *not* clearly expose:** a dedicated "notes" or "activity log" object — confirmed both by reading every path in the real spec and, now, by real API calls (see "Live API Verification" immediately below). The short staff notes visible in the 10-ticket test's manually-exported PDFs (e.g., "I want this redone," "Correct SP") don't map to any field in the documented schema at all. `estimate_note` (Job) is real and does carry genuine text, but only in the narrow case where Latchel's own budget-approval workflow was used. The rich narrative content in the test (vendor diagnostic reports, e.g. the "Tenant is complaining of health concerns" line) lived inside **uploaded PDF files attached to invoices**, not in a queryable text field — meaning this build has to actually open and read those attached files (reusing the PDF-extraction approach already proven in `projects/hub/insurance/extract-policy.js`, which already uses `pdf-parse` + Claude), not just read the structured JSON.

---

## Live API Verification (2026-08-15) — Resolves Open Items #1, #2, and #4

Real, read-only `GET` calls (no `POST`/`PUT`/`PATCH`/`DELETE` was made anywhere in this pass) were made against Rincon's live, production Latchel account for four of the ten 10-ticket-test work orders — chosen to include the two tickets whose manual extractions captured a real, named staff decision-note: **17537-1** ("Correct SP" — Leo O'Gorman reassigning the vendor away from Steve Grantham/United Electric to Andrew Joseph Corse/Corse Electric) and **17432-1** ("I want this redone" — Stephen Kenney ordering PuroClean's re-inspection), plus 17061-1 and 17445-1 (the latter's 2026-07-28 scope-expansion edit). Endpoints used: `GET /jobs`, `GET /jobs/{job_id}`, `GET /jobs/{job_id}/history/state`, `GET /jobs/{job_id}/files`, and one unfiltered `GET /invoices` call (to check field shape only, not tied to a specific ticket).

**A naming correction first.** What the manual extractions call "Latchel work order #" (e.g., `232751-701253`) is not itself a Latchel API field — it's `{pm_id}-{job_id}` concatenated, which is how Latchel's own printable ticket-log export appears to label its header. `pm_id` is documented as "ID referencing the PropertyManager in charge of Job" (a staff/team user ID, not a property ID) — confirmed live, since the same `pm_id` value repeats across many unrelated property addresses, consistent with Rincon having a handful of PM user records in Latchel. The real, path-level `job_id` is the second half of that string (e.g., `701253`) — confirmed by calling `GET /jobs/701253` directly and getting ticket 17061-1 back, correctly.

**Open Item #1 — the staff decision-notes: confirmed absent from every documented read path.**
- `GET /jobs/{job_id}` for all four tickets: no note text anywhere near "Correct SP" or "I want this redone." `estimate_note` was `null` on both 17432-1 (job 713912) and 17537-1 (job 718233) — it's a real field elsewhere in the account (other jobs have it populated with genuine vendor-submitted over-budget justification, e.g. "The system is 40+ years and no repairs should be made. Quote for replacement."), but it's scoped narrowly to Latchel's own budget-approval workflow, which neither of these two notes went through.
- `GET /jobs/{job_id}/history/state`, live, on all four tickets: exactly `updated_at` + `state_id` + `state.name`, nothing else. Job 713912's history shows the exact "Rescheduling Resident" transition timestamped 2026-07-30 20:49 that corresponds to Stephen Kenney's note — the state change is there; the note is not.
- `GET /jobs/{job_id}/files`, live, on all four tickets: file objects carry `classification` (Before Image / After Image / Invoice / Estimate / Miscellaneous), an author, and a time-limited S3 download link — never note text. Job 718233's (17537-1) file list has 8 entries (photos + one invoice PDF) with no record of the vendor swap anywhere.
- **A related, previously-undocumented gap, found by reading every path in the real spec:** there is no `/tasks`, `/notes`, or `/activity` endpoint at all. Latchel's internal "Task" objects — which several of the 10 extractions relied on (17432-1's "Service Provider Suggests Follow Up Work," left Unassigned, is how the manual test learned the mold recheck was dropped; 17111-1's "Invoice Not Received" reminder chain) — are entirely invisible to this API, not just their notes.
- **Conclusion:** these notes live only inside Latchel's own internal activity-timeline UI feature, which is what a human captures by manually exporting/printing a ticket (exactly how the original 10-ticket test got its source PDFs). That feature has no API surface at all. This is a confirmed, permanent gap, not an open question — worth one direct email to `tech@latchel.com` asking if an undocumented activity/notes endpoint exists, alongside Open Item #3's read-only-key question, but no build should wait on that answer.

**Open Item #2 — AppFolio linkage: confirmed present and populated on every job checked.**
- `ref_job_id` ("Reference ID for the Job; use this field to reference the ID of a Job within a 3rd party system") was populated on every one of the 23 real jobs seen in this pass (4 targets + 19 incidental jobs returned by the date-range list calls) — never null.
- Separately, `order_number` ("Mutable identifier for the Job") turned out to exactly equal Rincon's own internal ticket reference in every case checked — `"17061-1"`, `"17432-1"`, `"17445-1"`, `"17537-1"`, and so on — the same numbering already used as the extraction files' own filenames.
- `ref_job_id` is also deterministic, offset by a constant: on all 23 jobs sampled, `ref_job_id` equals `order_number`'s numeric part **plus exactly 172**, no exceptions (e.g. job 701253's `order_number` is "17061-1" and its `ref_job_id` is "17233"; 17061 + 172 = 17233).
- Whether `order_number` or `ref_job_id` is literally sourced from AppFolio's own database can't be proven from the Latchel side alone (that would need an AppFolio-side check), but it doesn't change the matching design: **`order_number` gives an exact, deterministic string match to Rincon's own ticket numbering, live, on every job checked.** This settles Open Item #2 and simplifies Data Model #2 below — no fuzzy match is needed as the primary path.

**Open Item #4 — AppFolio integration:** corroborated. Peter has separately confirmed the two systems are linked; the `ref_job_id`/`order_number` findings above are the API-side evidence of that same linkage.

**One more concrete finding for Q, not previously documented in this spec:** `GET /jobs` and `GET /jobs/{job_id}/history/state` are paginated at **10 results per page**; `GET /jobs/{job_id}/files` at **15**. The nightly sync must follow the `links.next` cursor, not assume a single page.

---

## Data Model

Kept deliberately small and additive — anchored only to the four fact-types the 10-ticket test already proved matter (what happened, what was decided and why, whether it held, whether it recurred), not a speculative mirror of every Latchel table.

### 1. Two new columns on `properties` (existing table — no new data inventory needed, same reasoning as `20260813000000_security_deposit_leases_extension.sql`'s jurisdiction-field addition)

- `latchel_property_id TEXT` — Latchel's own property ID, once matched. Stored as TEXT, matching this schema's existing `appfolio_id` convention, even though Latchel's own API types this as an integer.
- Matching approach: pull `GET /properties`, match each to `properties.appfolio_id`/address the same way any other cross-system reference gets resolved in this schema. Properties change rarely, so this can run as an occasional reconciliation step (reusing the existing "detect new properties needing attention" pattern already in `insurance/router.js`) rather than every night.

### 2. Two new columns on `maintenance_requests` (existing table, already synced nightly from AppFolio — no new data inventory needed, same reasoning)

- `latchel_job_id TEXT` — Latchel's own `job_id`, once matched to this ticket. The join key for everything below.
- `latchel_claims_synced_at TIMESTAMPTZ` — when this ticket's facts were last pulled and extracted, mirroring the exact `deposit_synced_at` pattern already used on `leases` (`20260813000000_security_deposit_leases_extension.sql`) — lets the ingestion job know what's already been processed without a fragile text-matching dedupe step, and lets the UI show "as of [date]."
- **Matching Latchel's `job_id` to the right `maintenance_requests` row — confirmed 2026-08-15 against live data (see "Live API Verification" above): a clean, certain join exists; no fuzzy match is needed as the primary path.** `Job.order_number` (from `GET /jobs/{job_id}`) matches Rincon's own internal ticket-reference numbering exactly, on every one of 23 real jobs checked live, and `ref_job_id` independently corroborates it (offset by a constant +172, no exceptions). Neo should match on `order_number`, cross-checked against `ref_job_id`. The confidence-scored, property-and-date fuzzy match already proven for B2 photo folders (`b2_photo_folders`) is retained only as a defensive fallback for the rare case a job is missing its reference field — not as the expected default path.

### 3. One new table: `maintenance_claims`

One row per extracted fact — not a flat mirror of Latchel's own tables. Mirrors the shape the answer-key template already validated (`projects/property-brain-experiment/answer-key-template.md`): event / decision / outcome / recurrence, each with a source and, where the fact came from free text rather than a structured field, a confidence score.

```
maintenance_claims
  id                            UUID PK
  maintenance_request_id        UUID NOT NULL REFERENCES maintenance_requests(id) ON DELETE CASCADE
                                 -- CASCADE, not RESTRICT: a claim has no meaning without its ticket,
                                 -- same reasoning as insurance_notes → property_insurance.

  claim_type                    TEXT NOT NULL CHECK (claim_type IN ('event','decision','outcome','recurrence'))

  claim_text                    TEXT NOT NULL       -- the fact itself, in plain English
  claim_date                    DATE                -- nullable — not every claim has one clean date;
                                                      -- "unknown" is a legitimate, expected value here,
                                                      -- same discipline the 10-ticket test used

  outcome_level                 SMALLINT CHECK (outcome_level IS NULL OR outcome_level BETWEEN 1 AND 5)
                                 -- populated only for claim_type = 'outcome'; mirrors the test's own
                                 -- 1-5 ladder (work completed -> function restored -> resident confirmed
                                 -- -> no recurrence in window -> verified by later inspection)

  related_maintenance_request_id UUID REFERENCES maintenance_requests(id)
                                 -- populated only for claim_type = 'recurrence'

  source_type                   TEXT NOT NULL CHECK (source_type IN (
                                   'latchel_job_field', 'latchel_state_history',
                                   'latchel_invoice_field', 'latchel_job_file'
                                 ))
  source_reference               TEXT NOT NULL       -- exactly which record, e.g. "Latchel job 6903,
                                                      -- state history entry 2026-07-30" or "Latchel
                                                      -- invoice 304354-231322-2" — mirrors the test's
                                                      -- own [source: ...] citation on every claim

  confidence                    NUMERIC(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1)
                                 -- NULL for claims copied straight from a structured API field
                                 -- (nothing to be uncertain about); set only for AI-derived claims
  extracted_by                  TEXT NOT NULL        -- 'system' for a direct field copy, or a model
                                                      -- version string for an AI-derived claim

  flagged_protected_class       BOOLEAN NOT NULL DEFAULT FALSE
  flagged_category               TEXT                -- free text, not a rigid enum — Mason should be
                                                      -- able to refine categories without a migration

  review_status                  TEXT NOT NULL DEFAULT 'unreviewed'
                                   CHECK (review_status IN ('unreviewed','confirmed','corrected','rejected'))
                                 -- deliberately NO 'auto_indexed' option, unlike b2_photo_folders —
                                 -- see "The Content Check" below for why nothing here ever
                                 -- auto-promotes past a human
  reviewed_by                    TEXT                -- reused verbatim from 20260803000002_reviewer_workflow.sql
  reviewed_at                    TIMESTAMPTZ
  reviewer_notes                 TEXT

  created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Data inventory (GOVERNANCE.md Rule 4):**
- `pii_fields`: `claim_text` — by design, this is where the rich narrative content lives, so it will routinely contain tenant names, health/medical mentions, and other personal detail; treat as the highest-PII-density field this spec creates. `reviewer_notes` — PII-adjacent, same caveat used everywhere else in this schema. `flagged_category` — could indirectly reveal what kind of sensitive topic was discussed.
- `agents_with_access`: Claude (existing `ANTHROPIC_API_KEY`) for extraction and protected-class flagging; the nightly ingestion cron (system, service-role key); Hub users holding the `reviewer` or `admin` role for `tool='maintenance_history'`.
- `privacy_category`: Maintenance-history record; may include health-adjacent free text — flagged as more sensitive than most existing tables in this schema, precisely because that's the content this tool exists to capture.
- `retention_policy`: PLACEHOLDER pending Mason — same explicitly-allowed placeholder pattern as `security_deposit_cases`, `lease_tenants`, and `b2_photo_folders`.
- `ccpa_exportable`: TRUE.
- `ccpa_deletable`: TRUE, via targeted redaction of `claim_text`/`reviewer_notes` to `"[REDACTED]"` (same convention as `audit_log.details` and `security_deposit_cases.reviewer_notes`), preserving `claim_type`/`claim_date`/`outcome_level`/`source_reference` for audit continuity. See "Known Limitation" above for why finding the right rows is a manual, not automated, step in v1.

**RLS:** enabled, no permissive policies — matches every other table in this schema.

**Deliberately not built:** a versioned confidence-threshold config table (the pattern `b2_photo_folders` uses via `b2_match_confidence_config`, required by Rule 5 *because* crossing that threshold lets a match skip human review entirely). Nothing in this design ever skips review based on confidence — every claim reaches a human regardless of score, so there's no "decision the threshold makes" in the Rule-5 sense yet. Confidence here is a sort/triage signal only. If a later phase ever adds an auto-accept tier, that is when a versioned config table becomes required, not before.

### 4. One new view: `maintenance_claims_decision_safe`

```sql
CREATE VIEW maintenance_claims_decision_safe AS
SELECT * FROM maintenance_claims
WHERE flagged_protected_class = FALSE
  AND review_status != 'rejected';
```

Any future feature that summarizes, searches, or reasons across maintenance history (recurrence detection, a portfolio-wide dashboard, anything) reads from this view, never the base table directly — makes "don't use flagged or rejected content" the easy default instead of something every future query has to remember.

### 5. `team_member_tool_roles` extension

Add `'maintenance_history'` to the existing `tool` CHECK constraint (same DROP-then-ADD pattern already proven in `20260803000002_reviewer_workflow.sql`). Reuse the existing `'admin'` role as-is. One new role recommended: `'reviewer'` — whoever checks unreviewed/flagged claims. Exactly who gets that role is Peter's call, same as `pod_lead` was left to him for Security Deposit.

---

## The Content Check (Governance Requirement #4)

Two layers, both running before a claim is ever saved:

**Layer 1 — keyword/phrase scan (deterministic, fast, cheap, auditable).** A maintained list of protected-class-indicator terms, built from sources already vetted in this codebase rather than invented fresh: GOVERNANCE.md Rule 9's ten categories, plus the California-specific expansions already researched and Mason-reviewed in `compliance/ventura-county-compliance-kb.json` (`topics.fair-housing` — adds marital status, age, ancestry, genetic information, source of income/vouchers, citizenship/immigration status, primary language), plus practical health/medical/disability terms (the category the real test example fell into). This list lives as a maintained code asset (e.g. `projects/hub/maintenance-history/lib/protected-class-terms.js`), reviewable and editable by Mason the same way GOVERNANCE.md itself is a maintained, owner-approved document — not a database config table, since this is a reference taxonomy, not a numeric decision threshold.

**Layer 2 — the extraction step's own judgment (defense in depth).** Since Claude already reads the source text to produce claims, the same extraction prompt is instructed to flag anything protected-class-adjacent it notices even when no listed keyword matches — catching subtler phrasing a fixed list would miss.

A hit on *either* layer sets `flagged_protected_class = TRUE` and records `flagged_category`. Flagged claims are:
- **Never deleted** — dropping data silently would break the same "0% missed" standard the original test was graded against.
- **Excluded from `maintenance_claims_decision_safe`** — structurally unavailable to any decision-relevant read path.
- **Routed to a separate "Needs privacy review" queue**, visible only to `reviewer`/`admin` roles, distinct from the normal per-ticket claims view.
- **Logged to `audit_log`** at the moment they're flagged (see below) — satisfying GOVERNANCE.md Rule 9's "log the exclusion" requirement directly. The log entry references the claim by ID rather than duplicating the flagged text itself into yet another table.

## Audit Logging (Governance Requirement #6)

Written against `audit_log`'s real, current columns (`id`, `action`, `entity_type`, `entity_id`, `performed_by`, `details`, `created_at` — confirmed from `20260720000003_foundation.sql`, not assumed):

- **Every nightly ingestion run, per ticket touched:** `action = 'maintenance_claims.ingestion_run'`, `entity_type = 'maintenance_request'`, `entity_id` = the ticket's ID, `details = { claim_ids, claim_types, source_files_read }`.
- **Every protected-class exclusion:** `action = 'maintenance_claims.protected_class_excluded'`, `entity_type = 'maintenance_claim'`, `entity_id` = the claim's ID, `details = { flagged_category, matched_layer, claim_type, source_reference }` — deliberately not the flagged text itself.
- **Every human review action:** `action = 'maintenance_claims.reviewed'`, `entity_type = 'maintenance_claim'`, `entity_id`, `performed_by`, `details = { review_status, reviewer_notes }`.

**Explicit dependency, not a blocker:** Neo is separately upgrading `audit_log` with a tamper-evident hash chain and privacy-category tagging. This spec is written against today's stable columns on purpose, since the upgrade's exact final column names aren't set yet. Once it lands, these entries should also populate `privacy_category` (the protected-class-exclusion entries especially) and whatever else becomes mandatory — flagged here as a known follow-up for whoever builds this, not something v1 should wait on.

---

## Ingestion Approach

**Nightly polling, not webhooks, for v1** — a real decision, not a default. Latchel's webhooks are real and well-documented (see above), and were seriously weighed:

*For webhooks:* lower latency, less redundant polling, exactly the objects this build needs (Job, Invoice, File) are covered.

*For polling (the choice made):* maintenance-history facts are retrospective — "what happened, what got decided" — not time-critical the way Security Deposit's 21-day legal countdown is, so sub-daily freshness buys nothing real today. A public inbound webhook receiver is new attack surface (signature verification, replay protection, a new Sentinel review) that a nightly outbound call using a credential Rincon already controls simply doesn't create. Webhook delivery has no documented delivery guarantee — without a polling reconciliation pass as a backstop, a silently-dropped webhook could reintroduce exactly the "missed" failure mode the original test scored 0% on. And polling matches this codebase's own proven pattern exactly (the nightly AppFolio sync), which means less new infrastructure to review and less new risk — directly in line with Peter's own "simple is better than clever" standing rule.

**v1 pipeline, nightly, mirrors the existing internal-cron pattern exactly** (`insuranceInternalRouter`/`securityDepositInternalRouter` — a shared-secret header route registered before `requireLogin`, reusing the existing `CRON_SECRET`):

1. Pull every Latchel `Job` updated since the last run (`GET /jobs?updated_at_start_date=...`), paginated.
2. Match each Job to its `maintenance_requests` row (see Data Model #2 above).
3. Pull that Job's state history and any new/changed files.
4. For new files: download, extract text (PDF via the same `pdf-parse` + Claude approach already proven in `insurance/extract-policy.js`), then **discard the downloaded bytes — never store the file itself**, same restraint already applied to B2 photos (no `photo_bytes` column exists there; no file-bytes column exists here either).
5. Feed the structured fields + state history + extracted file text to a Claude extraction step. **The prompt must preserve the original experiment's two hard rules** — cite a source for every claim, say "unknown" rather than guess — since those two rules are the reason the original test hit 0% missed and 0% wrong-source; they are not incidental style.
6. Run the content check (above) on every candidate claim before insert.
7. Insert claims; update `maintenance_requests.latchel_claims_synced_at`.
8. Write the audit log entries (above).

**Webhooks are a real, well-scoped Phase 2 option**, not a maybe — if nightly freezes prove too slow in practice, adding a webhook receiver later is additive (it would feed the same extraction pipeline, matching table, and content check built here), not a redesign. Deferred, not blocking v1, same treatment the Security Deposit spec gave automatic AppFolio attachment retrieval.

## Review Gate (Governance Requirement #3)

Every AI-derived claim is visible immediately in the ticket view (hiding it would defeat the point — the tool exists to replace manual digging) but is always labeled with its `review_status` and, where relevant, its confidence score — never presented as settled fact until a person acts on it. This mirrors exactly how Security Deposit shows missing-evidence flags as warnings rather than hiding them, and how B2 photo matches show their confidence score rather than suppressing low-confidence ones. The ticket-history screen itself should mirror the answer-key template's own four-part shape (event sequence / decisions / outcome ladder / related tickets) — that shape is already proven to be reviewable in under 2 minutes per ticket by the original test's own pre-committed success threshold, so there's no reason to invent a new layout.

---

## What Neo/Q Need to Build This

- **A read-only-in-practice Latchel API credential** (`LATCHEL_API_KEY`, documented in `.env.example` the same way the B2 key is — including the honest caveat that this is enforced in code, not by Latchel, unless Latchel support confirms otherwise). Generated by Peter (or whoever holds the Latchel PM login) via Latchel's own dashboard — a manual, one-time step, not something Q automates.
- **Neo:** the two additive columns on `properties`, the two additive columns on `maintenance_requests`, the new `maintenance_claims` table, the `maintenance_claims_decision_safe` view, and the `team_member_tool_roles` CHECK-constraint extension — all detailed above.
- **Q:** a Latchel connector module scoped to this tool (e.g. `projects/hub/maintenance-history/lib/latchel-connector.js`, mirroring exactly how the Security Deposit AppFolio connector was scoped locally rather than shared, for the same reason — no second consumer exists yet); the nightly ingestion job; the extraction step (reusing the `pdf-parse` + Claude pattern from `insurance/extract-policy.js`); the content-check module; the Hub router (`projects/hub/maintenance-history/router.js` + `internalRouter`, mounted into `server.js` exactly like the other two tools); the review-queue and privacy-review-queue routes.
- **Tron:** the ticket-history view (four sections, per "Review Gate" above) and the two queues (unreviewed claims, privacy-flagged claims) — same visual/interaction language as the other two Hub tools.
- **New environment variable:** `LATCHEL_API_KEY`.
- **A live discovery pass — partially done.** Open Items #1, #2, and #4 were confirmed against Rincon's real Latchel account on 2026-08-15 (see "Live API Verification" above): the notes gap is real and permanent, the AppFolio-style join is clean and certain, and pagination is confirmed at 10-15 results/page depending on endpoint. Still open before a full build: Open Item #3 (the read-only-key question — needs a direct answer from Latchel, not another API call), confirming the same `order_number` matching pattern holds across a larger sample than the 23 jobs checked here, and a first real run of the nightly pull against the full 150–500 unit portfolio to confirm rate-limit and pagination handling at that volume.

---

## Scope

**In v1:** nightly read-only ingestion from Latchel; matching to existing `maintenance_requests`; four-type claim extraction (event/decision/outcome/recurrence) from structured fields and attached files; the two-layer content check with quarantine and audit logging; the human review gate; the Hub UI described above.

**Explicitly out of v1:** anything that writes to Latchel; anything that sends a message to a tenant or vendor; any automated decision-making based on extracted claims (this is a history/reference tool, not a decision tool); webhooks (deferred, see above); resident-email content (the original 10-ticket test combined Latchel export *and* separate email — this spec covers the Latchel connection only; email is a different integration, not addressed here).

## Open Items — Needs Confirming Before Neo/Q Build

1. **RESOLVED 2026-08-15, against live data.** No — the real Latchel API does not expose the short staff/decision notes seen in the 10-ticket test's manual export (e.g., "I want this redone," "Correct SP"). Confirmed by real read-only `GET` calls against the Job object, state history, and file list for the two tickets that contain these exact notes (17432-1, 17537-1), plus a full read of every path in the real spec (no `/tasks`, `/notes`, or `/activity` endpoint exists at all). These notes live only inside Latchel's own internal UI timeline, which has no API surface. This is now a known, permanent limitation — see "Live API Verification" above and the updated "What Could Go Wrong" above for what the automated version can and can't capture as a result.
2. **RESOLVED 2026-08-15, against live data.** Yes — `Job.ref_job_id` and `Job.order_number` both carry a clean cross-reference on every one of 23 real jobs checked, live. `order_number` matches Rincon's own internal ticket numbering exactly; `ref_job_id` is the same numbering offset by a constant +172. Ticket-matching is a clean, certain join, not a fuzzy match — see "Live API Verification" above and the updated Data Model #2 above.
3. **Does Latchel offer any scoped-down or read-only API key option not shown in the public docs?** Still open — worth a direct email to Latchel (`tech@latchel.com`, the contact listed in their own API spec) before accepting the account-wide-key trade-off as final. Not testable via API calls; needs a direct answer from Latchel. Worth asking the same contact about a notes/activity endpoint at the same time, per Open Item #1's resolution above.
4. **RESOLVED.** Rincon's Latchel account is integrated with AppFolio — confirmed by Peter directly, and corroborated by the `ref_job_id`/`order_number` findings above, which are exactly the kind of cross-system reference field that integration would produce.

## Size Estimate

Comparable in scope to the Security Deposit build — the most recent, most similar Hub addition (external API connector + AI extraction with confidence + review queue + audit logging + a new Hub section). Two things make this one somewhat larger: the claims model is a genuinely new concept (Security Deposit's tables mostly mirror existing AppFolio fields; this one invents a small new fact-schema) and the content-check mechanism has no precedent yet in this codebase to reuse (Fair Housing checks so far have all been on tenant-facing *output*, not on scanning inbound data). Offsetting that: the core question of "can AI extract this accurately" is already answered by the 10-ticket test, so there's no extraction-quality risk left to discover during the build, only the pipeline and safeguards around it. The live API verification above also removed one piece of build-time uncertainty — ticket-matching is now known to be a clean join, not fuzzy-match logic that would have needed its own discovery and testing — a small reduction, not a change in the overall size category.

Rough shape, same specialist-sequenced pattern as every other build in this codebase (not calendar days): Neo — 1-2 sessions for the schema (smaller than Security Deposit's four-migration schema). Q — 3-4 sessions (connector, nightly job, extraction pipeline, content check, routes — the single largest piece is the file-extraction + claims pipeline). Tron — 1-2 sessions (the review-queue pattern is now proven twice, so this is mostly reuse). TARS/Ralph/Viper/Sentinel/Mason/Judge/Asimov — a full gate pass comparable to Security Deposit's own, likely a bit heavier on Mason/Sentinel specifically because of the content-check and the weaker credential guarantee. Overall: the same order of magnitude as Security Deposit, on the larger side of that comparison, not a bigger category of build.

---

*Sources for the Latchel API research above: [Latchel Partner API Documentation](https://app.latchel.com/api-docs/papi/) (OpenAPI spec, fetched directly), [How to Generate an API Key](https://help.latchel.com/s/topic/0TO5e000000h9wqGAA/How-to-Generate-an-API-Key), [The Webhook Subscription](https://help.latchel.com/s/topic/0TO5e000000h9wqGAA/The-Webhook-Subscription), [Latchel Webhooks Payload Format](https://help.latchel.com/reference/payload-format), [How Latchel Integration Works](https://help.latchel.com/s/topic/0TO5e000000h9wqGAA/How-Latchel-Integration-Works).*
