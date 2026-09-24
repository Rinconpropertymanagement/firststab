# Mason — Fair Housing Legal Review, Property 360 Embed (Archive Search Access Expansion)

**Date:** 2026-09-23. Reviewed:
`compliance/archive-search-property-360-embed-owner-risk-acceptance.md`,
the outside counsel opinion it quotes
(`compliance/archive-search-flagged-release-outside-counsel-opinion.md`),
`projects/hub/property-360/router.js`'s own "ACCESS CONTROL" header,
`team_member_tool_roles` for `tool = 'archive_search'`, and the real TARS
validation-sample findings recorded in
`compliance/archive-search-flagged-release-owner-risk-acceptance.md`.

**Status of this pass.** First-time legal read on this specific proposal.
Peter has already signed the owner-risk-acceptance document, on his own
authority, stating plainly that neither Asimov, Mason, nor outside counsel
has reviewed this specific change — this document is that review, written
honestly regardless of the signature already on file. Nothing here
authorizes Tron to build anything; per CLAUDE.md's own governance rules,
this compliance build cannot ship without Asimov as well.

---

**1. The population figure everyone has been reasoning against is wrong,
and the real number matters.** `team_member_tool_roles` where
`tool = 'archive_search'` shows exactly two rows, both `role = 'admin'`,
both granted 2026-09-13, to `peter@rinconmanagement.com` and
`stephen@rinconmanagement.com`. No `searcher` role has ever been granted.
Every prior document in this chain — the attorney question, the outside
counsel opinion, both rounds of Asimov's and Mason's confirmations, and
the flagged-release owner-risk-acceptance — reasons against "~8 trained
employees." The real, current, legally operative population is **2
people**, not 8. This proposal is not "adding a few more of the ~8" — it
is expanding a 2-person admin population to everyone who can log into the
Hub, a figure that today is Rincon's whole staff (6–15 people per
CLAUDE.md) and grows automatically with every future hire, with no step
in that hiring process that ever touches Archive Search's own access
table.

**2. This is not a gray-area reading of the standing opinion — it is the
one bright line the opinion itself drew.** Counsel's Section 7 lists, as
its lead example of a "genuinely material access change" requiring
renewed review: *"opening Archive Search to a materially broader employee
population."* The Standing Opinion conditions all future self-service
changes on one test: *"Rincon management may modify, narrow, override, or
remove internal screening restrictions and human-review gates without
renewed legal approval when **the same authorized personnel remain the
users**, the underlying business purpose remains the same, and Rincon's
substantive Fair Housing and other legal obligations remain unchanged."*
Every other change this opinion has cleared — releasing the 267 flagged
emails, retiring the per-item override gate, narrowing the self-report
question — held that variable constant: same 2 (or ~8-assumed) admins,
different rules about what they can search. This proposal is the first
one that changes *who the users are*. It does not fall on the permissive
side of a fuzzy line; it is the example the opinion used to draw the line.

**3. The safeguards the opinion's risk tolerance is built on were reasoned
against a small, named, presumably-vetted group — nothing here
establishes they exist for the group being added.** Section 5's
reasonable-residual-risk holding rests on four stated facts about the
population: *"Archive Search users are trained employees... Employees
have an escalation path... Rincon therefore has multiple safeguards
besides pre-search human review."* Those are factual predicates, not
policy preferences — counsel is relying on Rincon's representation that
the people searching this content are trained and have somewhere to take
a concern. Nothing in this proposal, the router, or the access table
establishes Fair Housing training, an onboarding step, or an escalation
path for "anyone with a Hub login" as a class. Property 360's own router
says as much about itself: it was deliberately built so that composing
tools onto that page "must never become a fifth, broader way in" than
each tool's own access — and the owner-risk-acceptance document says
plainly this build is "the first exception made to that stated design
principle." The safeguard reasoning doesn't transfer by default to a
population defined only by "logged into the Hub" — it has to be
established for that population, and it hasn't been.

