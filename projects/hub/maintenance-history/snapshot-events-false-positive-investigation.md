# `maintenance_snapshot_events` False-Positive Investigation

**Written by:** Oracle
**Date:** 2026-09-05
**Type:** Data investigation only — no fix proposed or designed. This document exists to tell Peter, Asimov, and Mason whether a fix is even needed for this table, matching the rigor of the original 340-record `maintenance_claims` review (`projects/hub/maintenance-history/scratch-docs/build-memo.js`, Section 1.2). If a fix is needed, that is a separate, fresh spec requiring its own outside-counsel and governance review — exactly like `content-screening-tier-redesign-SPEC.md` just went through for `maintenance_claims`.

**Coverage: full, not a sample.** 292 of 292 flagged rows read and classified — the same 100% coverage standard the original 340-record review used.

---

## Bottom line

**Yes — `maintenance_snapshot_events` has the same false-positive problem, and on the specific six terms the just-approved fix targets, it is actually worse (100% vs. 91%).** It also has a second, smaller, and genuinely different false-positive pattern the approved fix was never designed to touch at all, because that fix only ever modifies `content-check.js`'s `checkClaim()`, and this table's flag never runs through that function.

| | `maintenance_claims` (already reviewed) | `maintenance_snapshot_events` (this investigation) |
|---|---|---|
| Records flagged | 340 | 292 (of 11,483 total rows — 2.5%) |
| Overall false-positive rate | ~91% (309–312 of 340) | **95.2%** (278 of 292) |
| False-positive rate on the six known terms specifically (white/black/blind/diagnosis/diagnosed/too old-too young) | ~91% | **100%** (271 of 271) |
| Driving mechanism | Layer 1 keyword scan (`scanText()`) only | Layer 1 keyword scan (same dictionary) **plus** a second, separate live Layer 2 Haiku rescan with its own, different false-positive pattern |
| Does the just-approved Tier A/B fix help this table? | Yes (that's what it was built for) | **No — zero effect.** That fix only touches `content-check.js`'s `checkClaim()`. This table's flag is set by `backfill-maintenance-snapshot.js`'s own `checkRowContent()`, a separate code path that calls the *old*, pre-redesign `checkClaim()` and never will unless someone wires it in. |

---

## 1. What was queried, and how

- **Table:** `maintenance_snapshot_events`, live Supabase database (`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` from `.env`), queried directly with `@supabase/supabase-js` — not a report, not a sample export.
- **Schema confirmed first** against `supabase/migrations/20260903000000_maintenance_snapshot_events.sql`: the flagged text column is `summary` (TEXT, ≤300 chars) — there is no separate raw `description` column persisted on this table. `backfill-maintenance-snapshot.js`'s own `buildSummary()` embeds the raw AppFolio `description` text verbatim as the first component of `summary` (format: `"{description} — {date}, {amount}, {vendor}"`), and its own `--recheck-existing` mode comment confirms re-checking stored `summary` text is "the same real content Layer 2 would have judged at write time, not a degraded substitute." So reading `summary` is the correct and only available way to see what was actually screened.
- **Total rows in the table:** 11,483. **Rows with `flagged_protected_class = TRUE`: 292** (2.5% of all rows) — small enough for full-coverage review, not a sample.
- **Method, matching the original review's rigor:** fetched all 292 flagged rows in full (summary, flagged_category, review_status, reviewed_by/at, timestamps). Re-ran `lib/protected-class-terms.js`'s real `scanText()` function against each row's stored `summary` text — the same Layer 1 dictionary scan the original 340-record review used — to identify exactly which term(s) matched. Then read every one of the 292 summaries individually to judge, the same way the original review did, whether the flag is a genuine reference to a protected characteristic or a false positive.

Working files (not part of the deliverable, kept for anyone who wants to re-verify): `scratch-docs/oracle-snapshot-investigation-count.js`, `scratch-docs/oracle-snapshot-investigation-fetch.js`, `scratch-docs/oracle-snapshot-flagged-rows.json` (the full 292-row dataset with per-row Layer 1 term matches).

---

## 2. The breakdown, by term (all 292 rows accounted for)

| Term(s) | Category | Unique rows | Genuine | False positive | FP rate | What it's actually catching |
|---|---|---|---|---|---|---|
| `white` | race_color | 131 | 0 | 131 | 100% | Paint color, "Bradford White" water heater brand (~40+ occurrences), appliance/fixture color, vinegar descaling, blinds, curtains |
| `black` | race_color | 59 | 0 | 59 | 100% | Paint/appliance color, black mold, dishwasher power cord color, black-out curtains |
| *(white ∪ black, deduplicated)* | **race_color** | **183** | **0** | **183** | **100%** | — |
| `blind` | disability_health | 50 | 0 | 50 | 100% | Window blinds (the household item) — zero refer to a visually-impaired person |
| `diagnosis` / `diagnosed` | disability_health | 39 | 0 | 39 | 100% | A plumber's or vendor's diagnosis of a mechanical/plumbing fault — zero medical |
| *(blind ∪ diagnosis ∪ diagnosed, deduplicated)* | **disability_health** | **89** | **0** | **89** | **100%** | — |
| `too old` / `too young for` | age | 1 | 0 | 1 | 100% | A door handle/cylinder described as "too old and damaged" — a mechanical part, not a person |
| **Union of all six terms** | — | **271** | **0** | **271** | **100%** | |
| `section 8` *(not one of the six — a Tier A term, unaffected by the approved fix either way)* | source_of_income | 2 | 2 | 0 | 0% | A genuine Section 8 (Housing Choice Voucher) inspection compliance note — matches the original review's own finding that source-of-income has no measurable false-positive problem in this codebase |
| *No Layer 1 term match at all — flagged by the live Layer 2 Haiku call only* | mixed | 19 | 12 | 7 | 37% | See Section 3 below — a different, second pattern |
| **All flagged rows** | — | **292** | **14** | **278** | **95.2%** | |

Two rows matched terms spanning both `race_color` and `disability_health` in the same summary (e.g., "black marks" + "vertical blind wand" in the same sentence) — both are counted once in the union total, and both are false positives on every term they matched.

Every single one of the 271 rows driven by one of the six already-known terms was read individually and is a false positive by the same standard the original review used ("the flagged text has no genuine connection to a protected characteristic"). Representative examples:

- *race_color / white:* "Installation of new Bradford White 50 gallon water heater," "Paint the dining room ceilings in flat white paint," "Purchase new 47x64 white horizontal blinds"
- *race_color / black:* "Purchase and installation of standard black power supply cord for dishwasher," "Found visible black mold activity on ceiling"
- *disability_health / blind:* "Replaced the failing headrail for the vertical blinds," "Uninstall and properly dispose of damaged blind headrail"
- *disability_health / diagnosis:* "Includes an extensive diagnosis to a more complex plumbing problem" (this exact sentence, or a close variant of it, is the vendor's standard invoice line and alone accounts for the large majority of the 39 diagnosis/diagnosed hits)
- *age / too old:* "the handle is too old and damaged and we could not repair it"

---

## 3. The second, different pattern: 19 rows flagged with zero Layer 1 match

These 19 rows are not driven by the six terms, or by any dictionary word at all — `scanText()` found nothing in their `summary` text. They were flagged purely by `backfill-maintenance-snapshot.js`'s own live Layer 2 Haiku classification call (`runLayer2Check()`), a mechanism `maintenance_claims` does not have in this form (its Layer 2 comes from `extract-claims.js`'s self-report during extraction, a different call). This group splits differently than the six-term group:

**12 of 19 (63%) are genuine, correct catches — not false positives:**
- 10 rows: "Installation of Gerber ADA height elongated toilet" (and close variants) — genuinely a disability-accommodation modification.
- 2 rows: "Supply and install new grab bar in shower for accessibility" — genuinely a disability-accommodation modification.

These are real, correct flags in the same sense as counsel's own examples of genuinely-operational protected-class content ("tenant uses a wheelchair, ensure ramp access"). Whether content like this should stay quarantined or be shown normally to staff is the separate, already-flagged "Open Item" in `content-screening-tier-redesign-SPEC.md` (Section 2) — not something this investigation is deciding.

**7 of 19 (37%) are false positives — a pattern the six-term list doesn't cover at all:**
- 2 rows: "Treated for moles" / "Treated for moles, talprid worms" — this is yard/pest-control mole trapping, misread as a genetic-information or disability-health reference (presumably to a skin mole).
- 2 rows: "Replaced 9 x exterior light bulbs in motion detector fixtures. (Resident could not reach or access them)" — ambiguous; nothing in the text states a disability or mobility impairment, most likely just describes a fixture mounted out of easy reach. Flagged here as a false positive on the balance of the text, but noted as the one genuinely borderline call in this entire review.
- 1 row: furnace repair note citing "the age new furnace" — about the equipment's age, not a person's.
- 2 rows: general property-hazard notes ("Visible mold found on ceiling," "duct work is asbestos") — environmental/hazard disclosures about the property, not a statement about any person's health.

This is a real, separate false-positive source specific to this table's own Layer 2 mechanism, and it means "the same six terms" is not a complete description of this table's exposure — a smaller amount of the risk here comes from the model's own free-form judgment mis-firing on ambiguous words the dictionary doesn't even contain.

---

## 4. A data fact worth flagging, found while pulling this data (not an opinion, not a proposed fix)

290 of the 292 flagged rows currently show `review_status = 'confirmed'`, `reviewed_by = 'Peter McKenzie'` (1 `rejected`, 1 `corrected`, both also attributed to Peter McKenzie). Pulling the `reviewed_at` timestamps directly: **289 of the 292 reviews are timestamped within the same four-minute window (2026-09-04, 00:29–00:32 UTC), with 230 of them in the single minute of 00:30.** No row has any `reviewer_notes`.

This is consistent with `backfill-maintenance-snapshot.js`'s own file-header note that a 45-day real (non-dry-run) window was run specifically "to seed real flagged rows for testing the new merged flagged-review queue end-to-end" — i.e., this looks like the flagged-review queue's UI/mechanism being exercised, not a row-by-row content review of the kind the original 340-`maintenance_claims` review actually performed. Stated plainly because it matters for interpreting the numbers above: unlike `maintenance_claims`'s 340 records ("nearly all of which have already been through Rincon's internal human review process" — a real review), the "confirmed" status on these 292 `maintenance_snapshot_events` rows does not appear to reflect anyone having actually read and judged the content. Whether that's fine (it was just a mechanism test) or needs follow-up is Peter's and Asimov's call, not something this investigation resolves.

---

## 5. Why the approved fix doesn't reach this table (confirmed by reading the code, not assumed)

`content-screening-tier-redesign-SPEC.md` (Section 6, "Scope") already flagged this as an open item and this investigation confirms it by tracing the actual code path:

- `maintenance_claims`'s flag comes from `router.js` calling `content-check.js`'s `checkClaim()` (the function the approved Tier A/B redesign modifies).
- `maintenance_snapshot_events`'s flag comes from `backfill-maintenance-snapshot.js`'s own `checkRowContent()`, which calls the **same, but currently un-redesigned**, `checkClaim()` from `content-check.js` — plus its own separate, additional Haiku call (`runLayer2Check()`) that `maintenance_claims` doesn't have.
- Because the Tier A/B redesign is not yet built (per the spec's own status line, "Nothing in this document has been built yet"), *today* both tables call the identical old `checkClaim()` — which is exactly why both tables show the same six-term false-positive pattern. Once the redesign ships for `maintenance_claims`'s call site, `maintenance_snapshot_events`'s own call site is untouched and will keep producing 100% false positives on these six terms indefinitely, unless someone deliberately wires the new logic into `backfill-maintenance-snapshot.js` too.

---

## 6. What this investigation is not saying

Per the brief, this document does not propose or design a fix, does not recommend reusing the `maintenance_claims` Tier A/B mechanism for this table, and does not weigh in on the two-way override, audit-log, or rollout questions a real fix would need. Those are exactly the kind of judgment calls that (per how `maintenance_claims`'s own fix was handled) belong in a fresh spec with its own outside-counsel and governance review — not bundled into a data-investigation document. The one thing this document does say with confidence, backed by full-coverage numbers: the false-positive problem is real here, it is at least as bad as `maintenance_claims`'s on the same six terms (worse, in fact — 100% vs. 91%), and it currently gets zero benefit from tonight's fix.
