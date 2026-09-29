# Archive Search Significance + Complaint-Tracking Merge — AI Risk Assessment

**Status:** Draft — written to satisfy Asimov's fresh 2026-09-13 governance review requirement (his required item 6) for a standalone, Peter-reviewable AI Risk Assessment covering this specific build. Companion to `projects/hub/email-intake/archive-search-significance-technical-spec.md` (v2, as revised) and to the two fresh governance/legal reviews on file: `compliance/archive-search-significance-complaint-merge-asimov-review.md` (NOT CLEARED) and `compliance/archive-search-significance-complaint-merge-mason-review.md` (NOT CLEARED). Nothing in this document authorizes a build or a live run against real mail, and nothing in this document marks this build CLEARED.
**Written by:** Oracle, at Asimov's request.
**Date:** 2026-09-13
**Audience:** Written for Peter to read and approve without needing to be a developer.

---

## Why This Document Exists, and Why the Original One Doesn't Cover It

The existing `compliance/complaint-tracking-ai-risk-assessment.md` (2026-09-10) already risk-assessed the categorization judgment at the heart of this build — an AI reading a real tenant/owner email thread and deciding what it's about. That document is not being redone here; its reasoning about mis-categorization, tone bias, and the discriminatory-instruction safeguard still holds.

What that document cannot cover, because it was explicitly scoped otherwise, is the operating mode this merge actually runs in. Its own words: a **"live, low-volume, daily-trickle pipeline"**, with a shadow-mode plan built on Peter and the DO reviewing **"every run's output... not a sample, all of it, since volume is low."** This build runs the same kind of categorization judgment, once, in bulk, against **254,000+ historical conversations already sitting in the archive** — a scale and a mode of operation the original document never contemplated and its own exit criteria cannot verify. Asimov's fresh review confirms this gap explicitly (his Rule 7 finding) and requires this document as a first-class deliverable, not a paragraph folded into the technical spec's Section 12.

---

## What This Automation Actually Does

Two AI calls run per Missive conversation, against an archive of 254,000+ real tenant/owner/vendor email threads that have already passed archive-search's own Fair Housing screening pass (`screening_result = 'clear'`):

- **Call 1** (every eligible conversation) tags: topic (an 8-value taxonomy — routine scheduling, ordinary maintenance, a dispute, a safety issue, legal exposure, an accommodation matter, an owner's standing instruction, or other), resolution status, a Fair Housing protected-class self-check, tone trend, and identity (via a deterministic address match, with a cite-then-lookup fallback for unmatched threads — never a free-text AI guess). A second, independent keyword+AI protected-class check (`checkClaim()`, reused from `maintenance-history/lib/content-check.js`) also runs on every conversation as genuine defense-in-depth, feeding an `audit_log` entry when it fires.
- **Call 2** (conditional — most non-routine/unresolved conversations) assigns an urgency signal (blocked resolution, churn risk, escalation/recurrence, major money/property risk, or none), an honest "needs a human call" flag, and — only for live mail categorized `owner_instruction` — drafts note text for a discriminatory-instruction finding. For historical mail, Call 2 records the same finding (true/false/uncertain) but never drafts anything; a human decides whether a note gets written at all.

Results write to two tables: `missive_conversation_significance` (every conversation, `searcher`-readable, dismiss/reinstate lifecycle) and `complaints` (only conversations Call 2 found actionable, `admin`/`director_of_operations`-only, resolution-note-required lifecycle). They surface on Property 360 (a "Needs Attention" card, filtered to `is_big_issue = TRUE`), on `compliance-review.html` (a live "Needs Attention" tab, a "Historical Backlog" tab, and a new "Needs a Human Call" tab), and — live mail only — a home-page red-badge tile with DO assignment and a 24-hour aging nudge.

**Nothing in this design sends a message to any tenant, owner, or vendor.** This stays an internal triage/browsing tool. **No housing decision (approve/deny/condition) is made anywhere in this design.** Both facts are unchanged from the original assessment and independently re-confirmed by both fresh reviews.

---

## The New Risks This Scale and Mode Introduce, Beyond the Original Assessment

The original assessment's six risks (mis-categorization, tone bias, discriminatory-instruction proposals, the silence-as-refusal rule, duplicate detection, and future housing-decision misuse) still apply and are not repeated here. Four risks are genuinely new to this build — introduced by bulk historical scale and by categories the original daily-trickle tool never actually processed against real mail. All four were found by Asimov's and Mason's fresh reviews and are named here as **risks that were found and have been mitigated in the technical spec**, with a pointer to where each fix actually lives. None of the four is fully closed — each still has a real, named residual, listed underneath.

### 1. The privilege gap — an AI reading potentially privileged correspondence and permanently recording new analysis of it

Retiring complaint-tracking's own pipeline (`process-pending-messages.js`) also retires the *only* attorney-privilege/legal-hold gate (`privilege-filter.js`'s `checkThread()`) that ever ran ahead of an AI reading this content for meaning. Archive-search's own screening pass has never had one — by deliberate, counsel-reviewed design, for a different question (searchability, not AI-generated analysis). This merge's Call 2 is specifically designed to read for `legal_exposure`, decide urgency, and draft permanent note text, over a population that includes 3,623 conversations that previously tripped that same privilege filter before it was removed from archive-search for search-access purposes only.

