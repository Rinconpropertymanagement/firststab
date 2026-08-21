-- ============================================================
-- Migration: 20260819010000_call_stats
-- Created:   2026-08-19
-- Author:    Neo (database specialist)
--
-- Part of the Aircall Call Stats build (projects/hub/call-stats/SPEC.md,
-- written by Oracle, approved by Peter 2026-08-18/19). One new table
-- only. No changes to any existing table (the separate, small
-- permissions change this build also needs — widening the shared
-- `tool` CHECK on team_member_tool_roles to add 'call_stats' — is its
-- own migration, 20260819020000_call_stats_team_roles.sql, matching
-- the same split security_deposit used between its core tables and its
-- own team-roles migration).
--
-- What this is for: shows Peter and pod leads, per staff member, per
-- pod (Solimar/Faria), how their phone activity looks over a chosen
-- date range — call count, average call length, missed-call count,
-- average speed-to-answer. Read-only. No recordings, no transcripts,
-- no call content of any kind are ever fetched or stored by this
-- table or anything built on it (spec's "Explicitly Out of Scope").
--
-- ============================================================
-- WHY THIS DOESN'T GO THROUGH `claims`
-- ============================================================
-- Same reasoning as appfolio_property_actuals
-- (20260817010000_appfolio_property_actuals.sql) and stated in the
-- spec's Design Decision 3: a row here is a structured fact fetched
-- directly from Aircall's Calls API and arithmetically summed (call
-- counts, second totals), not an AI interpretation of messy source
-- material. No ambiguity to resolve, nothing for a human to
-- confirm-or-correct — so no confidence/extracted_by/review_status
-- columns, matching the plain-sync pattern already used throughout
-- this schema.
--
-- ============================================================
-- WHERE THIS DIVERGES FROM THE appfolio_property_actuals PRECEDENT
-- (this is the load-bearing difference in this migration, stated
-- plainly per the spec's own instruction not to inherit the wrong
-- conclusion by habit)
-- ============================================================
-- appfolio_property_actuals could honestly claim zero PII "by
-- construction" — its whole design was aggregating AWAY the fields
-- (party_name, party_id) that would have made a row personal. THIS
-- TABLE CANNOT MAKE THAT CLAIM. Per-person attribution is the entire
-- point of this build: the row's reason for existing is "which staff
-- member handled these calls." staff_email and aircall_user_id
-- identify a real, specific Rincon employee, and every count column
-- next to them (total_calls, missed_calls, total_talk_seconds, etc.)
-- is performance data about that named person. See "DATA INVENTORY"
-- below, written honestly against that fact rather than copy-pasting
-- appfolio_property_actuals's "NONE, by construction" entry.
--
-- ============================================================
-- LIVE VERIFICATION (done before writing this migration, per the
-- spec's own "confirmed vs. needs live verification" split and
-- CLAUDE.md's "don't guess field names from docs alone" discipline —
-- AIRCALL_API_ID/AIRCALL_API_TOKEN were already confirmed working
-- against https://api.aircall.io/v1/ping before this session)
-- ============================================================
-- Fetched a live page of Rincon's real GET /v1/calls (50 most recent
-- calls, Basic Auth via AIRCALL_API_ID:AIRCALL_API_TOKEN, which
-- worked with no separate read-only credential — confirms spec's
-- Design Decision 6). Findings:
--
--   1. Per-user attribution IS populated on real Rincon calls, exactly
--      as the spec hoped (Open Item 1): the nested `user` object
--      carries `id`, `name`, and `email` — e.g.
--      {"id": 1349351, "name": "Dio Lopes",
--       "email": "dio@rinconmanagement.com", ...}. `email` is the real
--      field name and is populated on every call that has a `user` at
--      all (45 of 50 sampled). This confirms staff_email below as the
--      correct join key into users.email, exactly as the spec's
--      Design Decision 1 assumed.
--
--   2. Fully-missed calls DO occur in real Rincon data, and DO carry
--      `user: null` (Open Item 2 — now answered, not still
--      hypothetical). 5 of 50 sampled calls were inbound, unanswered,
--      and had `user: null` — only a `number` object (the pod's shared
--      line, e.g. "RSC Solimar Team", "Office Line") identified them,
--      no staff member at all. THIS TABLE'S GRAIN CANNOT REPRESENT
--      THOSE CALLS — there is no staff_email to key a row on. Per the
--      spec's own recommendation ("recommend not designing that shape
--      now, on a guess — confirm first whether this case actually
--      occurs... add it as a small follow-on migration if it does"):
--      it does occur, confirmed live, so this IS a real, known gap in
--      what this table can show, not a hypothetical one anymore. A
--      pod-level-only fallback table is NOT built in this migration —
--      that's new scope Peter hasn't asked for yet, flagged back to
--      him in this session's summary rather than built silently.
--
--   3. Pagination is classic page/per_page, not cursor-only (Open Item
--      3): the response's `meta` carries
--      {count, total, current_page, per_page, next_page_link,
--      previous_page_link} — e.g. a real next_page_link of
--      ".../v1/calls?order=desc&page=2&per_page=50". Confirmed so Q's
--      nightly sync loop doesn't silently drop calls past page 1.
--
--   4. Real, non-hypothetical evidence for the spec's "What Could Go
--      Wrong" concern about email mismatches: one sampled call's
--      `user.email` was "regina@quickturnmaintenance.com" — an
--      external vendor's Aircall seat (Quick Turn Maintenance has its
--      own number in this Aircall account), not a Rincon employee at
--      all. This will never match a users.email row, by design, and
--      confirms the spec's "log the unmatched Aircall user, don't
--      silently fail the sync" behavior is a real, expected case for
--      Q to handle — not a rare edge case to skip.
--
-- ============================================================
-- GRAIN AND COLUMN SHAPE (spec's Design Decision 2)
-- ============================================================
-- One row per (staff member, calendar day, call direction) — not
-- per-call, not pre-aggregated to week/month. Sums and counts are
-- stored (total_calls, answered_calls, missed_calls,
-- total_talk_seconds, total_ring_seconds); averages are never stored
-- pre-divided, because averages don't combine across ranges (same
-- principle appfolio_property_actuals already uses for its own dollar
-- totals). "Average call length" = total_talk_seconds / answered_calls,
-- computed live in router.js for whatever date range is requested.
--
-- direction is its own dimension (not blended into one row), because
-- "missed" means something different per direction: for inbound, a
-- miss is a real responsiveness signal (nobody picked up a tenant/
-- owner call); for outbound, it just means the other party didn't
-- answer, which reflects nothing about Rincon staff performance.
-- Speed-to-answer (total_ring_seconds) is only a meaningful staff
-- metric for inbound calls, for the same reason.
--
-- call_date is Rincon's own business-day (America/Los_Angeles), NOT a
-- naive UTC truncation of Aircall's started_at (confirmed live:
-- started_at/answered_at/ended_at all arrive as UTC unix timestamps,
-- e.g. 1769911172) — flagged explicitly for Q so a late-evening
-- Pacific call doesn't get split across two UTC calendar days.
--
-- ============================================================
-- POD LOOKUP (spec's Design Decision 1)
-- ============================================================
-- Pod (Solimar/Faria) is never stored on this table. It's looked up at
-- query time via staff_email -> users.email -> users.pod. If someone's
-- pod assignment changes later, a report run today shows their
-- historical calls under their CURRENT pod, not the one they were in
-- at the time — a known, accepted limitation (no pod-history tracking
-- exists anywhere in this schema today; not invented here either).
-- staff_email and aircall_user_id are deliberately plain TEXT, not
-- declared foreign keys into users — same convention as every
-- external-system-sourced column in this schema (appfolio_property_id,
-- etc.): a real Aircall call should never fail to sync just because no
-- matching users row exists yet (see finding 4 above); Q's sync logs
-- that case instead (console/sync log, not audit_log — see below).
--
-- ============================================================
-- QUERY PATTERN (informs the index choice below)
-- ============================================================
-- "This pod's stats for [date range]" =
--   SUM(total_calls), SUM(answered_calls), SUM(missed_calls),
--   SUM(total_talk_seconds), SUM(total_ring_seconds)
--   WHERE call_date BETWEEN ? AND ?
--   GROUP BY staff_email
-- ...then joined to users (on email) for name + pod at read time, one
-- query per Hub dashboard load — matching the Budget tab's own
-- live-computed pattern. The filter leads with a date RANGE across
-- everyone, not a single staff member, which is why the index below is
-- a separate (call_date, staff_email) index rather than relying on the
-- UNIQUE constraint's own (aircall_user_id, call_date, direction)
-- index, which doesn't give a usable leading prefix for this query.
--
-- ============================================================
-- DATA INVENTORY (GOVERNANCE.md Rule 4 — written honestly, not
-- copy-pasted from appfolio_property_actuals's "NONE" entry)
-- ============================================================
--   pii_fields:          call_stats.staff_email (direct identifier —
--                         a named Rincon employee's real email) and
--                         call_stats.aircall_user_id (indirect
--                         identifier — Aircall's own internal ID for
--                         that same person; not independently
--                         meaningful without staff_email, but still a
--                         stable per-person identifier). Every other
--                         column on this table (total_calls,
--                         answered_calls, missed_calls,
--                         total_talk_seconds, total_ring_seconds) is
--                         performance data ABOUT the person those two
--                         fields identify — this is the whole point of
--                         the table, not an incidental side effect
--                         (spec's Design Decision 3).
--   agents_with_access:  the nightly Aircall sync process (system,
--                         service-role key, read-only Aircall API
--                         calls only); any Hub user holding 'admin' or
--                         'pod_lead' for tool='call_stats' in
--                         team_member_tool_roles. Per spec's "Access /
--                         Roles" section, v1 access is flat — either
--                         role sees BOTH pods' numbers, matching the
--                         already-shipped Security Deposit precedent,
--                         not a new gap invented here.
--   privacy_category:    Employee performance / call-activity
--                         metadata. NOT tenant or applicant data, NOT
--                         Fair Housing-relevant (no housing decision,
--                         no applicant, no tenant anywhere in this
--                         design) — genuinely personal to a Rincon
--                         staff member, a different category from
--                         anything else in this schema today. Governed
--                         by California employment-privacy law and
--                         CCPA, not GOVERNANCE.md's tenant-facing
--                         rules (see spec's Design Decision 5).
--   retention_policy:    PLACEHOLDER — Peter's call, not a technical
--                         one (per spec's Open Item 6). No technical
--                         reason forces a limit; absent a decision this
--                         defaults to indefinite, matching every other
--                         synced table in this schema. Given this is
--                         employee monitoring data, Peter may
--                         reasonably want a rolling window (e.g.
--                         trailing 12 months) instead — worth a
--                         deliberate decision, not left to this
--                         migration to assume either way.
--   ccpa_exportable:     TRUE — Neo's own read, stated plainly rather
--                         than left open. California's CCPA
--                         employee-data exemption expired January 1,
--                         2023; California employees generally now
--                         have the same right-to-know/access over
--                         their own employee data that consumers have
--                         over their own consumer data. A Rincon staff
--                         member requesting "what personal data do you
--                         hold about me" would reasonably expect this
--                         table's rows about them included in an
--                         export, same reasoning already applied to
--                         lease_tenants's ccpa_exportable entry.
--   ccpa_deletable:      TRUE, mechanically — this is a schema-level
--                         read, not a legal one. The same redact-in-
--                         place pattern already used elsewhere in this
--                         schema (claims.claim_text -> "[REDACTED]")
--                         applies cleanly here: overwrite staff_email
--                         and aircall_user_id, and what's left is an
--                         anonymous count-of-calls-on-a-day row with no
--                         person attached to it — technically
--                         straightforward, no schema obstacle. What
--                         stays genuinely OPEN, and is explicitly NOT a
--                         schema question: whether Rincon is legally
--                         REQUIRED to honor a deletion request for this
--                         data category, versus relying on a CCPA
--                         exception for legitimate internal/operational
--                         use (a real, available exception for
--                         employee performance records in some
--                         circumstances). That's an employment-law
--                         judgment call for whoever handles Rincon's
--                         employment-side compliance, not for this
--                         migration to resolve (matches the spec's own
--                         "not Neo's, not Oracle's, not Mason's stated
--                         lane" framing in Design Decision 5).
--   RLS:                 enabled, no permissive policies at creation —
--                         matches every table in this schema.
--   Audit logging:       none, by design — matches
--                         appfolio_property_actuals's own precedent
--                         (a plain sync of a fetched-and-summed fact
--                         needs no confidence/review workflow, and this
--                         table has none either).
--
-- Governance path: per CLAUDE.md's compliance-build boundary and the
-- spec's Design Decision 5, this does NOT route through Asimov or
-- Mason — no message is ever sent to anyone, no decision about a
-- tenant or applicant is made or influenced, and GOVERNANCE.md's Rules
-- and Fair Housing Standard don't address employee-performance-
-- monitoring data at all (a real category of risk, just not the one
-- those two specialists review). GOVERNANCE.md Rule 4 (this data
-- inventory) still applies in full, and does apply here, per Rule 4's
-- own text ("any new table that stores personal data," not scoped to
-- tenants). Peter's approval of the spec satisfies Rule 6 Standard
-- tier. Two open items remain flagged for Peter, not resolved here:
-- the real CCPA employee-data question above, and the retention-window
-- decision above.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- TABLE: call_stats
-- What it stores: one row per Rincon staff member, per calendar day
-- (Rincon business timezone), per call direction (inbound/outbound) —
-- Aircall call counts and second-totals for that slice, aggregated
-- from raw Aircall call records at sync time. The individual call
-- records themselves are never stored here or anywhere in Supabase
-- (spec's Design Decision 2). Synced nightly, read-only.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS call_stats (
  id                     UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Aircall's own numeric user ID (confirmed live: call.user.id, e.g.
  -- 1349351). Plain TEXT, not a declared FK — same convention as
  -- appfolio_property_id elsewhere in this schema (external system,
  -- sync-order not guaranteed). Not independently meaningful without
  -- staff_email below; kept as its own column because it's Aircall's
  -- stable per-person key even if a staff member's email ever changes.
  aircall_user_id        TEXT          NOT NULL,

  -- Confirmed live: call.user.email, e.g. "dio@rinconmanagement.com".
  -- The real join key into users.email at query/sync time, per the
  -- spec's Design Decision 1 — resolves to name + pod. NOT a declared
  -- FK: a real Aircall call (including one from an external vendor's
  -- Aircall seat, confirmed live — see finding 4 above) should never
  -- fail to sync just because no matching users row exists yet. Q's
  -- sync logs an unmatched email instead of dropping the sync run.
  staff_email             TEXT          NOT NULL,

  -- The calendar day this row aggregates, in Rincon's own business
  -- timezone (America/Los_Angeles) — NOT a naive UTC truncation of
  -- Aircall's started_at (confirmed live: started_at/answered_at/
  -- ended_at all arrive as UTC unix timestamps). A late-evening
  -- Pacific call must land on the Pacific calendar day, or a day's
  -- totals silently split across two rows. Flagged explicitly for Q.
  call_date               DATE          NOT NULL,

  -- Tracked separately per spec's Design Decision 2: "missed" means a
  -- real responsiveness problem for inbound (nobody picked up a
  -- tenant/owner call) but nothing about staff performance for
  -- outbound (the other party didn't answer). Confirmed live:
  -- call.direction arrives as exactly 'inbound' or 'outbound'.
  direction                TEXT         NOT NULL CHECK (direction IN ('inbound', 'outbound')),

  total_calls              INTEGER      NOT NULL CHECK (total_calls >= 0),

  answered_calls           INTEGER      NOT NULL CHECK (answered_calls >= 0),

  -- inbound: calls nobody on the pod's ring group picked up (a real
  -- responsiveness signal). outbound: calls the other party didn't
  -- answer (not a staff performance signal). Kept honest by being
  -- split via `direction` above, never blended into one number. Does
  -- NOT include the fully-unattributed "nobody in the whole pod
  -- answered, and Aircall assigned no user at all" calls confirmed to
  -- occur live (finding 2 above) — those calls have no staff_email to
  -- attribute to and cannot be represented at this table's grain at
  -- all; they are invisible to this table by construction, not
  -- undercounted quietly. Flagged as a known, confirmed limitation.
  missed_calls             INTEGER      NOT NULL CHECK (missed_calls >= 0),

  -- sum(ended_at - answered_at) over answered calls only, in seconds.
  -- "Average call length" = this / answered_calls, computed live at
  -- query time in router.js — never stored pre-divided (Design
  -- Decision 2). Defaults to 0 rather than NULL because "zero seconds
  -- talked" (e.g. a day with only missed calls) is itself a real, known
  -- answer.
  total_talk_seconds        INTEGER      NOT NULL DEFAULT 0 CHECK (total_talk_seconds >= 0),

  -- sum(answered_at - started_at) over answered calls only, in
  -- seconds. "Average speed-to-answer" = this / answered_calls, same
  -- computed-live rule. Meaningful as a staff metric for inbound only
  -- (Design Decision 2) — outbound rows still store it for symmetry
  -- and because nothing about the schema should silently assume
  -- router.js will always ignore it, but router.js/Tron's dashboard
  -- should not surface it as a staff performance number for outbound
  -- rows.
  total_ring_seconds         INTEGER      NOT NULL DEFAULT 0 CHECK (total_ring_seconds >= 0),

  -- When this row was last confirmed by the nightly sync — lets the
  -- dashboard show "as of [last sync time]," same purpose and pattern
  -- as appfolio_property_actuals.synced_at.
  synced_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Upsert key for the nightly sync job (matches Supabase's
  -- on_conflict= pattern every other sync in this project already
  -- uses). A day/direction/person combination gets overwritten in
  -- place if the sync ever re-runs over the same day (e.g. a retry, or
  -- a late-arriving call Aircall hadn't finished processing the first
  -- time it was fetched).
  UNIQUE (aircall_user_id, call_date, direction)
);

-- Supports the query-time rollup described in "Query pattern" above:
-- a date-range filter across every staff member (call_date leading),
-- grouped by staff_email. The UNIQUE constraint's own index leads with
-- aircall_user_id, which doesn't give a usable prefix for "every
-- staff member's stats over a date range" — this is a genuinely
-- separate index, not a duplicate of the constraint's own index (same
-- reasoning appfolio_property_actuals used for its own rollup index).
CREATE INDEX IF NOT EXISTS idx_call_stats_date_range
  ON call_stats (call_date, staff_email);

-- RLS: enabled, no permissive policies — all access denied until a
-- tool explicitly grants it via a policy scoped to authenticated
-- users. Matches every other table in this schema.
ALTER TABLE call_stats ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_call_stats_updated_at ON call_stats;
CREATE TRIGGER trg_call_stats_updated_at
  BEFORE UPDATE ON call_stats
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- MIGRATION GATE (Neo's own checklist, run before this applies to any
-- real database)
-- ============================================================
--   [x] Rollback exists — see DROP section below
--   [x] Breaks no existing data — brand-new table, nothing else
--       touched by this file
--   [x] Touches no table other code depends on — additive only; the
--       separate, small `team_member_tool_roles` CHECK widening this
--       build also needs is its own migration (...020000), reviewed
--       and gated on its own
--   [x] Additive, not destructive
--   [ ] Tested on a copy of the data first — no staging copy of
--       Supabase exists in this project (same caveat every migration
--       in this repo has carried since the first one); mitigated here
--       by live-reading real Aircall data before writing this file
--       (see "LIVE VERIFICATION" above) so the column shapes aren't
--       guessed, and by every column being additive/nullable-safe on
--       first sync (no existing rows to migrate)
-- ============================================================


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP TRIGGER IF EXISTS trg_call_stats_updated_at ON call_stats;
-- DROP INDEX IF EXISTS idx_call_stats_date_range;
-- DROP TABLE IF EXISTS call_stats;
--
-- Note: set_updated_at() is NOT dropped here — it is shared with
-- every other table in this schema that uses the same trigger pattern.
--
-- ============================================================
