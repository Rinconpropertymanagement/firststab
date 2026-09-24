# Asimov — Confirmation Pass, Property 360 Embed (Population Expansion)

**Date:** 2026-09-24. Confirms whether
`compliance/archive-search-property-360-access-expansion-outside-counsel-opinion.md`
closes Asimov's 2026-09-23 NOT CLEARED verdict on expanding Archive
Search access from 2 named admins to everyone with Property 360 access.
Reproduced verbatim from Asimov's actual output.

---

**Does the new opinion close the attorney-review prong? Yes.** The prior
verdict's one missing piece was a direct answer to a question counsel had
not yet been asked: does the standing authority extend to a *population*
change, not just a content/logic change. The new opinion is that direct
answer — it is the response to
`archive-search-property-360-access-expansion-attorney-question.md`, the
exact question both NOT CLEARED verdicts said was required — and it does
not hedge: "I would permit Rincon to make the Property 360 search
function available to ordinary authorized Hub users whose job
responsibilities reasonably include access to property, owner, tenant,
maintenance, leasing, accounting, or related operational information."
Gate closed.

**The "materially broader employee population" language is directly
addressed, not sidestepped.** Both prior verdicts leaned on that exact
phrase from the prior opinion as the bright line counsel had drawn.
Counsel's own Section 13 revisits it by name: "The prior reference to a
'materially broader employee population' should not be interpreted to
mean that every addition of employees or every expansion of internal
access requires new legal review." Section 15 goes further and disclaims
the two population figures both verdicts treated as load-bearing: "my
previous opinions should not be interpreted as establishing: two named
administrators or eight specifically approved employees as a permanent
legal limitation on Archive Search... Those numbers described the system
as it existed... They were not intended to establish a legal ceiling."
An attorney is entitled to clarify their own prior language; this isn't
Rincon reinterpreting an old opinion favorably, it's counsel doing so
directly, on the record, in response to the specific question that named
the ambiguity.

**Scope of what's actually cleared — worth stating precisely.** The
clearance is not "anyone with a Hub login, full stop." It's "ordinary
authorized Hub users whose job responsibilities reasonably include
access to property, owner, tenant, maintenance, leasing, accounting, or
related operational information" (Preliminary Opinion), tied to
"legitimate business reason for access" throughout (Sections 1, 13).
Today's ~9 Hub logins are Rincon staff per CLAUDE.md's own description
of the business (150–500 units, property/maintenance/leasing/accounting
operations) — nothing on file suggests a Hub account held by someone
without an operational property-management role. That should stay true
going forward: this opinion clears role-appropriate staff, not literally
every future Hub grant regardless of function.

**Training (Section 7) answers Mason's specific concern, not just the
population question in the abstract.** Mason's NOT CLEARED flagged that
the "trained employees" safeguard the whole framework leans on was never
shown to exist for anyone past the 2 admins. Counsel's answer:
"Employees who handle tenant and applicant information should already
understand Rincon's Fair Housing requirements... That principle can be
incorporated into Rincon's ordinary Fair Housing and system-use
training. I would not require employees to complete a separate course."
That's a real answer — ordinary Fair Housing training, already required
for staff handling tenant/applicant data, is the safeguard, not a new
Archive Search-specific certification. Worth confirming as a build
condition (below) that this training in fact already reaches everyone
who'll get search access, not assumed.

**Intermediate tier — legally optional, still the right build.** Section
6 is explicit the tier isn't legally required, but frames it as
"sensible role-based system design" when admins hold capabilities
ordinary users shouldn't: "ordinary users can simply receive search
privileges without receiving administrative privileges." That's exactly
the shape of this codebase today — `router.js` already splits
`ARCHIVE_SEARCH_SEARCH_ROLES = ['searcher', 'admin']` from
`ARCHIVE_SEARCH_ADMIN_ROLES = ['admin']`, meaning admin-only capabilities
(config, the significance-pass cron gate, whatever else sits behind that
check) are already gated separately from search. Counsel's "not legally
mandatory" doesn't change that recommendation: grant `searcher` role to
the Hub population this ships to, through `team_member_tool_roles`,
instead of routing Property 360's search box around the
`archive_search` role table entirely. Two independent reasons, neither
about the legal question: (1) it's the only way this build stays
consistent with Property 360's own stated design principle — composing
tools onto that page "must never become a fifth, broader way in" than
each tool's own access — a real `searcher` grant makes the tool's access
match Property 360's population instead of bypassing it; (2) it's the
only mechanism that gives Rule 6's audit log something concrete to log
(who was granted search access, when) instead of "whoever has a Hub
login on a given day."

## Rule 6 mechanics required in the build spec

1. Grant `searcher` role (not a bypass of the role table) to the current
   Hub population via `team_member_tool_roles`, and fold that grant into
   Rincon's normal employee-provisioning step going forward, per
   counsel's own suggested model (Section 8): Hub access → role-
   appropriate tool access, no separate admission process.
2. A Rule 6 `audit_log` entry (e.g.
   `archive_search.rule6_population_expanded`) citing this opinion and
   its date, the two 2026-09-23 NOT CLEARED verdicts it closes, owner
   approval (original signature plus both same-day reconfirmations in
   the risk-acceptance document), and Critical-tier classification
   (permission-tier change).
3. Shadow mode: counsel's own Section 10 counsels against turning
   logging into an approval gate — "I would not require... review search
   logs routinely... require human review of results before employees
   may see them." Consistent with the Layer 1 precedent (a concrete
   substitute stood in for shadow mode there), the substitute here is
   Archive Search's existing ordinary logging — no new pre-search gate
   should be built; one isn't legally required and the opinion says one
   would undermine the tool.
4. Search/consequential-reliance distinction (Section 11) stays in
   whatever employee-facing guidance already states it — this remains an
   operational search tool, not a basis for an unreviewed adverse
   housing decision. No change from the standing framework; just carries
   forward to the larger population.
5. Confirm, before shipping, that today's ~9 Hub accounts (and the
   provisioning step going forward) are in fact limited to staff with
   property-management job responsibilities per the opinion's own scope
   — a quick population check, not a new legal question.

**VERDICT: CLEARED WITH CONDITIONS** (the five items above). Mason's
separate confirmation required before Q builds, per the two-signature
pattern used on Layer 1 — see
`compliance/archive-search-property-360-embed-mason-confirmation.md`.
