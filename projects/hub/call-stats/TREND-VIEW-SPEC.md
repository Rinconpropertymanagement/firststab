# Call Stats — Trend View Spec

**Status:** Draft — awaiting Peter's approval before Q/Tron start building. Not a build yet.
**Written by:** Oracle
**Date:** 2026-09-10
**Origin:** Peter approved this direction on 2026-09-10, modeled on the S2 scorecard his team already reviews weekly. He chose the shape explicitly ("Option B"): **one metric at a time, every person down the left, several time periods across.** He also asked for daily / weekly / monthly bucketing and for the ability to set the start and end day of the week, because Rincon's working week may not run Monday–Sunday and the tool must not assume it does.

**Built from:**
- `projects/hub/call-stats/SPEC.md` in full — this document extends it, does not replace it. Every decision below either follows a Design Decision already recorded there or says plainly where it diverges.
- `projects/hub/call-stats/router.js` (the existing `/api/call-stats/stats` route — its aggregation shape, its null-vs-zero rules, its `fetchAllRows` pagination helper, and its three sections: pod tables, shared-line misses, HubSpot native lines)
- `projects/hub/call-stats/dashboard/index.html` (the existing tab bar, date-range picker, and the `formatDuration` / `formatAnswerRate` split between raw API values and display formatting)
- `supabase/migrations/20260819010000_call_stats.sql` in full, including its header comments (grain, the Pacific-day rule for `call_date`, the index choice, the Data Inventory)
- `projects/hub/call-stats/lib/timezone.js` (the live-verified Pacific-day helpers the nightly sync already uses)
- `CLAUDE.md` (the build pipeline, the compliance-build boundary, and "one thing at a time")

**Where this will live:** inside the existing `projects/hub/call-stats/` section — a **third tab** on the page that is already there. No new Hub tile, no new subdirectory, no new mount in `server.js`. Reasoning is Design Decision 1 below.

**No schema change. Neo is not needed for this build.** Confirmed, not assumed: `call_stats` is keyed `UNIQUE (aircall_user_id, call_date, direction)` with `call_date DATE NOT NULL`, and the migration's own header states that day is the grain precisely so that "this week," "this month," or any custom range can be answered by the same SUM query. Any week boundary — including a Wednesday-to-Tuesday week — is therefore computable from data already stored. The two sibling tables are the same shape: `call_stats_line_misses` is keyed `(aircall_number_id, call_date, direction)` and `call_stats_hubspot_native_calls` is keyed `(phone_number, call_date, direction)`. Nothing in this spec needs a column, a table, an index, or a constraint that does not already exist.

---

## What This Does

Today the Call Stats page answers one question well: *how did everybody do over this one stretch of time?* You pick a date range, and you get a row per person with every metric as a column. That is a snapshot, and it is the right shape for what it does.

It cannot answer the question Peter actually asks in the weekly meeting: *is this person getting better or worse?* To see that today you have to change the date range, read the number, write it down, change the range again, and compare by memory.

This adds a second way to look at exactly the same data. You pick **one** metric — Answer Rate, say — and you see every staff member down the left and the last several weeks running across. Drift shows up as a row of numbers sliding one direction. Nothing new is collected, nothing new is stored, and no new call is ever fetched from Aircall or HubSpot. This is a different arrangement of numbers the Hub already has.

## How It Works

1. **You open Call Stats and click the new "Trend" tab.** The existing "Stats" tab is untouched and still opens by default.
2. **You pick one metric** from a dropdown — Answer Rate to start, since that is the number Peter watches.
3. **You pick a bucket size** — daily, weekly, or monthly — and how many periods to show across.
4. **If you picked weekly, you pick which day the week starts and ends on.** Rincon's working week is set once and remembered by your browser; you do not re-pick it every visit.
5. **The Hub works out the calendar dates each period covers**, in Rincon's own Pacific business day, and reads the daily totals it already stores for that whole span — in one request, not one per period.
6. **Each cell is computed from raw sums, not from other cells.** An answer rate for a week is that week's answered inbound calls divided by that week's total inbound calls. It is never the average of seven daily percentages, because averages of averages are wrong when the days had different call volumes — the same rule `SPEC.md` Design Decision 2 already applies to every other number this tool shows.
7. **Nothing is written anywhere.** This is read-only, same as everything else in Call Stats.

