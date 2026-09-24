# Asimov — Design Confirmation Pass, Search-Corpus Concrete Mechanism

**Date:** 2026-09-24. Confirms whether Neo's concrete technical design
(`projects/hub/email-intake/archive-search-search-performance-security-
barrier-spec.md`) satisfies the six Rule 6 items and the specific numbers my
own abstract-design confirmation required
(`archive-search-search-performance-security-barrier-asimov-confirmation.md`,
CLEARED WITH CONDITIONS), and Mason's parallel conditions
(`-mason-confirmation.md`, CLEARED WITH CONDITIONS, condition 1 split by
direction). Read alongside
`archive-search-search-performance-security-barrier-shadow-mode-owner-risk-
acceptance.md` — Peter's signed waiver of the 7-day observation window only,
not of the mechanism. Not re-litigating that waiver here; it's a closed,
separate decision.

---

## VERDICT UP FRONT: CLEARED WITH CONDITIONS

The architecture is sound and the specific numbers hold up. Two things need
to change before Q builds the final artifact, and one thing needs to happen
before Peter applies the migration. None of the three requires redesigning
the mechanism — all three are fixes to what's already here.

---

## Going through the eight "Ready for Asimov Review" items

**1. Single eligibility function as source of truth (Section 2).** Confirmed.
Every trigger and the reconciliation job call `archive_search_message_is_
eligible()` — there is no second, hand-copied `WHERE` clause anywhere in
this design, which is the literal thing Mason's warning named: *"Two
independently maintained definitions of 'excluded' drifting apart is a
worse, less visible bug class than today's timeout."* Within this design,
that risk is closed.

It is not the only place this risk lives, though — see Condition 2 below.
Mason's warning was about definitions drifting from each other; there's a
second, adjacent drift risk this design honestly names but doesn't mitigate:
this one function drifting from the *view's* real, live predicate over time.
Section 2's own "MAINTENANCE OBLIGATION" comment says so directly: *"if
missive_message_intake_search_safe's own definition ever changes again...
this function must change in lockstep, by hand... There is no mechanism in
this design that keeps the two automatically in sync."* That's not a
hypothetical — it's the exact failure mode Section 1's own reading list
just lived through: this checkout's migration history doesn't have
`20260923000000` at all, and the view's real predicate only came to light
today because someone happened to read a header comment on an unrelated
migration. Named honestly by Neo; still needs a mitigation, not just a
comment. See Condition 2.

**2. Two-track trigger design, asymmetric by direction (Sections 3–4).**
Confirmed correct, including the self-correction in Section 3: reopening a
confirmed escalation is a *becoming*-eligible transition (clears
`reopened_at`, stops matching the exclusion condition), not a
leaving-eligibility one — Neo caught its own initial wrong assumption by
re-reading `router.js` lines 1534–1682 directly rather than reasoning from
the route name. The asymmetry itself is the right call: fail-closed, no
exception handler, whole transaction rolls back for the leaving-eligibility
direction (escalation-open-insert, suppression-insert) is the concrete
meaning of Mason's "no lag, ever, full stop." Fail-open, exception caught
and logged, for the screening-pass direction is correct because that
pipeline's own reliability is what the rest of this system's Fair Housing
protections depend on — blocking it over a corpus-table hiccup would itself
be the disproportionate response the opinion's Section 10 warns against.

**3. The concrete becoming-eligible number.** Confirmed, and it clears the
bar with room to spare, not just barely. Primary propagation target is 0
seconds (same-transaction, structural) against Mason's own anticipated
"low-single-digit-to-low-double-digit seconds" — stricter than what was
asked for, not merely compliant. The 15-minute reconciliation ceiling is
backstop-for-the-rare-failure-case, not the primary mechanism, which is
exactly the "event-driven... reconciliation as backstop not primary"
standard Mason's confirmation set. On the coupled-vs-decoupled fallback
(Open Item 4): confirming the coupled design as the one to build. The
corpus write is a single-row upsert on a small, purpose-built table — none
of the original bug's cost profile (wide `UNION` dedup, anti-join
instability) applies to it, and one reasoned-about mechanism beats two per
CLAUDE.md's own "simple is better than clever." If TARS's real-data pass
turns up latency on the screening cron from the coupled write, switching to
the named 5-second decoupled fallback does **not** require a new Asimov
design review — both paths were reviewed here, the target number and
15-minute backstop are unchanged either way.

