# Answer Rate — Redefinition Spec

**Status:** Draft — awaiting Peter's approval before Neo/Q start building. Spec only. No code written, no migration written.
**Written by:** Oracle
**Date:** 2026-09-10
**Origin:** Peter approved this direction on 2026-09-10, after TARS verified against real data that the Answer Rate column shipped earlier the same day is structurally incapable of showing anything but 100% or an em dash.

**Relationship to `projects/hub/call-stats/SPEC.md`:** this is a companion document, not a replacement. `SPEC.md` stays the authoritative record of the original build. This document **corrects Design Decision 7** on the record (Design Decision 9 below) and adds Design Decisions 9–16 and Open Items 9–14, numbered to continue from `SPEC.md`'s own sequence so the two can be read side by side without collision. Nothing in `SPEC.md` is deleted or quietly overwritten.

**Built from:**
- `projects/hub/call-stats/SPEC.md` in full, in particular Design Decisions 2, 7 and 8 and the "Confirmed live against Rincon's real Aircall account (2026-09-10)" block
- `supabase/migrations/20260819010000_call_stats.sql` and `supabase/migrations/20260904000000_call_stats_line_misses.sql` in full, including their header comments and Data Inventory blocks
- `projects/hub/call-stats/lib/sync.js` (`buildDailyAggregates`, `buildLineMissAggregates`, `buildHubspotDailyAggregates`)
- `projects/hub/call-stats/lib/aircall-connector.js` — in particular its "CRITICAL — READ BEFORE ADDING ANYTHING TO THIS FILE" header and LIVE VERIFICATION #3
- `projects/hub/call-stats/router.js` (`GET /api/call-stats/stats`, `POST /api/call-stats/internal/sync`) and `dashboard/index.html`
- `CLAUDE.md` and `GOVERNANCE.md` in full

---

## What This Does

The Call Stats dashboard has a column called **Answer Rate** that shows what share of a person's incoming calls they picked up. It shipped on 2026-09-10, and it is broken in a specific and quiet way: it shows **100% for every single person, every time**, or a dash when they had no calls at all. It cannot show any other number, ever, no matter how many calls anyone misses.

This change fixes that by counting a real, common kind of missed call that the number currently ignores. Rincon has 15 phone lines in Aircall. Eleven of them ring exactly one person — the Property Manager – Solimar line rings only Dio, the Office Line rings only Kristen, and so on. When a call comes into one of those lines and nobody picks up, Aircall records it against the *line*, not the person. That is why those misses never reach anyone's number today. After this change, a miss on a line that rings exactly one person counts against that one person. A miss on a line that rings nobody, or rings several people, stays where it is today — counted at the line, charged to no individual.

## How It Works

1. **Every night, the sync job also asks Aircall which staff members each phone line rings.** One extra read per line, on top of the calls it already fetches. Nothing is created, edited or deleted in Aircall.
2. **For each line, the answer is one of three things:** it rings exactly one person, it rings nobody, or it rings several people. Only the first case produces an attribution.
3. **That answer is written down alongside that night's misses** — frozen in place with the day it applies to, so a change in Aircall next month never reaches back and rewrites last month's numbers.
4. **When the dashboard loads,** a person's missed-call count is the sum of two things: misses Aircall already credited to them by name (which, in real data today, is always zero — see Design Decision 9), plus misses on lines that rang only them on the day the miss happened.
5. **Answer Rate is then that person's answered inbound calls divided by (answered + missed)**, over whatever date range is selected. Outbound is excluded from both halves, exactly as Design Decision 7 already specified and this document does not change.
6. Misses on lines that ring nobody or ring several people are **not** silently dropped. They keep appearing in the Shared Line Misses section that already exists, and that section gets clearer about what is and is not being charged to a person.

## What You'll See

