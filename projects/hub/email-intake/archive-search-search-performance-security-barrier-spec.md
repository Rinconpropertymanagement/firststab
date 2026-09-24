# Archive Search — Separate Eligible-Content Search Corpus: Concrete Technical Design

**Status:** This is Neo's concrete technical design against Asimov's and Mason's
**CLEARED WITH CONDITIONS** verdicts on the separate-corpus architecture
(`compliance/archive-search-search-performance-security-barrier-asimov-
confirmation.md`, `-mason-confirmation.md`), themselves responding to outside
counsel's `-outside-counsel-opinion.md`. **This document does not authorize Q
to build anything, and it does not authorize applying any SQL below.**
Everything here — the new table, the trigger functions, the reconciliation
job, the audit-log entry — is a design for Asimov to re-confirm against the
*concrete* mechanics (per both confirmations' own condition 3: "Neo designs
the actual mechanism... before Q builds anything"), not the abstract proposal
already cleared. Peter applies every migration himself via Supabase's SQL
Editor, per this project's standing convention (no CLI/DB URL in this
environment) — nothing here is applied by Neo.

**Written by:** Neo. **Date:** 2026-09-24.

**Read in full before writing this, source code directly, not taken on
summary:**
- `compliance/archive-search-search-performance-security-barrier-outside-
  counsel-opinion.md` — the opinion clearing this architecture. Section 4
  ("not perfectly synchronized... reasonable period"), Section 5 (leaving-
  eligibility direction: "expect the system to remove it reasonably
  promptly"), Section 9 (reconciliation as "good engineering practice"),
  Section 10 (proportionate fail-safe behavior), Section 13 (Rincon may hold
  itself to a stricter-than-legal-floor internal bar).
- `compliance/archive-search-search-performance-security-barrier-asimov-
  confirmation.md` — CLEARED WITH CONDITIONS. Section 4's recommended split
  (same-transaction for leaving eligibility; concrete outer-bound number for
  becoming eligible); Section 5's six Rule 6 mechanics, including the Rule 6
  audit entry shape and Tier 1 (Auto) classification, citing the
  layer1-removal precedent by name.
- `compliance/archive-search-search-performance-security-barrier-mason-
  confirmation.md` — CLEARED WITH CONDITIONS, condition 1 split by direction
  (same-transaction for escalation-confirmed/suppression-applied/override-
  revoked stays, full stop; reasonable-period for screening-clears, event-
  driven with reconciliation as backstop, not primary). Condition 5 names
  the 7-day Rule 6 shadow-mode requirement as a new item neither prior
  review had named.
- `compliance/archive-search-search-performance-security-barrier-asimov-
  review.md` and `-mason-review.md` — the real, live EXPLAIN evidence: the
  route's exact query (Postgres 57014 on every call, including "tenant");
  `security_barrier`'s real job (stop a non-leakproof external qual, here
  `@@`, from being pushed into the view's own scan before the exclusion
  logic runs); why dropping `security_barrier` or marking `@@` leakproof are
  both foreclosed on engineering-security grounds independent of the legal
  question.
- `supabase/migrations/20260910030000_archive_search_schema.sql` — the real
  `missive_message_intake` schema (Section B/C: `id UUID PK`, `mailbox_key
  TEXT`, `missive_conversation_id TEXT`, `subject/from_address/body_text
  TEXT`, `delivered_at TIMESTAMPTZ`, `search_document` a `GENERATED ALWAYS
  AS (to_tsvector('english', coalesce(subject,'') || ' ' ||
  coalesce(body_text,''))) STORED tsvector` column, `screening_result` CHECK
  constrained to `('held','flagged_protected_class','clear')` or NULL).
- `supabase/migrations/20260905020000_missive_shared_inbox_intake_schema.sql`
  lines 547–586 — `missive_message_intake`'s real base-table column list and
  types, confirmed directly rather than assumed for the new table's column
  types below.
- `supabase/migrations/20260912030000_archive_search_escalations_schema.sql`
  — the real `archive_search_escalations` schema (`status IN
  ('open','confirmed','false_alarm')`, resolution-fields-together CHECK, the
  partial unique index on `(missive_conversation_id, mailbox_key) WHERE
  status = 'open'`) and its `reopened_at`/`reopened_by`/`reopen_reason`/
  `litigation_hold_attestation` columns (added by
  `20260912040000_add_reopen_to_archive_search_escalations.sql`, superseded
  by `20260912050000_reconcile_20260912040000_timestamp_collision.sql`).
- `supabase/migrations/20260913000000_fix_search_safe_view_union_dedup_cost.sql`
  and `20260918020000_simplify_search_safe_clear_branch_view_remove_
  escalation_antijoin.sql` — real, hard-won precedent this design leans on
  directly: (a) `missive_message_intake_search_safe`'s real, current
  escalation-exclusion predicate (`status = 'open' OR (status = 'confirmed'
  AND reopened_at IS NULL)`), copied byte-for-byte into this design's
  eligibility function below; (b) live, measured proof that a correlated
  `NOT EXISTS` anti-join under `security_barrier` produced a plan that was
  **not stable across repeated identical requests** even against an empty
  exception table — the reason this design never runs a live anti-join
  against `missive_message_intake_search_safe` itself for reconciliation,
  and instead reuses the "fetch the small exception set once, merge
  client-side" pattern `20260918020000` already proved safe (55/55 real
  pages, flat timing) for the significance driver.
- `supabase/migrations/20260924000000_add_covering_index_for_archive_search_
  text_search_route.sql` — today's own migration, read in full, because its
  header contains load-bearing facts this design depends on and does not
  re-derive independently:
  1. **Production's live schema has already diverged from this checkout's
     migration history.** `missive_message_intake_search_safe`'s real,
     live predicate today is `screening_result IN ('clear',
     'flagged_protected_class')` — not the `= 'clear'`-only predicate any
     migration file actually committed to `main`/this branch defines. The
     migration that changed it
     (`20260923000000_archive_search_flagged_release_gate_removal.sql`)
     exists only on the unmerged branch
     `feature/archive-search-flagged-release-gate-removal` (commit
     `b5fe4ae`, Peter, 2026-09-23) — Peter applied it directly via Supabase's
     SQL Editor, independent of git merge state, per this project's standing
     convention. `grep -rl "archive_search_flagged_suppressions"
     supabase/migrations/*.sql` returns nothing in this checkout — confirmed
     directly, not assumed.
  2. **The live view's real predicate, confirmed directly against
     production this session:** `screening_result IN ('clear',
     'flagged_protected_class')` (255,280 visible: 254,494 clear + 786
     flagged), `AND NOT EXISTS` against `archive_search_escalations`
     (open/confirmed-not-reopened), **`AND NOT EXISTS` against
     `archive_search_flagged_suppressions`** — that migration's own line
     ~146 states plainly: "The escalations and flagged_suppressions
     exclusions (both `NOT EXISTS` correlated subqueries in the live view)
     are unaffected by this index either way." This is the ground truth
     this design's eligibility function (Section 2 below) is built against
     — not the older, merged-only definition.
  3. **The `archive_search_flagged_overrides` branch is dead in production**
     — the flagged-release-gate-removal build removed it from the view
     entirely (structurally redundant once Branch 1 covers
     `flagged_protected_class` unconditionally). `router.js` in *this*
     checkout still has the old override-grant/revoke routes
     (`POST /api/archive-search/flagged/:conversationId/override`,
     `POST /api/archive-search/flagged-override/:overrideId/revoke`,
     lines 848–1030) — this is real, flagged application-code drift from
     what's live, not something this design resolves. **This design does
     not sync against `archive_search_flagged_overrides` at all**, because
     it no longer affects search eligibility in production, confirmed
     directly, not by analogy.
  4. A genuinely open, unresolved risk named there and still true here: this
     checkout's migration history is missing a real file production already
     has applied. Recommending, again, that
     `feature/archive-search-flagged-release-gate-removal` get merged — not
     this design's job to fix, named as an Open Item below.
