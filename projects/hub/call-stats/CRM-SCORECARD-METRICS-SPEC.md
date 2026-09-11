# CRM Scorecard Metrics — Booking Rate, Follow-Up Completion, Re-Engagement, Past-Lead Conversion

**Status:** Draft — spec only. No code, no migration. **Booking rate is settled (approved 2026-09-11).** One item remains genuinely open and Peter has explicitly deferred it (past-lead conversion denominator). The credential blocker is gone.
**Written by:** Oracle
**Date:** 2026-09-10. **Revised 2026-09-11** — follow-up completion rebuilt on workflow-sourced tasks; Open Item 22 closed; booking rate marked settled.
**Origin:** Peter approved this direction on 2026-09-10 — automate the four scorecard lines that run on HubSpot deals, tasks and meetings rather than on Aircall calls. All four are Kristen Rau's, reviewed weekly.

---

### Revision note — 2026-09-11

Three things changed since the 2026-09-10 draft, and one thing I got wrong.

**Resolved: the credential blocker (Open Item 22).** Peter added scopes on 2026-09-11. Verified directly against the tool's own `HUBSPOT_PRIVATE_APP_TOKEN` — not the broader session connector this document originally used. Contacts, leads, deals, tasks, meetings, `/automation/v3/workflows` and `/automation/v4/flows` all return **200**. Only sequences is refused (`/automation/v2/sequences` → 404), which costs nothing: sequence-created *tasks* were always the route, and they remain readable.

**Settled: booking rate.** Peter approved Design Decision 27 on 2026-09-11 as written. No longer an open item.

**Deferred by Peter: the past-lead conversion denominator.** His words were "needs more research/discussion." Open Item 24 stays open deliberately. I have added the second measured figure he asked for and made no recommendation.

**Corrected: the shape of the follow-up problem.** The 2026-09-10 draft concluded that a completion rate over *all* Kristen's tasks is 100% by construction, and proposed a touch count instead. **That conclusion survives, and the proposed replacement mostly survives — but two of the supporting facts in it were wrong**, and the reasoning underneath the replacement was wrong in a way that mattered:

- "Zero overdue, ever" is no longer true. Re-measured 2026-09-11: **5 overdue** of 2,535. Still 0.2%, so the argument holds — but the word "zero" should not be repeated.
- The draft deferred the reschedule count because "HubSpot does not expose a task's original due date." HubSpot *does* expose `hs_task_missed_due_date` and `hs_task_missed_due_date_count`. **That looked like it unblocked Open Item 26. It does not** — see Design Decision 29, which now explains why on measured grounds rather than on the wrong ones.
- Most importantly: the touch count the draft proposed as a *quality* measure runs **backwards**. More touches correlates with a worse outcome, measured. Design Decision 29 is rebuilt around that.

Everything else in this document stands unchanged.

**Where this file lives vs. where the build lives.** This document sits in `projects/hub/call-stats/` because that is where its sibling specs are and where the conversation has been happening. **It recommends that the build does not live there** — see Design Decision 35. If Peter accepts that recommendation, this file moves to `projects/hub/scorecard/` with the build.

**Built from:**
- `projects/hub/call-stats/SALES-VS-OPERATIONAL-CLASSIFICATION-SPEC.md` in full — its HubSpot findings, its snapshot-never-recompute reasoning (Design Decision 22), its store-nothing-about-outside-people boundary (Design Decision 23), its honest-label rule (Design Decision 24), its measure-before-building gate (Design Decision 25), and its governance derivation. Design Decision numbering and Open Item numbering continue from it.
- `projects/hub/call-stats/COMMITTED-NOT-BUILT.md` §8 — the eleven-metric scorecard and the four marked "reachable now."
- `projects/hub/call-stats/lib/hubspot-connector.js` — its CRITICAL header (one module, fixed request shapes, no generic method-passing helper) and its LIVE VERIFICATION block, especially point 1 on which scopes this portal actually grants.
- `projects/hub/call-stats/SPEC.md` — Design Decision 2 (store sums and counts, divide at query time), Design Decision 4 (when a new Hub section is justified), Design Decision 5 (governance assessed rather than asserted), and the Data Inventory pattern.
- `CLAUDE.md`'s compliance-build definition and `GOVERNANCE.md` in full.

**Live investigation:** every number in this document was measured against Rincon's real, live HubSpot. Nothing here is inferred from what a metric's name suggests. Where I could not determine something from the data, it says so and is listed as an Open Item.

- **2026-09-10 figures** were measured through the read-only HubSpot connector available to that session — a broader credential than the tool's own.
- **2026-09-11 figures** — everything in the revision note, the workflow-layer section, the re-measured task counts, and Design Decisions 29 and 39–42 — were measured through the tool's own **`HUBSPOT_PRIVATE_APP_TOKEN`**, because that is the credential the build will use and verifying against anything else proves nothing about whether the build will work. All reads; nothing was written to HubSpot.
- Where the two disagree, the 2026-09-11 figure is the live one and the difference is shown rather than overwritten.

---

## Read This First — Three Things That Change The Job

Peter's stated reason for doing these four now is that they are the cheapest on the list and blocked on nobody. **That is mostly true, and materially wrong in three places.** Stating them up front rather than burying them:

**1. "Lead follow-up completion rate" should not be built as specified — and the narrower version does not rescue it either.** *(Updated 2026-09-11 with workflow access.)* Kristen owns **2,535 tasks**; 2,491 completed, 44 open, **5 overdue** — 0.2%. A completion rate over all her tasks is ~100% by construction.

The obvious next move, once workflow access arrived, was to narrow the denominator: measure completion over *the tasks one specific workflow generated for one specific enrolled lead*. **I built that and it pins at 100% too.** Across all 81 enrollments in the live follow-up workflow: **423 of 434 tasks completed (97.5%)**, median per-enrollment completion **100%**, **75 of 81 enrollments at exactly 100%**, and 12 of the 16 weekly figures at exactly 100.0% — the four that dip are cohorts still in flight. Narrowing the denominator did not create variance. It has none to find.

Design Decision 29 keeps the touch-count direction, but rebuilds it: the draft's version was pointed the wrong way round, and the real signal is somewhere else.

