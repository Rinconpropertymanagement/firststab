# Work Order Notes Alert — Build Spec

**Status:** Design complete, grounded in live data pulled 2026-09-21. **APPROVED TO BUILD, WITH CONDITIONS** (Asimov, 2026-09-21 — full review and hard-requirement conditions: `compliance/work-order-note-alerts-governance-review.md`). Section 7 (Compliance) below is preserved as Oracle originally wrote it, as the historical record of the open question — see the linked review for the actual verdict, including the Mason-routing determination (recommended by Asimov, explicitly overridden by Peter; see that document for how that's recorded). Every other section is design-complete; nothing else is waiting on a Peter decision except the two items flagged in the Open Items list at the end.

**Written by:** Oracle
**Date:** 2026-09-21

**Built from, read in full:** `projects/hub/approval-briefing/router.js`, `approval-briefing-SPEC.md` (all 12 sections), `maintenance-history/lib/latchel-connector.js`, `maintenance-history/router.js` (the Latchel↔property↔ticket matching logic, all three join paths), `maintenance-history/SPEC.md`'s Latchel field-verification notes, `lib/notify.js`, `insurance/router.js` (email + pod-fallback pattern), `security-deposit/router.js` (the `sendFailureAlertEmail` pattern), `maintenance-history/lib/protected-class-terms.js`, `owner-tenant-notes/lib/note-content-check.js`, `property-360/router.js` (the Maintenance card), `supabase/migrations/20260906000000_add_maintenance_notes_to_properties.sql`, `20260720000004_insurance_compliance.sql`, `20260918050000_notification_recipients_schema.sql` (via `lib/notify.js`'s description of it), `GOVERNANCE.md` Rules 1/4/6/7/8/9 and the Fair Housing Standard, `server.js`'s env-var documentation, and `maintenance-history/latchel-sync-frequency-feasibility.md` (for how cron actually gets scheduled on Sally). Plus two live, read-only checks run today (details throughout): real Latchel job data pulled via the existing connector, and current column-population counts pulled directly from Supabase.

---

## 1. What This Feature Does

Right now, if a property has special handling instructions on file (e.g. "Call Zack for approval on any work order"), the only place that shows up is the property's page in the Hub — someone has to think to go look. This feature makes it push instead of pull: the moment a new work order is created in Latchel for a property that has one of these notes, an email goes straight to that property's team inbox (Faria or Solimar) with the note and the basic work order info, so the right people see it immediately instead of finding out after the fact.

It is a fixed-template, plain-text email — no AI writes any part of it. It reuses Rincon's existing, already-verified Latchel webhook rather than building a new one.

---

## 2. Trigger and Webhook Design

### 2.1 Reusing the existing webhook, not building a new one

`POST /api/approval-briefing/internal/webhook` already receives every `Job/created` and `Job/updated` delivery from Latchel, secret-verified and rate-limited. Per the instruction for this spec, this feature adds a second, independent branch to that same handler — it does not touch, reorder, or depend on the existing "Needs Approval" (`state_id === 27`) logic already there, and it is not a new route with its own secret. Concretely: after `checkWebhookSecret()` and the `object_type === 'Job'` filter (both already in the file, both unchanged), the parsed `job` object feeds two independent branches — the existing approval-briefing logic, and this feature's new logic — in either order, since neither reads or writes anything the other touches.