- The **Answer Rate** column starts showing real percentages instead of 100% across the board. Expect it to drop noticeably for **Kristen Rau** and **Dio Lopes** in particular — they are the sole users of the two busiest missed lines.
- The **Missed** column, which today also always reads 0 for everyone (same root cause, see Design Decision 9), starts showing real counts. The two columns move together and always agree.
- The **Shared Line Misses** section below the pod tables changes from one list into two clearly labelled groups: lines whose misses are now charged to a person (with the person's name shown), and lines whose misses are still charged to nobody, with a running total of the latter, so it is impossible to read the per-person percentages without also seeing how many misses landed on no one.
- A short line of text under the Aircall tables saying this Answer Rate covers Aircall calls only, and a matching line in the HubSpot Native Lines section saying its misses are not included in it.
- **No new tile, no new page, no new date picker, no new permission.** Everything above happens inside the Call Stats page that already exists.

## What Could Go Wrong

- **The numbers will look worse on the first day, and that is the point.** Somebody comparing a printout from last week's meeting to this week's will see people drop from 100% to something real. If this ships without being announced, it reads as a sudden collapse in performance rather than a metric that started telling the truth. Handling: announce it in the meeting where it first appears, and do not restate week-over-week "improvement" across the changeover date.
- **A person can be charged for misses on a line they were never really expected to answer.** If a line is pointed at one person as a technical fallback, or the person is on vacation, every miss on that line lands entirely on them. Nothing in Aircall's data distinguishes "your phone rang and you ignored it" from "your phone rang while you were on PTO." Handling: the number is a prompt to ask a question in the weekly meeting, never a verdict on its own — see Design Decision 14.
- **The phone-tree question is still open, and it makes every percentage shown slightly too generous.** Aircall reports which people a line *rings*, not where a line *forwards*. If the Leasing Line routes to Kristen through a menu, those misses are hers and this design will not catch them. Every Answer Rate shown is therefore a best case. Handling: Design Decision 15 and Open Item 9 — the design is deliberately built so that closing this question later is a one-line mapping change plus a re-run, not a rebuild.

---

## The Correction — Confirmed vs. What Was Assumed

### Confirmed live / confirmed in code (2026-09-10)

- **Aircall never attributes an unanswered inbound call to an individual.** An inbound call nobody answers arrives with `call.user === null`. Three independent pieces of evidence, none of them a guess:
  - `lib/aircall-connector.js` LIVE VERIFICATION #3, written 2026-08-20 against a real 600-call sample: *"Every INBOUND call with a `user` attached was answered by that user (0/183 inbound+user calls had a null answered_at) — the 'inbound miss nobody personally picked up' case is carried ENTIRELY by user:null rows (128/600), never by a user-attached row with answered_at:null."*
  - `lib/sync.js`, `buildDailyAggregates()`: `if (!call.user) { summary.calls_unattributed_no_user++; continue; }` — a user-less call never reaches a `call_stats` row at all. It is picked up instead by `buildLineMissAggregates()`, keyed on `call.number.id`, not on a person.
  - TARS, 2026-09-10, against Rincon's live database: `missed_calls` is **0 on every inbound row in `call_stats`, all-time.**
- **Therefore the shipped Answer Rate can only ever be 100% or null.** `router.js` computes `answer_rate = inbound_answered / (inbound_answered + inbound_missed)` where `inbound_missed` is structurally always 0. The denominator can never exceed the numerator. This is not an edge case or a data gap; it is arithmetic.
- **The same root cause breaks the "Missed" column too**, which was not called out when this was reported: the dashboard's Missed column reads the same always-zero `inbound_missed_calls` field. Two columns are broken, not one, and this change fixes both together. Fixing only Answer Rate would leave the page contradicting itself — an 88% answer rate next to a Missed count of 0.
- **Ring membership is readable only from the per-number detail endpoint.** `GET /v1/numbers` returns all 15 lines with the `users` array empty or absent; `GET /v1/numbers/:id` returns the real membership. Already recorded in `SPEC.md` and repeated here because it is the single trap most likely to produce a confidently wrong re-check later.
- **Ring membership as of 2026-09-10** (from `SPEC.md`'s own live check and this task's brief):
  - **Exactly one user (11 lines):** Office Line +1 805-288-1119 (Kristen Rau), Business Development Coordinator +1 805-288-1209 (Kristen Rau), Property Manager – Solimar (Dio Lopes), Property Manager – Faria (Marci Gray), Transaction Coordinator (Shane Muir), Maintenance Coordinator–Solimar (Leo O'Gorman), RSC Solimar Team (Leo O'Gorman), RSC Faria Team (Liz Otero), Marketing Coordinator (Jackie Rodriguez), Quick Turn Project Manager (Caylee Andrade), Quick Turn Admin Assistant (Regina Franco Mendez).
  - **Zero users (2 lines):** Maintenance Hotline +1 800-525-5883, Leasing Line +1 805-288-1198.
  - **Three users (2 lines):** "Office Line Phone Tree – Outside Office Hours" (Liz, Marci, Dio), "Z.DO NOT USE – PHONE TREE TEMPLATE ONLY" (Kristen, Marci, Dio).
- **Real miss volume, 2026-08-15 to 2026-09-09:** 118 line misses across 12 distinct lines. Largest three: Property Manager – Solimar (35), Office Line (31), Office Line Phone Tree – Outside Office Hours (19). Roughly 66 of the 118 become attributable under this change.
- **The two populations cannot double-count each other.** A call has `call.user` set or it does not; `buildDailyAggregates()` skips the null case and `buildLineMissAggregates()` skips the non-null case. Every call lands in exactly one of `call_stats` and `call_stats_line_misses`, never both. This is what makes the combined fraction in Design Decision 14 arithmetically sound, and it is verifiable in the code rather than assumed.

### Needs live verification before Q writes any code

- **Whether `GET /v1/numbers/:id` returns an `email` on each user object, or only `id` and `name`.** This is load-bearing: it decides the join key and therefore the column shape in Design Decision 12. The brief confirms names come back; it does not establish that email does. Check this **first**.
- **Whether an inbound call that is *answered* on a sole-user line can still arrive with `user: null`.** `lib/sync.js`'s own LIVE VERIFICATION found 3 inbound + answered + `user: null` calls in a 573-call, 7-day sample. If any of those sit on sole-user lines, the numerator under-counts while the denominator does not — see Design Decision 14's "known bias" and Open Item 11. Q should count these specifically, by line, over the existing 2026-08-15..2026-09-09 window. It is a query against data already in Supabase; no new Aircall fetch is needed.
- **The per-line split of the 118 misses.** The brief's "roughly 66 attributable" figure happens to equal the two largest sole-user lines exactly (35 + 31). If that is not a coincidence, the other nine sole-user lines contribute almost nothing and this change is, in practice, "Dio and Kristen get their real misses." Worth confirming rather than assuming, because it changes how the result is presented in the weekly meeting.
- **Whether Aircall exposes any history of a line's ring membership.** Expected answer: no — the detail endpoint reports current state only. This is what forces the snapshot design in Design Decision 11 and constrains the backfill in Design Decision 13. If it turns out a history exists, Design Decision 13 gets easier and should be revisited.
- **Rate-limit headroom.** Adding ~16 GETs per nightly run (one list plus one detail per line) is trivial in volume, but `aircallGet()` currently throws on a 429 with no retry. Confirm the nightly run stays comfortably inside Aircall's limit with the extra calls.

---

## Design Decisions

### 9. Design Decision 7 was made on a mistaken premise — recorded, not quietly superseded

`SPEC.md` Design Decision 7 states, twice:

> "Kristen Rau is the sole user on two lines... **Aircall already attributes misses on those two lines to her**, and this build already counts them. Design Decision 7 does not shield them."
> "**This decision does not shield anyone's real misses.**"

**Both statements are false, and they are the load-bearing justification for the whole decision.** Aircall does not attribute an unanswered inbound call to any individual — see the confirmed evidence above. Kristen's 31 Office Line misses in the sampled window were never counted against her. Design Decision 7's "direct rings only" exclusion did not merely exclude misses on lines that ring nobody; combined with the mechanism above, it excluded **every inbound miss in the system**, which is what makes the column structurally incapable of showing anything but 100%.

Two things follow, and both belong on the record rather than being tidied away:

- **The half of Design Decision 7 that is still correct stays.** Outbound is excluded from both halves of the fraction. That reasoning was never dependent on the mistaken premise — an outbound call a vendor doesn't pick up says nothing about a staff member's responsiveness — and this document does not disturb it.
- **The half that is wrong is replaced by Design Decisions 10–15 below**, and the reason it was wrong is written down: not "we changed our minds," but "the stated factual basis was checked against real data and did not hold."

**Process note, worth one line because it is the point of this project's live-verification discipline:** the disproof was already sitting in this codebase. `lib/aircall-connector.js`'s LIVE VERIFICATION #3 recorded "0/183 inbound+user calls had a null answered_at" on 2026-08-20 — three weeks before Design Decision 7 was written on 2026-09-10. The fact was in the repository and the decision was made without reading it. The fix is not more process; it is that a decision about what a number counts must be checked against the code that computes it, not only against the API that feeds it.

### 10. The line-to-user mapping is read at sync time, not joined live at query time

**Source:** `GET /v1/numbers/:id`, one call per line, after `GET /v1/numbers` to enumerate the line IDs. This is the only source — the list endpoint returns empty `users` arrays for all 15 lines and will produce a confidently wrong answer if trusted.

**Where the code goes:** a new, narrowly-named function in `lib/aircall-connector.js` — that file's own CRITICAL header is explicit that a new Aircall read gets its own function calling `aircallGet()`, and that a generic `request(method, path)` helper must never be added. Q follows that rule; this is not the place to relax it.

**Two options were weighed:**

| | Read at sync time | Join live at query time |
|---|---|---|
| Aircall calls | ~16 per night | ~16 per dashboard load |
| Dashboard availability | Unaffected — page stays a pure Supabase read | Page now fails when Aircall is down or rate-limited |
| Historical stability | Can be frozen (Design Decision 11) | Impossible — always reflects today's config |
| Weekly-meeting behavior | Fine | The page is reloaded repeatedly with different date ranges during a meeting; each reload re-hits Aircall |

**Decision: read at sync time.** The query-time option is rejected on two independent grounds, either of which alone would be enough: it couples a dashboard that currently has no external dependency at page-load to Aircall's uptime and rate limit, and — decisively — it makes the history problem in Design Decision 11 unsolvable, because a live join can only ever apply today's configuration to every day in the range.

**Failure handling, and this matters more than it looks:** if the mapping fetch fails, the line-miss half of the sync must **fail loudly and skip its upserts**, leaving that day re-runnable. It must **not** write rows with a null attribution. Null is a meaningful value in this design — it means "this line had no sole user that day" — and it must never be overloaded to also mean "we could not find out," because that failure would be permanent, silent, and self-concealing: the day would look like a day with no sole-user lines, understating people's misses forever, and nothing about the row would say otherwise. The Aircall call fetch and the `call_stats` upserts happen earlier in the same route and are unaffected; this is the same failure-isolation reasoning `router.js` already applies in the other direction for the HubSpot half of the sync.

### 11. Line membership is snapshotted onto each miss row — this is the hard part, and it is not hand-waved

**The problem, concretely.** Dio Lopes is the sole user of Property Manager – Solimar, which accounted for 35 misses between 2026-08-15 and 2026-09-09. Suppose Dio leaves in November and Marci inherits the line. If attribution is computed by looking up the line's *current* sole user, then on the day Aircall is reconfigured, all 35 of Dio's August misses silently become Marci's. Her August answer rate drops. A number Peter read out in a weekly meeting in September is now a different number, with no record that it changed and no event in this system that caused it.

That is not a rounding error. It is a performance metric about a named employee, reviewed in a meeting, rewriting itself retroactively because of an unrelated phone-system change.

**Decision: membership is snapshotted at sync time, stored on the miss row itself, and never recomputed.** A miss on 2026-08-20 is attributed to whoever the line rang on 2026-08-20, permanently.

**What breaks under each choice, stated plainly:**

- **Snapshot (chosen).** Historical numbers are stable; a reconfiguration in Aircall affects only nights after it. *What breaks:* if a line's membership was wrong in Aircall for a stretch — someone forgot to update it after a role change — that error is frozen into the data and can only be corrected by deliberately re-running those days. And re-running an old day re-reads the *current* mapping, so the `?date=` escape hatch that `router.js` already provides becomes a small, sharp tool: re-running 2026-08-20 today stamps today's mapping onto August's misses. That is the exact history-rewrite this decision exists to prevent, now available as a one-line manual command. It must be documented at the route, not left as a surprise. It is acceptable because it is an explicit, rare operator action rather than something that happens on its own.
- **Live lookup (rejected).** Nothing to store, no migration, no backfill. *What breaks:* every historical number silently changes whenever a line changes hands, forever, with no signal. For a metric whose whole purpose is comparing a person to themselves week over week, this is disqualifying.
- **Versioned membership table with valid_from/valid_to (rejected for v1).** Genuinely correct, and the textbook answer. *What breaks:* it requires detecting membership changes nightly, closing and opening rows, and reasoning about as-of joins in the dashboard query. For an identical result on the only query pattern that exists — because the miss row is *already* per-line, per-day, so the row itself is the natural place to record the as-of answer — that is real complexity bought for nothing. Named here so nobody thinks it was overlooked. It becomes the right answer only if something else in the Hub ever needs "who was on which line on date X" independently of a miss count.

**On the apparent inconsistency with Design Decision 1**, which deliberately does *not* snapshot pod and looks it up live: this is a different case, not a contradiction, and the difference is what the field controls. Pod decides which **table a person is listed in** — a re-slicing of the same numbers under a different heading. Line membership decides **whose number it is** — it moves a miss out of one person's denominator and into another's. Re-grouping is cosmetic; re-attributing is not. Design Decision 1's own text calls its choice "worth knowing, not worth solving until it's a real complaint," which is a fair judgment for grouping and would not be a fair one here.

### 12. Two new columns on `call_stats_line_misses`. No new table. `call_stats` is not touched.

Three shapes were considered against this project's stated discipline of not inventing columns ahead of a proven need (`PROPERTY-BRAIN-ARCHITECTURE.md` §1.5, and both existing migrations' own headers).

