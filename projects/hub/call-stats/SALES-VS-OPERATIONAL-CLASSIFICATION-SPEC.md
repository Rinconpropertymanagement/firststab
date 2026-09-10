# Call Stats — Sales vs. Operational Call Classification Spec

**Status:** Draft — spec only. No code written, no migration written. Awaiting Peter's approval, and gated on a measurement step (Design Decision 25) that must run before Neo or Q touch anything.
**Written by:** Oracle
**Date:** 2026-09-10
**Origin:** Peter approved this direction on 2026-09-10 — classify Rincon's Aircall calls as SALES or OPERATIONAL by matching the caller's phone number against HubSpot, so the "operational calls" and "outbound sales calls" lines on his weekly scorecard stop being counted by hand.

**Built from:**
- `projects/hub/call-stats/SPEC.md` in full — especially Design Decision 2 (grain), Design Decision 5 (governance), Design Decision 8 (per-line outbound investigated and dropped), and the "Explicitly Out of Scope" ring-fence around call content
- `projects/hub/call-stats/answer-rate-redefinition-SPEC.md` — Design Decision 10 (sync-time vs. query-time lookup), **Design Decision 11 (snapshot, never recompute — the reasoning this document leans on hardest)**, Design Decision 12 (columns on an existing table vs. a new one), Design Decision 13 (backfill gate), Design Decision 14 ("measure it first")
- `projects/hub/call-stats/TREND-VIEW-SPEC.md` — Design Decision 10 (why the governance answer was re-derived rather than asserted), Design Decision 4 (why a config table with an editing screen is a real cost, not a free choice)
- `projects/hub/call-stats/lib/hubspot-connector.js` — its CRITICAL header (one module, fixed request shapes, no generic `request(method, path)`) and its LIVE VERIFICATION block (the `crm.objects.contacts.read` scope finding, and the two items it left open)
- `projects/hub/call-stats/lib/aircall-connector.js` — same CRITICAL header discipline, and LIVE VERIFICATION #3 on `call.user`
- `projects/hub/call-stats/lib/sync.js` and `projects/hub/call-stats/router.js` — the existing two-pass aggregation and the sync route's fail-loud/failure-isolation pattern
- `supabase/migrations/20260819010000_call_stats.sql`, `20260904000000_call_stats_line_misses.sql`, `20260908000000_call_stats_hubspot_native.sql`, `20260910010000_add_sole_user_attribution_to_call_stats_line_misses.sql` — grains, UNIQUE constraints, and all four Data Inventory blocks
- `CLAUDE.md`'s compliance-build definition and `GOVERNANCE.md` in full (Rules 1–10, the Fair Housing Standard, and the preamble's "when in doubt, treat it as in-scope and let Asimov decide")

**Where this lives:** entirely inside `projects/hub/call-stats/`. No new Hub section, no new tile, no new permission surface — the same `team_member_tool_roles` gate on `tool='call_stats'` that already governs this page.

---

## What This Does

Peter keeps a weekly scorecard by hand. Two of the lines on it are "number of operational calls" and "number of outbound sales calls," and today somebody counts those by remembering who they talked to. This adds two more columns to the Call Stats page that count them automatically.

The way it tells the difference is deliberately narrow: when a call comes in or goes out, it takes the other person's phone number and asks HubSpot one question — *has anyone at Rincon ever treated this number as a sales prospect?* Not "does this number exist in HubSpot" (almost every number does, for reasons explained below), but specifically: has a human put this person at a prospect stage, or attached a deal to them. If yes, the call is a sales call. If no, it is not counted as a sales call — and it is **not** silently relabelled "operational" either, because that would be claiming something nobody verified.

It never reads, fetches, or stores anything anyone said on a call. It reads a phone number and a lifecycle stage, and nothing else.

## How It Works

1. **The existing nightly sync already fetches the previous Pacific day's Aircall calls.** No second fetch is added. This work runs over the same `calls` array `buildDailyAggregates()` and `buildLineMissAggregates()` already share.
2. **Every call's *other party* number is normalized** into one canonical form — Rincon's own 15 Aircall lines are removed from that set, because a call to or from Rincon's own number is not a call with an outside person.
3. **The night's distinct outside numbers — a few dozen, not a few hundred — are looked up in HubSpot in one or two batched read requests**, asking only for contacts whose lifecycle stage or attached deals mark them as a real prospect.
4. **Each call gets one of three labels**, decided in memory and never stored against the person who was called:
   - **Sales** — the number matched a contact carrying real prospect evidence.
   - **Not matched** — the number was looked up and nothing qualifying came back.
   - **Unknown** — the number could not be read or could not be looked up (withheld caller ID, an unparseable number, a lookup that failed). This is never quietly merged into either of the other two.
5. **Only the three counts are written to the database.** The outside person's phone number, name, and HubSpot record ID are all discarded the moment the count is incremented. Nothing about any prospect is stored (Design Decision 23 — this is the load-bearing choice for the governance answer, not an afterthought).
6. **The label is frozen on the night it is computed and never recalculated.** A prospect who signs a contract in November does not retroactively turn September's sales calls into operational ones.

## What You'll See

- The two Aircall pod tables (Solimar / Faria) gain **three columns: Sales, Not matched, Unknown** — outbound-facing, since "outbound sales calls" is the scorecard line Peter is trying to automate, with the same three available for inbound.
- **No column is labelled "Operational."** The middle column says "Not matched." One line of text under the table explains what that means in one sentence: *these are calls to numbers HubSpot doesn't mark as a prospect — mostly tenants and vendors, but also any prospect nobody has advanced in HubSpot yet.*
- **A changeover date is visible.** Any date range that starts before the first night this ran shows a note saying calls before that date were not classified — rather than showing zeros that read as "no sales calls that week."
- Nothing else changes. The existing columns keep their existing meanings. No call list, no caller names, no numbers, no recordings, no transcripts.

