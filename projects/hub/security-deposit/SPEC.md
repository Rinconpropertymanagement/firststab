# Security Deposit Disposition Assembly Tool — v1 Build Spec

**Status:** Approved — build is underway (Neo's schema done, Q building the routes now). This document is being kept accurate as the source of record as real findings come in from the build, not as a spec still awaiting approval. See the latest revision note below for what changed from hypothesis to confirmed reality.
**Written by:** Oracle
**Date:** 2026-08-13
**Revised:** 2026-08-13 (six passes) — Mason's flagged legal review; Asimov's flagged governance review plus Jarvis's AppFolio attachment-retrieval finding; the AppFolio-connector/Skywalk-readiness architecture change; Peter's direct confirmation of Open Items #2 and #3; Peter's decision to make inspection-form gathering a manual upload for v1 (Open Item #7); and this pass — a documentation-accuracy sync reflecting Neo's live discovery findings during the actual build and Mason's resolution of the Prepaid Rent question (see Neo sections #2, #3, #7, Compliance Grounding, and Open Items for what changed)

**Built from:**
- `~/Downloads/security-deposit-disposition-tool-brief.md` — the original project brief (B2 folder findings, parsing strategy, data source table, open questions)
- `compliance/ventura-county-compliance-kb.json` (`topics.security-deposits`, `topics.trust-account-handling`, `_meta.review_log`) — Peter's Mason-reviewed CA/Ventura County landlord-tenant law research
- Direct reading of the real code this tool extends: `projects/hub/server.js`, `projects/hub/insurance/router.js`, `projects/appfolio-sync/sync.js`, and every relevant file in `supabase/migrations/`

**Where this tool will live:** `projects/hub/security-deposit/` — a new section inside the Rincon Hub, built the same way Insurance Compliance was: one router file, mounted into `projects/hub/server.js`, reusing the Hub's existing login. No new sign-in screen.

**A note on where this document itself lives:** I checked how `rental-analysis` and `calendar-assistant` stored their planning docs before writing this. Neither has one — both plans live only in agent memory (and `calendar-assistant`'s old plan file, which lived outside this repo in `~/.claude/plans/`, has already vanished — proving that location doesn't last). There's no existing convention to follow, so I'm proposing one: this file lives next to the code it specs, inside the tool's own folder, the same way this codebase already keeps rich rationale in long header comments inside router files and migrations. That makes it durable (checked into git), and the first thing anyone opens this folder to find.

---

## What This Does

This tool builds the packet a pod lead needs to review before returning a tenant's security deposit — automatically, as soon as a move-out is confirmed, instead of the pod lead manually digging through two disconnected systems (the Backblaze photo archive and AppFolio) every time. It automatically pulls together the move-in and move-out photos and the tenant's deposit and charge history, gives the pod lead one place to upload the written inspection forms (downloaded from AppFolio, where pulling them in automatically isn't possible today), and puts it all on one screen. It prominently shows how many of the 21 days California gives landlords to return the deposit (or send an itemized, documented statement) are left. It does not decide anything and it does not send anything — a person reviews everything it assembles and does every step after that by hand, exactly like today.

## How It Works

1. **Trigger — automatic, not manual.** Every night, the existing AppFolio sync already pulls lease data into Supabase (the database). This build adds two new pieces of information to that pull: the actual move-out date and the move-out reason, stored in their own dedicated fields (today this information gets silently overwritten some nights — see "What Could Go Wrong" below). The moment the nightly sync sees a lease's move-out date get filled in for the first time, it automatically opens a new disposition case. No pod lead has to notice a move-out happened and remember to start this themselves.
2. **The 21-day clock starts from the real move-out date** — the day the tenant actually left — never from the day the software happened to notice it. Even though the sync only runs once a night, the countdown is always computed from the true date, so a one-day sync delay never eats into the legal window shown to the pod lead.
3. **Assembly happens automatically in the background:**
   - The tool looks up every tenant on the lease (not just one — see the multi-tenant fix below).
   - It pulls the deposit amount(s) held, and all charges/payments/balance, from the tenant's AppFolio ledger — plus, as its own separate figure, the Prepaid Rent balance if there is one (California's deposit cap counts it, but AppFolio books it in a genuinely different account than the deposit itself, so it needs its own pull and its own line — see "What Could Go Wrong").
   - It finds the matching move-in and move-out photo folders in the Backblaze photo archive by property, unit, and nearest date, using an AI-assisted match (the folder names are typed by hand and inconsistent — see below).
4. **The pod lead opens the tool and sees a queue** of dispositions needing review, each showing days remaining, sorted so the most urgent is first.
5. **Opening one case shows everything assembled in one place** — including whether this is the whole tenancy ending or just one co-tenant moving out while the lease continues for the others, shown directly rather than something the pod lead has to work out from the leaseholder list. Two things happen here that software can't do on its own, so the pod lead does them directly in the tool: uploads the move-in and move-out inspection forms (downloaded from AppFolio, where the pod lead can already see them today — v1 doesn't pull these in automatically), and answers a short set of compliance questions — did Rincon send the tenant written notice of their right to request a pre-move-out inspection, was that inspection actually conducted (with a written list of items to fix given to the tenant) if one was requested, and do the right before/after photos exist for any deduction that involves repair or cleaning work. Exact checklist wording is in Compliance Grounding below.
6. **Anything missing is called out, not hidden.** If move-in photos can't be found, if there's no inspection form uploaded yet, if the ledger shows a $0 deposit that might be a data problem rather than a real $0 — the screen says so plainly instead of implying the packet is complete when it isn't.
7. **Reminders escalate automatically as the deadline approaches** — at day 7, day 14, and day 18 after move-out (14, 7, and 3 days left) — the same staged-warning idea already used for lease renewals, compressed to fit a 21-day window instead of a 60/30-day one. These go out whether or not the case has been opened yet, because the tool has no way to know whether the actual deposit return has been mailed — that step happens entirely outside this tool.
8. **From there, everything is manual, same as today.** The pod lead decides what to deduct, writes the itemized statement, and sends it — none of that happens inside this tool, in v1 or ever, without a separate build and a separate approval.

