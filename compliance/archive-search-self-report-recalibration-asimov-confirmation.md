# Asimov — Confirmation Pass, Self-Report Recalibration

**Date:** 2026-09-12. Confirmation pass following Asimov's first-pass
review (NOT CLEARED), after Peter's outside counsel responded in full
(`compliance/archive-search-self-report-recalibration-outside-counsel-opinion.md`)
and the spec
(`projects/hub/email-intake/archive-search-self-report-recalibration-spec.md`)
was updated to adopt counsel's own recommended prompt language verbatim.
Reproduced in full from Asimov's actual output — nothing paraphrased.

---

Reviewed both documents in full, and checked the three things a
confirmation pass can't take on faith: whether the spec's Section 3 prompt
actually matches counsel's Section 10 language, whether Section 6's build
mechanics are real and complete, and whether the "reset to NULL"
disposition is actually safe given how the search view filters rows. Also
confirmed no code had been touched yet
(`fair-housing-batch-self-report.js` and `screening-pass.js` still showed
the old version strings and old prompt at the time of this review) —
nobody built ahead of this confirmation.

**Gate 1 — Attorney review: CLOSED.** Counsel's Section 10 recommended
prompt and the spec's Section 3 prompt match, clause for clause — (a)
through (d), both "do not flag solely because..." sentences, and the
closing ambiguity-to-human-review line are word-for-word identical. The
only additions in Section 3 are call scaffolding (the intro sentence
framing it as "one narrow question" and the `{threadText}` slot) — not
substantive standard changes. This is real attorney review of the actual
deployed language, not the documented-provenance-by-analogy path rejected
in the first pass. Gate 1 is satisfied.

**Gate 2 — Shadow mode: CLOSED.** Spec Section 4 records Peter being told
the specific distinction Asimov raised (this change alters the AI's own
decision criteria, unlike the two same-day waivers it doesn't transfer
from) and then giving an explicit, on-the-record answer: "yes, no trial
period." That's the fresh decision required. Counsel's own opinion
(Section 6, and the Conclusion's "proceed with testing against real
archive data" rather than a monitored period) independently supports the
same outcome. Gate 2 is satisfied.

**Gate 3 — Build mechanics: present and technically verified, one small
completeness note.** Section 6 lists all four required items, each checked
against the real code/schema rather than taken on the spec's word:

- Version bumps — `FAIR_HOUSING_SELF_REPORT_VERSION`
  (`archive-search-self-report-v1`) and `SCREENING_VERSION`
  (`archive-search-screening-v2-wide-net-prefilter`) in the spec match the
  live constants exactly. Correct target.
- Audit log entry — modeled on the real, already-written precedent
  (`archive_search.rule6_shadow_mode_waived`, hash-chained, in the
  escalation-mechanism build). Legitimate template.
- Reset the 119 conversations to NULL — verified safe, not just
  plausible-sounding: `missive_message_intake_search_safe` (the only view
  any search route may query) filters on `m.screening_result = 'clear'` —
  strict equality, not a NULL-inclusive check. A `NULL` row can never
  satisfy `= 'clear'` in SQL, so all 119 (including the 107 real flags)
  drop out of search the instant they're reset, with no exposure window
  before re-screening. Fail-closed by construction, not by assumption.

One thing folded into the spec before build (not a re-open of the gate):
Section 6 item 3's audit entry must also record the disposition of the 119
conversations in that same entry (count reset, why) — one record, not two
separate facts a future dispute would have to reassemble. This has since
been added to spec Section 6.

**Verdict at the time of this confirmation pass:** Gates 1 and 2 CLOSED.
Gate 3 verified sound with the one addition above. Mason's own confirmation
pass was still pending at the moment this review was written — see
`compliance/archive-search-self-report-recalibration-mason-confirmation.md`
for Mason's separate, subsequently-completed confirmation (verdict: CLEAR).

**With both confirmations now on record, all of Asimov's gates for this
build are CLOSED.**
