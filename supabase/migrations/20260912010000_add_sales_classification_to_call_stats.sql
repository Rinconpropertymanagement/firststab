-- ============================================================
-- Migration: 20260912010000_add_sales_classification_to_call_stats
-- Created:   2026-09-12
-- Author:    Q (builder), following Neo's column shape in
--            projects/hub/call-stats/SALES-VS-OPERATIONAL-CLASSIFICATION-SPEC.md
--            Design Decision 21.
--
-- Extended:  2026-09-12, same day, follow-on task approved by Peter — see
--            PART 2 below, which adds the identical four columns to
--            call_stats_hubspot_native_calls (Kristen Rau's third phone
--            number, a completely separate call-tracking pipeline this
--            migration originally did not touch).
--
-- *** NOT APPLIED. Peter applies every migration by hand through
-- Supabase's SQL Editor. Nothing in this repo runs it. ***
--
-- What this is for: three of Peter's eleven hand-kept scorecard metrics —
-- "number of operational calls," "number of outbound sales calls," and
-- "conversations from outbound sales calls." Today somebody counts those
-- by remembering who they talked to. These columns count them.
--
-- ADDITIVE ONLY. Four nullable columns on an existing table plus two CHECK
-- constraints (PART 1, call_stats) — and, as of the extension above, the
-- identical shape on a second, unrelated table (PART 2,
-- call_stats_hubspot_native_calls). No grain change on either table, no
-- UNIQUE change, no backfill, no other table touched. The nightly sync's
-- upsert paths (call_stats: onConflict aircall_user_id,call_date,direction;
-- call_stats_hubspot_native_calls: onConflict phone_number,call_date,
-- direction) are both unchanged.
--
-- ============================================================
-- HOW A CALL IS CLASSIFIED (Design Decision 17)
-- ============================================================
-- The other party's phone number is matched against HubSpot contacts. The
-- call is SALES only if at least one matching contact carries evidence a
-- HUMAN at Rincon treated that number as a prospect — a lifecycle stage on
-- the configured prospect allowlist, or an associated deal. A contact's
-- mere EXISTENCE qualifies for nothing.
--
-- That narrowness is the whole design, and it exists because of one fact
-- about this portal: since 2026-06-02 the Aircall integration has
-- auto-created a HubSpot contact for essentially every number that rings
-- Rincon — ~1,275 of them, ~93% of all contacts created in that window,
-- most blank or named "Aircall new contact." So "this caller is in
-- HubSpot" is true of every tenant and every vendor and means nothing. The
-- rule reads only signals the integration does not set.
--
-- VERIFIED 2026-09-12 against the live portal: of 483 contacts still named
-- "Aircall new contact," ZERO sit at a prospect lifecycle stage, and zero
-- prospect-stage contacts carry the auto-generated name pattern. The
-- premise holds.
--
-- ============================================================
-- *** THE COMPLIANCE BOUNDARY THIS TABLE NOW SITS ON ***
-- (the one genuinely new sentence this header must carry, per the spec's
-- GOVERNANCE.md Rule 4 amendment)
-- ============================================================
-- The four columns below are COMPUTED FROM records about people OUTSIDE
-- Rincon — prospects in HubSpot — that this schema DELIBERATELY DOES NOT
-- RETAIN. The counterparty's phone number, name, and HubSpot contact ID
-- exist only in memory during the nightly sync and are discarded the
-- moment a counter is incremented. Only integers are stored.
--
-- ADDING A COLUMN TO RETAIN ANY OF THEM — a matched_contact_id "just for
-- debugging," a matched phone number, a prospect name — CHANGES THIS
-- TABLE'S COMPLIANCE STATUS. It would move this build across CLAUDE.md's
-- "stores someone's personal information" line and require Asimov's
-- review before it ships. The troubleshooting need that change would serve
-- is already met by
-- projects/hub/call-stats/diagnose-sales-classification.js, which prints
-- to an operator's terminal and persists nothing.
--
-- This is a property of the code, not a policy, which is exactly why it is
-- written here where the next person to open this migration will read it.
--
-- ============================================================
-- DATA INVENTORY AMENDMENT (GOVERNANCE.md Rule 4)
-- ============================================================
-- Amends 20260819010000_call_stats.sql's inventory. Everything not listed
-- here is UNCHANGED.
--   pii_fields:        GAINS NOTHING. No new direct identifier and no new
--                      indirect identifier. The four columns are counts of
--                      a named Rincon EMPLOYEE's own calls — facts about
--                      that employee's day, not about any prospect.
--   privacy_category:  UNCHANGED — employee call-activity / performance
--                      metadata. Not tenant data, not applicant data. The
--                      prospects behind these counts are prospective
--                      property-management clients (property OWNERS), not
--                      rental applicants and not tenants, so the Fair
--                      Housing Standard's subject matter is not engaged.
--   retention_policy / ccpa_exportable / ccpa_deletable / RLS posture /
--   audit-logging posture: ALL UNCHANGED.
--
-- Governance path: Asimov — a scoped pre-check is recommended before this
-- ships, per the spec's own reasoning: this is the first Call Stats build
-- to read records about people outside Rincon, and the durable question
-- worth registering is "is the no-outside-person-data property real, and
-- what keeps it real." Mason — not required for this migration as scoped
-- (no housing decision, no applicant, no tenant, nothing tenant-facing),
-- BUT SEE THE LEASING LINE TRIPWIRE below. Sentinel — not required: no new
-- credential, no new .env entry, no new external surface; the existing
-- HUBSPOT_PRIVATE_APP_TOKEN under the already-granted
-- crm.objects.contacts.read scope. Rule 6: Standard tier, a metric
-- definition; Peter's approval on 2026-09-12 satisfies it.
--
-- *** THE LEASING LINE TRIPWIRE — READ BEFORE EXTENDING THIS. ***
-- call_stats_line_misses is NOT touched by this migration, deliberately.
-- Those are inbound calls Aircall attributed to no individual, including
-- everything on the Leasing Line and the Maintenance Hotline. A prospect
-- who rang the Leasing Line and got nobody is a MISSED SALES CALL, and it
-- is arguably the most commercially interesting number in this whole tool
-- — and it is not counted here. That is a decision, not an oversight, and
-- it is not only a cost argument: Leasing Line callers are PROSPECTIVE
-- TENANTS, so attaching a derived CRM-sourced label to them is a Fair
-- Housing question with a different answer. MASON REVIEWS THAT BEFORE IT
-- IS EVER BUILT. The "no Mason needed" conclusion above does not cover it.
--
-- ============================================================
-- WHY COLUMNS AND NOT A TABLE (Design Decision 21)
-- ============================================================
-- Two alternatives were weighed and rejected:
--   - Widening call_stats's grain to (user, date, direction,
--     classification): changes the UNIQUE constraint and the upsert path,
--     and needs a full Aircall re-sync to backfill — which Design Decision
--     22 says cannot be done honestly anyway.
--   - A sibling call_stats_classification table: reproduces the
--     person/day/direction key in a second place, needs a join on every
--     read, and — decisively — lets the two tables disagree with nothing
--     detecting it.
-- The existing grain is already right: "how many of this person's outbound
-- calls yesterday were sales" is an attribute of a row that already
-- exists, not a new dimension.
--
-- ============================================================
-- *** NULL IS NOT ZERO, AND THE CHECK IS WHY THIS SHAPE WAS CHOSEN ***
-- ============================================================
-- All four columns are NULL together (never classified — every row before
-- the changeover date, and any night the HubSpot lookup failed), or all
-- four are populated and the first three sum EXACTLY to total_calls.
--
-- That constraint is the reason columns beat a sibling table. THE DATABASE
-- ITSELF REFUSES TO STORE A DAY IN WHICH A CALL WENT UNCOUNTED. A
-- phone-normalization bug that starts dropping numbers cannot produce a
-- plausible-looking row — it produces a rejected write and a loud failure.
-- Given that the failure mode this entire design guards against is a
-- number that is quietly wrong, a schema that cannot represent a
-- quietly-wrong number is worth the constraint's small cost.
--
-- A failed lookup writes NULL, never zeros, and never sweeps unclassified
-- calls into unmatched_calls. A stored value meaning "we could not find
-- out" that looks identical to "we looked and found nothing" is a
-- permanent, silent, self-concealing error — the same principle
-- sole_user_email already follows on call_stats_line_misses.
--
-- ============================================================
-- NO BACKFILL, AND THAT IS DELIBERATE (Design Decision 22)
-- ============================================================
-- Existing rows keep all four columns NULL. Classification is SNAPSHOTTED
-- on the night it is computed and never recomputed.
--
-- The reason is not tidiness. If classification were recomputed from
-- today's HubSpot, a prospect who signs in October would stop being a
-- prospect, and the September calls made to them would stop counting as
-- sales calls — months later, because of an unrelated CRM update, with
-- nothing recording that the number moved. SUCCESS IN SALES WOULD
-- SYSTEMATICALLY ERASE THE RECORD OF THE SALES WORK THAT PRODUCED IT.
-- Every prospect who converts would subtract from the historical count,
-- and the metric would degrade in exact proportion to how well the team
-- performed. That is not a rounding error; it is a metric that punishes
-- the outcome it exists to measure.
--
-- Backfilling the past would mean applying today's HubSpot to calls made
-- weeks ago — the same rewrite, done deliberately. The metric starts fresh
-- from the first night this runs, and the dashboard says so.
--
-- CONSEQUENCE, recorded rather than left as a surprise: re-running an old
-- day through POST /api/call-stats/internal/sync?date= re-reads TODAY's
-- HubSpot and re-stamps that day's classification. That is a second sharp
-- edge on the same command that already re-stamps line ring membership —
-- both are documented at the route in router.js.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- PART 1: call_stats (the original scope of this migration)
-- ============================================================

