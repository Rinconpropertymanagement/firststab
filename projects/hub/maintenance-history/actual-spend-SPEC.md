# Maintenance Budget — Actual Spend (Part 3) — v1 Build Spec

**Status:** Draft — awaiting Peter's approval before Neo/Q start building. Not a build yet.
**Written by:** Oracle
**Date:** 2026-08-17
**Origin:** `budget-crosscheck-SPEC.md` (Part 2) shipped the Budget tab with `actual_amount` always NULL, because at the time no per-property "actual spend" report was known to exist in AppFolio's API. `sync.js`'s `annual_budget_forecast` entry (lines 273–353) later confirmed live that no pre-totaled per-property actual-spend report exists, but flagged that AppFolio's `general_ledger` report *does* carry individual transactions tagged by property, and that summing them was "a materially bigger and riskier piece of work than a straight sync, not something to guess at" — deferred to a future spec. This is that spec.

**Built from, and confirmed live against, Rincon's real AppFolio account (2026-08-17), using the existing `APPFOLIO_CLIENT_ID`/`APPFOLIO_CLIENT_SECRET` from `.env` — same credential, same `v2/reports` endpoint every other `REPORT_CONFIG` entry already uses:**
- `projects/hub/maintenance-history/budget-crosscheck-SPEC.md` — this spec's own predecessor; same property, same UI, same governance reasoning extended here.
- `supabase/migrations/20260817000000_appfolio_property_budgets.sql` — the table this spec's data will sit next to (not inside).
- `projects/appfolio-sync/sync.js` — `REPORT_CONFIG` pattern, `annual_budget_forecast` entry (lines 273–353), `supabaseUpsertComposite()`, and the "sync broad, filter at display time" convention.
- `projects/hub/maintenance-history/dashboard/index.html` (line 488) and `router.js` (lines 414–537) — the exact spot "Actual (AppFolio)" renders as "not available from AppFolio" today.
- Four live probe scripts run against `https://rinconpm.appfolio.com/api/v2/reports/general_ledger.json` and `.../annual_budget_forecast.json` during this spec, discussed in full below.

---

## What This Does

The Budget tab Q already shipped shows two honest numbers side by side: what AppFolio says a property's yearly repair budget is, and — for context — what Rincon's own maintenance tickets cost. The middle column, "Actual (AppFolio)" — what AppFolio's own books say was really spent — has sat empty since launch, because no AppFolio report hands back that number pre-calculated.

This build fills that column in, by pulling AppFolio's raw accounting transactions (its general ledger) every night, adding up what was actually spent per property per spending category, and storing that running total. It does not touch the ticket-cost column or the budgeted-amount column — it only turns "not available from AppFolio" into a real dollar figure, sourced the same way every other number on that screen is: straight from AppFolio's books, no AI involved.

**One important limit, found live and worth knowing up front:** AppFolio's transaction report will only ever hand back the current month's activity — it ignores every date-range option tried. There is no way to pull January through July's numbers after the fact. That means this feature's "actual spend" total can only include activity from the day this sync starts forward, not the whole fiscal year retroactively. More on this below.

## How It Works

1. **Once a night**, as one more step in the existing AppFolio sync (`sync.js`), Rincon pulls AppFolio's general ledger — every accounting transaction AppFolio has recorded recently, tagged with which property, which spending category, and how much.
2. The sync adds up, per property and per category, how much was actually spent this month (money out, minus any refunds or credits back in) — and saves that one number. It does **not** save the individual transactions themselves (see "Storage Design" for why).
3. Because AppFolio only ever shows "this month," each month's total gets locked in permanently once that month ends, and a new month starts accumulating from zero. The Budget tab adds up every locked-in month plus the current month-in-progress to show "actual spent so far this year."
4. The Budget tab's existing "Actual (AppFolio)" column, which has shown "not available" since launch, now shows this real number once enough nights of syncing have happened to populate it.

## What You'll See

