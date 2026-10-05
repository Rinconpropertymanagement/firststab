# Archive Search — Recalibrating the Fair Housing Self-Report Question

**Status: CLEARED TO BUILD.** Outside counsel responded in full and
approves (`compliance/archive-search-self-report-recalibration-outside-counsel-opinion.md`).
Asimov's confirmation pass
(`compliance/archive-search-self-report-recalibration-asimov-confirmation.md`,
2026-09-12): Gates 1-3 CLOSED. Mason's confirmation pass
(`compliance/archive-search-self-report-recalibration-mason-confirmation.md`,
2026-09-12): CLEAR, FLAGGED status lifted. Both confirmations are
conditioned on the testing-phase requirement in Section 8 (TARS runs the
"given where he's from" and hijab/hallway-comments examples against the
real model and records both results before the rest of the archive runs)
— that is a condition on resuming the full-archive scan, not on Q
building.

## 1. The problem, found on real data

On 2026-09-12, with Peter's explicit go-ahead, the real screening pass was
run against real archived correspondence. The first chunk (500 messages,
398 conversations) came back: 279 auto-cleared by the wide-net pre-filter
(Option B, already live), and of the ~119 conversations that reached the
existing AI self-report check, 107 were flagged (`flagged_protected_class`).
That is a 90% flag rate on the subset that reaches the check. At that rate,
the full 254,291-conversation archive would produce roughly 60,000-70,000
flagged conversations for the Director of Operations to review by hand —
not workable, and the same "too conservative" problem Peter's attorney
raised at the start of this entire thread, now concentrated rather than
fixed.

## 2. Root cause (Oracle's diagnosis, 2026-09-12)

The self-report check
(`projects/hub/archive-search/lib/fair-housing-batch-self-report.js`) asks
the model only whether the conversation "references a protected
characteristic" — the same broad framing already used elsewhere in this
codebase (`complaint-tracking/lib/categorize-complaint.js`) as a harmless
side-tag on a much richer output. In archive search, this broad flag is the
*only* signal, and it alone decides both search-exclusion and the entire
human-review queue — a role it was never narrow enough to carry alone. A
routine, lawful mention of a protected characteristic (a disability
accommodation granted normally, a tenant's children, a housing-voucher
payment) reads as "referencing a protected characteristic" just as much as
a genuine concern does, so at scale it flags nearly everything that reaches
it.

Full diagnosis, precedent-file comparisons, and the honest recall/precision
tradeoff discussion: Oracle's full report, reproduced in
`compliance/archive-search-self-report-recalibration-oracle-report.md`.

## 3. The fix — Peter's explicit constraint

Peter's own words, 2026-09-12, giving the design constraint for this fix
(the same principle he set for the Option B wide-net filter earlier that
day): **"make is less conservative. no single words. phrases."** — the
check must not turn on the bare presence of a single protected-characteristic
word or topic; it must be driven by actual patterns/phrases of concern
(adverse treatment, an unresolved accommodation request, discriminatory
preference language), not mere topical mention.

### Final replacement question (`buildPrompt()`) — counsel's own language

Same call shape as today — one Claude call, `claude-sonnet-5`,
`max_tokens: 512`, `effort: 'low'`, 12s timeout, JSON-only response. Only
the question text changes. **This is counsel's own recommended language
from his opinion (Section 10), adopted verbatim as the build target** —
superseding the earlier Oracle/Mason-fix draft that circulated before
counsel responded:

> You are reviewing a single email conversation from a property management
> company's inbox, for one narrow question.
>
> This conversation already matched an automated scan for language
> connected to a legally protected characteristic (race, religion, sex,
> familial status, disability, national origin, source of income, marital
> status, age, or a similar protected category). That match alone does not
> mean this conversation is worth a person reviewing.
>
> Conversation:
> """
> {threadText}
> """
>
> Setting aside the mere presence or discussion of a protected
> characteristic, does this conversation reasonably indicate a potential
> Fair Housing concern?
>
> Flag the conversation if it reasonably indicates:
> (a) adverse, hostile, derogatory, or differential treatment connected to
> a protected characteristic, including a refusal, denial, exclusion,
> threat, different service, or materially different treatment;
> (b) a disability accommodation or modification request that appears to
> have been refused, ignored, materially delayed, retaliated against, or
> left unresolved;
> (c) a preference, limitation, policy, steering effort, recommendation,
> advertisement, instruction, or housing decision that appears influenced
> by a protected characteristic; or
> (d) indirect or euphemistic language that, viewed reasonably in context,
> suggests a protected characteristic influenced or may influence
> treatment, services, a housing decision, policy, preference, limitation,
> or recommendation.
>
> Do not flag solely because a protected characteristic is identified,
> mentioned, or discussed. Do not flag a reasonable accommodation or
> modification merely because it was requested or granted. Ordinary
> factual or operational discussion involving a protected characteristic
> should clear unless the surrounding context reasonably indicates one of
> the concerns above.
>
> If the communication presents a genuine ambiguity that cannot reasonably
> be resolved from context, send it for human review.