- **Fold attributed misses into `call_stats` at sync time — rejected.** It would mean writing a row keyed on a person for a call Aircall never attributed to a person, which is precisely the invention both existing migrations went out of their way to avoid. It destroys the line-level view the Shared Line Misses section already ships. And it is **irreversible**: if the phone-tree question (Open Item 9) resolves differently, or Peter changes the rule, undoing it requires a full re-sync from Aircall rather than an update in place. Reversibility is not a nice-to-have here — Open Item 9 is genuinely open.
- **A separate `call_stats_line_members` snapshot table — rejected for v1.** It would store membership for the zero-user and three-user lines too, which nothing asks for. It is the right answer only alongside the versioned design already rejected in Design Decision 11.
- **Two nullable columns on the existing table — chosen.** The table's grain is already exactly right: one row per (line, day, direction). The attribution is an attribute of that row, not a new dimension. **The `UNIQUE (aircall_number_id, call_date, direction)` constraint and the upsert path are unchanged** — this is additive only.

**Proposed columns (Neo finalizes; the exact join key depends on a verification below):**

```
call_stats_line_misses
  ... existing columns unchanged ...

  sole_user_email     TEXT NULL      -- the one staff member this line rang on
                                      -- this day, or NULL if it rang nobody or
                                      -- rang several. Matches users.email and
                                      -- call_stats.staff_email at query time,
                                      -- same convention as Design Decision 1.
                                      -- NULL means "no sole user," never
                                      -- "unknown" — see Design Decision 10's
                                      -- failure handling.

  ring_user_count     INTEGER NULL   -- how many users the line rang on this day
                                      -- (0, 1, or 3 in Rincon's data today).
```

