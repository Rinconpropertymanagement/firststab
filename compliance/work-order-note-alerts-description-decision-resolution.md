# Decision Resolution: Work Order Alert description block — no AI, risks accepted, Mason review skipped

**Date of Peter's decisions:** 2026-10-16
**Recorded by:** Asimov (governance), from the questions and the reply that Jarvis relayed, word for word.
**Status:** Recorded. **Peter confirmed the four questions and his four answers on 2026-10-16** (his reply "confirmed", relayed by Jarvis; see "Peter's replies to Jarvis's three questions" below). **Scope of that "confirmed", stated exactly:** Jarvis asked him to reply "confirmed" on "the decision record (our four questions and your four answers, word for word)". So it confirms the four questions and the four answers. It does **not** yet confirm the quotations and summaries of his later decisions (section "Later decisions of 2026-10-16"), which he had not seen when he replied; those are put to him again with the final record at the moment of ON. Updated by Asimov on 2026-10-16 after the third fix round with Peter's later decisions of the same day (the Missive copy, the shadow week and the faster check), and again after the fourth fix round with his replies to Jarvis's three questions and the facts of round 4. This document is the durable record of Peter's four answers, of those later decisions and of those replies. It is referenced by `compliance/work-order-note-alerts-description-governance-review.md` (Asimov's rulings and final reviews) and `projects/hub/work-order-notes-alert-SPEC.md` (Section 6A), and should be cited by Q's follow-up work and by any future review of this feature. Asimov is relying on Jarvis's relay for the wording and for what each answer settled; Asimov did not see the chat.

**Date Peter read this record and confirmed it:** 2026-10-16 *(entered by Asimov at Jarvis's instruction, from Peter's reply as relayed by Jarvis. It covers the four questions and four answers only; see the scope note above.)*

**Update of 2026-10-17 (Asimov):** Peter's decisions of 2026-10-17 are recorded in the section "Peter's decisions of 2026-10-17: the content screen turned off (Option B), ..." below. They turn the content screen itself off, as an **owner override** (CLAUDE.md rule 3) that is **never to be described as a met condition**, and they are the newest word on every point they touch. Where an older section of this record describes the word-list screen as the safeguard that holds text, read it as the record of the **screened version**, which stays in the code and is what runs unless the owner's switch `WORK_ORDER_ALERT_DESCRIPTION_SCREEN` is set to exactly `off`. Older sections are not rewritten; later notes say where they are superseded.

---

## What Asimov's earlier rulings required

The full text of Asimov's design-stage and first final rulings was given in earlier sessions. As summarised in the build brief: the optional "What the work order is" block in the Work Order Alert email was allowed only behind a safeguard that fails closed (a keyword scan, a contextual rescue for a few ordinary words such as "white" and "black", and an AI second look at the text), with counts-only audit, nothing stored, a shadow period, **Mason's review (Fair Housing and legal)**, and Peter's sign-off on rendered samples before switching on. A first version was built to that (commit `cae5a2491`).

## The four questions and Peter's reply, word for word

Jarvis put four questions to Peter in chat on 2026-10-16. They are given here exactly as Jarvis relayed them to Asimov. Asimov did not see the chat itself.

| # | The question, verbatim |
|---|---|
| 1 | "Do you accept the AI second look on this text? You said no AI for the property notes. This is different text. My recommendation is yes, and the alternative is no description at all." |
| 2 | "Do you accept that a miss is possible? If both checks miss something, a tenant's words about health or safety could land in the shared pod inboxes. Phone numbers, emails and gate codes typed into the description would also pass through. I'd recommend removing phone numbers and email addresses from the text as well." |
| 3 | "Mason's review: Asimov requires it. Skipping it needs your explicit say-so, and I'd recommend keeping it." |
| 4 | "Length: Asimov's limit is 300 characters, up to 500 if the shadow week shows 300 is too short. I'd start at 300." |

**Peter's reply, verbatim:** "1. no 2. yes i accept 3. skip this review 4. ok"

How Asimov applied each answer (re-ruling of 2026-10-16, summarised in the build brief):

1. **"no"** means no AI of any kind reads this text, in `off`, `shadow` or `on`: no model second look, and also no contextual-rescue call, because that classifier is an AI. Ambiguous words simply hold. Nothing from the job text may be sent to Anthropic.
2. **"yes i accept"** means a miss is possible and cannot be fully measured, and that phone numbers, e-mail addresses, names, unit numbers and gate or lockbox codes are left alone (not stripped, not screened). Peter did not take the recommendation to strip phone numbers and e-mail addresses. The email's last line says the text is not checked for them.
3. **"skip this review"** means Mason's sign-off is not required for building, deploying with the mode off, or running the shadow week. Jarvis asks Peter once more, with the checklist in front of him, before the feature is switched ON (see "Re-confirmation" below).
4. **"ok"** means 300 characters for the description (and 100 for the title, as ruled).

### Four things the wording does not settle, recorded plainly

These were glossed over in the earlier version of this record. None changes what was built. Each is a reason for a fresh question to Peter at a named point.

- **Question 1 offered two options, and the feature as built is a third.** The question asked for the AI second look, and gave the alternative as "no description at all". What is being built is neither: a local word list with no AI, in which ordinary words such as a paint colour also hold. Peter's answers 2 and 4 (accepting misses, agreeing a length) point to his wanting the description to exist, and that is how the work has been read. But he has not been asked in plain words about the as-built option, its cost, or the fact that its miss rate is not yet known. **Jarvis puts it to him when asking for the shadow yes, and again before ON.** Shadow shows nothing to anyone, so going ahead to it on the present reading is low risk. ON is not.
- **Question 2 speaks of "both checks".** Peter answered it in the same reply in which he said no to the second check. What he accepted is a miss with one layer, the word list. The miss rate was to be measured by the shadow week's human second look; **Peter later declined the shadow week and the faster check (see "Later decisions of 2026-10-16"), so no measured rate will exist before ON.** **He re-confirms at the moment of ON that a miss is acceptable, told in plain words that the rate is unmeasured** and shown the only figures that exist (the testers' probe sets, in the section "Facts from the final reviews", item 7).
- **Question 3, as relayed, does not list what Mason would have checked.** Whether Peter saw the checklist below before or after he said "skip this review" is not known to Asimov. The override stands for building, deploying OFF and the shadow week (CLAUDE.md rule 3). **It is re-confirmed with the checklist in front of him before ON, and Jarvis is asked to show it when asking for the shadow yes.**
- **Question 4 does not contain "about 600".** That figure came from the build brief, not from this question. Peter's "ok" covers the description limit of 300 (and the ruled title limit of 100). **He had not been told the real worst-case length of the block, 733 characters over six lines, when he said "ok".** *(Resolved on 2026-10-16: he was told and replied "accept it"; see "Peter's replies to Jarvis's three questions".)*

### Corrections to the earlier version of this record

- The four questions were paraphrased; they are now verbatim.
- Peter's reply was given as "yes i accept." with a full stop; the reply as relayed now is "1. no 2. yes i accept 3. skip this review 4. ok". The meaning is the same.
- Answer 4 was described as resting on "the whole block under about 600". It did not; see above.

## Later decisions of 2026-10-16 (after the four answers)

These were relayed to Asimov by Jarvis in the task for the third-round final review. Asimov did not see the chat. **Peter's words are quoted exactly as relayed. Jarvis's own words to Peter were not given to Asimov, so what Peter was shown is recorded as Jarvis summarised it.** **Correction made in the fourth-round review: these quotations and summaries are NOT yet confirmed by Peter.** The third-round version of this record said that his "confirmed" would also confirm them. The question Jarvis then put to him described the record as "our four questions and your four answers, word for word", so his "confirmed" (2026-10-16) covers those four only. The quotations below are his own words as Jarvis relayed them, and the summaries of what Jarvis showed him are Jarvis's; **Jarvis puts this section to him again, in the final record, at the moment of ON, and he confirms it or corrects it then.** Until then it stands as relayed, and if any is wrong Asimov corrects the record.

### 1. The Missive copy of the alerts: "yes stop copying them"

Jarvis asked Peter whether the Hub should stop copying Work Order Alert emails into its database (the question this record had listed as undecided). Peter: **"yes stop copying them"**. Jarvis reports that the exclusion (commit `3f6922e`, branch `feature/email-intake-exclude-work-order-alerts`, a separate branch from this feature) is deployed and has been live on the server since about 15:10 local time on 2026-10-16. It has **not yet been seen working on a real alert**: none had arrived when this was written. The check, read-only, on the first real alert sent after that deploy: no new `missive_message_intake` row for it, and the audit event `email_intake.work_order_alert_excluded` present for it. Asimov was not told whether the three consequences and the two costs (staff replies in an alert thread are not archived; the check trusts the sender Missive shows) were repeated to Peter in that message. A yes is the recommended answer and it narrows what is stored, so the answer stands; the two costs are listed for him again in the section "What Peter must still do or hear".

