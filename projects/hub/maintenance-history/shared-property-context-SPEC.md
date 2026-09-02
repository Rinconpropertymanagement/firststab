# Shared Property Context + Privacy Review Redesign — Build Spec

**Status:** Built. Parts 1 and 2 shipped substantially as scoped below, with one real deviation from the sequence this document originally described: `director_of_operations`'s access (Combined Open Item #1) did **not** ship in the same build as the rest of Part 2 — Asimov held it back for a separate Mason review, so that build shipped with `director_of_operations` deliberately excluded from `PRIVACY_REVIEW_ROLES` and the flagged-queue's front-end. It shipped in a later, follow-up build once Mason's conditional approval was in hand — see `compliance/director-of-operations-privacy-review-access.md` for the full decision trail and the two conditions (a one-time acknowledgment gate, role-aware audit logging) that build implemented alongside it. The rest of this document is left as originally written except where marked below, since it's still an accurate record of what was scoped and why.
**Written by:** Jarvis, from a live scoping conversation with Peter on 2026-09-01.
**Origin:** Peter's own framing, verbatim: "from tickets to property overview to budget to needs review. can we have all that be connected to the same property you are searching for." A second, related complaint followed: the current Needs Privacy Review queue "creates busy work and may not be relevant to what you're looking for" because it's disconnected from property context.

This spec covers two related but separable pieces of work. They can be built together or independently.

---

## Part 1 — Shared Property Context Across Tabs

### The problem today

Maintenance History has four tabs — Tickets, Property Overview, Budget, Needs Privacy Review — and each one has its own independent search/filter state:

- **Tickets** — has a basic client-side filter (`onSearch()`), plus a URL-param entry point (`?property=`) used when landing here from the hub-wide search widget, but nothing connects it live to the other three tabs.
- **Property Overview** — has its own search box (`onOverviewSearch()` / `loadOverview()`), native mode is already "one property at a time."
- **Budget** — has its own separate property search (`onBudgetSearch()` / `loadBudget()`).
- **Needs Privacy Review** — no property concept at all today; shows every flagged item across the entire portfolio (see Part 2).

Searching or picking a property in one tab does nothing for the other three. Peter has to re-search the same address up to three times to look at one property's tickets, overview, and budget in one sitting.

### The fix

Introduce one shared "current property" that persists as the user moves between tabs:

- A single piece of page-level state (e.g. `currentPropertyId` / `currentPropertyLabel`), set whenever a property is picked from *any* of the three property-aware tabs' search boxes, or from a property link elsewhere in the tool (e.g. the clickable property names already in the Tickets list, per SPEC.md's existing "third entry point" pattern).
- When set, switching to Tickets, Property Overview, or Budget auto-loads that same property instead of showing a blank search box or an unfiltered list.
- Each tab's own search box stays — this isn't about removing the ability to search a *different* property from within one tab, just about not losing your place when you're done and want to check the same property somewhere else.
- Picking a *different* property anywhere updates the shared state for all three going forward.

### What doesn't change

- Needs Privacy Review is handled separately in Part 2 below — it currently has no property concept, and per Mason's review, it should keep its portfolio-wide default view rather than become property-scoped by default.
- No backend changes needed for this part — Budget and Property Overview already load by real property id (`loadBudget(propertyId)`, `loadOverview(propertyId)`); this is purely front-end state-sharing (Tron's work), not a new API surface.

### Correction from the first draft, caught on review

Tickets does **not** already support loading by property id. `onSearch()` and the existing `?property=` URL entry point both do **text matching** against title/property name/address/AppFolio id — there's no id-based filter today, even though each ticket row already carries a real `property_id` from the backend. Tron will need to write a small new "filter by id" path for the Tickets tab specifically (the data is already there; the filter function isn't). Small addition, doesn't change the overall size, but it's real new logic, not just wiring.

Also needs reconciling: two existing state variables, `lastOverviewPropertyId` and `cameFromOverview` (used today only for ticket-detail back-navigation from Property Overview), already track a narrower version of "current property." Decide during build whether the new shared `currentPropertyId` replaces these or sits alongside them — don't leave two overlapping trackers of the same thing without an explicit call.

### Size

Small. No schema, no new endpoints for this part alone. Mostly `dashboard/index.html` state management — Tron, roughly half a session.

---

## Part 2 — Needs Privacy Review Redesign

### The problem today

The "Needs Privacy Review" tab shows every protected-class-flagged maintenance claim across the entire portfolio, in one disconnected list with no property context. A reviewer working on a specific property has no way to see "does this property have anything flagged" without leaving what they're doing and searching the whole queue by hand. Peter's read: this creates busy work and often surfaces items unrelated to what he's actually looking at.

### What was considered and rejected

Peter's first proposal: retire the standalone tab entirely, and show flagged items in-context directly on the Property Overview page, visible to **any** user with Maintenance History access (not just the currently-gated roles) — justified on the grounds that everyone who has Hub access to this tool also already has full, easy access to the same raw content directly in Latchel and AppFolio, so gating it in this one tool doesn't prevent anyone from finding it.

