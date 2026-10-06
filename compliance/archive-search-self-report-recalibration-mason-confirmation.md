# Mason — Confirmation Pass, Self-Report Recalibration

**Date:** 2026-09-12. Confirmation pass following Mason's first-pass
review (FLAGGED), after Peter's outside counsel responded in full
(`compliance/archive-search-self-report-recalibration-outside-counsel-opinion.md`)
and the spec
(`projects/hub/email-intake/archive-search-self-report-recalibration-spec.md`)
was updated to adopt counsel's own recommended prompt language verbatim.
Reproduced in full from Mason's actual output — nothing paraphrased.

---

**1. Category (b) "too disability-anchored" — closed, but not the way
you'd expect.** Counsel's (b) is still disability-specific ("a disability
accommodation or modification request..."). That's correct FHA
terminology, not a bug — "reasonable accommodation/modification" is a
defined disability-only legal term. The original concern — a denied
non-disability accommodation-style request (e.g., a religious-practice
accommodation) falling through a gap — is caught instead by (a)'s broad
language: "a refusal, denial, exclusion... connected to a protected
characteristic." A denied religious accommodation is a denial connected to
religion, so (a) sweeps it in even though (b) doesn't name it.
**Functionally closed.**

**2. Missing explicit third-party/tenant-on-tenant harassment coverage —
partially closed, wants an empirical check, not another wording round.**
Counsel's (a) includes "hostile... treatment connected to a protected
characteristic," broad enough to plausibly cover a hostile-environment
scenario created by another resident that management was told about and
must address (the real legal theory — HUD's harassment rule, 24 CFR
100.600, holds housing providers responsible for known third-party
harassment they fail to address). But the word "harassment" and any
explicit third-party framing never appears in the instruction text itself
— the spec's own example table (the hijab/hallway-comments row) assumes
this is covered, but that's the spec authors' assumption, not something
written into the prompt. Not requesting a fourth counsel round over this —
it's a defensible reading of "hostile treatment," and outside counsel
already accepted comparable residual risk for language the model has to
infer. Instead: **the hijab/hallway-comments example must be added to
TARS's empirical test list**, alongside the euphemism example, so there is
an actual model result for this fact pattern before it governs the archive
— not just an assumption in a table. (Since folded into spec Section 8.)

**3. Category (c) "stated preference" language not clearly catching
euphemism — fully closed, better than a wording patch would have been.**
Counsel didn't patch (c) — he added a standalone category (d) purely for
"indirect or euphemistic language that, viewed reasonably in context,
suggests a protected characteristic influenced or may influence
treatment..." at a "reasonably suggests" standard. Cleaner than folding it
into "preference" language, and the strongest of the three resolutions.

**Item 2 (send the outside-counsel question) — confirmed closed.** Counsel
reviewed the actual concrete prompt and the actual example pairs — not the
general concept — and gave explicit sign-off plus his own recommended
final language. That's the strongest form of the Rule 6 attorney-review
prong, and it directly resolves what Asimov's first pass flagged as an
open gap.

**Item 3 (empirical test of "given where he's from") — confirmed this
remains a requirement.** Spec Section 8 states it clearly enough: TARS must
run "given where he's from" through the real model and record the actual
result before the rest of the archive runs. Correctly scheduled during
testing, not before build. One addition (now folded into spec Section 8):
extend the same empirical-test line to the hijab/hallway-comments example
too — same treatment, same gate, no change to sequencing or to Q's build
start.

**No prompt-wording changes required.** One addition to Section 8 (TARS's
test scope) — already made: also run the third-party-harassment example
pair through the real model and record the result, alongside the euphemism
example, before resuming the full archive.

**No further attorney referral needed on the wording itself.** Counsel
already reviewed the exact language being shipped.

**VERDICT: CLEAR ✅ — FLAGGED status is lifted.** Counsel's Section 10
language, now spec Section 3, functionally closes all three of Mason's
original wording gaps (two cleanly, one via a broader neighboring category
to be empirically confirmed rather than re-argued). This clearance is
conditioned on the plan in spec Section 8: TARS runs the real model against
the "given where he's from" example and the hijab/hallway-comments example,
records both actual results, before the rest of the archive runs. That is
a testing-phase condition, not a build-blocking one — **Q may build now.**
