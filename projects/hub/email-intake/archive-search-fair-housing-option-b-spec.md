# Archive Search — Fair Housing Screening, Option B (Wide Topic Net Before the AI Call)

**Status:** AUTHORIZED TO WIRE IN. All three prongs of GOVERNANCE.md Rule 6's Critical tier are closed for this specific change, per `compliance/archive-search-option-b-governance-review.md` (the real, dedicated Asimov + Mason review — not the outside counsel opinion's own "Claude's Analysis" section, which is Claude's write-up, not a governance/legal verdict): (1) attorney review — the real outside counsel opinion, `compliance/archive-search-fair-housing-outside-counsel-opinion.md`; (2) owner approval — Peter's decisions throughout this project; (3) shadow mode — explicitly waived by Peter ("checking a real sample is fine, no monitored period," 2026-09-12), substituted with the validation-sample gate in Section 5 below, logged to `audit_log` (`action: archive_search.rule6_shadow_mode_waived_option_b`, written 2026-09-12). **This document DOES now authorize Q to wire `matchesWideNet()` into `screening-pass.js`'s `handleNonHeldConversation()`** — see Section 2 below for the exact integration point. The four concrete action items named in the governance review (military/veteran category, escalation mechanism, staff policy note, periodic re-validation extension) are all complete.
**Written by:** Oracle
**Date:** 2026-09-12
**Origin:** Peter, in direct conversation, per general consensus reached with his own outside attorney: Archive Search's Fair Housing self-report call (`fair-housing-batch-self-report.js`) — a real Anthropic API call, once per non-held conversation, unconditionally, across the full ~254,000-message archive — runs more conservatively than necessary. Peter reviewed three options and picked **Option B**: run a deliberately wide topic net first; only a conversation that matches something in that net gets the AI call; everything else goes straight to `'clear'`. Peter's own explicit, non-negotiable requirement on how that net must be built, stated verbatim: **"i dont want the keywords triggering non fair housing items. think phrases and not individual words."** This document turns that into a real, concrete, buildable design — not a restatement of it.

**This is a proposed change to an already-designed mechanism, not a new tool.** It reuses Archive Search's existing schema, roles, and audit conventions wherever they already fit, and touches exactly one function's control flow (`handleNonHeldConversation()`) plus one new, small library file. It does not reopen the hold check, the access model, or anything else the original build already settled.

