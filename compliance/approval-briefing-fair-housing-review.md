# Approval Briefing — Mason's Fair Housing Language Review

**Status:** Final — my own written sign-off, standing on its own as the system-of-record for this review, matching the pattern `compliance/leadsimple-fair-housing-review.md` set for the LeadSimple domain.
**Written by:** Mason
**Date:** 2026-08-27
**Reviewed against:** `projects/hub/approval-briefing-SPEC.md` as it stands today (post content-filter fix to Sections 5 and 8, dated 2026-08-27), the design-conversation record (`approval-briefing-overview.html`), `GOVERNANCE.md`'s Fair Housing Standard, and the two library files this domain reuses unchanged (`projects/hub/maintenance-history/lib/content-check.js`, `extract-claims.js`) — read in full to confirm exactly what the "content-check filter" this spec keeps citing actually does and doesn't catch.
**Companion documents:** `compliance/approval-briefing-spec-governance-precheck.md` (Asimov's full pre-check, which scoped my review) and `compliance/leadsimple-fair-housing-review.md` (the heavier applicant-screening review this one is deliberately not).

---

## Scope — Why This Review Is Narrow, and What That Means

Asimov's pre-check said it plainly: this domain "does not need the same amount of Fair Housing paperwork LeadSimple needed, because this tool never screens, scores, approves, or denies anyone... Mason's review here can be narrow — checking that a few sentences of wording ('recent maintenance pattern,' 'risk of damage') can't be read as characterizing a tenant — not a full applicant-screening-style sign-off."

I'm holding to that. This is not a data-inventory review, not an access-control review, not a retention review — those questions exist for this domain (Section 11 of the spec explicitly leaves the access-role question to me, more on that below) but they're a different kind of review than the one I was asked to do today. What I did: read every place in the spec where the pipeline turns real ticket data into words a human will read — Sections 4.2, 4.4, 5, and 8 — and asked one question of each: **could this be read as a statement about the person, rather than a statement about the property, the situation, or a documented event?**

That's a narrower bar than "is this legally airtight." I think it's the right bar for what this feature actually is. I'll flag at the end whether I think the scope needs to widen — it doesn't, with one exception I call out explicitly rather than just fixing it myself.

## Jurisdiction

Rincon operates 150–500 units across Southern California — multiple cities. This review applies California FEHA and federal FHA as the floor, the same baseline `compliance/leadsimple-fair-housing-review.md` used, for the same reason: it's the one standard guaranteed to cover every unit regardless of which city a given approval briefing's property sits in. Nothing in this review turns on city-specific rules — the wording questions here (does a sentence characterize a tenant vs. state a fact) don't vary by local ordinance the way, say, a security-deposit-return timeline would. If that changes — if a future version of this feature ever surfaces something jurisdiction-sensitive (a just-cause eviction reference, a local source-of-income rule) — that would need its own check at that time.

---

## What I Checked, and What I Found

### 1. Section 4.4 (Tenant context) — the maintenance-request count and the access notes

**Maintenance-request pattern.** The spec's own text is exactly right: *"Must be a bare count only, per the design doc's own hard rule ('never a judgment on the tenant') — no framing, no adjectives."* That's the correct instruction, stated as a hard rule, not a suggestion. **No change needed to this row.**

**Operational access notes — this is where I found a real gap, not a wording one.** The spec describes this field honestly: entry instructions come from each Latchel job's own `access_instructions` field, real examples confirmed live ("leave a key under the mat," "Code 2040"), pulled from whichever ticket is most recent. That's tenant- or vendor-authored free text — the same category of content Section 5's risk assessment reads (`description`, `vendor_description`, `estimate_note`) and, per the design doc's own third ground rule, exactly the kind of content that's supposed to run through the two-layer content check before it reaches anyone: *"Any tenant-related notes or free text run through the same content-safety check already built for other parts of this system... cheap insurance against the rare case something sensitive shows up in a maintenance note."*

I checked Section 2.3's field list and Section 5's content-check description against Section 4.4 directly, and `access_instructions` is nowhere in either. Section 2.3 is explicit that `description`/`vendor_description`/`estimate_note` are the free-text fields this pipeline content-checks, and only via the risk-assessment path. `access_instructions` is a fourth, separate free-text field, and nothing in the spec routes it through `content-check.js` before it lands in `pm_briefing_body` or `owner_draft_text` — both of which Section 11's own data inventory confirms carry "access-instruction excerpts pulled from a real ticket."

This matters because "leave a key under the mat" is a plausible, low-risk example, but it's not the only thing a tenant or PM types into a free-text access-instructions field. I've seen enough real maintenance tickets in this system's other domains to know free text drifts — "please call ahead, my mother who lives with us needs notice," "avoid Friday afternoons for religious observance," "kids nap 1–3pm, please avoid" are all entirely plausible things a real person types into an "any special instructions for the vendor" field, and every one of those is protected-class-adjacent (disability/familial status, religion, familial status respectively) in a way `content-check.js`'s Layer 1 keyword list and Layer 2 model self-flag exist specifically to catch. Nothing catches it here, because nothing runs the check on this field.

I want to be precise about why this isn't just me re-flagging Asimov's original finding: Asimov's gap was about the content check being wired to only one *save point* (the `claims` copy) for text that *was* otherwise in scope. This is different — it's a free-text field the content-check net was never extended to cover at all. Same failure mode, different field, and worth naming separately so it doesn't get closed by the same fix.

**⚠️ Risk: Medium-High.** This is real tenant free text, sourced from a system this pipeline doesn't control the writing of, flowing into two rendered documents — one of which (the owner draft) is meant to leave the building. It's exactly the scenario the design doc's own ground rule was written to prevent, and as specified today, nothing prevents it for this field.

### 2. Section 5 (Risk Assessment), as corrected

The correction Oracle made — content-check runs once, unconditionally, immediately after generation, gating both the `claims` write and both email templates — closes the gap Asimov found. I traced it through Section 5, Section 8's opening paragraph, and Section 3.6 step 6/7, and the logic holds: `risk_assessment_text` is only ever populated post-check, both templates are required to read only from that field, and a held (flagged) result renders as "Risk assessment pending review" rather than being silently dropped or worked around. **That fix is sound as written.**

What I was asked to check is narrower and different: not whether the *filter* runs, but whether the *risk-assessment language itself* is designed to stay about the property rather than the tenant. Here I found a real, fixable gap. The spec's prompt-design bullets (the "Design, reusing `extract-claims.js`'s proven discipline" list) specify: a qualitative risk level, a cited plain-English explanation, the same protected-class self-check `extract-claims.js` already does, and citation discipline. **Nowhere does the spec instruct the model to frame its output in terms of the property or situation, as opposed to the tenant's behavior or character.**

I read `extract-claims.js`'s actual prompt (the file this spec says it reuses) to confirm what that self-check really does — and it's scoped exactly to protected-class topics (`protected_class_flag`/`protected_class_category`, keyed to the same list `content-check.js` uses). That's the right check for what it's built for, but it isn't built to catch "tenant is negligent" or "tenant failed to report this promptly" or "tenant appears not to be maintaining the unit" — none of those trip a protected-class flag, because none of them are protected-class language. They're still exactly the failure mode the design doc's fourth ground rule was written to prevent: *"Owner and tenant history stays factual... never a summary of someone's character."*

This is a live risk, not a hypothetical one, because of *where* the risk assessment's source text comes from: `description`, `vendor_description`, and `estimate_note` are written by vendors and PMs, not the tenant, and vendor/PM notes about a maintenance ticket routinely characterize the tenant in exactly this way ("tenant wouldn't let vendor in," "tenant caused this by ignoring the earlier notice," "tenant is difficult to schedule with"). Today's prompt design gives the model no instruction not to carry that framing into its own output — only an instruction to flag if it happens to be protected-class-coded, which "tenant is difficult to schedule with" is not.

**⚠️ Risk: Medium.** The content-check gate (now fixed) is a strong backstop for the narrow thing it's built to catch. It is not a backstop for generic tenant-characterization drift, and right now nothing else is either.

**Recommended fix — specific language to add to Section 5's design bullets:**

> The prompt must explicitly instruct the model to frame its assessment in terms of the property or situation, never the tenant. Acceptable: *"risk the property incurs further water damage if not addressed within [timeframe]."* Not acceptable, even if the source ticket text uses this framing: *"tenant is negligent," "tenant failed to report promptly," "tenant caused the damage," "tenant has been uncooperative."* If a vendor's or PM's free text itself characterizes the tenant, the model should extract the underlying property-risk fact it supports, if any, and leave the characterization out — the same discipline `extract-claims.js` already applies to Latchel's `max_cost` field (report the number, strip the source's own framing around it).