ALTER TABLE call_stats
  -- The other party's number matched at least one HubSpot contact carrying
  -- human-applied prospect evidence (a prospect lifecycle stage, or an
  -- associated deal). A POSITIVE finding — this is the only one of the
  -- three the tool has actual evidence for.
  ADD COLUMN IF NOT EXISTS sales_calls INTEGER NULL CHECK (sales_calls >= 0),

  -- Looked up, and nothing qualifying came back. Also counts calls to and
  -- from Rincon's OWN 15 line numbers, which are excluded from lookup
  -- entirely (see below) and are positively known not to be prospects.
  --
  -- *** THIS COLUMN IS NOT CALLED "operational_calls" AND MUST NOT BE
  -- RENAMED TO IT. *** Peter will read it as his operational-call count,
  -- and Design Decision 24 is explicit that the label stays honest: this
  -- bucket contains at least three different things — genuine tenant and
  -- vendor calls, PROSPECTS NOBODY ADVANCED IN HUBSPOT, and personal or
  -- wrong-number calls. Calling it "operational" would assert a fact about
  -- all three. The tool has positive evidence for sales only; sales is a
  -- FLOOR, not a total.
  ADD COLUMN IF NOT EXISTS unmatched_calls INTEGER NULL CHECK (unmatched_calls >= 0),

  -- No usable number, or the number could not be looked up: withheld
  -- caller ID, a non-NANP international number, malformed digits. NEVER
  -- folded into either column above. Kept visible on the dashboard even
  -- when it reads zero, so the day it stops reading zero — a normalization
  -- regression, a HubSpot outage, a run of withheld caller IDs — is
  -- visible on the page rather than only in a log nobody opens.
  ADD COLUMN IF NOT EXISTS unknown_calls INTEGER NULL CHECK (unknown_calls >= 0),

  -- Scorecard metric 3: "conversations from outbound sales calls." A
  -- SUBSET of sales_calls, not a fourth bucket — it is deliberately NOT in
  -- the sum-to-total CHECK below, and its own CHECK enforces the subset
  -- relationship instead.
  --
  -- Definition: an OUTBOUND call to a prospect-matched number that
  -- CONNECTED (Aircall answered_at is set) and whose talk time
  -- (ended_at - answered_at, never Aircall's own unreliable `duration`
  -- field) reached CONVERSATION_MIN_TALK_SECONDS in
  -- lib/sales-classification-config.js. Inbound prospect calls are
  -- excluded because the scorecard line says OUTBOUND.
  --
  -- The threshold is a judgment, not a measurement, and the config module
  -- carries the argument for the value chosen along with a dated change
  -- log — changing it creates a definitional boundary in the data exactly
  -- like a stage-list change, because these values are snapshotted too.
  ADD COLUMN IF NOT EXISTS sales_conversations INTEGER NULL CHECK (sales_conversations >= 0);


