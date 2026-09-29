# Complaint-Tracking AI Categorization — Risk Assessment

**Status:** Draft — written to satisfy Asimov's 2026-09-10 technical-review requirement for a formal risk document covering the complaint-tracking tool's categorization step specifically. Companion to `projects/hub/email-intake/complaint-tracking-v1-scope.md` (the product design, already reviewed and cleared by Asimov and Mason) and `projects/hub/email-intake/complaint-tracking-technical-spec.md` (the engineering design, also reviewed and cleared with conditions). Nothing in this document authorizes a build or a live run against real mail.
**Written by:** Claude, at Asimov's request.
**Date:** 2026-09-10
**Audience:** Written for Peter to read and approve without needing to be a developer.

---

## What's Actually New Here

The hold check, the relevance filter, and the storage layer this tool reads from (`missive_message_intake`) are **not new** — they were already risk-assessed and cleared (`compliance/shared-inbox-risk-assessment.md`), and this build reuses them unchanged. What's genuinely new, and what this document covers, is the step downstream of all that: **an AI model reading the full text of a tenant/owner email thread that has already cleared the hold check, and deciding what it's about** — is it a big deal, which of six categories, how urgent, is the sender's tone escalating. That's a real, new kind of judgment this codebase hasn't asked an AI to make before at this depth.

## What This Step Does, In Plain Terms

Once a thread has already passed the hold check (so it's confirmed not a formal Fair Housing complaint or legal-privileged correspondence) and passed the separate Fair Housing content tag (Maintenance History's own two-layer screen, also already reviewed), the AI reads the thread and:
1. Assigns it to one of six categories (legal exposure, blocked resolution, relationship/churn risk, escalation/recurrence, major money risk, a one-off owner instruction) — or flags it "Needs a human call" if genuinely unsure.
2. Reads the tone across the thread's own message history and notes whether things seem to be getting more strained over time.
3. If it's a one-off owner instruction, proposes a draft note into the existing Operational Notes system — never posts anything itself; a human approves or declines.

None of this sends a message to anyone. None of it makes a decision — the DO reads whatever the AI flagged and decides everything from there.

## The Risks, and How Each Is Handled

**1. The AI mis-categorizes something, or misses a real big deal.** Handled by the design's own core principle: nothing the AI outputs is final. A wrong category just means the DO sees it under the wrong heading, not that it's hidden — every complaint is tracked regardless of category, and "Needs a human call" is the explicit escape hatch for genuine uncertainty (never a confident wrong guess).

**2. The tone signal misreads a communication style as escalating.** A blunt or direct writer, a non-native English speaker, or a neurodivergent communication pattern could get flagged more often than warranted. **Mason raised this directly; Peter reviewed it and confirmed the signal is advisory-only, DO always makes the final call, and declined a pre-launch accuracy/bias check** (recorded in `complaint-tracking-v1-scope.md`). The real mitigation is architectural, not a keyword filter: a wrong tone read can only draw a human's attention to something that turns out to be nothing — it cannot escalate, notify, or act on its own.

**3. Category 6 (owner instructions) proposes a discriminatory instruction as a durable rule.** Handled by reusing `operational_notes`' own already-reviewed safeguard: nothing the AI proposes is visible or acted on until a human approves it, and anything naming a protected characteristic independently trips that system's own content check on top.

**4. The 2-day "silence counts as refusal" rule mischaracterizes a legitimate delay as a refusal.** Mason recommended a caveat here; **Peter reviewed it and explicitly declined to add one**, on the record in the product doc. This assessment notes the residual risk plainly rather than re-litigating a decision Peter already made: staff reading a "blocked" tag should understand it can mean either a real refusal or unexplained silence, and the record itself (once built per the technical spec's Open Item 3) will distinguish the two even though the product doc doesn't require a UI caveat.

**5. Duplicate detection wrongly merges two genuinely different complaints, or fails to merge real duplicates and inflates recurrence counts.** Handled by requiring a human (the DO) to confirm every merge suggestion — nothing auto-merges. A wrong dismissal (two real duplicates kept separate) just means slightly inflated tracking, not a lost record either way.

**6. This becomes a shortcut for a housing decision later.** Per the technical spec's Open Item 10, `complaints` gets its own explicit Rule 9-style firewall statement: no future screening, renewal, or eviction tool may join against this data without its own fresh Asimov/Mason review.

## What This Is NOT Covered For

This assessment covers exactly the categorization step described above. It does not cover, and would need its own fresh assessment before any of the following are built:
- The Aircall phone-transcription pipeline (`aircall-transcription-v1-scope.md`) — a separate, not-yet-approved project.
- Any automated tenant/owner-facing communication ("closing the loop") — explicitly parked in the product doc, Section 8.
- A real LeadSimple write/escalation path — currently unbuilt; churn-risk complaints surface as an in-Hub flag only.
- Any future use of `complaints` data as an input to a housing decision — see risk #6 above; this is a hard, structural boundary, not a soft recommendation.

## Shadow Mode — What It Means Here

This step reuses already-cleared, already-shadow-tested upstream filters (the hold check and the Fair Housing content tag) — this assessment does not re-run their review clocks. What needs its own supervised period is the categorization step specifically, matching the technical spec's own Design Decision 16 precedent (`email-intake/router.js`'s manually-triggered-only pattern for a monitored period before automation).

**Concretely:**
- The categorization pipeline runs **manually triggered only, never on a cron**, for the length of this review period — matching the technical spec's own design (Design Decision 16), not a new restriction invented here.
- **Every categorization decision gets logged** — category assigned, tone signal, duplicate suggestions, "Needs a human call" flags — via the same `audit_log` wiring the technical spec already requires.
- **Peter and the DO review every run's output during this period** — not a sample, all of it, since volume is low (this tool is Peter-and-DO-only) and both people already need to see every complaint regardless.
- **Recommended length: 14 days of real, manually-triggered runs** — shorter than the underlying privilege filter's own 90-day period, since that filter (the actual highest-stakes decision — hold or don't hold) is unchanged and already cleared; this period is specifically about whether the six categories and tone signal are landing usefully in practice, a lower-stakes, faster-to-evaluate question.

**What ends the period (exit criteria):**
1. No case where a real big-deal complaint got mis-categorized as routine and effectively buried — this is the one non-negotiable item, same reasoning the upstream filter's own exit criteria uses for privilege misses.
2. Peter and the DO's own sign-off that the six categories and tone signal are actually useful, not just technically correct.
3. Asimov's formal sign-off before this moves from manually-triggered/shadow to a real scheduled run.

Only after all three are true should this run unsupervised.
