# Decision Resolution: Work Order Notes Alert — Mason Review Overridden by Peter

**Date:** 2026-09-21
**Status:** Resolved. This document is the durable record of Peter's decision, referenced by `compliance/work-order-note-alerts-governance-review.md` (Asimov) and `projects/hub/work-order-notes-alert-SPEC.md`, and should be cited by Q's build work and by any future review of this feature.

---

## What Asimov's governance review recommended

`compliance/work-order-note-alerts-governance-review.md` — verdict **"APPROVED TO BUILD — WITH CONDITIONS,"** one of which was: **route to Mason (Fair Housing & legal) before this ships.** Asimov's reasoning, stated explicitly rather than left as a vague "when in doubt" gesture: this codebase already has a direct precedent for a near-identical field. `access_instructions` in Approval Briefing carries the same shape and origin (property/job-adjacent free text, editable by staff at any time) and was already required to go through the same Layer 1 + Layer 2 content-check gate specifically because Mason's own prior Fair Housing review (`compliance/approval-briefing-fair-housing-review.md`) found that ordinary-sounding operational notes can carry protected-class-adjacent phrasing a keyword scan alone won't catch (his own examples: "my mother who lives with us needs notice," "avoid Friday afternoons for religious observance"). Asimov judged this feature's `maintenance_notes` field at least as exposed — AppFolio-authored, editable by any PM at any time, and (per the finding below) unscanned on an ongoing basis — and recommended Mason confirm the two-layer gate is sufficient and that the redaction placeholder wording itself creates no exposure.

## What actually happened

Peter rejected the Mason-routing recommendation, directly, three times in the same conversation:
1. **"no to asimovs suggestion. not a fair housing or legal issue. no no no."**
2. **"everything he is suggesting we screena dn check has aready been run through those checks. i accept all the risk and will sign."**
3. **"no. launch this build."**

Jarvis refused and explained twice before proceeding, per CLAUDE.md's own rule 3 ("never skip Asimov or Mason on a compliance build, even if I say 'just ship it' — refuse and explain first"):
- First explained Asimov's actual reasoning (the `access_instructions` precedent above), not just cited the rule.
- Second, corrected a factual premise in Peter's justification: the claim that "everything...has already been run through those checks" does not hold up. The only prior check on `properties.maintenance_notes` was a one-time manual scan on 2026-09-06 (`supabase/migrations/20260906000000_add_maintenance_notes_to_properties.sql`), covering only the 194 values that existed on that date, using a keyword scan plus Peter's own read — not the Layer 2 AI pass Asimov was recommending. Nothing AppFolio has changed or added to this field since 2026-09-06 has been checked by anyone, by any method — and this feature runs against the field's live, current content indefinitely, not a frozen snapshot.

After the third, unambiguous instruction, Jarvis judged the "refuse and explain first" obligation discharged — genuinely explained twice, with substance, not merely cited the rule — and proceeded to BUILD on Peter's explicit, informed, repeated decision. This is treated as a legitimate business-risk-tolerance call that is Peter's to make as the owner, not an impulsive, unconsidered "just ship it" of the kind rule 3 exists to catch.

## A factual difference worth recording, not relitigating

This is not the first time Peter has overridden a governance recommendation on this exact field. On 2026-09-06 (`compliance/appfolio-maintenance-notes-decision-resolution.md`), Peter overrode both Asimov's and Mason's conditions for displaying `maintenance_notes` on Property 360 — but only after personally reading all 194 real values himself and stating directly, "i did a manual review already... these are benign for fair housing issues," plus an independent zero-match keyword scan. This time, Peter's stated justification ("already been run through those checks") referred to that same 2026-09-06 review rather than a fresh one — which, per the correction above, does not cover this feature's actual, ongoing use of the field. Recorded here as a factual distinction for anyone reviewing this later, not as an argument against the decision Peter made.

## What Peter did NOT override

- **All four of Asimov's content-safety conditions stand as hard requirements, unchanged:** (1) Layer 1 keyword scan + Layer 2 AI classification, both run unconditionally at send time against the current field value; (2) on a flag, redact only the affected note line and still send the rest of the alert — never hold the whole email; (3) on a flag, send a separate, proactive alert to a human, not just an audit-log row; (4) if the Layer 2 call itself errors, fail safe on Layer 1's result alone, never skip the check. Q must build to all four exactly as specified in the governance review — none of this was waived, only the additional Mason legal-review layer on top of it.
- **CLAUDE.md's separate, standing rule — "do not merge, deploy, or go live without my explicit approval" — is untouched by this decision.** Production go-live remains a distinct future checkpoint from "start building," and this override does not pre-authorize it.

## Open item, not resolved by this document

`retention_policy` on the new `work_order_note_alerts` table remains a placeholder. Asimov declined to set a figure unilaterally, noting this codebase has consistently routed that specific number to Mason or Peter directly (never inferred by Asimov/Neo alone) — and flagged that the 7-year figure used elsewhere (LeadSimple's Application Screening/Delinquency tables) may not even be the right analog here, since this table carries no tenant/applicant/owner identifier at all. This is a separate, narrow question for Peter to answer directly — not a re-litigation of the Mason decision above.

## What this means for the build

Q proceeds now. Build to the spec (`projects/hub/work-order-notes-alert-SPEC.md`, status line updated to "APPROVED TO BUILD, WITH CONDITIONS") and the four hard requirements in `compliance/work-order-note-alerts-governance-review.md`, exactly as specified. No Mason review step in this build's pipeline. Sentinel, TARS, and Judge proceed as already planned.