- `projects/hub/archive-search/router.js` lines 186–200 (`writeAuditLog` —
  real signature and defaults), 427–480 (`GET /api/archive-search/search` —
  the actual broken route this design serves), 482–535 (`GET
  /api/archive-search/message/:id` — confirmed **not** in scope, see Section
  1), 1148–1299 (`POST /api/archive-search/escalate` — the real INSERT this
  design's escalation trigger fires on), 1451–1532 (`.../resolve`),
  1534–1682 (`.../reopen` — confirmed directly: reopening a **confirmed**
  escalation makes the conversation **reappear** in search, the opposite of
  what the route name suggests out of context — this design gets that
  direction right per Section 3 below, not by guessing from the name).
- `projects/hub/archive-search/lib/screening-pass.js` lines 211
  (`SCREENING_VERSION`), 290–306 (`markConversationScreened` — the real,
  only write path for `screening_result`, confirmed: `UPDATE
  missive_message_intake ... WHERE missive_conversation_id = conversationId`
  — conversation-grain, not message-grain, matching how this design's
  message-grain corpus table has to fan a single screening write out to
  every message row in that conversation via the trigger, not assume 1:1).
- `projects/hub/archive-search/reset-layer1-removal-310.js` — the real, live
  precedent for a one-time chunked backfill/reset script (measure against
  the live table first, guard-check counts before writing, verify after,
  one Rule 6 `audit_log` entry) and for the exact shadow-mode-substitute
  language Asimov's own confirmation for *that* build used — cited directly
  in Section 7 below, and explicitly distinguished from what this build can
  do instead.
- `GOVERNANCE.md` Rule 6, verbatim: *"Critical (decision criteria,
  compliance logic, permission tiers, guardrails): owner approval + attorney
  review for compliance changes + 7 days shadow mode... Log every change in
  the audit log with previous and new values."*

---

## What This Does

Full-text search (`GET /api/archive-search/search`) is down in production —
every query 500s, Postgres 57014, including common single-word queries. Root
cause, established by Neo's and Mason's earlier reviews today: `security_
barrier = true` on `missive_message_intake_search_safe` exists specifically
to stop a non-leakproof predicate (`search_document @@ tsquery(...)`) from
being pushed into the view's own scan before its exclusion logic
(screening/escalation/suppression) runs — and that protection is exactly
what prevents the planner from using any index shape that would make this
query fast. Today's earlier fix attempt in this same session
(`20260924000000`, a covering index) targeted a different, real, but
narrower bottleneck (sort-before-limit on a common term) and does not touch
this constraint — the barrier's own leakproofness restriction on `@@` is
still live and unaddressed by that migration.

This design does not remove `security_barrier` from `missive_message_intake_
search_safe`, and does not mark `@@` leakproof — both stay exactly as they
are, permanently out of scope, per both today's confirmations' own condition
5/item. Instead, it builds a **second, physically separate table**,
`archive_search_corpus`, containing a live, continuously-maintained copy of
only the rows currently eligible for ordinary search. Because ineligible
content (held, unscreened, escalated, suppressed) is never physically
present in this table, there is nothing for `security_barrier` to have to
protect there — a plain table has no such parameter at all — and the planner
gets full, unconstrained freedom to use a GIN index on `search_document` the
way it always should have been able to. `GET /api/archive-search/search`
moves to read from this new table instead of the original view. Every other
route in `router.js` is unaffected and keeps reading `missive_message_intake_
search_safe` exactly as it does today — this design touches nothing else.

---

## 1. Scope — What This Design Does and Does Not Touch

**In scope:** one new table, three trigger functions maintaining it, one
shared eligibility function, a reconciliation job, and the one query change
in `GET /api/archive-search/search` (named here at design level; not written
by Neo).

**Explicitly out of scope, confirmed by direct reading, not assumed:**
- `missive_message_intake_search_safe` itself — untouched. `security_
  barrier = true` stays. Every other route (`GET .../message/:id`, `POST
  .../escalate`'s own searchability check, the held-review-export, the
  significance driver) keeps reading it exactly as today. These are all
  either plain-equality or point lookups — already fast under `security_
  barrier`, per `20260912040000`'s own header, quoted directly in the
  asimov-review read this morning: "plain equality on built-in scalar
  types... IS marked leakproof." Nothing here needed fixing, and this
  design doesn't touch it.
- `archive_search_flagged_overrides` — confirmed dead in production (see the
  reading list above). Not synced against. If
  `feature/archive-search-flagged-release-gate-removal` is ever reverted,
  this design would need to be revisited — named as an Open Item, not
  silently assumed stable.
- The significance driver's own now-stale `'clear'`-only indexes, flagged
  but explicitly not fixed by `20260924000000`. This design adds one new
  index (Section 5) that happens to close part of that gap as a byproduct,
  but does not touch `significance-pass.js` itself — a distinct, separate
  decision per that migration's own header.
- The already-recommended date-bounded stopgap (asimov-review.md /
  mason-review.md, both: "ship it tonight, it needs none of the above").
  Not shipped as of this session (confirmed: no bounded-date logic exists
  anywhere in the current `GET /api/archive-search/search` route, lines
  427–480, read in full). Recommending this ship independently and
  immediately as interim relief during this build's shadow-mode window —
  see Section 7 — but it is not part of this design and Neo is not building
  it here.

---

## 2. The Corpus: A New Table, Not a Materialized View — and a Single Shared Eligibility Function

**A plain table, not a materialized view.** A materialized view in Postgres
has no row-level `DELETE`/incremental-`UPDATE` primitive — the only way to
change its contents is a full `REFRESH` (or `REFRESH ... CONCURRENTLY`,
which still recomputes the entire backing query, just without blocking
reads while doing it). That is structurally incompatible with the
same-transaction, single-row removal Mason's condition 1 requires — there is
no version of "delete this one row, right now, in the same transaction as
the escalation INSERT" available on a materialized view. A plain table with
row-level `INSERT`/`UPDATE`/`DELETE`, maintained by triggers, is the only
structure that can satisfy that requirement at all, not merely the simplest
one.

