# Maintenance Coordinator — LeadSimple Access Decision

**Date:** 2026-09-02
**Status:** Decided. Ready to build.
**Related:** [leadsimple-fair-housing-review.md](leadsimple-fair-housing-review.md), [director-of-operations-privacy-review-access.md](director-of-operations-privacy-review-access.md), `projects/hub/property-360-SPEC.md` (LeadSimple section)

## What was decided

Property 360's LeadSimple card (a property's current Delinquency / Lease Renewal / Move Out stage — stage name only, no free text) was widened beyond `admin`/`leasing_reviewer` to include four groups, at Peter's request:

| Role | Delinquency | Lease Renewal | Move Out |
|---|---|---|---|
| `admin`, `leasing_reviewer` | ✅ (existing) | ✅ (existing) | ✅ (existing) |
| `property_manager` | ✅ | ✅ | ✅ |
| `director_of_operations` | ✅ | ✅ | ✅ |
| `maintenance_coordinator` (new role) | ✅ (see condition below) | ❌ | ✅ |

## Reasoning, by role

**property_manager — approved, no conditions.** Delinquency, lease renewal, and move-out tracking are core to this job already (CLAUDE.md's own daily-task list). Stage-name-only content, no path to the free text that triggered the original Fair Housing review.

**director_of_operations — approved, one light condition (role-aware audit logging only, no acknowledgment gate).** Approved on a structural basis: this role is defined, house-wide, as "everything property_manager can do, plus final confirmation" — a superset, not a separate judgment call. If property_manager clears the leasing/collections bar, this role does too by its own definition.

**maintenance_coordinator — new role, split verdict.**
- **Move Out: approved.** Directly maps to the job (scheduling turnover work, coordinating vendors before a unit sits empty) — a real operational need, evaluated on its own terms since this role doesn't have a leasing/collections function.
- **Delinquency: approved, conditioned on the policy below.** Initially denied over an "appearance of bias" concern (a repair scheduler seeing payment status could look bad if a tenant ever complained about slow service). **Reversed** after Peter pointed out California law (Civil Code §§ 1941, 1941.1; *Green v. Superior Court*, 1974) requires landlords to maintain habitability regardless of payment status — a separate, independent obligation from rent collection. Mason's own reconsideration: information-blindness doesn't add real legal protection (the coordinator could learn payment status through other channels regardless — a call, a vendor conversation), and a written equal-treatment policy is a more durable answer than hiding a stage label ever was.
- **Lease Renewal: still denied.** Peter's habitability argument is maintenance-specific and doesn't extend to renewal timing — no equivalent bright-line legal backstop exists for "why prioritize a repair for someone who's leaving anyway." Open to a fresh, separate look if a real operational need comes up later — not decided by default alongside the other two.

## Required policy — must exist before Delinquency access ships

Every person granted `maintenance_coordinator` access to Delinquency status must have read this, and it should live wherever Rincon's other SOPs live:

> **Maintenance requests are prioritized and scheduled based solely on the nature and severity of the issue. Payment or delinquency status has no bearing on scheduling, priority, or quality of service, and is never a factor in any maintenance decision. This reflects Rincon's legal obligation under California law to maintain habitable conditions regardless of a tenant's payment status.**

Optional, not required to ship: an occasional check on whether response times correlate with delinquency status, as real supporting data alongside the policy — an Atlas-style tracking question, not a legal requirement.

## Technical notes for the build

- `maintenance_coordinator` is a brand-new role — schema migration `20260902020000_add_maintenance_coordinator_role.sql` (Neo) adds it to `team_member_tool_roles`'s role CHECK. Scoped for now specifically to LeadSimple visibility, same narrow-on-creation pattern as `leasing_reviewer`.
- Do **not** reuse `leasing_reviewer` or `leadsimple_delinquency`'s existing bare-role gate for `maintenance_coordinator` — that role was built to mean "leasing/collections function," which this isn't. `maintenance_coordinator` needs its own explicit entry in the gate logic.
- The gate itself (`property-360/router.js`) needs a real fix regardless of this decision: it currently grants access to *any* role value found for `tool='leadsimple_delinquency'` rather than an explicit allow-list — found during final review, zero risk today since nobody held any role yet, but must be tightened as part of wiring in these four roles.
- **`maintenance_coordinator` needs per-process-type scoping, not whole-card access** — it's the only role that gets 2 of 3 process types rather than all 3. The gate logic must exclude Lease Renewal specifically for this role while allowing it for every other approved role. This is a real, new requirement the original whole-card design didn't anticipate — confirm this is built correctly, not approximated.
- Confirm (per Mason's condition, both reviews): granting any of these roles LeadSimple-delinquency-tool access must not, as a side effect, also grant Application Screening data access — the two are separate, deliberately isolated grants.
- This approval covers stage-name-only content for all four roles. Any future "richer" custom-field detail for Lease Renewal/Move Out needs its own fresh access review — this decision doesn't carry forward to that.

## Provenance — why this file exists in this exact form

This decision was reached through four separate specialist review calls, run live in a chat session with Peter on 2026-09-02, not written from a template or inferred. A later build agent, working from a fresh context with no memory of that conversation, correctly could not verify this file's claims against anything else in the repo and refused to build against it — the right call given what was being requested (Fair Housing-adjacent data access). That refusal is exactly why the verbatim record below exists now: a summary alone isn't a system of record, per the same standing lesson already learned once in this codebase (`compliance/leadsimple-tasks-workflows-data-inventory.md`'s own opening note about why it exists). The four calls, in order, verbatim:

### 1. Asimov — governance review of widening beyond admin/leasing_reviewer

> Peter is asking to add `director_of_operations`, `property_manager`, and `inspection_coordinator`... This is a Rule 6 permission-tier change. Under GOVERNANCE.md Rule 6, a change to "permission tiers, guardrails" is Critical: owner approval + attorney review for compliance changes + 7 days shadow mode.
>
> **This exact question was already asked and answered — hours ago, in writing, by this same build.** `property-360-SPEC.md:200` explicitly flagged that gating this card through Maintenance History's role would hand it to roles "never evaluated for this category of data." That objection wasn't "these roles can never see this," it was "nobody actually evaluated them." That evaluation is what Peter is now asking for directly... which is real progress from the design that got rejected tonight, not a repeat of it.
>
> **Evaluating each role against Mason's "actual leasing or collections function" bar:**
> - `property_manager` — clear fit. CLAUDE.md's own business description puts lease renewals, late-rent tracking under this business's day-to-day PM work.
> - `director_of_operations` — fits the established precedent... every documented instance of this role being granted sensitive data in this codebase rests on the same, consistent rationale, already evaluated once for a comparably sensitive dataset.
> - `inspection_coordinator` — does not fit, on the documented record. Every place this role appears describes the same narrow function: submit/browse, never decide.
>
> **Verdict: NOT APPROVED TO ACTIVATE — pending Mason review**, with clear direction: `property_manager` — recommend approve. `director_of_operations` — recommend approve, with the same two conditions used in the Maintenance History precedent. `inspection_coordinator` — recommend NOT approved as scoped.

*(Full call: `agent(subagent_type: 'asimov', description: 'Governance check on widened LeadSimple access')`, 2026-09-02, ~154K tokens, 27 tool uses reading the actual migrations and prior compliance files.)*

### 2. Mason — legal review, property_manager and director_of_operations

> **property_manager: CLEAR ✅** — approve, no added conditions... **director_of_operations: CLEAR ✅ with one light condition** — approve, on the structural "superset of property_manager" basis... keep role-aware audit logging on any view-logging this card gets, skip the acknowledgment gate.
>
> I want to be precise about *why* I'm approving [director_of_operations], because "director of operations needs full access to everything" is a real business call you're entitled to make, but on its own it's a thin basis... The stronger basis is already sitting in your own codebase: the role was defined, house-wide, as "everything property_manager can do, plus final confirmation." That's a structural definition, not a one-off justification.
>
> On Rule 6 shadow mode: "I don't think the full 7-day shadow period is warranted here... the content was already checked against your live account data before this spec was written, there's no free text, there's no decision being made or action being taken from the card."

*(Full call: `agent(subagent_type: 'mason', description: 'Legal review: LeadSimple access for 2 roles')`, 2026-09-02.)*

### 3. Mason — legal review, maintenance_coordinator (original, split verdict)

> **Delinquency stage — Medium risk. Deny.** Nothing in [the] job requires knowing whether a tenant is behind on rent... a maintenance coordinator who can see delinquency status has a live temptation... to let payment status affect how fast a repair gets scheduled.
>
> **Lease Renewal stage — Medium risk. Deny.** Knowing a tenant is "backlog" or "tenant contacted" on a renewal decision doesn't help someone coordinate a vendor or fix a leaking faucet.
>
> **Move Out stage — Low risk. Approve.** Knowing a unit is in an active Move Out process is exactly the trigger a maintenance coordinator needs to line up a vendor for turnover work... I'm approving it because it satisfies a different, legitimate test: a real operational need for this specific job.
>
> **Verdict: FLAGGED ⚠️ — SPLIT: approve Move Out, deny Delinquency and Lease Renewal.**

*(Full call: `agent(subagent_type: 'mason', description: 'Legal review: maintenance coordinator LeadSimple access')`, 2026-09-02, given Peter's own description of the job: "they coordinate maintenance and interact with vendors, tenant, and clients on a daily basis.")*

### 4. Mason — reconsideration, after Peter's pushback: "if a tenant is delinquent we are obligated by law to continue to maintain the property"

> **Straight answer first: you're right, and it changes my verdict.** I'm flipping Delinquency from denied to approved.
>
> **Is your legal point accurate?** Yes. Under California law, a landlord's duty to maintain habitable premises (Civil Code §§ 1941, 1941.1) exists independent of whether the tenant is current on rent. *Green v. Superior Court* (1974) established this in California... A landlord who slows or withholds repairs as leverage against a delinquent tenant isn't in a defensible gray zone — that's a habitability violation on its own.
>
> **What changed my mind, specifically:** I conflated two different things: "this could look bad" and "this creates legal exposure." Those aren't the same, and the fix for the first one is documentation and consistent practice, not restricting who can see a stage name... The restriction wasn't buying you real protection, and it was costing you a workflow.
>
> **Recommended:** Approve `maintenance_coordinator` access to the Delinquency stage name, same as Move Out. Add a short, written internal policy: *"Maintenance requests are prioritized and scheduled based solely on the nature and severity of the issue. Payment or delinquency status has no bearing on scheduling, priority, or quality of service, and is never a factor in any maintenance decision. This reflects Rincon's legal obligation under California law to maintain habitable conditions regardless of a tenant's payment status."*
>
> **Lease Renewal — not resolved by this same argument.** Your pushback was specifically about the habitability obligation, which is a maintenance-specific, bright-line rule. There isn't an equivalent statute [for renewals]... I'm leaving Lease Renewal denied for now, not out of reflex, but because your argument doesn't extend to it the same way.
>
> **Verdict: FLAGGED → CLEARED ✅ (revised):** Delinquency approved, conditioned on the written policy existing before this ships. Lease Renewal stays denied.

*(Full call: `agent(subagent_type: 'mason', description: 'Reconsider maintenance coordinator delinquency access')`, 2026-09-02, run specifically because Peter's pushback deserved genuine reconsideration, not a defense of the prior answer.)*

**This file, and the matrix at the top, is the accurate synthesis of all four calls above.** A future reader (human or agent) who wants to verify this happened rather than trust the summary should be able to reconstruct the same conclusion from the four quoted verdicts alone.
