# Mason — Confirmation Pass, Search Performance / `security_barrier` — Sync-Timing Condition

**Date:** 2026-09-24. Confirms whether
`compliance/archive-search-search-performance-security-barrier-outside-counsel-opinion.md`
(received 2026-09-24, responding to
`archive-search-search-performance-security-barrier-attorney-question.md`)
relaxes condition 1 of my earlier CLEARED WITH CONDITIONS verdict
(`archive-search-search-performance-security-barrier-mason-review.md`) on the
separate-eligible-content-corpus architecture: **sync must be synchronous,
not eventually-consistent.** Read alongside Asimov's own confirmation pass
(`archive-search-search-performance-security-barrier-asimov-confirmation.md`),
which reached the existence-detection question but explicitly left this
specific question — whether condition 1 stands as an internal bar independent
of what counsel legally requires — for me to answer, not itself.

---

## Verdict up front

**CLEARED WITH CONDITIONS — condition 1 is split by direction, not relaxed
uniformly.** The opinion is legally sound and directly on point, and I accept
its "reasonable, not instantaneous" standard as the legal floor. But I am
**not** loosening same-transaction removal for the direction that actually
matters to the risk this whole review exists to close. I concur with Asimov's
own Section 2 read and adopt it as my formal position rather than a
Mason-still-to-confirm placeholder.

## 1. The opinion answers the exact question I left open

Condition 4 of my original review asked Peter to make an explicit,
on-the-record call about looping in outside counsel because neither existing
opinion had been asked about the exclusion *mechanism* itself. That happened.
Section 4 of the new opinion addresses my synchronous-sync condition
head-on, not by analogy: *"I would not impose a requirement that the
searchable copy be 'perfectly synchronized' at every millisecond... The
better standard is: Rincon should use a reasonable mechanism designed to
cause exclusion decisions to propagate to the searchable dataset within a
reasonable period appropriate to the sensitivity and operational
circumstances."* That's a real holding on the real question. Gate closed on
whether this needed a fresh legal read at all — it did, and now it has one.

## 2. I accept "reasonable, not instantaneous" as the legal floor

The reasoning holds up: distinguishing the substantive control objective
(excluded content isn't disclosed through Archive Search) from one
particular implementation of it (`security_barrier`, or millisecond sync) is
legally coherent, and matches how "reasonable safeguards" standards work
elsewhere (this isn't a novel or convenient carve-out invented for this
question). I'm not re-litigating that holding.

## 3. But condition 1 doesn't relax for the direction the protection exists to guard — same-transaction removal stays, as Rincon's own internal bar

The opinion itself leaves room for this. Section 13's closing rule is
explicit: *"Counsel determines or advises on substantive legal boundaries.
Management determines acceptable business risk. Engineering determines how
to implement those boundaries."* A legal floor is not a ceiling Rincon is
required to build down to.

For **escalation opened/confirmed, suppression applied, override
revoked** — content leaving eligibility — I am holding my original
condition: same-transaction removal from the search corpus, full stop. Three
reasons, none of which the opinion actually contradicts:

- This is exactly the direction Section 5 flags as higher-stakes even within
  its own more permissive frame: *"if a Fair Housing escalation is opened and
  the record subsequently becomes excluded, I would expect the system to
  remove it reasonably promptly."* Same-transaction removal satisfies
  "reasonably promptly" with room to spare — it isn't in tension with the
  opinion, it's the tightest point on the range the opinion itself describes.
- The standard being loosened here isn't a blank slate — it's a standard
  Rincon already committed to and had cleared once, specifically:
  "Immediate structural exclusion on report (not a lighter 'flag but stay
  visible' default)" (`archive-search-escalation-mechanism-review.md`,
  Round 1). Quietly loosening an already-cleared protection under cover of a
  performance fix is closer to Section 15's own list of things that *do*
  need fresh review — *"eliminating an existing substantive protection
  without replacing it with a reasonably equivalent control"* — than to an
  ordinary implementation swap, even though the opinion would legally permit
  the looser version if Rincon chose it.
- This is the population-facing direction of the actual side-channel risk my
  original review identified: a lag here is a window where a term matching
  newly-excluded content still resolves against it. That's not a theoretical
  edge case on this system specifically — see Section 8 below.

For **screening clears / override granted** — content becoming newly
eligible — I accept the opinion's "reasonable period" standard on its own
terms; this is content becoming visible, not an existing protection being
relaxed, and the opinion's proportionality framing applies cleanly. I concur
with Asimov's recommended outer bound: event-driven propagation targeting
low-single-digit-to-low-double-digit seconds, with periodic reconciliation as
backstop (Section 9), not as the primary mechanism — a purely batch/periodic
design (e.g., nightly) would not meet "reasonable" for this system given
Rule 6 Critical tier requires an auditable, falsifiable number, not a
qualitative goal. Neo proposes the actual number; Asimov reviews it against
this standard; I don't need to re-review a specific figure once that
happens.

## 4. Condition 2 (subset-guarantee guardrail) is unaffected and stays required