**This went to Mason (legal/Fair Housing) for review. Verdict: FLAGGED — rejected as described.** Full review on file; key points:

- Source-system access parity is a *privacy* argument ("nobody sees anything new"), not a Fair Housing argument. What matters legally isn't whether someone *could* find something in Latchel — it's what *this tool* routinely puts in front of staff, unprompted, inside a feature explicitly designed so a first-day hire can get oriented in a minute.
- This isn't just "removing friction" for people who already see this content. Today, only `admin`, `reviewer`, and `director_of_operations` can see flagged claims (via the gated queue). The rejected proposal would give `property_manager`, `inspection_coordinator`, and `pod_lead` — roles that currently have **zero** access — first-time exposure to tenants' protected-class-adjacent facts (disability, health, immigration status, familial status, etc.).
- Proceeding with that version exactly as described would require owner approval **and** a licensed CA attorney's sign-off, per GOVERNANCE.md Rule 6 (Critical changes to compliance guardrails) — not just Mason's review.
- Separately: making *every* role a `reviewer` to route around the role check was also considered and rejected — it reproduces the identical real-world exposure the rejected version created, just via a different code path, and would need the same attorney review to be done honestly.

### What Mason approved — this is the version to build

A bounded navigation improvement that solves Peter's actual complaint without touching who is exposed to what:

1. **The role gate on actual flagged claim content stays exactly as it is today — at the API level.** `requireMaintenanceHistoryRole('admin', 'reviewer', 'director_of_operations')` already governs the backend `/flagged-queue` route, and should be reused unchanged for the new count field, not reimplemented.

   **Decided by Peter, 2026-09-01: include `director_of_operations`.** The backend already allows all three roles (`admin`, `reviewer`, `director_of_operations`) via `requireMaintenanceHistoryRole`; the front-end today doesn't (the tab and its controls are `admin`/`reviewer`-only). This is a confirmed, deliberate, real access grant to `director_of_operations` — not a pure navigation shortcut — and goes to Mason/Asimov as an explicit part of this build. See Combined Open Items #1 for the front-end work this implies beyond just the new badge.

   **Correction, post-build:** this did *not* end up shipping as "part of this build." Asimov required a separate Mason review specifically for this role before it could ship, so the build that implemented the rest of Part 2 shipped with `director_of_operations` deliberately held out of `PRIVACY_REVIEW_ROLES` (narrowed to `admin`/`reviewer` for both the flagged-queue gate and the new count badge) and out of the front-end tab/`canReview`. `POST /claims/:id/review`'s pre-existing three-role grant was left in place but flagged as needing the same review, not treated as a working loophole. `director_of_operations` was added back in a later, separate build once Mason's conditional approval (a one-time acknowledgment gate + role-aware audit logging) was in hand — see `compliance/director-of-operations-privacy-review-access.md`.

