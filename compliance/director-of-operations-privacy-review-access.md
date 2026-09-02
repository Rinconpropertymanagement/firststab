# Director of Operations — Needs Privacy Review Access

**Status:** Final — a written record of a decision that was otherwise only going to live inside chat history and code comments. This document exists for the same reason `compliance/leadsimple-fair-housing-review.md` gives for its own existence: findings and a conditional approval that only ever lived paraphrased inside someone else's document (there, Jarvis's data-inventory; here, this build's task brief) are not a real paper trail. This closes that gap for this one narrow decision.
**Written by:** Q (builder) — this is not a fresh review by Mason or Asimov. It consolidates findings and a decision that Mason, Asimov, and Peter had already reached — as relayed in the brief for this build — into one durable, citable record, the same way this build's own code needed a durable audit trail rather than an informal one. Mason's and Asimov's positions below are reported, not re-derived; if either of them wants to expand on their own reasoning in their own words, that belongs in a document written by them, the same way Mason's fuller reviews (`compliance/leadsimple-fair-housing-review.md`, `compliance/approval-briefing-fair-housing-review.md`) are.
**Date:** 2026-09-02
**Companion documents:** `projects/hub/maintenance-history/shared-property-context-SPEC.md` (Part 2 — the bounded Needs Privacy Review redesign this decision sits inside), `projects/hub/maintenance-history/router.js` (the `PRIVACY_REVIEW_ROLES` / `PRIVACY_QUEUE_ACK_*` constants this document explains), commit `79c43cf` (the original grant this document supersedes the justification for).

---

## Scope — What This Does and Doesn't Answer

This is narrow on purpose: whether **`director_of_operations`**, specifically, should hold standing access to Maintenance History's "Needs Privacy Review" queue (flagged, protected-class-adjacent tenant claims) and its Confirm/Correct/Reject controls. It is not a re-review of the queue's design generally — that's Mason's fuller review already on record in `shared-property-context-SPEC.md` Part 2, which considered and rejected a much broader proposal (exposing flagged content to every role with Maintenance History access) and approved a bounded, count-only-badge version instead. This document only covers the one question Mason flagged as needing its own pass within that bounded version: this specific role.

It also does not cover Security Deposit, even though commit `79c43cf` (below) touched both tools in one change. Security Deposit's `director_of_operations` grant is a separate decision with its own content and its own risk profile, and isn't reviewed or re-justified here.

## Background — The Grant This Document Supersedes

Commit `79c43cf` (2026-08-26), *"Give director_of_operations full access to Security Deposit and Maintenance History,"* added `director_of_operations` to Maintenance History's claim-review and flagged-queue routes. Its own stated justification, verbatim from the commit message: *"Peter's Director of Operations needs to do hands-on testing, and the role was previously scoped to one narrow action... and didn't exist at all in Maintenance History."*

That is a testing-access justification, not a Fair Housing access decision. It was never represented as one, and it was never run past Mason.

## Asimov's Finding

Asimov flagged that `79c43cf`'s backend grant gave `director_of_operations` a working path to flagged, protected-class-adjacent claim content without that access ever having been evaluated under GOVERNANCE.md's Fair Housing Standard (owned by Mason, gated by Asimov) — it shipped as a side effect of a testing need, not a deliberate, reviewed access decision. The prior Maintenance History build (Part 1/Part 2 of `shared-property-context-SPEC.md`) responded to that finding by deliberately narrowing `PRIVACY_REVIEW_ROLES` — the constant gating the flagged-queue route and the Property Overview flagged-count badge — back down to `admin`/`reviewer` only, holding `director_of_operations` out of both until a real review happened. `POST /claims/:id/review`'s own three-role grant was left technically in place (changing it wasn't in scope for that build) but was explicitly flagged in that build's own code comments as needing the same review, not a loophole to rely on.

## Mason's Original Bounded-Badge Review

Recorded in full in `shared-property-context-SPEC.md` Part 2. Summary relevant here: Mason reviewed and **rejected** Peter's original, broader proposal (retire the standalone queue; show flagged claims to every role with Maintenance History access) — his key point was that "nobody sees anything new versus what's in Latchel/AppFolio" is a source-system-access-parity argument, not a Fair Housing one; what matters is what *this tool* routinely surfaces to staff, unprompted. Mason then approved a bounded alternative instead: the existing role gate stays exactly as-is at the API level; a count-only badge (no claim text, no category) is added to Property Overview, visible only to the same gated roles; the filtered/portfolio-wide queue itself is otherwise unchanged.

