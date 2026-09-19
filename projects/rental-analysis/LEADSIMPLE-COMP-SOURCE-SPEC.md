# LeadSimple Move-Ins Comp Source — Build Spec

Status: Draft — this is Step 2 (PLAN) of the CLAUDE.md Build Pipeline. Needs
Peter's approval (Step 3) before Q builds anything. Given this repo's real,
existing paper trail of caution around LeadSimple data specifically
(`compliance/leadsimple-spec-governance-precheck.md`,
`compliance/leadsimple-fair-housing-review.md` — a different LeadSimple
domain, see "Compliance Scope" below), Jarvis intends to get a quick Asimov
sanity-check on this spec before Q builds, even though this build's own
analysis concludes it doesn't cross GOVERNANCE.md's compliance-build bar.
Light 7-step CLAUDE.md pipeline either way, not the deeper GOVERNANCE.md one.

## What This Does

Today the rental analysis tool pulls comps from RentCast (asking prices) and
CRMLS (real MLS transactions), but neither one can ever tell you what Rincon
itself actually leased a unit for — that's Rincon's own private data, not on
the open market. This build adds a third comp source: real, confirmed new
leases from Rincon's own portfolio, pulled from LeadSimple (the system
Rincon's leasing team already works in for move-ins). Only genuinely new
tenants moving in count — a tenant renewing their existing lease is
deliberately excluded, because renewal rents often run below market for a
tenant staying in place, and mixing those in would drag a "what to ask a new
tenant" range in the wrong direction. Once built, every analysis blends
RentCast, CRMLS, and Rincon's own new-lease history together automatically —
nothing about how Peter or his team runs an analysis changes.

## How It Works

1. A nightly, scheduled job (not a live per-analysis lookup — see "Why a
   sync, not a live lookup" below) checks LeadSimple for Move-In cases that
   changed recently. For every closed one, it confirms — against Rincon's
   own AppFolio-synced lease ledger, never against anything LeadSimple
   itself reports about the unit — whether this Move-In is still the
   CURRENT lease for that unit. Only a confirmed-current Move-In gets
   saved — address, bed/bath/sqft, the real ledger rent, and lease dates —
   into a new, dedicated table in Rincon's Supabase database. A Move-In
   that's been superseded by a later tenant is discarded entirely, on
   purpose, per Peter's own direction — see "Resolving rent accuracy —
   current lease only, not a fallback" below for why, and for the real
   numbers this produces.
2. When someone runs a rental analysis, the tool now checks that table for
   any of Rincon's own new leases within the last two years, near the
   subject's zip code, alongside its usual RentCast/CRMLS queries.
3. Each matching record is converted into the tool's standard comp format,
   tagged `leased` — the same top trust tier CRMLS's real closed
   transactions already get, since this is exactly that: a real, closed,
   confirmed-new-tenant lease.
4. Because every comp this source produces is, by definition, one of
   Rincon's own managed properties, it needs a small but important fix to
   how the tool already treats "is this comp one of ours" — see "Resolving
   the Rincon-managed exclusion conflict" below. Without that fix, this
   entire source would silently contribute nothing.
5. If LeadSimple access lapses or the nightly sync has a bad night, the
   table simply doesn't get fresher data — analyses keep running on
   RentCast/CRMLS plus whatever's already saved, the same "one source
   failing never blocks the whole report" protection every other source
   already has.

### Why a sync, not a live lookup

LeadSimple's API has no address or property filter (confirmed by the
existing connector's own header comment) — finding "Move-Ins near this one
address" means paging through every Move-In record and matching addresses in
memory. `sync-property-stages.js`'s own header documents this as ~110
minutes for a full unbounded scan of a different, larger dataset on this
account — far too slow to run inside a "run analysis" button click. This
build follows that same script's proven fix: pull on a nightly schedule
using `updated_since` (a small, bounded pull), save the results, and have
the analysis tool read the saved table instead of calling LeadSimple
directly.

### The new table: its own, not a 4th row in `sync-property-stages.js`

`sync-property-stages.js` already syncs three other LeadSimple process types
(Delinquency, Lease Renewal, Move Outs) into one shared table,
`leadsimple_property_stages` — but that table was deliberately scoped to
just "what stage is this process in right now" (property_id, process_type,
stage, updated_at), and its row lifecycle is upsert-while-open,
delete-once-closed (a stage row exists only while there's something current
to show).

Move-Ins data is a different shape of problem entirely: it needs real
numbers (rent, bed/bath/sqft, lease dates), and — the opposite lifecycle — a
Move-In only becomes useful to this build once it's *closed* (a confirmed,
signed lease), and should then be *kept*, not deleted, so it can serve as a
comp for up to two years. Bolting that onto a loop built around the opposite
rule (delete on close) would mean special-casing one of four entries in a
shared loop for a fundamentally different lifecycle — fragile, and a trap
for the next person who touches that script's shared logic.

**Decision: a new table (`leadsimple_new_leases`, working name — Neo to
confirm) and a new, separate sync script, reusing the proven *mechanism*
(the nightly `updated_since` pull via the existing, already-tested
`getProcessTypeIdByName` / `listProcessesUpdatedSince` connector functions —
zero new code needed in `lib/leadsimple-connector.js`) but not the
`sync-property-stages.js` script or table itself.** This is a smaller sync
than that script's, not a bigger one: no delete-on-close branch is needed at
all (a closed Move-In is exactly what this build wants to keep), only a
narrow edge case for a process that un-closes (see "What Could Go Wrong").

## Resolving the Rincon-managed exclusion conflict

This is the part of this build most likely to go wrong silently if not
handled explicitly, so here's the exact mechanism and the exact fix.

