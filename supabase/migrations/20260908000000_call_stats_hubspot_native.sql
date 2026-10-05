-- ============================================================
-- Migration: 20260908000000_call_stats_hubspot_native
-- Created:   2026-09-08
-- Author:    Neo (database specialist)
--
-- Follow-on to the Aircall Call Stats build
-- (projects/hub/call-stats/SPEC.md; core table at
-- supabase/migrations/20260819010000_call_stats.sql; the shared-line
-- follow-on at 20260904000000_call_stats_line_misses.sql). TWO new
-- tables only. No changes to call_stats, call_stats_line_misses, their
-- sync, their dashboard, or their router. No team_member_tool_roles
-- change either — this is presented as part of the same "Call Stats"
-- Hub tile, reusing the existing tool='call_stats' gate, same reason
-- 20260904000000 gave for not needing one of its own.
--
-- ============================================================
-- WHY THIS EXISTS — A SECOND, SEPARATE PHONE SYSTEM
-- ============================================================
-- Rincon calls happen two genuinely different ways today:
--   1. Aircall (already fully covered by call_stats /
--      call_stats_line_misses via lib/aircall-connector.js).
--   2. HubSpot's own native built-in calling feature — a real phone
--      number provisioned directly inside HubSpot, no Aircall
--      involved. Kristen Rau has one of these ([staff phone number removed]), with 97
--      real VOIP-sourced calls on it since 2026-05-13 — genuine,
--      ongoing usage, not a one-off test.
--
-- HubSpot's CALL object already holds BOTH kinds of calls in one
-- place, distinguished by `hs_call_source`:
--   - INTEGRATIONS_PLATFORM = Aircall's own existing integration
--     relaying calls into HubSpot. NOT this build's concern — Rincon's
--     real Aircall data is already covered by call_stats and must
--     never be double-counted from this second path. Whoever builds
--     the HubSpot connector must filter hs_call_source = 'VOIP' only.
--   - VOIP = a call placed or received on HubSpot's own native line.
--     THIS is what these two tables exist to hold.
--
-- Peter was explicit: this does NOT need to be blended into call_stats
-- as one per-person total. It is tracked as its own separate line,
-- which is exactly why instruction #2 below is a genuinely separate
-- table, not a column added to call_stats.
--
-- ============================================================
-- LIVE VERIFICATION (done before writing this migration, via
-- HubSpot's CRM API against Rincon's real, live HubSpot account,
-- 2026-09-08 — same "confirmed live, not assumed from docs"
-- discipline call_stats.sql's own header applied to Aircall)
-- ============================================================
-- Confirmed against real CALL records (not assumed from HubSpot's
-- documentation):
--
--   1. hs_call_direction -> "INBOUND" / "OUTBOUND", UPPERCASE. This is
--      a DIFFERENT casing convention than Aircall's own lowercase
--      'inbound'/'outbound' (the exact strings call_stats.direction's
--      CHECK requires). Both tables below keep the same lowercase
--      CHECK as call_stats/call_stats_line_misses, for consistency
--      across this schema's own direction columns — flagged here so
--      whoever writes the HubSpot sync lowercases hs_call_direction
--      before insert; it will otherwise fail the CHECK below outright
--      (a loud failure, not a silent one, which is the safer of the
--      two ways this could go wrong).
--
--   2. hs_call_duration -> a STRING of MILLISECONDS (e.g. "214000" =
--      214 seconds; "0" on the sampled MISSED call). Aircall's own
--      call_stats.total_talk_seconds is SECONDS — a HubSpot sync must
--      divide by 1000 before writing into total_talk_seconds below.
--      NOT independently confirmed: whether this figure is "talk time
--      only" (call_stats's own total_talk_seconds = ended_at -
--      answered_at) or "total connected duration" more broadly —
--      HubSpot's CALL object does not appear to expose separate
--      started/answered/ended timestamps the way Aircall's does, so
--      there is no way to independently derive or cross-check this
--      split the way Aircall's three-timestamp shape allowed. Treated
--      as "close enough to talk time" for now (the "0" on a MISSED
--      call is consistent with that reading) but flagged, not asserted
--      as confirmed — re-verify against HubSpot's own property
--      definition for hs_call_duration before treating this as settled.
--
--   3. hs_call_status -> real observed values: "COMPLETED", "MISSED",
--      "BUSY", "QUEUED". COMPLETED and MISSED are unambiguous
--      (answered_calls / missed_calls below). BUSY and QUEUED are NOT
--      bucketed into either column by this schema — see "OPEN ITEM:
--      QUEUED / BUSY" below. total_calls is a deliberate SUPERSET of
--      answered_calls + missed_calls for exactly this reason (same
--      "don't assume equal, stay honest" reasoning
--      call_stats_line_misses.total_calls already uses relative to its
--      own missed_calls).
--
--   4. hs_call_from_number / hs_call_to_number -> E.164 strings (e.g.
--      "[staff phone number removed]"). This is the ONLY confirmed-reliable per-person
--      attribution signal for HubSpot-native calls — NOT
--      hubspot_owner_id, which was confirmed unreliable: every one of
--      ~30 sampled real Aircall-sourced (INTEGRATIONS_PLATFORM) calls
--      carried the identical hubspot_owner_id ("384054033") regardless
--      of which real staff member handled the call, with the real name
--      (when present at all) buried as free text inside hs_call_body
--      instead (e.g. "answered by Kristen Rau"). Only a SINGLE real
--      VOIP call's owner_id was checked before broadening the query —
--      not confirmed reliable for VOIP calls either at any real
--      sample size. This is why table 1 below keys tracking on the
--      actual phone number, never on hubspot_owner_id or any other
--      HubSpot identity field.
--
--   5. hs_createdate -> ISO-8601 UTC (e.g.
--      "2026-09-08T22:46:19.824Z"). Same "convert to Rincon's own
--      Pacific business day, don't naively truncate UTC" requirement
--      call_stats.call_date's own comment already states for Aircall's
--      unix timestamps — flagged again here for whoever writes the
--      HubSpot sync, not assumed to carry over automatically.
--
-- NOT independently verified yet (flagged, not asserted as confirmed
-- — same discipline aircall-connector.js's own header applies to
-- Aircall's pagination/auth before Q wrote sync code against it):
--   - The real pagination shape of HubSpot's actual
--     POST /crm/v3/objects/calls/search endpoint.
--   - Real rate-limit behavior on that endpoint.
--   - Whether a scoped, read-only private-app token (scoped to at
--     least crm.objects.calls.read) is sufficient, or whether a
--     broader scope ends up required in practice.
--   These were only checked through an interactive tool layer, not a
--   raw HTTPS call the way aircall-connector.js's own header documents
--   doing for Aircall. Whoever writes lib/hubspot-connector.js must
--   give this the exact same live-verification treatment — a real
--   response, re-checked, not carried over from this note — before
--   treating any of it as confirmed. This migration does not depend on
--   the answer (it only shapes storage), but the sync code that
--   populates these tables absolutely does.
--
-- No live HubSpot credential exists in this environment for
-- server-side/API use yet — only an interactive, logged-in-user
-- connection was available for this investigation. Peter still needs
-- to generate a HubSpot private-app access token (Settings ->
-- Integrations -> Private Apps, scoped to at minimum
-- crm.objects.calls.read) before any sync can run for real. This
-- migration can be applied and built against without it; a live
-- network test cannot happen until it exists.
--
-- ============================================================
-- OPEN ITEM: QUEUED / BUSY bucketing (not resolved by this schema —
-- flagged, not guessed)
-- ============================================================
-- A single QUEUED-status call was observed that otherwise looked like
-- an outbound, answered call. Neither QUEUED nor BUSY is mapped into
-- answered_calls or missed_calls by this migration — inventing that
-- mapping now, on one sampled example, would be a guess presented as a
-- confirmed schema decision. Both tables are shaped so nothing is
-- silently lost either way: total_calls (table 2) / total_calls (table
-- 1... see below) counts every call seen regardless of status, so
-- `total_calls - answered_calls - missed_calls` is always a real,
-- inspectable "other status" count rather than data that quietly
-- vanished. Whoever writes the HubSpot sync should log a per-status
-- breakdown in its own summary object the same way lib/sync.js already
-- does for Aircall (calls_unattributed_no_user, calls_unmatched_email,
-- etc.) rather than silently dropping BUSY/QUEUED calls from the count.
--
-- ============================================================
-- WHY THE JOIN CONVENTION MATCHES call_stats, NOT THIS SCHEMA'S
-- INTERNAL UUID-FK PATTERN
-- ============================================================
-- This schema does use real declared foreign keys when both tables are
-- Rincon-internal (e.g. maintenance_requests.property_id REFERENCES
-- properties(id)) — but always on a UUID primary key, never on a
-- natural-key TEXT column. The relationship these two new tables need
-- is closer in kind to call_stats.staff_email -> users.email (an
-- external-fact row identifying a person by a natural key that must
-- keep working even if the identity-side row changes or disappears
-- later) than to a parent/child business-record relationship. So:
-- table 2's phone_number matches table 1's phone_number, and table 1's
-- staff_email matches users.email, both by plain TEXT equality at
-- query/sync time, neither a declared FK — exactly call_stats's own
-- convention, not reinvented. Concretely, this means if Peter ever
-- stops tracking a number (deletes its row from table 1), table 2's
-- historical rows for that number are NOT deleted or blocked by any
-- constraint — they simply stop resolving to a name/pod at read time,
-- the same "sync-populated fact rows outlive identity-table churn"
-- property call_stats.staff_email already has relative to users.
--
-- ============================================================
-- DATA INVENTORY (GOVERNANCE.md Rule 4) — citing the existing
-- precedent's conclusion, not re-deriving governance from scratch
-- ============================================================
-- SPEC.md's Design Decision 5 (cited, not re-litigated) already
-- established the governance conclusion for this entire category of
-- data: Rincon employee call-activity metadata is real personal data
-- about an identifiable person, Rule 4 (this section) applies to it in
-- full, but it does NOT route through Asimov or Mason — not because
-- "no personal data is involved," but because Asimov/Mason's scope
-- (GOVERNANCE.md's AI Governance Rules and Fair Housing Standard,
-- cover to cover) is tenant/applicant/housing-decision risk, and
-- nothing here is any of those: no message is ever sent to anyone, no
-- decision about a tenant or applicant is made or influenced, and
-- there is no applicant, tenant, or housing decision anywhere in this
-- design. Same conclusion applies here, same reasoning, same citation
-- — this is a second phone system feeding the same already-reviewed
-- category of data, not a new category needing its own governance
-- pass.
--
--   pii_fields (call_stats_hubspot_native_numbers):
--                         phone_number (a real device tied to one
--                         specific Rincon employee) and staff_email (a
--                         direct identifier — a named employee's real
--                         email). This table's entire reason for
--                         existing is "which real number belongs to
--                         which real person" — same honesty standard
--                         call_stats.sql's header applied to itself,
--                         not copied from appfolio_property_actuals's
--                         "NONE, by construction" entry.
--   pii_fields (call_stats_hubspot_native_calls):
--                         phone_number — an indirect identifier, same
--                         character as call_stats.aircall_user_id: not
--                         independently meaningful without a join
--                         (here, to call_stats_hubspot_native_numbers,
--                         then to users), but once joined, every count
--                         column next to it (total_calls,
--                         answered_calls, missed_calls,
--                         total_talk_seconds) is performance data about
--                         the specific named person that number
--                         resolves to.
--   agents_with_access:   the (not yet built) nightly HubSpot sync
--                         process (system, read-only HubSpot API calls
--                         only, per the "GET-only, narrowly-named
--                         functions" discipline aircall-connector.js
--                         already established for the same class of
--                         connector); any Hub user holding 'admin' or
--                         'pod_lead' for tool='call_stats' in
--                         team_member_tool_roles — reusing call_stats's
--                         existing access gate, not a new one, same as
--                         call_stats_line_misses's own choice.
--   privacy_category:     Employee call-activity / performance
--                         metadata — the exact same category
--                         call_stats.sql's own entry already
--                         established (not tenant/applicant data, not
--                         Fair Housing-relevant), just a second real
--                         phone system feeding it. Governed by
--                         California employment-privacy law and CCPA,
--                         not GOVERNANCE.md's tenant-facing rules — per
--                         SPEC.md Design Decision 5, cited above.
--   retention_policy:     Same as call_stats.sql's own entry —
--                         indefinite, matching Peter's explicit
--                         2026-08-20 decision for the first phone
--                         system's data. Not re-litigated here; this is
--                         the same category of data, just a second
--                         source feeding it. If Peter ever wants a
--                         rolling retention window, that's a decision
--                         to apply consistently to both call_stats and
--                         these two tables together, not one to make
--                         piecemeal per data source.
--   ccpa_exportable:      Same as call_stats.sql's own entry — TRUE.
--                         California's CCPA employee-data exemption
--                         expired January 1, 2023; a Rincon staff
--                         member's own data-access request would
--                         reasonably expect these tables' rows about
--                         them included, same reasoning already applied
--                         to call_stats.
--   ccpa_deletable:       Same as call_stats.sql's own entry — TRUE,
--                         mechanically (redact-in-place on phone_number
--                         / staff_email, matching the
--                         claims.claim_text -> "[REDACTED]" pattern
--                         already used elsewhere in this schema).
--                         Whether Rincon is legally REQUIRED to honor a
--                         deletion request for this data category
--                         remains the same open employment-law question
--                         call_stats.sql's own entry already flagged —
--                         not re-resolved here, not a schema question.
--   RLS:                  enabled on both new tables, no permissive
--                         policies at creation — matches every table in
--                         this schema.
--   Audit logging:        none, by design — matches call_stats's own
--                         precedent (a plain sync of a fetched-and-
--                         summed fact needs no confidence/review
--                         workflow; a human-maintained allowlist table
--                         needs no audit trail beyond its own
--                         created_at/updated_at, same as every other
--                         small config table in this schema, e.g.
--                         team_member_tool_roles).
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- TABLE: call_stats_hubspot_native_numbers
-- What it stores: a small, human-editable allowlist — which real
-- phone numbers are tracked for the HubSpot-native-line feature, and
-- which real Rincon staff member each one belongs to (matched to
-- users.email, same join convention as call_stats.staff_email). A
-- number is tracked ONLY if a row exists here — this is the entire
-- opt-in mechanism. Excluding someone (e.g. a staff member Peter does
-- not want tracked) is simply never adding a row for their number; no
-- exclusion list, no special-case logic anywhere else needs to know
-- about them. One staff member may have more than one tracked number
-- (a real, current case: Kristen Rau has two lines total, only one of
-- which is HubSpot-native today) — phone_number is unique, staff_email
-- is not.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS call_stats_hubspot_native_numbers (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The tracked HubSpot-native line, in EXACTLY the E.164 string
  -- format HubSpot's own hs_call_from_number/hs_call_to_number use
  -- (confirmed live, e.g. "[staff phone number removed]") — no spaces, dashes, or
  -- other formatting. The sync (once built) joins by plain string
  -- equality against hs_call_from_number/hs_call_to_number; a
  -- mismatched format here means calls for that number silently never
  -- match anything, with no error raised anywhere (HubSpot would just
  -- return zero matching calls, forever, for a malformed number — not
  -- a loud failure). The CHECK below is a lightweight guard against
  -- exactly that silent-failure shape, not full E.164 validation.
  phone_number   TEXT          NOT NULL UNIQUE
                                CHECK (phone_number ~ '^\+[1-9][0-9]{6,14}$'),

  -- Matches users.email at query time — same join convention
  -- call_stats.staff_email already uses (see header). NOT a declared
  -- FK, same reasoning: this table should be editable by hand (Peter
  -- adding a number the moment someone's HubSpot line goes live)
  -- without being blocked by users-table timing, and a person's
  -- historical tracked-number row shouldn't become invalid just
  -- because a users row is edited or deactivated later.
  staff_email    TEXT          NOT NULL,

  -- Optional human context for whoever is reading this table directly
  -- in Supabase's SQL editor (e.g. "Kristen Rau's HubSpot native line
  -- — added 2026-09-08"). Free text, never read by any sync or query
  -- logic — purely for a human maintaining this allowlist by hand.
  notes          TEXT,

  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- RLS: enabled, no permissive policies — all access denied until a
-- tool explicitly grants it via a policy scoped to authenticated
-- users. Matches every other table in this schema.
ALTER TABLE call_stats_hubspot_native_numbers ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_call_stats_hubspot_native_numbers_updated_at ON call_stats_hubspot_native_numbers;
CREATE TRIGGER trg_call_stats_hubspot_native_numbers_updated_at
  BEFORE UPDATE ON call_stats_hubspot_native_numbers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TABLE: call_stats_hubspot_native_calls
-- What it stores: one row per (tracked phone number, calendar day,
-- call direction) — aggregated HubSpot-native (VOIP-sourced) call
-- counts and talk-time totals for that slice. Same grain philosophy as
-- call_stats: sums and counts, never pre-divided averages ("average
-- call length" = total_talk_seconds / answered_calls, computed live at
-- query time, same as call_stats's own total_talk_seconds); Pacific-
-- day bucketing, not a naive UTC truncation of hs_createdate; direction
-- tracked as its own dimension because "missed" means something
-- different for inbound vs. outbound, exactly call_stats's own
-- reasoning. A genuinely SEPARATE table from call_stats — not a reuse
-- of its columns or constraints — per Peter's explicit instruction
-- that this does not need to be blended into one per-person total; it
-- is its own line, tracked on its own.
--
-- Deliberately narrower than call_stats's five stat columns: there is
-- no total_ring_seconds here. call_stats can compute "speed to answer"
-- because Aircall exposes started_at/answered_at/ended_at as three
-- separate timestamps. HubSpot's CALL object, as confirmed live, does
-- not expose an equivalent split — only hs_call_duration, a single
-- total figure. Inventing a ring-time column with no confirmed field
-- to source it from would be a guess dressed up as a schema decision;
-- not done here (see header's "LIVE VERIFICATION" note #2). If a real
-- HubSpot field for this ever gets confirmed, add it as its own
-- follow-on migration then — same "don't design ahead of a confirmed
-- need" discipline call_stats.sql itself used for the pod-level
-- fallback it deferred, and call_stats_line_misses.sql used for the
-- duration columns it declined to add.
-- RLS: enabled, locked by default.
-- ============================================================

CREATE TABLE IF NOT EXISTS call_stats_hubspot_native_calls (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Matches call_stats_hubspot_native_numbers.phone_number at query
  -- time. NOT a declared FK — see header's "WHY THE JOIN CONVENTION
  -- MATCHES call_stats" note. Resolving to a staff member's name/pod
  -- is a join through call_stats_hubspot_native_numbers -> users,
  -- done at read time, never baked into this row (same "don't copy
  -- pod onto the row, look it up live" discipline call_stats.sql's own
  -- header already uses).
  phone_number          TEXT          NOT NULL,

  -- The calendar day this row aggregates, in Rincon's own business
  -- timezone (America/Los_Angeles) — NOT a naive UTC truncation of
  -- HubSpot's hs_createdate (confirmed live: hs_createdate arrives as
  -- an ISO-8601 UTC timestamp, e.g. "2026-09-08T22:46:19.824Z"). A
  -- late-evening Pacific call must land on the Pacific calendar day,
  -- or a day's totals silently split across two rows — same risk
  -- call_stats.call_date's own comment already flags for Aircall's
  -- timestamps, re-flagged here for whoever writes the HubSpot sync
  -- rather than assumed to carry over automatically.
  call_date             DATE          NOT NULL,

  -- Confirmed live: HubSpot's own hs_call_direction arrives as
  -- UPPERCASE "INBOUND"/"OUTBOUND" — a DIFFERENT casing convention
  -- than Aircall's lowercase 'inbound'/'outbound'. This CHECK stays
  -- lowercase to match call_stats/call_stats_line_misses's own
  -- direction columns for consistency across this schema; the HubSpot
  -- sync must lowercase hs_call_direction before insert, or every
  -- insert will fail this CHECK outright (a loud, safe failure, not a
  -- silent one).
  direction             TEXT          NOT NULL CHECK (direction IN ('inbound', 'outbound')),

  -- EVERY HubSpot-native (VOIP-sourced) call seen for this
  -- number/day/direction, regardless of hs_call_status — a deliberate
  -- SUPERSET of answered_calls + missed_calls, same reasoning
  -- call_stats_line_misses.total_calls already uses relative to its
  -- own missed_calls: BUSY and QUEUED calls (see header's "OPEN ITEM")
  -- are counted here but bucketed into neither answered_calls nor
  -- missed_calls below, so nothing is silently lost from the total
  -- even though its exact status isn't resolved by this schema.
  total_calls           INTEGER       NOT NULL DEFAULT 0 CHECK (total_calls >= 0),

  -- hs_call_status = 'COMPLETED' — the unambiguous "someone talked"
  -- case, confirmed live.
  answered_calls        INTEGER       NOT NULL DEFAULT 0 CHECK (answered_calls >= 0),

  -- hs_call_status = 'MISSED' only — deliberately NOT including BUSY
  -- (see header's "OPEN ITEM: QUEUED / BUSY bucketing"). For inbound,
  -- this is a real responsiveness signal (nobody picked up); for
  -- outbound, it means the other party never answered (not a staff
  -- performance signal) — same direction-dependent meaning
  -- call_stats.missed_calls's own comment already documents, kept
  -- honest here the same way, by direction being its own column.
  missed_calls          INTEGER       NOT NULL DEFAULT 0 CHECK (missed_calls >= 0),

  -- sum(hs_call_duration / 1000) over COMPLETED calls only, in
  -- seconds. hs_call_duration arrives as a STRING OF MILLISECONDS
  -- (confirmed live, e.g. "214000") — the /1000 conversion must happen
  -- in the sync before this column is written; never insert a raw
  -- hs_call_duration value here directly. "Average call length" =
  -- this / answered_calls, computed live at query time in router.js —
  -- never stored pre-divided, same rule as call_stats's own
  -- total_talk_seconds. NOT independently confirmed to mean exactly
  -- "talk time only" the way call_stats's own total_talk_seconds does
  -- (see header's "LIVE VERIFICATION" note #2) — treated as the
  -- closest available equivalent, flagged rather than asserted as
  -- equivalent.
  total_talk_seconds    INTEGER       NOT NULL DEFAULT 0 CHECK (total_talk_seconds >= 0),

  -- When this row was last confirmed by the (not yet built) nightly
  -- HubSpot sync — same purpose and pattern as call_stats.synced_at.
  synced_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- Upsert key for the nightly sync job, same on_conflict= pattern
  -- call_stats/call_stats_line_misses already use. A
  -- number/day/direction combination gets overwritten in place if the
  -- sync ever re-runs over the same day.
  UNIQUE (phone_number, call_date, direction)
);

-- Supports "this tracked number's HubSpot-native stats for [date
-- range]" and "every tracked number's stats for [date range]" — a
-- date-range filter leading across numbers, same reasoning as
-- call_stats's own idx_call_stats_date_range. The UNIQUE constraint's
-- own index leads with phone_number, which doesn't give a usable
-- prefix for a date-range-first query — this is a genuinely separate
-- index.
CREATE INDEX IF NOT EXISTS idx_call_stats_hubspot_native_calls_date_range
  ON call_stats_hubspot_native_calls (call_date, phone_number);

-- RLS: enabled, no permissive policies — all access denied until a
-- tool explicitly grants it via a policy scoped to authenticated
-- users. Matches every other table in this schema.
ALTER TABLE call_stats_hubspot_native_calls ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_call_stats_hubspot_native_calls_updated_at ON call_stats_hubspot_native_calls;
CREATE TRIGGER trg_call_stats_hubspot_native_calls_updated_at
  BEFORE UPDATE ON call_stats_hubspot_native_calls
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- MIGRATION GATE (Neo's own checklist, run before this applies to any
-- real database)
-- ============================================================
--   [x] Rollback exists — see DROP section below
--   [x] Breaks no existing data — two brand-new tables; call_stats and
--       call_stats_line_misses are completely untouched by this file
--   [x] Touches no table other code depends on — additive only; no
--       team_member_tool_roles change (reuses the existing
--       tool='call_stats' gate, same reasoning
--       call_stats_line_misses.sql already gave)
--   [x] Additive, not destructive
--   [ ] Tested on a copy of the data first — no staging copy of
--       Supabase exists in this project (same standing caveat every
--       migration in this repo carries); mitigated here by designing
--       strictly against real, live-confirmed HubSpot field shapes
--       (see "LIVE VERIFICATION" above) rather than guessing from
--       documentation, and by every column being additive/nullable-
--       safe on first sync (no existing rows to migrate, no sync code
--       exists yet to even populate these tables)
-- ============================================================


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP TRIGGER IF EXISTS trg_call_stats_hubspot_native_calls_updated_at ON call_stats_hubspot_native_calls;
-- DROP INDEX IF EXISTS idx_call_stats_hubspot_native_calls_date_range;
-- DROP TABLE IF EXISTS call_stats_hubspot_native_calls;
--
-- DROP TRIGGER IF EXISTS trg_call_stats_hubspot_native_numbers_updated_at ON call_stats_hubspot_native_numbers;
-- DROP TABLE IF EXISTS call_stats_hubspot_native_numbers;
--
-- Note: set_updated_at() is NOT dropped here — it is shared with
-- call_stats, call_stats_line_misses, and every other table in this
-- schema that uses the same trigger pattern.
--
-- ============================================================
