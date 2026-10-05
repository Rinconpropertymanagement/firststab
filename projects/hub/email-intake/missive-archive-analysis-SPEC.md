# Missive Archive — From Raw Storage to Staff-Usable Data

**Status:** Draft — research and design only. Nothing in this document is cleared to build. No schema, code, or database change results from this document by itself.
**Written by:** Oracle
**Date:** 2026-09-07
**Origin:** Peter's ask, this session: the historical Missive backfill (`backfill-missive-history.js`) is running in the background — as of tonight, roughly 35,000 of an estimated ~117,000 total conversations across the two allowlisted mailboxes (Faria, Solimar) are stored in `missive_message_intake`. That number is itself notable: `backfill-missive-history.js`'s own header estimates ~19,254 conversations total (Faria ~1,884 back to Feb 2025, Solimar ~17,370 back to May 2024) — a reference count the file's own comment already flags as "a progress-display convenience, not a target," since new mail arrives daily and the true archive-scoped total (`team_all`, not just the open inbox) was always going to run higher than that early estimate. Tonight's ~117,000 figure is the real number; treat the script's own 19,254 as stale. This document is deliberately **not** about the backfill mechanics (pacing, resumability, parallelization) — that's `backfill-missive-history.js`'s own, already-solved problem, out of scope here. This is about the next question: once messages are sitting in that table, how does any of it actually become something a Rincon staff member can use?
**Governance:** This is unambiguously a compliance build under `GOVERNANCE.md`'s own trigger — it stores and surfaces personal information about tenants and owners, and (via significance tagging) makes a judgment call about which of a tenant's or owner's issues staff should pay attention to. Per `CLAUDE.md`, that means Asimov (governance) and Mason (Fair Housing & legal) must both clear this before any of it ships, and no automated step in this design may make a final call on its own — every design choice below is built around a human staying in the loop, never an AI unilaterally deciding something isn't worth showing. **This document does not perform that review.** Section 4 states plainly what still has to happen and why.

**Built from, read in full:**
- `supabase/migrations/20260905020000_missive_shared_inbox_intake_schema.sql` — the `missive_message_intake` schema this whole phase builds on top of. Its own "RULE 9 — HOUSING-DECISION FIREWALL," "SCOPE LOCK," and Rule 4 retention-policy sections are load-bearing for several judgment calls below, not just background.
- `projects/hub/email-intake/router.js`, `backfill-missive-history.js`, `lib/shared.js` — the real connector/storage code (column names, JSONB shapes, the `storeMessage`/audit-log pattern).
- `projects/hub/email-intake/lib/index.js`, `privilege-filter.js`, `fair-housing-filter.js` — the existing, already-legally-cleared, but **still not connected to `missive_message_intake`** Stage 0/1/2 content filter. `lib/index.js`'s own header states it plainly: "NOT CONNECTED TO ANY REAL EMAIL SYSTEM... this stays inert until a human explicitly wires a real Missive connection into it." That wiring has not happened. This is the single most important fact grounding Section 4 below.
- `compliance/missive-connector-governance-precheck.md` — Asimov's real review of the intake connector itself, including the Section 5 architecture ("Rincon receives → stores → then analyzes") this entire project exists to satisfy, and the explicit statement that this review's scope does **not** cover any future analysis step.
- `projects/hub/property-360/owner-tenant-operational-notes-SPEC.md` — the closest real precedent in this codebase: a tiered-access, human-reviewed system for factual notes about owners/tenants/properties, built on counsel's own Fair Housing framework. Read for its access-tier model, its review-disposition vocabulary, and its "AI proposes, human approves/dismisses, nothing is ever silently and permanently suppressed" posture — reused as a pattern, not copied as a design.
- `projects/hub/maintenance-history/lib/content-check.js`, `protected-class-terms.js`, `extract-claims.js` — the real, working two-layer content-check mechanism and the real AI-extraction pattern (cite-your-source, say-unknown-rather-than-guess, self-reported protected-class flag) this design reuses rather than reinvents.
- `supabase/migrations/20260626000000_initial_schema.sql`, `20260720000002_owners.sql`, `20260813000001_lease_tenants.sql` — real `tenants`/`owners`/`properties`/`units`/`property_owners` columns and relationships, needed to ground Section 1's matching design in what actually exists (notably: `properties` has no `owner_id` column — the owner relationship runs through `property_owners`, keyed by AppFolio IDs, and is many-to-many).
- `compliance/shared-inbox-risk-assessment.md`, `compliance/shared-inbox-legal-checklist.md` — an earlier (2026-08-16), narrower design for a maintenance-ticket-scoped version of email matching. Superseded in scope by the general-purpose `missive_message_intake` architecture, but its "two checks before any content is looked at" framing is the direct conceptual ancestor of Section 4 below.

