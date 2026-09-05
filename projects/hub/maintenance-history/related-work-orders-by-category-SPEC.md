# Related Work Orders by Category — Warranty & Vendor-Callback Detection

**Status:** Draft — scoped and live-researched 2026-09-04, ready for Peter's go-ahead to build. Not yet reviewed by Asimov/Mason — see "Governance Assessment" below for Oracle's own recommendation on whether that's needed.
**Written by:** Oracle
**Date:** 2026-09-04
**Origin:** Peter, in his own words: *"when a open work order is shown or created can we set up some sort of flag that would show the viewer all the past work orders in that particular category. for example if an hvac work order comes in it would be really helpful if it showed all the hvac issues within the last 5 years and clearly outlined them out to provide better context to the current work order. this would help us catch warranty items or vendor call back issues as an example. along with a warning or popup that says please review the associated work orders to see if this is related."* He also said, twice, that he does not want a scary or obtrusive popup — earlier decisions this same session already leaned toward calm, in-context sections over blocking modals.

**Built from:** live reads of `maintenance-history/lib/component-categories.js` (full file), `maintenance-history/router.js` (`safeTicketTitle`, `categorizeMaintenanceVendor`/`VENDOR_CATEGORY_RULES`, the `/open-tickets` and `/snapshot` routes, `getMaintenanceHistoryPropertySummary`), `supabase/migrations/20260903000000_maintenance_snapshot_events.sql` (full file), and `property-360/dashboard/index.html`'s existing Open Tickets / Snapshot subsection rendering and lazy-load wiring — plus **three live queries against the real database** (not assumed): a 1,000-row recent sample and the full 11,191-row `maintenance_snapshot_events_decision_safe` table, run through both existing categorizers; a full scan of `maintenance_requests` (568 rows) to check its real status/date distribution; and a targeted sample-check of specific vendor-category-to-component-bucket mappings against real summaries. Findings from all three are cited by number throughout, not estimated.

---

## What This Is

When Peter opens an open work order on Property 360 (the already-built "Open tickets" list under the Maintenance section), each ticket that matches a real repair category (HVAC, plumbing, electrical, etc.) gets a calm, in-context note showing how many times that same category of issue has come up at that property in the last 5 years, with an expandable list of those past items — so Peter can catch a warranty callback or a repeat vendor issue before dispatching someone, without anything popping up or interrupting him.

**Not** a new page, a new table, a new AI call, or a new content-safety mechanism. It's a cross-reference layer over two data sources that already exist and are already safety-checked.

---

## What Already Exists — Read First

Two separate categorization systems are already in this codebase, built for different purposes, and reconciling them is the real design problem this spec solves:

1. **`componentCategories.categorize(text)`** (`lib/component-categories.js`) — categorizes a ticket by its **own title+description text**, keyword-matched into one or more of 10 fixed buckets (`electrical`, `plumbing`, `hvac_moisture`, `appliances`, `structural_exterior`, `landscaping`, `turnover_cleaning`, `pest_control`, `locks_security`, `other`). A ticket can land in more than one bucket by design (its own header comment gives a real example: kitchen/moisture + dryer/venting + crawl space + A/C, one ticket, four systems). Already used by `/overview`'s "By System" section and the "Currently Open" list.

2. **`categorizeMaintenanceVendor(vendorName)`** (`router.js` ~line 1013) — categorizes by the **vendor's name**, not ticket text, into a different 15-category-plus-two-catchalls list (`Restoration & Water Damage`, `Pest Control`, `Locksmith`, `Roofing`, `Plumbing`, `Electrical`, `HVAC`, `Painting`, `Flooring`, `Cleaning`, `Landscaping & Tree Service`, `Doors, Windows & Glass`, `Appliance Repair`, `Fireplace & Chimney`, `Fencing`, plus `Other / Handyman` and the special-cased `Maintenance Coordination Fee`). Built tonight for the Property 360 repair-type pie chart, which sums dollars by trade from `maintenance_snapshot_events`.

Both function on real, different inputs for real, different reasons — `maintenance_snapshot_events` rows come from AppFolio billing records (vendor + amount + one terse summary line, no rich narrative), so `componentCategories` (built and tuned against full Latchel ticket text) can't simply be pointed at them and trusted without checking. That check is done below, empirically, not assumed.