**4. This isn't hypothetical exposure — TARS's own real sample already
found live, unresolved Fair Housing-relevant content sitting in exactly
this content, at the *current*, smaller, supposedly-safer scale.** The
24-conversation random sample pulled directly from Supabase (12
pending, 12 already-released) came back 5 of 24 (~21%) not cleared
against the opinion's own conduct-based standard — a rate the
zero-confirmed-miss bar Mason and Asimov themselves set was written to
catch, and didn't. Specifically, and all now live in ordinary search for
the 2 admins: a tenant's written disability-accommodation request met
with no grant, denial, or decision while her unit's vacate proceeded
regardless, in the same thread as her account of unaddressed
sexual-harassment and neighbor-harassment reports; a ShowMojo auto-reject
where the income field read "Applicable housing voucher" with no other
disqualifier; a stated blanket "We do not add foster children to a
lease" policy; a denial letter naming "Section 8 Voucher for the city of
Oxnard" as a reason for decline; and an internal staff email reading
"however it is section 8 :/" reacting to an applicant's voucher status.
Peter's basis for proceeding past that result was that this system's
audience is "the same people who are resolving the issues outside of
email" — an operational-context argument that is specific to the 2
admins and does not describe, and was never asked to describe, a
Hub-wide population with no operational relationship to any of these
tenants, applicants, or files. Whatever residual comfort that argument
provides at 2 people evaporates at Hub scale — the content that already
failed a human-conduct review at the smaller population doesn't get
safer by being shown to more people who weren't part of resolving it.

**5. Peter's ownership authority and whether this specific change needs
its own legal read are two different questions, and the first does not
answer the second.** Peter's stated position — *"i own the company and i
decide who will have access to this. build it and I will decide who can
access it"* — is a true and undisputed statement about who gets to make
this call for Rincon. It is not a statement about, and doesn't change,
what that call costs in legal exposure or whether outside counsel's own
opinion already covers it. GOVERNANCE.md's Rule 6 treats these as
separate inputs on purpose: a Critical change requires *owner approval
and* attorney review — one is not a substitute for the other, and the
rule wouldn't need both if owner authorization alone resolved the legal
question. Practically: Peter's authority tells you *who may decide* to
open this population; it says nothing about *what a court, HUD, or DFEH
investigator would make of it* if the accommodation/harassment thread,
the ShowMojo rejection, or either Section 8 item surfaces in a dispute
after being made searchable to an untrained, unvetted, ever-growing
population with no escalation path established for it. Peter can
absolutely choose to accept that exposure himself, as owner — he already
has, on the record, in the risk-acceptance document — but that choice is
the thing being reviewed, not something that makes the review
unnecessary. These are not competing claims to the same authority; one is
a business-governance question Peter already owns outright, the other is
a legal-risk question that hasn't been asked of the person positioned to
answer it.

---

## General Fair Housing Standard Check

This proposal does not itself generate tenant/applicant-facing content or
make a housing decision (Rules 7/8 don't attach to it directly), but it
is an access-control change that determines who can encounter raw
protected-class-adjacent material — the accommodation/harassment thread,
the voucher-status denial letter, the foster-children policy statement —
without any of Rule 9's protections against that material entering a
staff member's decision-making, because the staff members receiving
access under this proposal are, by construction, unvetted for that
purpose. Asimov classified the *prior*, smaller expansion (retiring the
per-item override gate for the same 2 admins) as a Rule 8
permission-tier downgrade requiring Critical-tier review. This proposal
is a materially larger downgrade on the same axis — from 2 named,
role-gated people to an unbounded, ungated population — and should be
classified at least as strictly.

## Attorney Referral

**Yes.** This is squarely the fact pattern the standing opinion names as
outside its own authority: a materially broader employee population,
where the opinion's safety margin (trained employees, an escalation
path, safeguards beyond pre-search review) has not been shown to exist
for the population being added, over content a real validation sample
already found containing live, unresolved Fair Housing-relevant material.
Outside counsel should be asked this specific question — expanding
Archive Search's authorized population from 2 named admins to anyone
with a Hub login — before this ships, not folded into the standing
authority the existing opinion grants for a different kind of change.

## Verdict

**NOT CLEARED** on the Fair Housing/legal question, independent of
Peter's authority to proceed anyway. The existing outside counsel opinion
does not cover this change — it explicitly names it as the boundary of
what it covers — and the real-world validation sample this exact content
already failed at 2-person scale is a reason for more caution at Hub
scale, not less. Recommend: a fresh, narrow outside counsel opinion
specifically on (1) whether/how the "trained employees, escalation path,
multiple safeguards" reasoning can be extended to a Hub-wide population,
and (2) whether any mitigation (a real `searcher`-style gate, mandatory
Fair Housing training tied to that gate, an actual escalation mechanism)
would need to exist before such an extension could be reasoned about at
all — before this goes to Asimov for the governance side and before Tron
builds anything.
