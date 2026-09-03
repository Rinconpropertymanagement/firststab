# Flagged Content Review — Grouped View + Known-Safe Exclusions

**Status:** Both Mason's and Asimov's reviews found real problems, one of them (Asimov's) a genuinely serious, previously-unknown gap. **Part 1 is approved to build, with specific conditions below. Part 2 is not approved as scoped** — needs a real redesign, a Neo-owned migration, and outside attorney sign-off + shadow mode before it can ever go live (GOVERNANCE.md Rule 6). Written 2026-09-03, following the full 5-year maintenance snapshot backfill.
**Origin:** Peter's real complaint after seeing the backfill's flag rate (~2.3% of ~11,500 rows ≈ 250-300 items): reviewing that many one-by-one is impractical, and a large share are repeat false positives (a brand name like "Bradford White," a paint color like "white") that have nothing to do with anyone's race — and nothing about the system gets smarter after a human says so. This spec covers two connected pieces: a way to review flagged items in batches instead of one at a time, and a real (not AI-"learning") mechanism so a confirmed false positive stops recurring.

---

## Part 1 — Grouped Review View

### The problem today

`GET /api/maintenance-history/flagged-queue` already merges flagged `maintenance_claims` and `maintenance_snapshot_events` into one list (built earlier tonight), but it's still one row per item — a reviewer facing 250+ items has to open and judge each individually, even when many are the exact same false positive repeating.

### The real constraint that shapes this design

`lib/protected-class-terms.js`'s `scanText()` already computes exactly which word/phrase matched (`matchedTerms`), but the file's own header comment is explicit: this must never be written to `audit_log` or any log — only `flagged_category` and `matched_layer` get persisted (confirmed by reading `content-check.js`'s `checkClaim()`, which deliberately drops `matchedTerms` before returning). That restriction exists for a real reason (the matched term, out of context, could itself hint at sensitive content in a way a bare category label doesn't) and this spec does not propose changing it.

**The fix: don't persist the matched term — recompute it live, only for someone already allowed to see the full flagged text.** A `PRIVACY_REVIEW_ROLES` reviewer already reads the raw `claim_text`/`summary` today (that's the whole point of human review). Re-running `scanText()` against that same already-visible text, at request time, to cluster the queue by matched term/category, tells the reviewer nothing they couldn't already see by opening each item — it just saves them from opening 250 of them.

### What changes

- `GET /api/maintenance-history/flagged-queue` gets an optional `?grouped=true` mode. Instead of a flat list, it returns clusters: `{ category, matched_term, matched_layer, count, sample_text, item_ids: [...] }` — grouped by (matched term, category) for Layer 1 hits, and by (category, matched_layer='model') for Layer 2-only hits (which have no single matched term to cluster on — see Open Items).
- A new bulk action, `POST /api/maintenance-history/flagged-queue/bulk-review`, taking a list of item ids (mixed claims/snapshot-events, using the existing `item_type` tag) plus one action (confirm/correct is not offered in bulk — only same-shape reject, or a bulk-confirm for the rare case a whole cluster is a real, correctly-flagged repeat pattern someone wants to acknowledge at once). Internally this just calls the same per-item review logic already built and audited tonight, once per id — no new review-writing code, just a loop over the existing, already-correct single-item path.
- Dashboard: the "Needs Privacy Review" section gets a toggle between today's flat list and the new grouped view. Grouped view shows each cluster with a sample flagged line, a count, and one Reject-all / Confirm-all action, with a "view individually" expand for anyone who wants to check items inside a cluster before bulk-acting.

### What this does NOT do

- Doesn't touch the underlying flagging logic itself (Part 2 does that).
- Doesn't change what any non-reviewer role can see — `matched_term` is computed and returned only inside the already-gated `flagged-queue` response, same access rule as everything else in this queue.

---

## Part 2 — Known-Safe Exclusions

### The problem today

Confirmed directly with Peter: **nothing learns from a review decision today.** Layer 1 is a static keyword list with no memory. Layer 2 re-evaluates every row fresh, with no awareness of prior human decisions on the same phrase. Rejecting "Bradford White" as a false positive doesn't stop the next Bradford White water heater bill from getting flagged too.

### The fix — a real, explicit allowlist, not machine learning

A new table, `content_check_exclusions`: `id`, `phrase` (exact text, case-insensitive match), `category` (which flagged category this exclusion applies to — an exclusion is scoped to one category, not a blanket "never flag this word again" across every category), `added_by`, `added_at`, `reason` (free text, required — why this was excluded), `active` (boolean, so an exclusion can be turned off later without deleting the record).