Within that same review, Mason recorded that Peter had separately decided (2026-09-01) to include `director_of_operations` among the gated roles for the new badge — and flagged that specifically as *"a confirmed, deliberate, real access grant to `director_of_operations` — not a pure navigation shortcut"* that needed its own Mason/Asimov pass before shipping, distinct from the badge mechanism itself.

## Mason's Follow-Up Review and Conditional Yes

Mason reviewed that specific question — `director_of_operations` regaining standing access to flagged claim content and Confirm/Correct/Reject — and gave a **conditional approval**: back in, on two conditions that had to ship in the same build as the access itself, not as a follow-up:

1. **A one-time acknowledgment gate.** Before a `director_of_operations` user can see any flagged claim text or use Confirm/Correct/Reject on a flagged claim for the first time, they must see a short, one-time notice that the queue contains real tenant claims touching Fair Housing-protected characteristics (race, disability, immigration status, health, familial status, and similar), must be treated as confidential, and used only for legitimate review — and acknowledge it once.
2. **Role-aware audit logging.** The audit trail for a claim-review action must make the acting role recoverable, not just an email address, so a later compliance review can reconstruct role-at-time-of-action.

## Peter's Stated Reasoning

Peter's own reasoning for this specific role, verbatim: **"the director of operations is the person that needs full access to everything."**

Worth being explicit about what this does and doesn't establish: it's a business judgment call about one named role with a defined operational function, not a general "give everyone access" position — Mason's rejection of the broader, every-role version above stands untouched by it. It's the same kind of reasoning Mason accepted for the LeadSimple retention-period question (`compliance/leadsimple-fair-housing-review.md`, Addendum 2) — a specific person's specific, stated rationale for a specific, bounded grant, not a default anyone else can invoke without their own review.

## What Shipped, This Build — Mapped to Each Condition

| Condition | Implementation |
|---|---|
| Acknowledgment gate | `router.js`: `PRIVACY_QUEUE_ACK_ACTION` / `PRIVACY_QUEUE_ACK_ROLE` / `hasAcknowledgedPrivacyQueue()`, checked in `GET /api/maintenance-history/flagged-queue` and in `POST /api/maintenance-history/claims/:id/review` (only when the claim being reviewed is flagged and the actor's role is `director_of_operations`); new `POST /api/maintenance-history/privacy-queue/acknowledge` writes the one-time acknowledgment as an `audit_log` row (action `maintenance_claims.privacy_queue_acknowledged`) rather than a new table/column, reusing this codebase's existing "don't build schema ahead of a proven need" pattern. Front end: `dashboard/index.html`'s `view-flagged` tab shows a one-time notice + acknowledge button before rendering any flagged claim content for this role; `admin`/`reviewer` never see it. |
| Role-aware audit logging | `router.js`: the `maintenance_claims.reviewed` audit_log write in `POST /claims/:id/review` now includes `details.actor_role` (the role in effect for the action), in addition to the existing `actor_id` (email), which remains resolvable back through `team_member_tool_roles` as a second path to the same answer. |
| Backend access restored | `PRIVACY_REVIEW_ROLES` in `router.js` is `['admin', 'reviewer', 'director_of_operations']` again — governs both `GET /flagged-queue` and Property Overview's `flagged_review_count` field. |
| Front-end access restored | `dashboard/index.html`: the "Needs Privacy Review" tab is shown to `director_of_operations` (was `admin`/`reviewer`-only), and `canReview` extends to the same role, consistent with backend access. |

## What This Supersedes

Commit `79c43cf`'s stated justification for `director_of_operations`'s Maintenance History grant ("hands-on testing") is superseded by this document as the real, considered basis for that access going forward — Mason's conditional approval and Peter's stated reasoning above, not a testing convenience. The grant itself (which routes it covers) is unchanged from what `79c43cf` already shipped; what changed is that it now rests on an actual Fair Housing decision, with the two conditions Mason required in place, rather than riding along on an unrelated justification.

## What This Does Not Do

- Does not extend this access to any role beyond `director_of_operations` — Mason's rejection of the broader "every role" proposal (`shared-property-context-SPEC.md` Part 2) is untouched.
- Does not re-justify or review Security Deposit's `director_of_operations` grant from the same original commit — separate tool, separate content, not addressed here.
- Does not change who holds the `reviewer` role today, or how that grant is made (still a separate, per-person, auditable decision via the existing Users tab).
