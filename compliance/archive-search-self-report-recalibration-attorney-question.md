# Archive Search — Fair Housing Screening Design: A Follow-Up Question for Counsel

**Prepared for:** Peter McKenzie, Rincon Management, to forward to outside counsel
**Date:** 2026-09-12
**Purpose:** a short, specific follow-up to your earlier opinion on Archive Search — not a general check-in, and not asking you to reconsider anything you already told us.

---

## Quick Recap

You previously reviewed Archive Search's Fair Housing screening design and gave us a detailed opinion. One line from that opinion is the reason for this note. In discussing whether every email mentioning a protected characteristic should be treated the same way, you wrote:

> "I would not automatically exclude every email that mentions a protected characteristic... 'Owner says he doesn't want families with children' [vs.] 'Tenant requested grab bars as a reasonable accommodation and installation was completed June 14.' Both concern protected characteristics. Only the first presents an obvious Fair Housing compliance concern."

We've now run into that exact problem for real. This note asks whether a specific fix we're proposing reasonably matches what you described.

## The Problem, Found on Real Data

The automated check that decides whether an email gets excluded from search and sent to a human for review currently asks only one question: does this email reference a protected characteristic at all. We ran it today against a real sample of the archive, and it flagged 90% of what it looked at — at that rate, scanning the full ~254,000-email archive would produce roughly 60,000-70,000 emails needing a person to review by hand. That's not workable, and it's the same "too broad" problem you flagged in your original review, just concentrated rather than fixed.

## The Proposed Fix

Narrow that question so it asks about the distinction from your quote above — not "does this mention a protected characteristic," but "does this show something concerning." The actual proposed question we'd have the AI answer:

> Setting aside the mere presence of a protected characteristic, does this conversation show any of the following?
> (a) Adverse or differential treatment connected to a protected characteristic — a refusal, denial, exclusion, threat, or hostile/derogatory comment tied to someone's protected status.
> (b) A request related to a protected characteristic — most often a disability accommodation or modification — that appears to have been refused, ignored, or left unresolved.
> (c) Language suggesting a preference, steering, or a differential policy based on a protected characteristic (e.g. discouraging families, an income-source-based restriction, a stated preference for or against a group).
>
> A conversation that ONLY states a fact about someone's protected characteristic with no adverse or differential treatment attached, or describes an accommodation request that was granted and handled normally, does NOT count.

Some concrete examples of what this would and wouldn't catch:

| Topic | Would clear (not flagged) | Would still flag |
|---|---|---|
| Disability | "Tenant requested grab bars as a reasonable accommodation; installation completed June 14." | "Tenant asked for grab bars — we told her we don't do those kinds of modifications here." |
| Familial status | "New tenant has two kids, will need the extra parking spot." | "Owner: I'd rather not rent to families with young kids — can we word the listing to avoid that?" |
| National origin | "Tenant's primary language is Spanish — sent the renewal notice in both languages." | "I don't think this building would really work out for someone in his situation, given where he's from." |

## Two Honest Open Questions, Not Just a Confirmation Request

We'd rather surface these ourselves than have you find them:

1. **Your opinion sketched three categories** — flag it, restrict it without flagging, or leave it fully open — not two. We're keeping it as two (flag, or fully clear) for now, mainly because access to anything that clears is already limited to a small group of trained employees with logging and an escalation path if something's missed. Does collapsing your three categories into two change your view here, or does the existing access restriction cover the gap you were describing?
2. **The third example above** ("given where he's from") is the hardest case in the set — it's discriminatory in substance but doesn't use a direct refusal or an obvious keyword. We've written the question to try to catch that kind of indirect phrasing, but we're not fully confident it reliably will. Is that residual risk (indirect, euphemistic language slipping through) something you'd consider acceptable given the check still defaults to flagging anything the AI is uncertain about, or would you want something more explicit written into the question itself?

## What We're Asking

Does this narrower question reasonably match the distinction you described in your original opinion? Any wording you'd change, or anything you'd want done differently before we run this against the rest of the real archive?

As before — we'd rather get this right before it's used against real data than fix it after the fact.

---

*Available on request: the full underlying analysis and the complete set of example pairs we tested this question against.*
