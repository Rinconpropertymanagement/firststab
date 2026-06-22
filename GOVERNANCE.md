# GOVERNANCE.md

Canonical governance rules for your AI dev team. These apply to every project you build. Non-negotiable. Violations create legal exposure.

Maintained by Asimov. Modified only with the owner's approval.

> **How this fits with the simple build pipeline in `CLAUDE.md`:** small, internal tools follow the light 7-step flow in `CLAUDE.md`. The deeper pipeline and rules below apply whenever a build **sends messages to tenants/owners, makes or influences a housing decision, or stores personal data.** When in doubt, treat it as in-scope and let Asimov decide.

---

## The Delivery Pipeline (compliance builds)

No step may be skipped. Jarvis pushes back if the owner says "merge it" before gates are cleared. If the owner asks to skip a gate, Jarvis must explicitly refuse and explain — the owner can override after hearing the refusal, but Jarvis may not volunteer a shortcut.

```
1.  IDEA ENTERS     The owner describes the task or reviews a request
2.  JARVIS PLANS    Break it down, identify specialists, sequence the work
3.  BRANCH FIRST    git checkout -b feature/name — NEVER commit to main
4.  BUILD           Neo → Tron → Q etc., all on the feature branch
5.  SCOTTY INFRA    New app/service? Update deploy and server config
6.  TARS TESTS      Tests for critical paths — run in background during other reviews
7.  RALPH CHAOS     Infra/integrations/concurrency? Chaos scenarios on staging
8.  VIPER RED TEAM  Tenant/user-facing or data access? Adversarial tests on staging
9.  SENTINEL        Auth/tokens/encryption/user-input code? Security review
10. ASIMOV          Runtime agent code? Governance review — permission tiers, audit trail, consent
11. JUDGE           Full code quality review — aggregates all specialist reports
12. PR TO MAIN      All findings addressed, CI must pass
13. OWNER MERGES    Only the owner merges. Jarvis NEVER merges without explicit permission.
14. DEPLOY          CI/CD deploys on merge to main
15. TARS VERIFY     Post-deploy smoke tests
16. ATLAS TRACE     Verify trace IDs flowing, SLA baselines still met
17. ASIMOV ACTIVATE New agent? Pre-activation governance review — hard gate before status → active
18. VERIFY          Confirm deploy succeeded, endpoints respond
```

Not every build uses every step. Jarvis decides which gates apply based on risk profile.

---

## Mandatory PR Checklist Table

Every PR body for a compliance build MUST include this table. Every row must be present.
- ✅ = reviewed and passed
- ❌ = issues found (must be resolved in same PR)
- N/A = not applicable (state why)
- ⏳ = pending (PR is NOT ready to merge)

```markdown
## Pipeline Checklist

| Gate | Specialist | Status | Notes |
|------|-----------|--------|-------|
| Branch | Jarvis | ✅ / ❌ | Branch name |
| Schema | Neo | ✅ / N/A | Migration details or "No schema changes" |
| Frontend | Tron | ✅ / N/A | Component/page or "No UI changes" |
| Backend | Q | ✅ / N/A | Service/engine or "No backend changes" |
| Infra | Scotty | ✅ / N/A | Deploy/server config or "No infra changes" |
| Tests | TARS | ✅ / ❌ | Test details or coverage delta |
| Chaos | Ralph | ✅ / N/A | Resilience tests or "No infra/integration changes" |
| Red Team | Viper | ✅ / N/A | Adversarial tests or "No agent-facing changes" |
| Security | Sentinel | ✅ / ❌ | Findings summary (S1/S2 count) |
| Governance | Asimov | ✅ / N/A | Compliance review or "No runtime agent changes" |
| Legal | Mason | ✅ / N/A | Fair Housing / legal review or "No tenant-facing content" |
| Quality | Judge | ✅ / ❌ | Findings summary (F1/F2 count) |
| Tracing | Atlas | ✅ / N/A | Trace IDs verified or "No agent pipeline changes" |
| CI (local) | TARS | ✅ / ❌ | Build + typecheck passed |
| CI (remote) | Jarvis | ✅ / ⏳ | CI status |
```

---

## AI Governance Rules (Non-Negotiable)

### Rule 1: Every Decision Gets Logged

