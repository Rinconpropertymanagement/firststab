# Mason — Confirmation Pass, Property 360 Embed (Access Expansion)

**Date:** 2026-09-24. Confirms whether
`compliance/archive-search-property-360-access-expansion-outside-counsel-opinion.md`
closes Mason's earlier **NOT CLEARED** verdict
(`compliance/archive-search-property-360-embed-mason-review.md`, 2026-09-23)
on expanding Archive Search's authorized population from 2 named admins
to anyone with a Hub login via a Property 360 search box. Also read
`compliance/archive-search-property-360-embed-asimov-review.md` (Asimov's
parallel NOT CLEARED) and
`compliance/archive-search-property-360-embed-owner-risk-acceptance.md`
(both addenda) for the full chain.

---

**1. My prior verdict rested on three separable legs, not one — that
matters for what "closing" it actually requires.** Re-reading my own
2026-09-23 review: (a) the population-ceiling argument — that "materially
broader employee population" is the one bright line the standing opinion
drew; (b) the safeguard-transfer argument — that "trained employees,"
"an escalation path" were factual predicates reasoned against a small,
presumably-vetted group and not shown to exist for the group being added;
and (c) the specific-content argument — that TARS's real validation
sample already found live, unresolved Fair Housing-relevant material (the
accommodation/harassment thread chief among it) reachable at the
*current*, smaller, supposedly-safer scale, which is a reason for more
caution at Hub scale, not less. A new opinion has to close all three to
fully clear this, not just the first.

**2. Leg (a) — the population ceiling — is closed, directly and by name.**
The new opinion doesn't dodge the exact language my review anchored on;
it takes it head-on: *"The prior reference to a 'materially broader
employee population' should not be interpreted to mean that every
addition of employees or every expansion of internal access requires new
legal review... Those numbers described the system as it existed or was
anticipated at the time. They were not intended to establish a legal
ceiling."* That is counsel narrowing counsel's own prior language on
direct question — a normal, legitimate thing for an opinion to do, not an
evasion. Section 1's reframing (the controlling question is "who are the
users, why are they accessing it, is it reasonably related to Rincon's
business" rather than a headcount) is coherent, ordinary employment/privacy
reasoning, not result-oriented hand-waving. I treat leg (a) as closed.

