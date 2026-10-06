# Management Risk Memo — Content-Screening Precision Redesign

**Re:** The Tier A / Tier B change to the maintenance-history tool's Fair Housing content screen
**Prepared by:** Mason (Rincon's internal legal-review function), at outside counsel's recommendation
**Prepared for:** Peter McKenzie, Rincon Management — for Rincon's own files
**Date:** September 5, 2026

**A note on what this document is.** This memo is not required by any specific law. Rincon's outside counsel reviewed this change, approved it, and separately suggested — as good practice, not a legal obligation — that Rincon write a short internal memo explaining what changed and why, so there is a clear record if anyone ever asks. Separately, Rincon confirmed on this same date that it is not a business covered by California's newer privacy risk-assessment rules, so no state-required privacy risk assessment applies here either. Everything below is a factual account, not a legal opinion. Where counsel's actual opinion matters, it is quoted or cited directly. This memo does not replace that opinion and should be read alongside it.

---

## 1. Purpose

Rincon's maintenance-history tool keeps a record of repair and maintenance activity for every property it manages, pulled from field-service tickets and from Rincon's property-management software. Before any of that text is shown to staff, it passes through an automated screen whose job is to catch language that might touch a legally protected characteristic — race, disability, age, familial status, and similar categories protected under the federal Fair Housing Act and California's Fair Employment and Housing Act (FEHA). When the screen catches something, it holds that record out of ordinary view until a trained staff member reviews it. This exists so that maintenance records — which are written quickly, by many different people, and not with legal review in mind — don't casually create an appearance that Rincon is tracking or acting on a tenant's protected characteristics.

This particular change was made because the screen, as it existed until today, was doing that job very badly. A full review of every record it had ever flagged found that the overwhelming majority of flags had nothing to do with anyone's race, disability, or age — they were ordinary maintenance language that happened to contain a handful of overloaded words. That is the problem this redesign fixes.

## 2. The Problem

Rincon's team read all 340 records the screening tool had ever flagged since it went into use — not a sample, the entire history — and checked each one against what actually triggered it. About 91% of those 340 records, roughly 309 of them, were false positives: the flag fired, but the text had nothing genuinely to do with a protected characteristic.

Nearly all of that false-positive volume traced back to six specific words or phrases:

| Word or phrase | What it was actually being used to describe | Documented scale |
|---|---|---|
| "white" / "black" | A paint color, an appliance or fixture finish, or a brand name — most commonly "Bradford White," a water-heater brand | 214 of the 340 flagged records matched only these two words. None of them matched any actual race or ethnicity term. |
| "blind" | Window blinds — a household item — not a person's vision | 50 of 95 disability-related flags |
| "diagnosis" / "diagnosed" | A technician's diagnosis of a mechanical, electrical, or plumbing problem — not a person's medical diagnosis | 45 of 95 disability-related flags |
| "too old" / "too young for" | A piece of equipment or hardware described as worn out or outdated — not a person's age | Part of the same overall pattern; not separately broken out in the underlying review |

A small number of the 340 flags — roughly 10 to 12 — were genuine, correct catches: for example, a standard safety question asking whether an infant, elderly, or disabled resident lives in a home before certain heat-related repair work, and one instance of a tenant reporting an actual health concern. The tool does catch real issues. It was just catching about ten false alarms for every one real one.

## 3. What's Changing

The screen works in two layers today, and that basic design is not changing. Layer 1 is a fixed list of words tied to protected categories — if a maintenance record contains one of those words, the record gets flagged. Layer 2 is a separate AI check that reads the record and can flag it independently, even if no listed word matched. Either layer flagging something is enough to hold the record for review; nothing about that structure changes here.

What changes is what happens the moment one of the six specific words above shows up. Every other word on the list still works exactly as it always has — if it appears, the record is flagged immediately, no extra step, no change at all. But for those six words only, the system now runs one additional, narrow check before deciding whether to flag: it asks a targeted, single-purpose question — does this specific word, in this specific sentence, actually refer to the protected thing (a person's race, disability, or age), or does it refer to the ordinary thing (a paint color, window blinds, a mechanical diagnosis, worn-out equipment)? If the answer is that it's genuinely about a person, the record is flagged, same as before. If the answer is genuinely ambiguous — the check can't tell — the record is also flagged; the system is built to send anything uncertain to a human rather than guess that it's safe. Only when the answer is clearly and only the ordinary meaning does the record pass through without a flag.

Nothing was removed from the list of words the system watches for. The six words are still watched just as closely as before — they just get one extra, specific question asked about them before a flag is raised, instead of being flagged automatically the instant they appear. There is also a manual off-switch: if this new check is ever found to be behaving badly, it can be turned off instantly, which makes those six words go straight back to auto-flagging exactly as they did before this change, with no new code required to do it.

## 4. What Data Is Involved

No new kind of data is being collected or used. The text being checked is the same maintenance ticket and repair-record text this tool has always processed — nothing beyond what a maintenance ticket already contains, and no tenant Social Security numbers, financial account numbers, or similar sensitive identifiers are involved at any point.

The new targeted check uses the same AI service (Anthropic's Claude) and the same Rincon account already used elsewhere in this same tool to summarize maintenance records. This does not introduce a new AI vendor or a new data-sharing relationship — it is the same provider, reading the same category of text, for a closely related purpose.

## 5. Human Review & Override Availability

Anything the screen flags — whether by the unchanged part of the system or by the new targeted check — still goes into the same "Needs privacy review" queue that has always existed, and stays out of ordinary staff view until someone with that review responsibility looks at it. Nothing about that gate changes.

What's new is a two-way override, so a human can correct the system in either direction:

- **Clearing a wrong flag.** If a reviewer sees a flagged record that is obviously not about a protected characteristic — for example, "Bradford White 50-gallon heater" wrongly flagged as a race reference — they can clear it. This requires a written reason and is recorded, including who did it and when.
- **Flagging something the system missed.** If a staff member notices something in a record that should have been flagged but wasn't, they can flag it themselves. This also requires a written reason and is recorded the same way.

Both of these actions are restricted to staff who already hold the tool's privacy-review access — this is not open to every user of the system.

## 6. Expected Benefit

The direct benefit is a much smaller, much more useful review queue: reviewers stop wading through hundreds of records about paint colors and water heaters to find the handful that actually matter.

The reason this matters beyond convenience is the point counsel raised directly: a screening tool that cries wolf constantly trains the people using it to stop paying attention to it. If nine flags out of ten are meaningless, the tenth one — the one that's real — is the one most likely to get rubber-stamped through without a real look. Making the tool more accurate is not a loosening of the compliance program; it's what keeps the program credible enough that staff actually use it the way it's meant to be used.

## 7. Testing Performed

Before this went live, the new targeted check was run against all 340 previously flagged records' actual text — the entire known test set, not a new sample — and its answers were compared against the already-established correct human determination for each one. Immediately after deployment, it was also verified against two real, concrete examples run through the live system: the actual "Bradford White 50-gallon water heater" record that first surfaced this problem correctly cleared, and a genuine race-related test sentence correctly flagged.

The original plan called for an additional step before the new check was allowed to actually control anything: a short period where the new logic would run and its answers would be logged, but the older, cruder logic would still be the one actually deciding whether to flag a record — so any disagreements between the two could be reviewed by management before the new logic took over for real. That step did not happen, and it is worth stating plainly why. While building this, it turned out the technical off-switch only works in a fully binary way — either the old behavior (auto-flag) or the new behavior in full control — there was no way, without a separate and larger build effort, to have the new logic observe and log its answers silently while the old logic kept actually deciding. Presented with that choice — delay to build that extra safety step, or rely on the historical backtest and the two live spot-checks and go live the same day — Peter chose to go live immediately, accepting that there would be no separate observation period before the new check had real authority over these flags. That was a deliberate, informed decision, not something that slipped through unnoticed.

Because that step was skipped, the periodic audits described in Section 9 are the only ongoing, real-world check on how accurately this new check actually performs, and they should be treated as a firm commitment rather than an optional nice-to-have.

## 8. Who Approved Deployment

- **Outside counsel.** Rincon's actual outside counsel reviewed the proposed redesign and issued a written opinion on September 5, 2026, approving it and specifically endorsing the two-tier design described above. It was counsel who recommended writing this memo in the first place, as good practice rather than a legal requirement. One detail is worth recording honestly: the opinion was provided to Rincon's internal development system as text, without the attorney's name or firm attached to it. When asked directly, Peter confirmed personally that this is a genuine opinion from Rincon's actual outside counsel — a California-licensed attorney who has represented Rincon for a number of years — and that he chose not to share that attorney's name or firm with the AI system, as a deliberate privacy decision about not putting a named individual's information into an AI tool. Peter's direct confirmation, as the person who holds that attorney relationship and bears responsibility for it, was treated as sufficient for this project. As a follow-up, Rincon should keep the actual correspondence with counsel — the email, letter, or engagement record — in its own separate files, outside of this software project, as the lasting record of where this opinion came from.
- **Internal technical and legal-wording review.** On September 5, 2026, Rincon's internal governance reviewer and Mason (legal/Fair Housing wording) each checked the detailed build plan against counsel's opinion and against the actual underlying code, to confirm the plan matched what counsel had approved and that the system would work the way the plan described. Each required specific corrections before signing off, which were made. This step checked implementation accuracy — it was not a second legal opinion.
- **Peter's approval to build.** Peter approved building this change on September 5, 2026.
- **Peter's decision to deploy immediately.** Also on September 5, 2026, once told that the originally planned observation step could not be built without delay, Peter chose to deploy the new check with full authority right away rather than wait.

All of the above happened quickly — the follow-up memo went to counsel on September 4, 2026, counsel's opinion came back the next morning, and review, build, approval, and deployment all happened within that same day, September 5, 2026. That pace is recorded here plainly rather than smoothed over, because it is part of an honest account of how this decision was actually made.

## 9. Ongoing Oversight

Because the live observation step was skipped, regular after-the-fact checking carries more of the weight here than it otherwise would, and is not optional. The plan is:

- **Monthly** reviews for the first three months after go-live, reflecting the higher vigilance appropriate given that this went live without a separate observation window.
- **Quarterly** after that, assuming the monthly reviews don't turn up a problem.
- Each review covers **100% of the records the new check actually flagged** during that period — flagging is the smaller-volume outcome, and a mistake in that direction (missing a real protected-class reference) is the more serious kind to catch — plus a **random sample of roughly 20 to 25 records the check cleared**, as a broader spot-check on accuracy in the other direction.
- Reviews are conducted by Mason or whoever holds the tool's reviewer/administrator role, and each one produces a brief written note: the date, how many records were reviewed, and what was found.
- The manual off-switch described in Section 3 remains available at any time — if a periodic review, or anything else, surfaces a real problem, the new check can be turned off immediately, reverting to automatic flagging on all six words, without needing new code.

This memo will be updated if a periodic review finds a real problem, or if the design of this system changes again.
