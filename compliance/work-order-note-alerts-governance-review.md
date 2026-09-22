# Work Order Note Alerts — Governance Review

**Status:** Real Asimov governance pre-check on `projects/hub/work-order-notes-alert-SPEC.md`, run against Oracle's completed spec per that spec's own Section 7 ("PENDING ASIMOV REVIEW"). The substantive review happened in an orchestration session with Jarvis on 2026-09-21 and is transcribed here verbatim (lightly reformatted, not paraphrased), so it exists as a checkable artifact rather than only as chat narrative — the same discipline `compliance/leadsimple-tasks-workflows-data-inventory.md` and `compliance/approval-briefing-spec-governance-precheck.md` were each written to satisfy. This document is written in direct response to Neo flagging, in `compliance/work-order-note-alerts-data-inventory.md`, that no such standalone document existed yet. It satisfies that gap.

**Written by:** Asimov
**Date:** 2026-09-21

**Built from, read in full:** `projects/hub/work-order-notes-alert-SPEC.md`, `GOVERNANCE.md`, `projects/hub/maintenance-history/lib/protected-class-terms.js`, `projects/hub/maintenance-history/lib/content-check.js`, `projects/hub/owner-tenant-notes/lib/note-content-check.js` and `lib/manual-note-classifier.js`, `projects/hub/approval-briefing/lib/access-instructions-check.js`, `lib/gather.js`, and `lib/risk-assessment.js`, `supabase/migrations/20260906000000_add_maintenance_notes_to_properties.sql`, `projects/hub/property-360/router.js` (`fetchMaintenanceCard` — confirmed live, no content-check call today), `projects/hub/lib/notify.js`, `.claude/agents/mason.md`, and, in `compliance/`: `approval-briefing-spec-governance-precheck.md`, `work-order-note-alerts-data-inventory.md`, `leadsimple-tasks-workflows-data-inventory.md`, `appfolio-maintenance-notes-governance-review.md`, and `appfolio-maintenance-notes-decision-resolution.md`.

---

## Short answer

**Approved to build, with conditions.** Four conditions are hard requirements Q builds to, not suggestions: a Layer 1 + Layer 2 content check on `properties.maintenance_notes` at send time, redact-the-note-line-not-the-whole-email on a flag, a proactive human alert on every flag (not just a logged row), and Layer 2 failing safe on its own errors. Mason's review was separately recommended by this document and relayed by Jarvis as explicitly overridden by Peter — I am not re-litigating that override, but I am recording it plainly, and I found one open sub-question (retention) that override leaves genuinely unresolved rather than answered. Both are addressed below, in full, not left implicit.

---

## What this automation does

When Latchel reports a new work order at a property that has a maintenance note on file (e.g. "call Zack for approval"), the system sends a fixed-template, no-AI-generated-content email to that property's pod's internal shared inbox (Faria or Solimar team) with the note text and basic work-order info. Recipients are internal Rincon staff inboxes only — never tenants, owners, or vendors. Fires on every qualifying work order, unthrottled, per Peter's confirmed decision (not reopened here). Full design: `projects/hub/work-order-notes-alert-SPEC.md`.

---

## The three questions Oracle's spec left open, answered

### 1. Layer 1 alone, or Layer 1 + Layer 2?

**Both, required, run unconditionally at send time against the field's current value** — never reused from the stale 2026-09-06 one-time scan.

This codebase already has a directly on-point precedent, not a hypothetical one: `approval-briefing/lib/access-instructions-check.js` runs the same two-layer check on `access_instructions` — property/job-adjacent free text of essentially the same shape and origin — before it can enter an automated pipeline, specifically because Mason's Fair Housing review (`compliance/approval-briefing-fair-housing-review.md`, finding 1) required it: a free-text field "can just as plausibly carry something protected-class-adjacent." That gap — subtler phrasing a fixed keyword list won't catch — is Layer 2's entire reason for existing everywhere else it's used in this codebase. `maintenance_notes` is at least as exposed: AppFolio-authored, editable by any PM at any time, unscanned on every sync since the one 2026-09-06 pass, and (per `compliance/appfolio-maintenance-notes-governance-review.md`, my own prior review of this exact field) already assessed as content this codebase does not consider self-evidently safe absent a check. Applying a lighter standard here than was already required for a comparable field would be inconsistent. Marginal cost is low — Layer 2 is a small clone of `owner-tenant-notes/lib/manual-note-classifier.js` (same model, same low effort, same 512-token classification call), firing only on a bounded, low-frequency event.

