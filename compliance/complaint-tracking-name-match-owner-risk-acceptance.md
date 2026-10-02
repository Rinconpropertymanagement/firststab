# Complaint Tracking — Owner Risk Acceptance: Name-Based Human-Confirmed Matching, Without Outside Attorney Review

**This is an owner risk-acceptance document, not a governance or legal
clearance.** Mason (this project's internal legal/Fair Housing reviewer) has
reviewed this specific feature and recommended getting outside counsel's
answer to one specific question before it goes live. Peter, as owner of
Rincon Management, has decided to proceed without waiting for that answer.
This document records that decision plainly — not as something the
governance framework itself authorizes, but as a real prerogative an owner
has: it is his company and his legal exposure to accept.

## What is being built

Complaint Tracking currently matches a complaint to a real tenant or owner
only by exact email address (`projects/hub/complaint-tracking/lib/subject-match.js`).
About 70% of complaints can't be matched this way. This feature lets the AI
also suggest a match based on a tenant or owner's **name** mentioned in the
email content — but only in the narrow, human-confirmed form Mason's review
recommended, not the broader automatic version Mason recommended dropping
outright:

- A name-based suggestion is only ever generated when it's **corroborated
  by a property the system can already resolve independently** (the
  existing, already-approved property-address extraction). A name mention
  with no matching property produces no suggestion at all.
- The AI **never writes** `complaints.subject_type`/`subject_id` directly
  from a name match. It only ever proposes a candidate — or multiple
  candidates, if more than one real person could match — for a human to
  review.
- The review screen shows every real candidate explicitly, including which
  property each one is tied to, so a staff member is choosing between real
  people, not rubber-stamping a single AI guess.
- Only a human's explicit confirmation writes the match, tagged with a
  `match_method` value (`content_extracted_human_confirmed`) that can never
  be confused with an address-verified match, plus who confirmed it and
  when.
- A rejection (none of the candidates are right) leaves the complaint
  exactly as unmatched as it is today.

Full automatic resolution — the AI deciding and writing the match with no
human step — is explicitly **not** part of this feature and was not built.

## The real, quantified risk

Mason checked the actual portfolio data before this was built: names that
belong to more than one real tenant collide in about 2.1% of cases, and
about 2.5% for owners. But when the match is also required to agree with a
property the system can already resolve — the design this feature actually
implements — **zero of the 13 real tenant name-collision groups in the
current portfolio also shared a property.** On today's data, the practical
chance of this feature surfacing the wrong person as a candidate is at
effectively zero, not just reduced.

That is a measurement of today's data, not a mathematical guarantee for
every future case — a portfolio can always change in ways that create a new
collision. The residual risk being accepted is that gap: a real, if
currently unobserved, chance that two different real people (two tenants,
or two owners) with the same name are also tied to the same property at
some point, which would let a wrong name reach the human review screen as
one of the candidates. The human confirmation step is the backstop for that
case — the design assumes a person reviewing named candidates against a
specific property will catch a wrong one, not that the system can never
produce one.

## What outside counsel would have been asked, and why Peter decided to proceed without it

Mason drafted one specific question (saved at
`compliance/complaint-tracking-subject-name-identification-attorney-question.md`,
sent to Peter to forward): whether adding this human-confirmed, property-
corroborated name-matching path alongside the existing address-only rule
creates Fair Housing or other legal exposure that the address-only rule was
originally built to avoid. Peter has reviewed the risk as described above
and decided this does not need to wait for outside counsel's answer before
proceeding.

## What is NOT being waived by this decision

This document records only the decision to proceed without outside
attorney review of the one question above. It does not waive:

- The human-confirmation requirement itself — the AI still never writes a
  match on its own, on any complaint, ever, under this feature.
- The property-corroboration requirement — a name alone, unconfirmed by a
  resolvable property, still never produces a suggestion.
- The audit trail — every confirmed match still records who confirmed it,
  when, and under a match_method value that can never be mistaken for a
  verified address match.
- The feature's own activation flag (`NAME_MATCH_SUGGESTIONS_ENABLED`),
  which still defaults to off and is a separate decision from this one —
  this document accepts the risk of the feature's design, not an
  instruction to turn it on.

## Decision

Peter McKenzie, owner of Rincon Management, accepts the risk described
above and directs that this feature proceed to build and eventual use
without first obtaining outside counsel's answer to the attached question.

**Confirmed by Peter McKenzie, 2026-10-02, verbatim:** "I accept the risk.
i read the document."

**Addendum, same day:** Jarvis asked explicitly whether to activate this
feature with a 7-day shadow period first (suggestions generated and logged,
not yet treated as real) or go straight to full live use. Peter's answer,
verbatim: "go live." Shadow mode was offered and explicitly declined, not
skipped silently. The human-confirmation and property-corroboration
requirements described above are unaffected by this choice — they are
structural to the feature's design, not part of what shadow mode would have
added.