**Why `ring_user_count` earns its place rather than being invented ahead of need:** without it, a NULL `sole_user_email` is ambiguous between "this line rang nobody" and "this line rang three people." Peter's approved rule treats those two identically *today*, but they are different facts about the phone system, they may be decided differently later (the three-user "Outside Office Hours" line is the third-largest source of misses in the sampled window), and the distinction is knowable only at sync time. Once the night has passed it cannot be recovered. That is the test this project applies: not "might we want it," but "is it destroyed if we don't capture it now." It is.

**`sole_aircall_user_id` was considered and is not proposed**, unless the verification below forces it. `call_stats` stores Aircall's user ID because it is that table's upsert key; here the row is keyed on the line, and the person is an attribute joined by email. Adding a second identifier that nothing keys on or joins on would be exactly the ahead-of-need column this project avoids. **However:** if `GET /v1/numbers/:id` returns only `id` and `name` on its user objects and no `email`, then email is not available at sync time and the join key must become the Aircall user ID instead — joining to `call_stats.aircall_user_id`. That is a genuine fork in the column shape, and it is the reason "does the numbers detail endpoint return an email" is the first thing to verify. Neo should not finalize this table until that is answered.

### 13. Backfill: a one-time in-place update of the existing rows, gated on one question only Peter can answer