## What Could Go Wrong

- **Rincon's own sales hygiene becomes the ceiling on this number, and there is no code fix for that.** If Kristen speaks to a genuine prospect and never advances them past HubSpot's default stage, this counts that call as "not matched." The tool will under-report sales calls, and it will under-report them silently. This is the dominant error mode once the design below is in place, and it is a people-and-process problem, not a bug. Design Decision 25 exists to measure how big it is *before* anything gets built.
- **Someone could later "improve" this by storing which HubSpot contact matched.** That single change would turn a build that stores no outside person's data into one that does, and would move it across `CLAUDE.md`'s compliance-build line. Design Decision 23 says why it must not happen, and the governance section names it as the thing Asimov should be asked to register.
- **A number that reaches two different people gets one answer.** A cell phone that is both a prospect's and a current tenant's — a landlord who is also a client, say — classifies as sales on every call, in both directions, forever. The rule is "any qualifying evidence wins" and it cannot tell those two conversations apart, because it never looks at the conversation.

---

## The Obstacle This Design Exists To Survive

Measured live against Rincon's real HubSpot on 2026-09-09:

| | Count |
|---|---|
| Contacts created since 2026-06-01 | 1,368 |
| Of those, Aircall integration exhaust | ~1,275 (**~93%**) |
| Auto-named "Aircall new contact" | 453 |
| Completely blank | ~822 |
| **Sitting at a real prospect lifecycle stage** | **93** |

The exhaust arrives in near-duplicate pairs about 1 second apart, and a texting conversation produces a *separate contact per direction* — verified on one number holding two records 0.8 seconds apart, one carrying the inbound text and one the outbound reply. It started 2026-06-02 at 15:27; only 10 comparable records existed across the preceding 21 months.

**Why this kills the obvious design.** Every unknown caller already has a HubSpot contact carrying their phone number, created automatically the first time they rang. A tenant calling about a leak has one. A vendor confirming a work order has one. So the rule "the caller matched a HubSpot contact" would classify essentially every call as sales, and the "operational calls" count would read approximately zero. Any design that does not survive this is wrong, and this one is built around it rather than waiting for it to be cleaned up.

---

## Design Decisions

*Numbering continues from `answer-rate-redefinition-SPEC.md`, which ended at 16.*

### 17. The rule is an allowlist of human-applied evidence, not "a contact exists"

**Decision: a call is SALES if the other party's number matches at least one HubSpot contact that satisfies either condition below.**

1. **Its lifecycle stage is on a configured prospect-stage allowlist**, or
2. **It has at least one associated deal in a configured pipeline allowlist.**

Nothing else qualifies. A contact's mere existence qualifies for nothing.

**What this does to the 93% junk, stated concretely rather than hoped at.** All ~1,275 exhaust contacts sit at lifecycle stage `2263812856` ("Contact") with no deals attached. `2263812856` is not on the allowlist and never will be. Therefore the exhaust matches nothing, and every tenant and vendor whose number the integration harvested classifies as **not matched** — which is the correct answer. The design is not merely tolerant of the pollution; it is indifferent to it, because the two signals it reads (**a lifecycle stage above the default**, and **an attached deal**) are things a *person* at Rincon sets, and the integration sets neither.

**That is the whole idea in one sentence: don't ask whether HubSpot knows this number, ask whether a human at Rincon ever did something deliberate with it.**

**The inversion this creates, named plainly.** Flipping the rule this way flips the error too. Before: everything looks like sales. After: a real prospect nobody advanced in HubSpot looks like not-sales. That second error is quieter and therefore more dangerous, and it is bounded entirely by how consistently Rincon's sales process is reflected in HubSpot. It is measurable — see Design Decision 25 — and it must be measured before this is built, not discovered afterwards from a number that looks too low to trust.

**Stage and pipeline lists are configuration, not code.** Real prospect stages observed in use: `2262522612` Cold Lead, `2263492322` Warm Lead, `2263949039` Hot Lead, `4033377998` Re-engaged Lead, `marketingqualifiedlead`, `opportunity`. **Which of these officially count is an open question awaiting Rincon's marketing manager** (Open Item 16), and 9 of the 21 lifecycle options in the portal are labelled "do not use." Likewise the four pipelines — Sales Pipeline (`default`), RentScale Sales Pipeline, House Hack Group, Smartlead Positive Replies — and which of those count is unresolved (Open Item 17). Neither list may be hardcoded inline at a call site.

**Where the configuration lives — and why not a config table.** One exported constant in one module (`lib/sales-classification-config.js`), carrying both lists, the stage precedence order from Design Decision 19, and a dated comment recording who answered and when. **A `call_stats_sales_criteria` config table was considered and is rejected for v1**, on the same reasoning `TREND-VIEW-SPEC.md` Design Decision 4 used against targets: a config table needs an editing screen, and an editing screen needs a decision about who is allowed to change what a company metric means. Nobody has asked to edit this. The marketing manager's answer arrives once. `GOVERNANCE.md` Rule 5's versioned-criteria requirement is aimed at criteria that decide something about a person's housing — this decides which column a call is counted in — so it is not triggered, though its spirit is honoured by the next paragraph.

**Changing either list later creates a definitional boundary in the data, exactly like the answer-rate changeover date.** Because classifications are snapshotted (Design Decision 22), a stage-list change does not rewrite history — it means dates before the change were classified under one definition and dates after under another. Any such change must be recorded with its date in that config file, and a range spanning it is mixing two definitions. This is the same hazard `answer-rate-redefinition-SPEC.md` Design Decision 13 insisted be made visible, and the same answer applies.

