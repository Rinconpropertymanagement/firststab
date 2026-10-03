# Cross-Source Radius Tiering — Bug Fix Spec

Status: Approved. Peter reviewed the real 5537 Rainier Street, Ventura report,
flagged the condos, and approved this fix via Jarvis — his exact words: "make
all three sources decide together, as one team, whether they already have
enough close comps — instead of each one deciding for itself. If the combined
result already has enough good nearby matches, none of them go looking
further out." This is Step 2 (PLAN) of the CLAUDE.md pipeline, already past
Step 3 (APPROVE). Q builds directly from this.

## Revision (2026-09-20) — corrects a real regression TARS found

Q built the design below exactly as originally written, and TARS then tested
it against the real 5537 Rainier Street analysis (id
`9ab946b1-2c6b-405a-adbd-d8f1c91f31e1`). The original design's "combined
decision" cut EVERY comp beyond 1 mile, from every source, the moment the
combined pool had enough close comps — with no exception for a far comp that
was actually a good match. That correctly removed the motivating bug (the
1.7–1.9mi condos), but it also removed two comps that were never part of the
bug and were genuinely good evidence: **1148 Colina Vista** (1.10mi,
single_family, an exact 4-bedroom match, LEASED at $5,650 — the stored
rationale for this real analysis calls it "the best match we have") and
**7275 Coolidge Street** (1.47mi, single_family, 3bd — a 1-bedroom
difference, still partial-credit weighted — LEASED at $4,195, called "pulls
the floor down"). Both passed `exclusionReason() === null` (real,
correctly-weighted contributors, not zero-weighted noise) and both are
LEASED comps, the highest-trust `listing_status` this codebase has. Cutting
them purely for being >1 mile away collapsed the recommended range from the
live $4,197.50–$5,650 (a $1,452.50 spread) down to roughly a $100 spread on
the reconstructed data — losing both of the tool's real signed-lease data
points. A real regression, not a nitpick.

Peter approved a corrected design via Jarvis: **the distance cut now only
ever applies to a comp that is ALSO not a genuine match on its own merits**
— wrong property type, or a 2+ bedroom mismatch, i.e.
`exclusionReason() !== null`. A comp that IS a genuine match
(`exclusionReason() === null`) is never cut for being far away; it's shown
and counted at any distance up to the existing 2-mile search ceiling each
source already enforces, exactly as if no cross-source coordination existed
at all. Everything below — "What This Does," "What You'll See," "The Fix"
(sections 2–4), and the Test Plan — has been rewritten to reflect this. The
root cause, sections 1 (per-source cut removal), 5 (wide-bound network calls
unchanged), and 6 (both copies) are unchanged and still accurate.

## What This Does

Today, when the tool runs a rental analysis, each of its three comp sources —
RentCast, CRMLS, and Rincon's own LeadSimple move-in history — separately
decides for itself whether to show only very close comps (within 1 mile) or
widen out to 2 miles, based only on what that one source found. That's the
bug: one source can end up alone, empty-handed, and widen to 2 miles on its
own even though the *other* sources already turned up plenty of good comps
close by — pulling in comps (in the real case that triggered this, condos
1.7–1.9 miles away) that don't belong next to the rest of the report and make
it look unreliable.

After this fix, the three sources still each search out to 2 miles (nothing
about the network calls changes), and once all three have reported back, the
tool looks at everything they found *together* — but the decision it makes
is no longer a single "narrow or wide" switch for every comp. Instead:

- A comp that's a **real match** for the subject property — same property
  type, and no more than a 1-bedroom size difference — is always shown, no
  matter how far away it is (up to the 2-mile search limit already in
  place). Distance never disqualifies a genuine match.
- A comp that was **never a real match to begin with** — wrong property
  type, or a bedroom count 2 or more off from the subject — is the only kind
  of comp that gets cut for being far away, and only once the combined,
  same-source-agnostic pool of genuine matches already has enough close ones
  (4+ within 1 mile) that the report doesn't need a non-matching comp for
  context. If it doesn't have enough genuine matches close by yet, even the
  non-matching far comps stay, for context, exactly like today.

