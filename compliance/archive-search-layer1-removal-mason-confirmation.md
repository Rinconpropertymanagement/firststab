# Mason — Confirmation Pass, Layer 1 Removal

**Date:** 2026-09-12. Confirms whether
`compliance/archive-search-layer1-removal-outside-counsel-opinion.md`
closes Mason's earlier ATTORNEY REQUIRED verdict on removing Layer 1 from
archive search's Fair Housing screening. Reproduced verbatim from Mason's
actual output.

---

**1. The disclosure gap — the actual reason for the prior red verdict — is
closed, directly and specifically.** The new opinion states plainly:
"Archive Search presently uses two independent Fair Housing checks,"
correctly describes each layer, correctly states the OR logic, devotes a
full section to the exact tradeoff ("The Absence of an Independent Keyword
Backstop"), and closes with an unambiguous, change-specific holding: "I
approve removing the keyword-only Fair Housing screening layer from
Archive Search and relying upon the contextual AI review previously
approved... The fact that this eliminates an independent automated
backstop does not change my opinion." That sentence is what the prior
review was waiting for — now on the record, in counsel's own words.

**2. The residual-risk acceptance leaning on the control stack is directly
addressed, and the stack is unchanged.** Counsel conditions his acceptance
on the system "viewed as a whole" (contextual classifier, human review for
uncertain cases, fail-closed on error, limited access, logging, escalation
path). Removing Layer 1 touches none of those.

**3. Standing guidance and the "replace an older mechanism" language
independently cover this too** — belt and suspenders; the specific opinion
alone is already sufficient.

**4. The escalation-mechanism-availability question is answered and
doesn't reopen anything for THIS change.** DB/routes deployed and
functional; no search UI exists yet, so no employee can search or
escalate anything regardless of this change — a pre-existing, separate
gap, not worsened by this one. Flagged as a precondition for the search
UI's eventual launch (a real end-to-end search-and-escalate test), not for
this classification-logic change.

**VERDICT: CLEARED ✅.** No further attorney referral needed on this
point. Two process items to carry forward, neither a legal blocker: (1)
the validation-sample gate (TARS, before full-archive rollout), (2) an
end-to-end escalation test before the search UI ships to any employee
(separate future milestone).