## What You'll See

- A third tab at the top of the Call Stats page: **Stats | Trend | Users**. ("Users" is still admin-only. "Stats" and "Trend" are visible to anyone who already has access to this tool.)
- Above the grid: a metric dropdown, a Daily / Weekly / Monthly toggle, a "how many periods" selector, and — when Weekly is selected — two small dropdowns for the first and last day of Rincon's working week.
- Below that: **Solimar**, **Faria**, and (when anyone qualifies) **Not in a Pod** — the same three groups, with the same people in them, that the Stats tab already shows. Names run down the left. Periods run across, oldest on the left, most recent on the right.
- A final **Average** column showing the same metric computed across the whole span at once.
- The most recent column is labeled **(partial)** when the period is still in progress — this Monday-to-today, for example, is not a finished week and should not be read as one.
- Cells covering dates before this tool started collecting data show a dash with a "no data collected" note, not a zero. Call Stats has been syncing since 2026-08-19; a 13-week trend viewed today is mostly a period when the tool did not exist, and that must not read as thirteen weeks of terrible performance.
- No new numbers, no new columns of information about anybody. Every value in the grid is a number the Stats tab can already show you for the same dates.

## What Could Go Wrong

- **Someone reads a partial period as a finished one.** The rightmost column is almost always an in-progress week or month, and a half-finished week's call count looks like a collapse in volume. This is the single most likely way this view gets misread in a live meeting. Mitigated by labeling it explicitly and by computing rate metrics (which are volume-independent) as the default rather than raw counts.
- **Thirteen weeks of "0" that actually mean "we weren't recording yet."** With only ~26 days of history today, most of any long trend is empty by construction. Handled deliberately in Design Decision 7 below — the API says which cells have no data at all, rather than leaving the dashboard to guess from a zero.
- **The two tabs disagree and nobody notices.** If the trend view re-implements the answer-rate arithmetic instead of sharing it, a later change to that definition fixes one tab and silently leaves the other wrong. This is a real risk right now, because the answer rate is being redefined in a parallel spec at this moment. Handled in Design Decision 3, which makes sharing the arithmetic a build requirement, not a preference.

---

## Design Decisions

### 1. This sits alongside the existing table. It does not replace it.

**Decision: a third tab on the existing Call Stats page — Stats | Trend | Users. The Stats tab stays exactly as it is and remains the default landing view.**

The existing per-person table is in daily use and it answers a genuinely different question. Its shape is *one range, all metrics, all people* — the right arrangement when you want a full read on somebody. The trend's shape is *one metric, all people, many periods* — the right arrangement when you want to see movement. Neither is a better version of the other; collapsing them would cost a working tool to gain a new one.

Considered and rejected:

- **A replacement.** Rejected outright. Peter did not ask for the existing table to go away, it is in weekly use, and CLAUDE.md's "one thing at a time" applies — this is an addition.
- **A toggle that swaps the table in place.** Rejected. A toggle implies the two things are alternatives to the same question. They are not, and a toggle would also lose whichever range/metric you had set every time you flipped. Tabs keep both states alive.
- **A separate page or Hub tile.** Rejected. It is the same data, the same permission gate, the same "as of last sync" note, and the same three pod groups. A second tile on the Hub home page would imply a second tool, and it would need its own mount in `server.js`, its own dashboard file, and its own `auth/me` round trip for no benefit.
- **A third tab.** Chosen. The tab bar already exists in `dashboard/index.html` — it is simply hidden today (`#tab-bar` is `display:none` unless the viewer is an admin, because "Users" was the only other tab). Making it always visible with Stats and Trend, and keeping Users admin-gated, is a small change to a control that is already built and already styled.

**One consequence Tron must handle:** the tab bar's current visibility rule is "show only for admins." That rule now has to become "always show; show the Users tab only for admins." A pod lead who has never seen a tab bar on this page will now see one, which is correct and intended.

### 2. Which metrics can be trended, and which are worth trending

All seven per-person metrics the Stats tab already computes are available in the dropdown. They cost nothing extra — every one is derived from sums already being fetched — so excluding any of them would be an arbitrary restriction. But they are not equally useful in a trend, and the dropdown should be ordered and defaulted accordingly rather than presented as seven equal choices.