Respond-with-JSON instruction is unchanged from today's version (`{"flagged":
true or false, "category": ...}`).

### Example pairs (benign vs. concerning)

| Characteristic | Clears | Still flags |
|---|---|---|
| Disability | "Tenant requested grab bars as a reasonable accommodation; installation completed June 14." | "Tenant asked for grab bars in March for her mobility issue — we told her we don't do those kinds of modifications here." |
| Familial status | "New tenant has two kids, ages 6 and 9, will need the extra parking spot." | "Owner: I'd rather not rent to families with young kids in that unit — can we word the listing to avoid that?" |
| Source of income | "Tenant's Section 8 payment posted a few days late; voucher office says it's processing normally." | "We got her voucher paperwork but I told her we just don't want to deal with Section 8 tenants — let's find a reason to pass on the application." |
| Religion | "Tenant asked to move a maintenance visit around a religious holiday — rescheduled to Thursday, no problem." | "The new tenant wears a hijab and another resident keeps making comments about it in the hallway; she's asked us to do something." |
| National origin | "Tenant's primary language is Spanish — sent the renewal notice in both languages this time." | "I don't think this building would really work out for someone in his situation, given where he's from." |

### Fail-closed behavior — unchanged

Any network failure, timeout, `stop_reason === 'max_tokens'`, or
unparseable JSON still resolves to `{ flagged: true, category:
'model_self_report_failed_closed' }`, exactly as today. Only the question
asked on a successful response changes.

## 4. Decisions Recorded — Peter, 2026-09-12

Oracle's plan raised two open questions. Peter's answers, verbatim:

- **On adding a third "restrict but don't flag" middle bucket** (raised
  because outside counsel's existing opinion, point 9, sketches a
  three-bucket idea): Peter said **"keep it simple"** — this build stays a
  two-bucket design (flag-and-review, or clear), matching today's existing
  architecture. The middle bucket is not being added in this round.
- **On a short follow-up confirmation question to outside counsel:** Peter
  initially said "skip the attorney question," but Asimov's and Mason's
  review both concluded the documented-provenance path did not close this
  cleanly (see the review records referenced in Section 7), so a short
  follow-up question was sent after all
  (`compliance/archive-search-self-report-recalibration-attorney-question.md`).
  Counsel has since responded in full and approves — see
  `compliance/archive-search-self-report-recalibration-outside-counsel-opinion.md`.
  This prong is now closed on the merits.
- **On a 7-day-shadow-mode-style trial period before running the rest of
  the archive** (Asimov flagged this needed a fresh decision from Peter,
  since the reasoning behind the two earlier waivers that day — Option B,
  the escalation mechanism — does not transfer to a change that directly
  alters the AI's own decision criteria): Claude explained this distinction
  to Peter directly. Peter's response, verbatim: **"yes, no trial period."**
  No sample-based hold-point before running the rest of the archive.
  Counsel's own opinion independently supports this — Section 6 of his
  opinion accepts the existing uncertainty-defaults-to-review rule as
  sufficient and his Conclusion says only to "proceed with testing against
  real archive data," not a formal monitored period.
- **On the ~119 conversations already screened today under the old, broken
  question** (107 flagged, ~12 clear — Asimov flagged this as an
  unaddressed gap): Peter's decision, verbatim: **"reset the scan."** These
  119 conversations get their `screening_result` reset to `NULL` as part of
  shipping this fix, so they get re-evaluated under the new question rather
  than keeping stale results from the broken one. This reset should happen
  as part of the same deploy, not before the new code exists.

## 5. Governance classification

**Critical-tier** change under GOVERNANCE.md Rule 6, confirmed by Asimov's
first-pass review. Rule 6's three prongs, current status:

| Prong | Status |
|---|---|
| Owner approval | Closed — all design decisions recorded in Section 4 |
| Attorney review | Closed — counsel reviewed the actual concrete prompt/examples and approved (Section 3, Section 4) |
| Shadow mode | Closed — Peter's explicit "no trial period" decision (Section 4), independently consistent with counsel's own Conclusion |

## 6. Required build mechanics (Asimov's first-pass review)

Not optional, not previously in this spec — must be part of Q's build:

1. Bump `FAIR_HOUSING_SELF_REPORT_VERSION` in
   `fair-housing-batch-self-report.js` (currently
   `'archive-search-self-report-v1'`).
2. Bump `SCREENING_VERSION` in `screening-pass.js` (currently
   `'archive-search-screening-v2-wide-net-prefilter'`) — required by that
   file's own documented rule whenever
   `FAIR_HOUSING_SELF_REPORT_VERSION` changes materially.
3. Write a Rule 6 change-management `audit_log` entry recording the
   previous self-report version, the new version, a reference to this spec
   and counsel's opinion, **and the disposition of the 119 conversations
   (item 4 below) in the same entry** (Asimov's confirmation-pass addition
   — one record, not two separate facts to reassemble later) — same shape
   as the escalation mechanism's `archive_search.rule6_shadow_mode_waived`
   entries.
4. Reset the ~119 already-screened conversations from today's real run
   back to `screening_result = NULL` (Section 4, Peter's "reset the scan"
   decision), as part of the same deploy. Verified safe by Asimov: the
   search view filters on `screening_result = 'clear'` (strict equality),
   so a `NULL` row can never appear in search — no exposure window before
   re-screening.

## 7. Governance/legal review records

- Counsel's opinion —
  `compliance/archive-search-self-report-recalibration-outside-counsel-opinion.md`.
- Asimov's confirmation pass (Gates 1-3 CLOSED) —
  `compliance/archive-search-self-report-recalibration-asimov-confirmation.md`.
- Mason's confirmation pass (CLEAR, FLAGGED lifted) —
  `compliance/archive-search-self-report-recalibration-mason-confirmation.md`.

Both confirmation passes are complete and on record. **This gate is
closed.**

## 8. Next steps

1. ~~Short confirmation from Asimov and Mason~~ — DONE, both on record
   (Section 7).
2. Q builds it — the exact prompt in Section 3, plus the four mechanics in
   Section 6.
3. TARS re-runs it against the same real ~500-message batch already
   processed today, and specifically runs two hard examples through the
   real model with the actual result recorded (Mason's confirmation-pass
   requirement): the "given where he's from" euphemism example, and the
   hijab/hallway-harassment example — so the actual new flag rate and
   behavior on both hardest cases are known before running the rest of the
   archive.
4. Only after TARS confirms and Peter gives a final go-ahead: resume
   running against the remaining real archive.

**Peter's final go-ahead, verbatim, 2026-09-12, after seeing TARS's real
119-conversation comparison (90% → 0% on that subset) and both hard-example
passes: "go ahead with the full scan. trust the process."**