**Why a plain table needs no `security_barrier`, and why that isn't a
weaker protection than today's:** `security_barrier` is a view-level storage
parameter; it does not apply to physical tables in the first place. The
question this raises — does removing it create the exact side-channel risk
this whole build exists to avoid? — is the one outside counsel's opinion
answers directly: "if excluded rows are never physically present in the
thing being indexed, there is no row for a timing or error side channel to
expose" (Section 2). That is the actual mechanism here, not an assumption:
`archive_search_corpus` only ever contains rows the eligibility function
below has already determined are eligible — there is no held, unscreened,
escalated, or suppressed row anywhere in this table, ever, for a timing
channel to reveal the existence of. Access is gated exactly the same way
every other table in this schema is gated: `RLS ENABLE`, **zero permissive
policies**, actual access control lives in `requireArchiveSearchAccess`
(`router.js` line 159) against `SUPABASE_SERVICE_ROLE_KEY`, which bypasses
RLS entirely — the same trust model `archive_search_escalations` and
`archive_search_flagged_overrides` already use for the identical reason
(their own migrations say so directly). This table introduces no new trust
boundary; it removes the one performance-hostile mechanism
(`security_barrier`'s pushdown restriction) that was never actually
providing defense against this table's *own* access path in the first
place, because nothing untrusted ever queries it directly.

**One shared eligibility function, reused everywhere — directly answering
Mason's own warning.** Mason's confirmation named the exact failure mode to
avoid: *"Two independently maintained definitions of 'excluded' drifting
apart is a worse, less visible bug class than today's timeout."* Every
trigger below, and the reconciliation job in Section 5, calls exactly one
function — there is no second, hand-copied WHERE clause anywhere in this
design.

```sql
-- ============================================================
-- FUNCTION: archive_search_message_is_eligible
--
-- The SINGLE, canonical definition of "eligible for Archive Search" this
-- entire design uses — every trigger and the reconciliation job (Section 5)
-- calls this function; none of them re-derive the condition independently.
-- Copied BYTE-FOR-BYTE from missive_message_intake_search_safe's real,
-- live predicate, confirmed today against production (20260924000000's own
-- header) — NOT the older, merged-only 'clear'-only definition.
--
-- MAINTENANCE OBLIGATION, stated honestly: if missive_message_intake_
-- search_safe's own definition ever changes again (a new exclusion
-- category, a changed escalation condition), this function must change in
-- lockstep, by hand, in its own migration. There is no mechanism in this
-- design that keeps the two automatically in sync — that would require
-- introspecting the view's own query plan at runtime, which is not
-- something this design attempts. Named here as a real, ongoing
-- maintenance cost, not glossed over.
-- ============================================================
CREATE OR REPLACE FUNCTION archive_search_message_is_eligible(p_message_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT
    m.screening_result IN ('clear', 'flagged_protected_class')
    AND NOT EXISTS (
      SELECT 1 FROM archive_search_escalations e
      WHERE e.missive_conversation_id = m.missive_conversation_id
        AND e.mailbox_key             = m.mailbox_key
        AND (
          e.status = 'open'
          OR (e.status = 'confirmed' AND e.reopened_at IS NULL)
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM archive_search_flagged_suppressions s
      WHERE s.missive_conversation_id = m.missive_conversation_id
        AND s.mailbox_key             = m.mailbox_key
    )
  FROM missive_message_intake m
  WHERE m.id = p_message_id;
$$;
```

**Schema:**

```sql
-- ============================================================
-- NEW TABLE: archive_search_corpus
--
-- One row per missive_message_intake row CURRENTLY eligible for ordinary
-- Archive Search — message-grain, matching missive_message_intake_search_
-- safe's own grain exactly (that view is SELECT m.* FROM missive_message_
-- intake m, not conversation-grain). A row's mere presence in this table IS
-- the eligibility determination — no screening_result/status column is
-- copied here, deliberately: there is nothing to re-check once a row is
-- here, and nothing here that itself needs re-screening.
--
-- Maintained EXCLUSIVELY by triggers (Section 3/4). No application code
-- ever writes to this table directly. This is deliberate, not an oversight:
-- Peter applies fixes/migrations directly via Supabase's SQL Editor,
-- independent of any application code path (see 20260924000000's own real
-- example of exactly this happening for the flagged-release-gate-removal
-- build) — an application-code-only sync hook would silently miss any such
-- write. A database trigger cannot be bypassed by a future code path,
-- an admin script, or a manual SQL Editor fix, short of deliberately
-- setting session_replication_role, which nothing in this codebase does.
-- ============================================================
CREATE TABLE IF NOT EXISTS archive_search_corpus (
  id                        UUID        PRIMARY KEY
                                         REFERENCES missive_message_intake(id) ON DELETE CASCADE,
  mailbox_key               TEXT        NOT NULL,
  missive_conversation_id   TEXT        NOT NULL,
  subject                   TEXT,
  from_address              TEXT,
  delivered_at              TIMESTAMPTZ,
  body_text                 TEXT,
  search_document           tsvector,
  synced_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE archive_search_corpus ENABLE ROW LEVEL SECURITY;
-- RLS enabled, zero permissive policies — same default every table in this
-- schema uses (archive_search_escalations, archive_search_flagged_
-- overrides). Access is gated in application code
-- (requireArchiveSearchAccess), not RLS — see this section's own reasoning
-- above for why that's not a weaker guarantee than the original view.

COMMENT ON TABLE archive_search_corpus IS
  'A live, trigger-maintained copy of ONLY the missive_message_intake rows currently eligible for ordinary Archive Search, per archive_search_message_is_eligible(). Built to replace security_barrier-based query-time filtering for the one query it could never serve efficiently (full-text @@ search) — see projects/hub/email-intake/archive-search-search-performance-security-barrier-spec.md. missive_message_intake_search_safe is UNCHANGED and remains the required view for every other archive-search route (point lookups, escalation checks, exports) — this table serves GET /api/archive-search/search ONLY. Maintained exclusively by triggers on missive_message_intake, archive_search_escalations, and archive_search_flagged_suppressions (never written to directly by application code) plus a periodic reconciliation job (see spec Section 5) that self-heals any drift and enforces the hard subset guarantee: this table''s row set must never be a superset of what missive_message_intake_search_safe would return right now.';
```

**Indexes — deliberately created on the EMPTY table, before backfill runs
(Section 6), which is why neither needs `CONCURRENTLY`:** this table starts
at zero rows; `CREATE INDEX` on an empty table is instantaneous and has no
concurrent writers to block, the same reasoning every brand-new-table index
in this schema's history already gives (`archive_search_escalations`'s own
migration header). This sidesteps the exact `CONCURRENTLY`-on-a-live-250k-
row-table problem `20260924000000` had to solve for — by building the index
first and populating the table after, ordinary index maintenance (not a
one-time bulk build) carries the backfill's cost instead.

