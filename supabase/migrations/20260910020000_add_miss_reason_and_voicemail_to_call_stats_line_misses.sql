-- ============================================================
-- Migration: 20260910020000_add_miss_reason_and_voicemail_to_call_stats_line_misses
-- Created:   2026-09-10
-- Author:    Neo (database specialist)
--
-- Three nullable columns on the existing `call_stats_line_misses` table
-- (created 20260904000000_call_stats_line_misses.sql, extended
-- 20260910010000_add_sole_user_attribution_to_call_stats_line_misses.sql).
-- Build approved by Peter 2026-09-10.
--
-- Purely additive. No new table. `call_stats` is not touched — not its
-- columns, not its grain, not its UNIQUE constraint, not its sync path.
-- `call_stats_line_misses`'s own grain and its
-- UNIQUE (aircall_number_id, call_date, direction) constraint are ALSO
-- untouched — see "THE GRAIN QUESTION" below, which is the load-bearing
-- decision in this file. The two columns added on 2026-09-10,
-- `sole_user_email` and `ring_user_count`, are not altered, not dropped,
-- and not re-typed; shipped code that reads them keeps working.
--
-- No application code ships from this file. The nightly-sync change that
-- populates these columns, the one-time re-fetch backfill described
-- below, the router rollup and the dashboard are all Q's and Tron's next
-- steps — see "WHAT THIS MIGRATION DELIBERATELY DOES NOT DO".
-- This migration is NOT applied here: Peter applies it himself by pasting
-- it into Supabase's SQL Editor, per this project's standing convention
-- (no CLI and no database URL in this environment). Every statement below
-- is idempotent and safe to run twice.
--
-- ============================================================
-- WHY THESE COLUMNS EXIST — in one plain sentence, then the evidence
-- ============================================================
-- Right now the Answer Rate charges a person for every missed call on a
-- line that rings only them, and real Aircall data proves that lumps
-- three genuinely different things into one number.
--
-- Kristen Rau's two lines, 2026-09-01..2026-09-10, 41 missed calls
-- (live Aircall figures reported in this build's brief; recorded as
-- reported to Neo, not independently re-fetched in this session — same
-- "confirmed vs. needs live verification" discipline the three sibling
-- migrations use):
--
--   missed_call_reason      count   left voicemail   median duration
--   ---------------------   -----   --------------   ---------------
--   agents_did_not_answer      21               12            68 sec
--   no_available_agent         16                6            50 sec
--   short_abandoned             4                0             9 sec
--
--   * agents_did_not_answer — somebody was available and the phone rang
--     out. Genuinely attributable to a person.
--   * no_available_agent — nobody was logged in. Confirmed by Peter on
--     2026-09-10 that this is Kristen manually switching to the phone
--     tree for lunch, plus her 9am start. It is a schedule, not a
--     performance failure.
--   * short_abandoned — the caller hung up after a MEDIAN OF NINE
--     SECONDS. Nobody could have answered these.
--
-- Peter's decision, approved 2026-09-10: ONLY `agents_did_not_answer`
-- counts against a person. The other two stay visible on the dashboard
-- and are charged to nobody. Effect on Kristen's rate in that window:
-- 53% counting everything, 69% counting only this one.
--
-- Without a column recording the reason, that distinction does not exist
-- in Supabase at all. `missed_call_reason` lives on Aircall's individual
-- call object, and lib/sync.js's buildLineMissAggregates() currently
-- reads `call.answered_at == null` and nothing else — its own LIVE
-- VERIFICATION block says so explicitly: "missed_call_reason exists on
-- some calls but isn't read here." The raw calls are never stored (spec's
-- Design Decision 2), so once a night's aggregation has run, the reason
-- split for that night is gone unless it was written down that night.
--
-- ============================================================
-- WHY VOICEMAIL IS CAPTURED NOW EVEN THOUGH NO METRIC USES IT YET
-- ============================================================
-- Aircall's call object carries a `voicemail` field that is a URL or
-- null. Peter has NOT decided whether "left a voicemail" becomes its own
-- dashboard number, and this migration does not build one.
--
-- It is captured anyway, and the test is the same one `ring_user_count`
-- passed in the previous migration — not "might we want this later," but
-- "is it destroyed if we do not capture it tonight." It is: the field is
-- per-call, the calls are never stored, and the nightly aggregate is all
-- that survives. The live table above already shows the fact is not
-- uniform across reasons (12 of 21 vs 6 of 16 vs 0 of 4), so it carries
-- real information — a missed call where the caller cared enough to leave
-- a message is a different event from one where they did not.
--
-- *** WHAT IS STORED IS A COUNT. THE VOICEMAIL URL IS NEVER STORED. ***
-- Not an oversight and not a detail to "improve" later. A voicemail
-- recording is call content — a tenant or owner's own recorded voice —
-- and SPEC.md's "Explicitly Out of Scope" is absolute on this: no
-- recordings, no transcripts, no call content of any kind are ever
-- fetched or stored by this table or anything built on it. Storing the
-- URL would put a pointer to a tenant's recorded voice in a Hub table
-- whose entire design has avoided caller identity from day one (see
-- 20260904000000's inventory on deliberately NOT storing the caller's
-- phone number). Count the voicemails. Never store the link.
--
-- ============================================================
-- THE GRAIN QUESTION — the decision this migration exists to make
-- ============================================================
-- Recording a reason means one of two things, and they are not close.
--
-- ------------------------------------------------------------
-- OPTION 1 — CHANGE THE GRAIN to (line, day, direction, reason),
-- widening UNIQUE (aircall_number_id, call_date, direction) to include
-- the reason. *** REJECTED. Four independent reasons, any one of which
-- alone would be enough. ***
-- ------------------------------------------------------------
--   1. It breaks the shipped sync THE MOMENT IT IS APPLIED, not when Q's
--      change lands. lib/sync.js's buildLineMissAggregates() buckets on
--      `${aircallNumberId}|${callDate}|${direction}` and router.js
--      upserts on exactly that key. Peter applies migrations by hand and
--      Q's code ships separately; between those two events the nightly
--      job must keep working. The previous migration held that line
--      deliberately and this one holds it too.
--   2. The reason is NULL on a large share of the rows this table
--      already holds, and a NULL in a UNIQUE constraint does not
--      conflict with another NULL under Postgres's default NULLS
--      DISTINCT behavior. The upsert would stop updating and start
--      INSERTING A DUPLICATE ROW EVERY NIGHT for every answered or
--      reason-less call. That is not a theoretical worry: this table
--      holds answered calls on purpose. lib/sync.js's own live
--      verification found 3 inbound+answered and 25 outbound+answered
--      user-less calls in a 573-call sample, and an answered call has no
--      missed_call_reason at all. A silently duplicating nightly upsert
--      on a table feeding an employee-performance number is about the
--      worst failure available here.
--   3. Existing history cannot be re-grained. Every row already in the
--      table is a blend of all reasons. Splitting it needs a full
--      re-fetch from Aircall, and until that ran the table would hold two
--      incompatible kinds of row with nothing on either to say which is
--      which.
--   4. It collides with the one-time sole-user backfill that is about to
--      be written (previous migration's NOTES FOR Q #6), which is a
--      single UPDATE pass over rows addressed by exactly the key this
--      option would change.
--
-- ------------------------------------------------------------
-- OPTION 2 — PER-REASON COUNT COLUMNS, one per known value. Rejected in
-- its pure form, for a real reason and not a stylistic one.
-- ------------------------------------------------------------
-- Keeps the upsert key intact, which is right. But it hard-codes the
-- three values observed in ONE ten-day window into the schema. Aircall's
-- documentation lists others (`abandoned_in_ivr` and similar) that simply
-- did not occur in this sample. The instant Aircall returns a fourth
-- value, a fixed set of columns either silently drops those misses — an
-- undercount that conceals itself, the exact failure the previous
-- migration's fail-loud rule exists to prevent — or forces a new
-- migration before the number is trustworthy again. Neither is
-- acceptable for a value this schema does not control.
--
-- ------------------------------------------------------------
-- OPTION 3 — A JSONB reason→count map ALONE. Also rejected on its own.
-- ------------------------------------------------------------
-- Open-ended, so nothing vanishes — but it would put the ONE number that
-- charges a named employee inside an untyped blob with no CHECK, no
-- integer guarantee, and a rollup query reading
-- `(map->>'agents_did_not_answer')::int`, which returns NULL when the key
-- is absent. SUM() ignores NULLs, so a missing key becomes a silent
-- undercount of someone's misses. Everything else in this table's history
-- says do not build the load-bearing number that way.
--
-- ------------------------------------------------------------
-- CHOSEN — the grain stays exactly as it is, and the reason split
-- becomes ATTRIBUTES of the existing row: ONE typed column for the ONE
-- reason Peter's rule actually charges, plus a JSONB catch-all carrying
-- the complete breakdown including any value nobody has seen yet.
-- ------------------------------------------------------------
--   missed_calls_agents_did_not_answer  INTEGER  — the only number a
--     person's Answer Rate is computed from. It gets a real type, a real
--     range CHECK, and a name that spells out the Aircall value verbatim
--     so the mapping can never be misremembered. It is one column,
--     because Peter approved exactly one rule; the other two reasons get
--     no column of their own, because no metric charges them to anyone
--     and inventing columns ahead of a proven need is this project's
--     standing discipline (PROPERTY-BRAIN-ARCHITECTURE.md §1.5, and all
--     three sibling migrations' own headers).
--
--   missed_calls_by_reason  JSONB  — the complete reason→count map for
--     that row, INCLUDING agents_did_not_answer, and including any future
--     value Aircall invents. There is no CHECK enumerating the allowed
--     keys, deliberately: an unrecognized reason lands in the map on its
--     own, is visible in the Supabase table editor the same day, and
--     needs no migration to stop being lost. Contrast `direction`, which
--     does carry a CHECK — that is a closed two-value set confirmed live
--     across three separate samples. `missed_call_reason` is an
--     open enumeration owned by a vendor. Constraining it here would
--     convert Aircall shipping a new value into a crashed nightly sync.
--
-- That combination is deliberately NOT redundant bookkeeping. The typed
-- column is the metric; the map is the audit trail and the future-proof
-- half. Their relationship is a hard contract stated in NOTES FOR Q
-- below: the map's values sum to `missed_calls`, and the typed column
-- equals the map's `agents_did_not_answer` entry (0 when absent).
--
-- Voicemail follows the same grain, one column, flat:
--   voicemails_left  INTEGER  — how many calls on this (line, day,
--     direction) row left a voicemail. NOT split per reason. The
--     per-reason voicemail cross-tab in the table at the top of this file
--     is a real fact, but nothing asks for it, no decision turns on it,
--     and a second JSONB or a nested structure would be exactly the
--     ahead-of-need complexity the option analysis above just rejected.
--     If Peter later wants "voicemails on agents_did_not_answer misses
--     only," that is a small follow-on migration with a real need behind
--     it — the same path 20260904000000 itself took.
--
-- ============================================================
-- NULL MEANS "NOT CAPTURED" ON THESE THREE COLUMNS — AND THAT IS THE
-- OPPOSITE OF WHAT NULL MEANS ON sole_user_email. READ THIS ONE TWICE.
-- ============================================================
-- The previous migration was emphatic that a NULL `sole_user_email` means
-- "this line had no sole user that day" and must NEVER be written to mean
-- "we could not find out." These three columns are the reverse, and
-- conflating the two conventions would produce a wrong number quietly:
--
--   NULL   = this row was aggregated by a sync run that did not look at
--            missed_call_reason or voicemail at all. Every row in the
--            table today is in this state, and every row the CURRENT
--            shipped sync writes between this migration being applied and
--            Q's change landing will be too.
--   0      = the sync DID look, and the answer was none.
--
-- A dashboard that reads NULL as 0 would report every historical day as
-- having zero attributable misses — a flattering, entirely false number,
-- and precisely the failure mode answer-rate-redefinition-SPEC.md exists
-- to correct. Q and Tron must treat NULL as "not measured," not as zero,
-- and the page must say so for any date range that reaches back into it.
--
-- The all-or-none CHECK added below makes "was this row captured?" a
-- single unambiguous question rather than three separate ones that could
-- disagree.
--
-- ============================================================
-- BACKFILL: NOT CHEAP THIS TIME. DO NOT ASSUME IT IS.
-- ============================================================
-- The previous migration's backfill was a single UPDATE pass over rows
-- already in Supabase, because ring membership is per-LINE and did not
-- need any call data re-fetched. *** THAT DOES NOT APPLY HERE, AND THE
-- SIMILARITY IS A TRAP. *** `missed_call_reason` and `voicemail` are
-- per-CALL fields. This schema stores no individual call records
-- anywhere, by design. So historical reason and voicemail data is not
-- recoverable from Supabase by any query — filling in the past requires
-- RE-FETCHING the raw calls from Aircall for every day in the window and
-- re-aggregating them.
--
-- That is possible (Aircall's calls API takes a date range, and the
-- nightly job already paginates it) but it is a real job with real
-- rate-limit exposure, not an UPDATE. It is NOT authorized by this
-- migration and is not part of this build's approved scope. Peter has
-- approved capturing these facts going forward. Whether to spend a
-- re-fetch on history is a separate decision he has not been asked for.
--
-- If it is never done, the columns simply stay NULL before the first
-- night Q's change runs, the "NULL means not captured" rule above holds,
-- and the dashboard says so — the same honest-gap handling Design
-- Decision 13 specifies. A quietly wrong number is worse than an honestly
-- missing one; that principle is the entire reason this build exists.
--
-- ============================================================
-- THE `?date=` RE-RUN HAZARD APPLIES HERE TOO, DIFFERENTLY
-- ============================================================
-- router.js's manual `POST /api/call-stats/internal/sync?date=` hatch
-- re-reads the CURRENT line mapping and stamps it onto an old day — the
-- history-rewrite hazard the previous migration documented. For these
-- three columns the same command behaves BETTER, not worse: reason and
-- voicemail come off the re-fetched call objects themselves, which are
-- immutable historical facts, so a re-run fills them in correctly for
-- that day. Re-running an old day is therefore the sanctioned way to
-- capture reason data for a single past day, and it is the mechanism any
-- future backfill would use. It carries the sole_user_email rewrite risk
-- as its side effect, unchanged and already documented. Both facts belong
-- in the comment at that route.
--
-- ============================================================
-- DATA INVENTORY (GOVERNANCE.md Rule 4) — carried forward from the
-- 2026-09-10 correction and AMENDED, not re-derived from scratch
-- ============================================================
-- 20260910010000 corrected this table's inventory from "pii_fields: NONE,
-- by construction" (honest when 20260904000000 was written, false the
-- moment sole_user_email existed) to an employee-performance entry
-- mirroring call_stats's own. That correction stands in full. This
-- migration does not reopen it, does not weaken it, and adds one thing to
-- it:
--
--   pii_fields:          UNCHANGED in kind — call_stats_line_misses
--                         .sole_user_email remains the only direct
--                         identifier, and the counts beside it on any row
--                         where it is populated remain performance data
--                         about that identified person. The three columns
--                         added here JOIN THAT SET on such rows and are
--                         worth naming individually, because one of them
--                         is now the sharpest number in the table:
--                         missed_calls_agents_did_not_answer on a
--                         sole-user row is THE figure that lowers a named
--                         employee's Answer Rate in a weekly staff
--                         meeting. missed_calls_by_reason and
--                         voicemails_left are the same category on such
--                         rows. On rows where sole_user_email is NULL
--                         (the line rang nobody, or rang several) all
--                         three name no one and the row stays genuinely
--                         person-free, exactly as before.
--                         Still deliberately NOT stored, and this
--                         migration must not be read as softening either:
--                         the caller's own phone number/raw_digits, and —
--                         new to this file — the voicemail RECORDING URL,
--                         which is call content and out of scope by
--                         SPEC.md's own absolute terms. A count of
--                         voicemails identifies nobody; a link to one is a
--                         tenant's recorded voice.
--   agents_with_access:  UNCHANGED — the nightly Aircall sync process
--                         (system, service-role key, read-only Aircall API
--                         calls only); any Hub user holding a role for
--                         tool='call_stats' in team_member_tool_roles.
--                         This change adds no new reader, no new tool
--                         value, no new role, and no new external call:
--                         missed_call_reason and voicemail arrive on the
--                         SAME GET /v1/calls response the sync already
--                         fetches. Zero additional Aircall requests.
--   privacy_category:    UNCHANGED — employee performance / call-activity
--                         metadata. Not tenant or applicant data, not Fair
--                         Housing-relevant. Governed by California
--                         employment-privacy law and CCPA, not
--                         GOVERNANCE.md's tenant-facing rules.
--   retention_policy:    UNCHANGED — indefinite (Peter, 2026-08-20).
--   ccpa_exportable:     UNCHANGED — TRUE. A staff member asking "what do
--                         you hold about me" would reasonably expect rows
--                         attributed to them included, these columns among
--                         them.
--   ccpa_deletable:      UNCHANGED — TRUE mechanically, and these columns
--                         do not complicate it. The redact-in-place
--                         pattern still works untouched: overwrite
--                         sole_user_email and the row is once again an
--                         anonymous count-of-calls-on-a-line row.
--                         missed_calls_agents_did_not_answer,
--                         missed_calls_by_reason and voicemails_left all
--                         survive redaction and stay meaningful, because
--                         like ring_user_count they name no one — they
--                         describe a phone line's day.
--   RLS:                 UNCHANGED — enabled on this table since creation,
--                         no permissive policies. This migration adds,
--                         changes and removes no policy. Adding columns to
--                         an RLS-enabled table does not alter its posture:
--                         access stays denied until a tool explicitly
--                         grants it, exactly as every table in this schema
--                         does.
--   Audit logging:       UNCHANGED — none, by design. A plain sync of a
--                         fetched-and-counted fact needs no
--                         confidence/review workflow.
--
-- Neither 20260904000000's nor 20260910010000's file is edited —
-- migrations are never modified after the fact in this repo. The
-- COMMENT ON TABLE re-set at the bottom of this file carries the
-- 2026-09-10 correction forward VERBATIM in substance and appends this
-- amendment, so the database itself remains the single accurate place to
-- read this table's PII status without opening three migration files in
-- the right order.
--
-- Governance path: unchanged and confirmed rather than assumed. Still NOT
-- a compliance build under CLAUDE.md's definition — no message is sent to
-- anyone, no decision about a tenant or applicant is made or influenced,
-- and GOVERNANCE.md's Rules and Fair Housing Standard address
-- tenant/applicant/housing-decision risk, none of which is present. No
-- Asimov gate, no Mason gate. Rule 4 applies in full, which is why the
-- inventory amendment above is mandatory rather than optional. Peter's
-- approval of this build (2026-09-10) satisfies Rule 6 Standard tier.
--
-- ============================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================================
--   - It does not populate any of the three columns. Every existing row,
--     and every row the currently-shipped sync writes until Q's change
--     lands, gets NULL in all three.
--   - It does not change which misses count against a person. Peter's
--     "only agents_did_not_answer" rule is implemented in Q's rollup
--     query and Tron's dashboard, not in the schema. This file only makes
--     the rule expressible.
--   - It does not build a voicemail metric. The fact is captured; no
--     number is defined on it, because Peter has not decided one.
--   - It does not run or authorize any backfill — see the backfill
--     section above for why that is a bigger decision here than it was
--     last time.
--   - It does not touch lib/sync.js, router.js, lib/metrics.js, the
--     connectors, or the dashboard. Q owns those next; Tron owns the
--     Shared Line Misses presentation.
--   - It does not alter, drop or re-type sole_user_email or
--     ring_user_count, or the CHECK constraint added with them.
--   - It adds no index. The existing
--     idx_call_stats_line_misses_date_range (call_date,
--     aircall_number_id) already leads on the date-range filter every
--     dashboard query uses, and this table is small by construction
--     (~12 lines x 2 directions x 1 row per day). An index on a JSONB
--     column, or on a count, would be a structure added ahead of a proven
--     need — revisit only if a real query gets slow, which Hermes would
--     be the one to confirm.
--   - It adds no new `tool` value and no team_member_tool_roles change.
--     This stays inside the Call Stats section's existing access gate.
--
-- ============================================================
-- MIGRATION GATE SELF-CHECK (Neo's standing checklist, run before this is
-- handed to Peter to apply)
-- ============================================================
--   [x] Rollback exists — see the DROP section at the bottom of this
--       file, which also RESTORES the previous COMMENT ON TABLE text
--       rather than nulling it, so rolling this back does not destroy the
--       2026-09-10 PII correction.
--   [x] Does this break any existing data? No. ADD COLUMN IF NOT EXISTS
--       on three brand-new nullable columns with no default — every
--       existing row gets NULL in all three. Nothing is read, moved,
--       overwritten or deleted. No existing column, constraint, index,
--       trigger or policy is altered.
--   [x] Does this touch a table other code depends on? Yes —
--       call_stats_line_misses is read by router.js's Shared Line Misses
--       section and written by lib/sync.js's buildLineMissAggregates()
--       upsert. That is exactly why the grain analysis above lands where
--       it does: UNIQUE (aircall_number_id, call_date, direction) is
--       untouched, so the existing sync keeps working unchanged after this
--       applies and before Q's change lands. An existing SELECT * caller
--       gains three NULL-valued columns; nothing breaks by getting extra
--       columns back.
--   [x] Additive or destructive? Purely additive. No column dropped, no
--       type changed, no existing constraint tightened, no default that
--       could alter existing INSERT/UPDATE behavior.
--   [x] Do the new CHECK constraints risk failing on existing rows? No,
--       and this was checked rather than assumed — it is the one way an
--       ALTER like this can fail on paste. All three constraints are
--       written so that a row with all three columns NULL satisfies them
--       trivially, and every row in the table today is in exactly that
--       state because the columns did not exist a moment earlier. No
--       constraint below references only pre-existing columns.
--   [ ] Tested on a copy of the data first? No — no staging copy of
--       Supabase exists in this project (the standing caveat every
--       migration in this repo carries). Mitigated by: all three columns
--       nullable with no default, so no existing row is rewritten; the
--       constraints being unsatisfiable-to-violate by any row that exists
--       today (previous check); and the field names coming from live
--       Aircall data reported in this build's brief rather than guessed
--       from documentation. Peter should still run it against a Supabase
--       branch/copy first if one is available.
-- ============================================================


-- ============================================================
-- THE CHANGE
-- ============================================================

ALTER TABLE call_stats_line_misses
  ADD COLUMN IF NOT EXISTS missed_calls_agents_did_not_answer INTEGER,
  ADD COLUMN IF NOT EXISTS missed_calls_by_reason             JSONB,
  ADD COLUMN IF NOT EXISTS voicemails_left                    INTEGER;


-- Guard 1: the attributable count is a real, in-range subset of this
-- row's own missed_calls. It cannot be negative and it cannot exceed the
-- total number of misses it is drawn from. Catches the single arithmetic
-- mistake that would inflate a named employee's charged misses above the
-- number of calls that were actually missed on their line.
-- Trivially satisfied by every existing row (the column is NULL there).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'call_stats_line_misses_agents_did_not_answer_in_range'
  ) THEN
    ALTER TABLE call_stats_line_misses
      ADD CONSTRAINT call_stats_line_misses_agents_did_not_answer_in_range
      CHECK (
        missed_calls_agents_did_not_answer IS NULL
        OR (missed_calls_agents_did_not_answer >= 0
            AND missed_calls_agents_did_not_answer <= missed_calls)
      );
  END IF;