### 2. What happens on a flag?

**Redact the note line only; send the rest of the email; separately and proactively alert a human.**

- Hold *only* the note text, substitute the spec's proposed placeholder ("Maintenance notes on file — flagged for review, see Property 360 for details"), and send the rest of the alert normally — mirroring the proven `status: 'held'` pattern in `access-instructions-check.js`/`gather.js`: "a labeled placeholder, never a silent drop, never blocks the rest of the message." Holding the entire email would defeat this feature's purpose for the 100% of content that carries no risk.
- **New requirement, beyond what Section 7/8 of the spec currently specify:** every flag must also trigger a real, separate, proactive notification (via `lib/notify.js`'s `sendMail`) to a human who can act — not just the planned `work_order_note_alerts` row and audit-log entry, and not just a passive line on Property 360's Maintenance card. Section 5.2 of the spec itself already concedes the codebase's write-and-hope pattern (`tasks` table) is "not a proven 'someone will see this' mechanism" — the same weakness applies to a dashboard card nobody is prompted to check. A Rule 9 flag deserves the same "tell a human now" discipline this codebase already applies to technical failures (`sendFailureAlertEmail` in `security-deposit/router.js`/`archive-search/router.js`), pointed at a compliance flag instead. Exact recipient is Jarvis/Peter's call, not a compliance-substance question — but it cannot be the pod inbox alone and cannot be silent-log-only.
- A human decides what to do with a real flag; the system never auto-clears one. No separate "unflag" workflow is needed — this pipeline re-scans the live, current note text fresh on every new qualifying work order rather than persisting a sticky verdict, so a false positive doesn't recur once the underlying text changes.
- Layer 2 must fail *safe*: if the classification call errors, log loudly and proceed on Layer 1's result alone for that instance (copy `note-content-check.js`'s existing try/catch exactly) — never skip the check entirely, never hold the pipeline open waiting on Layer 2.

### 3. Does this need Mason's review too?

**My finding: yes.** This is arguably outside Mason's literal enforcement list (internal staff audience, no housing decision), but the direct precedent — Mason already required two-layer treatment for `access_instructions`, a comparable field, specifically because of what the content could contain, independent of the immediate recipient — binds at least as strongly here, arguably more so given this feed is indefinite and unthrottled rather than per-job.

**What happened after I gave that finding:** Jarvis relayed that Peter explicitly overrode the Mason-routing recommendation — his own call, not something Jarvis talked him into. See "Mason-routing override" below for how I'm treating that and one thing I flagged about how it's recorded.

---

## Tier classification

| Action | Tier | Why |
|---|---|---|
| Detect trigger, resolve property/pod, check dedup table | 1 (Auto) | Internal record-keeping only, no message sent |
| Layer 1 + Layer 2 content check | 1 (Auto) | Automated gate, not a decision about a tenant or applicant |
| Send cleared alert to pod shared inbox | 1 (Auto) | Internal-staff-only recipient, no tenant/owner/vendor, no housing decision, fixed template, unthrottled send explicitly confirmed by Peter — conditioned on passing the content check and on TARS's live Peter-only test (spec Section 10.2) actually running first, per CLAUDE.md's "tested and approved before anything sends automatically" |
| Send redacted alert on a flag | 1 (Auto) | Email itself carries zero unvetted free text at send time |
| Proactive human alert on a flag | 1 (Auto — the notification itself) | System sends this automatically; it invokes human judgment, it isn't one |
| Disposition of a flagged note | 3 (Human Only) | A person decides; the system never auto-clears or reinterprets a flag |

---

## Findings

