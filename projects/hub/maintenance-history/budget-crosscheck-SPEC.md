# Maintenance Budget Cross-Check — v1 Build Spec

**Status:** Draft — awaiting Peter's approval before Neo/Q start building. Not a build yet.
**Written by:** Oracle
**Date:** 2026-08-17
**Origin:** The 10-ticket "Property Brain" trial (`projects/property-brain-experiment/trial-1-results.md`) scored 48/60 (80%) fully correct. 8 of the 10 "Partial" ratings trace to one cause: the AI cited whatever dollar figure sat in Latchel's own ticket log (`job.max_cost`, an invoice amount, a budget cap mentioned in a decision note) as if it were the property's real, final budget. The human answer key says that's the wrong source of truth — the real budget of record lives in AppFolio, not Latchel. This spec fixes that.

**Built from:**
- `projects/property-brain-experiment/trial-1-results.md` — the graded finding this spec exists to close.
- `projects/hub/maintenance-history/lib/extract-claims.js` — the live extraction pipeline; `buildJobFieldsText()` (line 123) is the exact spot a Latchel dollar figure reaches the AI prompt unchecked today.
- `projects/appfolio-sync/sync.js` — the nightly AppFolio → Supabase batch sync and its `REPORT_CONFIG` pattern.
- `projects/hub/security-deposit/lib/appfolio-connector.js` — the second, on-demand/cached AppFolio client, considered and not reused (see "Why sync.js, not the security-deposit connector" below).
- `supabase/migrations/20260816000000_property_brain_claims_phase1.sql` and `projects/hub/PROPERTY-BRAIN-ARCHITECTURE.md` — the generalized `claims` table, considered and not used for this feature (see "Why this doesn't go through `claims`" below).
- `supabase/migrations/20260626000000_initial_schema.sql` — confirmed real columns on `properties`, `units`, `maintenance_requests` (`maintenance_requests.cost`, `unit_id → units.id → properties.id`).
- `projects/hub/maintenance-history/property-overview-SPEC.md` — a second, not-yet-approved spec that already reserves a "Spend rollup" section on a future property overview page. Not a dependency of this spec (see "Where this lives" below), but this spec is written so that section can read from this feature's route later instead of it being rebuilt.
- `.env.example` — confirmed `APPFOLIO_CLIENT_ID`/`APPFOLIO_CLIENT_SECRET` already exist and are the credential this feature would reuse.
- `GOVERNANCE.md` and CLAUDE.md's compliance-build boundary ("sends messages to tenants/owners, makes or influences a housing decision, or stores personal data").

**Where this lives:** `projects/hub/maintenance-history/` — a new tab on the existing Maintenance History dashboard (`router.js` + `dashboard/index.html`), reusing its login and the already-live hub-wide property search (`GET /api/hub/search-properties`). Not a new Hub tile, not a new project. Chosen over `projects/appfolio-sync/` because the *sync job* lives there, but the *thing a person looks at* belongs next to the tool whose accuracy problem it fixes.

---

## What This Does

Today, when the maintenance tool tells you what was decided on a ticket — "vendor budget capped at $250, hard limit $1,000" — that dollar figure comes straight from Latchel's own internal log, not from Rincon's actual books. The trial found this is the single biggest accuracy problem in the tool: 8 of 10 imperfect grades were exactly this — a real number, sourced honestly, but presented as if it were the official budget when nobody had checked it against AppFolio.

This build does two things:

1. **Stops the tool from overstating what a Latchel dollar figure means.** Any time a ticket's "what was decided" summary mentions a dollar amount, it will now say plainly that the figure is Latchel's own internal number for that one ticket, not a confirmed budget — instead of stating it as fact.
2. **Adds the real comparison, at the level that actually works.** A ticket-by-ticket dollar figure can't be checked against AppFolio's budget, because AppFolio doesn't track budgets per ticket — it tracks a property's whole year. So instead of a false per-ticket "match/no match," this build adds a new "Budget" view: pick a property, see what AppFolio's own books say that property's yearly Repairs & Maintenance budget is, what AppFolio's own books say was actually spent, and the individual maintenance tickets that make up that spending, for context. It's a real, apples-to-apples comparison, pulled directly from AppFolio — not a guess and not a mismatch alarm.

## How It Works