END $$;


-- Guard 2: voicemails_left is a real, in-range subset of this row's own
-- total_calls. Bounded by total_calls rather than missed_calls
-- deliberately: this table holds answered user-less calls too (lib/sync.js
-- live verification found 3 inbound-answered and 25 outbound-answered in a
-- 573-call sample), and while an answered call leaving a voicemail is not
-- expected, the schema does not assert it is impossible on a guess.
-- Trivially satisfied by every existing row.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'call_stats_line_misses_voicemails_left_in_range'
  ) THEN
    ALTER TABLE call_stats_line_misses
      ADD CONSTRAINT call_stats_line_misses_voicemails_left_in_range
      CHECK (
        voicemails_left IS NULL
        OR (voicemails_left >= 0 AND voicemails_left <= total_calls)
      );
  END IF;
END $$;


-- Guard 3: the three columns are captured together or not at all, and the
-- map is a JSON OBJECT rather than an array, a string or a bare number.
--
-- This is the constraint that keeps "NULL means not captured" a single,
-- answerable question. Without it, a partially-written row (say a reason
-- map but no voicemail count) is indistinguishable from a row where the
-- sync genuinely saw zero voicemails, and every downstream "is this day
-- measured?" test has to check three columns and guess what a
-- disagreement means. There is no legitimate partial state: all three
-- values are derived from the same array of call objects in the same
-- loop, so if one is computable, all three are.
--
-- jsonb_typeof() is immutable and safe inside a CHECK. Note what is
-- deliberately NOT constrained: the map's KEYS. Aircall owns that
-- enumeration and may add to it; a key CHECK would turn a new Aircall
-- value into a crashed nightly sync, which is the opposite of what this
-- migration is for.
-- Trivially satisfied by every existing row (all three columns NULL).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'call_stats_line_misses_reason_capture_all_or_none'
  ) THEN
    ALTER TABLE call_stats_line_misses
      ADD CONSTRAINT call_stats_line_misses_reason_capture_all_or_none
      CHECK (
        (
          missed_calls_agents_did_not_answer IS NULL
          AND missed_calls_by_reason IS NULL
          AND voicemails_left IS NULL
        )
        OR (
          missed_calls_agents_did_not_answer IS NOT NULL
          AND missed_calls_by_reason IS NOT NULL
          AND voicemails_left IS NOT NULL
          AND jsonb_typeof(missed_calls_by_reason) = 'object'
        )
      );
  END IF;
