# Approval Briefing — Spec-Level Governance Pre-Check

**Status:** Real Asimov governance pre-check, run against `projects/hub/approval-briefing-SPEC.md`. This document is the durable record of that review — the review itself happened inside a background workflow on 2026-08-27 and is transcribed here verbatim, not paraphrased, so it exists as a checkable artifact the way `compliance/leadsimple-spec-governance-precheck.md` does for the LeadSimple domain.

**Reviewed:** `projects/hub/approval-briefing-SPEC.md` (as it stood before the content-filter fix requested by this same review — see "Verdict" below for what's still pending re-confirmation), the design-conversation record (`approval-briefing-overview.html`), `GOVERNANCE.md`, `projects/hub/maintenance-history/lib/content-check.js` and `extract-claims.js`, the LeadSimple spec's own governance section, and the relevant database migration files.

---

## Asimov's verdict, verbatim

# Governance Pre-Check: Approval Briefing Spec — Verdict

**Short answer: This does NOT clear yet. It's close, and the two people who wrote it (Oracle, in the spec) did genuinely careful work — but I found one real gap in how the content-check safety net is wired, and it's exactly the kind of gap that matters on a feature whose whole point is "get information in front of a human, including toward the property owner." Neo and Q can start the two most boring, lowest-risk pieces now (Phase 0 and Phase 1 below). Everything that touches AI-generated text or sends an email has to wait for the fix.**

## 1. What kind of review this needs (the "Tier")

Property management systems classify AI actions into three tiers:
- **Tier 1 (Auto-pilot):** the AI just does it, no human checks first. Reserved for low-risk stuff.
- **Tier 2 (Ask First):** the AI recommends, a person approves before anything happens.
- **Tier 3 (Humans Only):** the AI isn't allowed to touch this at all — a person owns it entirely.

The spec asks for **Tier 1** for the automatic email to your Property Manager (PM) and **Tier 2** for the risk read, the emergency flag, and the draft toward the owner. I think that's the right end state, but it's **not safe to grant yet** — see the gap below. Practically: this whole build needs the same "stop and get sign-off before Neo or Q touch it" treatment as the LeadSimple applicant-screening project did. It's a **full governance review (what we call "Core," not the lighter "Incremental" reuse-track)** — same weight as LeadSimple, for a different reason:

- LeadSimple was heavy because it touches **applicant data and housing decisions** — the single most legally sensitive thing in property management.
- This one is heavy because it's the **first Property Brain feature that sends anything to anyone** — an automatic email to your PM, and text a PM will hand-copy toward a property owner. Every prior AI feature in this system only ever displayed things internally. This is genuinely new ground, and it also opens a brand-new front door on your server (a webhook Latchel controls, guarded only by a shared secret they issue, not something we control) — that's a new kind of attack surface Sentinel (security) needs to look at as a first priority, not a footnote.

So: it's not lighter than LeadSimple. It's heavy in a different way. Both need the full stop-and-check treatment — no shortcuts.

The good news: it does **not** need the same amount of Fair Housing paperwork LeadSimple needed, because this tool never screens, scores, approves, or denies anyone. Mason's review here can be narrow — checking that a few sentences of wording ("recent maintenance pattern," "risk of damage") can't be read as characterizing a tenant — not a full applicant-screening-style sign-off.

## 2. What the spec gets right

I checked the actual code this spec says it's reusing (the content-check filter, the AI extraction discipline, the database tables), and the spec describes them accurately — it isn't hand-waving. A few concrete strengths:
- It correctly refuses to let raw tenant/vendor free text (a ticket's actual written description) sit anywhere durable — only a distilled, AI-written summary with a citation ("Latchel job #, description field") ever gets stored. That's the same discipline the applicant-screening tool uses.
- It's honest about what data doesn't exist yet (no pet field, no vendor track record, no reliable "owner said yes/no" history) rather than quietly guessing or inventing something.
- It correctly identifies that the property-matching data it needs (linking a Latchel work order to your actual property record) is currently **0% built** — confirmed live, not assumed — and designs around that instead of ignoring it.

## 3. The gap I found — this is the one that has to be fixed before Q builds anything

You have a two-layer safety filter (a keyword scan plus an AI self-check) that's supposed to catch it if a maintenance ticket accidentally mentions something protected by Fair Housing law — a health condition, a disability, someone's family situation, that kind of thing — before it ever reaches a human. Every AI feature in this system so far runs every piece of AI-generated text through that filter before it's stored anywhere.

**This spec only wires that filter into one specific save-point: right before the AI's read of the ticket gets copied into the shared cross-feature record book (`claims`).** But that copy is optional — it only happens once your property records are properly linked to Latchel's records, which (confirmed) is not the case for a single property today. The spec is explicit that the emails go out **regardless** of whether that link exists.

Put plainly: as written, the actual text that lands in your PM's inbox — and that a PM might then paste into an email to an owner — comes from a different, separate copy of the same AI-generated text, and nothing in the spec says the safety filter runs on *that* copy before it's emailed. Given today's 0%-linked reality, that means the very first real briefings this system sends would go out without ever passing through the filter that's supposed to catch a stray sensitive mention. That's the exact failure mode this whole two-layer system was built to prevent, showing up in the one place — an outbound email, headed in part toward an outside party — where it matters most.

**Fix required:** the spec needs to say the filter runs on the text before it's ever put into an email — full stop, not conditional on whether the property-linking step happened. This is a spec-wording/design fix, not a huge rebuild — but it's not optional.

Two smaller things worth tightening in the same pass:
- There's no log entry for the moment the owner-facing draft is generated — only for when the PM email is sent. Since this is the first feature whose words are meant to eventually leave the building, I'd want a record of exactly what that draft said, not just that PM email went out.
- Section 0 already talks about the PM email as "basically automatic, low-risk" — I'd hold off calling it that until after a trial period (the spec itself proposes one — "Phase 8, shadow verification") actually proves the filter is catching what it's supposed to catch.

## 4. What can start now vs. what has to wait

- **OK to start now:** the two earliest, most mechanical phases — linking your existing property records to Latchel's records (pure data plumbing, no AI, no email), and building the new (empty) database table. Neither touches AI text or sends anything to anyone.
- **Must wait:** anything past that — the part that reads a ticket with AI, the part that builds the risk read, and the part that generates or sends either email. Those don't get built until the content-filter gap above is fixed in the spec, and Mason has done the short language check the spec itself already asked for.

This is my pre-check finding, not your go-ahead — per the standing rule, I still need you to say the word before this moves to Neo or Q, even for the two phases that are clear.

**Files reviewed in full:** `projects/hub/approval-briefing-SPEC.md`, the design-conversation record (`approval-briefing-overview.html`), `GOVERNANCE.md`, plus the actual filter code (`projects/hub/maintenance-history/lib/content-check.js`, `extract-claims.js`), the LeadSimple spec's own governance section, and the relevant database migration files, to confirm the spec's claims about existing code match reality.

---

## Status as of this document (Jarvis, orchestration session, 2026-08-27)

Peter confirmed directly, in chat, that Phase 0 and Phase 1 are approved to start — this is his own direct instruction, not a relayed claim. The content-filter fix (Section 3 of Asimov's verdict above) is in progress separately, being made directly in `projects/hub/approval-briefing-SPEC.md` by Oracle. Once that fix lands, this document should be updated (or a follow-up addendum added) noting the fix is in place, and ideally Asimov should confirm the fix actually closes the gap before Phase 2 onward (the parts that touch AI text and email) proceeds.

---

## Re-confirmation addendum (Asimov, 2026-08-27) — gap closed, Phase 2 cleared

I re-read the current spec directly — `projects/hub/approval-briefing-SPEC.md` Section 3.6 (steps 6–7), Section 4.4, Section 5, and Section 8 (8, 8.1, 8.2) — and Mason's independent Fair Housing review (`compliance/approval-briefing-fair-housing-review.md`), which touched this same fix from the wording-and-coverage angle rather than the wiring angle I originally flagged. Both checks land on the same conclusion.

**The original gap (Section 3 above) is closed.** Section 5 now states the content-check gate "runs once, unconditionally, immediately after generation... regardless of whether `property_id` has resolved... and regardless of whether a `claims` row will ever be written for this instance." `risk_assessment_text` — the field on `approval_briefings` itself, not the `claims` mirror — is only ever populated after the check clears; a flagged result is held and the field is left empty. Section 8's opening paragraph turns this into a hard read-path requirement for the email builder, not just a description: both templates "must read the risk assessment only from `risk_assessment_text`" and may not "re-derive a risk read... from the raw Latchel ticket fields... as a shortcut or fallback." Section 3.6 confirms the sequencing is enforced by construction: step 7 (email generation) "never runs ahead of step 6's content check — a flagged result cannot reach either email, by construction, because the field it would read from isn't populated until the check passes." That is exactly the fix I required: no longer conditional on the optional `claims` copy — it gates the one field the email is required to read from, full stop.

**Mason's follow-on finding (`access_instructions`) is closed the same way.** Section 4.4 now routes that field through the identical two-layer check at gather time, before either template can read it, with the same fail-safe render ("Access instructions not available for this ticket" in place of dropping or passing through flagged text). Section 8's opening paragraph explicitly extends the same no-shortcut, no-fallback-to-raw-fields rule to this field too — the same guarantee, applied twice, not a separate weaker one.

One thing worth naming as a positive check, not a residual gap: Mason's fix 4 also clarified that the owner draft (Section 8.2) is genuine AI rephrasing, not template fill-in — a second generation step that did not exist in the version I originally reviewed. I checked whether that introduced a new unguarded copy of tenant-adjacent text. It did not: Section 8.2 gates that output through the same `content-check.js` pass before it is written to `owner_draft_text`, with the same hold-and-render pattern ("Owner draft pending review"). The fix correctly extended the same discipline to a new AI-authored surface that appeared as a side effect of closing Mason's gap, rather than leaving it uncovered.

I found no remaining path by which flagged or unchecked text — risk assessment, access instructions, or owner-draft rephrasing — can reach either email.

**Phase 2 is cleared to build.** Phase 2 (Section 12) is the webhook receiver: the internal router, `LATCHEL_WEBHOOK_SECRET` verification, the two dashboard subscriptions, the idempotency check, and the hourly reconciliation poll. No gathering, no AI text, no risk assessment, no email — the spec itself is explicit that this phase only proves "a real approval event reliably produces exactly one tracked `approval_briefings` row." It does not touch any of the fields or logic this finding or Mason's review concern. Combined with Phase 0/1 already approved by Peter directly, and Mason's four Fair Housing fixes now incorporated into the spec text, there is nothing outstanding that blocks Phase 2. Per the spec's own Open Item 7, this re-confirmation was the one remaining condition on Phase 2 — it is now satisfied.

**Not cleared by this re-check.** Phases 3 onward still depend on Open Items 1–6 in the spec (the AppFolio maintenance-limit field/report name, owner-spend computability from `appfolio_property_actuals`, the Latchel job-level deep link, Peter's sign-off on Section 6.2's draft emergency-category list, the reminder/escalation timer durations, and Mason's still-open access-role-scoping question ahead of Phase 6) — none of those are content-check questions, and none are resolved by this document. This re-check confirms only that the specific gap named in Section 3 above, and Mason's directly related follow-on, are fixed. As before, this is my finding, not Peter's go-ahead — he still says the word before Phase 2 moves to Q.
