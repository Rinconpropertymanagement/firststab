# Complaint Tracking "Close old items" (bulk close): Decision Record, including Peter's owner override of the legal-exposure hold-back and the staged first close

**Date of Peter's decisions:** 2026-10-21 and 2026-10-22
**Recorded by:** Asimov (governance), from Peter's words as Jarvis relayed them, word for word. Asimov did not see the chat itself and relies on Jarvis's relay for the wording and for what Peter was shown.
**Branch:** `feature/bulk-close-old-complaints` (local only; not pushed, not merged, not deployed). Code reviewed at `1c748c9` (Q: contract tests and server hardening) on `a7a95ed` (Tron: the page reads the server's real answers); see section 14.
**Status:** Recorded, and brought up to date on 2026-10-22 after the page-and-contract round. **Peter has not yet confirmed this record.** It is put to him in plain words at the moment of his deploy yes (see sections 8 and 9). Until then, the quotations below are the relay's, not his confirmation of this document.
**Companion document:** `compliance/complaint-tracking-bulk-close-governance-review.md` (Asimov's rulings, the status of every condition, and the code evidence).

---

## 1. What this feature is, in one paragraph

Peter's open Needs-a-Call and Flagged-for-Review list has about 1,151 items, most of them old. This build adds a panel, "Close old items", that previews and then closes open items whose most recent email is older than a cutoff (90 days by default), in one batch of at most 2,000, after one confirmation that shows the exact count. Each closed item is marked Resolved with a note saying "Closed in bulk: no email activity for over N days", with the batch id and who approved it. Every batch can be undone. Nothing is deleted. Nothing is sent to anyone. No AI is involved. It makes no decision about any tenant or applicant.

## 2. Peter's decisions, word for word

| When | What prompted it | Peter's words, verbatim as relayed |
|---|---|---|
| 2026-10-21 | The request | "i need a better way to clear this backlog of complaints. most of them are old and already resolved. one by one is going to take days and we dont have that" |
| 2026-10-21 | Jarvis's plan: close items quiet for N days, hold back urgent ones | "90 days, hold back the urgent ones" |
| 2026-10-22 | Jarvis showed him the real numbers and the stakes (section 3) and recommended holding back the legal-exposure items and a staged first close at 1 year | "no to the recomednations.  i need this tool to be viable and in its current state of how many complaints there are in there it isnt.  i need to dratically cut down on the numbers.  i want to overide the recommendations" |

(The spelling and the doubled spaces are Peter's, kept as relayed.)

## 3. What Peter was shown before the third message

As relayed by Jarvis to Asimov. Asimov did not see the screen or the chat.

- **The real numbers:** 1,151 open Needs-a-Call and Flagged items. About 626 would close at 90 days under the original rule (Fair Housing items and, by default, urgent items held back). About 309 would close if Asimov's wider hold-back were applied, because 314 of the otherwise-eligible items are tagged legal exposure. (626 minus 309 is about 317, so by subtraction roughly 3 more are items where an owner's instruction was rejected and which are not tagged legal exposure. That split is an inference from rounded figures; the preview on the live data is the authoritative count.)
- **The stakes of closing legal-exposure items without a person looking:** a demand letter or an attorney notice could sit unseen in a closed item, and a deadline could be missed.
- **Jarvis's recommendation:** hold the legal-exposure items back and have a person (Stephen) skim them; and make the first real close a small one (1 year).

Peter said no to those recommendations and gave his reason: at the current size of the backlog the tool is not viable unless it cuts the numbers drastically.

## 4. What the override is

This is an **explicit owner override, made in the moment, after being shown what the review checks and what is at stake** (`CLAUDE.md`, Governance and Compliance, rule 3). It stands. Asimov records it here and in the review. **It is an override. It is not "met", and nobody may later describe these conditions as met, passed, cleared, satisfied or done.**

| Asimov item | Status after Peter's override |
|---|---|
| Condition 1: widen the hold-back so that items tagged legal exposure, and items where an owner's instruction was rejected ("true" or "uncertain"), are always kept open | **OVERRIDDEN by the owner. Not met.** The server instead has an opt-in box, "Also hold back items tagged legal exposure or with a rejected owner instruction", **unticked by default** (`hold_back_legal`, default false). Peter can still tick it with one click. |
| The recommendation to hold the legal-exposure items back and have a person skim them | **OVERRIDDEN. Not done.** |
| Condition 5: the first live close is small (for example 365 days), checked, undone once to prove Undo, and only then the 90-day close | **OVERRIDDEN. Not met.** Peter is not required to run a staged first batch. The first real close is the live trial. |
| "Any later loosening of the legal and Fair Housing list needs Mason first" (a line in condition 1) | **Not applied.** Mason was not asked about the loosened default, and Peter's relayed words do not mention Mason. This is recorded as a fact, not as a waiver. See section 7. |

The Fair Housing Standard and Rules 9 and 2 of `GOVERNANCE.md` are not waivable by anyone and were not touched by this override (section 5).

**The factual basis Peter gave.** He said the items are "old and already resolved". The tool cannot know that. It can only see that no email has arrived on the thread for N days. It writes "no email activity for over N days", never "fixed". Quiet does not mean resolved: a tenant may stop writing without the problem being solved, and an old legal notice may have been dealt with elsewhere or may not. Peter's knowledge of his own backlog is the basis for closing on silence alone, and this record treats it as his judgment, not as something the system verified.

## 5. What the override leaves true (still in force, verified in the code at commit 1c748c9)

- **Fair Housing and protected-class items are never closed, whatever anyone sends.** An item is kept open if it has `flagged_protected_class`, any `flagged_category`, or category `accommodation_related`; items held for legal and Fair Housing (`held_legal_fair_housing`) and merged items are never read. No setting, box or request key can change this (only named settings are read, and the tests send extra keys such as `hold_back_fair_housing: false` and show they are ignored). The write itself repeats these guards. The page says exactly this: "Items flagged for Fair Housing or marked as accommodation requests are always kept open."
- **Urgent items are held back by default** (a box, ticked, that Peter can untick; the page warns when it is off). This was Peter's own first instruction ("hold back the urgent ones"). "Urgent" means rated urgent. See the fourth plain-words point in section 8 (the unrated group has no effect on today's data).
- **Items stay open** when the last email is within the cutoff, when the item was typed in by a person, when a person worked on it in the last 30 days or it is handed to someone, when it is waiting on someone, when a duplicate suggestion is waiting for a decision, when the age cannot be worked out, and when it **already carries a note** (the tool never overwrites a note).
- **A record is written first.** Before any item is changed, a "started" audit row is saved with the settings, the counts and the code of the exact set that was approved. If it cannot be saved, nothing is changed. Then one row per closed item, then an end row. A batch that stops halfway is still listed (as "Unfinished") with a working Undo. A row that was saved while its answer was lost is not written a second time.
- **Every batch can be undone**, including a batch that stopped halfway. Undo reopens only items still carrying that batch's exact tag. After Undo, the same items can be closed again (the tool's own rows are not counted as "a person worked on it"). **If an Undo only partly works, the screen says so** ("Reopened N items. M items could not be reopened and are still closed. Press Undo again to finish."), says "This batch is only partly undone", and keeps an Undo button. It never says "This batch was undone" unless every item was put back.
- **The screen tells the truth about a close that went wrong.** If the record of a close cannot be saved, the screen shows the server's own sentence ("nothing was changed"). A batch that stopped partway is listed as "Unfinished batch started on ...", not as "Closed N items". A close that stopped early says so. The legal-group wording names the whole group everywhere. All of this is checked by an automated test that feeds the page the server's real answers, so a mismatch fails a test before it reaches Peter.
- **Nothing is deleted.** Close changes only `status` and `resolution_note`, and only when the note was empty, so Undo restores the exact prior state.
- **No message goes to anyone, no AI is used, no schema change.**
- **A person decides.** Nothing runs by itself and nothing is scheduled. A person previews, then confirms the exact count and the exact set (a fingerprint of the previewed items); a stale preview is refused. Only the admin and director_of_operations roles can reach the panel.
- **The legal-exposure count is shown before he closes.** The preview and the confirm screen say how many of the items to be closed are tagged legal exposure, and tell him how to keep them open.