**Built from, read in full:**
- `projects/hub/email-intake/lib/privilege-keywords.js` — the real, live precedent for "phrases and co-occurrence, not bare words": `HOLD_COOCCURRENCE_PAIRS` fires a Tier 2 hold when a regulator/subject-matter token (`a`) and a complaint-word (`b`) both appear anywhere in the same text, as two independent regexes ANDed together — not a bare single-word match, and not one `.*`-spanning regex (avoiding catastrophic backtracking over a full message body). This spec's own wide net is built directly on this shape, not invented fresh.
- `projects/hub/maintenance-history/lib/protected-class-terms.js` — the existing Fair-Housing term list in this codebase, `checkClaim()`'s Layer 1. Read in full, including its own stated design philosophy ("intentionally broad/recall-oriented... a false positive costs one extra human review of an already-unreviewed claim") and its `CATEGORIES` shape (10 categories, drawn from Rule 9 plus the California-specific expansions in `compliance/ventura-county-compliance-kb.json`, `fh-01`–`fh-06`).
- `projects/hub/maintenance-history/lib/content-check.js` — `checkClaim()`, and specifically the Tier A / Tier B split: six of `protected-class-terms.js`'s own terms (`'white'`, `'black'`, `'blind'`, `'diagnosis'`, `'diagnosed'`, `'too old'`, `'too young for'`) were responsible for **~91% of that tool's real false-positive volume** (`content-screening-tier-redesign-SPEC.md`, cited in `content-check.js`'s own header) — a real, measured, cited data point this spec relies on directly, not a hypothetical.
- `projects/hub/archive-search/lib/fair-housing-batch-self-report.js` — the actual AI call this new pre-filter gates. Confirmed: fails closed on every error path (`{ flagged: true, category: 'model_self_report_failed_closed' }`), never logs thread text or its own raw response, `claude-sonnet-5`, `max_tokens: 512`, `effort: 'low'`, 12000ms timeout.
- `projects/hub/archive-search/lib/screening-pass.js` — `handleNonHeldConversation()` (the exact insertion point), `markConversationScreened()` (writes `screening_result`/`screening_category`/`screening_tags`/`screening_version`/`screening_completed_at` identically across every row of a conversation), `runScreeningPassChunk()`'s per-chunk summary object and its one aggregate `audit_log` event (`archive_search.batch_pass_run`), and the existing count-only dry-run functions (`getScreeningStatus()`, `distinctPendingConversationCount()`) — the established precedent in this exact file for "don't guess a number you haven't measured."
- `compliance/archive-search-ai-risk-assessment.md` and `projects/hub/email-intake/archive-search-technical-spec.md`'s "Finding 2" — the real, on-record reasoning for why the self-report call runs unconditionally today: Archive Search's batch pass has no other reason to read a thread's content, so without a dedicated self-report call, Layer 2 of the two-layer check is silently `false` for every conversation, and the pass is really running "1.5 layers, not 2" while claiming full two-layer coverage. Finding 2 explicitly weighed and rejected the cheaper option (Layer 1 only) because it would undercut the product doc's own reasoning for choosing the two-layer check in the first place. **This spec proposes a real, deliberate, partial reopening of that conclusion** — not a silent reversal of it — narrowing when the self-report call fires, not removing the two-layer check's design.
- `GOVERNANCE.md`, Rule 9 and the Fair Housing Standard's Protected Classes section — the federal FHA list (race, color, national origin, religion, sex including sexual orientation/gender identity, familial status, disability) this spec's categories map onto, plus the California/FEHA expansions already reviewed in `ventura-county-compliance-kb.json`.
- `compliance/archive-search-fair-housing-outside-counsel-opinion.md` — the real opinion received from Rincon's actual outside counsel, approving this two-stage architecture subject to ten numbered safeguards. Safeguard #7 (periodic sampling of both the screened and unscreened pools) is what Section 5, item 7 below now adopts as a concrete commitment, closing that document's own Hard Blocker 4.

---

## What This Does

Today, before any archived email conversation becomes searchable, the system asks an AI model one narrow question about it — "does this touch on race, disability, family status, or another protected topic in a way a keyword scan might miss?" — for **every single** conversation that isn't already on legal hold. That is roughly a quarter of a million messages' worth of AI calls, most of which are asking that question about a maintenance request, a rent receipt, or a showing confirmation that obviously has nothing to do with Fair Housing at all. This change adds a cheap, instant first look — checking each conversation against a much broader list of Fair-Housing-related phrases than the system currently uses anywhere — **before** deciding whether to ask the AI at all. If a conversation doesn't touch anything on that broader list, it skips the AI question entirely and is marked safe to search. If it does touch something on the list, nothing changes — it goes through the exact same AI check and keyword check as it does today. Every phrase and pattern in this new broader list is built as a multi-word phrase or a "these two things need to both show up" pattern, per Peter's own explicit instruction — never a single ordinary word that could fire on something unrelated.

## How It Works

1. For every conversation that already cleared the legal-hold check (nothing about that check changes), the system now runs one new, instant, free check first: does this conversation's text contain any phrase, or any pair of related phrases, from a new "wide net" list covering all twelve-plus Fair-Housing-protected topics (race, color, religion, sex/orientation/gender identity, national origin, familial status, disability, source of income/vouchers, age, marital status, ancestry, immigration/citizenship, primary language)?
2. **No match:** the conversation is marked `clear` immediately. The AI question is never asked, and the existing keyword check is never run either — both are skipped entirely for this conversation.
3. **A match:** nothing changes from today. The AI question gets asked, the existing keyword check runs, and the conversation is marked `flagged` or `clear` exactly as it is now.
4. Either way, the fact that a conversation skipped the AI check via the wide net is recorded — on the conversation itself (an informational tag, the same mechanism already used for other informational tags) and in the run's summary count — so it's always possible to see, after the fact, how many conversations took each path.
5. The legal-hold check itself is completely unaffected by any of this — it is a different mechanism, checking for different things (an active lawsuit, an attorney, a subpoena), and it still runs first, on every conversation, with no exceptions, exactly as it does today.

## What You'll See

Nothing changes about what shows up in search, how search looks, or who can use it. The only visible difference is cost and speed: a batch screening run processes the backlog faster and for less money, because a large share of ordinary correspondence never triggers an AI call at all. If you look at a run's summary numbers (the same summary this tool already produces after every screening pass), you'll see a new count — how many conversations skipped the AI check via the wide net — alongside the existing held/flagged/clear counts.

## What Could Go Wrong

- **A conversation that's genuinely about a protected topic, but phrased in a way that touches none of the wide net's phrases at all, now gets zero independent check** — not even today's baseline AI question. This is the real, deliberate cost of this design, spelled out plainly in Section 4 below, not glossed over.
- **The wide net itself could still be too noisy if built carelessly** — even a two-word phrase can be a repeat offender (see the real, measured 91% false-positive data point cited above). Section 1 below is deliberately specific about which phrasings are safe to include standalone and which need a second, corroborating phrase nearby before they count as a match.
- **This changes a governance-reviewed conclusion (Finding 2), not an implementation detail** — Asimov and Mason reviewed and approved the current unconditional design specifically because it restores real two-layer coverage. This spec does not get to quietly narrow that; it needs their review again, named as such in this document's own title.

---

## 1. The Wide Net — Phrases and Co-occurrence Pairs, Never Bare Words

### 1.1 Why `protected-class-terms.js` cannot be reused as-is for this mechanism

`protected-class-terms.js` is real, already-approved, and already in production use one layer downstream of this new mechanism (inside `checkClaim()`, which still runs unchanged whenever the wide net *does* match). But roughly half of its entries are exactly what Peter's instruction rules out: bare single ordinary words matched with a `\b` boundary — `'race'`, `'black'`, `'white'`, `'gay'`, `'church'`, `'spouse'`, `'divorced'`, `'widow'`, `'wheelchair'`, `'blind'`, `'deaf'`, `'disabled'`, `'medication'`, `'therapy'`, `'senior citizen'`... some of these are already phrases (fine), many are not.

That file's own header explains why bare words are an acceptable design there: *"a false-positive flag costs one extra human review of an already-unreviewed claim... a false NEGATIVE is the failure mode Rule 9 exists to prevent."* That trade-off is correct for `protected-class-terms.js`'s actual job — a claim already headed for human review either way. It is the wrong trade-off for this mechanism: here, a false-positive match doesn't cost one extra human glance, it costs one full-thread AI call, repeated across whatever share of a 254,000-message archive happens to contain the word "church" as a landmark, "blind" as in window blinds, or "diagnosis" as in a vendor's HVAC fault report. Reusing that file's bare words wholesale would quietly defeat Option B's entire purpose *and* directly violate Peter's stated requirement.

**Recommendation: a new, separate file** — `projects/hub/archive-search/lib/fair-housing-wide-net-terms.js` — modeled on `privilege-keywords.js`'s exact two-part shape (a flat phrase list, plus a `HOLD_COOCCURRENCE_PAIRS`-style array), not a copy of `protected-class-terms.js` and not a modification to it (that file is frozen in full per the Tier A/B redesign spec's Section 3.1, and this build has no reason to reopen that). Where `protected-class-terms.js` already happens to hold a genuinely multi-word, low-ambiguity phrase (e.g. `'primary language'`, `'housing choice voucher'`, `'genetic information'`), the new file reuses that exact wording rather than inventing a competing variant — consistency without duplication. Where it only holds a bare word, the new file does not import it; it builds the equivalent coverage as a phrase or a co-occurrence pair instead.

