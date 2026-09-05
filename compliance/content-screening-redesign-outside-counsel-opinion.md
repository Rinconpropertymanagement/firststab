# Outside Counsel Opinion — Content-Screening Precision Redesign (Part One)

**Provenance note (added 2026-09-05, per Asimov's and Mason's independent governance review):** this document was originally recorded only as text provided by Peter with no attorney name, firm, or signature — both reviewers separately flagged that this doesn't, on its own, establish the attorney-review GOVERNANCE.md Rule 6 requires for a Critical-tier compliance-logic change. Peter (CEO) was asked directly and confirmed: this opinion came from Rincon's actual outside counsel, licensed to practice in California, who has represented Rincon for years — but declined to disclose the attorney's name or firm to this AI system, citing a considered privacy concern about sharing personally identifiable information with AI. As the business owner bearing responsibility for this representation, Peter's direct confirmation is accepted as satisfying the attorney-review requirement for purposes of this build. Recommended, not required: Rincon should retain the original correspondence with counsel (email, letter, or engagement record) in its own files, outside this codebase, as the durable record of this opinion's actual provenance.

**Received:** 2026-09-05, in response to `projects/hub/maintenance-history/scratch-docs/Rincon-Content-Screening-Redesign-Followup-for-Counsel.docx` / `.pdf` (the standalone Part One follow-up memo, itself reproducing Part One of the original combined memo sent 2026-09-04).
**Status:** Authoritative. Per standing project instruction, a real outside counsel opinion supersedes the internal (Mason) review wherever they conflict. This opinion is substantially more permissive than Mason's internal review across nearly every question — see `projects/hub/maintenance-history/scratch-docs/build-memo.js` (Section 1.4/1.6) for the internal review's original six safeguards and six questions this responds to.
**Overall verdict:** GREEN. Approved for development.

---

The following is the verbatim text of the opinion, as provided by Peter (CEO), pasted directly into chat and reproduced here in full for the record.

---

I reviewed the new follow-up memo and researched the current federal and California authorities before answering. This document is narrower than the last one: it deals only with the existing maintenance-content screening system and asks six questions about whether Rincon can make it substantially less prone to false positives.

My preliminary view is more permissive than the internal recommendation. The strongest legal point is that I do not find any FHA or California FEHA requirement that Rincon operate this type of pre-display protected-class filter in the first place. The statutes prohibit discrimination in housing and housing services; HUD's regulation specifically prohibits, for example, delaying maintenance because of a protected characteristic. They do not require maintenance personnel to be shielded from every reference to protected status. (Legal Information Institute)

That distinction gives Rincon considerable freedom to rely on trained employee judgment rather than trying to make the software itself eliminate every theoretical compliance risk.

## Legal Opinion — Content-Screening Redesign

### Overall opinion

I would approve moving forward with the redesign, and I believe Rincon can reasonably go further than the six safeguards proposed by the internal reviewer.

Your present system has reviewed 340 flagged records and found approximately 91% to be false positives. The overwhelming majority come from ordinary maintenance uses of words such as "white," "black," "blind," and "diagnosis." That is not a marginal precision problem. It means the compliance control is overwhelmingly identifying innocuous business communications.

From a legal-risk perspective, an overly sensitive system has its own cost. If professional staff encounter hundreds of meaningless flags, they are more likely to disregard the system when something genuinely important appears.

I therefore would not make "never miss a protected-class reference" the design standard.

I would use: Reasonably identify protected-class information that could matter to housing treatment, while allowing trained employees to see and use ordinary operational information.

The law requires nondiscriminatory treatment. It does not require Rincon employees to remain ignorant of protected characteristics.

### Question 1 — Is the two-tier design adequate?

Yes. In my view, it is more than adequate from a Fair Housing standpoint.

Tier A continues automatic flagging of terms that have not produced false positives, while Tier B allows context to determine whether six ambiguous terms actually concern a protected characteristic.

Nothing in the FHA or California FEHA requires the bare word "white" to be quarantined whenever it occurs in a maintenance record. The relevant legal issue would be whether race subsequently causes different treatment in maintenance, services, housing terms, etc. Federal law expressly focuses on discrimination "because of" protected status, and HUD's regulation identifies different or delayed maintenance treatment as the prohibited conduct. (Legal Information Institute)

I would actually allow more staff judgment. I would be comfortable with this workflow: Keyword identifies potentially sensitive language → contextual AI evaluates it → clearly operational uses are displayed normally → ambiguous or genuinely protected-class references can either be flagged or displayed with appropriate restrictions → trained staff retain ultimate judgment.

I do not think every genuine protected-class reference necessarily needs to disappear from ordinary staff view.

For example: "Tenant uses a wheelchair; ensure ramp access is not blocked during repair." That mentions disability but may be exactly the information a maintenance coordinator needs.

Likewise: "Section 8 inspector requires correction by Friday." That refers to source of income/program participation but is operationally important.

The better legal control is appropriate use, not automatic suppression.

