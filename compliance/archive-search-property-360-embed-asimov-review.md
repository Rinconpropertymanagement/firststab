# Asimov — Governance Review, Property 360 Embed (Population Expansion)

**Date:** 2026-09-23. Reviews
`compliance/archive-search-property-360-embed-owner-risk-acceptance.md`
against GOVERNANCE.md Rule 6, independently verified against the real
code and the real database, not taken on faith.

---

**VERDICT: NOT CLEARED.** This is a Critical-tier Rule 6 change, and the
missing prong is attorney review, not owner approval — owner approval is
already given and is real, but it is one of three required prongs, not a
substitute for the other two. This is not the same situation as the
2026-09-12 Layer 1 removal, where an owner-risk-acceptance was the right
call. Tron should not build the search box until a fresh outside counsel
opinion addresses this specific population change.

## What I verified directly

- **`team_member_tool_roles` where `tool = 'archive_search'`** (queried
  live): exactly 2 rows, both `role = 'admin'`, both granted 2026-09-13,
  to `peter@rinconmanagement.com` and `stephen@rinconmanagement.com`. The
  `'searcher'` role exists in `projects/hub/archive-search/router.js`
  (`ARCHIVE_SEARCH_SEARCH_ROLES = ['searcher', 'admin']`) but has zero
  grants. The document's "2 people, not 8" correction is right — every
  other Archive Search document on file that says "~8 authorized users"
  is describing a population that was never actually provisioned.
- **`team_members`** (queried live): 9 active people currently have Hub
  logins. That is the immediate size of the expansion — 2 admins to 9
  people today — and it is not a fixed number: it grows every time
  someone is hired, with no step in that hiring process that touches
  Archive Search's own role table. There is no ceiling on this
  population the way there is on `admin`/`searcher` grants.
- **`projects/hub/property-360/router.js`, "ACCESS CONTROL" header**
  (read directly): confirmed verbatim — "anyone logged into the Hub at
  all can open /property-360," and composing tools onto the page "must
  never become a fifth, broader way in" than each tool's own existing
  access. This build is the first proposed exception to that stated
  design principle, exactly as the owner-risk-acceptance document says.
- **The outside counsel language quoted in the document**: real,
  verified verbatim against the actual opinion text — "opening Archive
  Search to a materially broader employee population" as a named example
  of a material access change, and the standing authority's own
  condition, "the same authorized personnel remain the users." Not
  paraphrased, not fabricated. One provenance note for the record: that
  opinion file lives in commit `b5fe4ae` on branch
  `feature/archive-search-flagged-release-gate-removal`, which is not
  merged into `main` or into this branch — so the "made broadly
  searchable today" framing describes a build that exists, verified, but
  has not shipped yet. That doesn't change the legal analysis below, but
  the document should not describe it as already live in production.
- **The five real findings** (disability-accommodation request next to
  unaddressed harassment reports and an active eviction; the ShowMojo
  voucher auto-rejection; the "no foster children" policy statement; the
  Section-8-cited denial letter; the frown-emoji staff email): confirmed
  verbatim against TARS's actual validation-sample output in that same
  commit. All real, all still true, all reachable today by the 2 admins
  and — if this build ships as proposed — by everyone with a Hub login.

## Why this is not the Layer 1 precedent

The document is right to compare this to 2026-09-12, and right that the
comparison is where its case gets weaker, not stronger.

On Layer 1, counsel was never asked about the keyword mechanism at all —
Peter's owner-risk-acceptance extended an existing, on-point body of
counsel's *general* reasoning (mention-of-a-characteristic is not itself
a Fair Housing concern) to a mechanism counsel's opinions didn't
specifically discuss, and Rule 6's shadow-mode prong was replaced with a
concrete substitute (the validation-sample gate) that Asimov itself
confirmed closed the gap. That is a real, defensible use of owner
prerogative to fill counsel's silence with counsel's own stated
principles, and Asimov cleared it on that basis.

This is different in kind, not just degree. Counsel was not silent on
population size — counsel was asked, directly, and drew a line: the
standing authority to make future changes without new legal review holds
only "when the same authorized personnel remain the users." A population
change is not an unaddressed edge case the opinion's spirit plausibly
covers; it is the one variable the opinion's own text carves out as
requiring its own review. Signing an owner-risk-acceptance here does not
extend counsel's reasoning by analogy — it overrides the one boundary
counsel was explicit about. Rule 6's text is "owner approval + attorney
review for compliance changes + 7 days shadow mode" for Critical changes,
and this project's own precedent (the corrected paragraph in
`compliance/archive-search-layer1-removal-owner-risk-acceptance.md`,
which Asimov and Q both treated as binding on 2026-09-12) is explicit that
this is "all three, not owner's choice of which to skip." An owner can
accept legal risk that is genuinely his to accept; he cannot accept it on
counsel's behalf when counsel already spoke to the exact question and
said "not covered."

There is also a scale difference worth naming plainly: Layer 1 and the
held-release change both left the *population* fixed (2 admins, then
still 2 admins) and changed what content or logic applied to them. This
change leaves the content and logic fixed and removes the population
boundary entirely — the one dimension every prior opinion's reasoning
("trained employees," "an escalation path," "authorized Archive Search
users") was written to describe a small, vetted group, not "everyone
Rincon ever hires."

## Tier classification

**Critical**, under Rule 6's own listed examples — this is squarely a
"permission tiers" change, not a borderline case. Real content already
found to include an active accommodation/harassment/eviction thread and
multiple source-of-income adverse-action items would move from a
2-person admin population to a company-wide one with zero admission gate
of its own.

**Rule 6 prongs:**
- Owner approval — given, explicit, on the record ("i own the company
  and i decide who will have access to this").
- Attorney review — **missing**, and the current opinion on file
  affirmatively does not cover this change; it names this change as
  outside its scope.
- Shadow mode — not raised, and no substitute (like the validation-
  sample gate used for Layer 1) has been proposed for a population
  change, which isn't the kind of thing shadow mode over the same users
  would test anyway.

## What actually needs to happen

A new, narrow attorney question: not "should Rincon have Fair-Housing
screening" (settled, standing) but "does counsel's standing authority
extend to opening Archive Search's underlying content to Rincon's entire
Hub population, uncapped, growing with headcount, with no admission gate
of its own" — the exact question the current opinion says it isn't
answering. Until that comes back, this build does not have a cleared
path, regardless of Peter's sign-off on the risk-acceptance document.
Peter's owner-risk-acceptance is real and stands as what it says it is —
his acceptance of his own legal exposure — but it is not a governance or
legal clearance, by its own first line, and this review does not convert
it into one.

**VERDICT: NOT CLEARED. Attorney review required before Tron builds
anything.**