### 1.2 The mechanism: two shapes, exactly like the existing precedent

**Shape A — literal multi-word phrases**, compiled the same way `TAG_TERMS`/`HOLD_TERMS` already are (`\b`-bounded regex per phrase). Used wherever the topic has a natural, specific, multi-word way of coming up in real correspondence.

**Shape B — co-occurrence pairs**, compiled the same way `HOLD_COOCCURRENCE_PAIRS` already is: two independent regexes, `a` and `b`, both ANDed, matching anywhere in the full thread text regardless of order or distance. Used wherever the topic's core vocabulary is otherwise a single ordinary word (race, religion, sex/orientation, national origin, disability, marital status, ancestry) — the identity/topic term alone is `a`; a second, genuinely distinguishing signal is `b`.

**A new design element beyond the existing precedent, stated explicitly: two shared, reusable `b` patterns**, rather than a bespoke companion per pair (the existing precedent only has one pair total, so it never needed to generalize this). Both are exported alongside the pair list so Mason/Q can review and extend them independently of any single category:

```js
// Shared companion patterns — reused across many co-occurrence pairs below.
// Same two-independent-regexes-ANDed shape as HOLD_COOCCURRENCE_PAIRS; no
// single new regex spans both sides, for the same catastrophic-backtracking
// reason that file's own comment already gives.

// "Something adverse/differential happened" — the actual Fair-Housing-
// relevant scenario, as opposed to an identity word appearing incidentally.
const ADVERSE_TREATMENT_LANGUAGE = /\b(discriminat\w*|treated? (?:me|him|her|them|us)? ?differently|treated unfairly|wouldn'?t rent to|refused to rent|denied (?:my|his|her|their) application|turned (?:me|him|her|them|us)? ?down because|won'?t allow|declined (?:my|his|her|their) application|made (?:comments|fun) about|harass(?:ed|ment)|targeted (?:me|him|her|them|us)|uncomfortable because of|singled (?:me|him|her|them|us)? ?out)\b/i;

// "A need or request tied to a personal characteristic" — the Fair-
// Housing-relevant accommodation scenario, as opposed to a routine repair.
const ACCOMMODATION_OR_NEED_LANGUAGE = /\b(accommodat\w*|modif\w* the unit|needs? (?:a ramp|an interpreter|a translator|help with)|because of (?:my|his|her|their) (?:disability|condition)|due to (?:my|his|her|their) (?:disability|condition))\b/i;
```

### 1.3 Category-by-category starter list

Twelve categories per Peter's own list (matching Mason's prior FEHA/FHA review), plus `genetic_information` and `discrimination_general` carried forward from `protected-class-terms.js` for consistency (see the two flagged judgment calls below).