-- All four NULL together, or all four populated AND the three buckets sum
-- exactly to total_calls. See "NULL IS NOT ZERO" above — this constraint
-- is the reason this shape was chosen over a sibling table.
--
-- Written as a NOT VALID add followed by a VALIDATE so that applying this
-- to the live table does not take a long ACCESS EXCLUSIVE lock while it
-- scans 1,845 existing rows. Those rows all have NULLs and satisfy the
-- constraint trivially, but NOT VALID / VALIDATE is the safe habit on a
-- live table and costs nothing here.
ALTER TABLE call_stats
  DROP CONSTRAINT IF EXISTS call_stats_classification_balanced;
ALTER TABLE call_stats
  ADD CONSTRAINT call_stats_classification_balanced CHECK (
    (sales_calls IS NULL AND unmatched_calls IS NULL AND unknown_calls IS NULL AND sales_conversations IS NULL)
    OR
    (sales_calls IS NOT NULL AND unmatched_calls IS NOT NULL AND unknown_calls IS NOT NULL AND sales_conversations IS NOT NULL
     AND sales_calls + unmatched_calls + unknown_calls = total_calls)
  ) NOT VALID;
ALTER TABLE call_stats VALIDATE CONSTRAINT call_stats_classification_balanced;

-- A "conversation" is a sales call that went past the duration threshold,
-- so it can never exceed the sales count. Separate from the balance
-- constraint above because it expresses a subset relationship, not a
-- partition — keeping them apart means a violation names which rule broke.
ALTER TABLE call_stats
  DROP CONSTRAINT IF EXISTS call_stats_conversations_within_sales;