**Genuinely useful as a trend — these are rates and averages, so they are comparable across periods of different length and different call volume:**

- **Answer Rate** — the default selection. This is the number Peter watches, and it is the one where drift is the whole point.
- **Avg. Speed to Answer** — inbound only, same as today. A person getting slower to pick up is exactly the kind of drift a snapshot hides.
- **Avg. Length** — usable, with a caveat worth stating: it blends inbound and outbound (unchanged from the Stats tab), so it moves for reasons that have nothing to do with performance — a week heavy on vendor callbacks looks different from a week heavy on tenant intake. Trend it, but do not read it as a performance number on its own.

**Useful, but as workload rather than performance — these are raw counts, so they scale with how busy the period was:**

- **Calls** (blended inbound + outbound, unchanged per Design Decision 8 of the main spec)
- **Outbound**
- **Missed** (inbound)
- **Outbound, No Answer**

A count trend answers "is this person's workload changing" — a real and useful question for a weekly meeting. It does not answer "is this person doing better," because someone taking twice as many calls will miss more of them while performing identically. **Monthly bucketing makes this worse, not better**, because calendar months are 28–31 days long, so a monthly count column moves several percent for no reason but the calendar. The dropdown should group these four under a "Volume" heading, separate from the three above, so nobody picks "Missed" expecting a performance read.

**Nothing is excluded.** There is no metric here that is actively misleading enough to justify hiding it, and hiding one would only mean someone re-derives it by hand from the Stats tab.

### 3. The trend must not depend on today's answer-rate definition

The answer rate is being redefined in a parallel spec right now. The current definition lives inline inside `/api/call-stats/stats` in `router.js` — the arithmetic is written directly into the row-building loop, alongside its own explanatory comments about what is and is not counted.

**Decision: before the trend route is written, Q extracts the per-person metric computation out of `/api/call-stats/stats` into a shared module in `projects/hub/call-stats/lib/` — an accumulator that folds a `call_stats` row into a running total, and a function that turns a finished accumulator into the metric values. Both the existing Stats route and the new Trend route call it. Neither route contains metric arithmetic of its own.**

This is not tidiness. It is the specific mechanism that makes the trend independent of the current definition: whatever the parallel spec changes about how the answer rate is computed, it changes in one file, and both views move together in the same commit. The alternative — copying today's arithmetic into a second route — guarantees that the parallel spec's fix lands in one tab and not the other, and that the discrepancy is discovered in a meeting rather than in a test.

Two rules go with it:

- **The trend accumulates raw sums per (person, period) and computes the metric once per cell.** It never computes a metric per day and then averages. This is `SPEC.md` Design Decision 2 applied one level up, and it is the reason the extraction is an accumulator plus a compute step rather than a single function over a row.
- **The Average column obeys the same rule.** The trailing average of a rate is computed from the whole span's sums, not by averaging the period percentages. A person who answered 1 of 1 inbound calls one week and 50 of 100 the next has a two-week answer rate of 51%, not 75%. Getting this wrong would produce a number that is confidently, invisibly incorrect — the exact failure mode the main spec rejected pre-divided storage to avoid.

**The one assumption this spec does make about the redefinition:** that the answer rate remains computable from the sums stored per `(staff member, calendar day, direction)` in `call_stats`. Everything in this document rests on that and nothing else. If the redefinition needs data at a grain `call_stats` does not hold — for example, attributing shared-line misses to individuals, which would need a line-to-person mapping that does not exist today — then that is the parallel spec's problem to solve, and this trend view inherits the solution for free through the shared module. **This spec does not block on it, and should not wait for it.**

### 4. Periods across: how many, plus an Average column, and no targets

**How many periods:** a selector, with the options tied to the bucket size, defaulting as follows:

| Bucket | Options | Default |
|---|---|---|
| Daily | 7 / 14 / 30 days | 14 |
| Weekly | 4 / 8 / 13 weeks | 8 |
| Monthly | 3 / 6 / 12 months | 6 |

**On Peter's S2 screenshot showing three periods:** three is enough to see a change and not enough to see a trend. Two bad weeks in a row and a good one looks identical to a recovery and to noise. Eight weekly columns fits comfortably on screen, covers a full quarter of behavior at weekly grain, and still lets Peter narrow to four if the meeting only cares about the last month. The recommendation is eight; the selector means it is his call, not the tool's.