END $$;


COMMENT ON COLUMN call_stats_line_misses.missed_calls_agents_did_not_answer IS
  'How many of this row''s missed_calls carried Aircall''s missed_call_reason = ''agents_did_not_answer'' — somebody was available and the phone rang out. THE ONLY MISS REASON THAT COUNTS AGAINST A PERSON, per Peter''s decision of 2026-09-10. On a row where sole_user_email is populated, THIS is the number that goes into that named employee''s Answer Rate denominator; missed_calls as a whole must NOT be used for that any more. The other observed reasons are deliberately not charged to anyone: ''no_available_agent'' means nobody was logged in (confirmed by Peter as Kristen manually switching to the phone tree for lunch, plus her 9am start — a schedule, not a performance failure) and ''short_abandoned'' means the caller hung up after a median of NINE seconds, which nobody could have answered. Real figures behind the rule, Kristen Rau''s two lines 2026-09-01..2026-09-10: 41 misses = 21 agents_did_not_answer + 16 no_available_agent + 4 short_abandoned; her rate is 53% counting all of them and 69% counting only this column. Denormalized on purpose from missed_calls_by_reason so the load-bearing figure has a real integer type and a real range CHECK instead of living inside an untyped blob where an absent key would SUM to a silent undercount. It MUST equal COALESCE(missed_calls_by_reason->>''agents_did_not_answer'', 0). NULL means THIS ROW WAS NEVER MEASURED — a sync run that did not look at missed_call_reason at all — and is the OPPOSITE convention to sole_user_email''s NULL; it must never be read as zero. Populated by Q''s sync change, not by the migration that created this column.';