In short: distance decides whether to show a *mismatched* comp. It never
decides whether to show a *matching* one.

## What You'll See

Re-running the 5537 Rainier Street analysis (or any analysis shaped like it)
no longer shows comps that were never real matches to begin with, once the
combined pool of genuine nearby matches is big enough to stand on its own.
If RentCast alone already found 4+ solid same-type comps within a mile,
CRMLS's 1.7–1.9-mile condos — wrong property type, never a real match —
simply won't appear on the report, even though CRMLS itself only found 1
close comp.

But a comp that IS a genuine match — right property type, close enough in
bedroom count — now shows up and counts toward the recommended range no
matter how far away it is, up to the 2-mile search limit. On the real
Rainier Street case, that means two of the tool's best pieces of evidence —
**1148 Colina Vista** (1.1 miles away, an exact 4-bedroom match that leased
for $5,650) and **7275 Coolidge Street** (1.47 miles away, leased for
$4,195) — are back in the report and back in the math, because they're real
matches, just not close ones. The recommended range on that report goes back
to $4,197.50–$5,650, matching what's already live and correct in the
database — it no longer gets artificially narrowed to a ~$100 spread by
discarding the tool's two real signed leases.

In the opposite case — where even combined, the sources don't have enough
close genuine matches — the report still correctly keeps the farther-out,
non-matching comps for context, same as today.

---

## Root Cause (confirmed against current code)

Three files each independently query out to `WIDE_SEARCH_RADIUS_MILES` (2mi,
`lib/constants.js` line 37) in one network call, then locally decide whether
to keep only the `NARROW_SEARCH_RADIUS_MILES` (1mi, line 36) subset:

- **`lib/rentcast.js`**, `applyRadiusTiering()`, lines 144–147 — filters to
  `distance_miles <= 1`; if that subset has `>= MIN_COMPS_FOR_NARROW_RADIUS`
  (4, line 43), keeps only that subset, else keeps everything. Called at
  line 274, inline in `pullRentCastComps()`'s return.
- **`lib/crmls.js`**, lines 315–323, inside `pullCrmlsComps()` — identical
  narrow/wide logic, but only runs on the box-search path
  (`scope.type === 'box'`, i.e. when subject coordinates are known); the
  zip-fallback path has no distance data to tier on.
- **`lib/leadsimple.js`**, lines 188–206, inside `pullLeadSimpleComps()` —
  same logic again, gated on `hasSubjectCoords`, applied on top of the
  already zip-scoped rows fetched from `leadsimple_new_leases`.

The combination point is **`lib/sources.js`**, `runActiveSources()`
(lines 65–124). It calls each source's handler in sequence (RentCast first,
per the comment at lines 48–59, so its geocode can feed CRMLS/LeadSimple) and
simply concatenates whatever comps each handler already decided to return
(line 96: `allComps.push(...comps)`). By the time `runActiveSources()` sees
any comps, each source has already thrown away its own "wide" data if it
individually judged itself close enough — there is no point where the three
sources' findings exist together *before* that per-source cut happens.

Confirmed live: on the 5537 Rainier Street analysis (subject id
`9ab946b1-2c6b-405a-adbd-d8f1c91f31e1`), RentCast found 4 solid same-type
comps within 1 mile and (correctly, in isolation) stayed narrow. CRMLS found
only 1 comp within 1 mile on that same run, so CRMLS alone widened to 2 miles
and pulled in 1300 Saratoga Ave (units), 1237 Saratoga Ave, and 3700 Dean —
condos at 1.71–1.91 miles, shown on a report for a hillside single-family
home. `lib/weighting.js`'s `propertyTypeMultiplier()` already zero-weights
these in the actual rent-range math (confirmed separately, the computed range
is unaffected) — this is a "which comps get shown at all" bug, not a math
bug.

---

## The Fix

