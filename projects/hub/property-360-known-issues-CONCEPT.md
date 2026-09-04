# Property 360 — Known Owner/Client & Tenant Issues — CONCEPT (pre-spec)

**Status: concept only, not a spec. Nothing has been built. This document exists to get Asimov's and Mason's read on the underlying idea and its riskiest edges BEFORE Oracle writes a real spec or anything gets built.** If either of you thinks a piece of this shouldn't be built at all, or needs to be built completely differently, that's exactly the kind of input this is for — don't feel bound by the shape below.

**Origin:** Peter's own request, worked through in a live brainstorm tonight (2026-09-04). Verbatim framing of the goal, from Peter: *"I need a way to identify and summarize known owner/client issues or tenant issues. This is a potentially sensitive topic. None of this is used to make a decision but provide better context."* His example: an owner who is extremely particular about maintenance standards and has specific requirements — he wants that visible to staff before they act, not buried.

---

## 1. The problem this is trying to solve

Right now, if an owner has strong preferences (e.g., "always call before dispatching a vendor," "wants photo documentation of every repair"), or if there's a known pattern with a tenant or a neighbor dispute, that knowledge lives in individual staff members' heads or scattered emails — not anywhere a PM opening Property 360 would see it. Peter wants that surfaced, explicitly as *context for how staff handle a situation*, not as input to any housing decision (approve/deny/screen an applicant, etc. — none of that is in scope here).

## 2. Why this is being treated as more sensitive than anything else built on Property 360 so far

Everything shipped on Property 360 up to now describes *repairs and equipment* (a work order, a maintenance category, a dollar amount). This describes *people* — specifically, characterizations of how an owner or tenant behaves. That's a real, qualitative difference:

- **Owner-side** notes (maintenance standards, approval thresholds, communication preferences) are closer to ordinary CRM/relationship notes. Lower risk.
- **Tenant-side** notes are where Fair Housing exposure actually lives. A tenant labeled as someone who "complains about everything" is very often a tenant who has repeatedly reported a real habitability issue, or repeatedly requested an accommodation they're legally entitled to. A stored, permanent characterization like that — even never used to make a formal decision — can look like evidence of differential treatment or retaliation if that tenant's situation ever escalates to a real dispute. This is a well-established real-world pattern in Fair Housing enforcement, not a hypothetical.

## 3. What was worked through in tonight's brainstorm — the current shape

### 3a. Sources of a note
Peter wants two paths, both landing in the same place:
1. **Manual entry** — a staff member writes a note directly.
2. **AI-assisted, drawn from email content** — Peter wants patterns/issues surfaced automatically from correspondence, not just what someone remembers to type.

**Proposed guardrail (not yet built, needs your sign-off on whether it's sufficient):** an AI-drafted note is never shown to anyone until a human reviews and approves it (see 3c). It is a *draft/proposal*, not a published fact, until a person signs off. Whatever ships — AI-drafted or staff-typed — runs through the same two-layer Fair Housing content check (`lib/content-check.js` / `protected-class-terms.js`) already used for maintenance ticket titles and claims, before it can ever be saved or displayed.

**Open question for you both:** is "AI drafts, human approves" enough to make reading tenant email content for this purpose acceptable? Or is the act of an AI generating a characterization from tenant correspondence itself the risk, regardless of the approval gate downstream?

### 3b. Facts vs. labels — the single biggest open question, specifically for Mason
Peter's real examples: a tenant who "complains about everything," a tenant who has "threatened lawsuits," neighbors who are "fighting over trivial things."

Working through this live, the group's instinct (Peter agreed, not yet final) was to split these:
- **"Threatens lawsuits"** — legitimate liability/safety information. A property manager reasonably needs to know this to route the situation correctly (legal, insurance, escalation). Lower risk.
- **"Complains about everything" / "trivial" neighbor disputes** — proposed to represent these as **facts and counts, not subjective labels**: e.g. "12 complaints logged in the past 90 days, categories: noise (4), maintenance (6), other (2)" rather than a stored judgment like "difficult tenant" or "complains about everything." Same underlying information, but a fact is defensible; a permanent characterization is not.

**Explicit question for Mason:** is the facts/counts framing actually sufficient, or does a "high complaint count" field carry the same risk as a subjective label if complaint volume itself correlates with protected-class status (e.g., tenants exercising accommodation rights simply generate more contact volume than tenants who don't)? Is there a version of this that's actually safe, or does the tenant-side "known issues" idea need to be narrowed further — or dropped — regardless of framing?

### 3c. Who can write one, who can approve it
Current thinking (not finalized): any staff member with property access can write or propose a note; an admin has to approve it before it's visible to anyone else. This applies to both manual and AI-drafted notes.

**Open question:** is admin-approval a strong enough gate given what's at stake, or does this need a narrower author/approver pool, a second reviewer, or a different mechanism entirely (e.g., something closer to the existing flagged-content review queue, with an audit trail)?

### 3d. Where and how prominently it's shown
Peter's original framing was "front and center." Over the course of the brainstorm this shifted toward: a labeled, collapsible section on the property page — similar to how "Needs Privacy Review" or the Maintenance History Snapshot sections already work (click to open, not force-displayed) — rather than something unmissable on every page load. Not yet finalized with Peter.

### 3e. Retention
- Tenant notes: proposed to archive or expire when that tenant's tenancy ends (there's precedent for this kind of person-tied lifecycle elsewhere in this schema).
- Owner notes: no clean "move-out"-equivalent trigger exists. Proposed: some kind of periodic re-confirmation instead, not indefinite retention by default. Not yet designed.

## 4. What this is NOT

- Not used to approve, deny, or screen any applicant or tenant.
- Not a scoring or rating system.
- Not (as currently conceived) built from AI inference alone — every path requires a human sign-off before anything is visible, per 3a/3c above.

## 5. Governance path — flagged explicitly, not assumed

This project's own precedent (the "known-safe exclusions" feature parked earlier tonight, see `maintenance-history/flagged-review-grouping-and-exclusions-SPEC.md`) already established that a feature touching Fair Housing content classification at this level of sensitivity needs more than Asimov/Mason's own review to actually ship — GOVERNANCE.md Rule 6's Critical tier requires owner approval **and** actual licensed outside attorney review **and** a 7-day shadow mode before go-live. This concept doc is not asking to skip that. The purpose of this review, right now, is to get your independent read on the *direction* before Oracle spends time on a real spec — is this worth pursuing in something like this shape, does it need to be substantially narrower, or does part of it (the tenant side specifically) not belong in this tool at all.

## 6. What's being asked of you both

**Asimov:** does this fit within the governance framework as scoped, what's missing from the guardrails above, and what tier does this land in.

**Mason:** the facts-vs-labels question in 3b is the crux — is that framing actually sufficient, and is there a version of tenant-side "known issues" tracking that's genuinely safe to build, or should that half of this be dropped regardless of how it's framed. Owner-side, is there any real legal exposure worth flagging even though it's lower-risk (e.g., discoverability in a dispute with that owner).

Please push back hard on anything here — this is exactly the stage where that's cheap.
