# Owner & Tenant Operational Notes — Staff Guidance

**Written by:** Mason (legal review)
**Date:** 2026-09-05
**Built from, read in full:** `compliance/owner-tenant-notes-outside-counsel-opinion.md` (the controlling legal opinion) and `projects/hub/property-360/owner-tenant-operational-notes-SPEC.md` (the approved design). Nothing below adds a new legal position — this translates counsel's already-cleared framework into plain text a property manager reads in the moment, and finishes the two placeholder strings Q flagged as needing my review before this tool leaves its trial period.

**For Q:** Sections 1 and 2 each end with a ready-to-paste code block. Copy those verbatim into `router.js` / `lib/derogatory-language-terms.js` in place of the current placeholder/first-pass values — no further editing needed, and no `[PLACEHOLDER]` text should remain in either string afterward.

---

## 1. The Tier 2/3 Access Acknowledgment Message

### What this notice has to do

This fires once per person, the first time someone with `property_manager`, `pod_lead`, `reviewer`, `director_of_operations`, or `admin` access is about to see a Management/Compliance-Restricted or Legal-Privileged note. It exists because of a specific, deliberate business decision Peter made and Asimov/Mason already reviewed: this access is **portfolio-wide**, not scoped to a person's own properties, because property manager coverage at Rincon genuinely works that way — anyone may be asked to cover any property. That breadth is the reason a real notice is needed here at all, not a rubber-stamp checkbox.

Three things it must communicate, per the spec:
1. Why this tier exists and why access is this broad (active operational/backup coverage — a real, normal part of the job, not an overgrant).
2. Browsing without an actual work reason is a confidentiality violation, full stop — the same as misusing any other sensitive data.
3. What's actually in here (Fair Housing complaints, discrimination allegations, threats, disputes) and the one rule that matters most: it must never change how staff treat a tenant.

I kept it to four short paragraphs on purpose. A wall of legal text gets reflexively clicked through, which defeats the entire point of a warning that's supposed to be read. If Tron's modal can render paragraph breaks, split on the blank lines below — don't compress this into one dense block.

### Final text — replace `TIER_ACCESS_ACK_MESSAGE` in `router.js` with this exactly

```js
const TIER_ACCESS_ACK_MESSAGE =
  "Before you continue: this section can contain Fair Housing complaints, discrimination allegations, threats, restraining orders, and other sensitive disputes — for any property in the portfolio, not just the ones you normally handle. You have this access because property manager coverage at Rincon is portfolio-wide: you may be asked to step in on a property that isn't normally yours, and this is where the sensitive facts about it live.\n\n" +
  "Open a note only when you have an actual work reason to look. Browsing without one is a confidentiality violation — the same as misusing any other sensitive tenant or owner information — and every time you view a note at this level, it is logged: who, what property, and when.\n\n" +
  "Most important: nothing in this section should change how you treat a tenant. A Fair Housing complaint or a dispute is a fact to be aware of, not a reason to treat someone differently — doing that is retaliation, and it is illegal.\n\n" +
  "You'll only see this notice once.";
```

Delete the existing `TIER_ACCESS_ACK_MESSAGE` block (router.js lines ~288–302, including the `[PLACEHOLDER — Mason to provide...]` comment and sentence) and the "Q's placeholder wording only, flagged... as needing Mason's real policy language" caveat above it — both are resolved by this section.

---

## 2. The Derogatory-Characterization Soft Warning

### Review of Q's first pass

Q's design is right and shouldn't change: a **non-blocking** nudge, shown after the note is already saved, because a hard block on ordinary English words would be false-positive-heavy in exactly the way this codebase already got burned once (per the spec). I reviewed the word list against counsel's own fact-vs-characterization standard and made targeted changes — not a rewrite — for two reasons:

**Removed as bare standalone terms: `unstable`, `demanding`.** Both trigger constantly on completely legitimate, non-personal operational facts that have nothing to do with characterizing anyone — "the deck railing is unstable," "owner is demanding proof of insurance before releasing payment." That's exactly the annoying, gets-in-the-way false positive this feature is supposed to avoid, and it's a different failure mode than the useful kind of hit (a bare label on a person). `unstable tenant` / `unstable owner` are added as phrases so the actual characterization case ("tenant is unstable") is still caught.

**Added, from counsel's own opinion:**
- `unstable owner` — companion to the existing `unstable tenant`, same reasoning.
- `refuses to take responsibility` — counsel's own worked example (opinion Section 3): factual "Tenant disputes the plumbing charge" vs. evaluative "Tenant refuses to take responsibility."
- `always disputes`, `constantly disputes` — counsel's own worked example (opinion Section 2): discouraged "Tenant always disputes charges" vs. permitted "Tenant disputes responsibility for invoice #1234. Manager approval required before charge is posted." I added these as narrow two-word phrases rather than flagging bare "always" or "constantly" — those words alone appear in huge numbers of ordinary factual sentences ("gate is always locked after 6pm") and would nag far more than they'd help.

Everything else in Q's list is sound and I'm leaving it as-is, including the six terms taken directly from counsel's own prohibited-language list ("Crazy," "Bad tenant," "Problem tenant," "Lazy," "Entitled," "High maintenance" — all already present). A few of the remaining terms (`aggressive`, `hostile`, `volatile`, `disruptive`) will occasionally fire on legitimate safety- or property-condition facts (a dog's behavior, construction noise). That's an acceptable and intentional cost for a soft, non-blocking nudge — the fix in those cases is the same one the warning text below teaches: describe the specific incident, not the general label. The residual gap (a keyword list can't catch every characterization, and can't judge whether a hit is actually a problem) isn't solved by tuning the list further — that's what the periodic sampling audit (spec Section 7, counsel's Item I) exists for. Don't try to make the list "complete."

### Final word list — replace the `TERMS` array in `lib/derogatory-language-terms.js` with this exactly

```js
const TERMS = [
  // Generalized character judgments about a person, not a specific fact —
  // several of these are counsel's own enumerated examples (opinion
  // Section 6: "Crazy." "Bad tenant." "Problem tenant." "Lazy."
  // "Entitled." "High maintenance.")
  'difficult tenant', 'difficult owner', 'problem tenant', 'problem owner',
  'high maintenance', 'high-maintenance', 'nightmare tenant', 'nightmare owner',
  'bad tenant', 'bad owner', 'troublemaker', 'trouble maker',
  'unstable tenant', 'unstable owner',

  // Standalone evaluative adjectives — broad on purpose (Layer-1-style,
  // recall-oriented) but soft-warning-only, so the false-positive cost is
  // low (a rephrase prompt, not a suppression) per this file's own header.
  // NOTE (Mason review, 2026-09-05): bare 'unstable' and 'demanding' were
  // deliberately removed from this list — both trigger constantly on
  // ordinary, legitimate property-fact usage that has nothing to do with
  // characterizing a person ("the deck railing is unstable," "owner is
  // demanding proof of insurance before releasing payment"). That's the
  // annoying, in-the-way false positive this tool should avoid. The
  // 'unstable tenant'/'unstable owner' phrases above still catch the
  // actual characterization case.
  'difficult', 'unreasonable', 'dramatic', 'hostile', 'aggressive', 'rude',
  'entitled', 'lazy', 'crazy', 'paranoid', 'manipulative',
  'liar', 'lying', 'dishonest', 'uncooperative', 'confrontational',
  'combative', 'volatile', 'disruptive', 'condescending', 'obnoxious',
  'hysterical', 'irrational', 'needy', 'clingy', 'high strung',
  'high-strung', 'ungrateful', 'abrasive', 'unpleasant',
  'annoying', 'nasty', 'vindictive', 'petty',

  // Complaint-framed-as-negative-attribute phrasing — Section 7's own
  // "protected activity converted into a negative attribute" example.
  'always complaining', 'constantly complaining', 'chronic complainer',
  'serial complainer', 'chip on their shoulder',

  // Counsel's own worked fact-vs-characterization pairs (Mason review,
  // 2026-09-05) — opinion Section 3 (factual "Tenant disputes the
  // plumbing charge" vs. evaluative "Tenant refuses to take
  // responsibility") and opinion Section 2 (discouraged "Tenant always
  // disputes charges" vs. permitted "Tenant disputes responsibility for
  // invoice #1234. Manager approval required before charge is posted.").
  // Added as narrow phrases, not bare 'always'/'refuses' — those words
  // alone appear in huge numbers of ordinary factual sentences and would
  // false-positive far more than they'd help.
  'refuses to take responsibility', 'always disputes', 'constantly disputes',
];
```