**Part 1 — Fixing what the tool already says (ships first, cheapest, no new data connection):**
1. The extraction step that writes "what was decided" summaries gets a wording change. When Latchel's own record shows a dollar figure attached to a ticket (a spending cap, an estimate, an invoice amount), the summary now says something like *"Latchel recorded a $250 spending limit for this ticket — not yet checked against AppFolio's official budget"* instead of *"Budget: $250."*
2. Nothing about where facts get stored changes. This is a wording instruction to the AI, not a new database column, and it doesn't touch anything else the tool already extracts (events, outcomes, related tickets).
3. This does not retroactively rewrite tickets already processed — those keep their current wording until re-processed. Whether to re-run the extractor on old tickets is Peter's call (see Open Items).

**Part 2 — The real budget comparison (new data, new view):**
1. **Once a night**, as one more step in the AppFolio sync job that already runs (`projects/appfolio-sync/sync.js`), Rincon pulls AppFolio's own Budget report — the report family that shows, per property, per spending category (e.g. "Repairs & Maintenance"), what was budgeted for the year and what AppFolio's own books say was actually spent.
2. That gets saved into a new, small table — one row per property, per year, per spending category. Budgets barely change, so most nights this is just confirming nothing moved.
3. **In the Hub**, a new "Budget" tab is added to Maintenance History. Type a property name or address (the same search box already used elsewhere in the Hub), and see: this year's AppFolio-reported Repairs & Maintenance budget, what's actually been spent according to AppFolio, and — underneath, for context — the list of maintenance tickets and their individual costs that make up that spending.
4. The ticket list is shown as supporting detail, not as a second total that's supposed to match the AppFolio number exactly. It won't, and that's expected — a ticket's cost can post to AppFolio's books weeks after the ticket closes, and AppFolio's "actual spend" line can include repair costs that never went through Latchel at all. The screen shows both, clearly labeled, rather than pretending they're the same number.

## What You'll See

- On any maintenance ticket's "Decisions" section: dollar figures now read as Latchel's own internal number, clearly marked as not yet checked against the real budget — instead of being stated as if they were the final word.
- A new **"Budget"** tab in Maintenance History, next to the existing "Tickets" tab. Search a property, and see a simple card: *"751 Warwick Ave — 2026 Repairs & Maintenance: $15,000 budgeted, $18,400 spent per AppFolio"* — pulled straight from AppFolio's own numbers, nothing guessed or calculated by AI. Below it, a plain list of this property's maintenance tickets from that year and what each one cost, for context.
- Nothing here sends anything to anyone, changes any AppFolio or Latchel record, or makes a decision. It's a read-only comparison screen.

## What Could Go Wrong

- **Rincon's current AppFolio access might not include the Budget reports.** AppFolio's Reports API can be gated by subscription level, and this hasn't been tested live. First real step of the build has to be a live check — if it's not included, this needs a call to AppFolio before anything else proceeds. Flagged below as the first Open Item.
- **The ticket-cost list and AppFolio's "actual spend" number will not tie out exactly**, for the reasons above (timing lag, non-Latchel-tracked repair costs). If this isn't presented carefully, it recreates the exact "which number do I trust" confusion this build exists to fix, just one level up. The screen design above (two clearly separate, clearly labeled numbers, never a "match/mismatch" flag) is the guard against that — worth double-checking once real data is in front of it.
- **A property with a partial year of AppFolio data, or a brand-new property, may show an incomplete or missing budget line.** The screen should say plainly "no AppFolio budget data found for this property/year" rather than showing a blank or a zero that looks like a real number.

---

## The Design Question: What Does "Cross-Check" Actually Mean Here

This is the part worth explaining rather than just asserting, since the obvious first idea — "flag it when a ticket's dollar figure doesn't match AppFolio" — doesn't actually work, and it's worth being clear about why before describing what does.

**Why a per-ticket match/mismatch doesn't work:** AppFolio's budget reports are a property's whole-year number for a whole spending category (e.g., "this property's 2026 Repairs & Maintenance budget is $15,000"). Latchel's `job.max_cost` is a cap on one ticket (e.g., "$250 for this specific vendor visit"). There is no version of AppFolio's data that answers "was $250 the right number for this one ticket" — that fact doesn't exist anywhere in AppFolio. Building a feature that implies it can check that would be inventing a false precision, not fixing one.

**What does work:** ticket costs, added up over a year for one property, are the same kind of number as AppFolio's yearly "actual spend" line — both are "how much did this property's repairs cost this year." That's a real, like-for-like comparison, even though it won't tie out to the penny (see "What Could Go Wrong"). That's the comparison this spec builds: property + year + category, not ticket + limit.

