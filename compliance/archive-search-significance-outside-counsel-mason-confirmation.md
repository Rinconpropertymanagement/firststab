# Mason — Confirmation Pass, Outside Counsel Opinion (Archive Search Significance + Complaint-Tracking Merge)

**Date:** 2026-09-13. Read in full: my own prior review
(`compliance/archive-search-significance-complaint-merge-mason-review.md`),
the received opinion
(`compliance/archive-search-significance-outside-counsel-opinion.md`),
and — because it bears directly on what's actually left to decide — the
**current** state of `projects/hub/email-intake/archive-search-significance-technical-spec.md`
(588 lines, dated 2026-09-13, already a third same-day revision responding
to my and Asimov's fresh reviews). Verified two mechanisms directly against
live code: `checkClaim()`'s audit-log wiring
(`projects/hub/complaint-tracking/lib/process-pending-messages.js` lines
340-381) and its export shape (`projects/hub/maintenance-history/lib/content-check.js`
lines 88-157).

**Framing, up front, because it changes the answer to "what's left":** two
things happened since my NOT CLEARED verdict, not one. The opinion answered
the two questions sent to counsel. Separately, and *before* the opinion
came back, Oracle already revised the spec in direct response to my own
findings (Section 12 says so explicitly: "Everything else both reviews
found is addressed in this revision"). That means Findings 3, 4, and part
of 5 are not waiting on counsel at all — they were already fixed at the
spec level, on their own merits, days before this opinion existed. I
confirm that below rather than assuming it because the task asked me to
verify independently, and because "the opinion doesn't address it" is not
the same claim as "it's still open" — in three of my five findings it
turned out to mean the opposite.

---

## Finding 1 (privilege gap) — RESOLVED by the opinion, with one narrow residual already satisfied on inspection.

Question One's answer is unambiguous and directly on point: no privilege
screen is required "based on the architecture described," the prior
searchability conclusion "remains applicable," and Section 1 explicitly
declines to require "a separate legal-content classifier before the
principal AI analysis" or "removal of the previously restored 3,623
conversations." My own recommended mitigation — reinstate a narrow
`checkThread()`-based privilege *tag* ahead of Call 2 — is exactly the kind
of measure counsel considered and rejected as unnecessary. I withdraw it.
Section 11's own risk table price this at "LOW TO MODERATE RISK /
ACCEPTABLE" for the attorney-adjacent subset specifically — not zero, but
counsel's own graded acceptance, not silence.

**The residual task you flagged (field names/UI language for `legal_exposure`
output) — checked directly against the current spec text, not assumed
clear.** Section 5's rewritten precondition (lines 166-177) tells the model
plainly that no privilege filter ran — it never instructs the model to
*label* its own output "privileged," an "attorney conclusion," or "legal
advice," and I read every prompt block in Sections 5 and the Call 2 prompt
(lines 143-267) looking for exactly that. None exists. The category name
`legal_exposure` and the drafted `why`/`note_text` fields are operational
classifications in counsel's own sense (Section 2: "'Potential litigation
matter...' is an internal system classification. It should not
automatically be labeled 'Privileged Legal Analysis.'") — the spec never
applies that label. **One forward-looking note for Tron/Q, not a blocking
gap:** when `compliance-review.html`/Property 360 render these fields, make
sure no UI heading ever says "Attorney Analysis" or "Privileged" — cheap to
get right now, and this is the kind of thing that's easy to introduce later
without anyone re-checking against the opinion. Flagging it as a build note
in the sign-off below, not as an open legal question.

**Verdict on Finding 1: fully resolved.** No further attorney work needed
on this point.

---

## Finding 2 (retroactive `owner_instruction_rejected` note) — MY OWN EXTRA RESTRICTION IS WITHDRAWN. Yields to the opinion.

This is the one where I need to be direct about my own prior call, because
it's the one Peter is actually pushing back on. Two versions of "restrict
this" exist in the record:

1. **My original review's recommendation** (Finding 2, first review): set
   `owner_instruction_rejected` and route to human review, but don't
   auto-draft `note_text` at all — a human decides whether any note gets
   written.
2. **What the spec actually shipped in response** (Section 5,
   "historicalTemplateNote," current text): went further than I
   recommended — it drops the AI-drafted historical template *entirely*,
   leaves `note_text` NULL for every historical row, and requires a human
   to write the note themselves through Section 6's checklist UI if one
   gets written at all.

Question Two's answer addresses this fact pattern exactly — "may the AI
automatically create and retain present-day operational notes concerning
historical owner communications that appear discriminatory" is not an
analogy to what this spec does, it *is* what this spec does. Counsel's
answer: **yes**, generated automatically, without prior human review,
provided (a) the wording follows the present-day-assessment pattern (which
the earlier, now-dropped draft template already used — "AI-assessed in
2026... no record confirms what was actually communicated") and (b) the
record carries a clear designation that it's unverified — counsel's own
suggested wording is "Automated historical assessment — not human
verified" (Section 6).

Sections 5-9 close every distinct sub-concern my original Finding 2 raised:
misclassification risk of an ambiguous instruction (Section 7 — expected,
tolerable, provided the note characterizes the *communication*, not the
*owner*, in categorical-accusation terms), the "confident assertion with no
downstream double-check" concern (Section 8 — confidence and uncertainty
can both be expressed directly; a definitive guilty/not-guilty framing
isn't required, and my worry that the categorization half of the note
needed its own separate hedge is answered by the same section — the
blanket "not human verified" label is the calibration counsel wants, not a
second qualifier stacked onto the categorization clause specifically), and
the "no chance to contest before consequential use" concern (Section 9's
reliance-gate model — nothing stops the note from being wrong; it stops a
wrong note from being *relied on* for something that matters to the owner
without a human looking at the source first).

**I withdraw my own added restriction.** It was a defensible position to
take without an opinion in hand, but it doesn't rest on anything the
opinion left untouched — Question Two is precisely this scenario, answered
directly, with named conditions. Holding out for stricter treatment now
would be re-arguing a point counsel actually decided, which is exactly what
you asked me not to do, and what Peter's direction is pushing back on.

**What this means for the build, concretely — Section 5 needs to change
back, with one addition, not just revert:**
- Reinstate `historicalTemplateNote` and auto-draft `note_text` for
  historical mail, using the present-day-assessment pattern already drafted
  once in Section 3 before it was dropped ("AI-assessed in [year]: this
  [year] owner instruction, if acted on, would require Rincon's standard
  refusal — no record confirms what was actually communicated to the owner
  at the time") — this wording already matches counsel's own preferred
  phrasing in the Question Two answer almost verbatim.
- **Add the label counsel actually requires and the dropped draft never
  had:** every auto-generated historical note must carry "Automated
  historical assessment — not human verified" (or materially equivalent
  wording) as part of the stored text, not just as a UI badge layered on
  top. Counsel calls this "the" solution to the concern, not one option
  among several — it should be in the record itself, not only in how it
  renders.
- **Keep Section 6's mandatory-clearance checklist and the `needs_human_call`
  queue exactly as built.** Neither one is a creation-gate or a
  visibility-gate on inspection (see Finding 4 below) — they're a tracked
  obligation to look, layered on top of a record that already exists and is
  already visible to the appropriate tier. That's fully compatible with
  counsel's Section 9 model, not in tension with it, so nothing here needs
  to be removed to honor the opinion's permissiveness — only Section 5's
  "don't draft it at all" decision does.

**Verdict on Finding 2: resolved, but requires an actual spec edit before Q
builds** — reinstating the auto-draft is not automatic just because the
opinion permits it; someone has to put the reinstated template and the new
mandatory disclaimer line back into Section 5's text. That's a same-day
Oracle edit, not a new open legal question.

---

## Finding 3 (`checkClaim()` ambiguity) — the opinion doesn't touch it, and independent verification shows it's already closed at the spec level.

Confirmed the premise: nothing in the opinion addresses this — it's a
build-mechanics question about whether an independent keyword+AI Fair
Housing layer survives the merge, not a privilege or discrimination-record
question. Correct to treat it as outside what was asked.

**But "outside what was asked" and "still open" are different claims, and
I checked rather than assumed.** The current spec (Section 5, lines
179-184; schema, Section 7, lines 361-372) already answers exactly what I
asked for: `checkClaim()` is retained as a genuine second, separate call on
Call 1's own self-check output, four new columns store its result
independently of the model's own self-report so a divergence stays
visible, and a `true` flag fires the same `audit_log` entry pattern
(`complaint_tracking.protected_class_flagged`, `risk_level: 'high'`,
`actor_type` keyed off Tier A/Tier B) that `process-pending-messages.js`
already implements today. I read that code directly (lines 340-381) rather
than taking the spec's description on faith — the mechanism described is
real, matches the live implementation, and is not decoration. This was
fixed by Oracle's own revision in response to my first review, independent
of and before the counsel opinion arrived.

**Verdict on Finding 3: resolved — at the spec level, not the opinion level.
Confirmed genuinely closed, not just genuinely un-addressed by counsel.**

---

## Finding 4 (`needs_human_call` queue bound + `accommodation_related` in the checklist) — already fixed in-spec; the deeper "should the model be lighter-touch" question resolves in favor of keeping it.

Same pattern as Finding 3. My two concrete asks — add `accommodation_related`
to Section 6's mandatory-clearance category list, and put a real bound on
the review queue instead of "reviewed whenever someone opens the tab" — are
both already in the current spec text, not proposed: `accommodation_related`
is explicitly listed ("now widened to include `accommodation_related`,"
Section 6), and a real bound exists ("A real, active bound on both review
surfaces — required before build" — one outbound notification, through
Peter's existing out-of-Hub channel, fired once when the historical backfill
completes, naming both surfaces' counts). Both predate the opinion.

**On your deeper question — does counsel's Section 9 ("review triggered by
use, not creation") mean the mandatory-clearance model itself should be
relaxed:** I looked closely at what the checklist actually *does*, not just
its name, because "mandatory-clearance-before-visibility" is a fair
description of how Asimov and I both characterized it in the first review,
but it doesn't match what the spec text actually implements. A row that
qualifies for the checklist (`legal_exposure`/`accommodation_related`/
`escalation_signal` open-or-unknown, or historical
`owner_instruction_rejected = 'true'`) is **already created, already stored,
and already visible** wherever `is_big_issue = TRUE` is read — Property 360,
the Historical Backlog tab — the same instant Call 2 writes the row. The
checklist adds a second, parallel obligation ("this must also appear on a
list someone affirmatively clears") — it does not gate the first thing on
the second. Nothing about it blocks creation, and nothing about it blocks
ordinary visibility. That is not the "human-must-look-first" model counsel
was contrasting against; it's much closer to counsel's own model already —
the record exists and is usable the moment it's made, and a human is
guaranteed to look at some point, just not necessarily before the row shows
up on Property 360.

Given that, there's no real conflict to resolve by relaxing anything. My
own judgment, asked for directly: I would **keep** the mandatory-clearance
obligation for `legal_exposure`/`accommodation_related`/historical
`owner_instruction_rejected = 'true'`, specifically because it's already
this cheap — non-blocking, already-built, tied to a one-time notification
rather than an open-ended burden — and because Finding 5 below is a real,
distinct accuracy risk that a bounded "someone will look" guarantee
directly mitigates. Counsel's "labeling plus reliance-gate" model is
sufficient as the *legal* floor; keeping this on top of it is a business
choice about how fast Rincon wants to find out its own AI mischaracterized
a disability-accommodation thread as "still open" or "resolved," not a
compliance requirement the opinion imposes. Peter is free to drop it and
rely on the reliance-gate alone without contradicting the opinion — I'd
just tell him plainly what he's giving up if he does, the same way I'd want
told.

**Verdict on Finding 4: the concrete build gaps are already closed. The
model itself doesn't need loosening — it already matches counsel's
framework more closely than its name suggests, and I recommend keeping it
as-is.**

---

## Finding 5 (`accommodation_related`/`legal_exposure` — wrong "still open" reads on old mail) — confirmed still open, untouched by the opinion, distinct from Finding 4.

Confirmed on the premise you asked me to check: nothing in the opinion goes
near this. The opinion is about whether AI may analyze and generate records
from potentially privileged or discriminatory-instruction content at all —
it has nothing to say about whether the model's *read* of resolution status
or tone on old, resolved-off-channel threads is systematically reliable.
That's a different question in kind, not degree.

I also re-checked whether the spec's own fixes happen to cover it anyway,
the same way they quietly covered Findings 3 and 4 — they don't, fully.
Section 5's `historicalFraming` fix is scoped precisely to the
silence-context date-math bug feeding `escalation_signal`/`blocked_resolution`
(Call 2 only) — it does nothing for `tone_trend` or `resolution_status`
(Call 1 fields, unaffected by the date-math bug, but still vulnerable to
the structural bias I described originally: a thread resolved by phone
reads as unresolved/escalating on its face, regardless of age, because the
last thing in the archive is disproportionately the unresolved-sounding
message). That structural bias is not fixed and, per Section 5's own
scoping language, was never claimed to be — it's a real, live gap, exactly
as risky as I originally described, for exactly the two categories where a
false "still open" read carries the worst downside if it ever surfaces in
a HUD/DFEH complaint or discovery.

What **has** changed, independent of the opinion: my recommended
mitigation — treat both categories as automatically requiring a human look
on any historical item that isn't confidently resolved, rather than a
prompt-level fix — is exactly what Section 6's `accommodation_related`
inclusion (Finding 4) now does. The underlying inaccuracy risk doesn't go
away; the procedural backstop I asked for is already built.

**Verdict on Finding 5: remains open on its own merits, independent of
Finding 4's resolution and independent of the opinion. Not a blocker to
building — the mitigation is already in place — but worth Peter hearing
plainly: this is a real, permanent limitation of reading old mail for tone,
not a gap anyone is going to close with a better prompt.**

---

## General Fair Housing Standard Check and Jurisdiction — reconfirmed, no change.

Checked rather than assumed, per your instruction. The opinion doesn't
touch the protected-class list, disparate-impact concerns, or jurisdiction
at all — it's scoped entirely to privilege/confidentiality and to how an
AI-generated discriminatory-instruction note should be worded and
reviewed. If anything, Section 7 of the opinion ("classification of
communication versus adjudication of person... avoid: 'Owner discriminated
against disabled tenant.' Prefer: 'AI identified this communication as
potentially involving a disability-based owner instruction.'") is itself
Fair Housing Standard-consistent language discipline — it reinforces
GOVERNANCE.md's Rule 9/protected-class framing rather than creating any
tension with it. My original review's finding stands unchanged: this
design produces internal compliance artifacts, not tenant/owner/applicant-
facing communication, so Rules 7/8's outreach-facing concerns don't apply
directly; no output here approves, denies, or conditions a housing
decision. Jurisdiction remains Southern California per the codebase's
standing convention; nothing in the opinion or the spec revision surfaces
any city/county-specific ordinance question the original review didn't
already flag as unaddressed-and-out-of-scope-for-this-merge.

---

## Attorney Referral

**No further attorney referral needed on Findings 1 or 2** — both are
squarely answered by the received opinion, on the actual fact pattern this
build presents, not an analogy to it. Finding 5's residual risk is not a
legal question a further opinion would resolve — it's a model-accuracy
limitation counsel was never asked about and wouldn't be positioned to
answer; the correct response is the procedural mitigation already built
(Finding 4), not more counsel time.

## Verdict

**CLEARED WITH CONDITIONS.**

What's actually left, and who owns each item:

1. **Oracle: reinstate the historical `owner_instruction_rejected` auto-draft
   in Section 5**, using the present-day-assessment template already
   drafted once and then dropped, **plus** the mandatory "Automated
   historical assessment — not human verified" disclaimer counsel
   specifically requires — this is a real edit to the current spec text,
   not automatic just because the opinion permits it. Section 6's
   mandatory-clearance checklist and the `needs_human_call` queue stay
   exactly as built; nothing about them needs to loosen.
2. **Small build note for Tron/Q, not a legal gap:** when rendering
   `legal_exposure`/`owner_instruction` fields in the dashboard, no label
   should ever read "Attorney Analysis" or "Privileged" — confirmed nothing
   in the current spec does this; worth a one-line check when the UI is
   actually built, per Finding 1.
3. **Asimov's own confirmation pass on this same opinion is still
   outstanding** — I checked `compliance/` directly and no
   `archive-search-significance-outside-counsel-asimov-confirmation.md` (or
   equivalent) exists yet. GOVERNANCE.md and this spec's own Section 12
   both require Asimov and Mason to close this together; my sign-off above
   covers the legal/Fair Housing half only.
4. **Peter's own explicit compliance-risk approval and shadow-mode/pilot
   exit criterion (Section 12, items 3-4)** are unrelated to anything the
   opinion resolved and remain his calls to make, not mine — flagged here
   only so they don't get lost once the legal pieces clear.

Findings 1 and 2 are resolved on the merits by the opinion — I'm not
holding either open out of caution beyond what counsel actually decided.
Findings 3 and 4's concrete asks were already closed in-spec, verified
directly against the current document and, for Finding 3, against the live
code it claims to reuse. Finding 5 survives on its own, independent
grounds, with its mitigation already built. Once item 1 above is made
(the Section 5 edit) and item 3 (Asimov's parallel confirmation) is on
file, nothing legal stands between this and Neo/Q.