**Content safety is out of scope here and already handled upstream.** Every title/summary this feature displays has already passed the two-layer Fair Housing content check before it reached these tables — `safeTicketTitle()` for `maintenance_requests` titles, the backfill's own check for `maintenance_snapshot_events` summaries (enforced by that table's own `flagged_protected_class`/`review_status` columns and the `maintenance_snapshot_events_decision_safe` view, which structurally excludes flagged/rejected rows). This feature only ever reads `safeTicketTitle()`'s output and the `_decision_safe` view — it must never call `scanText()` itself, read raw `maintenance_requests.description` for display, or read the raw `maintenance_snapshot_events` table. No new content-check logic is proposed or needed.

---

## Design Question 1 — Categorizing the New/Viewed Ticket

**Use `componentCategories.categorize(`${title} ${description}`)`, exactly as `/overview` already does it (`router.js:792`). No change needed.**

This is already the right, existing tool for this job — it's tuned against real Latchel ticket text (validated against 542 real tickets, per its own header), and reusing it here means a ticket's category assignment is identical everywhere it's shown on this page, not a second, potentially-drifting copy.

**One real, concrete implementation gap to close:** the `/open-tickets` route's own `maintenance_requests` select (`router.js:1396`) only pulls `id, title, status, cost, completed_at, created_at` — **no `description`**. `componentCategories.categorize()` needs both fields to work as designed (title-only categorization is measurably weaker — most of the real category signal in a ticket's text lives in the description, not the title). This also means `safeTicketTitle()` is *currently* only ever scanning title text on this route, not title+description as its own code assumes (`ticket.description` is `undefined` there today) — a small, pre-existing gap that adding `description` to this select closes as a side effect, not a separate fix this spec is asking for.

---

## Design Question 2 — Matching Across Two Taxonomies (the central problem)

Task brief laid out three options to actually evaluate against real data. Here's what the data shows.

### Option (a): run `componentCategories.categorize()` on `maintenance_snapshot_events.summary` text directly — REJECTED as the primary signal

Ran it against the full, real, decision-safe dataset (11,191 rows) and a closer 1,000-row recent sample. Headline number looked survivable at first glance (81.7% of the 1,000-row sample landed in a real bucket, not `other`) — but that number hides a real, specific failure mode once you look at *which* rows fall through.

**Live example, `Clark & Sons Aire Inc` (a real HVAC vendor, confirmed by name):** of 12 of its real snapshot rows sampled, `componentCategories.categorize()` on the summary text alone correctly caught only 5/12 (42%) as `hvac_moisture`. The other 7 — "Performed a mini-split maintenance," "The evaporator coil was installed backwards," "Installed a hard-start kit to the outdoor unit," "The system is low on refrigerant," "System Maintenance" — all landed in `other`, because the terse, professional AppFolio bill summary uses real HVAC trade vocabulary (mini-split, evaporator coil, hard-start kit, refrigerant) that simply isn't in `component-categories.js`'s HVAC term list (`hvac`, `air condition`, `ac`, `heater`, `furnace`, `thermostat`, `venting`, `ductwork`, `duct`, `mold`, `mildew`, `water damage`, `humidity`, `crawl space`, `condensation`, `dehumidifier`, `moisture`). This isn't a fluke of one vendor — it's structural: AppFolio bill summaries describe *what was done*, in trade shorthand, not *what system it was* in the plainer language a tenant's own complaint uses (which is what `component-categories.js` was tuned against). Text-only matching on this data source would silently miss more than half of a real HVAC vendor's own work.

### Option (b): map `categorizeMaintenanceVendor`'s category onto `componentCategories`' buckets, and match snapshot events via the vendor-based category instead

Checked coverage on the full 11,191-row table:

| Vendor category | Row count | Maps to a `componentCategories` bucket? |
|---|---:|---|
| `Maintenance Coordination Fee` | 5,113 (45.7%) | **No — excluded, not a trade** (Rincon's own markup line riding on another vendor's real line item for the same job; matching it to any trade would be actively wrong, not just imprecise) |
| `Handyman, Turnover & Preventative Maint.` | 2,084 | No — too broad to assert one system |
| `Other / Handyman` | 749 | No — vendor name doesn't self-report a trade |
| `Fireplace & Chimney` | 33 | No — no real analog in the 10-bucket list |
| Everything else (Plumbing, Electrical, HVAC, Cleaning, Locksmith, Restoration & Water Damage, Doors/Windows/Glass, Appliance Repair, Roofing, Flooring, Landscaping & Tree Service, Painting, Fencing) | 3,212 | **Yes** |

That's only 28.7% of all rows directly mapped by vendor alone — lower coverage than option (a)'s raw number, but for a real reason: nearly half the table is Rincon's own coordination-fee line, which was never going to carry a trade signal from either method (it's a fee, not a description of work — the real, describable work is in the *other* row for the same job).

Spot-checked the mapping itself against real summaries, not just assumed it: `Restoration & Water Damage → hvac_moisture` (chosen because that bucket's own term list already includes "mold," "mildew," "water damage") checks out against real rows — "PuroClean inspected the area under kitchen sink for water and mold damage," "Ceiling had collapsed... Water migrated down the walls." `Roofing → structural_exterior` checks out — "Remove old sealant on all vent pipes and roof penetrations," "Cleaning - clear drain" (gutters). The rest of the mapping (Plumbing→plumbing, Electrical→electrical, HVAC→hvac_moisture, Painting/Flooring/Roofing/Fencing/Doors,Windows&Glass→structural_exterior, Cleaning→turnover_cleaning, Pest Control→pest_control, Locksmith→locks_security, Landscaping & Tree Service→landscaping, Appliance Repair→appliances) is definitional, not inferred — each vendor-category name already appears as a literal keyword in its target bucket's own term list.

### Recommendation: (c), a real combination — vendor-category as the primary signal, text as a fallback only where the vendor gives no signal

1. **Primary: map the vendor's category to a `componentCategories` bucket** (table above) whenever the vendor name resolves to a real trade. This is the *more reliable* signal for this specific, terse data source — proven directly by the HVAC example above (vendor-based catches all 12/12 of a known HVAC vendor's rows correctly; text-based catches 5/12).
2. **`Maintenance Coordination Fee` rows (5,113 of 11,191 — 45.7% of the whole table) are excluded from category matching entirely, on purpose, before the fallback ever runs on them.** Per this table's own migration comment, these are Rincon's own markup lines riding on another vendor's real line item for the *same* job — the real, describable work is already captured by that other row for the same job. Categorizing the fee line too would double-count the same incident under whatever generic phrase the fee row happens to use, or worse, mis-tag it.
3. **Fallback: for the remaining generic-vendor rows** (`Other / Handyman`, `Handyman, Turnover & Preventative Maint.`, `Fireplace & Chimney` — 2,866 rows, 25.6% of the table, deliberately *not* including the fee rows excluded above), run `componentCategories.categorize()` on the summary text as a second-chance signal. Checked this empirically, scoped to exactly this set: **2,203 of 2,866 (76.9%) recover a real bucket**, 663 remain genuinely signal-less. Real recovered examples: "Move out cleaning" → `turnover_cleaning`, "Irrigation water leak" → `plumbing`+`landscaping`, "Tile repair & color" → `structural_exterior`.
4. **Net real coverage, honestly stated:** of all 11,191 real snapshot rows, **5,415 (48.4%) end up with a usable category** (3,212 direct vendor match + 2,203 recovered by text fallback); **5,776 (51.6%) get none** — but that number is dominated by the 5,113 deliberately-excluded fee rows (45.7% of the whole table), not by matching failures. Restricted to rows that were ever eligible to get a category in the first place (excluding fee lines), real coverage is 5,415 of 6,078 — 89.1%. Either way, uncategorized rows are silently excluded from matching, never mis-assigned to the wrong bucket. That's the right failure direction for this feature: an undercount (a missed callback) is a real but bounded cost; a false category match (telling Peter two unrelated repairs are "the same issue") actively undermines the trust this feature needs to be useful.

### The `maintenance_requests` side — a real, live finding that changes the practical design

