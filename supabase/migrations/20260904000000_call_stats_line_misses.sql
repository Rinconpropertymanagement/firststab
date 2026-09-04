-- ============================================================
-- Migration: 20260904000000_call_stats_line_misses
-- Created:   2026-09-04
-- Author:    Neo (database specialist)
--
-- Follow-on to the Aircall Call Stats build
-- (projects/hub/call-stats/SPEC.md; schema at
-- supabase/migrations/20260819010000_call_stats.sql). One new table
-- only. No changes to call_stats itself, its sync, its dashboard, or
-- its router. Not building the Aircall sync that populates this table
-- (Q does that next) and not touching call_stats's own team-roles
-- CHECK (this reuses the existing 'call_stats' tool gate — see Access
-- below — so no team_member_tool_roles change is needed here).
--
-- ============================================================
-- WHY THIS TABLE EXISTS — closing a gap call_stats.sql already named
-- ============================================================
-- call_stats.sql's own header documents a confirmed, deliberately-
-- unbuilt gap: live-sampling Rincon's real Aircall data (50 recent
-- calls) found 5 that were inbound, unanswered, and had `user: null`
-- — only a `number` object (the shared line, e.g. "RSC Solimar Team",
-- "Office Line") identified them, no individual staff member at all.
-- call_stats's grain (per staff member, per day) literally cannot
-- represent those rows — there is no staff_email to key them on. That
-- migration's own text: "A pod-level-only fallback table is NOT built
-- in this migration... recommend not designing that shape now, on a
-- guess — confirm first whether this case actually occurs... add it
-- as a small follow-on migration if it does." This is that follow-on.
--
-- ============================================================
-- SCOPED DOWN FROM "ALL 15 LINES" TO THE 2 THAT ACTUALLY NEED IT
-- (per this task's brief — a live Aircall account check done just
-- before this migration was written, not independently re-verified
-- by Neo in this session; noted here rather than claimed as Neo's own
-- live check, matching this project's "confirmed vs. needs live
-- verification" discipline)
-- ============================================================
-- Rincon's real Aircall account has 15 numbers/lines. 13 are tied to
-- one or more individual Aircall users (e.g. "Property Manager -
-- Solimar" -> Dio Lopes) — a miss on one of THOSE lines still carries
-- call.user, so it's already fully covered by call_stats once Q's
-- separate, already-in-progress fix ships (showing non-pod staff
-- too). Only TWO lines have no individual user tied to them at all:
-- "Maintenance Hotline" (+1 800-525-5883) and "Leasing Line"
-- (+1 805-288-1198). Those are the only lines where a genuinely
-- unattributed miss (nobody, individually, to blame) can occur today.
--
-- This table is NOT designed only for those two, though — the two
-- names are not hardcoded anywhere below (no enum, no CHECK on
-- line_name/aircall_number_id). It's designed for "however many
-- shared lines exist," so a third one added in Aircall later needs no
-- migration, just a new value flowing through the same TEXT columns.
--
-- ============================================================
-- GRAIN AND COLUMN SHAPE
-- ============================================================
-- One row per (Aircall line, calendar day, call direction) — mirrors
-- call_stats's own grain style (per staff/day/direction) one level up,
-- at the line instead of the person. Every row in this table
-- represents calls where Aircall's own `user` field was null — there
-- was no individual to attribute the call to, by definition, not a
-- join or lookup failure.
--
-- Two count columns only, deliberately narrower than call_stats's five:
--   - missed_calls: the actual confirmed case this table exists for —
--     inbound calls nobody, individually or collectively, picked up.
--   - total_calls: ALL user-less calls on this line/day/direction,
--     missed or not. Kept as a superset of missed_calls rather than
--     assumed equal to it: the live sample only confirmed unanswered
--     user-less calls exist, it did not rule out an answered-but-
--     unattributed case (e.g. picked up via a shared voicemail/IVR
--     rather than a named person) — total_calls stays honest about
--     that even if, in practice, it turns out to always equal
--     missed_calls once Q's sync is live. No answered_calls column:
--     unlike call_stats, "answered" isn't a useful sub-count here,
--     because there's still nobody to credit for answering it — the
--     distinction call_stats's answered_calls exists to support
--     (crediting a specific person) doesn't apply at this grain.
--
-- No duration columns (no total_talk_seconds, no total_ring_seconds),
-- unlike call_stats. Deliberate, not an oversight: a fully-missed call
-- has no talk time by definition, and call_stats's own
-- total_ring_seconds is specifically "time before ANSWERED," which
-- doesn't describe the population this table is mostly/entirely
-- about (unanswered calls). A "how long did it ring before the caller
-- gave up" number could theoretically be added later if Peter asks
-- for it, but inventing it now, for a metric whose meaning is murky
-- against a mostly-never-answered population, isn't this migration's
-- call to make on a guess (same "don't design ahead of a confirmed
-- need" discipline call_stats.sql itself followed for the pod-level
-- fallback it deferred).
--
-- direction is still its own dimension (not blended into one row),
-- matching call_stats's own reasoning: in practice this case is
-- expected to be inbound-only (an outbound call is placed by a
-- specific Aircall user, so it should always carry a `user`) — but
-- the schema doesn't hardcode that assumption by narrowing the CHECK
-- to 'inbound' only, since it costs nothing to leave both values
-- available and Q's sync should still tell the difference if reality
-- ever proves this wrong.
--
-- call_date is Rincon's own business-day (America/Los_Angeles), NOT a
-- naive UTC truncation of Aircall's started_at — same reasoning as
-- call_stats.call_date's own comment (Aircall timestamps arrive as
-- UTC unix timestamps; a late-evening Pacific call must land on the
-- Pacific calendar day or a day's totals silently split in two).
-- Flagged again here for Q, not assumed carried over automatically.
--
-- ============================================================
-- LINE IDENTITY COLUMNS
-- ============================================================
-- aircall_number_id: Aircall's own numeric ID for the line/number
-- (the `id` on the `number` object attached to a call with no user) —
-- plain TEXT, not a declared FK, same "external system, sync-order
-- not guaranteed" convention as call_stats.aircall_user_id and
-- appfolio_property_id elsewhere in this schema. This is the real
-- upsert key (see UNIQUE constraint below) — stable even if the
-- line's display name is ever edited in Aircall's own dashboard.
--
-- line_name / line_digits: Aircall's own `number.name` (e.g.
-- "Maintenance Hotline") and `number.digits` (e.g. "+18005255883") —
-- for display only, refreshed at each sync, not used as a key. Same
-- "store the human-readable label alongside the stable ID, key on the
-- ID" pattern this schema already uses elsewhere (e.g. property
-- address alongside appfolio_property_id).
--
-- ============================================================
-- DATA INVENTORY (GOVERNANCE.md Rule 4 — written honestly against
-- what THIS table actually is, not copied from either precedent
-- without checking; this is a genuinely different case from
-- call_stats's own entry, and closer to appfolio_property_actuals's)
-- ============================================================
--   pii_fields:          NONE, by construction — and unlike
--                         call_stats, this holds for a structural
--                         reason, not an aggregation choice: every row
--                         in this table exists BECAUSE Aircall itself
--                         recorded no individual user for that call.
--                         There is no staff member identified anywhere
--                         in this table, not even indirectly — that's
--                         the entire premise of the "unattributed"
--                         case this table was built to close.
--                         aircall_number_id/line_name/line_digits
--                         identify a shared company phone line (e.g.
--                         "Maintenance Hotline"), not a person.
--                         Deliberately NOT stored here, even though
--                         Aircall's call records carry it: the
--                         caller's own phone number/raw_digits. Adding
--                         it would reintroduce a real PII question
--                         (a tenant's or caller's phone number) that
--                         this table's whole design otherwise avoids,
--                         and nothing about "how many calls did this
--                         shared line miss today" needs it. Confirmed
--                         against the actual column list below — this
--                         must be re-verified against Q's real sync
--                         code once built, same caveat
--                         appfolio_property_actuals's own inventory
--                         carries, not just assumed from intent.
--   agents_with_access:  the nightly Aircall sync process (system,
--                         service-role key, read-only Aircall API
--                         calls only); any Hub user holding a role for
--                         tool='call_stats' in team_member_tool_roles
--                         — this table reuses call_stats's existing
--                         access gate rather than inventing a new
--                         tool/role, since it's presented as part of
--                         the same Call Stats feature, not a separate
--                         Hub section.
--   privacy_category:    N/A — no personal data, matches
--                         appfolio_property_actuals's own entry, not
--                         call_stats's (which is genuinely personal,
--                         employee-performance data — this table is
--                         not that, and shouldn't be described as if
--                         it were).
--   retention_policy:    indefinite, matching the default used
--                         elsewhere in this schema. None of the
--                         reasoning that made call_stats's own
--                         retention question worth a deliberate flag
--                         (employee monitoring data) applies here —
--                         no employee is identified by any row.
--   ccpa_exportable:     N/A — not tied to any individual.
--   ccpa_deletable:      N/A — not tied to any individual.
--   RLS:                 enabled, no permissive policies at creation —
--                         matches every table in this schema.
--   Audit logging:       none, by design — matches call_stats's and
--                         appfolio_property_actuals's own precedent (a
--                         plain sync of a fetched-and-counted fact
--                         needs no confidence/review workflow).
--
-- Governance path: same conclusion and same reasoning as call_stats's
-- own migration — this does NOT route through Asimov or Mason. No
-- message is ever sent to anyone, no decision about a tenant or
-- applicant is made or influenced, and (an even easier call than
-- call_stats's own) no personal data of any kind is stored here at
-- all. GOVERNANCE.md Rule 4 (this data inventory) still applies in
-- full per its own text ("any new table that stores personal data" —
-- satisfied here by confirming there is none, not by skipping the
-- check). Peter's approval of this build satisfies Rule 6 Standard
-- tier, same as call_stats's own migration.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- TABLE: call_stats_line_misses
-- What it stores: one row per shared Aircall line (a number with no
-- individual staff member tied to it), per calendar day (Rincon
-- business timezone), per call direction — counts of calls that
-- arrived with no `user` at all on Aircall's own call record. Exists
-- specifically for the gap call_stats cannot cover: a miss on a
-- shared queue line (e.g. "Maintenance Hotline," "Leasing Line") that
-- nobody, individually, can be credited or blamed for. Synced
-- nightly, read-only.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS call_stats_line_misses (
  id                     UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Aircall's own numeric ID for the line (call.number.id on a call
  -- with no user). Plain TEXT, not a declared FK — same convention as
  -- call_stats.aircall_user_id. The real upsert key: stable even if
  -- the line's display name is edited later in Aircall's dashboard.
  aircall_number_id      TEXT          NOT NULL,

  -- Aircall's own call.number.name at sync time (e.g. "Maintenance
  -- Hotline"). Display only, not a key — refreshed on every sync, so
  -- a rename in Aircall shows up here without a schema change.
  line_name               TEXT          NOT NULL,

  -- Aircall's own call.number.digits at sync time (e.g.
  -- "+18005255883"). Display only, alongside line_name, same "store
  -- the human label next to the stable ID" pattern used elsewhere in
  -- this schema for external-system records.
  line_digits              TEXT         NOT NULL,

  -- The calendar day this row aggregates, in Rincon's own business
  -- timezone (America/Los_Angeles) — NOT a naive UTC truncation of
  -- Aircall's started_at. Same reasoning as call_stats.call_date
  -- (Aircall timestamps arrive as UTC unix timestamps; a late-evening
  -- Pacific call must land on the Pacific calendar day, or a day's
  -- totals silently split across two rows). Flagged explicitly for Q.
  call_date                DATE         NOT NULL,

  -- Kept as its own dimension even though this case is expected in
  -- practice to be inbound-only (an outbound call is placed by a
  -- specific Aircall user and should always carry `user`) — the CHECK
  -- isn't narrowed to 'inbound' only, so the schema doesn't silently
  -- assume that and Q's sync can still tell the difference if a real
  -- outbound, user-less call is ever found.
  direction                 TEXT        NOT NULL CHECK (direction IN ('inbound', 'outbound')),

  -- ALL calls on this line/day/direction that arrived with no `user`
  -- at all — a superset of missed_calls, not assumed equal to it (see
  -- header). May turn out to always equal missed_calls in practice
  -- once Q's sync is live; this column stays honest either way.
  total_calls               INTEGER     NOT NULL DEFAULT 0 CHECK (total_calls >= 0),

  -- The confirmed, real case this table exists to close: inbound
  -- calls nobody — individually or collectively — picked up, on a
  -- shared line with no staff member Aircall could name. No talk time
  -- or ring-to-answer time is stored for these (see header — a
  -- fully-missed call has none by definition, and no duration column
  -- is invented for the "answered but still unattributed" edge case
  -- either, absent a confirmed real example of it).
  missed_calls               INTEGER    NOT NULL DEFAULT 0 CHECK (missed_calls >= 0),

  -- When this row was last confirmed by the nightly sync — same
  -- purpose and pattern as call_stats.synced_at.
  synced_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Upsert key for the nightly sync job (matches call_stats's own
  -- on_conflict= pattern). A line/day/direction combination gets
  -- overwritten in place if the sync ever re-runs over the same day.
  UNIQUE (aircall_number_id, call_date, direction)
);

