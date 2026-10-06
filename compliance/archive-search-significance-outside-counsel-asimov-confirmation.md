# Asimov — Confirmation Pass, Outside Counsel Opinion (Archive Search Significance + Complaint-Tracking Merge)

**Date:** 2026-09-13. Confirmation pass against my own prior NOT CLEARED review
(`compliance/archive-search-significance-complaint-merge-asimov-review.md`),
in light of the real, received outside-counsel opinion
(`compliance/archive-search-significance-outside-counsel-opinion.md`), per
Peter's direction on file there: *"as usual you are to conservative and
overboard. please make this according to the opinion."*

**Ground rule for this pass:** counsel's answer controls anything it was
actually asked. I am not re-litigating those. I am independently checking
which of my nine items are actually privilege/discrimination-note questions
(controlled by the opinion) versus something else entirely (not controlled by
it, and still open on its own terms).

---

## Item-by-item

**1. Fresh attorney opinion on privilege — RESOLVED, with one narrow
build-mechanics task still owed, not a legal gate.**

Question One's answer is unambiguous: no privilege screen required, explicit
rejection of reinstating one, explicit statement that the 3,623
previously-held conversations do not need to be pulled again (Section 1, 11,
Specific Answers). This closes the legal question in Finding 1 in full — an
AI generating written legal-exposure analysis over that population does not
need its own privilege pre-filter.

What it does not close, because it was never asked: the spec's own committed
fix (Section 5) to `categorize-complaint.js`'s false precondition — the line
telling the model a hold check "already cleared" this thread — has not yet
landed in the actual file. I checked directly, today: `categorize-complaint.js`
line 62 and `subject-match.js`'s header (line 41) still state the old,
now-false precondition. This was never a privilege question — it's whether
the model is being told something true about its own input. The spec already
commits to the fix (Section 5's replacement text); it just hasn't been
written into the code yet, because no code has been written yet. Not a new
gate — a checklist item for Q at build time.

**2. Fresh attorney sign-off on `owner_instruction_rejected` wording —
RESOLVED as a legal matter; the spec's current text is now stricter than
what's authorized and needs to change.**

Question Two's answer explicitly approves automatic generation, without
prior human review, of exactly this kind of note — provided it's framed as
present-day automated assessment, not historical fact (Section 5, 7, Specific
Answers). Counsel's own template:

> "AI-assessed in 2026 as a potential discriminatory owner instruction.
> Rincon's current standard procedure would be to decline the instruction and
> follow nondiscriminatory procedures. The available historical record does
> not establish what response was actually provided at the time."

I compared this against the spec's actual current text (Section 5, under
`historicalTemplateNote`). They are not the same design. The spec, responding
to my and Mason's original Finding 2, went further than hedged wording — it
dropped AI drafting for historical mail *entirely*: "no note text is
generated at all... A human decides whether a note gets written at all, and
writes it themselves." That is more restrictive than what counsel just
approved, and it is exactly the "conservative and overboard" pattern Peter is
pointing at.

**This is the one item where the fix is not just build-mechanics — the spec
text itself needs to change.** Oracle should revise Section 5 to reinstate
AI-drafted `note_text` for historical `owner_instruction_rejected = true`
findings, using wording matching counsel's blessed pattern, carrying a
structural "Automated historical assessment — not human verified" tag
wherever that note surfaces (not just in the note text itself — the tag needs
to travel with the record through Property 360, `compliance-review.html`,
and `complaints`, the same way `discovery_context` already travels
structurally rather than by convention). I am not drafting that prompt
language myself — that's Oracle's document to revise and Q's to build — but
I am naming exactly what has to change and why.

**3. Section 6's mandatory-clearance checklist, extended to
`owner_instruction_rejected = TRUE` historical rows — RELAXED, on my own
independent judgment, not merely because counsel's answer sounds permissive.**

I went back to what my own Finding 2 was actually protecting against: an
unsupervised AI permanently writing an adverse, uncontestable characterization
of a named owner's past conduct, with no operational upside to offset getting
it wrong. Counsel's Section 9 ("Human Review Should Be Triggered by Use, Not
Necessarily Creation") is not a vague permission — it's a specific,
reasoned answer to that exact concern: review is required when someone
proposes to *rely* on the conclusion for a consequential action (terminate an
owner, accuse of discrimination, respond to litigation, discipline, external
report), not before the record is created or shown at all. That is a
different, and I think genuinely better, control than a pre-visibility
clearance gate — it puts the human check at the moment the risk actually
materializes (someone about to act on the finding) rather than at a moment
that may never correspond to actual use (a backlog item nobody was going to
act on anyway).