### 3. Section 4.2 (Owner history)

This one is clean, and better-handled in the spec than the tenant-context row, honestly. The owner's approval/denial history field is described throughout as "strictly a record of past decisions, never a characterization of the person" (design doc) and the spec's own Section 4.2 write-up is careful and appropriately hedged — it states plainly this data isn't actually sourceable today from either system, proposes `resolved_state_name` only as an explicitly-labeled **proxy**, and flags that proxy for Peter/Mason validation before it's ever shown to a PM as "owner history." The idea #1 example lead line — *"owner has approved 8 of their last 10 requests"* — is a clean factual-tally framing, not a characterization ("reasonable owner," "cooperative owner," etc. would be the failure mode; nothing here does that).

**No change needed.** I'll hold Peter/Mason validation of the `resolved_state_name` proxy as a standing to-do before that field is ever surfaced as "owner history" in a later version, per the spec's own Section 12 deferred list — that's a future-version item, not a Phase 2 blocker.

### 4. Section 8 (Email generation) and template wording — two more findings, reading the real spec text

**Finding: the tenant-context bare-fact rule isn't carried into Section 8 as a build requirement.** Section 8.1 explicitly enumerates ideas #1, #3, and #4 as "hard requirements, not nice-to-haves" for whoever builds the actual email template (Q or Tron). Section 4.4's "bare count only, no framing, no adjectives" rule for tenant-context data is just as much a hard requirement — the design doc calls it out with the same weight — but Section 8 never restates it as one. That's a real gap between "the data model correctly constrains what's captured" and "the template-building instructions correctly constrain what gets written." A careful data design can still get eroded by ordinary copywriting once someone is actually drafting sentences for a PM to read quickly — "3 requests in the last 6 months" is one sentence away from "this tenant submits maintenance requests frequently," and nothing in Section 8 currently tells Q or Tron not to make that stylistic choice.