## 6. What the override changes

- **Items tagged legal exposure, and items where an owner's instruction was rejected, are now closed along with the rest if they are old and quiet** and the box is left unticked. About 314 items are tagged legal exposure in the figures Peter was shown. They are moved out of the Needs-a-Call and Flagged lanes into Resolved, with the bulk note, without a person reading them first.
- **A demand letter, an attorney notice or a deadline sitting in an old thread of that kind will not be in front of anyone.** The email itself is still in Missive and the closed item can be found and reopened. Nothing is lost. But it will not be in the queue unless someone looks.
- **Mason's 2026-10-02 safety floor** (which stops the database from marking those same groups "no issue") is a different action from this one (this tool changes status, not the severity tier), so no database rule is broken. The floor expressed a view that these groups should not be quietly dismissed. The override accepts that exposure for this tool.
- **The first real close is the live trial.** The audit rows go in 80 at a time, which has never been done in this system; it has been tested only against stand-ins (see section 9 for what is unproven).

## 7. Mason

Mason (Fair Housing and legal) has not reviewed the loosened default, and was not asked. `CLAUDE.md` requires Mason for tenant-facing builds and housing decisions; this is an internal queue clean-up that does neither, so Mason is not a gate here. Peter's relayed words override Asimov's recommendations; they do not mention Mason, so this record does **not** say he waived Mason. A one-line read from Mason on the legal-exposure group is **optional**, and Peter may decline it. If asked, the question is: "Does closing complaints tagged legal exposure on inactivity alone, with a note and an undo, create exposure that leaving them open does not (for example a missed deadline on a notice that arrived in an old thread)?" That is a legal question and Asimov does not answer it.