---

## 0. Scope Recap

**In scope for this document:** what happens to a message once it is sitting, verbatim, in `missive_message_intake` — how it gets connected to a property/tenant/owner, how staff-relevant significance gets identified without drowning them in routine chatter, how search fits in, where any of this would surface, and what has to happen before any of it reaches a real screen.

**Explicitly out of scope:** the backfill itself (pacing, resumability, parallel-token splitting — all already designed and running), the Stage 0/1/2 privilege/Fair-Housing filter's own internal logic (already built, already legally cleared as a standalone function — see `lib/privilege-filter.js`, `lib/fair-housing-filter.js`), and any final schema, RLS policy, or route implementation (Neo's and Q's calls, once this design and its governance review are both approved).

---

## 1. What's Already True Today — Grounding Before Designing Anything

Four facts drive most of the judgment calls below, worth stating plainly because they're easy to lose track of across several documents:

1. **`missive_message_intake` has zero readers today.** The migration's own Rule 4 inventory states `agents_with_access: NONE` — no AI agent, no Hub route, no `team_member_tool_roles` grant exists for this table. RLS is enabled with zero permissive policies; only the Supabase service-role key (the sync/backfill jobs) can touch it. Every feature this document proposes is a **new** reader, starting from that zero baseline — not an extension of an existing access path.
2. **The content filter exists, but is not wired to this table.** `lib/privilege-filter.js` and `lib/fair-housing-filter.js` are real, working, already-legally-cleared pure functions — but they operate on plain JS objects a caller constructs, and nothing in this codebase currently calls them with a `missive_message_intake` row's content. `pipeline_status` (`'pending'` / `'processed'`) exists as a column on that table specifically so a future job can mark rows as filtered — but that job does not exist yet, and even once it does, the migration's own "PREREQUISITE" note flags that the table has **no column recording what the filter found**, only that it ran. Every 47,000+ (now ~117,000-conversation-scale) message currently sits at `pipeline_status = 'pending'`.
3. **The raw table deliberately has zero foreign keys to anything** — not to `properties`, `tenants`, `owners`, or any housing-decision table. This is the "Rule 9 — Housing-Decision Firewall" the migration documents at length: `missive_message_intake` may hold unscreened privileged or Fair-Housing-flagged content, so nothing joins toward it or from it by construction. Any property/tenant/owner linkage this phase builds has to respect that firewall, not quietly erode it.
4. **Address-to-person matching is well-covered; content-based matching is not optional.** Checked live tonight against the real synced AppFolio data: 382 of 383 owners have an email on file, 870 of 1,192 tenants do. A live sample of stored messages found 56% are Rincon-staff-to-staff internal correspondence with no tenant/owner address anywhere on the message — meaning address matching alone would leave more than half the archive with no property/tenant/owner connection at all, most of it legitimately unmatchable (internal chatter about no specific property), but some real fraction of it genuine correspondence where the tenant/owner's address just isn't in AppFolio's synced data yet, or where the relevant reference is only in the subject/body ("the Ventura Rd tenant," a property nickname, an address typed out by hand).

---

## 2. Matching Architecture: Connecting a Message to a Property, Tenant, or Owner

### 2.1 Two prongs, already agreed — recapped for grounding, not re-derived

**(a) Address matching.** Deterministic, no AI, cheap — the same category of thing `extract-claims.js`'s `buildDeterministicEventClaims` already does elsewhere in this codebase (facts derived mechanically from structured data, not model judgment). Compare `from_address`, and every address inside the `to_addresses`/`cc_addresses`/`bcc_addresses` JSONB arrays (each array holds `{address, name}` objects per Missive's own shape — confirmed against `storeMessage`'s `message.to_fields`/`cc_fields`/`bcc_fields` mapping in `lib/shared.js`), against `tenants.email` and `owners.email`, case-insensitive, trimmed.

**(b) Content-based extraction.** For a message with no matchable address (the 56% staff-to-staff case, plus any tenant/owner whose email isn't in AppFolio's synced data), an AI extraction step reads the subject/body and attempts to identify a property, unit, or named person it refers to — the same shape as `extract-claims.js`'s AI path: cite a source (which sentence/field the reference came from), say "unknown" rather than guess, self-report a confidence score, and — critically, since this reads unscreened body content — self-report a protected-class flag using the same `modelFlag`/`modelCategory` convention that feeds `content-check.js`.