**The rolling-average column: include it.** It is arithmetic over data the route has already fetched — no extra query, no extra fetch, no extra storage. It answers "what is normal for this person," which is the thing a single week's number has to be read against. Computed as described in Design Decision 3: from the span's raw sums, never from the period values. Labeled **Average** rather than "Rolling Average," because it is the plain average across exactly the periods shown, not a separate window.

**The target column: this is scope creep. Leave it out of v1, plainly.** Not because targets are a bad idea — a scorecard with no target is harder to read, and S2 clearly earns its keep partly on that. But a target is a *stored, editable value* — per metric, at minimum, and realistically per metric per person, since a maintenance coordinator's answer rate target is not a business development coordinator's. That means:

- a new table, which means **Neo**, which this build otherwise does not need at all;
- a new editing screen with its own permission question (who is allowed to set someone's target?), which means real Tron work and a real access decision;
- and a new governance question, because a stored per-employee performance target is a materially different thing from a displayed statistic — it is the first piece of this tool that looks like a formal performance standard rather than a report.

None of that is hard. All of it is a separate build, with a separate approval, and it roughly doubles the size of this one. **Recommendation: ship the trend without targets, use it in the weekly meeting for a few weeks, and then specify targets properly if the absence is actually felt.** If Peter wants targets now, that is a legitimate call — but it should be a deliberate "yes, build the bigger thing," not something that slides in under this spec.

### 5. The week-start setting: browser-local, no schema change

**Decision: the working-week definition is a per-viewer browser preference, stored in `localStorage`, and also readable and writable through the URL. Nothing is stored in the database. Neo is not involved.**

Why per-viewer and browser-local rather than a stored per-user or global setting:

- **A stored setting means a table, which means Neo, which means a migration Peter has to apply by hand** — for a preference that will realistically be set once, by the two or three people who use this tool, and then never changed. That is a poor trade.
- **This is a display preference, not a business fact.** It does not change what is stored, it does not change what the nightly sync collects, and two people with different settings are not looking at contradictory data — they are looking at the same days sliced on different boundaries. That is the same category as a chosen date range, which this tool already does not persist anywhere.
- **The URL makes it shareable, which is the one thing `localStorage` alone cannot do.** If Peter wants everyone in the Monday meeting looking at the identical grid, he sends the link and the link carries the metric, the bucket, the period count, and the week definition. That is the practical substitute for a global setting, at none of the cost.

**Precedence, so this is unambiguous for Q:** a setting present in the URL wins and is written back to `localStorage`; otherwise `localStorage`; otherwise the default. **The default is Monday through Sunday**, which exactly matches what the existing "This week" preset in `dashboard/index.html` already does today — so a first-time viewer sees the same week boundary the tool has always used, and nothing quietly changes underneath the existing Stats tab.

**Is "start and end day" one setting or two? Genuinely two — and this needs Peter's answer, not Oracle's guess.**

Mechanically, for a seven-day week, a start day implies the end day and the second control is redundant. But Peter specifically said "start **and** end day," which is only a meaningful thing to say if the week might not be seven days. That reads as: Rincon's working week may be Monday through Friday, and weekend calls may not belong in a weekly performance number at all.

Those are two different products:

- **A seven-day week with a movable start** (e.g. Wednesday through Tuesday) shifts where the boundary falls. Every call still lands in exactly one period. Totals across the trend equal totals for the same span on the Stats tab.
- **A partial week** (e.g. Monday through Friday) *excludes* days. Saturday and Sunday calls appear in no period at all. The Maintenance Hotline takes weekend calls, so this is not hypothetical — real activity would disappear from the view, and the trend's totals would no longer reconcile with the Stats tab for the same dates. That is defensible if the intent is "measure the working week," and confusing if it is not.

**Recommendation: build the two independent dropdowns, because they cost nothing extra over one, and default them to Monday–Sunday so the seven-day behavior is what anyone sees unless they deliberately narrow it.** But **Open Item 1 below asks Peter directly** whether he wants excluded days to genuinely vanish, because that decision changes what the numbers mean and it is not Oracle's to make.

**If the working week is partial, the exclusion applies at every bucket size, consistently** — a "daily" trend shows only working days as columns, and a "monthly" trend covers the calendar month minus the excluded weekdays. One rule, applied everywhere: a day outside the working week is in no bucket. Anything else means the same person's monthly number and the sum of their weekly numbers disagree.

### 6. One request, not one per period — and what the row volume actually is

**Decision: one new route, `GET /api/call-stats/trend`, taking the metric, the bucket size, the period count, and the working-week definition. It computes every period boundary server-side, reads `call_stats` once across the full span using the existing `fetchAllRows` helper, buckets the rows in JavaScript, and returns the finished grid.**

Rejected alternatives, with reasons:

- **N calls to the existing `/api/call-stats/stats` route, one per period.** Rejected. Thirteen weekly columns means thirteen round trips, thirteen permission lookups, thirteen `users` table fetches, and thirteen shared-line-miss and HubSpot queries whose results are thrown away. Worse, period boundaries would then be computed in the browser and the totals in the server, so a disagreement about where a week starts becomes a silent wrong answer rather than an error.
- **A SQL `GROUP BY date_trunc('week', call_date)`.** Rejected on two independent grounds. First, Postgres's `date_trunc('week', …)` is ISO week — Monday-start, always — and cannot express a Wednesday-start week or a Monday–Friday partial week, which is the entire feature Peter asked for. Second, PostgREST does not expose `date_trunc` in a `select`; getting it would mean a database function or view, which is a schema object, which is Neo's, which this build is otherwise entirely free of.
- **One request, bucketed in JavaScript.** Chosen. The bucketing is a lookup from a `YYYY-MM-DD` string to a period index — trivial at any volume this table will hold in the foreseeable future.

**Row volume, extrapolated from the real figure rather than guessed:** `call_stats` holds roughly 125 rows covering 26 days — about **4.8 rows per day** at present. That is well below the theoretical ceiling, because the grain is (person, day, direction) and not every one of Rincon's ~15 Aircall seats has activity in both directions every day. Both figures matter:

| Span requested | At today's ~4.8 rows/day | Ceiling if every seat were active both directions daily (~30/day) |
|---|---|---|
| 14 days (daily default) | ~70 | ~420 |
| 8 weeks (56 days — weekly default) | ~270 | ~1,680 |
| 13 weeks (91 days) | ~440 | ~2,730 |
| 12 months (365 days) | ~1,750 | ~10,950 |

Two conclusions follow, and both are load-bearing:

1. **Even the worst case is a small query.** Ten thousand narrow rows summed in memory is nothing; this needs no caching, no materialized view, no pre-aggregation, and no index beyond `idx_call_stats_date_range`, which already leads with `call_date` precisely for a date-range-across-everyone read.
2. **The longer spans cross PostgREST's silent 1,000-row page cap, so `fetchAllRows` is mandatory, not optional.** A bare `.select()` would return exactly 1,000 rows with no error and produce a grid that is quietly, plausibly wrong — the same class of bug `fetchAllRows` already exists in this router to prevent. Q must route this query through it.

**Add a hard cap on the requested span — reject anything over 400 days with a 400, the same way the existing route rejects a malformed date or a reversed range.** Not because 400 days is expensive, but because an unbounded `periods` parameter is an unbounded query, and the route should not be the thing that decides how much is too much at request time.

### 7. Timezone: inherited by construction, provided nobody reaches for a clock

**`call_date` is already a Pacific calendar day.** The nightly sync buckets it that way through `lib/timezone.js`'s `pacificDateOf`, live-verified when it was written (146 real Aircall calls, every one landing on the expected Pacific day). The migration's own column comment states the rule and flags it for Q. So the trend route does **no timezone conversion at all** — it groups Pacific calendar dates into runs of Pacific calendar dates. The discipline is inherited by not undoing it.

Two specific ways it could be undone, both stated as build requirements:

- **Period boundaries are computed as calendar-date arithmetic, never by adding milliseconds to a `Date`.** Adding `7 × 86,400,000` across a DST transition produces a 167-hour or 169-hour week, which lands one day in the wrong bucket twice a year — in March and November, silently, in a grid nobody will re-derive by hand. Q should add a small date-arithmetic helper alongside `lib/timezone.js` that steps `YYYY-MM-DD` strings by whole days (`Date.UTC(y, m-1, d + n)` and format back, the same technique `yesterdayPacificDateStr` already uses), and use it for every boundary and every column label.
- **"Today" is the server's Pacific today, not the browser's.** `dashboard/index.html` currently derives its ranges from the browser's local date, on the stated assumption that every Rincon user is in Southern California. That assumption is fine for a date picker where the user can see and correct the dates. It is worse here, because "the last 8 weeks" is anchored on a today the user never sees. The trend route should anchor its own periods from Pacific today server-side — `lib/timezone.js` already has exactly this in the first half of `yesterdayPacificDateStr` — and return the resolved date range of every column so the dashboard displays what the server actually used rather than re-deriving it.

The route should accept an optional explicit end date so a specific historical window can be examined and linked to. Absent it, Pacific today.

### 8. Empty periods: three states, not two

`SPEC.md` and `router.js` already draw a deliberate line between null and zero — a count of zero is a real answer ("this person placed no outbound calls"), while a division with nothing to divide is unknown and renders as an em dash ("this person had no inbound calls at all, which is not the same as answering none of them"). That reasoning carries forward unchanged. But a trend introduces a third state the single-range table never faces, and collapsing it into either of the existing two would be actively misleading.

**The three states, and what each cell shows:**

| State | Count metrics (Calls, Outbound, Missed, Outbound No Answer) | Rate/average metrics (Answer Rate, Avg. Length, Avg. Speed to Answer) |
|---|---|---|
| **Person had activity in this period** | the number | the computed value |
| **Person had no calls in this period, but the tool was collecting** | `0` — a real fact | `—` (em dash) — nothing to divide |
| **The tool was not collecting for any of this period** | `—`, visually distinct, with a "no data collected" tooltip | same |

**The third row is the one that matters right now.** Call Stats has been syncing since 2026-08-19. A 13-week trend viewed today is roughly nine weeks of a period when this tool did not exist. Rendering those as `0` would show every staff member with two months of zero calls, which reads as a catastrophe rather than as an empty filing cabinet — and it is precisely the kind of number that gets screenshotted before anyone checks.

**How the API expresses it, so the dashboard is not left inferring:** the route reads the earliest and latest `call_date` present in `call_stats` once, and marks each cell (or more simply, each period column) with an explicit `no_data: true` when the period falls entirely outside that coverage. The dashboard renders the flag; it never guesses "0 probably means missing." A period that only *partly* overlaps coverage is real data and is not flagged — it is genuine, if incomplete, and the partial-period label covers the rightmost one.

**A related case this spec deliberately does not solve:** somebody who joined or left Rincon mid-span shows zeros for the periods before they arrived or after they left, indistinguishable from someone present and idle. `call_stats` holds no hire or termination date and neither does `users` in any form this build should start depending on. Flagged as a known limitation, not fixed — the same treatment `SPEC.md` Design Decision 1 gives to the pod-history problem, and for the same reason: worth knowing, not worth solving until someone actually trips on it.

**One inconsistency in the existing Stats route that a long trend will make visible, flagged rather than fixed.** The zero-row placeholder loop in `/api/call-stats/stats` adds every podded person with no activity in range (`if (!pods[user.pod]) continue;`) **without checking `is_active`**, while the "Not in a Pod" bucket just above it explicitly requires `user.is_active`. On the Stats tab over a one-week range this is nearly invisible. In a 13-week trend it means a departed Solimar or Faria staff member appears as a permanent row of zeros across the whole grid, every week, forever. Per CLAUDE.md's "tell me, do not fix it without asking," this is **Open Item 2** — Oracle is not changing it, and the trend view should use the same roster logic as the Stats tab so the two tabs never disagree about who exists, whichever way Peter decides.

### 9. Scope: Aircall per-person only for v1

**Decision: the trend covers the per-person Aircall pod tables only. The Shared Line Misses section and the HubSpot Native Lines section keep their existing single-range display on the Stats tab and get no trend in v1.**

This is a recommendation with a reason, not an oversight:

- **Shared Line Misses has essentially one metric.** The section shows missed calls and total calls per line, and the only one anybody watches is misses on the Maintenance Hotline and the Leasing Line. A trend of it would be a two-row grid. There is a real question in there — "are we dropping more hotline calls than we used to?" — and it is a good one. But it is a different question from the one Peter asked for, about a different subject (a phone line, not a person), and answering it well probably wants its own small chart rather than a row in a staff scorecard.
- **HubSpot Native Lines depends on a hand-maintained allowlist that may still be empty.** `call_stats_hubspot_native_numbers` is populated by hand, the section is skipped entirely when it has no rows, and `HUBSPOT_PRIVATE_APP_TOKEN` may not be set yet. Building a trend over a section that may render as nothing is speculative work.
- **Both are cheap follow-ons if wanted.** Both underlying tables are day-grained with the identical `(subject, call_date, direction)` shape, so the same period-bucketing helper and the same shared-metric module apply unchanged. Adding either later is one more query and one more section on a page that already exists — a small piece of work, done on a real request rather than on a guess.

**Recommendation: ship the per-person trend, use it for a few weeks, and add the shared-line trend if the hotline question comes up in an actual meeting.**

### 10. Governance: unchanged, and this is not a new category

`SPEC.md` Design Decision 5 worked through this in full and concluded Call Stats is not a compliance build: no message is sent to anyone, no decision about an applicant or tenant is made or influenced, and GOVERNANCE.md's Rules and Fair Housing Standard address tenant/applicant risk, not employee-performance data. Peter has re-confirmed for this build that staff are internal, not tenants or applicants.

**Nothing in this spec changes that analysis, and it is worth saying why rather than just asserting it:** this view adds no data, collects nothing new, stores nothing, and displays no fact that the Stats tab cannot already display for the same dates. It rearranges numbers already on screen. There is no new table, so **GOVERNANCE.md Rule 4 (data inventory) has nothing new to cover** — the entry in `20260819010000_call_stats.sql` remains accurate and complete as written.

**No Asimov session. No Mason session. No Sentinel session either** — no new credential, no new external API call, no new data category, and the same `team_member_tool_roles` gate on `tool='call_stats'` that already governs this page. Sentinel's outstanding item on this tool (the Aircall credential's lack of a read-only scope) is unaffected and unchanged by this build.