Also bump `DEROGATORY_LANGUAGE_VERSION` to `'derogatory-language-terms-v2'` — this list changed, and this file already has its own versioning convention for exactly that reason (see the constant's neighboring comment).

### Final warning text — replace `DEROGATORY_LANGUAGE_WARNING` in `router.js` with this exactly

```js
const DEROGATORY_LANGUAGE_WARNING =
  "This note may describe a characterization rather than an objectively stated fact — for example, 'difficult tenant' describes the person, while 'tenant declined the last three proposed access times' describes what happened. Words like these aren't always wrong (e.g. 'difficult access due to a locked gate' is a legitimate fact) — but if this note labels a person rather than describing an event, consider rephrasing to state what was said or done, and when. This is a suggestion only — your note was saved as written.";
```

This keeps Q's original structure (one clear ask, one reassurance that nothing was blocked) but replaces the generic example with the spec's own real pair — a locked-gate access fact (legitimate) versus a bare personal label (not) — so the warning teaches the actual distinction instead of just repeating the trigger words back at the author.

---

## 3. Owner-Instruction-Rejection Guidance

This is the guidance a property manager should have open, or remember, the moment an owner gives an instruction that can't legally be followed. Counsel's own template (spec Section 6) is the required format — this section is the "how and when to actually use it" that has never been written down until now.

### When to use this

Use this template any time an owner instructs Rincon to do something because of a protected characteristic — theirs, the tenant's, or a prospective tenant's. The recurring real-world versions:

- **"No Section 8" / "no vouchers" / "I don't want to deal with housing assistance."** Source of income is a protected class in California — this instruction cannot be followed, no matter how it's phrased or how reasonable the owner thinks their reason is (cost, paperwork, past experience with one voucher tenant, etc.).
- **"No families with children" / "no kids" / "I'd rather have a single professional" / "empty nesters only."** Familial status is protected federally and in California.
- **Refusing or resisting an approved reasonable accommodation or modification** — e.g., an owner says no to a tenant's assistance animal, a grab bar, a reserved accessible parking spot, or extra time to respond at the door for a documented disability-related reason.
- **Any other "no [protected class]" instruction** — race, religion, national origin, marital status, age, sex, sexual orientation, gender identity, or any other class California or federal law protects.

**Don't use this template for ordinary, lawful owner preferences** — a "no smoking" policy, a pet policy that doesn't touch a service or support animal, a rent amount, or screening criteria (credit, income, rental history) applied the same way to everyone. Those aren't discriminatory and filing them this way just clutters the compliance record with things that don't belong there. **If you're not sure whether an instruction crosses the line, ask your director of operations or Mason before deciding on your own** — guessing wrong in either direction (filing something that isn't actually discriminatory, or not filing something that is) is worse than asking.

### What to actually do, in order

