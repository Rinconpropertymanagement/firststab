# Mason Legal Review — AppFolio `maintenance_notes` on Property 360

**Status:** Review only. Nothing has been built. This answers the five questions Jarvis put to me; it does not itself authorize a build.
**Reviewed by:** Mason (legal/Fair Housing review — knowledgeable reviewer, not a licensed attorney)
**Date:** 2026-09-06

**Read in full before writing this:**
- `projects/hub/property-360/appfolio-maintenance-and-property-notes-research.md` (Oracle, feasibility research, 2026-09-06)
- `projects/hub/maintenance-history/content-screening-tier-redesign-SPEC.md` (Tier A/B redesign, counsel-reviewed, 2026-09-05)
- `projects/hub/property-360/owner-tenant-operational-notes-SPEC.md` (Owner & Tenant Operational Notes, counsel-reviewed, 2026-09-05)
- `projects/hub/maintenance-history/lib/content-check.js`, `lib/protected-class-terms.js`
- `GOVERNANCE.md` (Fair Housing Standard, Rules 1, 4, 6, 9)

**A note on parallel review:** Asimov is running a governance review of the same proposal at the same time, and I have not seen it. Where my position below could plausibly diverge from a governance-only analysis, I've flagged it explicitly in **bold** so a disagreement is visible when both documents are read side by side. I have not softened any position to pre-agree with a document I can't see.

---

### Document Reviewed

Not a document — a proposed feature: surfacing AppFolio's `property_directory.maintenance_notes` field (194 of 379 properties populated, reachable today via the existing nightly sync, no new credential) on the Hub's Property 360 tool, as staff-facing operational context. Real, quoted content from Oracle's live-verified research: *"Call Zack for approval for any work order. Only Zack can approve maintenance"*; *"OWNER HAS THEIR OWN HANDYMAN, OKAY TO CONNECT HIM WITH TENANTS\nEzequiel 805-212-6184"*; *"NO VCF \n500 limit\n1000 reserve\n\nCONTACT DARLYNE FIRST. she has a home warranty..."*; *"Please contact the owner for all maintenance."*

### Jurisdiction

California, statewide — federal Fair Housing Act plus FEHA's expanded protected classes (source of income, age, marital status, ancestry, immigration status, primary language — all already reflected in `protected-class-terms.js`'s category list, which was itself built from `ventura-county-compliance-kb.json`'s CA-specific expansions). **City-level jurisdiction is not confirmed and, for this specific feature, doesn't need to be**: this is an internal staff tool, not tenant-facing communication, so city-specific notice-period/just-cause ordinances aren't implicated the way they would be for a lease or a notice. What does matter statewide is FEHA's protected-class breadth, and the existing term list already covers it. If a future version of this feature ever becomes tenant-facing or decision-adjacent, jurisdiction becomes load-bearing again and must be re-confirmed per property.

---

### Findings

**⚠️ Medium-High — This is the same category of risk that `maintenance_claims` and `operational_notes` were purpose-built to screen for, and the "landlord/staff-authored operational text" framing does not change that.**

The proposed lighter-touch argument is: this is approval rules and vendor contacts, not narrative about a tenant's circumstances, so maybe it doesn't need the full screening two other systems needed. I don't accept that distinction as sufficient, for three concrete reasons:

1. **The exact failure mode this field is used for — recording an owner's standing instruction about how a property is managed — is the same failure mode `operational_notes` Section 6 was built around** ("a discriminatory owner instruction... does not need a special code path — it is handled correctly by the [content-check] mechanism that already exists"). `maintenance_notes` is an unfiltered channel for exactly this kind of owner instruction today: *"Call Zack for approval," "contact the owner for all maintenance," "OKAY TO CONNECT HIM WITH TENANTS."* Nothing structurally prevents the next owner from writing *"contact owner before renting to anyone with kids"* or *"owner prefers not to deal with Section 8"* into this same field — it is the same authorship channel, just typed into AppFolio instead of into `operational_notes`' text box. The keyword scan doesn't know or care which UI the sentence was typed into; the risk doesn't either.
2. **Age and unreviewed status make this backlog higher risk than newly-authored content, not lower.** Oracle's own words: "some of it years old," and "the 6 real `maintenance_notes` examples quoted above were operationally benign, but that is a spot-check of 6 out of 194 real populated rows, not a scan — this document does not claim the corpus is clean." A multi-year backlog written by an unknown number of different staff/owners over time, never subject to any editorial or compliance discipline, is a *more* likely place to find an old, casual, now-clearly-inappropriate note than a corpus that has always been screened at write time.
3. **The harm pathway doesn't require this data to feed an automated decision.** GOVERNANCE.md Rule 9 and Fair Housing Standard Rule 2 ("treat every applicant identically... must not vary tone, thoroughness, or process based on anything that could correlate with a protected class") apply to *human* decision-making too, not just AI decision-making. If a staff member reads a maintenance note that happens to carry protected-class-adjacent framing about a tenant or a neighborhood before interacting with that property, that can shape how they treat that tenant — disparate treatment risk exists whether or not any system ever "decides" anything. This is precisely why `operational_notes` and `maintenance_claims` gate on content, not on whether the content will be used in an automated decision.