- On the Budget tab, the "Actual (AppFolio)" column that currently says "not available from AppFolio" now shows a real dollar figure, e.g. *"$4,230.00"* — sourced directly from AppFolio's own transaction records, no AI involved, same as the budgeted-amount column next to it. Where a tenant reimbursement contributed to that category, a second line shows how much: *"$4,230.00 spent — $310.00 reimbursed by tenants."* Per Peter's decision (Decision 3), the reimbursed amount is a breakout of the total, not something subtracted from or added on top of it.
- A small note under the number (or a tooltip, matching the existing pattern) explaining that this reflects AppFolio activity **since Rincon started tracking it through this tool** — not necessarily the whole fiscal year — so a property's "actual" figure will look artificially low for a while after this ships and build up correctly from there. This is not a bug; it's a real limit of what AppFolio's API will hand back (see below).
- Nothing changes about the budgeted-amount column, the ticket-cost list underneath, or any of Part 1/Part 2's existing behavior.

## What Could Go Wrong

- **The "actual spend" number will look incomplete for months after launch**, because AppFolio's API physically cannot hand back this year's January–July data — only "from whenever the sync started" forward. If this isn't labeled clearly, someone could mistake "$1,200 spent" for the whole year's spend when it's really just three weeks of tracked data. The UI note above is the guard against that.
- **AppFolio's transaction report's exact "current window" behavior (does it reset exactly on the 1st of the month, or something else?) was only checked from a single point in time today** — real confirmation needs either a check right at a month boundary or a direct question to AppFolio support. If it turns out to behave differently than assumed, a month's total could be recorded early/late or missed. Flagged as an Open Item, not guessed past.
- **Getting the reimbursable split wrong would quietly produce a plausible-looking wrong number** — exactly the kind of failure this whole feature (and its Part 1 predecessor) exists to prevent. Decision 3 settles the rule (`party_type == 'Occupancy'` on the credit side, confirmed live, not guessed), but TARS should still hand-check it against a real property/category once data is flowing, the same way any new arithmetic gets verified before being trusted.

## What Q Needs to Build This

- The existing AppFolio API credential (already in `.env`, already used by every other report) — nothing new to set up.
- One new small Supabase table (Neo, below).
- One new `REPORT_CONFIG` entry in `sync.js`, following the exact pattern the `annual_budget_forecast` entry already established.
- A small addition to the existing `/api/maintenance-history/property/:property_id/budget` route and the Budget tab's rendering — filling in a column that already exists in the UI, not building a new screen.

---

## Decision 1 — Live Check Results (done, not deferred to Q)

Rather than instruct Q to discover this blind, I ran the discovery live, the same way `--discover` already works for every other report in `sync.js`, using the real credential already in `.env`. Full results:

**Endpoint confirmed:** `POST https://rinconpm.appfolio.com/api/v2/reports/general_ledger.json`, empty body, same auth header pattern as every other report. Returns a bare JSON array (not the `{results: [...]}` wrapper), no `next_page_url`, 4,423 rows in one call — same shape `sync.js`'s own comment already documented for the whole budget-report family.

**Real field names on every row** (confirmed live, 44 fields total):
```
account_name, account_id, property_id, property_name, property_address,
property_street, property_city, property_state, property_zip, unit_id,
post_date, month, quarter, year, party_name, type, reference,
debit, credit, bank_account, txn_id, txn_detail_id, description, ...
(plus internal/integration-ID fields not needed here)
```

