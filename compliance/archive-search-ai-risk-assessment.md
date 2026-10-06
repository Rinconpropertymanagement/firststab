# Archive Search — AI Risk Assessment

**Status:** Draft — written to satisfy Asimov's Finding 3 (a dedicated AI Risk Assessment is required before the batch screening pass ever runs against real data). Companion to `projects/hub/email-intake/archive-search-v1-scope.md` (the product design) and `projects/hub/email-intake/archive-search-technical-spec.md` (the engineering design this document assumes in full). Nothing in this document authorizes a build or a live run against real mail.
**Written by:** Oracle, per Asimov's technical-review requirement (Finding 3).
**Date:** 2026-09-10
**Audience:** Written for Peter to read and approve without needing to be a developer.

---

## What's Actually New Here

The hold check (`privilege-filter.js`) and the two-layer Fair Housing content check (`content-check.js`) are **not new** — they're already built, already reused by the complaint tracker, and (per the technical spec's Finding 4) getting two real accuracy fixes as part of this build. What's genuinely new is two things at once:

1. **Retroactive scale.** Every other place these checks run in this codebase processes a normal day's trickle of new mail. This build runs them, once, against 254,056 messages that predate every governance decision this company has made about this content — none of the Fair Housing/legal reviews, none of the shared-inbox risk assessment, none of the complaint tracker's own review existed when most of this mail arrived.
2. **A new, narrow AI classifier reading raw archived correspondence for the first time.** The technical spec's Finding 2 adds a dedicated self-report call (`fair-housing-batch-self-report.js`) whose only job is to catch protected-characteristic-adjacent content the keyword scan misses. Nothing has ever pointed an AI model at this specific archive before — the storage-only Missive connector that landed these messages here never read them for meaning, and complaint-tracking's own categorization step has never run against anything older than this week.

## What This Step Does, In Plain Terms

For every message already sitting in `missive_message_intake`, grouped into conversations:

1. The mechanical hold check runs first — sender/recipient domain plus a keyword scan (now including the two fixes in the technical spec's Finding 4). A hit holds the entire conversation; it is never read for meaning by anything past this point, and it never becomes searchable.
2. Everything else gets the real two-layer Fair Housing content check — a keyword scan, plus (new) a narrow AI self-report asking one question: does this describe a protected characteristic in a way the keywords might have missed. A hit on either layer excludes the conversation from search.
3. Everything that clears both checks becomes searchable by the 8 confirmed people (7 of whom can already read this same correspondence by hand in Missive today).

None of this drafts, sends, or replies to anything. None of it makes a decision about a tenant, owner, or applicant — it decides only whether a piece of already-received correspondence is safe to make findable by search.

## The Risks, and How Each Is Handled

**1. A false negative on the hold check — a real privileged or Fair Housing complaint gets marked searchable.** This is the single highest-stakes failure mode this document covers; everything else is secondary to it. Handled by four independent layers, not one: the mechanical domain/keyword check itself (now closing two real gaps — missing "lawyer," and no word-order tolerance for the Fair Housing complaint phrases, per Finding 4); a real database view (`security_barrier`-protected, only ever returning rows already marked `clear`) that search's own code reads through, so a held or flagged row is never returned in a search result; the pre-launch validation sample specifically targeting the "clear" pool for misses (Finding 5, zero-tolerance exit rule); and the plain fact that even a missed item is not sent anywhere or acted on — at worst, it becomes findable by one of 8 people who already have a legitimate, day-to-day reason to be looking at Rincon's own tenant/owner correspondence, not a stranger.

**Correction, per Asimov and Mason's technical-spec review, 2026-09-10 — stated honestly here rather than only in the technical spec:** the second layer above (the database view) is real, but it is not yet a fully database-enforced boundary. Every Hub tool, including this one, connects to the database through one shared, full-access key — nothing at the database level stops a future line of code from querying the raw archive table directly instead of the safe view. The real backstop for that gap is a required, automated check (part of this build, not optional) that catches any code trying to do that before it ships. This is a real, accepted residual risk, not a solved one — a genuine improvement over having no filter at all, but not the same as a guarantee the database itself enforces. Worth knowing plainly, not just in the more technical companion document.

**2. A false negative on the Fair Housing content flag.** Lower stakes than #1 — a flagged item isn't pulled from a human's view entirely, it's excluded from a convenience search tool; the underlying correspondence isn't lost or hidden from anyone who has another legitimate way to find it (Missive itself, for 7 of the 8). Mitigated the same way: the new keyword fix (Finding 4), the new narrow self-report layer restoring genuine two-layer coverage (Finding 2), and the validation sample (Finding 5).

**3. The narrow self-report classifier itself fails — a timeout, a network error, an unparseable response.** Handled architecturally, not by hoping it doesn't happen: `fair-housing-batch-self-report.js` fails **closed**, identically to the already-proven `tier-b-classifier.js` pattern it's modeled on — any failure resolves to `flagged: true`, never a silent pass and never a thrown exception that could crash the batch run. Under a real outage, the honest failure mode of this system is "more gets excluded from search than strictly necessary," never the reverse.

**4. A false positive — something wrongly excluded from search.** The one failure mode this design deliberately biases toward, matching `protected-class-terms.js`'s own stated design philosophy exactly: a false positive costs a searcher an extra trip to Missive to find something by hand; a false negative is the thing every other mitigation above exists to prevent.

**5. Caylee's new access — a residual, already-accepted risk, not re-litigated here.** The scope document already surfaced this directly: Caylee has Property 360 access but is not a Missive team member, so archive search genuinely is new correspondence exposure for her specifically, not a faster path to something she could already see by hand. **Peter reviewed this directly and made an explicit, on-the-record decision to accept it** as a deliberate, named exception rather than changing the access model. This assessment does not reopen that decision — it is named here only so the one real residual-risk person in this build's access population is not lost between documents.

**6. The search-activity log becomes a new, sensitive asset in its own right.** Logging who searched for what (technical spec Finding 6) is the real mechanism for catching misuse — but that log is itself a genuinely sensitive record of staff behavior. Mitigated by restricting who can read it to `'admin'` role holders only, a narrower population than the 8 people who can run a search at all, and by never surfacing it to searchers or exporting it alongside message content.

**7. The retention/deletion-clock consequence (technical spec Finding 9).** Not a model-behavior risk, but a real, structural consequence of this build worth naming in a risk assessment specifically because it is easy to miss: running this pass starts a real 4-year deletion-eligibility clock on a real share of the archive, immediately, the moment `pipeline_status` flips to `'processed'` for those rows. No deletion job exists yet and nothing is deleted by this build — but this is a real, dated legal fact about the archive from the moment this pass runs, not a hypothetical one. Named here so it's weighed as part of the decision to run the pass at all, not discovered afterward.

## What This Is NOT Covered For

This assessment covers exactly the batch screening pass and the search tool built on top of its output. It does not cover, and would need its own fresh assessment before any of the following are built:

- **Any AI summarization of search results.** The product doc is explicit that v1 has none — "no AI summary of the results, no 'here's what this means,'" and this assessment's coverage ends at exactly that boundary.
- **The recurrence/pattern-detection fast-follow** named in the complaint tracker's own Section 8 — an AI proactively surfacing patterns across the archive is a materially different capability (proactive inference vs. a person typing a word and reading what comes back) and is explicitly out of scope for this build.
- **Any future screening, renewal, or eviction tool joining against this archive's content.** The same structural firewall already established for `complaints` data applies here: no future housing-decision tool may join against `missive_message_intake` or `missive_message_intake_search_safe` without its own fresh Asimov/Mason review. This build adds no foreign key that would make such a join easy, on purpose.
- **The complaint tracker's own categorization risk** — already covered by its own, separate, already-written assessment (`compliance/complaint-tracking-ai-risk-assessment.md`); this document does not re-cover that ground, and that document's clock is not affected by this one.

## Shadow Mode — What It Means Here (and Why the Usual Pattern Doesn't Map Directly)

GOVERNANCE.md Rule 7's normal lifecycle assumes an agent that runs repeatedly over time, so a "14 days of every-run review" or "90 days of shadow mode" period makes sense as a way to build confidence before removing human review from an ongoing process. **This build is not that shape.** The batch screening pass is fundamentally a one-time, bounded job against a fixed archive — there is no daily cadence to shadow, and demanding a multi-week supervised period before a single batch job may run once would not actually buy any additional confidence a calendar can't.

**The real, honest substitute gate for a one-time batch job is the validation sample itself (technical spec Finding 5), not a time-based shadow period:**

- **Before the batch pass runs against the real archive at all:** the technical spec, this risk assessment, and the two keyword-list fixes (Finding 4) must be in place and approved.
- **After the batch pass runs, before search goes live to anyone:** the 1,000-message stratified sample (500 from 2024-01-01 forward, 500 oversampled from before it) is reviewed by hand against the "clear" pool specifically, by whoever holds `'admin'` access — not the full 8-person population.
- **Exit criteria, identical in spirit to the upstream privilege filter's own already-cleared bar:**
  1. **Zero confirmed misses** in the validation sample — a real message the batch pass marked `'clear'` that should have been `'held'` or `'flagged_protected_class'`. This is the one non-negotiable item; any confirmed miss means the pass does not go live, the root cause gets fixed, the entire batch is re-run (not just the sample), and a fresh sample is drawn.
  2. **Peter's own sign-off** that the sample review is complete and the result is trustworthy.
  3. **Asimov's formal sign-off** before `'searcher'` access is granted to anyone beyond the validation reviewers.

**For the ongoing, incremental re-run of this same pass against new mail going forward:** this stays manually triggered only, `x-cron-secret`-gated, no automatic schedule — matching the same posture this codebase already uses for every comparable pipeline (`email-intake/router.js`'s sync route, `complaint-tracking`'s own ingestion route) — for as long as the initial validation period is still fresh in practice. Moving it onto any kind of schedule is a separate, later decision requiring its own sign-off, not assumed by this document.

Only after all three exit criteria above are true should any of the 6 remaining confirmed people (Stephen, Dio, Leo, Regina, Marci, Elizabeth) or Caylee be granted `'searcher'` access.
