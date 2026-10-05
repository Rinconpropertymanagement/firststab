# Bulk Photo Diffing — Security Deposit Build Spec Addendum

**Status:** Legal and governance groundwork complete — attorney-cleared to proceed with speccing and building. **Not yet approved to build.** That's a separate, later decision: Peter gives Neo/Q the explicit go-ahead when he's ready, distinct from today's legal clearance. This document is written so that go-ahead is the only thing standing between this spec and Q starting work.

**Written by:** Oracle
**Date:** 2026-08-20
**Governance history:** Reviewed by Asimov (FLAGGED-WITH-CONDITIONS, plus a sequencing recommendation — see Governance Path below), Mason (FLAGGED, two-layer recommended design), and then Rincon's outside counsel directly (five numbered answers, dated today — see Governance Path). Peter made the final design call given counsel's answers. Full history recorded below, not summarized away — this went through real back-and-forth and the record should show that.

**Built from:**
- `projects/hub/security-deposit/SPEC.md` — the v1 base spec this extends.
- `projects/hub/security-deposit/targeted-photo-matching-SPEC.md` — the sibling "v1" addendum this one depends on directly. As of this writing that document's own header says "Approved — governance-cleared," but it may still be mid-revision by another Oracle pass — see Open Items #1. **This addendum does not re-spec any B2 infrastructure** — the read-only `readFiles`-scoped B2 credential, `lib/b2-client.js`'s `listFilesInFolder`/`downloadFileBytes` functions, and the photo-matching AI contract in `lib/photo-matcher.js` are all reused as-is from that addendum, not duplicated here.
- `projects/hub/security-deposit/router.js`, `lib/folder-parser.js`, `lib/b2-client.js`, `dashboard/index.html` — the live code this plugs into.
- `supabase/migrations/20260626000000_initial_schema.sql` (`maintenance_requests`) and `supabase/migrations/20260815010000_maintenance_history_schema.sql` (`maintenance_claims`, `protected-class-terms.js`'s category list) — checked directly for what accommodation-adjacent data already exists in this codebase (see Neo section #3 for what that search found).
- `GOVERNANCE.md` Rule 6 (Change Management) and Rule 9 (Never Use Protected Class Data in Decisions) — both directly load-bearing on this feature's design, in tension with each other in a way that's worth stating plainly (see Compliance Grounding).

**Where this lives:** Same tool, same folder — `projects/hub/security-deposit/`. New routes on the existing router, a new section on the existing case screen, one new library file, new database tables. Not a new tool, not a new login.

**Scope note, worth stating up front:** the targeted-matching addendum (v1) explicitly deferred this exact feature: *"bulk automated diffing — an AI reviewing every photo in a case and flagging pairs that look different, unprompted... blocked pending outside legal counsel's Fair Housing review."* That review has now happened (see Governance Path). This document is that promised follow-up, phase 2, built on top of phase 1's infrastructure.

---

## What This Does

Today, once a case's move-in and move-out photo folders are matched, a pod lead still has to look through both folders themselves to notice anything that changed. This feature has an AI do that first pass automatically: for every move-out photo in a matched, confirmed folder, it finds the corresponding move-in photo (the same matching capability the targeted-matching addendum already built, just run automatically across every photo instead of one a coordinator picked) and asks a second, narrower question — does anything about this spot look different between the two photos? The answer is strictly binary plus a confidence number: "these differ" (yes/no) and how sure the AI is. **Nothing else.** No description of what changed, no caption, no guess about whether it's damage, wear and tear, or something else entirely — that judgment stays entirely with the pod lead, exactly like every decision this tool has never made for anyone.

Two things keep this from becoming a Fair Housing problem before it ever reaches a pod lead:

1. **A change present in both the move-in and move-out photos was never installed during this tenancy, so it's never flagged.** This isn't a separate thing to build — it's just how comparing two photos works: diffing only catches what's different *between* them. It's stated here because it's part of why this design is acceptable, not because it needed engineering.
2. **Before a flagged pair reaches the pod lead, the system checks Rincon's own records for a known accommodation tied to that tenancy** (a formal accommodation-approval log, plus a keyword search of maintenance tickets — see Neo section #3 for exactly what's queried and what isn't built yet) **and suppresses the flag if one exists.** This is the safeguard that stops the tool from mechanically directing extra scrutiny toward tenants who exercised a legally protected right to modify their unit — see Compliance Grounding for the full reasoning and who signed off on it.

## How It Works

1. **Starting point: a case already has confirmed, matched move-in and move-out folders** — today's existing base-tool feature, unchanged by this addendum.
2. **Shortly after both folders are confirmed matched, the system works through the move-out folder automatically, in the background** — not live when a pod lead opens the case, the same reason nothing else in this tool re-computes on every page load. For each move-out photo: it finds the matching move-in photo (reusing `lib/photo-matcher.js` from the targeted-matching addendum, called automatically for every photo this time, not one a coordinator clicked), and if a confident match exists, sends the pair to a second, separate AI call whose only allowed output is "differs: yes/no" and a confidence number.
3. **Before anything is shown as a flag, the records check runs.** If Rincon's own accommodation records show something on file for this tenancy, any flagged difference in that case is suppressed — not shown as a "these differ" flag at all. Suppression only affects this one triage layer; it never hides, removes, or restricts the underlying photos themselves, which stay exactly as visible in the case's photo folders as they already are today. See "What Could Go Wrong" for why suppression is case-wide rather than photo-by-photo, and Open Items for the tradeoff that creates.
4. **By the time a pod lead opens the case, anything flagged is already there waiting** — shown with a visible confidence score next to it, the same "never hide the number, let a human challenge it" pattern this tool already uses for the folder-level and photo-level matches.
5. **A pair that couldn't be confidently matched to a move-in photo at all is called out separately** ("no confident move-in match — this photo couldn't be compared"), not silently skipped and not treated the same as "checked and found no difference."
6. **Nothing here ever becomes case evidence the way a matched photo pair does in the targeted-matching addendum.** This tool never presents an AI's difference-judgment as fact — it's a highlighting layer over photos the pod lead can already see in full. A suppressed or low-confidence pair is not "hidden evidence"; it's evidence that was always visible, minus one algorithmic hint about where to look first.

## What You'll See

- On an already-open case, a new **"Photo Differences"** section, populated automatically once the background scan has run for that case — nothing to click to trigger it.
- Flagged pairs shown side by side, exactly like the targeted-matching addendum's photo pairs, each with a visible **"These differ"** badge and a confidence percentage next to it — never hidden, never just used internally to decide what to show.
- Pairs the AI checked and found no difference in are not listed as flags (this tool only ever surfaces what looks different, the same "call out what's wrong, don't clutter with what's fine" approach already used for missing-evidence flags) — but a short summary line always states how many pairs were checked in total, so "nothing flagged" reads as "checked and clean," not "nothing happened."
- **If any flags were suppressed because of a known accommodation on file, the case says so plainly** — e.g. "3 photo pairs were not flagged because this tenancy has a recorded accommodation on file. Review the full move-in/move-out photo folders directly if you want to check them yourself." This is a neutral informational note, not a warning — the suppression is working as designed, and the underlying photos remain one click away in the folders that already exist today.
- Photos that couldn't be confidently matched at all get their own separate note, distinct from "checked, no difference."
- Nothing on this screen ever shows a caption, a description, or any comment about what either photo depicts — same hard rule as the targeted-matching addendum, for the same reason.
- No checklist question is added to this screen. Peter's decision (see Governance Path) was to build the records-check safeguard only, not the additional per-flagged-pair question Mason originally recommended as a backstop.

## What Could Go Wrong

- **This runs automatically across every case, not just photos a person chose — that's the entire point, and it's also the entire added risk.** Asimov's own review flagged this directly: targeted matching (the v1 addendum) only ever touches photos a human already picked; bulk diffing decides on its own, for every case, what gets flagged. Everything else in this document — the records check, the no-captioning rule, the visible confidence — exists specifically because of that gap in exposure. See Governance Path for Asimov's sequencing recommendation, which speaks directly to this.
- **Suppression is case-wide, not photo-by-photo, and that's a real tradeoff, not a clean win.** The diffing AI is never allowed to describe what it sees, which means it has no way to know that *this specific* flagged pair is the grab bar the accommodation record is about, versus an unrelated wall scuff three rooms away. Without reliable room-level metadata anywhere in this codebase's B2 folder/file naming (`lib/folder-parser.js` extracts address/unit/inspection-type/date — no location field), the only buildable v1 option is: if a known accommodation exists anywhere in the tenancy, suppress every flag in that case. That protects against the disparate-impact pattern Mason and counsel were worried about, but it also means a real, unrelated difference in the same case won't get algorithmically highlighted either — mitigated, not eliminated, by the fact that the underlying photos are still fully browsable by the pod lead exactly as they are today. Flagged in Open Items for Peter/Mason to explicitly confirm this is the right tradeoff before it ships.
- **A keyword hit is not the same thing as a confirmed accommodation, and this design lets it suppress anyway.** A maintenance ticket that merely mentions "no reasonable accommodation needed" or references an unrelated repair near a similar term would still register as a hit under the current design and suppress that case's flags — the records check is deliberately tuned toward over-suppressing rather than under-suppressing (the same "when in doubt, protect the tenant" bias `protected-class-terms.js` already documents for a different tool), but that means some real damage will occasionally get de-highlighted for the wrong reason. Same mitigation as above: nothing is hidden, only the algorithmic hint.
- **This is a real, ongoing volume of AI calls, not a one-time cost.** Unlike targeted matching (bounded by how many photos a coordinator clicks), this runs the matching step exhaustively across every move-out photo in every confirmed case, on an ongoing basis as new cases open. Needs real pacing/rate-limit planning during the build (Scotty/Q section below), not just a batch-size decision the way v1 needed.
- **This only works as well as the matching step it's built on.** If the underlying move-in/move-out photo match is wrong (a real, already-flagged limitation in both the base tool and the targeted-matching addendum), this feature inherits that error — a bad pairing could get diffed and flagged (or fail to flag) against the wrong photo entirely. Not a new failure mode, just one more thing riding on top of an existing, disclosed one.

## Known Limitation — Extending the Existing CCPA Note

Same disclosed gap as both prior documents, extended once more: this feature's own records — which pairs were diffed, the flag result, the confidence, and any accommodation-suppression decision — live in Supabase and are covered by this tool's normal deletion/export handling. They do not and cannot reach back into Backblaze B2 to delete the underlying photos. Nothing new left undisclosed.

## What Q Needs to Build This

- **The B2 byte-reading infrastructure from the targeted-matching addendum, reused as-is** — no new B2 credential work, no new `lib/b2-client.js` functions. If that addendum's `readFiles` capability confirmation (its own Open Item #5) is still unresolved when this feature starts, it blocks this feature too, since both depend on the identical capability.
- **One new library file for the diff call** (`lib/photo-differ.js`) — a second, separate AI call from the matching one, with an even narrower output contract (see Q section below). Distinct from `lib/photo-matcher.js`, which this feature calls first (unmodified) to find each pair before diffing it.
- **A new records-check module** (`lib/accommodation-check.js`) — queries the new accommodation log plus a keyword search of `maintenance_requests.description` (see Neo section #3 — this is genuinely new; nothing like it exists in this codebase today). The AppFolio-messages leg of the keyword search Mason originally recommended is **not buildable yet** — no AppFolio messages/communications data source exists anywhere in this codebase, and the one time this codebase tested AppFolio's document API against what the vendor claimed, the API turned out far more limited than promised (`projects/appfolio-sync/api-capabilities-notes.md`). Flagged as an Open Item requiring its own live-discovery pass before that leg can be built — v1 of this feature ships with the two confirmed-available sources only.
- **Neo's schema** (below) — a new accommodation-records table, a new photo-diff-results table, and a second versioned confidence-threshold table for the diff decision (distinct from the matching threshold already built in v1).
- **A background/cron job**, not a per-case-open live call — mirrors the existing `index-b2-photos` and the targeted-matching pattern of "compute once, read many times."
- **Dedicated audit log entries** for every diff computed and every suppression applied — suppression especially, since it's the one action in this feature doing real legal work.
- **Confirmation, explicitly, that the checklist-question backstop is not being built.** Peter's decision, on counsel's answer — don't add it by default or as a "safer to include" instinct; it was deliberately scoped out.

---

## Technical Appendix — For Neo, Scotty, Q, Tron, TARS

*(Peter — you don't need to read past this line. Everything below is implementation detail for the people building it.)*

### Neo — schema changes needed

Table and column names below are illustrative, not mandates — Neo makes the final call on shape, same as every other schema section in this tool's specs.

**1. Photo diff results (new)**

One row per move-out photo the background job attempted to diff — e.g. `security_deposit_photo_diffs`:
- `case_id` — `NOT NULL REFERENCES security_deposit_cases(id) ON DELETE CASCADE`
- `move_out_photo_path` — `NOT NULL`
- `move_in_photo_path` — nullable (null means the matching step found no confident pair — nothing to diff)
- `match_confidence` — the matching AI's confidence (reused from `lib/photo-matcher.js`'s own output, `NUMERIC(4,3)`)
- `differs` — nullable boolean (null when `move_in_photo_path` is null — there was nothing to compare)
- `diff_confidence` — nullable `NUMERIC(4,3)`
- `diff_confidence_config_id` — references the active row in the new confidence-config table below at the time this row was computed (item 2)
- `model_version` — text, same pattern as every other AI-touched table in this schema
- `accommodation_suppressed` — boolean, default `FALSE`
- `accommodation_suppression_source_id` — nullable, `REFERENCES security_deposit_accommodation_records(id)` — which record (if any) caused suppression for this case. No free-text description of *why* beyond that reference — the record itself carries whatever detail it carries (item 3), this table doesn't duplicate it.
- `diff_status` — e.g. `CHECK IN ('flagged', 'not_flagged', 'suppressed', 'no_match_no_diff_possible')`
- `created_at`, `updated_at` (with the existing `set_updated_at` trigger)

**What this table deliberately does not contain, per the same defense-in-depth discipline `security_deposit_photo_matches` already applies (targeted-matching addendum, Neo section #1):** no caption, no description, no free-text field about what either photo shows. Only paths, numbers, a status, a model name, and a reference. There is nowhere for a description to go even if something tried to write one.

**2. Photo-diff confidence config (new, own table)**

Same versioned/singleton-active shape as `b2_match_confidence_config` and the targeted-matching addendum's `photo_match_confidence_config` — a new table, not a shared column, for the same reasoning that addendum already gave: this is a conceptually distinct judgment call (does a *difference* get shown as a flag) from either of the other two thresholds (does a folder-name parse get auto-indexed; does a photo *match* get shown automatically) and should be able to move independently. E.g. `photo_diff_confidence_config`: `id`, `version`, `flag_threshold NUMERIC(4,3) CHECK (BETWEEN 0 AND 1)`, `is_active`, `set_by`, `set_at`, `notes`, `created_at`, `updated_at`. Seed with a placeholder, flagged unconfirmed in `notes`, same as the other two threshold tables.

**3. Accommodation records (new — genuinely new, nothing to reuse)**

Checked directly before assuming a new table was needed: no table, column, or migration anywhere in this codebase tracks accommodation requests, accessibility modifications, or anything like it. The closest existing thing is `maintenance_history`'s (not-yet-built — see Open Items) `protected-class-terms.js` keyword list, whose `disability_health` category already includes the literal terms `'reasonable accommodation'`, `'reasonable modification'`, `'service animal'`, and `'emotional support animal'` — but that file belongs to a different tool that hasn't shipped yet, and it's a flag-and-quarantine list, not a request/approval-log model. This feature needs its own small, local table — e.g. `security_deposit_accommodation_records`:
- `id`
- `lease_id` — `NOT NULL REFERENCES leases(id)` — tenancy-scoped, same FK this whole tool already keys off of
- `modification_type` — free text (e.g. "grab bar, bathroom" or "wheelchair ramp, front entry") — this is a legitimate business record, not photo content, so it's fine for it to be descriptive; it just never gets copied into anything that describes photo content (see item 1)
- `approval_status` — e.g. `CHECK IN ('approved', 'denied', 'pending', 'noted_unconfirmed')` — deliberately includes an "unconfirmed" state, not just approved/denied, since a keyword-search hit isn't a formal approval decision and Fair Housing protection doesn't require one to exist (Mason's point, even though the checklist backstop built around it isn't being built — see Governance Path)
- `source` — `CHECK IN ('manual_entry', 'keyword_match_maintenance_ticket', 'keyword_match_appfolio_message')` — the third value is reserved for when/if that leg gets built (see Q section); nothing populates it yet
- `source_reference` — e.g. `maintenance_requests.id` for a keyword-match row, null for a manual entry
- `entered_by`, `entered_at`
- `notes`
- `created_at`, `updated_at`

**4. Data inventory, RLS, and the Rule 9 tension (Asimov, GOVERNANCE.md Rule 4 and Rule 9)**

`security_deposit_accommodation_records` and `security_deposit_photo_diffs` both need the same header-comment data inventory (`pii_fields`, `agents_with_access`, `privacy_category`, `retention_policy`, `ccpa_exportable`, `ccpa_deletable`) every other personal-data table in this schema already carries, using `b2_photo_folders`' migration as the template. `security_deposit_accommodation_records` specifically stores disability-accommodation-adjacent data — `privacy_category` should reflect that it's more sensitive than an ordinary case record, and RLS on it should be at least as tight as `security_deposit_cases`, arguably tighter (Neo's call on whether it needs its own, narrower role check rather than the standard `pod_lead`/`admin` split).

**Worth stating explicitly, not glossed over:** GOVERNANCE.md Rule 9 says disability data must never be used "in any decision-making context," and this table's entire purpose is to be used in a decision (whether to suppress a flag). This is a deliberate, counsel-reviewed exception, not an oversight — the use here is protective (preventing a pattern that would otherwise burden protected-class tenants), not adverse (nothing here denies, screens, or scores anyone). Counsel's review (Governance Path, answer #1) covered exactly this design. Still, it's the kind of carve-out that should be named as one in the migration's own comments, not left for someone auditing this table later to have to reconstruct the reasoning from scratch.

Both tables need `ENABLE ROW LEVEL SECURITY` with no permissive policies, same as every table in this schema.

### Scotty

- No new B2 credential work — this feature reuses exactly what the targeted-matching addendum sets up (`readFiles` on the existing key).
- **New: this feature runs AI calls automatically and continuously, not on human demand.** The background job needs real pacing — process a bounded number of cases/photos per run, with backoff, so a backlog of newly-matched cases doesn't produce a spike against Anthropic's API or a runaway cost. Flagged here because it's a genuinely different load pattern from anything else in this tool so far (every other AI call in this tool is triggered by a human action or a small nightly batch job with a naturally small volume).
- **Owns coordinating the 7-day shadow-mode window** GOVERNANCE.md Rule 6 requires for this Critical-tier change (see Governance Path) — a deploy/rollout responsibility, not a code change, but it needs an actual owner and an actual start date once Q's build is ready.

### Q — build instructions

**`lib/photo-differ.js` (new file) — the difference call.** Mirrors `lib/photo-matcher.js`'s shape and delimiter discipline, but is a genuinely different question from matching: given two photos already known to be a pair, is there any visible difference. The system prompt must state, explicitly and prominently — enforcing both Asimov's no-description condition and Mason's pure-retrieval condition, the same two conditions the matching call already enforces, applied here to a harder question because "is there a difference" is much closer to "what changed" than "which one matches" ever was:

> You are comparing two photos of the same room or area in a rental unit — one from move-in, one from move-out. Your only task is to determine whether there is any visible difference between them. You must never describe, list, categorize, or characterize any difference you notice — not what changed, not where in the photo, not whether it looks like damage, wear, an installed object, or anything else. Answer only with whether a difference exists and how confident you are. If you cannot tell whether the two photos show the same room or area, say so via low confidence rather than guessing.

**Output contract — same "no field to put it in" defense-in-depth as the matching call:**
```json
{ "differs": true, "confidence": 0.87 }
```
No `description`, `caption`, `notes`, `category`, or free-text field anywhere in the schema or the contract.

**`lib/accommodation-check.js` (new file) — the records cross-check.** Given a `lease_id`:
1. Query `security_deposit_accommodation_records` for any row on that lease, regardless of `approval_status` (even `'noted_unconfirmed'` suppresses — see Neo section #3 for why).
2. Keyword-search `maintenance_requests.description` for rows tied to this lease's unit, against a small local term list — new, local to this tool, not imported from `maintenance-history`'s `protected-class-terms.js`, for the same "no second consumer, don't force a shared module before one's proven" reasoning this codebase already applies to the B2 client and the AppFolio connector (and because that tool hasn't shipped yet — depending on it would tie this feature's launch to an unrelated tool's build). A hit here should both (a) suppress the case's flags and (b) write a `security_deposit_accommodation_records` row with `source = 'keyword_match_maintenance_ticket'`, so the hit becomes a durable, auditable record rather than a one-off suppression decision nobody can later trace.
3. **The `keyword_match_appfolio_message` source is not implemented in this version.** No AppFolio messages/communications data exists anywhere in this codebase's sync (`projects/appfolio-sync/sync.js`'s `REPORT_CONFIG` has no such report), and AppFolio's API has already proven, on live testing, considerably more limited than the vendor claimed for a similar question (document/attachment access — see `api-capabilities-notes.md`). Building this leg needs its own live-discovery pass first, the same way Neo did a live-discovery pass on AppFolio's ledger/attachment behavior before the base tool's schema was finalized. Flagged in Open Items, not silently dropped.

**Explicitly not being built:** the mandatory checklist question Mason originally recommended as a second-layer backstop for every flagged pair. Peter's decision, on counsel's answer that the records check alone is sufficient (Governance Path, answer #2). Do not add it as a "belt and suspenders" instinct during the build — it was a deliberate design call with both the more conservative and more permissive recommendation on record.

**Background job, not a live call:**
```
internalRouter (cron, own shared secret, same pattern as the rest of this tool):
POST  /api/security-deposit/internal/run-bulk-photo-diff
```
For each case whose move-in/move-out folders are both confirmed-matched and haven't yet been diffed (or whose folder match has changed since the last diff run — re-diff, don't leave stale results): list the move-out folder's individual photos (`listFilesInFolder`, reused from the targeted-matching addendum), run the matching call for each (`lib/photo-matcher.js`, unmodified, same bounded-batch handling that addendum's Q section already specifies), then the diff call (`lib/photo-differ.js`) for every confidently-matched pair, then the accommodation check (`lib/accommodation-check.js`) once per case to decide suppression, then write `security_deposit_photo_diffs` rows.

**Reader routes:**
```
GET   /api/security-deposit/cases/:id/photo-diffs   already-computed diff results for
                                                       this case, read-only — never
                                                       triggers a live AI call
```
This does not change `GET /api/security-deposit/cases/:id`'s existing response shape — additive, its own endpoint, same pattern the targeted-matching addendum already follows.

**Audit logging — suppression especially, since it's the one action here doing real legal work:**
```
action: 'security_deposit.photo_diff_computed'
details: {
  case_id, move_out_photo_path, move_in_photo_path,
  differs, diff_confidence, model_version,
  accommodation_suppressed,
}

action: 'security_deposit.photo_diff_flag_suppressed'   // its own distinct entry,
details: {                                                 // not folded into the
  case_id, accommodation_record_id, suppressed_count,      // entry above, because
}                                                           // suppression is the
                                                             // legally load-bearing
                                                             // action here

action: 'security_deposit.accommodation_record_created'
details: {
  lease_id, source, source_reference, entered_by,   // never modification_type's
}                                                     // free text in the audit
                                                       // payload itself — that stays
                                                       // in the record, queryable
                                                       // there, not duplicated
                                                       // into a second log
```

### Tron

- New **"Photo Differences"** section on the case screen, populated from `GET .../photo-diffs`, reusing the existing `.two-col`/`.evidence-card` layout already used for the folder-level and photo-level photo displays — same visual language, don't invent a new pattern.
- Confidence visible on every flagged pair, not just used internally — same requirement as both other AI-touched confidence scores in this tool.
- A short, always-present summary line: how many pairs were checked, how many flagged, how many suppressed. "Nothing flagged" must read as "checked, clean," not as if the feature didn't run.
- **The suppression note is informational, not a warning.** Style it the way this tool already styles a "confirmed, no issue" state, not the amber missing-evidence-flag style — suppression working correctly is a good outcome, and styling it like a problem would undercut the entire point of building it.
- **Nothing on this screen may ever render a caption, description, or generated text about either photo's content.** Same hard UI constraint as the targeted-matching addendum, for the same reason — mirrors the hard output-contract constraint on `lib/photo-differ.js` itself.
- No new checklist-question UI element anywhere on this screen — see Q section.

### TARS

- Confirm the diff AI's raw output, end to end, never contains anything beyond `differs`/`confidence` — inspect the actual model response, not just what the UI renders, same discipline the targeted-matching addendum's own TARS section already requires for the matching call.
- **Confirm suppression actually suppresses.** Seed a test case with a `security_deposit_accommodation_records` row and a photo pair that would otherwise flag; confirm the flag doesn't appear, and confirm the "N pairs suppressed" summary line does.
- **Confirm the pre-existing-modification case never flags.** Feed the diff call two photos containing the identical feature (present in both); confirm `differs: false` — this is the mechanism the entire design leans on, worth testing directly rather than assumed.
- Confirm the keyword search on `maintenance_requests.description` actually fires on a realistic accommodation-related ticket and writes a traceable `security_deposit_accommodation_records` row (`source = 'keyword_match_maintenance_ticket'`) rather than only suppressing silently.
- Confirm the background job is idempotent — running it twice against an already-diffed, unchanged case doesn't re-spend AI calls or duplicate rows.
- Confirm the confidence thresholds (matching and diffing, two separate config tables) are both read at call time, never hardcoded, same test discipline already applied to every other threshold in this tool.
- **Track the 7-day shadow-mode window** (GOVERNANCE.md Rule 6, Critical) as an explicit go/no-go gate before this feature's results are shown to pod leads in normal production use — not something to wave through because the code passed its other tests.

---

## Compliance Grounding

This section records the full governance and legal history for this feature, plainly and in order, because it was a real back-and-forth, not a rubber stamp — three separate reviewers reached three different comfort levels, and the final call rests on the last one.

**1. Asimov's review (governance) — verdict: FLAGGED-WITH-CONDITIONS.** Asimov's conditions on the design itself are the same ones enforced throughout this document (no free-text output, visible confidence, versioned thresholds, audit logging, Rule 4 data inventory on every new table). Beyond the design conditions, **Asimov made a sequencing recommendation**, on the record and preserved here as standing guidance rather than dropped once legal clearance came through: build and ship targeted matching (the v1 addendum) first, and get real production experience with it, before shipping bulk diffing — because bulk diffing is the larger exposure. It scans every case automatically; targeted matching only ever touches photos a human already selected. **Peter has cleared proceeding with speccing and building bulk diffing now** — this document is that build spec. Asimov's sequencing point applies to the *ship/activate* decision, not the *spec/build* decision: nothing here should be read as skipping it. It's a live consideration for whoever decides when this feature actually goes to production, tracked here so it isn't silently forgotten between now and then.

**2. Mason's review (legal) — verdict: FLAGGED, with a two-layer recommended design.** Mason identified the core risk precisely: a diff tool that flags every newly-installed accessibility modification (a grab bar, a ramp) at or near 100% of the time — even with zero captioning or fault language — mechanically creates a Fair Housing disparate-impact pattern, because it systematically directs extra pod-lead scrutiny toward exactly the population the law protects: tenants who exercised their right to a reasonable accommodation. Mason's recommended design had two layers: (a) cross-reference Rincon's own accommodation-request records — the formal approval log, plus a keyword search of other existing records (AppFolio messages, maintenance tickets) — to suppress flags for known accommodations; and (b) an additional mandatory checklist question shown to the pod lead on every flagged pair, as a backstop for accommodations that were never formally filed, since Fair Housing protection doesn't require paperwork.

**3. Outside counsel's review — the controlling legal sign-off.** Peter sent Rincon's outside counsel a written brief describing this exact design (records check plus checklist-question backstop, as Mason described it). Counsel's answers, dated 2026-08-20 — **recorded here as Peter's own summary of counsel's verbal/informal answers relayed to Jarvis, not a formal written opinion letter; the record should be accurate about that provenance:**

1. The overall design (records check + checklist question + no-captioning + pre-existing-not-flagged) adequately addresses Fair Housing/disparate-impact risk under federal and CA law — no changes suggested.
2. The records cross-check alone is sufficient — counsel does **not** require the additional checklist-question backstop Mason recommended.
3. A flagged accessibility-related difference should be routed the same as ordinary damage — no special handling needed beyond the suppression itself.
4. Given loose personal belongings are never in these photos (vacant units only), no other protected-class categories need special handling.
5. No additional conditions beyond what's already been proposed.

**4. Peter's decision, given counsel's answer on point 2: build the records-check only.** Mason's additional checklist-question layer is being deliberately omitted — not an oversight, not a corner cut, a decision made with both the more conservative internal recommendation (Mason) and the more permissive outside opinion (counsel) on the record, and counsel's controlling. This document reflects that decision throughout — see the Q and Tron sections' explicit "not being built" notes.

**5. The Rule 9 tension, named directly.** GOVERNANCE.md Rule 9 says protected-class data (disability included) must never be used "in any decision-making context." This feature's accommodation-records check is, literally, disability-adjacent data used in a decision (whether to suppress a flag). This is a deliberate, counsel-reviewed exception — the use is protective (preventing a disparate-impact pattern), never adverse (nothing here denies, screens, scores, or disadvantages anyone) — and it's exactly the design counsel's answer #1 signed off on. Named here so it reads as a considered carve-out, not a rule quietly ignored.

**6. GOVERNANCE.md Rule 6 process status for this Critical-tier change** (decision criteria/compliance logic — this qualifies): owner approval + attorney review + 7 days shadow mode. Owner approval and attorney review are both complete as of this document (items 3 and 4 above). **The 7-day shadow-mode period is a build/deploy requirement, tracked in Scotty's and TARS's sections above — it does not block this spec, but it does block flipping this feature on for real pod-lead use once built.**

## Governance Path for This Build

Same lighter compliance-build treatment the base tool and the targeted-matching addendum both already carry (GOVERNANCE.md Rule 7's full runtime-agent lifecycle doesn't apply — nothing here acts autonomously on a person; the AI flags a pair, a human decides what it means). This feature doesn't change that classification, but it is the largest expansion yet of what the AI is allowed to look at without a human prompting it first — which is exactly what Asimov's sequencing note (above) is about.

The full Mandatory PR Checklist Table (GOVERNANCE.md) applies at PR time:

| Reviewer | What they check for this feature specifically |
|---|---|
| Neo | Schema matches Rule 4; `security_deposit_accommodation_records`' RLS is at least as tight as `security_deposit_cases`'; both new confidence-config tables follow the versioned/singleton-active pattern |
| Q | Diff output contract has no free-text field; system prompt states the no-description restriction; checklist-question backstop was NOT added; audit logging covers suppression as its own entry |
| TARS | Raw model output never leaks a description; suppression actually suppresses; pre-existing-modification case never flags; background job is idempotent |
| Ralph | What happens under a huge case backlog, a slow B2 response, a malformed AI response, a keyword search against a very large `maintenance_requests` table |
| Viper | Whether a crafted maintenance-ticket description or a crafted image could manipulate either AI call's output beyond its schema, or fraudulently trigger/avoid suppression |
| Sentinel | Reuses the targeted-matching addendum's already-reviewed B2 capability — confirm no new credential surface was introduced here |
| Mason | The suppression logic and no-captioning output actually match counsel's five answers, not just this document's description of them |
| Judge | Whether this spec's conditions were actually built, not just written down |
| Asimov | Final confirmation pass, and explicit confirmation of where this feature stands relative to the sequencing recommendation (item 1 above) at the time it's actually proposed for production |

## Scope

**In scope for this addendum:** automatic, background scanning of every matched move-in/move-out photo pair in a case; a strict binary-plus-confidence diff output with no description or judgment; the records-check safeguard (formal accommodation log, populated manually or via maintenance-ticket keyword search); case-wide suppression of flags where a known accommodation exists; visible confidence on every flagged pair; a summary line covering checked/flagged/suppressed counts.

**Explicitly out of scope:**
- The checklist-question backstop Mason originally recommended — deliberately omitted per Peter's decision (Governance Path, item 4).
- The AppFolio-messages leg of the keyword search — not buildable yet; no such data source exists in this codebase, and its feasibility is unconfirmed (Open Items).
- Any evaluative output whatsoever — damage assessment, fault, cause, cost estimation. Never in scope for this feature, same as everything else in this tool.
- Any new B2 credential or infrastructure work — fully inherited from the targeted-matching addendum.

**Depends on:** the targeted-matching addendum (v1) — specifically its `readFiles`-scoped B2 credential, `lib/b2-client.js`'s `listFilesInFolder`/`downloadFileBytes`, and `lib/photo-matcher.js`'s matching contract, all reused unmodified. This feature does not exist without that one shipping first, at least at the code level (see Open Items and Governance Path for the separate question of whether it should also ship to production second, sequentially).

## Open Items — Flagged for Jarvis and Peter

1. **Cross-check against the targeted-matching addendum's final text once it settles.** As of this writing, `targeted-photo-matching-SPEC.md` is marked "Approved," but it may still be getting a final pass elsewhere. Nothing in this document should conflict with whatever that file lands on for the B2 infrastructure it defines — re-verify the function names/signatures this document assumes (`listFilesInFolder`, `downloadFileBytes`, `lib/photo-matcher.js`'s `{ matched_index, confidence }` contract) once that file is confirmed final.
2. **Case-wide suppression granularity is a real, unresolved design tradeoff, not a clean default.** Section "What Could Go Wrong" above lays out why photo-by-photo suppression isn't currently buildable (no room-level metadata anywhere in this codebase's B2 handling) and why case-wide suppression was chosen instead. This needs Peter and Mason to explicitly sign off on that specific tradeoff — it wasn't spelled out at this granularity in the original design discussion, and it's the kind of detail that matters if it's ever scrutinized later.
3. **Whether an unreviewed keyword-search hit should have the same suppression power as a formally entered accommodation record.** Current design: yes, immediately, no human confirmation step in between (consistent with Peter's decision not to add extra review layers) — but this is a natural extension of that decision, not something explicitly stated in it. Worth Peter's explicit confirmation before it ships.
4. **The AppFolio-messages keyword-search leg needs its own live-discovery pass before it can be built at all.** Given AppFolio's document/attachment API already proved considerably more limited than the vendor's own rep claimed (`projects/appfolio-sync/api-capabilities-notes.md`), nobody should assume tenant-message data is available via the API without testing it directly first. Until that's done, the records check runs on the formal log plus the maintenance-ticket keyword search only — a real, disclosed gap relative to Mason's original two-source recommendation, not a silent one.
5. **Both new confidence thresholds (diff-flag and, indirectly, the matching threshold this feature reuses) need Peter's confirmation on their actual placeholder values** before they govern a real case — same open item every other threshold in this tool already carries.
6. **The formal accommodation-approval log starts empty.** This design's protection is only as good as that log (plus the keyword search) actually reflecting Rincon's real accommodation history. Someone needs to decide whether historical accommodations get backfilled into `security_deposit_accommodation_records` before this feature goes live, or whether it's acceptable to start clean and rely on the keyword search plus new entries going forward — an operational readiness question for Peter, not a Q build task.
7. **Portfolio-wide AI call volume and pacing needs a real decision during the build**, not just a per-batch size the way the targeted-matching addendum needed. This runs continuously and automatically across every case in the portfolio, a materially different load pattern from anything else in this tool — flagged for Scotty and Q to size together before the background job goes live, even in shadow mode.
