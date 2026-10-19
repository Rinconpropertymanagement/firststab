# AppFolio API — Capabilities Notes

Running notes on what Rincon's AppFolio API access can and can't do, confirmed
directly by AppFolio (not guessed or inferred from public docs), so future
work doesn't have to re-ask or re-discover the same things.

## Document/attachment downloads — confirmed 2026-08 via AppFolio contact "John"

Peter asked (2026-08-13 email) whether the current API access allows
downloading documents from property or tenant pages. Answer:

- **Property pages:** the API can list attachment metadata (file names,
  IDs). Whether the response includes an actual download URL is
  unconfirmed — needs testing, not yet verified either way.
- **Tenant pages:** no attachment endpoint exists in the API at all today.
  Tenant documents are not accessible via the API.

**Why this matters:** this confirms an assumption already built into
`projects/hub/security-deposit/SPEC.md` — that AppFolio document downloads
aren't automatable today, which is why that tool has a pod lead manually
upload the written inspection forms rather than pulling them in
automatically. No design change needed there; this is official
confirmation the existing workaround was the right call, not a gap to fix.

**Still open:** Peter also asked about "the claude connection" in the same
email — AppFolio's reply didn't address that question at all. Unresolved,
follow up separately if it still matters.

**Source:** email thread between Peter McKenzie (peter@rinconmanagement.com)
and AppFolio contact John, question sent 2026-08-13, answer relayed
2026-08-17.

## Daily vacancy snapshot — added 2026-10-18 (code: vacancy-snapshot.js)

- Each sync run also saves one row per vacant unit per Pacific day (about 50) into the Supabase table `unit_vacancy_snapshots`, taken from AppFolio's `unit_vacancy` report. The sync runs at 15, 17, 19, 21 and 23 UTC Mon-Fri, 01:00 UTC Tue-Sat and 09:00 UTC daily (about 7 runs on a Pacific weekday, 1 on a weekend day); every run overwrites that day's row, so the row holds the state at the day's LAST run.
- It saves only unit numbers (unit, property, status, asking rent, scheduled rent, days vacant), never tenant details, and it never deletes anything; a snapshot problem is logged as one `[vacancy-snapshot]` line, it gives up by itself after 150 seconds, and it can never fail the sync.
- In the report, `new_rent` is NOT the asking rent (it is only filled once a unit is already rented), so `asking_rent` comes from `advertised_rent`. `days_vacant` is a real AppFolio field, but it is stored as NULL when AppFolio has no move-out date for the unit (AppFolio then says 0, which means "unknown", not "just vacated") and for units still on notice; a real 0 means moved out within the last day.
- To read it: Supabase table `unit_vacancy_snapshots`, filter on `snapshot_date` (Los Angeles date) or on one `unit_id` for that unit's history; no row on a date means the unit was not in that day's report (or the sync did not run).
- Safety check: if a report has fewer than 20% of the last saved day's rows it is NOT written and the log says "looks cut short". If the log shows "looks cut short" on 3 or more consecutive days, ask Q (or run `node vacancy-snapshot.js --force` once after checking the report; `--force` is for hand runs only, the sync can never use it).
- To check by hand: `node vacancy-snapshot.js --dry-run` shows what would be saved and writes nothing (a mistyped option such as `--dryrun` is refused, never run); `node snapshot.test.js` runs the self-checks (no real AppFolio or database calls).
