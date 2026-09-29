# Asimov — Governance Review: Significance Driver Clear-Page RPC (security_barrier Bypass)

**Date:** 2026-09-21. Reviews migration
`supabase/migrations/20260921020000_add_significance_driver_clear_page_rpc.sql`
and its wiring in `projects/hub/archive-search/lib/significance-pass.js`
(`fetchDriverPage()`). This is a review of a performance fix to an already-approved
mechanism, not a new feature — see
`compliance/archive-search-significance-final-asimov-clearance.md` for the original
clearance of the significance-tagging pipeline, and
`compliance/archive-search-significance-cursor-run-delta-asimov-review.md` for the
same-day review of a related fix inside this same driver. Written after the fact
(same-day gap, flagged by Judge's QA pass) — every other governance decision on
this feature today has a written record in `compliance/`; this migration was
substantively reviewed verbally but never written down until now. This file closes
that gap.

## What changed

`fetchDriverPage()` — the significance-tagging pipeline's per-page reader, walking
the ~148,586+ `screening_result = 'clear'` conversations 500 rows at a time — was
querying `missive_message_intake_search_safe_clear_branch`, a view with
`security_barrier = true`. Live production `EXPLAIN` evidence (reproduced twice,
986–1030ms both times, same plan, same buffer counts) showed `security_barrier`
was forcing Postgres into a full parallel sequential scan + in-memory sort of the
entire `clear` set on every page fetch, instead of using
`idx_missive_message_intake_clear_id` — the actual cause of the statement-timeout
crashes hitting the real production run. The same query run directly against the
base table used the index and returned in 76ms.

The fix: a new function, `archive_search_significance_driver_next_clear_page`,
that reads `missive_message_intake` directly with a hardcoded
`screening_result = 'clear'` filter, `ORDER BY id ASC`, a bare cursor comparison,
and `LIMIT 500` — identical shape to what the view provided, minus the
`security_barrier` boundary that was defeating the planner. `fetchDriverPage()`
now calls this RPC instead of querying the view. The view itself, its
`security_barrier` setting, and every other caller of it are untouched.

## Why this is a compliance build

This is the driver behind the significance/complaint-triage pipeline, which the
final clearance (`compliance/archive-search-significance-final-asimov-clearance.md`)
already established sits inside Fair-Housing-relevant territory (owner-instruction
review, escalation signals, `protected_class`-adjacent categorization). Any change
to how that pipeline reads its source data — including a change that only touches
*how* rows are fetched, not which ones — falls inside CLAUDE.md's Governance
section and gets a review before it ships.

## Verification performed (independent of the migration's own narrative)

1. **Grants** — read directly in the migration file: `REVOKE ALL ... FROM PUBLIC`
   followed by `GRANT EXECUTE ... TO service_role` only (lines 176–177). The RPC
   also returns fewer columns (4, named) than the view it replaces for this
   caller (`SELECT m.*`) — narrower, not broader, exposure.
2. **No new privilege gap** — confirmed from the base table's own original
   migration, not from today's reasoning alone.
   `supabase/migrations/20260905020000_missive_shared_inbox_intake_schema.sql`
   (lines 592–610) shows `missive_message_intake` has had RLS enabled with
   **zero permissive policies since creation**, with its own comment stating
   explicitly that only the service-role key (which bypasses RLS) can reach it
   until a future migration adds a scoped policy. No later migration adds one.
   `service_role` already had complete, direct, unrestricted read access to the
   raw table before this migration existed, independent of the view.
3. **Downstream logic unchanged** — read `fetchNextEligibleConversations()` and
   its surrounding code directly: `passesEscalationExclusion()`,
   `fetchEscalationExclusionSet()`, `passesSinceDate()`, and every decision-making
   function (`buildCall2Prompt`, `needs_human_call` fail-closed defaults,
   owner-instruction handling) are called exactly as before, downstream of this
   fetch. Nothing about what gets excluded, who decides, or when a human reviews
   anything changed.
4. **Single caller** — grepped the repository; only `fetchDriverPage()` and the
   corresponding test assertions (`test/run-tests.js`) reference this RPC.
5. **Query shape** — fully hardcoded filter/order/limit, a plain UUID cursor
   comparison, no caller-supplied predicate, no dynamic SQL, no
   `SECURITY DEFINER`. No composition surface for a caller to widen the query
   even in principle.

On items 1–5, the data-exposure conclusion is unchanged and unreversed: **nothing
new is exposed to anyone who couldn't already see it.**

## Guardrail-coverage finding (raised by Judge's QA pass — not addressed in my
## original review)

`test/no-raw-table-access-check.js` is a binding build requirement (promoted from
recommendation to requirement by the original 2026-09-10 spec review) that scans
`router.js` and `lib/*.js` for the literal string `missive_message_intake`
outside an allow-listed set of safe view/column suffixes, in any file except
`screening-pass.js`. I ran it against the current source: it passes clean, 0
violations, everywhere — **including `significance-pass.js`**, which no longer
contains the bare string `missive_message_intake` anywhere in its own source
(confirmed by direct grep). The raw table name now exists only inside the SQL
migration file, which this guardrail does not scan.

**This is a real gap, not a false alarm, and it is not the same question as
Gap 1's grants/exposure analysis.** The guardrail's own header comment states its
actual purpose: it exists *"given that every Hub route shares one Supabase
service-role connection with full table access regardless of any view or RLS
policy"* — i.e., it was built precisely because DB-level access controls alone
don't stop a developer (or an AI coding agent) from writing a query that reaches
unscreened, PII-bearing, pre-screening-exception content by habit or mistake. It
is a **discipline/defense-in-depth control, not a data-exposure control** — the
data-exposure question was already closed by RLS/grants before this guardrail
was ever written. So "no new exposure" does not answer whether the guardrail
still does its job here. It doesn't, in two concrete ways:

1. **Future-regression blindness.** The RPC's safety today depends entirely on
   its own SQL staying exactly `screening_result = 'clear'`. If a future
   migration ever loosens or removes that WHERE clause, `fetchDriverPage()`'s JS
   source would be unchanged (still just `.rpc('archive_search_significance_
   driver_next_clear_page', ...)`), and this guardrail — the one mechanism built
   to catch an accidental widening of raw-table access in this pipeline — would
   have nothing to say about it. Every one of the five existing view-suffix
   exemptions doesn't have this problem: the view name itself appears in the JS
   source, so a future change to which view is queried is visible to a `git
   diff` and to this checker. An RPC call site hides that.
2. **Audit-honesty.** A compliance scan of this codebase today reports "clean —
   no raw `missive_message_intake` table access found outside
   `screening-pass.js`." That is a true statement about what the checker
   currently detects, but not a true statement about what the code does —
   `significance-pass.js`'s own header comment (added by Q, to its credit)
   already says as much: *"the underlying read is, functionally, a filtered
   raw-table read now, one level removed."* A guardrail whose "clean" result no
   longer matches reality is worse than no guardrail, because it invites false
   confidence in exactly the audit it exists to support (this pipeline has had
   outside counsel and Mason review specifically because of this class of
   content).

## Recommendation: (a) — add a visible, mechanically-checked exception

Not (b). The reasoning above is concrete, not hypothetical, and this pipeline's
own established convention (all five prior exemptions) is to make every deviation
from "no raw-table access outside screening-pass.js" visible and reviewed, not
silently accepted. A code comment alone (which is all that exists today) doesn't
satisfy that — comments drift and aren't enforced by the check that's supposed to
be binding.

Concretely, handing off to Neo/Q:

1. Add a small, named, exported list to `test/no-raw-table-access-check.js` —
   e.g. `KNOWN_RAW_TABLE_RPC_FUNCTIONS` — listing
   `archive_search_significance_driver_next_clear_page`, citing this review and
   migration `20260921020000`, and stating its fixed filter
   (`screening_result = 'clear'`) in one line, matching how each of the five
   existing suffix exemptions is documented in that file's own header.
2. Add a companion check in the same file: scan the checked files for
   `.rpc('...')` call-site literals and flag any name not present in that list —
   so a *future* RPC reading the raw table can't slip in unreviewed the same way
   this one nearly did (it was Judge's QA pass that caught this, not the build
   pipeline itself).
3. This restores the guardrail's own promise: a clean run should mean what it
   claims to mean, for both view-based and RPC-based access paths.

## Verdict

**APPROVED TO ACTIVATE — confirmed, not reversed.** The data-exposure conclusion
from my original review stands: nothing new is exposed to any party that
couldn't already see it, verified independently against the base table's own RLS
history rather than taken on the migration's word. This migration may remain
live in production.

**New, separate condition, not a data-safety blocker:** the guardrail-coverage
gap above must be closed per recommendation (a) before another RPC-based
raw-table read is added anywhere in this pipeline. This migration itself does
not need to be rolled back or re-verified while that follow-up lands — its
safety does not depend on the guardrail catching it after the fact, it depends
on the verification already performed in this document.

— Asimov