**My answer to the framing question: authorship type (staff/AppFolio vs. Hub-typed) is not a legally meaningful distinction here. Content is.** Most of this backlog probably *is* operationally benign, exactly as the six examples suggest — but "probably benign" is what a screening pass exists to confirm, not a substitute for running it.

**⚠️ Low-Medium — Where a lighter approach *is* defensible: skipping the Tier B AI-reclassification step, not skipping Layer 1.**

Tier B exists to solve a volume/precision problem: 340 flagged records, 91% false-positive rate, a review queue overwhelmed by "Bradford White water heater." That problem doesn't exist here at this scale — 194 total candidate records, most of which won't even trip Layer 1's keyword scan. A human reviewer looking directly at the (likely small number of) raw Layer 1 hits is entirely tractable without standing up the contextual AI recheck. So: **Layer 1 (keyword scan) is not optional. Tier B is optional and can reasonably be skipped for this specific backlog given its size** — though since Tier B is already built and reusable at effectively zero marginal engineering cost, running it anyway to spare staff from reviewing an obvious "Bradford White" or "window blinds" false positive is a reasonable efficiency choice, not a legal requirement either way.

---

### Answers to the Five Questions

**1. Does this need the full two-layer check, or is a lighter approach defensible given the operational-text framing?**

Layer 1 (`protected-class-terms.js`'s `scanText()`, unmodified) must run on all 194 populated records before any of them displays, with no exception for "this looks operational." See Findings above for why the authorship-type distinction doesn't hold up. Tier B's contextual AI recheck is a legitimate thing to skip for this specific backlog given its small size (194 records, not 340+ recurring) — a human can review raw Layer 1 hits directly — but running it anyway is fine and probably worth the trivial cost, since it's already built and would reduce needless review load. **This is not a maximum-caution default; it's a content-based line, not an authorship-based one** — the corpus, whatever it turns out to contain, gets exactly the same Layer 1 gate `maintenance_claims` and `operational_notes` content gets, no more and no less.

**2. What happens to a flagged note — held out entirely, shown with a "pending review" indicator, or something else? Reuse `maintenance_claims`'s queue, or build something distinct?**

Not `maintenance_claims`'s exact model, and not a hard, silent hold-out either. Two reasons:

- **Silent exclusion is the wrong UX here for an operational reason, not just a legal one.** `maintenance_claims` hides flagged rows with no indicator because a hidden ticket-narrative claim rarely blocks anyone's next action. `maintenance_notes` is different in kind — it's the field most likely to carry the one sentence a maintenance coordinator actually needs *right now* ("only Zack can approve," "contact the owner directly"). Silently showing nothing, with a flagged note sitting in review for days, risks a real operational failure (nobody knows who to call) on top of the Fair Housing question. Recommend the `operational_notes` pattern instead: a visible placeholder ("A note here is pending compliance review") rather than silent absence — same placeholder convention `safeTicketTitle()` already uses for "something is here, you can't see it yet."
- **Structurally, this content is shaped like `operational_notes`, not like `maintenance_claims`.** It's property-level and persistent (like an owner/property fact), not per-incident and transient (like a ticket claim). `operational_notes`' three-way review disposition — retain restricted / rephrase-and-release / false-positive-released — fits this content much better than `maintenance_claims`'s binary flagged/not-flagged-plus-permanent-exclusion, because a `maintenance_notes` value legitimately might need partial rephrasing (keep "contact the owner for all maintenance," drop a clause that shouldn't be there) rather than an all-or-nothing keep/discard.

**My recommendation, and where I'd want Asimov's view compared against mine explicitly: don't build a third, parallel review queue.** Oracle's own Section 4 already names this fork ("Whether AppFolio's notes should feed into `operational_notes`... versus stay a separate, clearly-labeled, read-only display is a real design fork"). I come down on the side of routing this into (or directly modeling on) `operational_notes`'s access-tier and review-disposition machinery rather than inventing a fourth vocabulary — reusing `subject_type='property'`/`'owner'`, the three-outcome disposition table, and the tiered-access read-logging already built and already counsel-reviewed for structurally identical content. **If a schema change is needed** (e.g., a `source` value for AppFolio-synced content with no human author, since `operational_notes.author_team_member_id` is currently `NOT NULL`), that's a real, small Neo/Q build item — not a reason to avoid the fit. Building a lighter, separate system for this content specifically because it's less work would recreate the exact "second, disconnected notes surface with a weaker review discipline" risk Oracle already flagged.