2. **Add a property-scoped, count-only indicator on Property Overview, visible only to whichever gated roles are decided above.** E.g. "2 items need privacy review →". No claim text, no category, no detail of any kind — a bare number and a link. When the real count is 0, show no badge at all (same omit-don't-show-zero discipline as the ungated-role case below).
3. **Users without a gated role see nothing different at all.** No badge, no field in their API response, no hint anything is flagged on that property. The Property Overview endpoint must genuinely omit the count field for these roles — not send a zero or null that a front-end bug could misrender — so there is no code path where the wrong role could learn even that something exists.
4. **The link goes to the existing Needs Privacy Review view, filtered to that one property** instead of the whole portfolio. The un-filtered, portfolio-wide view stays available and unchanged as the default when reached normally (not via this new link) — this preserves its role as a comprehensive compliance sweep, which depends on nothing being scoped away by default.

   **Caught on review — two things the filtered view needs that don't exist today:**
   - The `/flagged-queue` response doesn't include a property id on each row, only `property_name`/`unit_number` text — and if the filtered result is genuinely empty (a real "nothing flagged here" case), there's no row left to read a property name *from*. The property label for "filtered to [property]" has to be carried over from the Property Overview page the reviewer clicked from, not derived from the flagged-queue response itself.
   - The queue's empty-state message is a single generic line today ("Nothing in the privacy review queue right now"), used everywhere. Shown inside a property-filtered view with zero results, that reads as "the whole portfolio queue is empty," which would be false and misleading. It needs its own copy when filtered (e.g. "Nothing flagged for [property] right now").

5. **Marker language must not reuse "low confidence."** That phrase is already used elsewhere in this tool for ordinary AI-confidence scores, unrelated to Fair Housing — reusing it here would train staff to skim past a real flag as routine uncertainty. Use distinct wording (e.g. "needs privacy review").
6. **View-logging.** Checked directly against the code, not left as an open question: **there is no audit-log entry anywhere today for the act of viewing the flagged queue** — only for a claim first getting flagged (ingest time) and for a claim being confirmed/corrected/rejected (review time). So the real decision for Asimov isn't "does existing logging already cover this" — it's whether to add view-logging for the first time at all, now that flagged content becomes reachable from a second entry point. Framed correctly, that's a fresh call, not a gap-check.

### Before this gets built

Per Mason's own recommendation: one more pass with Asimov specifically confirming this bounded version matches what Mason actually approved (no scope creep back toward the rejected version), and confirming the role-check reuses the existing, already-proven mechanism rather than a new one. **No attorney review needed for this version** — Mason was explicit that the bounded approach fits inside the normal Mason/Asimov pipeline already used elsewhere in this codebase.

### What's genuinely new to build

- **Backend — Property Overview endpoint** (`GET /api/maintenance-history/property/:property_id/overview`): role-gated `flagged_review_count` field, omitted (not zeroed) for ungated roles.
- **Backend — flagged-queue endpoint** (`GET /api/maintenance-history/flagged-queue`): optional `?property_id=` filter, additive only — existing gate and default (unfiltered) behavior unchanged.
- **Frontend — Property Overview**: the badge/link itself, rendered only when the field is present.
- **Frontend — Needs Privacy Review / `loadFlagged()`**: accept an optional property filter, carry the property label over from Property Overview (not derived from the flagged-queue response), show a clear "filtered to [property] — view all" indicator when scoped, and a distinct empty-state message for the filtered case so it can't be misread as "the whole queue is empty."
- **Frontend — role visibility, confirmed in scope per the `director_of_operations` decision above**: show the "Needs Privacy Review" tab to `director_of_operations` (currently `admin`/`reviewer` only), and extend `canReview` so they can actually use Confirm/Correct/Reject once there — matching backend access that already exists. **Post-build correction: this shipped in a separate, later build, not this one** — see the correction under "What Mason approved," item 1, above.

### Deliberately not part of this build

- No change to *who* holds the gated roles today. If Peter wants specific additional people trusted with this content, that's a separate, deliberate decision made through the existing `reviewer` role grant — per-person, auditable, reversible — not a change to this spec.
- No change to the portfolio-wide default view of Needs Privacy Review — it stays comprehensive by default, exactly as its compliance purpose requires.

### Size

Small-to-medium. No schema changes — reuses existing tables and the existing role-check mechanism. Q: roughly one session (two small route changes, two front-end changes). Governance: one short Asimov pass confirming scope fidelity to Mason's approved version, not a fresh full review.

---

## Combined Open Items — Needs Confirming Before Build

1. ~~`director_of_operations` UI parity~~ — **Decided by Peter, 2026-09-01: yes, include them.** The badge and the underlying Needs Privacy Review access are for all three roles the backend already permits (`admin`, `reviewer`, `director_of_operations`), matching what `requireMaintenanceHistoryRole` already allows at the API level today. Since this is confirmed to be a real, new grant (not a pure navigation shortcut, per the analysis above), it goes to Mason/Asimov as an explicit part of this build, not something to note in passing.

   **This also means fixing the underlying front-end gap, not just the new badge.** Right now `director_of_operations` has API access but the "Needs Privacy Review" tab itself is hidden from them, and the Confirm/Correct/Reject controls inside it (`canReview`) are also `admin`/`reviewer`-only. If they can now reach this content via the new badge, they need to actually be able to use the page it links to — so this build also needs: showing the "Needs Privacy Review" tab to `director_of_operations`, and extending `canReview` to include them, consistent with what the backend has allowed all along. Otherwise the badge would send them to a page that still doesn't work for their role.

   **CLOSED — but not in this build.** Asimov's own pass on this item concluded it needed a real Mason review, not a rubber stamp, so it was pulled out: the build that shipped the rest of this spec went out with `director_of_operations` deliberately narrowed back out of `PRIVACY_REVIEW_ROLES` and the front-end tab/`canReview` (see the correction under Part 2, "What Mason approved," item 1). Mason then reviewed the question on its own and gave a conditional yes — a one-time acknowledgment gate before this role can see flagged claim content or use Confirm/Correct/Reject, plus role-aware audit logging — and a later, separate build implemented the access together with both conditions. Full trail: `compliance/director-of-operations-privacy-review-access.md`.
2. **View-logging** (Part 2, condition 6) — confirmed no logging exists today for viewing the queue at all; this is a decision to add it for the first time, not a check for a gap. Resolve during the Asimov pass.
3. **Marker wording** — exact copy for the badge ("needs privacy review" was Mason's suggested direction, not a mandated exact string) — Tron's call within that constraint.
4. **Shared property state persistence** (Part 1) — should the current property survive a full page reload (e.g. via a URL parameter), or is in-memory-only (lost on refresh) acceptable for v1? Not yet discussed with Peter — worth a quick call before Tron builds it, since it changes the implementation slightly.
5. **Reconciling `lastOverviewPropertyId`/`cameFromOverview`** (Part 1) with the new shared `currentPropertyId` — replace them or keep both? Decide during build, not implicitly.