## 8. The plain-words points Peter must hear before the first real close

Jarvis tells Peter these, in these words or close to them, before the first real close, and writes the date on the "Date Jarvis told Peter" line at the end of this record. They are the substance of Asimov's condition 7 and of the page fix A5. The page does not carry the second point, so chat is where he hears it.

1. **Quiet does not mean fixed.** The tool closes on silence alone. It cannot tell "the tenant stopped writing because it was fixed" from "the tenant gave up". The note it writes says "no email activity", never "resolved" or "fixed". Your judgment that these are old and already resolved is the basis; the tool does not check it.
2. **If someone emails again on a thread you closed, Complaint Tracking will not notice.** It will not make a new complaint and will not reopen the old one. You would see that email only in Missive. This is already true for open items today, but an open item at least stays on your list and a closed one does not. This now also applies to the legal-exposure threads, where a late reply is the thing that matters most. (The Fair Housing and legal screening pass reads new mail on a thread independently of complaint status, according to its own header comment. Asimov did not verify what is scheduled on the server.) If you want new email to reopen closed items, that is a separate build and needs its own governance review.
3. **The legal-exposure items, and the few where an owner's instruction was turned down, will close without anyone reading them.** On today's figures that is about 314 to 317 of the roughly 626 that would close at 90 days. A demand letter or attorney notice sitting in one of those threads will not be in front of anyone, though the email is still in Missive and every closed item can be reopened. The preview shows the number before you confirm, and one tick ("Also hold back items tagged legal exposure or with a rejected owner instruction") keeps them open. Fair Housing and accommodation items are never closed.
4. **The unrated group, today: no effect.** "Urgent" means rated urgent. An item marked as needing a person's call but never given a rating would not be held back by the urgent box, and the preview does not count such items. On today's live data (as relayed to Asimov on 2026-10-22; Asimov did not run the query) all 626 items that would close carry the rating "worth a look" and none is unrated, so this changes nothing for the first batch. If the real close happens on a later day or at a different number of days, Jarvis repeats a read-only check first. It stays recorded as disclosed and not decided.
5. **The first close is the live trial, so watch it.** After it, look at Recent batches: the batch should be listed with the right count and an Undo button, and the screen should show no warning ("record not fully saved", "stopped early", "unfinished", "only partly undone"). If any warning appears, stop and tell Jarvis before closing another batch. If the preview shows a number far from about 626, do not press Close until Jarvis has explained the difference.
6. **Undo is the safety net and it tells you the truth.** If an Undo only partly works, the screen says how many items are still closed and keeps an Undo button; press it again. The first real Undo, if you ever use it, should be done while a person watches the numbers. After an Undo the same items can be closed again right away.

## 9. Conditions before this can be deployed

None of these is waived by the override.

