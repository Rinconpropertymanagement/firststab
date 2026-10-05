# Property Brain — Platform Architecture

**Status:** Research + architecture only. Nothing in this document authorizes a build, and nothing here connects to anything live. Neo/Q do not start on any of this until Peter approves it, piece by piece, per the phased plan at the end.
**Written by:** Oracle
**Date:** 2026-08-16
**Origin:** Peter's own words: "this is one of the critical pieces of the property brain project so we have to get it right." This document supersedes the maintenance-only relevance design in `projects/hub/email-intake/SPEC.md` (2026-08-16 draft) — not because that design was wrong for what it scoped, but because Peter, after reviewing it, corrected the scope: the relevance check can't be reliable as a simple keyword/subject-line rule (real correspondence has no clean structure — it needs actual reading and understanding), and this was never meant to be maintenance-only. He anticipates similar tools for tenant issues, lease renewals, and other domains, and expects the system to eventually "read and understand the emails very well" as one general capability, not several narrow ones built and rebuilt per use case.

**Built from, read in full:**
- `/Users/petermckenzie/Downloads/The_Property_Brain_Thesis_Wolfgang_Croskey.pdf` — a peer operator's public strategic thesis (entities/claims/claim heads/conflicts as the core concept; evidence, provenance, knowledge states, confidence, permissions, and an action layer as the twelve elements a real Property Brain needs).
- `/Users/petermckenzie/Downloads/property-brain-crane-spec-sheet.md` — the same author's illustrative, generic build pattern: `entities`, append-only `claims`, mutable `claim_heads` pointers, automatic `conflicts` on disagreement, fail-closed `promotion_policies`, and a specific write-path transaction design.
- `projects/property-brain-experiment/README.md` and `extractions/17432-1.md` — the 10-ticket test that validated AI extraction accuracy on Rincon's own real, messy maintenance data: 80% fully correct, 0% missed, 0% wrong-source, using cite-everything / say-unknown-not-guess / human-review-gate discipline. `answer-key-template.md` was also checked directly — it defines the graded categories (routine/messy/owner-decision/recurrence/sideways) and the 1–5 outcome ladder, but does not itself contain a lettered failure taxonomy; the "F1–F10" reference in this project's own history is treated below as a shape to generalize from, not a file to quote.
- `projects/hub/maintenance-history/SPEC.md`, its schema (`supabase/migrations/20260815010000_maintenance_history_schema.sql`), and its built code (`lib/content-check.js`, `lib/extract-claims.js`, `lib/protected-class-terms.js`) — the actual, working, tested simplification of the thesis: four claim types, one domain, no `claim_heads`, no automatic conflict detection, every claim human-reviewed regardless of confidence.
- `projects/hub/maintenance-history/property-overview-SPEC.md` — a second-generation spec already grappling with cross-ticket synthesis, a component taxonomy as a maintained code asset (not a table), and citation-validated AI summarization on top of already-extracted claims. Read closely because parts of its design (a registry-style taxonomy, validate-before-trust synthesis) generalize directly into this document.
- `projects/hub/email-intake/lib/` in full (`index.js`, `privilege-filter.js`, `fair-housing-filter.js`, `privilege-keywords.js` referenced, `government-legal-domains.js` referenced) — the built, tested, legally-cleared privilege/legal-hold and Fair Housing filter. Its logic is not touched by this document.
- `projects/hub/email-intake/SPEC.md`, `compliance/shared-inbox-risk-assessment.md`, `compliance/shared-inbox-legal-checklist.md` — the immediately prior round: a maintenance-only, rule-based relevance design, its risk assessment, and Mason's closed legal review. The legal review's six conclusions (privilege boundary, Fair Housing sufficiency, CCPA/CIPA/notice findings) are **inherited, not re-opened**, by this document — they were about the content boundary (what gets held vs. tagged vs. processed), which does not change here. What changes is how "is this in scope" gets decided and what happens after.
- `supabase/migrations/20260815000000_audit_log_rule1_compliance.sql` — `audit_log`'s real, current shape: the full Rule 1 field set, the tamper-evident hash chain, actor/version tracking, Solove-taxonomy privacy categories. This is load-bearing for the audit design below.
- `GOVERNANCE.md` in full (all 10 Rules, the Fair Housing Standard).

---

## What This Is, In Plain Terms

Today, three things are true that this document changes:

1. Rincon has one working example of "Property Brain" — Maintenance History — built narrow and deep for exactly one domain (Latchel maintenance tickets), because that's what the 10-ticket test proved and what got built first.
2. A second feature (a shared email inbox reader) was specified immediately after, and it was *also* built narrow — a simple keyword check deciding "is this email maintenance-related," bolted onto the existing filter.
3. Peter looked at that second spec and said: the keyword check won't work reliably, and this isn't supposed to be maintenance-only anyway.

This document is the answer to both problems at once. It proposes: **one shared reading step** that actually understands an email (not a keyword scan), producing **multiple typed, sourced facts** that land in **one shared claims store** — a generalized version of the table Maintenance History already built, not a second table next to it. Downstream, a maintenance tool, a future tenant-issue tool, and a future lease-renewal tool all read from that same store, filtered to what's relevant to each — the same way three people can read the same book and each take different notes, instead of the book being retyped three times for three readers.

The rest of this document is the specific decisions that make that real: what the shared store looks like, how "what is this email about" gets decided without either guessing or reading everything indiscriminately, what stays shared infrastructure versus what's domain-specific, who can see what and for how long, how the system gets better from its own mistakes, and — because Peter asked for a real answer, not a placeholder — whether the original thesis's `claim_heads` and automatic conflict detection belong in this now, or later.

---

## 1. The Data Model — What Generalizes, What Doesn't, and Why

### 1.1 What the thesis actually offers, and what's already been proven not needed

The crane spec sheet's five concepts — `entities`, `claims`, `claim_heads`, `conflicts`, `promotion_policies` — solve a specific problem: **a fact about something can be asserted more than once, by different sources, at different times, and disagree.** `claim_heads` answers "what do we currently believe" in one fast lookup instead of re-deriving it from history every time. `conflicts` answers "did two sources just disagree" automatically instead of a human happening to notice. `promotion_policies` answers "should this new claim silently become the accepted answer, or does it need a human first" — fail-closed by default.

Maintenance History already tested a simplified version of this against real data and it held: four claim types (event/decision/outcome/recurrence), every claim cited to an exact source, every claim landing in front of a human via `review_status = 'unreviewed'` regardless of confidence — and, deliberately, **no `claim_heads`, no automatic conflict detection, no promotion-policy routing.** The schema migration's own comments explain why: nothing in that design ever auto-promotes a claim past a human, so there's no "current accepted answer" being computed automatically, and therefore no head to point at and no concurrent-write race to protect. That reasoning still holds today, and the section below explains exactly what would have to change for it to stop holding.