### 1. Sources stop deciding for themselves — already done, unchanged by this revision

This part of the original fix is complete and this revision doesn't touch
it. Confirmed in the current code: `lib/rentcast.js`'s module header (lines
29–37), `lib/crmls.js`'s (lines 33–42), and `lib/leadsimple.js`'s (lines
39–52) all now document that they return their full result out to
`WIDE_SEARCH_RADIUS_MILES` and no longer make a narrow/wide decision
themselves. `applyRadiusTiering()` is gone from `lib/rentcast.js` (its
`pullRentCastComps()` now just returns `comparables.map(mapComparable)`, no
narrow/wide functions or unused constants left in its `require('./constants')`
on line 46). The per-source narrow/wide block is gone from `lib/crmls.js`'s
`pullCrmlsComps()` (it maps `comps` straight off the box-corner circle
filter, lines 307–315 — that filter enforces the real 2mi circle and is not
part of either version of this bug). The tiered branch is gone from
`lib/leadsimple.js`'s `pullLeadSimpleComps()` (it maps `bounded` directly,
lines 194–212). Nothing in this section needs to change for this revision —
only the coordination step in `lib/sources.js` (section 2 below) does.

### 2. The combined coordination step in `lib/sources.js` — corrected logic

`applyCombinedRadiusTiering(comps, subject)` already exists in
`lib/sources.js` (currently lines 74–85, with its JSDoc at lines 41–73),
called once from `runActiveSources()` on the full merged list (currently
line 171: `return { comps: applyCombinedRadiusTiering(allComps, subject),
... }`). Keep the function name, its signature, where it's exported (line
174), and where it's called from — only the decision logic inside the
function body changes.

Replace the current logic (count everything within 1 mile that passes
`exclusionReason()`, and if that clears the threshold, cut EVERY comp beyond
1 mile — the design that caused the regression above) with a per-comp rule:

1. A comp is a **genuine match** when
   `exclusionReason(comp, subject.bedrooms, subject.propertyType) === null`
   — same call as today, right property type, no more than a 1-bedroom
   difference. **A genuine match is never removed by this function**,
   regardless of its `distance_miles` (present, absent, or beyond 1 mile) —
   it survives exactly as it would if this function didn't exist at all,
   all the way out to the 2-mile bound each source already enforces on its
   own.
2. Count how many genuine matches have a real
   `distance_miles <= NARROW_SEARCH_RADIUS_MILES`
   (`typeof c.distance_miles === 'number' && c.distance_miles <=
   NARROW_SEARCH_RADIUS_MILES`, same numeric check as today). Call this
   `genuineNearbyCount`, computed once, up front, over the full merged list.
