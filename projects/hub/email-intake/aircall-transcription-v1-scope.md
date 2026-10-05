# Aircall Call Transcription & Phone Complaint Detection — v1 Scope

**Status:** Draft for Peter and outside review — not yet approved, not something to build against yet. Same status as `complaint-tracking-v1-scope.md`: written to get this idea sharp before it becomes a real build plan.
**Written by:** Oracle
**Date:** 2026-09-09
**Revision note (2026-09-09):** Updated after Sentinel's security/privacy review of the first draft. Three findings (consent-scope gap, audio-at-rest logging discipline, Fair-Housing full-visibility policy for audio) are addressed below — two as new Open Items (real open questions this document can't resolve on its own), one as a direct build-requirement fix to Design Decision 8. Sentinel's secondary findings (a numeric inconsistency, the CCPA cascading-delete hook, cross-owner access scoping, the two-part CIPA question, and the unscreened-STT-vendor exposure) are also incorporated — see Design Decisions 5, 7, 8, the Data Inventory, and Open Items 7 and 9.
**Origin:** Continuation of tonight's session. Peter already worked through the buy-vs-build decision directly (see Design Decision 1) and confirmed the direction: build our own recording → transcript → complaint-detection pipeline rather than buying Aircall's own AI Assist add-on. This is a **separate spec from `complaint-tracking-v1-scope.md`**, reviewed on its own track, for the same reason `call-stats/SPEC.md` was split from this document in the first place: "read and route" (call-stats, stats only) shipped first; "read and understand content" is deliberately later and separately governed. This document is the phone-side half of that second piece — it does not redesign anything `complaint-tracking-v1-scope.md` already decided, it describes how a phone call becomes an input to that system.