ALTER TABLE call_stats
  ADD CONSTRAINT call_stats_conversations_within_sales CHECK (
    sales_conversations IS NULL OR sales_calls IS NULL OR sales_conversations <= sales_calls
  ) NOT VALID;
ALTER TABLE call_stats VALIDATE CONSTRAINT call_stats_conversations_within_sales;


COMMENT ON COLUMN call_stats.sales_calls IS
  'Calls whose other party matched a HubSpot contact carrying human-applied prospect evidence (prospect lifecycle stage, or an associated deal). A floor, not a total: a real prospect nobody advanced in HubSpot is counted in unmatched_calls. Snapshotted at sync time, never recomputed. NULL = never classified.';
COMMENT ON COLUMN call_stats.unmatched_calls IS
  'Looked up, nothing qualifying returned; plus calls to/from Rincon''s own 15 lines. NOT "operational" — also contains prospects nobody advanced in HubSpot. Do not rename this column to operational_calls.';
COMMENT ON COLUMN call_stats.unknown_calls IS
  'No usable number or no lookup possible (withheld caller ID, international, malformed). Never folded into sales_calls or unmatched_calls. NULL = never classified, 0 = classified and none were unknown.';
COMMENT ON COLUMN call_stats.sales_conversations IS
  'Subset of sales_calls: outbound, connected, and talk time at or above the threshold in lib/sales-classification-config.js. Scorecard metric "conversations from outbound sales calls".';


