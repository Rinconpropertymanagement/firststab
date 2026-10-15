# Comp Coverage Fix — Build Spec

Status: Peter approved the plan (relayed by Jarvis). Q builds from this, then TARS and Judge verify.
Not a compliance build: internal rent-comp tool, no new tenant data, no decision about a person.

**Base code:** the working-tree files in `projects/rental-analysis/` and `projects/hub/rental-analysis/` (byte-identical to what is live on Sally; `diff -rq` on the two `lib/` folders prints nothing). Do NOT diff against, or rebase onto, `origin/main` — it regressed and is being handled separately. Baseline test suite before this build: `node q-mapping-unit-test.js` = 174 passed, 0 failed.

---

## What This Does

Peter ran 2461 Bunting Avenue and a colleague's manual comp search found good comparables the tool never showed him. Three causes, all fixed here:

1. **RentCast was only asked for its "10 most similar" rentals.** It also has a full listings search that returns every active and recently-removed rental near the address. The tool will now call that too (one extra RentCast request per report).
2. **The MLS (CRMLS) lookup filled its 10 slots with the wrong things.** It grabbed the 10 newest closed leases in a 2-mile box, then filtered afterwards, so condos, duplexes and townhouses crowded out a near-perfect match (7560 Lemur Street, leased $3,800 on 9/2, 0.81 mi). The lookup will now ask the MLS only for leases that could actually be comparable, and look at far more of them. Duplexes were also being mis-labelled "unknown type" and counted as matches for a single-family house; that label is fixed.
3. **The search radius was too wide.** The tool will now start at 0.5 mile and only widen (1, then 1.5, then 2 miles) until it has enough solid evidence: at least 4 genuine comps AND at least 2 confirmed leases inside that distance. Everything beyond the distance it stops at is dropped, including good matches, because by then the closer comps already carry confirmed leases. If it never finds enough, it uses the full 2 miles like today.

## What You'll See

- Same form, same report. Nothing new on screen.
- Bunting should now list 6630 Sora St (active, $4,195), 6552 Partridge Dr (off market, $3,995) and 7560 Lemur St (leased, $3,800, shown once), and the report stops at 1 mile, so the $7,900 off-market outlier at 352 Paine Ave (1.77 mi) disappears.
- Most reports will be built on comps within 0.5 to 1 mile. Reports will show fewer "not used" rows, because comps that cannot count (wrong type, wrong size) are mostly no longer fetched in the first place.
- **Recommended rents will move for many addresses**, and not only because of the radius: the tool now finds leases it used to miss. See the data below and Decision 3.
- No change to how you run it.

## Decisions for Peter (Jarvis: please ask in plain words)

1. **RentCast plan.** Each report costs 1 more RentCast request (table below). Peter's plan is unknown, but 42 reports completed in September alone, which is about 84 requests at the old cost if each used the pre-fill lookup (42 at the very least), more than the free 50. So he is probably on a paid plan or paying overage. RentCast's pricing page (checked 2026-10-14): Developer $0 for 50 requests then $0.20 each; Foundation $74/mo for 1,000; Growth $199/mo for 5,000. At his September pace the extra cost is about 42 requests/month, either $8.40 of overage or nothing on a paid plan. Please confirm his plan on the RentCast dashboard.
2. **How far back should comps go?** Recommended: **6 months** for market leases and listings (CRMLS closed leases, RentCast listings), constants in one line each. LeadSimple move-ins stay at 24 months, as Peter set. Why not 12: I tested it. With 12 months, Rainier's hillside area pulls in $8,500 and $9,500 leases from last winter and the range balloons to $4,500 / $6,500 / $8,500; with 6 months it is $4,275 / $4,500 / $4,700.
3. **Expect different numbers.** I replayed the 27 saved subjects that have coordinates using the real MLS data under the new filter, plus their saved RentCast and LeadSimple comps, plus the new ladder (this does not include the new RentCast listings, which add more comps). Result at 6 months: stops at 0.5 mi: 16 reports, 1 mi: 8, 1.5 mi: 1, 2 mi: 2. The recommended midpoint moves by $100 or less for 8, by $100–250 for 7, and by more than $250 for 12 (largest: Villamonte condo −$1,105, Charleston Place −$745, Coronado duplex +$700). Examples (low/mid/high, before to after): Bunting 3950/4350/4500 to 3950/4400/4500; Rainier 4197.5/4500/5650 to 4275/4500/4700; Dorrit 4425/4800/4900 to 4250/4900/5200. Most of the movement is the MLS fix and the Duplex fix, not the radius. Recommend Peter eyeball 4 or 5 re-runs (TARS produces a side-by-side) before deploy.
4. **Optional: is 4 comps enough to stop at 0.5 mi?** Peter's rule is 4 genuine + 2 leased, and 16 of 27 reports now stop at the first rung, some with exactly 4 comps (thin). Raising the minimum to 6 gives stops of 8 / 16 / 0 / 3. It is a one-number change, but that number is also the "few comps" cutoff in `lib/narrative.js`. Default in this spec: keep 4.
5. **Noticed, not fixing unless asked:** the subject property sometimes shows up as its own comp (19 of 1,320 saved comps, e.g. 1895 Dorrit St listed on CRMLS). This build adds a guard only to the NEW RentCast listings path (below).

---

## How It Works (one analysis, after the build)

