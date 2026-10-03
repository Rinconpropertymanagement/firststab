# Archive Search — Owner Risk Acceptance: Waiving the 7-Day Shadow Mode on the Search-Corpus Replacement

**This is an owner risk-acceptance document, not a governance or legal
clearance.** Asimov and Mason have not been asked to bless waiving this
specific requirement. Outside counsel has not been asked either — the
counsel opinion on file treats shadow-mode-style verification as
engineering/governance discretion, not something it opines on directly.
This document records Peter, as owner of Rincon Management, choosing to
proceed without it anyway.

## What is being waived

GOVERNANCE.md's Rule 6 requires, for a Critical-tier compliance change:
owner approval, attorney review, **and 7 days of shadow mode** — running
the new mechanism live and verified before anything depends on it,
before it ships. Both Asimov's and Mason's confirmations on the
search-corpus replacement (`compliance/archive-search-search-performance-security-barrier-asimov-confirmation.md`,
`-mason-confirmation.md`) required this explicitly — Mason specifically
flagged it as a gap neither earlier review had named. Neo's design
(`projects/hub/email-intake/archive-search-search-performance-security-barrier-spec.md`)
proposed a full, literal 7-day shadow period: the new search corpus runs
fully live, reconciled against the real exclusion state, for a week,
before the search route is allowed to read from it — specifically so any
bug in the new sync mechanism gets caught by observation before it's the
only thing standing between search and content that's supposed to be
excluded.

**What's being waived is that observation week — not the mechanism
itself.** The same-transaction fail-closed removal triggers, the
subset-guarantee reconciliation check, and the audit logging described
in Neo's design all still run. What's skipped is the week of watching
those things work correctly on real data before letting the search route
actually depend on them.

## Peter's basis for proceeding anyway, and his decision

Peter's position, stated directly in chat: **"i am exempting it for this
one time. i accept all the risk and will sign a doc."** Told directly
that the 7-day requirement is not about external exposure — the same 9
internal, growing-with-headcount searcher population is exactly who the
underlying exclusions (Fair Housing escalations, suppressions, held
content) protect against — Peter chose to exempt this requirement
anyway, for this build specifically, not as a change to the standing
GOVERNANCE.md rule.

## The real, honest risk being accepted

Stated plainly, not minimized:

- The new sync mechanism (database triggers, a reconciliation job) has
  never run against real production data and real concurrent usage. The
  7-day period existed specifically to surface a bug — a race condition
  under real load, a trigger that doesn't fire the way it does in
  isolated testing, a reconciliation job that doesn't actually catch what
  it's designed to catch — before the search route depends on it.
  Skipping that period means any such bug, if one exists, is discovered
  in production, live, rather than caught in advance.
- The specific failure mode this protects against: an escalated Fair
  Housing conversation, a suppressed conversation, or held/privileged
  content becoming visible in ordinary search to the current or future
  searcher population, undetected, because the new mechanism had a flaw
  the shadow period would have caught.
- This is not a reduction of the mechanism's own design — the
  same-transaction, fail-closed removal path and the subset-guarantee
  reconciliation check are unchanged and still run from day one. The risk
  is specifically that day one is live rather than observed-first.
- Neither Asimov nor Mason has confirmed this specific waiver resolves
  cleanly, and neither was asked to before this document was written —
  Peter is choosing to proceed on his own authority rather than wait for
  that review, consistent with how he has made comparable calls earlier
  today.

## What happens next

Once signed, this document authorizes Q to build the search-corpus
mechanism per Neo's design and, once built and applied, to let the
search route depend on it immediately rather than after a 7-day
observation period. It does not authorize skipping the reconciliation
check, the fail-closed triggers, or the audit logging themselves — only
the waiting period before relying on them. Asimov and Mason will still be
shown this document after the fact, per this project's transparent-
override practice.

---

## Signature

**I have read this document, understand that this skips the 7-day
observation period meant to catch a flaw in a brand-new mechanism before
it's relied on to keep excluded content out of search, and accept that
risk as owner of Rincon Management.**

Signed: Peter McKenzie — confirmed in chat, verbatim: "i confirm, sign it"
Peter McKenzie, Owner, Rincon Management
Date: 2026-09-24