### 2.2 Why the match output needs its own table, not new columns on `missive_message_intake`

The raw intake table's zero-FK design (Section 1, fact 3) isn't incidental — Asimov's governance precheck specifically required it stated as a structural fact, not a policy that could be silently bypassed by "just adding one property_id column later." Adding `property_id`/`tenant_id`/`owner_id` directly onto `missive_message_intake` would reopen exactly the design decision that migration went to the trouble of locking down, and would need its own fresh governance pass to do so. It also wouldn't fit the real shape of the data:

- **One message can match more than one subject.** A message cc'ing two co-tenants on a lease (`lease_tenants`, the multi-tenant-occupancy table Neo built specifically because `leases.tenant_id` can only hold one tenant) matches two people from one message. A message from a co-owned property's contact (`property_owners` is many-to-many — one owner can hold interests in several properties, one property can have several owners) can match more than one owner/property pair.
- **A tenant or owner's property relationship isn't a single fixed value to cache.** It's resolved through `leases`/`lease_tenants` → `units` → `properties` for a tenant (and a tenant can have more than one lease over time — matching should prefer the lease active at, or nearest to, the message's `delivered_at` date, not just "the tenant's most recent lease" blindly), and through `property_owners` for an owner (many-to-many, resolved via AppFolio IDs, not a direct UUID FK — confirmed against the real schema; `properties` has no `owner_id` column at all).

The precedent already in this codebase for exactly this situation is `operational_notes`: a separate table from its own raw source data, using a polymorphic `subject_type`/`subject_id` pair (`'owner' | 'tenant' | 'property'`) rather than three separate nullable FK columns, because Postgres can't express "an FK into one of two tables" natively and `audit_log` already accepts that same limitation. The natural shape for this phase's match output — **Neo's eventual call on the real DDL, not decided here** — is something like:

```
missive_message_links (sketch, not final DDL)
  id
  missive_message_id        -- matches missive_message_intake.missive_message_id
                             -- by value, not FK — same "documented convention,
                             -- not enforced constraint" choice the schema
                             -- already made between the two existing tables
  missive_conversation_id   -- denormalized for cheap "all links for this thread" queries
  property_id                -- FK -> properties(id)
  unit_id                     -- nullable FK -> units(id), when resolvable
  subject_type                -- 'tenant' | 'owner' | 'unmatched_internal' | 'unmatched_external'
  subject_id                   -- tenants.id | owners.id | NULL, per subject_type — same
                                -- polymorphic pattern operational_notes already uses
  match_method                  -- 'address_match' | 'content_extracted'
  matched_field                  -- which address field matched, for address_match
                                  -- (e.g. 'to_addresses'); NULL for content_extracted
  source_reference                -- for content_extracted only — which sentence/field
                                   -- the reference came from, same discipline
                                   -- extract-claims.js already requires
  confidence                       -- NULL for address_match (deterministic);
                                    -- 0.0-1.0 for content_extracted
  extracted_by                      -- NULL for address_match; model version string
                                     -- for content_extracted
  created_at
```

One message can therefore produce zero, one, or several rows here — zero for genuinely unmatchable internal chatter (expected, not a gap, per the 56% finding), one for the common case, several for a co-tenant cc or a shared-owner property.

### 2.3 A real sequencing question this raises, not resolved by the matching design alone

Address matching (prong a) only ever reads `from_address`/`to_addresses`/`cc_addresses`/`bcc_addresses` — it never touches `body_html`/`body_text`. That means it can, in principle, run against every stored message today, independent of whether the Stage 0/1/2 filter has ever run on that row — matching doesn't require having screened the content, because it isn't reading the content. Content-based extraction (prong b) is different: it necessarily reads the same unscreened body text the filter exists to check. Running an AI extraction step over 65,000+ (56% of ~117,000) messages' raw body content, before that content has ever been screened for privileged or Fair-Housing-protected material, is precisely the kind of thing Section 4 flags as needing Asimov/Mason's sign-off before it happens — not a decision this document makes.

**Practical implication for build sequencing, worth surfacing now rather than discovering later:** prong (a) and prong (b) are not one undifferentiated "matching" phase — they have a different relationship to the content-screening gate, and a build plan should treat them as two separate steps that can ship on two different timelines if Peter wants faster initial value from the well-covered address-matchable majority.

