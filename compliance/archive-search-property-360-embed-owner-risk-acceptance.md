# Archive Search — Owner Risk Acceptance: Embedding Search on Property 360, Open to Everyone With Property 360 Access

**This is an owner risk-acceptance document, not a governance or legal
clearance.** Asimov and Mason have not reviewed this specific change.
Outside counsel has not reviewed this specific change. This document
records Peter, as owner of Rincon Management, choosing to proceed anyway.

## What is being changed

A new search box, placed on Property 360's main page directly under the
Maintenance Notes section, that searches Archive Search's underlying
Missive content (the same content made broadly searchable today per
`compliance/archive-search-flagged-release-owner-risk-acceptance.md` and
its gate-removal build) and lets the viewer open a full conversation.

**Who can use it, per Peter's explicit instruction:** anyone who has
access to Property 360. Per Property 360's own router
(`projects/hub/property-360/router.js`, its own "ACCESS CONTROL" header
comment): "anyone logged into the Hub at all can open /property-360" —
there is no gate on that page today, by design; it was built specifically
so that composing tools onto one page "must never become a fifth, broader
way in" than each tool's own existing access. This build is the first
exception made to that stated design principle.

## The real, current numbers — queried directly, not assumed

**Archive Search's actual authorized population today, per
`team_member_tool_roles` where `tool = 'archive_search'`:**

| Email | Role | Granted |
|---|---|---|
| peter@rinconmanagement.com | admin | 2026-09-13 |
| stephen@rinconmanagement.com | admin | 2026-09-13 |

**Two people, both admins, both granted the same day.** No `'searcher'`
role has ever been granted to anyone. Every document produced today —
the attorney question, the outside counsel opinion, both rounds of
Asimov's and Mason's confirmations, and the flagged-release owner-risk-
acceptance — repeats "~8 authorized users" as an established fact. That
figure does not match what is actually granted in production. It may
describe a planned population that was never fully provisioned; either
way, the real, current population this build is legally reasoned
against is 2 people, not 8.

**Property 360's population is, by its own design, everyone logged into
the Hub** — bounded today by the size of Rincon's team, but not a fixed,
named, vetted list the way Archive Search's `admin`/`searcher` roles are;
it grows automatically as staff are hired, with no step in that process
that touches Archive Search's own access table.

## What the outside counsel opinion actually says about this

Quoted directly from `compliance/archive-search-flagged-release-outside-counsel-opinion.md`,
not paraphrased:

> "Examples of genuinely material access changes include: opening Archive
> Search to a materially broader employee population... By contrast, I
> would not ordinarily characterize the following as a material access
> change requiring renewed legal review: allowing the same
> already-authorized Archive Search users to search additional records
> because Rincon changed, narrowed, removed, or overrode an internal
> automated screening rule."

And from the same opinion's "Standing Opinion for Future Issues" section:

> "Rincon management may modify, narrow, override, or remove internal
> screening restrictions and human-review gates without renewed legal
> approval when the same authorized personnel remain the users, the
> underlying business purpose remains the same, and Rincon's substantive
> Fair Housing and other legal obligations remain unchanged."

This build changes exactly the one variable that condition is written
around — who the users are — going from 2 named admins to everyone with
a Hub login. The opinion does not clear this; it names this specific kind
of change as the boundary of what it clears.

## Peter's basis for proceeding anyway, and his decision

Peter's position, stated directly in chat: **"i own the company and i
decide who will have access to this. build it and I will decide who can
access it."** His reasoning is that deciding who has access to his own
company's systems is his prerogative as owner, independent of whether
outside counsel or this project's own governance specialists have
evaluated this specific population change.

## The real, honest risk being accepted

Stated plainly, not minimized:

- The reasonable-residual-risk reasoning the outside counsel opinion
  relies on throughout — "Archive Search users are trained employees,"
  "employees have an escalation path," "Rincon therefore has multiple
  safeguards besides pre-search human review" — was written against a
  specific, small, presumably-vetted admin population. Nothing in this
  build extends, confirms, or re-establishes that reasoning for whoever
  else ends up with Property 360 access; it simply exposes the same
  content to them without it.
- Real content already found in this exact population today is now
  reachable by a materially larger group: a tenant's unresolved
  disability-accommodation request paired with unaddressed
  harassment reports next to an active eviction; a plausible
  source-of-income screening rejection; a stated blanket "we do not add
  foster children to a lease" policy; a denial letter naming a
  housing-voucher status as a reason for decline; and an internal email
  reacting negatively to a Section 8 application. All five were reviewed
  today at only-2-admins scale; none of that review considered a
  company-wide audience.
- Asimov and Mason have not confirmed this specific population change
  resolves cleanly, and were not asked to before this document was
  written — Peter has chosen to proceed on his own authority rather than
  wait for that review.
