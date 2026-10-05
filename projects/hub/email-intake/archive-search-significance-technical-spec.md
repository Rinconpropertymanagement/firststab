# Archive Search, Phase 2 — Significance Tagging, Identification, and Complaint Triage (Combined) — v2

**Status:** Draft technical spec — **v2, a substantial revision, not a patch.** Awaiting Peter's approval, then a **fresh** Asimov and Mason governance/legal review (Section 12 — the v1 approval this replaces does not transfer). Nothing in this document authorizes Neo to apply a migration or Q to write code. No AI call described here has run against real data. **Same-day correction, 2026-09-13:** Peter reviewed and rejected this draft's original "non-routine AND unresolved" Property 360/`compliance-review.html` surfacing rule as too broad; Sections 3, 6, 7, 9, and 11 below now reflect the corrected rule, named `is_big_issue`. **Second same-day correction, 2026-09-13:** Peter further corrected `is_big_issue`'s third condition — `needs_human_call = true` alone must not auto-qualify a conversation as a big issue. Sections 6, 7, 9, and 11 below now route a `needs_human_call`-only conversation through a new human review queue instead, keyed on a new `human_confirmed_big_issue` column.
**Third correction, 2026-09-13, following Asimov's and Mason's fresh governance/legal reviews of this v2 document — both returned NOT CLEARED.** Both reviews are on file (`compliance/archive-search-significance-complaint-merge-asimov-review.md`, `compliance/archive-search-significance-complaint-merge-mason-review.md`) and read in full before this edit. Two of their findings require outside counsel and are handled separately — two attorney questions are drafted and pending Peter's send (`compliance/archive-search-significance-privilege-attorney-question.md`, `compliance/archive-search-significance-owner-instruction-attorney-question.md`). Everything else both reviewers found is fixed directly in this revision: Sections 4, 5, 6, 8, and 12 below all changed — see Section 12 for the full status. **This document is still NOT CLEARED** — a fresh Asimov/Mason confirmation pass, the two attorney answers, and Peter's own explicit compliance-risk approval are all still outstanding.
**Fourth correction, 2026-09-13, following the received outside-counsel opinion and both Asimov's and Mason's confirmation passes against it.** The opinion (`compliance/archive-search-significance-outside-counsel-opinion.md`) answered both attorney questions the third correction above left pending. Both reviewers then confirmed against it: Mason's verdict is **CLEARED WITH CONDITIONS** (`compliance/archive-search-significance-outside-counsel-mason-confirmation.md`); Asimov's is **STILL NOT CLEARED**, but only on three items that are not legal questions the opinion could resolve (`compliance/archive-search-significance-outside-counsel-asimov-confirmation.md`) — see Section 12. Both reviewers independently found that the third correction's own historical `owner_instruction_rejected` fix had overcorrected past what the opinion actually authorizes — it dropped AI drafting entirely and routed every historical finding to a human-written note, when counsel's own answer permits automatic drafting without prior human review. This revision walks that back: Sections 3, 4, 5, 6, 7, and 9 below now reinstate the AI-drafted historical note (whenever `owner_instruction_rejected = true`), carrying the mandatory **"Automated historical assessment — not human verified"** label in the stored `note_text` itself, with no human review required before creation — and Section 6 replaces the affirmative-clearance requirement for that same criterion with a lighter tag/reachable-source/reliance-gate model, per Asimov's own independent judgment on that specific point. The `legal_exposure`/`accommodation_related` mandatory-clearance checklist is unchanged. **This document is still not cleared** — see Section 12 for exactly what's left.
**Fifth correction, 2026-09-13, recording Peter's own compliance-risk approval and shadow-mode/sampling exit criterion, and finalizing the processing-method plan.** Of Asimov's three remaining non-legal items (Section 12), two were always Peter's to give, not counsel's or either reviewer's — his explicit compliance-risk approval, and his choice of a bulk-appropriate shadow-mode/sampling exit criterion. Both are now on record in Section 12, in his own words. Section 10's processing-method plan is finalized to match: the pilot (100 conversations, possibly 200 — the same batch that is the shadow-mode sample) runs synchronously, in real time, for fast turnaround; the full-scale run against the rest of the archive, once Peter reviews the pilot and gives the go-ahead, uses Anthropic's Message Batches API to cut cost at that scale. **This document is still not fully cleared** — Neo's Rule 4 data inventory (Section 12) remains outstanding, and Asimov's and Mason's own confirmation that these two resolutions satisfy their respective conditions is still needed; that determination is theirs to make, not recorded here.
**Sixth correction, 2026-09-17, following the real 167-conversation pilot run and Peter's own direct decision afterward.** The pilot ran successfully on sally (three real bugs found and fixed along the way — a `complaints.escalation_signal` CHECK-constraint mismatch, a duplicate-complaint-creation risk on interrupted runs, and a `.maybeSingle()` crash on legitimately ambiguous owner-email matches — each independently verified by TARS against real data and cleared by Judge before shipping). Reviewing the real results, Peter decided to remove Call 1's own protected-class self-check question (Section 5's `PROTECTED-CLASS SELF-CHECK`), reasoning that the archive-wide Fair Housing screening pass every conversation already passed through once makes this second, in-pass self-report redundant. Mason confirmed this is a reasonable business call, not a legal risk, contingent on one real implementation catch (the old fail-closed-to-`TRUE` default on a missing field, which had to be removed alongside the prompt question, not left dangling) — his full confirmation is appended to `compliance/archive-search-significance-complaint-merge-mason-review.md`. Q's fix hardcodes `protected_class_flag: false, protected_class_category: null` on every future row instead of asking the AI; `checkClaim()` (the separate, independent keyword+AI layer) is completely untouched and is now the sole active check on this pass's own content. TARS and Judge both independently verified this against real code and the real database; Judge's one non-blocking note — the admin pilot CSV export's `protected_class_flag` column now reads `false` for two different reasons (real self-reported "no" on the 167 pre-change rows, versus "never asked" on everything after) with nothing distinguishing them — is fixed in this same pass (see `router.js`). Section 5's prompt text and Section 12's "fails closed to flagged, always" policy language for this field are both now stale as written; treat this correction note as authoritative over that stale text until Sections 5 and 12 are fully rewritten to match.
**Written by:** Oracle
**Date:** 2026-09-13 (v1 same day; this is the same-day rewrite, now with a third same-day revision responding to fresh governance/legal review)
**Origin of v1:** Peter's ask — combine `missive-archive-analysis-SPEC.md`'s Section 2 (property/tenant/owner matching) and Section 3 (significance tagging) into one AI pass per conversation.
**Origin of v2 (this revision):** Peter separately has a built-but-never-run tool, **complaint-tracking**, with six real triage categories for "is this a big deal that needs a human right now" (`legal_compliance`, `blocked_resolution`, `churn_risk`, `escalation_recurrence`, `major_money_property_risk`, `owner_instruction_one_off`). Two facts, verified live today, made merging it into this pass urgent rather than optional:
1. **complaint-tracking's own `complaints` table has never been created in the live database** — `supabase/migrations/20260910000000_complaint_tracking_schema.sql` was written, reviewed, and never applied.
2. **complaint-tracking's own driver query is structurally starved and has been since before it ever ran.** `process-pending-messages.js` selects `missive_message_intake WHERE pipeline_status = 'pending'`. Verified live: `pipeline_status = 'processed'` on **254,302 of 254,307** real rows — a side effect of archive-search's own Fair Housing screening pass having already touched nearly the entire archive. Complaint-tracking's six categories have never been discovered anywhere in the historical archive, and cannot be, under complaint-tracking's own current design. This is not a future risk; it is already true today.

Peter's standing instruction, given the "don't re-scan the 250,000+ archive multiple times" cost constraint: fold the six categories into the one AI read this spec already designs, instead of building a fourth pass. A structured **six-lens design review** (governance/legal, database architecture, product/UX, AI reliability/cost, and adversarial red-team; a sixth, security, lens errored out and is unavailable) then ran against the merge proposal, verifying every claim against the real code rather than the specs' prose. Peter and Oracle talked through its findings and made the concrete decisions this revision encodes. Every section below that changed from v1 says so and says why.

**Built from, read in full (v1 sources, unchanged):**
- `projects/hub/email-intake/missive-archive-analysis-SPEC.md`, `archive-search-v1-scope.md`, `archive-search-technical-spec.md`.
- `projects/hub/archive-search/router.js`, `lib/screening-pass.js`, `lib/fair-housing-batch-self-report.js`.
- `compliance/archive-search-held-release-outside-counsel-opinion.md` and the layer1-removal / self-report-recalibration compliance trail.
- `projects/hub/maintenance-history/lib/extract-claims.js`.
- `supabase/migrations/20260905000000_owner_tenant_operational_notes_schema.sql`, `20260912010000_archive_search_flagged_overrides_schema.sql`.
- `supabase/migrations/20260905020000_missive_shared_inbox_intake_schema.sql`, `20260720000002_owners.sql`, `20260813000001_lease_tenants.sql`.
- `projects/hub/archive-search/dashboard/compliance-review.html`, `projects/hub/property-360/dashboard/index.html`.

**Built from, read in full (new for v2):**
- `projects/hub/complaint-tracking/lib/categorize-complaint.js` — the real, live (never-run) six-category prompt this revision folds in and rewrites around.
- `projects/hub/complaint-tracking/lib/subject-match.js` — the real, deliberate "email-match only, no AI free-text fallback, full stop" subject-resolution discipline this revision must not loosen.
- `projects/hub/complaint-tracking/lib/process-pending-messages.js` — the real `computeSilenceContext()` (lines 51-61) and the real, now-confirmed-starved `pipeline_status = 'pending'` driver query (line ~431).
- `supabase/migrations/20260910000000_complaint_tracking_schema.sql` — the real, unapplied `complaints` schema this revision extends. **Never applied to the live database — confirmed.**
- `projects/hub/email-intake/complaint-tracking-technical-spec.md` — the full technical spec that schema was built from; this revision reuses its Design Decisions 11 (audit events), 13 (`proposeAINote()`), 14 (lease-end view), and 15 (access model) directly, and its Rule 9 Housing-Decision Firewall language.
- A six-lens structured design review, run 2026-09-13 against the merge proposal, verifying claims against the real code (`categorize-complaint.js`, `process-pending-messages.js`, `screening-pass.js`, both schemas) rather than the specs' own prose. Every "why" below that isn't Peter's own direct decision cites a specific finding from that review.

---

## Scope Boundary — Missive Archive Only (unchanged from v1)

**This tool searches and tags the Missive shared-inbox email archive. Nothing else.**

It does not read, connect to, or search LeadSimple, Latchel, AppFolio work-order data, or any other connected system. The only lookups this design makes outside the archive itself are against `tenants`, `owners`, and `vendors` — plain address lookups against tables already synced into this same Supabase database. Peter confirmed this scope directly: archive-search stays scoped to the Missive archive only. A tool that searches *across* systems is "Property Brain" — separate, not-yet-built, and nothing here is a first step toward it.

**New for v2, stated explicitly since complaint-tracking's own design touched LeadSimple:** complaint-tracking's Design Decision 17 (an "Owner in Distress" LeadSimple escalation for `churn_risk`) is **not carried into this merge.** That write path was never built and only partially verified even in complaint-tracking's own unmerged design (its own Open Item 6: "confirmed as a hard gate... churn-risk complaints surface via the in-Hub flag only until a separately-reviewed write-capable module exists"). Nothing in this revision changes that — `churn_risk` becomes one of five `escalation_signal` values (Section 5) and surfaces in-Hub only, exactly as complaint-tracking's own spec already required before this merge existed.

---

## 1. What's Changed Since the Analysis Spec Was Written — Verified, Not Assumed (unchanged from v1)

| screening_result | count (live, 2026-09-13) |
|---|---|
| `clear` (searchable) | 249,952 |
| `flagged_protected_class` | 727 |
| `held` | **0** |
| `NULL` (not yet screened) | 3,626 |
| **Total** | **254,305** |

*(As of the same day, `missive_message_intake` shows 254,307 total rows and `pipeline_status = 'processed'` on 254,302 of them — two more rows than the table above, reflecting ordinary continued mail arrival; not a discrepancy worth chasing before this spec ships.)*

**Three real, positive changes from what the analysis spec assumed — and one correction:**

1. **The archive is Fair Housing screened, but not "essentially all of it" — 98.6%, not "everything."** The remaining 1.4% is mechanical fallout of removing the legal-hold bucket (next point), not stray unprocessed mail. This pass reads only `missive_message_intake_search_safe` (`screening_result = 'clear'`) — it runs today against 249,952 conversations and picks up the rest automatically as the existing screening pass finishes them.
2. **The legal-hold bucket is really gone, not just planned to be removed.** `held = 0`, live. Outside counsel concluded Rincon does not need a blanket automated legal/attorney exclusion for an internal search tool over already-accessible shared-inbox mail. **New for v2 — a real consequence of this fact, not previously stated:** this means archive-search's own screening pass never had, and does not have, an attorney-privilege filter of any kind — it only screens for Fair Housing protected-class content. Complaint-tracking's *own* separate privilege/legal-hold check (`privilege-filter.js`'s `checkThread()`) was a different filter, catching a different thing (attorney-client privileged correspondence, not protected-class content). Section 8 (Retiring Complaint-Tracking's Own Pipeline) and Section 12 (Governance) both flag this as a real, new question this merge raises that neither source document resolves — see there.
3. **Content-matching now runs against already-screened content** — Section 2.3 of the analysis spec's sequencing question ("should extraction wait for screening") is moot; the view this pass reads from structurally cannot return anything unscreened.
4. **A real search backend exists and is live.** This phase extends a tool with real users, real roles, and a real safety gate — it doesn't propose a new one.

---

## 2. The Problem This Revision Solves, and the Decision Not to Build a Fourth Pass

Complaint-tracking (`projects/hub/complaint-tracking/`) is a complete, reviewed, Asimov/Mason-approved build that has never processed a single real email, for the structural reason in the header above: its driver query depends on `pipeline_status = 'pending'`, and archive-search's own screening pass — which must run on every conversation before it's searchable at all — sets `pipeline_status = 'processed'` as a side effect of doing its own, unrelated job. This isn't a bug introduced by this merge; it's a pre-existing collision between two independently-built pipelines that happened to touch the same source column, discovered while scoping this merge.

Peter's instruction is not "fix complaint-tracking's query" — it's **don't scan the archive a fourth time.** Search already reads the archive once (live). Fair Housing screening reads it once (live, already run). This spec's v1 already commits to reading it a third time, once, for significance + identification. Building complaint-tracking a working driver query would be a *fourth* independent read of the same 250,000+ conversations. The fix this revision makes instead: **fold complaint-tracking's six categories into the same third read**, retire complaint-tracking's own pipeline (Section 8), and let one AI call per conversation answer both "what's this about, and is it resolved" and "does someone need to act on this" at once.

---

## 3. Plain English — What This Tool Now Does, With Real Examples

*Written for Peter to read on its own.*

### The two questions, asked in sequence — not one question with twice as many parts

For every conversation, the tool always asks a first, short set of questions (**Call 1**): what kind of thing is this, is it resolved, why, who is it about (if not already obvious from the email address), does the tone suggest frustration, and does it touch on a legally protected topic. This is cheap and runs on every conversation — old and new alike.

**Only when Call 1's answer isn't routine and resolved** does the tool ask a second, more pointed question (**Call 2**): is this actually urgent, and specifically why — blocked because someone won't respond or won't authorize something, a sign an owner might leave, the same problem coming back, money or property at real risk, or an owner instruction Rincon can't legally follow. Call 2 is where complaint-tracking's six categories live now, reframed as one field: **why is this urgent**, separate from **what kind of thing is this**.

Splitting it this way — instead of one call answering eleven things at once — exists for a concrete reason found in review: cramming "what kind of thing is this" together with "draft the exact wording of Rincon's legal response to a discriminatory instruction" in one call is exactly the kind of overload that produces truncated or inconsistent answers. Keeping them separate, and only asking the second question when the first one says it's worth asking, keeps both answers reliable and keeps the cost down — Call 2 will run on well under half the archive.

### The vocabulary — two lists, not one, because they answer different questions

**What kind of thing is this** (always answered, one of eight): routine scheduling, ordinary maintenance, a dispute, a safety issue, something with legal exposure, a disability/accommodation matter, an owner's standing instruction, or other.

**Why is this urgent** (only answered when Call 2 runs, one of five, or "none"): blocked resolution, churn risk, escalation/recurrence, major money or property risk, or none found.

These used to be two different tools' category lists (complaint-tracking's six vs. this tool's eight) with real overlap and real gaps — a parking dispute and a tenant threatening to break their lease are both "disputes," but only one is a churn risk. Keeping them as two separate answers means a person can browse by topic, or filter by urgency, or both — instead of forcing one label to do two jobs.

### Examples — including what's new

**routine_logistics, resolved** — unchanged from v1: a scheduling confirmation with nothing left pending. Call 2 never runs.

**dispute, open, escalation_signal: none** — *"My neighbor keeps parking in my spot and won't stop."* Call 2 runs (it's not routine/resolved) but finds nothing urgent beyond the dispute itself — no repeat pattern, no refusal, no churn signal. **Not a big issue (Section 6):** none of `is_big_issue`'s three conditions is true, so being still open doesn't put it on Property 360 or on either of `compliance-review.html`'s tabs — it stays exactly where routine/resolved conversations already stay, search-only, for as long as it remains open.

**legal_exposure, open, escalation_signal: none, needs_human_call: true** — a genuinely ambiguous thread where the AI isn't confident enough to call it either way. This flag — carried over unchanged from complaint-tracking's own design — is an honest "a person should look at this," distinct from any category. It has no equivalent in v1 of this spec and must not be lost in the merge.

**owner_instruction, discriminatory, live mail** — *"Don't rent to anyone with kids at that building going forward."* Received today. Call 2 fires: `owner_instruction_rejected: true`, and a note is drafted for the file using Rincon's counsel-approved response pattern — worded as something staff can actually act on, because this is a live conversation happening now.

**The same instruction, found in a 2022 email during the one-time archive read** — this is where v1 of this spec would have gotten it wrong, and where the six-lens review first caught a real problem. A same-day outside-counsel opinion (`compliance/archive-search-significance-outside-counsel-opinion.md`, Question Two) has since answered this directly: an AI-drafted, present-day-assessment note about a historical discriminatory owner instruction may be generated automatically, without prior human review, provided it is clearly framed as a present-day AI assessment rather than a historical fact, and carries a designation that it is unverified. **The tool drafts a note here, automatically, using that framing.** It sets `owner_instruction_rejected` to its honest read — `true`, `false`, or `uncertain` — and, whenever the read is `true`, drafts `note_text` using the present-day-assessment template: *"AI-assessed in 2026: this 2022 owner instruction, if acted on, would require Rincon's standard refusal — no record confirms what was actually communicated to the owner at the time."* Every such note also carries, as part of the stored text itself — not only as a UI badge — the label counsel and Mason both specifically require: **"Automated historical assessment — not human verified."** No human reviews or approves this note before it's created or shown; the source thread stays permanently, directly reachable from the record, and a human reviews that source before anyone relies on the note for anything consequential (Section 6).

An earlier revision of this section, written before the attorney opinion came back, dropped AI drafting for historical mail entirely on Mason's own more cautious original recommendation — the concern being that a confident AI assertion about a named owner's past conduct is more dangerous unreviewed than an uncertain one, with no operational upside to offset a wrong claim landing in a permanent record. Both Mason and Asimov have since reviewed the actual received opinion and withdrawn that added restriction as more restrictive than what counsel authorized (`compliance/archive-search-significance-outside-counsel-mason-confirmation.md`, Finding 2; `compliance/archive-search-significance-outside-counsel-asimov-confirmation.md`, Item 2) — the mandatory "not human verified" label, plus the reliance gate before consequential use (Section 6), is what actually addresses the risk, not withholding the note.

**blocked_resolution, found in a 2023 email, resolution status unknown** — a real habitability complaint from three years ago where the thread simply goes quiet. Under complaint-tracking's own unmodified logic, this reads as "unanswered for 1,046 days" and gets flagged blocked and urgent — treating a stale thread exactly like something that happened yesterday. This spec fixes that (Section 6) two ways: the "how long has this been quiet" signal is turned off or reframed for old mail, and — separately — if the underlying issue really might still be open, it goes onto a short, bounded list Peter and the Director of Operations must actually look at, rather than either paging anyone about a 2023 dispute or silently doing nothing about a genuinely unresolved issue just because it's old.

### One honest new limitation, stated up front

**A 24-hour "you've been ignoring this" alarm exists in complaint-tracking's design for live complaints.** Pointed at the archive unmodified, every single unresolved historical item would trip that alarm on day one, because the alarm only checks "how long ago was this created" with no idea a backfill run happened today. This spec's fix (Section 6) is a hard rule, enforced in the underlying query itself, not just in what's shown on screen: that alarm can only ever fire for new mail processed the same day it's received. A separate, calmer, clearly-labeled "Historical Backlog" list is where old items land instead (Section 9).

---

## 4. The Combined Design — Two Calls, Two Branches, One Driver Query

**What's unchanged from v1:** the deterministic address check runs first (no AI, free) against `tenants.email`/`owners.email`/`vendors.email`; the branch on whether an address match was found determines whether the AI needs to also attempt content-based identification (Prompt B) or not (Prompt A); resolution to a real property/tenant/owner/vendor row is always a separate, deterministic lookup afterward, never the model's own guess.

**What's new — the driver query itself was wrong in v1, and complaint-tracking's own query is actively broken (Section 2):**

> Process every conversation in `missive_message_intake_search_safe` (i.e. `screening_result = 'clear'`) that has **no existing row yet in `missive_conversation_significance`.**

`missive_conversation_significance`'s own `UNIQUE (mailbox_key, missive_conversation_id)` constraint is already the correct "have I processed this" check — no new tracking column, no new flag on `missive_message_intake`, needed. This single query correctly serves **both** the one-time historical backfill (everything currently `clear` with no significance row) **and** all future live mail (whatever becomes newly `clear` after archive-search's own screening pass runs on it) — the same query, forever, on its own independent schedule. This replaces complaint-tracking's `WHERE pipeline_status = 'pending'` query entirely; that query is retired, not fixed (Section 8).

**Call 1 — runs on every eligible conversation:**
1. Deterministic address check (unchanged from v1).
2. Branch: address match found → Prompt A; no match → Prompt B (both extended per Section 5 below: `category`, `resolution_status`, `why`, identification-or-unknown, `tone_trend`, `protected_class_flag`).
3. Write (or update) exactly one row per conversation in `missive_conversation_significance`, regardless of branch.

**Call 2 — conditional, runs only when Call 1's own output warrants it:**
- Gate: `category != 'routine_logistics' OR resolution_status != 'resolved'`.
- **Deliberately biased generous, not narrow** — per the reliability review's own finding: a missed gate silently drops a genuine complaint category entirely; a false-positive gate only costs a little extra money. Gating only on the "obviously legal/dispute" categories, as a narrower first draft might do, would let real `blocked_resolution`/`churn_risk` hits hiding inside `maintenance_standard` or `other` slip through unasked.
- Asks: `escalation_signal`, `needs_human_call`, `blocked_reason`/`blocked_party` (only if `escalation_signal = 'blocked_resolution'`), and — only if `category = 'owner_instruction'` — `owner_instruction_rejected` (true/false for live mail, or true/false/uncertain for historical mail). Note text is drafted for live mail always, and for historical mail whenever `owner_instruction_rejected = true` — carrying the mandatory "Automated historical assessment — not human verified" label as part of the stored text (Section 5). Historical mail leaves `note_text` NULL only when the read is `false` or `uncertain`.
- Writes onto the **same** `missive_conversation_significance` row (every conversation Call 2 runs against gets these fields recorded, whether or not anything urgent was found), and creates a linked row in `complaints` (Section 5) whenever the result is actionable: `escalation_signal != 'none'`, or `needs_human_call`, or `owner_instruction_rejected`, **or `category IN ('legal_exposure', 'owner_instruction')` on its own**, regardless of `escalation_signal`/`needs_human_call` state. That last condition is new in this revision, per Asimov's Finding 3 (his required item 5) — without it, a conversation that qualifies as `is_big_issue` (Section 6) on category alone never reached the DO assignment, the red-badge tile (live mail), or the aging clock, only the passive Property 360/backlog-tab surfacing. **This applies to both live and historical mail** — Asimov found the gap on the live side too, not only the historical backlog: a `legal_exposure`-categorized email received today, with no escalation signal and no uncertainty flag, must still create a `complaints` row and reach the DO the same way an escalation-flagged one does. (Section 6's hard-gate still keeps the historical side of these rows out of the red-badge tile, DO assignment, and aging clock — this fix only guarantees the `complaints` row itself gets created; Section 6 still decides how loudly it's surfaced.)
- **Do not confuse this gate with `is_big_issue` (Section 6).** This gate decides only whether Call 2 runs at all — deliberately biased broad, per the point above, so a real escalation hiding in an "other"-tagged thread isn't skipped before it's even asked about. Passing this gate says nothing about whether the conversation ends up shown to anyone: most conversations that trigger Call 2 finish with `escalation_signal = 'none'`, `needs_human_call = false`, and an ordinary category, and are therefore not big issues at all — see the neighbor-parking-dispute example in Section 3.

**Identification stays cite-then-lookup, not directory-in-prompt.** Complaint-tracking's own design hands the model Rincon's full property and vendor list as text on every call (`categorize-complaint.js`'s `buildPropertyDirectoryText`/`buildVendorDirectoryText`) — reasonable for a handful of live emails a day, but re-transmitted 250,000+ times it's a large, avoidable token cost. This merge does **not** port that approach. It keeps this spec's existing discipline: the model quotes the source text, a separate deterministic step resolves it to a real row afterward. Nothing about Call 2 changes this.

**Subject resolution stays email-match-only — this is a deliberate divergence complaint-tracking already made, and the merge must not silently loosen it.** `subject-match.js`'s own header is explicit: "a name alone is not enough to safely identify a specific person for a Fair Housing-adjacent workflow... subject resolution stays email-match-only, no AI free-text fallback, full stop." `complaints.subject_type`/`subject_id` must therefore only ever be populated from `missive_message_links` rows where `match_method = 'address_match'` — **never** from a `content_extracted` (Prompt B-guessed) row, regardless of how high its confidence score is. A conversation with no address match leaves `complaints.subject_type`/`subject_id` NULL and sets `needs_matching = TRUE` (the column already exists for exactly this case) — the same posture complaint-tracking already had, now correctly wired up for the first time. (Found in review: complaint-tracking's real prompt never actually asked for a subject match at all — only `extracted_property_id`/`extracted_vendor_id` — so `complaints.subject_type`/`subject_id` had no live population path whatsoever in the unmerged design. This merge is the first time it gets one, and it must be the address-match path, not a new AI guess.)

---

## 5. The Prompt Design

Both calls are modeled on the same real, live shapes this spec has always cited (`fair-housing-batch-self-report.js`'s JSON-only/fail-closed contract, `extract-claims.js`'s cite-a-source discipline) plus, new for Call 2, `categorize-complaint.js`'s six-category definitions and uncertainty/tone framing. `threadText` is built the same way as before — `threadFullText()`, reused from `complaint-tracking/lib/thread-adapter.js`.

### Call 1 — Prompt A (address-matched) and Prompt B (no address match)

Unchanged in structure from v1's Prompt A/B (Section 4 of the original draft) — same `RESOLUTION STATUS`/`CATEGORY`/`WHY` questions, same eight-category list, same citation-or-unknown identification discipline for Prompt B. **Two additions to both prompts:**

```
4. TONE — read the messages in order (oldest first). Is the sender's tone
   getting more strained or frustrated over time, or steady? Set
   tone_trend to "escalating" only if you see a real progression across
   multiple messages, "stable" otherwise. Advisory only — never decides
   anything by itself.

5. PROTECTED-CLASS SELF-CHECK — does this thread touch on a legally
   protected topic (race, color, religion, sex, sexual orientation,
   gender identity, national origin, familial status, disability/health,
   source of income, marital status, age, ancestry, citizenship, primary
   language)? If yes, set protected_class_flag: true.
```

(`protected_class_flag`/`tone_trend` — same wording as `categorize-complaint.js`'s own Fair Housing self-check and tone instructions, reused directly rather than re-derived.)

**One more thing does not carry over unchanged, and must be corrected before this ships (Mason's Finding 1).** The eight-category list's `legal_exposure` entry folds in complaint-tracking's old `legal_compliance` category (Section 7) — but not that category's own header sentence. `categorize-complaint.js` line 62 tells the model: *"an actual formal Fair Housing/HUD/CRD complaint or real attorney/legal correspondence should already have been pulled out before you ever saw this thread (a separate mechanical hold check runs first) — if you are seeing this thread at all, it already cleared that check."* That sentence describes `checkThread()`'s privilege/legal-hold filter. Under this merge, **no privilege or legal-hold filter of any kind runs before either call sees this content** — `checkThread()` is never called anywhere in this pipeline (Section 8; Mason's and Asimov's Finding 1). Carrying that sentence forward would tell the model something false about its own input, in exactly the category where that matters most — it does not carry forward. The `legal_exposure` category's instruction text in the merged prompt instead states plainly:

```
No privilege or legal-hold filter of any kind runs before this pass sees
this content. The only upstream check is archive-search's Fair Housing
protected-class self-report — a different filter, for a different thing,
gating a different eligibility question. Do not assume attorney-client-
privileged or formally-filed legal correspondence has already been
removed from what you're reading.
```

This is a factual correction to what the model is told, not a resolution of Finding 1's underlying legal question — the privilege attorney question (`compliance/archive-search-significance-privilege-attorney-question.md`, drafted and pending Peter's send) is still open and still required before Call 2 runs against real data (Section 12).

**Resolving the `checkClaim()` ambiguity (Mason's Finding 3).** `checkClaim()` — `maintenance-history/lib/content-check.js`'s real, independent Tier A/Tier B keyword+AI layer, the one `process-pending-messages.js` calls today (lines 273-277) — **is retained as a genuine second, separate call on Call 1's own self-check output**, exactly as it runs today. This is real defense-in-depth, not decoration, for the two reasons Mason's review gives: it is a differently-scoped question from archive-search's own Fair Housing self-report, and it is the only Fair Housing signal that runs on this content in the context of this specific triage read.

Mechanism: immediately after Call 1 writes (or updates) a `missive_conversation_significance` row, call `checkClaim({ claim_text: threadText, modelFlag: protected_class_flag, modelCategory: protected_class_category })` — the same call shape `process-pending-messages.js` uses today. Its result is written onto four new columns on `missive_conversation_significance` (Section 7) — `keyword_check_flagged_protected_class`, `keyword_check_flagged_category`, `keyword_check_matched_layer`, `keyword_check_terms_version` — the same shape `checkClaim()` already returns, stored independently of, and never overwriting, Call 1's own `protected_class_flag`/`protected_class_category` self-report. The two live side by side so a divergence between the model's own read and the keyword+AI layer's read stays visible, never collapsed into one field.

When `keyword_check_flagged_protected_class = true`, the same `audit_log` entry complaint-tracking's own (never-run) design already built for this fires: action `complaint_tracking.protected_class_flagged`, `risk_level: 'high'`, `privacy_category: 'processing'`, `actor_type` set per the existing Tier A/Tier B rule (`process-pending-messages.js` lines 357-381) — never the matched term itself, per the standing governance restriction. That `audit_log` entry is the review surface a `true` flag triggers — the same one this check was already designed to feed, now actually wired up for the first time, satisfying Mason's requirement that this not be "a self-check field that feeds no audit event and no review surface."

### Call 2 — new prompt, conditional

```
This conversation was already reviewed once and categorized as: {category}
({resolution_status}). {why}

{historicalFraming — see below}

Conversation:
"""
{threadText}
"""

Answer:

1. ESCALATION SIGNAL — does this conversation show one of the following?
   Choose exactly ONE, or "none":
   - blocked_resolution — the normal path to fixing something has broken
     down: an owner refuses to authorize/pay, a tenant refuses access, or
     Rincon asked for authorization/access and got silence past the
     threshold below with no explicit "no."
   - churn_risk — an owner hinting they're unhappy with management,
     mentioning other companies or selling; a tenant threatening to break
     the lease or withhold rent.
   - escalation_recurrence — the SAME issue coming up again. Only use
     this if THIS THREAD ITSELF shows a clear repeat — do not guess at
     history you can't see in this thread.
   - major_money_property_risk — not routine spend; something at the
     scale of a roof replacement or an insurance-claim-level event.
   - none — none of the above apply.
   If blocked_resolution, also set blocked_reason ("explicit_refusal" or
   "inferred_from_silence") and blocked_party ("owner" or "tenant").

2. NEEDS A HUMAN CALL — if you are genuinely unsure whether this needs
   attention, set needs_human_call: true. This is not a category — it's
   an honest "I'm not sure," not a forced guess.

3. OWNER INSTRUCTION CHECK — only if the conversation's category is
   owner_instruction: is the instruction itself discriminatory (would
   require Rincon to treat someone differently based on a protected
   characteristic)?

   LIVE MAIL: if yes, set owner_instruction_rejected: true and draft
   note_text per the live template below. If it's an ordinary,
   non-discriminatory instruction, set owner_instruction_rejected: false
   and note_text to a plain factual statement of the instruction.

   HISTORICAL MAIL: set owner_instruction_rejected to true, false, or
   "uncertain" — your honest read of whether the instruction was
   discriminatory. If true, draft note_text per the historical template
   below — every historical note must include the mandatory "Automated
   historical assessment — not human verified" label as part of the
   text itself. If false or "uncertain," leave note_text NULL — the
   received attorney opinion authorizes drafting the discriminatory-
   instruction note specifically; it does not extend to a non-
   discriminatory or genuinely ambiguous historical read, so nothing
   is drafted for those. If your read is "uncertain," also set
   needs_human_call: true — this is exactly the situation that flag
   exists for.

{historicalTemplateNote — see below}

SILENCE CONTEXT: {silenceContextText — see below}

Respond with EXACTLY one JSON object, no markdown fence:
{"escalation_signal": ..., "blocked_reason": ..., "blocked_party": ...,
 "needs_human_call": true|false,
 "owner_instruction_rejected": true|false|"uncertain"|null,
 "note_text": "..."|null}
```

**`historicalFraming` — fixes Bug #1 (silence-context date math), found by the adversarial lens against real code, not hypothetical.** `process-pending-messages.js`'s `computeSilenceContext()` (lines 51-61) computes days-since-last-message against `Date.now()` with no concept of thread age. Pointed at the archive unmodified, a perfectly-resolved 2023 thread whose last message happened to come from Rincon staff (a totally normal pattern — the fix got confirmed by phone, not email) reads as "unanswered for 1,046 days," and the model has every reason, following its own instructions, to call it `blocked_resolution`. **Fix:** for any conversation processed by the one-time historical backfill (`discovery_context = 'historical_backfill'`, Section 6), the silence-context block is either omitted entirely, or replaced with:

```
This is a historical thread (backfilled from the archive, not live mail).
The elapsed time since the last message reflects the passage of time, not
necessarily an unresolved refusal — do not infer blocked_resolution from
silence alone on a historical thread. Base your answer only on what the
thread's content actually shows.
```

For live mail (`discovery_context = 'live_pipeline'`), the silence-context text is unchanged from `categorize-complaint.js`'s existing wording.

**`historicalTemplateNote` — reinstated, per the received outside-counsel opinion (Question Two) and both Asimov's and Mason's confirmation passes on it.** An earlier version of this section fixed the retroactive-wording problem (Section 3's example) by replacing the historical `owner_instruction_rejected` template with a hedged, present-day-assessment wording. A later, same-day revision then dropped that template entirely, on Mason's own more cautious original recommendation, made before any opinion was in hand — the concern being an unsupervised AI permanently writing an adverse, un-contestable characterization of a named owner's past conduct, with no human check before that record exists.

The received opinion (Section 5, "Historical Discriminatory Instructions May Be Automatically Classified"; Section 6, "Human Review Is Not Required Before the Note Is Created"; Specific Answers, Question Two) answers exactly this fact pattern: an AI-drafted, present-day-assessment note about a historical discriminatory owner instruction may be generated automatically, without prior human review, provided (a) it is worded as a present-day assessment, not an assertion of historical fact, and (b) it carries a clear designation that it is unverified. Both Asimov and Mason reviewed the actual opinion and independently withdrew their own added restriction as stricter than what counsel authorized (`compliance/archive-search-significance-outside-counsel-asimov-confirmation.md`, Item 2; `compliance/archive-search-significance-outside-counsel-mason-confirmation.md`, Finding 2) — the label plus the reliance-gate at the point of consequential use (Section 6) is what the opinion actually asks for, not withholding the note until a human writes it.

**This revision reinstates the historical template, unchanged in substance from what an earlier revision drafted, plus the mandatory disclaimer counsel specifically requires.** For historical mail, whenever `owner_instruction_rejected = true`, Call 2 auto-drafts `note_text` as:

> "AI-assessed in [year]: this [year] owner instruction, if acted on, would require Rincon's standard refusal — no record confirms what was actually communicated to the owner at the time."

with `[year]` filled from the conversation's actual message date, followed immediately, as part of the same stored `note_text` value — not layered on afterward, not only a UI badge — by:

> "Automated historical assessment — not human verified."

This exact wording is Mason's and the opinion's own — Mason's confirmation names it directly as "the" required disclaimer, not one option among several, and it must be in the record itself so a reader encountering the note out of context (a CSV export, an audit log entry, a discovery production) still sees the qualifier. No human reviews or approves this note before it is created or shown anywhere it surfaces. For `owner_instruction_rejected = false` or `'uncertain'` on historical mail, `note_text` stays NULL, exactly as before — the received opinion was asked about, and answers, the discriminatory-instruction note specifically; nothing here extends auto-drafting to a non-discriminatory or genuinely ambiguous historical read.

For live mail, the wording is unchanged and still auto-drafted — Rincon's existing counsel-approved response pattern ("Owner instruction: [...]. Rincon response: [...]"), exactly as complaint-tracking's own design already does today.

### Fail-closed posture — field-specific, not one blanket policy

This is a real change from v1, which applied one posture ("retry-until-success, no row on failure") to the whole call. The review found that posture is right for browsing fields but wrong, unmodified, for higher-stakes ones, given this pipeline runs on no automatic schedule at all.

- **Call 1's pure browsing fields** (`category`, `resolution_status`, `why`, identification): retry-until-success; no row written until a parse succeeds. A wrong tag isn't a safety issue — unchanged from v1.
- **`protected_class_flag`:** stays fail-closed-to-flagged, always, on any kind of parse failure of that specific field — matching the existing screening pass's own discipline. (A total Call 1 failure still produces no row at all, same as above; this only governs a partial parse where every other field came through but this one didn't.)
- **Call 2's fields:** on parse failure, timeout, or truncation, write (or update) the significance row with `needs_human_call = TRUE` and leave `call2_completed_at` NULL (Section 5) rather than leaving no trace at all. Since nothing in this pipeline runs on a schedule, "no row, next run retries it" can mean silently unprocessed for weeks — exactly the failure mode that would defeat the entire point of merging complaint-tracking in.

---

## 6. The Critical Fork — Live Mail vs. Historical Backfill

**This is the load-bearing decision in this revision.** Get it wrong and the tool either pages the Director of Operations about a 2019 dispute, or — the review's more serious finding — quietly creates a permanent, timestamped record that Rincon's own AI spotted a real legal or safety problem and nobody was required to do anything about it, which the governance lens called "arguably worse than never having built the tool" and inconsistent with GOVERNANCE.md Rule 8's requirement that high-risk items escalate entirely, not get tagged for optional browsing.

**The mechanism:** add `discovery_context TEXT CHECK (discovery_context IN ('live_pipeline', 'historical_backfill'))` to `complaints` (and, for the same provenance reason, to `missive_conversation_significance`). This reflects **which run processed the conversation, not the age of the email itself** — the one-time Batches-API historical run (Section 10) stamps every row it produces `historical_backfill`; the ongoing, manually-triggered synchronous pass stamps `live_pipeline`. (This also correctly handles an edge case: an old email that only becomes newly eligible after the historical run has already finished — e.g., reinstated from a Fair Housing flag — runs through the live pipeline and is stamped `live_pipeline` even though the message itself is old. That's fine: `discovery_context` controls *how loudly* something is surfaced, never *whether* it counts, per the next paragraph.)

**Hard-gate the live workflow machinery on `discovery_context = 'live_pipeline'`, at the query level, not just in the UI:**
- The home-page red-count tile.
- The 24-hour aging/escalation job (`idx_complaints_aging_candidates`, `big_deal_aging_clock_hours`).
- `owner_team_member_id` assignment to the current Director of Operations.

None of these may ever consider a `historical_backfill` row. This is the fix for the alarm-fires-on-the-whole-archive problem (Section 3).

**The `is_big_issue` flag — CORRECTED by Peter, 2026-09-13, replacing this document's earlier "non-routine AND unresolved" framing (this section and Section 9, in the draft Peter reviewed) with the actual rule, then corrected a second time the same day on its third condition.** A conversation is a big issue when any of these three is true, independent of `resolution_status`:
1. `category` is `legal_exposure` or `owner_instruction` — these were always dedicated "big deal" categories on their own, carried over from complaint-tracking's original six; being one of these two categories is sufficient by itself.
2. `escalation_signal` is not `none` — i.e. `blocked_resolution`, `churn_risk`, `escalation_recurrence`, or `major_money_property_risk`.
3. `human_confirmed_big_issue` is `TRUE` — **not** `needs_human_call = true` directly. **Second same-day correction:** the first pass at this rule let the AI's own "I'm not sure" flag (`needs_human_call`) promote a conversation to Property 360 by itself. Peter's own words on why that's wrong: *"the not sure flag maybe goes to a review just like any other flag issues we have and then from there a human decides if its a big issue and if it is then it automatically goes onto property 360."* An honest AI uncertainty flag is a reason to ask a person, not a reason to publish — see the new **Needs a Human Call** review queue below.

Nothing else qualifies. A `dispute` or `safety_issue` or `maintenance_standard` conversation that is merely still open, with none of the three conditions above true, is **not** a big issue — being unresolved alone was never sufficient. That conversation stays exactly where routine/resolved content already stays: search-only, never listed on Property 360, never in either of `compliance-review.html`'s tabs (Section 9) — regardless of how long it's been open. **A conversation whose only signal is `needs_human_call = true` is also not yet a big issue** — it sits in the new review queue only, until a human decides otherwise.

**New — the `needs_human_call` review queue, replacing direct promotion.** When Call 2 sets `needs_human_call = true` and neither condition 1 nor condition 2 above is already true, the conversation does not touch Property 360, either `compliance-review.html` surfacing tab, or the Historical Backlog tab. Instead it appears in a new fourth tab on `compliance-review.html`, **"Needs a Human Call"** — deliberately built on the same mechanism the Fair Housing tab already uses (confirmed live against that tab and `router.js`, not assumed from prose): a plain list of pending items — every row where `needs_human_call = TRUE`, `category NOT IN ('legal_exposure', 'owner_instruction')`, `escalation_signal IS NULL OR escalation_signal = 'none'`, and `human_confirmed_big_issue IS NULL` (i.e. `needs_human_call` is the row's only signal and no human has reviewed it yet) — quick-pick reason chips, and bulk selection/action, reusing this page's existing `.tab-bar`/`.bulk-bar`/reason-chip-modal markup and JS pattern rather than a new design.

One deliberate difference from the Fair Housing tab, stated explicitly rather than left implicit: the Fair Housing tab has exactly one action (Reinstate) because its default — do nothing, stay flagged — is itself a valid, permanent outcome. This queue needs **two** outcomes, because "not yet reviewed" must stay distinguishable from "reviewed, and it's not actually a big issue" (see `human_confirmed_big_issue`'s tri-state, Section 7) — otherwise a genuinely-reviewed-and-rejected item would sit in this queue forever, its own failure mode given the multi-thousand-item historical volume Section 10 already flags. So each row gets two buttons — **"Confirm — this is a big issue"** and **"Not a big issue"** — each opening the same reason-chip modal component the Fair Housing tab already uses, and each available as a bulk action over a checked selection, exactly like the Fair Housing tab's bulk-reinstate bar. This borrows the Escalations tab's two-outcome shape (Confirmed / False Alarm) more than the Fair Housing tab's one-outcome shape — the *second* existing pattern on this same page, not an invented third one — because the underlying decision here (is this actually a big issue, yes or no) is genuinely binary the way Escalations' is, not one-sided the way Fair Housing's is.

Clicking **"Confirm — this is a big issue"** sets `human_confirmed_big_issue = TRUE` (with attribution — Section 7), which makes `is_big_issue` true by construction and the conversation appears everywhere `is_big_issue` is read — Property 360, the Historical Backlog tab (if historical), or the live Needs Attention tab (if live) — on the very next read, automatically, with no separate publish step. This is Peter's own requirement, verbatim: *"if it is then it automatically goes onto property 360."* Clicking **"Not a big issue"** sets `human_confirmed_big_issue = FALSE`, which leaves `is_big_issue` false for that conversation and removes it from this queue's pending list. Either action requires a reason, exactly like every other human decision recorded elsewhere on this page.

This queue is not scoped to historical mail only — a live conversation whose only signal is an honest `needs_human_call = true` goes through the same queue, for the same reason: Peter's own framing ("just like any other flag issues we have") does not carve out live mail, and an AI-uncertainty flag is not a timing question the way the aging-alarm problem (Section 3) is. This is a deliberate, narrow divergence from Section 9's live/historical split for the two surfacing tabs, worth naming so it isn't mistaken for an oversight: **a live `needs_human_call`-only conversation still gets a `complaints` row, DO assignment, and 24-hour aging exactly as Section 4 and this section's hard-gate above already specify** — that machinery answers "does the Director of Operations need to act on this now," a live-operational question. This new queue answers a different question — "does this deserve permanent billing as a big issue on Property 360" — and a conversation can sit in both places (the DO's complaints queue and this review queue) at once without conflict, because the two questions are independent; the DO's operational triage does not by itself settle the other's compliance-significance call.

`is_big_issue` is a `GENERATED ALWAYS ... STORED` boolean column on `missive_conversation_significance` (Section 7), computed once so every reading site — Property 360, both `compliance-review.html` tabs, and this section's own carve-out below — agrees by construction rather than re-deriving the definition differently in different places. This follows the exact precedent `complaints.is_big_deal` already sets (`20260910000000_complaint_tracking_schema.sql`), and the same table-local reasoning applies here even more directly: `category` (Call 1), `escalation_signal` (Call 2), and `human_confirmed_big_issue` (a human decision, never AI output) all live permanently on this same `missive_conversation_significance` row (Section 7) — never only transiently in Call 2's own response before being written to `complaints` — so the generated column can reference all three cleanly, with no view or cross-table lookup needed.

`is_big_issue` is deliberately independent of both `resolution_status` and `discovery_context` — neither one decides *whether* something is a big issue, only what happens to it afterward. `resolution_status` governs ordering, not inclusion: a big issue that later gets marked resolved does not drop off Property 360 or the Historical Backlog tab; it stays visible, collapsed/deprioritized below open big issues (Section 11, Item 1 — now confirmed by Peter, not just a recommended default), because the point of Property 360 is full context on a property regardless of timing. `discovery_context` (below and Bug #2 next) governs how loudly and to whom something is routed, never whether it counts as a big issue in the first place.

**The rule this must never be confused with — Bug #2, also found against real code:** for a conversation that already is a big issue (`is_big_issue`, above), the escalation/suppression decision must key strictly on `resolution_status` (`open`/`unknown` vs. `resolved`), **never** on `discovery_context` or age alone. A backfilled big issue that is genuinely still open — a habitability issue that never shows a confirmed fix — does not stop mattering because it's three years old. `discovery_context` controls *how* staff are told (a same-day nudge vs. a batched historical review); it must never control *whether* a big issue counts as needing attention. Muting the aging job for historical rows fixes the false-alarm problem; it does nothing, by itself, about a real still-open big issue that happens to be old — that's a separate risk, addressed next. (This paragraph governs only conversations that already pass `is_big_issue` — it does not itself decide what qualifies. An ordinary open dispute that was never a big issue in the first place does not gain urgency just by staying open for years, any more than it would on day one.)

**The one carve-out that still requires affirmative clearance — a bounded, human-reviewed checklist, not a notification and not silent tagging.** A historical row must be surfaced on this discrete, must-be-**affirmatively cleared** list whenever:
- `category IN ('legal_exposure', 'accommodation_related')` OR `escalation_signal IN ('blocked_resolution', 'major_money_property_risk')`, **AND** `resolution_status IN ('open', 'unknown')` — the original carve-out, **widened to include `accommodation_related`** (Mason's Findings 4 and 5: a wrong "still open" read on an old accommodation thread carries materially higher downside than most categories, the same reasoning that already put `legal_exposure` here — see Finding 5's discussion of why old, resolved-off-channel threads systematically read as unresolved on their face). This is a genuine, still-open data-*accuracy* risk the received attorney opinion was never asked about and does not touch — the opinion is scoped entirely to privilege and to the discriminatory-owner-instruction note; it says nothing about whether the model's read of resolution status on old mail is reliable. Both Asimov's and Mason's confirmation passes on the opinion independently agree this carve-out stays exactly as built (Asimov's confirmation, Item 3; Mason's confirmation, Finding 4).

These must be surfaced as a discrete list Peter or the DO must **affirmatively clear**, with the review itself logged (mirroring the `dismissed_at`/`dismissed_by`/`dismissal_reason` pattern already used elsewhere in this schema, but distinct from a plain dismiss — clearing this checklist is an attestation "a human looked at this," not "this isn't interesting"). Implementation: a computed view, `complaints_historical_review_required`, following this schema's existing "computed live, never a stored flag" convention (`complaints_needing_attention`), plus `historical_review_cleared_at`/`historical_review_cleared_by` columns on `complaints` (nullable; meaningful only for rows the view would otherwise include). Everything else historical — routine, or genuinely resolved — stays in the plain, passive, dismiss/reinstate model.

**A second, lighter treatment for historical `owner_instruction_rejected = 'true'` — tag, reachable source, and a reliance gate at the point of use, not affirmative clearance.** This criterion is deliberately **not** on the `complaints_historical_review_required` list above, and does not require Peter or the DO to individually clear each row — a real change from this document's own prior revision. This relaxation is Asimov's own independent judgment after reviewing the received opinion (his confirmation, Item 3), and Mason's confirmation separately agrees it is not in tension with the opinion's own framework (his confirmation, Finding 2 and Finding 4): the opinion's preferred safeguard (Section 9, "Human Review Should Be Triggered by Use, Not Necessarily Creation") is a better-fitted control for this specific risk than a pre-visibility clearance obligation, because it puts the human check at the moment someone actually proposes to act on the finding, rather than at a moment that may never correspond to real use. Structurally, this criterion is covered by three things instead:
- **The tag.** Every such note carries "Automated historical assessment — not human verified" as part of the stored `note_text` itself (Section 3, Section 5) — not a separate flag someone has to remember to check, and not only a UI badge.
- **The always-reachable source.** Already true by construction in this design — the finding lives on the same `missive_conversation_significance`/`complaints` row as the conversation reference; nothing about this relaxation changes that.
- **A reliance gate, written down here as a standing rule.** Before a historical `owner_instruction_rejected = 'true'` finding is used for any consequential action regarding the named owner — terminating the relationship, accusing them of discrimination, responding to litigation or discovery, disciplining an employee, reporting externally — a human reviews the underlying communication itself, not just the AI note, first. Nothing in this build takes any such action today — no message goes out, no housing decision is made anywhere in this design — so this is a rule for whatever tool or process next reads this table for such a purpose, not code this build has to enforce. It belongs, longer-term, as a line in `GOVERNANCE.md`'s Fair Housing Standard as well, since it will outlive this one build — that addition is a separate governance-document change for Peter/Asimov to make, not part of this technical spec.

This criterion's count is still reported — just informationally, not as a clearance obligation — in the same one-time active notification described below, alongside the `legal_exposure`/`accommodation_related` clearance-list count and the "Needs a Human Call" queue count.

**Pre-existing typo, fixed here.** The criterion above previously read `category IN ('legal_exposure', 'major_money_property_risk')` — but `major_money_property_risk` is one of the five `escalation_signal` values (Section 5), never a `category` value in this shared taxonomy (Section 7); as written it could never have matched a real row. Corrected to put it where the next paragraph's own "deliberately narrower" accounting already implied it belonged: under `escalation_signal`, alongside `blocked_resolution`.

**This checklist's own category/signal list stays deliberately narrower than `is_big_issue` in general** — it omits the `owner_instruction` category *at large*, the `churn_risk`/`escalation_recurrence` signals, bare `human_confirmed_big_issue` confirmations, and — following the relaxation above — historical `owner_instruction_rejected = 'true'` findings specifically, which now get the lighter tag/reachable-source/reliance-gate treatment instead of affirmative clearance. A mandatory-clearance requirement is a heavier obligation than mere visibility, and nothing here widens it just because `is_big_issue`'s underlying conditions changed, or because a different criterion needed a different kind of safeguard; the two remain related but not the same test.

**A real, active bound on both mandatory review surfaces, plus one informational count — required before build (Asimov's Finding 3, his required item 4; updated per his confirmation, Item 4).** Neither the `complaints_historical_review_required` checklist above nor the "Needs a Human Call" queue below is a passive view someone has to think to open. When the one-time historical backfill run completes, if either is non-empty, the system sends one real, outbound notification — through whatever channel Peter already uses for this kind of out-of-Hub compliance nudge. This follows the same posture Peter already set, explicitly, for privilege escalation in the held-release review: *"no escalation tool for this. escalation will happen outside of the hub"* — no new in-Hub badge invented to satisfy this requirement; the obligation to look is delivered to Peter/the DO through their existing channel outside the software, the same way it already is for privilege concerns. The notification names **three** counts: rows on `complaints_historical_review_required` (the still-mandatory `legal_exposure`/`accommodation_related` clearance list); rows in the "Needs a Human Call" queue; and, informationally only, how many historical `owner_instruction_rejected = TRUE` findings exist — not because anyone must clear each one before it's visible, but because this is exactly the kind of bulk compliance signal a reasonable operator wants pushed to them (Asimov's confirmation, Item 4). It links directly to the first two; the third links to the Historical Backlog tab filtered to `owner_instruction_rejected = TRUE`, since those findings are already fully visible there (Section 9) without requiring the informational count itself to be a clearance obligation. It fires once per backfill run — not on a recurring schedule, and not re-sent every time someone opens this document — a one-time push at the moment the backlog is created. This is a real build requirement for Q to implement, not a nice-to-have.

**Item 12 (Section 11) — this checklist and the "Needs a Human Call" review queue above remain related but distinct — not the same mechanism, and not to be merged.** They cover disjoint populations and answer different questions:
- This checklist only ever applies to a row that is **already** `is_big_issue = TRUE` through category or `escalation_signal` (condition 1 or 2 above), is historical, and is still open/unknown. Its question is **"did a human actually look at this"** — an attestation layered on top of a significance decision the system already made on its own.
- The new review queue only ever applies to a row where `needs_human_call = TRUE` and **neither** condition 1 nor 2 is true — i.e. the AI's uncertainty flag is the row's *only* signal. Its question is **"is this actually a big issue at all"** — a significance decision that has not yet been made.

A row can never be subject to both at once. Because they answer different questions over disjoint rows, merging them into one mechanism would blur "somebody looked" with "somebody decided this matters" — exactly the kind of undifferentiated overlap worth avoiding. What they should share is the same interaction pattern — a bounded pending list, mandatory logged reasons, bulk action, and the active-notification bound above — reused from the Fair Housing tab in both cases, so Peter and the DO learn one review pattern, not two. Historical `owner_instruction_rejected = 'true'` findings sit outside both of these mechanisms entirely, per the lighter tag/reliance-gate treatment above — they are not a third trigger onto the checklist, and not a member of the review queue either; they are fully visible wherever `is_big_issue` is read (via the `owner_instruction` category, condition 1) from the moment Call 2 writes the row, carrying their mandatory label, with no further gate of any kind.

---

## 7. Schema (for Neo to finalize)

**A build-mechanics note before the SQL:** `20260910000000_complaint_tracking_schema.sql` has never been applied — nothing in the live database depends on it, and it now sits behind several migrations that *have* been applied since (including two same-timestamp collisions already reconciled once in this repo — see `20260912050000_reconcile_20260912040000_timestamp_collision.sql`). The clean path is **one fresh migration, timestamped after today's latest, creating `missive_message_links`, `missive_conversation_significance`, and `complaints` (merged shape) together, in dependency order** — not a second migration layering `ALTER TABLE` statements onto a file that was itself never run, which would force Peter to apply two files by hand in a specific order via the SQL Editor with nothing enforcing that order. `20260910000000_complaint_tracking_schema.sql`'s own header should be marked superseded/do-not-apply.

### `missive_message_links` — unchanged from v1

No structural change. `subject_type` already includes `'vendor'`; `match_method` already distinguishes `address_match`/`content_extracted`. This is the table Section 4's subject-resolution rule reads from.

### `missive_conversation_significance` — extended

```sql
CREATE TABLE IF NOT EXISTS missive_conversation_significance (
  id                       UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_key              TEXT          NOT NULL,
  missive_conversation_id  TEXT          NOT NULL,

  -- Call 1 — unchanged in kind from v1, "category" is now the shared
  -- 8-value topic taxonomy referenced throughout this document.
  resolution_status         TEXT         NOT NULL CHECK (resolution_status IN ('open', 'resolved', 'unknown')),
  category                   TEXT        NOT NULL CHECK (category IN (
                                 'routine_logistics','maintenance_standard','dispute','safety_issue',
                                 'legal_exposure','accommodation_related','owner_instruction','other'
                               )),
  why                          TEXT,
  tone_trend                    TEXT      CHECK (tone_trend IS NULL OR tone_trend IN ('stable','escalating')),
  protected_class_flag            BOOLEAN NOT NULL DEFAULT FALSE,  -- fail-closed-to-TRUE on a partial-parse failure (Section 5)
  protected_class_category         TEXT,

  -- checkClaim() layer — NEW, resolves Mason's Finding 3. content-check.js's
  -- real, independent Tier A/Tier B keyword+AI check, called separately from
  -- Call 1's own self-report above, exactly as process-pending-messages.js
  -- calls it today (Section 5). Never overwrites protected_class_flag/
  -- protected_class_category — the two layers are stored side by side so a
  -- divergence between the model's self-read and this independent check
  -- stays visible.
  keyword_check_flagged_protected_class BOOLEAN NOT NULL DEFAULT FALSE,
  keyword_check_flagged_category        TEXT,
  keyword_check_matched_layer           TEXT,
  keyword_check_terms_version           TEXT,

  -- pattern — unchanged deferral, PLUS one new, cheap, deterministic
  -- upgrade path (Section 7's "recurrence" note below).
  pattern                     TEXT       NOT NULL DEFAULT 'unknown'
                                 CHECK (pattern IN ('first_occurrence', 'possible_recurrence', 'unknown')),

  content_identification_attempted BOOLEAN NOT NULL DEFAULT FALSE,
  source_screening_completed_at TIMESTAMPTZ NOT NULL,

  -- Call 2 — new. NULL in every column below means "Call 2 has not run
  -- (or not yet completed) against this row" — distinct from
  -- escalation_signal = 'none', which means Call 2 ran and found nothing.
  escalation_signal              TEXT     CHECK (escalation_signal IS NULL OR escalation_signal IN (
                                    'blocked_resolution','churn_risk','escalation_recurrence',
                                    'major_money_property_risk','none'
                                  )),
  needs_human_call                BOOLEAN NOT NULL DEFAULT FALSE,
  blocked_reason                    TEXT  CHECK (blocked_reason IS NULL OR blocked_reason IN ('explicit_refusal','inferred_from_silence')),
  blocked_party                      TEXT CHECK (blocked_party IS NULL OR blocked_party IN ('owner','tenant')),
  owner_instruction_rejected           TEXT CHECK (owner_instruction_rejected IS NULL OR owner_instruction_rejected IN ('true','false','uncertain')),  -- tri-state, per Mason's Finding 2 — widened from BOOLEAN because historical mail can now answer "uncertain"; live mail only ever answers true/false, unchanged from complaint-tracking's original design. NULL means Call 2 hasn't evaluated this field (category isn't owner_instruction, or Call 2 hasn't run). Exact typing for Neo to finalize; this is the simplest option that supports a real third state without overloading NULL.
  owner_instruction_note_text           TEXT,  -- AI-drafted and auto-populated for live mail always, and for historical mail whenever owner_instruction_rejected = 'true' (Section 3, Section 5) — carrying the mandatory "Automated historical assessment — not human verified" label as part of the stored text. NULL for historical mail when owner_instruction_rejected is 'false' or 'uncertain' — the received opinion authorizes the discriminatory-instruction note specifically, not a non-discriminatory or genuinely ambiguous historical read. No human reviews or writes this note before it's created; a human reviews the underlying thread only before relying on it for a consequential action (Section 6) — no separate attribution columns are needed here the way human_confirmed_big_issue needed its own, because no human decision is being recorded on this column at all.
  call2_completed_at                      TIMESTAMPTZ,  -- NULL = never attempted OR attempted-and-failed (Section 5's fail-closed posture); set only on a genuinely successful, fully-parsed Call 2 response — this is Call 2's own retry-driver check, same role source_screening_completed_at plays for staleness.

  -- human_confirmed_big_issue — NEW, Peter's second same-day correction
  -- to is_big_issue (Section 6). A human-only override; never written by
  -- either AI call. Tri-state, deliberately: NULL = not yet reviewed
  -- (the only state that makes a row appear in the "Needs a Human Call"
  -- queue, Section 6/9); TRUE = a human reviewed and confirmed this is a
  -- big issue; FALSE = a human reviewed and rejected it. FALSE is a
  -- distinct, explicit state rather than reusing NULL, or reusing the
  -- existing dismissed_at/dismissed_by/dismissal_reason columns below —
  -- Oracle's own call, made here rather than left to Q: those columns
  -- already carry a different, established meaning elsewhere on this
  -- same table (a passive "hide this" toggle for significance-only
  -- items, Section 9's "Closing an item"), and reusing them here would
  -- collapse "a human looked at this and it's not a big issue" into
  -- "nobody's looking at this," a materially different fact worth being
  -- able to tell apart later. Meaningful only when needs_human_call =
  -- TRUE and neither of is_big_issue's other two conditions holds — see
  -- the review-queue's own pending-list filter, Section 6.
  human_confirmed_big_issue        BOOLEAN,
  human_confirmed_big_issue_at     TIMESTAMPTZ,   -- set together with the two columns below, all four or none (new CHECK below) — same lockstep-attribution discipline archive_search_flagged_overrides.overridden_at/by and the Escalations table's resolved_at/by already use for every other human decision in this codebase, extended here rather than left as a bare, unattributed boolean.
  human_confirmed_big_issue_by     TEXT,
  human_confirmed_big_issue_reason TEXT,

  -- is_big_issue — CORRECTED by Peter, 2026-09-13, replacing this
  -- document's earlier "non-routine AND unresolved" surfacing rule
  -- (Section 6), then corrected a SECOND time the same day: condition 3
  -- is now human_confirmed_big_issue = TRUE, never needs_human_call
  -- directly — an AI uncertainty flag alone routes to human review
  -- (Section 6/9) instead of auto-promoting. Computed once, stored, so
  -- Property 360 and both compliance-review.html tabs all agree by
  -- construction rather than re-deriving this logic in N places — same
  -- precedent, same table-local GENERATED ALWAYS ... STORED pattern, as
  -- complaints.is_big_deal (20260910000000_complaint_tracking_schema.sql).
  -- Deliberately NOT a function of resolution_status or discovery_context.
  -- Note for Neo/Q: the third clause is deliberately `IS TRUE`, not
  -- `= TRUE`. `human_confirmed_big_issue = TRUE` evaluates to NULL (not
  -- FALSE) for every not-yet-reviewed row, since the column is NULL —
  -- three-valued SQL logic would then make the whole OR expression NULL,
  -- not FALSE, for any row where category/escalation_signal also don't
  -- qualify, i.e. most of the archive. `IS TRUE` treats NULL as "not
  -- true" the way this flag needs, so is_big_issue is always a real
  -- TRUE/FALSE, never a silent NULL.
  is_big_issue                     BOOLEAN GENERATED ALWAYS AS (
                                      category IN ('legal_exposure', 'owner_instruction')
                                      OR escalation_signal IN (
                                           'blocked_resolution', 'churn_risk',
                                           'escalation_recurrence', 'major_money_property_risk'
                                         )
                                      OR human_confirmed_big_issue IS TRUE
                                    ) STORED,

  -- New provenance/routing fields (Section 6).
  discovery_context               TEXT    NOT NULL CHECK (discovery_context IN ('live_pipeline','historical_backfill')),
  complaint_id                     UUID    REFERENCES complaints(id) ON DELETE SET NULL,  -- nullable, one-way — see note below

  -- Versioning — collapsed (Section 7's versioning note below).
  extracted_by                  TEXT     NOT NULL,  -- CONTENT_PASS_VERSION string; replaces both extracted_by and significance_pass_version from v1
  computed_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  dismissed_at                TIMESTAMPTZ,
  dismissed_by                 TEXT,
  dismissal_reason               TEXT,

  UNIQUE (mailbox_key, missive_conversation_id)
);
-- significance_pass_version is DROPPED relative to v1's draft (see
-- "Versioning" below) — extracted_by now carries the one string that
-- describes the single, un-splittable prompt text both calls live in.
```

`ADD CONSTRAINT missive_conversation_significance_dismissal_reason_required` (unchanged from v1) and the two `content_extracted`/`address_match` CHECKs on `missive_message_links` (unchanged) still apply.

**New constraint, added by this correction:** `CONSTRAINT missive_conversation_significance_human_confirmation_together CHECK ((human_confirmed_big_issue IS NULL AND human_confirmed_big_issue_at IS NULL AND human_confirmed_big_issue_by IS NULL AND human_confirmed_big_issue_reason IS NULL) OR (human_confirmed_big_issue IS NOT NULL AND human_confirmed_big_issue_at IS NOT NULL AND human_confirmed_big_issue_by IS NOT NULL AND human_confirmed_big_issue_reason IS NOT NULL AND human_confirmed_big_issue_reason <> ''))` — either all four columns are unset (not yet reviewed) or all four are set together with a non-empty reason, at the database level, the same defense-in-depth discipline `archive_search_flagged_overrides_revocation_fields_together` and the Escalations table's own lockstep CHECKs already apply to every other human decision in this codebase. Prevents a `TRUE`/`FALSE` value from ever being written without who and why attached.

**`complaint_id` — nullable, one-way, no reciprocal pointer.** Set only when Call 2 produced something actionable and a `complaints` row was created. Mirrors `complaints.proposed_operational_note_id → operational_notes` — the same directional, no-reciprocal-reference pattern this codebase already uses. **Why two tables, not one, and why this pointer instead of a merge (real architectural finding, not a stylistic call):** `complaints` is admin/`director_of_operations`-only, has resolved-retention-with-a-note-required CCPA redaction, and a real self-referential duplicate/merge lifecycle; `significance` is `searcher`-readable, dismiss/reinstate-only, and its own CCPA redaction posture is still an open question (Section 11, Item 8, carried over from v1). Forcing both lifecycles onto one row means either the stricter access/redaction policy leaks onto data that never needed it, or column-level RLS has to be invented to route around it — both worse than two tables with two already-reasoned-through postures.

**`is_big_issue` lives here, not on `complaints`, and not as a view — resolved concretely, since Peter's correction asked for exactly this.** `category`, `escalation_signal`, and `human_confirmed_big_issue` all live as real, permanent columns on this same `missive_conversation_significance` row (above) — they are never only transient Call 2 output that gets discarded once written to `complaints`. That makes a table-local `GENERATED ALWAYS ... STORED` column the clean, direct choice, with no view or cross-table predicate needed, and no ambiguity to leave open. It has to live here rather than on `complaints` because `complaints` only ever holds the subset of conversations where Call 2 already found something actionable (`escalation_signal != 'none'`, `needs_human_call`, `owner_instruction_rejected`, or — per this revision's Section 4 fix — `category IN ('legal_exposure', 'owner_instruction')` alone; Section 4). Even with that fix, a conversation can still be `is_big_issue = TRUE` purely because a human confirmed it via the "Needs a Human Call" queue (`human_confirmed_big_issue = TRUE`, Section 6), with no qualifying category or `escalation_signal` — and that path still never creates a `complaints` row. Property 360 and `compliance-review.html` must therefore read `is_big_issue` off `missive_conversation_significance` directly, not off the existence of a linked `complaints` row — this human-confirmed path is the one case where the two now diverge (Section 11 Item 13, resolved by this revision for the category-alone case, narrowed to just this remaining one).

### `complaints` — changes relative to the never-applied `20260910000000` draft

Everything not listed below carries forward unchanged (the polymorphic `subject_type`/`subject_id`, `vendor_id`, `status` lifecycle, `held_legal_fair_housing`, duplicate/merge columns, `owner_team_member_id`/`delegated_to_team_member_id`, the `is_big_deal` generated column, RLS/audit conventions, Design Decisions 11/13/14/15 of the original technical spec).

1. **`category`'s CHECK constraint is replaced.** The old 6-value complaint-tracking-only enum (`legal_compliance`, `blocked_resolution`, `churn_risk`, `escalation_recurrence`, `major_money_property_risk`, `owner_instruction_one_off`) is retired. `complaints.category` now uses the same shared 8-value topic taxonomy as `missive_conversation_significance.category` — `legal_compliance` folds into `legal_exposure` (same meaning, one name); `owner_instruction_one_off` folds into `owner_instruction`, with the discriminatory-instruction handling becoming the conditional `owner_instruction_rejected` sub-field, not its own category value.
2. **New column:** `escalation_signal TEXT CHECK (escalation_signal IN ('blocked_resolution','churn_risk','escalation_recurrence','major_money_property_risk'))` — NOT NULL-able as 'none' here, because a 'none' result never creates a `complaints` row in the first place (Section 4); every row that exists in this table has a real reason.
3. **New column:** `discovery_context TEXT NOT NULL CHECK (discovery_context IN ('live_pipeline','historical_backfill'))` — Section 6.
4. **New columns:** `historical_review_cleared_at TIMESTAMPTZ`, `historical_review_cleared_by TEXT` — Section 6's bounded checklist.
5. **`complaints_config_required_unless_held` is extended, not replaced.** Duplicate detection and `complaint_tracking_config_id` were tuned for live, day-to-day decisions (`duplicate_window_days = 3` is meaningless against a 2022 email — a real finding from the architecture review, not a hypothetical). Extend the existing held-row exemption to also exempt `discovery_context = 'historical_backfill'` rows: `CHECK (held_legal_fair_housing = TRUE OR discovery_context = 'historical_backfill' OR complaint_tracking_config_id IS NOT NULL)`. Historical rows correctly carry no threshold version, the same honest reason held rows already don't.
6. **`extracted_by` now stores `CONTENT_PASS_VERSION`, not `CLASSIFIER_VERSION`** — see "Versioning" below.
7. **The `held_legal_fair_housing` / `status = 'held'` path has no clear owner in the merged pipeline — flagged, not resolved, here.** Complaint-tracking's own hold placeholder existed because its pipeline called `privilege-filter.js`'s `checkThread()` directly, on raw, unscreened content, before any AI read it for meaning. This merge retires that call (Section 8) — the merged pass only ever reads `missive_message_intake_search_safe`, which has been through archive-search's Fair Housing screen and *only* that screen (Section 1, point 2: the legal-hold bucket was deliberately removed from archive-search itself, on the theory that search access doesn't need it). Attorney-client privilege and Fair Housing protected-class status are different things; removing one filter's target from search doesn't settle whether an AI reading for `legal_exposure` needs a privilege pre-filter of its own. **This document does not resolve this — it is a new item for Asimov and Mason (Section 12), not something Q should build around by assumption.**
8. **`owner_instruction_rejected`'s type widens to match `missive_conversation_significance` (Section 7 above)** — `TEXT CHECK (... IN ('true','false','uncertain'))` rather than `BOOLEAN`, for the same reason: a historical `owner_instruction` conversation can now reach `complaints` with an `uncertain` read (change #1 above plus this revision's Section 4 fix mean every historical `owner_instruction`-categorized conversation gets a `complaints` row, not only rejected ones). `note_text`/`owner_instruction_note_text` on this table follows the same live-drafted/historical-drafted-when-true split as Section 7's significance table above — auto-drafted for live mail always, and for historical mail whenever `owner_instruction_rejected = 'true'`, carrying the mandatory "Automated historical assessment — not human verified" label; NULL otherwise.

### Versioning — collapsed, per the architecture review's own finding

v1 required two separately-bumped strings (`extracted_by`/`CLASSIFIER_VERSION` and `significance_pass_version`) that would always change together once one prompt produces both calls' output — itself a code smell (two `NOT NULL` columns that must always hold matching content are a bug waiting to diverge). **v2 collapses to one shared constant, `CONTENT_PASS_VERSION`**, defined once in the new merged prompt module and written identically into `complaints.extracted_by`, `missive_message_links.extracted_by` (content_extracted rows), and `missive_conversation_significance.extracted_by`. `SCREENING_VERSION` (Fair Housing) stays fully independent — it gates *eligibility* into this pass, unrelated to this pass's own content, and is untouched by this change.

### `pattern` — a small, real, non-AI upgrade; full recurrence stays deferred

**`escalation_recurrence` and `pattern` are not the same concept at different maturity levels — a real, important distinction the architecture review caught that the merge proposal's own premise got wrong.** `categorize-complaint.js`'s real prompt scopes `escalation_recurrence` to what a single thread's own text admits ("do not guess at history you can't see in this thread") — it needs no cross-referencing and already works, unmerged, today. `pattern` is inherently the cross-thread problem (has this come up in a *different* conversation), which this spec's v1 correctly deferred. Do not build one shared "recurrence engine" for both.

What *is* newly buildable, now that `missive_message_links` exists: a plain SQL count — how many other `missive_conversation_significance` rows share the same `subject_id`/`property_id` (via `missive_message_links`) with a similar `category`, within N months — used only to move `pattern` from `'unknown'` to `'possible_recurrence'`. Never a confident "confirmed," never auto-escalating anything. This is a deterministic resolution step, the same "AI proposes text, code resolves relationships" discipline already used for property/tenant matching — not a new AI judgment, and not full recurrence detection.

---

## 8. Retiring Complaint-Tracking's Own Pipeline

**Once this merges, `categorize-complaint.js` and `process-pending-messages.js` are retired, not left running alongside the merged pass.** This needs to be stated plainly because the failure mode of *not* doing this is already partly true today, not hypothetical: running two independent categorizers against the same mail — one via the old `pipeline_status = 'pending'` trigger, one via the new merged pass — produces silent disagreement with no reconciliation surface (a live thread could show "Blocked" on one tool's tile and a plain open maintenance tag on another's, with neither UI aware the other tag exists), and the old trigger is already effectively starved by the Fair Housing pass's side effect on `pipeline_status` (Section 2) — this isn't a future risk introduced by the merge, it is already true today, independent of anything this document does.

The new merged pass's own driver query (Section 4) replaces `process-pending-messages.js`'s query entirely, for both the backfill and all future live mail. `subject-match.js`'s deterministic address-match logic is retained and reused (Section 4's subject-resolution rule).

**Correction, per Asimov's fresh review (Finding 5) — this is not just retiring "an AI-categorization call and its own driver query," full stop.** `process-pending-messages.js` was also the only caller anywhere in this codebase of `privilege-filter.js`'s `checkThread()` ahead of an AI reading this content for meaning (Section 1, point 2; Mason's and Asimov's Finding 1). Retiring it retires that privilege gate along with the AI call — the two were never separable, because complaint-tracking's own pipeline called `checkThread()` as its own first step, before any categorization. This does not reverse the decision to retire the pipeline: Asimov agrees retiring it is still the right call, since running two independent categorizers against the same mail is a real, already-materializing failure mode on its own (previous paragraph). It corrects an understated description of what's actually being given up — which is exactly why the privilege attorney question (`compliance/archive-search-significance-privilege-attorney-question.md`, drafted and pending Peter's send) is required before this ships.

**A real operational consequence, worth naming to Asimov explicitly rather than leaving as a silent side effect:** new mail's eligibility for six-category triage now depends on archive-search's own Fair Housing screening pass having run on it first — and that screening pass is itself manually-triggered, with no automatic schedule, exactly like complaint-tracking's own pipeline was designed to be. A `legal_exposure`-worthy new email now only gets triaged once **both** the screening batch and the merged categorization batch have run, in that order, rather than complaint-tracking's own independent `checkThread()` call catching it on its own first run. This is a new latency chain between two previously-independent pipelines. Whether both batches need to run on the same or a tighter cadence going forward — or whether the merged pass should trigger archive-search's screening as a preliminary step of its own manually-triggered call, rather than assuming it already ran — is a real decision for Asimov to sign off on, named here explicitly (Section 12), not something this document resolves on Peter's behalf.

---

## 9. Where This Surfaces

**New mail, Call-2-flagged — unchanged from complaint-tracking's own existing design, now fed by the shared call:** home-page red-badge tile (live count, hard-scoped to `discovery_context = 'live_pipeline'` per Section 6 so a historical backfill run can never inflate it), assigned to the DO via `owner_team_member_id`, 24-hour aging nudge, exactly as `complaint-tracking-technical-spec.md`'s Design Decisions 11/12 already specify.

**Historical hits — two homes, and they should NOT use the same interaction model for closing an item out (a real product finding: complaint-tracking's admin/DO-only, resolution-note-required workflow and significance's searcher-level dismiss/reinstate toggle are two different products' worth of interaction design, and nothing in either source document decided which one governs a historical six-category item until now):**

1. **A new "Historical Backlog" tab inside `compliance-review.html`'s existing tab-bar** (`Fair Housing` / `Escalations` / `Legal Hold` today — the exact `<div class="tab-bar" role="tablist">` / `<button class="tab-btn" data-tab="...">` mechanism already live in that file) — parallel to, **never merged with**, a live "Needs Attention" tab covering the same surface for new mail. **Both tabs list exactly the same thing — rows where `is_big_issue = TRUE` (Section 6) — split only by `discovery_context`:** this tab shows `historical_backfill`, the live tab shows `live_pipeline`. Neither tab re-derives its own notion of what counts; both read the one flag. This tab needs its own progress affordance beyond the live dashboard's simple "big-deal-up-top, routine-behind-a-dropdown" split (`index.html` ~line 601) — a per-property or per-category count with a reviewed/not-yet-reviewed toggle, sortable by property, since a multi-thousand-row day-one backlog surfaced to a two-person access model with no sense of "how much is left" is its own failure mode (Section 11, rollout).
2. **On Property 360, unlike `compliance-review.html`, live and historical items merge into one "Needs Attention" card** — filtered the same way (`is_big_issue = TRUE`), just not split by `discovery_context` the way `compliance-review.html`'s two tabs are. Full context about a property matters regardless of when an item was discovered, so splitting them here would work against the "full context" goal Peter stated for wanting this in the first place. Badge each item's provenance instead of separating them (next point).

**Every historical item carries a permanent, visible provenance label — never silently indistinguishable from a live item:** a neutral badge, e.g. "Historical — found in archive review, [date]," next to the category badge. On Property 360 and in any list view, sort/group live items above historical ones by default rather than interleaving by original message date, which would otherwise bury every live item under years of backlog.

**Resolution status must visually distinguish an AI guess from a human-confirmed close.** The prompt already tells the model never to over-claim resolution from silence alone — but that discipline is invisible to a reader. An AI-inferred "resolved" renders as something like *"AI read: appears resolved — not confirmed,"* distinct from the live workflow's solid "Resolved" badge, which already requires a human-written resolution note (`complaints_resolved_requires_note`). A one-click "Confirm resolved" action upgrades the AI guess to human-attested — the two must never be allowed to look the same.

**Closing an item.** A historical, significance-only item stays a lightweight dismiss/reinstate toggle, `searcher`-level, exactly as v1 specified. A historical item that graduated into the bounded human-review checklist (Section 6) or into `complaints` proper requires the heavier resolution-note workflow — the same one live items already use.

**A third home, for conversations `is_big_issue` hasn't decided on at all — the "Needs a Human Call" tab.** Unlike the two homes above, which both require `is_big_issue = TRUE` already, this fourth `compliance-review.html` tab holds conversations where `needs_human_call = TRUE` and neither `category` nor `escalation_signal` already qualifies them (Section 6). It is not split by `discovery_context` the way the Historical Backlog/Needs Attention tabs are — live and historical items sit in the same pending list, for the same reason Fair Housing flags aren't split that way either: an AI confidence flag isn't a timing question. Full mechanism, including how this differs from Section 6's own mandatory-clearance checklist, is in Section 6.

**`needs_human_call` gets its own badge, carried forward unchanged in spirit but with a corrected role** — complaint-tracking's live dashboard already has one (`badge-soft-amber`, "Needs a Human Call"); this must not quietly disappear in the merge, since the 250,000-conversation historical pass is exactly the highest-volume, hardest-to-verify run this flag will ever need to do its job on. **What changes (Section 6's second same-day correction):** the badge still renders wherever a conversation carrying `needs_human_call = TRUE` is shown, but a conversation whose *only* qualifying signal is `needs_human_call` no longer reaches Property 360 or either surfacing tab on its own — it lives in the new "Needs a Human Call" tab above until a human sets `human_confirmed_big_issue`. Once confirmed, the badge and the conversation both appear everywhere `is_big_issue` is read, same as any other big issue; the badge itself never changes meaning, only when the conversation becomes visible alongside it.

**`owner_instruction_rejected` historical items render read-only, with no "respond" affordance** — the live version's note text documents what staff should say if they haven't already; for a historical item the underlying conversation is over, and an actionable-looking "respond" button would be nonsensical against a closed, years-old thread. **Per this revision's Section 5 fix (reinstated per the received outside-counsel opinion), a historical item's `note_text` is auto-drafted whenever `owner_instruction_rejected = true`,** and renders exactly as drafted, with its mandatory "Automated historical assessment — not human verified" label visually distinct from the live version's staff-facing script — a different visual treatment than any human-authored note elsewhere in this design, since no human wrote or approved this text. For `owner_instruction_rejected = 'false'` or `'uncertain'` on historical mail, `note_text` stays NULL and renders as "no note generated" — there is nothing here for a human to write in by hand; Section 6's lighter reliance-gate rule, not a checklist review UI, governs when a human looks at the underlying thread for this criterion.

**Property 360 scope — CORRECTED by Peter, 2026-09-13, replacing this section's earlier "non-routine, unresolved/needs-attention" wording with the actual rule, `is_big_issue` (Section 6).** The card shows only conversations where `is_big_issue = TRUE` — regardless of `resolution_status`. Being merely unresolved was never, by itself, enough; being one of the two dedicated categories, carrying a real escalation signal, or a human confirming that an honest AI uncertainty flag (`needs_human_call`) really is a big issue (`human_confirmed_big_issue`, Section 6) is what makes something a big issue — not whether it happens to still be open. A big issue that is later marked resolved does not drop off the card — it stays visible, collapsed/deprioritized below open big issues (Section 11, Item 1), because the point of Property 360 is full context on a property regardless of timing. Everything that is not a big issue — an ordinary open `dispute`, `safety_issue`, or `maintenance_standard` conversation, however long it's been open — stays exactly where routine/resolved content already stays: search-only, never listed on the property page at all. The looser alternative (a full collapsed history including routine/resolved, under a toggle) is still rejected — not a fallback, not still on the table.

**Search vs. tags — stated explicitly since this merge adds real new tag content:** full-text search over subject/body already exists and is unchanged by anything in this document. Tags are additive — they let results be filtered, and they surface the minority of things nobody would think to search for. Tags never gate or replace search, and nothing in this merge changes that relationship.

---

## 10. Processing Method and Rollout

**Finalized by Peter, 2026-09-13 — the historical backfill runs in two phases, on two different processing methods, for two different reasons. This is the confirmed, final design, not an open question anymore.**

**Phase 1 — the pilot: 100 conversations, possibly 200, processed synchronously, in real time, per conversation — the same pattern the existing screening pass already uses today.** Peter's own direction: the pilot runs through the existing synchronous per-conversation loop (`screening-pass.js`/`process-pending-messages.js`'s own pattern), **explicitly not** the Batches API described in Phase 2 below. The reason is speed, not cost: the entire point of the pilot is for Peter to actually look at the results quickly, by hand, before deciding whether to expand — and at a scale of 100-200 calls, the cost difference between synchronous and batch processing is negligible, not worth trading turnaround time away for. This pilot batch is the same 100 (possibly 200) conversations that serve as this build's shadow-mode/sampling exit criterion under GOVERNANCE.md Rule 6 — see Section 12 for the exact sizing, the review process, and the rule that expansion past this batch requires Peter's own go-ahead, not an automatic trigger.

**Phase 2 — the full-scale run, once Peter reviews the pilot and gives the go-ahead to expand: the remaining ~249,850 conversations, via Anthropic's Message Batches API.** This is unchanged from — and cross-referenced to, not re-derived from — this section's own original recommendation from the AI reliability/cost lens of the six-lens design review (front matter, above): not the existing synchronous per-conversation loop, whose `SCREENING_PASS_CHUNK_SIZE = 500` sizing exists specifically to stay inside one HTTP request's timeout — a design for staying inside a request window, not for throughput across a quarter million conversations with a heavier, multi-field call. The Batches API is built for exactly this shape of large, non-time-sensitive job and doesn't require holding a live connection open per chunk. At this scale, unlike the 100-200-conversation pilot above, the cost difference between the two methods is real money — which is exactly why Phase 2, and only Phase 2, makes the switch.

**Ongoing, forward-looking (new mail):** keep the existing synchronous, manually-triggered loop — low volume, no reason to change it. Unaffected by either phase above; this governs live mail only, never the historical backfill.

**Explicit requirement, both phases, restated because this codebase has a real, live precedent for getting it wrong: every part of this pass — the pilot, the full-scale Batches-API run, and the ongoing forward-looking loop — runs entirely on sally.** None of it runs on Peter's laptop, in any form, at any point — not as a one-off manual trigger, not as a background process, not even temporarily during development. This is not a new rule invented for this document; it is the exact same requirement the original Fair Housing screening pass was corrected to follow after running locally by mistake earlier in this project (`/tmp/sally-screening-loop.sh`, launched on sally itself via `nohup ... & disown` specifically so it survives independent of any SSH session or the laptop). Whoever builds this (Q, with Scotty for the actual process/deployment mechanics) must launch and keep every long-running piece of this pass — pilot included — on sally the same way, and this must be independently verified live on the server, not assumed from the code, before anyone is told a run has started.

**What this replaces:** an earlier draft of this section recommended a pilot scoped to "one property, or one date range," with no fixed size, to get a real hit-rate estimate before committing Peter and the DO to an unsized review volume — the review's own back-of-envelope math (even a conservative 0.5–1% "big deal" hit rate across ~250,000 conversations is 1,250–5,000 items appearing at once, for a two-person review team) is exactly the scenario that recommendation was trying to avoid walking into blind. Peter's own pilot size — 100, possibly 200, conversations (Section 12) — supersedes that open-ended recommendation with an actual, fixed number; the underlying reasoning for why a pilot matters at all is unchanged and still applies.

---

## 11. Tradeoffs and Open Questions for Peter

Carried forward from v1 where still open, resolved items removed, new items added and marked.

1. **Resolved by Peter, 2026-09-13 (was: still open, unchanged from v1):** "resolved and done" — hidden, or just deprioritized? **Deprioritized, not hidden.** A big issue (`is_big_issue`, Section 6) that gets marked resolved stays visible on Property 360 and the Historical Backlog tab, collapsed below open big issues — never fully hidden. This confirmation also settles what the Property 360/`compliance-review.html` surfacing filter itself is: `is_big_issue` (Section 6, Section 9) — the draft's earlier "non-routine and unresolved" framing was wrong and is corrected everywhere it appeared.
2. **Still open, unchanged from v1:** does this pass wait for the last 1.4% of the archive, or start now? Recommendation unchanged: start now.
3. **Resolved by this revision:** whether `pattern` gets a first rough cross-conversation attempt — yes, the cheap deterministic count described in Section 7, not full AI-driven recurrence.
4. **New — access, given the "Needs Attention"/"Historical Backlog" tabs are a genuinely new lens.** Outside counsel's reasoning for removing archive-search's own legal hold was that search doesn't expand access beyond what people can already see. A curated "AI decided this needs attention" list, across the whole archive, is a different kind of exposure than a plain search box. Worth Asimov's and Mason's specific read — unchanged concern from v1, now sharper given Call 2's content.
5. **New — the `held_legal_fair_housing` gap (Section 7, item 7).** Retiring complaint-tracking's own pipeline also retires its only attorney-privilege pre-filter. Archive-search's own screening pass has never had one (by deliberate, counsel-reviewed design, for search access specifically). Whether an AI pass that specifically reads for `legal_exposure` and drafts notes needs a privilege pre-filter of its own is a real, new question this document does not resolve.
6. **Resolved by the received outside-counsel opinion and both Asimov's and Mason's confirmation passes on it (was: flagged, not resolved, in the prior revision).** The retroactive `owner_instruction_rejected` wording (Section 3, Section 5) is exactly the fact pattern the opinion's Question Two addresses: an AI-drafted, present-day-assessment note about a historical discriminatory owner instruction, carrying the mandatory "Automated historical assessment — not human verified" designation, may be generated automatically without prior human review. `compliance/archive-search-significance-outside-counsel-opinion.md`; `compliance/archive-search-significance-outside-counsel-asimov-confirmation.md`; `compliance/archive-search-significance-outside-counsel-mason-confirmation.md`.
7. **New — the operational latency chain (Section 8).** New mail's triage now depends on archive-search's own screening pass having run first. Named explicitly for Asimov, not left as a silent side effect.
8. **Carried forward from v1, sharper now:** `source_reference`/`why`/`note_text` all store real quoted/paraphrased tenant/owner correspondence, permanently, in a queryable table — and now `complaints`, not just `significance`, carries some of this same content. A real fact for Asimov's and Mason's Rule 4 review.
9. **Carried forward from v1:** the CCPA/redaction cascade question — if a tenant/owner record is redacted, does `missive_message_links`/`missive_conversation_significance`/`complaints` content naming them need sweeping too? Still not solved here.
10. **Carried forward from v1:** vendor matching is real, live logic with no real vendor data synced yet (Section 3, Item 11 in the original draft) — unchanged; still dormant until an AppFolio→Supabase vendor sync exists.
11. **New — a validation sample specifically before the *combined*, higher-stakes pass is trusted at scale**, not just the plain significance-tagging pass v1 already recommended one for. The Fair Housing hold-check's own residual false-negative risk (already accepted by Peter at trickle scale) compounds when the same "clear" determination now also gates a pass that specifically hunts for `legal_exposure`/`blocked_resolution` and drafts notes. Recommended: make this validation sample a hard precondition for the combined pass specifically, not merely "recommended" the way v1 left it for plain tagging.
12. **Resolved by this same-day correction (was: raised by the `is_big_issue` correction, not resolved here).** Section 6's bounded human-review checklist and the new "Needs a Human Call" review queue (Section 6, Section 9) are **related but distinct — not merged.** The checklist only ever fires on a row already `is_big_issue = TRUE` through category/`escalation_signal` (an attestation that a human looked, layered on a significance decision already made); the queue only ever fires on a row where `needs_human_call` is the *sole* signal (a significance decision not yet made at all). The two triggers are mutually exclusive by construction, so no row is ever subject to both, and merging them would blur "somebody looked" with "somebody decided this matters." They share one interaction pattern — a bounded pending list, mandatory logged reasons, bulk action, reused from the Fair Housing tab — so Peter and the DO learn one review UI, not two. Full reasoning in Section 6.
13. **Resolved by this revision, per Asimov's Finding 3 (his required item 5).** Section 4's `complaints`-creation trigger now also fires on `category IN ('legal_exposure', 'owner_instruction')` alone, for both live and historical mail — so a conversation that is `is_big_issue = TRUE` on category alone reliably reaches the DO assignment, the red-badge tile (live mail only, per Section 6's hard gate), and the aging clock, not just the subset that also trips an escalation signal. The one remaining case where `is_big_issue = TRUE` can exist without a `complaints` row is a human-confirmed "Needs a Human Call" item (`human_confirmed_big_issue = TRUE`) that never separately trips category or `escalation_signal` (Section 7) — that path still only ever reaches Property 360 and the surfacing tabs, never the DO/badge/aging machinery, a deliberate scope call (that queue answers "is this a big issue for Property 360," not "does the DO need to act on it right now"), not an oversight.

---

## 12. Governance — A Fresh Review, Named as a Precondition, Not an Assumption

**This is unambiguously a compliance build, for all the reasons v1 already named** (personal information linking real messages to real tenants/owners/vendors; a significance judgment that changes what staff see and how prominently) **plus, now, complaint-tracking's own three original triggers** (personal data storage; reading real correspondence to drive a triage decision; a path — `owner_instruction` — that can influence how staff treat a tenant or owner).

**Why complaint-tracking's existing 2026-09-10 Asimov/Mason approval does not carry over — stated plainly, not left implicit:** that approval was scoped to a live, low-volume, daily-trickle pipeline, with a shadow-mode plan built around "Peter and the DO review every run's output... not a sample, all of it, since volume is low." Run against a one-time bulk pass over 254,000+ historical conversations, that same design is asked to produce potentially thousands of newly-surfaced items for two people to review in days — its own exit criterion becomes unverifiable without a sampling methodology that review was never designed to include. Separately, and independent of whether the shadow-mode precedent is judged to transfer at all: **GOVERNANCE.md Rule 6 classifies any change to decision criteria or compliance logic as Critical**, requiring attorney review, owner approval, and a shadow-mode period as a hard floor — running six live-triage categories against the entire historical archive is exactly this kind of change, on its own terms, regardless of what was approved in September for a daily trickle.

**Status, updated 2026-09-13 — outside counsel's opinion has now been received, and both Asimov and Mason have completed confirmation passes against it.**

- **The outside-counsel opinion is in and on file:** `compliance/archive-search-significance-outside-counsel-opinion.md`, answering both attorney questions this section previously flagged as pending — the privilege/legal-hold gap, and the retroactive `owner_instruction_rejected` record.
- **Mason's confirmation pass is complete and on file:** `compliance/archive-search-significance-outside-counsel-mason-confirmation.md`. **Verdict: CLEARED WITH CONDITIONS.** The condition: this revision reinstates the AI-drafted historical `owner_instruction_rejected` note (Section 3, Section 5), carrying the mandatory **"Automated historical assessment — not human verified"** label as part of the stored `note_text` itself, per counsel's Question Two answer and Mason's own required wording — done in this revision. (Mason's file also carries a non-blocking build note for Tron/Q — never label a rendered `legal_exposure`/`owner_instruction` field "Attorney Analysis" or "Privileged" — which is a UI build-checklist item, not a further condition on this document.)
- **Asimov's confirmation pass is complete and on file:** `compliance/archive-search-significance-outside-counsel-asimov-confirmation.md`. **Verdict: STILL NOT CLEARED** — but, per Asimov's own accounting, only for reasons that are not legal questions the opinion could resolve:
  1. **Resolved by Peter, 2026-09-13 (was: Peter's own explicit, on-the-record approval of this build's compliance risk — still his to give, not supplied by the opinion or either reviewer).** See "Peter's compliance-risk approval" below.
  2. **Resolved by Peter, 2026-09-13 (was: Peter's choice of a bulk-appropriate shadow-mode/sampling exit criterion — still his to pick, informed but not decided by the smaller risk profile the opinion establishes).** See "Peter's shadow-mode/sampling exit criterion" below.
  3. **Neo's Rule 4 data inventory for the merged schema** — still outstanding, unrelated to anything the opinion addressed. The only one of the three that remains open, and it is Neo's task to produce, not a decision anyone is waiting on from Peter, Asimov, or Mason.

**Peter's compliance-risk approval — Asimov's Item 1, resolved 2026-09-13.** Peter's exact words, given directly, 2026-09-13: *"I've reviewed the opinion and the governance findings, I accept the risk, proceed."* This satisfies Rule 6's owner-approval prong for this specific compliance risk — running six live-triage categories, including automated historical drafting, against the entire historical archive, the Critical-tier change this section's opening paragraph already named. This is a distinct approval from the scope-directive and product decisions already on record elsewhere in this document (e.g., the `is_big_issue` correction and its two same-day corrections, Section 6; the Property 360 scope correction, Section 9) — those were decisions about what the tool does; this is Peter's own acceptance, as owner, of the compliance risk in doing it at all.

**Peter's shadow-mode/sampling exit criterion — Asimov's Item 2, resolved 2026-09-13.** Peter confirmed the exit criterion directly, in these terms (paraphrased faithfully — this was a direction given in conversation, not a single clean quote): the pilot batch of 100 conversations already committed to as this build's bounded rollout pilot (Section 10) is the shadow-mode sample. It is reviewed by hand before anything expands further. Asked whether 100 is enough, Peter's own words: *"good amount. might need another 100."* — an explicit allowance for a second batch of another 100 (200 total) if the first 100 doesn't give a clear enough picture, not a standing invitation to keep sampling indefinitely.

To be precise about what this is and isn't: the exit criterion is **100 (possibly 200) reviewed conversations** — a fixed, bounded count of actual conversations Peter (and/or the DO) looks at by hand — **not a percentage of the ~254,000-conversation archive**, and not a statistical sampling formula. Expansion beyond the pilot to the full-scale run (Section 10, Phase 2) requires Peter's own go-ahead after he's reviewed the pilot's results — it does not happen automatically once 100 (or 200) conversations are processed, and nothing in this build triggers it on its own. This satisfies Rule 6's shadow-mode prong for this specific change, alongside Peter's compliance-risk approval above (the owner-approval prong) and the already-received outside-counsel opinion (the attorney-review prong) — all three of Rule 6's requirements are now on record for this build.

- **Everything else both reviews found — from the original fresh reviews and this confirmation round — is addressed in this revision:** the stale privilege precondition (Section 5 — confirmed still correctly unhedged; the matching fix to the actual, soon-to-be-retired `categorize-complaint.js`/`subject-match.js` files remains a Q build-time task, not a spec change, since that prompt text is never carried into the new merged prompt module), the reinstated historical `owner_instruction_rejected` auto-draft with its mandatory label (Section 3, Section 5), the relaxed tag/reachable-source/reliance-gate treatment for that same criterion in place of affirmative clearance (Section 6), the unchanged, still-mandatory `legal_exposure`/`accommodation_related` clearance checklist (Section 6), the resolved `checkClaim()` mechanism (Section 5, Section 7), the active notification bound now naming a third, informational count (Section 6), the extended live-and-historical `complaints`-creation trigger (Section 4, Section 7, Section 11 Item 13), and the corrected description of what retiring `process-pending-messages.js` gives up (Section 8).
- **The standalone AI Risk Assessment for this specific build** (`compliance/archive-search-significance-complaint-merge-ai-risk-assessment.md`) still needs its "Attorney review" status line updated to reflect that the opinion is in and both confirmations are complete (Asimov's confirmation, Item 6) — a housekeeping update to an already-good document, not a new deliverable, and not itself a blocker to the three items above.

**This document is not fully cleared — and whether these two resolutions actually satisfy Asimov's and Mason's own conditions is their determination to make, not Oracle's.** The legal and Fair Housing questions the opinion was asked are resolved, and this revision makes the spec match what was actually authorized — no more restrictively, and no less. Of the three items in Asimov's list above, two are now on record:
1. **Resolved, 2026-09-13.** Peter's explicit compliance-risk approval — see "Peter's compliance-risk approval" above.
2. **Resolved, 2026-09-13.** Peter's shadow-mode/sampling exit criterion — see "Peter's shadow-mode/sampling exit criterion" above.
3. **Still open.** Neo's Rule 4 data inventory for the merged schema — this is Neo's own task to produce, not a decision anyone is waiting on.

Before Neo applies any migration or Q writes any code, item 3 above still needs to happen. Items 1 and 2 are recorded here, not self-certified as sufficient — a fresh confirmation pass from Asimov and Mason, checking that these two resolutions actually satisfy their respective outstanding conditions, is still the appropriate next step if Peter wants one; this section leaves that pass almost nothing left to check.