COMMENT ON COLUMN call_stats_line_misses.missed_calls_by_reason IS
  'Complete Aircall missed_call_reason -> count map for this row''s missed calls, as a JSON object, e.g. {"agents_did_not_answer": 21, "no_available_agent": 16, "short_abandoned": 4}. Covers MISSED calls only (answered_at IS NULL); answered user-less calls, which this table also holds, never appear here. Its values MUST sum to missed_calls, which makes "did any miss go missing" a one-line check. A missed call for which Aircall reported no reason is counted under the literal key "(no reason reported)" — spaces and parentheses so it can never collide with an Aircall enum value, and so it reads plainly to a human browsing the Supabase table editor. NO CHECK CONSTRAINT ENUMERATES THE KEYS, deliberately and permanently: missed_call_reason is an open enumeration owned by Aircall, whose docs list values (abandoned_in_ivr and similar) that simply did not occur in the ten-day window this build was designed against. An unrecognized future value must land in this map on its own, unblocked and unlost — constraining the keys would convert Aircall shipping a new value into a crashed nightly sync, and a fixed set of per-reason columns would have dropped it silently. This is the future-proof half of the design; missed_calls_agents_did_not_answer is the typed, metric half. NULL means THIS ROW WAS NEVER MEASURED, never "no misses had reasons". Populated by Q''s sync change, not by the migration that created this column.';

