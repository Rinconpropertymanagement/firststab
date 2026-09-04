# Can Maintenance History sync faster than once a night? — Feasibility & Recommendation

**Status: research only, for Peter's decision. Nothing here has been built. No cron job, config, or production file was changed to produce this doc.**

**Written by:** Oracle (research/feasibility)
**Date:** 2026-09-04
**Question asked:** Peter wants "check Property 360's maintenance history before acting on a work order" to become a standard part of how staff operate — to catch warranty items, repeat-vendor issues, and recurring problems before a vendor gets sent out again. Today the Latchel data behind that history only refreshes once a night (2:10am Pacific). Peter's read: "a delayed sync isn't going to make that possible." This doc checks that, live, against the real systems, and gives a recommendation.

**Everything below was checked live tonight** (real, read-only `GET` calls against Rincon's production Latchel and AppFolio accounts, and a live look at Sally's real crontab) — not copied from memory or old docs. Where it confirms something already written in `SPEC.md`, that's noted; where it corrects or adds to it, that's called out.

---

## 1. The short answer

**Yes — a faster poll is enough, and it's a small, low-risk, mostly non-code change.** Recommend: run the existing nightly Latchel sync every 15 minutes instead of once a night. No webhook is needed for this. Details and reasoning below.

---

## 2. Do webhooks (instant push updates) exist? Yes — and Rincon already has one working in production, for a different feature

"Webhook" = instead of Rincon asking Latchel "anything new?" on a timer (polling), Latchel would instead push a message to Rincon the instant something changes. Latchel genuinely supports this — real, documented feature (Job, Property, Resident, Invoice, File, Owner, on create/update).