- Outside counsel's own opinion, read directly, names this specific kind
  of change as outside what it cleared — this is not a gap in what was
  asked, it is the one thing the opinion is explicit about not covering.

## Addendum — reaffirmed after Asimov's and Mason's actual review

After this document was first signed, it was sent to Asimov and Mason for
real review before anything was built (`compliance/archive-search-property-360-embed-asimov-review.md`,
`compliance/archive-search-property-360-embed-mason-review.md`). Both
independently returned **NOT CLEARED**, both recommended a fresh outside
counsel opinion before this ships, and both drew the same distinction:
this is not like the 2026-09-12 Layer 1 removal case, where owner
risk-acceptance alone was treated as sufficient (a classification-logic
change counsel had been silent on). This is a population/access-tier
change, and GOVERNANCE.md's Rule 6 requires owner approval **and**
attorney review for a Critical-tier change — "all three, not owner's
choice of which to skip," per this repo's own prior correction on that
exact point. A draft question for outside counsel exists
(`compliance/archive-search-property-360-access-expansion-attorney-question.md`)
and has not been sent.

Told this directly — that both of his own governance and legal
specialists reviewed this specific change and did not clear it, and that
neither the existing opinion nor any new one has been obtained — Peter's
response, verbatim: **"no. i accept the risk and will sign off on it."**
This is not a case where Asimov and Mason were skipped or not asked; they
were asked, they answered NOT CLEARED, and Peter is proceeding anyway,
with that answer in hand. This document's authorization to build is
reaffirmed on that basis.

## Second addendum — reconfirmed live, same day, after Tron's second decline

Tron declined a second build attempt (2026-09-24) on a narrower, specific
ground: the reaffirmation above happened the night before (2026-09-23),
and Tron judged that a Critical-tier override of two NOT CLEARED verdicts
should not be carried forward across a session pause as standing
consent — it should come from Peter live, in the current conversation,
before each build attempt. That request was relayed to Peter directly.

Peter's response, live in chat, 2026-09-24, verbatim: **"yes, i confirm,
build it now."** This is a fresh, same-day, explicit reconfirmation — not
an inference from the prior night's statement. The attorney question
(`compliance/archive-search-property-360-access-expansion-attorney-question.md`)
remains unsent; Peter was offered that path again first and chose to
proceed on his own authority instead.

## Third addendum — outside counsel opinion obtained, both specialists CLEARED WITH CONDITIONS, one condition declined

A fresh outside counsel opinion was obtained
(`compliance/archive-search-property-360-access-expansion-outside-counsel-opinion.md`,
2026-09-24), answering the exact question Asimov and Mason both said was
missing. Both then ran a confirmation pass against it
(`compliance/archive-search-property-360-embed-asimov-confirmation.md`,
`compliance/archive-search-property-360-embed-mason-confirmation.md`)
and both returned **CLEARED WITH CONDITIONS** — the population question
itself is resolved; neither specialist is still objecting to expanding
access from 2 admins to Property 360's Hub-wide population as a general
matter.

Mason's conditions included one specific, substantive item: suppress the
five conversations TARS's validation sample already found concerning —
in particular the disability-accommodation request sitting beside
unaddressed harassment reports and an active eviction — via the existing
`archive_search_escalations` mechanism, before the broader population
can reach them, because the new opinion was never shown that specific
content.

Told this directly, Peter's response, verbatim: **"no dont suppress."**
This is consistent with his earlier decision the same day not to
suppress the two already-released conversations found in the original
flagged-release validation sample. This document records that Mason's
suppression condition is being knowingly declined, not silently dropped —
the five conversations, including the accommodation/harassment thread,
will be reachable by the expanded population without being pulled first.
Asimov's conditions (a real `searcher`-role grant, a Rule 6 audit_log
entry, no new pre-search approval gate, keeping existing
search-vs-consequential-reliance guidance, confirming the ~9 accounts are
property-management roles) are not affected by this and remain the basis
for the build.

## What happens next

Once signed, this document authorizes Tron to build the search box on
Property 360's main page, under Maintenance Notes, wired to Archive
Search's existing `/api/archive-search/search` and
`/api/archive-search/message/:id` endpoints, visible and usable by anyone
who can open Property 360 — no new role or gate of its own, matching
Peter's explicit instruction. Asimov and Mason will still be told this
happened and shown this document — this is a transparent owner override,
not something hidden from them after the fact.

---

## Signature

**I have read this document, understand that this opens Archive Search's
Fair-Housing-screened content to everyone with Property 360 access — a
materially broader population than the 2 people currently authorized,
and a change outside counsel's own opinion does not cover — and accept
that risk as owner of Rincon Management.**

Signed: Peter McKenzie — confirmed in chat, verbatim: "i confirm, sign it"
Peter McKenzie, Owner, Rincon Management
Date: 2026-09-23