Existing `call_stats_line_misses` rows — roughly 2026-08-15 onward — predate any mapping and would have both new columns NULL.

**The mechanics are unusually cheap, and worth stating because the obvious assumption is wrong.** The mapping is per-line, not per-call, so backfilling needs **no re-fetch of Aircall call data at all** — it is a single pass setting `sole_user_email` and `ring_user_count` from the current mapping, on rows already in Supabase. This is a sharp contrast with the per-line outbound question in `SPEC.md` Design Decision 8, which was dropped partly because it would have required "a schema change **plus** a full re-sync backfill from Aircall." That cost does not apply here.

**The gate is not technical.** Backfilling means applying **today's** mapping to the past — the one thing Design Decision 11 exists to prevent. It is defensible over this specific window for one reason: the window is about four weeks old. So the question that decides it is:

> **Did any Aircall line change hands between 2026-08-15 and 2026-09-10?**

Only Peter can answer that, and it costs him one sentence. Aircall's API is not expected to expose membership history (Open Item 12), so there is no way to check it from this side.

- **If yes, and no line changed hands:** run the backfill as a one-time, dated operation. The full existing window gets real attribution, and the metric has ~4 weeks of history on day one instead of starting from zero. Record the mapping used and the date it was applied, in the migration or a sync-log entry, so the provenance of those rows is never ambiguous later.
- **If no, or Peter isn't sure:** **do not guess.** Leave the pre-existing rows NULL and start the metric fresh from the first night the new sync runs. The dashboard must then say so — a range that begins before the start date shows a note that misses before that date were not attributed, rather than showing a flattering percentage built on a partly-blind denominator. A quietly wrong four weeks is worse than four weeks of honestly missing data; that principle is the whole reason this document exists.