**Mitigated in the spec:** the false precondition telling the model this check already ran (`categorize-complaint.js` line 62) is rewritten (spec Section 5) to state plainly that no privilege filter runs ahead of this pass. Section 8 now correctly describes retiring the old pipeline as also retiring the only privilege gate that ever existed here.

**Residual, not yet closed:** rewriting what the model is told does not resolve whether an AI *generating new written analysis* from potentially privileged content, at bulk scale, needs a privilege pre-filter of its own before Call 2 runs against real data. That is a genuine open legal question, not something Oracle, Q, or Asimov can resolve. **`compliance/archive-search-significance-privilege-attorney-question.md` is drafted and pending Peter's send** — Call 2 does not run against real data until that answer comes back.

### 2. The retroactive-record risk — a permanent, adverse, AI-generated Fair Housing finding about a real, named owner, written with no human check first

An AI, unsupervised, reading a 2022 email and concluding today that a real owner gave a discriminatory instruction — then permanently storing that conclusion as Rincon's own system's finding — is a materially different artifact than the thing it replaces (silence). Reworded, hedged wording ("AI-assessed... no record confirms...") fixes the narrower problem (fabricating a historical fact) but not the wider one: a confident AI assertion about a real person's past conduct, unreviewed, with no operational upside to offset getting it wrong.

**Mitigated in the spec:** for historical mail, Call 2 no longer drafts any note text at all (spec Section 5). It records `owner_instruction_rejected` (true/false/uncertain) and stops; the conversation routes to the mandatory-clearance checklist (spec Section 6), where a human decides whether anything gets written, and writes it themselves if so. Every historical `owner_instruction_rejected = true` finding is now a **required**, not optional, item on that checklist (spec Section 6), regardless of `resolution_status`.

**Residual, not yet closed:** this is the safe interim default, not a resolved legal question. **`compliance/archive-search-significance-owner-instruction-attorney-question.md` is drafted and pending Peter's send.** Peter can choose to revisit auto-drafting once that answer comes back; it does not ship as originally designed today.

### 3. The review-queue/mandatory-checklist bound — a safety net nobody is required to open