```sql
CREATE INDEX IF NOT EXISTS idx_archive_search_corpus_search_document
  ON archive_search_corpus USING GIN (search_document);

-- Same technique 20260924000000 already tried against the original view
-- and reasoned through in full — restated here because it now has room to
-- actually work: with no security_barrier in the way, the planner is free
-- to choose EITHER this covering index (walked backward for delivered_at
-- DESC, @@ evaluated as an in-scan Filter on the INCLUDE column, no heap
-- visit for non-matches) for a common term, OR the GIN index above for a
-- rare/selective term — real planner freedom neither branch of the
-- original view ever had.
CREATE INDEX IF NOT EXISTS idx_archive_search_corpus_delivered_at_covering
  ON archive_search_corpus (delivered_at DESC, id)
  INCLUDE (search_document, mailbox_key, missive_conversation_id);
```

---

## 3. Same-Transaction Removal — "Leaving Eligibility"

**Mechanism: database triggers, not application code — concretely, which
ones, and why triggers specifically (the open question the task asked me to
settle, not leave as "a trigger or app code").** Three real write paths can
make a row leave eligibility, and all three are covered by triggers on the
tables those writes already land on — never a second write application code
has to remember to also make:

1. `archive_search_escalations` — `INSERT` with `status='open'`
   (`router.js` `POST /api/archive-search/escalate`, line ~1236).
2. `archive_search_escalations` — `UPDATE` on a `'confirmed'` row that
   later gets `reopened_at` **cleared**... — **correction, stated
   plainly because it is easy to get backwards from the route name alone,
   and I initially reasoned it backwards myself before re-reading
   `router.js` lines 1534–1682 directly:** reopening a confirmed escalation
   sets `reopened_at`, which makes it **stop** matching the exclusion
   condition (`status = 'confirmed' AND reopened_at IS NULL`) — reopening
   the underlying Fair Housing case makes the conversation **reappear** in
   search. That is a *becoming*-eligible transition, not a leaving one. The
   two real leaving-eligibility transitions on this table are only:
   `open`-insert (item 1 above) and — there is no second one from this
   table alone; `open → confirmed` (resolve-as-confirmed) makes no
   visible change (the row was already excluded while `open`). Restating
   this cleanly: **only the initial `open` INSERT is a leaving-eligibility
   write on `archive_search_escalations`.** `false_alarm` and `reopen` are
   both becoming-eligible writes, handled by the same trigger, in the same
   function, below — the function computes current exclusion state
   symmetrically rather than hard-coding "INSERT only."
3. `archive_search_flagged_suppressions` — `INSERT` (append-only per its
   own design; no other transition exists on this table at all).

**Design choice: one trigger function per source table, symmetric (handles
both directions), and deliberately fail-closed (no exception handling) —
unlike the screening trigger in Section 4.** This is the asymmetry Mason's
confirmation itself draws: these are rare, deliberate, human-initiated admin
actions (an escalation report, a resolution, a reopen, a suppression) — not
a high-volume automated pipeline. Coupling the corpus write tightly to the
same transaction, with no swallowed exceptions, means: if the corpus-side
`DELETE`/`INSERT` cannot be guaranteed, the *entire* escalate/resolve/reopen
action rolls back and the admin sees a `500`, not a `200 OK` masking a
silent gap. That is the concrete, mechanical meaning of Mason's "no lag,
ever, full stop" for this direction.

```sql
-- ============================================================
-- TRIGGER: archive_search_escalations -> archive_search_corpus
-- Fires on every INSERT and UPDATE (covers open-insert, confirmed-resolve
-- [no-op], false_alarm-resolve, and reopen — one function, symmetric,
-- rather than four separately-reasoned-about triggers that could drift
-- apart from each other).
-- ============================================================
CREATE OR REPLACE FUNCTION archive_search_corpus_sync_from_escalation()
RETURNS TRIGGER AS $$
DECLARE
  is_excluding BOOLEAN;
BEGIN
  is_excluding := (NEW.status = 'open')
               OR (NEW.status = 'confirmed' AND NEW.reopened_at IS NULL);

  IF is_excluding THEN
    DELETE FROM archive_search_corpus
    WHERE missive_conversation_id = NEW.missive_conversation_id
      AND mailbox_key             = NEW.mailbox_key;
  ELSE
    -- false_alarm or reopened: re-derive eligibility per-message via the
    -- ONE shared function (Section 2) rather than assuming "not excluding
    -- by this table means eligible" — a message could still be screened
    -- NULL/held, or separately suppressed, and must stay out regardless.
    INSERT INTO archive_search_corpus
      (id, mailbox_key, missive_conversation_id, subject, from_address, delivered_at, body_text, search_document, synced_at)
    SELECT m.id, m.mailbox_key, m.missive_conversation_id, m.subject, m.from_address, m.delivered_at, m.body_text, m.search_document, NOW()
    FROM missive_message_intake m
    WHERE m.missive_conversation_id = NEW.missive_conversation_id
      AND m.mailbox_key             = NEW.mailbox_key
      AND archive_search_message_is_eligible(m.id)
    ON CONFLICT (id) DO UPDATE SET
      subject          = EXCLUDED.subject,
      from_address      = EXCLUDED.from_address,
      delivered_at      = EXCLUDED.delivered_at,
      body_text         = EXCLUDED.body_text,
      search_document   = EXCLUDED.search_document,
      synced_at         = NOW();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- Deliberately NO exception handler — see this section's header above.
-- If this fails, the triggering escalate/resolve/reopen transaction fails
-- with it; the caller gets a real 500, not a silently-incomplete success.

CREATE TRIGGER trg_archive_search_corpus_sync_from_escalation
  AFTER INSERT OR UPDATE ON archive_search_escalations
  FOR EACH ROW
  EXECUTE FUNCTION archive_search_corpus_sync_from_escalation();


-- ============================================================
-- TRIGGER: archive_search_flagged_suppressions -> archive_search_corpus
-- Append-only table, INSERT-only trigger — no reversal branch exists
-- because that table has no revoke path (see the (unmerged) flagged-
-- release-gate-removal-spec.md's own reasoning for why, restated here only
-- as a fact this design depends on, not re-litigated).
-- ============================================================
CREATE OR REPLACE FUNCTION archive_search_corpus_sync_from_suppression()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM archive_search_corpus
  WHERE missive_conversation_id = NEW.missive_conversation_id
    AND mailbox_key             = NEW.mailbox_key;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- No exception handler — same fail-closed reasoning as the escalation
-- trigger above.

CREATE TRIGGER trg_archive_search_corpus_sync_from_suppression
  AFTER INSERT ON archive_search_flagged_suppressions
  FOR EACH ROW
  EXECUTE FUNCTION archive_search_corpus_sync_from_suppression();
```