**⚠️ Risk: Low-Medium.** Low because Section 4.4's underlying rule is correct and clear; Medium because Section 8 is the section that actually governs what gets typed into the template, and it's silent on this specific point where it's explicit about three sibling points.

**Recommended fix:**

> Add a fourth hard requirement to Section 8.1, alongside ideas #1/#3/#4: tenant-context fields (maintenance-request count, tenure, access notes) render as bare facts in both templates — a number, a date, or a literal instruction string, never an adjective or a framing that implies a pattern of behavior ("frequent," "demanding," "high-maintenance," "difficult"). This is Section 4.4's own rule, restated here as a template-rendering requirement, not left to the template author's discretion.

**Finding: Section 8.2's "owner-appropriate language" is ambiguous about whether it's a template fill-in or an AI rewrite — and that ambiguity matters more here than anywhere else in the spec.** Section 8.2 says the owner draft is "generated from the same gathered data, in owner-appropriate language (no internal jargon, no raw Latchel field names)." If that means slotting already-vetted, already-bare-fact strings into a fixed template, there's no new risk. If it means an LLM freely rephrasing the gathered facts into prose — which "owner-appropriate language" reads more like — that rephrasing step is a second, unguarded opportunity to reintroduce exactly the drift Section 4.4 and my Section 5 finding above are both trying to foreclose, and as far as I can tell from the spec text, nothing content-checks that rephrasing before it's written to `owner_draft_text`. This is worth being precise about specifically because the owner draft is the one output in this entire feature that's designed to leave the building — the PM copies it into an email to a third party. Any characterizing language that slips through here doesn't just sit in an internal Hub record; it reaches an owner who might act on it.

**⚠️ Risk: Medium**, specifically because of the external destination, not because I think this is likely to go wrong by design — I think it's underspecified, and underspecified is exactly the condition that let the original content-check gap happen.

**Recommended fix:**

> Section 8.2 should state explicitly which of the two it is. If any AI-authored rephrasing of gathered facts happens (as opposed to a fixed template filling in pre-vetted strings), that generation step is subject to the same content-check gate as Section 5's risk assessment, and the same explicit instruction against tenant-characterization language recommended above — and its output should be content-checked before being written to `owner_draft_text`, the same way `risk_assessment_text` is checked before either template can read it.