**Counsel-style conclusion:** Approved. Low Fair Housing risk if properly implemented. I would not regard all six internal safeguards as legally required conditions.

### Question 2 — How broad should the contextual AI question be?

The internal reviewer wants the AI to ask not only whether a term refers to a person or object, but whether even apparently neutral language could be a "coded or indirect" protected-class reference.

I agree with the concept but think the proposed standard is too open-ended.

If you ask an AI whether virtually any sentence "could reasonably be understood" as coded discrimination, you invite another wave of false positives.

I would instead ask: "In context, does this language actually communicate or materially imply information about a protected characteristic of a person, household, or housing preference, rather than describing an object, product, repair condition, brand, or ordinary operational fact?"

Then add: "If ambiguous, identify it for human judgment rather than assuming discrimination."

That is important. I would not train the system to search imaginatively for hidden discriminatory meaning where none is apparent.

The example in the memo — "white neighborhood" — should plainly be caught because it does communicate racial composition or preference. But "white cabinet," "Bradford White," "black mold," or "blind replacement" should not require heroic analysis.

**Staff discretion:** If a phrase is genuinely ambiguous, I would rather route it to a trained employee than build increasingly elaborate automated rules. There is no statutory "AI must decide" requirement.

**Counsel-style conclusion:** Use a context-based actual-meaning standard, not an expansive theoretical-coding standard. Human review is an appropriate backstop.

### Question 3 — Is the validation period sufficient?

Yes, and I would permit something less burdensome than the memo proposes.

You already have unusually strong validation evidence because the team manually reviewed the entire historical flagged population, rather than a sample.

The proxy testing also demonstrated that context can reliably distinguish object references from person references without incorrectly classifying unresolved cases.

The proposed internal rule would require both systems to operate simultaneously and every disagreement to receive human review before the new system controls production. That's conservative and defensible.

I do not, however, see a legal requirement for a traditional shadow period, a particular number of days, or 100% disagreement review.

I would be comfortable with: historical validation against the 340 records → short live parallel test → management review of mistakes → production deployment → periodic sample audit.

I would not make "zero errors" the release criterion. Human property managers are not held to a zero-error standard, and neither should an internal compliance tool be.

The meaningful question is whether the tool is reasonably designed and whether actual protected-class references are being handled appropriately.

**Counsel-style conclusion:** Yes. The proposed validation is sufficient and arguably more conservative than necessary.

### Question 4 — Is a formal risk assessment required?

Under Fair Housing law: No requirement I found.

The FHA and FEHA do not require a formal algorithmic risk assessment for this type of internal maintenance-content tool.

California privacy law is a separate matter. As of January 1, 2026, the California Privacy Protection Agency's risk-assessment regulations are in effect for covered businesses engaging in specified processing presenting significant privacy risks. (California Privacy Protection Agency) The final regulations include circumstances involving processing of sensitive personal information. (California Privacy Protection Agency)

So the privacy answer depends first on whether Rincon is a CCPA-covered business and second on the exact data being processed. That is not enough for me to tell you this particular redesign automatically requires a statutory risk assessment.

**What I would recommend:** Even if legally unnecessary, I would prepare a short management risk memo, not a large formal exercise. It could state: the purpose of the system; the historical 91% false-positive rate; what changes; what information is involved; human review availability; expected benefit; testing performed; and who approved deployment. Probably two or three pages. That gives Rincon excellent governance evidence without burdening the staff.

**Counsel-style conclusion:** No Fair Housing risk assessment is legally required. Determine separately whether CCPA risk-assessment rules apply to Rincon. If not required, a concise internal assessment is sufficient.

### Question 5 — What should Rincon retain about AI decisions?

I would be less aggressive about logging than the internal memo suggests.

There is value in keeping enough information to demonstrate that the system functions reasonably. But logging every prompt, full response, source sentence, confidence value, reasoning chain and protected-class reference indefinitely can create a second sensitive database without much legal benefit.

I would retain enough to reconstruct the decision: the triggering term; classification; date/time; model/version or rule version; whether it was automatically cleared, flagged or manually reviewed; and final human disposition if there was one.

I would keep the original maintenance record in the normal system of record rather than duplicating its content into the audit log.

For routine cleared items, I do not believe you need attorneys or management approving each one. Periodic auditing is enough.

**Trained staff:** I would expressly permit designated trained staff to override a classification in either direction. For example: AI says "protected." Employee sees "Bradford White 50-gallon heater." Employee clears it. Or: AI says "ordinary." Employee recognizes something troubling in context. Employee flags it.

That kind of employee judgment strengthens the compliance system rather than weakening it.

There is no legal safe harbor merely because the employee was trained, but training plus written standards plus auditability are very useful evidence of a reasonable compliance program.

**Counsel-style conclusion:** Use lean audit logging and permit trained human overrides. Avoid creating excessive records merely to prove the AI made a decision.

### Question 6 — Must source-of-income terms remain Tier A?

