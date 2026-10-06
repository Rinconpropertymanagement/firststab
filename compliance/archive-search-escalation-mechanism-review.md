# Archive Search — Escalation Mechanism: Governance & Legal Review

**Status:** Reviewed and cleared to build. Not yet live — see the migration-order note at the bottom.
**Subject:** `projects/hub/email-intake/archive-search-escalation-mechanism-spec.md` — the employee escalation path (safeguard #5 of `compliance/archive-search-fair-housing-outside-counsel-opinion.md`).
**Reviewers:** Asimov (governance) and Mason (legal), in two rounds — an initial design review, then a closing review after Peter recorded two explicit decisions.
**Written by:** Claude, consolidating both real review rounds into one durable record — this project's own established convention (see `leadsimple-fair-housing-review.md`, `approval-briefing-fair-housing-review.md` for the pattern) that a real governance/legal review gets its own file, not just a mention inside a migration's comments.

---

## Round 1 — Initial Design Review

**Asimov's verdict:** NOT APPROVED ❌ — not yet, but close. Design itself (schema, human-only audit trail, reuse of existing mailer/CI-guardrail/admin-role patterns, deliberate restraint against inventing new infrastructure) was sound and precedent-accurate. Two real gaps found:
1. The spec never classified itself under GOVERNANCE.md's own Rule 6 (Critical tier — a compliance-logic/guardrail change to `missive_message_intake_search_safe`) or stated a position on the normal 7-day shadow-mode requirement.
2. Peter needed to resolve who actually receives the escalation notification — the spec defaulted to `DO_EMAIL` alone as the best available real infrastructure, but flagged this as Peter's decision to confirm, not something to assume.

**Mason's verdict:** FLAGGED ⚠️ — design legally sound, matches counsel's actual Section 7 rule correctly in both directions (not broader than "report real concerns," not narrower than "any employee, not just admins"). Real open items, none defects: no SLA/staleness backstop on an open report sitting unreviewed, a second reporter's reasoning is silently dropped on a 409, and `DO_EMAIL` alone might not obviously satisfy counsel's "designated manager/compliance person" language.

## Peter's Decisions, 2026-09-12

Recorded in the spec itself ("Decisions Recorded" section) before the closing review:
1. **Notification recipient: both `DO_EMAIL` and Peter's own email**, not a choice between them.
2. **GOVERNANCE.md Rule 6's 7-day shadow-mode period: explicitly waived**, on the stated reasoning that this mechanism only ever acts on a deliberate human click (report or resolve) — no automated decision path exists for a shadow period to monitor.

## Round 2 — Closing Review

**Asimov's verdict:** CLEARED FOR NEO AND Q TO BUILD ✅. Confirmed the dual-recipient decision raises no governance objection (two recipients is lower-risk than one, not higher). On the shadow-mode waiver: agreed the *outcome* is correct, but sharpened the *reasoning* — the real basis isn't "no automated decision path" alone (a bug in the exclusion logic still has real exposure regardless of who triggered the write), it's that this mechanism never touches `screening_result`/the AI's own decision criteria, the same category as the already-shipped, never-shadow-moded `maintenance_claims.clear_flag` precedent. Attached three conditions, carried into the build, none blocking Neo/Q from starting:
- Use the "doesn't touch decision criteria/screening logic" framing as the recorded reasoning, not "no automated path" alone (reflected above).
- Fold a concrete spot-check into the first 1–2 weeks of real use (confirm a real report actually excludes a conversation, a real false-alarm resolution actually restores it) — the substantive thing a shadow period would have bought, done as verification rather than a calendar clock.
- **Log the waiver itself to `audit_log` as its own Rule 6 change-management entry** (previous position: Critical/7-day; new position: waived, with the corrected reasoning). **Not yet done — see Outstanding Items below.**

**Mason's verdict:** FLAGGED ⚠️, both specifically-asked-about gaps closed:
- Dual-recipient email genuinely resolves the "designated manager/compliance person" question — Peter is unambiguously within that language for his own company.
- The shadow-mode reasoning is sound, not a rubber stamp — Rule 6's shadow-mode requirement exists to catch automated-process drift, and there is no automated process here.
- **One new item surfaced, not previously flagged:** Rule 6's Critical tier has three parts — owner approval, attorney review, and shadow mode. Peter's decision closes the shadow-mode part and, as owner, the owner-approval part. **It does not, by itself, close the attorney-review part.** The original outside-counsel opinion blessed the general concept of an escalation mechanism (safeguard #5), but did not review this specific implementation's own design choices (structural pull-before-review, the full 8-person reporting population, no rate limit, no second-approver) line by line. Mason cannot close this himself (not a licensed attorney) and named two ways to close it: (a) a short confirmation from actual outside counsel that this specific implementation reasonably satisfies safeguard #5, or (b) Peter making the same kind of explicit, on-the-record call he made for shadow mode — "the original opinion's Section 7 language covers this implementation, no fresh counsel sign-off needed." Mason was explicit this is a paperwork/process step, not a reason to stop the build.

Also answered, in Round 2, the three Mason questions the spec itself had posed:
- Immediate structural exclusion on report (not a lighter "flag but stay visible" default): concurred.
- Full searcher+admin population able to report, no rate limit: concurred.
- Litigation-hold interaction on a "confirmed" resolution: correctly left as a separate, existing human process — recommend only a one-line reminder to whoever handles litigation holds, not new code.

---

## Outstanding Items — Resolved 2026-09-12

1. ~~The Rule 6 audit-log entry Asimov required has not actually been written.~~ **Done.** A real, permanent `audit_log` entry (`action: archive_search.rule6_shadow_mode_waived`) recording the previous position (Critical/7-day shadow mode), the new position (waived), and Asimov's own corrected reasoning was written directly to the live database, 2026-09-12 — `entity_id: 585a3225-c821-4285-9bf5-365ee7c308e9`, `sequence_num: 265726`, correctly hash-chained by the existing trigger. This is the formal record Rule 6 requires; it is not just a comment in a spec or migration file.

2. **Mason's attorney-review prong — closed by Peter's own documented call, not a fresh counsel confirmation.** Peter's explicit, on-the-record decision, 2026-09-12: **the original outside counsel opinion's Section 7 language ("provide an employee escalation mechanism... if a search result appears to contain a material Fair Housing concern, the employee should stop relying on that information... and escalate") reasonably covers this specific implementation (immediate structural exclusion on report, the full 8-person reporting population, `DO_EMAIL` + Peter as the notification recipients, admin-only resolution) — no fresh counsel sign-off is being sought for this specific implementation.** This matches option (b) Mason offered in the closing review, and is the same kind of explicit ownership Peter already exercised for the shadow-mode waiver above. Recorded here as the permanent paper trail; not logged separately to `audit_log` since it is a legal-provenance decision about documentation, not a change to any system's live behavior.

3. **Two real design findings from testing, needing Peter's explicit yes/no (not defects) — still open:**
   - A `confirmed` escalation can never be re-escalated by anyone, ever — permanent by design, the same way a `held` conversation is. Confirm this is intended.
   - The "already reported" error a second reporter sees is a generic 404 in normal sequential use (the specific 409 only fires on a true simultaneous race) — cosmetic message-clarity issue only; the underlying protection against duplicate reports is solid either way.

## Round 3 — Real Legal/Governance Review of the "Reopen a Confirmed Escalation" Mechanism

**Context:** after Round 2 shipped, Peter decided a `confirmed` escalation should be reversible (resolving Outstanding Item #3 above) — see `supabase/migrations/20260912050000_reconcile_20260912040000_timestamp_collision.sql` for the resulting design (reopened_at/reopened_by/reopen_reason columns, modeled on `archive_search_flagged_overrides`'s already-cleared revocation pattern). An earlier attempt to treat this as a quick confirmation of that precedent was itself correctly refused — Asimov and Mason both found a real, substantive difference this section now records properly, in full, so it stops being lost between conversation turns and separate agent runs.

**Asimov's verdict, in full:** NOT APPROVED as a quick confirmation. The column shape and CHECK-constraint discipline transfer cleanly from `archive_search_flagged_overrides`; the risk analysis does not, because the two mechanisms move in opposite directions. Revoking an override **reduces** exposure (undoes an AI false positive being made searchable) — Mason built that path specifically because the *grant* was the risky action. Reopening a confirmed escalation **increases** exposure — it re-exposes correspondence a human admin already determined was a real Fair Housing concern, to the same up-to-8-person population, with no further check. Structurally, reopening mirrors the *original override grant* (the action Mason scrutinized hardest), not the revocation built to contain it. Three concrete gaps followed from that inversion: (1) the same admin who confirmed could unilaterally reopen it later with only a free-text reason, no second check; (2) Round 2's own litigation-hold answer ("a one-line reminder is enough") was reasonable when `confirmed` meant *permanent* — a reopen mechanism reintroduces exactly the scenario that reminder existed for, and it was never re-checked against this new capability; (3) Round 2 treated "should confirmed be reversible" as an open *product* question for Peter, not a compliance question already cleared — his "yes, make it reversible" answered the product question, not a safeguards question.

**Mason's verdict, in full:** FLAGGED ⚠️ — do not apply the reopen capability for real use as originally designed. Concurred with all three of Asimov's gaps. Two concrete, required changes, both confirmed cheap given the existing schema:
1. **A different admin must reopen than the one who confirmed** — enforce `reopened_by IS DISTINCT FROM resolved_by`, at the database level, in the same CHECK constraint pattern this table already uses. Mason's own words: "I'd treat this as close to a floor requirement, not a nice-to-have."
2. **The litigation-hold reminder must become a real, captured step in the reopen action itself, not a passive SQL comment.** Mason's own words: "require the reopen action to capture a structured attestation ('I confirmed with Peter this conversation is not under an active litigation hold') as part of `reopen_reason`... not as a separate unenforced reminder" — implemented as its own required, separate field, not buried in general reason text.

Mason explicitly said a mandatory cooling-off period is *not* required once the two changes above are in place, and that a fresh outside-counsel sign-off is *not* needed if these two concrete fixes are adopted (only if Peter instead wanted to rely on "a reminder is enough" without them).

**This Round 3 finding is the real, documented basis for building the two safeguards described in this file — any future build against this mechanism should cite this section, not a migration comment alone.**

---

## Build Status

Schema, routes (report/resolve/export), and the dual-recipient email are built and tested (86 static tests + 20 real integration tests, all passing; CI raw-table-access guardrail clean). Judge's verdict: CONDITIONAL ✅ — safe to leave staged. **Nothing here is live.** Two migrations need to be applied, in this specific order (the second references a table the first creates):
1. `supabase/migrations/20260912010000_archive_search_flagged_overrides_schema.sql`
2. `supabase/migrations/20260912030000_archive_search_escalations_schema.sql`

Both via Supabase's SQL Editor, as always — Peter applies migrations himself.