**My own judgment, independent of wanting to be less restrictive for its own
sake: yes, relax this specific criterion.** Replace the pre-visibility
mandatory-clearance requirement for historical `owner_instruction_rejected =
TRUE` rows with three things, all structural, not policy-on-paper:

- A tag — "Automated historical assessment — not human verified," or
  materially equivalent — that travels with the record everywhere it
  surfaces, enforced the same structural way `discovery_context` already is
  (a column/generated field every reading site inherits), not left to each
  page's own copy.
- The source thread permanently, directly reachable from the record — already
  true by construction in this design (the finding lives on the same
  `missive_conversation_significance`/`complaints` row as the conversation
  reference); just confirming it isn't lost in the relaxation.
- A reliance gate, written down as a standing rule (I'd put it in the
  technical spec's Section 6 and flag it for a line in GOVERNANCE.md's Fair
  Housing Standard, since it will outlive this one build): before this
  specific kind of record is used for any consequential action regarding the
  named owner — terminating the relationship, accusing them of
  discrimination, responding to litigation or discovery, disciplining an
  employee, reporting externally — a human reviews the underlying
  communication itself, not just the AI note, first. Nothing in this build
  takes any such action today (confirmed, again: no message goes out, no
  housing decision is made anywhere in this design), so this is a rule for
  the *next* tool that reads this table for such a purpose, not new code
  this build has to enforce — but it has to exist somewhere durable, not
  just in this confirmation file.

I want to be precise about scope: this relaxation applies to the criterion I
added in my own Finding 2 — the historical `owner_instruction_rejected = TRUE`
addition. It does **not** extend to Section 6's original mandatory-clearance
carve-out (`category IN ('legal_exposure', 'accommodation_related')` or
`escalation_signal IN (...)`, AND open/unknown) — that criterion protects
against a different risk (a genuinely still-open legal/habitability/
accommodation issue rotting in a passive backlog), not a Fair-Housing finding
about a person's past conduct, and the opinion was never asked about it. That
one stays exactly as specced, protected by Item 4's active notification.

**4. Active notification when the mandatory-clearance list is non-empty —
survives, reframed for the owner_instruction_rejected subset; unchanged for
the rest.**

For the original carve-out (legal_exposure/accommodation_related, still open),
nothing changes — it's still a real pre-visibility gate, still needs the
active push, exactly as the spec already commits to building.