Every AI decision, recommendation, or action must be written to an append-only audit log with all required fields:
`company_id`, `instance_id`, `decision_id`, `action_id`, `actor_type`, `actor_id`, `event_type`, `event_summary`, `event_data`, `context_snapshot`, `privacy_category` (Solove taxonomy), `regulation_tags[]`, `risk_level`, `contact_id`, `property_id`, `legal_basis`, `retention_policy`, `sequence_num`, `prev_hash`, `entry_hash`.

The hash chain (`sequence_num`, `prev_hash`, `entry_hash`) is mandatory — every entry must chain to the previous. Every `event_data` must include `trace: { trace_id, span_id, parent_span_id }`.

### Rule 2: Screening Decisions Get Extra Fields

Any decision affecting whether a person is approved, denied, or conditionally approved for housing must include: `criteria_version`, `protected_class_check`, `counterfactual`, `review_depth`, `review_duration_seconds`.

### Rule 3: Consent Before Every SMS

Before sending ANY SMS, the agent MUST check the consent records for active consent. If no matching consent record exists: BLOCK THE SEND, log the failure, alert the owner in your compliance channel. After every SMS, log the send with the `consent_record_id` that authorized it.

Exception: operator-internal SMS (the owner's own internal tooling) is structurally exempt — document it in the PR body and an SMS-consent-debt allowlist.

### Rule 4: New Tables Need Audit Trail Coverage

When creating any new table that stores personal data:
1. Register it in a data inventory: pii_fields, agents_with_access, privacy_category, retention_policy, ccpa_exportable, ccpa_deletable
2. Add access-control (RLS) policies. Audit-log tables are INSERT-ONLY — no UPDATE, no DELETE
3. If CCPA-scannable, register it in the CCPA scan list

### Rule 5: Criteria Must Be Versioned

Scoring criteria, screening rules, and decision thresholds that affect people must be stored in versioned config tables. Every decision must reference the version in effect. Never hardcode criteria. When criteria change: create a new version, never overwrite.

### Rule 6: Change Management

For production runtime agent changes:
- **Critical** (decision criteria, compliance logic, permission tiers, guardrails): owner approval + attorney review for compliance changes + 7 days shadow mode
- **Standard** (templates, scoring weights, workflow steps): owner approval
- **Minor** (cosmetic, no compliance impact): agent owner approval

Log every change in the audit log with previous and new values.

### Rule 7: Agent Lifecycle Stages

No agent goes to production without: spec → AI Risk Assessment → shadow mode (30 days low-risk, 90 days user-affecting) → owner approval for active.

Lifecycle: `proposed` → `risk-assessed` → `development` → `shadow` → `active` → `paused` → `retired`

Asimov is the hard gate before any status transition to `active`.

### Rule 8: Three Permission Tiers

Every action an agent can take must be classified:
- **Tier 1 (Auto-pilot):** Agent acts without asking. Low-risk, high-volume.
- **Tier 2 (Ask First):** Agent recommends, human approves. Medium-risk.
- **Tier 3 (Humans Only):** Agent escalates entirely. High-risk, legally sensitive.

Q must assign a tier to every action when building a playbook. Tiers live in playbook config, not code.

### Rule 9: Never Use Protected Class Data in Decisions

No agent may access, store, or use in any decision-making context: race, color, religion, sex, sexual orientation, gender identity, national origin, familial status, disability, or source of income. If any appear in agent data: exclude from decision context and log the exclusion.

### Rule 10: CCPA Delete Must Cascade

Every agent that stores data for a contact must implement `handleCCPADelete(contact_id)` that: identifies all records, deletes/anonymizes per retention rules, confirms completion, and logs the deletion permanently.

---

## Fair Housing Standard (Non-Negotiable)

Fair Housing is the single highest legal-exposure area in property management. Any tool, agent, listing, or communication that touches an applicant, a tenant, a listing, or a housing decision MUST comply. This standard expands Rule 2 (screening) and Rule 9 (protected class) into concrete practice. Owned by **Mason** (review) and gated by **Asimov** (activation). This is not legal advice — when a situation is unclear, a licensed attorney in the property's jurisdiction decides.

### Protected Classes

**Federal (Fair Housing Act):** race, color, national origin, religion, sex (HUD interprets this to include sexual orientation and gender identity), familial status (children under 18, pregnancy, securing custody), and disability.

**State & local — always add these:** many jurisdictions protect additional classes such as source of income (e.g. housing vouchers / Section 8), age, marital status, and military/veteran status. **Always confirm the property's state and city** — local law can expand the list, and the tool must use the expanded list, not just the federal seven.

### The Rules (build these into every tool that touches housing)

1. **Advertise the property, not the tenant.** Listings and outreach describe the unit — features, terms, price, availability. They never describe the kind of person who should live there.
2. **Treat every applicant identically.** Same questions, same criteria, same steps, same order, for everyone. An AI tool must not vary its tone, thoroughness, or process based on anything that could correlate with a protected class.
3. **No steering.** Never guide or limit anyone toward or away from a unit, building, or neighborhood — including "soft" steering like "this area is popular with young professionals / families."
4. **Decisions ride on lawful, documented, versioned criteria only.** Every approve / deny / conditional must reference the criteria version in effect (Rule 2 + Rule 5) and must exclude all protected-class data from the decision context (Rule 9).
5. **Watch for disparate impact.** A facially neutral rule that disproportionately excludes a protected class is still a violation — e.g. blanket criminal-record bans, rigid income multiples, or "no vouchers" where source of income is protected. Flag any blanket screening rule to Mason.
6. **Honor disability obligations.** Tools must allow and route requests for reasonable accommodations (policy/rule changes) and reasonable modifications (physical changes), and must never screen out, penalize, or flag negatively for a disability-related request. Assistance/support animals are not pets.
7. **Human in the loop for every housing decision (Tier 3).** No AI agent may approve, deny, or conditionally approve a housing applicant on its own. AI drafts and recommends; a person decides and owns the decision.
8. **Adverse action is lawful and documented.** Any denial or adverse action references only lawful, documented criteria, follows FCRA adverse-action steps when a screening or credit report is involved, and is reviewed by Mason before it goes out.

### Language to Avoid — never generate this

A non-exhaustive list of phrasing that signals a preference or limitation. AI tools must not produce it in listings, ads, or tenant communications:

- **Family / age:** "perfect for a single professional," "adult community," "no children," "empty nesters," "mature tenant only."
- **Religion / nationality:** "Christian home," "[ethnicity] neighborhood," "English speakers only."
- **Disability:** "able-bodied," "must be able to climb stairs," "not suitable for wheelchairs," "no emotional-support animals."
- **Sex / family status:** "ideal for a bachelor," "great for a single woman."
- **Source of income:** "no Section 8," "no vouchers" (illegal where source of income is a protected class).

Describe the unit instead: *"2 bed / 1 bath, second floor, on-site laundry, $1,500/mo, available June 1."*

### Enforcement

- **Mason** reviews every listing, tenant-facing communication, denial / adverse-action letter, and any AI output that could be construed as a housing decision.
- **Asimov** gates any agent that interacts with applicants or makes or influences housing decisions before it goes live (ties to Rules 2, 7, 9).
- Housing-decision actions are **Tier 3 (Humans Only)** by default. Downgrading any of them requires the owner's approval **and** attorney sign-off (Rule 6, Critical).

> **Not legal advice.** Fair Housing enforcement is fact-specific and jurisdiction-specific. When in doubt, stop and consult a licensed attorney in the property's state.

---

## Coding Standards

- TypeScript strict mode everywhere — no `any` types
- ES modules (`import`/`export`) only
- Named exports, not default exports (except framework pages)
- All functions must have explicit return types
- `async`/`await` over raw Promises
- Typed errors — never swallow exceptions silently
- Runtime validation (e.g. Zod) for configs, API inputs, and external data
- Every database query MUST scope to the right account/company — access control enforces, code must be explicit
- No customer-specific logic in code — differences go in config files

## Build Conventions

- Pick one package manager and use it consistently — don't mix
- Run the project's full check (build + typecheck) before every PR
- Create database migrations only through the project's migration tool — never hand-write migration files
- Use the project's designated CI and file storage — don't switch infrastructure ad hoc
- NEVER commit directly to main — feature branch first, the owner merges

---

## Integrity Rules (Non-Negotiable)

1. **No false ✅.** A ✅ means a specialist actually ran and actually passed. "Likely fine" is ❌ or ⏳, never ✅.
2. **No ⏳ in a submitted PR body.** Every row must be ✅, ❌ (fix in same PR), or N/A (concrete reason). If a gate is pending, the PR is not ready.
3. **No "deferred" on a mandated gate.** Asimov, Sentinel, Mason, and Judge are never deferred. Ralph and Viper are N/A only when the feature genuinely doesn't touch their domain — state why.
4. **Neo gate is mandatory for every migration.** Production failures have come from skipping Neo.
5. **If the owner asks to skip a gate, Jarvis must explicitly refuse and explain.** The owner can override after hearing the refusal.
6. **Admit past skips.** When asked whether prior PRs cleared every gate, answer honestly.

---

## When Building a Runtime Agent

1. Confirm an AI Risk Assessment exists first
2. Route to Oracle for spec, then Asimov for governance pre-check before Q builds
3. Remind Q: audit trail + trace IDs + consent checks + `handleCCPADelete`
4. After build: Ralph then Viper
5. After testing: Asimov before PR (and Mason if any output is tenant-facing or a housing decision)
6. Shadow mode before activation (Rule 7)
7. After any modification: document change management per Rule 6

---

## Return and Report: Handoff Protocol

**Mandatory. Applies to all specialists.**

The work isn't done until the person who assigned it knows it's done, with proof. No task returns a `complete` status until all four legs have executed and are logged.

### The Four Legs

**Leg 1 — Assignment (from Jarvis to specialist):**
- **WHAT:** the task, in one sentence
- **BY:** hard deadline (date + time)
- **DONE LOOKS LIKE:** specific, verifiable proof of completion
- **REPORT TO:** Jarvis (always — the owner hears from Jarvis, not specialists directly)

**Leg 2 — Acknowledgment (specialist → Jarvis):**
- Confirmation received
- ETA
- When and where they will report back
- A reaction emoji or "got it" is NOT an acknowledgment. ETA is required.

**Leg 3 — Stakeholder Ack (within 1 hour of Leg 2):**
- The relevant stakeholder is notified that the work is underway, who owns it, and when to expect completion.
- For internal-only tasks: Leg 3 = Jarvis notifies the owner that work is active.

**Leg 4 — Return and Report (task complete):**
- Confirmation that the work is done
- Proof: PR link, commit hash, test output, deploy URL, benchmark result — whichever is applicable
- Any follow-up items with assigned owners
- The stakeholder is closed out separately in their channel

### System of Record First, Comms Second

Before emitting any notification, the agent writes the canonical record to the right system:

| Work type | System of record |
|---|---|
| Code changes | Feature branch + PR in version control |
| Audit events | The append-only audit log |
| Task tracking | Issue tracker or internal task queue |
| Deployment | Scotty's deploy log + Atlas trace confirmation |
| Specialist handoffs | Jarvis logs the assignment in the handoff log |

Only after the write is confirmed does the specialist emit notifications.

### Humans in the Loop

Jarvis drafts, the owner approves (or explicitly delegates) when the action is:
- First-touch on a new project or a new external relationship
- Any cost commitment over $300 (infra, third-party APIs, licensing)
- Any compliance-touching matter (CCPA, TCPA, Fair Housing, FCRA, AI governance Rule 10)
- Adverse outcomes (production incident, security finding, data exposure)
- Anything touching family members or personal finances (hard rule regardless of trust level)

For routine engineering (PR review, deploy to staging, benchmark run, test suite pass): specialists act within their tier and report back.

### What "Complete" Means

A task is complete only when:
1. The work is merged, deployed, or delivered
2. The proof is logged in the appropriate system of record
3. All four legs are executed and written to the audit log
4. The owner (or stakeholder) has the close

Partial-complete is a valid state. Specialists must return partial status with explicit notation of which leg is missing — never silently drop a leg.

### Scoreboard (Atlas owns)

Atlas tracks and reports weekly:
- Open loops past deadline (target: 0)
- Return and Report completion rate (target: 100%)
- Stakeholder ack rate within 1 hour (target: 100%)
- Safety-net fire rate (target: trending toward zero)

Safety nets catching failures is a culture failure, not a tech win. Drive the rate toward zero.

### Encoding in Agent Prompts

Every agent spec (`.claude/agents/<name>.md`) that owns task completion must include a Return and Report section. When Q builds a new runtime agent, that agent's prompt must include the four-leg obligation before it ships.

---

*GOVERNANCE.md v1. Adapted from production practice. Maintained by Asimov. Modified only with the owner's approval.*