COMMENT ON COLUMN call_stats_line_misses.voicemails_left IS
  'How many calls on this (line, day, direction) row left a voicemail — i.e. how many had a non-null `voicemail` field on Aircall''s call object. A COUNT ONLY: *** THE VOICEMAIL RECORDING URL IS NEVER STORED HERE OR ANYWHERE IN THIS SCHEMA. *** That is not an omission to fix later — a voicemail is call content, a tenant or owner''s own recorded voice, and SPEC.md''s "Explicitly Out of Scope" bars recordings, transcripts and call content of any kind from this tool absolutely. Captured with no metric built on it, on purpose: Peter has not decided whether "left a voicemail" becomes its own dashboard number, but the field is per-call, raw calls are never stored, and the nightly aggregate is all that survives the night — the same "destroyed if not captured now" test ring_user_count passed. Real data shows it carries information rather than tracking miss volume: across Kristen Rau''s two lines 2026-09-01..2026-09-10, 12 of 21 agents_did_not_answer misses left one, 6 of 16 no_available_agent, and 0 of 4 short_abandoned. Deliberately NOT split per reason — that cross-tab is real but nothing asks for it, and a nested structure would be exactly the ahead-of-need complexity this migration''s option analysis rejected; it is a small follow-on migration if Peter ever wants it. Bounded by total_calls rather than missed_calls because this table also holds answered user-less calls. NULL means THIS ROW WAS NEVER MEASURED, never zero. Populated by Q''s sync change, not by the migration that created this column.';

