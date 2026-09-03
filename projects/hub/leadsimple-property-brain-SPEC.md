# LeadSimple Tasks/Workflows → Property Brain — Domain Build Spec

**Status:** Draft spec. **Nothing in this document authorizes a build.** This spec must clear a **second, spec-level Asimov governance pre-check** — separate from and in addition to the pre-check already applied to the underlying data inventory — before Neo or Q may build anything against it.

**Updated 2026-08-25:** the two items originally gating that pre-check request are now closed — Mason's standalone written sign-off exists at `compliance/leadsimple-fair-housing-review.md`, and Peter closed the retention question (7 years, previously attorney-advised policy, no fresh review needed). The `comments`-field scope question is also resolved (included). One item remains before the governance pre-check should be requested: a human read of the 3 outlier free-text records (Open Items list, #4) — in progress.

Until the pre-check passes, this document is research and design only, exactly like `PROPERTY-BRAIN-ARCHITECTURE.md` before it.

**Written by:** Oracle
**Date:** 2026-08-24
**Origin:** Asimov approved spec drafting to begin now (2026-08-25 resubmission, recorded in the data-inventory doc's Governance status section), in parallel with the two items above — spec work does not wait on them, but a build does.

**Built from, read in full:**
- `compliance/leadsimple-tasks-workflows-data-inventory.md` — the Rule 4 data-inventory addendum this domain requires before Oracle specs it. Real, live-account findings (100% coverage on both Application Screening's 2,158 cases and Delinquency's 6,772 cases), Mason's GO WITH CONDITIONS review, Asimov's approval and its correction of the earlier reasoning (below).
- `projects/hub/PROPERTY-BRAIN-ARCHITECTURE.md` in full — the platform this spec plugs into. Section 1 (the shared `claims` table + `claim_type_registry`), Section 2 (the Stage 0→3 pipeline shape and the reusable content-check discipline), Section 3 (the shared safety-layer architecture), Section 4 (retention/access tiers), Section 8 (governance scaling — Core vs. Incremental).
- `supabase/migrations/20260816000000_property_brain_claims_phase1.sql` — the actual, live shape of `claims` / `claim_type_registry` / `claims_decision_safe`. Phase 1 is already built and Asimov-cleared; this spec builds on what's real.
- `projects/hub/maintenance-history/lib/protected-class-terms.js`, `content-check.js`, `extract-claims.js` — the working, tested extraction/content-check discipline (cite-everything, say-unknown-not-guess, human-review-gate, Layer 1 keyword + Layer 2 model self-check) this domain's extractor must follow, not reinvent.
- `supabase/migrations/20260812020000_shared_team_members.sql`, `20260813000004_security_deposit_team_roles.sql`, `20260815010000_maintenance_history_schema.sql` (its `team_member_tool_roles` extension) — the live, proven pattern for adding a new Hub tool's access roles.
- `GOVERNANCE.md` — Rules 2, 4, 5, 6, 9 and the Fair Housing Standard (Rules 1–8), cited by number below rather than restated in full.

---

## 0. Governance Track: Core, Not Incremental — and Why

`PROPERTY-BRAIN-ARCHITECTURE.md` §8 describes two review tracks for a new domain: a full **Core** review (comparable in weight to Maintenance History's original six-condition review) and a lighter **Incremental** track for a domain that reuses the shared pipeline without changing it. This is the first domain built against this architecture other than maintenance, and it goes through **Core**, for three specific reasons — none of which is §8's narrow "hard disqualifier" clause:

1. **The Fair Housing Standard applies to any applicant data, full stop.** Application Screening claims are about prospective tenants. That alone puts this build under `GOVERNANCE.md`'s Fair Housing Standard regardless of how narrow the claim vocabulary is kept (Section 2 below).
2. **Rule 2's screening-decision-adjacent handling is live**, because this domain stores facts about a screening process even though — by design (Section 2) — it never makes or characterizes the decision itself.
3. **Fair Housing Standard Rule 5 (disparate impact)** is live given the real housing-voucher mention already surfaced in the data inventory's comments-field scan — a facially neutral field can still carry protected-class-adjacent content, and this domain has already proven it does, at least once. (Naming this explicitly per Asimov's spec-level review, 2026-08-25 — not to be confused with GOVERNANCE.md's core Rule 5, "Criteria Must Be Versioned," which doesn't apply here since this domain has no scoring criteria by design.)

Separately, and independent of the three reasons above: **this domain needs claims to point at applicants and tenants, not just properties and maintenance tickets** — a subject-linking question the architecture doc's §1.5 flagged as the concrete trigger for revisiting the `entities` abstraction. Section 3 below addresses this without building `entities` yet, but the fact that the question is live at all is itself evidence this isn't a same-shape-as-maintenance Incremental add.

**Correction inherited from Asimov's own review, restated so it isn't re-litigated:** §8's "hard disqualifier" is about a claim type's *vocabulary itself* being protected-class-shaped (a claim type literally about disability status, for example) — not about a domain that might incidentally surface protected-class content, which is what actually happened here (the voucher mention). This domain does not trigger that clause. It still requires full Core review, for the three reasons above.

---

## 1. Scope

Three `domain` values, at two different levels of rigor — stated honestly rather than presented as uniform:

| Domain | Coverage this spec is built on | Rigor |
|---|---|---|
| `leadsimple_application_screening` | 2,158 process instances, 15,267 tasks, 100% record-level content-scanned | Full |
| `leadsimple_delinquency` | 6,772 process instances, 5,347 tasks, 100% record-level content-scanned | Full |
| `leadsimple_operations` | The other 74 LeadSimple workflow types — Move In/Out, Lease Renewal, Property Onboarding, Insurance Compliance, HOA Violations, Owner Termination, internal HR/accounting, etc. | **Account/definition level only** — workflow list, instance counts, custom-field *definitions*. **Not record-level content-scanned.** |

The third row is not a smaller version of the first two — it is a materially different, lighter research basis, and this spec does not pretend otherwise. Per the data-inventory doc's own scope note: any of these 74 that turn out to be built around free-form narrative notes (rather than boilerplate/dropdown/date fields) needs the same record-level scan Application Screening and Delinquency already got, **before** its free text is ever extracted. Section 2 and Phase 4 (Section 10) build that gate into the domain's design rather than leaving it as a promise.

Out of scope, unchanged from the data inventory doc: LeadSimple's Pipelines, Deals, and Contacts-as-CRM features (Rincon doesn't use them); Notes (API is write-only — excluded, not cleared, per that doc's own framing); call recordings/audio (never accessed, per the standing Aircall-integration rule).

---

## 2. Claim-Type Vocabulary — Structured Facts Only, No Characterization

**Asimov's hard constraint, restated as an enforceable list, not a prose guideline:** a claim type for either full-rigor domain may only represent a verbatim structured fact of record. No claim type may infer, score, characterize, or recommend toward an approval/denial/collections outcome. `claim_type_registry`'s existing fail-closed foreign key (`claims.domain, claims.claim_type` → `claim_type_registry`) is what makes this enforceable at the database level, not just in a prompt — an extraction attempt using anything outside this list is rejected outright, the same protection `claim_type_registry` already gives the four maintenance types.

### `leadsimple_application_screening` and `leadsimple_delinquency` — identical vocabulary, registered separately per domain

| `claim_type` | What it records | Example `claim_text` |
|---|---|---|
| `stage_entered` | The process currently sits in a named stage, as of the pull date. The stage name is LeadSimple's own — a human made this call inside LeadSimple; the claim records that they did, not why. LeadSimple does not expose when a process entered its current stage — no history/timeline endpoint exists, and the Stage object's own `updated_at` reflects when that stage *definition* was last edited account-wide, not when this process moved into it — so `claim_date` is `null` for this claim type, following the extractor's existing say-unknown-rather-than-guess discipline rather than using a misleading field. | "Process currently in stage 'Approved' (as of 2026-08-25 pull)." |
| `task_completed` | A named task on the process was marked complete on a date. | "Task 'Verify employment' marked complete on 2026-05-28." |
| `task_skipped` | A named task was marked skipped/not applicable on a date. | "Task 'Call previous landlord' marked skipped on 2026-05-29." |
| `field_recorded` | A custom field's value as recorded on a date — field name plus value. For the two free-text fields (`Positive Landlord Reference` on Application Screening, the general `comments` field on either domain), the value is a **distilled paraphrase**, never a verbatim quote — see Section 4. | "Field 'Positive Landlord Reference' recorded a positive, boilerplate reference on 2026-04-11." |

Four types, registered twice (`(leadsimple_application_screening, stage_entered)`, `(leadsimple_delinquency, stage_entered)`, etc.) — eight rows total, mirroring how the four proven maintenance types are already one domain's worth of registry rows.

**What is deliberately absent from this list, on purpose:** any claim type resembling `screening_recommendation`, `risk_score`, `applicant_summary`, `collections_priority`, or anything that reads the case and produces a judgment. This system is a record of what LeadSimple's own process already shows happened — never a second opinion on it.

### `leadsimple_operations` — the 74-type lighter-touch domain

Same three structural types (`stage_entered`, `task_completed`, `task_skipped`) registered once under `leadsimple_operations`. **`field_recorded` is deliberately NOT registered for this domain in Phase 1** (Section 10) — extraction code must not be able to produce a `field_recorded` claim for any of the 74 types until that specific type gets its own record-level scan and its own registry addition, mirroring exactly how a claim can't be inserted at all without a registered `(domain, claim_type)` pair today. This turns Mason's "any of the 74 needs the same check before its free text ships" condition from a promise into a structural gate: the registry itself won't allow the claim type to exist yet.

---

## 3. Subject-Linking — `property_id` Only, With an Honest Limitation Flagged

`claims` today supports exactly two subject columns: `property_id` and `maintenance_request_id` (`claims_has_a_subject` requires at least one). Neither LeadSimple domain has a maintenance ticket to point at. This spec uses **`property_id` alone** for all three domains:
- Application Screening: the unit being filled.
- Delinquency: the unit the delinquent tenant occupies.
- Operations: whichever property the workflow instance is about, where one exists (some of the 74 — HR/accounting workflows, for instance — may have no property at all; those simply don't get a `claims` row under today's schema, which is a real, accepted limitation, not an oversight).

**What this loses, stated plainly rather than glossed over:** these are fundamentally per-applicant and per-tenant facts, not per-property facts — the architecture doc's own §1.5 named "a tenant-issue domain needing `tenant_id`/`contact_id`" as the concrete trigger for building the `entities` abstraction. This domain is close to that trigger without quite requiring it: a property can have more than one Application Screening case over time (a prior applicant rejected, the unit re-listed), and without a dedicated subject column, distinguishing them relies on `claim_date` and `source_reference` (which will include the LeadSimple process ID) rather than a clean foreign key. This is workable for v1 — a reviewer can tell cases apart by date and process ID — but it is a real trade-off, not a non-issue, and it's flagged here so whoever specs the next domain that needs `tenant_id` (a tenant-issue or lease-renewal domain, per the architecture doc's own Phase 3 options) knows this domain pushed right up against that line without crossing it. No `entities` work is proposed in this spec.

---

## 4. The Comments Field and Free-Text Handling at Ingestion — Not Just This One-Time Check

The data inventory doc's Layer-1 scan already found the risk case this section exists to handle: a comments-field entry mentioning a housing-voucher payment method, in a routine, operational way — technically a source-of-income mention, not personal commentary, but exactly the kind of content the content check exists to catch on the very next entry that isn't so benign. This has to be a standing ingestion-time control, not a one-time finding.

**Design, reusing the existing two-layer content check exactly as built (`content-check.js`), applied to every claim regardless of domain:**

- **Layer 1 — keyword scan (`protected-class-terms.js`).** Runs on every candidate `claim_text` before insert, unchanged from how it already runs for maintenance claims. This is the layer that already scored zero hits across all 2,158 + 6,772 cases — it stays as the deterministic first pass, not a substitute for Layer 2 below.
- **Layer 2 — model self-check, added specifically for Application Screening's free text.** Per Mason's finding that a keyword-only pass is the weakest check for the ~10% "minor variation" task-description bucket (dates, verification shorthand, property-specific notes — the category most likely to drift into something a fixed list wouldn't catch), the extraction prompt for `leadsimple_application_screening` must include the same self-check `extract-claims.js` already asks of the maintenance extractor: for every candidate claim, the model states `protected_class_flag`/`protected_class_category` based on its own reading of the meaning, independent of and in addition to the keyword scan. `content-check.js`'s existing `matched_layer` combination logic (`keyword`, `model`, `keyword+model`) needs no changes — it already handles a domain supplying `modelFlag`/`modelCategory`.
- **Delinquency and Operations get Layer 1 only for now**, matching their materially lower free-text exposure (Delinquency's fields are dropdown/date only in practice; Operations extracts no free text at all per Section 2). If Delinquency's `comments` field usage ever grows past its current near-zero rate, Layer 2 should be added there too — flagged as a future trigger, not built now.

**Resolved 2026-08-25: Peter confirmed the `comments` field ships.** Both layers above apply to it exactly like any other `field_recorded` claim — Neo/Q may build the `comments` extraction path as designed. This closes Open Item 3 below.

**Design resolution (2026-08-25):** Peter pushed back on this section's original design — `claim_text` as a paraphrase with no way to see the real original text — on the grounds that the only staff who'd ever use this tool already have full LeadSimple access, so hiding the original just sends them around the tool to LeadSimple directly. Mason reconsidered and Peter has confirmed the resulting middle path: `claim_text` for `comments` and `Positive Landlord Reference` **stays a distilled paraphrase, unchanged** — the reasoning that made it a paraphrase in the first place (Section 5's Risk B) is unaffected by internal-access questions and still stands. What changes is the citation: it must now support a **direct, one-click link-through** to the actual source record in LeadSimple, so a staff member gets the real text in one click instead of a second search. See Section 5 for the mechanism and live verification.

---

## 5. `source_reference` and `claim_text` Discipline for LeadSimple's Free-Text Fields

`claims.source_reference`'s existing rule — "exactly which record, never a summary with the source stripped off" — already governs every Latchel-sourced claim. The architecture doc's §1.2.1 sharpened that rule further for *email*-derived claims specifically, because an email has a subject line and body that can quietly become an unguarded second copy of sensitive content sitting in a citation column nobody content-checks. LeadSimple's `Positive Landlord Reference` and `comments` fields carry the same structural risk as an email body, even though the source is a structured API, not an inbox — so this spec extends §1.2.1's two rules to these two specific fields by the same reasoning, not because the source_type is email-derived (it isn't):

1. **`source_reference` for a `field_recorded` claim on either free-text field may only contain a structural pointer**: the LeadSimple process ID, the field name, and a timestamp (e.g. `"LeadSimple process 4821 (01 Application Screening), field 'comments', recorded 2026-04-02"`). Never the field's own text content restated as if it were a citation.
2. **`claim_text` must be a distilled paraphrase of what the field establishes — never a verbatim quote**, matching §1.2.1's exact language. "Field 'comments' mentions the applicant's rent will be paid via a housing voucher" is acceptable; reproducing the actual sentence typed into LeadSimple is not.

For every other `field_recorded`, `stage_entered`, `task_completed`, and `task_skipped` claim — all boilerplate/dropdown/date/stage content — `source_reference` follows the plain Latchel-style convention already proven (process ID + field/task name + record type), since there's no free-form content to guard against there in the first place.

**New `source_type` values needed** (Neo, Phase 1, using the same DROP-then-ADD `CHECK`-widening pattern already used three times in this schema): `leadsimple_process_stage`, `leadsimple_task`, `leadsimple_custom_field`.

### Citation must click through to the source record (resolved 2026-08-25)

Per the Section 4 update: keeping `claim_text` paraphrase-only is unaffected, but the citation can no longer be text-only. **The Hub's UI (Tron, Phase 5) must render `source_reference` as an actual clickable link into the specific LeadSimple record it cites — not a plain-text citation a staff member has to go re-search for.**

**Live verification done for this update, against Rincon's real LeadSimple account (not assumed from public docs — LeadSimple's public help center does not document this at all; it had to be checked directly):**

- LeadSimple's REST API (`api.leadsimple.com/rest`, swagger at `/rest/swagger_doc.json`, `Authorization: Bearer <LEADSIMPLE_API_KEY>`) — the `Process` object schema includes a `link` field, described in the swagger doc as *"Link to process in LeadSimple."*
- Confirmed against a real, live record (`GET /processes?per_page=1`): every process returns its own ready-made deep link, e.g. `https://app.leadsimple.com/v2/process-types/{opaque_token}/processes/{opaque_token}`. This is **not** a URL built from the plain `process_id` UUID — LeadSimple encodes it into its own opaque token and hands back the finished URL. Do not construct this URL from `process_id`; capture the `link` field's value verbatim at ingestion time.
- Confirmed the link is real and behaves correctly unauthenticated: an unauthenticated `curl` to that exact URL returns a 302 to LeadSimple's login (`/auth/mmp_id?origin=<the same process path>`), preserving the destination as the post-login redirect target. That's the standard, correct behavior for a deep link into an authenticated app — a staff member who is (or becomes) logged into LeadSimple lands directly on that process, one click, no search. This matches Peter's actual usage assumption: everyone who'd use this tool already has LeadSimple access.
- The nested objects on a process (`stage`, `user`, `process_type`) each carry their own `link` field the same way, in case a future domain wants to cite one of those instead of the process itself — not needed for this spec's four claim types, noted for completeness.

**Mechanism:** deep-linking works, no fallback needed. Capture LeadSimple's `link` value for the process at extraction time and store it alongside the structural citation text already specified above (items 1–2). Whether that's a new column on `claims` or a structured sub-value inside `source_reference` is Neo's call in Phase 1 — this spec's requirement is only that the raw URL survives ingestion and reaches Tron's UI as a real value to put in an `<a href>`, not that Oracle dictates the column.

**A distinction worth naming so a future domain doesn't inherit this pattern uncritically:** this section's original design mechanically extended §1.2.1's email-citation rule (never let source_reference become an unguarded second copy of sensitive text) into a *verbatim-vs-paraphrase* rule for `claim_text` itself. Peter's pushback surfaced that this had conflated two different risks:

1. **Internal access exposure** — does hiding the original text stop someone from seeing it who shouldn't? No, for any domain where every plausible reader of the tool already holds direct access to the source system. This risk doesn't support paraphrase-only `claim_text`, and the one-click link resolves it directly.
2. **A consolidated, discoverable copy** (Section 4's Risk B) — does pulling raw free text into `claims` create one easy-to-search table holding what used to be scattered across thousands of individual LeadSimple records? Yes, independent of who's allowed to read it — that's a real, distinct exposure, and it's what still justifies keeping `claim_text` a paraphrase.

Risk 1 is resolved by a link. Risk 2 is not, and a link doesn't touch it. The next domain that borrows "paraphrase claim_text, cite the source" from this pattern should ask both questions separately rather than assume paraphrase-only follows automatically from citation discipline — it doesn't; they're independent design levers.

---

## 6. Access Control

Mason's condition: Application Screening access restricted to staff with an actual leasing function, not general Hub-wide `reviewer`/`admin`. Recommended the same for Delinquency.

**What's already true, worth stating explicitly:** `team_member_tool_roles` is already scoped per `(team_member_id, tool)`, not Hub-wide — someone holding `reviewer` for `maintenance_history` does not automatically get access to any other tool's claims. That structural isolation already satisfies half of Mason's concern. What it doesn't do on its own is guarantee that whoever *grants* a role for this domain is actually checking for a leasing function, since `reviewer`/`admin` are generic labels reused everywhere.

**Concrete design, following the exact pattern used for `maintenance_history` and `security_deposit`:**

- Two new `tool` values, kept separate from each other (not lumped, since Application Screening and Delinquency are different domains with different — if both sensitive — data profiles): `leadsimple_application_screening`, `leadsimple_delinquency`.
- One new `role` value: **`leasing_reviewer`** — distinct from the generic `reviewer` already used elsewhere, so that granting it is a visibly deliberate act tied to this specific access question, not a reuse of a label that could be handed out without anyone checking "does this person actually do leasing." Paired with `admin` (already an existing value) for full control including managing who else has access, exactly mirroring `pod_lead`'s addition for Security Deposit.
- A person needs an explicit row for `tool='leadsimple_application_screening'` (or `'leadsimple_delinquency'`) — being `admin` or `reviewer` for any other tool grants nothing here, by construction.
- `leadsimple_operations` (the 74-type domain) gets its own third `tool` value, reusing the existing `admin`/`reviewer` roles unchanged — lower risk, no leasing-function restriction, matching the standard Hub review pattern already used for maintenance claims, since this domain by design (Section 2) never extracts free text at all.

Migration mechanics: one Neo migration widening `team_member_tool_roles`'s `tool` CHECK (add three values) and `role` CHECK (add `leasing_reviewer`), using the same DROP-then-ADD statements as `20260813000004_security_deposit_team_roles.sql` and `20260815010000_maintenance_history_schema.sql`. Who actually gets `leasing_reviewer` is Peter's call, same as `pod_lead` was left to him.

---

## 7. Retention

**7 years**, per Peter's direct 2026-08-24 instruction applying Rincon's standing company-wide records retention policy — not a number invented specifically for this build. Applies uniformly to `leadsimple_application_screening` and `leadsimple_delinquency` claims, including denied applicants.

This is **not yet a closed item**, and this spec does not treat it as one:
- Mason's review recommended attorney confirmation specifically for denied-applicant Application Screening data. Peter has not yet decided whether to pursue that confirmation — his call, not a default this spec assumes either way.
- Mason has not yet issued a standalone written sign-off confirming 7 years satisfies the concern he raised (his review exists today only inside the data-inventory doc, attributed to him but not authored by him as its own document).

Both are named in this document's status header as pre-build gates, not pre-spec gates — restated here because retention is the section most likely to get treated as settled prematurely. `leadsimple_operations` claims, being structural-only and lower-risk, inherit the same 7-year figure by default (no reason identified to diverge) but were not separately reviewed by Mason — flag this to him when his standalone sign-off is requested.

---

## 8. The Domain-Specific Accuracy Test

Asimov's approval requires the same style of check Maintenance History went through before it went live: a real, blind-graded sample test against actual LeadSimple data, using the fully-correct/partial/wrong/missed/wrong-source grading categories and the sealed-answer-key discipline already established (`projects/property-brain-experiment/answer-key-template.md` — filled from memory/records only, no AI help, before the grader looks at the raw source material with fresh eyes, before extraction runs against it).

**Grading unit:** one LeadSimple **process instance** (a "case"), the natural equivalent of a maintenance "ticket" — its stage history, tasks, and custom fields together, graded as one unit the way one ticket's event/decision/outcome/recurrence claims were graded together in the original test.

**Sample size and composition — sized up from the original 10, given the larger corpus and higher regulatory weight, not left at the same size by default:**

| Domain | Sample size | Composition |
|---|---|---|
| `leadsimple_application_screening` | ~20 cases | A mix of ordinary boilerplate-only cases, the 1 known non-boilerplate `Positive Landlord Reference` outlier, both known `comments`-field cases (including the housing-voucher mention), and several cases drawn from the ~10% "minor variation" task-description bucket Mason flagged as the weakest spot for a keyword-only check |
| `leadsimple_delinquency` | ~15 cases | Predominantly the standard blank/dropdown case, since 100% of Delinquency's custom fields are non-free-text in practice; still worth a real sample given tenant collections data is sensitive on its own terms |

**Process:** a human with real LeadSimple access fills a sealed answer key per case (same format as `answer-key-template.md`, adapted for stage/task/field content instead of maintenance events) before the extractor sees the case. The extractor's output is graded blind against that key, using the same five-way split (fully correct / partial / wrong / missed / wrong-source) already used for the maintenance test's own 80% / 17% / 3% / 0% / 0% result. **Recommended exit bar, matching the original test's own bar rather than a lower one invented for this domain: 0% missed and 0% wrong-source** before either domain is allowed into shadow mode. This is condition (f) from the architecture doc's §8, distinct from and required in addition to the full 90-day shadow-mode review inherited from §7 below — the accuracy test is a pre-launch sample check; shadow mode is the live, 100%-review period after launch.

`leadsimple_operations`, extracting no free text at all (Section 2), does not need the same blind-graded narrative test — its accuracy question is structural ("did it ever wrongly extract a `field_recorded` claim for an unregistered field," which the registry already prevents outright) rather than judgment-based. Recommend a narrower automated invariant check in place of a full sample test for this domain specifically — flagged for Asimov to confirm rather than asserted as sufficient here.

---

## 9. Phased Build Plan

This is a full Core-level build (Section 0), not a quick incremental add — sized accordingly, not understated. The base Maintenance History build ran roughly Neo 1–2 / Q 3–4 / Tron 1–2 sessions for one domain reading structured API + PDF content. This spec covers three domains (two full-rigor, one lighter-touch), a new external API, and materially higher regulatory stakes than maintenance content — it should be expected to run larger overall, spread across more, smaller phases so the riskiest domain proves itself before the next one builds on it.

**Phase 1 — Schema. Additive only, zero risk to anything already built.**
Neo: register 11 `claim_type_registry` rows (4 types × 2 full-rigor domains, 3 types × 1 operations domain — deliberately *not* registering `field_recorded` for `leadsimple_operations`, per Section 2). Widen `claims.source_type` CHECK (add `leadsimple_process_stage`, `leadsimple_task`, `leadsimple_custom_field`). Widen `team_member_tool_roles`' `tool` CHECK (add 3 values) and `role` CHECK (add `leasing_reviewer`), per Section 6. File this domain's own `pii_fields`/`privacy_category`/etc. addendum to `claims`' Rule 4 data inventory (architecture doc §5's own requirement that every new domain files its own entry, not assumes an existing one covers it) — pointing back to `compliance/leadsimple-tasks-workflows-data-inventory.md` for the underlying Rule 4 fields rather than duplicating them here, per this spec's own scope.
*Rough shape: Neo 1 session — mechanically similar to three prior CHECK-widening migrations, just more rows.*

**Phase 2 — The ingestion/extraction pipeline, proven against `leadsimple_application_screening` only first.**
Q: read-only LeadSimple API connector (`api.leadsimple.com/rest`, `LEADSIMPLE_API_KEY`, already documented in `.env.example`). **Resolved live during Phase 2 build:** `GET /processes?updated_since=<unix ts>` works, confirmed — incremental pulls follow the same design as Latchel's `GET /jobs`. Also confirmed live: the `/tasks` endpoint has no working process-scoping filter (`process_id`, `processes_id`, `process[id]`, `process_ids[]`, and `deal_id` were all tested and silently ignored, returning the full unfiltered set rather than an error) — task extraction must filter client-side using each task's nested `process` reference instead, the same pattern already used for Latchel jobs elsewhere in this codebase. Extraction logic producing the four registered claim types, Layer 1 + Layer 2 content check (Section 4), `source_reference`/`claim_text` discipline (Section 5), claim_type_registry validation reused as-is. Domain-specific accuracy test (Section 8) run and cleared before shadow mode begins. 90-day, 100%-review shadow mode entered per architecture §7, scoped to this domain.
*Rough shape: Q 3–4 sessions — larger than the architecture doc's own Phase 2 estimate for a single lower-stakes domain, given the new external API and the added Layer 2 pass.*

**Phase 3 — `leadsimple_delinquency`, the second domain, proving the pipeline built in Phase 2 actually generalizes.**
Q: reuse the Phase 2 connector/extraction pipeline, no new infrastructure — just Delinquency's own field/task shape and its own (Layer 1 only) content-check path. Its own accuracy test (Section 8, ~15 cases) and its own shadow-mode clock. Whether this domain's shadow period can run concurrently with the remainder of Application Screening's is Asimov's call, not assumed here.
*Rough shape: Q 1–2 sessions — should be measurably smaller than Phase 2 for the same reason the architecture doc's own Phase 3 expects a second domain to be cheaper once the expensive infrastructure already exists; if it isn't smaller, that's a signal worth stopping to reassess.*

**Phase 4 — `leadsimple_operations`, the 74-type lighter-touch domain.**
Q: extraction limited to `stage_entered`/`task_completed`/`task_skipped` only — no `field_recorded` path exists for this domain until a specific workflow type earns its own record-level scan and its own registry row (Section 2). Breadth work (74 configurations to read reliably), not depth. Structural invariant check in place of a full blind-graded test (Section 8).
*Rough shape: Q 2–3 sessions.*

**Phase 5 — Tron: Hub surface.**
Two new review-queue-style screens (or sections within a shared "LeadSimple History" tile), reusing the confirm/correct/reject pattern already built for Maintenance History and Security Deposit, gated by the Section 6 roles. Operations claims likely surface as a lighter read-only view rather than a full review queue, given no free text is ever in play there.
*Rough shape: Tron 1–2 sessions.*

**Deferred, named triggers, not scheduled:** the `entities` abstraction (Section 3) — the day a domain (this one or a future tenant-issue/lease-renewal domain) actually needs `tenant_id`/`contact_id` rather than working around its absence; `field_recorded` for any specific one of the 74 operational workflow types — the day that type gets its own record-level scan.

---

## 10. Data Inventory

Per this spec's own scope, the Rule 4 fields (`pii_fields`, `agents_with_access`, `privacy_category`, `retention_policy`, `ccpa_exportable`, `ccpa_deletable`) are not duplicated here — see `compliance/leadsimple-tasks-workflows-data-inventory.md`'s own "Data Inventory (GOVERNANCE.md Rule 4 / PROPERTY-BRAIN-ARCHITECTURE.md §5 format)" section for the current, real entry. Neo's Phase 1 migration (Section 9) is responsible for translating that entry into `claims`' own Section 5 data-inventory addendum at build time, per the architecture doc's requirement that every new domain files its own addendum rather than assuming an existing one already covers it.

---

## Open Items — Needs Confirming Before Any of This Gets Built

**Resolved, 2026-08-25:** the verbatim-vs-paraphrase citation design question (originally in Sections 4/5) is now closed. Peter confirmed Mason's recommended middle path — `claim_text` stays a distilled paraphrase, and the citation gets a direct, one-click link into the LeadSimple source record instead (Section 5). This is consistent with, not a change to, Mason's existing Condition 2 in `compliance/leadsimple-fair-housing-review.md` ("Citation, not verbatim quoting... cite back to its source record, not reproduce applicant/tenant free text verbatim") — that document has not been separately amended with link-specific language as of this update; flag to Mason if a standalone addendum confirming the link mechanism specifically is wanted, though nothing here contradicts what he already signed off on.

1. ~~Mason's standalone written sign-off~~ — **RESOLVED 2026-08-25.** `compliance/leadsimple-fair-housing-review.md` now exists as Mason's own document, including the Condition 2 refinement (paraphrase + one-click link) and the retention closure below.
2. ~~Peter's decision on attorney confirmation of the 7-year retention period for denied-applicant data~~ — **RESOLVED 2026-08-25.** Peter confirmed the 7-year figure is Rincon's standing, previously attorney-advised company-wide records policy, not a number invented for this build — no fresh attorney review needed. Mason accepted this closure in his own document with one honest residual note (the prior advice was general, not Fair Housing-specific) that isn't treated as a gate.
3. ~~Whether the `comments` field ships at all~~ — **RESOLVED 2026-08-25.** Peter confirmed inclusion (Section 4).
4. ~~The 3 outlier records still needing a human (not just Layer 1) read~~ — **RESOLVED 2026-08-25.** Peter reviewed all 3 directly in LeadSimple's own interface. His finding, verbatim: "I found all three fine, nothing that is related to any fair housing issues." See `compliance/leadsimple-tasks-workflows-data-inventory.md`'s Outstanding Items section for the full record.
5. ~~Whether the LeadSimple API supports an incremental/updated-since pull~~ — **RESOLVED, confirmed live during Phase 2 build.** `GET /processes?updated_since=<unix ts>` works (Section 9, Phase 2). Also found live and load-bearing for anyone touching this pipeline: the `/tasks` endpoint has no working process-scoping filter — `process_id`, `processes_id`, `process[id]`, `process_ids[]`, `deal_id` were all tested and silently ignored — so task extraction filters client-side via each task's nested `process` reference, mirroring the existing Latchel-jobs pattern (Section 9, Phase 2).
6. **Whether Delinquency's and Application Screening's shadow-mode clocks can run concurrently or must be sequential** (Section 9, Phase 3) — Asimov's call.
7. **This spec's own governance pre-check** — items 1 and 2 above are now closed, so this can be requested from Asimov once item 4 also closes.
