# Asimov — Confirmation Pass, Layer 1 Removal

**Date:** 2026-09-12. Confirms whether
`compliance/archive-search-layer1-removal-outside-counsel-opinion.md`
closes Asimov's earlier NOT APPROVED verdict on removing Layer 1 from
archive search's Fair Housing screening. Reproduced verbatim from Asimov's
actual output.

---

**Does the new opinion close the attorney-review prong? Yes.** Counsel's
opinion explicitly names both layers, states the OR logic, and gives an
unambiguous holding: "I approve removing the keyword-only Fair Housing
screening layer from Archive Search and relying upon the contextual AI
review previously approved... The fact that this eliminates an independent
automated backstop does not change my opinion." This is the specific,
direct answer — not a documented-provenance substitute. Gate 1 satisfied.
The standing-guidance extraction is a faithful summary of the source
opinion, safe to rely on for future similar changes.

**Validation-sample gate — still required.** Counsel addresses the legal
floor, not an internal quality check. Confirmed unchanged: pull a real
sample of conversations Layer 1 alone currently flags that Layer 2 alone
would clear; confirm none are real Fair Housing concerns; zero-confirmed-
miss bar; before wide release against the rest of the archive. Folds into
TARS's normal real-data test pass.

**Rule 6 mechanics required in the build spec:**
1. `SCREENING_VERSION` bumped to a new, distinct value (currently
   `'archive-search-screening-v3-narrow-fh-self-report'`) at the moment
   `handleNonHeldConversation()` stops calling `checkClaim()`.
2. A Rule 6 `audit_log` entry (e.g. `archive_search.rule6_layer1_removed`)
   citing the outside counsel opinion and standing-guidance file by name,
   owner approval, and the shadow-mode substitute (the validation-sample
   gate).
3. Scope stated explicitly in the spec: archive search only;
   `checkClaim()`/`protected-class-terms.js`/every other caller unchanged.
4. Tier 1 (Auto) classification recorded for the mechanism itself — no
   tenant/owner messaging, no housing decision, only changes which
   archived internal communications a trained employee can see.

**VERDICT: CLEARED WITH CONDITIONS** (the four items above). Mason's
separate confirmation required before Q builds, per the two-signature
pattern used all night — see
`compliance/archive-search-layer1-removal-mason-confirmation.md`.
