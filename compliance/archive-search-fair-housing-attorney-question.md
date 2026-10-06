# Archive Search — Fair Housing Screening Design: Question for Counsel

**Prepared for:** Peter McKenzie, Rincon Management, to forward to outside counsel
**Date:** 2026-09-12
**Purpose:** to get a specific, on-the-record answer about one specific design choice — not a general check-in about the system's overall approach.

---

## The Situation

Rincon Management has an internal tool ("Archive Search") that will let a small number of staff (8 people) search the company's historical email archive. Before any message becomes searchable, it goes through an automated screening step. Two categories of email are permanently excluded from search: (1) anything involving attorneys or legal/regulatory matters, and (2) anything that appears to raise a Fair Housing concern (discrimination based on a protected characteristic — race, disability, familial status, national origin, and similar categories under California and federal law).

**How the Fair Housing check works today:** every email that isn't already excluded for legal reasons gets an individual, automated review asking one question — does this appear to describe treatment based on a protected characteristic. This runs on all ~254,000 archived messages, regardless of subject matter.

## The Proposed Change

To reduce the cost of running this check at that scale, we're considering narrowing which emails get that automated review. The proposed design:

1. First, a fast, mechanical scan checks whether an email touches on any of a specific list of topics connected to protected characteristics — family status, disability or accommodation needs, national origin or language, income source (e.g., housing vouchers), age, marital status, and similar categories.
2. **Only emails that touch one of those topics get the individual automated review described above.**
3. **Everything else is automatically treated as clear — with no individual review at all.**

## The Specific Thing We Need Your Input On

This is not the same as making the existing check *more accurate* or *less trigger-happy* (which is a change we made once before, with your input, and it worked well). This is a different kind of change: **for any email that doesn't touch the specific list of topics above, there is no automated review of any kind — not the current check, not a lighter version of it, nothing.**

**The concrete risk, stated plainly:** an email that describes discriminatory treatment in a way that doesn't happen to use any of the listed topic words or phrases would receive zero screening under this design. For example, a sentence like *"I don't think this building would really work out for someone in his situation"* — referring obliquely to a disability, without using any word on the list — would not be caught by the topic scan and would never reach the individual review step at all.

This is different from a normal false-negative risk (where a check runs but makes a mistake) — under this design, for anything outside the topic list, **the check simply never runs.**

## What We're Asking

Given your earlier general guidance that our screening approach has been more cautious than legally necessary: **does that guidance extend to this specific design — skipping individual review entirely for content outside a defined topic list — or does it apply more to making the existing check smarter and less prone to false alarms (which is a different, narrower kind of change)?**

We'd like your explicit confirmation, tied to this specific mechanism and this specific residual risk, before this is used against the real archive. If you'd prefer a different design (for example, a version that reduces cost without ever fully skipping review), we're open to that — this document is meant to get your input before we finalize anything, not to ask you to bless a decision that's already been made.

---

*Attachment/reference available on request: the full technical specification of the proposed topic list and matching logic, if useful for your review.*
