# Call Stats — Committed but Not Yet Built

**Purpose:** everything Peter has approved that is not finished. Nothing on this list
is a maybe — each item was explicitly agreed. Delete an item only when it ships and
passes TARS.

Last updated: 2026-09-12

---

## ✅ SHIPPED 2026-09-12 — answer rate, miss reasons, backfill

**Live on Sally.** Deployed 2026-09-12 after all ten Hub routers were smoke-tested for
startup failures (the deploy pushes the whole `projects/hub/` tree, including other
sessions' in-progress work — check this every time, it took the Hub down once before).

Final verified state: **185 days, 2026-03-10..2026-09-11, zero unmeasured rows**,
1,845 `call_stats` rows, 1,435 `call_stats_line_misses` rows, 3,631 misses, 1,350 voicemails.

| | Answered | Missed | Rate |
|---|---|---|---|
| Regina Franco Mendez | 302 | 31 | 90.69% |
| Shane Muir | 264 | 49 | 84.35% |
| Kristen Rau | 871 | 247 | **77.91%** |
| Leo O'Gorman | 849 | 260 | 76.56% |
| Liz Otero | 225 | 75 | 75.00% |
| Dio Lopes | 890 | 315 | 73.86% |
| Caylee Andrade | 823 | 306 | 72.90% |
| Marci Grey | 384 | 208 | 64.86% |

Every one of these read **100%** before this work.

**The deployment itself was the last bug.** Sally had been running a pre-2026-09-10 build,
so the nightly sync wrote 2026-09-11 with every attribution and measurement column NULL —
making the dashboard's default "Yesterday" view show all eight staff at 100% with 0 missed,
while Aircall had recorded 29 misses that day. Re-synced after deploy via
`POST /api/call-stats/internal/sync?date=2026-09-11`. **Lesson: an undeployed fix is not a
safe state — it was actively producing bad data nightly while we verified.**

**Judge was skipped**, deliberately, at Peter's call on 2026-09-12. TARS passed everything
substantive; Judge reviews code quality, not correctness. Worth running some quiet day.

**Still unexplained:** Kristen's hand-tracked 78.28% vs the measured 77.91%. TARS confirmed
it does not reconcile at any date window, and her 11 HubSpot-native calls do not close it.
0.37pp. Small, but nobody has accounted for it.

**Cosmetic, will be noticed in a meeting:** RSC Solimar Team renders "Leo O'Gorman
(0 answered, 2 missed)" against 1,317 total calls — correct, since 1,257 are Aldo's held-back
calls, but it reads badly at a glance. "Stephen" appears at 100% on a single call, and
`Z.DO NOT USE - PHONE TREE TEMPLATE ONLY` appears in Shared Line Misses.

---

## 1. Voicemails returned  ⟵ Peter specifically asked this not be forgotten

**Approved:** 2026-09-10. Peter asked for three voicemail metrics and confirmed all three.

| | Status |
|---|---|
| Voicemails left (count) | Covered by the miss-reason migration |
| Voicemail rate (% of misses leaving one) | Covered by the same migration |
| **Voicemails returned** | **Not started — this entry** |

**Why it is not built yet:** it reverses a founding design decision. The sync currently
counts calls and discards the individual records, so the database holds totals and no
personal data about callers. Matching a voicemail to a callback requires storing each
caller's phone number and the time they rang — tenants, vendors and prospects — then
looking for a later outbound call to that number.

Under `CLAUDE.md`'s definition ("stores someone's personal information") that makes it a
**compliance build**. Asimov reviews before it ships. Peter agreed to this sequencing on
2026-09-10 and simultaneously asked that it not be quietly dropped as a result.

**Open design questions, to be settled in the spec, not guessed:**
- How long a window counts as a callback?
- Does a callback by anyone count, or only by the person whose line took the voicemail?
- What happens when someone calls back several times?
- Retention — how long are caller numbers kept?

**Sequenced behind:** the miss-reason migration and the sales/operational matching spec,
because all three touch `call_stats_line_misses` and the sync. Not blocked on anything else.

---

## 0a. FINAL metric definitions, 2026-09-12 — these supersede CRM-SCORECARD-METRICS-SPEC.md

A read-only Phase 0 measurement against live HubSpot found that **two of the four metrics as
specced could not be built**, and corrected several of Oracle's figures. Build from this
table, not from the spec's definitions.

| Metric | Final definition | Measured |
|---|---|---|
| **Lead → discovery call** | Deals created ÷ leads created, **rolling 4 weeks**. A deal only exists once a discovery call has happened — "Discovery call complete" is the first stage of the only pipeline in use. | **62.8%** overall; rolling 50–64% |
| **Follow-up touches** | Count, labelled *activity*, split worked vs automation | worked flat 15–19/wk; automation 35–397 |
| **Sequence depth** | Median touches before a lead responds. **Lower is better, and the page must say so.** | deal 4.7 avg / no deal 6.5 |
| **Re-engagement attempts** | **Peter chose 2026-09-12:** completed tasks against leads in a past-lead stage — the strictest of three candidate readings (28 / 82 / 105 per week). | **28.5/wk**, 24.3 over last 8 |
| **Past-lead conversions** | **A count per quarter, not a percentage.** | **9 in the entire history since 2024-06-21** |

### Dropped, with reasons — do not reinstate without re-measuring

- **Booking rate as "Qualified ÷ resolved"** — arithmetically fine, but its denominator moved
  on *housekeeping*, not performance. Dead leads get written off in batches (6 in one
  afternoon). All three weeks it printed **100%** were simply weeks nobody did the clean-up.
  Weekly range 25–100% with a numerator that barely moved.
- **"First touch within 1 hour"** — measured, and it is the one cut of the latency
  distribution with **no outcome separation at all** (33% deal vs 29% no-deal, pointing the
  wrong way). The median does separate; the 1-hour threshold does not.
- **Past-lead conversion as a percentage** — 13 of the last 15 weeks have a numerator of
  zero. No denominator rescues it. The Open Item debating which denominator to use was the
  wrong question.

### Targets will look worse, and that is correct

Re-engagement's ≥25 target was set against a hand-count of ~105. The chosen definition
measures ~28 and dips below 25 in roughly a third of weeks. Peter confirmed the 5%
conversion target "was picked out of the air." **Reset every target from real baseline after
a few weeks of running** rather than carrying over targets set against different questions.

### Corrections to Oracle's spec figures — fix before anyone reads it as fact

Booking rate 70.6% (actual **64.5%** on the same window); the "520 lost-lead tasks" were
**two sequences**, not one; "~6 people/week re-engaged" was an arithmetic artifact of
dividing tasks by 9 — the real per-person figure is **~38.8/week**; parked leads "125, ~10%"
are actually **259, 20.5%**; and "name is the only join key HubSpot gives the task" is
**false for sequence tasks**, which carry `hs_task_sequence_id`.

### Two live data problems found in passing

- **Name matching would silently lose 49.6% of tasks today.** APM loses **100%** of its 422
  tasks, PMW 80%. There is a **third** PMW name with a **trailing space**, and eight workflow
  and sequence names in live data carry leading or trailing whitespace. Match on **id**,
  trim, and surface an unmatched count. DD 41's weekly name-drift check is **blind to this
  failure** — it compares today's config to today's live name and reports "no drift" while
  APM loses everything.
- **The DD 34 tenant exclusion is currently inert.** All 53 flagged leads are already
  Unqualified; the most recent resolved 2026-04-22; across 15 weeks it removed **zero** leads
  from **zero** denominators. Keep it as forward protection, but the governance write-up
  calling it "load-bearing" is wrong. Separately, it misses real junk — an Aircall-exhaust
  lead named `"+18058866848 Aircall new contact"` is sitting **in the Qualified numerator**.

---

## 0. Decisions 2026-09-12 — the scorecard becomes a business-wide Scoreboard

**Peter, 2026-09-12: this is for the business, not just Kristen's metrics.** Vacancy days,
collections, maintenance turnaround and the rest eventually live here too.

The design already accommodates that and should not be redesigned for it:
`(metric_key, week_start, owner_scope, numerator, denominator)` stores a **function** not a
person (`owner_scope` = `business_development`, not an email), and stores the **two raw parts**
rather than a computed percentage — so any metric that is "this over that" fits, and any
period can be re-derived later. Same discipline that made Call Stats survivable.

**Build the four CRM metrics as the first four rows of a Scoreboard, not as a Kristen page.
Do not design for metrics nobody has seen yet** — the general shape should earn its
generality from the second and third batch.

**It absorbs the trend-view work.** `TREND-VIEW-SPEC.md` describes metrics down the left,
periods across, an average column — which is the Scoreboard layout. Building a Call Stats
trend view *and* a Scoreboard means building the same thing twice.

**Call Stats stays where it is for now.** It shipped 2026-09-12 after two days of work and is
live. It can feed the Scoreboard once the shape has proven itself; moving working software
into a new structure on day one is how a week disappears.

### HubSpot credential scope change — recorded here because nowhere else records it

**2026-09-11, Peter widened the production `HUBSPOT_PRIVATE_APP_TOKEN`** to add read access
for **leads, deals, tasks, meetings and automation** (workflows). Sequences remained
unavailable (403).

**This is a shared credential.** Every Hub tool holding that token gained the same reach,
including tools whose security review predates the change. Asimov also noted the automation
endpoints return workflow definitions containing internal staff notification email addresses
— staff personal data that was not readable before.

**Sentinel review declined by Peter, 2026-09-12.** Recorded as his decision, not an oversight.
The exposure is live and unreviewed; this entry exists so that fact is written down somewhere
findable, per GOVERNANCE.md Rule 6.

---

## 1b. Working-hours window — the "layered" approach

**Approved:** 2026-09-10.

Two rules, layered. **Working hours decide when a person is accountable; the miss reason
decides what happened inside that window.**

- A miss outside working hours → charged to nobody, but stays visible.
- A `short_abandoned` inside working hours → charged to nobody (caller hung up, median 9 sec).
- A ring-out (`agents_did_not_answer`) inside working hours → charged to that person.
- `no_available_agent` **inside** working hours → charged to nobody, but surfaced as
  visible information rather than a silent pass. See why below.

**Kristen Rau's real hours, confirmed by Peter 2026-09-10:** 09:00–18:00, lunch 12:30–13:30.

**Why layered rather than reason-only.** Reason-only excuses a person whenever Aircall has
them marked away — which rewards being logged out. Measured on real data (2026-09-01..09-10,
Kristen's two lines), the toggle does NOT track her stated schedule:

- **9am carried the most `no_available_agent` misses — 7** — right at her start time,
  suggesting she logs in a little after 9.
- **1pm carried 5 `agents_did_not_answer`** — rang out with her marked *available*, during
  the lunch hour she is supposed to be away.

So the two rules genuinely disagree, and the schedule is the better description of intent.

**Everyone's hours, confirmed by Peter 2026-09-10:**

| Who | Hours | Lunch |
|---|---|---|
| Kristen Rau | 09:00–18:00 | 12:30–13:30, **fixed — excluded automatically** |
| Everyone else | 08:00–17:00 | Flexible — **no window excluded** |

**The lunch asymmetry is deliberate, not an oversight.** Kristen's fixed lunch is excluded
by schedule even on days she never marked herself away. Everyone else's flexible lunch is
excused only when they actually toggle to unavailable (which surfaces as
`no_available_agent` and is already charged to nobody).

Peter's reasoning, 2026-09-10: Kristen's tracking accuracy is the current priority, and her
real schedule is a better description of when she is accountable than whether she remembered
to click a button. This was chosen over treating all nine people identically, with that
trade-off understood. Revisit if the other eight ever need the same precision — the fix
would be collecting their real lunch patterns, not removing Kristen's window.

Consequence to keep in view: five calls rang out at 1pm during Kristen's lunch in the
2026-09-01..09-10 sample with her marked *available*. Under this rule those are charged to
nobody. Under a toggle-only rule they would have been hers.

**Open questions, not yet decided:**
- Where do working hours live? There is no schedule concept anywhere in this schema today.
  Neo's call. Note Aircall's own `opening_hours` is useless for this — all 15 lines are
  configured open 24/7 (verified 2026-09-10), so the schedule must come from Rincon.
- Out-of-hours misses must stay visible, so they need somewhere to live — likely a
  count column, since deleting them at sync time would hide real unanswered calls.
- The hourly measurement above cannot resolve a 12:30 boundary. **Re-verify against the
  real 12:30–13:30 window before building.**

**Sequenced behind** the six-month backfill and the miss-reason wiring, which touch the
same files.

---

## 1c. Line ownership history — BLOCKS THE BACKFILL

**Approved in principle 2026-09-10.** The backfill must not run until this exists.

### Why

Aircall **destroys attribution when a seat is deleted.** Aldo Hernandez was let go
~2026-08-27; `GET /v1/users/1906760` now returns 404, and every call he ever handled had
its `user` field stripped. His history did not disappear — it became anonymous.

Because attribution charges an unnamed call to whoever rings that line *today*, the backfill
would have credited **1,257 of Aldo's calls to Leo O'Gorman** (363 answered, 683 outbound,
211 missed). Leo's rate would have moved only 75.9% → 77.0%, so nothing would have looked
wrong in the meeting.

The 2026-09-10 migration snapshots ring membership specifically to stop history being
rewritten. It guards a **line changing hands**. It does not guard **a person leaving**,
which produces the same corruption by a different route. Peter's "no line changed hands in
six months" confirmation was true and did not cover this.

`backfill-six-months.js` states in its header that "Aircall's record of a call that happened
in April does not change. These are as good as a row the nightly sync wrote that night."
**That is false and must be corrected.**

### The real ownership history, measured 2026-09-10

Verified against six months of raw Aircall calls, then confirmed by Peter:

| Line | Period | Who actually worked it |
|---|---|---|
| **Office Line** | → Apr 2026 | An office phone tree, exclusively. 365 unnamed outbound in Mar–Apr, then zero. |
| | May 2026 → | **Kristen Rau.** Moved into Business Development Coordinator Mar/Apr. |
| **RSC Solimar Team** | → Mar 2026 | **Kristen Rau** (calls correctly named — she is still employed). |
| | Apr – Aug 2026 | **Aldo Hernandez.** All attribution stripped. 363 answered, 683 outbound. |
| | Sep 2026 → | **Leo O'Gorman**, who moved into Aldo's role on departure. |
| **Maintenance Coordinator-Solimar** | → present | **Leo O'Gorman.** No cutoff needed — he owns past and present. |

### What to build

- **Office Line** — attribute unnamed calls only from **2026-05-01**.
- **RSC Solimar Team** — attribute unnamed calls only from **2026-09-01**.
- Everything excluded stays **visible and charged to nobody**. Nothing is deleted.
- Build it as a **dated ownership list**, not two hardcoded dates. The next role change
  should be one line of config, not a six-month archaeology exercise. This is the third
  time stale configuration has produced a wrong number in this project.

### Pending, add when it happens

**Regina Franco Mendez takes over Maintenance Coordinator-Solimar.** Agreed but not yet
done — she is still in training and Aircall still rings Leo (confirmed 2026-09-10). Add a
dated entry when the handover is real.

Note: Regina is `regina@quickturnmaintenance.com`, an external vendor domain with **no row
in `users`**. Once she holds a line, her misses will be tracked but charged to nobody.
Whether an outside vendor belongs on an internal staff performance dashboard is Peter's
decision, and it has not been made.

### Decided, 2026-09-10 — pod leaders do NOT absorb pod misses

Dio Lopes leads the Solimar pod. Pod membership stays a grouping on the dashboard and
nothing more. A leader's personal answer rate must not be driven by other people's phones,
or it stops describing the leader. Pod-level orphan misses are worth showing as a pod-level
figure beside the individuals — never folded into the lead's own score.

Dio's own data needs no cutoff: consistent activity on Property Manager - Solimar across all
six months, no role change, no unnamed calls.

---

## 2. Six-month Aircall backfill

**Approved:** 2026-09-10, after Peter confirmed no Aircall line changed hands in the last
six months — which is what makes retroactive attribution safe.

Two separate problems it solves:

- **The trend view is useless without it.** Call Stats has only collected since
  2026-08-19, so a trend today shows about four weeks.
- **The missed-call data has holes.** `call_stats_line_misses` holds rows only for
  2026-08-29 onward, and is missing 2026-08-31, 09-01 and 09-02 entirely. TARS measured
  Aircall's real total for 08-29..09-09 as **177 misses; the table holds 118.** Every
  figure reasoned from that table so far is roughly two-thirds of the truth.

**Constraints already established:** backfill floor 2026-03-10 (the limit of Peter's
confirmation); must not touch `synced_at`, which means "last confirmed by the nightly
sync" — a backfill is not a sync.

---

## 3. Trend view

**Approved:** 2026-09-10. Spec written: `TREND-VIEW-SPEC.md`.

Peter's decisions, all settled:
- Option B — one metric selected, people down the left, periods across
- Week runs **Monday to Sunday**
- **No targets** for now (revisit after it has been used a few weeks)
- 8 periods across by default, dropdown for 4 / 13
- **Nobody is ever dropped automatically for inactivity** — removal is always a
  deliberate, per-person decision by Peter.

  **Clarified 2026-09-11, and the trend view must follow it.** The concern was never
  the `is_active` flag itself — it was a named employee vanishing from a page Peter
  reads aloud in a staff meeting because something flipped without a human deciding.
  Since `is_active` is only ever set by a person, the pod tables now **do** respect it
  (`router.js`, both the accumulator loop and the placeholder loop — they are one
  decision applied twice and are cross-referenced so they cannot drift apart).

  Aldo Hernandez was marked inactive on 2026-09-11 and no longer renders. His
  historical rows are untouched and his held-back calls are still visible, charged to
  nobody, under the shared-line section.

  **The standing prohibition is on automation, not on the filter:** nothing automated
  may ever set `is_active`, or this filter becomes exactly the silent deletion the
  original rule existed to prevent. Do not read this entry as "ignore the flag."

**Sequenced behind** the answer-rate work, so the trend does not render a broken metric
across eight weeks. Should also follow the backfill, or it launches nearly empty.

---

## 4. Sales vs. operational classification

**Approved:** 2026-09-10. Spec in progress.

Matches the caller's phone number against HubSpot: a prospect-stage contact or one with a
deal means sales; no match means operational. Chosen specifically because it needs no call
content — Aircall's transcription endpoints return 403 on this account, and `SPEC.md`
permanently ring-fences call content pending separate Mason and Asimov review.

**Hard dependency:** HubSpot is roughly 93% junk (see §6). Every unknown caller already
has an auto-created contact carrying their phone number, so naive matching classifies
nearly everything as sales. The design must survive that.

---

## 5. Miss reasons — only real misses count against a person

**Approved:** 2026-09-10. Migration in progress.

Only `agents_did_not_answer` counts against a person. `no_available_agent` (Kristen
switching to the phone tree at lunch, and her 9am start) and `short_abandoned` (caller
hung up, median 9 seconds) stay visible but charged to nobody.

Measured effect on Kristen, 2026-09-01..09-10, her two lines: **53% → 69%.**

---

## 6. Blocked on other people

| Blocker | Unblocks |
|---|---|
| **Marketing manager** — 7 questions in the shared brief | 4 metrics: operational calls, outbound sales calls, conversations from outbound calls, speed to lead. Plus which lifecycle stages count as a prospect, which 2 more depend on. |
| **Peter — 15 min in the Aircall dashboard** | Whether the Leasing Line and Maintenance Hotline forward into Kristen's line. If they do, those misses are hers and every rate shown today is too generous. Logged as Open Item 7 in `SPEC.md`. |

---

## 7. Known-broken, not yet addressed

- **The HubSpot duplicate bug is still running.** Started 2026-06-02, creating roughly
  90 junk contacts a week and splitting text conversations across two records. Nothing has
  been changed — it is the marketing manager's system.
- **`Z.DO NOT USE - PHONE TREE TEMPLATE ONLY`** (+1 805-541-2938) has three live users
  attached (Kristen, Marci, Dio). Any call landing there is attributed to whoever answers.
- **`SPEC.md` front matter is stale** — still reads "Status: Draft — awaiting Peter's
  approval before Neo/Q start building. Not a build yet." The tool has been live for weeks.
- **Sync route status codes are inconsistent** — a line-miss failure returns 502, a HubSpot
  failure returns 200 with the error nested. Monitoring that watches HTTP status will never
  see the HubSpot case.

---

## 8. Original scorecard metrics — overall progress

Peter's hand-tracked scorecard has 11 metrics. Current state:

| Metric | Status |
|---|---|
| Incoming call answer rate | Built; being corrected (§5) |
| Number of outbound sales calls | Outbound count built; needs §4 for the "sales" half |
| Number of operational calls | Needs §4 |
| Conversations from outbound sales calls | Needs §4 + a definition of "conversation" (seconds threshold) |
| Speed to lead | Needs HubSpot cleanup + Aircall SMS history (not built — she texts from both Aircall and HubSpot) |
| CRM data accuracy & completeness | Needs the field list and a decision on what population it scores |
| New lead booking rate | **Definition approved 2026-09-11.** Leads resolved as Qualified ÷ leads resolved at all, counted in the week they resolve. Measured 70.6% vs Peter's hand-tracked 71.86%. Runs on the LEAD object. |
| Lead follow-up completion rate | **REPLACED, approved by Peter 2026-09-11.** The percentage cannot vary — 423/434 workflow tasks completed, 75 of 81 enrollments at exactly 100%, 12 of 16 weeks at exactly 100.0%, because an unfinished task's due date moves rather than lapsing. Replaced by three plain numbers: **touches** (labelled *activity*, never quality), **sequence depth** (lower is better, said on the page), and **speed to first touch** (8% within 5 min, 31% within 1h, median 2.9h). **Read the warning below before building any of them.** |
| Past lead re-engagement attempts | Runs on **tasks**, not deals. Sequence- and workflow-sourced tasks carry the process name. |
| Past lead conversion rate | Runs on **leads**, not deals. **Denominator settled 2026-09-11: the ~105 leads actually contacted that week**, not the 411-lead pool. Chosen on meaning, not arithmetic — it measures something the team controls, where the pool version measures the pool decaying. **Target deliberately unset**: Peter confirmed the 5% "was picked out of the air," so a target gets set from real baseline once the number has run a few weeks. |

---

### ⚠ A trap in the follow-up numbers — read before building them

**More touches means a WORSE outcome, not a better one.** The workflow stops touching a
lead the moment they respond, so the touch count measures how long someone stayed silent.
Measured 2026-09-11:

| | Avg. touches |
|---|---|
| Leads that became deals | **4.7** |
| Leads that did not | **7.0** |
| `Won` | 4.0 |
| `Back to Marketing for Nurture` | 8.7 |

A naive "follow-up touches" performance metric would have **scored the best weeks lowest**.
That is why touches ships labelled *activity* and sequence depth ships with "lower is
better" stated on the page. Do not let a later tidy-up turn either into a quality score.

Two more facts that will bite whoever builds this:

- **Name matching is already broken.** Tasks store a frozen snapshot of the workflow name
  and **no workflow ID at all**. PMW's 9 tasks are split across "- Testing Phase" (6) and
  "- Active" (3) because of a rename; matching today's name finds 3 and silently loses 6.
  Same on APM and Geek Leads. Key the config on the **v4 flow id**, keep an alias list, and
  surface an unmatched count. Note v3 and v4 use *different ids for the same workflow*
  (`36143443` = v4 `4259746541`).
- **PMW and the 11-touch workflow are chained, not parallel.** PMW creates exactly one
  task, then sets `hs_lead_status = NEW`, which is the 11-touch workflow's enrollment
  trigger. 4 of its 5 contacts appear in both. Measuring them as separate funnels
  double-counts. The workflows in scope, per Peter 2026-09-11: **11-touch (`36143443`),
  PMW (`31570873`), APM (`36585716`)**. Geek Leads and PPC "still need work."

### ⚠ Several scorecard targets were picked arbitrarily

Peter confirmed on 2026-09-11 that the 5% conversion target "was picked out of the air."
Booking rate at 100% and follow-up completion at 100% look like the same — aspirations
rather than measurements; nobody books every lead. A target nobody can reach stops being a
target and becomes noise in the meeting. Worth revisiting once each number is real. Not
raised as a build task — it is Peter's to decide.
| Lost deals added to sequence | Permanently approximate — HubSpot exposes only "last sequence enrolled date," not enrollment counts |
