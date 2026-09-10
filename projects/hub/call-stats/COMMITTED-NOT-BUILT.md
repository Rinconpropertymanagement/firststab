# Call Stats — Committed but Not Yet Built

**Purpose:** everything Peter has approved that is not finished. Nothing on this list
is a maybe — each item was explicitly agreed. Delete an item only when it ships and
passes TARS.

Last updated: 2026-09-10

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
  deliberate, per-person decision by Peter

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
| New lead booking rate | Reachable now — runs on meetings, not the junk contacts |
| Lead follow-up completion rate | Reachable now — runs on tasks |
| Past lead re-engagement attempts | Reachable now — runs on deals |
| Past lead conversion rate | Reachable now — runs on deals |
| Lost deals added to sequence | Permanently approximate — HubSpot exposes only "last sequence enrolled date," not enrollment counts |
