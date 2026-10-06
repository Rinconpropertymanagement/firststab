# LeadSimple Tasks/Workflows — Data Inventory & Content Check

**Status:** Pre-build compliance research, written up as a record after the fact. Nothing in this document authorizes a build. Property Brain does not connect to LeadSimple today — this is the Section 5 (GOVERNANCE.md Rule 4) data-inventory addendum `PROPERTY-BRAIN-ARCHITECTURE.md` §5 and §8(e) require before Oracle may spec a new domain, for the two LeadSimple workflow types that carry applicant/tenant data.

**Written by:** Jarvis (orchestration session), consolidating findings from several live-data research agents run against Rincon's real LeadSimple account on 2026-08-24.

**Why this document exists:** the underlying research was real and ran live against Rincon's actual LeadSimple account, but the findings were only ever reported in a chat conversation — no durable artifact existed anywhere in the project. Asimov correctly flagged this as a verification gap (per GOVERNANCE.md's Integrity Rules — "System of Record First, Comms Second") when asked for final sign-off. This document is that system-of-record artifact, written from the same findings, so the work can be checked later instead of trusted from a transcript.

---

## Scope

Rincon uses LeadSimple only for its **Tasks** and **Workflows** features (called `tasks` and `processes`/`process_types` in LeadSimple's API). Peter confirmed 2026-08-24 that Rincon does not use LeadSimple's Pipelines, Deals, or Contacts-as-CRM features — those are explicitly out of scope and were not researched.

Within Tasks/Workflows, this inventory focuses on the two highest-volume, highest-sensitivity workflow types:
- **"01 Application Screening"** (2,158 process instances) — prospective-tenant data.
- **"002 Delinquency"** (6,772 process instances, the largest workflow of all) — tenant late-payment/collections data.

The other 74 workflow types (Move In/Out, Lease Renewal, Property Onboarding, Insurance Compliance, HOA Violations, Owner Termination, internal HR/accounting, etc.) were inventoried at the account level (workflow list, instance counts, custom-field *definitions* only) but not put through the same record-level content scan, on the judgment that their subject matter is materially lower-risk (operational/logistical rather than applicant- or collections-adjacent). Per Mason's final review (below), any of the 74 that turn out to be built around free-form narrative notes rather than boilerplate/dropdowns should get the same record-level check before their free text ships.

## Methodology

All data was pulled live via LeadSimple's official REST API (`api.leadsimple.com/rest`, documented at `https://api.leadsimple.com/rest/swagger_doc.json`), authenticated with Rincon's own account API key (`LEADSIMPLE_API_KEY`, stored in this project's `.env`, never committed to git). This is Rincon's own sanctioned integration point — the key is issued from LeadSimple's own account settings, not a reverse-engineered or non-public endpoint.

Free text was scanned against this project's existing protected-class term list — `projects/hub/maintenance-history/lib/protected-class-terms.js`, **`TERMS_VERSION = 'protected-class-terms-v1'`** — the same California-expanded list (race, religion, sex, national origin, familial status, disability, source of income, marital status, age, ancestry, citizenship/immigration status, primary language) already used by the email-intake Fair Housing filter and Maintenance History's content check. This is Layer 1 (keyword/pattern) only — Mason's review below notes Layer 2 (AI judgment) has not yet been run against this data and recommends adding it to the ongoing pipeline, particularly for Application Screening's non-boilerplate task text.

**On raw artifacts:** the research agents were deliberately instructed not to write any code or persist any files to the repository — the explicit goal was to determine *whether this data is safe to bring into Property Brain*, and copying real applicant/tenant PII into the project before that question was answered would have pre-empted the review this document is part of. No raw per-record API responses were saved. What is reproducible: the same live account, the same workflow types, and the same term list are all still in place, so this methodology can be re-run at any time to reproduce or spot-check these figures — this is not a one-time, unrepeatable observation.

## Findings

### Application Screening — custom fields
19 defined fields; only 1 is free-text ("Positive Landlord Reference"). Checked across all 2,158 real process instances (100% coverage, not a sample):
- 2,157 of 2,158 (99.95%) contain an identical, repeated boilerplate sentence.
- 1 of 2,158 has different (but still short, templated/operational) wording.
- A separate general "comments" field exists on every case outside the 19 defined fields; used in 2 of 2,158 cases. One mentions a housing-voucher payment method in a routine, operational way (technically touches "source of income," not read as personal commentary).
- **Zero Layer-1 term-list hits** across all 2,158 cases' free-text content.

### Delinquency — custom fields
6 defined fields, none free-text (dropdowns/dates only). Checked across all 6,772 real process instances (100% coverage):
- Blank 100% of the time, no exceptions.
- Same general comments field used in 33 of 6,772 cases; 32 empty, 1 is LeadSimple's own default placeholder text on a system test record.
- **Zero Layer-1 term-list hits.**
- Separately flagged (not a compliance issue): these 6 fields read as unrelated to delinquency — likely a LeadSimple workflow-configuration mismatch, worth Rincon's LeadSimple admin cleaning up.

### Tasks — both workflow types
100% coverage, not a sample. Application Screening's task scan was independently re-run from scratch as a cross-check given the stakes; a rate-limit-related pagination bug was caught and corrected mid-run, and both runs agreed on final numbers.
- Delinquency: 5,347 of 5,347 tasks checked. `description` field is mostly fixed step-template boilerplate (17 distinct wordings sampled across 200 tasks); the only other free-text field is a system-generated auto-send-failure log message, not tenant-authored content. **Zero hits.**
- Application Screening: 15,267 of 15,267 tasks checked. ~70% standard boilerplate, ~20% blank, ~10% minor variation (dates, verification shorthand, property-specific notes — not personal narrative). **Zero hits.**
- No free-text field exists on a task beyond `description` and the auto-send-error log.

### Calls
All 383 calls in the account's full history checked (100 tied to these two workflow types via their linked process). The one field where a person could type free text has never been used, on any call, ever. **Zero hits.** Per this project's standing rule (from the Aircall integration), call audio/recordings/transcripts were never accessed — only text metadata fields were checked; 62 of the 100 relevant calls have a recording attached, its existence was noted, its content was not.

### Notes
LeadSimple's API is confirmed write-only for Notes — there is no endpoint or nested field anywhere that returns existing note content. **Nothing can be exposed through this channel in the current build.** This should be recorded as **excluded, not cleared** — it is not proven safe, it is simply inaccessible today. If LeadSimple ever adds read access to Notes, this entire inventory needs a new pass before Notes are surfaced anywhere in Property Brain.

## Outstanding items before Application Screening free text ships (per Mason's final review, 2026-08-24)

These are pre-launch gates, not blockers to Oracle starting spec work:
1. ~~A human (not just the Layer-1 filter) reads the 3 unread outlier records~~ — **RESOLVED 2026-08-25.** Peter reviewed the 1 non-boilerplate "Positive Landlord Reference" entry and the 2 comments-box entries (including the housing-voucher mention) directly in LeadSimple's own interface. His finding, verbatim: "I found all three fine, nothing that is related to any fair housing issues." No content excluded as a result — all three clear for inclusion as-is.
2. ~~Whether the general "comments" field ships~~ — **RESOLVED 2026-08-25.** Peter confirmed inclusion.
3. ~~A real, non-indefinite retention period~~ — **RESOLVED 2026-08-24: 7 years**, per Peter's direct instruction, applying Rincon's standing company-wide records policy. See Data Inventory section above.
4. Layer 2 (AI-judgment) content review added to the *ongoing* pipeline for Application Screening, not just this one-time Layer-1 pass — particularly for the ~10% "minor variation" task-description bucket. This is a build requirement for Oracle's spec, not something to execute before the spec is written.

## Data Inventory (GOVERNANCE.md Rule 4 / PROPERTY-BRAIN-ARCHITECTURE.md §5 format)

- **`pii_fields`:** Applicant/tenant/owner name, email, phone (nested on every task/process); Application Screening's "Positive Landlord Reference" and general "comments" free-text fields; Delinquency's general "comments" field (currently always empty in practice). No SSNs, bank account numbers, or government IDs found anywhere in any of the 267 account-wide custom field definitions.
- **`agents_with_access`:** none yet — no build exists. When built: the scheduled sync process (LeadSimple API key), Claude (extraction/claim-writing step, per the shared claims pipeline), Hub users holding `reviewer`/`admin` roles for this domain — per Mason's recommendation, Application Screening access should be further restricted to staff with an actual leasing function, not all `reviewer`/`admin` users hub-wide.
- **`privacy_category`:** Applicant and tenant personal data — comparable in sensitivity to the email-intake domain's classification, per PROPERTY-BRAIN-ARCHITECTURE.md §4.
- **`retention_policy`:** **7 years**, per Peter's direct instruction 2026-08-24 — Rincon's standing company-wide records retention policy. **Resolved 2026-08-25:** Peter confirmed this figure was previously set with attorney input (not invented for this build, and not requiring a fresh attorney review), directly addressing Mason's specific request for attorney confirmation on the denied-applicant Application Screening case. Applies to Application Screening and Delinquency claims alike, including denied applicants. This closes the one open item in Mason's written sign-off (`compliance/leadsimple-fair-housing-review.md`).
- **`ccpa_exportable`:** TRUE (expected, matching every other claims-derived table in this schema — confirm at build time).
- **`ccpa_deletable`:** TRUE (expected — redact `claim_text` in place, same mechanism as `maintenance_claims`, preserve citation fields for audit continuity — confirm at build time).
- **RLS:** not yet applicable — no table exists. Required at creation per every other table in this schema.

## Governance status

- **Mason (Fair Housing/legal):** FLAGGED ⚠️ — GO WITH CONDITIONS, 2026-08-24. Full findings in this session's record; summarized in "Outstanding items" above. Five standing conditions on any build spec: reuse the protected-class filter (+ add Layer 2 for Application Screening), citation/no-verbatim-quote discipline, role-restricted access, an explicit retention policy, and this written addendum (satisfied by this document).
- **Asimov (AI governance):** APPROVED TO PROCEED ✅ (2026-08-25, resubmission) — Oracle may begin spec drafting now, in parallel with the two items below. Before Neo/Q build anything: (1) Mason's sign-off must exist as Mason's own written document, not paraphrased here — in progress; (2) the retention period needs actual attorney confirmation for the denied-applicant Application Screening case specifically, not just Peter's internal policy decision — outstanding, Peter's call on whether to pursue this. The completed spec itself must also clear a second Asimov governance pre-check before Neo/Q start building — this document does not substitute for that.
- **Correction to this document's earlier reasoning (per Asimov's review):** Application Screening does not actually trigger PROPERTY-BRAIN-ARCHITECTURE.md §8's narrow "hard disqualifier" clause (that clause is about a claim type's *vocabulary itself* being protected-class-shaped — e.g. a claim type literally about disability status — not about incidentally surfacing protected-class content, which is what happened here with the housing-voucher mention). Asimov still requires full core-level review for this domain, but for the correct reason: the Fair Housing Standard applies to any applicant data full stop, Rule 2's screening-decision-adjacent handling applies given the subject matter, and Rule 5 (disparate impact) is live given the voucher mention. Oracle's spec should cite these, not the disqualifier clause.