Checked `maintenance_requests`' actual status and date distribution before assuming this table is a rich "recent + historical" source: **all 568 rows today carry status `assigned` (538) or `open` (30) — zero rows have ever been marked `completed` or `closed`**, and `created_at` spans only 2026-07-20 to 2026-09-03 (a few weeks, not years). `/overview`'s own code independently confirms why: it needs a *second*, claims-informed layer (`resolved = hasClaims ? (statusResolved && maxOutcomeLevel >= 3) : statusResolved`, `router.js:789`) precisely because the plain `status` field alone can't be trusted to signal real resolution.

**Practical consequence:** today, essentially all of this feature's real 5-year historical signal comes from `maintenance_snapshot_events`, not from other `maintenance_requests` rows — there is currently no genuinely "closed" ticket history to cross-reference. This will change as the Latchel sync matures, so the design below still queries both sources, but Peter should know the `maintenance_requests` side is thin today, not a bug in this feature.

**Resulting design decision:** don't try to reuse `/overview`'s claims-informed resolved logic here (that would mean reading `maintenance_claims` content, which `getMaintenanceHistoryPropertySummary` and `/open-tickets` both deliberately avoid, by design, to keep flagged content out of this part of the page by construction — see that route's own comment, `router.js:1056-1064`). Instead: **every other `maintenance_requests` row at the property that shares a matched category is shown as "related," regardless of its own status** — labeled with its real status (`assigned`, `open`, or eventually `completed`/`closed`), so Peter can judge for himself whether it reads as historical or as a second concurrent issue. That second case (two open HVAC tickets right now) is itself useful, arguably more useful than an ambiguous status field — "is this the same problem reported twice" is exactly the kind of thing this feature exists to surface. This is a deliberate choice, not an oversight: it keeps the feature simple, AI-free, and claims-free, matching this whole section's own established discipline.

---

## What Gets Displayed, and From Where

Two source-typed shapes, same convention the Privacy Review section already uses to distinguish `claim` vs. `snapshot_event` items (`item_type`) — never merged into one blended "title" field:

**From `maintenance_requests`** (via `safeTicketTitle()`, unmodified):
`{ source: 'ticket', id, title, title_redacted, status, cost, date }` — `date` = `completed_at || created_at`, same fallback used everywhere else on this page. A flagged title still appears in the list (with the existing safe placeholder, "AppFolio record — see ticket for details") — it isn't hidden, only its text is redacted, same as Open Tickets today.

**From `maintenance_snapshot_events_decision_safe`** (already-safe view, unmodified):
`{ source: 'snapshot_event', id, summary, vendor_name, amount, date }` — `date` = `event_date`. A flagged or rejected row never appears at all here — the `_decision_safe` view structurally excludes it before this feature ever sees it, so (unlike the ticket side) there's no placeholder to show; it's silently absent, same as the pie chart and vendor-spend figures already inherit from this same view.

**No dedup between the two sources.** The migration's own comment already accepts this: "Both tables can end up describing the same real-world repair from two different angles... that overlap is accepted, not deduped here." This feature inherits that same accepted overlap rather than inventing new matching logic to solve it — a real repair could legitimately appear once from each source, and that's fine; better a harmless duplicate line than a matching heuristic that's wrong in the other direction.

**Merged sort:** both sources combined into one list per matched category, most-recent-first by `date`, capped (see below) — same sort convention `/open-tickets` and `/snapshot` already use independently.

---

## Where and How This Surfaces in the UI

Peter asked for a "warning or popup" but explicitly does not want a disruptive one. Reusing the existing pattern, not inventing a new one:

**Extend the already-built, already-lazy `GET /api/maintenance-history/property/:property_id/open-tickets` route** (no new route). It already fetches every open ticket for the property in one call, on first expand of the Open Tickets subsection — cheap to also fetch this property's full `maintenance_snapshot_events_decision_safe` rows in that same request (one more indexed, per-property query, no AI, no per-ticket round trip) and compute each open ticket's related-item matches server-side, in memory, once.

Response shape becomes, per ticket: `related_work_orders: { count, items: [...] }` (present only when `count > 0` — omitted otherwise, matching this whole page's "don't show an empty section" convention already used for `flagged_review_count`, tool cards with no data, etc.). `items` is capped (see below); `count` is the real, uncapped total, so a truncated list can still say "and 4 more."

**UI change needed (Tron's scope, not this spec's code):** the Open Tickets list currently renders as a flat `<table>` (`renderOpenTicketsList`, `dashboard/index.html:1241`). A `<details>` note can't nest cleanly inside a `<td>`, so this becomes a list of ticket rows (same fields — title, status, cost, date) instead of a table, each optionally followed by a small highlighted note when `related_work_orders.count > 0`:

> **3 past HVAC issues in the last 5 years — worth checking before dispatching a vendor** ▸

...expandable in place to the capped list, using the *exact same* nested `.subsection`/`<details>`/`<summary>` pattern and the *exact same* blue "info" styling already defined for `.ov-open-tickets summary` (`#eff6ff` background, `#bfdbfe` border, `#1d4ed8` text — `dashboard/index.html:156-160`) — deliberately not a new red/orange "warning" color. That reuse is the actual answer to "not scary": same calm visual language this page already uses for "here's more if you want it," not a new alarm-shaped component. No modal, no dismiss button, no acknowledgment gate (that heavier pattern is reserved elsewhere on this page for actual content-review workflow actions — nothing here is a decision to acknowledge, it's a fact to notice).

**If a ticket matches more than one category** (real, documented case — e.g. a "water heater leaking" ticket lands in both `plumbing` and `hvac_moisture` by design, see below), show one note per matched category, each with its own count and its own expand — never blended into one mixed list, so "3 past HVAC issues" and "2 past Plumbing issues" both stay honest about what they actually found.

---

## Thresholds and Edge Cases

**"Same category" = shares at least one matched bucket key.** No separate adjacency/related-category logic is needed — `componentCategories.categorize()` already multi-tags ambiguous tickets into every bucket that applies, by design, and this already covers the adjacency concern raised in the task brief. Verified live: `categorize("water heater leaking")` → `['plumbing', 'hvac_moisture']`; `categorize("tankless water heater not igniting")` → `['plumbing', 'hvac_moisture']`. A water-heater ticket is already found by a plumbing-categorized OR an hvac_moisture-categorized past item, automatically.

**A real, live-verified gap, not fixed by this spec:** `categorize("no hot water in unit")` → `['other']` — zero signal, not "wrong bucket," genuinely no match at all, because neither "hot water" nor "heater" nor "water heater" appears as a matchable phrase for that exact wording. A ticket phrased this common way gets no related-history note under this design, silently, the same way it gets no "By System" card on `/overview` today. This is a pre-existing gap in `component-categories.js`'s term list (not the protected-class content-check dictionary — a completely separate file, out of tonight's separate content-check thread) and this spec deliberately does not touch it, per the task brief's own scope. Worth knowing, and a cheap, obvious, separately-approvable follow-up later would be adding "hot water" to the `plumbing`/`hvac_moisture` term lists — not part of this build.

**`other`-only tickets get no related-history feature at all.** If a new/viewed ticket's only matched category is `other`, no note is shown, on either count-0 logic (nothing coherent to search for) or on principle (`other` is a residual catch-all with no real trade meaning — matching on it would produce noisy, unhelpful groupings, not a real pattern).

**No history = no note.** Matches this page's own established convention throughout (omitted fields, not zeroed; absent cards, not "no access" cards) — confirmed by count, not by a separate empty-state string.

**Cap: 10 items shown per category, most-recent-first, with a plain "+N more in the last 5 years" line when truncated** (no second page, no pagination control — matches `property-search.js`'s own existing "same 10-result cap" convention rather than inventing a new limit). Grounded in real data, not picked arbitrarily: across every real (property, category) pair in the full dataset, the distribution is p50 = 3, p75 = 6, p90 = 12, p95 = 17, p99 = 31, worst real case = 95 (one property's `structural_exterior` bucket, which absorbs painting/flooring/roofing/fencing/doors/windows — the broadest bucket by construction). A cap of 10 shows the true full list for roughly 90% of real cases and still gives an honest, truthful count for the rest.

**No minimum count to show the note.** Even a single past occurrence (count = 1) is exactly the kind of "did we already fix this once" signal Peter asked for — no artificial "needs 2+ to count as a pattern" threshold.

---

## Governance Assessment — Oracle's Own Read

Peter's own framing in the task brief: this is lower-risk than tonight's "known owner/tenant issues" feature, closer in shape to the already-shipped Open Tickets list and repair-type pie chart. **I agree, and recommend this specific build does not need a fresh Asimov/Mason pass before shipping** — final call is Peter's, not mine, per the task brief, but here's the honest reasoning:

- **It sends no message** to a tenant, owner, or anyone else.
- **It makes or influences no decision about a person** — it characterizes repair *categories* at a *property*, never a tenant or applicant. Nothing here is Fair Housing-adjacent in the way LeadSimple's tenant/owner-linked process data or the flagged-content review queue are.
- **It collects and stores nothing new.** No new table, no new column that captures anything not already captured. It's a read-and-cross-reference layer over two already-existing, already-reviewed, already-safety-gated data flows.
- **It reuses existing content-safety machinery unmodified** — `safeTicketTitle()` and `maintenance_snapshot_events_decision_safe` are called exactly as built, not extended or altered. This spec adds no new call to `scanText()`, no new flagged-content code path, and doesn't touch `protected-class-terms.js`.
- **Access stays exactly where it already is** — gated by the same `requireMaintenanceHistoryAccess` the `/open-tickets` route already uses; no new role, no new visibility for anyone who couldn't already see this same underlying data by opening Open Tickets and the Snapshot section separately today. This feature only changes *how conveniently* already-visible data is cross-referenced, not *who* can see it.

One thing worth naming honestly rather than dismissing outright: grouping and framing many already-safe summaries together under a "worth checking" prompt is a small step beyond a flat list, and someone could ask whether aggregation itself creates a new kind of inference risk. Considered and rejected as a real concern here — every field shown was already independently safe and independently visible on this same page (Open Tickets, the Snapshot section); this feature changes the *arrangement*, not the *content*, and arrangement by property + repair category carries no Fair Housing dimension the way arrangement by tenant or protected-class characteristic would.

---

## What This Spec Does Not Do

- Does not write the matching/display code — that's Q's job, from this spec.
- Does not touch `lib/protected-class-terms.js`, `lib/content-check.js`, or any content-check logic — that's a separate, in-progress thread tonight (the flagged-review grouping/exclusions work), not conflated with this one.
- Does not modify `component-categories.js`'s term list, even though a real gap was found (the "no hot water" case above) — flagged as a known limitation and an optional, separately-approvable future follow-up, not part of this build.
- Does not add a new table, a new migration, or a new `team_member_tool_roles` value — this is pure application-layer cross-referencing over existing data.
- Does not write to `audit_log` — this is a read-only display feature; nothing here is a decision or a reviewable action the way a Confirm/Correct/Reject review action is.
- Does not attempt to reconcile or dedup `maintenance_requests` and `maintenance_snapshot_events` when they describe the same real repair — inherits the migration's own already-accepted overlap.
- Does not build a ticket-creation flow. Peter's own phrase "when a work order is shown or created" is read here as "shown" only — this Hub has no ticket-creation UI (tickets arrive via the nightly Latchel sync, same as today); a newly-synced ticket gets this same treatment automatically the next time it appears in Open Tickets, with nothing new to build for the "created" half of that sentence.

---

## Open Items — Needs Peter's Confirmation Before Q Builds

1. **The 10-item cap** — reasonable given the real percentile data above, but confirm the number itself; a smaller cap (5) would still cover p75 of real cases and read as tighter/calmer.
2. **Including concurrent still-open `maintenance_requests` tickets in the same category as "related"** (not just genuinely resolved history) — recommended above with real reasoning (status can't reliably distinguish resolved from open today; a second live issue is itself useful signal), but confirm this reads right rather than confusingly blending "past" and "also happening right now" in one list.
3. **The "no hot water" taxonomy gap** — not part of this build; confirm whether it's worth a tiny, separate follow-up to `component-categories.js`'s term list later, or leave it (real but low-frequency, and out of tonight's stated scope either way).
4. **Whether this needs Asimov/Mason review** — Oracle's recommendation above is no, but that's Peter's call to make, not skip by default.
