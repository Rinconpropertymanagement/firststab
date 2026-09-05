# Content-Screening Precision Redesign — Tier A / Tier B

**Status:** Draft — both Mason's and Asimov's sanity-checks are complete (2026-09-05). Mason (faithful implementation of counsel's opinion; five corrections requested and applied — broken cross-references, explicit `clear_flag` gating/acknowledgment language, `category` audit-field reconciliation). Asimov (architecture sound; four required changes, all applied — the Section 7 historical-cleanup plan's bulk-review route gap fixed with a concrete new mechanism, the Section 5 triggering-term logging exception now carries an explicit cross-tool-exposure guardrail requirement, Section 6 scope explicitly limited to `maintenance_claims` with the `maintenance_snapshot_events` gap flagged as a separate Open Item, plus the outside-counsel-provenance question — resolved: Peter confirmed directly this is real, licensed California counsel of long standing, declining only to disclose the attorney's identity to this AI system; see the provenance note atop `compliance/content-screening-redesign-outside-counsel-opinion.md`). Remaining: Peter's go-ahead to build. Nothing in this document has been built yet.
**Written by:** Oracle
**Date:** 2026-09-05
**Origin:** A full manual review of all 340 records ever flagged by the maintenance-history tool's content-safety check found a 91% false-positive rate, traced almost entirely to six overloaded dictionary words (`build-memo.js` Section 1.2). An internal (non-attorney) review proposed a Tier A/Tier B fix with six required safeguards (`build-memo.js` Section 1.3/1.4). **Real outside counsel reviewed that proposal and issued a formal opinion (`compliance/content-screening-redesign-outside-counsel-opinion.md`, received 2026-09-05, verdict GREEN) that is substantially more permissive than the internal review across nearly every question.** Per standing project instruction, counsel's opinion is authoritative and supersedes the internal review wherever they conflict. This spec implements counsel's actual framework, using the internal memo only as a starting skeleton — see Section 1 for exactly where and why this diverges from the internal memo's six safeguards.

**Built from, read in full:**
- `compliance/content-screening-redesign-outside-counsel-opinion.md` — the controlling document for every judgment call below.
- `projects/hub/maintenance-history/scratch-docs/build-memo.js`, Sections 1.1–1.6 — the problem data (91% FP rate, the six-term breakdown), the internal review's original Tier A/Tier B design and six safeguards, and the six questions counsel answered.
- `projects/hub/maintenance-history/lib/content-check.js`, `lib/protected-class-terms.js`, `lib/extract-claims.js` (full files) — the real, current two-layer mechanism this spec modifies. `extract-claims.js`'s `EXTRACTION_PROMPT_HEADER` (lines 78–110) is Layer 2's actual self-report instruction, unchanged by this spec.
- `projects/hub/maintenance-history/router.js` — `writeAuditLog` (line 238), `applyReviewAction` (line 1797), `requireAcknowledgment` (line 268), `safeTicketTitle` (lines 542–577), the flagged-queue and bulk-review routes (lines 2183, 2440), `PRIVACY_REVIEW_ROLES` (line 167) — the real precedent and real constraints for every review-workflow and logging decision below. The single call site of `checkClaim()` is line 3069.
- `projects/hub/maintenance-history/flagged-review-grouping-and-exclusions-SPEC.md` — the prior, already-reviewed attempt at a related fix (a static exclusion list). Its Part 2 was blocked by Mason and Asimov for a specific reason directly relevant here (Section 10).
- `supabase/migrations/20260815010000_maintenance_history_schema.sql`, `20260815000000_audit_log_rule1_compliance.sql`, `20260720000003_foundation.sql` — the real `maintenance_claims` schema and the real `audit_log` columns.
- `GOVERNANCE.md` Rule 6, Rule 9 — the internal governance discipline that applies on top of counsel's clearance, unaffected by it.
- `projects/hub/maintenance-history/SPEC.md` — "The Content Check," "Audit Logging," "Review Gate" sections, for the tool's own documented conventions.
- `projects/hub/property-360/owner-tenant-operational-notes-SPEC.md` — structural template for this document.

---

## 1. What Changed, Concretely

| Internal review proposed | Counsel says |
|---|---|
| Design goal: maximum suppression of anything protected-class-adjacent | "The design objective should no longer be maximum suppression... It should be reasonably accurate identification of information that presents an actual Fair Housing concern while allowing trained... personnel to exercise professional judgment." |
| Tier B question: could this "reasonably be understood as a coded or indirect reference" | "If you ask an AI whether virtually any sentence 'could reasonably be understood' as coded discrimination, you invite another wave of false positives." Use a narrower, actual-meaning standard instead (Section 4). |
| Prospective-only; never touch the 340 historical records | "There is no obvious legal reason you cannot apply improved logic to historical records... if doing so has operational value." Now Rincon's engineering call (Section 7). |
| At least 3 tailored question formulations (color / blind / diagnosis-age) | "Not legally required... If one well-designed contextual classifier performs better, use it." Now Rincon's engineering call (Section 4). |
| Full comparison period, 100% of disagreements reviewed before the new logic controls anything | "Good for initial rollout but not legally mandated... I would be comfortable with: historical validation → short live parallel test → management review of mistakes → production deployment → periodic sample audit." (Section 8). |
| Ongoing, heavy periodic audit of "cleared as object" decisions | "Keep it, but use reasonable sampling. No reason for heavy permanent oversight if the system demonstrates good accuracy." (Section 8). |

Two things counsel did **not** change, and this spec carries forward unchanged:
- **Safeguard 1 (don't touch the shared matcher) stays, in full** — counsel calls it "sensible engineering control... not Fair Housing law," and it protects a real, separate, already-identified dependent (Section 3).
- **Source-of-income/Section 8 stays Tier A** — no measurable false-positive problem exists in this data (2 real occurrences in 17,867 records), and counsel is explicit this is a reasonable-but-not-mandatory choice Rincon can revisit later (Section 1.5 of `build-memo.js`).

---

## 2. Scope — What This Spec Does and Does Not Redesign

Counsel's opinion makes one much bigger point than the Tier A/B mechanics: property-management staff are allowed to see genuinely operational protected-class-adjacent information (her own examples: "tenant uses a wheelchair, ensure ramp access," "Section 8 inspector requires correction by Friday") displayed normally, not automatically quarantined pending review, when it's clearly operational.

**This spec does not build that.** It is scoped to *precision* — making the flag correctly distinguish "this text is actually about a protected characteristic" from "this text just happens to contain an overloaded word" — not to redesigning what happens *after* something is correctly and genuinely flagged. A real wheelchair mention stays Tier A (see below) and, once flagged, still goes to the same "Needs privacy review" quarantine queue as it does today, because "wheelchair" produced zero false positives in the 340-record review — the keyword scan already correctly identifies it as genuine, so this precision fix has nothing to improve there.

Counsel's broader vision — should genuinely-operational protected-class content bypass quarantine and display normally to the right role, the way `owner-tenant-operational-notes-SPEC.md`'s three-tier access model already does for a different tool — is a real, separate, larger feature. It is flagged as a natural follow-on project (see the "Open Items" section at the end of this document) and is explicitly out of scope here so it doesn't get silently half-built as a side effect of a precision fix.

Also unchanged and out of scope: the OR relationship between (Tier A or confirmed Tier B) and Layer 2 — Layer 2 can still only *add* a flag, never veto one (Section 3); the entire Tier A dictionary itself; and Layer 2's own self-report prompt in `extract-claims.js`.

---

## 3. The Actual Code Change

### 3.1 What must never move (Safeguard 1, kept in full)

`protected-class-terms.js`'s `scanText()` is called from a second, independent place: `router.js`'s `safeTicketTitle()` (lines 542–577), which scans raw AppFolio ticket titles/descriptions directly and swaps in a placeholder (`APPFOLIO_TEXT_PLACEHOLDER`) if flagged. It is gated only by `requireMaintenanceHistoryAccess` — broader than the `PRIVACY_REVIEW_ROLES` gate on the review queue — with no acknowledgment gate. Asimov's own review of `flagged-review-grouping-and-exclusions-SPEC.md` already found this exact dependency and required that any future change "scope strictly to the content-check pipeline (`checkClaim()`)... `safeTicketTitle()` must keep using an exclusion-unaware scan, always."

**This spec makes zero changes to `protected-class-terms.js`.** Not even adding a `tier` field to its `CATEGORIES` data — the safest reading of Safeguard 1 is that the file is frozen, full stop, so there is no risk whatsoever (accidental or otherwise) to `safeTicketTitle()`, the line-887 synthesis-output check, or `clusterFlaggedRows()`. All new Tier A/B logic, including the list of which six terms are Tier B, lives as new data and new code inside `content-check.js` (or a new sibling file it imports), which nothing else in the codebase calls.

### 3.2 What changes: `content-check.js`

`checkClaim()` becomes **async** (it now has to make a network call for Tier B terms). Its one call site, `router.js:3069`, changes from `const check = contentCheck.checkClaim(candidate);` to `const check = await contentCheck.checkClaim(candidate);` — a small, findable ripple, confirmed to be the only call site in the codebase for this specific function.

```js
// lib/content-check.js — illustrative design, not final code

const { scanText, TERMS_VERSION } = require('./protected-class-terms'); // UNCHANGED import, UNCHANGED call
const { classifyTierBTerm, TIER_B_CLASSIFIER_VERSION } = require('./tier-b-classifier'); // NEW file, Section 4

// The six terms responsible for ~91% of the 340-record false-positive volume
// (build-memo.js Section 1.2). Defined HERE, not in protected-class-terms.js —
// see 3.1. Must exactly match the lowercase strings scanText() returns in
// matchedTerms (confirmed against protected-class-terms.js's CATEGORIES).
const TIER_B_TERMS = new Set(['white', 'black', 'blind', 'diagnosis', 'diagnosed', 'too old', 'too young for']);

// Kill switch: set to the literal string 'false' to make every Tier B term
// behave exactly like Tier A (immediate flag, no AI call) — an instant,
// code-free rollback lever if the classifier misbehaves in production.
// Defaults to enabled.
const TIER_B_ENABLED = () => process.env.TIER_B_CONTEXTUAL_CHECK_ENABLED !== 'false';

async function checkClaim(claim) {
  const layer1 = scanText(claim.claim_text); // UNCHANGED — scanText() itself never modified
  const layer2Hit = !!claim.modelFlag;

  const tierATerms  = layer1.matchedTerms.filter(t => !TIER_B_TERMS.has(t));
  const tierBTerms  = layer1.matchedTerms.filter(t =>  TIER_B_TERMS.has(t));

  let tierBResults = [];   // returned so the caller can write one audit_log
                            // entry per Tier B term checked — see Section 5
  let tierBFlagged = false;

  if (tierBTerms.length > 0) {
    if (!TIER_B_ENABLED()) {
      // Kill switch engaged: Tier B behaves exactly like Tier A did before
      // this change (immediate flag), and no AI call is made.
      tierBFlagged = true;
      tierBResults = tierBTerms.map(term => ({
        term, category: categoryOf(term), classification: 'kill_switch_engaged',
        disposition: 'flagged', model_version: null,
      }));
    } else {
      tierBResults = await Promise.all(tierBTerms.map(term =>
        classifyTierBTerm({ term, category: categoryOf(term), claimText: claim.claim_text })
        // classifyTierBTerm() itself fails closed: any error, timeout, or
        // unparseable response resolves to { classification: 'ambiguous' }
        // rather than throwing — see Section 4.
      ));
      tierBFlagged = tierBResults.some(r => r.classification !== 'ordinary');
      // 'protected' -> flagged. 'ambiguous' -> flagged (counsel: "identify
      // it for human judgment rather than assuming discrimination" — the
      // review queue IS that human-judgment routing mechanism).
    }
  }

  const layer1Flagged = tierATerms.length > 0 || tierBFlagged;
  const flagged = layer1Flagged || layer2Hit; // OR with Layer 2 UNCHANGED —
                                                // Layer 2 still only adds, never vetoes

  if (!flagged) {
    return { flagged_protected_class: false, flagged_category: null, matched_layer: null, terms_version: TERMS_VERSION, tier_b_results: tierBResults };
  }

  const categories = new Set([...tierATerms.map(categoryOf), ...(tierBFlagged ? tierBTerms.map(categoryOf) : [])]);
  if (layer2Hit && claim.modelCategory) categories.add(String(claim.modelCategory).trim());
  else if (layer2Hit) categories.add('model_judgment_unspecified');

  // matched_layer gains tier granularity (a JS string, not a DB column — no
  // migration involved). Existing values 'keyword'/'model'/'keyword+model'
  // become tier-specific; any code or dashboard reading these strings
  // needs updating alongside this change — flagged for Q.
  let matched_layer;
  if (tierATerms.length > 0)      matched_layer = layer2Hit ? 'keyword_tier_a+model'          : 'keyword_tier_a';
  else if (tierBFlagged)          matched_layer = layer2Hit ? 'keyword_tier_b_confirmed+model' : 'keyword_tier_b_confirmed';
  else                             matched_layer = 'model';

  return {
    flagged_protected_class: true,
    flagged_category: Array.from(categories).join(', '),
    matched_layer,
    terms_version: TERMS_VERSION,
    tier_b_results: tierBResults, // [] if no Tier B term matched
  };
}
```

`categoryOf(term)` is a two-line lookup against the same four groupings used for the classifier hints (Section 4) — trivial, but new, small code, not reused from `protected-class-terms.js`.

---

## 4. The Tier B Question(s) — One Classifier, Four Parameter Sets

**Engineering decision (counsel removed the "at least 3 tailored prompts" requirement — Safeguard 3 — and left this to Rincon):** build **one** classifier function and **one** prompt template, parameterized per term-group, not three-or-more separate prompt bodies.

Reasoning:
- Counsel's own base question is already written generically enough to cover all six terms as-is; the only thing that needs to vary per term is a short, concrete description of "the protected thing" and "the ordinary thing" — a data lookup, not a logic fork.
- One prompt means one thing to validate against the 340-record backtest (Section 7) and one thing to tune if accuracy is uneven across terms — a smaller, more tractable surface than three-plus independently-drifting prompts.
- If validation later shows one term-group performs meaningfully worse than the others, that is the trigger for giving *that* group its own refined hint text or, if truly necessary, its own prompt — not decided in advance of any evidence that it's needed.

**The four parameter sets** (`categoryOf()` and the hint lookup share this table):

| Group | Terms | Category | "Protected" hint | "Ordinary" hint |
|---|---|---|---|---|
| Color | `white`, `black` | `race_color` | a person's race, ethnicity, or skin color — including a stated racial/ethnic preference about a tenant, neighborhood, or household | a paint color, a fixture or appliance finish or material, a brand name that happens to include a color word, or a similar object/product/repair description |
| Blind | `blind` | `disability_health` | a person's visual impairment or blindness | a household item (window blinds) or an unrelated use of the word (e.g. "blind spot") |
| Diagnosis | `diagnosis`, `diagnosed` | `disability_health` | a person's medical condition, disability, or health diagnosis | a technician's or vendor's diagnosis of a mechanical, electrical, plumbing, or appliance fault |
| Age/device | `too old`, `too young for` | `age` | a person's age — including an age-based housing preference or restriction | a piece of equipment, fixture, appliance, or hardware described as worn out, outdated, or unsuitable for its purpose |

**The prompt template**, built directly from counsel's own base question (Question 2 of the opinion), not the internal memo's broader "coded or indirect" standard:

```
You are reviewing a single sentence from a property-management maintenance
record, for one narrow question. Do not evaluate the sentence for anything
else.

Sentence: "{claim_text}"

The word or phrase in question: "{term}"

Question: In this sentence, does "{term}" actually communicate or
materially imply information about {protected_hint}, rather than
describing {ordinary_hint}?

If the answer is genuinely ambiguous, say "ambiguous" — do not guess, and
do not assume discrimination is present just because the word could
theoretically be read that way.

Respond with exactly one word: "protected", "ordinary", or "ambiguous".
```

`classifyTierBTerm({ term, category, claimText })` fills the template, makes one `@anthropic-ai/sdk` call (same package and account already used by `extract-claims.js`, so this introduces no new AI-vendor question — see Section 10), and maps the response to `{ term, category, classification, disposition: classification === 'ordinary' ? 'cleared' : 'flagged', model_version: TIER_B_CLASSIFIER_VERSION }`. Any exception, timeout, or a response that isn't exactly one of the three expected words resolves to `classification: 'ambiguous'` rather than throwing — the fail-closed default the internal memo specified is kept here in full, and now covers both AI uncertainty *and* infrastructure failure identically.

`TIER_B_CLASSIFIER_VERSION` (e.g. `'tier-b-classifier-v1'`) is versioned independently of `protected-class-terms.js`'s own `TERMS_VERSION` — a prompt change here doesn't imply a dictionary change, and vice versa. Bump it whenever the template or hint text changes, same discipline `TERMS_VERSION` already uses.

---

## 5. Data Model — What Gets Logged Where

**Checked against the real schema before deciding anything:** `maintenance_claims` (`20260815010000_maintenance_history_schema.sql`) and `audit_log` (`20260815000000_audit_log_rule1_compliance.sql`).

**No new columns on `maintenance_claims`.** `flagged_protected_class`/`flagged_category` already say everything a claim's *current* state needs to say. `matched_layer` and the Tier B classification detail are transient, not persisted on the row — they exist only in memory (returned by `checkClaim()`) and in `audit_log`, exactly like `matched_layer` already works today for the keyword/model distinction.

**One small, necessary schema change:** `review_status`'s CHECK constraint needs one new value, `cleared_false_positive`, to make the two-way override (Section 6) auditable and distinguishable from the existing three actions. Today's vocabulary — `unreviewed`, `confirmed`, `corrected`, `rejected` — has no value that means "a flag was determined to be wrong and reversed"; overloading `corrected` (which already means "the claim's own text was edited") would blur two different things behind one label in a compliance-sensitive column. This is the **only** schema change this spec requires, and it's additive (a Neo-owned DROP-then-ADD CHECK widen, the same pattern already used twice in this schema for `team_member_tool_roles`):

```sql
ALTER TABLE maintenance_claims
  DROP CONSTRAINT IF EXISTS maintenance_claims_review_status_check;

ALTER TABLE maintenance_claims
  ADD CONSTRAINT maintenance_claims_review_status_check
  CHECK (review_status IN ('unreviewed', 'confirmed', 'corrected', 'rejected', 'cleared_false_positive'));
```

(The other override direction — staff manually flagging an AI-cleared item — reuses the existing `confirmed` value as-is: "a human looked at this and confirmed a flag belongs here" already fits that action's meaning without a new value.)

**Audit logging — deliberately lean, per counsel's Question 5.** Retain exactly what counsel asked for and nothing more: the triggering term, the classification, date/time, model/rule version, disposition, and any human override. Do **not** log the full prompt, the full AI response text, a confidence score, or a reasoning chain — counsel's own words: this "can create a second sensitive database without much legal benefit." `claim_text` itself stays only in `maintenance_claims`, the normal system of record — never duplicated into `audit_log.details`.

**A deliberate, narrow exception to this codebase's existing "never log the matched term" rule — flagged explicitly for Asimov/Mason, not slipped in quietly.** `protected-class-terms.js`'s own header, and `flagged-review-grouping-and-exclusions-SPEC.md`'s Part 1 design, both establish that a matched term must never be written to `audit_log` because, out of context, it could itself hint at sensitive content. Counsel's Question 5 answer explicitly requires retaining "the triggering term" for every AI-decision record. This spec resolves the tension narrowly: the exception applies **only** to the six already-fully-disclosed Tier B terms (named in this very document, in `build-memo.js`, and in the production code) for Tier B classification events specifically — never to Tier A's much larger and more sensitive term set, and never to `claim_text` itself. Logging that a Tier B check fired on "white" reveals nothing beyond what `flagged_category = 'race_color'` already discloses; it just makes the classification auditable the way counsel asked for.

**Required condition on this exception, per Asimov's review (2026-09-05) — the safety claim above assumes `audit_log` read access stays scoped to `PRIVACY_REVIEW_ROLES`, and that assumption isn't currently enforced anywhere.** Asimov verified `audit_log` is a single shared table written by at least six different Hub tools (call-stats, insurance-compliance, security-deposit, owner-tenant-notes, approval-briefing, maintenance-history) and confirmed no route today reads `audit_log.details` back to any UI — so there is no *current* leak, but also no code-level guarantee against a *future* generic "activity log" viewer, built for any of those other five tools, surfacing `tier_b_classification.details.triggering_term` to an audience wider than maintenance-history's own reviewers. Required before Q builds this: (1) Q must confirm, before writing the `tier_b_classification` insert, that no existing cross-tool audit-log reader exists that isn't already scoped to `PRIVACY_REVIEW_ROLES`; (2) add a one-line comment on this new audit action's write call, and a corresponding one-line addition to `protected-class-terms.js`'s own header, pointing at this exact section as the one named, Asimov/Mason-approved exception to "never log the matched term" — so a future engineer building a generic audit-log viewer for some other tool sees the guardrail before accidentally exposing it, rather than reading the header's general rule as either false or as an invitation to add further exceptions without another governance pass.

**New audit_log action, `maintenance_claims.tier_b_classification`** — fires for **every** Tier B term match, whether cleared or flagged (a genuine addition: today's system only logs an event when something *is* flagged; counsel wants both outcomes retained):

| Field | Value |
|---|---|
| `action` / `event_type` | `maintenance_claims.tier_b_classification` |
| `entity_type` / `entity_id` | `maintenance_claim` / the claim's id (written after insert, once the id exists — same ordering the existing `protected_class_excluded` entry already uses) |
| `actor_type` | `ai_agent` |
| `actor_id` | `maintenance-history-tier-b-classifier` |
| `actor_version` | `TIER_B_CLASSIFIER_VERSION` |
| `privacy_category` | `processing` |
| `risk_level` | `high` if disposition is `flagged`, `low` if `cleared` |
| `details` | `{ triggering_term, category, classification, disposition }` — **never** `claim_text`, the prompt, the raw model response, or a confidence score |

**On `category` specifically, per Mason's review (2026-09-05):** counsel's Question 5 answer enumerates triggering term, classification, date/time, model/version, and disposition — `category` isn't on that literal list. It's kept anyway, deliberately: it's fully derivable from the already-disclosed triggering term via the public Section 4 table (e.g., "white" only ever maps to `race_color`), so logging it discloses nothing the triggering term hasn't already disclosed — it just saves a lookup when reading the log later. Reconciled explicitly here rather than left as an implicit assumption.

**Open build item, flagged precisely, not glossed over:** `writeAuditLog()` as it exists today (`router.js:238`) takes `actor_email` and hardcodes `actor_type: 'human'` / `actor_id: <that email>` — it has no path for an `ai_agent` actor. `SPEC.md`'s own "Audit Logging" section describes `ai_agent`/`system`-actor entries for ingestion-time events (`ingestion_run`, `protected_class_excluded`), so *some* insert path for non-human actors must already exist in the ingestion route (it wasn't in the code this spec's research pulled). Before building the `tier_b_classification` write: **find and reuse whatever mechanism already writes today's `protected_class_excluded` entries** (they already carry `actor_type: 'ai_agent'`/`'system'` per SPEC.md) rather than assuming `writeAuditLog()` can be called as-is — extend it with optional `actor_type`/`actor_id`/`actor_version` parameters (falling back to today's human-actor default when omitted) if no such path already exists. A small, concrete verification step for Q, not a design gap in this spec.

**New audit_log action for the human override, `maintenance_claims.protected_class_flag_overridden`** (Section 6) — this one *is* a human actor, so it reuses `writeAuditLog()` exactly as it works today, with `actor_email` = the reviewer:

| Field | Value |
|---|---|
| `details` | `{ direction: 'cleared' \| 'flagged', previous_flagged_protected_class, new_flagged_protected_class, previous_category, new_category, reviewer_notes }` |
| `risk_level` | `medium` for `cleared` (loosens a protection, but is itself a controlled, justified, audited action), `high` for `flagged` (a genuine new protected-class flag — same level today's exclusion events already use) |

---

## 6. Two-Way Human Override

**A real gap found while designing this, not assumed away:** today, `applyReviewAction`'s allowed actions are exactly `confirm` / `correct` / `reject` (`router.js:1797`), and none of them ever touches `flagged_protected_class` — only `review_status`. Concretely, `reject`-ing a flagged claim today sets `review_status = 'rejected'` but the claim stays `flagged_protected_class = TRUE` forever, permanently excluded from `maintenance_claims_decision_safe` no matter what a human decides. There is currently **no way at all** to release a flagged claim back to normal visibility, and no way to flag a claim that wasn't already caught. Counsel's requirement 7 (explicit two-way override) needs two small, new, real capabilities:

**Clearing an AI/Tier-A flag (e.g., "Bradford White 50-gallon heater" wrongly flagged as race).** A new `applyReviewAction` action value, `clear_flag`, usable on any currently-flagged claim regardless of its current `review_status` (unlike the existing three actions, this doesn't require `guardUnreviewed`, since the whole point is overriding a *completed* prior disposition too). Effect: `flagged_protected_class → FALSE`, `review_status → 'cleared_false_positive'`, `flagged_category` **left in place** as historical record of what it used to be flagged for (the `maintenance_claims_flag_requires_category` CHECK constraint only requires a category *when* `flagged_protected_class = TRUE`, so this is already valid — no constraint change needed for this). This single column flip is sufficient to make the claim reappear in `maintenance_claims_decision_safe` — no view change needed, since that view already reads `flagged_protected_class = FALSE AND review_status != 'rejected'`, both satisfied.

**Flagging an AI-cleared item (staff recognizes something the system missed).** A new endpoint, `POST /api/maintenance-history/claims/:id/flag`, gated to `PRIVACY_REVIEW_ROLES`, usable on any claim regardless of its current flag state (the existing flagged-queue routes only ever operate on already-flagged items, so this can't reuse them as-is). Calls `applyReviewAction` with a new action value, `flag`: `flagged_protected_class → TRUE`, `flagged_category →` the category the staff member selects from `protected-class-terms.js`'s existing `CATEGORIES` keys (reusing the existing vocabulary, not inventing a new one), `review_status → 'confirmed'` (a human already looked at this and confirmed a flag belongs here — the existing value already fits).

**Both new actions require non-empty `reviewer_notes`** — unlike the three existing actions, where notes are optional. Reversing a Fair Housing content-safety disposition, in either direction, should always carry a stated reason. Both write the new `maintenance_claims.protected_class_flag_overridden` audit action (Section 5), distinct from the generic `.reviewed` action the existing three transitions use, so "how often is this override actually used" is directly queryable later without wading through routine corrections. **One guideline for whoever writes `reviewer_notes` on either action: describe the disposition, don't quote or paraphrase the flagged text itself into the notes field** — that field isn't subject to the same content-check/redaction discipline as `claim_text`, so copying sensitive text into it would create an uncontrolled second copy.

**Access gating and acknowledgment, stated explicitly per Mason's review (2026-09-05) rather than left inferred:**
- `clear_flag` is exposed through the same existing route(s) that already handle `confirm`/`correct`/`reject` for claims (`router.js:2183`/`2440`), which are already gated to `PRIVACY_REVIEW_ROLES` — no new route, no new gate to add, but stated here directly since this is the toggle that turns off a Fair Housing flag and deserves an explicit statement, not an inference. The new standalone `POST .../flag` endpoint (above) is separately, explicitly gated to `PRIVACY_REVIEW_ROLES` in its own right.
- `requireAcknowledgment` applies to `clear_flag` but not, by the existing mechanism's own logic, to `flag`. `applyReviewAction`'s acknowledgment check (`router.js:1821-1824`) only fires `if (requireAck && before.flagged_protected_class)` — i.e., it exists specifically to warn a reviewer before they see content that is *already* flagged. `clear_flag` runs against `before.flagged_protected_class = TRUE` by definition (that's the whole point — a reviewer is about to look at already-flagged claim text to judge whether to release it), so it must be called with `requireAck: true`, extending Mason's original condition on `director_of_operations`'s exposure to this exact category of content to this new action too. `flag` runs against `before.flagged_protected_class = FALSE` by definition (an item nobody flagged yet) — the gate's own trigger condition doesn't apply, and the staff member is the one bringing the concern forward, not being exposed to a pre-existing flag they didn't choose to look at. This asymmetry is intentional, not an oversight, and Q should not add an acknowledgment check to `flag` "for consistency" without re-checking this reasoning first.

**Scope, per Asimov's review (2026-09-05): `claims` only, deliberately, not `maintenance_snapshot_events`.** Verified directly against the code: `maintenance_snapshot_events`'s `flagged_protected_class` is never set via `content-check.js`'s `checkClaim()` at all — it goes through a completely separate path (`backfill-maintenance-snapshot.js`, a live `scanText()` rescan with no Layer 2, no Tier A/B distinction, and no `matched_layer` ever persisted, per `router.js`'s own comment at lines 2056-2064). This entire spec's Tier A/B fix — the classifier, the six terms, the kill switch — only ever touches `checkClaim()`, so it has **zero effect on snapshot events either way**. Extending `clear_flag`/`flag` to that table would let a reviewer override a flag that was never run through Tier B in the first place, which doesn't match this spec's actual fix. **This is correctly out of scope, not an oversight** — but it does mean `maintenance_snapshot_events` may have its own, unexamined false-positive rate on these same six words, since it uses a plain Layer-1-only scan with no precision fix of any kind. Flagged as a real, separate Open Item below, not assumed away.

---

## 7. The Historical 340 Records — Recommendation

Counsel found no legal bar to reprocessing them. The engineering question is real, though: an automated bulk `UPDATE` against a live compliance table, touching records that already went through a completed manual review, is exactly the kind of "don't casually touch a live compliance system's historical record" move that deserves caution independent of whether it's legally permitted.

**Recommendation: clean them up, but not via a bulk script — reuse the exact two-way-override mechanism just built (Section 6), with the new classifier doing triage, not the change itself.**

1. **Sequence this *after* the live parallel test (Section 8.2), not simultaneously with first deployment.** By the time the historical cleanup happens, the same classifier version has already been validated against new, live records — it isn't being trusted with a bulk historical change on day one of its existence.
2. Run the Tier B classifier (Section 4) against each of the 340 records' already-stored `claim_text`, purely as a **triage pass** — this produces a suggested disposition per record, nothing more. No row is changed by this step.
3. Surface the results through the **already-approved grouped-review view** (`flagged-review-grouping-and-exclusions-SPEC.md` Part 1, cleared to build independent of this spec) — cluster the 340 by matched Tier B term, annotate each cluster with the classifier's suggested disposition, and let a `PRIVACY_REVIEW_ROLES` reviewer bulk-apply `clear_flag` to a whole cluster in one action once they've looked at the sample shown.

   **Required fix, per Asimov's review (2026-09-05), code-verified — the existing bulk-review route cannot do this as-is.** `POST /api/maintenance-history/flagged-queue/bulk-review` (`router.js:2440-2510`) hardcodes its allowed actions to `['confirm', 'reject']` only (line 2444 — no `clear_flag`), and unconditionally rejects any item where `review_status !== 'unreviewed'` (line 2477) *before* ever calling `applyReviewAction`. Every one of the 340 historical records is, by this section's own premise, already reviewed — so every single one would be rejected by this route exactly as it exists today. This needs a real, small addition, not a workaround: either (a) a new `bulk-clear-flag`-style route, or (b) a new branch inside the existing route, that (i) adds `clear_flag` to the allowed-actions list, (ii) for `clear_flag` specifically, checks `flagged_protected_class = TRUE` as the eligibility bar instead of `review_status === 'unreviewed'` (an already-reviewed, currently-flagged record is exactly what this action targets), and (iii) calls `applyReviewAction` with `guardUnreviewed: false` for this action only, carrying forward every other safeguard the existing route already has unchanged (the fresh per-id re-check right before acting, the live rescan to derive the audit category, the per-item audit trail, the batch-size cap). This is new, small, real code — not a configuration change — and Q should size it accordingly rather than assume the existing route already covers this case.
4. **Every actual change still goes through a human clicking `clear_flag`** — there is no automated bulk `UPDATE` script touching `maintenance_claims` at all. This captures nearly all of the operational value (a reviewer processing 300 pre-sorted, likely-false-positive items via the grouped view is fast) while adding zero new risk beyond what Section 6's override mechanism already carries and has already been reasoned through.
5. This reuses code that already has to exist for ordinary, ongoing operation — no separate one-off historical-migration script to write, review, and then never run again.

This is a genuine, considered recommendation (do the cleanup) delivered the lowest-risk way available (never automated, always human-executed, sequenced after the mechanism is already proven) — not a deferral disguised as caution, and not a bulk mutation disguised as safe.

---

## 8. Validation & Rollout Plan

Counsel: "historical validation against the 340 records → short live parallel test → management review of mistakes → production deployment → periodic sample audit." Sized concretely below. Rincon's own internal governance discipline (`GOVERNANCE.md` Rule 6, unaffected by counsel's opinion) separately requires a minimum 7-day shadow mode for any Critical-tier compliance-logic change — the plan below is set to comfortably clear that floor regardless of what counsel would have permitted on its own.

**Step 0 — Classifier backtest (new, cheap, not previously done).** The internal memo's own validation (the "crude proxy," 91%/60% resolution on color/blind-diagnosis) tested the *concept*, not the real prompt. Before shipping anything, run the actual `classifyTierBTerm()` against the 340 records' real `claim_text` and record its accuracy against the already-known-correct human determination. Cheap (the data already exists), and it's the same pass Section 7 needs anyway for the historical-cleanup triage — do it once, use it twice.

**Step 1 — Short live parallel test, 2 weeks (or until 25+ new Tier B term matches have accumulated, whichever is longer, so a slow stretch doesn't produce a thin sample).** New Tier B logic runs and its classification is logged (`tier_b_classification`, Section 5) on every new claim, but does **not** yet control `flagged_protected_class` — Tier B terms still auto-flag exactly as they do today during this window (i.e., the kill switch from Section 3.2 is left engaged for the duration of the test). This is deliberately *not* the internal memo's "100% of disagreements reviewed before any autonomy" standard — it's a bounded, time-boxed window producing a bounded, reviewable disagreement set.

**Build-time finding, resolved by Peter's explicit decision (2026-09-05): the kill switch as actually built is binary (off / fully live), not three-state.** There is no code path where Tier B computes and logs a classification while the *old* logic still controls the real flag — engaging the switch means Tier B's result immediately and fully controls `flagged_protected_class`. Q flagged this gap between Section 8's narrative (above) and Section 3.2's literal design during the build. Presented with the choice (build the missing three-state shadow mode first, or accept going straight to full production authority on the strength of the historical backtest and build-time verification alone), **Peter chose to go live immediately, explicitly accepting no live observation window before the classifier gets real authority.** Deployed live 2026-09-05 (`TIER_B_CONTEXTUAL_CHECK_ENABLED=true` on production) — confirmed working correctly against real production code and a live Anthropic call immediately after: a literal "Bradford White 50-gallon water heater" claim (the original false-positive example this whole redesign exists to fix) correctly clears, and a genuine race-related claim correctly flags. Steps 1-2 below are therefore superseded for this rollout — the system went directly from Step 0 (backtest) to Step 3 (production). The periodic sample audit (Step 4) is now the only real-world check on this classifier's ongoing accuracy and should not be treated as optional given the shortened path here.

**Step 2 — Management review of mistakes.** At the end of the 2-week window, whoever holds a `PRIVACY_REVIEW_ROLES` role pulls every case where the new classifier's logged classification *disagreed* with what actually happened under the still-live old logic — i.e., every "ordinary" classification (since everything was still being auto-flagged during the test, every Tier B hit currently in the queue is a candidate; the ones the new logic would have cleared are the ones that matter). This is a bounded review — the disagreements only, not the full window's volume — and is the concrete meaning of "management review of mistakes" for this system.

**Step 3 — Production deployment.** Once that review confirms the new logic's would-be clearances look right (not a zero-error bar — counsel: "I would not make 'zero errors' the release criterion"), disengage the kill switch. Tier B now actually controls `flagged_protected_class` for new claims.

**Step 4 — Periodic sample audit.** Monthly for the first quarter after go-live (higher initial vigilance, matching the review cadence already used elsewhere in this codebase for a comparably new grant — `owner-tenant-operational-notes-SPEC.md`'s 30–60 day heightened-review period), then quarterly thereafter. Sample: 100% of `flagged` Tier B classifications in the period (the false-negative direction — a real protected-class reference wrongly cleared — is the higher-consequence one to catch, and "flagged" is the smaller-volume set to review in full) plus a spot sample of roughly 20–25 `cleared` classifications. Reviewed by Mason or whoever holds the tool's `reviewer`/`admin` role; a brief written note (date, sample size, findings) is enough — this does not need its own `audit_log` action to satisfy the lean-logging standard, though logging just the fact that a periodic audit occurred (no sensitive content) is cheap and consistent with the spirit of Section 5, and is left as an easy optional addition.

---

## 9. Management Risk Memo — Outline (Not the Final Prose)

Counsel: not legally required, but recommended as good governance practice, roughly 2–3 pages. This is an outline for Peter/Mason to write the actual prose from — not something Q builds in code.

1. **Purpose** — why this system exists (Fair Housing content screening for maintenance records) and why this specific change was made.
2. **The Problem** — the 91% false-positive finding, the six-term breakdown (the table in `build-memo.js` Section 1.2 can be reused directly).
3. **What's Changing** — the Tier A/Tier B mechanism, in plain language: unchanged terms still auto-flag; six specific terms now get a targeted, narrow contextual check before flagging.
4. **What Data Is Involved** — maintenance ticket text already being processed today; no new data source, no new AI vendor relationship (Section 4).
5. **Human Review & Override Availability** — the existing "Needs privacy review" queue, plus the new two-way override (Section 6): staff can clear a wrong flag or add a flag the system missed, in either direction.
6. **Expected Benefit** — fewer false positives cluttering the review queue; counsel's own point that an overly-sensitive system risks staff disregarding it when something real appears.
7. **Testing Performed** — the historical backtest (Step 0), the live parallel test (Step 1), and management's review of the disagreements (Step 2).
8. **Who Approved Deployment** — outside counsel's opinion (this document's origin), Asimov/Mason's technical sanity-check, and Peter's go-ahead — each with a date.
9. **Ongoing Oversight** — the periodic audit cadence (Section 8, Step 4).

---

## 10. Interactions With Existing Specs

**`flagged-review-grouping-and-exclusions-SPEC.md` Part 1 (grouped review) — compatible, reused, not modified.** This spec's historical-cleanup plan (Section 7) directly depends on it. No changes to Part 1's own design are needed.

**`flagged-review-grouping-and-exclusions-SPEC.md` Part 2 (static exclusion list) — superseded by this design for the six Tier B terms.** Part 2 was blocked by both Mason and Asimov specifically because `scanText()` only ever records the bare matched word ("white"), not the phrase around it, so a static exclusion for "white" would blind the system to a genuine future race reference using the same word — and because it would have required touching the same shared matcher `safeTicketTitle()` depends on. Tier B's per-instance, full-sentence contextual check solves exactly this problem: it re-evaluates the actual sentence fresh every time, never builds a static allowlist, and never touches `scanText()` at all. Part 2 should be considered withdrawn for these six terms; nothing prevents it from still being pursued later for some *other* narrow, single-word false-positive pattern if one turns up that Tier B doesn't already cover, but that would be a fresh proposal, not a revival of Part 2 as originally scoped.

**No new AI-vendor or CIPA/CCPA question.** Unlike `owner-tenant-operational-notes-SPEC.md`'s email-extraction feature, Tier B's classifier call processes text (`claim_text`) that is already being sent to the same Anthropic account for the same extraction pipeline today — no new data source, no new processor relationship, no new privacy-architecture question.

---

## 11. What Still Has to Happen Before This Goes Live

1. **Rincon's own internal governance discipline (`GOVERNANCE.md` Rule 6) — unaffected by counsel's opinion.** This is a Critical-tier compliance-logic change: owner approval, attorney review (satisfied — this is that review), and the rollout plan in Section 8 (which comfortably clears Rule 6's 7-day shadow-mode floor).
2. **Neo:** the one `review_status` CHECK-constraint widen (Section 5) — the only schema change this spec requires.
3. **Q, before writing the classifier call:** confirm which existing mechanism already writes `ai_agent`/`system`-actor `audit_log` entries for today's `ingestion_run`/`protected_class_excluded` events (Section 5's flagged open item) and reuse or extend it — do not assume `writeAuditLog()` as it stands today can be called as-is for the new `tier_b_classification` action.
4. **Asimov and Mason's technical sanity-check on this document** — the design in Sections 3–8, against the real code and schema cited throughout. Not a re-review of counsel's legal conclusions.
5. **Peter's go-ahead to build**, after 4.

---

## Open Items — Needs Confirming Before Q Builds

1. **The bigger "display operational protected-class content normally, don't auto-quarantine it" feature (Section 2)** — real, per counsel's opinion, but explicitly out of scope here. Worth a future Oracle spec of its own if Peter wants to pursue it, modeled on `owner-tenant-operational-notes-SPEC.md`'s existing tiered-access pattern.
2. **Whether the periodic sample audit (Section 8, Step 4) should write its own lightweight `audit_log` entry** or stay a written note Mason keeps outside the database — both are consistent with counsel's lean-logging guidance; this spec defaults to "a note is enough" but either is fine.
3. **The exact model/prompt parameters for `classifyTierBTerm()`** (temperature, max tokens, timeout value that triggers the fail-closed path) — an implementation detail for Q to size, not a design question this spec needs to resolve in advance.
4. **`maintenance_snapshot_events`'s own false-positive rate on these same six terms is unexamined** (found during Asimov's review, 2026-09-05) — this table's `flagged_protected_class` is set by a completely separate path (`backfill-maintenance-snapshot.js`, a plain Layer-1 rescan) that this spec's Tier A/B fix never touches, so it may carry the identical 91%-type false-positive problem with no fix applied. Worth its own data pull (how many snapshot-event rows are flagged on these six terms, and at what apparent accuracy) before deciding whether it needs its own version of this same fix — not assumed to be fine, and not assumed to need the identical treatment either, without first looking at its actual numbers.
5. **Derive `categoryOf()` from `protected-class-terms.js`'s existing `CATEGORIES` data** (via a load-once lookup, the same pattern `router.js:2026-2037`'s `TERM_TO_CATEGORY` already uses) rather than hand-duplicating the four term-group categories in a second place — flagged by Asimov as a minor drift risk, not blocking.
6. **Log the kill-switch disengage / go-live moment itself as one auditable change-management entry** (distinct from the per-classification `tier_b_classification` events) — flagged by Asimov as consistent with GOVERNANCE.md Rule 6's "log every change, with previous and new values" language; not currently a required blocker, worth adding.
