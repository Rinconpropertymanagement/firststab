# AppFolio Maintenance & Property Notes — Feasibility Research

**Status:** Research only, for Peter's decision. Nothing has been built, no schema changed, no production file touched. This answers "is this data even reachable" — it does not authorize a build.
**Written by:** Oracle (research/feasibility)
**Date:** 2026-09-06
**Question asked:** Peter wants to research pulling two kinds of AppFolio notes into Property 360, possibly in different spots on the page: (1) notes/comments logged in AppFolio's own maintenance/work-order module, and (2) a separate, general notes section on the property page. Both are **AppFolio-native** data — not Latchel (the separate field-service vendor system Maintenance History already reads from) and not the new, still-draft, staff-authored Owner & Tenant Operational Notes system.

**Everything below marked "confirmed live" was checked tonight against Rincon's real, production AppFolio account**, reusing the exact auth pattern and credentials `projects/appfolio-sync/sync.js` already uses in production (`APPFOLIO_CLIENT_ID`/`APPFOLIO_CLIENT_SECRET`, Basic auth, `POST /api/v2/reports/{name}.json`) — not guessed from AppFolio's public docs and not assumed from the existing attachments finding. Every call made was read-only (`GET`/report `POST` with an empty `{}` body, identical to how the nightly sync already queries this account) — nothing was created, changed, or deleted in AppFolio. The probe script is a temporary, throwaway file in this session's scratchpad, never added to this repo.

**Built from, read in full:**
- `/Users/petermckenzie/.claude/projects/-Users-petermckenzie-CODE-firststab/memory/project_appfolio_attachments.md` — the existing memory finding that AppFolio's API exposes **zero** document/attachment access on either property or tenant records, confirmed live 2026-08-17, contradicting the AppFolio rep's own answer. That finding is about *files*, not *notes* — this document does not assume the same answer applies to text fields; it re-tests notes empirically, the same way that finding tested attachments empirically.
- `projects/appfolio-sync/sync.js` (full file) and `projects/appfolio-sync/api-capabilities-notes.md` — the real, live, nightly AppFolio → Supabase connection, its `REPORT_CONFIG` entries, and the documented capability gaps.
- `projects/hub/property-360/router.js` and `projects/hub/property-360/dashboard/index.html` — the real current card layout, the Maintenance section's Open Tickets/pie-chart/Privacy-Review subsections, and the new (draft) Owner & Tenant Operational Notes card.
- `projects/hub/property-360/owner-tenant-operational-notes-SPEC.md` — the draft, not-yet-built, counsel-reviewed system for staff-authored/AI-proposed factual notes about owners, tenants, and properties. Read in full to avoid recommending something that duplicates or gets confused with it.
- `projects/hub/maintenance-history/` (`SPEC.md`, `latchel-sync-frequency-feasibility.md`, `router.js`) — the existing Latchel-based Maintenance History feature already live on Property 360, and its own confirmed finding that Latchel's API has **no** notes/activity endpoint at all (the short staff decision-notes visible in Latchel's UI, e.g. "Correct SP," are unreachable via any documented Latchel endpoint).
- `supabase/migrations/20260828000000_add_year_built_and_maintenance_limit_to_properties.sql` and `projects/hub/approval-briefing-SPEC.md` (Section 4.2) — prior, independent confirmation that `property_directory`'s response object also carries a `maintenance_notes` field, never previously investigated for content.

---

## 1. The headline finding

**This is genuinely different from the attachments story — this data exists, and Rincon's API access already reaches it. Nobody has looked at it before now.**

Both AppFolio reports the nightly sync already pulls every night — `property_directory` and `work_order` — carry real, populated free-text fields that `sync.js`'s `buildRow()` functions read past today without mapping anywhere. No new credential, no new endpoint, no new AppFolio permission is needed to reach any of it. The catch is not availability — it's that **none of this content has ever been screened for Fair-Housing-sensitive language**, because nobody has ever looked at it as a data source before (Section 4).

Separately, and just as clearly: **AppFolio's Reports API has no endpoint of any kind for a running log of staff comments or an activity/notes thread** — on either a work order or a property. That specific thing (a chronological "who said what, when" log) does not exist in this API, the same way it doesn't exist in Latchel's API either. What exists instead is a handful of point-in-time descriptive/instructional text fields, which is a real but different thing than "comments logged on a ticket."

## 2. What was tested, and how

