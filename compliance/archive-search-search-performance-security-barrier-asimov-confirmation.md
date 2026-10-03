# Asimov — Confirmation Pass, Search Performance / `security_barrier` Architecture Change

**Date:** 2026-09-24. Confirms whether
`compliance/archive-search-search-performance-security-barrier-outside-counsel-opinion.md`
closes Asimov's earlier NOT CLEARED / ATTORNEY REQUIRED verdict
(`archive-search-search-performance-security-barrier-asimov-review.md`) on
replacing `security_barrier`-based enforcement of Archive Search's
content-exclusion rules with a separate eligible-content search corpus. Read
alongside Mason's parallel review
(`archive-search-search-performance-security-barrier-mason-review.md`, NOT
CLEARED on the two direct fixes, CLEARED WITH CONDITIONS on the
separate-corpus alternative) and the attorney question that produced the new
opinion (`archive-search-search-performance-security-barrier-attorney-
question.md`).

---

**Does the new opinion close the attorney-review prong? Yes — for the
separate-corpus architecture specifically. Not for the two direct fixes,
which the opinion never blesses and which stay foreclosed on Mason's and my
own engineering-security grounds regardless.**

## 1. The specific gap I flagged is the specific thing this opinion answers

My prior verdict didn't say "get any opinion" — it said no *existing* opinion
addressed whether the search infrastructure itself could leak the
*existence* of excluded content through timing or behavior, as distinct from
the content-policy question (who sees what, under what process) the Fair
Housing and privilege opinions actually answer. This opinion is a fresh,
narrow read asked exactly that question, and Section 8 ("Existence Detection
Should Be Treated Proportionately") answers it directly rather than by
analogy: counsel treats existence-detection as "a legitimate security
consideration," declines to make "absolute prevention of every conceivable
inference channel... an independent legal requirement," and gives a
proportionality test instead — can the employee see the content, is there a
"realistic rather than merely theoretical disclosure mechanism," are
safeguards "reasonable in relation to the actual risk." That's a real
holding on the real question, not a documented-provenance substitute.
**Gate 1 satisfied.**

Section 11's clarification of standing authority is also useful and correctly
scoped: it says engineering doesn't need renewed legal sign-off to swap
*which* mechanism enforces an already-approved substantive rule. It does not
say a mechanism can be removed without being replaced — Section 12 is
explicit that removing a control is only a non-reduction "if engineering
... simultaneously replaces it with another mechanism that reasonably
achieves the same objective," and Section 15 keeps "eliminating an existing
substantive protection without replacing it with a reasonably equivalent
control" on the list of things that need fresh review. Read together: this
opinion clears *build the separate corpus and retire `security_barrier` once
it's actually doing the job*. It does not clear dropping `security_barrier`
first, or on its own. Restating this because Section 11's language, read in
isolation, could be mistaken for broader cover than it actually gives.

## 2. A real tension with Mason's own condition — needs Mason's confirmation, not mine, to resolve

Mason's CLEARED WITH CONDITIONS set four conditions on the separate-corpus
approach. Condition 1 was: **sync must be synchronous, not
eventually-consistent**, specifically because the escalation mechanism was
already built and cleared as "immediate structural exclusion on report"
(`archive-search-escalation-mechanism-review.md`, Round 1 — "Immediate
structural exclusion on report (not a lighter 'flag but stay visible'
default): concurred"), and Mason didn't want a batch/async refresh to quietly
reopen a window that decision had already closed.

The new opinion is more permissive than that on its face. Section 4 rejects
"perfectly synchronized... at every millisecond" as a legal requirement, and
the Specific Opinion section lists "synchronization interval" among things
counsel "would not require... to approve." Read narrowly, that's about legal
approval, not about Rincon's own internal bar — the opinion is explicit
elsewhere (Section 13, the closing "standing rule") that management sets
acceptable business risk and engineering implements it, which leaves room for
Rincon to hold itself to a stricter internal standard than the legal floor.
But it does mean Mason's condition, as literally written, is now stricter
than what counsel requires, and that gap needs Mason to say explicitly
whether condition 1 still stands as an internal risk-management choice
(distinct from a legal requirement) or is relaxed in light of this opinion —
not something I should resolve unilaterally on Mason's behalf. Flagging this
for Mason's confirmation pass, same two-signature pattern used throughout
this build.

My own read, for whatever weight it carries going into that: don't relax it
for the escalation/suppression/override-revocation triggers specifically.
That standard was already committed to and cleared once; loosening it now,
under cover of a performance fix, is closer to Section 15's "eliminating an
existing substantive protection" than to an ordinary implementation swap —
even though the opinion would legally permit the looser version. See the
concrete recommendation in Section 4 below.

## 3. Does "reasonable synchronization" / "proportionate fail-safe" give Neo enough to design against — or does the spec still need Asimov to pin numbers?

**The build spec still needs concrete numbers, and the opinion says so
itself — it just correctly declines to be the thing that sets them.**
Section 4 explicitly declines to "convert a specific number of seconds or
minutes into a legal requirement," and the Specific Opinion section lists
synchronization interval, reconciliation schedule, and retry policy as
"ordinary engineering details" counsel won't gate on. That's the right legal
answer. It is not, by itself, something Neo can build against or TARS can
test against — "reasonable" and "proportionate" aren't falsifiable until
someone attaches a number and a category to them, and GOVERNANCE.md Rule 6
Critical tier requires exactly that: an auditable standard with previous and
new values logged, not a qualitative goal. That pinning-down is Asimov's job
under Rule 6, independent of what counsel does or doesn't require — the
opinion's silence on numbers is a delegation to Rincon's internal governance,
not an absence of any requirement.

## 4. Recommendation for the build spec (Neo designs the actual mechanism against this; this does not replace Mason's condition 3)

Split the sync requirement by category instead of one blanket standard:

- **Escalation opened/confirmed, suppression applied, override revoked →
  same-transaction removal from the search corpus.** This preserves the
  already-cleared "immediate structural exclusion" standard rather than
  quietly loosening it, and it's the highest-sensitivity direction (content
  going *out* of eligibility) — Section 5 of the new opinion specifically
  says it would "expect the system to remove it reasonably promptly" for
  this direction, which same-transaction removal satisfies with room to
  spare.
- **Screening clears / override granted → newly eligible for search.** This
  is content becoming eligible, not an existing protection being relaxed, so
  the opinion's "reasonable period appropriate to the sensitivity and
  operational circumstances" standard applies on its own terms. Neo should
  propose a concrete outer bound (opinion's own examples: immediately via
  event, within seconds, short queue, periodic reconciliation) with
  reconciliation as the backstop per Section 9 — Asimov reviews the actual
  number against the standard once Neo has a design, per Mason's condition 3.

This confirmation does not itself clear a specific number — that comes when
Neo's concrete design comes back, consistent with Mason's condition 3
("Neo designs the actual mechanism and Asimov reviews it before Q builds
anything"), which the new opinion doesn't override. The opinion clears the
*legal* question; Rule 6 Critical tier still gates the *build*.

## 5. Rule 6 audit mechanics this build needs

1. **Spec states the two-track sync model explicitly** (Section 4 above),
   naming which triggers are same-transaction and which are
   reasonable-period-async — not left implicit or uniform.
2. **A defined, falsifiable sync-target number** for the async track,
   proposed by Neo, reviewed by Asimov against the opinion's proportionality
   standard, and recorded — this is the actual Rule 6 "previous and new
   values" log entry, since there's no prior value to diff against
   (`security_barrier` was binary; a sync window is a number).
3. **Continuous or periodic subset-guarantee check** (Mason's condition 2:
   search-corpus row set is always a subset of what the live
   `security_barrier`'d view would return, never a superset) — implemented
   as the reconciliation job the opinion's Section 9 calls "good engineering
   practice." Its pass/fail and any discrepancy count logged to `audit_log`,
   not just alerted — a silent drift here is undetectable by reading either
   definition in isolation, which is exactly the failure mode Mason flagged
   as worse than today's timeout.
4. **Fail-safe behavior spec'd explicitly**, not left to Section 10's list of
   options implicitly — the spec should say which of retry / temporary
   exclusion / scope restriction / full disable applies to which failure
   mode, so it's reviewable and testable rather than decided ad hoc at 2am.
5. **`audit_log` entry** (e.g. `archive_search.rule6_security_barrier_
   replaced`) citing this confirmation, the new outside counsel opinion,
   Mason's confirmation once filed, owner approval, and the chosen sync-target
   numbers.
6. **Tier 1 (Auto) classification for the mechanism itself** — same
   reasoning as the layer1-removal confirmation: no tenant/owner messaging,
   no housing decision, changes only which archived internal communications
   a trained employee can retrieve via search. It's Rule 6 Critical *because*
   it's a guardrail/compliance-logic mechanism (GOVERNANCE.md Rule 6's own
   language), not because it triggers Tier 2/3 housing-decision review.
7. **Scope stated explicitly:** this covers the `missive_message_intake_
   search_safe` → Archive Search full-text path only. The two direct fixes
   (dropping `security_barrier`; marking `@@` leakproof) remain NOT CLEARED
   and out of scope for this build regardless of the standing-authority
   language in Section 11 — see Section 1 above.

Unaffected by any of this: the already-shipped, date-bounded stopgap. It
doesn't touch `security_barrier` and needs no sign-off from this document or
Mason's.

---

**VERDICT: CLEARED WITH CONDITIONS.**

1. The existence-detection gap that produced my prior NOT CLEARED /
   ATTORNEY REQUIRED verdict is closed by this opinion — no further
   attorney read needed on the separate-corpus architecture itself.
2. Mason confirms separately (expected, given Mason's own path B was this
   architecture) — and specifically addresses whether condition 1
   (synchronous sync) stands as an internal bar independent of what the
   opinion legally requires, per Section 2 above.
3. Neo designs the concrete mechanism — two-track sync model, actual
   numbers, reconciliation job, fail-safe behavior — before Q builds
   anything, per Mason's condition 3, which this opinion does not waive.
4. Asimov reviews Neo's concrete design against the six Rule 6 items in
   Section 5 before this ships.
5. The two direct fixes (drop `security_barrier`; mark `@@` leakproof) stay
   NOT CLEARED. Nothing in the new opinion changes that.