This is where I would give you considerably more flexibility than the memo.

California absolutely protects source of income, including Housing Choice/Section 8 vouchers, and those protections expressly apply to property management companies. (Civil Rights Department)

But: California prohibits discrimination because someone uses Section 8. It does not prohibit property managers from knowing or discussing that a tenant participates in Section 8. That is a critical distinction.

Your memo found "Section 8" only twice in 17,867 processed records, both connected to one real event. Leaving the category Tier A is perfectly defensible because the system has no demonstrated false-positive problem there.

But I would not treat Tier A status as legally required.

Operational examples could include: "Section 8 inspection scheduled Tuesday." "Housing Authority requires smoke detector correction." "Voucher program inspector requested repair." Those are ordinary business facts. Staff often need that information to perform their jobs.

If Section 8 references eventually generate significant unnecessary suppression, I would have no Fair Housing objection to putting those terms through the same contextual process: Is this simply operational information about a subsidy/program, or does it express or support discriminatory treatment because of the person's source of income? That is the legal distinction that matters.

**Counsel-style conclusion:** Keeping source-of-income terminology Tier A is a reasonable conservative choice today, but it is not legally necessary. Rincon can later contextualize these terms if operational experience supports doing so.

### Where I Would Loosen the Six Safeguards

This is probably the most important part for what you're trying to build.

Of the six "required safeguards" in the internal memo, I would treat only a few as meaningful governance controls rather than absolute conditions.

- **Safeguard 1 — don't alter the shared matcher:** sensible engineering control because another feature depends on it. I would keep it, but that's software-change management, not Fair Housing law.
- **Safeguard 2 — prospective only:** I would loosen this. There is no obvious legal reason you cannot apply improved logic to historical records. If 300 historical flags are known false positives, I would allow trained staff or the revised system to clean them up if doing so has operational value.
- **Safeguard 3 — separate prompts for each term:** good engineering practice, but not legally required. If one well-designed contextual classifier performs better, use it.
- **Safeguard 4 — coded/indirect references:** keep the concept, but narrow the standard so the model identifies actual meaningful implications rather than imagining possible discriminatory interpretations.
- **Safeguard 5 — recurring manual auditing:** keep it, but use reasonable sampling. I see no reason for heavy permanent oversight if the system demonstrates good accuracy.
- **Safeguard 6 — full comparison period with 100% disagreement review:** good for initial rollout but not legally mandated. Your existing 340-record dataset already provides substantial validation.

### The Bigger Legal Point

I think the internal team's analysis starts from an assumption that deserves reconsideration: Protected-class information itself is dangerous and therefore should generally be hidden from property-management staff.

I don't think that is the correct legal standard.

Property managers inevitably know things about tenants. They can see families with children. They speak with people who have disabilities. They process Section 8 paperwork. They receive accommodation requests. They see names, languages, ages, spouses and household information.

The Fair Housing Act does not require property managers to operate blindfolded. It requires them not to discriminate because of those characteristics. Federal law expressly frames the violation in terms of different treatment or services because of protected status. (Legal Information Institute) California protects a broader set of characteristics but follows the same fundamental antidiscrimination principle. (Civil Rights Department)

That makes your professionally trained staff an important part of the compliance model.

I would therefore design this system around: Technology identifies potential issues. Professional staff apply judgment. Management audits outcomes. — rather than: Technology must prevent employees from seeing anything that could conceivably relate to Fair Housing.

There is no special statutory safe harbor for professional judgment, so you still want training, consistent policies and oversight. But reasonable human discretion is absolutely compatible with Fair Housing compliance.

One other current-development point strengthens the case for focusing on the statutes and regulations rather than highly conservative AI guidance: in September 2025, HUD withdrew a number of prior FHEO guidance documents and expressly stated that guidance should not create obligations beyond statutes, regulations, or binding precedent. (HUD) That withdrawal included HUD's 2024 digital-platform Fair Housing guidance. (HUD)

### My overall preliminary opinion

I would rate the proposed redesign GREEN and authorize development.

I would also tell the technology team that the design objective should no longer be maximum suppression of protected-class-adjacent information. It should be reasonably accurate identification of information that presents an actual Fair Housing concern while allowing trained property-management personnel to exercise professional judgment over ordinary business records.

---

## Open Items for Peter (not resolved by this opinion)

1. **CCPA-coverage question (Q4).** Counsel's risk-assessment answer explicitly branches on whether Rincon is a CCPA-covered business and what data is processed — counsel did not determine this, and it isn't determinable from this codebase alone. Worth confirming directly (with counsel or Rincon's own accountant/counsel on the business side) if the CPPA's 2026 risk-assessment rules are a live question for Rincon generally, independent of this specific feature.
2. **The short management risk memo counsel recommends (Q4)** — not legally required, but counsel's own suggested governance evidence. Two to three pages: purpose, the 91% false-positive finding, what changes, what data's involved, human-review availability, expected benefit, testing performed, who approved deployment. Not yet written.
