# Shared Inbox Email Feature — What Wraps Around the Filter (v1 Build Spec)

**Status:** Draft — awaiting Peter's approval before Neo/Q start building. Not a build yet. Nothing in this document connects to a real inbox or credential, and none should be added while this is still a draft.
**Written by:** Oracle
**Date:** 2026-08-16
**Origin:** The privilege/legal-hold and Fair Housing content filter (`projects/hub/email-intake/lib/`) cleared legal review (`compliance/shared-inbox-legal-checklist.md` — all six items resolved 2026-08-16) and is done, tested, and inert. Asimov's governance check-in on the same day found three real gaps standing between that filter and a live inbox: no decision about whether an email is even worth running through the filter in the first place (a data-minimization problem, not just a missing feature), no place to put what comes out the other side, and no formal risk assessment. This spec closes the first two gaps. The third — the risk assessment, plus what a mandatory 90-day shadow period means in practice — is `compliance/shared-inbox-risk-assessment.md`, a companion document to this one.
**Governance:** Directly answers Asimov's 2026-08-16 check-in. Nothing in this document authorizes a build — Neo/Q start only after Peter approves, and this specific feature does not go live (even after building) until the shadow period in the risk-assessment document runs its course and Asimov signs off, per GOVERNANCE.md Rule 7.