One honest note, since a longer view of the same data is not *literally* identical to a shorter one: a 13-week per-person performance grid is a more pointed artifact than a one-week table, in the ordinary sense that it is easier to build a case from. That is a management judgment, not a governance finding, and it is Peter's to make with his eyes open rather than something for a specialist review to adjudicate.

---

## Who Builds What

- **Neo — nothing.** No table, no column, no index, no constraint, no migration. Stated explicitly because a trend view is the kind of thing that looks like it needs a rollup table, and it does not: `call_stats` is already day-grained for exactly this reason.
- **Q — the backend.** Extract the shared metric module first (Design Decision 3), then add the period-boundary date helper (Design Decision 7), then the `GET /api/call-stats/trend` route (Design Decisions 6, 8). The extraction is a prerequisite, not a cleanup to do afterward — doing it second means writing the arithmetic twice and then deleting one copy.
- **Tron — the frontend.** Unhide the tab bar for non-admins and add the Trend tab (Design Decision 1); build the metric / bucket / period-count / week-definition controls with the URL-and-`localStorage` precedence (Design Decision 5); build the grid itself. Two specific notes: the grid needs a **sticky first column** for names and horizontal scrolling inside its own container, since 14 daily columns will not fit in the page's current 1000px width; and every control must be wired with `addEventListener`, never inline `onclick`, because the Hub's CSP sets `script-src-attr 'none'` and silently kills inline handlers — a trap this page's own comments record having already been caught by once.
- **TARS — the test that matters most:** set the trend to weekly, Monday–Sunday, and confirm that a given cell exactly equals what the Stats tab returns for that same person over those same seven dates. Every metric, several people, including at least one person with no inbound calls (the em-dash case) and at least one period entirely before 2026-08-19 (the no-data case). If the two tabs disagree by even one call, the bucketing is wrong. Also verify a week spanning the DST change in November.
- **Judge — sign-off** before this is called done, per the pipeline.

