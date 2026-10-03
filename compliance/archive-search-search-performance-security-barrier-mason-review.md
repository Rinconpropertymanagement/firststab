# Mason — Fair Housing/Legal Review: Removing `security_barrier` (or Marking `@@` Leakproof) to Fix Full-Text Search Performance

**Date:** 2026-09-24. Live context: Archive Search's search box times out on
every query in production. Neo's confirmed root cause: `security_barrier =
true` on `missive_message_intake_search_safe` prevents the planner from
using an index for the `@@` (tsquery) match, because `@@` is not marked
LEAKPROOF — so full-text matching only ever runs as a Filter *after* the
view's own exclusion logic (screening_result, escalations, overrides) has
already been fully evaluated. A bounded recent-date-window fix is already
available and does not touch any of this — that fix is not what's under
review here. This review is narrow: **can Rincon let full-text search use
an index across the entire archive without reopening the specific side
channel `security_barrier` exists to close, on this specific content?**

Read: `archive-search-held-release-outside-counsel-opinion.md`,
`archive-search-property-360-access-expansion-outside-counsel-opinion.md`,
`supabase/migrations/20260910030000_archive_search_schema.sql`,
`20260912040000_fix_search_safe_view_seq_scan.sql`,
`20260913000000_fix_search_safe_view_union_dedup_cost.sql`, and
`projects/hub/archive-search/lib/screening-pass.js` (to confirm current
exclusion state, not assume it).

---

## Verdict

**NOT CLEARED** for the two ways to literally do what was asked (drop
`security_barrier`; mark `@@` leakproof). **CLEARED WITH CONDITIONS** for a
different technical approach that gets Peter the same outcome — whole-archive,
indexed full-text search — without touching the protection. Details below.

---

## 1. What `security_barrier` is actually protecting, stated precisely

Per `20260910030000`'s own comment: `search_document` (the tsvector column)
is computed over *every* row, including flagged and not-yet-screened ones —
the GIN index physically contains tokenized text from content no searcher is
supposed to see. `security_barrier` doesn't change *whether* the view's WHERE
clause (`screening_result = 'clear' AND NOT EXISTS escalations`, plus the
override branch) is enforced — that clause is not optional and stays in the
query either way. What it changes is *evaluation order*: it stops Postgres
from running a non-leakproof external qual (here, `@@`) against rows before
the view's own exclusion logic has decided those rows shouldn't be visible.
Today's slow-but-safe behavior is exactly that ordering working as designed:
exclusions first, text match second, over whatever survives.

So the real risk was never "excluded rows show up in results" — they don't,
under any of the options below. It's a **side channel**: whether an
authorized searcher can learn that a specific search term matches something
excluded — a confirmed Fair Housing escalation, a flagged-and-not-overridden
conversation, a not-yet-screened message — through timing, error behavior,
or (in any future version of this feature) result counts, ranking, or
suggestions, without that content ever being returned.

## 2. Dropping `security_barrier` outright — NOT CLEARED

Removing it lets the planner combine `@@` with a GIN index scan across the
*whole* table, including flagged/pending/escalated rows, and apply the
exclusion filter afterward or interleaved with the scan — freely reordered,
no longer fenced. The result *set* is still correct (excluded rows still
never come back as results). What's lost is the guarantee that a rare or
targeted search term touching only excluded content resolves at a
meaningfully different cost — timing, resource use, or future error paths —
than a term that matches nothing at all. That's a real, not theoretical,
existence-inference risk, and it lands specifically on the categories this
project has spent the last two weeks building separate, deliberate exclusion
mechanisms for: an open/confirmed Fair Housing escalation someone raised (the
same mechanism Round 3 of `archive-search-escalation-mechanism-review.md`
treated as high-stakes enough to require a second-admin check and a
structured litigation-hold attestation before it could even be *reopened*),
a flagged-and-not-overridden conversation, and not-yet-screened backlog. The
population that could run this probing is no longer 2 named admins — it's
whoever has Property 360 access, expanding today per this morning's
clearance and growing with headcount, with no per-search review. A bigger,
less-vetted population searching, combined with a reopened side channel onto
content specifically marked "not for search," is a worse fact pattern than
anything the two opinions above were asked about — neither was asked whether
the exclusion mechanisms themselves could be inferred around; both explicitly
assumed they hold.

Also worth naming directly: `security_barrier` isn't only protecting today's
`@@` usage. It's the backstop for *every future addition* to this query path
— relevance ranking, `ts_headline` snippets, autocomplete, "did you mean"
— several of which are more leak-prone than plain `@@`, not less. Removing
the fence now means every future feature on this path has to independently
re-derive safety instead of inheriting it. Given how fast this feature has
been iterated (three performance migrations in under two weeks, access
expanded twice), that's a real forward-looking cost, not a hypothetical one.

## 3. Marking `@@` leakproof — not a real option, don't build it

This isn't a narrower version of option 2. `LEAKPROOF` is a property
declared on the function/operator itself, database-wide — it would affect
every view, every RLS policy, and every other security-barrier'd object in
this schema that ever uses `@@`, not just this one view. Postgres core
declines to mark text-search matching leakproof by default for good reason
(dictionary/configuration behavior can be data-dependent). This trades a
scoped, well-understood performance problem for an unscoped, unreviewed
security downgrade across the whole database. Not proportionate to the
problem being solved.

## 4. The approach that actually gets Peter what he wants — CLEARED WITH CONDITIONS

The ask is whole-archive indexed search, not specifically "remove
`security_barrier`." Those aren't the same thing. Build the full-text index
over a *pre-filtered copy* — a table or materialized structure containing
only rows that currently pass the exclusion logic — instead of over the base
table through a barrier that has to referee access at query time. If excluded
rows are never physically present in the thing being indexed, there is no
row for a timing or error side channel to expose, on any query, present or
future. That's a stronger guarantee than today's architecture, not just a
faster one — it also gets rid of the underlying fact `20260910030000` flagged
as uncomfortable in the first place (that the real GIN index contains
tokenized excluded content at all).

This is real re-architecture, not a query tweak, and I'm not clearing it
blind. Conditions:

1. **Sync must be synchronous, not eventually-consistent.** The escalation
   mechanism was specifically built and cleared as "immediate structural
   exclusion on report" (`archive-search-escalation-mechanism-review.md`,
   Round 1). A batch/async refresh of the search copy reopens exactly the
   exposure window that design decision closed — a report or override
   revocation must remove a row from the searchable copy in the same
   transaction, not on a delay.
2. **A hard, continuously-checked guarantee that the search copy's row set
   is always a subset of what the live `security_barrier`'d view would
   return — never a superset, ever.** This project already has precedent
   for this kind of guardrail (the CI check barring raw
   `missive_message_intake` access outside the view). Two independently
   maintained definitions of "excluded" drifting apart is a worse bug class
   than today's timeout, because it wouldn't be visible by reading the
   view's own definition.
3. **Neo designs the actual mechanism and Asimov reviews it before Q
   builds anything.** This is a compliance-logic/guardrail change to the one
   view every search route depends on — same Rule 6 Critical-tier class as
   the escalation mechanism itself, not a pure performance fix like the two
   UNION rewrites that came before it.
4. **Flag this to outside counsel, even if briefly.** Neither opinion I read
   was asked about the mechanism that enforces exclusion — both assumed it
   works. This is close enough to that assumption that I'd rather Peter make
   the same kind of explicit, on-the-record call he made for the held-release
   and escalation-reopen questions ("counsel's existing opinion covers this,
   no fresh sign-off needed") than have it go unmentioned. That's a judgment
   call I can flag but not close myself.

## 5. Does the outage justify moving faster than this tonight?

No, and it doesn't need to. The bounded recent-date-window fix is already
available, doesn't touch `security_barrier` at all, and gets the search box
working now. Whole-archive indexed search is a real, separately-schedulable
build with its own design and review — nothing about tonight's outage makes
option 2 or option 3 above safer than they are on their own merits.

---

## Bottom Line

Don't drop `security_barrier` on this view, and don't mark `@@` leakproof —
both reopen a real existence-inference side channel onto Fair
Housing-escalated, flagged, and pending content, for a search population
that's expanding today, and neither was contemplated by the opinions this
morning's clearances relied on. A pre-filtered, synchronously-maintained
search copy can deliver the same whole-archive result Peter wants without
that exposure, and I'll clear that path once Neo designs it, Asimov signs
off on it as the Critical-tier change it is, and Peter makes an explicit
call on looping in outside counsel. Ship the already-available bounded-date
fix tonight; this is not a reason to wait on that.