For the `owner_instruction_rejected = TRUE` historical subset, now that it is
no longer a pre-visibility clearance gate (Item 3), the notification's job
changes but doesn't disappear: Peter and the DO should still be told, once,
when the historical backfill finishes, how many `owner_instruction_rejected =
TRUE` historical findings exist — not because anyone must clear each one
before it's visible, but because this is exactly the kind of bulk compliance
signal a reasonable operator wants pushed to them, matching the posture Peter
already set for privilege escalation ("escalation will happen outside of the
hub"). Practically: the same single notification the spec already commits to
building just needs to name this count too, informationally, alongside the
legal_exposure/accommodation_related clearance count and the "Needs a Human
Call" queue count. This is not new work — it's the same build requirement
already in Section 6, now covering one more number.

**5. Section 4's `complaints`-creation trigger, extended to fire on `category
IN ('legal_exposure', 'owner_instruction')` alone — confirmed untouched by the
opinion, and confirmed already fixed in the spec text.**

This was never a privilege or discrimination-record question — it's whether
the paging machinery reliably reaches the Director of Operations for a real
live issue, a reliability/completeness question. The opinion doesn't address
it because it was never asked. Separately, and worth stating plainly: I
re-read the current technical spec (Section 4) directly, and my required item
5 is already written in — the `complaints`-creation trigger now includes
`category IN ('legal_exposure', 'owner_instruction')` on its own, for both
live and historical mail, with an explicit citation back to this finding.
This item is closed on the spec side. It carries into build as an ordinary
TARS verification item (does the row actually get created), not as an open
governance gate.

**6. Standalone AI Risk Assessment document — confirmed it exists; needs one
small update, not a rewrite.**

`compliance/archive-search-significance-complaint-merge-ai-risk-assessment.md`
exists, written by Oracle at my request, dated today. I read it in full. It's
a real, substantive, Peter-readable document — it names the same four risks
both fresh reviews found, points to where each is mitigated in the spec,
states the residual honestly, and lays out Rule 6's three prongs without
softening any of them. As a document, it satisfies Rule 7's requirement for a
fresh, standalone artifact at this operating mode/scale — that requirement is
met.

It does need one update: its "Attorney review" status line (under "Rule 6's
Three Prongs — Status") currently reads "two questions drafted, pending" —
that's now stale. The opinion is in. Oracle should update that section to
reflect what the opinion actually resolved (Items 1 and 2 above) and what it
didn't (the owner-approval and shadow-mode prongs, still open — see Item 7).
This is housekeeping on an already-good document, not a new deliverable.

**7. Peter's own explicit approval of the compliance risk, plus a
bulk-appropriate shadow-mode exit criterion — confirmed fully open. This is
the one item where the opinion changes the picture without being able to
close it.**

An attorney opinion cannot supply owner approval, and Rule 6 requires both
independently — that hasn't changed. What has changed: the underlying legal
risk this build carries is now substantially smaller than it was when the
original 14-day/"review all of it" plan (built for a different tool, at a
different scale) was written, and smaller than it was when my own prior
review was assessing this merge against unanswered legal questions. Counsel
has now said, in terms: no privilege screen needed, automatic historical
discriminatory-instruction notes are fine with the right labeling, human
review belongs at the point of reliance, not creation.

My own view, since I was asked for it directly: that legal clarity supports a
**smaller** shadow-mode sample than "100% of everything," but not zero, and
not uniformly small. I'd point Peter toward a stratified approach that
matches where risk is actually concentrated post-opinion — a meaningful
random sample across the pilot batch generally, but full review of the two
buckets that remain genuinely load-bearing regardless of the opinion: every
row on the original legal_exposure/accommodation_related mandatory-clearance
list (Item 3's untouched half) and every row in the "Needs a Human Call"
queue. Both of those already require human eyes by the spec's own design —
so this isn't new review burden, it's confirming the existing design already
does the right thing at whatever sample size Peter picks for everything else.
The actual number, and the sign-off to expand past the pilot, are still
Peter's to write into the risk-assessment document's own fill-in-the-blank
section — not something I or counsel can complete on his behalf.

**8. Completed Rule 4 data inventory for the merged schema — confirmed
unaffected by the opinion, confirmed still open, confirmed Neo's to do.**
Nothing here.

**9. Mason's own review — noted, not re-derived.** Mason completed a full,
independent NOT CLEARED review
(`compliance/archive-search-significance-complaint-merge-mason-review.md`)
and is running this same confirmation pass in parallel. His domain — the
eight-category/five-signal vocabulary, and the Fair-Housing-specific half of
Items 2 and 3 above — is his to close, not mine. I have not assumed his
answer in anything above; where my Item 3 judgment overlaps his parallel
Finding 2, both of us need to land in the same place before either of us
calls it closed on that point.

---

## Verdict

**STILL NOT CLEARED — but the list is now short, concrete, and mostly not
mine or counsel's to close.**

What the opinion actually did: fully resolved the legal question behind Item
1, fully resolved the legal question behind Item 2 (though the spec's current
wording needs to catch up to it), and gave me a real, reasoned basis to relax
Item 3 for the one criterion it was aimed at — not because permissive-sounding
language invites relaxation, but because counsel's reliance-triggered-review
principle is a better-fitted control for the actual risk than a pre-visibility
gate was. Item 5 turned out to already be fixed in the spec. Item 6's
artifact already exists.

What's left, in order of who owns it:

1. **Peter's own, explicit, on-the-record approval of this build's compliance
   risk, and his shadow-mode exit criterion** — fill in the blanks in
   `archive-search-significance-complaint-merge-ai-risk-assessment.md`.
   Nothing above supplies this; it was never counsel's or mine to give. (Item
   7.)
2. **Mason's parallel confirmation, on record.** His domain, not mine. (Item
   9.)
3. **Neo's Rule 4 data inventory for the merged schema.** (Item 8.)
4. **Three concrete edits to the technical spec, before Q builds against
   it** — not new governance gates, just making the document match what's
   now actually authorized, no more restrictively and no less:
   - Reinstate AI-drafted `note_text` for historical
     `owner_instruction_rejected` findings, using counsel's blessed hedged
     template, with a structural "not human verified" tag. (Item 2.)
   - Replace Section 6's pre-visibility clearance requirement for that same
     historical criterion with the tag + reachable-source + reliance-gate
     model above; leave the original legal_exposure/accommodation_related
     carve-out untouched. (Item 3.)
   - Fix the stale `checkThread()`-already-ran precondition text — confirmed
     still live today in `categorize-complaint.js` line 62 and
     `subject-match.js`'s header — per the spec's own already-committed
     Section 5 replacement language. (Item 1.)

Once 1–3 are on record and 4 is written into the spec, I'd expect this to
clear on my side. I am not manufacturing caution the opinion didn't ask for —
Items 1, 2, and 3 moved because counsel's answer and my own reasoning about it
actually support moving them, not because Peter asked for speed. I am also
not waving away Items 7, 8, and 9 to deliver that speed — none of them was a
question anyone asked outside counsel, and the opinion doesn't touch them.

— Asimov