3. A comp that is **not** a genuine match (`exclusionReason() !== null` —
   wrong property type, or a 2+ bedroom mismatch) is the only kind of comp
   this function can remove:
   - If `genuineNearbyCount >= MIN_COMPS_FOR_NARROW_RADIUS`: drop it unless
     it itself has a real `distance_miles <= NARROW_SEARCH_RADIUS_MILES` —
     the report already stands on its own with enough good nearby matches,
     so a non-matching comp only stays if it's ALSO genuinely close. A
     non-matching comp with no `distance_miles` at all is dropped here too
     (can't be proven close — see judgment call #3).
   - If `genuineNearbyCount < MIN_COMPS_FOR_NARROW_RADIUS`: keep it — not
     enough good nearby matches yet, so the report still needs the
     farther/non-matching comps for context, same as today's "genuinely
     wide" case.

Equivalent to filtering `comps` with:
```
comp => isGenuineMatch(comp)
  || genuineNearbyCount < MIN_COMPS_FOR_NARROW_RADIUS
  || (typeof comp.distance_miles === 'number' && comp.distance_miles <= NARROW_SEARCH_RADIUS_MILES)
```
where `isGenuineMatch(comp) = exclusionReason(comp, subject.bedrooms,
subject.propertyType) === null` and `genuineNearbyCount` is computed once,
up front, exactly as in step 2 above.

Same requires as today — `MIN_COMPS_FOR_NARROW_RADIUS`/
`NARROW_SEARCH_RADIUS_MILES` from `./constants`, `exclusionReason` from
`./weighting` — no new imports needed; only the function body changes.

### 3. Judgment call — does a comp with no `distance_miles` count, and does it survive?

This now splits by whether the comp is a genuine match, where the original
design didn't:

- **A genuine match with no `distance_miles`** now always survives — same as
  every genuine match, this function never removes it, whether or not its
  distance is known. This is a real change from the original design (its
  judgment call #3 dropped a no-distance comp whenever the combined decision
  went narrow). Under the corrected design there's no single narrow/wide
  switch anymore — only a per-comp check that only ever applies to
  non-matching comps — so a genuine match's missing distance is simply
  irrelevant to whether it's shown, exactly as irrelevant as its exact
  distance already is.
- **A non-matching comp with no `distance_miles`** is dropped whenever
  `genuineNearbyCount >= MIN_COMPS_FOR_NARROW_RADIUS` (same "can't prove it
  belongs" reasoning the original design used), and kept otherwise. It's
  never counted toward `genuineNearbyCount` either way — a comp with unknown
  distance can't prove the report already has enough close matches. This
  part is unchanged from the original design, just now scoped to
  non-matching comps specifically, since only genuine matches ever counted
  toward the threshold to begin with.

### 4. Judgment call — `exclusionReason()` now decides two things, not one

In the original design, `exclusionReason()` was used only to decide whether
a within-1-mile comp counted toward `MIN_COMPS_FOR_NARROW_RADIUS`. In the
corrected design it does that AND decides whether a comp is even eligible to
be cut by distance at all — those must be the exact same check, or the fix
could quietly diverge from its own definition of "genuine match" between the
two places it's used. Reuse `exclusionReason()` exactly as it exists today
(`lib/weighting.js` lines 206–211) for both — don't reimplement its logic
and don't add a second, differently-defined check.

The reasoning from the original design for why `exclusionReason()` is the
right check still holds and doesn't need to change:

- **Property type** has no partial-credit tier in this codebase
  (`propertyTypeMultiplier()` is either 1 or 0 — "a townhouse isn't
  'somewhat comparable' to a single-family house"). A wrong-type comp isn't
  a genuine match at any distance, the same reason it wasn't countable
  toward the threshold before. An **unknown** property type (either side
  null) is NOT treated as a mismatch — same "don't punish missing data"
  rule `exclusionReason()` already applies — so it's still a genuine match,
  shown/counted at any distance. This directly matters for RentCast/CRMLS
  comps whose type didn't map cleanly (see each file's own
  `FROM_..._PROPERTY_TYPE` "leave null rather than guess" comment).
- **Bedrooms**: same reuse of `exclusionReason()`, which only excludes a
  2+-bedroom mismatch — a 1-off comp is still a genuine match here (it gets
  partial credit in the range math, and it's never cut by distance under
  this fix either, same as 7275 Coolidge Street in the real regression
  case above).
- **Rincon-managed status is still a structural no-op here, on purpose.**
  `exclusionReason()` checks `is_rincon_managed` first (line 207), but that
  field isn't set yet at this point in the pipeline — `server.js` only sets
  it after `runActiveSources()` returns, via `findBestPropertyMatch()`
  (server.js lines ~504–505). Every comp passed into
  `applyCombinedRadiusTiering()` has `is_rincon_managed` undefined, so that
  branch of `exclusionReason()` still can't fire here — unchanged from the
  original design. `excludeRinconManaged()` still fully re-applies
  downstream regardless of which comps survive this step. This function
  still only needs `subject.bedrooms` and `subject.propertyType`, both
  already present on the `subject` object `runActiveSources(activeSources,
  subject)` receives — no new data has to be threaded through.

Same explicit non-goal as before, also unchanged: this function still does
**not** deduplicate the same real address reported by two different sources
before computing `genuineNearbyCount` (that's `dedupeComps()`'s job, in
`lib/property-matching.js`, which runs later in `server.js` and needs
`is_rincon_managed` — not available yet at this point either, per above). In
practice RentCast/CRMLS/LeadSimple draw from distinct pools so an exact
duplicate address surviving into this count is rare, and this fix doesn't
make that theoretical risk any worse than it is today. Not addressing it
here is a deliberate scope decision, not an oversight — flagging it so
Judge/TARS don't treat it as a miss.

### 5. Wide-bound network calls do not change

Confirmed as in-scope-to-preserve, not in-scope-to-touch: `maxRadius` in
`lib/rentcast.js` line 232, the bounding box in `lib/crmls.js`
`buildBoundingBox()`/line 267, the box-corner circle filter at lines
303–311, and the `WIDE_SEARCH_RADIUS_MILES` cap in `lib/leadsimple.js` line
203 all stay exactly as they are. No source will ever fetch or keep a comp
beyond 2 miles after this fix, same as today — only which comps get cut
back to 1 mile, and who decides that, changes.

### 6. Both copies need this fix, identically

`projects/rental-analysis/lib/` and `projects/hub/rental-analysis/lib/` are
mirrored — confirmed via `diff -rq` that every file under `lib/` (including
`constants.js`, `sources.js`, `rentcast.js`, `crmls.js`, `leadsimple.js`,
`weighting.js`) is currently byte-identical between the two, even though the
two projects have different entry points (`server.js` in the standalone
copy vs. `router.js` in the Hub-mounted copy). Apply every change in this
spec to both `lib/` directories, identically, same as every prior build in
this project's history (CRMLS, LeadSimple). Only `projects/rental-analysis/`
has `q-mapping-unit-test.js` — the Hub-mounted copy has no test suite of its
own, so the test-plan changes below are made once, in the standalone copy,
and validate the shared `lib/` logic for both.

This revision replaces the already-shipped `applyCombinedRadiusTiering()`
logic inside `lib/sources.js` in both trees (re-confirmed still
byte-identical between the two copies as of this revision). Same
requirement applies: change both copies identically, not just the
standalone one, or the Hub-mounted tool keeps the regression this revision
fixes.

---

## What Q Needs to Build This

No new dependencies, no schema changes (Neo not needed), no new environment
variables. Pure refactor of existing logic already living in `lib/rentcast.js`,
`lib/crmls.js`, `lib/leadsimple.js`, and `lib/sources.js`, reusing
`lib/weighting.js`'s existing `exclusionReason()`. Touches only files already
listed above, in both `projects/rental-analysis/` and
`projects/hub/rental-analysis/`.

This revision is narrower still: it only changes the decision logic inside
the already-existing `applyCombinedRadiusTiering()` function in
`lib/sources.js` (both copies) — no new files, requires, or exports beyond
what that function already has.

---

## Test Plan

All in `q-mapping-unit-test.js` (standalone copy only — see "Both copies"
above). The section-1 test rewrites from the original build (the
`lib/rentcast.js`/`lib/crmls.js`/`lib/leadsimple.js` "always returns the
full <=2mi set" tests, now at their own `--- ... ---` headers around lines
1007, 1564, and 1731) are unaffected by this revision and need no further
change — they test the per-source behavior from section 1 above, which this
revision doesn't touch.

The `applyCombinedRadiusTiering()` / `runActiveSources()` tests, under
`--- lib/sources.js applyCombinedRadiusTiering() / runActiveSources() cross-
source radius coordination ---` (currently line 1274), were written against
the original (regressed) design and need to change as follows:

- **Keep, unchanged** (all still pass under the corrected logic, verified by
  hand — see reasoning below): the real-bug-scenario test (lines 1276–1309,
  "RentCast alone finds enough close comps..."), the genuinely-wide test
  (1311–1320), the type-mismatch-doesn't-count test (1322–1331), and the
  unknown-type-counts test (1333–1344). None of these four happen to include
  a genuine match beyond 1 mile, so their existing assertions hold under
  both the old and corrected designs — but note in a comment on the first of
  these that they no longer exercise the one behavior this revision changes
  (see the new test below).
- **Strengthen** (lines 1346–1356, "comps with no distance_miles never push
  it narrow, but survive in the wide result"): this test's assertions still
  pass unchanged, but for a different reason than before — the no-distance
  comp here is a genuine match (`property_type: 'single_family'` matching
  the subject), so under the corrected design it survives unconditionally,
  not because the combined count happened to stay under threshold. Add a
  second case to this test (or a new one right after it) with enough OTHER
  genuine nearby comps to push `genuineNearbyCount >= MIN_COMPS_FOR_NARROW_RADIUS`,
  and confirm the genuine no-distance comp *still* survives — this is the
  one assertion that would have failed under the original design's judgment
  call #3 and needs its own coverage. Also add a case with a NON-genuine
  no-distance comp (e.g. `property_type: 'condo'` vs. a `single_family`
  subject, `distance_miles: null`) alongside enough genuine nearby comps to
  clear the threshold, and confirm that one IS dropped — the mirror case.
- **Rewrite the assertions** (lines 1358–1371, "going narrow drops every
  comp beyond 1mi network-wide..."): this test's core assertion is now
  **wrong** under the corrected design and must be flipped. All 6 comps in
  its current mock are `property_type: 'single_family'` — the same type as
  the subject, so every one of them is a genuine match, including the
  RentCast comp at 1.6mi and the LeadSimple comp at 1.8mi. Hand-traced under
  the corrected logic: `genuineNearbyCount` is still 4 (the four within
  1 mile), clearing the threshold, but since nothing in this mock is
  non-genuine, **all 6 comps now survive** — the opposite of the old
  assertion (`result.length === 4`, 1.6mi comp dropped). To keep this test
  meaningful, add a 7th comp that's genuinely non-matching and beyond 1 mile
  (e.g. `{ source_name: 'RentCast', property_type: 'condo', distance_miles: 1.6 }`)
  and rewrite the assertions to: `result.length === 6`; the original 1.6mi
  `single_family` RentCast comp IS present (flipped from the old test); the
  newly-added 1.6mi `condo` is NOT present. That combination is what
  actually proves the cut is scoped to non-matches only, which the old test
  never checked (it never included a genuinely non-matching comp at all).

New test, added right after the above, for the exact regression TARS found:

- **The Rainier Street regression — genuine matches beyond 1 mile survive
  and the range recomputes correctly.** Reconstruct the real
  `9ab946b1-2c6b-405a-adbd-d8f1c91f31e1` analysis's comp set (pull the
  actual `rental_comps` rows for that analysis, or match their key fields by
  hand from the live `rental_analyses` row): RentCast's 4 close same-type
  comps within 1 mile, CRMLS's 480 Day Road at 0.44mi (`single_family`,
  genuine), **1148 Colina Vista at 1.10mi** (`single_family`, 4 bedrooms,
  `listing_status: 'leased'`, `monthly_rent: 5650`), **7275 Coolidge Street
  at 1.47mi** (`single_family`, 3 bedrooms, `listing_status: 'leased'`,
  `monthly_rent: 4195`), and the three condos at 1.71–1.91mi
  (`property_type: 'condo'`, non-genuine). Subject: `single_family`,
  4 bedrooms (matching Colina Vista's "exact 4-bedroom match" and
  Coolidge's "1 off" as described in the live rationale). Assert:
  - `1148 Colina Vista` and `7275 Coolidge Street` are both present in
    `runActiveSources()`'s returned `comps`.
  - The three Saratoga/Dean condos are still absent (the original bug fix
    must still hold).
  - Feeding the surviving comps into `computeRecommendedRange()` (from
    `lib/weighting.js`, already imported by this test file) with
    `subjectBedrooms: 4, subjectPropertyType: 'single_family'` produces
    `low: 4197.50, mid: 4500, high: 5650` — the figure already live and
    correct in the `rental_analyses` row for this analysis. If the
    reconstructed mock data doesn't reproduce that exact figure, pull the
    real comp rows rather than adjusting the assertion — the live number is
    the ground truth here, not a rounded approximation.

This is a direct regression test for what TARS found, and should replace
the old "going narrow drops every comp beyond 1mi network-wide" test as the
project's primary Rainier-Street-shaped coverage, alongside the rewritten
version of that test described above.

Also required before calling this done — unchanged in spirit, corrected in
expectation: re-run (or reconstruct from the live `rental_analyses`/
`rental_comps` rows for subject `9ab946b1-2c6b-405a-adbd-d8f1c91f31e1`) an
actual analysis shaped like the 5537 Rainier Street case and confirm by
hand that (a) the 1300 Saratoga Ave / 1237 Saratoga Ave / 3700 Dean condos
still don't appear in the output, (b) 1148 Colina Vista and 7275 Coolidge
Street do appear, and (c) the recommended rent range matches the live
$4,197.50 / $4,500 / $5,650 figure — not "unchanged from before this fix"
as the original Test Plan said, since the original (regressed) design's
output was itself wrong. This is TARS's job per the pipeline, not Q's, but
Q should leave the mock data for the new Rainier Street test above shaped
closely enough to the real case that TARS can reuse it directly.

## What Could Go Wrong

- **A genuine match near the 2-mile edge now always shows up, even on an
  otherwise "tight" report.** A report can have 5 genuine matches within a
  few tenths of a mile AND a 6th genuine match at 1.9 miles — all six now
  show and count, because distance never cuts a genuine match. This is the
  explicit, intended fix (it's exactly what brings 1148 Colina Vista and
  7275 Coolidge Street back), not a bug — but it does mean "the combined
  decision went narrow" no longer means "every comp on the report is close,"
  only "every comp is either close or a real match." Worth TARS doing one
  sanity pass on a real report to confirm this reads as "more evidence,"
  not as "why is there a comp 2 miles away on a report that otherwise looks
  tight."
- **A source that used to return only 4 comps now returns up to ~20**
  (RentCast's `DEFAULT_COMP_COUNT`, CRMLS's `COMPS_PER_STATUS * 2`) on every
  analysis, not just the ones that go wide — because every source's own
  narrow cut is gone (section 1, unchanged by this revision), `allComps` in
  `runActiveSources()` is larger before `applyCombinedRadiusTiering()` runs,
  even on analyses that end up narrow in the end. This is expected and
  intended, but it does mean slightly more `rental_comps` rows get inserted
  temporarily in memory before the cut removes some of them — not a real
  performance concern at this data volume, just worth TARS confirming
  nothing downstream (e.g. `dedupeComps()`, the narrative-writing Claude
  call) assumes it's only ever handed an already-small list.
- **Forgetting the Hub-mounted copy.** Both `lib/` trees must change
  identically for this revision too. If Q only edits
  `projects/rental-analysis/lib/sources.js`, Hub-mounted analyses keep the
  regressed (original-design) behavior and TARS's finding stays live there.
- **Silent regression if judgment call #4's dual role is missed.** If Q
  keeps using `exclusionReason()` only to compute `genuineNearbyCount` but
  doesn't also use it to decide which comps are exempt from the distance
  cut, this revision doesn't actually fix anything — every far comp,
  including genuine matches, would still get cut once the threshold clears,
  which is the exact regression TARS found. The new Rainier Street test
  above exists specifically to catch that: it fails loudly (Colina
  Vista/Coolidge missing) if this happens.
- **Silent behavior change if judgment call #4's "unknown isn't a
  mismatch" rule is skipped.** If Q treats an unknown property type as a
  mismatch instead of reusing `exclusionReason()` as-is, a comp with
  unmapped type data could be wrongly treated as non-genuine and become
  eligible for the distance cut it shouldn't be subject to. The
  unknown-type-counts test (existing, kept unchanged above) exists to catch
  that.