**Open item, named honestly:** `archive_search_flagged_suppressions` does
not exist in this checkout's migration history at all (see Section 1 /
reading list item on `20260924000000`). This trigger is written against the
column shape from the unmerged branch's own migration
(`missive_conversation_id TEXT`, `mailbox_key TEXT`, both `NOT NULL`) —
confirmed live in production only indirectly, via `20260924000000`'s own
statement that the view already reads it. **Before this migration is
applied, Peter or Asimov should confirm the table's real, live column names
match exactly** — this design does not independently re-verify that table's
schema against production the way `20260924000000` verified the view's
predicate, because this session has no direct database connection either.

---

## 4. Becoming Eligible — The Screening-Pass Direction, With a Concrete Number

**The only high-volume, unattended write path in this design.**
`markConversationScreened()` runs inside the hourly, business-hours-only
screening cron, potentially many conversations per chunk, with a circuit
breaker but no human watching each write. This is the one direction where
coupling corpus-table health tightly to the triggering transaction is the
wrong tradeoff: a corpus-side problem should never be able to stall the
screening pipeline itself, because that pipeline is what the rest of this
system's Fair Housing/privilege protections depend on running reliably.

**Design: same trigger mechanism as Section 3, but the trigger function
catches and swallows its own exceptions, logging a `WARNING` instead of
failing the transaction.** The base-table write (screening pass writing
`screening_result`) always succeeds regardless of corpus-table health. The
corpus insert/update is attempted synchronously, in the same transaction, on
every attempt — in the success case (the overwhelming majority; this table
has no reason to routinely fail), **propagation is exactly 0 seconds,
structurally, not best-effort** — stronger than the "seconds" outer bound
Mason's confirmation anticipated as a target, not merely inside it. This
also covers CCPA redaction (a future capability, not yet built, but already
named in `20260910030000`'s own column comment on `search_document`: it
"recomputes automatically if subject/body_text are ever redacted") — firing
on every `UPDATE`, not narrowly scoped to `screening_result` alone, means a
future redaction of `subject`/`body_text` re-syncs this table's copy
automatically too, with no separate mechanism to build later.

```sql
-- ============================================================
-- TRIGGER: missive_message_intake -> archive_search_corpus
-- Fires on every INSERT and UPDATE — not narrowly scoped to screening_
-- result alone, so a future subject/body_text redaction (search_document
-- recomputes automatically, per 20260910030000's own column comment)
-- re-syncs this table's copy too, with no separate mechanism to build.
-- ============================================================
CREATE OR REPLACE FUNCTION archive_search_corpus_sync_from_message()
RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    IF archive_search_message_is_eligible(NEW.id) THEN
      INSERT INTO archive_search_corpus
        (id, mailbox_key, missive_conversation_id, subject, from_address, delivered_at, body_text, search_document, synced_at)
      VALUES
        (NEW.id, NEW.mailbox_key, NEW.missive_conversation_id, NEW.subject, NEW.from_address, NEW.delivered_at, NEW.body_text, NEW.search_document, NOW())
      ON CONFLICT (id) DO UPDATE SET
        subject          = EXCLUDED.subject,
        from_address      = EXCLUDED.from_address,
        delivered_at      = EXCLUDED.delivered_at,
        body_text         = EXCLUDED.body_text,
        search_document   = EXCLUDED.search_document,
        synced_at         = NOW();
    ELSE
      DELETE FROM archive_search_corpus WHERE id = NEW.id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Deliberately swallowed. See this section's header: markConversation
    -- Screened()'s own write must never fail because of a corpus-table
    -- problem. Any gap left here is caught and self-healed by the
    -- reconciliation job (Section 5) on its own next run.
    RAISE WARNING 'archive_search_corpus_sync_from_message failed for message %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_archive_search_corpus_sync_from_message
  AFTER INSERT OR UPDATE ON missive_message_intake
  FOR EACH ROW
  EXECUTE FUNCTION archive_search_corpus_sync_from_message();
```

**Migration-time locking caveat, named honestly rather than glossed over:**
`CREATE TRIGGER` is DDL and takes a brief `SHARE ROW EXCLUSIVE` lock on
`missive_message_intake` — this is metadata-only and normally fast (it does
not rewrite the table), but it blocks concurrent writers for its duration,
the same class of caution every prior DDL statement against this specific
table has already documented in this schema's migration history (column
additions, constraints). Apply this statement during a lull, not mid-cron-
run — same operational discipline `20260912020000`'s own header already
established for this table, not a new requirement this design invents.

**The concrete number Mason's confirmation asked for, stated plainly:**
primary propagation target is **0 seconds** (same-transaction, structural,
not a queue with a target SLO) — exceeding Mason's own anticipated
"low-single-digit-to-low-double-digit seconds" range for this direction. The
outer-bound backstop, for the rare case a corpus write is caught and
swallowed above, is the reconciliation job's own cadence — proposed at **15
minutes** (Section 5) — worst case, not typical case. I'm recommending the
single unified trigger mechanism over building a genuinely separate
async/queue-based pathway for this direction specifically because: (a) the
corpus-table write here is a single-row upsert against a small, purpose-built
table, nothing like the original bug's cost profile (wide-row `UNION`
dedup, anti-join instability under `security_barrier`) — there's no
performance reason to defer it; (b) one mechanism, reasoned about once, is
simpler than two, which is a real value in this codebase (CLAUDE.md's "keep
it as simple as possible," and this project's own repeated practice of
picking the simpler design when it doesn't cost the correctness the more
complex one would buy). **If Asimov or Mason would rather this direction be
deliberately decoupled from the screening pass's own transaction — e.g., to
further insulate screening reliability from corpus-table health even in the
already-caught-exception case — the fallback is an application-level upsert
called from `markConversationScreened()` right after its own write commits,
target 5 seconds, with the same 15-minute reconciliation backstop.** Stating
both so Asimov has an actual choice rather than one design presented as the
only option.

---

## 5. The Subset-Guarantee Reconciliation Job

**What it queries, concretely, and why it never touches `missive_message_
intake_search_safe` or any correlated anti-join under `security_barrier`
directly.** `20260918020000`'s own live evidence (Section 1's reading list)
already proved a correlated `NOT EXISTS` anti-join under `security_barrier`
produces a plan whose success is **not stable run-to-run**, even against an
empty exception table — running the reconciliation check as a live query
against the barrier'd view itself would import exactly the reliability
problem this whole build exists to get away from, for the one job whose
entire purpose is defense-in-depth. Instead, this job reuses the exact
pattern `20260918020000` already proved safe for the significance driver:
fetch the small exception sets once, compute the eligible set in application
code, never run a live anti-join under the barrier at all.

1. **Corpus's actual current ID set** — paginated, `id`-ordered cursor
   walk of `archive_search_corpus` (a small, single-purpose table; its own
   primary key index serves this directly).