More importantly: **Rincon already built and is running one of these, live, today** — for the separate "Approval Briefing" feature (the one that emails a PM when a repair needs approval). It receives Latchel's push notifications on Sally (Rincon's server) right now, has its own security credential (`LATCHEL_WEBHOOK_SECRET`, already issued by Latchel and already sitting in Rincon's configuration), and Sally already has the public web address needed to receive it. So "can we technically receive a push from Latchel" is not a hypothetical — it's already happening for one feature.

**But — and this matters — even that existing webhook doesn't fully replace polling on its own.** Latchel's own documentation (checked directly, three separate places: their payload reference, their technical API spec, their setup walkthrough) never states a retry policy, a delivery guarantee, or what happens if Rincon's server is briefly down when Latchel tries to push. Because of that, the Approval Briefing feature was deliberately built with the webhook as the *fast path* and a regular timed check-in (once an hour) as a *backstop* that catches anything the push silently dropped. In other words: even where Rincon has already paid the cost of building a webhook, it still needed a timer-based check running underneath it, because Latchel can't promise the push will always arrive.

**What that means for this decision:** building a webhook here would not let Rincon stop polling — it would only add a "usually faster, but not guaranteed" layer on top of polling that's still required anyway. Given that, and given a fast poll turns out to be cheap and safe (next section), a webhook isn't worth the extra cost for this specific need right now.

---

## 3. What does a much faster poll (e.g., every 15 minutes) actually cost? Checked live, with real numbers

The nightly Latchel sync already knows how to ask Latchel "what changed since a given date" — this isn't a new capability that needs to be built. Tonight's live checks:

- **Real request volume, checked live right now:** 51 Latchel tickets were updated in the last 1 day, 143 in the last 7 days, 359 in the last 30 days (today's actual account, not an estimate).
- **Real rate limit, re-confirmed live** (not just copied from the old spec): Latchel's own response headers just now say **600 requests per 10 minutes**, and after ~90 real requests made during tonight's checks, Rincon still had 540 left in the current window. The limit really is 600/10 min, and it resets on a rolling basis.
- **What a full sync run actually costs in requests:** worst case — every single one of today's 51 updated tickets needing the full detail pull (ticket details + history + attached files + vendor lookup) — comes to roughly 200–260 real requests to Latchel. That's well under the 600-per-10-minute ceiling, and a run every 15 minutes gets its own fresh budget window each time (previous runs have long since rolled off). In practice, most 15-minute runs would see only a handful of newly-changed tickets since the last run (not all 51 at once), so the typical run would use a small fraction of that.
- **Re-running the same time window repeatedly is safe — confirmed by reading the actual code, not assumed.** Every ticket only gets reprocessed if Latchel's own "last updated" timestamp for it is newer than the last time Rincon's system pulled it. An unchanged ticket is skipped, not reprocessed — so running the sync every 15 minutes instead of once a night does **not** create duplicate history entries or double-counted facts.

**The practical upshot: turning "once a night" into "every 15 minutes" does not need new code.** The sync already accepts a setting for how far back to look, and already runs safely if re-triggered on an overlapping time window. The only actual change needed is how *often* the existing job is told to run — a scheduling change (Scotty's territory), not a rebuild (Q's territory).

**One real thing worth fixing before shipping this (not something I built — flagging it for whoever does the work):** the sync has no "don't start a new run if the last one is still going" check. At once-a-night, that's never mattered. At every 15 minutes, if a run ever legitimately takes longer than 15 minutes (say, an unusually busy day), the next one could start before the last one finishes. Recommend a small safeguard be added at build time — this is a quick fix, not a redesign.

---

## 4. Where do new work orders actually come from — and a genuinely important correction to the starting assumption

This is the most consequential thing tonight's check turned up.

**AppFolio, not just Latchel, is a source of new tickets** — and it's *already syncing much faster than once a night.* Checked live on Sally's real schedule:

```
AppFolio → Rincon sync runs at: 8am, 10am, noon, 2pm, 4pm, and 6pm Pacific
(weekdays), plus once more overnight — roughly every 2 hours during the
work day, not once a night.
```

That means a brand-new AppFolio work order is typically already visible in the Hub (as a ticket) within about **2 hours**, most of the workday — not next-day. **The once-a-night piece is specifically the Latchel enrichment layer** — the extracted history facts (what happened, what was decided, whether it recurred, warranty-relevant notes) that Property 360 shows. That's the part actually worth speeding up; the raw ticket itself mostly already keeps pace.

**A second, separate check (matching what was found earlier tonight on the AppFolio side):** AppFolio's "work order" report genuinely does not support any kind of date filter — checked live again just now with two different filter styles (a plain date range, and an "updated since" style filter); both were silently ignored, returning the exact same 133 rows either way. So the earlier finding ("AppFolio's work order report can't do a historical range query") turns out to be the same underlying limitation for a "what's new since X" query too — AppFolio just always hands back its whole current list, no filtering at all, request after request.

**The good news buried in that:** the report is small — 133 rows, live, right now — so pulling the *entire* thing every time, with no filter, is cheap and already exactly what the existing AppFolio sync does. There's no need to fix or work around the missing filter; Rincon just keeps re-pulling the whole (small) list, the same way it already does every ~2 hours today. If Peter ever wants that even faster than 2 hours, that's a separate, easy, low-risk scheduling dial — but nothing found tonight suggests that's the actual bottleneck.

**One honest nuance worth naming, not to talk Peter out of anything, just so the real shape of the fix is clear:** the "history" a staff member checks on Property 360 (recurring issues, warranty flags, vendor patterns) is built mostly from *past*, already-processed tickets — it doesn't need *today's* brand-new ticket to already be fully processed to be useful. The specific case a once-a-night Latchel sync actually misses is narrower than "the whole feature is stale until 2am": it's same-day pattern matching — e.g., two calls about the same leak in one day wouldn't yet be cross-referenced against each other. That narrower case is still real, and still worth fixing (an every-15-minute sync fixes it), but it's a smaller gap than "nothing is current until the next morning."

---

## 5. Recommendation

**Go with a faster poll. Don't build a webhook for this.**

- **What to change:** move the existing nightly Latchel sync (`POST /api/maintenance-history/internal/ingest`) from once a night to every 15 minutes. This is a crontab/scheduling change (Scotty), not a rebuild. Recommend also adding a small "don't overlap with a still-running sync" safeguard at the same time (a short task for Q) — cheap insurance, not required by anything found tonight, but the responsible thing to add before running something this much more often.
- **Why not a webhook:** Latchel's own webhook has no delivery guarantee (confirmed straight from their docs, three separate times, across two different features built against it in this codebase) — so it can never fully replace the timed check-in anyway; Rincon's own working webhook build for Approval Briefing proves this, since it still needed an hourly backstop poll on top of the webhook. A 15-minute poll's worst case (wait up to 15 minutes) is close enough to "instant" for a same-day "check before you act" habit that the extra cost of a webhook — a new public endpoint on Sally, a new kind of failure to plan for, and (per Rincon's own standing pattern for this kind of build) a fresh Sentinel security review before anything ships — isn't worth it for this specific need right now.
- **If that ever changes:** the webhook groundwork already exists (credential, endpoint pattern, a live working example in Approval Briefing). Extending it to Maintenance History later would be an addition, not a redo — exactly what the original Maintenance History plan already expected ("a well-scoped, no-rebuild-needed upgrade for later"). No need to build it now just in case.
- **Nothing here touches the database** — no new tables, no schema change. Neo doesn't need to be involved for this specific change.
- **Nothing here is a compliance build on its own** — this doesn't send anything to a tenant or owner, and doesn't make or influence any decision about a person; it only changes how often an existing, already-approved read-only sync runs. (Flagging this only so it's clear why Asimov/Mason aren't listed below — not asking you to skip governance, just noting this particular change doesn't trigger it.)

**Suggested next step, if you want to move forward:** Scotty makes the schedule change (and, alongside it, Q adds the small overlap safeguard noted above), then TARS confirms a few real 15-minute cycles run cleanly against production before calling it done — same build pipeline as everything else, just a small one.

---

## Sources checked live tonight (2026-09-04)

- Latchel API: real `GET` calls to `/jobs` (with and without date filters), rate-limit response headers, and a fresh count of tickets updated in the last 1/7/30 days — all against Rincon's real, live Latchel account.
- AppFolio API: real report calls to `work_order` (baseline, plus two different date-filter attempts) against Rincon's real, live AppFolio account.
- Sally's real, live crontab (`crontab -l`), confirming the actual current schedules for both the AppFolio sync and the Latchel ingest.
- Code read (not run) of `maintenance-history/router.js`'s ingest route and `latchel-connector.js`, to confirm the idempotency/re-run-safety claims above.
- Existing project docs cross-checked for consistency: `maintenance-history/SPEC.md` ("Live API Verification," rate limit, webhook section) and `approval-briefing-SPEC.md` (webhook mechanics research, delivery-guarantee findings) — both already-recorded live research from earlier builds, confirmed still consistent with tonight's fresh checks rather than assumed to still be true.