-- ============================================================
-- PART 2: THE SAME COLUMNS, ON call_stats_hubspot_native_calls
-- ============================================================
-- Added 2026-09-12, same session, extending the classification above to
-- Kristen Rau's THIRD phone number — 805-410-1625, tracked as
-- +18054101625 in call_stats_hubspot_native_numbers, a completely
-- separate call-tracking pipeline (HubSpot's own built-in calling;
-- migration 20260908000000_call_stats_hubspot_native.sql) that Part 1
-- above never touched. Confirmed live 2026-09-12: 5 rows in
-- call_stats_hubspot_native_calls, 11 total calls ever recorded on this
-- number. Small volume, but real, and it is specifically Kristen's
-- prospecting-adjacent line — a classification gap there would be the
-- wrong place to have one.
--
-- *** WHY THIS IS PART 2 OF THE SAME FILE, NOT A SEPARATE MIGRATION. ***
-- Both parts are additive ALTER TABLEs on tables that have nothing
-- structurally to do with each other (call_stats vs.
-- call_stats_hubspot_native_calls) — different columns, different CHECK
-- constraint names, different UNIQUE keys. There is no possible collision
-- between them. Both were, as of this writing, still unapplied; Peter
-- pastes migrations into Supabase's SQL Editor by hand, and one file
-- covering one feature (this classification build, now extended to its
-- second phone system) is less for him to track and apply than two files
-- he would otherwise have to remember to run together to get one complete
-- feature. The one thing worth naming rather than assuming: pasting this
-- whole file runs both parts as one script. Every ADD COLUMN below is
-- IF NOT EXISTS and every constraint DROP is IF EXISTS — the same
-- guard style Part 1 and every other migration in this schema already
-- use — so re-running the whole file after Part 1 has already been applied
-- is safe: Part 1's statements become no-ops and Part 2 applies cleanly on
-- top.
--
-- The rule is IDENTICAL to Part 1's — not a second implementation that can
-- drift from the first. Same config module
-- (lib/sales-classification-config.js), same lib/phone-key.js
-- normalization, same lib/hubspot-connector.js lookup functions
-- (listQualifyingPhoneKeys / searchContactsByPhoneKeys / contactQualifies),
-- all reused unchanged. The classification decision for a given outside
-- phone number is the same whether that number called in via Aircall or
-- via HubSpot's own native line.
--
-- *** THE ONE REAL DIFFERENCE: WHAT COUNTS AS "THE OTHER PARTY." *** This
-- table's grain is (phone_number, call_date, direction) — per TRACKED
-- NUMBER, not per staff member (see the parent migration's own header,
-- "grain philosophy"). HubSpot's native CALL object gives one
-- hs_call_from_number and one hs_call_to_number per call, not an
-- Aircall-style raw_digits field naming "the other party" directly. The
-- outside number for a call attributed to tracked number T is WHICHEVER of
-- hs_call_from_number / hs_call_to_number is NOT T. Implemented in
-- lib/sync.js's buildHubspotDailyAggregates() and
-- collectHubspotNativeOutsideNumberKeys() — getting this backwards would
-- classify every call by Kristen's own number, the same class of bug the
-- parent migration's raw_digits warning exists to prevent on the Aircall
-- side.
--
-- staff_email for these counters is NOT stored on this table directly — it
-- is resolved the same way this table already resolves it for every other
-- column: joined from call_stats_hubspot_native_numbers.staff_email at
-- read time, keyed on phone_number. No new join, no new column for it.
--
-- CONVERSATION THRESHOLD: reused, not re-derived. Only 11 historical calls
-- exist on this number as of 2026-09-12 — far too small a sample to
-- justify its own cutoff, and the 60-second CONVERSATION_MIN_TALK_SECONDS
-- in lib/sales-classification-config.js was itself derived from 8,925 real
-- Aircall calls. Applying that same figure here, explicitly on that basis,
-- rather than fitting a new number to 11 rows. Talk time for this table is
-- durationSeconds (from hs_call_duration), the same figure
-- total_talk_seconds is already built from — this table's own migration
-- header (LIVE VERIFICATION #2) already flags that HubSpot's native CALL
-- object does not expose the separate timestamps that would let talk time
-- be derived independently the way Aircall's does.
--
-- ============================================================
-- DATA INVENTORY AMENDMENT (GOVERNANCE.md Rule 4) — for THIS table
-- ============================================================
-- Amends 20260908000000_call_stats_hubspot_native.sql's inventory for
-- call_stats_hubspot_native_calls specifically. Everything not listed here
-- is UNCHANGED. Restated for this table rather than only cross-referenced
-- Part 1's amendment above, since a future reader may open this migration
-- looking specifically for this table's entry:
--   pii_fields:        GAINS NOTHING. No new direct or indirect
--                      identifier. The four columns are counts of calls on
--                      a named Rincon EMPLOYEE's tracked line — a fact
--                      about that employee's day, not about any prospect.
--   privacy_category:  UNCHANGED — employee call-activity / performance
--                      metadata.
--   retention_policy / ccpa_exportable / ccpa_deletable / RLS posture /
--   audit-logging posture: ALL UNCHANGED.
--
-- *** THE SAME COMPLIANCE BOUNDARY AS PART 1, RESTATED FOR THIS TABLE. ***
-- These four columns are COMPUTED FROM records about people OUTSIDE Rincon
-- that this schema deliberately does not retain. The counterparty's phone
-- number, name, and HubSpot contact ID exist only in memory during the
-- nightly sync and are discarded the moment a counter is incremented.
-- ADDING A COLUMN TO RETAIN ANY OF THEM changes THIS table's compliance
-- status too and requires Asimov's review before it ships — same rule,
-- same reason, same file it must be read from regardless of which table's
-- migration a future editor happens to have open.
--
-- Governance path: same conclusion as Part 1, extended rather than
-- re-derived — this is the same durable question Asimov's scoped pre-check
-- already covers ("is the no-outside-person-data property real, and what
-- keeps it real"), and this table is now a second place that property must
-- hold. Mason / Sentinel: not required, same reasoning as Part 1 (no
-- housing decision, no applicant, no tenant, no new credential). Rule 6:
-- Standard tier; Peter's 2026-09-12 approval of this extension satisfies
-- it.
-- ============================================================


ALTER TABLE call_stats_hubspot_native_calls
  -- Same meaning as call_stats.sales_calls, computed against the OTHER
  -- side of the call (see header above) rather than raw_digits.
  ADD COLUMN IF NOT EXISTS sales_calls INTEGER NULL CHECK (sales_calls >= 0),

  -- Same meaning as call_stats.unmatched_calls, including internal calls
  -- to/from any of Rincon's own numbers — Aircall lines AND every other
  -- row in call_stats_hubspot_native_numbers, since a call between two of
  -- Rincon's own HubSpot-native lines is exactly as "not a prospect" as a
  -- call to Rincon's own Aircall line.
  --
  -- *** NOT NAMED "operational_calls" — SAME REASON AS call_stats, DO NOT
  -- RENAME IT. *** This bucket contains genuine tenant/vendor calls,
  -- prospects nobody advanced in HubSpot, and internal Rincon-to-Rincon
  -- calls. The tool has positive evidence for sales only.
  ADD COLUMN IF NOT EXISTS unmatched_calls INTEGER NULL CHECK (unmatched_calls >= 0),

  -- Same meaning as call_stats.unknown_calls: no usable outside number, or
  -- the lookup could not be performed. Never folded into either column
  -- above.
  ADD COLUMN IF NOT EXISTS unknown_calls INTEGER NULL CHECK (unknown_calls >= 0),

  -- Same meaning as call_stats.sales_conversations: a SUBSET of
  -- sales_calls (outbound, connected/COMPLETED, talk time at or above
  -- CONVERSATION_MIN_TALK_SECONDS), not a fourth bucket — deliberately NOT
  -- in the sum-to-total CHECK below, same as Part 1.
  ADD COLUMN IF NOT EXISTS sales_conversations INTEGER NULL CHECK (sales_conversations >= 0);


-- All four NULL together, or all four populated AND the three buckets sum
-- exactly to total_calls — the identical shape as Part 1's
-- call_stats_classification_balanced, on this table's own total_calls.
-- Written NOT VALID / VALIDATE for the same reason Part 1 is: safe on a
-- live table without a long lock, even though this table's row count today
-- (5) makes the lock duration a non-issue either way.
ALTER TABLE call_stats_hubspot_native_calls
  DROP CONSTRAINT IF EXISTS call_stats_hubspot_native_calls_classification_balanced;
ALTER TABLE call_stats_hubspot_native_calls
  ADD CONSTRAINT call_stats_hubspot_native_calls_classification_balanced CHECK (
    (sales_calls IS NULL AND unmatched_calls IS NULL AND unknown_calls IS NULL AND sales_conversations IS NULL)
    OR
    (sales_calls IS NOT NULL AND unmatched_calls IS NOT NULL AND unknown_calls IS NOT NULL AND sales_conversations IS NOT NULL
     AND sales_calls + unmatched_calls + unknown_calls = total_calls)
  ) NOT VALID;
ALTER TABLE call_stats_hubspot_native_calls
  VALIDATE CONSTRAINT call_stats_hubspot_native_calls_classification_balanced;

-- A "conversation" can never exceed the sales count on this table either.
-- Kept as its own constraint, same reason Part 1 splits it out: a
-- violation names which rule broke.
ALTER TABLE call_stats_hubspot_native_calls
  DROP CONSTRAINT IF EXISTS call_stats_hubspot_native_calls_conversations_within_sales;
ALTER TABLE call_stats_hubspot_native_calls
  ADD CONSTRAINT call_stats_hubspot_native_calls_conversations_within_sales CHECK (
    sales_conversations IS NULL OR sales_calls IS NULL OR sales_conversations <= sales_calls
  ) NOT VALID;
ALTER TABLE call_stats_hubspot_native_calls
  VALIDATE CONSTRAINT call_stats_hubspot_native_calls_conversations_within_sales;


COMMENT ON COLUMN call_stats_hubspot_native_calls.sales_calls IS
  'Calls whose other party (whichever of hs_call_from_number/hs_call_to_number is not this row''s tracked phone_number) matched a HubSpot contact carrying human-applied prospect evidence. Same rule as call_stats.sales_calls — see lib/sales-classification-config.js. A floor, not a total. Snapshotted at sync time, never recomputed. NULL = never classified.';
COMMENT ON COLUMN call_stats_hubspot_native_calls.unmatched_calls IS
  'Looked up, nothing qualifying returned; plus calls to/from Rincon''s own numbers (Aircall lines or another HubSpot-native tracked number). NOT "operational" — see call_stats.unmatched_calls for why. Do not rename this column to operational_calls.';
COMMENT ON COLUMN call_stats_hubspot_native_calls.unknown_calls IS
  'No usable outside number or no lookup possible. Never folded into sales_calls or unmatched_calls. NULL = never classified, 0 = classified and none were unknown.';
COMMENT ON COLUMN call_stats_hubspot_native_calls.sales_conversations IS
  'Subset of sales_calls: outbound, COMPLETED, and talk time (from hs_call_duration) at or above CONVERSATION_MIN_TALK_SECONDS in lib/sales-classification-config.js — the same 60s threshold derived from Aircall data and reused here, not re-derived, because only 11 historical calls exist on this number.';


-- ============================================================
-- MIGRATION GATE (run before this applies to any real database)
-- ============================================================
--   [x] Rollback exists — see DROP section below (both parts)
--   [x] Breaks no existing data — eight nullable ADD COLUMNs total across
--       two tables; every existing row on both tables gets NULL, which
--       both balance constraints permit
--   [x] Touches no other table; in particular does NOT touch
--       call_stats_line_misses, so it cannot collide with the miss-reason
--       migration (20260910020000) which does
--   [x] PART 1: UNIQUE (aircall_user_id, call_date, direction) on
--       call_stats unchanged, so the nightly sync's upsert path is
--       unchanged
--   [x] PART 2: UNIQUE (phone_number, call_date, direction) on
--       call_stats_hubspot_native_calls unchanged, so ITS nightly sync's
--       upsert path is unchanged too
--   [x] RLS posture unchanged on both tables — no new policy, both stay
--       locked
--   [ ] Asimov's scoped pre-check — RECOMMENDED BEFORE THIS SHIPS, covering
--       BOTH parts. Not a review of the feature; one durable question, per
--       the spec: is the "no outside-person data is stored" property real,
--       and what keeps it real, now on two tables?
-- ============================================================


-- ============================================================
-- ROLLBACK
-- ============================================================
-- Removing the columns removes the constraints with them, but the DROPs
-- are listed explicitly so a partial rollback is possible. Part 2 can be
-- rolled back independently of Part 1 (different table, no dependency
-- either direction) — listed in reverse order (Part 2 first) purely so
-- this section mirrors the order the ALTERs above were applied in.
--
-- ALTER TABLE call_stats_hubspot_native_calls DROP CONSTRAINT IF EXISTS call_stats_hubspot_native_calls_conversations_within_sales;
-- ALTER TABLE call_stats_hubspot_native_calls DROP CONSTRAINT IF EXISTS call_stats_hubspot_native_calls_classification_balanced;
-- ALTER TABLE call_stats_hubspot_native_calls DROP COLUMN IF EXISTS sales_conversations;
-- ALTER TABLE call_stats_hubspot_native_calls DROP COLUMN IF EXISTS unknown_calls;
-- ALTER TABLE call_stats_hubspot_native_calls DROP COLUMN IF EXISTS unmatched_calls;
-- ALTER TABLE call_stats_hubspot_native_calls DROP COLUMN IF EXISTS sales_calls;
--
-- ALTER TABLE call_stats DROP CONSTRAINT IF EXISTS call_stats_conversations_within_sales;
-- ALTER TABLE call_stats DROP CONSTRAINT IF EXISTS call_stats_classification_balanced;
-- ALTER TABLE call_stats DROP COLUMN IF EXISTS sales_conversations;
-- ALTER TABLE call_stats DROP COLUMN IF EXISTS unknown_calls;
-- ALTER TABLE call_stats DROP COLUMN IF EXISTS unmatched_calls;
-- ALTER TABLE call_stats DROP COLUMN IF EXISTS sales_calls;
-- ============================================================