### 1.2 The decision: generalize the table, not the whole thesis

**Recommendation: `maintenance_claims`'s shape generalizes into one shared `claims` table with a `domain` dimension. Domain-specific claims tables are not built going forward — new domains are new rows in this one table, not new tables.**

Why one table, not domain-specific tables fed by a shared pipeline (the other option the task asked me to weigh): the entire reason this document exists is that Peter rejected "read once, but still keep three separate readers/stores downstream." A `maintenance_claims` table, an `email_context` table, a future `lease_claims` table, a future `tenant_issue_claims` table — each with its own near-identical scaffolding (source citation, confidence, review gate, protected-class flag, audit shape) — reproduces the narrow-silo problem one layer down, in storage instead of extraction. It also makes "everything we know about this property, across every domain" a UNION across N tables instead of one query — directly working against the "one shared understanding layer" principle this whole document is supposed to deliver. The cost of one shared table is real but small: a `domain` column, and accepting that not every column is meaningful for every domain (e.g., `outcome_level` only makes sense where a domain has an outcome ladder — this is no different from the *existing* table already having `outcome_level` sit unused on `event`/`decision`/`recurrence` rows today).

**The generalized shape:**

```
claims
  id                            UUID PK

  domain                        TEXT NOT NULL     -- 'maintenance' today; 'lease_renewal',
                                                   -- 'tenant_issue', etc. as those get built.
                                                   -- Registered, not free-form — see 1.4.

  claim_type                    TEXT NOT NULL     -- domain-scoped vocabulary. For domain='maintenance':
                                                   -- exactly the four types already proven
                                                   -- (event/decision/outcome/recurrence), unchanged.
                                                   -- A future domain defines its own types — see 1.4.

  -- Subject — which property/ticket this claim is about. Exactly the same two columns
  -- maintenance_claims (via maintenance_request_id) and the prior email-context design
  -- (via property_id + maintenance_request_id) already use. See 1.5 for why this stays
  -- two columns instead of the thesis's generic `entities` abstraction, for now.
  property_id                    UUID REFERENCES properties(id)
  maintenance_request_id          UUID REFERENCES maintenance_requests(id)
  related_maintenance_request_id   UUID REFERENCES maintenance_requests(id)  -- unchanged from today,
                                                                             -- populated only for claim_type='recurrence'

  claim_text                      TEXT NOT NULL
  claim_date                       DATE
  outcome_level                     SMALLINT CHECK (outcome_level IS NULL OR outcome_level BETWEEN 1 AND 5)

  source_type                       TEXT NOT NULL   -- today's four Latchel-sourced values, PLUS new
                                                     -- values as new domains/channels are added
                                                     -- (e.g. 'missive_conversation') — see 1.4 for how a new
                                                     -- value gets added safely.
  source_reference                   TEXT NOT NULL  -- unchanged discipline: exactly which record,
                                                     -- never a summary with the source stripped off

  confidence                          NUMERIC(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1)
  extracted_by                         TEXT NOT NULL

  flagged_protected_class              BOOLEAN NOT NULL DEFAULT FALSE
  flagged_category                      TEXT

  review_status                         TEXT NOT NULL DEFAULT 'unreviewed'
                                          CHECK (review_status IN ('unreviewed','confirmed','corrected','rejected'))
  reviewed_by                            TEXT
  reviewed_at                             TIMESTAMPTZ
  reviewer_notes                           TEXT
  correction_reason_code                    TEXT      -- NEW — see Section 6 (the feedback loop).
                                                        -- Required whenever review_status moves to
                                                        -- 'corrected' or 'rejected'.

  created_at / updated_at                    TIMESTAMPTZ
```

Every column above except `domain` and `correction_reason_code` already exists, unchanged, in `maintenance_claims` today. This is a small, additive generalization — not a rewrite.

### 1.2.1 Email-sourced claims — the hard rule for `source_reference` and `claim_text`

Both columns already exist in 1.2's shape, unchanged from `maintenance_claims`. What changes with Phase 2 is what they point at. Today, `source_reference` only ever cites a Latchel job field, a state-history entry, an invoice field, or a job file — structured, bounded records with no free-form personal narrative sitting in the citation itself. An email-sourced claim's citation points at something categorically different: an actual piece of correspondence, and the subject line is exactly where sensitive detail — a health complaint, a custody arrangement, an income source — routinely lives in real messages, often more so than the body a filter is built to scan. Section 4's central guarantee is that the raw thread is never duplicated into this system. That guarantee only holds if the citation field itself can't quietly become a second, unguarded copy of the same content under a different column name. Two hard requirements follow, not suggestions, binding on whoever builds Phase 2 — and written here to match, not drift from, what Neo's Phase 1 schema migration comment states for this same column even though no email-sourced claim exists to test it against until Phase 2 is built:

1. **`source_reference` on any email-sourced claim may only ever contain: thread ID + message ID + timestamp + sender address.** Never a subject line. Never a body excerpt, however short. Never a paraphrased "summary of the source" in place of the four identifying fields above. A subject line is not a citation shortcut — it is frequently the single most sensitive string in the entire email — and storing it here would defeat Section 4's no-raw-storage decision without anyone having actually decided that.
2. **`claim_text` on any email-sourced claim must be a distilled paraphrase of what the email establishes — never a verbatim quote, and never a close paraphrase that reproduces the original wording closely enough to function as one.** This is the same "cite everything, don't guess" discipline `extract-claims.js` already applies to Latchel sources, restated explicitly here because unstructured email prose is far easier for an extraction model to quote from than a structured API field is — a failure mode that barely exists for a Latchel job field and is a live, real risk for an email body.