| Category | Recommended shape | Real candidate entries |
|---|---|---|
| **Race / Color** | Co-occurrence only — no natural multi-word phrase covers this without a companion, and the bare words (`race`, `black`, `white`) are exactly the kind of ordinary-language collision (paint, "the race is on," a brand name) this spec exists to avoid. | `a: /\b(race|racial|ethnicity|ethnic background|skin color|skin tone)\b/i`, `b: ADVERSE_TREATMENT_LANGUAGE` |
| **Religion** | Phrases + co-occurrence. | Phrases: `'religious accommodation'`, `'religious discrimination'`, `'religious harassment'`, `'religious observance'`. Co-occurrence: `a: /\b(religion|religious|christian|catholic|muslim|jewish|hindu|buddhist|sikh|church|mosque|synagogue|temple|hijab|yarmulke)\b/i`, `b: ADVERSE_TREATMENT_LANGUAGE` |
| **Sex / Gender (incl. orientation, gender identity)** | Phrases + co-occurrence — matches `protected-class-terms.js`'s own `sex_gender` grouping, so this spec doesn't invent a category split that file doesn't already have. | Phrases: `'sexual orientation'`, `'gender identity'`, `'gender expression'`, `'sexual harassment'`, `'pregnancy discrimination'`. Co-occurrence: `a: /\b(pregnant|pregnancy|gay|lesbian|bisexual|transgender|nonbinary|non-binary|lgbtq)\b/i`, `b: ADVERSE_TREATMENT_LANGUAGE` |
| **National Origin** | Phrases + co-occurrence. | Phrases: `'national origin'`, `'country of origin'`, `'accent discrimination'`. Co-occurrence: `a: /\b(national origin|country of origin|accent|middle eastern|latino|latina|hispanic|indigenous|native american|pacific islander)\b/i`, `b: ADVERSE_TREATMENT_LANGUAGE` |
| **Familial Status** | Phrases only — this is the one category where the real vocabulary is already multi-word and directly on-topic even in mundane-sounding correspondence (occupancy-limit discussions are a classic *indirect* familial-status issue), matching the task's own example. | `'familial status'`, `'family status'`, `'no children allowed'`, `'kids not allowed'`, `'adults only'`, `'no kids policy'`, `'child custody'`, `'foster child'`, `'pregnant tenant'`, `'occupancy limit'`, `'household size'`, `'household composition'`, `'number of occupants'` |
| **Disability** | Phrases (accommodation-shaped) + co-occurrence (everything else) — the single most bare-word-prone category in the whole list; `wheelchair`, `blind`, `medication`, `diagnosis`, `therapy` are all common in entirely ordinary PM correspondence. | Phrases: `'reasonable accommodation'`, `'reasonable modification'`, `'service animal'`, `'emotional support animal'`, `'assistance animal'`, `'accessible unit'`, `'wheelchair accessible'`, `'disability accommodation'`, `'accessibility needs'`. Co-occurrence: `a: /\b(wheelchair|blind|deaf|hard of hearing|disability|disabled|handicap(?:ped)?|mental illness|depression|anxiety disorder|ptsd|bipolar|schizophrenia|autism|autistic|adhd|diagnosis|diagnosed|medication|prescription|therapy)\b/i`, `b: ACCOMMODATION_OR_NEED_LANGUAGE` (a second pair with `b: ADVERSE_TREATMENT_LANGUAGE` as well — either companion should fire the match) |
| **Source of Income / Vouchers** | Phrases only — already naturally specific ("Section 8" rarely means anything else in PM correspondence). | `'source of income'`, `'section 8'`, `'housing choice voucher'`, `'housing voucher'`, `'rental assistance program'`, `'calfresh'`, `'snap benefits'`, `'public assistance'`, `'social security disability'` |
| **Age** | Phrases only, deliberately **excluding** `'too old'` / `'too young for'` — see 1.4 below. | `'age discrimination'`, `'senior citizen'`, `'elderly tenant'`, `'over 62'`, `'over 65'`, `'age restricted community'` |
| **Marital Status** | Co-occurrence — `spouse`, `divorced`, `widow` are ordinary words on their own. | `a: /\b(divorced|divorce|separated|widow|widower|spouse|domestic partner)\b/i`, `b: ADVERSE_TREATMENT_LANGUAGE`. Standalone phrase: `'marital status'` |
| **Ancestry** | Co-occurrence, for consistency (bare `'ancestry'` is rare enough alone that this is a low-cost, low-risk gate). | `a: /\bancestry\b/i`, `b: ADVERSE_TREATMENT_LANGUAGE`. Standalone phrase: `'family ancestry'` |
| **Immigration / Citizenship Status** | Phrases only — already naturally specific. | `'immigration status'`, `'citizenship status'`, `'visa status'`, `'green card'`, `'undocumented immigrant'`, `'ice hold'`, `'deportation'`, `'proof of citizenship'` |
| **Primary Language** | Phrases only — `protected-class-terms.js`'s own entries here are already phrase-shaped; reused directly, not reworded. | `'primary language'`, `'doesn't speak english'`, `'does not speak english'`, `'language barrier'`, `'needs a translator'`, `'needs an interpreter'`, `'limited english proficiency'` |
| **Genetic Information** *(bonus — see 1.4)* | Phrases only — already phrase-shaped in `protected-class-terms.js`; reused directly. | `'genetic information'`, `'genetic testing'`, `'family medical history'` |
| **Discrimination, general** *(bonus — see 1.4)* | Bare word — see 1.4 for why this is flagged as a deliberate, named exception rather than silently included. | `discriminate`, `discriminated`, `discriminating`, `discriminates`, `discrimination`, `discriminatory` |

### 1.4 Two judgment calls, flagged rather than decided silently

1. **`'too old'` and `'too young for'` are deliberately left OUT of this list**, even though both are already two-word phrases and Peter's instruction is about words, not phrase length. The reason is a real, cited number, not caution for its own sake: these two exact phrases are already among the six terms responsible for ~91% of `protected-class-terms.js`'s own measured false-positive volume in this codebase (Section header, above). Phrase construction meaningfully cuts false-positive risk versus bare words — it does not eliminate it, and this is the concrete proof already sitting in this repository. Age coverage is carried instead by the more specific phrases in the table above (`'age discrimination'`, `'senior citizen'`, `'over 62'`, etc.).
2. **`discrimination_general` is proposed as the one deliberate bare-word exception**, against the letter (not obviously the spirit) of Peter's instruction. `protected-class-terms.js`'s own header gives the reasoning this spec leans on rather than re-deriving: *"a bare discrimination accusation, in property-management correspondence, is in practice essentially never an unrelated use of the word."* Unlike `race`/`black`/`blind`/`old`, there is no ordinary paint-color or window-blind reading of "discrimination." **This is named here explicitly for Peter's own sign-off**, not assumed — if he'd rather this be phrase-only too (e.g. `'this is discrimination'`, `'that's discriminatory'`), that is a one-line change to the table above, not a redesign.