**The conflict:** `lib/weighting.js`'s `excludeRinconManaged()` currently
drops every comp flagged `is_rincon_managed` from both range calculations,
full stop — validated earlier against Peter's own reference report, where
his team's manual process already excludes their own units. `is_rincon_managed`
gets set the same way for every comp regardless of source: `server.js`
address-matches every raw comp against the `properties` table and sets
`is_rincon_managed: !!match` (server.js, the comp-matching step right before
`computeRecommendedRange`/`computeRawRange` run). This new source's comps
are, by construction, Rincon's own properties — the address match will
succeed for nearly all of them. Left unchanged, `excludeRinconManaged()`
would zero out every single comp this build produces, silently. The build
would ship, run, insert real comps into `rental_comps`, and never once move
the recommended range — a very hard bug to notice because nothing errors.

**Why this source is different in kind, not just another instance of the
same thing:** the existing rule protects against an *incidental* match — a
RentCast or CRMLS comp that happens to be a Rincon-managed unit, of unknown
lease type (could be a renewal, could be mid-turnover), showing up via an
independent-market source and effectively vouching for itself. This new
source is the opposite: it was *deliberately* pulled specifically because
it's Rincon's own confirmed, new-tenant, real-transaction data — the most
trustworthy category of comp the tool has, not the least.

**The fix:** key the exclusion off which *source* produced the comp, not
`is_rincon_managed` alone. `lib/weighting.js` gains a small, named set of
source names that are exempt from the Rincon-managed exclusion because
they were deliberately built to be exactly that:

```
SELF_SOURCED_TRUSTED_SOURCE_NAMES = { 'LeadSimple Move-Ins' }

excludeRinconManaged(comps) filters out a comp when:
  is_rincon_managed is true AND its source_name is NOT in that set
```

`source_name` is already present on every comp at this point in the
pipeline — `lib/sources.js`'s `runActiveSources()` already attaches it
(`source_id`/`source_name`, kept for logging, stripped only right before the
final DB insert in `server.js`), so this needs no new plumbing, just the one
changed check. This correctly keeps excluding a RentCast/CRMLS comp that
happens to match a Rincon-managed property (unchanged behavior — still
excluded, still unknown lease-type quality) while including a comp that
came from this new source.

**Weight tier: reuse `leased` (3x), don't add a 4th tier.** The task brief
that led to this spec raises a real question worth a straight answer:
should Rincon's own confirmed-new-tenant data outrank even CRMLS's `leased`
comps, since it's not just closed but guaranteed non-renewal? Considered and
rejected for v1: `rental_comps.listing_status` is a real CHECK-constrained
column (`'active','leased','off_market'` only — see the migration) and
`lib/weighting.js`'s three weights were validated against a real reference
report, not chosen arbitrarily. A 4th tier means a schema migration (Neo)
*and* picking a new number (4x? 5x?) with nothing real to validate it
against — CRMLS's 3x had Peter's own report to check against; a brand-new
number here would be a guess dressed up as a decision. `leased` is also
simply the accurate word for what this comp is — a real, closed lease — not
a workaround. Recommendation: ship with `leased` (3x, no schema change,
`lib/weighting.js` untouched beyond the exclusion fix above), and revisit
whether it deserves more weight once Peter/TARS have actually looked at a
handful of real analyses with both source types present.

**A knock-on fix this makes necessary — `is_rincon_managed` no longer means
one thing everywhere.** Today, `is_rincon_managed: true` always means
"excluded, internal reference only," and two places say so directly:
`lib/narrative.js`'s `describeComp()` (line ~50) tells Claude to write "this
is a Rincon-managed property, not outside competition — internal reference
only" for *any* `is_rincon_managed` comp, and `dashboard/index.html`
(~line 1482) hardcodes the label "Internal reference only — not an
independent market comp" the same way. Once this ships, that's no longer
universally true — a LeadSimple-sourced comp will show `RINCON MANAGED`
*and* be counted at full 3x weight, which would make the existing label
actively wrong and confusing (Peter's team would see "internal reference
only, not counted" sitting directly on a comp that visibly moved the
number). **Both call sites need the same trusted-source check as
`excludeRinconManaged()`** — cleanest as one small shared helper exported
from `lib/weighting.js` (e.g. `isExcludedRinconManaged(comp)`) that all
three places (`excludeRinconManaged`, `describeComp`, the dashboard) import,
so the trusted-source list never has to be kept in sync by hand across three
files.

## Resolving rent accuracy — current lease only, not a fallback

This section replaces the previous revision's "cross-reference `leases` as
a fallback for the 189 null-`current_rent` records" design. Peter's own
direct words, after seeing that only 13 of those 189 could actually be
resolved: **"only the current lease is really the most relevant. if we
lose the two leases before on the same property that is fine. current
lease is what matters."** That's a bigger change than a bug fix to the
fallback math — it changes what this source is allowed to report a rent
for, full stop. This revision re-examined the **whole 667-record set**
against that instruction, live, not just the 189-record gap the last
revision focused on.

### Why this applies to all 667 records, not just the 189 with no rent

The last revision already found that LeadSimple's `properties[0].unit`
object is a **live snapshot as of the API call**, not a record pinned to
the specific Move-In process — that's what caused `current_rent` and
`lease_start_date` to come back null for a tenant who'd already moved out
again. Re-examining the full dataset surfaces the sharper version of that
same finding: **the same live-snapshot behavior also silently corrupts
populated `current_rent` values, not just null ones, whenever a property
turned over more than once.**

Tested live: of the 667 closed Move-Ins in the 2-year pull window, **458
are distinct addresses** and **135 of those addresses have 2+ closed
Move-Ins** in the window (206 "older" records sitting behind a more recent
one at the same address). For every consecutive older/newer pair at those
135 addresses, this session checked whether the OLDER record's
`current_rent`/`lease_start_date` matched the NEWER record's exactly —
**117 of 206 pairs matched exactly, both fields, byte for byte.** Real
example, live: a Move-In at 2303 Otter Creek Ln that closed **2020-07-23**
shows `current_rent: 3865.0` and `lease_start_date: 2026-09-09` —
identical to the Move-In that closed at the same address on **2026-09-16**.
The "2020" record isn't reporting 2020's rent at all; it's reporting
whatever tenant occupies the unit **today**, because that's literally what
`properties[0].unit` always reflects, regardless of which process record
you're looking at. A populated `current_rent` was never proof of accuracy
for anything but the single most-recent Move-In at that address — this
was invisible in the last revision because it only audited the null
subset, not the full set. Peter's instinct to distrust anything but the
current lease is, concretely, correct: LeadSimple's own fields can't be
trusted to represent an older Move-In at all, populated or not.