-- Re-set on the table so the database itself stays the single accurate
-- place to read this table's PII status. Carries 20260910010000's
-- 2026-09-10 correction forward unchanged in substance and appends this
-- migration's amendment — it does not restate 20260904000000's superseded
-- "pii_fields: NONE" claim as anything but superseded.
COMMENT ON TABLE call_stats_line_misses IS
  'One row per Aircall line, per calendar day (America/Los_Angeles business day), per call direction: counts of calls that arrived with no `user` at all on Aircall''s own record — the misses call_stats structurally cannot represent. Synced nightly, read-only. GRAIN AND UPSERT KEY: UNIQUE (aircall_number_id, call_date, direction), unchanged since creation and deliberately NOT widened when miss-reason capture was added on 2026-09-10 (migration 20260910020000) — reason and voicemail are ATTRIBUTES of this row, not new dimensions. DATA INVENTORY (GOVERNANCE.md Rule 4), CORRECTED 2026-09-10 by migration 20260910010000 and AMENDED the same day by 20260910020000 — this SUPERSEDES 20260904000000''s "pii_fields: NONE, by construction" entry, which was honest when written and stopped being true when sole_user_email was added: this table CONTAINS PII. sole_user_email is a direct identifier (a named Rincon employee''s real email), and on any row where it is populated the counts beside it are employee-performance data about that person — the same category call_stats carries. That now includes missed_calls_agents_did_not_answer, which is THE figure that lowers a named employee''s Answer Rate in a weekly staff meeting, alongside missed_calls_by_reason and voicemails_left. Rows where sole_user_email IS NULL name no one and contain no personal data at all. Deliberately never stored: the caller''s own phone number/raw_digits, and the voicemail recording URL — voicemails_left is a COUNT, because a recording is call content and out of scope by SPEC.md''s absolute terms. privacy_category: employee performance / call-activity metadata, not tenant or applicant data, not Fair Housing-relevant. ccpa_exportable TRUE; ccpa_deletable TRUE mechanically via redact-in-place (overwrite sole_user_email and the row is anonymous again; ring_user_count, the reason columns and voicemails_left all survive and name no one). Retention indefinite (Peter, 2026-08-20). RLS enabled, no permissive policies. No audit logging, by design.';