Both rules apply only where `source_type` is an email-derived value (e.g. `missive_conversation`, per 1.2's note on new `source_type` values) — nothing here changes today's four Latchel `source_type` values or their existing citation discipline.

### 1.3 What does NOT get built now: `claim_heads` and automatic conflict detection

This is the direct answer to the question Peter asked to reconsider.

**`claim_heads` do not get built now.** They solve write contention and "what's the current answer" for facts that get **asserted repeatedly, by possibly-different sources, about the same (subject, predicate)** — a roof age reported once by an inspection and again, differently, by a vendor invoice. Nothing in any claims domain spec'd so far — maintenance, or the email-derived claims this document proposes — actually works that way. Every claim in this system today is a fact about **something that happened** (an event, a decision someone made, evidence of an outcome, a link to another ticket) — append-only by nature, not a mutable property being re-asserted over time. There is no predicate here like the thesis's own example, `condition.roof_age`, where two claims can legitimately compete to be "the current truth." Building the pointer-and-optimistic-concurrency machinery the crane spec's write path describes (steps 3–5: look up policy, check idempotency, insert, compare to existing head, update head under a version check) would be solving a race condition that cannot currently occur in this system, because nothing here ever needs one claim to structurally replace another as "the accepted answer" — every claim just sits in the store, cited, and a human decides what to do with it.

**What would change this:** the day a domain produces two claims about the *same fact* from *different sources* that can disagree — e.g., an AppFolio-synced lease-end-date and an email-extracted claim about a different move-out date, both about the same lease, both claiming to be current. That is a genuinely different shape of problem than anything built so far, and it's the concrete trigger to revisit `claim_heads`.

**Automatic conflict detection does not get built now**, for the same underlying reason — it needs a `claim_head` (or an equivalent "current answer") to detect a disagreement *against*. A cheaper, real substitute ships instead: any review-queue view (Tron's job, later) that shows an unreviewed claim already joins in "other claims about the same subject + claim_type," so a human reviewing one claim sees a genuine disagreement sitting right next to it, without any new schema or write-path logic. This is not automatic detection — nothing is flagged or blocked on its own — but it removes the "a human would have to happen to notice" failure mode at near-zero build cost, and it's the honest middle step between "nothing" and "the full thesis mechanism," matched to what's actually needed today.

**What would change this:** the same trigger as `claim_heads` above (a second real source disagreeing about the same fact), plus claim volume per subject growing large enough that a human skimming a joined list stops being a reliable way to spot a disagreement — at which point automatic detection earns its complexity.

### 1.4 What DOES get adopted from the thesis, partially and deliberately: fail-closed type registration

The crane spec's `promotion_policies` table does two things at once: it registers what's allowed (fail-closed — an unregistered predicate is rejected, not silently accepted), and it routes what's registered (`auto_accept` / `review` / `escalate`). This system has no use for the routing half — nothing here is designed to auto-accept a claim past a human, on purpose, twice already (Maintenance History's schema comments say so explicitly; this document doesn't change that). But the fail-closed registration half is a genuinely good, cheap idea worth adopting on its own:

```
claim_type_registry
  domain        TEXT NOT NULL
  claim_type    TEXT NOT NULL
  description   TEXT NOT NULL
  is_active     BOOLEAN NOT NULL DEFAULT TRUE
  PRIMARY KEY (domain, claim_type)
```

Seeded on creation with exactly the four already-proven maintenance types (`maintenance`/`event`, `maintenance`/`decision`, `maintenance`/`outcome`, `maintenance`/`recurrence`) — nothing invented, just made explicit and enforced. Every extraction pipeline (today's Latchel one, the email pipeline below, any future domain) checks a candidate claim's `(domain, claim_type)` against this registry before insert; an unregistered pair is rejected and logged, never silently written with a type nobody defined. A new domain's first real engineering step is registering its vocabulary here — a maintained, reviewable code-and-table asset, the same "don't guess the taxonomy, check it against real data" discipline `property-overview-SPEC.md` already applied to its own component categories.

### 1.5 Why not the thesis's `entities` abstraction, yet

The thesis's `entities` table exists to solve a different scaling problem than the one above: as more domains join, a claims table needs more and more nullable "which thing is this about" foreign keys (`property_id`, `maintenance_request_id`, and eventually `lease_id`, `tenant_id`, `vendor_id`...) unless subjects get abstracted behind one polymorphic `entities` table with a single `subject_entity_id` column.

That's a real problem, but not one that exists yet: every domain concretely in scope right now — maintenance (existing) and the email-derived claims this document proposes — needs exactly the two subject columns already above, `property_id` and `maintenance_request_id`, which is the exact same pair the prior round's email-context design already proved out. Building the `entities` abstraction today means designing it against a hypothetical third subject type, not a real one — the same over-building this document just argued against for `claim_heads`.

**The concrete trigger:** the day a domain needs `claims` to point at something neither `property_id` nor `maintenance_request_id` can express — a lease-renewal domain needing `lease_id`, a tenant-issue domain needing `tenant_id`/`contact_id` — is the day to add `entities`, and it should be added *then*, generically, rather than bolting on a fourth or fifth nullable column. Flagging this now so whoever specs the first lease or tenant-issue tool knows to raise it, not rediscover it.

### 1.6 Migration path for `maintenance_claims` — deferred, not silently changed

`maintenance_claims` is real, working code today (`router.js`, the dashboard, the nightly ingestion job all read and write it). This document does **not** propose touching it now. The generalized `claims` table above is new, additive infrastructure that ships alongside it, not a replacement on day one.

**The deferred step, named so it doesn't get forgotten:** once a second domain is actually live and writing to `claims` (Phase 3 below proves this), `maintenance_claims` gets backfilled into `claims` (`domain='maintenance'`) and converted into a compatibility view over it — Postgres can make a simple, single-table, filtered view like this auto-updatable, so existing INSERT/SELECT code in `router.js` keeps working essentially unchanged; Neo should confirm the exact mechanics (a plain updatable view vs. an `INSTEAD OF` trigger) at that time, once there's a second domain's real data to test the migration against. Doing this now, before a second domain exists to prove the shared shape actually holds, would be exactly the kind of building-ahead-of-a-proven-need this codebase has consistently avoided (see both `property-overview-SPEC.md`'s and the maintenance-history migration's own "deliberately not built" sections).

---

## 2. The Relevance/Routing Design — Multi-Label, Understanding-Based, Sequenced

### 2.1 The one non-negotiable rule

**The privilege/legal-hold filter runs first, on every thread, before anything else — including the new AI reading step — touches its content. No exception, ever.** This is the same ordering the prior spec already committed to, restated here because it matters even more now: the whole reason a keyword-only relevance gate isn't good enough is that it's being replaced with an actual AI reading the content, which makes the "cheap, deterministic, already-legally-cleared check runs first" rule more important, not less. A privileged or legal-hold thread must never reach an AI reading step in the first place, regardless of how good that step is.

### 2.2 The pipeline

```
Stage 0 — Privilege / legal-hold filter (unchanged, existing code)
  processThread()'s privilege half runs on every thread, full stop.
  HELD  -> stop here. Nothing proceeds. No AI ever reads this content.
           An audit_log entry is written (thread ID + hold reason,
           never content). This is identical to today's behavior.
  Not held -> continue.

Stage 1 — Fair Housing / protected-class scan (unchanged, existing code)
  Runs on every non-held thread. Flags, does not block — matches
  today's behavior exactly. The flag travels with anything this
  thread produces downstream (Stage 3).

Stage 2 — Understanding: ONE read, MULTIPLE labels, MULTIPLE claims (NEW)
  This is what actually changes. A single AI call reads the
  (already privilege-cleared) thread once and produces:
    (a) a multi-label relevance decision — which registered domains
        this thread is relevant to (maintenance: yes/no, and so on
        for every domain in claim_type_registry) — NOT a binary
        yes/no the way the prior design worked. A thread can be
        maintenance-relevant AND lease-relevant at once; both get
        recorded, neither is forced to pick one.
    (b) for each domain the thread matched THAT ALSO HAS A
        REGISTERED CLAIM-TYPE VOCABULARY, extracted claims in that
        domain's own vocabulary — reusing extract-claims.js's exact
        two hard rules (cite a source, say unknown rather than
        guess) and its citation discipline, just against email text
        as the source instead of a Latchel job/PDF.
    (c) for a domain the thread matched but which has NO registered
        vocabulary yet (a future domain not built out), nothing is
        extracted — but the match itself is NOT silently dropped.
        It's recorded as `unhandled_domains` (Section 2.4) so a
        future domain-extractor build has a real signal of demand
        waiting for it, instead of that signal being lost forever
        because nobody built the reader yet.

Stage 3 — Content check + store (existing module, new call sites)
  Every candidate claim from Stage 2b runs through the existing,
  unchanged two-layer content check (content-check.js) before
  insert — same as today. Flagged claims are never deleted, never
  silently included, structurally excluded from
  claims_decision_safe (Section 1's generalized version of
  maintenance_claims_decision_safe), and logged.
  Passing claims are inserted into `claims`, validated first
  against claim_type_registry (Section 1.4) — an extraction
  producing an unregistered (domain, claim_type) pair is rejected
  and logged, not silently written.
```

### 2.3 Subject-linking stays rule-based — this is a genuinely different problem than relevance

Peter's critique was specifically that deciding "is this email about maintenance at all" can't be done reliably with keywords — that's a hard, meaning-dependent judgment. Deciding "which property/ticket does this matched thread belong to" is a different, easier problem: matching known address strings and vendor emails against text already in memory. The prior spec's rule-based property/address matcher (Signal 1: address match against `properties`; Signal 3: known vendor sender, corroborating only) was never the part Peter objected to, and it stays — just repositioned. It no longer *gates* whether the AI gets to read a thread (Stage 2 runs on every non-held thread regardless); it now runs alongside Stage 2 to resolve each extracted claim's `property_id`/`maintenance_request_id`, the same subject-linking job it already did, on the same evidence it already used.

### 2.4 What gets stored about the routing decision itself — a new, deliberately thin table

The thread's own relevance decision (which domains it matched, whether it was held/tagged, what claims it produced) needs a durable, queryable record — but per Section 4 below, **the raw thread content itself is not stored a second time anywhere in this system.** A small, content-free routing record replaces the prior design's `maintenance_email_context` table (which stored full verbatim thread text):

```
thread_routing_decisions
  id                        UUID PK
  thread_id                  TEXT NOT NULL UNIQUE   -- external Missive conversation ID

  privilege_outcome           TEXT NOT NULL CHECK (privilege_outcome IN ('held','tagged','clear'))
  privilege_tags               TEXT[]
  fair_housing_flagged          BOOLEAN NOT NULL DEFAULT FALSE
  fair_housing_categories        TEXT[]

  matched_domains                 TEXT[]      -- e.g. {'maintenance'}, {'maintenance','lease_renewal'}, or {}
  unhandled_domains                TEXT[]      -- relevant, but no extractor registered yet — never silently lost

  claim_ids                         UUID[]     -- claims rows this thread produced, across every domain

  safety_layer_version               TEXT NOT NULL   -- from the shared version manifest, Section 3
  classifier_model_version            TEXT            -- NULL when privilege_outcome = 'held' (no AI ran)

  pipeline_reviewed                    BOOLEAN NOT NULL DEFAULT FALSE   -- shadow-period workflow, unchanged intent
  reviewed_by                           TEXT
  reviewed_at                            TIMESTAMPTZ
  reviewer_notes                          TEXT

  created_at / updated_at                  TIMESTAMPTZ
```

No `thread_text`, no `subject`, no `participants`, no content of any kind. This table answers "what did the pipeline decide and why" for audit and shadow-mode review — it does not answer "what did the email say," which is Missive's job (Section 4).

### 2.5 Fail-closed, without inventing new machinery — same posture as before, restated for the new design

The prior spec's answer to "should ambiguous content default to held for review" still applies and still doesn't need a new permanent holding queue: the extraction step is instructed the same recall-biased way the keyword lists already are (a real maintenance-adjacent thread that's genuinely ambiguous should tend toward being labeled relevant, not excluded by a coin flip), a NOT_RELEVANT-for-every-domain decision never means deletion (Missive is untouched regardless), every decision is logged, and the actual "hold for review" mechanism is temporal — the shadow period (Section 7) requires a human to check every decision against the live thread before this pipeline is trusted for normal use. That mechanism is, if anything, more justified now than before: an AI is reading content it wasn't reading under the old design, which is exactly the kind of change that deserves full-review shadow verification, not less.

### 2.6 Audit Log Guidance for Q — Generalized Across Domains, Plus the New Routing Decision

`20260815010000_maintenance_history_schema.sql`'s "AUDIT LOG GUIDANCE FOR Q" section gives field-by-field guidance for three event types, written narrowly against `maintenance_claims` and the Latchel pipeline. This generalizes that guidance to the shared `claims` table (Section 1) and adds a fourth event type the prior guidance never needed, because Stage 2 (2.2) introduces a kind of AI decision that had no analog in the maintenance-only design. All four follow the same discipline the original section established: nothing invented beyond Rule 1's field list and the prior migration's own pattern, and `event_data` never contains thread content, a subject line, or a claim's `claim_text` verbatim — citation-shaped references only, the same posture `thread_routing_decisions` itself already keeps (2.4).

1. **Claim extraction/ingestion run** (generalized from `maintenance_claims.ingestion_run`) — one entry per run per subject touched, any domain, any source:
   - `event_type` = `claims.extraction_run`
   - `entity_type` = whatever the domain's subject-linking (1.2, 2.3) resolved to for this run (`'maintenance_request'`, `'property'`, or a future domain's subject type) — not hardcoded to maintenance
   - `entity_id` = that subject's id
   - `actor_type` = `'ai_agent'` (an extraction model produced the claims this run inserted); `'system'` only for a run that touched zero claims
   - `actor_id` = the extraction model identifier for that domain/source
   - `actor_version` = the actual model version string used
   - `privacy_category` = `'collection'` for a structured-API-sourced run (unchanged from today); `'processing'` for an email-sourced run — reading and interpreting a thread that already exists in Missive is not new collection, it's the system processing content it already had access to, the same Solove distinction the routing entry below relies on
   - `risk_level` = `'low'` unless the run itself surfaced a protected-class flag (then see #2)
   - `event_data` = `{ domain, claim_ids, claim_types, source_type, source_files_read }` — on an email-sourced run, `source_files_read` is thread/message IDs only, never a subject line or body text, per 1.2.1

2. **Protected-class exclusion** (generalized from `maintenance_claims.protected_class_excluded`):
   - `event_type` = `claims.protected_class_excluded`
   - `entity_type` = `'claim'`, `entity_id` = the claim's `claims.id`
   - `actor_type` = `'system'` if `matched_layer = 'keyword'`; `'ai_agent'` if `matched_layer = 'model'`
   - `actor_id` = the shared term-list module's identifier (post-relocation per Section 3) for the keyword layer, or the same extraction-model `actor_id` as #1 for the model layer
   - `actor_version` = the shared term list's version (Section 3's `VERSIONS.js` manifest) for the keyword layer, or the model version for the model layer
   - `privacy_category` = `'processing'`
   - `risk_level` = `'high'`
   - `event_data` = `{ domain, flagged_category, matched_layer, claim_type, source_reference }` — deliberately never the flagged text itself, same as today

3. **Human review action** (generalized from `maintenance_claims.reviewed`):
   - `event_type` = `claims.reviewed`
   - `entity_type` = `'claim'`, `entity_id` = the claim's id
   - `actor_type` = `'human'`, `actor_id` = the reviewer's email (`team_members.email`, matching the existing `reviewed_by` convention)
   - `privacy_category` = `'processing'`
   - `risk_level` = `'low'`, unless the outcome is `'corrected'`/`'rejected'` on a claim that was also `flagged_protected_class`, in which case `'medium'` — unchanged from today
   - `event_data` = `{ domain, review_status, reviewer_notes, correction_reason_code }` — `correction_reason_code` added per Section 6, absent from the prior migration's guidance because that field didn't exist yet

4. **NEW — the Stage 2 domain-match / routing decision.** Nothing in the maintenance-only design made this call: a keyword check either matched "maintenance" or it didn't, and that binary check was never treated as an independent Rule 1 decision worth its own audit entry. Stage 2 is different in kind — one AI call reads a thread's content and decides which of potentially several registered domains it's relevant to (2.2), including domains with no extractor built yet (`unhandled_domains`). That is an AI decision about a person's correspondence, made before any claim exists to attach an audit entry to, and it needs its own Rule 1 entry. A `thread_routing_decisions` row (2.4) records the same facts for querying and shadow-mode review, but it is not an `audit_log` entry and does not substitute for one — `thread_routing_decisions` carries no `actor_version`/`privacy_category`/`risk_level`/hash-chain fields and was deliberately designed content-free and thin (2.4), not as Rule 1's system of record.
   - `event_type` = `thread_routing.domain_match_decision`
   - `entity_type` = `'thread_routing_decision'`, `entity_id` = the `thread_routing_decisions.id` this call produced
   - `actor_type` = `'ai_agent'` (Stage 2 ran). A thread that stopped at Stage 0 (`privilege_outcome = 'held'`) never reaches Stage 2 — that case is already covered by Stage 0's own existing audit entry (2.2: "An audit_log entry is written... thread ID + hold reason, never content") and gets no Stage 2 entry on top of it
   - `actor_id` = the classifier/understanding-step model identifier — distinct from any single domain's extraction-model `actor_id` in #1, since Stage 2 is domain-agnostic by design (2.2)
   - `actor_version` = the classifier model version string used, matching `thread_routing_decisions.classifier_model_version`
   - `privacy_category` = `'processing'` — the thread already exists in Missive (Tier 0, Section 4); this call is the system reading and interpreting content it already had access to in order to make a determination, not new collection
   - `risk_level` = `'medium'` by default (an AI read personal correspondence to make a determination about it — inherently more sensitive than a keyword match ever was, per 2.5); `'high'` if `fair_housing_flagged = TRUE` on the resulting `thread_routing_decisions` row, matching #2's own escalation logic for protected-class content
   - `event_data` = `{ matched_domains, unhandled_domains, fair_housing_flagged, fair_housing_categories, safety_layer_version, claim_ids }` — thread ID only, never subject, never body, never a snippet, same discipline `thread_routing_decisions` itself keeps (2.4)

All four should also set `instance_id`/`decision_id`/`action_id`/`context_snapshot`/`regulation_tags`/`legal_basis`/`contact_id`/`property_id` per `audit_log`'s standard shape wherever a real value is available — none of those are invented here, since they depend on data this document doesn't have visibility into, the same caveat the original migration's guidance already carried.

---

## 3. The Reusable Safety-Layer Architecture

Nothing about `privilege-filter.js`'s or `fair-housing-filter.js`'s actual logic changes — that instruction is followed exactly. What changes is how the module is positioned, versioned, and enforced as genuinely shared infrastructure rather than one feature's private library that other things happen to import from.

**1. Physical location (a Q task once this document is approved, not executed by this document).** `projects/hub/email-intake/lib/` is a feature-shaped name for what is, in practice, already cross-feature code — `fair-housing-filter.js` today reaches *into* `maintenance-history/lib/protected-class-terms.js` for its own term list via a relative path, which is backwards: a "shared" module depending on a single domain's private library for its most important shared asset. The recommended target is a domain-neutral home, e.g. `projects/hub/lib/content-safety/`, parallel to the genuinely hub-wide utilities already there (`property-search.js`, `global-search-widget.js`). `protected-class-terms.js` moves there too, since it's already, in practice, shared by two consumers today (the Fair Housing filter and Maintenance History's own content check) wearing one feature's directory as its home. Once colocated, every current and future consumer — Maintenance History's `content-check.js`, the new relevance/routing pipeline, any future domain extractor — imports from one shared location, and there is exactly one place a version bump is felt.

**2. Versioning.** `protected-class-terms.js` already has this right (`TERMS_VERSION`, bumped on every list change, written into `audit_log.actor_version`). The same discipline should extend to `privilege-keywords.js` and `government-legal-domains.js` if either lacks its own version constant today — worth Q confirming and adding when the relocation happens, since a compliance review needs to be able to say exactly which version of *every* shared list produced a given hold/tag/flag decision, not just the protected-class one.

**3. A single version manifest — the concrete mechanism for incremental governance (Section 8).** One small file (e.g. `projects/hub/lib/content-safety/VERSIONS.js`) listing the current version of every shared component: the privilege-filter/fair-housing-filter logic itself (bumped only when the actual filtering logic changes, not when a new consumer is added), and each keyword/domain list's own version. This is the one artifact a lighter, incremental governance check can look at and answer objectively: did anything in the shared core change since the last full review, or is a new domain just plugging into an unchanged core? See Section 8.

**4. The calling contract.** `index.js`'s `processThread()` stays exactly as-is — same signature, same two-tier privilege/Fair Housing output. What's new is the contract around it: **every current and future pipeline that reads personal correspondence content with AI must call `processThread()` first, unconditionally, before its own domain logic runs — not just the maintenance/email pipeline this document specifies.** Recommend making that explicit in the module's own top-of-file comment (it already has a clear "NOT CONNECTED TO ANY REAL EMAIL SYSTEM" banner; the same treatment should state the mandatory-first-gate contract directly in the code, not only in a spec document a future domain's builder may not re-read).

---

## 4. Retention and Access Tiers

The task was explicit that this needs more deliberateness than anywhere else in the system, because this is the first tool touching people's actual words rather than a distilled fact or a structured field. The single decision that does the most work here: **the raw email thread is never duplicated into Rincon's own database by this pipeline.** Only distilled, cited claims are stored durably. This is a real, deliberate change from the prior round's design (which stored full verbatim `thread_text` for inline reading in the Hub) — flagged plainly here, not slipped in, because it trades a piece of staff convenience (reading a thread inline in the Hub) for a materially smaller retained-PII footprint on what is, by the task's own framing, the most sensitive table this system will ever have. If that trade turns out to be wrong in practice, a narrower, separately-governed "store the verbatim thread too" addition can be layered on later — it should not be the v1 default.

**Tier 0 — Raw source (Missive itself).** Never copied into Supabase by this pipeline, at any stage. Retention is governed by Rincon's Missive account settings/policy — **not yet confirmed** (see Open Items). Access: whoever already has shared-inbox access today — unchanged. The "view in Missive" link on a claim's citation is the actual mechanism for reading full context, not a database copy.

**Tier 1 — Transient, in-memory content (one classification/extraction pass).** A thread's body exists in the ingestion process's memory only for the duration of Stage 0→1→2 (seconds), and is sent once to the Anthropic API for the understanding step. Never written to disk. Never logged — the existing extraction module already sets this precedent (`extract-claims.js` explicitly avoids logging raw model responses pre-content-check; the new pipeline must follow the identical discipline). **What can't be fully guaranteed and should be stated honestly rather than glossed over:** content sent to the Anthropic API is, briefly, outside Rincon's own infrastructure. Anthropic's standard commercial API terms do not use customer inputs to train models and apply a limited retention window for abuse/safety monitoring — the *exact* terms in Rincon's own agreement should be confirmed by Sentinel/Peter directly against Rincon's actual contract before this ships, since this document can verify a general practice, not a specific contract it hasn't seen.

**Tier 2 — Extracted claims (`claims` table).** The durable record. A cited, distilled sentence, not a raw thread — meaningfully lower PII density than what the prior design would have stored, by the same logic the prior spec's own data-inventory note already applied when it called `thread_text` "the single highest-PII-density field in this schema... more sensitive... because it's the verbatim source, not a distilled fact." Retention: indefinite, redact-in-place on a CCPA request (`claim_text` → `"[REDACTED]"`, same mechanism already proven on `maintenance_claims`) — and genuinely *simpler* here than the prior design's problem, because a claim is (by construction) usually about one fact/one person's situation, not several people's words commingled in one field the way a raw thread is. Access: `reviewer`/`admin` roles only, by default — narrower than the general property-manager-tier read this schema grants elsewhere, for every domain fed by this pipeline, not just email-derived maintenance claims.

**Tier 3 — Audit records (`audit_log`, `thread_routing_decisions`).** Metadata only — thread ID, decision, matched/unhandled domains, which claims resulted, never content. Retained indefinitely under `audit_log`'s existing, already-documented CCPA security/fraud exemption (Cal. Civ. Code § 1798.105(d)(9)). Access: whoever already has audit-log access today — this document adds no new audit-log access tier.

**The access matrix, plainly:**

| Who | Sees |
|---|---|
| General Hub staff | Nothing from this pipeline by default — same conservative default the prior design already recommended, now applying platform-wide, not just to email context. |
| `reviewer` (per-domain) | Unreviewed/flagged claims in their domain's review queue (Tier 2). |
| `admin` | Everything `reviewer` sees, across every domain. |
| Anyone, any role | Never the raw Missive conversation through this system — only the citation and a link to read it in Missive directly, under their own existing Missive access. |
| The ingestion process (service-role key) / Anthropic API | Transient access only (Tier 1), exactly as documented in the data inventory below. |

---

## 5. Data Inventory (GOVERNANCE.md Rule 4)

- **`pii_fields`:** `claims.claim_text` (unchanged risk profile from today's `maintenance_claims.claim_text` — the highest-PII-density *stored* field, now shared across domains instead of siloed per-table), `claims.reviewer_notes`, `claims.flagged_category`. `thread_routing_decisions` carries no PII fields at all by design (no content columns) — worth stating explicitly since it's a deliberate difference from every other table this system has built so far.
- **`agents_with_access`:** Claude (existing `ANTHROPIC_API_KEY`) for the understanding/extraction step and protected-class flagging, transient only per Tier 1 above; the scheduled ingestion process (system, service-role key); Hub users holding `reviewer`/`admin` for the relevant `tool` value in `team_member_tool_roles`.
- **`privacy_category`:** Personal correspondence, distilled — more sensitive than any existing structured-field-derived table, less sensitive than a verbatim-thread design would have been.
- **`retention_policy`:** PLACEHOLDER pending Mason, same explicitly-allowed pattern used on every comparable table in this schema to date.
- **`ccpa_exportable`:** TRUE.
- **`ccpa_deletable`:** TRUE — redact `claim_text`/`reviewer_notes` to `"[REDACTED]"` in place, preserve `domain`/`claim_type`/`claim_date`/`source_reference` for audit continuity. `thread_routing_decisions` has no content field to redact at all; a deletion request against it, if ever needed, only ever touches `reviewer_notes`.
- **RLS:** enabled, no permissive policies at creation, on both new tables — matches every table in this schema.
- **Every new domain (Phase 3+) requires its own addendum here, not an assumption this entry already covers it.** The entries above are written against maintenance-shaped email content specifically — health/medical mentions, tenant names, the actual content this document's own review surfaced. A lease-renewal or tenant-issue domain's claims can carry a materially different PII profile (financial detail, household composition, disability-accommodation requests) that this entry cannot be assumed to already describe correctly. This is not left implicit: it is one of Section 8's incremental-track conditions (condition (e)) — whoever builds a new domain's extractor files a domain-specific `privacy_category`/`pii_fields` addendum to this section before that domain goes live, reviewed the same way this entry was.

---

## 6. The Feedback Loop — Human Corrections as a Standing Calibration Signal

The original 10-ticket test's grading pass (fully correct / partial / wrong / missed / wrong-source) was a one-time, manual exercise. Making that discipline durable means every real correction a reviewer makes gets captured in a form that can be aggregated later, not just fixed in place and forgotten.

**Mechanism:** `claims.correction_reason_code`, required (not optional) whenever `review_status` moves to `corrected` or `rejected` — a small, controlled vocabulary, generalized from the same failure shapes the original test actually surfaced and from the review categories `answer-key-template.md` already established:

- `WRONG_SOURCE` — the claim isn't actually supported by what it cites.
- `HALLUCINATED_DETAIL` — the claim states something not present in the source at all.
- `WRONG_SUBJECT` — the fact is right, but linked to the wrong property/ticket.
- `WRONG_CLAIM_TYPE` — right fact, wrong bucket (e.g., filed as `event` when it's really a `decision`).
- `MISSED_NUANCE` — technically sourced, but the phrasing misleads or drops important context.
- `STALE_ON_ARRIVAL` — accurate when extracted, superseded by a later fact the pipeline should have connected.
- `PROTECTED_CLASS_MISS` — the content check should have flagged this and didn't. High-priority: this is a direct Rule 9 signal, not just a quality one.
- `OTHER` — free text in `reviewer_notes` required.

**The loop, concretely:** a monthly (not the shadow period's daily/weekly — this is ongoing quality drift, not active-pilot miss-catching) query groups corrections by `domain` + `claim_type` + `source_type` + `correction_reason_code` + `extracted_by` (the model version string already stored on every claim). A real pattern — e.g., email-sourced maintenance claims getting `WRONG_SOURCE` corrections at a materially higher rate than Latchel-sourced ones — is exactly the kind of signal that should drive a specific, targeted fix: a prompt revision, a keyword-list addition, a claim-type boundary clarification — each one a version bump in the manifest from Section 3, closing the loop back into the version-based governance trigger. Owned by whichever `reviewer` covers that domain, escalated to Mason immediately (not held for the monthly rollup) on any `PROTECTED_CLASS_MISS`, and reported to Peter in the same spirit as the shadow period's existing weekly rollup. No new UI is required for v1 — this is a SQL query a reviewer runs, promoted to a dashboard only once the habit proves itself, matching this codebase's own established "don't build ahead of a proven need" pattern.

---

## 7. Shadow Mode — Inherited, Not Loosened

Asimov's 90-day, full-review shadow period (`shared-inbox-risk-assessment.md`) was scoped to a rule-based relevance classifier reading nothing with AI. This design now has an AI reading every non-held thread — a change that argues for at least the same rigor, not less. Recommend Asimov re-confirm the 90-day, 100%-review track applies here too, with the review question widened to match what actually changed: not just "was the relevance/privilege call right," but "was the multi-label domain match right, and was every extracted claim's citation actually verifiable against the source thread."

**Concretely, the shadow-period reviewer checklist per thread should include:**
- Was the privilege/legal-hold call right (unchanged from before)?
- Was every domain in `matched_domains` actually correct — no false positive?
- **Was anything relevant left out of `matched_domains` and `unhandled_domains` both — a false negative on the multi-label call itself?** This is the failure mode the prior maintenance-only design had no way to even ask about, and it's easy to miss precisely because a false negative here produces no record to review against by default: a thread that should have matched a not-yet-built domain (an `unhandled_domains` case, per 2.2(c)) but that Stage 2 didn't flag as relevant to *any* domain, so it never landed in `unhandled_domains` either — the demand signal 2.2(c) exists to capture is silently lost, exactly the way it would have been lost under the old keyword-only design. Checking this requires the reviewer to read the live thread itself (Tier 0, Section 4) against what the pipeline decided, not just audit the decisions the pipeline actually recorded — the same asymmetry 2.5's recall-biased instruction is meant to guard against, verified here rather than assumed.
- Was every extracted claim's citation actually verifiable against the source thread — specifically, does `source_reference` hold only the four permitted fields and does `claim_text` read as a distilled paraphrase, per 1.2.1's rules?
- For any thread with `fair_housing_flagged = TRUE`, was the flag itself correct, and did the audit entry escalate to `risk_level = 'high'` per 2.6 #4?

The existing exit criteria (zero missed privilege/legal-hold threads, a documented and fixed error-rate pattern, Peter's own sign-off, Asimov's formal sign-off) all still apply unchanged — this document does not propose loosening any of them.

---

## 8. Governance That Scales Incrementally — A Proposed Structure, Not a Final Policy

This is explicitly Asimov's call, not this document's. What follows is a concrete structure that would make a lighter incremental review *possible* — proposed for Asimov's actual approval, not asserted as decided.

**Core (reviewed once, in full — comparable in weight to the six-condition review Maintenance History already went through):** the shared safety layer itself (`processThread()`, its keyword/domain lists, and the mandatory-first-gate sequencing rule); the `claims` table's core discipline (mandatory citation, the review gate with no auto-promote path, the content check, the audit-log shape); the `claim_type_registry` fail-closed mechanism; the version-manifest mechanism from Section 3.

**Incremental (a narrower, faster check, proposed for a new domain that changes none of the above):** a new domain-specific extractor that (a) calls the existing, unchanged `processThread()` first, (b) registers its claim-type vocabulary in `claim_type_registry` rather than inventing new columns, (c) writes into the existing `claims` shape with no schema change, (d) reuses the existing review-gate and audit-log patterns as-is (Section 2.6), (e) files its own `privacy_category`/`pii_fields` data-inventory addendum per Section 5 — every domain's claim content differs enough that Section 5's existing entry, written against maintenance-shaped content, cannot be assumed to already cover a new domain without someone actually looking at what that domain's claims contain, and (f) passes a scaled-down version of the original 10-ticket test — real data from that domain, blind-graded, the same fully-correct/partial/wrong/missed/wrong-source categories — before going live under this track. Beyond (a)–(f), the track should only need Mason's spot-check that the new vocabulary doesn't itself invite protected-class predicates, and confirmation that its extraction prompt preserves the two hard rules (cite source, say unknown). **The version manifest is the objective trigger for everything above it, not a substitute for (e) or (f):** if a new domain's build leaves every core-component version in the manifest unchanged, the incremental path is what Asimov is being asked to approve as sufficient — provided (e) and (f) are also satisfied, since an unchanged manifest speaks only to the shared safety layer, not to the new domain's own PII profile or extraction accuracy (see below). If the new domain needs a real core change — a new subject-type column (triggering the `entities` question from 1.5), a new external credential, a new source-of-content type the safety layer hasn't seen before — that pushes it back to a full core-level review, because at that point it isn't incremental, it's a second core change wearing a new domain's name.

**A hard disqualifier, not a spot-check.** The incremental track above assumes a new domain's claim-type vocabulary is comparable in kind to maintenance's four types (event/decision/outcome/recurrence) — factual, not itself about a protected characteristic. That assumption can be wrong: a domain whose claim types are inherently protected-class-shaped — a claim type that is itself about disability status, familial status, source of income, or any other Rule 9 category, as distinct from a claim type that might incidentally surface protected-class content the way maintenance claims sometimes do — never qualifies for the incremental track, full stop, regardless of what the version manifest shows. An unchanged `safety_layer_version` proves the shared filtering code didn't change; it says nothing about whether the new domain's own vocabulary was built around a protected characteristic in the first place, which the manifest cannot answer either way. This is a disqualifying condition, checked before the version-manifest check is even relevant — not folded into Mason's spot-check above, because a spot-check implies a judgment call on a borderline case, and this isn't borderline: any domain whose vocabulary is built around a protected characteristic goes to full core-level review, no exception.

**Why the accuracy proof (incremental condition (f)) can't be skipped even when the manifest is unchanged.** An unchanged `safety_layer_version` proves the shared privilege/Fair Housing/content-check code didn't change — it proves nothing about whether the new domain's own extraction is actually accurate against real data, because that extraction logic is, by definition, new code the manifest has never scored. Condition (f) is that proof: not a full 90-day shadow rerun (Section 7 covers that separately, and still applies regardless of track), but a real, domain-specific accuracy check — the same scaled-down 10-ticket-style test Maintenance History itself was built and cleared against, sized to the new domain, completed before that domain goes live under the incremental track.

**Section 6's feedback loop and this section's scaling rules, made explicit so they don't contradict each other.** Section 6 describes corrections driving "a specific, targeted fix: a prompt revision, a keyword-list addition, a claim-type boundary clarification — each one a version bump in the manifest." Read alone, that sentence could be misread as saying any such change — including a protected-class keyword-list change — only needs a version bump to ship. It doesn't. A change to the protected-class term list itself (Layer 1's `TERMS_VERSION`, Section 3) is a change to `processThread()`'s guardrail logic, and guardrail changes are GOVERNANCE.md Rule 6's **Critical** tier: owner approval, attorney review, and 7 days of shadow mode before it ships — not merely a version-manifest bump that this section's incremental track would otherwise wave through. A prompt revision or claim-type boundary clarification scoped to one domain's own extraction logic is Rule 6 **Standard** (owner approval) at most, and stays on the version-manifest path this section already describes. The dividing line is Rule 6's own: does the change touch decision criteria, compliance logic, or guardrails (protected-class term lists, `processThread()`'s actual filtering logic) — Critical, full stop, no matter how small the diff looks in the manifest — or does it touch a domain's own extraction prompt or vocabulary, which is Standard at most.

---

## 9. Size and Phased Build Plan

Honestly: this is bigger than anything spec'd in this project so far. The base Maintenance History build (new external API, a from-scratch extraction pipeline, a new content check, a new review gate) ran roughly Neo 1–2 / Q 3–4 / Tron 1–2 sessions. This document's design carries that same weight on the schema-generalization side, and adds a genuinely new and harder engineering problem on top: multi-label AI classification (not binary), per-domain claim extraction from free-form correspondence (not a structured API), and citation validation against arbitrary email text (not a fixed PDF/field). It should not be built as one project. The phased order below is the smallest real step that proves the architecture actually works, before committing to the rest.

**Phase 1 — Foundational schema. Additive only, zero risk to anything already built.**
Neo: the generalized `claims` table, `claims_decision_safe` view, `claim_type_registry` (seeded with the four existing, already-proven maintenance types). `maintenance_claims` is untouched — no migration yet (Section 1.6). This phase's only goal is to stand up the shared store and prove the registry mechanism, even smoke-testable by copying a handful of real, already-graded `maintenance_claims` rows across without removing the originals.
*Rough shape: Neo 1 session. No Q, no Tron — nothing consumes this table yet.*

**Phase 2 — The understanding pipeline, proven against exactly one domain first.**
Q: relocate/version the shared safety-layer modules per Section 3 (mechanical, no logic change). Build Stage 0→1→2→3 (Section 2), with Stage 2's extraction scoped initially to detecting and extracting maintenance-domain claims only — proving "read once, cite everything, land in the shared store" end-to-end before adding a second domain's vocabulary. Multi-label detection and `unhandled_domains` logging can and should exist from day one even though no second domain's extractor exists yet — cheap to build now, and it's the concrete proof that the multi-label design itself works, without requiring a second full domain to be built to test it.
Neo: `thread_routing_decisions` (Section 2.4).
Shadow mode per Section 7 — same 90-day, full-review bar, now covering the multi-label and citation-validation calls specifically.
*Rough shape: comparable to the prior round's own estimate for its narrower version — Neo ~1, Q ~2–3, Tron ~1–2 — plus a real governance pass per Section 8's "core" track, since this phase changes the shared safety layer's calling contract for the first time.*

**Phase 3 — Prove the second domain. This is the actual test of "shared, not narrow."**
Once Phase 2 is shadow-verified and live, build exactly one additional domain's claim-type vocabulary (tenant-issue or lease-renewal — Peter's call on order) against the *same* pipeline, *same* safety layer, *same* `claims` table — no new pipeline, no new safety layer, no new table. This phase should be measurably smaller than Phase 2 specifically because the expensive, novel infrastructure is already built and proven; if it isn't smaller, that's a signal the architecture didn't actually generalize the way this document claims it will, and worth stopping to reassess rather than pushing through.
*Rough shape, per Section 8's "incremental" track if the version manifest holds: Neo 0 (registry rows only, no schema change), Q 1–2, Tron 1.*

**Phase 4 — Deferred, named triggers, not scheduled:**
- The `maintenance_claims` → `claims` compatibility-view migration (Section 1.6), once Phase 3 proves the shared shape holds for a second domain and the cost of maintaining two parallel stores starts actually costing something real.
- `claim_heads` and automatic conflict detection (Section 1.3), the day a second source produces a genuinely disagreeing claim about the same fact.
- The `entities` abstraction (Section 1.5), the day a domain needs a subject type `property_id`/`maintenance_request_id` can't express.

---

## Open Items — Needs Confirming Before Any of This Gets Built

1. ~~The raw-thread-storage trade-off (Section 4)~~ — **RESOLVED 2026-08-16: Peter confirmed no raw email storage.** Only distilled, cited claims are stored; staff click through to Missive for the source conversation. This is now the settled design, not a proposal.
2. **Anthropic's exact API retention terms (Section 4, Tier 1)** — this document states the general, standard practice; Sentinel/Peter should confirm the specifics against Rincon's actual agreement before any live connection.
3. **The governance-scaling structure in Section 8 is a proposal, not a decision** — it needs Asimov's actual review and sign-off before it's treated as real policy, exactly as the task instructed.
4. **Which domain comes second (Phase 3)** — tenant-issue or lease-renewal — is Peter's call, not something this document should presume.
5. **The exact Missive connection mechanism** remains entirely undecided, same as the prior round left it (when this was still assumed to be Gmail) — this document doesn't change that; it's still a separate Sentinel/Scotty pass once any of this is approved to build. Missive has a REST API and webhooks that look well-suited to a shared-inbox read use case, but that's an observation, not a decision.
6. **Who administers the shared Missive inboxes, what Missive's own data-retention setting is, and whether Missive has an existing data processing agreement on file** — none of this was confirmed when the doc assumed Gmail/Google Workspace; it needs Peter/Mason to confirm before Tier 0's retention/access framing (Section 4) can be treated as settled.
