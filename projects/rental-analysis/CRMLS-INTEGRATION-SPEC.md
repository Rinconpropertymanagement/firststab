# CRMLS (MLS) Comp Source — Build Spec

Status: Approved by Peter (verbal go-ahead, this session). Scope: light 7-step
CLAUDE.md pipeline, not the deeper GOVERNANCE.md pipeline — see "Compliance
scope" below.

## What This Does

Right now the rental analysis tool only pulls comps from RentCast, which can
tell you what's currently *listed* for rent but can never confirm what a unit
actually *leased* for — it can only guess. This build adds a second comp
source, CRMLS (the real Southern California MLS, accessed through a licensed
data platform called Recore), which gives us actual closed-lease records —
real transactions, not guesses. The tool already has a built-in preference for
this kind of data (a "leased" comp already counts 3x more than a plain listing
when it calculates a recommended rent), it just hasn't had any real leased
data to use until now. Once this is built, every analysis will pull comps from
both RentCast and CRMLS and blend them together automatically — nothing about
how Peter or his team uses the tool changes.

## How It Works

1. When someone runs a rental analysis (enters an address), the tool now
   queries two sources instead of one: RentCast (as today) and CRMLS (new).
2. The CRMLS query asks Recore's system for rental listings near that address
   — both properties currently for rent (`Active`) and properties that
   recently, actually leased (`Closed`).
3. Each CRMLS result is converted into the tool's standard comp format
   (address, beds/baths/sqft, rent, status, dates) — the same format RentCast
   comps already use, so nothing downstream needs to know which source a comp
   came from.
4. Closed/leased CRMLS comps get tagged `leased` — the tool's highest-trust
   category. Active CRMLS listings get tagged `active`, same as RentCast's
   active listings.
5. Both sources' comps get combined into one list, and the existing math
   (already built, not changing) weights the leased comps more heavily when
   it works out the recommended rent range.
6. If CRMLS has a hiccup (down, no results, bad address) the analysis still
   completes using whatever RentCast returns — one source failing never
   blocks the whole report, same protection RentCast already has today.

## What You'll See

No visible change to how you run an analysis — same address box, same
"Run Analysis" button. The difference shows up in the results: real leased
comps (marked "Leased") should start appearing in the comp list for Southern
California addresses, pulling the recommended rent range toward what units
are actually leasing for instead of just what's advertised. Sales and ops
should end up recommending the same number for the same address more often,
because everyone's now looking at the same real transaction data instead of
each person's personal read on the market.

## What Could Go Wrong

- **No CRMLS results for an address.** Rural or low-inventory areas may come
  back empty from CRMLS. Not an error — the analysis proceeds on RentCast
  alone, same as any source returning zero comps today.
- **CRMLS/Recore is down or rejects the request.** Logged and skipped, same
  pattern RentCast already uses — the analysis still runs, just without that
  source's comps for that one run.
- **Access or credentials lapse.** If the Recore login stops working (trial
  expires, plan changes, token rotates), CRMLS comps silently stop appearing
  and the tool quietly reverts to RentCast-only. Worth a periodic gut-check
  that "Leased" comps are still showing up for a known address, so this
  doesn't go unnoticed for months.

## What Q Needs to Build This