**Built from:**
- `projects/hub/call-stats/SPEC.md` in full — the precedent this reuses directly: its "Explicitly Out of Scope" section is the line this document now crosses on purpose, and its Design Decisions 1–6 (pod/person attribution via `users.email`, sum-not-average storage, the `claims`-bypass test, governance reasoning, the Aircall credential) are the starting assumptions here, diverged from explicitly wherever content changes the answer.
- `supabase/migrations/20260819010000_call_stats.sql` and `20260904000000_call_stats_line_misses.sql`, and `projects/hub/call-stats/lib/aircall-connector.js` / `lib/sync.js` — the real, already-live-verified Aircall API behavior this document builds on rather than re-guesses (600-call and 573-call live samples: pagination via `meta.next_page_link`, `call.user` populated with `{id, name, email}` or `null`, `call.duration` not trustworthy, in-progress calls have `ended_at: null`, three real "unattributed" call shapes). None of that prior verification touched `recording` / `recording_short_url` — this document's own "Needs Live Verification" section is the first time those fields are addressed.
- `projects/hub/email-intake/complaint-tracking-v1-scope.md` in full — the taxonomy, lifecycle, and ownership model this document plugs into rather than reinvents. Every category name, the 2-day silence rule, the tone dimension, the DO-owned triage, the "uncertain → DO queue, tagged, never hidden" mechanism, and the Owner-in-Distress escalation mapping are treated as fixed here, not redesigned.
- `projects/hub/maintenance-history/lib/content-check.js`, `lib/protected-class-terms.js`, and `content-screening-tier-redesign-SPEC.md` — the real, precision-tuned two-layer Fair Housing screen this document points phone transcripts at (`checkClaim()`'s Tier A / Tier B / model-layer shape), not `email-intake/lib/fair-housing-filter.js`'s simpler keyword-only version.
- `supabase/migrations/20260905020000_missive_shared_inbox_intake_schema.sql` — two patterns reused directly: the Rule 9 "housing-decision firewall" (zero foreign keys from raw, unscreened content into any housing-decision table), and its own citation of `compliance/owner-tenant-notes-outside-counsel-opinion.md` Section 5's architecture principle, which this document leans on hard for the third-party speech-to-text step (see Design Decision 7).
- `compliance/owner-tenant-notes-outside-counsel-opinion.md`, Section 5 — outside counsel's CIPA-conscious architecture ("Rincon receives → resides in Rincon's system → Rincon causes a contracted processor to analyze Rincon's stored copy → processor doesn't monetize/train on it"), written about email, applied here to recorded audio by analogy — flagged as needing its own confirmation, not assumed to transfer automatically (Design Decision 7, Open Items). Also Section 4 — the same opinion's tiered-access recommendation for flagged/withheld content ("Ordinary employee → sanitized note; authorized compliance reviewer → underlying content"), pulled in on Sentinel's review to question whether email's "fully visible" Fair Housing behavior should transfer unmodified to a verbatim audio transcript (Design Decision 5, Open Items) — not part of the original draft's citations.
- `GOVERNANCE.md` in full (Rules 1–10, the Fair Housing Standard) and `CLAUDE.md`'s compliance-build definition.
- `projects/hub/package.json` (no speech-to-text SDK installed yet — a real, new dependency this build introduces) and `.env.example`'s credential-documentation pattern.

**Where this will live:** Proposed as a new Hub section, `projects/hub/phone-intake/` — not folded into `call-stats/` (which stays permanently stats-only, per its own spec's explicit boundary) and not a copy of the central complaints tool (which lives wherever `complaint-tracking-v1-scope.md`'s build puts it — this section writes into that system, it doesn't duplicate it). `phone-intake` would depend on Aircall API access the same way `call-stats` does; whether it shares `call-stats/lib/aircall-connector.js` outright or gets its own narrowly-scoped copy (matching that file's own stated reason for not being a shared, cross-project module yet) is a small decision for Q, not resolved here.

**A load-bearing dependency, stated plainly up front:** this build has no destination until `complaint-tracking-v1-scope.md`'s own system exists. That document is itself still a draft scope awaiting Stephen's review — no `complaints` table, no lifecycle, no DO queue has been built yet. This document assumes that system ships first, or in parallel closely enough that Neo can design this build's own tables against its real, finished shape rather than a guess. Building this piece first, with nowhere real to send a detected complaint, is not recommended (see Open Items).

---

## What This Does

Today, if a tenant or owner says something important on a phone call — a habitability complaint, a threat to break a lease, an owner hinting they're unhappy — that information exists only in whoever took the call remembering to write it down. Nothing captures it automatically the way email already will once `complaint-tracking-v1-scope.md` ships. This build closes that gap for the **subset of calls that get recorded**: it fetches the recording, turns it into text using a third-party transcription service, reads that text the same way an email would be read, and — if it looks like a real complaint — creates a tracked record in the exact same central complaint system email complaints land in, tagged so everyone can see it came from a phone call.

**The one-sentence limitation that has to be understood before anything else about this build:** it can only see what got recorded. Real, live-sampled data tonight shows roughly two-thirds of inbound calls (65%) and under a third of outbound calls (30%) have a recording at all today — this tool doesn't create new phone coverage, it adds understanding on top of whatever slice of phone activity already happens to be recorded.

## How It Works

1. **A recorded call finishes.** Aircall's own webhook system (or, if that turns out not to be reliable enough — see Open Items — a nightly sweep of the previous day's calls, the same pattern `call-stats` already uses) notices a call has ended and has a `recording`/`recording_short_url` field.
2. **This build fetches that recording** — the same presigned S3 audio link Aircall's own API already returns for free on the base plan, no different account tier needed. Very short calls (under some minimum length — not yet decided, see Open Items) may be skipped outright, since a 12-second call is unlikely to contain a real complaint and would just add noise and cost.
3. **The audio goes to a third-party speech-to-text service** (exact vendor not yet chosen — see Open Items) and comes back as plain text. The audio itself is not kept in Rincon's own storage afterward, by design (see Design Decision 8) — only the transcript is retained.
4. **The transcript is run through the same two-layer Fair Housing content check already built and precision-tuned for Maintenance History** (`content-check.js` — keyword scan plus a second, independent AI pass), not the simpler keyword-only version used for email. A flag never hides the record; it tags it (Design Decision 5).
5. **Claude reads the transcript** and applies the exact same logic already defined for email: match it to a property, tenant, owner, team member, or vendor; assign it to one of the six "big deal" categories (or "Needs a human call" if genuinely unsure); score the same frustration/tone dimension; and — same rule as email — create an orphan record, flagged "needs matching," if no subject can be identified rather than dropping it.
6. **The result is written into the same central complaint-tracking system email complaints go into**, with `source = 'phone'`, a link to the transcript for anyone who wants to read the actual conversation, and everything else (lifecycle, DO ownership, aging clock, Owner-in-Distress escalation) working exactly the way `complaint-tracking-v1-scope.md` already defines it — this build adds a second front door, not a second system.
7. **Routine calls produce a tracked-but-not-surfaced record**, same as a routine email — logged for future recurrence detection, never shown as something needing attention.

## What You'll See

- **Nothing new to look at separately.** A phone-detected complaint shows up inside the same central complaints tool `complaint-tracking-v1-scope.md` describes, next to email-detected ones — distinguished by a small "Phone" tag/icon (the same visual treatment that document already calls for separating owner-tied from tenant-tied items, applied to source instead). Opening one shows the transcript instead of an email thread.
- **A real, visible reminder of the coverage gap**, not something buried in a footnote: this tool should make it obvious, probably right on the complaints list or its own small status line, that it's only ever seeing a fraction of real calls — something like "X of Y calls this week had a recording to check." Peter should never come away thinking "the phone is covered" when today it's roughly two-thirds of inbound and under a third of outbound, and some lines aren't recorded in any meaningful volume at all.
- **A Fair-Housing-flagged phone complaint stays fully visible, tagged, as this document's current working design** — same behavior already confirmed for email, not Maintenance History's own "held until reviewed" gate. A human always sees it; a human decides what happens next. **This specific point is still open for audio, not fully settled** — see Design Decision 5 and Open Item 9: Mason should confirm whether "fully visible" is the right call for a verbatim transcript, or whether a tiered view (sanitized by default, full content for an authorized reviewer) is more appropriate here than it was for email.
- Nothing here sends a text, a call, or an email to anyone. Nothing here approves, denies, or scores a tenant or applicant. This build reads and classifies phone content; a person still owns every decision.

