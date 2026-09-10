# Aircall Call Stats — v1 Build Spec

**Status:** Draft — awaiting Peter's approval before Neo/Q start building. Not a build yet.
**Written by:** Oracle
**Date:** 2026-08-19
**Origin:** Peter approved this direction the night of 2026-08-18/19, with the scope deliberately narrowed to stats only — no recordings, no transcripts, no call content of any kind. That fuller build (if it happens) is out of scope here and gets its own spec, its own Mason/Asimov pass, the same two-phase pattern already used for email-intake (relevance/routing built and reviewed first; a deeper content-reading capability specified separately, later).
**Built from:**
- `projects/hub/PROPERTY-BRAIN-ARCHITECTURE.md` (Section 1.2's test for what belongs in the shared `claims` table vs. bypasses it; Section 1.5 on not inventing new subject-type plumbing ahead of a proven need)
- `supabase/migrations/20260817010000_appfolio_property_actuals.sql` in full, including its header comments — the precedent for "a fetched, arithmetically-aggregated fact, not an AI interpretation" bypassing `claims` entirely. Followed for the core reasoning; explicitly diverged from on the PII question (see Design Decision 3 and the Data Inventory section below) — that migration's table has zero PII "by construction," this one cannot honestly make the same claim, because per-person attribution is the entire point of this build.
- `supabase/migrations/20260720000003_foundation.sql` (`users` table — real name, role, and **existing `pod` column**, `CHECK (pod IN ('Solimar','Faria'))`) and `supabase/migrations/20260812020000_shared_team_members.sql` (`team_members` / `team_member_tool_roles` — the Hub's login-and-role system, separate from `users`)
- `supabase/migrations/20260813000004_security_deposit_team_roles.sql` (the `pod_lead` role, and the precedent for widening a shared CHECK constraint to onboard a new Hub tool) and `projects/hub/security-deposit/router.js` (confirms `pod_lead` today is *not* pod-scoped — every `pod_lead` sees every pod's cases, a deliberate v1 simplification carried forward here, not reinvented)
- `projects/hub/server.js` and `projects/hub/maintenance-history/SPEC.md` (the Hub's established shape: one section = one subdirectory with its own `router.js`/`dashboard/`/`lib/`, mounted into `server.js`, listed as a tile on the home page, gated by `team_member_tool_roles`)
- `.env.example` (the credential-documentation pattern, including how the Latchel "not actually read-only" caveat was flagged — followed here for Aircall)
- `GOVERNANCE.md` in full (Rules 1–10, the Fair Housing Standard) and `CLAUDE.md`'s compliance-build definition

**Where this will live:** `projects/hub/call-stats/` — a new Hub section, same shape as Insurance Compliance, Security Deposit, and Maintenance History (`router.js`, `dashboard/index.html`, `lib/`), mounted into `projects/hub/server.js` and listed as a new tile on the Hub home page. Reasoning for why this is a new section rather than folding into an existing tool is in Design Decision 4 below.

---

## What This Does

Right now, if Peter or a pod lead wants to know how a staff member's phone activity looks — how many calls they're taking, how fast they're picking up, how many calls are going unanswered — that means opening Aircall directly and reading it call-by-call or pulling Aircall's own reports by hand. This build pulls that same information automatically, every night, and lays it out per person, grouped by pod (Solimar / Faria), inside the Hub next to the other tools already there.

It shows **only statistics** — counts, averages, timing. It never touches what was said on a call. No recordings, no transcripts, no call content of any kind are ever fetched, stored, or displayed by this tool. That boundary is deliberate and permanent for this build, not a placeholder for a later phase (see "Explicitly Out of Scope" below).

## How It Works

1. **Every night, a sync job asks Aircall's API for the previous day's calls** — a read call only; nothing is ever created, edited, or deleted in Aircall.
2. **Each call is matched to the Rincon staff member who handled it**, using the email address Aircall already has on file for that person, matched against Rincon's own staff list (`users.email`). That same staff record already says which pod (Solimar or Faria) the person belongs to — this build doesn't invent a new way of tracking who's in which pod; it reads the one that already exists.
3. **The raw calls are added up, not stored one-by-one** — for each person, each day: how many calls, how many were answered, how many were missed, total talk time, and total ring time before pickup. The individual call records themselves are discarded once they're counted (see Design Decision 2 for why).
4. **A person opens the Hub and picks a time range** (this week, this month, etc.) and sees, per pod, a table of every staff member's call count, average call length, missed-call count, and average speed-to-answer for that range** — computed on the fly from the daily totals, not pre-baked into a single number that can't be re-sliced.
5. Nothing here makes a decision about anyone, sends a message to anyone, or flags anyone for review. It is a read-only dashboard.

## What You'll See

- A new **"Call Stats"** tile on the Hub home page, next to Insurance Compliance, Security Deposit, and Maintenance History.
- Opening it shows two grouped tables — **Solimar** and **Faria** — each listing every staff member in that pod with six columns: **Calls**, **Avg. Length**, **Missed**, **Avg. Speed to Answer**, **Answer Rate**, and **Outbound**. A date-range picker (default: this week) controls every column at once. **Calls** is the blended inbound+outbound total it has always been (Design Decision 8); **Answer Rate** and **Outbound** were added 2026-09-10 and are specified in Design Decisions 7 and 8 below.
- A small "as of [last sync time]" note, same as the Budget tab's actual-spend figures elsewhere in the Hub.
- Nothing else — no call list, no names of who was called, no recordings, no transcripts, no notes.

## What Could Go Wrong

- **Some missed calls may not attribute to any one person.** If a call rings a whole pod's line and nobody picks up, Aircall may not tag that call to an individual staff member at all — only to the shared line. This build can still count it at the pod level, but it may not be able to say *whose* miss it was, because there may genuinely be no "whose" to assign. This needs confirming against Rincon's real Aircall data once a credential exists (see Open Items) — flagged now so it isn't a surprise later, not glossed over.
- **A wrong or missing email match would silently drop a person's stats**, or worse, merge two people's numbers if Aircall and `users` disagree on an email address for the same person. The sync should log (to the console/sync log, not to `audit_log` — see Design Decision 3) any Aircall user it couldn't match to a `users` row, so an unmatched person doesn't just quietly vanish from the dashboard.
- **Outbound "no answer" isn't the same thing as an inbound miss, and treating them as one number would be misleading.** A staff member calling a vendor who doesn't pick up is not a performance problem the way an unanswered inbound tenant call is. This build tracks direction separately for exactly this reason (Design Decision 2) — but whoever reads the dashboard should understand "Missed" means "inbound calls nobody picked up," not "every call that didn't connect."

---

## Explicitly Out of Scope — Not Designed Around, Not Hooked For

Call recordings, transcripts, and any other form of call *content* are not part of this build in any way — not fetched, not stored, not summarized, no database column reserved for them, no code path that could be pointed at them later. Peter discussed and declined that piece tonight. If it's built later, it is a **separate spec**, reviewed by Mason and Asimov the same way the email-intake project split "read and route" from "read and understand content" into two separately-governed pieces. Nothing below should be read as quietly preparing for that later piece.

For context, not as something this spec resolves: real recording-consent disclosures are already given on Rincon's calls today, which is what would settle the two-party-consent question for *recording itself* if that later piece ever gets built — but that's a fact about existing business practice, not a decision this document is making, and it doesn't bear on anything in this spec, since no recording or transcript is touched here at all.

---

## Aircall API — What's Confirmed vs. What Needs Live Verification

No Aircall credential exists in this environment yet. Everything below marked "confirmed" comes from Peter's own prior research into Aircall's documented Calls API (`developer.aircall.io/docs/calls`), taken as given per the task brief. Everything marked "needs live verification" is Oracle's best understanding of Aircall's public API as documented, **not yet checked against Rincon's real account** — the same "confirmed-from-docs vs. confirmed-live" discipline `maintenance-history/SPEC.md` applied to Latchel, and the same thing that document's own "Live API Verification" section did once a real credential existed. Q/TARS should re-verify every "needs live verification" line below against the real account before this ships, the same way that was done for Latchel.

**Confirmed (per brief):**
- Per call: `started_at`, `answered_at` (null if never answered), `ended_at`, `missed_call_reason` (present only on missed *inbound* calls).
- Duration = `ended_at - started_at` (includes ring time). Talk time = `ended_at - answered_at`. Speed-to-answer = `answered_at - started_at`.
- An outbound call the other party never answers also has `answered_at` null — same field, different meaning depending on direction (see Design Decision 2).

**Needs live verification once a credential exists:**
- **Per-user attribution.** Aircall's documented Calls resource is understood to carry a nested `user` object (id/name/email) identifying which staff member handled the call — but whether that's populated on every call, only answered ones, or is absent for calls nobody on a ring group picked up, is not confirmed. This is the single most load-bearing fact for this build (it's how "per person" happens at all) and must be checked first, against real Rincon data, before Neo finalizes the schema below.
- **Whether a fully-missed call (nobody in the pod's ring group answered) carries any staff-identifying field at all**, or only a line/number identifier. Directly feeds the "What Could Go Wrong" item above.
- **Pagination shape** on the calls-list endpoint (cursor-style `meta.next_page_link`, or plain `page`/`per_page`) — needed so the nightly sync doesn't silently drop calls past page 1, the same class of bug flagged for Latchel's job-history endpoint in `maintenance-history/SPEC.md`.
- **Auth mechanism and whether a read-only scope exists.** Aircall's classic API is understood to use an API ID + API Token pair (HTTP Basic Auth), generated per-account in the Aircall dashboard, with no separate read-only variant — but this is not confirmed. See Design Decision 6.
- **Exact field names** — `user`, `number`, and any others referenced above are Oracle's best understanding of Aircall's schema, not verified against a real response body. Q should confirm field-for-field against a real `GET /v1/calls` response before writing the sync code, not build against this document's guesses.

**Confirmed live against Rincon's real Aircall account (2026-09-10)** — checked while settling Design Decision 7 below, and recorded here so the next person doesn't have to re-derive it:

- **Rincon has 15 Aircall lines.**
- **Ring membership is not visible on the list endpoint — only on the per-number detail endpoint.** `GET /v1/numbers` returns every line with its `users` array empty or absent, for *all* 15 lines. `GET /v1/numbers/:id` returns the real ring membership for that line. **Flagged deliberately, because the list endpoint alone leads to a confidently wrong conclusion** — that no line rings anybody. Anyone re-checking this later must fetch each line's detail endpoint individually; do not trust the list.
- **Two lines ring nobody at all:** "Maintenance Hotline" (+1 800-525-5883) and "Leasing Line" (+1 805-288-1198). These are the source of the unattributed inbound misses — the case Open Item 2 asked about, now confirmed to be real in Rincon's data rather than hypothetical.
- **Kristen Rau is the sole user on two lines:** "Office Line" (+1 805-288-1119) — Rincon's main inbound number, which rings only her — and "Business Development Coordinator" (+1 805-288-1209). Aircall already attributes misses on those two lines to her, and this build already counts them. Design Decision 7 does not shield them.

**Still needs live verification — not settled by the check above:**

- **Where a line *forwards*, as opposed to who it *rings*.** Aircall's API reports a line's ring membership; it does not report the line's forwarding or phone-tree routing. All 15 lines report `is_ivr: false`, **including the two that ring nobody — which cannot be the whole story**, since a line that rings no individual and is not a menu must still route somewhere. So: it is **confirmed** that the Leasing Line does not ring Kristen directly. It is **not confirmed** that the Leasing Line never reaches her via a phone tree. If it does, those misses would become hers, and her answer rate would drop. **This cannot be settled from the API** — it requires a human opening Rincon's Aircall dashboard and reading the phone-tree configuration. Tracked as Open Item 7.

---

## Design Decisions

### 1. Attribution to "person in the pod"

Aircall's own concepts are users (staff members with an Aircall seat) and numbers/lines (phone lines, plausibly one per pod). Rincon already has a real, existing way to know which pod a person is in — it does **not** need to be invented for this build:

- `users` (`supabase/migrations/20260720000003_foundation.sql`) already has a `pod` column, `CHECK (pod IN ('Solimar','Faria'))`, populated for the four "Pod roles" (Property Manager, Maintenance Coordinator, Transaction Coordinator, Resident Services Coordinator) and `NULL` for Executive/Operations/Business Development roles. This is the real, working pod-membership record this project asked to check for before inventing anything — it exists, and this build should read it, not build a second one.
- Note this is a *different* table from `team_members`/`team_member_tool_roles` (`20260812020000_shared_team_members.sql`), which is the Hub's login-and-permissions system, tied to Supabase Auth. `users` and `team_members` are two separate identity tables in this schema today with no documented FK between them — matched, where it's needed elsewhere in this codebase, by email. This build follows that same convention: match Aircall's per-call user email to `users.email` to look up name + pod. It does not attempt to unify `users` and `team_members` — that's a separate, larger decision outside this build's scope.
- **Pod is looked up at query/sync time from `users.pod`, never copied onto the call-stats rows themselves.** If someone's pod assignment changes later, their historical numbers should reflect whichever pod the dashboard is asked to show *today* — there's no existing precedent anywhere in this schema for tracking pod history over time (`properties.pod`, the closest analog, is a flat, unversioned field updated in place by `assign-pods.js`), so this build doesn't invent one either. Flagged as a known limitation, not a blocker: if someone switches pods mid-quarter, a "last month" report run today will show their calls under their *current* pod, not the one they were in at the time. Worth knowing, not worth solving until it's a real complaint.

### 2. Storage grain and shape

**Decision: aggregate at sync time, one row per (staff member, calendar day, call direction).** Not per-call, not pre-aggregated all the way up to week/month.

Reasoning:
- **Per-call storage was rejected**, same logic as `appfolio_property_actuals`'s rejection of raw transaction lines: no drill-down need has been asked for (Peter asked for counts and averages, not a call log), Aircall's own dashboard already is the system of record for anyone who wants to see individual calls, and per-call rows for a 6–15 person team calling all day, every day, accumulate fast for a benefit nobody's requested.
- **Pre-aggregating all the way to "this week's average" and storing only that was also rejected.** Averages don't combine — you can't correctly compute "this month's average call length" by averaging four "this week's average call length" numbers if the weeks had different call volumes. The fix, same principle `appfolio_property_actuals` already uses for its own dollar totals: store **sums and counts**, not pre-divided averages, and divide at query time. Concretely: `total_talk_seconds` and `answered_calls` are both stored; "average call length" is `total_talk_seconds / answered_calls`, computed live in `router.js` for whatever date range was requested — the same "computed live... not written back anywhere" pattern the Budget tab's query already uses.
- **Day is the grain, not week**, because it's the smallest boundary Aircall's data naturally supports and it lets the dashboard answer "this week," "this month," or any custom range with the same SUM query — locking in a coarser week/month grain now would make a finer-grained question unanswerable later, the same reasoning `appfolio_property_actuals` used to justify locking in month (not year) as its own grain.
- **Direction (inbound/outbound) is tracked as its own dimension, not blended**, because "missed" means something different for each (see Design Decision 2's own note in "What Could Go Wrong," and the schema below) — and because speed-to-answer is only a meaningful staff-performance number for inbound calls (how fast Rincon picked up), not outbound ones (how fast the other party picked up, which reflects nothing about Rincon's staff).

### 3. Does this belong in `claims`, or bypass it?

**Bypasses `claims`**, same category as `appfolio_property_actuals` and for the same core reason, stated in that migration's own header comment and in `PROPERTY-BRAIN-ARCHITECTURE.md` Section 1.2: a row here is a structured fact fetched directly from Aircall's API and arithmetically summed (call counts, second totals), not an AI interpretation of messy source material. There's no ambiguity to resolve, no source document to cite a specific sentence from, and nothing for a human to confirm-or-correct the way a `claims` row needs — so no `confidence`/`extracted_by`/`review_status`/citation columns, matching the plain-sync pattern `appfolio_property_actuals`, `properties`, and `maintenance_requests` already use.

**Where this explicitly diverges from the `appfolio_property_actuals` precedent, stated plainly rather than inherited silently:** that migration's entire PII argument was "this table has none, by construction" — aggregating away exactly the fields (`party_name`, `party_id`) that would have made a row personal. **This table cannot make that same claim.** The whole point of this build is "which staff member" — the row's entire reason for existing is per-person attribution. So while the *bypass-claims* reasoning carries over cleanly (nothing here is an AI interpretation needing review), the *no-PII* conclusion does not, and this document does not pretend it does. See the Data Inventory section below, which is written honestly against that fact rather than copy-pasting the prior table's "NONE, by construction" entry.

### 4. Where this surfaces in the Hub

**A new, small Hub section** (`projects/hub/call-stats/`), not folded into an existing tool. Reasoning: every existing Hub tool (Insurance Compliance, Security Deposit, Maintenance History) is organized around a *property or a case* — you open a property, or a specific case, or a specific ticket. This data has no natural property to hang off of; it's organized around *a person, within a pod*, which is a genuinely different axis than anything else in the Hub today. Bolting it onto Maintenance History (the closest existing thing, since it's also an external-API-sync tool) would mean a staff-performance table showing up inside a tool whose whole identity is "history of what happened to a maintenance ticket" — confusing for no real savings, since the new section is small enough (one router, one simple dashboard, no review queue, no content-check) that there's no meaningful build-cost argument for cramming it into something else. This follows the same "one section = one subdirectory" shape every other Hub tool already uses, mounted into `server.js` and added as a fourth tile on the home page, next to the existing three.

### 5. Governance path

**Working hypothesis going in, per the task brief: probably not a compliance build.** Checked against what this design actually is, not just asserted:

- **No message is ever sent to anyone** — not a tenant, not an owner, not even the staff member whose stats are shown. This is a read-only dashboard.
- **No decision is made or influenced about an applicant or tenant.** Nothing here touches Fair Housing territory at all — there is no applicant, no tenant, no housing decision anywhere in this design.
- **CLAUDE.md's third compliance-build trigger — "stores someone's personal information" — is the one worth actually checking, not skipping past.** Read literally, this table does store personal information: a real staff member's name/email tied to their call counts, day by day. That's genuinely different from `appfolio_property_actuals`, which could honestly claim zero PII. Here, the honest answer is: **yes, this stores personal data about an identifiable person — a Rincon employee, not a tenant or applicant.**

Given that, the actual conclusion: **this does not need Asimov or Mason's review**, but not because "no personal data is involved" — it's because Asimov and Mason's specific scope in this codebase, per their own role descriptions and everything GOVERNANCE.md actually contains (the AI Governance Rules and the Fair Housing Standard, cover to cover), is tenant/applicant/housing-decision risk. Nothing in GOVERNANCE.md addresses employee-performance-monitoring data at all — it's a real category of risk, just a different one than what those two specialists are built to review. Routing this through them would be checking it against rules that don't speak to what it actually is.

That said, two things worth Peter's attention that a purely mechanical "not Asimov, not Mason" answer would gloss over:

1. **GOVERNANCE.md's Rule 4 (new tables storing personal data need a data inventory + RLS + CCPA-scan registration) still applies here, in full — Rule 4 isn't scoped to tenants, it applies to any personal data.** See the Data Inventory section below; this is followed exactly like every other table in this schema.
2. **This is employee data, which is a different body of law than anything GOVERNANCE.md was written to cover** (GOVERNANCE.md's Rules and Fair Housing Standard are consumer/tenant-facing law; employee monitoring is an employment-law question). One concrete, non-obvious point worth flagging honestly: California's CCPA employee-data exemption expired at the start of 2023 — California employees generally do have CCPA rights over their own employee data today, the same as any consumer. This document is not the place to resolve that (Oracle doesn't give legal advice any more than Mason does, and this is arguably outside Mason's stated landlord-tenant lane too) — but Peter should know it's a live question before this ships, worth a short check with whoever handles Rincon's employment-side compliance, not assumed away.

One more thing worth naming plainly, because it changes how much new privacy exposure this actually creates: **this tool doesn't create new visibility into staff call activity — Aircall's own dashboard already shows this to whoever has admin access there today.** This build only aggregates and re-displays data management can already see, in one place instead of Aircall's own interface. That's a meaningfully smaller step than building new monitoring from scratch, and it's part of why "probably not a compliance build" holds up under a real check, not just as a first-glance assumption.

### 6. Credential needed

An Aircall API credential, following this project's established `.env.example` pattern:

```
AIRCALL_API_ID=your-aircall-api-id-here
AIRCALL_API_TOKEN=your-aircall-api-token-here
```

Peter needs to generate this from Aircall's own dashboard (Integrations/API settings — exact menu path to confirm once someone's logged into Rincon's Aircall account, same as Latchel's key was sourced). **Flag, matching the same discipline `.env.example` already applies to the Latchel key:** Aircall's classic API is understood to issue one account-wide credential without a documented read-only variant — needs confirming once the credential is actually generated, but if that holds, the same compensating approach used for Latchel applies here: the sync code only ever calls Aircall's "get" endpoints, and the read-only guarantee is enforced in Rincon's own code, not by the credential itself. Sentinel should confirm this the same way it was flagged (not yet resolved) for Latchel.

### 7. Answer rate counts direct rings only

**Decision (Peter, 2026-09-10): answer rate is inbound calls answered ÷ all inbound calls that rang that person directly, per person, over the selected range. Outbound is excluded from both halves.**

The outbound exclusion is not a new judgment — it follows Design Decision 2's existing reasoning directly. An outbound call the other party doesn't pick up says nothing about how responsive a Rincon staff member is, so folding it into a number labeled "answer rate" would make the number mean less, not more.

**The part actually worth recording is what is deliberately *not* counted.** Rows in `call_stats_line_misses` — inbound calls Aircall credited to no individual — do not reach any person's answer rate. Neither half of the fraction: not the numerator, not the denominator. Peter ruled on this explicitly on 2026-09-10, after the live account check recorded above, and the reasoning is the finding itself:

- Two of Rincon's 15 lines — the Maintenance Hotline and the Leasing Line — **ring nobody at all.** They are the source of the unattributed misses. An unanswered call on a line that rings no individual cannot fairly land on any individual's number, because there is genuinely no person it rang. Attributing it to someone would be inventing an attribution Aircall itself never made — the same thing "What Could Go Wrong" warned about from the start ("there may genuinely be no *whose* to assign"), now confirmed against real data and decided rather than left open.
- **This decision does not shield anyone's real misses.** Kristen Rau is the sole user on the Office Line — Rincon's main inbound number, which rings only her — and on the Business Development Coordinator line. Aircall already attributes misses on both to her by name, so they are already counted in her answer rate today. The line-level exclusion above touches only calls Aircall left unattributed; it is not a mechanism for anyone's misses to disappear.

**Known limitation, recorded as unresolved rather than settled:** Aircall's API reports which users a line *rings*, not where a line *forwards* (see the "Still needs live verification" note above). It is confirmed that the Leasing Line does not ring Kristen directly. It is **not** confirmed that it never routes to her through a phone tree. If it turns out to, those calls stop being unattributed line misses and become hers — and her answer rate would drop accordingly. **The number this build shows today should be read with that caveat attached until a human reads the phone-tree configuration in the Aircall dashboard** (Open Item 7). This decision is correct on what is currently known; it is not proof that no attributable miss is being excluded.

**Cleanup item noticed during the same check, not acted on:** the line named "Z.DO NOT USE - PHONE TREE TEMPLATE ONLY" (+1 805-541-2938) has three live users attached — Kristen Rau, Marci Gray, and Dio Lopes. Any call landing on that line would be attributed to whoever answers it, despite the name saying it should never be used. Recorded here, deliberately not changed by this build — Aircall configuration is Peter's to change, and this tool only reads. Tracked as Open Item 8.

### 8. Outbound is counted per person, not per line

**Decision (Peter, 2026-09-10): the new "Outbound" column shows total outbound calls per person for the selected range. Per-*line* outbound was explicitly requested, investigated, and dropped the same day — it was not overlooked.**

Two separate reasons, and both matter, because they answer different questions:

- **It isn't derivable from what's stored.** `call_stats` holds no line identifier at its grain (staff member / calendar day / direction — Design Decision 2). The line a call came in on or went out from is aggregated away at sync time, by design. Producing outbound-per-line would therefore require a schema change (a line dimension added to the table's grain and its UNIQUE constraint) **plus** a full re-sync backfill from Aircall, which does retain the line on every call. That is a real, non-trivial piece of work, not a query change.
- **The reason for wanting it went away.** The motivation for per-line was a specific hypothesis: that Kristen might place prospect calls from her Business Development Coordinator line and operational callbacks from the Office Line, which would have split sales calls from operational calls cleanly, without depending on HubSpot contact matching to tell them apart. **Peter confirmed on 2026-09-10 that no such usage pattern exists** — she dials from whichever line is at hand. That removes the entire rationale.

**So this is dropped, not deferred.** The distinction is deliberate: a deferred item is one worth doing later, and there is currently no question per-line outbound would answer. If the sales-vs-operational split is wanted again, it needs a fresh reason first, and the schema-change-plus-backfill cost above is what it would cost then.

**The existing "Calls" column is deliberately unchanged.** It remains the blended inbound+outbound total it has always been. The new "Outbound" column sits beside it rather than splitting it, so nobody reading a saved figure from before 2026-09-10 finds that the same column now means something different.

---

## Proposed Data Model (for Neo to finalize)

One new table, additive only, no changes to any existing table:

```
call_stats
  id                     UUID PK

  aircall_user_id        TEXT NOT NULL   -- Aircall's own user ID, plain TEXT not a
                                          -- declared FK, same convention as
                                          -- appfolio_property_id elsewhere in this
                                          -- schema (external system, sync-order not
                                          -- guaranteed)
  staff_email             TEXT NOT NULL  -- matches users.email at query time —
                                          -- the join key for name + pod, per Design
                                          -- Decision 1. Not a declared FK: this table
                                          -- should not fail to sync a real Aircall
                                          -- call just because a name doesn't match a
                                          -- users row yet (log it instead, per "What
                                          -- Could Go Wrong")

  call_date               DATE NOT NULL  -- the day this row aggregates, in Rincon's
                                          -- own business timezone (America/
                                          -- Los_Angeles), NOT a naive UTC truncation
                                          -- of started_at — Aircall's timestamps are
                                          -- UTC and a late-evening Pacific call must
                                          -- land on the Pacific calendar day, or a
                                          -- day's totals silently split across two
                                          -- rows. Flagged explicitly for Q.
  direction                TEXT NOT NULL CHECK (direction IN ('inbound','outbound'))

  total_calls              INTEGER NOT NULL
  answered_calls           INTEGER NOT NULL
  missed_calls             INTEGER NOT NULL  -- inbound: calls nobody picked up (a
                                              -- real responsiveness signal). outbound:
                                              -- calls the other party didn't answer
                                              -- (not a staff performance signal) — kept
                                              -- honest by being split via `direction`,
                                              -- never blended into one number

  total_talk_seconds        INTEGER NOT NULL DEFAULT 0  -- sum(ended_at - answered_at)
                                                         -- over answered calls only.
                                                         -- "Average call length" =
                                                         -- this / answered_calls,
                                                         -- computed live at query
                                                         -- time — never stored
                                                         -- pre-divided (Design
                                                         -- Decision 2)
  total_ring_seconds         INTEGER NOT NULL DEFAULT 0 -- sum(answered_at -
                                                         -- started_at) over answered
                                                         -- calls only. "Average
                                                         -- speed-to-answer" = this /
                                                         -- answered_calls, same
                                                         -- computed-live rule.
                                                         -- Meaningful for inbound
                                                         -- only (Design Decision 2)

  synced_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  created_at / updated_at     TIMESTAMPTZ

  UNIQUE (aircall_user_id, call_date, direction)
```

**Open, unresolved by this table's design, per the "Needs live verification" list above:** how (or whether) to represent a call that Aircall never assigns to any individual user at all — a fully-missed call to a shared pod line. If real Rincon data turns out to have these, they cannot fit this table's grain (there's no person to attribute them to) and may need a second, much simpler pod-level-only row shape. **Recommend not designing that shape now, on a guess** — confirm first whether this case actually occurs in Rincon's real Aircall data (Design Decision 1's flagged unknown), and add it as a small follow-on migration if it does. This mirrors exactly how `appfolio_property_actuals`'s own migration left its own real unknowns (pagination behavior, month-window reset timing) as named, unresolved open items rather than guessed at.

*Update, 2026-09-10:* the case is confirmed real — two lines ring nobody — and these calls are now recorded separately in `call_stats_line_misses` rather than being attributed to a person. What that separation means for the per-person answer rate, and what it deliberately does not mean, is Design Decision 7.

**Query pattern this supports:** "this pod's stats for [date range]" = `SUM(...)` grouped by `staff_email`, filtered by `call_date BETWEEN ? AND ?`, joined to `users` for name + pod at read time — one query per dashboard load, matching the Budget tab's own live-computed pattern.

---

## Access / Roles in the Hub

Reuses the existing `team_member_tool_roles` mechanism exactly as-is — no new permission system. `tool` gets one new allowed value, `'call_stats'`, added the same way `security_deposit` was onboarded (`supabase/migrations/20260813000004_security_deposit_team_roles.sql`'s DROP-then-ADD CHECK pattern). No new `role` values are needed: `admin` and `pod_lead` already exist in the shared `role` CHECK (added for Security Deposit) and both are reusable here — a smaller Neo change than Security Deposit's own onboarding needed, since that one required a new role value too.

**v1 access is flat, deliberately, matching an already-shipped precedent, not a new gap:** anyone holding `admin` or `pod_lead` for `tool='call_stats'` sees **both** pods' numbers, not just their own. This is the exact same simplification already live for Security Deposit's `pod_lead` role today (confirmed in `security-deposit/router.js`: "Every active pod_lead role holder gets every reminder in v1 — no per-property pod routing yet"). Reusing that already-accepted limitation here, rather than building a new pod-scoped visibility rule for this tool alone, is the deliberate call — Peter decides who gets a role at all (likely himself, Director of Operations, and each pod's lead to start), the same way he does for every other Hub tool today.

---

## Data Inventory (GOVERNANCE.md Rule 4)

- **`pii_fields`:** `call_stats.aircall_user_id`, `call_stats.staff_email` — both identify a real, specific Rincon staff member, and the row's counts (call volume, missed calls, speed-to-answer) are performance data about that person. **Stated plainly, diverging from `appfolio_property_actuals`'s "NONE, by construction" entry (see Design Decision 3):** this table is not PII-free, and shouldn't be described as such.
- **`agents_with_access`:** the nightly Aircall sync process (system, service-role key); any Hub user holding `admin` or `pod_lead` for `tool='call_stats'` in `team_member_tool_roles`.
- **`privacy_category`:** employee performance metadata — not tenant/applicant data, not Fair Housing–relevant, but genuinely personal to a Rincon staff member. Separate category from anything else in this schema today.
- **`retention_policy`:** RESOLVED 2026-08-20 — indefinite, matching the default used elsewhere in this schema. Peter's explicit decision, not the technical default going unquestioned.
- **`ccpa_exportable`:** Likely TRUE — see Design Decision 5's note on California's expired employee-data CCPA exemption. Not fully resolved here; flagged for a real check before this is treated as settled.
- **`ccpa_deletable`:** Open — same reasoning. Redact-in-place (matching the pattern already used elsewhere, e.g. `claims.claim_text` → `"[REDACTED]"`) is technically straightforward if it turns out to be required; whether it's *required* for employee data the way it is for tenant data is the open legal question, not a schema question.
- **RLS:** enabled, no permissive policies at creation — matches every table in this schema.
- **Audit logging:** none, by design — matches `appfolio_property_actuals`'s own precedent (confirmed: its own sync writes no `audit_log` entries at all). This is a plain sync of a fetched-and-summed fact, the same category that precedent already established doesn't need one.

---

## Open Items — Needs Confirming Before This Gets Built

1. **Per-user attribution on Aircall's real Calls API** — confirm the `user` object (or equivalent) actually exists and is populated the way this spec assumes, against Rincon's real account, before Neo finalizes the schema. This is the single highest-risk unknown in this document.
2. ~~**Whether a fully-missed, unattributed-to-any-person call exists in Rincon's real data**~~ — RESOLVED 2026-09-10: yes, it does. Two lines (Maintenance Hotline, Leasing Line) ring nobody, and their unanswered calls are recorded separately in `call_stats_line_misses` rather than being forced onto a person. Peter's ruling on how those rows affect (and don't affect) the answer rate is Design Decision 7.
3. **Pagination shape** on Aircall's list endpoint — confirm before Q writes the sync loop, so a busy day's calls past page 1 aren't silently dropped.
4. **Auth mechanism and whether a scoped/read-only credential option exists** — get the real answer when Peter generates the credential; if not, this needs the same Sentinel sign-off the Latchel key's all-or-nothing access is still waiting on.
5. ~~**The CCPA employee-data question**~~ — RESOLVED 2026-08-20: Peter reviewed the plain-English summary of what's collected and decided to treat this as settled for now, without a formal employment-compliance check. Not a legal determination that no obligation exists — a deliberate decision to proceed without that check at this time, revisit if it ever becomes relevant (e.g., a staff member asks about their own data).
6. ~~**Retention window**~~ — RESOLVED 2026-08-20: indefinite, Peter's explicit call.
7. **Where the two no-ring lines actually forward.** The Maintenance Hotline and Leasing Line ring nobody and both report `is_ivr: false`, which can't be the full picture — a line that rings no one and isn't a menu still routes somewhere. **This cannot be answered from Aircall's API**; it needs a human opening Rincon's Aircall dashboard and reading the phone-tree configuration. If the Leasing Line does route to Kristen Rau, those calls stop being unattributed line misses and become her misses, and her answer rate drops. Design Decision 7 is correct on what's known today and is explicitly *not* claiming this is settled.
8. **Cleanup, not a blocker: the line "Z.DO NOT USE - PHONE TREE TEMPLATE ONLY" (+1 805-541-2938) has three live users attached** — Kristen Rau, Marci Gray, Dio Lopes. Any call landing there is attributed to whoever answers, contradicting the line's own name. Noticed during the 2026-09-10 check, deliberately not acted on: this is Aircall configuration, Peter's to change, and this build only reads. Flagged so it isn't mistaken later for a data bug in this tool.

---

## Rough Build Size

Small relative to the other Hub tools — no AI extraction, no content check, no review queue, no `claims` involvement. Roughly: **Neo ~1 session** (one new table, one CHECK-constraint widening), **Q ~1–2 sessions** (Aircall sync + aggregation + a simple two-table dashboard route), **Tron ~1 session** (two grouped tables with a date-range picker — no new visual pattern needed, matches the Budget tab's existing look). No Asimov/Mason session required per Design Decision 5; Sentinel should do a short pass on the credential-scope question (Open Item 4) before this connects to a live Aircall account, the same review Latchel got.