- **New file:** `lib/crmls.js`, following the same shape as the existing
  `lib/rentcast.js` (one function that takes the subject property and returns
  `{comps: [...], ...}` in the tool's standard format).
- **One-line addition to `lib/sources.js`:** register the new handler — this
  file was deliberately built so adding a source never requires touching its
  loop logic, only adding one entry.
- **Database update:** the `rental_comp_sources` table currently has an
  inactive placeholder row named `FlexMLS`. This needs to become an active
  `CRMLS` row (Neo to advise: rename the existing row vs. add a new one) with
  `is_active` set to true. Small migration file, applied by Peter himself via
  Supabase's SQL Editor — no code deploy needed to flip a source on.
- **Housekeeping:** two comments in the existing code (in `lib/sources.js` and
  `lib/rentcast.js`) currently say CRMLS/FlexMLS access is "pending" — those
  need updating now that access is real.
- **Access:** Recore/CRMLS login credentials in `.env` — confirmed present
  and non-empty (`RECORE_CLIENT_ID`, `RECORE_CLIENT_SECRET`,
  `RECORE_SERVER_TOKEN`, `RECORE_BROWSER_TOKEN`) via direct shell check
  immediately before this spec update (values never printed). An earlier
  pass reported these as missing — that was a false alarm from a grep
  pattern that missed the `RECORE_` prefix; they're there. Use
  `RECORE_SERVER_TOKEN` for server-to-server calls, not the Browser Token.
- **Not changing:** `lib/weighting.js`. Checked directly — it already expects
  a `leased` status and already weights it 3x; nothing here requires
  touching that file.
- **Verification target:** 1895 Dorrit St, Newbury Park, CA 91320 should
  return at least one real `leased` comp from CRMLS with current (September
  2026) data once this is live — TARS to confirm with a real run before this
  is called done.

## One Thing Worth Flagging (not a blocker)

MLS data licenses often have rules about how long you're allowed to store or
cache their data, and in what form. This build does store CRMLS comps in the
database (same as RentCast comps are today), so at some point it's worth
Peter checking the actual terms with Recore or his own counsel — on his own
timeline, not something that needs to hold up this build.

## Technical Appendix — API Mechanics (verified live, 2026-09-18)

This is not a guess and not third-party documentation paraphrased — every
field and query below was confirmed by Jarvis running real, live, read-only
GET requests directly against the production CRMLS feed with Peter's own
approved credentials, earlier in this same session. If a field you need isn't
listed here, the fix is another quick live query against the real feed (cheap,
safe, already proven to work) — not inventing a plausible-looking field name.

**Base URL:** `https://api.marketplace.recore.net/api/v2/OData/crmls/{Resource}`
— the resource for rental comps is `Property`. (`crmls` is the real dataset ID;
the account also has a `test_recore` sample dataset provisioned by default —
never use that one.)

**Auth:** append `?access_token=${RECORE_SERVER_TOKEN}` as a query parameter.
Standard OData query params compose normally alongside it (`&$filter=...` etc).

**Query syntax:** standard OData — `$filter`, `$select`, `$top`, `$orderby`,
`$skip`; pagination via `@odata.nextLink` in the response when results are
paged. Rate limit is 5,000/hr — generous, no RentCast-style request budgeting
needed.

**Proven working filter** (this exact query returned real September 2026
closed-lease records live):
```
$filter=StandardStatus eq 'Closed' and PropertyType eq 'Residential Lease' and PostalCode eq '91320'
```
Swap `StandardStatus eq 'Closed'` for `eq 'Active'` to get current listings.
`$orderby=CloseDate desc` works for recency sorting on closed records.
Filtering by `PostalCode` (the subject's own zip — this tool already resolves
and stores `subject_zip` elsewhere) is the proven way to scope "nearby," not
a guess — no separate radius/geo-search endpoint has been tested or is needed.

**Confirmed real field names on actual returned records:**

| Purpose | Field(s) |
|---|---|
| Status | `StandardStatus` (`'Active'` / `'Closed'`) |
| Property type filter | `PropertyType` (literal value `'Residential Lease'`, with the space) |
| Address | No `UnparsedAddress` field exists on this feed. Assemble from: `StreetNumberNumeric` (int, preferred — `StreetNumber` string version can be null even when this is populated), `StreetDirPrefix` (nullable), `StreetName`, `StreetSuffix`, `StreetDirSuffix` (nullable), `UnitNumber` (nullable), `City`, `StateOrProvince`, `PostalCode` |
| Beds | `BedroomsTotal` |
| Baths | `BathroomsTotalDecimal` (also has `BathroomsFull`/`Half`/`ThreeQuarter`/`OneQuarter` broken out if ever needed) |
| Rent price | `ListPrice`; `ClosePrice` (populated on Closed, null/absent on Active); `OriginalListPrice` |
| Dates | `CloseDate` (Closed only); `OnMarketDate`, `ListingContractDate` (Active); `ModificationTimestamp` |
| Geo | `Latitude`/`Longitude` — populated on Active listings tested, but were `null` on at least one older Closed record. Don't require these; fall back to City/PostalCode when null. |
| Sqft | `LivingArea` |
| Other useful | `ListingId`, `ListingKey` (unique id), `DaysOnMarket`, `YearBuilt` |

**Mapping into this tool's `listing_status` vocabulary** (per `lib/weighting.js`,
already expects this, no changes needed there): `StandardStatus: 'Closed'` →
`'leased'`, `StandardStatus: 'Active'` → `'active'`.

## Compliance Scope

This build does not meet GOVERNANCE.md's bar for a compliance build. Per
GOVERNANCE.md's own scope line: the deeper pipeline applies only when a build
"sends messages to tenants/owners, makes or influences a housing decision, or
stores personal data." This build does none of those — it pulls property/
listing-level market records (address, beds/baths/sqft, rent, dates), same
category of data RentCast already supplies today, with no tenant or owner
messaging and no decision made about any individual applicant or tenant. The
standard CLAUDE.md pipeline applies: this spec, Neo on the small schema
change, Q builds, TARS tests with a real address, Judge signs off.