**So this spec does two things, not one — a cheap fix now and the real feature on top**, rather than picking option (a) [per-property annual rollup] or (b) [a caveat label] alone from the original brief:
- The caveat-label change (Part 1) ships immediately, requires no new AppFolio connection, and directly closes the exact defect the trial measured — 8 of 10 misses were graders penalizing an unqualified dollar figure, and this fixes that regardless of whether Part 2 ever gets used.
- The property-level annual comparison (Part 2) is the real, durable answer — it's the first time this system will show Peter an actual AppFolio-sourced budget number next to actual AppFolio-sourced spending, instead of relying on Latchel's version of events at all.

Shipping only the label change and skipping Part 2 would leave Peter without any real budget visibility — just a more honest disclaimer. Shipping only Part 2 and skipping Part 1 would leave every already-flagged ticket decision still overstating a Latchel number for weeks while Part 2 gets built. Both are cheap enough to do together.

## Why This Doesn't Go Through the `claims` Table

`projects/hub/PROPERTY-BRAIN-ARCHITECTURE.md`'s `claims` table (and the live `maintenance_claims` table it generalizes) exists for facts an AI had to *extract and interpret* from messy source material — a ticket description, a PDF, a state-history entry — where something could plausibly be mis-read, mis-cited, or need a human to confirm it. That's why every claim carries `confidence`, `extracted_by`, and starts `review_status = 'unreviewed'` until a person checks it.

An AppFolio budget-vs-actual number isn't that. It's a structured field, fetched directly from AppFolio's own report API, with no AI reading or interpretation step in between — the same category of fact as `properties.address` or `maintenance_requests.cost`, both of which already sync straight into their own tables today with no claims wrapper and no review gate. Forcing a fetched fact through `unreviewed` → someone-clicks-confirm would ask a person to "review" a number that was never actually uncertain, which is overhead with no real safety benefit. **This gets a new plain synced table, matching the `properties`/`units`/`maintenance_requests` pattern, not the `claims` pattern.**

The one place this feature *does* touch existing claims content is Part 1 — and there, nothing about the claims/review-gate mechanism changes. It's the same `maintenance_claims.claim_text` field, written by the same extraction step, just with different wording instructions. It still goes through the existing content check and still lands as `unreviewed` exactly as today.

## Why sync.js, Not the Security-Deposit Connector

Two AppFolio clients already exist in this codebase for different reasons: `appfolio-sync/sync.js` is a nightly batch job — pull everything, once a night, no matter who's looking. `security-deposit/lib/appfolio-connector.js` is built for a bursty, on-demand pattern — a pod lead opens one case and needs one lease's live data right now, so it adds a short in-memory cache to absorb repeat clicks without tripping AppFolio's rate limit.

Budget data has no on-demand access pattern — nobody opens "one budget case" the way a pod lead opens one lease. It's portfolio-wide and changes rarely (property managers set an annual budget once, maybe revise it occasionally). That's exactly `sync.js`'s shape, not the connector's. **This adds one more entry to `sync.js`'s existing `REPORT_CONFIG` array**, reusing the batching/rate-limit handling already built there, rather than building a third AppFolio client or bolting an unrelated access pattern onto the security-deposit connector.

**Cadence: nightly, same run, not a separate schedule.** Budgets rarely change, so most nights this step just re-confirms the same numbers. Running it nightly anyway (rather than inventing a weekly job) costs nothing extra — it's one more report in a loop that already exists — and avoids asking Scotty to stand up a second cron schedule for a trivial savings. Matches Peter's own "simple is better than clever" standing rule.

---

## Data Flow

```
AppFolio (Budget - Comparative report, or nearest equivalent — see Open Items)
        │  nightly, via existing sync.js REPORT_CONFIG loop
        ▼
appfolio_property_budgets  (new Supabase table — Neo)
        │
        │  joined at query time with:
        ▼
maintenance_requests.cost ── units.property_id ── properties.appfolio_id
        │
        ▼
GET /api/maintenance-history/property/:property_id/budget  (new route — Q)
        │
        ▼
"Budget" tab, Maintenance History dashboard  (Tron)
```

Separately, unrelated to the flow above:

```
Latchel job fields (job.max_cost, invoice amounts, decision-note $ figures)
        │
        ▼
extract-claims.js — prompt wording change only (Q)
        │
        ▼
maintenance_claims.claim_text  (existing table, existing review gate — unchanged)
```

---

## Neo's Section — Schema

One new table. No changes to `claims`, `maintenance_claims`, or any existing table.