1. **Page fixes: DONE for A1 to A4, verified in the code at `1c748c9`** (a partly failed Undo is a warning and keeps its button; an unfinished batch is not shown as "Closed N items"; the server's plain "nothing was changed" sentence is shown; the legal wording names both groups everywhere). **A5 (the later-email line) is satisfied only by Jarvis telling Peter in chat (point 2 above) and writing the date below.** Full detail is in section 7 of the governance review.
2. **Re-verification: DONE** (TARS PASS; Sentinel round 3 CLEAR with no S1 or S2; Asimov's own run of all four suites, 224, 441, 13 and 292, and 25 spot-mutants all caught). **Still to come: Judge's final review issues the exact deploy command and the expected hashes of the four runtime files** (any edit to those files changes the hashes and voids the earlier ones; Asimov re-checks the changed hunks). Recommended in the same pipeline, test-only: tests for the page rules that TARS's mutants showed are not yet pinned (above all, Undo stays available when the still-closed count is unknown).
3. **Peter's separate, explicit yes to each of commit, push, merge and deploy.** One yes does not carry to the next, and none is inferred from this record or from the override.
4. **Before any push, check that the GitHub repository is private.** It was noted as public on 2026-10-04, and `compliance/` holds legal and governance records, including this one, which quotes Peter's decision word for word. Never commit the untracked `projects/hub/node_modules` symlink; stage by explicit path.
5. **Peter hears section 8**, and his deploy yes is taken as his confirmation of this record. Jarvis writes the dates into the two lines at the end of this record.
6. **After deploy and before closing anything:** Judge's read-only check (the panel loads, the rest of the dashboard is unchanged, Preview at 90 days with the urgent box ticked and the legal box unticked shows about 626 items, about 314 to 317 of them in the legal group). Do not press Close until any difference is explained.
7. The unproven items in section 10 are known and accepted for the first live run.

## 10. What is unproven

- The audit rows go in 80 at a time through the audit log's hash-chain trigger. This is believed to chain correctly from PostgreSQL's documented behaviour, and the code falls back to one row at a time if the group insert is refused, but that has been shown only against stand-ins, never against the real database.
- Repeated filters on the close update (up to five `or` conditions together when both hold-back boxes are ticked) and the exact quoting of one filter have been checked against a stand-in that reads the real request format, not against a real PostgREST. If they misbehave, the likeliest outcome is a refused request: a group stays open and the done screen says so. The Fair Housing flag and category guards on the update are plain filters, and the read-time Fair Housing skip is the first line.
- The "last email" date comes from Rincon's stored copy of the shared-inbox threads. If the Missive sync had stalled, a live thread could look older than it is. At a 90-day cutoff this needs a very long stall.
- "Recently worked on by a person" looks at the newest audit row per item, so a later automatic row can hide an earlier person's action inside the 30 days.
- The close update does not repeat two of the read-time rules (the lane an item sits in, and the 30-day "a person worked on it" test); the `updated_at` fence stands in for them. It now cannot be widened by one future-dated item.
- Everything above fails safe: a failed start row changes nothing; a refused group stays open; failed audit rows give a loud warning, the batch is still listed, and Undo works.

## 11. What Peter does not have to do

- He does **not** have to run a small staged first batch (the 1-year trial) first. He declined it and that stands.
- He does not have to ask Mason.
- There is no shadow week: this is a person's click, not a runtime agent. `GOVERNANCE.md` Rules 6 and 7 are not applied for that reason, which is Asimov's earlier ruling and is unchanged.

## 12. What Asimov recommends he looks at after the first real close

The first two are part of the live-trial condition (point 5 in section 8); the rest are optional.

1. **Recent batches** in the panel: the new batch is listed, with the right count, who closed it, the settings, a working Undo button, and no warning on the screen. If a warning appears, stop and tell Jarvis before closing another batch.
2. **The audit rows**: Jarvis gives Peter a read-only query for the Supabase SQL Editor (it is in the governance review) that shows one "started" row, one row per closed item, and one end row for the batch id. The start row also carries the code of the exact set that was approved.
3. **One Undo test if he wishes**: press Undo on that batch, with a person watching the numbers, check that the items come back to Open, then close again with the same settings. This works without a 30-day wait.
4. A quick look at a few of the closed legal-exposure items, in the Resolved list, if he wants a feel for what was closed. Optional.

## 13. Notes

- **Integrity Rule 5** of `GOVERNANCE.md`: if the owner asks to skip a gate, Jarvis must explain and refuse first, and the owner can override after hearing the refusal. The relay says Jarvis showed Peter the numbers, the stakes and a recommendation. It does not say whether Jarvis refused first. That is noted, not held against anyone. The override is valid under `CLAUDE.md` rule 3 as written: explicit, in the moment, after being shown what the review checks and what is at stake, and about a condition Asimov set (not a never-waivable rule).
- **What was not overridden:** Rule 9, the Fair Housing Standard, and the audit trail. These are not Asimov's or Peter's to waive for this tool and are in force.

## 14. The commits this record covers

| Commit | What | Who |
|---|---|---|
| `594ffad`, `c00018d`, `a7a95ed` | The "Close old items" panel (`dashboard/index.html`), its fix round, and the round in which it was made to read the server's real answers (partly failed Undo, batch states, plain 500 sentence, whole-group legal wording) | Tron |
| `846f510`, `3c29749`, `1c748c9` | The server (`lib/bulk-close.js`, `lib/last-touched.js`, `router.js`), its fix round, and this round's contract tests and hardening (update-time guards, set code in the start row, lock timeout from last progress, short cache on Recent batches, `stopped_early`, no duplicate audit rows) | Q |
| `dfb4b17` and the commit after `1c748c9` | These two compliance documents (first version, then this update) | Asimov |

Based on `8c9da8b` (what is live). The code Asimov reviewed is `1c748c9`; the commit after it changes only the two documents in `compliance/`. Local only: nothing is pushed, merged or deployed. The four runtime files that would differ from the live server are `dashboard/index.html`, `lib/bulk-close.js`, `lib/last-touched.js` and `router.js` (all under `projects/hub/complaint-tracking/`); their git blob ids at `1c748c9` are in the governance review, section 13. Judge issues the deploy hashes.

**Date Jarvis told Peter the points in section 8:** *not yet (to be entered by Jarvis, with whether it was said in chat or shown on the screen).*

**Date Peter confirmed this record:** *not yet confirmed (to be entered by Jarvis from Peter's deploy yes, as relayed).*