Recommended file organization (Q's call on the exact layout): keep the secret/rate-limit code and the route itself in `approval-briefing/router.js` exactly where they are, and put this feature's own logic in a new sibling module (e.g. `approval-briefing/lib/work-order-notes-alert.js`) that the route calls into — the same shape `router.js` already uses to call out to `./lib/gather.js` for its own logic.

### 2.2 Verified live: a fresh Latchel Job carries what this feature needs, directly

This was the single biggest open question, and it's now resolved with real data, not assumption. Using the existing read-only connector (`latchel-connector.js`, no new methods added), I pulled 170 real jobs updated in the last 7 days and fetched full detail on 3 of them via `getJob()`.

**Both the webhook-delivery shape and the `GET /jobs/{id}` detail shape carry `property_id` — Latchel's own internal property ID — directly on the job, with no `null`s in the sample.** (Full key list, confirmed live: `access_instructions, created_at, description, enter_permission, estimate, estimate_note, is_emergency, is_mandatory, is_urgent, is_vacant, issue_id, job_id, job_rating, location_id, manually_assign_vendor, max_cost, name, order_number, pm_id, problem_id, project_id, property_id, rating_comments, ref_job_id, scheduled_end, scheduled_start, severity, slug, source, state, state_id, tenant_id, updated_at, vendor_description, vendor_id, vendor_rating`.) There is no address or unit text on the Job object itself, and no `ref_property_id` on Job (that field lives only on the separate `GET /properties` object) — `property_id` is the only, and sufficient, link.

**This means property resolution does NOT need to go through a matched `maintenance_requests` row at all** — the original concern was that this might be the only reliable link, and that turns out not to be the case, because the actual link is one level up, at the property level, not the ticket level: `job.property_id` (Latchel's internal ID, e.g. `175353`) matches `properties.latchel_property_id`, a column already populated by the existing `POST /api/maintenance-history/internal/reconcile-properties` job (matches Latchel's `GET /properties`' `ref_property_id` against `properties.appfolio_id`). Checked live today: **350 of 398 properties (88%) already have `latchel_property_id` populated** — this is current, not the 0%-populated snapshot `approval-briefing-SPEC.md` recorded a month ago; that reconciliation job has clearly been run since. The remaining 12% is a real, bounded gap, not a design blocker — see 2.4.

**No new Latchel dashboard subscription is needed either.** Approval Briefing already has both `Job/created` and `Job/updated` subscriptions registered and pointed at this exact URL — meaning every new-work-order-creation event is already arriving here today; it's just being discarded because it isn't state 27. This feature's new branch simply stops discarding it.

### 2.3 Defining "new work order" without depending on an unconfirmed field

Whether Latchel's webhook body explicitly labels a delivery as "this was a created event" vs. "this was an updated event" is not confirmed by anything in this codebase's existing research or code — the current handler never checks for such a field, because it only cares about the resulting state, not which event produced it. Rather than depend on an unverified field, this feature defines "new work order" operationally: **the first delivery this system ever sees for a given `latchel_job_id` is what triggers the one-time notification** (see Section 4 for the dedup mechanism that makes this safe). In practice this is equivalent to "the job was just created," since a job's creation event will essentially always be the first delivery Latchel sends for it — and it has the added benefit of still working correctly even in the rare case a `created` delivery is dropped and an `updated` delivery arrives first.

### 2.4 Backstop: yes, this needs one, and here's why

Decided, not assumed: **yes.** Two independent reasons, not one:
1. Latchel's webhook has no documented delivery guarantee — confirmed by three separate official doc sources in the approval-briefing research, and reconfirmed independently in `maintenance-history/latchel-sync-frequency-feasibility.md` ("Rincon's own working webhook build for Approval Briefing proves this, since it still needed an hourly backstop poll on top of the webhook").
2. This feature's entire purpose is "don't miss this" — an even stronger case for a backstop than approval-briefing had for itself.

Design: a new internal route, `POST /api/approval-briefing/internal/reconcile-work-order-notes`, authenticated with the same `checkCronSecret()`/`CRON_SECRET` pattern already in this file (reused exactly, not reinvented). It calls `latchel.listJobsUpdatedSince(since)` — the same connector function `maintenance-history`'s nightly ingest already uses, with the same proven pagination-safe fix already built into it — and runs every returned job through the identical resolve → check-notes → check-pod → send logic as the webhook path. This is a new route rather than an added branch on the existing `/internal/reconcile` endpoint because that endpoint pulls a structurally different query (`listJobsNeedingApproval`, state 27 only) — reusing the auth pattern, not the endpoint itself, matches this codebase's existing convention of one focused route per concern.

Because this route re-checks the same dedup table as the webhook path (Section 4), running it repeatedly or on overlapping windows is always safe — no double-sends.

**Cadence:** recommend hourly, matching approval-briefing's existing poll (Scotty already maintains a cron entry for that sibling job on the same box). One honest caveat: this repo has no crontab file anywhere in it — every real cron schedule on the production server (Sally) is configured directly there, by hand, outside version control (confirmed via `maintenance-history/latchel-sync-frequency-feasibility.md`, which describes reading Sally's live crontab directly). Scotty needs to actually add the cron entry for this new endpoint; this spec can recommend a cadence but can't confirm one exists until Scotty wires it up.

---

## 3. The Two Data Lookups

| Lookup | Source | Live population (checked today) |
|---|---|---|
| Maintenance notes | `properties.maintenance_notes` (TEXT, nullable), synced nightly from AppFolio's `property_directory` report — mapping already shipped in `sync.js` (`if (row.maintenance_notes) built.maintenance_notes = row.maintenance_notes;`), contrary to this spec's original brief which described that mapping as still pending | **194 of 398 properties (49%) currently populated** |
| Pod | `properties.pod` (TEXT, `'Solimar'` \| `'Faria'` \| NULL) | **381 of 398 populated (275 Solimar, 106 Faria); 17 NULL** |

Combined, of the 194 properties with a note on file: **174 also have both a pod and a resolvable `latchel_property_id` (the clean path). 20 have a note but no `latchel_property_id` yet** (the 12% gap from 2.4 — these are caught by the backstop once `reconcile-properties` catches up, not lost). **1 has a note but no pod assigned** (the unassigned-pod fallback case, Section 5.2 — real, but rare today).

**Important scope boundary:** this feature reads `properties.maintenance_notes` only — never `job.description`, `job.vendor_description`, `job.estimate_note`, or `job.access_instructions`. Those are the job's own free-text fields, not yet content-checked anywhere in this codebase for this purpose, and pulling them in would blur this feature into the much larger, still-governance-blocked "Section 8 email generation" work in `approval-briefing-SPEC.md` (explicitly out of scope per this spec's brief). This feature's email is built entirely from already-synced, already-reviewed-once property data plus a handful of deterministic job fields (address, job id, ticket number) — nothing freshly read from the job's own narrative text.

