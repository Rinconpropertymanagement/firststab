# LeadSimple Tasks/Workflows — Mason's Fair Housing & Legal Review

**Status:** Final — my own written sign-off, standing on its own as the system-of-record for this review. This document exists because Asimov correctly flagged that my findings previously lived only inside Jarvis's data-inventory document (`compliance/leadsimple-tasks-workflows-data-inventory.md`) — paraphrased secondhand, not in my own words. That's the same "no independent paper trail" problem the data-inventory itself was written to fix for the underlying research. This closes that gap for the legal-review side.
**Written by:** Mason
**Date:** 2026-08-24
**Companion document:** `compliance/leadsimple-tasks-workflows-data-inventory.md` — the data inventory, methodology, and full figures this review is based on. I am not re-deriving those numbers here; I'm citing them and giving my legal read of them.
**Nothing in this document authorizes a build.** Oracle may begin spec work under the conditions below; Neo/Q do not build until the spec clears a second Asimov governance check per the data-inventory's Governance status section.
**Updated:** 2026-08-25 — Three separate updates on this date, addressed independently. (1) Condition 2 below refined per Peter's confirmation ("one click link is fine and will work"). (2) The Retention Question below is now **closed** per Peter's confirmation. (3) Both remaining Outstanding Pre-Launch Items are now **closed**. See Addenda 1, 2, and 3 at the end of this document for what changed and why on each.

---

## Document / Domain Reviewed

Whether LeadSimple's **Application Screening** and **Delinquency** workflow data (Tasks and Workflows features only — Pipelines/Deals/Contacts are out of scope and unreviewed) is safe to bring into Property Brain as a new claims domain. This is a data-source review, not a review of a specific tenant-facing document — there is no lease, notice, or listing language being cleared here. The question is whether the underlying content is clean enough, and the access/retention controls tight enough, for an AI pipeline to extract and surface it.

## Jurisdiction

Rincon operates 150–500 units across Southern California — multiple cities, not one. This review applies **California statewide law (FEHA)** and **federal law (FHA)** as the floor, since that's the one jurisdiction guaranteed to cover every unit in the portfolio. It does **not** resolve city-level variation (rent control ordinances, additional local protected classes, local just-cause rules) because this tool operates across the whole portfolio rather than one property — there is no single city to check. That's a real gap, not an oversight: if Property Brain ever surfaces Application Screening or Delinquency claims in a way tied to a specific city's stricter rules, that city's ordinances need their own check at that time, the same way any single-property document would need one.

**Protected classes used for the content scan:** the project's existing California-expanded list in `projects/hub/maintenance-history/lib/protected-class-terms.js` (`TERMS_VERSION = 'protected-class-terms-v1'`) — race, color, religion, sex, national origin, familial status, disability, source of income, marital status, age, ancestry, citizenship/immigration status, and primary language. This is the correct list for this review: it's the federal FHA seven plus every FEHA addition relevant to a California-wide portfolio, and it's the same list already in production use for the email-intake Fair Housing filter and Maintenance History's content check, so this domain is held to the same bar as everything else in this system rather than a bar invented for this build.

## My Findings

I reviewed this domain twice, at two different points, and I want both on the record because they answered different questions.

**First review — before the content inventory existed.** At this point nobody had actually opened the 74 lower-sensitivity workflow types (Move In/Out, Lease Renewal, Property Onboarding, Insurance Compliance, HOA Violations, Owner Termination, internal HR/accounting, etc.) or scanned Delinquency's structured fields at the record level — the account-level pass only confirmed those 74 types were operational/logistical in subject matter and that Delinquency's 6 custom fields were dropdowns/dates, not free text. I gave this a **conditional clearance**: the *shape* of that data (structured fields, non-applicant subject matter) is low Fair Housing risk on its face, but I explicitly did not clear it on content, because nobody had looked at the content yet. My condition then was the same condition I'd give any domain with unexamined free text: don't ship it until someone actually reads what's in it, and if any of those 74 types turn out to be built around free-form narrative notes rather than boilerplate/dropdowns, that one needs the same record-level check Application Screening and Delinquency got before its free text ships.

**Second review — after the 100%-coverage content check.** This is the review that matters. Every Application Screening instance (2,158), every Delinquency instance (6,772), every task on both workflow types (15,267 + 5,347), and every linked call (383) got checked — not sampled — against the protected-class term list, and the Application Screening task scan was independently re-run from scratch given the stakes. The result was clean: zero Layer-1 term-list hits anywhere. What I focused my read on wasn't the zero — a keyword scan turning up zero doesn't mean zero risk, it means zero *of the risk this particular check is built to catch* — it was the three records that weren't boilerplate:

- The one non-identical "Positive Landlord Reference" entry, out of 2,158.
- Two "comments" field entries outside the 19 defined Application Screening fields, one of which references a housing-voucher payment method. Source of income is a protected class under California law. The mention reads as routine and operational in context (how rent gets paid, not commentary on the applicant), and it produced no keyword hit — but "routine in context" is a human judgment call I made reading a paraphrase of the record, not a machine-verifiable fact, and it's exactly the kind of content a keyword filter is structurally unable to evaluate for tone or intent. That's why I did not wave this through on the Layer-1 result alone.

That gap — a filter that catches *presence* of protected-class-adjacent language but can't judge *how* it's being used — is the reason my clearance comes with conditions rather than a clean pass, and it's the reason I'm asking for a second, judgment-capable layer specifically on this workflow type going forward, not just this one-time check.

## Final Verdict

**FLAGGED ⚠️ — GO WITH CONDITIONS**

This is not a rejection. The content came back clean at 100% coverage, checked twice on the highest-stakes bucket. It's a conditional clearance because a keyword scan is the wrong tool to certify judgment calls on its own, and because three specific records and one policy question were still open at the time I gave this verdict. The conditions below are what make this a "go," not optional follow-ups.

## Conditions — Hard Requirements for Oracle's Build Spec

These stand as conditions on the build spec itself, not suggestions to consider:

1. **Reuse the existing protected-class filter, plus a Layer 2 AI-judgment pass for Application Screening specifically.** The Layer-1 keyword filter (`protected-class-terms-v1`) is necessary but not sufficient for this workflow type — it caught nothing that "read as fine in context" needs a person or a model that can weigh context to actually evaluate. This is a build requirement for the *ongoing* pipeline, not a one-time pre-launch task, and it should be weighted toward the ~10% "minor variation" task-description bucket where free-form content is most likely to appear.
2. **`claim_text` stays a distilled paraphrase; the citation must also resolve to a one-click link into the source record.** `claim_text` should be a distilled paraphrase of the source content — searchable, low-PII-density — never the field's own text restated as if it were a citation. That half of the condition is unchanged from the original. What's now explicit: `source_reference` can't stop at identifying the record structurally (LeadSimple process ID, field name, timestamp, per Section 5 of `projects/hub/leadsimple-property-brain-SPEC.md`) — it must resolve to a direct, one-click link into that specific LeadSimple record, using that same process ID, so a staff member with `leasing_reviewer` access can view the real, original text in one click rather than running a second search inside LeadSimple to find it. Confirmed by Peter on 2026-08-25 ("one click link is fine and will work"); see Addendum 1 at the end of this document for the reasoning and its limits.
3. **Role-restricted access, and restricted narrowly.** This isn't satisfied by "reviewer/admin roles" as a generic Hub permission tier. Application Screening data touches applicants who may have been denied housing — access should be scoped to staff with an actual leasing or collections function, not every admin-equivalent user across the Hub. Broad access to applicant data that a person doesn't need for their job is its own exposure, independent of what the data says.

## Outstanding Pre-Launch Items

**Status: Both closed 2026-08-25.** See Addendum 3 at the end of this document for what closed each one and why. The two items as originally written, for context, are below unchanged.

Two items were open when I gave this verdict and needed to close before Application Screening free text ships (they didn't block Oracle from starting spec work):

1. **Human review of the 3 outlier records** — the one non-boilerplate landlord-reference entry and the two comments-field entries, including the housing-voucher mention. I need a person, not a keyword list, to confirm my "routine, not commentary" read holds up against the actual record. Peter is doing this review directly. **Resolved — see Addendum 3.**
2. **An explicit decision on whether the general "comments" field is in scope for the build**, rather than an assumption either way. Usage is low (2 of 2,158 Application Screening cases, 33 of 6,772 Delinquency cases, nearly all blank) and what exists scanned clean, but low-usage free text fields are exactly where the next surprise tends to live, so I want this decided on purpose, not by default. **Resolved — see Addendum 3.**

## The Retention Question — My Explicit Position

**Status: Closed 2026-08-25.** See Addendum 2 at the end of this document for Peter's confirmation and my closing verdict. The reasoning immediately below is unchanged from my original review — it explains why I asked for independent attorney confirmation in the first place. What changed is the information I now have about how the 7-year figure was actually set; that's addressed in the addendum, and in the updated paragraph at the end of this section.

Peter has set retention at 7 years, applying Rincon's standing company-wide records policy rather than inventing a number for this build. I want to be precise about what that does and doesn't settle, because Asimov specifically flagged this as unresolved and wants my position in writing.

**7 years is a reasonable general business-records retention period, and I have no objection to it as Rincon's default.** But I do not consider it sufficient, on its own, to answer the specific question that matters for denied-applicant Application Screening data: how long does this data need to be defensibly retrievable for Fair Housing purposes.

Here's the distinction I'm drawing. A company-wide retention policy is designed around general business and tax recordkeeping norms. Fair Housing recordkeeping exposure is a different animal — it's driven by statute-of-limitations windows for administrative complaints and private lawsuits (which I am not going to state as specific numbers of years here, because getting that number wrong in a document like this is worse than not stating it, and it is exactly the kind of question that turns on current statute and is a licensed attorney's call, not mine), by tolling doctrines that can extend those windows beyond their nominal length, and by the reality that if a denied applicant ever alleges discrimination, Rincon's ability to show *what the actual criteria and records were at the time* is the entire defense. A retention period picked for general business purposes could turn out to be exactly right, or it could be short in a way nobody notices until a specific case makes it matter — and by then it's too late to fix.

