# Decision Resolution: Work Order Notes Alert — Content-Check Conditions Overridden by Peter

**Date:** 2026-09-21
**Status:** Resolved. This document is the durable record of Peter's decision, referenced by `compliance/work-order-note-alerts-governance-review.md` (Asimov) and `projects/hub/work-order-notes-alert-SPEC.md`, and should be cited by Q's follow-up build work and by any future review of this feature.

---

## What Asimov's governance review required

`compliance/work-order-note-alerts-governance-review.md` approved this feature to build **conditioned on** four hard requirements, the first of which: Layer 1 (keyword scan, `protected-class-terms.js`) **and** Layer 2 (AI classification) both run unconditionally, on the live note text, before every send. Q built exactly this and confirmed it working in testing — including one concrete, real example: a note reading roughly "coordinate with the tenant's home health aide" passed Layer 1 (no keyword match) but was correctly caught by Layer 2.

## What actually happened

Peter instructed, across three messages in the same conversation, that the content check be removed entirely and the note text sent verbatim:

1. **"we dont need any scan or explanation on the notes. simply quote them and emaikl them out. no double scan."**
2. **"no ai use / i already told you this."**
3. **"what your quoting isnt a fair housing issue at all but simply access instructions. do what i told you. we dont needd you to overthink this."**

Jarvis pushed back twice before complying, on two grounds:
- **Procedural:** this isn't a discretionary extra layer the way the Mason legal-review question was — Asimov's actual approval was *conditioned on* this check. A version without it is a different design that Asimov has not reviewed, which CLAUDE.md's rule 1 says needs to go back through Asimov before shipping, not be decided unilaterally.
- **Substantive:** the home-health-aide example (above) is concrete, not hypothetical — a keyword-only or no-check version would have let it through unfiltered.

On Peter's third message, he offered a direct substantive argument rather than only an instruction: that the flagged example is "simply access instructions," not Fair Housing-relevant content. Jarvis noted, for the record, one fact directly on point before proceeding: this exact argument already arose in this codebase for the field this design was modeled on — Mason's own prior Fair Housing review of `access_instructions` (`compliance/approval-briefing-fair-housing-review.md`) specifically flagged a superficially similar "just an access/scheduling note" example ("my mother who lives with us needs notice") as Fair-Housing-relevant anyway, precisely because ordinary-sounding access/coordination language is where protected-class-adjacent facts (here, a health-aide arrangement implying a disability) tend to appear. Mason's prior review did not accept "it's just access instructions" as sufficient reason to skip a content check for this category of field.

Peter maintained his instruction after this was raised — confirmed directly ("yes") — and separately, explicitly declined even the fast Asimov confirmation Jarvis had offered as a middle ground ("no asimov. skip it"). Jarvis judged the "refuse and explain first" obligation discharged after two substantive rounds plus this final, specific, on-point rebuttal, and proceeded on Peter's explicit, repeated, informed decision — the same threshold applied to the Mason override, and for the same underlying reason: this is Peter's legitimate business-risk-tolerance call to make as the owner, not Jarvis's to keep withholding once he has been given the specific, relevant facts and still directs otherwise. Unlike the Mason override, this decision was made with no Asimov involvement at all, at Peter's explicit instruction — recorded here plainly, not obscured.

## What Peter overrode, precisely

- Asimov's governance-review condition 1 (Layer 1 + Layer 2 content check before every send) — **removed entirely** for this feature. `properties.maintenance_notes` will be quoted verbatim into the pod email with no automated content screening of any kind.
- Conditions 2–4 (redact-not-block, proactive human alert on a flag, Layer 2 fail-safe) are **moot as a direct consequence** — there is no longer a flag mechanism to redact around, alert on, or fail safe from. Not separately re-litigated; they fall away because condition 1 (the thing that would ever produce a flag) is gone.

## What Peter did NOT override

- CLAUDE.md's separate, standing rule — "do not merge, deploy, or go live without my explicit approval" — is untouched. Production go-live remains a distinct future checkpoint.
- Everything else about the build (recipient resolution, dedup/retry, audit trail, failure visibility) is unaffected — this decision only removes the content-check step from the send path.

## What this means for the build

Q needs to modify `work-order-notes-alert.js` to remove the call into `work-order-notes-content-check.js` (Layer 1 + Layer 2) and send `properties.maintenance_notes` verbatim. `work-order-notes-classifier.js` and `work-order-notes-content-check.js` can stay in the repo unused (cheap to leave, cheap to re-wire later if this decision is ever revisited) rather than being deleted — Q's call on which is cleaner. The `work_order_note_alerts` table's `flagged_protected_class`/`flagged_category` columns will simply always be `FALSE`/`NULL` going forward; no schema change needed, Neo does not need to be re-engaged.
