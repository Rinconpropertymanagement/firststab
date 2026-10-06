# Fair Housing Standing Guidance — Check Here Before Drafting a New Attorney Question

**Source:** outside counsel's opinion, 2026-09-12
(`compliance/archive-search-layer1-removal-outside-counsel-opinion.md`),
issued specifically to stop repeated narrow attorney questions on
implementation variants of the same underlying principle. Counsel was
direct that Rincon should not need a new opinion each time.

**How to use this file:** before drafting any new attorney question about
an Archive Search (or similar internal information-retrieval/compliance
tool) screening change, check it against the principles and boundaries
below first. If it clearly falls within the principles and outside the
boundaries, it does NOT need a new attorney question — cite this file and
counsel's opinion above as the basis, note it in the relevant spec, and
still route through Asimov/Mason for a real (but fast) confirmation that
this specific change actually fits the standing guidance, the same way any
Rule 6 Critical-tier change gets logged. If it's genuinely ambiguous or
touches one of the boundaries below, draft the question — counsel would
rather answer a real new question than have Rincon guess wrong on a
boundary case.

## The consistent principle

Fair Housing law does not require preventing trained employees from
encountering every reference to a protected characteristic. The relevant
concern is potentially discriminatory conduct, treatment, policy,
preference, decision, harassment, retaliation, or failure to satisfy
accommodation obligations because of protected status — not mere knowledge
of a protected characteristic.

## Covered, does NOT need a new opinion (examples counsel gave directly)

- Removing a poorly performing keyword rule
- Adding or removing screening terms
- Changing AI prompts
- Consolidating multiple classifiers
- Modifying confidence thresholds
- Changing routing rules
- Reducing unnecessary flags
- Allowing additional categories of legitimate operational information to
  clear
- Adjusting audit sampling
- Changing escalation workflows
- Replacing an older screening mechanism with a better-performing
  contextual one

## The 8 conditions that must remain true for standing guidance to apply

1. Mere knowledge is distinguished from discriminatory conduct — no
   restriction solely for mentioning a protected characteristic.
2. Screening focuses on meaningful Fair Housing concerns (discriminatory
   treatment, preferences, policies, steering, harassment, retaliation,
   unresolved/improperly handled accommodations) — not mere mention.
3. Professional judgment remains part of the system — trained employees
   are relied on to recognize and handle what they encounter.
4. Reasonable false-negative risk is accepted — the system need not catch
   every conceivable direct, indirect, coded, or euphemistic issue.
5. Reasonable false-positive reduction is legitimate business judgment.
6. Redundant automated controls are not inherently required.
7. Human escalation remains available regardless of automated
   classification.
8. The system stays in the information-retrieval / classification /
   flagging / access / compliance-review category — see boundary below.

## Boundary — DOES need a fresh opinion

Do not treat as covered, and draft a real question instead, if a change:

- Uses protected-class information to influence a substantive housing
  decision (approval, denial, rent, deposit, renewal, termination,
  eviction, eligibility)
- Introduces automated tenant risk scores
- Materially expands who can access sensitive information
- Eliminates Fair Housing training or escalation mechanisms
- Intentionally retains discriminatory preferences for operational use
- Materially changes the purpose for which protected information is
  processed
- Introduces a new privacy or statutory issue these opinions don't address

## Still required for every change, covered or not

Per Rule 6 and this project's own established practice: owner approval,
Asimov governance review (tier classification, version bump, audit log),
and a real-data test pass (TARS) before running against production at
scale — this standing guidance closes the *attorney-review* prong when a
change is clearly covered; it does not substitute for the other two.