### The new mechanism — confirm currency for every closed Move-In

`sync-move-in-leases.js` now cross-references **every** closed Move-In
against Rincon's own `leases` table (not just the null-`current_rent`
ones), and the question it asks changes from "what's the rent?" to "is
this Move-In still the current lease for this unit?":

1. Match the LeadSimple record's property/unit against Rincon's own
   `properties`/`units` tables. **A real, live matching-granularity finding
   from re-testing this against the account:** Rincon's `properties` table
   stores one row **per unit**, not one row per building, and a unit's
   specific sub-address is sometimes baked into `properties.address`
   itself and sometimes only present on its child `units.unit_number` row
   (confirmed live — "130 N Garden St" has 5 separate `properties` rows,
   one of which is itself unit-less in its own `address` column even
   though its one `units` child is `"130 N Garden St Unit 3243"`). The
   robust match target is therefore LeadSimple's own `full_address` (which
   always includes the unit when one exists) matched against **both**
   `properties.address` and `units.unit_number` as candidate addresses,
   using the existing house-number-gated, unit-identifier-gated, 0.6
   word-overlap rule (`findBestPropertyMatch()`/`unitIdentifier()` in
   `lib/property-matching.js`) — not `properties.address` alone, which
   under-matches multi-unit buildings. (LeadSimple's own `unit.unit_number`
   field is *not* a safe match target on its own — confirmed live it's
   sometimes just a bare fragment like `"#1"` or `"A"` with no street text
   at all, e.g. on a real closed record at 127 S B St.)
2. Once a `units` row is matched, pick its `leases` row whose `lease_start`
   is closest to this Move-In's `closed_at` (unchanged reasoning from the
   last revision: `closed_at` is the one reliable anchor date, `unit`
   fields are not — see Technical Notes). In practice there's rarely more
   than one `leases` row to pick from — see "Does the tolerance mechanism
   change shape" below.
3. **If the closest `lease_start` is within 45 days of `closed_at` → this
   Move-In is confirmed current. Use `leases.monthly_rent` — the real,
   AppFolio-synced, actively-charged rent — and keep the record.**
4. **If the closest `lease_start` is more than 45 days away, if no
   `leases` row exists for the matched unit, or if no property/unit match
   is found at all → drop the record entirely.** No `market_rent`
   estimate, no partial record. This is Peter's own instruction acted on
   directly: losing the older data is fine.

### The real numbers, tested live against all 667 — not assumed

|  | Count |
|---|---|
| Confirmed current lease (real, ledger-verified rent — **kept**) | **279** |
| Superseded — a newer tenant has since moved in (**dropped**) | 170 |
| No matching property/unit in Rincon's own tables at all (**dropped**) | 194 |
| Unit matched, but no `leases` row exists for it (**dropped**) | 24 |
| **Total** | **667** |

**The honest number Peter needs before approving this: the real comp pool
this source produces is 279 records, not 667, and not the ~647 the
previous fallback design would have kept (with 156 of those being
estimates).** That's a 58% drop from the raw pull — but every single one of
the 279 is a real, confirmed, currently-accurate rent with zero risk of
reporting a superseded tenant's number. The 194 "no property/unit match"
records are a separate, honest limitation worth naming directly: Rincon's
own `properties`/`units` tables (398/467 rows) are smaller than the 458
distinct addresses LeadSimple's Move-In history covers over 2 years —
sampled live, most of these are genuine absences (an address with no
same-house-number row anywhere in Rincon's `properties` table for that
zip), not a matching-code gap; a handful of multi-unit buildings account
for some of the difference (`properties` sometimes doesn't have a row for
a specific unit LeadSimple knows about), which this design correctly
treats as "can't confirm, don't guess" rather than falling back to an
estimate.

**Concrete example of the new drop behavior, live, 2026-09-18:** 3570 S B
St., Oxnard has two closed Move-Ins in the window — one closed 2025-07-23,
one closed 2026-09-08. The `leases` cross-reference finds one `leases` row
for that unit, `lease_start` 2026-09-01. The 2026-09-08 record is 7.7 days
from that `lease_start` → confirmed current, kept at the real $3,445/mo
rent. The 2025-07-23 record is 404 days away → superseded, dropped
entirely, even though LeadSimple's own `current_rent` field for *that*
record also (wrongly) shows $3,445 — the exact corruption described above.
263 S Ventura Rd #270, Port Hueneme shows the same pattern three deep:
Move-Ins closed 2022-04-13, 2023-06-26, and 2026-09-04 at the same unit —
only the 2026-09-04 one (7.8 days from the matched `lease_start`) is kept.

### Does the tolerance/matching mechanism need to change shape? (it mostly doesn't)

Confirmed live: `leases` holds 433 rows across 467 units — close to one row
per unit, not several to choose among. Sorting every matched record's
day-distance from its nearest `leases.lease_start` (all 449 property/unit
matches, confirmed-current and superseded together — 279 + 170) shows a
dense, tight
cluster from 0–40 days, then a real gap: 40 days, then 54, 71, 77, 80, 94,
104... only 11 records land in that 41–183 day "gray zone," and the
population resumes densely from ~183 days on (into the hundreds — clearly
different, older tenancies). This is the same shape the last revision found
against the smaller 189-record subset (genuine matches within 40 days,
nearest false lead at 183), now re-confirmed against the full set.
**Recommendation: keep `LEASE_MATCH_TOLERANCE_DAYS = 45` unchanged** — it's
well clear of the dense cluster and well short of the gray zone, and
there's no hard evidence to justify widening it into 11 ambiguous records
without a manual check Peter/TARS haven't done. What *does* simplify: the
mechanism no longer needs to "pick the best among several candidates" as
its primary job (there's rarely more than one), and its output is no
longer "a rent, or a fallback rent" — it's a plain yes/no (confirmed
current, or drop).

