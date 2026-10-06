# Oracle's Report — Narrowing the Archive-Search Fair Housing Self-Report Question

**Date:** 2026-09-12. **Author:** Oracle (research/spec agent). Reproduced
verbatim from Oracle's actual output — nothing paraphrased or summarized in
this file. See
`projects/hub/email-intake/archive-search-self-report-recalibration-spec.md`
for the resulting spec, Peter's recorded decisions, and next steps. This
file is the source analysis those decisions were made against.

---

No code was written or changed for this. This is a plan for Peter to read,
decide on, and then route to Asimov and Mason before anyone builds anything.

## 1. What's actually wrong (confirmed by reading the code)

Oracle read `/Users/petermckenzie/CODE/firststab/projects/hub/archive-search/lib/fair-housing-batch-self-report.js`
in full, plus the two files it says it's modeled on —
`/Users/petermckenzie/CODE/firststab/projects/hub/maintenance-history/lib/tier-b-classifier.js`
and
`/Users/petermckenzie/CODE/firststab/projects/hub/complaint-tracking/lib/categorize-complaint.js`
— and the code that actually uses their output,
`/Users/petermckenzie/CODE/firststab/projects/hub/maintenance-history/lib/content-check.js`
and
`/Users/petermckenzie/CODE/firststab/projects/hub/complaint-tracking/lib/process-pending-messages.js`.

Peter's summary going in was right, but there's a more precise story
underneath it, and it matters for what happens next.

**The prompt itself is not a new, worse question than the precedent it was
copied from.** `categorize-complaint.js` line 73 — the exact same pipeline
used every day for live tenant/owner complaints — asks: "does this thread
touch on a legally protected personal topic ... If yes, set
`protected_class_flag: true`." That's the same broad "does this reference a
protected characteristic" framing the archive-search file uses. This isn't
Q inventing a worse standard — it's the standard this codebase has been
using all along.

**What's different, and what actually causes the 90% number, is what that
flag is allowed to decide.** In `categorize-complaint.js`,
`protected_class_flag` is one field on a much richer output. The thing that
actually puts a complaint in front of a human is a separate judgment in the
same AI call — `process-pending-messages.js` line 285:
`isBigDeal = !!categorization.category || categorization.needs_human_call`.
Six specific categories (legal risk, blocked resolution, churn risk,
escalation, big money, unusual owner instruction) and a distinct
uncertainty flag do that work. `protected_class_flag` rides along mostly as
an audit-trail tag — a high-risk `audit_log` entry gets written, but a
complaint that merely mentions a protected characteristic, with nothing
else going on, does not by itself land in the review queue.