1. **Don't implement the instruction.** Not "implement it quietly this once" — don't do it at all, even for one showing or one applicant.
2. **Tell the owner, briefly and professionally, that the request can't be carried out.** You don't need to deliver a lecture on fair housing law — a short, factual line is enough: *"I'm not able to do that — [protected category] is a legally protected status, and treating an applicant differently because of it isn't something we can do."*
3. **File an Owner & Tenant Operational Note** using the template below. In the tool: `subject_type: owner`, `category: owner_instruction_rejected`, `access_tier: management_compliance_restricted`.
4. **If the owner pushes back, repeats the instruction, or threatens to end the relationship over it, stop handling it solo and escalate** to your director of operations or admin. That's a conversation Rincon's leadership needs to be aware of, not something to resolve unilaterally.

### The template

> Owner instruction: "[quote the instruction]." Rincon response: request could not be implemented because [reason — e.g., California Government Code / FEHA protects source of income].

Quote the owner's actual words in the first blank — don't paraphrase or soften them. The record is only useful if it's accurate.

### Filling in the reason clause

A caveat before the examples: **the specific code citations below are a starting point, not verified legal citations.** I'm not counsel, and exact statute numbers should be confirmed with Rincon's actual outside counsel before anyone treats this as authoritative — the same caution the spec itself applies to its own CCPA citation elsewhere. For an internal record like this, naming the protected category in plain English is enough and safer than guessing at a citation. Use the short version unless someone with legal training tells you otherwise.

**Source of income (Section 8 / Housing Choice Vouchers):**
> ...request could not be implemented because source of income, including Section 8 / Housing Choice Vouchers, is a protected class under California's Fair Employment and Housing Act (Government Code § 12955).

**Familial status (families with children, pregnancy):**
> ...request could not be implemented because familial status — including having children under 18 or being pregnant — is a protected class under the federal Fair Housing Act and California's Fair Employment and Housing Act.

**Disability accommodation (assistance/support animals, physical modifications, procedural adjustments):**
> ...request could not be implemented because it would deny a reasonable accommodation for a disability, which the federal Fair Housing Act and California's Fair Employment and Housing Act both require Rincon to provide.

If the instruction touches a category not listed here (race, religion, national origin, marital status, age, etc.), use the same structure — name the actual category, and say plainly that it's a protected class under federal and/or California law. If you're unsure how to phrase it, ask before filing rather than guessing at legal language.

### Why this record exists — and why it's not something to feel awkward about

Filing this note is not "telling on" the owner, and it's not optional paperwork. It's the single best protection Rincon has if this ever becomes a dispute — a contemporaneous record, in the owner's own quoted words, showing Rincon refused a discriminatory instruction the moment it was given rather than going along with it. Counsel's opinion is explicit that this kind of record is useful protection for Rincon, precisely because it exists. Writing it down is doing the job correctly, not creating a problem.

One practical note: because this note is filed at the Management/Compliance-Restricted tier, you may not be able to see it again afterward if your own role caps out below that tier (most property managers' access here is calibrated to what they can read, not what they can write — see the spec's Section 3 access table). That's expected, not a bug — the record is safely kept for review by admin/compliance, and a compliance reviewer will typically confirm it as `retained_restricted` rather than release it more broadly, since this is exactly the kind of record that should stay in the restricted tier permanently.

---

## Summary for whoever reviews this before it ships

| Piece | Status |
|---|---|
| `TIER_ACCESS_ACK_MESSAGE` | Final text provided above — replaces Q's `[PLACEHOLDER]` draft in full. |
| `DEROGATORY_LANGUAGE_WARNING` + `TERMS` list | Reviewed and refined (2 terms removed, 4 added, versioned to v2) — no longer a first pass. |
| Owner-instruction-rejection guidance | Net-new staff document — did not exist before this file. |

**Attorney referral:** No new referral needed for this text itself — it implements outside counsel's already-received, already-authoritative opinion rather than taking a new legal position. The one open item is the reason-clause citations in Section 3 above: flagged plainly as illustrative, not confirmed, and should be checked against current code section numbers by Rincon's actual outside counsel before anyone relies on the specific statute numbers rather than just the plain-English category name.
