# Sync Health Visibility + Portfolio Rollup — Build Spec

**Status:** Draft — scoped only, not built. Awaiting Peter's approval before Neo/Q start building.
**Written by:** Jarvis, from a live conversation with Peter on 2026-09-02, immediately following a night of real incidents this spec exists specifically to prevent a repeat of.
**Origin:** Peter asked what would improve Maintenance History next. Jarvis's top suggestion, chosen by Peter: visibility into whether the tool's background jobs are actually running, plus a portfolio-wide view to complement Property Overview's per-property one.

Two separable pieces. Confirmed against the real codebase before writing this (no existing sync-tracking table, no existing portfolio-wide view — both are genuinely new, not extensions of something half-built).

---

## Part 1 — Sync Health Visibility

### Why this, why now

Three real, silent failures happened in this exact codebase within the last 24 hours of work: Maintenance History's own nightly Latchel sync stopped running for 15 days with nothing surfacing it; Call Stats' nightly sync was never scheduled at all; a database function that links maintenance tickets to their properties had never been turned on. All three were found by manually digging through logs and databases, not because anything told anyone. This spec is the fix for "how would we know sooner next time," not a hypothetical.

### What's genuinely missing today

Every scheduled job (Maintenance History's ingest, the AppFolio sync, Call Stats' sync, and others outside this tool) runs as a cron-triggered script that writes to a plain text log file on the server and nothing else. There is no queryable record anywhere of "did this run today," "did it succeed," or "when did it last actually work." The only way to check right now is SSH into the server and read raw log files by hand — which is exactly what found tonight's three failures, after the fact.

### The fix

**One new small table**, e.g. `sync_runs`: job name, started at, finished at, status (success/error), a short summary (row counts, whatever the job already reports), and an error message if it failed. Every scheduled job writes one row per run — start and finish, or a single row with both timestamps once it completes — instead of (or in addition to) its current log-file-only behavior.

**One small dashboard widget** showing, per job: last run time, how long ago that was in plain language ("2 hours ago" / "3 days ago"), and its status. A job that hasn't run successfully within its own expected window (nightly jobs flagged if no success in 36+ hours, giving a day's grace) shows a clear red/amber flag instead of green.

### Scope decision needed from Peter

Build this **just for Maintenance History's own jobs** (the Latchel ingest — the one that actually failed silently), or **for every scheduled job across the whole Hub** (AppFolio sync, Call Stats, Maintenance History, and anything else on Sally's crontab)? Technically nearly the same amount of work either way, since the table and the checking logic don't care which job wrote to them — the only real difference is how many of the existing cron wrapper scripts get touched to report in. **Recommendation: build it Hub-wide from the start.** Tonight's incidents weren't limited to one tool, and retrofitting this to more jobs later is strictly more work than including them now, for close to zero extra design cost.

### Where it lives

No existing widget infrastructure exists on the Hub home page today (checked — it's a plain list of tool links). Two reasonable options: a small new section on that home page (visible to whoever can already see the home page), or a dedicated small admin-only page. **Recommendation: home page, since that's where the problem was actually invisible from** — but this is Peter's call, not a technical constraint.

### What's genuinely new to build

- **Neo** — one new table (`sync_runs` or similar), small, no relation to existing sensitive data.
- **Q** — instrument each in-scope internal sync route (already-existing routes: Maintenance History's `/internal/ingest`, and however many others are in scope per the decision above) to write a start/finish record; one new small read endpoint (`GET /api/hub/sync-health` or similar) and the dashboard widget that renders it.
- No AI, no new external credentials, no schema changes to anything sensitive.

### Deliberately not part of this build

- No automated alerting (email/text) when a job fails — this is a glance-at-the-dashboard fix, not a paging system. Worth revisiting later if a visible badge still isn't enough in practice.
- No historical trend/uptime chart — just "is it healthy right now," matching this codebase's own repeated "don't build ahead of a proven need" pattern.

### Size

Small. One small table, no sensitive data, reuses existing routes' own success/failure knowledge rather than inventing new health-check logic. Neo — well under 1 session. Q — about half a session, mostly repetitive wiring across however many jobs are in scope.

---

## Part 2 — Portfolio-Wide Rollup

### Why this

Property Overview answers "what's going on at this one property." Nothing today answers "what's going on across the whole portfolio right now" without opening every property one at a time. Peter's own words, from earlier tonight, about a related but different complaint (Needs Privacy Review's disconnected queue) apply here too: the tool should show what's actually relevant to what someone's looking for, not force them to hunt for it property by property.

### What this shows

One new view, portfolio-wide instead of per-property, built from data that already exists — no new AI, no new external connection:

- **Most active properties this month** — a simple count of tickets/activity per property, ranked, so a property that's suddenly generating a lot of maintenance activity is visible without having to already know to look for it.
- **Spend trend** — reuses the Budget tab's existing real AppFolio numbers, rolled up across the whole portfolio instead of one property at a time (total budgeted vs. actual, portfolio-wide, this year).
- **Open/urgent items, portfolio-wide** — the exact same "Currently Open / Unresolved" logic Property Overview already computes per property (real outcome-claim evidence, not just an AppFolio status field), aggregated across every property instead of filtered to one. This is the same computation already built and tested tonight, run wider rather than reinvented.
- **Properties with recurring issues** — surfaces any property with 2+ tickets flagged as recurring in the same system, so a pattern doesn't stay invisible until someone happens to open that one property's overview.

### What's genuinely new to build

- **No new tables** — every number here already exists in `maintenance_requests`, `maintenance_claims`, `appfolio_property_budgets`, `appfolio_property_actuals`. This is aggregation, not new data collection.
- **One new endpoint** (e.g. `GET /api/maintenance-history/portfolio-overview`) that reuses Property Overview's existing open-items/recurrence logic, widened from "one property's tickets" to "every property's tickets" — same rules, wider input, not new rules.
- **One new page/tab** in the dashboard to display it — reusing Property Overview's existing visual language (cards, badges) rather than a new design system, same as Property Overview reused the base tool's.

### Governance note

This reads the exact same already-reviewed, already-filtered data Property Overview reads (`maintenance_claims_decision_safe` — flagged/rejected claims structurally excluded, same as everywhere else). No new content-safety surface is introduced by widening an existing, already-cleared query from one property to all of them. Worth a quick Asimov confirmation of that reasoning before build, not a full review — this is explicitly not expected to need Mason, since nothing about what's shown or to whom changes, only how many properties it's shown for at once.

### Part 2b — "Property in Distress" flagging

**Added 2026-09-02, from a live conversation with Peter.** Rincon already runs a "property in distress" process today, outside this tool, in LeadSimple — currently trigged by things like a large maintenance spend and a long vacancy. Peter's question: could this portfolio rollup identify the same kind of properties proactively, using data already in the Hub, rather than needing that check to happen somewhere separate.

**This isn't a new feature bolted onto the rollup — it's the same data, scored instead of just displayed.** The signals Peter described (maintenance spend, vacancy length) are exactly what Part 2's "most active properties" and the fixed occupancy data already surface; recurring issues (Part 2's own recurring-issues section) is a third natural signal in the same family. A "properties needing attention" section is that same underlying data run against thresholds, not a separate system.