**2. The booking itself is not attributable to Kristen anywhere in HubSpot — and mostly is not recorded at all.** Every prospect booking in this account is a meeting on Kenya's HubSpot scheduling link. HubSpot records the meeting's owner as Kenya (`hubspot_owner_id` 191249450) and its creator as Kenya (`hs_created_by` 45454734, which is Kenya's internal user id), no matter who caused the booking to happen. Worse, the booking usually leaves no meeting record tied to the lead at all: of the **364 leads currently sitting at the "Qualified" stage, only 36 have `hs_lead_meeting_count` above zero.** Booking rate therefore cannot be measured from meetings. It can be measured well from something else (Design Decision 27), but the thing Peter described — "Kristen booked a call with Kenya" — is not a recorded event in this system.

**3. ~~The existing HubSpot credential almost certainly cannot read the objects these metrics need.~~ RESOLVED 2026-09-11.** The 2026-09-10 draft flagged this as the thing to check in the first ten minutes. Peter added the scopes on 2026-09-11 and I verified against the tool's own `HUBSPOT_PRIVATE_APP_TOKEN` — the credential the build will actually use, not the broader session connector:

| Endpoint | Status |
|---|---|
| `/crm/v3/objects/contacts` | **200** |
| `/crm/v3/objects/leads` | **200** |
| `/crm/v3/objects/deals` | **200** |
| `/crm/v3/objects/tasks` | **200** |
| `/crm/v3/objects/meetings` | **200** |
| `/automation/v3/workflows` | **200** |
| `/automation/v4/flows` | **200** |
| `/automation/v2/sequences` | 404 |

Sequences remains refused and remains irrelevant — sequence- and workflow-created *tasks* carry their origin, which is the route this design already used. **Nothing in this document is now blocked on a credential.**

**Replacing it as the third thing worth knowing up front: workflow access opened a door and then closed most of it.** Enrollment lists are genuinely unavailable — `/automation/v2/workflows/{id}/performance/histogram`, `/automation/v3/workflows/{id}/enrollments`, `/automation/v4/flows/{id}/enrollments` and `/automation/v4/flows/{id}/revisions` all 404 against the tool's token. But **enrollment turned out to be directly readable off the tasks themselves**, better than the "distinct contacts with tasks" workaround assumed: every automation task carries `hs_object_source_id = "enrollmentId:<N>;actionExecutionIndex:<N>"`, which is a real enrollment key *and* a step index. 434 tasks resolve to 81 distinct enrollments with their step order intact. That is what made Design Decision 29's rebuild possible.

One piece of unambiguously good news, which unblocks something previously blocked on somebody else: **the "which pipelines count" question is answered by the data.** Of the four pipelines, only `default` (Sales Pipeline) is in use, with 1,631 deals. RentScale has **0** deals. Smartlead Positive Replies has **0**. House Hack Group has 5, all from 2023. That closes `SALES-VS-OPERATIONAL-CLASSIFICATION-SPEC.md`'s Open Item 17 without waiting for the marketing manager.

---

## What This Does

Four of the eleven lines on Peter's weekly scorecard get counted automatically instead of by hand. All four describe the business-development function: how many new enquiries turn into a conversation with Kenya, how diligently they get followed up, how much work goes into reviving old enquiries, and how often that revival actually produces a client.

None of it reads what anyone said. It reads the stage a lead is sitting in, how many follow-up touches were logged against it, and whether a deal was created — and it stores only the weekly totals, never the name, phone number or record ID of any prospect.

## How It Works

1. **Once a week, after the week closes, a job asks HubSpot four narrow questions** about that week — read-only, four to eight requests, nothing is ever written back to HubSpot.
2. **Every question is asked about "leads," which in this account is a real, well-behaved HubSpot object** — 1,265 records, each created by one named workflow when a contact is genuinely promoted to prospect status. The junk contacts never become leads (verified below), which is what makes these metrics reachable at all.
3. **Leads that were disqualified as tenants or vendors are removed from every count** before anything is calculated. This is a correctness rule and a governance rule at the same time (Design Decision 34).
4. **Four pairs of whole numbers are written to the database** — a top and a bottom of a fraction for each metric, for that week, for that person. Nothing else. No prospect's name, number or record ID ever enters Rincon's database.
5. **Once a week is written, it is never recalculated.** A lead that moves stage in October does not change September's figure.
6. **The Hub shows the four numbers per week**, with the target beside each and a plain sentence saying what it counts.

## What You'll See

- **Six rows in four groups** — Booking rate; Follow-up (three rows: touches completed, sequence depth, first touch within an hour); Re-engagement attempts; Past-lead conversion — each showing the figure, the target where there is one, and the last eight weeks beside it. *(Follow-up became three rows in the 2026-09-11 revision — Design Decision 29.)*
- **Every percentage shows its two raw numbers underneath** — "71% (12 of 17)" rather than a bare 71%. A percentage with a denominator of 3 and a percentage with a denominator of 300 look identical otherwise, and at Rincon's volumes the denominators really are that small.
- **A sentence under each metric saying exactly what it counted**, in the same words as this spec. For the follow-up rows this includes saying what the number is *not*: sequence depth is not a quality score, and first-touch speed is not a proven driver of deals.
- **Each row carries its own week label.** The follow-up rows are held ten days after their week closes (Design Decision 42), so they refer to an earlier week than the booking row. They are not stacked under one date header.
- **A visible "counted from" date.** Weeks before the first run show as blank, never as zero.
- **An "unmatched follow-up tasks" figure.** Normally zero. If a workflow gets renamed, this rises instead of the metric quietly falling (Design Decision 41).

## What Could Go Wrong

- **The denominators are small enough that one lead moves the number several points.** Seventeen leads resolved in a typical fortnight. One prospect who stops answering the phone moves the booking rate by roughly six percentage points. Read weekly if you like, but judge on a month. **The follow-up rows are smaller still** — 81 enrollments across sixteen weeks is about **five a week**. One enrollment can move a follow-up figure twenty points. These rows should be read monthly, and the page must not invite otherwise.
- **A workflow rename breaks name matching, and it has already happened once.** `PMW Incoming Call leads` has tasks filed under two different names; `Geek Leads` and the APM workflow likewise. Design Decision 41 handles it with aliases and a visible unmatched count — but the underlying fact stands: HubSpot puts no workflow ID on the task, only a name, and names change.
- **The metric describes the function, not the person, and v1 does not pretend otherwise.** Lead ownership in this account is inherited automatically from the contact, not deliberately assigned. Following it produces a perverse result, demonstrated on real records in Design Decision 33: the lead that failed is Kristen's and the lead that succeeded is Kenya's, for the same human being.
- **Kristen's own workflow is the measurement instrument, and changing the workflow changes the number without anything breaking.** If the team stops moving leads to "No Response" and starts leaving them at "Connected," the booking rate silently rises, because the denominator shrinks. This is the same class of hazard as the sales-hygiene ceiling in the classification spec, and it has the same answer: the number is only as honest as the process behind it.

---

## What Is Actually In Rincon's HubSpot — Measured 2026-09-10

### The lead object is real, well-populated, and clean

| | Count |
|---|---|
| LEAD records, total | **1,265** |
| Created since 2026-06-01 | **120** |
| Created since 2026-06-01, owned by Kristen | 84 |

**Every lead in the recent sample was created by one workflow.** All 27 leads created between 2026-08-25 and 2026-09-10 carry `hs_object_source_label = AUTOMATION_PLATFORM`, `hs_object_source_detail_1 = "Create Lead Upon Contact LCS Update"`, and `hs_lead_flow_id = 1630051113`. A lead is created when a contact's lifecycle stage is promoted. Nothing else creates one.

**This is why these four metrics are reachable and the call-classification ones were hard.** The ~1,275 Aircall-exhaust contacts sit at lifecycle stage `2263812856` and are never promoted, so they never trigger that workflow and never become leads. The arithmetic confirms it: roughly 1,275 junk contacts were created since 2026-06-01, and **120** leads were created in the same window. If the junk produced leads we would see over a thousand. **The lead object is the clean surface the contact table is not,** and every definition below runs on it.

One honest caveat: the exclusion is not perfect *historically*. One lead in the past-lead pool is literally named `+18054430138 Aircall new contact`, created 2024-09-17 — before the June 2026 bug, from the older trickle of the same behaviour. It is a handful of records in a 1,265-record object, but it means "no junk ever reaches this object" is not quite true, and Design Decision 34's exclusion rule is doing real work rather than being theoretical.

### The lead pipeline — seven stages, and they account for every record

| Stage | Internal ID | Currently in stage | Ever entered |
|---|---|---|---|
| New | `new-stage-id` | 86 | — |
| Contacted | `attempting-stage-id` | 49 | 463 |
| Connected | `connected-stage-id` | 125 | 450 |
| **Qualified** | `qualified-stage-id` | **364** | **397** |
| Unqualified | `unqualified-stage-id` | 230 | 236 |
| Back to Marketing for Nurture | `201593994` | 206 | 218 |
| No Response | `201593995` | 205 | 213 |
| **Total** | | **1,265** | |

The seven current-stage counts sum to exactly 1,265, so nothing is hiding in an eighth state.

**"Qualified" is the load-bearing stage, and it means "a deal was created."** 397 leads have ever entered Qualified; **392 leads have at least one associated deal**. In the 27-lead recent sample the correspondence is exact: every Qualified lead had `hs_lead_associated_deals_count = 1`, and every non-Qualified lead had 0.

**Deals are created *after* the discovery call, not when it is booked.** Every won deal sampled had `hs_v2_date_entered_decisionmakerboughtin` equal to its `createdate` — the deal is born at the stage named "Discovery call complete." Deals are named after properties (`2317 Chippewa Ln`, `921 Aurora Dr #A` and `#B` won the same day for one client), so **deal count is not client count.**

### The deal pipeline is effectively binary

Only `default` is in use — 1,631 deals. Stage distribution, all-time:

| Stage | Internal ID | Count |
|---|---|---|
| Discovery call complete | `decisionmakerboughtin` | 22 |
| Onsite Consultation Scheduled | `23313482` | 2 |
| Onsite Consultation Complete | `closedlost` ⚠ | 10 |
| **Agreement Signed** | `13517903` | **496** |
| **Lost** | `5144166` | **1,101** |

Sums to 1,631 exactly. Only 34 deals are in flight at any moment; the rest are won or lost.

**The `closedlost` trap is confirmed live and is worse than it looks.** The stage labelled "Onsite Consultation Complete" carries the internal ID `closedlost`. Verified on real records: `hs_is_closed_lost` correctly returns **false** for deals in that stage, and `hs_is_closed_won` correctly returns **true** for stage `13517903`. **Use the boolean properties. Never match on the stage ID string.** A future reader who greps for `closedlost` and concludes those ten deals are lost will be wrong by a full pipeline stage.

Recent throughput: **76 deals created, 28 reaching Agreement Signed, 59 entering Lost**, all since 2026-06-01.

### Tasks: 2,535 of them, 5 overdue — re-measured 2026-09-11

| | 2026-09-10 draft | **Re-measured 2026-09-11** |
|---|---|---|
| Tasks assigned to Kristen, all time | 2,513 | **2,535** |
| Completed | 2,476 | **2,491** (98.3%) |
| Not started | 37 | **44** |
| **Open with a due date in the past (overdue)** | 0 | **5** |
| Created by automation workflows | 801 | — |

**The draft's "zero overdue, across the entire history of the account" was true when measured and is not true now.** It is 5 of 2,535 — 0.2%. The argument it supported is unaffected: a completion rate over this population still cannot print anything but ~100%. But the word "zero" should not be repeated in a meeting, because it is now falsifiable in a way "0.2%" is not. Portfolio-wide the picture is different and worth knowing — **830 of 26,233 tasks are overdue**, so the near-perfect figure is Kristen's, not HubSpot's.

Weekly completion volume, measured on `hs_task_completion_date`:

| Week | Completed | of which automation-created |
|---|---|---|
| 2026-08-18 → 08-25 | 84 | — |
| 2026-08-25 → 09-01 | 145 | — |
| 2026-09-01 → 09-08 | **140** | 94 |

**The ~100% is achieved two ways, and both are visible in the records.** Some tasks are closed. Others have their due date pushed: task `380568742644` ("follow up") was created 2026-07-02, last modified 2026-08-13, and is due **2027-01-04**. Task `372988035783` ("Follow up with Mike Kehoe"), created 2026-06-01, is due 2026-12-01.

**`hs_task_missed_due_date_count` is not a reschedule counter, despite the name.** *(Added 2026-09-11.)* The draft deferred the reschedule count on the grounds that HubSpot does not expose a task's original due date. HubSpot does expose `hs_task_missed_due_date` (boolean) and `hs_task_missed_due_date_count` (number), which looks like exactly the missing piece. It is not:

- **The count never exceeds 1.** Searching the whole portal for `hs_task_missed_due_date_count >= 2` returns **0 of 26,233 tasks**. It is a boolean wearing a number's name. It records *that* a due date was missed once, never *how many times* it was pushed.
- **On workflow tasks it is true by construction.** Every task the follow-up workflows create is `dueImmediately` — due the instant it is created — so **2,303 of Kristen's 2,535 tasks (91%)** and **425 of the 434 follow-up-workflow tasks** carry `missed_due_date = true` simply because they were not completed within the same second. It measures the workflow's due-date convention, not Kristen.

So the property is real, free, and useless for this purpose. Open Item 26 stays deferred — but for the corrected reason, not the original one.

There is also a **close-and-immediately-recreate** pattern, which is a legitimate workflow rather than gaming: task `395876032191` "Follow up on 758 Terrace View Pl" was completed at `2026-09-08T22:28:48.510Z`, and task `398336401089` with the identical subject was created at `2026-09-08T22:28:48.858Z` — **0.35 seconds later** — due a week out. The same pattern appears for "Follow up with Laura Richman" two seconds apart. This is Kristen closing a touch and booking the next one. It is good practice. It also means **a completed task is a touch, not a resolution**, and any metric built on completions must be described that way.

**Sequences versus workflows — the brief's assumption needs one correction.** Sequences are indeed not exposed as an object, but the follow-up machinery here is **HubSpot Workflows**, not Sequences, and workflows name themselves on every task they create via `hs_object_source_detail_1`.

Two separate new-lead streams exist. One task body reads, in full: *"New APM lead assigned. We are actively paying to be first to receive this contact, so speed matters."* APM is a paid lead source with a different economics and a different follow-up cadence from the website form.

### The workflow layer, measured 2026-09-11

**61 workflows in `/automation/v3/workflows`, 22 enabled. 64 in `/automation/v4/flows`.** The two lists are not the same list and — the trap — **they do not share IDs.**

| Workflow | v3 id | **v4 id** |
|---|---|---|
| `New lead follow up - 11 touches - Testing Phase` | `36143443` | **`4259746541`** |
| `PMW Incoming Call leads - Active` | `31570873` | **`3950514911`** |

This is why `/automation/v4/flows/36143443` 404s: `36143443` is a v3 id being handed to a v4 endpoint. **Both ids must be carried in config**, because the two APIs answer different questions and neither alone is sufficient — see Design Decision 40.

**Read the definition from v4, never from v3.** `/automation/v3/workflows/36143443` reports **7 actions** ending in a `BRANCH` whose `acceptActions` and `rejectActions` are both empty arrays — which reads as "an unfinished workflow that stops after Day 1." That is a rendering limitation of the legacy endpoint, not the truth. The same workflow at `/automation/v4/flows/4259746541` reports **27 actions including 12 task-creating ones**, and the live task data confirms the v4 view: tasks named "Day 2", "Day 3", "Day 5", "Day 6" exist in HubSpot right now. **Anyone sizing this build from the v3 definition will undercount the sequence by three quarters.**

Four v4 flows produce tasks but appear in v3 under different names or not at all — `Lost Deals (Kenya)` and `Closed Lost Re-engagement based on intent - active - good` are v4-only and are **deal-scoped** (`objectTypeId 0-3`), not lead-scoped. They are out of scope here but explain 378 automation tasks that would otherwise look unattributable.

**Enrollment lists are unavailable, and enrollment is readable anyway.** Confirmed 404 against the tool's own token: `/automation/v2/workflows/{id}/performance/histogram`, `/automation/v3/workflows/{id}/enrollments`, `/automation/v4/flows/{id}/enrollments`, `/automation/v4/flows/{id}/revisions`. There is no way to ask who is enrolled. But every automation task carries `hs_object_source_id = "enrollmentId:<N>;actionExecutionIndex:<N>"` — **a real enrollment identifier and the step's position in the flow.** 434 follow-up tasks resolve to **81 distinct enrollments** with step order intact. This is strictly better than the "distinct contacts with tasks" workaround: it survives a contact being enrolled twice, and it does not require touching the contact object at all. 69 of the 81 also resolve to a contact; 12 do not, and that residue is reported rather than dropped.

Separately, `hs_primary_contact_enrolled_in_sequence` **is** readable on the lead object as a true/false. It is a current-state flag, not a count, so it still cannot produce an enrolment total — but it is more than the brief credited.

### The single most important finding: past leads come back as *new* leads

**Zero leads have ever moved from "Back to Marketing for Nurture" or "No Response" into "Qualified."** I checked directly; the result is an empty set across all 411 past leads. Read naively, past-lead conversion is 0%, and one might conclude re-engagement never works.

That conclusion would be wrong. **When a past lead re-engages, the workflow creates a second lead record for the same person.** Lead names carry a year-month suffix, which is the tell. Verified on two real records:

| | `836904086243` | `842564038384` |
|---|---|---|
| Name | Irsula Castillo **2026-08** | Irsula Castillo **2026-09** |
| `hs_primary_contact_id` | **545009814254** | **545009814254** |
| Stage | No Response | **Qualified** |
| Associated deals | 0 | **1** |
| Outreach activities | 17 | 6 |
| Owner | **Kristen** (384054033) | **Kenya** (191249450) |

Same `hs_primary_contact_id`. Same human being. The August attempt failed under Kristen; the September attempt succeeded and is recorded under Kenya.

**Everything about metric 6 follows from this**, and so does the attribution problem in metric 7 — that table is the whole argument for Design Decision 33, on live records rather than in principle.

### What I could not reproduce

**Peter's 71.86% booking rate does not correspond to any natural ratio in this data.** I tested every plausible one: leads-with-a-meeting over leads created (10.8%), ever-Qualified over ever-Connected (88.2%), ever-Qualified over ever-Contacted (85.7%), Qualified over Qualified-plus-Unqualified (62.7%), Qualified over Qualified-plus-No-Response (65.1%). None lands on 71.86%.

The closest by a distance is **leads resolved as Qualified ÷ leads reaching any terminal outcome, measured on the recent cohort: 12 of 17 = 70.6%.** That is within a point and a half of his hand-kept average, and it is the definition Design Decision 27 adopts — but I want to be exact about the status of that agreement: **it is a close match, not a reproduction.** His figure is an average of weekly percentages, which does not equal a pooled ratio, so an exact match was never going to be provable from stock data. Open Item 23 asks him to confirm the definition; it does not ask him to explain his arithmetic.

---

## Design Decisions

*Numbering continues from `SALES-VS-OPERATIONAL-CLASSIFICATION-SPEC.md`, which ended at 25.*

### 26. Everything runs on the LEAD object, and the junk-exclusion property is preserved by construction

**Decision: the lead object is the population for all four metrics. No definition reads the contact table to decide who counts.**

The brief asked that the property which makes these metrics reachable — the junk never touches them — be preserved in every definition, and that any definition reading the contact population say so and justify it. **None of the four definitions below reads the contact population to decide membership.** Membership is always "is there a LEAD record," and leads exist only when the `Create Lead Upon Contact LCS Update` workflow fires on a deliberate lifecycle promotion.

There is exactly one place a contact ID is touched at all: Design Decision 31 joins two lead records by `hs_primary_contact_id` to detect a returning prospect. That is a join key used in memory and discarded; it is not a read of the contact population and no contact record is fetched. Called out explicitly because it is the one line in this document that could be mistaken for a contact read.

**Why the lead object rather than lifecycle stage.** The brief noted that which lifecycle stages count as a prospect is an open question awaiting the marketing manager, and asked for a configurable set. **That question does not need answering for these four metrics.** The lifecycle stage is the *trigger* for lead creation, inside a HubSpot workflow Rincon already owns; by the time a lead record exists the judgment has already been made by Rincon's own automation. Reading lead existence instead of re-deriving prospect-hood from lifecycle stages avoids the open question entirely, and avoids the risk of this tool and that workflow disagreeing about who is a prospect.

The one configurable set this design does need is much smaller and is specified in Design Decision 34.

### 27. "New lead booking rate" = leads resolved as Qualified ÷ leads resolved at all, in the week they resolved

**Decision: the denominator is leads that reached a terminal outcome during the week. The numerator is those that reached Qualified.**

Terminal outcomes are the four stages a lead stops moving in:

| Outcome | Stage ID | Counts as |
|---|---|---|
| Qualified | `qualified-stage-id` | **Booked** (numerator) |
| Unqualified | `unqualified-stage-id` | Denominator only |
| No Response | `201593995` | Denominator only |
| Back to Marketing for Nurture | `201593994` | Denominator only |

`New`, `Contacted` and `Connected` are work-in-progress and are in **neither** half.

**Why "resolved this week" and not "created this week" — this is the decision, not a detail.** A lead created on Friday has had no chance to be booked by Sunday. A cohort-based metric therefore understates every recent week and keeps changing as the cohort matures, which makes it incompatible with the freeze rule in Design Decision 32. Measuring resolutions instead of arrivals removes maturation entirely: a lead is counted once, in the week it stopped moving, and it never moves again. The figure for a closed week is final the moment the week closes.

**What this costs, stated plainly.** It is a lagging measure. A bad week of lead handling shows up when those leads finally get written off, not when they were mishandled. And a lead that never resolves — parked at "Connected" forever — is never counted at all, in either half. Today that is 125 leads, about 10% of the object. If that number grows, the metric is quietly measuring a shrinking share of the work, so **the count of leads currently parked in a non-terminal stage is shown on the page beside the metric**, not hidden. That is the same instinct as the classification spec's refusal to suppress its "Unknown" column.

**Why not meetings, which is what "booking" literally means.** Because the data does not support it: only 36 of 364 Qualified leads have any meeting attached, and every prospect meeting that does exist is owned and created by Kenya. Design Decision 28 deals with the residue this leaves.

**Measured value on real data:** 12 of 17 resolved leads in the 2026-08-25 → 09-10 window = **70.6%**, against Peter's hand-kept 71.86%.

### 28. What this definition cannot see: the no-show

**Decision: name the gap rather than paper over it, and do not build a second mechanism for it in v1.**

Peter's definition of a booking is Kristen creating the appointment. This spec's proxy is the lead reaching Qualified, which happens when the discovery call has actually taken place and a deal has been created. **The two differ by exactly one case: the prospect who books and then cancels or does not show.** Under Peter's definition Kristen did her job. Under this one it does not count.

That is a real understatement of Kristen's performance and it is not fixable from the data — the booking event is not reliably recorded, and where it is, it is Kenya's. Two things follow:

1. **The metric is a floor, and the page says so** — the same "Sales is a floor, not a total" honesty the classification spec put on its own page.
2. If the no-show rate matters, the fix is a process change (have Kristen log the booking on the lead), not a code change. Worth Peter knowing; not worth building around.

### 29. "Lead follow-up completion rate" is replaced, because the metric as written cannot fail

*Rebuilt 2026-09-11 on workflow-sourced tasks. The 2026-09-10 version is superseded; its conclusion holds, its reasoning did not.*

**Decision: do not build a completion rate — not over all tasks, and not over workflow-generated tasks either. Build three numbers: touches completed this week, sequence depth reached, and first-touch latency. Only the third carries quality information, and even that is not yet proven to matter.**

#### The narrowed definition was tested on real data, and it also pins at 100%

The brief asked whether a rate over *the tasks a specific workflow generated for a specific enrolled lead* actually varies before recommending it. It does not.

Measured across every enrollment of `New lead follow up - 11 touches` since it went live (2026-05-21), grouped by the `enrollmentId` in `hs_object_source_id`:

| | |
|---|---|
| Tasks the workflow created | **434** |
| Completed | **423** — 97.5% |
| Distinct enrollments | **81** |
| Enrollments at exactly 100% completion | **75 of 81** |
| Median per-enrollment completion | **100%** |
| Enrollments with any incomplete task | **6** — all created in the last 4 days |

Weekly, by the cohort's start week — **12 of 16 weeks are exactly 100.0%.** The four that are not (96.8%, 91.7%, 85.3%, 98.1%) are the oldest cohort and the three most recent, which are still in flight. The same test on the APM workflow gives **373 of 374 (99.7%)**; on `PMW Incoming Call leads`, **9 of 9 (100%)**.

**So the answer to the brief's question is no.** Narrowing the denominator from "all Kristen's tasks" to "this workflow, this lead" does not produce variance. The touch-count alternative is kept, as instructed — but it needs rebuilding, because the version in the 2026-09-10 draft points the wrong way.

#### Why the draft's touch count was backwards

The draft proposed touches as a proxy for follow-up diligence. **Measured against outcomes, more touches means a worse result.**

The workflow has four `LIST_BRANCH` gates that unenroll a lead once its status reaches `CONNECTED`, `OPEN_DEAL`, `Won`, `Lost`, `UNQUALIFIED` or `Back to Marketing for Nurture`. **Tasks are only created when the flow actually reaches that step**, so an enrollment's task count is a record of *how long the lead stayed unresponsive*, not of how hard anyone worked. The data says exactly that:

| Contact's current lead status | Enrollments | Avg tasks created |
|---|---|---|
| `Won` | 2 | **4.0** |
| `CONNECTED` | 15 | **4.9** |
| `OPEN_DEAL` | 20 | **5.4** |
| `UNQUALIFIED` | 10 | 4.9 |
| `Lost` | 4 | 6.3 |
| `Back to Marketing for Nurture` | 10 | **8.7** |

| | Enrollments | Avg tasks created |
|---|---|---|
| Contact **has** a deal | 36 | **4.7** |
| Contact has **no** deal | 33 | **7.0** |

**A rising touch count is a symptom of leads not answering.** Put it on a scorecard as "follow-up quality" and the best possible week — every lead connects on Day 1 — prints the lowest number. That is worse than a flat 100%: a flat number carries no information, but an inverted one actively misleads.

**Touches stay, relabelled as what they are: activity volume.** 84, 145, 140 over the last three weeks. Split **worked** versus **automation-generated** (`hs_object_source_label = AUTOMATION_PLATFORM`), because 94 of the most recent week's 140 were workflow-created. The page must not call this quality, diligence, or completion.

#### What does vary, and points the right way: first-touch latency

Every task this workflow creates is `dueImmediately` — due the second it is created. So the gap between `hs_timestamp` and `hs_task_completion_date` is a clean measure of **how long a new lead waited**, with no due-date convention to argue about.

On the first touch of the sequence (`New lead assigned. Day 1 - Text`), n = 80 enrollments:

| Responded within | Share |
|---|---|
| 5 minutes | **8%** |
| 15 minutes | 19% |
| 1 hour | **31%** |
| 4 hours | 53% |
| 24 hours | 73% |

**Median 2.9 hours.** Across all 423 completed tasks in the sequence: median 7.1 hours, p25 1.5h, p75 43h. That is a wide, real distribution on a business whose own task body says *"we are actively paying to be first to receive this contact, so speed matters."* It is the only thing measured here that both varies and improves when the team does better.

**The honest caveat, and it is a real one: at this sample size, speed does not predict outcome.**

| | n | Median first touch | Within 1h |
|---|---|---|---|
| Contact has a deal | 36 | 2.90h | 33% |
| Contact has no deal | 33 | 3.40h | 36% |

Essentially no separation — and the within-1h figure runs the wrong way. **So latency is defensible as an operational service-level measure and is not defensible as a driver of revenue**, and the page must not imply the second. It may become significant with more data; 69 enrollments cannot show it either way.

**One boundary note:** this overlaps scorecard metric 5, "Speed to lead," which `COMMITTED-NOT-BUILT.md` §8 lists as blocked on HubSpot cleanup and Aircall SMS history. This measures task-completion latency inside one workflow, which is a **narrower thing than speed to lead** — it is when Kristen marked the touch done, not when the prospect was actually contacted. Shipping it must not be allowed to look like metric 5 is finished.

#### What v1 ships

Three numbers under one heading, **no percentage anywhere**, because there is no honest denominator and dressing a count up as a rate is what created this problem:

1. **Touches completed this week** — split worked / automation-generated. Labelled *activity volume*.
2. **Sequence depth reached** — median tasks created per enrollment closing this week, shown beside the **12-task ceiling** (see Design Decision 39). Labelled *how far leads went before resolving — lower is generally better*.
3. **First touch within 1 hour** — share of enrollments resolving this week whose first task was completed within an hour of creation. Labelled *service level, not a conversion driver*.

Open Item 26 (the reschedule count) stays deferred. The 2026-09-10 draft deferred it because HubSpot does not expose an original due date; it turns out HubSpot exposes `hs_task_missed_due_date_count`, which looked like the answer and is not — the count is capped at 1 portal-wide and is `true` on 91% of tasks purely because they are due-immediately. **Same deferral, corrected reason.** It still cannot be computed without storing task IDs weekly, and that still makes it a compliance build.

### 30. "Past lead re-engagement attempts" = touches logged this week against leads already in a past-lead state

**Decision: a past lead is a lead sitting in `201593994` (Back to Marketing for Nurture) or `201593995` (No Response). An attempt is one completed task or logged activity against such a lead during the week.**

**Why these two stages and not age.** The brief asked how old a past lead is. The answer from the data is that age is the wrong axis: these two stages *are* the business's own definition of "we stopped getting anywhere with this one," they are explicitly named for it, and together they hold **411 leads** — a real, stable population. A day-count threshold would be an invented rule sitting on top of a rule Rincon already applies deliberately.

**Lifecycle stage `4033377998` "Re-engaged Lead" is not load-bearing and should not be used.** The brief flagged it as possibly central. Measured: **5 contacts**, portfolio-wide. It is vestigial.

**`hs_lead_type = RE_ATTEMPTING` is also not load-bearing.** Measured: **6 leads** of 1,265. The field exists and is almost never set.

**The counters on the lead object cannot be used directly, and this is the trap in this metric.** `hs_lead_outreach_activity_count`, `hs_lead_call_count`, `hs_lead_email_count` and `hs_lead_communication_count` are all well populated and genuinely useful — one lead shows 28 outreach activities, 18 calls. **But they are lifetime cumulative totals with no time dimension.** A weekly figure cannot be read off them. It could only be obtained by storing last week's value per lead and subtracting — which means storing a lead ID per row, which is the same boundary crossing Design Decision 29 refused. So:

**Count the activities themselves, in the week, by timestamp.** Completed tasks against past-stage leads, using `hs_task_completion_date` within the week. This is week-scoped by construction, needs no stored per-lead state, and aggregates to a single integer.

**An honest undercount, named.** Email sends inside the "Drip campaign #1" nurture workflow do not create tasks — that workflow has produced only **8** tasks in total, all of them "End of Nurture Sequence - Please Follow up" handoffs. So automated nurture emails are invisible to this count. The metric measures **attempts a person made**, not attempts the marketing system made. Given the target is a person's activity target of ≥25, that is arguably the right thing to measure — but it must be labelled that way on the page, and it is one reason this number may read lower than Peter's hand-kept 104.84.

**On that 104.84:** total task completions run 84–145 a week, which brackets it. Past-lead-only completions will be a subset and therefore lower. **Expect this metric to print below Peter's current figure**, and expect that to be a definitional difference rather than a drop in Kristen's activity. Phase 0 measures the gap before anything ships.

### 31. "Past lead conversion rate" = past leads whose person came back and reached Qualified

**Decision: a conversion is a lead reaching Qualified this week whose `hs_primary_contact_id` also belongs to an earlier lead that is in a past-lead stage. The denominator is the count of past leads eligible at the start of the week.**

This is the metric the Irsula Castillo pair makes possible, and it is the only one of the four that could not have been defined without looking at the data. **The naive definition — a lead moving from a past-lead stage to Qualified — returns zero, always**, because HubSpot's workflow creates a second lead record instead of advancing the first. A tool built on the naive definition would confidently report 0% forever and nobody would know why.

**The rule, precisely:**

1. Take every lead that entered Qualified during the week.
2. For each, take its `hs_primary_contact_id`.
3. If any *other*, *earlier-created* lead for that same contact ID is sitting in `201593994` or `201593995`, this is a **past-lead conversion**.
4. Numerator = count of those. Denominator = the past-lead population as it stood at the start of the week.

**The contact ID is a join key and is never stored.** It exists in memory for the length of step 3 and is discarded. Only the two integers are written. This is the same construction as the classification spec's Design Decision 23 and it is what keeps this out of compliance-build territory.

**On the target and the 0.58%.** The target is ≥5% against a current 0.58%, and the brief rightly notes the definition decides whether that reads as a crisis or a rounding error. Against a denominator of **411 past leads**, 5% would mean about 20 conversions a week, which is more than Rincon's entire new-deal throughput (28 Agreement Signeds in fourteen weeks). **Against that denominator the target is not achievable and the metric will read as permanent failure.** 0.58% of 411 is 2.4 a week, which is already implausibly high.

Peter's 0.58% is far more consistent with a denominator of **weekly re-engagement attempts** (~105), giving about 0.6 conversions a week — roughly one every ten days, which matches Rincon's real deal flow. **So the two readings differ by a factor of roughly four, and the target only makes sense under one of them.** I cannot tell from the data which one Peter means. This is Open Item 24 and it is the single most consequential question in this document: it decides whether this metric is reporting a business in trouble or a business doing fine. **Both denominators are cheap to compute, and the recommendation is to compute both in Phase 0 and let Peter choose from real numbers rather than from a description.**

### 32. Weekly grain, computed after the week closes, frozen forever

**Decision: one row per (metric, week, person). Computed once, after the week ends. Never recomputed.**

This is `SALES-VS-OPERATIONAL-CLASSIFICATION-SPEC.md` Design Decision 22 applied to a case that needs it more, not less. Lead stages move constantly — that is what a lead pipeline is for. A lead that was "No Response" in week 1 may be "Qualified" in week 6. Recomputing week 1 from today's HubSpot would rewrite history every single week, and it would rewrite it **in the direction of flattery**: past failures would keep turning into successes and last quarter's booking rate would drift upward on its own.

**Week runs Monday to Sunday**, matching the decision already made for the trend view in `COMMITTED-NOT-BUILT.md` §3. Computed the following Monday, so a week is always complete before it is counted.

**No backfill.** Historical weeks cannot be reconstructed: the stage-entry timestamps (`hs_v2_date_entered_*`) survive, but *stage-exit* history for leads that have moved on since does not, and neither does the past-lead population as it stood on some Monday in July. Reconstructing it would mean applying today's HubSpot to a week in the past — the exact rewrite this decision exists to prevent. **The four metrics start from the first Monday this runs, and the page says so.** Peter keeps his hand-kept history for everything before that; the two should not be spliced into one line on a chart, because they are not the same measurement.

### 33. Attribution: these are the function's numbers in v1, not one person's — and following HubSpot's owner field would be actively wrong

**Decision: count every in-scope lead regardless of who owns it. Do not filter by `hubspot_owner_id`. Label the metrics as business-development function metrics that Kristen is accountable for and reviews weekly.**

The brief asked how each metric attributes when Kristen and Kenya are both involved. The honest answer is that **HubSpot cannot support per-person attribution here, and pretending otherwise would produce a number that is worse than no number.**

**The evidence, on real records rather than in principle.** `hubspot_owner_id` on a lead is not a deliberate assignment — HubSpot's own field description says it "defaults to the owner of the primary associated contact." So it records who happens to own the contact, not who did the work. The Irsula Castillo pair shows what that produces: **the failed August lead is Kristen's, the successful September lead is Kenya's, for the same prospect.** Filtering by owner would systematically credit Kenya with Kristen's conversions and charge Kristen with the failures that preceded them. Across the recent sample, 84 of 120 leads are Kristen's, but the split has nothing to do with effort.

**The same applies to bookings by definition.** Kristen's job is to create the appointment; Kenya's is to run it. A booking Kenya makes himself is still a booking, still fills Kenya's calendar, and still shows up as a lead reaching Qualified. There is no field distinguishing the two, and inventing one by inspecting who created which record would be reading `hs_created_by` — which, as established, says "Kenya" on every prospect meeting regardless of who caused it.

**So v1 counts the function.** The schema carries an owner column from day one (Design Decision 36) so that per-person reporting is a query change rather than a migration when ownership becomes deliberate — but it is populated with a single function-level value, not split, and the page does not claim a split it cannot support.

**What would make per-person real, if Peter wants it:** lead ownership assigned deliberately at creation rather than inherited from the contact. That is a change to one HubSpot workflow, not a change to this tool. Open Item 25.

### 34. Leads disqualified as tenants or vendors are excluded from every count

**Decision: any lead whose `hs_lead_disqualification_reason` is `Tenants` or `Vendor` is removed from both halves of every metric, before anything is calculated.**

HubSpot's disqualification-reason list on this portal is mostly standard (`BAD_TIMING`, `BUDGET_CONSTRAINTS`, `NOT_A_GOOD_FIT`, `NO_INTEREST`, and so on) with **two values Rincon added: `Vendor` and `Tenants`.** They exist because tenants and vendors ring the office, get logged, occasionally get promoted by mistake, and then have to be thrown out of the sales pipeline by hand.

**This rule is doing two jobs at once, and both are load-bearing.**

*Correctness:* a tenant who was misrouted into the lead pipeline is not a failed booking. Leaving them in the denominator makes Kristen's booking rate worse for a data-entry error she did not make.

*Governance:* it is the mechanism that keeps prospective tenants out of this build entirely. `GOVERNANCE.md`'s Fair Housing Standard and Mason's lane are engaged by tools that touch applicants or tenants. The classification spec's tripwire was precisely this distinction — prospective management clients are one thing, prospective tenants are another. **This rule means no lead flagged as a tenant contributes to any number this tool produces**, which is a far stronger statement than "we think they're mostly owners," and it is checkable in code rather than asserted in prose.

**The exclusion list is configuration, not an inline literal** — one exported constant with a dated comment, following the classification spec's Design Decision 17 pattern and rejecting a config table for the same reason it did. It is the only configurable set this design needs.

**The limit of the rule, stated honestly:** it catches tenants who were *identified and disqualified as such*. A tenant sitting un-triaged at "Connected" is invisible to it and will sit in no denominator either, because Design Decision 27 only counts resolved leads. The combination is tighter than either rule alone, but neither is a guarantee, and TARS should check for tenant-looking leads in a resolved state as part of Phase 0.

### 35. This does not belong in the Call Stats tool — recommend a new Hub section

**Recommendation: a new, small Hub section at `projects/hub/scorecard/`. Peter decides.**

The brief asked for a recommendation and this is a genuine judgment call, so here is both sides.

**Why not Call Stats.** `SPEC.md` Design Decision 4 set this project's test: a new section is justified when the organising axis is genuinely different. Call Stats is organised around *a person, a day, and a phone call*, sourced from Aircall. These four are organised around *a lead and its lifecycle*, sourced from HubSpot, at weekly grain, with no call anywhere in any of them. They share one staff member and one meeting slot, and nothing else. Putting four lead-funnel metrics on a page titled "Call Stats" would mislead every person who opens it — and this is a page Peter reads aloud in a meeting.

**Why the argument for folding them in is not silly.** Peter's scorecard is one document with eleven lines, and splitting it across two Hub tiles means he reads two pages to run one meeting. That is a real cost, and it gets worse as more of the eleven get automated.

**Why the new section wins anyway.** The fragmentation argument actually points *at* a separate section rather than away from it: the eventual destination is one Scorecard page carrying all eleven lines, with Call Stats continuing to own the call-derived numbers and feeding them in. Naming that section now costs one router, one tile and one `team_member_tool_roles` value; discovering the need later costs a migration and a page move. **What it must not become is a licence to build the other seven metrics now.** v1 is four metrics on one page. Design Decision 36's storage shape is chosen so the remaining seven need no schema change when their turn comes, and that is the only forward provision being made.

**Access reuses the existing mechanism exactly** — `team_member_tool_roles` gains one allowed `tool` value, `'scorecard'`, the same DROP-then-ADD CHECK pattern Security Deposit and Call Stats both used. No new role values; `admin` and `pod_lead` already exist and are reusable.

### 36. Storage: one small table, keyed by metric, and deliberately no collision with `call_stats`

**Decision: one new table. `call_stats` and `call_stats_line_misses` are not touched at all.**

The brief warned against colliding with the classification spec's three proposed counters on `call_stats`. **There is no collision to manage: that spec adds columns to `call_stats`, and this one creates a separate table in a separate section.** Neo should still take a migration timestamp after `20260910010000` and after the classification migration, but the two cannot interfere.

**Proposed shape (Neo finalizes):**

```
scorecard_weekly
  id              UUID PK

  metric_key      TEXT NOT NULL   -- closed set, CHECK-constrained:
                                  -- 'new_lead_booking_rate'
                                  -- 'followup_touches'          (DD 29)
                                  -- 'followup_sequence_depth'   (DD 29)
                                  -- 'followup_first_touch_1h'   (DD 29)
                                  -- 'past_lead_reengagement_attempts'
                                  -- 'past_lead_conversion_rate'
  week_start      DATE NOT NULL   -- Monday, America/Los_Angeles.
                                  -- NOT a UTC truncation — same hazard
                                  -- SPEC.md flagged for call_date
                                  -- NOTE (DD 42): the three followup_*
                                  -- keys are published 10 days after
                                  -- their week ends, so on any given
                                  -- Monday the newest followup row is
                                  -- an OLDER week than the newest
                                  -- booking row. That is correct, not a
                                  -- gap. The page labels each row with
                                  -- its own week (DD 42).
  owner_scope     TEXT NOT NULL   -- 'business_development' in v1.
                                  -- Design Decision 33: present so
                                  -- per-person is a query change, not a
                                  -- migration. Not split in v1.

  numerator       INTEGER NOT NULL
  denominator     INTEGER NULL    -- NULL for count-only metrics
                                  -- (followup_touches,
                                  -- reengagement_attempts). NULL means
                                  -- "this metric is not a rate", never
                                  -- "we could not find out".
                                  -- followup_sequence_depth and
                                  -- followup_first_touch_1h DO carry a
                                  -- denominator (enrollments closing in
                                  -- the week) but are NOT rendered as a
                                  -- percentage of the 12-task ceiling —
                                  -- DD 39 explains why that fraction is
                                  -- meaningless.

  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  created_at / updated_at TIMESTAMPTZ

  UNIQUE (metric_key, week_start, owner_scope)
```

**Why a keyed row rather than eight columns on a weekly row.** All four metrics have the same shape — a top and an optional bottom — so one keyed table expresses them uniformly, and the remaining seven scorecard metrics need no schema change when they arrive. The cost is the usual cost of a keyed table: the database cannot enforce that `past_lead_conversion_rate` means what the spec says it means. That is acceptable here because the key set is closed and CHECK-constrained, and because the alternative — a wide table that gets a migration every time a scorecard line is automated — is the shape this project has repeatedly avoided.

**Percentages are never stored.** Numerator and denominator only; divide at read time. This is `SPEC.md` Design Decision 2's rule and it matters more here than there: storing 70.6% loses the "12 of 17" that the page is required to show, and makes any multi-week roll-up silently wrong, because averaging four weekly percentages with different denominators is not the month's rate.

**Failure handling — write nothing rather than write a guess.** If HubSpot cannot be read, **no row is written for that week and the week stays re-runnable.** A zero is not written. A partially-computed week is not written. Per the classification spec's reasoning: a stored value meaning "we could not find out" that looks exactly like "we looked and found nothing" is a permanent, self-concealing error. A missing row renders as blank on the page and is obviously missing.

### 37. One read module, fixed request shapes, and it is not `hubspot-connector.js`

**Decision: a new module, `projects/hub/scorecard/lib/hubspot-leads-connector.js`, built to the same CRITICAL rule as the existing connector — and deliberately separate from it.**

The existing `hubspot-connector.js` is scoped to the Call Stats tool and reads exactly one thing: VOIP call records. Its header says it is the only place allowed to call HubSpot **for that tool**. Adding lead, deal and task reads to it would widen a module whose narrowness is its entire safety property, and would couple two tools that otherwise share nothing.

The new module inherits the rule verbatim: **no generic `request(method, path, body)` helper, ever.** One fixed-shape function per question — five of them, one per metric plus the past-lead population count — each hitting one fixed endpoint, each read-only in effect. HubSpot's CRM Search API is POST-shaped by HubSpot's own design; that is a real HTTP verb the file sends and it is fine, for exactly the reason the existing file already documents.

**Volume is small enough not to need engineering.** Four to eight requests, once a week, against populations in the hundreds. Paging matters only for the past-lead population (411 records) and the weekly task sweep (~140). The existing connector's `paging.next.after` cursor logic has **still never been exercised against a genuine multi-page result** (its LIVE VERIFICATION point 3), so the new module must not assume that pattern is proven — it should be written carefully and tested against a real second page, which at 411 records it will actually get.

### 38. Measure before building — the same gate, for the same reason

**Decision: before Neo writes a migration or Q writes a table, run all four definitions read-only over the last eight weeks and put the results next to Peter's hand-kept figures.**

This is `SALES-VS-OPERATIONAL-CLASSIFICATION-SPEC.md` Design Decision 25 applied to a build whose whole risk is definitional. Nothing here is technically hard. The entire risk is that a defensible definition produces a number Peter does not recognise, and that this is discovered on the page rather than beforehand.

**Phase 0 is a throwaway script.** Read-only, writes nothing, no migration, no table, no page. It reports:

1. **Booking rate per week for eight weeks**, beside Peter's 71.86%. *(Definition approved 2026-09-11 — this is now a confirmation run, not a decision input.)*
2. **Past-lead conversion under both candidate denominators** — against the 411-lead population and against weekly attempts — beside his 0.58% and his ≥5% target. **This remains the highest-value output of Phase 0.** Peter has deferred the choice (Open Item 24); Phase 0 supplies the evidence for the discussion he asked for, and recommends nothing.
3. **Re-engagement attempts per week**, beside his 104.84, with the expected undercount from nurture emails quantified.
4. **The three follow-up numbers per week** — touches (split worked / automation), sequence depth, and first-touch-within-1h — computed on the **close week** with the 10-day hold (Design Decision 42), for eight *settled* weeks.
5. **The count of leads parked in a non-terminal stage**, as a share of the object — the blind-spot figure from Design Decision 27.
6. ~~**Confirmation that the `HUBSPOT_PRIVATE_APP_TOKEN` can actually read leads, deals and tasks.**~~ **Done 2026-09-11 — see "Read This First" item 3.** All required endpoints return 200 against the tool's own token. Nothing is gated on it.
7. **New: the unmatched-workflow count** (Design Decision 41) — automation tasks in the window whose `hs_object_source_detail_1` matched no configured alias. Phase 0 must report this as a number, because it is the early-warning signal the whole config design rests on, and it should be verified to read **0** before shipping, not discovered at 400 six months later.
8. **New: a re-read of each configured workflow's current name** from `/automation/v4/flows/{id}`, compared against the display name in config. Should report "no drift" on day one.

**The gate.** If the numbers land in the same neighbourhood as Peter's, build it. If past-lead conversion comes back at a number that makes the ≥5% target arithmetically unreachable, **do not build that metric as a percentage** — report the finding and have the conversation about what the target should be, because shipping a metric that structurally reads "failure" every week teaches Peter to ignore his own scorecard.

**One gate that is already decided and does not need re-testing.** The follow-up *completion rate* — over all tasks and over workflow-generated tasks per enrollment — has now been measured on real data and pins at ~100% both ways (Design Decision 29). **Phase 0 should not re-litigate it.** If anyone proposes reviving it, the numbers are in this document: 423 of 434, 75 of 81 enrollments at exactly 100%, 12 of 16 weeks at exactly 100.0%.

### 39. The workflow really does produce 11 touches — but 11 is a ceiling, not a denominator

**Decision: the sequence's full length is 12 task actions (11 outreach touches plus one triage task). Do not use it as the bottom of a fraction. Report depth reached against it as a range, not a completion percentage.**

The brief asked whether the name is honest, given that the v3 definition shows 7 actions. **The name is honest and the v3 definition is wrong** — see the workflow-layer section above. Read from `/automation/v4/flows/4259746541`, the flow has 27 actions of which **12 create tasks**:

| Step | Task | Type |
|---|---|---|
| 1 | New lead assigned. Day 1 - Text | TODO |
| 2 | New lead assigned - Day 1 call | CALL |
| 3 | New Lead assigned - Day 1 Email (Follow up) | EMAIL |
| 4 | Day 2 - Connect with new lead - Call | CALL |
| 5 | Day 2 - Connect with new lead - text | TODO |
| 6 | Day 3 - Connect with new lead - Call | CALL |
| 7 | Day 3 - Connect with new lead - Email | EMAIL |
| 8 | Day 4 - Connect with new lead - Email | EMAIL |
| 9 | Day 5 - Connect with new lead - SMS | TODO |
| 10 | Day 6 - Connect with lead - Final Email | EMAIL |
| 11 | Day 6 - Connect with lead - Final Call | CALL |
| — | **Assign Lead - Cold/Warm/Hot** | TODO — *triage, not a touch* |

**Eleven outreach touches exactly, plus one internal triage task.** "11 touches - Testing Phase" is a precise name. The live data confirms every step: enrollments with all 12 tasks exist, with step indices `[0,2,4,7,9,12,14,17,20,23,24,26]`.

**Why 12 is nevertheless the wrong denominator.** Four `LIST_BRANCH` gates end the sequence early the moment the lead resolves, and **a task not reached is never created** — it is not an incomplete task, it is an absent one. Observed distribution of tasks per enrollment:

| Tasks created | Enrollments |
|---|---|
| 1–2 | 8 |
| **3** (Day 1 only) | **38 — 47%** |
| 5 | 7 |
| 7–9 | 13 |
| **11–12** (full sequence) | **15** |

**Nearly half of all enrollments end after Day 1**, and most of those ended well: 3-task enrollments are concentrated in `OPEN_DEAL` and `CONNECTED`. A "3 of 12 = 25% complete" reading would score the single best outcome in the dataset as a three-quarters failure.

**Two further properties of the flow, both load-bearing:**

- **`shouldReEnroll: false`.** One enrollment per contact, ever. A returning prospect — the Irsula Castillo case in Design Decision 31 — gets a *second lead record* but **not** a second follow-up enrollment. So this metric and the past-lead metrics count different populations, and the page must not imply they are two views of the same funnel.
- **The flow explicitly excludes APM leads.** Its enrollment criteria carry a `NOT_IN_LIST` filter on `WORKFLOWS_ENROLLMENT` id `36585716` — the APM workflow. The two new-lead streams are mutually exclusive **in HubSpot's own configuration**, which settles Open Item 27's mechanics: they cannot double-count, and a blended figure would be a weighted average of two deliberately separated cadences.

### 40. The two workflows are not equivalent, must not be blended, and one of them barely exists

**Decision: report `New lead follow up - 11 touches` (v4 `4259746541`) as the follow-up metric. Do not give `PMW Incoming Call leads` (v4 `3950514911`) its own line or fold it into a blended figure. Carry it as a lead-source tag instead.**

The brief asked whether one blended number or two, and what breaks either way. Reading both definitions from v4 settles it more firmly than a judgment call:

**`PMW Incoming Call leads` is not a follow-up sequence.** Its 7 actions are: two extension calls, set lifecycle stage to MQL, set `hs_lead_status = NEW`, set owner to Kristen, send an internal notification email to Peter/Kenya/Jackie/Kristen, and create **exactly one task** — *"New Inbound Call - Contact Created - add notes."* That is a data-hygiene task on a routing workflow. There are no delays, no branches, no cadence. It has produced **9 tasks across 5 contacts since 2026-05-01** — one of them in September.

**And it feeds directly into the other one.** Its action 10 sets `hs_lead_status = NEW`, which *is* the 11-touches workflow's enrollment trigger. Verified on real records: **4 of its 5 contacts (80%) also carry 11-touches tasks.** The two workflows are chained, not parallel.

**What breaks under each option:**

- **Blended into one rate** — the same lead is counted in both halves, the 1-task admin item is averaged against an 11-touch cadence, and the denominator is polluted by a task that is not outreach. Every number moves and none of them means anything.
- **Two separate rows** — the PMW row reports on roughly one task a month. At that volume a single task moves it 100 points. It is a row that will be wrong-looking most weeks and ignored the rest.
- **Recommended: one row, sourced from the 11-touches workflow, with PMW carried as a lead-source label on the enrollments it fed.** Nothing is lost — PMW's contribution is fully visible in the one task it creates and in the enrollments it triggers — and no number is invented at a volume that cannot support one.

**The configuration must still support the second workflow**, and the other three Peter excluded (`APM leads`, `PPC campaign leads`, `Geek Leads`), because "still need work" is a temporary state. Adding one is a config entry, not a rebuild — Design Decision 41.

### 41. Match workflows on id, keep the name for humans, and surface unmatched tasks

**Decision: configuration is keyed on the workflow's **v4 flow id**, carries its v3 id and a list of known name aliases, and the job reports a count of automation tasks whose source name matched no configured alias.**

The brief asked me to note the rename risk plainly, citing the Aircall line-ownership lesson. **It is stronger than a risk. It has already happened, to one of the two workflows Peter selected.**

`hs_object_source_detail_1` on a task is a **snapshot of the workflow's name at the moment the task was created**, and it is never updated. The task data shows the same workflows under multiple names:

| Current workflow name | Names found on its tasks |
|---|---|
| `PMW Incoming Call leads - Active` | `PMW Incoming Call leads - Testing Phase` (6 tasks) **and** `PMW Incoming Call leads - Active` (3 tasks) |
| `APM leads - New lead follow up touches - active` | `APM leads - New lead follow up touches - In progress` (374 tasks) |
| `Geek Leads - Active` | `Geek Leads - Under Test Phase` (1) **and** `Geek Leads - Active` (5) |

A task created on **2026-09-11** still carries `APM leads - New lead follow up touches - In progress` while the workflow is currently named `- active`. **Name matching on `PMW Incoming Call leads - Active` today finds 3 of its 9 tasks and silently loses the other 6.** This is the fourth time stale configuration has produced a wrong number in this project, and it is the only one that was already wrong before anybody wrote the code.

`Testing Phase` in the live workflow's name is therefore not a cosmetic oddity. Peter confirms the workflow is live and real, and the name is accurate about the cadence — but **the name is the one part of it guaranteed to change**, because it advertises a temporary state. The rename from `Testing Phase` to `Active` is a matter of when.

**The complication, and why this is not simply "match on id":** the task does **not** carry a workflow id. `hs_object_source_id` holds `enrollmentId:<N>;actionExecutionIndex:<N>`, `hs_object_source_detail_2` and `_3` are null, and there is no other source field. **Name is the only join key HubSpot gives the task.** So:

- **Config is keyed on the v4 flow id** — the durable identifier, used to fetch the definition and to key the stored rows. The v3 id is carried alongside because the two APIs do not share ids and some checks need v3.
- **Each entry carries an `aliases` list** — every name the workflow has ever been saved under. Task matching runs against the alias list, not against one current name. Adding a rename is one string.
- **The current name is carried as a display field**, for the page and for anyone reading the config. It is never the matching key.
- **The job counts automation tasks whose `detail_1` matched no configured alias and shows that count on the page.** A rename then appears as a visible "unmatched" figure rather than as a metric quietly falling toward zero — the same refusal-to-hide-the-residue as Design Decision 27's parked-leads count and the classification spec's `Unknown` column.
- **The weekly job re-reads each configured workflow's current name from `/automation/v4/flows/{id}` and flags a mismatch against the stored display name.** A rename is then detected the week it happens, by the tool, not six months later by archaeology. This is the piece the Aircall line-ownership work had to reconstruct by hand and could not.

**Seed configuration:**

| v4 id | v3 id | Display name | Aliases | In metric? |
|---|---|---|---|---|
| `4259746541` | `36143443` | New lead follow up - 11 touches - Testing Phase | *(as displayed)* | **Yes** |
| `3950514911` | `31570873` | PMW Incoming Call leads - Active | + `PMW Incoming Call leads - Testing Phase` | Source tag only (DD 40) |
| `4288923329` | `36585716` | APM leads - New lead follow up touches - active | + `...- In progress` | No — "still needs work" |
| `4265048812` | `36226104` | PPC campaign leads - to new - active | — | No — "still needs work" |
| `615829021` | `66034306` | Geek Leads - Active | + `Geek Leads - Under Test Phase` | No — "still needs work" |

Same exported-constant-with-a-dated-comment pattern as Design Decision 34, and same reasoning for rejecting a config table.

### 42. Enrollment maturation: count an enrollment in the week it closes, and hold the week ten days

**Decision: an enrollment belongs to the week its **last task was completed**, not the week it started. A week is not published until **10 days** after it ends.**

The brief asked how the weekly figure avoids punishing a Friday enrollment whose touches are mostly still pending on Monday — the same cohort-maturation trap Design Decision 27 avoided on booking rate by counting leads in the week they resolve. The answer is the same shape, and the data says how long the hold needs to be.

Measured across the 81 enrollments:

| | |
|---|---|
| Days from first task to **last task created** | median 0.0, p75 2.8, p90 4.8, **max 5.8** |
| Days from first task to **last completion** | median 1.0, p75 4.0, p90 7.0 |
| Enrollments fully closed within **3 days** | 67% |
| Enrollments fully closed within **7 days** | **93%** |
| Enrollments fully closed within **10 days** | **98%** |
| Enrollments fully closed within 14 days | 98% |

The cohort view shows the trap directly: enrollments **started** per week and enrollments **closed** per week diverge badly — 8 started and 2 closed in the week of 2026-05-25; 4 started and 9 closed in the week of 2026-09-07. **A start-week metric reports on work that has not happened yet.**

**Ten days, because 98% is where the curve flattens** — 7 days catches 93% and 14 days catches nothing more than 10 does. So the Monday job computes the week that ended **10 days ago**, not the week that ended yesterday. The page's most recent complete figure is roughly a fortnight old, and the page says so.

**What this costs, stated plainly.** It is slower than the booking-rate lag, and it means the follow-up row and the booking row on the same page refer to different weeks. **They must be labelled with their own week, not stacked under one date header.** The alternative — publishing immediately and marking in-flight enrollments — was rejected for the reason Design Decision 32 gives: a figure that changes after it is published rewrites history, and this one would rewrite it in the direction of flattery, since a pending touch always resolves as completed.

The 2% that never close within 10 days are counted in the week they eventually close, however late. None is dropped.

---

## Governance — Assessed, Not Inherited

The classification spec concluded: not a compliance build by construction, because only aggregate counts are stored, with a scoped Asimov review to confirm the property is real and stays real. **I reach the same conclusion, and I want to be explicit that I did not simply copy it** — this build reads a different object, and one of the reasons the earlier conclusion held does not automatically hold here.

**Against `CLAUDE.md`'s three triggers:**

**1. Sends messages to tenants or owners — No.** Read-only against HubSpot, permanently. Nothing is sent, drafted, or queued. Note that this tool *counts* outreach that Rincon's own workflows perform; it does not perform or trigger any of it.

**2. Makes or influences a decision about an applicant or tenant — No, and here the reasoning genuinely differs from the classification spec.** The subjects are prospective property-management clients — property owners. No unit is allocated, no application screened, no approve/deny made or influenced.

> **But the tenant tripwire is live here in a way it was not there.** Mason's concern in the classification spec was that prospective *tenants* are a different matter from prospective management clients, and that extending classification to the Leasing Line would cross that line. **In this build, tenants are already inside the source data**: `hs_lead_disqualification_reason` carries a Rincon-added value `Tenants`, which exists precisely because tenants end up in the lead pipeline and have to be thrown out.
>
> **Design Decision 34 is the answer, and it is a mechanism rather than a reassurance.** Leads disqualified as `Tenants` or `Vendor` are removed from both halves of every metric before anything is computed. No tenant-flagged lead contributes to any number this tool produces. That rule is the reason the answer to trigger 2 is "no" rather than "probably" — and it is therefore not a tidy-up detail, it is load-bearing, and removing it would change this build's compliance status.
>
> Residual, stated honestly: an un-triaged tenant sitting at "Connected" is invisible to the rule — but also invisible to the metrics, since Design Decision 27 counts only resolved leads. Neither rule alone is a guarantee; together they are tight. TARS checks this for real (below).

**3. Stores someone's personal information — No, by construction.** Only `metric_key`, `week_start`, `owner_scope`, and two integers are written. No lead name, no contact ID, no lead ID, no phone number, no email. Two specific places where the temptation arises are named and refused: Design Decision 31's `hs_primary_contact_id` join key (in memory, discarded) and Design Decision 29's deferred reschedule count (would require storing task IDs, and is therefore deferred rather than quietly built).

**`owner_scope` is worth a sentence, since it is the one column that names a person-shaped thing.** In v1 it holds the literal string `'business_development'` — a function, not a person. If it is ever populated with a staff member's email it becomes employee performance metadata, which is the same category `call_stats` already honestly declares itself to be. That is a change in the table's inventory, not a change in its compliance status, and the migration header should say so.

### Recommendation

**Asimov: yes — a short, scoped pre-check before this ships. Not the full 18-step pipeline.**

Consistent with the classification spec, and for one added reason specific to this build:

1. **Same durable question as before:** is the "no outside-person data is stored" property real, and what keeps it real? It is a property of the code, and one debugging change away from being gone.
2. **A second question this build adds:** Design Decision 34's tenant exclusion is now part of *why* the answer to compliance trigger 2 is no. That is a governance rule living inside a config constant, and it deserves to be registered as a standing constraint rather than surviving on the strength of a comment.

This is not inflation. It is one short session covering two named, durable properties — not a review of the feature.

**Mason: no for v1 as scoped — conditional on Design Decision 34 shipping as specified.** No housing decision, no applicant, no tenant contributing to any output, nothing tenant-facing, no generated communication. **If the tenant/vendor exclusion is dropped, weakened, or made optional, that answer changes and Mason reviews before it ships.** That is the condition, stated so it cannot be missed.

**Sentinel: yes, briefly — and now with a definite scope, not a speculative one.** *(Updated 2026-09-11.)* The classification spec said "no" because it reused an existing token under an already-granted scope. This build no longer *might* need new scopes: **Peter widened the production `HUBSPOT_PRIVATE_APP_TOKEN` on 2026-09-11**, and it now reads leads, deals, tasks, meetings and the automation/workflow APIs where before it read contacts. That widening has already happened, on the live credential, and the same token is used by Call Stats. New reach on a production credential is exactly what Sentinel exists to look at — a short pass, not a full review, and it should note two things specifically:

1. The widening is **already live and is not confined to this build** — anything holding that token can now read leads, deals and tasks.
2. The workflow endpoints (`/automation/v3/workflows`, `/automation/v4/flows`) return **full workflow definitions**, including the internal notification recipient list on `PMW Incoming Call leads` (four staff email addresses, read during this investigation). That is staff data, not prospect data, and this design stores none of it — but it is now readable by the tool, and Sentinel should confirm the read module never persists a definition.

**`GOVERNANCE.md` Rule 4 applies and produces a full inventory**, since this is a new table:

- **`pii_fields`:** none. `owner_scope` holds a function name in v1, not a person.
- **`agents_with_access`:** the weekly sync (system, service-role key); any Hub user holding `admin` or `pod_lead` for `tool='scorecard'`.
- **`privacy_category`:** aggregate business-performance metadata. Not tenant/applicant data, not Fair Housing–relevant, and — unlike `call_stats` — not personal to any individual in v1.
- **`retention_policy`:** indefinite, matching the decision Peter already made for `call_stats`.
- **`ccpa_exportable` / `ccpa_deletable`:** N/A — no contact record, no identifier, nothing for a CCPA scan to reach.
- **RLS:** enabled, no permissive policies at creation, matching every table in this schema.
- **Audit logging:** none, matching `appfolio_property_actuals` and `call_stats`. A fetched-and-summed fact.
- **The one sentence the migration header must carry:** that these counts are computed from lead records this schema deliberately does not retain, that the tenant/vendor exclusion is a governance control and not a filter of convenience, and that adding any column holding a lead, contact or task ID changes this table's compliance status.

**Rule 6 (Change Management):** Standard tier — metric definitions, not decision criteria, not compliance logic, not permission tiers. Peter's approval satisfies it. **One exception:** Design Decision 34's exclusion list is compliance logic under this analysis, and changing it should be treated as Critical.

**Rules 1, 2, 3, 5, 7, 8, 9, 10:** not engaged. No agent decision, no screening, no SMS, no housing criteria, no runtime agent lifecycle, no permission tiers, no protected-class data anywhere in the design, no contact records stored for a CCPA cascade to reach.

---

## Who Builds What

- **Q — Phase 0, ~half a session, and nothing else starts until it reports.** The read-only measurement script of Design Decision 38. ~~Including the credential-scope check that gates everything~~ — **that check is done and passed (2026-09-11); Phase 0 is no longer gated on it.** Writes nothing.
- **Peter — one deferred discussion, not a blocking decision.** Open Item 22 is closed (he added the scopes). Open Item 23 is closed (he approved booking rate). **Open Item 24 he has explicitly deferred** — it needs a conversation, not an answer today. Open Item 27 is now largely answered by the data (Design Decision 40) and needs only his nod.
- **Neo — ~half a session, blocked on Phase 0.** One new table, one CHECK constraint on `metric_key` — now **six** keys, not four (Design Decision 29 splits follow-up into three) — one `team_member_tool_roles` CHECK widening for `'scorecard'`, the Rule 4 inventory, and the boundary statement in the header. No existing table is touched. Take a timestamp after the classification migration.
- **Q — ~2 sessions** *(up from 1.5)*. The new `hubspot-leads-connector.js` under the CRITICAL rule; fixed-shape read functions — now including one for `/automation/v4/flows/{id}` (the name-drift check of Design Decision 41); the six metric computations; the tenant/vendor exclusion constant; **the workflow config constant with v4 id, v3 id, aliases and display name**; the enrollment grouping on `hs_object_source_id`; the 10-day publication hold; the weekly job with the write-nothing-on-failure path; the `GET /api/scorecard/metrics` route.
- **Tron — ~half a session.** One page, **six rows** across four metric groups, numerator and denominator visible on every rate, target beside each, the eight-week history, the "counted from" date, the parked-leads figure, **the unmatched-workflow count, and a per-row week label** (the follow-up rows are a different week from the booking row — Design Decision 42). Two standing traps on Hub pages: wire every control with `addEventListener` and never inline `onclick` (the Hub's CSP sets `script-src-attr 'none'` and kills inline handlers silently), and mind the 1000px width.
- **TARS — mandatory, and specific.** Not "does the page load."
  - (a) A week's booking-rate numerator and denominator match a hand count of the leads that resolved that week.
  - (b) **A lead disqualified as `Tenants` appears in no numerator and no denominator of any metric** — the governance control, tested directly.
  - (c) The Irsula Castillo pair (leads `836904086243` and `842564038384`, contact `545009814254`) is counted as exactly **one** past-lead conversion.
  - (d) A forced HubSpot failure writes **no row**, not a row of zeros, and re-running the week fills it in.
  - (e) Weeks before the first run render blank, never as zero.
  - (f) No lead ID, contact ID, task ID, **enrollment ID**, name, email or phone number appears anywhere in `scorecard_weekly` or in the routine sync logs. *(Enrollment IDs are new in this revision and are prospect-identifying by association — they are a grouping key held in memory, exactly like `hs_primary_contact_id` in Design Decision 31, and must be discarded the same way.)*
  - (g) Deal-stage reads use `hs_is_closed_won` / `hs_is_closed_lost` and never the string `closedlost`.
  - (h) **New — the alias matcher catches the known rename.** `PMW Incoming Call leads` has tasks under both `- Testing Phase` and `- Active`; the matcher must return **9**, not 3. This is a real regression test against real records, not a hypothetical.
  - (i) **New — an automation task from an unconfigured workflow increments the unmatched count and enters no metric.**
  - (j) **New — workflow definitions are read from `/automation/v4/flows/{v4id}`, never `/automation/v3/workflows/{id}`.** The v3 view reports 7 actions for a 27-action flow; a reader who takes v3 as truth undercounts the sequence by three quarters. Assert the flow returns 12 task actions.
  - (k) **New — an enrollment whose last task completed 3 days ago is not yet published**, and appears once the 10-day hold elapses (Design Decision 42).
- **Asimov — the scoped pre-check above, before this ships.**
- **Sentinel — short pass on the widened token**, per the Governance section. The scopes are now known and already live, so this is no longer waiting on anything.
- **Judge — sign-off before this is called done**, per the pipeline.

---

## Open Items — Needs Answering Before This Gets Built

*Numbering continues from `SALES-VS-OPERATIONAL-CLASSIFICATION-SPEC.md`, which ended at 21.*

22. ~~**Can `HUBSPOT_PRIVATE_APP_TOKEN` read leads, deals and tasks?**~~ — **CLOSED 2026-09-11.** Peter added the scopes; verified against the tool's own token. Contacts, leads, deals, tasks, meetings, `/automation/v3/workflows` and `/automation/v4/flows` all return 200. Sequences remains 404 and does not matter.
23. ~~**Does Peter accept Design Decision 27's booking-rate definition?**~~ — **CLOSED 2026-09-11. Peter approved it as written:** leads resolved as Qualified ÷ leads resolved at all, counted in the week they resolve. Produces 70.6% on recent data against his hand-kept 71.86%. The exact formula was never reproducible and the approval does not claim it was. **This definition is settled and should not be reopened without a deliberate decision.**
24. **Which denominator for past-lead conversion? — OPEN, AND DEFERRED BY PETER.** His words on 2026-09-11: *"needs more research/discussion."* **No recommendation is made here, deliberately.** Both candidates stay documented:
    - **Denominator A — the 411-lead past-lead population.** Gives Peter's hand-kept **0.58%**, i.e. about 2.4 conversions a week.
    - **Denominator B — weekly re-engagement attempts (~105).** The same underlying conversions against the smaller base give roughly **2.3%**.
    **Both are under his ≥5% target**, so the choice of denominator no longer decides pass/fail the way the 2026-09-10 draft argued it did — it only decides *how far* under. That is the substantive change: **the target itself may need revisiting, not just the denominator.** Reaching 5% under B means about 5 conversions a week; under A, about 20 — more than Rincon's entire new-deal throughput. Flagged as part of the discussion Peter asked for, **not as a recommendation.** Phase 0 supplies both series over eight weeks so the conversation runs on numbers.
25. **Should lead ownership be assigned deliberately rather than inherited from the contact?** Until it is, per-person attribution is not possible and Design Decision 33 stands. This is a change to one HubSpot workflow, not to this tool.
26. **Does Peter want the "tasks rescheduled past their original due date" count?** Still deferred in v1 — **but the stated reason was wrong and is now corrected.** The 2026-09-10 draft said HubSpot does not expose it. HubSpot exposes `hs_task_missed_due_date` and `hs_task_missed_due_date_count`, which look like the answer and are not: the count **never exceeds 1** anywhere in the portal (0 of 26,233 tasks), so it is a boolean, and it is `true` on 91% of Kristen's tasks purely because workflow tasks are due-immediately. A genuine reschedule count still requires storing task IDs weekly, still makes this a compliance build, and still needs Asimov first. Deferred deliberately, not dropped.
27. **Should the two new-lead streams be reported separately? — LARGELY ANSWERED by Design Decision 40; needs only Peter's nod.** The data settles the mechanics: the 11-touches workflow carries an explicit `NOT_IN_LIST` exclusion on the APM workflow, so the two streams are **mutually exclusive in HubSpot's own configuration** and cannot double-count. They remain genuinely different — one task body says outright that Rincon pays to be first to the APM contact. The recommendation is one row on the live workflow with lead source carried as a label, and APM added as configuration when Peter says it is ready. **What still needs his call:** whether APM gets its own row once it graduates from "still needs work."
28. **New — when does `New lead follow up - 11 touches - Testing Phase` get renamed, and who tells the tool?** Peter confirms the workflow is live and real despite the name. The name advertises a temporary state, so the rename is a matter of when, not if. Design Decision 41 handles it without breaking (aliases + an unmatched count + a weekly name-drift check), so **this is not a blocker** — it is a note that when the rename happens, one line of config should be updated, and the tool will have already flagged it. **The same question applies to the four excluded workflows Peter said "still need work":** there is no signal today that tells the tool one has graduated. That is a human handoff, and it belongs in `COMMITTED-NOT-BUILT.md` rather than in code.

**Answered by this investigation, and closable elsewhere:** `SALES-VS-OPERATIONAL-CLASSIFICATION-SPEC.md` **Open Item 17** — only the `default` pipeline is in use (1,631 deals; RentScale 0, Smartlead 0, House Hack 5 from 2023). It does not need the marketing manager.

Carried forward and untouched: `SPEC.md` Open Items 3, 4, 7, 8; `answer-rate-redefinition-SPEC.md` Open Items 9–14; classification spec Open Items 15, 16, 18–21.

---

## Rough Build Size

**Small — smaller than the classification build, with more thinking already done and less code to write.**

| | Effort |
|---|---|
| ~~Credential check~~ | **done 2026-09-11 — passed** |
| Phase 0 measurement (Q) | ~half a session — **blocks everything else** |
| Peter's decisions | Open Items 22 and 23 are closed. **24 is deferred to a conversation.** 27 needs a nod. |
| Neo | ~half a session — one table, two CHECKs (six metric keys, not four), one inventory |
| Q | **~2 sessions** — up from 1.5: workflow config with aliases, the v4 definition read, enrollment grouping, the 10-day hold |
| Tron | ~half a session — six rows, per-row week labels, unmatched count |
| TARS | **~three-quarters of a session** — up from half: four new checks, including the PMW rename regression |
| Asimov | scoped pre-check, well under a session |
| Sentinel | short pass on the already-widened token |
| Mason | none, conditional on Design Decision 34 shipping intact |

No new external service. No new credential — **the existing one was widened by Peter on 2026-09-11 and now has everything needed.** No change to any existing table. No backfill.

---

## Plain-English Summary for Peter — written 2026-09-10

> **Read the 2026-09-11 update at the bottom of this file first.** Three things below have changed: the permissions question (item 3) is solved, the booking-rate question (item 2) you've now answered, and the follow-up swap (item 1) turned out to need a different answer than the one I proposed. The rest still stands.

**What you'd get.** Four of the eleven lines on your weekly scorecard — Kristen's four — counted for you every Monday morning instead of by hand, with the last eight weeks beside them. It reads HubSpot only, never writes to it, and never stores a prospect's name, number or record.

**The good news first.** Your HubSpot has a "Leads" section that is in much better shape than the contacts list. There are 1,265 leads, every one created automatically when somebody at Rincon genuinely promotes an enquiry. **The junk from the Aircall bug never becomes a lead** — I checked: about 1,275 junk contacts got created since June, and only 120 leads. So all four of these metrics sit on clean data. That's why they were the right four to pick.

Also: you have four sales pipelines and we'd been waiting on your marketing manager to say which ones count. **The data answers it — only one is actually used.** The other three have zero, zero, and five deals from 2023. That question is closed.

**Now the three things I'd rather tell you now than after building.**

**1. One of the four shouldn't be built the way it's written.** "Lead follow-up completion rate" is at 100% and it will be at 100% every week forever. Kristen has 2,513 tasks in HubSpot. 2,476 are done. **Not one is overdue** — not one, ever. That's genuinely impressive and I don't want it read as criticism. But a number that can only ever say 100% isn't telling you anything in a meeting. I'd swap it for a straight count of follow-up touches she completed that week, which actually moves — it was 84, then 145, then 140 over the last three weeks — and I'd split out how many were the automated ones so a busy week of software doesn't look like a busy week of Kristen. **That swap is yours to approve. I haven't assumed it.**

**2. "Kristen booked a call with Kenya" isn't recorded anywhere.** Prospects book through Kenya's calendar link, and HubSpot stamps every one of those with Kenya's name as both owner and creator, no matter who made it happen. And most of the time there's no calendar record at all — of the 364 leads marked "Qualified," only 36 have a meeting attached. So I can't count bookings directly. What I *can* count, and count well, is whether the enquiry reached the stage that means the call with Kenya actually happened. On your recent data that comes out at **70.6%**, which is within a point and a half of the 71.86% you've been tracking by hand. I think that's your number, but I couldn't reproduce your exact arithmetic and I'm not going to pretend I did — **I need you to confirm that's the definition you want.** The one thing it misses is a prospect who books and then no-shows: you'd count that as Kristen doing her job, and this wouldn't.

**3. There may be a small HubSpot permissions job for you.** I did this investigation through a different connection than the one the tool uses. The tool's own key was set up to read contacts and calls, and these four metrics need to read leads, deals and tasks. You may need to tick three more boxes in HubSpot's settings. It's five minutes if it's needed — but it's worth finding out on day one rather than after we've built.

**The most interesting thing I found.** Your "past lead conversion rate" looks like 0% if you measure it the obvious way — and that's wrong. When an old lead comes back, HubSpot doesn't wake the old record up; **it creates a brand-new lead for the same person.** I found a live example: Irsula Castillo has two lead records, August and September. The August one went cold under Kristen. The September one is the same human being, it converted, and it's sitting under Kenya's name. So re-engagement *does* work, it just leaves its evidence in two places, and you'd never see it on a standard report. I can count it properly by matching the two records to the same person.

**Which brings up the thing I'd want you to think about.** That same example is why I'd hold off on reporting these as "Kristen's numbers" per se. HubSpot doesn't record who did the work — it just copies whoever happens to own the contact. So the failed lead is Kristen's and the successful one is Kenya's, for the same prospect. If I filter by name, I'd credit Kenya with Kristen's wins and charge her with the losses that came first. For now I'd report them as the business-development function's numbers, which Kristen owns and reviews — and build it so switching to per-person is a five-minute change later. **Making that real is a small change to one HubSpot workflow — assigning lead owners on purpose instead of letting HubSpot guess — and that's your call, not a software problem.**

**One decision I genuinely can't make for you.** Your past-lead conversion target is 5% and you're tracking 0.58%. Whether that's a crisis depends entirely on what you're dividing by, and I can't tell from the data which you meant. If it's "out of all 411 old leads sitting in nurture," then hitting 5% would mean about 20 conversions a week — which is more than Rincon signs in three months. That target would be unreachable by arithmetic, and the metric would read "failure" forever. If it's "out of the roughly 105 re-engagement attempts we make each week," that's about one conversion every ten days, which matches your actual deal flow, and 5% is a stretch but a real one. **The two readings differ by about four times.** I'd rather compute both on your real numbers first and show you them side by side than pick one and have you find out in a meeting.

**What I'd do next.** Half a day, writing nothing and changing nothing: run all four definitions over the last eight weeks and put them next to your hand-kept figures, and check the HubSpot permissions question. Then you look at eight real numbers instead of my description of them, and we decide. If they're in the right neighbourhood, the whole build is about three days across the team.

**How big.** Small. Half a day to check first, half a day of database work, a day and a half of building, half a day of front-end, half a day of testing. No new logins, no new services, no change to anything already running. It needs one short governance check from Asimov before it ships — same reason as last time, plus one new one: the rule that keeps tenants out of these numbers is doing real legal work, and I want it written down somewhere it won't get deleted by someone tidying up.

**And one thing I'll flag rather than bury.** Your numbers here are small. About seventeen leads reach a conclusion in a fortnight. One prospect who stops returning calls moves the booking rate about six points. The page will show you "12 of 17" and not just "71%" for exactly that reason — read it weekly if you like, but judge it on a month.

---

## Plain-English Update for Peter — 2026-09-11

**What changed.** The permissions you added on Thursday worked. I checked the tool's own key directly — not a different connection like last time — and it can now read everything these metrics need: leads, deals, tasks, meetings, and the follow-up workflows themselves. **That was the one thing blocking us, and it's gone.** I also marked your booking rate as settled, since you approved it.

**Is follow-up completion worth building? No — and I now know that rather than suspecting it.**

Last week I told you the follow-up completion rate is stuck at 100% and suggested we look at it per-workflow instead, in case a narrower view had some life in it. **I've now built that and measured it.** Across every lead that has gone through your "11 touches" follow-up sequence since May — 81 of them, 434 tasks — Kristen completed **423 of 434**. Seventy-five of the eighty-one leads are at exactly 100%. Twelve of the sixteen weeks are at exactly 100.0%. The handful below that are leads still in progress. **Narrowing it didn't help. There's genuinely nothing there to measure.**

Two corrections to what I told you, because I'd rather you hear them from me:

- I said **not one** of Kristen's tasks was overdue, ever. Re-checking today, it's **five out of 2,535**. Still essentially perfect — and worth knowing that across your whole HubSpot it's 830 out of 26,000, so that near-perfect record is hers, not the software's. But "not one, ever" was too strong and I shouldn't repeat it in a meeting.
- I proposed replacing the completion rate with a **count of follow-up touches**. I've since checked whether that count means what I assumed, and **it runs backwards.** The workflow stops sending touches the moment a lead responds. So a lead that signs up on day one gets three touches, and a lead that ignores you for a week gets eleven. Measured: leads that turned into deals averaged **4.7 touches**; leads that went nowhere averaged **7.0**. Put that on your scorecard as "follow-up quality" and Kristen's best possible week would show her worst-looking number. I'm glad I checked.

**What I'd put there instead.** Three plain numbers, no percentage:

1. **How many follow-up touches got done that week** — labelled as activity, not quality.
2. **How far leads got through the sequence before they resolved** — with lower being generally better, said out loud on the page.
3. **How often the first touch happened within an hour of the lead arriving.** This is the one with real information in it. Right now: **8% within five minutes, 31% within an hour, 53% within four hours** — median just under three hours. That's a wide spread on a business where one of your own task notes says you're paying to be first to the phone. **Honest caveat: I checked whether faster leads actually convert better, and at this volume they don't — 2.9 hours for leads that became deals versus 3.4 for the ones that didn't.** So I'd show it as a service standard, not as a money-maker, until there's more data.

**Two things worth knowing about your workflows.**

**"11 touches" is exactly right.** I was suspicious of the name, because HubSpot's older interface shows that workflow as only seven steps. That's the interface being wrong — the real thing has **eleven outreach touches plus one "sort this lead" task**, day one through day six. Your marketing manager named it accurately.

**The other workflow you picked isn't really a follow-up sequence.** "PMW Incoming Call leads" creates exactly **one** task — "add notes" — then sets the lead to New, which is what kicks off the 11-touches sequence. It's a doorway into the other one, not a parallel process. It's made nine tasks since May. I'd report the 11-touches workflow as your follow-up number and carry PMW as a label on the leads it sent in, rather than giving it a line of its own that would swing a hundred points on one task.

**And one thing I want to flag plainly, because it's bitten this project before.** HubSpot does **not** stamp a workflow's ID on the tasks it creates — only the workflow's **name**, frozen at the moment the task was made. So if anyone renames a workflow, the tool silently stops finding its tasks. **This isn't hypothetical: it's already happened.** "PMW Incoming Call leads" has tasks filed under two different names, because it used to be called "Testing Phase" and is now called "Active." If we matched on today's name we'd find three of its nine tasks and lose the other six without any error. Your "Geek Leads" and APM workflows have the same split. So I'm building it to match on the workflow's ID with every past name listed alongside, to show you a count of any tasks it couldn't place, and to check each week whether a name has changed — the same lesson as the phone-line ownership work, except here we can catch it automatically instead of digging through six months of history.

That also means **"Testing Phase" in the live workflow's name is a live tripwire.** You've told me it's real and running, and I believe you — but that name is advertising that it'll be renamed one day. When that happens, it's one line of config, and the tool will have already told us.

**One thing about timing.** A lead that arrives Friday still has most of its touches ahead of it on Monday. If I counted by the week leads arrived, every recent week would look bad and then quietly improve. So I'll count a lead in the week it **finishes** — the same way we settled the booking rate — and hold each week for **ten days** before publishing it. I picked ten because 98% of leads are fully finished by then and waiting longer gains nothing. The trade-off: **the follow-up rows on your page will refer to a week about a fortnight back, while the booking rate refers to last week.** Each row will say which week it's showing. I didn't want to hide that.

**What's still undecided — one thing, and it's yours.**

The **past-lead conversion denominator.** You said it needs more research and discussion, so I haven't decided it. Here's the arithmetic to have that discussion with: measured against all **411** old leads sitting in nurture, it's **0.58%** — your hand-kept figure. Measured against the roughly **105 re-engagement attempts** made each week, the same conversions come out at about **2.3%**.

**Your target is 5%, and both readings are under it.** So the choice of denominator doesn't decide whether you're passing or failing — it only decides by how much. That's different from what I told you last week, when I thought one reading made the target reachable and the other didn't. **It means the target itself is probably part of what needs discussing, not just the denominator.** Hitting 5% on the smaller base means about five conversions a week; on the bigger one, about twenty — more than Rincon signs in three months. I'm flagging that as something to talk about, not recommending a number.

**Where that leaves us.** Nothing is blocked. Booking rate is settled. Follow-up completion is dead as written and I've got three honest numbers to put in its place. The past-lead denominator is waiting on your conversation. Next step is still the same half-day of measuring-before-building — run everything over the last eight weeks, put it beside your hand-kept figures, and you look at real numbers before anyone writes a line of the actual tool.