## Open Items — Needs Peter's Answer Before Building

1. **Partial working week: should excluded days genuinely disappear?** If Rincon's week is Monday–Friday, Saturday and Sunday calls would appear in no column at all — real activity (the Maintenance Hotline takes weekend calls) vanishing from the view, and the trend's totals no longer reconciling with the Stats tab for the same dates. That may be exactly what Peter wants, if the intent is to measure the working week. It may also be a surprise. **This is the one question in this spec that changes what the numbers mean, and Oracle is not deciding it.** Default as specified is Monday–Sunday, all seven days, which matches today's behavior.
2. **Departed staff in a long trend.** The existing Stats route lists podded staff with no activity regardless of whether they are still active (see Design Decision 8). Over 13 weeks that means former employees sitting in the grid as permanent rows of zeros. Fixing it is a two-word change; it also changes the existing Stats tab, which is in daily use, so it is Peter's call and not a silent edit.
3. **Targets — now or later?** Design Decision 4 recommends later, and says plainly what "now" would cost (a Neo table, an editing screen, a who-can-set-whose-target permission question, and a governance conversation about stored per-employee performance standards). If Peter wants them in v1, that is a legitimate answer and roughly doubles the build.
4. **Default period count.** Specified as 8 weekly columns, against the 3 shown on the S2 scorecard, with the reasoning in Design Decision 4. Worth a nod from Peter since it is the first thing he will see.