**Design principle, not yet a full spec:** score this transparently, not with an AI judgment call. This is the kind of thing that should drive real decisions about where Peter or his team steps in — a property should be flagged with a plain-English reason ("47 days vacant, $3,200 in maintenance spend this month"), not a black-box number. Matches this tool's existing discipline elsewhere (real evidence, not inference, for anything that gets acted on).

**Blocked on Peter sharing the actual LeadSimple process** — what currently counts as "large" spend, how many days counts as "long" vacancy, and whatever other criteria that process already uses. Two reasons to wait for the real thresholds rather than inventing new ones: (1) replicating (or deliberately improving on) something Peter already trusts is more useful than a guess, and (2) it avoids building a second, differently-tuned "is this property in trouble" opinion that disagrees with the one Rincon already runs on operationally.

**Once the real process is in hand, this section should cover:** the exact signals and thresholds (mapped 1:1 to what's already computable here — spend from `appfolio_property_actuals`/`maintenance_requests`, vacancy length from the now-fixed `units.status` plus lease move-out data, recurrence from `maintenance_claims`), whether a property needs to hit one signal or a combination to be flagged, and whether this should eventually feed back into or replace the LeadSimple-side process, or just run alongside it as an early-warning view inside the Hub.

### Deliberately not part of this build

- No property-by-property drill-down beyond what already exists — this rollup should link back into the existing Property Overview page for any property a user wants to look at closer, not duplicate that page's detail.
- No owner-facing or tenant-facing version of this — internal staff view only, same access gate as the rest of Maintenance History.
- No LeadSimple integration/API connection as part of this — Part 2b works entirely off data already in this Hub; it's parallel to LeadSimple's process, not connected to it, unless Peter decides otherwise once the thresholds are in hand.

### Size

Small-to-medium. No schema, no new external connections, no new AI. Most of the work is widening one existing query pattern and building one new page — Q, roughly one session; a light Asimov confirmation pass, not a full review. Part 2b adds a small amount of scoring logic on top of data Part 2 already computes — not sized yet, pending the real thresholds.

---

## Combined Open Items — Needs Confirming Before Build

1. **Part 1 scope** — Hub-wide (recommended) or Maintenance-History-only?
2. **Part 1 placement** — Hub home page (recommended) or a dedicated admin page?
3. **Part 1 alert threshold** — is "no success in 36 hours" the right window for every job, or does a job like Call Stats (once-daily) need a different threshold than something that used to run every 2 hours?
4. **Part 4's recurring-issues section** — this overlaps with an idea Peter didn't explicitly pick ("surface recurring issues proactively") but is included here as a natural piece of a portfolio rollup rather than its own separate feature. Confirm that's wanted as part of this build, not held back.
5. **Part 2b's actual thresholds** — waiting on Peter to share Rincon's real LeadSimple "property in distress" criteria before this section can be fully scoped. Everything above it is ready to build; this piece isn't yet.