**3. Leg (b) — safeguard transfer — is closed as a matter of legal
framework, conditioned on two facts I cannot verify from this chair.**
Sections 5–8 answer this directly: no individual vetting required, no
mandatory intermediate tier, ordinary Hub provisioning is an acceptable
admission mechanism, and baseline Fair Housing training — not a special
Archive Search course — is sufficient, provided it is "incorporated into
Rincon's ordinary Fair Housing and system-use training." That is a
defensible legal position. But it is built on two representations the
opinion assumes rather than establishes: that Rincon's ~9 current (and
growing) Hub-login holders actually receive Fair Housing training today,
and that an actual, known escalation path exists for that broader group —
not just the 2 admins the original safeguard language was written around.
Nothing in this chain confirms either fact against Rincon's real practice.
This is not a Fair Housing *law* gap — the legal test the opinion
articulates is sound — it is a factual-predicate gap, and it is Asimov's
kind of verification (the same "queried live, not taken on faith"
standard Asimov's prior review applied to `team_member_tool_roles`), not
mine to close by reading a document. I'm flagging it as a condition, not
reopening the legal question.

**4. Leg (c) — the specific real content — is not addressed, because the
opinion was never shown it.** This is the leg that does not close. The
attorney-question document that produced this opinion asks only about
population size, vetting, and training in the abstract; it never mentions
that a live validation sample already found, at 2-admin scale: a tenant's
disability-accommodation request met with no grant, denial, or decision
while her unit's vacate proceeded regardless, in the same thread as
unaddressed sexual-harassment and neighbor-harassment reports; a ShowMojo
auto-reject citing an applicant's housing voucher; a stated blanket
no-foster-children policy; a Section-8-cited denial letter; and a staff
email reacting negatively to an applicant's voucher status. Section 4's
discussion of accommodation records — *"Resident has an approved
accommodation requiring 48-hour notice before non-emergency maintenance
entry"* — is a different, easier fact pattern: a clean, resolved,
*approved* accommodation used constructively by maintenance staff. That is
not the real thread on file, which is an unresolved request sitting next
to unaddressed harassment allegations and an active eviction — closer to
the fact pattern a Fair Housing or retaliation claim gets built around
than to the fact pattern the opinion uses to argue access is operationally
useful. A general framework opinion answering a genericized question does
not, on its own terms, resolve whether *that specific thread* should be
made visible to an untrained-by-confirmation, ever-growing population
before anyone has evaluated it individually.

**5. This is exactly the "something more" the task in front of me asks
about, and the answer is yes.** Rincon already has a live mechanism for
this — `archive_search_escalations` in
`projects/hub/archive-search/router.js`: a conversation reported and
confirmed as a real concern is marked `status = 'confirmed'` and "remains
excluded from search" going forward, independent of who has access. I
found no record anywhere in `compliance/` that the accommodation/
harassment thread (or the other four findings) has been run through that
mechanism. Independent of the population question — which the new opinion
does close — that specific thread should be reported and confirmed
through the existing escalation path, or the five findings should go back
to counsel as a targeted follow-up so the opinion's general framework gets
tested against the actual worst content in the corpus, before this ships
to a company-wide audience. Either path is available now; neither has been
taken yet.

**6. Provenance note, for consistency's sake, not as a basis for the
verdict.** This opinion, like the 2026-09-23 flagged-release opinion and
the 2026-09-12 Layer 1 opinion before it, arrives as text pasted into chat
by Peter, with no attorney name, firm, or signature attached — the same
format this project has treated as a legitimate record of counsel's advice
throughout this entire chain, including the two opinions my own prior
reviews and Asimov's relied on and quoted as authoritative. I'm not
applying a different bar to this one now that it happens to answer
favorably — that would be inconsistent, not more rigorous. Worth naming
plainly for the record regardless: nothing in this chain independently
verifies who wrote any of these opinions. That has been true since
2026-09-12 and isn't new to this document.

---

## General Fair Housing Standard Check

The population-expansion mechanism itself — role-based access through
ordinary Hub provisioning, baseline training folded into existing Fair
Housing training, logging plus the search/consequential-reliance
distinction — is now supported by a specific, on-point legal opinion and
does not by itself violate the Fair Housing Standard. The open item is
narrower than the mechanism: specific already-identified content (the
accommodation/harassment thread in particular) has not been evaluated
against Rule 9's protections before being handed to a materially larger,
less-accountable audience. That is a closeable gap, not a structural one.

## Verdict

**CLEARED WITH CONDITIONS.** The new opinion closes my 2026-09-23 NOT
CLEARED verdict on the population-ceiling question — the specific,
named boundary ("materially broader employee population") my review and
Asimov's both anchored on — with direct, on-point, legitimate legal
reasoning, not evasion. It does not need to be re-litigated. Two
conditions remain before this should ship to the broader population:

1. Report and confirm the accommodation/harassment/eviction thread (and
   ideally the other four validation-sample findings) through the
   existing `archive_search_escalations` mechanism so it is excluded from
   search — or send that specific content to counsel as a targeted
   follow-up — before the broader, untrained-by-confirmation population
   can reach it. This is independent of the population question and the
   new opinion does not address it.
2. Asimov should independently verify, the same way `team_member_tool_roles`
   was verified last round, that Fair Housing/system-use training and a
   real escalation path actually exist today for the ~9 current (and
   future) Hub-login holders — the factual predicates Section 7's
   safeguard reasoning assumes rather than establishes.

Neither condition blocks Tron from building the search box itself; both
should be satisfied before Peter's authorization is treated as covering a
company-wide, live population. This confirmation closes Mason's Fair
Housing/legal-substance review; it is not a substitute for Asimov's own
governance sign-off on Rule 6's remaining prongs.