```
appfolio_property_budgets
  id                     UUID PK

  appfolio_property_id   TEXT NOT NULL     -- joins to properties.appfolio_id.
                                            -- Not resolved into a stored property_id FK — see
                                            -- "Why no FK-resolution step" below.

  fiscal_year             INTEGER NOT NULL  -- exact period representation (single year vs.
                                             -- period_start/period_end) TBD once the real report
                                             -- shape is confirmed live — see Open Items.

  gl_account_name          TEXT NOT NULL   -- e.g. "Repairs & Maintenance". Sync EVERY category
                                            -- the report returns, not just R&M — same "sync
                                            -- broad, filter at display time" pattern sync.js
                                            -- already uses for rent_roll/delinquency/etc. — so a
                                            -- future feature wanting a different budget line
                                            -- doesn't need a second sync built for it.

  budgeted_amount           NUMERIC(12,2)
  actual_amount              NUMERIC(12,2) -- NULL if the report doesn't provide an actual
                                            -- column at this grain — confirm via live discovery,
                                            -- don't assume

  synced_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  created_at / updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()

  UNIQUE (appfolio_property_id, fiscal_year, gl_account_name)  -- upsert key;
                                            -- exact grain (is a row really unique per
                                            -- property+year+category, or does AppFolio return
                                            -- monthly rows too?) TBD by live discovery
```

**Why no FK-resolution step into a stored `property_id`:** `sync.js`'s existing `resolve_appfolio_foreign_keys()` RPC exists because several tables (`units`, `leases`, `maintenance_requests`) get *written to* using an AppFolio ID and need a real foreign key resolved afterward for joins elsewhere in the app. This table is only ever read one way — "show me this property's budget" — which is a single join (`properties.appfolio_id = appfolio_property_budgets.appfolio_property_id`) at query time. Adding this table into the shared FK-resolution RPC would touch code every other synced table depends on, for a saving that doesn't exist yet. Simple join at read time, no shared machinery touched — Neo's call to revisit if a second real consumer of this table ever needs a stored FK.