**My original position** was that I wanted a licensed attorney in California to independently confirm 7 years is adequate for Fair Housing recordkeeping and statute-of-limitations purposes for denied-applicant Application Screening data specifically, before I'd call this fully closed rather than provisionally accepted. That was the right ask on the information I had at the time — I had no basis to believe anyone had looked at the Fair Housing-specific side of this question at all.

**Updated position, 2026-08-25 — closed.** Peter confirmed directly, twice: first, *"no attorney review needed. already been advised in the past by an attorney re how long to retain documents,"* and then, when I asked him to confirm and close this out, *"close the retention question. its 7 years."* His representation is that 7 years isn't a number picked for this build — it's Rincon's existing, standing company-wide records policy, and that policy was set with an attorney's input previously, not left to a business guess made in this conversation.

**I'm accepting that as sufficient to close this condition.** I'm not treating this as a rubber stamp — I still have one narrow residual observation, recorded below in Addendum 2, about whether that prior advice specifically had Fair Housing screening data for denied applicants in view versus general business recordkeeping. But on balance — a legitimate business judgment call, a policy actually set with attorney input rather than invented now, and a 7-year window that sits on the long side of ordinary practice — I don't think that residual gap is enough to keep this open as a gating condition on the build. See Addendum 2 for the full reasoning.

## Attorney Referral

**No — closed as of 2026-08-25.** This review previously called for a licensed California attorney to independently confirm the 7-year retention period was adequate for denied-applicant Application Screening data specifically. Peter has since confirmed that 7 years is Rincon's existing company-wide records policy, set previously with attorney input — not a figure decided for this build. I'm accepting that representation as sufficient to close this item; see Addendum 2 for my full reasoning, including the one residual point I'm noting on the record without blocking on it. Everything else in this review (the content findings, the access-control conditions, the filter requirements) was already within what I can clear as Mason without outside counsel.

## Verdict Summary

**FLAGGED ⚠️ — GO WITH CONDITIONS.** Oracle may proceed with spec work under the three hard conditions above — those remain permanent requirements on how this domain is built and operated, not pre-launch checklist items, so closing other items doesn't retire them. Neo/Q do not build until the spec itself clears its own Asimov governance check. **The retention question is closed as of 2026-08-25 (Addendum 2), and both outstanding pre-launch items are closed as of 2026-08-25 (Addendum 3). Nothing on my side is still open ahead of Phase 2.**

---

## Addendum 1 — 2026-08-25: Condition 2 Refined (One-Click Link)

This is a finalization of reasoning I'd already worked through, not a new review — it's on the record here because the question it closes out was open when the document above was written, and it's now answered.

**What changed.** Condition 2 above originally read "citation, not verbatim quoting," full stop. I've refined it: `claim_text` stays a distilled paraphrase — searchable, low-PII-density — exactly as before. What's new is that the citation side of the pair can't stop at a structural pointer someone has to go search on; `source_reference` must resolve to a direct, one-click link into the specific LeadSimple record, using the same process ID `source_reference` already captures per Section 5 of the Property Brain spec. Peter confirmed this directly: **"one click link is fine and will work."**

**Why I split this into two risks instead of treating "is a link safe" as one question.** A paraphrased claim that links back to its raw source touches two separable risks, and collapsing them together is exactly how the original condition ended up under-specified:

- **Risk A — internal access exposure.** Does the link hand raw, unparaphrased source text (including content like the housing-voucher/source-of-income mention flagged in the Second Review above) to people who couldn't otherwise see it? For this domain, **resolved — doesn't apply.** `leasing_reviewer` access (Condition 3, and Section 6 of the spec) is deliberately scoped to staff with an actual leasing or collections function — the same population, or a subset of it, that already has direct LeadSimple login access as part of that job. A one-click link isn't creating a new audience for the source text; it's removing a manual search step for someone who could already pull up that record on their own.
- **Risk B — a consolidated, discoverable copy.** Does building Property Brain create a new, cross-record-searchable aggregation of protected-class-adjacent content that's easier to query than the source system ever was? This risk is **still real, and it is unaffected by Risk A being resolved** — it has nothing to do with who's allowed to click the link. It's why `claim_text` still has to be a distilled paraphrase rather than verbatim text, link or no link: what Property Brain indexes and makes searchable is the paraphrase, not the source record, and that's what keeps this domain from becoming its own exposure regardless of how tightly LeadSimple's own access is scoped.

**Why this matters beyond this one condition.** The original "citation, not verbatim quoting" language was carried over from the same discipline already applied to the email-intake domain's Fair Housing filter — a reasonable instinct, reused without being re-derived for this domain's specific access model. That's exactly how Risk A and Risk B end up looking like one question instead of two: nobody asked who already has access to the underlying system. They're not the same risk, and whoever specs the next domain that reuses this "citation, not verbatim" condition should re-check both independently rather than assuming a one-click link is automatically fine because it was fine here. It's fine *here* specifically because LeadSimple's own access already sets the boundary — that won't hold for every future source system, and a domain where Property Brain's viewer role is broader than the source system's own access list would need Risk A re-evaluated from scratch, not waved through on this precedent.

**What this addendum does not touch.** "The Retention Question — My Explicit Position" above was a separate, unrelated open item at the time this addendum was originally written. It has since been closed — see Addendum 2 below — but that closure has nothing to do with the link-format decision documented here; the two were resolved independently, on different reasoning.

---

## Addendum 2 — 2026-08-25: Retention Question Closed

This closes out the last open condition from this review. It's on the record here, in my own words, because Asimov specifically asked for my written position on this item — not just a note that Peter made a decision.

**What Peter told me.** Directly, in this conversation, twice. First: *"no attorney review needed. already been advised in the past by an attorney re how long to retain documents."* Then, when I asked him to confirm and close this out: *"close the retention question. its 7 years."* His position is that 7 years isn't a figure being set now, for this build — it's Rincon's existing, company-wide records retention policy, and that policy was already established with an attorney's input in the past. He's not asking me to bless a new number; he's telling me an existing, previously-vetted policy applies here too.

**What I originally asked for, and why.** My original position (above) drew a distinction between two different things that both get called "retention policy": a general business-records retention period, set for tax and ordinary recordkeeping purposes, versus the retention window that actually matters if a denied applicant later alleges Fair Housing discrimination — which is governed by statute-of-limitations and tolling rules I'm not in a position to state precisely, and which is a licensed attorney's call, not mine. I asked for independent confirmation because, at the time, I had no information suggesting anyone had looked at that second, more specific question at all. The 7-year figure looked to me like it might simply have been carried over from general business practice without anyone checking it against Fair Housing-specific exposure.

**Why I'm accepting the closure.** Peter's new information changes the picture in a real way, not just a procedural one: this isn't a number invented in this conversation, it's a standing company policy that was set with an attorney's input at some point in the past. A few things push me toward accepting that as sufficient:

- Retention-period selection, within a reasonable range, is a legitimate business judgment call — it isn't a bright-line rule like "don't ask about familial status." Peter is entitled to make that call for his company, and he has, twice, directly.
- A property manager's attorney advising generally on "how long to retain documents" would, as a practical matter, almost certainly have applicant and tenant screening files in view — that's one of the largest and most obviously sensitive document categories a property management company holds, not an edge case an attorney would plausibly have overlooked while advising on retention generally.
- Seven years is a long window. It sits on the long end of typical business-records retention practice — and, without me putting a specific number on statute-of-limitations or tolling periods here (I said in my original review I wouldn't do that in this document, and I'm holding to that), a window on the long side of normal practice is, on its face, the kind of choice that tends to err toward *more* protective rather than less. That lowers the real-world stakes of the residual question below, even if it doesn't fully answer it.