---

## 3. Significance Tagging — Turning "everything" into "what actually needs a look"

Peter's own framing, quoted directly because it's the literal product requirement everything below implements: *"not every single thing that shows up is going to be what we want highlighted... we only want major issues or things that will affect how we act in the future... if a simple issue is raised with a tenant and it is resolved and done i dont know if thats something we want on the tool."*

### 3.1 What gets tagged, and at what grain

Resolution status ("is this done") is a property of a **conversation** — a back-and-forth thread — not any single message in isolation ("thanks, all set!" only means something in the context of what came before it). Significance tagging should therefore key off `missive_conversation_id`, evaluated once the AI has read the conversation's full message history to date, not per-message.

### 3.2 The categories — real defaults, not a placeholder

Three independent dimensions, each with a conservative default, mirroring the tier-ordinal and disposition-vocabulary conventions `operational_notes` already established for a comparable problem:

| Dimension | Values | Default when ambiguous |
|---|---|---|
| **Resolution status** | `open` \| `resolved` \| `unknown` | `open` (or `unknown`, treated identically to `open` for display purposes) — never default to `resolved`, since that's the value that would cause something to be de-emphasized |
| **Pattern** | `first_occurrence` \| `possible_recurrence` \| `unknown` | `unknown` — see 3.3 below for why this one is genuinely harder and shouldn't be overclaimed |
| **Category** | Free text with suggested values (`routine_logistics`, `maintenance_standard`, `dispute`, `safety_issue`, `legal_exposure`, `accommodation_related`, `owner_instruction`, `other`) — same "free text, not a rigid enum, Mason can refine without a migration" convention `operational_notes.category` already uses | No default needed — every conversation gets a best-guess category; `other` is the honest fallback, not a blocker |

An AI classification step (same Claude-call pattern as `extract-claims.js`) reads a conversation's messages and proposes values for all three dimensions, plus a one-sentence `why` (its stated reasoning, useful for a human skimming why something is flagged the way it is). **This never gates visibility** — unlike `operational_notes`' AI-proposed notes (invisible until a human approves them), a significance tag is visible the moment it's computed. The tag changes *how prominently* something is shown, never *whether* it can be seen at all — this is the direct implementation of "AI narrows what a human looks at, never unilaterally clears something," the same posture the task brief names as already the standard for this project's other Fair Housing work tonight.

### 3.3 Pattern/recurrence detection — flagged honestly as the harder piece

Determining "is this the same issue that came up before" requires comparing a conversation against *other* conversations about the same tenant/property — a cross-reference problem, not a single-document classification problem the way resolution status and category are. A first version could reasonably ship with `pattern` permanently `unknown` (i.e., not attempted) while the other two dimensions are fully built, with real recurrence detection (e.g., "any other conversation matched to the same `subject_id` with a similar category and matched address within the last N months") as an explicit fast-follow once the matching layer (Section 2) exists to make that cross-reference possible at all — recurrence detection has a real, structural dependency on matching that resolution-status and category do not. **Recommend against overclaiming pattern detection in a first version rather than shipping a half-working heuristic that looks more confident than it is.**

### 3.4 Human override — dismiss, never delete

A staff member viewing a tagged item can dismiss it (mark "not something I need to keep seeing here") or confirm/re-open it. Dismissing:
- Never deletes or hides the underlying message/conversation from search or from the raw record — only removes it from whatever "needs attention" surfacing view is showing it by default.
- Writes an audit row (`missive_significance.overridden`, actor = the staff member, `details: { conversation_id, previous_status, new_status, dismissal_reason }`) — same discipline `operational_notes.reviewed` already applies to every disposition change, and the same reason: if a dismissal is ever second-guessed later, there's a real record of who made the call and roughly why.
- Is itself reversible — a dismissed item can be un-dismissed; nothing here is a one-way door, matching the "never silently and permanently suppress" principle carried over from the operational-notes precedent.

This is deliberately the opposite failure mode from a silent auto-filter: the AI's classification is a starting point a human can immediately override, not a gate a human has to fight to see past.

---

## 4. Search — Feasible Now, But Not the Same Question as "Cleared to Ship"

**Technically:** yes, and independent of matching, exactly as discussed tonight. `body_text`/`subject` are already plain Postgres `TEXT` columns; Postgres's built-in full-text search (a generated `tsvector` column plus a GIN index, the standard pattern — this codebase has no existing full-text-search feature to point to as precedent, so this would be the first one, but it's a well-understood, low-risk addition, not novel engineering) would let staff search across every stored message's subject and body without needing a single row of Section 2's matching to exist first. A keyword search for "roof leak" or a tenant's last name works the same whether or not that message has been linked to a property record yet.

