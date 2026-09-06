-- ============================================================
-- Migration: 20260905020000_missive_shared_inbox_intake_schema
-- Created:   2026-09-05
-- Author:    Neo (database specialist)
--
-- Storage layer for the Missive shared-inbox connector
-- (projects/hub/email-intake/missive-connection-plan.md, Sections 2.4
-- and 2.5 — the table sketches this migration implements). This is the
-- concrete database step that satisfies the controlling legal
-- architecture in compliance/owner-tenant-notes-outside-counsel-
-- opinion.md, Section 5, quoted directly: "Tenant sends communication
-- to Rincon. Rincon actually receives the communication. Communication
-- resides in Rincon's system. Rincon subsequently causes a contracted
-- processor to analyze Rincon's stored copy." missive_message_intake IS
-- the "resides in Rincon's system" step — every message lands here,
-- verbatim, before anything else (filter, AI, human) ever touches it.
--
-- Governance status: cleared by Asimov, 2026-09-05, verdict APPROVED
-- WITH REQUIRED ADDITIONS. This migration builds exactly those
-- required additions — no redesign of the connector, no new columns
-- or tables beyond the plan's own Section 2.4/2.5 sketches. Asimov's
-- four required additions and where each is satisfied below:
--   [x] Full GOVERNANCE.md Rule 4 data inventory, matching the exact
--       convention of 20260815010000_maintenance_history_schema.sql /
--       20260905000000_owner_tenant_operational_notes_schema.sql —
--       see "RULE 4 DATA INVENTORY" section below.
--   [x] RLS enabled on both tables, zero permissive policies at
--       creation, narrower-than-usual per Asimov's specific flag — see
--       "RLS" notes on each table below.
--   [x] An explicit Rule 9 statement confirming zero FKs/joins/
--       references into any housing-decision system — see "RULE 9 —
--       HOUSING-DECISION FIREWALL" section below.
--   [x] A scope-lock comment (2 Team Inboxes only; expansion requires a
--       fresh Asimov/Mason pass) — see "SCOPE LOCK" section below.
--
-- No application code, no router, no credential, no ingestion job ships
-- from this file — schema only, per Neo's standing role. Q builds the
-- connector on top of this once Peter has confirmed the open items the
-- plan itself still lists (Team Inbox vs. shared-inbox model, plan
-- tier, real message volume). This migration is NOT applied here —
-- Peter applies it himself via Supabase's SQL Editor, per this
-- project's standing convention (no CLI/DB URL in this environment).
--
-- ============================================================
-- SCOPE LOCK — READ BEFORE EXTENDING THIS SCHEMA
-- ============================================================
-- This migration exists for exactly TWO Team Inboxes, per Peter's
-- current, confirmed scope:
--   'team:b56138a6-f464-43db-a861-9bd79b07c8df'   -- Faria
--   'team:ab0d3661-fb4c-498c-a311-94c6978530d6'   -- Solimar
-- Neither value is seeded by this migration (no INSERT below) — Q's
-- sync job writes the first missive_sync_state row for each mailbox on
-- its first real run. They are recorded here only so the scope-lock
-- itself is checkable later: if a future missive_sync_state or
-- missive_message_intake row ever carries a mailbox_key outside this
-- pair, that is evidence of undisclosed scope creep, not a value this
-- migration authorized.
--
-- ANY expansion of that scope — a third/fourth Team Inbox, or the
-- separate, not-yet-approved "individual staff mailboxes" phase the
-- plan's Section 6/7 amendments research (but do not approve) — REQUIRES
-- its own fresh Asimov/Mason governance pass before deployment. It is
-- NOT a silent reuse of this schema. This is a direct, load-bearing
-- consequence of the individual-mailbox phase being materially more
-- sensitive: per the plan's Section 6, an individual mailbox's
-- mailbox_key would take the shape 'shared_inbox:<email>' — an email
-- address is itself PII, unlike a Team Inbox's opaque team UUID. At
-- that point:
--   - mailbox_key stops being PII-free even in missive_sync_state
--     (today, at 2-Team-Inbox scope, mailbox_key is an opaque team ID,
--     not personal data — the "no PII in this table at this scope"
--     note under missive_sync_state's own Rule 4 note below depends
--     directly on this fact).
--   - This table's Rule 4 classification (below) would need to be
--     reopened and re-run, not assumed to still hold.
-- Flagged here explicitly, per the task that produced this migration:
-- do not build for that phase now; do not let a future engineer treat
-- this schema as "already handles individual mailboxes, just add rows."
--
-- ============================================================
-- RULE 9 — HOUSING-DECISION FIREWALL (GOVERNANCE.md Rule 9: "Never Use
-- Protected Class Data in Decisions")
-- ============================================================
-- This is the single most important structural property of this
-- migration, so it is stated directly, as a design fact confirmed by
-- construction — not an assumption, not a policy that could be
-- silently bypassed later by a well-meaning join.
--
-- Both tables below have ZERO foreign keys, of any kind, to any other
-- table in this schema — confirmed by reading every CREATE TABLE
-- statement in this file: neither missive_sync_state nor
-- missive_message_intake declares a single REFERENCES clause. In
-- particular, neither table has, and neither table may ever gain
-- without its own fresh governance review, any foreign key, join
-- path, or view into:
--   - leases, lease_tenants, or any lease/tenancy table
--   - security_deposit_cases, or any security-deposit table
--   - any LeadSimple screening/decisioning table (the
--     leadsimple_application_screening / leadsimple_delinquency /
--     leadsimple_operations family, or leadsimple_property_stages)
--   - properties, units, owners, or tenants themselves — this schema
--     does not even link the mail to a specific property or tenant
--     record; that association, if any, happens only after the
--     existing Stage 0/1/2 filter (privilege-filter.js,
--     fair-housing-filter.js — email-intake/SPEC.md) has run, and
--     lands in maintenance_email_context, a wholly separate table
--     this migration does not touch.
-- This matters specifically because missive_message_intake is, by
-- design, the ONE table in this schema that may hold unscreened,
-- unfiltered correspondence containing protected-class language,
-- health/disability mentions, or privileged attorney communications —
-- exactly the category Rule 9 exists to keep out of any decision
-- context. The zero-FK, zero-join property above is the concrete,
-- structural enforcement of that: there is no path, accidental or
-- otherwise, for a query joining toward a housing-decision table to
-- reach this content, because no such join can be written without
-- first adding a foreign key this migration deliberately does not
-- create. This mirrors counsel's own "Housing-decision firewall"
-- recommendation (compliance/owner-tenant-notes-outside-counsel-
-- opinion.md, Section 8, item G: "operational information should not
-- automatically flow into screening or adverse housing decisions...
-- Keeping the operational system structurally separate substantially
-- reduces risk") — applied here to raw intake, which is the most
-- sensitive point in the entire pipeline to apply it, since it is the
-- one table storing content nothing has screened yet.
--
-- ============================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT BUILD
-- ============================================================
--   - The Missive connector, cron route, or credential
--     (MISSIVE_API_TOKEN). Schema only — Q's build, Scotty's
--     provisioning, per the plan Sections 2.2/4.
--   - The HTML-to-plain-text conversion step (plan Section 3.5). Q's
--     code, not a database concern. body_text exists as a column for
--     it to write into; nothing here computes it.
--   - Any FK from missive_message_intake to missive_sync_state on
--     mailbox_key, even though the plan's own Section 2.4 comment
--     notes the values "match." A FK here would force
--     missive_sync_state's row to exist before the very first message
--     for a mailbox could ever be stored, which is backwards for a
--     cold-start run — and, more importantly, is not something the
--     plan or Asimov's review asked for. Left as a plain TEXT match by
--     convention, not a constraint.
--   - Any team_member_tool_roles CHECK-constraint widening or role
--     grant. Asimov's review states plainly: no AI agent reads this
--     table in this build, and there is no reader built yet at all
--     (see "RULE 4 DATA INVENTORY" below — agents_with_access lists
--     zero readers). Adding a tool value now would be granting a
--     access lever nothing yet uses — the same "a tool gets access
--     only when something explicitly asks for it" discipline this
--     schema already applies to RLS policies, applied here to the
--     role-grant vocabulary itself. Add it in its own future migration
--     when Q actually builds a reader.
--   - A CHECK constraint restricting mailbox_key to exactly the two
--     Team Inbox values named in "SCOPE LOCK" above. The scope lock is
--     enforced by process (a fresh governance pass before any new
--     mailbox_key is ever written), not by the database rejecting an
--     unrecognized value outright — matches this schema's general
--     preference for documented-but-unenforced operational
--     conventions over a CHECK constraint that would need its own
--     migration every time scope legitimately expands. Flagged here so
--     it isn't assumed away.
--   - A CHECK constraint on missive_sync_state.last_run_status. The
--     plan's own Section 2.4 sketch documents it as a comment
--     ('ok' | 'error' | 'partial'), not an enforced enum, and nothing
--     in Asimov's required additions asks for one — left exactly as
--     the plan sketched it rather than adding new enforcement this
--     task didn't call for.
--   - updated_at on missive_message_intake. The plan's own Section 2.5
--     sketch lists created_at only for this table, not updated_at —
--     followed literally rather than defaulting to this schema's usual
--     "every table gets id/created_at/updated_at" house style. Flagged
--     explicitly because it's a real, deliberate departure from that
--     house style, not an oversight: see the column-level comment on
--     pipeline_status below for the one known mutation this table
--     undergoes after insert, and why it's still not timestamped here.
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No. Both tables are brand
--       new; nothing existing reads or writes either one.
--   [x] Does this touch a table other code depends on? No. Nothing in
--       this file alters any existing table. (No team_member_tool_roles
--       change either — see "WHAT THIS MIGRATION DELIBERATELY DOES NOT
--       BUILD" above.)
--   [x] Additive or destructive? Fully additive — two new tables, no
--       existing column, constraint, or row touched.
--   [ ] Tested on a copy of the data first? No staging copy exists in
--       this project — same standing caveat every migration here has
--       carried to date. Mitigated by: both tables are brand new and
--       empty; nothing can be broken that doesn't yet exist. The real
--       pre-flight risk is downstream (the connector itself, not yet
--       built) — not this schema.
--   [x] Governance go-ahead to build this specific schema — Asimov,
--       2026-09-05, APPROVED WITH REQUIRED ADDITIONS (this file). Not
--       a go-ahead to activate a live connector against a real
--       Missive credential — that remains a separate, later gate per
--       the plan's own "What This Document Is Not" section.
-- ============================================================


-- ============================================================
-- RULE 4 DATA INVENTORY (GOVERNANCE.md Rule 4 — required for every new
-- table storing personal data)
-- ============================================================
--
-- missive_sync_state — NO PII FIELDS AT CURRENT SCOPE.
--   At the 2-Team-Inbox scope this migration is locked to (see "SCOPE
--   LOCK" above), mailbox_key values are opaque Missive team UUIDs
--   ('team:<uuid>'), not personal data — no tenant, owner, or staff
--   identifier appears anywhere in this table. last_synced_conversation_id
--   is Missive's own opaque conversation ID, not content. This
--   classification is scope-dependent, not permanent: if individual
--   mailboxes are ever added (a separate, not-yet-approved phase),
--   mailbox_key would become 'shared_inbox:<email>' — an email address,
--   which IS PII — and this table's Rule 4 status must be reopened at
--   that time. Not built for now; flagged so it isn't forgotten later.
--   RLS: enabled, zero permissive policies (see table section below).
--
-- missive_message_intake — the sensitive table. Full inventory:
--   pii_fields:          body_html, body_text — by far the highest PII
--                         density of anything in this schema. Unlike
--                         every other table here (maintenance_claims,
--                         operational_notes, maintenance_email_context),
--                         these two columns store verbatim, unfiltered
--                         correspondence BEFORE any privilege or
--                         Fair-Housing filter has run. This table is
--                         explicitly designed to also hold Tier-2
--                         HELD/privileged threads and Fair-Housing-
--                         flagged threads — maintenance_email_context
--                         never stores those at all (email-intake/
--                         SPEC.md's own design), which is exactly why
--                         this table cannot reuse that one and cannot
--                         inherit its access posture.
--                         subject, from_address, to_addresses,
--                         cc_addresses, bcc_addresses — PII-adjacent
--                         (names/email addresses of real people,
--                         internal and external), same caveat this
--                         schema already applies elsewhere to
--                         PII-adjacent free text (security_deposit_
--                         cases.reviewer_notes, lease_tenants).
--   agents_with_access:  NONE, in this build. No AI agent, LLM call, or
--                         extraction step reads this table — note-
--                         extraction (owner-tenant-operational-notes-
--                         SPEC.md Section 8) is separate, future work,
--                         behind its own future governance gate, and is
--                         explicitly out of scope here (plan's own
--                         "What This Plan Deliberately Does Not Do").
--                         Writers: the Missive sync cron job only, via
--                         the Supabase service-role key (same
--                         connection convention every other scheduled
--                         job in this schema uses — AppFolio sync,
--                         Latchel ingestion). Readers: none yet — no
--                         Hub route, no UI, no team_member_tool_roles
--                         grant exists for this table (see "WHAT THIS
--                         MIGRATION DELIBERATELY DOES NOT BUILD" above).
--   privacy_category:    'collection' — the act of pulling and storing
--                         Rincon's own already-received mail off
--                         Missive's servers, per counsel's Section 5
--                         architecture. At-rest content may include
--                         health/disability mentions, Fair-Housing-
--                         protected-class language, and privileged
--                         attorney-client communications — more
--                         sensitive, as a category, than any other
--                         table in this schema, precisely BECAUSE
--                         nothing has screened it yet. Every other
--                         table holding comparably sensitive content
--                         (maintenance_claims, operational_notes) only
--                         holds it after a content check has already
--                         run; this table holds it before.
--   retention_policy:    SET BY MASON (legal review), 2026-09-05 — real
--                         policy, replacing the prior placeholder, ahead
--                         of the ~47,000-message historical backfill
--                         (May 2024-present) about to land in this
--                         table. A flat, single retention period was
--                         considered and rejected for this table
--                         specifically (see reasoning below); the policy
--                         is instead GATED on the still-unbuilt Stage
--                         0/1/2 filter (privilege-filter.js /
--                         fair-housing-filter.js), because this table
--                         cannot currently tell ordinary correspondence
--                         apart from a Tier 2 HELD thread (privilege-
--                         filter.js's term for privileged/litigation-
--                         relevant content pulled from normal
--                         processing) — nothing has run the filter yet,
--                         and the entire 47,000-message backfill will
--                         land as pipeline_status = 'pending'.
--
--                         RULE 1 — WHILE pipeline_status = 'pending':
--                         no row may be deleted for age or any other
--                         retention reason (a valid, individually-
--                         actioned CCPA deletion request is the one
--                         exception — see the amended ccpa_deletable
--                         note below, which carries the same gate).
--                         This is a real, concrete rule, not "no policy
--                         yet": an age-based deletion clock applied to
--                         unscreened correspondence is only "safe
--                         because nothing is being screened or deleted
--                         yet anyway" for as long as nobody actually
--                         builds the deletion job — this rule makes that
--                         explicit and enforceable instead of relying on
--                         that never happening by accident.
--
--                         RULE 2 — ONCE pipeline_status = 'processed'
--                         for a given row (the future filter has
--                         actually run against it) AND that row's
--                         filter outcome (held / tagged / tier) is
--                         available to check (see PREREQUISITE below):
--                           - Tier 2 HELD (layer-3 staff legal-hold tag,
--                             law-firm domain, or HOLD_TERMS keyword
--                             match anywhere in the thread) -> LEGAL
--                             HOLD. No deletion clock at all — retained
--                             until an attorney affirmatively releases
--                             the hold. Mirrors the filter's own "held"
--                             semantics (pulled from normal processing
--                             for a human) and counsel's Section 8
--                             framework of tying retention to continued
--                             legal relevance rather than a fixed date
--                             once content is known to be legally
--                             significant.
--                           - Everything else (ordinary correspondence,
--                             and Tier 1 TAG/regulatory-matter threads,
--                             which are expressly NOT held) -> 4 years
--                             from delivered_at, then eligible for
--                             deletion. This 4-year figure is an
--                             independent decision for THIS table only —
--                             anchored to California's 4-year statute of
--                             limitations for written contracts (Code of
--                             Civil Procedure Section 337), the most
--                             relevant available benchmark for ordinary
--                             landlord-tenant correspondence, with rough
--                             allowance for a FEHA housing-discrimination
--                             claim's combined administrative-complaint-
--                             plus-civil-action window (Gov. Code Section
--                             12960 et seq.). Deliberately NOT copied
--                             from, and not to be overwritten by,
--                             whatever figure Mason sets later for
--                             maintenance_claims or operational_notes —
--                             per this file's own prior instruction,
--                             this table's number is its own decision,
--                             and the above is it.
--
--                         PREREQUISITE — stated so it cannot be missed
--                         later: this table has NO column recording a
--                         row's filter outcome once pipeline_status
--                         flips to 'processed' — that column only
--                         records that the filter ran, not what it
--                         found (see the pipeline_status column comment
--                         below; the classification itself is designed
--                         to live downstream, and HELD threads are, by
--                         the filter's own design, exactly the ones
--                         maintenance_email_context never stores at
--                         all). Before any age-based deletion job is
--                         ever built against this table, it must be able
--                         to answer, per row, "was this Tier 2 HELD" —
--                         either via a new column on this table (a
--                         held/tier flag; Neo's call, not added by this
--                         migration) or a reliable join to wherever the
--                         filter actually records its output. Until that
--                         mechanism exists, RULE 1 continues to apply
--                         even to 'processed' rows — "processed" alone
--                         must never be read as "safe to delete on the
--                         age clock."
--
--                         SEPARATE LIMITATION, not solved by the above:
--                         the automated filter (domain/keyword matching)
--                         is necessary but not sufficient for a real
--                         litigation hold. If Rincon has actual notice
--                         of, or reasonably anticipates, litigation or a
--                         regulatory complaint (Fair Housing or
--                         otherwise) touching specific tenants, units, or
--                         matters, a human-issued litigation hold on
--                         every potentially-relevant row is required
--                         regardless of what the automated filter
--                         tagged — the filter catches known keyword/
--                         domain patterns, not "everything a reasonable
--                         person would anticipate is discoverable."
--                         Standing operational obligation; a
--                         retention_policy field cannot satisfy it by
--                         itself.
--
--                         DOES THIS NEED TO BE REVISITED once the filter
--                         is actually built? No — as a legal matter this
--                         policy already accounts for that transition
--                         and does not need to be reopened. What happens
--                         at that time is engineering, not a new legal
--                         decision: (1) the filter must actually run
--                         against all 47,000 backfilled messages, not
--                         just new arrivals, (2) its held/tier output
--                         must land somewhere queryable per the
--                         PREREQUISITE above, and only then (3) may an
--                         actual age-based deletion job be built and run.
--   ccpa_exportable:     TRUE.
--   ccpa_deletable:      TRUE, via the same targeted-redaction
--                         convention as maintenance_claims and
--                         operational_notes: on a valid CCPA deletion
--                         request, the PII fields above — body_html,
--                         body_text, subject, from_address,
--                         to_addresses, cc_addresses, bcc_addresses —
--                         are set to the literal string "[REDACTED]"
--                         (for the three JSONB columns, the JSON scalar
--                         string value "[REDACTED]", i.e.
--                         '"[REDACTED]"'::jsonb, to keep the column's
--                         declared type), preserving mailbox_key,
--                         missive_conversation_id, missive_message_id,
--                         delivered_at, and pipeline_status for audit
--                         continuity (the fact "a message existed, on
--                         this date, in this mailbox, at this pipeline
--                         stage" stays; the correspondence itself does
--                         not). Known, accepted limitation, same
--                         category as every other domain in this
--                         schema: this table has no tenant_id/owner_id
--                         column, so finding every row that concerns a
--                         specific person is a manual lookup by
--                         matching that person's known email address(es)
--                         against from_address/to_addresses/
--                         cc_addresses/bcc_addresses — arguably a
--                         harder manual step than the tenant-unit
--                         lookups already accepted elsewhere in this
--                         schema (maintenance_claims, b2_photo_folders,
--                         lease_tenants), because one message can name
--                         several people across three different address
--                         fields at once. Not solved here, not silently
--                         ignored either.
--
--                         AMENDED BY MASON, 2026-09-05, same pass as the
--                         retention_policy note above — this "redact on
--                         any valid CCPA request" convention needs the
--                         identical gate applied to it, for the same
--                         reason: while pipeline_status = 'pending' for
--                         a row, this table cannot yet tell whether that
--                         row is Tier 2 HELD (privileged / litigation-
--                         relevant). Redacting body_html/body_text on a
--                         row that would have been HELD, had the filter
--                         already run, is the same spoliation risk as
--                         age-based deletion of that row — the trigger
--                         differs (a CCPA request vs. a retention clock)
--                         but the underlying harm and the fix are the
--                         same. CCPA's own regulations recognize an
--                         exception for data a business must preserve to
--                         comply with a legal obligation or to exercise
--                         or defend legal claims (Cal. Civ. Code Section
--                         1798.105(d)) — a litigation hold or privilege
--                         obligation falls squarely within that
--                         exception. Rule, mirroring retention_policy's
--                         RULE 1/RULE 2 above: a CCPA deletion request
--                         against a 'pending' row is honored for every
--                         OTHER table reachable by that person's known
--                         email address(es), but redaction of THIS row
--                         is deferred (not refused — logged as deferred,
--                         pending the filter) until pipeline_status =
--                         'processed' and the row's filter outcome is
--                         known; if the row then turns out to be Tier 2
--                         HELD, redaction is withheld under the Section
--                         1798.105(d) exception and counsel is notified
--                         before any further action; if not HELD,
--                         redaction proceeds as already described above.
--                         Same PREREQUISITE dependency as
--                         retention_policy: this deferral-then-check
--                         logic cannot be implemented until a row's
--                         filter outcome is recorded somewhere queryable
--                         (see retention_policy's PREREQUISITE note).
--
-- RLS: enabled on BOTH tables, zero permissive policies at creation —
-- see each table's own RLS note below for why this needs to be at
-- least as narrow as, arguably narrower than, maintenance_email_
-- context's reviewer/admin access (Asimov's specific flag).
-- ============================================================


-- ============================================================
-- TABLE: missive_sync_state (plan Section 2.4)
-- One row per mailbox, tracking how far the pull job has gotten.
-- Exists because Missive's API has no "give me everything since
-- timestamp X" filter (plan Section 1.3/3.1) — pagination is strictly
-- backward-only, so the job needs its own bookmark per mailbox rather
-- than a single .env timestamp.
-- ============================================================

CREATE TABLE IF NOT EXISTS missive_sync_state (
  id                            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 'team:<team_id>' at current scope (see "SCOPE LOCK" above). Not a
  -- foreign key to anything — see "WHAT THIS MIGRATION DELIBERATELY
  -- DOES NOT BUILD" for why missive_message_intake.mailbox_key doesn't
  -- reference this column either.
  mailbox_key                   TEXT        NOT NULL UNIQUE,

  -- Newest conversation fully processed, and its last_activity_at at
  -- that time — the actual paging stop condition the job checks
  -- against on its next run (plan Section 2.3, step 2). Both nullable:
  -- a mailbox's first-ever sync run has no prior watermark to compare
  -- against.
  last_synced_conversation_id   TEXT,
  last_synced_activity_at       TIMESTAMPTZ,

  last_run_at                   TIMESTAMPTZ,
  -- 'ok' | 'error' | 'partial' — documented convention per the plan's
  -- own sketch, not a CHECK constraint; see "WHAT THIS MIGRATION
  -- DELIBERATELY DOES NOT BUILD" above for why this stays as sketched.
  last_run_status                TEXT,
  last_error                     TEXT,

  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: enabled, no permissive policies — matches every other table in
-- this schema's "locked down until a tool explicitly asks for access"
-- default. This table carries no PII at current scope (see Rule 4 note
-- above), but is locked down anyway for the same reason every table in
-- this schema is: only the sync cron job (service-role key, which
-- bypasses RLS regardless) needs to touch it at all.
ALTER TABLE missive_sync_state ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_missive_sync_state_updated_at ON missive_sync_state;
CREATE TRIGGER trg_missive_sync_state_updated_at
  BEFORE UPDATE ON missive_sync_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE missive_sync_state IS
  'Per-mailbox watermark for the Missive shared-inbox pull job (projects/hub/email-intake/missive-connection-plan.md, Section 2.4). No PII at current 2-Team-Inbox scope — see SCOPE LOCK note in this migration file for why that changes if individual mailboxes are ever added. RLS enabled, zero permissive policies.';

COMMENT ON COLUMN missive_sync_state.mailbox_key IS
  'Opaque mailbox identifier, e.g. ''team:b56138a6-f464-43db-a861-9bd79b07c8df''. At current scope this is a Missive Team UUID, not personal data. If a future, separately-governed individual-mailbox phase is ever approved, this value would take the shape ''shared_inbox:<email>'' for that phase''s rows — at which point mailbox_key becomes PII-bearing and this table''s Rule 4 classification must be reopened. Flagged, not built for.';


-- ============================================================
-- TABLE: missive_message_intake (plan Section 2.5)
-- The raw intake table — one row per Missive message, stored verbatim
-- the moment it's pulled, before the existing privilege/Fair-Housing
-- filter (email-intake/lib/privilege-filter.js, fair-housing-filter.js)
-- or any future AI extraction ever touches it. This IS "Rincon's own
-- system" holding "its own copy" in outside counsel's exact words
-- (compliance/owner-tenant-notes-outside-counsel-opinion.md, Section
-- 5) — the row landing here, committed, is the step that satisfies
-- that architecture. Upstream of, and never a reuse of,
-- maintenance_email_context: that table is the FILTERED, ready-for-
-- staff output of Stage 0/1/2 and by design never stores a HELD
-- (privileged) or NOT_RELEVANT thread at all — this table has to,
-- because counsel's "Rincon receives and stores" step has to happen
-- for every message, including the ones that turn out to be privileged
-- or irrelevant, before anything decides that.
-- ============================================================

CREATE TABLE IF NOT EXISTS missive_message_intake (
  id                        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Matches missive_sync_state.mailbox_key by value/convention, not by
  -- foreign key — see "WHAT THIS MIGRATION DELIBERATELY DOES NOT
  -- BUILD" above.
  mailbox_key               TEXT          NOT NULL,
  missive_conversation_id   TEXT          NOT NULL,
  missive_message_id        TEXT          NOT NULL UNIQUE,  -- idempotent re-fetch/upsert key (plan Section 2.3, step 6: "an INSERT ... ON CONFLICT DO NOTHING/upsert on the raw table's unique key")
  email_message_id          TEXT,          -- the Message-ID header, when present

  subject                   TEXT,
  from_address              TEXT,
  to_addresses               JSONB,
  cc_addresses                JSONB,
  bcc_addresses                 JSONB,

  delivered_at                   TIMESTAMPTZ,

  -- Verbatim, as Missive returned it — untouched. This is the literal
  -- "Rincon receives and stores" copy counsel's Section 5 architecture
  -- requires; nothing may pre-process, strip, or filter this value
  -- before it is written.
  body_html                       TEXT,
  -- Derived from body_html by Q's future HTML-to-plain-text conversion
  -- step (plan Section 3.5) — never the only copy kept; body_html
  -- above remains the system of record.
  body_text                        TEXT,

  fetched_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Has the existing Stage 0/1/2 filter run against this row yet. The
  -- one field on this table that mutates after insert ('pending' ->
  -- 'processed', written by Q's future pipeline step) — see "WHAT THIS
  -- MIGRATION DELIBERATELY DOES NOT BUILD" above for why that mutation
  -- is still not covered by an updated_at column on this table.
  pipeline_status                    TEXT NOT NULL DEFAULT 'pending'
                                       CHECK (pipeline_status IN ('pending', 'processed')),

  created_at                           TIMESTAMPTZ NOT NULL DEFAULT NOW()

  -- No FOREIGN KEY of any kind appears anywhere in this table
  -- definition — see "RULE 9 — HOUSING-DECISION FIREWALL" above.
);

-- RLS: enabled, zero permissive policies at creation — same "locked
-- down until a tool explicitly asks for access" convention as every
-- other table in this schema (20260812020000, 20260815010000,
-- 20260905000000 all state this explicitly). Asimov's review is
-- explicit that this needs to be treated as harder than the usual
-- case: this table must be at least as narrow as, arguably narrower
-- than, maintenance_email_context's eventual reviewer/admin access,
-- because it holds unscreened Tier-2 HELD/privileged and Fair-Housing-
-- flagged content that maintenance_email_context never stores at all.
-- Zero permissive policies at creation is, by construction, already at
-- least as narrow as any policy set maintenance_email_context could
-- ever define — nobody reaches this table's rows except through the
-- Supabase service-role key (which bypasses RLS regardless, same fact
-- already documented for every base table in this schema) until a
-- future migration adds an explicit, scoped policy. When that future
-- policy is written, it must be justified independently — it may NOT
-- simply mirror whatever role tier ends up reading
-- maintenance_email_context, per Asimov's flag.
ALTER TABLE missive_message_intake ENABLE ROW LEVEL SECURITY;

-- Mailbox-level lookup — "everything pulled for this Team Inbox,"
-- the natural per-mailbox scope every sync run and any future audit
-- operates within.
CREATE INDEX IF NOT EXISTS idx_missive_message_intake_mailbox
  ON missive_message_intake(mailbox_key);

-- Conversation-level lookup — plan Section 2.3, step 4: "Compare each
-- message ID against what's already stored for this conversation."
CREATE INDEX IF NOT EXISTS idx_missive_message_intake_conversation
  ON missive_message_intake(missive_conversation_id);

-- "Still needs Stage 0/1/2 filtering" queue — the concrete work queue
-- Q's future pipeline step drains, same partial-index-on-a-status
-- convention as idx_operational_notes_pending_approval / idx_
-- maintenance_claims_unreviewed.
CREATE INDEX IF NOT EXISTS idx_missive_message_intake_pending
  ON missive_message_intake(pipeline_status)
  WHERE pipeline_status = 'pending';

-- (missive_message_id's UNIQUE constraint above already creates its
-- own unique index — no separate CREATE INDEX needed for it.)

COMMENT ON TABLE missive_message_intake IS
  'Raw, verbatim Missive shared-inbox message intake (projects/hub/email-intake/missive-connection-plan.md, Section 2.5) — the concrete "Rincon receives and stores" step required by compliance/owner-tenant-notes-outside-counsel-opinion.md, Section 5, before the existing privilege/Fair-Housing filter or any future AI extraction ever runs. Holds unscreened content, including privileged and Fair-Housing-flagged threads, that maintenance_email_context (the filtered output table) never stores at all. Zero foreign keys into any table in this schema, by design — see RULE 9 note in this migration file. RLS enabled, zero permissive policies at creation.';

COMMENT ON COLUMN missive_message_intake.body_html IS
  'Verbatim HTML body as returned by Missive''s GET /v1/messages/:id — untouched. Highest-PII-density column in this schema: may contain unfiltered tenant/owner/staff correspondence, health/disability mentions, Fair-Housing-protected-class language, or privileged attorney communications, stored BEFORE any content check runs. CCPA-deletable via redaction to the literal string "[REDACTED]" — see RULE 4 DATA INVENTORY note in this migration file.';

COMMENT ON COLUMN missive_message_intake.body_text IS
  'Plain-text rendering of body_html, derived by a future deterministic HTML-to-text conversion step (plan Section 3.5) — never the only copy kept; body_html remains the verbatim system of record. Same PII sensitivity and CCPA-redaction treatment as body_html.';

COMMENT ON COLUMN missive_message_intake.mailbox_key IS
  'Matches missive_sync_state.mailbox_key by convention, not by foreign key. See that table''s own column comment for the PII-status caveat if individual mailboxes are ever added in a future, separately-governed phase.';


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP TRIGGER IF EXISTS trg_missive_sync_state_updated_at ON missive_sync_state;
--
-- DROP INDEX IF EXISTS idx_missive_message_intake_pending;
-- DROP INDEX IF EXISTS idx_missive_message_intake_conversation;
-- DROP INDEX IF EXISTS idx_missive_message_intake_mailbox;
--
-- -- Safe to drop in full as long as nothing has been built on top of
-- -- these tables yet (true as of this migration — no Q, no cron job,
-- -- no credential exists that could have written a real row). If a
-- -- later phase has since inserted real rows (e.g. a live sync job has
-- -- run), dropping either table permanently loses that data — confirm
-- -- nothing depends on it first, and consider exporting first per the
-- -- ccpa_exportable note above if a compliance hold might apply.
-- DROP TABLE IF EXISTS missive_message_intake;
-- DROP TABLE IF EXISTS missive_sync_state;
--
-- ============================================================