The opinion frames reconciliation/verification as "good engineering practice"
rather than "a condition requiring counsel to approve" (Section 9). That's a
statement about what *legal review* gates, not about what *Rincon's own
governance* requires. The hard, continuously-checked guarantee that the
search corpus's row set is always a subset of what the live
`security_barrier`'d view would return — never a superset — stays a required
condition, as a Rule 6 Critical-tier correctness control, independent of
counsel's framing. Two independently maintained definitions of "excluded"
drifting apart is a worse, less visible bug class than today's timeout, and
nothing in the opinion argues otherwise — it just correctly declines to be
the vehicle that mandates it.

## 5. Condition 3 (Neo designs, Asimov Critical-tier reviews, before Q builds) stays — and needs one addition neither review has named yet

Untouched by this opinion; Section 11's standing-authority language is about
not needing *renewed legal sign-off* to swap the enforcement mechanism for
an already-approved substantive rule. It says nothing about Rincon's own
internal Rule 6 process, which is a separate, self-imposed requirement, not
a legal one counsel's opinion could waive even if it tried to. Adding one
item neither my prior review nor Asimov's confirmation named explicitly:
**GOVERNANCE.md Rule 6 Critical tier requires 7 days shadow mode**, in
addition to owner approval and attorney review, before a change like this
goes to full production. That should be in Neo's design and Asimov's
sign-off checklist, not assumed.

## 6. Scope limit on the "standing authority for future changes" language

Sections 11 and 14 give engineering latitude to change the *mechanism*
enforcing an already-approved rule without renewed *legal* review, for
future iterations too. I'm not contesting that as a legal matter. But this
should not be read — by Jarvis, by Q, by anyone building the next iteration
of this view — as license to also skip Asimov's Rule 6 Critical-tier review
on those future changes. Legal review and Rincon's own internal governance
review are two different gates; counsel closing one does not close the
other, and CLAUDE.md's own rule (never skip Asimov or Mason on a compliance
build, even on "just ship it") controls that second gate regardless of what
any opinion says about the first. Stating this explicitly so it isn't
inferred more broadly later.

## 7. Correcting a premise, not reopening a decision: the accommodation/harassment thread

I was asked to weigh the sync-timing standard against "the real content
already found in this system (the accommodation/harassment thread)" as
evidence of how time-sensitive Fair-Housing-escalation content is. That
thread is real — TARS's validation sample found an unresolved disability
accommodation request sitting beside unaddressed sexual- and
neighbor-harassment reports, next to an active eviction. But it is not
currently protected by any of this system's exclusion categories, and
tightening sync timing on this build does not change that. Per
`archive-search-property-360-embed-owner-risk-acceptance.md` (Third
addendum, 2026-09-24): I recommended suppressing that thread through the
`archive_search_escalations` mechanism before the broader Property 360
population could reach it; Peter declined, verbatim, in chat: **"no dont
suppress."** That decision is recorded and signed, and I'm not reopening it
here. But it means that specific thread is not "escalated" or "suppressed"
content today — it's ordinary, searchable content, already reachable by the
full Property 360 population, independent of `security_barrier`,
independent of this corpus redesign, and independent of whatever sync
number Neo picks. Using it as the illustration for "how fast must
excluded content propagate" risks implying it's currently protected content
whose protection speed is the open question. It isn't protected content at
all right now. The actual open item on that thread is still what my prior
confirmation named: get it run through the escalation mechanism (or sent to
counsel as a targeted follow-up), independent of this build — this review
doesn't touch it and shouldn't be read as having addressed it.

## Verdict

**CLEARED WITH CONDITIONS**, restated:

1. **Escalation-confirmed / suppression-applied / override-revoked →
   same-transaction removal from the search corpus.** Not relaxed. This is
   Rincon's own internal bar, permitted (not required) to be stricter than
   the legal floor per the opinion's own Section 13, and it's the one
   direction where a lag reopens the exact side-channel risk this review
   exists to close.
2. **Screening-clears / override-granted → reasonable-period propagation**,
   concrete number proposed by Neo, reviewed by Asimov against the
   opinion's proportionality standard, event-driven with reconciliation as
   backstop rather than periodic-only.
3. **Hard subset-guarantee guardrail** (search corpus always ⊆ live
   `security_barrier`'d view, never a superset), continuously or
   periodically checked and logged — unaffected by the opinion's "not a
   legal gate" framing; this is a Rincon governance control, not a legal
   one.
4. **Neo designs the concrete two-track mechanism; Asimov's Critical-tier
   review happens before Q builds anything**, including the 7-day shadow
   mode GOVERNANCE.md Rule 6 requires for Critical changes, not previously
   named in either review.
5. **The two direct fixes (drop `security_barrier`; mark `@@` leakproof)
   remain NOT CLEARED.** Nothing in the new opinion changes that, and
   nothing in this confirmation reopens it.
6. **The accommodation/harassment thread's actual exposure is a separate,
   already-decided, owner-accepted risk** (Peter's "no dont suppress")
   independent of this build. This confirmation does not resolve it and
   should not be cited as having done so.

Outside-counsel condition (my original condition 4) is satisfied — Peter
made the explicit call, counsel weighed in directly and specifically. Two
of four original conditions (2 and 3) stand unchanged; condition 1 is
resolved by direction rather than uniformly relaxed; a new item (shadow
mode) is added under condition 3's umbrella.