### 2. The shadow week: "no shadow period. ship it and make it work right away"

In the same message Peter said, verbatim as relayed: **"no shadow period. ship it and make it work right away"**.

Jarvis then showed him, in plain words (as relayed, summarised): what the 7-day shadow week would have measured (how often the screen withholds text; whether Latchel really sends the description on new work orders, which has never been confirmed against a live delivery; that the error rate stays at or below 5%; a human spot-check of 20 "shown" descriptions for misses, where Asimov wanted zero; and the Missive exclusion verified on a real alert), and what is at stake if it is skipped (a miss in the first days puts a tenant's sensitive words into the two shared pod inboxes, Missive and the sent folder, from which they can only be cleaned up by hand).

### 3. The faster check: "skip the check"

Jarvis offered a faster alternative to the week: a read-only run of the screen over the roughly 160 real past work orders on the server, reporting counts and ticket numbers only (no text). Peter answered, verbatim as relayed: **"skip the check"**.

### 4. What these overrides are, and are not

Both are owner overrides of Asimov's conditions, made explicitly, in the moment, after Jarvis showed him what the conditions check and what is at stake. Under `CLAUDE.md` rule 3 they stand, and Asimov records them as such. They fall under GOVERNANCE.md Rule 6 (a Critical change normally needs 7 days of shadow mode and attorney review) and Rule 7 (30 or 90 days). **They are overrides. They are not "met", and nobody may later describe the shadow week, the 40-attempt count, the human second look, the hold-rate review or the real-work-order check as having been done.** GOVERNANCE.md says an owner who asks to skip a gate hears Jarvis refuse and explain first; the relay says Jarvis explained and offered a stricter alternative, and does not say whether Jarvis refused first. That is noted, not held against anyone.

| Asimov condition | Status after Peter's overrides |
|---|---|
| 7 consecutive days of shadow on the final version, at least 40 screened attempts | **OVERRIDDEN by the owner. Not met. Never measured.** |
| Zero scanner errors measured over the week; `unavailable` at or below 5% measured | **OVERRIDDEN. Not measured.** The audit rows are written in `on` too, so the same counts can be read from the first live alert (SPEC queries 1 to 4) |
| Hold rate and `common_word_only` share reviewed with Peter before ON | **OVERRIDDEN as a gate.** Recommended after the fact (day 3 and day 7 of live use), not required |
| Human second look at 20 random "shown" jobs, zero misses | **OVERRIDDEN. Not done. There is no measured miss rate.** |
| Live path proven by a synthetic canary over 40 attempts | **OVERRIDDEN in that form.** The start-up self-test and the tests still run; whether Latchel sends a description on new work orders is unconfirmed until the first live alert |
| The faster real-work-order check over about 160 past jobs | **Offered, declined.** Not done |
| Mason's review (attorney review under Rule 6) | **OVERRIDDEN earlier (answer 3).** The checklist is shown again at ON (below) |
| The longer shadow of Rule 7 (30 or 90 days) | **Not applied** (unchanged) |

**What these overrides do NOT remove** (none of these is Asimov's to waive and none was waived by Peter): the build rules that protect his own standing rules and the law (no AI of any kind, nothing from the text stored or logged, **no category names or other protected-class data in any table**, no SSNs, bank accounts or passwords stored, fail closed, internal recipients only, no influence on any decision: Rule 9 and the Fair Housing Standard are never waivable and this feature makes no housing decision); fixes to real defects the testers found; the Missive exclusion **seen working on a real alert** before the interlock is set; Peter saying **"confirmed"** on this record; his sign-off on the sample emails, the word-list diff and the real block length; the Mason checklist and the as-built version put to him again at ON; and his **separate, explicit yes to each of merge, deploy and switching ON**. The full list is in the governance review, Sections 17 and 18 (Section 18 governs where it differs).

## Peter's replies to Jarvis's three questions (2026-10-16, after round 4 was built)

Jarvis put three questions to Peter in chat after the fourth fix round was built and tested. They are given here exactly as Jarvis relayed them to Asimov, with his reply. Asimov did not see the chat.

| # | Jarvis's question, verbatim | Peter's reply, verbatim |
|---|---|---|
| 1 | "Reply "confirmed" on the decision record (our four questions and your four answers, word for word)" | "confirmed" |
| 2 | "Block length: the worst-case size of the new section is 733 characters. A typical alert is about 330. Do you accept that, or do you want a cut, such as a 250-character description? I'd accept it." | "accept it" |
| 3 | "The repo is still public, and the first build commit has a slur written into its history. Asimov says to make the repo private before anything from this branch is pushed. I can deploy to the server without pushing anything, and I will. We'll decide about merging and pushing separately." | "ignore and treat as normal" |

**The whole reply as relayed:** "1 confirmed 2. accept it 3. ignore and treat as normal".

How Asimov applied each reply:

1. **"confirmed" (2026-10-16): the four questions and four answers are confirmed.** The "date confirmed" line at the top is filled in accordingly. **This is narrower than Asimov's earlier condition and the record says so:** the later-decision quotations and summaries (shadow week, faster check, Missive copy) were not in front of him, so they are re-asked at ON (see the correction in the "Later decisions" section). Nothing about the four answers changes: no AI of any kind, a miss is possible and personal details pass through, Mason's review skipped, 300 and 100 characters.
2. **"accept it": the real worst-case block length is accepted.** The figure is **733 characters over six lines at most** (a theoretical ceiling; the testers could reach 723 with the real category labels), **typical about 330, and the "about 600" was a soft target that nothing was cut to meet.** No cut. The acceptance is of the limits as built (title 100, description 300, the fixed last line of 104 characters); **if any of those numbers changes, the question is asked again.** This closes the block-length item in "What Peter has NOT yet decided". It does **not** replace his sign-off on the sample emails or the word-list diff, which he still has not seen on the final commit.
3. **"ignore and treat as normal": the repository caution is accepted by the owner.** This is an owner override of Asimov's condition that the repository be private before any push (O-4). Jarvis surfaced the condition and the stake in the question, and Peter answered it directly, so under `CLAUDE.md` rule 3 it stands. It is not one of the things nobody can waive (Rule 9 and the Fair Housing Standard are not touched; the repository holds no tenant data from this feature, only synthetic test data). Jarvis's mitigation: when the work is merged, Jarvis uses `git merge --squash`, so the merged history carries no slur literal. **What the question did not say, recorded here so his answer is judged on the whole fact:** the squash removes the stray literal from the history of the first build commit, but **the squashed tree itself still contains the screening vocabulary and the list of 81 slur entries, written out in `work-order-text-screen-terms.js`, because the screen needs them to work.** That is the one file where such words are allowed. Pushing to a public repository publishes that file. Asimov's recommendation stays that the repository be private; the override does not change what the files contain. **Nothing needs deciding now:** deploying to the server involves no push. **At the moment of any push or merge to the shared repository, Jarvis tells Peter this one sentence and asks once more; his answer then stands.**

## Peter's decisions of 2026-10-17: the content screen turned off (Option B), "turned on, not off", and his answers to the five questions

**Date:** 2026-10-17 (chat; confirmed against the instruction that carried these words to Asimov, and it is today's date). **Source and limits.** Peter's own words are quoted exactly as Jarvis relayed them. Jarvis's five questions and his explanation of what a block with no screen means were relayed to Asimov as summaries, not word for word; every place where only a summary exists is marked "(summary)". Asimov did not see the chat and relies on Jarvis's relay for what was said and what each answer settled. **Peter has not yet seen this section.** It is put to him with the switch-on question (see "What Peter must still say" below), and he confirms it or corrects it then.

### What was said, in order

1. After Jarvis's recap, Peter said, verbatim: **"yes to merge. i want the tool turned on not off like asimov suggested"**.
2. Jarvis then asked him five fresh questions (summary): (1) are the quotations of his earlier decisions accurate; (2) does he still skip Mason's review; (3) the as-built version put in plain words, with the hold rate; (4) does he accept that a miss is possible; (5) does he sign off the sample emails, the v4 word list and the two side effects. Peter answered, verbatim: **"1,2, 4,5 yes, for 3. i dont want anything held or anything to be told to go back to latchel"**.
3. Jarvis then told him, in plain words (summary), that the hold is the safeguard and that removing it removes the screen entirely; that his earlier "I accept misses" covered the screen's gaps and not having no screen; and what happens with no screen: every word a tenant types is emailed word for word to the two shared pod inboxes, where it stays in those inboxes, in Missive and in the sent folder, and cannot be unsent. The examples he gave, as relayed: "My husband hit me, I need the locks changed", "I'm undocumented", "I use a wheelchair", "I have cancer", a child's name, a gate code. He told Peter that this puts protected information in writing in team inboxes, which can matter in a Fair Housing dispute, and that the decision is Peter's to make. He offered three options: **Option A** (switch on as built, loosen the ordinary-word holds in parallel, and show the title when the description is held; Jarvis's recommendation), **Option B** (no screen at all) and **Option C** (as built); and a read-only count over Peter's roughly 160 real past work orders.
4. Peter answered, verbatim: **"option b. no 160 scan"**.

### How Asimov records each, in order

1. **"yes to merge".** A yes to merging the work as it stood when he said it: the squash of the branch at `c781a1b`, already merged locally into his `reconcile/main-and-sally` as `4b89a11` (not pushed, not deployed). It is **not** a yes to merging the later switch commit (`33c08a3`, or the commit that replaces it after the fixes named in the governance review, Section 19), which did not exist when he said it. His standing rule is a fresh, separate, explicit yes before each of merge and deploy, and the switch is new code. So the switch commit needs its own yes to merge.
2. **"i want the tool turned on not off like asimov suggested".** A clear statement of what he wants: the feature on. Asimov's reviews approved a deploy with the mode off and held ON behind conditions, which is what "off" refers to as I read it. I record it as his decision that the outcome he wants is ON. It is **not** the operational yes to deploy or to switch on: each of those is a fresh yes at its own moment (see "What Peter must still say"). It removes no condition that he did not override by name.
3. **"1, 2, 4, 5 yes".**
   - **(1) The quotations are accurate.** I read this as confirming the quotations and summaries of his later decisions of 2026-10-16 in this record (the Missive copy, the shadow week, the faster check), which his earlier "confirmed" did not cover. The relay does not list which quotations Jarvis put to him; if it was another set, Jarvis tells Asimov and the record is corrected. This closes the caveat in the "Later decisions" section.
   - **(2) Still skip Mason's review.** The override of Mason's review (and with it attorney review under Rule 6) is re-affirmed for the switch-on, which my earlier rulings required as a fresh answer. The relay does not say whether the six items of the Mason checklist were in front of him with this question. They change in meaning with no screen (see "What the checklist means now"), so Jarvis restates them in one short paragraph at the switch-on question. The answer stands under rule 3.
   - **(4) A miss is acceptable.** Said about the screened version, where a miss means a sensitive sentence that the word list failed to hold. Jarvis then told him that with no screen there is nothing to miss with, because everything goes through, and he chose that (Option B). What he has accepted, in the end, is **no content screen at all**, with the never-store mask doing a best-effort job on the numbers that his standing rule covers.
   - **(5) Signed off the sample emails, the v4 word list and the two side effects.** This closes the open sign-off for the **screened** version. It does not cover the sample email of the block with no screen (a different last line, `[removed]` in place of some numbers). Jarvis shows him that one at the switch-on question.
4. **Question 3 (the as-built version): not accepted.** Peter did not say yes to the screened version. He said: "i dont want anything held or anything to be told to go back to latchel". After Jarvis explained what no screen means, he chose Option B. So the as-built version is **not** what is being switched on. Nobody may later describe him as having accepted the as-built version or its hold rate (none was measured).
5. **"option b".** The content screen is turned off. Nothing is held for what a title or description says, for any pod, and an unassigned property's text goes to both pod inboxes like any other. No reader is told to open Latchel because of what the text says. The text is still cleaned so that the email itself is safe (markup, hidden characters, line breaks, the 100 and 300 limits, links replaced, job text never reaching the subject, headers or recipients), and a never-store mask replaces Social Security, card, bank and password strings. He gave this decision **after** Jarvis told him the stakes in the words summarised above and after Jarvis recommended Option A.
6. **"no 160 scan".** The read-only count over the real past work orders is declined, again. It was also the faster check he declined on 2026-10-16 ("skip the check"). Not done, never to be described as done. With no screen it would also have had nothing to count.

### What this is, under CLAUDE.md rule 3

An **owner override**, made explicitly, in the moment, after Jarvis showed Peter what the screen does, what no screen means and what the alternatives were (the review the rule asks Jarvis to surface), and after Jarvis recommended against it. Under rule 3 it stands. It is recorded here as an override of the **content screen itself**, which Asimov's rulings of 2026-10-16 treated as the core safeguard of the block. It is **not** a met condition, and nobody may later write that the block was screened, reviewed by counsel, shadow-tested, measured or checked against the real past work orders. GOVERNANCE.md says that an owner who asks to skip a gate hears Jarvis refuse and explain first; the relay says Jarvis explained, recommended against and offered a safer option, and does not say whether he used the word "refuse". Noted, not held against anyone.

### Owner overrides now in force (never to be described as met)

| What the owner overrode | When | Status |
|---|---|---|
| Mason's review, and with it attorney review (GOVERNANCE.md Rule 6) | 2026-10-16 ("skip this review"); re-affirmed 2026-10-17 ("yes", question 2) | **OVERRIDDEN. Not reviewed by counsel.** |
| The 7-day shadow week and everything measured in it (Rule 6) | 2026-10-16 ("no shadow period. ship it and make it work right away") | **OVERRIDDEN. Not run, no measurement.** |
| The 30 or 90 days of shadow (Rule 7) | never applied | **Not applied.** |
| The faster real-work-order check over about 160 jobs | 2026-10-16 ("skip the check"); 2026-10-17 ("no 160 scan") | **Declined twice. Not done.** |
| Asimov's condition that the repository be private before any push (O-4) | 2026-10-16 ("ignore and treat as normal") | **Accepted by the owner; one-sentence re-ask at any push.** |
| **The content screen itself (the word-list screen, the holds, the fail-closed block)** | **2026-10-17 ("option b")** | **OVERRIDDEN. With the switch at exactly `off`, nothing is screened or held.** |
| The as-built version put to him at ON, and the measured hold rate and miss rate | 2026-10-17 (question 3; "option b") | **Not accepted by him; superseded by Option B. No rate was ever measured.** |

Nothing in this table is a gate that was passed.

### What Peter did not override (no override removes these)

- **Rule 9 and the Fair Housing Standard.** The text only decides what is displayed. It never reaches the recipients, routing, the subject, tasks, priority or anything about a tenant or a unit, and this feature makes no housing decision. Rule 9 is not engaged precisely because the text never enters a decision. **If anyone ever lets this text influence recipients, assignment, priority, an alert rule, or feed any AI, this override does not cover it and Rule 9 applies in full.**
- **No AI of any kind** (his answer 1 of 2026-10-16). Nothing from the text is sent to Anthropic or anywhere else.
- **Nothing from the text stored or logged** in any Hub table, log, subject, header or failure email. The audit row keeps its eleven keys plus the trace; no text, no length, no hash, no category name.
- **No protected-class data and no category names in any table.**
- **Peter's standing rule: no SSNs, bank account numbers or passwords stored.** Kept by the never-store mask, as a **best-effort** replacement, not a guarantee (see the residual list below).
- **Internal recipients only.** The two pod shared inboxes (both, for a property with no pod). Never a tenant, owner or vendor.
- **The limits he accepted:** title 100, description 300, block at most 733 characters over six lines. The last line is exactly as long as the old one or shorter.
- **The Missive exclusion** (the Hub must not store these alert emails or their job text), seen working again on a real alert after the deploy, before the interlock is set.
- **His separate, explicit yes to each of merge (of the switch commit), deploy and switching on.**
- **The tripwire** (below).

### What remains true with no screen, in plain words

- **Every word of a tenant's (or vendor's) title and description goes to both shared pod inboxes, to Missive and to the noreply sent folder, word for word.** That includes health, family, immigration, violence and religion facts, a child's name, a person's name, phone numbers, e-mail addresses and gate or lockbox codes. The Hub does not store it, but the copies exist and **cannot be unsent**. Deleting one is a manual search of those places (and Latchel stays the source of truth).
- **It puts protected information in writing in team inboxes.** If a tenant discloses a disability, a family circumstance, immigration status or an abuse situation in a job description, staff who never opened that job now have it in an inbox. That can matter in a Fair Housing dispute, and **it cuts both ways**: the copies may be evidence that staff were put on notice, and once a dispute or notice exists they may have to be kept, not deleted. So a hand cleanup after a report goes to Mason or counsel first when any complaint, dispute or request is connected (a legal question; Asimov does not answer it).
- **Lawfulness and retention of such copies, and a tenant's access or deletion request (CCPA), were never reviewed by counsel.** A tenant's request would now include a manual search of the two inboxes, Missive and the sent folder for the alerts about that tenant's jobs (the audit rows give job ids). Peter's override of Mason leaves these as **accepted by owner, not reviewed by counsel**.
- **The never-store mask is best effort, and the email says so.** *(Updated 2026-10-17 after the mask-only step, commit `c8e6c71`; governance review, Section 21.)* It blanks the common written forms of an SSN (with or without the word SSN, also when it is written next to a card number), a card number in any grouping (when its digits pass the card check digit, or after a card word) and its security code, a bank account or routing number introduced by its word, a SWIFT code, and a password introduced by its word (in most everyday sentences: "the password is ...", "password to ...", "password will be ...", up to four in a row). It does not catch an account number with no word in front, the last four digits of anything, a card in an unusual grouping written right next to another number, a card with spaced punctuation between its groups, text written right after an IBAN, other words for a secret or a login (wifi key, token, secret, login, access code, a security code), a password with no separator, a fifth password in a row, or a passphrase with no colon; the full list is in the SPEC. It also blanks harmless numbers: about 1 in 10 lists of unit, ticket or serial numbers written with spaces (their digits happen to pass the card check), and more for lists of five or more four-digit numbers (about 18% for five, 27% for six, 41% for eight). The two flaws the testers found at `c205631` (a bare Social Security number beside a card number left partly visible, and a password phrase that swallowed the next keyword) are fixed and re-tested. The email's last line is honest: "Not screened; some links, cards, SSNs, passwords removed" (101 characters), and it says nothing about names, phone numbers, e-mail addresses or gate codes beyond "Not screened".
- **Instruction-like text inside a job description is just text, and it now reaches people and any tool that reads those inboxes.** The Hub's own archive passes are protected by the Missive exclusion, which is why that gate stays. Other tools that read the inboxes are not covered by it. Sentinel's findings S3-2 (job text in the webhook and raw payload fields) and S3-3 (instruction-like text reaching staff and AI readers) are for Jarvis to put to Peter in plain words, from Sentinel's report, before he says yes to switch on.
- **One case still says "see Latchel".** If the text cannot be made safe to print (nested markup that will not settle, a value that is not text; about 1 string in 5,000 hostile strings, practically never for real text), or if the read-only Latchel lookup finds no description, the block is the neutral line "What the work order is: (could not be retrieved, see Latchel)". That is a safety fallback, not a content hold, but Peter said he does not want anything told to go back to Latchel, so Jarvis tells him this one case in a sentence.
- **Nothing was measured and nothing was reviewed before live use.** No shadow week, no count over real past jobs, no counsel, no human second look. The first real blocks are the first test.

### The tripwire and the first-day read

- **Tripwire (required).** Any report that a title or description appeared in an alert and should not have (from staff, a tenant, an owner, anyone) sets `WORK_ORDER_ALERT_DESCRIPTION_MODE` to `off` **the same day** (a one-line change and a Hub restart; the procedure is in the governance review, Section 19.9). With no screen, "should not have been shown" is anything sensitive that appears, so the report is the only detection there is. After that: the already-sent copies are cleaned up by hand only as Peter decides (and, where a complaint or dispute is connected, after Mason or counsel), Asimov is told the same day, and switching back on needs Peter's fresh yes.
- **Day-one human read (recommended, not required).** Peter or a pod lead reads the first 10 to 20 live "What the work order is" blocks on the first day (they arrive in the pod inbox anyway), looking for anything that surprises them. This is the nearest thing to a check that was declined, and it costs a few minutes. Asimov does not make it a gate.
- **Counts (recommended).** Jarvis sends Peter the SPEC's counts at day 3 and day 7 (queries 1 to 5; query 5 is the unscreened rows).

### What the Mason checklist means now (for the switch-on question)

The six items Jarvis showed Peter when he skipped Mason's review, read for a block with no screen: (1) text about eviction or legal proceedings is **shown**, not withheld; (2) text about a criminal record or arrest is **shown**; (3) text about the death of a tenant is **shown**; (4) an English-only keyword layer for Spanish text is **moot**, because there is no keyword layer, and Spanish text is shown like English; (5) whether it is lawful to keep tenant-written text in the pod inboxes and in Missive is **still a legal question for counsel, and larger**, because now it is all the text, not only what the list let through; (6) retention of those copies is **likewise unreviewed and larger**. Peter can send items 5 and 6 to Mason or an attorney at any time; they do not block, by his instruction.

### What Peter must still say (in order)

Peter's messages of 2026-10-17 are **sufficient** as the informed override of the screen, as the fresh Mason answer, as the miss acceptance, as the confirmation of the later-decision quotations, and as the sign-off on the screened samples and word list. They are **not** sufficient as the actions themselves. His "yes to merge" covered the squash that already exists, and "i want the tool turned on" states the goal. His own standing rule asks for a fresh, separate, explicit yes before each of merge, deploy and going live, and switching on is the one step that cannot be taken back (an email cannot be unsent). **So Asimov needs exactly three more words from Peter, each at its own moment, each a plain yes to a one-sentence question that Jarvis asks:**

1. **"Yes, merge"** the switch commit (squash), once the fixed commit exists and has passed its re-tests.
2. **"Yes, deploy"** to the server with the mode off and the switch unset (dormant code; Scotty's checks first).
3. **"Yes, switch on"**, asked after the Missive exclusion has been seen working on a real alert after the deploy, and **together with** these, in plain words, in the same message: the one sample email of the block with no screen, with its final last line; the mask is best effort (one sentence, naming the account number with no word in front, the last four digits of a number, and the lists of unit or ticket numbers that it blanks by mistake; the card grouping gap is closed, see the update after round 5 below); the Mason checklist as it reads above; the one "see Latchel" case; Sentinel's S3-2 and S3-3 in plain words; the tripwire and the optional first-day read; and the confirmation of this section (he confirms it or corrects it). Jarvis writes his answer, the date and the commit hash in the blanks under "Re-confirmation before ON".

### Update after round 5 (commit `c205631`, 2026-10-17): the final list of what Peter must still say, in order, and the sample email he is shown (superseded by the update after round 6, below)

**State.** Round 5 closed the card-grouping gap and made the email's last line honest. The testers then found two flaws that the round itself introduced or left, both in the never-store mask and both small (governance review, Section 20): a bare Social Security number written directly beside a card number can be left partly visible, and a password phrase followed by another keyword leaves the number after it visible. Asimov requires both fixed (a mask-only change), then TARS, Sentinel and Judge re-run. **Nothing is needed from Peter for that step.** If he would rather not wait, he can accept the two flaws by name in his own words; Asimov does not recommend it, because both are flaws with a cheap fix and one is a step backwards from the previous commit.

**What he says, in this order, each at its own moment:**

1. **"Yes, merge"** the switch commits (squash), when Jarvis asks after the fixed commit has passed its re-tests. (His "yes to merge" of 2026-10-17 covered the squash that already exists, `4b89a11`.)
2. **"Yes, deploy"** to the server with the mode off and the switch unset (dormant code). Scotty's checks come first.
3. **He hears, and need not answer:** Scotty's results; the Missive exclusion seen working on the first real alert after the deploy (checked by file hash and by that alert); which of the webhook and the hourly backstop are live (the backstop's first run is a separate decision with its own yes).
4. **"Yes, switch on"**, asked in one message together with all of these in plain words: **(a)** the sample email below; **(b)** the mask is a best effort: it blanks the common written forms of Social Security numbers, card numbers, bank account and routing numbers and passwords, and it does not blank an account number with no word like "account" in front, the last four digits of a number, a password with no colon or "is", or a card with unusual punctuation, and it does not touch names, phone numbers, e-mail addresses or gate codes; **(c)** it also blanks harmless numbers by mistake, about one list in ten of unit, ticket or serial numbers written with spaces, and more for long lists of four-digit numbers; **(d)** the Mason checklist as it reads above, and his fresh answer on skipping Mason (the blank above); **(e)** the one case that still says "see Latchel"; **(f)** Sentinel's S3-2 and S3-3 in plain words; **(g)** the tripwire and the optional first-day read; **(h)** his confirmation or correction of the section "Peter's decisions of 2026-10-17" and of this update. Jarvis writes his answer, the date and the commit hash in the blanks above and in the change note below.

**Not asked again:** the shadow week, the faster check and the 160-job count (declined, recorded as overrides), the as-built version (not accepted, superseded by Option B). **At any push:** the one sentence about the slur list and the vocabulary in the terms file, and his answer then.

**The one sample email he is shown (screen off, as rendered by `test/render-samples-unscreened.js` at `c205631`; synthetic data; nothing sent).** The block in the middle is the new part; the last line is the final wording:

```
To:      solimar-pod@example.test
Subject: Work Order Alert — 123 Test Street Unit A has special handling notes

A new work order was just created for 123 Test Street Unit A (pod: Solimar).

This property has maintenance notes on file:
"Call the owner before any work over $500."

Work order: Ticket #9002 (Latchel job 7002)
Created: 2026-10-01T15:30:00Z

What the work order is:
  Title: Locks
  Category (auto-sorted guess): Locks & Security
  Description: "My husband hit me last night, I need the locks changed. I use a wheelchair and I am undocumented."
  (Quoted from Latchel. Not screened; some links, cards, SSNs, passwords removed. Internal use only.)

View this property: https://hub.test.invalid/property-360?property_id=prop-0001

This inbox is not monitored — see Property 360 above for anything that needs follow-up.
```

And the block of a second sample, which shows what the mask does to numbers (the same renderer, sample "E2"):

```
What the work order is:
  Title: Billing question for units 4521 4522 4523 4524
  Description: "Tenant paid with [removed] last week. The password for the portal is [removed]. Wire via SWIFT: [removed], account [removed] or account 2026-10-17. Ticket 4421-5532-6643-7754."
  (Quoted from Latchel. Not screened; some links, cards, SSNs, passwords removed. Internal use only.)
```

The first sample is the point of the decision: a sensitive sentence from a tenant goes to both shared pod inboxes word for word. Jarvis should show it as it is, without softening, and say that it cannot be unsent.

### Update after round 6 (commit `c8e6c71`, 2026-10-17): the final list of what Peter must still say, in order, and the sample email he is shown

*This replaces the update after round 5 above; where the two differ, this one governs.*

**State.** The mask-only step is done (governance review, Section 21). The two flaws found at `c205631` are fixed: a bare Social Security number written next to a card number (or a list of 4-digit numbers) no longer shows a digit of either, and a password phrase can no longer swallow the keyword of another rule and leave its number visible. A password straight after "to", "now", "be" or "as", and up to four passwords in a row, are masked as well. The step touched only the never-store mask, its tests and the documents; Asimov read the diff to confirm that. TARS passes and Sentinel is clear (no S1, no S2) on the commit, and the whole test suite passes (292 of 292). **What is still open is not review but process and Peter's own words:** Judge's sign-off of the whole change since the version that is live, Scotty's checks and a file-by-file deploy, the Missive exclusion seen working on a real alert, and Peter's separate yeses. **Nothing is needed from Peter for the next step** (Judge's sign-off, and a documentation check of three small findings from Sentinel). If Jarvis quotes figures for the mask, he quotes the SPEC and this section, not the commit message's "0 changed", which refers to Q's own corpus (the SPEC states the 3 of 600 that TARS's older generator changes).

**What he says, in this order, each at its own moment:**

1. **"Yes, merge"** the switch commits (squash), when Jarvis asks after Judge has signed the delta. (His "yes to merge" of 2026-10-17 covered the squash that already exists, `4b89a11`.)
2. **"Yes, deploy"** to the server with the mode off and the switch unset (dormant code). Scotty's checks come first, and the files deployed are exactly the six reviewed ones (sha-256 list in the governance review, 21.8).
3. **He hears, and need not answer:** Scotty's results; the Missive exclusion seen working on the first real alert after the deploy (checked by file hash and by that alert); which of the webhook and the hourly backstop are live (the backstop's first run is a separate decision with its own yes).
4. **"Yes, switch on"**, asked in one message together with all of these in plain words: **(a)** the sample email below; **(b)** the mask is a best effort. *What it blanks:* the common written forms of Social Security numbers (also when written next to a card number), card numbers in any grouping, bank account and routing numbers with a word like "account" or "routing" in front, SWIFT codes, and passwords after the word "password" in most everyday sentences. *What it misses:* an account number with no word in front, the last four digits of any number, a card in an unusual grouping written right next to another number, a card with spaced dashes or commas between its groups, anything written right after an IBAN, other words for a secret or a login (wifi key, token, secret, login, access code, a security code), a password with no colon or "is", a fifth password in a row. It does not touch names, phone numbers, e-mail addresses, gate or lockbox codes, driver's licence, passport or tax numbers; **(c)** it also blanks harmless numbers by mistake: about one list in ten of unit, ticket or serial numbers written with spaces, more for long lists of four-digit numbers (about 18% for five, 41% for eight), and the odd sentence like "password must be 8 characters"; **(d)** the Mason checklist as it reads above, and his fresh answer on skipping Mason (the blank below); **(e)** the one case that still says "see Latchel"; **(f)** Sentinel's S3-2 and S3-3 in plain words; **(g)** the tripwire and the optional first-day read; **(h)** his confirmation or correction of the section "Peter's decisions of 2026-10-17" and of this update. Jarvis writes his answer, the date and the commit hash in the blanks below and in the change note.

**Not asked again:** the shadow week, the faster check and the 160-job count (declined, recorded as overrides), the as-built version (not accepted, superseded by Option B). **At any push:** the one sentence about the slur list and the vocabulary in the terms file, and his answer then.

**The one sample email he is shown (screen off, as rendered by `test/render-samples-unscreened.js` at `c8e6c71`; synthetic data; nothing sent).** The block in the middle is the point of the decision; the last line is the final wording. This is word for word what was rendered at `c205631`, because the round-6 changes do not alter it:

```
To:      solimar-pod@example.test
Subject: Work Order Alert — 123 Test Street Unit A has special handling notes

A new work order was just created for 123 Test Street Unit A (pod: Solimar).

This property has maintenance notes on file:
"Call the owner before any work over $500."

Work order: Ticket #9002 (Latchel job 7002)
Created: 2026-10-01T15:30:00Z

What the work order is:
  Title: Locks
  Category (auto-sorted guess): Locks & Security
  Description: "My husband hit me last night, I need the locks changed. I use a wheelchair and I am undocumented."
  (Quoted from Latchel. Not screened; some links, cards, SSNs, passwords removed. Internal use only.)

View this property: https://hub.test.invalid/property-360?property_id=prop-0001

This inbox is not monitored — see Property 360 above for anything that needs follow-up.
```

The second sample shows what the mask does to numbers (the same renderer, sample "E2"):

```
What the work order is:
  Title: Billing question for units 4521 4522 4523 4524
  Description: "Tenant paid with [removed] last week. The password for the portal is [removed]. Wire via SWIFT: [removed], account [removed] or account 2026-10-17. Ticket 4421-5532-6643-7754."
  (Quoted from Latchel. Not screened; some links, cards, SSNs, passwords removed. Internal use only.)
```

And a third, four lines run through the real cleaner at `c8e6c71`, which show round 6 at work and, on the last line, two of the things the mask misses:

```
Tenant gave 123-45-6789 4111 1111 1111 1111 for the deposit.
   becomes:  Tenant gave [removed] for the deposit.
Changed the password to Rincon2026 and the portal password: Welcome1.
   becomes:  Changed the password to [removed] and the portal password: [removed].
Password reset: tenant account number 123456789012, routing 021000021.
   becomes:  Password reset: tenant account number [removed], routing [removed].
Wifi key: Summer2024. Refund to iban GB82WEST12345698765432 123-45-6789.
   becomes:  Wifi key: Summer2024. Refund to iban [removed]-45-6789.
```

The first sample is the point of the decision: a sensitive sentence from a tenant goes to both shared pod inboxes word for word. Jarvis should show it as it is, without softening, and say that it cannot be unsent.

## What Peter was shown when he skipped Mason's review (the Mason checklist)

As Jarvis surfaced it (CLAUDE.md rule 3: an override must be explicit, in the moment, and made with real information; see the caveat above):

1. Should text about **eviction or legal proceedings** also be withheld? (The earlier screening named none of these.)
2. Should text about a **criminal record or arrest** also be withheld?
3. Should text about the **death of a tenant** also be withheld?
4. Is an **English-only keyword layer** acceptable for **Spanish** text?
5. Is it **lawful to keep tenant-written text** in the pod shared inboxes and in Missive?
6. **Retention** of those copies.

Items 1 to 3 are answered by the word list, which withholds them (including a notice period of any number of days once round 3 is in). Item 4 is answered by mandatory Spanish keywords, accent folding, and a rule that holds text in scripts the lists cannot read. **At the second final review the Spanish list was found to cover less than the English one (in Asimov's small probe, roughly three in four natural Spanish sentences on the usual topics were held against nine in ten in English), and Asimov required the gap to be closed for the vocabulary already held in English (round 3, R3-6). Round 3 closed it on Asimov's probe sets (Spanish 51 of 51, English 72 of 74) and the red team's fresh sets show Spanish within four points of English (80% and 84%); both languages still miss roughly one sensitive sentence in five on fresh sets.** Whether the result is legally *sufficient* was not reviewed by counsel. Items 5 and 6 are legal questions Asimov may not answer. They stay open and are recorded as **accepted by owner, not reviewed by counsel**. Peter can send them to Mason or an attorney at any time; they do not block building.

### Re-confirmation before ON (required)

Before the feature is switched ON, Jarvis shows Peter this checklist again, in plain words, and asks for a fresh yes or no on skipping Mason. The skip stands for building, deploying OFF and the shadow week. It is not a standing waiver for ON. Jarvis records the date and Peter's answer here:

**Date and answer at the moment of switching ON (Mason skip):** **2026-10-17, "yes"** (Peter's answer to Jarvis's question 2, "1,2, 4,5 yes", as relayed): he still skips Mason's review. The relay does not say that the six items above were in front of him with that question, and with no screen they change in meaning ("What the Mason checklist means now", above). **Jarvis restates them at the switch-on question and Peter's answer there is written here:** ______________________ *(blank until then)*

At the same moment Jarvis also asks, and records, Peter's fresh answer to two more questions:

**The as-built version (word list only, no AI, ordinary words hold), put in plain words, together with the costs and the plain statement that no hold rate or miss rate has been measured (the shadow week and the faster check were declined):** **2026-10-17, NOT ACCEPTED, superseded.** For Jarvis's question 3 Peter said: "i dont want anything held or anything to be told to go back to latchel". After Jarvis explained what no screen means he chose "option b". The as-built version is not what is being switched on. Nothing further is needed here.

**Whether a miss is acceptable, with the only figures that exist in front of him (the testers' probe sets, "Facts from the final reviews" item 7) and the plain statement that the real rate is unmeasured:** **2026-10-17, "yes"** (question 4, as relayed), about the screened version; he then chose a block with no screen at all ("option b"), so what he has accepted is no content screen, with the best-effort never-store mask. No rate exists to show him, because nothing was measured.

**His confirmation (or correction) of the quotations and summaries in "Later decisions of 2026-10-16" (the Missive copy, the shadow week, the faster check), which he had not seen when he said "confirmed" on 2026-10-16:** **2026-10-17, "yes"** (question 1, "quotes accurate", as relayed; I read it as this section). The new section above (his decisions of 2026-10-17) he has not yet seen; he confirms or corrects it at the switch-on question: ______________________ *(blank until then)*

**Final commit and list version that was shown to him and is deployed (written by Jarvis at ON):** ______________________ *(blank until then; the reviewed commit is `c8e6c71` (governance review, Section 21): TARS PASS and Sentinel CLEAR on it, after the mask-only fix of the two regressions found in round 5; `33c08a3` and `c205631` each failed a TARS check and neither is it. If any runtime file differs from `c8e6c71`'s by hash, it is a new commit and needs its own re-tests. The `screen_version` string in the audit rows is `unscreened-owner-override`. The word list `protected-class-terms-v2+wo-supp-v4` stays in the code as the screened version and is not what runs with the switch at `off`.)*

### Change note for the moment of switching on (template; Jarvis or Scotty fills it in the same hour, Asimov keeps it)

An edit of the environment file is not an audit-log event, so this note is the record GOVERNANCE.md Rule 6 asks for. It is filled in only when Peter has said "yes, switch on" and Asimov has given the written activation confirmation. **Blank on purpose until then; nothing below has happened.**

```
CHANGE NOTE: Work Order Alert description block switched ON with the content screen OFF (owner override, Option B)

Date and time (local):                  ______________________
Made by (name; relayed by Jarvis/Scotty): ______________________
Peter's yes, in his own words, and the question he was asked: "______________________" / ______________________
Sample email shown to him (date):       ______________________
Commit deployed (hash):                 ______________________
TARS PASS and Sentinel CLEAR on that commit: yes / no ; Judge's delta sign-off (D-2), date: ______________
Sentinel S3-11 to S3-13 checked against the SPEC lists (documentation): yes / no
The six files on the server (five runtime files and the comment-only router.js) equal that commit's by hash (sha-256 list: governance review, 21.8): yes / no   (hashes attached or listed: ____________)
Missive exclusion (U-4): alert id ________ ; no new missive_message_intake row: yes / no ; audit event
  email_intake.work_order_alert_excluded present: yes / no ; exclusion code present in the intake file by hash: yes / no
Webhook and hourly backstop state (U-7):  ______________________  (backstop first-run decision, if any: ________)
Environment file the running Hub reads:   ______________________  (path only; the file is never printed)

The three lines (exact lowercase, no quotes, no spaces):
  WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED   old: ________   new: yes
  WORK_ORDER_ALERT_DESCRIPTION_SCREEN             old: ________   new: off
  WORK_ORDER_ALERT_DESCRIPTION_MODE               old: ________   new: on

Restart (pm2 restart hub --update-env) at: ________ ; process online and health check answered: yes / no
Staged start used (governance review 19.9 step 5a): yes / no
Verification:
  (a) no "interlock is not set" line in the logs: yes / no
  (b) first alert after the restart (job id ________): block present with the final last line: yes / no ;
      SPEC query 5 row: mode on, on_downgraded false, screen_version unscreened-owner-override, eleven keys, no category: yes / no
  (c) Missive exclusion seen again on that alert: yes / no
  (d) first 10 to 20 live blocks read by ________ on ________ ; anything that surprised them: ______________________
Asimov's written activation confirmation (date, commit): ______________________
Emergency stop, if needed: WORK_ORDER_ALERT_DESCRIPTION_MODE=off, then pm2 restart hub --update-env (the screen line is not a stop)
```

## What Peter accepted (answer 2), in plain words

- **A miss is possible and cannot be fully measured.** A word list cannot understand a sentence. Sensitive text can be described without any listed word and would be shown. The shadow week includes a human second look at 20 random jobs to estimate how often; it does not remove the risk.
- **Personal details are not screened.** Tenant names, phone numbers, e-mail addresses, unit numbers, gate codes and lockbox codes typed into a title or description pass through into the email. The email says so in its last line ("Not checked for names, phone numbers or access codes. Internal use only."). He chose not to have phone numbers and e-mail addresses removed.
- **The email is a copy this system cannot control.** It lives in the two pod shared inboxes (Solimar and Faria), in Missive, and in the noreply sent folder. Deleting it later is a manual search of those places (and Latchel stays the source of truth).
- **Classes that the screen does not try to catch, by name (no examples are written here on purpose):** letters of a word split by punctuation or spaces; words typed together with no separator, beyond a short fixed list; digit or symbol substitution; elongated letters and ordinary misspellings; euphemism and indirect reference beyond the short lists; emoji beyond the short list; the long tail of health, family, religion, immigration, legal and death vocabulary beyond the classes added; Social Security, card and account numbers written with unusual separators; uncommon web address endings. They are in Section 9 of the governance review. Whether Peter's "yes i accept" reaches these classes in detail was not asked; they are listed so he can say if any is not acceptable.

## What Peter declined or overrode, precisely

- **The AI second look (answer 1).** Asimov's earlier rulings made an AI check of the text a condition. Peter declined it. Asimov re-ruled (approved with conditions) and replaced it with a local word-list screen and a human second look in the shadow week. As a consequence the ordinary words (white, black, blind, diagnosis, diagnosed, too old, too young for) now simply hold: "paint the walls white" is withheld. That is the cost of having no AI to tell the difference, and Peter has accepted it.
- **Mason's review (answer 3).** Skipped. Valid under CLAUDE.md rule 3. It removes Mason's sign-off. It does not remove the need for evidence that the safeguard works. (Section 5.6 of the governance review listed ten conditions; the owner's later overrides below remove the shadow-week ones among them, Section 17.4.)
- **Attorney review under GOVERNANCE.md Rule 6.** A change to compliance logic is normally expected to have attorney review. By skipping Mason's review the owner has overridden that here. This is recorded, not cured. If a complaint, audit or counsel ever asks whether an attorney reviewed this, the honest answer is no.
- **The 7-day shadow week of GOVERNANCE.md Rule 6, and everything measured in it (later decision 2, 2026-10-16).** Declined: "no shadow period. ship it and make it work right away". **Not applied, not met, and no measurement exists.** If a complaint, audit or counsel ever asks whether the feature was shadow-tested on live data before it went live, the honest answer is no, on the owner's instruction.
- **The faster real-work-order check (later decision 3).** Offered, declined: "skip the check". Not done.
- **Asimov's condition that the repository be private before any push (O-4).** Overridden by the owner on 2026-10-16, "ignore and treat as normal" (see "Peter's replies to Jarvis's three questions"). Accepted risk, not a met condition; the squash merge removes the stray literal from history but not the slur list in the terms file; one-sentence re-ask at the moment of any push.
- **The longer shadow of GOVERNANCE.md Rule 7 (30 or 90 days).** It was **not applied.** This is not a new agent but an optional display block in an alert that is already live and that decides nothing about any person, so Asimov had ruled the 7 days of Rule 6; those 7 days are now also overridden. Peter or counsel may ask for a shadow period at any time; it costs only time. Nobody should later say that any shadow period was met.

## What Peter did NOT override

*Amended 2026-10-17: this list is the position of 2026-10-16, for the screened version. Two bullets change with the owner's switch (marked below); the current list for the version with no screen is in "Peter's decisions of 2026-10-17", above, and governs where it differs.*

- **Rule 9, the no-decisions firewall.** The text only decides what is displayed. It never influences recipients, routing, the subject, tasks, priority or anything about a tenant or unit.
- **Internal recipients only.** The pod shared inboxes, never a tenant, owner or vendor.
- **Fail closed.** Any error withholds the block; the alert still goes out. *(Changed 2026-10-17: with the owner's switch at exactly `off` the content screen no longer holds anything, so there is no content hold to fail closed on. What stays fail-soft: any error while building the block never stops the alert (it goes out in the old format), and text that cannot be made safe to print gets the neutral "could not be retrieved, see Latchel" line.)*
- **Nothing stored in Hub tables or logs.** The only record is a counts-only audit row (job id, property id, a result, a cause, a yes/no, a version and flags). **After round 3 it carries no category names**, because Peter's own rule is that protected-class data is not stored in any table (see "Facts from the final reviews").
- **Peter's own rule:** no SSNs, bank account numbers or passwords stored. The screen also withholds text that looks like an SSN or a card number. *(Changed 2026-10-17: with the switch at `off` there is no screen; the never-store mask replaces such strings with "[removed]" instead of holding the block. It is best effort and says so; see "Peter's decisions of 2026-10-17".)*
- **Fixes to real defects the testers find.** The overrides remove measurement, not repairs. Round 3 left a short list of cheap defects (governance review, Section 17.3); they are fixed and re-tested before ON. *(Done in round 4, commit `c781a1b`, and re-tested: governance review, Section 18.)*
- **The ingestion exclusion:** Peter said yes ("yes stop copying them"). It is reported deployed. **It must be seen working on a real alert before the interlock is set**, and its code must still be on the server after the last deploy of this feature (the two are separate branches).
- **Peter's confirmation of the later-decision quotations** (his "confirmed" of 2026-10-16 covers the four questions and answers only), his **sign-off on the sample emails and the word-list diff** (the block length is accepted, see "Peter's replies to Jarvis's three questions"), and the Mason checklist and the as-built version put to him again at ON.
- **Peter's separate, explicit yes** for each of merge, deploy, and going live (CLAUDE.md "Things I Never Want"). Nothing here, and none of the later decisions, pre-authorises any of them. Changing the setting to `shadow` is no longer planned (he declined the week); if he ever wants it, it needs its own yes.

## What Peter has NOT yet decided

*Amended 2026-10-17: Peter's answers "1,2, 4,5 yes" close the open sign-off on the sample emails, the v4 word list and the two side effects, for the screened version, and the confirmation of the later-decision quotations. The word-list diff and the screened samples matter only if the screen is ever switched back on. Still open: the sample email of the block with no screen (shown at the switch-on question), and the three yes words in "What Peter must still say".*

- **Whether the Missive exclusion is really working.** *Decided; the evidence is now reported.* Peter said "yes stop copying them" (later decision 1). Jarvis verified read-only earlier that 153 of the 160 alerts sent so far (subject starts "Work Order Alert", from the company's noreply address; a domain-level count) were already copied; they predate the description, so they hold none. With the description in the email those copies would hold tenant-written text, searchable by every Archive Search user, and the archive's AI passes are built to send stored text to Anthropic, which would contradict answer 1. The exclusion (`feature/email-intake-exclude-work-order-alerts`, commit `3f6922e`) is live on the server. **Evidence reported by Jarvis for the fourth-round review (Asimov did not see it first-hand; Sentinel and TARS could not reach the server):** the exclusion was deployed about 15:10 local on 2026-10-16 and checked read-only on a real alert, #161, sent at 22:56Z: it was not stored (stored copies stayed at 153) and two audit events `email_intake.work_order_alert_excluded` were written at 23:00:11Z with reason `sender_and_subject`. Asimov accepts that as the gate's evidence, relayed. **Two parts of the gate remain at ON:** its code must **still be on the server after the last deploy of the description feature** (checked by file hash; it is not an ancestor of the description branch, so a whole-Hub deploy from the description branch could silently put the old intake code back), and the first real alert **after** that deploy is seen excluded again. Two costs for him to know: staff replies in an alert thread are also not archived, and the check trusts the sender shown by Missive. (Sentinel checked that sender, recipient and subject of the alert are identical in off, shadow and on, so the exclusion that keys on sender and subject applies unchanged when the description is in the body.)
- **The real worst-case length of the block.** *Decided: accepted.* Peter replied "accept it" on 2026-10-16 (see "Peter's replies to Jarvis's three questions"): **733 characters over six lines at most**, typical about 330, soft target about 600 not met, no cut. Asked again only if a limit changes.
- **The word list.** Version **`wo-supp-v4`** (round 4 added terms, so the label moved from v3 to v4; v2 and v3 were never deployed under any label). Counted by Asimov's own program from the real historical files in git: 911 terms in v1, 1,124 in v2 (+213), 1,455 in v3 (+331), **1,511 in v4 (+56)**; 9, 12, 13 and **16** pair rules (+3 in v4); 0, 10, 14 and 14 groups of symbols; 33 squashed phrases (a rule list, not terms). **0 terms removed or changed at any step**, checked against each of the v1, v2 and v3 files; no pair-rule word removed or narrowed; the 81 slur entries, the 328 everyday-word entries and the language list are identical to v1. The 56 v4 terms are, in plain words: molestation, touching, spanking and injury words (38), the first-person Spanish forms of "no papers" and "no documents" (4), and the Section 8 program's own names such as HQS inspection and HAP contract (14). Adding words is a Standard change that needs his OK; **he has not yet seen the diff** (readable list prepared by Q, shown to him by Jarvis). A plain-English side effect to tell him: "spanking" is held, so "brand spanking new" now withholds the description; the dictionary scan (235,976 words) shows exactly four plain words newly held (molester, molestation, spank, spanking) and none lost.
- **The sample emails.** Twelve rendered states exist for round 4 (Q's `render-samples.js`; Asimov re-ran it and read them, block lengths 61 to 578 characters). He has not seen them. He signs off the ones rendered on the final commit.
- **Whether to delete the 153 existing copies.** Not needed for ON. Any deletion is Peter's separate, explicit decision and must respect the table's retention rules.

## Facts from the final reviews, to put to Peter

These were not part of the four questions. Several bear directly on his answers.

1. **The block is longer than "about 600".** The measured worst case is 733 characters (six lines), mostly because of the fixed last line (104 characters) that says the text was not checked for names, phone numbers or access codes. Typical blocks are far shorter. His "ok" on answer 4 was about the 300 and 100 limits, so he should either accept the real figure or choose a cut.
2. **Round 3 was built (commit `2ab3d53`).** *(Superseded text: this item once said the shadow week would not start on the second build; Peter has since declined the week, see "Later decisions".)* The second round's remaining gaps were fixed in round 3: the audit row no longer carries category names, shared phrases are held whatever punctuation stands where the space belongs, the brand-looking "word.Word" shape holds the block, text the cleaner cannot settle has its own cause, "N day notice" is covered in its written forms, and Spanish and first-person violence wording was added (list version `wo-supp-v3`, additions only). The testers then found a short list of cheap defects that remain; Asimov requires them fixed before ON (governance review, Section 17.3).
3. **The audit row will not carry category names.** Asimov's earlier rulings allowed the audit row to say which kind of word caused a hold (for example a health word, a religion word, a word about children) next to a job id and a property id. That is a record of something about the people at a property, and Peter's rule is that protected-class data is not stored in any table. He was not asked. Asimov has withdrawn the names from the row; it keeps whether the list held the text and a yes/no for "only ordinary words matched". If Peter wants the names for tuning, that is his call to make out loud, and Asimov does not recommend it.
4. **Some ordinary alerts will show only the "open Latchel" sentence.** Colour words, some first names that are also listed words, street names such as Church or Temple, some trade jargon and abbreviation-heavy lines, and some long numbers will hold. The shadow week measures the rate. Peter decides whether it is still worth switching on.
5. **Where this repository lives.** The compliance files and the screening source, including the list of terms, sit in a repository that was **public when last checked (2026-10-16, read-only check)**. One word that the list screens for is also written in the history of the first build commit, `0092ffe`. Peter must make the repository private, or confirm it is, before anything from this branch is pushed. *(On 2026-10-16 he replied "ignore and treat as normal" to Jarvis's question about this: recorded as an owner override with the push-time re-ask, see "Peter's replies to Jarvis's three questions". The squash merge removes the stray literal from history; the terms file keeps the slur list, which the screen needs.)*
6. **What the tests and reviewers found.** The suite passes (160 of 160), the email with the mode off is identical to today's in 576 comparisons against the live code, no AI is loaded and nothing leaves the server, and no job text was found in any log, database write, subject or failure email. The red-team and security reviews found nothing critical and a list of gaps, which is why Asimov's verdict is: deploy with the mode off approved with conditions; shadow not yet; ON blocked.
7. **The only figures that exist for how often a sensitive sentence slips through.** None of them is a real-world rate; there is no measured rate. (a) On the two small sets of natural sentences that Asimov wrote and Q then built against: 72 of 74 English sentences held (97%), 51 of 51 Spanish (100%). (b) On the red team's fresh sets, which nobody tuned against: 67 of 80 English held (84%) and 86 of 107 Spanish held (80%). Read plainly: of sentences that really are about health, family, religion, immigration, legal trouble, violence and the like, the list holds roughly four in five to nine in ten, and the rest are shown. How many real work orders contain such sentences is unknown; most contain none. In a neutral frame the single-word long tail was held 246 of 344 times (about 7 in 10). The shadow week and the faster check would have measured the real mix; Peter declined both.
8. **The tripwire is now the main safety net.** After ON, any report of a title or description in an alert that should have been held sets the mode back to `off` the same day (a one-line change and a Hub restart), the list is extended, and the copies are cleaned up by hand in the pod inboxes, Missive and the sent folder. That works only if somebody reads the alerts. Asimov recommends, and does not require, that Peter or a pod lead read the first 10 to 20 live "What the work order is" blocks on the first day.

9. **Round 4 was built (commit `c781a1b`, word list `wo-supp-v4`) and re-tested.** What it fixed, in plain words: a symbol such as the trademark or numero sign typed where a space belongs can no longer hide a protected phrase (Asimov's own sweep of 639,864 variants found none that slip, apart from circled and boxed single letters, which are letters and are left alone on purpose); a web-like word in front of an at-sign is replaced unless a real address follows; a web address followed by a superscript, a fraction or an accented letter is replaced; the third-round list is pinned by a test so that deleting a word fails it; and violence done to a named person ("hits his wife", English and Spanish), the first-person Spanish forms ("soy de Mexico", "no tengo papeles") and the Section 8 program's own names were added. Tests: 209 of 209 pass, 167 of 167 deliberate breakages are caught, the email with the mode off is byte-identical to today's in 3,784 comparisons (TARS), no AI is loaded. **What it did not fix, to put to Peter plainly:** violence written with the victim first and a passive verb (in the red team's set 6 of 14 such forms still pass and 8 are held; the class is named here and not an example, because the repository is public), the long tail of vocabulary, and the other classes named in Section 9 of the governance review; and these side effects: "brand spanking new" now holds, two Southern California place names (Costa Mesa, La Cañada) hold after "soy de" or "vengo de", and a Spanish word that begins with a web ending and continues with an accented letter, typed with no space after a full stop, reads as a cut web address ("[link removed]" plus the rest). None of this changes the four answers.

## What Peter must still do or hear (in order)

*Superseded in part 2026-10-17: the list in "Peter's decisions of 2026-10-17" (section "What Peter must still say") is the current one. Items 1 and 4 below are answered for the screened version (the sign-off and the fresh answers), and item 4's "as-built version" was not accepted by him (superseded by Option B).*

*Updated after the fourth fix round. Done already, on 2026-10-16: "confirmed" (the four questions and answers), "accept it" (the 733-character worst case), "ignore and treat as normal" (the repository caution, with the one-sentence re-ask at push time), and round 4 itself (built, re-tested, no step needed from him).*

1. See and sign off, on the final commit: the **12 sample emails** and the **word-list diff** (v1 to v2 to v3 to v4; the v4 delta is 56 terms and 3 rules, additions only, as the readable list Q prepared and Jarvis shows him, with the plain-English side effect that "spanking" is now held). Jarvis shows him both; this is a sign-off, not a new question about the length, which he has accepted.
2. Say yes to **merge** (Jarvis uses `git merge --squash`), then a separate yes to **deploy with the mode off** (the Missive exclusion branch is merged first or together; Scotty's checks first). Before any **push**, Jarvis tells him in one sentence that the pushed tree holds the slur list and the whole screening vocabulary in the terms file, and he answers again.
3. Hear the result of Scotty's checks and, after the deploy, the **second real-alert check** of the Missive exclusion (Jarvis reports; nothing for Peter to do). The first check was reported done on alert #161.
4. At the moment of ON: see the **Mason checklist** again and answer fresh; hear the **as-built version** in plain words (a word list, no AI, ordinary words hold, **no measured hold rate or miss rate**, the figures in item 7 above) and answer fresh; say again whether **a miss is acceptable**; **confirm or correct the later-decision quotations** (the shadow week, the faster check and the Missive copy, as recorded above); and give a separate **yes to switch ON**. Jarvis records each answer and the date in the blank lines above.
5. Know: the audit rows carry no category names; the two costs of the Missive exclusion; some ordinary alerts will show only the "open Latchel" sentence; the feature is a list with no AI; attorney review and every shadow period were skipped on his instruction; the known misses include violence written with the victim first and a passive verb, and the long tail of vocabulary; and the optional first-day read of the live blocks (item 8 above).

## Counts from the shadow week: NOT RUN (declined by the owner). Kept for any after-the-fact review of live use (counts only, never the text)

| Item | Count |
|---|---|
| Jobs the screen let through that were opened in Latchel and read | |
| Of those, jobs that should have been held (misses) | |
| Of those, jobs with non-English text | |
| Screen version these counts belong to | |

## Related decisions

- `compliance/work-order-note-alerts-mason-override-decision-resolution.md` (2026-09-21): Peter's earlier override of Mason's review for the maintenance-notes text in this same alert.
- `compliance/work-order-note-alerts-content-check-removal-decision-resolution.md` (2026-09-21): Peter's removal of the content check on those notes. That removal covers the maintenance notes only. It is not extended to the job title and description, which have their own screen.

## What this means for the build

The build is done to Asimov's re-ruling and is OFF by default. Asimov's fourth final review (governance review, Section 18, commit `c781a1b`): deploy with the mode off **approved with conditions**; switch ON **approved with conditions** (no governance objection to the code or design; the activation confirmation is withheld until the gates in Section 18.5 are true). The shadow week is not a step: Peter declined it and the faster check, and that is recorded as an owner override, never as met. Round 4 is built and re-tested (TARS pass, Sentinel no S1 or S2, Viper none critical or high, Ralph resilient; Judge's sign-off on the final commit is outstanding). Done by Peter: "confirmed" (four questions and answers), "accept it" (733 characters), "ignore and treat as normal" (repository, with the push-time re-ask). The next steps, each needing Peter's separate yes where noted: Judge's sign-off and Scotty's checks; Peter's sign-off on the sample emails and the word-list diff; merge (Peter's yes, squash) in an order that keeps the Missive exclusion on the server; deploy of the feature OFF (Peter's yes); the Missive exclusion seen again on the first alert after the deploy, with its code confirmed by hash; Mason's checklist shown again with a fresh answer, together with the as-built version, the acceptance of misses and the later-decision quotations; Asimov's activation confirmation; Peter's final yes to switch ON; then the tripwire and the day-3 and day-7 look at the live counts.

**Update, 2026-10-17.** Peter chose Option B: the content screen is off, by an owner switch (`WORK_ORDER_ALERT_DESCRIPTION_SCREEN`, exactly `off`), recorded above as an owner override and never as a met condition. The build (commit `33c08a3`) does what he chose, and keeps every standing rule that no override removes (governance review, Section 19), but it **fails one tester check on the never-store mask and its last line claims more than the mask delivers**; both are conditions to fix and re-test before switch-on. Deploying the dormant code (mode off, switch unset) and switching on each need his separate, explicit yes, plus the Missive exclusion seen working on a real alert after the deploy and Asimov's written activation confirmation. The tripwire and the exact switch-on and emergency switch-off steps are in the governance review, Section 19.

**Update 2, 2026-10-17 (round 5, commit `c205631`).** Round 5 closed the card-grouping gap and made the email's last line honest ("Not screened; some links, cards, SSNs, passwords removed", 101 characters; the 733-character worst case Peter accepted is now 730 with the screen off). The testers found two small flaws in the never-store mask that round 5 introduced or left, so **`c205631` is not the commit to deploy**: Asimov requires a mask-only fix, then TARS, Sentinel and Judge re-run (governance review, Section 20). Every owner override above still stands and is still not a met condition. Peter's three words and the sample email he is shown are in "Update after round 5", above; the change note for the moment of switching on is the template above.

**Update 3, 2026-10-17 (the mask-only step, commit `c8e6c71`).** The two mask flaws found at `c205631` are fixed (a bare SSN beside a card number; a password phrase that swallowed the next keyword), a password after "to", "now", "be" or "as" and up to four passwords in a row are masked, and Asimov confirmed that the step stayed inside the mask, its tests and the documents. TARS passes and Sentinel is clear on `c8e6c71`. Judge's delta sign-off, Scotty's checks and Peter's separate yeses are still to come; the activation confirmation is not given (governance review, Section 21). Every owner override above still stands and is still not a met condition. The final list of what Peter says and the sample emails are in "Update after round 6", above; the change note for the moment of switching on is the template above.