### 18. Phone number normalization — one canonical key, and an honest list of what fails

**Decision: reduce both sides to a canonical key before comparing. Never compare raw strings.**

**The key.** Strip every non-digit character. Then:
- **11 digits beginning with `1`** → drop the leading `1`, keep the remaining 10. This is the key.
- **10 digits** → this is the key.
- **Anything else** → no key. The call is **Unknown**, never "not matched."

For a non-`+1` international number, do **not** truncate to ten digits — keep the full E.164 string as the key and compare it only against other full E.164 strings. Truncating an international number into a ten-digit NANP-shaped key is how two unrelated people collide.

**Aircall's side.** Aircall supplies the outside party's number as `raw_digits`, formatted for humans (`+1 805-288-1119`), alongside an E.164 form (`+18052881119`). The normalizer above handles either. **Two cautions for Q, and the second one is a real trap:**

- **Nothing in this codebase reads `raw_digits` today.** `lib/sync.js` reads `call.number.digits`, which is *Rincon's own line*, not the caller. The presence, spelling, and population rate of the outside-party field must be verified field-for-field against a real `GET /v1/calls` payload before any code is written — the same discipline that caught `SPEC.md`'s "confirmed" claim about `call.duration` being live-verified wrong (`aircall-connector.js` LIVE VERIFICATION #4). Open Item 18.
- **`call.number.digits` and the outside-party number must never be confused.** Feeding the wrong one in produces a classifier that looks up Rincon's own phone numbers all night.

**HubSpot's side.** Phone fields there are user-entered and inconsistent — `(805) 288-1119`, `805.288.1119`, `8052881119`, `+1 805 288 1119 x204` are all real shapes. Read **both `phone` and `mobilephone`**; a number entered in only one of them is otherwise invisible. HubSpot also maintains calculated searchable phone properties that do their own normalization, which would be preferable if available — whether they are exposed to this portal under `crm.objects.contacts.read` is unverified (Open Item 19). Until that is answered, assume they are not and normalize on Rincon's side.

**What fails, listed rather than hand-waved:**

| Case | Result | Note |
|---|---|---|
| Withheld / anonymous caller ID | **Unknown** | Aircall may return an empty or non-numeric value |
| Extension suffix (`x204`) in HubSpot | Matched on the base 10 digits | Two HubSpot contacts on the same base number collapse to one key — acceptable, because the question is "does *any* qualifying contact hold this number," not "which one" |
| Non-`+1` international | Full-E.164 key, compared only to full-E.164 | Rare in a SoCal portfolio, but must not silently collide |
| Malformed / short-code / 7-digit fragment | **Unknown** | Never guessed at, never area-code-completed |
| A HubSpot contact with no phone at all | Invisible to this rule | Cannot be helped; it is not a failure of matching |

**Rincon's own numbers are excluded from matching entirely, before any lookup happens.** The exclusion set is the 15 Aircall lines plus every row in `call_stats_hubspot_native_numbers`. This is not tidiness — the Aircall exhaust could plausibly have created a HubSpot contact holding one of Rincon's own numbers, and if that contact ever got advanced to a prospect stage by hand, every internal call would classify as sales. Excluding by construction removes the possibility rather than trusting it never happened.

### 19. Duplicate contacts: the rule is set-wide, so precedence is a reporting question, not a correctness one

A number will routinely match several HubSpot records — the exhaust creates them in pairs, and separately per text direction. Those records can carry conflicting lifecycle stages.

**Decision: the classification is evaluated over the whole matched set, not over one chosen record.** *Does **any** contact matching this key carry qualifying evidence?* Because "any" is order-independent, there is no tie to break and no non-determinism to design around. A number with one Hot Lead record and eleven exhaust records is a sales number. A number with twelve exhaust records and nothing else is not.

**Precedence still gets defined, for one narrow purpose: naming which record justified the answer during troubleshooting.** It never changes the answer.

1. Highest-ranked lifecycle stage per the configured **ordered** list (`opportunity` > `marketingqualifiedlead` > Hot > Warm > Re-engaged > Cold — the order itself lives in the config module, since the marketing manager may rank them differently).
2. Tie → the contact carrying an associated deal in an allowlisted pipeline.
3. Tie → **earliest `createdate`.**
4. Tie → lowest numeric `hs_object_id`.

**Why earliest-created and not most-recently-modified**, which is the more usual choice: the exhaust integration keeps touching records, so `hs_lastmodifieddate` moves on its own and would make the cited record change between two runs that produced the identical classification. Earliest-created is stable. Step 4 exists so the cascade has an absolute floor and can never depend on the order HubSpot happened to return results in.

**Nothing from this cascade is persisted** — see Design Decision 23. It exists so that a diagnostic run can answer "why did this call classify as sales," at the operator's terminal, on demand.

### 20. The lookup happens at sync time, in batches, and the volume is much smaller than it looks

**Decision: sync time. Not query time.** This follows `answer-rate-redefinition-SPEC.md` Design Decision 10's table directly, and the reasoning transfers without modification:

| | Sync time (chosen) | Query time (rejected) |
|---|---|---|
| HubSpot requests | ~1–3 per night | ~1–3 per dashboard load, repeatedly during a weekly meeting |
| Dashboard availability | Unaffected — the page stays a pure Supabase read | Fails when HubSpot is down or rate-limited |
| Historical stability | Can be frozen (Design Decision 22) | Impossible — always reflects today's HubSpot |

The decisive one is the third. A query-time lookup can only ever apply *today's* HubSpot to every day in the range, which makes Design Decision 22 unachievable. The availability argument alone would also be sufficient: the two connectors' headers both record unverified rate-limit behavior (`hubspot-connector.js` LIVE VERIFICATION #4 — its 429 guard "has still never actually fired against a real HubSpot response"), and coupling a dashboard that currently has no external dependency at page load to an endpoint whose throttling is unmeasured is not a trade worth making for a number that changes once a night.

**Volume, since this is the usual objection.** ~2,700 calls in 30 days is ~90 calls a night, and distinct outside numbers are meaningfully fewer — a repeat caller, a callback, and a text thread are one number. Batched with an `IN` filter against a day's distinct set, that is **one to three HubSpot requests per night, not ninety.** The existing connector already uses exactly this shape: `buildTrackedNumberFilterGroups()` passes an `IN` with a `values` array. HubSpot's real limit on `IN` list length for this endpoint is unverified (Open Item 20) — Q must chunk conservatively and confirm, rather than discovering the cap on a busy night.

**A number-level cache table was considered and is rejected for v1.** A day's distinct-number set is small enough that a cache saves one or two requests, and the classification is already snapshotted onto the aggregate rows, so a cache would be a second place for the same fact to live and drift. That is exactly the ahead-of-need structure `PROPERTY-BRAIN-ARCHITECTURE.md` §1.5 and both existing migrations' headers refuse.

**Where the code goes.** One new, narrowly-named function in `lib/hubspot-connector.js` — `searchProspectContactsByPhone()` or similar — built the same way `searchVoipCallsPage()` is: one fixed request shape against one fixed endpoint (`/crm/v3/objects/contacts/search`), GET-only in effect, no HTTP method or endpoint passable from outside the file. That file's CRITICAL header is explicit about this and Q does not relax it here.

**A pleasing fact worth recording: no credential change is needed, and the existing scope finally gets used for what it is named.** `HUBSPOT_PRIVATE_APP_TOKEN` already carries `crm.objects.contacts.read` — granted because `crm.objects.calls.read` is not selectable in this portal (`hubspot-connector.js` LIVE VERIFICATION #1). Reading contacts is precisely what that scope is for. No new key, no new external surface, no new `.env` entry.

**Failure handling — fail loud, never write a guess.** If the HubSpot lookup fails for any reason, the classification columns for that night are **left NULL and the day stays re-runnable**. They are not written as zeros, and unclassified calls are not swept into "not matched." This is the same principle `answer-rate-redefinition-SPEC.md` Design Decision 10 established for `sole_user_email` and for the same reason: a stored value that means "we could not find out" while looking exactly like "we looked and found nothing" is a permanent, silent, self-concealing error. Isolation follows the existing route's pattern exactly — the `call_stats` upserts and the line-miss half have already run and are untouched.

### 21. Storage: three counter columns on `call_stats`, and a CHECK constraint that refuses to lose a call

Three shapes were weighed against this project's standing rule about not inventing structure ahead of proven need.

- **Widen `call_stats`'s grain to `(user, date, direction, classification)` — rejected.** It changes the UNIQUE constraint, the upsert path, and requires a full re-sync from Aircall to backfill, and Design Decision 22 says that backfill cannot be done honestly anyway. `SPEC.md` Design Decision 8 already priced this exact class of change ("a schema change **plus** a full re-sync backfill") when it dropped per-line outbound.
- **A sibling `call_stats_classification` table at the wider grain — rejected.** It reproduces the person/day/direction key in a second place, requires a join on every read, and, decisively, allows the two tables to disagree with nothing detecting it.
- **Three nullable counter columns on `call_stats` — chosen.** The existing grain is already correct: "how many of this person's outbound calls yesterday were sales" is an attribute of the row that already exists, not a new dimension. **The `UNIQUE (aircall_user_id, call_date, direction)` constraint and the upsert path are unchanged.** This is the direct analogue of `answer-rate-redefinition-SPEC.md` Design Decision 12, which chose columns over a table on the same test.

**Proposed columns (Neo finalizes):**

```
call_stats
  ... existing columns unchanged ...

  sales_calls        INTEGER NULL   -- matched a qualifying HubSpot contact
                                     -- (Design Decision 17)
  unmatched_calls    INTEGER NULL   -- looked up, nothing qualifying returned.
                                     -- NOT "operational" — see Design
                                     -- Decision 24 on why the column is not
                                     -- named that
  unknown_calls      INTEGER NULL   -- no usable number, or the lookup could
                                     -- not be performed. NEVER folded into
                                     -- either column above
```

**The constraint that makes this shape worth choosing.** All three are NULL together (unclassified — every row before the changeover date, and any night the lookup failed), or all three are populated **and sum exactly to `total_calls`**. Expressed for Neo to write properly, roughly: `CHECK ((sales_calls IS NULL AND unmatched_calls IS NULL AND unknown_calls IS NULL) OR (sales_calls + unmatched_calls + unknown_calls = total_calls))`.

That constraint is the reason this shape beats the sibling table. **The database itself refuses to store a day in which a call went uncounted.** A normalization bug that starts dropping numbers cannot produce a plausible-looking row — it produces a rejected write and a loud failure. Given that the failure mode this whole design is guarding against is a number that is quietly wrong, a schema that cannot represent a quietly-wrong number is worth the constraint's small cost.

**`call_stats_line_misses` is not touched, and that is a real v1 gap, deliberately taken.** Those are inbound calls Aircall attributed to no individual — including everything on the Leasing Line and the Maintenance Hotline. A prospect who rang the Leasing Line and got nobody is a **missed sales call**, arguably the most commercially interesting number in this entire tool, and v1 will not count it. Two reasons, and the second is not a cost argument: Peter asked for operational-call and outbound-sales-call counts, neither of which needs it; and classifying Leasing Line callers means attaching a derived label to **prospective tenants**, which is a different governance question with a different answer (see Governance below). Named as a gap so it is a decision, not an oversight.

**Coordination with the parallel missed-call-reason migration.** A separate migration recording missed-call reasons is being written at the same time and is expected to add columns to `call_stats_line_misses`. This spec's migration touches **`call_stats` only** and therefore cannot collide with it. Neo should still take a distinct timestamp after `20260910010000` and confirm before applying that the two migrations do not both attempt to alter the same table — but as specified, they are on different tables and there is nothing to reconcile.

### 22. Classification is snapshotted at sync time and never recomputed

**Decision: the label a call gets on the night it syncs is the label it keeps.** This is `answer-rate-redefinition-SPEC.md` Design Decision 11's reasoning applied to a case it fits even more tightly than the one it was written for.

**The problem, concretely.** A prospect Kristen called in September signs in October and moves to operations. If classification were recomputed from today's HubSpot, that September call would stop being a sales call — and Peter's September scorecard number would change, months later, because of an unrelated CRM update, with no event in this system recording that it moved. Worse: **success in sales would systematically erase the record of the sales work that produced it.** Every prospect who converts subtracts from the historical sales-call count. The metric would degrade precisely in proportion to how well the sales team performed.

That is not a rounding error. It is a metric that punishes the outcome it exists to measure.

**What breaks under the choice made, stated plainly, as Design Decision 11 required of itself:**

- **Snapshot (chosen).** History is stable; a HubSpot change affects only nights after it. *What breaks:* if a contact was mis-staged in HubSpot for a stretch, the error is frozen and correctable only by deliberately re-running those days — and **re-running an old day re-reads today's HubSpot**, so the `?date=` escape hatch already documented in `router.js` becomes a second sharp tool of the same kind. It must be documented at the route alongside the line-membership hazard already recorded there, not left as a surprise. Acceptable for the same reason: an explicit, rare operator action rather than something that happens on its own.
- **Recompute at query time (rejected).** Nothing to store, no migration. *What breaks:* the erasure described above, silently, forever.
- **Versioned contact-stage history (rejected outright).** It would mean storing the HubSpot stage history of outside individuals in Rincon's database — the one thing Design Decision 23 exists to avoid. It is not merely more work; it is the wrong direction entirely.

**No backfill.** Existing `call_stats` rows keep all three columns NULL. Classifying the past would mean applying today's HubSpot to calls made weeks ago — the exact rewrite this decision prevents — and unlike `answer-rate-redefinition-SPEC.md` Design Decision 13's line-membership case, there is no "did anything change in the window" question Peter could answer to make it safe. HubSpot changed constantly across that window; that is what a CRM does. **The metric starts fresh from the first night this runs, and the dashboard says so.**

### 23. Nothing about any outside person is stored — and this is a design requirement, not a side effect

**Decision: the counterparty's phone number, name, and HubSpot contact ID exist only in memory during the sync pass. Only the three integer counters are written.**

This is the same move `appfolio_property_actuals` made when it aggregated away `party_name` and `party_id` — and it is available here in a way it explicitly was not available for `call_stats` itself, whose entire purpose was per-person attribution (`SPEC.md` Design Decision 3 was careful to say so rather than inherit the claim). Here, no purpose requires keeping the number. A count of sales calls is a count.

**The consequence is the whole governance answer.** Because nothing identifying an outside individual enters Supabase, this build does not trigger `CLAUDE.md`'s "stores someone's personal information" clause with respect to prospects. That claim is honest and checkable — and it is a **property of the code, not a policy**, which means an ordinary-looking future change can break it without anyone noticing. A single `matched_contact_id` column added for debugging would move this build across the compliance line. That is precisely why the governance section below recommends registering the boundary with Asimov rather than simply asserting it here.

**The cost, named rather than glossed:** there is no stored trail of *which* contact justified any classification, so a disputed number cannot be traced after the fact from the database. The mitigation is a separate, manually-run diagnostic script that prints the Design Decision 19 cascade to the operator's terminal on demand and persists nothing. **Routine sync logging records counts only** — not the numbers looked up, not the contacts matched. Logging the numbers would quietly reintroduce, in the log files, exactly the data this decision keeps out of the tables.

**And the reason this is even possible: no call content is involved at all.** Peter asked on 2026-09-10 whether voicemail transcripts could do this job instead. They cannot — Aircall's transcription, summary and sentiment endpoints all return 403 on this account (no AI add-on) — and `SPEC.md`'s "Explicitly Out of Scope" section permanently ring-fences call content from this tool pending separate Mason and Asimov review. **Number matching was chosen specifically because it needs no call content whatsoever, and that is a design virtue, not a consolation prize.** A transcript-based classifier would have needed to read what a prospect said to a staff member and store a judgment derived from it. This one reads ten digits and a lifecycle stage. There is no code path here that could later be pointed at call content, and none should be added.

### 24. The residual is called "Not matched," and never "Operational"

**Decision: the column that Peter will read as his operational-call count is not labelled "Operational."**

The tool has evidence for exactly one of the three buckets. "Sales" is a positive finding: a human at Rincon marked this number as a prospect. "Not matched" is the absence of a finding, and it contains at least three different things — genuine tenant and vendor calls, prospects nobody advanced in HubSpot, and personal or wrong-number calls. Labelling that "Operational" would assert a fact about all three.

This is the same standard `answer-rate-redefinition-SPEC.md` applied to itself when it chose four weeks of honestly-missing data over four weeks of flattering data, and the same standard that made NULL mean "no sole user" and never "we could not find out."

**Unknown is always on screen, never suppressed.** It gets its own visible column even when it reads zero, so that the day it stops reading zero — a normalization regression, a HubSpot outage, a run of withheld caller IDs — is visible on the page rather than only in a log nobody opens. A single portfolio-level health figure alongside it (*"97% of calls had a usable number"*) makes a slow degradation obvious; a per-person count would not, because the failure is not per-person.

**For Peter's scorecard, in one sentence that belongs on the page:** *Sales is a floor, not a total — it counts calls HubSpot can prove were with a prospect, and it will miss any prospect nobody has entered there.*

### 25. Measure before building — this is a gate, not a suggestion

**Decision: before Neo writes a migration or Q writes a column, run the classification rule read-only over the last 30 days of Aircall calls already in hand, and compare the result to the sales-call number Peter has been counting by hand.**

This is `answer-rate-redefinition-SPEC.md` Design Decision 14's "measure it first" applied to the one assumption this entire build rests on: that Rincon's HubSpot hygiene is good enough for the rule in Design Decision 17 to find real sales calls. Only 93 contacts in the portal sit at a prospect stage. If the true weekly sales-call volume is well above what those 93 contacts can account for, this tool would report a number that is not merely imprecise but useless — and it would report it confidently.

**What Phase 0 is.** A throwaway script. Read-only against both APIs. No migration, no column, no dashboard change, no write of any kind. It fetches ~30 days of Aircall calls, normalizes the outside numbers, batches them to HubSpot under the candidate stage and pipeline lists, and prints a handful of totals to the operator's terminal. It stores nothing and is deleted or left unwired afterwards.

**What it must report:**

1. Distinct outside numbers seen, and how many produced a usable key (the **Unknown** rate — if this is high, Design Decision 18 is wrong somewhere).
2. Calls classified sales / not matched / unknown, split by direction, for the whole window and per week.
3. **The check that matters most: do any of the ~1,275 exhaust contacts carry a lifecycle stage other than `2263812856`, or any associated deal?** If the integration — or a HubSpot workflow — advances contacts on its own, Design Decision 17's entire premise collapses and this build must not proceed as designed. This is Open Item 15 and it is the highest-risk unknown in this document.
4. The overlap between the 93 prospect-stage contacts and the four pipelines' deals, which is what actually answers Open Item 17.

**The gate.** If the outbound sales-call count lands in the same neighbourhood as Peter's hand-kept scorecard number, build it. If it comes back at 4 when Peter counted 60, **do not build it** — report the finding, and the real conversation is about how prospects get entered into HubSpot, which is a business-process discussion and not a Q session. Phase 0 costs a few hours. Building first and discovering this afterwards costs a migration, a backfill decision, a dashboard change, and Peter's confidence in a number he has to read out in a meeting.

---

## Governance — Assessed, Not Inherited

`SPEC.md` Design Decision 5, `20260908000000_call_stats_hubspot_native.sql`'s header, `answer-rate-redefinition-SPEC.md`, and `TREND-VIEW-SPEC.md` Design Decision 10 all concluded Call Stats is not a compliance build. **That conclusion is not inherited here.** Every one of those pieces reasoned about *employee* data only. This piece reads records about **outside individuals** and attaches a label derived from them to a staff performance number. That is different in kind and gets its own check.

**Against `CLAUDE.md`'s three triggers:**

**1. Sends messages to tenants or owners — No.** Nothing is sent to anyone. Read-only against both APIs, in both directions, permanently.

**2. Makes or influences a decision about an applicant or tenant — No, and the boundary is worth stating precisely.** The prospects in Rincon's HubSpot are **prospective property-management clients — property owners** — not rental applicants and not tenants. No unit is allocated, no application is screened, no approve/deny/conditional decision is made or influenced. The Fair Housing Standard's subject matter is not engaged at any point.

> **The tripwire, and it is real.** The Leasing Line handles **prospective tenants.** Its calls land in `call_stats_line_misses`, which Design Decision 21 deliberately leaves unclassified in v1. Extending classification to line misses would mean attaching a derived, CRM-sourced label to rental applicants — which lands squarely inside Mason's lane and would require his review before it ships. **Do not treat the "no Mason needed" answer below as covering that extension.** It does not.

**3. Stores someone's personal information — No, by construction, and the construction is the point.** Design Decision 23 keeps every outside person's number, name, and contact ID out of the database entirely; only three integers per existing row are written. This is the same claim `appfolio_property_actuals` made and that `call_stats` honestly refused to make about itself. Here it holds — but it holds because of a specific design choice that a routine future edit could undo without anyone reading this document.

### Recommendation

**Asimov: yes — a short, scoped pre-check before this ships. Not the full 18-step pipeline.**

This is not consistency-for-its-own-sake with the earlier "no Asimov" conclusions, and it is not inflation. Three specific reasons:

1. **This is the first Call Stats build to read records about people outside Rincon.** That is a genuinely new category for this tool, and the earlier analyses did not consider it because it did not exist.
2. **`CLAUDE.md` says so directly:** *"If you're unsure whether something is a compliance build, treat it as one and ask Asimov."* `GOVERNANCE.md`'s own preamble says the same. I am genuinely at the boundary here, and the instruction for that situation is unambiguous.
3. **The thing worth Asimov's time is one durable question, not a review of the feature.** *Is the "no outside-person data is stored" property real, and what keeps it real?* A boundary that lives only in a design document is one plausible debugging change away from being gone. Registering it — as a standing constraint on this tool rather than a one-time finding — is exactly the kind of thing Asimov is for, and it takes a fraction of a session.

**Mason: no for v1 as scoped — with the Leasing Line tripwire above as a hard condition.** No housing decision, no applicant, no tenant, nothing tenant-facing, no generated communication. If line-miss classification is ever added, Mason reviews it first.

**Sentinel: no.** No new credential, no new `.env` entry, no new external surface. The same `HUBSPOT_PRIVATE_APP_TOKEN` under the same already-granted `crm.objects.contacts.read` scope — used, for the first time, for the thing it is actually named after. `SPEC.md` Open Item 4's standing question about the Aircall credential's lack of a read-only scope is unaffected and remains open independently.

**`GOVERNANCE.md` Rule 4 applies, and produces a small amendment rather than a new inventory.** Three integer columns are added to a table whose inventory already describes it honestly. The amendment: `pii_fields` gains nothing — no new identifier and no new indirect identifier is stored. `privacy_category` stays employee call-activity / performance metadata; the counters are facts about a Rincon employee's day, not about any prospect. `retention_policy`, `ccpa_exportable`, `ccpa_deletable`, RLS posture and audit-logging posture are all unchanged. **The one genuinely new sentence the migration header must carry** is a statement of the Design Decision 23 boundary — that the classification is computed from outside individuals' records that this schema deliberately does not retain, and that adding a column to retain them changes this table's compliance status. Written into the header so the next person to open the migration reads it there, not only here.

**Rule 6 (Change Management):** Standard tier — a metric definition, not decision criteria, not compliance logic, not a permission tier. Peter's approval satisfies it.

**Rules 1, 2, 3, 5, 7, 8, 9, 10:** not engaged. No agent decision, no screening, no SMS, no housing criteria, no runtime agent lifecycle, no permission tiers, no protected-class data anywhere in the design, no contact records stored for a CCPA cascade to reach.

---

## Who Builds What

- **Phase 0 — Q, ~half a session, and nothing else starts until it reports.** The throwaway read-only measurement script of Design Decision 25. No migration, no columns, no dashboard change, no writes. Its output is a handful of numbers and a go/no-go.
- **Neo — ~1 session, blocked on Phase 0 and on Open Items 15, 16 and 18.** One additive migration on `call_stats`: three nullable integer columns, the all-NULL-or-summing CHECK constraint of Design Decision 21, and the Data Inventory amendment plus the Design Decision 23 boundary statement in the header. No grain change, no UNIQUE change, no change to any other table.
- **Q — ~1–1.5 sessions.** One new narrowly-named read function in `lib/hubspot-connector.js` following that file's CRITICAL header rule; the normalizer and the exclusion set (Design Decision 18); the classification pass in `lib/sync.js` over the existing `calls` array; the config module of Design Decision 17; wiring into the sync route with the fail-loud-and-leave-NULL path; the three counters surfaced from `GET /api/call-stats/stats`; the `?date=` re-run hazard documented at the route; and the standalone diagnostic script of Design Decision 23.
- **Tron — ~half a session.** Three columns on the two existing pod tables, the changeover-date note, the "Sales is a floor, not a total" line, and the portfolio-level usable-number health figure. Two standing traps on this page: wire every control with `addEventListener` and never inline `onclick` (the Hub's CSP sets `script-src-attr 'none'` and kills inline handlers silently), and the tables are already near the page's 1000px width, so three more columns need the horizontal-scroll treatment `TREND-VIEW-SPEC.md` Design Decision 1 specified for its grid.
- **TARS — mandatory, and specific.** Not "does the page load." (a) The three columns sum to `total_calls` for **every** row in the range — and confirm the CHECK constraint actually rejects a deliberately unbalanced write. (b) A known tenant's number and a known vendor's number both classify as **not matched**, proving the 93% exhaust is being excluded as designed. (c) A known real prospect's number classifies as **sales**. (d) A day whose HubSpot lookup is forced to fail writes **NULL, not zeros**, and re-running that day fills it in. (e) Rows predating the changeover show as unclassified and never as zero. (f) A withheld-caller-ID call lands in **Unknown** and not in "not matched."
- **Asimov — the scoped pre-check above, before this ships.**
- **Judge — sign-off before this is called done**, per the pipeline.

---

## Open Items — Needs Answering Before This Gets Built

*Numbering continues from `answer-rate-redefinition-SPEC.md`, which ended at 14.*

15. **Do any of the ~1,275 Aircall-exhaust contacts carry a lifecycle stage other than `2263812856`, or any associated deal?** If the integration or a HubSpot workflow ever advances a contact on its own, Design Decision 17's premise collapses and this design must not ship. **Highest-risk unknown in this document.** Answered by Phase 0.
16. **Which lifecycle stages officially count as a prospect?** Awaiting Rincon's marketing manager. Observed in use: Cold Lead, Warm Lead, Hot Lead, Re-engaged Lead, `marketingqualifiedlead`, `opportunity` — and 9 of the 21 options are labelled "do not use." Design Decision 17 makes the list configurable precisely so this can be answered late, but it must be answered before the first real night.
17. **Which of the four pipelines count?** Sales Pipeline (`default`), RentScale Sales Pipeline, House Hack Group, Smartlead Positive Replies. Unresolved. Phase 0's deal-overlap figure informs it; the decision is Rincon's.
18. **Verify the outside-party number field on a real Aircall call payload** — presence, exact spelling, format, and how often it is populated or withheld. Nothing in this codebase reads it today. Decides whether Design Decision 18's normalizer is correct or is guessing. **Verify before Q writes the normalizer.**
19. **Does this HubSpot portal expose calculated searchable phone properties under `crm.objects.contacts.read`?** If yes, matching gets more reliable at no cost. If no, Rincon-side normalization stands as specified.
20. **HubSpot's real limit on `IN` list length for the contacts search endpoint**, and its real rate-limit behavior — the latter is the same item `hubspot-connector.js`'s own header has had open since 2026-09-09 and has still never been exercised against a real 429.
21. **Should missed calls on the Leasing Line and Maintenance Hotline eventually be classified?** A missed prospect call is a lost deal and is commercially the most interesting number here. Deliberately out of v1 (Design Decision 21), and **gated on Mason** because those callers are prospective tenants. Peter's call whether to pursue it.

Carried forward and untouched by this document: `SPEC.md` Open Items 3, 4, 7 and 8; `answer-rate-redefinition-SPEC.md` Open Items 9–14.

---

## Rough Build Size

**Small — but with a real gate in front of it that is not optional.**

| | Effort |
|---|---|
| Phase 0 measurement (Q) | ~half a session — **blocks everything else** |
| Neo | ~1 session — one additive migration, three columns, one CHECK, inventory amendment |
| Q | ~1–1.5 sessions |
| Tron | ~half a session |
| TARS | ~half a session, dominated by the sum-equals-total and exhaust-excluded checks |
| Asimov | a scoped pre-check, well under a session |
| Mason / Sentinel | none for v1 as scoped |

No new credential, no new external service, no new Hub section, no new permission surface, no grain change, no backfill.

---

## Plain-English Summary for Peter

**What this would give you.** Two of the numbers you count by hand every week — operational calls and outbound sales calls — would land on the Call Stats page automatically, per person, for whatever dates you pick. The way it tells them apart is by looking at the other person's phone number and asking HubSpot one question: has anybody here ever marked this person as a prospect? If yes, it's a sales call. It never reads or stores anything anybody said on a call, and it never stores the prospect's phone number or name — just the counts.

**What it cannot do, and this is the important part.** Your HubSpot is full of junk. The Aircall connection has been automatically creating a contact for basically every number that rings you since early June — about 1,275 of them in three months, most of them blank or named "Aircall new contact." So "this caller is in HubSpot" tells you nothing at all; every tenant and every vendor is in there too.

I've designed around that rather than waiting for it to be cleaned up. Instead of asking "is this number in HubSpot," it asks "has a person at Rincon deliberately marked this number as a lead, or attached a deal to it?" The junk contacts have neither, because the integration doesn't set those — only a human does. **So the cleanup is not a blocker, and I'd ship this before it rather than after.** Cleaning up HubSpot would be good for a dozen other reasons, but it wouldn't change this number.

**Here's the catch, though, and it's the one thing I want to check before building anything.** Only 93 contacts in your whole HubSpot sit at a real prospect stage. If Kristen talks to a prospect and never moves them along in HubSpot, this tool counts that as *not* a sales call. So the number it gives you is a floor — a count of the sales calls HubSpot can prove — and if your team's HubSpot habits are loose, that floor could sit well below reality.

So I want to run the rule over the last 30 days of your actual calls first, before anybody builds anything, and show you the number it produces next to the number you counted by hand. That's a few hours of work, it writes nothing and changes nothing. If the two numbers are in the same neighbourhood, we build it. If it says 4 outbound sales calls and you counted 60, then the honest answer is that the problem isn't the software — it's that prospects aren't making it into HubSpot — and I'd rather tell you that for a few hours' work than after a week of building.

**Three things I need you to decide.**

1. **Which lead stages count as a prospect?** You've got Cold Lead, Warm Lead, Hot Lead, Re-engaged Lead, Marketing Qualified and Opportunity actually in use — plus nine more options in there labelled "do not use." I've built it so this list is easy to change, but somebody has to say which ones count. I think that's your marketing manager's call.
2. **Which of your four sales pipelines count?** There are four — Sales Pipeline, RentScale, House Hack Group, and Smartlead Positive Replies. Same question, same reason.
3. **Missed calls on the Leasing Line.** Right now this only classifies calls that got connected to a person. Calls that rang the Leasing Line and nobody picked up aren't included — and if one of those was a prospect, that's a lost deal you'd probably want to know about. I've left it out of the first version on purpose, because those callers are people looking to rent, and putting a label on people looking to rent is the kind of thing that needs a Fair Housing look first. Worth doing later, and I'd want Mason to look at it when we do.

**Two things I'll flag rather than bury.** The column that you'd read as "operational calls" is going to be labelled **"Not matched,"** not "Operational." That's deliberate. The tool genuinely knows when something *is* a sales call; it doesn't actually know that everything else is operational — that bucket also contains any prospect nobody entered in HubSpot. I'd rather the label be honest on a page you read out in a meeting.

And the label a call gets is frozen on the night it's counted. If a prospect signs in October, the calls you made to them in September stay counted as sales calls. That matters more than it sounds like: if it recalculated, then every prospect who converts would quietly subtract from your historical sales-call count, and your numbers would look worst in the months your team did best.

**One more thing, since you asked about it.** You asked whether voicemail transcripts could do this job instead. They can't — Aircall's transcription features return an error on your account, you don't have that add-on. That turned out to be a good thing. Phone-number matching doesn't need to read a single word anybody said, which keeps this well clear of the whole recordings-and-transcripts question we deliberately walled off when we started this tool.

**How big.** Small. Half a day for the check-first step, then roughly a day of database work, a day and a half of building, half a day of front-end, and half a day of testing. No new logins, no new services, nothing new connected. It does need one short governance check from Asimov before it ships — not because it's risky, but because this is the first piece of Call Stats that reads records about people outside the company, and the reason it stays simple is a specific design choice I want written down somewhere it won't get accidentally undone later.