**Finding A — the report's account-name text does NOT match the Budget table's vocabulary, but a reliable join key exists.** `general_ledger.account_name` comes back as `"6210 - Repair"` (AppFolio's internal code, then the name). `annual_budget_forecast.account_name` (already stored in `appfolio_property_budgets.gl_account_name`) comes back as bare `"Repair"` — no code. String-matching them directly would silently fail for every category. But both reports also carry `account_id`, AppFolio's own stable internal numeric ID for that GL account (e.g., `"Repair"` is `account_id: 34` on *both* reports). I cross-checked all 42 account IDs appearing in the general ledger against the 54 in the budget report: **40 of 42 matched exactly** by ID (the two that didn't — "Security Deposits Clearing" and "AppFolio Insurance Services" — are balance-sheet/passthrough accounts with no budget line, which makes sense). **Recommendation: join and store using `account_id`, not text-matching the name.** Strip the "NNNN - " prefix from `account_name` only for display, so the stored `gl_account_name` text still matches `appfolio_property_budgets`'s existing vocabulary exactly.

**Finding B — sign convention.** `debit` and `credit` are separate columns; in every row observed, only one of the two is ever populated (never both). For an expense account, a debit increases the expense (real spend), a credit reduces it (refund, reversal, or — see the open item below — a tenant billback landing in the same account). Net spend for a property+category+period = `sum(debit) − sum(credit)`, treating blank as zero. This is a standard, well-understood accounting rule, not a guess.

**Finding C — the report ignores every date-range parameter tried.** I tested `{}` (no params), `{from_date, to_date}`, `{start_date, end_date}`, and `{period_from, period_to}`, each requesting the full 2026 calendar year. **All four returned the identical 4,423 rows**, spanning only `2026-08-01` through `2026-08-17` — today's date. This mirrors exactly what `sync.js`'s own comment already found for `annual_budget_forecast` (date params silently ignored there too). **This is the load-bearing constraint for this whole spec** — see "Decision 2" below for what it means for storage design, and the Open Item below for what's still unconfirmed about it.

**Finding D — a real PII wrinkle, found live, that changes the governance answer.** The general ledger is not exclusively vendor/expense data — `party_name` on many rows is a tenant's real name, including on rows tagged to *expense* GL accounts. Example, verbatim from today's live pull: a credit-side transaction on `"6410 - Electricity"`, `type: "eCheck receipt"`, `party_name: "Scott Sander"`, `description: "Utility charge for Electric from 06/16/2026 to 07/15/2026"` — a tenant's utility reimbursement landing in the same GL account as the expense it offsets. This directly affects both the storage design and governance decisions below — flagged there, not glossed over.

**Finding E — there's a structured field behind the "tenant name" signal, and it's more reliable than the name itself.** Every row also carries `party_type`, AppFolio's own classification of who the counterparty is. Live vocabulary confirmed across all 4,423 rows: `Occupancy` (a tenant, via their lease/tenancy record), `Owner`, `Vendor`, `Management Company`, or `null`. On expense-tagged accounts specifically: every debit-side vendor payment I found (CheckSend/eCheck to "AA Garage Doors," "Clark & Sons Aire Inc," etc.) carries `party_type: "Vendor"`. Every one of the 32 credit-side "reimbursement-shaped" rows found in Finding D — the Electricity/Gas/Water/Insurance billbacks, plus move-out damage recoveries on Miscellaneous Expense ("Paid Charge at Move Out: Move out cleaning," "Floor replacement... due to damage") — carries `party_type: "Occupancy"`. Rather than detecting "is this string a person's name" (fragile, and exactly the kind of guessing this codebase's own conventions avoid), **`party_type == 'Occupancy'` is the real, structured signal for "a tenant is the counterparty on this line."** This is what Decision 3 below uses.

**One nuance Finding E also surfaced, worth flagging precisely because it looks similar but isn't:** 9 rows had `party_type: "Occupancy"` on the *debit* side, not credit — e.g. `"7700 - Miscellaneous Expense"`, debit \$538.05, party "Stefanie R. Navarro," and another debit \$10.95 for the same tenant described as `"Hotel stay from 04/27 to 04/30, due to maintenance repairs"`. These are payments made **to** a tenant (relocation/hotel costs during a repair, an "Inhabitability" credit) — real spend, tenant-linked, but the opposite of a reimbursement: money going out to a tenant, not coming back in from one. These must stay counted as ordinary spend and must **not** be counted as "reimbursable" — see Decision 3.

---

## Decision 2 — Storage Design: Aggregate Only, New Table, Monthly Grain

**Decision: store a monthly aggregate (one row per property + GL account + month), not raw transaction lines. New table, not a change to `appfolio_property_budgets.actual_amount`.**

**Why not raw transaction lines**, despite the audit-trail appeal:
1. **AppFolio's own report can't actually deliver a complete raw history anyway** (Finding C) — it only ever shows the current month. Raw storage could never contain more than "this month forward from whenever the sync started," so it can't fully deliver the "drill into any transaction from any point in the year" promise that makes raw storage worth its cost in the first place. AppFolio itself remains the real system of record for line-item detail; Peter or his bookkeeper can already open AppFolio directly for that.
2. **Real PII risk, confirmed live (Finding D).** Raw general-ledger rows carry tenant names in `party_name` on transactions that touch expense-category GL accounts, not just on obviously tenant-facing accounts like Rent Income. Storing raw lines would put tenant names into this schema for the first time on this feature — a real change from the "no personal data" design every table in this area has held to so far (see Governance below). Aggregating at sync time — keeping only the property, category, month, and net dollar total, discarding `party_name`, `description`, `txn_id`, and everything else — avoids ever writing a tenant's name to Supabase for this feature.
3. **Volume/shape mismatch**, exactly as flagged in the task: 4,423 rows *in seventeen days, one property portfolio*. A full year, kept as raw lines, would be tens of thousands of rows growing forever — a genuinely different animal from every other table in this schema, for a benefit (drill-down) that's already covered by AppFolio's own interface.

**Why a new table, not `appfolio_property_budgets.actual_amount`:** Because of Finding C, there is no single number to write into that column — the real annual total has to be *built up* month by month as each month closes (AppFolio's window won't hand back last month's number again once it's rolled over, so each month's total has to be captured and permanently kept before the window moves on). That's a fundamentally different write pattern than the budget table's "set once a year, rarely touched" shape — exactly the distinction the task description anticipated. Forcing it into one nullable column on the yearly-grain budget table would either lose the monthly detail needed to compute a correct running total, or require a totally different write pattern bolted onto a table that doesn't otherwise need one. `appfolio_property_budgets.actual_amount` stays NULL and unused, exactly as Neo originally designed it ("nullable specifically so a sync run that only has budgeted_amount doesn't need to fake a zero") — that original decision holds up and isn't being revisited.

### New table: `appfolio_property_actuals`

```
appfolio_property_actuals
  id                     UUID PK

  appfolio_property_id   TEXT NOT NULL      -- String(row.property_id), same convention as
                                             -- appfolio_property_budgets

  period                 TEXT NOT NULL      -- 'YYYY-MM', AppFolio's own month-id format
                                             -- (matches annual_budget_forecast's months[].id
                                             -- shape already used in sync.js) — this table's
                                             -- natural grain, since AppFolio's report only
                                             -- ever exposes "the current month."
  fiscal_year            INTEGER NOT NULL   -- derived from period at write time (same
                                             -- parseInt(...slice(0,4)) pattern the existing
                                             -- annual_budget_forecast entry already uses) —
                                             -- stored, not computed at query time, purely so
                                             -- "sum this property's year" is a plain filter.

  gl_account_id           INTEGER NOT NULL  -- AppFolio's own internal numeric account ID —
                                             -- the real join key (see Finding A). NOT text.
  gl_account_name          TEXT NOT NULL    -- "NNNN - " prefix stripped at write time so this
                                             -- matches appfolio_property_budgets.gl_account_name
                                             -- character-for-character (e.g. "Repair", not
                                             -- "6210 - Repair") — display convenience only,
                                             -- gl_account_id is the real key.

  net_amount                 NUMERIC(12,2) NOT NULL  -- sum(debit) - sum(credit), ALL
                                             -- transactions for this property + account +
                                             -- month, no filtering by counterparty — this is
                                             -- the "total spend" figure, and per Peter's
                                             -- decision (Decision 3) it deliberately still
                                             -- INCLUDES tenant reimbursements/billbacks netted
                                             -- in, exactly like every other credit. Computed
                                             -- from the raw general_ledger rows at sync time;
                                             -- the raw rows themselves are never written
                                             -- anywhere — see "Why not raw transaction lines"
                                             -- above.

  reimbursable_amount           NUMERIC(12,2) NOT NULL DEFAULT 0  -- the portion of
                                             -- net_amount that was offset by a tenant, not a
                                             -- second total — sum(credit) restricted to rows
                                             -- where party_type == 'Occupancy' (Finding E),
                                             -- for this same property + account + month. Lets
                                             -- staff see "$X of this category's spend was
                                             -- covered by a tenant reimbursement" without
                                             -- changing net_amount itself (Decision 3). Tenant
                                             -- DEBIT rows (money paid TO a tenant — Finding E's
                                             -- nuance) are correctly excluded from this figure;
                                             -- they remain ordinary spend inside net_amount
                                             -- only. party_type/party_id/party_name are read
                                             -- and used only in memory to decide which bucket a
                                             -- dollar amount falls into — never written to this
                                             -- table or anywhere in Supabase.

  synced_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  created_at / updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()

  UNIQUE (appfolio_property_id, period, gl_account_id)  -- upsert key. While a month is still
                                             -- "current" in AppFolio's window, this row gets
                                             -- overwritten every night with the latest running
                                             -- total for that month. Once the calendar rolls
                                             -- past that month, AppFolio's window moves on and
                                             -- this row simply stops being touched — it's the
                                             -- permanent record of that month's total.
```

RLS enabled, no permissive policies — matching every table in this schema. Same `supabaseUpsertComposite()` + `conflictCols` pattern `sync.js` already built for `appfolio_property_budgets`.

**Query-time rollup, not a second write path:** "Actual spend this year" for a property/category = `SUM(net_amount)` across all `appfolio_property_actuals` rows for that property + `gl_account_id` + `fiscal_year`; "reimbursed this year" = `SUM(reimbursable_amount)` over the same rows. Both get computed live in the `/budget` route, the same way the ticket-cost rollup is already computed live today (`router.js` lines 504–527) — not written back into `appfolio_property_budgets.actual_amount`, keeping one clear source per number instead of two things that could drift out of sync.

---

## Decision 3 — What Counts as "Spend": Decided by Peter — Count Everything, Split Out the Reimbursed Portion

**Peter's decision:** leave tenant reimbursements/billbacks counted in "actual spend" — don't exclude them — but show, separately, how much of a category's spend was offset by a tenant reimbursement, so staff can see both numbers rather than one flat total. This resolves what was an open item in the original draft of this spec.

**What this means concretely, using Finding E's `party_type` signal:**
- `net_amount` (the "actual spend" figure the Budget tab's "Actual (AppFolio)" column shows) = every debit minus every credit, for all transactions on that property + category + month, exactly as originally designed — no filtering. Tenant billbacks still net against it, same as before Peter's decision; nothing about the headline number changes.
- `reimbursable_amount`, new and additive alongside it, is the piece of that total attributable to a tenant: `sum(credit)` restricted to rows where `party_type == 'Occupancy'` (a tenant, per Finding E), for that same property + category + month. This is what lets staff see "$18,400 spent, $1,240 of that reimbursed by tenants" instead of just the net \$17,160-equivalent figure.
- Finding E's nuance matters here directly: the 9 *debit*-side `Occupancy` rows (hotel/relocation costs paid **to** a tenant) are not reimbursements — a tenant didn't give money back, Rincon paid money out to one. Those stay inside `net_amount` as ordinary spend and are correctly excluded from `reimbursable_amount`, which only counts credit-side tenant-sourced dollars.

**Why `party_type`, not name-matching:** the coordinator's framing was "the presence of a tenant's real name on a transaction line" — and that's the right instinct, but implementing it by pattern-matching `party_name` text (guessing whether a string "looks like a person") would be fragile and exactly the kind of guessing this codebase avoids elsewhere. AppFolio already exposes the same signal as a clean, small, structured field (`party_type ∈ {Occupancy, Owner, Vendor, Management Company, null}`), confirmed live against all 4,423 rows in today's pull — same distinction the coordinator asked for, implemented on a real enum instead of free text.

**Other things confirmed live, still worth knowing:**
- Zero "JE" (journal entry / correction) rows and zero negative amounts showed up on expense accounts in the ~17 days I could see — not proof these never happen over a full year, just not observed yet.
- No field on this report says "posted" vs. "pending." AppFolio's own general ledger report being posted-only is reasonable to assume (a GL, by accounting convention, is the posted book) but not something I found an explicit flag to confirm.

Both of those remain minor, genuinely open watch-items (carried into "Open Items" below) — but they're no longer blocking, since Peter's decision above answers the one judgment call that actually needed his sign-off before Neo/Q could build the summing logic.

---

## Decision 4 — Sync Cadence: Same Nightly `sync.js` Run

Rides the existing nightly job as one more `REPORT_CONFIG` entry — not a new schedule. Reasons:
- Matches Part 2's own precedent and reasoning exactly (budgets ride the nightly job; this is the same call).
- Finding C means there's nothing to gain from syncing more often than nightly anyway — AppFolio's own report only ever shows "the current month," not live-updating intraday figures, so checking it every hour wouldn't produce fresher information, just more API calls against the same window.
- One firm requirement worth stating plainly (not just "nice to have"): **the nightly sync must actually run at least once during the last day of every month**, or that month's final total is lost for good once AppFolio's window rolls to the next month — there's no way to recover a missed month after the fact through this report. This is already satisfied by "runs every night," but it's a harder requirement here than it was for the budget report (which barely changes, so a missed night there is a non-event) — worth flagging to whoever (Scotty) monitors the cron job's reliability.

## Decision 5 — Governance: Still No Asimov/Mason, Conditional on the Design Above Being Followed as Specified

Checked against the actual columns designed above, not assumed to inherit Part 2's answer automatically — per the task's own instruction.

**With the aggregate-only design above (property + GL account + month + two dollar totals, nothing else):** the "no personal data" conclusion from Part 2 still holds. No tenant name, vendor name, party ID, or transaction description is ever written to Supabase — Finding D's tenant-name exposure, and the `party_type`/`party_id` fields Decision 3's reimbursable-split logic reads, live only in the raw AppFolio response, inside the sync process's memory, for the moment it takes to compute two sums, and are discarded before anything is written. No message is sent to anyone. No decision about a tenant or applicant is made or influenced — this is property-level financial reporting, same category as Part 2. **Same conclusion: GOVERNANCE.md Rule 6 Standard tier at most — Peter's approval of this spec satisfies it. No Asimov, no Mason.**

**Re-confirmed explicitly for the reimbursable-split addition, not just carried forward:** adding `reimbursable_amount` does not change this. It is still a plain dollar total with no tenant identifier attached — `party_type` is read only to decide *which bucket* a credit's dollar amount adds to during the in-memory sum (Decision 3), never stored itself, and `party_id`/`party_name` are never read into the aggregation at all, only `party_type` and the amount. A person looking at `reimbursable_amount: 1,240.00` for "751 Warwick Ave, Electricity, August 2026" cannot tell from that number which tenant, or how many tenants, made up that figure — exactly the same non-identifying shape as `net_amount` already had. The conclusion above holds under this addition specifically, not just by inheritance from Part 2.

**This conclusion is conditional, not automatic** — it depends on Q actually implementing the aggregation at sync time exactly as designed (computing `net_amount` from the raw rows and discarding `party_name`/`description`/`txn_id`/everything else, never persisting a raw row to Supabase). If a future change to this feature ever stores raw transaction lines instead — for a drill-down feature, say — Finding D means that WOULD introduce tenant PII into this schema for the first time in this area, and would need to go back through Neo's data-inventory pattern properly (not carry this spec's conclusion forward unchecked) and would be worth a Sentinel look given real tenant names would be entering a new table. Flagging this now so it isn't missed later if someone builds "just add the raw rows too" as a quick follow-on.

---

## Neo's Section — Schema Summary

One new table, `appfolio_property_actuals` (full definition in Decision 2 above). No changes to `appfolio_property_budgets`, `claims`, `maintenance_claims`, or any other existing table. Same "why this doesn't go through claims" reasoning as Part 2 applies unchanged: this is a fetched-and-summed structured fact, not an AI interpretation of messy source material — no `confidence`/`extracted_by`/review-gate machinery needed.

**Data inventory:**
- `pii_fields`: NONE, by construction — see Decision 2/Finding D and Decision 5's re-confirmation for `reimbursable_amount`. This must be verified against the actual `buildRow()` code once built (confirm `party_type`, `party_id`, and `party_name` are read only to route a dollar amount into `net_amount`/`reimbursable_amount` during aggregation, and that no raw-row field beyond the six aggregate columns above ever reaches the Supabase payload), not just assumed from this spec's intent.
- `agents_with_access`: nightly sync process (service-role key); any Hub user with existing Maintenance History access — same as `appfolio_property_budgets`.
- `retention_policy`: indefinite, same as every other synced table — nothing here needs redaction once PII is confirmed absent.
- RLS: enabled, no permissive policies.

## Q's Section — Build

- New `REPORT_CONFIG` entry in `sync.js` for `general_ledger`, following the `annual_budget_forecast` entry's exact pattern (lines 273–353): `buildRow()`/aggregation groups raw rows by `(property_id, period, account_id)` **before** upserting (the raw per-transaction rows themselves are not what gets sent to Supabase — the aggregation has to happen in the sync job, not rely on the database to do it) and computes two running sums per group: `net_amount += (debit - credit)` for every row, and `reimbursable_amount += credit` only when `row.party_type === 'Occupancy'` and a credit is present (Decision 3). Strips the `"NNNN - "` prefix from `account_name` for the stored `gl_account_name`. Uses `requiredField`/`conflictCols` the same way the existing entry does. `party_type` is read to route each row's amount into the right sum; `party_id`/`party_name` are never read into the aggregation at all — only the amount and `party_type` matter.
- Extend `GET /api/maintenance-history/property/:property_id/budget` (router.js) to also query `appfolio_property_actuals`, sum `net_amount` **and** `reimbursable_amount` grouped by `gl_account_id`/`gl_account_name` for the requested fiscal year(s), and return both as a new, clearly-labeled `actual_spend_by_year` object (e.g. `{ category, spent, reimbursed }` per row) — same "never merge into one number" discipline the route already applies to the ticket-cost rollup. `reimbursed` is a breakout of `spent`, not an addition to it — the UI must not add the two together.
- Dashboard (`dashboard/index.html`, line 488): render the real value in the existing "Actual (AppFolio)" column instead of "not available from AppFolio" when present, plus a small secondary line/tooltip showing the reimbursed portion when `reimbursed > 0` (e.g. "$18,400 spent — $1,240 reimbursed by tenants"). Add the plain-language note described in "What You'll See" above — this reflects tracked-since-launch data, not automatically the full fiscal year — so the number isn't misread as more complete than it is while it's still building up.
- No new environment variable — reuses the existing AppFolio credential.

---

## Open Items — Needs Confirming or Deciding Before/During Build

1. **Whether AppFolio's general-ledger window resets exactly on the calendar month, or on some other rule** — confirmed only from a single snapshot today (Aug 1–17 returned, matching month-to-date, but not proven across an actual month boundary). Q should either re-check right around a month-end, or this can be asked of AppFolio support directly — same "don't guess, check" standard already applied to the sync's other date-window quirks.
2. ~~What counts as "spend"~~ — **Decided** (Decision 3): count everything in `net_amount`, split out tenant-sourced credits into `reimbursable_amount` using `party_type == 'Occupancy'`. No longer open.
3. **Confirm no pagination/truncation kicks in on `general_ledger` near month-end**, when a full month's transactions (likely several times today's 17-day sample) get requested in one call. No `next_page_url` or pagination was observed today, but today's sample is a partial month.
4. **Backfill is not possible.** Whatever date this ships, "actual spend" starts accumulating from that date forward — there is no way to pull earlier-2026 transactions through this report after the fact. Worth Peter knowing this plainly before this ships, not discovering it later when a property's "actual" number looks suspiciously low.

## Size Estimate

Similar shape to Part 2. **Neo — well under 1 session** (one new table, same pattern as the existing one). **Q — 1-2 sessions** (one new `REPORT_CONFIG` entry with real aggregation logic — more involved than Part 2's straight sync because of the sum-and-normalize step — plus a small route/UI extension to an existing screen, not a new one). **TARS/Judge** — normal pass; TARS should specifically verify the aggregation math against a hand-checked example property/category once real data is flowing, and confirm no raw transaction fields leak into the new table's actual columns. No Asimov/Mason step, per Decision 5 above.