**Layer 1 change:** `scanText()` checks each matched term against active exclusions for that term's category before including it in the flag result. An excluded exact phrase no longer contributes to a flag *for that category* — a phrase excluded from `race_color` would still trigger correctly if it somehow also matched a completely different category's term list (narrow by design, not a blanket exemption).

**Layer 2 — deliberately NOT touched by this spec.** Layer 2 is a semantic judgment call, not a keyword match — there's no clean, reliable way to tell a fresh AI call "don't flag this phrase" without either (a) maintaining a growing few-shot prompt that could itself leak sensitive examples into every future call, or (b) trying to pattern-match the AI's own free-text reasoning after the fact, which is unreliable. Layer 1 improvements should absorb the large majority of the observed false-positive volume (brand names, paint colors, and stock phrases are exactly the kind of literal-keyword-match false positive Layer 1 produces) — Layer 2's false-positive rate wasn't separately measured tonight and may simply be low enough not to need this. Revisit only if Layer 2-only false positives turn out to be a real, recurring problem once the grouped view makes them visible.

### Where the action lives

In the grouped review view (Part 1), each cluster's Reject-all action gets one additional, separate, off-by-default checkbox: **"Also stop flagging '[exact phrase]' as [category] going forward."** Deliberately not bundled into the default reject action — excluding a phrase from all future scans is a more consequential, harder-to-reverse decision than rejecting today's batch, and should require its own explicit, visible choice, not a side effect of clearing the queue.

### Access and governance

- **Recommend restricting who can add an exclusion to `admin` only** — narrower than the general `PRIVACY_REVIEW_ROLES` (`admin`/`reviewer`/`director_of_operations`) that can reject individual items today. Rejecting one item only affects that one row; adding an exclusion changes what the *entire system* flags for everyone, going forward, permanently until someone reverses it. That's a structurally different kind of decision and this spec's own recommendation is to gate it more narrowly — Peter's call, flagged as an explicit Open Item below, not decided here.
- Every exclusion add/deactivate writes a real `audit_log` entry (`action: 'content_check_exclusion.added'` / `'.deactivated'`), same discipline as every other consequential action in this system tonight.
- **This needs a real Asimov and Mason pass before it's built** — not a courtesy step. This spec proposes deliberately narrowing the exact safety mechanism that Fair Housing review built and that tonight's own governance cycle twice required strengthening (the Layer 2 addition, the reviewer-queue fix). Getting the exclusion scope wrong (too broad) could recreate exactly the blind spot Layer 1 was built to avoid. This is flagged as a hard requirement, not a recommendation Peter can skip.

---

## Mason's Review — Real Design Flaw Found, 2026-09-03

**The core problem: `scanText()` matches and records the bare dictionary word, not the surrounding phrase.** Read the actual code (`protected-class-terms.js`): a "Bradford White" water heater bill and "painted the trim white" both produce the exact same matched term — `white` — because matching is `\bwhite\b` against the fixed term list, and what gets returned is the dictionary entry itself, not the sentence around it. This spec's Part 1 (cluster by matched term) and Part 2 (exclude a matched term for a category) were both written as if "Bradford White" and "white trim" are two distinguishable, narrowly-scoped patterns. **They are not, as designed — they're the same cluster and the same exclusion.** Excluding "white" from `race_color` to quiet vendor-brand noise would also blind the system to a genuinely race-related mention that happens to use the word "white" — the opposite of narrow scoping, on exactly the words most likely to matter.

**Verdict: Part 1 (grouped review) — CLEAR ✅, build as scoped, no detection changes, no Fair Housing objection.** **Part 2 (exclusions) — BLOCKED**, pending a real fix: exclusions need to match against the actual confirmed-false-positive phrase in context (e.g., "bradford white" as a unit, or the matched term plus a window of surrounding text) — not the bare dictionary word. Until that's redesigned, do not build exclusions for any single-word term (most of `race_color` and several other categories) that has no charged-vs-uncharged distinction separable from its surrounding words.