**Governance-wise, this is a different question, and the two should not be conflated.** "Search doesn't depend on matching" is a statement about technical build order. It is not a statement about whether search is exempt from the content-screening gate the rest of this document is built around — if anything, a search box that returns raw subject lines and body snippets from **unscreened** correspondence is a *more* direct exposure of raw content to a human reader than the tagging feature (which mostly surfaces metadata and AI-generated summaries), not a lesser one. A message that would have tripped the privilege filter (an attorney communication, a litigation-relevant thread) or the Fair Housing filter (a health/disability mention, protected-class language) is, today, exactly as searchable as any other message, because nothing has screened it yet. Building the search *index* has no dependency on the filter having run; letting a real staff member *use* that search box against real content does — same gate as everything else in Section 5.

**Practical recommendation:** the search *infrastructure* (the `tsvector`/GIN index, the query function) can reasonably be built and tested against real data early, in parallel with the matching/tagging work, since it has no technical dependency on either. Whether it's ever exposed to a live user, and to which roles, is squarely inside the Section 5 gate — same as Property 360 surfacing or any tagged "needs attention" view.

---

## 5. The Fair Housing / Content-Screening Gate — An Open Item, Not Resolved Here

Stated plainly, because it's the thing everything above is built around without deciding: **none of the ~117,000 conversations currently being stored have been through any content check.** `pipeline_status` sits at `'pending'` for all of them, and — per Section 1 — the job that would actually run `lib/privilege-filter.js`/`fair-housing-filter.js` against this table doesn't exist yet. Any feature in this document that puts a message's subject, body, or an AI-generated summary of it in front of a staff member needs the same two-layer discipline `maintenance_claims`/`operational_notes` already apply before their content reaches anyone:

- **Layer 1** — deterministic keyword/domain scan. `fair-housing-filter.js` already reuses `protected-class-terms.js` unchanged for exactly this purpose; `privilege-filter.js` already implements the legal-hold/attorney-domain check. Both are real, working, already-cleared functions — they just need to actually be called against real `missive_message_intake` rows, which is new, not-yet-built work.
- **Layer 2** — the extraction/tagging model's own self-reported flag, same `modelFlag`/`modelCategory` convention this document's Sections 2 and 3 already assume for the content-extraction and significance-tagging AI calls.

**What this document is explicitly not doing:** deciding how a HELD (privileged) or Fair-Housing-flagged conversation should behave inside the matching/tagging/search features above — whether it's excluded entirely, walled off behind a restricted tier the way `operational_notes`' Legal/Privileged tier works, or something else. That is a real design decision with real legal weight (the exact kind of call outside counsel made for `operational_notes` in `compliance/owner-tenant-notes-outside-counsel-opinion.md`), and per the task brief and this project's own established practice tonight, it belongs to **Asimov (governance) and Mason (Fair Housing & legal)**, not to this research document. Flagging it here as the load-bearing open item, not resolving it:

1. **A shared prerequisite this phase has in common with retention, already flagged by Neo's own migration.** The migration's "PREREQUISITE" note (Rule 4 inventory, `retention_policy`) already identifies that `missive_message_intake` has no column recording a row's filter *outcome* once `pipeline_status` flips to `'processed'` — only that the filter ran. Both the age-based deletion job Mason designed *and* every feature in this document need the same missing piece: somewhere queryable, per message or per conversation, recording whether the filter held it, flagged it, and for what category. Whoever eventually builds the filter's real connection to this table should build that output store once, for both consumers — not have retention and this analysis phase each invent their own incompatible version of "did this get flagged."
2. **Scale matters here in a way it didn't for `operational_notes`.** That system's flagged-content volume was expected to be small and slow-growing (staff typing individual notes). This phase inherits ~117,000 conversations' worth of already-existing, unscreened correspondence on day one — a fundamentally different volume for a human review queue to absorb, and a real open question for Asimov/Mason on whether the existing review-queue UX pattern (`flagged-review-grouping-and-exclusions-SPEC.md`'s grouped/bulk review, built for a much smaller volume) scales to it as-is or needs its own rework.
3. **Access tiering is a fresh question, not an inherited one.** `operational_notes`' three-tier model (Operational / Management-Compliance-Restricted / Legal-Privileged) was purpose-built for staff-authored facts. Whether this email archive needs the same three tiers, a different tiering scheme, or something narrower given its much higher sensitivity-before-screening (Section 1, fact 3's "may hold unscreened Tier-2 HELD/privileged and Fair-Housing-flagged threads that `maintenance_email_context` never stores at all" — the migration's own words) is Asimov's and Mason's call, informed by but not decided in this document.

