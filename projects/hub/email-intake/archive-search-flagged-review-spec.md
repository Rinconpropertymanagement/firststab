# Archive Search — Flagged-Conversation Review & Reinstatement Spec

**Status:** Asimov and Mason reviewed the original draft and found it nearly ready, with two required additions: a revocation path (Mason) and a GOVERNANCE.md Rule 4 data-inventory section (Asimov), both quoted in full where they're addressed below. Neo has now built both into the migration (`supabase/migrations/20260912010000_archive_search_flagged_overrides_schema.sql`, not yet applied) and into this document (Section 3's updated schema, the new "Data Inventory" section, Open Item 6). **Still awaiting Peter's approval to apply the migration, and Asimov's and Mason's confirmation that this concrete build actually satisfies their findings** — Neo does not approve its own migrations. Nothing in this document authorizes applying anything.
**Written by:** Oracle. Revocation-path and Rule 4 additions: Neo.
**Date:** 2026-09-12
**Origin:** A confirmed, real gap in the already-built Archive Search design, found by reading the live schema and code directly, not inferred: once a conversation is screened `screening_result = 'flagged_protected_class'`, there is no path — anywhere in the schema, the code, or either prior spec — for a human to review it and restore it to search if it turns out to be a false positive. `missive_message_intake_held_review_safe` gives Peter/DO/counsel a read-only export of the **held** bucket (privileged/legal-hold correspondence), but that mechanism is explicitly about closing a legal-hold loop by hand outside the system (Mason's Condition 4) — it has no equivalent for the **flagged** bucket, and was never meant to. Peter asked for this reinstatement path to be built as new scope. This document is that spec.

**This is a direct extension of the already-approved Archive Search project, not a new tool.** It reuses that project's schema, roles, routes, and audit conventions wherever they already fit, and departs from them only where the task genuinely requires something new (Section 3). Every citation below to "the original spec" means `archive-search-technical-spec.md`; every citation to "the migration" means `20260910030000_archive_search_schema.sql`.

**Built from, read in full:**
- `projects/hub/email-intake/archive-search-technical-spec.md` — the full existing design this spec extends: `screening_result`'s value set, `missive_message_intake_search_safe`'s definition, the `missive_message_intake_held_review_safe` held-bucket-export pattern this spec's own flagged-bucket view is modeled on, the `archive_search` role model, and every open item already on record.
- `projects/hub/email-intake/archive-search-v1-scope.md` — the product-level design and access model (`'admin'` vs `'searcher'`, the 8-person population, Caylee's named exception) this spec inherits without re-litigating.
- `compliance/archive-search-ai-risk-assessment.md` — the risk framing for the underlying screening pass this mechanism now gives a release valve for.
- `supabase/migrations/20260910030000_archive_search_schema.sql` (full) — the real, live schema: `screening_result`/`screening_category`/`screening_tags`/`screening_version`/`screening_completed_at`, the `missive_message_intake_screening_result_check` and `_screening_category_required` constraints, both existing views' exact definitions, and the required-CI-guardrail note this spec must extend.
- `projects/hub/archive-search/lib/screening-pass.js` (full) — confirmed directly, not assumed: `markConversationScreened()` writes `screening_result`/`screening_category`/`screening_version`/`screening_completed_at` identically across **every** message row in a conversation in one `UPDATE ... WHERE missive_conversation_id = ...` call, and a conversation that receives new mail after being fully screened is re-screened **in full** (old and new messages together) the next time the driver query picks up its now-`NULL` new row — the mechanic this spec's own "stale override" design (Section 3) depends on.
- `projects/hub/archive-search/router.js` (full) — `requireArchiveSearchAdmin`, `attachArchiveSearchRole`, `writeAuditLog()`'s real call shape, `missiveConversationLink()`, the `held-review-export` route's exact join-audit_log-in-app-code pattern this spec's own export route reuses, and the `validation-sample-export` route's precedent for exposing `body_text` in bulk to an admin reviewer for accuracy-judging purposes.
- `supabase/migrations/20260815000000_audit_log_rule1_compliance.sql` (full) — `audit_log`'s real, current CHECK constraints (`actor_type IN ('human','ai_agent','system')`, `privacy_category IN ('collection','processing','dissemination','invasion','unclassified')`, `risk_level IN ('unclassified','low','medium','high','critical')`) — every value this spec's new events use is confirmed legal against these, not assumed.
- `supabase/migrations/20260910000000_complaint_tracking_schema.sql` — `complaints.flagged_protected_class`'s real column comment ("advisory tag only, never a hold") — the precedent this spec relies on for confirming an override here does not touch the retention clock.
- `projects/hub/maintenance-history/content-screening-tier-redesign-SPEC.md`, Sections 5–6, and `compliance/content-screening-management-risk-memo.md`, Section 5 — **the one existing precedent in this codebase for exactly this shape of problem**: a two-way human override (`clear_flag` / `flag`) of an AI Fair-Housing content-check disposition, on `maintenance_claims`, already reviewed by Mason and outside counsel and already live. This spec's own override design (required written reason, `reviewer_notes`-style guidance not to quote flagged text into that reason, a dedicated audit action distinct from routine review actions, gating to the tool's own privacy/admin role) follows this precedent directly wherever it applies — cited by name throughout, not reinvented.
- `GOVERNANCE.md`, Rule 6–9, the Fair Housing Standard (Rule 7, "a person decides and owns the decision"), and Rule 8's Tier 3 ("Agent escalates entirely... Humans Only") — the standing rules this mechanism must satisfy, and the precedent Section 5 (below) leans on to answer the abuse-guardrail question honestly rather than inventing a new bar this project hasn't set anywhere else.

**Where this will live:** entirely inside the existing `projects/hub/archive-search/` tool — no new Hub section, no new `tool` value in `team_member_tool_roles`, no new role. One new table, one new view, one modified view, two new routes, all under the `router.js` this project already has.

---

## What This Does

Today, if Archive Search's automated Fair Housing check flags a conversation — even wrongly, even on an obvious false positive like a "Bradford White" water heater — that conversation is permanently excluded from search with no way back in. Nobody can tell the system "I looked at this, it's not actually about anyone's race, disability, or age, please make it findable again." This build adds that missing piece: an admin reviews the flagged conversations, and for any one that's a genuine mistake, restores it to search — while permanently keeping the record that it was flagged in the first place, by whom it was cleared, and why. Nothing about the original AI decision gets erased; a second, human decision gets layered on top of it, visibly and permanently.

## How It Works

1. **An admin opens the flagged-conversation export** (`GET /api/archive-search/flagged-review-export`, admin-only) — a CSV of every conversation currently excluded from search for a Fair Housing reason: sender, date, subject, the actual message text (so the reviewer can judge it, the same reasoning the existing validation-sample export already uses), which category it was flagged under, and — if someone already acted on it — who overrode it, when, and why.
2. **The admin decides one is a false positive.** They call a single action (`POST /api/archive-search/flagged/:conversationId/override`) with the mailbox it came from and a required, written reason — no reason, no override.
3. **The system records the override as its own, separate fact** — a new row saying "this specific flagged determination, made by this version of the check, was reviewed by this person on this date, for this reason, and released." It never rewrites the original flag. `screening_result` on the actual message rows stays exactly `'flagged_protected_class'`, forever, exactly as the AI check left it.
4. **Search starts returning it.** The same database view search already reads through (`missive_message_intake_search_safe`) is taught one more rule: show a `'clear'` row, same as always, **or** show a `'flagged_protected_class'` row that has a currently-valid override on file. Nothing else changes about how search works.
5. **If that conversation ever gets new mail and gets re-screened,** the override automatically stops applying to the new result — it was only ever a decision about the specific flagged determination it was granted against, not a blanket, permanent pass for anything added to that conversation later. If the re-screen comes back `'clear'` on its own, nothing further is needed. If it comes back flagged again, an admin sees it in the export again, as a fresh decision.
6. **Every override is permanently logged** — who, when, why, and exactly what it was flagged as at the time — in the same audit trail every other decision in this system already goes through, with `actor_type: 'human'` always, never `'system'` or `'ai_agent'`, because this is exactly the kind of decision GOVERNANCE.md says a human must make and own.

## What You'll See

A downloadable list of every conversation the Fair Housing check has flagged and excluded from search, with the actual message text so you (or whoever you designate) can judge whether it's real or a false alarm. For anything that's clearly a false alarm, one action — click, type a short reason, done — and that conversation becomes findable in search again for the same people who could already search everything else. The conversation still shows up on this same list forever, now marked "overridden by [name] on [date]: [reason]" — nothing about the fact that it was once flagged ever disappears.

## What Could Go Wrong

- **An admin overrides something that shouldn't have been overridden.** The mitigation is the same one this project already trusts for the held-bucket review and for the maintenance-history tool's own live two-way override: a required, permanent, attributed written reason, not a second approver — Section 5 explains why that's the right level of friction here, not a lighter one.
- **A stale override silently masking a genuinely new Fair Housing issue in the same conversation.** Solved by construction (Section 3): an override only ever applies to the exact screening determination it was granted against; new mail that triggers a re-screen invalidates it automatically, with no code that has to remember to check for this.
- **The export itself becomes a new way to see Fair-Housing-adjacent correspondence in bulk.** True, and stated plainly rather than glossed over: this export deliberately includes real message text, the same trade-off the existing validation-sample export already makes, to the exact same already-trusted admin population, for the same kind of accuracy judgment — no new population, no new purpose, see Section 2.

---

## 1. Who Can Do This

**Recommendation: the same `'admin'` role for `tool = 'archive_search'` that already exists — no new role, no new population.** Confirmed, not assumed, against the original spec's "Access / Roles in the Hub" section: `'admin'` is already the population trusted with the two most comparable existing decisions in this tool — reviewing the pre-launch validation sample (Finding 5, "is this AI clear/flag determination actually correct?") and reviewing the held bucket (Finding 8, actual privileged/regulatory-complaint correspondence). Deciding "is this specific Fair Housing flag a false positive" is the same kind of judgment as the first of those, made on an ongoing basis instead of as a one-time pre-launch gate — there is no principled reason to draw a different or narrower population for it.

**A narrower population was considered and rejected.** Restricting overrides to Mason/counsel specifically, rather than the tool's existing admin population, would set a stricter bar than this project has set anywhere else for a comparable decision — the held-bucket review (arguably higher-stakes, since it covers actual privileged correspondence) is already entrusted to "Peter, the DO, or counsel" as a group, not counsel exclusively. GOVERNANCE.md's own language — Rule 8 Tier 3 ("Agent escalates entirely... Humans Only"), the Fair Housing Standard's Rule 7 ("a person decides and owns the decision") — requires *a* human, not a specific named human or a second reviewer. Narrowing further would be inconsistent with precedent, not more careful.

**One real, open question this spec does not decide (see Open Items):** whether Mason should be automatically notified (not gated — just informed) whenever an override happens, given it's specifically a Fair-Housing-adjacent decision rather than the held bucket's broader legal-hold character. Worth Mason's own view, not decided here.

Per the original spec's own standing note, who actually *holds* `'admin'` for this tool is Peter's call, made outside this schema — this spec adds no seed/grant row, exactly like the original migration.

---

## 2. The Review Experience — Export First, Not a Live UI, With One Explicit Caveat

**Model: the same "plain exported list, not a review-queue UI" pattern the validation-sample export already uses (Finding 5) — not the held-review-export's metadata-only shape, and here's why the two differ.** `missive_message_intake_held_review_safe` deliberately excludes message body content — Mason's Condition 4 is explicit that the held bucket "is not a search feature into the held bucket itself," and the correct place to review actual privileged/legal-hold correspondence is Missive itself, by hand, outside this system. That reasoning does not transfer here: a flagged conversation is not privileged, it's ordinary correspondence an automated check flagged, rightly or wrongly — the exact same character as the validation-sample export's `'clear'`-pool content, which this project already decided is fine to export with full `body_text` specifically because a reviewer cannot judge accuracy without seeing the actual text. This spec's flagged-review export follows that precedent, not the held-bucket one.

**A real, honest caveat, stated rather than assumed away: this is a recurring workflow, not a one-time bounded task, and a CSV-plus-hand-typed-`curl`-call interface is not a durable answer to that.** Finding 5's validation sample was explicitly a single, bounded, pre-launch exercise — a plain export was the right, simple mechanism for it. New mail keeps landing and getting screened indefinitely (original spec, "How It Works," step 6); new false positives will keep appearing on an ongoing basis for as long as this tool exists. Asking Peter — a non-developer, per CLAUDE.md's standing instruction — to submit a written reason and trigger an override via a raw authenticated API call is not a realistic, sustainable interface for a recurring task, even though it is a perfectly fine one for a single pre-launch gate.

**Recommendation: ship the schema and the two routes in this pass (matching the original build's own "schema + screening-pass + API — not Tron's dashboard" split), but name a minimal Tron UI as a required near-term follow-on, not indefinitely deferred work.** A small admin-only page — the flagged list, the message text, a text box for the reason, a button — is genuinely needed here in a way it was not for the one-time validation sample. This spec does not ask Tron to build it now (out of scope for this pass, per Asimov's own precedent for the original build), but it should not be treated as a "someday" item the way `screening_tags` UI display was in the original spec's Open Item 5. Flagged explicitly in Open Items below.

---

## 3. The Override Mechanism — Preserving History While Restoring Search Access

### 3.1 The core design decision

**Never touch `screening_result`, `screening_category`, `screening_tags`, `screening_version`, or `screening_completed_at` on `missive_message_intake`. Ever.** Flipping `screening_result` back to `'clear'` on override was explicitly ruled out by the task that produced this spec, and for good reason: it would erase the one fact a governance reviewer would most want to find later — that this conversation *was* flagged, by what, and under what version of the check. Instead, a new, small table records the override as its own fact, and the search-safe view is taught to also show a flagged row that has one, without ever pretending the row wasn't flagged.

**Updated 2026-09-12, per Mason's required revocation-path finding (see the new "Data Inventory" section and Open Item 6, both below): this table is append-*mostly*, not strictly append-only.** A row is inserted once, at grant time, and permits exactly one further event — a human revoking it (`revoked_at`/`revoked_by`/`revocation_reason`, all NULL until that happens, set together, once, and never cleared again). Every other column on the row is still fixed forever at insert, exactly as originally designed: a re-flag after a future re-screen still gets its own brand-new row, never an edit to an existing one. See Section 3.2's schema and Neo's migration (`supabase/migrations/20260912010000_archive_search_flagged_overrides_schema.sql`) for the full design.

**The mechanism that keeps an old override from silently covering a brand-new problem: the override is scoped to the exact screening determination it was granted against, not to the conversation in general.** `markConversationScreened()` (screening-pass.js) writes a fresh `screening_completed_at` timestamp across every row of a conversation every time it is (re-)screened — confirmed directly in the real code, not assumed. This spec's override row snapshots that exact timestamp at the moment of the override, and the search-safe view's new clause only honors an override when it matches the row's **current** `screening_completed_at`. If the conversation is later re-screened (new mail arrives, the driver query picks it up again, the whole thread is re-evaluated per screening-pass.js's own documented full-re-screen behavior), `screening_completed_at` changes — and the old override, still permanently on record, simply stops being the *current* one. No override row is ever deleted or edited to make this work; it just becomes a historical record of a prior determination once a newer one supersedes it. This is the same "never overwrite, add a new row for new state" discipline `archive_search_validation_sample.sample_run` already uses for its own re-draw case.

### 3.2 Schema (built by Neo, `supabase/migrations/20260912010000_archive_search_flagged_overrides_schema.sql`)

**Updated 2026-09-12 to add Mason's required revocation path** (`revoked_at`/`revoked_by`/`revocation_reason` below) **on top of this section's original design.** The table is no longer strictly "never updated after insert" — it now permits exactly one further event, a human revoking their own (or another admin's) earlier override, recorded on the *same* row rather than a new one, so both the grant and the revocation stay visible together forever. See the "Data Inventory (GOVERNANCE.md Rule 4)" section below for the required PII registration this new table (now including the revocation fields) triggers.

```sql
-- ============================================================
-- NEW TABLE: archive_search_flagged_overrides
--
-- One row per human decision to reinstate a specific flagged screening
-- determination into search — and, if it happens, the human decision to
-- later take that reinstatement back. Append-MOSTLY, not strictly
-- append-only (a deliberate, narrow departure from
-- archive_search_validation_sample's "never updated after insert"
-- discipline, scoped to exactly the revocation columns — see their own
-- comments below): a conversation that is re-flagged after a later
-- re-screen still gets its OWN new override row if an admin decides to
-- override that too; it never reuses or edits an existing one for that.
--
-- Deliberately does NOT touch missive_message_intake at all. Not a
-- single column on that table changes. screening_result stays exactly
-- what the screening pass wrote, forever — this table is a second,
-- independent fact layered on top, never a correction applied in place.
-- ============================================================

CREATE TABLE IF NOT EXISTS archive_search_flagged_overrides (
  id                                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Compound identity, mirroring missive_message_intake_held_review_safe's
  -- own GROUP BY (missive_conversation_id, mailbox_key) — this schema's
  -- own precedent treats a conversation id as unique only within a
  -- mailbox, not globally, so this table follows the same key shape.
  missive_conversation_id             TEXT        NOT NULL,
  mailbox_key                         TEXT        NOT NULL,

  -- Snapshots of what the flagged determination actually was AT THE
  -- MOMENT of override — never a live join back to missive_message_intake
  -- for these three. This is what lets the override row stand on its own
  -- as a permanent record even after a future re-screen changes the live
  -- row's own screening_category/version/completed_at.
  overridden_screening_category       TEXT        NOT NULL,
  overridden_screening_version        TEXT        NOT NULL,
  overridden_screening_completed_at   TIMESTAMPTZ NOT NULL,

  -- The human decision itself (the grant).
  overridden_by                       TEXT        NOT NULL,
  override_reason                     TEXT        NOT NULL
    CHECK (length(trim(override_reason)) > 0),
  overridden_at                       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The human decision to reverse it (Mason's required revocation path,
  -- 2026-09-12). All three NULL until revoked — never touched at INSERT
  -- time; the ONLY UPDATE this table ever permits is setting these three
  -- together, once.
  revoked_at                          TIMESTAMPTZ,
  revoked_by                          TEXT,
  revocation_reason                   TEXT,

  -- One override per exact determination — prevents an accidental double
  -- submit from creating two rows for the same flagged state, while still
  -- allowing a genuinely NEW override after a re-screen produces a new
  -- overridden_screening_completed_at value.
  UNIQUE (missive_conversation_id, mailbox_key, overridden_screening_completed_at),

  -- Keeps the three revocation columns in lockstep: either all three are
  -- NULL (never revoked) or all three are set together with a non-empty
  -- reason — the same "required, attributed, non-empty reason" discipline
  -- override_reason's own CHECK already enforces for the grant, applied
  -- symmetrically to the reversal.
  CONSTRAINT archive_search_flagged_overrides_revocation_fields_together
    CHECK (
      (revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL)
      OR
      (revoked_at IS NOT NULL AND revoked_by IS NOT NULL
       AND revocation_reason IS NOT NULL
       AND length(trim(revocation_reason)) > 0)
    )
);

ALTER TABLE archive_search_flagged_overrides ENABLE ROW LEVEL SECURITY;
-- RLS enabled, zero permissive policies — same default every table in
-- this schema uses; every real reader/writer is the Hub's own
-- service-role connection, gated in application code by
-- requireArchiveSearchAdmin, not by RLS (identical reasoning to
-- archive_search_validation_sample and every other table this project
-- has added).

-- Recency listing for the future admin UI (Section 2) and for the export
-- route's own ordering.
CREATE INDEX IF NOT EXISTS idx_archive_search_flagged_overrides_overridden_at
  ON archive_search_flagged_overrides (overridden_at DESC);

COMMENT ON TABLE archive_search_flagged_overrides IS
  'A human decision to reinstate one specific flagged screening determination into search, without ever changing screening_result/_category/_tags/_version/_completed_at on missive_message_intake itself — and, if it happens, the human decision to later take that reinstatement back (revoked_at/revoked_by/revocation_reason). A row is inserted once, at grant time, with the revocation columns NULL; the only UPDATE this table ever permits is setting those three together, once. Every other column is fixed forever at insert — a re-flag after a future re-screen (a new screening_completed_at) gets a fresh override row of its own if an admin chooses to override it again, never an edit to this one. See missive_message_intake_search_safe''s own comment for how a row here (grant AND revocation state) is consumed at query time.';

COMMENT ON COLUMN archive_search_flagged_overrides.overridden_screening_completed_at IS
  'Snapshot of missive_message_intake.screening_completed_at at the moment of override — this is the fingerprint that ties this override to one specific screening determination, not to the conversation in general. missive_message_intake_search_safe only honors this row while the live row''s own screening_completed_at still matches it AND revoked_at IS NULL; a later re-screen (new mail, a fresh pass) changes that value on the live row and this override silently stops applying, without ever being edited or deleted — same for a later revocation.';

COMMENT ON COLUMN archive_search_flagged_overrides.override_reason IS
  'Required, non-empty (enforced by CHECK, not just application code — same defense-in-depth discipline as missive_message_intake_screening_category_required). Guidance for whoever writes this, following the identical precedent already set for maintenance_claims.protected_class_flag_overridden''s own reviewer_notes field: describe the disposition and why it is a false positive — do not quote or paraphrase the flagged correspondence itself into this field, which is not subject to the same redaction discipline as the message content it is stored alongside in an audit trail. The same restraint applies to revocation_reason below.';

COMMENT ON COLUMN archive_search_flagged_overrides.revoked_at IS
  'NULL until a human decides this specific override should no longer keep its conversation searchable — Mason''s required revocation path (finding, 2026-09-12). Once set, missive_message_intake_search_safe''s EXISTS clause stops honoring this row on its very next query — the conversation reverts to excluded from search immediately, without this row (or any of the original grant''s columns) ever being deleted or edited. Enforced together with revoked_by/revocation_reason by this table''s own revocation-fields-together CHECK: never set alone.';

COMMENT ON COLUMN archive_search_flagged_overrides.revoked_by IS
  'Who revoked the override — same TEXT attribution convention as overridden_by. NULL until revoked; once set, permanent — a revocation, like the original override, is always attributed to a specific human, never inferred or defaulted.';

COMMENT ON COLUMN archive_search_flagged_overrides.revocation_reason IS
  'Why the override was revoked — required, non-empty once revoked (enforced by the revocation-fields-together CHECK). Same restraint as override_reason: describe the reason for reversing the decision, do not quote or paraphrase the flagged correspondence itself into this field.';


-- ============================================================
-- MODIFIED VIEW: missive_message_intake_search_safe
--
-- One additive change to the WHERE clause only — every column, every
-- other predicate, and security_barrier = true are unchanged from the
-- original migration. A currently-flagged row is now visible through
-- this view if, and only if, a currently-valid, NON-REVOKED override
-- exists for the EXACT determination it currently carries (see 3.1
-- above).
-- ============================================================

CREATE OR REPLACE VIEW missive_message_intake_search_safe
WITH (security_barrier = true) AS
SELECT *
FROM missive_message_intake m
WHERE m.screening_result = 'clear'
   OR EXISTS (
     SELECT 1
     FROM archive_search_flagged_overrides o
     WHERE o.missive_conversation_id           = m.missive_conversation_id
       AND o.mailbox_key                       = m.mailbox_key
       AND o.overridden_screening_completed_at = m.screening_completed_at
       AND o.revoked_at IS NULL
   );

-- All three predicates use only leakproof "=" / "IS NULL" comparisons,
-- and EXISTS against a plain equality-correlated subquery composes the
-- same way the original screening_result = 'clear' predicate already did
-- with the search_document @@ ... predicate (see the original spec's
-- "The Search Mechanism") — security_barrier's guarantee is unaffected by
-- adding this clause or the revoked_at IS NULL condition. One real,
-- honest performance note, not glossed over: the planner now has one
-- more correlated EXISTS check per row that isn't already
-- screening_result = 'clear', evaluated against a table expected to stay
-- small (overrides should be rare, by design) and already indexed for
-- this exact lookup by the table's own UNIQUE constraint — a real but
-- minor cost, not benchmarked here, and not expected to matter at this
-- archive's scale, but not asserted as free either.

COMMENT ON VIEW missive_message_intake_search_safe IS
  'The ONLY view every archive-search search/message route may query — never missive_message_intake directly, with the one named exception of screening-pass.js. Extended, archive-search-flagged-review-spec.md, to also surface a flagged row when a currently-valid, NON-REVOKED entry exists in archive_search_flagged_overrides for that row''s exact screening_completed_at — screening_result itself is NEVER rewritten to make this happen. A revoked override stops satisfying this EXISTS clause immediately, on the very next query. security_barrier = true unchanged from the original migration; see that migration''s own comment for why this view needs it.';


-- ============================================================
-- NEW VIEW: missive_message_intake_flagged_review_safe
--
-- Mirrors missive_message_intake_held_review_safe's own shape exactly
-- (one row per conversation, not per message; GROUP BY
-- (missive_conversation_id, mailbox_key); MAX() on the screening columns
-- because markConversationScreened() writes them identically across
-- every message row in a conversation in one call — confirmed directly
-- against the real screening-pass.js code, not assumed). Read-only,
-- admin-gated in application code (requireArchiveSearchAdmin) — no
-- security_barrier, same reasoning as the held-bucket view: this exists
-- specifically to surface flagged content to an already-trusted, narrow
-- population, not to hide it from a broad one.
--
-- Unlike the held-bucket view, this one is joined (in the export route's
-- application code, not here — same pattern held-review-export already
-- uses for its own audit_log join) against
-- archive_search_flagged_overrides so an admin reviewing the list can
-- see, for each conversation, whether it has already been overridden,
-- by whom, when, and why.
-- ============================================================

CREATE OR REPLACE VIEW missive_message_intake_flagged_review_safe AS
SELECT
  missive_conversation_id,
  mailbox_key,
  MIN(delivered_at)                                        AS earliest_delivered_at,
  MAX(delivered_at)                                         AS latest_delivered_at,
  COUNT(*)                                                  AS message_count,
  (ARRAY_AGG(subject      ORDER BY delivered_at ASC))[1]    AS earliest_subject,
  (ARRAY_AGG(from_address ORDER BY delivered_at ASC))[1]    AS earliest_from_address,
  MAX(screening_category)                                   AS screening_category,
  MAX(screening_version)                                    AS screening_version,
  MAX(screening_completed_at)                               AS screening_completed_at
FROM missive_message_intake
WHERE screening_result = 'flagged_protected_class'
GROUP BY missive_conversation_id, mailbox_key;

COMMENT ON VIEW missive_message_intake_flagged_review_safe IS
  'archive-search-flagged-review-spec.md — every currently-flagged conversation, one row per conversation, admin-only, read-only, mirroring missive_message_intake_held_review_safe''s own shape exactly. Deliberately does NOT include body_text — unlike the export route built on top of it, which deliberately DOES fetch body_text separately for the reviewer to judge, the same precedent the validation-sample export already set (not the held-bucket export''s metadata-only shape — see the spec''s Section 2 for why the two differ). Joined in application code against archive_search_flagged_overrides to show existing override status; this view does not know about overrides itself.';


-- ============================================================
-- ROLLBACK
-- ============================================================
--
-- DROP VIEW IF EXISTS missive_message_intake_flagged_review_safe;
--
-- -- Reverts missive_message_intake_search_safe to its original,
-- -- override-unaware definition (20260910030000). Safe at any time —
-- -- this only changes which rows the view returns, never any stored
-- -- data.
-- CREATE OR REPLACE VIEW missive_message_intake_search_safe
-- WITH (security_barrier = true) AS
-- SELECT * FROM missive_message_intake WHERE screening_result = 'clear';
--
-- DROP INDEX IF EXISTS idx_archive_search_flagged_overrides_overridden_at;
-- -- Confirm no real override (or revocation) has been granted yet before
-- -- dropping this table for real — check row count first. If any
-- -- override exists, this table is the only durable record that a human
-- -- ever restored that specific conversation to search, AND — if it was
-- -- later reversed — the only durable record that a human later revoked
-- -- that reinstatement, by whom, when, why. Dropping the table loses both
-- -- facts permanently (audit_log's own archive_search.
-- -- flagged_conversation_overridden and, once built,
-- -- archive_search.flagged_override_revoked events, Section 4, are the
-- -- one remaining record if this table is ever dropped after real use).
-- DROP TABLE IF EXISTS archive_search_flagged_overrides;
--
-- ============================================================
```

### 3.3 Routes

Both reuse `requireArchiveSearchAdmin` exactly as it exists today — **no schema change to `team_member_tool_roles`, no new tool value, no new role.** This is smaller than the original build in that specific sense: it needed a brand-new tool/role pair; this one needs neither.

- **`GET /api/archive-search/flagged-review-export`** (admin-only) — CSV of `missive_message_intake_flagged_review_safe`, with `body_text` fetched separately per conversation's earliest message (same "the reviewer needs the real content to judge it" reasoning as the validation-sample export, Section 2), joined in application code against `archive_search_flagged_overrides` (same pattern `held-review-export` already uses for its own `audit_log` join) to show existing override status per row. Logs `archive_search.flagged_review_export_generated` on every pull (Section 4).
- **`POST /api/archive-search/flagged/:conversationId/override`** — admin-only. Body: `{ mailbox_key, reason }`, both required. Logic:
  1. Read the conversation's current state from `missive_message_intake_flagged_review_safe` only — never the base table directly, keeping the original spec's Finding 1 discipline fully intact (this route needs `screening_category`/`screening_version`/`screening_completed_at`, all of which that view already exposes without any message body content).
  2. If no row is found, or `mailbox_key` doesn't match, return 404 — nothing to override.
  3. Validate `reason` is non-empty after trimming (a clean 400 with a clear message; the table's own `CHECK` constraint is the backstop, not the primary UX).
  4. Insert into `archive_search_flagged_overrides`, snapshotting `screening_category`/`screening_version`/`screening_completed_at` exactly as read in step 1, `overridden_by: req.archiveSearchMemberName || req.user.email` (same precedent `maintenance_claims.reviewed_by` and this tool's own `attachArchiveSearchRole` already establish).
  5. Write `archive_search.flagged_conversation_overridden` (Section 4).
  6. Return success. From this point, `missive_message_intake_search_safe` includes this conversation's rows automatically — no further write to `missive_message_intake` happens, by design.

### 3.4 A pre-existing inconsistency this design surfaces, not introduced by it

Read directly against the real code while designing this: `screening-pass.js`'s `fetchFullConversation()` groups a conversation by `missive_conversation_id` alone, with no `mailbox_key` filter — while `missive_message_intake_held_review_safe` (and now this spec's `flagged_review_safe`) both group by `(missive_conversation_id, mailbox_key)` together, implying Neo's own view design assumed conversation ids are only unique within a mailbox, not globally. This is a real, pre-existing gap in the screening pass itself, unrelated to this spec's own correctness (this spec's override key already requires `mailbox_key` to match, so it cannot itself misattribute an override across mailboxes) — named here because it surfaced while designing this table's key, not because this spec is the place to fix it. Carried into Open Items.

---

## 4. The Required Audit Trail

Two events, both reusing `audit_log` exactly as it stands today (no schema change) — every field value below confirmed legal against the real, current CHECK constraints (`20260815000000_audit_log_rule1_compliance.sql`), not assumed.

| Event | `action` | `actor_type` | `entity_type` | `privacy_category` | `risk_level` |
|---|---|---|---|---|---|
| A conversation is reinstated | `archive_search.flagged_conversation_overridden` | **`human`** | `archive_search_flagged_override` | `processing` | `high` |
| The flagged-bucket export is pulled | `archive_search.flagged_review_export_generated` | `human` | `archive_search_flagged_export` | `processing` | `medium` |
| An override is revoked (added 2026-09-12, Mason's required revocation-path finding) | `archive_search.flagged_override_revoked` | **`human`** | `archive_search_flagged_override` | `processing` | `high` |

**The third row is new, added with the revocation path itself.** `risk_level: 'high'` — matching, not exceeding, the override-grant event it reverses: turning off search access to Fair-Housing-adjacent content for up to 8 people is at least as consequential as turning it on, so it does not get a lower ceiling just because it is a "cleanup" action. `actor_type: 'human'`, always, for the identical Rule 8 Tier 3 / Fair Housing Standard Rule 7 reasoning already given for the grant event below — no code path in this design ever revokes an override automatically. `details` for this event should carry the same shape as the grant event (`override_id`, `missive_conversation_id`, `mailbox_key`, the three `overridden_screening_*` values as they were at grant time, plus `revocation_reason`) so a reviewer can see exactly what was reversed without a second lookup. Writing this event is Q's future revocation-route work, not built by Neo's schema migration — named here so the dependency is explicit, matching how `flagged_conversation_overridden` and `flagged_review_export_generated` were already named ahead of their own routes.

**`actor_type: 'human'`, always, hardcoded, never optional and never inferred from context — the one deliberate, non-negotiable value in this whole document.** This is exactly the class of decision GOVERNANCE.md's Rule 8 Tier 3 ("Agent escalates entirely... Humans Only") and the Fair Housing Standard's Rule 7 ("a person decides and owns the decision") describe: a human overriding an automated Fair Housing screening determination. There is no code path in this design that could ever produce this event with `actor_type: 'system'` or `'ai_agent'` — no automated process ever calls the override route.

**`risk_level: 'high'` for the override itself — matching, not exceeding, the ceiling this project has already set for this class of event.** The original `screening_flagged_protected_class` and `screening_held` events are both already logged at `'high'`. An override reverses one of those determinations for real, live search visibility — it should be logged at the same level those determinations themselves carry, not lower (this is a real, consequential action, not routine housekeeping) and not escalated to `'critical'` either (this project has not used `'critical'` anywhere in this tool, and reserving it for something more severe than a documented, reasoned, fully-audited human correction is the more defensible line).

**`risk_level: 'medium'` for the export pull — not `'low'`, and here's the deliberate reason it differs from `held_review_export_generated`'s own `'low'`.** The held-bucket export is metadata-only (no message body). This spec's flagged-review export deliberately includes real `body_text` (Section 2) — the same "materially wider window into raw correspondence" reasoning the original spec already used to justify `'medium'` for `query_performed`/`message_opened` (Finding 6) applies here for the identical reason, and should not be logged at the held-bucket export's lower level just because both are CSV exports.

**`details` — what is logged, and, just as deliberately, what is not:**

```json
// archive_search.flagged_conversation_overridden
{
  "override_id": "<uuid>",
  "missive_conversation_id": "...",
  "mailbox_key": "...",
  "overridden_screening_category": "disability_health",
  "overridden_screening_version": "archive-search-screening-v1",
  "overridden_screening_completed_at": "2026-09-10T04:12:00Z",
  "override_reason": "<the reviewer's own written text>"
}
```

**Never logged: the matched keyword/term, the self-report classifier's own free text, or any excerpt of `body_text`/`subject`** — the exact same restraint the original spec's Finding 1 already established for `screening_flagged_protected_class` itself, and the same one `maintenance_claims.tier_b_classification` already draws around the AI's own reasoning. `override_reason` is the one piece of free text this event does carry — that is a **direct, deliberate reuse of an already-approved precedent**, not a new exception: `maintenance_claims.protected_class_flag_overridden`'s own `details` shape (`content-screening-tier-redesign-SPEC.md`, Section 5) already includes `reviewer_notes` in full for this identical class of event (a human override of a Fair Housing flag), on the reasoning that the reviewer's own authored explanation of their decision is not the same category of sensitive content as the underlying correspondence. The same guidance that precedent states applies here without modification: describe the disposition, don't quote the flagged text into the reason field (restated on the table's own column comment, Section 3.2, so it travels with the schema, not just this document).

---

## Data Inventory (GOVERNANCE.md Rule 4)

**Added 2026-09-12, per Asimov's required finding on this spec's original draft (quoted in full at the top of this document): "This spec adds a brand-new table (archive_search_flagged_overrides) that stores personal data — a staff member's name (overridden_by) and free text about a Fair Housing disposition (override_reason) — and has no equivalent section. Rule 4 requires registering any new personal-data-storing table (pii_fields, agents_with_access, privacy_category, retention_policy, ccpa_exportable/deletable) before it ships."** This section is that registration. It did not exist in the original draft. Structured the same way `20260910000000_complaint_tracking_schema.sql`'s own Rule 4 section registers its one sensitive new table (`complaints`) — full inventory, not a delta on an existing table's inventory, since `archive_search_flagged_overrides` is brand new. Covers both this table's original override fields and the revocation fields added alongside this same finding (Section 3.1's update, Section 3.2, Open Item 6).

**`archive_search_flagged_overrides` — the only new table this spec adds. Full inventory:**

- **`pii_fields`:**
  - `override_reason`, `revocation_reason` — free text written by a human reviewer explaining a Fair-Housing-adjacent disposition. PII-adjacent, same caveat used everywhere else in this schema for a reviewer's own free-text explanation (`maintenance_claims.reviewer_notes`, `security_deposit_cases.reviewer_notes`) — not about a third party by design (each column's own comment instructs the reviewer never to quote or paraphrase the flagged correspondence into it), but still personal data in its own right: it is the reviewer's authored judgment, tied to their name via `overridden_by`/`revoked_by` on the same row.
  - `overridden_by`, `revoked_by` — a staff member's name/email, identifying exactly who made each decision. Personal data, but — following the identical, already-approved precedent `maintenance_claims.reviewed_by` already sets in this same schema (that table's own Rule 4 section lists `reviewer_notes` as a redaction-target `pii_field` but does not list `reviewed_by` among the columns targeted for CCPA redaction) — these two are the accountability mechanism itself, not incidental collection: the whole point of this table, per the Fair Housing Standard's Rule 7 ("a person decides and owns the decision"), is a permanent, attributed record of who made each call. See `ccpa_deletable` below for how this is handled without contradicting Rule 10.
  - `overridden_screening_category` — could indirectly reveal what kind of protected-class topic the flagged conversation involved, without containing the correspondence itself (same caveat `screening_category`/`complaints.flagged_category` already carry on their own source tables).
  - `missive_conversation_id`, `mailbox_key` — not PII directly, but an indirect pointer into `missive_message_intake`, this schema's highest-PII-density table (same caveat `archive_search_validation_sample.missive_message_intake_id` already carries for the identical reason) — a row existing here identifies which specific conversation was flagged, reviewed, and (if applicable) reinstated or later un-reinstated.
  - `overridden_screening_version`, `overridden_screening_completed_at`, `overridden_at`, `revoked_at` — timestamps/version strings, not personal data by themselves, but load-bearing metadata for exactly which determination and which decision this row documents.

- **`agents_with_access`:** NONE. No AI agent, LLM call, or extraction step reads or writes this table — every row is written by a human, through Q's future override and revocation routes, gated by `requireArchiveSearchAdmin` (the same `'admin'`-for-`tool='archive_search'` population Section 1 already names, reused rather than a new one). Reads: the same admin population, via the flagged-review-export route (joining this table against `missive_message_intake_flagged_review_safe`, Section 3.3) and, once built, a revocation route/UI.

- **`privacy_category`:** `'processing'` — a human decision layered on top of already-collected, already-screened correspondence, not a new collection event. This applies identically to the revocation fields: revoking is a second `'processing'` event of the same underlying record, not a new collection of anything.

- **`retention_policy`:** RESOLVED, not a placeholder — kept indefinitely, never deleted, matching this schema's own `archive_search_validation_sample` and `audit_log` precedent for a permanent decision record. This is the whole point of the table's design (Section 3.1): a revoked override does not get deleted, redrawn, or archived out — it stays, forever, as the one row that shows both that reinstatement was granted and that it was later taken back.

- **`ccpa_exportable`:** TRUE — this table plainly holds personal data about identifiable staff members (`overridden_by`, `revoked_by`) and reviewer-authored text about a specific, identifiable correspondence record.

- **`ccpa_deletable`:** TRUE for `override_reason`/`revocation_reason`, via the same targeted `"[REDACTED]"` redaction convention `maintenance_claims.reviewer_notes` and `complaints.description`/`resolution_note` already use — preserving `overridden_screening_category`/`_version`/`_completed_at`, `overridden_at`, and `revoked_at` for audit continuity (the fact "this was overridden, and later revoked" stays; the reviewer's own free-text explanation of why does not, if redaction is ever requested). **NOT deletable/redactable for `overridden_by`/`revoked_by`** — following `maintenance_claims.reviewed_by`'s own already-approved precedent of excluding staff-attribution columns from the redaction target list: these two columns are the accountability record itself, not content about a third party, and redacting them would defeat the reason this table exists. This is not in tension with Rule 10 (CCPA delete must cascade) — Rule 10 governs a *contact's* (tenant/owner/applicant) data, and no contact is a data subject on this table at all; `overridden_by`/`revoked_by` identify Rincon's own staff acting in their employment capacity, the same category `reviewed_by` already occupies elsewhere in this schema.

- **Not CCPA-scannable beyond the redaction convention above** — `override_reason`/`revocation_reason` should be added to whatever CCPA scan list already covers `maintenance_claims.reviewer_notes` and `complaints.description`, once one exists (no CCPA scan list exists yet anywhere in this schema, per every prior Rule 4 section's own silence on this point — not a gap this spec introduces).

**RLS:** enabled on `archive_search_flagged_overrides`, zero permissive policies at creation — same "locked down until a tool explicitly asks for access" default as every table in this schema, applied here specifically because this table's very existence-per-row is sensitive: it names a specific staff member's judgment call about a specific Fair-Housing-flagged conversation, twice over if it is later revoked.

---

## 5. A Real Governance Question — Guardrails Against Abuse

**The question, stated plainly:** should there be anything beyond a required written reason and a full audit trail to stop a single admin from quietly clearing every flag with a low-effort, boilerplate reason — a second approver, a rate limit, a real-time review gate — or is trusting the admin population's judgment, the same way this project already does for the held-bucket review and the maintenance-history tool's live `clear_flag` override, the right answer here too?

**Recommendation: no real-time gate and no second-approver requirement — trust the admin population, consistent with how this project has already decided to handle every comparable decision, and reuse (don't rebuild) the periodic-review machinery this project has already recommended elsewhere.**

Reasoning, not assertion:

- **This project has never required dual control for a comparable human decision.** The held-bucket review (Finding 8) — arguably the higher-stakes case, since it covers actual privileged/legal-hold correspondence — is entrusted to "Peter, the DO, or counsel," reviewed and closed "by hand," with no second sign-off built into the system. The maintenance-history tool's own live `clear_flag`/`flag` two-way override (`content-screening-tier-redesign-SPEC.md`, Section 6) — the direct precedent for this exact mechanism — requires only a written reason from a `PRIVACY_REVIEW_ROLES` holder, nothing more, and that design has already cleared both Asimov's and Mason's real review and outside counsel's opinion. Requiring a second approver here, where neither of those did, would be an inconsistent, invented bar — not a more careful one.
- **GOVERNANCE.md's own language describes a single human deciding, not a panel.** Rule 8 Tier 3 says an agent "escalates entirely" to humans; the Fair Housing Standard's Rule 7 says "a person decides and owns the decision" — singular. Rule 6's "attorney review + 7-day shadow mode" bar is written for changes to the **screening logic itself** (a Critical change to decision criteria) — this mechanism does not change the screening logic at all; it is a per-case human judgment call layered on top of whatever the logic already decided, the same category of action `clear_flag` already is for `maintenance_claims`, which did not go through a shadow-mode period either.
- **The real, already-recommended lever is after-the-fact visibility, not a real-time gate — and it already exists in this design, more durably than the precedent it follows.** Every override is a permanent, queryable row plus a permanent, attributed `audit_log` event — more structured than `maintenance_claims`'s own equivalent, which lives only in `audit_log.details` with no dedicated table. "How often is this being used, and does the pattern look right" is fully answerable at any time without building anything new.

**One concrete, low-cost recommendation, reusing existing machinery rather than inventing new machinery:** the original spec's own Open Item 7 already recommends a periodic (e.g. quarterly) re-validation sample against newly-screened mail, to keep checking the underlying screening accuracy after launch. **Fold a review of override usage into that same, already-recommended cadence** — when Mason or whoever holds the tool's `'admin'` role does that periodic check, they also pull the period's overrides and confirm the reasons given look substantive, not boilerplate. This adds no new mechanism, no new schedule, and no new audit event — it reuses a check this project has already decided it wants to do anyway, extended slightly in scope. This is a recommendation for Peter/Asimov/Mason to confirm, not something this spec treats as already decided (see Open Items).

---

## 6. Interaction With the Three Fair-Housing-Check-Loosening Options

Peter is separately weighing three ways to change how the Fair Housing check itself decides what to flag: a model swap keeping full coverage, a wider-keyword-gated narrower AI net, or a sampling/reactive-takedown approach. **This mechanism works identically regardless of which one is chosen, and should not be treated as blocked on that decision.**

The reason is structural: everything this spec builds operates only on `screening_result`, `screening_category`, `screening_version`, and `screening_completed_at` as they already exist on `missive_message_intake` — four fields whose meaning is already fixed by the original schema and does not depend on which mechanism populates them. Whether a conversation ends up `screening_result = 'flagged_protected_class'` because of today's Tier A keyword list plus the Tier 2 self-report classifier, a swapped model with full coverage, a narrower AI net gated behind a wider keyword trigger, or a reactive process that flags something after the fact, this mechanism reads the same four columns the same way and writes the same override row the same way. Nothing in Sections 3–4 references the detection mechanism at all.

**One honest, non-blocking observation, not a caveat that changes the design:** if the sampling/reactive-takedown option is the one chosen, the volume and rhythm of what shows up in the flagged bucket may look different — items might arrive in smaller, more irregular batches rather than as the product of one uniform batch pass — which could affect how often an admin needs to check the export, but not whether the override mechanism itself works. This spec does not need, and does not attempt, to anticipate which of the three gets picked.

---

## 7. Confirmed Non-Interactions, Stated Explicitly Rather Than Left Implicit

**The retention/deletion clock (original spec, Finding 9 / Open Item 1) is completely unaffected by this build.** `complaints.flagged_protected_class`'s own real column comment — "advisory tag only, never a hold" — already establishes, and the original spec's Finding 9 already confirms for this exact table, that a `'flagged_protected_class'` row gets the ordinary 4-year CCP §337 clock, same as `'clear'`, not the permanent hold `'held'` rows get. This spec does not touch `screening_result` at all, so it cannot and does not change that in either direction — an overridden conversation's retention clock is exactly what it already was before the override, because the column that clock is computed from never changes.

**This spec does not require its own new AI Risk Assessment.** `compliance/archive-search-ai-risk-assessment.md` already covers the AI decision this mechanism provides an override for (the screening pass's own flagging determination). This build introduces no new AI decision-making of any kind — the override action is, by design and by Section 4's `actor_type: 'human'` requirement, never automated. A fresh AI Risk Assessment would be warranted for a genuinely new AI capability (e.g., an AI-assisted triage suggestion for which flagged items look most like false positives); nothing like that is proposed here.

**The required CI/test guardrail from the original spec's Finding 1 (no file outside `screening-pass.js` may reference `missive_message_intake` by its raw name) needs a small, necessary update, named here so it is not missed.** That check must allow-list `missive_message_intake_flagged_review_safe` as a legitimate view name, the same way it already had to account for `missive_message_intake_held_review_safe`. This spec does not build or modify that check (Q's/TARS's work); it names the dependency so whoever maintains it sees it before this ships.

---

## Open Items — Needs Confirming Before This Gets Built

1. **Whether Mason should be automatically notified (not gated) on every override** (Section 1) — a real, reasonable question given the Fair-Housing-adjacent nature of this specific decision, left to Mason's own judgment rather than decided here.
2. **The timing of a real Tron UI** (Section 2) — this spec recommends one is genuinely needed sooner than the original build's UI-deferral precedent suggests, because this is a recurring workflow, not a one-time gate. Not scheduled here; Peter's call.
3. **Whether the periodic re-validation sample (original spec, Open Item 7) is actually extended to include an override-usage spot-check** (Section 5) — this spec recommends it and explains why, but does not treat the recommendation as already adopted.
4. **The pre-existing `mailbox_key`-scoping inconsistency between `screening-pass.js`'s `fetchFullConversation()` (unscoped) and this schema's own view convention (scoped)** (Section 3.4) — surfaced while designing this table's key, genuinely unrelated to this spec's own correctness, but worth Neo's or Q's attention on its own terms at some point.
5. **Whether `complaints.flagged_protected_class` (complaint-tracking's own, separate advisory Fair Housing tag, same "advisory tag only, never a hold" precedent) needs an equivalent override mechanism** — not examined by this spec, not assumed to need one or not need one, named only because the underlying problem shape (an AI Fair Housing flag with no release valve) could plausibly recur there too.
6. ~~Whether an override, once granted, should ever be revocable — not built here.~~ **Resolved 2026-09-12, per Mason's required finding: yes, and it is now built into the schema.** `archive_search_flagged_overrides.revoked_at`/`revoked_by`/`revocation_reason` (Section 3.2, above) let a human reverse an override without ever deleting the row or touching `screening_result` — the moment `revoked_at` is set, `missive_message_intake_search_safe` stops honoring that override on its very next query. What is genuinely still open, and not resolved by adding these columns: the notice question Mason's finding didn't reach — whether a searcher who already saw a now-revoked conversation needs to be told, or whether silent re-exclusion is sufficient — and the revocation route/UI itself (Q's/Tron's future work; only the schema ships now). Both remain real open items, not decided here.

---

## Ready for Asimov + Mason Review

The real compliance questions this spec is asking Asimov and Mason to weigh in on, not deciding unilaterally:

1. **Is the `'admin'`-for-`tool='archive_search'` population the right one to trust with reinstating a Fair Housing flag** (Section 1), or does Mason want a narrower population, or a notification-only involvement, given this is specifically a Fair-Housing-adjacent decision rather than the broader held-bucket legal-hold character?
2. **Is "required written reason + full permanent audit trail, no second approver" the right level of control** (Section 5), matching this project's own existing precedent for the held-bucket review and the maintenance-history tool's live `clear_flag` override — or does this specific decision (search visibility of Fair-Housing-adjacent content, at Hub scale, to a wider population than a one-off precision fix) warrant something more than either of those precedents required?
3. **Does exposing flagged conversations' real message text in bulk to the admin population** (Section 2/3.3, the same trade-off the validation-sample export already made) need any additional restriction specific to *this* content, given it is Fair-Housing-flagged rather than merely unscreened?
4. **Does the "override is scoped to the exact screening determination, invalidated by any re-screen" design** (Section 3.1) correctly balance "never let a stale override mask a new problem" against "never make a human re-justify the same correct decision needlessly" — or is there a Fair Housing reason to require a fresh look even sooner (e.g., any new message in the conversation at all, not just a full re-screen)?
5. **Open Item 1 (notify Mason on every override) and Open Item 3 (extend the periodic audit to cover override usage)** — both real, both left to Peter/Mason's judgment rather than decided in this document.