### Does the 2-year lookback window still matter, or is it redundant now?

Still matters, but its *reason* changes. Checked live: `leases.monthly_rent`
is not a frozen signing-time figure — `projects/appfolio-sync/sync.js`
populates it from AppFolio's own rent-roll/delinquency/lease-expiration
reports on every nightly run (`monthly_rent: parseFloat(row.rent...)`,
upserted by `appfolio_id`), so a long-tenured current lease's rent in
`leases` reflects whatever AppFolio says is being charged **today**,
increases included — not what that tenant signed at move-in. So the
lookback window is no longer protecting against *stale rent data* (that
risk doesn't exist once the source is `leases.monthly_rent` instead of
LeadSimple's own snapshot). It's still doing real work for a different
reason: **this source's whole premise is a recent, genuine new-tenant
signing event** — the same logic that already excludes lease renewals from
this source applies just as much to a Move-In from 4 years ago that
happens to still be current. A tenant who signed 4 years ago and never
turned over hasn't been tested against today's market any more recently
than a renewal has, even though their rent figure itself is fresh. Keeping
`MOVE_IN_LOOKBACK_MONTHS` (still 24, unchanged) scoping which Move-Ins are
even considered — applied to `closed_at`, the actual signing date, before
the currency check runs — is what keeps this source honestly representing
"what a new tenant recently agreed to pay," not "what everyone happens to
be paying now."

### Does `market_rent`/`is_estimated_price` still belong in this design?

No, for the core path. Every record this source keeps now has a real,
`leases`-confirmed rent — there is no case left where this source ever
sets `is_estimated_price = true`. **Recommendation: drop LeadSimple's own
`current_rent`/`market_rent` fields from what the sync reads and stores
entirely** — they're not used for anything anymore (confirmed-current
records use `leases.monthly_rent`; unconfirmed records are dropped before
ever being written). `lib/leadsimple.js`'s comp-mapper should hardcode
`is_estimated_price: false` on every comp it produces (same pattern
`crmls.js`/`rentcast.js` already use for their own certain-price cases) —
no column for it is needed on the new table at all, since it never varies.

### A new operational requirement this design creates — retracting superseded rows

The old table's row lifecycle was pure insert (one row per closed process,
keyed by `leadsimple_process_id`, never revisited). This design needs one
more behavior the old one didn't: **when a unit turns over again, the
row already saved for its previous "confirmed current" Move-In must be
deleted, not left in the table growing stale.** Concretely: the new table
should carry the matched Rincon `units.id` as a column
(`matched_unit_id`), and the sync's write step for a newly-confirmed-
current record should first delete any existing row for that same
`matched_unit_id` before inserting the new one — enforcing "at most one
row per currently-confirmed unit" as the table's real invariant, not
"one row per Move-In ever closed." This is a natural consequence of "only
the current lease matters" and is simpler than it sounds, but it's new
behavior Q needs to build, not something the old upsert-by-process-id
design already did — flagged explicitly in "What Q Needs to Build This"
and "What Could Go Wrong" below.

One consequence worth naming rather than hand-waving: the address-matching
rules this cross-reference needs (house-number gate, unit-identifier gate,
0.6 word-overlap) already live in rental-analysis's `lib/property-matching.js`
— reusing that exact file from a script in a different tool's directory
would be a cross-project `require('../../../rental-analysis/lib/...')`
reach, not a pattern this codebase uses elsewhere. `sync-property-stages.js`
already faced this same choice for its own (simpler) address matching and
resolved it by duplicating the small matching logic locally rather than
importing across tools (see that script's own header, "PROPERTY MATCHING —
REUSED, NOT REINVENTED, BUT NOT SHARED YET"), flagging the duplication as a
known, explicit follow-up rather than a blocker. `sync-move-in-leases.js`
follows that same precedent: a small, local copy of the house-number +
unit-identifier + word-overlap gates (not the full `property-matching.js`
file, just the pieces this cross-reference needs), with the same follow-up
flagged — now a second and third consumer of this exact matching logic
exist (`sync-property-stages.js`'s own copy, and this one), which makes
extracting a real shared library a more clearly worthwhile follow-up than
it was before, still not done here for the same reason it wasn't done
there.

## What Could Go Wrong

- **This build silently produces zero comps if the exclusion fix above is
  missed or gets the source name wrong.** The single biggest risk in this
  spec — flagged three times on purpose (above), and worth TARS explicitly
  confirming a LeadSimple comp actually survives into `recommended_rent_*`,
  not just that it gets inserted into `rental_comps`.
- **The comp pool is real and accurate, but much smaller than the raw pull
  — 279 of 667, not ~647.** Per Peter's own direct instruction, this source
  now only ever reports a rent when Rincon's own `leases` table confirms
  the Move-In is still the CURRENT lease for that unit — see "Resolving
  rent accuracy — current lease only" above for the full mechanism and the
  live numbers. Every kept record is a real, ledger-confirmed, currently-
  accurate rent — there's no estimated-price case left in this design. The
  honest tradeoff: 388 of the 667 real closed Move-Ins get dropped (170
  confirmed superseded by a newer tenant, 194 with no matching
  property/unit in Rincon's own tables, 24 with a matched unit but no
  `leases` row at all) — a meaningfully smaller pool, worth saying plainly
  to Peter rather than leading with the raw 667.
- **A confirmed-current record can become superseded on a later night, and
  the sync must actively retract it, not just leave it sitting there.**
  This design needs new behavior the previous table design didn't:
  deleting a previously-kept row for a unit once a newer Move-In is
  confirmed current for that same unit (see "A new operational requirement
  this design creates" above). If Q ships the insert side of this without
  the delete side, the table would silently accumulate stale, no-longer-
  current comps over time — the exact risk this whole redesign exists to
  eliminate. Worth TARS testing directly: simulate (or wait for) a real
  turnover on a unit already in the table and confirm the old row is gone,
  not just that the new one appeared.
- **No coordinates exist on LeadSimple's data (checked live — see Technical
  Notes) — CRMLS's radius-search mechanism doesn't apply here.** This source
  scopes "nearby" by matching zip code only (reusing CRMLS's own zip
  fallback path, which already exists for exactly this situation), not the
  lat/long-box search. Confirmed real volume across 156 distinct zip codes
  supports this being workable, not just a fallback of last resort.
- **A Move-In process that un-closes.** Rare, but real: if a previously
  closed process's `closed_at` reverts to null on a later sync (a walked-
  back or corrected case), the sync must delete any row already saved for
  that process — a cancelled Move-In is not a real transaction and must not
  linger in the comp pool. Confirmed live that `closed_at` is a plain,
  mutable field, not an append-only log.
- **The initial backfill is a separate step from the nightly cron.** The
  table starts empty; the first real run needs a wide lookback (e.g.
  `--since-days 730`) to backfill ~2 years of history before the nightly
  job's small overlap window (matching `sync-property-stages.js`'s
  `--since-days` pattern) takes over. Easy to forget and ship a source that
  looks live but has nothing in it for months.