**Either way, the changeover date is a real event and must be visible.** Answer Rate means something different before and after it. A range spanning the boundary is mixing two definitions.

### 14. What the combined number means — arithmetically sound, with one named bias

For Kristen Rau, Answer Rate becomes:

```
                    inbound calls answered on her own call_stats rows
  ─────────────────────────────────────────────────────────────────────────────
  that  +  inbound misses on lines that rang only her on the day of the miss
           (Office Line, Business Development Coordinator)
```

**Confirmed sound, on two counts:**

- **No double counting.** The two populations are disjoint by construction, verifiable in `lib/sync.js`: a call with `call.user` set goes to `call_stats` and is skipped by `buildLineMissAggregates()`; a call with `call.user === null` goes to `call_stats_line_misses` and is skipped by `buildDailyAggregates()`. No call can appear in both halves.
- **The units match.** Both halves count inbound calls that rang this person. Adding a line-keyed count into a person-keyed denominator is legitimate *only* because the line rang exactly one person — which is the entire content of Peter's rule, and why it does not generalise to the three-user lines.

**One known bias, and it points the same way as everything else here — the number shown is optimistic.** `lib/sync.js`'s own live verification found 3 inbound calls in a 573-call sample that were **answered** and still arrived with `user: null`. If any of those fall on a sole-user line, the design as written adds that line's *misses* to the denominator but does not add its *answers* to the numerator — depressing that person's rate slightly. Two responses, in order:

1. **Measure it first.** Count inbound, answered, `user: null` calls on sole-user lines over the existing window. This is a query against data already in Supabase. If the count is near zero — which the 3-in-573 sample suggests — the simple rule stands and the bias is noted and ignored.
2. **If it is material,** credit `total_calls − missed_calls` on sole-user line rows to that person's numerator as well, making the whole line row that person's. Not done pre-emptively: an "answered" call on a shared line may have been answered by voicemail rather than by the person, and `20260904000000_call_stats_line_misses.sql` explicitly declined to design around that case without a confirmed example. Tracked as Open Item 11.

**Where the number misleads, and this belongs in front of Peter, not buried:**

- **It is not comparable across people whose lines are structured differently.** Kristen is the sole user of Rincon's main company inbound number. Shane is the sole user of the Transaction Coordinator line. They face different volumes and different expectations. A lower percentage does not mean a worse employee.
- **Time off lands entirely on the sole user.** Every miss on a one-person line during that person's vacation is charged to them, because nothing in Aircall's data distinguishes an ignored ring from an absent employee.
- **Whoever's calls arrive through a multi-user line looks better than they are.** The three-user "Office Line Phone Tree – Outside Office Hours" absorbed 19 misses in the sampled window and charges them to nobody. Liz, Marci and Dio are on that line.
- **Because of Open Item 9, every percentage is a best case.** Forwarded calls that should count against someone currently do not.

Read together: this is a number that tells you **where to ask a question**, not a number that answers one. Given it is reviewed in a weekly staff meeting, that framing should appear on the page, not only in this document.

### 15. How the design behaves while the phone-tree question stays open

Aircall reports which users a line **rings**, not where it **forwards**. All 15 lines report `is_ivr: false`, including the two that ring nobody — which cannot be the whole story, since a line that rings no individual and is not a menu must still route somewhere. This is `SPEC.md` Open Item 7 and it is not closed.

**The design does not guess. It behaves as follows:**