**3. Does an already-cleared flag need re-check logic when the underlying AppFolio value changes, or is "each new sync'd value gets its own fresh check, reusing the flag state only if text is unchanged" sufficient?**

That approach is correct, and I'd go further: **it isn't just sufficient, it's the only safe design, and it should be treated as a hard requirement, not a nice-to-have.** A disposition (cleared, false-positive-released, whatever) is a judgment about specific text. If AppFolio's value changes — even a small edit — the old disposition was never a judgment about the *new* text, and carrying it forward uncritically would create exactly the gap this whole review exists to prevent: an owner edits a previously-benign note into something newly problematic, and because the row's flag was "already cleared," nobody ever looks at it again. Concretely:

- On every sync, diff the incoming value against the last text Rincon actually scanned for that row (not against whatever AppFolio currently shows elsewhere — Rincon has no visibility into AppFolio's own edit history per Oracle's Section 8, so Rincon must keep its own "last scanned text + timestamp" specifically to make this diff possible).
- Unchanged text → the persisted flag/review state may be reused; no need to re-run Layer 1 or a human review nightly for identical content.
- Any change at all → treat the new value as unscreened content requiring a fresh Layer 1 pass and a reset review status. Never inherit a prior human's disposition for text they never saw.
- Log the value transition itself (old value, new value, sync timestamp) to `audit_log`, consistent with GOVERNANCE.md Rule 6's "log every change... with previous and new values" — this is also the only way a future compliance review can answer "was this flag cleared against the text that's showing today, or against something different that's since been edited."

**4. Any concern with displaying real vendor names/phone numbers and owner-relationship details to whichever staff roles can see Property 360?**

Not a Fair Housing question, and low legal risk on its own terms — this is ordinary internal-use B2B contact information (a handyman's name and cell number, an owner's home-warranty contact), collected and already used for the same operational purpose it's being redisplayed for. No CCPA/data-broker exposure that I can identify from displaying it to Rincon's own staff for property-management purposes.

Two things worth a plain sanity-check flag, not a blocker:

- **Least-privilege access, not blanket Hub-wide display.** CLAUDE.md's own Supabase section already requires RLS access policies "explicitly added per tool," and every other Hub tool in this codebase (LeadSimple, maintenance-history, `operational_notes`) uses an explicit per-role allow-list rather than "any logged-in Hub user." This field should get the same treatment — scoped to whichever roles actually need it for property/maintenance work, not exposed simply because Property 360 itself is visible to a broader audience.
- **Some of this content encodes an owner's private preference about who gets contacted and how** ("OWNER HAS THEIR OWN HANDYMAN, OKAY TO CONNECT HIM WITH TENANTS" — a specific permission granted to whoever was managing that property at the time). Redisplaying it broadly, without the original context of who that permission was actually meant for, is a business/operational risk (a staff member unfamiliar with the account relaying a contact the owner didn't intend to be handed out that broadly) more than a strict legal one — worth a light mention to whoever scopes access, not a legal blocker.

**5. Anything else, matching tonight's rigor?**