-- Supports "this line's unattributed misses over a date range" and
-- "every shared line's misses over a date range" — a date-range
-- filter leading across lines, same reasoning as call_stats's own
-- idx_call_stats_date_range. The UNIQUE constraint's own index leads
-- with aircall_number_id, which doesn't give a usable prefix for a
-- date-range-first query — this is a genuinely separate index.
CREATE INDEX IF NOT EXISTS idx_call_stats_line_misses_date_range
  ON call_stats_line_misses (call_date, aircall_number_id);

-- RLS: enabled, no permissive policies — all access denied until a
-- tool explicitly grants it via a policy scoped to authenticated
-- users. Matches every other table in this schema.
ALTER TABLE call_stats_line_misses ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_call_stats_line_misses_updated_at ON call_stats_line_misses;
CREATE TRIGGER trg_call_stats_line_misses_updated_at
  BEFORE UPDATE ON call_stats_line_misses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- MIGRATION GATE (Neo's own checklist, run before this applies to any
-- real database)
-- ============================================================
--   [x] Rollback exists — see DROP section below
--   [x] Breaks no existing data — brand-new table, nothing else
--       touched by this file (call_stats itself is untouched)
--   [x] Touches no table other code depends on — additive only
--   [x] Additive, not destructive
--   [ ] Tested on a copy of the data first — no staging copy of
--       Supabase exists in this project (same standing caveat every
--       migration in this repo carries); mitigated here by designing
--       strictly against the confirmed shape already established in
--       call_stats.sql's own live verification, plus the specific
--       2-line finding reported in this task's brief, rather than
--       guessing new field names; every column is additive/
--       nullable-safe on first sync (no existing rows to migrate)
-- ============================================================


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP TRIGGER IF EXISTS trg_call_stats_line_misses_updated_at ON call_stats_line_misses;
-- DROP INDEX IF EXISTS idx_call_stats_line_misses_date_range;
-- DROP TABLE IF EXISTS call_stats_line_misses;
--
-- Note: set_updated_at() is NOT dropped here — it is shared with
-- call_stats and every other table in this schema that uses the same
-- trigger pattern.
--
-- ============================================================