- **Rule 4 (data inventory):** satisfied by `compliance/work-order-note-alerts-data-inventory.md` (Neo) — a genuinely light-touch, proportionate addendum. One field remains open; see "Retention policy" below.
- **Rule 1 (audit trail):** the spec's Section 9 event types are well-shaped and follow this codebase's content-free `event_data` convention. Standard reminder to Q: every entry still needs the full Rule 1 field set (hash chain, `trace` object) per the established `writeAuditLog` convention.
- **Rule 7 (agent lifecycle / shadow mode):** determined **not applicable**, stated explicitly rather than left silent. This is a deterministic trigger→template→send pipeline with an AI-based content-safety gate, not an autonomous agent making an ongoing judgment call about a person — no text is AI-generated (spec Section 1). Architecturally the same shape as already-shipped notification pipelines in this codebase (`insurance/router.js`, `security-deposit/router.js`) that did not go through 30/90-day shadow mode. Rule 7's lifecycle machinery reads as aimed at a heavier category (e.g. Property Brain's claims-extraction agent).
- **Rules 2, 3, 5, 10:** N/A. No SMS (Rule 3). No screening/scoring decision about a person (Rules 2, 5). No `contact_id`-keyed personal record subject to CCPA deletion in the tenant/applicant sense (Rule 10) — confirmed by Neo's inventory: the table keys off `property_id`/`latchel_job_id` only, no `tenant_id`/`owner_id`/`contact_id` anywhere on it.
- **Scope boundary holds:** confirmed the spec correctly excludes `job.description`/`vendor_description`/`estimate_note`/`access_instructions` from this feature (spec Sections 3, 11). If a future change pulls any of those fields into this pipeline, that needs fresh Asimov review — this approval does not extend there.
- **Property 360's existing display is untouched by this review, deliberately.** Read in full for this review: `compliance/appfolio-maintenance-notes-governance-review.md` (my own 2026-09-06 review of this same field, which recommended an ongoing two-layer check, a review queue, and tiered access for the *display* use case) and `compliance/appfolio-maintenance-notes-decision-resolution.md` (Peter's explicit, repeated override of that recommendation — "we aren't going to go through a crazy review process," confirmed to cover future edits, not just the 194-value backlog). **Nothing in this document reopens that.** The content check required here gates only the new outbound-email channel this feature adds; Property 360's Maintenance card keeps rendering `maintenance_notes` exactly as Peter decided — unscreened, unrestricted, always visible. The distinction driving this review — a person choosing to load a login-gated page vs. Rincon's own system generating and distributing content on a schedule nobody triggers — is the same distinction Jarvis actually put to Peter in the 09-06 conversation ("is this a decision about today's notes, or does it also mean no screening on any future edit to this field, forever?"), and Peter's answer was scoped to the display mechanism, not to every future use of the field. I'm flagging this explicitly so nobody reading this document mistakes the new content-check requirement for a quiet reversal of an already-settled, Peter-confirmed decision.
- **GMAIL_USER/GMAIL_APP_PASSWORD gap (spec Section 8, Open Item #2):** not a governance blocker for this feature, but a pre-existing silent gap affecting other tools' fallback alerts too.

---

## Retention policy — `work_order_note_alerts.retention_policy`

Raised by Neo (`compliance/work-order-note-alerts-data-inventory.md`, line 41: **PLACEHOLDER — pending Mason**) and put to me directly, since Mason isn't reviewing this build. Addressing it here, plainly, rather than leaving it for Jarvis to guess at.

**The facts, checked rather than assumed:**
- Neo's placeholder matches this schema's own standing pattern — `maintenance_claims`, `operational_notes`, `security_deposit_cases`, and `b2_photo_folders` all shipped the same way, pending Mason.
- This table's closest relative, `properties.maintenance_notes` itself (the field this table snapshots), reached the identical placeholder conclusion for the identical reason in my own 2026-09-06 review (`compliance/appfolio-maintenance-notes-governance-review.md`, Section 5/6: "Rincon does not control retention of the underlying AppFolio field... [f]lag this limitation to Mason rather than engineering around it"). As far as I can find in `compliance/`, that placeholder was never actually resolved to a figure — Peter's 09-06 override settled the review-workflow, access-tier, and outside-counsel questions, but not retention. So `work_order_note_alerts` isn't a new open question; it's inheriting one that already existed one level up, still unresolved.
- The one time this codebase actually resolved a retention figure this way — LeadSimple's Application Screening/Delinquency tables, `compliance/leadsimple-tasks-workflows-data-inventory.md` — the mechanism was **Peter's own direct instruction**, invoking Rincon's standing 7-year company-wide records policy, plus his separate confirmation that the underlying policy had prior attorney input specifically to close Mason's request for attorney confirmation on that build. It was not Asimov or Neo inferring the figure applied by similarity to another table.

**I'm not setting this figure myself, and want to be explicit about why rather than quietly default it so the field isn't blank.** Every time this codebase has resolved a table's retention period, it went through Mason or Peter directly — never Asimov alone. Peter overriding "route the whole build through Mason" is a scope decision he's entitled to make, and I'm treating it as such. It is a different thing from Peter deciding this specific figure, and nothing in what Jarvis relayed says he has.

**Is 7 years even the right fit here, on the merits?** Genuinely unclear, worth saying rather than staying silent on:
- *For it:* consistency and simplicity — one standing, attorney-grounded, company-wide policy is easier to operate than a table-by-table patchwork.
- *Against assuming it transfers directly:* the LeadSimple tables it was set for are applicant/tenant screening and delinquency records tied to actual housing decisions — the highest-sensitivity category this business has. `work_order_note_alerts` is the opposite shape on the axis that mattered to that decision: per Neo's own inventory, it has **no tenant/applicant/owner identifier at all** — a property- and job-level notification log, closer in kind to an audit record than a screening record. A shorter, audit-log-style retention period would be at least as defensible, possibly more appropriate. Not my call to pick between them.

**Recommendation:** leave Neo's placeholder exactly as written — no schema or document change requested here. Put this to Mason or Peter directly as its own short, narrow, bounded ask (one field, one table) — not a re-ask of the broader review Peter already declined, and resolvable the same direct way LeadSimple's figure actually was. **This does not block Q's build.** Shipping with a documented placeholder ahead of resolution is this schema's own established, accepted practice — `properties.maintenance_notes` itself has apparently been running that way since 2026-09-06. Recording this now, in writing, so it's a visible open item rather than one that quietly becomes permanent by default because nothing is currently blocking on it.

---

## Mason-routing override

Jarvis relayed, in this session, that Peter explicitly overrode my recommendation (above) that Mason review this feature before it ships — his own call, documented, not something Jarvis talked him into. Per how approval reaches me, I'm treating that as genuine and am not re-opening whether Mason reviews this build as a whole. The four hard-requirement conditions in this document stand regardless and are not contingent on Mason's involvement.

One thing worth naming for the written record, in the same spirit as this document's own reason for existing: I did not find a document in `compliance/` recording this specific override, the way `compliance/appfolio-maintenance-notes-decision-resolution.md` records Peter's 2026-09-06 override of my and Mason's recommendations on this same underlying field. That document is a good model for why this is worth doing — a verbal override, even a real and informed one, is harder to stand behind later than a written record of what was asked, what Peter said, and what he was told the tradeoff was. I'd recommend Jarvis write the short equivalent for this override, since Jarvis had the actual conversation with Peter — flagging the gap, same as Neo flagged mine, not asking anyone to stop and produce it before Q proceeds.

---

## Conditions Q builds to (hard requirements)

1. Layer 1 (`protected-class-terms.js` `scanText()`) **and** Layer 2 (new, small classifier cloned from `manual-note-classifier.js`'s pattern), both run unconditionally at send time against the current `properties.maintenance_notes` value.
2. On a flag from either layer: redact only the note line (fixed placeholder text), send the rest of the alert normally. Never hold the whole email.
3. On a flag from either layer: send a separate, proactive email (via `lib/notify.js`) to a real human recipient, in addition to the `work_order_note_alerts` row and audit-log entry already planned. Recipient TBD by Jarvis/Peter, but not the pod inbox and not log-only.
4. Layer 2 fails safe: a classification-call error logs loudly and falls back to Layer 1's result alone for that instance; it never skips the check or blocks the send.

## Governance status

- **Asimov:** APPROVED TO BUILD, WITH CONDITIONS ✅ (this document, 2026-09-21). Satisfies the gap flagged in `compliance/work-order-note-alerts-data-inventory.md`.
- **Mason:** Recommended by Asimov; explicitly overridden by Peter per Jarvis (see "Mason-routing override" above). Retention figure (see above) still needs Mason or Peter's direct input — narrow, non-blocking.
- **Peter:** Gave the original go-ahead for the feature and for this review (per task framing); separately overrode Mason-routing (relayed by Jarvis, documentation gap noted above, not blocking).
