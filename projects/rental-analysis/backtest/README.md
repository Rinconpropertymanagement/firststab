# Blind accuracy test

A developer/ops tool, not part of the app staff use. For every past lease it asks: "if the rent tool had been run the day before this lease closed, knowing only what existed then, what would it have said?", then compares that with what the home actually leased for. (For Rincon's own leases the date is the move-in, the day the lease starts.) It runs the real tool code (`lib/sources.js`, `lib/property-matching.js`, `lib/weighting.js`, `lib/analyze.js`) on a pool of comps rebuilt as of each date. It reads only: it never writes to Recore or Supabase, never calls RentCast or Anthropic, and never prints a key.

Plan: `../CMA-QUALITY-SPEC.md`, Phase A.

## Commands (run from `projects/rental-analysis/`)

| What you want | Command |
|---|---|
| Run on the data already saved here (no network; about 2 minutes on an idle machine, longer when the computer is busy) | `node backtest/run.js` |
| Pull fresh data first, run everything, including the live check against Recore | `node backtest/run.js --refresh` |
| The monthly routine (publishes THIS run's scorecard only if it is trusted and the run was complete; otherwise it refuses and exits with an error) | `node backtest/run.js --refresh --publish` |
| Ask the MLS again what kind of home (house, condo, townhouse ...) each saved Rincon lease is, then run on the data already saved (about 13 free Recore reads; answers under two weeks old are reused; nothing else in the saved data changes) | `node backtest/run.js --refresh-types` |
| Re-check the replay against the live Recore feed (needed again whenever the product's comp-pulling code or the replay changes) | `node backtest/run.js --fidelity` |
| Skip the second pass that re-runs the MLS leases as of the day each went on the market (on by default, about 15 seconds; the report states its effect) | `node backtest/run.js --no-asof-listing` |
| Prove the `lib/analyze.js` refactor changed no number (the Phase B rules are switched off for this proof) | `node backtest/a0-replay.js` |
| Prove the Phase B rules (size band 25% plus the furnished / short-term / 55+ rules), as the real `lib/` code applies them, give the same answer for every lease as the simulation the test used before they were built (about 75 seconds, saved data only, no network) | `node backtest/phase-b-equivalence.js` |
| See all options | `node backtest/run.js --help` |
| Check the building blocks | `node q-mapping-unit-test.js` |

`--refresh` makes about 30 free Recore reads plus 3 Supabase reads, about 13 more Recore reads to ask the MLS what kind of home each Rincon lease is (see "How Rincon leases are typed" below), then about 10 more Recore reads for the live check. `--publish` copies the scorecard THIS run built into `lib/accuracy-scorecard.json` in BOTH `lib/` folders, and only if that scorecard says `"trusted": true` and the run was complete; look at the result and commit it yourself (nothing here commits, merges or deploys). If the saved data is missing or damaged, the run stops with one line telling you to use `--refresh`. A run is **complete** only on the default settings: any of `--limit`, `--target-from`, `--holdout-from`, `--today` or `--plant-leak` makes it partial, so it never updates `backtest/scorecard.json`, is never trusted, and `--publish` with it is refused at once with an error.

## What you get

- `out/<date>/report.md`: the readable result. Percentages and counts only, safe to share.
- `out/<date>/detail.csv`, `worst-misses.csv`, `outcomes.csv`: one row per lease WITH addresses. Local only.
- `scorecard.json`: the committed summary. Aggregates only (every group has 20+ leases; a guard refuses to write an address, zip code, listing id or email).
- The report opens with three checks. **Leak self-test**: the answer is put back into the pool on purpose and the error must collapse. **Fidelity check**: for 5 known properties the replay's MLS comps must be identical to a live call of the real `pullCrmlsComps()`. **No-peeking guard**: any comp dated on or after the lease's start date stops the run. The scorecard says `"trusted": true` only when all three held in the same run. The fidelity result is tied to the code it checked: it stores a content hash of the product's comp-pulling files (`lib/crmls.js`, `lib/leadsimple.js`, `lib/sources.js`, `lib/rentcast.js`, `lib/weighting.js`, `lib/property-matching.js`, `lib/mls-facts.js`, `lib/analyze.js`, `lib/constants.js`) and of the replay itself (`asof-sources.js`, `rincon-mls.js`, `candidates.js`, `engine.js`, `selftests.js`) and of the pull (`recore.js`, which says which MLS fields are fetched, the county field included), and it is invalid, so the scorecard is not trusted, as soon as any of them changes or the data is re-pulled, until `--fidelity` is run again. The lookbacks the replay uses (6 months of closed leases, 24 months of Rincon leases today) are read from the product's own modules, and the scorecard is also untrusted if any pool's setting differs from the product's. It is untrusted as well when the saved data is more than 45 days old, does not reach back far enough for the targets, or when the network guard saw anything other than Recore and Supabase (the guard blocks RentCast and Anthropic outright and counts every request; the counts are in the scorecard).

## How Rincon leases are typed (house, condo, townhouse)

LeadSimple calls almost every Rincon property a "Single Home", but the MLS says close to half of those are condos or townhomes. The product therefore asks the MLS what is at each Rincon lease's street address while an analysis runs (`lib/leadsimple.js`, `lookupMlsRecords()` and `classifyRinconLease()`), and the same function builds the Rincon comps for the live tool and for this test (`buildLeadSimpleComps()`). The test cannot reach the network while it replays, so it reads the SAME answers from `backtest/cache/rincon-mls.json` (street, zip, unit and the MLS's kind of home only; no rents, dates or names), pulled by `--refresh` or `--refresh-types` through `rincon-mls.js`. The same file types the Rincon test leases themselves: a lease the MLS shows to be a condo is tested as a condo, a townhouse as a townhouse, and one that is not a house, condo or townhouse (a condo/townhouse mix, a duplex) is left out and counted as `typeNotTested` in the report. The report page's other two Rincon rules apply here too, because they live in the same shared code: a lease whose rent cannot be right (outside $800-$12,000 a month or $0.80-$6.00 a square foot; the same four numbers choose which Rincon leases are tested, `lib/constants.js` `RINCON_RENT_SCREEN`) never counts, and a "Multi-Family" lease counts only for apartment-type subjects unless the MLS names another type.

The scorecard is NOT trusted when `rincon-mls.json` is missing, when more than 2% of the searchable Rincon addresses have no saved answer, or when the oldest answer is more than 45 days old. `node backtest/phase-b-equivalence.js` also proves, on every Rincon lease and four kinds of subject, that the product's live lookup (run against a pretend Recore that serves the saved answers) and the replay's saved-answers path give identical comps.

## The two methods in the scorecard

- **baseline** is the tool before Phase B: bedrooms and property type only. The engine gives the tool a subject with no square footage and none of the form's furnished / lease length / 55+ facts, and the rules in `lib/weighting.js` only switch on for a subject that carries them, so the real code behaves exactly as it did before Phase B.
- **size25_item2** is the tool with Phase B: the real `lib/` code applies the 25% size band and the furnished, short-term and 55+ rules, because the engine gives it the full subject (square footage, unfurnished, a 12-month lease, not 55+, the form's defaults). Before Phase B was built this column was a simulation (the same rules as a filter on the comps, method `size25_item2_sim` in `candidates.js`). `node backtest/phase-b-equivalence.js` runs both on every lease in every pool and requires the identical estimate, range, comp count and list of counted rents; it passed on all of them, which is why the scorecard's numbers did not change when the simulation was replaced by the real code. The other tuning variants (`item2`, `size25`, bands 15/20/30/35) still use the simulated filter, because the shipped band is fixed at 25%.

## The rule for adopting a change

A tuning change ships only if, on the newest three months of leases that were not used to choose it, it passes ALL of these (`evaluateAcceptance` in `candidates.js`; the numbers are in `constants.js`):

- (a) at least 4 points more leases within $300 of the estimate;
- (b) the typical miss is better by at least $25;
- (c) **right answers per 100 reports tried must not fall** (right = the suggested price is within $300 of the signed rent);
- (c2) **badly wrong answers per 100 reports tried must fall** (badly wrong = off by more than $600);
- (d) no large group (100 or more leases) is worse by more than 3 points;
- (e) at least 300 hold-out leases (150 for Rincon-only changes).

Rule (c) was rewritten by Peter on 2026-10-17. It used to say "no more than 5 points fewer reports may get a range"; that is gone, because the size rule is worth it even though fewer reports get a range. A report that gets no range counts as neither right nor wrong, so a method cannot look better by declining to answer, and cannot look worse just for being careful. On the saved data the Phase B rules go from 34.8 to 38.5 right answers per 100 tried and from 34.1 to 20.8 badly wrong ones per 100 tried (whole box), so they pass.

## What the product reads from this test

`node backtest/run.js --refresh --publish` (or `--fidelity --publish`) copies this run's scorecard into `lib/accuracy-scorecard.json` in both `lib/` folders, but only when the run is complete and trusted. The report page reads that file when the server starts and writes its staff sentences from it with `lib/accuracy-sentences.js`, the same code this test's report uses for its preview. If the file is missing, damaged or not trusted, those sentences are simply left out. The product's recommended range, suggested price and High / Medium / Low label (`lib/weighting.js`, `lib/confidence.js`) are checked against this folder's reference copy (`metrics.js`) on every lease by `phase-b-equivalence.js`, so the published hit rates describe the tool that really runs.

## Keep this data off the server and out of git

`cache/` (MLS records, Rincon lease rows, the saved MLS answers about Rincon lease types) and `out/` (per-address results) are git-ignored by `backtest/.gitignore`, and `deploy-to-sally.sh` excludes both folders from its `rsync`, so they are never copied to Sally. The repo is public, so they must never be committed either. If you move or rename them, update both files.

## Reading the result

`out/<date>/report.md` starts with a plain-English "How to read this" and a preview of the exact sentences staff would see, generated from the scorecard (never typed in). Every sentence names its area, shows the date the data was pulled, says that RentCast listings were not part of the test, and quotes a rate only when 100 or more leases stand behind it.

**Ventura County vs the LA-border area.** The test area also takes in the Los Angeles side of the Conejo Valley border, and the town of Westlake Village straddles the county line. So leases are grouped by the county the MLS records for each home (the Recore field `CountyOrParish`; values seen: Ventura, Los Angeles, a few Santa Barbara around Carpinteria, and "Other County", which CRMLS uses when the county is not in its pick-list and which is treated as "no county"). The two groups are "Ventura County" and "Other counties (LA-border area)" (every other county; in the current pull every other-county lease is Los Angeles County, so the label is exact today, and the report prints the county values on every run so a change would show). A lease whose record has no usable county is placed by the old city list (Westlake Village, Agoura Hills, Calabasas, West Hills, Woodland Hills, Malibu, Hidden Hills, Canoga Park, Agoura, Los Angeles count as other counties); the report states how many that is, and says so as a limit when it is more than 2% of the tested leases. The county is used for GROUPING ONLY: it never changes which comps the tool uses, the comp box, or any headline number. The staff accuracy line and the per-label sentences quote the "Ventura County" group (labelled that way) when it has 100 or more leases with a range and no more than 2% of the leases lack a county, and say that figures for the LA-border area are reported separately; otherwise they quote the whole Ventura-area box with the "Ventura-area" wording. The report shows both groups side by side for today's code and the proposed rules (coverage, typical miss, within $300, range hit), how many Westlake Village leases fall in each county group, and a city-by-county table. The scorecard has a `counties` block (aggregates only, each side published at 20 or more leases) next to the older `regions` block, which keeps the old city-list split for comparison. The county field is part of the pull, so after this change the first run needs `--refresh` (or the saved data has no county and every lease counts as "county unknown").

## Files

- `run.js` command line and orchestration · `data.js`, `recore.js`, `db.js`, `env.js` read-only data access and the local cache
- `targets.js` which leases are tested · `asof-sources.js` the replay of the live sources, the no-peeking guard, removal of the target itself
- `engine.js` runs one lease through the real tool · `metrics.js` scoring · `report.js` report, scorecard, staff sentences
- `candidates.js` the methods, pools, tuning candidates and the rule for adopting a change, written before any hold-out is looked at · `judging.js` the "judged once" lock: a candidate can be judged again only on a hold-out that starts after the end of the one it was last judged on, and the verdict text is stored
- `rincon-mls.js` pulls, saves and replays the MLS answers about what kind of home each Rincon lease is · `tests/fake-recore-mls.js` a pretend Recore for tests and the equivalence proof
- `provenance.js` the code hashes that tie the fidelity result to the code it checked · `publish.js` the rules for `--publish` · `netguard.js` counts and blocks outside network requests
- `outcomes.js` matches saved reports to leases signed later · `selftests.js` leak and fidelity checks
- `a0-replay.js` with `tests/a0-legacy-pipeline.js` (frozen copy of the pre-refactor code) the A0 proof (run with the Phase B rules switched off, so it keeps proving that moving the pipeline changed no number)
- `phase-b-equivalence.js` the Phase B proof (see "The two methods" below), which also checks the product's recommended range, prices and label against `metrics.js`
- `appendix-g.js` the spec's reference numbers, printed beside each run

## What it cannot see

RentCast is not in the pool (the RentCast snapshot, phase A2, is not built), and RentCast is about 45% of the comps staff see. Pricing happens at listing time but the test knows everything up to the day the lease closed, so it is optimistic (the report measures by how much by re-running the leases as of the day each went on the market). Only homes that actually leased are tested, and duplexes, triplexes, fourplexes and apartments are not. As-of asking prices are only listings that later leased, priced at their original list price. Rincon's lease table keeps only leases that are still current. About 4 in 10 Rincon addresses have no MLS record at all, so those leases keep LeadSimple's "Single Home" label here, exactly as in the product. A signed rent is not always the market rent. The report lists these every time.