**4. The subset-guarantee reconciliation design (Section 5).** Confirmed on
the mechanism, with a required addition — see Condition 2. Never running a
live anti-join under `security_barrier` for this job is the right call;
`20260918020000`'s own finding (an anti-join plan unstable run-to-run even
against an empty exception table) is real, measured evidence, not a
theoretical worry, and reconciliation is exactly the job that can't afford
an unreliable check. The fetch-small-exception-sets-and-diff-client-side
pattern is proven safe at this table's scale by the same migration. 15
minutes as a starting cadence is reasonable given the cited precedent
(~200–330ms per page, ~255k rows) — correctly flagged as a proposal for
TARS to confirm, not asserted as measured. The 500-row / repeated-violation
systemic threshold is a sane starting bar for the kill-switch escalation.

**5. Fail-safe table (Section 6), systemic kill-switch.** Confirmed as the
correct proportionate ceiling. Falling back to the original,
still-`security_barrier`'d view on systemic violation is "temporarily
restricting a particular search scope" off the opinion's own Section 10
menu, not a full outage — and it's the right asymmetry: isolated violation
gets a silent (to the user) self-heal plus a loud audit/alert; systemic
violation gets the self-heal *and* a structural fallback until a human
confirms health. Confirming Open Item 2 (kill-switch's concrete shape) is
correctly left to Q's implementation — but Asimov needs to see that concrete
proposal before it ships, not just this document's description of what it
must do. Adding that as a required follow-up gate, not a condition on this
document.

**6. Rule 6 `audit_log` entry shape (Section 7).** The `actor_type: 'human'`
/ layer1-removal-precedent classification is correct and consistent with
what I already cleared for that build. The entry's *content* needs two
fixes before it ships — see Condition 1. This is not a reason to withhold
clearance on the shape or precedent, which are right; it's a reason the
specific payload in this document can't be copied verbatim into the backfill
script as-is.

**7. Literal 7-day shadow-mode design (Section 8).** As *designed*, Section
8 correctly satisfies Rule 6's literal text — a second, physically separate,
continuously-synchronized copy run in parallel before any real traffic
depends on it is shadow mode by the term's actual meaning, not an analogy
to it, and the zero-unresolved-critical-violation bar is the right gate for
calling the window clean. None of that changes.

What changes is that Peter's signed waiver means this window, as designed,
will not run before cutover. That doesn't touch anything Rule 6 gates
through *this* document — the waiver already states plainly what is and
isn't skipped: *"the same-transaction fail-closed removal triggers, the
subset-guarantee reconciliation check, and the audit logging Neo designed
still apply from day one; only the week of watching them first is
skipped."* One thing this does **not** waive, because it was never part of
the Rule 6 shadow-mode requirement in the first place: TARS's own real-data
comparison pass (Section 8, step 3 — sampling actual queries against both
`archive_search_corpus` and `missive_message_intake_search_safe`, confirming
identical result sets). That's CLAUDE.md's ordinary "TARS verifies it works
with real data" gate, not a shadow-mode artifact — it doesn't need 7 days to
run, it needs to run once, for real, before the route cutover, waiver or no
waiver. Confirming it should still happen, just compressed to immediately
before cutover instead of stretched across a week.

**8. Scope confirmation.** Confirmed correct and unchanged.
`missive_message_intake_search_safe` and `security_barrier` are untouched;
the two direct fixes stay NOT CLEARED; nothing here reopens that. Section 1
of this document reads as intended.

---

## Condition 1 — Fix the audit_log entry before Q writes the backfill script

Two concrete problems in Section 7's payload, both because it was drafted
before the waiver existed:

- **Wrong section reference.** `shadow_mode_satisfaction` points to "Section
  9" — Section 9 is Backfill and Rollout; the shadow-mode content is Section
  8. Small, but this field is exactly what someone reads six months from now
  to understand what happened.
- **Stale claim.** As written, `shadow_mode_satisfaction: 'See spec Section
  9 — literal 7-day parallel-run shadow mode, not a substitute.'` describes
  a 7-day parallel run that, per the signed waiver, will not happen. Applied
  verbatim, this audit entry would misrepresent the actual sequence of
  events on the one thing Rule 6 exists to make auditable. Fix: cite
  `archive-search-search-performance-security-barrier-shadow-mode-owner-
  risk-acceptance.md` by name, state plainly that the 7-day observation
  window was waived by signed owner risk-acceptance while the mechanism
  (triggers, reconciliation, audit logging) went live from day one, and add
  that document to `reference_documents`.

Mechanical fix, not a design problem. Q applies it when writing the actual
backfill script per Section 9 — the entry gets written once, for real, with
a real row count, same as the layer1-removal precedent; this document just
needs to not describe a shadow window that didn't run.

## Condition 2 — Add a live drift check between the eligibility function and the view

The single-function design closes the "two independently maintained
definitions" risk *within* this build. It does not close the risk that the
one function drifts from `missive_message_intake_search_safe`'s real,
live predicate over time — and that specific failure mode isn't
speculative on this project; it's what this exact document's own reading
list found happened in the last 24 hours (a predicate change applied
directly in production, on an unmerged branch, invisible to this checkout
until someone read a migration header by hand). With the shadow week now
waived, there is no observation period left to catch that kind of drift
before it matters — which makes an automated check more necessary here,
not less.

Required addition: the reconciliation job (Section 5) should also run a
lightweight, periodic point-sample check directly against
`missive_message_intake_search_safe` — not a full anti-join (Section 5's
own reasoning against that stands, and I'm not asking to reopen it), but a
rotating sample of corpus row IDs checked with plain-equality point lookups,
the same access pattern this design's own Section 1 already confirms is
leakproof and fast under `security_barrier` (`20260912040000`'s header,
quoted directly in this design: "plain equality on built-in scalar
types... IS marked leakproof"). Point lookups don't carry the anti-join
instability risk `20260918020000` measured — they're a different query
shape, not the thing that broke. Log pass/fail the same way as the rest of
Section 5 (an `audit_log` entry either folded into the existing
reconciliation entry or a new `archive_search.corpus_view_drift_check`
action — Q's choice). This is a bounded addition to an already-designed
job, not a new subsystem.

## Condition 3 — Verify `archive_search_flagged_suppressions`'s real column names before Peter applies the migration

Open Item 1, restated as a hard condition rather than a note: this design's
trigger is written against column names read off an unmerged branch's
migration file, not independently confirmed against production the way the
view's own predicate was. Confirm the real, live columns match
(`missive_conversation_id TEXT`, `mailbox_key TEXT`, both `NOT NULL`) before
this migration is applied via Supabase's SQL Editor. If they don't match,
the migration fails loudly at apply time rather than silently — a safe
failure mode — but it should be checked ahead of time rather than
discovered at 11pm on Peter's own attempt to apply it.

---

## Everything else, restated plainly

- **Tier 1 (Auto) classification**: confirmed correct, same reasoning as the
  layer1-removal precedent — no tenant/owner messaging, no housing
  decision, changes only which archived internal communications a trained
  employee can retrieve.
- **The two direct fixes** (drop `security_barrier`; mark `@@` leakproof)
  remain NOT CLEARED, untouched by this design, as they must.
- **Standard pipeline gates unaffected by this document**: this confirms
  the concrete Rule 6 design only. Sentinel (RLS/access-control review on
  the new table and the kill-switch's access path), Ralph (concurrent-write
  and trigger-failure chaos scenarios — this is exactly the kind of
  integration/concurrency change Ralph's gate exists for), and Judge still
  apply before this ships, per GOVERNANCE.md's standard pipeline. Nothing in
  this document substitutes for them.
- **Interim relief**: the date-bounded stopgap Neo (and both this morning's
  reviews) recommended shipping tonight is still worth doing independently —
  the waiver shortens the wait for the real fix, but Q still needs to build
  it, Peter still needs to apply the migration, and TARS's one real-data
  pass still needs to run before cutover. The stopgap covers that gap.

---

## VERDICT: CLEARED WITH CONDITIONS

1. Fix the `audit_log` entry (Section 7): correct the section reference and
   replace the stale 7-day-shadow-mode claim with an accurate citation to
   the signed owner risk-acceptance waiver.
2. Add a periodic point-sample drift check between
   `archive_search_message_is_eligible()` and the live view, using
   already-proven-leakproof plain-equality lookups, logged to `audit_log`.
3. Confirm `archive_search_flagged_suppressions`'s real column names against
   production before Peter applies the migration.

Everything else — the two-track trigger design, the 0-second/15-minute
numbers, the per-failure-mode fail-safe table, the reconciliation job's
architecture, the Tier 1 classification, the scope boundary — is confirmed
as designed. None of the three conditions above requires touching the
schema, the trigger logic, or the sync model Asimov's and Mason's earlier
confirmations already cleared. Q can start building Sections 2–6 now;
conditions 1 and 2 need to land before this goes to production, and
condition 3 needs to land before Peter applies the migration.
