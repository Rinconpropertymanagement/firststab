# Archive Search — Owner Risk Acceptance: Removing the Keyword-Based Layer 1 Check

**This is an owner risk-acceptance document, not a governance or legal
clearance.** Asimov and Mason have not reviewed this specific change.
Outside counsel has not reviewed this specific change.

**Correction (2026-09-12, found by Q reading GOVERNANCE.md directly before
building anything, before Peter's signature below was acted on):** an
earlier version of this paragraph claimed GOVERNANCE.md Rule 6 itself makes
its three prongs "independently waivable with recorded reasoning." That is
not what Rule 6's actual text says. Rule 6 states plainly, for Critical-tier
changes: "owner approval + attorney review for compliance changes + 7 days
shadow mode" — all three, not owner's choice of which to skip. Every
same-day precedent where shadow mode was waived (the wide-net prefilter,
the escalation mechanism) involved Asimov actually reviewing that specific
case and agreeing the waiver was sound — not a bare assertion that the rule
permits owner override unilaterally. This document should not have implied
otherwise, and Q correctly refused to build against the original wording.

What this document actually records is narrower and more honest: Peter,
as owner of Rincon Management, is choosing to accept this risk and proceed
notwithstanding Rule 6 normally calling for attorney review on a
Critical-tier compliance-logic change — not because Rule 6 authorizes
skipping it, but because it is his company and his legal exposure to
accept. That is a real prerogative an owner has; it is different from
claiming the governance framework itself blesses the shortcut, and this
document should say which one is actually happening.

## What is being changed

Archive search's Fair Housing screening currently combines two independent
checks before deciding whether a conversation is `flagged_protected_class`
or `clear` (`handleNonHeldConversation()` in
`projects/hub/archive-search/lib/screening-pass.js`, via `checkClaim()` in
`projects/hub/maintenance-history/lib/content-check.js`):

- **Layer 2** — the AI self-report question, recalibrated today
  (`compliance/archive-search-self-report-recalibration-outside-counsel-opinion.md`)
  to flag adverse/differential treatment, unresolved accommodation
  requests, or discriminatory preference/steering language — not mere
  mention of a protected characteristic.
- **Layer 1** — a pre-existing keyword scanner
  (`maintenance-history/lib/protected-class-terms.js`, via `checkClaim()`'s
  Tier A/B logic), unchanged by today's work, that flags immediately on
  matching most protected-class-related terms found anywhere in the
  conversation text, regardless of context. The two layers are OR'd
  together — either one flagging is sufficient to flag the conversation.

Real production testing tonight showed Layer 1 is still flagging most
wide-net-matched conversations on its own, largely negating today's Layer
2 improvement for archive search's real-world flag rate — this is what
this document proposes to change.

**The proposed change:** archive search stops calling `checkClaim()`
(Layer 1 + Layer 2 combined) and instead makes its `flagged_protected_class`
determination from Layer 2 (the recalibrated self-report) alone.

**Scope — archive search only.** This does not modify
`content-check.js`, `protected-class-terms.js`, or `checkClaim()` itself.
Every other tool that calls `checkClaim()` — complaint-tracking,
maintenance-history, approval-briefing, owner-tenant-notes, and
leadsimple-property-brain — is unaffected and keeps both layers exactly as
they work today.

## Why this isn't simply covered by today's outside-counsel opinion

Raised directly by Claude, and worth recording honestly rather than
glossing over: the question sent to outside counsel today
(`compliance/archive-search-self-report-recalibration-attorney-question.md`)
described archive search's Fair Housing check as a single mechanism — the
self-report question. Counsel was never told a second, independent
keyword-based layer exists and also drives the same decision. His approval
of a conduct-based standard over a mention-based one cannot have been
evaluating whether to remove a layer he did not know was there.

## Peter's basis for proceeding anyway, and his decision

Peter's position, verbatim: **"i am accepting the potential risk of
removing it from this tool. write it up and i will sign it. its in line
with the spirit of all 4 written legal opinions from our counsel."**

Peter's reasoning, as he's stated it across today's four written opinions
(the original Fair Housing design opinion, and today's self-report
recalibration opinion, both real and on file in `compliance/`) is that
counsel's *general legal position* — that mere mention or knowledge of a
protected characteristic is not itself a Fair Housing concern, and that the
actual legal question is what was done, decided, or communicated because of
that characteristic — is not specific to one AI prompt's wording. Layer 1's
current design (flag on keyword match, no context) is the same
"mention-equals-concern" standard counsel's opinions repeatedly say the law
does not require. Peter is accepting, as owner, that this general
reasoning extends to Layer 1, without a fifth written opinion confirming it
in those specific terms.

## The real, honest risk being accepted

Stated plainly, not minimized:

- Layer 1 is a hard, unconditional keyword backstop with no judgment
  involved — it cannot be fooled, distracted, or wrong about content it
  doesn't understand, because it does no interpretation at all. Layer 2 is
  an AI judgment call. Removing Layer 1 means archive search's Fair
  Housing determination rests entirely on Layer 2's judgment, with no
  independent second check.
- Layer 2's fail-closed behavior (any network error, timeout, or
  unparseable response defaults to `flagged: true`) still provides a
  backstop against *infrastructure* failures, but not against a case where
  Layer 2 runs successfully and simply reaches the wrong conclusion on
  content Layer 1's keyword match would have caught regardless.
- **Correction:** an earlier version of this section cited tonight's
  category-string finding (many categories joined into one field on
  real flagged conversations) as evidence Layer 2 "already misbehaves under
  real load." That's not accurate — the actual diagnosis (recorded earlier
  in this session) is that the garbled category string is Layer 1's own,
  unchanged behavior (it collects every matched category across the whole
  thread and joins them), not a sign of anything wrong with Layer 2. This
  document should not have used that finding as supporting evidence for
  the risk being accepted.
- `content-check.js`'s own header comment (not GOVERNANCE.md Rule 9
  itself) describes this two-layer check as run "on every candidate claim
  before insert, no exceptions." Rule 9 itself
  ("Never Use Protected Class Data in Decisions") does not name this
  specific two-layer mechanism. This document is the recorded exception to
  that file's own stated convention, made by the owner for archive search
  specifically — not a claim that GOVERNANCE.md Rule 9 itself was
  satisfied or waived.
- Asimov and Mason have not confirmed this specific change resolves
  cleanly, and were not asked to before this document was written — Peter
  has chosen to proceed on his own authority rather than wait for that
  review.

## What happens next

Once signed, this document authorizes Q to build the change (archive
search calls `selfReportFairHousingContent()` directly for its
`flagged_protected_class` determination, no longer calling `checkClaim()`),
Neo/Q to bump `SCREENING_VERSION` again and write a Rule 6 audit_log entry
citing this document by name, and TARS to verify the change against real
data before it runs against the rest of the archive. Asimov and Mason will
still be told this happened and shown this document — this is a
transparent owner override, not something hidden from them after the
fact.

---

## Signature

**I have read this document, understand the risk described above — that
this removes an independent keyword-based safeguard for archive search
specifically, resting Fair Housing screening on the AI's judgment alone —
and accept that risk as owner of Rincon Management.**

Signed: Peter McKenzie — confirmed in chat, verbatim: "i confirm"
Peter McKenzie, Owner, Rincon Management
Date: 2026-09-12