### 1.5 The trade-off, stated honestly, and a concrete recommendation

Every phrase or pair added to this net makes it wider — catching more indirect phrasing, at the cost of more AI calls (the exact cost this build exists to reduce). Every phrase or pair left out makes it narrower and cheaper, at the cost of more conversations that skip the AI check outright based on a topic-net miss alone.

**Recommendation: include every literal phrase in Section 1.3's table, and every co-occurrence pair — but not `protected-class-terms.js`'s bare words, and not `'too old'`/`'too young for'`.** The literal phrases are, by construction, already specific enough that a real property-management use ("please translate the lease into Spanish for our tenant who needs an interpreter," "the applicant has a housing voucher," "confirming the occupancy limit for a 2-bedroom") is itself exactly the kind of conversation worth one extra AI look — these are not false-positive-prone the way bare words are; they are the actual on-topic case, just not necessarily a violation, which is exactly the AI call's job to judge. The co-occurrence pairs are deliberately the "wide" part of the net: they will produce some AI calls on conversations that turn out to be nothing (someone mentioning a divorce in passing while discussing a lease transfer, with no adverse-treatment language actually intended) — but each such call is cheap, bounded, and fails closed if it errors, and a match here only means "ask the question," never "flag automatically." Erring toward inclusion at this gate costs money, not accuracy; erring toward exclusion costs coverage on exactly the content this whole two-layer check exists to catch. Given Peter's own stated goal is cost reduction with an accepted, named residual risk (Section 4) — not maximum possible savings — this is the right place to draw the line.

---

## 2. Where This Sits in the Real Code — `handleNonHeldConversation()`

**`checkThread()` (the legal-hold check) is untouched and stays completely independent.** It is a different mechanism answering a different question (active litigation, an attorney, a subpoena, a staff-applied legal-hold tag) via a different file (`privilege-filter.js` / `privilege-keywords.js`), and it already runs unconditionally, first, on every conversation, before any Fair Housing content check of any kind — per `screening-pass.js`'s own header comment and `runScreeningPassChunk()`'s real code (`checkThread(thread)` runs before the `holdResult.held` branch). This spec adds nothing before that check and changes nothing about it. The new wide-net gate lives entirely inside `handleNonHeldConversation()` — it only ever runs for a conversation `checkThread()` has already determined is *not* held, exactly where today's self-report call already sits.

**The actual code-flow change:**

```js
// screening-pass.js — handleNonHeldConversation(), NEW step before the self-report call.
const { matchesFairHousingWideNet } = require('./fair-housing-wide-net-terms'); // new file, Section 1

async function handleNonHeldConversation(conversationId, thread, holdResult, anchorRowId) {
  const threadText = threadFullText(thread);

  // NEW — the wide-net gate. Same reasoning shape as scanForHoldKeywords():
  // a flat phrase scan plus a co-occurrence scan, ORed together.
  const wideNet = matchesFairHousingWideNet(threadText);

  const baseTags = holdResult.tagged && holdResult.tags.length ? holdResult.tags : [];

  if (!wideNet.matched) {
    // Skip the self-report AI call AND checkClaim() entirely.
    const screening_tags = [...baseTags, 'wide_net_skip'];
    await markConversationScreened(conversationId, {
      screening_result: 'clear',
      screening_category: null,
      screening_tags: screening_tags.length ? screening_tags : null,
    });
    return 'clear'; // no audit_log event — matches today's convention that
                     // a 'clear' outcome writes no per-conversation event;
                     // the skip is counted in the chunk-level summary instead (see below).
  }

  // UNCHANGED from here down — exactly today's code.
  const selfReport = await selfReportFairHousingContent({ threadText });
  const contentCheck = await checkClaim({ claim_text: threadText, modelFlag: selfReport.flagged, modelCategory: selfReport.category });
  // ... rest unchanged
}
```