Archive search has no such second gate. By design (per
`projects/hub/email-intake/archive-search-technical-spec.md`, "Resolving
Finding 2" and Finding 1), `screening_result = 'flagged_protected_class'` is
the only signal: it excludes a conversation from search and is exactly what
a human (the Director of Operations) has to review by hand. There is
nothing narrower sitting on top of it. So the same broad question that was
harmless as a side-tag in complaint-tracking becomes the entire
review-routing decision here — and that's the first time it's ever had to
carry that weight alone. Today's real-data run is the first time anyone has
actually load-tested it in that role, and it's buckling under it exactly
the way you'd expect a "does this touch the topic at all" question to
buckle when it's the only gate.

One more thing worth knowing before deciding anything: your own outside
counsel already flagged this exact problem, unprompted, in the existing
opinion
(`/Users/petermckenzie/CODE/firststab/compliance/archive-search-fair-housing-outside-counsel-opinion.md`,
point 9): "I would not automatically exclude every email that mentions a
protected characteristic... 'Owner says he doesn't want families with
children' [vs.] 'Tenant requested grab bars as a reasonable accommodation
and installation was completed June 14.' Both concern protected
characteristics. Only the first presents an obvious Fair Housing compliance
concern." Counsel goes on to say he'd "ultimately prefer the detailed AI
review to distinguish" real discriminatory content from ordinary
operational information involving a protected characteristic. That's this
exact fix, already invited by name — see section 5 for what that means for
going back to counsel.

## 2. The proposed replacement question

Same shape as today (one Claude call, `claude-sonnet-5`, `max_tokens: 512`,
`effort: 'low'`, 12s timeout, JSON-only response) — only the question
itself changes. The full proposed prompt text and the example-pairs table
are reproduced in the spec document (Section 3) rather than duplicated here.

## 3. The honest tradeoff — does narrower mean under-flagging real concerns?

Yes, and it should be stated plainly rather than assumed away. Narrowing
this question necessarily trades recall for precision: fewer flagged
conversations, but a real, non-zero chance that a genuinely concerning one
now gets read as benign — specifically when adverse or discriminatory
conduct is described in muted, professional, deniable language rather than
an obvious refusal ("we thought it best to point her toward the other
building instead" reads softer than "we refused her"). This is the same
failure mode counsel's own opinion already names as unavoidable ("no
keyword dictionary can identify every euphemism... universal AI review does
not eliminate false negatives; it merely moves the point at which they can
occur") — narrowing this question moves that point again, it doesn't
remove it.

This is not a reason to avoid the change, but it is a reason to build in
the mitigations that already exist in this project rather than treat
"narrower" as strictly safer:

- The "if genuinely unsure, answer true" line is deliberately kept in the
  new prompt for the same reason it's in `tier-b-classifier.js` — it biases
  the model toward flagging when it can't tell, rather than confidently
  clearing something ambiguous.
- The fail-closed default still catches every infrastructure failure.
- The employee escalation mechanism already built and cleared
  (`compliance/archive-search-escalation-mechanism-review.md`) is a real,
  independent backstop for exactly this residual risk — any of the
  searchers who personally notices something concerning that the AI
  cleared can still flag it. It only catches what someone happens to
  search for and notice, though — it's not a substitute for the AI check,
  just a second net under it.
- Counsel's own safeguard #7 ("periodically sample both screened and
  unscreened content to determine whether the first-stage filter is
  performing reasonably") should be extended to this change specifically:
  pull a periodic sample from the newly-cleared bucket — conversations the
  old question would have flagged but the new one clears — and have a
  human confirm they're actually benign. That's the concrete way to find
  out, with real data, whether this tradeoff is landing where intended
  rather than just hoping it is.

## 4. Fail-closed behavior — unchanged

Confirmed: nothing about this proposal touches the error handling in
`fair-housing-batch-self-report.js`. Any network failure, timeout,
`stop_reason === 'max_tokens'`, or unparseable JSON still resolves to
`{ flagged: true, category: 'model_self_report_failed_closed' }`. Only the
question asked when the model does respond successfully changes.

## 5. Governance classification — and whether to go back to counsel

This is Critical tier under GOVERNANCE.md Rule 6. Today's wide-net filter
(already live) changed volume/routing — which conversations reach the AI
check at all. This change is different in kind: it changes what the AI
decides once it's looking at a conversation — the actual compliance
decision criteria for a Fair Housing screen. Rule 6 is explicit that
Critical-tier changes need owner approval, attorney review for compliance
changes, and a 7-day shadow mode. This needs Asimov's governance sign-off
and Mason's Fair Housing/legal review before anyone builds it, full stop —
no shortcutting even given the 60-70k volume problem.

**Oracle's recommendation on going back to the actual outside attorney:
yes, with a short, narrow confirmation — not a full re-review.** (Peter's
own decision on this recommendation is recorded in the spec document,
Section 4 — this section preserves Oracle's original reasoning for the
record.)

Reasoning, both ways:

*Why it might not be needed:* the existing opinion already speaks directly
to this, unprompted, at point 9 (quoted above) — counsel isn't being
surprised by the direction, he invited it. Peter has also already used the
"my own explicit documented call that the existing opinion covers this"
path once before, for the escalation mechanism's shadow-mode question, and
Mason accepted it as a valid way to close an attorney-review requirement
without going back to counsel every time.

*Why Oracle would still recommend a short trip back:* three things
distinguish this from that precedent. First, when Asimov and Mason reviewed
a similar "does an old opinion cover a new, related mechanism" question for
the escalation-reopen feature
(`archive-search-escalation-mechanism-review.md`, Round 3), they explicitly
rejected treating a related-but-different mechanism as automatically
covered just because it looked structurally similar to something already
cleared — they required the actual risk direction to be checked, not just
the shape. This change and counsel's point 9 are a good directional match,
but point 9 sketches a concept ("I'd prefer the detailed review to
distinguish three buckets"), not a review of concrete prompt language or
the specific line drawn between "adverse treatment" and "mere mention."
Second, counsel's own three-bucket idea (flag / restrict-but-don't-flag /
allow) doesn't fully match what's proposed here — the spec keeps the
existing two-bucket architecture (flag-and-review vs. clear) rather than
adding counsel's middle "restrict appropriately, no flag" tier, which is a
real, known gap worth surfacing to him rather than silently deciding it's
close enough. Third, the stakes just got concrete: this is the decision
criteria that determines who among 60,000+ real conversations does or
doesn't get a human's eyes, at the scale of the entire archive, not a
one-off product tweak.

None of that requires a full re-review — a short, specific confirmation (in
the same style as
`compliance/archive-search-fair-housing-attorney-question.md`, which
counsel already answered clearly and quickly) asking whether the proposed
replacement question reasonably implements the distinction he already
described in point 9, showing him the actual prompt text and the example
pairs, would close this cleanly and give a real paper trail for a
Critical-tier compliance-logic change. Oracle framed this as confirmation
of an already-invited direction, not a request for new guidance.

## Files referenced (all absolute paths)

- `/Users/petermckenzie/CODE/firststab/projects/hub/archive-search/lib/fair-housing-batch-self-report.js` (the file to be changed)
- `/Users/petermckenzie/CODE/firststab/projects/hub/maintenance-history/lib/tier-b-classifier.js` (precedent it's modeled on)
- `/Users/petermckenzie/CODE/firststab/projects/hub/complaint-tracking/lib/categorize-complaint.js` (source of the original broad question)
- `/Users/petermckenzie/CODE/firststab/projects/hub/maintenance-history/lib/content-check.js` and `/Users/petermckenzie/CODE/firststab/projects/hub/complaint-tracking/lib/process-pending-messages.js` (where the flag actually gets used downstream)
- `/Users/petermckenzie/CODE/firststab/compliance/archive-search-fair-housing-outside-counsel-opinion.md` (point 9 — counsel already inviting this change)
- `/Users/petermckenzie/CODE/firststab/compliance/archive-search-escalation-mechanism-review.md` (the existing human backstop, and the Round 3 precedent on not over-extending an old opinion to a new risk)
- `/Users/petermckenzie/CODE/firststab/compliance/archive-search-fair-housing-attorney-question.md` (template/tone for a fresh counsel question, if that route were taken)
- `/Users/petermckenzie/CODE/firststab/GOVERNANCE.md` (Rule 6, Fair Housing Standard)