- **Register the repurposed column under GOVERNANCE.md Rule 4 before it goes live.** `properties.maintenance_notes` becomes a new store of personal data (vendor names/numbers, owner instructions) the moment it's mapped and displayed — it needs the same data-inventory entry (`pii_fields`, `agents_with_access`, `privacy_category`, `retention_policy`, `ccpa_exportable`/`ccpa_deletable`) every other PII-bearing table in this schema carries. Nothing has been built yet, so this hasn't happened — flagging it now so it isn't skipped later because "it's just a sync mapping, not a new table."
- **Treat the 194-record backlog the same way the Tier A/B redesign treated its own 340-record historical cleanup (that spec's Section 7): never an automated bulk release.** Run Layer 1 across all 194 up front; anything unflagged can display; anything flagged waits for an actual human disposition before it displays, one record at a time. No bulk `UPDATE` that marks the whole backlog "reviewed" based on a sample.
- **The ongoing sync-time check (Question 3) has to ship with the initial display, not as a fast-follow.** A one-time backlog scan without live re-check logic leaves a same-day gap: the very next nightly sync could pull a newly-edited value that's never been screened at all. Given Oracle's Section 8 explicitly flags that Rincon only ever sees "today's current value," shipping the static scan without the diff/re-check mechanism creates a false sense of having solved this.
- **Attorney confirmation, not necessarily a full new opinion, but I don't think this should ship on Mason's internal read alone.** Both of the two directly-analogous systems in this codebase went to real outside counsel before shipping their content-screening logic — and both opinions were scoped to specific data (`maintenance_claims`, `operational_notes`). Neither document was written with `properties.maintenance_notes` in view. I'm not a licensed attorney and can't personally clear the sufficiency question of "does the existing Tier A/B reasoning legally extend to this new data source" — that's exactly the kind of question my own operating limits say to route out. My recommendation is a short confirmation from the same counsel (not a ground-up new engagement) that the existing framework's reasoning covers this additional AppFolio-sourced corpus. This is inexpensive relative to what's already been spent tonight and closes a real "assumed coverage" gap rather than leaving it implicit.

---

### Where My Position May Differ From Asimov's Governance Review

I haven't seen Asimov's parallel document, so I can't say where we actually disagree — only where I'd expect a difference to show up if one exists. Flagging these explicitly so a reader comparing both documents can spot it:

1. **I do not accept "this is landlord/staff-authored operational text" as, by itself, a reason to run a lighter content-check than `maintenance_claims`/`operational_notes` got.** If Asimov's governance analysis treats the authorship distinction as sufficient to justify skipping Layer 1 (as opposed to just skipping Tier B, which I agree is reasonably skippable at this volume), that's a place we'd disagree.
2. **I recommend a visible "pending review" placeholder over silent exclusion**, specifically because this field carries information staff may operationally depend on. If Asimov recommends reusing `maintenance_claims`'s silent-hide model as-is for consistency with existing infrastructure, that's a difference in emphasis worth surfacing — mine is driven partly by an operational-continuity concern sitting alongside the legal one.
3. **I recommend routing this into (or modeling directly on) `operational_notes` rather than building a separate, lighter review structure**, even though that likely means more build work up front (schema extension for a non-human-authored source, no `author_team_member_id`). If Asimov's read is that a smaller bespoke mechanism is acceptable given this is "just a display of existing AppFolio data," I'd flag that as the point of disagreement — my position is that the review discipline should match the content risk, not the size of the engineering lift.
4. **I recommend a short attorney touch before shipping**, on the reasoning that neither existing counsel opinion was written with this data source in view. If Asimov's governance review concludes that Asimov/Mason's own internal sanity-check is sufficient (the same pattern used for some smaller changes within the already-covered specs), that's worth reconciling explicitly with Peter rather than silently picking whichever answer is more convenient.

---

### Recommended Changes

1. Run Layer 1 (`scanText()`, unmodified) against all 194 populated `maintenance_notes` values before any of them is shown on Property 360. No exception for content that "looks operational."
2. Tier B's contextual recheck is optional for this specific backlog given its size — reasonable to skip (human reviews raw Layer 1 hits directly) or reasonable to run anyway (it's already built, reduces needless review). Either is defensible; document which one is chosen and why.
3. A flagged-and-unreviewed record renders a visible placeholder, not silent absence, given the operational-continuity concern above.
4. Route review disposition through `operational_notes`'s three-outcome model (retain restricted / rephrase-and-release / false-positive-released) rather than `maintenance_claims`'s binary model or a new fourth vocabulary — resolve Oracle's Section 4 fork toward `operational_notes`, with Neo scoping whatever schema extension a non-human-authored source requires.
5. Every nightly sync diffs incoming text against the last-scanned value per row; unchanged → reuse prior disposition; changed → fresh Layer 1 scan, review status reset to unreviewed, and an audit_log entry recording old/new value. This ships with the initial display, not after.
6. Gate Property 360's display of this field to an explicit, reasoned per-role allow-list (matching every other Hub tool's convention), not blanket visibility to anyone who can open Property 360.
7. Register `properties.maintenance_notes` in the GOVERNANCE.md Rule 4 data inventory before go-live.
8. Treat the historical backlog the same human-executed, no-bulk-release way the Tier A/B redesign treated its own 340-record cleanup.
9. Get a short confirmation from the outside counsel who reviewed the Tier A/B redesign and `operational_notes` that their existing reasoning extends to this new AppFolio data source.

### Attorney Referral

**Yes, recommended before production display — likely a short confirmation, not a new engagement.** This extends an already-attorney-reviewed compliance mechanism (Tier A/B content screening) to a data source neither existing opinion was scoped to cover. I can flag that gap; I can't close it myself. *"This requires a licensed attorney's confirmation that the existing framework extends to this specific data source — I can identify the gap, but I cannot certify legal sufficiency myself."*

### Verdict

**FLAGGED ⚠️ — Buildable, with the controls above in place before real display goes live.** Nothing about this data, based on what's been sampled so far, looks alarming — the risk is the same known, already-solved-elsewhere risk (unscreened staff/owner free text about real properties and people), not a novel one. The path to shipping this safely is short and mostly reuses infrastructure this codebase already built and already got counsel to bless once tonight. It should not ship as a bare, unscreened display just because the underlying AppFolio data happens to be reachable — reachability was Oracle's question; this document's answer is that reachability alone doesn't clear the Fair Housing bar the two sibling systems were required to clear.