2. **The theoretically-eligible ID set, computed the same way, from three
   independently cheap sources — never derived by querying the view:**
   - `missive_message_intake` `WHERE screening_result IN ('clear',
     'flagged_protected_class')`, `id`-ordered, via a **new partial index**
     this migration also adds (below) — closing, as a direct byproduct, the
     exact gap `20260924000000`'s own "Follow-up worth a separate
     migration" section flagged and deliberately left open (the
     significance driver's indexes are still scoped to `screening_result =
     'clear'` only, now under-scoped since `flagged_protected_class` also
     counts). This design needs the same id-ordered, two-value-predicate
     walk for its own backfill (Section 6) and reconciliation regardless —
     adding the index once serves both, and happens to leave the
     significance driver's own stale-index gap narrower than it found it,
     without this design taking on fixing `significance-pass.js` itself
     (still a separate, deliberate decision, per that migration's own
     header).
   - `archive_search_escalations` — full scan of the open/confirmed-not-
     reopened set (tiny table, by design).
   - `archive_search_flagged_suppressions` — full scan (tiny table, by
     design).
   Combine: `(a) MINUS (conversations excluded by b) MINUS (conversations
   excluded by c)` — the identical logic `archive_search_message_is_
   eligible()` encodes, computed set-wise instead of row-by-row for
   efficiency at reconciliation scale, but never a second, independently
   *written* definition — same source values, same predicate structure.

```sql
-- Follow-up index this design needs for its own backfill/reconciliation
-- id-ordered walk — also directly closes 20260924000000's own named,
-- deliberately-deferred gap for the significance driver (a real, welcome
-- side effect, not this design's primary purpose and not a promise that
-- significance-pass.js itself is updated to use it — that's still Q's
-- separate decision).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_missive_message_intake_eligible_id
  ON missive_message_intake (id)
  WHERE screening_result IN ('clear', 'flagged_protected_class');
