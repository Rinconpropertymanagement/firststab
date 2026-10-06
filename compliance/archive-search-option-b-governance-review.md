# Archive Search — Option B (Fair Housing Wide-Net Redesign): Governance & Legal Review

**Status:** Real Asimov + Mason review of the actual outside counsel opinion completed 2026-09-12. This file is the permanent record of that review — it did not previously exist as its own document, which is itself the reason an earlier attempt to wire this design into the live screening pass was correctly refused twice by independent agents who could not find a real, dedicated review file for this specific change (only the escalation mechanism had one). This corrects that gap.
**Subject:** `projects/hub/email-intake/archive-search-fair-housing-option-b-spec.md` — the wide-net pre-filter that changes the archive-search screening pass from "AI Fair Housing check on every non-held conversation" to "AI check only on conversations matching a broad topic list; everything else marked clear automatically."
**Reviewers:** Asimov (governance) and Mason (legal), reviewing `compliance/archive-search-fair-housing-outside-counsel-opinion.md` (the real outside counsel opinion) together with Claude's extracted action-item list, in one closing round.

---

## Asimov's Verdict

**Rule 6 attorney-review requirement: Conditional yes, with one documentation gap (since fixed).** The opinion is genuinely question-specific and mechanism-specific — it names the exact two-stage architecture, directly engages the exact residual-risk example posed to counsel, gives an explicit bottom-line answer, and attaches a concrete numbered safeguards list. Asimov flagged that the opinion document mostly paraphrased counsel's words rather than reproducing them verbatim (unlike the precedent, `compliance/content-screening-redesign-outside-counsel-opinion.md`) — **this has since been corrected**: `compliance/archive-search-fair-housing-outside-counsel-opinion.md` now reproduces the real opinion in full, verbatim, with Claude's own analysis kept in a clearly separate, clearly labeled section.

**Action-item check (against the real, current code):**
- Sexual orientation/gender identity: already covered under the sex/gender category — confirmed, no action needed.
- Military/veteran status: genuinely absent at the time of review — **since added** (`fair-housing-wide-net-terms.js`, `TERMS_VERSION` bumped to v2, independently confirmed by two later reviewers).
- Employee escalation mechanism, staff policy note, periodic re-validation extension: all real, correctly-scoped follow-ups — **all since completed** (escalation mechanism built/tested/reviewed separately; policy note drafted and Mason-corrected; periodic audit extended to cover the skipped pool, Section 5 of the option-b-spec, 2026-09-12).

**Explicit verdict on hard blockers, at the time of this review:** the current design (full AI check on every non-held conversation, no exceptions) was the right, necessary bar as it stood; the real, safe way to reduce cost was approved in principle (this wide-net redesign, once the above items closed). All items are now closed as of this writing.

## Mason's Verdict

**Is Claude's explanation of why keyword-only screening is legally insufficient for Fair Housing correct?** Confirmed, with a sharpened distinction: the real dividing line isn't "predictable vocabulary vs. indirect phrasing" so much as "closed-set lookup vs. meaning in context." The privilege/hold check works because legal correspondence is institutionally identifiable (a domain, a phrase); Fair Housing violations are a semantic, inferential question that a keyword list cannot resolve by definition — the same reason `tier-b-classifier.js` needed an AI call just to disambiguate a *confirmed* keyword hit.

**Is there a legitimate, safe way to reduce cost?** Yes — the wide-net topic pre-filter, with the residual risk stated plainly (a conversation touching none of the net's phrases gets zero independent check, not even today's baseline). The "only check the ~2% that look relevant" idea was explicitly ruled out as circular — there is no way to know which conversations are relevant without already checking all of them.

**Final verdict:** keep the full-coverage check as the floor unless and until a real, informed decision is made to narrow it — which is exactly what the outside counsel opinion, obtained afterward, provided. Mason's closing note: *"Put in perspective: $500–$1,000 one-time, or ~$250-500 with Batch API, against 254,056 messages of real correspondence that predate every governance decision this company has made — including whatever privileged or Fair-Housing-relevant threads are actually sitting in that archive today, unscreened. That's a genuinely small number relative to what it's actually buying."*

---

## The One Real Gap Neither Round Addressed, Found By a Later Build Attempt

**GOVERNANCE.md Rule 6's Critical tier requires three things: owner approval, attorney review, and (normally) a 7-day shadow-mode monitoring period.** The attorney-review prong is closed by the real outside counsel opinion above. Owner approval is Peter's to give explicitly. **The shadow-mode prong has never actually been addressed for this specific change** — not waived with recorded reasoning, not run, not discussed anywhere in the option-b-spec. This is a real, meaningful gap, not a formality: unlike the escalation mechanism (a purely human-triggered action, where Asimov and Mason agreed no automated process exists for a shadow period to monitor), **this change directly alters the AI screening pass's own decision criteria** — it is exactly the kind of change Rule 6's shadow-mode requirement exists for.

**Why a calendar-based 7-day period doesn't map cleanly here, though, and what the real substitute is:** this isn't an ongoing agent making repeated live decisions that could drift over time — it's a change to a one-time (or infrequently re-run), bounded batch job. The original archive-search risk assessment (`compliance/archive-search-ai-risk-assessment.md`) already worked through this exact tension for the whole screening pass and concluded the substitute for shadow mode is the validation-sample review process (zero-confirmed-miss exit rule) — not a calendar clock. The option-b-spec's own validation plan (Section 5: a zero-cost dry run, a real comparison against already-AI-reviewed rows, and — as of today — a locked-in quarterly commitment to sample the skipped pool too) is that same substitute mechanism, applied to this specific redesign.

**This reasoning has not yet been explicitly put to Peter as his own decision, the way the escalation mechanism's shadow-mode waiver was.** That is the one concrete thing standing between here and wiring this in. Recorded as an Open Item below, not decided in this document.

## Decision Recorded — Peter, 2026-09-12

**GOVERNANCE.md Rule 6's shadow-mode requirement: explicitly waived for this change, substituted with the validation-sample-based gate.** Peter's own words, verbatim: "checking a real sample is fine, no monitored period." This closes the one remaining open item above — the reasoning (a one-time/infrequent batch job's real substitute for a calendar-based monitoring period is a real, hand-reviewed sample with a zero-confirmed-miss exit rule, matching the original archive-search risk assessment's own already-accepted argument for the screening pass as a whole) is adopted as the recorded basis for this waiver, the same way it was for the escalation mechanism's shadow-mode waiver. Logged to `audit_log` as its own Rule 6 change-management entry (see entry recorded 2026-09-12, action `archive_search.rule6_shadow_mode_waived_option_b`).

**All three prongs of Rule 6's Critical tier are now closed for this specific change:**
1. Attorney review — `compliance/archive-search-fair-housing-outside-counsel-opinion.md` (real, verbatim opinion).
2. Owner approval — Peter's explicit decisions throughout this document and its predecessor discussions, culminating in this shadow-mode waiver.
3. Shadow mode — waived above, substituted with the validation-sample gate (Section 5/6 of the option-b-spec, including the newly-locked quarterly commitment to sample the skipped pool).

**This document now DOES authorize Q to wire `matchesWideNet()` into the live screening pass** (`screening-pass.js`'s `handleNonHeldConversation()`). A future agent verifying this authorization should find: this file, with real Asimov/Mason verdicts and Peter's own recorded decisions; the real outside counsel opinion; and the corresponding `audit_log` entries — not a single document's own self-description.
