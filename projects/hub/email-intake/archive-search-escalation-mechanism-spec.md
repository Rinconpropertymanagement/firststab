# Archive Search — Employee Escalation Mechanism for Material Fair Housing Concerns

**Status:** APPROVED and BUILT. Asimov's and Mason's closing review (`compliance/archive-search-escalation-mechanism-review.md`) resolved all open questions from the "Ready for Asimov + Mason Review" section below — see that file for the real, full verdicts, not the questions as originally posed here. Peter's two decisions (notification recipient: both `DO_EMAIL` and Peter's own email; GOVERNANCE.md Rule 6 shadow-mode requirement: explicitly waived, logged to `audit_log`) are recorded and implemented. Schema (`supabase/migrations/20260912030000_archive_search_escalations_schema.sql`) and routes (`report`/`resolve`/`export` in `archive-search/router.js`) are built, tested (106 tests), and the migration is applied to production. Two follow-on decisions (both resolved 2026-09-12, also implemented and tested): a `'confirmed'` report can be reopened by an admin (never erasing the original confirmation), and a duplicate report now gets a specific, informative message instead of a generic one. **Not yet live** — the report/resolve routes have no real caller until Tron builds the search UI's Report button, and none of this project's code has been deployed to the production server yet.
**Written by:** Oracle
**Date:** 2026-09-12
**Origin:** `compliance/archive-search-fair-housing-outside-counsel-opinion.md` — the real opinion received from Rincon's outside counsel approving Archive Search's Option B cost-reduction redesign, subject to eight named safeguards. Safeguard #5, verbatim: *"provide an employee escalation mechanism for material discriminatory content encountered during searches."* Counsel's own Section 7 gives the actual rule this mechanism must implement, verbatim: *"If a search result appears to contain a material Fair Housing concern, the employee should stop relying on that information for decision-making and escalate the issue to the designated manager/compliance person when appropriate... I would not require employees to report every historical mention of disability, children, vouchers, race or another protected characteristic. The escalation rule should concern potential discriminatory treatment or inappropriate use, not mere presence of protected information."* Peter assigned this document directly. This is that mechanism, designed concretely rather than restated.

**This is a direct extension of the already-approved Archive Search project, not a new tool** — same reasoning `archive-search-flagged-review-spec.md` already gives for itself. It reuses that project's schema conventions, role model, audit conventions, and (Section 5, below) a real notification pattern already live elsewhere in this same Hub, and departs from precedent only where this task genuinely requires something new (Section 3).

**This is explicitly NOT `archive-search-flagged-review-spec.md`'s override mechanism, and the difference is structural, not cosmetic.** That spec's `archive_search_flagged_overrides` table exists to *correct a false positive* — the AI's automated check said `'flagged_protected_class'`, and a human says "no, that's wrong, restore it." This document is the mirror-image, opposite-direction case: the AI's automated check said (or implied, via the Option B wide-net gate now under separate review) `'clear'`, and a human — a trained searcher, not an admin, using their own professional judgment while actually reading correspondence, exactly the class of judgment counsel's opinion trusts (Section 3 of that opinion) — says "I think this one is actually a real problem the system missed." Different direction, different population initiating it, different default disposition, and (Section 3, below) a different table. It reuses only what genuinely transfers: the audit conventions, the admin-review-and-resolve shape, and the same `requireArchiveSearchAdmin`/`requireArchiveSearchAccess` functions already built.

**Built from, read in full:**
- `compliance/archive-search-fair-housing-outside-counsel-opinion.md` (full) — Section 7 ("Human Judgment Should Remain Part of the System," quoted above) is this document's entire mandate. Section 10's numbered safeguard list, Section 4's reasoning for why an 8-person, Fair-Housing-trained population can be trusted with professional judgment, and the "Claude's Analysis" section's own safeguard-status table (safeguard #5: **"Not yet built — real, non-trivial new scope"**) — all read in full, not summarized from memory.
- `projects/hub/email-intake/archive-search-flagged-review-spec.md` (full) — the most recent, most rigorous precedent for this directory's own citation and rigor conventions, and the direct structural model for Sections 3–4 below: `archive_search_flagged_overrides`'s schema shape (compound `(missive_conversation_id, mailbox_key)` identity, a required non-empty reason enforced by `CHECK`, an append-mostly table with exactly one further permitted event), its "never touch `screening_result` — ever" discipline (Section 3.1 of that spec), its additive `EXISTS` modification to `missive_message_intake_search_safe`, its Data Inventory section (GOVERNANCE.md Rule 4), and its Section 5 reasoning for why this project has never required dual control for a comparable human decision.
- `projects/hub/email-intake/archive-search-technical-spec.md` (full) — Finding 1 (the raw-table guardrail, `missive_message_intake_search_safe` is the only view any route may query, `screening-pass.js` the one named exception), Finding 6 (the `query_performed`/`message_opened` audit-logging convention and its `'medium'` risk-level reasoning), Finding 7 (the "no results" default and why a restricted-content placeholder is the wrong pattern here), and "Access / Roles in the Hub" (the `'searcher'`/`'admin'` role pair this document reuses without modification).
- `projects/hub/archive-search/router.js` (full) — `requireArchiveSearchAccess`, `requireArchiveSearchAdmin`, `attachArchiveSearchRole`, `writeAuditLog()`'s real call shape, `missiveConversationLink()`, the `flagged-review-export`/`flagged/:conversationId/override`/`flagged-override/:overrideId/revoke` routes' exact patterns (Section 6b) this document's own routes are modeled on, and — the one finding that changes this document's answer to the task's own notification question — the `mason_notification_required: true` / `mason_notification_status: 'not_sent_no_channel_implemented'` placeholder pattern at lines 647–648 and 735–736, written because *no chat/real-time notification system exists in this Hub*. Section 5, below, confirms that finding is correct for a *chat* system and simultaneously confirms it is **not the whole picture**: a real, already-wired, already-used **email** notification channel exists in this exact codebase, and this document uses it rather than repeating the placeholder pattern.
- `projects/hub/security-deposit/router.js` (relevant sections, ~lines 58–100, 1930–1988, 3230–3265) and `projects/hub/insurance/router.js` (~lines 71–125) — confirmed directly, not assumed: both already implement `createMailer()` via `nodemailer` against `process.env.GMAIL_USER`/`GMAIL_APP_PASSWORD`, and both already send a real escalation email to `process.env.DO_EMAIL` when a human escalates something for another human's review — `security-deposit`'s `POST /api/security-deposit/cases/:id/escalate` is, structurally, the closest existing precedent in this entire codebase to what this document needs to build. That route's own honesty discipline — reporting `escalation_email_sent` as its own field in the API response rather than folding a silent email failure into `success: true`, and firing a separate `sendFailureAlertEmail()` when the primary send fails — is reused directly in Section 5, not reinvented.
- `projects/hub/server.js` (~line 140) — confirms `GMAIL_USER`, `GMAIL_APP_PASSWORD`, and `DO_EMAIL` are already required, already-configured top-level environment variables for the whole Hub process, not something specific to those two tools alone.
- `projects/hub/archive-search/lib/screening-pass.js` (full), specifically `fetchFlaggedEarliestBodyTextByConversation()` (~lines 676–722) — the one function outside `screening-pass.js`'s own driver code that the Finding-1 raw-table guardrail already permits to read `missive_message_intake` directly, specifically because a review-safe view (there, `missive_message_intake_flagged_review_safe`) deliberately excludes `body_text` and a human reviewer needs the real text to judge a report. This document's own escalation-review export (Section 3.3) needs the identical capability for a different population of conversations (escalated, not AI-flagged) and reuses this exact, already-approved exception pattern rather than opening a second one.
- `projects/hub/archive-search/test/no-raw-table-access-check.js` (full) — the CI guardrail that fails the build if any file under `archive-search/router.js` or `archive-search/lib/` other than `screening-pass.js` references the raw `missive_message_intake` table by name. This document's own design (Section 3) is checked against this guardrail directly: nothing this document proposes needs a new exemption, because the one raw-table read it needs is done by extending `screening-pass.js`'s own existing exempt function, not by adding a second exempt file.
- `projects/hub/email-intake/archive-search-v1-scope.md` (Sections 4 and 7) — the real, confirmed 8-person access population (Peter, Stephen, Dio, Leo, Regina, Marci, Elizabeth, Caylee) this document's "who can report" question (Section 1) answers against.
- `GOVERNANCE.md`, Rule 1 (audit trail, all required fields), Rule 4 (new-table data inventory), Rule 8 (Tier 3 — "Agent escalates entirely... Humans Only"), and the Fair Housing Standard's Rule 7 ("a person decides and owns the decision") and Rule 6 ("blanket screening rule... flag any... to Mason") — the standing rules this mechanism must satisfy. Read against this document's own design in Section 6, not assumed to be satisfied.