---

## 6. Where This Would Surface in the Hub — A First Pass

Two natural homes, not mutually exclusive, sequenced by what each depends on:

**Property 360 — a new card, once matching (Section 2) exists.** Follows the exact pattern this Hub already uses for "Needs Privacy Review" and the Maintenance Snapshot: a labeled, collapsible section on a property's own page, closed by default, showing that property's tagged conversations (via `missive_message_links.property_id`) ordered by significance (open/flagged items first, resolved items collapsed further or hidden behind a "show resolved" toggle — Peter's actual preference on this is an open question, see Section 7). This is the highest-value surface for the "I'm about to talk to this owner/tenant, what do I need to know" use case Peter's original ask was framed around, but it structurally cannot exist before Section 2's matching produces a `property_id` to key off of.

**A dedicated Email Archive tool — buildable independent of matching.** A standalone Hub page, its own `team_member_tool_roles` value (something like `email_archive` — a new tool value, not a reuse of `owner_tenant_notes`, since the access-sensitivity profile is different enough per Section 5 point 3 to need its own independent mapping, same "no tool inherits another tool's role meaning" discipline this codebase already applies everywhere `team_member_tool_roles` is used). This is the natural home for the search capability from Section 4, and for the ~56% of messages that are genuinely internal, unmatched correspondence with no property page to attach to at all.

**Recommendation:** if Peter wants to see value sooner rather than later, the dedicated search tool (once cleared through Section 5's gate) is the piece with the fewest technical dependencies — it needs the content-screening gate resolved, but not the matching or tagging layers. The Property 360 card is the more directly useful surface for day-to-day property-manager work, but depends on Section 2 being built first. Both are a first pass, not a final UI design — Tron's call once this is further along.

---

## 7. Open Questions for Peter

1. **Sequencing:** does address-matching (well-covered, deterministic, doesn't touch body content) get built and shipped ahead of content-extraction matching and AI significance tagging (both of which read unscreened body content and sit behind the Section 5 gate), or does Peter want to wait and ship all of it together?
2. **"Resolved and done" — hidden, or just deprioritized?** Section 3 defaults to *never fully hiding* a resolved item, only deprioritizing/collapsing it, so nothing is silently suppressed. Is that the right balance, or does Peter actually want a stronger default — e.g., resolved-and-routine items excluded from the default property view entirely, with a deliberate click to "show everything including resolved"?
3. **Recurrence/pattern detection (Section 3.3):** is a first version without real cross-thread recurrence detection (defaulting every conversation to `pattern: unknown`) an acceptable v1 cut, with real pattern-matching as a later phase once Section 2's matching exists to make it possible — or is "is this a repeat issue" important enough to Peter's original ask that it needs to be in scope from the start, even at lower confidence?
4. **Access — reuse the `operational_notes` playbook, or design fresh?** Given this archive is both higher-volume and higher-sensitivity-before-screening than anything `operational_notes` covers, should the same portfolio-wide `property_manager`/`pod_lead` access model even be the starting proposal for Asimov/Mason's review, or does Peter want a narrower first cut (e.g., `admin`/`director_of_operations` only, widened later once the volume and review workload are better understood)?
5. **Should the filter-connection work get prioritized now, ahead of everything in this document?** Section 5 point 1 identifies that wiring the existing privilege/Fair-Housing filter to actually run against `missive_message_intake` — and recording its output somewhere queryable — is a shared prerequisite for retention (already a live legal requirement per Mason's policy in the schema migration) *and* every feature in this document. Does Peter want that filter-connection work treated as its own, first, priority build — separate from and ahead of matching/tagging/search — given it unblocks two separate needs at once?

---

## What This Document Is Not

Not a schema (Neo's call once this design and its governance review are approved). Not a governance clearance (Section 5 states plainly this still needs Asimov and Mason). Not a UI design (Tron's call). Not an estimate of build time or engineering cost — not asked for, and premature before the Section 5 gate and Peter's answers to Section 7 shape what's actually being built. This document's only job is to answer "is this reachable, and what would it look like" — not "is this cleared, or how long would it take."