**Data inventory (GOVERNANCE.md Rule 4 pattern, followed for consistency even though this table carries no personal data):**
- `pii_fields`: NONE. This table holds property-level budget figures only — no tenant name, no contact info, no protected-class-adjacent content of any kind.
- `agents_with_access`: the nightly sync process (service-role key); any Hub user with existing Maintenance History access (no narrower `reviewer`/`admin` gate needed — this isn't a claim requiring review, see "Why this doesn't go through claims" above).
- `privacy_category`: N/A — no personal data.
- `retention_policy`: indefinite, same as `properties`/`units` — nothing to redact.
- `ccpa_exportable` / `ccpa_deletable`: N/A — not tied to any individual contact.
- **RLS:** enabled, no permissive policies at creation — matches every table in this schema.

No changes needed to `claim_type_registry`, `claims`, or `maintenance_claims` — this feature adds no new claim type.

---

## Q's Section — Build

**Part 1 (ship first, no new external dependency):**
- Edit `projects/hub/maintenance-history/lib/extract-claims.js`:
  - `buildJobFieldsText()` (line 123): relabel the `Max cost (budget)` field so the model sees it framed as Latchel's own internal figure, not a confirmed budget.
  - `EXTRACTION_PROMPT_HEADER`: add explicit instruction that any 'decision' claim citing a dollar figure (max_cost, an invoice amount, a stated cap/limit in a decision note) must phrase it as Latchel's own recorded figure, not yet checked against AppFolio's official budget — never use the word "budget" to describe it as settled.
- No schema change, no new route. Existing tests/re-runs of the extractor should be spot-checked against a few of the trial's own 8 "Partial (budget sourcing)" tickets (17061-1, 17111-1, 17432-1, 17468-1, 17480-1, 17537-1, 17583-1) to confirm the new wording actually reads the way this spec intends.

**Part 2:**
- Extend `projects/appfolio-sync/sync.js`'s `REPORT_CONFIG` with one new entry for the Budget report, once the real report name and field shape are confirmed (see Open Items) — same `buildRow()` pattern every other entry already uses.
- New route(s) on `projects/hub/maintenance-history/router.js`:
  - `GET /api/maintenance-history/property/:property_id/budget` — returns this property's most recent 1-2 fiscal years of `appfolio_property_budgets` rows (filtered/labeled to the Repairs & Maintenance category for the v1 screen), plus a live-queried rollup of `maintenance_requests.cost` for the same property/year window (via `units.property_id`), returned as a separate, clearly-labeled list — never merged into one number.
- New "Budget" tab in `projects/hub/maintenance-history/dashboard/index.html`, following the existing `tab-bar`/`showTab()` pattern already in that file. Reuses the already-live `GET /api/hub/search-properties` search box (no new search endpoint).
- **Forward-compatibility note, not a dependency:** `projects/hub/maintenance-history/property-overview-SPEC.md` (not yet approved) already reserves a "Spend rollup" section on a future property overview page. If that spec is approved later, its build should call this feature's `/budget` route rather than re-deriving the same numbers — flagged here so it isn't rebuilt twice, not because this spec requires that page to exist.

---

## Governance Path

**This does not need the Asimov/Mason compliance-build gate.** Per CLAUDE.md's own boundary, that gate applies when a build "sends messages to tenants/owners, makes or influences a housing decision, or stores personal data." This feature does none of those:
- No message is ever sent to anyone.
- No decision about a tenant or applicant is made or influenced — this is property-level financial reporting, not a housing decision.
- The new table stores property-level budget figures only — no tenant data, no protected-class data, no PII of any kind (see Neo's data-inventory section above).
- Part 1's change is a wording adjustment to an existing, already-governed extraction prompt. Per `PROPERTY-BRAIN-ARCHITECTURE.md` Section 8's own reasoning on change tiers: a change scoped to one domain's own extraction prompt (not the shared protected-class/privilege guardrail logic) is GOVERNANCE.md Rule 6 **Standard** tier at most — owner approval, not a full Critical-tier review. Peter approving this spec satisfies that.

**Follows CLAUDE.md's light 7-step pipeline only:** Oracle (this spec) → Neo (schema) → Q (build) → TARS (test with real data) → Judge (quality check) → Peter confirms. No Asimov, no Mason step required.

Sentinel is worth a quick look regardless, not because this crosses a compliance threshold, but because it touches a real external credential (`APPFOLIO_CLIENT_ID`/`APPFOLIO_CLIENT_SECRET`) — the same light "any time an API is involved" check this codebase already applies elsewhere, not a compliance gate.

---

## Open Items — Needs Confirming Before Neo/Q Build

1. **Does Rincon's current AppFolio API access actually include the Budget report family?** Not tested live in this spec — AppFolio's Reports API can be gated by subscription tier, and this spec was explicitly told not to assume otherwise. First real build step: a live `--discover`-style probe against candidate report names (starting with `Annual Budget - Comparative`, since it's explicitly annual and explicitly comparative — the closest fit to "budgeted vs. actual"; `Budget - Comparative` as a fallback) using the existing `APPFOLIO_CLIENT_ID`/`APPFOLIO_CLIENT_SECRET`. If access is blocked, this needs a call to AppFolio before Part 2 can proceed — Part 1 is unaffected either way and can ship on its own.
2. **Exact report slug and field names are unconfirmed.** Every existing entry in `sync.js`'s `REPORT_CONFIG` has its field names "confirmed by `--discover`," never guessed — this feature should get the same treatment before Neo finalizes `appfolio_property_budgets`' column types/grain (does a row come back per property+year+category, or does it include monthly detail too? Is there a real `actual_amount` column, or does "actual" require a second report?).
3. **Should already-extracted `maintenance_claims` rows (the ones the trial already graded) be re-processed under the new wording, or left as-is?** Re-running the extractor on old tickets costs real API time/money for tickets nobody may ever look at again. Peter's call, not assumed here — can be decided after Part 1 ships and the new wording is confirmed to read correctly on a few real tickets.
4. **No new environment variable is anticipated** (reuses the existing AppFolio credential) — but this is contingent on Open Item #1 confirming that credential's scope actually covers Budget reports.

---

## Size Estimate

Smaller than the base Maintenance History build or the property-overview spec — no new external credential to set up (reuses AppFolio's existing one), no new AI extraction pipeline (Part 2 has zero AI involvement; Part 1 is a prompt-wording edit to an existing pipeline), no new content-check or review-gate machinery.

Rough shape: **Neo — well under 1 session** (one small table, no FK-resolution changes). **Q — 1-2 sessions** (Part 1 is a small, contained prompt edit; Part 2 is one new sync-report entry plus one new route, following patterns already proven twice in this codebase). **Tron — under 1 session** (one new tab, reusing the existing search widget and tab pattern). **TARS/Judge** — a normal pass, no Asimov/Mason step per the governance section above.