1. Form posts to `/run`. `runActiveSources()` (lib/sources.js) runs RentCast first, as today.
2. RentCast request 1, the existing AVM call (unchanged): rent estimate, subject coordinates, zip, plausibility check, 10 similar comps.
3. RentCast request 2, NEW listings search around those coordinates: Active and Inactive rentals within 2 mi, same property type, bedrooms within 1, listed in the last 180 days. Mapped to the same comp shape. Inactive maps to `off_market` (weight 1), never `leased`.
4. CRMLS (Recore) runs with the same coordinates: closed leases of the last 6 months plus active listings, filtered server-side to a compatible property type and bedroom count, up to 200 per status (Recore's maximum page).
5. LeadSimple Move-Ins runs as today.
6. `applyCombinedRadiusTiering()` runs the ladder over the merged list and keeps only comps inside the rung it stops at.
7. Unchanged from here: `server.js` / `router.js` match addresses to Rincon properties, `dedupeComps()` collapses same-address duplicates, ranges are computed, narrative is written, rows are saved.

## What Could Go Wrong

- **Numbers move a lot for old addresses** (Decision 3). Mitigation: TARS side-by-side, Peter reviews before deploy.
- **RentCast request exhaustion.** If the monthly cap is hit, the AVM call fails and the whole RentCast source fails (existing behavior). One more request per report brings that day closer. The listings call itself never fails an analysis (see Part 1 error rules).
- **Thin samples at 0.5 mi.** Decision 4.
- **The ladder counts Rincon-managed comps** because `is_rincon_managed` is only set later in `server.js`; those comps are excluded later from the math. In the replay this flipped one subject (Haley Point townhouse: stops at 0.5 with the flag unset, at 2 mi with it honored). Same limitation PR #8 documented; not fixed here. Optional follow-up: pass the properties list into `runActiveSources`.
- **Many more comps reach the narrative step** (CRMLS up to 200 per status, RentCast up to 500). After the ladder it is usually 10–40, but a no-lease area falling back to 2 mi can reach 80+. `lib/narrative.js` caps output at 8192 tokens and a cut-off response silently loses the rationale. Mitigation required in this build: raise `max_tokens` to 16000 (one line) and TARS verifies on the largest run.
- **Recore filter syntax or page cap changes.** Verified live today (see Appendix). Unit tests pin the exact strings. If a page returns exactly 200 rows, log a warning (possible truncation); do not paginate.

---

## What Q Needs to Build This

No new dependencies, no schema change (Neo not needed: `distance_miles` is `NUMERIC(6,2)`, already fine), no new env vars, no new UI. Not touched: `lib/weighting.js`, `lib/property-matching.js`, `lib/leadsimple.js`, `lib/market-data.js`, both dashboards. Apply every `lib/` change **identically** to `projects/rental-analysis/lib/` and `projects/hub/rental-analysis/lib/`, then confirm `diff -rq` prints nothing. Q does not commit, merge or deploy; Peter approves each separately.

### Part 1 — RentCast full listings search (`lib/rentcast.js`)

Facts (RentCast docs read 2026-10-14; marked V where I confirmed with a live call):
- `GET /v1/listings/rental/long-term`. Omitting `status` returns **Active only** (default). `status=Active|Inactive` (pipe = multiple values) returns **both in one request** (V: 500 rows back, 52 Active + 448 Inactive, `x-total-count: 1334`).
- Each listing carries (V, 500/500 sampled): `formattedAddress`, `addressLine1/2`, `city`, `state`, `zipCode`, **`latitude`, `longitude`** (present on all 500), `propertyType`, `bedrooms`, `bathrooms`, `squareFootage`, `status`, `price`, `listingType` (Standard / New Construction), `listedDate`, `removedDate`, `createdDate`, `lastSeenDate`, `daysOnMarket`, `history`. It has **no `distance`** (AVM comps do), so distance must be computed.
- Filters (V): `propertyType` (e.g. `Single Family`), `bedrooms=3:5` (inclusive range, colon), `daysOld=180` (a single value is a maximum; in my test the oldest listed date came back 178 days old), `radius` (max 100), `limit` (1–500), `includeTotalCount=true` (adds an `x-total-count` header at no extra request). Results come back unsorted.
- Same search, Bunting subject, `radius=2`: 1,334 rows unfiltered; **74 rows** (12 Active, 62 Inactive, all Single Family, 58×3bd, 15×4bd, 1×5bd) with `propertyType=Single Family&bedrooms=3:5&daysOld=180`. Contains 6630 Sora St (Active, 0.52 mi, $4,195, listed 2026-10-02), 6552 Partridge Dr (Inactive, 0.66 mi, $3,995, removed 2026-09-27) and also 7560 Lemur St (Inactive, 0.81 mi, $3,800).
- RentCast does not define "Inactive". It means no longer listed, not a confirmed lease.

Build:
1. **Order:** inside `pullRentCastComps(subject)`, after the AVM response passes `assessPlausibility()` and subject lat/long are extracted, call a new `pullRentCastListings(subject, lat, lon)`. Skip it (log one line) when lat/lon are not both numbers. If the AVM call throws, the listings call is never made (so a failed AVM costs exactly 1 request).
2. **Request params, exactly:**
   - `latitude`, `longitude` = the AVM's `subjectProperty` coordinates
   - `radius` = `WIDE_SEARCH_RADIUS_MILES` (2)
   - `status` = `Active|Inactive`
   - `propertyType` = `TO_RENTCAST_PROPERTY_TYPE[subject.propertyType]`; omit the param when unmapped (`other`)
   - `bedrooms` = `${max(0, B − (BEDROOM_MISMATCH_THRESHOLD − 1))}:${B + (BEDROOM_MISMATCH_THRESHOLD − 1)}` with B = `subject.bedrooms`. For a 4-bed that is `3:5`; for a studio `0:1`. Import `BEDROOM_MISMATCH_THRESHOLD` from `./weighting`; do not hard-code 1.
   - `daysOld` = new constant `LISTINGS_DAYS_OLD = 180`
   - `limit` = new constant `LISTINGS_LIMIT = 500`
   - `includeTotalCount` = `true`
   - Header `X-Api-Key`, same as the AVM call. Build with `URLSearchParams` (it encodes `|` as `%7C`; verified accepted).
3. **Why 180 days:** Inactive listings carry no confirmed rent and weigh 1, so 6 months matches the CRMLS window (Decision 2) and keeps Bunting at 74 rows. My unfiltered all-time view was 1,334 rows. A longer window brings in last year's market. Active listings older than 180 days are also dropped; that is acceptable (stale asking prices).
4. **Bedroom filter caveat (accepted):** a RentCast listing with no bedroom count is excluded server-side, which differs from the house rule "unknown is not a mismatch". RentCast listings essentially always carry bedrooms (0 missing in 500 sampled). Property type is never unknown on RentCast.
5. **Mapping:** new `mapListing(listing, subjectLat, subjectLon)` that sets `distance` = `haversineMiles(subjectLat, subjectLon, listing.latitude, listing.longitude)` when both listing coordinates are numbers (else leave undefined so it maps to null), then calls the existing `mapComparable()`. Reuse the existing `mapListingStatus()`: `Active` to `active`, anything else to `off_market`. `leased_date` stays the date-only `removedDate`; `is_estimated_price` false. Import `haversineMiles` from `./crmls` (same as `lib/leadsimple.js`; no import cycle).
6. **Row filters after mapping (in this order):** drop if `price` is not a number; drop if `distance_miles` is a number greater than `WIDE_SEARCH_RADIUS_MILES`; drop if `addressesMatch(subject.address, listing.address)` (from `./property-matching`; the subject must not appear as its own comp on this new path). Keep listings with no coordinates (distance null), same as CRMLS.
7. **Error rules:** the listings call must never throw. Non-OK status (including 429), network error, bad JSON, or a non-array body: `console.warn` a one-line message and return `[]`. If `x-total-count` (read only if `res.headers && res.headers.get` exist; existing test mocks have no headers) is greater than the number of rows returned, warn once about truncation. Do not paginate (each page is another billable request).
8. **Return shape unchanged:** `comps = [...avmComps, ...listingComps]`. AVM comps first so the tie-break in `dedupeComps()` (first seen wins) is stable.
9. **AVM call: do not change.** Keep `compCount=10`, `maxRadius=2`. Dropping to 5 saves no requests (RentCast's pricing is per request: its pricing page lists included requests and a per-request overage price, and says nothing about charging per row) and RentCast documents `compCount` as the number of comps used in the rent estimate, so it could shift `subject_estimated_rent`, which is shown on the report and fed to the narrative. The AVM comps are free and still useful; dedupe handles the overlap. Update the header comment and the `DEFAULT_COMP_COUNT` comment accordingly (they currently say the listings search is deliberately not used, and that a report costs one request).
10. **Update the stale budget comments** in `lookupPropertyDetails()` ("TWO RentCast requests") and, comment-only, in `server.js` (header lines 25–29, `--help` line 88, route comment lines 284–288). `router.js` has no such comments.
11. **Exports to add:** `pullRentCastListings`, `mapListing`, `LISTINGS_DAYS_OLD`, `LISTINGS_LIMIT`.

**RentCast requests per report**

| Request | Before | After |
|---|---|---|
| `/properties` pre-fill (when the form's lookup button or an autocomplete pick is used) | 0–1 | 0–1 |
| `/avm/rent/long-term` | 1 | 1 |
| `/listings/rental/long-term` (one call, both statuses) | 0 | **1** |
| `/markets` (only if the zip's cached row is missing or older than 7 days; runs after the report is saved) | 0–1 | 0–1 |
| **Typical (pre-fill + AVM [+ cache hit])** | 2 | **3** |
| Range | 1–3 | 2–4 |

Peter was told a report would cost about 3 instead of 1; because one call returns both statuses, the core pull is 2 instead of 1. Smallest possible: this is it, short of dropping features. (Not in scope: raising `FRESHNESS_WINDOW_DAYS` from 7 would cut `/markets` calls.) I used 2 of my 3 allowed live RentCast requests.

**Dedupe (confirmed by reading `dedupeComps()`):** it matches on address (`addressesMatch()`: house-number gate, unit gate, normalized street suffix and direction, 0.6 word overlap), so RentCast "7560 Lemur St, Ventura, CA 93003" matches CRMLS "7560 Lemur Street, Ventura, CA 93003". Which copy wins: (0) the copy that is not excluded by `exclusionReason()`; (1) higher status weight, so a CRMLS/LeadSimple **leased** copy beats a RentCast `off_market` copy regardless of order (Lemur: CRMLS $3,800 leased wins over RentCast $3,800 Inactive); (2) tie: trusted self-sourced source (LeadSimple); (3) tie: the copy that has a distance; (4) tie: first seen (RentCast runs first, so an AVM comp beats its identical listings-search twin). No change to `dedupeComps()` is needed.

### Part 2 — CRMLS relevance filtering and Duplex mapping (`lib/crmls.js`)

**Decision: filter on the server AND over-fetch, with a date floor.** Why: Recore has no distance sort, so any plain cap is arbitrary. In Bunting's 2-mile box there are 400 closed leases all-time; the 10 newest today are 5 single-family and 5 duplex/condo/townhouse, and Lemur is the 13th. Over-fetching alone would catch Lemur here but fail again in a denser area. Filtering alone with `$top=10` still picks the 10 newest across the whole box rather than the nearest. Filtering plus Recore's maximum page (200) plus a date floor leaves about 20 relevant rows for Bunting.

Facts (V, read-only Recore queries today):
- Maximum `$top` is **200** (400 error above that). `$count=true` works.
- These all work: parentheses, `or`, `eq null`, `ne`, `ge` with an unquoted date.
- Bunting box, filtered to Single Family or null subtype, bedrooms 3–5 or null, closed since 2025-10-14: 33 rows (29 in the circle), containing 7560 Lemur (0.81 mi, $3,800, 2026-09-02), 7275 Coolidge (1.93 mi, $4,195, 2026-08-26), 9026 Feather (1.98 mi, $3,700, 2026-07-31). With a 6-month floor, about 20 in the circle.
- **PropertySubType values seen on PropertyType 'Residential Lease'** (2-mile Bunting box: 414 rows; Ventura-area 12-mile box: 2,172 rows): Single Family Residence, Condominium, Townhouse, **Duplex**, **Triplex**, **Quadruplex**, Apartment, Studio, Loft, Rooms for Rent, Commercial/Residential, Manufactured On Land, null (and Stock Cooperative in the original sample). In the 2-mile box: SFR 196, Condo 85, Townhouse 54, Duplex 6, Studio 2, Apartment 1, Manufactured 1, null 69.
- The null subtypes are legacy: 56 of 61 closed records from 2015 are null; 0 of 107 closed in 2026. A date floor removes almost all of them, but keep the null rule anyway (below).

Build:
1. **Mapping.** Extend `FROM_CRMLS_PROPERTY_TYPE` to: Single Family Residence to `single_family`; Condominium to `condo`; Townhouse to `townhouse`; Apartment to `apartment`; Manufactured On Land to `manufactured`; **Duplex to `duplex`; Triplex to `triplex`; Quadruplex to `fourplex`; Studio to `apartment`; Rooms for Rent to `other`; Commercial/Residential to `other`**. Leave **unmapped (null)**: Loft (ambiguous, 4 seen), Stock Cooperative, and anything new. Update the "live-sampled 200" comment.
2. **Reverse map.** Derive `TO_CRMLS_PROPERTY_SUBTYPES` from the forward map (every subtype whose mapped value equals the subject's type), so the two can never drift. `other` yields no subtypes.
3. **`buildFilter(status, scope, relevance = {})`.** With `relevance` omitted the output is byte-identical to today (existing exact-string tests must still pass). Otherwise append, in this order, to the existing filter:
   - subtype clause, only if the subject type has subtypes: ` and (PropertySubType eq 'A' or PropertySubType eq 'B' or PropertySubType eq null)`
   - bedrooms clause, only if `relevance.bedrooms` is a number, with lo/hi computed from `BEDROOM_MISMATCH_THRESHOLD` exactly as in Part 1: ` and ((BedroomsTotal ge LO and BedroomsTotal le HI) or BedroomsTotal eq null)`
   - date floor, only when `status === 'Closed'` and `relevance.closedSince` is set: ` and CloseDate ge YYYY-MM-DD`
   - Example, Closed, SFR 4-bed, box scope: `... and (PropertySubType eq 'Single Family Residence' or PropertySubType eq null) and ((BedroomsTotal ge 3 and BedroomsTotal le 5) or BedroomsTotal eq null) and CloseDate ge 2026-04-14`
   The `eq null` branches preserve the house rule that an unknown type or unknown bedroom count is not a mismatch. A record whose subtype IS known to CRMLS but unmapped (Loft, Stock Cooperative) is deliberately not fetched for a typed subject: CRMLS told us what it is; that is not missing data.
4. **Constants:** replace `COMPS_PER_STATUS = 10` with `MAX_RECORDS_PER_STATUS = 200`; add `CRMLS_CLOSED_LOOKBACK_MONTHS = 6` and `closedSinceDate()` (same month-subtraction pattern as `lib/leadsimple.js`). Active listings get no date floor. Keep the `$orderby` values exactly as today (`CloseDate desc`, `OnMarketDate desc`); existing test mocks key on them.
5. **`pullCrmlsComps`:** pass `{ propertyType: subject.propertyType, bedrooms: subject.bedrooms, closedSince }` to `fetchByStatus()` for both the box path and the zip fallback. The subject object already carries `propertyType` and `bedrooms` (`runActiveSources()` spreads the whole subject into every handler), so **no change to `server.js`, `router.js` or `sources.js` plumbing is needed.** Missing `propertyType`/`bedrooms` (old tests, direct calls) simply adds no relevance clauses. If a status returns exactly 200 rows, `console.warn` a truncation notice. Everything after the fetch (circle filter, mapping, return shape) is unchanged.
6. Update the header and `COMPS_PER_STATUS` comments. Exports to add: `TO_CRMLS_PROPERTY_SUBTYPES`, `MAX_RECORDS_PER_STATUS`, `CRMLS_CLOSED_LOOKBACK_MONTHS`, `closedSinceDate`. Keep every existing export.

### Part 3 — Radius ladder (`lib/constants.js`, `lib/sources.js`)

**Constants (`lib/constants.js`):**
- `WIDE_SEARCH_RADIUS_MILES = 2`, unchanged. It stays the ceiling and the distance each source fetches out to (RentCast `maxRadius`/`radius`, CRMLS box, LeadSimple cap). Peter's earlier "1 mile, 2 in a more rural setting" is why 2 stays.
- New `RADIUS_LADDER_MILES = [0.5, 1, 1.5, WIDE_SEARCH_RADIUS_MILES]` (define after WIDE).
- `NARROW_SEARCH_RADIUS_MILES` stays exported, redefined as `RADIUS_LADDER_MILES[0]` (0.5), the tightest rung. Nothing outside tests reads it after this build (`lib/crmls.js` only re-exports it; `sync-move-in-leases.js` only mentions it in a comment). Update the comment block above these constants to describe the ladder.
- `MIN_COMPS_FOR_NARROW_RADIUS = 4`, unchanged value and export. It is now "genuine comps needed at a rung", and `lib/narrative.js` still imports it as its "few comps" cutoff (no change to narrative.js for this).
- New `MIN_LEASED_COMPS_FOR_NARROW_RADIUS = 2`.
- `lib/crmls.js` keeps re-exporting `NARROW_SEARCH_RADIUS_MILES`, `WIDE_SEARCH_RADIUS_MILES`, `MIN_COMPS_FOR_NARROW_RADIUS` (the test file imports them from there). No importer needs editing.

**`lib/sources.js`:** keep `applyCombinedRadiusTiering(comps, subject)`, its signature, export, and its single call in `runActiveSources()`. Add and export `chooseRadiusRung(comps, subject)`. Replace the body.

`chooseRadiusRung`, for each rung `r` in `RADIUS_LADDER_MILES`, ascending:
1. `candidates` = comps with `exclusionReason(c, subject.bedrooms, subject.propertyType) === null` (a "genuine" comp, same call as today) AND `typeof c.distance_miles === 'number'` AND `c.distance_miles <= r` (exactly 0.5 counts).
2. `unique = dedupeComps(candidates, subject.bedrooms, subject.propertyType)` (import from `./property-matching`; no cycle). Count distinct addresses, not rows. This is required now, unlike in PR #8: the listings search overlaps CRMLS and the AVM heavily (Lemur is in both), and without it one property seen by two sources would count twice. Comps with no address are never merged, so existing tests that omit addresses are unaffected.
3. Qualifies when `unique.length >= MIN_COMPS_FOR_NARROW_RADIUS` AND the number of `unique` with `listing_status === 'leased'` is `>= MIN_LEASED_COMPS_FOR_NARROW_RADIUS`. "Leased" means CRMLS Closed and LeadSimple Move-Ins; RentCast can never produce it.
4. First qualifying rung wins. If none qualify, the rung is the last one (2 mi). Return `{ rung, genuineCount, leasedCount }`.

`applyCombinedRadiusTiering` then keeps a comp if:
- it has a numeric `distance_miles <= rung`, **whether or not it is a genuine match**; or
- it has no numeric distance AND `rung` is the ceiling (nothing was verified closer; sources already bound everything to 2 mi, so this is today's behavior when the ladder finds nothing).

So: non-genuine comps inside the chosen rung stay and show as "not used" (as today). Genuine and non-genuine comps beyond the rung are dropped. A comp with no distance is dropped whenever a narrower rung is chosen (it cannot be shown to be inside; in the 30 saved reports none lacks a distance). When there are zero distances at all (RentCast failed, CRMLS on its zip fallback) no rung qualifies, so everything is kept, i.e. today's behavior. Log one line: `[rental-analysis] Radius ladder: stopped at R mi (genuine=G, leased=L); kept N of M comps.`

**Why dropping genuine matches beyond the rung is now safe** (this deliberately supersedes PR #8's "genuine matches are never cut for distance"). PR #8's regression (CROSS-SOURCE-RADIUS-SPEC.md, Revision) was a plain 1-mile cut that deleted Rainier's two best leases when the area had no confirmed leases inside 1 mile. The ladder cannot stop at a rung unless that rung already holds at least 4 genuine comps with at least 2 confirmed leases, so a far comp is only dropped when real lease evidence already sits closer. Where the evidence is not there, the ladder widens (Rainier) or falls back to 2 mi.

**Hand-trace, Rainier regression test (frozen mock in `q-mapping-unit-test.js`, subject single_family 4bd):** rung 0.5: genuine = 555 Skyline (0.19), 480 Day Rd (0.44, 3bd = one off, still genuine) = 2, leased 0: fails. Rung 1: adds Bryn Mawr, Burnett, Hunter = 5 genuine, leased 0: fails (1148 Colina Vista is at 1.10). Rung 1.5: adds Colina Vista (leased) and 7275 Coolidge (1.47, leased) = 7 genuine, 2 leased: **stops at 1.5**. Kept = 9: the 4 RentCast comps, Day Rd, Colina Vista, Coolidge, plus Creekmont (6bd) and Brentwood (apartment), which are inside 1.5 mi and non-genuine so they stay as "not used". Dropped: College Dr (1.6), the five Saratoga/Dean condos, 3296 San Luis (1.96), 1220 Johnson (1.99). With 555 Skyline flagged Rincon-managed, `computeRecommendedRange(kept, 4, 'single_family')` = **{low 4200, mid 4500, high 5650}** (I ran the real `weighting.js`). The old assertion was 4197.5/4500/5650; the $2.50 difference is only because 3296 San Luis is now beyond the rung. Colina Vista and Coolidge survive, the condos are gone: the property that test protects still holds.

**Bunting, on the saved comps:** rung 0.5 has 3 genuine (Sherwin A, Swan, Buffalo); rung 1 has 5 genuine and 2 leased (Buffalo, Tanager): **stops at 1**, range 3950/4350/4500 unchanged.

### Part 4 — `lib/narrative.js` (one line)
Raise `max_tokens` from 8192 to 16000, update its comment (more comps now reach this step). Nothing else in that file changes.

### Entry points
- `server.js` (standalone): functional change none. Comment-only updates listed in Part 1 item 10.
- `router.js` (Hub): none. Both call `runActiveSources(activeSources, { address, propertyType, bedrooms, bathrooms, sqft })`, which already hands the new code everything it needs.
- UI/narrative wording: I searched both `dashboard/index.html` files and `lib/narrative.js` for "1-2 miles", "1 mile", "radius" and similar. Only the per-comp "N.NN mi from subject" label exists. Nothing to update. (Optional idea for later, not built: a small "radius used" label.)

---

## Tests (`q-mapping-unit-test.js`, standalone only; Hub has none)

Add imports as needed (`RADIUS_LADDER_MILES`, `MIN_LEASED_COMPS_FOR_NARROW_RADIUS` from `./lib/constants`; new rentcast/crmls/sources exports). Line numbers below are the current file.

### Existing tests that must change
All hand-traced under the ladder. The reason most old assertions break: the old mocks contain no `leased` comps, so no rung qualifies and the ladder keeps everything out to 2 mi.

| Line | Test | Change |
|---|---|---|
| 1009 | RentCast `maxRadius` request | The mock records the LAST URL, which is now the listings call. Record the URL whose path contains `/avm/rent/long-term`, then assert `maxRadius`. |
| 889, 920, 1493, 1514 | `pullRentCastComps` coordinate/zip tests | Pass unchanged. Their mocks answer every URL with an AVM-shaped object, so the listings response is a non-array and must be treated as `[]`. This protects the "never throw" rule. |
| 1283 | Rainier bug reconstructed (condos must be cut) | Make two of the within-1-mile mock comps `leased` (e.g. the 0.8 and 0.9 comps). Hand-trace: rung 0.5 has 2 genuine, fails; rung 1 has 5 genuine and 2 leased, stops. Assertions then hold: the three condos absent, 5 comps. |
| 1318, 1329, 1353 | stays wide / type mismatch / no distance, wide | Still pass unchanged (no leases, so ceiling, all kept). Retitle and comment: they now pass because no rung qualifies, not because of a count of 4. |
| 1340 | unknown type counts | Add two leases among the four near comps (one single_family, one null-type) so rung 1 qualifies (0.2, 0.4, 0.5, 0.6 = 4 genuine). Assertion `length === 4`, all `<= RADIUS_LADDER_MILES[1]` (replace the `NARROW_SEARCH_RADIUS_MILES` use). |
| 1365 | genuine no-distance comp always survives | Rewrite. With 4 genuine within 1 mi including 2 leased plus a genuine no-distance comp: **dropped** (rung 1 chosen). Add a sibling: same comps with no leases, the no-distance comp survives at the ceiling. |
| 1378 | non-genuine no-distance dropped | Add two leases to the genuine four so the ladder stops at 1; the condo with null distance is dropped (length 4). |
| 1391 | genuine beyond 1 mi survives | **Flip.** Give the four near comps two leases so rung 1 is chosen: the 1.6 and 1.8 genuine comps and the 1.6 condo are all dropped (length 4). Rename: "a genuine match beyond the chosen rung is dropped once the rung has 4 genuine + 2 leased". |
| 1407 | Rainier regression | Mock data unchanged. New assertions: rung 1.5 (check via `chooseRadiusRung` or the log); Colina Vista and Coolidge present; the five Saratoga/Dean condos, College Dr, 3296 San Luis, 1220 Johnson absent; **Creekmont (6bd) and Brentwood (apartment) now present** with `exclusionReason !== null`; range `{ low: 4200, mid: 4500, high: 5650 }`. |
| 1682–1749 | CRMLS "always returns full set" | Unchanged and still pass (mocks key on `$orderby`, subjects carry no type or bedrooms). |
| 1578 | `buildFilter` exact strings | Unchanged and must still pass (two-argument calls). |

### New tests
**Ladder (`sources.js`):**
1. Stops at 0.5 when 4 genuine + 2 leased are within 0.5; a comp at exactly 0.5 counts; a comp at 0.51 does not.
2. Widens 0.5 to 1 to 1.5 to 2 as the counts fail; stops at the first qualifying rung.
3. Leased gate: 6 genuine within 0.5 but only 1 leased widens; adding a second lease stops it.
4. No rung qualifies: returns the 2 mi ceiling and keeps every comp including no-distance ones.
5. Dedupe in the gate: the same address from RentCast (`off_market`) and CRMLS (`leased`) counts once, as leased; 4 rows that are really 2 addresses do not qualify.
6. LeadSimple Move-Ins leased comps count toward the leased gate.
7. Non-genuine comps inside the rung are kept; beyond it dropped; unknown type counts as genuine; zero comps returns `[]`.
8. Constants: ladder ascending, first = 0.5, last === `WIDE_SEARCH_RADIUS_MILES`; the three legacy exports still resolve from `lib/crmls`.
9. **Bunting-shaped scenario** via `runActiveSources` with mocked handlers (subject single_family 4bd): RentCast returns 2810 Sherwin (0.26 active), 6630 Sora St (0.52 active $4,195), 6552 Partridge Dr (0.66 off_market $3,995), 7560 Lemur St (0.81 off_market $3,800); CRMLS returns Swan St (0.36 active), 2292 Buffalo (0.45 leased $4,600), 6453 Tanager (0.59 leased $4,500), 7560 Lemur Street (0.81 leased $3,800), 1203 Nilgai (1.07 leased $3,000), 7275 Coolidge (1.93 leased $4,195), 9026 Feather (1.98 leased $3,700), and a Duplex-typed 2974 Sherwin (0.38, `duplex`). Expect: rung 1; Sora, Partridge, Lemur present; Nilgai, Coolidge, Feather absent; after the later `dedupeComps()` Lemur is one row, leased.

**RentCast listings:**
10. `pullRentCastComps` makes exactly 2 fetches, AVM first then listings (budget guard).
11. Listings URL params exactly: lat/lon from the AVM's `subjectProperty`, `radius=2`, `status=Active|Inactive`, `propertyType=Single Family`, `bedrooms=3:5` for a 4-bed (`0:1` for a studio), `daysOld=180`, `limit=500`, `includeTotalCount=true`; no `propertyType` for subject type `other`.
12. Mapping: Active maps to `active`; Inactive maps to `off_market` and never `leased`; `monthly_rent` = price; `leased_date` = date-only `removedDate`; `distance_miles` equals `haversineMiles` of the two points (6630 Sora St about 0.52 from Bunting); a listing with no coordinates keeps a null distance.
13. Filters: listing with no price dropped; listing over 2 mi dropped; listing whose address matches the subject dropped.
14. Never throws: 500, 429, network rejection, and non-array body each still return the AVM comps (and warn). AVM failure throws with only 1 fetch made. AVM response with no coordinates makes no listings call.
15. AVM comp and listing for the same address collapse to one comp through `dedupeComps()`.

**CRMLS:**
16. `buildFilter` with relevance: exact strings for Closed SFR 4-bed box scope (above example), Active (no `CloseDate`), condo (`'Condominium'`), apartment (two subtypes), fourplex (`'Quadruplex'`), `other` (no subtype clause), 0-bed (`ge 0 and ... le 1`), zip scope.
17. `pullCrmlsComps`: both statuses request `$top=200`; Closed filter has the 6-month `CloseDate ge`; Active has none; relevance clauses present when the subject has type and bedrooms and absent when not; warns when exactly 200 rows come back.
18. Mapping table: Duplex to `duplex`, Triplex to `triplex`, Quadruplex to `fourplex`, Studio to `apartment`, Rooms for Rent and Commercial/Residential to `other`; Loft, Stock Cooperative, null and an unknown string to null. The Tiber-St-shaped record (3bd, Duplex) against a single_family 4bd subject gives `exclusionReason === 'property_type_mismatch'` (no longer "unknown = match").

Expected end state: 174 existing checks (with the edits above) plus the new ones, all passing, 0 failing.

---

## Verification Plan for TARS (real data)

Costs are RentCast requests unless stated. Never print API keys; read-only Recore only.

1. **Suite and copies (free).** `node q-mapping-unit-test.js` all green. `diff -rq projects/rental-analysis/lib projects/hub/rental-analysis/lib` prints nothing.
2. **Saved-data ladder replay (free).** Method: with the service-role key, pull `rental_analyses` (status=complete) and `rental_comps` plus `rental_comp_sources` (for `source_name`). Keep the latest analysis per (address, property type): 30 subjects. For each, build the comp list from its saved rows (numeric `distance_miles`, `source_name`), **clear `is_rincon_managed`** for the ladder step (it is unset in the real pipeline at that point), call the real `applyCombinedRadiusTiering(comps, { bedrooms, propertyType })` (do not re-implement it), then compute `computeRecommendedRange()` on the kept rows using the saved `is_rincon_managed`, and compare with the saved range. Expected: stops 0.5 / 1 / 1.5 / 2 mi = **3 / 8 / 5 / 14** (2 / 8 / 5 / 15 if the saved Rincon flag is honored, which matches Peter's numbers); **Rainier (9ab946b1) stops at 1.5 and gives 4200 / 4500 / 5650; Bunting (62ec1441) stops at 1.0 with 3950 / 4350 / 4500**; about 18 of 30 ranges unchanged. This step only tests the ladder on old comps.
3. **Hybrid replay (free, the important one).** Same subjects that have coordinates (27), but replace each saved CRMLS row set with a live read-only `pullCrmlsComps()` call using the subject's saved lat/long, type and bedrooms, keep the saved RentCast and LeadSimple rows, run the ladder and compute ranges. Expected at 6 months: stops 0.5 / 1 / 1.5 / 2 = about **16 / 8 / 1 / 2**; midpoint moves of $100 or less for about 8, $100–250 for about 7, over $250 for about 12. Deliver a side-by-side table (before low/mid/high, after low/mid/high, rung, comp count) for Peter. Flag any subject whose after-range has fewer than 4 counted comps.
4. **Live Recore, Bunting (free).** `pullCrmlsComps({ address: '2461 Bunting Avenue, Ventura, CA 93003', latitude: 34.252446, longitude: -119.200606, propertyType: 'single_family', bedrooms: 4 })`. Confirm 7560 Lemur (0.81 mi, leased, $3,800), 7275 Coolidge (1.93, $4,195), 9026 Feather (1.98, $3,700) are returned; only single-family (or null-type) rows; about 20 closed rows inside the circle (my count on 2026-10-14: 20 SFR 3–5bd leases in 6 months). Then the same call with `propertyType: 'duplex', bedrooms: 2` and confirm 2974 and 2976 Sherwin Avenue come back with `property_type: 'duplex'`.
5. **Live RentCast, Bunting (1 request, or fold into step 6).** Same listings call as in Part 1 (`radius=2`, `status=Active|Inactive`, `propertyType=Single Family`, `bedrooms=3:5`, `daysOld=180`, `limit=500`). Expect about 74 rows (my 2026-10-14 run: 12 Active, 62 Inactive); 6630 Sora St Active and 6552 Partridge Dr Inactive present and mapped `active` / `off_market` through `mapListing()` with distances near 0.52 and 0.66; none mapped `leased`.
6. **End-to-end through the real endpoint** (standalone `server.js` locally, then confirm the Hub path uses the same `lib/`). Record the RentCast dashboard's request counter before and after each run.
   - Bunting: exactly **2 requests** for the analysis (3 if the zip's market cache was stale; +1 if the pre-fill is used). Log shows `Radius ladder: stopped at 1 mi`. Report contains Sora, Partridge, Lemur (one row, leased); no 352 Paine Ave; no condos, townhouses or duplexes counted; no "RentCast Inactive shown as leased".
   - Rainier: **informational.** Expect a different stop than the frozen test, possibly 1 mi, because the MLS fix now finds leases within 1 mi that crowding hid. Report the rung, the range and whether 1148 Colina Vista / 7275 Coolidge survived, for Peter. Not a pass/fail on "1.5" (that is the unit test and step 2).
   - A sparse address (e.g. 4990 Bradley Rd, Somis): confirm it falls back to 2 mi and is not emptied.
   - A duplex (530 Coronado Street): confirm duplex-typed CRMLS comps appear and count.
   - Whichever run has the most comps: confirm the narrative completes (non-null `rationale`, one narrative per comp).
   - Budget: 4 runs is about 8–12 RentCast requests.
7. **Failure paths (free, mocks).** Covered by unit tests 14 and 17; no live fault injection.
8. **Judge checklist:** (a) both `lib/` copies identical; (b) no RentCast `Inactive` ever maps to `leased`; (c) unknown-type and unknown-bedroom comps are still not excluded on the CRMLS path; (d) no secrets logged; (e) the "genuine matches are never cut by distance" comment in `lib/sources.js` is rewritten (it is now false); (f) stale request-count comments updated.

---

## Appendix — evidence behind the numbers

- Saved data: 67 complete analyses (21 in Aug, 42 in Sept, 4 in Oct to date), 30 distinct address+type, 1,320 comps. Median age of saved CRMLS leased comps at analysis time was 20 days (p90 37 days, max 1,464): today's "10 newest" is a very short, accidental window. 6 months is a deliberate widening in dense areas.
- Recore `$count` for Bunting's 2-mile box: 400 closed leases all-time (oldest 2007), 14 active.
- Hybrid replay at 12 months: stops 18 / 7 / 0 / 2; with the stricter minimum of 6 genuine comps at 6 months: 8 / 16 / 0 / 3 (Decision 4).
- Rainier under the new CRMLS filter (6 mo) finds leases the old fetch hid, all single-family 3–4bd: 480 Day Rd 0.44 mi $4,700; 639 Skyview 0.67 $6,500; 1148 Colina Vista 1.10 $5,650; 7429 Nixon 1.40 $5,500; 7275 Coolidge 1.47 $4,195; and at 12 months also 6153 Cobblestone 0.45 $8,500 and 697 Via Cielito 0.55 $9,500.
- Files Q touches: `lib/constants.js`, `lib/sources.js`, `lib/rentcast.js`, `lib/crmls.js`, `lib/narrative.js` (one line), `q-mapping-unit-test.js`, comments in `server.js`; the first five in both `lib/` trees.