## Rough Build Size

**Small — smaller than the original Call Stats build**, because there is no new data source, no sync, no credential, no schema change, and no new permission surface.

- **Neo:** zero sessions.
- **Q:** ~1 session — one extraction, one small date helper, one new read-only route.
- **Tron:** ~1 session — a third tab and one grid, reusing the page's existing styles, controls, and formatting helpers.
- **TARS:** ~half a session, dominated by the trend-equals-Stats-tab reconciliation described above.
- **Asimov / Mason / Sentinel:** none required (Design Decision 10).

The one thing that would change this estimate materially is adding targets (Open Item 3), which brings Neo back in and adds an editing screen.

---

## Plain-English Summary for Peter

**What you'd see.** The Call Stats page gets a second tab next to the one you use now — call it "Trend." The page you have today doesn't change at all and still opens first. On the new tab you pick one thing to look at, like Answer Rate, and you get every person's name down the left side and the last eight weeks running across the top. If somebody's answer rate is sliding, you see it as a row of numbers going the wrong direction instead of having to change the date range five times and remember what you saw. There's a toggle for daily, weekly, or monthly, a couple of dropdowns to tell it which day your week starts and ends on, and one extra column at the end showing that person's average across the whole stretch.

**Four things I need you to decide.**

1. **You said "start and end day of the week."** If you mean your week runs Monday to Friday, then Saturday and Sunday calls would show up nowhere at all in this view — and the Maintenance Hotline does take weekend calls. That might be exactly right, if what you want to measure is the working week. It might also be a surprise later. If you just mean the week doesn't start on Monday, that's simpler and nothing goes missing. Which one is it?
2. **People who've left.** The page you use today still lists anyone assigned to a pod, even if they no longer work here. Over one week that's barely noticeable. Over three months it means former employees sitting in the grid as rows of zeros. I can take them out, but that also changes the page you use every day, so I'm not touching it without you saying so.
3. **Targets.** Your S2 scorecard has a target column and I've left it out on purpose. Showing a target means storing one for each metric and probably for each person, which means a new place to keep them, a new screen to set them, and a decision about who's allowed to set somebody else's. That's roughly double the work and it's a different kind of thing than a report — it's a written performance standard. My advice is to use the trend for a few weeks first and add targets if you actually miss them. Say the word if you want them now.
4. **How many weeks across.** Your S2 shows three. I've set it to eight, because three weeks isn't really enough to tell a trend from a bad fortnight. There's a dropdown either way — 4, 8, or 13 — so it's just a question of what you see first.

**One thing to know going in.** This tool has only been collecting since mid-August, so about three and a half weeks of history exist. If you ask for thirteen weeks today, most of the grid will be blank. It will say "no data collected" rather than showing zeros, so nobody misreads it as everyone having a terrible summer — but it means the trend gets genuinely useful around November, once there's a real stretch of weeks behind it.

**How big.** Small — about a day of work for the builder and a day for the front-end, plus testing. Nothing new gets collected, nothing new gets stored, no new database changes, no new connection to Aircall. It's the same numbers you already have, arranged the way your scorecard arranges them. Nothing here sends a message to anyone or makes a decision about anyone, so it doesn't need the governance or legal review passes.