Same methodology the existing attachments finding used: try real report names against the live Reports API and read the exact error. `POST /api/v2/reports/{name}.json` returns **HTTP 400 `{"message":["Id is not a valid report."]}`** when a name isn't in this account's fixed report catalog — a clean, unambiguous "does not exist" signal, not a permissions error. Also tried a batch of REST-style single-resource URLs (`/api/v2/work_orders/{id}.json`, `/api/v2/properties/{id}.json`, `/api/v2/properties/{id}/notes.json`, etc.) — every one returned a bare **HTTP 404**, the identical signature the attachments finding already established means "this route doesn't exist on this API at all," not a scoping issue with Peter's key.

**Candidates tried for a maintenance/work-order notes or comments report** — all HTTP 400, none exist: `work_order_notes`, `work_order_note`, `work_order_comment(s)`, `maintenance_note(s)`, `maintenance_comment(s)`, `job_notes`, `job_comment(s)`, `service_request_notes`, `service_request_comments`, `work_order_activity`, `work_order_history`, `work_order_log`, `ticket_notes`, `ticket_comments`.

**Candidates tried for a general property-notes report** — all HTTP 400, none exist: `property_notes`, `property_note`, `notes`, `note`, `general_notes`, `property_comments`, `property_comment`, `property_memo(s)`, `unit_notes`, `property_directory_notes`.

**REST-style single-resource candidates** — all HTTP 404, none exist: `/api/v2/work_orders/17832.json`, `/api/v1/work_orders/17832.json`, `/api/v2/service_requests/17715.json`, `/api/v2/properties/306.json`, `/api/v2/properties/306/notes.json`, `/api/v2/properties/306/maintenance_notes.json`.

This confirms, empirically, that AppFolio's API surface for this account is Reports-API-only (exactly what the attachments finding already established) and that **there is no dedicated "notes" or "activity log" object anywhere in it** — matching, almost field-for-field, what the Maintenance History spec already found true of Latchel's separate API.

## 3. What actually IS there, confirmed live

### 3a. The work-order module — `work_order` report (already synced nightly)

This is the exact report `sync.js`'s `REPORT_CONFIG` entry 9 already calls every night to populate `maintenance_requests`. It returns **only currently-open tickets** — confirmed live: all 132 real rows pulled tonight are `status: "Assigned"` (112) or `"New"` (20), zero have a completion date, spanning `created_at` 2026-06-01 to 2026-09-04. This matches the Maintenance History team's own already-documented finding that this report ignores date filters and always returns AppFolio's whole current list, not a historical range — so any free-text field on this report is only ever visible for as long as the ticket stays open, the same capture window every other field `sync.js` already reads from this report lives under.

Fields on this report that carry description/instruction-like text: `service_request_description`, `job_description` (both already partially mapped, into `maintenance_requests.description`), plus two that are **not currently mapped anywhere**:

- **`instructions`** — real, substantive content. Confirmed live: differs from `job_description` on 108 of 132 real open tickets (82%). Sometimes a near-duplicate trim of the description; sometimes genuinely additional detail AppFolio's own intake flow captured — e.g. one real ticket's `instructions` carried a full "Troubleshooting Summary" paragraph (spiders/black widows, exterior inspected, webs cleared, still present) that `job_description` didn't have at all; another carried a vendor's direct contact name and phone number that `job_description` didn't. This is the closest thing AppFolio's API has to "notes on a maintenance ticket."
- **`status_notes`** — a real field in the schema, but **empty on all 132 currently-open tickets checked tonight (0/132)**. Not proven to never be populated (this only samples today's open tickets, not history), but confirmed unpopulated on every real ticket looked at.

**What this is not:** a chronological comment thread. There is no equivalent here of Latchel's own internal activity-timeline notes ("I want this redone," "Correct SP") that the Maintenance History spec already found permanently unreachable via any API. If "notes/comments logged in the maintenance section" means a running log of staff back-and-forth on a ticket, **that specific thing does not exist in AppFolio's API either** — same permanent gap, independently confirmed on a second system. If it means the ticket's own descriptive/instructional text, that part is real and reachable.

### 3b. The property page — `property_directory` report (already synced nightly)

This is the exact report `REPORT_CONFIG` entry 1 already calls every night to populate `properties`. It carries **three distinct free-text fields**, none currently mapped by `buildRow()` (which today maps only name/address/city/state/zip/unit_count/appfolio_id/jurisdiction_county/year_built/maintenance_limit):

| Field | Populated (of 379 properties) | What it actually contains, confirmed live |
|---|---|---|
| `maintenance_notes` | **194 / 379 (51%)** | The main candidate. Real, substantive, staff-facing operational notes — real examples pulled tonight: *"Call Zack for approval for any work order. **Only Zack can approve maintenance"*, *"OWNER HAS THEIR OWN HANDYMAN, OKAY TO CONNECT HIM WITH TENANTS\nEzequiel 805-212-6184"*, *"NO VCF \n500 limit\n1000 reserve\n\nCONTACT DARLYNE FIRST. she has a home warranty..."*, *"Please contact the owner for all maintenance."* This sits alongside `maintenance_limit` in the same response object — `approval-briefing-SPEC.md` already noted its existence in passing (2026-08-27) but never looked at its content until tonight. |
| `description` | 8 / 379 (2%) | Sparse, and mostly about leasing/occupancy status, not maintenance — e.g. *"tenant occupied, take over management on 8/20/23"*, *"Lease Listing Only"*, *"Current tenant moving out in early September."* A weaker match for "general property notes" than `maintenance_notes`, both in volume and in subject matter. |
| `online_maintenance_request_instructions` | 12 / 379 (3%) | Tenant-facing — this is what AppFolio shows a tenant *submitting* a maintenance request through the online portal, a different audience than staff. Real examples: *"DO NOT HOOK UP ICE & WATER TO FRIDGE/FREEZER"*, appliance-specific how-tos with a linked video. |

**`maintenance_notes` is almost certainly what AppFolio itself surfaces on the property record's own Maintenance tab in its UI** — the field name, its co-location with `maintenance_limit`, and its content (approval rules, owner maintenance preferences, vendor relationships) all point the same way. This document cannot independently verify the exact on-screen tab/label AppFolio's own UI uses for it — that's a 30-second visual check Peter (or whoever has an AppFolio login) can do directly by opening one of the properties above (e.g. property_id 77, 10182 Abilene St) and confirming which tab shows that exact text.

## 4. Fair Housing / privacy — flagged, not resolved here

This is the part of this research that matters more than the technical reachability question, and it is genuinely open — not a call for Oracle to make.

- **None of this content has ever been through any content check.** `maintenance_claims` (Maintenance History) and the draft `operational_notes` (Owner & Tenant Operational Notes) both exist specifically because free text about a property, owner, or tenant can carry protected-class-adjacent language, and both were built around a two-layer content check + human review queue for exactly that reason. `maintenance_notes`/`instructions`/`description` are the same *category* of risk — staff-typed free text about real people and properties — but they are pre-existing AppFolio data, some of it years old, that nobody has ever screened. The 6 real `maintenance_notes` examples quoted above were operationally benign, but that is a spot-check of 6 out of 194 real populated rows, not a scan — this document does not claim the corpus is clean, and it should not be treated as screened just because none of the examples reviewed here happened to be sensitive.
- **This is a different problem shape than a normal content check.** Every content-check pipeline already built in this codebase screens *new* content as it's created. Pulling `maintenance_notes` into the Hub means screening a *backlog* that already exists — closer to a one-time retroactive scan than an ongoing ingestion filter, though the same two-layer mechanism (`lib/protected-class-terms.js` + a model judgment pass) should be directly reusable for both.
- **This risks becoming a third, disconnected "notes" surface on the same page.** Property 360 is about to gain the Owner & Tenant Operational Notes card (draft spec, counsel-reviewed, tiered access, human-review workflow) — a purpose-built home for exactly this kind of factual operational note about an owner or property. Surfacing AppFolio's `maintenance_notes` as its own, separate, unscreened, unreviewed display risks (a) confusing staff about which "notes" section is the current source of truth, and (b) shipping real owner/property content with none of the tiering or review discipline Asimov and Mason already required for the parallel system. Whether AppFolio's notes should feed *into* `operational_notes` (as a triaged/AI-proposed input) versus stay a separate, clearly-labeled, read-only "from AppFolio" display is a real design fork — flagged here, decided by Peter/Asimov/Mason, not by this document.

## 5. Where this relates to what's already built

- **Not Latchel, not Maintenance History.** The Maintenance card on Property 360 today shows Latchel-derived claims (event/decision/outcome/recurrence) plus an AppFolio general-ledger spend figure. It does not show any of AppFolio's own `work_order.instructions`/`job_description` text today. This research is about a different, currently-unsurfaced AppFolio data source — additive, not a duplicate of what the Maintenance card already shows.
- **Not the Owner & Tenant Operational Notes system.** That system is staff-authored (manually typed or AI-proposed from email), lives in a brand-new `operational_notes` table, and has its own tiered access/review model. AppFolio's `maintenance_notes` is AppFolio's own pre-existing data, authored inside AppFolio by whoever set up or has edited that property record over the years — a different source, a different authorship model, and (today) zero access tiering or review. See Section 4 for why this distinction matters for what gets built.
- **The Latchel notes gap and the AppFolio notes gap are now independently confirmed to be the same shape.** Maintenance History's spec already found Latchel has no notes/activity endpoint. This research finds AppFolio doesn't either. Two unrelated vendor systems, tested the same way, same conclusion: a running comment/activity log is not an API-reachable concept in either system Rincon uses for maintenance today.

## 6. Where this could surface on Property 360, if Peter wants to proceed

Not a design decision — just where each piece would plausibly fit, given the page's existing structure:

- **`work_order.instructions`** is per-ticket, and Property 360's Maintenance section already renders an expandable Open Tickets list (`ticket-row` / `ticket-row-main` in `dashboard/index.html`). The natural fit is an additional line inside each open ticket's row — it's the same kind of thing the existing "Related Work Orders" note already does (a small, calm, expand-in-place addition to a row that already exists), not a new card.
- **`property_directory.maintenance_notes`** is property-level, not ticket-level, and persistent rather than per-event — closer in shape to the owner name/phone/email already shown in the property header, or to a short line at the top of the Maintenance card (above the Open Tickets/spend stats), since it's literally AppFolio's own maintenance-tab field for this property. A new small card in the existing card-grid is also plausible. Which of these is right depends on Section 4's still-open access/review question — a note that hasn't been screened probably shouldn't render as plainly as the owner's phone number does today.
- **`description`/`online_maintenance_request_instructions`** are sparse enough (2% and 3% of properties) that they may not be worth their own UI at all — flagged as a lower-priority "include if convenient" rather than a separate design question.

## 7. What would actually need to be built — rough shape only

Assuming Peter resolves Section 4 first:

- **Neo:** additive, nullable columns — `maintenance_notes` (and optionally `description`) on `properties`; `instructions` on `maintenance_requests` — same shape as the existing `year_built`/`maintenance_limit` migration, nothing structurally new.
- **Q:** a few-line addition to `sync.js`'s existing `property_directory` and `work_order` `buildRow()` functions (the exact `if (row.field) built.field = row.field` omit-when-absent convention already used throughout that file) — no new connector, no new credential, no new AppFolio scope. The actual work is whatever Section 4 requires: either a one-time retroactive content-check pass over the existing backlog (reusing `protected-class-terms.js` + a model judgment pass) before this is shown to anyone, or a decision to route it through `operational_notes` instead of a new display.
- **Tron:** wherever Peter decides in Section 6, once Section 4 is resolved.
- **Asimov/Mason:** a look at Section 4 before any of this reaches a real screen — this is the actual gating step, not the data pull.
- **No new environment variables, no new AppFolio permissions, no new credential.** Everything above is reachable today with the exact `APPFOLIO_CLIENT_ID`/`APPFOLIO_CLIENT_SECRET` already in `.env`.

## 8. Open questions for Peter

1. Please do a quick visual check in AppFolio itself (e.g., property_id 77 / 10182 Abilene St) confirming `maintenance_notes` is the field you're picturing as "the property page's general notes section" — and whether `description`/`online_maintenance_request_instructions` matter to you at all, or `maintenance_notes` alone is what you meant.
2. When you say "notes/comments logged in the maintenance section" — do you mean the ticket's own description/instructions text (real, reachable — Section 3a), or a running log of staff back-and-forth comments on a ticket (not reachable via any AppFolio endpoint tried, the same permanent gap Latchel already has)? Worth confirming before anyone plans a build around the wrong one.
3. How do you want to handle the fact that none of this content has ever been screened for Fair-Housing-sensitive language before it's shown to staff (Section 4)? A one-time retroactive scan, routing it through the new Owner & Tenant Operational Notes system instead of a separate display, or something narrower?
4. Should this become its own new piece of Property 360, or fold into the existing Maintenance card / the in-progress Owner & Tenant Operational Notes card once that ships — avoiding a third, disconnected "notes" surface on one page?
5. Worth knowing going in: both source reports are always-current snapshots with no history. If someone edits or clears a `maintenance_notes` value in AppFolio, Rincon would only ever see today's current value on the next sync — there's no way to see what it said last month, the same limitation every other AppFolio-sourced field in this schema already has.