---

## 4. Duplicate-Notification Prevention — a small new table (Neo)

**Flagging this as a small, well-defined Neo task**, not inventing schema myself. Requirements only:

A new table — suggested name `work_order_note_alerts` — one row per Latchel job that has triggered (or attempted to trigger) a notification. Unique on `latchel_job_id`. Fields, grouped by purpose (exact types/constraints are Neo's call):

- **Identity:** `latchel_job_id` (unique, not null), `latchel_property_id` (Latchel's raw property ID as seen on the job, captured even if it didn't resolve), `property_id` (nullable FK → `properties`, RESTRICT).
- **What was resolved:** `pod` (`'Solimar'` \| `'Faria'` \| `'unassigned_both'`), `recipients` (email array — who it actually went to).
- **Content-check result** (mirrors `maintenance_claims`' existing fields, same discipline — never store the matched term text, only the category): `flagged_protected_class` (boolean), `flagged_category` (text, nullable).
- **What was sent:** `notes_snapshot` (the maintenance-notes text as actually included in the email — if the content check held it, this stores the placeholder text that was sent instead, never the raw flagged text, per this codebase's standing rule in `protected-class-terms.js`).
- **Outcome, and retry logic:** `send_status` (`'sent'` \| `'failed'`), `send_error` (nullable), `trigger_source` (`'webhook'` \| `'reconciliation_poll'`), `attempted_at`, `sent_at` (nullable).

**The logic that makes both duplicate-prevention and failure-retry work together, with one mechanism:** before sending, check for an existing row by `latchel_job_id`. No row, or an existing row with `send_status = 'failed'` → attempt the send, insert or update the row. An existing row with `send_status = 'sent'` → skip, already handled. This means a transient send failure is automatically retried on the next poll (or the next webhook delivery for the same job, if one arrives) instead of being permanently given up on after one failed attempt — which matters specifically because this feature's whole point is not missing a notification.

RLS: enabled, zero permissive policies at creation, matching every table in this schema. Not tenant PII in the SSN/financial sense, but does carry property-operational text — Neo/Asimov should confirm whether this needs a Rule 4 data-inventory addendum (likely a light one, similar reasoning to `maintenance_notes`' own migration: operational text about a property, not personal data about a person).

---

## 5. Recipient Resolution

### 5.1 The normal case

Resolve via `getSharedInbox('faria_pod_team')` / `getSharedInbox('solimar_pod_team')` in `lib/notify.js` — **not** hardcoded email strings. Checked live today: the `shared_inboxes` table exists, is populated, and both keys resolve correctly to the addresses Peter confirmed (`fariateam@rinconmanagement.com`, `solimarteam@rinconmanagement.com`), both marked active. This is also simply the current codebase convention — `insurance/router.js`'s pod-routing logic already migrated off hardcoded literals to this exact lookup, and a new feature should follow the pattern already in place, not reintroduce a third hardcoded copy of the same two addresses.

### 5.2 Unassigned-pod fallback

If `properties.pod` is NULL for a property with a triggering note: email **both** `getSharedInbox('faria_pod_team')` and `getSharedInbox('solimar_pod_team')` (same shape as `insurance/router.js`'s own existing "property can't be matched to a pod" fallback, lines ~989–1005 — this feature copies that pattern directly, not a new one), **and** separately write a `tasks` row (`entity_type: 'property'`, `entity_id: <property.id>`, `title: "Property missing pod assignment"`, `status: 'open'`) so the underlying data gap is tracked, not just routed around silently forever.

**One honest caveat, worth flagging rather than glossing over:** the `tasks` table exists and is written to elsewhere in this codebase (`insurance/router.js`'s batch-import summary), but there is currently no Hub page or view that lists/displays `tasks` rows anywhere — it's a write-only destination today. Writing here is still worth doing (it's cheap, durable, and matches existing convention, and a future tasks-list view would immediately pick up these rows for free) but it should not be presented as a proven "someone will see this" mechanism on its own — pair it with the audit log entry in Section 8, and treat "build a real tasks list view" as a separate, standalone gap in this codebase that this feature surfaces but doesn't need to fix.

### 5.3 Frequency

No throttling, confirmed by Peter: every new work order at a flagged property sends its own email, every time — Section 4's dedup is purely "don't send twice for the *same* work order," never "don't send again if a similar one was sent recently."

---

## 6. Email Content

Plain text, fixed template, no AI-generated content anywhere in this feature. Suggested fields (Q/Tron's call on exact copy and formatting):

```
Subject: Work Order Alert — [Property Address] has special handling notes

A new work order was just created for [Property Name / Address] (pod: [Solimar/Faria]).

This property has maintenance notes on file:
"[maintenance_notes text — or the held-content placeholder, see Section 7]"

Work order: Ticket #[order_number] (Latchel job [job_id])
Created: [job.created_at]

View this property: [HUB_BASE_URL]/property-360?property_id=[property.id]
```

Deliberately excludes the job's own `description`/`vendor_description`/`estimate_note` (Section 3's scope boundary) — this is a fixed alert that a special-handling note exists and a new work order triggered it, not a summary of the work order itself. `order_number` (Rincon's own human-facing ticket numbering, confirmed present on every real job pulled) is included as a convenience cross-reference, not the AI-synthesized content Section 8 of `approval-briefing-SPEC.md` covers — that remains a separate, larger, still-blocked initiative, and this feature should stay clearly on this side of that line. I don't think the line is actually blurry here: this email contains zero words generated by a model, only a template filled with already-synced structured fields plus one already-existing property-level text field.

---

## 7. Compliance — PENDING ASIMOV REVIEW

**This section is explicitly not a decision. Flagging clearly, per this spec's brief, so it isn't mistaken for one.**

`properties.maintenance_notes` has been scanned for protected-class content exactly once — manually, by Peter, plus a one-time keyword pass, on 2026-09-06, against the 194 values that existed that day (`supabase/migrations/20260906000000_add_maintenance_notes_to_properties.sql`). That migration explicitly, deliberately added **no ongoing enforcement** — any future AppFolio edit lands in this column unscanned on the next nightly sync. That was an acceptable design for the use this field had at the time: a plain, login-gated display field on Property 360, already reviewed once, with a human choosing to go look at it.

**This feature changes that use materially.** It takes the same unenforced field and pipes it into an unprompted, automatic outbound email, every time a new work order is created, indefinitely into the future — a genuinely new use outside the one this field's own migration was scoped and approved for.

This codebase has an established two-layer pattern for exactly this situation:
- **Layer 1 — `scanText()` from `maintenance-history/lib/protected-class-terms.js`.** Deterministic, fast, free, no network call, already proven on this exact field once. Recommend: run unconditionally, at send time, every time (not stored-and-reused from the 2026-09-06 scan, which is now stale by construction).
- **Layer 2 — an AI self-check**, the pattern `owner-tenant-notes/lib/note-content-check.js` layers on top for tenant-authored free text reaching a comparable audience. Not a direct drop-in (that module's Layer 2 is built for a different table/purpose), but the same pattern could be replicated for this field if Asimov/Mason want the extra coverage.

**What this spec recommends, marked as a recommendation for Asimov to confirm or override, not a decision already made:** run Layer 1 unconditionally. Whether Layer 2 is also warranted here is a proportionality call — this field already got one human review plus one keyword pass with zero matches, and it's property-level operational text (vendor contacts, approval routing) rather than tenant-narrative text, which is a materially different risk shape than the free-text fields Layer 2 exists to catch elsewhere in this codebase. Asimov should decide.

**If Layer 1 (or Layer 2, if adopted) flags the note:** the recommendation is to hold the note text specifically, not the whole email — send the rest of the alert (property, work order, link) with the note line replaced by a fixed placeholder ("Maintenance notes on file — flagged for review, see Property 360 for details"), mirroring the established "missing/held data renders as a labeled placeholder, never a silent drop, never blocks the rest of the message" pattern from `approval-briefing-SPEC.md` Section 8. This is proportionate specifically because the note text isn't disappearing — it's already visible, unconditionally, on Property 360 today (that's a decision Peter already made and this feature doesn't reopen); the gate here is only about whether it also gets repeated in an unprompted email before a human has looked at the flag.

Jarvis: this section is the reason Q cannot start on this feature yet, per CLAUDE.md's Governance & Compliance rules. Please route this spec to Asimov (governance) and, given the Fair Housing Standard's broad "any communication" language, probably Mason too, even though this is an internal staff email, not tenant-facing — flagged for their judgment, not decided here.

---

## 8. Failure Visibility

This feature's whole point is "don't miss this," so a failure that only shows up in a server log defeats the purpose. Two layers, kept deliberately simple:

**1. Every attempt is durably recorded** (Section 4's table) — a Supabase write, which doesn't depend on email working at all, so this layer can't fail for the same reason an email send would.

**2. Surfaced somewhere a human actually looks.** Recommend adding a small "Work order alerts" line to Property 360's existing Maintenance card (`property-360/router.js`'s `fetchMaintenanceCard`, which already renders `maintenance_notes` for this exact property today) — showing the outcome of the most recent alert attempt for that property. This is cheap specifically because that card and its data-fetch path already exist and already surface this same field.

**One honest, current gap worth flagging rather than assuming away:** this codebase's established "something is fundamentally broken, tell Peter no matter what" fallback (`sendFailureAlertEmail`, in `security-deposit/router.js` and `archive-search/router.js`) is deliberately built on a *separate* credential from the normal send path (`nodemailer` + `GMAIL_USER`/`GMAIL_APP_PASSWORD`, not `lib/notify.js`'s Gmail-API path) — specifically so a bug in one can't silence the alert that the other is broken. **Checked live today: `GMAIL_USER`/`GMAIL_APP_PASSWORD` are not set in this project's `.env`, and `.env.example`'s own comment states they're also not set on the production server.** That means this established fallback pattern, if reused as-is, would itself be a silent no-op right now — the code already says as much in its own comments. (For contrast: `lib/notify.js`'s Gmail API credentials — `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`HUB_NOTIFY_REFRESH_TOKEN` — **are** all set and working today, which is why the primary send path in this spec is designed around it.)

Recommendation: this feature's primary send goes through `lib/notify.js` (confirmed working). For the "tell Peter no matter what" layer specifically, either (a) get `GMAIL_USER`/`GMAIL_APP_PASSWORD` actually configured in production so the existing `sendFailureAlertEmail` pattern is real rather than theoretical — worth doing regardless of this feature, since it's silently non-functional for the tools that already have it — or (b) accept layer 1 + 2 above (durable row + Property 360 card) as the v1 safety net and revisit a true independent-credential fallback once (a) is resolved. This spec doesn't decide between those two — flagging it for Peter, since it's a real, currently-true fact about the codebase, not a hypothetical.

---

## 9. Audit Logging (GOVERNANCE.md Rule 1)

Following this codebase's established per-event-type convention, content-free `event_data` throughout:

1. `work_order_note_alert.triggered` — a qualifying job was seen (notes present, property resolved). `actor_type: 'system'`.
2. `work_order_note_alert.sent` — `actor_type: 'system'`, `event_data: { latchel_job_id, property_id, pod, recipients }`.
3. `work_order_note_alert.send_failed` — same shape, `risk_level: 'high'` (matching this codebase's convention of elevating risk_level for a failure that could mean something real got missed).
4. `work_order_note_alert.protected_class_excluded` — fires only if Section 7's check flags the note. Same shape and same restraint as `maintenance_claims.protected_class_excluded` — category only, never the matched text.
5. `work_order_note_alert.pod_unassigned_flagged` — the both-inboxes fallback fired.

---

## 10. Testing Plan for TARS

Concrete, not "figure it out" — real anchors from today's live data:

1. **Dry-run replay against real jobs.** Add a `--dry-run` flag (same convention `projects/insurance-compliance/assign-pods.js` already uses) that pulls real recent jobs via `listJobsUpdatedSince()` and runs them through resolve → check-notes → check-pod → content-check, logging what *would* happen (property resolved? notes found? which pod? flagged?) without calling `sendMail()`. Safe against production data, no real email sent, no write to Latchel/AppFolio ever (the connector is GET-only by construction).
2. **One real end-to-end send, to Peter only, not the real pod inbox.** Use a real, already-confirmed property with notes on file — e.g. **2402 E. Ocean Avenue** (pod Faria, `latchel_property_id` resolved) or **1444 S E St.** (pod Solimar, `latchel_property_id` resolved) — both confirmed live today to have a populated note and a resolvable property link. Temporarily override the recipient to `peter@rinconmanagement.com` with an obvious `[TEST]` subject prefix, and either wait for or manually trigger (via the dry-run harness feeding a real recent job at that property into the real send path) one real send, so the actual `lib/notify.js` path is proven, not just the resolution logic.
3. **Dedup proof.** Re-run the same real job through the pipeline twice (once via the webhook-shaped path, once via the reconcile path) and confirm exactly one send, one `work_order_note_alerts` row, `send_status = 'sent'` both times checked.
4. **Retry-on-failure proof.** Temporarily break the mailer config (or mock `sendMail()` to fail once), confirm a `'failed'` row is written, then restore config and confirm the next poll retries and flips it to `'sent'` rather than skipping it.
5. **Unassigned-pod path.** Live data has exactly one real property today with a note and no pod — TARS can use it directly (read-only check, no data modified) to confirm both inboxes get addressed and the `tasks` row is written.

None of this requires creating a fake work order in production AppFolio or Latchel — every step above works against real, already-existing data through the read-only connector, which is the safer and more representative test than fabricating one.

---

## 11. What This Does NOT Do

- Does not touch, reorder, or depend on the existing "Needs Approval" (`state_id === 27`) logic already live in `approval-briefing/router.js`.
- Does not read or expose `job.description`, `job.vendor_description`, `job.estimate_note`, or `job.access_instructions` (Section 3, Section 6).
- Does not generate any text with AI — 100% fixed template plus already-synced fields.
- Does not route to Dio or Marci by name, anywhere, under any fallback — pod shared inboxes only, per Peter's confirmed final answer.
- Does not throttle or deduplicate across different work orders at the same property — only across repeated deliveries of the *same* work order.

---

## 12. Build Sequence

1. **Neo** — `work_order_note_alerts` table (Section 4), RLS, Rule 4 addendum if needed.
2. **Q** — the new webhook branch (Section 2), the new reconcile route (Section 2.4), recipient resolution (Section 5), email template (Section 6), Layer 1 content check wired in per Asimov's Section 7 sign-off, audit log entries (Section 9).
3. **Tron** (only if a Property 360 UI change is wanted for Section 8's visibility layer — small, one card).
4. **TARS** — Section 10.
5. **Judge** — final review.

**Blocked until Asimov (and likely Mason) sign off on Section 7.** Everything else above is ready to build the moment that clears.

---

## Open Items — Needs Confirming Before Q Starts

1. **Section 7 (Compliance) — Asimov's call, not made here.** Does this field need Layer 1 only, or Layer 1 + Layer 2, before it can go into an automatic outbound email? Mason's input likely needed too, given the Fair Housing Standard's broad "any communication" language, even though this is staff-facing, not tenant-facing.
2. **Section 8 (Failure visibility) — Peter's call.** Get `GMAIL_USER`/`GMAIL_APP_PASSWORD` actually configured in production (fixing a real, currently-silent gap that predates this feature and also affects Security Deposit's and Archive Search's existing fallback alerts), or ship this feature's v1 with just the durable-row + Property 360-card layer and revisit later?
3. **Scotty** — needs to add the actual cron entry for the new `reconcile-work-order-notes` endpoint on Sally; nothing in this repo does that automatically (Section 2.4).

Everything else in this spec is design-complete and grounded in data pulled live today, not assumption.