1. **Attribution keys on ring membership only** — the thing the API actually reports. No forwarding is inferred, modelled, or approximated. A line that rings nobody attributes to nobody, full stop, even where a plausible guess exists.
2. **The direction of the error is known and must be stated on the page.** Unmodelled forwarding can only ever *add* misses to someone's denominator, never remove them. So every Answer Rate shown is an **upper bound** — the true figure is this or lower. That is a one-sentence note under the table, and it is honest in a way that "we're not sure" is not.
3. **The unattributed remainder stays visible and countable.** The Shared Line Misses section splits into "charged to a person" and "charged to nobody," with a total for the second. In the sampled window that second group is roughly 52 of 118 misses. Nobody should be able to read the per-person percentages without seeing that number next to them.
4. **Closing the question later must be cheap, and Design Decision 12 is what makes it cheap.** Because misses stay in their own table with the attribution as a *column*, resolving the phone tree means changing how the mapping is built and re-running an update — not re-syncing call data from Aircall. Folding misses into `call_stats` would have made this a rebuild. This is the concrete payoff of that choice.
5. **A specific, checkable hypothesis for Peter, from the line names themselves:** the third-largest source of misses is "Office Line Phone Tree – Outside Office Hours" (19). If that is where Office Line calls go after hours, then Kristen's 31 Office Line misses and those 19 are the same call flow split by time of day — and the real question is not attribution but whether after-hours misses should count against anyone at all. Worth answering while he is in the Aircall dashboard anyway.

**What Peter actually has to do:** open Rincon's Aircall dashboard and read the routing configuration for the Maintenance Hotline and the Leasing Line — where do they go when nobody picks up. Roughly fifteen minutes. It cannot be answered from the API by anyone.

### 16. The Aircall / HubSpot contradiction: better, but one label change belongs in this piece

Today the same page shows Kristen at 100% in the Aircall table and 3 missed inbound calls on her HubSpot number in the HubSpot Native Lines section. Two numbers about one person, on one screen, contradicting each other.

**Does this change make it better, worse, or unchanged? Better on the substance, and it should be finished with a label.**

- **Better:** the contradiction has two parts, and this fixes the sharper one. Kristen's Aircall Answer Rate stops reading 100% and starts reflecting her ~31 Office Line misses. The "100% next to 3 missed" whiplash goes away because the 100% goes away.
- **Unchanged, and now slightly more conspicuous:** the two systems remain separate, deliberately, per Peter's own decision. The HubSpot section has no Answer Rate column at all — `router.js` returns `total_calls`, `avg_length_seconds`, `inbound_missed_calls` and `outbound_not_answered` for those rows and nothing else. After this change, one table on the page carries an Answer Rate and the other does not, for the same named person. A reasonable reader will assume the percentage covers all of Kristen's calls. It does not.
- **Do here (small, text only, no schema):** label the Aircall Answer Rate as covering Aircall calls only, and add a matching line to the HubSpot section noting its misses are not included in the percentage above. This is in scope precisely because this change is what makes the ambiguity acute.
- **Do not do here — a separate piece, with a real open question in it:** adding an Answer Rate to the HubSpot section. It is arithmetically possible — that table stores `answered_calls` and `missed_calls` — but `lib/sync.js`'s `buildHubspotDailyAggregates()` records an unresolved open item: HubSpot's `hs_call_status` takes the values COMPLETED, MISSED, BUSY and QUEUED, and only the first two are bucketed. `answered + missed ≠ total`. Deciding whether a QUEUED inbound call belongs in an answer-rate denominator is a real judgment call, not a five-minute addition, and shipping a HubSpot answer rate without settling it would reproduce exactly the failure this document exists to correct. Tracked as Open Item 13.
- **Explicitly not recommended: a blended cross-system Answer Rate.** Beyond Peter's standing decision to keep the systems unblended, the two "missed" definitions are not the same measurement — Aircall's is `answered_at == null`, HubSpot's is `hs_call_status == 'MISSED'` with two statuses classified as neither. Averaging two different definitions into one percentage is a quietly wrong number, which this project has now established is worse than no number.

---

## Data Model Change (for Neo to finalize)

One migration, additive only. Two nullable columns on `call_stats_line_misses` as specified in Design Decision 12. **No change to `call_stats`, its grain, its UNIQUE constraint, or its sync path. No change to `call_stats_line_misses`'s grain or UNIQUE constraint either** — additive columns only, so the existing upsert on `(aircall_number_id, call_date, direction)` is untouched.

**Data Inventory impact (GOVERNANCE.md Rule 4) — this is a real change and must not be waved through.** `20260904000000_call_stats_line_misses.sql`'s inventory currently reads:

> `pii_fields: NONE, by construction — and unlike call_stats, this holds for a structural reason, not an aggregation choice: every row in this table exists BECAUSE Aircall itself recorded no individual user for that call.`