A discrete, must-clear checklist and a "Needs a Human Call" review queue are only real safeguards if someone is actually told to open them. As originally specced, both were passive views — no active push, no schedule, at a volume (Section 10's own estimate: 1,250–5,000 flagged items from the historical run, some fraction of that genuinely uncertain) that a two-person review team could plausibly never get around to.

**Mitigated in the spec:** the mandatory-clearance checklist is widened to also cover `accommodation_related` category threads (unresolved) and any historical `owner_instruction_rejected = true` finding, regardless of resolution status (spec Section 6). Both that checklist and the "Needs a Human Call" queue now get one real, active, outbound notification — through Peter's existing out-of-Hub channel, the same posture he already set for privilege escalation in the held-release review — fired once when the historical backfill completes, naming both counts and linking directly to each (spec Section 6).

**Residual, not yet closed:** this closes the *mechanism* gap (something now actively tells Peter/the DO to look). It does not by itself size how much review capacity two people actually have, or guarantee the review happens promptly once notified. That is a staffing/capacity question for the rollout, addressed by the pilot-before-full-archive recommendation (spec Section 10) — not solved by the notification alone.

### 4. The live-mail complaints-trigger gap — a live "big issue" that never reaches the Director of Operations at all

As originally specced, a `complaints` row (the only thing driving the red-badge tile, DO assignment, and 24-hour aging clock) was only created when `escalation_signal != 'none'`, `needs_human_call`, or `owner_instruction_rejected`. A `legal_exposure`-categorized conversation that didn't happen to also trip one of those three — live mail, not just historical backlog — was `is_big_issue = TRUE` by the design's own definition, yet never reached the DO at all: no badge, no assignment, no aging clock, only a passive tab someone has to browse to.

**Mitigated in the spec:** a `complaints` row is now also created whenever `category IN ('legal_exposure', 'owner_instruction')` alone, regardless of `escalation_signal`/`needs_human_call` state — for both live and historical mail (spec Section 4).

**Residual, not yet closed:** one path still diverges by design, not oversight — a conversation that becomes `is_big_issue = TRUE` purely because a human confirmed it through the "Needs a Human Call" queue (`human_confirmed_big_issue = TRUE`) still never creates a `complaints` row (spec Section 7, Section 11 Item 13). That queue answers "is this a big issue for Property 360," a different question from "does the DO need to act on it right now" — a deliberate scope boundary, named here so it isn't mistaken for the same gap re-appearing.

---

## What This Is NOT Covered For

This assessment covers exactly the automation described above — Call 1 and Call 2's categorization and triage judgment, at bulk historical scale plus ongoing live mail, writing to `missive_conversation_significance` and `complaints`. It does not cover, and would need its own fresh assessment before any of the following are built:

- Anything the original 2026-09-10 assessment already excluded and that remains untouched by this merge: the Aircall transcription pipeline, any automated tenant/owner-facing communication, a real LeadSimple write/escalation path, or any future use of `complaints`/`missive_conversation_significance` data as an input to a housing decision (a hard, structural boundary, restated by both fresh reviews, not a soft recommendation).
- Whether an AI drafting written analysis from potentially privileged content needs its own privilege pre-filter (risk #1 above) — an open legal question, not something this assessment resolves.
- Whether a retroactive Fair Housing finding about a named owner's historical conduct should exist as a permanent record at all, in what form (risk #2 above) — also an open legal question.
- The CCPA/redaction cascade question for `missive_conversation_significance`/`complaints` content naming a redacted tenant or owner — carried forward, unresolved, from the original spec (Section 11, Item 9).

---

## Rule 6's Three Prongs — Status

GOVERNANCE.md Rule 6 requires all three before a Critical-tier change like this one runs. Both fresh reviews confirm the classification; none of the three is fully satisfied yet.

**1. Owner approval — given for scope, not yet for this specific compliance risk.** Peter has given a scope directive (fold the six categories into one AI read; don't build a fourth pass over the archive) and concrete product decisions (`is_big_issue`'s corrected definition; Property 360's strict scope). Neither is an approval of the compliance risk of running this at 254,000-conversation bulk scale, over a population that includes previously privilege-flagged mail, generating retroactive Fair Housing findings. Both fresh reviews say so explicitly, and this assessment does not treat the scope directive as if it were that approval.

**2. Attorney review — two questions drafted, pending.** Three existing opinions on record (held-release, layer1-removal, self-report-recalibration) all answer questions about search *visibility* and Fair Housing *screening*. None was asked, and none answers, the two new questions this merge raises: an AI drafting permanent legal-exposure/privilege-adjacent analysis (risk #1), or a present-day record characterizing a possible historical Fair Housing violation (risk #2). Both questions are now drafted:
- `compliance/archive-search-significance-privilege-attorney-question.md`
- `compliance/archive-search-significance-owner-instruction-attorney-question.md`

Both are **pending Peter's send.** Call 2 does not run against real data until answers come back.

**3. Shadow mode — the original plan is obsolete; no replacement has been chosen yet.** The original assessment's exit criteria assumed a live, low-volume trickle: "Peter and the DO review every run's output... not a sample, all of it, since volume is low." Run against a one-time bulk pass over 254,000+ historical conversations producing an estimated 1,250–5,000 flagged items in one run (spec Section 10), that plan is **explicitly obsolete** — reviewing "all of it" in days is not a real exit criterion at this scale, and no replacement has been decided.

**Open item — Peter's to decide, named explicitly, not resolved here:** what bulk-appropriate shadow-mode exit criterion replaces "review all of it"? The technical spec (Section 10) already commits to running a bounded pilot — one property, or one date range — before the full 254,000-conversation run, specifically to get a real hit-rate estimate before committing to a review volume nobody has sized. **The natural, already-decided anchor for this is that same pilot:** a sized, stratified sample of the pilot batch, reviewed by Peter and the DO before any expansion beyond it, rather than a separate number invented here. This assessment does not pick the sample size or the pilot's exact scope on Peter's behalf — that is his decision to make, the same way the original assessment left its own 14-day figure for him to set.

**PETER'S DECISION (fill in before this moves past shadow mode):**

> Shadow-mode exit criterion for the pilot batch: _______________________
>
> Sample size / review method: _______________________
>
> Sign-off to expand beyond the pilot: _______________________ (date: _______)

---

## Verdict

**This document does not clear this build.** It names the new risks at this scale, points to where each is mitigated in the technical spec, states plainly which residual is not yet closed, and lays out Rule 6's three prongs honestly — one given for scope only, two open. Before this build runs against real data:

1. Both attorney questions above need answers.
2. A fresh Asimov/Mason confirmation pass needs to verify the technical spec's mitigations actually close the gaps as specced.
3. Peter needs to give his own explicit, on-the-record approval of this build's specific compliance risk — distinct from the scope and product decisions already given.
4. Peter needs to fill in the shadow-mode exit criterion above.

Only after all four are true should this run past the pilot batch.
