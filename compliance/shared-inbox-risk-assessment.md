# Shared Inbox Email Feature — Risk Assessment

**Status:** Draft — written to satisfy Asimov's 2026-08-16 governance check-in requirement for a formal, standalone risk document. Companion to `projects/hub/email-intake/SPEC.md` (the technical design for the two other gaps Asimov flagged). Nothing in this document authorizes a build or a connection to a real inbox.
**Written by:** Oracle
**Date:** 2026-08-16
**Audience:** Written for Peter to read and approve without needing to be a developer. Technical detail is included where the decision actually depends on it, and called out as such.

---

## What This Feature Does, In Plain Terms

Right now, when a tenant emails about a maintenance problem, that email lives in Missive (Rincon's shared team inbox tool) and nowhere else — if someone wants to know what a tenant said about an issue, they have to go dig through the inbox by hand. This feature would let staff look up a property or a maintenance ticket in the Hub and see the relevant email conversation right there, with a link back to the original in Missive. It does not send anything, reply to anything, or summarize anything into a report. It reads a copy of matched emails and shows them next to the ticket they belong to, the same way Maintenance History already shows what happened on a ticket from Latchel.

Two things have to happen before any email content is even looked at:
1. **A quick check decides whether the email is about maintenance at all** — does it mention one of our properties, and does it use maintenance-type language. Everything else (HR mail, personal matters, unrelated leasing chatter) is left alone entirely.
2. **A second check** — already built, already tested, already reviewed by Mason — looks for anything that should be handled by a person instead of a machine: active legal matters, attorney correspondence, formal Fair Housing complaints. Anything that trips this check never gets stored anywhere by this tool; it's set aside for a person.

Only what's left after both checks gets stored, and even then, anything touching a sensitive personal topic (health, disability, and similar) is walled off from ordinary use — visible only to whoever's checking it, never mixed in with the regular correspondence someone browsing a property would see.

## What Data This Touches

- **The content of emails in Rincon's shared inbox** — subject lines, who sent/received them, and the full text of the messages, for whatever gets matched to a property or ticket.
- **Property and maintenance ticket records already in Rincon's system** — used only to figure out which property/ticket an email is about, nothing new added to those records.
- **Nothing new about tenants themselves** — no new tenant profile fields, no scoring, no decision-making. This tool reads correspondence; it doesn't build a file on anyone.

This is, by a real margin, the most sensitive category of information any tool in this system has touched so far. Every other tool in this codebase works from structured records (a lease date, a work order status) or an AI's distilled summary of one. This tool's whole content is someone's actual, unedited words — which is exactly why it gets the most caution of anything built to date.

## The Risks, and How Each Is Handled

**1. Privileged or legal-hold content gets processed when it shouldn't.** If an email is with an attorney, a subpoena, a demand letter, or a formal Fair Housing/HUD complaint, that needs to go straight to a person — never get summarized, searched, or treated as routine. **This is handled by the filter that's already built and cleared legal review** (`compliance/shared-inbox-legal-checklist.md`, all six items resolved). This risk assessment doesn't change or re-decide that boundary — it inherits it. What's new here is making sure this content never even reaches that filter's *sibling storage table* — a held thread produces zero rows anywhere in the new system this spec adds. That's a hard rule in the design, not a preference.

**2. Fair Housing–protected content (health, disability, and other protected topics) gets used in a way that could touch a housing decision.** Handled the same way Maintenance History already handles it: flagged content is never deleted, but it's structurally walled off — a separate database view excludes it from anything a person would browse in the normal course of work, the same technical pattern already proven and reviewed for the Latchel-based tool.

**3. CCPA (a resident's right to have their data deleted).** Handled the same "redact, don't destroy the record" approach used everywhere else in this system: if someone asks for their data deleted, the actual email text gets replaced with a redaction marker while the fact that a thread existed (dates, which property, which ticket) stays for audit purposes. One honest caveat, specific to this tool: because an email thread naturally contains more than one person's words in the same message, redacting one person's request may mean redacting the whole thread rather than surgically removing just their part — the same kind of accepted trade-off already documented for other tools in this system, just worth stating plainly here because the content itself is more sensitive.

**4. Data minimization — touching more personal correspondence than the job requires.** This was Asimov's specific, named concern, and it's the reason the "is this even about maintenance" check exists as its own first step, before anything else runs. The technical design (`SPEC.md`) recommends a simple, rule-based check — not an AI reading everything — specifically so that the tool that decides "is this in scope" doesn't itself become a second thing reading everything in the inbox. HR mail and personal matters are never looked at beyond that one quick check, and even that check never keeps a copy of anything it decides isn't relevant.

## What This Is NOT Covered For

This risk assessment applies to exactly one thing: **a staff-facing tool that shows matched correspondence next to a property or ticket, for a person to read.** It does not cover, and would need a fresh risk assessment before any of the following are built:

- Automatically summarizing email content into an owner report.
- Automatically drafting a reply to a tenant, owner, or vendor based on this content.
- Using anything from this tool as an input to any decision about a tenant or applicant.
- Any AI model reading or summarizing the stored email content (this v1 design deliberately keeps every AI model out of the pipeline entirely — see `SPEC.md`'s storage design).

If any of those get proposed later, that's a materially different, higher-risk build, and Mason's own scoping note applies directly: it needs its own review, not an extension of this one.

## Shadow Mode — What It Means in Practice

Asimov recommended the full 90-day shadow period (GOVERNANCE.md Rule 7's "user-affecting" track) rather than the shorter 30-day track, specifically because this tool's entire job is correctly sorting sensitive content — and the filter has only been proven against 13 hand-built test cases so far, which prove the logic holds against cases someone thought to write, not against however real correspondence actually reads at real volume. That reasoning is sound and this assessment adopts it as a condition of going live, not a suggestion.

**What shadow mode actually is here, concretely:**

- **Every decision the pipeline makes gets logged** — every email's relevance call (maintenance-related or not), every privilege/Fair Housing outcome, every row stored. Nothing is silently decided; everything leaves a trace (see `SPEC.md`'s Audit Logging section for the exact fields).
- **During the 90 days, a person reviews every single decision** — not a sample, all of it — checking the original thread in Missive against what the tool decided. For an email the tool set aside as "not maintenance-related," the check is: was that right, or did something real get missed? For an email the tool did process, the check is: did the legal-hold and Fair Housing calls come out right on this specific real content?
- **Cadence:** reviewed within one business day of the pipeline running, so nothing sits un-checked for long; a short weekly rollup (how many misses, what kind, any pattern) goes to whoever holds the reviewer role and to Peter.
- **Nothing from this tool is used for normal staff work during these 90 days.** It's a supervised pilot — the "Related Correspondence" view exists for the reviewer doing the checking, not for general staff use yet.
- **If a pattern shows up** — the same kind of email getting missed or misclassified repeatedly — the maintenance-keyword list or property-matching logic gets updated and the count resets on that specific failure mode, the same way the underlying filter's own keyword lists are meant to be maintained and improved over time, not treated as fixed on day one.

**What ends the 90 days (exit criteria), all of which have to be true:**

1. **Zero missed legal-hold or privilege-relevant threads across the full review window.** This is the one non-negotiable item — even one real miss here is serious enough that the honest response is to fix it and extend the review period, not to let the clock run out regardless.
2. **A documented, acceptably low relevance-classifier error rate** (missed-relevant and over-included, both tracked), with any recurring pattern already fixed and re-verified before the period ends — not just noted for later.
3. **Peter's own sign-off that the tool is actually useful and accurate day to day**, based on what the shadow-period reviews turned up.
4. **Asimov's formal governance sign-off**, per GOVERNANCE.md Rule 7 — the hard gate before this tool's status moves from shadow to active for normal staff use.

Only after all four are true does this tool go live for ordinary use. Before that, everything about it stays in a supervised, human-reviewed state.