**That entry stops being true the moment `sole_user_email` exists.** The table will identify a named Rincon employee and attach missed-call counts to them — the same category of employee-performance personal data that `call_stats` carries and that `call_stats.sql`'s own inventory describes honestly. The migration must rewrite that table's inventory block rather than leave the "NONE, by construction" line standing, and the corrected entry should mirror `call_stats`'s: `privacy_category` becomes employee performance metadata rather than N/A; `ccpa_exportable` and `ccpa_deletable` move from N/A to the same answers `call_stats` gives, with the same redact-in-place mechanism (overwrite `sole_user_email` and the row is anonymous again). Retention stays indefinite, matching Peter's 2026-08-20 decision. RLS and audit-logging posture are unchanged.

This is exactly the kind of inherited-by-habit inventory entry that `call_stats.sql` itself warned about when it refused to copy `appfolio_property_actuals`'s "NONE, by construction" line. Neo should apply the same care in the other direction.

**Governance path: unchanged, and confirmed rather than assumed.** Still not a compliance build under `CLAUDE.md`'s definition and `SPEC.md` Design Decision 5 — no message is sent to anyone, no decision about a tenant or applicant is made or influenced, and GOVERNANCE.md's Rules and Fair Housing Standard address tenant/applicant/housing-decision risk, none of which is present. No Asimov gate, no Mason gate. Rule 4 applies in full, which is why the inventory correction above is mandatory and not optional. Peter's approval satisfies Rule 6 Standard tier.

---

## Open Items — Needs Confirming Before This Gets Built

9. **Where the Maintenance Hotline and Leasing Line actually forward.** Carried forward from `SPEC.md` Open Item 7, unresolved, and the single largest source of remaining error. Needs Peter in the Aircall dashboard; cannot be answered from the API. Design Decision 15 specifies how the tool behaves while it stays open. Add the "Office Line Phone Tree – Outside Office Hours" line to the same check.
10. **Does `GET /v1/numbers/:id` return an `email` on each user object, or only `id` and `name`?** Decides the join key and the column shape. **Verify this before Neo writes the migration** — it is the one unknown that can change the schema.
11. **How many inbound, answered, `user: null` calls fall on sole-user lines?** A query against existing Supabase data. Decides whether Design Decision 14's known bias is negligible or needs the numerator adjustment described there.
12. **Does Aircall expose any history of a line's ring membership?** Expected no. If yes, Design Decision 13's backfill gets a real basis instead of a judgment call, and should be revisited.
13. **A HubSpot-side Answer Rate** — deferred to its own piece, and blocked on deciding whether QUEUED and BUSY calls belong in an answer-rate denominator (`lib/sync.js`'s existing open item). Named here so the asymmetry on the page is a known state, not an oversight.
14. **Peter's one-sentence answer: did any Aircall line change hands between 2026-08-15 and 2026-09-10?** Decides whether the existing four weeks get backfilled or the metric starts fresh (Design Decision 13).

Carried forward from `SPEC.md` and untouched by this document: Open Item 1 (resolved in practice by the live verifications since), Open Item 3, Open Item 4 (Sentinel's credential-scope pass), Open Item 8 (the "Z.DO NOT USE" line — still Peter's to clean up in Aircall; note it has three users, so this design attributes nothing from it either way).

---

## Rough Build Size

Small, and smaller than it looks, because the grain that was already chosen turns out to be the right one.

- **Neo — ~1 session.** One additive migration: two nullable columns, no constraint change, plus the Data Inventory correction described above. Blocked on Open Item 10.
- **Q — ~1 session.** One new read function in `aircall-connector.js` (following that file's CRITICAL header rule), a second argument to `buildLineMissAggregates()`, the fail-loud-on-mapping-failure path in the sync route, the two-source rollup in `GET /api/call-stats/stats` for both `answer_rate` and `inbound_missed_calls`, and the one-time backfill script if Open Item 14 clears.
- **Tron — ~half a session.** Split the Shared Line Misses section into attributed and unattributed with a running total for the second, and add three lines of explanatory text (upper-bound caveat, Aircall-only caveat, HubSpot cross-reference).
- **TARS — mandatory and specific.** Not "does the page load." Verify against real data that (a) Kristen's and Dio's rates are no longer 100%, (b) the Missed column and the Answer Rate agree with each other for every person, (c) attributed misses plus unattributed misses equals the total line-miss count for the range — nothing silently lost between the two sections, and (d) no person's numbers changed for a date range that predates the changeover, if the backfill was skipped.
- **No Asimov, no Mason** (Design Decision 5, re-confirmed above). **No Sentinel session required for this change specifically** — no new credential, no new external surface, one additional read against an already-approved API — though `SPEC.md` Open Item 4's standing credential-scope question is still open independently of this work.
