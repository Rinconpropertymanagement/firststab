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