- **Access lapses quietly, same as every LeadSimple/RentCast/CRMLS
  integration in this codebase.** If `LEADSIMPLE_API_KEY` stops working, the
  nightly sync fails loudly in its own logs, but the analysis tool itself
  just keeps running on whatever's already saved plus RentCast/CRMLS — worth
  the same periodic gut-check CRMLS's own spec flagged.
- **Deduping a Rincon unit that appears via two sources for the same real
  lease.** If a Rincon-managed unit is ever independently listed on CRMLS
  around the same time (a broker-assisted listing, say), `dedupeComps()`
  could keep the CRMLS copy over the LeadSimple copy on a tie (both weight
  3), and the kept copy would then get excluded by
  `excludeRinconManaged()` — silently losing a comp that should have
  counted. Low-probability, but Q should have `dedupeComps()`'s tie-break
  prefer the trusted-source comp when `listing_status` weight is tied,
  rather than leaving it to the current first-seen rule.

## What Q Needs to Build This

- **New file:** `lib/leadsimple.js` in `projects/rental-analysis/`, same
  shape as `lib/crmls.js`/`lib/rentcast.js` — one function
  (`pullLeadSimpleComps(subject)`) that reads the new
  `leadsimple_new_leases` table (via `lib/supabase.js`'s `select()`, filtered
  by zip and the freshness window below) and returns `{comps: [...], ...}`
  in the tool's standard shape. No live LeadSimple API call at analysis
  time — this only ever reads the synced table.
  - Reuse `extractZip()` from `lib/crmls.js` to get the subject's zip
    (self-sufficient — doesn't depend on RentCast running first or on
    `sources.js`'s ordering).
  - A tunable named constant, `MOVE_IN_LOOKBACK_MONTHS` (same style as
    `crmls.js`'s `SEARCH_RADIUS_MILES` / `market-data.js`'s
    `FRESHNESS_WINDOW_DAYS`), default 24 — "the last year or two at the
    most," per Peter's own words; easy to dial to 12–18 later.
  - A small `property_type` mapping table (same pattern as
    `FROM_CRMLS_PROPERTY_TYPE`), based on real, live-sampled values: `'Single
    Home'` and `'Single-Family'` → `'single_family'`; everything else
    (`'Multi-Family'`, `'Multi-Family 2-4 units'`, `'Student'`, two legacy
    price-range labels, and nulls) → `null` — ambiguous, left unmapped
    rather than guessed, same "say unknown" rule as the CRMLS/RentCast
    mappers.
- **One-line addition to `lib/sources.js`:** register `'LeadSimple Move-Ins':
  pullLeadSimpleComps` in `SOURCE_HANDLERS` — no loop changes needed, same
  as CRMLS's own addition.
- **`lib/weighting.js` changes** (the exclusion-conflict fix above): the new
  `SELF_SOURCED_TRUSTED_SOURCE_NAMES` set, the updated
  `excludeRinconManaged()`, and a shared helper both `lib/narrative.js` and
  `dashboard/index.html` can use so the trusted-source list lives in exactly
  one place.
- **`lib/narrative.js` change:** `describeComp()` (~line 50) needs the same
  trusted-source check so it stops telling Claude a counted, 3x-weighted
  comp is "internal reference only."
- **`dashboard/index.html` change:** the "Internal reference only — not an
  independent market comp" label (~line 1482) needs the same check — still
  show the `RINCON MANAGED` badge (it's true and useful info), just not the
  "not counted" language for a comp that is counted.
- **Database (Neo):** a new table, `leadsimple_new_leases` (name to
  confirm) — `leadsimple_process_id` (the Move-In process this row was last
  confirmed from — no longer the table's uniqueness guarantee, see below),
  **`matched_unit_id`** (new in this revision — the Rincon `units.id` this
  record was confirmed current against; **unique** — this is now the real
  invariant: at most one row per currently-confirmed unit, not one row per
  Move-In ever closed), address/city/state/zip_code as captured live (plain
  text fields, matching `rental_comps.address`'s own free-text convention),
  bedrooms/bathrooms/sqft, `rent` (always `leases.monthly_rent` — real,
  confirmed, never an estimate), lease_start_date (the **confirmed**
  `leases.lease_start`, not LeadSimple's own `unit.lease_start_date` —
  that field has the same live-snapshot unreliability as `current_rent`,
  see above), closed_at. **No `market_rent` or `is_estimated_price`
  column** — dropped from this revision's design, since this source never
  produces an estimate anymore (see "Does `market_rent`/`is_estimated_price`
  still belong" above); `lib/leadsimple.js` hardcodes
  `is_estimated_price: false` on every comp it maps instead. No
  `property_id` column and no address-matching *at analysis time* — unlike
  `leadsimple_property_stages`, this table has exactly one consumer
  (`lib/leadsimple.js`) and `server.js`'s existing pipeline already
  re-matches every comp from every source against `properties` at analysis
  time regardless of where it came from; the address-matching this revision
  adds happens once, at sync time, specifically to confirm currency (a
  different purpose than `server.js`'s own re-match). And a small
  `rental_comp_sources` row, seeded **inactive** (`is_active = FALSE`) —
  same pattern CRMLS's own FlexMLS placeholder used — flipped to active by
  Peter/Scotty (a plain UPDATE, no deploy) only once TARS confirms real
  comps are flowing end-to-end, so a half-tested source can't silently start
  feeding live recommendations.
- **New file:** `projects/hub/leadsimple-property-brain/sync-move-in-leases.js`
  — the nightly sync script. Same CLI shape as `sync-property-stages.js`
  (`--since-days`, `--dry-run`, `--help`), reusing the existing, already-
  tested `getProcessTypeIdByName('02 Move Ins')` /
  `listProcessesUpdatedSince()` connector functions with zero changes to
  `lib/leadsimple-connector.js`. Only considers a process once `closed_at`
  is set (an in-progress Move-In has no final lease yet); deletes a row if
  a previously closed process's `closed_at` reverts to null (see "What
  Could Go Wrong"). Must never call `getProcessTypeIdByName('05 Lease
  Renewal')` or `'17 Month to Month Renewal Process'` — those are explicitly
  out of scope, not just unused.
  - **Current-lease confirmation, for every closed record, not just
    null-`current_rent` ones** (see "Resolving rent accuracy — current
    lease only" above for the full design and live numbers). For each
    closed Move-In, query Rincon's main Supabase database (same
    `@supabase/supabase-js` client this script already uses, read-only,
    three tables: `properties`, `units`, `leases`) for the matching unit —
    matching LeadSimple's `full_address` against **both**
    `properties.address` and `units.unit_number` as candidates (not
    `properties.address` alone — confirmed live this under-matches
    multi-unit buildings, see above), then the closest `leases.lease_start`
    to `closed_at`. A small local copy of the house-number/unit-
    identifier/word-overlap matching logic (see the cross-project-
    dependency note above for why this is copied, not imported, from
    rental-analysis's `lib/property-matching.js`). A tunable named
    constant, `LEASE_MATCH_TOLERANCE_DAYS`, default **45**, unchanged from
    the last revision (re-validated live against the full 667-record set,
    not just the 189-record subset: genuine matches cluster within 40
    days, next-nearest false lead at 183 days). **Within tolerance →
    confirmed current: write the row, `rent = leases.monthly_rent`.
    Outside tolerance, no `leases` row at all, or no property/unit match →
    drop the record. No `market_rent` fallback exists in this design.**
  - **Retraction step, new in this revision:** before inserting a newly-
    confirmed-current row, delete any existing row in `leadsimple_new_leases`
    for the same `matched_unit_id` — a unit that turns over again must not
    leave its previous tenant's row sitting in the table (see "A new
    operational requirement" above and the matching "What Could Go Wrong"
    bullet).
- **Deployment step, not code:** the one-time wide-window backfill run
  (`--since-days 730` or similar) before the nightly cron entry is added —
  Scotty's setup, same "cron wrapper written by hand on Sally, excluded from
  repo deploys" convention `sync-property-stages.js`'s own header documents.

## Verification Target

Live-confirmed, real closed Move-In records to test against, re-pulled
directly from the account for this revision (2026-09-18). **Caution worth
naming plainly: this is live, changing data** — Rincon's leasing team closes
new Move-Ins and existing tenants turn over every day, so a specific
address's confirmed/superseded status can shift between this spec being
written and Q building it. TARS should verify against a fresh live run at
build time, not treat the specific numbers below as fixed expectations —
they're proof the mechanism works today, not a frozen fixture.

- **Confirmed-current example (expect KEPT, tagged `leased`, real rent):**
  2303 Otter Creek Ln, Oxnard, CA 93036 — closed 2026-09-16, matched
  `leases.lease_start` 2026-09-09 (7.8 days away, well within the 45-day
  tolerance), `leases.monthly_rent` **$3,865**. Confirm this comp lands
  with `is_estimated_price = false` and exactly this rent.
- **Superseded-pair example (expect the OLDER dropped, the NEWER kept —
  the core new behavior in this revision):** 3570 S B St., Oxnard, CA 93033
  has two closed Move-Ins in the 2-year window — one closed 2025-07-23,
  one closed 2026-09-08. Only the 2026-09-08 one is confirmed current
  (matched `lease_start` 2026-09-01, 7.7 days away, $3,445/mo); the
  2025-07-23 one must be dropped, even though LeadSimple's own
  `current_rent` field on *that* record also shows $3,445 — proof the sync
  is checking Rincon's `leases` table, not trusting LeadSimple's own
  (unreliable, live-snapshot) rent field.
- **Triple-turnover example (expect only the most recent of three kept):**
  263 S Ventura Rd #270, Port Hueneme, CA 93041 — closed Move-Ins on
  2022-04-13, 2023-06-26, and 2026-09-04 at the same unit. Only the
  2026-09-04 one (7.8 days from the matched `lease_start`, $2,250/mo)
  should survive; the other two must be dropped.
- **Matching-granularity example:** 130 N Garden St, Ventura, CA 93001 —
  the same 5-row building `lib/property-matching.js`'s own code comments
  already use as the worked example for the unit-identifier matching gate
  (units #3144, #1411, #1107, Unit 2121, Unit 3243). Live-confirmed this
  session: the #1107 unit's most recent closed Move-In (2025-05-09) is
  itself now superseded (its unit's `leases` row starts 2026-07-17, 433
  days away) — a good check that the sync correctly drops a stale record
  at a building where getting the *specific unit* right, not just the
  street address, actually matters (a wrong-unit match here would produce
  a wrong keep/drop decision, not just a wrong rent).
- Zip 93003 (Ventura) had 63 closed Move-Ins in the last 2 years — the
  single highest-volume zip on the account (raw pull volume, unaffected by
  this revision). Other strong zips: 93001 (62), 93036 (42), 93004 (41),
  93041 (38). Not every one of these will produce a confirmed-current
  comp now (most won't — see the 279/667 real yield above), so use these
  for "does the pull/match pipeline run at all," not "does every address
  in this zip return a comp."

TARS should confirm, with a real run: a confirmed comp appears tagged
`leased`, is *not* excluded from the recommended range (the core risk in
this spec), `RINCON MANAGED` shows without the "internal reference only"
language, and a superseded Move-In genuinely produces no comp at all rather
than a wrong one.

## Data Boundary

Hard boundary, matching `sync-property-stages.js`'s own v1 scope for the
other three process types, **narrowed further in this revision**: this
build reads **only** bedrooms/bathrooms/square_feet, address/city/state/zip,
and `closed_at` from LeadSimple's process/property/unit objects. It no
longer reads or stores LeadSimple's own `current_rent`, `market_rent`,
`lease_start_date`, or `lease_end_date` fields at all — established above
that none of these are reliable for anything but the single most-recent
Move-In at an address (they're a live snapshot, not a historical record),
so this design gets rent and lease-start exclusively from the `leases`
cross-reference instead of trusting LeadSimple's own copies. It never reads
or stores `contact_roles` (tenant/owner name, email, phone — confirmed
present as a real key on every LeadSimple process record, right alongside
the fields this build does use) or any other field on the process/
property/unit objects. This line is enforced the same way the existing
script enforces it: by simply never assigning that field to a variable
anywhere in the new sync script, not by a runtime filter.

**Same hard boundary applies to the `leases` cross-reference, on the
Rincon-database side — unchanged in shape from the last revision, but now
run for every one of the 667 closed records, not just the 189 that had no
`current_rent`.** The cross-reference reads exactly four columns from
Rincon's own `leases`/`units`/`properties` tables: `leases.monthly_rent`
(the rent itself, now the *only* source of rent this build ever writes),
`leases.lease_start` (the date-proximity check, and now the *only* source
of the lease-start date this build ever writes), and
`units.unit_number`/`properties.address,city,state,zip` (the address match —
discarded once the match decision is made, except for `units.id` itself,
kept as `matched_unit_id` so the sync can retract a superseded row later —
see "A new operational requirement" above). It never reads
`leases.tenant_id`, never joins to `tenants`, and never reads any other
column on `leases` (`status`, `notes`, `deposit_held_total`,
`move_out_date`/`move_out_reason`, `appfolio_id`, or anything else) —
enforced the same way, by simply never selecting those columns in the
query, not by a runtime filter. Only `monthly_rent`, `lease_start`, and
`units.id` ever make it into the new table; `is_estimated_price` is no
longer a stored column at all (see above) — it's hardcoded `false` at the
comp-mapping layer in `lib/leadsimple.js` instead, since this source never
produces anything else.

## Compliance Scope

Per GOVERNANCE.md's own scope line, the deeper pipeline applies when a build
"sends messages to tenants/owners, makes or influences a housing decision,
or stores personal data." This build does none of those: it sends no
messages, makes no decision about any applicant or tenant, and — per the
Data Boundary above — stores only property-level facts (address, bed/bath/
sqft, rent, lease dates), the same category of data RentCast and CRMLS
already supply today, not names, contact info, or anything applicant-
specific. On that basis, this build does not meet the compliance-build bar
and the standard CLAUDE.md pipeline applies (this spec, Neo on the schema, Q
builds, TARS tests with real data, Judge signs off).

**The `leases` cross-reference is a new data source this spec didn't
originally account for, so worth confirming explicitly rather than leaving
implicit: it doesn't change this picture — including now that it runs
against all 667 closed records instead of only the 189 that lacked a
rent.** `leases.monthly_rent` is a plain financial figure, not sensitive or
protected-class data — nothing about this repo's existing practice treats
a unit's rent amount that way, and reading it for more rows doesn't change
its sensitivity category. It's already read and displayed by other tools
in this exact codebase (`projects/hub/security-deposit/router.js`, and
rental-analysis's own `lib/crmls.js`/`lib/rentcast.js`/`lib/weighting.js`/
`server.js` already handle real rent figures from other sources today). As
confirmed in Data Boundary above, the cross-reference reads only
`monthly_rent`, `lease_start`, `units.id`, and the address/unit columns
needed to find the right row — never `tenant_id`, never anything from
`tenants`, never any other column on `leases`. No new applicant- or
tenant-identifying data enters this build as a result of this addition or
its wider scope.

Said plainly, though: this repo has real, on-the-record institutional
caution specifically about LeadSimple data — `compliance/leadsimple-spec-
governance-precheck.md` and `compliance/leadsimple-fair-housing-review.md`
both exist because a *different* LeadSimple domain (Application Screening
free-text notes, applicant comments, a housing-voucher mention) turned out
to carry real Fair Housing content that a keyword scan alone couldn't
certify. This build's own data shape is much closer to CRMLS's (structured,
property-level, no applicant narrative, no free text at all) than to that
one — Move-In process records carry no comparable free-text/comments field
in what this build actually reads. But given that precedent exists in this
exact codebase, Jarvis intends to get Asimov's quick sign-off on this
specific reasoning before Q builds, rather than relying solely on this
document's own self-assessment.

## Technical Notes (verified live, 2026-09-18)

Confirmed by direct, read-only GET requests against the real LeadSimple
account this session — not assumed, not paraphrased from documentation.

- **Process type:** `02 Move Ins`, id resolved via the existing
  `getProcessTypeIdByName()`. 672 processes updated in the last 2 years, 667
  closed (`closed_at` set).
- **No coordinates anywhere.** Checked the full object shape at all three
  levels — process, `properties[0]`, and `properties[0].unit` — no
  latitude/longitude field exists on any of them. This is why this source
  uses zip-only scoping (CRMLS's existing fallback mechanism) rather than
  `crmls.js`'s lat/long-box + Haversine radius search — that mechanism
  needs coordinates on both sides and this data source simply doesn't have
  them, not a stylistic choice.
- **Real field shapes**, from `properties[0]`: `address`, `city`, `state`,
  `zip_code` (populated on 665/667 closed records), `full_address` (a
  structured object with its own `.full_address` pre-formatted string),
  `property_type` (free text, 8 distinct real values seen, only 2 clean
  enough to map — see property_type mapping above).
- From `properties[0].unit`: `num_bedrooms`, `num_bathrooms`, `square_feet`,
  `market_rent`, `current_rent` (current_rent null on 189/667 closed
  records — 28%; market_rent null on only 23/667), `lease_start_date`,
  `lease_end_date`, `current_lease_move_in`, `unit_number` (in practice:
  equal to the property's own street address for a single-unit property,
  but the *specific* sub-address for a multi-unit one — e.g. `658 Poli St`
  on a parent property record addressed `656-658 Poli St` — confirmed real
  on a live closed record).
- `contact_roles` confirmed present as a top-level key on every process
  record — never read by this build, see Data Boundary.
- No `05 Lease Renewal` or `17 Month to Month Renewal Process` record is
  ever queried by this build's process-type filter — the exclusion is
  structural (a different `process_type_id`), not a runtime check on
  content.
- **`properties[0].unit` is a live snapshot, not a historical record tied
  to the process.** Confirmed on real closed records: a Move-In that closed
  2026-07-20 came back with `current_rent: null`, `lease_start_date: null`,
  `current_lease_move_in: null`, and `occupancy: "Vacant"` — because by the
  time of the API call, that tenancy had already ended. 185 of the 189 real
  null-`current_rent` closed records had no usable `lease_start_date`/
  `current_lease_move_in` either, for the same reason. This is why the
  `leases` cross-reference (see "Resolving rent accuracy — current lease
  only" above) anchors its date-proximity check on the process's own
  `closed_at`, not on any date field nested under `unit`.
- **`leases` cross-reference, originally live-tested against just the 189
  real null-`current_rent` closed records (previous revision):** 24 had any
  same-address candidate in `leases` at all; 13 resolved to a real match
  within 45 days of `closed_at`. `leases` itself holds 433 rows total (408
  active, 25 terminated) — roughly one row per currently-or-recently-
  occupied unit, not a multi-year archive.

### Additional live findings, this revision (2026-09-18) — re-testing against the full 667, not just the 189-record gap

- **The live-snapshot problem also corrupts populated `current_rent`
  values, not just null ones.** 458 distinct addresses among the 667
  closed records; 135 of those addresses have 2+ closed Move-Ins in the
  window (206 "older" records sitting behind a more recent one at the same
  address). Checked every consecutive older/newer pair: 117 of 206 (57%)
  show the OLDER record's `current_rent` and/or `lease_start_date`
  matching the NEWER record's exactly — proof `properties[0].unit` reflects
  today's occupant on *every* process record for that address, not just
  the one it nominally belongs to. Real example: a Move-In closed
  2020-07-23 at 2303 Otter Creek Ln shows `current_rent: 3865.0`,
  `lease_start_date: 2026-09-09` — identical to the Move-In that closed at
  the same address on 2026-09-16.
- **`properties.address` is not consistently unit-qualified even for
  multi-unit buildings, but `units.unit_number` is.** Confirmed against
  the real "130 N Garden St" building (5 rows in `properties`): one row's
  own `address` is the plain "130 N Garden St" with no unit, while its one
  child `units` row has `unit_number: "130 N Garden St Unit 3243"` — the
  unit distinction lives on `units`, not reliably on `properties`, for
  every row. Matching LeadSimple's `full_address` against `properties.address`
  alone under-matches multi-unit buildings; matching against
  `units.unit_number` as well is necessary. Also confirmed:
  `properties`/`units` in this account are effectively 1:1 (398 properties,
  467 units; 350 properties have exactly 1 unit, 37 have 2+, up to 15 on
  one property) — not "one building row with many units," which shaped how
  the matching approach above was written.
- **`leases.monthly_rent` is refreshed nightly from AppFolio, not frozen at
  signing.** Confirmed in `projects/appfolio-sync/sync.js`: multiple report
  handlers (`delinquency`, `tenant_tickler`, `lease_expiration_detail`,
  `rent_roll`) write `monthly_rent: parseFloat(row.rent...)` via a merge-
  duplicates upsert keyed by `appfolio_id`, so a long-tenured lease's
  `monthly_rent` reflects whatever AppFolio's own live reports say is being
  charged today (increases included), not the original signing rent. This
  is why the 2-year lookback window's purpose shifts to "was this a recent
  new-tenant signing event," not "is the rent data fresh" — see "Does the
  2-year lookback window still matter" above.
- **Full cross-reference results, live, against all 667 closed records**
  (corrected matching — `full_address` against both `properties.address`
  and `units.unit_number`, `LEASE_MATCH_TOLERANCE_DAYS = 45`, unchanged):
  279 confirmed current (kept, real rent), 170 confirmed superseded
  (dropped), 194 with no property/unit match in Rincon's own tables at all
  (dropped), 24 with a matched unit but no `leases` row (dropped). Total
  279 + 170 + 194 + 24 = 667.
- **Day-distance distribution re-confirms 45 days as the right tolerance,
  now against the full set, not just the 189-record subset.** Sorting
  every matched record's distance from its nearest `leases.lease_start`: a
  dense cluster from 0–40 days, then a real gap (only 11 records land
  between 41 and 183 days), then a second dense population resuming at
  ~183 days and climbing into the hundreds (clearly different, older
  tenancies). Same shape the previous revision found on the smaller
  subset, now verified against the whole dataset.