## What Could Go Wrong

- **Partial recording coverage creates a false sense of complete coverage.** The single biggest risk of this build isn't a bug — it's someone assuming "we now track phone complaints" when really only the recorded slice is tracked, and per tonight's real sample, that's unevenly split by line and direction in a way nobody fully understands yet (see Open Items). This needs to be communicated plainly and kept visible in the tool itself (see "What You'll See"), not just disclosed once in this document and forgotten.
- **Speech-to-text mishears create a false complaint signal, or miss a real one.** Transcription of real phone audio (background noise, crosstalk, accents, a bad cell connection) is not perfect. A misheard word could make an ordinary call look like a churn threat, or a real complaint could come through garbled enough that Claude reads past it. The mitigation is the same discipline already used for email: nothing here auto-acts, a human reviewing a flagged item should be able to read the actual transcript (not just an AI summary of it), and — new to this build specifically — TARS should test against a sample of real, noisy Rincon audio, not just clean studio-quality test clips.
- **A missed or delayed webhook silently means a recorded call never gets processed at all**, and nobody notices, because there's no natural "the count looks wrong" signal the way a missing email might eventually surface elsewhere. Aircall's own webhook shape for this hasn't been checked against a real payload yet (Open Items). Recommend building a nightly reconciliation pass regardless of whether webhooks work — the same call-stats sync job already pulls the previous day's calls; it's a small addition to also check "did every recorded call from yesterday get a transcript row," and flag any gap rather than trusting the webhook alone.

---

## Explicitly Different From `call-stats` — Read Before Assuming Anything Carries Over

`call-stats/SPEC.md` drew a hard, permanent line: no recordings, no transcripts, no call content, ever, in that build. This document is the deliberate crossing of that line, built as its own separately-reviewed piece exactly as that document said it would need to be. Nothing about `call-stats`'s own governance conclusion (Design Decision 5: "probably not a compliance build," no Asimov/Mason review needed) transfers here — this build's governance conclusion is the opposite, and stated in full in Design Decision 9 below.

---

## Aircall API — What's Confirmed vs. What Needs Live Verification

Following the same discipline `call-stats/SPEC.md` and `maintenance-history/SPEC.md` both used for Latchel and Aircall before them.

**Confirmed, live, tonight (real Rincon account, real `GET /v1/calls`):**
- A real call object carries `recording` and `recording_short_url` fields — presigned, time-limited S3 URLs to the actual MP3 audio — whenever a recording exists for that call. No `transcript` field exists anywhere in the base API response; only raw audio is ever returned.
- Recording coverage is real but partial and uneven, confirmed against a 50-call sample: 26/50 calls had a recording. By direction: inbound 15/23 (65%), outbound 8/27 (30%).
- Of the 7 Aircall lines that appeared in that 50-call sample (Property Manager - Solimar, Property Manager - Faria, Transaction Coordinator, Maintenance Coordinator-Solimar, Quick Turn Project Manager, Quick Turn Admin Assistant, Office Line), only "Office Line" showed `live_recording_activated: true` — yet several of the *other* lines still had real recordings present too. **This is a genuine, unresolved contradiction, not glossed over:** whatever actually controls whether a given call gets recorded is not fully understood — a per-agent manual start/stop is one real possibility, not confirmed. Worth noting: `call_stats_line_misses.sql`'s own live check found Rincon's account has **15 real Aircall lines total**, not 7 — this 50-call sample only happened to touch 7 of them, so the recording picture across the other 8 lines is completely unchecked, not just uncertain.
- Aircall's own support, via Peter's real correspondence today, confirmed that transcripts under their paid AI Assist product are pulled per-call-ID after the call ends (no bulk push), become available roughly 30% of the way through the call's own duration after it ends, and the recommended integration pattern is their own webhook events (e.g. call-ended) triggering a fetch — this is secondhand from Aircall support, not yet checked against a real webhook payload from Rincon's own account.