**Three deliberate, precedent-following design choices, named explicitly:**

1. **`screening_tags` gains a new informational value, `'wide_net_skip'` — no migration.** `screening_tags` is already a `JSONB`, informational-only column (never a search filter, per the original spec's own Finding 1 design) holding Tier 1 TAG labels from `checkThread()`. This spec adds one more possible value to that same array, additively — a conversation can carry `['regulatory_matter', 'wide_net_skip']` if both are true, since these are genuinely independent facts about it. This is a schema *use* change, not a schema *shape* change; flagged for Neo's quick sign-off in Open Items anyway, since Neo owns column semantics even when no migration is required.
2. **No new per-conversation `audit_log` event for a skip.** Today, a `'clear'` outcome (via `checkClaim()`) already writes no `audit_log` row at all — only `held` and `flagged_protected_class` do. A skip is also, functionally, a `'clear'` outcome; giving it its own per-conversation audit event would be a new, higher-volume logging pattern this build doesn't otherwise have, for a fact that's better captured in aggregate (next point).
3. **`runScreeningPassChunk()`'s existing summary object gains one field: `wide_net_skipped`.** Incremented in the new skip branch, alongside the existing `held`/`flagged`/`clear` counters (a skip still also increments `clear`, since `'clear'` is the real, identical `screening_result` value either way). This one small addition makes the entire point of this build directly measurable, per chunk and in the existing `archive_search.batch_pass_run` aggregate event, with no new table and no new event type: `wide_net_skipped / conversations_processed` is, after any real run, the actual percentage of AI calls this change avoided — a real number in place of the estimate in Section 3.

`SCREENING_VERSION` (currently `'archive-search-screening-v1'`) should be bumped to reflect this change (e.g. `'archive-search-screening-v2-wide-net-prefilter'`) — it is written identically across every row of a conversation regardless of which path (skip or full-check) that conversation took, so `screening_version` alone does not distinguish the two; `screening_tags` (point 1, above) is what carries that distinction on the row itself.

---

## 3. How Much of the Archive This Would Likely Skip — Reasoned, Not Guessed

No exact number exists without running it — and per the precedent already established in this exact codebase (`screening-pass.js`'s own `getScreeningStatus()`, and the original technical spec's explicit "a number the spec explicitly says not to guess" stance on conversation counts), the right move is to measure, not assume. **Section 5 below proposes exactly that measurement, as a required, zero-cost, zero-risk step before this ever changes real behavior.**

Reasoned qualitatively in the meantime, by ordinary property-management correspondence type:

**Very unlikely to match any wide-net entry — the honest bulk of routine PM traffic:**
- Rent payment confirmations, late-rent reminders, autopay setup, receipt requests.
- Routine maintenance requests and vendor scheduling ("the sink is leaking," "vendor arriving Tuesday 9-11am") — unless the request happens to reference an accommodation, an accessibility need, or a disability-adjacent term from the disability co-occurrence pair.
- Showing scheduling, lease-renewal logistics, move-in/move-out walkthrough scheduling.
- Owner reporting, insurance correspondence, HOA notices, general vendor/contractor coordination.
- Ordinary scheduling and calendar coordination between staff and tenants/owners/vendors.

**Likely to match, correctly, per the task's own framing:**
- Anything discussing household composition, number of occupants, or occupancy limits (familial status).
- Anything discussing accessibility needs, a service/support animal, or a reasonable-accommodation request (disability).
- Anything discussing a housing voucher, Section 8, or another income-assistance program (source of income).
- Anything discussing an applicant's screening criteria alongside a protected characteristic, or a translation/interpretation need (primary language, national origin).
- Correspondence that surfaces an actual dispute framed around identity or differential treatment (any co-occurrence pair firing its `ADVERSE_TREATMENT_LANGUAGE` side).

**Plausible expectation, stated as an expectation and not a measurement:** the large majority of a 254,000-message property-management archive is routine transactional correspondence of the first kind, so a meaningful majority of non-held conversations plausibly skip the AI call under this design. That is a reasoned expectation built from what property-management correspondence actually is, not a number this document is entitled to assert as fact.

---

## 4. The Residual Risk — Stated Plainly, Not Softened

**A conversation phrased indirectly enough to touch none of Section 1's phrases or co-occurrence pairs at all now receives zero independent Fair Housing check — not even today's baseline, unconditional AI self-report call.** Today's design's entire value, per Finding 2's own words, is that the self-report call is asked of *every* non-held conversation, specifically to catch phrasing a keyword scan would miss. This design removes that guarantee for exactly the conversations the wide net doesn't reach. This is not a smaller version of today's residual risk — it is a structurally different, strictly larger one: today, a miss requires the self-report call itself to fail or misjudge; under this design, a miss can also happen because the conversation never reached the call at all.

This is the deliberate, accepted trade Peter is asking to make — narrower independent-check coverage, in exchange for materially lower cost — and it is named here in the same direct language `compliance/archive-search-ai-risk-assessment.md` already uses for a comparable point (*"a real, accepted residual risk, not a solved one"*), not hedged into something softer. The honest mitigations available are: (1) build the net as wide as Section 1.5 recommends, erring toward inclusion at this cheap gate; (2) the validation plan in Section 5, run before this replaces the current design in production; (3) the existing flagged-conversation reinstatement mechanism (`archive-search-flagged-review-spec.md`) has no equivalent for a conversation that was never even looked at — worth naming as a real, currently-unfilled gap, not something this spec closes.

---

## 5. Validation Plan — Before This Ever Touches Real Data

**The real, correct comparison is old design vs. new design on the same known set, computed before any real run switches over — not a redesign of Finding 5's existing validation-sample mechanism, but an extension of it.**

1. **Zero-cost dry run first.** Build a count-only mode for the new wide-net check (mirroring `getScreeningStatus()`'s existing shape exactly: no AI calls, no writes) and run it across the full archive (or the driver query's existing chunking) to get the real Section 3 number — how many non-held conversations would skip vs. proceed — before writing a single line of the real integration in Section 2. Report this to Peter, per the same "Q reports this back before it's scheduled" precedent Finding 4 already established for conversation counts.
2. **If Archive Search's initial batch pass has already run against real data** (confirm current status before starting this work — do not assume): query `missive_message_intake` for every conversation where `screening_result = 'flagged_protected_class'` **and** `matched_layer = 'model'` exactly (`content-check.js`'s own value meaning the self-report call alone caught it — no keyword hit at all). This is the strongest possible validation set available, because it is not a random sample — it is every real, already-confirmed case where today's design's *only* backstop is the one this change would gate. For each one, run the new wide-net check against that same conversation's thread text. Any case where the wide net does **not** match is a concrete, real, already-known-important conversation this design would have missed entirely — not hypothetically.
3. **If the batch pass has not yet run against real data at the time this is built:** use Finding 5's own planned 1,000-message stratified sample (500 from 2024 forward, 500 oversampled pre-2024) as the comparison set instead, computed for both designs before either runs against the full archive: for each sampled conversation, compute what the *old* design produces (self-report always called, then `checkClaim()`) and what the *new* design produces (wide-net gate first). Extending Finding 5's already-planned review to include this comparison is more efficient than a second, separate sample.
4. **Every divergence — a case where the old design's self-report call would flag something but the new design's wide net skips it outright — gets a human look**, by whoever holds Archive Search's `'admin'` role (the same reviewer population Finding 5 already uses). Each one is either a genuine miss (the wide net needs a new phrase or pair — feed it back into Section 1's list and re-run the comparison) or a confirmed non-issue the old design would have flagged anyway for no real reason (fine to now skip).
5. **Exit rule:** not "zero divergence" — some divergence between the two designs is the entire deliberate point of Option B. The real bar is **zero divergence a human reviewer confirms as a genuine miss.** Any confirmed miss means the wide net gets expanded and the comparison re-run before this design replaces the current one for any real, non-comparison run — the same "fix it and re-check, don't just ship it" discipline Finding 5 already applies to the underlying screening pass itself.
6. This comparison has a real, one-time AI-call cost (running the old design's self-report call across the comparison set) — a bounded validation expense, the same category Finding 5's sample review already accepts, not a recurring one.

7. **Adopted, ongoing, post-launch — sample BOTH pools every quarter, for as long as this design runs.** Items 1–6 above are the one-time comparison run before this design ever replaces the current one. Counsel's safeguard #7 (`compliance/archive-search-fair-housing-outside-counsel-opinion.md`) asks for something else, ongoing: *"periodically sample both screened and unscreened content to determine whether the first-stage filter is performing reasonably."* This project already has a standing recommendation for a periodic re-validation cadence on newly-screened mail (`archive-search-technical-spec.md`'s Open Item 7 — "a periodic, e.g. quarterly, re-validation sample," echoed in `archive-search-flagged-review-spec.md` and `archive-search-escalation-mechanism-spec.md`), but every prior mention of it is phrased as a recommendation Peter/Asimov/Mason had not yet adopted, and none of them name the wide-net-skip pool specifically — only the AI-reviewed pool. Per Peter's decision to proceed with Option B, this is now adopted as a real, concrete, locked-in commitment, not a future maybe:

   - **Cadence:** every quarter, for as long as the wide-net gate is live — the same cadence this project already uses for its other periodic Fair Housing accuracy checks.
   - **What gets sampled — two pools, every quarter, drawn from conversations screened since the last review:**
     - **Pool A — the screened (AI-reviewed) pool:** conversations that went through the self-report call and `checkClaim()` that quarter (`flagged_protected_class` and `clear` outcomes both included) — a random 100, or all of them if that quarter's volume is under 100.
     - **Pool B — the unscreened (topic-net-miss) pool:** conversations tagged `wide_net_skip` that quarter — a random 100, or all of them if that quarter's volume is under 100. This is the pool no existing document in this project currently commits to sampling at all; it is the one safeguard #7 exists specifically to cover.
   - **Who does it:** whoever holds Archive Search's `'admin'` role — the same reviewer population already doing the one-time comparison in items 1–6 above, and the same population Finding 5's own validation-sample review already uses. No new role, no new training requirement.
   - **What "reviewing" means for Pool B specifically (the new part):** for each sampled `wide_net_skip` conversation, the reviewer reads the full thread and judges whether it plausibly should have been flagged had it gone through the self-report call — the identical judgment call items 4–5 above already ask reviewers to make on the one-time comparison set, applied on a rolling basis instead of once.
   - **Exit criteria, every quarter — the same discipline this project already applies everywhere else for Fair Housing accuracy:** zero confirmed genuine misses in either pool → continue at the current cadence, no design change. One confirmed genuine miss, in either pool → (a) expand the wide-net phrase/co-occurrence list to close that specific gap, (b) re-run the wide-net check against every conversation screened since the wide net went live, so anything else with the same gap gets caught and routed through the full check, (c) log the finding and the fix, (d) notify Mason. Never "note it and move on."
   - **Cost:** bounded and small — up to 200 human reviews per quarter total, split across the two pools; no new AI calls for Pool A (that pool already has a screening result on file), and up to 100 human reads of thread text per quarter for Pool B. The same category of expense Finding 5's own one-time sample review already treats as acceptable, just recurring.

   This closes the gap the outside counsel opinion's own "Hard Blockers Before This Runs Against Real Data" list names directly (`compliance/archive-search-fair-housing-outside-counsel-opinion.md`, Claude's Analysis, Hard Blocker 4): *"Lock in, in writing, the commitment to extend periodic re-validation sampling to the topic-net-miss pool (safeguard 7) — the first actual sampling pass can follow shortly after launch, but the commitment itself should exist before launch."* The commitment now exists in writing, here, as an adopted part of this design — not an open item awaiting a future decision. The first actual sampling pass still happens after launch, on a real quarter of real data; that was never blocking and still isn't. What changes today is that the obligation to run it, on this cadence, against both pools, with this exit rule, is locked in now rather than deferred.