**Where this will live:** entirely inside the existing `projects/hub/archive-search/` tool — no new Hub section, no new `tool` value in `team_member_tool_roles`, no new role. One new table, one further additive modification to `missive_message_intake_search_safe`, three new routes, all under the `router.js` this project already has. No dependency on Neo's or Q's not-yet-built search UI (see Section 2's honest dependency note) for the schema or the admin-facing routes — only the searcher-facing report action is inert until that UI exists.

---

## What This Does

Right now, if a Rincon employee is searching the old email archive and comes across something that looks like a real Fair Housing problem — not just a mention of a tenant's disability or a family's kids, but something that actually reads like discriminatory treatment, a comment that shouldn't have been made, a decision that looks like it was made for the wrong reason — there is no button, no form, no way inside this tool to do anything about it except tell someone by hand and hope it doesn't get forgotten. This build adds that missing piece: a "report this" action any of the eight trained searchers can take on a conversation, right where they found it. The moment they do, that conversation disappears from search for everyone — not just for them — until a designated admin has actually looked at it and made a call. An email goes out immediately to Rincon's director of operations so it doesn't sit unnoticed. And the whole thing — who reported it, when, why, what was decided, and by whom — is written permanently to the same audit trail every other decision in this system already goes through.

## How It Works

1. **A searcher is looking at a conversation in Archive Search and something looks wrong** — not "this mentions a wheelchair," which counsel's opinion is explicit is not by itself something to report, but something that reads like actual discriminatory treatment or an inappropriate use of someone's protected information.
2. **They click "Report a Fair Housing concern"** (once the search results/message-view screen itself exists — see Section 2's honest caveat) and write a short, required reason in their own words — what they saw and why it concerns them, not a copy-paste of the correspondence itself.
3. **The conversation is immediately pulled from search — for every one of the eight people, not just the reporter.** The system doesn't wait for anyone to confirm the report is valid first; the same conversation search already returns just a moment ago will come back empty on the very next query, for anyone.
4. **An email goes out right away** to Rincon's director of operations — the same email address, and the same underlying send mechanism, this Hub already uses for the Security Deposit tool's own case-escalation emails — saying a conversation has been reported, by whom, and why, with a link back into this tool's admin export and a direct link to the conversation in Missive.
5. **The report itself is permanently recorded**, separately from any of the system's own automated Fair Housing decisions — this never rewrites what the AI screening check originally decided about that conversation.
6. **An admin reviews it** — the same `'admin'` population that already reviews the AI's own flagged conversations and the held/privileged bucket — and makes one of two calls: it's a real concern (the conversation stays out of search, permanently, as its own recorded fact), or it's not (search access is restored). Either way, the decision, the reviewer, and their reasoning are permanently logged.
7. **Nothing about this changes how the AI screening check itself works.** This is a release valve layered on top of it for the cases a searcher's own judgment catches that the automated check didn't — exactly the role counsel's opinion assigns to human judgment (Section 3 of that opinion), not a redesign of the check.

## What You'll See

A "Report a Fair Housing concern" action wherever search results are shown (once that screen exists), asking for a short written reason. The moment it's submitted, that conversation is gone from search — for everyone — and stays gone until someone with admin access has reviewed it and made a call. As the admin, you'll see a downloadable list of everything that's been reported, with the actual message text so you can judge it, who reported it and why, and a place to mark each one "confirmed — stays out of search" or "false alarm — safe to search again," with your own reasoning recorded next to the report. You (or whoever holds the director-of-operations email) will also get an email the moment anything is reported — this isn't something that waits for someone to remember to check a list.

## What Could Go Wrong

- **A searcher over-reports something that isn't actually a problem**, pulling a genuinely harmless conversation out of search until an admin gets to it. This is the deliberate, accepted cost of the design recommended in Section 6 — the same "erring toward caution costs a bounded admin review, not a Fair Housing violation" trade-off this project has already made twice (`protected-class-terms.js`'s own recall-oriented design; the Option B wide-net's own "erring toward inclusion... costs money, not accuracy" reasoning) — and it is fully reversible with one admin action.
- **The director-of-operations email fails to send** (mail server hiccup, `GMAIL_APP_PASSWORD` misconfigured) and nobody notices a report came in until an admin happens to open the review export. Mitigated the same way Security Deposit's own escalation route already handles this exact failure mode (Section 5) — a second, separate failure-alert email, and the API response itself honestly reports whether the notification actually sent rather than assuming it did. Not eliminated (a hard mail outage would still delay notice), but the report itself is never lost — it is written to the database and the audit log before any email is attempted.
- **An admin resolves a report too quickly, with a low-effort reason, to make it go away.** Same mitigation this project already applies to the comparable override decision (`archive-search-flagged-review-spec.md`, Section 5) rather than a new one invented here: a required, permanent, attributed reason, full audit-log coverage, and folding a spot-check of resolution reasons into whatever periodic review cadence this project already recommends — not a second approver. Section 6 explains why.

---

## 1. Who Can Report, Who Reviews, Who Is Notified

**Who can report: `'searcher'` or `'admin'` for `tool = 'archive_search'` — the full population, not admin-only.** This is a deliberate departure from `archive-search-flagged-review-spec.md`'s own population (that spec's override action is admin-only). The reason is textual, not a judgment call: counsel's own Section 7 says *"If a search result appears to contain a material Fair Housing concern, **the employee** should stop relying on that information... and escalate"* — "the employee," not "the admin." The whole value of this mechanism is catching what a person actually reading correspondence notices, and per `archive-search-v1-scope.md`, all eight people who can search at all are the same Fair-Housing-trained population counsel's opinion already trusts with professional judgment (Section 4 of that opinion) — there is no principled reason to let seven of the eight see something concerning and be unable to act on it themselves.

**Who reviews and resolves a report: `'admin'` for `tool = 'archive_search'` — same population, same reasoning, as every other review action this tool already has** (the validation sample, the held bucket, the flagged-conversation override). No narrower or wider population is recommended; see Section 6 for why a second approver is not recommended either.

**Who is notified: the director of operations, via `DO_EMAIL`** — Section 5. **Flagged honestly as an Open Item, not decided here:** counsel's Section 7 says "the designated manager/compliance person," and this document assumes that's the director of operations because `DO_EMAIL` is the real, already-configured address this exact Hub already uses for the two structurally closest existing escalation flows (Security Deposit, Insurance). If Peter or Mason wants a different or additional recipient — Peter himself, outside counsel's intake, a distinct compliance address — that is a one-line change to Section 5, not a redesign.

---

## 2. The Report Action's Real Dependency — Honest, Not Glossed Over

**This document can be built and shipped in full — schema, the report/review/resolve routes, the notification email — with zero dependency on the search UI existing.** All three routes take `missive_conversation_id` and `mailbox_key` as plain input, exactly like `archive-search-flagged-review-spec.md`'s own override route already does; nothing about them requires a rendered search results page to exist first.

**What genuinely does depend on the search UI: the searcher ever having a "Report a Fair Housing concern" button to click at all.** Per `router.js`'s own header comment, `GET /api/archive-search?q=...` and `GET /api/archive-search/message/:id` — the actual search-results and message-view routes — are named in the original technical spec's "Routes Needed" but deliberately not yet built, gated behind the Finding 5 validation sample clearing with zero confirmed misses. Until one of those exists, there is no screen for a searcher to be looking at a conversation on in the first place, so the report route this document specifies, however complete, has no real caller. **This is not a reason to defer this document** — counsel's safeguard #5 is a condition of the Option B redesign generally, not of the search UI specifically, and building the mechanism now means it is simply ready and wired the moment Tron's search UI does ship, rather than a second, later scramble. Named here explicitly, the same honest-dependency discipline `archive-search-flagged-review-spec.md`'s own Section 2 already applies to its UI recommendation.

**One concrete, minimal near-term need this creates for whoever eventually builds the search UI:** the report action needs the current `missive_conversation_id` and `mailbox_key` for whatever result the searcher is looking at — both values the search-results route will already have to return per-row for the message-view route to work at all, so this adds no new data requirement to that future UI, only one new button and one new short-text prompt.

---

## 3. The Escalation Mechanism — Pull First, Review Second

### 3.1 The core design decision, and why: immediate, structural exclusion, not a passive flag

**The task's own open question: does a reported conversation get pulled from search immediately, pending review, or does it stay visible until an admin acts?**

**Recommendation: pulled immediately, structurally, the moment the report is submitted — for every searcher, not just the reporter — via the same kind of additive `WHERE`-clause change to `missive_message_intake_search_safe` this project has already used twice.**

Reasoning, not assertion:

- **This project's own structural philosophy already treats "possibly a Fair Housing problem" as "excluded by default until a human affirmatively says otherwise."** That is exactly what `screening_result = 'flagged_protected_class'` already means for the AI's own check, and exactly what `archive-search-flagged-review-spec.md`'s override mechanism exists to reverse only when a human deliberately decides to. A report from a trained searcher is, if anything, a *stronger* signal than an automated keyword/AI hit — it is a specific, considered human judgment call, not a probabilistic classifier's guess. Treating it with a *lighter* default than the AI's own flag would be an inconsistent, harder-to-defend design, not a more careful one.
- **Counsel's own words are about reliance, and the only way to guarantee the whole searcher population — not just the one person who noticed — stops relying on it is structural, not advisory.** Section 7 of the opinion says the employee who spots it should personally stop relying on the information. That is a real, necessary instruction, but it only protects against *that one employee's* future reliance. Leaving the conversation searchable while a report sits in a queue does nothing to stop the other seven people from encountering and relying on the same content in the meantime — the exact outcome the escalation mechanism exists to prevent. A structural pull closes that gap for everyone, immediately, at essentially zero engineering cost (Section 3.2).
- **It is cheap and fully precedented — the same additive predicate pattern, used a third time on the same view.** `missive_message_intake_search_safe` already carries one base predicate (`screening_result = 'clear'`) and one additive inclusion clause (the override `EXISTS`, from the flagged-review-spec). This document adds one additive *exclusion* clause — the mirror image, subtracting rather than adding — using the identical `EXISTS`/`NOT EXISTS`-against-a-small-table mechanism, not a new kind of check.
- **It is fully reversible, at a bounded, already-accepted cost, if the report turns out to be a false alarm.** Exactly the same cost this project has already accepted for the AI's own false positives (one admin review, one written reason, restored) — see Section 6 for why no additional friction beyond that is recommended here either.

**What immediate pull does *not* do:** it does not touch `screening_result`, `screening_category`, `screening_tags`, `screening_version`, or `screening_completed_at` on `missive_message_intake` — identical, non-negotiable discipline to the flagged-override spec's own Section 3.1, restated here because it is the same table this mechanism must not touch either. The AI's own screening determination for that conversation is completely unaffected and untouched by a human report existing; this is a second, independent fact laid on top, exactly the same relationship the override table already has to the base table.

### 3.2 Schema (for Neo — this document proposes the design; Neo owns the actual migration)

A new table, distinct from `archive_search_flagged_overrides` because the fact it records is a different kind of event — a proactive human report, not a correction of an AI determination — with its own lifecycle (`open` → `confirmed` or `false_alarm`, never back to `open`).

```sql
-- ============================================================
-- NEW TABLE: archive_search_escalations
--
-- One row per human report of a suspected material Fair Housing concern
-- encountered while using Archive Search (compliance/archive-search-
-- fair-housing-outside-counsel-opinion.md, safeguard #5). NOT the same
-- mechanism as archive_search_flagged_overrides (which corrects a false-
-- positive AI flag) — this records the opposite-direction fact: a human
-- proactively reporting a concern the AI check did not (or has not yet)
-- caught.
--
-- Deliberately does NOT touch missive_message_intake at all — same
-- discipline as archive_search_flagged_overrides. A row existing here,
-- with status IN ('open','confirmed'), is what makes
-- missive_message_intake_search_safe stop returning the conversation
-- (see the view change below) — never a write to the base table.
-- ============================================================

CREATE TABLE IF NOT EXISTS archive_search_escalations (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Same compound identity convention as archive_search_flagged_overrides
  -- and missive_message_intake_held_review_safe/_flagged_review_safe — a
  -- conversation id is unique only within a mailbox (technical spec's own
  -- Finding-1-adjacent precedent; flagged-review-spec Section 3.4).
  missive_conversation_id   TEXT        NOT NULL,
  mailbox_key               TEXT        NOT NULL,

  -- The report itself.
  reported_by               TEXT        NOT NULL,
  reported_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  escalation_reason         TEXT        NOT NULL
    CHECK (length(trim(escalation_reason)) > 0),

  -- Lifecycle: 'open' until an admin resolves it one of two ways. Never
  -- reverts to 'open' once resolved — a re-report after a resolution
  -- gets its own new row (see the partial unique index below), same
  -- "never edit history, add a new row for new state" discipline
  -- archive_search_validation_sample.sample_run already uses.
  status                    TEXT        NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'confirmed', 'false_alarm')),

  resolved_by               TEXT,
  resolved_at               TIMESTAMPTZ,
  resolution_notes          TEXT,

  -- Same "all-or-nothing together" discipline as
  -- archive_search_flagged_overrides' revocation-fields-together CHECK:
  -- either still open (all three NULL) or resolved (all three set, with
  -- a real, non-empty reason).
  CONSTRAINT archive_search_escalations_resolution_fields_together
    CHECK (
      (status = 'open' AND resolved_by IS NULL AND resolved_at IS NULL AND resolution_notes IS NULL)
      OR
      (status IN ('confirmed', 'false_alarm') AND resolved_by IS NOT NULL
       AND resolved_at IS NOT NULL AND resolution_notes IS NOT NULL
       AND length(trim(resolution_notes)) > 0)
    )
);

-- Prevents a double-submit (or two different searchers independently
-- reporting the same still-open conversation) from producing two
-- redundant open rows for the one conversation — a genuinely NEW report
-- after a prior one is resolved gets its own row, since the partial
-- index only applies WHERE status = 'open'.
CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_search_escalations_one_open_per_conversation
  ON archive_search_escalations (missive_conversation_id, mailbox_key)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_archive_search_escalations_reported_at
  ON archive_search_escalations (reported_at DESC);

ALTER TABLE archive_search_escalations ENABLE ROW LEVEL SECURITY;
-- RLS enabled, zero permissive policies — same default as every table in
-- this schema; access is gated in application code
-- (requireArchiveSearchAccess to report, requireArchiveSearchAdmin to
-- review/resolve), not by RLS.

COMMENT ON TABLE archive_search_escalations IS
  'A human report of a suspected material Fair Housing concern encountered while using Archive Search (compliance/archive-search-fair-housing-outside-counsel-opinion.md, safeguard #5). Distinct from archive_search_flagged_overrides, which corrects a false-positive AI flag in the opposite direction. A row with status IN (''open'',''confirmed'') makes missive_message_intake_search_safe stop returning the conversation immediately — never by writing to missive_message_intake itself. status is one-way: open -> confirmed or open -> false_alarm, never back to open; a later new report on the same conversation gets its own fresh row.';

COMMENT ON COLUMN archive_search_escalations.escalation_reason IS
  'Required, non-empty (CHECK-enforced). Same guidance as archive_search_flagged_overrides.override_reason: describe what concerned you and why — do not quote or paraphrase the flagged correspondence itself into this field.';

COMMENT ON COLUMN archive_search_escalations.status IS
  'open: reported, pending admin review — the conversation is excluded from search. confirmed: an admin determined this is a real concern — stays excluded from search, permanently, as its own recorded fact (mirrors how screening_result = ''flagged_protected_class'' with no override already works, without ever touching that column). false_alarm: an admin determined this was not a real concern — the conversation reappears in search on the very next query once this status is set, with no further action needed, exactly the same "no separate cleanup step" mechanic archive_search_flagged_overrides.revoked_at already documents for its own reversal case.';

COMMENT ON COLUMN archive_search_escalations.resolution_notes IS
  'Required, non-empty once resolved. Same restraint as escalation_reason and (in archive_search_flagged_overrides) override_reason/revocation_reason: describe the disposition and why, do not quote the correspondence itself.';


-- ============================================================
-- MODIFIED VIEW: missive_message_intake_search_safe
--
-- One further additive change, on top of archive-search-flagged-review-
-- spec.md's own addition. That spec added an inclusion clause (OR EXISTS
-- ... override). This adds an exclusion clause (AND NOT EXISTS ...
-- escalation) that applies REGARDLESS of screening_result or any
-- override — an escalated conversation is pulled from search even if it
-- was previously 'clear', and even if it was previously flagged AND
-- already overridden. security_barrier = true unchanged.
-- ============================================================

CREATE OR REPLACE VIEW missive_message_intake_search_safe
WITH (security_barrier = true) AS
SELECT *
FROM missive_message_intake m
WHERE (
    m.screening_result = 'clear'
    OR EXISTS (
      SELECT 1
      FROM archive_search_flagged_overrides o
      WHERE o.missive_conversation_id           = m.missive_conversation_id
        AND o.mailbox_key                       = m.mailbox_key
        AND o.overridden_screening_completed_at = m.screening_completed_at
        AND o.revoked_at IS NULL
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM archive_search_escalations e
    WHERE e.missive_conversation_id = m.missive_conversation_id
      AND e.mailbox_key             = m.mailbox_key
      AND e.status IN ('open', 'confirmed')
  );

COMMENT ON VIEW missive_message_intake_search_safe IS
  'The ONLY view every archive-search search/message route may query — never missive_message_intake directly, with the one named exception of screening-pass.js. Extended twice: archive-search-flagged-review-spec.md added the override inclusion clause; archive-search-escalation-mechanism-spec.md added this exclusion clause — a conversation with an open or confirmed entry in archive_search_escalations is excluded from this view immediately, regardless of screening_result or any override on file. Resolving an escalation as false_alarm removes the exclusion on the very next query, with no separate cleanup step.';
```

**No change needed to `test/no-raw-table-access-check.js`.** This document adds no new file that reads `missive_message_intake` by name — the one raw-table read it needs (Section 3.3's export route's `body_text`) is added to `screening-pass.js`'s own already-exempt module, exactly like `fetchFlaggedEarliestBodyTextByConversation()` already was.

### 3.3 Routes

- **`POST /api/archive-search/escalate`** — `requireArchiveSearchAccess` (the full `'searcher'`+`'admin'` population, per Section 1). Body: `{ missive_conversation_id, mailbox_key, reason }`, all required.
  1. Confirm the conversation is currently visible via `missive_message_intake_search_safe` for that `(missive_conversation_id, mailbox_key)` pair — if it isn't (already held, already flagged with no live override, or already escalated), 404: nothing to report that this tool would have shown the searcher in the first place.
  2. Validate `reason` non-empty after trimming (400 if not; the table's own `CHECK` is the backstop).
  3. Insert into `archive_search_escalations` (`status: 'open'`). A `23505` unique-violation (the partial index) means this exact conversation already has an open report — return 409 with a clear message, same handling `flagged/:conversationId/override` already uses for its own unique-violation case, not a 500.
  4. Write `archive_search.escalation_reported` (Section 4).
  5. Send the director-of-operations email (Section 5); include `notification_email_sent: <bool>` in the response, per the honesty discipline named in Section 5.
  6. Return success. `missive_message_intake_search_safe` excludes this conversation starting with the very next query — no further step.

- **`GET /api/archive-search/escalations-review-export`** — `requireArchiveSearchAdmin`. CSV of every row in `archive_search_escalations`, ordered by `reported_at DESC`: `reported_at`, `reported_by`, `escalation_reason`, `missive_conversation_id`, `mailbox_key`, `status`, `resolved_by`, `resolved_at`, `resolution_notes`, plus `body_text` for the conversation's earliest message and a Missive deep link — the same "the reviewer needs the real content to judge it" reasoning `flagged-review-export`/`validation-sample-export` already establish. `body_text` fetched via a small, generalized sibling of `fetchFlaggedEarliestBodyTextByConversation()` in `screening-pass.js` (keyed off the escalations table's own `(conversation, mailbox)` pairs instead of `screening_result = 'flagged_protected_class'` — Q's implementation choice whether to generalize that existing function to accept an explicit id list or add a second, narrowly-scoped one beside it; either satisfies the guardrail, since both live inside the one already-exempt file). Logs `archive_search.escalation_review_export_generated` (Section 4).

- **`POST /api/archive-search/escalations/:id/resolve`** — `requireArchiveSearchAdmin`. Body: `{ resolution, resolution_notes }`, `resolution` one of `'confirmed'`/`'false_alarm'`, both required.
  1. Read the existing row by `id`; 404 if missing, 409 if `status !== 'open'` (already resolved — same "lost the race / already handled" handling `flagged-override/:overrideId/revoke` already uses, including the same `.eq('status','open')`-in-the-update-filter race-close pattern that route's own revoke action uses for `revoked_at IS NULL`).
  2. Validate `resolution_notes` non-empty (400 if not).
  3. Update `status`/`resolved_by`/`resolved_at`/`resolution_notes` together, filtered on `status = 'open'` to close the same concurrent-request race window `flagged-override/:overrideId/revoke` already closes for its own update.
  4. Write `archive_search.escalation_resolved` (Section 4).
  5. Return success. If `resolution: 'false_alarm'`, the conversation reappears in search on the very next query — no further step. If `resolution: 'confirmed'`, it stays excluded, permanently, as this table's own row — no further step either.

---

## 4. The Required Audit Trail

Three events, all reusing `audit_log` exactly as it stands today (no schema change) — every field value confirmed legal against the real, current CHECK constraints (`20260815000000_audit_log_rule1_compliance.sql`), same discipline the flagged-review-spec's own Section 4 already applied.

| Event | `action` | `actor_type` | `entity_type` | `privacy_category` | `risk_level` |
|---|---|---|---|---|---|
| A concern is reported | `archive_search.escalation_reported` | `human` | `archive_search_escalation` | `processing` | `high` |
| A report is resolved | `archive_search.escalation_resolved` | `human` | `archive_search_escalation` | `processing` | `high` |
| The escalations export is pulled | `archive_search.escalation_review_export_generated` | `human` | `archive_search_escalation_export` | `processing` | `medium` |

**`actor_type: 'human'`, always, on all three — hardcoded, never inferred, identical reasoning to `archive-search-flagged-review-spec.md`'s own Section 4.** There is no code path anywhere in this design where an AI process reports a concern, resolves one, or pulls this export — GOVERNANCE.md's Rule 8 Tier 3 and the Fair Housing Standard's Rule 7 describe exactly this class of decision, and this mechanism has no automated actor at any step.

**`risk_level: 'high'` for both the report and the resolution — matching, not exceeding, the ceiling this project already uses for the comparable events** (`screening_flagged_protected_class`, `screening_held`, `flagged_conversation_overridden`, `flagged_override_revoked` are all `'high'`). A human proactively reporting a suspected real Fair Housing concern is at least as consequential as any of those — arguably more, since it is a specific, considered human judgment rather than a probabilistic classifier's guess — and resolving it, in either direction, carries live search-access consequences for up to eight people. `'critical'` is not used, per the same reasoning already given for this exact question in the flagged-review-spec: this project has not used `'critical'` anywhere in this tool, and a documented, reasoned, fully-audited human report or correction is not the more severe category that level should be reserved for.

**`risk_level: 'medium'` for the export pull — same reasoning as `flagged_review_export_generated`'s own `'medium'`, not `held_review_export_generated`'s `'low'`,** because this export deliberately includes real `body_text` (Section 3.3), the "materially wider window into raw correspondence" distinction the technical spec's own Finding 6 already draws.

**`details`, and the same restraint every comparable event in this codebase already applies:**

```json
// archive_search.escalation_reported
{
  "escalation_id": "<uuid>",
  "missive_conversation_id": "...",
  "mailbox_key": "...",
  "reported_by": "<name>",
  "escalation_reason": "<the reporter's own written text>",
  "notification_email_sent": true
}
```

```json
// archive_search.escalation_resolved
{
  "escalation_id": "<uuid>",
  "missive_conversation_id": "...",
  "mailbox_key": "...",
  "resolution": "confirmed" | "false_alarm",
  "resolution_notes": "<the reviewer's own written text>"
}
```

**Never logged: any excerpt of `body_text`/`subject`, or a description of the specific protected characteristic involved beyond what the reporter/reviewer chose to write in their own reason/notes.** Identical restraint to Finding 1's own rule for the AI's flags and the flagged-override spec's identical rule for override/revocation reasons — `escalation_reason`/`resolution_notes` are the one piece of free text these events carry, on the same already-approved reasoning: the reporter's/reviewer's own authored explanation of their judgment is not the same category of sensitive content as the underlying correspondence, provided (per each column's own comment, Section 3.2) they don't quote it in.

---

## 5. Notification — a Real, Already-Wired Channel, Not a Placeholder

**Correcting the premise this task was given, with a concrete finding, not a restatement of it:** the task cites the earlier, real finding that "notify Mason" had no real channel to use, evidenced by `router.js`'s own `mason_notification_required: true` / `mason_notification_status: 'not_sent_no_channel_implemented'` placeholder (lines 647–648, 735–736). **That finding is correct as far as it goes — no chat or real-time-messaging system exists anywhere in this Hub — but it is not the whole picture.** A real, already-configured, already-used **email** notification channel exists in this exact codebase: `projects/hub/security-deposit/router.js` and `projects/hub/insurance/router.js` both already implement `createMailer()` via `nodemailer` against `process.env.GMAIL_USER`/`GMAIL_APP_PASSWORD` (both already required, top-level Hub environment variables per `server.js` line 140), and both already send a real email to `process.env.DO_EMAIL` the moment something is escalated for human review — Security Deposit's own `POST /api/security-deposit/cases/:id/escalate` is structurally the closest thing in this whole codebase to what this document needs.

**Recommendation: reuse that exact pattern, not the placeholder pattern, and not a new invented channel.**

1. **`archive-search/router.js` gains its own small `createMailer()`/`sendEscalationEmail()`/`sendFailureAlertEmail()` trio**, copied in shape (not shared as a module) from `security-deposit/router.js`'s own implementation — matching this codebase's own established convention (`router.js`'s Section 2 comment: "sibling implementation, same reasoning every other router.js in this codebase gives for its own copy") of each tool keeping its own small mailer/audit-log helpers rather than a shared library.
2. **On `POST /api/archive-search/escalate` success, send one email to `process.env.DO_EMAIL`**: who reported it, when, their written reason (not the correspondence itself), the Missive deep link (`missiveConversationLink()`, already exported), and a note to open the escalations review export in the Hub for the full record. Subject line in the same shape Security Deposit's own escalation email already uses (e.g. `Archive Search: Fair Housing concern reported — needs your review`).
3. **If the mailer is unavailable or the send fails, follow Security Deposit's own exact honesty discipline**: report `notification_email_sent: false` in the API response (never silently folded into `success: true`), and fire a second, separate failure-alert email via `sendFailureAlertEmail()` if the mailer itself is reachable, so a mail-server-level outage doesn't also silence the alert that the primary notification didn't go out. The underlying report is never lost either way — it is written to `archive_search_escalations` and `audit_log` before any email is attempted, exactly like Security Deposit's own case-escalation write is committed before its notification email is sent.

**What is genuinely still an open question, honestly, not resolved by finding this channel: whether `DO_EMAIL` is the right recipient for *this specific* content.** `DO_EMAIL` is Rincon's real, already-used address for "a human needs to review something a staff member escalated" in two other tools — but those two tools' escalations aren't Fair-Housing-adjacent. This document recommends `DO_EMAIL` as the best available match for counsel's "designated manager/compliance person" language, because it is the one real, already-configured address this Hub already treats as exactly that role — but Peter should confirm whether he wants this to go to himself specifically, to the DO, to both, or to a distinct address, before this ships. Named as Open Item 1.

**What is not recommended, and why: a real-time chat notification (Slack, SMS, or similar).** That infrastructure genuinely does not exist anywhere in this Hub today, and building it would be a real, separate piece of new infrastructure this task explicitly asked to be honest about rather than assume. Email, unlike chat, is infrastructure this Hub already has, already configured, already used for the identical purpose (a human needs to know something was escalated) — so it satisfies safeguard #5's own words ("provide an employee escalation mechanism") without inventing anything new. If Peter later wants faster-than-email notice (a text to his own phone, for instance), that is real, separate, additional scope, named honestly as Open Item 2 rather than built quietly into this document.

---

## 6. A Real Governance Question — Guardrails Against Over-Reporting or Under-Review

**The question, stated plainly, mirroring the flagged-review-spec's own Section 5 for the comparable question on the other mechanism:** should anything beyond a required written reason and a full audit trail stop (a) a searcher from reporting things that aren't real concerns, effectively giving eight people a way to pull any conversation from search, or (b) an admin from clearing every report with a low-effort, boilerplate resolution note?

**Recommendation: no rate limit on reporting, no second-approver requirement on resolution — trust both populations' judgment, consistent with how this project has already decided every comparable question, for the same reasons `archive-search-flagged-review-spec.md`'s Section 5 already gives and does not need to re-argue from scratch:**

- **This project has never required dual control for a comparable human decision**, and a rate limit on reporting would be a genuinely new kind of restriction this project has not applied to any comparable action — the closest analog, `security-deposit`'s own case-escalation route, has no rate limit either.
- **GOVERNANCE.md's own language describes a single human deciding, not a panel or a quota** — Rule 8 Tier 3, the Fair Housing Standard's Rule 7 ("a person decides and owns the decision," singular). Nothing in either rule contemplates limiting how often a person may raise a concern.
- **The real, already-recommended lever is after-the-fact visibility, not a real-time gate — and this design already has it, structurally, twice over:** every report is a permanent row plus a permanent `audit_log` event; every resolution is the same. "How often is this being used, by whom, and does the pattern of resolutions look right" is fully answerable at any time without building anything new, exactly the same answer the flagged-review-spec's own Section 5 already gives for the comparable override question.
- **A cost asymmetry actually favors erring toward easy reporting, not against it.** An over-report costs one bounded admin review (Section 3.1) and briefly removes one conversation from search for the small population that can already see it in Missive directly for seven of the eight people (`archive-search-v1-scope.md`'s own Section 4/7 finding). An under-report — a searcher hesitating to flag something because the action feels heavyweight or rate-limited — costs the entire point of safeguard #5. Given that asymmetry, adding friction to reporting would be optimizing for the wrong failure mode.

**One concrete, low-cost recommendation, reusing existing machinery rather than inventing new machinery — identical in shape to the flagged-review-spec's own Section 5 recommendation:** fold a review of escalation usage (how many reports, how many confirmed vs. false-alarm, whether resolution reasons look substantive) into whatever periodic re-validation cadence this project already recommends for the underlying screening pass (technical spec's Open Item 7). This adds no new mechanism and no new schedule — it is a recommendation for Peter/Asimov/Mason to confirm, not something this document treats as already decided (see Open Items).

---

## 7. Confirmed Non-Interactions, Stated Explicitly Rather Than Left Implicit

**The retention/deletion clock (technical spec Finding 9) is unaffected by this build, for the identical reason the flagged-review-spec's own Section 7 already gives for the override mechanism.** This document never touches `screening_result` or `pipeline_status`, so it cannot and does not change the 4-year CCP §337 clock in either direction — a `'confirmed'` escalation excludes a conversation from search, exactly like an un-overridden AI flag already does, without granting it the permanent legal hold only `'held'` rows get.

**This document does not require its own new AI Risk Assessment**, for the same reason the flagged-review-spec's Section 7 already gives: it introduces no new AI decision-making of any kind. Every report and every resolution is, by design and by Section 4's hardcoded `actor_type: 'human'`, a human act.

**This document is independent of the Option B wide-net redesign currently under separate review** (`archive-search-fair-housing-option-b-spec.md`) — exactly the same structural independence that spec's own Section 6 already claims for itself relative to this project's screening mechanism generally. Whether a conversation ends up searchable because it was never flagged at all, because Option B's wide net skipped it, or because it was flagged and later overridden, this mechanism's report/exclude/resolve logic operates identically: any conversation currently visible in `missive_message_intake_search_safe`, regardless of why, can be reported, and reporting it excludes it the same way regardless of why it was visible in the first place.

---

## Data Inventory (GOVERNANCE.md Rule 4)

Structured identically to `archive-search-flagged-review-spec.md`'s own Data Inventory section — full inventory, since `archive_search_escalations` is a brand-new table.

**`archive_search_escalations` — the only new table this document adds. Full inventory:**

- **`pii_fields`:**
  - `escalation_reason`, `resolution_notes` — free text written by a human describing a suspected Fair Housing concern and, later, its resolution. Same caveat as `override_reason`/`revocation_reason` on `archive_search_flagged_overrides`: not about a third party by design (each column's comment instructs against quoting the flagged correspondence), but still personal data — the reporter's/reviewer's own authored judgment, tied to their name.
  - `reported_by`, `resolved_by` — a staff member's name/email, identifying who reported and who resolved. Personal data, but — following `maintenance_claims.reviewed_by`'s and `archive_search_flagged_overrides.overridden_by`/`revoked_by`'s own already-approved precedent — these are the accountability mechanism itself, not incidental collection. See `ccpa_deletable` below.
  - `missive_conversation_id`, `mailbox_key` — an indirect pointer into `missive_message_intake`, this schema's highest-PII-density table, same caveat `archive_search_flagged_overrides`' identical two columns already carry.
  - `status`, `reported_at`, `resolved_at` — not personal data by themselves, but load-bearing metadata for which decision this row documents and when.

- **`agents_with_access`:** NONE. No AI agent, LLM call, or extraction step reads or writes this table — every row is written by a human, through the report route (`requireArchiveSearchAccess`) or the resolve route (`requireArchiveSearchAdmin`). Reads: the `'admin'` population, via the escalations-review-export route, and (via `DO_EMAIL`) whoever holds the director-of-operations email address, in the notification email's own limited content (never `body_text`).

- **`privacy_category`:** `'processing'` — a human decision layered on top of already-collected correspondence, not a new collection event. Applies identically to the resolution fields.

- **`retention_policy`:** kept indefinitely, never deleted — same reasoning as `archive_search_flagged_overrides` and `audit_log`: this table's entire purpose is a permanent record that a concern was raised and how it was resolved, including for a `'confirmed'` row where the resulting search-exclusion is itself meant to be permanent.

- **`ccpa_exportable`:** TRUE — this table plainly holds personal data about identifiable staff members (`reported_by`, `resolved_by`) and their own authored text about a specific, identifiable correspondence record.

- **`ccpa_deletable`:** TRUE for `escalation_reason`/`resolution_notes`, via the same targeted `"[REDACTED]"` redaction convention `archive_search_flagged_overrides.override_reason`/`revocation_reason` already use, preserving `status`, `reported_at`, and `resolved_at` for audit continuity. **NOT deletable/redactable for `reported_by`/`resolved_by`** — same already-approved precedent (`maintenance_claims.reviewed_by`, `archive_search_flagged_overrides.overridden_by`/`revoked_by`) of excluding staff-attribution columns: these identify Rincon's own staff acting in their employment capacity, not a third-party data subject, and redacting them would defeat the accountability purpose of the table.

- **Not CCPA-scannable beyond the redaction convention above** — same standing gap this project's every prior Rule 4 section already names: no CCPA scan list exists yet anywhere in this schema.

**RLS:** enabled on `archive_search_escalations`, zero permissive policies at creation — same default as every table in this schema.

---

## Decisions Recorded — Peter, 2026-09-12

**Notification recipient (Open Item 1, resolved):** both `DO_EMAIL` and Peter's own email. The escalation email fires to both addresses, not a choice between them — Section 5's implementation should send to both, not pick one.

**GOVERNANCE.md Rule 6 shadow-mode period: explicitly waived, by Peter's own decision, not silently skipped.** Asimov's review of this spec classified it as Critical tier (a compliance-logic/guardrail change to `missive_message_intake_search_safe`), which would normally require a 7-day monitored period before being treated as fully trusted. Peter's stated reasoning, on the record: this mechanism only ever acts when a human deliberately clicks report/resolve — there is no automated decision anywhere in the path a shadow period would be monitoring for drift or unexpected behavior. Sent back to Asimov and Mason (below) to confirm this reasoning holds and formally close the gap, rather than treating a business owner's verbal waiver alone as sufficient for a Critical-tier item — same discipline this project has applied to every other Rule 6 decision.

## Open Items — Needs Confirming Before This Gets Built

1. ~~Whether `DO_EMAIL` is the right notification recipient for this specific content~~ — **Resolved above: both `DO_EMAIL` and Peter's own email.**
2. **Whether email notification is sufficient, or whether faster/additional notice (e.g., a text to Peter's own phone) is wanted** (Section 5) — real, separate, additional scope if so; not built here.
3. **Whether a `'confirmed'` escalation should ever be reversible** — this document, like the original flagged-review-spec's first draft, does not build a symmetric "un-confirm" path; a `'confirmed'` row's exclusion is permanent by this design. Flagged the same way that spec's own Open Item 6 was originally flagged, for Mason to decide whether this needs the same kind of revocation path Mason later required for the override mechanism, before or after launch rather than preemptively invented here.
4. **Whether the periodic re-validation cadence already recommended elsewhere (technical spec Open Item 7; flagged-review-spec Open Item 3) should explicitly extend to escalation-usage review** (Section 6) — this document recommends folding it in, consistent with the flagged-review-spec's identical recommendation for override usage, but does not treat this as already adopted.
5. **The generalization (or duplication) of `fetchFlaggedEarliestBodyTextByConversation()`** (Section 3.3) — a small implementation choice left to Q, either way satisfies the raw-table guardrail; named so it isn't discovered mid-build.
6. **How a searcher who already saw a now-excluded (or, if resolved false-alarm, since-restored) conversation is or isn't told anything changed** — the flagged-review-spec's own Open Item 6 named the identical open question for its reversal case and did not resolve it; this document inherits the same open question for both directions of this mechanism and does not resolve it here either.

---

## Ready for Asimov + Mason Review

The real compliance questions this document is asking Asimov and Mason to weigh in on, not deciding unilaterally:

1. **Does immediate, structural, unreviewed exclusion on report — before any admin has looked at it — correctly satisfy safeguard #5** (Section 3.1), or does Mason want a lighter default (visible-but-flagged, pending review) given a report has not yet been confirmed as a real concern by anyone but the reporter?
2. **Is the full `'searcher'`+`'admin'` population the right one to trust with the power to pull a conversation from search unilaterally** (Section 1), given Section 6's recommendation against any rate limit or second-approver requirement on the report action itself — or does Mason want the report action itself gated more tightly than the review/resolution action?
3. ~~Is `DO_EMAIL` an acceptable stand-in...~~ — **Resolved by Peter (see "Decisions Recorded" above): both `DO_EMAIL` and Peter's own email.** Mason: confirm this satisfies counsel's "designated manager/compliance person" language.
4. **Does resolving a report as `'confirmed'` need to feed into anything beyond permanent search exclusion** (Section 3.1/3.2) — e.g., should it also trigger Rincon's standing litigation-hold obligation (technical spec Open Item 6, restated from Mason's own prior review) if the confirmed content plausibly touches anticipated litigation or a regulatory complaint, or is that a separate, human, already-standing obligation this mechanism correctly does not attempt to automate?
5. **NEW — Asimov: confirm Peter's Rule 6 shadow-mode waiver (see "Decisions Recorded" above) is sound**, given this mechanism is 100% human-triggered with no automated decision path, and formally close that gap so it doesn't block the build.
6. **Open Items 2 and 4 above** — real, left to Peter's/Mason's judgment rather than decided in this document.