**Needs live verification before Neo finalizes a schema or Q writes the sync:**
- The exact webhook event Aircall sends for "call ended, recording ready" — its name, payload shape, and whether it fires before or after `recording_short_url` is actually populated on the call object. Not yet checked against a real payload. If it turns out unreliable or the payload is missing fields this design needs, the fallback is the nightly-sweep pattern `call-stats` already uses (poll yesterday's calls, filter to ones with a recording) — slower (up to a day's delay) but far simpler and already-proven in this codebase.
- Whether `recording_short_url` is a stable, sufficiently-long-lived link for a same-day fetch, or expires fast enough that a delayed nightly sweep could find it already dead — presigned S3 URLs are typically short-lived. If they expire quickly, this design needs to fetch on webhook-fire (same-day), not next-day-batch, which is a real design constraint on whether the nightly-sweep fallback above is even viable.
- Whether a call ever has `recording_short_url` populated but the audio is corrupted, silent, or otherwise unusable — not yet observed, should be handled defensively (skip + log) rather than assumed impossible, same posture `sync.js` already takes toward every other Aircall edge case.

---

## Design Decisions

### 1. Build our own pipeline, don't buy Aircall's AI Assist / AI Assist Pro

**Decision, already made with Peter tonight:** do not buy Aircall's own transcription add-on ($9–49/seat/month, roughly $99–539/month across Rincon's 11 real seats). Pull raw audio ourselves (already free on the base plan) and run third-party speech-to-text on it instead.

**Reasoning:** buying Aircall's add-on does not remove the engineering work this build requires. Aircall's own support confirmed that even under AI Assist, transcripts are not pushed automatically — someone still has to listen for new calls via webhooks and pull each transcript by API call. Since the webhook-listen-and-fetch integration has to be built either way, the only thing paying Aircall's per-seat fee buys is *their* transcription instead of a third party's — and third-party transcription is meaningfully cheaper (see Design Decision 3's cost figures) for equivalent or better accuracy. There is no version of this build that avoids writing an integration; given that, the cheaper source for the text is the obvious choice.

### 2. This is a genuinely new content-sensitivity category for this schema

Every other AI-reading build in this codebase (`maintenance_claims`, the Missive email intake) reads *written* correspondence. This is the first build to touch **actual recorded human speech** — a tenant's or owner's own voice, not their typed words. That's not a cosmetic difference: audio recording of a phone call is squarely CIPA (California's wiretapping law) territory in a way email generally isn't, and it's a more sensitive data category than anything else currently in this schema. Every governance and retention decision below is made with that fact in view, not by inheriting `call-stats`'s "this is just counts" conclusion, which explicitly does not apply once content enters the picture.

### 3. Cost is real but small — the actual cost driver is the build, not the bill