---

## Open Items — Needs Confirming Before This Gets Built

1. **`discrimination_general` as a bare-word exception (Section 1.4, item 2)** — a deliberate, named departure from the letter of Peter's own instruction, leaning on this codebase's own prior reasoning for exactly this word. Peter's call to keep it as-is or convert it to phrase-only.
2. **Whether `'too old'`/`'too young for'` should really be left out** (Section 1.4, item 1) — this spec's recommendation, given the real 91% data point, but a narrower judgment call than the rest of the list; Mason may have a view on whether age coverage is now too thin.
3. **`screening_tags` gaining `'wide_net_skip'` as a new value** (Section 2) — no migration needed, but flagged for Neo's sign-off as a new semantic use of an existing column, per CLAUDE.md's standing instruction that Neo owns schema/column meaning.
4. **Confirm Archive Search's real current status** (already run against real data, mid-run, or not yet run) before Section 5 is finalized — the validation approach differs materially depending on which is true, and this document does not assume an answer.
5. **This is a real, deliberate reopening of Finding 2's already-reviewed conclusion**, not an implementation detail inside an already-approved design — it should get its own explicit Asimov/Mason sign-off referencing this document by name, not be folded silently into a future unrelated review.
6. **Whether the new wide-net phrase list, like `protected-class-terms.js`, should become a named Mason-maintained code asset** (edited with the same review discipline as `GOVERNANCE.md` itself) — recommended, not decided here.
7. **The Section 3 estimate is qualitative** — Section 5's dry run produces the real number; no phrase-list wording should be treated as final until that number is reported back to Peter.

