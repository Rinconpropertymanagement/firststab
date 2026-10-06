# Archive Search — Owner Risk Acceptance: Launching the Significance Backfill Without the Override-Branch Merge

**This is an owner risk-acceptance document, not a governance or legal
clearance.** Asimov reviewed this specific gap and explicitly did **not**
approve launching without the fix (see its verdict quoted below). Mason has
not reviewed this. Outside counsel has not reviewed this.

## What is being skipped

Overnight into this morning (2026-09-17/18), a real, live database
performance bug forced a redesign of `fetchDriverPage()`/
`fetchNextEligibleConversations()` in
`projects/hub/archive-search/lib/significance-pass.js` — the driver that
finds which conversations are still eligible for the significance-tagging
pass ahead of the real 84,408-conversation, one-year historical backfill.

The new design (migrations `20260918000000`, `20260918020000`) reads a
simplified view, `missive_message_intake_search_safe_clear_branch`
(screening_result = 'clear' only), instead of the original
`missive_message_intake_search_safe` view. The original view was a UNION of
that same clear-screened branch **and** a second branch drawn from
`archive_search_flagged_overrides` — conversations originally screened out
as real Fair-Housing-flagged correspondence, which a human later reviewed
and specifically granted an override to make visible again
(`supabase/migrations/20260912010000_archive_search_flagged_overrides_schema.sql`).

Application code to fetch that override branch and merge it into the
driver's eligible set — always intended, described in both of this
morning's migrations — was never actually built. Q flagged this explicitly
rather than silently shipping around it. The practical effect: as the
driver ships right now, tonight's real backfill run will **not** include the
127 currently-active override conversations as candidates at all. They are
not deferred to a later page of the same run — they simply never become
eligible under the new driver.

## Asimov's verdict on this specific gap

Quoted directly, not paraphrased: **"This needs to be built before tonight's
real launch. I would not approve running the 84,408-conversation historical
pass without it... These are not an arbitrary 127 conversations... very
close to the highest-signal subset in the entire 84,408-conversation corpus
for exactly the categories this pass exists to catch... Silently dropping
that subset from a compliance-triage pass is a materially different risk
than dropping 127 random routine-logistics threads would be."** Asimov also
recommended looping in Mason briefly on this specific question, given this
table's real Round 3 governance history
(`compliance/archive-search-escalation-mechanism-review.md`), and said that
if Peter chose to launch anyway, it needed to be a written, explicit risk
acceptance — not a silent default. That is what this document is.

## Peter's decision, verbatim

**"no. not interested in building. i accept any risk associated with the
decision."**

No further reasoning was given beyond this. This document records the
decision as made, not a reconstruction of unstated reasoning.

## The real, honest risk being accepted

Stated plainly, not minimized:

- The 127 conversations currently active in `archive_search_flagged_overrides`
  were originally screened out specifically because they matched Fair
  Housing-relevant content, then manually reviewed and released for
  visibility by a human. They are a real, identified, non-random subset with
  a documented history of Fair-Housing relevance.
- Tonight's real backfill (the significance/complaint-tagging pass, covering
  categories including `legal_exposure`, `owner_instruction`,
  `accommodation_related`, and `escalation_recurrence`) will not consider
  these 127 conversations at all, in this run or any future run, unless the
  override merge is built and a later run is deliberately pointed back at
  them.
- There is currently no code-level record or alert marking that these 127
  conversations were excluded from this pass. Absent this document, nothing
  in the system would show, later, that this specific subset was
  deliberately skipped rather than simply not yet reached.
- Mason was not consulted on this specific question before the decision was
  made, despite Asimov's explicit recommendation that he be.
- This is a scope gap, not a data-quality or timing/staleness issue — the
  127 conversations are not stale or delayed, they are excluded outright
  from this driver as currently built.

## What happens next

This document authorizes tonight's real backfill to proceed against the
84,408-conversation one-year window **without** the 127 active override-branch
conversations as candidates. The override merge remains a known, open,
deferred piece of work — the design for it is already written in migration
`20260918000000`'s own header and restated in `20260918020000`'s handoff
section 4 (point 4), ready to build later using the same
`passesEscalationExclusion()` function already built and tested tonight.
Asimov and Mason will be shown this document — this is a transparent owner
decision, not something hidden from them after the fact.

---

## Signature

**I have read this document, understand the risk described above — that
tonight's real backfill will not consider the 127 currently-active,
previously Fair-Housing-flagged, human-overridden conversations at all —
and accept that risk as owner of Rincon Management.**

Signed: Peter McKenzie — confirmed in chat, verbatim: "no. not interested in
building. i accept any risk associated with the decision."
Peter McKenzie, Owner, Rincon Management
Date: 2026-09-18