-- CONCURRENTLY required here (unlike archive_search_corpus's own indexes,
-- Section 2) because missive_message_intake is a live, 255,000+ row table
-- with an active writer (the hourly screening cron) — same reasoning every
-- prior index built on this specific table already documents. Must be run
-- alone, not pasted alongside any other statement (20260910030000,
-- 20260912020000, 20260922010000's own repeated, hard-won lesson).
```

**Frequency: every 15 minutes**, via the same cron-wrapper infrastructure
pattern already used for the hourly screening pass (Scotty's
`cron-archive-search-screening.sh`, not in git, per that route's own
comment). Reasoning for 15 minutes specifically, stated plainly rather than
asserted: this job is **defense-in-depth against the rare case**, not the
primary sync mechanism (which is same-transaction/0-second, Sections 3–4) —
it exists to catch trigger bugs, a caught-and-swallowed exception in the
becoming-eligible direction, or a write that bypassed the triggers entirely
(should be structurally impossible per Section 2's own reasoning, but this
job is exactly the check that would catch it if that reasoning were ever
wrong). Given the base-table `id`-ordered walk's own measured precedent
(`20260918020000`: 55 real consecutive pages, ~200–330ms flat, ~27,500 rows
per full pass at that rate) scaled to this table's real size (~255,000
rows), a full reconciliation pass should complete in well under a minute —
15 minutes leaves ample headroom without the job's own runs overlapping.
**This number is a proposal, not a certainty** — Asimov/TARS should confirm
real run time before locking it in, and can tighten the interval if that
measured time comes in low.

**On mismatch — proportionate per the opinion's Section 10, not "shut
everything down" by default, and not silent either:**

| Finding | Severity | Response |
|---|---|---|
| Corpus row present that should NOT be eligible (**superset violation** — the one guarantee that must never be true) | `critical` | **Self-heal immediately**: `DELETE` the offending row(s) from `archive_search_corpus` within the reconciliation job's own transaction. Write `audit_log` (`action: 'archive_search.corpus_subset_violation_detected'`, `risk_level: 'critical'`). Send an immediate alert via the existing `sendFailureAlertEmail()` (`router.js` line ~1121, already proven, already hardcoded to `peter@rinconmanagement.com` independent of `PETER_EMAIL` config) — never a silent fix. |
| Superset violation is **systemic** — more than 500 rows in one pass, or any nonzero violation count repeats across two consecutive runs | `critical`, escalated | Everything above, **plus** flip a kill-switch (Section 6's `GET /api/archive-search/search` fallback) so the search route reads from `missive_message_intake_search_safe` directly (slower, but back under the original, still-`security_barrier`-protected guarantee) until a human confirms the corpus is healthy again. This is "temporarily restricting a particular search scope" from the opinion's own Section 10 menu, not a full search outage. |
| Eligible row **missing** from corpus (a lag gap — expected to be rare given same-transaction sync, not expected to be zero given the swallowed-exception path in Section 4) | `medium` | Self-heal: `INSERT` the missing row(s). Log `audit_log` (`action: 'archive_search.corpus_sync_gap_detected'`, `risk_level: 'medium'`). |
| Gap repeats across 2+ consecutive runs (signals the becoming-eligible trigger is failing routinely, not just once) | escalated | Same self-heal, **plus** `sendFailureAlertEmail()` — a repeating gap means Section 4's swallowed exception is masking a real, ongoing problem, not a one-off. |
| Clean run, zero findings | `low` | Still logs one `audit_log` entry per run (Rule 1's "every decision gets logged," applied to "nothing was wrong" too, not only to incidents) — this is also what lets TARS/Peter later confirm the shadow-mode window (Section 7) actually ran clean for real, not just "didn't get an alert." |

---

## 6. Fail-Safe Behavior Per Failure Mode

| Failure mode | Response | Why proportionate (opinion Section 10) |
|---|---|---|
| Escalation/suppression trigger fails (corpus `DELETE` can't complete) | Whole escalate/resolve/reopen/suppress transaction rolls back; caller gets `500` | This is the "no lag, ever" direction — failing the action outright, loudly, is the correct proportionate response; a silent partial success here would recreate the exact leak this build exists to close. |
| Screening-pass trigger fails (corpus `INSERT`/`DELETE` can't complete) | Exception caught, `RAISE WARNING` logged, screening write still commits | "Retrying the update" / accepting a bounded, self-healing gap — proportionate because this is the low-stakes direction (content becoming visible, not staying hidden), and blocking screening entirely over a corpus-table hiccup would be a disproportionate response to a minor sync error, per the opinion's own "a minor synchronization error should not automatically require a company-wide search outage." |
| Reconciliation job itself fails to run (cron failure, script crash) | Alert via `sendFailureAlertEmail()`; do NOT disable search — same-transaction sync (Sections 3–4) is still the live, active guarantee independent of whether the backstop ran | A missed backstop run is not itself a known leak; escalate the alert (not the outage) if reconciliation hasn't completed successfully within a larger bound (proposed: 2 hours) — signals the backstop itself needs attention, not that search does. |
| Isolated superset violation found | Self-heal (delete offending rows) + `critical` audit log + immediate alert | "Temporarily excluding the affected record" — the opinion's own named proportionate option, applied to exactly the record affected, nothing broader. |
| Systemic superset violation (>500 rows, or repeats) | Self-heal + kill-switch fallback to the original `security_barrier`'d view for the search route, until human confirmation | "Temporarily restricting a particular search scope" — not a full outage; search still works, just slower and back under the original protection, until confirmed safe to re-enable. |
| A write to `missive_message_intake`/`archive_search_escalations`/`archive_search_flagged_suppressions` happens outside any application code path this design names (e.g., Peter running a manual fix in Supabase's SQL Editor, this project's own standing convention) | Already covered — triggers fire on the underlying table regardless of which code path or client issued the write; this is a structural property of choosing DB triggers over app-code hooks (Section 3), not something a failure-mode table entry needs to separately guard | N/A — this is the reason triggers were chosen over app-code hooks in the first place, not a residual risk. |

---

## 7. Rule 6 `audit_log` Entry

Written once, at go-live, by the backfill script (Section 8, Q's future
build) — same reasoning `reset-layer1-removal-310.js` already established
for its own `archive_search.rule6_layer1_removed` entry: the entry needs a
*real*, live-measured row count, not one reasoned about ahead of time in
this document.

```js
await supabase.from('audit_log').insert({
  action: 'archive_search.rule6_security_barrier_replaced',
  entity_type: 'archive_search_corpus',
  entity_id: crypto.randomUUID(),
  actor_type: 'human',
  actor_id: 'peter_mckenzie_owner_decision',
  // Tier 1 (Auto)/actor_type='human' classification and actor_id shape
  // follow the layer1-removal precedent directly — Asimov's own
  // confirmation for THIS build (Section 5, item 6) names that precedent
  // as the reasoning to reuse, and (unlike the flagged-release-gate-
  // removal build) no actor_type conflict was flagged for this one.
  risk_level: 'high',
  privacy_category: 'unclassified',
  details: {
    decision: "GOVERNANCE.md Rule 6 Critical-tier change: GET /api/archive-search/search now reads from archive_search_corpus, a separate, trigger-maintained, eligible-content-only table, instead of missive_message_intake_search_safe (security_barrier view). security_barrier is NOT removed from that view — it stays in place, unchanged, and every other archive-search route continues to read it exactly as before. This changes only the enforcement MECHANISM for the one query security_barrier could never serve efficiently.",
    reasoning: "Full-text search was down in production (Postgres 57014 on every query) because security_barrier prevents pushdown of the non-leakproof @@ predicate. Outside counsel's opinion (2026-09-24) approved a separate eligible-content search corpus as a reasonable alternative enforcement mechanism for the same substantive exclusion rule. Asimov and Mason both CLEARED WITH CONDITIONS.",
    decided_by: 'Peter McKenzie, owner',
    reviewed_by: 'Outside counsel (compliance/archive-search-search-performance-security-barrier-outside-counsel-opinion.md); Asimov confirmation, VERDICT: CLEARED WITH CONDITIONS; Mason confirmation, VERDICT: CLEARED WITH CONDITIONS — all 2026-09-24',
    scope: 'GET /api/archive-search/search only. missive_message_intake_search_safe, security_barrier, and every other archive-search route are unmodified.',
    sync_model: {
      leaving_eligibility: 'Same-transaction, trigger-based (archive_search_escalations open-insert; archive_search_flagged_suppressions insert), fail-closed — no lag, per Mason condition 1.',
      becoming_eligible: 'Same-transaction, trigger-based, fail-open/non-blocking (exceptions caught and logged, never block the screening pass). Primary propagation target: 0 seconds, structural. Backstop ceiling: 15-minute reconciliation cadence.',
    },
    subset_guarantee_mechanism: 'Reconciliation job, every 15 minutes, self-healing, never queries missive_message_intake_search_safe directly (reuses the fetch-small-exception-sets-client-side pattern already proven by 20260918020000). Escalates to a search-route kill-switch fallback on systemic violation (>500 rows or repeated).',
    shadow_mode_satisfaction: 'See spec Section 9 — literal 7-day parallel-run shadow mode, not a substitute.',
    previous_mechanism: 'security_barrier view (missive_message_intake_search_safe), query-time filtering — UNCHANGED, still live for every other route.',
    new_mechanism: 'archive_search_corpus — a separate, physically eligible-content-only table, synchronized via database triggers, serving GET /api/archive-search/search only.',
    reference_documents: [
      'compliance/archive-search-search-performance-security-barrier-attorney-question.md',
      'compliance/archive-search-search-performance-security-barrier-outside-counsel-opinion.md',
      'compliance/archive-search-search-performance-security-barrier-asimov-review.md',
      'compliance/archive-search-search-performance-security-barrier-mason-review.md',
      'compliance/archive-search-search-performance-security-barrier-asimov-confirmation.md',
      'compliance/archive-search-search-performance-security-barrier-mason-confirmation.md',
      'projects/hub/email-intake/archive-search-search-performance-security-barrier-spec.md',
    ],
    corpus_row_count_at_migration: null, // filled in live by the backfill script, per reset-layer1-removal-310.js's own precedent — never copied from this document
  },
});
```

---

## 8. Shadow-Mode Satisfaction — A Literal 7-Day Run, Not a Substitute

**GOVERNANCE.md Rule 6, verbatim:** Critical-tier changes require "owner
approval + attorney review for compliance changes + **7 days shadow
mode**." Mason's confirmation flagged this as a real requirement neither
prior review had named.

**The precedent this project already has** (`archive-search-layer1-removal-
asimov-confirmation.md`, Section 5 of this spec's own reading list) used a
**substitute**: a one-time validation sample (pull a real sample of
affected conversations, confirm zero real misses, ship). That was the right
call *for that build*, because a pure logic change (which classifier layer
decides `screening_result`) has no natural artifact to run "in shadow" —
there's no second copy of the decision to compare against a live one without
literally running two classifiers side by side.

**This build is different, and can satisfy Rule 6's literal text, not an
analogy to it:** because the entire design is a second, physically separate,
continuously-synchronized copy of the eligible data, running it in parallel
for a real 7 days **before** switching any real traffic to it is not a
metaphor — it is exactly what "shadow mode" already means everywhere else
this term is used. Concretely:

1. Apply this migration (table, function, triggers, indexes) and run the
   backfill (Section 9) — `archive_search_corpus` is now live, trigger-
   maintained, and reconciled, but `GET /api/archive-search/search` is
   **not yet pointed at it** — the route keeps querying `missive_message_
   intake_search_safe` exactly as it does today (broken, per this session's
   own finding — see the recommendation below).
2. For 7 consecutive days: the reconciliation job (Section 5) runs on its
   full cadence, writing one `audit_log` entry per run regardless of
   outcome. The **zero-unresolved-violations bar**: any `critical` (superset)
   finding during this window must be investigated and explained, not just
   auto-healed and forgotten — the same "zero-confirmed-miss bar" discipline
   the layer1-removal validation sample already established for this
   project, applied here to a live, running system instead of a one-time
   sample.
3. TARS runs a real sample of actual search queries against **both**
   `archive_search_corpus` and `missive_message_intake_search_safe` (via a
   read-only comparison script, not through the broken route) and confirms
   identical result sets, at least once during the window — direct evidence
   the new mechanism enforces the same substantive rule the opinion requires
   (Section 12: "removing a control is not automatically a reduction in
   protection... what protection does the resulting system provide").
4. Only after 7 days clean, Q changes `GET /api/archive-search/search`'s
   one query to read from `archive_search_corpus` instead of `missive_
   message_intake_search_safe`. This is the actual go-live moment the Rule 6
   `audit_log` entry (Section 7) should be dated to, not the migration date.

**Interim relief during the 7-day window, named honestly:** the search
route stays broken (500 on every query) for the entire shadow-mode window
under this plan, because it keeps reading the original view throughout.
Both `asimov-review.md` and `mason-review.md` from earlier today already
recommended shipping the bounded recent-date-window stopgap tonight,
independent of any of this — confirmed not yet shipped (Section 1). **This
is the honest way to give Peter working search sooner without shortening
the shadow window this design otherwise gets for free**: ship the
date-bounded stopgap now (it touches nothing this design or the
`security_barrier` question depends on) as interim relief, run the full,
literal 7-day shadow mode on the real fix, then cut over. Recommending this
explicitly; not building the stopgap here (out of scope, Section 1).

---

## 9. Backfill and Rollout — Named Here, Built by Q

Not built in this design document (schema-only, per this document's own
opening disclaimer), but the shape needs to be concrete enough for Asimov to
review, so stated plainly:

1. **A one-time, chunked backfill script**, same structure as `reset-
   layer1-removal-310.js` (measure the live table first via
   `idx_missive_message_intake_eligible_id`, Section 5; page through in
   batches, `INSERT ... ON CONFLICT DO NOTHING`; verify the final corpus
   count against a live re-query; write the Rule 6 `audit_log` entry,
   Section 7, with the real measured count — never copied from this
   document). Safe to re-run (idempotent via `ON CONFLICT`).
2. **The reconciliation job** (Section 5), on its 15-minute cron, live from
   the moment the migration is applied — not gated behind the backfill
   finishing, since a partially-backfilled corpus is a real, valid state the
   reconciliation job should already be able to reason about (it will
   report gaps until the backfill catches up, which is correct, expected
   behavior, not a bug).
3. **The kill-switch fallback** named in Section 5/6 — a concrete mechanism
   (a small single-row health/status check `GET /api/archive-search/search`
   consults before querying `archive_search_corpus`, falling back to
   `missive_message_intake_search_safe` on an unhealthy read) — named here
   as a real requirement, not designed down to exact DDL in this pass; Q's
   build should propose the concrete shape and Asimov should see it before
   it ships, same as everything else in this document.
4. **The query change itself** in `GET /api/archive-search/search`
   (`router.js` lines 427–480) — swap `.from('missive_message_intake_
   search_safe')` for `.from('archive_search_corpus')`; response shape,
   `buildSnippet()`, and the `archive_search.query_performed` audit event
   are all unchanged, since the corpus table carries the identical columns
   the route already selects. **Only after the 7-day shadow window (Section
   8) closes clean.**

---

## Open Items — Needs Confirming Before This Gets Built

1. **`archive_search_flagged_suppressions`'s real, live column names** are
   assumed from the unmerged branch's own migration, not independently
   re-verified against production the way the view's predicate was
   (Section 3's own open item). Confirm before applying.
2. **The kill-switch fallback's concrete shape** (Section 9, item 3) is
   named as a requirement, not designed to DDL/code level, in this pass —
   Asimov should see Q's concrete proposal before it ships, not just this
   document's description of what it must do.
3. **The 15-minute reconciliation cadence** (Section 5) is a reasoned
   proposal, not a measured certainty — TARS should confirm real run time
   against the live table before this number is locked in as the audited
   Rule 6 value.
4. **Whether to keep the becoming-eligible direction fully coupled
   (Section 4's primary design, 0-second/same-transaction) or deliberately
   decouple it (the stated fallback, 5-second app-level upsert)** — I'm
   recommending the coupled design for simplicity; Asimov/Mason should
   confirm that's the right call rather than the more conservative
   decoupled one.
5. **The date-bounded stopgap** (Section 8) is recommended as immediate,
   independent interim relief but is not part of this build — confirm
   someone is actually shipping it, since without it the search route stays
   fully down for the entire 7-day shadow window under this plan.
6. **`feature/archive-search-flagged-release-gate-removal` remains
   unmerged** — this design already accounts for its real, live effects
   (Section 1), but the underlying git/production drift it represents is a
   real, separate risk this document surfaces again (following
   `20260924000000`'s own lead) without resolving.

---

## Ready for Asimov Review

Everything below is new since this morning's confirmations on the abstract
architecture — concrete-design questions only:

1. **The eligibility function (Section 2)** as the single source of truth
   for "eligible," reused by every trigger and the reconciliation job —
   confirm this structurally satisfies Mason's "two independently
   maintained definitions" warning, rather than just asserting it does.
2. **The two-track trigger design (Sections 3–4)**: same-transaction/
   fail-closed for escalation-open and suppression-insert; same-transaction/
   fail-open for the screening-pass direction. Confirm the asymmetry itself
   (deliberately different error-handling philosophy per direction) is the
   right call, not just the sync-timing numbers.
3. **The concrete becoming-eligible number**: primary 0 seconds
   (same-transaction), 15-minute backstop ceiling — confirm this satisfies
   Mason's "seconds, event-driven, reconciliation as backstop not primary"
   standard, since it's stricter than what was asked for rather than merely
   compliant with it, and confirm or reject the named fallback (Open Item
   4).
4. **The subset-guarantee reconciliation design (Section 5)** — confirm the
   deliberate choice to never query `missive_message_intake_search_safe`
   directly (citing `20260918020000`'s own anti-join instability finding as
   the reason) is the right call, and confirm the 15-minute cadence and the
   500-row/repeat-violation systemic threshold as reasonable starting
   numbers pending TARS's real measurement.
5. **The fail-safe table (Section 6)**, specifically the systemic-violation
   kill-switch (fallback to the original view, not a full outage) as the
   correct proportionate ceiling per the opinion's own Section 10 menu.
6. **The Rule 6 `audit_log` entry shape (Section 7)** — confirm the reused
   `actor_type: 'human'` / layer1-removal-precedent classification is
   correct for this build specifically (no conflict was flagged for this
   build's own confirmation, unlike the flagged-release-gate-removal one).
7. **The literal 7-day shadow-mode design (Section 8)** — confirm running
   the corpus fully live and reconciled for 7 real days before the search
   route ever reads from it satisfies GOVERNANCE.md Rule 6's actual text,
   and confirm the zero-unresolved-critical-violation bar as the right gate
   for calling that window "clean."
8. **Scope confirmation**: this design touches `missive_message_intake_
   search_safe` not at all — `security_barrier` stays exactly as it is,
   permanently, per both direct fixes remaining NOT CLEARED. Confirm this
   reading is still correct and nothing here should be read as reopening
   that question.
