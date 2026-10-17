# Blind accuracy test

A developer/ops tool, not part of the app staff use. For every past lease it asks: "if the rent tool had been run the day before this lease closed, knowing only what existed then, what would it have said?", then compares that with what the home actually leased for. (For Rincon's own leases the date is the move-in, the day the lease starts.) It runs the real tool code (`lib/sources.js`, `lib/property-matching.js`, `lib/weighting.js`, `lib/analyze.js`) on a pool of comps rebuilt as of each date. It reads only: it never writes to Recore or Supabase, never calls RentCast or Anthropic, and never prints a key.

Plan: `../CMA-QUALITY-SPEC.md`, Phase A.

## Commands (run from `projects/rental-analysis/`)

| What you want | Command |
|---|---|
| Run on the data already saved here (no network; about 2 minutes on an idle machine, longer when the computer is busy) | `node backtest/run.js` |
| Pull fresh data first, run everything, including the live check against Recore | `node backtest/run.js --refresh` |
| The monthly routine (publishes THIS run's scorecard only if it is trusted and the run was complete; otherwise it refuses and exits with an error) | `node backtest/run.js --refresh --publish` |
| Re-check the replay against the live Recore feed (needed again whenever the product's comp-pulling code or the replay changes) | `node backtest/run.js --fidelity` |
| Skip the second pass that re-runs the MLS leases as of the day each went on the market (on by default, about 15 seconds; the report states its effect) | `node backtest/run.js --no-asof-listing` |
| Prove the `lib/analyze.js` refactor changed no number | `node backtest/a0-replay.js` |
| See all options | `node backtest/run.js --help` |
| Check the building blocks | `node q-mapping-unit-test.js` |

`--refresh` makes about 30 free Recore reads plus 3 Supabase reads, then about 10 more Recore reads for the live check. `--publish` copies the scorecard THIS run built into `lib/accuracy-scorecard.json` in BOTH `lib/` folders, and only if that scorecard says `"trusted": true` and the run was complete; look at the result and commit it yourself (nothing here commits, merges or deploys). If the saved data is missing or damaged, the run stops with one line telling you to use `--refresh`. A run is **complete** only on the default settings: any of `--limit`, `--target-from`, `--holdout-from`, `--today` or `--plant-leak` makes it partial, so it never updates `backtest/scorecard.json`, is never trusted, and `--publish` with it is refused at once with an error.

## What you get

- `out/<date>/report.md`: the readable result. Percentages and counts only, safe to share.
- `out/<date>/detail.csv`, `worst-misses.csv`, `outcomes.csv`: one row per lease WITH addresses. Local only.
- `scorecard.json`: the committed summary. Aggregates only (every group has 20+ leases; a guard refuses to write an address, zip code, listing id or email).
- The report opens with three checks. **Leak self-test**: the answer is put back into the pool on purpose and the error must collapse. **Fidelity check**: for 5 known properties the replay's MLS comps must be identical to a live call of the real `pullCrmlsComps()`. **No-peeking guard**: any comp dated on or after the lease's start date stops the run. The scorecard says `"trusted": true` only when all three held in the same run. The fidelity result is tied to the code it checked: it stores a content hash of the product's comp-pulling files (`lib/crmls.js`, `lib/leadsimple.js`, `lib/sources.js`, `lib/rentcast.js`, `lib/weighting.js`, `lib/property-matching.js`, `lib/analyze.js`, `lib/constants.js`) and of the replay itself (`asof-sources.js`, `candidates.js`, `engine.js`, `selftests.js`), and it is invalid, so the scorecard is not trusted, as soon as any of them changes or the data is re-pulled, until `--fidelity` is run again. The lookbacks the replay uses (6 months of closed leases, 24 months of Rincon leases today) are read from the product's own modules, and the scorecard is also untrusted if any pool's setting differs from the product's. It is untrusted as well when the saved data is more than 45 days old, does not reach back far enough for the targets, or when the network guard saw anything other than Recore and Supabase (the guard blocks RentCast and Anthropic outright and counts every request; the counts are in the scorecard).

## Keep this data off the server and out of git

`cache/` (MLS records, Rincon lease rows) and `out/` (per-address results) are git-ignored by `backtest/.gitignore`, and `deploy-to-sally.sh` excludes both folders from its `rsync`, so they are never copied to Sally. The repo is public, so they must never be committed either. If you move or rename them, update both files.

## Reading the result

`out/<date>/report.md` starts with a plain-English "How to read this" and a preview of the exact sentences staff would see, generated from the scorecard (never typed in). Every sentence names its area ("Ventura-area" or "Ventura core"), shows the date the data was pulled, says that RentCast listings were not part of the test, and quotes a rate only when 100 or more leases stand behind it. About a quarter of the leases are in the LA-border cities (Westlake Village, Agoura Hills, Calabasas, West Hills and a few others), which rent for more and are missed by more; the report and scorecard give those figures separately from the rest of the Ventura-area.

## Files

- `run.js` command line and orchestration · `data.js`, `recore.js`, `db.js`, `env.js` read-only data access and the local cache
- `targets.js` which leases are tested · `asof-sources.js` the replay of the live sources, the no-peeking guard, removal of the target itself
- `engine.js` runs one lease through the real tool · `metrics.js` scoring · `report.js` report, scorecard, staff sentences
- `candidates.js` the methods, pools, tuning candidates and the rule for adopting a change, written before any hold-out is looked at · `judging.js` the "judged once" lock: a candidate can be judged again only on a hold-out that starts after the end of the one it was last judged on, and the verdict text is stored
- `provenance.js` the code hashes that tie the fidelity result to the code it checked · `publish.js` the rules for `--publish` · `netguard.js` counts and blocks outside network requests
- `outcomes.js` matches saved reports to leases signed later · `selftests.js` leak and fidelity checks
- `a0-replay.js` with `tests/a0-legacy-pipeline.js` (frozen copy of the pre-refactor code) the A0 proof
- `appendix-g.js` the spec's reference numbers, printed beside each run

## What it cannot see

RentCast is not in the pool (the RentCast snapshot, phase A2, is not built), and RentCast is about 45% of the comps staff see. Pricing happens at listing time but the test knows everything up to the day the lease closed, so it is optimistic (the report measures by how much by re-running the leases as of the day each went on the market). Only homes that actually leased are tested, and duplexes, triplexes, fourplexes and apartments are not. As-of asking prices are only listings that later leased, priced at their original list price. Rincon's lease table keeps only leases that are still current. A signed rent is not always the market rent. The report lists these every time.
