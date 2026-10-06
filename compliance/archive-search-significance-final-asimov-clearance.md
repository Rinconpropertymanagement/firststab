# Asimov — Final Clearance Check (Archive Search Significance + Complaint-Tracking Merge)

**Date:** 2026-09-13. Short confirmation pass only, against my prior STILL NOT CLEARED
(`compliance/archive-search-significance-outside-counsel-asimov-confirmation.md`),
which left exactly three non-legal items open. Checking each against what's now on
record — not re-litigating Items 1/2/3/5/6/9, which the technical spec's Section 12
and my own prior confirmation already settled.

## Item 1 — Peter's compliance-risk approval: CONFIRMED ON RECORD

Technical spec Section 12, verbatim: *"I've reviewed the opinion and the governance
findings, I accept the risk, proceed."* — dated 2026-09-13, attributed to Peter
directly. Satisfies Rule 6's owner-approval prong. Closed.

## Item 2 — Shadow-mode/sampling exit criterion: CONFIRMED ON RECORD

Technical spec Section 12: the 100-conversation pilot (Section 10) is the shadow-mode
sample, human-reviewed before any expansion; Peter's own words, quoted: *"good amount.
might need another 100."* — a bounded allowance to 200, not open-ended, and expansion
past the pilot requires his own go-ahead, not an automatic trigger. Satisfies Rule 6's
shadow-mode prong, matching the criterion I asked for. Closed.

## Item 3 — Neo's Rule 4 data inventory: NOT YET CLOSED — one narrow, specific gap

I read the migration (`supabase/migrations/20260913020000_archive_search_significance_
complaint_merge_schema.sql`) against the inventory
(`compliance/archive-search-significance-complaint-merge-data-inventory.md`) field by
field, not just by section heading.

**Genuinely covered, not a stale restatement:** both new tables
(`missive_conversation_significance`, `missive_message_links`) each get their own full
six-field inventory entry; the extended `complaints` table's new column
(`owner_instruction_note_text`) is explicitly called out as new; `human_confirmed_big_
issue` is correctly scoped as human-only, never AI-written; `discovery_context`'s
practical effect (bulk ~254,000-conversation historical population vs. live trickle,
live-vs-historical note-drafting behavior) is substantively discussed throughout even
where the column name itself isn't repeated; the retroactive `owner_instruction_note_
text` template — including its mandatory "not human verified" label and its CCPA
redaction tension — gets the most thorough treatment in the document, correctly
flagged as still-open rather than resolved.

**What's actually missing:** the tri-state `owner_instruction_rejected` field itself —
on both `missive_conversation_significance` and `complaints` — never gets its own
`pii_fields` line. It appears only in the document's opening and closing claims that it
was "contemplated," never in the actual per-table inventory body. Its risk is folded
silently into the `owner_instruction_note_text` bullet, but it is a materially
different kind of data: a structured, indexed (`idx_missive_conversation_significance_
owner_instruction_rejected`), directly-queryable adverse-characterization flag — a
`WHERE owner_instruction_rejected = 'true'` filter surfaces every AI-concluded
discriminatory-owner-instruction finding without reading any free text at all. That's a
distinct Rule 4 fact (and a distinct `ccpa_deletable` question — redacting a structured
tri-state flag isn't the same operation as redacting text) that the current document
doesn't state anywhere. This is the same class of gap my prior confirmation named as
insufficient in the 2026-09-10 inventory: real, load-bearing data left out of the actual
inventory body, not a difference of emphasis.

**Fix required, narrow:** add `owner_instruction_rejected` as its own `pii_fields`
entry on both tables' sections, noting (a) its tri-state values, (b) that it is
structurally indexed/queryable independent of the note text, and (c) its own
`ccpa_deletable` treatment (does a CCPA request against the named owner require
resetting this flag, not just redacting the text it's paired with?). This is a
paragraph, not a rebuild — Neo's to add.

## Noted, not treated as a new blocker

- `complaints.is_big_deal` is now definitionally TRUE for nearly every AI-sourced row
  under the 8-value taxonomy — a semantic observation Neo flagged honestly in the DDL,
  correctly not silently decided. Agreed this doesn't gate anything by itself; no
  action required from me right now.
- The CCPA-cascade question and the redaction-tension on `owner_instruction_note_text`
  remain open, exactly as my and Mason's prior reviews already said they would. Not
  re-opened, not newly resolved.

## Item 3 — Re-read, 2026-09-13: CLOSED

Neo added the fix in place, in
`compliance/archive-search-significance-complaint-merge-data-inventory.md`: a
dedicated `pii_fields — owner_instruction_rejected (own entry...)` bullet on each of
`missive_conversation_significance` (new document, line 28) and `complaints` (line 39),
no longer folded into the `owner_instruction_note_text` bullet. Checked both against the
migration directly, not just against the prose:

- **Tri-state values** — both bullets state `NULL`/`'true'`/`'false'`/`'uncertain'`,
  matching the `CHECK` constraints at lines 436 and 653 of
  `supabase/migrations/20260913020000_archive_search_significance_complaint_merge_schema.sql`,
  and the category-gating (`NULL` unless `category = 'owner_instruction'`) matching the
  `..._owner_instruction_requires_category` constraints at lines 574 and 720.
- **Structured/directly-filterable, independent of the note text** — the
  `missive_conversation_significance` bullet correctly names the partial index at lines
  762-763 (`idx_missive_conversation_significance_owner_instruction_rejected`); the
  `complaints` bullet correctly notes no equivalent index exists on that table's copy of
  the column, while it's still a plain filterable value. Both distinguish this from
  `owner_instruction_note_text` as a materially different kind of data, and both name the
  access tier the column is readable at (`searcher` on one table, admin/DO-only on the
  other) — matching the Access-Tier Summary elsewhere in the same document.
- **Its own `ccpa_deletable` question** — both bullets open the flag-reset question
  distinctly from the note-text redaction question (resetting a tri-state column to
  `NULL` is a schema-level UPDATE, not the existing `"[REDACTED]"` text convention),
  and both correctly leave it flagged for Asimov/Mason rather than deciding it.

All three elements my prior confirmation asked for are present, on both tables, as their
own inventory line. Nothing new is missing. Item 3 is closed.

## Verdict

**CLEARED.** This specific compliance build — the archive-search significance +
complaint-tracking merge, as specified in
`projects/hub/email-intake/archive-search-significance-technical-spec.md` (v2) and
implemented in
`supabase/migrations/20260913020000_archive_search_significance_complaint_merge_schema.sql`
— is cleared for Neo/Q to proceed on the schema already written. Items 1, 2, and 3 are
all now on record as closed. This clearance does not re-decide, and does not block on,
the items already on record as open and non-blocking:

- The CCPA-cascade question (spec Section 11, Item 9) — whether a redaction on
  `tenants`/`owners` must cascade into `missive_message_links` /
  `missive_conversation_significance` / `complaints` content naming them.
- The `owner_instruction_rejected`/`owner_instruction_note_text` flag-and-text reset
  question against the very owner either describes.
- The `complaints.is_big_deal` semantic note (definitionally TRUE for nearly every
  AI-sourced row under the new shared taxonomy) — a schema-design observation, not a
  privacy finding.

None of these were ever gating conditions on this clearance; they remain open items on
record elsewhere, to be picked up on their own timeline.

— Asimov
