# Decision Resolution: AppFolio `maintenance_notes` Display — Review Workflow Overridden by Peter

**Date:** 2026-09-06
**Status:** Resolved. This document is the durable record of Peter's decision, referenced by the Neo migration (`supabase/migrations/20260906000000_add_maintenance_notes_to_properties.sql`), and should be cited by Q/Tron's build work and by any future review of this feature.

---

## What the two governance reviews recommended

Both reviews are real and remain in the repo in full:

- `compliance/appfolio-maintenance-notes-governance-review.md` (Asimov) — verdict **"NOT YET APPROVED TO BUILD"**, conditioned on Mason's review, a validation pass (a human reading all flagged rows plus a real sample of unflagged rows), and Peter's explicit go-ahead. Recommended an ongoing per-sync re-check inside `sync.js`'s `buildRow()`, a two-outcome review-status column (`released`/`suppressed`), and a "pending review" placeholder for anything flagged.
- `compliance/appfolio-maintenance-notes-fair-housing-review.md` (Mason) — verdict **"FLAGGED ⚠️ — Buildable, with the controls above in place."** Found Medium-High risk in principle (an owner-instruction field is the same failure mode `operational_notes` was built to catch), called the ongoing per-sync re-check "not just sufficient, it's the only safe design... a hard requirement," and recommended per-role access gating narrower than blanket Maintenance-tab visibility, plus a short outside-counsel confirmation before production display.

Both reviews were reasoned and correct given what they knew at the time. What changed is described below.

## What actually happened after both reviews landed

1. Peter corrected a factual premise both reviews relied on: **this is not an unreviewed, forgotten backlog.** Rincon's own staff write these notes in AppFolio and use them daily to coordinate maintenance — they are read and relied on constantly, just never through an automated Fair Housing screen. This changes (does not eliminate, but changes) the risk profile both reviews reasoned from.
2. All 194 currently-populated real values were pulled live from AppFolio and written verbatim, unfiltered, to `compliance/appfolio-maintenance-notes-full-export.md` — sent directly to Peter for his own review.
3. Peter reviewed the actual content and stated directly: **"these are benign for fair housing issues."** Confirmed explicitly in this session that this was a real manual review of the actual export, not a guess based on general familiarity with the field: **"i did a manual review already."**
4. As a second, independent check (not requested as a condition, offered and run anyway): every one of the 194 values was scanned against the exact same Fair Housing keyword list `maintenance_claims` uses (`scanText()` in `lib/protected-class-terms.js`). **Result: zero matches, 194 of 194.**
5. With that in hand, Peter made an explicit decision, stated directly and more than once:
   - **No per-row review workflow, no flagging column, no review-status vocabulary.** ("we arent going to go through a crazy review process")
   - **No visible warning, caveat, or disclaimer language of any kind** on the displayed text.
   - **Same visibility as the rest of the Maintenance tab** — no new, narrower access tier.
   - Placement: a plain text block next to the existing pie chart on Property 360's Maintenance tab, always visible, never behind a click-through or dropdown.
   - Confirmed to proceed: **"yes send it."**

## Scope of the override — confirmed explicitly to cover future edits, not just today's backlog

Q (the builder) correctly paused a second time on a real, substantive gap: Mason's "hard requirement" language for an ongoing per-sync re-check wasn't really about the 194 values that exist today — it was about the fact that Rincon staff add and edit these notes in AppFolio continuously, and without a re-check, every future addition or edit would get zero Fair Housing screening, silently, forever. A one-time read of today's 194 values only clears today's backlog, not that ongoing exposure.

Jarvis put this exact question to Peter directly, plainly: is "no review process" a decision about today's 194 notes, or does it also mean no screening on any future edit to this field, forever? Peter's direct answer, in this session: **"no review process needed."** This is Peter's explicit, informed confirmation that the override covers ongoing future syncs, not only the current backlog — he was told the specific tradeoff (zero screening on all future additions/edits, not just today's content) before answering.

## What Peter did NOT override

- The housing-decision firewall stands, unchanged and non-negotiable: this column must never be joined, foreign-keyed, or referenced by any leasing, screening, delinquency, renewal, eviction, or security-deposit code path, now or in any future change. Q was already instructed on this and it is not affected by anything in this document.
- Nothing about how this data is *sourced* changes — no new AppFolio credential, no new connector, same nightly sync.

## The outside-counsel item — resolved, declined by Peter

Mason recommended a short confirmation from the same outside counsel who reviewed the Tier A/B redesign and `operational_notes`, on the reasoning that neither existing opinion was scoped to this new AppFolio data source. Mason was explicit that this is his own attorney-referral, not something he can resolve internally — he flagged the gap but could not close it himself.

Peter's direct decision, stated in this session: **no counsel review needed.** In his own words: "i am accepting any risk even though it would be very monor at best." This is Peter, as the business owner, personally accepting whatever residual legal risk this specific gap represents (which both Mason's review and the zero-match scan already characterized as low), rather than commissioning further attorney review. This closes the item — it is not left open, and no further follow-up on it is expected.

## What this means for the build

- Neo's migration (`20260906000000_add_maintenance_notes_to_properties.sql`) — already written to match this decision exactly (plain nullable column, no review-status field, no default). No change needed.
- Q's sync mapping — proceed exactly as originally briefed: map `maintenance_notes` from the existing `property_directory` sync response into the new column, no content-check call, no flagging logic, with the housing-decision-firewall comment at the mapping line. This document is the durable confirmation that was missing.
- Tron's UI work — proceed exactly as originally briefed: plain text block next to the pie chart, always visible, no warning/caveat language, omitted cleanly when empty.