I did not find anything else in Sections 4, 5, or 8 that reads as characterizing a person rather than stating a fact. The vendor-context rows (Section 4.5) are about vendors, not a protected class of person, and are appropriately scoped down to cost-benchmark-only for v1 with everything else honestly marked "not proposed." The emergency-matching list (Section 6.2) is about issue categories, not people. Idea #1's lead-line example and the cost-benchmark language (Section 7) are both quantitative and appropriately caveated with sample sizes — no characterization risk there.

---

## Out of Scope, Flagged Separately, Not Resolved Here

Section 11 of the spec explicitly assigns me a decision: *"Whether a narrower role than `property_manager`/`pod_lead`/`admin` is warranted for this domain — explicitly left to Mason's Section 0 review."* I'm naming this rather than silently skipping it, because it's directed at me by name in the spec text — but I'm not resolving it in this document. It's an access-control/RLS scoping question, not a wording question, and Asimov's own framing for this review was specifically the language check, not the full domain review LeadSimple got (which is where the equivalent access-scoping condition for that domain actually got decided). Answering it properly means the same kind of question Condition 3 took in the LeadSimple review — who actually needs this data for their job, not just who could plausibly want it — and that's worth its own short pass, not a paragraph tacked onto a language review. **My recommendation: treat this as a small, separate, quick decision before Phase 6 (email generation) — it doesn't block Phase 2 or 3, and it isn't a reason to widen this review, but it shouldn't be quietly forgotten because it wasn't in today's four items either.**

---

## Recommended Changes — Summary

1. **Section 2.3 / 4.4 (access instructions):** Route `access_instructions` through the same two-layer content check as the risk-assessment free-text fields before it's rendered into either email. On a flag, render "Access instructions not available for this ticket" — matching the existing missing-data pattern (idea #4) — rather than surfacing flagged text.
2. **Section 5 (risk-assessment prompt):** Add an explicit instruction constraining the model to property/situation framing, with the "acceptable / not acceptable" language above, so the prompt doesn't rely solely on the protected-class-scoped content check to catch generic tenant-characterization drift.
3. **Section 8.1 (PM briefing template):** Add tenant-context bare-fact rendering as a fourth hard requirement, matching how ideas #1/#3/#4 are already treated.
4. **Section 8.2 (owner draft):** Clarify whether generation is template fill-in or AI rephrasing; if the latter, apply the same content-check gate and characterization instruction as items 2 and 3, before text is written to `owner_draft_text`.

None of these are large changes — each is a paragraph or a bullet added to a section that already exists and is otherwise well-reasoned. They're the same size and shape as the correction Oracle already made to Section 5/8 for Asimov's finding.

---

## Attorney Referral

**No.** Nothing in this review turns on a legal question outside my scope — no novel statute, no jurisdiction-specific rule, no question about how a court would read a document. This is a wording-and-coverage check against `GOVERNANCE.md`'s own Fair Housing Standard and the design doc's own ground rules, which is squarely mine to make. If Peter or Asimov later want independent counsel on the broader compliance build (the webhook endpoint, the new credential, retention) that's a separate question from this one and isn't mine to answer either way.

---

## Verdict

**FLAGGED ⚠️ — specific, fixable changes needed before this clears; not a clean pass, and not a rebuild.**

The content-check correction Oracle already made to Sections 5 and 8 is sound and closes the gap Asimov found. On the narrow question I was actually asked — can a few sentences of wording be read as characterizing a tenant — I found one real coverage gap (access-instructions free text, item 1 above) that's the same class of problem Asimov already flagged once, just in a field that fix didn't reach, plus three smaller language/rendering gaps (items 2–4) that are underspecified rather than wrong. None of these require reopening the feature's design — the design doc's own ground rules already say the right thing in every case I checked. What's missing is that the spec's actual build instructions don't yet fully carry those ground rules through to every place free text or AI-generated prose reaches a human.

**What I'd want before Phase 2 continues into Phase 3 (the gather step, where `access_instructions` first gets pulled) and Phase 6 (email generation, where all four items above get built into real templates):** the four changes above incorporated into the spec text, the same way Section 5/8's correction already got incorporated for Asimov's finding. Phase 2 itself (the webhook receiver) touches none of this and isn't affected by anything in this review.

I'm not asking for a second round of this review once those changes land — they're narrow enough that Oracle incorporating the language above should close them. If Oracle's edit changes the actual mechanism rather than just adding the instructions I've recommended, I'd want a quick second look at just the diff, not a re-review from scratch.