---

## Ready for Asimov + Mason Review

This document proposed a real, deliberate narrowing of a mechanism Asimov and Mason already reviewed and approved once (Finding 2, `archive-search-technical-spec.md`) — not a bug fix, not an implementation detail. **As of 2026-09-12, this is authorized** — see the Status line at the top of this document and `compliance/archive-search-option-b-governance-review.md` for the real, complete closing record (Asimov's sign-off that reopening Finding 2 this way is acceptable, and Mason's review of Section 1's actual phrase and co-occurrence list are both in that file, attributed, not summarized here). Nothing here changes the legal-hold check, the access model, or anything about how a flagged conversation gets reviewed today.

Outside counsel's opinion is now in hand (`compliance/archive-search-fair-housing-outside-counsel-opinion.md`) and approves this architecture subject to its ten numbered safeguards. Section 5, item 7 above adopts safeguard #7 (periodic sampling of both pools) as a locked-in commitment per Peter's decision to proceed — that piece is no longer an open question. Mason should still review the two specific numbers chosen there (100 per pool, quarterly) against real-world admin bandwidth and actual quarterly volume once the Section 5 dry run reports real counts, and confirm the Pool B judgment call (items 4–5's standard, applied on a rolling basis) is something a trained reviewer can actually execute in practice. Asimov's sign-off should also cover this new ongoing obligation itself — it is a new standing commitment this project is taking on, not a one-time task, and it belongs in whatever mechanism tracks recurring compliance obligations going forward.