**Beyond the redesign, Part 2 is a real GOVERNANCE.md Rule 6 "Critical" change** (modifies compliance/guardrail logic) — Mason's and Asimov's review is necessary but explicitly NOT sufficient. Before any exclusion is ever live in production: (1) actual sign-off from a licensed CA attorney (Mason is a reviewer, not that attorney), (2) a 7-day shadow-mode period where exclusions are logged/proposed but don't yet actually suppress any flag, so their real effect is visible before it's trusted. Also required once redesigned: admin-only gating (confirmed, not left to default), exclusions auto-expire after 90 days requiring affirmative re-confirmation (not a passive periodic glance — this is active, ongoing suppression, treated with more rigor than the passive record-review case the original "quarterly spot-check" idea came from), and real measurement (route to Atlas) of how often Layer 2 actually catches what an excluded Layer 1 term would have — right now nobody knows if that backstop is doing real work or just assumed to be.

---

## Asimov's Review — A More Serious Gap Found, 2026-09-03

**Independently confirms Mason's phrase-granularity finding, and finds something worse: `scanText()` is used in a second place this spec never accounted for.** `router.js`'s `safeTicketTitle()` calls the *same* `scanText()` directly against raw AppFolio ticket titles/descriptions, on a route gated only by `requireMaintenanceHistoryAccess` — broader than the `PRIVACY_REVIEW_ROLES` gate the review queue itself uses, and with no acknowledgment gate. If Part 2 changes what `scanText()` returns globally, an exclusion added to quiet review-queue noise would **silently also weaken `safeTicketTitle()`'s redaction of raw ticket text shown to a wider audience** — a real, live gap, not hypothetical. **Hard requirement: any exclusion check must be scoped to the content-check pipeline (`checkClaim()`) specifically — `safeTicketTitle()` must keep using an exclusion-unaware scan, always.**

**A second, separate, serious mechanical bug found:** if Part 1's grouped view determines *queue membership* by live-recomputing the scan (rather than reading the already-persisted `flagged_protected_class` column), then once an exclusion exists, an already-flagged, still-unreviewed item whose only matched term gets excluded would **silently vanish from the queue with no human ever seeing it** — the exact failure this whole system exists to prevent. **Hard requirement: `flagged_protected_class` (persisted at ingest) is the only source of truth for whether an item is in the queue. The live re-scan may only ever compute a display/cluster label for an item already known to belong there — never decide inclusion.**

**Part 1 approved, with these conditions:** built as a mode on the existing gated route (not new); queue membership stays driven by the persisted flag per above; bulk actions get server-side re-validation of each id's current flagged/unreviewed status before acting (never trust the client's cluster snapshot); each bulk action writes one `audit_log` row *per item*, marked `bulk: true` with the cluster key and batch size (not one row per batch call — Rule 1 traceability); bulk actions return real per-id success/failure, not all-or-nothing; **Layer-2-only clusters (no shared matched term) get grouped for browsing but no one-click bulk action — individual review only**, since there's no real shared reason to batch them.

**Part 2, additional requirements beyond Mason's, before it's ever built:** the exclusion table is a **Neo-owned migration** (not in the original Open Items — fixed now), with RLS and a full Rule 4 data-inventory entry, since it will hold exactly the kind of `{phrase, category}` content `protected-class-terms.js`'s own header says must never live somewhere with broader-than-reviewer access. **Reading** the exclusion table needs its own gate at least as narrow as the write gate — the original spec only addressed who can *add* one. A quarterly Mason spot-check of the active exclusion list is required, not optional, consistent with Rule 6's Critical-tier treatment of compliance-logic changes.

**Combined verdict: Part 1 — build now, with the conditions above folded in. Part 2 — real redesign required (fix the phrase-granularity problem Mason found AND scope it away from `safeTicketTitle()` per this finding), route through Neo for the table, and the full Rule 6 path (attorney sign-off, 7-day shadow mode, quarterly Mason review) before anything is ever live.**

---

## Open Items — Needs Confirming Before This Gets Built

1. **Who can add an exclusion — `admin` only, or all three `PRIVACY_REVIEW_ROLES`?** Recommendation above is `admin`-only; confirm before Q builds the gate.
2. **Layer 2-only flags (no matched keyword) — grouped by category alone, or left ungrouped since there's no reliable cluster key?** This spec defaults to grouping by category for these, but a "23 items, all flagged as disability_health by the AI, no common phrase" cluster is a much weaker grouping than a real matched-term cluster — worth deciding if that's still useful enough to show as one cluster, or if Layer 2-only flags should just stay in the flat, individual list.
3. **Should an exclusion have any expiration or periodic re-confirmation** (e.g., Mason's own earlier suggestion of a quarterly spot-check on reviewed history), or does `active`/deactivatable-anytime cover it well enough?
4. **This needs Asimov's and Mason's actual review before any code gets written** — not scheduled yet, pending Peter's go-ahead to kick that off.