-- ============================================================
-- NOTES FOR Q — read before wiring the sync
-- ============================================================
--
-- 1. THE UPSERT KEY DID NOT CHANGE. Still
--    UNIQUE (aircall_number_id, call_date, direction). Keep upserting on
--    exactly that, keep bucketing on
--    `${aircallNumberId}|${callDate}|${direction}` in
--    buildLineMissAggregates(), and add the three new values to the
--    bucket object alongside total_calls/missed_calls. No on_conflict=
--    change, no new bucket dimension. If you find yourself wanting to
--    key on reason, re-read "THE GRAIN QUESTION" above first — the
--    NULLS DISTINCT duplicate-row failure is the specific reason it was
--    rejected, and it would not announce itself.
--
-- 2. NULL MEANS "NOT MEASURED" ON ALL THREE COLUMNS — the reverse of
--    sole_user_email. Never write NULL to mean zero, and never read NULL
--    as zero. In the rollup, an unmeasured row must be excluded from the
--    charged total AND reported as unmeasured, not summed as 0. Every row
--    written before your change lands is unmeasured, and cannot be fixed
--    by an UPDATE (see #7).
--
-- 3. ALL THREE, ALWAYS, TOGETHER. The all-or-none CHECK will reject a
--    partial write. That is intentional — there is no legitimate partial
--    state, since all three come off the same call array in the same
--    loop. If the loop runs at all, write all three; if you are writing a
--    row from a code path that has not looked at reasons, write all three
--    NULL.
--
-- 4. THE TWO INVARIANTS THE SCHEMA CANNOT ENFORCE, AND YOU MUST:
--      (a) SUM of missed_calls_by_reason's values == missed_calls.
--      (b) missed_calls_agents_did_not_answer ==
--          COALESCE(missed_calls_by_reason->>'agents_did_not_answer', 0).
--    (a) cannot be a CHECK without a non-immutable aggregate over JSONB;
--    (b) cannot be one without a text->int cast whose failure mode inside
--    a constraint is a confusing runtime error rather than a clean
--    violation. Both are cheap assertions in the aggregation function and
--    belong there. TARS should verify (a) against real rows after the
--    first live sync.
--
-- 5. A MISS WITH NO REASON GETS THE KEY "(no reason reported)". Do not
--    drop it, do not use a JSON null value, and do not invent a
--    plausible-looking Aircall value for it. Invariant (a) depends on
--    every miss being counted somewhere in the map.
--
-- 6. AN UNRECOGNIZED REASON IS DATA, NOT AN ERROR. Write it into the map
--    under whatever string Aircall sent, unmodified — do not normalize,
--    map, or bucket it into "other". Then LOG IT LOUDLY in the sync
--    summary, distinct and counted the same way
--    unresolved_sole_user_lines and lines_missing_from_mapping already
--    are, so a new Aircall value surfaces the next morning instead of
--    sitting quietly in a blob for a month. It must not crash the sync
--    and it must not be silently discarded. Only 'agents_did_not_answer'
--    ever charges a person; every other key — known or new — is visible
--    and charged to nobody until Peter decides otherwise.
--
-- 7. YOU CANNOT BACKFILL THESE FROM SUPABASE. The previous migration's
--    backfill was a plain UPDATE because ring membership is per-line.
--    These are per-CALL fields and no individual call is stored anywhere
--    in this schema, so history requires RE-FETCHING calls from Aircall
--    day by day. That is not authorized by this migration and is not in
--    this build's approved scope — if you think it is needed, it is a
--    question for Peter, not a script to write. Do not assume the shape
--    of last week's backfill carries over.
--
-- 8. NO EXTRA AIRCALL REQUESTS. Both fields — missed_call_reason and
--    voicemail — are already on the call objects the existing
--    GET /v1/calls fetch returns. Do not add a per-call detail fetch. If
--    a field appears absent, confirm against the raw JSON first; the
--    2026-09-04 live verification read call.number off these same objects
--    successfully.
--
-- 9. STORE A COUNT OF VOICEMAILS. NEVER THE URL. `voicemail` is a link to
--    a recording of a caller's voice. Counting is in scope; storing,
--    fetching, transcribing or displaying the recording is not, under
--    SPEC.md's "Explicitly Out of Scope", and this is the kind of line
--    that gets crossed by accident while debugging. No metric is built on
--    this column yet — capture only, per Peter.
--
-- 10. THE ROLLUP CHANGES SHAPE. The previous migration's NOTES FOR Q #4
--     defined a person's missed inbound calls as SUM(call_stats
--     .missed_calls) + SUM(call_stats_line_misses.missed_calls) for their
--     sole-user rows. THE SECOND TERM IS NOW
--     SUM(missed_calls_agents_did_not_answer), not SUM(missed_calls).
--     Answer Rate and the Missed column must BOTH read the new term or
--     the page contradicts itself — the exact failure
--     answer-rate-redefinition-SPEC.md exists to correct.
--
-- 11. NOTHING GOES MISSING, and there are now THREE buckets on the page,
--     not two: charged to a person (agents_did_not_answer on a sole-user
--     line), charged to nobody because of the reason (no_available_agent
--     and short_abandoned, on any line), and charged to nobody because of
--     the line (any reason, on a line that rang nobody or several). Those
--     three plus the unmeasured rows must add up to the total line misses
--     for the range. Tron needs that breakdown to label the section
--     honestly, and TARS should test the addition explicitly.
--
-- 12. DOCUMENT BOTH ?date= BEHAVIORS AT THE ROUTE. Re-running an old day
--     now fills in reason and voicemail correctly for that day (they come
--     off immutable historical call objects) WHILE ALSO re-stamping
--     today's line mapping onto that day's sole_user_email — the
--     history-rewrite hazard from the previous migration, unchanged. One
--     command, one good effect and one sharp one. Say both at the route.
--
-- ============================================================


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- ALTER TABLE call_stats_line_misses
--   DROP CONSTRAINT IF EXISTS call_stats_line_misses_agents_did_not_answer_in_range;
-- ALTER TABLE call_stats_line_misses
--   DROP CONSTRAINT IF EXISTS call_stats_line_misses_voicemails_left_in_range;
-- ALTER TABLE call_stats_line_misses
--   DROP CONSTRAINT IF EXISTS call_stats_line_misses_reason_capture_all_or_none;
-- ALTER TABLE call_stats_line_misses DROP COLUMN IF EXISTS missed_calls_agents_did_not_answer;
-- ALTER TABLE call_stats_line_misses DROP COLUMN IF EXISTS missed_calls_by_reason;
-- ALTER TABLE call_stats_line_misses DROP COLUMN IF EXISTS voicemails_left;
--
-- -- Then RESTORE the table comment set by 20260910010000. Do NOT set it
-- -- to NULL: that would delete the 2026-09-10 PII correction from the
-- -- database, leaving 20260904000000's superseded "pii_fields: NONE, by
-- -- construction" as the only inventory a reader finds. Paste this
-- -- statement as part of the rollback:
-- --
-- -- COMMENT ON TABLE call_stats_line_misses IS
-- --   'One row per Aircall line, per calendar day (America/Los_Angeles business day), per call direction: counts of calls that arrived with no `user` at all on Aircall''s own record — the misses call_stats structurally cannot represent. Synced nightly, read-only. DATA INVENTORY (GOVERNANCE.md Rule 4), CORRECTED 2026-09-10 by migration 20260910010000 — this SUPERSEDES 20260904000000''s "pii_fields: NONE, by construction" entry, which was honest when written and stopped being true when sole_user_email was added: this table now CONTAINS PII. sole_user_email is a direct identifier (a named Rincon employee''s real email), and on any row where it is populated the counts beside it are employee-performance data about that person — the same category call_stats carries. privacy_category: employee performance / call-activity metadata, not tenant or applicant data, not Fair Housing-relevant. ccpa_exportable TRUE; ccpa_deletable TRUE mechanically via redact-in-place (overwrite sole_user_email and the row is anonymous again; ring_user_count survives and names no one). Retention indefinite (Peter, 2026-08-20). RLS enabled, no permissive policies. No audit logging, by design. Rows where sole_user_email IS NULL contain no personal data at all.';
--
-- WARNING, and it is a different warning from the previous migration's:
-- dropping these columns destroys captured miss-reason and voicemail data
-- that CANNOT be rebuilt from anything in Supabase. Unlike sole_user_email
-- — which at least could be re-derived for recent days from Aircall's
-- current line mapping — these are per-call facts, and this schema stores
-- no individual call records. Rebuilding them means a full re-fetch of raw
-- calls from Aircall for every affected day, and only for as far back as
-- Aircall's own call history reaches. Export
-- (aircall_number_id, call_date, direction,
--  missed_calls_agents_did_not_answer, missed_calls_by_reason,
--  voicemails_left) before rolling back if any real sync has run.
--
-- Note: the table, its index, its trigger, set_updated_at(), and the
-- sole_user_email/ring_user_count columns and their constraint are NOT
-- dropped here — this migration did not create any of them.
--
-- ============================================================