Grounded in Rincon's real call volume (742 answered calls / ~2,064 minutes of talk time company-wide in a real 30-day window, though only the recorded fraction of that actually gets processed):
- Third-party speech-to-text at 2026 pricing runs roughly $0.0025–$0.006/minute (AssemblyAI ~$0.15/hr batch, Deepgram Nova-3 ~$0.0043/min, OpenAI's transcribe models ~$0.003–0.006/min) — at current, partial recording volume, roughly **$6–12/month**.
- Claude reading each transcript to extract complaint signal, the same classification work `extract-claims.js` already does for maintenance content, at Sonnet 5 rates — roughly **$2–4/month** at this volume.
- **Combined: roughly $10–15/month at today's partial (Office-Line-heavy) recording volume.** If recording is ever expanded to more of the other lines, this scales with volume but stays cheap per-minute — the real cost of this build is the engineering time to build and govern it correctly, not the ongoing bill.

### 4. What triggers processing — webhook-driven, with a nightly fallback

Following Aircall support's own recommended pattern (and the shape `call-stats` already uses for its own nightly pull), this design prefers a webhook — "call ended, recording available" — triggering an immediate fetch-and-process, rather than waiting for a nightly batch. Recommended specifically **because** transcripts becoming useful roughly 30 minutes into a still-fresh conversation's aftermath is a real, if smaller, win for phone content (a fast-moving situation, like a tenant threatening to break a lease *today*, benefits from same-day surfacing more than an email does, where next-morning is usually fine). Given the webhook payload shape is unverified (see above), this build should still include the nightly reconciliation sweep as a safety net regardless of whether the webhook works cleanly — not an either/or choice.

### 5. Fair Housing screening reuses Maintenance History's real, tuned two-layer check — not email-intake's simpler one

Same reuse principle `complaint-tracking-v1-scope.md` already confirmed for the email side: point at `maintenance-history/lib/content-check.js`'s `checkClaim()` — a keyword list (`protected-class-terms.js`) plus a second, independent AI layer, recently precision-tuned with Mason and outside counsel (2026-09-05) to cut false positives on six specific words (e.g. "white"/"black" almost always meaning a paint color, not race) — not `email-intake/lib/fair-housing-filter.js`'s simpler keyword-only scanner. **Behavior matches what's already been decided for email, explicitly not Maintenance History's own gate:** a flag stays fully visible in the normal complaint view, tagged — it routes into the same "Needs a human call" DO queue, never held out of sight the way Maintenance History's own review queue holds its own flagged claims.

One real difference worth naming: `checkClaim()` was built and tuned against maintenance-report text — short, structured, third-party-written descriptions. A phone transcript is longer, first-person, and conversational. The keyword layer should behave identically (it's a plain text scan), but the Tier B contextual-disambiguation layer and Layer 2's model judgment have not been tested against transcript-shaped text specifically — worth a real check with a handful of actual transcripts before this ships, not assumed to transfer perfectly from claim text to conversation text.

**A second, more basic difference this document is not resolving on its own: whether "fully visible" is even the right policy for a verbatim audio transcript.** The "flag but never hide" behavior above is inherited directly from the email complaint tracker's own decision for *written* notes. But `compliance/owner-tenant-notes-outside-counsel-opinion.md` Section 4 — the same opinion cited elsewhere in this document — recommends the opposite tiering for exactly this kind of flagged content: "Ordinary employee → sees sanitized note or notice that something was withheld. Authorized compliance reviewer → may inspect the underlying content." A raw phone transcript carries materially more incidental protected-class exposure than a terse written maintenance ticket — a tenant can mention a disability, a custody arrangement, or an immigration status in passing mid-conversation in a way that essentially never happens in a structured note. This document is not overriding the email decision on its own authority — that would be inventing an answer to a real open question — so it names this plainly instead: **Mason should re-examine "fully visible, tagged" specifically for audio transcripts, not treat it as automatically inherited from the email decision** (see Open Items).

### 6. Same complaint taxonomy, same lifecycle, same ownership — this build adds a source, not a system

Per the task's own instruction and `complaint-tracking-v1-scope.md`'s own design: this document does not redefine the six "big deal" categories, the 2-day blocked-resolution clock, the DO-owned triage, the "uncertain → DO queue, tagged" mechanism, the frustration/tone dimension, the orphan-record rule, or the Owner-in-Distress escalation mapping (only relationship/churn-risk escalates there). A phone-detected complaint is written into the exact same underlying table(s) that system defines, with `source = 'phone'` (alongside whatever value email uses, e.g. `'email'`) as effectively the only new dimension this build's content adds to that system's own data model. The one-off-owner-instruction category (category 6) still proposes a new `operational_notes` entry (`20260905000000_owner_tenant_operational_notes_schema.sql`) exactly as email does — no separate mechanism invented for phone.

### 7. The third-party speech-to-text step, architected against real counsel guidance — even though that guidance was written about email

**This decision covers two analytically separate CIPA questions, and they should not be collapsed into one "does the email opinion transfer" question — they need to be posed to counsel as two distinct questions:**

**(a) Consent to record the call at all** — California Penal Code §632, the two-party-consent question. This is the question already named in Open Item 2 (whether the existing recording disclosure covers any newly-expanded line) and is unrelated to the architecture below.

**(b) Whether routing an already-lawfully-recorded call's audio through a contracted third-party transcription processor is itself defensible under an interception theory** — closer to §631, which is what `compliance/owner-tenant-notes-outside-counsel-opinion.md` Section 5 actually analyzed, for email: whether a third-party processor acting on Rincon's behalf is "a tool of the business" or a separate interceptor. That section lays out a specific, CIPA-conscious architecture: Rincon receives the content, it resides in Rincon's own system, Rincon *then* causes a contracted processor to analyze Rincon's stored copy, and that processor does not independently monetize, train on, or otherwise use the content for its own purposes. That opinion was written about *email*, not recorded audio — but the underlying concern maps at least as directly onto recorded phone audio, arguably more directly, since CIPA's origin is wiretapping law, not email law.

**This design follows that architecture as its working assumption for question (b), not as a settled legal conclusion:** the sync job fetches the recording from Aircall's presigned URL itself (Rincon "receiving" it), rather than ever handing Aircall's URL directly to the speech-to-text vendor to fetch on its own — the vendor only ever receives audio bytes Rincon's own server sent it, under a data-processing agreement that says the vendor doesn't retain or train on the audio afterward (a concrete term to confirm when a vendor is chosen — see Open Items). The same shape applies to Claude reading the transcript afterward, which is already how every other AI-reading build in this codebase works. **Flagged explicitly, matching this document's own "don't assume, get it checked" discipline:** this is Oracle's extension of an email-specific opinion to a new content type by analogy, not a fact this document is asserting as settled. It needs its own confirmation from whoever gave that opinion (or new counsel) before this ships, specifically on recorded audio and CIPA §631 — not inherited silently. Question (a) needs its own, separate confirmation (see Open Items).

**One exposure this architecture does not remove, stated plainly rather than left implicit:** Fair Housing screening (`content-check.js`) only runs on the transcript, *after* transcription. There is no way to keep protected-class-adjacent speech from reaching the speech-to-text vendor first — audio can't be pre-screened the way text theoretically could. This is likely unavoidable given the shape of any transcription pipeline, not a flaw specific to this design, but it means the STT vendor is the first recipient of the raw conversation that has had zero Fair Housing or sensitivity screening applied to it. Worth naming as an accepted exposure, contingent on the vendor's DPA terms (no retain/no train) actually holding, rather than a risk this design eliminates.

### 8. Store the transcript, not the audio

**Decision: keep the transcript text (needed for complaint detection, human review, and Fair Housing screening); do not keep a second permanent copy of the raw audio.** Reasoning: Aircall already holds the audio (that's where this build fetches it from in the first place) — a second, permanent copy in Rincon's own storage would be a new, larger, more sensitive data footprint (actual recorded voice, playable, of real tenants and owners) for no confirmed benefit, matching this codebase's repeated "don't store more than the confirmed need requires" discipline (`call_stats` storing sums not per-call rows; `call_stats_line_misses` deliberately omitting the caller's raw phone number). The audio is fetched into memory, sent to the transcription vendor, and discarded once a transcript comes back — never written to disk or object storage by this build. If Peter later wants a permanent, playable audio archive (a real, bigger decision — legal hold, storage cost, a much larger privacy footprint), that is new scope requiring its own review, not something this design quietly leaves room for.

**This "no audio at rest" rule is a build requirement, not just a happy-path description, and it has to extend past the main flow:** "the audio isn't written to disk" is only true if it's also never written to an application log, an exception/error trace, or a retry or dead-letter queue if the speech-to-text call fails — in practice, that is exactly where "audio at rest" actually leaks in a real system (a `catch` block that logs its input for debugging, or a retry job that persists the failed payload so it can be replayed). `content-check.js`'s own header already states the equivalent rule for claim text — "never log the flagged text itself, only the category." This document states the analogous rule for this build, explicitly, as something Q must build to, not something Sentinel discovers missing in a post-hoc code review: **raw audio bytes are never written to a log line, an error/exception record, or a persisted retry queue, at any point in this pipeline.** If a speech-to-text call fails, the retry path re-fetches the audio from Aircall's presigned URL (still live within its window) rather than persisting the failed audio anywhere in Rincon's own systems.

### 9. Governance path — this is a real compliance build, unlike `call-stats`

Checked plainly against CLAUDE.md's three triggers, the same way `call-stats/SPEC.md` checked itself and correctly concluded "no":

- **Does this store someone's personal information?** Yes, unambiguously — this is real recorded speech from tenants and owners, the single most sensitive data category yet introduced into this schema, a different and harder case than `call-stats`'s own employee-performance-data conclusion.
- **Does this make or influence a decision about an applicant or tenant?** Not directly — same as email, this build classifies and routes, it never approves/denies/scores anyone. But it does read the actual content of real tenant and owner conversations for signal, including content that could contain protected-class information (health mentions, familial status, disability, source of income) spoken out loud rather than typed — squarely the territory the Fair Housing Standard and Rule 9 exist to govern.
- **Does this ever send a message to a tenant or owner?** No — same as every piece of this scoped so far, this reads and classifies, it does not communicate.

**Conclusion: this needs both Asimov and Mason before it ships** — the same standing rule already applied to every other content-reading build this session (Missive email intake, the maintenance content check, the complaint tracker itself). Unlike `call-stats`, this is not a case where GOVERNANCE.md simply doesn't speak to the risk category — it speaks to it directly (Rule 9, the Fair Housing Standard, Rule 1's audit-log requirement for AI decisions). GOVERNANCE.md Rule 4 (data inventory) also applies in full — see below.

---

## Proposed Data Model (for Neo to finalize, once `complaint-tracking-v1-scope.md`'s own tables are real)

Sketch only — Neo owns the real shape. Two new pieces, additive:

```
call_transcripts
  id                        UUID PK
  aircall_call_id           TEXT NOT NULL UNIQUE   -- Aircall's own call ID; the
                                                    -- real dedupe/idempotency key
                                                    -- for a webhook or sweep that
                                                    -- might see the same call twice
  aircall_user_id            TEXT                   -- nullable — a call.user:null
                                                    -- recording (shared-line, per
                                                    -- call-stats's own confirmed
                                                    -- "unattributed" case) should
                                                    -- still be transcribed and
                                                    -- checked, just with no staff
                                                    -- attribution, same posture as
                                                    -- call_stats_line_misses
  staff_email                 TEXT                  -- nullable, same reason
  direction                    TEXT NOT NULL CHECK (direction IN ('inbound','outbound'))
  call_date                     DATE NOT NULL        -- Pacific business day, same
                                                     -- rule and same reasoning as
                                                     -- call_stats.call_date — reuse
                                                     -- lib/timezone.js, don't
                                                     -- reimplement it
  recording_duration_seconds     INTEGER
  transcript_text                 TEXT               -- the actual transcript; the
                                                     -- most sensitive column in this
                                                     -- table, see Data Inventory
  stt_vendor / stt_model_version    TEXT             -- which vendor + model produced
                                                     -- this transcript — needed the
                                                     -- same way terms_version is
                                                     -- needed on maintenance_claims,
                                                     -- so a later accuracy question
                                                     -- can be traced to a specific
                                                     -- vendor/model, not guessed at
  fair_housing_flagged             BOOLEAN
  fair_housing_category             TEXT             -- checkClaim()'s own output
                                                      -- shape, reused as-is
  fair_housing_matched_layer         TEXT
  complaint_id                        UUID           -- FK into whatever
                                                      -- complaint-tracking-v1's own
                                                      -- table turns out to be called
                                                      -- — NULL if this transcript was
                                                      -- read and judged routine
                                                      -- (still tracked, never surfaced)
  status                                TEXT          -- pending / transcribed /
                                                      -- screened / classified / error
                                                      -- — a real state machine, since
                                                      -- this pipeline has more steps
                                                      -- than any prior sync in this
                                                      -- schema and any one step can
                                                      -- fail independently
  created_at / updated_at                TIMESTAMPTZ
```

**Not proposed here, deliberately:** an `audio_url` or `audio_storage_path` column — per Design Decision 8, no audio is kept past the transcription step, so there's nothing to point one at.

**Open, unresolved by this sketch, matching this document's own "don't guess it, flag it" discipline:** exactly how `complaint_id` links to `complaint-tracking-v1-scope.md`'s own eventual schema can't be nailed down until that system's real tables exist — Neo should design both together, or design this one second, not guess at a foreign key into a table that doesn't exist yet.

---

## Data Inventory (GOVERNANCE.md Rule 4)

- **`pii_fields`:** `call_transcripts.transcript_text` — the actual words of a real recorded conversation involving a tenant, owner, or staff member; the single most sensitive field this schema has ever held. `staff_email` / `aircall_user_id` (when present) identify a specific Rincon employee, same as `call_stats`. Once matched to a subject via the complaint system, the linked complaint record may additionally identify a specific tenant or owner — that identification lives in the complaint system's own tables (Neo's call there, per `complaint-tracking-v1-scope.md`), not duplicated here.
- **`agents_with_access`:** the phone-intake sync process (system, service-role key); the third-party speech-to-text vendor (contractually, per Design Decision 7 — a data-processing relationship, not open access); Claude, via the Anthropic API, reading transcript text for classification (same pattern already used for `extract-claims.js`); any Hub user with access to the complaint-tracking tool (role/permission model TBD by that system, inherited here, not reinvented).

  **Named plainly rather than left as an aside: this is currently an undesigned dependency, not a settled answer.** The proposed `call_transcripts` table (below) has no `property_id` or `owner_id` column of its own — only a nullable `complaint_id` FK into a system that doesn't exist yet. That means Rincon's "one owner's data isn't visible to another owner" access requirement rests entirely on whatever scoping `complaint-tracking-v1-scope.md`'s own system ends up building, inherited here rather than reinvented. That's a reasonable choice not to duplicate access control in two places, but until that system's real access model exists, this table's real-world access scoping is not actually designed — it's deferred. Neo and Asimov should confirm the inherited scoping is actually sufficient once both schemas are real, not assume it by default.
- **`privacy_category`:** recorded conversational content involving tenants, owners, and staff — genuinely new to this schema, more sensitive than `call_stats`'s employee-performance metadata (Fair Housing–relevant by nature of the content, not just employee-privacy-relevant) and more sensitive than email intake's written correspondence (actual voice, actual spoken words, potentially disclosing health/familial/disability information incidentally, the way a phone conversation naturally can).
- **`retention_policy`:** **OPEN — Peter's decision, not assumed.** Unlike `call-stats`, where Peter explicitly chose indefinite retention for employee call metadata, this is a materially different and more sensitive category (real tenant/owner speech, transcribed) and should not inherit that precedent by default. A shorter retention window (e.g., transcripts purged after N months once any linked complaint is resolved and closed) is a real option worth Peter's explicit choice, not a technical default.
- **`ccpa_exportable` / `ccpa_deletable`:** Likely **TRUE** for both, on the same reasoning already applied to `call_stats` (California's expired employee-data CCPA exemption) plus the much clearer case that a tenant or owner — an actual consumer under CCPA, not an ambiguous employee-data edge case — is very likely to have rights over a transcript of their own recorded call. Needs Mason and real counsel confirmation before treated as settled, flagged here rather than asserted. **If confirmed deletable, `call_transcripts` needs its own GOVERNANCE.md Rule 10 cascading-delete hook** (a `handleCCPADelete` entry, or an explicit hand-off into whatever cascade `complaint-tracking-v1-scope.md`'s own system builds for the linked complaint) — not assumed to happen automatically just because the CCPA columns are marked true.
- **RLS:** enabled, no permissive policies at creation — matches every table in this schema.
- **Audit logging:** **Required, unlike `call_stats`.** This is not a plain arithmetic sync — it's an AI interpretation of sensitive source material producing a decision-adjacent output (a complaint classification, a Fair Housing flag), the same category `maintenance_claims` and the Missive intake pipeline already write `audit_log` entries for under GOVERNANCE.md Rule 1. Every classification, every Fair Housing flag, and every match-to-subject decision should be logged the same way, with the same "never log the flagged text itself, only the category/matched_layer" discipline `content-check.js`'s own header already documents for claims.

---

## Rough Build Size

Larger than `call-stats` (no AI, no content) and comparable to or larger than `complaint-tracking-v1-scope.md`'s own email side, plus a genuinely new piece (audio handling, a speech-to-text vendor integration) neither of those builds needed:

- **Neo:** ~1–2 sessions — `call_transcripts` (or equivalent) table, once the complaint system's own schema is real enough to link against; likely a second small pass once that dependency resolves.
- **Q:** ~3–4 sessions — Aircall recording fetch + webhook handling (or nightly-sweep fallback) + the new speech-to-text vendor integration + wiring the existing `content-check.js` and the (not-yet-built) complaint-classification prompt against transcript text instead of claim text.
- **Tron:** ~0.5–1 session — likely just a transcript view inside the complaint tool's own existing detail page, plus the "X of Y calls had a recording" coverage note; no new dedicated dashboard expected.
- **Asimov + Mason:** a real review, not a formality — new content type, new third-party data recipient (the STT vendor), a two-part CIPA question this document explicitly did not resolve (Design Decision 7), and a Fair-Housing-visibility question this document also left open rather than inherited by default (Design Decision 5, Open Item 9).
- **Sentinel:** should independently confirm the "no audio at rest" design (Design Decision 8) is actually what the code does, and review the STT vendor's own data-handling terms once one is chosen (Open Items).

---

## Open Items — Needs Deciding or Verifying Before This Gets Built

1. **What actually controls whether a call gets recorded** — line setting, per-agent manual toggle, or something else. Not understood even by Peter tonight. Needs a real answer before anyone can reason about whether/how to expand coverage.
2. **Whether Peter wants recording expanded to the other lines**, and the real consent-disclosure question that comes with it. Peter has stated Aircall's *existing* recorded calls are already California two-party-consent compliant via an existing disclosure — this document does not assume that same disclosure automatically covers a newly-recorded line; that needs its own confirmation if recording is ever expanded, not assumed to carry over.
3. **Aircall's real webhook payload shape** for "call ended, recording available" — described secondhand by Aircall support, not yet checked against a live payload from Rincon's account.
4. **Minimum call-duration filter** — whether every recorded call gets transcribed, or only ones above some length. Not yet decided; a real design choice with a real cost/signal tradeoff (Design Decision 3's cost figures assume some filtering, not "every recorded second").
5. **Speech-to-text vendor selection** — AssemblyAI, Deepgram, and OpenAI's transcribe models were researched for pricing (Design Decision 3) but none has been chosen. The choice should weigh accuracy on real Rincon audio (accents, cell/landline quality, background noise) as much as price, and must include confirming the vendor's own data-retention/training terms match Design Decision 7's architecture before any real Rincon audio is sent to it.
6. **This build's own dependency on `complaint-tracking-v1-scope.md` actually shipping** — stated in the Origin section above, repeated here as a real sequencing risk, not just a footnote: this document cannot be finalized into a real schema until that system's own tables exist.
7. **CIPA confirmation specific to recorded audio and a third-party transcription vendor — two separate questions for counsel, not one.** Design Decision 7 extends an email-specific counsel opinion to audio by analogy, and that extension needs its own real confirmation before this ships. Specifically: **(a)** does the existing recording disclosure's *consent to record* also cover this build's new *use* of that recording — automated third-party transcription plus AI-driven complaint and Fair Housing analysis — under Penal Code §632? A "this call may be recorded" notice given for quality/training purposes is not obviously sufficient notice for "this call's audio will be sent to an outside AI vendor and analyzed to generate a tracked complaint record." **(b)** is routing that recording's audio through a contracted third-party transcription processor itself defensible under an interception theory, closer to §631 — the actual question counsel's Section 5 opinion analyzed, for email? Both are real, unresolved questions worth putting to counsel; this document does not attempt to answer either on Oracle's own authority.
8. **Retention window for transcripts** — flagged in the Data Inventory above as Peter's decision, not resolved here.
9. **Whether "fully visible, tagged" is the right Fair-Housing-flag policy for a verbatim audio transcript, or whether Mason should apply the tiered-access model instead** — Design Decision 5 currently inherits email's "never hidden, only tagged" rule, but `compliance/owner-tenant-notes-outside-counsel-opinion.md` Section 4 recommends a sanitized-view-plus-authorized-reviewer tier for exactly this kind of flagged content, and a raw phone transcript carries more incidental protected-class exposure than a written note. This document does not resolve that trade-off on its own — Mason should decide it specifically for audio, not by default inheritance.