**Built from:**
- `projects/hub/email-intake/lib/index.js`, `privilege-filter.js`, `fair-housing-filter.js`, `privilege-keywords.js`, `government-legal-domains.js` — read in full. This spec builds a new pipeline stage in front of this filter and a new stage after it; it does not modify any of these five files.
- `compliance/shared-inbox-legal-checklist.md` — the closed legal record; sets the exact content boundary (which threads get held vs. tagged vs. processed) this spec inherits rather than re-litigates.
- `projects/hub/maintenance-history/SPEC.md`, `property-overview-SPEC.md`, and `supabase/migrations/20260815010000_maintenance_history_schema.sql` — the precedent for both the data-inventory pattern and the "claims with source + confidence, human review gate" discipline. Also read the actual built code this spec's size estimate is grounded against: `lib/content-check.js`, `lib/protected-class-terms.js`, `lib/extract-claims.js`, `lib/latchel-connector.js`, `router.js`.
- `supabase/migrations/20260626000000_initial_schema.sql` (`properties`, `maintenance_requests` real columns), `20260720000003_foundation.sql` (`audit_log`, `vendors` real columns), `20260815000000_audit_log_rule1_compliance.sql` (`audit_log`'s current Rule 1 fields), `20260812020000_shared_team_members.sql` (`team_member_tool_roles`).
- `projects/hub/lib/property-search.js` — the existing hub-wide property search. Read closely because it looked reusable and turned out not to be directly: it matches a *typed query against properties*; this spec needs the reverse — *scanning email text for a property match* — so it's the same underlying data and matching convention, not the same function call. See "Signal 1" below.
- GOVERNANCE.md (Rules 4, 6, 7, 9, 10).

**Where this lives:** A new Hub section, `projects/hub/email-intake/`, mounted into `projects/hub/server.js` the same way Insurance Compliance, Security Deposit, and Maintenance History are — one router file, reusing the Hub's existing login. No new sign-in screen, no new standalone project. It is a sibling to Maintenance History, not a tab inside it — the shared inbox touches broader correspondence than any one ticket, and Asimov's gaps are specifically about the inbox-wide relevance decision.

---

## What This Does

Today, if this were connected to a real shared inbox, the existing filter would faithfully sort every single email — HR correspondence, personal matters, unrelated leasing chatter, actual maintenance threads, all of it — into held/tagged/clear. That's the wrong amount of touching: the filter's job is to protect against legal and Fair Housing risk in maintenance-relevant correspondence, not to read everything that happens to land in a shared mailbox. This build adds two things around that filter: a first pass that decides whether an email is even about maintenance before anything else touches it, and a place to put the maintenance-relevant threads that make it through — so staff can search "what has this tenant said about this issue" the same way they can already look up a ticket in Maintenance History.

It does not extract facts, summarize, or make any decision about anyone. It is a narrower, staff-facing search/context tool: read the matched correspondence, see it linked to the right property or ticket, done. The moment this grows into auto-summarizing into an owner report or auto-drafting a reply, it becomes a different, higher-risk build that needs its own fresh review — see the risk assessment's scope boundary.

## How It Works

1. **Stage 0 — Relevance.** Before anything else happens, every email thread is checked for two signals: does it mention a real Rincon property, and does it use maintenance-specific language (leak, repair, vendor, work order, and similar — a separate list from the filter's own legal-hold keywords). A thread with neither signal is set aside, untouched, nothing extracted or stored about it beyond the fact that a decision was made. A thread with either signal continues to Stage 1. This stage is rule-based (keyword and property-name matching), not AI — see "The Relevance Classifier" below for why, and for how it avoids silently losing something it shouldn't.
2. **Stage 1 — Privilege and Fair Housing (the existing filter, unchanged).** Every thread that passed Stage 0 runs through `lib/index.js`'s `processThread()` exactly as already built and tested. A thread the filter holds (Tier 2 — law firm, subpoena, demand letter, active Fair Housing complaint) stops here. Nothing about it is stored in the new table this spec adds — a held thread is pulled for a person, same as the filter already guarantees, and that guarantee doesn't get diluted by a second table quietly holding a copy.
3. **Stage 2 — Store.** A thread that passed Stage 0 and cleared Stage 1 (not held) gets one row written to a new table, linked to the property and, where a specific ticket can be identified, the maintenance request. Fair Housing–flagged content is stored (never silently dropped, matching the existing filter's own principle) but structurally excluded from any list a person browses in the normal course of work — same wall-off pattern Maintenance History already uses for protected-class content.
4. **Stage 3 — Search.** A staff member opens a property or a maintenance ticket in the Hub and sees a "Related Correspondence" section listing matched threads — subject, date, who was on it, and the thread text itself — with a link back to the original in Missive.

## What You'll See

- A new **"Email Context"** section in the Hub, next to Insurance Compliance, Security Deposit, and Maintenance History. Same login.
- On a property or maintenance ticket page, a **"Related Correspondence"** list — matched email threads relevant to that property/ticket, most recent first, each showing subject, date range, participants, and the thread content, with a "view in Missive" link back to the source.
- Threads the filter tagged (Tier 1 — routine code-compliance language, self-reported small claims mentions) show a small tag badge, same visual language as the underlying filter already defines.
- Threads touching a protected-class-adjacent topic (health, disability, and similar) never appear in the normal correspondence list — a separate, admin/reviewer-only "Needs privacy review" view shows them instead, same pattern as Maintenance History's existing privacy queue.
- Nothing here ever creates, edits, sends, or replies to anything in Missive. It only ever reads and displays.
- During the mandatory shadow period (see risk assessment), nothing from this tool is used to make or influence anything — it's a human-reviewed pilot, not live for normal staff use yet. What "live" looks like after that is covered there too.

## What Could Go Wrong

- **A thread gets matched to the wrong property or ticket.** Property-level matching (address/name against `properties`) is fairly reliable; ticket-level matching (a specific `maintenance_requests` row) has no clean deterministic key the way Latchel's `order_number` did for Maintenance History — there's no natural ID an email carries that maps to a ticket. This build treats ticket-level matching as best-effort with a confidence score and expects it to be wrong sometimes; property-level matching is the reliable fallback. See "Storage Design" below.
- **The relevance classifier misses a real maintenance email because it doesn't use any listed keyword and doesn't name a matchable address** (e.g., a tenant writes "the thing in the kitchen is still broken" with no address, replying deep in an old thread). This is the actual reason Asimov wants a 90-day shadow period instead of a shorter one — see the risk assessment for exactly what gets checked and how often.
- **The classifier over-includes** — an HR email that happens to mention "the office AC" gets pulled in. Low-stakes compared to the miss above (it costs one unnecessary row a reviewer can dismiss), but real, and one more reason storage defaults to reviewer/admin-only access rather than broad staff visibility on day one.

---

## The Relevance Classifier (Asimov's Gap 1)

**Recommendation: rule-based only — keyword and property-name matching, no AI judgment layer, for this stage specifically.** This is a real recommendation, not a placeholder; the reasoning:

1. **This stage runs on every email in the shared inbox, before anything else has looked at it.** Sending unfiltered inbox content — which includes HR correspondence and personal matters by the scenario's own description — to an AI model as the very first processing step reproduces the exact problem Asimov flagged (touching more than the job requires), just moved from the privilege filter to a classifier. A rule-based scan touches nothing beyond pattern-matching against text already in memory — no external call, no new agent access surface, no new thing with "access to everything in the inbox" to have to govern.
2. **The privilege/Fair Housing filter already earns its two-layer design (domain + keyword, with room for judgment) because legal-exposure classification is genuinely hard and the cost of getting it wrong is severe.** "Does this email mention one of our properties or use maintenance language" is a much easier, lower-stakes classification problem, and this codebase already has two working precedents for handling exactly that kind of problem with a maintained keyword list and nothing more (`protected-class-terms.js`, `government-legal-domains.js`) — versus exactly one precedent for needing AI judgment on top (`extract-claims.js`), and that one only ever runs on content already known to be maintenance-relevant and already matched to a specific ticket, never as a first-pass filter over an entire inbox.
3. **Cost and latency scale with inbox volume, not with what's actually relevant.** A shared mailbox sees HR, leasing, vendor, and personal traffic; running all of it through an LLM call before knowing whether it's even in scope adds a real AI processing step and cost line to content that, most of the time, has nothing to do with this tool.
4. **If shadow mode shows the rule-based classifier's recall is inadequate in practice** — real maintenance threads getting missed because they don't match any listed term or address — that's the trigger to add a second, judgment-based layer specifically for relevance, the same way the privilege filter's own two-layer design came from a real, specific gap. Not built in ahead of a proven need.

### Signals

**Signal 1 — property/address match.** Scan the thread's subject and body for a match against real Rincon property `name`/`address`/`city` (from the `properties` table). Not a reuse of `property-search.js`'s live endpoint (that function goes query → properties; this needs the reverse, email text → properties) but the same underlying data. Recommended implementation: pull `id, name, address, city, zip` for all properties into memory on a periodic refresh (properties change rarely — same reasoning `latchel-connector.js`'s reconciliation step already uses — every 15–30 minutes is plenty, not a live query per email) and match address components against the thread text. A hit here is strong, close to deterministic evidence.

**Signal 2 — maintenance keyword match.** A new, separate maintained list (`lib/maintenance-keywords.js`, not touching `privilege-keywords.js`) — leak, broken, not working, repair, maintenance, work order, vendor, plumber, electrician, HVAC, AC, heater, furnace, appliance, water heater, pest, mold, mildew, smoke detector, garage door, roof, gutter, sprinkler, inspection, technician, service request, and similar. Same "err toward flagging" design bias already used for `protected-class-terms.js` and `government-legal-domains.js` — a false positive here costs one reviewer glance; a false negative is the failure mode that matters.

**Signal 3 (weaker, corroborating only) — known vendor sender/recipient.** `vendors.email` is a real, populated field. A thread involving a known vendor address is corroborating evidence, not sufficient on its own (vendors also send insurance certs, invoices unrelated to a specific issue, etc.) — used only to nudge borderline cases, never as a standalone trigger.

### Decision

- **Signal 1 OR Signal 2 hits → RELEVANT.** Passes to Stage 1 (the existing filter). This is deliberately an "either signal" threshold, not "both" — matching the recall-biased posture above.
- **Neither hits → NOT_RELEVANT.** Does not pass to Stage 1. Nothing is extracted or stored. The source email is never touched, deleted, or modified — Missive remains the system of record regardless of this decision; NOT_RELEVANT only means "this pipeline doesn't keep a copy," not "this content is gone."

### "Fail closed" without inventing a new holding queue

The task framing asks specifically whether ambiguous content should default to relevant/held for review rather than being silently dropped, given the data-minimization concern cuts toward *not* processing by default. Both pulls are real, and the answer isn't a third permanent bucket (more machinery — a whole new review queue with its own RLS and Tron work — than this decision warrants on its own). Instead:

1. The signal lists are already recall-biased, so a genuinely ambiguous thread (some maintenance-adjacent language, no clean signal) tends to land on RELEVANT rather than being excluded by a coin flip — that's the classifier's own bias doing the "fail closed" work at decision time.
2. NOT_RELEVANT never means deletion. The email isn't touched. This bounds the actual cost of a wrong NOT_RELEVANT call to "not indexed in this tool yet," not "gone."
3. Every decision — RELEVANT and NOT_RELEVANT — is logged (thread ID, decision, which signal(s) matched, never full content for a NOT_RELEVANT decision — see Audit Logging below).
4. **The real "hold for review" mechanism is temporal, not architectural: the mandatory 90-day shadow period (risk assessment, per Asimov) requires a person to check every NOT_RELEVANT decision against the live thread in Missive**, to catch anything wrongly excluded, before this tool goes live for normal use. This is sized to the actual risk (early-stage, full review, time-boxed) instead of permanent standing infrastructure — the same "don't build ahead of a proven need" call the Property Overview spec made about its own caching table.

---

## Storage Design (Asimov's Gap 2)

**One new table: `maintenance_email_context`.** Not a reuse of `maintenance_claims` — genuinely different shape. `maintenance_claims` stores discrete AI-extracted facts (event/decision/outcome/recurrence) pulled from Latchel's structured data and files, each needing a human to confirm or correct the extraction. This table stores something simpler: the matched, filter-cleared **thread itself** — one row per email thread, verbatim content, no AI extraction step, because Stage 0 and Stage 1 are both rule-based (see above) and nothing in this pipeline reads the content with a model. It's an index/context tool, not a claims tool — matching the feature's own description as "matching maintenance-relevant correspondence to AppFolio/maintenance records for context."

```
maintenance_email_context
  id                        UUID PK

  thread_id                 TEXT NOT NULL         -- external Missive conversation ID
  message_count              INTEGER NOT NULL DEFAULT 1
  thread_started_at           TIMESTAMPTZ
  thread_last_message_at      TIMESTAMPTZ

  property_id                  UUID REFERENCES properties(id)
                                -- the reliable link — address/name match, close to deterministic
  maintenance_request_id       UUID REFERENCES maintenance_requests(id)
                                -- the best-effort link — no clean deterministic key exists between
                                -- an email thread and a specific ticket (unlike Latchel's order_number).
                                -- Populated only when the thread's content/timing lines up with an
                                -- existing ticket; nullable otherwise. Property-level linkage is the
                                -- expected default, ticket-level a bonus when confidently found.
  match_confidence              NUMERIC(4,3)        -- confidence of the maintenance_request_id match
                                -- specifically, not the property match (property matching is treated
                                -- as reliable enough not to need its own score, same reasoning
                                -- b2_photo_folders applies to its own two-tier confidence design)

  subject                        TEXT
  participants                    JSONB NOT NULL    -- [{ address, role: 'from'|'to'|'cc' }, ...]
  thread_text                      TEXT NOT NULL    -- concatenated plain-text body, every message in
                                                      -- the thread — no HTML, no attachments (never
                                                      -- store the file itself, same restraint already
                                                      -- applied to B2 photos and Latchel files)

  relevance_signals                 JSONB NOT NULL   -- { property_match: bool, matched_property_id,
                                                      -- keyword_matches: [...] } — for transparency and
                                                      -- the shadow-period audit; never raw excerpt text
                                                      -- beyond the matched terms/address themselves

  fair_housing_flagged              BOOLEAN NOT NULL DEFAULT FALSE
  fair_housing_categories            TEXT[]
  privilege_tag                       TEXT           -- e.g. 'regulatory_matter' if the filter Tier-1
                                                      -- tagged it; NULL otherwise. HELD threads (Tier 2)
                                                      -- NEVER produce a row here at all — see Stage 1.

  match_rejected                       BOOLEAN NOT NULL DEFAULT FALSE   -- an admin/reviewer marked the
                                                      -- property/ticket match wrong; row stays (never
                                                      -- deleted) but structurally excluded from normal
                                                      -- and decision-safe views, same "never delete,
                                                      -- exclude instead" discipline as maintenance_claims

  pipeline_reviewed                     BOOLEAN NOT NULL DEFAULT FALSE  -- shadow-period audit trail:
                                                      -- did a human check this row's relevance +
                                                      -- privilege/FH decision against the live thread?
                                                      -- NOT a gate on staff seeing the row day-to-day
                                                      -- (unlike maintenance_claims' review_status) —
                                                      -- there's no AI extraction here to get wrong, only
                                                      -- a filter decision to audit. See risk assessment.
  reviewed_by                            TEXT
  reviewed_at                             TIMESTAMPTZ
  reviewer_notes                           TEXT

  created_at                               TIMESTAMPTZ NOT NULL DEFAULT NOW()
  updated_at                                TIMESTAMPTZ NOT NULL DEFAULT NOW()

  CHECK (property_id IS NOT NULL OR maintenance_request_id IS NOT NULL)
```

Unique index on `thread_id` — re-processing an updated thread updates its row rather than duplicating it, same convention as `latchel_job_id`.

**Why no `review_status` gate like `maintenance_claims`:** that table gates display because an AI extracted a fact that could be wrong. This table stores verbatim source text that already passed a legally-reviewed filter — there's nothing to "correct." The thing that genuinely needs auditing is whether the *filter's decision* was right, which is exactly what `pipeline_reviewed` plus the shadow period's 100%-review requirement covers, without blocking ordinary use of correctly-processed threads behind a manual click. `match_rejected` covers the one thing that can go wrong post-hoc — a bad property/ticket link.

**Decision-safe view**, same pattern as `maintenance_claims_decision_safe`:

```sql
CREATE VIEW maintenance_email_context_decision_safe AS
SELECT * FROM maintenance_email_context
WHERE fair_housing_flagged = FALSE
  AND match_rejected = FALSE;
```

Any future feature reading across matched correspondence reads from this view, never the base table.

**Data inventory (GOVERNANCE.md Rule 4):**
- `pii_fields`: `thread_text` — the single highest-PII-density field in this schema; this is by design a full copy of real personal correspondence, more sensitive than `maintenance_claims.claim_text` (a single extracted sentence) because it's the verbatim source, not a distilled fact. `participants` — email addresses and, by implication, names. `reviewer_notes`, standard caveat.
- `agents_with_access`: the scheduled ingestion process (system, service-role key); Hub users holding `reviewer` or `admin` role for `tool='email_context'` (new tool value, `team_member_tool_roles`). **Deliberately does NOT list Claude or any AI model** — unlike every other table in this schema, nothing in this pipeline reads this content with a model. Worth stating explicitly since it's a meaningful, deliberate difference, not an oversight.
- `privacy_category`: Personal correspondence record — the most sensitive category in this schema to date. Default access should be narrower than `maintenance_claims`' (reviewer/admin only, not the broader property-manager-tier read some other tools grant) — flagged here for Neo to apply when writing actual RLS policies, and for Sentinel to confirm before this ships.
- `retention_policy`: PLACEHOLDER pending Mason, same explicitly-allowed pattern as `security_deposit_cases`, `lease_tenants`, `b2_photo_folders`, `maintenance_claims`.
- `ccpa_exportable`: TRUE.
- `ccpa_deletable`: TRUE — **redact-in-place still fits, with one honest addition.** `thread_text` and `participants` redact to `"[REDACTED]"`, same convention as `audit_log.details` and `maintenance_claims.claim_text`, preserving `thread_id`/dates/`message_count`/`property_id`/`maintenance_request_id`/`fair_housing_flagged` for audit continuity. **What's genuinely different here versus `maintenance_claims`:** a thread commingles multiple people's words in one field (a tenant's message and staff's reply both live in the same `thread_text`), and this design doesn't split thread content per-message per-person for v1. A deletion request tied to one participant redacts the *whole row* for any row where they appear in `participants` — there's no clean way to strip just their words out of a shared thread without new machinery this spec doesn't build. Same accepted, documented trade-off already used for `maintenance_claims` and `lease_tenants`, just flagged here in slightly starker terms because the content itself (verbatim email) is more sensitive than a distilled sentence.

**RLS:** enabled, no permissive policies at creation — matches every table in this schema. Actual policies, when Neo writes them, should default to `reviewer`/`admin` only, narrower than this schema's typical property-manager-tier read, per the privacy_category note above.

**`team_member_tool_roles` extension:** add `'email_context'` to the `tool` CHECK constraint, same DROP-then-ADD pattern already used twice. No new role — reuse `'admin'` and `'reviewer'` as-is. Who gets `reviewer` for this specific tool is Peter's call, same as every prior tool.

---

## Ingestion Approach (sketch only — no connection is being built)

Same shape as the Latchel/AppFolio precedent, described here for completeness, not implemented: a scheduled pull (`internalRouter`, shared-secret header, reusing `CRON_SECRET`, same as `insuranceInternalRouter`/`securityDepositInternalRouter`/`maintenanceHistoryInternalRouter`) that lists new/updated threads in the shared inbox, runs them through Stage 0 → Stage 1 → Stage 2 above, and writes the audit log entries below. **The actual Missive connection mechanism (which auth model, what scopes, whether it's Missive's REST API/webhooks against a delegated shared-inbox account or something else) is explicitly not decided by this spec** — that's a real, separate decision needing its own Sentinel and Scotty pass once this spec is approved, not something to guess at while nothing is being connected yet.

## Audit Logging (Rule 1)

Written against `audit_log`'s current real columns (`action`, `entity_type`, `entity_id`, `actor_type`, `actor_id`, `actor_version`, `privacy_category`, `regulation_tags`, `risk_level`, `details`, plus the Rule 1 fields added in `20260815000000_audit_log_rule1_compliance.sql`):

1. **Every Stage 0 relevance decision, every thread, every run:** `action = 'email_context.relevance_decision'`, `entity_type = 'email_thread'`, `entity_id` = a stable identifier for the thread (not yet a row in this table for NOT_RELEVANT threads — use the Missive conversation ID string in `details`, not a UUID FK), `actor_type = 'system'` (rule-based, no model), `actor_version` = the keyword-list version, `privacy_category = 'collection'`, `details = { decision, matched_signals }` — **never the thread's content for a NOT_RELEVANT decision.**
2. **Every Stage 1 outcome for a RELEVANT thread:** mirrors the existing filter's own `held`/`tagged`/`fairHousingFlagged` output — `action = 'email_context.privilege_fh_decision'`.
3. **Every Stage 2 write:** `action = 'email_context.stored'`, `entity_type = 'maintenance_email_context'`, `entity_id` = the new row's id.
4. **Every shadow-period human review:** `action = 'email_context.reviewed'`, `performed_by` = reviewer, `details = { relevance_correct, privilege_fh_correct, notes }` — this is the record the risk assessment's exit criteria are graded against.

---

## What Neo/Q Need to Build This

- **Neo:** one new table (`maintenance_email_context`), its decision-safe view, the `team_member_tool_roles` CHECK-constraint extension. No changes to any existing table — no natural single-ID join exists the way Latchel's `order_number` did, so no new columns on `properties`/`maintenance_requests`.
- **Q:** `lib/maintenance-keywords.js` (new, maintained list, mirrors `protected-class-terms.js`'s structure), `lib/property-matcher.js` (new — periodic in-memory property cache + text-scan matcher), `lib/relevance-filter.js` (new — Stage 0, combines the two signals into RELEVANT/NOT_RELEVANT), `lib/pipeline.js` (new — orchestrates Stage 0 → the existing, untouched `index.js` → Stage 2 storage; this is the "wraps around it" layer, and it's the only new file that calls into the existing filter code), the Hub router (`router.js` + `internalRouter`, mounted into `server.js` exactly like the other three tools), the "Related Correspondence" read routes, and the review/audit routes for shadow mode. **No file inside the existing five (`index.js`, `privilege-filter.js`, `fair-housing-filter.js`, `privilege-keywords.js`, `government-legal-domains.js`) is modified.**
- **Tron:** the "Email Context" Hub tile, the "Related Correspondence" section wired into Maintenance History's property/ticket pages, the "Needs privacy review" view (reuse of the existing pattern's visual language), and the shadow-mode reviewer UI (mark a thread's relevance/privilege decision correct or wrong).
- **Not needed yet, explicitly:** any Missive credential, API/OAuth scope decision, or connection code — none of that is part of this spec (see "Ingestion Approach" above).

## Size Estimate

Grounded against this project's own comparable builds, not a guess. The base Maintenance History build (new external API, AI extraction pipeline, content-check, review gate, new Hub section) ran Neo 1–2 sessions / Q 3–4 sessions / Tron 1–2 sessions in practice (confirmed against the actual code: `content-check.js` 62 lines, `protected-class-terms.js` 155, `extract-claims.js` 218, `latchel-connector.js` 158, `router.js` 659). Property Overview, a lighter follow-on with no new external credential and no new AI extraction, ran an estimated Neo 0–1 / Q 2 / Tron 1.

This build sits between the two, closer to Property Overview's size: **no AI extraction pipeline at all** (the single biggest cost driver in the base Maintenance History build — `extract-claims.js` at 218 lines plus its prompt design and citation-validation logic doesn't exist here, because Stage 0/1/2 are all rule-based or reuse of already-built, already-tested code), but it does need a genuinely new relevance-classification layer with its own signal design and a new table with its own privacy discipline (more sensitive than any existing table, per the data-inventory note above), which Property Overview didn't need.

Rough shape: **Neo — 1 session** (one table, one view, one CHECK-constraint extension — smaller than Maintenance History's schema, similar order of magnitude to Property Overview's, which needed zero new tables — this spec does need one). **Q — 2–3 sessions** (the relevance classifier and its two keyword/matcher modules is genuinely new work with no direct precedent to copy; the pipeline wrapper and storage routes are straightforward reuse of the already-proven `internalRouter`/`CRON_SECRET` pattern). **Tron — 1–2 sessions** (one new Hub tile, one new page section wired into an existing page, one reviewer UI for shadow mode — all reusing existing visual language, no new design system). **Governance/QA — a real pass, not a repeat of the base filter's six-condition review** (that's closed) **but not a light one either** — Asimov's shadow-period requirement (90 days, not the standard 30) means this stays in an active review/verification state well past the initial build-and-ship gate, longer in calendar time than the engineering itself, even though the day-to-day review burden during that period is lightweight (see risk assessment).

## Open Items — Needs Confirming Before Neo/Q Build

1. **Missive connection mechanism** — deferred entirely, per this spec's scope (see "Ingestion Approach"). Needs its own Sentinel/Scotty pass once this spec is approved.
2. **The maintenance-keyword list (Signal 2) and component/relevance decision should get a sanity check against a sample of real (non-privileged) inbox subject lines before Q builds the matcher** — same "don't guess the taxonomy, check it against real data" discipline Property Overview applied to its own component categories. Not blocking the build, but should happen before shadow mode starts, not after.
3. **Exact RLS policy shape** (which roles get which read/write) — Neo's call at build time, informed by the narrower-than-`maintenance_claims` guidance above; Sentinel should confirm before this ships.