**The one residual point I'm still noting, not blocking on.** Peter's statement was that he was advised "re how long to retain documents" — general phrasing, not a statement that the attorney was specifically asked about Fair Housing recordkeeping or denied-applicant screening data exposure. I don't know, and I'm not asking Peter to go find out, whether that past conversation used words like "discrimination claim" or "statute of limitations," or was purely about tax and general business recordkeeping. I'm recording that gap honestly rather than treating it as fully answered with certainty. But for the reasons above, I'm not treating it as a blocking condition — the inference that applicant records were in view, plus the length of the window chosen, are enough for me to call this closed rather than leaving it provisionally open.

**What would fully close the residual point, if Peter ever wants to.** A one-line confirmation from whoever gave that original advice — or from Rincon's current counsel, next time there's an occasion to ask — that the 7-year period was set (or is still considered adequate) with denied-applicant Fair Housing screening records specifically in view, not just general business files. That's a nice-to-have for the file, not a prerequisite for this build.

**Verdict on this item: CLOSED.** This is no longer an open condition on the Property Brain build. The Attorney Referral section above is updated accordingly — no attorney referral is outstanding on this review as of 2026-08-25. The two Outstanding Pre-Launch Items (human review of the 3 outlier records; the comments-field-in-scope decision) are unaffected by this addendum — see Addendum 3 below, where both are closed independently.

---

## Addendum 3 — 2026-08-25: Outstanding Pre-Launch Items Closed

This closes the two remaining items from the "Outstanding Pre-Launch Items" section above — the last two open items on this review. Both resolved on 2026-08-25. I'm recording the resolutions here, in my own words, for the same reason this whole document exists: so my findings have an independent paper trail rather than living only inside Jarvis's data-inventory document or Oracle's spec, paraphrased secondhand.

### Item 1 — Human review of the 3 outlier records

**What happened.** Peter reviewed all three directly in LeadSimple's own interface — the one non-boilerplate "Positive Landlord Reference" entry and the two comments-field entries, including the housing-voucher mention. This is exactly the design I originally asked for: a person looking at the actual record, not an AI intermediary summarizing it back to him, and not a second run of the same keyword filter that already couldn't evaluate tone or intent.

His finding, verbatim: **"I found all three fine, nothing that is related to any fair housing issues."**

**What this settles.** My hold on these three records was narrow and specific: "routine, not commentary" was my own read of a paraphrase, and a keyword filter can't judge tone or intent — I wanted a human to confirm that read against the real record before any of it shipped. That's done, by the person best positioned to make that call on his own data. No content is excluded as a result. All three clear for inclusion as-is, including the housing-voucher mention, which stands as a source-of-income reference made in an operational context (how rent gets paid) rather than commentary on the applicant.

**What this doesn't settle.** Peter's review answers the question I asked — does this specific record contain something that reads as commentary or exclusionary rather than operational fact — not a broader one. It doesn't bless every future comments-field entry in advance. That's precisely why Condition 1 (the standing Layer 2 AI-judgment pass on this workflow type) stays in force as an ongoing build requirement rather than being satisfied by a one-time human read of three records. A one-time check and a standing control answer different questions; closing this item doesn't retire the other.

**Item 1: RESOLVED.** No conditions attached beyond the ones already governing this data.

### Item 2 — Comments field in scope

**What happened.** Peter confirmed inclusion. Verbatim: **"i want to have visibility on the notes... include the comments."**

**What this settles.** This was a scope decision, not a legal-risk decision — I flagged it because low-usage free-text fields are exactly where the next surprise tends to surface, and I wanted it decided on purpose rather than by silent default. It's now decided on purpose: the field ships.

**What this doesn't change.** The comments field being in scope is the reason Conditions 1 and 2 exist, not a reason to loosen them. The Layer 2 judgment pass, the distilled-paraphrase-not-verbatim rule, and the one-click citation link (Addendum 1) all apply to `comments` exactly as they apply to `Positive Landlord Reference`.

**Item 2: RESOLVED.** No conditions attached beyond the ones already governing this data (Conditions 1–3, unchanged).

### Effect on the overall verdict

Both items closed here, together with the retention question closed in Addendum 2, mean everything I listed as needing to close before Phase 2 (the actual data-pulling phase) begins is now closed. The verdict does **not** change from **FLAGGED ⚠️ — GO WITH CONDITIONS** — closing these items isn't a clean pass, because Conditions 1–3 (the Layer 2 judgment pass, the paraphrase-only citation with one-click link-through, and role-restricted access) aren't a checklist that gets crossed off; they're permanent requirements on how this domain has to be built and operated. What changes is that there is nothing left gating the start of Phase 2 on my end. The Verdict Summary above reflects this.