## What You'll See

- A new "Security Deposit" tile on the Rincon Hub home page, next to Insurance Compliance.
- Logging in uses the same email and password as every other Hub tool — nothing new to remember.
- A queue screen listing open dispositions — property, unit, tenant name(s), and a days-remaining count that turns red as day 21 approaches.
- Opening a disposition shows: the lease and all leaseholders, a clear "full tenancy ending" vs. "one co-tenant moving out, lease continues" flag (this changes whether the 21-day clock and inspection rights even apply, so it's shown directly, not inferred from the leaseholder list), the deposit total and — as its own separate labeled line, not folded into the deposit figure — the Prepaid Rent balance if there is one, with a note asking the pod lead to confirm and account for it before finalizing (both labeled clearly as coming from AppFolio's records, not an independently verified trust account balance), the matched move-in/move-out photos side by side, and a place to upload the move-in and move-out inspection forms (downloaded from AppFolio — v1 can't pull these in automatically, so the pod lead attaches them here).
- The compliance questions the pod lead answers directly in the tool: did Rincon send the tenant written notice of their right to request a pre-move-out inspection, and if one was requested, was it conducted before move-out with a written list of items to fix given to the tenant; and for any deduction involving repair or cleaning work, do photos exist from right after move-out (before that work started) and again after it finished.
- Anything the tool couldn't find is shown as a clear flag at the top of the screen — "no move-in photos found," "no deposit amount on file," "inspection form not uploaded yet" — not a passing green checkmark.
- A short separate list (visible to an admin or inspection coordinator) of photo folders the AI wasn't confident about matching, for quick manual confirmation — this keeps low-confidence guesses from silently feeding a disposition packet.
- Email reminders arriving at 14, 7, and 3 days left on any case still open.
- Nothing in this tool ever shows a "send to tenant" button. That action doesn't exist here.

## What Could Go Wrong

- **Resolved, but worth remembering operationally: Prepaid Rent shows as a separate line from the deposit total, not folded in.** AB 12's cap counts prepaid last-month's-rent as part of the aggregate, but AppFolio tracks it in a genuinely different account (Security Deposits vs. Prepaid Rent) than the deposit itself. v1 shows both, separately labeled, with guidance for the pod lead to confirm and account for the Prepaid Rent figure before finalizing — a judgment call the tool surfaces but doesn't make for them, same as everything else in this build.
- **Fixing the multi-tenant bug doesn't retroactively fix already-synced leases.** The database only has room for one tenant per lease today, so multi-tenant leases that have already synced have already lost every tenant but one — silently, whichever one happened to sync last. Adding the fix only prevents new data loss going forward; recovering the tenants already dropped needs a fresh, targeted pull from AppFolio after the fix ships, not just a schema change. (Not hypothetical: Neo already found two real examples — a 3-tenant lease and a 5-tenant lease, both currently showing only one tenant.)
- **The Backblaze photo folders will never match perfectly.** The original brief found real noise — junk folders, loose unfiled photos, inconsistent naming — at roughly 1 in 10-15 items. A pod lead could see "no photos found" for a disposition where photos genuinely exist but simply weren't confidently matched. This is exactly why the missing-evidence flags and the manual-review list both need to exist, and why that manual-review list needs an actual owner checking it — not a report nobody reads.
- **A bug in the day-count math is a legal-exposure bug, not a cosmetic one.** Missing the 21-day deadline forfeits Rincon's right to withhold any part of a deposit, even for legitimate deductions. TARS needs to specifically test the date math (including a case spanning a daylight-saving change and a month boundary) and confirm it always counts from the true move-out date, never from whatever day the sync happened to run.

## Known Limitation — CCPA Deletion Doesn't Reach the Actual Photos

If a tenant submits a CCPA deletion request, this tool can only delete/anonymize what it stores itself in Supabase — the case record, the checklist answers, and its own index of B2 folder names and parsed fields. It cannot delete the actual move-in/move-out photos sitting in Backblaze B2, because the B2 credential is deliberately read-only (the right call — it's exactly what prevents this tool from ever accidentally deleting a real photo). That means an actual tenant photo-deletion request needs a separate manual process outside this tool. This is an accepted, known trade-off, flagged here so it's a documented decision, not something discovered later.

## What Q Needs to Build This

- **A read-only Backblaze B2 credential** from Scotty — this integration doesn't exist anywhere in the codebase today. Read-only because this tool never needs to write or delete a photo, only look at one.
- **Neo's live discovery pass against the real AppFolio API is done.** Findings: the deposit is a single fixed total field (Rincon's real chart of accounts has no separate pet/cleaning/key-fob deposit accounts), and Prepaid Rent (last month's rent collected upfront) needs its own separate `general_ledger` lookup, pulled live per case rather than nightly-synced — see Neo section #3 for the full detail and Mason's resolution on how it's surfaced to the pod lead.
- **A simple upload control for inspection forms:** the pod lead attaches the move-in and move-out inspection form PDFs (downloaded from AppFolio, where they can already see them today) to a case — an ordinary file-upload feature, not an integration. Likely reuses the existing `documents` table rather than a new one — see Neo section #4 below.
- **Neo's schema changes** (detailed below) — dedicated move-out date/reason fields, a real multi-tenant-per-lease structure, deposit/charge-type storage, a disposition case table, and a small persisted index of parsed B2 photo folders.
- **Dedicated audit log entries for every AI parse, every manual override, and every reviewer action** — not optional logging, and a real gap this spec is deliberately not repeating: Insurance Compliance's own review-queue routes don't actually write to `audit_log` when a human accepts, approves, or overrides something today, only when a policy is first saved. This build does better than that precedent, not copy its gap. Exact fields are in the Q section below.
- **Built so it can be swapped later, not rebuilt:** every AppFolio call this tool makes goes through one internal connector module, not scattered calls in route handlers. Peter's exploring a third-party layer called Skywalk as possible shared infrastructure for future tools — nothing decided yet, no account, no vendor review — but this keeps that door open. v1 still gets its data directly from AppFolio's own API, exactly like `sync.js` does today; nothing about where the data actually comes from changes now. See the Q section below for the details and a deferred (not v1) note about vendor review before anything like Skywalk is ever actually connected.
- **Everything already built and proven in the Hub gets reused, not reinvented:** the login (`lib/auth.js`, `lib/middleware.js`), the `team_members` / `team_member_tool_roles` permission pattern, the `reviewed_by` / `reviewed_at` / `escalated_by` / `escalated_at` / `reviewer_notes` columns pattern from `20260803000002_reviewer_workflow.sql`, the escalation-email approach in `sendEscalationEmail`, and the existing `ANTHROPIC_API_KEY` (already used for insurance document extraction, reused here for B2 folder-name parsing).
- **New environment variables:** `B2_APPLICATION_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_NAME` (read-only key, from Scotty).

---

## Technical Appendix — For Neo, Scotty, Q, Tron, TARS

*(Peter — you don't need to read past this line. Everything below is implementation detail for the people building it.)*

### Neo — schema changes needed

Table and column names below are illustrative, not mandates — Neo makes the final call on shape. What each piece needs to accomplish is not optional. **Update:** items below marked "resolved by Neo's live discovery" reflect real findings from the actual build (schema is done as of this revision), not hypotheses anymore — everything else in this section still reflects pre-build guidance.

One cross-reference before the detail: everywhere below that talks about pulling something from AppFolio (attachments, ledger, lease data), Q's actual code will reach it through a single connector module described in the Q section, not scattered direct API calls. That doesn't change anything about what Neo needs to build here — just how Q's code reaches AppFolio underneath it.

**1. Move-out signal (fixes Gap #2 — confirmed real, not hypothetical)**

Today, four reports (`delinquency`, `tenant_tickler`, `lease_expiration_detail`, `rent_roll`) all write to `leases`, keyed by `appfolio_id` (occupancy_id), in a fixed sequence with `rent_roll` last and explicitly documented as winning on conflict (`sync.js` line 246). Every report's `buildRow()` sets a `notes` field, and Supabase's `Prefer: resolution=merge-duplicates` upsert overwrites `notes` on every run. `tenant_tickler` is the only report that currently captures the move-out reason (`sync.js` lines 154-156), and it gets silently clobbered whenever a later report in the same run writes its own `notes` to the same row.

Needed: dedicated columns — e.g. `leases.move_out_date DATE` and `leases.move_out_reason TEXT` — owned exclusively by `tenant_tickler` going forward, following the same "sync-owned field" convention already documented at the top of `sync.js` and in `20260720000003_foundation.sql` (own it explicitly, never send `null` to clear it, omit the field entirely if a report doesn't have the data). No other report's `buildRow()` should ever touch these two columns.

**2. Multi-tenant leases (fixes Gap #3 — confirmed real with live examples; root cause corrected by Neo's live discovery)**

`leases.tenant_id UUID NOT NULL REFERENCES tenants(id)` (line 128 of the initial schema) only allows one tenant per lease. This is a confirmed real bug, not hypothetical — Neo's live discovery pass against real Rincon data found two examples already collapsed to one tenant (a 3-tenant lease and a 5-tenant lease, both currently showing just one).

**Correction to my original trace:** I had hypothesized the mechanism was the three `leases`-writing reports (`tenant_tickler`, `lease_expiration_detail`, `rent_roll`) each emitting a row per (occupancy, tenant) pair and colliding on the same upsert conflict key (`appfolio_id`), with `resolve_appfolio_foreign_keys()` then resolving `tenant_id` from whichever `appfolio_tenant_id` survived. **Neo's live discovery pass found the actual root cause traces to `tenant_directory` instead** — the three reports I traced weren't the real mechanism. The bug and the fix both hold regardless; only my explanation of *why* was wrong. The corrected mechanism's full detail lives in Neo's migration comments.

The structural fix is unaffected by the corrected root cause: a join table between `leases` and `tenants`, mirroring the existing many-to-many pattern already proven in `team_member_tool_roles` (`supabase/migrations/20260812020000_shared_team_members.sql`, line 175) — its own primary key, a `NOT NULL REFERENCES ... ON DELETE CASCADE` foreign key, and a `UNIQUE` constraint over the pair. `lease_tenants`: `lease_id`, `tenant_id`, enough of the raw AppFolio identifiers to upsert additively instead of overwriting a single column, and its own `UNIQUE(lease_id, tenant_id)`. This tool's assembled package must list every leaseholder, not just one. Confirmed needed: a one-time backfill pull after the fix ships to recover the tenants already dropped from the two known examples above (and any others) — see "What Could Go Wrong" above.

**3. Deposit and charge-type capture (fixes Gap #1 — confirmed missing everywhere today, now resolved with real data)**

Checked all 10 report configs in `sync.js` (lines 55-273) and the full initial schema — no deposit field exists in either place. AB 12 (Cal. Civil Code § 1950.5(c), KB claim `deposit-01`) caps the deposit as an aggregate across every upfront charge functioning as security: security deposit, pet deposit, cleaning deposit, key/fob deposit, and last month's rent collected upfront — not just whatever's labeled "security deposit."

**Resolved by Neo's live discovery pass:** the "two shapes are both reasonable" question below is settled — Rincon's real chart of accounts has no separate pet/cleaning/key-fob deposit accounts, so the deposit itself is a single fixed total field, not a child table. The one real complication AB 12's aggregate cap actually runs into here is Prepaid Rent (last month's rent collected upfront), which AppFolio tracks in a genuinely separate account from Security Deposits — see below.

**Prepaid Rent — flagged by Neo mid-build, resolved by Mason, sent to Q for the build:** a caveat alone wasn't enough, since AB 12's cap is an aggregate that includes prepaid rent even though AppFolio books it separately. v1 pulls the Prepaid Rent balance live, on-demand, per case — not nightly-synced, since this is a `general_ledger` lookup rather than a report row — filtered to account "2300 - Prepaid Rent" and `party_type='Occupancy'`. It shows as its own separate labeled line next to the deposit total (never silently folded into one number), with guidance text for the pod lead to confirm its nature and account for it before finalizing.

Also needed:
- A way to mark when the deposit figure was last pulled, since gap #9 requires the UI to label it plainly as sourced from AppFolio's ledger, not an independently verified trust-account balance (see Compliance Grounding below).

**4. Disposition case tracking (new)**

One row per lease/move-out being tracked through this tool — e.g. `security_deposit_cases`: `lease_id`, `move_out_date` (copied at creation time, or joined live), the computed 21-day deadline, a status field, and the reviewer-workflow columns already proven in `20260803000002_reviewer_workflow.sql` (`reviewed_by`, `reviewed_at`, `escalated_by`, `escalated_at`, `reviewer_notes`) — reused here rather than reinvented.

Also needed: an explicit field distinguishing a full tenancy ending from a partial co-tenant move-out (one leaseholder leaving while the lease and other leaseholders continue) — e.g. `tenancy_status`. This matters because the 21-day clock and pre-move-out inspection rights attach to the tenancy actually ending, not to any one person leaving (Mason's finding). Auto-suggest a value where the sync data supports it (e.g. whether the lease itself terminates vs. one tenant on a multi-tenant lease shows a move-out while the lease stays active), but treat it the same way as the checklist fields below — pod-lead-confirmable, never silently trusted, since getting this wrong has real legal consequences.

Plus the reviewer checklist fields from Gap #7 — final wording is in Compliance Grounding below (Mason finalized it 2026-08-13; no longer a draft). If Tron builds the preferred two-row version of the first question (see Compliance Grounding), that's two separate stored fields — notice sent, inspection conducted — not one, so plan for three checklist fields total, not two. All of them must be nullable/unanswered until a pod lead actively sets them; nothing in this tool infers them automatically.

Missing-evidence flags (Gap #8) are better computed at read time from whatever the assembly step actually found (photos, ledger, forms) than stored as a separate persisted fact — "missing" is a derived state, not new information to keep in sync.

**Inspection form uploads (new — Peter's decision, see Open Item #7):** inspection forms are now a manual upload by the pod lead rather than an automatic AppFolio pull, so this tool needs somewhere to store the uploaded files and link them to a case, distinguishing move-in from move-out. Worth checking first whether the existing `documents` table (already used by Insurance Compliance — `file_name`, `file_path`, `file_type`, `entity_type`, `entity_id`, `mime_type`, per `insurance/router.js`'s `POST /api/insurance/upload`) can just be reused here with `entity_type = 'security_deposit_case'` and `entity_id` = the case's ID, rather than building a new table — same reuse-what-exists approach the rest of this spec follows. `file_type` could distinguish move-in vs. move-out (e.g. `'inspection_form_move_in'` / `'inspection_form_move_out'`), the same way insurance-compliance already uses `file_type = 'insurance_certificate'`. This is a recommendation, not a decision — confirm with Neo before building, same as every other schema item in this section.

**5. B2 photo index (new — supports the brief's recommended parsing approach)**

The original brief recommends an AI-assisted parse of B2 folder names into structured fields (address, unit, inspection type, date) with a confidence signal, auto-indexing high-confidence parses and routing ambiguous ones to a manual-review list. That implies a persisted, queryable index — not a live re-parse of the whole bucket on every case load, which would be slow and would re-spend AI-parsing cost on folders that haven't changed. Needed: a table (e.g. `b2_photo_folders`) holding the parsed fields, confidence score, and a review status, built by a periodic indexing job (nightly or weekly, incremental — only new/changed folders since last run) rather than a one-time script. The per-case assembly step then queries this index (matching by normalized address + nearest-date, per the brief's open question on address normalization) instead of touching B2 directly on every request.

**Hard requirement, not a nice-to-have (Asimov):** the folder-name parser sends Claude only the folder path/name string — never photo bytes, never the photo files themselves. Asimov drew a hard line here: "AI reads a filename" and "AI reads a photo of someone's apartment" are materially different privacy exposures, and this tool only ever needs the first one. Q must not build a version that fetches photo bytes for parsing, even as an accuracy improvement, without a separate privacy review first.

**Also required (Asimov, GOVERNANCE.md Rule 5):** the confidence threshold that decides auto-index vs. route-to-manual-review must be a stored, versioned config value — never a hardcoded number in code, same principle GOVERNANCE.md already applies to any criteria affecting what a person sees. Per Rule 6, changing this threshold later is a "Standard" change requiring Peter's approval, not something a specialist adjusts unilaterally.

**6. Permission table extension**

`team_member_tool_roles.tool` is currently `CHECK (tool IN ('insurance_compliance'))` — needs `'security_deposit'` added, using the same DROP-then-ADD CONSTRAINT pattern already proven in `20260803000002_reviewer_workflow.sql`. The `role` CHECK is shared across all tools (role↔tool pairing is enforced by the `UNIQUE(team_member_id, tool)` constraint, not by the CHECK), so `'admin'` and `'director_of_operations'` can both be reused as-is for this tool — the latter now needed for the escalate flow (see Q's route sketch). Recommend adding one new role value, `'pod_lead'`, for the primary reviewer role — that's the only genuinely new value needed.

**7. Jurisdiction field (confirmed needed, not theoretical — Neo's live discovery)**

Mason flagged that Rincon's portfolio is described broadly as "Southern California," but the compliance KB is scoped specifically to Ventura County for anything beyond the two statewide deposit statutes — county-level rent control and just-cause notice periods would misfire if silently applied outside Ventura County. **This is no longer a hypothetical:** Neo's live discovery pass found `property_directory` already returns county data for free (no extra API call or new report needed), and confirmed 2 of Rincon's 381 synced properties are actually in Los Angeles County, not Ventura. The deposit statutes this v1 actually reads (`deposit-01`, `deposit-03`, `deposit-04`, `deposit-05`) are all statewide, so nothing in v1's own logic is wrong for those 2 properties today — but this is now a confirmed fact about Rincon's real portfolio, not an edge case being guarded against speculatively. Add the county/city field now — most naturally on `properties`, since jurisdiction is a property fact, not a per-lease one, and since `property_directory` already carries the data, this is a near-zero-cost addition to the existing sync rather than a new lookup.

**8. Data inventory and RLS — required for all three new tables (Asimov, GOVERNANCE.md Rule 4)**

`security_deposit_cases`, `b2_photo_folders`, and `lease_tenants` all store personal data (tenant identity, lease association, and — for `b2_photo_folders` — parsed address/date data tied to a specific tenancy). Per GOVERNANCE.md Rule 4, each one's migration needs a header-comment data inventory documenting: `pii_fields`, `agents_with_access`, `privacy_category`, `retention_policy` (a placeholder is fine for now — the real value needs Mason, already effectively gated on him via the open `deposit-03` citation item below), `ccpa_exportable`, `ccpa_deletable`. `audit_log`'s CCPA note (`20260720000003_foundation.sql`, around line 310) is the closest existing example of this kind of documentation living in a migration file, but the exact structured field names come from Rule 4 itself, not from that file — use Rule 4's field list, don't just copy that file's prose. All three tables also need `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` with no permissive policies, matching every other table in this schema.

### Scotty

- Set up a **read-only** Backblaze B2 application key, scoped to the one bucket this tool needs to read. This tool never writes or deletes a photo.
- New env vars: `B2_APPLICATION_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_NAME`.

### Q — route sketch (illustrative, final naming is your call)

Follows `insurance/router.js`'s exact shape — a `router` (everything behind Hub login) and an `internalRouter` (cron-only, shared-secret header, mounted before `requireLogin`):

```
GET   /security-deposit                                  dashboard page
GET   /api/security-deposit/auth/me
GET   /api/security-deposit/cases                        queue, sorted by days remaining
GET   /api/security-deposit/cases/:id                     full assembled package
POST  /api/security-deposit/cases                          manual/backfill creation (fallback — see below)
POST  /api/security-deposit/cases/:id/checklist            pod lead saves the checklist answers (2 or 3 fields — see Neo section #4)
POST  /api/security-deposit/cases/:id/inspection-form       pod lead uploads a move-in or move-out inspection form PDF
POST  /api/security-deposit/cases/:id/review               pod lead marks reviewed
POST  /api/security-deposit/cases/:id/escalate              pod lead escalates a case to director_of_operations
POST  /api/security-deposit/cases/:id/escalate-confirm       director_of_operations confirms/resolves an escalated case
GET   /api/security-deposit/photo-review-queue              low-confidence B2 folder matches
POST  /api/security-deposit/photo-review-queue/:id/resolve
GET/POST/PATCH/DELETE /api/security-deposit/users           role management — mirrors insurance's admin endpoints exactly

internalRouter (cron, own shared secret, same pattern as insuranceInternalRouter):
POST  /api/security-deposit/internal/create-cases-from-sync   nightly, after AppFolio sync
POST  /api/security-deposit/internal/send-reminders            nightly, day 7/14/18 checks
POST  /api/security-deposit/internal/index-b2-photos           periodic, incremental
```

**Manual/backfill case creation** is a deliberate fallback, not a contradiction of "automatic, not manual" — it exists for edge cases the automatic signal might miss (a move-out that predates this tool, a correction, a move-out that doesn't flow cleanly through `tenant_tickler`). The automatic nightly trigger is the primary path; this is a safety valve so a gap in the AppFolio signal doesn't leave a disposition permanently unassembled.

**Reminder recipients:** query `team_member_tool_roles` for `tool='security_deposit' AND role='pod_lead'` and email every active holder — same pattern `check-new-properties` already uses for inspection coordinators in `insurance/router.js`. No pod-based routing in v1 (see Deferred, below) — everyone with the `pod_lead` role gets every reminder until Phase 2 narrows it.

**Design call, confirmed by Peter ("agree") — see Open Item #3:** reminders fire on the day 7/14/18 schedule regardless of whether the case has already been reviewed in-tool. The tool has no reliable way to know whether the actual deposit return was mailed — that step is entirely manual and outside this tool — so the conservative default (keep warning) wins over the convenient one (stop warning once reviewed). A future phase could add an explicit "sent to tenant" confirmation to stop reminders early, but v1 deliberately doesn't build a silent assumption that "reviewed in-tool" means "handled" when the tool can't actually verify that.

**Escalate flow (added late — Peter confirmed this belongs in v1 after all; the `reviewer_workflow` columns were already reused from Insurance Compliance for this, but the route sketch originally never actually included the endpoint — an oversight in the brief, not a design change):** a pod lead can manually escalate a case to whoever holds `director_of_operations` for `tool='security_deposit'` — a deliberate human action, not something the tool triggers automatically, since unlike Insurance Compliance, v1 has no AI-suggested status to trigger off of (there's no AI judgment on deductions in this build at all). Mirrors `insurance/router.js`'s `approve`/`escalate-confirm` shape: `POST .../escalate` moves the case to an escalated state, records `escalated_by`/`escalated_at`, and emails the DO (reusing the `sendEscalationEmail` pattern already used elsewhere in this tool); `POST .../escalate-confirm`, restricted to `director_of_operations`/`admin`, records `reviewed_by`/`reviewed_at`/`reviewer_notes` once they've weighed in. Both reuse the exact `reviewer_workflow` columns (`20260803000002_reviewer_workflow.sql`) already planned for `security_deposit_cases`.

**Audit logging (Asimov, hard requirement — and a real gap in the precedent this spec otherwise follows):** `insurance/router.js`'s approve/reject/escalate-confirm routes update `property_insurance` directly but never write an `audit_log` row for the human's decision — only `POST /api/insurance/save`'s initial extraction writes one. Don't copy that gap here. This tool needs its own `audit_log` entries for:
- Every AI folder-name parse: `details = { raw_folder_name, parsed_address, parsed_unit, parsed_date, confidence_score, model_version }`.
- Every manual resolution of a low-confidence photo-folder match — who resolved it, what they changed it to.
- Every checklist answer, case-review submission, and escalate/escalate-confirm action — who did what, when.

### Q — AppFolio connector (built swappable, not actually swapped)

Peter is considering Skywalk — a third-party API layer over AppFolio — as shared infrastructure for multiple future tools, this one included. Nothing about that is decided: no Skywalk account, no credentials, no vendor review has happened. This is a "leave the door open" design requirement for v1, not an integration to build now.

**What this means for the build:** every place this tool needs AppFolio data — the tenant ledger/deposit figures and lease details — goes through one internal connector module with a plain interface, not direct AppFolio calls scattered across route handlers. Illustrative shape (Q's call on exact signatures):
```
getTenantLedger(tenantId)
getLeaseDetails(occupancyId)
getPrepaidRentBalance(occupancyId)  // general_ledger lookup, account "2300 - Prepaid Rent" — see Neo section #3
getLeaseAttachments(occupancyId)   // v1: likely returns "not available" — see below
```
**v1's actual implementation behind `getTenantLedger`, `getLeaseDetails`, and `getPrepaidRentBalance` calls AppFolio's native API directly** — Basic Auth against `rinconpm.appfolio.com`, the same pattern `sync.js` already uses. `getLeaseAttachments` stays in the interface for shape-consistency, but v1 doesn't depend on it working: Peter decided inspection forms are a manual upload by the pod lead for v1 (see "What Q Needs to Build This" and Neo section #4), not something this tool retrieves automatically — the UI's upload path is what actually carries v1, not a fallback for when this connector method fails. If `getLeaseAttachments` ever becomes real — native AppFolio API, Skywalk, or otherwise — swapping it in later is a straightforward upgrade behind this same interface, not a rebuild; nothing about the manual-upload decision creates rework. Nothing about where v1's ledger/lease data actually comes from changes. The only thing this buys: routes, Tron's screens, and the assembly logic only ever talk to the connector's interface, never to AppFolio specifics directly, so a second implementation — Skywalk-backed or otherwise — can drop in later without touching the rest of the tool.

**Where it lives — my call, since I was asked to make one rather than default to "shared":** scoped to this tool (e.g. `projects/hub/security-deposit/lib/appfolio-connector.js`), not a new shared Hub-wide module. Reasoning: I checked, and today `sync.js` is the *only* place in this codebase that calls AppFolio's API directly — insurance-compliance reads from Supabase (already synced) and rental-analysis reads from RentCast, neither touches AppFolio directly. There is no second live consumer that would benefit from a shared connector right now, and `sync.js` is a nightly batch job (pull everything, once a night) — a fundamentally different access pattern from this tool's need (pull one case's data, on demand). Forcing both into one shared shape today would mean guessing at a cross-pattern interface before a second real use case exists to validate it against. If a second tool genuinely needs the same interface later, extracting this module to `projects/hub/lib/` at that point is a small, low-risk move — the interface design is what makes a later swap easy, not its folder location today.

**Deferred, explicitly not a v1 requirement:** before Skywalk (or any second AppFolio data source) is ever actually wired into this connector for real, Sentinel needs to review it as a new vendor with access to tenant data, and Rincon should request the narrowest access role Skywalk offers rather than its default broad one. Noting this now so the gate isn't skipped whenever that conversation actually happens — it does not block or affect v1 in any way, since v1 only ever calls AppFolio's own native API.

### Tron

- Same visual and interaction language as the Insurance Compliance dashboard (`projects/hub/insurance/dashboard/index.html`) — tab bar, table-driven queue, a detail view per record, plain fetch() calls to the API above.
- The days-remaining indicator needs to be the single most visually prominent thing on both the queue and detail views — this is the one number with real legal consequences if it's missed.
- Missing-evidence flags need to read as warnings (not passing checkmarks) even when a case is otherwise "ready."
- Inspection form upload is a plain file-attach control on the case screen (PDF or image, move-in and move-out separately) — not a new UI pattern, just an upload button. Before upload, "no inspection form uploaded yet" is exactly the same kind of missing-evidence flag already used for missing photos or a missing deposit amount — no new UI concept needed here.
- The deposit figure must carry a visible, plain-language label that it comes from AppFolio's ledger and hasn't been independently verified against a trust account balance (see Compliance Grounding below) — not a footnote, something a pod lead actually sees while looking at the number.
- If move-in/move-out photos or inspection forms show tenant-made accessibility modifications (grab bars, ramps, and similar), the tool must not caption or flag those as "damage" or a deduction candidate by default — a tenant generally can't be charged to restore a disability-related modification they were entitled to make (Mason's finding).
- The AI's confidence score for each matched photo folder must stay visible on the case screen, not just used internally to decide auto-index vs. manual-review and then discarded — a pod lead needs to be able to notice and challenge a wrong high-confidence match, not just trust it silently (Asimov's finding).

### TARS

- Test the 21-day countdown specifically: correct across a daylight-saving transition, correct across a month/year boundary, and always computed from the real `move_out_date` — never from the date a case was created or the date the sync ran.
- Test the multi-tenant fix against a real lease Peter confirms has more than one tenant — confirm every leaseholder shows up, not just one.
- Test the missing-evidence flags actually fire — e.g. a case with no matched move-in photos should visibly say so, not silently show an empty gallery.
- Confirm nothing in this tool has any code path that sends anything to a tenant, under any input.

---

## Compliance Grounding

From `compliance/ventura-county-compliance-kb.json`, already reviewed by Mason on 2026-07-09 (`_meta.review_log`). Mason's sign-off was conditional on one thing: the human-review gate before anything reaches a tenant or owner has to stay fully intact. This tool's assembly-only, human-reviews-everything design is exactly that gate, preserved.

| Claim | What it requires | Confidence | Where it shows up in this tool |
|---|---|---|---|
| `deposit-01` | AB 12: deposit cap is an aggregate across security deposit, pet deposit, cleaning deposit, key/fob deposit, and last month's rent collected upfront | HIGH | **Resolved:** Rincon's real chart of accounts has no separate pet/cleaning/key-fob deposit accounts, so the deposit is one fixed total field. The one real aggregate-cap complication is Prepaid Rent (last month's rent collected upfront), tracked in a genuinely separate AppFolio account — v1 pulls it live per case and shows it as its own labeled line next to the deposit total, with guidance for the pod lead to confirm its nature before finalizing (see Neo section #3) |
| `deposit-03` | 21 calendar days to return the deposit or send an itemized, documented statement — missing it forfeits the right to withhold anything, even legitimate deductions | HIGH | Drives the automatic clock start and escalating reminders (Gap #6) |
| `deposit-04` | Tenant has a right to request a pre-move-out inspection, occurring in the final two weeks of tenancy | HIGH | Reviewer checklist field #1 (Gap #7) |
| `deposit-05` | Since April 1, 2025, landlords must photograph the unit before repairs/cleaning and again after, for any deduction claimed | HIGH — Civil Code § 1950.5(g)(2), via AB 2801 (2024); upgraded from MEDIUM after Mason's direct statute confirmation (2026-08-13) | Reviewer checklist field #2 (Gap #7) |
| `trust-01` through `trust-04` | Security deposits are trust funds with their own deposit-timing, commingling, and monthly-reconciliation rules, separate from this tool | HIGH | Drives the "label the source, don't imply independent verification" requirement (Gap #9) |

**Flagged, not yet fixed:** the same AB 2801 renumbering that moved the photo-documentation requirement into § 1950.5(g)(2) may have also shifted `deposit-03`'s existing citation ("§ 1950.5(g)-(l)") off by one letter. Mason flagged this as unverified, not blocking — the substance of `deposit-03` (the 21-day deadline and itemized-statement requirement) isn't in question, just the exact subsection letters. Treat the citation as open until Mason confirms the correct range.

**Reviewer checklist wording (Mason-finalized 2026-08-13):**
1. Preferred — two separate questions, since Rincon's own duty to notify the tenant and the tenant's separate choice to request an inspection are two different legal obligations, not one:
   - "Did Rincon send the tenant written notice of their right to request a pre-move-out inspection?"
   - "If the tenant requested a pre-move-out inspection, was it conducted before move-out (generally within the final two weeks of the tenancy), and was the tenant given a written list of items to fix before the final move-out inspection?"

   Fallback, if the review screen can only fit one row: "Did Rincon notify the tenant of the right to request a pre-move-out inspection, and — if requested — was it conducted before move-out (generally within the final two weeks of tenancy)?"
2. "For each deduction that involves repair or cleaning work: do photos exist from (a) after the tenant moved out but before that work began, and (b) after the work was completed?" Doesn't apply to deductions with no repair/cleaning component (e.g. unpaid rent) — the checklist shouldn't read as if every deduction needs before/after photos.

## Governance Path for This Build

Asimov confirmed this build gets the lighter compliance-build treatment from GOVERNANCE.md, not the full runtime-agent lifecycle (spec → AI Risk Assessment → 30/90-day shadow mode, GOVERNANCE.md Rule 7) — because nothing in this tool acts autonomously on a person. The one consequential action here (actually issuing the disposition) is entirely and permanently excluded from what this tool does, by design, not by a permission tier that could later be loosened. Worth stating plainly so this doesn't get re-litigated later.

That said, the full Mandatory PR Checklist Table (GOVERNANCE.md) still applies at PR time, same as any build touching personal data: Neo, Q, TARS, Ralph (for the new B2 integration), Viper (for the new PII surface this tool creates), Sentinel (for the new B2 credential), Mason, Judge, and Asimov again at final review. This is a scope clarification, not a new requirement — noted here so nobody assumes "lighter treatment" means "fewer gates."

---

## Scope

**In v1:** everything in "How It Works" above — automatic case creation, multi-tenant-aware assembly, deposit/charge display, B2 photo matching with a manual-review fallback for low-confidence matches, manual inspection-form upload by the pod lead, the two human-answered checklist fields, missing-evidence flagging, the 21-day countdown, and escalating reminders. Also in v1: a manual escalate-to-`director_of_operations` flow, added late at Peter's confirmation — a pod lead's own judgment call to loop in a DO, not something the tool triggers automatically (v1 has no AI judgment on deductions to trigger off of, unlike Insurance Compliance's escalation flow) — see the Q section's escalate flow. Nothing in v1 is gated on AppFolio's attachment-retrieval capability anymore — see Open Item #7.

**Explicitly out of v1 (unchanged from the original brief):** AI judgment on which deductions are legally defensible; drafting the itemized deduction statement or any tenant-facing letter; sending anything to a tenant automatically, under any circumstance.

**Deferred — do not let these block v1:**
- Pairing move-in/move-out photos by room or area for easier side-by-side comparison.
- Routing each disposition to the specific pod lead who owns that property (using `properties.pod` and the same `byPod` grouping logic already in `insurance/router.js`'s `sendPMQueueEmail`), instead of every `pod_lead`-role holder seeing every case in v1. Peter confirmed the v1 default (every `pod_lead` holder sees every case) is fine to start with — see Open Item #2.
- Automatically retrieving inspection forms from AppFolio instead of the pod lead uploading them manually — a nice-to-have if AppFolio's API (or Skywalk, or another connector) ever supports attachment retrieval; see the Q section's AppFolio connector for how this drops in later without a rebuild. Not scheduled, not blocking, not needed for v1 to be useful.

## Open Items — Flagged for Jarvis and Peter

1. **The original brief's "Relationship to existing systems" section says this tool reuses the content engine's review-queue pattern. That's now stale and contradicts a standing rule.** Peter's hub-consolidation decision (confirmed 2026-08-12) explicitly excludes `content-engine`/`content-review` from the hub and says not to even use them as a pattern to copy — "stated twice." This spec follows Jarvis's own (correct, current) instruction instead: the Insurance Compliance review-queue pattern (`pending_review`/`escalated` statuses, approve/reject/escalate-confirm) is the real reference, not content-engine. Flagging this so the stale brief text doesn't confuse anyone who reads the original file later.
2. **RESOLVED — Peter confirmed "fine."** V1 reminder/notification recipients default to everyone holding the `pod_lead` role in this tool, not per-property pod routing — accepted as the v1 starting point (mirrors "one person owning all of them," the deferred item's stated status quo). Per-property pod routing stays a Phase 2 item (see Deferred, in Scope above).
3. **RESOLVED — Peter confirmed "agree."** Reminders keep firing on the day 7/14/18 schedule regardless of in-tool review status (see Q section above) — the conservative default holds, since the tool still has no reliable way to verify the actual deposit-return letter was mailed.
4. **RESOLVED — Mason's parallel review (2026-08-13).** Verdict was FLAGGED, now incorporated directly into the sections above: reworded both reviewer checklist items (Compliance Grounding), pointed Neo at the existing `team_member_tool_roles` many-to-many pattern for the leases↔tenants fix instead of a generic join table (Neo section #2), added the full-tenancy-ending vs. partial-co-tenant-move-out field (Neo section #4, What You'll See), added a jurisdiction field (Neo section #7), and added the disability-modification caution (Tron section). On the two originally-pending questions specifically: reusing the compliance KB in this tool is **cleared** — no gaps found beyond what's already in the file; the reviewer checklist wording is **finalized**, not draft (see Compliance Grounding).
5. **NEW — `deposit-03`'s citation may be outdated, unverified, not yet fixed.** The same AB 2801 renumbering that resolved `deposit-05` may have also shifted `deposit-03`'s "§ 1950.5(g)-(l)" citation off by one letter. The 21-day deadline requirement itself isn't in question — just the exact subsection letters. Flagged for Mason to confirm.
6. **RESOLVED (conditionally) — Asimov's governance pre-check (2026-08-13).** Verdict: FLAGGED, not blocked — additive changes, no redesign needed. Conditions: the data inventory (Neo section #8), the photo-bytes-only restriction on the folder-name parser (Neo section #5), the versioned confidence threshold (Neo section #5), the visible confidence score (Tron section), and the dedicated audit log entries (Q section) all had to be written into Neo's and Q's build instructions before this clears for Q to build. All five are now in this spec as of this revision. Asimov also confirmed this build gets the lighter compliance-build treatment, not the full runtime-agent lifecycle (see "Governance Path for This Build" above), and flagged that this tool cannot fulfill CCPA deletion of the underlying B2 photos, only its own index (see "Known Limitation" above). Marked *conditionally* resolved because Asimov reviewed the conditions, not this exact revised text — a final confirmation pass at PR time (per the Mandatory PR Checklist Table) is still expected, same as any gate.
7. **RESOLVED — Peter's decision: manual upload for v1, not automatic retrieval.** Rather than wait on AppFolio's attachment-retrieval question, the pod lead downloads the inspection form from AppFolio themselves (already possible today, just not programmatically) and uploads it into this tool — the same "human does what software can't" pattern already used for the checklist questions. This fully resolves the item: v1 includes inspection forms in the assembled package, just via upload instead of automatic pull, and nothing in this build waits on an answer from AppFolio anymore. Automatic retrieval (native API, Skywalk, or otherwise) stays available as a future upgrade behind the same connector interface (see the Q section's AppFolio connector) — deferred, not blocking, and creates no rework if it happens later. (The deposit/charge-type ledger discovery pass is separate and unaffected — that's regular report data, not document attachments.)
8. **NEW — deferred, not blocking v1: before any second AppFolio data source (e.g. Skywalk) is ever wired into the connector for real, it needs a Sentinel vendor review** (a new third party would gain access to tenant data) **and Rincon should request the narrowest access role that source offers, not its default broad one.** Nothing about this is scheduled or decided today — v1 only ever talks to AppFolio's own native API, same as `sync.js` does now. Noting this now, per Jarvis, so the gate isn't skipped whenever that conversation actually happens.
9. **NEW — informational, not a v1 blocker: Rincon's portfolio isn't entirely within Ventura County.** Neo's live discovery pass confirmed 2 of 381 synced properties are in Los Angeles County. v1's compliance logic only uses statewide statutes (see Compliance Grounding), so nothing is wrong today, but Peter should know his portfolio already has real, confirmed out-of-Ventura-County properties — worth keeping in mind if/when a later phase pulls in county-specific compliance content. Neo section #7's jurisdiction field was added specifically so this doesn't need a schema retrofit when that day comes.
